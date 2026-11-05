//! Bindungen der Griff-Zug-Rechnung (`crate::grip_drag`, [128]): Punkte als Zahlenpaare bzw. flache
//! Puffer `[x0, y0, …]`; NaN = „fehlt" (ungelockter Wert, kein Snap, kein Zentrum). Kaputte Puffer ergeben
//! ein leeres Ergebnis.

use crate::grip_drag::{self as gd, Edge, EdgeDrive, HeightGrip, P};
use wasm_bindgen::prelude::wasm_bindgen;

fn opt(v: f64) -> Option<f64> {
    (!v.is_nan()).then_some(v)
}

fn opt_p(x: f64, y: f64) -> Option<P> {
    (!x.is_nan() && !y.is_nan()).then_some((x, y))
}

fn pts(f: &[f64]) -> Vec<P> {
    f.chunks_exact(2).map(|c| (c[0], c[1])).collect()
}

fn flat(v: &[P]) -> Vec<f64> {
    v.iter().flat_map(|p| [p.0, p.1]).collect()
}

/// `[länge, winkel°, abstand entlang (nx, ny)]` von `(ax, ay)` nach `(px, py)`.
#[wasm_bindgen]
pub fn grip_polar(ax: f64, ay: f64, px: f64, py: f64, nx: f64, ny: f64) -> Vec<f64> {
    let (l, a, o) = gd::polar((ax, ay), (px, py), (nx, ny));
    vec![l, a, o]
}

/// Punkt aus Anker + Länge/Winkel° (NaN = folgt dem Cursor `(rx, ry)`): `[x, y]`.
#[wasm_bindgen]
pub fn grip_polar_point(ax: f64, ay: f64, length: f64, angle: f64, rx: f64, ry: f64) -> Vec<f64> {
    let p = gd::polar_point((ax, ay), opt(length), opt(angle), (rx, ry));
    vec![p.0, p.1]
}

/// Shift-Achsen-Lock (`grip_drag::axis_lock`): Ursprung `(ox, oy)` NaN = noch keiner; `ring` = Punkte des
/// Elements (leer = keine Polygon-Nachbarn), `index` = gezogener Punkt darin. `[x, y]`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn grip_axis_lock(rx: f64, ry: f64, ax: f64, ay: f64, ox: f64, oy: f64, ring: &[f64], index: f64, closed: bool) -> Vec<f64> {
    let ring = pts(ring);
    let i = if index >= 0.0 && index.fract() == 0.0 && index < ring.len() as f64 { index as usize } else { usize::MAX };
    let p = gd::axis_lock((rx, ry), (ax, ay), opt_p(ox, oy), &ring, i, closed);
    vec![p.0, p.1]
}

/// Zielpunkt eines Kanten-Zugs (`grip_drag::edge_target`): Kante `mid`/`normal`/`free`, Cursor, Feld-Controller
/// (`locked`, Länge/Winkel NaN = live), Shift, Raster (0 = aus), Geometrie-Snap (NaN = keiner). `[x, y]`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn grip_edge_target(
    mx: f64,
    my: f64,
    nx: f64,
    ny: f64,
    free: bool,
    rx: f64,
    ry: f64,
    locked: bool,
    length: f64,
    angle: f64,
    shift: bool,
    grid: f64,
    sx: f64,
    sy: f64,
) -> Vec<f64> {
    let edge = Edge { mid: (mx, my), normal: (nx, ny), free };
    let grid = if grid.is_finite() && grid > 0.0 { grid } else { 0.0 };
    let d = EdgeDrive { locked, length: opt(length), angle: opt(angle), shift, grid, snapped: opt_p(sx, sy) };
    let p = gd::edge_target(edge, (rx, ry), d);
    vec![p.0, p.1]
}

/// Höhen-Griff im Schnitt (`kind` 0 Wand-Oberkante, 1 Öffnung oben, 2 Öffnung unten): `[oben, unten, höhe,
/// brüstung]` (Brüstung NaN, wenn sie sich nicht ändert); `[]` bei unbekannter Art.
#[wasm_bindgen]
pub fn grip_sheet_height(kind: u32, base: f64, top: f64, bottom: f64, y: f64, free: bool) -> Vec<f64> {
    let k = match kind {
        0 => HeightGrip::WallTop,
        1 => HeightGrip::OpeningTop,
        2 => HeightGrip::OpeningBottom,
        _ => return vec![],
    };
    let r = gd::sheet_height(k, base, top, bottom, y, free);
    vec![r.top, r.bottom, r.height, r.sill_height.unwrap_or(f64::NAN)]
}

/// Mittelpunkt-Griff einer Öffnung auf der Wandachse `s → e`: `[x, y]`.
#[wasm_bindgen]
pub fn grip_opening_point(sx: f64, sy: f64, ex: f64, ey: f64, position: f64, width: f64) -> Vec<f64> {
    let p = gd::opening_wall_grip((sx, sy), (ex, ey), position, width);
    vec![p.0, p.1]
}

/// Neue Öffnungs-`position` beim Ziehen des Mittelpunkt-Griffs nach `(px, py)`: `[position]`, `[]` = Wand ohne Länge.
#[wasm_bindgen]
pub fn grip_opening_slide(sx: f64, sy: f64, ex: f64, ey: f64, width: f64, px: f64, py: f64) -> Vec<f64> {
    gd::opening_slide((sx, sy), (ex, ey), width, (px, py)).map(|p| vec![p]).unwrap_or_default()
}

/// Öffnung im Schnitt-Blatt (`grip_drag::opening_slide_sheet`): `[position, wirksames du]`, `[]` = keine Bewegung.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn grip_opening_slide_sheet(sx: f64, sy: f64, ex: f64, ey: f64, ux: f64, uy: f64, position: f64, width: f64, du: f64) -> Vec<f64> {
    gd::opening_slide_sheet((sx, sy), (ex, ey), (ux, uy), position, width, du).map(|(p, d)| vec![p, d]).unwrap_or_default()
}

/// Bewegpunkt einer Treppe (Zentrum NaN = keines): `[x, y]`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn grip_stair_handle(spiral: bool, cx: f64, cy: f64, sx: f64, sy: f64, dx: f64, dy: f64, run_length: f64) -> Vec<f64> {
    let p = gd::stair_handle(spiral, opt_p(cx, cy), (sx, sy), (dx, dy), run_length);
    vec![p.0, p.1]
}

/// Griffe einer Wand (Bogenwand mit Scheitel-Griff): `[x0, y0, …]`.
#[wasm_bindgen]
pub fn grip_wall_points(sx: f64, sy: f64, ex: f64, ey: f64, bulge: f64) -> Vec<f64> {
    flat(&gd::wall_grips((sx, sy), (ex, ey), bulge))
}

/// Griffe einer Baugrube (Umriss `[x0, y0, …]`, dann der Sohlen-Griff): `[x0, y0, …]`.
#[wasm_bindgen]
pub fn grip_excavation_points(outline: &[f64], bottom: f64) -> Vec<f64> {
    flat(&gd::excavation_grips(&pts(outline), bottom))
}

/// Koinzidente Punkte anderer Elemente an den Ecken `corners` (`[x0, y0, …]`); `groups` = je Element
/// `[n, x0, y0, …]` hintereinander. Antwort `[element, punkt, …]`; `[]` bei kaputtem Puffer.
#[wasm_bindgen]
pub fn grip_coincident(corners: &[f64], groups: &[f64]) -> Vec<f64> {
    let mut gs: Vec<Vec<P>> = Vec::new();
    let mut i = 0;
    while i < groups.len() {
        let n = groups[i];
        if !(n >= 0.0 && n.fract() == 0.0) {
            return vec![];
        }
        let end = i + 1 + 2 * n as usize;
        if end > groups.len() {
            return vec![];
        }
        gs.push(pts(&groups[i + 1..end]));
        i = end;
    }
    gd::coincident(&pts(corners), &gs).into_iter().flat_map(|(g, k)| [g as f64, k as f64]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kaputte_puffer_leer() {
        assert!(grip_coincident(&[0.0, 0.0], &[3.0, 1.0]).is_empty());
        assert!(grip_coincident(&[0.0, 0.0], &[f64::NAN]).is_empty());
        assert_eq!(grip_coincident(&[0.0, 0.0], &[1.0, 0.01, 0.0, 0.0]), vec![0.0, 0.0]);
        assert!(grip_sheet_height(7, 0.0, 1.0, 0.0, 1.0, false).is_empty());
        // Unsinniger Index: keine Polygon-Nachbarn, nur Welt-H/V.
        assert_eq!(grip_axis_lock(3.0, 0.4, 0.0, 0.0, 1.0, 1.0, &[0.0, 0.0, 1.0, 1.0], f64::NAN, true), vec![3.0, 0.0]);
    }
}
