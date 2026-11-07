//! Grafische Overrides ([K3d], [33]): wertet `Project.overrideRules` für ein Element bzw. eine
//! Bauteilschicht aus. Pro Aktions-Feld gewinnt die OBERSTE aktive Regel, deren Bedingungen passen;
//! spätere Regeln füllen nur noch offene Felder. Vergleiche ohne Gross-/Kleinschreibung, Werte
//! getrimmt (wie JS `trim()`/`toLowerCase()`).
//!
//! [33] Schicht-Regeln: Eine Regel mit einer Schicht-Bedingung (Funktion, Lage zur tragenden Schicht,
//! Baustoff, Baustoff-Kategorie) wirkt nur auf Bauteilschichten (Schnittflächen im Schnitt, Wandschichten
//! im Grundriss), nie auf ganze Elemente ([`effective`] überspringt sie). Schicht-Aktionen (Füllung,
//! Schraffur, Umriss) wertet [`effective_layer`] aus — dort zählen auch Element-Regeln (Ebene, Name,
//! Bauteilart), deren Bedingungen auf das Bauteil der Schicht passen. Die Aktionen haben Vorrang vor der
//! Massstabsregel „Schnittflächen 1:100 schwarz“ (`style::solid_cut`) und der Ausnahme für lose
//! Schüttungen (`standards::is_loose_fill`).

use crate::model::*;
use std::collections::HashSet;

/// [33] Darstellung, für die Regeln ausgewertet werden: Massstab (Kriterium `minScale`/`maxScale`) und
/// die eingeschalteten Regeln eines Ausschnitts/einer Ansichtsvorlage (Blatt-Viewport). `on: None` =
/// Schalter `enabled` der Regeln im Projekt; `scale: None` = Massstab unbekannt (Kriterium ignoriert).
#[derive(Clone, Copy, Debug, Default)]
pub struct RuleView<'a> {
    pub scale: Option<f64>,
    pub on: Option<&'a HashSet<String>>,
    /// Darstellung für das Kriterium `view_kind`: "plan", "section", "elevation" (`None` = unbekannt).
    pub view: Option<&'static str>,
}

impl<'a> RuleView<'a> {
    pub fn at(scale: f64, on: Option<&'a HashSet<String>>) -> Self {
        RuleView { scale: Some(scale), on, view: None }
    }

    /// Dieselbe Auswertung für die Darstellung `view` ("plan", "section", "elevation").
    pub fn view(self, view: &'static str) -> Self {
        RuleView { view: Some(view), ..self }
    }

    /// Wirkt die Regel in dieser Darstellung (eingeschaltet und im Massstabsbereich)?
    pub fn active(&self, r: &OverrideRule) -> bool {
        let on = match self.on {
            Some(ids) => ids.contains(&r.id),
            None => r.enabled,
        };
        on && scale_ok(r, self.scale)
    }
}

/// [33] Massstab-Kriterium: Nenner `n` im Bereich `minScale`..=`maxScale` (fehlende Grenze = offen).
pub fn scale_ok(r: &OverrideRule, scale: Option<f64>) -> bool {
    let Some(n) = scale.filter(|n| n.is_finite() && *n > 0.0) else { return true };
    let lo = r.min_scale.filter(|x| x.is_finite() && *x > 0.0);
    let hi = r.max_scale.filter(|x| x.is_finite() && *x > 0.0);
    lo.is_none_or(|lo| n >= lo - 1e-9) && hi.is_none_or(|hi| n <= hi + 1e-9)
}

/// Die vergleichbaren Eigenschaften eines Elements bzw. einer Schicht (Schicht-Felder `None` = Element).
#[derive(Clone, Copy, Debug, Default)]
pub struct Subject<'a> {
    /// Name der Ebene (`LayerCategory.name`).
    pub layer_name: Option<&'a str>,
    /// Code der Ebene (`categoryCode`).
    pub layer_code: Option<&'a str>,
    /// Element-/Typ-Name (Wandtyp, Raum, Öffnungs-Label …).
    pub object_name: Option<&'a str>,
    /// [33] Bauteilart: "wall", "slab", "ground_slab", "roof", "stair", "column", "opening", "room", dazu
    /// [`SPECIAL_KINDS`] "shadow" (Schlagschatten der Ansicht), "terrain" (Gelände/Höhenlinien) und "floor_finish"
    /// (Bodenbelag-Muster im Grundriss, [156]).
    pub element_kind: Option<&'a str>,
    /// [33] Funktion der Schicht ([`function_key`]).
    pub layer_function: Option<&'a str>,
    /// [33] Lage zur tragenden Schicht: "above", "structure", "below".
    pub layer_position: Option<&'a str>,
    /// [33] Baustoff: id, Standard-Kennung, Name.
    pub material_id: Option<&'a str>,
    pub material_standard: Option<&'a str>,
    pub material_name: Option<&'a str>,
    /// [33] Baustoff-Kategorie (`standards::material_category`).
    pub material_category: Option<&'a str>,
    /// [33] Darstellung (die Auswertung setzt sie aus [`RuleView::view`]).
    pub view_kind: Option<&'a str>,
}

/// Effektive Aktionen (alle `None` = kein Override).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Actions {
    pub color: Option<String>,
    pub lineweight: Option<f64>,
    pub linetype_id: Option<String>,
    /// [33] Ausblenden (Element samt Linien, Schraffur, Beschriftung).
    pub hide: Option<bool>,
}

impl Actions {
    pub fn any(&self) -> bool {
        self.color.is_some() || self.lineweight.is_some() || self.linetype_id.is_some()
    }
    pub fn hidden(&self) -> bool {
        self.hide == Some(true)
    }
}

/// [33] Bauteilarten ohne eigenes Element im Modell (Schlagschatten der Ansicht, Gelände/Höhenlinien): Sie
/// folgen nur Regeln, die die Bauteilart ausdrücklich nennen (gleich/enthält/beginnt mit) — sonst würden
/// allgemeine Regeln („Ebene ≠ …“, „Bauteilart ≠ Fenster/Tür“) sie plötzlich mitfärben.
pub const SPECIAL_KINDS: [&str; 3] = ["shadow", "terrain", "floor_finish"];

/// [33] Wirkt die Regel auf diese Bauteilart? Für [`SPECIAL_KINDS`] nur mit positiver Bauteilart-Bedingung.
fn kind_ok(rule: &OverrideRule, s: &Subject) -> bool {
    !s.element_kind.is_some_and(|k| SPECIAL_KINDS.contains(&k)) || conditions(rule).any(|c| c.r#type == OverrideConditionType::ElementKind && matches!(c.operator, OverrideOperator::Equals | OverrideOperator::Contains | OverrideOperator::StartsWith))
}

/// [33] Strichmuster eines Linienstils (Aktion `linetypeId`) als `dash` einer Linie: `Some(None)` =
/// durchgezogen, `None` = kein bzw. unbekannter Linienstil.
pub fn linetype_dash(p: &Project, id: Option<&str>) -> Option<Option<Vec<f64>>> {
    let id = id.map(js_trim).filter(|s| !s.is_empty())?;
    p.line_styles.iter().find(|l| l.id == id).map(|l| l.dash.clone().filter(|d| !d.is_empty()))
}

/// [33] Effektive Schicht-Aktionen (Füllung, Schraffur, Umriss) einer Schicht.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayerActions {
    pub fill_color: Option<String>,
    /// "none", "material" oder id einer Schraffur.
    pub hatch: Option<String>,
    pub outline: Option<bool>,
    /// [33] Linienstil der Fugen/Umrisse der Schicht (nur aus Schicht-Regeln, [`is_layer_rule`]).
    pub linetype_id: Option<String>,
}

impl LayerActions {
    /// Ändert die Regel Füllung oder Schraffur (und hebt damit „schwarz ab 1:100“ auf)?
    pub fn styles(&self) -> bool {
        self.fill_color.is_some() || self.hatch.is_some()
    }
    pub fn any(&self) -> bool {
        self.styles() || self.outline.is_some() || self.linetype_id.is_some()
    }
    /// Fläche ohne Muster (Schraffur "none")?
    pub fn plain(&self) -> bool {
        self.hatch.as_deref() == Some("none")
    }
}

/// Leerraum im Sinne von JS `String.prototype.trim` (WhiteSpace + LineTerminator).
pub fn js_space(c: char) -> bool {
    matches!(c, '\u{9}' | '\u{A}' | '\u{B}' | '\u{C}' | '\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// JS `s.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn norm(s: &str) -> String {
    js_trim(s).to_lowercase()
}

/// [33] Bedingung auf eine Schicht-Eigenschaft (Regel wirkt dann nur auf Schichten)?
pub fn is_layer_condition(t: OverrideConditionType) -> bool {
    use OverrideConditionType as T;
    matches!(t, T::LayerFunction | T::LayerPosition | T::Material | T::MaterialCategory)
}

/// Alle Bedingungen einer Regel (Haupt- und weitere).
fn conditions(rule: &OverrideRule) -> impl Iterator<Item = &OverrideCondition> {
    std::iter::once(&rule.condition).chain(rule.conditions.iter().flatten())
}

/// [33] Wirkt die Regel nur auf Schichten?
pub fn is_layer_rule(rule: &OverrideRule) -> bool {
    conditions(rule).any(|c| is_layer_condition(c.r#type))
}

/// `matchesCondition`: `layer_name` vergleicht Name UND Code (positive Operatoren: einer passt;
/// `not_equals`: keiner gleich), `object_name` den Element-Namen, `material` id, Standard-Kennung und
/// Name. Fehlt die Eigenschaft, trifft nur `not_equals`.
pub fn matches_condition(c: &OverrideCondition, s: &Subject) -> bool {
    use OverrideConditionType as T;
    let value = norm(&c.value);
    let raw: [Option<&str>; 3] = match c.r#type {
        T::LayerName => [s.layer_name, s.layer_code, None],
        T::ObjectName => [s.object_name, None, None],
        T::ElementKind => [s.element_kind, None, None],
        T::LayerFunction => [s.layer_function, None, None],
        T::LayerPosition => [s.layer_position, None, None],
        T::Material => [s.material_id, s.material_standard, s.material_name],
        T::MaterialCategory => [s.material_category, None, None],
        T::ViewKind => [s.view_kind, None, None],
        T::Unknown => [None, None, None],
    };
    let cands: Vec<String> = raw.iter().flatten().map(|x| norm(x)).collect();
    if cands.is_empty() {
        return c.operator == OverrideOperator::NotEquals;
    }
    match c.operator {
        OverrideOperator::NotEquals => cands.iter().all(|x| *x != value),
        OverrideOperator::Equals => cands.contains(&value),
        OverrideOperator::Contains => cands.iter().any(|x| x.contains(value.as_str())),
        OverrideOperator::StartsWith => cands.iter().any(|x| x.starts_with(value.as_str())),
        OverrideOperator::Unknown => false,
    }
}

/// Treffen alle Bedingungen der Regel?
pub fn rule_matches(rule: &OverrideRule, s: &Subject) -> bool {
    conditions(rule).all(|c| matches_condition(c, s))
}

/// `effectiveOverrides`: kollabiert die Regelliste für ein Element (Schicht-Regeln zählen nicht).
pub fn effective(rules: Option<&[OverrideRule]>, s: &Subject, v: RuleView) -> Actions {
    let mut out = Actions::default();
    let Some(rules) = rules else { return out };
    let s = &Subject { view_kind: v.view, ..*s };
    for rule in rules {
        if !v.active(rule) || is_layer_rule(rule) || !kind_ok(rule, s) || !rule_matches(rule, s) {
            continue;
        }
        let a = &rule.actions;
        if out.color.is_none() {
            out.color = a.color.clone();
        }
        if out.lineweight.is_none() {
            out.lineweight = a.lineweight;
        }
        if out.linetype_id.is_none() {
            out.linetype_id = a.linetype_id.clone();
        }
        if out.hide.is_none() {
            out.hide = a.hide;
        }
        if out.color.is_some() && out.lineweight.is_some() && out.linetype_id.is_some() && out.hide.is_some() {
            break;
        }
    }
    out
}

/// [33] Schicht-Aktionen für eine Schicht (alle aktiven Regeln, deren Bedingungen passen).
pub fn effective_layer(rules: Option<&[OverrideRule]>, s: &Subject, v: RuleView) -> LayerActions {
    let mut out = LayerActions::default();
    let Some(rules) = rules else { return out };
    let s = &Subject { view_kind: v.view, ..*s };
    for rule in rules {
        let a = &rule.actions;
        let lt = if is_layer_rule(rule) { a.linetype_id.as_deref().map(js_trim).filter(|x| !x.is_empty()) } else { None };
        if !v.active(rule) || (a.fill_color.is_none() && a.hatch.is_none() && a.outline.is_none() && lt.is_none()) || !rule_matches(rule, s) {
            continue;
        }
        if out.linetype_id.is_none() {
            out.linetype_id = lt.map(String::from);
        }
        if out.fill_color.is_none() {
            out.fill_color = a.fill_color.as_deref().map(js_trim).filter(|x| !x.is_empty()).map(String::from);
        }
        if out.hatch.is_none() {
            out.hatch = a.hatch.as_deref().map(js_trim).filter(|x| !x.is_empty()).map(String::from);
        }
        if out.outline.is_none() {
            out.outline = a.outline;
        }
    }
    out
}

/// [33] Alle Aktionen einer Ansichtsfläche ([`super::elevation`]): Die sichtbare Fläche IST eine Schicht
/// (äusserste Wandschicht, Dachdeckung), darum zählen Element- und Schicht-Regeln gleich; `s` trägt die
/// Element- und — wo bekannt — die Schicht-Eigenschaften. Pro Feld gewinnt die oberste passende Regel.
pub fn effective_surface(rules: Option<&[OverrideRule]>, s: &Subject, v: RuleView) -> (Actions, LayerActions, Option<bool>) {
    let (mut el, mut ly, mut hide) = (Actions::default(), LayerActions::default(), None);
    let Some(rules) = rules else { return (el, ly, hide) };
    let s = &Subject { view_kind: v.view, ..*s };
    let text = |x: &Option<String>| x.as_deref().map(js_trim).filter(|x| !x.is_empty()).map(String::from);
    for rule in rules {
        if !v.active(rule) || !kind_ok(rule, s) || !rule_matches(rule, s) {
            continue;
        }
        let a = &rule.actions;
        el.color = el.color.take().or_else(|| text(&a.color));
        el.lineweight = el.lineweight.or(a.lineweight.filter(|w| w.is_finite() && *w >= 0.0));
        el.linetype_id = el.linetype_id.take().or_else(|| a.linetype_id.clone());
        ly.fill_color = ly.fill_color.take().or_else(|| text(&a.fill_color));
        ly.hatch = ly.hatch.take().or_else(|| text(&a.hatch));
        ly.outline = ly.outline.or(a.outline);
        hide = hide.or(a.hide);
    }
    (el, ly, hide)
}

/// Gibt es überhaupt eine aktive Regel (Schnellpfad der Ansicht)?
pub fn has_active(p: &Project, v: RuleView) -> bool {
    p.override_rules.iter().flatten().any(|r| v.active(r))
}

/// Gibt es überhaupt aktive Regeln mit Schicht-Aktionen? (Schnellpfad: sonst nichts auswerten.)
pub fn has_layer_actions(p: &Project, v: RuleView) -> bool {
    p.override_rules.iter().flatten().any(|r| v.active(r) && (r.actions.fill_color.is_some() || r.actions.hatch.is_some() || r.actions.outline.is_some() || (r.actions.linetype_id.is_some() && is_layer_rule(r))))
}

/// [33] Gibt es aktive Element-Regeln mit „Ausblenden“? (Schnellpfad für [`hidden_elements`].)
pub fn has_hide(p: &Project, v: RuleView) -> bool {
    p.override_rules.iter().flatten().any(|r| v.active(r) && r.actions.hide == Some(true) && !is_layer_rule(r))
}

/// [33] Elemente, die eine Regel „Ausblenden“ in Grundriss/Deckenspiegel/Schnitt ausblendet (ids): Wände,
/// Öffnungen, Decken/Bodenplatten, Dächer, Treppen, Stützen, Räume — Bedingungen wie bei [`effective`]
/// (Element-Regeln: Ebene, Name, Bauteilart, Darstellung, Massstab). Eine ausgeblendete Wand nimmt ihre
/// Öffnungen mit. Leer ohne aktive Regel mit „Ausblenden“.
pub fn hidden_elements(p: &Project, v: RuleView) -> HashSet<String> {
    let mut out = HashSet::new();
    if !has_hide(p, v) {
        return out;
    }
    let rules = p.override_rules.as_deref();
    let mut memo: std::collections::HashMap<(&'static str, String, Option<String>), bool> = std::collections::HashMap::new();
    let mut test = |kind: &'static str, code: &str, name: Option<&str>| -> bool {
        *memo.entry((kind, code.to_string(), name.map(String::from))).or_insert_with(|| {
            let s = Subject { layer_name: p.layer_category(code).map(|c| c.name.as_str()), layer_code: Some(code), object_name: name, element_kind: Some(kind), ..Default::default() };
            effective(rules, &s, v).hidden()
        })
    };
    for w in &p.walls {
        if test("wall", &w.category_code, Some(&p.wall_type_or_fallback(w).name)) {
            out.insert(w.id.clone());
        }
    }
    for o in p.openings.iter().flatten() {
        if out.contains(&o.host_wall_id) || test("opening", &o.category_code, Some(&super::walls::opening_label(o))) {
            out.insert(o.id.clone());
        }
    }
    for c in p.ceilings.iter().flatten() {
        let layers = super::domains::ceiling_layers(p, c).unwrap_or(&[]);
        let kind = if is_ground_slab(p, c, layers) { "ground_slab" } else { "slab" };
        if test(kind, &c.category_code, super::domains::ceiling_type_name(p, c)) {
            out.insert(c.id.clone());
        }
    }
    for r in p.roofs.iter().flatten() {
        if test("roof", &r.category_code, None) {
            out.insert(r.id.clone());
        }
    }
    for s in p.stairs.iter().flatten() {
        if test("stair", &s.category_code, Some(&super::stairs::stair_label(s))) {
            out.insert(s.id.clone());
        }
    }
    for c in p.columns.iter().flatten() {
        if test("column", &c.category_code, Some(&super::domains::column_label(c))) {
            out.insert(c.id.clone());
        }
    }
    for r in p.rooms.iter().flatten() {
        if test("room", &r.category_code, Some(&r.name)) {
            out.insert(r.id.clone());
        }
    }
    // [152] Importierte Netze (Bauteilart „mesh"); ohne Kategorie nur über Name/Bauteilart.
    for c in p.context.iter().flatten() {
        if let ContextObject::ImportedMesh(m) = c {
            if test(super::section::MESH_KIND, m.category_code.as_deref().unwrap_or(""), Some(&m.name)) {
                out.insert(m.id.clone());
            }
        }
    }
    out
}

/// [33] Override für Gelände/Höhenlinien (Bauteilart "terrain", s. [`SPECIAL_KINDS`]): Linie (Farbe, Stärke,
/// Linienstil), Füllung, Ausblenden (`Actions::hide`). `None` ohne wirksame Regel.
pub fn terrain_override(p: &Project, v: RuleView, code: Option<&str>, name: &str) -> Option<(Actions, LayerActions)> {
    special_override(p, v, "terrain", code, Some(name))
}

/// [33] Override für den Schlagschatten der Ansicht (Bauteilart "shadow").
pub fn shadow_override(p: &Project, v: RuleView) -> Option<(Actions, LayerActions)> {
    special_override(p, v, "shadow", None, None)
}

fn special_override(p: &Project, v: RuleView, kind: &str, code: Option<&str>, name: Option<&str>) -> Option<(Actions, LayerActions)> {
    if !has_active(p, v) {
        return None;
    }
    let s = Subject { layer_name: code.and_then(|c| p.layer_category(c)).map(|c| c.name.as_str()), layer_code: code, object_name: name, element_kind: Some(kind), ..Default::default() };
    let (mut el, ly, hide) = effective_surface(p.override_rules.as_deref(), &s, v);
    el.hide = hide;
    (el.any() || el.hidden() || ly.fill_color.is_some()).then_some((el, ly))
}

/// Schlüssel einer Schichtfunktion (wie im JSON).
pub fn function_key(f: LayerFunction) -> Option<&'static str> {
    Some(match f {
        LayerFunction::Structure => "structure",
        LayerFunction::Insulation => "insulation",
        LayerFunction::Screed => "screed",
        LayerFunction::Finish => "finish",
        LayerFunction::Plaster => "plaster",
        LayerFunction::Substructure => "substructure",
        LayerFunction::Membrane => "membrane",
        LayerFunction::Cladding => "cladding",
        LayerFunction::Air => "air",
        LayerFunction::Unknown => return None,
    })
}

/// Funktion einer Schicht: eigenes Feld, sonst aus dem Baustoff.
pub fn layer_function(p: &Project, l: &Layer) -> Option<LayerFunction> {
    l.function.filter(|f| *f != LayerFunction::Unknown).or_else(|| crate::standards::layer_function_of_category(crate::standards::material_category(p.component_or_fallback(&l.component_id))))
}

/// [33] Aus dem Baustoff abgeleitete Schichtfunktion je Bauteil-id (Schlüssel wie im JSON; `None` = keine) —
/// die Vorgabe, die gilt, solange eine Schicht kein eigenes `function` hat (Anzeige im Aufbau-Editor).
pub fn component_functions(p: &Project) -> std::collections::BTreeMap<&str, Option<&'static str>> {
    p.components.iter().map(|c| (c.id.as_str(), crate::standards::layer_function_of_category(crate::standards::material_category(c)).and_then(function_key))).collect()
}

/// [33] Lage jeder Schicht zur tragenden Schicht: Schichten liegen aussen/oben → innen/unten; die tragende
/// ist die mit Funktion „tragend“ und dem höchsten Verschneidungs-Rang (Gleichstand: die dickere), ohne
/// tragende die mit dem höchsten Rang. Davor "above", danach "below".
pub fn layer_positions(p: &Project, layers: &[Layer]) -> Vec<&'static str> {
    let rank = |i: usize| {
        let l = &layers[i];
        let st = layer_function(p, l) == Some(LayerFunction::Structure);
        (st, p.component_or_fallback(&l.component_id).join_priority, l.thickness)
    };
    let core = (0..layers.len()).max_by(|&a, &b| {
        let (x, y) = (rank(a), rank(b));
        x.0.cmp(&y.0).then(x.1.total_cmp(&y.1)).then(x.2.total_cmp(&y.2)).then(b.cmp(&a))
    });
    (0..layers.len())
        .map(|i| match core {
            Some(c) if i < c => "above",
            Some(c) if i > c => "below",
            _ => "structure",
        })
        .collect()
}

/// [33] Bodenplatte: Decke mit Unterbau-Schicht (Kies, Magerbeton, Erdreich) oder auf dem untersten
/// Geschoss mit Oberkante auf dessen Boden.
pub fn is_ground_slab(p: &Project, c: &Ceiling, layers: &[Layer]) -> bool {
    if layers.iter().any(|l| crate::standards::is_loose_fill(p.component_or_fallback(&l.component_id))) {
        return true;
    }
    let lowest = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).min_by(|a, b| a.base_elevation.unwrap_or(0.0).total_cmp(&b.base_elevation.unwrap_or(0.0)));
    lowest.is_some_and(|lv| lv.id == c.floor_id && matches!(&c.top, Some(VerticalAnchor::Floor { floor_id, offset }) if *floor_id == c.floor_id && offset.unwrap_or(0.0) <= 1e-6))
}

/// [33] Schicht-Aktionen je Schicht eines Bauteils (`kind` "wall"/"slab"/"ground_slab"/"roof"). Ohne aktive
/// Regel mit Schicht-Aktionen: lauter leere Aktionen (Schnellpfad).
pub fn layer_actions(p: &Project, v: RuleView, kind: &str, category_code: &str, object_name: Option<&str>, layers: &[Layer]) -> Vec<LayerActions> {
    if !has_layer_actions(p, v) {
        return vec![LayerActions::default(); layers.len()];
    }
    let rules = p.override_rules.as_deref();
    let cat = p.layer_category(category_code);
    let pos = layer_positions(p, layers);
    layers
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let comp = p.component_or_fallback(&l.component_id);
            let s = Subject {
                layer_name: cat.map(|c| c.name.as_str()),
                layer_code: Some(category_code),
                object_name,
                element_kind: Some(kind),
                layer_function: layer_function(p, l).and_then(function_key),
                layer_position: Some(pos[i]),
                material_id: Some(comp.id.as_str()),
                material_standard: comp.standard_id.as_deref(),
                material_name: Some(comp.name.as_str()),
                material_category: Some(crate::standards::material_category(comp)),
                view_kind: None,
            };
            effective_layer(rules, &s, v)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WALL: Subject = Subject {
        layer_name: Some("Wände"),
        layer_code: Some("20"),
        object_name: Some("AW 24"),
        element_kind: None,
        layer_function: None,
        layer_position: None,
        material_id: None,
        material_standard: None,
        material_name: None,
        material_category: None,
        view_kind: None,
    };

    fn cond(t: OverrideConditionType, op: OverrideOperator, v: &str) -> OverrideCondition {
        OverrideCondition { r#type: t, operator: op, value: v.into(), ..Default::default() }
    }

    fn rule(enabled: bool, c: OverrideCondition, color: Option<&str>, lw: Option<f64>, lt: Option<&str>) -> OverrideRule {
        OverrideRule {
            enabled,
            condition: c,
            actions: OverrideActions { color: color.map(Into::into), lineweight: lw, linetype_id: lt.map(Into::into), ..Default::default() },
            ..Default::default()
        }
    }

    use OverrideConditionType::*;
    use OverrideOperator::*;

    #[test]
    fn operatoren_wie_ts() {
        assert!(matches_condition(&cond(LayerName, Equals, "  wände "), &WALL));
        assert!(!matches_condition(&cond(LayerName, Equals, "Decken"), &WALL));
        assert!(matches_condition(&cond(LayerName, Equals, "20"), &WALL));
        assert!(matches_condition(&cond(ObjectName, Contains, "24"), &WALL));
        assert!(matches_condition(&cond(ObjectName, StartsWith, "aw"), &WALL));
        assert!(!matches_condition(&cond(ObjectName, StartsWith, "24"), &WALL));
        assert!(!matches_condition(&cond(LayerName, NotEquals, "20"), &WALL));
        assert!(!matches_condition(&cond(LayerName, NotEquals, "Wände"), &WALL));
        assert!(matches_condition(&cond(LayerName, NotEquals, "Decken"), &WALL));
        let no_obj = Subject { object_name: None, ..WALL };
        assert!(!matches_condition(&cond(ObjectName, Contains, "x"), &no_obj));
        assert!(matches_condition(&cond(ObjectName, NotEquals, "x"), &no_obj));
        // JS-trim kennt U+FEFF, aber nicht U+0085.
        assert!(matches_condition(&cond(LayerName, Equals, "\u{FEFF}20\u{FEFF}"), &WALL));
        assert!(!matches_condition(&cond(LayerName, Equals, "\u{85}20"), &WALL));
    }

    #[test]
    fn oberste_regel_gewinnt_je_feld() {
        let rules = vec![
            rule(false, cond(LayerName, Equals, "20"), Some("#000"), None, None),
            rule(true, cond(LayerName, Equals, "20"), Some("#f00"), None, None),
            rule(true, cond(ObjectName, Contains, "aw"), Some("#0f0"), Some(0.7), None),
            rule(true, cond(LayerName, Equals, "Wände"), None, Some(0.1), Some("dashed")),
        ];
        let a = effective(Some(&rules), &WALL, RuleView::default());
        assert_eq!(a, Actions { color: Some("#f00".into()), lineweight: Some(0.7), linetype_id: Some("dashed".into()), hide: None });
        assert!(!effective(None, &WALL, RuleView::default()).any());
        assert!(!effective(Some(&[]), &WALL, RuleView::default()).any());
    }

    /// [33] Schicht-Regeln: wirken nur auf Schichten (nicht aufs ganze Element), alle Bedingungen müssen
    /// passen, Material nach id/Standard/Name; Element-Regeln mit Schicht-Aktionen gelten für alle Schichten.
    #[test]
    fn schicht_regeln() {
        let screed = Subject {
            element_kind: Some("slab"),
            layer_function: Some("screed"),
            layer_position: Some("above"),
            material_id: Some("c7"),
            material_standard: Some("std-c-zementestrich"),
            material_name: Some("Zementestrich"),
            material_category: Some("screed"),
            ..WALL
        };
        let core = Subject { layer_function: Some("structure"), layer_position: Some("structure"), material_id: Some("c1"), material_standard: None, material_name: Some("STB"), material_category: Some("concrete"), ..screed };
        let mut white = rule(true, cond(LayerPosition, Equals, "above"), Some("#00f"), None, None);
        white.conditions = Some(vec![cond(ElementKind, Contains, "slab")]);
        white.actions.fill_color = Some("#ffffff".into());
        white.actions.hatch = Some("none".into());
        white.actions.outline = Some(true);
        assert!(is_layer_rule(&white));
        // Nicht aufs Element (auch nicht die Farbe).
        assert!(!effective(Some(std::slice::from_ref(&white)), &WALL, RuleView::default()).any());
        let a = effective_layer(Some(std::slice::from_ref(&white)), &screed, RuleView::default());
        assert_eq!(a, LayerActions { fill_color: Some("#ffffff".into()), hatch: Some("none".into()), outline: Some(true), linetype_id: None });
        assert!(!effective_layer(Some(std::slice::from_ref(&white)), &core, RuleView::default()).any());
        // Weitere Bedingung verfehlt: Wand.
        assert!(!effective_layer(Some(std::slice::from_ref(&white)), &Subject { element_kind: Some("wall"), ..screed }, RuleView::default()).any());
        // Material: Standard-Kennung oder Name; Kategorie.
        assert!(matches_condition(&cond(Material, Equals, "std-c-zementestrich"), &screed));
        assert!(matches_condition(&cond(Material, Contains, "estrich"), &screed));
        assert!(matches_condition(&cond(MaterialCategory, Equals, "screed"), &screed));
        assert!(!matches_condition(&cond(MaterialCategory, Equals, "screed"), &core));
        // Element-Regel (Ebene) mit Schicht-Aktion: auf jede Schicht; oberste Regel gewinnt je Feld.
        let mut by_layer = rule(true, cond(LayerName, Equals, "20"), None, None, None);
        by_layer.actions.hatch = Some("material".into());
        let rules = vec![white.clone(), by_layer];
        assert_eq!(effective_layer(Some(&rules), &screed, RuleView::default()).hatch.as_deref(), Some("none"));
        assert_eq!(effective_layer(Some(&rules), &core, RuleView::default()).hatch.as_deref(), Some("material"));
        // Ausgeschaltet: nichts.
        white.enabled = false;
        assert!(!effective_layer(Some(&[white]), &screed, RuleView::default()).any());
    }

    /// [33] Massstab-Kriterium (Nenner von–bis, Grenzen inklusive) und eingeschaltete Regeln eines
    /// Ausschnitts (übersteuern `enabled`).
    #[test]
    fn massstab_und_ausschnitt_regeln() {
        let mut r = rule(true, cond(LayerName, Equals, "20"), Some("#f00"), None, None);
        r.id = "r1".into();
        r.min_scale = Some(100.0);
        let rules = std::slice::from_ref(&r);
        let at = |n: f64| effective(Some(rules), &WALL, RuleView::at(n, None)).color;
        assert_eq!(at(50.0), None, "1:50 unter „ab 1:100“");
        assert_eq!(at(100.0).as_deref(), Some("#f00"));
        assert_eq!(at(200.0).as_deref(), Some("#f00"));
        // Unbekannter Massstab: Kriterium wirkt nicht.
        assert!(effective(Some(rules), &WALL, RuleView::default()).any());
        let mut r2 = r.clone();
        r2.max_scale = Some(200.0);
        assert!(scale_ok(&r2, Some(150.0)) && scale_ok(&r2, Some(200.0)) && !scale_ok(&r2, Some(500.0)) && !scale_ok(&r2, Some(20.0)));
        // Unsinnige Grenzen (0, NaN) = offen.
        r2.min_scale = Some(f64::NAN);
        r2.max_scale = Some(0.0);
        assert!(scale_ok(&r2, Some(1.0)) && scale_ok(&r2, Some(1000.0)));
        // Ausschnitt: eingeschaltete Regeln nach id, unabhängig von `enabled`.
        let none = HashSet::new();
        let only: HashSet<String> = ["r1".to_string()].into();
        assert!(!effective(Some(rules), &WALL, RuleView::at(100.0, Some(&none))).any());
        let mut off = r.clone();
        off.enabled = false;
        assert!(effective(Some(std::slice::from_ref(&off)), &WALL, RuleView::at(100.0, Some(&only))).any());
        assert!(!effective(Some(std::slice::from_ref(&off)), &WALL, RuleView::at(50.0, Some(&only))).any(), "Massstab gilt auch im Ausschnitt");
    }

    /// [33] Lage zur tragenden Schicht und Funktion aus dem Baustoff (Standard-Deckenaufbau).
    #[test]
    fn lage_zur_tragenden_schicht() {
        let mut p: Project = serde_json::from_value(serde_json::json!({"id": "p", "name": "P", "drawingLevels": [], "walls": [], "openings": [], "wallTypes": [], "lineStyles": [], "hatches": []})).unwrap();
        p.components = crate::standards::components().into_iter().map(|v| serde_json::from_value(v).unwrap()).collect();
        let l = |c: &str, t: f64| Layer { component_id: c.into(), thickness: t, ..Default::default() };
        let deck = [l("std-c-parkett", 0.015), l("std-c-zementestrich", 0.07), l("std-c-trittschall", 0.04), l("std-c-stahlbeton", 0.24), l("std-c-innenputz", 0.01)];
        assert_eq!(layer_positions(&p, &deck), ["above", "above", "above", "structure", "below"]);
        let f: Vec<_> = deck.iter().map(|x| layer_function(&p, x).and_then(function_key)).collect();
        assert_eq!(f, [Some("finish"), Some("screed"), Some("insulation"), Some("structure"), Some("plaster")]);
        // Vorgabe je Bauteil (Aufbau-Editor).
        let cf = component_functions(&p);
        assert_eq!((cf["std-c-zementestrich"], cf["std-c-stahlbeton"], cf["std-c-trittschall"]), (Some("screed"), Some("structure"), Some("insulation")));
        // Eigene Funktion schlägt den Baustoff.
        let mut own = l("std-c-holz", 0.03);
        own.function = Some(crate::model::LayerFunction::Finish);
        assert_eq!(layer_function(&p, &own), Some(crate::model::LayerFunction::Finish));
        // Ohne tragenden Baustoff: höchster Rang (Estrich vor Dämmung).
        assert_eq!(layer_positions(&p, &[l("std-c-zementestrich", 0.05), l("std-c-eps", 0.1)]), ["structure", "below"]);
        // Ohne aktive Regel: Schnellpfad, lauter leere Aktionen.
        assert!(layer_actions(&p, RuleView::default(), "slab", "30", None, &deck).iter().all(|a| !a.any()));
        p.override_rules = Some(crate::standards::override_rules().into_iter().map(|v| serde_json::from_value(v).unwrap()).collect());
        assert!(layer_actions(&p, RuleView::default(), "slab", "30", None, &deck).iter().all(|a| !a.any()), "Standardregel ist aus");
        p.override_rules.as_mut().unwrap()[0].enabled = true;
        let a = layer_actions(&p, RuleView::default(), "slab", "30", None, &deck);
        assert_eq!(a.iter().map(|x| x.styles()).collect::<Vec<_>>(), [true, true, true, false, false]);
        assert!(layer_actions(&p, RuleView::default(), "ground_slab", "30", None, &deck)[1].plain());
        assert!(!layer_actions(&p, RuleView::default(), "wall", "20", None, &deck)[1].any());
    }

    fn sample() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
    }

    /// [33] „Ausblenden“ für Grundriss/Schnitt: Element-Regeln (Bauteilart, Ebene, Darstellung), eine
    /// ausgeblendete Wand nimmt ihre Öffnungen mit; Schicht-Regeln blenden nichts aus.
    #[test]
    fn ausgeblendete_elemente() {
        let mut p = sample();
        assert!(hidden_elements(&p, RuleView::default()).is_empty());
        let mut r = rule(true, cond(ElementKind, Equals, "wall"), None, None, None);
        r.actions.hide = Some(true);
        r.conditions = Some(vec![cond(ViewKind, Equals, "section")]);
        p.override_rules = Some(vec![r.clone()]);
        assert!(hidden_elements(&p, RuleView::default().view("plan")).is_empty(), "nur im Schnitt");
        let h = hidden_elements(&p, RuleView::default().view("section"));
        assert!(p.walls.iter().all(|w| h.contains(&w.id)));
        assert!(p.openings.iter().flatten().all(|o| h.contains(&o.id)), "Öffnungen der Wand mit");
        assert!(p.ceilings.iter().flatten().all(|c| !h.contains(&c.id)));
        // Nur die Öffnungen (Ebene 21): Wände bleiben.
        r.condition = cond(LayerName, Equals, "21");
        r.conditions = None;
        p.override_rules = Some(vec![r.clone()]);
        let h = hidden_elements(&p, RuleView::default().view("plan"));
        assert!(p.walls.iter().all(|w| !h.contains(&w.id)) && p.openings.iter().flatten().all(|o| h.contains(&o.id)));
        // Schicht-Regel: blendet keine Elemente aus.
        r.condition = cond(MaterialCategory, Equals, "insulation");
        p.override_rules = Some(vec![r]);
        assert!(hidden_elements(&p, RuleView::default().view("plan")).is_empty());
    }

    /// [33] Schatten und Gelände folgen nur Regeln, die die Bauteilart ausdrücklich nennen; Linienstil und
    /// Ausblenden wirken; Linienstil aus Schicht-Regeln auf Schichten.
    #[test]
    fn schatten_gelaende_und_linienstil() {
        let mut p = sample();
        let mut general = rule(true, cond(ElementKind, NotEquals, "opening"), Some("#ff0000"), None, None);
        general.actions.fill_color = Some("#ffffff".into());
        p.override_rules = Some(vec![general.clone()]);
        assert!(shadow_override(&p, RuleView::default()).is_none(), "allgemeine Regel lässt Schatten in Ruhe");
        assert!(terrain_override(&p, RuleView::default(), Some("02"), "Gelände").is_none());
        let mut sh = rule(true, cond(ElementKind, Equals, "shadow"), None, None, None);
        sh.actions.hide = Some(true);
        let mut te = rule(true, cond(ElementKind, Equals, "terrain"), Some("#00aa00"), Some(0.5), Some("hatch-dash"));
        te.actions.fill_color = Some("#eeeeee".into());
        p.override_rules = Some(vec![sh, te, general]);
        assert!(shadow_override(&p, RuleView::default()).is_some_and(|(a, _)| a.hidden()));
        let (a, l) = terrain_override(&p, RuleView::default(), None, "Gelände").unwrap();
        assert_eq!((a.color.as_deref(), a.lineweight, a.linetype_id.as_deref(), l.fill_color.as_deref(), a.hidden()), (Some("#00aa00"), Some(0.5), Some("hatch-dash"), Some("#eeeeee"), false));
        assert_eq!(linetype_dash(&p, Some("hatch-dash")), Some(Some(vec![0.35, 0.3])));
        assert_eq!(linetype_dash(&p, Some("thin")), Some(None), "durchgezogen");
        assert_eq!(linetype_dash(&p, Some("gibts-nicht")), None);
        // Linienstil: aus Schicht-Regeln auf die Schicht, Element-Regeln nicht (Wandschichten blieben sonst neu gezeichnet).
        let s = Subject { element_kind: Some("wall"), material_category: Some("insulation"), ..WALL };
        let el = rule(true, cond(LayerName, Equals, "20"), None, None, Some("hatch-dash"));
        assert_eq!(effective_layer(Some(std::slice::from_ref(&el)), &s, RuleView::default()).linetype_id, None);
        let ly = rule(true, cond(MaterialCategory, Equals, "insulation"), None, None, Some("hatch-dash"));
        assert_eq!(effective_layer(Some(std::slice::from_ref(&ly)), &s, RuleView::default()).linetype_id.as_deref(), Some("hatch-dash"));
        p.override_rules = Some(vec![el]);
        assert!(!has_layer_actions(&p, RuleView::default()));
        p.override_rules = Some(vec![ly]);
        assert!(has_layer_actions(&p, RuleView::default()));
    }
}
