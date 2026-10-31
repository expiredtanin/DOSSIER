//! Standard-Bibliothek ([100]–[102]): Baustoffe (Bauteile) mit Schnittschraffur nach SIA 400, Füllfarbe,
//! Ansichtsfarbe, Ansichtsschraffur, 3D-Textur (ambientCG, CC0) und Kennwerten (λ, Rohdichte, VKF-Brand-
//! verhaltensgruppe RF1–RF4), Schraffuren, Linientypen nach SIA 400 / ISO 128 und Standard-Aufbauten (Wand,
//! Decke, Dach). Neue Projekte bekommen sie, bestehende laden sie über „Standards laden" nach
//! ([`merge_ops`]: fehlende Einträge anhängen, nichts verdoppeln — gleiche id oder gleicher Name gilt als
//! vorhanden; Verweise der neuen Einträge zeigen dann auf den vorhandenen).
//!
//! Kennwerte: Bemessungs-/Richtwerte (SIA 381/1, SN EN ISO 10456, übliche Herstellerangaben), gerundet;
//! für den Nachweis gelten die Produktwerte.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// Gebündelte Material-Bibliothek (`public/assets/materials/manifest.json`, wie `src/materials/library.ts`).
const MANIFEST: &str = include_str!("../../../public/assets/materials/manifest.json");

/// 3D-Material zu einer ambientCG-Kennung: gebündelt → mit Karten-Pfaden; sonst nur die Kennung (die
/// Karten lädt der Bauteil-Dialog bei Bedarf von ambientCG).
fn material(id: &str, size_m: f64) -> Value {
    let manifest: Value = serde_json::from_str(MANIFEST).unwrap_or(Value::Null);
    let hit = manifest["materials"].as_array().and_then(|a| a.iter().find(|m| m["id"] == id));
    let mut m = Map::new();
    m.insert("libraryId".into(), id.into());
    if let Some(maps) = hit.and_then(|h| h["maps"].as_object()) {
        for k in ["color", "normal", "roughness", "metalness", "displacement", "ao"] {
            if let Some(v) = maps.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
    }
    m.insert("sizeM".into(), json!(size_m));
    Value::Object(m)
}

const INK: &str = "#1a1a1a";

/// Linientypen (SIA 400 / ISO 128): nur Muster und Farbe — die Strichstärke kommt vom Element, der
/// Schraffur, der Schichtfuge bzw. Ebene/Stift ([110]). Strichmuster in Papier-mm (AN/AUS, 0 = Punkt),
/// unabhängig vom Massstab.
pub fn line_styles() -> Vec<Value> {
    let dash = |id: &str, name: &str, d: Value| json!({"id": id, "name": name, "color": INK, "dash": d});
    vec![
        dash("std-ls-voll", "Volllinie", Value::Null),
        dash("std-ls-strich-fein", "Strichlinie", json!([3, 1.5])),
        dash("std-ls-strich-grob", "Strichlinie lang", json!([6, 2])),
        dash("std-ls-punkt", "Punktierte Linie", json!([0, 1])),
        dash("std-ls-strichpunkt", "Strichpunktlinie (Achse)", json!([12, 1.5, 0, 1.5])),
        dash("std-ls-strichzweipunkt", "Strich-Zweipunktlinie", json!([12, 1.5, 0, 1.5, 0, 1.5])),
        dash("std-ls-grundstueck", "Grundstücksgrenze", json!([8, 1.5, 0, 1.5, 0, 1.5])),
        dash("std-ls-bauteilgrenze", "Baulinie / Bauteilgrenze", json!([8, 1.5, 0, 1.5])),
        json!({"id": "std-ls-bruch", "name": "Bruchlinie (Zickzack)", "color": INK, "dash": null,
               "kind": "zigzag", "zigzag": {"amplitude": 1.5, "wavelength": 4}}),
        dash("std-ls-schraffur-strich", "Strichlinie kurz", json!([1, 0.7])),
        dash("std-ls-schraffur-punkt", "Punktlinie kurz", json!([0.5, 1.6])),
        // SIA 400 Fig. 34: Sperrschicht als 2D-Linie (mit kräftiger Strichstärke zeichnen).
        dash("std-ls-sperrschicht", "Sperrschicht (Wind, Dampf, Wasser)", json!([3, 3])),
    ]
}

/// Schnittschraffuren (Sinnbilder) nach SIA 400:2000, B.8.3.1 Fig. 34 ([109]). Abstände im Modell senkrecht zu
/// den Linien (Linienschar: `spacing_m`, intern `scale = spacing_m · 90 / 8`), gemessen an Fig. 34 und an den
/// 1:50-Beispielen Fig. 37/39 (Backstein, Beton: 1.5 mm Papier in 1:50 → 0.075 m; Holz massiv halb so weit);
/// Winkel in Grad. Musterlinien dünn (B.3.3: Schraffuren = dünne Volllinie, 0.10 mm). Schicht-Muster spannen
/// über die ganze Schichtdicke und laufen entlang der Schicht (`relativeToWall`).
///
/// Massstab (B.8.3.1): „Die Dichte der Sinnbilder ist dem Massstab anzupassen" — die Abstände sind für 1:50
/// gewählt und skalieren als Modell-Längen mit (1:20 gröber, 1:100 feiner). „Bei 1:100 und kleiner häufig
/// schwarz oder ein gleichbleibendes Sinnbild für alle Baustoffe" (Fig. 36) = Detailgrad „grob" (Wand als
/// schwarze Sammelfläche). Stahl (B.8.4.1): 1:50…1:10 schwarz, grösser schraffiert → „SIA Stahl M 1:1".
pub fn hatches() -> Vec<Value> {
    let lines = |id: &str, name: &str, pattern: &str, spacing_m: f64, angle: f64, rel: bool, lw: f64, ls: &str| {
        let scale = (spacing_m * 90.0 / 8.0 * 1e4).round() / 1e4;
        let mut v = json!({"id": id, "name": name, "pattern": pattern, "scale": scale, "angle": angle, "color": INK, "lineWeight": lw});
        if rel {
            v["relativeToWall"] = json!(true);
        }
        if !ls.is_empty() {
            v["lineStyleId"] = json!(ls);
        }
        v
    };
    let layer = |id: &str, name: &str, pattern: &str, scale: f64, lw: f64| {
        json!({"id": id, "name": name, "pattern": pattern, "scale": scale, "angle": 0, "relativeToWall": true, "color": INK, "lineWeight": lw})
    };
    let solid = |id: &str, name: &str, color: &str| json!({"id": id, "name": name, "pattern": "solid", "scale": 1, "angle": 0, "color": color});
    let empty = |id: &str, name: &str| json!({"id": id, "name": name, "pattern": "none", "scale": 1, "angle": 0, "color": INK});
    vec![
        empty("std-h-ohne", "SIA Ohne Schraffur"),
        // Fig. 34 „Bewehrter und unbewehrter Beton": ein Sinnbild — Kreuzschraffur 45°/135°.
        lines("std-h-stahlbeton", "SIA Stahlbeton", "crosshatch", 0.075, 45.0, false, 0.1, ""),
        lines("std-h-beton", "SIA Beton unbewehrt", "crosshatch", 0.075, 45.0, false, 0.1, ""),
        // Fig. 34 Backsteine: 45° (zur Wand), 1.5 mm in 1:50.
        lines("std-h-backstein", "SIA Backstein", "diagonal", 0.075, 45.0, true, 0.1, ""),
        // Fig. 34 Kalksandsteine: wie Backstein, gegenläufig 135°.
        lines("std-h-kalksandstein", "SIA Kalksandstein", "diagonal", 0.075, 135.0, true, 0.1, ""),
        // Porenbeton: in SIA 400 ohne Sinnbild (nur Kurzzeichen MP) — Konvention: 45°, weit, gestrichelt.
        lines("std-h-porenbeton", "SIA Porenbeton", "diagonal", 0.09, 45.0, true, 0.1, "std-ls-strich-fein"),
        // Fig. 34 Vollholz im Querschnitt: Kreuz je Holz (Feld über die Schichtdicke).
        layer("std-h-holz", "SIA Holz (Querschnitt)", "timber", 1.0, 0.1),
        // Fig. 34 Holz massiv / Fig. 28 Brett: dichte 45°-Linien, unregelmässig (Maserung).
        lines("std-h-holz-massiv", "SIA Holz massiv", "wood", 0.0375, 45.0, true, 0.1, ""),
        // Fig. 34 Brettschichtholz: Lamellen-Linien längs der Schicht.
        lines("std-h-bsp", "SIA Brettsperrholz", "diagonal", 0.04, 90.0, true, 0.1, ""),
        // Fig. 34 Holzwerkstoffe: 45°-Linien in Dreiergruppen (Teilung 2.5 mm in 1:50).
        lines("std-h-holzwerkstoff", "SIA Holzwerkstoff", "woodBased", 0.125, 45.0, true, 0.1, ""),
        // Fig. 34 Dämmstoffe (Fig. 37/38): Parallelen quer zur Schicht über die ganze Dicke; SIA 400
        // unterscheidet weiche/harte Dämmung nicht.
        lines("std-h-daemmung-weich", "SIA Dämmstoffe", "diagonal", 0.035, 0.0, true, 0.1, ""),
        // Dämmschlange (DIN 1356) als Alternative, kein SIA-Sinnbild.
        layer("std-h-daemmung-schlaufe", "Dämmung weich, Schlaufe (nicht SIA)", "insulation", 1.0, 0.13),
        // Fig. 34 Mörtel, Gips, Verputz: leer (Farbe violett nur bei farbiger Darstellung). Estrich ist Mörtel.
        empty("std-h-gips", "SIA Gips"),
        empty("std-h-putz", "SIA Putz"),
        empty("std-h-estrich", "SIA Estrich"),
        // Keramik, Faserzement: in SIA 400 ohne Sinnbild — Konvention: feines Kreuzraster bzw. dichte 135°.
        lines("std-h-keramik", "SIA Keramik", "crosshatch", 0.015, 45.0, false, 0.1, ""),
        lines("std-h-faserzement", "SIA Faserzement", "diagonal", 0.02, 135.0, false, 0.1, ""),
        // Fig. 34 Stahl (Schnitt): schwarz (B.8.4.1: 1:50 bis 1:10); grössere Massstäbe schraffiert (Stahl M 1:1).
        solid("std-h-stahl", "SIA Stahl", INK),
        lines("std-h-stahl-detail", "SIA Stahl M 1:1", "diagonal", 0.075, 45.0, false, 0.1, ""),
        // Fig. 34 Metall (ausser Stahl): leer (hellblau nur farbig).
        empty("std-h-alu", "SIA Aluminium"),
        // Fig. 34 Naturstein allgemein: 45°-Linien paarweise (zweite bei ⅓ der Teilung).
        lines("std-h-naturstein", "SIA Naturstein", "stone", 0.1125, 45.0, true, 0.1, ""),
        // Fig. 34 Glas: Parallelen längs der Scheibe.
        lines("std-h-glas", "SIA Glas", "diagonal", 0.008, 90.0, true, 0.1, ""),
        // Fig. 34 Sperrschichten (Wind, Dampf, Wasser): kräftige Strichlinie schwarz/weiss.
        layer("std-h-sperrschicht", "SIA Sperrschicht", "barrier", 1.0, 0.5),
        // Erdreich, Kies: in SIA 400 ohne Sinnbild (B.3.3 nur Terrainlinien) — Konvention.
        lines("std-h-erdreich", "SIA Erdreich", "earth", 0.0889, 45.0, false, 0.1, ""),
        lines("std-h-kies", "SIA Kies / Sauberkeitsschicht", "gravel", 0.0889, 0.0, false, 0.1, ""),
    ]
}

/// Frühere Namen von Standard-Einträgen: wer den alten Namen noch trägt, hat nicht umbenannt —
/// „Standards aktualisieren" setzt dort den heutigen Namen (Begriffe nach SIA 400).
fn former_names(id: &str) -> &'static [&'static str] {
    match id {
        "std-h-daemmung-weich" => &["SIA Dämmung weich"],
        "std-ls-punkt" => &["Punktlinie"],
        _ => &[],
    }
}

/// Ein Standard-Baustoff.
struct Mat<'a> {
    id: &'a str,
    name: &'a str,
    abbrev: &'a str,
    fill: &'a str,
    elev: &'a str,
    hatch: &'a str,
    lambda: Option<f64>,
    density: Option<f64>,
    rf: &'a str,
    tex: Option<(&'a str, f64)>,
    prio: f64,
    pattern: Option<Value>,
}

fn sp(kind: &str, dir: Option<&str>, spacing: f64, height: Option<f64>, width: Option<f64>) -> Option<Value> {
    let mut v = json!({"kind": kind, "spacing": spacing});
    if let Some(d) = dir {
        v["direction"] = json!(d);
    }
    if let Some(h) = height {
        v["height"] = json!(h);
    }
    if let Some(w) = width {
        v["width"] = json!(w);
    }
    Some(v)
}

/// Baustoffe (Bauteile) mit allen Darstellungs- und Kennwerten.
pub fn components() -> Vec<Value> {
    #[rustfmt::skip]
    let list = [
        Mat { id: "std-c-beton", name: "Beton", abbrev: "BE", fill: "#ffffff", elev: "#c4c4c0", hatch: "std-h-beton", lambda: Some(2.0), density: Some(2300.0), rf: "RF1", tex: Some(("Concrete048", 2.0)), prio: 95.0, pattern: None },
        Mat { id: "std-c-stahlbeton", name: "Stahlbeton", abbrev: "STB", fill: "#ffffff", elev: "#bdbdb8", hatch: "std-h-stahlbeton", lambda: Some(2.3), density: Some(2400.0), rf: "RF1", tex: Some(("Concrete048", 2.0)), prio: 100.0, pattern: None },
        Mat { id: "std-c-backstein", name: "Backstein", abbrev: "BS", fill: "#ffffff", elev: "#b5653f", hatch: "std-h-backstein", lambda: Some(0.44), density: Some(1100.0), rf: "RF1", tex: Some(("Bricks104", 1.0)), prio: 50.0, pattern: sp("runningBond", None, 0.26, Some(0.075), None) },
        Mat { id: "std-c-kalksandstein", name: "Kalksandstein", abbrev: "KS", fill: "#ffffff", elev: "#e4e1d8", hatch: "std-h-kalksandstein", lambda: Some(1.0), density: Some(1800.0), rf: "RF1", tex: None, prio: 55.0, pattern: sp("runningBond", None, 0.25, Some(0.125), None) },
        Mat { id: "std-c-porenbeton", name: "Porenbeton", abbrev: "PB", fill: "#ffffff", elev: "#e8e8e4", hatch: "std-h-porenbeton", lambda: Some(0.11), density: Some(400.0), rf: "RF1", tex: None, prio: 45.0, pattern: sp("runningBond", None, 0.6, Some(0.25), None) },
        Mat { id: "std-c-holz", name: "Holz massiv", abbrev: "HO", fill: "#ffffff", elev: "#c8a26a", hatch: "std-h-holz-massiv", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 40.0, pattern: None },
        Mat { id: "std-c-bsp", name: "Brettsperrholz", abbrev: "BSP", fill: "#ffffff", elev: "#d6b47e", hatch: "std-h-bsp", lambda: Some(0.12), density: Some(470.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 60.0, pattern: sp("lines", Some("horizontal"), 0.6, None, None) },
        Mat { id: "std-c-holzwerkstoff", name: "Holzwerkstoff (OSB/Spanplatte)", abbrev: "OSB", fill: "#ffffff", elev: "#d9b98a", hatch: "std-h-holzwerkstoff", lambda: Some(0.13), density: Some(650.0), rf: "RF3", tex: Some(("Chipboard001", 1.0)), prio: 35.0, pattern: sp("grid", None, 1.25, Some(2.5), None) },
        Mat { id: "std-c-mineralwolle", name: "Mineralwolle", abbrev: "MW", fill: "#ffffff", elev: "#efe6a8", hatch: "std-h-daemmung-weich", lambda: Some(0.035), density: Some(20.0), rf: "RF1", tex: None, prio: 20.0, pattern: None },
        Mat { id: "std-c-steinwolle", name: "Steinwolle", abbrev: "SW", fill: "#ffffff", elev: "#d9cfa0", hatch: "std-h-daemmung-weich", lambda: Some(0.036), density: Some(100.0), rf: "RF1", tex: None, prio: 21.0, pattern: None },
        Mat { id: "std-c-eps", name: "EPS", abbrev: "EPS", fill: "#ffffff", elev: "#f2f2f2", hatch: "std-h-daemmung-weich", lambda: Some(0.034), density: Some(20.0), rf: "RF3", tex: None, prio: 22.0, pattern: None },
        Mat { id: "std-c-xps", name: "XPS", abbrev: "XPS", fill: "#ffffff", elev: "#cfe3ef", hatch: "std-h-daemmung-weich", lambda: Some(0.033), density: Some(35.0), rf: "RF3", tex: None, prio: 23.0, pattern: None },
        Mat { id: "std-c-holzfaser", name: "Holzfaser", abbrev: "HF", fill: "#ffffff", elev: "#b08a5a", hatch: "std-h-daemmung-weich", lambda: Some(0.04), density: Some(140.0), rf: "RF3", tex: None, prio: 24.0, pattern: None },
        Mat { id: "std-c-trittschall", name: "Trittschalldämmung", abbrev: "TSD", fill: "#ffffff", elev: "#efe6a8", hatch: "std-h-daemmung-weich", lambda: Some(0.035), density: Some(100.0), rf: "RF1", tex: None, prio: 19.0, pattern: None },
        Mat { id: "std-c-gipskarton", name: "Gipskarton", abbrev: "GK", fill: "#ffffff", elev: "#f4f4f2", hatch: "std-h-gips", lambda: Some(0.25), density: Some(800.0), rf: "RF1", tex: Some(("Plaster001", 1.0)), prio: 12.0, pattern: None },
        Mat { id: "std-c-innenputz", name: "Innenputz", abbrev: "IP", fill: "#ffffff", elev: "#f5f3ee", hatch: "std-h-putz", lambda: Some(0.7), density: Some(1400.0), rf: "RF1", tex: Some(("Plaster001", 1.0)), prio: 10.0, pattern: None },
        Mat { id: "std-c-aussenputz", name: "Aussenputz", abbrev: "AP", fill: "#ffffff", elev: "#e9e3d6", hatch: "std-h-putz", lambda: Some(0.87), density: Some(1800.0), rf: "RF1", tex: Some(("Plaster001", 1.0)), prio: 10.0, pattern: None },
        Mat { id: "std-c-zementestrich", name: "Zementestrich", abbrev: "ZE", fill: "#ffffff", elev: "#cfcac0", hatch: "std-h-estrich", lambda: Some(1.4), density: Some(2000.0), rf: "RF1", tex: Some(("Concrete048", 2.0)), prio: 30.0, pattern: None },
        // Bodenbeläge ([100]): Muster im Grundriss (Oberseite der Decke) und im 3D.
        Mat { id: "std-c-parkett", name: "Parkett", abbrev: "PA", fill: "#ffffff", elev: "#c9a06b", hatch: "std-h-holz-massiv", lambda: Some(0.13), density: Some(650.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 8.0, pattern: sp("runningBond", None, 0.6, Some(0.1), None) },
        Mat { id: "std-c-keramik", name: "Keramikplatten", abbrev: "KP", fill: "#ffffff", elev: "#d8d4cc", hatch: "std-h-keramik", lambda: Some(1.3), density: Some(2300.0), rf: "RF1", tex: None, prio: 9.0, pattern: sp("grid", None, 0.3, Some(0.3), None) },
        Mat { id: "std-c-glas", name: "Glas", abbrev: "GL", fill: "#ffffff", elev: "#a9c8d4", hatch: "std-h-glas", lambda: Some(1.0), density: Some(2500.0), rf: "RF1", tex: None, prio: 70.0, pattern: None },
        Mat { id: "std-c-stahl", name: "Stahl", abbrev: "ST", fill: INK, elev: "#7d8287", hatch: "std-h-stahl", lambda: Some(50.0), density: Some(7850.0), rf: "RF1", tex: Some(("Metal063", 1.0)), prio: 110.0, pattern: None },
        Mat { id: "std-c-aluminium", name: "Aluminium", abbrev: "AL", fill: "#ffffff", elev: "#b9bcbf", hatch: "std-h-alu", lambda: Some(160.0), density: Some(2700.0), rf: "RF1", tex: Some(("Metal063", 1.0)), prio: 105.0, pattern: None },
        Mat { id: "std-c-naturstein", name: "Naturstein", abbrev: "NS", fill: "#ffffff", elev: "#bcb6a8", hatch: "std-h-naturstein", lambda: Some(2.3), density: Some(2600.0), rf: "RF1", tex: Some(("Marble012", 1.0)), prio: 90.0, pattern: sp("polygonal", None, 0.45, Some(0.35), None) },
        Mat { id: "std-c-erdreich", name: "Erdreich", abbrev: "ER", fill: "#ffffff", elev: "#8a7a62", hatch: "std-h-erdreich", lambda: Some(2.0), density: Some(1800.0), rf: "RF1", tex: Some(("Ground103", 2.0)), prio: 5.0, pattern: None },
        Mat { id: "std-c-kies", name: "Kies / Sauberkeitsschicht", abbrev: "KI", fill: "#ffffff", elev: "#b3aca0", hatch: "std-h-kies", lambda: Some(2.0), density: Some(2000.0), rf: "RF1", tex: Some(("Gravel043", 1.0)), prio: 6.0, pattern: None },
        // Sperrschicht (Abdichtung, Dampfbremse, Windpapier; SIA 400 Fig. 34).
        Mat { id: "std-c-sperrschicht", name: "Abdichtung / Sperrschicht", abbrev: "AB", fill: "#ffffff", elev: "#3a3a3a", hatch: "std-h-sperrschicht", lambda: Some(0.17), density: Some(1100.0), rf: "RF3", tex: None, prio: 2.0, pattern: None },
        // Bekleidungen / Eindeckungen: Ansichtsschraffur als Hauptsache.
        Mat { id: "std-c-luft", name: "Luftschicht / Hinterlüftung", abbrev: "LU", fill: "#ffffff", elev: "#ffffff", hatch: "std-h-ohne", lambda: None, density: None, rf: "RF1", tex: None, prio: 1.0, pattern: None },
        Mat { id: "std-c-lattung-v", name: "Holzlattung vertikal", abbrev: "LV", fill: "#ffffff", elev: "#b98d55", hatch: "std-h-holz", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 41.0, pattern: sp("lines", Some("vertical"), 0.08, None, None) },
        Mat { id: "std-c-lattung-h", name: "Holzlattung horizontal", abbrev: "LH", fill: "#ffffff", elev: "#b98d55", hatch: "std-h-holz", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 41.0, pattern: sp("lines", Some("horizontal"), 0.08, None, None) },
        Mat { id: "std-c-boden-deckel", name: "Holzschalung Boden-Deckel", abbrev: "BD", fill: "#ffffff", elev: "#a9824f", hatch: "std-h-holz-massiv", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("WoodSiding008", 1.0)), prio: 41.0, pattern: sp("boardBatten", Some("vertical"), 0.2, None, Some(0.06)) },
        Mat { id: "std-c-schindeln", name: "Holzschindeln", abbrev: "SCH", fill: "#ffffff", elev: "#9c8566", hatch: "std-h-holz-massiv", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("Wood095", 0.5)), prio: 41.0, pattern: sp("shingles", None, 0.1, Some(0.12), None) },
        Mat { id: "std-c-trapezblech", name: "Trapezblech", abbrev: "TB", fill: INK, elev: "#9aa1a6", hatch: "std-h-stahl", lambda: Some(50.0), density: Some(7850.0), rf: "RF1", tex: Some(("CorrugatedSteel005", 1.0)), prio: 108.0, pattern: sp("trapezoid", Some("vertical"), 0.2, None, Some(0.06)) },
        Mat { id: "std-c-faserzement", name: "Faserzementplatten", abbrev: "FZ", fill: "#ffffff", elev: "#a6a8a6", hatch: "std-h-faserzement", lambda: Some(0.6), density: Some(1800.0), rf: "RF1", tex: None, prio: 42.0, pattern: sp("grid", None, 1.25, Some(0.625), None) },
        Mat { id: "std-c-tonziegel", name: "Tonziegel", abbrev: "ZI", fill: "#ffffff", elev: "#b3583c", hatch: "std-h-backstein", lambda: Some(1.0), density: Some(1900.0), rf: "RF1", tex: Some(("RoofingTiles013A", 1.0)), prio: 15.0, pattern: sp("grid", Some("horizontal"), 0.21, Some(0.34), None) },
    ];
    list.iter()
        .map(|m| {
            let mut v = json!({"id": m.id, "name": m.name, "abbrev": m.abbrev, "color": m.fill, "background": m.fill, "hatchId": m.hatch,
                               "joinPriority": m.prio, "fireClass": m.rf, "elevationColor": m.elev, "standardId": m.id});
            if let Some(l) = m.lambda {
                v["lambda"] = json!(l);
            }
            if let Some(d) = m.density {
                v["density"] = json!(d);
            }
            if let Some((id, size)) = m.tex {
                v["material"] = material(id, size);
            }
            if let Some(p) = &m.pattern {
                v["surfacePattern"] = p.clone();
            }
            v
        })
        .collect()
}

fn layer(c: &str, t: f64) -> Value {
    json!({"componentId": c, "thickness": t})
}

/// Standard-Aufbauten (Schichten aussen → innen bzw. oben → unten).
pub fn wall_types() -> Vec<Value> {
    vec![
        json!({"id": "std-wt-aw-kompakt", "name": "Aussenwand verputzt, Aussendämmung 18 cm", "layers": [
            layer("std-c-aussenputz", 0.02), layer("std-c-eps", 0.18), layer("std-c-backstein", 0.175), layer("std-c-innenputz", 0.015)]}),
        json!({"id": "std-wt-iw-backstein", "name": "Innenwand Backstein 12.5 cm verputzt", "layers": [
            layer("std-c-innenputz", 0.01), layer("std-c-backstein", 0.125), layer("std-c-innenputz", 0.01)]}),
        json!({"id": "std-wt-holzstaender", "name": "Holzständerwand hinterlüftet", "layers": [
            layer("std-c-lattung-v", 0.024), layer("std-c-luft", 0.04), layer("std-c-holzfaser", 0.06),
            layer("std-c-mineralwolle", 0.2), layer("std-c-holzwerkstoff", 0.015), layer("std-c-gipskarton", 0.0125)]}),
    ]
}

pub fn ceiling_types() -> Vec<Value> {
    vec![json!({"id": "std-ct-stb-estrich", "name": "Stahlbetondecke mit Trittschall + Zementestrich", "layers": [
        layer("std-c-zementestrich", 0.08), layer("std-c-trittschall", 0.04), layer("std-c-stahlbeton", 0.24), layer("std-c-innenputz", 0.01)]})]
}

pub fn roof_types() -> Vec<Value> {
    vec![json!({"id": "std-rt-steildach-holz", "name": "Steildach Holz gedämmt", "layers": [
        layer("std-c-tonziegel", 0.04), layer("std-c-luft", 0.06), layer("std-c-holzfaser", 0.06),
        layer("std-c-mineralwolle", 0.22), layer("std-c-holzwerkstoff", 0.015), layer("std-c-gipskarton", 0.0125)]})]
}

/// Alle Standard-Ressourcen je Projekt-Liste, in Abhängigkeitsreihenfolge.
pub fn library() -> Vec<(&'static str, Vec<Value>)> {
    vec![
        ("lineStyles", line_styles()),
        ("hatches", hatches()),
        ("components", components()),
        ("wallTypes", wall_types()),
        ("ceilingTypes", ceiling_types()),
        ("roofTypes", roof_types()),
    ]
}

fn name_key(v: &Value) -> Option<String> {
    v["name"].as_str().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty())
}

fn remap(v: &mut Value, key: &str, ids: &HashMap<String, String>) {
    if let Some(new) = v[key].as_str().and_then(|s| ids.get(s)) {
        v[key] = json!(new);
    }
}

/// Ops, die die fehlenden Standard-Ressourcen anhängen. Vorhanden ist ein Eintrag mit gleicher id oder
/// gleichem Namen (Gross-/Kleinschreibung egal); Verweise neuer Einträge (Schraffur → Linienstil, Bauteil →
/// Schraffur, Aufbau → Bauteil/Fugen-Linienstil) zeigen dann auf den vorhandenen Eintrag.
pub fn merge_ops(root: &Map<String, Value>) -> Vec<Value> {
    merge_plan(root).0
}

/// Wie [`merge_ops`], dazu die Umleitung Standard-id → vorhandene id (gleichnamige Einträge).
fn merge_plan(root: &Map<String, Value>) -> (Vec<Value>, HashMap<String, String>) {
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut ops = Vec::new();
    for (key, items) in library() {
        let existing = root.get(key).and_then(Value::as_array);
        let by_id: HashMap<&str, &Value> = existing.map(|a| a.iter().filter_map(|e| e["id"].as_str().map(|i| (i, e))).collect()).unwrap_or_default();
        let by_name: HashMap<String, &str> = existing.map(|a| a.iter().filter_map(|e| Some((name_key(e)?, e["id"].as_str()?))).collect()).unwrap_or_default();
        let mut add = Vec::new();
        for mut item in items {
            let id = item["id"].as_str().unwrap_or_default().to_string();
            if by_id.contains_key(id.as_str()) {
                continue;
            }
            if let Some(other) = name_key(&item).and_then(|n| by_name.get(&n).copied()) {
                ids.insert(id, other.to_string());
                continue;
            }
            remap(&mut item, "lineStyleId", &ids);
            remap(&mut item, "hatchId", &ids);
            remap(&mut item, "viewHatchId", &ids);
            if let Some(layers) = item.get_mut("layers").and_then(Value::as_array_mut) {
                for l in layers {
                    remap(l, "componentId", &ids);
                    remap(l, "jointLineStyleId", &ids);
                }
            }
            add.push(item);
        }
        if add.is_empty() {
            continue;
        }
        if existing.is_some() {
            ops.push(json!({"kind": "add", "collection": key, "items": add}));
        } else {
            ops.push(json!({"kind": "setField", "key": key, "value": add}));
        }
    }
    (ops, ids)
}

// ── „Standards aktualisieren" ([109]) ────────────────────────────────────────
//
// Projekte, die mit älteren Standards angelegt wurden, behalten deren Definitionen („Standards laden"
// ergänzt nur). „Aktualisieren" gleicht Standard-Einträge (gleiche id wie ein Eintrag der Bibliothek) mit
// der heutigen Definition ab. Regel:
// - Verglichen werden nur die vom Standard geführten Felder (`managed`); Name und eigene Zusatzfelder
//   bleiben unangetastet — ausser der Name ist ein früherer Standard-Name ([`former_names`]). Ein vom Standard geführtes Feld, das die neue Definition nicht mehr hat, wird
//   entfernt (z. B. ein früherer `lineStyleId`).
// - Ob jemand einen Standard-Eintrag selbst geändert hat, lässt sich nicht erkennen (frühere Fassungen sind
//   nicht gespeichert). Darum nennt der Plan jede Abweichung einzeln; vorgewählt sind alle Einträge,
//   deren Name noch dem Standard entspricht, umbenannte (`renamed`) sind abgewählt. Gewählt wird im Dialog.
// - Verweise (Schraffur, Linienstil, Bauteil) werden nur gesetzt, wenn das Ziel im Projekt existiert bzw.
//   gleichzeitig ergänzt wird; fehlende Standard-Einträge werden wie bei „Standards laden" angehängt.

type Valid<'a> = HashMap<&'a str, std::collections::HashSet<String>>;

/// Felder, die der Standard je Liste führt.
fn managed(key: &str) -> &'static [&'static str] {
    match key {
        "lineStyles" => &["color", "dash", "kind", "zigzag"],
        "hatches" => &[
            "pattern", "scale", "angle", "color", "lineWeight", "relativeToWall", "lineStyleId", "kind", "lines", "density", "lengthMin", "lengthMax", "seed",
        ],
        "components" => &[
            "color", "background", "hatchId", "viewHatchId", "joinPriority", "fireClass", "elevationColor", "standardId", "lambda", "density", "material", "surfacePattern",
            "abbrev",
        ],
        _ => &["layers"],
    }
}

/// Zahlen gleich nach Wert (1 == 1.0), sonst strukturell.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

/// Ziel eines Verweises im Projekt (nach Umleitung gleichnamiger Einträge), sonst `None`.
fn ref_target(ref_key: &str, id: &str, valid: &Valid, ids: &HashMap<String, String>) -> Option<String> {
    let list = match ref_key {
        "lineStyleId" | "jointLineStyleId" => "lineStyles",
        "hatchId" | "viewHatchId" => "hatches",
        _ => "components",
    };
    let id = ids.get(id).map(String::as_str).unwrap_or(id);
    valid.get(list).is_some_and(|v| v.contains(id)).then(|| id.to_string())
}

/// Neue Fassung eines vorhandenen Standard-Eintrags (nur geführte Felder; Verweise auf fehlende Ziele
/// bleiben wie sie sind) und die Namen der geänderten Felder.
fn updated(key: &str, old: &Value, std: &Value, valid: &Valid, ids: &HashMap<String, String>) -> (Value, Vec<String>) {
    let mut new = old.clone();
    let mut fields = Vec::new();
    for f in managed(key) {
        let mut want = std.get(*f).cloned();
        if let Some(Value::String(id)) = &want {
            if matches!(*f, "lineStyleId" | "hatchId" | "viewHatchId") {
                match ref_target(f, id, valid, ids) {
                    Some(ok) => want = Some(json!(ok)),
                    None => continue, // Ziel fehlt: Verweis bleibt
                }
            }
        }
        if *f == "layers" {
            if let Some(Value::Array(ls)) = &mut want {
                for l in ls {
                    for rk in ["componentId", "jointLineStyleId"] {
                        if let Some(id) = l[rk].as_str().map(String::from) {
                            match ref_target(rk, &id, valid, ids) {
                                Some(ok) => l[rk] = json!(ok),
                                None => return (old.clone(), Vec::new()),
                            }
                        }
                    }
                }
            }
        }
        let have = old.get(*f);
        let differs = match (&want, have) {
            (Some(w), Some(h)) => !same(w, h),
            (None, None) => false,
            (None, Some(h)) => !h.is_null(),
            (Some(w), None) => !w.is_null(),
        };
        if differs {
            fields.push((*f).to_string());
            match want {
                Some(w) => new[*f] = w,
                None => {
                    if let Some(o) = new.as_object_mut() {
                        o.remove(*f);
                    }
                }
            }
        }
    }
    (new, fields)
}

/// Eine Abweichung: (Liste, id, Name, geänderte Felder, umbenannt, neue Fassung).
type Change = (String, String, String, Vec<String>, bool, Value);

fn update_changes(root: &Map<String, Value>) -> (Vec<Change>, usize) {
    let (merge, ids) = merge_plan(root);
    let mut valid: Valid = HashMap::new();
    let mut added = 0;
    for (key, _) in library() {
        let set = valid.entry(key).or_default();
        if let Some(a) = root.get(key).and_then(Value::as_array) {
            set.extend(a.iter().filter_map(|e| e["id"].as_str().map(String::from)));
        }
        for op in &merge {
            let list = match op["kind"].as_str() {
                Some("add") if op["collection"] == key => op["items"].as_array(),
                Some("setField") if op["key"] == key => op["value"].as_array(),
                _ => None,
            };
            for it in list.into_iter().flatten() {
                added += 1;
                if let Some(i) = it["id"].as_str() {
                    set.insert(i.to_string());
                }
            }
        }
    }
    let mut out = Vec::new();
    for (key, items) in library() {
        let Some(existing) = root.get(key).and_then(Value::as_array) else { continue };
        for std in &items {
            let Some(id) = std["id"].as_str() else { continue };
            let Some(old) = existing.iter().find(|e| e["id"] == id) else { continue };
            let (mut new, mut fields) = updated(key, old, std, &valid, &ids);
            // Früherer Standard-Name: nicht umbenannt, heutigen Namen setzen.
            let former = name_key(old).is_some_and(|n| former_names(id).iter().any(|f| f.to_lowercase() == n));
            if former && name_key(old) != name_key(std) {
                new["name"] = std["name"].clone();
                fields.push("name".into());
            }
            if fields.is_empty() {
                continue;
            }
            let name = old["name"].as_str().unwrap_or(id).to_string();
            let renamed = !former && name_key(old) != name_key(std);
            out.push((key.to_string(), id.to_string(), name, fields, renamed, new));
        }
    }
    (out, added)
}

/// Abweichungen der Standard-Einträge im Projekt von der heutigen Bibliothek: je Eintrag
/// `{collection, id, name, fields, renamed}`; dazu `added` = Anzahl fehlender Standard-Einträge.
pub fn update_plan(root: &Map<String, Value>) -> Value {
    let (changes, added) = update_changes(root);
    json!({
        "added": added,
        "changes": changes.iter().map(|c| json!({"collection": c.0, "id": c.1, "name": c.2, "fields": c.3, "renamed": c.4})).collect::<Vec<_>>(),
    })
}

/// Ops für „Standards aktualisieren": fehlende Standards anhängen und die gewählten Einträge (`selected` =
/// `"<Liste>:<id>"`) ersetzen — ein Undo-Schritt. Unbekannte Auswahl wird ignoriert.
pub fn update_ops(root: &Map<String, Value>, selected: &[String]) -> Vec<Value> {
    let mut ops = merge_ops(root);
    for (key, id, _, _, _, new) in update_changes(root).0 {
        if selected.contains(&format!("{key}:{id}")) {
            ops.push(json!({"kind": "replace", "collection": key, "entity": new}));
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Project;

    fn empty_root() -> Map<String, Value> {
        json!({"id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "drawingLevels": [],
               "walls": [], "openings": []})
        .as_object()
        .unwrap()
        .clone()
    }

    fn apply(root: &Map<String, Value>, ops: &[Value]) -> Map<String, Value> {
        let mut r = root.clone();
        for op in ops {
            match op["kind"].as_str().unwrap() {
                "add" => r.get_mut(op["collection"].as_str().unwrap()).unwrap().as_array_mut().unwrap().extend(op["items"].as_array().unwrap().iter().cloned()),
                "setField" => {
                    r.insert(op["key"].as_str().unwrap().into(), op["value"].clone());
                }
                k => panic!("{k}"),
            }
        }
        r
    }

    #[test]
    fn bibliothek_ist_vollstaendig_und_gueltig() {
        let r = apply(&empty_root(), &merge_ops(&empty_root()));
        let p: Project = serde_json::from_value(Value::Object(r.clone())).unwrap();
        for name in [
            "Beton", "Stahlbeton", "Backstein", "Kalksandstein", "Porenbeton", "Holz massiv", "Brettsperrholz", "Holzwerkstoff (OSB/Spanplatte)",
            "Mineralwolle", "Steinwolle", "EPS", "XPS", "Holzfaser", "Gipskarton", "Innenputz", "Aussenputz", "Zementestrich", "Glas", "Stahl",
            "Aluminium", "Naturstein", "Erdreich", "Kies / Sauberkeitsschicht", "Parkett", "Keramikplatten",
        ] {
            let c = p.components.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("{name} fehlt"));
            assert!(c.lambda.is_some() && c.density.is_some() && c.fire_class.as_deref().is_some_and(|f| f.starts_with("RF")), "{name}");
            assert!(c.elevation_color.is_some() && !c.color.is_empty(), "{name}");
            assert!(p.hatches.iter().any(|h| h.id == c.hatch_id), "{name}: Schraffur");
        }
        // Alle Verweise lösen auf
        assert!(crate::project_refs::dangling_refs(&p).is_empty(), "{:?}", crate::project_refs::dangling_refs(&p));
        for name in ["Aussenwand verputzt, Aussendämmung 18 cm", "Innenwand Backstein 12.5 cm verputzt", "Holzständerwand hinterlüftet"] {
            assert!(p.wall_types.iter().any(|t| t.name == name), "{name}");
        }
        assert_eq!(p.ceiling_types.as_ref().unwrap().len(), 1);
        assert_eq!(p.roof_types.as_ref().unwrap().len(), 1);
        // Gebündelte Textur mit Karten, fremde nur mit Kennung
        let bs = p.components.iter().find(|c| c.id == "std-c-backstein").unwrap().material.as_ref().unwrap();
        assert_eq!(bs.color.as_deref(), Some("/assets/materials/Bricks104/color.jpg"));
        let tb = p.components.iter().find(|c| c.id == "std-c-trapezblech").unwrap().material.as_ref().unwrap();
        assert!(tb.color.is_none() && tb.library_id.as_deref() == Some("CorrugatedSteel005"));
        // Linientypen
        for name in ["Volllinie", "Strichlinie", "Strichlinie lang", "Punktierte Linie", "Strichpunktlinie (Achse)", "Strich-Zweipunktlinie", "Grundstücksgrenze", "Bruchlinie (Zickzack)"] {
            assert!(p.line_styles.iter().any(|l| l.name == name), "{name}");
        }
    }

    /// Sinnbilder nach SIA 400:2000 Fig. 34 (B.8.3.1) und B.8.4.1.
    #[test]
    fn sinnbilder_nach_sia_400() {
        use crate::model::HatchPattern as P;
        let r = apply(&empty_root(), &merge_ops(&empty_root()));
        let p: Project = serde_json::from_value(Value::Object(r)).unwrap();
        let of = |comp: &str| {
            let c = p.components.iter().find(|c| c.id == comp).unwrap_or_else(|| panic!("{comp}"));
            p.hatches.iter().find(|h| h.id == c.hatch_id).unwrap_or_else(|| panic!("{comp}: Schraffur"))
        };
        let spacing = |comp: &str| of(comp).scale * 8.0 / 90.0;
        // Beton bewehrt und unbewehrt: dieselbe Kreuzschraffur, durchgezogen.
        for c in ["std-c-beton", "std-c-stahlbeton"] {
            assert_eq!(of(c).pattern, P::Crosshatch, "{c}");
            assert!(of(c).line_style_id.is_none(), "{c}");
            assert!((spacing(c) - 0.075).abs() < 1e-3, "{c}");
        }
        // Backstein 45°, Kalksandstein 135°, gleiche Teilung.
        assert_eq!((of("std-c-backstein").pattern, of("std-c-backstein").angle), (P::Diagonal, 45.0));
        assert_eq!((of("std-c-kalksandstein").pattern, of("std-c-kalksandstein").angle), (P::Diagonal, 135.0));
        assert!((spacing("std-c-backstein") - spacing("std-c-kalksandstein")).abs() < 1e-9);
        // Dämmstoffe: eine Schraffur, Parallelen quer zur Schicht.
        for c in ["std-c-mineralwolle", "std-c-steinwolle", "std-c-eps", "std-c-xps", "std-c-holzfaser", "std-c-trittschall"] {
            let h = of(c);
            assert_eq!((h.id.as_str(), h.pattern, h.angle, h.relative_to_wall), ("std-h-daemmung-weich", P::Diagonal, 0.0, Some(true)), "{c}");
        }
        // Mörtel, Gips, Verputz (und Estrich) leer; Metall leer, Stahl schwarz.
        for c in ["std-c-innenputz", "std-c-aussenputz", "std-c-gipskarton", "std-c-zementestrich", "std-c-aluminium"] {
            assert_eq!(of(c).pattern, P::None, "{c}");
            assert_eq!(p.components.iter().find(|k| k.id == c).unwrap().color, "#ffffff", "{c}");
        }
        assert_eq!(of("std-c-stahl").pattern, P::Solid);
        // Holz: massiv/Brett dichte Maserung, Kantholz (Lattung) Kreuz, Holzwerkstoff Dreiergruppen.
        for c in ["std-c-holz", "std-c-parkett", "std-c-boden-deckel", "std-c-schindeln"] {
            assert_eq!(of(c).pattern, P::Wood, "{c}");
        }
        assert_eq!(of("std-c-lattung-v").pattern, P::Timber);
        assert_eq!(of("std-c-holzwerkstoff").pattern, P::WoodBased);
        assert!(of("std-c-holzwerkstoff").lines.is_none() && of("std-c-holzwerkstoff").kind.is_none());
        assert_eq!(of("std-c-naturstein").pattern, P::Stone);
        assert_eq!((of("std-c-glas").pattern, of("std-c-glas").angle), (P::Diagonal, 90.0));
        assert_eq!(of("std-c-sperrschicht").pattern, P::Barrier);
        assert!(p.hatches.iter().any(|h| h.id == "std-h-stahl-detail" && h.pattern == P::Diagonal));
        assert!(p.line_styles.iter().any(|l| l.name == "Punktierte Linie"));
    }

    /// Ein Projekt mit den Standards vom 30.10. ([109]) bekommt über „Aktualisieren" die SIA-Fassung: alle
    /// Abweichungen vorgewählt (auch der frühere Name „SIA Dämmung weich"), danach nichts mehr offen.
    #[test]
    fn aktualisieren_bringt_sia_fassung_in_alte_projekte() {
        let mut root = apply(&empty_root(), &merge_ops(&empty_root()));
        let hs = root.get_mut("hatches").unwrap().as_array_mut().unwrap();
        hs.retain(|h| !["std-h-holz-massiv", "std-h-glas", "std-h-sperrschicht", "std-h-stahl-detail", "std-h-daemmung-schlaufe"].contains(&h["id"].as_str().unwrap()));
        for h in hs.iter_mut() {
            match h["id"].as_str().unwrap() {
                "std-h-daemmung-weich" => *h = json!({"id": "std-h-daemmung-weich", "name": "SIA Dämmung weich", "pattern": "insulation", "scale": 1, "angle": 0, "relativeToWall": true, "color": INK, "lineWeight": 0.13}),
                "std-h-beton" => {
                    h["pattern"] = json!("diagonal");
                    h["lineStyleId"] = json!("std-ls-schraffur-strich");
                }
                "std-h-putz" => h["pattern"] = json!("dots"),
                _ => {}
            }
        }
        hs.push(json!({"id": "std-h-eps", "name": "SIA Dämmung EPS", "pattern": "insulationHard", "scale": 1, "angle": 0, "relativeToWall": true, "color": INK}));
        for c in root.get_mut("components").unwrap().as_array_mut().unwrap() {
            if c["id"] == "std-c-eps" {
                c["hatchId"] = json!("std-h-eps");
            }
            if c["id"] == "std-c-holz" || c["id"] == "std-c-glas" {
                c["hatchId"] = json!("std-h-holz");
            }
        }
        let plan = update_plan(&root);
        let ch = plan["changes"].as_array().unwrap();
        let find = |id: &str| ch.iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("{id}"));
        assert_eq!(find("std-h-daemmung-weich")["renamed"], false, "früherer Standard-Name");
        assert!(find("std-h-daemmung-weich")["fields"].as_array().unwrap().iter().any(|f| f == "name"));
        assert!(ch.iter().all(|c| c["renamed"] == false));
        let all: Vec<String> = ch.iter().map(|c| format!("{}:{}", c["collection"].as_str().unwrap(), c["id"].as_str().unwrap())).collect();
        let after = apply_all(&root, &update_ops(&root, &all));
        let get = |k: &str, id: &str| after[k].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap().clone();
        assert_eq!(get("hatches", "std-h-daemmung-weich")["name"], "SIA Dämmstoffe");
        assert_eq!(get("hatches", "std-h-daemmung-weich")["pattern"], "diagonal");
        assert_eq!(get("hatches", "std-h-beton")["pattern"], "crosshatch");
        assert!(get("hatches", "std-h-beton").get("lineStyleId").is_none());
        assert_eq!(get("hatches", "std-h-putz")["pattern"], "none");
        assert_eq!(get("components", "std-c-eps")["hatchId"], "std-h-daemmung-weich");
        assert_eq!(get("components", "std-c-holz")["hatchId"], "std-h-holz-massiv");
        assert_eq!(get("components", "std-c-glas")["hatchId"], "std-h-glas");
        assert_eq!(get("components", "std-c-glas")["color"], "#ffffff");
        assert!(update_plan(&after)["changes"].as_array().unwrap().is_empty());
        assert_eq!(update_plan(&after)["added"], 0);
        let p: Project = serde_json::from_value(Value::Object(after)).unwrap();
        assert!(crate::project_refs::dangling_refs(&p).is_empty());
    }

    fn alt_projekt() -> Map<String, Value> {
        // Projekt mit Standards vom 29.10.: alte EPS-Schraffur, Putz ohne Schraffur, eine umbenannte und
        // eine eigene Schraffur.
        let mut root = apply(&empty_root(), &merge_ops(&empty_root()));
        let hs = root.get_mut("hatches").unwrap().as_array_mut().unwrap();
        hs.retain(|h| h["id"] != "std-h-putz");
        for h in hs.iter_mut() {
            if h["id"] == "std-h-daemmung-weich" {
                h["pattern"] = json!("insulation");
            }
            if h["id"] == "std-h-kalksandstein" {
                h["name"] = json!("Meine KS");
                h["pattern"] = json!("crosshatch");
            }
        }
        hs.push(json!({"id": "mine", "name": "Eigene", "pattern": "diagonal", "scale": 1, "angle": 0, "color": "#000"}));
        for c in root.get_mut("components").unwrap().as_array_mut().unwrap() {
            if c["id"] == "std-c-innenputz" {
                c["hatchId"] = json!("std-h-backstein");
            }
        }
        root
    }

    fn apply_all(root: &Map<String, Value>, ops: &[Value]) -> Map<String, Value> {
        let mut r = root.clone();
        for op in ops {
            match op["kind"].as_str().unwrap() {
                "add" => r.get_mut(op["collection"].as_str().unwrap()).unwrap().as_array_mut().unwrap().extend(op["items"].as_array().unwrap().iter().cloned()),
                "setField" => {
                    r.insert(op["key"].as_str().unwrap().into(), op["value"].clone());
                }
                "replace" => {
                    let list = r.get_mut(op["collection"].as_str().unwrap()).unwrap().as_array_mut().unwrap();
                    let i = list.iter().position(|e| e["id"] == op["entity"]["id"]).unwrap();
                    list[i] = op["entity"].clone();
                }
                k => panic!("{k}"),
            }
        }
        r
    }

    #[test]
    fn aktualisieren_listet_abweichungen_und_ersetzt_gewaehlte() {
        let root = alt_projekt();
        let plan = update_plan(&root);
        assert_eq!(plan["added"], 1, "Putz-Schraffur fehlt");
        let ch = plan["changes"].as_array().unwrap();
        let find = |id: &str| ch.iter().find(|c| c["id"] == id);
        assert_eq!(find("std-h-daemmung-weich").unwrap()["fields"], json!(["pattern"]));
        assert_eq!(find("std-h-daemmung-weich").unwrap()["renamed"], false);
        assert_eq!(find("std-h-kalksandstein").unwrap()["renamed"], true, "umbenannt: abgewählt");
        assert!(find("std-h-kalksandstein").unwrap()["fields"].as_array().unwrap().iter().any(|f| f == "pattern"));
        assert_eq!(find("std-c-innenputz").unwrap()["fields"], json!(["hatchId"]), "Verweis zeigt künftig auf die ergänzte Putz-Schraffur");
        assert!(find("mine").is_none() && find("std-h-backstein").is_none(), "Eigenes und Unverändertes nicht");
        let ops = update_ops(&root, &["hatches:std-h-daemmung-weich".to_string(), "components:std-c-innenputz".to_string()]);
        let after = apply_all(&root, &ops);
        let get = |k: &str, id: &str| after[k].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap().clone();
        assert_eq!(get("hatches", "std-h-daemmung-weich")["pattern"], "diagonal");
        assert_eq!(get("hatches", "std-h-kalksandstein")["pattern"], "crosshatch", "nicht gewählt: bleibt");
        assert_eq!(get("components", "std-c-innenputz")["hatchId"], "std-h-putz");
        assert!(after["hatches"].as_array().unwrap().iter().any(|h| h["id"] == "std-h-putz"));
        let left = update_plan(&after);
        assert_eq!(left["added"], 0);
        assert!(left["changes"].as_array().unwrap().iter().all(|c| c["id"] == "std-h-kalksandstein"));
        let all: Vec<String> = left["changes"].as_array().unwrap().iter().map(|c| format!("{}:{}", c["collection"].as_str().unwrap(), c["id"].as_str().unwrap())).collect();
        let done = apply_all(&after, &update_ops(&after, &all));
        assert!(update_plan(&done)["changes"].as_array().unwrap().is_empty());
        let p: Project = serde_json::from_value(Value::Object(done)).unwrap();
        assert!(crate::project_refs::dangling_refs(&p).is_empty());
    }

    #[test]
    fn aktualisieren_entfernt_nicht_mehr_gefuehrte_felder_und_laesst_zusatzfelder() {
        let mut root = apply(&empty_root(), &merge_ops(&empty_root()));
        for h in root.get_mut("hatches").unwrap().as_array_mut().unwrap() {
            if h["id"] == "std-h-daemmung-weich" {
                h["lineStyleId"] = json!("std-ls-voll");
                h["myNote"] = json!("bleibt");
            }
        }
        let after = apply_all(&root, &update_ops(&root, &["hatches:std-h-daemmung-weich".to_string()]));
        let eps = after["hatches"].as_array().unwrap().iter().find(|h| h["id"] == "std-h-daemmung-weich").unwrap();
        assert!(eps.get("lineStyleId").is_none());
        assert_eq!(eps["myNote"], "bleibt");
    }

    #[test]
    fn zweites_laden_verdoppelt_nichts() {
        let once = apply(&empty_root(), &merge_ops(&empty_root()));
        assert!(merge_ops(&once).is_empty());
    }

    #[test]
    fn gleichnamige_bleiben_und_verweise_zeigen_darauf() {
        let mut root = empty_root();
        root.insert("components".into(), json!([{"id": "brick", "name": "backstein ", "color": "#8c5544", "hatchId": "x", "joinPriority": 50}]));
        root.insert("lineStyles".into(), json!([{"id": "thin", "name": "Strichlinie", "color": "#000", "dash": [3, 1.5]}]));
        let r = apply(&root, &merge_ops(&root));
        let comps = r["components"].as_array().unwrap();
        assert_eq!(comps.iter().filter(|c| c["name"].as_str().unwrap().trim().eq_ignore_ascii_case("backstein")).count(), 1);
        assert_eq!(comps[0]["color"], "#8c5544", "vorhandenes Bauteil unverändert");
        let iw = r["wallTypes"].as_array().unwrap().iter().find(|t| t["id"] == "std-wt-iw-backstein").unwrap();
        assert_eq!(iw["layers"][1]["componentId"], "brick");
        let pb = r["hatches"].as_array().unwrap().iter().find(|h| h["id"] == "std-h-porenbeton").unwrap();
        assert_eq!(pb["lineStyleId"], "thin");
    }
}
