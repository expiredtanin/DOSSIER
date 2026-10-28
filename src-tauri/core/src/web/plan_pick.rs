//! Bindungen der Auswahl (`crate::plan_pick`). Ein Index wird einmal je Plan gebaut
//! (`pick_index_build`, Abschnitte wie `plan_parts`) und bleibt, bis TS ihn freigibt
//! (`pick_index_release`); er hält seine Puffer selbst, Verdrängen im Puffer-Speicher stört ihn
//! nicht. Unbekannter Index oder kaputte Eingabe → leeres Ergebnis bzw. −1, nie Panic.

use crate::plan_pick::{ClientMap, PickIndex};
use std::cell::RefCell;
use wasm_bindgen::prelude::wasm_bindgen;

thread_local! {
    static INDEXES: RefCell<(u32, Vec<(u32, PickIndex)>)> = const { RefCell::new((0, Vec::new())) };
}

fn with<R>(id: u32, f: impl FnOnce(&PickIndex) -> R) -> Option<R> {
    INDEXES.with(|h| h.borrow().1.iter().find(|e| e.0 == id).map(|e| f(&e.1)))
}

/// Index über die Abschnitte `[Puffer-Nr, von, bis, …]` bauen; Nummer ≥ 1, 0 = Fehler (Puffer
/// fehlt oder kaputt — TS legt neu ab und baut nochmals).
#[wasm_bindgen]
pub fn pick_index_build(segs: &[f64]) -> u32 {
    let Some(bufs) = super::plan_buf::held_for_segs(segs) else { return 0 };
    let Some(ix) = PickIndex::build(segs, bufs) else { return 0 };
    INDEXES.with(|h| {
        let mut h = h.borrow_mut();
        h.0 = h.0.wrapping_add(1).max(1);
        let id = h.0;
        h.1.push((id, ix));
        id
    })
}

#[wasm_bindgen]
pub fn pick_index_release(id: u32) {
    INDEXES.with(|h| h.borrow_mut().1.retain(|e| e.0 != id));
}

/// Nächstes 2D-Zeichnungs-Segment als `[Index, Abstand]`, leer ohne Treffer.
#[wasm_bindgen]
pub fn pick_nearest_segment(id: u32, x: f64, y: f64, max_dist: f64) -> Vec<f64> {
    with(id, |ix| ix.nearest_segment(x, y, max_dist)).flatten().map_or(Vec::new(), |(i, d)| vec![i as f64, d])
}

/// Segmente im Umkreis als `[Index, Abstand, …]`, nächste zuerst.
#[wasm_bindgen]
pub fn pick_segments_near(id: u32, x: f64, y: f64, max_dist: f64) -> Vec<f64> {
    with(id, |ix| ix.segments_near(x, y, max_dist).into_iter().flat_map(|(i, d)| [i as f64, d]).collect()).unwrap_or_default()
}

/// Polygone unter dem Punkt (Maske der Pick-Arten, 0 = alle), oberstes zuerst.
#[wasm_bindgen]
pub fn pick_polygons_at(id: u32, x: f64, y: f64, mask: u32) -> Vec<u32> {
    with(id, |ix| ix.polygons_at(x, y, mask as u16)).unwrap_or_default()
}

/// Nächste Symbol-Linie/-Bogen in Client-Pixeln (Abbildung `left+offX, top+offY, view.x,
/// view.y, scale`) oder −1.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn pick_nearest_symbol_px(id: u32, line_mask: u32, arc_mask: u32, left: f64, top: f64, view_x: f64, view_y: f64, scale: f64, cx: f64, cy: f64, max_px: f64) -> f64 {
    let map = ClientMap { left, top, view_x, view_y, scale };
    with(id, |ix| ix.nearest_symbol_px(line_mask as u16, arc_mask as u16, map, cx, cy, max_px)).flatten().map_or(-1.0, |i| i as f64)
}

/// Kreise/Bögen der 2D-Zeichnung nahe am Punkt: `[Index, Abstand px, …]` in Plan-Reihenfolge.
#[wasm_bindgen]
pub fn pick_rings_near(id: u32, x: f64, y: f64, px_per_m: f64, tol_px: f64) -> Vec<f64> {
    with(id, |ix| ix.rings_near(x, y, px_per_m, tol_px).into_iter().flat_map(|(i, d)| [i as f64, d]).collect()).unwrap_or_default()
}

/// Primitive der Ids (jede mit `\0` davor) der Pick-Art `kind`, aufsteigend.
#[wasm_bindgen]
pub fn pick_owned_by(id: u32, kind: u32, ids: &str) -> Vec<u32> {
    let list: Vec<&str> = ids.split('\0').skip(1).collect();
    with(id, |ix| ix.owned_by(kind, &list)).unwrap_or_default()
}
