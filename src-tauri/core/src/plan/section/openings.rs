//! Geschnittene Fenster und Türen (früher `sectionOpenings.ts`): Rahmen, Flügel, Glas, Sturz und
//! Storenkasten im Querschnitt der Wand (`section_opening_primitives()`). Aufgerufen von der Abfrage
//! `section_plan_buf()` (`query.rs`).

use super::*;

const OPENING_INK: &str = "#1f242c";
const FRAME_MM: f64 = 0.25;
const GLASS_MM: f64 = crate::plan::style::GLASS_LINE_MM;
const DEFAULT_FRAME_DEPTH: f64 = 0.07;
const DEFAULT_FRAME_WIDTH: f64 = 0.06;
const DOOR_LEAF_THICKNESS: f64 = 0.04;
pub(super) const MIN_CROSS: f64 = 0.15;
pub(super) const LINTEL_FILL: &str = "#d4d7db";
pub(super) const SHADING_PACK_FILL: &str = "#e6e8eb";

fn rect(u0: f64, u1: f64, v0: f64, v1: f64) -> Vec<Vec2> {
    vec![v2(min(u0, u1), v0), v2(max(u0, u1), v0), v2(max(u0, u1), v1), v2(min(u0, u1), v1)]
}

fn opening_poly(pts: Vec<Vec2>, profile: bool, id: &str) -> Primitive {
    let mut pr = if profile { polygon(pts, "#ffffff", OPENING_INK, FRAME_MM, no_hatch_base()) } else { polygon(pts, "none", "none", 0.0, no_hatch_base()) };
    if let Primitive::Polygon { opening_id, .. } = &mut pr {
        *opening_id = Some(id.into());
    }
    pr
}

pub(super) struct CrossSection {
    n0: f64,
    un: f64,
    pub(super) z_bottom: f64,
    pub(super) z_top: f64,
    pub(super) face_min: f64,
    pub(super) face_max: f64,
    /// Formöffnung ([G3]): Umriss (Öffnungskoordinaten), Lage der Schnittstelle darin und Brüstungshöhe.
    pub(super) shape: Option<(Vec<crate::opening_shape::P>, f64, f64)>,
}

impl CrossSection {
    fn u_at(&self, s: f64) -> f64 {
        (s - self.n0) / self.un
    }
}

pub(super) fn axis_frame(w: &Wall) -> ((f64, f64), (f64, f64)) {
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = hypot2(dx, dy);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let u = (dx / l, dy / l);
    (u, (-u.1, u.0))
}

pub(super) fn cross_section(p: &Project, wall: &Wall, o: &Opening, p0: (f64, f64), u: (f64, f64)) -> Result<Option<CrossSection>, String> {
    let Some((from, to)) = opening_interval(wall, o) else { return Ok(None) };
    let (a, n) = axis_frame(wall);
    let un = u.0 * n.0 + u.1 * n.1;
    if un.abs() < MIN_CROSS {
        return Ok(None);
    }
    let rel = (p0.0 - wall.start.x, p0.1 - wall.start.y);
    let n0 = rel.0 * n.0 + rel.1 * n.1;
    let a0 = rel.0 * a.0 + rel.1 * a.1;
    let ua = u.0 * a.0 + u.1 * a.1;
    let total = sum_thickness(&p.wall_type_or_fallback(wall).layers);
    let ref_off = crate::joins::reference_offset(model3d::wall_reference(wall), total);
    let along = a0 + ((ref_off - n0) / un) * ua;
    if along < from + 1e-4 || along > to - 1e-4 {
        return Ok(None);
    }
    let (mut z_bottom, mut z_top) = opening_extent(p, wall, o);
    // Formöffnung ([G3]): lichte Höhe an der Schnittstelle aus dem Umriss.
    let mut shape = None;
    if let Some(poly) = crate::opening_shape::opening_outline(o, to - from, z_top - z_bottom) {
        let Some((lo, hi)) = crate::opening_shape::v_range(&poly, along - from) else { return Ok(None) };
        shape = Some((poly, along - from, z_bottom));
        (z_bottom, z_top) = (z_bottom + lo, z_bottom + hi);
    }
    if z_top - z_bottom < 1e-3 {
        return Ok(None);
    }
    Ok(Some(CrossSection { n0, un, z_bottom, z_top, face_min: ref_off - total / 2.0, face_max: ref_off + total / 2.0, shape }))
}

/// Sash-Liste eines Fenstertyps (`sashesOfWindowType`) für das Fenster-Symbol.
pub(crate) fn sashes_of_window_type(wt: &WindowType) -> Vec<crate::opening_geom::Sash> {
    if let Some(s) = wt.sashes.as_deref().filter(|s| !s.is_empty()) {
        return s
            .iter()
            .map(|s| crate::opening_geom::Sash {
                post: s.kind == SashDefKind::Pfosten,
                auto_width: s.auto_width != Some(false),
                width: s.width.unwrap_or(f64::NAN),
                post_width: s.post_width.unwrap_or(f64::NAN),
                operable: s.opening.is_some_and(|o| o != OpeningKind::Fest),
            })
            .collect();
    }
    let wc = if wt.wing_count == 0.0 || wt.wing_count.is_nan() { 1.0 } else { wt.wing_count };
    let n = max(1.0, round(wc)) as usize;
    let operable = wt.kind != OpeningKind::Fest;
    (0..n).map(|_| crate::opening_geom::Sash { post: false, auto_width: true, width: f64::NAN, post_width: f64::NAN, operable }).collect()
}

fn window_cut(p: &Project, wall: &Wall, o: &Opening, c: &CrossSection) -> Result<Vec<Primitive>, String> {
    let wt = p.window_type(o);
    let fw = max(0.02, wt.and_then(|t| t.frame_width).unwrap_or(DEFAULT_FRAME_WIDTH));
    let (_, n) = axis_frame(wall);
    let off_of = |q: crate::opening_geom::V| (q.x - wall.start.x) * n.0 + (q.y - wall.start.y) * n.1;
    let mut f_min = (c.face_min + c.face_max) / 2.0 - DEFAULT_FRAME_DEPTH / 2.0;
    let mut f_max = f_min + DEFAULT_FRAME_DEPTH;
    let mut glass: Vec<f64> = vec![(f_min + f_max) / 2.0];
    // `windowSymbol(project, wall, o, 1, spec, "mittel")`.
    let total = sum_thickness(&p.wall_type_or_fallback(wall).layers);
    let ref_off = crate::joins::reference_offset(model3d::wall_reference(wall), total);
    let spec = wt.map(|t| crate::opening_geom::WindowSpec {
        sashes: sashes_of_window_type(t),
        frame_width: t.frame_width.unwrap_or(DEFAULT_FRAME_WIDTH),
        frame_depth: t.frame_depth.unwrap_or(f64::NAN),
        inset_from_face: t.inset_from_face.or_else(|| crate::opening_detail::default_frame_inset(p, o)).unwrap_or(f64::NAN),
        inset_inner: t.inset_face == Some(WindowTypeInsetFace::Innen),
        inset_mid: t.inset_face == Some(WindowTypeInsetFace::Mitte),
        frame_width_end: f64::NAN,
    });
    // [105] Rahmen-Detail: Lage/Tiefe übersteuert, Breite oben/unten, Anschlussprofile.
    let det = crate::opening_detail::frame_of(p, o).filter(|f| f.detailed);
    let spec = spec.map(|s| match &det {
        Some(f) => crate::opening_geom::WindowSpec {
            frame_depth: f.depth,
            inset_from_face: f.inset,
            inset_inner: f.face == crate::opening_detail::Face::Innen,
            inset_mid: f.face == crate::opening_detail::Face::Mitte,
            ..s
        },
        None => s,
    });
    let finite = [wall.start.x, wall.start.y, wall.end.x, wall.end.y, total, ref_off, o.position, o.width].iter().all(|x| x.is_finite());
    let sym = if finite {
        let wr = crate::opening_geom::WallRef { start: crate::opening_geom::v(wall.start.x, wall.start.y), end: crate::opening_geom::v(wall.end.x, wall.end.y), total, ref_off };
        crate::opening_geom::window_symbol(&wr, o.position, o.width, 1.0, spec.as_ref(), o.wing_count.unwrap_or(f64::NAN), crate::opening_geom::Detail::Mittel)
    } else {
        None
    };
    if let (Some(sym), true) = (sym, spec.is_some()) {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for q in &sym.frame {
            let s = off_of(*q);
            lo = min(lo, s);
            hi = max(hi, s);
        }
        f_min = lo;
        f_max = hi;
        if !sym.glass_lines.is_empty() {
            let mut seen: Vec<f64> = Vec::new();
            for (q, _) in &sym.glass_lines {
                let x = round(off_of(*q) * 1e6) / 1e6;
                // `new Set` (SameValueZero: 0 = -0, NaN = NaN).
                if !seen.iter().any(|&s| s == x || (s.is_nan() && x.is_nan())) {
                    seen.push(x);
                }
            }
            glass = seen;
        }
    }
    let u0 = c.u_at(f_min);
    let u1 = c.u_at(f_max);
    let h = c.z_top - c.z_bottom;
    let fwv = min(fw, h / 3.0);
    let (sp, sh) = det.as_ref().map_or((0.0, 0.0), |f| (min(f.sill_profile, h / 4.0), min(f.shading_profile, h / 4.0)));
    let (fwb, fwt) = det.as_ref().map_or((fwv, fwv), |f| (min(max(0.02, f.sides.bottom), h / 3.0), min(max(0.02, f.sides.top), h / 3.0)));
    let (zb0, zt0) = (c.z_bottom + sp, c.z_top - sh);
    let mut out = vec![opening_poly(rect(c.u_at(c.face_min), c.u_at(c.face_max), c.z_bottom, c.z_top), false, &o.id)];
    out.push(opening_poly(rect(u0, u1, zb0, zb0 + fwb), true, &o.id));
    out.push(opening_poly(rect(u0, u1, zt0 - fwt, zt0), true, &o.id));
    // Fensterbank- und Storen-Anschlussprofil.
    if sp > 1e-4 {
        out.push(opening_poly(rect(u0, u1, c.z_bottom, zb0), true, &o.id));
    }
    if sh > 1e-4 {
        out.push(opening_poly(rect(u0, u1, zt0, c.z_top), true, &o.id));
    }
    for s in glass {
        let u = c.u_at(s);
        let mut l = line(v2(u, zb0 + fwb), v2(u, zt0 - fwt), "section-window-glass", GLASS_MM, OPENING_INK);
        if let Primitive::Line { opening_id, .. } = &mut l {
            *opening_id = Some(o.id.clone());
        }
        out.push(l);
    }
    // [105] Kämpfer (Oberlicht) und waagrechte Sprossen-Riegel geschnitten, in ihrer Breite.
    if let Some(t) = wt.filter(|_| !crate::opening_shape::is_shaped(o)) {
        let (lo, hi) = (zb0 + fwb, zt0 - fwt);
        let tw = det.as_ref().map(|f| f.transom_width).filter(|v| v.is_finite()).unwrap_or(fw);
        let mw = det.as_ref().map(|f| f.mullion_width).filter(|v| v.is_finite()).unwrap_or(fw);
        let mut bars: Vec<(f64, f64)> = Vec::new();
        let mut top = hi;
        let tr = t.transom_height.unwrap_or(0.0);
        if tr > 1e-4 && c.z_top - tr > lo + tw && c.z_top - tr < hi - tw / 2.0 {
            let z = c.z_top - tr;
            bars.push((z - tw / 2.0, z + tw / 2.0));
            top = z - tw / 2.0;
        }
        let rows = t.mullion_rows.unwrap_or(1.0).round().clamp(1.0, 20.0) as usize;
        for r in 1..rows {
            let z = lo + (top - lo) * r as f64 / rows as f64;
            bars.push((z - mw / 2.0, z + mw / 2.0));
        }
        for (z0, z1) in bars {
            out.push(opening_poly(rect(u0, u1, z0, z1), true, &o.id));
        }
    }
    if let Some(t) = wt {
        // Formöffnung ([G3]): kein Sturz-Querschnitt, kein Storenkasten (Bogen/Schräge statt Sturz).
        let shaped = crate::opening_shape::is_shaped(o);
        let shading = t.shading.as_ref().filter(|s| s.create && !shaped);
        let sturz_box = shading.filter(|s| s.mount == Some(WindowShadingMount::Sturz)).map_or(0.0, |s| max(0.0, s.r#box.depth));
        if !shaped {
            lintel_cut(&mut out, o, c, t.lintel_height, sturz_box);
        }
        // Fensterbänke nur bei ausdrücklicher Wahl (bisherige Schnitte bleiben gleich).
        let zb = c.z_bottom;
        if matches!(t.sill_board, Some(WindowTypeSillBoard::Aussen | WindowTypeSillBoard::Beide)) {
            // Aussen: mit Gefälle, bis 4 cm vor die Aussenfläche.
            let out_s = min(f_min, c.face_min) - 0.04;
            let pts = vec![v2(c.u_at(f_min), zb), v2(c.u_at(out_s), zb - 0.015), v2(c.u_at(out_s), zb - 0.045), v2(c.u_at(f_min), zb - 0.03)];
            out.push(opening_poly(pts, true, &o.id));
        }
        if matches!(t.sill_board, Some(WindowTypeSillBoard::Innen | WindowTypeSillBoard::Beide)) {
            let in_s = max(f_max, c.face_max) + 0.02;
            out.push(opening_poly(rect(c.u_at(f_max), c.u_at(in_s), zb - 0.025, zb), true, &o.id));
        }
        if let Some(sh) = shading {
            let h = max(0.0, sh.r#box.height);
            let d = max(0.0, sh.r#box.depth);
            if h > 1e-4 && d > 1e-4 {
                // Im Sturz: ab der Aussenfläche in die Wand; vorgesetzt: vor der Rahmen-Vorderkante.
                let (s0, s1) = if sturz_box > 0.0 { (c.face_min, c.face_min + d) } else { (f_min - d, f_min) };
                out.push(opening_poly(rect(c.u_at(s0), c.u_at(s1), c.z_top, c.z_top + h), true, &o.id));
                // Lamellen-/Rollpaket im Kasten.
                let m = min(0.02, d / 4.0);
                let mut pack = polygon(rect(c.u_at(s0 + m), c.u_at(s1 - m), c.z_top + m, c.z_top + h * 0.6), SHADING_PACK_FILL, OPENING_INK, crate::plan::style::SYMBOL_LINE_MM, no_hatch_base());
                if let Primitive::Polygon { opening_id, .. } = &mut pack {
                    *opening_id = Some(o.id.clone());
                }
                out.push(pack);
            }
        }
    }
    Ok(out)
}

/// Sturz im Schnitt ([94]): eigener Querschnitt über der Öffnung (Beton grau), neben einem
/// Storenkasten im Sturz (`box_depth` ab der Aussenfläche) nur über den Rest der Wanddicke.
fn lintel_cut(out: &mut Vec<Primitive>, o: &Opening, c: &CrossSection, height: Option<f64>, box_depth: f64) {
    let h = height.unwrap_or(0.0);
    if !(h > 1e-4) {
        return;
    }
    let s0 = min(c.face_max, c.face_min + box_depth);
    if c.face_max - s0 <= 1e-4 {
        return;
    }
    let mut pr = polygon(rect(c.u_at(s0), c.u_at(c.face_max), c.z_top, c.z_top + h), LINTEL_FILL, OPENING_INK, FRAME_MM, no_hatch_base());
    if let Primitive::Polygon { opening_id, .. } = &mut pr {
        *opening_id = Some(o.id.clone());
    }
    out.push(pr);
}

fn door_cut(p: &Project, o: &Opening, c: &CrossSection) -> Vec<Primitive> {
    let mut out = vec![opening_poly(rect(c.u_at(c.face_min), c.u_at(c.face_max), c.z_bottom, c.z_top), false, &o.id)];
    if !crate::opening_shape::is_shaped(o) {
        lintel_cut(&mut out, o, c, p.door_type(o).and_then(|t| t.lintel_height), 0.0);
    }
    let kind = p.door_type(o).map(|t| t.kind);
    // [105] Zargen-Arten: Sturz-Profil der Zarge und Blatt im Falz.
    if let Some(df) = crate::opening_detail::door_frame_of(p, o).filter(|_| matches!(kind, Some(DoorTypeKind::Dreh | DoorTypeKind::Pendel | DoorTypeKind::Unknown))) {
        door_frame_cut(&mut out, o, c, &df);
        return out;
    }
    if o.door_type == Some(OpeningDoorType::Wandoeffnung) || kind == Some(DoorTypeKind::Wandoeffnung) {
        return out;
    }
    let mid = (c.face_min + c.face_max) / 2.0;
    let fw = min(DEFAULT_FRAME_WIDTH, (c.z_top - c.z_bottom) / 4.0);
    if kind == Some(DoorTypeKind::Schiebe) {
        // Schiebetür vor der Wand ([95]): Blatt vor der Fläche auf der Aufschlagseite (linke Normale wie im Grundriss).
        let swing = if matches!(o.swing, None | Some(SwingSide::Left)) { 1.0 } else { -1.0 };
        let dir = if matches!(o.opening_dir, None | Some(OpeningOpeningDir::In)) { 1.0 } else { -1.0 };
        let face = if swing * dir > 0.0 { c.face_max } else { c.face_min };
        let s = swing * dir;
        out.push(opening_poly(rect(c.u_at(face + s * 0.01), c.u_at(face + s * (0.01 + DOOR_LEAF_THICKNESS)), c.z_bottom + 0.01, c.z_top + 0.03), true, &o.id));
        return out;
    }
    out.push(opening_poly(rect(c.u_at(mid - DEFAULT_FRAME_DEPTH / 2.0), c.u_at(mid + DEFAULT_FRAME_DEPTH / 2.0), c.z_top - fw, c.z_top), true, &o.id));
    if kind == Some(DoorTypeKind::Hebeschiebe) {
        // Zwei Flügel auf versetzten Gleisen, je mit Glaslinie.
        for off in [-0.035, 0.035] {
            let (a, b) = (mid + off - 0.02, mid + off + 0.02);
            out.push(opening_poly(rect(c.u_at(a), c.u_at(b), c.z_bottom + 0.03, c.z_top - fw), true, &o.id));
            let mut l = line(v2(c.u_at(mid + off), c.z_bottom + 0.03 + fw), v2(c.u_at(mid + off), c.z_top - 2.0 * fw), "section-window-glass", GLASS_MM, OPENING_INK);
            if let Primitive::Line { opening_id, .. } = &mut l {
                *opening_id = Some(o.id.clone());
            }
            out.push(l);
        }
        return out;
    }
    out.push(opening_poly(rect(c.u_at(mid - DOOR_LEAF_THICKNESS / 2.0), c.u_at(mid + DOOR_LEAF_THICKNESS / 2.0), c.z_bottom + 0.01, c.z_top - fw), true, &o.id));
    out
}

/// Türzarge im Schnitt ([105]): Profil am Sturz (gleiches Profil wie im Grundriss, `x` nach unten)
/// und Türblatt im Falz der Aufschlagseite.
fn door_frame_cut(out: &mut Vec<Primitive>, o: &Opening, c: &CrossSection, df: &crate::opening_detail::DoorFrame) {
    use crate::opening_detail as od;
    let total = c.face_max - c.face_min;
    let innen = od::aufschlag_innen(o);
    let s_of = |d: f64| c.face_min + if innen { total - d } else { d };
    let profile = od::door_frame_profile(df, total, innen);
    let clear = od::profile_clear_x(&profile);
    for (_, poly) in &profile {
        let pts: Vec<Vec2> = poly.iter().map(|q| v2(c.u_at(s_of(q[1])), c.z_top - q[0])).collect();
        let mut pr = if df.steel { polygon(pts, OPENING_INK, OPENING_INK, FRAME_MM, no_hatch_base()) } else { polygon(pts, "#ffffff", OPENING_INK, FRAME_MM, no_hatch_base()) };
        if let Primitive::Polygon { opening_id, .. } = &mut pr {
            *opening_id = Some(o.id.clone());
        }
        out.push(pr);
    }
    let (d0, d1) = od::leaf_band(df, total, innen);
    let top = c.z_top - max(clear - df.falz_width, 0.0);
    out.push(opening_poly(rect(c.u_at(s_of(d0)), c.u_at(s_of(d1)), c.z_bottom + 0.01, top), true, &o.id));
}

/// `sectionOpeningPrimitives`.
pub fn section_opening_primitives(p: &Project, level: &LevelSpec, vis: &Visibility) -> Result<Vec<Primitive>, String> {
    let Some(plane) = level.plane() else { return Ok(Vec::new()) };
    if level.kind != "section" {
        return Ok(Vec::new());
    }
    let u_raw = plane.u_model();
    let l = hypot2(u_raw.0, u_raw.1);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let u = (u_raw.0 / l, u_raw.1 / l);
    let p0 = plane.base();
    let mut walls_by_id: HashMap<&str, &Wall> = HashMap::new();
    for w in &p.walls {
        walls_by_id.insert(w.id.as_str(), w);
    }
    let mut out = Vec::new();
    for o in p.openings.as_deref().unwrap_or(&[]) {
        if !vis.visible(&o.category_code) || !vis.render(&o.category_code) {
            continue;
        }
        // Dach-/Deckenfenster ([103]): Schnitt durch Rahmen, Glas und Eindeckrahmen.
        if let Some(f) = crate::opening_shape::host_frame(p, o) {
            let greyed = vis.greyed(&o.category_code);
            for (part, corners) in crate::opening_shape::surface_window_boxes(p, o, &f) {
                let Some(pts) = crate::opening_shape::box_section(&corners, p0, u) else { continue };
                let pr = opening_poly(pts.iter().map(|q| v2(q[0], q[1])).collect(), part != 0, &o.id);
                out.push(if greyed { pr.with_greyed(true) } else { pr });
            }
            continue;
        }
        let Some(wall) = walls_by_id.get(o.host_wall_id.as_str()).copied() else { continue };
        if !vis.visible(&wall.category_code) {
            continue;
        }
        // Bogenwand ([T2]): Öffnung auf der Sehne zwischen den Laibungen (gerades Einbauteil).
        let chord = arc_chord_opening(wall, o);
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (wall, o),
        };
        let Some(c) = cross_section(p, wall, o, p0, u)? else { continue };
        let prims = if o.kind == ElementKind::Window { window_cut(p, wall, o, &c)? } else { door_cut(p, o, &c) };
        let greyed = vis.greyed(&o.category_code);
        for pr in prims {
            out.push(if greyed { pr.with_greyed(true) } else { pr });
        }
    }
    Ok(out)
}
