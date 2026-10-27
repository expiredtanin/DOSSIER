//! Bindungen der GPU-Kompilierung (`crate::gpu_compile`). Ausgabe-Layout s. dort.

use wasm_bindgen::prelude::wasm_bindgen;

/// Plan-Puffer (ein Chunk) → Vertex-/Index-/Batch-Daten als ein `u32`-Puffer; leer bei
/// unlesbarem Puffer.
#[wasm_bindgen]
pub fn gpu_compile_flat(buf: &[f64], px_per_meter: f64, packed_lines: bool) -> Vec<u32> {
    crate::gpu_compile::compile_flat(buf, px_per_meter, packed_lines)
}

/// Ear-Clipping eines Rings `[x, y, …]` → Dreiecks-Indizes.
#[wasm_bindgen]
pub fn triangulate_flat(pts: &[f64]) -> Vec<u32> {
    crate::gpu_compile::triangulate(&crate::hatch_flat::pts(pts))
}
