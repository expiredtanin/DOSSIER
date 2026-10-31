//! Darstellungs-Auflösung aus dem Modell ([K4] S2): Farben, Schraffur und Schnitt-Linienstil, wie sie
//! `src/plan/generatePlan/shared.ts` und `src/plan/toWalls3d/shared.ts` aus dem `Project` ableiten.

use crate::model::{HatchPattern, Project};
use serde::Serialize;

pub type Rgb = [f64; 3];

/// Warmer, neutraler Wand-Grundton (wie render3d).
pub const WALL_RGB: Rgb = [0.82, 0.8, 0.76];
/// Etwas hellerer, kühlerer Ton für Deckenplatten.
pub const SLAB_RGB: Rgb = [0.86, 0.86, 0.88];
/// Fallback-Farbe für Linien ohne Farbe ("#888888").
pub const DRAWING_LINE_FALLBACK_RGB: Rgb = [0x88 as f64 / 255.0, 0x88 as f64 / 255.0, 0x88 as f64 / 255.0];

/// "#rrggbb" → RGB 0..1; ungültiges Format → `fallback`.
pub fn hex_to_rgb(hex: &str, fallback: Rgb) -> Rgb {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return fallback;
    }
    let v = u32::from_str_radix(h, 16).unwrap_or(0);
    [((v >> 16) & 0xff) as f64 / 255.0, ((v >> 8) & 0xff) as f64 / 255.0, (v & 0xff) as f64 / 255.0]
}

/// Schnitt-Schraffur eines Bauteil-Bandes für den 3D-Live-Schnitt (`RHatch` in TS).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RHatch {
    pub pattern: f64,
    pub angle: f64,
    pub scale: f64,
    pub line_weight: f64,
    pub base_angle: f64,
    pub relative_to_wall: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_angle: Option<f64>,
}

fn pattern_id(p: HatchPattern) -> f64 {
    match p {
        HatchPattern::Solid => 1.0,
        HatchPattern::Diagonal => 2.0,
        HatchPattern::Crosshatch => 3.0,
        // Ab 4: Muster-Code des Kern-Generators (render3d zeichnet die Linien selbst, [109]).
        HatchPattern::Insulation => 4.0,
        HatchPattern::InsulationHard => 6.0,
        HatchPattern::InsulationWave => 7.0,
        HatchPattern::Timber => 8.0,
        HatchPattern::Earth => 9.0,
        HatchPattern::Gravel => 10.0,
        HatchPattern::Stone => 11.0,
        HatchPattern::Dots => 12.0,
        HatchPattern::WoodBased => 13.0,
        HatchPattern::Wood => 14.0,
        HatchPattern::Barrier => 15.0,
        _ => 0.0,
    }
}

/// Aufgelöste Schraffur (Kern von `resolveHatch`): Muster, Massstab, Endwinkel, Musterlinien-Stärke.
/// `None`, wenn die Schraffur fehlt; ein hängender Linienstil zählt wie keiner (0.13).
pub struct HatchCore {
    pub pattern: HatchPattern,
    pub scale: f64,
    pub angle: f64,
    pub line_weight: f64,
}

pub fn resolve_hatch_core(p: &Project, hatch_id: &str, wall_angle_deg: Option<f64>) -> Option<HatchCore> {
    let h = p.hatch(hatch_id)?;
    let base = h.angle;
    let angle = match wall_angle_deg {
        Some(w) if h.relative_to_wall == Some(true) => base - w,
        _ => base,
    };
    Some(HatchCore { pattern: h.pattern, scale: h.scale * 1.0, angle, line_weight: h.line_weight.unwrap_or(0.13) })
}

/// Schnitt-Schraffur eines Bauteils (`resolveComponentHatch`); `axis_angle_deg` 90 für Wand-Bänder,
/// `None` für Decken.
pub fn resolve_component_hatch(p: &Project, component_id: &str, axis_angle_deg: Option<f64>) -> Option<RHatch> {
    let comp = p.component(component_id)?;
    if comp.hatch_id.is_empty() {
        return None;
    }
    let hr = resolve_hatch_core(p, &comp.hatch_id, axis_angle_deg)?;
    let abs = resolve_hatch_core(p, &comp.hatch_id, None)?;
    let relative = resolve_hatch_core(p, &comp.hatch_id, Some(90.0))?.angle != abs.angle;
    Some(RHatch {
        pattern: pattern_id(hr.pattern),
        angle: hr.angle,
        scale: hr.scale,
        line_weight: hr.line_weight,
        base_angle: abs.angle,
        relative_to_wall: relative,
        top_angle: None,
    })
}

/// Schnitt-Schraffur der dicksten Schicht (`dominantLayerHatch`).
pub fn dominant_layer_hatch(p: &Project, layers: &[crate::model::Layer], axis_angle_deg: Option<f64>) -> Option<RHatch> {
    let dominant = dominant_layer(layers)?;
    resolve_component_hatch(p, &dominant.component_id, axis_angle_deg)
}

/// Dickste Schicht (bei Gleichstand die erste).
pub fn dominant_layer(layers: &[crate::model::Layer]) -> Option<&crate::model::Layer> {
    let mut best = layers.first()?;
    for l in layers {
        if l.thickness > best.thickness {
            best = l;
        }
    }
    Some(best)
}

/// Repräsentative Farbe der dicksten Schicht (`dominantLayerColor`).
pub fn dominant_layer_color(p: &Project, layers: &[crate::model::Layer], fallback: Rgb) -> Rgb {
    match dominant_layer(layers).and_then(|d| p.component(&d.component_id)) {
        Some(c) => hex_to_rgb(&c.color, fallback),
        None => fallback,
    }
}

/// Stil der Schnitt-Umrisslinie einer Schicht (`resolveCutLineStyle`): Farbe aus dem Linienstil der
/// Fuge, Stärke aus der Schicht (`jointWeightMm`, [110]) — beide unabhängig optional.
pub fn resolve_cut_line_style(p: &Project, layer: &crate::model::Layer) -> (Option<Rgb>, Option<f64>) {
    let id = layer.joint_line_style_id.as_deref().filter(|s| !s.is_empty());
    let ls = id.and_then(|id| p.line_styles.iter().find(|l| l.id == id));
    (ls.map(|ls| hex_to_rgb(&ls.color, DRAWING_LINE_FALLBACK_RGB)), layer.joint_weight_mm.filter(|w| w.is_finite() && *w > 0.0))
}
