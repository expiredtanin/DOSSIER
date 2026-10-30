//! Objekt-Info der Auswahl ([K4] S3, vorher `deriveSelection` in `src/state/selectionInfo.ts`): die
//! anzeigefertigen, effektiv aufgelösten Attribute des ERSTEN gewählten Elements für die Paletten
//! (Attribute, Objekt-Info) — Farbe/Strichstärke/Schraffur nach derselben Kette wie der Plan, Masse,
//! Flächen, Volumen, UK/OK, die Listen der Dropdowns (Wand-/Deckentypen, Geschosse, Layouts) und je
//! Bauteilart die eigenen Felder. Ausgabe: JSON in der Form `Selection` (TS), Schlüssel in der
//! Reihenfolge der früheren Objekt-Literale, fehlende (`undefined`) Felder weggelassen.
//!
//! Rechnung auf der rohen Projekt-Wurzel (verlustfrei, keine typisierte Sicht des ganzen Projekts —
//! nach einem Mausschritt an einer grossen Liste wäre deren Neueinlesen teurer als die Abfrage). Nur das
//! gewählte Dach, die Treppe und die Stütze werden typisiert gelesen, wo die Geometrie schon typisiert im
//! Kern steht (`roof.rs`, `stair.rs`, `model3d::column_footprint`). Zahlen wie in JS: `null` rechnet wie
//! 0 (`grips::num_of`), nicht endliche Ergebnisse reisen als Marken (`grips::js_num`).
//!
//! Wo TS warf (unbekannter Wandtyp, Deckentyp oder Bauteil), kommt dieselbe Meldung als Fehler.
//! Der B-Rep-Körper einer Extrusion (`spec`) bleibt in TS (truck-Pipeline, `plan/extrudedSolidSpec.ts`).

use crate::document::Lookup;
use crate::model::helpers::heights;
use crate::grips::{arr, field, js_num, num_of, truthy, xy};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::ops::id_of;
use serde_json::{Map, Value};

const WALL_FALLBACK_MM: f64 = 0.18;
const DRAW_FALLBACK_COLOR: &str = "#d0d0d0";
const WALL_FALLBACK_COLOR: &str = "#2b3039";
const EXTRUSION_COLOR: &str = "#d98c40";
const COLUMN_COLOR: &str = "#3a3f47";

/// Gewählte ids je Art (wie die Parameter von `deriveSelection`).
#[derive(serde::Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SelArgs {
    pub wall_ids: Vec<String>,
    pub drawing_id: Option<String>,
    pub ceiling_id: Option<String>,
    pub opening_id: Option<String>,
    pub stair_id: Option<String>,
    pub room_id: Option<String>,
    pub extruded_solid_id: Option<String>,
    pub column_id: Option<String>,
    pub roof_id: Option<String>,
    pub context_object_id: Option<String>,
}

// ── Hilfen ───────────────────────────────────────────────────────────────────

/// JSON-Text eines Werts. Die Antwort wird direkt als Text geschrieben (kein `Value`-Baum mit je
/// Schlüssel einer Zuteilung), durchgereichte Felder werden nur gelesen, nicht kopiert.
pub struct J(Vec<u8>);

impl J {
    fn null() -> J {
        J(b"null".to_vec())
    }
    fn arr(items: impl IntoIterator<Item = J>) -> J {
        let mut out = vec![b'['];
        for (i, it) in items.into_iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.extend(it.0);
        }
        out.push(b']');
        J(out)
    }
    pub fn into_string(self) -> String {
        String::from_utf8(self.0).unwrap_or_default()
    }
}

/// Etwas, das sich als JSON schreiben lässt (Wert, Text-Stück).
trait Emit {
    fn emit(&self, out: &mut Vec<u8>);
}
impl Emit for Value {
    fn emit(&self, out: &mut Vec<u8>) {
        let _ = serde_json::to_writer(out, self);
    }
}
impl Emit for J {
    fn emit(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.0);
    }
}
impl<T: Emit> Emit for &T {
    fn emit(&self, out: &mut Vec<u8>) {
        (*self).emit(out)
    }
}

/// Objekt in Schlüssel-Reihenfolge; `undefined` (None/fehlend) entfällt.
struct O(Vec<u8>);

impl Default for O {
    fn default() -> Self {
        O(vec![b'{'])
    }
}

impl O {
    fn key(&mut self, k: &str) {
        if self.0.len() > 1 {
            self.0.push(b',');
        }
        self.0.push(b'"');
        self.0.extend_from_slice(k.as_bytes());
        self.0.extend_from_slice(b"\":");
    }
    fn v(mut self, k: &str, v: impl Emit) -> Self {
        self.key(k);
        v.emit(&mut self.0);
        self
    }
    fn o(self, k: &str, v: Option<impl Emit>) -> Self {
        match v {
            Some(v) => self.v(k, v),
            None => self,
        }
    }
    fn n(self, k: &str, x: f64) -> Self {
        self.v(k, js_num(x))
    }
    fn s(self, k: &str, s: &str) -> Self {
        self.v(k, Value::from(s))
    }
    /// Feld `key` von `src` unverändert durchreichen (fehlend = `undefined`).
    fn raw(self, k: &str, src: &Value, key: &str) -> Self {
        self.o(k, field(src, key))
    }
    fn done(mut self) -> J {
        self.0.push(b'}');
        J(self.0)
    }
}

/// Erstes Element, dessen Feld `key` gleich `val` ist (`===`; fehlend gleich fehlend).
fn find_by<'a>(list: &'a [Value], key: &str, val: Option<&Value>) -> Option<&'a Value> {
    list.iter().find(|e| field(e, key) == val)
}

/// `a ?? b`: Wert, ausser fehlend/`null`.
fn nn(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// Kategorie (Ebene) per Code: erster Treffer der Tiefensuche (`findCategory`).
fn category<'a>(root: &'a Map<String, Value>, code: Option<&Value>) -> Option<&'a Value> {
    fn walk<'a>(list: &'a [Value], code: Option<&Value>) -> Option<&'a Value> {
        for c in list {
            if field(c, "code") == code {
                return Some(c);
            }
            if let Some(hit) = walk(arr(field(c, "children")), code) {
                return Some(hit);
            }
        }
        None
    }
    walk(arr(root.get("layers")), code)
}

/// `getComponent`: Bauteil per id oder Fehler (Meldung wie TS).
fn component<'a>(root: &'a Map<String, Value>, id: Option<&Value>) -> Result<&'a Value, String> {
    find_by(arr(root.get("components")), "id", id).ok_or_else(|| format!("Unbekanntes Bauteil-Material: {}", id.map_or("undefined".into(), |v| js_text(v))))
}

/// Wert in einer Template-Zeichenkette (`${v}`).
fn js_text(v: &Value) -> String {
    crate::js_fmt::js_string(v)
}

/// `x.color ?? cat?.color ?? fallback`.
fn color_of(el: &Value, cat: Option<&Value>, fallback: &str) -> Value {
    nn(field(el, "color")).or_else(|| cat.and_then(|c| nn(field(c, "color")))).cloned().unwrap_or_else(|| fallback.into())
}

/// Strichstärke `x ?? cat?.lw ?? fallback` (nur die Kategorie-Kette).
fn lw_or(over: Option<&Value>, cat: Option<&Value>, fallback: f64) -> Value {
    nn(over).or_else(|| cat.and_then(|c| nn(field(c, "lw")))).cloned().unwrap_or_else(|| js_num(fallback))
}

fn is_layer(src: Option<&Value>) -> bool {
    str_of(src) == Some("layer")
}

/// `resolveForeground`/`resolveBackground`: Override ?? (Quelle „layer" ⇒ Kategorie-Farbe) ?? Bauteil-Feld.
fn resolve_color(comp_field: Option<&Value>, over: Option<&Value>, cat: Option<&Value>, source: Option<&Value>) -> Option<Value> {
    if let Some(o) = nn(over) {
        return Some(o.clone());
    }
    if is_layer(source) {
        if let Some(c) = cat {
            return nn(field(c, "color")).cloned().or_else(|| comp_field.cloned());
        }
    }
    comp_field.cloned()
}

/// `resolveHatchId`: Override ?? (Quelle „layer" ⇒ Kategorie-Schraffur) ?? Rückfall.
fn resolve_hatch(over: Option<&Value>, source: Option<&Value>, cat: Option<&Value>, fallback: Option<&Value>) -> Option<Value> {
    if let Some(o) = nn(over) {
        return Some(o.clone());
    }
    if is_layer(source) {
        return cat.and_then(|c| nn(field(c, "hatch"))).or(fallback).cloned();
    }
    fallback.cloned()
}

/// Bauteil-Feld (`comp.foreground` …) als Rückfall, unverändert (auch `null`).
fn cf<'a>(comp: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    comp.and_then(|c| c.get(key))
}

/// Achsparallele bbox mit `Math.min/max`; nicht endlich → Null-Box.
fn bbox_of(pts: impl IntoIterator<Item = (f64, f64)>) -> [f64; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (x, y) in pts {
        x0 = jsnum::min(x0, x);
        y0 = jsnum::min(y0, y);
        x1 = jsnum::max(x1, x);
        y1 = jsnum::max(y1, y);
    }
    if !x0.is_finite() {
        return [0.0; 4];
    }
    [x0, y0, x1, y1]
}

fn bbox_value(b: [f64; 4]) -> J {
    O::default().n("minX", b[0]).n("minY", b[1]).n("maxX", b[2]).n("maxY", b[3]).done()
}

fn pts_of(v: Option<&Value>) -> Vec<(f64, f64)> {
    arr(v).iter().map(xy).collect()
}

fn ring(v: Option<&Value>) -> Vec<[f64; 2]> {
    arr(v).iter().map(|p| xy(p).into()).collect()
}

/// Polygonfläche (immer positiv, `polygonArea` = Raum-Bewertung im Kern).
fn polygon_area(v: Option<&Value>) -> f64 {
    crate::room_area::evaluate(&ring(v), 0.0).gross
}

/// Deckenfläche `|signedArea|` (kernel2d).
fn ceiling_area(v: Option<&Value>) -> f64 {
    let p: Vec<kernel2d::Vec2> = pts_of(v).into_iter().map(|(x, y)| kernel2d::Vec2::new(x, y)).collect();
    kernel2d::signed_area(&p).abs()
}

/// Summe der Schichtdicken (`wallTypeThickness`, `reduce` ab 0).
fn type_thickness(t: &Value) -> f64 {
    arr(field(t, "layers")).iter().fold(0.0, |s, l| s + num_of(field(l, "thickness")))
}

/// Geschosse (`kind === "floor"`) als `{id, name}`.
fn floors(root: &Map<String, Value>) -> J {
    J::arr(
        arr(root.get("drawingLevels"))
            .iter()
            .filter(|z| str_of(field(z, "kind")) == Some("floor"))
            .map(|z| O::default().raw("id", z, "id").raw("name", z, "name").done()),
    )
}

fn level<'a>(root: &'a Map<String, Value>, id: Option<&Value>) -> Option<&'a Value> {
    find_by(arr(root.get("drawingLevels")), "id", id)
}

/// `floor?.name ?? fallback`.
fn floor_name(floor: Option<&Value>, fallback: Option<&Value>) -> Option<Value> {
    floor.and_then(|f| nn(field(f, "name"))).or(fallback).cloned()
}

/// UK/OK-Bindung (`resolveAnchor`): absolutes Z oder `None` (Rückfall des Aufrufers).
fn anchor(root: &Map<String, Value>, a: Option<&Value>) -> Option<f64> {
    let a = a.filter(|a| truthy(Some(a)))?;
    if str_of(field(a, "mode")) == Some("custom") {
        // `return anchor.z` — fehlend/null fällt beim `??` des Aufrufers zurück.
        return nn(field(a, "z")).map(|z| num_of(Some(z)));
    }
    let f = level(root, field(a, "floorId"))?;
    Some(heights::floor_anchor(num_or(field(f, "baseElevation"), 0.0), num_or(field(a, "offset"), 0.0)))
}

fn num_or(v: Option<&Value>, d: f64) -> f64 {
    if nn(v).is_some() {
        num_of(v)
    } else {
        d
    }
}

/// (UK, OK) einer Wand oder Stütze: UK aus `bottom` sonst Geschoss-Basis, OK aus `top` sonst UK + Höhe.
fn vertical_extent(root: &Map<String, Value>, el: &Value) -> (f64, f64) {
    let floor_base = level(root, field(el, "floorId")).map_or(0.0, |f| num_or(field(f, "baseElevation"), 0.0));
    heights::element(floor_base, anchor(root, field(el, "bottom")), anchor(root, field(el, "top")), num_of(field(el, "height")))
}

/// (UK, OK) einer Decke (`ceilingVerticalExtent`): OK aus `top` sonst Geschoss-Oberkante (Basis + Höhe), UK aus
/// `bottom` sonst OK − `thickness` (die Decke wächst nach unten).
fn ceiling_extent(root: &Map<String, Value>, c: &Value, thickness: f64) -> (f64, f64) {
    let floor_top = level(root, field(c, "floorId")).map_or(0.0, |f| num_or(field(f, "baseElevation"), 0.0) + num_or(field(f, "floorHeight"), 0.0));
    heights::ceiling(floor_top, anchor(root, field(c, "bottom")), anchor(root, field(c, "top")), || thickness)
}

/// Anfrage `verticalExtents`: Wände und Decken als ganze Elemente (die 3D-Griffe zeigen auch gerade gezogene,
/// noch nicht übernommene Fassungen).
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct ExtentArgs {
    pub walls: Vec<Value>,
    pub ceilings: Vec<Value>,
}

/// (UK, OK) der Wände, dann der Decken, flach: `[zb, zt, zb, zt, …]`.
pub fn vertical_extents(root: &Map<String, Value>, a: &ExtentArgs) -> J {
    let walls = a.walls.iter().map(|w| vertical_extent(root, w));
    let ceilings = a.ceilings.iter().map(|c| ceiling_extent(root, c, ceiling_thickness(root, c)));
    J::arr(walls.chain(ceilings).flat_map(|(zb, zt)| [zb, zt]).map(|x| {
        let mut out = Vec::new();
        js_num(x).emit(&mut out);
        J(out)
    }))
}

/// Aufbau-Typ einer Decke (`getCeilingType`): eigener Deckentyp, sonst Alt-Wandtyp, sonst Fehler.
fn ceiling_type<'a>(root: &'a Map<String, Value>, c: &Value) -> Result<&'a Value, String> {
    if truthy(field(c, "ceilingTypeId")) {
        if let Some(t) = find_by(arr(root.get("ceilingTypes")), "id", field(c, "ceilingTypeId")) {
            return Ok(t);
        }
    }
    find_by(arr(root.get("wallTypes")), "id", field(c, "wallTypeId"))
        .ok_or_else(|| format!("Unbekannter Deckentyp: {}", nn(field(c, "ceilingTypeId")).or(field(c, "wallTypeId")).map_or("undefined".into(), js_text)))
}

/// Deckendicke (`ceilingThickness`): `thickness` > 0, sonst Typ-Dicke, sonst 0.2.
fn ceiling_thickness(root: &Map<String, Value>, c: &Value) -> f64 {
    if nn(field(c, "thickness")).is_some() && num_of(field(c, "thickness")) > 0.0 {
        return num_of(field(c, "thickness"));
    }
    ceiling_type(root, c).map_or(0.2, type_thickness)
}

/// `wallTypeLabel`: Kürzel + Dicke in cm (einschichtig „BET 24", mehrschichtig „GKB·BET (25.5)"), sonst der Name.
fn wall_type_label(root: &Map<String, Value>, t: &Value) -> Value {
    let comps = arr(root.get("components"));
    let total_cm: f64 = crate::js_fmt::to_fixed(type_thickness(t) * 100.0, 1).parse().unwrap_or(f64::NAN);
    let cm = if total_cm % 1.0 == 0.0 { jsnum::to_int32(total_cm).to_string() } else { crate::js_fmt::js_number(total_cm) };
    let layers = arr(field(t, "layers"));
    let abbrevs: Vec<String> = layers
        .iter()
        .map(|l| find_by(comps, "id", field(l, "componentId")).and_then(|c| nn(field(c, "abbrev"))).map_or(String::new(), js_text))
        .collect();
    if abbrevs.iter().all(|a| !a.is_empty()) {
        if layers.len() == 1 {
            return Value::from(format!("{} {cm}", abbrevs[0]));
        }
        return Value::from(format!("{} ({cm})", abbrevs.join("·")));
    }
    field(t, "name").cloned().unwrap_or(Value::Null)
}

/// Einträge der Typ-Auswahl (`WallTypeChoice`).
fn type_choices(root: &Map<String, Value>, list: &str) -> J {
    J::arr(
        arr(root.get(list))
            .iter()
            .map(|t| {
                O::default()
                    .raw("id", t, "id")
                    .raw("name", t, "name")
                    .v("label", wall_type_label(root, t))
                    .n("thickness", type_thickness(t))
                    .v("layerCount", Value::from(arr(field(t, "layers")).len()))
                    .done()
            }),
    )
}

/// Effektive Vordergrund-/Hintergrund-/Schraffur-Vorschau eines Bauteils (äusserste Schicht bzw. das
/// zugewiesene Bauteil als Repräsentant).
fn effective(el: &Value, comp: Option<&Value>, cat: Option<&Value>) -> (Option<Value>, Option<Value>, Option<Value>) {
    let fg = if comp.is_some() { resolve_color(cf(comp, "foreground"), field(el, "foreground"), cat, field(el, "foregroundSource")) } else { field(el, "foreground").cloned() };
    let bg = if comp.is_some() { resolve_color(cf(comp, "background"), field(el, "background"), cat, field(el, "backgroundSource")) } else { field(el, "background").cloned() };
    let hatch = resolve_hatch(field(el, "hatchId"), field(el, "hatchSource"), cat, cf(comp, "hatchId"));
    (fg, bg, hatch)
}

// ── Abfrage ──────────────────────────────────────────────────────────────────

/// Objekt-Info des ersten gewählten Elements (Vorrang wie `deriveSelection`); `Value::Null` = nichts.
/// Gesucht wird über `lk` (im Dokument mit dessen Positions-Index, keine lineare Suche je Darstellung).
pub fn derive(lk: &Lookup, a: &SelArgs) -> Result<J, String> {
    fn id(o: &Option<String>) -> Option<&str> {
        o.as_deref().filter(|s| !s.is_empty())
    }
    let root = lk.root;
    if let Some(i) = id(&a.context_object_id) {
        if let Some(o) = lk.find("context", i) {
            return Ok(context_selection(root, o));
        }
    }
    if let Some(i) = id(&a.drawing_id) {
        return Ok(lk.find("drawings2d", i).map_or(J::null(), |d| drawing_selection(root, d)));
    }
    if let Some(i) = id(&a.extruded_solid_id) {
        return Ok(lk.find("extrudedSolids", i).map_or(J::null(), |s| solid_selection(root, s)));
    }
    if let Some(i) = id(&a.column_id) {
        return lk.find("columns", i).map_or(Ok(J::null()), |c| column_selection(root, c));
    }
    if let Some(i) = id(&a.opening_id) {
        if let Some(o) = lk.find("openings", i) {
            return opening_selection(lk, o);
        }
    }
    if let Some(i) = a.wall_ids.first().filter(|s| !s.is_empty()) {
        return lk.find("walls", i).map_or(Ok(J::null()), |w| wall_selection(root, w));
    }
    if let Some(i) = id(&a.ceiling_id) {
        return lk.find("ceilings", i).map_or(Ok(J::null()), |c| ceiling_selection(root, c));
    }
    if let Some(i) = id(&a.roof_id) {
        return lk.find("roofs", i).map_or(Ok(J::null()), |r| roof_selection(root, r));
    }
    if let Some(i) = id(&a.stair_id) {
        return lk.find("stairs", i).map_or(Ok(J::null()), |s| stair_selection(root, s));
    }
    if let Some(i) = id(&a.room_id) {
        return Ok(lk.find("rooms", i).map_or(J::null(), |r| room_selection(root, r)));
    }
    Ok(J::null())
}

fn wall_selection(root: &Map<String, Value>, w: &Value) -> Result<J, String> {
    let cat = category(root, field(w, "categoryCode"));
    let color = color_of(w, cat, WALL_FALLBACK_COLOR);
    let weight = lw_or(field(w, "strokeWeight"), cat, WALL_FALLBACK_MM);
    let (s, e) = (xy(field(w, "start").unwrap_or(&Value::Null)), xy(field(w, "end").unwrap_or(&Value::Null)));
    let mut bb = [jsnum::min(s.0, e.0), jsnum::min(s.1, e.1), jsnum::max(s.0, e.0), jsnum::max(s.1, e.1)];
    for q in crate::wall_arc::axis_polyline(s, e, field(w, "bulge").and_then(Value::as_f64), 0.0, 0.0) {
        bb = [bb[0].min(q.0), bb[1].min(q.1), bb[2].max(q.0), bb[3].max(q.1)];
    }
    let wt = find_by(arr(root.get("wallTypes")), "id", field(w, "wallTypeId"))
        .ok_or_else(|| format!("Unbekannter Wandtyp: {}", field(w, "wallTypeId").map_or("undefined".into(), js_text)))?;
    let thickness = type_thickness(wt);
    let layers = arr(field(wt, "layers"));
    let outer = component(root, layers.first().and_then(|l| field(l, "componentId")))?;
    let (fg, bg, hatch) = effective(w, Some(outer), cat);
    let floor = level(root, field(w, "floorId"));
    let (zb, zt) = vertical_extent(root, w);
    let above = next_floor_above(root, field(w, "floorId"));
    // Bogenwand ([T2]): Bogenlänge der Achse.
    let bulge = field(w, "bulge").and_then(Value::as_f64);
    let length = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(s.0, s.1), kernel2d::Vec2::new(e.0, e.1), bulge).map_or_else(|| hypot2(e.0 - s.0, e.1 - s.1), |a| a.length());
    let height = jsnum::max(0.0, zt - zb);
    let gross = length * thickness * height;
    let opening_volume = arr(root.get("openings"))
        .iter()
        .filter(|o| field(o, "hostWallId") == field(w, "id"))
        .fold(0.0, |sum, o| sum + num_of(field(o, "width")) * num_of(field(o, "height")) * thickness);
    let net = jsnum::max(0.0, gross - opening_volume);
    // Interne Schichttrennlinien als wählbare Referenz: Achsversatz +n = halbe Dicke − Fugenlage.
    let half = thickness / 2.0;
    let mut cum = 0.0;
    let mut boundaries = Vec::new();
    let abbrev = |l: &Value| -> Result<String, String> {
        let c = component(root, field(l, "componentId"))?;
        Ok(nn(field(c, "abbrev")).or_else(|| field(c, "name")).map_or("undefined".into(), js_text))
    };
    for i in 0..layers.len().saturating_sub(1) {
        cum += num_of(field(&layers[i], "thickness"));
        let label = format!("{}|{}", abbrev(&layers[i])?, abbrev(&layers[i + 1])?);
        boundaries.push(O::default().n("offset", half - cum).s("label", &label).done());
    }
    let info = O::default()
        .v("referenceLine", nn(field(w, "referenceLine")).cloned().unwrap_or_else(|| "center".into()))
        .raw("referenceOffset", w, "referenceOffset")
        .v("layerBoundaries", J::arr(boundaries))
        .v("sliceTermination", nn(field(w, "sliceTermination")).cloned().unwrap_or_else(|| "both".into()))
        .raw("wallTypeId", w, "wallTypeId")
        .n("thickness", thickness)
        .v("singleLayer", Value::Bool(layers.len() <= 1))
        .v("wallTypes", type_choices(root, "wallTypes"))
        .raw("floorId", w, "floorId")
        .o("floorName", floor_name(floor, field(w, "floorId")))
        .v("floors", floors(root))
        .o("floorAbove", above)
        .raw("bottom", w, "bottom")
        .raw("top", w, "top")
        .n("zBottom", zb)
        .n("zTop", zt)
        .n("length", length)
        .n("grossVolume", gross)
        .n("openingVolume", opening_volume)
        .n("netVolume", net)
        .done();
    Ok(O::default()
        .s("kind", "wall")
        .raw("id", w, "id")
        .raw("categoryCode", w, "categoryCode")
        .raw("floorId", w, "floorId")
        .v("color", color)
        .raw("colorPenId", w, "colorPenId")
        .v("weightMm", weight)
        .raw("fillHatchId", w, "hatchId")
        .raw("foreground", w, "foreground")
        .raw("foregroundPenId", w, "foregroundPenId")
        .raw("background", w, "background")
        .raw("backgroundPenId", w, "backgroundPenId")
        .raw("foregroundSource", w, "foregroundSource")
        .raw("backgroundSource", w, "backgroundSource")
        .o("effectiveForeground", fg)
        .o("effectiveBackground", bg)
        .o("effectiveHatchId", hatch)
        .raw("strokeWeightOverride", w, "strokeWeight")
        .raw("strokeWeightSource", w, "strokeWeightSource")
        .raw("hatchSource", w, "hatchSource")
        .v("bbox", bbox_value(bb))
        .v("wall", info)
        .done())
}

/// Geschoss direkt über `floor_id` (Reihenfolge der „floor"-Ebenen), `{id, name}`.
fn next_floor_above(root: &Map<String, Value>, floor_id: Option<&Value>) -> Option<J> {
    let fl: Vec<&Value> = arr(root.get("drawingLevels")).iter().filter(|z| str_of(field(z, "kind")) == Some("floor")).collect();
    let idx = fl.iter().position(|z| field(z, "id") == floor_id)?;
    fl.get(idx + 1).map(|a| O::default().raw("id", a, "id").raw("name", a, "name").done())
}

fn ceiling_selection(root: &Map<String, Value>, c: &Value) -> Result<J, String> {
    let cat = category(root, field(c, "categoryCode"));
    let color = color_of(c, cat, WALL_FALLBACK_COLOR);
    let weight = lw_or(field(c, "strokeWeight"), cat, WALL_FALLBACK_MM);
    let bb = bbox_of(pts_of(field(c, "outline")));
    let wt = ceiling_type(root, c)?;
    let thickness = ceiling_thickness(root, c);
    let outer = component(root, arr(field(wt, "layers")).first().and_then(|l| field(l, "componentId")))?;
    let (fg, bg, hatch) = effective(c, Some(outer), cat);
    let floor = level(root, field(c, "floorId"));
    let (zb, zt) = ceiling_extent(root, c, thickness);
    let area = ceiling_area(field(c, "outline"));
    let openings: Vec<J> = arr(field(c, "openings"))
        .iter()
        .map(|hole| {
            let b = bbox_of(pts_of(Some(hole)));
            O::default().n("width", b[2] - b[0]).n("depth", b[3] - b[1]).done()
        })
        .collect();
    let info = O::default()
        .o("typeId", nn(field(c, "ceilingTypeId")).or(field(c, "wallTypeId")).cloned())
        .n("thickness", thickness)
        .v("singleLayer", Value::Bool(arr(field(wt, "layers")).len() <= 1))
        .n("area", area)
        .n("volume", area * thickness)
        .v("ceilingTypes", type_choices(root, "ceilingTypes"))
        .raw("floorId", c, "floorId")
        .o("floorName", floor_name(floor, field(c, "floorId")))
        .v("floors", floors(root))
        .raw("top", c, "top")
        .raw("bottom", c, "bottom")
        .n("zBottom", zb)
        .n("zTop", zt)
        .v("openings", J::arr(openings))
        .done();
    Ok(O::default()
        .s("kind", "ceiling")
        .raw("id", c, "id")
        .raw("categoryCode", c, "categoryCode")
        .raw("floorId", c, "floorId")
        .v("color", color)
        .raw("colorPenId", c, "colorPenId")
        .v("weightMm", weight)
        .raw("fillHatchId", c, "hatchId")
        .raw("foreground", c, "foreground")
        .raw("foregroundPenId", c, "foregroundPenId")
        .raw("background", c, "background")
        .raw("backgroundPenId", c, "backgroundPenId")
        .raw("foregroundSource", c, "foregroundSource")
        .raw("backgroundSource", c, "backgroundSource")
        .o("effectiveForeground", fg)
        .o("effectiveBackground", bg)
        .o("effectiveHatchId", hatch)
        .raw("strokeWeightOverride", c, "strokeWeight")
        .raw("strokeWeightSource", c, "strokeWeightSource")
        .raw("hatchSource", c, "hatchSource")
        .v("closed", Value::Bool(true))
        .v("bbox", bbox_value(bb))
        .v("ceiling", info)
        .done())
}

fn roof_selection(root: &Map<String, Value>, r: &Value) -> Result<J, String> {
    let cat = category(root, field(r, "categoryCode"));
    let color = color_of(r, cat, WALL_FALLBACK_COLOR);
    let weight = lw_or(None, cat, WALL_FALLBACK_MM);
    // `roofBBox`: Vergleiche ohne Math.min (NaN wird übergangen), leer = ±∞.
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (x, y) in pts_of(field(r, "outline")) {
        if x < x0 {
            x0 = x;
        }
        if y < y0 {
            y0 = y;
        }
        if x > x1 {
            x1 = x;
        }
        if y > y1 {
            y1 = y;
        }
    }
    // `roof.baseElevation !== undefined` (auch `null` gilt als gesetzt, rechnet wie 0 und bleibt in der Ausgabe null).
    let (eaves, eaves_out) = match field(r, "baseElevation") {
        Some(b) => (num_of(Some(b)), b.clone()),
        None => {
            let z = level(root, field(r, "floorId")).map_or(0.0, |f| num_or(field(f, "baseElevation"), 0.0) + num_or(field(f, "floorHeight"), 0.0));
            (z, js_num(z))
        }
    };
    let ridge_height = roof_ridge_height(r, eaves)?;
    let (w, d) = ((x1 - x0).abs(), (y1 - y0).abs());
    let holes: Vec<J> = arr(field(r, "holes"))
        .iter()
        .map(|h| O::default().n("area", polygon_area(Some(h)).abs()).v("points", Value::from(arr(Some(h)).len())).done())
        .collect();
    let info = O::default()
        .raw("shape", r, "shape")
        .raw("pitchDeg", r, "pitchDeg")
        .raw("pitchUpperDeg", r, "pitchUpperDeg")
        .raw("roofTypeId", r, "roofTypeId")
        .raw("mansardType", r, "mansardType")
        .raw("mansardKneeRatio", r, "mansardKneeRatio")
        .raw("halfHipRatio", r, "halfHipRatio")
        .raw("overhang", r, "overhang")
        .raw("overhangGable", r, "overhangGable")
        .raw("ridgeAxis", r, "ridgeAxis")
        .raw("thickness", r, "thickness")
        .v("baseElevation", eaves_out)
        .n("ridgeHeight", ridge_height)
        .n("footprintArea", w * d)
        .n("width", w)
        .n("depth", d)
        .n("minX", x0)
        .n("minY", y0)
        .v("edges", roof_edges(r))
        .v("holes", J::arr(holes))
        .v("hasEdgePitch", Value::Bool(field(r, "edgePitchDeg").is_some()))
        .done();
    Ok(O::default()
        .s("kind", "roof")
        .raw("id", r, "id")
        .raw("categoryCode", r, "categoryCode")
        .raw("floorId", r, "floorId")
        .v("color", color)
        .raw("colorPenId", r, "colorPenId")
        .v("weightMm", weight)
        .v("closed", Value::Bool(true))
        .v("bbox", bbox_value([x0, y0, x1, y1]))
        .v("roof", info)
        .done())
}

/// Gemerkte Firsthöhen, Schlüssel = Inhalts-Hash (Dach-JSON + Traufhöhe); je Eintrag Dach, Traufhöhe,
/// Firsthöhe (bei einem Treffer wird der Inhalt verglichen, nie veraltet).
type RidgeCache = std::collections::HashMap<u64, Vec<(Value, u64, f64)>>;

/// Höchstzahl gemerkter Firsthöhen (danach wird geleert).
const RIDGE_CACHE_MAX: usize = 4096;

thread_local! {
    /// Gerechnete Firsthöhen: die Objekt-Info fragt je Darstellung neu, das Skelett eines Dachs kostet aber
    /// ein Vielfaches der übrigen Abfrage (TS merkte sich die Geometrie je Dach-Objekt). Nach Inhalt
    /// gemerkt, damit auch das Hin- und Herwählen zwischen vielen Dächern trifft.
    static RIDGE_CACHE: std::cell::RefCell<RidgeCache> = std::cell::RefCell::new(RidgeCache::new());
}

/// FNV-1a über einen JSON-Wert (Struktur, Schlüssel, Zahlen-Bits, Texte).
fn value_hash(v: &Value, h: &mut u64) {
    let mut put = |bytes: &[u8]| {
        for b in bytes {
            *h = (*h ^ *b as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    match v {
        Value::Null => put(b"n"),
        Value::Bool(b) => put(if *b { b"t" } else { b"f" }),
        Value::Number(n) => {
            put(b"#");
            put(&n.as_f64().unwrap_or(f64::NAN).to_bits().to_le_bytes());
        }
        Value::String(s) => {
            put(b"s");
            put(s.as_bytes());
            put(&[0]);
        }
        Value::Array(a) => {
            put(b"[");
            for x in a {
                value_hash(x, h);
            }
            *h = (*h ^ b']' as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
        Value::Object(m) => {
            put(b"{");
            for (k, x) in m {
                *h = k.bytes().fold(*h, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3));
                value_hash(x, h);
            }
            *h = (*h ^ b'}' as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

/// Firsthöhe über der Traufe (Dach-Geometrie des Kerns, `roof.rs`), nach Inhalt gemerkt.
fn roof_ridge_height(r: &Value, eaves: f64) -> Result<f64, String> {
    let mut key = 0xcbf2_9ce4_8422_2325u64 ^ eaves.to_bits();
    value_hash(r, &mut key);
    let hit = RIDGE_CACHE.with(|c| c.borrow().get(&key).and_then(|l| l.iter().find(|(v, z, _)| *z == eaves.to_bits() && v == r).map(|e| e.2)));
    if let Some(h) = hit {
        return Ok(h);
    }
    let typed: crate::model::Roof = serde_json::from_value(r.clone()).map_err(|e| format!("Dach passt nicht zum Kern-Modell: {e}"))?;
    let h = crate::roof::roof_geometry(&typed.params(), eaves).ridge_height;
    RIDGE_CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= RIDGE_CACHE_MAX {
            c.clear();
        }
        c.entry(key).or_default().push((r.clone(), eaves.to_bits(), h));
    });
    Ok(h)
}

/// Kantenliste eines Dachs (`roofEdgeList`): Umriss, dann Höfe; Vorgabe je Kante aus `edgePitchDeg`.
fn roof_edges(r: &Value) -> J {
    let shape = str_of(field(r, "shape"));
    let gabled = shape == Some("sattel") || (shape == Some("mansarde") && nn(field(r, "mansardType")).map_or(Some("giebel"), |m| m.as_str()) == Some("giebel"));
    let axis_y = str_of(field(r, "ridgeAxis")) == Some("y");
    let pitches = field(r, "edgePitchDeg").and_then(Value::as_array);
    let mut rings: Vec<&[Value]> = vec![arr(field(r, "outline"))];
    rings.extend(arr(field(r, "holes")).iter().map(|h| arr(Some(h))));
    let mut out = Vec::new();
    let mut index = 0usize;
    for (ri, ring) in rings.iter().enumerate() {
        for (edge, a) in ring.iter().enumerate() {
            let b = &ring[(edge + 1) % ring.len()];
            let (pa, pb) = (xy(a), xy(b));
            let spec = match pitches.and_then(|p| p.get(index)) {
                Some(Value::Null) => O::default().s("kind", "gable").done(),
                Some(v) if v.as_f64().is_some_and(|d| d.is_finite() && d >= 0.0) => O::default().s("kind", "pitch").v("deg", v).done(),
                _ => O::default().s("kind", "default").done(),
            };
            let default_gable = gabled && {
                let (dx, dy) = ((pb.0 - pa.0).abs(), (pb.1 - pa.1).abs());
                if axis_y {
                    dy < dx
                } else {
                    dx < dy
                }
            };
            out.push(
                O::default()
                    .v("index", Value::from(index))
                    .v("ring", Value::from(ri))
                    .v("edge", Value::from(edge))
                    .v("a", a)
                    .v("b", b)
                    .n("length", hypot2(pb.0 - pa.0, pb.1 - pa.1))
                    .v("spec", spec)
                    .v("defaultGable", Value::Bool(default_gable))
                    .done(),
            );
            index += 1;
        }
    }
    J::arr(out)
}

fn opening_selection(lk: &Lookup, o: &Value) -> Result<J, String> {
    use crate::opening_geom::{opening_gap_quad, v, WallRef};
    let root = lk.root;
    let cat = category(root, field(o, "categoryCode"));
    let color = color_of(o, cat, WALL_FALLBACK_COLOR);
    let weight = lw_or(None, cat, WALL_FALLBACK_MM);
    let host = field(o, "hostWallId");
    let wall = match host.and_then(Value::as_str) {
        Some(i) => lk.find("walls", i),
        None => find_by(arr(root.get("walls")), "id", host),
    };
    let floor = wall.and_then(|w| level(root, field(w, "floorId")));
    let mut quad = None;
    if let Some(w) = wall {
        let (s, e) = (xy(field(w, "start").unwrap_or(&Value::Null)), xy(field(w, "end").unwrap_or(&Value::Null)));
        let wr = |total: f64, ref_off: f64| WallRef { start: v(s.0, s.1), end: v(e.0, e.1), total, ref_off };
        let (pos, width) = (num_of(field(o, "position")), num_of(field(o, "width")));
        // Der Wandtyp wird erst gebraucht (und kann werfen), wenn die Lücke nicht entartet ist.
        if crate::opening_geom::opening_interval(&wr(0.0, 0.0), pos, width).is_some() {
            let wt = find_by(arr(root.get("wallTypes")), "id", field(w, "wallTypeId"))
                .ok_or_else(|| format!("Unbekannter Wandtyp: {}", field(w, "wallTypeId").map_or("undefined".into(), js_text)))?;
            let total = type_thickness(wt);
            quad = opening_gap_quad(&wr(total, reference_offset(w, total)), pos, width);
        }
    }
    let bb = bbox_of(quad.unwrap_or_default().into_iter().map(|p| (p.x, p.y)));
    let (zb, zt) = match wall {
        Some(w) => {
            let (wb, wt) = vertical_extent(root, w);
            let bottom = wb + jsnum::max(0.0, num_of(field(o, "sillHeight")));
            (js_num(bottom), Some(js_num(jsnum::min(wt, bottom + num_of(field(o, "height"))))))
        }
        None => (js_num(0.0), field(o, "height").cloned()),
    };
    let info = O::default()
        .raw("id", o, "id")
        .raw("kind", o, "kind")
        .raw("hostWallId", o, "hostWallId")
        .o("hostWallName", floor.map_or_else(|| field(o, "hostWallId").cloned(), |f| Some(Value::from(field(f, "name").map_or("undefined".into(), js_text)))))
        .raw("position", o, "position")
        .raw("width", o, "width")
        .raw("height", o, "height")
        .raw("sillHeight", o, "sillHeight")
        .raw("hinge", o, "hinge")
        .raw("swing", o, "swing")
        .raw("swingAngle", o, "swingAngle")
        .raw("openingDir", o, "openingDir")
        .raw("wingCount", o, "wingCount")
        .raw("doorType", o, "doorType")
        .raw("lintelLines", o, "lintelLines")
        .raw("typeId", o, "typeId")
        .raw("detailLevel", o, "detailLevel")
        .v("zBottom", zb)
        .o("zTop", zt)
        .raw("frameLine", o, "frameLine")
        .raw("frameViewLine", o, "frameViewLine")
        .raw("sashLine", o, "sashLine")
        .raw("sillLineStyle", o, "sillLineStyle")
        .done();
    Ok(O::default()
        .s("kind", "opening")
        .raw("id", o, "id")
        .raw("categoryCode", o, "categoryCode")
        .v("color", color)
        .raw("colorPenId", o, "colorPenId")
        .v("weightMm", weight)
        .v("bbox", bbox_value(bb))
        .v("opening", info)
        .done())
}

/// Achsversatz der Schichtstapelung (`wallReferenceOffset`): freier Versatz (auf die Dicke geklemmt),
/// sonst die benannte Referenzlinie.
fn reference_offset(w: &Value, total: f64) -> f64 {
    let half = total / 2.0;
    if nn(field(w, "referenceOffset")).is_some() {
        return jsnum::max(-half, jsnum::min(half, num_of(field(w, "referenceOffset"))));
    }
    match nn(field(w, "referenceLine")).map_or(Some("center"), Value::as_str) {
        Some("left") => half,
        Some("right") => -half,
        _ => 0.0,
    }
}

fn stair_selection(root: &Map<String, Value>, s: &Value) -> Result<J, String> {
    let cat = category(root, field(s, "categoryCode"));
    let color = color_of(s, cat, WALL_FALLBACK_COLOR);
    let weight = lw_or(None, cat, WALL_FALLBACK_MM);
    let floor = level(root, field(s, "floorId"));
    let (base, floor_height) = floor.map_or((0.0, 0.0), |f| (num_or(field(f, "baseElevation"), 0.0), num_or(field(f, "floorHeight"), 0.0)));
    let tr = field(s, "totalRise");
    let rise = if nn(tr).is_some() && num_of(tr) > 0.0 {
        num_of(tr)
    } else if floor_height > 0.0 {
        floor_height
    } else {
        2.6
    };
    let (zb, zt) = (base, base + rise);
    let total_rise = zt - zb;
    let typed: crate::model::Stair = serde_json::from_value(s.clone()).map_err(|e| format!("Treppe passt nicht zum Kern-Modell: {e}"))?;
    // Wie die TS-Fassade: Geometrie flach, leer (Unsinn-Eingabe) = leere Geometrie, daraus die bbox.
    let mut geo = crate::stair::geometry(&typed.encode(), total_rise);
    if geo.len() < 4 {
        geo = vec![0.0, 0.0, 0.0, 0.0, -1.0, 0.0];
        geo.extend([0.0; 10]);
    }
    let b = crate::stair::bbox(&geo);
    let bb = if b.len() < 4 { [0.0; 4] } else { [b[0], b[1], b[2], b[3]] };
    let info = O::default()
        .raw("shape", s, "shape")
        .raw("width", s, "width")
        .raw("stepCount", s, "stepCount")
        .n("totalRise", total_rise)
        .n("riserHeight", geo[0])
        .n("treadDepth", geo[1])
        .v("up", Value::Bool(field(s, "up") != Some(&Value::Bool(false))))
        .raw("arrowStyle", s, "arrowStyle")
        .raw("referenz", s, "referenz")
        .raw("typeId", s, "typeId")
        .raw("floorId", s, "floorId")
        .o("floorName", floor_name(floor, field(s, "floorId")))
        .n("zBottom", zb)
        .n("zTop", zt)
        .done();
    Ok(O::default()
        .s("kind", "stair")
        .raw("id", s, "id")
        .raw("categoryCode", s, "categoryCode")
        .raw("floorId", s, "floorId")
        .v("color", color)
        .raw("colorPenId", s, "colorPenId")
        .v("weightMm", weight)
        .v("bbox", bbox_value(bb))
        .v("stair", info)
        .done())
}

fn room_selection(root: &Map<String, Value>, r: &Value) -> J {
    let cat = category(root, field(r, "categoryCode"));
    let color = color_of(r, cat, WALL_FALLBACK_COLOR);
    let weight = lw_or(None, cat, WALL_FALLBACK_MM);
    let ev = crate::room_area::evaluate(&ring(field(r, "boundary")), 0.0);
    let floor = level(root, field(r, "floorId"));
    let bb = bbox_of(pts_of(field(r, "boundary")));
    let info = O::default()
        .raw("name", r, "name")
        .raw("siaCategory", r, "siaCategory")
        .n("area", ev.net)
        .n("perimeter", ev.perimeter)
        .raw("floorId", r, "floorId")
        .o("floorName", floor_name(floor, field(r, "floorId")))
        .done();
    O::default()
        .s("kind", "room")
        .raw("id", r, "id")
        .raw("categoryCode", r, "categoryCode")
        .raw("floorId", r, "floorId")
        .v("color", color)
        .raw("colorPenId", r, "colorPenId")
        .v("weightMm", weight)
        .v("closed", Value::Bool(true))
        .v("bbox", bbox_value(bb))
        .v("room", info)
        .done()
}

fn solid_selection(root: &Map<String, Value>, s: &Value) -> J {
    let floor = level(root, field(s, "levelId"));
    let bb = bbox_of(pts_of(field(s, "points")));
    let brep = field(s, "brep").filter(|b| truthy(Some(b)));
    let taper = num_or(field(s, "taper"), 0.0);
    let subtract = str_of(field(s, "operation")) == Some("subtract");
    let info = O::default()
        .raw("height", s, "height")
        .n("taper", taper)
        .n("cornerRadius", num_or(field(s, "cornerRadius"), 0.0))
        .n("chamfer", num_or(field(s, "chamfer"), 0.0))
        .o("brepLabel", brep.map(|b| nn(field(b, "label")).cloned().unwrap_or_else(|| "B-Rep".into())))
        .n("area", polygon_area(field(s, "points")))
        // Platzhalter: `spec` (B-Rep für truck) setzt die TS-Fassade ein.
        .v("spec", Value::Null)
        .v("subtract", Value::Bool(subtract))
        .v("canSubtract", Value::Bool(brep.is_none() && taper < 1e-6))
        .n("baseOffset", num_or(field(s, "baseOffset"), 0.0))
        .raw("floorId", s, "levelId")
        .o("floorName", floor_name(floor, field(s, "levelId")))
        .done();
    O::default()
        .s("kind", "extrudedSolid")
        .raw("id", s, "id")
        .s("categoryCode", "")
        .raw("floorId", s, "levelId")
        .s("color", EXTRUSION_COLOR)
        .n("weightMm", WALL_FALLBACK_MM)
        .v("fillHatchId", Value::Null)
        .v("fillColor", Value::Null)
        .v("closed", Value::Bool(true))
        .v("bbox", bbox_value(bb))
        .v("extrudedSolid", info)
        .done()
}

fn column_selection(root: &Map<String, Value>, c: &Value) -> Result<J, String> {
    let floor = level(root, field(c, "floorId"));
    let cat = category(root, field(c, "categoryCode"));
    let typed: crate::model::Column = serde_json::from_value(c.clone()).map_err(|e| format!("Stütze passt nicht zum Kern-Modell: {e}"))?;
    let bb = bbox_of(crate::model3d::column_footprint(&typed).into_iter().map(|p| (p.x, p.y)));
    let (zb, zt) = vertical_extent(root, c);
    let rotation = num_or(field(c, "rotation"), 0.0);
    let info = O::default()
        .raw("profile", c, "profile")
        .raw("height", c, "height")
        .n("rotationDeg", (rotation * 180.0) / std::f64::consts::PI)
        .raw("floorId", c, "floorId")
        .o("floorName", floor_name(floor, field(c, "floorId")))
        .n("zBottom", zb)
        .n("zTop", zt)
        .done();
    // Ein gelöschtes Bauteil wirft hier nicht (die Vorschau fällt auf „kein Bauteil" zurück).
    let comp = if truthy(field(c, "componentId")) { find_by(arr(root.get("components")), "id", field(c, "componentId")) } else { None };
    let (fg, bg, hatch) = effective(c, comp, cat);
    let weight = match nn(field(c, "strokeWeight")) {
        Some(w) => w.clone(),
        None if is_layer(field(c, "strokeWeightSource")) => cat.and_then(|k| nn(field(k, "lw"))).cloned().unwrap_or_else(|| js_num(WALL_FALLBACK_MM)),
        None => js_num(WALL_FALLBACK_MM),
    };
    Ok(O::default()
        .s("kind", "column")
        .raw("id", c, "id")
        .raw("categoryCode", c, "categoryCode")
        .raw("floorId", c, "floorId")
        .v("color", color_of(c, cat, COLUMN_COLOR))
        .raw("colorPenId", c, "colorPenId")
        .v("weightMm", weight)
        .raw("fillHatchId", c, "hatchId")
        .raw("foreground", c, "foreground")
        .raw("foregroundPenId", c, "foregroundPenId")
        .raw("background", c, "background")
        .raw("backgroundPenId", c, "backgroundPenId")
        .raw("foregroundSource", c, "foregroundSource")
        .raw("backgroundSource", c, "backgroundSource")
        .o("effectiveForeground", fg)
        .o("effectiveBackground", bg)
        .o("effectiveHatchId", hatch)
        .raw("strokeWeightOverride", c, "strokeWeight")
        .raw("strokeWeightSource", c, "strokeWeightSource")
        .raw("hatchSource", c, "hatchSource")
        .v("bbox", bbox_value(bb))
        .v("column", info)
        .done())
}

fn context_selection(root: &Map<String, Value>, o: &Value) -> J {
    let kind = str_of(field(o, "type"));
    let mut pts: Vec<(f64, f64)> = Vec::new();
    match kind {
        Some("contourSet") => {
            for c in arr(field(o, "contours")) {
                pts.extend(pts_of(field(c, "pts")));
            }
        }
        Some("image") => {
            pts.push(xy(field(o, "min").unwrap_or(&Value::Null)));
            pts.push(xy(field(o, "max").unwrap_or(&Value::Null)));
        }
        _ => {
            let pos = arr(field(o, "positions"));
            let mut i = 0;
            while i + 2 < pos.len() {
                pts.push((num_of(Some(&pos[i])), num_of(Some(&pos[i + 1]))));
                i += 3;
            }
        }
    }
    let bb = bbox_of(pts);
    let lv95 = root.get("geoAnchor").filter(|a| truthy(Some(a))).map(|a| {
        let (lv, m) = (field(a, "lv95").unwrap_or(&Value::Null), field(a, "model").unwrap_or(&Value::Null));
        let (oe, on) = (num_of(field(lv, "e")) - num_of(field(m, "x")), num_of(field(lv, "n")) - num_of(field(m, "y")));
        O::default().n("e", (bb[0] + bb[2]) / 2.0 + oe).n("n", (bb[1] + bb[3]) / 2.0 + on).done()
    });
    let image = kind == Some("image");
    O::default()
        .s("kind", "contextObject")
        .raw("id", o, "id")
        .s("categoryCode", "")
        .s("color", "#888888")
        .n("weightMm", WALL_FALLBACK_MM)
        .v("bbox", bbox_value(bb))
        .v("contextObject", O::default().raw("objType", o, "type").o("lv95Center", lv95).done())
        .v("isImage", Value::Bool(image))
        .o("opacity", image.then(|| nn(field(o, "opacity")).cloned().unwrap_or_else(|| Value::from(1u64))))
        .o("imageFilters", if image { field(o, "filters").cloned() } else { None })
        .done()
}

/// Ob eine 2D-Form geschlossen ist (Füllung/Schraffur sinnvoll).
fn is_closed_geom(g: &Value) -> bool {
    match str_of(field(g, "shape")) {
        Some("rect" | "circle" | "ellipse") => true,
        Some("polyline" | "spline") => truthy(field(g, "closed")),
        _ => false,
    }
}

/// Bounding-Box einer 2D-Form (`geomBBox`, auch für Ausrichten/Verteilen).
pub fn geom_bbox(g: &Value) -> [f64; 4] {
    let p = |k: &str| xy(g.get(k).unwrap_or(&Value::Null));
    let mut pts: Vec<(f64, f64)> = Vec::new();
    match str_of(field(g, "shape")) {
        Some("line" | "xline" | "ray") => pts.extend([p("a"), p("b")]),
        Some("polyline" | "bezier" | "spline") => pts = pts_of(field(g, "pts")),
        Some("rect" | "image") => pts.extend([p("min"), p("max")]),
        Some("circle" | "arc") => {
            let (c, r) = (p("center"), num_of(field(g, "r")));
            pts.extend([(c.0 - r, c.1 - r), (c.0 + r, c.1 + r)]);
        }
        Some("ellipse") => {
            // Genau mit Drehung (rotation 0 beim heutigen Werkzeug).
            let rot = num_of(field(g, "rotation"));
            let (c, s) = (jsnum::cos(rot), jsnum::sin(rot));
            let (rx, ry) = (num_of(field(g, "rx")), num_of(field(g, "ry")));
            let (hw, hh) = (hypot2(rx * c, ry * s), hypot2(rx * s, ry * c));
            let ctr = p("center");
            pts.extend([(ctr.0 - hw, ctr.1 - hh), (ctr.0 + hw, ctr.1 + hh)]);
        }
        Some("dimension") => {
            let chain = pts_of(field(g, "pts"));
            pts.extend(chain.iter().copied());
            if chain.len() >= 2 {
                let (a, b) = (chain[0], chain[chain.len() - 1]);
                let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                let l = hypot2(dx, dy);
                let len = if l == 0.0 || l.is_nan() { 1.0 } else { l };
                let off = num_of(field(g, "offset"));
                let (nx, ny) = ((-dy / len) * off, (dx / len) * off);
                pts.extend(chain.iter().map(|q| (q.0 + nx, q.1 + ny)));
            }
        }
        Some("kote" | "text" | "block" | "detailref" | "pointmarker") => pts.push(p("at")),
        Some("scalebar") => {
            let at = p("at");
            pts.extend([at, (at.0 + num_of(field(g, "segmentLength")) * num_of(field(g, "segments")), at.1)]);
        }
        _ => {}
    }
    bbox_of(pts)
}

fn drawing_selection(root: &Map<String, Value>, d: &Value) -> J {
    let g = field(d, "geom").unwrap_or(&Value::Null);
    let ls = if truthy(field(d, "lineStyleId")) { find_by(arr(root.get("lineStyles")), "id", field(d, "lineStyleId")) } else { None };
    let cat = category(root, field(d, "categoryCode"));
    let color = nn(field(d, "color"))
        .or_else(|| ls.and_then(|l| nn(field(l, "color"))))
        .or_else(|| cat.and_then(|c| nn(field(c, "color"))))
        .cloned()
        .unwrap_or_else(|| DRAW_FALLBACK_COLOR.into());
    // Wie der Plan: Override, „layer" (Standard) erzwingt die Kategorie, sonst Linienstil → Kategorie.
    let cat_lw = cat.and_then(|c| nn(field(c, "lw")));
    let weight = nn(field(d, "weightMm"))
        .or_else(|| if str_of(field(d, "strokeWeightSource")) != Some("object") { cat_lw } else { None })
        .or_else(|| ls.and_then(|l| nn(field(l, "weight"))))
        .or(cat_lw)
        .cloned()
        .unwrap_or_else(|| js_num(WALL_FALLBACK_MM));
    let closed = is_closed_geom(g);
    // Ein Drawing2D hat kein Bauteil; fehlende Quelle = „Nach Ebene".
    let layer = Value::from("layer");
    let src = |k: &str| nn(d.get(k)).or(Some(&layer)).cloned();
    let pick = |k: &str| if closed { d.get(k).cloned() } else { None };
    let (fg, bg, hatch) = if closed {
        let fs = src("foregroundSource");
        let bs = src("backgroundSource");
        let hs = src("hatchSource");
        (
            resolve_color(None, field(d, "foreground"), cat, fs.as_ref()),
            resolve_color(None, field(d, "background"), cat, bs.as_ref()),
            resolve_hatch(field(d, "hatchId"), hs.as_ref(), cat, None),
        )
    } else {
        (None, None, Some(Value::Null))
    };
    let is_image = str_of(field(g, "shape")) == Some("image");
    let detail = (str_of(field(g, "shape")) == Some("detailref")).then(|| {
        let layouts = J::arr(arr(root.get("layouts")).iter().map(|l| O::default().raw("id", l, "id").raw("name", l, "name").done()));
        O::default().raw("label", g, "label").raw("sheetLayoutId", g, "sheetLayoutId").raw("sheetLabel", g, "sheetLabel").v("availableLayouts", layouts).done()
    });
    O::default()
        .s("kind", "drawing2d")
        .raw("id", d, "id")
        .raw("categoryCode", d, "categoryCode")
        .raw("floorId", d, "levelId")
        .v("color", color)
        .raw("colorPenId", d, "colorPenId")
        .v("weightMm", weight)
        .v("fillHatchId", if closed { nn(field(d, "hatchId")).cloned().unwrap_or(Value::Null) } else { Value::Null })
        .v("fillColor", if closed { nn(field(d, "fillColor")).cloned().unwrap_or(Value::Null) } else { Value::Null })
        .o("foreground", pick("foreground"))
        .o("foregroundPenId", pick("foregroundPenId"))
        .o("background", pick("background"))
        .o("backgroundPenId", pick("backgroundPenId"))
        .o("foregroundSource", pick("foregroundSource"))
        .o("backgroundSource", pick("backgroundSource"))
        .o("effectiveForeground", fg)
        .o("effectiveBackground", bg)
        .o("effectiveHatchId", hatch)
        .raw("strokeWeightOverride", d, "weightMm")
        .raw("strokeWeightSource", d, "strokeWeightSource")
        .o("hatchSource", pick("hatchSource"))
        .v("closed", Value::Bool(closed))
        .v("isImage", Value::Bool(is_image))
        .o("opacity", if is_image { Some(nn(field(g, "opacity")).cloned().unwrap_or_else(|| Value::from(1u64))) } else { field(d, "opacity").cloned() })
        .v("bbox", bbox_value(geom_bbox(g)))
        .o("detailRef", detail)
        .done()
}

/// Bounding-Boxen der Zeichnungen `ids` in Listen-Reihenfolge: `[[id, minX, minY, maxX, maxY], …]`.
pub fn drawing_bboxes(root: &Map<String, Value>, ids: &[String]) -> J {
    let wanted: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    J::arr(
        arr(root.get("drawings2d"))
            .iter()
            .filter(|d| id_of(d).is_some_and(|i| wanted.contains(i)))
            .map(|d| {
                let b = geom_bbox(field(d, "geom").unwrap_or(&Value::Null));
                let mut out = vec![b'['];
                field(d, "id").unwrap_or(&Value::Null).emit(&mut out);
                for x in b {
                    out.push(b',');
                    js_num(x).emit(&mut out);
                }
                out.push(b']');
                J(out)
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn sel(r: &Map<String, Value>, a: Value) -> Result<Value, String> {
        derive(&Lookup::plain(r), &serde_json::from_value(a).unwrap()).map(|j| serde_json::from_str(&j.into_string()).unwrap())
    }

    #[test]
    fn wand_mit_typ_volumen_und_fuge() {
        let r = root(json!({
            "layers": [{"code": "1", "name": "W", "color": "#111111", "lw": 0.35, "children": [{"code": "2", "color": "#222222", "lw": 0.5}]}],
            "components": [{"id": "a", "name": "Beton", "abbrev": "BET", "foreground": "#f00"}, {"id": "b", "name": "Daemmung"}],
            "wallTypes": [{"id": "t", "name": "Aussenwand", "layers": [{"componentId": "a", "thickness": 0.2}, {"componentId": "b", "thickness": 0.1}]}],
            "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "baseElevation": 0}, {"id": "og", "name": "OG", "kind": "floor", "baseElevation": 3}],
            "walls": [{"id": "w", "floorId": "eg", "categoryCode": "2", "start": {"x": 0, "y": 0}, "end": {"x": 4, "y": 3}, "wallTypeId": "t", "height": 2.5}],
            "openings": [{"id": "o", "hostWallId": "w", "width": 1, "height": 2}],
        }));
        let s = sel(&r, json!({"wallIds": ["w"]})).unwrap();
        assert_eq!(s["color"], json!("#222222"));
        assert_eq!(s["weightMm"], json!(0.5));
        assert_eq!(s["effectiveForeground"], json!("#f00"));
        assert_eq!(s["wall"]["length"], json!(5));
        assert_eq!(s["wall"]["layerBoundaries"], json!([{"offset": 0.15000000000000002 - 0.2, "label": "BET|Daemmung"}]));
        assert_eq!(s["wall"]["floorAbove"], json!({"id": "og", "name": "OG"}));
        assert_eq!(s["wall"]["wallTypes"][0]["label"], json!("Aussenwand"));
        let gross = 5.0 * 0.30000000000000004 * 2.5;
        assert_eq!(s["wall"]["netVolume"].as_f64().unwrap(), gross - 2.0 * 0.30000000000000004);
        // Unbekannter Wandtyp: dieselbe Meldung wie TS.
        let mut bad = r.clone();
        bad["walls"][0]["wallTypeId"] = json!("x");
        assert_eq!(sel(&bad, json!({"wallIds": ["w"]})).unwrap_err(), "Unbekannter Wandtyp: x");
    }

    #[test]
    fn hoehen_von_waenden_und_decken() {
        let r = root(json!({
            "wallTypes": [{"id": "t", "layers": [{"componentId": "a", "thickness": 0.3}]}],
            "drawingLevels": [{"id": "eg", "kind": "floor", "baseElevation": 1, "floorHeight": 3}, {"id": "og", "kind": "floor", "baseElevation": 4}],
        }));
        let a: ExtentArgs = serde_json::from_value(json!({
            "walls": [{"floorId": "eg", "height": 2.5}, {"floorId": "eg", "height": 2.5, "top": {"mode": "floor", "floorId": "og", "offset": -0.2}}, {"floorId": "x"}],
            "ceilings": [{"floorId": "eg", "wallTypeId": "t"}, {"floorId": "eg", "thickness": 0.25, "bottom": {"mode": "custom", "z": 3}}, {"floorId": "x", "ceilingTypeId": "fehlt"}],
        }))
        .unwrap();
        let v: Value = serde_json::from_str(&vertical_extents(&r, &a).into_string()).unwrap();
        assert_eq!(v, json!([1, 3.5, 1, 3.8, 0, "\u{1}NaN", 3.7, 4, 3, 4, -0.2, 0]));
    }

    #[test]
    fn typ_beschriftung_wie_ts() {
        let r = root(json!({"components": [{"id": "a", "abbrev": "BET"}, {"id": "b", "abbrev": "GKB"}]}));
        let one = json!({"name": "N", "layers": [{"componentId": "a", "thickness": 0.24}]});
        assert_eq!(wall_type_label(&r, &one), json!("BET 24"));
        let two = json!({"name": "N", "layers": [{"componentId": "b", "thickness": 0.0125}, {"componentId": "a", "thickness": 0.24}]});
        assert_eq!(wall_type_label(&r, &two), json!("GKB·BET (25.3)"));
    }

    #[test]
    fn zeichnung_offen_und_geschlossen() {
        let r = root(json!({"layers": [{"code": "1", "color": "#123", "lw": 0.25, "hatch": "h"}],
            "drawings2d": [
                {"id": "l", "categoryCode": "1", "levelId": "f", "geom": {"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 2, "y": -1}}},
                {"id": "r", "categoryCode": "1", "levelId": "f", "geom": {"shape": "rect", "min": {"x": 0, "y": 0}, "max": {"x": 1, "y": 1}}}
            ]}));
        let l = sel(&r, json!({"drawingId": "l"})).unwrap();
        assert_eq!(l["effectiveHatchId"], Value::Null);
        assert_eq!(l["bbox"], json!({"minX": 0, "minY": -1, "maxX": 2, "maxY": 0}));
        let rr = sel(&r, json!({"drawingId": "r"})).unwrap();
        assert_eq!(rr["effectiveHatchId"], json!("h"));
        assert_eq!(rr["effectiveForeground"], json!("#123"));
        assert!(sel(&r, json!({"drawingId": "x"})).unwrap().is_null());
    }
}
