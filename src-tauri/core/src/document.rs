//! Projekt-Dokument und Ops ([K4], Stufe S1): Rust hält das Projekt als JSON-Baum und wendet die
//! Op-Folgen an, die TS aus `core/ops.ts` erzeugt (`setField`/`add`/`replace`/`remove`/`reorder`).
//! Die Ops werden atomar angewendet und geprüft (doppelte ids); bei Verstoss bleibt das Dokument
//! unverändert. Später lesen die Ableitungen (Plan, Schnitt, 3D, Kennzahlen, Export) direkt dieses
//! Dokument statt flacher TS-Sammler.
//!
//! JSON kennt weder `undefined` noch NaN: fehlende Felder fehlen, nicht endliche Zahlen prüft TS
//! vor dem Senden (`validateOps`).

use crate::model::Project;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::rc::Rc;

/// Eine Änderung am Projekt (Spiegel von `CoreOp` in `core/ops.ts`).
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Add { collection: String, items: Vec<Value>, at: Option<usize> },
    Replace { collection: String, entity: Value },
    Remove { collection: String, ids: Vec<String> },
    Reorder { collection: String, ids: Vec<String> },
    SetField { key: String, value: Option<Value> },
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str)
}

impl Op {
    pub fn from_json(v: &Value) -> Result<Op, String> {
        let kind = v.get("kind").and_then(Value::as_str).ok_or("Op ohne kind")?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned).ok_or(format!("Op {kind}: {k} fehlt"));
        let ids = |k: &str| -> Result<Vec<String>, String> {
            v.get(k)
                .and_then(Value::as_array)
                .ok_or(format!("Op {kind}: {k} fehlt"))?
                .iter()
                .map(|x| x.as_str().map(str::to_owned).ok_or(format!("Op {kind}: {k} enthält Nicht-Text")))
                .collect()
        };
        Ok(match kind {
            "add" => {
                let items = v.get("items").and_then(Value::as_array).ok_or("Op add: items fehlt")?.clone();
                if items.iter().any(|e| id_of(e).is_none()) {
                    return Err("Op add: Element ohne id".into());
                }
                let at = match v.get("at") {
                    None | Some(Value::Null) => None,
                    Some(a) => Some(a.as_f64().filter(|x| x.is_finite()).map(|x| x.max(0.0) as usize).ok_or("Op add: at ungültig")?),
                };
                Op::Add { collection: s("collection")?, items, at }
            }
            "replace" => {
                let entity = v.get("entity").cloned().ok_or("Op replace: entity fehlt")?;
                if id_of(&entity).is_none() {
                    return Err("Op replace: Element ohne id".into());
                }
                Op::Replace { collection: s("collection")?, entity }
            }
            "remove" => Op::Remove { collection: s("collection")?, ids: ids("ids")? },
            "reorder" => Op::Reorder { collection: s("collection")?, ids: ids("ids")? },
            "setField" => Op::SetField { key: s("key")?, value: v.get("value").filter(|x| !x.is_null()).cloned() },
            other => return Err(format!("Unbekannte Op: {other}")),
        })
    }

    fn key(&self) -> &str {
        match self {
            Op::Add { collection, .. } | Op::Replace { collection, .. } | Op::Remove { collection, .. } | Op::Reorder { collection, .. } => collection,
            Op::SetField { key, .. } => key,
        }
    }
}

/// Liste mit lauter `id`-tragenden Elementen (leer zählt mit).
fn is_id_list(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(|e| id_of(e).is_some()))
}

fn unique_ids(list: &[Value]) -> bool {
    let mut seen = HashSet::new();
    list.iter().all(|e| seen.insert(id_of(e).unwrap_or("")))
}

fn has_dup(v: Option<&Value>) -> bool {
    match v {
        Some(v) if is_id_list(v) => !unique_ids(v.as_array().unwrap()),
        _ => false,
    }
}

#[derive(Clone, Debug, Default)]
pub struct Document {
    root: Map<String, Value>,
    /// Typisierte Sicht (Cache); jede Änderung verwirft sie.
    typed: Option<Rc<Project>>,
}

impl Document {
    pub fn from_json(text: &str) -> Result<Document, String> {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(root)) => Ok(Document { root, typed: None }),
            Ok(_) => Err("Projekt ist kein JSON-Objekt".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.root).unwrap_or_default()
    }

    /// Typisierte Sicht des Projekts (gecacht bis zur nächsten Änderung). Fehler = Feld, das dem
    /// Modell widerspricht (Meldung von serde).
    pub fn project(&mut self) -> Result<Rc<Project>, String> {
        if let Some(p) = &self.typed {
            return Ok(p.clone());
        }
        // Die Map wird nur ausgeliehen: `Value::Object` braucht Besitz, daher temporär herausnehmen.
        let value = Value::Object(std::mem::take(&mut self.root));
        let parsed = Project::deserialize(&value).map_err(|e| e.to_string());
        if let Value::Object(m) = value {
            self.root = m;
        }
        let p = Rc::new(parsed?);
        self.typed = Some(p.clone());
        Ok(p)
    }

    pub fn field(&self, key: &str) -> Option<&Value> {
        self.root.get(key)
    }

    fn list_mut(&mut self, collection: &str) -> &mut Vec<Value> {
        let slot = self.root.entry(collection.to_owned()).or_insert_with(|| Value::Array(vec![]));
        if !slot.is_array() {
            *slot = Value::Array(vec![]);
        }
        slot.as_array_mut().unwrap()
    }

    fn apply_one(&mut self, op: &Op) {
        match op {
            Op::SetField { key, value } => match value {
                Some(v) => {
                    self.root.insert(key.clone(), v.clone());
                }
                None => {
                    self.root.shift_remove(key);
                }
            },
            Op::Add { collection, items, at } => {
                let list = self.list_mut(collection);
                let at = at.map_or(list.len(), |a| a.min(list.len()));
                list.splice(at..at, items.iter().cloned());
            }
            Op::Replace { collection, entity } => {
                let list = self.list_mut(collection);
                let id = id_of(entity);
                match list.iter().position(|e| id_of(e) == id) {
                    Some(i) => list[i] = entity.clone(),
                    None => list.push(entity.clone()),
                }
            }
            Op::Remove { collection, ids } => {
                let drop: HashSet<&str> = ids.iter().map(String::as_str).collect();
                self.list_mut(collection).retain(|e| !id_of(e).is_some_and(|i| drop.contains(i)));
            }
            Op::Reorder { collection, ids } => {
                let list = std::mem::take(self.list_mut(collection));
                let mut ordered = Vec::with_capacity(list.len());
                let mut rest = Vec::new();
                let listed: HashSet<&str> = ids.iter().map(String::as_str).collect();
                for id in ids {
                    if let Some(e) = list.iter().find(|e| id_of(e) == Some(id.as_str())) {
                        ordered.push(e.clone());
                    }
                }
                for e in &list {
                    if !id_of(e).is_some_and(|i| listed.contains(i)) {
                        rest.push(e.clone());
                    }
                }
                ordered.extend(rest);
                *self.list_mut(collection) = ordered;
            }
        }
    }

    /// Wendet `ops` atomar an. Verstösse (neue doppelte ids) → `Err(Meldungen)`, Dokument unverändert.
    pub fn apply(&mut self, ops: &[Op]) -> Result<(), Vec<String>> {
        self.typed = None;
        // Zustand der berührten Felder sichern (Rücknahme) und Alt-Doppelungen merken.
        let mut saved: Vec<(String, Option<Value>)> = Vec::new();
        let mut had_dup: HashSet<String> = HashSet::new();
        for op in ops {
            let k = op.key().to_owned();
            if !saved.iter().any(|(s, _)| *s == k) {
                if has_dup(self.root.get(&k)) {
                    had_dup.insert(k.clone());
                }
                saved.push((k.clone(), self.root.get(&k).cloned()));
            }
        }
        for op in ops {
            self.apply_one(op);
        }
        let mut problems = Vec::new();
        let mut checked: HashSet<&str> = HashSet::new();
        for op in ops {
            let (key, is_add, is_set) = match op {
                Op::Add { collection, .. } => (collection.as_str(), true, false),
                Op::SetField { key, .. } => (key.as_str(), false, true),
                _ => continue,
            };
            if (is_add || is_set) && checked.insert(key) && !had_dup.contains(key) {
                if let Some(v) = self.root.get(key) {
                    let relevant = is_add || v.as_array().is_some_and(|a| !a.is_empty()) && is_id_list(v);
                    if relevant && is_id_list(v) && !unique_ids(v.as_array().unwrap()) {
                        problems.push(format!("Doppelte ids in „{key}\"."));
                    }
                }
            }
        }
        if problems.is_empty() {
            return Ok(());
        }
        for (k, old) in saved {
            match old {
                Some(v) => {
                    self.root.insert(k, v);
                }
                None => {
                    self.root.shift_remove(&k);
                }
            }
        }
        Err(problems)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Document {
        Document::from_json(r#"{"id":"p","walls":[{"id":"a","x":1},{"id":"b","x":2}],"name":"N"}"#).unwrap()
    }
    fn ops(v: Value) -> Vec<Op> {
        v.as_array().unwrap().iter().map(|o| Op::from_json(o).unwrap()).collect()
    }

    #[test]
    fn ops_wirken_wie_in_ts() {
        let mut d = doc();
        d.apply(&ops(json!([
            {"kind":"replace","collection":"walls","entity":{"id":"b","x":9}},
            {"kind":"add","collection":"walls","items":[{"id":"c"}],"at":0},
            {"kind":"remove","collection":"walls","ids":["a"]},
            {"kind":"setField","key":"name","value":"M"},
            {"kind":"setField","key":"id"},
        ])))
        .unwrap();
        assert_eq!(d.to_json(), r#"{"name":"M","walls":[{"id":"c"},{"id":"b","x":9}]}"#.replace(r#"{"name":"M","walls""#, r#"{"walls""#).replace("}]}", r#"}],"name":"M"}"#));
        d.apply(&ops(json!([{"kind":"reorder","collection":"walls","ids":["b"]}]))).unwrap();
        assert_eq!(d.field("walls").unwrap()[0]["id"], "b");
    }

    #[test]
    fn doppelte_ids_werden_zurueckgenommen() {
        let mut d = doc();
        let before = d.to_json();
        let e = d.apply(&ops(json!([{"kind":"add","collection":"walls","items":[{"id":"a"}]}]))).unwrap_err();
        assert_eq!(e, vec!["Doppelte ids in „walls\".".to_string()]);
        assert_eq!(d.to_json(), before);
    }

    #[test]
    fn alt_doppelungen_bleiben_aenderbar() {
        let mut d = Document::from_json(r#"{"walls":[{"id":"a"},{"id":"a"}]}"#).unwrap();
        d.apply(&ops(json!([{"kind":"add","collection":"walls","items":[{"id":"z"}]}]))).unwrap();
    }

    #[test]
    fn typisierte_sicht_folgt_den_ops() {
        let text = include_str!("../tests/fixtures/sample_project.json");
        let mut d = Document::from_json(text).unwrap();
        let n = d.project().unwrap().walls.len();
        assert!(n > 0);
        let id = d.project().unwrap().walls[0].id.clone();
        d.apply(&ops(json!([{"kind":"remove","collection":"walls","ids":[id]}]))).unwrap();
        assert_eq!(d.project().unwrap().walls.len(), n - 1);
    }

    #[test]
    fn kaputte_ops_sind_fehler() {
        assert!(Op::from_json(&json!({"kind":"add","collection":"w","items":[{"x":1}]})).is_err());
        assert!(Op::from_json(&json!({"kind":"nope"})).is_err());
    }
}
