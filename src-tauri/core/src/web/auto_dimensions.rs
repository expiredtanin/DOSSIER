//! Bindungen der automatischen Aussenbemassung (`crate::auto_dimensions`).

use crate::auto_dimensions::{self, OpeningIn, WallIn};
use crate::flat_read::Reader;
use wasm_bindgen::prelude::wasm_bindgen;

fn read_walls(buf: &[f64]) -> Option<Vec<WallIn>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        out.push(WallIn { start: [r.num()?, r.num()?], end: [r.num()?, r.num()?], thickness: r.num()? });
    }
    Some(out)
}

fn read_openings(buf: &[f64]) -> Option<Vec<OpeningIn>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let wall = r.count()?;
        out.push(OpeningIn { wall, jamb_start: [r.num()?, r.num()?], jamb_end: [r.num()?, r.num()?] });
    }
    Some(out)
}

/// Wände `[n, (x0, y0, x1, y1, dicke)…]`, Öffnungen `[n, (wandIndex, ax, ay, bx, by)…]`
/// → `[n, (seite, kette, abstand, nPkt, x, y, …)…]` (Seite 0..3 = Süd/Ost/Nord/West,
/// Kette 0..2 = Öffnungen/Vor-Rücksprünge/Gesamt).
#[wasm_bindgen]
pub fn autodim_chains(walls: &[f64], openings: &[f64], scale_denominator: f64) -> Vec<f64> {
    let (Some(w), Some(o)) = (read_walls(walls), read_openings(openings)) else { return vec![0.0] };
    let chains = auto_dimensions::auto_exterior_dimensions(&w, &o, scale_denominator);
    let mut out = vec![chains.len() as f64];
    for c in chains {
        out.extend([c.side as f64, c.chain as f64, c.offset, c.pts.len() as f64]);
        out.extend(c.pts.into_iter().flatten());
    }
    out
}
