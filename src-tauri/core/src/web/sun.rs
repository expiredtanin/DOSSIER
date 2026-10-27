//! Bindungen von Sonnenstand und Schatten (`crate::sun`).

use crate::flat_read::pairs;
use crate::flat::{decode, encode};
use crate::flat_read::Reader;
use crate::sun::{self, Prism, SunPosition};
use wasm_bindgen::prelude::wasm_bindgen;

/// `[azimut, höhe]` in Grad.
#[wasm_bindgen]
pub fn sun_position(lat: f64, lon: f64, unix_ms: f64) -> Vec<f64> {
    let s = sun::sun_position(lat, lon, unix_ms);
    vec![s.azimuth, s.elevation]
}

/// Grundriss als `[x0, y0, x1, y1, …]` → Schatten-Ring im selben Format.
#[wasm_bindgen]
pub fn sun_shadow_of_prism(footprint: &[f64], z_bottom: f64, z_top: f64, azimuth: f64, elevation: f64) -> Vec<f64> {
    let r = sun::shadow_of_prism(&pairs(footprint), z_bottom, z_top, SunPosition { azimuth, elevation });
    r.into_iter().flatten().collect()
}

fn read_prisms(buf: &[f64]) -> Option<Vec<Prism>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let (z_bottom, z_top) = (r.num()?, r.num()?);
        out.push(Prism { footprint: r.ring()?, z_bottom, z_top });
    }
    Some(out)
}

fn read_clouds(buf: &[f64]) -> Option<Vec<Vec<[f64; 3]>>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let k = r.count()?;
        out.push(r.points3(k)?);
    }
    Some(out)
}

/// Prismen `[n, (zUnten, zOben, nPkt, x, y, …)…]` und Punktwolken `[n, (nPkt, x, y, z, …)…]`
/// → vereinigter Schatten (Polygone, `flat`-Kodierung).
#[wasm_bindgen]
pub fn sun_shadow_union(prisms: &[f64], clouds: &[f64], azimuth: f64, elevation: f64) -> Vec<f64> {
    let (Some(p), Some(c)) = (read_prisms(prisms), read_clouds(clouds)) else { return encode(&[]) };
    encode(&sun::shadow_union(&p, &c, SunPosition { azimuth, elevation }))
}

/// Ein Polygon (`flat`, erstes Polygon zählt) → lochfreie Teile (`flat`, je ein Ring).
#[wasm_bindgen]
pub fn sun_without_holes(poly: &[f64]) -> Vec<f64> {
    let Some(first) = decode(poly).and_then(|p| p.into_iter().next()) else { return encode(&[]) };
    let parts: Vec<_> = sun::without_holes(&first).into_iter().map(|r| vec![r]).collect();
    encode(&parts)
}
