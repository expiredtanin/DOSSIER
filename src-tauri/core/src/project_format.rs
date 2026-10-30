//! Projektdatei-Format (`.obp`/`.obpt`/Alt-`.json`) ([K4] S4-Vorarbeit, vorher
//! `src/io/projectFormat.ts`): Versionierung, Migration und EIN Parser für alle Ladestellen.
//!
//! Regeln: jede gespeicherte Datei trägt `formatVersion`; ältere Dateien (auch ohne = Version 0)
//! laufen durch die Migrationskette; neuere werden mit klarer Meldung ABGELEHNT; tolerant gelesen
//! (fehlende Listen leer ergänzt, unbekannte Felder bleiben erhalten und werden gemeldet). Alles
//! arbeitet auf dem rohen JSON-Baum — das Modell wird erst danach typisiert.

use serde_json::{Map, Value};

/// Aktuelle Version des Dateiformats. Bei jeder Formatänderung erhöhen + Migration anhängen.
pub const PROJECT_FORMAT_VERSION: u64 = 4;

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

use crate::js_fmt::js_string;

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

/// Kategorie für Blatt-Zeichnungen aus der Migration: „50" (Text), sonst die erste Kategorie.
fn sheet_category(raw: &Map<String, Value>) -> String {
    fn walk(v: &Value, out: &mut Vec<String>) {
        for c in v.as_array().into_iter().flatten() {
            if let Some(code) = c.get("code").and_then(Value::as_str) {
                out.push(code.to_string());
            }
            if let Some(ch) = c.get("children") {
                walk(ch, out);
            }
        }
    }
    let mut codes = Vec::new();
    if let Some(l) = raw.get("layers") {
        walk(l, &mut codes);
    }
    if codes.iter().any(|c| c == "50") {
        return "50".into();
    }
    codes.into_iter().next().unwrap_or_else(|| "50".into())
}

/// Papier-mm (x, y nach unten) → Blatt-Ebene (Meter, y nach oben), s. `DrawingLevel.layoutId`.
fn sheet_pt(x_mm: f64, y_mm: f64) -> Value {
    serde_json::json!({"x": x_mm / 1000.0, "y": -y_mm / 1000.0})
}

/// Eine Alt-Annotation (Papier-mm) als `geom` + Zusatzfelder einer 2D-Zeichnung; `None` = unlesbar.
fn annotation_geom(a: &Value) -> Option<(Value, Vec<(&'static str, Value)>)> {
    let n = |k: &str| a.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    let mut extra: Vec<(&'static str, Value)> = Vec::new();
    let color = a.get("color").and_then(Value::as_str).unwrap_or("#111111").to_string();
    let kind = a.get("kind").and_then(Value::as_str)?;
    let geom = match kind {
        "line" => {
            extra.push(("color", Value::String(color)));
            extra.push(("weightMm", n("weightMm").unwrap_or(0.25).into()));
            serde_json::json!({"shape": "line", "a": sheet_pt(n("x1Mm")?, n("y1Mm")?), "b": sheet_pt(n("x2Mm")?, n("y2Mm")?)})
        }
        "rect" | "image" => {
            let (x, y, w, h) = (n("xMm")?, n("yMm")?, n("widthMm")?, n("heightMm")?);
            let (x0, x1) = (x.min(x + w), x.max(x + w));
            let (y0, y1) = (y.min(y + h), y.max(y + h));
            let (min, max) = (sheet_pt(x0, y1), sheet_pt(x1, y0));
            if kind == "rect" {
                extra.push(("color", Value::String(color)));
                extra.push(("weightMm", n("weightMm").unwrap_or(0.25).into()));
                serde_json::json!({"shape": "rect", "min": min, "max": max})
            } else {
                let mut g = serde_json::json!({"shape": "image", "min": min, "max": max, "src": a.get("src").and_then(Value::as_str)?});
                if let Some(o) = n("opacity") {
                    g["opacity"] = o.into();
                }
                g
            }
        }
        "text" => {
            extra.push(("color", Value::String(color)));
            let mut g = serde_json::json!({
                "shape": "text",
                "at": sheet_pt(n("xMm")?, n("yMm")?),
                "text": a.get("text").and_then(Value::as_str).unwrap_or_default(),
                "height": n("heightMm")? / 1000.0,
                "angle": 0,
            });
            if let Some(w) = n("widthMm").filter(|w| *w > 0.0) {
                g["width"] = (w / 1000.0).into();
            }
            if let Some(d) = a.get("doc").filter(|d| d.is_object()) {
                g["doc"] = d.clone();
            }
            g
        }
        _ => return None,
    };
    Some((geom, extra))
}

/// 2 → 3: Blatt-Zeichnungen sind gewöhnliche 2D-Zeichnungen auf einer Blatt-Ebene
/// (`DrawingLevel.layoutId`) statt eigener `Layout.annotations` in Papier-mm. Jedes Layout bekommt
/// seine Blatt-Ebene; Linie/Rechteck/Text/Bild werden zu `line`/`rect`/`text`/`image`.
fn migrate_layout_annotations(mut raw: Map<String, Value>) -> Map<String, Value> {
    let Some(Value::Array(mut layouts)) = raw.get("layouts").cloned() else { return raw };
    let mut levels: Vec<Value> = raw.get("drawingLevels").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut drawings: Vec<Value> = raw.get("drawings2d").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut level_ids: std::collections::HashSet<String> =
        levels.iter().filter_map(|l| l.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
    let mut drawing_ids: std::collections::HashSet<String> =
        drawings.iter().filter_map(|d| d.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
    let cat = sheet_category(&raw);
    for lay in layouts.iter_mut() {
        let Some(lay) = lay.as_object_mut() else { continue };
        let annotations = lay.shift_remove("annotations");
        let Some(layout_id) = lay.get("id").and_then(Value::as_str).map(str::to_owned) else { continue };
        let existing = levels
            .iter()
            .find(|l| l.get("layoutId").and_then(Value::as_str) == Some(layout_id.as_str()))
            .and_then(|l| l.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let level_id = match existing {
            Some(id) => id,
            None => {
                let mut id = format!("sheet-{layout_id}");
                while level_ids.contains(&id) {
                    id.push_str("-s");
                }
                level_ids.insert(id.clone());
                let name = lay.get("name").and_then(Value::as_str).unwrap_or_default();
                levels.push(serde_json::json!({"id": id, "name": name, "kind": "drawing", "visible": true, "locked": false, "layoutId": layout_id}));
                id
            }
        };
        for a in annotations.as_ref().and_then(Value::as_array).into_iter().flatten() {
            let Some((geom, extra)) = annotation_geom(a) else { continue };
            let mut id = a.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("ann").to_string();
            while drawing_ids.contains(&id) {
                id.push_str("-a");
            }
            drawing_ids.insert(id.clone());
            let mut d = Map::new();
            d.insert("id".into(), Value::String(id));
            d.insert("type".into(), "drawing2d".into());
            d.insert("levelId".into(), Value::String(level_id.clone()));
            d.insert("categoryCode".into(), Value::String(cat.clone()));
            d.insert("geom".into(), geom);
            for (k, v) in extra {
                d.insert(k.into(), v);
            }
            drawings.push(Value::Object(d));
        }
    }
    raw.insert("layouts".into(), Value::Array(layouts));
    raw.insert("drawingLevels".into(), Value::Array(levels));
    raw.insert("drawings2d".into(), Value::Array(drawings));
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

/// Name ohne angehängte Strichstärke („Volllinie 0.13" → „Volllinie", „Schraffurlinie 0.10 mm" →
/// „Schraffurlinie"); sonst unverändert.
fn strip_weight_suffix(name: &str) -> String {
    let t = name.trim_end();
    let t = t.strip_suffix("mm").map_or(t, str::trim_end);
    let Some(pos) = t.rfind(' ') else { return name.to_string() };
    let tail = &t[pos + 1..];
    if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') && tail.chars().any(|c| c.is_ascii_digit()) {
        t[..pos].trim_end().to_string()
    } else {
        name.to_string()
    }
}

/// 3 → 4 ([110]): Linienstile tragen keine Strichstärke mehr. Das alte `LineStyle.weight` wandert an
/// die Verwender — Schraffur (`lineWeight`), Schichtfuge der Aufbauten (`jointWeightMm`), 2D-Element
/// (`weightMm`, nur wo es vorher galt: kein eigenes `weightMm`, Quelle nicht „layer") und Override-
/// Aktion (`lineweight`) —, damit Pläne gleich aussehen. Danach werden Stile, die sich nur in der
/// Stärke unterschieden, zu einem zusammengeführt (erster gewinnt, Name ohne Stärke-Anhang).
fn migrate_line_weights(mut raw: Map<String, Value>) -> Map<String, Value> {
    let Some(Value::Array(styles)) = raw.get("lineStyles").cloned() else { return raw };
    let mut weight: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    // Gruppen gleicher Stile ohne id/Name/Stärke → kanonische id.
    let mut canon: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut by_key: Vec<(String, String)> = Vec::new();
    let mut kept: Vec<Value> = Vec::new();
    for st in styles {
        let Value::Object(mut o) = st else {
            kept.push(st);
            continue;
        };
        let id = o.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(w) = o.get("weight").and_then(Value::as_f64).filter(|w| w.is_finite()) {
            weight.insert(id.clone(), w);
        }
        o.shift_remove("weight");
        let mut key_obj = o.clone();
        key_obj.shift_remove("id");
        key_obj.shift_remove("name");
        if key_obj.get("dash").is_some_and(Value::is_null) {
            key_obj.shift_remove("dash");
        }
        let key = Value::Object(key_obj).to_string();
        if let Some((_, first)) = by_key.iter().find(|(k, _)| *k == key) {
            if !id.is_empty() {
                canon.insert(id, first.clone());
            }
            continue;
        }
        if let Some(n) = o.get("name").and_then(Value::as_str) {
            // Ohne Stärke-Anhang, solange der Name dadurch nicht doppelt wird.
            let stripped = strip_weight_suffix(n);
            if !kept.iter().any(|k| k.get("name").and_then(Value::as_str) == Some(stripped.as_str())) {
                o.insert("name".into(), stripped.into());
            }
        }
        by_key.push((key, id));
        kept.push(Value::Object(o));
    }
    raw.insert("lineStyles".into(), Value::Array(kept));
    let canon_of = |id: &str| canon.get(id).cloned().unwrap_or_else(|| id.to_string());
    let weight_of = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(|id| weight.get(id).copied());
    let num = |w: f64| serde_json::Number::from_f64(w).map(Value::Number);
    let redirect = |o: &mut Map<String, Value>, key: &str| {
        if let Some(Value::String(id)) = o.get(key) {
            let c = canon_of(id);
            o.insert(key.into(), c.into());
        }
    };
    // Schraffuren.
    if let Some(Value::Array(hs)) = raw.get_mut("hatches") {
        for h in hs.iter_mut().filter_map(Value::as_object_mut) {
            if !h.contains_key("lineWeight") {
                if let Some(w) = weight_of(h.get("lineStyleId")).and_then(num) {
                    h.insert("lineWeight".into(), w);
                }
            }
            redirect(h, "lineStyleId");
        }
    }
    // Schichtfugen der Aufbauten.
    for key in ["wallTypes", "ceilingTypes", "roofTypes"] {
        let Some(Value::Array(ts)) = raw.get_mut(key) else { continue };
        for t in ts.iter_mut().filter_map(Value::as_object_mut) {
            let Some(Value::Array(ls)) = t.get_mut("layers") else { continue };
            for l in ls.iter_mut().filter_map(Value::as_object_mut) {
                if !l.contains_key("jointWeightMm") {
                    if let Some(w) = weight_of(l.get("jointLineStyleId")).and_then(num) {
                        l.insert("jointWeightMm".into(), w);
                    }
                }
                redirect(l, "jointLineStyleId");
            }
        }
    }
    // 2D-Elemente.
    if let Some(Value::Array(ds)) = raw.get_mut("drawings2d") {
        for d in ds.iter_mut().filter_map(Value::as_object_mut) {
            let layer_src = d.get("strokeWeightSource").and_then(Value::as_str) == Some("layer");
            if !layer_src && !d.get("weightMm").is_some_and(Value::is_number) {
                if let Some(w) = weight_of(d.get("lineStyleId")).and_then(num) {
                    d.insert("weightMm".into(), w);
                }
            }
            redirect(d, "lineStyleId");
        }
    }
    // Override-Regeln.
    if let Some(Value::Array(rs)) = raw.get_mut("overrideRules") {
        for r in rs.iter_mut().filter_map(Value::as_object_mut) {
            let Some(Value::Object(a)) = r.get_mut("actions") else { continue };
            if !a.get("lineweight").is_some_and(Value::is_number) {
                if let Some(w) = weight_of(a.get("linetypeId")).and_then(num) {
                    a.insert("lineweight".into(), w);
                }
            }
            redirect(a, "linetypeId");
        }
    }
    raw
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
            2 => migrate_layout_annotations(obj),
            3 => migrate_line_weights(obj),
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

    /// [110]: Stärke wandert vom Linienstil an Schraffur, Fuge, Element und Override; Stile, die sich
    /// nur in der Stärke unterscheiden, werden eins.
    #[test]
    fn linienstaerke_wandert_an_die_verwender() {
        let v = json!({"formatVersion": 3, "id":"p","name":"N","walls":[],"layers":[],"drawingLevels":[],
            "lineStyles": [
                {"id":"hair","name":"Volllinie 0.02","weight":0.02,"color":"#1a1a1a","dash":null},
                {"id":"thin","name":"Volllinie 0.13","weight":0.13,"color":"#1a1a1a","dash":null},
                {"id":"thick","name":"Volllinie 0.5 mm","weight":0.5,"color":"#1a1a1a"},
                {"id":"dash","name":"Strich","weight":0.02,"color":"#1a1a1a","dash":[1,0.7]},
                {"id":"dark","name":"Volllinie 0.5","weight":0.5,"color":"#0a0a0a","dash":null}
            ],
            "hatches": [
                {"id":"h1","name":"A","pattern":"diagonal","scale":1,"angle":45,"color":"#000","lineStyleId":"hair"},
                {"id":"h2","name":"B","pattern":"diagonal","scale":1,"angle":45,"color":"#000","lineStyleId":"thick","lineWeight":0.18},
                {"id":"h3","name":"C","pattern":"diagonal","scale":1,"angle":45,"color":"#000"}
            ],
            "wallTypes": [{"id":"w","name":"W","layers":[{"componentId":"c","thickness":0.1,"jointLineStyleId":"thin"},{"componentId":"c","thickness":0.1}]}],
            "roofTypes": [{"id":"r","name":"R","layers":[{"componentId":"c","thickness":0.1,"jointLineStyleId":"dash"}]}],
            "drawings2d": [
                {"id":"d1","lineStyleId":"thick"},
                {"id":"d2","lineStyleId":"thick","weightMm":0.7},
                {"id":"d3","lineStyleId":"thick","strokeWeightSource":"layer"}
            ],
            "overrideRules": [{"id":"o","actions":{"linetypeId":"thin"}}]
        });
        let Parsed::Ok { project: p, migrated_from, .. } = parse_project_object(v, 0.0) else { panic!() };
        assert_eq!(migrated_from, Some(3));
        assert_eq!(p["lineStyles"], json!([
            {"id":"hair","name":"Volllinie","color":"#1a1a1a","dash":null},
            {"id":"dash","name":"Strich","color":"#1a1a1a","dash":[1,0.7]},
            {"id":"dark","name":"Volllinie 0.5","color":"#0a0a0a","dash":null}
        ]));
        assert_eq!(p["hatches"][0]["lineWeight"], json!(0.02));
        assert_eq!(p["hatches"][1]["lineWeight"], json!(0.18));
        assert_eq!(p["hatches"][1]["lineStyleId"], json!("hair"));
        assert!(p["hatches"][2].get("lineWeight").is_none());
        let wl = &p["wallTypes"][0]["layers"];
        assert_eq!((wl[0]["jointWeightMm"].clone(), wl[0]["jointLineStyleId"].clone()), (json!(0.13), json!("hair")));
        assert!(wl[1].get("jointWeightMm").is_none());
        assert_eq!(p["roofTypes"][0]["layers"][0]["jointWeightMm"], json!(0.02));
        let d = &p["drawings2d"];
        assert_eq!((d[0]["weightMm"].clone(), d[0]["lineStyleId"].clone()), (json!(0.5), json!("hair")));
        assert_eq!(d[1]["weightMm"], json!(0.7));
        assert!(d[2].get("weightMm").is_none());
        assert_eq!(p["overrideRules"][0]["actions"], json!({"linetypeId":"hair","lineweight":0.13}));
    }

    #[test]
    fn staerke_anhang_im_namen() {
        assert_eq!(strip_weight_suffix("Volllinie 0.13"), "Volllinie");
        assert_eq!(strip_weight_suffix("Schraffurlinie 0.10 mm"), "Schraffurlinie");
        assert_eq!(strip_weight_suffix("Strichlinie fein"), "Strichlinie fein");
        assert_eq!(strip_weight_suffix("PDF-Strich 1.05/0.7"), "PDF-Strich 1.05/0.7");
    }

    #[test]
    fn alte_datei_wird_migriert_und_ergaenzt() {
        let Parsed::Ok { project, warnings, migrated_from } = parse_project_object(minimal(), 0.0) else { panic!() };
        assert_eq!(migrated_from, Some(0));
        assert_eq!(project["formatVersion"], 4);
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
    fn layout_annotationen_werden_blatt_zeichnungen() {
        let mut v = minimal();
        v["formatVersion"] = json!(2);
        v["layers"] = json!([{"code": "20", "children": [{"code": "50"}]}]);
        v["drawings2d"] = json!([{"id": "a1", "levelId": "eg"}]);
        v["layouts"] = json!([
            {"id": "L1", "name": "Blatt 1", "paper": "a3", "orientation": "landscape", "viewports": [], "annotations": [
                {"kind": "line", "id": "a1", "x1Mm": 10, "y1Mm": 20, "x2Mm": 110, "y2Mm": 20, "weightMm": 0.5},
                {"kind": "rect", "id": "a2", "xMm": 10, "yMm": 20, "widthMm": 50, "heightMm": 30, "color": "#ff0000"},
                {"kind": "text", "id": "a3", "xMm": 5, "yMm": 7, "text": "Hallo", "heightMm": 3.5, "widthMm": 40},
                {"kind": "image", "id": "a4", "xMm": 0, "yMm": 0, "widthMm": 20, "heightMm": 10, "src": "data:image/png;base64,AA", "opacity": 0.5},
                {"kind": "line", "id": "kaputt", "x1Mm": "x"}
            ]},
            {"id": "L2", "name": "Blatt 2", "paper": "a4", "orientation": "portrait", "viewports": []}
        ]);
        let Parsed::Ok { project, migrated_from, .. } = parse_project_object(v, 0.0) else { panic!() };
        assert_eq!(migrated_from, Some(2));
        assert!(project["layouts"][0].get("annotations").is_none());
        let levels = project["drawingLevels"].as_array().unwrap();
        assert_eq!(levels.len(), 2, "jedes Layout bekommt seine Blatt-Ebene");
        assert_eq!(levels[0], json!({"id": "sheet-L1", "name": "Blatt 1", "kind": "drawing", "visible": true, "locked": false, "layoutId": "L1"}));
        assert_eq!(levels[1]["layoutId"], "L2");
        let d = project["drawings2d"].as_array().unwrap();
        assert_eq!(d.len(), 5, "kaputte Annotation fällt weg");
        assert_eq!(d[1]["id"], "a1-a", "ID-Kollision mit bestehender Zeichnung");
        assert_eq!(d[1]["levelId"], "sheet-L1");
        assert_eq!(d[1]["categoryCode"], "50");
        assert_eq!(d[1]["geom"], json!({"shape": "line", "a": {"x": 0.01, "y": -0.02}, "b": {"x": 0.11, "y": -0.02}}));
        assert_eq!(d[1]["weightMm"], 0.5);
        assert_eq!(d[2]["geom"], json!({"shape": "rect", "min": {"x": 0.01, "y": -0.05}, "max": {"x": 0.06, "y": -0.02}}));
        assert_eq!(d[2]["color"], "#ff0000");
        assert_eq!(d[3]["geom"]["at"], json!({"x": 0.005, "y": -0.007}));
        assert_eq!(d[3]["geom"]["height"], 0.0035);
        assert_eq!(d[3]["geom"]["width"], 0.04);
        assert_eq!(d[4]["geom"]["src"], "data:image/png;base64,AA");
        assert_eq!(d[4]["geom"]["max"]["x"], 0.02);
        assert_eq!(d[4]["geom"]["min"]["y"], -0.01);
        // Schon migriert: ein zweiter Lauf ändert nichts mehr.
        let mut again = project.clone();
        again.insert("formatVersion".into(), json!(2));
        let Parsed::Ok { project: p2, .. } = parse_project_object(Value::Object(again), 0.0) else { panic!() };
        assert_eq!(p2, project);
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
        assert!(s.starts_with("{\n  \"formatVersion\": 4,\n  \"id\": \"p\""));
    }
}
