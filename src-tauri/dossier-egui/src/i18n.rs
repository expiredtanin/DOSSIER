// Kleine eigene Übersetzungstabelle (de/en). Die TS-App hat `src/i18n/de.ts`/`en.ts`; die
// egui-Probe braucht nur einen Bruchteil davon und bleibt bewusst unabhängig. Unbekannte
// Schlüssel werden unverändert angezeigt (sichtbar statt still leer).

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    De,
    En,
}

static LANG: AtomicU8 = AtomicU8::new(0);

pub fn set_lang(l: Lang) {
    LANG.store(if l == Lang::En { 1 } else { 0 }, Ordering::Relaxed);
}

pub fn lang() -> Lang {
    if LANG.load(Ordering::Relaxed) == 1 {
        Lang::En
    } else {
        Lang::De
    }
}

/// Sprache aus der Umgebung (`DOSSIER_LANG`, sonst `LANG`/`LC_ALL`): Deutsch, ausser die
/// Umgebung verlangt ausdrücklich Englisch.
pub fn lang_from_env() -> Lang {
    let pick = |v: &str| if v.to_ascii_lowercase().starts_with("en") { Lang::En } else { Lang::De };
    for key in ["DOSSIER_LANG", "LC_ALL", "LANG"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() && v != "C" && v != "POSIX" {
                return pick(&v);
            }
        }
    }
    Lang::De
}

/// (Schlüssel, Deutsch, Englisch)
const TABLE: &[(&str, &str, &str)] = &[
    // Werkzeugleiste / Menü
    ("app.title", "Dossier", "Dossier"),
    ("toolbar.open", "Öffnen…", "Open…"),
    ("toolbar.reload", "Neu laden", "Reload"),
    ("toolbar.select", "Auswahl", "Select"),
    ("toolbar.wall", "Wand zeichnen", "Draw wall"),
    ("toolbar.wall_thickness", "Dicke", "Thickness"),
    ("toolbar.fit", "Einpassen", "Fit"),
    ("toolbar.clear_sketch", "Skizze löschen", "Clear sketch"),
    ("toolbar.theme", "Erscheinungsbild", "Appearance"),
    ("theme.system", "System", "System"),
    ("theme.light", "Hell", "Light"),
    ("theme.dark", "Dunkel", "Dark"),
    // Tabs
    ("tab.levels", "Geschosse", "Storeys"),
    ("tab.plan", "Grundriss", "Floor plan"),
    ("tab.3d", "3D", "3D"),
    ("tab.properties", "Eigenschaften", "Properties"),
    ("tab.areas", "Flächenbilanz", "Area balance"),
    // Geschosse
    ("levels.active", "Aktives Geschoss", "Active storey"),
    ("levels.visible_3d", "Im 3D sichtbar", "Visible in 3D"),
    ("levels.elevation", "Höhe", "Elevation"),
    ("levels.context", "Umgebung", "Context"),
    ("levels.none", "Kein Projekt geladen.", "No project loaded."),
    // Eigenschaften
    ("props.none", "Nichts ausgewählt. Im Grundriss auf ein Bauteil klicken.", "Nothing selected. Click an element in the floor plan."),
    ("props.readonly", "Nur Anzeige — Bearbeiten folgt mit dem Rust-Modell [K4].", "Display only — editing follows with the Rust model [K4]."),
    ("props.id", "ID", "ID"),
    ("props.kind", "Bauteil", "Element"),
    ("props.level", "Geschoss", "Storey"),
    ("prop.type", "Typ", "Type"),
    ("prop.thickness", "Dicke", "Thickness"),
    ("prop.length", "Länge", "Length"),
    ("prop.height", "Höhe", "Height"),
    ("prop.width", "Breite", "Width"),
    ("prop.sill", "Brüstung", "Sill"),
    ("prop.wall", "Wand", "Wall"),
    ("prop.name", "Name", "Name"),
    ("prop.sia", "SIA 416", "SIA 416"),
    ("prop.area", "Fläche", "Area"),
    ("prop.category", "Ebene", "Layer"),
    ("prop.profile", "Profil", "Profile"),
    ("prop.shape", "Form", "Shape"),
    ("prop.steps", "Stufen", "Steps"),
    ("prop.runLength", "Lauflänge", "Run length"),
    ("prop.pitch", "Neigung", "Pitch"),
    ("kind.wall", "Wand", "Wall"),
    ("kind.door", "Tür", "Door"),
    ("kind.window", "Fenster", "Window"),
    ("kind.room", "Raum", "Room"),
    ("kind.column", "Stütze", "Column"),
    ("kind.stair", "Treppe", "Stair"),
    ("kind.ceiling", "Decke", "Slab"),
    ("kind.roof", "Dach", "Roof"),
    ("kind.sketch", "Skizzierte Wand (nicht gespeichert)", "Sketched wall (not saved)"),
    // Flächenbilanz
    ("areas.none", "Keine Kennzahlen im geladenen JSON.", "No key figures in the loaded JSON."),
    ("areas.building", "Gebäude", "Building"),
    ("areas.gf", "Geschossfläche GF", "Gross floor area GF"),
    ("areas.agf", "Anrechenbare GF (aGF)", "Chargeable GF (aGF)"),
    ("areas.gv", "Gebäudevolumen GV", "Building volume GV"),
    ("areas.footprint", "Bebaute Fläche", "Footprint"),
    ("areas.az", "Ausnützungsziffer AZ", "Floor area ratio"),
    ("areas.uez", "Überbauungsziffer ÜZ", "Site coverage"),
    ("areas.per_level", "Je Geschoss", "Per storey"),
    ("areas.rooms", "Räume", "Rooms"),
    ("areas.program", "Raumprogramm", "Room programme"),
    ("areas.program_empty", "Kein Raumprogramm hinterlegt.", "No room programme defined."),
    ("areas.target", "Soll", "Target"),
    ("areas.actual", "Ist", "Actual"),
    ("areas.extra", "Räume ohne Programmzeile", "Rooms without programme row"),
    ("status.ok", "erfüllt", "met"),
    ("status.under", "zu klein", "too small"),
    ("status.over", "zu gross", "too large"),
    ("status.missing", "fehlt", "missing"),
    ("status.too_few", "zu wenige", "too few"),
    ("status.too_many", "zu viele", "too many"),
    // Ansichten
    ("plan.empty", "Kein Grundriss im geladenen JSON.", "No floor plan in the loaded JSON."),
    ("plan.hint_select", "Klick: Bauteil wählen · Ziehen: verschieben · Rad/Pinch: zoomen", "Click: select · Drag: pan · Wheel/pinch: zoom"),
    ("plan.hint_wall", "Klick: Punkt setzen · Doppelklick/Enter/Esc: beenden · Shift: orthogonal", "Click: set point · Double-click/Enter/Esc: finish · Shift: orthogonal"),
    ("3d.empty", "Kein 3D-Modell im geladenen JSON.", "No 3D model in the loaded JSON."),
    ("3d.hint", "Ziehen: drehen · Rechts/Mitte ziehen: verschieben · Rad: zoomen", "Drag: orbit · Right/middle drag: pan · Wheel: zoom"),
    ("3d.style", "Darstellung", "Style"),
    ("style.shaded", "Schattiert", "Shaded"),
    ("style.shaded_edges", "Schattiert mit Kanten", "Shaded with edges"),
    ("style.white", "Weissmodell", "White model"),
    ("style.hidden", "Verdeckte Kanten", "Hidden line"),
    ("3d.reset", "Ansicht zurücksetzen", "Reset view"),
    ("gpu.missing", "Kein wgpu-Gerät (eframe mit wgpu-Renderer nötig).", "No wgpu device (eframe with wgpu renderer required)."),
    // Laden
    ("load.error", "Laden fehlgeschlagen", "Loading failed"),
    ("load.loaded", "Geladen", "Loaded"),
    ("load.hint", "JSON aus `dossier-cli <projekt.obp> bundle` öffnen (oder .obp, wenn Node und die CLI gefunden werden).", "Open JSON from `dossier-cli <project.obp> bundle` (or .obp if Node and the CLI are found)."),
    ("load.filter_json", "Dossier-Ansichtspaket", "Dossier view bundle"),
    ("load.filter_obp", "Dossier-Projekt", "Dossier project"),
    ("sketch.count", "Skizzierte Wände", "Sketched walls"),
];

/// Übersetzt `key` in die aktuelle Sprache; unbekannt → der Schlüssel selbst.
pub fn t(key: &str) -> String {
    tr(key).map(str::to_owned).unwrap_or_else(|| key.to_owned())
}

/// Wie [`t`], aber `None` für unbekannte Schlüssel.
pub fn tr(key: &str) -> Option<&'static str> {
    let l = lang();
    TABLE.iter().find(|(k, _, _)| *k == key).map(|(_, de, en)| if l == Lang::En { *en } else { *de })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabelle_vollstaendig_und_eindeutig() {
        let mut seen = std::collections::HashSet::new();
        for (k, de, en) in TABLE {
            assert!(seen.insert(*k), "doppelter Schlüssel {k}");
            assert!(!de.is_empty() && !en.is_empty(), "leere Übersetzung für {k}");
        }
    }

    #[test]
    fn unbekannt_bleibt_sichtbar() {
        assert_eq!(t("gibts.nicht"), "gibts.nicht");
        assert!(tr("gibts.nicht").is_none());
    }

    #[test]
    fn sprachwechsel() {
        set_lang(Lang::En);
        assert_eq!(t("tab.plan"), "Floor plan");
        set_lang(Lang::De);
        assert_eq!(t("tab.plan"), "Grundriss");
    }
}
