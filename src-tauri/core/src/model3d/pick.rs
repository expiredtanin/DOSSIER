//! Pick-Geometrie für den 3D-Viewport: vereinfachte Körper je Element (Öffnungen, Treppen, Dächer,
//! Kontext, Stützen, Bäume, Körper, Zeichnungen) für Raycast und Auswahl (`pick_geometry()`). Aufgerufen
//! von den 3D-Abfragen (`queries.rs`) und der Explosionsansicht (`explode3d.rs`).

use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickBox {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub thickness: f64,
    pub height: f64,
    pub base_elevation: f64,
    pub opening_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickStair {
    pub outline: [[f64; 2]; 4],
    pub z_bottom: f64,
    pub z_top: f64,
    pub stair_id: String,
}

pub(super) type Tri = [V3; 3];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickRoof {
    pub tris: Vec<Tri>,
    pub roof_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickContextMesh {
    pub tris: Vec<Tri>,
    pub context_object_id: String,
}

/// [137] Stütze für den 3D-Pick: Welt-Dreiecke ihres Prismas.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickColumn {
    pub tris: Vec<Tri>,
    pub column_id: String,
}

/// [149] Baum für den 3D-Pick.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickTree {
    pub tris: Vec<Tri>,
    pub tree_id: String,
}

/// [137] Öffnung ohne Wand (Dach, Decke, Gaube) für den 3D-Pick: Welt-Dreiecke ihrer Teile.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickOpeningMesh {
    pub tris: Vec<Tri>,
    pub opening_id: String,
}

/// [137] Freier Körper für den 3D-Pick: Welt-Dreiecke.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickSolid {
    pub tris: Vec<Tri>,
    pub solid_id: String,
}

/// [137] Treppen-Geländer (Handlauf, Pfosten) für den 3D-Pick: Welt-Dreiecke; ragen über die Hülle
/// ([`PickStair`]) hinaus (oberes Podest).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickStairMesh {
    pub tris: Vec<Tri>,
    pub stair_id: String,
}

/// [137] Flächige Pick-Form eines 2D-Elements, das im 3D keine Linie ist (Kreis, Bogen, Ellipse, Text): Welt-Dreiecke
/// auf Geschosshöhe.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickDrawingMesh {
    pub tris: Vec<Tri>,
    pub drawing_id: String,
}

#[derive(Debug, Serialize)]
pub struct PickGeometry {
    pub walls: Vec<RWall>,
    pub slabs: Vec<RSlab>,
    pub openings: Vec<PickBox>,
    pub stairs: Vec<PickStair>,
    pub roofs: Vec<PickRoof>,
    #[serde(rename = "contextMeshes")]
    pub context_meshes: Vec<PickContextMesh>,
    /// [137] Stützen (vorher im 3D nicht anwählbar).
    pub columns: Vec<PickColumn>,
    /// [137] Freie Körper (Dreiecke des Kern-Netzes, [115]).
    pub solids: Vec<PickSolid>,
    /// [137] Öffnungen in Dach/Decke/Gaube als Netz.
    #[serde(rename = "openingMeshes")]
    pub opening_meshes: Vec<PickOpeningMesh>,
    pub drawings: Vec<PickDrawingSeg>,
    /// [137] Treppengeländer.
    #[serde(rename = "stairMeshes")]
    pub stair_meshes: Vec<PickStairMesh>,
    /// [137] Kreise, Bögen, Ellipsen und Texte als flache Pick-Flächen.
    #[serde(rename = "drawingMeshes")]
    pub drawing_meshes: Vec<PickDrawingMesh>,
    /// [149] Bäume (Stamm + Krone).
    pub trees: Vec<PickTree>,
}

/// Öffnungen als Quader (Laibung zu Laibung, Wanddicke, Brüstung bis Sturz) für Pick und Hervorhebung.
pub fn pick_openings(p: &Project) -> Vec<PickBox> {
    let mut openings = Vec::new();
    for o in p.openings.as_deref().unwrap_or(&[]) {
        let Some(wall) = p.walls.iter().find(|w| w.id == o.host_wall_id) else { continue };
        let wr = wall_ref(p, wall);
        let Some((mut jamb_start, mut jamb_end)) = opening_geom::opening_jambs(&wr, o.position, o.width) else { continue };
        // Bogenwand ([T2]): Laibungen auf dem Bogen (Sehne als Pick-Quader).
        if let Some(a) = crate::wall_arc::WallArc::of_wall(wall) {
            let (ps, pe) = (a.point(jamb_start.x, 0.0), a.point(jamb_end.x, 0.0));
            jamb_start = opening_geom::v(ps.x, ps.y);
            jamb_end = opening_geom::v(pe.x, pe.y);
        }
        let thickness = Project::type_thickness(&p.wall_type_or_fallback(wall).layers);
        let (zb, zt) = p.wall_vertical_extent(wall);
        let o_bottom = zb + o.sill_height.max(0.0);
        let o_top = p.opening_top_under_ceilings(wall, o, o_bottom, zt.min(o_bottom + o.height));
        if o_top - o_bottom <= 0.0 {
            continue;
        }
        openings.push(PickBox {
            start: [jamb_start.x, jamb_start.y],
            end: [jamb_end.x, jamb_end.y],
            thickness,
            height: o_top - o_bottom,
            base_elevation: o_bottom,
            opening_id: o.id.clone(),
        });
    }
    openings
}

/// Treppen als achsparallele Hülle (UK bis OK) für Pick und Hervorhebung.
pub fn pick_stairs(p: &Project) -> Vec<PickStair> {
    let mut stairs = Vec::new();
    for st in p.stairs.as_deref().unwrap_or(&[]) {
        let (z_bottom, z_top) = p.stair_vertical_extent(st);
        let total_rise = z_top - z_bottom;
        if total_rise <= 0.0 {
            continue;
        }
        let geo = crate::stair::geometry(&st.encode(), total_rise);
        let b = crate::stair::bbox(&geo);
        let (min_x, min_y, max_x, max_y) = if b.len() >= 4 { (b[0], b[1], b[2], b[3]) } else { (0.0, 0.0, 0.0, 0.0) };
        stairs.push(PickStair { outline: [[min_x, min_y], [max_x, min_y], [max_x, max_y], [min_x, max_y]], z_bottom, z_top, stair_id: st.id.clone() });
    }
    stairs
}

/// Geometrie für den 3D-Raycast (`pickGeometry`).
pub fn pick_geometry(p: &Project) -> Result<PickGeometry, String> {
    // Dächer: Flächen + Giebel als Welt-Dreiecke (Fächer ab Punkt 0), Modell [x, y, h] → Welt [x, h, y].
    let mut roofs = Vec::new();
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        let to_world = |q: &V3| -> V3 { [q[0], q[2], q[1]] };
        // [137] Dachkörper wie gezeichnet (Gauben, Verschneidungen, Löcher der Dachfenster); ohne Körper die Flächen.
        let mut tris: Vec<Tri> = emit_roofs(p, Some(&roof.id)).unwrap_or_default().iter().flat_map(|m| extrusion_tris(&m.positions, &m.indices)).collect();
        let planes: &[Vec<V3>] = if tris.is_empty() { &g.planes } else { &[] };
        for poly in planes.iter().chain(g.gables.iter()) {
            for i in 1..poly.len().saturating_sub(1) {
                tris.push([to_world(&poly[0]), to_world(&poly[i]), to_world(&poly[i + 1])]);
            }
        }
        if !tris.is_empty() {
            roofs.push(PickRoof { tris, roof_id: roof.id.clone() });
        }
    }
    let openings = pick_openings(p);
    let stairs = pick_stairs(p);
    // Kontext-Meshes: rohe Welt-Dreiecke, Modell (x, y, z) → Welt (x, z, −y).
    let mut context_meshes = Vec::new();
    // [137] Was im 3D nicht gezeichnet wird (Klasse aus), fängt auch keinen Klick.
    let hidden = hidden_category_codes(&p.layers);
    for obj in p.context.as_deref().unwrap_or(&[]) {
        if hidden.contains(obj.category_code()) {
            continue;
        }
        let (pos, idx, id) = match obj {
            ContextObject::TerrainMesh(m) => {
                let (pos, idx, _) = crate::excavation::terrain_model_mesh(p, m);
                (pos, idx, &m.id)
            }
            ContextObject::ImportedMesh(m) => (std::borrow::Cow::Borrowed(m.positions.as_slice()), std::borrow::Cow::Borrowed(m.indices.as_slice()), &m.id),
            // [68] Verbauwand: Körper der Baugrube (Positionen im Modell, Welt wie die übrigen Kontext-Meshes).
            ContextObject::Excavation(e) => {
                if let Some(s) = crate::excavation::shoring_solids(p).into_iter().find(|s| s.excavation_id == e.id) {
                    let at = |i: u32| -> V3 { [s.pos[i as usize * 3], s.pos[i as usize * 3 + 2], -s.pos[i as usize * 3 + 1]] };
                    let tris: Vec<Tri> = s.idx.chunks_exact(3).map(|t| [at(t[0]), at(t[1]), at(t[2])]).collect();
                    if !tris.is_empty() {
                        context_meshes.push(PickContextMesh { tris, context_object_id: e.id.clone() });
                    }
                }
                continue;
            }
            _ => continue,
        };
        let (pos, idx) = (&*pos, &*idx);
        let vcount = pos.len() / 3;
        let at = |i: usize| -> V3 { [pos[i * 3], pos[i * 3 + 2], -pos[i * 3 + 1]] };
        // [137] Dreiecke im Wirkbereich einer Baugrube (Sohle, Böschungen) wählen die Baugrube.
        let site = match obj {
            ContextObject::TerrainMesh(m) => Some(crate::excavation::site_terrain(p, m)),
            _ => None,
        };
        let site = site.filter(|st| !st.items.is_empty());
        let orig_idx = site.as_ref().map(|st| st.index_orig());
        let boxes: Vec<[f64; 4]> = site.as_ref().map_or_else(Vec::new, |st| {
            st.items
                .iter()
                .map(|(eid, ..)| crate::excavation::affected_hull(st, eid).iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]))
                .collect()
        });
        let mut tris: Vec<Tri> = Vec::new();
        let mut owned: Vec<(String, Vec<Tri>)> = Vec::new();
        for t in idx.chunks_exact(3) {
            let ok = |v: f64| v >= 0.0 && v.fract() == 0.0 && (v as usize) < vcount;
            if !(ok(t[0]) && ok(t[1]) && ok(t[2])) {
                continue;
            }
            let tri = [at(t[0] as usize), at(t[1] as usize), at(t[2] as usize)];
            let owner = match (&site, &orig_idx) {
                (Some(st), Some(oi)) => {
                    let (cx, cy) = ((tri[0][0] + tri[1][0] + tri[2][0]) / 3.0, -(tri[0][2] + tri[1][2] + tri[2][2]) / 3.0);
                    let near = boxes.iter().any(|b| cx >= b[0] - 0.01 && cx <= b[2] + 0.01 && cy >= b[1] - 0.01 && cy <= b[3] + 0.01);
                    if near { crate::excavation::owner_at(st, oi, cx, cy) } else { None }
                }
                _ => None,
            };
            match owner {
                Some(eid) => match owned.iter_mut().find(|(i, _)| i == eid) {
                    Some((_, l)) => l.push(tri),
                    None => owned.push((eid.to_string(), vec![tri])),
                },
                None => tris.push(tri),
            }
        }
        if !tris.is_empty() {
            context_meshes.push(PickContextMesh { tris, context_object_id: id.clone() });
        }
        for (eid, tris) in owned {
            context_meshes.push(PickContextMesh { tris, context_object_id: eid });
        }
    }
    Ok(PickGeometry {
        walls: emit_walls(p, true)?,
        slabs: emit_slabs(p),
        openings,
        stairs,
        roofs,
        context_meshes,
        columns: pick_columns(p),
        solids: pick_solids(p),
        opening_meshes: pick_hosted_openings(p),
        drawings: pick_drawing_segs(p, &HashMap::new()),
        stair_meshes: pick_stair_railings(p),
        drawing_meshes: pick_drawing_meshes(p, &HashMap::new()),
        trees: pick_trees(p),
    })
}

/// [137] Handläufe und Pfosten der Treppen als Welt-Dreiecke je Treppe (wie [`emit_stair_railings`]).
pub fn pick_stair_railings(p: &Project) -> Vec<PickStairMesh> {
    let (mut out, guards) = pick_stair_railings_split(p);
    for (_, g) in guards {
        match out.iter_mut().find(|o| o.stair_id == g.stair_id) {
            Some(o) => o.tris.extend(g.tris),
            None => out.push(g),
        }
    }
    out.retain(|o| !o.tris.is_empty());
    out
}

/// Handläufe je Treppe und, getrennt, die Absturzsicherungen mit der Geschoss-id der Decke mit dem Loch
/// (Explosionsbild: Sicherung folgt dem Geschoss der Decke, nicht dem der Treppe).
pub fn pick_stair_railings_split(p: &Project) -> (Vec<PickStairMesh>, Vec<(String, PickStairMesh)>) {
    let (stairs, buf) = stair_input(p, |s, st| s.shape != StairShape::Unknown && st.and_then(|t| t.railing).is_some_and(|r| r != StairTypeRailing::Keine)).unwrap_or_default();
    let mut out: Vec<PickStairMesh> = Vec::new();
    for m in crate::stairs3d::railings(&buf) {
        let Some(&(_, stair)) = stairs.get(m.src) else { continue };
        let tris = extrusion_tris(&m.positions, &m.indices);
        match out.iter_mut().find(|o| o.stair_id == stair.id) {
            Some(o) => o.tris.extend(tris),
            None => out.push(PickStairMesh { tris, stair_id: stair.id.clone() }),
        }
    }
    // [155] Absturzsicherung gehört zur Treppe, die darin ankommt (pickbar mit ihr), steht aber auf dem Geschoss der Decke.
    let mut guards: Vec<(String, PickStairMesh)> = Vec::new();
    for (si, floor, m) in stair_guard_meshes_by_floor(p) {
        let Some(stair) = p.stairs.as_deref().and_then(|v| v.get(si)) else { continue };
        let tris = extrusion_tris(&m.positions, &m.indices);
        if !tris.is_empty() {
            guards.push((floor, PickStairMesh { tris, stair_id: stair.id.clone() }));
        }
    }
    out.retain(|o| !o.tris.is_empty());
    (out, guards)
}

/// [137] Kreis, Bogen, Ellipse und Text (im 3D nicht als Linie gezeichnet, z. B. Bäume und Symbole) als flache
/// Pick-Flächen auf Geschosshöhe (+ `lift` der Explosion): Kreis/Ellipse als Scheibe, Bogen als Band der
/// Pick-Toleranz, Text als gedrehtes Rechteck (Breite ≈ 0.6 · Höhe je Zeichen bzw. Spaltenbreite).
pub(crate) fn pick_drawing_meshes(p: &Project, lift: &HashMap<String, f64>) -> Vec<PickDrawingMesh> {
    const N: usize = 32;
    let mut out = Vec::new();
    for d in &p.drawings2d {
        let elev = p.floor(&d.level_id).map_or(0.0, |l| l.base_elevation.unwrap_or(0.0)) + DRAWING_LINE_ELEVATION_EPS + lift.get(d.level_id.as_str()).copied().unwrap_or(0.0);
        let mut tris: Vec<Tri> = Vec::new();
        let at = |x: f64, y: f64| -> V3 { [x, elev, y] };
        let fan = |c: Vec2, rx: f64, ry: f64, rot: f64, tris: &mut Vec<Tri>| {
            let (sr, cr) = (rot.sin(), rot.cos());
            let pt = |i: usize| {
                let a = std::f64::consts::TAU * (i % N) as f64 / N as f64;
                let (x, y) = (rx * a.cos(), ry * a.sin());
                at(c.x + x * cr - y * sr, c.y + x * sr + y * cr)
            };
            for i in 0..N {
                tris.push([at(c.x, c.y), pt(i), pt(i + 1)]);
            }
        };
        match &d.geom {
            Drawing2DGeom::Circle { center, r } if r.is_finite() && *r > 0.0 => fan(*center, r.max(DRAWING_PICK_TOLERANCE), r.max(DRAWING_PICK_TOLERANCE), 0.0, &mut tris),
            Drawing2DGeom::Ellipse { center, rx, ry, rotation } if rx.is_finite() && ry.is_finite() && rotation.is_finite() && *rx > 0.0 && *ry > 0.0 => fan(*center, rx.max(DRAWING_PICK_TOLERANCE), ry.max(DRAWING_PICK_TOLERANCE), *rotation, &mut tris),
            Drawing2DGeom::Arc { center, r, a0, a1 } if [r, a0, a1].iter().all(|v| v.is_finite()) && *r > 0.0 => {
                let mut sweep = (a1 - a0) % std::f64::consts::TAU;
                if sweep <= 0.0 {
                    sweep += std::f64::consts::TAU;
                }
                let (ri, ro) = ((r - DRAWING_PICK_TOLERANCE).max(0.0), r + DRAWING_PICK_TOLERANCE);
                let pt = |i: usize, rr: f64| {
                    let a = a0 + sweep * i as f64 / N as f64;
                    at(center.x + rr * a.cos(), center.y + rr * a.sin())
                };
                for i in 0..N {
                    tris.push([pt(i, ri), pt(i, ro), pt(i + 1, ro)]);
                    tris.push([pt(i, ri), pt(i + 1, ro), pt(i + 1, ri)]);
                }
            }
            Drawing2DGeom::Text { at: pos, text, height, angle, width, .. } if height.is_finite() && *height > 0.0 && angle.is_finite() => {
                let lines = text.lines().count().max(1) as f64;
                let longest = text.lines().map(|l| l.chars().count()).max().unwrap_or(0).max(1) as f64;
                let w = width.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(longest * 0.6 * height).max(*height);
                let h = (lines * height * 1.2).max(*height);
                let (sa, ca) = (angle.sin(), angle.cos());
                let c = |x: f64, y: f64| at(pos.x + x * ca - y * sa, pos.y + x * sa + y * ca);
                tris.push([c(0.0, 0.0), c(w, 0.0), c(w, h)]);
                tris.push([c(0.0, 0.0), c(w, h), c(0.0, h)]);
            }
            _ => {}
        }
        if !tris.is_empty() {
            out.push(PickDrawingMesh { tris, drawing_id: d.id.clone() });
        }
    }
    out
}

/// [137] Öffnungen in Dach, Decke oder Gaube (Dachfenster, Deckenöffnung, Gaubenfenster): ihre 3D-Teile
/// (Rahmen, Glas, Eindeckrahmen) als Welt-Dreiecke — sie haben keine Wand-Box wie [`pick_openings`].
pub fn pick_hosted_openings(p: &Project) -> Vec<PickOpeningMesh> {
    let hosted: Vec<&Opening> = p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| o.host_roof_id.is_some() || o.host_ceiling_id.is_some() || o.host_dormer_id.is_some()).collect();
    if hosted.is_empty() {
        return Vec::new();
    }
    let mut q = p.clone();
    q.context = None;
    q.drawings2d.clear();
    let mut out = Vec::new();
    for o in hosted {
        q.openings = Some(vec![o.clone()]);
        let tris: Vec<Tri> = emit_opening_meshes(&q, 1.0).iter().flat_map(|m| extrusion_tris(&m.positions, &m.indices)).collect();
        if !tris.is_empty() {
            out.push(PickOpeningMesh { tris, opening_id: o.id.clone() });
        }
    }
    out
}

/// [137] Freie Körper (`extrudedSolids`, ohne Abzugskörper) als Welt-Dreiecke ihres 3D-Netzes aus dem Kern
/// ([115], `solid_mesh::body_mesh_3d`, dasselbe Netz wie im Bild). Ohne Netz (unbaubare Beschreibung) das
/// Prisma über dem Grundriss-Umriss (UK = Geschoss-UK + `baseOffset`, OK = UK + `height`).
pub fn pick_solids(p: &Project) -> Vec<PickSolid> {
    let mut out = Vec::new();
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") || !(s.height > 0.0) {
            continue;
        }
        let mesh = crate::solid_mesh::body_mesh_3d(p, s);
        let tris = match mesh.as_deref().and_then(Option::as_ref) {
            Some(m) => extrusion_tris(&m.positions, &m.indices),
            None => {
                let z0 = solid_base_z(p, s);
                let foot: Vec<[f64; 2]> = s.points.iter().map(|q| [q.x, q.y]).collect();
                if foot.len() < 3 || !(z0.is_finite() && foot.iter().all(|q| q[0].is_finite() && q[1].is_finite())) {
                    continue;
                }
                let (pos, idx) = crate::columns3d::prism(&foot, z0, z0 + s.height);
                extrusion_tris(&pos, &idx)
            }
        };
        if !tris.is_empty() {
            out.push(PickSolid { tris, solid_id: s.id.clone() });
        }
    }
    out
}

/// UK eines freien Körpers (Geschoss-UK + `baseOffset`).
pub fn solid_base_z(p: &Project, s: &ExtrudedSolid) -> f64 {
    p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + s.base_offset.unwrap_or(0.0)
}

/// Modell-Netz (x, y, z = Höhe) eines plan-abgeleiteten Körpers (render3d `MeshKind::Extrusion`) als
/// Welt-Dreiecke (x, Höhe, y) — ohne Vorzeichenwechsel, anders als Gelände/Import (x, Höhe, −y).
pub(super) fn extrusion_tris(pos: &[f64], idx: &[u32]) -> Vec<Tri> {
    let at = |i: u32| -> V3 { let i = i as usize * 3; [pos[i], pos[i + 2], pos[i + 1]] };
    idx.chunks_exact(3).filter(|t| t.iter().all(|&i| (i as usize) * 3 + 2 < pos.len())).map(|t| [at(t[0]), at(t[1]), at(t[2])]).collect()
}

/// [137] Stützen als Welt-Dreiecke (Prisma aus Querschnitt und Höhenlage, wie [`emit_columns`]).
fn pick_columns(p: &Project) -> Vec<PickColumn> {
    let mut out = Vec::new();
    for col in p.columns.as_deref().unwrap_or(&[]) {
        if !(col.height > 0.0) {
            continue;
        }
        let Some((pos, idx)) = column_mesh(p, col) else { continue };
        let tris = extrusion_tris(&pos, &idx);
        if !tris.is_empty() {
            out.push(PickColumn { tris, column_id: col.id.clone() });
        }
    }
    out
}
