// Mitgeliefertes Cycles als eigener Prozess ([215], Endbilder): Programm finden, Argumente prüfen. Gegenstück zu
// scripts/electron-cycles.cjs (Electron/Linux); die Renderer-Seite ist src/native/cyclesRuntime.ts.
//
// Nur `std`, damit die Logik ohne Tauri-Toolchain testbar ist (`rustc --test src/cycles.rs`). Die Tauri-Befehle
// (`cycles_where`, `cycles_job_dir`, `cycles_start`, `cycles_cancel`) stehen in `lib.rs`, starten über
// `blender::start_program` (Job-Verwaltung, Ereignisse `cycles://line` / `cycles://exit`) und rufen NUR das Programm auf, das
// diese Funktionen liefern: der Sidecar `cycles-render` ([`SIDECAR`]) neben dem App-Programm (`bundle.externalBin`, macOS: `Contents/MacOS/cycles-render`).
// Sicherheit: keine Shell; feste Schalter mit Wertebereich; Dateien nur im Arbeitsordner `<temp>/dossier-render/…`.
// Cycles ist Apache-2.0; Herkunft und Lizenzen: NOTICE, `Resources/cycles/licenses/`.

use std::path::{Component, Path, PathBuf};

/// Name des Sidecars im App-Paket (`bundle.externalBin: binaries/cycles-render`). Nicht `cycles`: beim Bau liegen Programm
/// und Ressourcenordner `cycles/` (lib, source, licenses) im selben Ordner, ein gleichnamiges Programm bricht den Bau.
pub const SIDECAR: &str = "cycles-render";

/// Programmdatei: Entwicklung (`dev_dir`, aus `DOSSIER_CYCLES_DIR`, nur in Debug-Builds) vor dem Sidecar neben dem App-Programm.
pub fn find_exe(sidecar_dir: &Path, dev_dir: Option<&Path>) -> Option<PathBuf> {
    let candidates = dev_dir.map(|d| d.join("cycles")).into_iter().chain(std::iter::once(sidecar_dir.join(SIDECAR)));
    candidates.into_iter().find(|p| p.is_file())
}

/// Metal-Kernel-Quellen im Paket (Ressource `cycles/source`); Cycles liest sie über `CYCLES_KERNEL_PATH`.
pub fn kernel_source_dir(resource_dir: &Path) -> Option<PathBuf> {
    let p = resource_dir.join("cycles").join("source");
    p.is_dir().then_some(p)
}

/// Pfad ohne `.`/`..` lexikalisch (ohne Dateisystem); `None`, wenn er über die Wurzel hinaus nach oben ginge.
fn normalize(p: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// Datei im Arbeitsordner: relativ zu `scene_dir` oder absolut darin.
fn inside(scene_dir: &Path, p: &str) -> Option<PathBuf> {
    let abs = normalize(&scene_dir.join(p))?;
    (abs.starts_with(scene_dir) && abs != scene_dir).then_some(abs)
}

fn int_in(v: &str, min: u32, max: u32) -> bool {
    v.len() <= 6 && !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) && v.parse::<u32>().map(|n| n >= min && n <= max).unwrap_or(false)
}

fn device_ok(v: &str) -> bool {
    let parts: Vec<&str> = v.split('+').collect();
    parts.len() <= 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 24 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

fn ext_is(p: &Path, exts: &[&str]) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| exts.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// Prüft die Kommandozeile für Cycles (dieselben Regeln wie `validateCyclesArgs` in electron-cycles.cjs): nur bekannte Schalter
/// mit Wertebereich und genau EINE Szenendatei `*.xml`, Pfade relativ zum Arbeitsordner. `render_root` = `<temp>/dossier-render`.
/// Gibt die Argumente mit aufgelösten Pfaden zurück.
pub fn validate_args(scene_dir: &Path, render_root: &Path, args: &[String]) -> Result<Vec<String>, String> {
    let scene_dir = normalize(scene_dir).ok_or("ungültiger Arbeitsordner")?;
    let render_root = normalize(render_root).ok_or("ungültiger Arbeitsroot")?;
    if !(scene_dir.starts_with(&render_root) && scene_dir != render_root) {
        return Err("Arbeitsordner liegt nicht in dossier-render".into());
    }
    if args.len() > 40 || args.iter().any(|a| a.len() > 4096 || a.contains('\0')) {
        return Err("ungültige Argumente".into());
    }
    let mut out = Vec::new();
    let mut scene: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--background" | "--quiet" => out.push(a.clone()),
            "--samples" | "--width" | "--height" | "--tile-size" | "--threads" | "--device" | "--log-level" | "--output" => {
                let v = it.next().ok_or_else(|| format!("{a}: Wert fehlt"))?;
                let ok = match a.as_str() {
                    "--samples" => int_in(v, 1, 100_000),
                    "--width" | "--height" => int_in(v, 1, 16_384),
                    "--tile-size" => int_in(v, 8, 8_192),
                    "--threads" => int_in(v, 0, 512),
                    "--device" => device_ok(v),
                    "--log-level" => ["fatal", "error", "warning", "info", "stats", "debug"].contains(&v.as_str()),
                    _ => true,
                };
                if !ok {
                    return Err(format!("{a}: ungültiger Wert: {v}"));
                }
                if a == "--output" {
                    let abs = inside(&scene_dir, v).filter(|p| ext_is(p, &["png", "exr", "jpg", "jpeg", "tif", "tiff"]));
                    out.push(a.clone());
                    out.push(abs.ok_or_else(|| format!("{a}: Datei ausserhalb des Arbeitsordners oder unbekannte Endung: {v}"))?.to_string_lossy().into_owned());
                } else {
                    out.push(a.clone());
                    out.push(v.clone());
                }
            }
            s if !s.starts_with('-') => {
                let abs = inside(&scene_dir, s).filter(|p| ext_is(p, &["xml"])).ok_or_else(|| format!("Szenendatei ausserhalb des Arbeitsordners oder keine .xml: {s}"))?;
                if scene.is_some() {
                    return Err("mehr als eine Szenendatei".into());
                }
                scene = Some(abs.to_string_lossy().into_owned());
                out.push(scene.clone().unwrap());
            }
            other => return Err(format!("Schalter nicht erlaubt: {other}")),
        }
    }
    if scene.is_none() {
        return Err("Szenendatei fehlt".into());
    }
    Ok(out)
}

/// Auftragskennung: nur kurze Wörter (kommt aus der Webview).
pub fn job_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }
    fn dirs() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join("dossier-render");
        (root.join("123-1-0"), root)
    }

    #[test]
    fn erlaubte_schalter_loesen_pfade_im_arbeitsordner_auf() {
        let (d, r) = dirs();
        let out = validate_args(&d, &r, &s(&["--background", "--samples", "8", "--width", "320", "--device", "CPU", "--output", "out.png", "haus.xml"])).unwrap();
        assert_eq!(out[..7], s(&["--background", "--samples", "8", "--width", "320", "--device", "CPU"])[..]);
        assert_eq!(out[7], "--output");
        assert_eq!(PathBuf::from(&out[8]), d.join("out.png"));
        assert_eq!(PathBuf::from(&out[9]), d.join("haus.xml"));
        assert!(validate_args(&d, &r, &s(&["--device", "METAL+CPU", "sub/a.xml"])).is_ok());
    }

    #[test]
    fn fremdes_wird_abgelehnt() {
        let (d, r) = dirs();
        for bad in [
            s(&["--help", "a.xml"]),
            s(&["--samples", "0", "a.xml"]),
            s(&["--samples", "8; rm -rf /", "a.xml"]),
            s(&["--samples", "99999999", "a.xml"]),
            s(&["--device", "CPU;ls", "a.xml"]),
            s(&["--output", "../out.png", "a.xml"]),
            s(&["--output", "/etc/passwd", "a.xml"]),
            s(&["--output", "out.sh", "a.xml"]),
            s(&["../../etc/x.xml"]),
            s(&["/etc/hosts.xml"]),
            s(&["a.xml", "b.xml"]),
            s(&["--samples", "8"]),
            s(&["--samples"]),
        ] {
            assert!(validate_args(&d, &r, &bad).is_err(), "sollte scheitern: {bad:?}");
        }
        assert!(validate_args(&std::env::temp_dir(), &r, &s(&["a.xml"])).is_err());
        assert!(validate_args(&r.join(".."), &r, &s(&["a.xml"])).is_err());
        assert!(validate_args(&r, &r, &s(&["a.xml"])).is_err());
    }

    #[test]
    fn programm_im_sidecar_ordner_oder_entwicklung() {
        let base = std::env::temp_dir().join(format!("dossier-cycles-test-{}", std::process::id()));
        let (side, dev) = (base.join("MacOS"), base.join("dev"));
        std::fs::create_dir_all(&side).unwrap();
        std::fs::create_dir_all(&dev).unwrap();
        assert_eq!(find_exe(&side, Some(&dev)), None);
        std::fs::write(side.join(SIDECAR), "").unwrap();
        assert_eq!(find_exe(&side, None), Some(side.join(SIDECAR)));
        std::fs::write(dev.join("cycles"), "").unwrap();
        assert_eq!(find_exe(&side, Some(&dev)), Some(dev.join("cycles")));
        std::fs::create_dir_all(base.join("res/cycles/source")).unwrap();
        assert_eq!(kernel_source_dir(&base.join("res")), Some(base.join("res/cycles/source")));
        assert_eq!(kernel_source_dir(&base), None);
        std::fs::remove_dir_all(&base).ok(); // [273]
    }

    #[test]
    fn auftragskennung() {
        assert!(job_id_ok("cycles-lq1x2y-0"));
        assert!(!job_id_ok(""));
        assert!(!job_id_ok("a b"));
        assert!(!job_id_ok("../x"));
    }
}
