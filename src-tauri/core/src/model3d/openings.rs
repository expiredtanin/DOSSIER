//! Öffnungs-Einbauteile im 3D (Glas, Rahmen, Sprossen, Bank, Kasten): Öffnungen als flacher Puffer an
//! `openings3d`, Kästen zu Netzen, Füllungen von Formöffnungen und Türzargen (`emit_opening_meshes()`,
//! `wall_opening_meshes()`). Aufgerufen von `parts()` (`mod.rs`) und dem inkrementellen Cache.

use super::*;

/// Farbe je Bauteil-Klasse (Index = `Part` in `openings3d.rs`).
pub(crate) const PART_RGB: [Rgb; 7] = [
    [0.62, 0.76, 0.85],
    [0.85, 0.85, 0.83],
    [0.88, 0.88, 0.9],
    [0.8, 0.8, 0.78],
    [0.25, 0.27, 0.3],
    [0.93, 0.9, 0.85],
    [0.9, 0.89, 0.86],
];

/// Dreiecke eines Öffnungs-Quaders (Ecken-Bits: bit0 = Achse, bit1 = Höhe, bit2 = quer).
const OPENING_BOX_TRIS: [u32; 36] = [0, 1, 3, 0, 3, 2, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 3, 7, 1, 7, 5];

fn opt(v: Option<f64>) -> f64 {
    v.unwrap_or(f64::NAN)
}

fn flag(b: bool) -> f64 {
    if b {
        1.0
    } else {
        0.0
    }
}

fn join_code(j: Option<FrameCornerJoin>) -> f64 {
    match j {
        Some(FrameCornerJoin::Horizontal) => 1.0,
        Some(FrameCornerJoin::Gehrung) => 2.0,
        _ => 0.0,
    }
}

fn opening_kind_code(k: Option<OpeningKind>) -> f64 {
    match k {
        None => 0.0,
        Some(OpeningKind::Dreh) => 1.0,
        Some(OpeningKind::Kipp) => 2.0,
        Some(OpeningKind::Drehkipp) => 3.0,
        Some(OpeningKind::Fest) => 4.0,
        Some(OpeningKind::Schiebe) => 5.0,
        Some(OpeningKind::Unknown) => 6.0,
    }
}

#[allow(clippy::too_many_arguments)]
fn write_common(w: &mut FlatWriter, frame_depth: Option<f64>, inset: Option<f64>, side: f64, join: Option<FrameCornerJoin>, frame_width: Option<f64>, transom: Option<f64>, rebate: Option<f64>) {
    w.nums(&[opt(frame_depth), opt(inset), side, join_code(join), opt(frame_width), opt(transom), opt(rebate)]);
}

fn glazing_panes_of(wt: &WindowType) -> f64 {
    match wt.glazing_panes {
        Some(p) if p != 0.0 => p,
        _ => match wt.glazing {
            WindowTypeGlazing::Dreifach => 3.0,
            WindowTypeGlazing::Zweifach => 2.0,
            _ => 1.0,
        },
    }
}

fn write_opening(w: &mut FlatWriter, p: &Project, op: &Opening) {
    if op.kind == ElementKind::Window {
        let Some(wt) = p.window_type(op) else {
            w.num(0.0);
            return;
        };
        w.num(1.0);
        let side = match wt.inset_face {
            Some(WindowTypeInsetFace::Innen) => 1.0,
            Some(WindowTypeInsetFace::Mitte) => 2.0,
            _ => 0.0,
        };
        write_common(w, wt.frame_depth, wt.inset_from_face, side, wt.frame_corner_join, wt.frame_width, wt.transom_height, wt.rebate_depth);
        let sturz = wt.shading.as_ref().is_some_and(|s| s.mount == Some(WindowShadingMount::Sturz));
        let rails = sturz && wt.shading.as_ref().is_some_and(|s| s.kind != WindowShadingKind::Markise);
        let shading = wt.shading.as_ref().filter(|s| s.create).map(|s| &s.r#box);
        w.nums(&[
            glazing_panes_of(wt),
            opt(wt.mullion_rows),
            opt(wt.mullion_cols),
            match wt.sill_board {
                Some(WindowTypeSillBoard::Keine) => 1.0,
                Some(WindowTypeSillBoard::Innen) => 2.0,
                Some(WindowTypeSillBoard::Beide) => 3.0,
                _ => 0.0,
            },
            flag(shading.is_some()),
            shading.map_or(0.0, |b| b.width),
            shading.map_or(0.0, |b| b.height),
            shading.map_or(0.0, |b| b.depth),
            flag(sturz),
            flag(rails),
            op.wing_count.unwrap_or(wt.wing_count),
            opening_kind_code(Some(wt.kind)),
        ]);
        let sashes = wt.sashes.as_deref().unwrap_or(&[]);
        w.num(sashes.len() as f64);
        for s in sashes {
            w.nums(&[
                if s.kind == SashDefKind::Fluegel { 0.0 } else { 1.0 },
                flag(s.auto_width == Some(false)),
                opt(s.width),
                opt(s.post_width),
                opening_kind_code(s.opening),
                flag(s.hinge_side != Some(SashDefHingeSide::Right)),
            ]);
        }
        let transom = wt.transom_sashes.as_deref().unwrap_or(&[]);
        w.num(transom.len() as f64);
        for s in transom {
            w.nums(&[
                if s.kind == SashDefKind::Fluegel { 0.0 } else { 1.0 },
                flag(s.auto_width == Some(false)),
                opt(s.width),
                opt(s.post_width),
                opening_kind_code(s.opening),
                flag(s.hinge_side != Some(SashDefHingeSide::Right)),
            ]);
        }
        return;
    }
    let Some(dt) = p.door_type(op) else {
        w.num(0.0);
        return;
    };
    w.num(1.0);
    let side = match dt.inset_face {
        Some(DoorTypeInsetFace::Innen) => 1.0,
        Some(DoorTypeInsetFace::Mitte) => 2.0,
        _ => 0.0,
    };
    write_common(w, dt.frame_depth, dt.inset_from_face, side, dt.frame_corner_join, dt.frame_width, dt.transom_height, dt.rebate_depth);
    w.nums(&[
        flag(dt.threshold == Some(true)),
        dt.leaf_count,
        match dt.leaf_style {
            DoorTypeLeafStyle::Glas => 1.0,
            DoorTypeLeafStyle::Kassette => 2.0,
            _ => 0.0,
        },
        opt(dt.glazing_ratio),
        flag(dt.frame_kind != Some(DoorTypeFrameKind::Blockrahmen)),
        opt(dt.panel_cols),
        opt(dt.panel_rows),
        match dt.kind {
            DoorTypeKind::Schiebe => 1.0,
            DoorTypeKind::Hebeschiebe => 2.0,
            DoorTypeKind::Pendel => 3.0,
            DoorTypeKind::Tasche => 4.0,
            _ => 0.0,
        },
        // Aufschlagseite wie im Grundriss (linke Normale), hier entlang der rechten Normalen.
        -(if matches!(op.swing, None | Some(SwingSide::Left)) { 1.0 } else { -1.0 }) * (if matches!(op.opening_dir, None | Some(OpeningOpeningDir::In)) { 1.0 } else { -1.0 }),
        flag(op.hinge == Some(OpeningHinge::End)),
    ]);
}

/// Öffnungs-Einbauteile als Quader-Meshes (`emitOpeningMeshes`); `detail`: 0 grob, 1 mittel, 2 fein.
/// Bogenwände ([T2]): je Wand auf der abgewickelten Ersatzwand gerechnet und die Ecken gebogen — die
/// Einbauteile bleiben gerade (Sehne zwischen den Laibungen), ihre Enden sitzen radial in der Laibung.
pub fn emit_opening_meshes(p: &Project, detail: f64) -> Vec<RMesh> {
    let arcs: Vec<usize> = p.walls.iter().enumerate().filter(|(_, w)| crate::wall_arc::WallArc::of_wall(w).is_some()).map(|(i, _)| i).collect();
    if arcs.is_empty() {
        return emit_opening_meshes_plain(p, detail);
    }
    let mut q = p.clone();
    let arc_ids: std::collections::HashSet<&str> = arcs.iter().map(|&i| p.walls[i].id.as_str()).collect();
    q.openings = p.openings.as_ref().map(|v| v.iter().filter(|o| !arc_ids.contains(o.host_wall_id.as_str())).cloned().collect());
    let mut out = emit_opening_meshes_plain(&q, detail);
    for &i in &arcs {
        let Some((arc, v)) = crate::wall_arc::unrolled_wall(&p.walls[i]) else { continue };
        q.walls = vec![v];
        let own: Vec<Opening> = p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| o.host_wall_id == p.walls[i].id).cloned().collect();
        // [106] Öffnungen mit Schichteinzug liegen gerade auf der Sehne über `reveal_zone` (wie die
        // Teilwand mit dem Loch, `wall_arc::chord_walls`); die übrigen werden gebogen.
        let zone = |o: &Opening| -> Option<(f64, f64)> {
            let r = crate::opening_detail::opening_reveal(p, &p.walls[i], o)?;
            let ms = r.sides[..2].iter().flatten().map(|a| a.shift).fold(0.0f64, f64::max);
            Some(crate::wall_arc::reveal_zone(r.from, r.to, ms, arc.length()))
        };
        let (zoned, bent): (Vec<Opening>, Vec<Opening>) = own.into_iter().partition(|o| zone(o).is_some());
        q.openings = Some(bent);
        for mut m in emit_opening_meshes_plain(&q, detail) {
            for c in m.positions.chunks_exact_mut(3) {
                let w = arc.point(c[0], c[1]);
                c[0] = w.x;
                c[1] = w.y;
            }
            out.push(m);
        }
        for o in zoned {
            let Some((sa, sb)) = zone(&o) else { continue };
            let (pa, u, chord) = crate::wall_arc::chord_of(&arc, sa, sb);
            q.openings = Some(vec![o]);
            for mut m in emit_opening_meshes_plain(&q, detail) {
                for c in m.positions.chunks_exact_mut(3) {
                    let t = (c[0] - sa) / (sb - sa) * chord;
                    let (x, y) = (pa.x + u.x * t - u.y * c[1], pa.y + u.y * t + u.x * c[1]);
                    c[0] = x;
                    c[1] = y;
                }
                out.push(m);
            }
        }
    }
    out
}

fn emit_opening_meshes_plain(p: &Project, detail: f64) -> Vec<RMesh> {
    let by_wall = p.openings_by_wall();
    let per: Vec<WallOpeningMeshes> = p.walls.iter().map(|wall| wall_opening_meshes(p, wall, by_wall.get(wall.id.as_str()).map_or(&[][..], |v| v.as_slice()), detail)).collect();
    let mut out = assemble_opening_meshes(per);
    out.extend(surface_window_meshes(p));
    out
}

/// Öffnungs-Einbauteile EINER Wand ([58]: der 3D-Cache behält sie je Wand): die Quader je Durchgang
/// (`openings3d::wall_mesh_passes`), Türzargen und Formöffnungen.
#[derive(Clone, Debug, Default)]
pub(crate) struct WallOpeningMeshes {
    pub passes: [Vec<RMesh>; 3],
    pub zargen: Vec<RMesh>,
    pub shaped: Vec<RMesh>,
}

/// Reihenfolge des ganzen Modells: alle Wände je Durchgang, dann alle Zargen, dann alle Formöffnungen
/// (ohne die Dach-/Deckenfenster, s. [`surface_window_meshes`]).
pub(crate) fn assemble_opening_meshes(per: Vec<WallOpeningMeshes>) -> Vec<RMesh> {
    let mut lists: [Vec<RMesh>; 5] = Default::default();
    for m in per {
        let [a, b, c] = m.passes;
        for (k, v) in [a, b, c, m.zargen, m.shaped].into_iter().enumerate() {
            lists[k].extend(v);
        }
    }
    lists.into_iter().flatten().collect()
}

/// Dach-/Deckenfenster ([103]).
pub(crate) fn surface_window_meshes(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    for op in p.openings.as_deref().unwrap_or(&[]) {
        if let Some(f) = crate::opening_shape::host_frame(p, op) {
            for (part, positions) in crate::opening_shape::surface_window_boxes(p, op, &f) {
                out.push(box_mesh(positions, PART_RGB[part as usize]));
            }
        }
    }
    out
}

/// Einbauteile der Öffnungen `openings` (in Projekt-Reihenfolge) der Wand `wall`.
pub(crate) fn wall_opening_meshes(p: &Project, wall: &Wall, openings: &[&Opening], detail: f64) -> WallOpeningMeshes {
    let mut shaped: Vec<RMesh> = Vec::new();
    let mut w = FlatWriter::new();
    w.num(detail).num(1.0);
    // [105] Anhang: Rahmen-Detail je (Wand, Öffnung); Türzargen als eigene Quader.
    let mut details: Vec<f64> = Vec::new();
    let mut n_details = 0.0;
    let mut zargen: Vec<RMesh> = Vec::new();
    let wi = 0usize;
    {
        w.nums(&[wall.start.x, wall.start.y, wall.end.x, wall.end.y]);
        let slot = w.slot();
        let mut count = 0.0;
        let wr = wall_ref(p, wall);
        let (zb, zt) = p.wall_vertical_extent(wall);
        let mut thickness: Option<f64> = None;
        for &op in openings {
            let Some((from, to)) = opening_geom::opening_interval(&wr, op.position, op.width) else { continue };
            let o_bottom = zb + op.sill_height.max(0.0);
            let o_top = zt.min(o_bottom + op.height);
            let t = *thickness.get_or_insert_with(|| p.wall_thickness(wall, 0.2));
            // Formöffnung ([G3]): Füllkörper, Rahmen und Glas entlang des Umrisses statt der Quader-Teile.
            if crate::opening_shape::is_shaped(op) {
                shaped.extend(shaped_wall_opening_meshes(p, wall, &wr, op, [from, to, o_bottom, o_top]));
                continue;
            }
            w.nums(&[from, to, o_bottom, o_top, flag(op.kind != ElementKind::Window), t]);
            write_opening(&mut w, p, op);
            let dframe = crate::opening_detail::door_frame_of(p, op);
            if let Some(f) = crate::opening_detail::frame_of(p, op).filter(|f| f.detailed || dframe.is_some()) {
                let s4 = |s: crate::opening_detail::Sides| [s.left, s.right, s.top, s.bottom];
                details.extend([wi as f64, count]);
                details.extend(s4(f.sides));
                details.extend(s4(f.ext));
                details.extend(s4(f.rebate));
                details.extend([f.sash_width, f.sash_depth, f.sash_overlap, f.mullion_width, f.transom_width, f.sill_profile, f.shading_profile, flag(dframe.is_some())]);
                details.extend(dframe.as_ref().map_or([f64::NAN; 4], |df| door_leaf_in_falz(&wr, op, df)));
                n_details += 1.0;
            }
            if let (Some(df), true) = (dframe.as_ref(), detail > 0.0) {
                door_frame_boxes(&mut zargen, wall, &wr, op, df, (from, to, o_bottom, o_top));
            }
            count += 1.0;
        }
        w.set(slot, count);
    }
    w.num(n_details);
    w.nums(&details);
    let passes = crate::openings3d::opening_mesh_passes_flat(&w.done()).map(|buf| box_meshes_of_flat(&buf));
    WallOpeningMeshes { passes, zargen, shaped }
}

/// Quader aus dem flachen Puffer von `openings3d` (`[n, je Quader: Bauteil, 24 Koordinaten]`).
fn box_meshes_of_flat(buf: &[f64]) -> Vec<RMesh> {
    let n = buf.first().copied().unwrap_or(0.0).max(0.0) as usize;
    let mut out = Vec::new();
    let mut i = 1;
    for _ in 0..n {
        if i + 25 > buf.len() {
            break;
        }
        let part = buf[i] as usize;
        out.push(RMesh {
            crease_angle: None,
            positions: buf[i + 1..i + 25].to_vec(),
            indices: OPENING_BOX_TRIS.to_vec(),
            kind: "extrusion",
            color: PART_RGB.get(part).copied().unwrap_or(PART_RGB[1]),
            vertex_colors: None,
            material_index: None,
        });
        i += 25;
    }
    out
}

fn box_mesh(positions: [f64; 24], color: Rgb) -> RMesh {
    RMesh { crease_angle: None, positions: positions.to_vec(), indices: OPENING_BOX_TRIS.to_vec(), kind: "extrusion", color, vertex_colors: None, material_index: None }
}

/// Schichten einer Wand für die Füllkörper einer Formöffnung ([G3]): Dicke (auf `total` skaliert)
/// und Farbe, aussen zuerst; ohne Aufbau eine Schicht in Wandfarbe. Dazu je Schicht der
/// Schichteinzug [106] (nur gestapelte Schichten wie die Wandbänder): Rücksprung je Seite
/// `[links, rechts, oben, unten]` und Zusatzstücke `(seite, [x0, x1, o0, o1])`.
struct FillBand {
    thickness: f64,
    color: Rgb,
    shift: [f64; 4],
    pieces: Vec<(usize, [f64; 4])>,
}

fn shaped_fill_bands(p: &Project, wall: &Wall, op: &Opening, total: f64) -> Vec<FillBand> {
    let (bands, stacked) = resolve_wall_bands(p, &wall_material_color_maps(p), wall, true);
    let sum: f64 = bands.iter().map(|b| b.thickness.max(0.0)).sum();
    if !(sum > 1e-9) || bands.iter().all(|b| b.thickness <= 1e-9) {
        return vec![FillBand { thickness: total, color: WALL_RGB, shift: [0.0; 4], pieces: Vec::new() }];
    }
    let reveal = if stacked { crate::opening_detail::opening_reveal(p, wall, op).filter(|r| r.thick.len() == bands.len()) } else { None };
    let mut list: Vec<FillBand> = bands.iter().map(|b| FillBand { thickness: b.thickness.max(0.0) * total / sum, color: b.color, shift: [0.0; 4], pieces: Vec::new() }).collect();
    for (k, side) in reveal.iter().flat_map(|r| r.sides.iter().enumerate()) {
        for a in side {
            if let Some(fb) = list.get_mut(a.layer) {
                fb.shift[k] = a.shift;
                fb.pieces.extend(a.pieces.iter().map(|pc| (k, [pc[0], pc[1], pc[2] * total / sum, pc[3] * total / sum])));
            }
        }
    }
    list.retain(|b| b.thickness > 1e-9);
    list
}

/// Wandkörper einer Formöffnung als Vierecke in Öffnungskoordinaten mit Lage quer `[n0, n1]` (aussen =
/// +total/2) und Farbe: Füllkörper je Schicht zwischen dem (geweiteten) Rechteck-Loch und dem um den
/// Schichteinzug versetzten Umriss, Zusatzstücke [106] entlang des Umrisses (je Kante nach ihrer Seite).
fn shaped_wall_fill(p: &Project, wall: &Wall, op: &Opening, total: f64, w: f64, h: f64) -> Vec<([crate::opening_shape::P; 4], f64, f64, Rgb)> {
    use crate::opening_shape as os;
    let Some(poly) = os::opening_outline(op, w, h) else { return Vec::new() };
    let half = total / 2.0;
    let bands = shaped_fill_bands(p, wall, op, total);
    let mut out = Vec::new();
    let mut n_hi = half;
    for b in &bands {
        for q in os::layer_fill_quads(&poly, w, h, b.shift) {
            out.push((q, n_hi - b.thickness, n_hi, b.color));
        }
        n_hi -= b.thickness;
    }
    for b in &bands {
        for &(side, [x0, x1, o0, o1]) in &b.pieces {
            if !(x1 - x0 > 1e-9 && o1 - o0 > 1e-9) {
                continue;
            }
            let (outer, inner) = (os::inset(&poly, x0), os::inset(&poly, x1));
            for (i, q) in os::ring_quads(&outer, &inner).into_iter().enumerate() {
                if os::edge_side(&poly, i) == side {
                    out.push((q, half - o1, half - o0, b.color));
                }
            }
        }
    }
    out
}

/// Anzahl der Wandkörper (Füllkörper je Schicht, Zusatzstücke) einer Formöffnung — sie stehen in
/// [`shaped_wall_opening_meshes`] vor Rahmen und Glas.
pub(crate) fn shaped_fill_count(p: &Project, wall: &Wall, op: &Opening, w: f64, h: f64) -> usize {
    shaped_wall_fill(p, wall, op, p.wall_thickness(wall, 0.2), w, h).len()
}

/// Formöffnung in der Wand ([G3]) als Quader: Füllkörper (je Wandschicht, mit Schichteinzug [106]) zwischen dem
/// Rechteck-Loch und dem Umriss, Rahmen-Ring und Glas (bzw. Türblatt) entlang des Umrisses. Rahmenlage
/// quer zur Wand wie bei den Rechteck-Öffnungen (`openings3d::frame_normal_range`). Nicht für Formen:
/// Anschlag, Fensterbank, Storenkasten, Flügel-/Sprossenteilung (bleiben beim Rechteck).
pub(crate) fn shaped_wall_opening_meshes(p: &Project, wall: &Wall, wr: &WallRef, op: &Opening, [from, to, zb, zt]: [f64; 4]) -> Vec<RMesh> {
    use crate::opening_shape as os;
    let (w, h) = (to - from, zt - zb);
    let Some(poly) = os::opening_outline(op, w, h) else { return Vec::new() };
    let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    let len = hypot2(dx, dy);
    if len < 1e-9 {
        return Vec::new();
    }
    let (ux, uy) = (dx / len, dy / len);
    // Quer-Achse wie `openings3d` (rechte Normale); die Wandmitte liegt bei −ref_off.
    let shift = -wr.ref_off;
    let map = |u: f64, v: f64, n: f64| -> [f64; 3] {
        let (s, t) = (from + u, n + shift);
        [wall.start.x + ux * s + uy * t, wall.start.y + uy * s - ux * t, zb + v]
    };
    let half = wr.total / 2.0;
    // Wandkörper je Schicht (aussen = +half) in deren Farbe.
    let mut out: Vec<RMesh> = shaped_wall_fill(p, wall, op, wr.total, w, h).into_iter().map(|(q, n0, n1, rgb)| box_mesh(os::quad_box(&q, n0, n1, &map), rgb)).collect();
    let door = op.kind == ElementKind::Door;
    let ty = if door {
        p.door_type(op).map(|t| (t.frame_depth, t.inset_from_face, t.inset_face == Some(DoorTypeInsetFace::Innen), t.inset_face == Some(DoorTypeInsetFace::Mitte), t.frame_width))
    } else {
        p.window_type(op).map(|t| (t.frame_depth, t.inset_from_face, t.inset_face == Some(WindowTypeInsetFace::Innen), t.inset_face == Some(WindowTypeInsetFace::Mitte), t.frame_width))
    };
    let glass = PART_RGB[0];
    let Some((fd, inset_face, inner, mid, fw)) = ty else {
        // Ohne Typ: eine Vollscheibe mittig (wie das Rechteck-Fenster ohne Typ).
        if !door {
            let g = crate::openings3d::GLASS_HALF_THICK;
            for q in os::strip_quads(&poly) {
                out.push(box_mesh(os::quad_box(&q, -g, g, &map), glass));
            }
        }
        return out;
    };
    let depth = crate::openings3d::across_wall_depth(fd.unwrap_or(f64::NAN).max(0.0), wr.total);
    let (n_min, n_max) = crate::openings3d::frame_normal_range(half, depth, inset_face.unwrap_or(0.0), inner, mid);
    let fw = fw.filter(|v| *v > 0.0).unwrap_or(crate::openings3d::DEFAULT_FRAME_WIDTH).min(w.min(h) / 3.0);
    let inner_poly = os::inset(&poly, fw);
    for (k, q) in os::ring_quads(&poly, &inner_poly).into_iter().enumerate() {
        // Tür: unten keine Schwelle (Kante 0 = Boden).
        if door && k == 0 && op.shape != Some(OpeningShape::Rund) {
            continue;
        }
        out.push(box_mesh(os::quad_box(&q, n_min, n_max, &map), PART_RGB[1]));
    }
    let (inner_glass, color) = if door {
        let c = (n_min + n_max) / 2.0;
        let t = crate::openings3d::DOOR_LEAF_THICK / 2.0;
        ((c - t, c + t), PART_RGB[5])
    } else {
        let n1 = n_max - 0.02;
        ((n1 - 2.0 * crate::openings3d::GLASS_HALF_THICK, n1), glass)
    };
    for q in os::strip_quads(&inner_poly) {
        out.push(box_mesh(os::quad_box(&q, inner_glass.0, inner_glass.1, &map), color));
    }
    out
}

/// Türzarge als Quader ([105]): Profil (Grundriss = Schnitt) an beiden Leibungen über die Höhe und
/// am Sturz über die Breite; Ecken ohne Überlappung (Leibungsstück endet unter dem Sturzstück).
/// Türblatt im Falz ([105]): Einzug ab Rohbaukante (seitlich, oben) und Lage quer zur Wand in der
/// Normalen von `openings3d` (rechts der Achse, `t = −Versatz`).
fn door_leaf_in_falz(wr: &WallRef, op: &Opening, df: &crate::opening_detail::DoorFrame) -> [f64; 4] {
    use crate::opening_detail as od;
    let innen = od::aufschlag_innen(op);
    let clear = od::profile_clear_x(&od::door_frame_profile(df, wr.total, innen));
    let x = (clear - df.falz_width).max(0.0);
    let (d0, d1) = od::leaf_band(df, wr.total, innen);
    let face = wr.ref_off - wr.total / 2.0;
    let off_of = |d: f64| face + if innen { wr.total - d } else { d };
    [x, x, -off_of(d0), -off_of(d1)]
}

fn door_frame_boxes(out: &mut Vec<RMesh>, wall: &Wall, wr: &WallRef, op: &Opening, df: &crate::opening_detail::DoorFrame, (from, to, zb, zt): (f64, f64, f64, f64)) {
    use crate::opening_detail as od;
    let (u, n) = wr.frame();
    let face = wr.ref_off - wr.total / 2.0;
    let innen = od::aufschlag_innen(op);
    let off_of = |d: f64| face + if innen { wr.total - d } else { d };
    let s = [wall.start.x, wall.start.y];
    let (u, n) = ([u.x, u.y], [n.x, n.y]);
    for (part, poly) in od::door_frame_profile(df, wr.total, innen) {
        let rgb = if part == od::FramePart::Frame && df.steel { PART_RGB[4] } else { PART_RGB[1] };
        for [x0, x1, d0, d1] in od::ortho_rects(&poly) {
            let (o0, o1) = (off_of(d0).min(off_of(d1)), off_of(d0).max(off_of(d1)));
            let boxes = [
                od::axis_box(s, u, n, from + x0, from + x1, zb, zt - x1, o0, o1),
                od::axis_box(s, u, n, to - x1, to - x0, zb, zt - x1, o0, o1),
                od::axis_box(s, u, n, from + x0, to - x0, zt - x1, zt - x0, o0, o1),
            ];
            for b in boxes.into_iter().flatten() {
                out.push(RMesh {
                    crease_angle: None, positions: b.to_vec(), indices: OPENING_BOX_TRIS.to_vec(), kind: "extrusion", color: rgb, vertex_colors: None, material_index: None });
            }
        }
    }
}
