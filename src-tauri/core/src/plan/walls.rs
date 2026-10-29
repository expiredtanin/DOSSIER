//! Wände und Öffnungen im Grundriss auf dem Dokument ([K3d]): Filter, Override-Regeln,
//! Verschneidung, Stil (Bauteil, Schraffur, Farbe, Fugen-Linienstil) und Pick-IDs um die schon
//! portierte Geometrie (`plan_walls.rs`, `plan_openings.rs`) — Rust-Gegenstück zu
//! `generatePlan/{walls,openings}.ts` und der Wand-Schleife in `generatePlan.ts`.
//!
//! Die Geometrie-Funktionen nehmen weiter ihren flachen Puffer; er wird hier genau so aufgebaut wie
//! früher in TS, damit das Ergebnis bitgleich bleibt.

use super::domains::Ctx;
use super::prim::{HatchRender, Primitive};
use super::style::*;
use crate::joins::{self, WallCuts};
use crate::js_fmt::to_fixed;
use crate::jsnum::{atan2, round};
use crate::model::*;
use std::collections::HashMap;

/// Linienklassen der Öffnungs-Kodierung (`plan_openings.rs`).
const LINE_CLS: [&str; 11] = [
    "door-leaf", "door-frame", "door-lintel", "opening-frame", "window-glass", "window-mullion", "window-sash", "window-stulp", "window-sill", "window-frame", "window-shading",
];

fn dash_of(code: f64) -> Option<Vec<f64>> {
    match code as i64 {
        1 => Some(vec![0.18, 0.09]),
        2 => Some(OVERHEAD_DASH.to_vec()),
        3 => Some(vec![0.04, 0.08]),
        _ => None,
    }
}

/// `openingLabel` (für `object_name`).
pub fn opening_label(o: &Opening) -> String {
    format!("{} {}×{}", if o.kind == ElementKind::Door { "Tür" } else { "Fenster" }, to_fixed(o.width * 100.0, 0), to_fixed(o.height * 100.0, 0))
}

/// Wandtyp; hängender Verweis (Datei/Import) → Rückfall-Typ, nie ein Fehler.
fn wall_type<'a>(p: &'a Project, w: &Wall) -> Result<&'a WallType, String> {
    Ok(p.wall_type_or_fallback(w))
}

/// Verschneidung der gezeichneten Wände (`computeJoins` in TS, gleicher Puffer). Fehler wie die
/// Modell-Helfer in TS (unbekannter Wandtyp/Bauteil).
fn plan_joins(p: &Project, walls: &[EffWall]) -> Result<Vec<WallCuts>, String> {
    let mut buf = vec![walls.len() as f64];
    let mut comp_index: HashMap<&str, usize> = HashMap::new();
    for e in walls {
        let w = e.w;
        buf.extend([w.start.x, w.start.y, w.end.x, w.end.y]);
        match (w.reference_offset, w.reference_line) {
            (Some(v), _) => buf.extend([3.0, v]),
            (None, Some(WallReferenceLine::Left)) => buf.extend([1.0, 0.0]),
            (None, Some(WallReferenceLine::Right)) => buf.extend([2.0, 0.0]),
            _ => buf.extend([0.0, 0.0]),
        }
        // Hängende Wandtypen/Bauteile (Datei/Import) verschneiden mit den Rückfall-Werten.
        let wt = p.wall_type_or_fallback(w);
        buf.extend([1.0, wt.layers.len() as f64]);
        for l in &wt.layers {
            let comp = p.component_or_fallback(&l.component_id);
            let n = comp_index.len();
            let idx = *comp_index.entry(comp.id.as_str()).or_insert(n) as f64;
            buf.extend([l.thickness, idx, comp.join_priority]);
        }
    }
    let out = joins::compute_joins_flat(&buf);
    // Fehler der Verschneidung (mit den Rückfällen oben nicht mehr erwartet): Wände ohne Verschneidung.
    if out.first() != Some(&0.0) {
        return Ok(vec![WallCuts::default(); walls.len()]);
    }
    let mut r = crate::flat_read::Reader::new(&out[1..]);
    let mut cuts = Vec::with_capacity(walls.len());
    for _ in walls {
        cuts.push(joins::decode_cuts(&mut r).unwrap_or_default());
    }
    Ok(cuts)
}

/// Wand mit angewandten Override-Regeln (Farbe → Umriss/Fugen, Strichstärke).
struct EffWall<'a> {
    w: &'a Wall,
    color: Option<String>,
    stroke_weight: Option<f64>,
}

/// `wallTypeThickness` (Summe ab 0 wie `reduce` in TS).
fn thickness(layers: &[Layer]) -> f64 {
    layers.iter().fold(0.0, |s, l| s + l.thickness)
}

fn line_buf(out: &mut Vec<f64>, l: Option<&joins::Line>) {
    match l {
        Some(l) => out.extend([1.0, l.point.x, l.point.y, l.dir.x, l.dir.y]),
        None => out.extend([0.0; 5]),
    }
}

/// Eingabe von `plan_walls::wall_poche` (wie `encodeWallPoche` in TS).
#[allow(clippy::too_many_arguments)]
fn encode_wall_poche(w: &Wall, layers: &[f64], total: f64, ref_off: f64, gaps: &[(f64, f64)], cuts: &WallCuts, grob: bool, view_only: bool) -> Vec<f64> {
    let mut b = vec![w.start.x, w.start.y, w.end.x, w.end.y, total, ref_off, if grob { 1.0 } else { 0.0 }, if view_only { 1.0 } else { 0.0 }];
    b.push(layers.len() as f64);
    b.extend_from_slice(layers);
    line_buf(&mut b, cuts.start_cut.as_ref());
    line_buf(&mut b, cuts.end_cut.as_ref());
    match &cuts.layer_cuts {
        Some(lc) => {
            b.push(1.0);
            let at = |v: &Vec<Option<joins::Line>>, i: usize| v.get(i).copied().flatten();
            for i in 0..layers.len() {
                line_buf(&mut b, at(&lc.start, i).as_ref());
                line_buf(&mut b, at(&lc.end, i).as_ref());
                line_buf(&mut b, at(&lc.start_side, i).as_ref());
                line_buf(&mut b, at(&lc.end_side, i).as_ref());
            }
        }
        None => b.push(0.0),
    }
    b.push(cuts.span_cutouts.len() as f64);
    for c in &cuts.span_cutouts {
        b.extend([c.from, c.to, c.off_a, c.off_b]);
    }
    b.push(gaps.len() as f64);
    for g in gaps {
        b.extend([g.0, g.1]);
    }
    b
}

#[allow(clippy::too_many_arguments)]
fn wall_polygon(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, hatch: HatchRender, greyed: bool, no_stroke_edges: Option<Vec<f64>>, wall_id: Option<&str>, opening_id: Option<&str>) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: stroke.into(),
        stroke_width_mm: w,
        hatch,
        greyed: Some(greyed),
        opacity: None,
        no_stroke_edges,
        wall_id: wall_id.map(String::from),
        drawing_id: None,
        ceiling_id: None,
        opening_id: opening_id.map(String::from),
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: None,
        column_id: None,
        roof_id: None,
        section_line_id: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn mk_line(a: Vec2, b: Vec2, cls: &str, w: f64, dash: super::prim::Dash, color: Option<&str>, greyed: bool, opening_id: Option<&str>) -> Primitive {
    Primitive::Line { a, b, cls: cls.into(), weight_mm: w, dash, zigzag: None, motif: None, color: color.map(String::from), drawing_id: None, opening_id: opening_id.map(String::from), stair_id: None, greyed: Some(greyed), opacity: None }
}

fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Wand-Poché (`addWallPoche`).
#[allow(clippy::too_many_arguments)]
fn wall_poche(c: &Ctx, out: &mut Vec<Primitive>, e: &EffWall, gaps: &[(f64, f64)], cuts: &WallCuts, greyed: bool, wall_lw: f64, category: Option<&LayerCategory>, view_only: bool) -> Result<(), String> {
    let p = c.p;
    let w = e.w;
    let detail = c.a.detail;
    let wt = wall_type(p, w)?;
    let total = thickness(&wt.layers);
    let ref_off = joins::reference_offset(crate::model3d::wall_reference(w), total);
    let angle = atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180.0 / std::f64::consts::PI;
    let stroke = e.color.as_deref().unwrap_or(POCHE_STROKE);
    let outline_mm = wall_lw * detail.outline_factor();
    let layer_mm = LAYER_LINE_MM * detail.layer_factor();
    let thick: Vec<f64> = wt.layers.iter().map(|l| l.thickness).collect();
    let f = crate::plan_walls::wall_poche(&encode_wall_poche(w, &thick, total, ref_off, gaps, cuts, detail == Detail::Grob, view_only));
    if f.is_empty() {
        return Ok(());
    }
    let mut styles: HashMap<usize, (HatchRender, String)> = HashMap::new();
    let mut style_of = |li: usize| -> Result<(HatchRender, String), String> {
        if let Some(s) = styles.get(&li) {
            return Ok(s.clone());
        }
        let layer = wt.layers.get(li).ok_or("Schicht fehlt")?;
        let comp = p.component_or_fallback(&layer.component_id);
        let hid = resolve_hatch_id(w.hatch_id.as_deref(), w.hatch_source, category, Some(&comp.hatch_id)).unwrap_or(&comp.hatch_id);
        let hatch = super::domains::resolve_hatch_or_none(p, hid, Some(angle), resolve_foreground(comp, w.foreground.as_deref(), category, w.foreground_source));
        let bg = resolve_background(comp, w.background.as_deref(), category, w.background_source);
        let fill = bg.unwrap_or(if hatch.pattern == HatchPattern::Solid { HATCH_INK } else { HATCH_PAPER }).to_string();
        styles.insert(li, (hatch.clone(), fill.clone()));
        Ok((hatch, fill))
    };
    let n = f[0] as usize;
    let mut i = 1;
    for _ in 0..n {
        if f[i] == 1.0 {
            let art = f[i + 1];
            let li = f[i + 2] as usize;
            let n_no = f[i + 3] as usize;
            let no_stroke = f[i + 4..i + 4 + n_no].to_vec();
            let q = i + 4 + n_no;
            let pts: Vec<Vec2> = (0..4).map(|j| v2(f[q + 2 * j], f[q + 2 * j + 1])).collect();
            i = q + 8;
            if art == 2.0 {
                let (hatch, fill) = style_of(li)?;
                out.push(wall_polygon(pts, &fill, "none", 0.0, hatch, greyed, Some(no_stroke), Some(&w.id), None));
            } else {
                let fill = if art == 1.0 { HATCH_INK } else { "none" };
                let sw = if art == 0.0 { layer_mm } else { outline_mm };
                out.push(wall_polygon(pts, fill, stroke, sw, no_hatch(), greyed, Some(no_stroke), Some(&w.id), None));
            }
        } else {
            let art = f[i + 1];
            let li = f[i + 2] as usize;
            let a = v2(f[i + 3], f[i + 4]);
            let b = v2(f[i + 5], f[i + 6]);
            i += 7;
            if art == 0.0 {
                out.push(mk_line(a, b, "layer-joint-l", layer_mm, None, Some(stroke), greyed, None));
            } else if art == 1.0 {
                let jls = wt.layers.get(li).and_then(|l| l.joint_line_style_id.as_deref()).filter(|s| !s.is_empty()).and_then(|id| p.line_style(id));
                let mut l = mk_line(
                    a,
                    b,
                    "layer-joint",
                    jls.map_or(layer_mm, |s| s.weight * detail.layer_factor()),
                    Some(jls.and_then(|s| s.dash.clone())),
                    Some(jls.map_or(stroke, |s| s.color.as_str())),
                    greyed,
                    None,
                );
                if let (Primitive::Line { zigzag, motif, .. }, Some(s)) = (&mut l, jls) {
                    if s.kind == Some(LineStyleKind::Zigzag) {
                        *zigzag = s.zigzag.clone();
                    }
                    if s.kind == Some(LineStyleKind::Custom) {
                        *motif = s.motif.clone();
                    }
                }
                out.push(l);
            } else {
                out.push(mk_line(a, b, "wall-outline", outline_mm, None, Some(stroke), greyed, None));
            }
        }
    }
    Ok(())
}

/// Sashes eines Fenstertyps (`sashesOfWindowType`): fehlend → aus `wingCount` gleichmässig.
fn sashes(wt: &WindowType) -> Vec<SashDef> {
    if let Some(s) = wt.sashes.as_ref().filter(|s| !s.is_empty()) {
        return s.clone();
    }
    let wc = if wt.wing_count == 0.0 || wt.wing_count.is_nan() { 1.0 } else { wt.wing_count };
    let n = crate::jsnum::max(1.0, round(wc)) as usize;
    let opening = if wt.kind == OpeningKind::Fest { OpeningKind::Fest } else { wt.kind };
    (0..n).map(|i| SashDef { kind: SashDefKind::Fluegel, auto_width: Some(true), opening: Some(opening), hinge_side: Some(if i % 2 == 0 { SashDefHingeSide::Left } else { SashDefHingeSide::Right }), ..Default::default() }).collect()
}

fn door_type<'a>(p: &'a Project, o: &Opening) -> Option<&'a DoorType> {
    let id = o.type_id.as_deref().filter(|s| !s.is_empty())?;
    p.door_types.as_deref()?.iter().find(|t| t.id == id)
}

fn window_type<'a>(p: &'a Project, o: &Opening) -> Option<&'a WindowType> {
    let id = o.type_id.as_deref().filter(|s| !s.is_empty())?;
    p.window_types.as_deref()?.iter().find(|t| t.id == id)
}

/// Öffnungs-Symbol (`addOpeningSymbol`).
#[allow(clippy::too_many_arguments)]
fn opening_symbol(c: &Ctx, out: &mut Vec<Primitive>, w: &Wall, o: &Opening, color: Option<&str>, greyed: bool, detail: Detail, lw: f64) -> Result<(), String> {
    let p = c.p;
    let total = thickness(&wall_type(p, w)?.layers);
    let ref_off = joins::reference_offset(crate::model3d::wall_reference(w), total);
    let door = o.kind == ElementKind::Door;
    let wt = if door { None } else { window_type(p, o) };
    // Rahmenband nur bei Türen mit Typ (Fenster zeichnen es selbst).
    let dt = if door { door_type(p, o) } else { None };
    let sash_list = wt.map(sashes).unwrap_or_default();
    let stroke = color.unwrap_or(POCHE_STROKE);
    let frame_color = o.frame_line.as_ref().and_then(|l| l.color.as_deref()).unwrap_or(stroke);
    let frame_weight = o.frame_line.as_ref().and_then(|l| l.weight).unwrap_or(lw);
    let frame_view_weight = o.frame_view_line.as_ref().and_then(|l| l.weight).unwrap_or(frame_weight);
    let colors = [
        "",
        stroke,
        frame_color,
        o.frame_view_line.as_ref().and_then(|l| l.color.as_deref()).unwrap_or(frame_color),
        o.sash_line.as_ref().and_then(|l| l.color.as_deref()).unwrap_or(stroke),
        o.sill_line_style.as_ref().and_then(|l| l.color.as_deref()).unwrap_or(stroke),
    ];
    let b01 = |b: bool| if b { 1.0 } else { 0.0 };
    let detail_code = match detail {
        Detail::Grob => 0.0,
        Detail::Mittel => 1.0,
        Detail::Fein => 2.0,
    };
    let mut b: Vec<f64> = vec![w.start.x, w.start.y, w.end.x, w.end.y, total, ref_off, o.position, o.width, b01(door), detail_code];
    // Tür
    b.push(b01(o.swing.is_some_and(|s| s != SwingSide::Left)));
    b.push(b01(o.opening_dir.is_some_and(|s| s != OpeningOpeningDir::In)));
    b.push(b01(o.hinge.is_some_and(|s| s != OpeningHinge::Start)));
    b.push(o.swing_angle.unwrap_or(f64::NAN));
    b.push(b01(o.door_type == Some(OpeningDoorType::Wandoeffnung)));
    b.push(if door { crate::jsnum::max(1.0, round(door_type(p, o).map_or(1.0, |t| t.leaf_count))) } else { 1.0 });
    b.push(match o.lintel_lines.unwrap_or(OpeningLintelLines::Beide) {
        OpeningLintelLines::Keine => 0.0,
        OpeningLintelLines::Aussen => 1.0,
        OpeningLintelLines::Innen => 2.0,
        OpeningLintelLines::Beide => 3.0,
        OpeningLintelLines::Unknown => f64::NAN,
    });
    // Rahmenband (Tür mit Typ)
    match dt {
        Some(t) => b.extend([
            1.0,
            t.frame_width.unwrap_or(0.06),
            b01(t.frame_kind == Some(DoorTypeFrameKind::Blockrahmen)),
            t.inset_from_face.unwrap_or(0.0),
            b01(t.inset_face == Some(DoorTypeInsetFace::Innen)),
        ]),
        None => b.extend([0.0, 0.0, 0.0, 0.0, 0.0]),
    }
    // Fenster
    b.push(b01(wt.is_some()));
    b.push(wt.map_or(0.0, |t| t.frame_width.unwrap_or(0.06)));
    b.push(wt.and_then(|t| t.frame_depth).unwrap_or(f64::NAN));
    b.push(wt.and_then(|t| t.inset_from_face).unwrap_or(f64::NAN));
    b.push(b01(wt.and_then(|t| t.inset_face) == Some(WindowTypeInsetFace::Innen)));
    b.push(o.wing_count.unwrap_or(f64::NAN));
    b.push(if detail == Detail::Fein { 2.0 } else { 1.0 });
    let sill = wt.and_then(|t| t.sill_line.as_ref());
    b.push(sill.map_or(0.0, |s| match s.faces {
        WindowTypeSillLineFaces::Aussen => 1.0,
        WindowTypeSillLineFaces::Innen => 2.0,
        WindowTypeSillLineFaces::Beide => 3.0,
        WindowTypeSillLineFaces::Unknown => f64::NAN,
    }));
    b.push(b01(sill.is_some_and(|s| s.view == WindowTypeSillLineView::Unter)));
    let shading = wt.and_then(|t| t.shading.as_ref());
    b.push(b01(shading.is_some_and(|s| s.create)));
    b.push(shading.map_or(0.0, |s| s.r#box.width));
    b.push(shading.map_or(0.0, |s| s.r#box.height));
    // Strichstärken
    b.push(SYMBOL_HAIRLINE_MM);
    b.push(o.frame_line.as_ref().and_then(|l| l.weight).unwrap_or(SYMBOL_HAIRLINE_MM));
    b.push(frame_view_weight);
    b.push(o.sash_line.as_ref().and_then(|l| l.weight).unwrap_or(SYMBOL_HAIRLINE_MM));
    b.push(o.sill_line_style.as_ref().and_then(|l| l.weight).unwrap_or(SYMBOL_HAIRLINE_MM));
    b.push(sash_list.len() as f64);
    for s in &sash_list {
        b.extend([
            b01(s.kind == SashDefKind::Pfosten),
            if s.auto_width == Some(false) { 0.0 } else { 1.0 },
            s.width.unwrap_or(f64::NAN),
            s.post_width.unwrap_or(f64::NAN),
            b01(s.opening.is_some_and(|k| k != OpeningKind::Fest)),
        ]);
    }
    let f = crate::plan_openings::plan_opening(&b);
    if f.is_empty() {
        return Ok(());
    }
    let id = Some(o.id.as_str());
    let slot = |k: f64| colors.get(k as usize).copied().unwrap_or("");
    let n = f[0] as usize;
    let mut i = 1;
    for _ in 0..n {
        if f[i] == 1.0 {
            let count = f[i + 4] as usize;
            let pts: Vec<Vec2> = (0..count).map(|j| v2(f[i + 5 + 2 * j], f[i + 6 + 2 * j])).collect();
            let frame = f[i + 1] == 1.0;
            out.push(wall_polygon(pts, "none", if frame { slot(f[i + 3]) } else { "none" }, f[i + 2], no_hatch(), greyed, None, None, id));
            i += 5 + 2 * count;
        } else if f[i] == 2.0 {
            let s = f[i + 3];
            let cls = LINE_CLS.get(f[i + 1] as usize).copied().unwrap_or("");
            out.push(mk_line(v2(f[i + 5], f[i + 6]), v2(f[i + 7], f[i + 8]), cls, f[i + 2], dash_of(f[i + 4]).map(Some), (s != 0.0).then(|| slot(s)), greyed, id));
            i += 9;
        } else {
            out.push(Primitive::Arc {
                center: v2(f[i + 2], f[i + 3]),
                from: v2(f[i + 4], f[i + 5]),
                to: v2(f[i + 6], f[i + 7]),
                r: f[i + 8],
                cls: "door-swing".into(),
                weight_mm: f[i + 1],
                dash: None,
                opening_id: Some(o.id.clone()),
                stair_id: None,
                greyed: Some(greyed),
                opacity: None,
            });
            i += 9;
        }
    }
    Ok(())
}

/// Wände (Poché, Referenzlinie) und ihre Öffnungs-Symbole in Zeichenreihenfolge, dazu das Ausmass
/// der Wand-Ecken (`computeBounds`).
pub fn plan_walls(c: &Ctx, reference_lines: bool, out: &mut Vec<Primitive>, bounds: &mut super::domains::Bounds) -> Result<(), String> {
    let p = c.p;
    let type_names: HashMap<&str, &str> = p.wall_types.iter().map(|t| (t.id.as_str(), t.name.as_str())).collect();
    let walls: Vec<EffWall> = p
        .walls
        .iter()
        .filter(|w| w.floor_id == c.a.floor && c.shown(&w.category_code))
        .map(|w| {
            let ov = c.overrides(&w.category_code, type_names.get(w.wall_type_id.as_str()).copied());
            EffWall { w, color: ov.color.or_else(|| w.color.clone()), stroke_weight: ov.lineweight.or(w.stroke_weight) }
        })
        .collect();
    let cuts = plan_joins(p, &walls)?;
    let floor = p.floor(&c.a.floor);
    let cut_z = floor.and_then(|f| f.base_elevation).unwrap_or(0.0) + floor.and_then(|f| f.cut_height).unwrap_or(1.0);
    // Bei doppelten Wand-ids gewinnt in TS (Map) die letzte Verschneidung.
    let mut cut_by_id: HashMap<&str, &WallCuts> = HashMap::new();
    for (e, k) in walls.iter().zip(&cuts) {
        cut_by_id.insert(e.w.id.as_str(), k);
    }
    for e in &walls {
        let w = e.w;
        bounds_wall(p, w, bounds);
        let greyed = c.greyed(&w.category_code);
        let category = c.cat(&w.category_code);
        let lw = resolve_stroke_weight(e.stroke_weight, w.stroke_weight_source, category, category.map_or(WALL_FALLBACK_MM, |k| k.lw));
        let openings: Vec<&Opening> = p.openings_of_wall(&w.id).collect();
        let wr_total = p.wall_thickness(w, 0.2);
        let wr = crate::opening_geom::WallRef {
            start: crate::opening_geom::v(w.start.x, w.start.y),
            end: crate::opening_geom::v(w.end.x, w.end.y),
            total: wr_total,
            ref_off: joins::reference_offset(crate::model3d::wall_reference(w), wr_total),
        };
        let mut gaps: Vec<(f64, f64)> = openings.iter().filter_map(|o| crate::opening_geom::opening_interval(&wr, o.position, o.width)).collect();
        gaps.sort_by(|a, b| (a.0 - b.0).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
        let empty = WallCuts::default();
        let cut = cut_by_id.get(w.id.as_str()).copied().unwrap_or(&empty);
        let (zb, zt) = p.wall_vertical_extent(w);
        let view_only = zt < cut_z || zb > cut_z;
        wall_poche(c, out, e, &gaps, cut, greyed, lw, category, view_only)?;
        if reference_lines {
            out.push(mk_line(w.start, w.end, "wall-axis", 0.13, Some(Some(vec![0.18, 0.06, 0.04, 0.06])), None, greyed, None));
        }
        for o in openings {
            if !c.shown(&o.category_code) {
                continue;
            }
            let ov = c.overrides(&o.category_code, Some(&opening_label(o)));
            let olw = ov.lineweight.unwrap_or_else(|| c.cat(&o.category_code).map_or(LAYER_LINE_MM, |k| k.lw));
            let color = ov.color.as_deref().or(o.color.as_deref());
            let detail = match o.detail_level {
                Some(DetailLevel::Grob) => Detail::Grob,
                Some(DetailLevel::Mittel) => Detail::Mittel,
                Some(DetailLevel::Fein) => Detail::Fein,
                _ => c.a.detail,
            };
            opening_symbol(c, out, w, o, color, c.greyed(&o.category_code), detail, olw)?;
        }
    }
    Ok(())
}

/// Wand-Ecken (`wallCorners` mit Typ-Dicke) ins Ausmass.
fn bounds_wall(p: &Project, w: &Wall, bounds: &mut super::domains::Bounds) {
    let Some(wt) = p.wall_type(w) else { return };
    let h = thickness(&wt.layers) / 2.0;
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = crate::jsmath::hypot2(dx, dy);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let (ux, uy) = (dx / l, dy / l);
    let (nx, ny) = (-uy, ux);
    for (q, off) in [(w.start, h), (w.end, h), (w.end, -h), (w.start, -h)] {
        bounds.acc(q.x + nx * off, q.y + ny * off);
    }
}
