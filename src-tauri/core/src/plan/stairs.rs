//! Treppen im Grundriss auf dem Dokument ([K3d]): Filter, Override-Regeln, Stil und Pick-ID um
//! das Treppen-Symbol aus `plan_stairs.rs` — Rust-Gegenstück zu `generatePlan/stairs.ts` und der
//! Treppen-Schleife in `generatePlan.ts`.

use super::domains::{Bounds, Ctx};
use super::prim::Primitive;
use super::style::*;
use crate::js_fmt::js_number;
use crate::model::*;

/// Linienklassen der Kern-Kodierung (`plan_stairs.rs`).
const LINE_CLS: [&str; 5] = ["stair-outline", "stair-tread", "stair-break", "stair-run", "stair-arrow"];
/// Strichmuster der verdeckten Tritte.
const TREAD_DASH: [f64; 2] = [0.12, 0.08];

/// `stairLabel` (für `object_name`).
pub fn stair_label(s: &Stair) -> String {
    let shape = match s.shape {
        StairShape::Straight => "Gerade",
        StairShape::L => "L-Treppe",
        _ => "Wendel",
    };
    format!("{shape} {} STG", js_number(s.step_count))
}

fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Treppen des Geschosses in Zeichenreihenfolge; Tritte und Podest ins Ausmass.
pub fn plan_stairs(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) {
    let p = c.p;
    let cut_height = p.floor(&c.a.floor).and_then(|f| f.cut_height).unwrap_or(1.0);
    for s in p.stairs.as_deref().unwrap_or(&[]).iter().filter(|s| s.floor_id == c.a.floor && c.shown(&s.category_code)) {
        let greyed = Some(c.greyed(&s.category_code));
        let ov = c.overrides(&s.category_code, Some(&stair_label(s)));
        let lw = ov.lineweight.unwrap_or_else(|| c.cat(&s.category_code).map_or(WALL_FALLBACK_MM, |k| k.lw));
        let stroke = ov.color.as_deref().or(s.color.as_deref()).unwrap_or(POCHE_STROKE).to_string();
        let (zb, zt) = p.stair_vertical_extent(s);
        let params = s.encode();
        if let Some(sp) = crate::stair::decode_params(&params).filter(|_| (zt - zb).is_finite()) {
            let geo = kernel2d::stair_geometry(&sp, zt - zb);
            for t in &geo.treads {
                for q in &t.pts {
                    bounds.acc(q.x, q.y);
                }
            }
            for q in geo.landing.iter().flatten() {
                bounds.acc(q.x, q.y);
            }
        }
        let f = crate::plan_stairs::plan_stair(&params, zt - zb, cut_height, lw, s.arrow_style == Some(StairArrowStyle::Filled));
        if f.is_empty() {
            continue;
        }
        let n = f[0] as usize;
        let mut i = 1;
        for _ in 0..n {
            match f[i] as i64 {
                1 => {
                    let count = f[i + 3] as usize;
                    let pts = (0..count).map(|j| v2(f[i + 4 + 2 * j], f[i + 5 + 2 * j])).collect();
                    out.push(Primitive::Polygon {
                        pts,
                        fill: if f[i + 2] != 0.0 { stroke.clone() } else { "none".into() },
                        stroke: stroke.clone(),
                        stroke_width_mm: f[i + 1],
                        hatch: no_hatch(),
                        greyed,
                        opacity: None,
                        no_stroke_edges: None,
                        wall_id: None,
                        drawing_id: None,
                        ceiling_id: None,
                        opening_id: None,
                        stair_id: Some(s.id.clone()),
                        room_id: None,
                        extruded_solid_id: None,
                        context_object_id: None,
                        column_id: None,
                        roof_id: None,
                        section_line_id: None,
                    });
                    i += 4 + 2 * count;
                }
                2 => {
                    let cls = LINE_CLS.get(f[i + 1] as usize).copied().unwrap_or("");
                    let dash = (cls == "stair-tread").then(|| (f[i + 3] != 0.0).then(|| TREAD_DASH.to_vec()));
                    out.push(Primitive::Line {
                        a: v2(f[i + 4], f[i + 5]),
                        b: v2(f[i + 6], f[i + 7]),
                        cls: cls.into(),
                        weight_mm: f[i + 2],
                        dash,
                        zigzag: None,
                        motif: None,
                        color: Some(stroke.clone()),
                        drawing_id: None,
                        opening_id: None,
                        stair_id: Some(s.id.clone()),
                        greyed,
                        opacity: None,
                    });
                    i += 8;
                }
                _ => {
                    out.push(Primitive::Arc {
                        center: v2(f[i + 2], f[i + 3]),
                        from: v2(f[i + 4], f[i + 5]),
                        to: v2(f[i + 6], f[i + 7]),
                        r: f[i + 8],
                        cls: "stair-outline".into(),
                        weight_mm: f[i + 1],
                        dash: None,
                        color: None,
                        opening_id: None,
                        stair_id: Some(s.id.clone()),
                        greyed,
                        opacity: None,
                    });
                    i += 9;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_wie_ts() {
        let s = Stair { shape: StairShape::L, step_count: 16.0, ..Default::default() };
        assert_eq!(stair_label(&s), "L-Treppe 16 STG");
        assert_eq!(stair_label(&Stair { shape: StairShape::Spiral, step_count: 12.0, ..Default::default() }), "Wendel 12 STG");
    }
}
