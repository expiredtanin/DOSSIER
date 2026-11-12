//! Baugrube / Geländebearbeitung ([68], [T6]): ein Umriss (Sohle) auf fester Höhe, Böschungen bis zum
//! Gelände (Abtrag) bzw. Schüttungen bis zum Gelände (Auftrag), optional mit Bermen.
//!
//! Neue Geländehöhe am Punkt p:  clamp(t(p), b − d·tan β, b + H(d))  mit d = Abstand zum Umriss (innen 0),
//! H(d) = Böschungsprofil (Neigung α der nächsten Kante, je `bermHeight` eine Berme der Breite
//! `bermWidth`), β = Schüttungswinkel. Innen gilt damit überall die Sohle b; die Ecken der Böschung sind
//! Kegel (wie beim Aushub mit dem Bagger).
//!
//!  • Netz: das Gelände wird im Wirkbereich neu trianguliert — Rasterpunkte (exakte neue Höhe), Umriss
//!    und Böschungsoberkante (Schnitt Böschung/Gelände) als Bruchkanten, ausserhalb das Original-TIN
//!    samt seinen Kanten. Ergebnis je Gelände-Netz zwischengespeichert ([`site_terrain`]).
//!  • Mengen: Abtrag/Auftrag als Integral von (t − neu) über ein feines Raster (Mittelpunktregel auf der
//!    exakten Funktion, nicht auf dem Netz); Hinterfüllung = Abtrag ausserhalb der Gebäude-Grundfläche.
//!    Jede Baugrube wird gegen das gewachsene Terrain gerechnet.

use crate::model::{ContextObject, Excavation, Project, TerrainMesh};
use crate::terrain::{constrained_tin, datum, isolines, P2, Tin, TinIndex};
use std::cell::RefCell;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

pub const DEFAULT_SLOPE: f64 = 45.0;
pub const DEFAULT_FILL_SLOPE: f64 = 33.7;

fn tan_deg(a: f64) -> f64 {
    a.clamp(5.0, 89.5).to_radians().tan()
}

/// Baugrube im Höhenbezug des Netzes.
#[derive(Clone, Debug)]
pub struct ExSpec {
    /// Umriss gegen den Uhrzeigersinn (Bögen fein geteilt, [191]).
    pub ring: Vec<P2>,
    /// [191] Je Punkt von `ring`: liegt im Inneren eines Bogens (keine Ecke: Schraffur läuft durch, kein Fächer).
    pub smooth: Vec<bool>,
    pub bottom: f64,
    pub cut_tan: Vec<f64>,
    /// Kante mit senkrechtem Verbau (Spundwand): keine Böschung, keine Schraffur.
    pub shored: Vec<bool>,
    /// [68] Art des Verbaus (`sheetPile`, `soldierPile`, `borePile`) und Wanddicke in m.
    pub shore_kind: &'static str,
    pub shore_t: f64,
    /// [68] Umriss vor dem Arbeitsraum (Gebäude-Grundfläche, gegen den Uhrzeigersinn) und Arbeitsraum in m.
    pub base: Vec<P2>,
    pub ws: f64,
    pub fill_tan: f64,
    pub berm_w: f64,
    pub berm_h: f64,
}

fn seg_dist(p: P2, a: P2, b: P2) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
}

pub fn point_in_ring(p: P2, r: &[P2]) -> bool {
    let mut inside = false;
    let n = r.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (r[i], r[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn signed_area(r: &[P2]) -> f64 {
    let n = r.len();
    (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum::<f64>() / 2.0
}

/// Umriss (gegen den Uhrzeigersinn) um `d` nach aussen versetzt: Gehrung an den Ecken, höchstens 4·d weit.
pub fn offset_ring(ring: &[P2], d: f64) -> Vec<P2> {
    let n = ring.len();
    let normal = |i: usize| {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        let l = (b[0] - a[0]).hypot(b[1] - a[1]).max(1e-12);
        [(b[1] - a[1]) / l, -(b[0] - a[0]) / l]
    };
    (0..n)
        .map(|i| {
            let (n0, n1) = (normal((i + n - 1) % n), normal(i));
            let (mx, my) = (n0[0] + n1[0], n0[1] + n1[1]);
            let k = 1.0 + n0[0] * n1[0] + n0[1] * n1[1];
            if k < 1e-6 {
                return [ring[i][0] + n1[0] * d, ring[i][1] + n1[1] * d];
            }
            let (sx, sy) = (mx * d / k, my * d / k);
            let l = sx.hypot(sy);
            let f = if l > 4.0 * d { 4.0 * d / l } else { 1.0 };
            [ring[i][0] + sx * f, ring[i][1] + sy * f]
        })
        .collect()
}

/// [191] Wie [`offset_ring`], dazu ohne Schwalbenschwänze an Bögen: an einer einspringenden Ecke neben einem fein
/// geteilten Bogen kehren sich die kurzen versetzten Teilkanten um (die Gehrungspunkte überholen einander). Solche
/// Kanten (`arc[i]`: Kante i gehört zu einem Bogen) entfallen der Reihe nach — ihre Ecken rücken auf den Schnitt der
/// versetzten Nachbarkanten. Gerade Kanten bleiben wie bei [`offset_ring`] (zu enge Nischen meldet die Prüfung).
/// Gleiche Punktzahl wie `ring`; entfallene Kanten haben Länge 0.
pub fn offset_ring_clean(ring: &[P2], d: f64, arc: &[bool]) -> Vec<P2> {
    let n = ring.len();
    let mut off = offset_ring(ring, d);
    if n < 4 || !arc.iter().any(|a| *a) {
        return off;
    }
    let dir = |i: usize| [ring[(i + 1) % n][0] - ring[i][0], ring[(i + 1) % n][1] - ring[i][1]];
    let normal = |i: usize| {
        let v = dir(i);
        let l = v[0].hypot(v[1]).max(1e-12);
        [v[1] / l, -v[0] / l]
    };
    // Versetzte Gerade der Kante i: Punkt und Richtung.
    let line = |i: usize| {
        let nn = normal(i);
        ([ring[i][0] + nn[0] * d, ring[i][1] + nn[1] * d], dir(i))
    };
    let mut alive = vec![true; n];
    let reversed = |off: &[P2], i: usize| {
        let v = dir(i);
        let w = [off[(i + 1) % n][0] - off[i][0], off[(i + 1) % n][1] - off[i][1]];
        v[0] * w[0] + v[1] * w[1] < 0.0
    };
    for _ in 0..n {
        let Some(i) = (0..n).find(|&i| alive[i] && arc.get(i).copied().unwrap_or(false) && reversed(&off, i)) else { break };
        alive[i] = false;
        let Some(p) = (1..n).map(|k| (i + n - k) % n).find(|&k| alive[k]) else { break };
        let Some(q) = (1..n).map(|k| (i + k) % n).find(|&k| alive[k]) else { break };
        if p == q {
            break;
        }
        let ((a, u), (b, w)) = (line(p), line(q));
        let den = u[0] * w[1] - u[1] * w[0];
        // Ecken zwischen p und q (Ende von p bis Anfang von q) auf den Schnitt; parallel: Mitte.
        let x = if den.abs() > 1e-12 {
            let t = ((b[0] - a[0]) * w[1] - (b[1] - a[1]) * w[0]) / den;
            [a[0] + u[0] * t, a[1] + u[1] * t]
        } else {
            let (s, e) = (off[(p + 1) % n], off[q]);
            [(s[0] + e[0]) / 2.0, (s[1] + e[1]) / 2.0]
        };
        let mut k = (p + 1) % n;
        loop {
            off[k] = x;
            if k == q {
                break;
            }
            k = (k + 1) % n;
        }
    }
    off
}

/// Kanten eines fein geteilten Bogens: mindestens ein Ende liegt im Inneren des Bogens.
fn arc_edges(smooth: &[bool]) -> Vec<bool> {
    let n = smooth.len();
    (0..n).map(|i| smooth[i] || smooth[(i + 1) % n]).collect()
}

/// Doppelte Punkte (nach [`offset_ring_clean`]) aus dem Ring samt Kanten- und Punkt-Eigenschaften entfernen: die Kante
/// ab einem doppelten Punkt ist die des späteren.
fn dedup_ring(ring: &mut Vec<P2>, cut_tan: &mut Vec<f64>, shored: &mut Vec<bool>, smooth: &mut Vec<bool>) {
    let n = ring.len();
    let keep: Vec<bool> = (0..n).map(|i| { let j = (i + 1) % n; (ring[i][0] - ring[j][0]).hypot(ring[i][1] - ring[j][1]) >= 1e-9 }).collect();
    if keep.iter().all(|k| *k) || keep.iter().filter(|k| **k).count() < 3 {
        return;
    }
    let pick = |v: &[bool], k: &[bool]| v.iter().zip(k).filter(|(_, k)| **k).map(|(x, _)| *x).collect::<Vec<bool>>();
    // Ein entfallener Punkt i liegt auf i+1: Punkt i+1 bleibt, wird aber eine Ecke.
    let mut sm = smooth.clone();
    for i in 0..n {
        if !keep[i] {
            sm[(i + 1) % n] = false;
        }
    }
    *ring = ring.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| *p).collect();
    *cut_tan = cut_tan.iter().zip(&keep).filter(|(_, k)| **k).map(|(t, _)| *t).collect();
    *shored = pick(shored, &keep);
    *smooth = pick(&sm, &keep);
}

impl ExSpec {
    /// Aus dem Modell; `dz` = Höhenbezug des Netzes ([`datum`]). `None` bei kaputtem Umriss.
    pub fn of(e: &Excavation, dz: f64) -> Option<ExSpec> {
        // [191] Bögen fein geteilt; je Punkt die Modell-Kante (Neigung, Verbau) und ob er im Inneren eines Bogens liegt.
        let (dense, src, smooth_in) = e.ring_marked();
        let mut pts: Vec<(P2, usize, bool)> = Vec::with_capacity(dense.len());
        for ((v, k), sm) in dense.iter().zip(src).zip(smooth_in) {
            let p = [v.x, v.y];
            if !(p[0].is_finite() && p[1].is_finite()) {
                continue;
            }
            match pts.last_mut() {
                // Doppelter Punkt: die Kante ab hier ist die des späteren.
                Some(l) if (l.0[0] - p[0]).hypot(l.0[1] - p[1]) < 1e-9 => *l = (l.0, k, sm),
                _ => pts.push((p, k, sm)),
            }
        }
        if pts.len() > 2 && (pts[0].0[0] - pts[pts.len() - 1].0[0]).hypot(pts[0].0[1] - pts[pts.len() - 1].0[1]) < 1e-9 {
            pts.pop();
        }
        let mut ring: Vec<P2> = pts.iter().map(|q| q.0).collect();
        if ring.len() < 3 || !e.bottom.is_finite() || signed_area(&ring).abs() < 1e-6 {
            return None;
        }
        let n = ring.len();
        let slope = e.slope.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(DEFAULT_SLOPE);
        let mut shored: Vec<bool> = pts.iter().map(|q| e.edge_shoring.as_ref().and_then(|v| v.get(q.1)).copied().unwrap_or(false)).collect();
        let mut cut_tan: Vec<f64> = pts.iter().zip(&shored).map(|(q, sh)| if *sh { tan_deg(89.5) } else { tan_deg(e.edge_slopes.as_ref().and_then(|v| v.get(q.1)).copied().filter(|s| s.is_finite() && *s > 0.0).unwrap_or(slope)) }).collect();
        let mut smooth: Vec<bool> = pts.iter().map(|q| q.2).collect();
        if signed_area(&ring) < 0.0 {
            // Kante i (p_i → p_i+1) wird nach dem Umdrehen Kante n−2−i (mod n), Punkt i wird Punkt n−1−i.
            ring.reverse();
            smooth.reverse();
            let (old, old_s) = (cut_tan.clone(), shored.clone());
            for i in 0..n {
                cut_tan[(2 * n - 2 - i) % n] = old[i];
                shored[(2 * n - 2 - i) % n] = old_s[i];
            }
        }
        // Arbeitsraum: Sohle um `workingSpace` nach aussen (Gehrung, höchstens 4× so weit an spitzen Ecken; an Bögen
        // ohne Schwalbenschwänze, [191]).
        let ws = e.working_space.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
        let base = ring.clone();
        if ws > 0.0 {
            ring = offset_ring_clean(&ring, ws, &arc_edges(&smooth));
            dedup_ring(&mut ring, &mut cut_tan, &mut shored, &mut smooth);
        }
        let (shore_kind, default_t) = shoring_kind(e.shoring_kind.as_deref());
        let shore_t = e.shoring_thickness.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(default_t);
        let bw = e.berm_width.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
        let bh = e.berm_height.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
        Some(ExSpec {
            ring,
            smooth,
            bottom: e.bottom + dz,
            cut_tan,
            shored,
            shore_kind,
            shore_t,
            base,
            ws,
            fill_tan: tan_deg(e.fill_slope.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(DEFAULT_FILL_SLOPE)),
            berm_w: if bh > 0.0 { bw } else { 0.0 },
            berm_h: if bw > 0.0 { bh } else { 0.0 },
        })
    }

    /// Abstand zum Umriss (innen 0) und Index der nächsten Kante.
    pub fn dist(&self, p: P2) -> (f64, usize) {
        if point_in_ring(p, &self.ring) {
            return (0.0, 0);
        }
        let n = self.ring.len();
        (0..n).map(|i| (seg_dist(p, self.ring[i], self.ring[(i + 1) % n]), i)).fold((f64::INFINITY, 0), |a, b| if b.0 < a.0 { b } else { a })
    }

    /// Böschungsprofil: Höhe über der Sohle im Abstand d bei Neigung tan.
    fn profile(&self, d: f64, tan: f64) -> f64 {
        if self.berm_w > 0.0 {
            let run = self.berm_h / tan;
            let period = run + self.berm_w;
            let k = (d / period).floor();
            k * self.berm_h + (d - k * period).min(run) * tan
        } else {
            d * tan
        }
    }

    /// Abstand, bei dem das Profil die Höhe h erreicht (Umkehrung von [`profile`]).
    fn reach(&self, h: f64, tan: f64) -> f64 {
        if !(h > 0.0) {
            return 0.0;
        }
        if self.berm_w > 0.0 {
            let k = (h / self.berm_h).floor();
            k * (self.berm_h / tan + self.berm_w) + (h - k * self.berm_h) / tan
        } else {
            h / tan
        }
    }

    /// Neue Geländehöhe zur alten Höhe `t` am Punkt p.
    pub fn apply(&self, t: f64, p: P2) -> f64 {
        let (d, i) = self.dist(p);
        let hi = self.bottom + self.profile(d, self.cut_tan[i]);
        let lo = self.bottom - d * self.fill_tan;
        t.max(lo).min(hi)
    }

    fn bbox(&self) -> [f64; 4] {
        let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in &self.ring {
            b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
        }
        b
    }

    /// Wirkbereich: grösster Abstand vom Umriss, in dem das Gelände geändert wird.
    pub fn reach_in(&self, orig: &Tin, idx: &TinIndex) -> f64 {
        let b = self.bbox();
        let min_tan = self.cut_tan.iter().copied().fold(f64::INFINITY, f64::min);
        let mut r = 0.0;
        for _ in 0..6 {
            let (mut lo, mut hi) = (self.bottom, self.bottom);
            for (p, z) in orig.xy.iter().zip(&orig.z) {
                if p[0] >= b[0] - r && p[0] <= b[2] + r && p[1] >= b[1] - r && p[1] <= b[3] + r {
                    lo = lo.min(*z);
                    hi = hi.max(*z);
                }
            }
            // Zwischen den Ecken (grosse Dreiecke): Stichproben im Bereich.
            for j in 0..=24 {
                for i in 0..=24 {
                    let (x, y) = (b[0] - r + (b[2] - b[0] + 2.0 * r) * i as f64 / 24.0, b[1] - r + (b[3] - b[1] + 2.0 * r) * j as f64 / 24.0);
                    if let Some(z) = idx.z_at(x, y) {
                        lo = lo.min(z);
                        hi = hi.max(z);
                    }
                }
            }
            let nr = self.reach(hi - self.bottom, min_tan).max((self.bottom - lo) / self.fill_tan).min(2000.0);
            if nr <= r + 1e-6 {
                return nr;
            }
            r = nr;
        }
        r
    }
}

// ── Verbau ([68]) ────────────────────────────────────────────────────────────

/// Einbindetiefe der Verbauwand unter die Sohle (m).
pub const SHORING_EMBED: f64 = 1.0;

/// Einbindetiefe der Baugrube (Feld `shoringEmbed`, Vorgabe [`SHORING_EMBED`]).
pub fn shoring_embed(e: &Excavation) -> f64 {
    e.shoring_embed.filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(SHORING_EMBED)
}

/// Art des Verbaus und ihre Vorgabe-Dicke (m); Unbekanntes = Spundwand.
pub fn shoring_kind(k: Option<&str>) -> (&'static str, f64) {
    match k {
        Some("soldierPile") => ("soldierPile", 0.3),
        Some("borePile") => ("borePile", 0.6),
        _ => ("sheetPile", 0.2),
    }
}

/// Schraffur-Id der Verbauart (SIA: Stahl, Holz, Beton).
pub fn shoring_hatch_id(kind: &str) -> &'static str {
    match kind {
        "soldierPile" => "std-h-holz",
        "borePile" => "std-h-beton",
        _ => "std-h-stahl-detail",
    }
}

/// [68] Wandband einer Folge verbauter Kanten: Sohlkante (`inner`, gegen den Uhrzeigersinn der Baugrube) und die um
/// die Wanddicke nach aussen versetzte Kante (`outer`, gleich viele Punkte, Gehrung an den Ecken).
#[derive(Clone, Debug, PartialEq)]
pub struct ShoringBand {
    pub inner: Vec<P2>,
    pub outer: Vec<P2>,
    /// Ringsum verbaut (Band ohne Stirnseiten; `inner`/`outer` ohne Schlusspunkt).
    pub closed: bool,
}

impl ShoringBand {
    /// Umriss des Bands (Sohlkante, dann die Aussenkante rückwärts); ringsum verbaut nur die Aussenkante.
    pub fn polygon(&self) -> Vec<P2> {
        if self.closed {
            return self.outer.clone();
        }
        self.inner.iter().chain(self.outer.iter().rev()).copied().collect()
    }

    /// Vierecke je Teilkante (Sohlkante i → i+1, aussen i+1 → i), gegen den Uhrzeigersinn.
    pub fn quads(&self) -> Vec<[P2; 4]> {
        let m = self.inner.len();
        let k = if self.closed { m } else { m.saturating_sub(1) };
        (0..k).map(|i| { let j = (i + 1) % m; [self.inner[i], self.inner[j], self.outer[j], self.outer[i]] }).collect()
    }
}

impl ExSpec {
    /// Wandbänder der verbauten Kanten: zusammenhängende verbaute Kanten (auch die Teilkanten eines Bogens, [191])
    /// bilden EIN Band von der Sohlkante um die Wanddicke nach aussen (Gehrung an den Ecken, wie der Arbeitsraum).
    pub fn shoring_bands(&self) -> Vec<ShoringBand> {
        if !self.shored.iter().any(|b| *b) || !(self.shore_t > 0.0) {
            return Vec::new();
        }
        let n = self.ring.len();
        let off = offset_ring_clean(&self.ring, self.shore_t, &arc_edges(&self.smooth));
        if self.shored.iter().all(|b| *b) {
            return vec![ShoringBand { inner: self.ring.clone(), outer: off, closed: true }];
        }
        let mut out = Vec::new();
        for i in 0..n {
            // Anfang eines Laufs: verbaut, Vorgänger nicht.
            if !self.shored[i] || self.shored[(i + n - 1) % n] {
                continue;
            }
            let mut idx = vec![i];
            let mut j = i;
            while self.shored[j] {
                j = (j + 1) % n;
                idx.push(j);
            }
            out.push(ShoringBand { inner: idx.iter().map(|&k| self.ring[k]).collect(), outer: idx.iter().map(|&k| off[k]).collect(), closed: false });
        }
        out
    }
}

/// [68] Verbauwand einer Baugrube als geschlossene Prismen (Modellbezug, Höhen = Gelände − Höhenbezug) für 3D, Ansicht
/// und Pick: je verbauter Kante ein Körper von Sohle − Einbindetiefe bis zum gewachsenen Gelände.
#[derive(Clone, Debug)]
pub struct ShoringSolid {
    pub excavation_id: String,
    pub kind: &'static str,
    /// x, y, z je Ecke.
    pub pos: Vec<f64>,
    pub idx: Vec<u32>,
}

/// Verbauwände aller Baugruben des Projekts, ein [`ShoringSolid`] je Baugrube mit Verbau.
pub fn shoring_solids(p: &Project) -> Vec<ShoringSolid> {
    let mut out: Vec<ShoringSolid> = Vec::new();
    for t in terrains(p) {
        if t.positions.len() < 9 {
            continue;
        }
        let st = site_terrain(p, t);
        let idx = st.index_orig();
        for (id, spec, _) in &st.items {
            if out.iter().any(|s| &s.excavation_id == id) {
                continue;
            }
            let Some(e) = excavations(p).into_iter().find(|e| e.id == *id) else { continue };
            let bands = spec.shoring_bands();
            if bands.is_empty() {
                continue;
            }
            let z_bottom = e.bottom - shoring_embed(e);
            let mut s = ShoringSolid { excavation_id: id.clone(), kind: spec.shore_kind, pos: Vec::new(), idx: Vec::new() };
            for band in bands {
                // [191] Ein Körper je Band: Ober-/Unterseite als Streifen der Teilvierecke, Seiten nur aussen herum
                // (keine Innenflächen zwischen den Teilkanten eines Bogens).
                let quads = band.quads();
                let top_of = |q: &P2| idx.z_at(q[0], q[1]).map(|z| (z - st.datum).max(e.bottom));
                let (ti, to): (Vec<Option<f64>>, Vec<Option<f64>>) = (band.inner.iter().map(top_of).collect(), band.outer.iter().map(top_of).collect());
                if ti.iter().chain(&to).any(Option::is_none) || ti.iter().chain(&to).flatten().all(|z| *z <= e.bottom + 1e-3) || quads.is_empty() {
                    continue;
                }
                // Ecken: innen 0..m, aussen m..2m; je unten, dann oben (+2m).
                let m = band.inner.len() as u32;
                let b = s.pos.len() as u32 / 3;
                for q in band.inner.iter().chain(&band.outer) {
                    s.pos.extend([q[0], q[1], z_bottom]);
                }
                for (q, z) in band.inner.iter().chain(&band.outer).zip(ti.iter().chain(&to)) {
                    s.pos.extend([q[0], q[1], z.unwrap_or(e.bottom)]);
                }
                let (lo, hi) = (|k: u32| b + k, |k: u32| b + 2 * m + k);
                let k = quads.len() as u32;
                for i in 0..k {
                    let j = (i + 1) % m;
                    let (a0, a1, o1, o0) = (i, j, m + j, m + i);
                    // Das Viereck a0 → a1 → o1 → o0 läuft im Uhrzeigersinn (aussen rechts der Sohlkante).
                    // Oberseite (Normale nach oben), Unterseite (nach unten).
                    s.idx.extend([hi(a0), hi(o0), hi(o1), hi(a0), hi(o1), hi(a1)]);
                    s.idx.extend([lo(a0), lo(o1), lo(o0), lo(a0), lo(a1), lo(o1)]);
                    // Sohlseite (Normale in die Grube) und Aussenseite.
                    s.idx.extend([lo(a0), hi(a0), hi(a1), lo(a0), hi(a1), lo(a1)]);
                    s.idx.extend([lo(o0), hi(o1), hi(o0), lo(o0), lo(o1), hi(o1)]);
                }
                if !band.closed {
                    // Stirnseiten am Anfang und am Ende.
                    let (e0, e1) = (m - 1, 2 * m - 1);
                    s.idx.extend([lo(0), lo(m), hi(m), lo(0), hi(m), hi(0)]);
                    s.idx.extend([lo(e0), hi(e1), lo(e1), lo(e0), hi(e0), hi(e1)]);
                }
            }
            if !s.idx.is_empty() {
                out.push(s);
            }
        }
    }
    out
}

/// Prüfung des Arbeitsraums an den Ecken des Umrisses ([68]).
#[derive(Clone, Debug, PartialEq)]
pub struct WsCheck {
    /// Verlangte Breite (m).
    pub required: f64,
    /// Kleinster Abstand zwischen Gebäude-Umriss und Sohle (m), 0 bei Überschneidung.
    pub min_width: f64,
    pub ok: bool,
    /// Stellen, an denen die Breite fehlt (Ecken der Sohle bzw. des Umrisses, Selbstüberschneidungen).
    pub spots: Vec<P2>,
}

fn seg_cross(a: P2, b: P2, c: P2, d: P2) -> Option<P2> {
    let (r, s) = ([b[0] - a[0], b[1] - a[1]], [d[0] - c[0], d[1] - c[1]]);
    let den = r[0] * s[1] - r[1] * s[0];
    if den.abs() < 1e-12 {
        return None;
    }
    let q = [c[0] - a[0], c[1] - a[1]];
    let t = (q[0] * s[1] - q[1] * s[0]) / den;
    let u = (q[0] * r[1] - q[1] * r[0]) / den;
    (t > 1e-9 && t < 1.0 - 1e-9 && u > 1e-9 && u < 1.0 - 1e-9).then(|| [a[0] + t * r[0], a[1] + t * r[1]])
}

fn ring_dist(p: P2, r: &[P2]) -> f64 {
    let n = r.len();
    (0..n).map(|i| seg_dist(p, r[i], r[(i + 1) % n])).fold(f64::INFINITY, f64::min)
}

/// Arbeitsraum an konkaven und spitzen Ecken: Die Sohle ist der um `ws` versetzte Gebäude-Umriss. In engen Nischen
/// (< 2·ws) kreuzen sich die versetzten Kanten, an spitzen Ecken kappt die Gehrung bei 4·ws — dort fehlt Breite.
/// `None` ohne Arbeitsraum.
pub fn working_space_check(spec: &ExSpec) -> Option<WsCheck> {
    if !(spec.ws > 0.0) {
        return None;
    }
    let (base, sole) = (&spec.base, &spec.ring);
    let mut spots: Vec<P2> = Vec::new();
    let mut min_w = f64::INFINITY;
    // Ecken der Sohle zum Umriss (innen = Verletzung) und Ecken des Umrisses zur Sohle (aussen = Verletzung).
    for &v in sole {
        let w = if point_in_ring(v, base) { 0.0 } else { ring_dist(v, base) };
        if w < spec.ws - 1e-6 {
            spots.push(v);
        }
        min_w = min_w.min(w);
    }
    for &v in base {
        let w = if point_in_ring(v, sole) { ring_dist(v, sole) } else { 0.0 };
        if w < spec.ws - 1e-6 {
            spots.push(v);
        }
        min_w = min_w.min(w);
    }
    // Selbstüberschneidung der Sohle (zu enge Nische) und Kreuzung mit dem Umriss.
    let (n, m) = (sole.len(), base.len());
    for i in 0..n {
        for j in i + 2..n {
            if i == 0 && j == n - 1 {
                continue;
            }
            if let Some(x) = seg_cross(sole[i], sole[(i + 1) % n], sole[j], sole[(j + 1) % n]) {
                spots.push(x);
            }
        }
        for j in 0..m {
            if let Some(x) = seg_cross(sole[i], sole[(i + 1) % n], base[j], base[(j + 1) % m]) {
                spots.push(x);
                min_w = 0.0;
            }
        }
    }
    let mut uniq: Vec<P2> = Vec::new();
    for s in spots {
        if !uniq.iter().any(|u| (u[0] - s[0]).hypot(u[1] - s[1]) < 1e-3) {
            uniq.push(s);
        }
    }
    let min_width = if min_w.is_finite() { min_w } else { spec.ws };
    Some(WsCheck { required: spec.ws, min_width, ok: uniq.is_empty(), spots: uniq })
}

/// Regelmässiges Raster über einem Rechteck (Knoten).
struct Grid {
    x0: f64,
    y0: f64,
    s: f64,
    nx: usize,
    ny: usize,
}

impl Grid {
    fn new(b: [f64; 4], s: f64, max_nodes: usize) -> Grid {
        let (w, h) = (b[2] - b[0], b[3] - b[1]);
        let mut s = s;
        while ((w / s).ceil() + 1.0) * ((h / s).ceil() + 1.0) > max_nodes as f64 {
            s *= 1.25;
        }
        Grid { x0: b[0], y0: b[1], s, nx: (w / s).ceil() as usize + 1, ny: (h / s).ceil() as usize + 1 }
    }
    fn at(&self, i: usize, j: usize) -> P2 {
        [self.x0 + i as f64 * self.s, self.y0 + j as f64 * self.s]
    }
    /// TIN des Rasters mit den Werten `v` (NaN = fehlt; Zellen nur mit vier Werten).
    fn tin(&self, v: &[f64]) -> Tin {
        let mut t = Tin { xy: Vec::with_capacity(v.len()), z: v.to_vec(), tris: Vec::new() };
        for j in 0..self.ny {
            for i in 0..self.nx {
                t.xy.push(self.at(i, j));
            }
        }
        for j in 0..self.ny.saturating_sub(1) {
            for i in 0..self.nx.saturating_sub(1) {
                let k = (j * self.nx + i) as u32;
                let q = [k, k + 1, k + 1 + self.nx as u32, k + self.nx as u32];
                if q.iter().all(|&i| v[i as usize].is_finite()) {
                    t.tris.push([q[0], q[1], q[2]]);
                    t.tris.push([q[0], q[2], q[3]]);
                }
            }
        }
        t
    }
}

/// Ergebnis einer Baugrube auf einem Netz.
#[derive(Clone, Debug)]
pub struct Excavated {
    pub tin: Tin,
    /// Böschungsoberkante (Abtrag) bzw. Böschungsfuss (Auftrag) im Gelände.
    pub daylight: Vec<Vec<P2>>,
    pub reach: f64,
    pub step: f64,
}

/// Wendet eine Baugrube auf ein Netz an. `None`, wenn sie das Netz nicht trifft.
pub fn excavate(orig: &Tin, ex: &ExSpec) -> Option<Excavated> {
    let idx = TinIndex::new(orig);
    let c = ex.ring.iter().fold([0.0, 0.0], |a, p| [a[0] + p[0], a[1] + p[1]]);
    let c = [c[0] / ex.ring.len() as f64, c[1] / ex.ring.len() as f64];
    if idx.z_at(c[0], c[1]).is_none() && ex.ring.iter().all(|p| idx.z_at(p[0], p[1]).is_none()) {
        return None;
    }
    let r = ex.reach_in(orig, &idx);
    let b = ex.bbox();
    let s0 = (((b[2] - b[0] + 2.0 * r) * (b[3] - b[1] + 2.0 * r)).sqrt() / 120.0).clamp(0.15, 2.0);
    let reg = [b[0] - r - s0, b[1] - r - s0, b[2] + r + s0, b[3] + r + s0];
    let g = Grid::new(reg, s0, 250_000);
    let s = g.s;
    let mut t_val = vec![f64::NAN; g.nx * g.ny];
    let mut d_val = vec![f64::INFINITY; g.nx * g.ny];
    let (mut cut_phi, mut fill_phi) = (vec![f64::NAN; g.nx * g.ny], vec![f64::NAN; g.nx * g.ny]);
    for j in 0..g.ny {
        for i in 0..g.nx {
            let p = g.at(i, j);
            let k = j * g.nx + i;
            let Some(t) = idx.z_at(p[0], p[1]) else { continue };
            let (d, e) = ex.dist(p);
            t_val[k] = t;
            d_val[k] = d;
            cut_phi[k] = t - (ex.bottom + ex.profile(d, ex.cut_tan[e]));
            fill_phi[k] = (ex.bottom - d * ex.fill_tan) - t;
        }
    }
    let mut pts: Vec<[f64; 3]> = Vec::new();
    let mut cons: Vec<(u32, u32)> = Vec::new();
    let chain = |line: &[P2], z: &dyn Fn(P2) -> Option<f64>, pts: &mut Vec<[f64; 3]>, cons: &mut Vec<(u32, u32)>| {
        let mut prev: Option<u32> = None;
        for &p in line {
            match z(p) {
                Some(h) => {
                    pts.push([p[0], p[1], h]);
                    let k = pts.len() as u32 - 1;
                    if let Some(q) = prev {
                        cons.push((q, k));
                    }
                    prev = Some(k);
                }
                None => prev = None,
            }
        }
    };
    // 1. Umriss der Sohle, verdichtet.
    let n = ex.ring.len();
    let mut ring_pts: Vec<P2> = Vec::new();
    for i in 0..n {
        let (a, q) = (ex.ring[i], ex.ring[(i + 1) % n]);
        let steps = ((a[0] - q[0]).hypot(a[1] - q[1]) / s).ceil().max(1.0) as usize;
        for k in 0..steps {
            let f = k as f64 / steps as f64;
            ring_pts.push([a[0] + (q[0] - a[0]) * f, a[1] + (q[1] - a[1]) * f]);
        }
    }
    ring_pts.push(ring_pts[0]);
    let bottom = ex.bottom;
    chain(&ring_pts, &|p| idx.z_at(p[0], p[1]).map(|t| ex.apply(t, p).min(bottom).max(bottom)), &mut pts, &mut cons);
    // 2. Böschungsoberkante / -fuss: Nullinien von t − hi bzw. lo − t ausserhalb des Umrisses.
    let mut daylight = Vec::new();
    for phi in [&cut_phi, &fill_phi] {
        let gt = g.tin(phi);
        for l in isolines(&gt, 1e12, 0.0) {
            let mut part: Vec<P2> = Vec::new();
            let flush = |part: &mut Vec<P2>, daylight: &mut Vec<Vec<P2>>| {
                if part.len() >= 2 {
                    daylight.push(std::mem::take(part));
                } else {
                    part.clear();
                }
            };
            let mut pl = l.pts.clone();
            if l.closed {
                pl.push(pl[0]);
            }
            for p in pl {
                if ex.dist(p).0 > 1e-6 {
                    part.push(p);
                } else {
                    flush(&mut part, &mut daylight);
                }
            }
            flush(&mut part, &mut daylight);
        }
    }
    for l in &daylight {
        chain(l, &|p| idx.z_at(p[0], p[1]), &mut pts, &mut cons);
    }
    // 3. Rasterpunkte im Wirkbereich.
    for j in 0..g.ny {
        for i in 0..g.nx {
            let k = j * g.nx + i;
            if t_val[k].is_finite() && d_val[k] <= r + s {
                let p = g.at(i, j);
                pts.push([p[0], p[1], ex.apply(t_val[k], p)]);
            }
        }
    }
    // 4. Original ausserhalb samt Kanten.
    let mut keep = vec![u32::MAX; orig.xy.len()];
    for (i, p) in orig.xy.iter().enumerate() {
        if ex.dist(*p).0 > r + 1.5 * s {
            keep[i] = pts.len() as u32;
            pts.push([p[0], p[1], orig.z[i]]);
        }
    }
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    for tr in &orig.tris {
        for k in 0..3 {
            let (a, b) = (keep[tr[k] as usize], keep[tr[(k + 1) % 3] as usize]);
            if a != u32::MAX && b != u32::MAX && seen.insert((a.min(b), a.max(b))) {
                cons.push((a, b));
            }
        }
    }
    let (mut tin, _) = constrained_tin(&pts, &cons, 0.3 * s, 0.0);
    // Dreiecke ausserhalb des Original-Netzes (konkave Ränder) weg.
    let xy = tin.xy.clone();
    tin.tris.retain(|tr| {
        let c = tr.iter().fold([0.0, 0.0], |a, &i| [a[0] + xy[i as usize][0] / 3.0, a[1] + xy[i as usize][1] / 3.0]);
        idx.z_at(c[0], c[1]).is_some()
    });
    Some(Excavated { tin, daylight, reach: r, step: s })
}

// ── Mengen ───────────────────────────────────────────────────────────────────

/// Abtrag, Auftrag, Hinterfüllung (m³) und Sohlenfläche (m²).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Volumes {
    pub cut: f64,
    pub fill: f64,
    pub backfill: f64,
    pub bottom_area: f64,
}

/// Mengen mehrerer Baugruben ohne Doppelzählung: die Baugruben wirken der Reihe nach (wie in [`site_terrain`]),
/// je Probe geht der Höhenunterschied einer Baugrube an sie allein — die Summe ist die Vereinigung.
/// Integriert über ein Raster der Weite ≤ `h` (Mittelpunkte, höchstens ~1.5 Mio. Proben).
/// `footprint`: Gebäude-Grundfläche (Ringe); Abtrag darin zählt nicht zur Hinterfüllung.
/// Sohlenfläche = Fläche des Umrisses ohne die der vorherigen Baugruben (exakt, Polygon-Booleans).
pub fn volumes_union(orig: &Tin, specs: &[&ExSpec], h: f64, footprint: &[Vec<P2>]) -> Vec<Volumes> {
    if specs.is_empty() {
        return Vec::new();
    }
    let idx = TinIndex::new(orig);
    let mut reg = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for ex in specs {
        let (b, r) = (ex.bbox(), ex.reach_in(orig, &idx));
        reg = [reg[0].min(b[0] - r), reg[1].min(b[1] - r), reg[2].max(b[2] + r), reg[3].max(b[3] + r)];
    }
    let (w, hh) = (reg[2] - reg[0], reg[3] - reg[1]);
    let mut h = h.max(1e-3);
    while (w / h).ceil() * (hh / h).ceil() > 1.5e6 {
        h *= 1.2;
    }
    let (nx, ny) = (((w / h).ceil() as usize).max(1), ((hh / h).ceil() as usize).max(1));
    let (hx, hy) = (w / nx as f64, hh / ny as f64);
    let cell = hx * hy;
    let mut out: Vec<Volumes> = specs.iter().map(|_| Volumes::default()).collect();
    for j in 0..ny {
        for i in 0..nx {
            let p = [reg[0] + (i as f64 + 0.5) * hx, reg[1] + (j as f64 + 0.5) * hy];
            let Some(t) = idx.z_at(p[0], p[1]) else { continue };
            let mut cur = t;
            let outside_fp = !footprint.iter().any(|f| point_in_ring(p, f));
            for (k, ex) in specs.iter().enumerate() {
                let next = ex.apply(cur, p);
                let dz = cur - next;
                if dz > 0.0 {
                    out[k].cut += dz * cell;
                    if outside_fp {
                        out[k].backfill += dz * cell;
                    }
                } else {
                    out[k].fill -= dz * cell;
                }
                cur = next;
            }
        }
    }
    // Sohlenfläche exakt: Fläche des Umrisses ohne die der vorherigen Baugruben (Polygon-Booleans, [68]).
    for (k, v) in out.iter_mut().enumerate() {
        let prev: Vec<crate::flat::Polygon> = specs[..k].iter().map(|e| vec![e.ring.clone()]).collect();
        let left = crate::polygon_bool::difference(&[vec![specs[k].ring.clone()]], &prev);
        v.bottom_area = left.iter().flat_map(|poly| poly.iter().map(|r| signed_area(r))).sum::<f64>().max(0.0);
    }
    out
}

/// Mengen einer einzelnen Baugrube (s. [`volumes_union`]).
pub fn volumes(orig: &Tin, ex: &ExSpec, h: f64, footprint: &[Vec<P2>]) -> Volumes {
    volumes_union(orig, &[ex], h, footprint).pop().unwrap_or_default()
}

// ── Gelände mit Baugruben, zwischengespeichert ──────────────────────────────

/// Gelände-Netz samt angewandten Baugruben (Höhen roh, Modell = roh − `datum`).
#[derive(Debug)]
pub struct SiteTerrain {
    pub datum: f64,
    pub orig: Tin,
    /// Gelände nach allen Baugruben; `None`, wenn keine das Netz trifft.
    pub modified: Option<Tin>,
    /// (Baugrube, Spezifikation, Böschungsoberkante)
    pub items: Vec<(String, ExSpec, Vec<Vec<P2>>)>,
    /// [159] Inhalts-Schlüssel (Netz, Höhenbezug, Baugruben) für abgeleitete Caches.
    pub key: u64,
    /// [159] Suchraster von `orig` bzw. `current()`, einmal gebaut.
    grids: [std::cell::OnceCell<crate::terrain::TinGrid>; 2],
}

impl SiteTerrain {
    pub fn current(&self) -> &Tin {
        self.modified.as_ref().unwrap_or(&self.orig)
    }

    /// [159] Suchindex des gewachsenen Netzes (`orig`), Raster gemerkt.
    pub fn index_orig(&self) -> TinIndex<'_> {
        TinIndex::with_grid(&self.orig, self.grids[0].get_or_init(|| TinIndex::new(&self.orig).grid()).clone())
    }

    /// [159] Suchindex des Netzes mit Baugruben (`current()`), Raster gemerkt.
    pub fn index_current(&self) -> TinIndex<'_> {
        TinIndex::with_grid(self.current(), self.grids[1].get_or_init(|| TinIndex::new(self.current()).grid()).clone())
    }
}

pub fn excavations(p: &Project) -> Vec<&Excavation> {
    p.context.as_deref().unwrap_or(&[]).iter().filter_map(|c| if let ContextObject::Excavation(e) = c { Some(e) } else { None }).collect()
}

pub fn terrains(p: &Project) -> Vec<&TerrainMesh> {
    p.context.as_deref().unwrap_or(&[]).iter().filter_map(|c| if let ContextObject::TerrainMesh(t) = c { Some(t) } else { None }).collect()
}

type Cache = Vec<(u64, Rc<SiteTerrain>)>;
thread_local! {
    static CACHE: RefCell<Cache> = const { RefCell::new(Vec::new()) };
}

fn hash_of(p: &Project, t: &TerrainMesh, ex: &[&Excavation]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for v in t.positions.iter().chain(&t.indices) {
        v.to_bits().hash(&mut h);
    }
    p.reference_elevation_masl.map(f64::to_bits).hash(&mut h);
    for e in ex {
        serde_json::to_string(e).unwrap_or_default().hash(&mut h);
    }
    h.finish()
}

/// Gelände-Netz `t` mit allen Baugruben des Projekts (zwischengespeichert, Schlüssel = Inhalt).
pub fn site_terrain(p: &Project, t: &TerrainMesh) -> Rc<SiteTerrain> {
    let ex = excavations(p);
    let key = hash_of(p, t, &ex);
    if let Some(hit) = CACHE.with(|c| c.borrow().iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())) {
        return hit;
    }
    let orig = Tin::from_flat(&t.positions, &t.indices);
    let dz = datum(p.reference_elevation_masl, &orig.z);
    let mut cur: Option<Tin> = None;
    let mut items = Vec::new();
    for e in ex {
        let Some(spec) = ExSpec::of(e, dz) else { continue };
        let base = cur.as_ref().unwrap_or(&orig);
        if let Some(r) = excavate(base, &spec) {
            items.push((e.id.clone(), spec, r.daylight));
            cur = Some(r.tin);
        }
    }
    let st = Rc::new(SiteTerrain { datum: dz, orig, modified: cur, items, key, grids: Default::default() });
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        c.insert(0, (key, st.clone()));
        c.truncate(4);
    });
    st
}

/// Gelände-Netz im Modellbezug samt Baugruben (flach: Positionen, Indizes) und ob es geändert wurde.
/// Ohne Baugrube und ohne Höhenbezug das Original (ohne Kopie).
pub fn terrain_model_mesh<'a>(p: &Project, t: &'a TerrainMesh) -> (std::borrow::Cow<'a, [f64]>, std::borrow::Cow<'a, [f64]>, bool) {
    use std::borrow::Cow;
    let st = site_terrain(p, t);
    if st.modified.is_none() && st.datum == 0.0 {
        return (Cow::Borrowed(&t.positions), Cow::Borrowed(&t.indices), false);
    }
    let (pos, idx) = st.current().to_flat(-st.datum);
    (Cow::Owned(pos), Cow::Owned(idx), st.modified.is_some())
}

/// [227] Das gewachsene Gelände-Netz im Modellbezug, ohne Baugruben (hinterfüllt, z. B. für Bilder).
pub fn terrain_original_mesh(p: &Project, t: &TerrainMesh) -> (std::borrow::Cow<'static, [f64]>, std::borrow::Cow<'static, [f64]>, bool) {
    let st = site_terrain(p, t);
    let (pos, idx) = st.orig.to_flat(-st.datum);
    (std::borrow::Cow::Owned(pos), std::borrow::Cow::Owned(idx), false)
}

/// [T6] Luftbild-Farben (flach r,g,b je Eckpunkt des Original-Netzes) auf das geänderte Gelände übertragen:
/// jeder neue Eckpunkt erhält die in der Grundrissprojektion (x, y) des Originals interpolierte Farbe
/// (Böschungen und Sohle bekommen so die Farbe des Bildes darüber); ausserhalb der nächste Eckpunkt.
pub fn reproject_colors(orig: &Tin, colors: &[f64], new: &Tin) -> Vec<f64> {
    let idx = TinIndex::new(orig);
    let col = |i: usize| -> [f64; 3] { [colors[3 * i], colors[3 * i + 1], colors[3 * i + 2]] };
    let mut out = Vec::with_capacity(new.xy.len() * 3);
    for p in &new.xy {
        let c = match idx.bary_at(p[0], p[1]) {
            Some((t, l)) => {
                let (a, b, c) = (col(t[0]), col(t[1]), col(t[2]));
                [0, 1, 2].map(|k| l[0] * a[k] + l[1] * b[k] + l[2] * c[k])
            }
            None => {
                let n = orig.xy.iter().enumerate().min_by(|a, b| (a.1[0] - p[0]).hypot(a.1[1] - p[1]).total_cmp(&(b.1[0] - p[0]).hypot(b.1[1] - p[1]))).map_or(0, |x| x.0);
                col(n)
            }
        };
        out.extend(c);
    }
    out
}

/// Vertex-Farben des Geländes im Modell: unverändert, oder auf das Netz mit Baugruben übertragen.
/// `None` ohne (passende) Farben.
pub fn terrain_vertex_colors(p: &Project, t: &TerrainMesh) -> Option<Vec<f64>> {
    let c = t.vertex_colors.as_ref().filter(|v| !v.is_empty())?;
    let st = site_terrain(p, t);
    match &st.modified {
        None => Some(c.clone()),
        Some(m) => (c.len() == st.orig.xy.len() * 3).then(|| reproject_colors(&st.orig, c, m)),
    }
}

/// Mengen je Baugrube (gegen das gewachsene Terrain des ersten Netzes, das sie trifft).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExQty {
    pub id: String,
    pub name: String,
    pub bottom: f64,
    pub bottom_area: f64,
    pub cut: f64,
    pub fill: f64,
    pub backfill: f64,
    /// [68] Arbeitsraum: verlangte Breite, kleinster Abstand Umriss–Sohle, eingehalten? Ohne Arbeitsraum 0 / 0 / true.
    pub working_space: f64,
    pub working_space_min: f64,
    pub working_space_ok: bool,
    /// Stellen mit fehlender Breite (Modell-x/y).
    pub working_space_spots: Vec<[f64; 2]>,
}

pub fn quantities(p: &Project) -> Vec<ExQty> {
    let fp: Vec<Vec<P2>> = crate::site_rules::building_footprint(p).iter().flat_map(|poly| poly.first().map(|r| r.iter().map(|v| [v.x, v.y]).collect::<Vec<P2>>())).collect();
    let mut done: Vec<ExQty> = Vec::new();
    // Je Gelände-Netz alle Baugruben, die es trifft, zusammen (Überlagerungen zählen einmal).
    for t in terrains(p) {
        let st = site_terrain(p, t);
        let hits: Vec<&(String, ExSpec, Vec<Vec<P2>>)> = st.items.iter().filter(|(id, ..)| !done.iter().any(|q| q.id == *id)).collect();
        if hits.is_empty() {
            continue;
        }
        let specs: Vec<&ExSpec> = hits.iter().map(|(_, s, _)| s).collect();
        let (x0, x1) = specs.iter().flat_map(|s| s.ring.iter().map(|q| q[0])).fold((f64::INFINITY, f64::NEG_INFINITY), |a, x| (a.0.min(x), a.1.max(x)));
        let h = ((x1 - x0).max(1.0) / 400.0).clamp(0.02, 0.5);
        let vols = volumes_union(&st.orig, &specs, h, &fp);
        for ((id, spec, _), v) in hits.iter().zip(vols) {
            let Some(e) = excavations(p).into_iter().find(|e| e.id == *id) else { continue };
            let ws = working_space_check(spec);
            done.push(ExQty {
                id: e.id.clone(),
                name: e.name.clone(),
                bottom: e.bottom,
                bottom_area: v.bottom_area,
                cut: v.cut,
                fill: v.fill,
                backfill: v.backfill,
                working_space: ws.as_ref().map_or(0.0, |w| w.required),
                working_space_min: ws.as_ref().map_or(0.0, |w| w.min_width),
                working_space_ok: ws.as_ref().is_none_or(|w| w.ok),
                working_space_spots: ws.map_or_else(Vec::new, |w| w.spots),
            });
        }
    }
    // Reihenfolge wie im Modell.
    let order: Vec<&str> = excavations(p).iter().map(|e| e.id.as_str()).collect();
    done.sort_by_key(|q| order.iter().position(|i| *i == q.id).unwrap_or(usize::MAX));
    done
}

/// Höhe des gewachsenen (`designed = false`) bzw. gestalteten Terrains im Modellbezug; `None` ohne Gelände.
pub fn terrain_z(p: &Project, x: f64, y: f64, designed: bool) -> Option<f64> {
    for t in terrains(p) {
        let st = site_terrain(p, t);
        let tin = if designed { st.current() } else { &st.orig };
        if let Some(z) = TinIndex::new(tin).z_at(x, y) {
            return Some(z - st.datum);
        }
    }
    None
}

/// [159] Wie [`terrain_z`] für viele Punkte: Gelände (samt Baugruben) und Suchindex einmal statt je Punkt.
/// Antwort je Punkt `(gewachsen, gestaltet)`.
pub fn terrain_z_many(p: &Project, pts: &[P2]) -> Vec<(Option<f64>, Option<f64>)> {
    let sts: Vec<Rc<SiteTerrain>> = terrains(p).into_iter().map(|t| site_terrain(p, t)).collect();
    let idx: Vec<(TinIndex, TinIndex, f64)> = sts.iter().map(|st| (st.index_orig(), st.index_current(), st.datum)).collect();
    let z = |q: &P2, designed: bool| idx.iter().find_map(|(o, c, d)| (if designed { c } else { o }).z_at(q[0], q[1]).map(|z| z - d));
    pts.iter().map(|q| (z(q, false), z(q, true))).collect()
}

// ── Grundriss: Böschungsschraffur ────────────────────────────────────────────

/// Böschungsschraffur: Striche von der Oberkante zur Unterkante, abwechselnd lang und halb, im Abstand
/// `spacing` entlang des Umrisses (an konvexen Ecken gefächert). `t` = Gelände vor dieser Baugrube.
type HatchCache = Vec<((u64, String, u64), Rc<Vec<(P2, P2)>>)>;
thread_local! {
    static HATCH: RefCell<HatchCache> = const { RefCell::new(Vec::new()) };
}

/// [159] [`slope_hatch`] der Baugrube `id` auf dem Gelände davor ([`terrain_before`]), zwischengespeichert
/// (Schlüssel: Inhalt des Geländes, Baugrube, Abstand); `None` ohne die Baugrube.
pub fn slope_hatch_of(st: &SiteTerrain, id: &str, spec: &ExSpec, spacing: f64) -> Option<Rc<Vec<(P2, P2)>>> {
    let key = (st.key, id.to_string(), spacing.to_bits());
    if let Some(hit) = HATCH.with(|c| c.borrow().iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())) {
        return Some(hit);
    }
    let before = terrain_before(st, id)?;
    let v = Rc::new(slope_hatch(&before, spec, spacing));
    HATCH.with(|c| {
        let mut c = c.borrow_mut();
        c.insert(0, (key, v.clone()));
        c.truncate(8);
    });
    Some(v)
}

/// Kleinster Knick einer konvexen Ecke mit Strich-Fächer (5°); flachere Ecken sind von den Strichen der beiden
/// Kanten schon gedeckt.
const FAN_MIN_TURN: f64 = 5.0 * std::f64::consts::PI / 180.0;

pub fn slope_hatch(t: &Tin, ex: &ExSpec, spacing: f64) -> Vec<(P2, P2)> {
    let idx = TinIndex::new(t);
    let r = ex.reach_in(t, &idx).max(spacing);
    let step = (spacing / 4.0).max(0.02);
    // Länge des geänderten Bereichs entlang des Strahls q + n·L; Vorzeichen: Abtrag (true) / Auftrag.
    let ray = |q: P2, n: P2| -> Option<(f64, bool)> {
        let mut last: Option<(f64, bool)> = None;
        let mut l = step / 2.0;
        while l <= r + step {
            let p = [q[0] + n[0] * l, q[1] + n[1] * l];
            let tz = idx.z_at(p[0], p[1])?;
            let dz = tz - ex.apply(tz, p);
            if dz.abs() < 1e-6 {
                break;
            }
            last = Some((l, dz > 0.0));
            l += step;
        }
        last
    };
    let n = ex.ring.len();
    let normal = |i: usize| {
        let (a, b) = (ex.ring[i], ex.ring[(i + 1) % n]);
        let l = (b[0] - a[0]).hypot(b[1] - a[1]).max(1e-12);
        [(b[1] - a[1]) / l, -(b[0] - a[0]) / l]
    };
    let mut rays: Vec<(P2, P2)> = Vec::new();
    // [191] Läufe von Kanten zwischen zwei Ecken: Punkte im Inneren eines Bogens (fein geteilt) sind keine Ecken —
    // die Striche laufen im Abstand `spacing` über den ganzen Bogen, ohne Fächer an jedem kleinen Knick.
    let corner = |v: usize| !ex.smooth.get(v).copied().unwrap_or(false);
    let starts: Vec<usize> = (0..n).filter(|&v| corner(v)).collect();
    let cyclic = starts.is_empty();
    let runs: Vec<(usize, usize)> = if cyclic {
        vec![(0, n)]
    } else {
        starts.iter().enumerate().map(|(k, &v)| (v, (starts[(k + 1) % starts.len()] + n - v - 1) % n + 1)).collect()
    };
    for (v0, m) in runs {
        let edges: Vec<usize> = (0..m).map(|k| (v0 + k) % n).collect();
        if ex.shored[edges[0]] {
            continue;
        }
        let lens: Vec<f64> = edges.iter().map(|&i| { let (a, b) = (ex.ring[i], ex.ring[(i + 1) % n]); (b[0] - a[0]).hypot(b[1] - a[1]) }).collect();
        let total: f64 = lens.iter().sum();
        // Normale im Punkt v: an einer Ecke die der Kante i, im Bogen das Mittel der beiden Kanten (radial).
        let vnormal = |v: usize, i: usize| -> P2 {
            if corner(v) {
                return normal(i);
            }
            let (a, b) = (normal((v + n - 1) % n), normal(v % n));
            let (x, y) = (a[0] + b[0], a[1] + b[1]);
            let l = x.hypot(y);
            if l > 1e-12 { [x / l, y / l] } else { normal(i) }
        };
        // Stelle s entlang des Laufs: Punkt und Normale dort (zwischen den Punkt-Normalen gemittelt, damit die
        // Striche im Bogen radial stehen statt je Teilkante gekippt).
        let at = |s: f64| -> (P2, P2) {
            let mut rest = s;
            for (k, &i) in edges.iter().enumerate() {
                if rest <= lens[k] || k + 1 == edges.len() {
                    let (a, b) = (ex.ring[i], ex.ring[(i + 1) % n]);
                    let f = (rest / lens[k].max(1e-12)).clamp(0.0, 1.0);
                    let (na, nb) = (vnormal(i, i), vnormal((i + 1) % n, i));
                    let (x, y) = (na[0] + (nb[0] - na[0]) * f, na[1] + (nb[1] - na[1]) * f);
                    let l = x.hypot(y).max(1e-12);
                    return ([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], [x / l, y / l]);
                }
                rest -= lens[k];
            }
            (ex.ring[v0], normal(v0))
        };
        if cyclic {
            let k = ((total / spacing).round() as usize).max(1);
            for s in 0..k {
                rays.push(at(total * s as f64 / k as f64));
            }
            continue;
        }
        let k = (total / spacing).floor() as usize;
        let off = (total - k as f64 * spacing) / 2.0;
        for s in 0..=k {
            let pos = off + s as f64 * spacing;
            if pos <= 1e-9 || pos >= total - 1e-9 {
                continue;
            }
            rays.push(at(pos));
        }
        // Fächer an der konvexen Ecke am Ende des Laufs (nicht an einer fast tangentialen, z. B. Gerade → Bogen).
        let (last, next) = (edges[m - 1], (edges[m - 1] + 1) % n);
        let b = ex.ring[next];
        let (nn, n2) = (normal(last), normal(next));
        let cross = nn[0] * n2[1] - nn[1] * n2[0];
        if cross > FAN_MIN_TURN.sin() && !ex.shored[next] {
            let a0 = nn[1].atan2(nn[0]);
            let mut a1 = n2[1].atan2(n2[0]);
            if a1 < a0 {
                a1 += std::f64::consts::TAU;
            }
            let mid = [((a0 + a1) / 2.0).cos(), ((a0 + a1) / 2.0).sin()];
            let lm = ray(b, mid).map_or(0.0, |r| r.0);
            let m = ((a1 - a0) * lm / spacing).floor() as usize;
            for s in 0..=m {
                let ang = a0 + (a1 - a0) * s as f64 / m.max(1) as f64;
                rays.push((b, [ang.cos(), ang.sin()]));
            }
        }
    }
    let mut out = Vec::new();
    for (k, (q, nn)) in rays.into_iter().enumerate() {
        let Some((l, cut)) = ray(q, nn) else { continue };
        let far = [q[0] + nn[0] * l, q[1] + nn[1] * l];
        let (top, bot) = if cut { (far, q) } else { (q, far) };
        let f = if k % 2 == 0 { 1.0 } else { 0.5 };
        out.push((top, [top[0] + (bot[0] - top[0]) * f, top[1] + (bot[1] - top[1]) * f]));
    }
    out
}

/// Gelände vor der Baugrube `id` (für die Schraffur); `None`, wenn sie das Netz nicht trifft.
pub fn terrain_before(st: &SiteTerrain, id: &str) -> Option<Tin> {
    let pos = st.items.iter().position(|(i, ..)| i == id)?;
    if pos == 0 {
        return Some(st.orig.clone());
    }
    let mut cur = st.orig.clone();
    for (_, spec, _) in &st.items[..pos] {
        cur = excavate(&cur, spec)?.tin;
    }
    Some(cur)
}

// ── Auswahl ([137]) ──────────────────────────────────────────────────────────

/// [137] Baugrube, die das Gelände am Punkt (x, y) ändert (Sohle oder Böschung/Schüttung), sonst `None`.
/// `idx` = Index des gewachsenen Netzes (`st.orig`); die Baugruben wirken der Reihe nach wie im Netz.
pub fn owner_at<'a>(st: &'a SiteTerrain, idx: &TinIndex, x: f64, y: f64) -> Option<&'a str> {
    let p = [x, y];
    let mut z = idx.z_at(x, y);
    for (id, spec, _) in &st.items {
        if point_in_ring(p, &spec.ring) {
            return Some(id);
        }
        if let Some(t) = z {
            let n = spec.apply(t, p);
            if (n - t).abs() > 0.005 {
                return Some(id);
            }
            z = Some(n);
        }
    }
    None
}

/// [137] Wirkbereich einer Baugrube im Grundriss (Pick-Fläche): konvexe Hülle aus Sohle und
/// Böschungsoberkante, gegen den Uhrzeigersinn. Leer, wenn sie kein Gelände trifft.
pub fn affected_hull(st: &SiteTerrain, id: &str) -> Vec<P2> {
    let Some((_, spec, daylight)) = st.items.iter().find(|(i, ..)| i == id) else { return Vec::new() };
    let mut pts: Vec<P2> = spec.ring.iter().chain(daylight.iter().flatten()).copied().filter(|q| q[0].is_finite() && q[1].is_finite()).collect();
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: P2, a: P2, b: P2| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut hull: Vec<P2> = Vec::with_capacity(pts.len() + 1);
    for pass in 0..2 {
        let start = hull.len();
        let it: Box<dyn Iterator<Item = &P2>> = if pass == 0 { Box::new(pts.iter()) } else { Box::new(pts.iter().rev()) };
        for &q in it {
            while hull.len() >= start + 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], q) <= 0.0 {
                hull.pop();
            }
            hull.push(q);
        }
        hull.pop();
    }
    hull
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Vec2;
    use crate::terrain::{mesh_volume, prism, watertight};
    use std::f64::consts::PI;

    fn flat(z: f64, half: f64) -> Tin {
        Tin { xy: vec![[-half, -half], [half, -half], [half, half], [-half, half]], z: vec![z; 4], tris: vec![[0, 1, 2], [0, 2, 3]] }
    }

    fn square(e: f64, bottom: f64) -> Excavation {
        Excavation {
            id: "bg".into(),
            outline: vec![Vec2 { x: -e, y: -e }, Vec2 { x: e, y: -e }, Vec2 { x: e, y: e }, Vec2 { x: -e, y: e }],
            bottom,
            slope: Some(45.0),
            ..Default::default()
        }
    }

    #[test]
    fn aushub_wie_analytisch() {
        // 10 × 10 m, 3 m tief, 45°: V = A·h + U·h²/(2 tan α) + π h³/(3 tan² α).
        let ex = ExSpec::of(&square(5.0, -3.0), 0.0).unwrap();
        let t = flat(0.0, 50.0);
        let exact = 100.0 * 3.0 + 40.0 * 9.0 / 2.0 + std::f64::consts::PI * 27.0 / 3.0;
        let v = volumes(&t, &ex, 0.02, &[]);
        assert!((v.cut - exact).abs() < 2e-3 * exact, "{} vs {exact}", v.cut);
        assert!(v.fill.abs() < 1e-9 && (v.bottom_area - 100.0).abs() < 1e-9);
        // Hinterfüllung: ohne Gebäude = Abtrag; mit Gebäude 10 × 10 = Abtrag − 300.
        assert!((v.backfill - v.cut).abs() < 1e-9);
        let fp = vec![vec![[-5.0, -5.0], [5.0, -5.0], [5.0, 5.0], [-5.0, 5.0]]];
        let v2 = volumes(&t, &ex, 0.02, &fp);
        assert!((v.cut - v2.backfill - 300.0).abs() < 1.0, "{}", v2.backfill);
        // Netz: dicht als Prisma, Volumen-Differenz ≈ Aushub.
        let r = excavate(&t, &ex).unwrap();
        let (v0, f0) = prism(&t, -10.0);
        let (v1, f1) = prism(&r.tin, -10.0);
        assert!(watertight(&f1));
        let dv = mesh_volume(&v0, &f0) - mesh_volume(&v1, &f1);
        assert!((dv - exact).abs() < 0.02 * exact, "{dv} vs {exact}");
        // Sohle und Böschungsoberkante: Oberkante als geschlossener Ring bei d = 3.
        let z = TinIndex::new(&r.tin).z_at(0.0, 0.0).unwrap();
        assert!((z + 3.0).abs() < 1e-9);
        assert!(!r.daylight.is_empty());
        for l in &r.daylight {
            for q in l {
                assert!((ex.dist(*q).0 - 3.0).abs() < 0.1, "{q:?}");
            }
        }
    }

    #[test]
    fn arbeitsraum_verbau_und_ueberlappung() {
        // Arbeitsraum 1 m: Sohle 12 × 12 statt 10 × 10 (Gehrung), Mengen wachsen entsprechend.
        let mut e = square(5.0, -3.0);
        e.working_space = Some(1.0);
        let ws = ExSpec::of(&e, 0.0).unwrap();
        assert!((signed_area(&ws.ring) - 144.0).abs() < 1e-9, "{}", signed_area(&ws.ring));
        // Senkrechter Verbau auf allen Kanten: Abtrag = Sohle × Tiefe (kaum Böschung), keine Schraffur.
        let mut e = square(5.0, -3.0);
        e.edge_shoring = Some(vec![true; 4]);
        let sh = ExSpec::of(&e, 0.0).unwrap();
        let t = flat(0.0, 50.0);
        let v = volumes(&t, &sh, 0.05, &[]);
        assert!((v.cut - 300.0).abs() < 0.03 * 300.0, "{}", v.cut);
        assert!(slope_hatch(&t, &sh, 0.5).is_empty());
        // Nur eine Kante verbaut: Hatch an den anderen drei bleibt, Index folgt dem Umlaufsinn (auch im Uhrzeigersinn).
        let mut e = square(5.0, -3.0);
        e.outline.reverse();
        e.edge_shoring = Some(vec![true, false, false, false]);
        let one = ExSpec::of(&e, 0.0).unwrap();
        assert_eq!(one.shored.iter().filter(|b| **b).count(), 1);
        // Überlagerung: zwei sich überdeckende Gruben zählen die gemeinsame Fläche einmal.
        let mut a = square(5.0, -3.0);
        a.id = "a".into();
        let mut b = square(5.0, -3.0);
        b.id = "b".into();
        let (sa, sb) = (ExSpec::of(&a, 0.0).unwrap(), ExSpec::of(&b, 0.0).unwrap());
        let single = volumes(&t, &sa, 0.1, &[]);
        let both = volumes_union(&t, &[&sa, &sb], 0.1, &[]);
        assert!((both[0].cut + both[1].cut - single.cut).abs() < 1e-6, "{} vs {}", both[0].cut + both[1].cut, single.cut);
        assert!(both[1].cut.abs() < 1e-6 && both[1].bottom_area < 1.0, "{:?}", both[1]);
        // Teilweise versetzt: Summe < Summe der Einzelmengen, > jede einzelne.
        let mut c = square(5.0, -3.0);
        for q in &mut c.outline {
            q.x += 6.0;
        }
        let sc = ExSpec::of(&c, 0.0).unwrap();
        let sep = volumes(&t, &sc, 0.1, &[]);
        let u = volumes_union(&t, &[&sa, &sc], 0.1, &[]);
        let sum = u[0].cut + u[1].cut;
        assert!(sum < single.cut + sep.cut - 1.0 && sum > single.cut, "{sum}");
    }

    #[test]
    fn sohlenflaeche_ueberlappung_exakt() {
        // Zwei 10 × 10-Gruben, die zweite um 6 m versetzt: gemeinsam 4 × 10, also bleiben 60 m² (exakt, nicht gerastert).
        let t = flat(0.0, 50.0);
        let sa = ExSpec::of(&square(5.0, -3.0), 0.0).unwrap();
        let mut c = square(5.0, -3.0);
        for q in &mut c.outline {
            q.x += 6.0 + 0.0123;
        }
        let sc = ExSpec::of(&c, 0.0).unwrap();
        let u = volumes_union(&t, &[&sa, &sc], 0.5, &[]);
        assert!((u[0].bottom_area - 100.0).abs() < 1e-6, "{}", u[0].bottom_area);
        assert!((u[1].bottom_area - (100.0 - 10.0 * (5.0 - (1.0 + 0.0123)))).abs() < 1e-6, "{}", u[1].bottom_area);
        // Vollständig überdeckt: 0.
        let same = volumes_union(&t, &[&sa, &sa], 0.5, &[]);
        assert!(same[1].bottom_area.abs() < 1e-6);
    }

    #[test]
    fn arbeitsraum_ecken_und_nischen() {
        let v = |x: f64, y: f64| Vec2 { x, y };
        let pit = |pts: Vec<Vec2>, ws: f64| Excavation { id: "bg".into(), outline: pts, bottom: -3.0, working_space: Some(ws), ..Default::default() };
        // Rechteck und L-Form (konkave Ecke): Breite eingehalten.
        let l = pit(vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 4.0), v(4.0, 4.0), v(4.0, 10.0), v(0.0, 10.0)], 1.0);
        let c = working_space_check(&ExSpec::of(&l, 0.0).unwrap()).unwrap();
        assert!(c.ok && c.spots.is_empty() && (c.min_width - 1.0).abs() < 1e-6, "{c:?}");
        // Schmale Nische (1 m < 2 · 1 m Arbeitsraum): die versetzten Kanten kreuzen sich, Stelle gemeldet.
        let u = pit(vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 10.0), v(5.5, 10.0), v(5.5, 3.0), v(4.5, 3.0), v(4.5, 10.0), v(0.0, 10.0)], 1.0);
        let c = working_space_check(&ExSpec::of(&u, 0.0).unwrap()).unwrap();
        assert!(!c.ok && !c.spots.is_empty(), "{c:?}");
        // Breite Nische (3 m): in Ordnung.
        let w = pit(vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 10.0), v(6.5, 10.0), v(6.5, 3.0), v(3.5, 3.0), v(3.5, 10.0), v(0.0, 10.0)], 1.0);
        assert!(working_space_check(&ExSpec::of(&w, 0.0).unwrap()).unwrap().ok);
        // Sehr spitze Ecke: Gehrung wird gekappt, dort fehlt Breite.
        let spike = pit(vec![v(0.0, 0.0), v(20.0, 0.5), v(0.0, 1.0)], 1.0);
        assert!(!working_space_check(&ExSpec::of(&spike, 0.0).unwrap()).unwrap().ok);
        // Ohne Arbeitsraum keine Prüfung.
        assert!(working_space_check(&ExSpec::of(&square(5.0, -3.0), 0.0).unwrap()).is_none());
    }

    #[test]
    fn verbau_baender_und_arten() {
        let mut e = square(5.0, -3.0);
        e.edge_shoring = Some(vec![true, false, false, false]);
        let spec = ExSpec::of(&e, 0.0).unwrap();
        assert_eq!((spec.shore_kind, spec.shore_t), ("sheetPile", 0.2));
        let q = spec.shoring_bands();
        assert_eq!(q.len(), 1);
        assert_eq!((q[0].inner.len(), q[0].quads().len()), (2, 1));
        // 10 m × 0.2 m plus die Gehrungsdreiecke an den Enden.
        assert!((signed_area(&q[0].polygon()).abs() - 2.04).abs() < 1e-9, "{}", signed_area(&q[0].polygon()));
        // Band liegt ausserhalb der Sohle.
        assert!(q[0].outer.iter().all(|p| !point_in_ring(*p, &spec.ring)));
        // Zwei anstossende verbaute Kanten: EIN Band über die Ecke; ringsum verbaut: geschlossenes Band.
        e.edge_shoring = Some(vec![true, true, false, false]);
        let b = ExSpec::of(&e, 0.0).unwrap().shoring_bands();
        assert_eq!((b.len(), b[0].inner.len()), (1, 3));
        e.edge_shoring = Some(vec![true; 4]);
        let b = ExSpec::of(&e, 0.0).unwrap().shoring_bands();
        assert!(b.len() == 1 && b[0].closed && b[0].quads().len() == 4);
        e.edge_shoring = Some(vec![true, false, false, false]);
        e.shoring_kind = Some("borePile".into());
        e.shoring_thickness = Some(0.9);
        let spec = ExSpec::of(&e, 0.0).unwrap();
        assert_eq!((spec.shore_kind, spec.shore_t), ("borePile", 0.9));
        assert_eq!(shoring_hatch_id(spec.shore_kind), "std-h-beton");
        // Ohne Verbau keine Bänder.
        assert!(ExSpec::of(&square(5.0, -3.0), 0.0).unwrap().shoring_bands().is_empty());
    }

    /// [191] Baugrube 10 × 6 m, Ostkante als Halbkreis nach aussen (r = 3, tangential an Süd- und Nordkante).
    fn bogen_pit() -> Excavation {
        let v = |x: f64, y: f64| Vec2 { x, y };
        Excavation { id: "bg".into(), outline: vec![v(-5.0, -3.0), v(5.0, -3.0), v(5.0, 3.0), v(-5.0, 3.0)], outline_bulge: Some(vec![0.0, -1.0, 0.0, 0.0]), bottom: -3.0, slope: Some(45.0), ..Default::default() }
    }

    /// [191] Bogenkante: fein geteilt (Punkte auf dem Kreis, im Inneren glatt), Mengen wie analytisch für die
    /// glatte Form, Böschungsschraffur im gleichen Abstand über den Bogen — kein Fächer an den kleinen Knicken.
    #[test]
    fn bogenkante_glatte_boeschung() {
        let ex = ExSpec::of(&bogen_pit(), 0.0).unwrap();
        let on_arc: Vec<&P2> = ex.ring.iter().filter(|q| q[0] > 5.0 + 1e-9).collect();
        assert!(on_arc.len() + 1 >= 48, "{} Teile", on_arc.len() + 1);
        assert!(on_arc.iter().all(|q| ((q[0] - 5.0).hypot(q[1]) - 3.0).abs() < 1e-9));
        assert_eq!(ex.smooth.iter().filter(|s| **s).count(), on_arc.len());
        assert_eq!(ex.cut_tan.len(), ex.ring.len());
        // Mengen: V = A·h + U·h²/2 + π h³/3 (45°, konvex, glatter Bogen); Sohle exakt bis auf die Sehnen.
        let t = flat(0.0, 60.0);
        let (a, u, h) = (60.0 + PI * 4.5, 26.0 + 3.0 * PI, 3.0);
        let exact = a * h + u * h * h / 2.0 + PI * h * h * h / 3.0;
        let v = volumes(&t, &ex, 0.02, &[]);
        assert!((v.cut - exact).abs() < 3e-3 * exact, "{} vs {exact}", v.cut);
        assert!((v.bottom_area - a).abs() < 2e-2 && (bogen_pit().outline_area() - a).abs() < 1e-12, "{}", v.bottom_area);
        // Schraffur: Striche radial vom Bogen bis zur Böschungsoberkante (Abstand 6 vom Mittelpunkt), Teilung 0.5 m.
        let sp = 0.5;
        let hatch = slope_hatch(&t, &ex, sp);
        let mut ang: Vec<f64> = hatch.iter().filter(|(top, _)| top[0] > 5.0 + 1e-6 && ((top[0] - 5.0).hypot(top[1]) - 6.0).abs() < 0.15).map(|(top, _)| top[1].atan2(top[0] - 5.0)).collect();
        ang.sort_by(f64::total_cmp);
        let want = PI * 3.0 / sp;
        assert!((ang.len() as f64 - want).abs() <= 2.0, "{} Striche am Bogen, erwartet ≈ {want}", ang.len());
        let gaps: Vec<f64> = ang.windows(2).map(|w| (w[1] - w[0]) * 3.0).collect();
        assert!(gaps.iter().all(|g| (g - sp).abs() < 0.1 * sp), "{gaps:?}");
        // Gerade Kanten unverändert: Striche alle `sp` auf der Südkante.
        let south = hatch.iter().filter(|(top, _)| top[1] < -3.0 - 1e-6 && top[0].abs() < 4.9).count();
        assert!((south as f64 - 10.0 / sp).abs() <= 1.0, "{south}");
    }

    /// [191] Arbeitsraum und Verbau an der Bogenkante: Sohle um den Arbeitsraum nach aussen (ohne Gehrungs-Spitzen,
    /// Prüfung eingehalten), Verbau als EIN Band über den ganzen Bogen, Verbaukörper geschlossen.
    #[test]
    fn bogenkante_arbeitsraum_und_verbau() {
        let mut e = bogen_pit();
        e.working_space = Some(1.0);
        let ex = ExSpec::of(&e, 0.0).unwrap();
        let c = working_space_check(&ex).unwrap();
        assert!(c.ok && (c.min_width - 1.0).abs() < 1e-6, "{c:?}");
        for q in ex.ring.iter().filter(|q| q[0] > 5.0 + 1e-6) {
            assert!(((q[0] - 5.0).hypot(q[1]) - 4.0).abs() < 2e-3, "{q:?}");
        }
        // Erker: Halbkreis (r = 2) aus der Mitte der Ostkante, an beiden Enden eine einspringende Ecke. Die versetzten
        // kurzen Bogen-Teilkanten an der Ecke kehren sich um (Schwalbenschwanz) — sie entfallen, die Sohle bleibt
        // einfach und hält den Arbeitsraum überall ein.
        let v = |x: f64, y: f64| Vec2 { x, y };
        let erker = Excavation { outline: vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 3.0), v(10.0, 7.0), v(10.0, 10.0), v(0.0, 10.0)], outline_bulge: Some(vec![0.0, 0.0, -1.0, 0.0, 0.0, 0.0]), working_space: Some(0.8), edge_shoring: Some(vec![false, false, true, false, false, false]), ..bogen_pit() };
        let ex = ExSpec::of(&erker, 0.0).unwrap();
        let c = working_space_check(&ex).unwrap();
        assert!(c.ok && (c.min_width - 0.8).abs() < 1e-6, "{c:?}");
        let n = ex.ring.len();
        assert_eq!((ex.cut_tan.len(), ex.shored.len(), ex.smooth.len()), (n, n, n));
        for i in 0..n {
            for j in i + 2..n {
                if !(i == 0 && j == n - 1) {
                    assert!(seg_cross(ex.ring[i], ex.ring[(i + 1) % n], ex.ring[j], ex.ring[(j + 1) % n]).is_none(), "Sohle kreuzt sich: Kante {i} / {j}");
                }
            }
        }
        // Sohle auf dem Kreis r = 2.8 bzw. auf den versetzten Geraden.
        for q in &ex.ring {
            let d = (q[0] - 10.0).hypot(q[1] - 5.0);
            assert!((d - 2.8).abs() < 2e-3 || (q[0] - 10.8).abs() < 1e-9 || q[0] < 10.8, "{q:?} {d}");
        }
        // Verbau am Bogen: Band ohne umgekehrte Vierecke.
        for b in ex.shoring_bands() {
            for q in b.quads() {
                assert!(signed_area(&q) <= 1e-12, "Viereck umgekehrt: {q:?}");
            }
        }
        let mut e = bogen_pit();
        e.edge_shoring = Some(vec![false, true, false, false]);
        let ex = ExSpec::of(&e, 0.0).unwrap();
        let bands = ex.shoring_bands();
        assert_eq!(bands.len(), 1);
        assert_eq!(bands[0].inner.len(), ex.ring.iter().filter(|q| q[0] > 5.0 - 1e-9).count());
        let ring_area = PI / 2.0 * (3.2f64.powi(2) - 9.0);
        assert!((signed_area(&bands[0].polygon()).abs() - ring_area).abs() < 5e-3, "{}", signed_area(&bands[0].polygon()));
        // Verbaukörper: dicht (jede Kante in genau zwei Dreiecken), Höhe Sohle − 1 m bis Gelände.
        let t = crate::model::TerrainMesh { id: "t".into(), positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
        let p = Project { context: Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(e)]), ..Default::default() };
        let solids = shoring_solids(&p);
        assert_eq!(solids.len(), 1);
        let tris: Vec<[u32; 3]> = solids[0].idx.chunks_exact(3).map(|q| [q[0], q[1], q[2]]).collect();
        assert!(watertight(&tris));
        // Volumen positiv (Dreiecke nach aussen) ≈ Ringfläche × 4 m.
        let pos = &solids[0].pos;
        let vol: f64 = tris.iter().map(|t| { let p = |i: u32| [pos[3 * i as usize], pos[3 * i as usize + 1], pos[3 * i as usize + 2]]; let (a, b, c) = (p(t[0]), p(t[1]), p(t[2])); (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0 }).sum();
        assert!((vol - ring_area * 4.0).abs() < 0.05, "{vol}");
    }

    #[test]
    fn luftbildfarben_auf_geaendertem_gelaende() {
        // Original-Netz mit Farbverlauf in x; nach der Baugrube behalten alle neuen Punkte die Farbe ihrer (x, y).
        let t = flat(0.0, 50.0);
        let colors: Vec<f64> = t.xy.iter().flat_map(|p| [(p[0] + 50.0) / 100.0, 0.5, 0.25]).collect();
        let r = excavate(&t, &ExSpec::of(&square(5.0, -3.0), 0.0).unwrap()).unwrap();
        let c = reproject_colors(&t, &colors, &r.tin);
        assert_eq!(c.len(), r.tin.xy.len() * 3);
        for (p, q) in r.tin.xy.iter().zip(c.chunks(3)) {
            assert!((q[0] - (p[0] + 50.0) / 100.0).abs() < 1e-9 && (q[1] - 0.5).abs() < 1e-9, "{p:?} {q:?}");
        }
    }

    #[test]
    fn auftrag_am_hang_und_bermen() {
        // Hang 10 %: Plattform auf ±0 schneidet bergseits ein und wird talseits geschüttet.
        let t = Tin { xy: vec![[-50.0, -50.0], [50.0, -50.0], [50.0, 50.0], [-50.0, 50.0]], z: vec![-5.0, -5.0, 5.0, 5.0], tris: vec![[0, 1, 2], [0, 2, 3]] };
        let ex = ExSpec::of(&square(5.0, 0.0), 0.0).unwrap();
        let v = volumes(&t, &ex, 0.05, &[]);
        assert!(v.cut > 10.0 && v.fill > 10.0, "{v:?}");
        // Bermen verlängern die Böschung: mehr Aushub als ohne.
        let mut e = square(5.0, -6.0);
        let base = volumes(&flat(0.0, 60.0), &ExSpec::of(&e, 0.0).unwrap(), 0.05, &[]).cut;
        e.berm_width = Some(1.0);
        e.berm_height = Some(2.0);
        let sp = ExSpec::of(&e, 0.0).unwrap();
        assert!((sp.profile(2.0, 1.0) - 2.0).abs() < 1e-12 && (sp.profile(2.5, 1.0) - 2.0).abs() < 1e-12 && (sp.profile(3.5, 1.0) - 2.5).abs() < 1e-12);
        assert!((sp.reach(2.5, 1.0) - 3.5).abs() < 1e-12);
        assert!(volumes(&flat(0.0, 60.0), &sp, 0.05, &[]).cut > base);
    }

    #[test]
    fn schraffur_und_unsinn() {
        let t = flat(0.0, 50.0);
        let mut e = square(5.0, -3.0);
        // Umlaufsinn im Uhrzeigersinn: Kantenneigungen wandern mit.
        e.outline.reverse();
        e.edge_slopes = Some(vec![60.0, 45.0, 45.0, 45.0]);
        let ex = ExSpec::of(&e, 0.0).unwrap();
        // Kante 0 war (−5,5)→(5,5) (oben); dort steiler: Böschung kürzer.
        let h = slope_hatch(&t, &ex, 0.5);
        assert!(h.len() > 40);
        let top: Vec<_> = h.iter().filter(|(a, _)| a[1] > 5.0 + 1e-6 && a[0].abs() < 4.0).collect();
        assert!(!top.is_empty() && top.iter().all(|(a, _)| a[1] < 5.0 + 3.0 / 60f64.to_radians().tan() + 0.2));
        assert!(ExSpec::of(&Excavation { outline: vec![Vec2 { x: 0.0, y: 0.0 }], ..Default::default() }, 0.0).is_none());
        assert!(ExSpec::of(&Excavation { bottom: f64::NAN, ..square(1.0, 0.0) }, 0.0).is_none());
        // Ausserhalb des Netzes: nichts.
        let far = ExSpec::of(&Excavation { outline: square(1.0, 0.0).outline.iter().map(|v| Vec2 { x: v.x + 500.0, y: v.y }).collect(), ..square(1.0, 0.0) }, 0.0).unwrap();
        assert!(excavate(&t, &far).is_none());
    }
}
