//! Bogen-Formeln (DXF-bulge) als flache Aufrufe für `src/geometry/bulge.ts`. Die Mathematik steht
//! in `kernel2d` (`bulge.rs`); hier nur die Eingabe-Prüfung (NaN/∞ → neutrales Ergebnis, nie Panic)
//! und die flache Kodierung der Ergebnisse:
//! - Bogen `[cx, cy, r, a0, a1, sweep]`, „kein Bogen" = leerer Puffer
//! - CCW-Bogen `[cx, cy, r, a0, a1]`, „kein Bogen" = leerer Puffer
//! - Punkte `[x0, y0, x1, y1, …]`

use kernel2d::{self as k, ArcParams, Vec2};

fn v(x: f64, y: f64) -> Vec2 {
    Vec2::new(x, y)
}

fn finite(xs: &[f64]) -> bool {
    xs.iter().all(|x| x.is_finite())
}

fn flat_pts(pts: &[Vec2]) -> Vec<f64> {
    pts.iter().flat_map(|p| [p.x, p.y]).collect()
}

fn flat_arc(a: Option<ArcParams>) -> Vec<f64> {
    a.map(|a| vec![a.center.x, a.center.y, a.r, a.a0, a.a1]).unwrap_or_default()
}

pub fn arc(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64) -> Vec<f64> {
    if !finite(&[ax, ay, bx, by, bulge]) {
        return Vec::new();
    }
    match k::bulge_arc(v(ax, ay), v(bx, by), bulge) {
        Some(a) if finite(&[a.center.x, a.center.y, a.r, a.a0, a.a1, a.sweep]) => {
            vec![a.center.x, a.center.y, a.r, a.a0, a.a1, a.sweep]
        }
        _ => Vec::new(),
    }
}

pub fn arc_points(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64) -> Vec<f64> {
    if !finite(&[ax, ay, bx, by]) {
        return vec![ax, ay, bx, by];
    }
    let bulge = if bulge.is_finite() { bulge } else { 0.0 };
    flat_pts(&k::bulge_arc_points(v(ax, ay), v(bx, by), bulge))
}

/// `pts` = `[x0, y0, …]`, `bulge` je Kante (fehlende/NaN-Einträge = Gerade).
pub fn polyline_points(pts: &[f64], bulge: &[f64], closed: bool) -> Vec<f64> {
    if !finite(pts) {
        return Vec::new();
    }
    let p: Vec<Vec2> = pts.chunks_exact(2).map(|c| v(c[0], c[1])).collect();
    let b: Vec<f64> = bulge.iter().map(|x| if x.is_finite() { *x } else { 0.0 }).collect();
    flat_pts(&k::bulge_polyline_points(&p, &b, closed))
}

pub fn from_sagitta_point(ax: f64, ay: f64, bx: f64, by: f64, px: f64, py: f64) -> f64 {
    if !finite(&[ax, ay, bx, by, px, py]) {
        return 0.0;
    }
    k::bulge_from_sagitta_point(v(ax, ay), v(bx, by), v(px, py))
}

pub fn between_angles(cx: f64, cy: f64, r: f64, a_from: f64, a_to: f64, sweep_sign: f64) -> f64 {
    if !finite(&[cx, cy, r, a_from, a_to, sweep_sign]) {
        return 0.0;
    }
    k::bulge_between_angles(v(cx, cy), r, a_from, a_to, sweep_sign)
}

pub fn point_at(ax: f64, ay: f64, bx: f64, by: f64, bulge: f64, t: f64) -> Vec<f64> {
    if !finite(&[ax, ay, bx, by, t]) {
        return vec![ax, ay];
    }
    let bulge = if bulge.is_finite() { bulge } else { 0.0 };
    let p = k::bulge_point_at(v(ax, ay), v(bx, by), bulge, t);
    vec![p.x, p.y]
}

pub fn through_point(ax: f64, ay: f64, tx: f64, ty: f64, bx: f64, by: f64) -> f64 {
    if !finite(&[ax, ay, tx, ty, bx, by]) {
        return 0.0;
    }
    k::bulge_through_point(v(ax, ay), v(tx, ty), v(bx, by))
}

pub fn arc_through_points(ax: f64, ay: f64, tx: f64, ty: f64, bx: f64, by: f64) -> Vec<f64> {
    if !finite(&[ax, ay, tx, ty, bx, by]) {
        return Vec::new();
    }
    flat_arc(k::arc_through_points(v(ax, ay), v(tx, ty), v(bx, by)))
}

pub fn arc_from_start_end_radius(ax: f64, ay: f64, bx: f64, by: f64, r: f64, nx: f64, ny: f64) -> Vec<f64> {
    if !finite(&[ax, ay, bx, by, r, nx, ny]) {
        return Vec::new();
    }
    flat_arc(k::arc_from_start_end_radius(v(ax, ay), v(bx, by), r, v(nx, ny)))
}

pub fn arc_from_start_end_direction(ax: f64, ay: f64, bx: f64, by: f64, dx: f64, dy: f64) -> Vec<f64> {
    if !finite(&[ax, ay, bx, by, dx, dy]) {
        return Vec::new();
    }
    flat_arc(k::arc_from_start_end_direction(v(ax, ay), v(bx, by), v(dx, dy)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bogen_flach() {
        let a = arc(0.0, 0.0, 2.0, 0.0, 1.0);
        assert_eq!(a.len(), 6);
        assert!((a[0] - 1.0).abs() < 1e-9 && a[1].abs() < 1e-9 && (a[2] - 1.0).abs() < 1e-9);
        assert!(arc(0.0, 0.0, 2.0, 0.0, 0.0).is_empty());
        assert!(arc(0.0, 0.0, 0.0, 0.0, 1.0).is_empty());
    }

    #[test]
    fn unsinn_ohne_panic() {
        let nan = f64::NAN;
        assert!(arc(nan, 0.0, 1.0, 0.0, 1.0).is_empty());
        assert!(arc(0.0, 0.0, 1.0, 0.0, nan).is_empty());
        assert!(arc(0.0, 0.0, 1.0, 0.0, f64::INFINITY).is_empty());
        assert_eq!(arc_points(0.0, 0.0, 1.0, 0.0, nan), vec![0.0, 0.0, 1.0, 0.0]);
        assert_eq!(arc_points(nan, 0.0, 1.0, 0.0, 1.0).len(), 4);
        assert!(polyline_points(&[0.0, nan, 1.0, 1.0], &[], false).is_empty());
        assert!(polyline_points(&[], &[], true).is_empty());
        assert_eq!(polyline_points(&[0.0, 0.0, 1.0, 0.0, 5.0], &[nan], false), vec![0.0, 0.0, 1.0, 0.0]);
        assert_eq!(from_sagitta_point(nan, 0.0, 1.0, 0.0, 0.0, 1.0), 0.0);
        assert_eq!(between_angles(0.0, 0.0, 1.0, nan, 1.0, 1.0), 0.0);
        assert_eq!(point_at(0.0, 0.0, 1.0, 0.0, 1.0, nan), vec![0.0, 0.0]);
        assert_eq!(through_point(nan, 0.0, 1.0, 0.0, 2.0, 1.0), 0.0);
        assert!(arc_through_points(nan, 0.0, 1.0, 0.0, 2.0, 1.0).is_empty());
        assert!(arc_from_start_end_radius(0.0, 0.0, 2.0, 0.0, nan, 0.0, 1.0).is_empty());
        assert!(arc_from_start_end_direction(0.0, 0.0, 2.0, 0.0, nan, 1.0).is_empty());
    }

    #[test]
    fn polylinie_ganz() {
        // Quadrat, eine Kante Halbkreis: Start nicht doppelt, Schlusskante enthalten
        let p = polyline_points(&[0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 2.0], &[1.0, 0.0, 0.0, 0.0], true);
        assert_eq!(p.len() / 2, 17 + 2); // a..b (17), +c, +d; Schlusskante ohne Startpunkt
        assert_eq!(&p[..2], &[0.0, 0.0]);
    }

    #[test]
    fn bogen_ccw_flach() {
        let c = arc_through_points(2.0, 0.0, 1.0, 1.0, 0.0, 0.0);
        assert_eq!(c.len(), 5);
        assert!(arc_through_points(0.0, 0.0, 1.0, 0.0, 2.0, 0.0).is_empty());
        assert_eq!(arc_from_start_end_radius(0.0, 0.0, 2.0, 0.0, 1.0, 1.0, 5.0).len(), 5);
        assert_eq!(arc_from_start_end_direction(0.0, 0.0, 1.0, 1.0, 0.0, 1.0).len(), 5);
    }
}
