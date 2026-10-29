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
const KNOWN_KEYS: [&str; 47] = [
    "formatVersion", "id", "name", "lineStyles", "textStyles", "hatches", "components", "wallTypes",
    "ceilingTypes", "roofTypes", "blockDefs", "doorTypes", "windowTypes", "stairTypes", "pens",
    "penSets", "activePenSetId", "customPalettes", "builtinPaletteBanks", "drawingLevels", "layers",
    "walls", "ceilings", "roofs", "openings", "stairs", "rooms", "drawings2d", "context",
    "extrudedSolids", "columns", "groups", "parametricWalls", "overrideRules", "viewSnapshots",
    "viewSnapshotFolders", "layouts", "masterLayouts", "layoutFolders", "referenceElevationMasl",
    "geoAnchor", "roomProgram", "roomProgramTolerance", "parcelArea", "sunStudy", "siteRules", "scaleLineWeights",
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
        Value::Number(n) => n.as_f64().map_or(n.to_string(), crate::js_fmt::js_number),
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
        Ok(mut raw) => {
            js_key_order(&mut raw);
            parse_project_object(raw, now_ms)
        }
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
            Some(f) if f.fract() == 0.0 && f >= 0.0 => {
                if f > PROJECT_FORMAT_VERSION as f64 {
                    return Parsed::Err(format!(
                        "Die Datei wurde mit einer neueren Dossier-Version gespeichert (Format {}, dieses Programm kennt bis {PROJECT_FORMAT_VERSION}). Bitte Dossier aktualisieren.",
                        crate::js_fmt::js_number(f)
                    ));
                }
                version = f as u64;
            }
            _ => return Parsed::Err(format!("Ungültige Formatversion „{}\".", js_string(v))),
        }
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

/// Serialisiert ein Projekt für die Datei: aktuelle Formatversion vorne, Einrückung 2 — Zeichen für
/// Zeichen wie `JSON.stringify({ formatVersion, ...rest }, null, 2)` (Zahlen über [`JsFormatter`]).
pub fn serialize_project(project: &Map<String, Value>) -> String {
    to_js_json_pretty(&FileView(project))
}

/// Das Projekt mit `formatVersion` vorn, ohne Kopie des Baums.
struct FileView<'a>(&'a Map<String, Value>);

impl serde::Serialize for FileView<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let n = self.0.len() + usize::from(!self.0.contains_key("formatVersion"));
        let mut m = s.serialize_map(Some(n))?;
        m.serialize_entry("formatVersion", &PROJECT_FORMAT_VERSION)?;
        for (k, v) in self.0 {
            if k != "formatVersion" {
                m.serialize_entry(k, v)?;
            }
        }
        m.end()
    }
}

/// `JSON.stringify(v, null, 2)`: Einrückung 2, Zahlen wie JS `String(n)` (`0.000005` statt `5e-6`,
/// `1e+21`, `-0` → `0`; ganze Zahlen über 2⁵³ so gerundet, wie JS sie liest).
pub fn to_js_json_pretty<T: serde::Serialize + ?Sized>(v: &T) -> String {
    let mut buf = Vec::with_capacity(1 << 16);
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, JsFormatter(serde_json::ser::PrettyFormatter::with_indent(b"  ")));
    if v.serialize(&mut ser).is_err() {
        return String::new();
    }
    String::from_utf8(buf).unwrap_or_default()
}

/// Formatierer mit den Zahlen von JS (`js_fmt::js_number`), sonst wie `PrettyFormatter`.
struct JsFormatter<'a>(serde_json::ser::PrettyFormatter<'a>);

/// Ganze Zahlen ab hier liest JS nicht mehr exakt (2⁵³).
const JS_SAFE: u64 = 1 << 53;

impl serde_json::ser::Formatter for JsFormatter<'_> {
    fn write_f64<W: ?Sized + std::io::Write>(&mut self, w: &mut W, value: f64) -> std::io::Result<()> {
        // JSON.stringify schreibt nicht-endliche Zahlen als null (kommen im Dokument nicht vor).
        if value == 0.0 {
            w.write_all(b"0")
        } else if (1e-6..1e21).contains(&value.abs()) {
            // Schneller Weg: Rusts `Display` schreibt hier dieselbe kürzeste Ziffernfolge ohne
            // Exponent wie JS (Test `zahlen_und_einrueckung_wie_json_stringify`, `js_number` als Gegenprobe).
            write!(w, "{value}")
        } else if value.is_finite() {
            w.write_all(crate::js_fmt::js_number(value).as_bytes())
        } else {
            w.write_all(b"null")
        }
    }
    fn write_u64<W: ?Sized + std::io::Write>(&mut self, w: &mut W, value: u64) -> std::io::Result<()> {
        if value > JS_SAFE {
            self.write_f64(w, value as f64)
        } else {
            w.write_all(value.to_string().as_bytes())
        }
    }
    fn write_i64<W: ?Sized + std::io::Write>(&mut self, w: &mut W, value: i64) -> std::io::Result<()> {
        if value.unsigned_abs() > JS_SAFE {
            self.write_f64(w, value as f64)
        } else {
            w.write_all(value.to_string().as_bytes())
        }
    }
    fn begin_array<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        self.0.begin_array(w)
    }
    fn end_array<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        self.0.end_array(w)
    }
    fn begin_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        self.0.begin_array_value(w, first)
    }
    fn end_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        self.0.end_array_value(w)
    }
    fn begin_object<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        self.0.begin_object(w)
    }
    fn end_object<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        self.0.end_object(w)
    }
    fn begin_object_key<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        self.0.begin_object_key(w, first)
    }
    fn begin_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        self.0.begin_object_value(w)
    }
    fn end_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        self.0.end_object_value(w)
    }
}

/// Ob `k` ein Array-Index-Schlüssel ist (`"0"`, `"12"` …, < 2³² − 1): solche Schlüssel stellt ein
/// JS-Objekt vor alle anderen, aufsteigend nach Zahl.
fn index_key(k: &str) -> Option<u32> {
    if k.is_empty() || k.len() > 10 || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u64>().ok().filter(|&n| n < u32::MAX as u64).map(|n| n as u32)
}

/// Bringt die Schlüssel aller Objekte in die Reihenfolge, die `JSON.parse` in JS liefert
/// (Array-Index-Schlüssel zuerst, aufsteigend; sonst Einfüge-Reihenfolge). So schreibt das Speichern
/// eine geladene Datei genau wie die frühere TS-Fassung (`JSON.parse` → `JSON.stringify`).
pub fn js_key_order(v: &mut Value) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(js_key_order),
        Value::Object(m) => {
            m.values_mut().for_each(js_key_order);
            if m.keys().any(|k| index_key(k).is_some()) {
                let mut entries: Vec<(String, Value)> = std::mem::take(m).into_iter().collect();
                // Stabil: Index-Schlüssel nach Zahl vorn, die übrigen in ihrer Reihenfolge dahinter.
                entries.sort_by_key(|(k, _)| index_key(k).map_or((1, 0), |n| (0, n)));
                m.extend(entries);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `KNOWN_KEYS` = Felder von `Project` im Rust-Modell ([K4] S4: das Modell ist die Quelle).
    #[test]
    fn bekannte_felder_aus_dem_modell() {
        let mut model = crate::model::ts_export::object_keys::<crate::model::Project>();
        let mut known: Vec<String> = KNOWN_KEYS.iter().map(|k| k.to_string()).collect();
        model.sort();
        known.sort();
        assert_eq!(known, model, "KNOWN_KEYS an die Felder von model::Project angleichen");
    }

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
        // Meldung mit der Zahl wie JS `String(n)`.
        let mut v = minimal();
        v["formatVersion"] = json!(1e21);
        assert!(matches!(parse_project_object(v, 0.0), Parsed::Err(m) if m.contains("(Format 1e+21,")));
        let mut v = minimal();
        v["formatVersion"] = json!(1e-7);
        assert_eq!(parse_project_object(v, 0.0), Parsed::Err("Ungültige Formatversion „1e-7\".".into()));
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
    fn zahlen_und_einrueckung_wie_json_stringify() {
        let text = r#"{"a":[0.000005,1.5e-7,1e21,123456789012345680000,9007199254740993,-9007199254740993,1.0,-0.0,3,[],{}],"b":{"c":"x\u0001\n é\u007f"}}"#;
        let v: Value = serde_json::from_str(text).unwrap();
        // Erwartet = JSON.stringify(JSON.parse(text), null, 2) in Node.
        let want = "{\n  \"a\": [\n    0.000005,\n    1.5e-7,\n    1e+21,\n    123456789012345680000,\n    9007199254740992,\n    -9007199254740992,\n    1,\n    0,\n    3,\n    [],\n    {}\n  ],\n  \"b\": {\n    \"c\": \"x\\u0001\\n\u{2028}é\u{7f}\"\n  }\n}";
        assert_eq!(to_js_json_pretty(&v), want);
    }

    #[test]
    fn schneller_zahlenweg_gleich_js_number() {
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        for i in 0..200_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            // Zufällige Bitmuster und gerundete Werte über alle Grössenordnungen.
            let v = if i % 2 == 0 { f64::from_bits(x) } else { ((x % 2_000_001) as f64 - 1e6) * 10f64.powi((x % 40) as i32 - 20) };
            if !v.is_finite() {
                continue;
            }
            let s = to_js_json_pretty(&serde_json::json!(v));
            assert_eq!(s, crate::js_fmt::js_number(v), "{v:e}");
        }
    }

    #[test]
    fn schluessel_reihenfolge_wie_js_objekt() {
        let mut v: Value = serde_json::from_str(r#"{"b":1,"21":2,"a":{"x":1,"10":2,"2":3,"01":4,"4294967295":5,"4294967294":6},"3":0}"#).unwrap();
        js_key_order(&mut v);
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        // Erwartet = Object.keys(JSON.parse(…)) in Node.
        assert_eq!(keys(&v), ["3", "21", "b", "a"]);
        assert_eq!(keys(&v["a"]), ["2", "10", "4294967294", "x", "01", "4294967295"]);
    }

    #[test]
    fn serialisierung_setzt_version_nach_vorn() {
        let Value::Object(m) = minimal() else { panic!() };
        let s = serialize_project(&m);
        assert!(s.starts_with("{\n  \"formatVersion\": 2,\n  \"id\": \"p\""));
    }
}
