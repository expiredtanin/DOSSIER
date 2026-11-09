//! Projektion hinter der Schnittebene: sichtbare und verdeckte Kanten mit exakter Sichtbarkeit (`hlr.rs`,
//! [G4]), begrenzt durch den Ansichtsbereich ([36]). Aufgerufen von `compute_section()` (`mod.rs`).

use super::*;

/// Ansichtsbereich ([36]): Flächen der Eigentümer weglassen, deren nächster Punkt (Tiefe `q[2]` hinter
/// der Ebene) weiter als `depth` liegt. Ein Bauteil zählt als Ganzes: was in den Bereich hineinragt,
/// bleibt vollständig.
fn drop_far_owners(faces: Vec<crate::hlr::Face>, owners: usize, depth: f64) -> Vec<crate::hlr::Face> {
    let mut near = vec![f64::INFINITY; owners];
    for f in &faces {
        if let Some(m) = near.get_mut(f.owner as usize) {
            *m = f.pts.iter().fold(*m, |m, q| m.min(q[2]));
        }
    }
    faces.into_iter().filter(|f| near.get(f.owner as usize).is_none_or(|&m| m <= depth + 1e-6)).collect()
}

// ── Schnitt ───────────────────────────────────────────────────────────────────

/// Viereck aus dem Dreieck `t` und dem folgenden Dreieck `next`, wenn beide dieselbe Normale haben und
/// genau eine Kante teilen (die gemeinsame Diagonale entfällt).
fn quad_of(t: &[[f64; 3]; 3], n: [f64; 3], next: &[u32], vert: &dyn Fn(u32) -> ([f64; 3], [f64; 3])) -> Option<[[f64; 3]; 4]> {
    let (p0, n0) = vert(next[0]);
    if n0 != n {
        return None;
    }
    let u = [p0, vert(next[1]).0, vert(next[2]).0];
    let shared: Vec<usize> = (0..3).filter(|&i| u.contains(&t[i])).collect();
    let extra = u.iter().find(|q| !t.contains(q))?;
    if shared.len() != 2 {
        return None;
    }
    // Gemeinsame Kante (i, i+1) im Umlauf von t: das neue Eck dazwischen einsetzen.
    let i = if shared == [0, 1] { 0 } else if shared == [1, 2] { 1 } else { 2 };
    let mut q = [[0.0; 3]; 4];
    for (k, slot) in q.iter_mut().enumerate() {
        *slot = match k.cmp(&(i + 1)) {
            std::cmp::Ordering::Less => t[k],
            std::cmp::Ordering::Equal => *extra,
            std::cmp::Ordering::Greater => t[k - 1],
        };
    }
    Some(q)
}

/// Ansichtskanten hinter der Schnittebene mit exakter Sichtbarkeit ([G4], `hlr.rs`; verdeckte nur mit
/// `hidden`, wie `hiddenLines` der Ebene): die Körper als
/// Dreiecke (Wände samt Gehrung und Löchern wie im 3D-Modell, Platten, Treppen, Dächer, Körper),
/// auf die Seite hinter der Ebene zugeschnitten; die Schnittflächen verdecken in Tiefe 0. Bogenwände,
/// verschnittene Dächer und Körper glätten ihre Facetten (keine Fugen, nur Knicke und Silhouetten).
#[allow(clippy::too_many_arguments)]
pub(super) fn projection_edges(p: &Project, plane: &Plane, walls_r: &[RWall], wi: &[render3d::WallInput], slabs_r: &[RSlab], bodies: &[&BodyMesh], meshes: &[crate::mesh_view::MeshRef], cuts: &[Cut], hidden: bool, max_depth: Option<f64>) -> (Vec<Edge>, Vec<Edge>) {
    use crate::hlr;
    let nl = crate::jsmath::hypot(&plane.normal);
    if !(nl > 1e-12) {
        return (Vec::new(), Vec::new());
    }
    let n = [plane.normal[0] / nl, plane.normal[1] / nl, plane.normal[2] / nl];
    let ul = hypot2(n[2], n[0]);
    let u = if ul > 1e-12 { [n[2] / ul, 0.0, -n[0] / ul] } else { [1.0, 0.0, 0.0] };
    let o = plane.point;
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let view = |w: [f64; 3]| {
        let r = [w[0] - o[0], w[1] - o[1], w[2] - o[2]];
        [dot(r, u), w[1], dot(r, n)]
    };
    let mut faces: Vec<hlr::Face> = Vec::new();
    let mut owners: Vec<(Kind, usize)> = Vec::new();
    // Fläche (Welt, Y oben) hinter die Ebene zuschneiden und anhängen.
    let mut push = |faces: &mut Vec<hlr::Face>, world: &[[f64; 3]], normal: [f64; 3], owner: u32, smooth: u32, two_sided: bool| {
        let pts: Vec<[f64; 3]> = world.iter().map(|&w| view(w)).collect();
        if pts.iter().all(|q| q[2] <= 0.0) {
            return;
        }
        let Some((pts, no_edge)) = hlr::clip_front(&pts) else { return };
        let mut f = hlr::Face::new(pts, [dot(normal, u), normal[1], dot(normal, n)], owner);
        f.no_edge = no_edge;
        f.smooth = smooth;
        f.two_sided = two_sided;
        faces.push(f);
    };
    let tri_normal = |t: &[[f64; 3]; 3]| {
        let (a, b) = ([t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]], [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]]);
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    };
    // render3d-Netz (Welt, f32; Normale je Ecke).
    let mesh_faces = |faces: &mut Vec<hlr::Face>, m: &render3d::Mesh, range: std::ops::Range<usize>, owner: u32, smooth: u32| {
        let vert = |i: u32| {
            let j = i as usize * render3d::FLOATS_PER_VERTEX;
            let v = &m.verts[j..j + 6];
            ([v[0] as f64, v[1] as f64, v[2] as f64], [v[3] as f64, v[4] as f64, v[5] as f64])
        };
        // Zwei aufeinanderfolgende Dreiecke einer Ebene mit gemeinsamer Kante (ein Viereck) als eine Fläche.
        let tris: Vec<&[u32]> = m.indices[range].chunks_exact(3).collect();
        let mut k = 0;
        while k < tris.len() {
            let (a, na) = vert(tris[k][0]);
            let t = [a, vert(tris[k][1]).0, vert(tris[k][2]).0];
            if let Some(q) = tris.get(k + 1).and_then(|n| quad_of(&t, na, n, &vert)) {
                push(faces, &q, na, owner, smooth, false);
                k += 2;
                continue;
            }
            push(faces, &t, na, owner, smooth, false);
            k += 1;
        }
    };
    // Wände: Bogen-Teilkörper derselben Wand bilden eine Glättungsgruppe.
    let wall_of = wall_owners(p, walls_r);
    let (wmesh, ends) = render3d::mesh::build_walls_mesh_owned(wi);
    let mut start = 0;
    for (i, &end) in ends.iter().enumerate() {
        let arc = wall_of.get(i).copied().flatten().filter(|w| crate::wall_arc::WallArc::of_wall(w).is_some());
        let smooth = arc.and_then(|w| p.walls.iter().position(|x| std::ptr::eq(x, w))).map_or(0, |k| k as u32 + 1);
        owners.push((Kind::Wall, i));
        mesh_faces(&mut faces, &wmesh, start..end, owners.len() as u32 - 1, smooth);
        start = end;
    }
    let mut group = p.walls.len() as u32 + 1;
    // Platten und Treppenstufen: Prismen (Deckel, Boden, Seiten) direkt aus dem Umriss. [157] Die Seiten einer
    // Platte bilden eine Glättungsgruppe: ein rundes Treppenloch oder ein Bogen-Rand zeigt nur seine
    // Silhouetten, keine senkrechten Facettenfugen (echte Ecken bleiben über dem Knickwinkel).
    for (i, s) in slabs_r.iter().enumerate() {
        let side_group = group;
        group += 1;
        owners.push((Kind::Slab, i));
        let owner = owners.len() as u32 - 1;
        let (o, n) = (&s.outline, s.outline.len());
        let (y0, y1) = (s.z_bottom.min(s.z_top), s.z_bottom.max(s.z_top));
        if n < 3 || y1 - y0 < 1e-6 {
            continue;
        }
        let area: f64 = (0..n).map(|k| o[k][0] * o[(k + 1) % n][1] - o[(k + 1) % n][0] * o[k][1]).sum();
        let sign = if area >= 0.0 { 1.0 } else { -1.0 };
        let top: Vec<[f64; 3]> = o.iter().map(|q| [q[0], y1, q[1]]).collect();
        let bottom: Vec<[f64; 3]> = o.iter().rev().map(|q| [q[0], y0, q[1]]).collect();
        push(&mut faces, &top, [0.0, 1.0, 0.0], owner, 0, false);
        push(&mut faces, &bottom, [0.0, -1.0, 0.0], owner, 0, false);
        for k in 0..n {
            let (a, b) = (o[k], o[(k + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            if dx.abs() + dy.abs() < 1e-12 {
                continue;
            }
            let side = [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]];
            push(&mut faces, &side, [dy * sign, 0.0, -dx * sign], owner, side_group, false);
        }
    }
    // Modell [x, y, Höhe] → Welt [x, Höhe, y].
    let model_tris = |faces: &mut Vec<hlr::Face>, pos: &[f64], idx: &mut dyn Iterator<Item = usize>, owner: u32, smooth: u32, push: &mut dyn FnMut(&mut Vec<hlr::Face>, &[[f64; 3]], [f64; 3], u32, u32, bool)| {
        let q = |i: usize| -> Option<[f64; 3]> { Some([*pos.get(3 * i)?, *pos.get(3 * i + 2)?, *pos.get(3 * i + 1)?]) };
        while let (Some(a), Some(b), Some(c)) = (idx.next(), idx.next(), idx.next()) {
            let (Some(a), Some(b), Some(c)) = (q(a), q(b), q(c)) else { continue };
            let t = [a, b, c];
            // Spiegelung durch den Achsentausch: Umlauf umkehren, damit die Normale aussen bleibt.
            let m = tri_normal(&t);
            push(faces, &t, [-m[0], -m[1], -m[2]], owner, smooth, false);
        }
    };
    for (ri, roof) in p.roofs.as_deref().unwrap_or(&[]).iter().enumerate() {
        owners.push((Kind::Roof, ri));
        let owner = owners.len() as u32 - 1;
        if let Some(solids) = crate::roof_assembly::roof_solids(p, ri) {
            model_tris(&mut faces, &solids.skin.positions, &mut solids.skin.indices.iter().map(|&i| i as usize), owner, 0, &mut push);
            continue;
        }
        // Dachhaut ohne Dicke: beidseitig.
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        // Stirnflächen der Ränder ([132]): Flachdächer zeigen sonst hinter dem Schnitt nur eine Linie.
        let total: f64 = p.roof_layers(roof).iter().map(|l| l.thickness.max(0.0)).sum();
        let fascia: Vec<Vec<[f64; 3]>> = crate::plan::elevation::fascia_quads(&g.planes, total).into_iter().map(|q| q.to_vec()).collect();
        for poly in g.planes.iter().chain(&g.gables).chain(&fascia) {
            let w: Vec<[f64; 3]> = poly.iter().map(|q| [q[0], q[2], q[1]]).collect();
            if w.len() >= 3 {
                push(&mut faces, &w, [0.0; 3], owner, 0, true);
            }
        }
    }
    for b in bodies {
        owners.push((Kind::Body, b.index));
        let owner = owners.len() as u32 - 1;
        let mut idx = b.indices.iter().filter(|&&i| i >= 0.0 && i.fract() == 0.0).map(|&i| i as usize);
        model_tris(&mut faces, &b.positions, &mut idx, owner, group, &mut push);
        group += 1;
    }
    // [157] Wangen und Geländer der Treppen (im Schnitt sonst nur Tritte und Setzstufen): Ansichtskanten mit
    // Verdeckung, Besitzer = eine Stufe derselben Treppe.
    for (si, m) in model3d::stair_view_meshes(p) {
        let Some(i) = slabs_r.iter().position(|s| matches!(s.source, SlabSource::Stair { index } if index == si)) else { continue };
        owners.push((Kind::Slab, i));
        let owner = owners.len() as u32 - 1;
        model_tris(&mut faces, &m.positions, &mut m.indices.iter().map(|&k| k as usize), owner, group, &mut push);
        group += 1;
    }
    // [152] Importierte Netze hinter der Ebene (Hüllbox vorgefiltert): Facetten innerhalb des Knickwinkels
    // glätten (eine Gruppe je Netz), offene Netze beidseitig.
    let (base, um) = (plane.base(), plane.u_model());
    for (k, m) in meshes.iter().enumerate() {
        let (lo, hi) = mesh_depth_range(m, base, um);
        if !(hi > 0.0) || max_depth.is_some_and(|d| d > 0.0 && lo > d + 1e-6) {
            continue;
        }
        owners.push((Kind::Mesh, k));
        let owner = owners.len() as u32 - 1;
        crate::mesh_view::hlr_faces(m, &|q| view([q[0], q[2], q[1]]), owner, group, true, &mut faces);
        group += 1;
    }
    // Ansichtsbereich ([36]): Bauteile, deren nächster Punkt weiter als `max_depth` hinter der Ebene
    // liegt, entfallen ganz (auch als Verdecker — sie liegen ohnehin hinter allem Gezeigten).
    if let Some(d) = max_depth.filter(|d| *d > 0.0) {
        faces = drop_far_owners(faces, owners.len(), d);
    }
    // Schnittflächen (Tiefe 0) verdecken nur.
    for c in cuts {
        if c.pts.len() >= 3 {
            let mut f = hlr::Face::new(c.pts.iter().map(|q| [q[0], q[1], 0.0]).collect(), [0.0, 0.0, -1.0], 0);
            f.edges = false;
            faces.push(f);
        }
    }
    let opts = hlr::Opts { tol: 1e-4, depth_eps: 1e-4, hidden, ..hlr::Opts::default() };
    let (mut visible, mut hidden) = (Vec::new(), Vec::new());
    for sg in hlr::hidden_lines(&faces, &opts) {
        let (kind, index) = owners[sg.owner as usize];
        let e = Edge { kind, index, a: sg.a, b: sg.b };
        if sg.hidden {
            hidden.push(e);
        } else {
            visible.push(e);
        }
    }
    (visible, hidden)
}
