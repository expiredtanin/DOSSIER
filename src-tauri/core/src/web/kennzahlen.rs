//! Bindungen der Kennzahlen-Rechenteile (`crate::kennzahlen`).

use crate::flat_read::pairs;
use crate::flat_read::Reader;
use crate::kennzahlen::{self, RoomIn, SolidIn};
use wasm_bindgen::prelude::wasm_bindgen;

/// Grundriss `[x0, y0, …]`, Kreisradius (NaN = kein Kreis), Höhe, Verjüngung → m³.
#[wasm_bindgen]
pub fn kz_solid_volume(points: &[f64], circle_r: f64, height: f64, taper: f64) -> f64 {
    kennzahlen::solid_volume(&pairs(points), circle_r, height, taper)
}

fn read_rooms(buf: &[f64]) -> Option<Vec<RoomIn>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let (level, category) = (r.count()?, r.count()?);
        out.push(RoomIn { level, category, boundary: r.ring()? });
    }
    Some(out)
}

fn read_solids(buf: &[f64]) -> Option<Vec<SolidIn>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let subtract = r.num()? != 0.0;
        let (circle_r, height, taper) = (r.num()?, r.num()?, r.num()?);
        out.push(SolidIn { subtract, points: r.ring()?, circle_r, height, taper });
    }
    Some(out)
}

/// Räume `[n, (geschoss, kategorie, nPkt, x, y, …)…]`, Körper
/// `[n, (abzug 0/1, radius|NaN, höhe, verjüngung, nPkt, x, y, …)…]`, Parzellenzahl, Parzellenring
/// `[x0, y0, …]` → `[gv, parzelle|NaN, (6 Kategorie-Summen je Geschoss)…]`.
#[wasm_bindgen]
pub fn kz_area_sums(n_levels: u32, rooms: &[f64], solids: &[f64], parcel_area: f64, parcel_ring: &[f64]) -> Vec<f64> {
    let rooms = read_rooms(rooms).unwrap_or_default();
    let solids = read_solids(solids).unwrap_or_default();
    let s = kennzahlen::area_sums(n_levels.min(1 << 16) as usize, &rooms, &solids, parcel_area, &pairs(parcel_ring));
    let mut out = vec![s.gv, s.parcel.unwrap_or(f64::NAN)];
    for l in s.by_level {
        out.extend(l);
    }
    out
}
