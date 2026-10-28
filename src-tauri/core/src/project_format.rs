//! Projektdatei-Format (`.obp`/`.obpt`/Alt-`.json`) ([K4] S4-Vorarbeit, vorher
//! `src/io/projectFormat.ts`): Versionierung, Migration und EIN Parser für alle Ladestellen.
//!
//! Regeln: jede gespeicherte Datei trägt `formatVersion`; ältere Dateien (auch ohne = Version 0)
//! laufen durch die Migrationskette; neuere werden mit klarer Meldung ABGELEHNT; tolerant gelesen
//! (fehlende Listen leer ergänzt, unbekannte Felder bleiben erhalten und werden gemeldet). Alles
//! arbeitet auf dem rohen JSON-Baum — das Modell wird erst danach typisiert.

use serde_json::{Map, Value};

/// Aktuelle Version des Dateiformats. Bei jeder Formatänderung erhöhen + Migration anhängen.
pub const PROJECT_FORMAT_VERSION: u64 = 2;

const REQUIRED_ARRAYS: [&str; 3] = ["walls", "layers", "drawingLevels"];
const DEFAULT_ARRAYS: [&str; 5] = ["lineStyles", "hatches", "components", "wallTypes", "drawings2d"];

/// Bekannte Felder von `Project` (für die Meldung unbekannter Felder).
const KNOWN_KEYS: [&str; 46] = [
    "formatVersion", "id", "name", "lineStyles", "textStyles", "hatches", "components", "wallTypes",
    "ceilingTypes", "roofTypes", "blockDefs", "doorTypes", "windowTypes", "stairTypes", "pens",
    "penSets", "activePenSetId", "customPalettes", "builtinPaletteBanks", "drawingLevels", "layers",
    "walls", "ceilings", "roofs", "openings", "stairs", "rooms", "drawings2d", "context",
    "extrudedSolids", "columns", "groups", "parametricWalls", "overrideRules", "viewSnapshots",
    "viewSnapshotFolders", "layouts", "masterLayouts", "layoutFolders", "referenceElevationMasl",
    "geoAnchor", "roomProgram", "parcelArea", "sunStudy", "siteRules", "scaleLineWeights",
];

/// Ergebnis des Einlesens.
#[derive(Debug, PartialEq)]
pub enum Parsed {
    Ok { project: Map<String, Value>, warnings: Vec<String>, migrated_from: Option<u64> },
    Err(String),
}

/// JS-`String(v)` für die Meldungen.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map_or(n.to_string(), |f| if f.fract() == 0.0 && f.abs() < 1e21 { format!("{}", f as i64) } else { f.to_string() }),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// 1 → 2: Legacy-Türen (`doors`) werden zu Öffnungen (`openings`, kind `door`).
fn migrate_doors(mut raw: Map<String, Value>) -> Map<String, Value> {
    let doors: Vec<Value> = raw.get("doors").and_then(Value::as_array).cloned().unwrap_or_default();
    raw.shift_remove("doors");
    if doors.is_empty() {
        return raw;
    }
    let mut openings: Vec<Value> = raw.get("openings").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut taken: std::collections::HashSet<String> = openings.iter().map(|o| o.get("id").map_or("undefined".to_string(), js_string)).collect();
    let door_type_id = raw
        .get("doorTypes")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|t| t.get("id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    for d in &doors {
        let mut id = d.get("id").map_or("undefined".to_string(), js_string);
        while taken.contains(&id) {
            id = format!("{id}-t");
        }
        taken.insert(id.clone());
        let mut o = Map::new();
        o.insert("id".into(), Value::String(id));
        o.insert("type".into(), "opening".into());
        for (k, src) in [("hostWallId", "hostWallId"), ("categoryCode", "categoryCode")] {
            if let Some(v) = d.get(src) {
                o.insert(k.into(), v.clone());
            }
        }
        o.insert("kind".into(), "door".into());
        for k in ["position", "width", "height"] {
            if let Some(v) = d.get(k) {
                o.insert(k.into(), v.clone());
            }
        }
        o.insert("sillHeight".into(), 0.into());
        for k in ["swing", "hinge"] {
            if let Some(v) = d.get(k) {
                o.insert(k.into(), v.clone());
            }
        }
        if let Some(t) = &door_type_id {
            o.insert("typeId".into(), Value::String(t.clone()));
        }
        openings.push(Value::Object(o));
    }
    raw.insert("openings".into(), Value::Array(openings));
    raw
}

/// Liest eine Projektdatei (Text) tolerant ein, migriert und prüft sie. `now_ms`: Zeitpunkt für
/// eine Ersatz-ID, falls die Datei keine trägt.
pub fn parse_project_file(text: &str, now_ms: f64) -> Parsed {
    match serde_json::from_str::<Value>(text) {
        Ok(raw) => parse_project_object(raw, now_ms),
        Err(e) => Parsed::Err(format!("Die Datei ist kein gültiges JSON ({e}).")),
    }
}

/// Wie [`parse_project_file`], für ein bereits geparstes Objekt.
pub fn parse_project_object(raw: Value, now_ms: f64) -> Parsed {
    let Value::Object(mut obj) = raw else { return Parsed::Err("Die Datei enthält kein Dossier-Projekt.".into()) };
    let mut warnings: Vec<String> = Vec::new();

    let mut version: u64 = 0;
    if let Some(v) = obj.get("formatVersion") {
        match v.as_f64() {
            Some(f) if f.fract() == 0.0 && f >= 0.0 => version = f as u64,
            _ => return Parsed::Err(format!("Ungültige Formatversion „{}\".", js_string(v))),
        }
    }
    if version > PROJECT_FORMAT_VERSION {
        return Parsed::Err(format!(
            "Die Datei wurde mit einer neueren Dossier-Version gespeichert (Format {version}, dieses Programm kennt bis {PROJECT_FORMAT_VERSION}). Bitte Dossier aktualisieren."
        ));
    }
    for key in REQUIRED_ARRAYS {
        if !obj.get(key).is_some_and(Value::is_array) {
            return Parsed::Err(format!("Die Datei enthält kein Dossier-Projekt (Liste „{key}\" fehlt)."));
        }
    }

    let migrated_from = (version < PROJECT_FORMAT_VERSION).then_some(version);
    for i in version..PROJECT_FORMAT_VERSION {
        obj = match i {
            1 => migrate_doors(obj),
            _ => obj, // 0 → 1: Einführung von `formatVersion`; Inhalt unverändert.
        };
    }
    obj.insert("formatVersion".into(), PROJECT_FORMAT_VERSION.into());

    for key in DEFAULT_ARRAYS {
        match obj.get(key) {
            None => {
                obj.insert(key.into(), Value::Array(vec![]));
            }
            Some(Value::Array(_)) => {}
            Some(_) => {
                warnings.push(format!("Feld „{key}\" ist keine Liste und wurde geleert."));
                obj.insert(key.into(), Value::Array(vec![]));
            }
        }
    }
    if !obj.get("id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        obj.insert("id".into(), Value::String(format!("project-{}", to_base36(now_ms.max(0.0) as u64))));
    }
    if !obj.get("name").is_some_and(Value::is_string) {
        obj.insert("name".into(), Value::String(String::new()));
    }
    let unknown: Vec<&str> = obj.keys().map(String::as_str).filter(|k| !KNOWN_KEYS.contains(k)).collect();
    if !unknown.is_empty() {
        warnings.push(format!("Unbekannte Felder behalten: {}.", unknown.join(", ")));
    }
    Parsed::Ok { project: obj, warnings, migrated_from }
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("ASCII")
}

/// Serialisiert ein Projekt für die Datei: aktuelle Formatversion vorne, Einrückung 2.
pub fn serialize_project(project: &Map<String, Value>) -> String {
    let mut out = Map::new();
    out.insert("formatVersion".into(), PROJECT_FORMAT_VERSION.into());
    for (k, v) in project {
        if k != "formatVersion" {
            out.insert(k.clone(), v.clone());
        }
    }
    serde_json::to_string_pretty(&Value::Object(out)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal() -> Value {
        json!({"id":"p","name":"N","walls":[],"layers":[],"drawingLevels":[]})
    }

    #[test]
    fn alte_datei_wird_migriert_und_ergaenzt() {
        let Parsed::Ok { project, warnings, migrated_from } = parse_project_object(minimal(), 0.0) else { panic!() };
        assert_eq!(migrated_from, Some(0));
        assert_eq!(project["formatVersion"], 2);
        assert_eq!(project["lineStyles"], json!([]));
        assert!(warnings.is_empty());
    }

    #[test]
    fn neuere_und_kaputte_dateien_werden_abgelehnt() {
        let mut v = minimal();
        v["formatVersion"] = json!(99);
        assert!(matches!(parse_project_object(v, 0.0), Parsed::Err(m) if m.contains("neueren")));
        let mut v = minimal();
        v["formatVersion"] = json!("x");
        assert_eq!(parse_project_object(v, 0.0), Parsed::Err("Ungültige Formatversion „x\".".into()));
        assert!(matches!(parse_project_object(json!([1]), 0.0), Parsed::Err(_)));
        assert!(matches!(parse_project_object(json!({"walls":[]}), 0.0), Parsed::Err(m) if m.contains("layers")));
        assert!(matches!(parse_project_file("{", 0.0), Parsed::Err(m) if m.starts_with("Die Datei ist kein gültiges JSON")));
    }

    #[test]
    fn tueren_werden_zu_oeffnungen() {
        let mut v = minimal();
        v["doors"] = json!([{"id":"D1","hostWallId":"W","categoryCode":"21","position":1,"width":0.9,"height":2,"swing":"left","hinge":"start"},{"id":"O1","hostWallId":"W","position":0,"width":1,"height":2}]);
        v["openings"] = json!([{"id":"O1"}]);
        v["doorTypes"] = json!([{"id":"dt"}]);
        let Parsed::Ok { project, .. } = parse_project_object(v, 0.0) else { panic!() };
        assert!(!project.contains_key("doors"));
        let o = project["openings"].as_array().unwrap();
        assert_eq!(o.len(), 3);
        assert_eq!(o[1]["id"], "D1");
        assert_eq!(o[1]["kind"], "door");
        assert_eq!(o[1]["typeId"], "dt");
        assert_eq!(o[2]["id"], "O1-t");
    }

    #[test]
    fn unbekannte_felder_bleiben_und_werden_gemeldet() {
        let mut v = minimal();
        v["zukunft"] = json!(1);
        v["hatches"] = json!("kaputt");
        let Parsed::Ok { project, warnings, .. } = parse_project_object(v, 0.0) else { panic!() };
        assert_eq!(project["zukunft"], 1);
        assert_eq!(warnings.len(), 2);
    }

    #[test]
    fn ersatz_id_aus_zeit() {
        let mut v = minimal();
        v["id"] = json!("");
        let Parsed::Ok { project, .. } = parse_project_object(v, 36.0 * 36.0 + 5.0) else { panic!() };
        assert_eq!(project["id"], "project-105");
    }

    #[test]
    fn serialisierung_setzt_version_nach_vorn() {
        let Value::Object(m) = minimal() else { panic!() };
        let s = serialize_project(&m);
        assert!(s.starts_with("{\n  \"formatVersion\": 2,\n  \"id\": \"p\""));
    }
}
