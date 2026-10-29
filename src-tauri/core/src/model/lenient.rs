//! Tolerantes Einlesen der typisierten Sicht: Dateien von der Platte und Importe können Werte tragen,
//! die nicht zum Modell passen — `null` statt einer Zahl (NaN überlebt JSON nicht), eine Zeichenkette
//! statt eines Punkts, eine kaputte Form. Ohne Toleranz scheitert das ganze Projekt an EINEM Wert und
//! jede Abfrage wirft. Hier wird nur das Nötige verworfen: der Wert, an dem es scheitert, fällt auf die
//! Vorgabe des Modells zurück (`#[serde(default)]`); lässt sich ein Listenelement gar nicht lesen,
//! entfällt es. Die JSON-Wurzel des Dokuments bleibt unverändert (Speichern verliert nichts).
//!
//! Vorgehen (typunabhängig, nur über Probe-Lesen): erst das ganze Feld, dann je Listenelement; ein
//! Element, das nicht passt, wird von leer aus wieder aufgebaut — Schlüssel (bzw. Listeneinträge)
//! werden in Hälften zugefügt, solange das Probe-Lesen gelingt; ein einzelner Schlüssel, der es
//! scheitern lässt, wird rekursiv repariert oder weggelassen. Aufwand nur im Fehlerfall.

use super::Project;
use serde_json::{Map, Value};

/// Ein Pfadschritt im JSON-Baum.
#[derive(Clone, Debug)]
enum Seg {
    Key(String),
    Index(usize),
}

fn get_mut<'a>(v: &'a mut Value, path: &[Seg]) -> Option<&'a mut Value> {
    let mut cur = v;
    for s in path {
        cur = match (s, cur) {
            (Seg::Key(k), Value::Object(m)) => m.get_mut(k)?,
            (Seg::Index(i), Value::Array(a)) => a.get_mut(*i)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn path_text(path: &[Seg]) -> String {
    let mut s = String::new();
    for p in path {
        match p {
            Seg::Key(k) => {
                if !s.is_empty() {
                    s.push('.');
                }
                s.push_str(k);
            }
            Seg::Index(i) => s.push_str(&format!("[{i}]")),
        }
    }
    s
}

/// Repariert `cur` (ganzer Wert, den `ok` prüft) so, dass `ok(cur)` gelingt; verworfene Pfade
/// landen in `dropped`. `false`: auch die Wurzel lässt sich nicht lesen.
fn repair(cur: &mut Value, ok: &dyn Fn(&Value) -> bool, dropped: &mut Vec<String>) -> bool {
    if ok(cur) {
        return true;
    }
    let mut path = Vec::new();
    rebuild(cur, &mut path, ok, dropped)
}

/// Baut den Knoten an `path` von leer aus neu auf (Vorbedingung: das Ganze scheitert mit ihm).
/// `false`: der Knoten lässt sich auch leer nicht lesen — der Aufrufer entfernt ihn.
fn rebuild(cur: &mut Value, path: &mut Vec<Seg>, ok: &dyn Fn(&Value) -> bool, dropped: &mut Vec<String>) -> bool {
    let Some(node) = get_mut(cur, path) else { return false };
    match std::mem::take(node) {
        Value::Object(orig) => {
            // 1. Leer anfangen (Strukturen mit Vorgaben) und die Schlüssel wieder zufügen.
            *get_mut(cur, path).expect("eben gelesen") = Value::Object(Map::new());
            if ok(cur) {
                add_keys(cur, path, orig.into_iter().collect(), ok, dropped);
                return true;
            }
            // 2. Pflichtfelder (z. B. `Vec2 {x, y}`): `null` bzw. jeder Nicht-Zahl-Wert als 0.
            for zero_all in [false, true] {
                let mut subst = Vec::new();
                let candidate: Map<String, Value> = orig
                    .iter()
                    .map(|(k, v)| {
                        let replace = if zero_all { !(v.is_number() || v.is_object() || v.is_array()) } else { v.is_null() };
                        if replace {
                            subst.push(k.clone());
                            (k.clone(), Value::from(0.0))
                        } else {
                            (k.clone(), v.clone())
                        }
                    })
                    .collect();
                if subst.is_empty() {
                    continue;
                }
                *get_mut(cur, path).expect("eben gelesen") = Value::Object(candidate);
                if ok(cur) {
                    for k in subst {
                        path.push(Seg::Key(k));
                        dropped.push(path_text(path));
                        path.pop();
                    }
                    return true;
                }
            }
            // 3. Nur die Zeichenketten (Kennungen wie `shape`/`kind`/`type` innerer Enums), dann der Rest.
            let (tags, rest): (Vec<(String, Value)>, Vec<(String, Value)>) = orig.into_iter().partition(|(_, v)| v.is_string());
            *get_mut(cur, path).expect("eben gelesen") = Value::Object(tags.into_iter().collect());
            if !ok(cur) {
                return false;
            }
            add_keys(cur, path, rest, ok, dropped);
            true
        }
        Value::Array(orig) => {
            *get_mut(cur, path).expect("eben gelesen") = Value::Array(Vec::new());
            if !ok(cur) {
                return false;
            }
            add_items(cur, path, orig, ok, dropped);
            true
        }
        other => {
            *get_mut(cur, path).expect("eben gelesen") = other;
            false
        }
    }
}

/// Fügt `items` (in Hälften) zum Objekt an `path` hinzu, solange `ok` gilt.
fn add_keys(cur: &mut Value, path: &mut Vec<Seg>, items: Vec<(String, Value)>, ok: &dyn Fn(&Value) -> bool, dropped: &mut Vec<String>) {
    if items.is_empty() {
        return;
    }
    let keys: Vec<String> = items.iter().map(|(k, _)| k.clone()).collect();
    let insert_all = |cur: &mut Value, path: &[Seg], items: &[(String, Value)]| {
        if let Some(Value::Object(m)) = get_mut(cur, path) {
            for (k, v) in items {
                m.insert(k.clone(), v.clone());
            }
        }
    };
    let remove_all = |cur: &mut Value, path: &[Seg], keys: &[String]| {
        if let Some(Value::Object(m)) = get_mut(cur, path) {
            for k in keys {
                m.remove(k);
            }
        }
    };
    insert_all(cur, path, &items);
    if ok(cur) {
        return;
    }
    remove_all(cur, path, &keys);
    if items.len() == 1 {
        let (k, v) = items.into_iter().next().expect("ein Eintrag");
        let container = v.is_object() || v.is_array();
        if let Some(Value::Object(m)) = get_mut(cur, path) {
            m.insert(k.clone(), v);
        }
        path.push(Seg::Key(k.clone()));
        let fixed = container && rebuild(cur, path, ok, dropped);
        if !fixed {
            dropped.push(path_text(path));
        }
        path.pop();
        if !fixed {
            if let Some(Value::Object(m)) = get_mut(cur, path) {
                m.remove(&k);
            }
        }
        return;
    }
    let mut items = items;
    let second = items.split_off(items.len() / 2);
    add_keys(cur, path, items, ok, dropped);
    add_keys(cur, path, second, ok, dropped);
}

/// Hängt `items` (in Hälften, Reihenfolge bleibt) an die Liste an `path`, solange `ok` gilt.
fn add_items(cur: &mut Value, path: &mut Vec<Seg>, items: Vec<Value>, ok: &dyn Fn(&Value) -> bool, dropped: &mut Vec<String>) {
    if items.is_empty() {
        return;
    }
    let len = |cur: &mut Value, path: &[Seg]| match get_mut(cur, path) {
        Some(Value::Array(a)) => a.len(),
        _ => 0,
    };
    let base = len(cur, path);
    if let Some(Value::Array(a)) = get_mut(cur, path) {
        a.extend(items.iter().cloned());
    }
    if ok(cur) {
        return;
    }
    if let Some(Value::Array(a)) = get_mut(cur, path) {
        a.truncate(base);
    }
    if items.len() == 1 {
        let v = items.into_iter().next().expect("ein Eintrag");
        let container = v.is_object() || v.is_array();
        if let Some(Value::Array(a)) = get_mut(cur, path) {
            a.push(v);
        }
        path.push(Seg::Index(base));
        let fixed = container && rebuild(cur, path, ok, dropped);
        if !fixed {
            dropped.push(path_text(path));
        }
        path.pop();
        if !fixed {
            if let Some(Value::Array(a)) = get_mut(cur, path) {
                a.truncate(base);
            }
        }
        return;
    }
    let mut items = items;
    let second = items.split_off(items.len() / 2);
    add_items(cur, path, items, ok, dropped);
    add_items(cur, path, second, ok, dropped);
}

/// Setzt das Feld `key` der typisierten Sicht tolerant (s. Modulkopf). Liefert die verworfenen
/// Pfade (leer, wenn alles passte). Scheitert nie: notfalls gilt die Vorgabe des Felds.
pub fn set_field_lenient(p: &mut Project, key: &str, v: Option<&Value>) -> Vec<String> {
    if p.set_field(key, v).is_ok() {
        return Vec::new();
    }
    let mut dropped = Vec::new();
    let Some(v) = v else { return dropped };
    let probe = |val: &Value| Project::default().set_field(key, Some(val)).is_ok();
    let mut cur = v.clone();
    if let Value::Array(items) = &mut cur {
        // Je Element prüfen (Probe mit einer Ein-Element-Liste), kaputte reparieren oder weglassen.
        let mut out = Vec::with_capacity(items.len());
        for (i, item) in std::mem::take(items).into_iter().enumerate() {
            let mut one = Value::Array(vec![item]);
            let mut d = Vec::new();
            let fine = repair(&mut one, &probe, &mut d);
            let kept = match one {
                Value::Array(mut a) if fine && a.len() == 1 => a.pop(),
                _ => None,
            };
            dropped.extend(d.into_iter().map(|s| format!("{key}[{i}]{}", s.strip_prefix("[0]").unwrap_or(&s))));
            match kept {
                Some(x) => out.push(x),
                None => dropped.push(format!("{key}[{i}]")),
            }
        }
        cur = Value::Array(out);
    } else {
        let mut d = Vec::new();
        if !repair(&mut cur, &probe, &mut d) {
            dropped.push(key.to_string());
            let _ = p.set_field(key, None);
            return dropped;
        }
        dropped.extend(d.into_iter().map(|s| if s.is_empty() { key.to_string() } else { format!("{key}.{s}") }));
    }
    if p.set_field(key, Some(&cur)).is_err() {
        dropped.push(key.to_string());
        let _ = p.set_field(key, None);
    }
    dropped
}

/// Typisierte Sicht der ganzen JSON-Wurzel, tolerant (s. Modulkopf): erst am Stück, im Fehlerfall
/// Feld für Feld. Liefert die verworfenen Pfade.
pub fn project_lenient(root: &Map<String, Value>) -> (Project, Vec<String>) {
    let mut p = Project::default();
    let mut dropped = Vec::new();
    for (k, v) in root {
        dropped.extend(set_field_lenient(&mut p, k, Some(v).filter(|v| !v.is_null())));
    }
    (p, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }

    #[test]
    fn null_statt_zahl_faellt_auf_vorgabe() {
        let r = root(json!({
            "id": "p", "name": "x", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "drawingLevels": [], "layers": [], "drawings2d": [],
            "walls": [
                {"id": "w1", "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": null, "y": 2}, "end": {"x": 3, "y": 2}, "wallTypeId": "t", "height": null},
                {"id": "w2", "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 1, "y": 0}, "wallTypeId": "t", "height": 2.5}
            ]
        }));
        assert!(Project::deserialize(&Value::Object(r.clone())).is_err(), "Vorbedingung: streng scheitert es");
        let (p, dropped) = project_lenient(&r);
        assert_eq!(p.walls.len(), 2);
        assert_eq!(p.walls[0].start.y, 2.0, "der Rest des Punkts bleibt");
        assert_eq!(p.walls[0].start.x, 0.0);
        assert_eq!(p.walls[0].height, 0.0);
        assert_eq!(p.walls[0].end.x, 3.0);
        assert_eq!(p.walls[1].height, 2.5);
        assert!(dropped.contains(&"walls[0].start.x".to_string()) && dropped.contains(&"walls[0].height".to_string()), "{dropped:?}");
    }

    #[test]
    fn falsche_typen_und_kaputte_listen() {
        let r = root(json!({
            "id": "p", "lineStyles": "keine Liste", "walls": [
                {"id": "w1", "start": "hier", "height": "hoch"},
                7,
                {"id": "w3", "end": {"x": 1, "y": 1}}
            ],
            "ceilings": [{"id": "c1", "outline": [{"x": 0, "y": 0}, null, {"x": 1, "y": "a"}, {"x": 1, "y": 1}]}],
            "siteRules": {"parcel": [{"x": 0, "y": 0}], "maxHeight": null}
        }));
        let (p, dropped) = project_lenient(&r);
        assert!(p.line_styles.is_empty());
        assert_eq!(p.walls.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["w1", "w3"], "nicht lesbares Element entfällt");
        assert_eq!(p.walls[1].end.x, 1.0);
        let c = &p.ceilings.as_ref().unwrap()[0];
        assert_eq!(c.outline.len(), 3, "kaputter Punkt entfällt, halber Punkt mit Vorgabe: {:?}", c.outline);
        assert_eq!((c.outline[1].x, c.outline[1].y), (1.0, 0.0));
        assert!(p.site_rules.is_some());
        assert!(dropped.iter().any(|d| d == "walls[1]"), "{dropped:?}");
    }

    #[test]
    fn passendes_projekt_unveraendert() {
        let r = root(json!({"id": "p", "walls": [{"id": "w", "height": 3}]}));
        let (p, dropped) = project_lenient(&r);
        assert!(dropped.is_empty());
        assert_eq!(p, Project::deserialize(&Value::Object(r)).unwrap());
    }
}
