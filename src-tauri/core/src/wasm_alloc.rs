//! Heap-Wachstum im WASM ([K4], erstes Öffnen grosser Dokumente): der Standard-Allokator
//! (dlmalloc) holt neuen Speicher mit `memory.grow` nur so gross wie die gerade fehlende
//! Anforderung (64 KiB-Schritte). Jedes `memory.grow` kostet in V8 aber ~0,3–0,7 ms — beim
//! Einlesen eines Projekts mit 200 000 Zeichnungen (~1,5 GB Baum) waren das ~20 000 Aufrufe und
//! ~7 der ~10 s. Diese Hülle reserviert nach jedem Wachstum zusätzlich einen Vorrat
//! ([`headroom`], ein Viertel des Speichers, 8–256 MiB): sie fordert ihn einmal an und gibt ihn
//! sofort zurück — der Block liegt am Ende des Heaps und verschmilzt mit dessen freiem Rest, die
//! folgenden Anforderungen kommen ohne `memory.grow` aus. Der Speicher wächst so in wenigen
//! grossen Schritten; mehr als der Vorrat bleibt nicht ungenutzt.

/// Vorrat nach einem Wachstum auf `total` Bytes: ein Viertel, mindestens 8 MiB, höchstens 256 MiB.
pub fn headroom(total: usize) -> usize {
    (total / 4).clamp(8 << 20, 256 << 20)
}

#[cfg(all(target_arch = "wasm32", feature = "web"))]
mod imp {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::arch::wasm32::memory_size;

    const PAGE: usize = 65536;

    pub struct GrowAhead;

    impl GrowAhead {
        /// Nach einem Wachstum (Seitenzahl gestiegen) den Vorrat anlegen und gleich freigeben.
        #[inline]
        unsafe fn after(&self, before: usize) {
            let now = memory_size(0);
            if now == before {
                return;
            }
            if let Ok(l) = Layout::from_size_align(super::headroom(now * PAGE), 16) {
                let q = System.alloc(l);
                if !q.is_null() {
                    System.dealloc(q, l);
                }
            }
        }
    }

    unsafe impl GlobalAlloc for GrowAhead {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let before = memory_size(0);
            let p = System.alloc(l);
            self.after(before);
            p
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            let before = memory_size(0);
            let p = System.alloc_zeroed(l);
            self.after(before);
            p
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            System.dealloc(p, l)
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
            let before = memory_size(0);
            let q = System.realloc(p, l, n);
            self.after(before);
            q
        }
    }

    #[global_allocator]
    static ALLOC: GrowAhead = GrowAhead;
}

#[cfg(test)]
mod tests {
    use super::headroom;

    #[test]
    fn vorrat_ein_viertel_mit_grenzen() {
        assert_eq!(headroom(0), 8 << 20);
        assert_eq!(headroom(100 << 20), 25 << 20);
        assert_eq!(headroom(4 << 30), 256 << 20);
    }
}
