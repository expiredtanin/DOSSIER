//! Bindungen des Objektfangs (`crate::snap`). Die Fang-Strecken eines Projekt-Geschosses legt TS
//! einmal ab (`snap_segs_hold`) und gibt sie frei, wenn es sie ersetzt (`snap_segs_release`).
//! Je Mausbewegung `snap_eval`; unbekannte Nummer oder kaputte Eingabe → leeres Ergebnis.

use crate::snap::{segs_from, snap_segments, Cand, SnapQuery, SnapSet};
use std::cell::RefCell;
use wasm_bindgen::prelude::wasm_bindgen;

thread_local! {
    static SETS: RefCell<(u32, Vec<(u32, SnapSet)>)> = const { RefCell::new((0, Vec::new())) };
}

/// Strecken `[ax, ay, bx, by, …]` ablegen; Nummer ≥ 1 (0 = kaputte Eingabe).
#[wasm_bindgen]
pub fn snap_segs_hold(flat: &[f64]) -> u32 {
    if flat.len() % 4 != 0 {
        return 0;
    }
    SETS.with(|h| {
        let mut h = h.borrow_mut();
        h.0 = h.0.wrapping_add(1).max(1);
        let id = h.0;
        h.1.push((id, SnapSet::new(segs_from(flat))));
        id
    })
}

#[wasm_bindgen]
pub fn snap_segs_release(id: u32) {
    SETS.with(|h| h.borrow_mut().1.retain(|e| e.0 != id));
}

fn push(out: &mut Vec<f64>, c: Option<Cand>) {
    match c {
        Some(c) => out.extend_from_slice(&[c.x, c.y, c.kind, c.dist_px, c.score]),
        None => out.extend_from_slice(&[f64::NAN; 5]),
    }
}

/// Fang über abgelegte (`held`, 0 = keine) + Zusatz-Strecken. `int_mode` 1: Schnittpunkte nur
/// aus `int_segs`, sonst aus denselben Strecken. `flags` s. `snap::F_*`; letzter Punkt NaN =
/// keiner. Ergebnis: `[nächste Strecke (−1), ax, ay, bx, by, Block A (x, y, Art, distPx,
/// Punktzahl), Block B (…)]` (NaN = kein Kandidat); leer = Fehler (Nummer unbekannt).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn snap_eval(held: u32, extra: &[f64], int_mode: u32, int_segs: &[f64], rx: f64, ry: f64, tol_m: f64, px_per_m: f64, flags: u32, lx: f64, ly: f64) -> Vec<f64> {
    if extra.len() % 4 != 0 || int_segs.len() % 4 != 0 {
        return Vec::new();
    }
    let extra = segs_from(extra);
    let ints = segs_from(int_segs);
    let run = |base: &SnapSet| -> Vec<f64> {
        let q = SnapQuery {
            base,
            extra: &extra,
            int_segs: (int_mode == 1).then_some(&ints[..]),
            raw: (rx, ry),
            tol_m,
            px_per_m,
            flags,
            last: (!lx.is_nan() && !ly.is_nan()).then_some((lx, ly)),
        };
        let o = snap_segments(&q);
        let mut out = Vec::with_capacity(15);
        match o.dwell {
            Some(i) => {
                let s = if i < base.segs.len() { base.segs[i] } else { extra[i - base.segs.len()] };
                out.extend_from_slice(&[i as f64, s[0], s[1], s[2], s[3]]);
            }
            None => out.extend_from_slice(&[-1.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN]),
        }
        push(&mut out, o.a);
        push(&mut out, o.b);
        out
    };
    if held == 0 {
        return run(&SnapSet::default());
    }
    SETS.with(|h| h.borrow().1.iter().find(|e| e.0 == held).map(|e| run(&e.1))).unwrap_or_default()
}
