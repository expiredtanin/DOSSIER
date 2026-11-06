//! Bindungen der GPU-Kompilierung (`crate::gpu_compile`). Ausgabe-Layout s. dort.

use crate::plan::line_ends::LineEnds;
use wasm_bindgen::prelude::wasm_bindgen;

/// Primitive `[from, to)` eines Plan-Puffers (v2) → Vertex-/Index-/Batch-Daten als ein
/// `u32`-Puffer; leer bei unlesbarem Puffer oder ungültigem Bereich. `line_ends` = Linienenden
/// und -ecken `cap | join << 2` ([146], 0 = flach + Gehrung).
#[wasm_bindgen]
pub fn gpu_compile_flat(buf: &[u8], from: u32, to: u32, px_per_meter: f64, packed_lines: bool, line_ends: u32) -> Vec<u32> {
    crate::gpu_compile::compile_flat(buf, from as usize, to as usize, px_per_meter, packed_lines, LineEnds::from_code(line_ends as f64))
}

/// Wie [`gpu_compile_flat`] auf einem gehaltenen Puffer (`plan_buf_hold`); leer, wenn er nicht
/// mehr gehalten wird.
#[wasm_bindgen]
pub fn gpu_compile_held(id: u32, from: u32, to: u32, px_per_meter: f64, packed_lines: bool, line_ends: u32) -> Vec<u32> {
    super::plan_buf::with_held(id, |b| crate::gpu_compile::compile_flat(b, from as usize, to as usize, px_per_meter, packed_lines, LineEnds::from_code(line_ends as f64))).unwrap_or_default()
}

/// Ear-Clipping eines Rings `[x, y, …]` → Dreiecks-Indizes.
#[wasm_bindgen]
pub fn triangulate_flat(pts: &[f64]) -> Vec<u32> {
    crate::gpu_compile::triangulate(&crate::hatch_flat::pts(pts))
}
