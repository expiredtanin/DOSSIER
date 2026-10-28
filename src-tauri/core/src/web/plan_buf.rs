//! Bindungen des Plan-Puffers (`crate::plan_buf`). Format s. dort.
//!
//! Gehaltene Puffer: TS übergibt einen Plan-Puffer einmal (`plan_buf_hold`) und kompiliert danach
//! beliebig viele GPU-Chunks daraus (`gpu_compile_held`), ohne ihn je Chunk erneut zu kopieren.
//! Höchstens `MAX_HELD` Puffer bzw. `MAX_HELD_BYTES` bleiben liegen (ältester fällt weg);
//! ein verdrängter Puffer liefert leere Ergebnisse, TS übergibt ihn dann neu.

use std::cell::RefCell;
use wasm_bindgen::prelude::wasm_bindgen;

const MAX_HELD: usize = 8;
const MAX_HELD_BYTES: usize = 96 << 20;

thread_local! {
    static HELD: RefCell<(u32, Vec<(u32, Vec<u8>)>)> = const { RefCell::new((0, Vec::new())) };
}

/// Plan-Puffer lesen und neu schreiben (Hin-und-zurück-Prüfung der TS-Kodierung); leer bei
/// fremder Version oder kaputtem Puffer.
#[wasm_bindgen]
pub fn plan_buf_recode(buf: &[u8]) -> Vec<u8> {
    crate::plan_buf::recode(buf)
}

/// Puffer im Kern halten; Ergebnis ist die Nummer (≥ 1), 0 bei unlesbarem Puffer.
#[wasm_bindgen]
pub fn plan_buf_hold(buf: &[u8]) -> u32 {
    if crate::plan_buf::View::parse(buf).is_none() {
        return 0;
    }
    HELD.with(|h| {
        let mut h = h.borrow_mut();
        h.0 = h.0.wrapping_add(1).max(1);
        let id = h.0;
        h.1.push((id, buf.to_vec()));
        let mut bytes: usize = h.1.iter().map(|e| e.1.len()).sum();
        while h.1.len() > MAX_HELD || (bytes > MAX_HELD_BYTES && h.1.len() > 1) {
            bytes -= h.1.remove(0).1.len();
        }
        id
    })
}

/// Gehaltenen Puffer freigeben (unbekannte Nummer: nichts).
#[wasm_bindgen]
pub fn plan_buf_release(id: u32) {
    HELD.with(|h| h.borrow_mut().1.retain(|e| e.0 != id));
}

/// Mit dem gehaltenen Puffer `id` rechnen; `None`, wenn er nicht (mehr) da ist.
pub(crate) fn with_held<R>(id: u32, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
    HELD.with(|h| h.borrow().1.iter().find(|e| e.0 == id).map(|e| f(&e.1)))
}
