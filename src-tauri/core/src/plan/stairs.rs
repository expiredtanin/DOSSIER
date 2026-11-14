//! Treppen im Grundriss auf dem Dokument ([K3d]): Filter, Override-Regeln, Stil und Pick-ID um
//! das Treppen-Symbol aus `stair_symbol.rs` — Rust-Gegenstück zu `generatePlan/stairs.ts` und der
//! Treppen-Schleife in `generatePlan.ts`.

use super::domains::{Bounds, Ctx};
use super::prim::Primitive;
use super::style::*;
use crate::js_fmt::js_number;
use crate::model::*;

/// Linienklassen der Kern-Kodierung (`stair_symbol.rs`); 6 = Absturzsicherung am Treppenloch ([155]).
const LINE_CLS: [&str; 7] = ["stair-outline", "stair-tread", "stair-break", "stair-run", "stair-arrow", "stair-handrail", "stair-guard"];
/// Strichmuster der verdeckten Tritte.
const TREAD_DASH: [f64; 2] = super::line_pattern::HIDDEN;

/// `stairLabel` (für `object_name`).
pub fn stair_label(s: &Stair) -> String {
    let shape = match s.shape {
        StairShape::Straight => "Gerade",
        StairShape::L => "L-Treppe",
        StairShape::U => "U-Treppe",
        StairShape::StraightLanding => "Podesttreppe",
        _ => "Wendel",
    };
    format!("{shape} {} STG", js_number(s.step_count))
}

fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Geländer-Code des Treppentyps (0 keins, 1 links, 2 rechts, 3 beide).
fn railing_code(p: &Project, s: &Stair) -> u8 {
    match p.stair_type(s).and_then(|t| t.railing) {
        Some(StairTypeRailing::Links) => 1,
        Some(StairTypeRailing::Rechts) => 2,
        Some(StairTypeRailing::Beide) => 3,
        _ => 0,
    }
}

fn stair_line(a: Vec2, b: Vec2, cls: &str, weight_mm: f64, dash: Option<Option<Vec<f64>>>, stroke: &str, greyed: Option<bool>, id: &str) -> Primitive {
    Primitive::Line {
        a,
        b,
        cls: cls.into(),
        weight_mm,
        dash,
        zigzag: None,
        motif: None,
        color: Some(stroke.to_string().into()),
        drawing_id: None,
        opening_id: None,
        stair_id: Some(id.to_string()),
        greyed,
        opacity: None,
    }
}

/// [173] Ob ein Eintrag des Symbol-Puffers nach der Modelldarstellung entfällt: Lauflinie, Pfeil (Linien und
/// gefüllte Spitze), Bruchlinie, Handlauf, Stufen über der Schnitthöhe (gestrichelt).
fn dropped(o: &super::model_view::StairOpts, f: &[f64], i: usize) -> bool {
    match f[i] as i64 {
        1 => !o.arrow && f[i + 1] > 0.0 && f[i + 2] != 0.0,
        2 => {
            let cls = f[i + 1];
            (cls == 3.0 && !o.walk_line) || (cls == 4.0 && !o.arrow) || (cls == 2.0 && !o.break_line) || (cls == 5.0 && o.handrail.is_none()) || (f[i + 3] != 0.0 && !o.above_cut)
        }
        _ => f[i + 2] != 0.0 && !o.above_cut,
    }
}

/// Symbol-Puffer (`stair_symbol.rs`) als Primitive; `opts`: Modelldarstellung ([173]).
fn emit(out: &mut Vec<Primitive>, f: &[f64], stroke: &str, greyed: Option<bool>, id: &str, opts: &super::model_view::StairOpts) {
    if f.is_empty() {
        return;
    }
    let n = f[0] as usize;
    let mut i = 1;
    for _ in 0..n {
        if dropped(opts, f, i) {
            i += match f[i] as i64 {
                1 => 4 + 2 * f[i + 3] as usize,
                2 => 8,
                _ => 10,
            };
            continue;
        }
        match f[i] as i64 {
            1 => {
                let count = f[i + 3] as usize;
                let pts = (0..count).map(|j| v2(f[i + 4 + 2 * j], f[i + 5 + 2 * j])).collect();
                // Strichstärke 0: unsichtbare Pick-Fläche.
                let visible = f[i + 1] > 0.0;
                out.push(Primitive::Polygon {
                    pts,
                    fill: if f[i + 2] != 0.0 { stroke.to_string() } else { "none".into() },
                    stroke: if visible { stroke.to_string() } else { "none".into() },
                    stroke_width_mm: f[i + 1],
                    hatch: Box::new(no_hatch()),
                    greyed,
                    opacity: None,
                    no_stroke_edges: None,
                    wall_id: None,
                    drawing_id: None,
                    ceiling_id: None,
                    opening_id: None,
                    stair_id: Some(id.to_string()),
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
                let dash = (cls == "stair-tread" || cls == "stair-handrail" || cls == "stair-outline" || cls == "stair-run").then(|| (f[i + 3] != 0.0).then(|| TREAD_DASH.to_vec()));
                out.push(stair_line(v2(f[i + 4], f[i + 5]), v2(f[i + 6], f[i + 7]), cls, f[i + 2], dash, stroke, greyed, id));
                i += 8;
            }
            _ => {
                out.push(Primitive::Arc {
                    center: v2(f[i + 3], f[i + 4]),
                    from: v2(f[i + 5], f[i + 6]),
                    to: v2(f[i + 7], f[i + 8]),
                    r: f[i + 9],
                    cls: "stair-outline".into(),
                    weight_mm: f[i + 1],
                    dash: (f[i + 2] != 0.0).then(|| Some(TREAD_DASH.to_vec())),
                    color: None,
                    opening_id: None,
                    stair_id: Some(id.to_string()),
                    greyed,
                    opacity: None,
                });
                i += 10;
            }
        }
    }
}

/// Treppen des Geschosses in Zeichenreihenfolge; Tritte und Podest ins Ausmass.
pub fn plan_stairs(c: &Ctx, out: &mut Vec<Primitive>, bounds: &mut Bounds) {
    let p = c.p;
    let cut_height = p.floor(&c.a.floor).and_then(|f| f.cut_height).unwrap_or(1.0);
    let range = super::view_range::ViewRange::of(p, &c.a.floor);
    // [151] Handlauf-Doppellinie ab 1:50 bzw. Detailstufe fein; [173] Modelldarstellung: aus/einfach/doppelt.
    let opts = c.mv().stair.clone();
    let double = opts.handrail.unwrap_or(c.a.scale <= 50.0 || c.a.detail == Detail::Fein);
    for s in p.stairs.as_deref().unwrap_or(&[]).iter().filter(|s| s.floor_id == c.a.floor && c.vis(&s.category_code, &s.id)) {
        let greyed = Some(c.greyed(&s.category_code));
        let ov = c.overrides(Some("stair"), &s.category_code, Some(&stair_label(s)));
        let lw = ov.lineweight.unwrap_or_else(|| c.cat(&s.category_code).map_or(WALL_FALLBACK_MM, |k| k.lw));
        let stroke = ov.color.as_deref().or(s.color.as_deref()).unwrap_or(POCHE_STROKE).to_string();
        let (zb, zt) = p.stair_vertical_extent(s);
        let zone = range.classify(zb, zt);
        if zone == super::view_range::Zone::Hidden {
            continue;
        }
        let out_start = out.len();
        let params = s.encode();
        let geo = crate::stair::decode_params(&params).filter(|_| (zt - zb).is_finite()).map(|sp| kernel2d::stair_geometry(&sp, zt - zb));
        if let Some(geo) = &geo {
            for t in &geo.treads {
                for q in &t.pts {
                    bounds.acc(q.x, q.y);
                }
            }
            for q in geo.landing.iter().chain(geo.landing2.iter()).flatten() {
                bounds.acc(q.x, q.y);
            }
        }
        let f = crate::plan::stair_symbol::plan_stair_run(&params, zt - zb, cut_height, lw, s.arrow_style == Some(StairArrowStyle::Filled), s.center_column.unwrap_or(0.0), railing_code(p, s), double, &[], &run_opts(&opts, c.a.scale, s));
        emit(out, &f, &stroke, greyed, &s.id, &opts);
        if let (true, Some(geo)) = (opts.step_numbers, &geo) {
            let avoid = arrow_boxes(&out[out_start..]);
            step_numbers(out, geo, cut_height, &opts, c.a.scale, &stroke, greyed, &avoid);
        }
        if let Some(d) = range.restyle_dash(zone) {
            super::view_range::restyle(out, out_start, d);
        }
    }
    arriving(c, out, double, &opts);
    underside(c, out, double, &opts);
}

/// [173] Höhe der Stufennummern (Papier-mm).
const STEP_NUMBER_MM: f64 = 1.8;

/// [173] Stufennummern (Modelldarstellung, Basis aus): je Tritt die Nummer ab Antritt (1, 2, …) in der Mitte des
/// Tritts; Tritte ganz über der Schnitthöhe nur, wenn die Stufe sie zeigt (`above_cut`).
/// [173] Umrisse (xmin, ymin, xmax, ymax) der Pfeilspitze der Lauflinie (Linien `stair-arrow` und gefüllte Spitze).
fn arrow_boxes(prims: &[Primitive]) -> Vec<[f64; 4]> {
    let bb = |pts: &[Vec2]| pts.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)]);
    prims
        .iter()
        .filter_map(|q| match q {
            Primitive::Line { a, b, cls, .. } if cls == "stair-arrow" => Some(bb(&[*a, *b])),
            Primitive::Polygon { pts, fill, stair_id: Some(_), .. } if fill != "none" && pts.len() == 3 => Some(bb(pts)),
            _ => None,
        })
        .collect()
}

fn step_numbers(out: &mut Vec<Primitive>, geo: &kernel2d::StairGeometry, cut_height: f64, opts: &super::model_view::StairOpts, scale: f64, stroke: &str, greyed: Option<bool>, avoid: &[[f64; 4]]) {
    let h = STEP_NUMBER_MM * scale / 1000.0;
    if !(h.is_finite() && h > 0.0) {
        return;
    }
    for (k, t) in geo.treads.iter().enumerate() {
        if t.pts.len() < 3 || (!opts.above_cut && t.base_rise > cut_height + 1e-6) {
            continue;
        }
        let n = t.pts.len() as f64;
        let (cx, cy) = t.pts.iter().fold((0.0, 0.0), |(x, y), q| (x + q.x / n, y + q.y / n));
        let text = (k + 1).to_string();
        let w = crate::text_layout::text_width_em(&text, false) * h;
        // Nummer, die die Pfeilspitze der Lauflinie berührt: seitlich (entlang der Trittkante) versetzen, im Tritt
        // bleibend; passt keine Stelle, entfällt sie.
        let hits = |x: f64, y: f64| avoid.iter().any(|b| x - w / 2.0 < b[2] + 0.3 * h && x + w / 2.0 > b[0] - 0.3 * h && y - 0.35 * h < b[3] + 0.3 * h && y + 0.65 * h > b[1] - 0.3 * h);
        let (mut cx, mut cy) = (cx, cy);
        if hits(cx, cy) {
            let (ex, ey) = (t.pts[1].x - t.pts[0].x, t.pts[1].y - t.pts[0].y);
            let el = ex.hypot(ey);
            let ring: Vec<[f64; 2]> = t.pts.iter().map(|q| [q.x, q.y]).collect();
            let spot = (2..=8).flat_map(|m| [1.0, -1.0].map(|sg| sg * m as f64 * 0.5 * h)).find_map(|d| {
                let (x, y) = (cx + ex / el * d, cy + ey / el * d);
                (el > 1e-9 && !hits(x, y) && crate::surface_pattern::point_in([x, y], &ring)).then_some((x, y))
            });
            match spot {
                Some((x, y)) => (cx, cy) = (x, y),
                None => continue,
            }
        }
        out.push(Primitive::DrawingText {
            at: v2(cx - w / 2.0, cy - 0.35 * h),
            text,
            height_m: h,
            angle: 0.0,
            color: stroke.to_string(),
            marks: None,
            wrap_width: None,
            doc: None,
            drawing_id: None,
            greyed,
            opacity: None,
        });
    }
}

/// [173] Lauflinie nach der Modelldarstellung: Versatz (Papier-mm → Meter bei 1:`scale`) und Antrittspunkt
/// (Halbmesser 0.75 mm Papier, nur mit Lauflinie).
fn run_opts(o: &super::model_view::StairOpts, scale: f64, s: &Stair) -> crate::plan::stair_symbol::RunOpts {
    let m = |mm: f64| if scale.is_finite() && scale > 0.0 { mm * scale / 1000.0 } else { 0.0 };
    crate::plan::stair_symbol::RunOpts { start: m(o.run_start_mm), end: m(o.run_end_mm), start_mark: (o.start_mark && o.walk_line).then(|| m(0.75)).filter(|r| *r > 0.0), rail_half: rail_half(s), no_break: false, break_mm: m(1.0) }
}

/// [T3] Halbe Handlaufbreite der Treppe (Meter).
fn rail_half(s: &Stair) -> f64 {
    crate::stairs3d::RailSpec::decode(s.rail_params()).rail_half_width()
}

/// [155] Treppen tieferer Geschosse, die auf diesem Geschoss ankommen: durch das Loch der Decke, auf der
/// das Geschoss steht, von oben gesehen (ausgezogen, auf das Loch beschnitten), dazu die Absturzsicherung
/// an den freien Lochrändern (nicht unter Wänden, nicht am Austritt der Treppe; Lage: [`crate::stair_guard`]).
fn arriving(c: &Ctx, out: &mut Vec<Primitive>, double: bool, opts: &super::model_view::StairOpts) {
    let p = c.p;
    let arrivals = crate::stair_guard::arrivals_in_plan(p, &c.a.floor, &|s| c.vis(&s.category_code, &s.id), &|| super::domains::wall_footprints(c));
    for a in arrivals {
        let s = &p.stairs.as_deref().unwrap_or(&[])[a.stair];
        let greyed = Some(c.greyed(&s.category_code));
        let ov = c.overrides(Some("stair"), &s.category_code, Some(&stair_label(s)));
        let lw = ov.lineweight.unwrap_or_else(|| c.cat(&s.category_code).map_or(WALL_FALLBACK_MM, |k| k.lw));
        let stroke = ov.color.as_deref().or(s.color.as_deref()).unwrap_or(POCHE_STROKE).to_string();
        // ganz unter der Schnittebene: alles ausgezogen, keine Bruchlinie
        let f = crate::plan::stair_symbol::plan_stair_run(&a.params, a.rise, a.rise + 1.0, lw, s.arrow_style == Some(StairArrowStyle::Filled), 0.0, railing_code(p, s), double, &a.rings, &run_opts(opts, c.a.scale, s));
        emit(out, &f, &stroke, greyed, &s.id, opts);
        for axis in &a.axes {
            let r = rail_half(s);
            let lines = if double { vec![crate::stair_rail::offset_polyline(axis, r), crate::stair_rail::offset_polyline(axis, -r)] } else { vec![axis.clone()] };
            for l in lines {
                for w in l.windows(2) {
                    out.push(stair_line(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), LINE_CLS[6], crate::plan::stair_symbol::HANDRAIL_MM, None, &stroke, greyed, &s.id));
                }
            }
        }
    }
}

/// [G1] Untersicht: Treppen (alle Formen: gerade, Podest, Wendel) des Geschosses darüber, die auf einer Decke dieses
/// Geschosses stehen, in deren Loch sichtbar sind; von unten gesehen ganz gestrichelt („über Schnitt"), auf das
/// Loch beschnitten. Ohne Deckenloch deckt die Decke die Treppe, dann entfällt sie (wie jedes Bauteil darüber).
fn underside(c: &Ctx, out: &mut Vec<Primitive>, double: bool, opts: &super::model_view::StairOpts) {
    let p = c.p;
    let Some(floor) = p.floor(&c.a.floor) else { return };
    if floor.kind != DrawingLevelKind::Floor {
        return;
    }
    let cut = super::view_range::ViewRange::of(p, &c.a.floor).cut;
    let ceilings: Vec<&Ceiling> = p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|ce| ce.floor_id == c.a.floor && c.vis(&ce.category_code, &ce.id)).collect();
    if ceilings.is_empty() {
        return;
    }
    for s in p.stairs.as_deref().unwrap_or(&[]).iter().filter(|s| s.floor_id != c.a.floor && c.vis(&s.category_code, &s.id)) {
        let (zb, zt) = p.stair_vertical_extent(s);
        if !(zb > cut && (zt - zb).is_finite()) {
            continue;
        }
        let params = s.encode();
        let Some(sp) = crate::stair::decode_params(&params) else { continue };
        let geo = kernel2d::stair_geometry(&sp, zt - zb);
        let centroid = |t: &kernel2d::TreadRect| {
            let n = t.pts.len().max(1) as f64;
            [t.pts.iter().map(|q| q.x).sum::<f64>() / n, t.pts.iter().map(|q| q.y).sum::<f64>() / n]
        };
        let rings: Vec<Vec<crate::stair_rail::P>> = ceilings
            .iter()
            .filter(|ce| {
                let top = p.ceiling_vertical_extent(ce).1;
                top >= zb - 0.3 && top <= zb + 0.05
            })
            .flat_map(|ce| crate::opening_shape::ceiling_hole_rings(p, ce))
            .map(|h| h.iter().map(|q| [q.x, q.y]).collect::<Vec<_>>())
            .filter(|h| h.len() >= 3 && h.iter().all(|q| q[0].is_finite() && q[1].is_finite()))
            .filter(|h| geo.treads.iter().any(|t| crate::surface_pattern::point_in(centroid(t), h)) || geo.landing.iter().chain(geo.landing2.iter()).any(|l| l.iter().any(|q| crate::surface_pattern::point_in([q.x, q.y], h))))
            .collect();
        if rings.is_empty() {
            continue;
        }
        let greyed = Some(c.greyed(&s.category_code));
        let ov = c.overrides(Some("stair"), &s.category_code, Some(&stair_label(s)));
        let lw = ov.lineweight.unwrap_or_else(|| c.cat(&s.category_code).map_or(WALL_FALLBACK_MM, |k| k.lw));
        let stroke = ov.color.as_deref().or(s.color.as_deref()).unwrap_or(POCHE_STROKE).to_string();
        // Schnitthöhe unter dem Treppenfuss (-1): jedes Element liegt über der Schnittebene, also ganz gestrichelt.
        let start = out.len();
        let f = crate::plan::stair_symbol::plan_stair_run(&params, zt - zb, -1.0, lw, s.arrow_style == Some(StairArrowStyle::Filled), s.center_column.unwrap_or(0.0), railing_code(p, s), double, &rings, &crate::plan::stair_symbol::RunOpts { no_break: true, ..run_opts(opts, c.a.scale, s) });
        emit(out, &f, &stroke, greyed, &s.id, opts);
        // Von unten gibt es keine Gehrichtung: Pfeil (Linien, gefüllte Spitze) und Bruchlinie entfallen.
        let mut k = 0;
        out.retain(|q| {
            k += 1;
            k <= start || !matches!(q, Primitive::Line { cls, .. } if cls == "stair-arrow" || cls == "stair-break") && !matches!(q, Primitive::Polygon { fill, .. } if fill != "none")
        });
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
