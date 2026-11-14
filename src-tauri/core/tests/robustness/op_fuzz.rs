//! [258] Zustandsbehafteter Op-Fuzzer: aus dem aktuellen Dokument heraus GÜLTIGE Ops aller Arten
//! (add / replace / remove / reorder / setField, einzeln, als Stapel in einem Commit, in Gruppen, mit
//! Coalesce-Schlüsseln), angewendet über denselben Weg wie die App (`Document::commit`, `history_*`,
//! `undo`/`redo`/`history_jump`). Nach JEDEM Schritt Invarianten (s. `run_episode`).
//!
//! Das Modell des Verlaufs: `snaps[i]` = Dokument-JSON bei Undo-Tiefe `i` (samt Redo-Rest dahinter).
//! Jedes Undo/Redo/Springen muss exakt dort landen, jeder verschmolzene Schritt überschreibt
//! `snaps[tiefe]`, jede neue Änderung kappt den Redo-Rest.
//!
//! Umgebung: `FUZZ_STEPS` (Schritte je Episode, 200), `FUZZ_EPISODES` (je Beispiel, 4), `FUZZ_SEED`,
//! `FUZZ_DERIVE` (alle n Schritte tiefe Prüfung, 6), `FUZZ_ONLY` (beispiel|wettbewerb|gross), `FUZZ_TRACE=1`.

use super::*;
use dossier_core::ops::{validate_project, COALESCE_WINDOW_MS};
use dossier_core::project_refs::dangling_refs;
use std::collections::BTreeSet;

type Path = Vec<String>;

/// Blätter eines JSON-Werts (Zahl/Bool/Text) mit Pfad; ohne `id`/`type` der obersten Ebene.
fn leaves(v: &Value, path: &mut Path, out: &mut Vec<Path>) {
    match v {
        Value::Number(_) | Value::Bool(_) | Value::String(_) => out.push(path.clone()),
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate().take(64) {
                path.push(i.to_string());
                leaves(x, path, out);
                path.pop();
            }
        }
        Value::Object(o) => {
            for (k, x) in o {
                if path.is_empty() && (k == "id" || k == "type") {
                    continue;
                }
                path.push(k.clone());
                leaves(x, path, out);
                path.pop();
            }
        }
        Value::Null => {}
    }
}

fn get_path<'a>(v: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut cur = v;
    for p in path {
        cur = match cur {
            Value::Array(a) => a.get(p.parse::<usize>().ok()?)?,
            Value::Object(o) => o.get(p)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn shift_xy(v: &mut Value, dx: f64, dy: f64) {
    match v {
        Value::Object(o) => {
            if let (Some(x), Some(y)) = (o.get("x").and_then(Value::as_f64), o.get("y").and_then(Value::as_f64)) {
                o.insert("x".into(), json!(x + dx));
                o.insert("y".into(), json!(y + dy));
            }
            for (_, x) in o.iter_mut() {
                shift_xy(x, dx, dy);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| shift_xy(x, dx, dy)),
        _ => {}
    }
}

/// Listen mit id-tragenden Objekten (die Sammlungen, auf denen die Op-Arten arbeiten).
fn entity_cols(root: &Map<String, Value>) -> Vec<String> {
    root.iter()
        .filter(|(_, v)| v.as_array().is_some_and(|a| !a.is_empty() && a.iter().all(|e| e.get("id").and_then(Value::as_str).is_some())))
        .map(|(k, _)| k.clone())
        .collect()
}

fn ref_key(k: &str) -> bool {
    k.ends_with("Id") || k.ends_with("Ids")
}

struct Gen {
    rng: Rng,
    n: usize,
}

type Step = Option<(String, Vec<Value>)>;

impl Gen {
    fn fresh_id(&mut self) -> String {
        self.n += 1;
        format!("fz{}", self.n)
    }

    /// Eine Zahl: meist nahe am Alten, gelegentlich Randwert (0, winzig, negativ, gross, aber endlich).
    fn number(&mut self, old: &serde_json::Number) -> Value {
        let integer = old.is_i64() || old.is_u64();
        let x = old.as_f64().unwrap_or(0.0);
        let v = match self.rng.below(10) {
            0 => 0.0,
            1 => -x,
            2 => 1e-6,
            3 => x * 2.0,
            4 => x * 0.5,
            5 => x + (self.rng.unit() - 0.5) * 4.0,
            6 => 1e5,
            7 => x.round(),
            _ => x + (self.rng.unit() - 0.5) * 0.4,
        };
        if integer {
            // Zähler/Indizes: klein bleiben (Treppen mit 1e5 Stufen sind kein Realfall, sondern Speicherfresser).
            json!((v.round().clamp(-8.0, 64.0)) as i64)
        } else if v.abs() > 5e5 {
            json!(x)
        } else {
            json!(v)
        }
    }

    fn pick<'a>(&mut self, root: &'a Map<String, Value>, cols: &[String]) -> Option<(String, &'a Value)> {
        let c = cols.get(self.rng.below(cols.len()))?.clone();
        let a = root.get(&c)?.as_array()?;
        let e = a.get(self.rng.below(a.len()))?;
        Some((c, e))
    }

    /// Ein anderer Wert für ein Verweis-Feld: id eines Elements derselben Sammlung wie der alte Wert.
    fn other_ref(&mut self, root: &Map<String, Value>, old: &str) -> Option<String> {
        let (_, list) = root.iter().find(|(_, v)| v.as_array().is_some_and(|a| a.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(old))))?;
        let a = list.as_array()?;
        a.get(self.rng.below(a.len()))?.get("id")?.as_str().map(String::from)
    }

    fn patch(&mut self, root: &Map<String, Value>, cols: &[String]) -> Step {
        let (c, e) = self.pick(root, cols)?;
        let mut e = e.clone();
        let mut paths = Vec::new();
        leaves(&e, &mut Vec::new(), &mut paths);
        // Mehrere Felder auf einmal (ein Regler/Dialog ändert oft mehrere).
        let k = 1 + self.rng.below(3);
        let mut what = String::new();
        for _ in 0..k {
            let path = paths.get(self.rng.below(paths.len().max(1)))?.clone();
            let cur = get_path(&e, &path)?.clone();
            let new = match &cur {
                Value::Number(n) => self.number(n),
                Value::Bool(b) => json!(!b),
                Value::String(s) if path.last().is_some_and(|l| ref_key(l)) => json!(self.other_ref(root, s).unwrap_or_else(|| s.clone())),
                Value::String(s) if path.last().is_some_and(|l| l == "name" || l == "label" || l == "text") => json!(format!("{s}~{}", self.rng.below(100))),
                _ => continue,
            };
            set_path(&mut e, &path, new.clone());
            what += &format!(" .{}={new}", path.join("."));
        }
        let id = e.get("id")?.as_str()?.to_string();
        Some((format!("patch {c}/{id}{what}"), vec![json!({"kind": "replace", "collection": c, "entity": e})]))
    }

    fn add(&mut self, root: &Map<String, Value>, cols: &[String]) -> Step {
        let (c, e) = self.pick(root, cols)?;
        let len = root.get(&c)?.as_array()?.len();
        let n = if self.rng.below(5) == 0 { 2 + self.rng.below(3) } else { 1 };
        let (dx, dy) = ((self.rng.unit() - 0.5) * 20.0, (self.rng.unit() - 0.5) * 20.0);
        let mut items = Vec::new();
        for _ in 0..n {
            let mut x = e.clone();
            x["id"] = json!(self.fresh_id());
            shift_xy(&mut x, dx, dy);
            items.push(x);
        }
        let at = [None, Some(0), Some(len / 2), Some(len), Some(len + 7)][self.rng.below(5)];
        let mut op = json!({"kind": "add", "collection": c, "items": items});
        if let Some(a) = at {
            op["at"] = json!(a);
        }
        Some((format!("add {n}x {c} at {at:?}"), vec![op]))
    }

    /// Entfernen samt Abhängigen (wie die App: Wand + ihre Öffnungen, Geschoss + sein Inhalt, Mitglieder aus Gruppen).
    fn remove(&mut self, root: &Map<String, Value>, cols: &[String]) -> Step {
        let (c, e) = self.pick(root, cols)?;
        let id = e.get("id")?.as_str()?.to_string();
        let mut gone: Vec<(String, String)> = vec![(c.clone(), id.clone())];
        let mut patches: BTreeSet<(String, String)> = BTreeSet::new();
        let mut i = 0;
        while i < gone.len() && gone.len() < 400 {
            let target = gone[i].1.clone();
            i += 1;
            for col in cols {
                for x in root.get(col).and_then(Value::as_array).into_iter().flatten() {
                    let xid = x.get("id").and_then(Value::as_str).unwrap_or("");
                    if gone.iter().any(|g| g.0 == *col && g.1 == xid) {
                        continue;
                    }
                    let Some(o) = x.as_object() else { continue };
                    let (mut hit_scalar, mut hit_array) = (false, false);
                    for (k, v) in o {
                        if !ref_key(k) {
                            continue;
                        }
                        match v {
                            Value::String(s) if *s == target => hit_scalar = true,
                            Value::Array(a) if a.iter().any(|y| y.as_str() == Some(&target)) => hit_array = true,
                            _ => {}
                        }
                    }
                    if hit_scalar {
                        gone.push((col.clone(), xid.to_string()));
                    } else if hit_array {
                        patches.insert((col.clone(), xid.to_string()));
                    }
                }
            }
        }
        let mut ops: Vec<Value> = Vec::new();
        let dropped: BTreeSet<&str> = gone.iter().map(|g| g.1.as_str()).collect();
        // Gruppen und Ähnliches: Verweise aus Listen streichen (im selben Schritt, Undo bringt beides zurück).
        for (col, pid) in &patches {
            if gone.iter().any(|g| g.0 == *col && g.1 == *pid) {
                continue;
            }
            let Some(x) = root.get(col).and_then(Value::as_array).and_then(|a| a.iter().find(|x| x.get("id").and_then(Value::as_str) == Some(pid))) else { continue };
            let mut x = x.clone();
            if let Some(o) = x.as_object_mut() {
                for (k, v) in o.iter_mut() {
                    if let (true, Value::Array(a)) = (ref_key(k), &mut *v) {
                        a.retain(|y| y.as_str().is_none_or(|s| !dropped.contains(s)));
                    }
                }
            }
            ops.push(json!({"kind": "replace", "collection": col, "entity": x}));
        }
        let mut by_col: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (col, gid) in &gone {
            by_col.entry(col).or_default().push(gid);
        }
        for (col, ids) in by_col {
            ops.push(json!({"kind": "remove", "collection": col, "ids": ids}));
        }
        Some((format!("remove {c}/{id} (+{} abhängig)", gone.len() - 1), ops))
    }

    fn reorder(&mut self, root: &Map<String, Value>, cols: &[String]) -> Step {
        let c = cols.get(self.rng.below(cols.len()))?.clone();
        let mut ids = ids_of(root, &c);
        for i in (1..ids.len()).rev() {
            ids.swap(i, self.rng.below(i + 1));
        }
        // Teilmenge nennen: der Rest folgt dahinter.
        if self.rng.below(2) == 0 {
            ids.truncate(1 + self.rng.below(ids.len().max(1)));
        }
        Some((format!("reorder {c} ({} ids)", ids.len()), vec![json!({"kind": "reorder", "collection": c, "ids": ids})]))
    }

    fn set_field(&mut self, root: &Map<String, Value>) -> Step {
        match self.rng.below(7) {
            // Ebenen/Klassen (Liste ohne id): sichtbar/gesperrt/Strichstärke, neue Klasse.
            0 | 1 => {
                let mut layers = root.get("layers")?.as_array()?.clone();
                let i = self.rng.below(layers.len().max(1));
                if self.rng.below(4) == 0 {
                    let code = format!("9{}", self.rng.below(90) + 10);
                    if layers.iter().any(|l| l.get("code").and_then(Value::as_str) == Some(&code)) {
                        return None;
                    }
                    layers.push(json!({"code": code, "name": "Fuzz", "color": "#336699", "lw": 0.25, "visible": true, "locked": false}));
                } else {
                    let l = layers.get_mut(i)?.as_object_mut()?;
                    match self.rng.below(3) {
                        0 => {
                            let v = l.get("visible").and_then(Value::as_bool).unwrap_or(true);
                            l.insert("visible".into(), json!(!v));
                        }
                        1 => {
                            let v = l.get("locked").and_then(Value::as_bool).unwrap_or(false);
                            l.insert("locked".into(), json!(!v));
                        }
                        _ => {
                            let lw = [0.0, 0.05, 0.13, 0.5, 2.0][self.rng.below(5)];
                            l.insert("lw".into(), json!(lw));
                        }
                    }
                }
                Some(("setField layers".into(), vec![json!({"kind": "setField", "key": "layers", "value": layers})]))
            }
            // Skalare Felder.
            2 => {
                let keys: Vec<&String> = root.iter().filter(|(k, v)| !matches!(k.as_str(), "id" | "formatVersion") && (v.is_number() || v.is_boolean() || v.is_string())).map(|(k, _)| k).collect();
                let k = (*keys.get(self.rng.below(keys.len().max(1)))?).clone();
                let v = match root.get(&k)? {
                    Value::Number(n) => self.number(n),
                    Value::Bool(b) => json!(!b),
                    Value::String(s) => json!(format!("{s}~{}", self.rng.below(100))),
                    _ => return None,
                };
                Some((format!("setField {k} = {v}"), vec![json!({"kind": "setField", "key": k, "value": v})]))
            }
            // Verschachtelte Objekte (Kontext, Baurecht, Sonnenstudie …): ein Blatt ändern.
            3 | 4 => {
                let keys: Vec<&String> = root.iter().filter(|(k, v)| v.is_object() && k.as_str() != "uiState").map(|(k, _)| k).collect();
                let k = (*keys.get(self.rng.below(keys.len().max(1)))?).clone();
                let mut o = root.get(&k)?.clone();
                let mut paths = Vec::new();
                leaves(&o, &mut Vec::new(), &mut paths);
                let path = paths.get(self.rng.below(paths.len().max(1)))?.clone();
                let new = match get_path(&o, &path)? {
                    Value::Number(n) => self.number(n),
                    Value::Bool(b) => json!(!b),
                    _ => return None,
                };
                set_path(&mut o, &path, new.clone());
                Some((format!("setField {k}.{} = {new}", path.join(".")), vec![json!({"kind": "setField", "key": k, "value": o})]))
            }
            // Neues Feld an einer Position (Undo muss die Feld-Reihenfolge halten) …
            5 => {
                let at = self.rng.below(root.len() + 1);
                let v = json!(self.rng.below(1000));
                Some((format!("setField fuzzNote at {at}"), vec![json!({"kind": "setField", "key": "fuzzNote", "value": v, "at": at})]))
            }
            // … wieder entfernen, sonst eine ganze Liste kürzen.
            _ => {
                if root.contains_key("fuzzNote") {
                    Some(("setField fuzzNote entfernt".into(), vec![json!({"kind": "setField", "key": "fuzzNote"})]))
                } else {
                    let cols = entity_cols(root);
                    let c = cols.get(self.rng.below(cols.len().max(1)))?.clone();
                    let mut a = root.get(&c)?.as_array()?.clone();
                    a.truncate(a.len().saturating_sub(1));
                    Some((format!("setField {c} um 1 gekürzt"), vec![json!({"kind": "setField", "key": c, "value": a})]))
                }
            }
        }
    }

    /// Neue Gruppe über vorhandene Elemente (das Beispiel hat keine).
    fn group(&mut self, root: &Map<String, Value>) -> Step {
        let pick_ids = |g: &mut Gen, col: &str| -> Vec<String> {
            let ids = ids_of(root, col);
            if ids.is_empty() {
                return vec![];
            }
            (0..1 + g.rng.below(3)).map(|_| ids[g.rng.below(ids.len())].clone()).collect::<BTreeSet<_>>().into_iter().collect()
        };
        let gid = self.fresh_id();
        let g = json!({
            "id": gid, "name": "Fuzz-Gruppe",
            "wallIds": pick_ids(self, "walls"), "drawingIds": pick_ids(self, "drawings2d"), "ceilingIds": [], "roomIds": pick_ids(self, "rooms"),
            "stairIds": [], "columnIds": [], "roofIds": [], "openingIds": pick_ids(self, "openings"), "groupIds": []
        });
        Some((format!("add groups/{gid}"), vec![json!({"kind": "add", "collection": "groups", "items": [g]})]))
    }

    /// Abhängige Op-Folgen in einem Commit (die Reihenfolge innerhalb eines Schritts muss stimmen).
    fn combo(&mut self, root: &Map<String, Value>, cols: &[String]) -> Step {
        let (c, e) = self.pick(root, cols)?;
        let mut x = e.clone();
        let nid = self.fresh_id();
        x["id"] = json!(nid);
        let mut y = x.clone();
        let mut paths = Vec::new();
        leaves(&y, &mut Vec::new(), &mut paths);
        if let Some(p) = paths.get(self.rng.below(paths.len().max(1))) {
            if let Some(Value::Number(n)) = get_path(&y, p).cloned() {
                let v = self.number(&n);
                set_path(&mut y, p, v);
            }
        }
        let add = json!({"kind": "add", "collection": c, "items": [x]});
        let rep = json!({"kind": "replace", "collection": c, "entity": y});
        let rem = json!({"kind": "remove", "collection": c, "ids": [nid]});
        let (name, ops) = match self.rng.below(5) {
            0 => ("add+replace", vec![add, rep]),
            1 => ("add+remove", vec![add, rem]),
            2 => ("add+replace+remove", vec![add, rep, rem]),
            // Replace eines unbekannten Elements hängt an; Undo entfernt es.
            3 => ("replace(neu)", vec![rep]),
            _ => ("replace(neu)+remove", vec![rep, rem]),
        };
        Some((format!("combo {name} {c}/{nid}"), ops))
    }

    fn step(&mut self, root: &Map<String, Value>) -> Step {
        let cols = entity_cols(root);
        if cols.is_empty() {
            return None;
        }
        match self.rng.below(100) {
            0..=34 => self.patch(root, &cols),
            35..=48 => self.add(root, &cols),
            49..=60 => self.remove(root, &cols),
            61..=66 => self.reorder(root, &cols),
            67..=80 => self.set_field(root),
            81..=86 => self.group(root),
            _ => self.combo(root, &cols),
        }
    }
}

// ── Lauf ─────────────────────────────────────────────────────────────────────

struct Model {
    /// Dokument-JSON je Undo-Tiefe (Redo-Rest dahinter).
    snaps: Vec<String>,
    /// Schlüssel und Zeit der letzten aufgezeichneten Änderung (Koaleszenz, s. `History::record`).
    last: Option<(String, f64)>,
    /// Hängende Verweise, die schon im Ausgangsstand da waren.
    baseline: BTreeSet<String>,
}

fn dangling(d: &mut Document) -> BTreeSet<String> {
    match d.project() {
        Ok(p) => dangling_refs(p).into_iter().collect(),
        Err(_) => BTreeSet::new(),
    }
}

struct Ctx<'a> {
    name: &'a str,
    fails: &'a mut Fails,
    problems: Vec<String>,
    stats: BTreeMap<&'static str, usize>,
    trace: bool,
}

impl Ctx<'_> {
    fn problem(&mut self, tag: &str, msg: String) {
        if self.problems.len() < 40 {
            self.problems.push(format!("{tag}: {msg}"));
        }
    }
    fn count(&mut self, k: &'static str) {
        *self.stats.entry(k).or_default() += 1;
    }
}

/// JSON-Gleichheit, Zahlen nach Wert (die Datei schreibt `0.0` als `0`; beides ist dieselbe Zahl).
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().zip(y.iter()).all(|((k, p), (l, q))| k == l && json_eq(p, q)),
        _ => a == b,
    }
}

/// Ort des ersten Unterschieds zweier Texte.
fn first_diff(a: &str, b: &str) -> String {
    let i = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    let from = i.saturating_sub(60);
    let cut = |s: &str| s.get(from..(i + 80).min(s.len())).unwrap_or("?").to_string();
    format!("erster Unterschied bei Byte {i}: …{}… gegen …{}…", cut(a), cut(b))
}

/// Dokument gegen den Stand `snaps[tiefe]` prüfen.
fn expect_state(cx: &mut Ctx, d: &Document, m: &Model, tag: &str, what: &str) {
    let depth = d.history().undo_depth();
    let Some(want) = m.snaps.get(depth) else {
        cx.problem(tag, format!("{what}: Undo-Tiefe {depth} ausserhalb des Modells ({})", m.snaps.len()));
        return;
    };
    let now = d.to_json();
    if now != *want {
        cx.problem(tag, format!("{what}: Dokument weicht vom Stand bei Tiefe {depth} ab; {}", first_diff(&now, want)));
    }
}

/// Invarianten, die nach jedem Schritt gelten.
fn check_light(cx: &mut Ctx, d: &mut Document, m: &Model, tag: &str) {
    let v = validate_project(d.root());
    if !v.is_empty() {
        cx.problem(tag, format!("Projekt ungültig: {}", v[0]));
    }
    let now = dangling(d);
    if let Some(new) = now.difference(&m.baseline).next() {
        cx.problem(tag, format!("neuer hängender Verweis: {new}"));
    }
}

/// Teure Invarianten: Cache-Kohärenz, Speichern/Laden, Ableitungen.
fn check_deep(cx: &mut Ctx, d: &mut Document, tag: &str) {
    // Frisch aus dem JSON gelesenes Dokument gegen das fortgeschriebene (typisierte Sicht, Pläne, 3D, Kennzahlen).
    let text = d.to_json();
    let Ok(mut fresh) = Document::from_json(&text) else {
        cx.problem(tag, "to_json() lässt sich nicht wieder lesen".into());
        return;
    };
    let a = cx.fails.run(|| format!("{tag} typed"), || d.project().ok().and_then(|p| serde_json::to_string(p).ok())).flatten();
    let b = fresh.project().ok().and_then(|p| serde_json::to_string(p).ok());
    if a != b {
        cx.problem(tag, format!("typisierte Sicht des fortgeschriebenen Dokuments weicht vom frisch gelesenen ab: {}", first_diff(a.as_deref().unwrap_or("-"), b.as_deref().unwrap_or("-"))));
    }
    let floors: Vec<String> = d.project().map(|p| p.drawing_levels.iter().filter(|l| l.kind == dossier_core::model::DrawingLevelKind::Floor).map(|l| l.id.clone()).take(2).collect()).unwrap_or_default();
    for fl in floors {
        let t = d.project().map(|p| plan_text(p, &fl, 100.0, json!({}))).unwrap_or_default();
        let x = cx.fails.run(|| format!("{tag} Grundriss {fl}"), || dossier_core::queries::run_bin_doc(d, "planDomains", &[1.0], &t));
        let y = dossier_core::queries::run_bin_doc(&mut fresh, "planDomains", &[1.0], &t);
        if let (Some(Ok(x)), Ok(y)) = (x, y) {
            // Der Cache lässt Reste in den Tabellen stehen (Verschnitt, s. `plan::cache`): Bytes sind kein Mass,
            // der Inhalt (als SVG) muss gleich sein.
            let (sx, sy) = (svg_of(&x), svg_of(&y));
            if sx != sy {
                cx.problem(tag, format!("Grundriss {fl}: fortgeschriebenes Dokument liefert anderen Plan als frisch gelesenes; {}", first_diff(sx.as_deref().unwrap_or("-"), sy.as_deref().unwrap_or("-"))));
            }
        }
    }
    for (q, args) in [("kennzahlen", vec![]), ("model3dParts", vec![0.0, 1.0, 0.0, 1.0])] {
        let x = cx.fails.run(|| format!("{tag} {q}"), || dossier_core::queries::run_doc(d, q, &args, ""));
        let y = dossier_core::queries::run_doc(&mut fresh, q, &args, "");
        if let Some(x) = x {
            if format!("{x:?}") != format!("{y:?}") {
                cx.problem(tag, format!("Abfrage {q}: fortgeschriebenes Dokument liefert anderes Ergebnis als frisch gelesenes"));
            }
        }
    }
    // Speichern → Laden.
    let saved = d.serialize();
    match open(&saved) {
        Ok(back) => {
            let (a, b) = (d.root(), back.root());
            // (Die Datei schreibt `formatVersion` zuerst; die Reihenfolge der Wurzelfelder im Speicher ist davon frei.)
            let same = a.len() == b.len() && a.iter().all(|(k, p)| b.get(k).is_some_and(|q| json_eq(p, q)));
            if !same {
                let ka: BTreeSet<&String> = a.keys().collect();
                let kb: BTreeSet<&String> = b.keys().collect();
                let diff: Vec<&String> = a.keys().filter(|k| !b.get(*k).is_some_and(|y| json_eq(&a[*k], y))).collect();
                let order: Vec<&String> = a.keys().filter(|k| b.get(*k).is_some_and(|y| json_eq(&a[*k], y) && a[*k].to_string() != y.to_string())).collect();
                let detail = diff.first().map(|k| first_diff(&a[*k].to_string(), &b.get(*k).map(|v| v.to_string()).unwrap_or_default())).or_else(|| order.first().map(|k| format!("Feld {k}: {}", first_diff(&a[*k].to_string(), &b[*k].to_string())))).unwrap_or_else(|| "Reihenfolge der Wurzelfelder".to_string());
                cx.problem(tag, format!("Speichern → Laden ergibt anderes Dokument (Felder: {diff:?}, nur vorher: {:?}, nur nachher: {:?}); {detail}", ka.difference(&kb).collect::<Vec<_>>(), kb.difference(&ka).collect::<Vec<_>>()));
            }
        }
        Err(e) => cx.problem(tag, format!("gespeichertes Dokument lässt sich nicht laden: {e}")),
    }
    derive_all(d, tag, Depth::Light, cx.fails);
}

/// SVG eines Plan-Puffers (feste Ausschnitt-Wahl), zum inhaltlichen Vergleich zweier Puffer.
fn svg_of(b: &[u8]) -> Option<String> {
    let mut parts = parts_of(b)?;
    let o = dossier_core::plan::svg::SvgOptions { scale_denominator: 100.0, margin_m: 0.5, min_x: -50.0, min_y: -50.0, max_x: 50.0, max_y: 50.0, hatch: false, line_ends: Default::default() };
    dossier_core::plan::svg::plan_svg(&mut parts, &o)
}

fn fresh_doc(text: &str) -> Document {
    let mut d = open(text).expect("Beispiel lädt");
    d.history_mut().max_steps = usize::MAX / 2;
    d.history_mut().max_bytes = usize::MAX / 2;
    d
}

/// Nach einer angenommenen Änderung das Modell nachführen (Tiefe unverändert = verschmolzen).
fn settle(m: &mut Model, d: &Document) {
    m.snaps.truncate(d.history().undo_depth());
    m.snaps.push(d.to_json());
}

fn parse_ops(ops: &[Value]) -> Option<Vec<Op>> {
    ops.iter().map(Op::from_json).collect::<Result<Vec<_>, _>>().ok()
}

/// Trockenlauf auf einer Kopie: die Ops dürfen keine neuen hängenden Verweise erzeugen (die App tut das auch
/// nicht). Ops, die der Kern ablehnt, lässt der Fuzzer durch (der Commit muss sie sauber ablehnen).
fn safe_to_apply(d: &mut Document, ops: &[Op], baseline: &BTreeSet<String>) -> bool {
    let mut t = d.clone();
    if t.apply(ops).is_err() {
        return true;
    }
    dangling(&mut t).difference(baseline).next().is_none()
}

fn run_episode(name: &str, text: &str, steps: usize, seed: u64, deep_every: usize, fails: &mut Fails) -> (Vec<String>, BTreeMap<&'static str, usize>) {
    let mut d = fresh_doc(text);
    let mut g = Gen { rng: Rng(seed | 1), n: 0 };
    let mut m = Model { snaps: vec![d.to_json()], last: None, baseline: dangling(&mut d) };
    let mut cx = Ctx { name, fails, problems: Vec::new(), stats: BTreeMap::new(), trace: std::env::var("FUZZ_TRACE").is_ok() };
    let initial = m.snaps[0].clone();
    let mut now = 1.0e12;

    for i in 0..steps {
        let tag = format!("{} seed {seed} Schritt {i}", cx.name);
        let depth0 = d.history().undo_depth();
        let redo0 = d.history().redo_depth();
        let before = d.to_json();
        let kind = g.rng.below(20);
        let desc;
        // Ein Sprung auf die eigene Tiefe tut nichts (auch am Koaleszenz-Zustand nicht).
        let mut keep_last = false;
        match kind {
            // Undo / Redo / Springen.
            0..=3 => {
                let r = g.rng.below(8);
                if r < 3 {
                    desc = "undo".to_string();
                    if let Some(got) = cx.fails.run(|| format!("{tag} undo"), || d.undo()) {
                        if got.is_some() != (depth0 > 0) {
                            cx.problem(&tag, format!("undo meldet {} bei Tiefe {depth0}", got.is_some()));
                        }
                    }
                    cx.count("undo");
                } else if r < 6 {
                    desc = "redo".to_string();
                    if let Some(got) = cx.fails.run(|| format!("{tag} redo"), || d.redo()) {
                        if got.is_some() != (redo0 > 0) {
                            cx.problem(&tag, format!("redo meldet {} bei Redo-Tiefe {redo0}", got.is_some()));
                        }
                    }
                    cx.count("redo");
                } else {
                    let target = g.rng.below(depth0 + redo0 + 1);
                    desc = format!("jump {depth0} -> {target}");
                    if let Some(got) = cx.fails.run(|| format!("{tag} {desc}"), || d.history_jump(target)) {
                        if got.is_some() != (target != depth0) {
                            cx.problem(&tag, format!("history_jump meldet {} ({depth0} -> {target})", got.is_some()));
                        }
                    }
                    keep_last = target == depth0;
                    cx.count("jump");
                }
                if !keep_last {
                    m.last = None;
                }
                if d.history().undo_depth() + d.history().redo_depth() != depth0 + redo0 {
                    cx.problem(&tag, format!("Undo/Redo ändert die Gesamttiefe ({depth0}+{redo0} -> {}+{})", d.history().undo_depth(), d.history().redo_depth()));
                }
                expect_state(&mut cx, &d, &m, &tag, &desc);
            }
            // Gruppe: mehrere Commits = ein Undo-Schritt (auch mit Schlüssel).
            4..=7 => {
                let key = (g.rng.below(3) == 0).then_some("fuzz-zug");
                now += if g.rng.below(2) == 0 { 50.0 } else { 1000.0 };
                let expect_merge = key.is_some() && m.last.as_ref().is_some_and(|(k, t)| Some(k.as_str()) == key && now - t < COALESCE_WINDOW_MS) && depth0 > 0;
                d.history_mut().begin_group_keyed(key, now);
                let n = 1 + g.rng.below(4);
                let mut accepted = 0;
                let mut parts = Vec::new();
                for _ in 0..n {
                    let root = d.root().clone();
                    let Some((dsc, ops)) = g.step(&root) else { continue };
                    let Some(ops) = parse_ops(&ops) else { continue };
                    if !safe_to_apply(&mut d, &ops, &m.baseline) {
                        cx.count("verworfen(hängend)");
                        continue;
                    }
                    parts.push(dsc);
                    if let Some(Ok(())) = cx.fails.run(|| format!("{tag} Gruppe: {}", parts.join(" | ")), || d.commit(ops, None, now, false)) {
                        accepted += 1;
                    }
                }
                d.history_mut().end_group();
                desc = format!("Gruppe{} [{}]", if key.is_some() { " (Schlüssel)" } else { "" }, parts.join(" | "));
                let depth1 = d.history().undo_depth();
                let want = if accepted == 0 || expect_merge { depth0 } else { depth0 + 1 };
                if depth1 != want {
                    cx.problem(&tag, format!("{desc}: {accepted} angenommene Commits, Undo-Tiefe {depth0} -> {depth1}, erwartet {want} (Verschmelzung erwartet: {expect_merge})"));
                }
                if accepted > 0 {
                    m.last = key.map(|k| (k.to_string(), now));
                    settle(&mut m, &d);
                    if d.history().redo_depth() != 0 {
                        cx.problem(&tag, "Redo-Rest nach neuer Gruppe nicht gelöscht".into());
                    }
                } else if before != d.to_json() {
                    cx.problem(&tag, "Gruppe ohne angenommenen Commit ändert das Dokument".into());
                }
                cx.count("gruppe");
                expect_state(&mut cx, &d, &m, &tag, &desc);
            }
            // Ungültige Änderung (doppelte id, nicht endliche Zahl, auch als zweite Op hinter einer gültigen):
            // muss als Ganzes abgelehnt werden, ohne Spur im Dokument und im Verlauf.
            8..=9 => {
                let root = d.root().clone();
                let cols = entity_cols(&root);
                let Some((c, e)) = g.pick(&root, &cols) else { continue };
                let (c, e) = (c, e.clone());
                let mut paths = Vec::new();
                leaves(&e, &mut Vec::new(), &mut paths);
                let numeric: Vec<&Path> = paths.iter().filter(|p| get_path(&e, p).is_some_and(Value::is_number)).collect();
                let dup = json!({"kind": "add", "collection": c, "items": [e.clone()]});
                let (what, ops) = match (g.rng.below(3), numeric.get(g.rng.below(numeric.len().max(1)))) {
                    (0, _) | (_, None) => ("doppelte id".to_string(), vec![dup]),
                    (1, Some(p)) => {
                        let mut bad = e.clone();
                        set_path(&mut bad, p, json!(["\u{1}NaN", "\u{1}Infinity", "\u{1}-Infinity"][g.rng.below(3)]));
                        ("nicht endliche Zahl".to_string(), vec![json!({"kind": "replace", "collection": c, "entity": bad})])
                    }
                    (_, Some(_)) => {
                        // Gültige Op davor: die ganze Folge fällt.
                        let Some((_, mut ops)) = g.patch(&root, &cols) else { continue };
                        ops.push(dup);
                        ("gültige Op + doppelte id".to_string(), ops)
                    }
                };
                let Some(ops) = parse_ops(&ops) else { continue };
                desc = format!("ungültig: {what} ({c}/{})", e.get("id").and_then(Value::as_str).unwrap_or("?"));
                now += 1000.0;
                match cx.fails.run(|| format!("{tag}: {desc}"), || d.commit(ops, None, now, true)) {
                    Some(Ok(())) => cx.problem(&tag, format!("{desc}: ungültige Änderung wurde angenommen")),
                    Some(Err(_)) => {
                        cx.count("abgelehnt");
                        if d.to_json() != before {
                            cx.problem(&tag, format!("{desc}: abgelehnt und trotzdem geändert; {}", first_diff(&before, &d.to_json())));
                        }
                        if (d.history().undo_depth(), d.history().redo_depth()) != (depth0, redo0) {
                            cx.problem(&tag, format!("{desc}: abgelehnt und trotzdem Verlauf geändert"));
                        }
                    }
                    None => {
                        d = fresh_doc(&before);
                        m.snaps = vec![before.clone()];
                        m.last = None;
                    }
                }
                expect_state(&mut cx, &d, &m, &tag, &desc);
            }
            // Einzelner Commit, mit/ohne Koaleszenz-Schlüssel.
            _ => {
                let root = d.root().clone();
                let Some((dsc, ops)) = g.step(&root) else { continue };
                let Some(ops) = parse_ops(&ops) else { continue };
                if !safe_to_apply(&mut d, &ops, &m.baseline) {
                    cx.count("verworfen(hängend)");
                    continue;
                }
                let key = (g.rng.below(3) == 0).then_some("fuzz-regler");
                now += if g.rng.below(2) == 0 { 40.0 } else { 1000.0 };
                desc = dsc;
                let expect_merge = key.is_some() && m.last.as_ref().is_some_and(|(k, t)| Some(k.as_str()) == key && now - t < COALESCE_WINDOW_MS) && depth0 > 0;
                match cx.fails.run(|| format!("{tag}: {desc}"), || d.commit(ops, key, now, false)) {
                    Some(Ok(())) => {
                        cx.count("angenommen");
                        let depth1 = d.history().undo_depth();
                        let want = if expect_merge { depth0 } else { depth0 + 1 };
                        if depth1 != want {
                            cx.problem(&tag, format!("{desc}: Undo-Tiefe {depth0} -> {depth1}, erwartet {want} (Schlüssel {key:?}, Verschmelzung erwartet: {expect_merge})"));
                        }
                        if d.history().redo_depth() != 0 {
                            cx.problem(&tag, format!("{desc}: Redo-Rest nach neuer Änderung nicht gelöscht"));
                        }
                        m.last = key.map(|k| (k.to_string(), now));
                        settle(&mut m, &d);
                    }
                    Some(Err(e)) => {
                        // Abgelehnte Op: nichts darf sich ändern.
                        cx.count("abgelehnt");
                        if d.to_json() != before {
                            cx.problem(&tag, format!("{desc}: abgelehnt ({}) und trotzdem geändert; {}", e.first().cloned().unwrap_or_default(), first_diff(&before, &d.to_json())));
                        }
                        if (d.history().undo_depth(), d.history().redo_depth()) != (depth0, redo0) {
                            cx.problem(&tag, format!("{desc}: abgelehnt und trotzdem Verlauf geändert"));
                        }
                    }
                    None => {
                        // Panic: mit dem Stand davor neu beginnen.
                        d = fresh_doc(&before);
                        m.snaps = vec![before.clone()];
                        m.last = None;
                    }
                }
                expect_state(&mut cx, &d, &m, &tag, &desc);
            }
        }
        if cx.trace {
            eprintln!("{tag}: {desc} (Tiefe {}+{})", d.history().undo_depth(), d.history().redo_depth());
        }
        check_light(&mut cx, &mut d, &m, &format!("{tag}: {desc}"));
        if deep_every > 0 && i % deep_every == deep_every - 1 {
            check_deep(&mut cx, &mut d, &format!("{tag}: {desc}"));
        }
        if cx.problems.len() >= 40 {
            break;
        }
    }

    // Am Ende: bis zum Anfang zurück = Ausgangsdokument; dann Schritt für Schritt vor (jeder Stand wie im
    // Modell), bis zum Ende = Endzustand; und wieder einzeln zurück.
    let tag = format!("{name} seed {seed} Ende");
    let total = d.history().undo_depth() + d.history().redo_depth();
    cx.fails.run(|| format!("{tag} jump 0"), || d.history_jump(0));
    if d.to_json() != initial {
        cx.problem(&tag, format!("Undo bis zum Anfang ergibt nicht das Ausgangsdokument; {}", first_diff(&d.to_json(), &initial)));
    }
    for k in 1..=total {
        cx.fails.run(|| format!("{tag} redo {k}"), || d.redo());
        if m.snaps.get(k).is_none_or(|s| d.to_json() != *s) {
            cx.problem(&tag, format!("Redo {k}/{total} weicht vom Modell ab"));
            break;
        }
    }
    for k in (0..total).rev() {
        cx.fails.run(|| format!("{tag} undo {k}"), || d.undo());
        if m.snaps.get(k).is_none_or(|s| d.to_json() != *s) {
            cx.problem(&tag, format!("Undo auf Tiefe {k} weicht vom Modell ab"));
            break;
        }
    }
    cx.fails.run(|| format!("{tag} jump total"), || d.history_jump(total));
    if m.snaps.get(total).is_none_or(|s| d.to_json() != *s) {
        cx.problem(&tag, "Redo bis zum Ende ergibt nicht den Endzustand".into());
    }
    check_deep(&mut cx, &mut d, &tag);
    (cx.problems, cx.stats)
}

#[test]
fn op_fuzzer() {
    let steps = env_num("FUZZ_STEPS", 200) as usize;
    let eps = env_num("FUZZ_EPISODES", 4);
    let seed0 = env_num("FUZZ_SEED", 0x0F0_F258);
    let deep = env_num("FUZZ_DERIVE", 6) as usize;
    let only = std::env::var("FUZZ_ONLY").ok();
    let mut fails = Fails::default();
    let mut all: Vec<String> = Vec::new();
    // Die grossen Beispiele mit weniger Schritten (sie rechnen länger).
    for (name, text) in FIXTURES.iter().filter(|f| f.0 != "komplex" && only.as_deref().is_none_or(|o| o == f.0)) {
        let n = if *name == "beispiel" { steps } else { (steps / 4).max(10) };
        for e in 0..eps {
            let t0 = std::time::Instant::now();
            let seed = seed0.wrapping_add(e * 7919);
            let (problems, stats) = run_episode(name, text, n, seed, deep, &mut fails);
            eprintln!("Op-Fuzzer {name} Episode {e} (seed {seed}): {stats:?}, {} Befunde, {:.1} s", problems.len(), t0.elapsed().as_secs_f64());
            all.extend(problems);
        }
    }
    let mut msg = String::new();
    if !all.is_empty() {
        msg += &format!("Op-Fuzzer: {} Befunde\n", all.len());
        for p in all.iter().take(30) {
            msg += &format!("  - {p}\n");
        }
    }
    if !fails.0.is_empty() {
        msg += &fails.report("Op-Fuzzer (Panics)");
    }
    assert!(msg.is_empty(), "{msg}");
}
