//! Prüfung neuer Werte gegen das typisierte Modell ([124]): Eine Op, die ein Element einfügt/ersetzt
//! oder ein Feld setzt, muss Werte liefern, die sich in den Modelltyp lesen lassen (`Project::set_field`,
//! dieselbe Lese-Logik wie die typisierte Sicht). Sonst würde das Dokument den Wert annehmen und
//! speichern, die typisierte Sicht aber still auf die Vorgabe zurückfallen (`lenient`).
//!
//! Alt-Dateien bleiben tolerant: Laden prüft nicht. Ersetzt eine Op ein Element (oder Feld), das schon
//! vorher nicht zum Modell passte, gilt nur ein NEUER Fehler: die Pfade, die das tolerante Lesen beim
//! neuen Wert verwerfen müsste, dürfen nicht über die des alten hinausgehen.
//!
//! Aufwand: nur die berührten Elemente/Felder werden gelesen (wie die typisierte Sicht es danach
//! ohnehin tut); die Fehlersuche (Pfade, Vergleich mit dem alten Wert) läuft nur im Fehlerfall.

use super::lenient::set_field_lenient;
use super::Project;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

/// Liest `v` als Feld `key` (`None`/`null` = Feld fehlt, wie die typisierte Sicht).
pub fn check_field(key: &str, v: Option<&Value>) -> Result<(), String> {
    super::allowing_extra(|| Project::default().set_field(key, v.filter(|v| !v.is_null())))
}

/// Pfade, die das tolerante Lesen von `v` als Feld `key` verwerfen müsste (leer = passt).
pub fn bad_paths(key: &str, v: Option<&Value>) -> BTreeSet<String> {
    super::allowing_extra(|| set_field_lenient(&mut Project::default(), key, v.filter(|v| !v.is_null()))).into_iter().collect()
}

/// Pfade eines einzelnen Listenelements (ohne den Präfix `key[0]`).
fn item_paths(key: &str, item: &Value) -> BTreeSet<String> {
    let one = Value::Array(vec![item.clone()]);
    let prefix = format!("{key}[0]");
    bad_paths(key, Some(&one))
        .into_iter()
        .map(|p| match p.strip_prefix(&prefix) {
            Some("") => "(Element)".to_string(),
            Some(rest) => rest.trim_start_matches('.').to_string(),
            None => p,
        })
        .collect()
}

fn id_text(v: &Value) -> &str {
    crate::ops::id_of(v).unwrap_or("undefined")
}

/// Meldung für ein Element, das nicht zum Modell passt.
fn item_message(key: &str, item: &Value, paths: &BTreeSet<String>) -> String {
    let err = check_field(key, Some(&Value::Array(vec![item.clone()]))).err().unwrap_or_default();
    let fields = paths.iter().cloned().collect::<Vec<_>>().join(", ");
    format!("„{key}\" {}: Feld {fields} passt nicht zum Modell ({err}).", id_text(item))
}

/// Prüft neue Listenelemente (`add`/`replace` in die Liste `key`). `items` wird für die Prüfung
/// kurz in ein Array verschoben (keine Kopie) und unverändert zurückgegeben. `old(id)` = das Element
/// mit dieser id vor der Op (Alt-Fehler zählen nicht, s. Modulkopf).
pub fn check_items<'a>(key: &str, items: &mut Vec<Value>, old: &dyn Fn(&str) -> Option<&'a Value>) -> Vec<String> {
    let arr = Value::Array(std::mem::take(items));
    let whole = check_field(key, Some(&arr));
    let Value::Array(back) = arr else { unreachable!("eben gebaut") };
    *items = back;
    if whole.is_ok() {
        return Vec::new();
    }
    let mut problems = Vec::new();
    for item in items.iter() {
        let one = Value::Array(vec![item.clone()]);
        if check_field(key, Some(&one)).is_ok() {
            continue;
        }
        let paths = item_paths(key, item);
        let legacy = crate::ops::id_of(item).and_then(old).map(|o| item_paths(key, o));
        if legacy.is_some_and(|l| paths.is_subset(&l)) {
            continue;
        }
        problems.push(item_message(key, item, &paths));
    }
    problems
}

/// Prüft einen neuen Feldwert (`setField`). `old` = Wert vorher. Bei Listen mit ids werden Alt-Fehler
/// je Element (per id) verglichen, sonst über das ganze Feld.
pub fn check_set_field(key: &str, value: Option<&Value>, old: Option<&Value>) -> Vec<String> {
    let Err(err) = check_field(key, value) else { return Vec::new() };
    if let Some(Value::Array(items)) = value {
        if items.iter().all(|e| crate::ops::id_of(e).is_some()) {
            let old_by_id: HashMap<&str, &Value> =
                old.and_then(Value::as_array).into_iter().flatten().filter_map(|e| crate::ops::id_of(e).map(|i| (i, e))).collect();
            let mut items = items.clone();
            return check_items(key, &mut items, &|id| old_by_id.get(id).copied());
        }
    }
    let new_paths = bad_paths(key, value);
    if old.is_some_and(|o| new_paths.is_subset(&bad_paths(key, Some(o)))) && !new_paths.is_empty() {
        return Vec::new();
    }
    let fields = new_paths.into_iter().collect::<Vec<_>>().join(", ");
    let fields = if fields.is_empty() { key.to_string() } else { fields };
    vec![format!("Feld „{key}\": {fields} passt nicht zum Modell ({err}).")]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn element_pruefung_meldet_id_feld_und_fehler() {
        let mut items = vec![json!({"id": "w1", "height": "hoch"})];
        let p = check_items("walls", &mut items, &|_| None);
        assert_eq!(items.len(), 1, "Elemente kommen zurück");
        assert_eq!(p.len(), 1);
        assert!(p[0].contains("w1") && p[0].contains("height") && p[0].contains("invalid type"), "{p:?}");
        // Passend, fremde Liste (ausserhalb des Modells): keine Meldung.
        assert!(check_items("walls", &mut vec![json!({"id": "w", "height": 3})], &|_| None).is_empty());
        assert!(check_items("eigeneListe", &mut vec![json!({"id": "x", "a": "b"})], &|_| None).is_empty());
    }

    #[test]
    fn alt_fehler_zaehlen_nicht() {
        let old = json!({"id": "w1", "height": null, "start": {"x": 0, "y": 0}});
        // Gleicher Alt-Fehler, andere Änderung: angenommen.
        let mut items = vec![json!({"id": "w1", "height": null, "start": {"x": 1, "y": 0}})];
        assert!(check_items("walls", &mut items, &|_| Some(&old)).is_empty());
        // Neuer Fehler dazu: abgelehnt.
        let mut items = vec![json!({"id": "w1", "height": null, "start": {"x": "a", "y": 0}})];
        let p = check_items("walls", &mut items, &|_| Some(&old));
        assert!(p.len() == 1 && p[0].contains("start.x"), "{p:?}");
    }

    #[test]
    fn feld_pruefung() {
        assert!(check_set_field("parcelArea", Some(&json!(12.5)), None).is_empty());
        assert!(check_set_field("parcelArea", Some(&Value::Null), None).is_empty(), "null = Feld fehlt");
        assert!(check_set_field("parcelArea", None, None).is_empty());
        let p = check_set_field("parcelArea", Some(&json!("gross")), None);
        assert!(p.len() == 1 && p[0].contains("parcelArea"), "{p:?}");
        let p = check_set_field("walls", Some(&json!([{"id": "a"}, {"id": "b", "height": [1]}])), None);
        assert!(p.len() == 1 && p[0].contains("\" b:") && p[0].contains("height"), "{p:?}");
        // Unbekanntes Feld: frei (Extra).
        assert!(check_set_field("meinFeld", Some(&json!({"x": "y"})), None).is_empty());
    }
}
