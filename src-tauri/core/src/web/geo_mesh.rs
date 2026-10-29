//! Bindungen der Mesh-Aufbereitung des Gebäude-Imports (`crate::geo_mesh`) für `src/io/swissBuildings3d.ts`.
//! Eingabe: Positionen `[x, y, z, …]` und Indizes (je als `f64`-Puffer). Ausgabe flach:
//! Zuschnitt/Soffiten `[nPos, pos…, idx…]` (leer = Mesh unverändert lassen);
//! Zerlegen `[nKomponenten, (nPos, nIdx, pos…, idx…)*]` (leer = eine Komponente, Mesh unverändert).
//! Unsinn (NaN-Grenzen, leere Puffer) ergibt das leere Ergebnis — nie Panic.

use crate::geo_mesh as gm;
use wasm_bindgen::prelude::wasm_bindgen;

fn encode(m: &gm::Mesh) -> Vec<f64> {
    let mut out = Vec::with_capacity(1 + m.pos.len() + m.idx.len());
    out.push((m.pos.len() / 3) as f64);
    out.extend_from_slice(&m.pos);
    out.extend_from_slice(&m.idx);
    out
}

/// Zuschnitt auf `[xMin, yMin, xMax, yMax]` (Dreieck bleibt, sobald eine Ecke in der Box liegt).
#[wasm_bindgen]
pub fn geo_mesh_clip(pos: &[f64], idx: &[f64], bbox: &[f64]) -> Vec<f64> {
    if bbox.len() != 4 {
        return Vec::new();
    }
    encode(&gm::clip_to_bbox(pos, idx, [bbox[0], bbox[1], bbox[2], bbox[3]]))
}

/// Dachüberstand-Untersichten entfernen (leer = unverändert).
#[wasm_bindgen]
pub fn geo_mesh_strip_soffits(pos: &[f64], idx: &[f64]) -> Vec<f64> {
    gm::strip_overhang_soffits(pos, idx).map(|m| encode(&m)).unwrap_or_default()
}

/// In zusammenhängende Gebäude zerlegen (Verschweiss-Toleranz in mm).
#[wasm_bindgen]
pub fn geo_mesh_split(pos: &[f64], idx: &[f64], weld_mm: f64) -> Vec<f64> {
    if !weld_mm.is_finite() || weld_mm <= 0.0 {
        return Vec::new();
    }
    let parts = gm::split_components(pos, idx, weld_mm);
    if parts.is_empty() {
        return Vec::new();
    }
    let mut out = vec![parts.len() as f64];
    for p in &parts {
        out.push((p.pos.len() / 3) as f64);
        out.push(p.idx.len() as f64);
        out.extend_from_slice(&p.pos);
        out.extend_from_slice(&p.idx);
    }
    out
}

/// Footprints extrudieren: `[nGebäude, (Höhe, nPunkte, x, y, …)*]` → `[nPos, pos…, idx…]`.
#[wasm_bindgen]
pub fn geo_extrude_footprints(data: &[f64]) -> Vec<f64> {
    let mut rings: Vec<(f64, Vec<[f64; 2]>)> = Vec::new();
    let mut at = 1;
    let n = data.first().copied().unwrap_or(0.0);
    if !(n >= 0.0) {
        return Vec::new();
    }
    for _ in 0..n as usize {
        let (Some(&h), Some(&np)) = (data.get(at), data.get(at + 1)) else { return Vec::new() };
        let np = np as usize;
        let Some(pts) = data.get(at + 2..at + 2 + np * 2) else { return Vec::new() };
        rings.push((h, pts.chunks_exact(2).map(|c| [c[0], c[1]]).collect()));
        at += 2 + np * 2;
    }
    encode(&gm::extrude_rings(&rings))
}
