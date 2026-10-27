//! Bindungen der Schraffur-/Linienmuster-Geometrie (`crate::hatch`) für die TS-Fassade
//! `glPlanHatch.ts`. Punkte als `[x, y, …]`, Läufe als `[n, x, y, …(n Punkte), n, …]`,
//! Segmente als `[ax, ay, bx, by, …]`, Schraffur im Hatch-Format des Plan-Puffers.

use crate::hatch::{self, v2, Motif};
use crate::hatch_flat::{pts, runs_in, runs_out, segs_out};
use wasm_bindgen::prelude::wasm_bindgen;

fn opt(v: f64) -> Option<f64> {
    if v.is_nan() {
        None
    } else {
        Some(v)
    }
}

#[wasm_bindgen]
pub fn hatch_runs_flat(poly: &[f64], hatch_buf: &[f64]) -> Vec<f64> {
    match crate::plan_buf::decode_hatch(hatch_buf) {
        Some((h, _)) => runs_out(&hatch::build_hatch_runs(&pts(poly), &h)),
        None => Vec::new(),
    }
}

/// `scale` NaN = aus der Schraffur.
#[wasm_bindgen]
pub fn random_hatch_runs_flat(poly: &[f64], hatch_buf: &[f64], scale: f64) -> Vec<f64> {
    match crate::plan_buf::decode_hatch(hatch_buf) {
        Some((h, _)) => runs_out(&hatch::build_random_hatch_runs(&pts(poly), &h, opt(scale))),
        None => Vec::new(),
    }
}

#[wasm_bindgen]
pub fn dash_runs_flat(runs: &[f64], dash: &[f64]) -> Vec<f64> {
    runs_out(&hatch::apply_dash_runs(runs_in(runs), dash))
}

/// Leer = entartet (Aufrufer nimmt `[a, b]`).
#[wasm_bindgen]
pub fn zigzag_points_flat(ax: f64, ay: f64, bx: f64, by: f64, amplitude: f64, wavelength: f64) -> Vec<f64> {
    match hatch::zigzag_points(v2(ax, ay), v2(bx, by), amplitude, wavelength) {
        Some(p) => p.iter().flat_map(|q| [q.x, q.y]).collect(),
        None => Vec::new(),
    }
}

/// Leer = entartet (Aufrufer nimmt `[a, b]`).
#[wasm_bindgen]
pub fn motif_points_flat(ax: f64, ay: f64, bx: f64, by: f64, motif_pts: &[f64], length: f64, scale: f64) -> Vec<f64> {
    let m = Motif { points: pts(motif_pts), length };
    match hatch::motif_points_opt(v2(ax, ay), v2(bx, by), &m, scale) {
        Some(p) => p.iter().flat_map(|q| [q.x, q.y]).collect(),
        None => Vec::new(),
    }
}

#[wasm_bindgen]
pub fn clip_line_to_polygon_flat(px: f64, py: f64, dx: f64, dy: f64, poly: &[f64]) -> Vec<f64> {
    segs_out(&hatch::clip_line_to_polygon(v2(px, py), v2(dx, dy), &pts(poly)))
}

#[wasm_bindgen]
pub fn clip_segment_to_polygon_flat(ax: f64, ay: f64, bx: f64, by: f64, poly: &[f64]) -> Vec<f64> {
    segs_out(&hatch::clip_segment_to_polygon(v2(ax, ay), v2(bx, by), &pts(poly)))
}

#[wasm_bindgen]
pub fn clip_polyline_to_polygon_flat(line: &[f64], poly: &[f64]) -> Vec<f64> {
    runs_out(&hatch::clip_polyline_to_polygon(&pts(line), &pts(poly)))
}

#[wasm_bindgen]
pub fn hatch_line_family_flat(poly: &[f64], angle_rad: f64, spacing_m: f64, offset_m: f64, ax: f64, ay: f64) -> Vec<f64> {
    segs_out(&hatch::hatch_line_family(&pts(poly), angle_rad, spacing_m, offset_m, v2(ax, ay)))
}

/// `len_min`/`len_max` NaN = nicht gesetzt.
#[wasm_bindgen]
pub fn scatter_strokes_flat(
    poly: &[f64],
    cell: f64,
    base_angle_rad: f64,
    seed: f64,
    stroke_len: f64,
    len_min: f64,
    len_max: f64,
) -> Vec<f64> {
    runs_out(&hatch::scatter_strokes(&pts(poly), cell, base_angle_rad, seed, stroke_len, opt(len_min), opt(len_max)))
}
