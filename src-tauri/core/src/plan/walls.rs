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
use crate::wall_arc::Unroll;
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
    // Fehler der Verschneidung (mit den Rückfällen oben nicht mehr erwartet): Wände ohne Verschneidung.
    let Some(mut jw) = joins::decode_walls(&buf) else {
        return Ok(vec![WallCuts::default(); walls.len()]);
    };
    // Bogenwände ([T2]) tragen ihren Bulge.
    for (j, e) in jw.iter_mut().zip(walls) {
        j.bulge = e.w.bulge;
    }
    Ok(joins::compute_joins(&jw).unwrap_or_else(|_| vec![WallCuts::default(); walls.len()]))
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
fn encode_wall_poche(w: &Wall, layers: &[f64], total: f64, ref_off: f64, gaps: &[(f64, f64)], cuts: &WallCuts, grob: bool, view_only: bool, reveals: &[f64]) -> Vec<f64> {
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
        b.extend([c.from, c.to, c.off_a, c.off_b, c.from_b, c.to_b]);
    }
    b.push(gaps.len() as f64);
    for g in gaps {
        b.extend([g.0, g.1]);
    }
    // [106] Schichteinzug an den Leibungen.
    if reveals.first().is_some_and(|n| *n > 0.0) {
        b.extend_from_slice(reveals);
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
fn wall_poche(c: &Ctx, out: &mut Vec<Primitive>, e: &EffWall, gaps: &[(f64, f64)], cuts: &WallCuts, greyed: bool, wall_lw: f64, category: Option<&LayerCategory>, view_only: bool, reveals: &[f64], bend: Option<&Unroll>) -> Result<(), String> {
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
    let f = crate::plan_walls::wall_poche(&encode_wall_poche(w, &thick, total, ref_off, gaps, cuts, detail == Detail::Grob, view_only, reveals));
    if f.is_empty() {
        return Ok(());
    }
    let mut styles: HashMap<usize, (HatchRender, String)> = HashMap::new();
    let mut style_of = |li: usize| -> Result<(HatchRender, String), String> {
        if let Some(s) = styles.get(&li) {
            return Ok(s.clone());
        }
        let (hatch, fill) = layer_style(p, w, wt, li, category, angle)?;
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
            if let (Some(u), true) = (bend, art == 2.0) {
                // [T2] Bogenwand: Schichtband in Winkelstücke teilen, damit die Schraffur der
                // Tangente folgt (gebogen wird danach in `bend_prims`).
                for (piece, s_mid) in split_band(u, &pts) {
                    let t = u.arc.tangent(s_mid);
                    let local = atan2(t.y, t.x) * 180.0 / std::f64::consts::PI;
                    let (hatch, fill) = layer_style(p, w, wt, li, category, local)?;
                    let all: Vec<f64> = (0..piece.len()).map(|k| k as f64).collect();
                    out.push(wall_polygon(piece, &fill, "none", 0.0, hatch, greyed, Some(all), Some(&w.id), None));
                }
                continue;
            }
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

/// Schraffur und Füllung der Schicht `li` im Wandschnitt (Bauteil, Wand- und Kategorie-Übersteuerung).
fn layer_style(p: &Project, w: &Wall, wt: &WallType, li: usize, category: Option<&LayerCategory>, angle: f64) -> Result<(HatchRender, String), String> {
    let layer = wt.layers.get(li).ok_or("Schicht fehlt")?;
    let comp = p.component_or_fallback(&layer.component_id);
    let hid = resolve_hatch_id(w.hatch_id.as_deref(), w.hatch_source, category, Some(&comp.hatch_id)).unwrap_or(&comp.hatch_id);
    let hatch = super::domains::resolve_hatch_or_none(p, hid, Some(angle), resolve_foreground(comp, w.foreground.as_deref(), category, w.foreground_source));
    let bg = resolve_background(comp, w.background.as_deref(), category, w.background_source);
    let fill = bg.unwrap_or(if hatch.pattern == HatchPattern::Solid { HATCH_INK } else { HATCH_PAPER }).to_string();
    Ok((hatch, fill))
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
fn opening_symbol(c: &Ctx, out: &mut Vec<Primitive>, w: &Wall, o: &Opening, color: Option<&str>, greyed: bool, detail: Detail, lw: f64, wall_line: (&str, f64)) -> Result<(), String> {
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
    // [105] Rahmen-Detail und Türzarge (eigene Zeichnung in `opening_detail_plan`).
    let det = crate::opening_detail::frame_of(p, o).filter(|f| f.detailed);
    let dframe = crate::opening_detail::door_frame_of(p, o);
    // Verbreiterungsprofile: das Fenster-Element sitzt um sie eingerückt in der Rohbauöffnung.
    let (ext_l, ext_r) = det.as_ref().filter(|_| !door).map_or((0.0, 0.0), |f| (f.ext.left, f.ext.right));
    let (o_pos, o_wid) = if ext_l + ext_r > 1e-6 && o.width - ext_l - ext_r > 0.05 { (o.position + ext_l, o.width - ext_l - ext_r) } else { (o.position, o.width) };
    let mut b: Vec<f64> = vec![w.start.x, w.start.y, w.end.x, w.end.y, total, ref_off, o_pos, o_wid, b01(door), detail_code];
    // Tür
    b.push(b01(o.swing.is_some_and(|s| s != SwingSide::Left)));
    b.push(b01(o.opening_dir.is_some_and(|s| s != OpeningOpeningDir::In)));
    b.push(b01(o.hinge.is_some_and(|s| s != OpeningHinge::Start)));
    b.push(o.swing_angle.unwrap_or(f64::NAN));
    b.push(b01(o.door_type == Some(OpeningDoorType::Wandoeffnung) || (door && door_type(p, o).is_some_and(|t| t.kind == DoorTypeKind::Wandoeffnung))));
    b.push(if door { crate::jsnum::max(1.0, round(door_type(p, o).map_or(1.0, |t| t.leaf_count))) } else { 1.0 });
    b.push(match o.lintel_lines.unwrap_or(OpeningLintelLines::Beide) {
        OpeningLintelLines::Keine => 0.0,
        OpeningLintelLines::Aussen => 1.0,
        OpeningLintelLines::Innen => 2.0,
        OpeningLintelLines::Beide => 3.0,
        OpeningLintelLines::Unknown => f64::NAN,
    });
    // Rahmenband (Tür mit Typ; Zargen-Arten [105] zeichnet `opening_detail_plan`)
    match dt.filter(|_| dframe.is_none()) {
        Some(t) => b.extend([
            1.0,
            t.frame_width.unwrap_or(0.06),
            b01(t.frame_kind == Some(DoorTypeFrameKind::Blockrahmen)),
            t.inset_from_face.unwrap_or(0.0),
            match t.inset_face {
                Some(DoorTypeInsetFace::Innen) => 1.0,
                Some(DoorTypeInsetFace::Mitte) => 2.0,
                _ => 0.0,
            },
        ]),
        None => b.extend([0.0, 0.0, 0.0, 0.0, 0.0]),
    }
    // Fenster
    b.push(b01(wt.is_some()));
    match det.as_ref().filter(|_| wt.is_some()) {
        // [105]: Rahmen je Seite (links hier, rechts im Anhang), Tiefe/Lage übersteuert.
        Some(f) => b.extend([
            f.sides.left,
            f.depth,
            f.inset,
            match f.face {
                crate::opening_detail::Face::Innen => 1.0,
                crate::opening_detail::Face::Mitte => 2.0,
                crate::opening_detail::Face::Aussen => 0.0,
            },
        ]),
        None => {
            b.push(wt.map_or(0.0, |t| t.frame_width.unwrap_or(0.06)));
            b.push(wt.and_then(|t| t.frame_depth).unwrap_or(f64::NAN));
            b.push(wt.and_then(|t| t.inset_from_face).unwrap_or(f64::NAN));
            b.push(match wt.and_then(|t| t.inset_face) {
                Some(WindowTypeInsetFace::Innen) => 1.0,
                Some(WindowTypeInsetFace::Mitte) => 2.0,
                _ => 0.0,
            });
        }
    }
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
    // Details ([94]): Anschlag, Fensterbank, Storenkasten.
    // Anschlag: je Seite verschieden ⇒ zeichnet `opening_detail_plan`.
    let rebate_sides = det.as_ref().map(|f| f.rebate).filter(|r| (r.left - r.right).abs() > 1e-9 || dframe.is_some());
    b.push(match (&det, rebate_sides) {
        (_, Some(_)) => 0.0,
        (Some(f), None) => f.rebate.left,
        (None, None) => if door { dt.and_then(|t| t.rebate_depth) } else { wt.and_then(|t| t.rebate_depth) }.unwrap_or(0.0),
    });
    b.push(match wt.and_then(|t| t.sill_board) {
        Some(WindowTypeSillBoard::Keine) => 1.0,
        Some(WindowTypeSillBoard::Innen) => 2.0,
        Some(WindowTypeSillBoard::Beide) => 3.0,
        Some(WindowTypeSillBoard::Aussen) => 4.0,
        _ => 0.0,
    });
    b.push(b01(shading.is_some_and(|s| s.mount == Some(WindowShadingMount::Sturz))));
    b.push(shading.map_or(0.0, |s| s.r#box.depth));
    b.push(match shading.map(|s| s.kind) {
        Some(WindowShadingKind::Raffstore) => 1.0,
        Some(WindowShadingKind::Markise) => 2.0,
        _ => 0.0,
    });
    b.push(match dt.map(|t| t.kind) {
        Some(DoorTypeKind::Schiebe) => 1.0,
        Some(DoorTypeKind::Hebeschiebe) => 2.0,
        Some(DoorTypeKind::Pendel) => 3.0,
        _ => 0.0,
    });
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
    // [105] Anhang: Rahmenbreite rechts (Fenster).
    if let Some(f) = det.as_ref().filter(|f| wt.is_some() && (f.sides.right - f.sides.left).abs() > 1e-9) {
        b.push(f.sides.right);
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
            if f[i + 1] == 2.0 {
                // Anschlag: Wandnase, je Wandschicht (aussen → innen) in deren Schnitt-Darstellung.
                i += 5 + 2 * count;
                if pts.len() != 4 {
                    continue;
                }
                let wtype = wall_type(p, w)?;
                let category = c.cat(&w.category_code);
                let angle = atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180.0 / std::f64::consts::PI;
                let (_, n) = crate::opening_geom::WallRef { start: crate::opening_geom::v(w.start.x, w.start.y), end: crate::opening_geom::v(w.end.x, w.end.y), total, ref_off }.frame();
                let off = |q: &Vec2| (q.x - w.start.x) * n.x + (q.y - w.start.y) * n.y;
                let (lo, hi) = (off(&pts[0]), off(&pts[2]));
                let a = v2(pts[0].x - n.x * lo, pts[0].y - n.y * lo);
                let bq = v2(pts[1].x - n.x * lo, pts[1].y - n.y * lo);
                let at = |q: Vec2, d: f64| v2(q.x + n.x * d, q.y + n.y * d);
                let mut l0 = ref_off - total / 2.0;
                for (li, layer) in wtype.layers.iter().enumerate() {
                    let l1 = l0 + layer.thickness;
                    let (s0, s1) = (lo.max(l0), hi.min(l1));
                    l0 = l1;
                    if s1 - s0 <= 1e-6 {
                        continue;
                    }
                    let (hatch, fill) = layer_style(p, w, wtype, li, category, angle)?;
                    out.push(wall_polygon(vec![at(a, s0), at(bq, s0), at(bq, s1), at(a, s1)], &fill, wall_line.0, wall_line.1, hatch, greyed, None, Some(&w.id), id));
                }
                continue;
            }
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
                color: None,
                opening_id: Some(o.id.clone()),
                stair_id: None,
                greyed: Some(greyed),
                opacity: None,
            });
            i += 9;
        }
    }
    let ctx = DetailCtx { stroke: frame_color, weight: frame_weight, greyed, detail, wall_line };
    opening_detail_plan(c, out, w, o, &ctx, rebate_sides, (ext_l, ext_r), dframe.as_ref())
}

/// Stil der Detail-Zeichnung einer Öffnung.
struct DetailCtx<'a> {
    stroke: &'a str,
    weight: f64,
    greyed: bool,
    detail: Detail,
    wall_line: (&'a str, f64),
}

/// Grundriss-Detail einer Öffnung ([105]): Anschlag je Seite (Wandnase in der Schicht-Schraffur),
/// Verbreiterungsprofile neben dem Fensterrahmen und die Türzarge nach Art (Profil je Leibung,
/// Stahl im feinen Detail gefüllt).
#[allow(clippy::too_many_arguments)]
fn opening_detail_plan(c: &Ctx, out: &mut Vec<Primitive>, w: &Wall, o: &Opening, s: &DetailCtx, rebate: Option<crate::opening_detail::Sides>, ext: (f64, f64), dframe: Option<&crate::opening_detail::DoorFrame>) -> Result<(), String> {
    use crate::opening_detail as od;
    let p = c.p;
    if rebate.is_none() && ext.0 + ext.1 <= 1e-6 && dframe.is_none() {
        return Ok(());
    }
    let wtype = wall_type(p, w)?;
    let total = thickness(&wtype.layers);
    let ref_off = joins::reference_offset(crate::model3d::wall_reference(w), total);
    let wr = crate::opening_geom::WallRef { start: crate::opening_geom::v(w.start.x, w.start.y), end: crate::opening_geom::v(w.end.x, w.end.y), total, ref_off };
    let Some((js, je)) = crate::opening_geom::opening_jambs(&wr, o.position, o.width) else { return Ok(()) };
    let (u, n) = wr.frame();
    let face = ref_off - total / 2.0;
    let width = ((je.x - js.x).powi(2) + (je.y - js.y).powi(2)).sqrt();
    // Punkt: Leibung (0 links, 1 rechts), x in die Öffnung, o quer ab Aussenfläche.
    let pt = |side: usize, x: f64, off: f64| {
        let (base, dir) = if side == 0 { (js, 1.0) } else { (je, -1.0) };
        v2(base.x + u.x * x * dir + n.x * (face + off), base.y + u.y * x * dir + n.y * (face + off))
    };
    let id = Some(o.id.as_str());
    let frame = od::frame_of(p, o);
    // Anschlag je Seite.
    if let (Some(r), Some(f)) = (rebate, frame.as_ref()) {
        if let Some((z0, z1)) = f.rebate_zone(total) {
            let category = c.cat(&w.category_code);
            let angle = atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180.0 / std::f64::consts::PI;
            for (side, rd) in [(0usize, r.left), (1, r.right)] {
                let rd = rd.min(width / 2.0 - 0.01);
                if !(rd > 1e-4) {
                    continue;
                }
                let mut l0 = 0.0;
                for (li, layer) in wtype.layers.iter().enumerate() {
                    let l1 = l0 + layer.thickness;
                    let (a, b) = (z0.max(l0), z1.min(l1));
                    l0 = l1;
                    if b - a <= 1e-6 {
                        continue;
                    }
                    let (hatch, fill) = layer_style(p, w, wtype, li, category, angle)?;
                    out.push(wall_polygon(vec![pt(side, 0.0, a), pt(side, rd, a), pt(side, rd, b), pt(side, 0.0, b)], &fill, s.wall_line.0, s.wall_line.1, hatch, s.greyed, None, Some(&w.id), id));
                }
            }
        }
    }
    // Verbreiterungsprofile (Fenster) in der Rahmenlage.
    if let Some(f) = frame.as_ref().filter(|_| ext.0 + ext.1 > 1e-6 && s.detail != Detail::Grob) {
        let (lo, hi) = f.range(total);
        for (side, e) in [(0usize, ext.0), (1, ext.1)] {
            if e > 1e-6 {
                let pts = vec![pt(side, 0.0, lo), pt(side, e, lo), pt(side, e, hi), pt(side, 0.0, hi)];
                out.push(wall_polygon(pts, "none", s.stroke, s.weight, no_hatch(), s.greyed, None, None, id));
            }
        }
    }
    // Türzarge.
    if let Some(df) = dframe {
        let innen = od::aufschlag_innen(o);
        let off_of = |d: f64| if innen { total - d } else { d };
        let fein = s.detail == Detail::Fein;
        for (part, poly) in od::door_frame_profile(df, total, innen) {
            if s.detail == Detail::Grob && part == od::FramePart::Casing {
                continue;
            }
            let fill = if fein && df.steel { s.stroke } else { "none" };
            for side in [0usize, 1] {
                let pts: Vec<Vec2> = poly.iter().map(|q| pt(side, q[0], off_of(q[1]))).collect();
                out.push(wall_polygon(pts, fill, s.stroke, s.weight, no_hatch(), s.greyed, None, None, id));
            }
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
        // Bogenwand ([T2]): die gerade Pipeline rechnet auf der abgewickelten Ersatzwand `wv`, die
        // Ausgabe wird gebogen (`bend_prims`).
        let arc_wall = crate::wall_arc::unrolled_wall(w);
        let wv: &Wall = arc_wall.as_ref().map_or(w, |a| &a.1);
        let ev = EffWall { w: wv, color: e.color.clone(), stroke_weight: e.stroke_weight };
        let greyed = c.greyed(&w.category_code);
        let category = c.cat(&w.category_code);
        let lw = resolve_stroke_weight(e.stroke_weight, w.stroke_weight_source, category, category.map_or(WALL_FALLBACK_MM, |k| k.lw));
        let openings: Vec<&Opening> = p.openings_of_wall(&w.id).collect();
        let wr_total = p.wall_thickness(w, 0.2);
        let wr = crate::opening_geom::WallRef {
            start: crate::opening_geom::v(wv.start.x, wv.start.y),
            end: crate::opening_geom::v(wv.end.x, wv.end.y),
            total: wr_total,
            ref_off: joins::reference_offset(crate::model3d::wall_reference(w), wr_total),
        };
        let mut gaps: Vec<(f64, f64)> = openings.iter().filter_map(|o| crate::opening_geom::opening_interval(&wr, o.position, o.width)).collect();
        gaps.sort_by(|a, b| (a.0 - b.0).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
        let empty = WallCuts::default();
        let cut = cut_by_id.get(w.id.as_str()).copied().unwrap_or(&empty);
        let (zb, zt) = p.wall_vertical_extent(w);
        let view_only = zt < cut_z || zb > cut_z;
        let reveals = crate::opening_detail::plan_reveal_block(p, wv, &openings);
        let (unroll, cut_u) = match &arc_wall {
            Some((arc, _)) => {
                let total = p.wall_thickness(w, 0.2);
                let ro = joins::reference_offset(crate::model3d::wall_reference(w), total);
                let mut u = Unroll::new(*arc);
                let cu = unroll_cuts(&mut u, cut, ro - total / 2.0, ro + total / 2.0);
                (Some(u), cu)
            }
            None => (None, WallCuts::default()),
        };
        match &unroll {
            Some(u) => {
                let mut tmp = Vec::new();
                wall_poche(c, &mut tmp, &ev, &gaps, &cut_u, greyed, lw, category, view_only, &reveals, Some(u))?;
                if reference_lines {
                    tmp.push(mk_line(wv.start, wv.end, "wall-axis", 0.13, Some(Some(vec![0.18, 0.06, 0.04, 0.06])), None, greyed, None));
                }
                bend_prims(u, tmp, out);
            }
            None => {
                wall_poche(c, out, e, &gaps, cut, greyed, lw, category, view_only, &reveals, None)?;
                if reference_lines {
                    out.push(mk_line(w.start, w.end, "wall-axis", 0.13, Some(Some(vec![0.18, 0.06, 0.04, 0.06])), None, greyed, None));
                }
            }
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
            let wall_line = (e.color.as_deref().unwrap_or(POCHE_STROKE), lw * c.a.detail.outline_factor());
            match &unroll {
                Some(u) => {
                    let mut tmp = Vec::new();
                    opening_symbol(c, &mut tmp, wv, o, color, c.greyed(&o.category_code), detail, olw, wall_line)?;
                    bend_prims(u, tmp, out);
                }
                None => opening_symbol(c, out, w, o, color, c.greyed(&o.category_code), detail, olw, wall_line)?,
            }
        }
    }
    Ok(())
}

/// Schnittlinien einer Bogenwand in den abgewickelten Rahmen ([T2]); Aussparungen sind schon in
/// Bogenlänge. Nicht abwickelbare Linien fallen weg (Ende bleibt radial).
fn unroll_cuts(u: &mut Unroll, c: &WallCuts, lo: f64, hi: f64) -> WallCuts {
    let len = u.arc.length();
    let mut one = |l: &Option<joins::Line>, s: f64| l.as_ref().and_then(|l| u.unroll_line(l, lo, hi, s));
    let start_cut = one(&c.start_cut, 0.0);
    let end_cut = one(&c.end_cut, len);
    let layer_cuts = c.layer_cuts.as_ref().map(|lc| joins::LayerCuts {
        start: lc.start.iter().map(|l| one(l, 0.0)).collect(),
        end: lc.end.iter().map(|l| one(l, len)).collect(),
        start_side: lc.start_side.iter().map(|l| one(l, 0.0)).collect(),
        end_side: lc.end_side.iter().map(|l| one(l, len)).collect(),
    });
    WallCuts { start_cut, end_cut, layer_cuts, span_cutouts: c.span_cutouts.clone() }
}

/// Konvexes Viereck (abgewickelt) an den Zerlegungsstellen in Stücke teilen: (Stück, mittleres s).
fn split_band(u: &Unroll, pts: &[Vec2]) -> Vec<(Vec<Vec2>, f64)> {
    let (x0, x1) = pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), q| (a.min(q.x), b.max(q.x)));
    if !(x1 > x0) {
        return vec![];
    }
    let (n0, n1) = pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), q| (a.min(q.y), b.max(q.y)));
    let st = u.arc.stations(x0, x1, u.arc.r_max(n0, n1));
    let mut out = Vec::new();
    for k in 0..st.len() - 1 {
        let piece = clip_slab(pts, st[k], st[k + 1]);
        if piece.len() >= 3 {
            out.push((piece, (st[k] + st[k + 1]) / 2.0));
        }
    }
    out
}

/// Polygon auf den Streifen a ≤ x ≤ b beschneiden (Sutherland–Hodgman).
fn clip_slab(pts: &[Vec2], a: f64, b: f64) -> Vec<Vec2> {
    let clip = |poly: Vec<Vec2>, keep: &dyn Fn(Vec2) -> bool, x: f64| -> Vec<Vec2> {
        let n = poly.len();
        let mut o = Vec::with_capacity(n + 2);
        for i in 0..n {
            let (p, q) = (poly[i], poly[(i + 1) % n]);
            let (kp, kq) = (keep(p), keep(q));
            if kp {
                o.push(p);
            }
            if kp != kq && (q.x - p.x).abs() > 1e-15 {
                let t = (x - p.x) / (q.x - p.x);
                o.push(v2(x, p.y + (q.y - p.y) * t));
            }
        }
        o
    };
    let p1 = clip(pts.to_vec(), &|q: Vec2| q.x >= a - 1e-12, a);
    let mut p2 = clip(p1, &|q: Vec2| q.x <= b + 1e-12, b);
    p2.dedup_by(|p, q| (p.x - q.x).abs() < 1e-12 && (p.y - q.y).abs() < 1e-12);
    p2
}

fn kv(p: Vec2) -> kernel2d::Vec2 {
    kernel2d::Vec2::new(p.x, p.y)
}

fn mv(p: kernel2d::Vec2) -> Vec2 {
    v2(p.x, p.y)
}

fn bmap(u: &Unroll, p: Vec2) -> Vec2 {
    mv(u.map(kv(p)))
}

fn bend_poly(u: &Unroll, pts: &[Vec2], ns: &[f64]) -> (Vec<Vec2>, Vec<f64>) {
    let k: Vec<kernel2d::Vec2> = pts.iter().map(|q| kv(*q)).collect();
    let (o, n) = u.polygon(&k, ns);
    (o.into_iter().map(mv).collect(), n)
}

/// Grundriss-Primitive der abgewickelten Ersatzwand biegen ([T2]): Flächen über die Bogenkanten
/// zerlegt, Linien mit konstantem Querversatz als Bögen (≤ 90° je Stück, Gegenuhrzeigersinn, wie
/// es Bildschirm, SVG und DXF erwarten), übrige Linien gerade.
fn bend_prims(u: &Unroll, prims: Vec<Primitive>, out: &mut Vec<Primitive>) {
    for mut p in prims {
        match &mut p {
            Primitive::Polygon { pts, no_stroke_edges, .. } => {
                let (bp, ns) = bend_poly(u, pts, no_stroke_edges.as_deref().unwrap_or(&[]));
                *pts = bp;
                if no_stroke_edges.is_some() {
                    *no_stroke_edges = Some(ns);
                }
            }
            Primitive::Line { a, b, cls, weight_mm, dash, color, opening_id, greyed, opacity, .. } => {
                if u.is_arc_edge(kv(*a), kv(*b)) {
                    let c = mv(u.arc.center);
                    let r = u.arc.radius_at(a.y);
                    let (pa, pb) = (bmap(u, *a), bmap(u, *b));
                    let (fa, fb) = crate::wall_arc::arc_angles(kv(c), kv(pa), kv(pb));
                    let est = u.arc.sigma() * (b.x - a.x) / u.arc.r;
                    let mut d = (fb - fa) - est;
                    d = d - (d / (2.0 * std::f64::consts::PI)).round() * 2.0 * std::f64::consts::PI;
                    let sweep = est + d;
                    let k = ((sweep.abs() / (std::f64::consts::PI / 2.0)).ceil() as usize).max(1);
                    for i in 0..k {
                        let t0 = fa + sweep * i as f64 / k as f64;
                        let t1 = fa + sweep * (i + 1) as f64 / k as f64;
                        let (lo, hi) = if t1 >= t0 { (t0, t1) } else { (t1, t0) };
                        let at = |t: f64| v2(c.x + r * t.cos(), c.y + r * t.sin());
                        // Exakte Endpunkte (eingerastet) an den Enden.
                        let q0 = if (lo - fa).abs() < 1e-12 { pa } else if (lo - (fa + sweep)).abs() < 1e-12 { pb } else { at(lo) };
                        let q1 = if (hi - fa).abs() < 1e-12 { pa } else if (hi - (fa + sweep)).abs() < 1e-12 { pb } else { at(hi) };
                        out.push(Primitive::Arc {
                            center: c,
                            from: q0,
                            to: q1,
                            r,
                            cls: cls.clone(),
                            weight_mm: *weight_mm,
                            dash: dash.clone(),
                            color: color.clone(),
                            opening_id: opening_id.clone(),
                            stair_id: None,
                            greyed: *greyed,
                            opacity: *opacity,
                        });
                    }
                    continue;
                }
                *a = bmap(u, *a);
                *b = bmap(u, *b);
            }
            Primitive::Arc { center, from, to, .. } => {
                *center = bmap(u, *center);
                *from = bmap(u, *from);
                *to = bmap(u, *to);
            }
            _ => {}
        }
        out.push(p);
    }
}

/// Wand-Ecken (`wallCorners` mit Typ-Dicke) ins Ausmass.
fn bounds_wall(p: &Project, w: &Wall, bounds: &mut super::domains::Bounds) {
    let Some(wt) = p.wall_type(w) else { return };
    let h = thickness(&wt.layers) / 2.0;
    if let Some(a) = crate::wall_arc::WallArc::of_wall(w) {
        for s in a.stations(0.0, a.length(), a.r + h) {
            for off in [h, -h] {
                let q = a.point(s, off);
                bounds.acc(q.x, q.y);
            }
        }
        return;
    }
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = crate::jsmath::hypot2(dx, dy);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let (ux, uy) = (dx / l, dy / l);
    let (nx, ny) = (-uy, ux);
    for (q, off) in [(w.start, h), (w.end, h), (w.end, -h), (w.start, -h)] {
        bounds.acc(q.x + nx * off, q.y + ny * off);
    }
}
