//! [272] Varianten wie Archicads „Design Options“: Variantensätze (z. B. „Dachform“) mit Varianten (A, B, C …),
//! jedes Element gehört zum Hauptmodell (ohne `designOption`) oder zu genau einer Variante eines Satzes.
//!
//! Hier liegen nur das Modell der **Kombination** (je Satz eine Variante, Vorgabe die Hauptvariante), das Lesen der
//! Anfragen (`"Dachform=B,Fassade=A"` oder `{"Dachform": "B"}`), die Ops zum Bearbeiten (Übernehmen, Löschen,
//! Zuweisen, Kopieren) und der Vergleich der Kennzahlen. **Ob ein Element in einer Darstellung erscheint**, entscheidet
//! weiterhin der eine Ort `renovation.rs` ([`crate::renovation::View`]): er nimmt die Kombination mit auf und blendet
//! Elemente anderer Varianten aus wie die Regel „Ausblenden“ — Grundriss, Schnitt, Ansicht, Axo, 3D, Kennzahlen und
//! Exporte fragen dort.

use crate::model::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};

/// Listen, deren Elemente eine Variante tragen können (Wurzel-Schlüssel).
pub const COLLECTIONS: [&str; 11] = ["walls", "openings", "ceilings", "roofs", "stairs", "columns", "beams", "extrudedSolids", "rooms", "drawings2d", "railings"];

/// Höchstens so viele Kombinationen im Vergleich (Kreuzprodukt der Sätze).
pub const MAX_COMPARE: usize = 24;

/// Variantensätze des Projekts.
pub fn sets(p: &Project) -> &[DesignOptionSet] {
    p.design_option_sets.as_deref().unwrap_or(&[])
}

/// Id der Hauptvariante eines Satzes (`primary`, sonst die erste); `None` ohne Varianten.
pub fn primary_of(s: &DesignOptionSet) -> Option<&str> {
    s.primary.as_deref().filter(|id| s.options.iter().any(|o| o.id == *id)).or_else(|| s.options.first().map(|o| o.id.as_str()))
}

/// Satz nach Id, sonst nach Name (ohne Gross-/Kleinschreibung).
pub fn find_set<'a>(p: &'a Project, key: &str) -> Option<&'a DesignOptionSet> {
    let key = key.trim();
    let low = key.to_lowercase();
    sets(p).iter().find(|s| s.id == key).or_else(|| sets(p).iter().find(|s| s.name.trim().to_lowercase() == low))
}

/// Variante eines Satzes nach Id, sonst nach Name (ohne Gross-/Kleinschreibung).
pub fn find_option<'a>(s: &'a DesignOptionSet, key: &str) -> Option<&'a DesignOption> {
    let key = key.trim();
    let low = key.to_lowercase();
    s.options.iter().find(|o| o.id == key).or_else(|| s.options.iter().find(|o| o.name.trim().to_lowercase() == low))
}

/// Trägt irgendein Element eine Variante eines bekannten Satzes? Sonst ist jede Kombination wirkungslos.
pub fn active(p: &Project) -> bool {
    if sets(p).is_empty() {
        return false;
    }
    let known = |r: Option<&DesignOptionRef>| r.is_some_and(|r| sets(p).iter().any(|s| s.id == r.set));
    p.walls.iter().any(|x| known(x.design_option.as_ref()))
        || p.openings.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.ceilings.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.roofs.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.stairs.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.columns.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.railings.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.beams.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.extruded_solids.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.rooms.iter().flatten().any(|x| known(x.design_option.as_ref()))
        || p.drawings2d.iter().any(|x| known(x.design_option.as_ref()))
}

/// Eine Variantenkombination: je Satz (Id) die gezeigte Variante (Id). Sätze ohne Varianten fehlen.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Combination {
    pub choice: BTreeMap<String, String>,
}

/// Anfrage einer Kombination: Paare (Satz, Variante) als Id oder Name.
pub type Request = Vec<(String, String)>;

/// Liest eine Anfrage: Text `"Dachform=B,Fassade=A"` (auch `;`) oder Objekt `{"Dachform": "B"}`; Unsinn ⇒ leer.
pub fn parse_request(v: Option<&Value>) -> Request {
    match v {
        Some(Value::String(s)) => parse_text(s),
        Some(Value::Object(m)) => m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).filter(|(k, v)| !k.trim().is_empty() && !v.trim().is_empty()).collect(),
        _ => Vec::new(),
    }
}

/// Wie [`parse_request`] für einen Text (CLI `--options`).
pub fn parse_text(s: &str) -> Request {
    s.split([',', ';'])
        .filter_map(|part| {
            let (k, v) = part.split_once('=')?;
            let (k, v) = (k.trim(), v.trim());
            (!k.is_empty() && !v.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

impl Combination {
    /// Hauptvariante je Satz.
    pub fn primary(p: &Project) -> Combination {
        let mut choice = BTreeMap::new();
        for s in sets(p) {
            if let Some(o) = primary_of(s) {
                choice.insert(s.id.clone(), o.to_string());
            }
        }
        Combination { choice }
    }

    /// Kombination einer Darstellung: Hauptvarianten, darüber die gespeicherte Wahl (`level`: Ebene, Vorlage,
    /// Ausschnitt, Viewport — nur gültige Ids), darüber die ausdrückliche Anfrage (Ids oder Namen). Unbekanntes
    /// wird übergangen.
    pub fn resolve(p: &Project, stored: &[&BTreeMap<String, String>], request: &[(String, String)]) -> Combination {
        let mut c = Combination::primary(p);
        for m in stored {
            for (k, v) in m.iter() {
                c.set(p, k, v);
            }
        }
        for (k, v) in request {
            c.set(p, k, v);
        }
        c
    }

    /// Variante `option` (Id/Name) im Satz `set` (Id/Name) wählen; unbekannt ⇒ unverändert.
    pub fn set(&mut self, p: &Project, set: &str, option: &str) {
        if let Some(s) = find_set(p, set) {
            if let Some(o) = find_option(s, option) {
                self.choice.insert(s.id.clone(), o.id.clone());
            }
        }
    }

    /// Erscheint ein Element mit dieser Zugehörigkeit? Ohne Feld oder bei unbekanntem Satz: ja (Hauptmodell).
    pub fn shows(&self, r: Option<&DesignOptionRef>) -> bool {
        match r {
            None => true,
            Some(r) => self.choice.get(&r.set).is_none_or(|o| *o == r.option),
        }
    }

    /// Schlüssel für Caches.
    pub fn key(&self) -> String {
        self.choice.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",")
    }

    /// Sind alle Sätze auf der Hauptvariante?
    pub fn is_primary(&self, p: &Project) -> bool {
        *self == Combination::primary(p)
    }

    /// Lesbarer Name „Dachform B, Fassade A“ (Namen der Sätze und Varianten, Projekt-Reihenfolge).
    pub fn label(&self, p: &Project) -> String {
        let mut parts = Vec::new();
        for s in sets(p) {
            let Some(oid) = self.choice.get(&s.id) else { continue };
            let Some(o) = s.options.iter().find(|o| o.id == *oid) else { continue };
            parts.push(format!("{} {}", s.name.trim(), o.name.trim()).trim().to_string());
        }
        parts.join(", ")
    }

    /// Ausgeblendete Elemente (ids) aller Listen mit Varianten: Elemente anderer Varianten; Öffnungen in
    /// ausgeblendeten Wänden mit.
    pub fn hidden(&self, p: &Project) -> HashSet<String> {
        let mut out = HashSet::new();
        if self.choice.is_empty() {
            return out;
        }
        for w in &p.walls {
            if !self.shows(w.design_option.as_ref()) {
                out.insert(w.id.clone());
            }
        }
        for o in p.openings.iter().flatten() {
            if out.contains(&o.host_wall_id) || !self.shows(o.design_option.as_ref()) {
                out.insert(o.id.clone());
            }
        }
        macro_rules! each {
            ($($f:ident),*) => {$(
                for x in p.$f.iter().flatten() {
                    if !self.shows(x.design_option.as_ref()) {
                        out.insert(x.id.clone());
                    }
                }
            )*};
        }
        each!(ceilings, roofs, stairs, columns, beams, extruded_solids, rooms, railings);
        for d in &p.drawings2d {
            if !self.shows(d.design_option.as_ref()) {
                out.insert(d.id.clone());
            }
        }
        out
    }

    /// Alle Kombinationen (Kreuzprodukt der Sätze, Hauptkombination zuerst), höchstens [`MAX_COMPARE`].
    pub fn all(p: &Project) -> Vec<Combination> {
        let mut out = vec![Combination::default()];
        for s in sets(p).iter().filter(|s| !s.options.is_empty()) {
            let prim = primary_of(s).unwrap_or_default().to_string();
            let mut order: Vec<&str> = vec![prim.as_str()];
            order.extend(s.options.iter().map(|o| o.id.as_str()).filter(|id| *id != prim));
            let mut next = Vec::new();
            for c in &out {
                for o in &order {
                    let mut c = c.clone();
                    c.choice.insert(s.id.clone(), o.to_string());
                    next.push(c);
                    if next.len() >= MAX_COMPARE {
                        break;
                    }
                }
                if next.len() >= MAX_COMPARE {
                    break;
                }
            }
            out = next;
        }
        out
    }
}

// ── Bearbeiten wie im Archicad-Manager ([272] Nachtrag 17.11.: Stift und „grau einfärben“) ───────────────────────

/// Bearbeitungsvariante einer **Bildschirm**-Darstellung (Stift im Panel „Varianten“, Zustand der Sitzung): die Variante
/// ist sichtbar (Stift impliziert Auge, geht der Kombination der Ebene vor), mit `grey` zeichnet die Darstellung alles
/// ausserhalb von ihr (Hauptmodell und andere sichtbare Varianten) grau ([`crate::renovation::ghost_style`]). Kommt nur über
/// das Anfrage-Feld `designOptionEdit` der Bildschirm-Ansichten (Grundriss, Schnitt, Ansicht, Axo, 3D) — Druck, PDF,
/// Exporte, Kennzahlen und Goldens fragen nie damit. Die Sperre („Elemente ausserhalb sperren“) ist reine Auswahl-Logik
/// der Oberfläche (`model/designOptions.ts::designOptionLocked`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub set: String,
    pub option: String,
    pub grey: bool,
    /// [272] Häkchen „ausserhalb sperren“ (nur 3D-Pick, `lock`): Elemente ausserhalb sind im 3D nicht anwählbar.
    pub lock: bool,
    /// [272] 3D-Fenster: das Grau kommt als durchscheinende Geisterschicht (`model3d::ClassFilter`, render3d), nicht als
    /// helle Teilefarbe ([`crate::renovation::View::resolve`] färbt dann nicht).
    pub layer: bool,
}

/// Liest `{"set", "option", "grey", "lock", "layer"}` (Ids oder Namen); unbekannter Satz/Variante oder Unsinn ⇒ `None`.
pub fn parse_edit(p: &Project, v: Option<&Value>) -> Option<Edit> {
    let v = v?.as_object()?;
    let s = find_set(p, v.get("set")?.as_str()?)?;
    let o = find_option(s, v.get("option")?.as_str()?)?;
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    Some(Edit { set: s.id.clone(), option: o.id.clone(), grey: flag("grey"), lock: flag("lock"), layer: flag("layer") })
}

impl Edit {
    /// Gehört ein Element mit dieser Zugehörigkeit zur Bearbeitungsvariante?
    pub fn holds(&self, r: Option<&DesignOptionRef>) -> bool {
        r.is_some_and(|r| r.set == self.set && r.option == self.option)
    }

    /// Ids aller Elemente ausserhalb der Bearbeitungsvariante (Öffnung ohne eigene Variante folgt ihrer Wand).
    pub fn outside(&self, p: &Project) -> HashSet<String> {
        let mut out = HashSet::new();
        for w in &p.walls {
            if !self.holds(w.design_option.as_ref()) {
                out.insert(w.id.clone());
            }
        }
        for o in p.openings.iter().flatten() {
            let r = o.design_option.as_ref().or_else(|| p.walls.iter().find(|w| w.id == o.host_wall_id).and_then(|w| w.design_option.as_ref()));
            if !self.holds(r) {
                out.insert(o.id.clone());
            }
        }
        macro_rules! each {
            ($($f:ident),*) => {$(
                for x in p.$f.iter().flatten() {
                    if !self.holds(x.design_option.as_ref()) {
                        out.insert(x.id.clone());
                    }
                }
            )*};
        }
        each!(ceilings, roofs, stairs, columns, beams, extruded_solids, rooms, railings);
        // 2D-Elemente (Möbel, Linien, Masse, Texte): nur die, die einer anderen Variante angehören — ohne Zugehörigkeit
        // stehen sie im Hauptmodell, wo sie nicht grau werden (sonst wäre jede Beschriftung grau).
        for d in &p.drawings2d {
            if d.design_option.is_some() && !self.holds(d.design_option.as_ref()) {
                out.insert(d.id.clone());
            }
        }
        out
    }

    /// Ids der Elemente, die bei „ausserhalb sperren“ im 3D nicht anwählbar sind: alles ausserhalb ([`Self::outside`]),
    /// alle 2D-Elemente ohne die Bearbeitungsvariante, Bäume und Kontext (wie `designOptionLocked` der Auswahl).
    pub fn locked(&self, p: &Project) -> HashSet<String> {
        let mut out = self.outside(p);
        out.extend(p.drawings2d.iter().filter(|d| !self.holds(d.design_option.as_ref())).map(|d| d.id.clone()));
        out.extend(p.trees.iter().flatten().map(|t| t.id.clone()));
        out.extend(p.context.iter().flatten().map(|c| c.id().to_string()));
        out
    }

    /// Schlüssel für Caches.
    pub fn key(&self) -> String {
        format!("{}={}{}{}", self.set, self.option, if self.grey { ":grey" } else { "" }, if self.layer { ":layer" } else { "" })
    }
}

/// Gespeicherte Wahl einer Ebene ([`stored_choice`]; über die verknüpfte Vorlage hat sie schon `level_with_template`).
pub fn level_choice(p: &Project, level_id: &str) -> Option<BTreeMap<String, String>> {
    p.floor(level_id).and_then(|l| stored_choice(p, l.design_option_combination.as_deref(), l.design_options.as_ref()))
}

// ── Benannte Kombinationen ([272] Nachtrag, Archicad „Design Option Combinations“) ───────────────────────────────

/// Benannte Variantenkombinationen des Projekts.
pub fn combinations(p: &Project) -> &[DesignOptionCombination] {
    p.design_option_combinations.as_deref().unwrap_or(&[])
}

/// Kombination nach Id, sonst nach Name (ohne Gross-/Kleinschreibung).
pub fn find_combination<'a>(p: &'a Project, key: &str) -> Option<&'a DesignOptionCombination> {
    let key = key.trim();
    let low = key.to_lowercase();
    combinations(p).iter().find(|c| c.id == key).or_else(|| combinations(p).iter().find(|c| c.name.trim().to_lowercase() == low))
}

/// Vollständige Wahl einer benannten Kombination: je Satz die gespeicherte Variante, sonst (fehlender Satz, gelöschte
/// Variante) die Hauptvariante.
pub fn combination_choice(p: &Project, c: &DesignOptionCombination) -> Combination {
    Combination::resolve(p, &[&c.choices], &[])
}

/// **Rangfolge der gespeicherten Wahl eines Objekts** (Ebene, Vorlage, Ausschnitt, Viewport): Verweist es auf eine
/// vorhandene benannte Kombination (`designOptionCombination`, Id), gilt diese vollständig — fehlende Sätze zeigen die
/// Hauptvariante — und die freie Wahl `designOptions` desselben Objekts wird übergangen. Sonst (kein oder unbekannter
/// Verweis) gilt die freie Wahl je Satz. Zwischen den Objekten bleibt es bei der bisherigen Reihenfolge (Hauptvarianten <
/// Ebene < Vorlage < Ausschnitt < Viewport < Anfrage; spätere gehen vor). `None` = keine Wahl gespeichert.
pub fn stored_choice(p: &Project, combination: Option<&str>, free: Option<&BTreeMap<String, String>>) -> Option<BTreeMap<String, String>> {
    if let Some(c) = combination.filter(|s| !s.is_empty()).and_then(|id| combinations(p).iter().find(|c| c.id == id)) {
        return Some(combination_choice(p, c).choice);
    }
    free.cloned()
}

/// Das Projekt in einer Kombination (Elemente anderer Varianten fehlen; ohne Wirkung geliehen).
pub fn project_in<'a>(p: &'a Project, c: &Combination) -> std::borrow::Cow<'a, Project> {
    let hidden = c.hidden(p);
    if hidden.is_empty() {
        std::borrow::Cow::Borrowed(p)
    } else {
        std::borrow::Cow::Owned(crate::renovation::without_hidden(p, &hidden))
    }
}

// ── Vergleich ────────────────────────────────────────────────────────────────

/// Eine Zeile der Vergleichstabelle: Kennzahlen und Kosten einer Kombination.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRow {
    /// Satz-Id → Varianten-Id.
    pub choice: BTreeMap<String, String>,
    /// Zeilentitel: Name der benannten Kombination, sonst die Wahl als Text („Dachform B“).
    pub label: String,
    /// Id der benannten Kombination; fehlt bei Zeilen aus dem Kreuzprodukt.
    pub combination: Option<String>,
    /// Die Wahl je Satz als Text („Dachform B, Fassade A“).
    pub detail: String,
    pub primary: bool,
    pub gf: f64,
    pub hnf: f64,
    pub gv: f64,
    pub footprint: f64,
    pub az: Option<f64>,
    pub uez: Option<f64>,
    /// Kosten inkl. MwSt. (Grobschätzung [209]).
    pub cost: f64,
}

/// [272] Kennzahlen und Kosten je Kombination; `filter`/`phase`: Umbau-Zustand. Zeilen: die gespeicherten benannten
/// Kombinationen (Name als Zeilentitel, Reihenfolge des Projekts); ohne gespeicherte Kombination alle Kombinationen
/// der Sätze (Hauptkombination zuerst).
pub fn compare(p: &Project, filter: Option<&str>, phase: Option<&str>) -> Vec<CompareRow> {
    compare_scope(p, filter, phase, false)
}

/// Wie [`compare`]; `all` = immer alle Kombinationen der Sätze (Kreuzprodukt, höchstens [`MAX_COMPARE`]).
pub fn compare_scope(p: &Project, filter: Option<&str>, phase: Option<&str>, all: bool) -> Vec<CompareRow> {
    if sets(p).is_empty() {
        return Vec::new();
    }
    let prim = Combination::primary(p);
    let rows: Vec<(Option<&DesignOptionCombination>, Combination)> = if all || combinations(p).is_empty() {
        Combination::all(p).into_iter().map(|c| (None, c)).collect()
    } else {
        combinations(p).iter().take(MAX_COMPARE).map(|c| (Some(c), combination_choice(p, c))).collect()
    };
    rows.into_iter()
        .map(|(named, c)| {
            let q = crate::renovation::project_in_view(p, filter, phase, &c);
            let k = crate::kennzahlen::compute(&q);
            let cost = crate::kosten::estimate(&q);
            let num = |x: f64| if x.is_finite() { x } else { 0.0 };
            let detail = c.label(p);
            CompareRow {
                label: named.map_or_else(|| detail.clone(), |n| n.name.clone()),
                combination: named.map(|n| n.id.clone()),
                detail,
                primary: c == prim,
                gf: num(k.gf),
                hnf: num(k.hnf),
                gv: num(k.gv),
                footprint: num(k.footprint),
                az: k.az.filter(|x| x.is_finite()),
                uez: k.uez.filter(|x| x.is_finite()),
                cost: num(cost.gross),
                choice: c.choice,
            }
        })
        .collect()
}

/// Vergleich als CSV (Semikolon, Spaltenköpfe aus `head`, de/en von der Oberfläche).
pub fn compare_csv(rows: &[CompareRow], head: &[String]) -> String {
    let f = |x: f64, d: usize| format!("{x:.d$}");
    let o = |x: Option<f64>| x.map_or(String::new(), |x| f(x, 2));
    let mut out = head.iter().map(|h| csv_cell(h)).collect::<Vec<_>>().join(";");
    out.push('\n');
    for r in rows {
        let cells = [csv_cell(&r.label), f(r.gf, 1), f(r.hnf, 1), f(r.gv, 0), f(r.footprint, 1), o(r.az), o(r.uez), f(r.cost, 0)];
        out.push_str(&cells.join(";"));
        out.push('\n');
    }
    out
}

fn csv_cell(s: &str) -> String {
    if s.contains([';', '"', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// ── Ops (auf der rohen Wurzel, verlustfrei) ─────────────────────────────────

fn arr<'a>(root: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    root.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn ref_of(v: &Value) -> Option<(&str, &str)> {
    let r = v.get("designOption")?;
    Some((r.get("set")?.as_str()?, r.get("option")?.as_str()?))
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str)
}

/// Element ohne/mit Feld `designOption` (als `replace`-Op).
fn with_ref(v: &Value, r: Option<(&str, &str)>) -> Value {
    let mut m = v.as_object().cloned().unwrap_or_default();
    match r {
        Some((s, o)) => {
            m.insert("designOption".into(), json!({"set": s, "option": o}));
        }
        None => {
            m.shift_remove("designOption");
        }
    }
    Value::Object(m)
}

fn set_list(root: &Map<String, Value>) -> Vec<Value> {
    arr(root, "designOptionSets").to_vec()
}

/// Ops: `fix` auf Ebenen, Vorlagen, Ausschnitte und Layout-Viewports (Träger einer gespeicherten Wahl) anwenden.
fn map_holders(root: &Map<String, Value>, fix: impl Fn(&Value) -> Option<Value>, ops: &mut Vec<Value>) {
    for key in ["drawingLevels", "viewTemplates", "viewSnapshots"] {
        for v in arr(root, key) {
            if let Some(n) = fix(v) {
                ops.push(json!({"kind": "replace", "collection": key, "entity": n}));
            }
        }
    }
    // Viewports liegen in den Layouts.
    for l in arr(root, "layouts") {
        let Some(vps) = l.get("viewports").and_then(Value::as_array) else { continue };
        let next: Vec<Value> = vps.iter().map(|vp| fix(vp).unwrap_or_else(|| vp.clone())).collect();
        if next != *vps {
            let mut obj = l.as_object().cloned().unwrap_or_default();
            obj.insert("viewports".into(), Value::Array(next));
            ops.push(json!({"kind": "replace", "collection": "layouts", "entity": Value::Object(obj)}));
        }
    }
}

/// Gespeicherte Wahlen (Ebenen, Vorlagen, Ausschnitte, Layout-Viewports) und benannte Kombinationen ohne den Satz `set`
/// bzw. ohne die Variante `option` des Satzes (`None` = alle seine Varianten). Eine benannte Kombination ohne den Satz
/// zeigt dort die Hauptvariante.
fn clear_choices(root: &Map<String, Value>, set: &str, option: Option<&str>, ops: &mut Vec<Value>) {
    let without = |m: &Map<String, Value>| -> Option<Map<String, Value>> {
        let cur = m.get(set)?.as_str();
        if option.is_some_and(|o| cur != Some(o)) {
            return None;
        }
        let mut next = m.clone();
        next.shift_remove(set);
        Some(next)
    };
    map_holders(
        root,
        |v| {
            let next = without(v.get("designOptions")?.as_object()?)?;
            let mut obj = v.as_object()?.clone();
            if next.is_empty() {
                obj.shift_remove("designOptions");
            } else {
                obj.insert("designOptions".into(), Value::Object(next));
            }
            Some(Value::Object(obj))
        },
        ops,
    );
    for c in arr(root, "designOptionCombinations") {
        let Some(next) = c.get("choices").and_then(Value::as_object).and_then(&without) else { continue };
        let mut obj = c.as_object().cloned().unwrap_or_default();
        obj.insert("choices".into(), Value::Object(next));
        ops.push(json!({"kind": "replace", "collection": "designOptionCombinations", "entity": Value::Object(obj)}));
    }
}

/// [272] Benannte Kombination löschen: sie verschwindet, Verweise an Ebenen, Vorlagen, Ausschnitten und Viewports fallen weg
/// (dort gilt wieder die freie Wahl bzw. die Hauptvarianten). Ein Undo-Schritt.
pub fn delete_combination_ops(root: &Map<String, Value>, id: &str) -> Vec<Value> {
    let mut ops = Vec::new();
    if !arr(root, "designOptionCombinations").iter().any(|c| id_of(c) == Some(id)) {
        return ops;
    }
    map_holders(
        root,
        |v| {
            if v.get("designOptionCombination").and_then(Value::as_str) != Some(id) {
                return None;
            }
            let mut obj = v.as_object()?.clone();
            obj.shift_remove("designOptionCombination");
            Some(Value::Object(obj))
        },
        &mut ops,
    );
    ops.push(json!({"kind": "remove", "collection": "designOptionCombinations", "ids": [id]}));
    ops
}

/// Elemente des Satzes `set` je Liste: (Liste, Element) für jede Variante, die `keep(option)` nicht behält.
fn elements_where<'a>(root: &'a Map<String, Value>, pred: impl Fn(&str, &str) -> bool) -> Vec<(&'static str, &'a Value)> {
    let mut out = Vec::new();
    for c in COLLECTIONS {
        for v in arr(root, c) {
            if ref_of(v).is_some_and(|(s, o)| pred(s, o)) {
                out.push((c, v));
            }
        }
    }
    out
}

/// Ops zum Entfernen der Elemente (je Liste ein `remove`), Öffnungen entfernter Wände mit.
fn remove_ops(root: &Map<String, Value>, doomed: &[(&'static str, &Value)], ops: &mut Vec<Value>) {
    let mut by: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (c, v) in doomed {
        if let Some(id) = id_of(v) {
            by.entry(c).or_default().push(id.to_string());
        }
    }
    let walls: HashSet<&str> = by.get("walls").map(|v| v.iter().map(String::as_str).collect()).unwrap_or_default();
    let mut extra = Vec::new();
    for o in arr(root, "openings") {
        let host = o.get("hostWallId").and_then(Value::as_str).unwrap_or("");
        if walls.contains(host) {
            if let Some(id) = id_of(o) {
                if !by.get("openings").is_some_and(|v| v.iter().any(|x| x == id)) {
                    extra.push(id.to_string());
                }
            }
        }
    }
    if !extra.is_empty() {
        by.entry("openings").or_default().extend(extra);
    }
    for (c, ids) in by {
        ops.push(json!({"kind": "remove", "collection": c, "ids": ids}));
    }
}

/// [272] „Variante übernehmen“: die Elemente der Variante `option` gehen ins Hauptmodell, die der übrigen Varianten
/// des Satzes werden gelöscht, der Satz verschwindet (auch aus gespeicherten Kombinationen). Ein Undo-Schritt.
pub fn accept_ops(root: &Map<String, Value>, set: &str, option: &str) -> Vec<Value> {
    let mut ops = Vec::new();
    let sets = set_list(root);
    let Some(s) = sets.iter().find(|s| id_of(s) == Some(set)) else { return ops };
    if !s.get("options").and_then(Value::as_array).is_some_and(|a| a.iter().any(|o| id_of(o) == Some(option))) {
        return ops;
    }
    for c in COLLECTIONS {
        for v in arr(root, c) {
            if ref_of(v) == Some((set, option)) {
                ops.push(json!({"kind": "replace", "collection": c, "entity": with_ref(v, None)}));
            }
        }
    }
    let doomed = elements_where(root, |s, o| s == set && o != option);
    remove_ops(root, &doomed, &mut ops);
    clear_choices(root, set, None, &mut ops);
    ops.push(json!({"kind": "remove", "collection": "designOptionSets", "ids": [set]}));
    ops
}

/// [272] Satz löschen: alle Elemente seiner Varianten werden gelöscht, der Satz verschwindet.
pub fn delete_set_ops(root: &Map<String, Value>, set: &str) -> Vec<Value> {
    let mut ops = Vec::new();
    if !set_list(root).iter().any(|s| id_of(s) == Some(set)) {
        return ops;
    }
    let doomed = elements_where(root, |s, _| s == set);
    remove_ops(root, &doomed, &mut ops);
    clear_choices(root, set, None, &mut ops);
    ops.push(json!({"kind": "remove", "collection": "designOptionSets", "ids": [set]}));
    ops
}

/// [272] Variante löschen: ihre Elemente werden gelöscht; war sie die Hauptvariante, wird die erste übrige es.
/// Die letzte Variante löscht den Satz.
pub fn delete_option_ops(root: &Map<String, Value>, set: &str, option: &str) -> Vec<Value> {
    let mut ops = Vec::new();
    let sets = set_list(root);
    let Some(s) = sets.iter().find(|s| id_of(s) == Some(set)) else { return ops };
    let opts: Vec<Value> = s.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
    if !opts.iter().any(|o| id_of(o) == Some(option)) {
        return ops;
    }
    let rest: Vec<Value> = opts.iter().filter(|o| id_of(o) != Some(option)).cloned().collect();
    if rest.is_empty() {
        return delete_set_ops(root, set);
    }
    let doomed = elements_where(root, |s, o| s == set && o == option);
    remove_ops(root, &doomed, &mut ops);
    clear_choices(root, set, Some(option), &mut ops);
    let mut obj = s.as_object().cloned().unwrap_or_default();
    obj.insert("options".into(), Value::Array(rest.clone()));
    if obj.get("primary").and_then(Value::as_str) == Some(option) || !obj.contains_key("primary") {
        if let Some(first) = rest.first().and_then(id_of) {
            obj.insert("primary".into(), json!(first));
        }
    }
    ops.push(json!({"kind": "replace", "collection": "designOptionSets", "entity": Value::Object(obj)}));
    ops
}

/// Ids je Liste (Auswahl der Oberfläche, `{walls: [...], ...}`); Listen ohne Varianten werden übergangen.
pub type Selection = BTreeMap<String, Vec<String>>;

fn selected<'a>(root: &'a Map<String, Value>, sel: &Selection) -> Vec<(&'static str, &'a Value)> {
    let mut out = Vec::new();
    for c in COLLECTIONS {
        let Some(ids) = sel.get(c) else { continue };
        let ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
        for v in arr(root, c) {
            if id_of(v).is_some_and(|id| ids.contains(id)) {
                out.push((c, v));
            }
        }
    }
    out
}

/// Ist (`set`, `option`) eine bekannte Variante?
fn known(root: &Map<String, Value>, set: &str, option: &str) -> bool {
    set_list(root).iter().any(|s| id_of(s) == Some(set) && s.get("options").and_then(Value::as_array).is_some_and(|a| a.iter().any(|o| id_of(o) == Some(option))))
}

/// [272] Variante zuweisen (`None` = Hauptmodell) für die Auswahl: ein `replace` je geändertes Element.
/// Unbekannte Variante ⇒ keine Ops.
pub fn assign_ops(root: &Map<String, Value>, sel: &Selection, target: Option<(&str, &str)>) -> Vec<Value> {
    if target.is_some_and(|(s, o)| !known(root, s, o)) {
        return Vec::new();
    }
    let mut ops = Vec::new();
    for (c, v) in selected(root, sel) {
        if ref_of(v) != target {
            ops.push(json!({"kind": "replace", "collection": c, "entity": with_ref(v, target)}));
        }
    }
    ops
}

/// [272] „In Variante kopieren“: Kopien der Auswahl mit neuen Ids (`stamp` + laufende Nummer) in der Variante
/// (`None` = Hauptmodell); Öffnungen gewählter Wände wandern mit und zeigen auf die kopierte Wand.
pub fn copy_ops(root: &Map<String, Value>, sel: &Selection, target: Option<(&str, &str)>, stamp: &str) -> Vec<Value> {
    if target.is_some_and(|(s, o)| !known(root, s, o)) {
        return Vec::new();
    }
    let mut picked = selected(root, sel);
    // Öffnungen der gewählten Wände kommen mit, sofern nicht selbst gewählt.
    let wall_ids: HashSet<&str> = picked.iter().filter(|(c, _)| *c == "walls").filter_map(|(_, v)| id_of(v)).collect();
    let chosen: HashSet<&str> = picked.iter().filter(|(c, _)| *c == "openings").filter_map(|(_, v)| id_of(v)).collect();
    for o in arr(root, "openings") {
        let host = o.get("hostWallId").and_then(Value::as_str).unwrap_or("");
        if wall_ids.contains(host) && id_of(o).is_some_and(|id| !chosen.contains(id)) {
            picked.push(("openings", o));
        }
    }
    let mut n = 0usize;
    let mut new_id: BTreeMap<String, String> = BTreeMap::new();
    for (_, v) in &picked {
        if let Some(id) = id_of(v) {
            n += 1;
            new_id.insert(id.to_string(), format!("{stamp}-{n}"));
        }
    }
    let mut by: BTreeMap<&str, Vec<Value>> = BTreeMap::new();
    for (c, v) in &picked {
        let Some(id) = id_of(v) else { continue };
        let mut x = with_ref(v, target);
        if let Some(m) = x.as_object_mut() {
            m.insert("id".into(), json!(new_id[id]));
            if *c == "openings" {
                if let Some(h) = m.get("hostWallId").and_then(Value::as_str).and_then(|h| new_id.get(h)) {
                    m.insert("hostWallId".into(), json!(h));
                }
            }
        }
        by.entry(c).or_default().push(x);
    }
    by.into_iter().map(|(c, items)| json!({"kind": "add", "collection": c, "items": items})).collect()
}

/// [272] Neue Elemente der Ops (`add` in [`COLLECTIONS`]) erhalten die Zeichen-Variante (`{set, option}`), sofern sie
/// keine tragen; ohne gültige Angabe unverändert.
pub fn stamp_ops(mut ops: Vec<crate::ops::Op>, v: Option<&Value>) -> Vec<crate::ops::Op> {
    let Some(r) = v.and_then(|r| Some(json!({"set": r.get("set")?.as_str().filter(|s| !s.is_empty())?, "option": r.get("option")?.as_str().filter(|s| !s.is_empty())?}))) else { return ops };
    for op in ops.iter_mut() {
        if let crate::ops::Op::Add { collection, items, .. } = op {
            if !COLLECTIONS.contains(&collection.as_str()) {
                continue;
            }
            for it in items.iter_mut() {
                if let Some(o) = it.as_object_mut() {
                    o.entry("designOption").or_insert_with(|| r.clone());
                }
            }
        }
    }
    ops
}

/// Antwort der Abfrage `designOptionInfo`: Sätze mit Varianten und Hauptvariante, Zahl der Elemente je Variante.
pub fn info(p: &Project) -> Value {
    let mut count: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut add = |r: Option<&DesignOptionRef>| {
        if let Some(r) = r {
            *count.entry((r.set.clone(), r.option.clone())).or_default() += 1;
        }
    };
    p.walls.iter().for_each(|x| add(x.design_option.as_ref()));
    p.openings.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.ceilings.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.roofs.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.stairs.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.columns.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.railings.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.beams.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.extruded_solids.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.rooms.iter().flatten().for_each(|x| add(x.design_option.as_ref()));
    p.drawings2d.iter().for_each(|x| add(x.design_option.as_ref()));
    Value::Array(
        sets(p)
            .iter()
            .map(|s| {
                let opts: Vec<Value> = s.options.iter().map(|o| json!({"id": o.id, "name": o.name, "count": count.get(&(s.id.clone(), o.id.clone())).copied().unwrap_or(0)})).collect();
                json!({"id": s.id, "name": s.name, "primary": primary_of(s), "options": opts})
            })
            .collect(),
    )
}

#[cfg(test)]
#[path = "design_options_tests.rs"]
mod tests;
