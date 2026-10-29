//! Ebenen/Kategorien-Baum ([K4] S3, vorher `model/types.ts`, `state/projectSlice.ts`,
//! `state/selectionLayers.ts`, `io/dxfToDrawings.ts`): Abflachen, Nachschlagen, Sichtbarkeit,
//! Isolieren, Baum-Umbauten (Umschalten, Ändern, Unterkategorie, Duplikat, Löschen) und freie Codes.
//! Die Rechnung läuft auf `serde_json::Value` (verlustfrei: unbekannte Felder und Reihenfolge der Schlüssel
//! bleiben), Reihenfolgen und Sonderfälle wie in der TS-Fassung (doppelte Codes: es greifen alle Treffer
//! bzw. der erste, fehlende Felder = JS-`undefined`).

use crate::model::Project;
use serde_json::{Map, Value};
use std::collections::HashSet;

type Tree = Vec<Value>;

/// JS-Wahrheitswert eines JSON-Werts (`if (c.visible)`).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn code_of(c: &Value) -> Option<&str> {
    c.get("code").and_then(Value::as_str)
}

fn children(c: &Value) -> Option<&Tree> {
    c.get("children").and_then(Value::as_array)
}

/// Kopie von `c` mit gesetztem Schlüssel (`{...c, key: v}`: vorhandener Schlüssel behält seine Stelle).
fn with(c: &Value, key: &str, v: Value) -> Value {
    let mut m: Map<String, Value> = c.as_object().cloned().unwrap_or_default();
    m.insert(key.to_string(), v);
    Value::Object(m)
}

/// Flacht den Baum (Tiefensuche, Eltern vor Kindern) ab (`flattenCategories`).
pub fn flatten(cats: &[Value]) -> Vec<&Value> {
    fn walk<'a>(list: &'a [Value], out: &mut Vec<&'a Value>) {
        for c in list {
            out.push(c);
            if let Some(ch) = children(c) {
                walk(ch, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(cats, &mut out);
    out
}

/// Erste Kategorie mit `code` im Baum (`findCategory`, `getLayerCategory`).
pub fn find<'a>(cats: &'a [Value], code: &str) -> Option<&'a Value> {
    flatten(cats).into_iter().find(|c| code_of(c) == Some(code))
}

/// Codes aller sichtbaren Kategorien in Baumreihenfolge (`collectVisibleCodes`, ohne Doppelungen).
pub fn visible_codes(cats: &[Value]) -> Vec<String> {
    let mut seen = HashSet::new();
    flatten(cats)
        .into_iter()
        .filter(|c| truthy(c.get("visible")))
        .filter_map(|c| code_of(c).map(str::to_string))
        .filter(|c| seen.insert(c.clone()))
        .collect()
}

/// Wendet `f` auf jede Kategorie an (Kinder zuerst); `None` = nichts geändert (`mapCategories`).
fn map_cats(cats: &[Value], f: &dyn Fn(&Value) -> Option<Value>) -> Option<Tree> {
    let mut changed = false;
    let next: Tree = cats
        .iter()
        .map(|c| {
            let base = match children(c).and_then(|ch| map_cats(ch, f)) {
                Some(ch) => {
                    changed = true;
                    with(c, "children", Value::Array(ch))
                }
                None => c.clone(),
            };
            match f(&base) {
                Some(out) => {
                    changed = true;
                    out
                }
                None => base,
            }
        })
        .collect();
    changed.then_some(next)
}

/// `visible` genau für `codes` setzen; `None` = nichts zu tun (`setCategoriesVisible`).
pub fn set_visible(cats: &[Value], codes: &HashSet<String>, visible: bool) -> Option<Tree> {
    map_cats(cats, &|c| {
        let hit = code_of(c).is_some_and(|k| codes.contains(k));
        (hit && c.get("visible") != Some(&Value::Bool(visible))).then(|| with(c, "visible", Value::Bool(visible)))
    })
}

/// Nur `codes` sichtbar, alle übrigen aus; `None` = nichts zu tun (`isolateCategories`).
pub fn isolate(cats: &[Value], codes: &HashSet<String>) -> Option<Tree> {
    map_cats(cats, &|c| {
        let want = code_of(c).is_some_and(|k| codes.contains(k));
        (c.get("visible") != Some(&Value::Bool(want))).then(|| with(c, "visible", Value::Bool(want)))
    })
}

/// Anzeigenamen zu den Codes; unbekannter Code → der Code selbst (`categoryNames`).
pub fn names(cats: &[Value], codes: &[String]) -> Vec<String> {
    let all = flatten(cats);
    codes
        .iter()
        .map(|code| {
            all.iter()
                .find(|c| code_of(c) == Some(code))
                .and_then(|c| c.get("name").and_then(Value::as_str))
                .map_or_else(|| code.clone(), str::to_string)
        })
        .collect()
}

/// Sichtbarkeit der Kategorie `code` umschalten; trifft jede Kategorie mit dem Code, ohne unter einem
/// Treffer weiterzusuchen (`toggleCategoryByCode`).
pub fn toggle(cats: &[Value], code: &str) -> Tree {
    cats.iter()
        .map(|c| {
            if code_of(c) == Some(code) {
                return with(c, "visible", Value::Bool(!truthy(c.get("visible"))));
            }
            match children(c) {
                Some(ch) => with(c, "children", Value::Array(toggle(ch, code))),
                None => c.clone(),
            }
        })
        .collect()
}

/// `visible`-Flags gemäß `codes` (Code → sichtbar) setzen, unbekannte Codes ignorieren (`applyVisibilityByCode`).
pub fn apply_visibility(cats: &[Value], codes: &Map<String, Value>) -> Tree {
    cats.iter()
        .map(|c| {
            let next = match code_of(c).and_then(|k| codes.get(k)) {
                Some(v) => with(c, "visible", v.clone()),
                None => c.clone(),
            };
            match children(&next) {
                Some(ch) => with(&next, "children", Value::Array(apply_visibility(ch, codes))),
                None => next,
            }
        })
        .collect()
}

/// Kategorie `code` ändern (`{...c, ...patch}`; ein `null` im Patch entfernt das Feld = JS-`undefined`).
pub fn patch(cats: &[Value], code: &str, patch_obj: &Map<String, Value>) -> Tree {
    cats.iter()
        .map(|c| {
            if code_of(c) == Some(code) {
                let mut m = c.as_object().cloned().unwrap_or_default();
                for (k, v) in patch_obj {
                    if v.is_null() {
                        m.shift_remove(k);
                    } else {
                        m.insert(k.clone(), v.clone());
                    }
                }
                return Value::Object(m);
            }
            match children(c) {
                Some(ch) => with(c, "children", Value::Array(patch(ch, code, patch_obj))),
                None => c.clone(),
            }
        })
        .collect()
}

/// `child` als letztes Kind der Kategorie `parent_code` anhängen (`addChildByCode`).
pub fn add_child(cats: &[Value], parent_code: &str, child: &Value) -> Tree {
    cats.iter()
        .map(|c| {
            if code_of(c) == Some(parent_code) {
                let mut ch = children(c).cloned().unwrap_or_default();
                ch.push(child.clone());
                return with(c, "children", Value::Array(ch));
            }
            match children(c) {
                Some(ch) => with(c, "children", Value::Array(add_child(ch, parent_code, child))),
                None => c.clone(),
            }
        })
        .collect()
}

/// `clone` direkt nach der Kategorie `code` auf derselben Ebene einfügen (`insertAfterCode`). Anders als die
/// TS-Fassung (sie übersprang genau die Ebene, die das Ziel enthält, und verlor so das Duplikat einer
/// Unterkategorie) wird in jede Kinderliste hinabgestiegen.
pub fn insert_after(cats: &[Value], code: &str, clone: &Value) -> Tree {
    let mut out = Vec::with_capacity(cats.len() + 1);
    for c in cats {
        let next = match children(c) {
            Some(ch) => with(c, "children", Value::Array(insert_after(ch, code, clone))),
            None => c.clone(),
        };
        out.push(next);
        if code_of(c) == Some(code) {
            out.push(clone.clone());
        }
    }
    out
}

/// Kategorie `code` samt Kindern entfernen (`removeByCode`).
pub fn remove(cats: &[Value], code: &str) -> Tree {
    cats.iter()
        .filter(|c| code_of(c) != Some(code))
        .map(|c| match children(c) {
            Some(ch) => with(c, "children", Value::Array(remove(ch, code))),
            None => c.clone(),
        })
        .collect()
}

/// JS-`parseInt(s, 10)`: führende Leerzeichen, Vorzeichen, Ziffern bis zum ersten Fremdzeichen; sonst `None` (NaN).
pub fn js_parse_int(s: &str) -> Option<f64> {
    let t = s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let v: f64 = digits.parse().ok()?;
    Some(if neg { -v } else { v })
}

/// Zweistellig aufgefüllte Zahl (`String(i).padStart(2, "0")`).
fn pad2(i: f64) -> String {
    let s = format!("{i}");
    if s.len() < 2 {
        format!("0{s}")
    } else {
        s
    }
}

/// Alle Codes des Baums als Menge.
fn used_codes(cats: &[Value]) -> HashSet<String> {
    flatten(cats).into_iter().filter_map(|c| code_of(c).map(str::to_string)).collect()
}

/// Höchster numerischer Code (`Math.max(...nums)`), `None` ohne numerische Codes.
fn max_numeric(used: &HashSet<String>) -> Option<f64> {
    used.iter().filter_map(|c| js_parse_int(c)).fold(None, |m, n| Some(m.map_or(n, |m: f64| m.max(n))))
}

/// Nächster freier zweistelliger Code über den ganzen Baum (`nextFreeCode`); ab 999 `now_ms` als Text.
pub fn next_free_code(cats: &[Value], now_ms: f64) -> String {
    let used = used_codes(cats);
    let start = max_numeric(&used).unwrap_or(0.0);
    let mut i = start + 1.0;
    while i < 1000.0 {
        let c = pad2(i);
        if !used.contains(&c) {
            return c;
        }
        i += 1.0;
    }
    format!("{}", now_ms.trunc())
}

/// Kategorien für Import-Layer ohne gleichnamige Kategorie (`planImportCategories`): die neuen
/// Unterkategorien, der Code der (noch anzulegenden) Elternkategorie — leer, wenn keine neue Kategorie
/// nötig ist — und das Mapping Layer-Name → Code für alle Layer.
pub struct ImportPlan {
    pub children: Vec<Value>,
    pub parent_code: String,
    pub code_by_layer: Vec<(String, String)>,
}

pub fn plan_import(layer_names: &[String], existing: &[Value], colors: &Map<String, Value>, weights: &Map<String, Value>) -> ImportPlan {
    let mut used = used_codes(existing);
    // Namensvergleich ohne Gross-/Kleinschreibung; spätere gleichnamige Kategorien überschreiben frühere.
    let mut by_name: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for c in flatten(existing) {
        if let (Some(code), Some(name)) = (code_of(c), c.get("name").and_then(Value::as_str)) {
            by_name.insert(name.to_lowercase(), code.to_string());
        }
    }
    let mut next = max_numeric(&used).map_or(0.0, |m| m.max(0.0)) + 1.0;
    let mut allocate = |used: &mut HashSet<String>| -> String {
        while used.contains(&pad2(next)) {
            next += 1.0;
        }
        let code = pad2(next);
        next += 1.0;
        used.insert(code.clone());
        code
    };
    let mut code_by_layer: Vec<(String, String)> = Vec::new();
    let mut children = Vec::new();
    for name in layer_names {
        let key = name.to_lowercase();
        if let Some(known) = by_name.get(&key) {
            code_by_layer.push((name.clone(), known.clone()));
            continue;
        }
        let code = allocate(&mut used);
        by_name.insert(key, code.clone());
        code_by_layer.push((name.clone(), code.clone()));
        let color = colors.get(name).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::String("#707078".into()));
        let lw = weights.get(name).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| serde_json::json!(0.18));
        children.push(serde_json::json!({"code": code, "name": name, "color": color, "lw": lw, "visible": true, "locked": false}));
    }
    let parent_code = if children.is_empty() { String::new() } else { allocate(&mut used) };
    ImportPlan { children, parent_code, code_by_layer }
}

/// Auswahl nach Elementart (`SelectionMembers`: ids je Art).
#[derive(serde::Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SelectionMembers {
    pub wall_ids: Vec<String>,
    pub drawing_ids: Vec<String>,
    pub ceiling_ids: Vec<String>,
    pub room_ids: Vec<String>,
    pub stair_ids: Vec<String>,
    pub column_ids: Vec<String>,
    pub roof_ids: Vec<String>,
    pub opening_ids: Vec<String>,
}

/// Kategorie-Codes aller gewählten Objekte (eindeutig, in Fundreihenfolge; leere Codes zählen nicht).
pub fn selection_category_codes(p: &Project, sel: &SelectionMembers) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut scan = |ids: &[String], items: &mut dyn Iterator<Item = (&str, &str)>| {
        if ids.is_empty() {
            return;
        }
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        for (id, code) in items {
            if !code.is_empty() && wanted.contains(id) && seen.insert(code.to_string()) {
                out.push(code.to_string());
            }
        }
    };
    scan(&sel.wall_ids, &mut p.walls.iter().map(|o| (o.id.as_str(), o.category_code.as_str())));
    scan(&sel.drawing_ids, &mut p.drawings2d.iter().map(|o| (o.id.as_str(), o.category_code.as_str())));
    scan(&sel.ceiling_ids, &mut p.ceilings.iter().flatten().map(|o| (o.id.as_str(), o.category_code.as_str())));
    scan(&sel.room_ids, &mut p.rooms.iter().flatten().map(|o| (o.id.as_str(), o.category_code.as_str())));
    scan(&sel.stair_ids, &mut p.stairs.iter().flatten().map(|o| (o.id.as_str(), o.category_code.as_str())));
    scan(&sel.column_ids, &mut p.columns.iter().flatten().map(|o| (o.id.as_str(), o.category_code.as_str())));
    scan(&sel.roof_ids, &mut p.roofs.iter().flatten().map(|o| (o.id.as_str(), o.category_code.as_str())));
    scan(&sel.opening_ids, &mut p.openings.iter().flatten().map(|o| (o.id.as_str(), o.category_code.as_str())));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cat(code: &str, name: &str, visible: bool, ch: Option<Vec<Value>>) -> Value {
        let mut v = json!({"code": code, "name": name, "color": "#000", "lw": 0.2, "visible": visible, "locked": false});
        if let Some(ch) = ch {
            v["children"] = Value::Array(ch);
        }
        v
    }
    fn tree() -> Tree {
        vec![cat("20", "Wände", true, None), cat("05", "Import", true, Some(vec![cat("100", "01421", true, None), cat("101", "01847", true, None)]))]
    }
    fn set(codes: &[&str]) -> HashSet<String> {
        codes.iter().map(|s| s.to_string()).collect()
    }
    fn vis(t: &[Value]) -> Vec<(String, bool)> {
        flatten(t).iter().map(|c| (code_of(c).unwrap().to_string(), c["visible"].as_bool().unwrap())).collect()
    }
    fn codes_of(t: &[Value]) -> Vec<String> {
        flatten(t).iter().map(|c| code_of(c).unwrap().to_string()).collect()
    }

    #[test]
    fn abflachen_und_finden() {
        let t = tree();
        assert_eq!(codes_of(&t), ["20", "05", "100", "101"]);
        assert_eq!(find(&t, "101").unwrap()["name"], "01847");
        assert!(find(&t, "999").is_none());
        assert_eq!(visible_codes(&t), ["20", "05", "100", "101"]);
    }

    #[test]
    fn sichtbarkeit_isolieren_und_unveraendert() {
        let t = tree();
        let n = set_visible(&t, &set(&["100"]), false).unwrap();
        assert_eq!(vis(&n), [("20".into(), true), ("05".into(), true), ("100".into(), false), ("101".into(), true)]);
        assert!(set_visible(&t, &set(&["100"]), true).is_none());
        let iso = isolate(&t, &set(&["101"])).unwrap();
        assert_eq!(vis(&iso), [("20".into(), false), ("05".into(), false), ("100".into(), false), ("101".into(), true)]);
        assert_eq!(names(&t, &["100".into(), "20".into(), "999".into()]), ["01421", "Wände", "999"]);
    }

    #[test]
    fn umbauten() {
        let t = tree();
        assert_eq!(vis(&toggle(&t, "100"))[2], ("100".into(), false));
        let av = apply_visibility(&t, json!({"20": false, "101": false, "zz": true}).as_object().unwrap());
        assert_eq!(vis(&av), [("20".into(), false), ("05".into(), true), ("100".into(), true), ("101".into(), false)]);
        let p = patch(&t, "101", json!({"name": "X", "color": null}).as_object().unwrap());
        assert_eq!(find(&p, "101").unwrap()["name"], "X");
        assert!(find(&p, "101").unwrap().get("color").is_none());
        let ac = add_child(&t, "20", &cat("21", "k", true, None));
        assert_eq!(find(&ac, "20").unwrap()["children"][0]["code"], "21");
        assert_eq!(codes_of(&insert_after(&t, "100", &cat("102", "c", true, None))), ["20", "05", "100", "102", "101"]);
        assert_eq!(codes_of(&remove(&t, "05")), ["20"]);
    }

    #[test]
    fn freie_codes() {
        assert_eq!(js_parse_int(" 12abc"), Some(12.0));
        assert_eq!(js_parse_int("x1"), None);
        assert_eq!(js_parse_int("-3"), Some(-3.0));
        assert_eq!(next_free_code(&[], 5.0), "01");
        assert_eq!(next_free_code(&tree(), 5.0), "102");
        assert_eq!(next_free_code(&[cat("999", "x", true, None)], 1234.9), "1234");
        assert_eq!(next_free_code(&[cat("-5", "x", true, None), cat("ab", "y", true, None)], 0.0), "-4");
    }

    #[test]
    fn import_plan() {
        let t = vec![cat("05", "Import", true, None), cat("20", "Wände", true, None)];
        let weights = json!({"Neu": 0.5});
        let plan = plan_import(&["Wände".into(), "Neu".into(), "NEU".into()], &t, &Map::new(), weights.as_object().unwrap());
        assert_eq!(plan.children.len(), 1);
        assert_eq!(plan.children[0]["code"], "21");
        assert_eq!(plan.children[0]["lw"], 0.5);
        assert_eq!(plan.parent_code, "22");
        assert_eq!(plan.code_by_layer, [("Wände".into(), "20".into()), ("Neu".into(), "21".into()), ("NEU".into(), "21".into())]);
        let none = plan_import(&["wände".into()], &t, &Map::new(), &Map::new());
        assert!(none.children.is_empty());
        assert!(none.parent_code.is_empty());
    }
}
