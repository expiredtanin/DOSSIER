// Absturzsicheres Speichern ([116]): erst `<pfad>.tmp` im selben Ordner schreiben und
// auf den Datentraeger zwingen (fsync), dann die bisherige Datei als `<pfad>~`
// (eine Generation) sichern und die Temp-Datei per Umbenennen an den Zielpfad setzen.
// Bricht irgendein Schritt ab, bleibt die urspruengliche Datei unveraendert.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// Schreibt `content` atomar nach `path`; die Vorversion landet in `<path>~`.
pub fn save_atomic_impl(path: &Path, content: &[u8]) -> Result<(), String> {
    let tmp = with_suffix(path, ".tmp");
    let backup = with_suffix(path, "~");
    let write_tmp = || -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()
    };
    if let Err(e) = write_tmp() {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Temp-Datei schreiben: {e}"));
    }
    // Vorversion sichern (Kopie statt Umbenennen: der Zielpfad existiert so zu jedem Zeitpunkt).
    if path.exists() {
        if let Err(e) = fs::copy(path, &backup) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Sicherung anlegen: {e}"));
        }
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Umbenennen: {e}"));
    }
    // Ordner-Eintrag sichern (unter Windows nicht moeglich, dort best effort).
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dossier-atomic-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn neue_datei_ohne_sicherung() {
        let d = tmpdir("neu");
        let p = d.join("a.obp");
        save_atomic_impl(&p, b"eins").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"eins");
        assert!(!with_suffix(&p, "~").exists());
        assert!(!with_suffix(&p, ".tmp").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn ueberschreiben_legt_sicherung_an() {
        let d = tmpdir("ueber");
        let p = d.join("a.obp");
        save_atomic_impl(&p, b"eins").unwrap();
        save_atomic_impl(&p, b"zwei").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"zwei");
        assert_eq!(fs::read(with_suffix(&p, "~")).unwrap(), b"eins");
        save_atomic_impl(&p, b"drei").unwrap();
        assert_eq!(fs::read(with_suffix(&p, "~")).unwrap(), b"zwei");
        assert!(!with_suffix(&p, ".tmp").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn fehler_laesst_original_unberuehrt() {
        let d = tmpdir("fehler");
        let p = d.join("a.obp");
        save_atomic_impl(&p, b"original").unwrap();
        // Ein Ordner an der Stelle der Temp-Datei laesst das Schreiben scheitern.
        fs::create_dir(with_suffix(&p, ".tmp")).unwrap();
        assert!(save_atomic_impl(&p, b"neu").is_err());
        assert_eq!(fs::read(&p).unwrap(), b"original");
        // Nicht existierender Zielordner: Fehler, nichts angelegt.
        assert!(save_atomic_impl(&d.join("nope").join("b.obp"), b"x").is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn liegengebliebene_temp_datei_eines_absturzes_stoert_nicht() {
        let d = tmpdir("stale");
        let p = d.join("a.obp");
        save_atomic_impl(&p, b"alt").unwrap();
        // Absturz mitten im Schreiben: abgeschnittene Temp-Datei bleibt zurueck, das Original ist heil.
        fs::write(with_suffix(&p, ".tmp"), b"{\"walls\": [").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"alt");
        save_atomic_impl(&p, "neu äöü 😀".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "neu äöü 😀");
        assert!(!with_suffix(&p, ".tmp").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn scheitert_die_sicherung_bleibt_original_und_keine_temp_datei() {
        let d = tmpdir("sicherung");
        let p = d.join("a.obp");
        save_atomic_impl(&p, b"original").unwrap();
        // Ein Ordner an der Stelle von `<pfad>~` laesst das Kopieren der Vorversion scheitern.
        fs::create_dir(with_suffix(&p, "~")).unwrap();
        assert!(save_atomic_impl(&p, b"neu").is_err());
        assert_eq!(fs::read(&p).unwrap(), b"original");
        assert!(!with_suffix(&p, ".tmp").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn leerer_inhalt_wird_geschrieben_ohne_das_original_zu_verlieren() {
        let d = tmpdir("leer");
        let p = d.join("a.obp");
        save_atomic_impl(&p, b"inhalt").unwrap();
        save_atomic_impl(&p, b"").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"");
        assert_eq!(fs::read(with_suffix(&p, "~")).unwrap(), b"inhalt");
        fs::remove_dir_all(&d).unwrap();
    }
}
