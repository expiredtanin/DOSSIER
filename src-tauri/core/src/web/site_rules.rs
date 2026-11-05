//! Bindungen des Baurechts (`crate::site_rules`).

use crate::flat::{decode, encode};
use crate::flat_read::Reader;
use crate::site_rules::{self, BuildingLine, SiteRules};
use wasm_bindgen::prelude::wasm_bindgen;

/// `[nPkt, x, y, …, nAbstände, d0, d1, …, nLinien, (ax, ay, bx, by)…]`.
fn read_rules(buf: &[f64]) -> Option<SiteRules> {
    let mut r = Reader::new(buf);
    let parcel = r.ring()?;
    let n = r.count()?;
    let mut setbacks = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        setbacks.push(r.num()?);
    }
    let n = r.count()?;
    let mut lines = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        lines.push(BuildingLine { a: [r.num()?, r.num()?], b: [r.num()?, r.num()?] });
    }
    Some(SiteRules { parcel, setbacks, lines })
}

#[wasm_bindgen]
pub fn site_multi_polygon_area(polys: &[f64]) -> f64 {
    site_rules::multi_polygon_area(&decode(polys).unwrap_or_default())
}

#[wasm_bindgen]
pub fn site_allowed_area(rules: &[f64]) -> Vec<f64> {
    encode(&read_rules(rules).map(|r| site_rules::allowed_area(&r)).unwrap_or_default())
}

/// Zulässige Hülle im 3D ([63], `site_rules::envelope3d`) für render3d `set_ghost`:
/// `[nDreieckWerte, Dreiecke (x y z r g b a)…, Kanten (x y z r g b)…]` (Float32); leer bei Fehler.
#[wasm_bindgen]
pub fn doc_site_envelope(h: u32) -> Vec<f32> {
    super::document::with_doc(h, |d| d.project().ok().map(|p| site_rules::envelope3d(&p)))
        .flatten()
        .map(|e| {
            let mut out = Vec::with_capacity(1 + e.tris.len() + e.lines.len());
            out.push(e.tris.len() as f32);
            out.extend(e.tris);
            out.extend(e.lines);
            out
        })
        .unwrap_or_default()
}
