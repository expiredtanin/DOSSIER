//! Ops, Validierung und Undo/Redo-Verlauf ([K4] S3, [7], [8]).
//!
//! Eine [`Op`] ist eine Änderung am Projekt (Spiegel von `CoreOp` in `src/core/ops.ts`). Das
//! Dokument (`document.rs`) wendet Op-Folgen atomar an, prüft sie hier ([`validate`], gleiche
//! Ablehnungen und Meldungen wie die frühere TS-Fassung `validateOps`) und hält den Verlauf
//! ([`History`]): je Schritt die Vorwärts-Ops und die inversen Ops — keine Projekt-Schnappschüsse.
//!
//! Nicht endliche Zahlen: JSON kennt weder NaN noch ±Infinity. TS kodiert sie beim Senden als
//! Marken-Text `"\u{1}NaN"`, `"\u{1}Infinity"`, `"\u{1}-Infinity"` (s. `opsToJson` in
//! `core/document.ts`), damit die Prüfung sie sieht. Was trotzdem angenommen wird (tiefer als die
//! Prüfung schaut), wird als `null` gespeichert — wie `JSON.stringify` es täte.

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

/// Zeitfenster, in dem Änderungen mit gleichem `coalesceKey` zu einem Undo-Schritt verschmelzen (ms).
pub const COALESCE_WINDOW_MS: f64 = 400.0;

/// Eine Änderung am Projekt.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// Fügt Elemente an `at` (Default: Ende) in die Liste `collection` ein.
    Add { collection: String, items: Vec<Value>, at: Option<usize> },
    /// Ersetzt das Element mit gleicher id (fehlt es, wird angehängt).
    Replace { collection: String, entity: Value },
    /// Entfernt Elemente per id.
    Remove { collection: String, ids: Vec<String> },
    /// Setzt die Reihenfolge (genannte ids zuerst, der Rest dahinter).
    Reorder { collection: String, ids: Vec<String> },
    /// Setzt ein Feld (`None` = entfernen). `at`: Position, falls das Feld neu eingefügt wird
    /// (Undo stellt so auch die Feld-Reihenfolge wieder her).
    SetField { key: String, value: Option<Value>, at: Option<usize> },
}

pub(crate) fn id_of(v: &Value) -> Option<&str> {
    let o = v.as_object()?;
    // Schnellweg: `id` steht fast immer zuerst (spart das Hashen bei langen Listen).
    match o.iter().next() {
        Some((k, id)) if k == "id" => id.as_str(),
        _ => o.get("id").and_then(Value::as_str),
    }
}

fn index_arg(v: Option<&Value>, what: &str) -> Result<Option<usize>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        // Wie JS `slice`: Bruchteile abschneiden, negativ → 0.
        Some(a) => a.as_f64().filter(|x| x.is_finite()).map(|x| Some(x.max(0.0) as usize)).ok_or(format!("{what} ungültig")),
    }
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
                Op::Add { collection: s("collection")?, items, at: index_arg(v.get("at"), "Op add: at")? }
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
            // `value: null` ist ein Wert (TS setzt das Feld auf null); fehlend = entfernen.
            "setField" => Op::SetField { key: s("key")?, value: v.get("value").cloned(), at: index_arg(v.get("at"), "Op setField: at")? },
            other => return Err(format!("Unbekannte Op: {other}")),
        })
    }

    /// JSON-Form wie `CoreOp` in TS.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        let mut put = |k: &str, v: Value| {
            m.insert(k.to_owned(), v);
        };
        match self {
            Op::Add { collection, items, at } => {
                put("kind", "add".into());
                put("collection", collection.as_str().into());
                put("items", Value::Array(items.clone()));
                if let Some(a) = at {
                    put("at", (*a as u64).into());
                }
            }
            Op::Replace { collection, entity } => {
                put("kind", "replace".into());
                put("collection", collection.as_str().into());
                put("entity", entity.clone());
            }
            Op::Remove { collection, ids } | Op::Reorder { collection, ids } => {
                put("kind", if matches!(self, Op::Remove { .. }) { "remove" } else { "reorder" }.into());
                put("collection", collection.as_str().into());
                put("ids", ids.iter().map(|s| Value::from(s.as_str())).collect());
            }
            Op::SetField { key, value, at } => {
                put("kind", "setField".into());
                put("key", key.as_str().into());
                if let Some(v) = value {
                    put("value", v.clone());
                }
                if let Some(a) = at {
                    put("at", (*a as u64).into());
                }
            }
        }
        Value::Object(m)
    }

    /// Das Projekt-Feld, das die Op ändert.
    pub fn key(&self) -> &str {
        match self {
            Op::Add { collection, .. } | Op::Replace { collection, .. } | Op::Remove { collection, .. } | Op::Reorder { collection, .. } => collection,
            Op::SetField { key, .. } => key,
        }
    }
}

/// Op-Liste aus JSON (Array).
pub fn ops_from_json(v: &Value) -> Result<Vec<Op>, String> {
    v.as_array().ok_or("Ops sind kein Array".to_string())?.iter().map(Op::from_json).collect()
}

/// Op-Liste als JSON-Text.
pub fn ops_to_json(ops: &[Op]) -> String {
    let mut out = Vec::new();
    write_ops(&mut out, ops);
    String::from_utf8(out).unwrap_or_default()
}

/// Op-Liste als JSON wie [`Op::to_json`], ohne die Elemente zu kopieren (grosse Importe und ihr
/// Undo/Redo: 10⁵ Zeichnungen).
pub fn write_ops(out: &mut Vec<u8>, ops: &[Op]) {
    fn head(out: &mut Vec<u8>, kind: &str, collection: &str) {
        out.extend_from_slice(b"{\"kind\":\"");
        out.extend_from_slice(kind.as_bytes());
        out.extend_from_slice(b"\",\"collection\":");
        let _ = serde_json::to_writer(&mut *out, collection);
    }
    out.push(b'[');
    for (i, op) in ops.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        match op {
            Op::Add { collection, items, at } => {
                head(out, "add", collection);
                out.extend_from_slice(b",\"items\":[");
                for (k, it) in items.iter().enumerate() {
                    if k > 0 {
                        out.push(b',');
                    }
                    let _ = serde_json::to_writer(&mut *out, it);
                }
                out.push(b']');
                if let Some(a) = at {
                    out.extend_from_slice(format!(",\"at\":{a}").as_bytes());
                }
                out.push(b'}');
            }
            Op::Replace { collection, entity } => {
                head(out, "replace", collection);
                out.extend_from_slice(b",\"entity\":");
                let _ = serde_json::to_writer(&mut *out, entity);
                out.push(b'}');
            }
            op => {
                let _ = serde_json::to_writer(&mut *out, &op.to_json());
            }
        }
    }
    out.push(b']');
}

// ── Listen-Hilfen ────────────────────────────────────────────────────────────

/// Liste mit lauter `id`-tragenden Elementen (leer zählt mit) — `isIdList` in TS.
pub fn is_id_list(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(|e| id_of(e).is_some()))
}

/// Nicht leere Liste mit lauter ids — `isEntityList` in TS.
fn is_entity_list(v: &Value) -> bool {
    v.as_array().is_some_and(|a| !a.is_empty()) && is_id_list(v)
}

pub fn unique_ids(list: &[Value]) -> bool {
    let mut seen = HashSet::new();
    list.iter().all(|e| seen.insert(id_of(e).unwrap_or("")))
}

/// Liste mit alten Doppelungen (Alt-Dateien bleiben änderbar: nur NEUE Doppelungen zählen).
pub fn has_dup(v: Option<&Value>) -> bool {
    match v {
        Some(v) if is_id_list(v) => !unique_ids(v.as_array().unwrap()),
        _ => false,
    }
}

// ── Nicht endliche Zahlen ────────────────────────────────────────────────────

/// Text einer Nicht-endlich-Marke (`"\u{1}NaN"` → `"NaN"`).
pub fn non_finite_mark(v: &Value) -> Option<&str> {
    match v.as_str()?.strip_prefix('\u{1}')? {
        t @ ("NaN" | "Infinity" | "-Infinity") => Some(t),
        _ => None,
    }
}

/// `findNonFinite` aus TS: Suche bis Tiefe 3, grosse Zahlenfelder (> 5000) werden übersprungen.
fn find_non_finite(v: &Value, depth: u32) -> Option<&str> {
    if let Some(t) = non_finite_mark(v) {
        return Some(t);
    }
    if depth > 3 {
        return None;
    }
    match v {
        Value::Array(a) if a.len() > 5000 => None,
        Value::Array(a) => a.iter().find_map(|x| find_non_finite(x, depth + 1)),
        Value::Object(o) => o.values().find_map(|x| find_non_finite(x, depth + 1)),
        _ => None,
    }
}

/// Ersetzt Nicht-endlich-Marken durch `null` (Speicherform, wie `JSON.stringify`).
pub fn sanitize_non_finite(v: &mut Value) {
    match v {
        Value::String(_) if non_finite_mark(v).is_some() => *v = Value::Null,
        Value::Array(a) => a.iter_mut().for_each(sanitize_non_finite),
        Value::Object(o) => o.values_mut().for_each(sanitize_non_finite),
        _ => {}
    }
}

// ── Validierung ([7]) ────────────────────────────────────────────────────────

/// Prüft eine angewendete Op-Folge (bitgleich zur früheren TS-Fassung `validateOps`): nicht
/// endliche Zahlen in neuen/ersetzten Elementen und `setField`-Zahlen, neue doppelte ids in den
/// Listen, in die eingefügt wurde. `after` = Projekt nach den Ops, `had_dup(key)` = die Liste hatte
/// vorher schon Doppelungen.
pub fn validate(after: &Map<String, Value>, ops: &[Op], had_dup: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut problems = Vec::new();
    let mut dup_checked: HashSet<&str> = HashSet::new();
    for op in ops {
        value_problems(op, had_dup, &mut problems);
        if let Op::Add { collection, .. } = op {
            if dup_checked.insert(collection) {
                problems.extend(add_dup_problem(after, collection, had_dup));
            }
        }
    }
    problems
}

/// Der Teil von [`validate`], der nur die Op selbst liest (vor dem Anwenden prüfbar): nicht endliche
/// Zahlen in Elementen und Feldwerten, doppelte ids in einer gesetzten Liste.
pub fn value_problems(op: &Op, had_dup: &dyn Fn(&str) -> bool, problems: &mut Vec<String>) {
    match op {
        Op::Add { collection, .. } | Op::Replace { collection, .. } => {
            let ents: &[Value] = match op {
                Op::Add { items, .. } => items,
                Op::Replace { entity, .. } => std::slice::from_ref(entity),
                _ => unreachable!(),
            };
            for e in ents {
                if let Some(bad) = find_non_finite(e, 0) {
                    problems.push(format!("„{collection}\" {}: {bad} ist nicht endlich.", id_of(e).unwrap_or("undefined")));
                }
            }
        }
        Op::SetField { key, value, .. } => {
            if let Some(bad) = value.as_ref().and_then(non_finite_mark) {
                problems.push(format!("Feld „{key}\": {bad} ist nicht endlich."));
            } else if let Some(v) = value {
                if is_entity_list(v) && !unique_ids(v.as_array().unwrap()) && !had_dup(key) {
                    problems.push(format!("Doppelte ids in „{key}\"."));
                }
            }
        }
        _ => {}
    }
}

/// Der Teil von [`validate`] nach dem Anwenden: doppelte ids in der Liste `collection` nach einem `add`.
pub fn add_dup_problem(after: &Map<String, Value>, collection: &str, had_dup: &dyn Fn(&str) -> bool) -> Option<String> {
    let list = after.get(collection)?;
    (is_id_list(list) && !unique_ids(list.as_array().unwrap()) && !had_dup(collection)).then(|| format!("Doppelte ids in „{collection}\"."))
}

/// Wie [`validate`] mit dem Projekt vor den Ops (für die TS-Fassade `validateOps`).
pub fn validate_ops(after: &Map<String, Value>, ops: &[Op], before: Option<&Map<String, Value>>) -> Vec<String> {
    validate(after, ops, &|k| before.is_some_and(|b| has_dup(b.get(k))))
}

/// Prüft ein ganzes Projekt (`validateProject`): doppelte ids und nicht endliche Zahlen je Liste.
pub fn validate_project(root: &Map<String, Value>) -> Vec<String> {
    let mut problems = Vec::new();
    for (key, v) in root {
        if !is_entity_list(v) {
            continue;
        }
        let list = v.as_array().unwrap();
        if !unique_ids(list) {
            problems.push(format!("Doppelte ids in „{key}\"."));
        }
        for e in list {
            if let Some(bad) = find_non_finite(e, 0) {
                problems.push(format!("„{key}\" {}: {bad} ist nicht endlich.", id_of(e).unwrap_or("undefined")));
                break;
            }
        }
    }
    problems
}

// ── Verlauf ([8]) ────────────────────────────────────────────────────────────

/// Ein Schritt des Verlaufs: die Ops, die ihn anwenden (Undo-Stapel: die inversen Ops der Änderung,
/// Redo-Stapel: die Änderung), in Anwendungsreihenfolge. Die Gegenrichtung entsteht beim Anwenden
/// (`Document::undo`/`redo`: die Inverse der Inversen) — so hält der Verlauf jedes Element nur einmal.
#[derive(Clone, Debug, Default)]
pub struct Step {
    pub ops: Vec<Op>,
    /// Kurze Beschriftung für die Verlaufsliste (i18n-Schlüssel oder Text; leer = Standard der UI).
    pub label: String,
    bytes: usize,
    /// Laufnummer (nie 0; jeder neu gebaute Schritt bekommt eine neue, auch beim Verschmelzen und beim
    /// Wechsel zwischen Undo- und Redo-Stapel): TS erkennt daran einen Schritt wieder, dessen Stände es
    /// selbst noch hält (`ProjectDocument`: Undo/Redo grosser Importe ohne Ops-Rückgabe).
    pub seq: u64,
}

/// Zähler der Schritt-Laufnummern (prozessweit, von allen Dokumenten geteilt).
static STEP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Step {
    pub fn new(ops: Vec<Op>) -> Step {
        let bytes = ops_bytes(&ops);
        let seq = STEP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        Step { ops, label: String::new(), bytes, seq }
    }
    pub fn labeled(mut self, label: String) -> Step {
        self.bytes += label.len();
        self.label = label;
        self
    }
}

/// Geschätzter Speicherbedarf eines JSON-Werts (Bytes).
fn approx_bytes(v: &Value) -> usize {
    match v {
        Value::String(s) => 24 + s.len(),
        Value::Array(a) => 24 + a.iter().map(approx_bytes).sum::<usize>(),
        Value::Object(o) => 64 + o.iter().map(|(k, v)| 24 + k.len() + approx_bytes(v)).sum::<usize>(),
        _ => 16,
    }
}

fn ops_bytes(ops: &[Op]) -> usize {
    ops.iter()
        .map(|op| {
            48 + op.key().len()
                + match op {
                    Op::Add { items, .. } => items.iter().map(approx_bytes).sum(),
                    Op::Replace { entity, .. } => approx_bytes(entity),
                    Op::Remove { ids, .. } | Op::Reorder { ids, .. } => ids.iter().map(|s| 24 + s.len()).sum(),
                    Op::SetField { value, .. } => value.as_ref().map_or(0, approx_bytes),
                }
        })
        .sum()
}

/// Streicht Ops, die eine spätere Op derselben Folge vollständig überschreibt (Drag/Regler-Serien
/// wachsen so nicht mit jeder Mausbewegung): `replace` desselben Elements ohne Struktur-Op auf der
/// Liste dazwischen, `setField` desselben Felds mit gleicher Einfüge-Position. Alle aufgezeichneten
/// `replace` treffen ein vorhandenes Element (s. `Document::apply_recorded`), daher ist das exakt.
pub fn compact(ops: Vec<Op>) -> Vec<Op> {
    let mut keep = vec![true; ops.len()];
    {
        let mut later_set: HashMap<&str, Option<usize>> = HashMap::new();
        let mut later_replaced: HashMap<&str, HashSet<&str>> = HashMap::new();
        for (i, op) in ops.iter().enumerate().rev() {
            let k = op.key();
            match op {
                Op::SetField { value: Some(_), at, .. } => {
                    if later_set.get(k) == Some(at) {
                        keep[i] = false;
                    } else {
                        later_set.insert(k, *at);
                        later_replaced.remove(k);
                    }
                }
                Op::Replace { entity, .. } => {
                    later_set.remove(k);
                    if !later_replaced.entry(k).or_default().insert(id_of(entity).unwrap_or("")) {
                        keep[i] = false;
                    }
                }
                _ => {
                    later_set.remove(k);
                    later_replaced.remove(k);
                }
            }
        }
    }
    if keep.iter().all(|&k| k) {
        return ops;
    }
    ops.into_iter().zip(keep).filter_map(|(op, k)| k.then_some(op)).collect()
}

/// Undo/Redo-Stapel. Gleicher `coalesceKey` innerhalb von [`COALESCE_WINDOW_MS`] = ein Schritt;
/// Gruppen (`begin_group`/`end_group`) fassen beliebige Änderungen zu einem Schritt zusammen.
/// Begrenzt auf `max_steps` Schritte und (ungefähr) `max_bytes` Speicher — die ältesten fallen weg.
#[derive(Clone, Debug)]
pub struct History {
    undo: VecDeque<Step>,
    redo: Vec<Step>,
    last_key: Option<String>,
    last_at: f64,
    group_depth: u32,
    /// In einer offenen Gruppe: der erste Schritt steht schon (weitere verschmelzen damit).
    group_started: bool,
    /// Schlüssel und Zeit der offenen Gruppe (`begin_group_keyed`): aufeinanderfolgende Gruppen
    /// mit gleichem Schlüssel im Zeitfenster verschmelzen wie einzelne Änderungen.
    group_key: Option<String>,
    group_at: f64,
    /// Die offene Gruppe hat etwas aufgezeichnet.
    group_recorded: bool,
    /// Beschriftung für den nächsten neu angelegten Schritt ([`History::set_label`]).
    pending_label: String,
    /// Die letzte Aufzeichnung ist mit dem vorigen Schritt verschmolzen (Koaleszenz, Gruppe).
    merged: bool,
    bytes: usize,
    pub max_steps: usize,
    pub max_bytes: usize,
}

impl Default for History {
    fn default() -> Self {
        History {
            undo: VecDeque::new(),
            redo: Vec::new(),
            last_key: None,
            last_at: 0.0,
            group_depth: 0,
            group_started: false,
            group_key: None,
            group_at: 0.0,
            group_recorded: false,
            pending_label: String::new(),
            merged: false,
            bytes: 0,
            max_steps: 100,
            max_bytes: 256 << 20,
        }
    }
}

impl History {
    pub fn undo_depth(&self) -> usize {
        self.undo.len()
    }
    pub fn redo_depth(&self) -> usize {
        self.redo.len()
    }
    /// Geschätzter Speicher aller Schritte (Bytes).
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    /// Laufnummern der obersten Schritte `(Undo, Redo)`, 0 = Stapel leer.
    pub fn top_seqs(&self) -> (u64, u64) {
        (self.undo.back().map_or(0, |s| s.seq), self.redo.last().map_or(0, |s| s.seq))
    }
    /// Die letzte Aufzeichnung ist mit dem vorigen Schritt verschmolzen (kein eigener Schritt).
    pub fn last_merged(&self) -> bool {
        self.merged
    }

    /// Beschriftung des Schritts, den die nächste aufgezeichnete Änderung neu anlegt (Koaleszenz
    /// und Gruppen-Folgeänderungen behalten die des ersten). Wird von `record` verbraucht; leer = keine.
    pub fn set_label(&mut self, label: &str) {
        self.pending_label.clear();
        self.pending_label.extend(label.chars().take(120));
    }

    /// Beschriftungen `(Undo: ältester zuerst, Redo: nächster zuerst)`.
    pub fn labels(&self) -> (Vec<String>, Vec<String>) {
        (
            self.undo.iter().map(|s| s.label.clone()).collect(),
            self.redo.iter().rev().map(|s| s.label.clone()).collect(),
        )
    }

    pub fn clear(&mut self) {
        self.pending_label.clear();
        self.undo.clear();
        self.redo.clear();
        self.bytes = 0;
        self.last_key = None;
        self.group_depth = 0;
        self.group_started = false;
    }

    pub fn begin_group(&mut self) {
        self.begin_group_keyed(None, 0.0);
    }

    /// Wie [`History::begin_group`]; mit `key` verschmilzt die Gruppe mit dem vorigen Schritt, wenn
    /// dieser von einer Gruppe (oder Änderung) mit gleichem Schlüssel innerhalb des Zeitfensters
    /// stammt — z. B. ein Griff-Zug, der je Mausschritt mehrere Elemente mitführt.
    pub fn begin_group_keyed(&mut self, key: Option<&str>, now: f64) {
        if self.group_depth == 0 {
            let coalesced = key.is_some() && key == self.last_key.as_deref() && now - self.last_at < COALESCE_WINDOW_MS;
            self.group_started = coalesced && !self.undo.is_empty();
            self.group_key = key.map(str::to_owned);
            self.group_at = now;
            self.group_recorded = false;
        }
        self.group_depth += 1;
    }

    pub fn end_group(&mut self) {
        if self.group_depth == 0 {
            return;
        }
        self.group_depth -= 1;
        if self.group_depth == 0 {
            if self.group_recorded || self.group_key.is_none() {
                // Ohne Schlüssel beginnt die nächste Änderung einen eigenen Schritt (auch mit gleichem
                // Schlüssel); mit Schlüssel kann die nächste gleichnamige Gruppe anschliessen.
                self.last_key = self.group_key.take();
                self.last_at = self.group_at;
            } else {
                self.group_key = None;
            }
        }
    }

    /// Zeichnet eine angewendete Änderung auf (`inverse` = die Ops, die sie zurücknehmen).
    pub fn record(&mut self, inverse: Vec<Op>, key: Option<&str>, now: f64) {
        for s in self.redo.drain(..) {
            self.bytes -= s.bytes;
        }
        let coalesced = key.is_some() && key == self.last_key.as_deref() && now - self.last_at < COALESCE_WINDOW_MS;
        self.last_key = key.map(str::to_owned);
        self.last_at = now;
        if self.group_depth > 0 {
            self.group_recorded = true;
        }
        let label = std::mem::take(&mut self.pending_label);
        let merge = if self.group_depth > 0 { std::mem::replace(&mut self.group_started, true) } else { coalesced };
        self.merged = merge && !self.undo.is_empty();
        match self.undo.back_mut().filter(|_| merge) {
            Some(top) => {
                self.bytes -= top.bytes;
                let mut inv = inverse;
                inv.append(&mut top.ops);
                *top = Step::new(compact(inv)).labeled(std::mem::take(&mut top.label));
                self.bytes += top.bytes;
            }
            None => {
                let s = Step::new(inverse).labeled(label);
                self.bytes += s.bytes;
                self.undo.push_back(s);
            }
        }
        while self.undo.len() > self.max_steps || (self.bytes > self.max_bytes && self.undo.len() > 1) {
            let s = self.undo.pop_front().expect("nicht leer");
            self.bytes -= s.bytes;
        }
    }

    /// Nimmt den jüngsten Schritt vom Undo-Stapel (der Aufrufer wendet `inverse` an und legt ihn
    /// mit [`History::push_redo`] ab).
    pub fn pop_undo(&mut self) -> Option<Step> {
        self.group_depth = 0;
        self.last_key = None;
        let s = self.undo.pop_back()?;
        self.bytes -= s.bytes;
        Some(s)
    }
    pub fn push_redo(&mut self, s: Step) {
        self.bytes += s.bytes;
        self.redo.push(s);
    }
    pub fn pop_redo(&mut self) -> Option<Step> {
        self.group_depth = 0;
        self.last_key = None;
        let s = self.redo.pop()?;
        self.bytes -= s.bytes;
        Some(s)
    }
    pub fn push_undo(&mut self, s: Step) {
        self.bytes += s.bytes;
        self.undo.push_back(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }
    fn ops(v: Value) -> Vec<Op> {
        ops_from_json(&v).unwrap()
    }

    #[test]
    fn json_hin_und_zurueck() {
        let v = json!([
            {"kind":"add","collection":"walls","items":[{"id":"a"}],"at":2},
            {"kind":"replace","collection":"walls","entity":{"id":"a","x":1}},
            {"kind":"remove","collection":"walls","ids":["a"]},
            {"kind":"reorder","collection":"walls","ids":["b","a"]},
            {"kind":"setField","key":"name","value":"N"},
            {"kind":"setField","key":"name","value":null,"at":3},
            {"kind":"setField","key":"name"},
        ]);
        assert_eq!(serde_json::from_str::<Value>(&ops_to_json(&ops(v.clone()))).unwrap(), v);
    }

    #[test]
    fn meldungen_wie_ts() {
        let before = obj(json!({"walls":[{"id":"a"}],"old":[{"id":"x"},{"id":"x"}]}));
        let after = obj(json!({"walls":[{"id":"a"},{"id":"a","h":"\u{1}NaN"}],"old":[{"id":"x"},{"id":"x"},{"id":"y"}]}));
        let o = ops(json!([
            {"kind":"add","collection":"walls","items":[{"id":"a","h":"\u{1}NaN"}]},
            {"kind":"add","collection":"old","items":[{"id":"y"}]},
            {"kind":"replace","collection":"walls","entity":{"id":"a","p":{"q":[1,"\u{1}-Infinity"]}}},
            {"kind":"setField","key":"scale","value":"\u{1}Infinity"},
            {"kind":"setField","key":"levels","value":[{"id":"l"},{"id":"l"}]},
        ]));
        assert_eq!(
            validate_ops(&after, &o, Some(&before)),
            vec![
                "„walls\" a: NaN ist nicht endlich.",
                "Doppelte ids in „walls\".",
                "„walls\" a: -Infinity ist nicht endlich.",
                "Feld „scale\": Infinity ist nicht endlich.",
                "Doppelte ids in „levels\".",
            ]
        );
    }

    #[test]
    fn tiefe_und_grosse_felder_wie_ts() {
        // Tiefe 4 wird noch geprüft (Zahl vor der Tiefenprüfung), Tiefe 5 nicht.
        let deep4 = json!({"id":"a","b":{"c":{"d":{"e":"\u{1}NaN"}}}});
        let deep5 = json!({"id":"a","b":{"c":{"d":{"e":{"f":"\u{1}NaN"}}}}});
        assert!(find_non_finite(&deep4, 0).is_some());
        assert!(find_non_finite(&deep5, 0).is_none());
        let mut big = vec![json!(0); 5001];
        big[3] = json!("\u{1}NaN");
        assert!(find_non_finite(&json!({"id":"a","m":big}), 0).is_none());
    }

    #[test]
    fn projekt_pruefung() {
        let p = obj(json!({"walls":[{"id":"a","h":"\u{1}NaN"},{"id":"a"}],"levels":[],"name":"x"}));
        assert_eq!(validate_project(&p), vec!["Doppelte ids in „walls\".", "„walls\" a: NaN ist nicht endlich."]);
    }

    #[test]
    fn verdichtung() {
        let o = ops(json!([
            {"kind":"replace","collection":"walls","entity":{"id":"a","x":1}},
            {"kind":"replace","collection":"walls","entity":{"id":"b","x":1}},
            {"kind":"replace","collection":"walls","entity":{"id":"a","x":2}},
            {"kind":"setField","key":"s","value":1},
            {"kind":"setField","key":"s","value":2},
            {"kind":"remove","collection":"walls","ids":["c"]},
            {"kind":"replace","collection":"walls","entity":{"id":"a","x":3}},
        ]));
        let c = compact(o.clone());
        assert_eq!(c.len(), 5);
        assert_eq!(c[0], o[1]);
        assert_eq!(c[1], o[2]);
        assert_eq!(c[2], o[4]);
    }

    #[test]
    fn verlauf_koalesziert_und_begrenzt() {
        let mut h = History { max_steps: 3, ..Default::default() };
        let op = |n: i32| ops(json!([{"kind":"setField","key":"s","value":n}]));
        h.record(op(0), Some("k"), 0.0);
        h.record(op(1), Some("k"), 100.0);
        assert_eq!(h.undo_depth(), 1);
        h.record(op(2), Some("k"), 600.0);
        assert_eq!(h.undo_depth(), 2);
        h.record(op(3), None, 700.0);
        h.record(op(4), None, 800.0);
        assert_eq!(h.undo_depth(), 3);
        h.begin_group();
        h.record(op(5), None, 900.0);
        h.record(op(6), Some("x"), 901.0);
        h.end_group();
        assert_eq!(h.undo_depth(), 3);
        let s = h.pop_undo().unwrap();
        assert_eq!(s.ops, op(5));
    }
}
