//! Grundriss-Unterlage in Schnitt/Ansicht (früher `src/plan/planUnderlay.ts`): ein Geschoss-
//! Grundriss wird AUSGERICHTET unter die Schnitt-/Ansichtsfläche gelegt — die klassische
//! Konstruktion „Ansicht über dem Grundriss“. Die Schnittlinie wird waagrecht gedreht, die
//! Blickrichtung zeigt im Blatt nach OBEN, und die u-Achse stimmt mit der des Schnitts überein
//! (`Plane::u_model`): ein Punkt im Grundriss liegt senkrecht unter seiner Projektion im Schnitt.
//!
//! Reine Starrkörper-Abbildung (Drehung + Verschiebung, keine Spiegelung) — Kreise bleiben Kreise,
//! Bögen behalten ihren Drehsinn. Die Unterlage ist gedimmt, ohne Auswahl-Ids (fremde Projektion:
//! ein Klick darf nie das echte Bauteil wählen) und trägt die Schnittlinie selbst (strichpunktiert).
//! Rechenreihenfolge wie in der TS-Fassung (bitgleich).

use super::prim::Primitive;
use crate::jsmath::hypot2;
use crate::jsnum::{atan2, max, min};
use crate::model::Vec2;

/// Abstand (Meter) zwischen tiefster Schnitt-/Ansichtskante und Grundriss-Oberkante.
pub const GAP_M: f64 = 1.5;

/// Abbildung Grundriss (Modell x/y) → Schnitt-Blatt (u, Höhe) (`PlanToSectionMap`).
#[derive(Clone, Copy, Debug)]
pub struct SectionMap {
    /// Ursprung = Startpunkt der Schnittlinie.
    pub p0: Vec2,
    /// Horizontale Schnitt-u-Achse im Grundriss (Blickrichtungs-RECHTS).
    pub u: Vec2,
    /// Blickrichtung im Grundriss (Einheit).
    pub n: Vec2,
    /// Drehwinkel (Radiant, CCW).
    pub theta: f64,
    /// Vertikaler Versatz im Blatt.
    pub dy: f64,
}

/// Abbildung aus der Schnitt-/Ansichtslinie (`planToSectionMap`); `None` ohne (gültige) Linie.
pub fn section_map(line: [Vec2; 2], direction_sign: Option<f64>) -> Option<SectionMap> {
    let [p0, p1] = line;
    let len = hypot2(p1.x - p0.x, p1.y - p0.y);
    if len < 1e-9 {
        return None;
    }
    let dx = (p1.x - p0.x) / len;
    let dy = (p1.y - p0.y) / len;
    let sign = direction_sign.unwrap_or(1.0);
    // Wie `sectionPlaneFromLevel`: Links-Normale der Linie, per directionSign gedreht.
    let n = Vec2 { x: -dy * sign, y: dx * sign };
    // Wie `sectionUAxisModel`: u = (n.y, −n.x).
    let u = Vec2 { x: n.y, y: -n.x };
    Some(SectionMap { p0, u, n, theta: atan2(n.x, u.x), dy: 0.0 })
}

/// Bildet einen Grundriss-Punkt ins Schnitt-Blatt ab (`mapPlanPoint`).
pub fn map_point(m: &SectionMap, p: Vec2) -> Vec2 {
    let rx = p.x - m.p0.x;
    let ry = p.y - m.p0.y;
    Vec2 { x: rx * m.u.x + ry * m.u.y, y: rx * m.n.x + ry * m.n.y + m.dy }
}

/// Bildet ein Plan-Primitiv ab (`mapPlanPrimitive`). Achsparallele Rasterbilder lassen sich nicht
/// drehen und entfallen — ausser die Abbildung ist eine reine Verschiebung.
pub fn map_primitive(m: &SectionMap, pr: Primitive) -> Option<Primitive> {
    let p = |q: Vec2| map_point(m, q);
    Some(match pr {
        Primitive::Polygon { pts, mut hatch, fill, stroke, stroke_width_mm, greyed, opacity, no_stroke_edges, wall_id, drawing_id, ceiling_id, opening_id, stair_id, room_id, extruded_solid_id, context_object_id, column_id, roof_id, section_line_id } => {
            if hatch.origin.is_some() || m.theta != 0.0 {
                // SVG-Musterwinkel dreht im Uhrzeigersinn (Bildschirm) = −Winkel im Modell.
                hatch.angle -= (m.theta * 180.0) / std::f64::consts::PI;
                hatch.origin = hatch.origin.map(p);
            }
            Primitive::Polygon { pts: pts.into_iter().map(p).collect(), hatch, fill, stroke, stroke_width_mm, greyed, opacity, no_stroke_edges, wall_id, drawing_id, ceiling_id, opening_id, stair_id, room_id, extruded_solid_id, context_object_id, column_id, roof_id, section_line_id }
        }
        // `motif` ist im Strich-lokalen Raum definiert — dreht mit der Linie mit.
        Primitive::Line { a, b, cls, weight_mm, dash, zigzag, motif, color, drawing_id, opening_id, stair_id, greyed, opacity } => Primitive::Line { a: p(a), b: p(b), cls, weight_mm, dash, zigzag, motif, color, drawing_id, opening_id, stair_id, greyed, opacity },
        Primitive::Arc { center, from, to, r, cls, weight_mm, dash, color, opening_id, stair_id, greyed, opacity } => Primitive::Arc { center: p(center), from: p(from), to: p(to), r, cls, weight_mm, dash, color, opening_id, stair_id, greyed, opacity },
        Primitive::Text { at, doc, extra_lines, base_pt, color, room_id, greyed, opacity } => Primitive::Text { at: p(at), doc, extra_lines, base_pt, color, room_id, greyed, opacity },
        Primitive::DrawingText { at, text, height_m, angle, color, marks, wrap_width, doc, drawing_id, greyed, opacity } => Primitive::DrawingText { at: p(at), text, height_m, angle: angle + m.theta, color, marks, wrap_width, doc, drawing_id, greyed, opacity },
        Primitive::DrawingTextPath { path_pts, text, height_m, color, drawing_id, greyed, opacity } => Primitive::DrawingTextPath { path_pts: path_pts.into_iter().map(p).collect(), text, height_m, color, drawing_id, greyed, opacity },
        Primitive::DrawingCircle { center, r, fill, stroke, weight_mm, dash, drawing_id, greyed, opacity } => Primitive::DrawingCircle { center: p(center), r, fill, stroke, weight_mm, dash, drawing_id, greyed, opacity },
        Primitive::DrawingArc { center, r, a0, a1, stroke, weight_mm, dash, drawing_id, greyed, opacity } => Primitive::DrawingArc { center: p(center), r, a0: a0 + m.theta, a1: a1 + m.theta, stroke, weight_mm, dash, drawing_id, greyed, opacity },
        Primitive::DrawingImage { min: lo, max: hi, src, opacity, drawing_id, greyed } => {
            if m.theta.abs() > 1e-9 {
                return None;
            }
            let (a, b) = (p(lo), p(hi));
            Primitive::DrawingImage { min: Vec2 { x: min(a.x, b.x), y: min(a.y, b.y) }, max: Vec2 { x: max(a.x, b.x), y: max(a.y, b.y) }, src, opacity, drawing_id, greyed }
        }
    })
}

/// Höchster Stützpunkt eines Primitivs (`primitivePoints`, nur y), für die Höhenlage der Unterlage.
fn max_y(pr: &Primitive, acc: &mut f64) {
    let mut see = |y: f64| {
        if y > *acc {
            *acc = y;
        }
    };
    match pr {
        Primitive::Polygon { pts, .. } => pts.iter().for_each(|q| see(q.y)),
        Primitive::Line { a, b, .. } => {
            see(a.y);
            see(b.y);
        }
        Primitive::Arc { from, to, center, .. } => {
            see(from.y);
            see(to.y);
            see(center.y);
        }
        Primitive::Text { at, .. } | Primitive::DrawingText { at, .. } => see(at.y),
        Primitive::DrawingTextPath { path_pts, .. } => path_pts.iter().for_each(|q| see(q.y)),
        Primitive::DrawingCircle { center, r, .. } | Primitive::DrawingArc { center, r, .. } => see(center.y + r),
        Primitive::DrawingImage { min, max, .. } => {
            see(min.y);
            see(max.y);
        }
    }
}

/// Auswahl-Ids entfernen (die Geometrie stammt aus einer fremden Projektion) und dimmen.
fn as_reference(pr: Primitive) -> Primitive {
    let mut pr = pr.with_greyed(true);
    match &mut pr {
        Primitive::Polygon { wall_id, drawing_id, ceiling_id, opening_id, stair_id, room_id, extruded_solid_id, context_object_id, column_id, roof_id, section_line_id, .. } => {
            for id in [wall_id, drawing_id, ceiling_id, opening_id, stair_id, room_id, extruded_solid_id, context_object_id, column_id, roof_id, section_line_id] {
                *id = None;
            }
        }
        Primitive::Line { drawing_id, opening_id, stair_id, .. } => {
            *drawing_id = None;
            *opening_id = None;
            *stair_id = None;
        }
        Primitive::Arc { opening_id, stair_id, .. } => {
            *opening_id = None;
            *stair_id = None;
        }
        Primitive::Text { room_id, .. } => *room_id = None,
        Primitive::DrawingText { drawing_id, .. }
        | Primitive::DrawingTextPath { drawing_id, .. }
        | Primitive::DrawingImage { drawing_id, .. }
        | Primitive::DrawingCircle { drawing_id, .. }
        | Primitive::DrawingArc { drawing_id, .. } => *drawing_id = None,
    }
    pr
}

/// Legt die Grundriss-Primitive ausgerichtet unter einen Schnitt / eine Ansicht, deren tiefste Kante
/// bei `section_min_y` liegt (`planUnderlayPrimitives`): gedimmt, ohne Auswahl-Ids, dazu die
/// Schnittlinie. Ohne gültige Linie leer.
pub fn underlay_primitives(line: Option<[Vec2; 2]>, direction_sign: Option<f64>, plan: impl IntoIterator<Item = Primitive>, section_min_y: f64) -> Vec<Primitive> {
    let Some(line) = line else { return vec![] };
    let Some(base) = section_map(line, direction_sign) else { return vec![] };
    let mut mapped = Vec::new();
    let mut top = f64::NEG_INFINITY;
    for pr in plan {
        let Some(q) = map_primitive(&base, pr) else { continue };
        max_y(&q, &mut top);
        mapped.push(q);
    }
    // Die Schnittlinie (w = 0) liegt immer mit in der Unterlage.
    if 0.0 > top {
        top = 0.0;
    }
    let shift = section_min_y - GAP_M - top;
    let o = Vec2 { x: 0.0, y: 0.0 };
    let shift_map = SectionMap { p0: o, u: Vec2 { x: 1.0, y: 0.0 }, n: Vec2 { x: 0.0, y: 1.0 }, theta: 0.0, dy: shift };
    let mut out: Vec<Primitive> = mapped.into_iter().filter_map(|q| map_primitive(&shift_map, q)).map(as_reference).collect();
    let [l0, l1] = line;
    let len = hypot2(l1.x - l0.x, l1.y - l0.y);
    out.push(Primitive::Line {
        a: Vec2 { x: 0.0, y: shift },
        b: Vec2 { x: len, y: shift },
        cls: "section-underlay-line".into(),
        weight_mm: 0.25,
        dash: Some(Some(vec![3.0, 0.8, 0.4, 0.8])),
        zigzag: None,
        motif: None,
        color: Some("#8a3b2c".into()),
        drawing_id: None,
        opening_id: None,
        stair_id: None,
        greyed: None,
        opacity: None,
    });
    out
}

/// Primitive eines `planDomains`-Ergebnisses in Plan-Reihenfolge: Haupt-Puffer mit den Zeichnungs-
/// Stücken an Stelle ihrer (leeren) Gruppe 7.
pub fn plan_out_primitives(out: &super::domains::PlanOut) -> Result<Vec<Primitive>, String> {
    use crate::plan_buf::View;
    let bad = || "planUnderlay: Plan-Puffer unlesbar".to_string();
    let v = View::parse(&out.main).ok_or_else(bad)?;
    let main = v.prims().ok_or_else(bad)?;
    let groups = v.groups().ok_or_else(bad)?;
    let at = groups.get(7).map_or(main.len(), |g| g.0);
    let mut prims = Vec::with_capacity(main.len());
    let mut it = main.into_iter();
    prims.extend(it.by_ref().take(at));
    for (_, bytes) in &out.chunks {
        let bytes = bytes.as_ref().ok_or_else(|| "planUnderlay: Zeichnungs-Stück fehlt".to_string())?;
        prims.extend(View::parse(bytes).and_then(|c| c.prims()).ok_or_else(bad)?);
    }
    prims.extend(it);
    Ok(prims)
}

/// Argumente aus dem Abfrage-Text: die `planDomains`-Argumente des Geschosses plus `level` (Schnitt/
/// Ansicht) und `minY` (tiefste Kante des Schnitts).
pub fn parse_args(text: &str) -> Result<(Option<[Vec2; 2]>, Option<f64>, f64), String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("planUnderlay: {e}"))?;
    let level = super::section::LevelSpec::from_json(v.get("level").unwrap_or(&serde_json::Value::Null));
    let min_y = v.get("minY").and_then(|x| x.as_f64()).ok_or("planUnderlay: minY fehlt")?;
    Ok((level.line, level.direction_sign, min_y))
}

/// Plan-Puffer (eine Gruppe) der Unterlage.
pub fn underlay_buf(prims: &[Primitive]) -> Vec<u8> {
    let mut w = crate::plan_buf::Writer::new(false);
    w.group(prims);
    w.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    fn line(a: Vec2, b: Vec2) -> Primitive {
        Primitive::Line { a, b, cls: "t".into(), weight_mm: 0.25, dash: None, zigzag: None, motif: None, color: None, drawing_id: Some("d".into()), opening_id: None, stair_id: None, greyed: None, opacity: None }
    }

    /// Abfrage auf dem Dokument (Plan-Caches, Zeichnungs-Stücke) == ohne Cache.
    #[test]
    fn abfrage_mit_und_ohne_cache_gleich() {
        let text = include_str!("../../tests/fixtures/sample_project.json");
        let p: crate::model::Project = serde_json::from_str(text).unwrap();
        let mut d = crate::document::Document::from_json(text).unwrap();
        let sec = p.drawing_levels.iter().find(|l| l.line_points.is_some()).unwrap();
        for floor in p.drawing_levels.iter().filter(|l| l.kind == crate::model::DrawingLevelKind::Floor) {
            let show: Vec<&str> = p.layers.iter().map(|l| l.code.as_str()).collect();
            let args = serde_json::json!({ "floor": floor.id, "show": show, "scale": 100, "level": serde_json::to_value(sec).unwrap(), "minY": -0.25 }).to_string();
            let plain = crate::queries::run_bin(&p, "planUnderlay", &[1.0], &args).unwrap();
            for _ in 0..2 {
                assert_eq!(crate::queries::run_bin_doc(&mut d, "planUnderlay", &[1.0], &args).unwrap(), plain);
            }
            let n = crate::plan_buf::View::parse(&plain).unwrap().len();
            assert!(n > 5, "{n}");
        }
    }

    #[test]
    fn blickrichtung_nach_oben_keine_spiegelung() {
        // Linie entlang +x, Blick nach +y: reine Verschiebung.
        let m = section_map([v(-1.0, 2.0), v(12.0, 2.0)], Some(1.0)).unwrap();
        assert!(m.theta.abs() < 1e-12);
        let q = map_point(&m, v(0.0, 5.0));
        assert!((q.x - 1.0).abs() < 1e-12 && (q.y - 3.0).abs() < 1e-12);
        // Umgekehrte Blickrichtung: 180°-Drehung.
        let r = section_map([v(-1.0, 2.0), v(12.0, 2.0)], Some(-1.0)).unwrap();
        assert!((r.theta.abs() - std::f64::consts::PI).abs() < 1e-12);
        assert!((map_point(&r, v(0.0, 0.0)).y - 2.0).abs() < 1e-12);
        assert!(section_map([v(1.0, 1.0), v(1.0, 1.0)], None).is_none());
    }

    #[test]
    fn u_wie_schnittebene() {
        // Ein Punkt liegt senkrecht unter seiner Projektion im Schnitt (u wie `Plane::u_model`).
        for (l, p, sign) in [([v(-1.0, 2.0), v(12.0, 2.0)], v(4.0, 7.0), 1.0), ([v(3.0, 0.0), v(3.0, 9.0)], v(6.0, 2.0), -1.0), ([v(0.0, 0.0), v(5.0, 5.0)], v(1.0, 3.0), 1.0)] {
            let m = section_map(l, Some(sign)).unwrap();
            let plane = super::super::section::LevelSpec { line: Some(l), direction_sign: Some(sign), ..Default::default() }.plane().unwrap();
            let (ux, uy) = plane.u_model();
            let (bx, by) = plane.base();
            let len = hypot2(ux, uy);
            let expected = ((p.x - bx) * ux + (p.y - by) * uy) / len;
            assert!((map_point(&m, p).x - expected).abs() < 1e-9);
        }
    }

    #[test]
    fn unterlage_mit_abstand_gedimmt_ohne_ids_plus_schnittlinie() {
        let out = underlay_primitives(Some([v(-1.0, 2.0), v(12.0, 2.0)]), Some(1.0), vec![line(v(0.0, 0.0), v(11.0, 6.0))], -0.3);
        let Primitive::Line { a, b, greyed, drawing_id, .. } = &out[0] else { panic!() };
        assert_eq!((*greyed, drawing_id.as_deref()), (Some(true), None));
        // Oberste Grundriss-Kante (y = 6 → w = 4) liegt GAP unter der Schnitt-Unterkante.
        let top = a.y.max(b.y);
        assert!((top - (-0.3 - GAP_M)).abs() < 1e-9);
        assert!((a.x.min(b.x) - 1.0).abs() < 1e-9);
        let Primitive::Line { a, b, cls, greyed, dash, .. } = out.last().unwrap() else { panic!() };
        assert_eq!(cls, "section-underlay-line");
        assert_eq!(*greyed, None);
        assert_eq!(dash, &Some(Some(vec![3.0, 0.8, 0.4, 0.8])));
        assert!((b.x - a.x - 13.0).abs() < 1e-9 && (a.y - (top - 4.0)).abs() < 1e-9);
        assert!(underlay_primitives(None, None, vec![line(v(0.0, 0.0), v(1.0, 1.0))], 0.0).is_empty());
    }

    #[test]
    fn gedrehte_linie_dreht_schraffur_und_texte_bilder_entfallen() {
        use super::super::prim::HatchRender;
        let mut hatch: HatchRender = super::super::style::no_hatch();
        hatch.angle = 10.0;
        let poly = Primitive::Polygon { pts: vec![v(0.0, 0.0), v(1.0, 0.0), v(1.0, 1.0)], fill: "#fff".into(), stroke: "#000".into(), stroke_width_mm: 0.2, hatch, greyed: None, opacity: None, no_stroke_edges: None, wall_id: Some("W".into()), drawing_id: None, ceiling_id: None, opening_id: None, stair_id: None, room_id: None, extruded_solid_id: None, context_object_id: None, column_id: None, roof_id: None, section_line_id: None };
        let img = Primitive::DrawingImage { min: v(0.0, 0.0), max: v(1.0, 1.0), src: "x".into(), opacity: 1.0, drawing_id: None, greyed: None };
        // Linie entlang +y → Drehung um 90°.
        let out = underlay_primitives(Some([v(0.0, 0.0), v(0.0, 5.0)]), None, vec![poly, img], 0.0);
        assert_eq!(out.len(), 2, "Bild entfällt bei Drehung");
        let Primitive::Polygon { hatch, wall_id, greyed, .. } = &out[0] else { panic!() };
        assert_eq!((wall_id, *greyed), (&None, Some(true)));
        // Blick nach −x: θ = −90°, das Muster dreht um +90°.
        assert!((hatch.angle - 100.0).abs() < 1e-9, "{}", hatch.angle);
    }
}
