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

/// Eingabe von `plan::wall_poche::wall_poche` (wie `encodeWallPoche` in TS).
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
    let f = crate::plan::wall_poche::wall_poche(&encode_wall_poche(w, &thick, total, ref_off, gaps, cuts, detail == Detail::Grob, view_only, reveals));
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
                // [T2] Bogenwand: polare Schraffur — das Muster folgt der Krümmung stetig (Abwicklung
                // im Uhrzeigersinn: Laufrichtung 0° bzw. 180° im Gegenuhrzeigersinn; gebogen wird das
                // Band danach in `bend_prims`).
                let local = if u.arc.sigma() > 0.0 { 180.0 } else { 0.0 };
                let (mut hatch, fill) = layer_style(p, w, wt, li, category, local)?;
                hatch.polar = Some([u.arc.center.x, u.arc.center.y, u.arc.r]);
                out.push(wall_polygon(pts, &fill, "none", 0.0, hatch, greyed, Some(no_stroke), Some(&w.id), None));
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
                    wt.layers.get(li).and_then(|l| l.joint_weight_mm).filter(|w| w.is_finite() && *w > 0.0).map_or(layer_mm, |w| w * detail.layer_factor()),
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
    let mut sash_list = wt.map(sashes).unwrap_or_default();
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
    // [105] Pfostenbreite: Pfosten ohne eigene Breite und (bei Flügeln aus der Flügelzahl) Pfosten
    // zwischen den Flügeln wie im 3D.
    let mullion = det.as_ref().map_or(f64::NAN, |f| f.mullion_width);
    if mullion.is_finite() && mullion > 1e-4 {
        let from_count = wt.is_some_and(|t| t.sashes.as_ref().is_none_or(|s| s.is_empty()));
        let mut list = Vec::with_capacity(sash_list.len() * 2);
        for (i, mut s) in sash_list.into_iter().enumerate() {
            if s.kind == SashDefKind::Pfosten && s.post_width.is_none() {
                s.post_width = Some(mullion);
            }
            if from_count && i > 0 {
                list.push(SashDef { kind: SashDefKind::Pfosten, post_width: Some(mullion), ..Default::default() });
            }
            list.push(s);
        }
        sash_list = list;
    }
    // [105] Türblatt im Falz der Zarge: Drehpunkt an der Falzkante, auf der Aufschlagfläche des Blatts.
    let hinge = dframe.as_ref().filter(|_| dt.is_some_and(|t| matches!(t.kind, DoorTypeKind::Dreh | DoorTypeKind::Pendel | DoorTypeKind::Unknown))).map(|df| {
        use crate::opening_detail as od;
        let innen = od::aufschlag_innen(o);
        let clear = od::profile_clear_x(&od::door_frame_profile(df, total, innen));
        let (d0, _) = od::leaf_band(df, total, innen);
        let off = ref_off - total / 2.0 + if innen { total - d0 } else { d0 };
        ((clear - df.falz_width).max(0.0), off)
    });
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
        Some(DoorTypeKind::Tasche) => 4.0,
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
    // [105] Anhang: Rahmenbreite rechts (Fenster), Drehpunkt des Türblatts im Falz (Einzug, Versatz).
    b.push(det.as_ref().filter(|f| wt.is_some() && (f.sides.right - f.sides.left).abs() > 1e-9).map_or(f64::NAN, |f| f.sides.right));
    b.extend(hinge.map_or([f64::NAN; 2], |(x, off)| [x, off]));
    let f = crate::plan::openings::plan_opening(&b);
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
    let range = super::view_range::ViewRange::of(p, &c.a.floor);
    // Bei doppelten Wand-ids gewinnt in TS (Map) die letzte Verschneidung.
    let mut cut_by_id: HashMap<&str, &WallCuts> = HashMap::new();
    for (e, k) in walls.iter().zip(&cuts) {
        cut_by_id.insert(e.w.id.as_str(), k);
    }
    for e in &walls {
        let w = e.w;
        bounds_wall(p, w, bounds);
        // Ansichtsbereich ([36]): ausserhalb entfällt die Wand samt Öffnungen, über/unter dem Schnitt
        // wird sie gestrichelt/gepunktet gezeichnet.
        let (wzb, wzt) = p.wall_vertical_extent(w);
        let zone = range.classify(wzb, wzt);
        if zone == super::view_range::Zone::Hidden {
            continue;
        }
        let out_start = out.len();
        // Bogenwand ([T2]): die gerade Pipeline rechnet auf der abgewickelten Ersatzwand `wv`, die
        // Ausgabe wird gebogen (`bend_prims`).
        let arc_wall = crate::wall_arc::unrolled_wall(w);
        let wv: &Wall = arc_wall.as_ref().map_or(w, |a| &a.1);
        let ev = EffWall { w: wv, color: e.color.clone(), stroke_weight: e.stroke_weight };
        let greyed = c.greyed(&w.category_code);
        let category = c.cat(&w.category_code);
        let lw = resolve_stroke_weight(e.stroke_weight, w.stroke_weight_source, category, category.map_or(WALL_FALLBACK_MM, |k| k.lw));
        // Öffnungen mit eigener Zone ([36], nur mit eigenem Bereich): ausserhalb entfällt die Öffnung,
        // ganz über der Schnittebene einer geschnittenen Wand (Oberlicht) schliesst die Wand im Schnitt
        // und das Symbol wird „über Schnitt“ gezeichnet.
        use super::view_range::Zone;
        let all_openings: Vec<(&Opening, Zone)> = p.openings_of_wall(&w.id).map(|o| {
            let (ob, ot) = super::view_range::opening_vertical_extent(p, w, o);
            (o, if range.custom { range.classify(ob, ot) } else { Zone::Cut })
        }).collect();
        let overhead_opening = |oz: Zone| zone == Zone::Cut && oz == Zone::Above;
        let openings: Vec<&Opening> = all_openings.iter().filter(|(_, oz)| *oz != Zone::Hidden && !overhead_opening(*oz)).map(|(o, _)| *o).collect();
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
        let reveals = crate::opening_detail::plan_reveal_block(p, w, &openings);
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
        // [95] Taschen der Taschen-Schiebetüren (Hohlraum in der Wand, aus der Schraffur ausgespart).
        let pockets = if view_only { WallPockets { o: wv.start, u: v2(1.0, 0.0), n: v2(0.0, 1.0), cuts: vec![] } } else { wall_pockets(p, wv, &openings) };
        match &unroll {
            Some(u) => {
                let mut tmp = Vec::new();
                wall_poche(c, &mut tmp, &ev, &gaps, &cut_u, greyed, lw, category, view_only, &reveals, Some(u))?;
                cut_pockets(&mut tmp, 0, &pockets);
                if reference_lines {
                    tmp.push(mk_line(wv.start, wv.end, "wall-axis", 0.13, Some(Some(vec![0.18, 0.06, 0.04, 0.06])), None, greyed, None));
                }
                bend_prims(u, tmp, out);
            }
            None => {
                let at = out.len();
                wall_poche(c, out, e, &gaps, cut, greyed, lw, category, view_only, &reveals, None)?;
                cut_pockets(out, at, &pockets);
                if reference_lines {
                    out.push(mk_line(w.start, w.end, "wall-axis", 0.13, Some(Some(vec![0.18, 0.06, 0.04, 0.06])), None, greyed, None));
                }
            }
        }
        for &(o, oz) in &all_openings {
            if !c.shown(&o.category_code) || oz == Zone::Hidden {
                continue;
            }
            let sym_start = out.len();
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
            if overhead_opening(oz) {
                super::view_range::restyle(out, sym_start, &super::view_range::ABOVE_DASH);
            }
        }
        if let Some(d) = range.restyle_dash(zone) {
            super::view_range::restyle(out, out_start, d);
        }
    }
    Ok(())
}

/// [95] Taschen der Taschen-Schiebetüren einer Wand: Wandrahmen (Start, Achse, Normale) und je Tasche
/// die Aussparung `(u0, u1, n0, n1)` (Hohlraum + Blattbahn durch die Öffnung).
pub(crate) struct WallPockets {
    o: Vec2,
    u: Vec2,
    n: Vec2,
    cuts: Vec<(f64, f64, f64, f64)>,
}

pub(crate) fn wall_pockets(p: &Project, w: &Wall, openings: &[&Opening]) -> WallPockets {
    use crate::opening_geom as og;
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = crate::jsmath::hypot2(dx, dy);
    let u = if l > 1e-12 { v2(dx / l, dy / l) } else { v2(1.0, 0.0) };
    let mut r = WallPockets { o: w.start, u, n: v2(-u.y, u.x), cuts: vec![] };
    let pocket: Vec<&&Opening> = openings.iter().filter(|o| o.kind == ElementKind::Door && door_type(p, o).is_some_and(|t| t.kind == DoorTypeKind::Tasche)).collect();
    if pocket.is_empty() || l <= 1e-9 {
        return r;
    }
    let Ok(wt) = wall_type(p, w) else { return r };
    let total = thickness(&wt.layers);
    let wr = og::WallRef { start: og::v(w.start.x, w.start.y), end: og::v(w.end.x, w.end.y), total, ref_off: joins::reference_offset(crate::model3d::wall_reference(w), total) };
    for o in pocket {
        let count = crate::jsnum::max(1.0, round(door_type(p, o).map_or(1.0, |t| t.leaf_count)));
        let hinge_end = o.hinge.is_some_and(|s| s != OpeningHinge::Start);
        r.cuts.extend(og::pocket_cavities(&wr, o.position, o.width, hinge_end, count).iter().map(|k| k.cut()));
    }
    r
}

/// [95] Taschen aus Schraffur/Füllung und Fugenlinien der Wand-Primitive ab `from` aussparen (die
/// Schichten sind dort nicht massiv); den Umriss der Tasche zeichnet das Türsymbol.
fn cut_pockets(prims: &mut Vec<Primitive>, from: usize, wp: &WallPockets) {
    if wp.cuts.is_empty() {
        return;
    }
    let local = |q: Vec2| {
        let d = v2(q.x - wp.o.x, q.y - wp.o.y);
        (d.x * wp.u.x + d.y * wp.u.y, d.x * wp.n.x + d.y * wp.n.y)
    };
    let world = |u: f64, n: f64| v2(wp.o.x + wp.u.x * u + wp.n.x * n, wp.o.y + wp.u.y * u + wp.n.y * n);
    let rect = |&(u0, u1, n0, n1): &(f64, f64, f64, f64)| -> crate::flat::Polygon {
        vec![[(u0, n0), (u1, n0), (u1, n1), (u0, n1)].iter().map(|&(u, n)| { let q = world(u, n); [q.x, q.y] }).collect()]
    };
    let rects: Vec<crate::flat::Polygon> = wp.cuts.iter().map(rect).collect();
    // Teilstücke (Parameter 0..1) einer Strecke ausserhalb aller Taschen (Liang-Barsky im Wandrahmen).
    let keep_of = |a: Vec2, b: Vec2| -> Vec<(f64, f64)> {
        let (la, lb) = (local(a), local(b));
        let (du, dn) = (lb.0 - la.0, lb.1 - la.1);
        let mut keep = vec![(0.0_f64, 1.0_f64)];
        for &(u0, u1, n0, n1) in &wp.cuts {
            let e = 1e-7;
            let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
            for (pp, q) in [(-du, la.0 - (u0 + e)), (du, (u1 - e) - la.0), (-dn, la.1 - (n0 + e)), (dn, (n1 - e) - la.1)] {
                if pp.abs() < 1e-15 {
                    if q < 0.0 {
                        t0 = 1.0;
                        t1 = 0.0;
                    }
                } else if pp < 0.0 {
                    t0 = t0.max(q / pp);
                } else {
                    t1 = t1.min(q / pp);
                }
            }
            if t1 - t0 <= 1e-9 {
                continue;
            }
            keep = keep
                .into_iter()
                .flat_map(|(s, f)| {
                    let mut r = vec![];
                    if t0 > s + 1e-9 {
                        r.push((s, t0.min(f)));
                    }
                    if t1 < f - 1e-9 {
                        r.push((t1.max(s), f));
                    }
                    r.into_iter().filter(|(x, y)| y - x > 1e-9)
                })
                .collect();
        }
        keep
    };
    let lerp = |a: Vec2, b: Vec2, t: f64| v2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    // Umriss einer gestrichenen Fläche als Linien, ohne die Stücke in der Tasche (`None`: nichts betroffen).
    let outline = |prim: &Primitive| -> Option<Vec<Primitive>> {
        let Primitive::Polygon { pts, stroke, stroke_width_mm, no_stroke_edges, greyed, .. } = prim else { return None };
        let n = pts.len();
        let skip = |i: usize| no_stroke_edges.as_ref().is_some_and(|v| v.iter().any(|k| *k as usize == i));
        let mut out = Vec::new();
        let mut cut = false;
        for i in (0..n).filter(|&i| !skip(i)) {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            let keep = keep_of(a, b);
            cut |= !(keep.len() == 1 && keep[0] == (0.0, 1.0));
            for (s, f) in keep {
                out.push(mk_line(lerp(a, b, s), lerp(a, b, f), "wall-outline", *stroke_width_mm, None, Some(stroke), greyed.unwrap_or(false), None));
            }
        }
        cut.then_some(out)
    };
    let tail = prims.split_off(from);
    for prim in tail {
        match &prim {
            Primitive::Polygon { pts, fill, stroke, .. } if fill != "none" && pts.len() >= 3 => {
                // Nur Flächen, die eine Tasche echt überlappen (Hüllquader im Wandrahmen).
                let lp: Vec<(f64, f64)> = pts.iter().map(|q| local(*q)).collect();
                let (pu0, pu1) = lp.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, q| (a.0.min(q.0), a.1.max(q.0)));
                let (pn0, pn1) = lp.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, q| (a.0.min(q.1), a.1.max(q.1)));
                let eps = 1e-6;
                let hit: Vec<usize> = (0..wp.cuts.len())
                    .filter(|&i| {
                        let (u0, u1, n0, n1) = wp.cuts[i];
                        pu0 < u1 - eps && pu1 > u0 + eps && pn0 < n1 - eps && pn1 > n0 + eps
                    })
                    .collect();
                if hit.is_empty() {
                    prims.push(prim);
                    continue;
                }
                let subj: crate::flat::Polygon = vec![pts.iter().map(|q| [q.x, q.y]).collect()];
                let clip: Vec<crate::flat::Polygon> = hit.iter().map(|&i| rects[i].clone()).collect();
                let mut parts = crate::polygon_bool::difference(std::slice::from_ref(&subj), &clip);
                if parts.iter().any(|q| q.len() > 1) {
                    // Tasche ganz innerhalb der Fläche: Fläche an der Taschenmitte teilen, damit kein Loch entsteht.
                    let (u0, u1, _, _) = wp.cuts[hit[0]];
                    let um = (u0 + u1) / 2.0;
                    let big = 1e3 + (pu1 - pu0).abs() + (pn1 - pn0).abs();
                    let halves = [rect(&(pu0 - big, um, pn0 - big, pn1 + big)), rect(&(um, pu1 + big, pn0 - big, pn1 + big))];
                    parts = halves.iter().flat_map(|h| crate::polygon_bool::intersection(std::slice::from_ref(&subj), std::slice::from_ref(h))).flat_map(|h| crate::polygon_bool::difference(&[h], &clip)).collect();
                }
                // Füllung ausgespart (ohne Strich), der Umriss danach als Linien ohne die Taschenmündung.
                let stroked = stroke != "none";
                for part in parts {
                    let Some(ring) = part.first() else { continue };
                    let mut o = prim.clone();
                    if let Primitive::Polygon { pts, no_stroke_edges, stroke, stroke_width_mm, .. } = &mut o {
                        *pts = ring.iter().map(|q| v2(q[0], q[1])).collect();
                        *no_stroke_edges = None;
                        if stroked {
                            *stroke = "none".into();
                            *stroke_width_mm = 0.0;
                        }
                    }
                    prims.push(o);
                }
                if stroked {
                    match outline(&prim) {
                        Some(lines) => prims.extend(lines),
                        None => {
                            let mut o = prim.clone();
                            if let Primitive::Polygon { fill, hatch, .. } = &mut o {
                                *fill = "none".into();
                                *hatch = no_hatch();
                            }
                            prims.push(o);
                        }
                    }
                }
            }
            Primitive::Polygon { stroke, .. } if stroke != "none" => match outline(&prim) {
                Some(lines) => prims.extend(lines),
                None => prims.push(prim),
            },
            Primitive::Line { a, b, cls, .. } if cls.starts_with("layer-joint") || cls == "wall-outline" => {
                let keep = keep_of(*a, *b);
                if keep.len() == 1 && keep[0] == (0.0, 1.0) {
                    prims.push(prim);
                    continue;
                }
                for (s, f) in keep {
                    let mut o = prim.clone();
                    if let Primitive::Line { a, b, .. } = &mut o {
                        let (pa, pb) = (lerp(*a, *b, s), lerp(*a, *b, f));
                        *a = pa;
                        *b = pb;
                    }
                    prims.push(o);
                }
            }
            _ => prims.push(prim),
        }
    }
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Projekt: dreischichtige Wand (Putz 2 · Backstein 12 · Putz 2 cm) entlang +x mit einer Tür
    /// (1.0..1.9) des Typs `kind`.
    pub(crate) fn pocket_project(kind: DoorTypeKind, hinge: Option<OpeningHinge>, leaves: f64) -> Project {
        let mut p = Project::default();
        for id in ["a", "b"] {
            p.components.push(Component { id: id.into(), ..Default::default() });
        }
        let l = |c: &str, t: f64| Layer { component_id: c.into(), thickness: t, ..Default::default() };
        p.wall_types.push(WallType { id: "iw".into(), layers: vec![l("a", 0.02), l("b", 0.12), l("a", 0.02)], ..Default::default() });
        p.drawing_levels.push(DrawingLevel { id: "eg".into(), kind: DrawingLevelKind::Floor, floor_height: Some(2.6), ..Default::default() });
        p.walls.push(Wall { id: "w".into(), floor_id: "eg".into(), wall_type_id: "iw".into(), category_code: "20".into(), start: Vec2 { x: 0.0, y: 0.0 }, end: Vec2 { x: 4.0, y: 0.0 }, height: 2.6, ..Default::default() });
        p.door_types = Some(vec![DoorType { id: "t".into(), kind, leaf_count: leaves, ..Default::default() }]);
        p.openings = Some(vec![Opening { id: "o".into(), host_wall_id: "w".into(), kind: ElementKind::Door, type_id: Some("t".into()), category_code: "20".into(), position: 1.0, width: 0.9, height: 2.0, hinge, ..Default::default() }]);
        p
    }

    /// Bogen von 90° (Bulge tan 22.5°) über dieselbe Sehne 0..4: Achsmass = Bogenlänge ([T2]).
    pub(crate) const POCKET_BULGE: f64 = 0.414_213_562_373_095_1;

    /// [95] Wie [`pocket_project`], Wand als Bogen (`bulge`) oder unter einem Satteldach mit First quer
    /// zur Wand (`roof`: Wand an Dach angeschlossen, schräge Oberkante, Tür bleibt darunter).
    pub(crate) fn pocket_project_with(kind: DoorTypeKind, hinge: Option<OpeningHinge>, leaves: f64, bulge: Option<f64>, roof: bool) -> Project {
        let mut p = pocket_project(kind, hinge, leaves);
        p.walls[0].bulge = bulge;
        if roof {
            p.walls[0].roof_attach = Some(true);
            let rect = serde_json::json!([{"x":-0.5,"y":-2},{"x":4.5,"y":-2},{"x":4.5,"y":2},{"x":-0.5,"y":2}]);
            p.roofs = Some(vec![serde_json::from_value(serde_json::json!({"id": "R", "type": "roof", "floorId": "eg", "categoryCode": "35",
                "outline": rect, "shape": "sattel", "pitchDeg": 30, "overhang": 0, "ridgeAxis": "y", "baseElevation": 2.4, "thickness": 0.2})).unwrap()]);
        }
        p
    }

    fn wall_prims(p: &Project) -> Vec<Primitive> {
        let t = serde_json::json!({ "floor": "eg", "show": ["20"], "grey": [] }).to_string();
        super::super::domains::plan_domains(p, &super::super::domains::PlanArgs::parse(1.0, &t).unwrap()).unwrap().walls
    }

    fn area(pts: &[Vec2]) -> f64 {
        let n = pts.len();
        (0..n).map(|i| pts[i].x * pts[(i + 1) % n].y - pts[(i + 1) % n].x * pts[i].y).sum::<f64>().abs() / 2.0
    }

    /// Gefüllte Wandflächen (ohne Öffnungs-Lücken): Fläche gesamt und die Ringe.
    fn hatched(prims: &[Primitive]) -> (f64, Vec<Vec<Vec2>>) {
        let polys: Vec<Vec<Vec2>> = prims
            .iter()
            .filter_map(|q| match q {
                Primitive::Polygon { pts, fill, wall_id: Some(_), opening_id: None, .. } if fill != "none" => Some(pts.clone()),
                _ => None,
            })
            .collect();
        (polys.iter().map(|q| area(q)).sum(), polys)
    }

    /// [95] Taschen-Schiebetür: die Tasche (Blattbreite + 5 cm × 7 cm) fehlt in der Schraffur, auf der
    /// Bandseite; die Fugen laufen nicht durch die Tasche.
    #[test]
    fn tasche_aus_der_schraffur_ausgespart() {
        let (full, _) = hatched(&wall_prims(&pocket_project(DoorTypeKind::Schiebe, None, 1.0)));
        assert!((full - 3.1 * 0.16).abs() < 1e-9, "{full}");
        let cavity = (0.9 + 0.05) * 0.07;
        for (hinge, side) in [(None, -1.0), (Some(OpeningHinge::End), 1.0)] {
            let prims = wall_prims(&pocket_project(DoorTypeKind::Tasche, hinge, 1.0));
            let (a, polys) = hatched(&prims);
            assert!((full - a - cavity).abs() < 1e-5, "{full} {a} {cavity}");
            let inside = |q: Vec2| {
                polys.iter().any(|pts| {
                    let n = pts.len();
                    let mut c = false;
                    for i in 0..n {
                        let (a, b) = (pts[i], pts[(i + 1) % n]);
                        if (a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x {
                            c = !c;
                        }
                    }
                    c
                })
            };
            let (pocket_x, other_x, jamb_x) = if side < 0.0 { (0.5, 2.5, 1.0) } else { (2.4, 0.5, 1.9) };
            // Die Leibung ist an der Taschenmündung offen: kein Strich durch (Leibung, Wandmitte).
            let through = |a: Vec2, b: Vec2| (a.x - jamb_x).abs() < 1e-6 && (b.x - jamb_x).abs() < 1e-6 && a.y.min(b.y) < 0.0 && a.y.max(b.y) > 0.0;
            for q in &prims {
                match q {
                    Primitive::Line { a, b, cls, .. } if cls == "wall-outline" || cls.starts_with("layer-joint") => assert!(!through(*a, *b), "{a:?} {b:?}"),
                    Primitive::Polygon { pts, stroke, no_stroke_edges, .. } if stroke != "none" => {
                        for i in 0..pts.len() {
                            let skip = no_stroke_edges.as_ref().is_some_and(|v| v.iter().any(|k| *k as usize == i));
                            assert!(skip || !through(pts[i], pts[(i + 1) % pts.len()]), "{pts:?}");
                        }
                    }
                    _ => {}
                }
            }
            assert!(!inside(v2(pocket_x, 0.001)), "Tasche ausgespart ({hinge:?})");
            assert!(inside(v2(other_x, 0.001)), "Gegenseite massiv ({hinge:?})");
            assert!(inside(v2(pocket_x, 0.05)) && inside(v2(pocket_x, -0.07)), "ausserhalb der Tasche massiv ({hinge:?})");
            // Keine Schichtfuge/Umrisslinie durch die Tasche.
            for q in &prims {
                if let Primitive::Line { a, b, cls, .. } = q {
                    if cls.starts_with("layer-joint") || cls == "wall-outline" {
                        let m = v2((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
                        assert!(!(m.y.abs() < 0.034 && (m.x - pocket_x).abs() < 0.4), "{a:?} {b:?}");
                    }
                }
            }
        }
        // Zweiflügelig: Taschen beidseitig (je halbe Breite + 5 cm).
        let (a, _) = hatched(&wall_prims(&pocket_project(DoorTypeKind::Tasche, None, 2.0)));
        assert!((full - a - 2.0 * (0.45 + 0.05) * 0.07).abs() < 1e-5, "{full} {a}");
    }

    /// [95][T2] Bogenwand: die Tasche folgt dem Bogen (Länge entlang der Achse); unter schräger
    /// Oberkante wie gerade.
    #[test]
    fn tasche_in_bogenwand_und_unter_dach_ausgespart() {
        let cavity = (0.9 + 0.05) * 0.07;
        for (bulge, roof) in [(Some(POCKET_BULGE), false), (None, true)] {
            for (hinge, leaves, k) in [(None, 1.0, cavity), (Some(OpeningHinge::End), 1.0, cavity), (None, 2.0, 2.0 * (0.45 + 0.05) * 0.07)] {
                let (full, _) = hatched(&wall_prims(&pocket_project_with(DoorTypeKind::Schiebe, hinge, leaves, bulge, roof)));
                let (a, _) = hatched(&wall_prims(&pocket_project_with(DoorTypeKind::Tasche, hinge, leaves, bulge, roof)));
                assert!((full - a - k).abs() < 2e-4, "{bulge:?} {roof} {hinge:?} {leaves}: {full} {a} {k}");
            }
        }
        // Bogen: die Wandmitte am Taschenpunkt (Achsmass 0.5) ist hohl, an der Gegenseite (3.5) massiv.
        let arc = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(0.0, 0.0), kernel2d::Vec2::new(4.0, 0.0), Some(POCKET_BULGE)).unwrap();
        let (_, polys) = hatched(&wall_prims(&pocket_project_with(DoorTypeKind::Tasche, None, 1.0, Some(POCKET_BULGE), false)));
        let inside = |q: kernel2d::Vec2| {
            let q = v2(q.x, q.y);
            polys.iter().any(|pts| {
                let n = pts.len();
                let mut c = false;
                for i in 0..n {
                    let (a, b) = (pts[i], pts[(i + 1) % n]);
                    if (a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x {
                        c = !c;
                    }
                }
                c
            })
        };
        assert!(!inside(arc.point(0.5, 0.001)));
        assert!(inside(arc.point(3.5, 0.001)));
        assert!(inside(arc.point(0.5, 0.05)) && inside(arc.point(0.5, -0.07)));
    }
}
