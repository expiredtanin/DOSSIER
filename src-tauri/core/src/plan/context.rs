//! Projektglobale Referenzen im Grundriss auf dem Dokument ([K3d]): Kontext-Konturen (Höhenlinien,
//! Fussabdruck importierter Gebäude, Rahmen von Gelände-Meshes, Pick-Bänder) und Schnittführungs-
//! Symbole der Schnitt-/Ansichtsebenen — Rust-Gegenstück zu `generatePlan/{context,sections}.ts`.
//! Die Geometrie liegt in `plan_misc.rs`; die Meshes werden direkt aus dem Dokument gelesen.

use super::domains::Ctx;
use super::overrides::{js_space, js_trim};
use super::prim::Primitive;
use super::style::no_hatch;
use crate::model::*;

const CONTEXT_LINE_COLOR: &str = "#9aa3ad";
const CONTEXT_LINE_MM: f64 = 0.1;
/// Kategorie der Schnittführungs-Symbole (Referenzen).
const SECTION_LINE_CATEGORY: &str = "90";
const SECTION_LINE_INK: &str = "#1f242c";
const SECTION_LINE_MM: f64 = 0.18;
const SECTION_LINE_MARK_MM: f64 = 0.5;
const SECTION_LINE_DASH: [f64; 4] = [6.0, 1.5, 0.4, 1.5];
const SECTION_LABEL_H: f64 = 0.5;

fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

fn context_line(a: Vec2, b: Vec2) -> Primitive {
    Primitive::Line { a, b, cls: "context-line".into(), weight_mm: CONTEXT_LINE_MM, dash: None, zigzag: None, motif: None, color: Some(CONTEXT_LINE_COLOR.into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None }
}

fn pick_band(pts: Vec<Vec2>, context_id: Option<&str>, section_id: Option<&str>) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: "none".into(),
        stroke: "none".into(),
        stroke_width_mm: 0.0,
        hatch: no_hatch(),
        greyed: None,
        opacity: None,
        no_stroke_edges: None,
        wall_id: None,
        drawing_id: None,
        ceiling_id: None,
        opening_id: None,
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: context_id.map(String::from),
        column_id: None,
        roof_id: None,
        section_line_id: section_id.map(String::from),
    }
}

/// Rahmen-Ecken eines Meshes (x/y), `None` ohne Punkte.
fn bbox_corners(positions: &[f64]) -> Option<Vec<Vec2>> {
    let b = crate::plan_misc::bbox(positions);
    (b.len() == 4).then(|| vec![v2(b[0], b[1]), v2(b[2], b[1]), v2(b[2], b[3]), v2(b[0], b[3])])
}

/// Kontext-Schicht (`addContextContours`). Objekte ohne Kategorie bleiben immer sichtbar.
pub fn plan_context(c: &Ctx, out: &mut Vec<Primitive>) {
    for obj in c.p.context.as_deref().unwrap_or(&[]) {
        let code = match obj {
            ContextObject::ImportedMesh(m) => m.category_code.as_deref(),
            ContextObject::ContourSet(s) => s.category_code.as_deref(),
            ContextObject::TerrainMesh(t) => t.category_code.as_deref(),
            ContextObject::Image(i) => i.category_code.as_deref(),
        };
        if code.is_some_and(|k| !c.shown(k)) {
            continue;
        }
        match obj {
            ContextObject::ContourSet(s) => {
                for k in &s.contours {
                    let pts = &k.pts;
                    if pts.len() < 2 {
                        continue;
                    }
                    let seg_end = if k.closed { pts.len() } else { pts.len() - 1 };
                    for i in 0..seg_end {
                        out.push(context_line(pts[i], pts[(i + 1) % pts.len()]));
                    }
                }
            }
            ContextObject::ImportedMesh(m) => {
                let f = crate::plan_misc::context_footprint(&m.positions, &m.indices);
                let n = f.first().copied().unwrap_or(0.0) as usize;
                for i in 0..n {
                    out.push(context_line(v2(f[1 + 4 * i], f[2 + 4 * i]), v2(f[3 + 4 * i], f[4 + 4 * i])));
                }
                if let Some(pts) = bbox_corners(&m.positions) {
                    out.push(pick_band(pts, Some(&m.id), None));
                }
            }
            ContextObject::TerrainMesh(t) => {
                if let Some(q) = bbox_corners(&t.positions) {
                    for i in 0..4 {
                        out.push(context_line(q[i], q[(i + 1) % 4]));
                    }
                    out.push(pick_band(q, Some(&t.id), None));
                }
            }
            ContextObject::Image(_) => {}
        }
    }
}

/// Kurz-Tag eines Schnitt-Labels: letztes Wort des Namens, sonst der ganze (getrimmte) Name.
pub fn section_label_tag(name: &str) -> String {
    let t = js_trim(name);
    let parts: Vec<&str> = t.split(js_space).filter(|s| !s.is_empty()).collect();
    if parts.len() > 1 {
        parts[parts.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// Schnittführungs-Symbole aller Schnitt-/Ansichtsebenen mit Linie (`addSectionLines`).
pub fn plan_section_lines(c: &Ctx, out: &mut Vec<Primitive>) {
    if !c.shown(SECTION_LINE_CATEGORY) {
        return;
    }
    // Auf freien Zeichnungsebenen (Blätter wie „Raumprogramm", Detail) gehören die Symbole nicht hin:
    // sie beziehen sich auf die Geschoss-Grundrisse.
    if c.p.drawing_levels.iter().any(|l| l.id == c.a.floor && matches!(l.kind, DrawingLevelKind::Drawing)) {
        return;
    }
    let greyed = Some(c.greyed(SECTION_LINE_CATEGORY));
    for level in &c.p.drawing_levels {
        if !matches!(level.kind, DrawingLevelKind::Section | DrawingLevelKind::Elevation) {
            continue;
        }
        let Some([p0, p1]) = level.line_points else { continue };
        let f = crate::plan_misc::section_line(p0.x, p0.y, p1.x, p1.y, level.direction_sign.unwrap_or(1.0));
        if f.is_empty() {
            continue;
        }
        let n = f[0] as usize;
        let mut i = 1;
        for _ in 0..n {
            if f[i] == 2.0 {
                let main = f[i + 1] == 0.0;
                out.push(Primitive::Line {
                    a: v2(f[i + 2], f[i + 3]),
                    b: v2(f[i + 4], f[i + 5]),
                    cls: "section-line".into(),
                    weight_mm: if main { SECTION_LINE_MM } else { SECTION_LINE_MARK_MM },
                    dash: main.then(|| Some(SECTION_LINE_DASH.to_vec())),
                    zigzag: None,
                    motif: None,
                    color: Some(SECTION_LINE_INK.into()),
                    drawing_id: None,
                    opening_id: None,
                    stair_id: None,
                    greyed,
                    opacity: None,
                });
                i += 6;
            } else if f[i] == 5.0 {
                out.push(Primitive::DrawingText {
                    at: v2(f[i + 1], f[i + 2]),
                    text: section_label_tag(&level.name),
                    height_m: SECTION_LABEL_H,
                    angle: 0.0,
                    color: SECTION_LINE_INK.into(),
                    marks: None,
                    wrap_width: None,
                    doc: None,
                    drawing_id: None,
                    greyed,
                    opacity: None,
                });
                i += 3;
            } else {
                let pts = (0..4).map(|j| v2(f[i + 1 + 2 * j], f[i + 2 + 2 * j])).collect();
                out.push(pick_band(pts, None, Some(&level.id)));
                i += 9;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_tag_wie_ts() {
        assert_eq!(section_label_tag("Schnitt A"), "A");
        assert_eq!(section_label_tag("  Ansicht   Süd "), "Süd");
        assert_eq!(section_label_tag("Längsschnitt"), "Längsschnitt");
        assert_eq!(section_label_tag("   "), "");
        assert_eq!(section_label_tag("a\u{A0}b"), "b");
    }
}
