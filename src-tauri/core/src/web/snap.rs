//! Bindungen des Objektfangs ([K4] S3, `crate::snap_model`): die Kandidaten eines Geschosses sammelt
//! der Kern aus dem Dokument (`doc_snap_hold`, gleiche Nummer solange sich die betroffenen Felder
//! nicht ändern); je Mausbewegung `snap_query`. Unbekannte Nummer oder kaputte Eingabe → leeres
//! Ergebnis (TS sammelt dann neu).

use crate::snap::{segs_from, Cand};
use crate::snap_model::{query, ModelQuery, SnapCache};
use super::document::with_doc;
use std::cell::RefCell;
use wasm_bindgen::prelude::wasm_bindgen;

thread_local! {
    static CACHE: RefCell<SnapCache> = RefCell::new(SnapCache::default());
}

/// Kandidaten des Geschosses `level` mit den sichtbaren Ebenen `codes` (durch `\n` getrennt) im
/// Dokument `h`; Nummer ≥ 1 für [`snap_query`] (0 = Dokument nicht offen).
#[wasm_bindgen]
pub fn doc_snap_hold(h: u32, level: &str, codes: &str) -> u32 {
    let codes: Vec<String> = if codes.is_empty() { Vec::new() } else { codes.split('\n').map(str::to_owned).collect() };
    with_doc(h, |d| CACHE.with(|c| c.borrow_mut().hold(h, d, level, &codes))).unwrap_or(0)
}

fn push(out: &mut Vec<f64>, c: Option<Cand>) {
    match c {
        Some(c) => out.extend_from_slice(&[c.x, c.y, c.kind, c.dist_px, c.score]),
        None => out.extend_from_slice(&[f64::NAN; 5]),
    }
}

/// Fang je Mausbewegung über das abgelegte Geschoss `held` plus Entwurfs- und Blatt-Strecken
/// (`[ax, ay, bx, by, …]`). `flags`: `snap::F_*` und `snap_model::F_*`; letzter Punkt NaN = keiner.
/// Ergebnis (25 Zahlen): `[nächste Strecke (1|−1), ax, ay, bx, by]`, dann je Block `[x, y, Art,
/// distPx, Punktzahl]` (NaN = kein Kandidat): A (Lot, Endpunkte), Raum-Anker, B (Mitte, Schnitt,
/// Kante), C (Kreise, Ellipsen). Leer = Nummer unbekannt bzw. kaputte Eingabe.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn snap_query(held: u32, draft: &[f64], sheet: &[f64], rx: f64, ry: f64, tol_m: f64, px_per_m: f64, flags: u32, lx: f64, ly: f64) -> Vec<f64> {
    if draft.len() % 4 != 0 || sheet.len() % 4 != 0 {
        return Vec::new();
    }
    let (draft, sheet) = (segs_from(draft), segs_from(sheet));
    CACHE.with(|c| {
        let c = c.borrow();
        let Some(ls) = c.get(held) else { return Vec::new() };
        let q = ModelQuery {
            draft: &draft,
            sheet: &sheet,
            raw: (rx, ry),
            tol_m,
            px_per_m,
            flags,
            last: (!lx.is_nan() && !ly.is_nan()).then_some((lx, ly)),
        };
        let o = query(ls, &q);
        let mut out = Vec::with_capacity(25);
        match o.dwell {
            Some(s) => out.extend_from_slice(&[1.0, s[0], s[1], s[2], s[3]]),
            None => out.extend_from_slice(&[-1.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN]),
        }
        push(&mut out, o.a);
        push(&mut out, o.anchors);
        push(&mut out, o.b);
        push(&mut out, o.c);
        out
    })
}
