//! Fenster und Türen in der Ansicht: Projektion der Öffnungen samt Verglasung, Flügel, Rahmen und
//! Leibungsschatten (`collect_openings()`), dazu Flächenöffnungen. Gerufen von `elevation_primitives_with()`
//! in `mod.rs`.

use super::*;

pub(super) struct ProjOpening {
    pub(super) pts: [Pt; 4],
    pub(super) depth: f64,
    pub(super) glass: Vec<[Pt; 4]>,
    pub(super) door_leaf: Vec<[Pt; 4]>,
    pub(super) divisions: Vec<(Pt, Pt)>,
    pub(super) sash_rects: Vec<[Pt; 4]>,
    pub(super) sill: Vec<[Pt; 4]>,
    pub(super) symbol: Vec<(Pt, Pt)>,
    pub(super) id: String,
    /// Formöffnung ([G3]): Rahmen-Umriss und Glas entlang des Umrisses statt der Rechtecke.
    pub(super) shape: Option<(Vec<Pt>, Vec<Pt>, Vec<Vec<Pt>>, String)>,
    /// [105] Rahmen-Umriss, wenn er über die Rohbauöffnung hinausgeht (Zargenspiegel, Bekleidung).
    pub(super) frame: Option<[Pt; 4]>,
}

/// Türzarge in der Ansicht ([105]) von der sichtbaren Seite: `outer` = über die Rohbaukante hinaus
/// (Spiegel, Bekleidung, Blendrahmen), `clear` = lichte Kante der Zarge, `leaf` = Blatt-Einzug.
struct DoorBand {
    pub(super) outer: f64,
    pub(super) clear: f64,
    leaf: f64,
}

/// Sichtbare Wandseite: +1 = rechts der Achse (Aussenseite, `layers[0]`), −1 = innen.
fn view_side(frame: &[f64; 9], wall: &Wall) -> f64 {
    let (ax, az) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    let len = hypot2(ax, az).max(1e-12);
    if frame[3] * az / len - frame[5] * ax / len < 0.0 { 1.0 } else { -1.0 }
}

fn door_band(df: &crate::opening_detail::DoorFrame, total: f64, o: &Opening, side: f64) -> DoorBand {
    use crate::opening_detail as od;
    let innen = od::aufschlag_innen(o);
    let prof = od::door_frame_profile(df, total, innen);
    // Aufschlagfläche sichtbar? (Aufschlag innen ⇔ Innenseite −1).
    let aufschlag = (side < 0.0) == innen;
    let touches = |poly: &[[f64; 2]]| poly.iter().any(|q| if aufschlag { q[1] <= 1e-6 } else { q[1] >= total - 1e-6 });
    let outer = prof.iter().filter(|(_, p)| touches(p)).flat_map(|(_, p)| p.iter().map(|q| -q[0])).fold(0.0, f64::max);
    let clear = od::profile_clear_x(&prof);
    // Von der Aufschlagseite liegt das Blatt vor dem Falz.
    let leaf = if aufschlag { (clear - df.falz_width).max(0.0) } else { clear };
    DoorBand { outer, clear, leaf }
}

/// Umriss einer Formöffnung in Anteilen (0…1) und das um die Rahmenbreite eingerückte Glas.
type ShapeNorm = (Vec<[f64; 2]>, Vec<[f64; 2]>, Vec<[[f64; 2]; 4]>, String);

fn map_quad(q: &[Pt; 4], s: f64, t: f64) -> Pt {
    let lerp = |a: Pt, b: Pt, k: f64| -> Pt { [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] };
    lerp(lerp(q[0], q[1], s), lerp(q[3], q[2], s), t)
}

fn sash_kind(k: OpeningKind) -> f64 {
    match k {
        OpeningKind::Dreh => 1.0,
        OpeningKind::Kipp => 2.0,
        OpeningKind::Drehkipp => 3.0,
        OpeningKind::Schiebe => 4.0,
        _ => 0.0,
    }
}

/// `collectOpenings`.
pub(super) fn collect_openings(p: &Project, frame: &[f64; 9]) -> Vec<ProjOpening> {
    let mut b = vec![0.0];
    let mut ids: Vec<&str> = Vec::new();
    let mut shapes: Vec<Option<ShapeNorm>> = Vec::new();
    let mut bands: Vec<Option<DoorBand>> = Vec::new();
    let by_wall = p.openings_by_wall();
    for wall in &p.walls {
        let thickness = p.wall_type(wall).map_or(0.2, |t| t.layers.iter().fold(0.0, |s, l| s + l.thickness));
        for &op in by_wall.get(wall.id.as_str()).map_or(&[][..], |v| v.as_slice()) {
            let arc = crate::wall_arc::WallArc::of_wall(wall);
            let axis = arc.map_or_else(|| hypot2(wall.end.x - wall.start.x, wall.end.y - wall.start.y), |a| a.length());
            let from = max(0.0, min(op.position, axis));
            let to = max(from, min(op.position + op.width, axis));
            if to - from < 1e-4 {
                continue;
            }
            // [T2] Bogenwand: Öffnung als Sehne zwischen den Laibungen (Ersatzwand je Öffnung).
            let (ws, we, from, to) = match arc {
                Some(a) => {
                    let (ps, pe) = (a.point(from, 0.0), a.point(to, 0.0));
                    (Vec2 { x: ps.x, y: ps.y }, Vec2 { x: pe.x, y: pe.y }, 0.0, hypot2(pe.x - ps.x, pe.y - ps.y))
                }
                None => (wall.start, wall.end, from, to),
            };
            let (zb, zt) = p.wall_vertical_extent(wall);
            let ob = zb + max(0.0, op.sill_height);
            let ot = min(zt, ob + op.height);
            let door = op.kind == ElementKind::Door;
            let dt = if door { p.door_type(op) } else { None };
            let wt = if door { None } else { p.window_type(op) };
            b.extend([
                ws.x,
                ws.y,
                we.x,
                we.y,
                thickness,
                from,
                to,
                ob,
                ot,
                if door { 1.0 } else { 0.0 },
                if dt.is_some_and(|d| d.leaf_style == DoorTypeLeafStyle::Glas) { 1.0 } else { 0.0 },
                dt.and_then(|d| d.glazing_ratio).unwrap_or(f64::NAN),
                wt.and_then(|t| t.frame_width).unwrap_or(0.06),
                if door { dt.and_then(|t| t.transom_height) } else { wt.and_then(|t| t.transom_height) }.unwrap_or(0.0),
                wt.and_then(|t| t.mullion_rows).unwrap_or(f64::NAN),
                wt.and_then(|t| t.mullion_cols).unwrap_or(f64::NAN),
                if matches!(wt.and_then(|t| t.sill_board), Some(WindowTypeSillBoard::Keine | WindowTypeSillBoard::Innen)) { 0.0 } else { 1.0 },
                wt.map_or(0.0, |t| sash_kind(t.kind)),
                // Anschlag nur mit Leibung (Einzug > 0 oder mittig), sonst gibt es keine Wandnase.
                match (dt, wt) {
                    (Some(t), _) if t.inset_face == Some(DoorTypeInsetFace::Mitte) || t.inset_from_face.unwrap_or(0.0) > 1e-4 => t.rebate_depth.unwrap_or(0.0),
                    (_, Some(t)) if t.inset_face == Some(WindowTypeInsetFace::Mitte) || t.inset_from_face.unwrap_or(0.0) > 1e-4 => t.rebate_depth.unwrap_or(0.0),
                    _ => 0.0,
                },
                if (door && dt.and_then(|t| t.inset_face) == Some(DoorTypeInsetFace::Innen)) || (!door && wt.and_then(|t| t.inset_face) == Some(WindowTypeInsetFace::Innen)) { -1.0 } else { 1.0 },
                match dt.map(|t| t.kind) {
                    // Schiebe-/Taschentür: Pfeil zur Park-/Taschenseite (Bandseite), zweiflügelig beidseitig.
                    Some(DoorTypeKind::Schiebe | DoorTypeKind::Tasche) => match dt.map_or(1.0, |t| round(t.leaf_count)) {
                        n if n >= 2.0 => 5.0,
                        _ if op.hinge.is_some_and(|s| s != OpeningHinge::Start) => 4.0,
                        _ => 1.0,
                    },
                    Some(DoorTypeKind::Hebeschiebe) => 2.0,
                    Some(DoorTypeKind::Pendel) => 3.0,
                    _ => 0.0,
                },
            ]);
            // [105] Rahmen-Detail je Seite, Anschlag je Seite, Profile, Türblatt-Einzug der Zarge.
            let det = crate::opening_detail::frame_of(p, op).filter(|f| f.detailed);
            let dframe = crate::opening_detail::door_frame_of(p, op);
            let side = view_side(frame, wall);
            let band = dframe.as_ref().map(|df| door_band(df, thickness, op, side));
            let nan = f64::NAN;
            match det.as_ref() {
                Some(f) if !door => b.extend([f.sides.left, f.sides.right, f.sides.top, f.sides.bottom]),
                _ => b.extend([nan; 4]),
            }
            match det.as_ref() {
                Some(f) => b.extend([f.rebate.left, f.rebate.right, f.rebate.top]),
                None => b.extend([nan; 3]),
            }
            match det.as_ref() {
                Some(f) if !door => b.extend([f.ext.left, f.ext.right, f.sill_profile, f.shading_profile]),
                _ => b.extend([nan; 4]),
            }
            match &band {
                Some(bd) => b.extend([bd.leaf, bd.leaf]),
                None => b.extend([nan; 2]),
            }
            if band.is_some() {
                // Zargen ohne Wandnase: der Anschlag gehört zur Zarge.
                let k = b.len() - 13 - 3;
                b[k] = 0.0;
            }
            let mullion = det.as_ref().map_or(f64::NAN, |f| f.mullion_width);
            // Flügel: (pfosten, postWidth, autoWidth, width, opening, hingeLeft).
            let mut sashes: Vec<[f64; 6]> = Vec::new();
            if !door {
                match wt {
                    Some(t) => match t.sashes.as_deref().filter(|s| !s.is_empty()) {
                        Some(list) => {
                            for s in list {
                                sashes.push([
                                    if s.kind == SashDefKind::Pfosten { 1.0 } else { 0.0 },
                                    s.post_width.unwrap_or(mullion),
                                    if s.auto_width == Some(false) { 0.0 } else { 1.0 },
                                    s.width.unwrap_or(f64::NAN),
                                    s.opening.map_or(-1.0, sash_kind),
                                    if s.hinge_side.unwrap_or(SashDefHingeSide::Left) == SashDefHingeSide::Left { 1.0 } else { 0.0 },
                                ]);
                            }
                        }
                        None => {
                            let wc = if t.wing_count == 0.0 || t.wing_count.is_nan() { 1.0 } else { t.wing_count };
                            let n = max(1.0, round(wc)) as usize;
                            for i in 0..n {
                                // [105] Pfostenbreite gesetzt: Pfosten zwischen den Flügeln.
                                if i > 0 && mullion.is_finite() && mullion > 1e-4 {
                                    sashes.push([1.0, mullion, 1.0, f64::NAN, 0.0, 1.0]);
                                }
                                sashes.push([0.0, f64::NAN, 1.0, f64::NAN, sash_kind(t.kind), if i % 2 == 0 { 1.0 } else { 0.0 }]);
                            }
                        }
                    },
                    None => sashes.push([0.0, f64::NAN, 1.0, f64::NAN, -1.0, 1.0]),
                }
            }
            b.push(sashes.len() as f64);
            for s in &sashes {
                b.extend(s);
            }
            // Oberlicht-Einteilung (Pfosten/Riegel, [95]).
            let transom = if door { &[][..] } else { wt.and_then(|t| t.transom_sashes.as_deref()).unwrap_or(&[]) };
            b.push(transom.len() as f64);
            for s in transom {
                b.extend([
                    if s.kind == SashDefKind::Pfosten { 1.0 } else { 0.0 },
                    s.post_width.unwrap_or(f64::NAN),
                    if s.auto_width == Some(false) { 0.0 } else { 1.0 },
                    s.width.unwrap_or(f64::NAN),
                    s.opening.map_or(0.0, sash_kind),
                    if s.hinge_side.unwrap_or(SashDefHingeSide::Left) == SashDefHingeSide::Left { 1.0 } else { 0.0 },
                ]);
            }
            ids.push(&op.id);
            bands.push(band);
            shapes.push(crate::opening_shape::opening_outline(op, to - from, ot - ob).map(|poly| {
                let (w, h) = (to - from, ot - ob);
                let fw = if door { dt.and_then(|t| t.frame_width) } else { wt.and_then(|t| t.frame_width) }.unwrap_or(0.06).min(w.min(h) / 3.0);
                let norm = |q: &[f64; 2]| [q[0] / w, q[1] / h];
                let fills = crate::opening_shape::fill_quads(&poly, w, h).iter().map(|q| q.map(|c| norm(&c))).collect();
                (poly.iter().map(norm).collect(), crate::opening_shape::inset(&poly, fw).iter().map(norm).collect(), fills, wall.id.clone())
            }));
            b[0] += 1.0;
        }
    }
    let f = crate::plan::elevation_geom::openings(frame, &b);
    let mut out = Vec::new();
    if f.is_empty() {
        return out;
    }
    let mut i = 1;
    let quads = |i: &mut usize| -> Vec<[Pt; 4]> {
        let n = f[*i] as usize;
        *i += 1;
        let mut list = Vec::with_capacity(n);
        for _ in 0..n {
            list.push([[f[*i], f[*i + 1]], [f[*i + 2], f[*i + 3]], [f[*i + 4], f[*i + 5]], [f[*i + 6], f[*i + 7]]]);
            *i += 8;
        }
        list
    };
    let lines = |i: &mut usize| -> Vec<(Pt, Pt)> {
        let n = f[*i] as usize;
        *i += 1;
        let mut list = Vec::with_capacity(n);
        for _ in 0..n {
            list.push(([f[*i], f[*i + 1]], [f[*i + 2], f[*i + 3]]));
            *i += 4;
        }
        list
    };
    for k in 0..f[0] as usize {
        let vis = f[i];
        i += 1;
        if vis == 0.0 {
            continue;
        }
        let depth = f[i];
        let pts = [[f[i + 2], f[i + 3]], [f[i + 4], f[i + 5]], [f[i + 6], f[i + 7]], [f[i + 8], f[i + 9]]];
        i += 10;
        let glass = quads(&mut i);
        let door_leaf = quads(&mut i);
        let divisions = lines(&mut i);
        let sash_rects = quads(&mut i);
        let sill = quads(&mut i);
        let symbol = lines(&mut i);
        let m = |q: &[f64; 2]| map_quad(&pts, q[0], q[1]);
        let shape = shapes[k].as_ref().map(|(o, g, fl, wid)| (o.iter().map(m).collect(), g.iter().map(m).collect(), fl.iter().map(|q| q.iter().map(m).collect()).collect(), wid.clone()));
        if shape.is_some() {
            // Formöffnung ([G3]): ohne Flügel-/Sprossenteilung, Türblatt und Symbole (Rechteck-Raster).
            let round = p.openings.as_deref().unwrap_or(&[]).iter().any(|o| o.id == ids[k] && !crate::opening_shape::has_flat_bottom(o));
            out.push(ProjOpening { pts, depth, glass: Vec::new(), door_leaf: Vec::new(), divisions: Vec::new(), sash_rects: Vec::new(), sill: if round { Vec::new() } else { sill }, symbol: Vec::new(), id: ids[k].to_string(), shape, frame: None });
            continue;
        }
        let mut sash_rects = sash_rects;
        let mut pts_frame = None;
        if let Some(bd) = &bands[k] {
            // Zarge von dieser Seite: Spiegel/Bekleidung über die Rohbaukante hinaus, lichte Kante.
            let (w, h) = (hypot2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]).max(1e-6), hypot2(pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]).max(1e-6));
            let r = |a0: f64, a1: f64, z1: f64| [map_quad(&pts, a0, 0.0), map_quad(&pts, a1, 0.0), map_quad(&pts, a1, z1), map_quad(&pts, a0, z1)];
            if bd.outer > 1e-4 {
                pts_frame = Some(r(-bd.outer / w, 1.0 + bd.outer / w, 1.0 + bd.outer / h));
                // Rohbaukante unter dem Spiegel/der Bekleidung.
                sash_rects.push(r(0.0, 1.0, 1.0));
            }
            if bd.clear > 1e-4 && bd.clear < bd.leaf - 1e-4 {
                sash_rects.push(r(bd.clear / w, 1.0 - bd.clear / w, 1.0 - bd.clear / h));
            }
        }
        out.push(ProjOpening { pts, depth, glass, door_leaf, divisions, sash_rects, sill, symbol, id: ids[k].to_string(), shape, frame: pts_frame });
    }
    surface_openings(p, frame, &mut out);
    out
}

/// Dach-/Deckenfenster ([103]) in der Ansicht: Rahmen-Rechteck in der Dachfläche (6 cm über der
/// Eindeckung) und Glas, nur wenn die Fläche zum Betrachter zeigt.
pub(super) fn surface_openings(p: &Project, frame: &[f64; 9], out: &mut Vec<ProjOpening>) {
    let (fp, fnrm, fu) = ([frame[0], frame[1], frame[2]], [frame[3], frame[4], frame[5]], [frame[6], frame[7], frame[8]]);
    let proj = |q: [f64; 3]| -> (Pt, f64) {
        // Modell (x, y, z) → Ansichtswelt (x, Höhe, y).
        let w = [q[0] - fp[0], q[2] - fp[1], q[1] - fp[2]];
        ([w[0] * fu[0] + w[1] * fu[1] + w[2] * fu[2], q[2]], w[0] * fnrm[0] + w[1] * fnrm[1] + w[2] * fnrm[2])
    };
    for o in p.openings.as_deref().unwrap_or(&[]) {
        let Some(f) = crate::opening_shape::host_frame(p, o) else { continue };
        if (f.plane.is_none() && !f.dormer) || fnrm[0] * f.n[0] + fnrm[1] * f.n[2] + fnrm[2] * f.n[1] >= -1e-4 {
            continue;
        }
        let (w, h) = (o.width, o.height);
        let fw = crate::opening_shape::surface_frame_width(p, o);
        let quad = |inset: f64| -> ([Pt; 4], f64) {
            let c = [f.at(-w / 2.0 + inset, -h / 2.0 + inset, -0.06), f.at(w / 2.0 - inset, -h / 2.0 + inset, -0.06), f.at(w / 2.0 - inset, h / 2.0 - inset, -0.06), f.at(-w / 2.0 + inset, h / 2.0 - inset, -0.06)];
            let pr = c.map(proj);
            ([pr[0].0, pr[1].0, pr[2].0, pr[3].0], (pr[0].1 + pr[1].1 + pr[2].1 + pr[3].1) / 4.0)
        };
        let (pts, own) = quad(0.0);
        if own <= 1e-6 {
            continue;
        }
        // Painter: knapp vor der eigenen Dachfläche (deren Tiefe = Mittel ihrer Ecken wie `project_face`).
        let plane_depth = p.roofs.as_deref().and_then(|r| r.get(f.host)).and_then(|roof| {
            let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
            let pl = g.planes.get(f.plane?)?.clone();
            Some(pl.iter().map(|q| proj(*q).1).sum::<f64>() / pl.len() as f64)
        });
        let depth = plane_depth.map_or(own, |d| d.min(own));
        let glass = if o.kind == ElementKind::Window { vec![quad(fw).0] } else { Vec::new() };
        out.push(ProjOpening { pts, depth, glass, door_leaf: Vec::new(), divisions: Vec::new(), sash_rects: Vec::new(), sill: Vec::new(), symbol: Vec::new(), id: o.id.clone(), shape: None, frame: None });
    }
}
