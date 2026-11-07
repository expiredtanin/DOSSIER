//! Attribut-Auflösung (By-Layer / By-Object) und Schraffur-Auflösung des Grundriss-Generators —
//! Gegenstück zu `src/plan/generatePlan/shared.ts`.

use super::prim::HatchRender;
use crate::model::*;

pub const POCHE_STROKE: &str = "#1a1a1a";
pub const MONO_INK: &str = "#111111";
pub const LAYER_LINE_MM: f64 = 0.02;
pub const SYMBOL_HAIRLINE_MM: f64 = 0.02;
/// [140] Feine Symbol-Linien der Türen/Fenster im Grundriss (Blatt, Aufschlag, Rahmen, Bank), solange der Typ
/// keine eigene Stärke trägt; 0.1 nach Wunsch Maintainer (5.11.). Glas: `GLASS_LINE_MM`.
pub const SYMBOL_LINE_MM: f64 = 0.1;
/// Glasscheiben (Fenster im Grundriss und im Schnitt): feinste Linie, Wunsch Maintainer 5.11. ([140]).
pub const GLASS_LINE_MM: f64 = 0.02;
/// [140] Schichtfugen im Wandschnitt ohne eigene Fugenstärke (`Layer.jointWeightMm`): fein, aber druckbar
/// (vorher 0.02); bewusst unter der Schraffur-Stärke, damit dünne Schichten in 1:100 nicht zulaufen.
pub const LAYER_JOINT_MM: f64 = 0.09;
/// Kanten über der Schnittebene (Decken-/Dachränder, Bauteile „über Schnitt"): Strichpunktlinie
/// (Strich, Lücke, Punkt, Lücke; Punkt = Länge 0 mit runder Kappe), Papier-mm ([153]).
pub const OVERHEAD_DASH: [f64; 4] = super::line_pattern::OVERHEAD;
pub const ROOF_EAVES_MM: f64 = 0.13;
pub const ROOF_RIDGE_MM: f64 = 0.25;
pub const ROOF_HIP_MM: f64 = 0.18;
pub const ROOF_BREAK_MM: f64 = 0.09;
pub const ROOF_BREAK_DASH: [f64; 2] = super::line_pattern::HIDDEN;
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
            // [140] Fein (1:50/1:20) behält die volle Schnittkante (vorher 0.6 — dünner als die
            // Fugen-Rangfolge verlangt); Grob (1:200/1:500, Vollpoché) etwas kräftiger.
            Detail::Grob => 1.2,
            Detail::Mittel => 1.0,
            Detail::Fein => 1.0,
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

/// [140] Dünne Schichten (Putz, Parkett, Trittschall, Folien, dünne Dämmung) unter dieser Papierdicke (mm)
/// werden ab [`THIN_FROM_SCALE`] nicht als eigene Schicht mit Fugen gezeichnet: sonst laufen Umriss, Fuge und
/// Schraffur in 1:100 zu einem schwarzen Balken zusammen. Eine Regel für Wände im Grundriss
/// (`walls::thin_layer_targets`) und Schnitt-Schichten (`section::merge_thin_cuts`, `plain_thin_insulation`).
pub const THIN_LAYER_PAPER_MM: f64 = 0.5;
/// [140] Ab diesem Massstab (1:50 und kleiner) werden dünne Schichten vereinfacht (Teil 5: ab 1:100 sind
/// Schnittflächen ohnehin schwarz, [`solid_cut`] — die Regel wirkt v. a. im 1:50); 1:20/1:25 zeigt alle.
pub const THIN_FROM_SCALE: f64 = 50.0;

/// [140] Werden bei Detailgrad `detail` und 1:`scale` dünne Schichten vereinfacht? „fein" zeigt immer alle,
/// ebenso Massstäbe grösser als 1:50 (und ein unbekannter Massstab 0/NaN).
pub fn simplify_thin_layers(detail: Detail, scale: f64) -> bool {
    detail != Detail::Fein && scale.is_finite() && scale >= THIN_FROM_SCALE
}

/// [140] Ab diesem Massstab (1:75 und kleiner, also 1:100) sind Schnittflächen schwarz.
pub const SOLID_CUT_FROM: f64 = 75.0;

/// [140] Schnittflächen (Wände, Stützen, Körper im Grundriss; alle geschnittenen Bauteile im Schnitt) als
/// volle schwarze Fläche ohne Schichtfugen und Schraffur, nur mit Umriss (Vorgabe Maintainer: „Schraffur-
/// Bauteile im 1:50 zeigen, das 1:100 wird i. d. R. schwarz angezeigt")? Ab 1:100 ja, Detail „grob" immer;
/// „fein" und `cut_hatch` (Feld der Ebene/Ansichtsvorlage „Schnittflächen schraffiert") behalten die
/// Schichten mit Schraffur.
pub fn solid_cut(detail: Detail, scale: f64, cut_hatch: bool) -> bool {
    detail == Detail::Grob || (!cut_hatch && detail != Detail::Fein && scale.is_finite() && scale >= SOLID_CUT_FROM)
}

/// [140] Ist eine Schicht der Dicke `thickness_m` (Meter) bei 1:`scale` auf dem Papier dünn
/// (unter [`THIN_LAYER_PAPER_MM`])? Nur zusammen mit [`simplify_thin_layers`] verwenden.
pub fn is_thin_layer(thickness_m: f64, scale: f64) -> bool {
    !(thickness_m * 1000.0 / scale >= THIN_LAYER_PAPER_MM)
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

/// [141] Drehung einer wandbezogenen Schraffur. Kreuzschraffur und Diagonale unter 45° zur Achse sehen
/// um 90° gedreht gleichwertig aus (45° zur Achse bleibt 45° zur Achse); sie drehen nur um den Rest der
/// Wandrichtung modulo 90° mit — so laufen sie an rechtwinkligen Ecken, T- und Kreuzstössen (und zwischen
/// gleich schräg gestellten Wänden) ohne Fischgrat-Knick durch. Gerichtete Muster (Dämmung, Holz …)
/// und Linien längs/quer zur Achse (Dämmung, Putz als Längsstriche) folgen weiter der vollen Wandrichtung.
pub fn wall_turn(pattern: HatchPattern, base_angle_deg: f64, wall_angle_deg: f64) -> f64 {
    let diagonal = ((base_angle_deg.rem_euclid(90.0)) - 45.0).abs() < 1e-6;
    match pattern {
        HatchPattern::Crosshatch | HatchPattern::Diagonal if wall_angle_deg.is_finite() && (diagonal || pattern == HatchPattern::Crosshatch) => {
            let r = wall_angle_deg.rem_euclid(90.0);
            // Rundungsrest knapp unter 90° (z. B. 89.9999999) zählt als 0.
            if 90.0 - r < 1e-9 {
                0.0
            } else {
                r
            }
        }
        _ => wall_angle_deg,
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
        Some(w) if h.relative_to_wall == Some(true) => base_angle - wall_turn(h.pattern, base_angle, w),
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

    #[test]
    fn diagonale_dreht_modulo_90_daemmung_voll() {
        assert_eq!(wall_turn(HatchPattern::Diagonal, 45.0, 90.0), 0.0);
        assert_eq!(wall_turn(HatchPattern::Diagonal, 45.0, -90.0), 0.0);
        assert_eq!(wall_turn(HatchPattern::Diagonal, -45.0, 180.0), 0.0);
        assert!((wall_turn(HatchPattern::Crosshatch, 0.0, 120.0) - 30.0).abs() < 1e-12);
        assert!((wall_turn(HatchPattern::Diagonal, 45.0, 89.99999999999) - 0.0).abs() < 1e-12);
        // Längsstriche (Dämmung als Linien längs der Wand) und gerichtete Muster: volle Drehung.
        assert_eq!(wall_turn(HatchPattern::Diagonal, 0.0, 90.0), 90.0);
        assert_eq!(wall_turn(HatchPattern::Insulation, 45.0, 90.0), 90.0);
        assert_eq!(wall_turn(HatchPattern::Timber, 0.0, -90.0), -90.0);
    }

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

#[cfg(test)]
mod thin_tests {
    use super::*;

    /// [140] Eine Regel: unter 0.5 mm Papier ist dünn (5 cm in 1:100, 10 cm in 1:200), ab 1:75 ausser „fein".
    #[test]
    fn duenne_schicht_regel() {
        assert!(simplify_thin_layers(Detail::Mittel, 100.0) && simplify_thin_layers(Detail::Grob, 200.0));
        assert!(simplify_thin_layers(Detail::Mittel, 50.0), "Teil 5: auch 1:50");
        assert!(!simplify_thin_layers(Detail::Mittel, 20.0) && !simplify_thin_layers(Detail::Fein, 100.0));
        assert!(!simplify_thin_layers(Detail::Mittel, 0.0) && !simplify_thin_layers(Detail::Mittel, f64::NAN));
        assert!(is_thin_layer(0.015, 100.0) && is_thin_layer(0.04, 100.0) && is_thin_layer(0.0499, 100.0));
        assert!(!is_thin_layer(0.06, 100.0) && !is_thin_layer(0.05, 100.0));
        assert!(is_thin_layer(0.08, 200.0) && !is_thin_layer(0.04, 50.0) && is_thin_layer(0.02, 50.0));
    }

    /// [140] Schnittflächen: 1:100 schwarz, 1:50 schraffiert; „fein" und `cutHatch` schraffiert, „grob" schwarz.
    #[test]
    fn schnittflaeche_schwarz_ab_1_100() {
        assert!(solid_cut(Detail::Mittel, 100.0, false) && solid_cut(Detail::Mittel, 200.0, false));
        assert!(!solid_cut(Detail::Mittel, 50.0, false) && !solid_cut(Detail::Fein, 100.0, false));
        assert!(!solid_cut(Detail::Mittel, 100.0, true), "Vorlage: schraffiert");
        assert!(solid_cut(Detail::Grob, 50.0, true) && !solid_cut(Detail::Mittel, f64::NAN, false));
    }
}
