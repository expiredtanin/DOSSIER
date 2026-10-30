//! Attribut-Auflösung (By-Layer / By-Object) und Schraffur-Auflösung des Grundriss-Generators —
//! Gegenstück zu `src/plan/generatePlan/shared.ts`.

use super::prim::HatchRender;
use crate::model::*;

pub const POCHE_STROKE: &str = "#1a1a1a";
pub const MONO_INK: &str = "#111111";
pub const LAYER_LINE_MM: f64 = 0.02;
pub const SYMBOL_HAIRLINE_MM: f64 = 0.02;
pub const OVERHEAD_DASH: [f64; 2] = [0.4, 0.25];
pub const ROOF_EAVES_MM: f64 = 0.13;
pub const ROOF_RIDGE_MM: f64 = 0.25;
pub const ROOF_HIP_MM: f64 = 0.18;
pub const ROOF_BREAK_MM: f64 = 0.09;
pub const ROOF_BREAK_DASH: [f64; 2] = [0.12, 0.08];
pub const WALL_FALLBACK_MM: f64 = 0.18;
pub const HATCH_PAPER: &str = "#f0f0f0";
pub const HATCH_INK: &str = "#0f0f0f";

/// Detailgrad der Plan-Darstellung.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Detail {
    Grob,
    Mittel,
    Fein,
}

impl Detail {
    pub fn parse(s: &str) -> Detail {
        match s {
            "grob" => Detail::Grob,
            "fein" => Detail::Fein,
            _ => Detail::Mittel,
        }
    }

    /// Stärke der Wand-Umrisslinie als Faktor auf die Ebenen-lw.
    pub fn outline_factor(self) -> f64 {
        match self {
            Detail::Grob => 1.6,
            Detail::Mittel => 1.0,
            Detail::Fein => 0.6,
        }
    }

    /// Stärke der Schichtfugen.
    pub fn layer_factor(self) -> f64 {
        match self {
            Detail::Fein => 0.7,
            _ => 1.0,
        }
    }
}

/// Schraffur-Platzhalter „ohne" (für reine Umriss-/Sammelflächen).
pub fn no_hatch() -> HatchRender {
    HatchRender {
        pattern: HatchPattern::None,
        scale: 1.0,
        angle: 0.0,
        origin: None,
        color: POCHE_STROKE.into(),
        line_weight: LAYER_LINE_MM,
        dash: None,
        kind: None,
        lines: None,
        image: None,
        gradient: None,
        seed: None,
        density: None,
        length_min: None,
        length_max: None,
        motif: None,
        polar: None,
    }
}

/// Neutrale Poché-Füllfarbe für ein Muster: „solid" → Tinte, sonst Papier.
pub fn poche_fill(p: HatchPattern) -> &'static str {
    if p == HatchPattern::Solid {
        HATCH_INK
    } else {
        HATCH_PAPER
    }
}

/// `resolveHatch`: `None`, wenn die Schraffur fehlt. Ein hängender Linienstil der Schraffur
/// (Datei/Import) zählt wie keiner (Vorgabe-Strichstärke 0.13, durchgezogen).
pub fn resolve_hatch(p: &Project, hatch_id: &str, wall_angle_deg: Option<f64>, foreground: Option<&str>, placement: Option<(Option<f64>, Option<f64>, Option<Vec2>)>) -> Option<HatchRender> {
    let h = p.hatch(hatch_id)?;
    let ls = h.line_style_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.line_style(id));
    let (p_angle, p_scale, p_origin) = placement.unwrap_or((None, None, None));
    let base_angle = p_angle.unwrap_or(h.angle);
    let angle = match wall_angle_deg {
        Some(w) if h.relative_to_wall == Some(true) => base_angle - w,
        _ => base_angle,
    };
    Some(HatchRender {
        pattern: h.pattern,
        scale: h.scale * p_scale.unwrap_or(1.0),
        angle,
        origin: p_origin,
        color: foreground.unwrap_or(HATCH_INK).to_string(),
        line_weight: h.line_weight.unwrap_or(0.13),
        dash: ls.and_then(|l| l.dash.clone()),
        kind: h.kind,
        lines: h.lines,
        image: h.image.clone(),
        gradient: h.gradient.clone(),
        seed: h.seed,
        density: h.density,
        length_min: h.length_min,
        length_max: h.length_max,
        motif: h.motif.clone(),
        polar: None,
    })
}

/// Vordergrundfarbe der Schraffur: Override ?? (Quelle „layer" ⇒ Kategorie-Farbe) ?? Bauteil.
pub fn resolve_foreground<'a>(comp: &'a Component, override_: Option<&'a str>, category: Option<&'a LayerCategory>, source: Option<AttributeSource>) -> Option<&'a str> {
    if let Some(o) = override_ {
        return Some(o);
    }
    if source == Some(AttributeSource::Layer) {
        return category.map(|c| c.color.as_str()).or(comp.foreground.as_deref());
    }
    comp.foreground.as_deref()
}

/// Hintergrund-/Füllfarbe (Poché-Override), analog [`resolve_foreground`].
pub fn resolve_background<'a>(comp: &'a Component, override_: Option<&'a str>, category: Option<&'a LayerCategory>, source: Option<AttributeSource>) -> Option<&'a str> {
    if let Some(o) = override_ {
        return Some(o);
    }
    if source == Some(AttributeSource::Layer) {
        return category.map(|c| c.color.as_str()).or(comp.background.as_deref());
    }
    comp.background.as_deref()
}

/// Schraffur-Referenz: Override ?? (Quelle „layer" ⇒ Kategorie-Schraffur) ?? Rückfall.
pub fn resolve_hatch_id<'a>(override_: Option<&'a str>, source: Option<AttributeSource>, category: Option<&'a LayerCategory>, fallback: Option<&'a str>) -> Option<&'a str> {
    if let Some(o) = override_ {
        return Some(o);
    }
    if source == Some(AttributeSource::Layer) {
        return category.and_then(|c| c.hatch.as_deref()).or(fallback);
    }
    fallback
}

/// Strichstärke: Override ?? (Quelle „layer" ⇒ Kategorie-lw) ?? Rückfall.
pub fn resolve_stroke_weight(override_: Option<f64>, source: Option<AttributeSource>, category: Option<&LayerCategory>, fallback: f64) -> f64 {
    if let Some(o) = override_ {
        return o;
    }
    if source == Some(AttributeSource::Layer) {
        return category.map_or(fallback, |c| c.lw);
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = include_str!("../../tests/fixtures/sample_project.json");

    /// Bauteil mit Vorder-/Hintergrund und Kategorie mit Farbe, Schraffur, Strichstärke (früher `shared.resolve.test.ts`).
    fn comp_cat() -> (Component, LayerCategory) {
        let p: Project = serde_json::from_str(SAMPLE).unwrap();
        let mut comp = p.components.first().cloned().expect("Bauteil");
        comp.foreground = Some("#112233".into());
        comp.background = Some("#445566".into());
        let mut cat = p.flat_categories().first().map(|c| (*c).clone()).expect("Kategorie");
        cat.color = "#abcdef".into();
        cat.hatch = Some("sia-wall".into());
        cat.lw = 0.5;
        (comp, cat)
    }

    #[test]
    fn vorder_hintergrund_default_nach_bauteil() {
        let (comp, cat) = comp_cat();
        for src in [None, Some(AttributeSource::Object)] {
            assert_eq!(resolve_foreground(&comp, None, Some(&cat), src), Some("#112233"));
            assert_eq!(resolve_background(&comp, None, Some(&cat), src), Some("#445566"));
        }
        assert_eq!(resolve_foreground(&comp, None, Some(&cat), Some(AttributeSource::Layer)), Some("#abcdef"));
        assert_eq!(resolve_background(&comp, None, Some(&cat), Some(AttributeSource::Layer)), Some("#abcdef"));
        assert_eq!(resolve_foreground(&comp, Some("#ff00ff"), Some(&cat), Some(AttributeSource::Layer)), Some("#ff00ff"));
        assert_eq!(resolve_foreground(&comp, Some("#ff00ff"), Some(&cat), None), Some("#ff00ff"));
    }

    #[test]
    fn schraffur_und_strichstaerke_nach_ebene() {
        let (_, cat) = comp_cat();
        assert_eq!(resolve_hatch_id(None, None, Some(&cat), Some("eigene")), Some("eigene"));
        assert_eq!(resolve_hatch_id(None, Some(AttributeSource::Layer), Some(&cat), Some("eigene")), Some("sia-wall"));
        assert_eq!(resolve_stroke_weight(None, None, Some(&cat), 0.13), 0.13);
        assert_eq!(resolve_stroke_weight(None, Some(AttributeSource::Layer), Some(&cat), 0.13), 0.5);
    }

    #[test]
    fn motiv_und_verlauf_unveraendert_durchgereicht() {
        let mut v: serde_json::Value = serde_json::from_str(SAMPLE).unwrap();
        v["hatches"] = json!([
            {"id": "h-custom", "name": "Motiv", "pattern": "custom", "scale": 1, "angle": 0, "color": "#000",
             "motif": {"points": [{"x": 0, "y": 0}, {"x": 2, "y": 1}, {"x": 4, "y": 0}], "length": 4}},
            {"id": "h-grad", "name": "Verlauf", "kind": "gradient", "pattern": "diagonal", "scale": 1, "angle": 0, "color": "#000",
             "gradient": {"color1": "#ffffff", "color2": "#000000", "angle": 45, "type": "radial"}},
            {"id": "h-diag", "name": "Diagonal", "pattern": "diagonal", "scale": 1, "angle": 30, "color": "#000", "relativeToWall": true}
        ]);
        let p: Project = serde_json::from_value(v).unwrap();
        let m = resolve_hatch(&p, "h-custom", None, None, None).unwrap();
        assert_eq!(serde_json::to_value(&m.motif).unwrap()["length"], json!(4.0));
        let g = resolve_hatch(&p, "h-grad", None, None, None).unwrap();
        assert!(g.gradient.is_some() && g.kind.is_some());
        let d = resolve_hatch(&p, "h-diag", Some(90.0), None, None).unwrap();
        assert!(d.motif.is_none() && d.gradient.is_none());
        assert_eq!(d.angle, -60.0);
        assert_eq!(resolve_hatch(&p, "h-diag", None, None, None).unwrap().angle, 30.0);
        assert_eq!(d.color, HATCH_INK);
    }
}
