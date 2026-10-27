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

/// `[gültig, Parzelle, zulässig, Verstoss, HöheÜberschritten, …flat(zulässig), …flat(Verstösse)]`;
/// ungültig → `[0]`. `footprint` = Teile der Gebäude-Grundfläche (`flat`), `max_top` NaN = keine.
#[wasm_bindgen]
pub fn site_check(rules: &[f64], footprint: &[f64], max_height: f64, max_top: f64) -> Vec<f64> {
    let (Some(r), Some(fp)) = (read_rules(rules), decode(footprint)) else { return vec![0.0] };
    let Some(c) = site_rules::check_site_rules(&r, &fp, max_height, max_top) else { return vec![0.0] };
    let mut out = vec![1.0, c.parcel_area, c.allowed_area, c.violation_area, if c.height_exceeded { 1.0 } else { 0.0 }];
    out.extend(encode(&c.allowed));
    out.extend(encode(&c.violations));
    out
}
