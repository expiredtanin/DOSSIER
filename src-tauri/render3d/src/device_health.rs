// Zustand des WebGPU-Geraets eines Browser-Renderers (`web.rs`), [206]/[118]: Geraeteverlust sauber behandeln.
//
// Der `device.lost`-Rueckruf von wgpu laeuft im Ereignis-Takt des Browsers (Promise), nie mitten in einer
// `&mut self`-Methode. Er setzt hier NUR Flags; den Renderer fasst er nicht an (sonst „recursive use of an
// object …“). Alle GPU-Methoden fragen `is_lost()` und kehren danach sofort zurueck: auf einem verlorenen Geraet
// wirft z. B. `createBuffer(mappedAtCreation)`, wgpu macht daraus einen Panic/Trap („unreachable“), und das
// wasm-bindgen-Objekt bliebe gesperrt. Den Neuaufbau macht der Aufrufer (TS) ausserhalb, mit Backoff.
//
// Gleiche Datei in `render2d/src/device_health.rs` (die Crates haengen nicht voneinander ab).

use std::sync::atomic::{AtomicBool, Ordering};

/// Geteilt zwischen Renderer und Verlust-Rueckruf (`Arc<DeviceHealth>`; wgpu verlangt `Send`).
#[derive(Debug, Default)]
pub struct DeviceHealth {
    lost: AtomicBool,
    /// Der Renderer wird abgebaut: ein danach gemeldeter Verlust (Grund „Destroyed“ durch unser eigenes
    /// `destroy()`) ist gewollt und wird weder geloggt noch gemeldet.
    retired: AtomicBool,
    /// Bereits gemeldete WebGPU-Fehler (`uncapturederror`), damit ein totes Geraet die Konsole nicht flutet.
    errors: std::sync::atomic::AtomicU32,
}

/// Hoechstens so viele `uncapturederror`-Meldungen je Renderer.
pub const MAX_ERROR_REPORTS: u32 = 3;

impl DeviceHealth {
    pub fn new() -> Self {
        Self::default()
    }

    /// Geraet verloren (aus `device.lost`). `true` = melden (loggen + JS-Rueckruf): nur beim ersten Verlust und
    /// nicht, wenn wir das Geraet beim Abbau selbst zerstoert haben.
    pub fn on_lost(&self) -> bool {
        let first = !self.lost.swap(true, Ordering::SeqCst);
        first && !self.retired.load(Ordering::SeqCst)
    }

    /// true, sobald das Geraet verloren ist (oder der Renderer abgebaut wird): keine GPU-Aufrufe mehr.
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst) || self.retired.load(Ordering::SeqCst)
    }

    /// Abbau beginnt (vor `device.destroy()` im `Drop`).
    pub fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    /// WebGPU-Fehler melden? Nach einem Verlust nie (Folgefehler), sonst die ersten `MAX_ERROR_REPORTS`.
    pub fn should_report_error(&self) -> bool {
        if self.is_lost() {
            return false;
        }
        self.errors.fetch_add(1, Ordering::SeqCst) < MAX_ERROR_REPORTS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verlust_wird_genau_einmal_gemeldet() {
        let h = DeviceHealth::new();
        assert!(!h.is_lost());
        assert!(h.on_lost());
        assert!(h.is_lost());
        assert!(!h.on_lost(), "zweiter Verlust-Rueckruf meldet nichts mehr");
    }

    #[test]
    fn eigener_abbau_ist_still() {
        let h = DeviceHealth::new();
        h.retire();
        assert!(h.is_lost(), "nach dem Abbau keine GPU-Aufrufe mehr");
        assert!(!h.on_lost(), "„Destroyed“ durch unser destroy() wird nicht gemeldet");
    }

    #[test]
    fn fehler_begrenzt_und_nach_verlust_still() {
        let h = DeviceHealth::new();
        let n = (0..10).filter(|_| h.should_report_error()).count();
        assert_eq!(n as u32, MAX_ERROR_REPORTS);
        let h = DeviceHealth::new();
        h.on_lost();
        assert!(!h.should_report_error());
    }
}
