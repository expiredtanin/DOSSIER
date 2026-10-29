//! Bindungen des Plan-Puffers (`crate::plan_buf`). Format s. dort.
//!
//! Gehaltene Puffer: TS übergibt einen Plan-Puffer einmal (`plan_buf_hold`) und kompiliert danach
//! beliebig viele GPU-Chunks daraus (`gpu_compile_held`), ohne ihn je Chunk erneut zu kopieren.
//! Höchstens `MAX_HELD` Puffer bzw. `MAX_HELD_BYTES` bleiben liegen (ältester fällt weg);
//! ein verdrängter Puffer liefert leere Ergebnisse, TS übergibt ihn dann neu. Die Puffer eines Plans
//! (bei 2D-Zeichnungen viele Stücke, s. `plan/cache.rs`) legt TS in einer Runde ab
//! (`plan_buf_round_begin` … `plan_buf_round_end`): was in der Runde abgelegt oder berührt wird,
//! fällt in ihr nicht weg.

use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::wasm_bindgen;

const MAX_HELD: usize = 4096;
const MAX_HELD_BYTES: usize = 256 << 20;

/// Gehaltene Puffer: (Nummer, Bytes, Runde der letzten Berührung).
struct Held {
    next: u32,
    list: Vec<(u32, Rc<[u8]>, u64)>,
    round: u64,
    /// Runde offen: ihre Puffer fallen nicht weg.
    pinned: bool,
}

thread_local! {
    static HELD: RefCell<Held> = const { RefCell::new(Held { next: 0, list: Vec::new(), round: 0, pinned: false }) };
}

/// Älteste Puffer verdrängen, bis die Grenzen eingehalten sind (nicht die der offenen Runde, immer
/// mindestens einen behalten).
fn evict(h: &mut Held) {
    let mut bytes: usize = h.list.iter().map(|e| e.1.len()).sum();
    while h.list.len() > MAX_HELD || (bytes > MAX_HELD_BYTES && h.list.len() > 1) {
        let Some(i) = h.list.iter().position(|e| !(h.pinned && e.2 == h.round)) else { break };
        if h.list.len() == 1 {
            break;
        }
        bytes -= h.list.remove(i).1.len();
    }
}

/// Beginn einer Runde (die Puffer eines Plans ablegen, s. Modulkopf).
#[wasm_bindgen]
pub fn plan_buf_round_begin() {
    HELD.with(|h| {
        let mut h = h.borrow_mut();
        h.round += 1;
        h.pinned = true;
    });
}

/// Ende der Runde; danach gelten die Grenzen wieder für alle.
#[wasm_bindgen]
pub fn plan_buf_round_end() {
    HELD.with(|h| {
        let mut h = h.borrow_mut();
        h.pinned = false;
        evict(&mut h);
    });
}

/// Puffer `id` berühren (zuletzt benutzt, in der offenen Runde geschützt); `false`, wenn er nicht
/// (mehr) gehalten ist.
#[wasm_bindgen]
pub fn plan_buf_touch(id: u32) -> bool {
    HELD.with(|h| {
        let mut h = h.borrow_mut();
        let round = h.round;
        let Some(i) = h.list.iter().position(|e| e.0 == id) else { return false };
        let mut e = h.list.remove(i);
        e.2 = round;
        h.list.push(e);
        true
    })
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
        h.next = h.next.wrapping_add(1).max(1);
        let id = h.next;
        let round = h.round;
        h.list.push((id, Rc::from(buf), round));
        evict(&mut h);
        id
    })
}

/// Gehaltenen Puffer freigeben (unbekannte Nummer: nichts).
#[wasm_bindgen]
pub fn plan_buf_release(id: u32) {
    HELD.with(|h| h.borrow_mut().list.retain(|e| e.0 != id));
}

/// Mit dem gehaltenen Puffer `id` rechnen; `None`, wenn er nicht (mehr) da ist.
pub(crate) fn with_held<R>(id: u32, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
    HELD.with(|h| h.borrow().list.iter().find(|e| e.0 == id).map(|e| f(&e.1)))
}

/// Gehaltenen Puffer `id` teilen (bleibt am Leben, auch wenn er verdrängt wird); `None`, wenn er
/// nicht (mehr) da ist.
pub(crate) fn held_rc(id: u32) -> Option<Rc<[u8]>> {
    HELD.with(|h| h.borrow().list.iter().find(|e| e.0 == id).map(|e| e.1.clone()))
}

/// Die Puffer der Abschnitte `[nr, von, bis, …]` (s. `plan_parts`) in Abschnitts-Reihenfolge;
/// `None`, wenn einer fehlt oder die Liste kaputt ist.
pub(crate) fn held_for_segs(segs: &[f64]) -> Option<Vec<(u32, Rc<[u8]>)>> {
    if segs.len() % 3 != 0 {
        return None;
    }
    let mut out: Vec<(u32, Rc<[u8]>)> = Vec::new();
    for s in segs.chunks_exact(3) {
        let nr = crate::plan_buf::whole(s[0])? as u32;
        if !out.iter().any(|e| e.0 == nr) {
            out.push((nr, held_rc(nr)?));
        }
    }
    Some(out)
}

/// Ist der Puffer `id` noch gehalten?
#[wasm_bindgen]
pub fn plan_buf_is_held(id: u32) -> bool {
    HELD.with(|h| h.borrow().list.iter().any(|e| e.0 == id))
}
