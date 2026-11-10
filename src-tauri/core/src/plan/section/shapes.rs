//! Sonderformen im Schnitt: Wände an Formöffnungen ([G3]) samt ihrer Projektion, Schnittspur der Dächer,
//! Monolith-Vereinigung der Platten, Laufplatten gerader Betontreppen ([G1]) und Schnitt parallel zur
//! Wand durch die Leibungen ([106]). Aufgerufen von `compute_section()` (`mod.rs`).

use super::*;

/// `appendRoofSections`: Schnittspur der Dachflächen, je Schicht ein Band.
/// Formöffnungen ([G3]): Die Wand hat im Modell das Rechteck-Loch; an der Schnittstelle reicht die
/// Wand bis an den Umriss. Die geschnittenen Wandbänder über bzw. unter der Öffnung werden bis zur
/// lichten Höhe des Umrisses an dieser Stelle verlängert.
pub(super) fn shaped_wall_cuts(cuts: &mut [Cut], p: &Project, walls_r: &[RWall], base: (f64, f64), u: (f64, f64)) {
    let ul = hypot2(u.0, u.1);
    if !(ul > 1e-12) {
        return;
    }
    let u = (u.0 / ul, u.1 / ul);
    for o in p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| crate::opening_shape::is_shaped(o)) {
        let Some(host) = p.walls.iter().find(|w| w.id == o.host_wall_id) else { continue };
        // Bogenwand ([T2]): Umriss auf der Sehne zwischen den Laibungen.
        let chord = arc_chord_opening(host, o);
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (host, o),
        };
        let Some((from, to)) = opening_interval(wall, o) else { continue };
        let (a, _) = axis_frame(wall);
        let den = a.0 * u.1 - a.1 * u.0;
        if den.abs() < MIN_CROSS {
            continue;
        }
        let (rx, ry) = (base.0 - wall.start.x, base.1 - wall.start.y);
        let along = (rx * u.1 - ry * u.0) / den;
        // [171] Auch genau am Rand des Rechtecks (Sehne fast 0): sonst bliebe dort das Rechteck-Loch ohne Fenster.
        if along < from - 1e-4 || along > to + 1e-4 {
            continue;
        }
        let along = along.clamp(from, to);
        let (zb, zt) = opening_extent(p, wall, o);
        let Some(poly) = crate::opening_shape::opening_outline(o, to - from, zt - zb) else { continue };
        let Some((lo, hi)) = crate::opening_shape::v_range(&poly, along - from) else { continue };
        let (new_bottom, new_top) = (zb + lo, zb + hi);
        const TOL: f64 = 2e-3;
        for c in cuts.iter_mut().filter(|c| c.kind == Kind::Wall && walls_r.get(c.index).is_some_and(|w| w.wall_id == wall.id)) {
            let (y_lo, y_hi) = c.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), q| (l.min(q[1]), h.max(q[1])));
            let (from_y, to_y) = if (y_lo - zt).abs() < TOL && new_top < zt - 1e-6 {
                (zt, new_top)
            } else if (y_hi - zb).abs() < TOL && new_bottom > zb + 1e-6 {
                (zb, new_bottom)
            } else {
                continue;
            };
            for q in c.pts.iter_mut().filter(|q| (q[1] - from_y).abs() < TOL) {
                q[1] = to_y;
            }
        }
    }
}

/// Neigung (Grad) der längsten Kante eines Schnitt-Rings, auf −90…90 gefaltet.
fn ring_slope_deg(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    let mut best = (0.0, 0.0);
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = dx * dx + dy * dy;
        if l > best.0 {
            best = (l, if dx < 0.0 { atan2(-dy, -dx) } else { atan2(dy, dx) });
        }
    }
    best.1 * 180.0 / std::f64::consts::PI
}

/// Formöffnungen ([G3]) hinter der Schnittebene: die Wand trägt im Modell das Rechteck-Loch, die
/// Projektion zeigt aber den Umriss — Kanten der Wand im Loch-Rechteck fallen weg, der Umriss auf der
/// zugewandten Wandfläche kommt dazu.
pub(super) fn shaped_projection(visible: &mut Vec<Edge>, p: &Project, walls_r: &[RWall], plane: &Plane) {
    let (base, u) = (plane.base(), plane.u_model());
    let ul = hypot2(u.0, u.1);
    if !(ul > 1e-12) {
        return;
    }
    let u = (u.0 / ul, u.1 / ul);
    let nrm = (plane.normal[0], plane.normal[2]);
    for o in p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| crate::opening_shape::is_shaped(o)) {
        let Some(host) = p.walls.iter().find(|w| w.id == o.host_wall_id) else { continue };
        // Bogenwand ([T2]): Umriss auf der Sehne zwischen den Laibungen.
        let chord = arc_chord_opening(host, o);
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (host, o),
        };
        let owners: Vec<usize> = walls_r.iter().enumerate().filter(|(_, w)| w.wall_id == wall.id).map(|(i, _)| i).collect();
        if owners.is_empty() || !visible.iter().any(|e| e.kind == Kind::Wall && owners.contains(&e.index)) {
            continue;
        }
        let Some((from, to)) = opening_interval(wall, o) else { continue };
        let (a, n) = axis_frame(wall);
        if (a.0 * u.0 + a.1 * u.1).abs() < 0.05 {
            continue;
        }
        let (zb, zt) = opening_extent(p, wall, o);
        let Some(poly) = crate::opening_shape::opening_outline(o, to - from, zt - zb) else { continue };
        let total = sum_thickness(&p.wall_type_or_fallback(wall).layers);
        let ref_off = crate::joins::reference_offset(model3d::wall_reference(wall), total);
        let at = |s: f64, off: f64| (wall.start.x + a.0 * s + n.0 * off, wall.start.y + a.1 * s + n.1 * off);
        let uu = |q: (f64, f64)| (q.0 - base.0) * u.0 + (q.1 - base.1) * u.1;
        let depth = |q: (f64, f64)| (q.0 - base.0) * nrm.0 + (q.1 - base.1) * nrm.1;
        let faces = [ref_off - total / 2.0, ref_off + total / 2.0];
        let us: Vec<f64> = faces.iter().flat_map(|&f| [uu(at(from, f)), uu(at(to, f))]).collect();
        let (u_lo, u_hi) = us.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &x| (l.min(x), h.max(x)));
        const TOL: f64 = 1e-3;
        let inside = |q: [f64; 2]| q[0] >= u_lo - TOL && q[0] <= u_hi + TOL && q[1] >= zb - TOL && q[1] <= zt + TOL;
        visible.retain(|e| !(e.kind == Kind::Wall && owners.contains(&e.index) && inside(e.a) && inside(e.b)));
        // Senkrechte Stösse der Wandstücke neben dem Loch: der Teil auf Öffnungshöhe entfällt (dort
        // liegt der Umriss bzw. die durchgehende Wand).
        let mut split: Vec<Edge> = Vec::new();
        for e in visible.iter_mut().filter(|e| e.kind == Kind::Wall && owners.contains(&e.index) && (e.a[0] - e.b[0]).abs() < TOL && e.a[0] >= u_lo - TOL && e.a[0] <= u_hi + TOL) {
            let (lo, hi) = (e.a[1].min(e.b[1]), e.a[1].max(e.b[1]));
            if hi <= zb + TOL || lo >= zt - TOL {
                continue;
            }
            let x = e.a[0];
            if hi > zt + TOL {
                split.push(Edge { kind: e.kind, index: e.index, a: [x, zt], b: [x, hi], stair: e.stair });
            }
            // Rest unten (oder leer: Länge 0 wird unten entfernt).
            (e.a, e.b) = ([x, lo], [x, lo.max(zb.min(hi))]);
        }
        visible.retain(|e| (e.a[0] - e.b[0]).abs() + (e.a[1] - e.b[1]).abs() > 1e-9);
        visible.extend(split);
        // Zugewandte Fläche: kleinere Tiefe hinter der Ebene.
        let mid = (from + to) / 2.0;
        let near = if depth(at(mid, faces[0])) <= depth(at(mid, faces[1])) { faces[0] } else { faces[1] };
        let pts: Vec<[f64; 2]> = poly.iter().map(|q| [uu(at(from + q[0], near)), zb + q[1]]).collect();
        for i in 0..pts.len() {
            visible.push(Edge { kind: Kind::Wall, index: owners[0], a: pts[i], b: pts[(i + 1) % pts.len()], stair: StairPart::None });
        }
    }
}

pub(super) fn append_roof_sections(cuts: &mut Vec<Cut>, p: &Project, plane: &Plane) {
    let roofs = p.roofs.as_deref().unwrap_or(&[]);
    if roofs.is_empty() {
        return;
    }
    let (bx, by) = plane.base();
    let (ux, uy) = plane.u_model();
    let nb = crate::roof_assembly::neighbors_rc(p);
    for (index, roof) in roofs.iter().enumerate() {
        // Verschnittene Dächer und Gauben ([G5]): Schnitt durch die Körper je Schicht.
        if let Some(solids) = crate::roof_assembly::roof_solids_with(p, index, &nb) {
            let rl = p.roof_layers(roof);
            for part in &solids.parts {
                let li = rl.iter().position(|l| !part.component_id.is_empty() && l.component_id == part.component_id);
                let rings = crate::roof_assembly::section_rings(&part.mesh, (bx, by), (ux, uy));
                if rings.is_empty() {
                    continue;
                }
                let wall = part.role == crate::roof_assembly::Role::DormerWall;
                for pts in rings {
                    // Muster der Dachschichten entlang der Neigung (Richtung der längsten Kante).
                    let slope = if wall { None } else { Some(ring_slope_deg(&pts)) };
                    let hatch = if part.component_id.is_empty() { None } else { p.component(&part.component_id).and_then(|comp| resolve_hatch(p, &comp.hatch_id, slope, None, None)) };
                    let mut c = Cut::new(Kind::Roof, index, pts);
                    c.layer_index = li;
                    if let Some(h) = &hatch {
                        c.fill = Some(poche_fill(h.pattern).to_string());
                        c.hatch = Some(h.clone());
                    }
                    cuts.push(c);
                }
            }
            continue;
        }
        let eaves = p.roof_base_elevation(roof);
        let geo = crate::roof::roof_geometry(&roof.params(), eaves);
        let layers = p.roof_layers(roof);
        let total = layers.iter().fold(0.0, |s, l| s + max(0.0, l.thickness));
        if total <= 1e-9 {
            continue;
        }
        let mut pl: Vec<f64> = vec![geo.planes.len() as f64];
        for plane in &geo.planes {
            pl.push(plane.len() as f64);
            for q in plane {
                pl.extend([q[0], q[1], q[2]]);
            }
        }
        let sg = crate::plan::section_bands::roof_segments(bx, by, ux, uy, &pl);
        // Dachfenster ([103]): Lochkörper in der Schnittebene, aus jeder Schicht ausgeschnitten.
        let holes: Vec<Vec<[f64; 2]>> = crate::opening_shape::roof_openings(p, index)
            .iter()
            .filter_map(|(o, f)| crate::opening_shape::box_section(&crate::opening_shape::surface_hole_box(o, f), (bx, by), (ux, uy)))
            .collect();
        let n = sg.first().copied().unwrap_or(0.0) as usize;
        for k in 0..n {
            let o = 1 + 5 * k;
            let (t_lo, t_hi, z0, z1, cos_t) = (sg[o], sg[o + 1], sg[o + 2], sg[o + 3], sg[o + 4]);
            let mut prefix = 0.0;
            for (li, layer) in layers.iter().enumerate() {
                let t = max(0.0, layer.thickness);
                if t <= 1e-9 {
                    continue;
                }
                let vt = t / max(cos_t, 1e-6);
                let top0 = z0 - prefix;
                let top1 = z1 - prefix;
                prefix += vt;
                let mut pieces = vec![vec![[t_lo, top0], [t_hi, top1], [t_hi, top1 - vt], [t_lo, top0 - vt]]];
                for h in &holes {
                    pieces = pieces.iter().flat_map(|pc| crate::opening_shape::subtract_convex(pc, h)).collect();
                }
                // Wandbezogene Muster laufen entlang der Dachneigung ([109]: Dämmschlange über die Schichtdicke).
                let slope_deg = atan2(z1 - z0, t_hi - t_lo) * 180.0 / std::f64::consts::PI;
                let hatch = if layer.component_id.is_empty() { None } else { p.component(&layer.component_id).and_then(|comp| resolve_hatch(p, &comp.hatch_id, Some(slope_deg), None, None)) };
                for pts in pieces {
                    let mut c = Cut::new(Kind::Roof, index, pts);
                    c.layer_index = Some(li);
                    if let Some(h) = &hatch {
                        c.fill = Some(poche_fill(h.pattern).to_string());
                        c.hatch = Some(h.clone());
                    }
                    cuts.push(c);
                }
            }
        }
    }
}

// ── Monolith, Abzugskörper, Körper, Gelände, Tiefe ───────────────────────────

/// `unionRectOutlines` (Rechnung: `plan::section_bands::union_outlines`).
pub(super) fn union_rect_outlines(rects: &[[f64; 4]]) -> Vec<Vec<[f64; 2]>> {
    let mut b = vec![rects.len() as f64];
    for r in rects {
        b.extend(r);
    }
    let f = crate::plan::section_bands::union_outlines(&b);
    let mut rings = Vec::new();
    let mut i = 1;
    for _ in 0..f.first().copied().unwrap_or(0.0) as usize {
        let count = f[i] as usize;
        i += 1;
        rings.push((0..count).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect());
        i += 2 * count;
    }
    rings
}

/// `mergeMonolithCuts`.
pub(super) fn merge_monolith_cuts(cuts: Vec<Cut>, slabs: &[RSlab], exact: &HashMap<String, Vec<Vec<[f64; 2]>>>) -> Vec<Cut> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Cut>> = HashMap::new();
    let mut out = Vec::new();
    for cp in cuts {
        let g = if cp.kind == Kind::Slab { slabs.get(cp.index).and_then(|s| s.monolith.clone()).filter(|g| !g.is_empty()) } else { None };
        match g {
            None => out.push(cp),
            Some(g) => {
                if !groups.contains_key(&g) {
                    order.push(g.clone());
                }
                groups.entry(g).or_default().push(cp);
            }
        }
    }
    for g in order {
        let list = groups.remove(&g).unwrap_or_default();
        // [G1] Exakte Fläche (gerade Betontreppe: Untersicht als Gerade statt Scheiben-Sägezahn).
        if let Some(rings) = exact.get(&g).filter(|r| !r.is_empty() && !list.is_empty()) {
            for ring in rings {
                out.push(Cut { pts: ring.clone(), nse: None, ..list[0].clone() });
            }
            continue;
        }
        if list.len() == 1 {
            out.extend(list);
            continue;
        }
        let rects: Vec<[f64; 4]> = list.iter().filter_map(rect_of_band).collect();
        if rects.len() != list.len() {
            out.extend(list);
            continue;
        }
        for ring in union_rect_outlines(&rects) {
            out.push(Cut { pts: ring, ..list[0].clone() });
        }
    }
    out
}

/// [G1] Schnittflächen der Laufplatten gerader Betontreppen (je Treppen-ID vereinigt, Löcher als
/// Schlüsselloch) aus ihren Netzen mit exakter Untersicht.
pub(super) fn stair_flight_sections(p: &Project, base: (f64, f64), u: (f64, f64)) -> HashMap<String, Vec<Vec<[f64; 2]>>> {
    let stairs = p.stairs.as_deref().unwrap_or(&[]);
    let mut polys: HashMap<String, Vec<crate::flat::Polygon>> = HashMap::new();
    for (si, m) in model3d::stair_flight_meshes(p) {
        let Some(st) = stairs.get(si) else { continue };
        let idx: Vec<f64> = m.indices.iter().map(|&i| i as f64).collect();
        let (rings, _) = cut_mesh(&m.positions, &idx, base, u);
        polys.entry(st.id.clone()).or_default().extend(rings_to_polygons(&rings));
    }
    // [151] Podestplatten derselben Treppen gehören zur exakten Fläche (sonst ersetzt die Laufplatte sie).
    let with_flights: std::collections::HashSet<String> = polys.keys().cloned().collect();
    for s in model3d::emit_stairs(p, false) {
        if !with_flights.contains(&s.ceiling_id) || s.monolith.is_none() {
            continue;
        }
        let m = crate::solid_bool::Mesh::prism(&s.outline, s.z_bottom, s.z_top);
        let idx: Vec<f64> = m.indices.iter().map(|&i| i as f64).collect();
        let (rings, _) = cut_mesh(&m.positions, &idx, base, u);
        polys.entry(s.ceiling_id.clone()).or_default().extend(rings_to_polygons(&rings));
    }
    polys
        .into_iter()
        .map(|(id, list)| {
            let rings = crate::polygon_bool::union(&list).into_iter().map(|poly| if poly.len() > 1 { keyhole(&poly).0 } else { poly.into_iter().next().unwrap_or_default() }).map(drop_collinear).filter(|r| r.len() >= 3).collect();
            (id, rings)
        })
        .collect()
}

/// Ecken ohne Knick weglassen (Tritt-Fugen auf der Untersicht).
fn drop_collinear(r: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    let n = r.len();
    if n < 4 {
        return r;
    }
    let keep = |i: usize| {
        let (a, b, c) = (r[(i + n - 1) % n], r[i], r[(i + 1) % n]);
        let (ux, uy, vx, vy) = (b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
        let l = hypot2(ux, uy) * hypot2(vx, vy);
        !(l > 0.0) || (ux * vy - uy * vx).abs() > 1e-6 * l || ux * vx + uy * vy < 0.0
    };
    (0..n).filter(|&i| keep(i)).map(|i| r[i]).collect()
}

pub(super) fn is_void_solid(s: &ExtrudedSolid) -> bool {
    s.operation.as_deref() == Some("subtract") && s.brep.is_none() && s.taper.unwrap_or(0.0) < 1e-6 && s.points.len() >= 3 && s.height > 0.0
}

/// [106] Schnitt parallel zur Wand durch die Leibungen: Die geschnittene Schicht springt an den
/// Öffnungen um ihren Rücksprung zurück (Loch geweitet), ihre Zusatzstücke (Leibungsdämmung, Putz,
/// Überdämmung), die die Schnittebene quert, kommen als Schnittfläche im Stil der Schicht dazu.
pub(super) fn parallel_reveal_cuts(mut cuts: Vec<Cut>, p: &Project, plane: &Plane, walls: &[Option<&Wall>]) -> Result<Vec<Cut>, String> {
    use crate::opening_detail::SIDES;
    let (base, u_raw) = (plane.base(), plane.u_model());
    let l = hypot2(u_raw.0, u_raw.1);
    if !(l > 1e-12) {
        return Ok(cuts);
    }
    let u = (u_raw.0 / l, u_raw.1 / l);
    let mut seen: Vec<&str> = Vec::new();
    for w in walls.iter().flatten() {
        if seen.contains(&w.id.as_str()) {
            continue;
        }
        seen.push(&w.id);
        // Bogenwand: Ebene parallel zur gekrümmten Wand gibt es nicht (nur Sehnen-Teilwände).
        if crate::wall_arc::is_arc_bulge(w.bulge) {
            continue;
        }
        let (a, n) = axis_frame(w);
        let (un, ua) = (u.0 * n.0 + u.1 * n.1, u.0 * a.0 + u.1 * a.1);
        if un.abs() > 0.05 || ua.abs() < 0.5 {
            continue;
        }
        let Some(wt) = p.wall_type(w) else { continue };
        let total = sum_thickness(&wt.layers);
        let ref_off = crate::joins::reference_offset(model3d::wall_reference(w), total);
        let rel = (base.0 - w.start.x, base.1 - w.start.y);
        let d = rel.0 * n.0 + rel.1 * n.1 - (ref_off - total / 2.0);
        if d <= 1e-6 || d >= total - 1e-6 {
            continue;
        }
        let mut acc = 0.0;
        let Some(li) = wt.layers.iter().position(|ly| {
            acc += ly.thickness;
            d < acc
        }) else {
            continue;
        };
        let a0 = rel.0 * a.0 + rel.1 * a.1;
        let u_of = |s: f64| (s - a0) / ua;
        let owners: Vec<usize> = walls.iter().enumerate().filter(|(_, x)| x.is_some_and(|x| x.id == w.id)).map(|(i, _)| i).collect();
        let mut voids: Vec<Vec<[f64; 2]>> = Vec::new();
        let mut pieces: Vec<Vec<[f64; 2]>> = Vec::new();
        let rect = |s0: f64, s1: f64, z0: f64, z1: f64| {
            let (ua, ub) = (u_of(s0).min(u_of(s1)), u_of(s0).max(u_of(s1)));
            vec![[ua, z0], [ub, z0], [ub, z1], [ua, z1]]
        };
        for o in p.openings_of_wall(&w.id) {
            let Some(r) = crate::opening_detail::opening_reveal(p, w, o) else { continue };
            let (zb, zt) = opening_extent(p, w, o);
            // Rücksprung je Seite dieser Schicht; die seitlichen reichen in die Ecken oben/unten.
            let sh: Vec<f64> = (0..4).map(|k| r.sides[k].iter().filter(|x| x.layer == li).map(|x| x.shift).fold(0.0, f64::max)).collect();
            for (k, side) in SIDES.iter().enumerate() {
                for adj in r.sides[k].iter().filter(|x| x.layer == li) {
                    let s = adj.shift;
                    if s > 1e-6 {
                        voids.push(match side {
                            crate::opening_detail::Side::Left => rect(r.from - s, r.from, zb - sh[3], zt + sh[2]),
                            crate::opening_detail::Side::Right => rect(r.to, r.to + s, zb - sh[3], zt + sh[2]),
                            crate::opening_detail::Side::Top => rect(r.from, r.to, zt, zt + s),
                            crate::opening_detail::Side::Bottom => rect(r.from, r.to, zb - s, zb),
                        });
                    }
                    for pc in adj.pieces.iter().filter(|pc| d >= pc[2] - 1e-9 && d <= pc[3] + 1e-9 && pc[1] - pc[0] > 1e-6) {
                        pieces.push(match side {
                            crate::opening_detail::Side::Left => rect(r.from + pc[0], r.from + pc[1], zb, zt),
                            crate::opening_detail::Side::Right => rect(r.to - pc[1], r.to - pc[0], zb, zt),
                            crate::opening_detail::Side::Top => rect(r.from, r.to, zt - pc[1], zt - pc[0]),
                            crate::opening_detail::Side::Bottom => rect(r.from, r.to, zb + pc[0], zb + pc[1]),
                        });
                    }
                }
            }
        }
        if voids.is_empty() && pieces.is_empty() {
            continue;
        }
        if !voids.is_empty() {
            let refs: Vec<&[[f64; 2]]> = voids.iter().map(|r| r.as_slice()).collect();
            let cutters = encode_rings(&refs);
            let mut out = Vec::with_capacity(cuts.len());
            for cp in cuts {
                if cp.kind != Kind::Wall || !owners.contains(&cp.index) || cp.pts.len() < 3 {
                    out.push(cp);
                    continue;
                }
                let ring = &encode_rings(&[cp.pts.as_slice()])[1..];
                let f = crate::voids::subtract_rings_flat(ring, &cutters, &[0.0]);
                if f.is_empty() || f[0] < 0.0 {
                    out.push(cp);
                    continue;
                }
                let mut i = 1;
                for _ in 0..f[0] as usize {
                    let k = f[i] as usize;
                    i += 1;
                    let pts: Vec<[f64; 2]> = (0..k).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect();
                    i += 2 * k;
                    let m = f[i] as usize;
                    i += 1 + m;
                    out.push(Cut { pts, nse: None, ..cp.clone() });
                }
            }
            cuts = out;
        }
        let Some(&idx) = owners.first() else { continue };
        let layer = &wt.layers[li];
        let comp = p.component_or_fallback(&layer.component_id);
        let category = p.layer_category(&w.category_code);
        let (fill, hatch) = layer_style(p, comp, w.hatch_id.as_deref(), w.hatch_source, w.foreground.as_deref(), w.foreground_source, w.background.as_deref(), w.background_source, category, SECTION_WALL_AXIS_ANGLE_DEG)?;
        for pts in pieces {
            let mut c = Cut::new(Kind::Wall, idx, pts);
            c.fill = Some(fill.clone());
            c.hatch = Some(hatch.clone());
            c.join_priority = Some(comp.join_priority);
            c.component_id = Some(comp.id.clone());
            c.source_id = Some(w.id.clone());
            c.category = Some(w.category_code.clone());
            c.layer_index = Some(li);
            cuts.push(c);
        }
    }
    Ok(cuts)
}
