//! Projekt-Dokument ([K4], Stufen S1/S3): Rust hält das Projekt als JSON-Baum, wendet Op-Folgen
//! (`ops.rs`) atomar an, prüft sie (NaN, neue doppelte ids → Rücknahme mit Meldungen) und führt den
//! Undo/Redo-Verlauf als inverse Ops. Die Ableitungen (Kennzahlen, 3D, Export …) lesen die
//! typisierte Sicht [`Document::project`].
//!
//! TS hält eine Leseansicht des Projekts und wendet genau die Ops an, die der Kern angenommen
//! (`commit`) oder für Undo/Redo geliefert hat (`core/document.ts`).

use crate::model::Project;
pub use crate::ops::Op;
use crate::ops::{has_dup, id_of, unique_ids, History};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default)]
pub struct Document {
    root: Map<String, Value>,
    /// Typisierte Sicht (Cache). Eine Op markiert nur ihr Feld als geändert; `project()` liest dann
    /// genau diese Felder neu ein.
    typed: Option<Project>,
    dirty: HashSet<String>,
    /// Undo/Redo-Verlauf (inverse Ops, `ops::History`).
    history: History,
}

impl Document {
    pub fn from_json(text: &str) -> Result<Document, String> {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(root)) => Ok(Document { root, typed: None, dirty: HashSet::new(), history: History::default() }),
            Ok(_) => Err("Projekt ist kein JSON-Objekt".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Datei-Text des Projekts (`serializeProject`): Formatversion vorn, Einrückung 2.
    pub fn serialize(&self) -> String {
        crate::project_format::serialize_project(&self.root)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.root).unwrap_or_default()
    }

    /// Typisierte Sicht des Projekts (gecacht; nach Ops werden nur die berührten Felder neu gelesen).
    /// Fehler = Feld, das dem Modell widerspricht (Meldung von serde).
    pub fn project(&mut self) -> Result<&Project, String> {
        if self.typed.is_none() {
            // Die Map wird nur ausgeliehen: `Value::Object` braucht Besitz, daher temporär herausnehmen.
            let value = Value::Object(std::mem::take(&mut self.root));
            let parsed = Project::deserialize(&value).map_err(|e| e.to_string());
            if let Value::Object(m) = value {
                self.root = m;
            }
            self.typed = Some(parsed?);
            self.dirty.clear();
        } else if !self.dirty.is_empty() {
            let dirty: Vec<String> = self.dirty.drain().collect();
            let mut failed = None;
            if let Some(t) = self.typed.as_mut() {
                for key in &dirty {
                    if let Err(e) = t.set_field(key, self.root.get(key).filter(|v| !v.is_null())) {
                        failed = Some(e);
                        break;
                    }
                }
            }
            if let Some(e) = failed {
                self.typed = None;
                return Err(e);
            }
        }
        Ok(self.typed.as_ref().expect("gerade gesetzt"))
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


    /// Wendet eine Op ohne Aufzeichnung an (Semantik wie `applyOps` in TS).
    fn apply_raw(&mut self, op: &Op) {
        match op {
            Op::SetField { key, value, at } => match value {
                Some(v) => match at {
                    Some(i) if !self.root.contains_key(key) => {
                        let i = (*i).min(self.root.len());
                        self.root.shift_insert(i, key.clone(), v.clone());
                    }
                    _ => {
                        self.root.insert(key.clone(), v.clone());
                    }
                },
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
                let listed: HashSet<&str> = ids.iter().map(String::as_str).collect();
                let mut by_id: HashMap<&str, &Value> = HashMap::new();
                for e in &list {
                    // Erstes Vorkommen gewinnt (wie bisher `find`).
                    if let Some(i) = id_of(e) {
                        by_id.entry(i).or_insert(e);
                    }
                }
                let mut ordered: Vec<Value> = ids.iter().filter_map(|id| by_id.get(id.as_str()).map(|e| (*e).clone())).collect();
                ordered.extend(list.iter().filter(|e| !id_of(e).is_some_and(|i| listed.contains(i))).cloned());
                *self.list_mut(collection) = ordered;
            }
        }
    }

    /// Wendet eine Op an und liefert (inverse Ops in Anwendungsreihenfolge, normalisierte
    /// Vorwärts-Op). Listen bekommen feine Inverse (`replace` ↔ altes Element, `add` ↔ `remove`,
    /// `remove` ↔ `add` an den alten Positionen, `reorder` ↔ alte Reihenfolge), wo das exakt ist
    /// (`add`: ids neu und eindeutig; `reorder`: alle ids eindeutig); sonst (fehlendes Feld, kein
    /// Array, Alt-Doppelungen) wird das ganze Feld samt Position gesichert. Ohne Hash über die ganze
    /// Liste — ein Drag-Schritt kostet nur das Suchen des Elements.
    fn apply_recorded(&mut self, op: &Op) -> (Vec<Op>, Op) {
        let key = op.key();
        let old = self.root.get(key);
        let snapshot = || {
            let at = self.root.keys().position(|k| k == key);
            Op::SetField { key: key.to_owned(), value: old.cloned(), at }
        };
        let clean = match op {
            Op::SetField { .. } => None,
            Op::Reorder { .. } => old.and_then(Value::as_array).filter(|a| a.iter().all(|e| id_of(e).is_some()) && unique_ids(a)),
            _ => old.and_then(Value::as_array),
        };
        let mut forward = op.clone();
        let inverse = match (op, clean) {
            (_, None) => vec![snapshot()],
            (Op::Add { collection, items, .. }, Some(list)) => {
                let mut new_ids: HashSet<&str> = HashSet::with_capacity(items.len());
                let fresh = items.iter().all(|e| id_of(e).is_some_and(|i| new_ids.insert(i)))
                    && !list.iter().any(|e| id_of(e).is_some_and(|i| new_ids.contains(i)));
                if fresh {
                    vec![Op::Remove { collection: collection.clone(), ids: items.iter().filter_map(id_of).map(str::to_owned).collect() }]
                } else {
                    vec![snapshot()]
                }
            }
            (Op::Replace { collection, entity }, Some(list)) => match list.iter().position(|e| id_of(e) == id_of(entity)) {
                Some(i) => {
                    // Direkt ersetzen (spart die zweite Suche in `apply_raw`).
                    let slot = &mut self.root.get_mut(key).and_then(Value::as_array_mut).expect("Liste geprüft")[i];
                    let prev = std::mem::replace(slot, entity.clone());
                    return (vec![Op::Replace { collection: collection.clone(), entity: prev }], forward);
                }
                None => {
                    // Aufgezeichnet als `add` (so trifft jedes aufgezeichnete `replace` ein vorhandenes Element).
                    forward = Op::Add { collection: collection.clone(), items: vec![entity.clone()], at: None };
                    vec![Op::Remove { collection: collection.clone(), ids: vec![id_of(entity).unwrap_or("").to_owned()] }]
                }
            },
            (Op::Remove { collection, ids }, Some(list)) => {
                let drop: HashSet<&str> = ids.iter().map(String::as_str).collect();
                let mut runs: Vec<Op> = Vec::new();
                let mut prev: Option<usize> = None;
                for (i, e) in list.iter().enumerate() {
                    if !id_of(e).is_some_and(|x| drop.contains(x)) {
                        continue;
                    }
                    match runs.last_mut() {
                        Some(Op::Add { items, .. }) if prev.is_some_and(|p| p + 1 == i) => items.push(e.clone()),
                        _ => runs.push(Op::Add { collection: collection.clone(), items: vec![e.clone()], at: Some(i) }),
                    }
                    prev = Some(i);
                }
                runs
            }
            (Op::Reorder { collection, .. }, Some(list)) => {
                vec![Op::Reorder { collection: collection.clone(), ids: list.iter().filter_map(id_of).map(str::to_owned).collect() }]
            }
            (Op::SetField { .. }, Some(_)) => unreachable!("setField hat keine Liste"),
        };
        self.apply_raw(op);
        (inverse, forward)
    }

    /// Wendet `ops` atomar an und prüft sie (`ops::validate`). Verstösse → `Err(Meldungen)`,
    /// Dokument unverändert. Ok → (Vorwärts-Ops normalisiert, inverse Ops). `sanitize`: die Ops
    /// können Nicht-endlich-Marken enthalten (s. `ops.rs`).
    fn apply_checked(&mut self, ops: &[Op], sanitize: bool) -> Result<(Vec<Op>, Vec<Op>), Vec<String>> {
        // Alt-Doppelungen der Listen merken, in die eingefügt oder die gesetzt wird.
        let mut had_dup: HashSet<String> = HashSet::new();
        for op in ops {
            if matches!(op, Op::Add { .. } | Op::SetField { .. }) && !had_dup.contains(op.key()) && has_dup(self.root.get(op.key())) {
                had_dup.insert(op.key().to_owned());
            }
        }
        let mut inverses: Vec<Vec<Op>> = Vec::with_capacity(ops.len());
        let mut forward: Vec<Op> = Vec::with_capacity(ops.len());
        for op in ops {
            let (inv, fwd) = self.apply_recorded(op);
            inverses.push(inv);
            forward.push(fwd);
        }
        let problems = crate::ops::validate(&self.root, ops, &|k| had_dup.contains(k));
        if !problems.is_empty() {
            for inv in inverses.iter().rev() {
                for op in inv {
                    self.apply_raw(op);
                }
            }
            return Err(problems);
        }
        if sanitize {
            // Angenommene Nicht-endlich-Marken (zu tief für die Prüfung) als null speichern.
            let keys: HashSet<&str> = ops.iter().map(Op::key).collect();
            for k in keys {
                if let Some(v) = self.root.get_mut(k) {
                    crate::ops::sanitize_non_finite(v);
                }
            }
            crate::ops::sanitize_ops(&mut forward);
        }
        for op in ops {
            self.dirty.insert(op.key().to_owned());
        }
        Ok((forward, inverses.into_iter().rev().flatten().collect()))
    }

    /// Wendet `ops` atomar an, ohne Verlauf (Abgleich des Spiegels). Verstösse (NaN, neue
    /// doppelte ids) → `Err(Meldungen)`, Dokument unverändert.
    pub fn apply(&mut self, ops: &[Op]) -> Result<(), Vec<String>> {
        self.apply_checked(ops, false).map(|_| ())
    }

    /// Wie [`Document::apply`]; `sanitize` = die Ops können Nicht-endlich-Marken enthalten.
    pub fn apply_marked(&mut self, ops: &[Op], sanitize: bool) -> Result<(), Vec<String>> {
        self.apply_checked(ops, sanitize).map(|_| ())
    }

    /// Eine Benutzer-Änderung: anwenden, prüfen und als Undo-Schritt aufzeichnen (`key` =
    /// `coalesceKey`, `now` = Zeit in ms für das Koaleszenz-Fenster).
    pub fn commit(&mut self, ops: &[Op], key: Option<&str>, now: f64, sanitize: bool) -> Result<(), Vec<String>> {
        let (forward, inverse) = self.apply_checked(ops, sanitize)?;
        self.history.record(forward, inverse, key, now);
        Ok(())
    }

    fn apply_unchecked(&mut self, ops: &[Op]) {
        for op in ops {
            self.apply_raw(op);
            self.dirty.insert(op.key().to_owned());
        }
    }

    /// Einen Schritt zurück; liefert die angewendeten Ops (für die TS-Leseansicht), `None` = nichts.
    pub fn undo(&mut self) -> Option<Vec<Op>> {
        let step = self.history.pop_undo()?;
        self.apply_unchecked(&step.inverse);
        let ops = step.inverse.clone();
        self.history.push_redo(step);
        Some(ops)
    }

    /// Einen Schritt vor; liefert die angewendeten Ops, `None` = nichts.
    pub fn redo(&mut self) -> Option<Vec<Op>> {
        let step = self.history.pop_redo()?;
        self.apply_unchecked(&step.forward);
        let ops = step.forward.clone();
        self.history.push_undo(step);
        Some(ops)
    }

    pub fn history(&self) -> &History {
        &self.history
    }

    pub fn history_mut(&mut self) -> &mut History {
        &mut self.history
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
        // Feld entfernen und wieder setzen
        d.apply(&ops(json!([{"kind":"setField","key":"name"}]))).unwrap();
        assert_eq!(d.project().unwrap().name, "");
        d.apply(&ops(json!([{"kind":"setField","key":"name","value":"X"}]))).unwrap();
        assert_eq!(d.project().unwrap().name, "X");
    }

    #[test]
    fn kaputte_ops_sind_fehler() {
        assert!(Op::from_json(&json!({"kind":"add","collection":"w","items":[{"x":1}]})).is_err());
        assert!(Op::from_json(&json!({"kind":"nope"})).is_err());
    }

    /// Deterministischer Zufall (LCG wie in den TS-Tests).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = (self.0.wrapping_mul(1664525).wrapping_add(1013904223)) % 4294967296;
            self.0 as f64 / 4294967296.0
        }
        fn below(&mut self, n: usize) -> usize {
            ((self.next() * n as f64) as usize).min(n.saturating_sub(1))
        }
    }

    fn ids(d: &Document, c: &str) -> Vec<String> {
        d.field(c).and_then(Value::as_array).map(|a| a.iter().filter_map(id_of).map(str::to_owned).collect()).unwrap_or_default()
    }

    /// Zufällige Op-Folge auf dem aktuellen Stand (manchmal mit Verstoss: doppelte id, NaN).
    fn random_ops(d: &Document, r: &mut Rng, n: usize) -> Vec<Op> {
        let mut out = Vec::new();
        let colls = ["walls", "ceilings", "rooms", "neu"];
        for k in 0..1 + r.below(3) {
            let c = colls[r.below(colls.len())].to_owned();
            let cur = ids(d, &c);
            let pick = r.next();
            let op = if pick < 0.25 || cur.is_empty() {
                let at = if r.next() < 0.5 { Some(r.below(cur.len() + 2)) } else { None };
                let id = if r.next() < 0.03 && !cur.is_empty() { cur[0].clone() } else { format!("z{n}-{k}") };
                let h = if r.next() < 0.03 { json!("\u{1}NaN") } else { json!(r.next()) };
                json!({"kind":"add","collection":c,"items":[{"id":id,"h":h}],"at":at})
            } else if pick < 0.5 {
                let id = &cur[r.below(cur.len())];
                json!({"kind":"replace","collection":c,"entity":{"id":id,"h":r.next(),"n":n}})
            } else if pick < 0.65 {
                let mut drop = vec![cur[r.below(cur.len())].clone()];
                if r.next() < 0.5 {
                    drop.push(cur[r.below(cur.len())].clone());
                }
                json!({"kind":"remove","collection":c,"ids":drop})
            } else if pick < 0.75 {
                let mut p = cur.clone();
                for i in (1..p.len()).rev() {
                    p.swap(i, r.below(i + 1));
                }
                p.truncate(1 + r.below(p.len()));
                json!({"kind":"reorder","collection":c,"ids":p})
            } else if pick < 0.85 {
                json!({"kind":"setField","key":"name","value":format!("n{n}")})
            } else if pick < 0.92 {
                if d.field("extra").is_some() {
                    json!({"kind":"setField","key":"extra"})
                } else {
                    json!({"kind":"setField","key":"extra","value":{"v":n}})
                }
            } else {
                // Ganze Liste setzen (auch Liste mit Alt-Doppelungen → Feld-Sicherung als Inverse).
                let dup = r.next() < 0.3;
                json!({"kind":"setField","key":c,"value":[{"id":"s1"},{"id": if dup {"s1"} else {"s2"}}]})
            };
            out.push(Op::from_json(&op).unwrap());
        }
        out
    }

    #[test]
    fn tausend_zufallsaenderungen_undo_redo_exakt() {
        let text = include_str!("../tests/fixtures/sample_project.json");
        let mut d = Document::from_json(text).unwrap();
        d.history_mut().max_steps = 5000;
        let start = d.to_json();
        let mut r = Rng(7);
        let mut committed = 0;
        let mut rejected = 0;
        for n in 0..1000 {
            let ops = random_ops(&d, &mut r, n);
            let before = d.to_json();
            // Ohne Schlüssel: jede Änderung ein Schritt.
            match d.commit(&ops, None, n as f64 * 1000.0, true) {
                Ok(()) => committed += 1,
                Err(_) => {
                    rejected += 1;
                    assert_eq!(d.to_json(), before, "Rücknahme bei Verstoss");
                }
            }
        }
        assert!(rejected > 0 && committed > 900, "{committed}/{rejected}");
        let end = d.to_json();
        assert_eq!(d.history().undo_depth(), committed);
        while d.undo().is_some() {}
        assert_eq!(d.to_json(), start);
        while d.redo().is_some() {}
        assert_eq!(d.to_json(), end);
    }

    #[test]
    fn coalesce_key_ein_schritt_und_verdichtet() {
        let mut d = doc();
        let start = d.to_json();
        for i in 0..500 {
            let o = ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","x":i}}]));
            d.commit(&o, Some("drag"), i as f64, false).unwrap();
        }
        assert_eq!(d.history().undo_depth(), 1);
        // Der Schritt wächst nicht mit jeder Mausbewegung.
        assert!(d.history().bytes() < 1000, "{}", d.history().bytes());
        d.commit(&ops(json!([{"kind":"setField","key":"name","value":"Q"}])), Some("drag"), 499.0, false).unwrap();
        assert_eq!(d.history().undo_depth(), 1);
        d.undo().unwrap();
        assert_eq!(d.to_json(), start);
        // Nach Undo beginnt dieselbe Serie einen neuen Schritt.
        d.redo().unwrap();
        d.commit(&ops(json!([{"kind":"setField","key":"name","value":"R"}])), Some("drag"), 500.0, false).unwrap();
        assert_eq!(d.history().undo_depth(), 2);
    }

    #[test]
    fn nan_und_doppelte_ids_abgelehnt_ohne_schritt() {
        let mut d = doc();
        let before = d.to_json();
        let e = d.commit(&ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","x":"\u{1}NaN"}}])), None, 0.0, true).unwrap_err();
        assert_eq!(e, vec!["„walls\" a: NaN ist nicht endlich.".to_string()]);
        let e = d.commit(&ops(json!([{"kind":"add","collection":"walls","items":[{"id":"b"}]}])), None, 0.0, false).unwrap_err();
        assert_eq!(e, vec!["Doppelte ids in „walls\".".to_string()]);
        assert_eq!(d.to_json(), before);
        assert_eq!(d.history().undo_depth(), 0);
        // Tiefe Marken werden angenommen und als null gespeichert.
        d.commit(&ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","p":{"q":{"r":{"s":{"t":"\u{1}NaN"}}}}}}])), None, 0.0, true).unwrap();
        assert_eq!(d.field("walls").unwrap()[0]["p"]["q"]["r"]["s"]["t"], Value::Null);
    }

    #[test]
    fn feld_reihenfolge_bleibt_beim_undo() {
        let mut d = doc();
        let start = d.to_json();
        d.commit(&ops(json!([{"kind":"setField","key":"walls"}])), None, 0.0, false).unwrap();
        d.commit(&ops(json!([{"kind":"setField","key":"walls","value":[]}])), None, 1.0, false).unwrap();
        d.undo().unwrap();
        d.undo().unwrap();
        assert_eq!(d.to_json(), start);
    }

    #[test]
    fn speichergrenze_wirft_aelteste_schritte() {
        let mut d = doc();
        d.history_mut().max_bytes = 20_000;
        let big: Vec<Value> = (0..10).map(|i| json!({"id": format!("e{i}"), "pad": "x".repeat(100)})).collect();
        for i in 0..20 {
            d.commit(&ops(json!([{"kind":"setField","key":"blob","value":big.clone()}, {"kind":"setField","key":"i","value":i}])), None, i as f64 * 1000.0, false).unwrap();
        }
        assert!(d.history().bytes() <= 20_000 && d.history().undo_depth() < 20 && d.history().undo_depth() >= 1);
    }

    #[test]
    #[ignore = "Messung: cargo test --release -- --ignored --nocapture"]
    fn messung_grosses_projekt() {
        use std::time::Instant;
        let walls: Vec<Value> = (0..5000)
            .map(|i| json!({"id": format!("w{i}"), "start": {"x": i, "y": 0}, "end": {"x": i + 1, "y": 0}, "thickness": 0.2, "height": 2.6, "layers": [{"m":"a","t":0.1},{"m":"b","t":0.1}]}))
            .collect();
        let mut d = Document::from_json(&json!({"id":"p","walls":walls}).to_string()).unwrap();
        d.history_mut().max_steps = 10_000;
        let t = Instant::now();
        let n = 5000;
        for i in 0..n {
            let o = ops(json!([{"kind":"replace","collection":"walls","entity":{"id": format!("w{}", (i * 7) % 5000), "height": i}}]));
            d.commit(&o, None, i as f64 * 1000.0, false).unwrap();
        }
        let commit = t.elapsed();
        let t = Instant::now();
        while d.undo().is_some() {}
        let undo = t.elapsed();
        let t = Instant::now();
        while d.redo().is_some() {}
        let redo = t.elapsed();
        eprintln!(
            "5000 Wände, {n} Schritte: commit {:.1} µs/Schritt, undo {:.1} µs, redo {:.1} µs, Verlauf ≈ {} KiB",
            commit.as_secs_f64() * 1e6 / n as f64,
            undo.as_secs_f64() * 1e6 / n as f64,
            redo.as_secs_f64() * 1e6 / n as f64,
            d.history().bytes() / 1024
        );
    }
}
