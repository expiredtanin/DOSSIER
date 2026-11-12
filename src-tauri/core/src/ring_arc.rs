//! [191] Bögen in Umriss-Ringen (Decke `outline`/`openings`, Dach `outline`/`holes`, Raum `boundary`): je
//! Kante ein optionaler Bulge wie bei Wänden und Polylinien (`bulge = tan(Öffnungswinkel/4)`, positiv =
//! Scheitel links der Kante a → b; fehlt/0 = Gerade). Das Modell speichert die Stützpunkte; die Ableitungen
//! (Plan, Schnitt, Ansicht, 3D, Booleans, Exporte) rechnen auf dem fein geteilten Ring ([`densify`]), dessen
//! Punkte exakt auf dem Kreis liegen — die Ausgaben fassen sie über `plan/arc_fit.rs` ([169]) wieder zu echten
//! Bögen. Flächen rechnen exakt ([`signed_area`]: Sehnenpolygon + Kreisabschnitte).
//!
//! Teilung: Winkelschritt ≤ 3.75° (≥ 48 Teile je Halbkreis) und Pfeilhöhe ≤ 0.25 mm.

use crate::model::{Ceiling, Roof, Room, Vec2};
use std::borrow::Cow;
use std::f64::consts::PI;

/// [`fit_arcs`]: grösste Verschiebung einer Lauf-Endecke entlang ihrer Nachbarkante auf den Kreis (m).
const SNAP_REACH: f64 = 0.05;
/// Bulge unterhalb dieser Grösse gilt als gerade (wie `wall_arc::BULGE_EPS`).
pub const BULGE_EPS: f64 = 1e-9;
/// Grösster Winkelschritt der Teilung (3.75° → 48 Teile je Halbkreis).
pub const MAX_STEP: f64 = PI / 48.0;
/// Grösste Pfeilhöhe einer Sehne (Meter).
pub const SAGITTA: f64 = 2.5e-4;
/// Obergrenze der Teile je Bogen (Schutz vor Unsinn).
const MAX_SEGMENTS: usize = 4096;

/// Bulge der Kante `i` (fehlend, nicht endlich oder ~0 → 0; Betrag ≤ 1e3 wie bei Bogenwänden).
pub fn bulge_at(bulge: Option<&[f64]>, i: usize) -> f64 {
    match bulge.and_then(|b| b.get(i)).copied() {
        Some(b) if b.is_finite() && b.abs() > BULGE_EPS => b.clamp(-1e3, 1e3),
        _ => 0.0,
    }
}

/// Hat der Ring mindestens eine Bogenkante?
pub fn has_arcs(bulge: Option<&[f64]>, n: usize) -> bool {
    (0..n).any(|i| bulge_at(bulge, i) != 0.0)
}

/// Kreis einer Bogenkante: (Mittelpunkt, Radius, Startwinkel, Schwenk mit Vorzeichen).
pub fn arc_of(a: Vec2, b: Vec2, bulge: f64) -> Option<(Vec2, f64, f64, f64)> {
    if bulge.abs() <= BULGE_EPS || ![a.x, a.y, b.x, b.y, bulge].iter().all(|v| v.is_finite()) {
        return None;
    }
    let k = kernel2d::bulge_arc(kernel2d::Vec2::new(a.x, a.y), kernel2d::Vec2::new(b.x, b.y), bulge.clamp(-1e3, 1e3))?;
    (k.r.is_finite() && k.r > 1e-9 && k.sweep.is_finite()).then_some((Vec2 { x: k.center.x, y: k.center.y }, k.r, k.a0, k.sweep))
}

/// Anzahl Teile eines Bogens (Radius `r`, Schwenk `sweep`).
pub fn segments(r: f64, sweep: f64) -> usize {
    let s = sweep.abs();
    if !(s.is_finite() && r.is_finite() && r > 0.0) {
        return 1;
    }
    let by_angle = s / MAX_STEP;
    let by_sag = if r > SAGITTA { s / (2.0 * (1.0 - SAGITTA / r).acos()) } else { 1.0 };
    (by_angle.max(by_sag).max(1.0).ceil() as usize).min(MAX_SEGMENTS)
}

/// Innere Teilpunkte der Kante a → b (ohne a und b; leer bei gerader Kante).
pub fn edge_points(a: Vec2, b: Vec2, bulge: f64) -> Vec<Vec2> {
    let Some((c, r, a0, sweep)) = arc_of(a, b, bulge) else { return Vec::new() };
    let n = segments(r, sweep);
    (1..n)
        .map(|i| {
            let t = a0 + sweep * (i as f64 / n as f64);
            Vec2 { x: c.x + r * (t).cos(), y: c.y + r * (t).sin() }
        })
        .collect()
}

/// Fein geteilter Ring (Schlusspunkt nicht doppelt); ohne Bögen der Ring selbst.
pub fn densify<'a>(pts: &'a [Vec2], bulge: Option<&[f64]>) -> Cow<'a, [Vec2]> {
    if !has_arcs(bulge, pts.len()) || pts.len() < 2 {
        return Cow::Borrowed(pts);
    }
    Cow::Owned(densify_map(pts, bulge).0)
}

/// Wie [`densify`], dazu je Kante des feinen Rings die Kante des Stützpunkt-Rings, aus der sie stammt.
pub fn densify_map(pts: &[Vec2], bulge: Option<&[f64]>) -> (Vec<Vec2>, Vec<usize>) {
    let n = pts.len();
    let mut out = Vec::with_capacity(n);
    let mut src = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        out.push(a);
        src.push(i);
        for q in edge_points(a, b, bulge_at(bulge, i)) {
            out.push(q);
            src.push(i);
        }
    }
    (out, src)
}

/// Fein geteilter Ring als `[x, y]`.
pub fn densify_xy(pts: &[Vec2], bulge: Option<&[f64]>) -> Vec<[f64; 2]> {
    densify(pts, bulge).iter().map(|p| [p.x, p.y]).collect()
}

/// Je Punkt des feinen Rings: liegt er im Inneren eines Bogens oder zwischen zwei tangential anschliessenden
/// Bögen (glatte Normale im 3D)? Gleiche Reihenfolge wie [`densify`].
pub fn smooth_flags(pts: &[Vec2], bulge: Option<&[f64]>) -> Vec<bool> {
    let n = pts.len();
    let mut out = Vec::new();
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        out.push(false);
        out.extend(edge_points(a, b, bulge_at(bulge, i)).iter().map(|_| true));
    }
    out
}

/// Vorzeichenbehaftete Fläche (Gauss, Gegenuhrzeigersinn positiv) des Rings samt Kreisabschnitten, exakt.
/// Ein Bogen mit positivem Bulge (Scheitel links) nimmt einem Gegenuhrzeiger-Ring Fläche weg.
pub fn signed_area(pts: &[Vec2], bulge: Option<&[f64]>) -> f64 {
    let n = pts.len();
    if n < 2 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        s += a.x * b.y - b.x * a.y;
    }
    let mut area = s / 2.0;
    for i in 0..n {
        let bl = bulge_at(bulge, i);
        if let Some((_, r, _, sweep)) = arc_of(pts[i], pts[(i + 1) % n], bl) {
            let th = sweep.abs();
            area -= bl.signum() * r * r / 2.0 * (th - (th).sin());
        }
    }
    area
}

/// Umfang des Rings samt Bögen.
pub fn perimeter(pts: &[Vec2], bulge: Option<&[f64]>) -> f64 {
    let n = pts.len();
    (0..n)
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            match arc_of(a, b, bulge_at(bulge, i)) {
                Some((_, r, _, sweep)) => r * sweep.abs(),
                None => crate::jsmath::hypot2(b.x - a.x, b.y - a.y),
            }
        })
        .sum()
}

/// Raum-/Flächenbewertung wie `room_area::evaluate`, Fläche und Umfang exakt mit Bögen, Schwerpunkt aus dem
/// fein geteilten Ring.
pub fn evaluate(pts: &[Vec2], bulge: Option<&[f64]>, deduction: f64) -> crate::room_area::RoomEval {
    let dense = densify_xy(pts, bulge);
    let mut ev = crate::room_area::evaluate(&dense, deduction);
    if has_arcs(bulge, pts.len()) {
        ev.gross = signed_area(pts, bulge).abs();
        ev.net = (ev.gross - if deduction > 0.0 { deduction } else { 0.0 }).max(0.0);
        ev.perimeter = perimeter(pts, bulge);
    }
    ev
}

/// Scheitel (Bogenmitte) der Kante a → b; gerade: Kantenmitte.
pub fn apex(a: Vec2, b: Vec2, bulge: f64) -> Vec2 {
    let m = Vec2 { x: (a.x + b.x) / 2.0, y: (a.y + b.y) / 2.0 };
    if bulge.abs() <= BULGE_EPS || !bulge.is_finite() {
        return m;
    }
    // Pfeilhöhe = Sehne/2 · bulge entlang der linken Normalen.
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    Vec2 { x: m.x - dy / 2.0 * bulge, y: m.y + dx / 2.0 * bulge }
}

/// Bulge der beiden Teilbögen, wenn ein Bogen bei Winkelanteil `f` (0..1) geteilt wird.
pub fn split_bulge(bulge: f64, f: f64) -> (f64, f64) {
    if bulge.abs() <= BULGE_EPS || !bulge.is_finite() {
        return (0.0, 0.0);
    }
    let q = (bulge).atan();
    let f = if f.is_finite() { f.clamp(0.0, 1.0) } else { 0.5 };
    ((q * f).tan(), (q * (1.0 - f)).tan())
}

/// Winkelanteil des Punkts `p` auf dem Bogen a → b (Projektion auf den Kreis; 0.5 bei gerader Kante).
pub fn arc_fraction(a: Vec2, b: Vec2, bulge: f64, p: Vec2) -> f64 {
    let Some((c, _, a0, sweep)) = arc_of(a, b, bulge) else {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l2 = dx * dx + dy * dy;
        return if l2 > 0.0 { (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0) } else { 0.5 };
    };
    let ang = (p.y - c.y).atan2(p.x - c.x);
    let mut d = ang - a0;
    // In die Schwenkrichtung bringen (0 .. 2π bzw. −2π .. 0).
    while d * sweep.signum() < 0.0 {
        d += 2.0 * PI * sweep.signum();
    }
    while d.abs() > 2.0 * PI {
        d -= 2.0 * PI * sweep.signum();
    }
    (d / sweep).clamp(0.0, 1.0)
}

/// Bulge-Liste für einen umgekehrten Ring (Punkte rückwärts): Kante i wird Kante n−2−i, Vorzeichen kehrt.
pub fn reversed(bulge: &[f64], n: usize) -> Vec<f64> {
    (0..n).map(|k| -bulge_at(Some(bulge), (2 * n - 2 - k) % n)).collect()
}

/// [191] Bögen aus Kreisen übernehmen (Raum aus Bogenwänden): Läufe von ≥ 3 aufeinanderfolgenden Ecken, deren
/// Abstand vom Mittelpunkt eines Bands `(Mittelpunkt, rMin, rMax)` darin liegt und innerhalb `tol` gleich ist
/// (Kreis = Abstand der mittleren Ecke des Laufs), werden EINE Bogenkante. Die Endecken des
/// Laufs rücken auf den Kreis (Schnitt der Nachbarkante mit dem Kreis), die Ecken dazwischen entfallen. Ergebnis:
/// Ecken und Bulge je Kante; ohne Treffer der Ring unverändert (alle Bulges 0). Ein Ring ganz auf einem Kreis
/// bleibt ein Vieleck.
pub fn fit_arcs(ring: &[Vec2], bands: &[(Vec2, f64, f64)], tol: f64) -> (Vec<Vec2>, Vec<f64>) {
    let n = ring.len();
    let plain = (ring.to_vec(), vec![0.0; n]);
    if n < 4 {
        return plain;
    }
    let dist = |i: usize, c: Vec2| (ring[i].x - c.x).hypot(ring[i].y - c.y);
    let on = |i: usize, b: &(Vec2, f64, f64)| (b.1 - tol..=b.2 + tol).contains(&dist(i, b.0));
    // Band je Ecke (erstes passendes).
    let which: Vec<Option<usize>> = (0..n).map(|i| bands.iter().position(|b| on(i, b))).collect();
    if which.iter().all(|w| w.is_some() && *w == which[0]) {
        return plain;
    }
    // Start an einer Ecke, deren Vorgänger nicht auf demselben Kreis liegt.
    let Some(start) = (0..n).find(|&i| which[i].is_none() || which[(i + n - 1) % n] != which[i]) else { return plain };
    let mut pts: Vec<Vec2> = Vec::new();
    let mut bulge: Vec<f64> = Vec::new();
    let mut k = 0;
    while k < n {
        let i = (start + k) % n;
        let mut len = 1;
        if let Some(ci) = which[i] {
            while len < n - k && which[(i + len) % n] == Some(ci) {
                len += 1;
            }
        }
        // Kreis des Laufs: Abstand der mittleren Ecke; die inneren Ecken des Laufs innerhalb `tol` darauf (die
        // Endecken stossen an die Nachbarkanten und rücken unten auf den Kreis).
        let circle = which[i].filter(|_| len >= 3).map(|ci| (bands[ci].0, dist((i + len / 2) % n, bands[ci].0))).filter(|&(c, r)| (1..len - 1).all(|k| (dist((i + k) % n, c) - r).abs() <= tol));
        if let Some((c, r)) = circle {
            let (j, prev, next) = ((i + len - 1) % n, ring[(i + n - 1) % n], ring[(i + len) % n]);
            let snap = |q: Vec2, from: Vec2| -> Vec2 {
                // Schnitt der Geraden from → q mit dem Kreis, nächst q; sonst radial projiziert.
                let (dx, dy) = (q.x - from.x, q.y - from.y);
                let (fx, fy) = (from.x - c.x, from.y - c.y);
                let (a, b, cc) = (dx * dx + dy * dy, 2.0 * (fx * dx + fy * dy), fx * fx + fy * fy - r * r);
                let disc = b * b - 4.0 * a * cc;
                if a > 1e-18 && disc >= 0.0 {
                    let sq = disc.sqrt();
                    let ts = [(-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a)];
                    let t = if (ts[0] - 1.0).abs() < (ts[1] - 1.0).abs() { ts[0] } else { ts[1] };
                    let hit = Vec2 { x: from.x + dx * t, y: from.y + dy * t };
                    if (hit.x - q.x).hypot(hit.y - q.y) <= SNAP_REACH {
                        return hit;
                    }
                }
                let d = (q.x - c.x).hypot(q.y - c.y);
                if d > 1e-12 { Vec2 { x: c.x + (q.x - c.x) * r / d, y: c.y + (q.y - c.y) * r / d } } else { q }
            };
            let (ea, eb) = (snap(ring[i], prev), snap(ring[j], next));
            let mid = ring[(i + len / 2) % n];
            let ang = |q: Vec2| (q.y - c.y).atan2(q.x - c.x);
            let wrap = |a: f64| a.rem_euclid(2.0 * PI);
            let (d_mid, d_end) = (wrap(ang(mid) - ang(ea)), wrap(ang(eb) - ang(ea)));
            let sweep = if d_mid < d_end { d_end } else { -(2.0 * PI - d_end) };
            pts.push(ea);
            bulge.push(-(sweep / 4.0).tan());
            pts.push(eb);
            bulge.push(0.0);
            k += len;
        } else {
            pts.push(ring[i]);
            bulge.push(0.0);
            k += 1;
        }
    }
    // Die Kante hinter einem Lauf-Ende läuft zur nächsten Ecke (Bulge 0 ist schon gesetzt); doppelte Punkte
    // (Lauf-Ende = nächste Ecke) entfallen.
    let mut out_p: Vec<Vec2> = Vec::with_capacity(pts.len());
    let mut out_b: Vec<f64> = Vec::with_capacity(pts.len());
    for (q, b) in pts.into_iter().zip(bulge) {
        if let Some(l) = out_p.last() {
            if (l.x - q.x).hypot(l.y - q.y) < 1e-9 {
                *out_b.last_mut().unwrap_or(&mut 0.0) = b;
                continue;
            }
        }
        out_p.push(q);
        out_b.push(b);
    }
    (out_p, out_b)
}

fn holes_dense<'a>(holes: Option<&'a [Vec<Vec2>]>, bulge: Option<&[Vec<f64>]>) -> Vec<Cow<'a, [Vec2]>> {
    holes.unwrap_or(&[]).iter().enumerate().map(|(i, h)| densify(h, bulge.and_then(|b| b.get(i)).map(Vec::as_slice))).collect()
}

impl Ceiling {
    /// Umriss, Bögen fein geteilt.
    pub fn ring(&self) -> Cow<'_, [Vec2]> {
        densify(&self.outline, self.outline_bulge.as_deref())
    }
    /// Aussparungen, Bögen fein geteilt.
    pub fn hole_rings(&self) -> Vec<Cow<'_, [Vec2]>> {
        holes_dense(self.openings.as_deref(), self.openings_bulge.as_deref())
    }
    /// Umriss als `[x, y]`, Bögen fein geteilt.
    pub fn ring_xy(&self) -> Vec<[f64; 2]> {
        densify_xy(&self.outline, self.outline_bulge.as_deref())
    }
    /// Fläche des Umrisses exakt (ohne Aussparungen), ohne Vorzeichen.
    pub fn outline_area(&self) -> f64 {
        signed_area(&self.outline, self.outline_bulge.as_deref()).abs()
    }
    /// Fläche der Aussparungen exakt.
    pub fn openings_area(&self) -> f64 {
        self.openings.as_deref().unwrap_or(&[]).iter().enumerate().map(|(i, h)| signed_area(h, self.openings_bulge.as_deref().and_then(|b| b.get(i)).map(Vec::as_slice)).abs()).sum()
    }
    /// Hat Umriss oder eine Aussparung Bögen?
    pub fn has_arcs(&self) -> bool {
        has_arcs(self.outline_bulge.as_deref(), self.outline.len()) || self.openings.as_deref().unwrap_or(&[]).iter().enumerate().any(|(i, h)| has_arcs(self.openings_bulge.as_deref().and_then(|b| b.get(i)).map(Vec::as_slice), h.len()))
    }
}

impl Roof {
    /// Umriss, Bögen fein geteilt.
    pub fn ring(&self) -> Cow<'_, [Vec2]> {
        densify(&self.outline, self.outline_bulge.as_deref())
    }
    /// Höfe, Bögen fein geteilt.
    pub fn hole_rings(&self) -> Vec<Cow<'_, [Vec2]>> {
        holes_dense(self.holes.as_deref(), self.holes_bulge.as_deref())
    }
    /// Fläche des Umrisses exakt (ohne Höfe), ohne Vorzeichen.
    pub fn outline_area(&self) -> f64 {
        signed_area(&self.outline, self.outline_bulge.as_deref()).abs()
    }
    pub fn has_arcs(&self) -> bool {
        has_arcs(self.outline_bulge.as_deref(), self.outline.len()) || self.holes.as_deref().unwrap_or(&[]).iter().enumerate().any(|(i, h)| has_arcs(self.holes_bulge.as_deref().and_then(|b| b.get(i)).map(Vec::as_slice), h.len()))
    }
    /// Kantenneigungen ([`Roof::edge_pitch_deg`]) für die fein geteilten Ringe: jede Teilkante erbt die ihrer
    /// Bogenkante. `None`, wenn das Dach keine Neigungen je Kante hat.
    pub fn dense_edge_pitch(&self) -> Option<Vec<Option<f64>>> {
        let src = self.edge_pitch_deg.as_ref()?;
        if !self.has_arcs() {
            return Some(src.clone());
        }
        let mut out = Vec::new();
        let mut off = 0usize;
        let empty: Vec<Vec<Vec2>> = Vec::new();
        let rings = std::iter::once((&self.outline, self.outline_bulge.as_deref())).chain(self.holes.as_ref().unwrap_or(&empty).iter().enumerate().map(|(i, h)| (h, self.holes_bulge.as_deref().and_then(|b| b.get(i)).map(Vec::as_slice))));
        for (ring, bulge) in rings {
            let (_, map) = densify_map(ring, bulge);
            out.extend(map.iter().map(|&k| src.get(off + k).copied().unwrap_or(None)));
            off += ring.len();
        }
        Some(out)
    }
}

impl Room {
    /// Umriss, Bögen fein geteilt.
    pub fn ring(&self) -> Cow<'_, [Vec2]> {
        densify(&self.boundary, self.boundary_bulge.as_deref())
    }
    /// Umriss als `[x, y]`, Bögen fein geteilt.
    pub fn ring_xy(&self) -> Vec<[f64; 2]> {
        densify_xy(&self.boundary, self.boundary_bulge.as_deref())
    }
    /// Fläche exakt (Bögen als Kreisabschnitte), ohne Vorzeichen.
    pub fn area(&self) -> f64 {
        signed_area(&self.boundary, self.boundary_bulge.as_deref()).abs()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    /// Rechteck 0..4 × 0..2 (Gegenuhrzeigersinn), rechte Kante als Halbkreis nach aussen (r = 1).
    fn d_shape() -> (Vec<Vec2>, Vec<f64>) {
        (vec![p(0.0, 0.0), p(4.0, 0.0), p(4.0, 2.0), p(0.0, 2.0)], vec![0.0, -1.0, 0.0, 0.0])
    }

    #[test]
    fn flaeche_exakt_mit_halbkreis() {
        let (pts, b) = d_shape();
        let a = signed_area(&pts, Some(&b));
        assert!((a - (8.0 + PI / 2.0)).abs() < 1e-12, "{a}");
        // Nach innen (Scheitel links): Fläche kleiner.
        let a2 = signed_area(&pts, Some(&[0.0, 1.0, 0.0, 0.0]));
        assert!((a2 - (8.0 - PI / 2.0)).abs() < 1e-12, "{a2}");
        // Umgekehrter Ring: gleiche Fläche, negatives Vorzeichen.
        let rev: Vec<Vec2> = pts.iter().rev().copied().collect();
        let rb = reversed(&b, 4);
        assert!((signed_area(&rev, Some(&rb)) + 8.0 + PI / 2.0).abs() < 1e-12);
        assert!((perimeter(&pts, Some(&b)) - (10.0 + PI)).abs() < 1e-12);
    }

    #[test]
    fn teilung_fein_und_auf_dem_kreis() {
        let (pts, b) = d_shape();
        let d = densify(&pts, Some(&b));
        let on_arc: Vec<&Vec2> = d.iter().filter(|q| q.x > 4.0 + 1e-9).collect();
        assert!(on_arc.len() + 1 >= 48, "{} Teile", on_arc.len() + 1);
        for q in &on_arc {
            assert!((crate::jsmath::hypot2(q.x - 4.0, q.y - 1.0) - 1.0).abs() < 1e-12);
        }
        // Grosser Radius: Pfeilhöhe ≤ 0.25 mm.
        let n = segments(20.0, PI);
        assert!(20.0 * (1.0 - (PI / n as f64 / 2.0).cos()) <= SAGITTA + 1e-12);
        // Flächenfehler des Sehnenpolygons klein.
        let poly = signed_area(&d, None);
        assert!((poly - signed_area(&pts, Some(&b))).abs() < 2e-3);
        // Ohne Bögen: unverändert, keine Kopie.
        assert!(matches!(densify(&pts, None), Cow::Borrowed(_)));
        assert!(matches!(densify(&pts, Some(&[0.0, f64::NAN])), Cow::Borrowed(_)));
    }

    #[test]
    fn teilen_und_scheitel() {
        let (a, b) = (p(0.0, 0.0), p(2.0, 0.0));
        let ap = apex(a, b, 1.0);
        assert!((ap.x - 1.0).abs() < 1e-12 && (ap.y - 1.0).abs() < 1e-12);
        let (b1, b2) = split_bulge(1.0, 0.5);
        assert!((b1 - (PI / 8.0).tan()).abs() < 1e-12 && (b1 - b2).abs() < 1e-12);
        assert!((arc_fraction(a, b, 1.0, ap) - 0.5).abs() < 1e-9);
        assert!((arc_fraction(a, b, -1.0, apex(a, b, -1.0)) - 0.5).abs() < 1e-9);
        assert!(arc_fraction(a, b, 1.0, p(0.0, 0.01)) < 0.05);
    }

    /// Decke 5 × 4 mit der Ostkante als Halbkreis nach aussen (r = 2): Fläche analytisch (Objekt-Info,
    /// Bauteilliste, Wärmeschutz-Liste), 3D-Rand mit ≥ 48 Teilen auf dem Kreis, Plan-Fläche ebenso.
    #[test]
    fn decke_mit_bogenkante_flaeche_und_3d_rand() {
        let mut pr: crate::model::Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        let c = &mut pr.ceilings.as_mut().unwrap()[0];
        c.outline = vec![p(0.0, 0.0), p(5.0, 0.0), p(5.0, 4.0), p(0.0, 4.0)];
        c.outline_bulge = Some(vec![0.0, -1.0, 0.0, 0.0]);
        c.edge_at_outline = Some(true);
        let exact = 20.0 + PI * 2.0;
        let c = &pr.ceilings.as_ref().unwrap()[0];
        assert!((c.outline_area() - exact).abs() < 1e-12);
        let row = crate::export_schedule::schedule_rows(&pr).into_iter().find(|r| r.id == c.id).unwrap();
        assert!((row.area.unwrap() - exact).abs() < 1e-12, "{:?}", row.area);
        for s in crate::model3d::emit_slabs(&pr) {
            let on_arc: Vec<&[f64; 2]> = s.outline.iter().filter(|q| q[0] > 5.0 + 1e-6).collect();
            assert!(on_arc.len() + 1 >= 48, "{} Teile", on_arc.len() + 1);
            for q in on_arc {
                assert!(((q[0] - 5.0).hypot(q[1] - 2.0) - 2.0).abs() < 1e-9);
            }
            // Sehnenpolygon: Fläche bis auf die Kreisabschnitte (< 0.01 m²).
            let a: f64 = (0..s.outline.len()).map(|i| { let (u, v) = (s.outline[i], s.outline[(i + 1) % s.outline.len()]); u[0] * v[1] - v[0] * u[1] }).sum::<f64>().abs() / 2.0;
            assert!(exact - a > 0.0 && exact - a < 0.01, "{a}");
        }
    }

    /// Lichter Raum an einer Bogenwand: der Sehnenzug (Ecken ~0.4 mm neben dem Kreis) wird EIN Bogen, die
    /// Endecken liegen auf dem Kreis und auf den Nachbarkanten; Fläche exakt wie Rechteck + Halbkreis.
    #[test]
    fn boegen_aus_wandkreis_uebernehmen() {
        let r = 1.9;
        let mut ring = vec![p(0.0, -r), p(4.0 - 0.015, -r)];
        for i in 1..24 {
            let a = -PI / 2.0 + PI * i as f64 / 24.0;
            let k = 1.0 + 4e-4 * (i % 2) as f64; // leicht neben dem Kreis
            ring.push(p(4.0 + r * k * a.cos(), r * k * a.sin()));
        }
        ring.extend([p(4.0, r), p(0.0, r)]);
        let (pts, b) = fit_arcs(&ring, &[(p(4.0, 0.0), r - 0.1, r + 0.1)], 2e-3);
        assert_eq!(pts.len(), 4, "{pts:?}");
        assert!((pts[1].x - 4.0).abs() < 1e-6 && (pts[1].y + r).abs() < 1e-6, "Endecke auf Kreis und Kante: {:?}", pts[1]);
        assert!((b[1] + 1.0).abs() < 1e-6 && b[0] == 0.0 && b[2] == 0.0 && b[3] == 0.0, "{b:?}");
        assert!((signed_area(&pts, Some(&b)) - (4.0 * 2.0 * r + PI * r * r / 2.0)).abs() < 1e-5);
        // Ohne passenden Kreis: unverändert.
        let (q, b2) = fit_arcs(&ring, &[(p(0.0, 0.0), 5.0, 5.1)], 2e-3);
        assert_eq!(q.len(), ring.len());
        assert!(b2.iter().all(|x| *x == 0.0));
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(densify(&[], Some(&[1.0])).is_empty());
        let one = [p(0.0, 0.0)];
        assert_eq!(densify(&one, Some(&[1.0])).len(), 1);
        let same = [p(1.0, 1.0), p(1.0, 1.0), p(2.0, 2.0)];
        assert_eq!(densify(&same, Some(&[1.0, 0.0, 0.0])).len(), 3);
        let nan = [p(f64::NAN, 0.0), p(1.0, 0.0), p(1.0, 1.0)];
        let _ = densify(&nan, Some(&[1.0, 1.0, 1.0]));
        assert_eq!(segments(f64::NAN, 1.0), 1);
        assert!(signed_area(&nan, None).is_nan());
        assert!(edge_points(p(0.0, 0.0), p(1.0, 0.0), 1e300).len() <= MAX_SEGMENTS);
    }
}
