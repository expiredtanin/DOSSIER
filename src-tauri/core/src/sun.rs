//! Sonnenstand und Boden-Schatten (Lageplan-Schattenstudie, [64]/[59]); aus `analysis/sun.ts`.
//!
//!  • [`sun_position`]: Azimut (° von Nord im Uhrzeigersinn) und Höhe (°) nach dem vereinfachten
//!    NOAA-Verfahren (Genauigkeit ~0.1°, ohne Refraktion).
//!  • [`shadow_of_prism`] / [`shadow_union`]: Boden-Schatten (z = 0) als Vereinigung konvexer
//!    Hüllen (Körper ∪ verschobener Körper). Modell: x = Ost, y = Nord, Höhen in Metern über dem
//!    Geländenullpunkt. TS sammelt die Prismen (Wände, Körper) und Punktwolken (Dächer).
//!  • [`without_holes`]: Polygon mit Löchern → lochfreie Teile gleicher Fläche (Plan-Primitiv).

use crate::flat::{Polygon, Ring};
use crate::polygon_bool;

const RAD: f64 = std::f64::consts::PI / 180.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SunPosition {
    /// Grad von Nord im Uhrzeigersinn (Ost = 90, Süd = 180).
    pub azimuth: f64,
    /// Grad über dem Horizont (negativ = Nacht).
    pub elevation: f64,
}

/// Sonnenstand für Breite/Länge (Grad) zur Zeit `unix_ms` (Millisekunden seit 1970, UTC).
pub fn sun_position(lat_deg: f64, lon_deg: f64, unix_ms: f64) -> SunPosition {
    use std::f64::consts::PI;
    let jd = unix_ms / 86_400_000.0 + 2_440_587.5;
    let n = jd - 2_451_545.0;
    let l = (280.46 + 0.985_647_4 * n) % 360.0;
    let g = ((357.528 + 0.985_600_3 * n) % 360.0) * RAD;
    let lambda = (l + 1.915 * g.sin() + 0.02 * (2.0 * g).sin()) * RAD;
    let eps = (23.439 - 0.000_000_4 * n) * RAD;
    let ra = (eps.cos() * lambda.sin()).atan2(lambda.cos());
    let dec = (eps.sin() * lambda.sin()).asin();
    // Greenwich-Sternzeit → Stundenwinkel.
    let gmst = (280.460_618_37 + 360.985_647_366_29 * n) % 360.0;
    let ha = ((((gmst + lon_deg) * RAD - ra) % (2.0 * PI)) + 3.0 * PI) % (2.0 * PI) - PI;
    let lat = lat_deg * RAD;
    let sin_el = lat.sin() * dec.sin() + lat.cos() * dec.cos() * ha.cos();
    let el = sin_el.asin();
    let az = (-ha.sin() * dec.cos()).atan2(dec.sin() * lat.cos() - dec.cos() * lat.sin() * ha.cos());
    SunPosition { azimuth: (((az / RAD) % 360.0) + 360.0) % 360.0, elevation: el / RAD }
}

/// Verschiebung des Schattens je Meter Höhe (von der Sonne weg); `None` bei Nacht/flacher Sonne.
pub fn shadow_shift(sun: SunPosition) -> Option<[f64; 2]> {
    if !(sun.elevation > 0.5) || !sun.azimuth.is_finite() || !sun.elevation.is_finite() {
        return None;
    }
    let k = 1.0 / (sun.elevation * RAD).tan();
    let az = sun.azimuth * RAD;
    Some([-az.sin() * k, -az.cos() * k])
}

/// Konvexe Hülle (Monotone Chain), gegen den Uhrzeigersinn; nicht endliche Punkte fallen weg.
pub fn hull(points: &[[f64; 2]]) -> Ring {
    let mut p: Vec<[f64; 2]> = points.iter().copied().filter(|q| q[0].is_finite() && q[1].is_finite()).collect();
    p.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    if p.len() < 3 {
        return p;
    }
    let cross = |o: [f64; 2], a: [f64; 2], b: [f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lower: Ring = Vec::new();
    for &q in &p {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], q) <= 0.0 {
            lower.pop();
        }
        lower.push(q);
    }
    let mut upper: Ring = Vec::new();
    for &q in p.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], q) <= 0.0 {
            upper.pop();
        }
        upper.push(q);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Höhe der schattenempfangenden Ebene (Geländenullpunkt ±0.00).
pub const GROUND_Z: f64 = 0.0;

/// [142] Teil einer (als konvex behandelten) Punktwolke über der Bodenebene: Punkte darüber plus die
/// Schnittpunkte jeder Verbindung über/unter der Ebene mit ihr. Ohne diesen Schnitt verschiebt `k·z`
/// Punkte unter ±0.00 (Untergeschoss, Stützmauer, im Gelände steckende Teile) zur Sonne hin —
/// Schatten in zwei Richtungen. Ganz vergrabene Körper werfen keinen Schatten.
fn above_ground(points: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let (up, down): (Vec<[f64; 3]>, Vec<[f64; 3]>) = points.iter().copied().filter(|p| p[2].is_finite()).partition(|p| p[2] >= GROUND_Z);
    if !up.iter().any(|p| p[2] > GROUND_Z + 1e-9) {
        return vec![];
    }
    if down.is_empty() {
        return up;
    }
    let mut out = up.clone();
    for a in &up {
        for b in &down {
            let t = (a[2] - GROUND_Z) / (a[2] - b[2]);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, GROUND_Z]);
        }
    }
    out
}

/// Schatten einer Punktwolke (x, y, z) auf der Bodenebene: Hülle des Teils über ±0.00 und seiner um
/// `k·(z − GROUND_Z)` verschobenen Punkte (alle von der Sonne weg).
fn shadow_of_points(points: &[[f64; 3]], k: [f64; 2]) -> Ring {
    let moved: Vec<[f64; 2]> = above_ground(points).iter().map(|p| [p[0] + k[0] * (p[2] - GROUND_Z), p[1] + k[1] * (p[2] - GROUND_Z)]).collect();
    hull(&moved)
}

/// Grundriss `footprint` von `z_bottom` bis `z_top` als Punktwolke; leer, wenn entartet.
fn prism_points(footprint: &[[f64; 2]], z_bottom: f64, z_top: f64) -> Vec<[f64; 3]> {
    if !(z_top > z_bottom) || footprint.len() < 3 {
        return vec![];
    }
    footprint.iter().flat_map(|p| [[p[0], p[1], z_bottom], [p[0], p[1], z_top]]).collect()
}

/// Boden-Schatten eines Prismas (leer bei Nacht oder entartetem Prisma).
pub fn shadow_of_prism(footprint: &[[f64; 2]], z_bottom: f64, z_top: f64, sun: SunPosition) -> Ring {
    match shadow_shift(sun) {
        Some(k) => shadow_of_points(&prism_points(footprint, z_bottom, z_top), k),
        None => vec![],
    }
}

/// Ein Prisma: Grundriss mit Unter- und Oberkante.
pub struct Prism {
    pub footprint: Ring,
    pub z_bottom: f64,
    pub z_top: f64,
}

/// Vereinigter Schatten aller Prismen und Punktwolken (z. B. Dächer); leer bei Nacht.
pub fn shadow_union(prisms: &[Prism], clouds: &[Vec<[f64; 3]>], sun: SunPosition) -> Vec<Polygon> {
    let Some(k) = shadow_shift(sun) else { return vec![] };
    let parts: Vec<Polygon> = prisms
        .iter()
        .map(|p| prism_points(&p.footprint, p.z_bottom, p.z_top))
        .chain(clouds.iter().cloned())
        .map(|pts| shadow_of_points(&pts, k))
        .filter(|r| r.len() >= 3)
        .map(|r| vec![r])
        .collect();
    if parts.is_empty() {
        return vec![];
    }
    polygon_bool::union(&parts)
}

// ── Schatten auf dem Gelände ([142]) ─────────────────────────────────────────

/// Schattenempfangendes Gelände: TIN mit Raster-Index; Höhen im Projekt-Bezug (TIN-Höhe − `datum`).
/// Ausserhalb des Netzes gilt die zuletzt getroffene Geländehöhe (bzw. ±0.00, wenn der Strahl
/// ausserhalb beginnt).
pub struct Ground<'a> {
    idx: crate::terrain::TinIndex<'a>,
    datum: f64,
    z_min: f64,
}

/// Schrittweite (m, waagrecht) beim Abtasten des Sonnenstrahls über dem Gelände.
const RAY_STEP: f64 = 0.25;
/// Abstand der Stützpunkte auf den Kanten der Schattenwerfer (m).
const EDGE_SAMPLE: f64 = 0.5;
/// Kleinere Löcher/Teile (m²) im vereinigten Geländeschatten sind Abtast-Splitter und fallen weg.
const SLIVER_AREA: f64 = 0.05;

impl<'a> Ground<'a> {
    pub fn new(tin: &'a crate::terrain::Tin, datum: f64) -> Ground<'a> {
        let z_min = tin.z_range().0 - datum;
        Ground { idx: crate::terrain::TinIndex::new(tin), datum, z_min: if z_min.is_finite() { z_min } else { GROUND_Z } }
    }

    /// Geländehöhe am Punkt; `None` ausserhalb des Netzes.
    pub fn z(&self, x: f64, y: f64) -> Option<f64> {
        self.idx.z_at(x, y).map(|z| z - self.datum)
    }

    /// Erster Schnitt des Sonnenstrahls ab `p` (von der Sonne weg, `k` = waagrechte Verschiebung je
    /// Meter Abstieg) mit dem Gelände, als Grundrisspunkt. Punkte auf/unter dem Gelände bleiben, wo
    /// sie sind. Abtasten in `RAY_STEP`, Schnitt linear zwischen den Stützstellen.
    pub fn project(&self, p: [f64; 3], k: [f64; 2]) -> [f64; 2] {
        let kl = hypot2(k[0], k[1]);
        let g0 = self.z(p[0], p[1]).unwrap_or(GROUND_Z);
        if !(p[2] > g0) || !(kl > 1e-12) || !kl.is_finite() {
            return [p[0], p[1]];
        }
        let dir = [k[0] / kl, k[1] / kl];
        let at = |s: f64| [p[0] + dir[0] * s, p[1] + dir[1] * s];
        let floor = self.z_min.min(g0) - 1.0;
        // Unsinnig hohe Punkte: Schnitt mit der Ebene der Ausgangshöhe statt tausender Schritte.
        if p[2] - floor > 1_000.0 {
            return at((p[2] - g0) * kl);
        }
        let (mut s, mut prev, mut last_g) = (0.0, p[2] - g0, g0);
        loop {
            let s1 = s + RAY_STEP;
            let zr = p[2] - s1 / kl;
            let q = at(s1);
            let g = self.z(q[0], q[1]).unwrap_or(last_g);
            last_g = g;
            let d = zr - g;
            if d <= 0.0 {
                return at(s + RAY_STEP * prev / (prev - d));
            }
            if zr < floor {
                return at((p[2] - g) * kl);
            }
            prev = d;
            s = s1;
        }
    }
}

/// Stützpunkte auf dem Rand eines Rings: je Kante der Startpunkt und Zwischenpunkte im Abstand
/// ≤ `EDGE_SAMPLE`; dazu je Kante der Index ihres Startpunkts.
fn sample_ring(r: &[[f64; 2]]) -> (Vec<[f64; 2]>, Vec<usize>) {
    let (mut pts, mut starts) = (Vec::new(), Vec::new());
    for i in 0..r.len() {
        let (a, b) = (r[i], r[(i + 1) % r.len()]);
        let n = (hypot2(b[0] - a[0], b[1] - a[1]) / EDGE_SAMPLE).ceil().clamp(1.0, 10_000.0) as usize;
        starts.push(pts.len());
        for j in 0..n {
            let t = j as f64 / n as f64;
            pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    (pts, starts)
}

/// Geländeschatten eines Prismas als Teilflächen: Unter- und Oberseite (auf das Gelände
/// projiziert) und je von der Sonne abgewandter Seitenkante die Fläche zwischen projizierter Unter-
/// und Oberkante. Schattenwerfer ist nur der Teil über dem örtlichen Gelände.
fn prism_parts_on(footprint: &[[f64; 2]], z_bottom: f64, z_top: f64, k: [f64; 2], g: &Ground) -> Vec<Polygon> {
    let mut fp: Ring = footprint.iter().copied().filter(|q| q[0].is_finite() && q[1].is_finite()).collect();
    if !(z_top > z_bottom) || fp.len() < 3 || !z_top.is_finite() {
        return vec![];
    }
    if crate::flat_read::signed_area(&fp) < 0.0 {
        fp.reverse();
    }
    let (pts, starts) = sample_ring(&fp);
    let mut bot = Vec::with_capacity(pts.len());
    let mut top = Vec::with_capacity(pts.len());
    let mut any = false;
    for q in &pts {
        let zb = z_bottom.max(g.z(q[0], q[1]).unwrap_or(GROUND_Z));
        if zb >= z_top {
            bot.push(*q);
            top.push(*q);
            continue;
        }
        any = true;
        bot.push(g.project([q[0], q[1], zb], k));
        top.push(g.project([q[0], q[1], z_top], k));
    }
    if !any {
        return vec![];
    }
    let mut out: Vec<Polygon> = vec![vec![bot.clone()], vec![top.clone()]];
    let n = pts.len();
    for (i, &s) in starts.iter().enumerate() {
        let (a, b) = (fp[i], fp[(i + 1) % fp.len()]);
        // Aussennormale (b − a, im Uhrzeigersinn gedreht) zeigt von der Sonne weg → Kante begrenzt den Schatten.
        if (b[1] - a[1]) * k[0] - (b[0] - a[0]) * k[1] <= 0.0 {
            continue;
        }
        let e = starts.get(i + 1).copied().unwrap_or(n);
        let idx: Vec<usize> = (s..=e).map(|j| j % n).collect();
        let mut ring: Ring = idx.iter().map(|&j| bot[j]).collect();
        ring.extend(idx.iter().rev().map(|&j| top[j]));
        out.push(vec![ring]);
    }
    out
}

/// Geländeschatten einer Punktwolke: Hülle der projizierten Punkte über dem Gelände.
fn cloud_part_on(points: &[[f64; 3]], k: [f64; 2], g: &Ground) -> Ring {
    let moved: Vec<[f64; 2]> = points
        .iter()
        .filter(|p| p.iter().all(|v| v.is_finite()) && p[2] > g.z(p[0], p[1]).unwrap_or(GROUND_Z) + 1e-9)
        .map(|p| g.project(*p, k))
        .collect();
    hull(&moved)
}

/// Splitter weg: Teile und Löcher unter `SLIVER_AREA`.
fn without_slivers(polys: Vec<Polygon>) -> Vec<Polygon> {
    use crate::flat_read::signed_area;
    polys
        .into_iter()
        .filter(|p| p.first().is_some_and(|o| signed_area(o).abs() >= SLIVER_AREA))
        .map(|p| p.into_iter().enumerate().filter(|(i, r)| *i == 0 || signed_area(r).abs() >= SLIVER_AREA).map(|(_, r)| r).collect())
        .collect()
}

/// Wie [`shadow_union`], aber auf das Gelände `ground` projiziert (ohne Gelände: Ebene ±0.00).
pub fn shadow_union_on(prisms: &[Prism], clouds: &[Vec<[f64; 3]>], sun: SunPosition, ground: Option<&Ground>) -> Vec<Polygon> {
    let Some(g) = ground else { return shadow_union(prisms, clouds, sun) };
    let Some(k) = shadow_shift(sun) else { return vec![] };
    let mut parts: Vec<Polygon> = prisms.iter().flat_map(|p| prism_parts_on(&p.footprint, p.z_bottom, p.z_top, k, g)).collect();
    parts.extend(clouds.iter().map(|c| cloud_part_on(c, k, g)).filter(|r| r.len() >= 3).map(|r| vec![r]));
    if parts.is_empty() {
        return vec![];
    }
    without_slivers(polygon_bool::union(&parts))
}

/// Baum als Schattenwerfer ([142]): Stamm (Prisma, Ø 0.3 m) und Krone (Ellipsoid aus drei Ringen und
/// den Scheitelpunkten), Kronenradius `r`, Gesamthöhe `h` ab `base`.
pub fn tree_caster(center: [f64; 2], r: f64, h: f64, base: f64) -> Option<(Prism, Vec<[f64; 3]>)> {
    if !(r > 0.0 && h > 0.0 && r.is_finite() && h.is_finite()) || !center.iter().chain([&base]).all(|v| v.is_finite()) {
        return None;
    }
    let a = r.min(0.35 * h);
    let zc = base + h - a;
    let ring = |rad: f64, n: usize| -> Vec<[f64; 2]> {
        (0..n)
            .map(|i| {
                let t = i as f64 / n as f64 * std::f64::consts::TAU;
                [center[0] + rad * crate::jsnum::cos(t), center[1] + rad * crate::jsnum::sin(t)]
            })
            .collect()
    };
    let mut crown: Vec<[f64; 3]> = vec![[center[0], center[1], zc + a], [center[0], center[1], zc - a]];
    for (f, dz) in [(1.0, 0.0), (0.75, 0.66), (0.75, -0.66)] {
        crown.extend(ring(r * f, 24).into_iter().map(|q| [q[0], q[1], zc + dz * a]));
    }
    let trunk = Prism { footprint: ring(0.15, 8), z_bottom: base, z_top: zc - a * 0.5 };
    Some((trunk, crown))
}

/// Zerlegt ein Polygon mit Löchern in lochfreie Teile gleicher Gesamtfläche. Jedes Loch wird
/// von einer senkrechten Schnittlinie durch seinen Mittelpunkt geteilt; in den Streifen dazwischen
/// berührt jeder Lochrest den Streifenrand und ist damit kein Loch mehr.
pub fn without_holes(poly: &Polygon) -> Vec<Ring> {
    let Some(outer) = poly.first() else { return vec![] };
    if outer.len() < 3 {
        return vec![];
    }
    if poly.len() == 1 {
        return vec![outer.clone()];
    }
    let rings: Polygon = poly.iter().filter(|r| r.len() >= 3).cloned().collect();
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for p in outer {
        min_x = min_x.min(p[0]);
        max_x = max_x.max(p[0]);
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
    }
    if !(min_x.is_finite() && max_x.is_finite() && min_y.is_finite() && max_y.is_finite()) {
        return vec![];
    }
    let mut cuts: Vec<f64> = poly[1..]
        .iter()
        .filter(|r| r.len() >= 3)
        .map(|r| {
            let lo = r.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
            let hi = r.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
            (lo + hi) / 2.0
        })
        .filter(|x| x.is_finite())
        .collect();
    cuts.sort_by(f64::total_cmp);
    let mut xs = vec![min_x - 1.0];
    xs.extend(cuts);
    xs.push(max_x + 1.0);
    let mut out = vec![];
    for w in xs.windows(2) {
        if w[1] - w[0] < 1e-9 {
            continue;
        }
        let slab = vec![vec![[w[0], min_y - 1.0], [w[1], min_y - 1.0], [w[1], max_y + 1.0], [w[0], max_y + 1.0]]];
        for piece in polygon_bool::intersection(&[rings.clone()], &[slab]) {
            if let Some(r) = piece.into_iter().next() {
                if r.len() >= 3 {
                    out.push(r);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flat_read::signed_area;

    /// Millisekunden seit 1970 (UTC) für Datum/Uhrzeit.
    fn utc(y: i64, mo: i64, d: i64, h: i64, mi: i64) -> f64 {
        // Tage seit 1970-01-01 (proleptischer Gregorianischer Kalender).
        let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
        let era = y2.div_euclid(400);
        let yoe = y2 - era * 400;
        let doy = (153 * m2 + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        ((days * 24 + h) * 60 + mi) as f64 * 60_000.0
    }

    #[test]
    fn sommersonnenwende_zuerich() {
        let s = sun_position(47.37, 8.54, utc(2026, 6, 21, 11, 26));
        assert!(s.elevation > 65.5 && s.elevation < 66.6, "{s:?}");
        assert!((s.azimuth - 180.0).abs() < 3.0, "{s:?}");
    }

    #[test]
    fn wintersonnenwende_und_nacht() {
        let noon = sun_position(47.37, 8.54, utc(2026, 12, 21, 11, 20));
        assert!(noon.elevation > 18.5 && noon.elevation < 19.8, "{noon:?}");
        assert!(sun_position(47.37, 8.54, utc(2026, 6, 21, 23, 0)).elevation < 0.0);
    }

    #[test]
    fn vormittags_im_osten() {
        let s = sun_position(47.37, 8.54, utc(2026, 3, 21, 6, 0));
        assert!(s.azimuth > 60.0 && s.azimuth < 120.0, "{s:?}");
    }

    const SQ: [[f64; 2]; 4] = [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];

    #[test]
    fn prisma_sonne_im_sueden() {
        let sh = shadow_of_prism(&SQ, 0.0, 4.0, SunPosition { azimuth: 180.0, elevation: 45.0 });
        let max_y = sh.iter().map(|p| p[1]).fold(f64::MIN, f64::max);
        let min_y = sh.iter().map(|p| p[1]).fold(f64::MAX, f64::min);
        assert!((max_y - 6.0).abs() < 1e-9 && min_y.abs() < 1e-9);
        assert!((signed_area(&sh) - 12.0).abs() < 1e-9); // 2 × 6
    }

    #[test]
    fn nacht_ohne_schatten() {
        let night = SunPosition { azimuth: 0.0, elevation: -3.0 };
        assert!(shadow_of_prism(&SQ, 0.0, 4.0, night).is_empty());
        let p = Prism { footprint: SQ.to_vec(), z_bottom: 0.0, z_top: 4.0 };
        assert!(shadow_union(&[p], &[], night).is_empty());
    }

    #[test]
    fn vereinigung_ueberlappender_schatten() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let a = Prism { footprint: SQ.to_vec(), z_bottom: 0.0, z_top: 4.0 };
        let b = Prism { footprint: SQ.iter().map(|p| [p[0] + 1.0, p[1]]).collect(), z_bottom: 0.0, z_top: 4.0 };
        let u = shadow_union(&[a, b], &[], sun);
        assert_eq!(u.len(), 1);
        assert!((signed_area(&u[0][0]) - 18.0).abs() < 1e-6); // 3 × 6
        // Punktwolke (Dach): Spitze in 2 m Höhe über (1, 1).
        let roof = vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [1.0, 1.0, 2.0]];
        let u = shadow_union(&[], &[roof], sun);
        assert_eq!(u.len(), 1);
        assert!(u[0][0].iter().any(|p| (p[1] - 3.0).abs() < 1e-6));
    }

    #[test]
    fn unsinn_ohne_panik() {
        let sun = SunPosition { azimuth: f64::NAN, elevation: 30.0 };
        assert!(shadow_shift(sun).is_none());
        let ok = SunPosition { azimuth: 200.0, elevation: 30.0 };
        let nan = Prism { footprint: vec![[f64::NAN, 0.0], [1.0, f64::INFINITY], [0.0, 0.0]], z_bottom: 0.0, z_top: 1.0 };
        let flat = Prism { footprint: SQ.to_vec(), z_bottom: 3.0, z_top: 3.0 };
        assert!(shadow_union(&[nan, flat], &[vec![]], ok).is_empty());
        assert!(shadow_union(&[], &[], ok).is_empty());
        assert!(hull(&[]).is_empty());
        let s = sun_position(f64::NAN, 0.0, 0.0);
        assert!(s.elevation.is_nan());
        assert!(without_holes(&vec![]).is_empty());
        assert!(without_holes(&vec![vec![[f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0]], vec![[0.1, 0.1]]]).is_empty());
    }

    /// [142] Alle Schattenpunkte liegen von der Sonne weg (Skalarprodukt mit der waagrechten
    /// Sonnenrichtung höchstens das des Körpers); ganz vergrabene Körper werfen keinen Schatten.
    #[test]
    fn schatten_nur_von_der_sonne_weg() {
        for az in [90.0, 135.0, 180.0, 250.0, 300.0] {
            let sun = SunPosition { azimuth: az, elevation: 35.0 };
            let to_sun = [(az * RAD).sin(), (az * RAD).cos()];
            let dot = |p: &[f64; 2]| p[0] * to_sun[0] + p[1] * to_sun[1];
            let near = SQ.iter().map(dot).fold(f64::NEG_INFINITY, f64::max);
            let far = SQ.iter().map(dot).fold(f64::INFINITY, f64::min);
            let k = 1.0 / (35.0 * RAD).tan();
            // Über Boden, teilweise vergraben (Untergeschoss bis −3, 1 m über Terrain), ganz vergraben.
            let above = shadow_of_prism(&SQ, 0.0, 4.0, sun);
            let partly = shadow_of_prism(&SQ, -3.0, 1.0, sun);
            let buried = shadow_of_prism(&SQ, -3.0, -0.2, sun);
            let flush = shadow_of_prism(&SQ, -3.0, 0.0, sun);
            assert!(buried.is_empty() && flush.is_empty(), "vergraben wirft keinen Schatten (az {az})");
            for (sh, h) in [(&above, 4.0), (&partly, 1.0)] {
                assert!(sh.len() >= 3);
                assert!(sh.iter().all(|p| dot(p) <= near + 1e-9), "Schatten zur Sonne hin (az {az})");
                let lo = sh.iter().map(dot).fold(f64::INFINITY, f64::min);
                assert!((lo - (far - h * k)).abs() < 1e-9, "Schattenlänge nur aus dem Teil über Boden (az {az})");
            }
            // Vereinigung und Punktwolke: dasselbe; der vergrabene Körper fügt nichts hinzu.
            let deep = Prism { footprint: SQ.iter().map(|p| [p[0] + 10.0, p[1]]).collect(), z_bottom: -3.0, z_top: -0.5 };
            let box_ = Prism { footprint: SQ.to_vec(), z_bottom: -3.0, z_top: 4.0 };
            let cloud = vec![[0.0, 0.0, -2.0], [2.0, 0.0, -2.0], [1.0, 2.0, 3.0]];
            let u = shadow_union(&[box_, deep], &[cloud], sun);
            assert_eq!(u.len(), 1);
            assert!(u[0][0].iter().all(|p| dot(p) <= near + 1e-6));
            assert!(u[0][0].iter().all(|p| p[0] < 2.0 + 4.0 * k + 1e-6), "vergrabener Körper bei x ≥ 10 ohne Schatten");
        }
    }

    fn square(x0: f64, y0: f64, s: f64) -> Ring {
        vec![[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]]
    }

    #[test]
    fn hof_zerlegt() {
        let mut hole = square(5.0, 5.0, 10.0);
        hole.reverse();
        let parts = without_holes(&vec![square(0.0, 0.0, 20.0), hole]);
        assert!(parts.len() > 1);
        let sum: f64 = parts.iter().map(|p| signed_area(p).abs()).sum();
        assert!((sum - 300.0).abs() < 1e-6);
        assert_eq!(without_holes(&vec![square(0.0, 0.0, 3.0)]), vec![square(0.0, 0.0, 3.0)]);
    }
}

// ── Schatten aus dem Projekt-Dokument ([K4] S2) ─────────────────────────────

use crate::jsmath::hypot2;
use crate::model::Project;

/// Vereinigter Boden-Schatten aller Wände, freien Körper und Dächer des Projekts (leer bei Nacht).
/// Wände und Körper als Prismen, Dächer als Punktwolke (Traufe auf Traufhöhe, Traufe/First/Grate
/// auf Firsthöhe).
pub fn shadow_polygons_project(p: &Project, sun: SunPosition) -> Vec<Polygon> {
    if shadow_shift(sun).is_none() {
        return vec![];
    }
    // [142] Mit Geländenetz fällt der Schatten aufs Gelände (inkl. Baugruben), sonst auf ±0.00.
    let site = shadow_terrain(p);
    let ground = site.as_ref().map(|st| Ground::new(st.current(), st.datum));
    let mut prisms: Vec<Prism> = Vec::new();
    for w in &p.walls {
        let (z_bottom, z_top) = p.wall_vertical_extent(w);
        // Bogenwand ([T2]): Kreisringsektor als Prisma.
        if let Some(footprint) = crate::wall_arc::arc_footprint(w, p.wall_thickness(w, 0.2)) {
            prisms.push(Prism { footprint, z_bottom, z_top });
            continue;
        }
        let dx = w.end.x - w.start.x;
        let dy = w.end.y - w.start.y;
        let len = hypot2(dx, dy);
        if len < 1e-9 {
            continue;
        }
        let t = p.wall_thickness(w, 0.2) / 2.0;
        let nx = (-dy / len) * t;
        let ny = (dx / len) * t;
        prisms.push(Prism {
            footprint: vec![
                [w.start.x + nx, w.start.y + ny],
                [w.end.x + nx, w.end.y + ny],
                [w.end.x - nx, w.end.y - ny],
                [w.start.x - nx, w.start.y - ny],
            ],
            z_bottom,
            z_top,
        });
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") {
            continue;
        }
        let base = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let z0 = base + s.base_offset.unwrap_or(0.0);
        prisms.push(Prism { footprint: s.points.iter().map(|v| [v.x, v.y]).collect(), z_bottom: z0, z_top: z0 + s.height });
    }
    let mut clouds: Vec<Vec<[f64; 3]>> = Vec::new();
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        let eaves_z = p.roof_base_elevation(r);
        let geo = crate::roof::roof_geometry(&r.params(), eaves_z);
        let top = eaves_z + geo.ridge_height;
        let mut pts: Vec<[f64; 3]> = Vec::new();
        for e in &geo.eaves {
            pts.push([e[0], e[1], eaves_z]);
            pts.push([e[0], e[1], top]);
        }
        for l in &geo.ridges {
            pts.push([l[0][0], l[0][1], top]);
            pts.push([l[1][0], l[1][1], top]);
        }
        for l in &geo.hips {
            pts.push([l[1][0], l[1][1], top]);
        }
        // Auf dem Gelände ist der Schatten der Traufkante gekrümmt: Zwischenpunkte entlang der Traufe.
        if ground.is_some() {
            let (s, _) = sample_ring(&geo.eaves);
            pts.extend(s.iter().flat_map(|e| [[e[0], e[1], eaves_z], [e[0], e[1], top]]));
        }
        clouds.push(pts);
    }
    // [142] Stützen (Prismen) und Bäume (2D-Kreise der Ebene „Bäume", Code 13): Stamm + Krone.
    for c in p.columns.as_deref().unwrap_or(&[]) {
        let (z_bottom, z_top) = p.column_vertical_extent(c);
        let footprint = crate::model3d::column_footprint(c).iter().map(|v| [v.x, v.y]).collect();
        prisms.push(Prism { footprint, z_bottom, z_top });
    }
    let tree_h = p.sun_study.as_ref().and_then(|s| s.tree_height).filter(|h| *h > 0.0).unwrap_or(DEFAULT_TREE_HEIGHT);
    for d in &p.drawings2d {
        let crate::model::Drawing2DGeom::Circle { center, r } = &d.geom else { continue };
        if !is_tree_category(p, &d.category_code) {
            continue;
        }
        let base = ground.as_ref().and_then(|g| g.z(center.x, center.y)).unwrap_or(GROUND_Z);
        if let Some((trunk, crown)) = tree_caster([center.x, center.y], *r, tree_h, base) {
            prisms.push(trunk);
            clouds.push(crown);
        }
    }
    shadow_union_on(&prisms, &clouds, sun, ground.as_ref())
}

/// Baumhöhe ohne `sunStudy.treeHeight` (m).
pub const DEFAULT_TREE_HEIGHT: f64 = 8.0;

/// Ebene der Bäume: Code 13 (SIA-Ebenenliste) oder ein Ebenenname mit „Baum"/„Tree".
fn is_tree_category(p: &Project, code: &str) -> bool {
    code == "13" || p.layer_category(code).is_some_and(|c| {
        let n = c.name.to_lowercase();
        n.contains("baum") || n.contains("bäume") || n.contains("tree")
    })
}

/// Gelände für den Schattenwurf: erstes sichtbares Geländenetz des Kontexts (inkl. Baugruben).
fn shadow_terrain(p: &Project) -> Option<std::rc::Rc<crate::excavation::SiteTerrain>> {
    let t = crate::excavation::terrains(p).into_iter().find(|t| t.hidden != Some(true))?;
    let st = crate::excavation::site_terrain(p, t);
    (!st.current().tris.is_empty()).then_some(st)
}

#[cfg(test)]
mod terrain_tests {
    //! [142] Schatten auf dem Gelände, Bäume und Stützen.
    use super::*;
    use crate::flat_read::signed_area;
    use crate::terrain::Tin;

    /// Rasternetz über [x0, x0 + (n−1)·step]² mit Höhe `f(x, y)`.
    fn grid_tin(n: usize, step: f64, x0: f64, f: impl Fn(f64, f64) -> f64) -> Tin {
        let (mut pos, mut idx) = (vec![], vec![]);
        for j in 0..n {
            for i in 0..n {
                let (x, y) = (x0 + i as f64 * step, x0 + j as f64 * step);
                pos.extend([x, y, f(x, y)]);
            }
        }
        for j in 0..n - 1 {
            for i in 0..n - 1 {
                let a = (j * n + i) as f64;
                let m = n as f64;
                idx.extend([a, a + 1.0, a + m + 1.0, a, a + m + 1.0, a + m]);
            }
        }
        Tin::from_flat(&pos, &idx)
    }

    /// Ebenes Gelände z = z0 + s·y über [−30, 30]².
    fn plane_tin(z0: f64, s: f64) -> Tin {
        grid_tin(61, 1.0, -30.0, |_, y| z0 + s * y)
    }

    const SQ: [[f64; 2]; 4] = [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];

    fn bbox(polys: &[Polygon]) -> [f64; 4] {
        polys.iter().flat_map(|p| p[0].iter()).fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])])
    }

    /// Körper am Hang: hangaufwärts kürzer, hangabwärts länger als auf der Ebene — wie analytisch.
    #[test]
    fn koerper_am_hang() {
        let s = 0.2; // Gelände steigt nach Norden um 20 %
        let tin = plane_tin(0.0, s);
        let g = Ground::new(&tin, 0.0);
        let (h, el) = (4.0, 40.0);
        let kl = 1.0 / (el * RAD).tan();
        let boxp = || Prism { footprint: SQ.to_vec(), z_bottom: -5.0, z_top: h };
        // Sonne im Süden → Schatten hangaufwärts (Nord) ab der Nordkante (y = 2, Gelände 0.4).
        let up = shadow_union_on(&[boxp()], &[], SunPosition { azimuth: 180.0, elevation: el }, Some(&g));
        assert_eq!(up.len(), 1);
        let d_up = (h - 2.0 * s) * kl / (1.0 + s * kl);
        assert!((bbox(&up)[3] - (2.0 + d_up)).abs() < 1e-6, "hangaufwärts {} statt {}", bbox(&up)[3], 2.0 + d_up);
        // Sonne im Norden → Schatten hangabwärts (Süd) ab der Südkante (y = 0, Gelände 0).
        let down = shadow_union_on(&[boxp()], &[], SunPosition { azimuth: 0.0, elevation: el }, Some(&g));
        let d_down = h * kl / (1.0 - s * kl);
        assert!((bbox(&down)[1] + d_down).abs() < 1e-6, "hangabwärts {} statt {}", bbox(&down)[1], -d_down);
        assert!(d_up < h * kl && d_down > h * kl);
        // Fläche = Grundriss + Schattenband (Breite 2).
        let a: f64 = up.iter().map(|p| signed_area(&p[0]).abs()).sum();
        assert!((a - 2.0 * (2.0 + d_up)).abs() < 1e-3, "{a}");
    }

    /// Freigelegte Untergeschoss-Wand über tieferem Gelände: wirft Schatten, obwohl sie ganz unter
    /// ±0.00 liegt; ohne Gelände (Ebene ±0.00) nicht; ganz im Gelände auch nicht.
    #[test]
    fn freigelegte_ug_wand() {
        let tin = plane_tin(-3.0, 0.0);
        let g = Ground::new(&tin, 0.0);
        let wall = || Prism { footprint: vec![[0.0, 0.0], [6.0, 0.0], [6.0, 0.3], [0.0, 0.3]], z_bottom: -3.0, z_top: -0.2 };
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let on = shadow_union_on(&[wall()], &[], sun, Some(&g));
        assert_eq!(on.len(), 1);
        assert!((bbox(&on)[3] - (0.3 + 2.8)).abs() < 1e-6, "{:?}", bbox(&on));
        assert!(shadow_union_on(&[wall()], &[], sun, None).is_empty());
        let tin2 = plane_tin(0.5, 0.0);
        assert!(shadow_union_on(&[wall()], &[], sun, Some(&Ground::new(&tin2, 0.0))).is_empty());
    }

    /// Ohne Gelände unverändert; auf welligem Gelände eine saubere Fläche ohne Splitter-Löcher, nur
    /// von der Sonne weg.
    #[test]
    fn ohne_gelaende_wie_bisher_und_ohne_splitter() {
        let sun = SunPosition { azimuth: 215.0, elevation: 28.0 };
        let ps = || {
            vec![
                Prism { footprint: SQ.to_vec(), z_bottom: 0.0, z_top: 5.0 },
                Prism { footprint: vec![[1.0, 0.0], [9.0, 0.0], [9.0, 0.25], [1.0, 0.25]], z_bottom: -3.0, z_top: 3.0 },
            ]
        };
        assert_eq!(shadow_union_on(&ps(), &[], sun, None), shadow_union(&ps(), &[], sun));
        let tin = grid_tin(81, 0.5, -20.0, |x, y| 0.6 * (x / 2.0).sin() * (y / 3.0).cos() - 0.5);
        let u = shadow_union_on(&ps(), &[], sun, Some(&Ground::new(&tin, 0.0)));
        assert_eq!(u.len(), 1, "eine zusammenhängende Fläche");
        assert_eq!(u[0].len(), 1, "keine Löcher");
        let to_sun = [(215.0 * RAD).sin(), (215.0 * RAD).cos()];
        let near = ps().iter().flat_map(|p| p.footprint.clone()).map(|q| q[0] * to_sun[0] + q[1] * to_sun[1]).fold(f64::MIN, f64::max);
        assert!(u[0][0].iter().all(|q| q[0] * to_sun[0] + q[1] * to_sun[1] <= near + 1e-6), "nur von der Sonne weg");
    }

    fn project_json(extra: serde_json::Value) -> Project {
        let mut v = serde_json::json!({
            "id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
            "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "cutHeight": 1.0, "baseElevation": 0}],
            "layers": [{"code": "13", "name": "Bäume", "color": "#000", "lw": 0.13, "visible": true, "locked": false}],
            "walls": [], "openings": [], "ceilings": [], "stairs": [], "rooms": [], "drawings2d": [], "context": []
        });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        serde_json::from_value(v).unwrap()
    }

    /// Bäume (Kreis auf der Ebene „Bäume", Höhe aus `sunStudy.treeHeight`) und Stützen werfen Schatten.
    #[test]
    fn baum_und_stuetze() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let tree = serde_json::json!([{"id": "b", "type": "drawing2d", "levelId": "eg", "categoryCode": "13", "geom": {"shape": "circle", "center": {"x": 0, "y": 0}, "r": 2.0}}]);
        let p = project_json(serde_json::json!({ "drawings2d": tree, "sunStudy": {"when": "2026-06-21T10:00:00Z", "show": true, "treeHeight": 10.0} }));
        let b = bbox(&shadow_polygons_project(&p, sun));
        // Krone ≈ Kugel r = 2 um z = 8: Schatten bis y = 8 + 2·√2 (45°), Kronenbreite ±2.
        assert!((b[3] - (8.0 + 2.0 * 2f64.sqrt())).abs() < 0.05 && (b[2] - 2.0).abs() < 0.05 && b[1] > -0.2, "{b:?}");
        let p2 = project_json(serde_json::json!({ "drawings2d": tree }));
        assert!((bbox(&shadow_polygons_project(&p2, sun))[3] - (DEFAULT_TREE_HEIGHT - 2.0 + 2.0 * 2f64.sqrt())).abs() < 0.05);
        let p3 = project_json(serde_json::json!({
            "columns": [{"id": "c", "type": "column", "floorId": "eg", "categoryCode": "25", "position": {"x": 5, "y": 5}, "profile": {"kind": "rect", "width": 0.2, "depth": 0.2}, "rotation": 0, "height": 3.0}]
        }));
        let b = bbox(&shadow_polygons_project(&p3, sun));
        assert!((b[3] - 8.1).abs() < 1e-6 && (b[0] - 4.9).abs() < 1e-6, "{b:?}");
        // Kreis auf einer anderen Ebene ist kein Baum.
        let p4 = project_json(serde_json::json!({
            "drawings2d": [{"id": "k", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "circle", "center": {"x": 0, "y": 0}, "r": 2.0}}]
        }));
        assert!(shadow_polygons_project(&p4, sun).is_empty());
    }
}
