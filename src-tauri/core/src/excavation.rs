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
    /// Umriss gegen den Uhrzeigersinn.
    pub ring: Vec<P2>,
    pub bottom: f64,
    pub cut_tan: Vec<f64>,
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

impl ExSpec {
    /// Aus dem Modell; `dz` = Höhenbezug des Netzes ([`datum`]). `None` bei kaputtem Umriss.
    pub fn of(e: &Excavation, dz: f64) -> Option<ExSpec> {
        let mut ring: Vec<P2> = e.outline.iter().map(|v| [v.x, v.y]).filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
        ring.dedup_by(|a, b| (a[0] - b[0]).hypot(a[1] - b[1]) < 1e-9);
        if ring.len() > 2 && (ring[0][0] - ring[ring.len() - 1][0]).hypot(ring[0][1] - ring[ring.len() - 1][1]) < 1e-9 {
            ring.pop();
        }
        if ring.len() < 3 || !e.bottom.is_finite() || signed_area(&ring).abs() < 1e-6 {
            return None;
        }
        let n = ring.len();
        let slope = e.slope.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(DEFAULT_SLOPE);
        let mut cut_tan: Vec<f64> = (0..n).map(|i| tan_deg(e.edge_slopes.as_ref().and_then(|v| v.get(i)).copied().filter(|s| s.is_finite() && *s > 0.0).unwrap_or(slope))).collect();
        if signed_area(&ring) < 0.0 {
            // Kante i (p_i → p_i+1) wird nach dem Umdrehen Kante n−2−i (mod n).
            ring.reverse();
            let old = cut_tan.clone();
            for i in 0..n {
                cut_tan[(2 * n - 2 - i) % n] = old[i];
            }
        }
        let bw = e.berm_width.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
        let bh = e.berm_height.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
        Some(ExSpec {
            ring,
            bottom: e.bottom + dz,
            cut_tan,
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

/// Integriert (t − neu) über ein Raster der Weite ≤ `h` (Mittelpunkte, höchstens ~1.5 Mio. Proben).
/// `footprint`: Gebäude-Grundfläche (Ringe); Abtrag darin zählt nicht zur Hinterfüllung.
pub fn volumes(orig: &Tin, ex: &ExSpec, h: f64, footprint: &[Vec<P2>]) -> Volumes {
    let idx = TinIndex::new(orig);
    let r = ex.reach_in(orig, &idx);
    let b = ex.bbox();
    let reg = [b[0] - r, b[1] - r, b[2] + r, b[3] + r];
    let (w, hh) = (reg[2] - reg[0], reg[3] - reg[1]);
    let mut h = h.max(1e-3);
    while (w / h).ceil() * (hh / h).ceil() > 1.5e6 {
        h *= 1.2;
    }
    let (nx, ny) = ((w / h).ceil() as usize, (hh / h).ceil() as usize);
    let (hx, hy) = (w / nx as f64, hh / ny as f64);
    let cell = hx * hy;
    let mut v = Volumes { bottom_area: signed_area(&ex.ring).abs(), ..Default::default() };
    for j in 0..ny {
        for i in 0..nx {
            let p = [reg[0] + (i as f64 + 0.5) * hx, reg[1] + (j as f64 + 0.5) * hy];
            let Some(t) = idx.z_at(p[0], p[1]) else { continue };
            let dz = t - ex.apply(t, p);
            if dz > 0.0 {
                v.cut += dz * cell;
                if !footprint.iter().any(|f| point_in_ring(p, f)) {
                    v.backfill += dz * cell;
                }
            } else {
                v.fill -= dz * cell;
            }
        }
    }
    v
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
}

impl SiteTerrain {
    pub fn current(&self) -> &Tin {
        self.modified.as_ref().unwrap_or(&self.orig)
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
    let st = Rc::new(SiteTerrain { datum: dz, orig, modified: cur, items });
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
}

pub fn quantities(p: &Project) -> Vec<ExQty> {
    let fp: Vec<Vec<P2>> = crate::site_rules::building_footprint(p).iter().flat_map(|poly| poly.first().map(|r| r.iter().map(|v| [v.x, v.y]).collect::<Vec<P2>>())).collect();
    let mut out = Vec::new();
    for e in excavations(p) {
        for t in terrains(p) {
            let st = site_terrain(p, t);
            let Some((_, spec, _)) = st.items.iter().find(|(id, ..)| *id == e.id) else { continue };
            let h = (spec.ring.iter().map(|q| q[0]).fold(f64::NEG_INFINITY, f64::max) - spec.ring.iter().map(|q| q[0]).fold(f64::INFINITY, f64::min)).max(1.0) / 400.0;
            let v = volumes(&st.orig, spec, h.clamp(0.02, 0.5), &fp);
            out.push(ExQty { id: e.id.clone(), name: e.name.clone(), bottom: e.bottom, bottom_area: v.bottom_area, cut: v.cut, fill: v.fill, backfill: v.backfill });
            break;
        }
    }
    out
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

// ── Grundriss: Böschungsschraffur ────────────────────────────────────────────

/// Böschungsschraffur: Striche von der Oberkante zur Unterkante, abwechselnd lang und halb, im Abstand
/// `spacing` entlang des Umrisses (an konvexen Ecken gefächert). `t` = Gelände vor dieser Baugrube.
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
    for i in 0..n {
        let (a, b) = (ex.ring[i], ex.ring[(i + 1) % n]);
        let len = (b[0] - a[0]).hypot(b[1] - a[1]);
        let nn = normal(i);
        let k = (len / spacing).floor() as usize;
        let off = (len - k as f64 * spacing) / 2.0;
        for s in 0..=k {
            let f = (off + s as f64 * spacing) / len.max(1e-12);
            if f <= 1e-9 || f >= 1.0 - 1e-9 {
                continue;
            }
            rays.push(([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], nn));
        }
        // Fächer an der konvexen Ecke b.
        let n2 = normal((i + 1) % n);
        let cross = nn[0] * n2[1] - nn[1] * n2[0];
        if cross > 1e-9 {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Vec2;
    use crate::terrain::{mesh_volume, prism, watertight};

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
