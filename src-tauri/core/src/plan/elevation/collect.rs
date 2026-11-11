//! Flächen aus dem Modell einsammeln: Ansichtsrahmen (`frame_of()`), Projektion der Wand-, Decken- und
//! Dachkörper (`project_faces()`), Stützen, Netze, Dächer und die Eck-Verlängerung der Wände. Gerufen von
//! `elevation_primitives_with()` in `mod.rs`.

use super::*;

/// `elevationFrame` flach: `[P, N, U]`.
pub(super) fn frame_of(plane: &super::super::section::Plane) -> [f64; 9] {
    let [nx, ny, nz] = plane.normal;
    let l = hypot(&[nx, ny, nz]);
    let n_len = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let ux = nz / n_len;
    let uz = -nx / n_len;
    let l = hypot2(ux, uz);
    let u_len = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let p = plane.point;
    [p[0], p[1], p[2], nx / n_len, ny / n_len, nz / n_len, ux / u_len, 0.0, uz / u_len]
}

pub(super) struct RoofIn {
    pub(super) id: String,
    pub(super) fill: [f64; 3],
    pub(super) planes: Vec<Vec<[f64; 3]>>,
    gables: Vec<Vec<[f64; 3]>>,
}

/// `projectFaces`.
pub(super) fn project_faces(frame: &[f64; 9], walls: &[RWall], slabs: &[RSlab], roofs: &[RoofIn]) -> Vec<Face> {
    let mut w = vec![walls.len() as f64];
    // Mit Schnittlinien (Bogen-Teilkörper, [T2]): die Ecken liegen auf der Gehrung statt rechtwinklig.
    let planes = walls.iter().any(|x| x.top_plane.is_some());
    let cut = planes || walls.iter().any(|x| x.start_cut.is_some() || x.end_cut.is_some() || x.joint != [false; 2]);
    for x in walls {
        w.extend([x.start[0], x.start[1], x.end[0], x.end[1], x.thickness, x.height, x.base_elevation]);
        if cut {
            w.extend(corner_shifts(x));
            w.extend([if x.joint[0] { 1.0 } else { 0.0 }, if x.joint[1] { 1.0 } else { 0.0 }]);
        }
        // Ebene Oberkante unter einem Dach ([G2]).
        if planes {
            match x.top_plane {
                Some(c) => w.extend([1.0, c[0], c[1], c[2]]),
                None => w.extend([0.0; 4]),
            }
        }
    }
    let mut sl = vec![slabs.len() as f64];
    for x in slabs {
        sl.extend([x.z_bottom, x.z_top, x.outline.len() as f64]);
        for q in &x.outline {
            sl.extend(q);
        }
    }
    let mut r = vec![roofs.len() as f64];
    for roof in roofs {
        r.extend([roof.planes.len() as f64, roof.gables.len() as f64]);
        for poly in roof.planes.iter().chain(&roof.gables) {
            r.push(poly.len() as f64);
            for q in poly {
                r.extend(q);
            }
        }
    }
    let mut out = Vec::new();
    for f in crate::plan::elevation_geom::faces_full(frame, &w, &sl, &r).unwrap_or_default() {
        let role = match f.role {
            0 => Role::Wall,
            1 => Role::Slab,
            _ => Role::Roof,
        };
        let (id, fill) = match role {
            Role::Wall => (walls[f.src].wall_id.clone(), walls[f.src].color),
            Role::Slab | Role::Column | Role::Mesh | Role::Body => (slabs[f.src].ceiling_id.clone(), slabs[f.src].color),
            Role::Roof => (roofs[f.src].id.clone(), roofs[f.src].fill),
        };
        let pts = f.pts.iter().map(|q| [q.0, q.1]).collect();
        out.push(Face { pts, pd: f.pd, depth: f.depth, depth_min: f.depth_min, depth_max: f.depth_max, role, id, fill, normal: f.normal, ov: None, two_sided: false, curved_slab: false });
    }
    out
}

/// Verschiebung der vier Wandecken längs der Achse bis auf die Schnittlinien (Anfang +n, Anfang −n,
/// Ende +n, Ende −n; +n = rechte Normale wie in `plan::elevation_geom::wall_faces`).
fn corner_shifts(x: &RWall) -> [f64; 4] {
    let (dx, dy) = (x.end[0] - x.start[0], x.end[1] - x.start[1]);
    let l = hypot2(dx, dy);
    if l < 1e-9 {
        return [0.0; 4];
    }
    let (ax, ay) = (dx / l, dy / l);
    let (nx, ny) = (ay, -ax);
    let ht = x.thickness / 2.0;
    let shift = |base: [f64; 2], t: f64, cut: Option<[f64; 4]>| -> f64 {
        let Some([cx, cy, ux, uy]) = cut else { return 0.0 };
        let (qx, qy) = (base[0] + nx * t, base[1] + ny * t);
        let den = ax * uy - ay * ux;
        if den.abs() < 1e-12 {
            return 0.0;
        }
        let lam = ((cx - qx) * uy - (cy - qy) * ux) / den;
        if lam.is_finite() && lam.abs() < l {
            lam
        } else {
            0.0
        }
    };
    [shift(x.start, ht, x.start_cut), shift(x.start, -ht, x.start_cut), shift(x.end, ht, x.end_cut), shift(x.end, -ht, x.end_cut)]
}

/// Stützen ([132]) als lotrechte Prismen aus dem Querschnitt (wie im 3D, `model3d::emit_columns`).
pub(super) fn collect_column_faces(p: &Project, frame: &[f64; 9]) -> Vec<Face> {
    // [141] Von einer prioritäreren Wand beschnitten: je Höhenabschnitt der Rest-Querschnitt (wie im 3D).
    let slabs = model3d::column_slabs(p);
    let mut faces = project_faces(frame, &[], &slabs, &[]);
    for f in &mut faces {
        f.role = Role::Column;
    }
    faces
}

/// [152] Importierte Netze als Dreiecksflächen vor der Ansichtsebene (Hüllbox vorgefiltert): geschlossene
/// Netze nur die zugewandten Dreiecke, offene beidseitig (Normale zum Betrachter). Farbe aus dem Import,
/// sonst Kontext-Grau wie im 3D.
pub(super) fn collect_mesh_faces(p: &Project, frame: &[f64; 9]) -> Vec<Face> {
    let mut out = Vec::new();
    for m in crate::mesh_view::meshes(p) {
        let fill = m.mesh.color.as_deref().map_or(IMPORTED_RGB, |c| hex_to_rgb(c, IMPORTED_RGB));
        mesh_faces(frame, &m.mesh.positions, &m.info, Role::Mesh, &m.mesh.id, fill, &mut out);
    }
    out
}

/// [115] Freie Körper (`extrudedSolids`, Netze aus dem Kern, `solid_mesh.rs`) wie importierte Netze; Abzugskörper
/// sind kein Material und fehlen.
pub(super) fn collect_body_faces(p: &Project, frame: &[f64; 9]) -> Vec<Face> {
    let solids = p.extruded_solids.as_deref().unwrap_or(&[]);
    let mut out = Vec::new();
    for b in crate::solid_mesh::body_meshes(p) {
        let Some(s) = solids.get(b.index).filter(|s| s.operation.as_deref() != Some("subtract")) else { continue };
        let Some(info) = crate::mesh_view::analyze(&b.positions, &b.indices) else { continue };
        mesh_faces(frame, &b.positions, &info, Role::Body, &s.id, BODY_RGB, &mut out);
    }
    out
}

/// Zugewandte Dreiecke eines Netzes (Modell [x, y, z]) als Ansichtsflächen, je Ebene vereinigt.
fn mesh_faces(frame: &[f64; 9], pos: &[f64], info: &crate::mesh_view::MeshInfo, role: Role, id: &str, fill: [f64; 3], out: &mut Vec<Face>) {
    let (o, n, u) = ([frame[0], frame[1], frame[2]], [frame[3], frame[4], frame[5]], [frame[6], frame[7], frame[8]]);
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    // Modell [x, y, z] → Welt [x, Höhe, y].
    let world = |q: [f64; 3]| [q[0], q[2], q[1]];
    let b = &info.bbox;
    // Tiefe der Hüllbox: ganz vor der Ebene (Tiefe ≤ 0) entfällt.
    let far = [(b[0], b[1]), (b[3], b[1]), (b[0], b[4]), (b[3], b[4])].iter().map(|&(x, y)| dot([x - o[0], 0.0, y - o[2]], n)).fold(f64::NEG_INFINITY, f64::max);
    if !(far > EPS) {
        return;
    }
    let pt = |i: u32| world([pos[3 * i as usize], pos[3 * i as usize + 1], pos[3 * i as usize + 2]]);
    // Zugewandte Dreiecke derselben Ebene werden zu Polygonen vereinigt (weniger Flächen für Maler und
    // Sichtbarkeit; Wände und Platten aus zwei bis wenigen Dreiecken werden eine Fläche).
    let mut groups: Vec<((i64, i64, i64, i64), Vec<Face>)> = Vec::new();
    let mut slot: HashMap<(i64, i64, i64, i64), usize> = HashMap::new();
    for t in &info.tris {
        let w = [pt(t[0]), pt(t[1]), pt(t[2])];
        let (e1, e2) = ([w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]], [w[2][0] - w[0][0], w[2][1] - w[0][1], w[2][2] - w[0][2]]);
        // Achsentausch spiegelt: Kreuzprodukt umkehren, damit die Normale aussen bleibt.
        let c = [-(e1[1] * e2[2] - e1[2] * e2[1]), -(e1[2] * e2[0] - e1[0] * e2[2]), -(e1[0] * e2[1] - e1[1] * e2[0])];
        let l = hypot(&c);
        if !(l > 1e-15) {
            continue;
        }
        let mut normal = [c[0] / l, c[1] / l, c[2] / l];
        if info.flip {
            normal = [-normal[0], -normal[1], -normal[2]];
        }
        let facing = dot(n, normal);
        if info.closed && facing >= -1e-9 {
            continue;
        }
        if !info.closed && facing > 0.0 {
            normal = [-normal[0], -normal[1], -normal[2]];
        }
        let mut pts = Vec::with_capacity(3);
        let mut pd = Vec::with_capacity(3);
        for q in w {
            let r = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
            pts.push([dot(r, u), q[1]]);
            pd.push(dot(r, n));
        }
        let depth = (pd[0] + pd[1] + pd[2]) / 3.0;
        if depth <= EPS {
            continue;
        }
        let (dmin, dmax) = (pd.iter().copied().fold(f64::INFINITY, f64::min), pd.iter().copied().fold(f64::NEG_INFINITY, f64::max));
        let key = ((normal[0] * 1e4).round() as i64, (normal[1] * 1e4).round() as i64, (normal[2] * 1e4).round() as i64, (dot(normal, w[0]) * 1e3).round() as i64);
        let k = *slot.entry(key).or_insert_with(|| {
            groups.push((key, Vec::new()));
            groups.len() - 1
        });
        groups[k].1.push(Face { pts, pd, depth, depth_min: dmin, depth_max: dmax, role, id: id.to_string(), fill, normal, ov: None, two_sided: !info.closed, curved_slab: false });
    }
    for (_, tris) in groups {
        merge_coplanar(tris, out);
    }
}

/// `collectRoofFaces`.
pub(super) fn collect_roof_faces(p: &Project, frame: &[f64; 9], walls: &[RWall]) -> Result<Vec<Face>, String> {
    // Giebeldreiecke nur ohne Wand darunter ([G2]): sonst zeigt die Ansicht die Giebelwand selbst.
    let reached: std::collections::HashSet<&str> = walls.iter().filter(|w| w.top_plane.is_some()).map(|w| w.wall_id.as_str()).collect();
    let floors: std::collections::HashSet<&str> = p.walls.iter().filter(|w| reached.contains(w.id.as_str())).map(|w| w.floor_id.as_str()).collect();
    let mut roofs = Vec::new();
    let all = p.roofs.as_deref().unwrap_or(&[]);
    let nb = crate::roof_assembly::neighbors_rc(p);
    // Geometrie und Grundriss-Ausdehnung je Dach einmal (die Stirnen-Prüfung fragt alle anderen Dächer).
    let geos: Vec<crate::roof::RoofGeometry> = all.iter().map(|r| crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r))).collect();
    let boxes: Vec<[f64; 4]> = geos
        .iter()
        .map(|g| g.planes.iter().flatten().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]))
        .collect();
    for (ri, roof) in all.iter().enumerate() {
        let g = &geos[ri];
        let layers = p.roof_layers(roof);
        let outer = layers.first();
        let fill = match roof.color.as_deref().filter(|c| !c.is_empty()) {
            Some(c) => hex_to_rgb(c, ROOF_RGB_FALLBACK),
            None => match outer.filter(|l| !l.component_id.is_empty()) {
                // Hängendes Bauteil (Datei/Import): Dach-Vorgabefarbe.
                Some(l) => p.component(&l.component_id).map_or(ROOF_RGB_FALLBACK, |c| hex_to_rgb(&c.color, ROOF_RGB_FALLBACK)),
                None => ROOF_RGB_FALLBACK,
            },
        };
        // Verschnittene Dächer und Gauben ([G5]): sichtbare Dreiecke der Aussenhaut, Gaubenwände in
        // ihrer Bauteilfarbe.
        if let Some(solids) = crate::roof_assembly::roof_solids_with(p, ri, &nb) {
            let fn_ = [frame[3], frame[4], frame[5]];
            // Zugewandte Dreiecke (Ansichtswelt x, Höhe, y wie `surface_openings`).
            let front = |m: &crate::solid_bool::Mesh| -> Vec<usize> {
                (0..m.indices.len() / 3)
                    .filter(|&ti| {
                        let q = |i: u32| {
                            let j = i as usize * 3;
                            [m.positions[j], m.positions[j + 1], m.positions[j + 2]]
                        };
                        let t = &m.indices[ti * 3..ti * 3 + 3];
                        let tri = [q(t[0]), q(t[1]), q(t[2])];
                        let n = crate::opening_shape::cross([tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]], [tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]]);
                        fn_[0] * n[0] + fn_[1] * n[2] + fn_[2] * n[1] < -1e-12
                    })
                    .collect()
            };
            // Wie die übrigen Dächer: Oberfläche der Eindeckung (Dach + Gaubendächer), dazu die Gaubenwände.
            // Wände reichen ans Dach ([G2]): Stirnflächen der Ränder, die nicht in einem anderen Dach stecken.
            let gables = {
                let total: f64 = p.roof_layers(roof).iter().map(|l| l.thickness.max(0.0)).sum();
                // Nur Dächer, deren Ausdehnung einen Stirn-Mittelpunkt enthalten kann (ausserhalb liegt
                // kein Punkt in einer ihrer Flächen).
                let others: Vec<&Vec<[f64; 3]>> = all
                    .iter()
                    .enumerate()
                    .filter(|(j, o)| o.id != roof.id && o.floor_id == roof.floor_id && !(boxes[*j][2] < boxes[ri][0] || boxes[*j][0] > boxes[ri][2] || boxes[*j][3] < boxes[ri][1] || boxes[*j][1] > boxes[ri][3]))
                    .flat_map(|(j, _)| &geos[j].planes)
                    .collect();
                let fascia = fascia_quads(&g.planes, total)
                    .into_iter()
                    .filter(|q| {
                        let (mx, my) = ((q[0][0] + q[1][0]) / 2.0, (q[0][1] + q[1][1]) / 2.0);
                        !others.iter().any(|o| crate::dormer::point_in_xy(mx, my, o))
                    })
                    .map(|q| q.to_vec());
                // Ohne Wände bis ans Dach zusätzlich die Giebeldreiecke ([132]: Stirnen immer).
                let parapet = crate::roof_parapet::parapet(roof, &g).map(|pp| crate::roof_parapet::view_faces(&pp)).unwrap_or_default();
                if floors.contains(roof.floor_id.as_str()) { fascia.chain(parapet).collect() } else { g.gables.iter().cloned().chain(fascia).chain(parapet).collect::<Vec<_>>() }
            };
            roofs.push(RoofIn { id: roof.id.clone(), fill, planes: crate::roof_assembly::planar_faces(&solids.top, &front(&solids.top)), gables });
            let wall_comp = solids.parts.iter().find(|pt| pt.role == crate::roof_assembly::Role::DormerWall && pt.layer == 0).and_then(|pt| p.component(&pt.component_id));
            let wf = wall_comp.map_or([0.85, 0.83, 0.8], |c| hex_to_rgb(&c.color, [0.85, 0.83, 0.8]));
            let wall_faces = crate::roof_assembly::planar_faces(&solids.walls, &front(&solids.walls));
            if !wall_faces.is_empty() {
                roofs.push(RoofIn { id: roof.id.clone(), fill: wf, planes: wall_faces, gables: Vec::new() });
            }
            continue;
        }
        // Wände reichen ans Dach: statt der Giebeldreiecke die Stirnflächen der Dachscheibe (Traufe, Ortgang).
        // Sonst Giebeldreiecke und Stirnen ([132]: ein Flachdach zeigt sonst gar nichts, die Fläche liegt
        // in der Ansicht auf der Kante).
        let total: f64 = p.roof_layers(roof).iter().map(|l| l.thickness.max(0.0)).sum();
        let fascia = fascia_quads(&g.planes, total).into_iter().map(|q| q.to_vec());
        let parapet = crate::roof_parapet::parapet(roof, &g).map(|pp| crate::roof_parapet::view_faces(&pp)).unwrap_or_default();
        let gables = if floors.contains(roof.floor_id.as_str()) { fascia.chain(parapet).collect() } else { g.gables.iter().cloned().chain(fascia).chain(parapet).collect() };
        roofs.push(RoofIn { id: roof.id.clone(), fill, planes: g.planes.clone(), gables });
    }
    Ok(project_faces(frame, &[], &[], &roofs))
}

/// `extendWallCornersForElevation`.
pub(super) fn extend_wall_corners(p: &Project, rwalls: &mut [RWall], u: (f64, f64)) {
    let mut floors: HashMap<&str, usize> = HashMap::new();
    let mut b = vec![p.walls.len() as f64];
    for w in &p.walls {
        let n = floors.len();
        let k = *floors.entry(w.floor_id.as_str()).or_insert(n);
        let thickness = p.wall_type(w).map_or(0.2, |t| t.layers.iter().fold(0.0, |s, l| s + l.thickness));
        b.extend([k as f64, w.start.x, w.start.y, w.end.x, w.end.y, thickness / 2.0]);
    }
    let ext = crate::plan::elevation_geom::wall_extensions(&b);
    if ext.is_empty() {
        return;
    }
    let mut by_wall: HashMap<&str, Vec<usize>> = HashMap::new();
    let ids: Vec<String> = rwalls.iter().map(|r| r.wall_id.clone()).collect();
    for (i, id) in ids.iter().enumerate() {
        by_wall.entry(id.as_str()).or_default().push(i);
    }
    // [171] Teilkörper einer Wand (unter dem Dach je Schichtlage quer versetzt) beginnen auf der Querlinie durch
    // den Wandanfang, nicht genau in ihm: alle verlängern, die dort liegen.
    let close = |a: [f64; 2], v: Vec2, ax: (f64, f64), ht: f64| {
        let (rx, ry) = (a[0] - v.x, a[1] - v.y);
        (rx * ax.0 + ry * ax.1).abs() < 1e-6 && (rx * -ax.1 + ry * ax.0).abs() <= ht + 1e-6
    };
    for (k, w) in p.walls.iter().enumerate() {
        let e_start = ext[1 + 2 * k];
        let e_end = ext[2 + 2 * k];
        if e_start <= EPS && e_end <= EPS {
            continue;
        }
        let Some(pieces) = by_wall.get(w.id.as_str()) else { continue };
        let (dx, dz) = (w.end.x - w.start.x, w.end.y - w.start.y);
        let len = hypot2(dx, dz);
        if len < 1e-9 {
            continue;
        }
        let (ux, uz) = (dx / len, dz / len);
        if (ux * u.0 + uz * u.1).abs() < 0.35 {
            continue;
        }
        let ht = p.wall_type(w).map_or(0.2, |t| t.layers.iter().fold(0.0, |s, l| s + l.thickness)) / 2.0;
        if e_start > EPS {
            // [141] Kollineare Stossfuge (`joint`): die Nachbarwand setzt fort, nicht verlängern.
            let hit: Vec<usize> = pieces.iter().copied().filter(|&i| close(rwalls[i].start, w.start, (ux, uz), ht) && !rwalls[i].joint[0]).collect();
            for i in hit {
                let s = rwalls[i].start;
                rwalls[i].start = [s[0] - ux * e_start, s[1] - uz * e_start];
                // Ebene Oberkante bezieht sich auf den Anfang ([G2]).
                if let Some(c) = rwalls[i].top_plane.as_mut() {
                    c[0] -= (c[1] * ux + c[2] * uz) * e_start;
                }
            }
        }
        if e_end > EPS {
            let hit: Vec<usize> = pieces.iter().copied().filter(|&i| close(rwalls[i].end, w.end, (ux, uz), ht) && !rwalls[i].joint[1]).collect();
            for i in hit {
                let e = rwalls[i].end;
                rwalls[i].end = [e[0] + ux * e_end, e[1] + uz * e_end];
            }
        }
    }
}
