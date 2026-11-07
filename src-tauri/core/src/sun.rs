//! Sonnenstand und Boden-Schatten (Lageplan-Schattenstudie, [64]/[59]); aus `analysis/sun.ts`.
//!
//!  • [`sun_position`]: Azimut (° von Nord im Uhrzeigersinn) und Höhe (°) nach dem vereinfachten
//!    NOAA-Verfahren (Genauigkeit ~0.1°, ohne Refraktion).
//!  • [`shadow_of_prism`] / [`shadow_union`]: Boden-Schatten (z = 0) als Vereinigung konvexer
//!    Hüllen (Körper ∪ verschobener Körper). Modell: x = Ost, y = Nord, Höhen in Metern über dem
//!    Geländenullpunkt. TS sammelt die Prismen (Wände, Körper) und Punktwolken (Dächer).
//!  • [`shadow_polygons_plan`] ([142]): Schatten im Grundriss aus dem Projekt — alle Bauteile als
//!    Flächen-Körper, je Empfänger (Gelände, Decken, Dachflächen unter dem Schnitt) projiziert.
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
/// ausserhalb beginnt). Gebäudeflächen als Empfänger rechnet [`shadow_polygons_plan`] je Fläche.
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

    /// [159] Wie `new(st.current(), st.datum)`, mit dem gemerkten Suchraster des Geländes.
    pub fn of_site(st: &'a crate::excavation::SiteTerrain) -> Ground<'a> {
        let z_min = st.current().z_range().0 - st.datum;
        Ground { idx: st.index_current(), datum: st.datum, z_min: if z_min.is_finite() { z_min } else { GROUND_Z } }
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

/// Splitter weg: Teile und Löcher unter `min_area` (m²).
fn without_slivers(polys: Vec<Polygon>, min_area: f64) -> Vec<Polygon> {
    polys
        .into_iter()
        .filter(|p| p.first().is_some_and(|o| signed_area(o).abs() >= min_area))
        .map(|p| p.into_iter().enumerate().filter(|(i, r)| *i == 0 || signed_area(r).abs() >= min_area).map(|(_, r)| r).collect())
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
    without_slivers(polygon_bool::union(&parts), SLIVER_AREA)
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

// ── Schatten aus dem Projekt-Dokument ([K4] S2, [142]) ──────────────────────

use crate::flat_read::signed_area;
use crate::jsmath::hypot2;
use crate::model::Project;

/// Ebene Fläche eines Schattenwerfers (3D; Ring 0 aussen, weitere Ringe Löcher im Gegensinn).
type Face = Vec<Vec<[f64; 3]>>;

/// Ebene `z = a·x + b·y + c` als `[a, b, c]`.
type Plane = [f64; 3];

/// Höhenabstand (m), ab dem eine Fläche über einer anderen liegt.
const LEVEL_EPS: f64 = 0.01;

/// Schattenwerfer des Projekts. Der Schatten eines geschlossenen Körpers auf einer Ebene ist die
/// Vereinigung der Projektionen seiner Flächen über der Ebene (jeder Strahl durch den Körper verlässt
/// ihn durch eine Fläche über der Ebene) — exakt auch für nicht-konvexe Körper.
struct Casters {
    /// Prismen mit Löchern (Wände, Körper, Stützen, Decken, Baumstämme); fürs Gelände abgetastet.
    prisms: Vec<(Prism, Vec<Ring>)>,
    /// Dachflächen in ihrer echten Form (Dachflächen + Stirnen bis Traufhöhe, verschnittene Dächer
    /// und Gauben als Hülle des Körpers).
    roof_faces: Vec<Face>,
    /// Konvexe Punktwolken (Baumkronen).
    clouds: Vec<Vec<[f64; 3]>>,
    /// Alle ebenen Flächen für Empfänger-Ebenen: zur Sonne gewandte Prismenflächen + Dachflächen.
    faces: Vec<Face>,
}

/// Gebäudefläche (Decke, Dach): darunter ist nicht im Freien — kein Sonnenschatten auf Tieferem.
struct Cover {
    region: Polygon,
    bottom: f64,
}

/// Schattenempfangende Gebäudefläche im Grundriss (Decke/Terrasse, Dachfläche eines tieferen Geschosses).
struct Recv {
    region: Polygon,
    plane: Plane,
    top: f64,
}

/// Aussenring gegen, Löcher im Uhrzeigersinn; Ringe unter drei Punkten fallen weg.
fn oriented(poly: Polygon) -> Polygon {
    let mut out: Polygon = poly.into_iter().filter(|r| r.len() >= 3 && r.iter().all(|q| q[0].is_finite() && q[1].is_finite())).collect();
    for (i, r) in out.iter_mut().enumerate() {
        if (i == 0) == (signed_area(r) < 0.0) {
            r.reverse();
        }
    }
    out
}

fn bbox2<'a>(pts: impl Iterator<Item = &'a [f64; 2]>) -> [f64; 4] {
    pts.fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])])
}

fn overlaps(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

fn plane_h(pl: Plane, p: [f64; 3]) -> f64 {
    p[2] - (pl[0] * p[0] + pl[1] * p[1] + pl[2])
}

/// Normale nach Newell (nicht normiert).
fn newell(r: &[[f64; 3]]) -> [f64; 3] {
    let mut n = [0.0; 3];
    for i in 0..r.len() {
        let (a, b) = (r[i], r[(i + 1) % r.len()]);
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n
}

/// Ebene einer Fläche; `None` für (fast) lotrechte oder entartete Flächen.
fn face_plane(r: &[[f64; 3]]) -> Option<Plane> {
    let n = newell(r);
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    let p0 = *r.first()?;
    if !(len > 1e-12) || n[2].abs() / len < 0.05 {
        return None;
    }
    Some([-n[0] / n[2], -n[1] / n[2], p0[2] + (n[0] * p0[0] + n[1] * p0[1]) / n[2]])
}

/// Teil eines Rings mit `h ≥ 0` über der Ebene (Sutherland–Hodgman).
fn clip_ring(r: &[[f64; 3]], pl: Plane) -> Vec<[f64; 3]> {
    let mut out = Vec::with_capacity(r.len() + 2);
    for i in 0..r.len() {
        let (a, b) = (r[i], r[(i + 1) % r.len()]);
        let (ha, hb) = (plane_h(pl, a), plane_h(pl, b));
        if ha >= 0.0 {
            out.push(a);
        }
        if (ha >= 0.0) != (hb >= 0.0) {
            let t = ha / (ha - hb);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        }
    }
    out
}

/// Punkt entlang des Sonnenstrahls (von der Sonne weg) auf die Ebene; `den` = 1 + a·kx + b·ky.
fn onto(pl: Plane, k: [f64; 2], den: f64, p: [f64; 3]) -> [f64; 2] {
    let t = plane_h(pl, p) / den;
    [p[0] + k[0] * t, p[1] + k[1] * t]
}

/// Schatten einer Fläche auf der Ebene: ihr Teil über der Ebene, entlang der Sonne projiziert.
fn project_face(face: &Face, pl: Plane, k: [f64; 2], den: f64) -> Option<Polygon> {
    let outer = face.first()?;
    if !outer.iter().any(|p| plane_h(pl, *p) > 1e-6) {
        return None;
    }
    let mut poly: Polygon = Vec::with_capacity(face.len());
    for (i, r) in face.iter().enumerate() {
        let c = clip_ring(r, pl);
        if c.len() < 3 {
            if i == 0 {
                return None;
            }
            continue;
        }
        poly.push(c.into_iter().map(|p| onto(pl, k, den, p)).collect());
    }
    let a = signed_area(&poly[0]);
    if !(a.abs() > 1e-9) {
        return None;
    }
    if a < 0.0 {
        poly.iter_mut().for_each(|r| r.reverse());
    }
    Some(poly)
}

/// Schatten einer konvexen Punktwolke auf der Ebene: Hülle des projizierten Teils über ihr.
fn project_cloud(points: &[[f64; 3]], pl: Plane, k: [f64; 2], den: f64) -> Ring {
    let (up, down): (Vec<[f64; 3]>, Vec<[f64; 3]>) = points.iter().copied().filter(|p| p.iter().all(|v| v.is_finite())).partition(|p| plane_h(pl, *p) >= 0.0);
    if !up.iter().any(|p| plane_h(pl, *p) > 1e-9) {
        return vec![];
    }
    let mut pts: Vec<[f64; 2]> = up.iter().map(|p| onto(pl, k, den, *p)).collect();
    for a in &up {
        for b in &down {
            let (ha, hb) = (plane_h(pl, *a), plane_h(pl, *b));
            let t = ha / (ha - hb);
            pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    hull(&pts)
}

/// Zur Sonne gewandte Flächen eines Prismas mit Löchern: Oberseite und die Seiten, deren
/// Aussennormale zur Sonne zeigt (durch sie verlässt jeder Strahl den Körper).
fn prism_faces(fp: &[[f64; 2]], holes: &[Ring], zb: f64, zt: f64, k: [f64; 2]) -> Vec<Face> {
    if !(zt > zb) || !zb.is_finite() || !zt.is_finite() {
        return vec![];
    }
    let poly = oriented(std::iter::once(fp.to_vec()).chain(holes.iter().cloned()).collect());
    if poly.first().is_none_or(|r| r.len() < 3 || fp.len() < 3) {
        return vec![];
    }
    let at = |r: &Ring, z: f64| r.iter().map(|q| [q[0], q[1], z]).collect::<Vec<_>>();
    let mut out: Vec<Face> = vec![poly.iter().map(|r| at(r, zt)).collect()];
    for r in &poly {
        for i in 0..r.len() {
            let (a, b) = (r[i], r[(i + 1) % r.len()]);
            if (b[1] - a[1]) * k[0] - (b[0] - a[0]) * k[1] >= 0.0 {
                continue;
            }
            out.push(vec![vec![[a[0], a[1], zb], [b[0], b[1], zb], [b[0], b[1], zt], [a[0], a[1], zt]]]);
        }
    }
    out
}

/// Schatten aller Werfer auf der Ebene (nur Teile, deren Rechteck `within` schneidet); `None`, wenn
/// die Ebene von der Sonne abgewandt ist (ganz im Eigenschatten).
fn plane_shadow(c: &Casters, pl: Plane, k: [f64; 2], within: Option<[f64; 4]>) -> Option<Vec<Polygon>> {
    let den = 1.0 + pl[0] * k[0] + pl[1] * k[1];
    if !(den > 1e-6) {
        return None;
    }
    let keep = |r: &Ring| within.is_none_or(|b| overlaps(bbox2(r.iter()), b));
    let mut parts: Vec<Polygon> = c.faces.iter().filter_map(|f| project_face(f, pl, k, den)).filter(|p| keep(&p[0])).collect();
    parts.extend(c.clouds.iter().map(|cl| project_cloud(cl, pl, k, den)).filter(|r| r.len() >= 3 && keep(r)).map(|r| vec![r]));
    Some(if parts.is_empty() { vec![] } else { polygon_bool::union(&parts) })
}

fn key3(p: [f64; 3]) -> [i64; 3] {
    [(p[0] * 1e6).round() as i64, (p[1] * 1e6).round() as i64, (p[2] * 1e6).round() as i64]
}

/// Ungerichtete Kante zwischen zwei Ecken (gerundet).
fn edge_key(a: [f64; 3], b: [f64; 3]) -> ([i64; 3], [i64; 3]) {
    let (ka, kb) = (key3(a), key3(b));
    if ka <= kb { (ka, kb) } else { (kb, ka) }
}

/// Wie oft jede Kante in den Flächen vorkommt (2 = innere Kante zwischen zwei Flächen).
type EdgeCount = std::collections::HashMap<([i64; 3], [i64; 3]), usize>;

/// Bereits aufs Gelände projizierte Stützpunkte (gemeinsame Ecken benachbarter Flächen).
type ProjCache = std::collections::HashMap<[i64; 3], [f64; 2]>;

/// Geländeschatten einer Dachfläche: Rand, jeder Punkt über dem Gelände entlang der Sonne aufs Gelände
/// (Bild des Randes = Rand des Bildes). Aussenkanten im Abstand ≤ `EDGE_SAMPLE` abgetastet (aufs
/// Gelände gekrümmt); Kanten zwischen zwei Flächen nur an den Ecken (liegen im Innern der Vereinigung,
/// beide Flächen nehmen dieselbe Sehne — keine Fuge).
fn face_part_on(face: &Face, k: [f64; 2], g: &Ground, edges: &EdgeCount, cache: &mut ProjCache) -> Option<Polygon> {
    let outer = face.first()?;
    if !outer.iter().all(|p| p.iter().all(|v| v.is_finite())) {
        return None;
    }
    let mut proj = |p: [f64; 3]| -> [f64; 2] { *cache.entry(key3(p)).or_insert_with(|| if p[2] > g.z(p[0], p[1]).unwrap_or(GROUND_Z) + 1e-9 { g.project(p, k) } else { [p[0], p[1]] }) };
    let mut ring: Ring = Vec::new();
    for i in 0..outer.len() {
        let (a, b) = (outer[i], outer[(i + 1) % outer.len()]);
        let n = if edges.get(&edge_key(a, b)).copied().unwrap_or(0) > 1 { 1 } else { (hypot2(b[0] - a[0], b[1] - a[1]) / EDGE_SAMPLE).ceil().clamp(1.0, 10_000.0) as usize };
        for j in 0..n {
            let t = j as f64 / n as f64;
            ring.push(proj([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]));
        }
    }
    (signed_area(&ring).abs() > 1e-9).then(|| oriented(vec![ring]))
}

/// Schatten aller Werfer auf dem Gelände.
fn terrain_shadow(c: &Casters, k: [f64; 2], g: &Ground) -> Vec<Polygon> {
    let mut parts: Vec<Polygon> = c.prisms.iter().flat_map(|(p, _)| prism_parts_on(&p.footprint, p.z_bottom, p.z_top, k, g)).collect();
    let mut edges = EdgeCount::new();
    for r in c.roof_faces.iter().filter_map(|f| f.first()) {
        for i in 0..r.len() {
            *edges.entry(edge_key(r[i], r[(i + 1) % r.len()])).or_default() += 1;
        }
    }
    let mut cache = ProjCache::new();
    parts.extend(c.roof_faces.iter().filter_map(|f| face_part_on(f, k, g, &edges, &mut cache)));
    parts.extend(c.clouds.iter().map(|cl| cloud_part_on(cl, k, g)).filter(|r| r.len() >= 3).map(|r| vec![r]));
    if parts.is_empty() {
        return vec![];
    }
    polygon_bool::union(&parts)
}

/// Dach als Körper von der Traufhöhe bis zur Dachfläche: Dachflächen (nach oben gerichtet) und an
/// jeder Randkante (nicht mit einer anderen Fläche geteilt) die lotrechte Stirn bis auf Traufhöhe.
fn roof_body_faces(planes: &[Vec<[f64; 3]>], eaves_z: f64) -> Vec<Face> {
    use std::collections::HashMap;
    let key = |q: [f64; 3]| ((q[0] * 1e5).round() as i64, (q[1] * 1e5).round() as i64);
    let mut count: HashMap<((i64, i64), (i64, i64)), usize> = HashMap::new();
    for pl in planes {
        for i in 0..pl.len() {
            let (a, b) = (key(pl[i]), key(pl[(i + 1) % pl.len()]));
            *count.entry(if a <= b { (a, b) } else { (b, a) }).or_default() += 1;
        }
    }
    let mut out = Vec::new();
    for pl in planes.iter().filter(|pl| pl.len() >= 3) {
        out.push(vec![pl.clone()]);
        for i in 0..pl.len() {
            let (a, b) = (pl[i], pl[(i + 1) % pl.len()]);
            let (ka, kb) = (key(a), key(b));
            if count.get(&if ka <= kb { (ka, kb) } else { (kb, ka) }).copied().unwrap_or(0) > 1 || (a[2] - eaves_z).max(b[2] - eaves_z) < 1e-6 {
                continue;
            }
            out.push(vec![vec![[a[0], a[1], eaves_z], [b[0], b[1], eaves_z], [b[0], b[1], b[2].max(eaves_z)], [a[0], a[1], a[2].max(eaves_z)]]]);
        }
    }
    out
}

/// Werfer, Abdeckungen und (mit Schnitthöhe `cut`) Empfänger des Projekts.
fn collect(p: &Project, k: [f64; 2], cut: Option<f64>, ground: Option<&Ground>) -> (Casters, Vec<Cover>, Vec<Recv>) {
    let gz = |x: f64, y: f64| ground.and_then(|g| g.z(x, y)).unwrap_or(GROUND_Z);
    let mut prisms: Vec<(Prism, Vec<Ring>)> = Vec::new();
    let mut covers: Vec<Cover> = Vec::new();
    let mut recvs: Vec<Recv> = Vec::new();
    // Empfänger nur im Grundriss sichtbar (OK nicht über dem Schnitt) und nicht im Gelände vergraben.
    let mut receive = |region: Polygon, plane: Plane, top: f64| {
        let Some(c) = cut else { return };
        let region = oriented(region);
        let Some(outer) = region.first() else { return };
        let b = bbox2(outer.iter());
        if top <= c + 1e-9 && top >= gz(0.5 * (b[0] + b[2]), 0.5 * (b[1] + b[3])) - 0.05 {
            recvs.push(Recv { region, plane, top });
        }
    };
    for w in &p.walls {
        let (z_bottom, z_top) = p.wall_vertical_extent(w);
        // Bogenwand ([T2]): Kreisringsektor als Prisma.
        if let Some(footprint) = crate::wall_arc::arc_footprint(w, p.wall_thickness(w, 0.2)) {
            prisms.push((Prism { footprint, z_bottom, z_top }, vec![]));
            continue;
        }
        let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
        let len = hypot2(dx, dy);
        if len < 1e-9 {
            continue;
        }
        let t = p.wall_thickness(w, 0.2) / 2.0;
        let (nx, ny) = ((-dy / len) * t, (dx / len) * t);
        let footprint = vec![[w.start.x + nx, w.start.y + ny], [w.end.x + nx, w.end.y + ny], [w.end.x - nx, w.end.y - ny], [w.start.x - nx, w.start.y - ny]];
        prisms.push((Prism { footprint, z_bottom, z_top }, vec![]));
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") {
            continue;
        }
        let base = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let z0 = base + s.base_offset.unwrap_or(0.0);
        prisms.push((Prism { footprint: s.points.iter().map(|v| [v.x, v.y]).collect(), z_bottom: z0, z_top: z0 + s.height }, vec![]));
    }
    for c in p.columns.as_deref().unwrap_or(&[]) {
        let (z_bottom, z_top) = p.column_vertical_extent(c);
        let footprint = crate::model3d::column_footprint(c).iter().map(|v| [v.x, v.y]).collect();
        prisms.push((Prism { footprint, z_bottom, z_top }, vec![]));
    }
    // [142] Decken (auch Balkone, Auskragungen) werfen Schatten, decken Tieferes ab und empfangen ihn.
    for ce in p.ceilings.as_deref().unwrap_or(&[]) {
        let (zb, zt) = p.ceiling_vertical_extent(ce);
        let ring = |r: &[crate::model::Vec2]| r.iter().map(|v| [v.x, v.y]).collect::<Ring>();
        let outline = ring(&ce.outline);
        let holes: Vec<Ring> = crate::opening_shape::ceiling_hole_rings(p, ce).iter().map(|h| ring(h)).collect();
        let region = oriented(std::iter::once(outline.clone()).chain(holes.iter().cloned()).collect());
        if region.first().is_none_or(|r| r.len() < 3) || !(zt > zb) {
            continue;
        }
        covers.push(Cover { region: region.clone(), bottom: zb });
        receive(region, [0.0, 0.0, zt], zt);
        prisms.push((Prism { footprint: outline, z_bottom: zb, z_top: zt }, holes));
    }
    // [142] Dächer in ihrer echten Form: verschnittene Dächer (Gauben, Anbauten) als Hülle ihres
    // Körpers, sonst Dachflächen + Stirnen bis Traufhöhe.
    let mut roof_faces: Vec<Face> = Vec::new();
    let nb = crate::roof_assembly::neighbors_rc(p);
    for (ri, r) in p.roofs.as_deref().unwrap_or(&[]).iter().enumerate() {
        let eaves_z = p.roof_base_elevation(r);
        let geo = crate::roof::roof_geometry(&r.params(), eaves_z);
        let tops: Vec<Vec<[f64; 3]>> = match crate::roof_assembly::roof_solids_with(p, ri, &nb) {
            Some(solids) if !solids.skin.indices.is_empty() => {
                let tris: Vec<usize> = (0..solids.skin.indices.len() / 3).collect();
                let faces = crate::roof_assembly::planar_faces(&solids.skin, &tris);
                let up: Vec<Vec<[f64; 3]>> = faces.iter().filter(|f| face_plane(f).is_some() && newell(f)[2] > 0.0).cloned().collect();
                roof_faces.extend(faces.into_iter().map(|f| vec![f]));
                up
            }
            _ => {
                let planes: Vec<Vec<[f64; 3]>> = geo
                    .planes
                    .iter()
                    .map(|pl| {
                        let mut pl = pl.clone();
                        if newell(&pl)[2] < 0.0 {
                            pl.reverse();
                        }
                        pl
                    })
                    .collect();
                roof_faces.extend(roof_body_faces(&planes, eaves_z));
                planes
            }
        };
        let region = oriented(std::iter::once(geo.eaves.clone()).chain(geo.eaves_holes.iter().cloned()).collect());
        if !region.is_empty() {
            covers.push(Cover { region, bottom: eaves_z });
        }
        for f in &tops {
            if let Some(pl) = face_plane(f) {
                let top = f.iter().map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
                receive(vec![f.iter().map(|q| [q[0], q[1]]).collect()], pl, top);
            }
        }
    }
    // [142] Bäume (2D-Kreise der Ebene „Bäume", Code 13): Stamm + Krone. [149] Steht ein Baum-Objekt am selben
    // Ort (Stamm nahe der Kreismitte), zählt nur das Objekt — sonst fiele der Schatten doppelt.
    let mut clouds: Vec<Vec<[f64; 3]>> = Vec::new();
    let tree_h = p.sun_study.as_ref().and_then(|s| s.tree_height).filter(|h| *h > 0.0).unwrap_or(DEFAULT_TREE_HEIGHT);
    let objects = crate::tree::geoms(p);
    for d in &p.drawings2d {
        let crate::model::Drawing2DGeom::Circle { center, r } = &d.geom else { continue };
        if !is_tree_category(p, &d.category_code) {
            continue;
        }
        if objects.iter().any(|(_, g)| circle_is_tree_object(center.x, center.y, *r, g.c)) {
            continue;
        }
        if let Some((trunk, crown)) = tree_caster([center.x, center.y], *r, tree_h, gz(center.x, center.y)) {
            prisms.push((trunk, vec![]));
            clouds.push(crown);
        }
    }
    // [149] Bäume als eigene Objekte: Stamm (Prisma) + Krone (Punktwolke) nach eigener Höhe, Krone und Form.
    for (_, g) in objects {
        prisms.push((Prism { footprint: g.trunk_ring(8), z_bottom: g.base, z_top: g.trunk_top() }, vec![]));
        clouds.push(g.crown_points());
    }
    // Nur zur Sonne gewandte Dachflächen (Aussennormale): durch sie verlässt jeder Strahl den Körper.
    roof_faces.retain(|f| f.first().is_some_and(|r| {
        let n = newell(r);
        n[2] - n[0] * k[0] - n[1] * k[1] > 1e-12
    }));
    let mut faces: Vec<Face> = prisms.iter().flat_map(|(pr, holes)| prism_faces(&pr.footprint, holes, pr.z_bottom, pr.z_top, k)).collect();
    faces.extend(roof_faces.iter().cloned());
    (Casters { prisms, roof_faces, clouds, faces }, covers, recvs)
}

/// Vereinigter Boden-Schatten aller Wände, Körper, Stützen, Decken, Dächer und Bäume des Projekts
/// (leer bei Nacht); mit `cut` wie [`shadow_polygons_plan`] im Geschoss am Gelände.
pub fn shadow_polygons_project(p: &Project, sun: SunPosition, cut: Option<f64>) -> Vec<Polygon> {
    shadow_plan(p, sun, cut, true)
}

/// [142] Schatten im Grundriss mit Schnitthöhe `cut`: auf den sichtbaren Flächen im Freien — Decken,
/// Terrassen und Dachflächen, deren Oberkante nicht über dem Schnitt liegt, und (`with_ground`, Geschoss
/// am Gelände) auf dem Gelände bzw. ±0.00. Flächen unter einer höheren Decke oder einem Dach (Innenräume,
/// unter Balkonen) und unter einer höheren sichtbaren Fläche zeigen keinen Schatten.
pub fn shadow_polygons_plan(p: &Project, sun: SunPosition, cut: f64, with_ground: bool) -> Vec<Polygon> {
    shadow_plan(p, sun, Some(cut), with_ground)
}

fn shadow_plan(p: &Project, sun: SunPosition, cut: Option<f64>, with_ground: bool) -> Vec<Polygon> {
    let Some(k) = shadow_shift(sun) else { return vec![] };
    // [142] Mit Geländenetz fällt der Schatten aufs Gelände (inkl. Baugruben), sonst auf ±0.00.
    let site = shadow_terrain(p);
    let ground = site.as_deref().map(Ground::of_site);
    let (casters, covers, recvs) = collect(p, k, cut, ground.as_ref());
    let mask = |above: f64| -> Vec<Polygon> {
        covers.iter().filter(|c| c.bottom > above + LEVEL_EPS).map(|c| c.region.clone()).chain(recvs.iter().filter(|r| r.top > above + LEVEL_EPS).map(|r| r.region.clone())).collect()
    };
    let mut out: Vec<Polygon> = Vec::new();
    if with_ground {
        let mut sh = match &ground {
            Some(g) => terrain_shadow(&casters, k, g),
            None => plane_shadow(&casters, [0.0, 0.0, GROUND_Z], k, None).unwrap_or_default(),
        };
        if cut.is_some() {
            // Gelände unter Gebäudeflächen und unter sichtbaren Empfängern zeigt keinen Schatten.
            let m: Vec<Polygon> = mask(GROUND_Z).into_iter().chain(recvs.iter().map(|r| r.region.clone())).collect();
            if !m.is_empty() && !sh.is_empty() {
                sh = polygon_bool::difference(&sh, &m);
            }
        }
        out.extend(sh);
    }
    for r in &recvs {
        let m = mask(r.top);
        let vis = if m.is_empty() { vec![r.region.clone()] } else { polygon_bool::difference(&[r.region.clone()], &m) };
        if vis.is_empty() {
            continue;
        }
        let b = bbox2(vis.iter().flat_map(|q| q[0].iter()));
        match plane_shadow(&casters, r.plane, k, Some(b)) {
            None => out.extend(vis),
            Some(sh) if !sh.is_empty() => out.extend(polygon_bool::intersection(&sh, &vis)),
            Some(_) => {}
        }
    }
    if out.is_empty() {
        return vec![];
    }
    without_slivers(polygon_bool::union(&out), if site.is_some() { SLIVER_AREA } else { 1e-4 })
}

/// [149] Kreis der Baum-Ebene am Ort eines Baum-Objekts (Stammmitte höchstens eine halbe Kreisbreite, mindestens
/// 0.5 m, von der Kreismitte): der Kreis ist dann nur die alte Darstellung desselben Baums.
fn circle_is_tree_object(cx: f64, cy: f64, r: f64, stem: [f64; 2]) -> bool {
    let tol = (0.5 * r).max(0.5);
    hypot2(stem[0] - cx, stem[1] - cy) <= tol
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

    fn in_ring(x: f64, y: f64, r: &[[f64; 2]]) -> bool {
        let mut inside = false;
        let mut j = r.len().wrapping_sub(1);
        for i in 0..r.len() {
            let (a, b) = (r[i], r[j]);
            if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
            j = i;
        }
        inside
    }

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

    /// Liegt (x, y) im Schatten (gerade/ungerade über alle Ringe)?
    fn shaded(polys: &[Polygon], x: f64, y: f64) -> bool {
        let mut inside = false;
        for r in polys.iter().flatten() {
            let mut j = r.len() - 1;
            for i in 0..r.len() {
                let (a, b) = (r[i], r[j]);
                if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
                    inside = !inside;
                }
                j = i;
            }
        }
        inside
    }

    fn area(polys: &[Polygon]) -> f64 {
        polys.iter().flatten().map(|r| signed_area(r)).sum::<f64>().abs()
    }

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> serde_json::Value {
        serde_json::json!([{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}])
    }

    fn levels() -> serde_json::Value {
        serde_json::json!([
            {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "cutHeight": 1.0, "baseElevation": 0},
            {"id": "t", "name": "T", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "cutHeight": 1.0, "baseElevation": -2},
            {"id": "og", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "cutHeight": 1.0, "baseElevation": 3}
        ])
    }

    fn slab(id: &str, floor: &str, outline: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"id": id, "type": "ceiling", "floorId": floor, "categoryCode": "21", "wallTypeId": "x", "outline": outline})
    }

    /// [142] Schatten auf tiefere Gebäudeteile: Körper (OK 6 m) neben einer Platte mit OK 1 m — im
    /// Grundriss (Schnitt 1.0) endet der Schatten auf der Platte (Länge 5 statt 6 bei 45°); die Platte
    /// wirft selbst Schatten; das Gelände unter ihr zeigt keinen.
    #[test]
    fn schatten_auf_tiefere_platte() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let solid = serde_json::json!([{"id": "s", "type": "extrudedSolid", "levelId": "eg", "points": rect(0.0, 0.0, 2.0, 2.0), "height": 6.0}]);
        let p = project_json(serde_json::json!({ "drawingLevels": levels(), "extrudedSolids": solid, "ceilings": [slab("c", "t", rect(-5.0, 2.5, 7.0, 20.0))] }));
        let (zb, zt) = p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]);
        assert!((zt - 1.0).abs() < 1e-9 && zb < 1.0 && zb > 0.0, "{zb} {zt}");
        // Ohne Schnitt: Boden ±0.00 — Körper 6 m, Platte 1 m (ihr Schatten bis y = 21).
        let raw = shadow_polygons_project(&p, sun, None);
        assert!(shaded(&raw, 1.0, 7.5) && shaded(&raw, 0.0, 20.5) && !shaded(&raw, 0.0, 21.2));
        // Mit Schnitt 1.0: Platte fängt ab, 5 m.
        let on = shadow_polygons_project(&p, sun, Some(1.0));
        assert!(shaded(&on, 1.0, 6.9) && !shaded(&on, 1.0, 7.2) && shaded(&on, 1.0, 2.2), "Körperschatten auf der Platte bis y = 7");
        assert!(shaded(&on, -4.0, 20.5) && !shaded(&on, -4.0, 19.0), "Plattenschatten nur ausserhalb der Platte");
        // Fläche: Körper + Band bis 7 (2 × 7) und Plattenschatten jenseits ihrer Kante (12 × 1).
        assert!((area(&on) - 26.0).abs() < 0.05, "{}", area(&on));
        // Decke über dem Schnitt (OG, OK 6): fängt nichts, deckt das Gelände darunter ab (kein Schatten im
        // Innern) und wirft ihren Schatten jenseits der Kante.
        let p2 = project_json(serde_json::json!({ "drawingLevels": levels(), "extrudedSolids": solid, "ceilings": [slab("c", "og", rect(-5.0, 2.5, 7.0, 20.0))] }));
        let on2 = shadow_polygons_project(&p2, sun, Some(1.0));
        assert!(shaded(&on2, 1.0, 2.2) && !shaded(&on2, 1.0, 5.0) && shaded(&on2, 0.0, 25.0) && !shaded(&on2, 0.0, 26.5));
        // Platte endet bei y = 5: Strahl ist dort noch über der Platte (z = 3) und geht bis zum Boden.
        let p3 = project_json(serde_json::json!({ "drawingLevels": levels(), "extrudedSolids": solid, "ceilings": [slab("c", "t", rect(-5.0, 2.5, 7.0, 5.0))] }));
        let on3 = shadow_polygons_project(&p3, sun, Some(1.0));
        assert!(shaded(&on3, 1.0, 4.9) && shaded(&on3, 1.0, 7.5) && !shaded(&on3, 1.0, 8.2) && shaded(&on3, -4.0, 5.5));
    }

    /// [142] Auskragung (Körper über dem Boden) und Balkon (Decke) werfen Schatten; der Boden unter der
    /// Auskragung bleibt hell.
    #[test]
    fn schatten_einer_auskragung_und_eines_balkons() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let solid = serde_json::json!([{"id": "s", "type": "extrudedSolid", "levelId": "eg", "points": rect(0.0, 0.0, 4.0, 2.0), "height": 0.3, "baseOffset": 3.0}]);
        let p = project_json(serde_json::json!({ "drawingLevels": levels(), "extrudedSolids": solid }));
        let sh = shadow_polygons_project(&p, sun, None);
        assert!(shaded(&sh, 1.0, 4.0) && !shaded(&sh, 1.0, 1.0) && !shaded(&sh, 1.0, 5.4));
        assert!((area(&sh) - 4.0 * 2.3).abs() < 1e-6, "{}", area(&sh));
        // Balkon: Decke des EG (OK 3.0) ohne Wände.
        let p = project_json(serde_json::json!({ "drawingLevels": levels(), "ceilings": [slab("b", "eg", rect(10.0, 0.0, 14.0, 2.0))] }));
        let (zb, zt) = p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]);
        assert!(zb >= 2.0 && zt > zb);
        for cut in [None, Some(1.0)] {
            let sh = shadow_polygons_project(&p, sun, cut);
            assert!((area(&sh) - 4.0 * (2.0 + zt - zb)).abs() < 1e-6, "{cut:?}: {}", area(&sh));
            assert!(shaded(&sh, 12.0, 4.0) && !shaded(&sh, 12.0, 1.0));
        }
    }

    /// [142] Nicht-konvexe Dächer: Schatten aus der echten Dachform statt aus der konvexen Hülle —
    /// L-förmiges Walmdach lässt den Innenwinkel hell.
    #[test]
    fn nichtkonvexes_dach() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let l = serde_json::json!([{"x": 0, "y": 0}, {"x": 6, "y": 0}, {"x": 6, "y": 2}, {"x": 2, "y": 2}, {"x": 2, "y": 6}, {"x": 0, "y": 6}]);
        let roof = |shape: &str, pitch: f64| {
            serde_json::json!([{"id": "r", "type": "roof", "floorId": "eg", "categoryCode": "31", "outline": l, "shape": shape, "pitchDeg": pitch, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.0}])
        };
        // Walmdach 45°: Arme 2 m breit, First 1 m über der Traufe; der Ostarm wirft bis y = 5, der
        // Westarm (Walm, Firstende y = 5 auf 4 m) bis y = 9.
        let sh = shadow_polygons_project(&project_json(serde_json::json!({ "roofs": roof("walm", 45.0) })), sun, None);
        assert!(shaded(&sh, 4.0, 4.5) && shaded(&sh, 1.0, 8.5) && !shaded(&sh, 1.0, 9.2));
        assert!(!shaded(&sh, 4.5, 5.5), "Innenwinkel bleibt hell");
        // Auf ebenem Gelände (TIN auf ±0.00) dasselbe: Dachflächen abgetastet aufs Gelände projiziert.
        let p = project_json(serde_json::json!({ "roofs": roof("walm", 45.0) }));
        let tin = plane_tin(0.0, 0.0);
        let g = Ground::new(&tin, 0.0);
        let k = shadow_shift(sun).unwrap();
        let (c, _, _) = collect(&p, k, None, Some(&g));
        let on = terrain_shadow(&c, k, &g);
        assert!(shaded(&on, 4.0, 4.5) && shaded(&on, 1.0, 8.5) && !shaded(&on, 1.0, 9.2) && !shaded(&on, 4.5, 5.5));
        assert!((area(&on) - area(&sh)).abs() < 0.05, "{} {}", area(&on), area(&sh));
    }

    /// [142] Schatten im Plan eines höheren Geschosses: auf Dach/Terrasse des tieferen Geschosses; im
    /// EG-Plan nicht auf der (höher liegenden) Terrasse, nur auf dem Gelände.
    #[test]
    fn schatten_auf_tieferem_dach_im_og_plan() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        // Turm 0..2 × 0..2, 6 m hoch; Terrasse (Decke EG, OK 3.0) nördlich davon, 0..2 × 2..4.
        let solid = serde_json::json!([{"id": "s", "type": "extrudedSolid", "levelId": "eg", "points": rect(0.0, 0.0, 2.0, 2.0), "height": 6.0}]);
        let p = project_json(serde_json::json!({ "drawingLevels": levels(), "extrudedSolids": solid, "ceilings": [slab("t", "eg", rect(0.0, 2.0, 2.0, 4.0))] }));
        let zt = p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]).1;
        assert!((zt - 3.0).abs() < 1e-9);
        // OG-Plan (Schnitt 4.0, ohne Gelände): Schatten nur auf der Terrasse (ganz, Turm wirft bis y = 2 + 3).
        let og = shadow_polygons_plan(&p, sun, 4.0, false);
        assert!((area(&og) - 4.0).abs() < 1e-6, "{}", area(&og));
        assert!(shaded(&og, 1.0, 3.0) && !shaded(&og, 1.0, 6.0) && !shaded(&og, 3.0, 3.0));
        // Teilweise: Turm nur 4 m hoch → Schatten auf der Terrasse bis y = 2 + 1.
        let low = serde_json::json!([{"id": "s", "type": "extrudedSolid", "levelId": "eg", "points": rect(0.0, 0.0, 2.0, 2.0), "height": 4.0}]);
        let p_low = project_json(serde_json::json!({ "drawingLevels": levels(), "extrudedSolids": low, "ceilings": [slab("t", "eg", rect(0.0, 2.0, 2.0, 4.0))] }));
        let og = shadow_polygons_plan(&p_low, sun, 4.0, false);
        assert!((area(&og) - 2.0).abs() < 1e-6 && shaded(&og, 1.0, 2.5) && !shaded(&og, 1.0, 3.5), "{}", area(&og));
        // EG-Plan (Schnitt 1.0, mit Gelände): unter der Terrasse kein Schatten, dahinter schon.
        let eg = shadow_polygons_plan(&p, sun, 1.0, true);
        assert!(!shaded(&eg, 1.0, 3.0) && shaded(&eg, 1.0, 5.0) && shaded(&eg, 1.0, 7.5) && !shaded(&eg, 1.0, 8.5));
        // Schnitt unter der Terrasse fängt auf ihr nichts; Flächen sind dort keine Empfänger.
        assert!(shadow_polygons_plan(&p, sun, 1.0, false).is_empty());
    }

    /// Nicht endliche Werte und Nacht: leer, ohne Panik.
    #[test]
    fn plan_unsinn_ohne_panik() {
        let p = project_json(serde_json::json!({ "drawingLevels": levels(), "ceilings": [slab("t", "eg", rect(0.0, 2.0, f64::MAX, 4.0))] }));
        let _ = shadow_polygons_plan(&p, SunPosition { azimuth: 180.0, elevation: 45.0 }, f64::NAN, true);
        assert!(shadow_polygons_plan(&p, SunPosition { azimuth: 180.0, elevation: -5.0 }, 4.0, true).is_empty());
    }

    /// [148] Flachdach auf L-Umriss wirft einen L-förmigen Schatten (nicht Bounding-Box, nicht konvexe
    /// Hülle): OK 3 m, Sonne 45° aus Süden ⇒ L um 3 m nach Norden verschoben, 60 m².
    #[test]
    fn flachdach_l_schatten() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let l = serde_json::json!([{"x": 0, "y": 0}, {"x": 11, "y": 0}, {"x": 11, "y": 4}, {"x": 8, "y": 4}, {"x": 8, "y": 6}, {"x": 0, "y": 6}]);
        let roof = serde_json::json!([{"id": "r", "type": "roof", "floorId": "eg", "categoryCode": "35", "outline": l, "shape": "flach", "pitchDeg": 0, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.3}]);
        let p = project_json(serde_json::json!({ "roofs": roof }));
        let s = shadow_polygons_project(&p, sun, None);
        let a: f64 = s.iter().map(|q| signed_area(&q[0]).abs() - q[1..].iter().map(|h| signed_area(h).abs()).sum::<f64>()).sum();
        assert!((a - 60.0).abs() < 0.05, "{a}");
        let b = bbox(&s);
        assert!((b[1] - 3.0).abs() < 1e-6 && (b[3] - 9.0).abs() < 1e-6, "{b:?}");
        // Aussparung (10, 8) bleibt hell.
        let hit = s.iter().any(|q| in_ring(10.0, 8.0, &q[0]));
        assert!(!hit, "Schatten in der Aussparung");
    }

    /// Bäume (Kreis auf der Ebene „Bäume", Höhe aus `sunStudy.treeHeight`) und Stützen werfen Schatten.
    #[test]
    fn baum_und_stuetze() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let tree = serde_json::json!([{"id": "b", "type": "drawing2d", "levelId": "eg", "categoryCode": "13", "geom": {"shape": "circle", "center": {"x": 0, "y": 0}, "r": 2.0}}]);
        let p = project_json(serde_json::json!({ "drawings2d": tree, "sunStudy": {"when": "2026-06-21T10:00:00Z", "show": true, "treeHeight": 10.0} }));
        let b = bbox(&shadow_polygons_project(&p, sun, None));
        // Krone ≈ Kugel r = 2 um z = 8: Schatten bis y = 8 + 2·√2 (45°), Kronenbreite ±2.
        assert!((b[3] - (8.0 + 2.0 * 2f64.sqrt())).abs() < 0.05 && (b[2] - 2.0).abs() < 0.05 && b[1] > -0.2, "{b:?}");
        let p2 = project_json(serde_json::json!({ "drawings2d": tree }));
        assert!((bbox(&shadow_polygons_project(&p2, sun, None))[3] - (DEFAULT_TREE_HEIGHT - 2.0 + 2.0 * 2f64.sqrt())).abs() < 0.05);
        let p3 = project_json(serde_json::json!({
            "columns": [{"id": "c", "type": "column", "floorId": "eg", "categoryCode": "25", "position": {"x": 5, "y": 5}, "profile": {"kind": "rect", "width": 0.2, "depth": 0.2}, "rotation": 0, "height": 3.0}]
        }));
        let b = bbox(&shadow_polygons_project(&p3, sun, None));
        assert!((b[3] - 8.1).abs() < 1e-6 && (b[0] - 4.9).abs() < 1e-6, "{b:?}");
        // Kreis auf einer anderen Ebene ist kein Baum.
        let p4 = project_json(serde_json::json!({
            "drawings2d": [{"id": "k", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "circle", "center": {"x": 0, "y": 0}, "r": 2.0}}]
        }));
        assert!(shadow_polygons_project(&p4, sun, None).is_empty());
    }

    /// [149] Baum-Objekt: Schattenlänge nach eigener Höhe und Krone (nicht `sunStudy.treeHeight`), Form zählt.
    #[test]
    fn baum_objekt_schatten_nach_hoehe() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let mk = |h: f64, d: f64, shape: &str| {
            project_json(serde_json::json!({
                "sunStudy": {"when": "2026-06-21T10:00:00Z", "show": true, "treeHeight": 30.0},
                "trees": [{"id": "t", "type": "tree", "floorId": "eg", "categoryCode": "13", "position": {"x": 0, "y": 0},
                    "trunkDiameter": 0.4, "crownDiameter": d, "crownBase": 2.0, "height": h, "shape": shape,
                    "status": "existing", "foliage": "deciduous"}]
            }))
        };
        // 45°: Spitze (Kegel) wirft bis y = h, Kronenbreite ±r.
        let b = bbox(&shadow_polygons_project(&mk(12.0, 4.0, "conical"), sun, None));
        assert!((b[3] - 12.0).abs() < 0.05 && (b[2] - 2.0).abs() < 0.05 && b[1] > -0.3, "{b:?}");
        let b6 = bbox(&shadow_polygons_project(&mk(6.0, 4.0, "conical"), sun, None));
        assert!((b6[3] - 6.0).abs() < 0.05, "{b6:?}");
        // Breitere Krone, breiterer Schatten; runde Krone endet vor der Spitze-Länge (Kugel: z_c + r·√2).
        let wide = bbox(&shadow_polygons_project(&mk(12.0, 8.0, "round"), sun, None));
        assert!((wide[2] - 4.0).abs() < 0.05, "{wide:?}");
        let a_small = area(&shadow_polygons_project(&mk(12.0, 4.0, "round"), sun, None));
        let a_wide = area(&shadow_polygons_project(&mk(12.0, 8.0, "round"), sun, None));
        assert!(a_wide > 2.0 * a_small, "{a_small} {a_wide}");
        // Kein Baum: kein Schatten.
        assert!(shadow_polygons_project(&project_json(serde_json::json!({"trees": []})), sun, None).is_empty());
    }

    /// [149] Kreis der Baum-Ebene am Ort eines Baum-Objekts wirft keinen zweiten Schatten (sonst hier mit
    /// `treeHeight` 30 m bis y = 30); ein Kreis anderswo wirft weiter.
    #[test]
    fn kreis_am_baum_objekt_nicht_doppelt() {
        let sun = SunPosition { azimuth: 180.0, elevation: 45.0 };
        let mk = |circle_x: f64| {
            project_json(serde_json::json!({
                "sunStudy": {"when": "2026-06-21T10:00:00Z", "show": true, "treeHeight": 30.0},
                "drawings2d": [{"id": "k", "type": "drawing2d", "levelId": "eg", "categoryCode": "13", "geom": {"shape": "circle", "center": {"x": circle_x, "y": 0.2}, "r": 2.0}}],
                "trees": [{"id": "t", "type": "tree", "floorId": "eg", "categoryCode": "13", "position": {"x": 0, "y": 0},
                    "trunkDiameter": 0.4, "crownDiameter": 4.0, "crownBase": 2.0, "height": 12.0, "shape": "conical",
                    "status": "existing", "foliage": "deciduous"}]
            }))
        };
        let same = bbox(&shadow_polygons_project(&mk(0.3), sun, None));
        assert!((same[3] - 12.0).abs() < 0.05, "nur das Objekt: {same:?}");
        let apart = bbox(&shadow_polygons_project(&mk(20.0), sun, None));
        assert!(apart[3] > 25.0, "Kreis anderswo wirft weiter: {apart:?}");
    }
}
