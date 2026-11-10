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
/// [155] Achse der Absturzsicherung: so weit vom Lochrand auf die Decke gerückt wie der Handlauf von der
/// Treppenkante (Rohr ganz auf der Decke).
const GUARD_INSET: f64 = crate::stair_rail::RAIL_INSET;
/// [155] Lochrand am Austritt: bis zu diesem Abstand von der Austrittskante keine Absturzsicherung.
const ARRIVAL_TOL: f64 = 0.15;

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
        color: Some(stroke.to_string()),
        drawing_id: None,
        opening_id: None,
        stair_id: Some(id.to_string()),
        greyed,
        opacity: None,
    }
}

/// Symbol-Puffer (`stair_symbol.rs`) als Primitive.
fn emit(out: &mut Vec<Primitive>, f: &[f64], stroke: &str, greyed: Option<bool>, id: &str) {
    if f.is_empty() {
        return;
    }
    let n = f[0] as usize;
    let mut i = 1;
    for _ in 0..n {
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
                    hatch: no_hatch(),
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
    // [151] Handlauf-Doppellinie ab 1:50 bzw. Detailstufe fein.
    let double = c.a.scale <= 50.0 || c.a.detail == Detail::Fein;
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
        if let Some(sp) = crate::stair::decode_params(&params).filter(|_| (zt - zb).is_finite()) {
            let geo = kernel2d::stair_geometry(&sp, zt - zb);
            for t in &geo.treads {
                for q in &t.pts {
                    bounds.acc(q.x, q.y);
                }
            }
            for q in geo.landing.iter().chain(geo.landing2.iter()).flatten() {
                bounds.acc(q.x, q.y);
            }
        }
        let f = crate::plan::stair_symbol::plan_stair(&params, zt - zb, cut_height, lw, s.arrow_style == Some(StairArrowStyle::Filled), s.center_column.unwrap_or(0.0), railing_code(p, s), double);
        emit(out, &f, &stroke, greyed, &s.id);
        if let Some(d) = range.restyle_dash(zone) {
            super::view_range::restyle(out, out_start, d);
        }
    }
    arriving(c, out, double);
}

/// [155] Treppen tieferer Geschosse, die auf diesem Geschoss ankommen: durch das Loch der Decke, auf der
/// das Geschoss steht, von oben gesehen (ausgezogen, auf das Loch beschnitten), dazu die Absturzsicherung
/// an den freien Lochrändern (nicht unter Wänden, nicht am Austritt der Treppe).
fn arriving(c: &Ctx, out: &mut Vec<Primitive>, double: bool) {
    use crate::stair_rail::P;
    let p = c.p;
    let Some(floor) = p.floor(&c.a.floor) else { return };
    // [157] Nur Geschoss-Grundrisse (nicht die 2D-Ebene eines Schnitts/einer Ansicht, Bezugshöhe sonst 0).
    if floor.kind != DrawingLevelKind::Floor {
        return;
    }
    let base = floor.base_elevation.unwrap_or(0.0);
    // Löcher der Decken unter dem Geschossboden (Oberkante wie bei den Bodenbelägen).
    let holes: Vec<Vec<P>> = p
        .ceilings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|ce| {
            let top = p.ceiling_vertical_extent(ce).1;
            top >= base - 0.3 && top <= base + 0.05
        })
        .flat_map(|ce| crate::opening_shape::ceiling_hole_rings(p, ce))
        .map(|h| h.iter().map(|q| [q.x, q.y]).collect::<Vec<P>>())
        .filter(|h| h.len() >= 3 && h.iter().all(|q| q[0].is_finite() && q[1].is_finite()))
        .collect();
    if holes.is_empty() {
        return;
    }
    let mut fps: Option<Vec<super::wall_poche::WallFootprint>> = None;
    for s in p.stairs.as_deref().unwrap_or(&[]).iter().filter(|s| s.floor_id != c.a.floor && c.vis(&s.category_code, &s.id)) {
        let (zb, zt) = p.stair_vertical_extent(s);
        if !((zt - base).abs() <= 0.05 && zb < base - 1e-6 && (zt - zb).is_finite()) {
            continue;
        }
        let params = s.encode();
        let Some(sp) = crate::stair::decode_params(&params) else { continue };
        let geo = kernel2d::stair_geometry(&sp, zt - zb);
        let centroid = |t: &kernel2d::TreadRect| {
            let n = t.pts.len().max(1) as f64;
            [t.pts.iter().map(|q| q.x).sum::<f64>() / n, t.pts.iter().map(|q| q.y).sum::<f64>() / n]
        };
        let own: Vec<Vec<P>> = holes.iter().filter(|h| geo.treads.iter().any(|t| crate::surface_pattern::point_in(centroid(t), h))).cloned().collect();
        if own.is_empty() {
            continue;
        }
        let greyed = Some(c.greyed(&s.category_code));
        let ov = c.overrides(Some("stair"), &s.category_code, Some(&stair_label(s)));
        let lw = ov.lineweight.unwrap_or_else(|| c.cat(&s.category_code).map_or(WALL_FALLBACK_MM, |k| k.lw));
        let stroke = ov.color.as_deref().or(s.color.as_deref()).unwrap_or(POCHE_STROKE).to_string();
        // ganz unter der Schnittebene: alles ausgezogen, keine Bruchlinie
        let f = crate::plan::stair_symbol::plan_stair_clipped(&params, zt - zb, zt - zb + 1.0, lw, s.arrow_style == Some(StairArrowStyle::Filled), 0.0, railing_code(p, s), double, &own);
        emit(out, &f, &stroke, greyed, &s.id);
        // Austrittskante: Hinterkante des obersten Tritts.
        let Some(last) = geo.treads.iter().filter(|t| t.pts.len() >= 4).max_by(|a, b| a.top_rise.total_cmp(&b.top_rise)) else { continue };
        let arrival = if sp.shape == "spiral" { (last.pts[3], last.pts[2]) } else { (last.pts[1], last.pts[2]) };
        let fps = fps.get_or_insert_with(|| super::domains::wall_footprints(c));
        for ring in &own {
            for pts in guard_chains(ring, fps, ([arrival.0.x, arrival.0.y], [arrival.1.x, arrival.1.y])) {
                let area: f64 = (0..ring.len()).map(|i| ring[i][0] * ring[(i + 1) % ring.len()][1] - ring[(i + 1) % ring.len()][0] * ring[i][1]).sum();
                // nach aussen (auf die Decke): rechts der Ringrichtung bei Gegenuhrzeigersinn
                let d = if area > 0.0 { -GUARD_INSET } else { GUARD_INSET };
                let axis = crate::stair_rail::offset_polyline(&pts, d);
                let r = crate::stair_rail::RAIL_THICK / 2.0;
                let lines = if double { vec![crate::stair_rail::offset_polyline(&axis, r), crate::stair_rail::offset_polyline(&axis, -r)] } else { vec![axis] };
                for l in lines {
                    for w in l.windows(2) {
                        out.push(stair_line(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), LINE_CLS[6], crate::plan::stair_symbol::HANDRAIL_MM, None, &stroke, greyed, &s.id));
                    }
                }
            }
        }
    }
}

/// [155] Freie Lochränder als Züge in Ringrichtung: ohne Stücke unter Wänden und ohne die Austrittskante.
fn guard_chains(ring: &[[f64; 2]], fps: &[super::wall_poche::WallFootprint], arrival: ([f64; 2], [f64; 2])) -> Vec<Vec<[f64; 2]>> {
    let near = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).abs() < 1e-7 && (a[1] - b[1]).abs() < 1e-7;
    let mut pieces: Vec<[[f64; 2]; 2]> = Vec::new();
    for [a, b] in super::wall_poche::ceiling_outline_lines(ring, &[], fps) {
        // Teil, der an der Austrittskante liegt (beide Enden der Kante nahe der Geraden a–b), entfällt.
        let d = [b[0] - a[0], b[1] - a[1]];
        let l = d[0].hypot(d[1]);
        if !(l > 1e-9) {
            continue;
        }
        let u = [d[0] / l, d[1] / l];
        let off = |q: [f64; 2]| ((q[0] - a[0]) * u[1] - (q[1] - a[1]) * u[0]).abs();
        let t = |q: [f64; 2]| ((q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1]) / l;
        let mut keep = vec![(0.0, 1.0)];
        if off(arrival.0) < ARRIVAL_TOL && off(arrival.1) < ARRIVAL_TOL {
            let pad = ARRIVAL_TOL / l;
            let (t0, t1) = (t(arrival.0).min(t(arrival.1)) - pad, t(arrival.0).max(t(arrival.1)) + pad);
            keep = [(0.0, t0.min(1.0)), (t1.max(0.0), 1.0)].into_iter().filter(|(x, y)| (y - x) * l > 1e-6).collect();
        }
        for (t0, t1) in keep {
            pieces.push([[a[0] + d[0] * t0, a[1] + d[1] * t0], [a[0] + d[0] * t1, a[1] + d[1] * t1]]);
        }
    }
    // aneinanderhängende Stücke zu Zügen
    let mut chains: Vec<Vec<[f64; 2]>> = Vec::new();
    for [a, b] in pieces {
        match chains.last_mut() {
            Some(ch) if ch.last().is_some_and(|q| near(*q, a)) => ch.push(b),
            _ => chains.push(vec![a, b]),
        }
    }
    // letzter Zug schliesst an den ersten an
    if chains.len() >= 2 && near(*chains.last().unwrap().last().unwrap(), chains[0][0]) {
        let mut last = chains.pop().unwrap();
        last.extend(chains[0].iter().skip(1).copied());
        chains[0] = last;
    }
    chains
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
