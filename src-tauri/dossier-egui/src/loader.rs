// Laden: JSON direkt (Ansichtspaket, model3d oder Plan-Szene) oder — Komfort — eine .obp-Datei
// bzw. das eingebaute Beispiel über die TS-CLI (`node dist-cli/dossier-cli.mjs … bundle`),
// solange das Modell noch in TS lebt ([K4]).

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::bundle::{self, Bundle};

/// Pseudo-Datei der CLI für das eingebaute Demo-Haus.
pub const EXAMPLE: &str = ":beispiel";

/// Sucht `dist-cli/dossier-cli.mjs`: `DOSSIER_CLI`, sonst relativ zum Crate (Repo-Checkout),
/// sonst relativ zum Arbeitsverzeichnis.
pub fn find_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DOSSIER_CLI") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [here.join("../../dist-cli/dossier-cli.mjs"), PathBuf::from("dist-cli/dossier-cli.mjs")];
    candidates.into_iter().find(|p| p.is_file())
}

/// Erzeugt das Ansichtspaket über die CLI (`project` = Pfad oder [`EXAMPLE`]).
pub fn bundle_via_cli(project: &str) -> Result<Bundle, String> {
    let cli = find_cli().ok_or("dist-cli/dossier-cli.mjs nicht gefunden (npm run build:cli, oder DOSSIER_CLI setzen)")?;
    // Über eine temporäre Datei statt `--out -`: die CLI beendet sich mit process.exit, bevor
    // Node grosse Ausgaben in eine Pipe fertig geschrieben hat (Abbruch bei 64 KiB).
    let tmp = std::env::temp_dir().join(format!("dossier-egui-{}.bundle.json", std::process::id()));
    let out = Command::new(std::env::var("DOSSIER_NODE").unwrap_or_else(|_| "node".into()))
        .arg(&cli)
        .arg(project)
        .arg("bundle")
        .arg("--out")
        .arg(&tmp)
        .output()
        .map_err(|e| format!("node nicht startbar: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("dossier-cli: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let text = std::fs::read_to_string(&tmp).map_err(|e| format!("CLI-Ausgabe: {e}"));
    let _ = std::fs::remove_file(&tmp);
    bundle::parse(&text?)
}

/// Lädt eine Datei: `.obp` über die CLI, alles andere als JSON.
pub fn load_path(path: &Path) -> Result<Bundle, String> {
    let is_obp = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("obp"));
    if is_obp {
        return bundle_via_cli(&path.to_string_lossy());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut b = bundle::parse(&text)?;
    if b.name.is_empty() {
        b.name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    }
    Ok(b)
}
