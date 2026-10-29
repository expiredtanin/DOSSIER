//! Stiftsätze ([K4] S3, vorher `src/model/penSets.ts` und `clearCategoryPenRefs` in `state/projectSlice.ts`):
//! Standardpalette, Neu-Backen der Stift-Farben (`rebake_ops`), Stift-Verweise beim Löschen eines Stifts.
//! Die Rechnung läuft auf der Projekt-Wurzel (`serde_json::Map`; unbekannte Felder und Schlüsselreihenfolge
//! bleiben) und liefert Ops (`{"kind":"replace"|"setField"|…}`, Form wie `core/ops.ts`), keine Kopien des
//! Projekts. Die Auflösung eines einzelnen Stifts (`resolvePenColor` …) bleibt als Leseweg der UI in TS.

use crate::jsnum;
use serde_json::{json, Map, Value};

/// Farbe eines Stifts, der im aktiven Stiftsatz (noch) keinen Eintrag hat.
pub const PEN_FALLBACK_COLOR: &str = "#9aa0a6";
/// Strichstärke (mm) eines Stifts ohne Eintrag.
pub const PEN_FALLBACK_WEIGHT: f64 = 0.18;

use crate::grips::truthy;

/// Schlüssel des Stifts als Objekt-Schlüssel (JS: `pens[penId]`, eine Zahl wird zu Text).
fn key_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(crate::js_fmt::js_number(n.as_f64()?)),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// HSL (h in Grad, s/l in 0..1) → "#rrggbb" (`hslToHex`).
pub fn hsl_to_hex(h: f64, s: f64, l: f64) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (((h % 360.0) + 360.0) % 360.0) / 60.0;
    let x = c * (1.0 - ((hp % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if hp < 1.0 {
        (c, x, 0.0)
    } else if hp < 2.0 {
        (x, c, 0.0)
    } else if hp < 3.0 {
        (0.0, c, x)
    } else if hp < 4.0 {
        (0.0, x, c)
    } else if hp < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = l - c / 2.0;
    // `Math.round(..).toString(16).padStart(2, "0")`; Werte ausserhalb 0..255 (nur bei unsinnigen Eingaben)
    // schreiben wie JS mehr Stellen bzw. ein Minuszeichen.
    let hex = |v: f64| {
        let n = jsnum::round((v + m) * 255.0);
        if n.is_nan() {
            "NaN".to_string()
        } else if n < 0.0 {
            format!("-{:02x}", (-n) as u64)
        } else {
            format!("{:02x}", n as u64)
        }
    };
    format!("#{}{}{}", hex(r1), hex(g1), hex(b1))
}

/// Feste Palette des Freie-Farbe-Popovers: 8 Graustufen + 8 Farbtöne × 5 Helligkeitsstufen (`FREE_COLOR_PALETTE`).
pub fn free_color_palette() -> Vec<String> {
    let mut out = Vec::with_capacity(48);
    for i in 0..8 {
        let v = jsnum::round((i as f64 / 7.0) * 255.0) as u64;
        out.push(format!("#{}", format!("{v:02x}").repeat(3)));
    }
    for hue in 0..8 {
        for level in 0..5 {
            out.push(hsl_to_hex(hue as f64 * 45.0, 0.75, 0.75 - level as f64 * 0.14));
        }
    }
    out
}

/// 255 Stifte + Stile der Standardpalette (`generateStandardPenPalette`): `(pens, styles)`.
pub fn standard_pen_palette() -> (Vec<Value>, Map<String, Value>) {
    let mut pens = Vec::with_capacity(255);
    let mut styles = Map::new();
    let mut add = |id: u32, name: String, color: String| {
        pens.push(json!({"id": id.to_string(), "name": name}));
        styles.insert(id.to_string(), json!({"color": color, "weight": PEN_FALLBACK_WEIGHT}));
    };
    for (id, name, color) in [
        (1, "Rot", "#ff0000"),
        (2, "Gelb", "#ffff00"),
        (3, "Grün", "#00ff00"),
        (4, "Cyan", "#00ffff"),
        (5, "Blau", "#0000ff"),
        (6, "Magenta", "#ff00ff"),
        (7, "Schwarz", "#000000"),
        (8, "Dunkelgrau", "#414141"),
        (9, "Grau", "#808080"),
    ] {
        add(id, name.to_string(), color.to_string());
    }
    let mut id = 10;
    for hue in 0..24 {
        let h = hue as f64 * 15.0;
        for step in 0..10 {
            let saturated = step < 5;
            let level = (step % 5) as f64;
            let l = 0.75 - level * 0.14;
            let s = if saturated { 0.85 } else { 0.4 };
            add(id, format!("Stift {id}"), hsl_to_hex(h, s, l));
            id += 1;
        }
    }
    for (gid, color) in [(250, "#333333"), (251, "#5b5b5b"), (252, "#848484"), (253, "#adadad"), (254, "#d6d6d6"), (255, "#ffffff")] {
        add(gid, format!("Grau {gid}"), color.to_string());
    }
    (pens, styles)
}

/// Stile (Farbe + Strichstärke) des aktiven Stiftsatzes (`activePenSet(p)?.pens`).
struct Active<'a>(Option<&'a Map<String, Value>>);

impl Active<'_> {
    fn of(root: &Map<String, Value>) -> Active<'_> {
        let want = root.get("activePenSetId").filter(|v| !v.is_null());
        let set = root
            .get("penSets")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|s| s.get("id").filter(|v| !v.is_null()) == want));
        Active(set.and_then(|s| s.get("pens")).and_then(Value::as_object))
    }

    fn style(&self, pen: &Value) -> Option<&Value> {
        let k = key_of(pen)?;
        self.0?.get(&k).filter(|v| !v.is_null())
    }

    fn color(&self, pen: &Value) -> Value {
        match self.style(pen).and_then(|s| s.get("color")) {
            Some(c) if c.is_string() => c.clone(),
            _ => Value::String(PEN_FALLBACK_COLOR.into()),
        }
    }

    fn weight(&self, pen: &Value) -> Value {
        match self.style(pen).and_then(|s| s.get("weight")) {
            Some(w) if w.is_number() => w.clone(),
            _ => json!(PEN_FALLBACK_WEIGHT),
        }
    }
}

/// Bauteil: Farben aus den Stift-Verweisen neu schreiben (`bakeComponent`).
fn bake_component(a: &Active, c: &Value) -> Value {
    let Some(src) = c.as_object() else { return c.clone() };
    let mut m = src.clone();
    for (pen, key) in [("colorPenId", "color"), ("foregroundPenId", "foreground"), ("backgroundPenId", "background")] {
        if truthy(src.get(pen)) {
            m.insert(key.to_string(), a.color(&src[pen]));
        }
    }
    Value::Object(m)
}

/// Kategorie samt Kindern (`bakeCategory`).
fn bake_category(a: &Active, cat: &Value) -> Value {
    let Some(src) = cat.as_object() else { return cat.clone() };
    let mut m = src.clone();
    if truthy(src.get("colorPenId")) {
        m.insert("color".into(), a.color(&src["colorPenId"]));
        m.insert("lw".into(), a.weight(&src["colorPenId"]));
    }
    if let Some(ch) = src.get("children").and_then(Value::as_array) {
        m.insert("children".into(), Value::Array(ch.iter().map(|c| bake_category(a, c)).collect()));
    }
    Value::Object(m)
}

/// Nur Farbe (Dach, Öffnung, Treppe, Raum; `bakeElementColor`).
fn bake_color(a: &Active, x: &Value) -> Value {
    let Some(src) = x.as_object() else { return x.clone() };
    if !truthy(src.get("colorPenId")) {
        return x.clone();
    }
    let mut m = src.clone();
    m.insert("color".into(), a.color(&src["colorPenId"]));
    Value::Object(m)
}

/// Farbe + Strichstärke unter `weight_key` + Vorder-/Hintergrund (`bakeElementColorAndWeight`).
fn bake_color_weight(a: &Active, x: &Value, weight_key: &str) -> Value {
    let Some(src) = x.as_object() else { return x.clone() };
    let mut m = src.clone();
    if truthy(src.get("colorPenId")) {
        m.insert("color".into(), a.color(&src["colorPenId"]));
        m.insert(weight_key.into(), a.weight(&src["colorPenId"]));
    }
    if truthy(src.get("foregroundPenId")) {
        m.insert("foreground".into(), a.color(&src["foregroundPenId"]));
    }
    if truthy(src.get("backgroundPenId")) {
        m.insert("background".into(), a.color(&src["backgroundPenId"]));
    }
    Value::Object(m)
}

/// `replace`-Ops für alle Elemente von `collection`, die `f` ändert (Listenreihenfolge; `patchItems`).
fn patch_items(root: &Map<String, Value>, collection: &str, f: &dyn Fn(&Value) -> Value, ops: &mut Vec<Value>) {
    let Some(list) = root.get(collection).and_then(Value::as_array) else { return };
    for e in list {
        let next = f(e);
        if next != *e {
            ops.push(json!({"kind": "replace", "collection": collection, "entity": next}));
        }
    }
}

/// Ops, die alle Farben/Strichstärken mit Stift-Verweis aus dem aktiven Stiftsatz neu schreiben (`rebakePenOps`).
/// Ändert nichts, wenn der Wert schon stimmt (die TS-Fassung schrieb die Ebenen immer ganz neu).
pub fn rebake_ops(root: &Map<String, Value>) -> Vec<Value> {
    let a = Active::of(root);
    let mut ops = Vec::new();
    patch_items(root, "components", &|c| bake_component(&a, c), &mut ops);
    if let Some(layers) = root.get("layers").and_then(Value::as_array) {
        let next: Vec<Value> = layers.iter().map(|c| bake_category(&a, c)).collect();
        if next != *layers {
            ops.push(json!({"kind": "setField", "key": "layers", "value": next}));
        }
    }
    patch_items(root, "walls", &|w| bake_color_weight(&a, w, "strokeWeight"), &mut ops);
    patch_items(root, "drawings2d", &|d| bake_color_weight(&a, d, "weightMm"), &mut ops);
    patch_items(root, "ceilings", &|c| bake_color_weight(&a, c, "strokeWeight"), &mut ops);
    patch_items(root, "columns", &|c| bake_color_weight(&a, c, "strokeWeight"), &mut ops);
    for coll in ["roofs", "openings", "stairs", "rooms"] {
        patch_items(root, coll, &|x| bake_color(&a, x), &mut ops);
    }
    ops
}

/// Ops zum Anlegen der Standardpalette (`seedStandardPenSetOps`): Stifte ersetzen, Satz anhängen (`set_id`,
/// `set_name`), aktiv setzen, falls noch keiner aktiv war, und neu backen. Die Stifte kommen als ein
/// `setField` (die TS-Fassung schrieb eine Listen-Differenz; Ergebnis gleich).
pub fn seed_standard_ops(root: &Map<String, Value>, set_id: &str, set_name: &str) -> Vec<Value> {
    let (pens, styles) = standard_pen_palette();
    let pen_set = json!({"id": set_id, "name": set_name, "pens": styles});
    let mut ops: Vec<Value> = Vec::new();
    let mut work = root.clone();
    if root.get("pens") != Some(&Value::Array(pens.clone())) {
        ops.push(json!({"kind": "setField", "key": "pens", "value": pens}));
    }
    work.insert("pens".into(), Value::Array(pens));
    ops.push(json!({"kind": "add", "collection": "penSets", "items": [pen_set.clone()]}));
    let sets = work.entry("penSets").or_insert_with(|| Value::Array(vec![]));
    if let Value::Array(a) = sets {
        a.push(pen_set);
    }
    let keep = root.get("activePenSetId").filter(|v| !v.is_null());
    let active = keep.cloned().unwrap_or_else(|| Value::String(set_id.into()));
    if root.get("activePenSetId") != Some(&active) {
        ops.push(json!({"kind": "setField", "key": "activePenSetId", "value": active}));
    }
    work.insert("activePenSetId".into(), active);
    ops.extend(rebake_ops(&work));
    ops
}

/// `{...x, colorPenId: undefined …}`: Verweise auf `id` entfernen (`clearPenRefs`).
fn clear_refs(x: &Value, id: &str) -> Value {
    let Some(src) = x.as_object() else { return x.clone() };
    let hit = |k: &str| src.get(k).and_then(Value::as_str) == Some(id);
    if !(hit("colorPenId") || hit("foregroundPenId") || hit("backgroundPenId")) {
        return x.clone();
    }
    let mut m = src.clone();
    for k in ["colorPenId", "foregroundPenId", "backgroundPenId"] {
        if hit(k) {
            m.shift_remove(k);
        }
    }
    Value::Object(m)
}

/// Kategorie: Verweis auf `id` entfernen, rekursiv (`clearCategoryPenRefs`).
fn clear_category(cat: &Value, id: &str) -> Value {
    let Some(src) = cat.as_object() else { return cat.clone() };
    let mut m = src.clone();
    if src.get("colorPenId").and_then(Value::as_str) == Some(id) {
        m.shift_remove("colorPenId");
    }
    if let Some(ch) = src.get("children").and_then(Value::as_array) {
        m.insert("children".into(), Value::Array(ch.iter().map(|c| clear_category(c, id)).collect()));
    }
    Value::Object(m)
}

/// Ops zum Löschen des Stifts `id`: aus `pens` und allen Stiftsätzen entfernen, Verweise in Bauteilen
/// und im Kategorien-Baum löschen (`deletePen`).
pub fn delete_pen_ops(root: &Map<String, Value>, id: &str) -> Vec<Value> {
    let mut ops = Vec::new();
    let known = root.get("pens").and_then(Value::as_array).is_some_and(|a| a.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(id)));
    if known {
        ops.push(json!({"kind": "remove", "collection": "pens", "ids": [id]}));
    }
    patch_items(
        root,
        "penSets",
        &|s| {
            let Some(src) = s.as_object() else { return s.clone() };
            let mut m = src.clone();
            if let Some(Value::Object(p)) = src.get("pens") {
                let mut p = p.clone();
                p.shift_remove(id);
                m.insert("pens".into(), Value::Object(p));
            }
            Value::Object(m)
        },
        &mut ops,
    );
    patch_items(root, "components", &|c| clear_refs(c, id), &mut ops);
    if let Some(layers) = root.get("layers").and_then(Value::as_array) {
        let next: Vec<Value> = layers.iter().map(|c| clear_category(c, id)).collect();
        if next != *layers {
            ops.push(json!({"kind": "setField", "key": "layers", "value": next}));
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn hsl_und_paletten() {
        assert_eq!(hsl_to_hex(0.0, 1.0, 0.5), "#ff0000");
        assert_eq!(hsl_to_hex(-120.0, 1.0, 0.5), "#0000ff");
        let free = free_color_palette();
        assert_eq!(free.len(), 48);
        assert_eq!(free[0], "#000000");
        assert_eq!(free[7], "#ffffff");
        let (pens, styles) = standard_pen_palette();
        assert_eq!(pens.len(), 255);
        assert_eq!(styles.len(), 255);
        assert_eq!(styles["7"]["color"], "#000000");
        assert_eq!(pens[9]["name"], "Stift 10");
    }

    #[test]
    fn rebake_schreibt_nur_geaenderte() {
        let p = root(json!({
            "penSets": [{"id": "a", "name": "A", "pens": {"1": {"color": "#111111", "weight": 0.5}}}],
            "activePenSetId": "a",
            "components": [{"id": "c1", "color": "#000", "colorPenId": "1"}, {"id": "c2", "color": "#000"}],
            "layers": [{"code": "20", "colorPenId": "9", "color": "#000", "lw": 1, "children": [{"code": "21"}]}],
            "walls": [{"id": "w", "colorPenId": "1", "color": "#111111", "strokeWeight": 0.5}, {"id": "w2", "colorPenId": "1"}],
        }));
        let ops = rebake_ops(&p);
        let kinds: Vec<(String, String)> = ops
            .iter()
            .map(|o| (o["kind"].as_str().unwrap().into(), o["entity"]["id"].as_str().or(o["key"].as_str()).unwrap().into()))
            .collect();
        assert_eq!(kinds, vec![("replace".into(), "c1".into()), ("setField".into(), "layers".into()), ("replace".into(), "w2".into())]);
        // fehlender Stift im Satz: Rückfallfarbe
        assert_eq!(ops[1]["value"][0]["color"], PEN_FALLBACK_COLOR);
        assert_eq!(ops[1]["value"][0]["lw"], PEN_FALLBACK_WEIGHT);
        assert_eq!(ops[2]["entity"]["strokeWeight"], 0.5);
    }

    #[test]
    fn stift_loeschen_entfernt_verweise() {
        let p = root(json!({
            "pens": [{"id": "1", "name": "x"}, {"id": "2", "name": "y"}],
            "penSets": [{"id": "a", "pens": {"1": {"color": "#1", "weight": 1}, "2": {"color": "#2", "weight": 1}}}],
            "components": [{"id": "c", "colorPenId": "1", "foregroundPenId": "2"}],
            "layers": [{"code": "1", "children": [{"code": "2", "colorPenId": "1"}]}],
        }));
        let ops = delete_pen_ops(&p, "1");
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0]["kind"], "remove");
        assert!(ops[1]["entity"]["pens"].get("1").is_none());
        assert!(ops[2]["entity"].get("colorPenId").is_none());
        assert_eq!(ops[2]["entity"]["foregroundPenId"], "2");
        assert!(ops[3]["value"][0]["children"][0].get("colorPenId").is_none());
        assert!(delete_pen_ops(&p, "9").is_empty());
    }

    #[test]
    fn standardpalette_anlegen() {
        let p = root(json!({"components": [{"id": "c", "color": "#000", "colorPenId": "7"}], "layers": []}));
        let ops = seed_standard_ops(&p, "penset-1", "Standard (CAD-Palette)");
        assert_eq!(ops[0]["key"], "pens");
        assert_eq!(ops[1]["collection"], "penSets");
        assert_eq!(ops[2]["value"], "penset-1");
        // Bauteil bekommt die Farbe von Stift 7 (Schwarz) aus dem neuen aktiven Satz
        assert_eq!(ops[3]["entity"]["color"], "#000000");
        assert_eq!(ops.len(), 4);
    }
}
