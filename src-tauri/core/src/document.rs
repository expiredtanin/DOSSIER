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
    /// Nach `replace` nur dieses Element der typisierten Sicht neu lesen (Liste, Position).
    dirty_items: Vec<(String, usize)>,
    /// Änderungsstände je Feld und je Listenelement (Schlüssel der Plan-Caches).
    revs: Revs,
    /// Caches der Plan-Erzeugung (`plan::cache`), gültig über [`Revs`].
    plan_cache: crate::plan::cache::PlanCache,
    /// id → Position je Liste über die Aufrufe hinweg (eine Änderung an einem Element einer grossen
    /// Liste sucht dann nicht jedes Mal linear); jede Op ausser `replace` verwirft ihre Liste.
    pos: PosCache,
}

/// Änderungsstände ([K4], Caches der Ableitungen): ein globaler Zähler; jede Op vergibt ihrem Feld
/// einen neuen Stand, `add`/`replace` den betroffenen Listenelementen neue Element-Stände. Gleicher
/// Stand = unverändert. Laden beginnt eine neue Epoche (alle Stände ungültig).
#[derive(Clone, Debug, Default)]
pub struct Revs {
    counter: u64,
    epoch: u64,
    field: HashMap<String, u64>,
    /// Element-Stände je Liste (gleich lang und gleich geordnet wie die Liste), erst auf Anfrage.
    items: HashMap<String, Vec<u64>>,
}

impl Revs {
    fn next(&mut self) -> u64 {
        self.counter += 1;
        self.counter
    }

    fn reset(&mut self) {
        self.epoch = self.next();
        self.field.clear();
        self.items.clear();
    }

    fn touch(&mut self, key: &str) {
        let r = self.next();
        self.field.insert(key.to_owned(), r);
    }

    /// Epoche (wechselt beim Laden).
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Stand eines Feldes (0 = seit dem Laden unverändert).
    pub fn field(&self, key: &str) -> u64 {
        self.field.get(key).copied().unwrap_or(0)
    }

    /// Jüngster Stand aller Felder ausser `except` (ändert sich, sobald eines davon geändert wird).
    pub fn max_except(&self, except: &[&str]) -> u64 {
        self.field.iter().filter(|(k, _)| !except.contains(&k.as_str())).map(|(_, v)| *v).max().unwrap_or(0)
    }

    /// Element-Stände der Liste `key`, falls schon vergeben (s. [`Revs::items`]).
    pub fn item_stamps(&self, key: &str) -> Option<&[u64]> {
        self.items.get(key).map(Vec::as_slice)
    }

    /// Element-Stände der Liste `key` (Länge `n`); fehlen sie oder passen sie nicht, neu vergeben.
    pub fn items(&mut self, key: &str, n: usize) -> &[u64] {
        if self.items.get(key).is_none_or(|v| v.len() != n) {
            let start = self.counter;
            self.counter += n as u64;
            self.items.insert(key.to_owned(), (start + 1..=start + n as u64).collect());
        }
        &self.items[key]
    }

    /// Element-Stände nach einer Op auf der Liste nachführen (`before` = Länge vor der Op).
    fn item_op(&mut self, op: &Op, before: usize, removed: Option<&[bool]>, hit: Option<usize>) {
        let key = op.key();
        self.touch(key);
        let Some(mut v) = self.items.remove(key) else { return };
        if v.len() != before {
            return;
        }
        match op {
            Op::Add { items, at, .. } => {
                let at = at.map_or(v.len(), |a| a.min(v.len()));
                let start = self.counter;
                self.counter += items.len() as u64;
                v.splice(at..at, start + 1..=start + items.len() as u64);
            }
            Op::Replace { .. } => match hit {
                Some(i) if i < v.len() => v[i] = self.next(),
                Some(_) => return,
                None => v.push(self.next()),
            },
            Op::Remove { .. } => match removed {
                Some(keep) if keep.len() == v.len() => {
                    let mut k = keep.iter();
                    v.retain(|_| *k.next().unwrap_or(&false));
                }
                _ => return,
            },
            Op::Reorder { .. } | Op::SetField { .. } => return,
        }
        self.items.insert(key.to_owned(), v);
    }
}

/// id → Position je Liste für die Dauer einer Op-Folge. Nur `replace` sucht darüber; jede andere Op
/// auf der Liste verwirft den Eintrag. Erst die zweite Suche in derselben Liste baut den Index —
/// ein einzelner Drag-Schritt bleibt bei der linearen Suche, Serien (Auswahl verschieben: hunderte
/// `replace`) kosten so O(Liste + Ops) statt O(Liste · Ops). Gleiche Semantik wie `position`
/// (erstes Vorkommen). Schlüssel ist ein Hash der id (keine Text-Kopien); jeder Treffer wird an der
/// Liste nachgeprüft, bei einer Kollision sucht `find` linear.
#[derive(Clone, Debug, Default)]
struct PosCache(HashMap<String, PosEntry>);

#[derive(Clone, Debug)]
enum PosEntry {
    /// Einmal linear gesucht.
    Once,
    Built(HashMap<u64, usize>),
}

/// FNV-1a über die id.
fn id_hash(id: &str) -> u64 {
    id.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3))
}

impl PosCache {
    fn find(&mut self, collection: &str, list: &[Value], id: Option<&str>) -> Option<usize> {
        let linear = |id: Option<&str>| list.iter().position(|e| id_of(e) == id);
        let Some(id) = id else {
            return linear(None);
        };
        match self.0.get(collection) {
            Some(PosEntry::Built(m)) => match m.get(&id_hash(id)) {
                Some(&i) if list.get(i).and_then(id_of) == Some(id) => Some(i),
                Some(_) => linear(Some(id)),
                None => None,
            },
            Some(PosEntry::Once) => {
                let mut m: HashMap<u64, usize> = HashMap::with_capacity(list.len());
                for (i, e) in list.iter().enumerate() {
                    if let Some(x) = id_of(e) {
                        m.entry(id_hash(x)).or_insert(i);
                    }
                }
                self.0.insert(collection.to_owned(), PosEntry::Built(m));
                self.find(collection, list, Some(id))
            }
            None => {
                self.0.insert(collection.to_owned(), PosEntry::Once);
                linear(Some(id))
            }
        }
    }

    /// Element `id` wurde an Position `at` angehängt (`replace` ohne Treffer).
    fn pushed(&mut self, collection: &str, id: Option<&str>, at: usize) {
        if let (Some(PosEntry::Built(m)), Some(id)) = (self.0.get_mut(collection), id) {
            m.entry(id_hash(id)).or_insert(at);
        }
    }

    fn forget(&mut self, collection: &str) {
        self.0.remove(collection);
    }
}

impl Document {
    pub fn from_json(text: &str) -> Result<Document, String> {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(root)) => Ok(Document { root, ..Default::default() }),
            Ok(_) => Err("Projekt ist kein JSON-Objekt".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Projekt laden ([K4] S4: Öffnen, Neu, Vorlage, Wiederherstellen): ersetzt den ganzen Inhalt und
    /// leert den Verlauf (Rückgängig führt nicht ins vorherige Projekt).
    pub fn load(&mut self, root: Map<String, Value>) {
        self.root = root;
        self.typed = None;
        self.dirty.clear();
        self.dirty_items.clear();
        self.revs.reset();
        self.pos = PosCache::default();
        self.history.clear();
    }

    /// Projektdatei (Text) einlesen, migrieren, prüfen (`project_format`) und laden wie [`Document::load`].
    /// Ergebnis: Hinweise und Ausgangsversion einer Migration; bei Fehler bleibt das Dokument unverändert.
    pub fn load_file(&mut self, text: &str, now_ms: f64) -> Result<(Vec<String>, Option<u64>), String> {
        match crate::project_format::parse_project_file(text, now_ms) {
            crate::project_format::Parsed::Ok { project, warnings, migrated_from } => {
                self.load(project);
                Ok((warnings, migrated_from))
            }
            crate::project_format::Parsed::Err(e) => Err(e),
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
            self.dirty_items.clear();
        } else if !self.dirty.is_empty() || !self.dirty_items.is_empty() {
            let mut dirty: Vec<String> = self.dirty.drain().collect();
            let mut failed = None;
            if let Some(t) = self.typed.as_mut() {
                // Einzelne Elemente (nach `replace`), ausser ihre Liste wird ohnehin ganz gelesen;
                // geht es nicht (Liste ohne Element-Weg, Element passt nicht), die ganze Liste.
                for (key, i) in std::mem::take(&mut self.dirty_items) {
                    if dirty.contains(&key) {
                        continue;
                    }
                    let v = self.root.get(&key).and_then(|l| l.get(i));
                    if !v.is_some_and(|v| t.set_item(&key, i, v) == Ok(true)) {
                        dirty.push(key);
                    }
                }
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

    /// Die Projekt-Wurzel als JSON (für Abfragen, die auf dem rohen Baum rechnen, s. `queries::run_root`).
    pub fn root(&self) -> &Map<String, Value> {
        &self.root
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


    /// Wendet eine Op ohne Aufzeichnung an (Semantik wie `applyOps` in TS). Liefert bei `replace`
    /// mit Treffer dessen Position; führt die Änderungsstände nach.
    fn apply_raw(&mut self, op: &Op, pos: &mut PosCache) -> Option<usize> {
        if !matches!(op, Op::Replace { .. }) {
            pos.forget(op.key());
        }
        let before = self.root.get(op.key()).and_then(Value::as_array).map_or(0, Vec::len);
        let mut hit = None;
        let mut removed = None;
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
                match pos.find(collection, list, id) {
                    Some(i) => {
                        list[i] = entity.clone();
                        hit = Some(i);
                    }
                    None => {
                        list.push(entity.clone());
                        pos.pushed(collection, id, list.len() - 1);
                    }
                }
            }
            Op::Remove { collection, ids } => {
                let drop: HashSet<&str> = ids.iter().map(String::as_str).collect();
                let tracked = self.revs.items.contains_key(collection.as_str());
                let list = self.list_mut(collection);
                if tracked {
                    removed = Some(list.iter().map(|e| !id_of(e).is_some_and(|i| drop.contains(i))).collect::<Vec<bool>>());
                }
                list.retain(|e| !id_of(e).is_some_and(|i| drop.contains(i)));
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
        self.revs.item_op(op, before, removed.as_deref(), hit);
        hit
    }

    /// Nach einer angenommenen Op: was die typisierte Sicht neu lesen muss (ein Element nach
    /// `replace` mit Treffer, sonst das Feld).
    fn mark_dirty(&mut self, op: &Op, hit: Option<usize>) {
        match (op, hit) {
            (Op::Replace { collection, .. }, Some(i)) if self.typed.is_some() => self.dirty_items.push((collection.clone(), i)),
            _ => {
                self.dirty.insert(op.key().to_owned());
            }
        }
    }

    /// Wendet eine Op an und liefert (inverse Ops in Anwendungsreihenfolge, ob die Vorwärts-Op als
    /// `add` aufzuzeichnen ist — `replace` ohne Treffer). Listen bekommen feine Inverse (`replace` ↔ altes Element, `add` ↔ `remove`,
    /// `remove` ↔ `add` an den alten Positionen, `reorder` ↔ alte Reihenfolge), wo das exakt ist
    /// (`add`: ids neu und eindeutig; `reorder`: alle ids eindeutig); sonst (fehlendes Feld, kein
    /// Array, Alt-Doppelungen) wird das ganze Feld samt Position gesichert. Ohne Hash über die ganze
    /// Liste — ein Drag-Schritt kostet nur das Suchen des Elements.
    fn apply_recorded(&mut self, op: &Op, pos: &mut PosCache) -> (Vec<Op>, bool, Option<usize>) {
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
        let mut as_add = false;
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
            (Op::Replace { collection, entity }, Some(list)) => match pos.find(collection, list, id_of(entity)) {
                Some(i) => {
                    // Direkt ersetzen (spart die zweite Suche in `apply_raw`).
                    let list = self.root.get_mut(key).and_then(Value::as_array_mut).expect("Liste geprüft");
                    let n = list.len();
                    let prev = std::mem::replace(&mut list[i], entity.clone());
                    self.revs.item_op(op, n, None, Some(i));
                    return (vec![Op::Replace { collection: collection.clone(), entity: prev }], false, Some(i));
                }
                None => {
                    // Aufgezeichnet als `add` (so trifft jedes aufgezeichnete `replace` ein vorhandenes Element).
                    as_add = true;
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
        let hit = self.apply_raw(op, pos);
        (inverse, as_add, hit)
    }

    /// Wendet `ops` atomar an und prüft sie (`ops::validate`). Verstösse → `Err(Meldungen)`,
    /// Dokument unverändert. Ok → (je Op: als `add` aufzuzeichnen, inverse Ops). `sanitize`: die Ops
    /// können Nicht-endlich-Marken enthalten (s. `ops.rs`).
    fn apply_checked(&mut self, ops: &[Op], sanitize: bool) -> Result<(Vec<bool>, Vec<Op>), Vec<String>> {
        // Alt-Doppelungen der Listen merken, in die eingefügt oder die gesetzt wird.
        let mut had_dup: HashSet<String> = HashSet::new();
        for op in ops {
            if matches!(op, Op::Add { .. } | Op::SetField { .. }) && !had_dup.contains(op.key()) && has_dup(self.root.get(op.key())) {
                had_dup.insert(op.key().to_owned());
            }
        }
        let mut inverses: Vec<Vec<Op>> = Vec::with_capacity(ops.len());
        let mut as_add: Vec<bool> = Vec::with_capacity(ops.len());
        let mut hits: Vec<Option<usize>> = Vec::with_capacity(ops.len());
        let mut pos = std::mem::take(&mut self.pos);
        for op in ops {
            let (inv, add, hit) = self.apply_recorded(op, &mut pos);
            inverses.push(inv);
            as_add.push(add);
            hits.push(hit);
        }
        let problems = crate::ops::validate(&self.root, ops, &|k| had_dup.contains(k));
        if !problems.is_empty() {
            // Nach der Rücknahme gilt keine gemerkte Position mehr sicher.
            let mut pos = PosCache::default();
            for inv in inverses.iter().rev() {
                for op in inv {
                    self.apply_raw(op, &mut pos);
                }
            }
            return Err(problems);
        }
        self.pos = pos;
        if sanitize {
            // Angenommene Nicht-endlich-Marken (zu tief für die Prüfung) als null speichern.
            let keys: HashSet<&str> = ops.iter().map(Op::key).collect();
            for k in keys {
                if let Some(v) = self.root.get_mut(k) {
                    crate::ops::sanitize_non_finite(v);
                }
            }
        }
        for (op, hit) in ops.iter().zip(hits) {
            self.mark_dirty(op, hit);
        }
        Ok((as_add, inverses.into_iter().rev().flatten().collect()))
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
    /// `coalesceKey`, `now` = Zeit in ms für das Koaleszenz-Fenster). Die Ops gehen in den Verlauf
    /// über (Redo) — das Dokument hält eigene Kopien, so wird jedes Element nur einmal kopiert.
    pub fn commit(&mut self, ops: Vec<Op>, key: Option<&str>, now: f64, sanitize: bool) -> Result<(), Vec<String>> {
        let (as_add, inverse) = self.apply_checked(&ops, sanitize)?;
        // Normalisiert: `replace` ohne Treffer wird als `add` aufgezeichnet (so trifft jedes
        // aufgezeichnete `replace` ein vorhandenes Element, s. `ops::compact`).
        let mut forward: Vec<Op> = ops
            .into_iter()
            .zip(as_add)
            .map(|(op, add)| match op {
                Op::Replace { collection, entity } if add => Op::Add { collection, items: vec![entity], at: None },
                op => op,
            })
            .collect();
        if sanitize {
            // Angenommene Nicht-endlich-Marken auch im Verlauf als null.
            crate::ops::sanitize_ops(&mut forward);
        }
        self.history.record(forward, inverse, key, now);
        Ok(())
    }

    fn apply_unchecked(&mut self, ops: &[Op]) {
        let mut pos = std::mem::take(&mut self.pos);
        for op in ops {
            let hit = self.apply_raw(op, &mut pos);
            self.mark_dirty(op, hit);
        }
        self.pos = pos;
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

    /// Änderungsstände (Schlüssel der Caches der Ableitungen).
    pub fn revs(&self) -> &Revs {
        &self.revs
    }

    /// Typisierte Sicht samt Änderungsständen (Element-Stände der 2D-Zeichnungen vergeben) und
    /// Plan-Cache — getrennte Ausleihen für die gecachte Plan-Erzeugung (`plan::cache`).
    pub fn project_cached(&mut self) -> Result<(&Project, &Revs, &mut crate::plan::cache::PlanCache), String> {
        self.project()?;
        let p = self.typed.as_ref().expect("gerade gelesen");
        self.revs.items("drawings2d", p.drawings2d.len());
        Ok((p, &self.revs, &mut self.plan_cache))
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
    fn laden_ersetzt_inhalt_und_leert_verlauf() {
        let mut d = doc();
        d.commit(ops(json!([{"kind":"setField","key":"name","value":"M"}])), None, 0.0, false).unwrap();
        assert_eq!(d.history().undo_depth(), 1);
        let n = d.field("walls").unwrap().as_array().unwrap().len();
        assert_eq!(n, 2);
        // Kaputte Datei: Fehler, Dokument und Verlauf unverändert.
        assert!(d.load_file(r#"{"walls":[]}"#, 0.0).is_err());
        assert_eq!(d.history().undo_depth(), 1);
        // Alte Datei (Version 1 mit Türen): migriert geladen, Verlauf leer, typisierte Sicht neu.
        let (warnings, from) = d
            .load_file(r#"{"formatVersion":1,"id":"q","name":"Q","walls":[],"layers":[],"drawingLevels":[],"doors":[{"id":"D"}]}"#, 0.0)
            .unwrap();
        assert!(warnings.is_empty());
        assert_eq!(from, Some(1));
        assert_eq!(d.history().undo_depth(), 0);
        assert_eq!(d.project().unwrap().walls.len(), 0);
        assert_eq!(d.field("openings").unwrap()[0]["kind"], "door");
        assert!(d.undo().is_none());
        assert!(d.serialize().starts_with("{\n  \"formatVersion\": 2,\n  \"id\": \"q\""));
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
            match d.commit(ops, None, n as f64 * 1000.0, true) {
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
    fn replace_serien_wie_einzeln() {
        // Serien in einem Aufruf (Positions-Index) = dieselben Ops einzeln (lineare Suche), auch mit
        // fehlenden ids, Alt-Doppelungen und Struktur-Ops dazwischen; Undo stellt exakt zurück.
        let start = r#"{"walls":[{"id":"a"},{"id":"b"},{"id":"a","alt":1},{"id":"c"}],"rooms":[{"id":"r"}]}"#;
        let mut r = Rng(3);
        for round in 0..200 {
            let mut list = Vec::new();
            for k in 0..(2 + r.below(30)) {
                let id = ["a", "b", "c", "d", "e"][r.below(5)];
                let c = if r.next() < 0.8 { "walls" } else { "rooms" };
                let p = r.next();
                list.push(if p < 0.7 {
                    json!({"kind":"replace","collection":c,"entity":{"id":id,"v":k}})
                } else if p < 0.8 {
                    json!({"kind":"remove","collection":c,"ids":[id]})
                } else if p < 0.9 {
                    json!({"kind":"add","collection":c,"items":[{"id":format!("n{round}-{k}")}],"at":r.below(4)})
                } else {
                    json!({"kind":"reorder","collection":c,"ids":[id]})
                });
            }
            let o = ops(Value::Array(list));
            let mut batch = Document::from_json(start).unwrap();
            batch.commit(o.clone(), None, 0.0, false).unwrap();
            let mut single = Document::from_json(start).unwrap();
            for op in &o {
                single.apply(std::slice::from_ref(op)).unwrap();
            }
            assert_eq!(batch.to_json(), single.to_json(), "Runde {round}");
            batch.undo().unwrap();
            assert_eq!(batch.to_json(), Document::from_json(start).unwrap().to_json());
            batch.redo().unwrap();
            assert_eq!(batch.to_json(), single.to_json());
        }
    }

    #[test]
    fn coalesce_key_ein_schritt_und_verdichtet() {
        let mut d = doc();
        let start = d.to_json();
        for i in 0..500 {
            let o = ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","x":i}}]));
            d.commit(o.clone(), Some("drag"), i as f64, false).unwrap();
        }
        assert_eq!(d.history().undo_depth(), 1);
        // Der Schritt wächst nicht mit jeder Mausbewegung.
        assert!(d.history().bytes() < 1000, "{}", d.history().bytes());
        d.commit(ops(json!([{"kind":"setField","key":"name","value":"Q"}])), Some("drag"), 499.0, false).unwrap();
        assert_eq!(d.history().undo_depth(), 1);
        d.undo().unwrap();
        assert_eq!(d.to_json(), start);
        // Nach Undo beginnt dieselbe Serie einen neuen Schritt.
        d.redo().unwrap();
        d.commit(ops(json!([{"kind":"setField","key":"name","value":"R"}])), Some("drag"), 500.0, false).unwrap();
        assert_eq!(d.history().undo_depth(), 2);
    }

    #[test]
    fn gruppen_mit_schluessel_verschmelzen() {
        let mut d = doc();
        let start = d.to_json();
        // Griff-Zug: je Mausschritt eine Gruppe (Element + mitgeführter Nachbar), gleicher Schlüssel.
        for i in 0..20 {
            d.history_mut().begin_group_keyed(Some("zug"), i as f64 * 20.0);
            d.commit(ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","x":i}}])), Some("grip:a"), i as f64 * 20.0, false).unwrap();
            d.commit(ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"b","x":i}}])), Some("grip:b"), i as f64 * 20.0, false).unwrap();
            d.history_mut().end_group();
        }
        assert_eq!(d.history().undo_depth(), 1);
        // Andere Gruppe bzw. Pause über das Zeitfenster: neuer Schritt.
        d.history_mut().begin_group_keyed(Some("zug"), 5000.0);
        d.commit(ops(json!([{"kind":"setField","key":"name","value":"Z"}])), None, 5000.0, false).unwrap();
        d.history_mut().end_group();
        assert_eq!(d.history().undo_depth(), 2);
        // Leere Gruppe ändert nichts am Anschluss.
        d.history_mut().begin_group_keyed(Some("anders"), 5010.0);
        d.history_mut().end_group();
        d.history_mut().begin_group_keyed(Some("zug"), 5020.0);
        d.commit(ops(json!([{"kind":"setField","key":"name","value":"Y"}])), None, 5020.0, false).unwrap();
        d.history_mut().end_group();
        assert_eq!(d.history().undo_depth(), 2);
        // Ohne Schlüssel: jede Gruppe ein Schritt.
        for i in 0..3 {
            d.history_mut().begin_group();
            d.commit(ops(json!([{"kind":"setField","key":"name","value":format!("g{i}")}])), Some("k"), 6000.0, false).unwrap();
            d.history_mut().end_group();
        }
        assert_eq!(d.history().undo_depth(), 5);
        while d.undo().is_some() {}
        assert_eq!(d.to_json(), start);
        // Nach Undo verschmilzt eine gleichnamige Gruppe nicht mit dem Redo-Rest.
        d.redo().unwrap();
        d.history_mut().begin_group_keyed(Some("zug"), 6001.0);
        d.commit(ops(json!([{"kind":"setField","key":"name","value":"W"}])), None, 6001.0, false).unwrap();
        d.history_mut().end_group();
        assert_eq!(d.history().undo_depth(), 2);
    }

    #[test]
    fn nan_und_doppelte_ids_abgelehnt_ohne_schritt() {
        let mut d = doc();
        let before = d.to_json();
        let e = d.commit(ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","x":"\u{1}NaN"}}])), None, 0.0, true).unwrap_err();
        assert_eq!(e, vec!["„walls\" a: NaN ist nicht endlich.".to_string()]);
        let e = d.commit(ops(json!([{"kind":"add","collection":"walls","items":[{"id":"b"}]}])), None, 0.0, false).unwrap_err();
        assert_eq!(e, vec!["Doppelte ids in „walls\".".to_string()]);
        assert_eq!(d.to_json(), before);
        assert_eq!(d.history().undo_depth(), 0);
        // Tiefe Marken werden angenommen und als null gespeichert.
        d.commit(ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","p":{"q":{"r":{"s":{"t":"\u{1}NaN"}}}}}}])), None, 0.0, true).unwrap();
        assert_eq!(d.field("walls").unwrap()[0]["p"]["q"]["r"]["s"]["t"], Value::Null);
    }

    #[test]
    fn feld_reihenfolge_bleibt_beim_undo() {
        let mut d = doc();
        let start = d.to_json();
        d.commit(ops(json!([{"kind":"setField","key":"walls"}])), None, 0.0, false).unwrap();
        d.commit(ops(json!([{"kind":"setField","key":"walls","value":[]}])), None, 1.0, false).unwrap();
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
            d.commit(ops(json!([{"kind":"setField","key":"blob","value":big.clone()}, {"kind":"setField","key":"i","value":i}])), None, i as f64 * 1000.0, false).unwrap();
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
            d.commit(o.clone(), None, i as f64 * 1000.0, false).unwrap();
        }
        let commit = t.elapsed();
        // Auswahl verschieben: 300 `replace` in einer Op-Folge.
        let sel: Vec<Value> = (0..300).map(|k| json!({"kind":"replace","collection":"walls","entity":{"id": format!("w{}", k * 16), "height": 1}})).collect();
        let sel = ops(Value::Array(sel));
        let t = Instant::now();
        for i in 0..20 {
            d.commit(sel.clone(), None, (n + i) as f64 * 1000.0, false).unwrap();
        }
        eprintln!("Auswahl 300 Wände verschieben: commit {:.1} µs/Schritt", t.elapsed().as_secs_f64() * 1e6 / 20.0);
        for _ in 0..20 {
            d.undo().unwrap();
        }
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
