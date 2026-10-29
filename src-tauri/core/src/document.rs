//! Projekt-Dokument ([K4], Stufen S1/S3): Rust hält das Projekt als JSON-Baum, wendet Op-Folgen
//! (`ops.rs`) atomar an, prüft sie (NaN, neue doppelte ids → Rücknahme mit Meldungen) und führt den
//! Undo/Redo-Verlauf als inverse Ops. Die Ableitungen (Kennzahlen, 3D, Export …) lesen die
//! typisierte Sicht [`Document::project`].
//!
//! TS hält eine Leseansicht des Projekts und wendet genau die Ops an, die der Kern angenommen
//! (`commit`) oder für Undo/Redo geliefert hat (`core/document.ts`).

use crate::model::Project;
pub use crate::ops::Op;
use crate::ops::{has_dup, id_of, unique_ids, History, Step};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::cell::RefCell;
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
    /// id → Position je Liste über die Aufrufe hinweg (s. [`PosCache`]); in einer `RefCell`, damit auch
    /// lesende Abfragen ([`Lookup`]) den Index bauen und nutzen.
    pos: RefCell<PosCache>,
    /// Je Op der zuletzt angewendeten Folge (Commit, Abgleich, Undo/Redo) die Position des von `replace`
    /// getroffenen Elements: TS führt die Leseansicht damit ohne Suche nach ([`Document::last_hits`]).
    last_hits: Vec<Option<usize>>,
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
        // Epoche über alle Dokumente eindeutig: Caches ausserhalb eines Dokuments (Fang, `snap_model.rs`)
        // erkennen so auch ein neu geöffnetes Dokument unter derselben Nummer.
        static EPOCHS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        self.next();
        self.epoch = EPOCHS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
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

    /// Element-Stände nach einer Op auf der Liste `key` nachführen (`before` = Länge vor der Op).
    fn item_op(&mut self, key: &str, shape: Shape, before: usize, removed: Option<&[bool]>, hit: Option<usize>) {
        self.touch(key);
        let Some(mut v) = self.items.remove(key) else { return };
        if v.len() != before {
            return;
        }
        match shape {
            Shape::Add { n, at } => {
                let at = at.map_or(v.len(), |a| a.min(v.len()));
                let start = self.counter;
                self.counter += n as u64;
                v.splice(at..at, start + 1..=start + n as u64);
            }
            Shape::Replace => match hit {
                Some(i) if i < v.len() => v[i] = self.next(),
                Some(_) => return,
                None => v.push(self.next()),
            },
            Shape::Remove => match removed {
                Some(keep) if keep.len() == v.len() => {
                    let mut k = keep.iter();
                    v.retain(|_| *k.next().unwrap_or(&false));
                }
                _ => return,
            },
            Shape::Other => return,
        }
        self.items.insert(key.to_owned(), v);
    }
}

/// Art einer Op für die Element-Stände (die Op selbst ist beim Nachführen schon ins Dokument übergegangen).
#[derive(Clone, Copy)]
enum Shape {
    Add { n: usize, at: Option<usize> },
    Replace,
    Remove,
    Other,
}

impl Shape {
    fn of(op: &Op) -> Shape {
        match op {
            Op::Add { items, at, .. } => Shape::Add { n: items.len(), at: *at },
            Op::Replace { .. } => Shape::Replace,
            Op::Remove { .. } => Shape::Remove,
            Op::Reorder { .. } | Op::SetField { .. } => Shape::Other,
        }
    }
}

/// id → Position je Liste, über die Aufrufe hinweg im Dokument gehalten: `replace` (Commit, Undo/Redo)
/// und die Abfragen, die ein Element per id suchen (Griffe, Objekt-Info, s. [`Lookup`]), finden es ab
/// der ersten Suche über den Index statt linear (eine Änderung an einem Element einer grossen Liste
/// kostete je Mausschritt eine lineare Suche im Kern und eine in TS). `add` am Ende führt den Index
/// nach, jede andere Struktur-Op (`add` mitten hinein, `remove`, `reorder`, `setField`) verwirft ihn.
/// Kleine Listen bleiben linear. Gleiche Semantik wie `position` (erstes Vorkommen). Schlüssel ist ein
/// Hash der id (keine Text-Kopien); jeder Treffer wird an der Liste nachgeprüft, bei einer Kollision
/// sucht `find` linear.
#[derive(Clone, Debug, Default)]
pub struct PosCache(HashMap<String, IdIndex>);

/// Index id-Hash → Position einer Liste.
type IdIndex = HashMap<u64, usize, std::hash::BuildHasherDefault<IdHasher>>;

/// Ab dieser Länge baut `find` einen Index (darunter ist die lineare Suche billiger).
const INDEX_MIN_LEN: usize = 32;

/// Reicht den schon gestreuten id-Hash ([`id_hash`]) durch (kein zweites Hashen).
#[derive(Default)]
struct IdHasher(u64);

impl std::hash::Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 ^ *b as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = n;
    }
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
        if list.len() < INDEX_MIN_LEN {
            return linear(Some(id));
        }
        let m = self.0.entry(collection.to_owned()).or_insert_with(|| {
            let mut m = IdIndex::with_capacity_and_hasher(list.len(), Default::default());
            for (i, e) in list.iter().enumerate() {
                if let Some(x) = id_of(e) {
                    m.entry(id_hash(x)).or_insert(i);
                }
            }
            m
        });
        match m.get(&id_hash(id)) {
            Some(&i) if list.get(i).and_then(id_of) == Some(id) => Some(i),
            Some(_) => linear(Some(id)),
            None => None,
        }
    }

    /// Element `id` wurde an Position `at` angehängt (`replace` ohne Treffer, `add` am Ende).
    fn pushed(&mut self, collection: &str, id: Option<&str>, at: usize) {
        if let (Some(m), Some(id)) = (self.0.get_mut(collection), id) {
            m.entry(id_hash(id)).or_insert(at);
        }
    }

    fn forget(&mut self, collection: &str) {
        self.0.remove(collection);
    }
}

/// Elemente der Projekt-Wurzel per id finden: im Dokument über dessen Positions-Index ([`PosCache`]),
/// sonst (Tests, Wurzel ohne Dokument) linear. Für Abfragen auf der rohen Wurzel (Griffe, Objekt-Info).
pub struct Lookup<'a> {
    pub root: &'a Map<String, Value>,
    pos: Option<&'a RefCell<PosCache>>,
}

impl<'a> Lookup<'a> {
    /// Ohne Index (lineare Suche).
    pub fn plain(root: &'a Map<String, Value>) -> Self {
        Lookup { root, pos: None }
    }

    /// Erstes Element mit `id` in der Liste `collection`.
    pub fn find(&self, collection: &str, id: &str) -> Option<&'a Value> {
        let list = self.root.get(collection).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        match self.pos {
            Some(pos) => pos.borrow_mut().find(collection, list, Some(id)).map(|i| &list[i]),
            None => list.iter().find(|e| id_of(e) == Some(id)),
        }
    }
}

impl Document {
    pub fn from_json(text: &str) -> Result<Document, String> {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(root)) => {
                let mut d = Document { root, ..Default::default() };
                d.revs.reset();
                Ok(d)
            }
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
        self.pos = RefCell::default();
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
    /// Werte, die dem Modell widersprechen, fallen auf die Vorgabe zurück (`model::lenient`) — das
    /// `Result` bleibt für die Aufrufer, ist aber stets `Ok`.
    pub fn project(&mut self) -> Result<&Project, String> {
        if self.typed.is_none() {
            // Die Map wird nur ausgeliehen: `Value::Object` braucht Besitz, daher temporär herausnehmen.
            let value = Value::Object(std::mem::take(&mut self.root));
            let parsed = Project::deserialize(&value);
            if let Value::Object(m) = value {
                self.root = m;
            }
            // Passt ein Wert nicht zum Modell (Datei/Import: `null` statt Zahl, falscher Typ), fällt nur
            // er auf die Vorgabe zurück statt das ganze Projekt (`model::lenient`).
            self.typed = Some(parsed.unwrap_or_else(|_| crate::model::lenient::project_lenient(&self.root).0));
            self.dirty.clear();
            self.dirty_items.clear();
        } else if !self.dirty.is_empty() || !self.dirty_items.is_empty() {
            let mut dirty: Vec<String> = self.dirty.drain().collect();
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
                    crate::model::lenient::set_field_lenient(t, key, self.root.get(key).filter(|v| !v.is_null()));
                }
            }
        }
        Ok(self.typed.as_ref().expect("gerade gesetzt"))
    }

    /// Die Projekt-Wurzel als JSON (für Abfragen, die auf dem rohen Baum rechnen, s. `queries::run_root`).
    pub fn root(&self) -> &Map<String, Value> {
        &self.root
    }

    /// Je Op der zuletzt angewendeten Folge die Position des von `replace` getroffenen Elements (None =
    /// keine `replace`-Op oder kein Treffer); nach einer Zurückweisung leer.
    pub fn last_hits(&self) -> &[Option<usize>] {
        &self.last_hits
    }

    /// Die Wurzel mit dem Positions-Index des Dokuments (Suche per id, s. [`Lookup`]).
    pub fn lookup(&self) -> Lookup<'_> {
        Lookup { root: &self.root, pos: Some(&self.pos) }
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


    /// Wendet eine Op ohne Aufzeichnung an (Semantik wie `applyOps` in TS); die Op geht ins Dokument
    /// über (keine Kopie). Liefert bei `replace` mit Treffer dessen Position; führt die Änderungsstände
    /// nach.
    fn apply_raw(&mut self, op: Op, pos: &mut PosCache) -> Option<usize> {
        let key = op.key().to_owned();
        let shape = Shape::of(&op);
        // `add` am Ende einer vorhandenen Liste lässt die Positionen stehen (Index wird nachgeführt).
        let current = self.root.get(&key).and_then(Value::as_array).map(Vec::len);
        let appended = matches!(op, Op::Add { at, .. } if current.is_some_and(|n| at.is_none_or(|a| a >= n)));
        if !matches!(op, Op::Replace { .. }) && !appended {
            pos.forget(&key);
        }
        let before = current.unwrap_or(0);
        let mut hit = None;
        let mut removed = None;
        match op {
            Op::SetField { key, value, at } => match value {
                Some(v) => match at {
                    Some(i) if !self.root.contains_key(&key) => {
                        let i = i.min(self.root.len());
                        self.root.shift_insert(i, key, v);
                    }
                    _ => {
                        self.root.insert(key, v);
                    }
                },
                None => {
                    self.root.shift_remove(&key);
                }
            },
            Op::Add { collection, items, at } => {
                let list = self.list_mut(&collection);
                let at = at.map_or(list.len(), |a| a.min(list.len()));
                if appended {
                    for (k, e) in items.iter().enumerate() {
                        pos.pushed(&collection, id_of(e), at + k);
                    }
                }
                list.splice(at..at, items);
            }
            Op::Replace { collection, entity } => {
                let list = self.list_mut(&collection);
                match pos.find(&collection, list, id_of(&entity)) {
                    Some(i) => {
                        list[i] = entity;
                        hit = Some(i);
                    }
                    None => {
                        pos.pushed(&collection, id_of(&entity), list.len());
                        list.push(entity);
                    }
                }
            }
            Op::Remove { collection, ids } => {
                let drop: HashSet<&str> = ids.iter().map(String::as_str).collect();
                let tracked = self.revs.items.contains_key(collection.as_str());
                let list = self.list_mut(&collection);
                if tracked {
                    removed = Some(list.iter().map(|e| !id_of(e).is_some_and(|i| drop.contains(i))).collect::<Vec<bool>>());
                }
                list.retain(|e| !id_of(e).is_some_and(|i| drop.contains(i)));
            }
            Op::Reorder { collection, ids } => {
                let list = std::mem::take(self.list_mut(&collection));
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
                *self.list_mut(&collection) = ordered;
            }
        }
        self.revs.item_op(&key, shape, before, removed.as_deref(), hit);
        hit
    }

    /// Nach einer angenommenen Op: was die typisierte Sicht neu lesen muss (ein Element nach
    /// `replace` mit Treffer, sonst das Feld).
    fn mark_dirty(&mut self, key: String, replace: bool, hit: Option<usize>) {
        match hit {
            Some(i) if replace && self.typed.is_some() => self.dirty_items.push((key, i)),
            _ => {
                self.dirty.insert(key);
            }
        }
    }

    /// Wendet eine Op an und liefert (inverse Ops in Anwendungsreihenfolge, Treffer-Position bei
    /// `replace`). Listen bekommen feine Inverse (`replace` ↔ altes Element, `add` ↔ `remove`,
    /// `remove` ↔ `add` an den alten Positionen, `reorder` ↔ alte Reihenfolge), wo das exakt ist
    /// (`add`: ids neu und eindeutig; `reorder`: alle ids eindeutig); sonst (fehlendes Feld, kein
    /// Array, Alt-Doppelungen) wird das ganze Feld samt Position gesichert. Ohne Hash über die ganze
    /// Liste — ein Drag-Schritt kostet nur das Suchen des Elements; das neue Element geht ohne Kopie
    /// ins Dokument, das alte in die inverse Op.
    fn apply_recorded(&mut self, op: Op, pos: &mut PosCache) -> (Vec<Op>, Option<usize>) {
        if matches!(op, Op::Remove { .. }) && self.root.get(op.key()).is_some_and(Value::is_array) {
            return (self.remove_moving(op, pos), None);
        }
        let key = op.key();
        let old = self.root.get(key);
        let snapshot = || {
            let at = self.root.keys().position(|k| k == key);
            Op::SetField { key: key.to_owned(), value: old.cloned(), at }
        };
        let clean = match &op {
            Op::SetField { .. } => None,
            Op::Reorder { .. } => old.and_then(Value::as_array).filter(|a| a.iter().all(|e| id_of(e).is_some()) && unique_ids(a)),
            _ => old.and_then(Value::as_array),
        };
        let inverse = match (&op, clean) {
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
                    let n = list.len();
                    let Op::Replace { collection, entity } = op else { unreachable!() };
                    let list = self.root.get_mut(&collection).and_then(Value::as_array_mut).expect("Liste geprüft");
                    let prev = std::mem::replace(&mut list[i], entity);
                    self.revs.item_op(&collection, Shape::Replace, n, None, Some(i));
                    return (vec![Op::Replace { collection, entity: prev }], Some(i));
                }
                None => vec![Op::Remove { collection: collection.clone(), ids: vec![id_of(entity).unwrap_or("").to_owned()] }],
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
        (inverse, hit)
    }

    /// `remove` auf einer vorhandenen Liste: die entfernten Elemente wandern ohne Kopie in die
    /// inverse Op (`add` an den alten Positionen, zusammenhängende Läufe als eine Op) — beim Undo eines
    /// grossen Imports kostete das Kopieren und spätere Freigeben von 10⁵ Elementen Sekunden.
    fn remove_moving(&mut self, op: Op, pos: &mut PosCache) -> Vec<Op> {
        let Op::Remove { collection, ids } = op else { unreachable!("nur remove") };
        pos.forget(&collection);
        let drop: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let list = std::mem::take(self.list_mut(&collection));
        let before = list.len();
        let tracked = self.revs.items.contains_key(collection.as_str());
        let mut keep_mask: Vec<bool> = Vec::with_capacity(if tracked { before } else { 0 });
        let mut kept: Vec<Value> = Vec::with_capacity(before);
        let mut runs: Vec<Op> = Vec::new();
        let mut prev: Option<usize> = None;
        for (i, e) in list.into_iter().enumerate() {
            let gone = id_of(&e).is_some_and(|x| drop.contains(x));
            if tracked {
                keep_mask.push(!gone);
            }
            if !gone {
                kept.push(e);
                continue;
            }
            match runs.last_mut() {
                Some(Op::Add { items, .. }) if prev.is_some_and(|p| p + 1 == i) => items.push(e),
                _ => runs.push(Op::Add { collection: collection.clone(), items: vec![e], at: Some(i) }),
            }
            prev = Some(i);
        }
        *self.list_mut(&collection) = kept;
        self.revs.item_op(&collection, Shape::Remove, before, tracked.then_some(&keep_mask[..]), None);
        runs
    }

    /// Wendet `ops` an und liefert die inversen Ops (Anwendungsreihenfolge), ohne Prüfung (Undo/Redo:
    /// die Inverse eines Schritts ist der Gegenschritt).
    fn apply_inverting(&mut self, ops: Vec<Op>) -> Vec<Op> {
        let mut pos = self.pos.take();
        self.last_hits.clear();
        let mut inverses: Vec<Vec<Op>> = Vec::with_capacity(ops.len());
        for op in ops {
            let (key, replace) = (op.key().to_owned(), matches!(op, Op::Replace { .. }));
            let (inv, hit) = self.apply_recorded(op, &mut pos);
            self.mark_dirty(key, replace, hit);
            self.last_hits.push(hit);
            inverses.push(inv);
        }
        *self.pos.get_mut() = pos;
        inverses.into_iter().rev().flatten().collect()
    }

    /// Wendet `ops` atomar an und prüft sie (`ops::validate`, Werte vor dem Anwenden, neue doppelte ids
    /// danach — die Ops gehen ohne Kopie ins Dokument über). Verstösse → `Err(Meldungen)`, Dokument
    /// unverändert. Ok → inverse Ops. `sanitize`: die Ops können Nicht-endlich-Marken enthalten
    /// (s. `ops.rs`).
    fn apply_checked(&mut self, ops: Vec<Op>, sanitize: bool) -> Result<Vec<Op>, Vec<String>> {
        // Alt-Doppelungen der Listen merken, in die eingefügt oder die gesetzt wird.
        let mut had_dup: HashSet<String> = HashSet::new();
        for op in &ops {
            if matches!(op, Op::Add { .. } | Op::SetField { .. }) && !had_dup.contains(op.key()) && has_dup(self.root.get(op.key())) {
                had_dup.insert(op.key().to_owned());
            }
        }
        let had = |k: &str| had_dup.contains(k);
        let n = ops.len();
        let mut inverses: Vec<Vec<Op>> = Vec::with_capacity(n);
        let mut hits: Vec<Option<usize>> = Vec::with_capacity(n);
        // Je Op: Feld, ob `replace`, ob `add`, Befunde der Werte.
        let mut info: Vec<(String, bool, bool, Vec<String>)> = Vec::with_capacity(n);
        let mut pos = self.pos.take();
        for op in ops {
            let mut found = Vec::new();
            crate::ops::value_problems(&op, &had, &mut found);
            info.push((op.key().to_owned(), matches!(op, Op::Replace { .. }), matches!(op, Op::Add { .. }), found));
            let (inv, hit) = self.apply_recorded(op, &mut pos);
            inverses.push(inv);
            hits.push(hit);
        }
        let mut problems = Vec::new();
        let mut dup_checked: HashSet<&str> = HashSet::new();
        for (key, _, add, found) in &mut info {
            problems.append(found);
            if *add && dup_checked.insert(key.as_str()) {
                problems.extend(crate::ops::add_dup_problem(&self.root, key, &had));
            }
        }
        if !problems.is_empty() {
            // Nach der Rücknahme gilt keine gemerkte Position mehr sicher.
            let mut pos = PosCache::default();
            for inv in inverses.into_iter().rev() {
                for op in inv {
                    self.apply_raw(op, &mut pos);
                }
            }
            self.last_hits.clear();
            return Err(problems);
        }
        *self.pos.get_mut() = pos;
        if sanitize {
            // Angenommene Nicht-endlich-Marken (zu tief für die Prüfung) als null speichern.
            let keys: HashSet<&str> = info.iter().map(|i| i.0.as_str()).collect();
            for k in keys {
                if let Some(v) = self.root.get_mut(k) {
                    crate::ops::sanitize_non_finite(v);
                }
            }
        }
        for ((key, replace, _, _), hit) in info.into_iter().zip(&hits) {
            self.mark_dirty(key, replace, *hit);
        }
        self.last_hits = hits;
        Ok(inverses.into_iter().rev().flatten().collect())
    }

    /// Wendet `ops` atomar an, ohne Verlauf (Abgleich des Spiegels). Verstösse (NaN, neue
    /// doppelte ids) → `Err(Meldungen)`, Dokument unverändert.
    pub fn apply(&mut self, ops: &[Op]) -> Result<(), Vec<String>> {
        self.apply_checked(ops.to_vec(), false).map(|_| ())
    }

    /// Wie [`Document::apply`] (die Ops gehen ins Dokument über); `sanitize` = die Ops können
    /// Nicht-endlich-Marken enthalten.
    pub fn apply_marked(&mut self, ops: Vec<Op>, sanitize: bool) -> Result<(), Vec<String>> {
        self.apply_checked(ops, sanitize).map(|_| ())
    }

    /// Eine Benutzer-Änderung: anwenden, prüfen und als Undo-Schritt aufzeichnen (`key` =
    /// `coalesceKey`, `now` = Zeit in ms für das Koaleszenz-Fenster). Die Ops gehen ohne Kopie ins
    /// Dokument über; der Verlauf hält nur die inversen Ops (den Redo-Schritt liefert das Rückgängig-
    /// machen selbst: die Inverse der Inversen, s. [`Document::undo`]).
    pub fn commit(&mut self, ops: Vec<Op>, key: Option<&str>, now: f64, sanitize: bool) -> Result<(), Vec<String>> {
        let inverse = self.apply_checked(ops, sanitize)?;
        self.history.record(inverse, key, now);
        Ok(())
    }

    /// Einen Schritt zurück; liefert die angewendeten Ops (für die TS-Leseansicht), `None` = nichts.
    /// Die dabei entstehenden Inversen sind der Redo-Schritt.
    pub fn undo(&mut self) -> Option<Vec<Op>> {
        let mut applied = None;
        self.undo_with(|ops| applied = Some(ops.to_vec()));
        applied
    }

    /// Einen Schritt vor; liefert die angewendeten Ops, `None` = nichts.
    pub fn redo(&mut self) -> Option<Vec<Op>> {
        let mut applied = None;
        self.redo_with(|ops| applied = Some(ops.to_vec()));
        applied
    }

    /// Wie [`Document::undo`] ohne Kopie der Ops: `emit` sieht sie vor dem Anwenden (z. B. als JSON
    /// schreiben, oder gar nicht, wenn TS den Schritt selbst kennt). `false` = nichts rückgängig zu machen.
    pub fn undo_with(&mut self, emit: impl FnOnce(&[Op])) -> bool {
        let Some(step) = self.history.pop_undo() else { return false };
        emit(&step.ops);
        let redo = self.apply_inverting(step.ops);
        self.history.push_redo(Step::new(redo));
        true
    }

    /// Wie [`Document::redo`] ohne Kopie der Ops (s. [`Document::undo_with`]).
    pub fn redo_with(&mut self, emit: impl FnOnce(&[Op])) -> bool {
        let Some(step) = self.history.pop_redo() else { return false };
        emit(&step.ops);
        let undo = self.apply_inverting(step.ops);
        self.history.push_undo(Step::new(undo));
        true
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
    fn messung_grosse_polylinie() {
        use std::time::Instant;
        let pts: Vec<Value> = (0..5000).map(|k| json!({"x": k as f64 * 0.1, "y": (k as f64 / 50.0).sin()})).collect();
        let mut drawings: Vec<Value> = (0..20000).map(|i| json!({"id": format!("d{i}"), "levelId": "eg", "geom": {"shape": "polyline", "closed": false, "pts": [{"x": i, "y": 1}, {"x": i + 1, "y": 2}]}})).collect();
        drawings[19000] = json!({"id": "d19000", "levelId": "eg", "geom": {"shape": "polyline", "closed": false, "pts": pts}});
        let mut d = Document::from_json(&json!({"id": "p", "drawings2d": drawings}).to_string()).unwrap();
        let n = 30;
        let (mut run, mut json, mut commit) = (0.0, 0.0, 0.0);
        for k in 0..n {
            let req: crate::grips::Request = serde_json::from_value(json!({"op": "moveGrip", "drawingId": "d19000", "index": 2500, "pt": [250.0 + (k % 5) as f64 * 0.01, 3], "scale": 100})).unwrap();
            let t = Instant::now();
            let res = crate::grips::run(&d.lookup(), &req).unwrap();
            run += t.elapsed().as_secs_f64();
            let t = Instant::now();
            let text = crate::grips::result_json(&res);
            json += t.elapsed().as_secs_f64();
            let t = Instant::now();
            d.commit(res.ops, Some("g"), k as f64, text.contains("\\u0001")).unwrap();
            commit += t.elapsed().as_secs_f64();
        }
        let ms = |x: f64| x * 1e3 / n as f64;
        eprintln!("Polylinie 5000 Punkte: Griff {:.2} ms, JSON {:.2} ms, Commit {:.2} ms", ms(run), ms(json), ms(commit));
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

#[cfg(test)]
mod big_steps {
    use super::*;
    use serde_json::json;

    fn ops(v: Value) -> Vec<Op> {
        crate::ops::ops_from_json(&v).unwrap()
    }

    #[test]
    fn schritt_laufnummern_und_verschmelzen() {
        let mut d = Document::from_json(r#"{"id":"p","walls":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}"#).unwrap();
        assert_eq!(d.history().top_seqs(), (0, 0));
        d.commit(ops(json!([{"kind":"remove","collection":"walls","ids":["b","c"]}])), None, 0.0, false).unwrap();
        let (s1, _) = d.history().top_seqs();
        assert!(s1 > 0 && !d.history().last_merged());
        d.commit(ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","x":1}}])), Some("k"), 10.0, false).unwrap();
        let (s2, _) = d.history().top_seqs();
        assert!(s2 != s1 && !d.history().last_merged());
        d.commit(ops(json!([{"kind":"replace","collection":"walls","entity":{"id":"a","x":2}}])), Some("k"), 20.0, false).unwrap();
        let (s3, _) = d.history().top_seqs();
        assert!(s3 != s2 && d.history().last_merged(), "verschmolzen = neuer Schritt, neue Nummer");
        // Undo ohne Ops-Rückgabe; die Gegenrichtung bekommt eine neue Nummer.
        assert!(d.undo_with(|_| ()));
        let (u, r) = d.history().top_seqs();
        assert!(u == s1 && r > s3);
        // Undo des `remove`: Elemente an den alten Positionen zurück (ohne Kopie verschoben).
        let mut seen = String::new();
        assert!(d.undo_with(|o| seen = crate::ops::ops_to_json(o)));
        assert_eq!(seen, r#"[{"kind":"add","collection":"walls","items":[{"id":"b"},{"id":"c"}],"at":1}]"#);
        assert_eq!(d.to_json(), r#"{"id":"p","walls":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}"#);
        assert!(!d.undo_with(|_| panic!("leer")));
        assert!(d.redo_with(|_| ()) && d.redo_with(|_| ()));
        assert_eq!(d.to_json(), r#"{"id":"p","walls":[{"id":"a","x":2},{"id":"d"}]}"#);
    }

    /// Messung (nativ): grosser Import (150 000 Zeichnungen) committen, Undo, Redo. `cargo test --release -- --ignored`.
    #[test]
    #[ignore]
    fn import_150k() {
        let mut d = Document::from_json(r#"{"id":"p","drawings2d":[]}"#).unwrap();
        let items: Vec<Value> = (0..150_000)
            .map(|i| json!({"id": format!("dxf2d-1-{i}"), "type":"drawing2d","levelId":"drawing-1","categoryCode":"105",
                "geom":{"shape":"polyline","points":[{"x":2601258.0+i as f64,"y":1204834.5},{"x":2601278.0,"y":1204834.0},{"x":2601278.0,"y":1204854.0}],"closed":true,"bulges":[0,0.25,0]}}))
            .collect();
        let t = std::time::Instant::now();
        d.commit(vec![Op::Add { collection: "drawings2d".into(), items, at: None }], None, 0.0, false).unwrap();
        eprintln!("commit {:?}", t.elapsed());
        for _ in 0..2 {
            let t = std::time::Instant::now();
            let mut n = 0;
            d.undo_with(|o| n = crate::ops::ops_to_json(o).len());
            eprintln!("undo+json {:?} {n}", t.elapsed());
            let t = std::time::Instant::now();
            d.redo_with(|o| n = crate::ops::ops_to_json(o).len());
            eprintln!("redo+json {:?} {n}", t.elapsed());
            let t = std::time::Instant::now();
            d.undo_with(|_| ());
            d.redo_with(|_| ());
            eprintln!("undo+redo quiet {:?}", t.elapsed());
        }
    }
}
