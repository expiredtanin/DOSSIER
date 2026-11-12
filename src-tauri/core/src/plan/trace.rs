//! [205] Pausfolie (Archicad „Pausfolie & Referenz“): eine andere Ansicht — Geschoss, Schnitt, Ansicht,
//! Zeichnung, Deckenspiegel — gedämpft hinter (oder über) der aktiven Ansicht, nur Anzeige.
//!
//! Die Quelle rechnen die bestehenden Abfragen (`planDomains`, `sectionPlan`, `elevationPlan`); die TS-Seite
//! schickt sie als Teil-Abfragen (`parts`) mit, so wie sie sie für die Quelle selbst stellen würde (keine
//! Doppelspur). Hier kommt nur dazu:
//!
//! 1. **Ausrichtung** je nach Koordinatenraum von Quelle und Ziel ([`align_for`]): Grundriss-artige Ebenen
//!    (Geschoss, Zeichnung, Deckenspiegel) teilen X/Y, Schnitte/Ansichten (u, Höhe). Schnitt hinter Grundriss:
//!    der Schnitt wird an seiner Schnittlinie aufgeklappt (u längs der Linie, Höhe in Blickrichtung, jenseits
//!    des Grundrisses); Grundriss hinter Schnitt: wie die Grundriss-Unterlage (`underlay.rs`, darunter, u wie
//!    im Schnitt). Gleicher Raum: deckungsgleich (Schnitt hinter Schnitt: gleiche Höhen).
//! 2. **Verschieben/Drehen** der Pause durch die Nutzerin ([`TraceArgs::offset`], `rotation` in Grad um den
//!    Ursprung, danach verschoben): reine Starrkörper-Abbildung über `underlay::map_primitive`.
//! 3. **Darstellung** ([`styled`]): ohne Auswahl-Ids (nie anwählbar), in einer Farbe (Grau oder gewählt), zur
//!    Papierfarbe hin aufgehellt nach Deckkraft; Füllungen nur sehr hell (unter) bzw. keine (über der Ansicht).
//!    Die Farbe steht in den Primitiven selbst — alle drei Zeichenwege (WebGPU, Metal, SVG) zeigen sie ohne
//!    eigene Logik.

use super::prim::Primitive;
use super::section::LevelSpec;
use super::underlay::{map_primitive, section_map, SectionMap};
use crate::jsmath::hypot2;
use crate::model::{DrawingLevelKind, Project, Vec2};

/// Abstand (Meter) zwischen aufgeklapptem Schnitt und Grundriss (wie die Grundriss-Unterlage).
pub const GAP_M: f64 = super::underlay::GAP_M;

/// Strichklasse der Pausfolien-Linien (keine CSS-Farbe, keine Sonderbehandlung).
pub const TRACE_CLS: &str = "trace-ref";

/// Standardfarbe der Pause (Grau), wenn keine Farbe gewählt ist.
pub const DEFAULT_COLOR: &str = "#6b6b6b";

/// Eine Teil-Abfrage der Quelle (Name, Zahl-Argumente, Text wie für die Quelle selbst).
#[derive(serde::Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Part {
    pub name: String,
    pub args: Vec<f64>,
    pub text: String,
}

/// Argumente der Abfrage `tracePlan`.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct TraceArgs {
    pub parts: Vec<Part>,
    /// Quell-Ebene (`DrawingLevel.id`).
    pub source: String,
    /// Aktive Ebene, hinter der die Pause liegt.
    pub active: String,
    /// Ausmass der aktiven Ansicht `[minX, minY, maxX, maxY]` (für das Aufklappen/Unterlegen).
    pub active_bounds: Option<[f64; 4]>,
    /// Farbe (`#rrggbb`); fehlt = Grau.
    pub color: Option<String>,
    /// Deckkraft 0…1 (zur Papierfarbe hin aufgehellt).
    pub opacity: f64,
    /// Verschiebung in Metern (nach der Drehung).
    pub offset: Vec2,
    /// Drehung in Grad, CCW um den Ursprung.
    pub rotation: f64,
    /// Über statt unter der aktiven Ansicht (dann ohne Füllungen).
    pub above: bool,
}

impl Default for TraceArgs {
    fn default() -> Self {
        TraceArgs { parts: vec![], source: String::new(), active: String::new(), active_bounds: None, color: None, opacity: 0.5, offset: Vec2 { x: 0.0, y: 0.0 }, rotation: 0.0, above: false }
    }
}

impl TraceArgs {
    pub fn parse(text: &str) -> Result<TraceArgs, String> {
        let a: TraceArgs = serde_json::from_str(text).map_err(|e| format!("tracePlan: {e}"))?;
        if a.parts.iter().any(|p| p.name == "tracePlan") {
            return Err("tracePlan: verschachtelt".into());
        }
        Ok(a)
    }
}

/// Grundriss-artige Ebene (Koordinaten X/Y in Metern)?
fn is_plan_like(k: &DrawingLevelKind) -> bool {
    matches!(k, DrawingLevelKind::Floor | DrawingLevelKind::Drawing | DrawingLevelKind::Ceiling)
}

fn is_view_like(k: &DrawingLevelKind) -> bool {
    matches!(k, DrawingLevelKind::Section | DrawingLevelKind::Elevation)
}

fn level_spec(l: &crate::model::DrawingLevel) -> LevelSpec {
    LevelSpec::from_json(&serde_json::to_value(l).unwrap_or_default())
}

/// Starrkörper-Abbildung p' = R(θ)·p + t als `SectionMap` (Ursprung so, dass R(p − p0) = R p + t).
pub fn rigid(theta: f64, t: Vec2) -> SectionMap {
    let (s, c) = (crate::jsnum::sin(theta), crate::jsnum::cos(theta));
    // p0 = −Rᵀ t
    let p0 = Vec2 { x: -(c * t.x + s * t.y), y: -(-s * t.x + c * t.y) };
    SectionMap { p0, u: Vec2 { x: c, y: -s }, n: Vec2 { x: s, y: c }, theta, dy: 0.0 }
}

/// Wie die Pause auf die aktive Ansicht gelegt wird (vor dem Verschieben/Drehen der Nutzerin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Align {
    /// Deckungsgleich (gleicher Koordinatenraum).
    Same,
    /// Schnitt/Ansicht an der Linie in den Grundriss aufgeklappt.
    Fold,
    /// Grundriss ausgerichtet unter den Schnitt / die Ansicht (wie `underlay.rs`).
    Under,
}

/// Ausrichtung aus den Arten von Quelle und Ziel.
pub fn align_for(source: &DrawingLevelKind, active: &DrawingLevelKind, source_has_line: bool, active_has_line: bool) -> Align {
    if is_plan_like(active) && is_view_like(source) && source_has_line {
        Align::Fold
    } else if is_view_like(active) && is_plan_like(source) && active_has_line {
        Align::Under
    } else {
        Align::Same
    }
}

fn each_point(pr: &Primitive, f: &mut impl FnMut(f64, f64)) {
    match pr {
        Primitive::Polygon { pts, .. } => pts.iter().for_each(|q| f(q.x, q.y)),
        Primitive::Line { a, b, .. } => {
            f(a.x, a.y);
            f(b.x, b.y);
        }
        Primitive::Arc { from, to, center, r, .. } => {
            f(from.x, from.y);
            f(to.x, to.y);
            f(center.x - r, center.y - r);
            f(center.x + r, center.y + r);
        }
        Primitive::Text { at, .. } | Primitive::DrawingText { at, .. } => f(at.x, at.y),
        Primitive::DrawingTextPath { path_pts, .. } => path_pts.iter().for_each(|q| f(q.x, q.y)),
        Primitive::DrawingCircle { center, r, .. } | Primitive::DrawingArc { center, r, .. } => {
            f(center.x - r, center.y - r);
            f(center.x + r, center.y + r);
        }
        Primitive::DrawingImage { min, max, .. } => {
            f(min.x, min.y);
            f(max.x, max.y);
        }
    }
}

/// Ausmass einer Primitiv-Liste; `None` ohne (endliche) Punkte.
pub fn bounds_of(prims: &[Primitive]) -> Option<[f64; 4]> {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for pr in prims {
        each_point(pr, &mut |x, y| {
            if x.is_finite() && y.is_finite() {
                b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
            }
        });
    }
    (b[0] <= b[2]).then_some(b)
}

/// Schnitt/Ansicht (u, Höhe) in den Grundriss aufklappen: u längs der Schnittlinie (wie `Plane::u_model`), die
/// Höhe in Blickrichtung `n`, unterste Kante `GAP_M` jenseits der aktiven Grundriss-Ausdehnung (in `n`), damit
/// die Pause nicht über dem Gebäude liegt. Mit `n` nach oben gedreht steht der Schnitt aufrecht darüber.
pub fn fold_map(line: [Vec2; 2], direction_sign: Option<f64>, source_min_v: f64, active_bounds: Option<[f64; 4]>) -> Option<SectionMap> {
    let m = section_map(line, direction_sign)?;
    let p0 = m.p0;
    // Ausdehnung des aktiven Grundrisses in Blickrichtung (Ecken des Ausmasses, auf n projiziert).
    let top = active_bounds.map_or(0.0, |[x0, y0, x1, y1]| {
        [(x0, y0), (x1, y0), (x0, y1), (x1, y1)].iter().map(|&(x, y)| (x - p0.x) * m.n.x + (y - p0.y) * m.n.y).fold(0.0f64, f64::max)
    });
    // Spalten der Drehung: Bild von x = u-Achse, Bild von y = n (det +1, keine Spiegelung).
    let theta = crate::jsnum::atan2(m.u.y, m.u.x);
    let shift = top + GAP_M - source_min_v;
    Some(rigid(theta, Vec2 { x: p0.x + m.n.x * shift, y: p0.y + m.n.y * shift }))
}

/// Pausen-Primitive: Quelle (`prims`, Teil-Abfragen in Reihenfolge) ausgerichtet, verschoben/gedreht, gefärbt.
pub fn trace_primitives(p: &Project, a: &TraceArgs, prims: Vec<Primitive>) -> Vec<Primitive> {
    let find = |id: &str| p.drawing_levels.iter().find(|l| l.id == id);
    let (Some(src), Some(act)) = (find(&a.source), find(&a.active)) else { return vec![] };
    if src.id == act.id || prims.is_empty() {
        return vec![];
    }
    let (ss, sa) = (level_spec(src), level_spec(act));
    let has = |l: &LevelSpec| l.line.is_some_and(|[a, b]| hypot2(b.x - a.x, b.y - a.y) >= 1e-9);
    let placed: Vec<Primitive> = match align_for(&src.kind, &act.kind, has(&ss), has(&sa)) {
        Align::Same => prims,
        Align::Fold => {
            let min_v = bounds_of(&prims).map_or(0.0, |b| b[1]);
            match fold_map(ss.line.unwrap(), ss.direction_sign, min_v, a.active_bounds) {
                Some(m) => prims.into_iter().filter_map(|q| map_primitive(&m, q)).collect(),
                None => prims,
            }
        }
        Align::Under => {
            let min_y = a.active_bounds.map_or(0.0, |b| b[1]);
            super::underlay::underlay_for_level(&sa, prims, min_y)
        }
    };
    let rot = a.rotation.to_radians();
    let moved = a.offset.x != 0.0 || a.offset.y != 0.0 || rot != 0.0;
    let m = rigid(if rot.is_finite() { rot } else { 0.0 }, Vec2 { x: fin(a.offset.x), y: fin(a.offset.y) });
    let color = a.color.as_deref().filter(|c| super::buf::parse_color(c).is_some()).unwrap_or(DEFAULT_COLOR);
    let opacity = if a.opacity.is_finite() { a.opacity.clamp(0.05, 1.0) } else { 0.5 };
    let tone = Tone::new(color, opacity);
    placed.into_iter().filter_map(|q| if moved { map_primitive(&m, q) } else { Some(q) }).map(|q| styled(q, &tone, a.above)).collect()
}

fn fin(x: f64) -> f64 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

/// Farbe der Pause: Strich (nach Deckkraft zur Papierfarbe aufgehellt) und Füllung (deutlich heller).
pub struct Tone {
    pub stroke: String,
    pub fill: String,
}

impl Tone {
    pub fn new(color: &str, opacity: f64) -> Tone {
        let c = super::buf::parse_color(color).unwrap_or([0.42, 0.42, 0.42, 1.0]);
        let mix = |k: f64| -> String {
            let ch = |v: f64| ((1.0 - k) + v * k).clamp(0.0, 1.0);
            let h = |v: f64| crate::jsnum::round(ch(v) * 255.0) as u8;
            format!("#{:02x}{:02x}{:02x}", h(c[0]), h(c[1]), h(c[2]))
        };
        Tone { stroke: mix(opacity), fill: mix(opacity * 0.15) }
    }
}

fn has_fill(f: &str) -> bool {
    super::buf::parse_color(f).is_some_and(|c| c[3] > 0.0)
}

/// Eine Pausen-Primitive: ohne Auswahl-Ids, in der Pausenfarbe, nicht gedimmt (die Farbe trägt die Dämpfung).
pub fn styled(pr: Primitive, t: &Tone, above: bool) -> Primitive {
    let s = || t.stroke.clone();
    match pr {
        Primitive::Polygon { pts, fill, stroke, stroke_width_mm, mut hatch, no_stroke_edges, .. } => {
            hatch.color = t.stroke.clone();
            let fill = if above || !has_fill(&fill) { "none".to_string() } else { t.fill.clone() };
            let stroke = if has_fill(&stroke) { s() } else { stroke };
            Primitive::Polygon { pts, fill, stroke, stroke_width_mm, hatch, greyed: None, opacity: None, no_stroke_edges, wall_id: None, drawing_id: None, ceiling_id: None, opening_id: None, stair_id: None, room_id: None, extruded_solid_id: None, context_object_id: None, column_id: None, roof_id: None, section_line_id: None }
        }
        Primitive::Line { a, b, weight_mm, dash, zigzag, motif, .. } => Primitive::Line { a, b, cls: TRACE_CLS.into(), weight_mm, dash, zigzag, motif, color: Some(s().as_str().into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None },
        Primitive::Arc { center, from, to, r, weight_mm, dash, .. } => Primitive::Arc { center, from, to, r, cls: TRACE_CLS.into(), weight_mm, dash, color: Some(s().as_str().into()), opening_id: None, stair_id: None, greyed: None, opacity: None },
        Primitive::Text { at, doc, extra_lines, base_pt, .. } => Primitive::Text { at, doc, extra_lines, base_pt, color: s(), room_id: None, greyed: None, opacity: None },
        Primitive::DrawingText { at, text, height_m, angle, marks, wrap_width, doc, .. } => Primitive::DrawingText { at, text, height_m, angle, color: s(), marks, wrap_width, doc, drawing_id: None, greyed: None, opacity: None },
        Primitive::DrawingTextPath { path_pts, text, height_m, .. } => Primitive::DrawingTextPath { path_pts, text, height_m, color: s(), drawing_id: None, greyed: None, opacity: None },
        Primitive::DrawingCircle { center, r, fill, weight_mm, dash, .. } => {
            let fill = if above || !has_fill(&fill) { "none".to_string() } else { t.fill.clone() };
            Primitive::DrawingCircle { center, r, fill, stroke: s(), weight_mm, dash, drawing_id: None, greyed: None, opacity: None }
        }
        Primitive::DrawingArc { center, r, a0, a1, weight_mm, dash, .. } => Primitive::DrawingArc { center, r, a0, a1, stroke: s(), weight_mm, dash, drawing_id: None, greyed: None, opacity: None },
        Primitive::DrawingImage { min, max, src, opacity, .. } => Primitive::DrawingImage { min, max, src, opacity: opacity * 0.4, drawing_id: None, greyed: None },
    }
}

/// Plan-Puffer (eine Gruppe, mit Ausmass) der Pause.
pub fn trace_buf(prims: &[Primitive]) -> Vec<u8> {
    let mut w = crate::plan::buf::Writer::new(false);
    w.bounds = bounds_of(prims);
    w.group(prims);
    w.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DrawingLevel;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    fn line(a: Vec2, b: Vec2) -> Primitive {
        Primitive::Line { a, b, cls: "door-leaf".into(), weight_mm: 0.25, dash: None, zigzag: None, motif: None, color: None, drawing_id: Some("d".into()), opening_id: Some("o".into()), stair_id: None, greyed: Some(true), opacity: None }
    }

    fn lv(id: &str, kind: DrawingLevelKind) -> DrawingLevel {
        DrawingLevel { id: id.into(), name: id.into(), kind, visible: true, ..Default::default() }
    }

    fn project(levels: Vec<DrawingLevel>) -> Project {
        Project { drawing_levels: levels, ..Default::default() }
    }

    fn args(source: &str, active: &str) -> TraceArgs {
        TraceArgs { source: source.into(), active: active.into(), ..Default::default() }
    }

    fn ends(pr: &Primitive) -> (Vec2, Vec2) {
        let Primitive::Line { a, b, .. } = pr else { panic!("{pr:?}") };
        (*a, *b)
    }

    fn close(a: Vec2, b: Vec2) -> bool {
        (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9
    }

    #[test]
    fn starrkoerper_drehung_und_verschiebung() {
        let m = rigid(std::f64::consts::FRAC_PI_2, v(10.0, 0.0));
        // (1, 0) → R·(1,0) = (0, 1) → + (10, 0)
        assert!(close(super::super::underlay::map_point(&m, v(1.0, 0.0)), v(10.0, 1.0)));
        assert!(close(super::super::underlay::map_point(&m, v(0.0, 2.0)), v(8.0, 0.0)));
        let id = rigid(0.0, v(0.0, 0.0));
        assert!(close(super::super::underlay::map_point(&id, v(3.0, 4.0)), v(3.0, 4.0)));
    }

    #[test]
    fn geschoss_hinter_geschoss_deckungsgleich_ohne_ids_gefaerbt() {
        let p = project(vec![lv("eg", DrawingLevelKind::Floor), lv("og", DrawingLevelKind::Floor)]);
        let a = TraceArgs { color: Some("#ff0000".into()), opacity: 0.5, ..args("og", "eg") };
        let out = trace_primitives(&p, &a, vec![line(v(0.0, 0.0), v(4.0, 0.0))]);
        assert_eq!(out.len(), 1);
        let Primitive::Line { a: pa, b: pb, cls, color, drawing_id, opening_id, greyed, .. } = &out[0] else { panic!() };
        assert!(close(*pa, v(0.0, 0.0)) && close(*pb, v(4.0, 0.0)));
        assert_eq!(cls.as_str(), TRACE_CLS);
        // Rot mit halber Deckkraft = zur Papierfarbe halb aufgehellt.
        assert_eq!(color.as_ref().map(|c| c.as_str()), Some("#ff8080"));
        assert_eq!((drawing_id, opening_id, greyed), (&None, &None, &None));
    }

    #[test]
    fn quelle_gleich_ziel_oder_unbekannt_leer() {
        let p = project(vec![lv("eg", DrawingLevelKind::Floor)]);
        assert!(trace_primitives(&p, &args("eg", "eg"), vec![line(v(0.0, 0.0), v(1.0, 0.0))]).is_empty());
        assert!(trace_primitives(&p, &args("xx", "eg"), vec![line(v(0.0, 0.0), v(1.0, 0.0))]).is_empty());
    }

    #[test]
    fn verschieben_und_drehen_der_pause() {
        let p = project(vec![lv("eg", DrawingLevelKind::Floor), lv("og", DrawingLevelKind::Floor)]);
        let a = TraceArgs { offset: v(2.0, 3.0), rotation: 90.0, ..args("og", "eg") };
        let out = trace_primitives(&p, &a, vec![line(v(0.0, 0.0), v(4.0, 0.0))]);
        let (pa, pb) = ends(&out[0]);
        assert!(close(pa, v(2.0, 3.0)), "{pa:?}");
        assert!(close(pb, v(2.0, 7.0)), "{pb:?}");
    }

    #[test]
    fn schnitt_hinter_grundriss_an_der_linie_aufgeklappt() {
        // Schnittlinie entlang +x bei y = 2, Blick nach +y (directionSign 1): u = x − (−1), Höhe in +y.
        let mut sec = lv("s", DrawingLevelKind::Section);
        sec.line_points = Some([v(-1.0, 2.0), v(12.0, 2.0)]);
        sec.direction_sign = Some(1.0);
        let p = project(vec![lv("eg", DrawingLevelKind::Floor), sec]);
        // Senkrechte Kante im Schnitt bei u = 3 von Höhe 0 bis 3; Grundriss reicht bis y = 10.
        let a = TraceArgs { active_bounds: Some([0.0, 0.0, 11.0, 10.0]), ..args("s", "eg") };
        let out = trace_primitives(&p, &a, vec![line(v(3.0, 0.0), v(3.0, 3.0))]);
        let (pa, pb) = ends(&out[0]);
        // x = −1 + 3 = 2 (senkrecht über der Stelle im Grundriss); unterste Kante GAP jenseits y = 10.
        assert!(close(pa, v(2.0, 10.0 + GAP_M)), "{pa:?}");
        assert!(close(pb, v(2.0, 13.0 + GAP_M)), "{pb:?}");
    }

    #[test]
    fn grundriss_hinter_schnitt_wie_unterlage() {
        let mut sec = lv("s", DrawingLevelKind::Section);
        sec.line_points = Some([v(-1.0, 2.0), v(12.0, 2.0)]);
        sec.direction_sign = Some(1.0);
        let p = project(vec![lv("eg", DrawingLevelKind::Floor), sec]);
        let a = TraceArgs { active_bounds: Some([0.0, -0.3, 13.0, 8.0]), ..args("eg", "s") };
        let src = vec![line(v(0.0, 0.0), v(11.0, 6.0))];
        let out = trace_primitives(&p, &a, src.clone());
        let under = super::super::underlay::underlay_primitives(Some([v(-1.0, 2.0), v(12.0, 2.0)]), Some(1.0), src, -0.3);
        assert_eq!(out.len(), under.len(), "samt Schnittlinie");
        assert_eq!(ends(&out[0]), ends(&under[0]));
    }

    #[test]
    fn ueber_der_ansicht_ohne_fuellung_unter_mit_heller_fuellung() {
        let poly = Primitive::Polygon { pts: vec![v(0.0, 0.0), v(1.0, 0.0), v(1.0, 1.0)], fill: "#000000".into(), stroke: "#000".into(), stroke_width_mm: 0.2, hatch: Box::new(super::super::style::no_hatch()), greyed: None, opacity: None, no_stroke_edges: None, wall_id: Some("W".into()), drawing_id: None, ceiling_id: None, opening_id: None, stair_id: None, room_id: None, extruded_solid_id: None, context_object_id: None, column_id: None, roof_id: None, section_line_id: None };
        let t = Tone::new("#000000", 0.5);
        let Primitive::Polygon { fill, stroke, wall_id, .. } = styled(poly.clone(), &t, false) else { panic!() };
        assert_eq!((fill.as_str(), stroke.as_str(), wall_id), ("#ececec", "#808080", None));
        let Primitive::Polygon { fill, .. } = styled(poly, &t, true) else { panic!() };
        assert_eq!(fill, "none");
    }

    #[test]
    fn puffer_lesbar_mit_ausmass() {
        let prims = vec![line(v(0.0, 0.0), v(4.0, 2.0))];
        let bytes = trace_buf(&prims);
        let view = crate::plan::buf::View::parse(&bytes).unwrap();
        assert_eq!(view.prims().unwrap().len(), 1);
        assert_eq!(view.bounds(), Some([0.0, 0.0, 4.0, 2.0]));
        assert!(TraceArgs::parse(r#"{"parts":[{"name":"tracePlan"}]}"#).is_err());
        assert!(TraceArgs::parse("kaputt").is_err());
    }

    /// Abfrage `tracePlan` auf dem Beispielprojekt: Schnitt hinter Geschoss (aufgeklappt) und Geschoss hinter
    /// Geschoss; auf dem Dokument (Plan-Caches) gleich wie ohne; keine Auswahl-Ids im Ergebnis.
    #[test]
    fn abfrage_auf_beispielprojekt() {
        let text = include_str!("../../tests/fixtures/sample_project.json");
        let p: Project = serde_json::from_str(text).unwrap();
        let mut d = crate::document::Document::from_json(text).unwrap();
        let floors: Vec<&DrawingLevel> = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).collect();
        let sec = p.drawing_levels.iter().find(|l| l.kind == DrawingLevelKind::Section && l.line_points.is_some()).unwrap();
        let show: Vec<&str> = p.layers.iter().map(|l| l.code.as_str()).collect();
        let floor_part = |id: &str| serde_json::json!({ "name": "planDomains", "args": [1], "text": serde_json::json!({ "floor": id, "show": show, "scale": 100, "traceOf": floors[0].id }).to_string() });
        let sec_part = serde_json::json!({ "name": "sectionPlan", "args": [0, 1, 0], "text": serde_json::json!({ "level": sec, "scale": 100 }).to_string() });
        for (src, part) in [(sec.id.as_str(), sec_part), (floors[floors.len() - 1].id.as_str(), floor_part(&floors[floors.len() - 1].id))] {
            let q = serde_json::json!({ "parts": [part], "source": src, "active": floors[0].id, "activeBounds": [0, 0, 12, 10], "opacity": 0.4 }).to_string();
            let plain = crate::queries::run_bin(&p, "tracePlan", &[], &q).unwrap();
            assert_eq!(crate::queries::run_bin_doc(&mut d, "tracePlan", &[], &q).unwrap(), plain, "{src}");
            let prims = crate::plan::buf::View::parse(&plain).unwrap().prims().unwrap();
            assert!(prims.len() > 5, "{src}: {}", prims.len());
            for pr in &prims {
                if let Primitive::Polygon { wall_id, room_id, .. } = pr {
                    assert!(wall_id.is_none() && room_id.is_none());
                }
                if let Primitive::Line { cls, .. } = pr {
                    assert_eq!(cls.as_str(), TRACE_CLS);
                }
            }
        }
    }
}
