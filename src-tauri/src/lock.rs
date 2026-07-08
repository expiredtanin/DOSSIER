// Lock-Datei gegen gleichzeitiges Öffnen derselben Projektdatei aus zwei
// App-Instanzen. Prinzip: ein OS-Advisory-Lock (Crate `fs4`, gepflegter
// `fs2`-Nachfolger) auf einer Sidecar-Datei `<projektdatei>.lock`, gehalten
// über ein offenes `File`-Handle im Tauri-`State`. Der OS-Lock fällt beim
// Prozessende AUTOMATISCH weg (auch bei Absturz) — kein manuelles Aufräumen
// nötig, keine verwaiste Sperre blockiert dauerhaft: ohne aktiven OS-Lock kann
// die nächste Instanz dieselbe Sidecar-Datei problemlos wieder exklusiv locken,
// auch wenn die Datei selbst liegen bleibt.
//
// Zusätzlich schreiben wir einen kleinen JSON-Info-Block (pid/hostname/
// timestamp) in die Sidecar-Datei, damit eine zweite Instanz bei einem
// Konflikt eine freundliche Meldung zeigen kann ("bereits geöffnet auf …").

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};

/// Info-Block in der Lock-Sidecar-Datei — wer hält den Lock gerade.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockInfo {
    pub pid: u32,
    pub hostname: String,
    /// Unix-Zeitstempel (Sekunden) als String — reicht für eine Anzeige,
    /// keine Notwendigkeit für eine Datumsbibliothek.
    pub timestamp: String,
}

impl LockInfo {
    fn current() -> Self {
        LockInfo {
            pid: std::process::id(),
            hostname: hostname(),
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_else(|_| "0".to_string()),
        }
    }
}

/// Bester-Versuch-Hostname ohne zusätzliche Abhängigkeit: erst Umgebungs-
/// variablen (Windows/Unix), sonst das `hostname`-Kommando, sonst "unbekannt".
fn hostname() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(h) = std::env::var(var) {
            if !h.is_empty() {
                return h;
            }
        }
    }
    if let Ok(out) = std::process::Command::new("hostname").output() {
        if out.status.success() {
            if let Ok(s) = String::from_utf8(out.stdout) {
                let s = s.trim();
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    "unbekannt".to_string()
}

/// Alle von DIESER Instanz gehaltenen Locks: Projektdatei-Pfad → offenes
/// File-Handle auf die Sidecar-Lock-Datei. Das Handle hält den OS-Lock, solange
/// es lebt (Drop/Prozessende gibt ihn automatisch frei).
#[derive(Default)]
pub struct LockState(pub Mutex<HashMap<PathBuf, File>>);

fn sidecar_path(project_path: &Path) -> PathBuf {
    let mut s = project_path.as_os_str().to_os_string();
    s.push(".lock");
    PathBuf::from(s)
}

/// Fordert den exklusiven Lock für `project_path` an.
///
/// - Bereits von UNS gehalten (dieselbe Datei nochmal geöffnet) → `Ok(())`.
/// - Frei → OS-Lock holen, eigenen Info-Block reinschreiben, Handle im State
///   behalten, `Ok(())`.
/// - Von einer ANDEREN Instanz gehalten → `Err(Some(info))` mit deren
///   Info-Block (falls lesbar), sonst `Err(None)`.
pub fn acquire(state: &LockState, project_path: &Path) -> Result<(), Option<LockInfo>> {
    let mut held = state.0.lock().expect("lock state poisoned");

    if held.contains_key(project_path) {
        return Ok(());
    }

    let sidecar = sidecar_path(project_path);
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&sidecar)
        .map_err(|_| None)?;

    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => {
            write_info(&file);
            held.insert(project_path.to_path_buf(), file);
            Ok(())
        }
        Err(_) => {
            // Gesperrt von einer anderen Instanz -> deren Info-Block lesen (best effort).
            Err(read_info(&sidecar))
        }
    }
}

/// Gibt den von uns gehaltenen Lock für `project_path` frei (schliesst das
/// File-Handle → OS-Lock fällt weg). No-op, wenn wir diesen Pfad nicht halten.
pub fn release(state: &LockState, project_path: &Path) {
    let mut held = state.0.lock().expect("lock state poisoned");
    held.remove(project_path);
}

/// Schreibt den aktuellen Info-Block (pid/hostname/timestamp dieser Instanz)
/// in die bereits gelockte Sidecar-Datei. Fehler hier sind nicht fatal — der
/// Lock selbst (das OS-Lock) steht unabhängig davon schon.
fn write_info(file: &File) {
    let info = LockInfo::current();
    let Ok(json) = serde_json::to_string(&info) else {
        return;
    };
    let mut f = file;
    let _ = f.set_len(0);
    let _ = f.seek(SeekFrom::Start(0));
    let _ = f.write_all(json.as_bytes());
    let _ = f.flush();
}

/// Liest den Info-Block aus einer (von einer anderen Instanz gesperrten)
/// Sidecar-Datei. `None` wenn die Datei fehlt/kein gültiges JSON enthält.
fn read_info(sidecar: &Path) -> Option<LockInfo> {
    let mut contents = String::new();
    File::open(sidecar).ok()?.read_to_string(&mut contents).ok()?;
    serde_json::from_str(&contents).ok()
}
