//! Dach-Verschneidung und Gauben als Körper ([G5], Booleans über [`crate::solid_bool`]).
//!
//! **Wann:** Ein Dach ist „verschnitten", wenn sich sein Traufumriss mit dem eines anderen Dachs
//! überdeckt (L-/T-Dächer, Anbauten auf gleicher Höhe) oder wenn es Gauben trägt. Nur dann rechnen
//! 3D, Schnitt, Ansicht und Grundriss mit den Körpern hier; alle übrigen Dächer bleiben auf dem
//! bisherigen (analytischen) Weg.
//!
//! **Regel Dach ↔ Dach** (je Schicht k mit Tiefe d0…d1 unter der Oberkante): `S_X(d)` = Raum unter der
//! um `d` gesenkten Oberfläche von Dach X (lotrechte Prismen über den Dachflächen bis unter dessen
//! tiefste Unterkante). Das frühere Dach A (Reihenfolge in `Project::roofs`) verliert, was unter der
//! Schicht-Unterkante von B liegt: `A_k − S_B(d1)`; das spätere B verliert, was unter der Schicht-Oberkante
//! von A liegt: `B_k − S_A(d0)`. Zusammen ergibt das je Schicht genau die Schicht der oberen Hülle beider
//! Dächer (Kehlen, Grate, im anderen Dach steckende Giebel fallen weg), ohne Überlappung.
//!
//! **Gaube** (`dormer.rs`): Hauptdach − Loch (alle Schichten); Gaubendach-Schichten − `S_Haupt(0)`
//! (liegt auf der Eindeckung auf); Wangen/Stirn je Wandschicht − `S_Haupt(Dicke)` (stehen auf der
//! Unterkante) − Raum über der Gaubendach-Unterkante − Fensterlöcher.
//!
//! **Cache:** je Dach (Schlüssel `roof-solids/<id>`), Inhalts-Hash über das Dach, die verschnittenen
//! Nachbarn, Typen und Öffnungen. Schlägt ein Boolean fehl, bleibt der Teil unverschnitten (gezählt in
//! `failed`), nie Panik.

use std::rc::Rc;

use crate::dormer::DormerGeom;
use crate::model::*;
use crate::opening_shape::V3;
use crate::solid_bool::{cached, ContentHash, Mesh, Solid};

/// Art eines Teils.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Schicht des Dachs selbst.
    RoofLayer,
    /// Schicht eines Gaubendachs.
    DormerRoof,
    /// Wandschicht (Wange/Stirn) einer Gaube.
    DormerWall,
}

#[derive(Clone, Debug)]
pub struct Part {
    pub role: Role,
    /// Schicht-Index (Dach- bzw. Wandaufbau, aussen zuerst).
    pub layer: usize,
    pub component_id: String,
    /// Geschlossenes, verschweisstes Netz (Modell-Meter, z = Höhe).
    pub mesh: Mesh,
    pub dormer: Option<String>,
}

#[derive(Clone, Default)]
pub struct RoofSolids {
    pub parts: Vec<Part>,
    /// Vereinigung aller Teile (Aussenhaut für Ansicht/Grundriss).
    pub skin: Mesh,
    /// Vereinigung der äussersten Dachschichten (Eindeckung von Dach und Gaubendächern): Dachaufsicht.
    pub top: Mesh,
    /// Vereinigung der Gaubenwände (Ansicht).
    pub walls: Mesh,
    /// Teile, deren Boolean scheiterte (unverschnitten übernommen).
    pub failed: usize,
}

const LOW: f64 = 0.05;

/// Dachflächen und Schichten eines Dachs.
struct RoofIn {
    planes: Vec<Vec<V3>>,
    layers: Vec<Layer>,
    total: f64,
    eaves: Vec<[f64; 2]>,
    z_lo: f64,
    z_hi: f64,
}

fn roof_in(p: &Project, r: &Roof) -> RoofIn {
    let g = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r));
    let layers: Vec<Layer> = p.roof_layers(r);
    let total: f64 = layers.iter().map(|l| l.thickness.max(0.0)).sum();
    let mut z_lo = f64::INFINITY;
    let mut z_hi = f64::NEG_INFINITY;
    let mut min_nz: f64 = 1.0;
    for pl in &g.planes {
        let n = crate::model3d::plane_normal_up(pl);
        if n[2] > 1e-3 {
            min_nz = min_nz.min(n[2]);
        }
        for q in pl {
            z_lo = z_lo.min(q[2]);
            z_hi = z_hi.max(q[2]);
        }
    }
    RoofIn { planes: g.planes, layers, total, eaves: g.eaves, z_lo: z_lo - total / min_nz.max(0.05) - LOW, z_hi }
}

/// Raum unter der um `d` (senkrecht zur Fläche) gesenkten Oberfläche, bis unter die tiefste Unterkante.
fn below_surface(r: &RoofIn, d: f64) -> Vec<Mesh> {
    let mut out = Vec::new();
    for pl in &r.planes {
        if pl.len() < 3 {
            continue;
        }
        let n = crate::model3d::plane_normal_up(pl);
        if n[2] < 1e-3 {
            continue;
        }
        let o = pl[0];
        let top = move |x: f64, y: f64| o[2] - (n[0] * (x - o[0]) + n[1] * (y - o[1])) / n[2] - d / n[2];
        let ring: Vec<[f64; 2]> = pl.iter().map(|q| [q[0], q[1]]).collect();
        let zl = r.z_lo;
        let m = Mesh::prism_between(&ring, &move |_, _| zl, &top);
        if !m.is_empty() {
            out.push(m);
        }
    }
    out
}

fn solid_union(meshes: &[Mesh], failed: &mut usize) -> Solid {
    let (s, bad) = Solid::union_all(meshes);
    *failed += bad;
    s
}

fn area2(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    (0..n).map(|i| ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1]).sum::<f64>() / 2.0
}

/// Überdecken sich die Traufumrisse zweier Dächer (Fläche > 1e-4 m²) und ihre Höhenbereiche?
fn overlaps(a: &RoofIn, b: &RoofIn) -> bool {
    if a.eaves.len() < 3 || b.eaves.len() < 3 || a.z_hi < b.z_lo || b.z_hi < a.z_lo {
        return false;
    }
    let pa = vec![vec![a.eaves.clone()]];
    let pb = vec![vec![b.eaves.clone()]];
    let i = crate::polygon_bool::intersection(&pa, &pb);
    i.iter().map(|poly| poly.iter().enumerate().map(|(k, r)| if k == 0 { area2(r).abs() } else { -area2(r).abs() }).sum::<f64>()).sum::<f64>() > 1e-4
}

/// Je Dach: verschnitten (Nachbarn überdecken sich oder Gauben)? Und mit welchen Nachbarn.
pub fn neighbors(p: &Project) -> Vec<Vec<usize>> {
    let roofs = p.roofs.as_deref().unwrap_or(&[]);
    let mut h = ContentHash::default();
    for r in roofs {
        h.json(&r.outline).json(&r.holes).json(&r.edge_pitch_deg).str(&format!("{:?}{:?}", r.shape, r.ridge_axis)).f64(r.pitch_deg).f64(r.overhang).f64(r.overhang_gable.unwrap_or(-1.0)).f64(r.thickness).f64(p.roof_base_elevation(r));
        h.json(&r.pitch_upper_deg).json(&r.mansard_type).json(&r.mansard_knee_ratio).json(&r.half_hip_ratio).json(&r.roof_type_id);
    }
    h.json(&p.roof_types);
    (*cached("roof-solids/neighbors", h.finish(), || neighbors_uncached(p, roofs))).clone()
}

fn neighbors_uncached(p: &Project, roofs: &[Roof]) -> Vec<Vec<usize>> {
    let ins: Vec<RoofIn> = roofs.iter().map(|r| roof_in(p, r)).collect();
    let mut out = vec![Vec::new(); roofs.len()];
    for i in 0..roofs.len() {
        for j in i + 1..roofs.len() {
            if overlaps(&ins[i], &ins[j]) {
                out[i].push(j);
                out[j].push(i);
            }
        }
    }
    out
}

fn has_dormers(r: &Roof) -> bool {
    r.dormers.as_deref().is_some_and(|d| !d.is_empty())
}

/// Ist das Dach `ri` verschnitten (Körper-Weg)?
pub fn is_assembled(p: &Project, ri: usize) -> bool {
    let Some(r) = p.roofs.as_deref().and_then(|v| v.get(ri)) else { return false };
    has_dormers(r) || !neighbors(p).get(ri).is_none_or(Vec::is_empty)
}

/// Körper des Dachs `ri`, falls verschnitten (sonst `None`), aus dem Cache.
pub fn roof_solids(p: &Project, ri: usize) -> Option<Rc<RoofSolids>> {
    let roofs = p.roofs.as_deref()?;
    let roof = roofs.get(ri)?;
    let nb = neighbors(p).swap_remove(ri);
    if nb.is_empty() && !has_dormers(roof) {
        return None;
    }
    let mut h = ContentHash::default();
    h.json(roof).f64(p.roof_base_elevation(roof)).json(&p.roof_types);
    for &j in &nb {
        h.u64(j as u64).json(&roofs[j]).f64(p.roof_base_elevation(&roofs[j]));
    }
    if has_dormers(roof) {
        h.json(&p.wall_types);
    }
    for o in p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| o.host_roof_id.as_deref() == Some(roof.id.as_str())) {
        h.json(o);
    }
    let r = cached(&format!("roof-solids/{}", roof.id), h.finish(), || build(p, ri, &nb));
    Some(r)
}

fn build(p: &Project, ri: usize, nb: &[usize]) -> RoofSolids {
    let roofs = p.roofs.as_deref().unwrap_or(&[]);
    let roof = &roofs[ri];
    let me = roof_in(p, roof);
    let others: Vec<(usize, RoofIn)> = nb.iter().map(|&j| (j, roof_in(p, &roofs[j]))).collect();
    let mut failed = 0usize;
    let mut parts = Vec::new();

    // Löcher: Dachfenster (Quader senkrecht zur Fläche) und Gauben (lotrechte Prismen).
    let mut holes: Vec<Mesh> = Vec::new();
    for (o, f) in crate::opening_shape::roof_openings(p, ri) {
        holes.push(hex_of(&crate::opening_shape::surface_hole_box(o, &f)));
    }
    let dormers: Vec<(&Dormer, DormerGeom)> = roof.dormers.as_deref().unwrap_or(&[]).iter().filter_map(|d| crate::dormer::geometry(p, roof, d).map(|g| (d, g))).collect();
    for (_, g) in &dormers {
        let ring: Vec<[f64; 2]> = g.hole().iter().map(|q| g.frame.plan(q[0], q[1])).collect();
        holes.push(Mesh::prism(&ring, me.z_lo - 1.0, me.z_hi + 1.0));
    }
    let hole_solid = solid_union(&holes, &mut failed);

    let mut d0 = 0.0;
    for (k, layer) in me.layers.iter().enumerate() {
        let t = layer.thickness.max(0.0);
        if t <= 1e-6 {
            continue;
        }
        let d1 = d0 + t;
        let prisms = crate::model3d::roof_plane_prisms(&me.planes, d0, d1);
        let mut slab = solid_union(&prisms, &mut failed);
        let raw = slab.clone();
        let mut ok = true;
        if let Ok(s) = slab.difference(&hole_solid) {
            slab = s;
        } else {
            ok = false;
        }
        for (j, other) in &others {
            let d = if *j > ri { d1 } else { d0 };
            let cut = solid_union(&below_surface(other, d), &mut failed);
            match slab.difference(&cut) {
                Ok(s) => slab = s,
                Err(_) => ok = false,
            }
        }
        if !ok {
            failed += 1;
            slab = raw;
        }
        let mesh = slab.to_mesh();
        if !mesh.is_empty() {
            parts.push(Part { role: Role::RoofLayer, layer: k, component_id: layer.component_id.clone(), mesh, dormer: None });
        }
        d0 = d1;
    }

    // Gauben.
    if !dormers.is_empty() {
        let main_top = solid_union(&below_surface(&me, 0.0), &mut failed);
        let main_under = solid_union(&below_surface(&me, me.total), &mut failed);
        let windows = crate::dormer::dormer_openings(p, ri);
        for (d, g) in &dormers {
            dormer_parts(d, g, &main_top, &main_under, &windows, &mut parts, &mut failed);
        }
    }

    let mut skin = Solid::empty();
    for pt in &parts {
        match Solid::new_exact(&pt.mesh).and_then(|s| skin.union(&s)) {
            Ok(s) => skin = s,
            Err(_e) => {
                #[cfg(test)]
                eprintln!("skin: {_e}");
                failed += 1
            }
        }
    }
    // Ohne `simplify`: das Zusammenlegen kippte an Schichtgrenzen einzelne Dreiecke aus der Dachebene
    // (Scheinkanten in Aufsicht/Ansicht).
    let skin = skin.to_mesh_raw();
    let mut top = Solid::empty();
    for pt in parts.iter().filter(|pt| pt.layer == 0 && pt.role != Role::DormerWall) {
        if let Ok(s) = Solid::new_exact(&pt.mesh).and_then(|s| top.union(&s)) {
            top = s;
        }
    }
    let top = top.to_mesh_raw();
    let mut walls = Solid::empty();
    for pt in parts.iter().filter(|pt| pt.role == Role::DormerWall) {
        if let Ok(s) = Solid::new_exact(&pt.mesh).and_then(|s| walls.union(&s)) {
            walls = s;
        }
    }
    let walls = walls.to_mesh_raw();
    RoofSolids { parts, skin, top, walls, failed }
}

fn hex_of(b: &[f64; 24]) -> Mesh {
    // `quad_box`: Ecke i nach Bits (0/1: Viereck in Bit-Reihenfolge 0,1,3,2; Bit 2: Seite).
    let c: [[f64; 3]; 8] = std::array::from_fn(|k| {
        let i = [0, 1, 3, 2, 4, 5, 7, 6][k];
        [b[i * 3], b[i * 3 + 1], b[i * 3 + 2]]
    });
    Mesh::hexahedron(&c)
}

fn dormer_parts(
    d: &Dormer,
    g: &DormerGeom,
    main_top: &Solid,
    main_under: &Solid,
    windows: &[(&Opening, &Dormer, crate::opening_shape::HostFrame)],
    parts: &mut Vec<Part>,
    failed: &mut usize,
) {
    let f = &g.frame;
    let planes = g.planes();
    let z_hi = g.z_max() + 1.0;
    let world_ring = |ring: &[[f64; 2]]| -> Vec<[f64; 2]> { ring.iter().map(|q| f.plan(q[0], q[1])).collect() };
    // Höhe einer lokalen Ebene an einem Grundrisspunkt.
    let zf = |pl: &crate::dormer::DormerPlane, x: f64, y: f64| {
        let l = f.local(x, y);
        pl.z(l[0], l[1])
    };
    // Gaubendach je Schicht.
    let mut d0 = 0.0;
    for (k, layer) in g.roof_layers.iter().enumerate() {
        let d1 = d0 + layer.thickness;
        let mut pieces = Vec::new();
        for pl in &planes {
            let c = pl.cos();
            let (a, b) = (d0 / c, d1 / c);
            let pl2 = pl.clone();
            let pl3 = pl.clone();
            pieces.push(Mesh::prism_between(&world_ring(&pl.ring), &move |x, y| zf(&pl2, x, y) - b, &move |x, y| zf(&pl3, x, y) - a));
        }
        let s = solid_union(&pieces, failed);
        let s = s.difference(main_top).unwrap_or_else(|_e| {
            #[cfg(test)]
            eprintln!("dormer roof: {_e}");
            *failed += 1;
            s.clone()
        });
        let mesh = s.to_mesh();
        if !mesh.is_empty() {
            parts.push(Part { role: Role::DormerRoof, layer: k, component_id: layer.component_id.clone(), mesh, dormer: Some(d.id.clone()) });
        }
        d0 = d1;
    }
    // Raum über der Gaubendach-Unterkante.
    let rv = g.roof_thickness;
    let above: Vec<Mesh> = planes
        .iter()
        .map(|pl| {
            let b = rv / pl.cos();
            let pl2 = pl.clone();
            Mesh::prism_between(&world_ring(&pl.ring), &move |x, y| zf(&pl2, x, y) - b, &move |_, _| z_hi + 1.0)
        })
        .collect();
    let above = solid_union(&above, failed);
    let win: Vec<Mesh> = windows.iter().filter(|(_, wd, _)| wd.id == d.id).map(|(o, _, fr)| hex_of(&crate::opening_shape::surface_hole_box(o, fr))).collect();
    let win = solid_union(&win, failed);
    let z_lo = f.z_m0 - g.main_thickness * (1.0 + f.tan_main * f.tan_main).sqrt() - 0.005;
    for (k, ring) in g.wall_pieces() {
        let m = Mesh::prism(&world_ring(&ring), z_lo, z_hi);
        let Ok(s) = Solid::new(&m) else {
            #[cfg(test)]
            eprintln!("wall prism");
            *failed += 1;
            continue;
        };
        let r = s.difference(main_under).and_then(|s| s.difference(&above)).and_then(|s| s.difference(&win));
        let s = match r {
            Ok(s) => s,
            Err(_e) => {
                #[cfg(test)]
                eprintln!("wall: {_e}");
                *failed += 1;
                continue;
            }
        };
        let mesh = s.to_mesh();
        if !mesh.is_empty() {
            parts.push(Part { role: Role::DormerWall, layer: k, component_id: g.wall_layers[k].component_id.clone(), mesh, dormer: Some(d.id.clone()) });
        }
    }
}

// ── Auswertung für Grundriss, Schnitt, Ansicht, 3D ───────────────────────────

/// Netz mit eigenen Ecken je Dreieck (flache Schattierung im 3D).
pub fn unshared(m: &Mesh) -> (Vec<f64>, Vec<u32>) {
    let mut positions = Vec::with_capacity(m.indices.len() * 3);
    for &i in &m.indices {
        let j = i as usize * 3;
        positions.extend_from_slice(&m.positions[j..j + 3]);
    }
    let indices = (0..m.indices.len() as u32).collect();
    (positions, indices)
}

fn tri(m: &Mesh, t: &[u32]) -> [V3; 3] {
    let v = |i: u32| {
        let j = i as usize * 3;
        [m.positions[j], m.positions[j + 1], m.positions[j + 2]]
    };
    [v(t[0]), v(t[1]), v(t[2])]
}

fn normal(t: &[V3; 3]) -> V3 {
    let (a, b) = ([t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]], [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]]);
    let c = crate::opening_shape::cross(a, b);
    let l = crate::opening_shape::dot(c, c).sqrt();
    if l > 1e-15 { [c[0] / l, c[1] / l, c[2] / l] } else { [0.0, 0.0, 0.0] }
}

/// Koplanare, über Kanten zusammenhängende Dreiecke gruppieren (Indizes `tris` in `m`): Gruppe je
/// Dreieck und Normale je Gruppe (die des grössten Dreiecks). Schmale Dreiecke (ungenaue Normale) zählen
/// zur Ebene ihres Nachbarn, wenn ihre Ecken darin liegen.
fn plane_groups(m: &Mesh, tris: &[usize], canon: &[u32]) -> (Vec<usize>, Vec<V3>) {
    use std::collections::HashMap;
    let geo: Vec<[V3; 3]> = tris.iter().map(|&t| tri(m, &m.indices[t * 3..t * 3 + 3])).collect();
    let area: Vec<f64> = geo
        .iter()
        .map(|t| {
            let c = crate::opening_shape::cross([t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]], [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]]);
            crate::opening_shape::dot(c, c).sqrt() / 2.0
        })
        .collect();
    let nrm: Vec<V3> = geo.iter().map(normal).collect();
    let coplanar = |a: usize, b: usize| {
        let (big, small) = if area[a] >= area[b] { (a, b) } else { (b, a) };
        let o = crate::opening_shape::dot(nrm[big], geo[big][0]);
        let on = geo[small].iter().all(|v| (crate::opening_shape::dot(nrm[big], *v) - o).abs() < 1e-4);
        (on && (area[small] < 1e-4 || crate::opening_shape::dot(nrm[a], nrm[b]) > 0.99)) || crate::opening_shape::dot(nrm[a], nrm[b]) > 0.9995
    };
    let mut parent: Vec<usize> = (0..tris.len()).collect();
    fn root(p: &mut [usize], mut i: usize) -> usize {
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    let mut by_edge: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (k, &t) in tris.iter().enumerate() {
        for e in 0..3 {
            let (a, b) = (canon[m.indices[t * 3 + e] as usize], canon[m.indices[t * 3 + (e + 1) % 3] as usize]);
            by_edge.entry((a.min(b), a.max(b))).or_default().push(k);
        }
    }
    let mut keys: Vec<&(u32, u32)> = by_edge.keys().collect();
    keys.sort_unstable();
    for e in keys {
        if let [a, b] = by_edge[e].as_slice() {
            if coplanar(*a, *b) {
                let (ra, rb) = (root(&mut parent, *a), root(&mut parent, *b));
                parent[ra] = rb;
            }
        }
    }
    let mut gid: HashMap<usize, usize> = HashMap::new();
    let mut group = vec![0; tris.len()];
    let mut best: Vec<(f64, V3)> = Vec::new();
    for k in 0..tris.len() {
        let r = root(&mut parent, k);
        let g = *gid.entry(r).or_insert_with(|| {
            best.push((-1.0, [0.0; 3]));
            best.len() - 1
        });
        group[k] = g;
        if area[k] > best[g].0 {
            best[g] = (area[k], nrm[k]);
        }
    }
    (group, best.into_iter().map(|b| b.1).collect())
}

/// Ecken-Ids: Manifold-Netze sind nach Indizes mannigfaltig — gleiche Lage verschiedener Ecken nicht
/// vereinen (gerundete Schlüssel trennten nahe Ecken an Rundungsgrenzen und erzeugten Scheinkanten).
fn canon_ids(m: &Mesh) -> Vec<u32> {
    (0..(m.positions.len() / 3) as u32).collect()
}

/// Dreiecke `tris` (Indizes in `m`) zu ebenen Flächen zusammenfassen: zusammenhängende, koplanare
/// Dreiecke bilden eine Gruppe; hat sie genau einen Rand-Ring, wird sie zu diesem Polygon (kollineare
/// Ecken entfernt), sonst (Löcher) bleiben ihre Dreiecke. Für die Ansicht (eine Fläche statt vieler
/// Dreiecke: keine Haarfugen, keine Scheinkanten).
pub fn planar_faces(m: &Mesh, tris: &[usize]) -> Vec<Vec<V3>> {
    use std::collections::HashMap;
    let canon = canon_ids(m);
    let tv: Vec<[u32; 3]> = tris.iter().map(|&t| [canon[m.indices[t * 3] as usize], canon[m.indices[t * 3 + 1] as usize], canon[m.indices[t * 3 + 2] as usize]]).collect();
    let geo: Vec<[V3; 3]> = tris.iter().map(|&t| tri(m, &m.indices[t * 3..t * 3 + 3])).collect();
    let (group, _) = plane_groups(m, tris, &canon);
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for (k, &g) in group.iter().enumerate() {
        groups.entry(g).or_default().push(k);
    }
    let pos = |i: u32| {
        let j = i as usize * 3;
        [m.positions[j], m.positions[j + 1], m.positions[j + 2]]
    };
    let mut keys: Vec<usize> = groups.keys().copied().collect();
    keys.sort_unstable();
    let mut out = Vec::new();
    for g in keys {
        let list = &groups[&g];
        // Gerichtete Randkanten: Kante ohne Gegenkante in der Gruppe.
        let mut directed: HashMap<(u32, u32), usize> = HashMap::new();
        for &k in list {
            for e in 0..3 {
                *directed.entry((tv[k][e], tv[k][(e + 1) % 3])).or_default() += 1;
            }
        }
        let boundary: Vec<(u32, u32)> = directed.keys().copied().filter(|&(a, b)| !directed.contains_key(&(b, a))).collect();
        let mut next: HashMap<u32, u32> = HashMap::new();
        let mut simple = true;
        for &(a, b) in &boundary {
            if next.insert(a, b).is_some() {
                simple = false;
            }
        }
        let ring = simple.then(|| {
            let start = boundary.first()?.0;
            let mut ring = vec![start];
            let mut cur = *next.get(&start)?;
            while cur != start {
                if ring.len() > boundary.len() {
                    return None;
                }
                ring.push(cur);
                cur = *next.get(&cur)?;
            }
            (ring.len() == boundary.len()).then_some(ring)
        });
        match ring.flatten() {
            Some(r) => {
                let pts: Vec<V3> = r.iter().map(|&i| pos(i)).collect();
                // Kollineare Ecken weg.
                let n = pts.len();
                let keep: Vec<V3> = (0..n)
                    .filter(|&i| {
                        let (a, b, c) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
                        let cr = crate::opening_shape::cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - b[0], c[1] - b[1], c[2] - b[2]]);
                        crate::opening_shape::dot(cr, cr).sqrt() > 1e-10
                    })
                    .map(|i| pts[i])
                    .collect();
                if keep.len() >= 3 {
                    out.push(keep);
                }
            }
            // Fläche mit Löchern: ihre Dreiecke (grosse Flächen stören die Maler-Reihenfolge der Ansicht vor
            // den Gauben; die Dreieckskanten blendet die Ansicht als koplanare Nähte aus).
            None => out.extend(list.iter().map(|&k| geo[k].to_vec())),
        }
    }
    out
}

/// Liegt `c` auf der Oberfläche von `m` (Abstand < 1e-6 zu einem Dreieck)?
pub fn on_surface(m: &Mesh, c: V3) -> bool {
    m.indices.chunks_exact(3).any(|t| {
        let tr = tri(m, t);
        let n = normal(&tr);
        let d = (c[0] - tr[0][0]) * n[0] + (c[1] - tr[0][1]) * n[1] + (c[2] - tr[0][2]) * n[2];
        if d.abs() > 1e-6 {
            return false;
        }
        // Baryzentrisch in der Ebene.
        let e = |a: V3, b: V3| crate::opening_shape::dot(crate::opening_shape::cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]), n);
        e(tr[0], tr[1]) >= -1e-9 && e(tr[1], tr[2]) >= -1e-9 && e(tr[2], tr[0]) >= -1e-9
    })
}

/// Linienart der Dachaufsicht.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeKind {
    Eaves,
    Ridge,
    Hip,
}

/// Dachaufsicht: sichtbare Kanten der nach oben zeigenden Flächen von `skin` (Rand gegen
/// nicht-aufwärts gerichtete Flächen = Traufe/Ortgang, zwischen zwei Ebenen = First (waagrecht) bzw.
/// Grat/Kehle), verdeckt durch alle `occluders` (Aufwärts-Flächen darüber) weggeschnitten.
pub fn top_view_edges(skin: &Mesh, occluders: &[&Mesh]) -> Vec<([f64; 2], [f64; 2], EdgeKind)> {
    use std::collections::HashMap;
    let canon = canon_ids(skin);
    let all: Vec<usize> = (0..skin.indices.len() / 3).collect();
    let (group, gn) = plane_groups(skin, &all, &canon);
    let mut edges: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (ti, t) in skin.indices.chunks_exact(3).enumerate() {
        for k in 0..3 {
            let (a, b) = (canon[t[k] as usize], canon[t[(k + 1) % 3] as usize]);
            edges.entry((a.min(b), a.max(b))).or_default().push(ti);
        }
    }
    let is_up = |ti: usize| gn[group[ti]][2] > 1e-4;
    let same_plane = |a: usize, b: usize| group[a] == group[b];
    // Verdecker: alle aufwärts zeigenden Dreiecke aller Häute.
    let occ: Vec<[V3; 3]> = occluders
        .iter()
        .flat_map(|m| m.indices.chunks_exact(3).map(|t| tri(m, t)).filter(|t| normal(t)[2] > 1e-4).collect::<Vec<_>>())
        .collect();
    let hidden = |x: f64, y: f64, z: f64| {
        occ.iter().any(|t| {
            let (a, b, c) = (t[0], t[1], t[2]);
            let d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
            if d.abs() < 1e-15 {
                return false;
            }
            let l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
            let l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
            let l3 = 1.0 - l1 - l2;
            let e = 1e-9;
            l1 > e && l2 > e && l3 > e && l1 * a[2] + l2 * b[2] + l3 * c[2] > z + 1e-4
        })
    };
    let mut out = Vec::new();
    for (&(a, b), list) in &edges {
        let ups: Vec<usize> = list.iter().copied().filter(|&t| is_up(t)).collect();
        let kind = match ups.as_slice() {
            [] => continue,
            [_] => EdgeKind::Eaves,
            [x, y] if same_plane(*x, *y) => continue,
            _ => EdgeKind::Hip,
        };
        let pa = [skin.positions[a as usize * 3], skin.positions[a as usize * 3 + 1], skin.positions[a as usize * 3 + 2]];
        let pb = [skin.positions[b as usize * 3], skin.positions[b as usize * 3 + 1], skin.positions[b as usize * 3 + 2]];
        let kind = if kind == EdgeKind::Hip && (pa[2] - pb[2]).abs() < 1e-6 { EdgeKind::Ridge } else { kind };
        let len = ((pb[0] - pa[0]).powi(2) + (pb[1] - pa[1]).powi(2)).sqrt();
        if len < 1e-6 {
            continue;
        }
        // In Stücke teilen, verdeckte weglassen, sichtbare zusammenhängende Stücke vereinen.
        let n = ((len / 0.05).ceil() as usize).clamp(1, 400);
        let at = |s: f64| [pa[0] + (pb[0] - pa[0]) * s, pa[1] + (pb[1] - pa[1]) * s, pa[2] + (pb[2] - pa[2]) * s];
        let mut start: Option<usize> = None;
        for i in 0..=n {
            let vis = i < n && {
                let m = at((i as f64 + 0.5) / n as f64);
                !hidden(m[0], m[1], m[2])
            };
            match (vis, start) {
                (true, None) => start = Some(i),
                (false, Some(s)) => {
                    let (q0, q1) = (at(s as f64 / n as f64), at(i as f64 / n as f64));
                    out.push(([q0[0], q0[1]], [q1[0], q1[1]], kind));
                    start = None;
                }
                _ => {}
            }
        }
    }
    out.sort_by(|a, b| a.0[0].total_cmp(&b.0[0]).then(a.0[1].total_cmp(&b.0[1])).then(a.1[0].total_cmp(&b.1[0])).then(a.1[1].total_cmp(&b.1[1])));
    out
}

/// Dachaufsicht aller verschnittenen Dächer zusammen (Kehlen zwischen zwei Dächern werden so als
/// Grat/Kehle erkannt): (Dach-Index, a, b, Art). Zuordnung einer Kante zum Dach mit der höchsten
/// Oberkante an ihrer Mitte.
pub fn assembly_edges(p: &Project) -> Rc<Vec<(usize, [f64; 2], [f64; 2], EdgeKind)>> {
    let n = p.roofs.as_deref().map_or(0, |r| r.len());
    let solids: Vec<(usize, Rc<RoofSolids>)> = (0..n).filter_map(|i| roof_solids(p, i).map(|s| (i, s))).collect();
    let mut h = ContentHash::default();
    for (i, s) in &solids {
        h.u64(*i as u64).f64s(&s.top.positions).u64(s.top.indices.len() as u64);
    }
    cached("roof-solids/edges", h.finish(), || {
        // Je Dach seine eigene Aufsicht (eine Vereinigung aller Dächer triangulierte neu und erzeugte
        // Scheinkanten), verdeckt durch alle; Traufkanten, die auf einer Traufkante eines anderen Dachs
        // liegen, sind Kehlen/Grate zwischen zwei Dächern (nur einmal, beim früheren Dach).
        let tops: Vec<&Mesh> = solids.iter().map(|(_, s)| &s.top).collect();
        let per: Vec<Vec<([f64; 2], [f64; 2], EdgeKind)>> = solids.iter().map(|(_, s)| top_view_edges(&s.top, &tops)).collect();
        let on_seg = |q: [f64; 2], a: [f64; 2], b: [f64; 2]| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            if l2 < 1e-18 {
                return false;
            }
            let t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2;
            let (px, py) = (a[0] + dx * t, a[1] + dy * t);
            (-1e-6..=1.0 + 1e-6).contains(&t) && (q[0] - px).powi(2) + (q[1] - py).powi(2) < 1e-10
        };
        let shared = |k: usize, a: [f64; 2], b: [f64; 2]| -> Option<usize> {
            let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
            (0..per.len()).filter(|&o| o != k).find(|&o| per[o].iter().any(|e| e.2 == EdgeKind::Eaves && on_seg(m, e.0, e.1) && on_seg(a, e.0, e.1) || e.2 == EdgeKind::Eaves && on_seg(m, e.0, e.1) && on_seg(b, e.0, e.1)))
        };
        let mut out = Vec::new();
        for (k, edges) in per.iter().enumerate() {
            for &(a, b, kind) in edges {
                if kind == EdgeKind::Eaves {
                    if let Some(o) = shared(k, a, b) {
                        if o < k {
                            continue;
                        }
                        out.push((solids[k].0, a, b, EdgeKind::Hip));
                        continue;
                    }
                }
                out.push((solids[k].0, a, b, kind));
            }
        }
        out
    })
}

/// Senkrechter Schnitt eines Körpers durch `base` in Richtung `u` (Grundriss): Ringe in
/// Schnitt-Koordinaten (t entlang `u`, z).
pub fn section_rings(m: &Mesh, base: (f64, f64), u: (f64, f64)) -> Vec<Vec<[f64; 2]>> {
    let idx: Vec<f64> = m.indices.iter().map(|&i| i as f64).collect();
    let r = crate::mesh_section::cut(&m.positions, &idx, &[0.0, base.0, base.1, u.0, u.1]);
    let mut out = Vec::new();
    let Some(&n) = r.first() else { return out };
    let mut i = 1;
    for _ in 0..n as usize {
        let Some(&k) = r.get(i) else { break };
        let k = k as usize;
        if i + 1 + 2 * k > r.len() {
            break;
        }
        out.push((0..k).map(|j| [r[i + 1 + 2 * j], r[i + 2 + 2 * j]]).collect());
        i += 1 + 2 * k;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_project(roofs: serde_json::Value) -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
            "drawingLevels": [], "layers": [], "walls": [], "drawings2d": [], "roofs": roofs
        }))
        .unwrap()
    }

    fn sattel(id: &str, outline: [[f64; 2]; 2], axis: &str) -> serde_json::Value {
        let [a, b] = outline;
        serde_json::json!({
            "id": id, "type": "roof", "floorId": "F", "categoryCode": "35",
            "outline": [{"x": a[0], "y": a[1]}, {"x": b[0], "y": a[1]}, {"x": b[0], "y": b[1]}, {"x": a[0], "y": b[1]}],
            "shape": "sattel", "pitchDeg": 40, "overhang": 0.0, "ridgeAxis": axis, "baseElevation": 3.0, "thickness": 0.25
        })
    }

    fn total_volume(p: &Project) -> f64 {
        (0..p.roofs.as_ref().unwrap().len()).filter_map(|i| roof_solids(p, i)).flat_map(|s| s.parts.iter().map(|pt| pt.mesh.volume()).collect::<Vec<_>>()).sum()
    }

    /// L-Dach: zwei Satteldächer gleicher Traufhöhe und Breite, das zweite stösst an das erste.
    #[test]
    fn l_roof_without_overlap_and_watertight() {
        let p = base_project(serde_json::json!([sattel("A", [[0.0, 0.0], [12.0, 8.0]], "x"), sattel("B", [[0.0, 0.0], [8.0, 14.0]], "y")]));
        let nb = neighbors(&p);
        assert_eq!(nb, vec![vec![1], vec![0]]);
        let a = roof_solids(&p, 0).unwrap();
        let b = roof_solids(&p, 1).unwrap();
        assert_eq!(a.failed + b.failed, 0);
        for s in [&a, &b] {
            for pt in &s.parts {
                assert!(pt.mesh.is_closed_exact(), "Teil geschlossen");
                assert!(pt.mesh.volume() > 0.0);
            }
        }
        // Keine Überlappung: Schnitt der beiden Dachkörper leer.
        let sa = Solid::new_exact(&a.parts[0].mesh).unwrap();
        let sb = Solid::new_exact(&b.parts[0].mesh).unwrap();
        assert!(sa.intersection(&sb).unwrap().volume() < 1e-9);
        // Vereinigt = Hülle: kleiner als die Summe der unverschnittenen Dächer.
        let raw: f64 = ["A", "B"].iter().map(|_| 0.0).sum::<f64>();
        let _ = raw;
        let vol = total_volume(&p);
        let single = |r: &Roof| crate::model3d::roof_plane_prisms(&crate::roof::roof_geometry(&r.params(), 3.0).planes, 0.0, 0.25).iter().map(|m| m.volume()).sum::<f64>();
        let rs = p.roofs.as_ref().unwrap();
        let sum = single(&rs[0]) + single(&rs[1]);
        assert!(vol < sum - 0.5, "überlappendes Volumen entfernt: {vol} vs {sum}");
        // Aufsicht: Kehle(n) als Grat-Linien vorhanden.
        let edges = assembly_edges(&p);
        let hips = edges.iter().filter(|e| e.3 == EdgeKind::Hip).count();
        assert!(hips >= 1, "Kehle sichtbar: {edges:?}");
        assert!(edges.iter().any(|e| e.0 == 0) && edges.iter().any(|e| e.0 == 1));
    }

    #[test]
    fn separate_roofs_are_not_assembled() {
        let p = base_project(serde_json::json!([sattel("A", [[0.0, 0.0], [5.0, 5.0]], "x"), sattel("B", [[10.0, 0.0], [15.0, 5.0]], "x")]));
        assert!(roof_solids(&p, 0).is_none() && roof_solids(&p, 1).is_none());
    }

    #[test]
    fn dormers_cut_main_roof_and_are_closed() {
        for kind in ["sattel", "schlepp", "flach", "walm"] {
            let mut r = sattel("R", [[0.0, 0.0], [10.0, 8.0]], "x");
            r["pitchDeg"] = 45.into();
            r["overhang"] = 0.4.into();
            r["dormers"] = serde_json::json!([{"id": "D", "kind": kind, "position": {"x": 4.0, "y": 1.2}, "width": 2.4, "frontHeight": 1.5}]);
            let p = base_project(serde_json::json!([r]));
            let s = roof_solids(&p, 0).expect("verschnitten");
            assert_eq!(s.failed, 0, "{kind}");
            let roles = |role: Role| s.parts.iter().filter(|pt| pt.role == role).count();
            assert_eq!(roles(Role::RoofLayer), 1, "{kind}");
            assert_eq!(roles(Role::DormerRoof), 1, "{kind}");
            assert_eq!(roles(Role::DormerWall), 3, "{kind}: Stirn + 2 Wangen");
            for pt in &s.parts {
                assert!(pt.mesh.is_closed_exact(), "{kind} {:?}", pt.role);
                assert!(pt.mesh.volume() > 1e-4, "{kind} {:?}", pt.role);
            }
            // Gaubendach und Hauptdach überlappen nicht.
            let main = Solid::new_exact(&s.parts[0].mesh).unwrap();
            for pt in &s.parts[1..] {
                let v = main.intersection(&Solid::new_exact(&pt.mesh).unwrap()).unwrap().volume();
                assert!(v < 1e-7, "{kind} {:?}: {v}", pt.role);
            }
            // Hauptdach hat ein Loch: Volumen kleiner als ohne Gaube.
            let roof = &p.roofs.as_ref().unwrap()[0];
            let full: f64 = crate::model3d::roof_plane_prisms(&crate::roof::roof_geometry(&roof.params(), 3.0).planes, 0.0, 0.25).iter().map(|m| m.volume()).sum();
            assert!(s.parts[0].mesh.volume() < full - 0.5, "{kind}");
            assert!(s.skin.is_closed_exact());
        }
    }

    /// Ansicht: koplanare Dreiecke zu Flächen (mit Loch ⇒ Dreiecke); Fläche bleibt gleich.
    #[test]
    fn planar_faces_keep_area() {
        let mut r = sattel("R", [[0.0, 0.0], [10.0, 8.0]], "x");
        r["dormers"] = serde_json::json!([{"id": "D", "kind": "sattel", "position": {"x": 4.0, "y": 1.2}, "width": 2.4, "frontHeight": 1.3}]);
        let p = base_project(serde_json::json!([r]));
        let s = roof_solids(&p, 0).unwrap();
        let all: Vec<usize> = (0..s.skin.indices.len() / 3).collect();
        let area3 = |pts: &[V3]| {
            let mut a = [0.0; 3];
            for k in 1..pts.len() - 1 {
                let c = crate::opening_shape::cross([pts[k][0] - pts[0][0], pts[k][1] - pts[0][1], pts[k][2] - pts[0][2]], [pts[k + 1][0] - pts[0][0], pts[k + 1][1] - pts[0][1], pts[k + 1][2] - pts[0][2]]);
                for i in 0..3 {
                    a[i] += c[i] / 2.0;
                }
            }
            crate::opening_shape::dot(a, a).sqrt()
        };
        let tri_area: f64 = all.iter().map(|&t| area3(&tri(&s.skin, &s.skin.indices[t * 3..t * 3 + 3]))).sum();
        let faces = planar_faces(&s.skin, &all);
        let face_area: f64 = faces.iter().map(|f| area3(f)).sum();
        assert!((tri_area - face_area).abs() < 1e-6 * tri_area, "{tri_area} vs {face_area}");
        assert!(faces.len() * 2 < all.len(), "zusammengefasst: {} Flächen aus {} Dreiecken", faces.len(), all.len());
    }

    #[test]
    fn section_through_dormer_hits_all_parts() {
        let mut r = sattel("R", [[0.0, 0.0], [10.0, 8.0]], "x");
        r["dormers"] = serde_json::json!([{"id": "D", "kind": "sattel", "position": {"x": 4.0, "y": 1.2}, "width": 2.4, "frontHeight": 1.5}]);
        let p = base_project(serde_json::json!([r]));
        let s = roof_solids(&p, 0).unwrap();
        // Schnitt längs y durch die Gaubenmitte (x = 4).
        let n: usize = s.parts.iter().map(|pt| section_rings(&pt.mesh, (4.0, -5.0), (0.0, 1.0)).len()).sum();
        assert!(n >= 4, "Hauptdach (2 Seiten), Gaubendach, Stirn: {n}");
    }
}
