//! Standard-Bibliothek ([94]–[96]): Baustoffe (Bauteile) mit Schnittschraffur nach SIA 400, Füllfarbe,
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

/// Linientypen (SIA 400 / ISO 128). Strichmuster in Papier-mm (AN/AUS, 0 = Punkt), unabhängig vom Massstab.
pub fn line_styles() -> Vec<Value> {
    let dash = |id: &str, name: &str, w: f64, d: Value| json!({"id": id, "name": name, "weight": w, "color": INK, "dash": d});
    vec![
        dash("std-ls-voll", "Volllinie", 0.25, Value::Null),
        dash("std-ls-strich-fein", "Strichlinie fein", 0.18, json!([3, 1.5])),
        dash("std-ls-strich-grob", "Strichlinie grob", 0.5, json!([6, 2])),
        dash("std-ls-punkt", "Punktlinie", 0.25, json!([0, 1])),
        dash("std-ls-strichpunkt", "Strichpunktlinie (Achse)", 0.18, json!([12, 1.5, 0, 1.5])),
        dash("std-ls-strichzweipunkt", "Strich-Zweipunktlinie", 0.18, json!([12, 1.5, 0, 1.5, 0, 1.5])),
        dash("std-ls-grundstueck", "Grundstücksgrenze", 0.5, json!([8, 1.5, 0, 1.5, 0, 1.5])),
        dash("std-ls-bauteilgrenze", "Baulinie / Bauteilgrenze", 0.35, json!([8, 1.5, 0, 1.5])),
        json!({"id": "std-ls-bruch", "name": "Bruchlinie (Zickzack)", "weight": 0.18, "color": INK, "dash": null,
               "kind": "zigzag", "zigzag": {"amplitude": 1.5, "wavelength": 4}}),
        dash("std-ls-schraffur", "Schraffurlinie 0.10", 0.1, Value::Null),
        dash("std-ls-schraffur-strich", "Schraffurlinie gestrichelt", 0.1, json!([1, 0.7])),
    ]
}

/// Schnittschraffuren (SIA 400). Abstand im Modell (Kachel 8·scale/90 m), Winkel in Grad.
pub fn hatches() -> Vec<Value> {
    let h = |id: &str, name: &str, pattern: &str, scale: f64, angle: f64, rel: bool, ls: &str| {
        let mut v = json!({"id": id, "name": name, "pattern": pattern, "scale": scale, "angle": angle, "color": INK});
        if rel {
            v["relativeToWall"] = json!(true);
        }
        if !ls.is_empty() {
            v["lineStyleId"] = json!(ls);
        }
        v
    };
    let solid = |id: &str, name: &str, color: &str| json!({"id": id, "name": name, "pattern": "solid", "scale": 1, "angle": 0, "color": color});
    let random = |id: &str, name: &str, angle: f64, density: f64, lmin: f64, lmax: f64, seed: f64| {
        json!({"id": id, "name": name, "kind": "vector", "lines": "random", "pattern": "diagonal", "scale": 1, "angle": angle,
               "color": INK, "lineStyleId": "std-ls-schraffur", "density": density, "lengthMin": lmin, "lengthMax": lmax, "seed": seed})
    };
    vec![
        h("std-h-ohne", "SIA Ohne Schraffur", "none", 1.0, 0.0, false, ""),
        h("std-h-stahlbeton", "SIA Stahlbeton", "crosshatch", 0.5, 45.0, false, "std-ls-schraffur"),
        h("std-h-beton", "SIA Beton unbewehrt", "crosshatch", 0.6, 45.0, false, "std-ls-schraffur-strich"),
        h("std-h-backstein", "SIA Backstein", "diagonal", 0.5, 45.0, true, "std-ls-schraffur"),
        h("std-h-kalksandstein", "SIA Kalksandstein", "diagonal", 0.35, 135.0, true, "std-ls-schraffur"),
        h("std-h-porenbeton", "SIA Porenbeton", "diagonal", 0.5, 45.0, true, "std-ls-schraffur-strich"),
        h("std-h-holz", "SIA Holz (Querschnitt)", "crosshatch", 0.6, 0.0, true, "std-ls-schraffur"),
        h("std-h-bsp", "SIA Brettsperrholz", "diagonal", 0.3, 90.0, true, "std-ls-schraffur"),
        random("std-h-holzwerkstoff", "SIA Holzwerkstoff", 30.0, 1.4, 0.6, 1.5, 7.0),
        h("std-h-daemmung-weich", "SIA Dämmung weich", "insulation", 1.0, 0.0, true, "std-ls-schraffur"),
        h("std-h-eps", "SIA Dämmung EPS", "diagonal", 0.45, 0.0, true, "std-ls-schraffur"),
        h("std-h-xps", "SIA Dämmung XPS", "crosshatch", 0.45, 0.0, true, "std-ls-schraffur"),
        h("std-h-holzfaser", "SIA Dämmung Holzfaser", "insulation", 0.8, 0.0, true, "std-ls-schraffur-strich"),
        solid("std-h-gips", "SIA Gips", "#cfcfcf"),
        h("std-h-estrich", "SIA Estrich", "diagonal", 0.35, 45.0, false, "std-ls-schraffur-strich"),
        solid("std-h-stahl", "SIA Stahl", INK),
        solid("std-h-alu", "SIA Aluminium", "#8c8c8c"),
        h("std-h-naturstein", "SIA Naturstein", "diagonal", 0.8, 45.0, false, "std-ls-voll"),
        random("std-h-erdreich", "SIA Erdreich", 45.0, 0.8, 1.5, 4.0, 11.0),
        random("std-h-kies", "SIA Kies / Sauberkeitsschicht", 60.0, 1.8, 0.4, 0.9, 13.0),
    ]
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
        Mat { id: "std-c-holz", name: "Holz massiv", abbrev: "HO", fill: "#ffffff", elev: "#c8a26a", hatch: "std-h-holz", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 40.0, pattern: None },
        Mat { id: "std-c-bsp", name: "Brettsperrholz", abbrev: "BSP", fill: "#ffffff", elev: "#d6b47e", hatch: "std-h-bsp", lambda: Some(0.12), density: Some(470.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 60.0, pattern: sp("lines", Some("horizontal"), 0.6, None, None) },
        Mat { id: "std-c-holzwerkstoff", name: "Holzwerkstoff (OSB/Spanplatte)", abbrev: "OSB", fill: "#ffffff", elev: "#d9b98a", hatch: "std-h-holzwerkstoff", lambda: Some(0.13), density: Some(650.0), rf: "RF3", tex: Some(("Chipboard001", 1.0)), prio: 35.0, pattern: sp("grid", None, 1.25, Some(2.5), None) },
        Mat { id: "std-c-mineralwolle", name: "Mineralwolle", abbrev: "MW", fill: "#ffffff", elev: "#efe6a8", hatch: "std-h-daemmung-weich", lambda: Some(0.035), density: Some(20.0), rf: "RF1", tex: None, prio: 20.0, pattern: None },
        Mat { id: "std-c-steinwolle", name: "Steinwolle", abbrev: "SW", fill: "#ffffff", elev: "#d9cfa0", hatch: "std-h-daemmung-weich", lambda: Some(0.036), density: Some(100.0), rf: "RF1", tex: None, prio: 21.0, pattern: None },
        Mat { id: "std-c-eps", name: "EPS", abbrev: "EPS", fill: "#ffffff", elev: "#f2f2f2", hatch: "std-h-eps", lambda: Some(0.034), density: Some(20.0), rf: "RF3", tex: None, prio: 22.0, pattern: None },
        Mat { id: "std-c-xps", name: "XPS", abbrev: "XPS", fill: "#ffffff", elev: "#cfe3ef", hatch: "std-h-xps", lambda: Some(0.033), density: Some(35.0), rf: "RF3", tex: None, prio: 23.0, pattern: None },
        Mat { id: "std-c-holzfaser", name: "Holzfaser", abbrev: "HF", fill: "#ffffff", elev: "#b08a5a", hatch: "std-h-holzfaser", lambda: Some(0.04), density: Some(140.0), rf: "RF3", tex: None, prio: 24.0, pattern: None },
        Mat { id: "std-c-trittschall", name: "Trittschalldämmung", abbrev: "TSD", fill: "#ffffff", elev: "#efe6a8", hatch: "std-h-daemmung-weich", lambda: Some(0.035), density: Some(100.0), rf: "RF1", tex: None, prio: 19.0, pattern: None },
        Mat { id: "std-c-gipskarton", name: "Gipskarton", abbrev: "GK", fill: "#cfcfcf", elev: "#f4f4f2", hatch: "std-h-gips", lambda: Some(0.25), density: Some(800.0), rf: "RF1", tex: Some(("Plaster001", 1.0)), prio: 12.0, pattern: None },
        Mat { id: "std-c-innenputz", name: "Innenputz", abbrev: "IP", fill: "#ffffff", elev: "#f5f3ee", hatch: "std-h-ohne", lambda: Some(0.7), density: Some(1400.0), rf: "RF1", tex: Some(("Plaster001", 1.0)), prio: 10.0, pattern: None },
        Mat { id: "std-c-aussenputz", name: "Aussenputz", abbrev: "AP", fill: "#ffffff", elev: "#e9e3d6", hatch: "std-h-ohne", lambda: Some(0.87), density: Some(1800.0), rf: "RF1", tex: Some(("Plaster001", 1.0)), prio: 10.0, pattern: None },
        Mat { id: "std-c-zementestrich", name: "Zementestrich", abbrev: "ZE", fill: "#ffffff", elev: "#cfcac0", hatch: "std-h-estrich", lambda: Some(1.4), density: Some(2000.0), rf: "RF1", tex: Some(("Concrete048", 2.0)), prio: 30.0, pattern: None },
        Mat { id: "std-c-glas", name: "Glas", abbrev: "GL", fill: "#d6ecf3", elev: "#a9c8d4", hatch: "std-h-ohne", lambda: Some(1.0), density: Some(2500.0), rf: "RF1", tex: None, prio: 70.0, pattern: None },
        Mat { id: "std-c-stahl", name: "Stahl", abbrev: "ST", fill: INK, elev: "#7d8287", hatch: "std-h-stahl", lambda: Some(50.0), density: Some(7850.0), rf: "RF1", tex: Some(("Metal063", 1.0)), prio: 110.0, pattern: None },
        Mat { id: "std-c-aluminium", name: "Aluminium", abbrev: "AL", fill: "#8c8c8c", elev: "#b9bcbf", hatch: "std-h-alu", lambda: Some(160.0), density: Some(2700.0), rf: "RF1", tex: Some(("Metal063", 1.0)), prio: 105.0, pattern: None },
        Mat { id: "std-c-naturstein", name: "Naturstein", abbrev: "NS", fill: "#ffffff", elev: "#bcb6a8", hatch: "std-h-naturstein", lambda: Some(2.3), density: Some(2600.0), rf: "RF1", tex: Some(("Marble012", 1.0)), prio: 90.0, pattern: sp("polygonal", None, 0.45, Some(0.35), None) },
        Mat { id: "std-c-erdreich", name: "Erdreich", abbrev: "ER", fill: "#ffffff", elev: "#8a7a62", hatch: "std-h-erdreich", lambda: Some(2.0), density: Some(1800.0), rf: "RF1", tex: Some(("Ground103", 2.0)), prio: 5.0, pattern: None },
        Mat { id: "std-c-kies", name: "Kies / Sauberkeitsschicht", abbrev: "KI", fill: "#ffffff", elev: "#b3aca0", hatch: "std-h-kies", lambda: Some(2.0), density: Some(2000.0), rf: "RF1", tex: Some(("Gravel043", 1.0)), prio: 6.0, pattern: None },
        // Bekleidungen / Eindeckungen: Ansichtsschraffur als Hauptsache.
        Mat { id: "std-c-luft", name: "Luftschicht / Hinterlüftung", abbrev: "LU", fill: "#ffffff", elev: "#ffffff", hatch: "std-h-ohne", lambda: None, density: None, rf: "RF1", tex: None, prio: 1.0, pattern: None },
        Mat { id: "std-c-lattung-v", name: "Holzlattung vertikal", abbrev: "LV", fill: "#ffffff", elev: "#b98d55", hatch: "std-h-holz", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 41.0, pattern: sp("lines", Some("vertical"), 0.08, None, None) },
        Mat { id: "std-c-lattung-h", name: "Holzlattung horizontal", abbrev: "LH", fill: "#ffffff", elev: "#b98d55", hatch: "std-h-holz", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("Wood095", 1.0)), prio: 41.0, pattern: sp("lines", Some("horizontal"), 0.08, None, None) },
        Mat { id: "std-c-boden-deckel", name: "Holzschalung Boden-Deckel", abbrev: "BD", fill: "#ffffff", elev: "#a9824f", hatch: "std-h-holz", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("WoodSiding008", 1.0)), prio: 41.0, pattern: sp("boardBatten", Some("vertical"), 0.2, None, Some(0.06)) },
        Mat { id: "std-c-schindeln", name: "Holzschindeln", abbrev: "SCH", fill: "#ffffff", elev: "#9c8566", hatch: "std-h-holz", lambda: Some(0.13), density: Some(450.0), rf: "RF3", tex: Some(("Wood095", 0.5)), prio: 41.0, pattern: sp("shingles", None, 0.1, Some(0.12), None) },
        Mat { id: "std-c-trapezblech", name: "Trapezblech", abbrev: "TB", fill: INK, elev: "#9aa1a6", hatch: "std-h-stahl", lambda: Some(50.0), density: Some(7850.0), rf: "RF1", tex: Some(("CorrugatedSteel005", 1.0)), prio: 108.0, pattern: sp("trapezoid", Some("vertical"), 0.2, None, Some(0.06)) },
        Mat { id: "std-c-faserzement", name: "Faserzementplatten", abbrev: "FZ", fill: "#ffffff", elev: "#a6a8a6", hatch: "std-h-ohne", lambda: Some(0.6), density: Some(1800.0), rf: "RF1", tex: None, prio: 42.0, pattern: sp("grid", None, 1.25, Some(0.625), None) },
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
            "Aluminium", "Naturstein", "Erdreich", "Kies / Sauberkeitsschicht",
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
        for name in ["Volllinie", "Strichlinie fein", "Strichlinie grob", "Punktlinie", "Strichpunktlinie (Achse)", "Strich-Zweipunktlinie", "Grundstücksgrenze", "Bruchlinie (Zickzack)"] {
            assert!(p.line_styles.iter().any(|l| l.name == name), "{name}");
        }
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
        root.insert("lineStyles".into(), json!([{"id": "thin", "name": "Schraffurlinie 0.10", "weight": 0.1, "color": "#000", "dash": null}]));
        let r = apply(&root, &merge_ops(&root));
        let comps = r["components"].as_array().unwrap();
        assert_eq!(comps.iter().filter(|c| c["name"].as_str().unwrap().trim().eq_ignore_ascii_case("backstein")).count(), 1);
        assert_eq!(comps[0]["color"], "#8c5544", "vorhandenes Bauteil unverändert");
        let iw = r["wallTypes"].as_array().unwrap().iter().find(|t| t["id"] == "std-wt-iw-backstein").unwrap();
        assert_eq!(iw["layers"][1]["componentId"], "brick");
        let bs = r["hatches"].as_array().unwrap().iter().find(|h| h["id"] == "std-h-backstein").unwrap();
        assert_eq!(bs["lineStyleId"], "thin");
    }
}
