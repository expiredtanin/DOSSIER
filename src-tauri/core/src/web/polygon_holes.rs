//! Bindung des Brücken-Tricks (`crate::polygon_holes`).

use crate::flat_read::{pairs, Reader};
use crate::polygon_holes::merge_holes;
use wasm_bindgen::prelude::wasm_bindgen;

/// Aussenring `[x0, y0, …]`, Löcher `[n, (nPkt, x, y, …)…]`, Brückenabstand →
/// `[nBrücken, kantenIndex…, nPkt, x, y, …]`; leer bei kaputter Eingabe.
#[wasm_bindgen]
pub fn polygon_merge_holes(outline: &[f64], holes: &[f64], gap: f64) -> Vec<f64> {
    let mut r = Reader::new(holes);
    let Some(n) = r.count() else { return vec![] };
    let mut hs = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let Some(h) = r.ring() else { return vec![] };
        hs.push(h);
    }
    let m = merge_holes(&pairs(outline), &hs, gap);
    let mut out = Vec::with_capacity(2 + m.bridge_edges.len() + 2 * m.ring.len());
    out.push(m.bridge_edges.len() as f64);
    out.extend(m.bridge_edges.iter().map(|&k| k as f64));
    out.push(m.ring.len() as f64);
    for p in &m.ring {
        out.extend(*p);
    }
    out
}
