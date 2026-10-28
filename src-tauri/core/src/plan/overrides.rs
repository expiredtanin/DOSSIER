//! Grafische Overrides ([K3d]): wertet `Project.overrideRules` für ein Element aus — Rust-Gegenstück
//! zu `src/overrides/engine.ts`. Pro Aktions-Feld gewinnt die OBERSTE aktive Regel, deren Bedingung
//! passt; spätere Regeln füllen nur noch offene Felder. Vergleiche ohne Gross-/Kleinschreibung, Werte
//! getrimmt (wie JS `trim()`/`toLowerCase()`).

use crate::model::*;

/// Die vergleichbaren Eigenschaften eines Elements.
#[derive(Clone, Copy, Debug, Default)]
pub struct Subject<'a> {
    /// Name der Ebene (`LayerCategory.name`).
    pub layer_name: Option<&'a str>,
    /// Code der Ebene (`categoryCode`).
    pub layer_code: Option<&'a str>,
    /// Element-/Typ-Name (Wandtyp, Raum, Öffnungs-Label …).
    pub object_name: Option<&'a str>,
}

/// Effektive Aktionen (alle `None` = kein Override).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Actions {
    pub color: Option<String>,
    pub lineweight: Option<f64>,
    pub linetype_id: Option<String>,
}

impl Actions {
    pub fn any(&self) -> bool {
        self.color.is_some() || self.lineweight.is_some() || self.linetype_id.is_some()
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

/// `matchesCondition`: `layer_name` vergleicht Name UND Code (positive Operatoren: einer passt;
/// `not_equals`: keiner gleich), `object_name` den Element-Namen. Fehlt die Eigenschaft, trifft nur
/// `not_equals`.
pub fn matches_condition(c: &OverrideCondition, s: &Subject) -> bool {
    let value = norm(&c.value);
    let mut cands: Vec<String> = Vec::with_capacity(2);
    if c.r#type == OverrideConditionType::LayerName {
        cands.extend(s.layer_name.map(norm));
        cands.extend(s.layer_code.map(norm));
    } else {
        cands.extend(s.object_name.map(norm));
    }
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

/// `effectiveOverrides`: kollabiert die Regelliste für ein Subjekt.
pub fn effective(rules: Option<&[OverrideRule]>, s: &Subject) -> Actions {
    let mut out = Actions::default();
    let Some(rules) = rules else { return out };
    for rule in rules {
        if !rule.enabled || !matches_condition(&rule.condition, s) {
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
        if out.color.is_some() && out.lineweight.is_some() && out.linetype_id.is_some() {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const WALL: Subject = Subject { layer_name: Some("Wände"), layer_code: Some("20"), object_name: Some("AW 24") };

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
        let a = effective(Some(&rules), &WALL);
        assert_eq!(a, Actions { color: Some("#f00".into()), lineweight: Some(0.7), linetype_id: Some("dashed".into()) });
        assert!(!effective(None, &WALL).any());
        assert!(!effective(Some(&[]), &WALL).any());
    }
}
