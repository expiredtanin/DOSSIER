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

/// Schatten einer Punktwolke (x, y, z): Hülle der um `k·z` verschobenen Punkte.
fn shadow_of_points(points: &[[f64; 3]], k: [f64; 2]) -> Ring {
    let moved: Vec<[f64; 2]> = points.iter().map(|p| [p[0] + k[0] * p[2], p[1] + k[1] * p[2]]).collect();
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
