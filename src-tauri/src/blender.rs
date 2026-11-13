// Blender als eigener Prozess ([211], Rendering mit Blender/Cycles): suchen, starten, Ausgabe zeilenweise melden,
// abbrechen. Blender ist GPL und bleibt ein fremdes Programm — Dossier ruft nur die Programmdatei auf.
//
// Nur `std`, damit die Logik ohne Tauri-Toolchain testbar ist (`rustc --test src/blender.rs`); die Tauri-Befehle
// (`blender_find`, `blender_job_dir`, `blender_start`, `blender_cancel`, `blender_open`) stehen in `lib.rs` und leiten Ereignisse
// `blender://line` / `blender://exit` an die Webview. Die Dateien des Pakets schreibt die Webview über das
// fs-Plugin in den Ordner von `blender_job_dir` (Berechtigung `$TEMP/dossier-render/**`, `capabilities/default.json`).

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Übliche Orte (macOS-App, Linux-Pakete), nach `blender` im PATH.
pub const CANDIDATES: &[&str] = &[
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/usr/bin/blender",
    "/usr/local/bin/blender",
    "/snap/bin/blender",
    "/var/lib/flatpak/exports/bin/org.blender.Blender",
];

/// Blender-Programmdatei: eigene Angabe (Einstellungen), dann `blender` im PATH, dann die üblichen Orte.
/// Ist die eigene Angabe eine macOS-`.app`, gilt `Contents/MacOS/Blender` darin.
pub fn find(custom: Option<&str>, path_var: Option<&OsStr>, candidates: &[&str]) -> Option<PathBuf> {
    if let Some(c) = custom.map(str::trim).filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
        let inner = p.join("Contents/MacOS/Blender");
        if inner.is_file() {
            return Some(inner);
        }
        return None;
    }
    if let Some(var) = path_var {
        for dir in std::env::split_paths(var) {
            for name in ["blender", "blender.exe"] {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    candidates.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Nur Programme, die nach Blender heissen: die Webview darf über diesen Weg nichts anderes starten.
pub fn looks_like_blender(exe: &Path) -> bool {
    exe.is_file()
        && exe
            .file_name()
            .and_then(OsStr::to_str)
            .map(|n| n.to_ascii_lowercase().contains("blender"))
            .unwrap_or(false)
}

/// Arbeitsordner für ein Rendering: `<temp>/dossier-render/<zeit>-<nr>`.
pub fn job_dir() -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir()
        .join("dossier-render")
        .join(format!("{stamp}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Laufende Aufträge (Kennung → Prozess), um sie abbrechen zu können.
#[derive(Default)]
pub struct Jobs(Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>);

/// Zerlegt einen Byte-Strom in Zeilen (Ende bei `\n` oder `\r`: Blender überschreibt Fortschrittszeilen).
fn pump_lines<R: Read>(mut r: R, on_line: impl Fn(String)) {
    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = Vec::new();
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !line.is_empty() {
                    on_line(String::from_utf8_lossy(&line).into_owned());
                    line.clear();
                }
            } else {
                line.push(b);
            }
        }
    }
    if !line.is_empty() {
        on_line(String::from_utf8_lossy(&line).into_owned());
    }
}

/// Startet `exe args…`; `on_line` bekommt stdout und stderr zeilenweise, `on_exit` den Exit-Code (-1 bei Abbruch/Signal).
pub fn start(
    jobs: &Jobs,
    id: &str,
    exe: &Path,
    args: &[String],
    on_line: impl Fn(String) + Send + Sync + 'static,
    on_exit: impl FnOnce(i32) + Send + 'static,
) -> Result<(), String> {
    if !looks_like_blender(exe) {
        return Err(format!("keine Blender-Programmdatei: {}", exe.display()));
    }
    let mut child = Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Blender lässt sich nicht starten: {e}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    jobs.0.lock().map_err(|e| e.to_string())?.insert(id.to_string(), child.clone());

    let on_line = Arc::new(on_line);
    // Die Leser melden ihr Ende; nach dem Exit wartet der Wächter nur kurz darauf (ein Kindprozess von Blender
    // kann die Rohre länger offen halten).
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let mut readers = 0;
    if let Some(o) = out {
        let (f, tx) = (on_line.clone(), done_tx.clone());
        readers += 1;
        std::thread::spawn(move || {
            pump_lines(o, |l| f(l));
            let _ = tx.send(());
        });
    }
    if let Some(e) = err {
        let (f, tx) = (on_line.clone(), done_tx.clone());
        readers += 1;
        std::thread::spawn(move || {
            pump_lines(e, |l| f(l));
            let _ = tx.send(());
        });
    }
    let table = jobs.0.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        let code = loop {
            let status = child.lock().ok().and_then(|mut c| c.try_wait().ok().flatten());
            if let Some(s) = status {
                break s.code().unwrap_or(-1);
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        for _ in 0..readers {
            if done_rx.recv_timeout(Duration::from_secs(2)).is_err() {
                break;
            }
        }
        if let Ok(mut t) = table.lock() {
            t.remove(&id);
        }
        on_exit(code);
    });
    Ok(())
}

/// [228] Startet Blender MIT Oberfläche (z. B. auf eine .blend-Datei) und wartet nicht: ein eigener Prozess, den die App
/// nicht überwacht (Ausgabe verworfen). Ein Wächter-Thread holt den Exit-Status ab, damit kein Zombie bleibt. Nur Programme, die
/// nach Blender heissen (wie {@link start}); wirft der Start, kommt die Meldung zurück.
pub fn open(exe: &Path, args: &[String]) -> Result<(), String> {
    if !looks_like_blender(exe) {
        return Err(format!("keine Blender-Programmdatei: {}", exe.display()));
    }
    let mut child = Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Blender lässt sich nicht starten: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Bricht einen Auftrag ab (Prozess beenden). Unbekannte Kennung: nichts.
pub fn cancel(jobs: &Jobs, id: &str) {
    let child = jobs.0.lock().ok().and_then(|mut t| t.remove(id));
    if let Some(c) = child {
        if let Ok(mut c) = c.lock() {
            let _ = c.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dossier-blender-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn findet_eigene_angabe_vor_path() {
        let d = tmp("eigen");
        let exe = d.join("Blender");
        std::fs::write(&exe, "").unwrap();
        assert_eq!(find(Some(exe.to_str().unwrap()), None, &[]), Some(exe.clone()));
        assert_eq!(find(Some(d.join("fehlt").to_str().unwrap()), None, &[exe.to_str().unwrap()]), None);
    }

    #[test]
    fn app_buendel_wird_zur_programmdatei() {
        let d = tmp("app");
        let inner = d.join("Blender.app/Contents/MacOS");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("Blender"), "").unwrap();
        assert_eq!(find(Some(d.join("Blender.app").to_str().unwrap()), None, &[]), Some(inner.join("Blender")));
    }

    #[test]
    fn sucht_im_path_dann_in_den_ueblichen_orten() {
        let d = tmp("path");
        std::fs::write(d.join("blender"), "").unwrap();
        let var = std::env::join_paths([d.clone()]).unwrap();
        assert_eq!(find(None, Some(&var), &[]), Some(d.join("blender")));
        let e = tmp("kandidat");
        std::fs::write(e.join("Blender"), "").unwrap();
        assert_eq!(find(None, None, &[e.join("Blender").to_str().unwrap()]), Some(e.join("Blender")));
        assert_eq!(find(None, None, &["/gibt/es/nicht"]), None);
    }

    #[test]
    fn startet_nur_programme_namens_blender() {
        let d = tmp("name");
        let other = d.join("python");
        std::fs::write(&other, "").unwrap();
        assert!(!looks_like_blender(&other));
        let jobs = Jobs::default();
        assert!(start(&jobs, "x", &other, &[], |_| {}, |_| {}).is_err());
    }

    #[test]
    fn zeilen_bei_cr_und_lf() {
        let lines = std::cell::RefCell::new(Vec::new());
        pump_lines(&b"Sample 1/4\rSample 2/4\r\nDOSSIER_DONE x\nrest"[..], |l| lines.borrow_mut().push(l));
        assert_eq!(*lines.borrow(), vec!["Sample 1/4", "Sample 2/4", "DOSSIER_DONE x", "rest"]);
    }

    #[test]
    fn oeffnen_nur_blender() {
        let d = tmp("oeffnen-name");
        let other = d.join("python");
        std::fs::write(&other, "").unwrap();
        assert!(open(&other, &[]).is_err());
        assert!(open(&d.join("blender-gibt-es-nicht"), &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn oeffnen_startet_ohne_zu_warten_mit_den_argumenten() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("oeffnen");
        let exe = d.join("blender");
        let seen = d.join("args.txt");
        std::fs::write(&exe, format!("#!/bin/sh\necho \"$@\" > \"{}\"\nsleep 3\n", seen.display())).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t0 = std::time::Instant::now();
        open(&exe, &["/tmp/x/dossier.blend".to_string()]).unwrap();
        assert!(t0.elapsed() < Duration::from_secs(2), "open darf nicht auf das Ende warten");
        for _ in 0..100 {
            if seen.is_file() && std::fs::read_to_string(&seen).map(|t| !t.is_empty()).unwrap_or(false) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(std::fs::read_to_string(&seen).unwrap().trim(), "/tmp/x/dossier.blend");
    }

    #[cfg(unix)]
    #[test]
    fn startet_meldet_zeilen_und_exit_und_bricht_ab() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("lauf");
        let exe = d.join("blender");
        std::fs::write(&exe, "#!/bin/sh\necho \"Sample 1/2\"\necho fehler 1>&2\nif [ \"$1\" = \"slow\" ]; then sleep 30; fi\nexit 3\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let jobs = Jobs::default();
        let (tx, rx) = mpsc::channel::<String>();
        let (tx2, rx2) = mpsc::channel::<i32>();
        let tx = Mutex::new(tx);
        start(&jobs, "a", &exe, &[], move |l| { let _ = tx.lock().unwrap().send(l); }, move |c| { let _ = tx2.send(c); }).unwrap();
        assert_eq!(rx2.recv_timeout(Duration::from_secs(10)).unwrap(), 3);
        let mut got: Vec<String> = rx.try_iter().collect();
        got.sort();
        assert_eq!(got, vec!["Sample 1/2", "fehler"]);

        let (tx3, rx3) = mpsc::channel::<i32>();
        start(&jobs, "b", &exe, &["slow".to_string()], |_| {}, move |c| { let _ = tx3.send(c); }).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        cancel(&jobs, "b");
        assert_eq!(rx3.recv_timeout(Duration::from_secs(10)).unwrap(), -1);
    }
}
