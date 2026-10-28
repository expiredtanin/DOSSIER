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

/// `resolveHatch`: `None`, wenn Schraffur oder ihr Linienstil fehlen (TS wirft dort — Aufrufer fängt).
pub fn resolve_hatch(p: &Project, hatch_id: &str, wall_angle_deg: Option<f64>, foreground: Option<&str>, placement: Option<(Option<f64>, Option<f64>, Option<Vec2>)>) -> Option<HatchRender> {
    let h = p.hatch(hatch_id)?;
    let ls = match h.line_style_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(p.line_style(id)?),
        None => None,
    };
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
        line_weight: ls.map_or(0.13, |l| l.weight),
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
