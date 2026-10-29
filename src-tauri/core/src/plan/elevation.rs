//! Ansicht auf dem Dokument ([K3c]): Rust-Gegenstück zu `src/plan/toElevation.ts` (Orchestrierung,
//! Stil, Painter-Reihenfolge). Die Geometrie (Flächen, Eck-Verlängerung, Öffnungen, Verdeckung,
//! Schatten, XOR-Umriss) rechnet `plan_elevation.rs`; hier werden sie aus dem Dokument gespeist,
//! gestylt, mit Pick-Ids versehen und fern → nah sortiert. Zahlsemantik wie in TS.

use super::prim::Primitive;
use super::section::{line, polygon, v2, Acc, LevelSpec, Visibility};
use super::style::no_hatch;
use crate::js_fmt::js_number;
use crate::jsmath::{hypot, hypot2};
use crate::jsnum::{max, min, round};
use crate::model::*;
use crate::model3d::{self, RSlab, RWall};
use crate::plan::overrides::js_trim;
use std::collections::HashMap;

const EDGE_INK: &str = "#2b3039";
const EDGE_MM: f64 = 0.13;
const FRAME_MM: f64 = 0.18;
const GLASS_FILL_MONO: &str = "#c4c8cd";
const GLASS_FILL_COLOR: &str = "#9fc2d9";
const SHADOW_FILL: &str = "#8f959e";
const OPENING_SHADOW_FILL: &str = "#a7adb5";
const GROUND_INK: &str = "#1f242c";
const GROUND_MM: f64 = 0.5;
const FRAME_FILL_COLOR: &str = "#d9d9d4";
const SILL_FILL_COLOR: &str = "#cccccb";
const DOOR_LEAF_FILL_COLOR: &str = "#ede6d9";
const SYMBOL_INK: &str = "#7d858f";
const ROOF_RGB_FALLBACK: [f64; 3] = [0.72, 0.45, 0.36];
const EPS: f64 = 1e-6;

type Pt = [f64; 2];

/// `hexToRgb` der Ansicht (mit JS-`trim`).
fn hex_to_rgb(hex: &str, fallback: [f64; 3]) -> [f64; 3] {
    let t = js_trim(hex);
    let h = t.strip_prefix('#').unwrap_or(t);
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return fallback;
    }
    let p = |i: usize| u32::from_str_radix(&h[i..i + 2], 16).unwrap_or(0) as f64 / 255.0;
    [p(0), p(2), p(4)]
}

/// `rgbToHex`.
fn rgb_to_hex(c: [f64; 3]) -> String {
    let b = |v: f64| -> String {
        let x = max(0.0, min(255.0, round(v * 255.0)));
        if x.is_nan() {
            return "NaN".into();
        }
        format!("{:02x}", x as u32)
    };
    format!("#{}{}{}", b(c[0]), b(c[1]), b(c[2]))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Wall,
    Slab,
    Roof,
}

struct Face {
    pts: Vec<Pt>,
    depth: f64,
    depth_min: f64,
    depth_max: f64,
    role: Role,
    id: String,
    fill: [f64; 3],
    normal: [f64; 3],
}

/// `elevationFrame` flach: `[P, N, U]`.
fn frame_of(plane: &super::section::Plane) -> [f64; 9] {
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

struct RoofIn {
    id: String,
    fill: [f64; 3],
    planes: Vec<Vec<[f64; 3]>>,
    gables: Vec<Vec<[f64; 3]>>,
}

/// `projectFaces`.
fn project_faces(frame: &[f64; 9], walls: &[RWall], slabs: &[RSlab], roofs: &[RoofIn]) -> Vec<Face> {
    let mut w = vec![walls.len() as f64];
    for x in walls {
        w.extend([x.start[0], x.start[1], x.end[0], x.end[1], x.thickness, x.height, x.base_elevation]);
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
    let f = crate::plan_elevation::faces(frame, &w, &sl, &r);
    let mut out = Vec::new();
    let n = f.first().copied().unwrap_or(0.0) as usize;
    let mut i = 1;
    for _ in 0..n {
        let role = match f[i] as i64 {
            0 => Role::Wall,
            1 => Role::Slab,
            _ => Role::Roof,
        };
        let src = f[i + 1] as usize;
        let count = f[i + 8] as usize;
        let pts = (0..count).map(|j| [f[i + 9 + 2 * j], f[i + 10 + 2 * j]]).collect();
        let (id, fill) = match role {
            Role::Wall => (walls[src].wall_id.clone(), walls[src].color),
            Role::Slab => (slabs[src].ceiling_id.clone(), slabs[src].color),
            Role::Roof => (roofs[src].id.clone(), roofs[src].fill),
        };
        out.push(Face { pts, depth: f[i + 2], depth_min: f[i + 3], depth_max: f[i + 4], role, id, fill, normal: [f[i + 5], f[i + 6], f[i + 7]] });
        i += 9 + 2 * count;
    }
    out
}

/// `collectRoofFaces`.
fn collect_roof_faces(p: &Project, frame: &[f64; 9]) -> Result<Vec<Face>, String> {
    let mut roofs = Vec::new();
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
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
        roofs.push(RoofIn { id: roof.id.clone(), fill, planes: g.planes.clone(), gables: g.gables.clone() });
    }
    Ok(project_faces(frame, &[], &[], &roofs))
}

/// `extendWallCornersForElevation`.
fn extend_wall_corners(p: &Project, rwalls: &mut [RWall], u: (f64, f64)) {
    let mut floors: HashMap<&str, usize> = HashMap::new();
    let mut b = vec![p.walls.len() as f64];
    for w in &p.walls {
        let n = floors.len();
        let k = *floors.entry(w.floor_id.as_str()).or_insert(n);
        let thickness = p.wall_type(w).map_or(0.2, |t| t.layers.iter().fold(0.0, |s, l| s + l.thickness));
        b.extend([k as f64, w.start.x, w.start.y, w.end.x, w.end.y, thickness / 2.0]);
    }
    let ext = crate::plan_elevation::wall_extensions(&b);
    if ext.is_empty() {
        return;
    }
    let mut by_wall: HashMap<&str, Vec<usize>> = HashMap::new();
    let ids: Vec<String> = rwalls.iter().map(|r| r.wall_id.clone()).collect();
    for (i, id) in ids.iter().enumerate() {
        by_wall.entry(id.as_str()).or_default().push(i);
    }
    let close = |a: [f64; 2], v: Vec2| (a[0] - v.x).abs() < 1e-6 && (a[1] - v.y).abs() < 1e-6;
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
        if e_start > EPS {
            if let Some(&i) = pieces.iter().find(|&&i| close(rwalls[i].start, w.start)) {
                let s = rwalls[i].start;
                rwalls[i].start = [s[0] - ux * e_start, s[1] - uz * e_start];
            }
        }
        if e_end > EPS {
            if let Some(&i) = pieces.iter().find(|&&i| close(rwalls[i].end, w.end)) {
                let e = rwalls[i].end;
                rwalls[i].end = [e[0] + ux * e_end, e[1] + uz * e_end];
            }
        }
    }
}

struct ProjOpening {
    pts: [Pt; 4],
    depth: f64,
    glass: Vec<[Pt; 4]>,
    door_leaf: Vec<[Pt; 4]>,
    divisions: Vec<(Pt, Pt)>,
    sash_rects: Vec<[Pt; 4]>,
    sill: Vec<[Pt; 4]>,
    symbol: Vec<(Pt, Pt)>,
    id: String,
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
fn collect_openings(p: &Project, frame: &[f64; 9]) -> Vec<ProjOpening> {
    let mut b = vec![0.0];
    let mut ids: Vec<&str> = Vec::new();
    let by_wall = p.openings_by_wall();
    for wall in &p.walls {
        let thickness = p.wall_type(wall).map_or(0.2, |t| t.layers.iter().fold(0.0, |s, l| s + l.thickness));
        for &op in by_wall.get(wall.id.as_str()).map_or(&[][..], |v| v.as_slice()) {
            let axis = hypot2(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
            let from = max(0.0, min(op.position, axis));
            let to = max(from, min(op.position + op.width, axis));
            if to - from < 1e-4 {
                continue;
            }
            let (zb, zt) = p.wall_vertical_extent(wall);
            let ob = zb + max(0.0, op.sill_height);
            let ot = min(zt, ob + op.height);
            let door = op.kind == ElementKind::Door;
            let dt = if door { p.door_type(op) } else { None };
            let wt = if door { None } else { p.window_type(op) };
            b.extend([
                wall.start.x,
                wall.start.y,
                wall.end.x,
                wall.end.y,
                thickness,
                from,
                to,
                ob,
                ot,
                if door { 1.0 } else { 0.0 },
                if dt.is_some_and(|d| d.leaf_style == DoorTypeLeafStyle::Glas) { 1.0 } else { 0.0 },
                dt.and_then(|d| d.glazing_ratio).unwrap_or(f64::NAN),
                wt.and_then(|t| t.frame_width).unwrap_or(0.06),
                wt.and_then(|t| t.transom_height).unwrap_or(0.0),
                wt.and_then(|t| t.mullion_rows).unwrap_or(f64::NAN),
                wt.and_then(|t| t.mullion_cols).unwrap_or(f64::NAN),
                if matches!(wt.and_then(|t| t.sill_board), Some(WindowTypeSillBoard::Keine | WindowTypeSillBoard::Innen)) { 0.0 } else { 1.0 },
                wt.map_or(0.0, |t| sash_kind(t.kind)),
            ]);
            // Flügel: (pfosten, postWidth, autoWidth, width, opening, hingeLeft).
            let mut sashes: Vec<[f64; 6]> = Vec::new();
            if !door {
                match wt {
                    Some(t) => match t.sashes.as_deref().filter(|s| !s.is_empty()) {
                        Some(list) => {
                            for s in list {
                                sashes.push([
                                    if s.kind == SashDefKind::Pfosten { 1.0 } else { 0.0 },
                                    s.post_width.unwrap_or(f64::NAN),
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
            ids.push(&op.id);
            b[0] += 1.0;
        }
    }
    let f = crate::plan_elevation::openings(frame, &b);
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
        out.push(ProjOpening { pts, depth, glass, door_leaf, divisions, sash_rects, sill, symbol, id: ids[k].to_string() });
    }
    out
}

fn encode_shadow_faces(faces: &[&Face]) -> Vec<f64> {
    let mut b = vec![faces.len() as f64];
    for f in faces {
        b.extend([f.depth, f.depth_min, f.pts.len() as f64]);
        for q in &f.pts {
            b.extend(q);
        }
    }
    b
}

/// Eintrag des Painter-Stroms.
struct Item {
    depth: f64,
    seq: usize,
    rank: Option<f64>,
    prim: Primitive,
}

enum Pending {
    /// `style`: Index in die Ansichtsschraffur-Stile (Strichstärke, Farbe); ohne = Kante.
    /// `paint`: Tiefe für die Maler-Reihenfolge, wenn sie von der Verdeckungstiefe abweicht (Muster-
    /// linien liegen knapp vor IHRER Fläche, auch wo sie tiefer liegen als deren Mittel).
    Line { a: Pt, b: Pt, depth: f64, style: Option<usize>, paint: Option<f64> },
    Item { depth: f64, rank: Option<f64>, prim: Primitive },
}

fn outline_line(a: Pt, b: Pt) -> Primitive {
    line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-outline", EDGE_MM, EDGE_INK)
}

/// Schlüssel einer Kante wie `edgeKey` (gerundet auf 0,1 mm, Endpunkte sortiert als Text).
fn edge_key(a: Pt, b: Pt) -> String {
    let r = |v: f64| js_number(round(v * 1e4));
    let ka = format!("{},{}", r(a[0]), r(a[1]));
    let kb = format!("{},{}", r(b[0]), r(b[1]));
    if ka < kb {
        format!("{ka}|{kb}")
    } else {
        format!("{kb}|{ka}")
    }
}

/// Schlüssel einer `Map<number, …>` (SameValueZero).
fn num_key(x: f64) -> u64 {
    if x == 0.0 {
        0
    } else if x.is_nan() {
        u64::MAX
    } else {
        x.to_bits()
    }
}

fn poly_prim(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, opening: Option<&str>) -> Primitive {
    let mut pr = polygon(pts, fill, stroke, w, no_hatch());
    if let (Primitive::Polygon { opening_id, .. }, Some(id)) = (&mut pr, opening) {
        *opening_id = Some(id.into());
    }
    pr
}

/// `generateElevationPlan`: Primitive und Ausmass; `None` ohne Ansichtslinie.
pub fn elevation_primitives(p: &Project, level: &LevelSpec, shadows: bool, mono: bool, vis: &Visibility, scale: f64) -> Result<Option<(Vec<Primitive>, [f64; 4])>, String> {
    let Some(plane) = level.plane() else { return Ok(None) };
    let frame = frame_of(&plane);
    let mut walls = model3d::emit_walls(p, false)?;
    let mut slabs = model3d::emit_slabs(p);
    slabs.extend(model3d::emit_stairs(p, false));
    extend_wall_corners(p, &mut walls, (frame[6], frame[8]));
    let mut faces = project_faces(&frame, &walls, &slabs, &[]);
    faces.extend(collect_roof_faces(p, &frame)?);

    // Kategorie einer Fläche (erstes Element mit der id, wie `find`).
    let mut wall_cat: HashMap<&str, &str> = HashMap::new();
    for w in &p.walls {
        wall_cat.entry(w.id.as_str()).or_insert(w.category_code.as_str());
    }
    let mut ceil_cat: HashMap<&str, &str> = HashMap::new();
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        ceil_cat.entry(c.id.as_str()).or_insert(c.category_code.as_str());
    }
    let mut roof_cat: HashMap<&str, &str> = HashMap::new();
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        roof_cat.entry(r.id.as_str()).or_insert(r.category_code.as_str());
    }
    let category = |f: &Face| -> Option<&str> {
        if f.id.is_empty() {
            return None;
        }
        match f.role {
            Role::Wall => wall_cat.get(f.id.as_str()).copied(),
            Role::Slab => ceil_cat.get(f.id.as_str()).copied(),
            Role::Roof => roof_cat.get(f.id.as_str()).copied(),
        }
    };
    if vis.has_vis && vis.has_display {
        faces.retain(|f| category(f).is_none_or(|c| vis.visible(c) && vis.render(c)));
    }
    let greyed = |f: &Face| vis.has_display && category(f).is_some_and(|c| vis.greyed(c));

    // Ansichtsfarbe und -schraffur ([94]) der sichtbaren Bauteilseite.
    let (pattern_lines, pattern_styles) = surface_patterns(p, &mut faces, &frame, scale, mono);
    let openings = collect_openings(p, &frame);
    let mut occ = vec![(faces.len() + openings.len()) as f64];
    for f in &faces {
        occ.extend([f.depth_max, f.pts.len() as f64]);
        for q in &f.pts {
            occ.extend(q);
        }
    }
    for op in &openings {
        occ.extend([op.depth, 4.0]);
        for q in &op.pts {
            occ.extend(q);
        }
    }
    let occluded = {
        let mut b = vec![openings.len() as f64];
        for op in &openings {
            let q = &op.pts;
            b.extend([(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0, op.depth]);
        }
        crate::plan_elevation::occluded_points(&occ, &b)
    };

    let mut acc = Acc::new();
    // Jede Fläche trägt ihre Bauteilfarbe (Wand/Decke aus dem 3D-Modell, Dach aus der Eindeckung).
    let fill_for = |fill: [f64; 3]| -> String { if mono { "#ffffff".into() } else { rgb_to_hex(fill) } };
    let mut items: Vec<Item> = Vec::new();
    let mut seq = 0usize;
    let mut pending: Vec<Pending> = Vec::new();

    let mut roof_edges: HashMap<String, Vec<usize>> = HashMap::new();
    for (fi, f) in faces.iter().enumerate() {
        if f.role != Role::Roof || f.id.is_empty() {
            continue;
        }
        for i in 0..f.pts.len() {
            roof_edges.entry(edge_key(f.pts[i], f.pts[(i + 1) % f.pts.len()])).or_default().push(fi);
        }
    }
    let coplanar_seam = |fi: usize, a: Pt, b: Pt| -> bool {
        let f = &faces[fi];
        if f.role != Role::Roof || f.id.is_empty() {
            return false;
        }
        roof_edges.get(&edge_key(a, b)).is_some_and(|list| {
            list.iter().any(|&oi| {
                let o = &faces[oi];
                oi != fi && o.id == f.id && f.normal[0] * o.normal[0] + f.normal[1] * o.normal[1] + f.normal[2] * o.normal[2] > 1.0 - 1e-9
            })
        })
    };
    let mut group_order: Vec<u64> = Vec::new();
    let mut groups: HashMap<u64, (Vec<usize>, f64)> = HashMap::new();
    for (fi, f) in faces.iter().enumerate() {
        let pts: Vec<Vec2> = f
            .pts
            .iter()
            .map(|q| {
                acc.add(q[0], q[1]);
                v2(q[0], q[1])
            })
            .collect();
        let is_roof = f.role == Role::Roof;
        let frontal = !is_roof && f.depth_max - f.depth_min < 1e-4;
        if frontal {
            let gk = num_key(round(f.depth * 1e4));
            groups
                .entry(gk)
                .or_insert_with(|| {
                    group_order.push(gk);
                    (Vec::new(), f.depth)
                })
                .0
                .push(fi);
        } else {
            for i in 0..f.pts.len() {
                let a = f.pts[i];
                let b = f.pts[(i + 1) % f.pts.len()];
                if coplanar_seam(fi, a, b) {
                    continue;
                }
                pending.push(Pending::Line { a, b, depth: f.depth_min - EPS * 5.0, style: None, paint: None });
            }
        }
        let mut prim = polygon(pts, &fill_for(f.fill), "none", 0.0, no_hatch());
        if let Primitive::Polygon { greyed: g, wall_id, ceiling_id, roof_id, .. } = &mut prim {
            *g = Some(greyed(f));
            if !f.id.is_empty() {
                match f.role {
                    Role::Wall => *wall_id = Some(f.id.clone()),
                    Role::Slab => *ceiling_id = Some(f.id.clone()),
                    Role::Roof => *roof_id = Some(f.id.clone()),
                }
            }
        }
        let rank = match f.role {
            Role::Slab => 0.0,
            Role::Wall => 1.0,
            Role::Roof => 2.0,
        };
        pending.push(Pending::Item { depth: f.depth, rank: Some(rank), prim });
    }
    for gk in &group_order {
        let (list, depth) = &groups[gk];
        let mut b = vec![list.len() as f64];
        for &fi in list {
            b.push(faces[fi].pts.len() as f64);
            for q in &faces[fi].pts {
                b.extend(q);
            }
        }
        let e = crate::plan_elevation::xor_outline(&b);
        for k in 0..e.first().copied().unwrap_or(0.0) as usize {
            let i = 1 + 4 * k;
            pending.push(Pending::Line { a: [e[i], e[i + 1]], b: [e[i + 2], e[i + 3]], depth: depth - EPS * 5.0, style: None, paint: None });
        }
    }
    for (a, b, depth, paint, k) in pattern_lines {
        pending.push(Pending::Line { a, b, depth, style: Some(k), paint: Some(paint) });
    }
    // Linien gebündelt gegen die Verdecker clippen (`flushPending`).
    {
        let mut q = vec![0.0];
        for pd in &pending {
            if let Pending::Line { a, b, depth, .. } = pd {
                q.extend([a[0], a[1], b[0], b[1], *depth]);
                q[0] += 1.0;
            }
        }
        let r = crate::plan_elevation::clip_segments(&occ, &q);
        let mut i = 1;
        for pd in pending {
            match pd {
                Pending::Item { depth, rank, prim } => {
                    items.push(Item { depth, seq, rank, prim });
                    seq += 1;
                }
                Pending::Line { a, b, depth, style, paint } => {
                    let c = if r.is_empty() {
                        1
                    } else {
                        i += 1;
                        r[i - 1] as usize
                    };
                    for _ in 0..c {
                        let (sa, sb) = if r.is_empty() {
                            (a, b)
                        } else {
                            let s = ([r[i], r[i + 1]], [r[i + 2], r[i + 3]]);
                            i += 4;
                            s
                        };
                        acc.add(sa[0], sa[1]);
                        acc.add(sb[0], sb[1]);
                        let prim = match style.and_then(|k| pattern_styles.get(k)) {
                            Some((w, c)) => line(v2(sa[0], sa[1]), v2(sb[0], sb[1]), "elevation-surface-pattern", *w, c),
                            None => outline_line(sa, sb),
                        };
                        items.push(Item { depth: paint.unwrap_or(depth), seq, rank: None, prim });
                        seq += 1;
                    }
                }
            }
        }
    }

    if shadows {
        let wall_faces: Vec<&Face> = faces.iter().filter(|f| f.role == Role::Wall).collect();
        let mut casters: Vec<&Face> = faces.iter().filter(|f| f.role == Role::Slab).collect();
        casters.extend(faces.iter().filter(|f| f.role == Role::Roof));
        let f = crate::plan_elevation::shadows(&encode_shadow_faces(&wall_faces), &encode_shadow_faces(&casters));
        let mut i = 1;
        for _ in 0..f.first().copied().unwrap_or(0.0) as usize {
            let depth = f[i];
            let count = f[i + 1] as usize;
            i += 2;
            let pts: Vec<Vec2> = (0..count)
                .map(|j| {
                    let (x, y) = (f[i + 2 * j], f[i + 2 * j + 1]);
                    acc.add(x, y);
                    v2(x, y)
                })
                .collect();
            i += 2 * count;
            items.push(Item { depth: depth - EPS * 10.0, seq, rank: None, prim: polygon(pts, SHADOW_FILL, "none", 0.0, no_hatch()) });
            seq += 1;
        }
    }

    for (k, op) in openings.iter().enumerate() {
        if occluded.get(1 + k) == Some(&1.0) {
            continue;
        }
        let mut to_vec = |q: &[Pt]| -> Vec<Vec2> {
            q.iter()
                .map(|p| {
                    acc.add(p[0], p[1]);
                    v2(p[0], p[1])
                })
                .collect()
        };
        let d = op.depth - EPS * 100.0;
        let id = Some(op.id.as_str());
        let mut push = |prim: Primitive| {
            items.push(Item { depth: d, seq, rank: None, prim });
            seq += 1;
        };
        push(poly_prim(to_vec(&op.pts), if mono { "#ffffff" } else { FRAME_FILL_COLOR }, EDGE_INK, FRAME_MM, id));
        for r in &op.sill {
            push(poly_prim(to_vec(r), if mono { "#ffffff" } else { SILL_FILL_COLOR }, EDGE_INK, EDGE_MM, id));
        }
        for r in &op.sash_rects {
            push(poly_prim(to_vec(r), "none", EDGE_INK, EDGE_MM, id));
        }
        for r in &op.glass {
            push(poly_prim(to_vec(r), if mono { GLASS_FILL_MONO } else { GLASS_FILL_COLOR }, EDGE_INK, EDGE_MM, id));
        }
        for r in &op.door_leaf {
            push(poly_prim(to_vec(r), if mono { "#ffffff" } else { DOOR_LEAF_FILL_COLOR }, EDGE_INK, EDGE_MM, id));
        }
        if shadows {
            let q = &op.pts;
            let lerp = |a: Pt, b: Pt, t: f64| -> Pt { [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
            let quad_at = |fa: f64, fz: f64| lerp(lerp(q[0], q[1], fa), lerp(q[3], q[2], fa), fz);
            let w_u = hypot2(q[1][0] - q[0][0], q[1][1] - q[0][1]);
            let h_v = hypot2(q[3][0] - q[0][0], q[3][1] - q[0][1]);
            let f_u = min(0.3, 0.08 / max(w_u, 1e-6));
            let f_v = min(0.3, 0.08 / max(h_v, 1e-6));
            for (fa0, fa1, fz0, fz1) in [(0.0, 1.0, 1.0 - f_v, 1.0), (0.0, f_u, 0.0, 1.0 - f_v)] {
                let r = [quad_at(fa0, fz0), quad_at(fa1, fz0), quad_at(fa1, fz1), quad_at(fa0, fz1)];
                push(polygon(to_vec(&r), OPENING_SHADOW_FILL, "none", 0.0, no_hatch()));
            }
        }
        for (a, b) in &op.divisions {
            push(line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-division", EDGE_MM, EDGE_INK));
        }
        for (a, b) in &op.symbol {
            let mut l = line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-opening-symbol", 0.1, SYMBOL_INK);
            if let Primitive::Line { dash, .. } = &mut l {
                *dash = Some(Some(vec![2.2, 1.8]));
            }
            push(l);
        }
    }

    // Painter: fern zuerst; Gleichstand nach Rang (Decke < Wand < Dach < Rest), dann Reihenfolge.
    let nz = |d: f64| if d.is_nan() { 0.0 } else { d };
    items.sort_by(|a, b| {
        let d = nz(b.depth - a.depth);
        if d != 0.0 {
            return super::section::cmp_num(d);
        }
        let r = nz(a.rank.unwrap_or(3.0) - b.rank.unwrap_or(3.0));
        if r != 0.0 {
            return super::section::cmp_num(r);
        }
        a.seq.cmp(&b.seq)
    });
    let mut prims: Vec<Primitive> = items.into_iter().map(|it| it.prim).collect();
    if acc.min_x.is_finite() && acc.min_y.is_finite() {
        prims.push(line(v2(acc.min_x, acc.min_y), v2(acc.max_x, acc.min_y), "elevation-ground", GROUND_MM, GROUND_INK));
    }
    Ok(Some((prims, acc.bounds())))
}

/// Bauteil der sichtbaren Wandseite: rechts der Achse (Anfang → Ende) liegt die äusserste Schicht
/// (`layers[0]`), links die innerste; Stirnseiten haben keine.
fn wall_side_component<'a>(p: &'a Project, wall: &Wall, normal: [f64; 3]) -> Option<&'a Component> {
    let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    let len = hypot2(dx, dy);
    if !(len > 1e-9) {
        return None;
    }
    // Plan (x, y) → Welt (x, Höhe, y); rechte Normale (dy, −dx).
    let side = (dy * normal[0] - dx * normal[2]) / len;
    let layers = &p.wall_type(wall)?.layers;
    let l = if side > 0.7 {
        layers.first()
    } else if side < -0.7 {
        layers.last()
    } else {
        None
    }?;
    p.component(&l.component_id)
}

/// Strichstärke und Farbe einer Ansichtsschraffur.
fn pattern_style(sp: &SurfacePattern, comp: &Component) -> (f64, String) {
    let w = sp.weight_mm.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(0.1);
    let c = sp.color.clone().or_else(|| comp.foreground.clone()).filter(|c| !c.trim().is_empty()).unwrap_or_else(|| PATTERN_INK.into());
    (w, c)
}

const PATTERN_INK: &str = "#3a3f47";

/// Linie der Ansichtsschraffur: Endpunkte, Verdeckungstiefe, Maler-Tiefe, Stil-Index.
type PatternLine = (Pt, Pt, f64, f64, usize);

/// Ansichtsfarbe (`Component.elevationColor`) der sichtbaren Seite auf die Flächen legen und die
/// Ansichtsschraffur ([94]) als Linien liefern: Wände in Wand-Koordinaten (x ab Wandanfang, y ab UK),
/// Dachflächen traufparallel/in Falllinie (`surface_pattern::segments_3d`). Tiefe je Linie = nächster
/// Endpunkt (knapp vor der Fläche), damit die Verdeckung wie bei den Kanten greift.
fn surface_patterns(p: &Project, faces: &mut [Face], frame: &[f64; 9], scale: f64, mono: bool) -> (Vec<PatternLine>, Vec<(f64, String)>) {
    use crate::surface_pattern as sp;
    let mut lines: Vec<PatternLine> = Vec::new();
    let mut styles: Vec<(f64, String)> = Vec::new();
    let (pp, nn, uu) = ([frame[0], frame[1], frame[2]], [frame[3], frame[4], frame[5]], [frame[6], frame[7], frame[8]]);
    let proj = |w: [f64; 3]| -> (f64, f64, f64) {
        let r = [w[0] - pp[0], w[1] - pp[1], w[2] - pp[2]];
        (r[0] * uu[0] + r[1] * uu[1] + r[2] * uu[2], w[1], r[0] * nn[0] + r[1] * nn[1] + r[2] * nn[2])
    };
    let mut walls: HashMap<&str, &Wall> = HashMap::new();
    for w in &p.walls {
        walls.entry(w.id.as_str()).or_insert(w);
    }
    for f in faces.iter_mut() {
        if f.role != Role::Wall || f.id.is_empty() || f.pts.len() < 3 {
            continue;
        }
        let Some(wall) = walls.get(f.id.as_str()).copied() else { continue };
        let Some(comp) = wall_side_component(p, wall, f.normal) else { continue };
        if !mono {
            if let Some(c) = comp.elevation_color.as_deref().filter(|c| !c.trim().is_empty()) {
                f.fill = hex_to_rgb(c, f.fill);
            }
        }
        let Some(pat) = comp.surface_pattern.as_ref() else { continue };
        let Some(spec) = sp::spec_of(pat, wall.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
        let len = hypot2(dx, dy);
        let t = [dx / len, 0.0, dy / len];
        let k = t[0] * uu[0] + t[2] * uu[2];
        if k.abs() < 0.05 {
            continue; // fast von der Seite gesehen
        }
        let kd = (t[0] * nn[0] + t[2] * nn[2]) / k; // Tiefe je u entlang der Fläche
        let mean_u = f.pts.iter().map(|q| q[0]).sum::<f64>() / f.pts.len() as f64;
        let depth_at = |u: f64| f.depth + (u - mean_u) * kd;
        let z0 = p.wall_vertical_extent(wall).0;
        let (u0, _, _) = proj([wall.start.x, 0.0, wall.start.y]);
        let local: Vec<sp::P> = f.pts.iter().map(|q| [(q[0] - u0) / k, q[1] - z0]).collect();
        let off = wall.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
        let segs = sp::segments(&local, &spec, off, scale);
        if segs.is_empty() {
            continue;
        }
        styles.push(pattern_style(pat, comp));
        let si = styles.len() - 1;
        for (s0, s1) in segs {
            let (qa, qb) = ([u0 + k * s0[0], s0[1] + z0], [u0 + k * s1[0], s1[1] + z0]);
            let d = min(depth_at(qa[0]), depth_at(qb[0])) - EPS * 5.0;
            lines.push((qa, qb, d, f.depth - EPS * 5.0, si));
        }
    }
    // Dachflächen: äusserste Schicht (Eindeckung).
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let Some(comp) = p.roof_layers(roof).first().filter(|l| !l.component_id.is_empty()).and_then(|l| p.component(&l.component_id)) else { continue };
        if !mono && roof.color.as_deref().is_none_or(|c| c.is_empty()) {
            if let Some(c) = comp.elevation_color.as_deref().filter(|c| !c.trim().is_empty()) {
                for f in faces.iter_mut().filter(|f| f.role == Role::Roof && f.id == roof.id) {
                    f.fill = hex_to_rgb(c, f.fill);
                }
            }
        }
        let Some(pat) = comp.surface_pattern.as_ref() else { continue };
        let Some(spec) = sp::spec_of(pat, roof.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        let off = roof.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
        let mut si: Option<usize> = None;
        for plane in &g.planes {
            if plane.len() < 3 {
                continue;
            }
            // Flächennormale (Plan-Koordinaten, aufwärts); sichtbar, wenn sie zum Betrachter zeigt.
            let mut n = [0.0; 3];
            for i in 0..plane.len() {
                let (a, b) = (plane[i], plane[(i + 1) % plane.len()]);
                n[0] += (a[1] - b[1]) * (a[2] + b[2]);
                n[1] += (a[2] - b[2]) * (a[0] + b[0]);
                n[2] += (a[0] - b[0]) * (a[1] + b[1]);
            }
            if n[2] < 0.0 {
                n = [-n[0], -n[1], -n[2]];
            }
            if nn[0] * n[0] + nn[1] * n[2] + nn[2] * n[1] >= -1e-9 {
                continue;
            }
            // Maler-Tiefe der Fläche wie `project_face`: Mittel der Eckentiefen.
            let face_depth = plane.iter().map(|q| proj([q[0], q[2], q[1]]).2).sum::<f64>() / plane.len() as f64;
            for (a, b) in sp::segments_3d(plane, &spec, off, scale) {
                let (ua, va, da) = proj([a[0], a[2], a[1]]);
                let (ub, vb, db) = proj([b[0], b[2], b[1]]);
                if da <= EPS || db <= EPS {
                    continue;
                }
                let k = *si.get_or_insert_with(|| {
                    styles.push(pattern_style(pat, comp));
                    styles.len() - 1
                });
                lines.push(([ua, va], [ub, vb], min(da, db) - EPS * 5.0, face_depth - EPS * 5.0, k));
            }
        }
    }
    if mono {
        for s in &mut styles {
            s.1 = PATTERN_INK.into();
        }
    }
    (lines, styles)
}

/// Abfrage `elevationPlan`: `args` = `[mono, shadows]`, `text` = `{"level": {...}, "hasVis", "invisible",
/// "hasDisplay", "norender", "grey"}`. Puffer mit einer Gruppe und Ausmass; ohne Ansichtslinie ohne Gruppen.
pub fn elevation_plan_buf(p: &Project, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Ansicht-Argumente: {e}"))?;
    let level = LevelSpec::from_json(v.get("level").unwrap_or(&serde_json::Value::Null));
    let vis = Visibility::from_json(&v);
    let mono = args.first().is_some_and(|&x| x != 0.0);
    let shadows = args.get(1).is_some_and(|&x| x != 0.0);
    // Massstab für die Ausdünnung der Ansichtsschraffur (fehlt er: 1:100).
    let scale = args.get(2).copied().filter(|s| s.is_finite() && *s > 0.0).unwrap_or(100.0);
    let mut w = crate::plan_buf::Writer::new(true);
    if let Some((prims, bounds)) = elevation_primitives(p, &level, shadows, mono, &vis, scale)? {
        w.group(&prims);
        w.bounds = Some(bounds);
    }
    Ok(w.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
    }

    #[test]
    fn farben_wie_ts() {
        assert_eq!(rgb_to_hex([1.0, 0.0, 0.5]), "#ff0080");
        assert_eq!(rgb_to_hex([f64::NAN, 2.0, -1.0]), "#NaNff00");
        assert_eq!(hex_to_rgb(" #ff0000 ", [0.0; 3]), [1.0, 0.0, 0.0]);
        assert_eq!(hex_to_rgb("#abc", [0.5; 3]), [0.5; 3]);
    }

    #[test]
    fn beispiel_ansicht() {
        let p = sample();
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, b) = elevation_primitives(&p, &level, true, false, &Visibility::default(), 100.0).unwrap().unwrap();
        let json = serde_json::to_string(&prims).unwrap();
        assert!(json.contains("\"wallId\":\"W1\"") && json.contains("\"openingId\":\"O1\"") && json.contains("elevation-ground"), "{json}");
        assert!(json.contains("#8f959e"), "Schlagschatten fehlt");
        assert!(b[2] > b[0]);
        // Painter: die Bodenlinie zuletzt
        assert!(matches!(prims.last(), Some(Primitive::Line { cls, .. }) if cls == "elevation-ground"));
    }

    fn render(p: &Project, scale: f64) -> String {
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, _) = elevation_primitives(p, &level, false, false, &Visibility::default(), scale).unwrap().unwrap();
        serde_json::to_string(&prims).unwrap()
    }

    #[test]
    fn ansichtsschraffur_und_ansichtsfarbe_der_aussenschicht() {
        let mut p = sample();
        assert!(!render(&p, 50.0).contains("elevation-surface-pattern"), "ohne Muster keine Linien");
        let outer = p.wall_types.iter().find(|t| t.id == "aw").unwrap().layers[0].component_id.clone();
        let c = p.components.iter_mut().find(|c| c.id == outer).unwrap();
        c.elevation_color = Some("#123456".into());
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, spacing: 0.1, ..Default::default() });
        let fine = render(&p, 50.0);
        let n_fine = fine.matches("elevation-surface-pattern").count();
        assert!(n_fine > 20, "{n_fine}");
        assert!(fine.contains("#123456"), "Ansichtsfarbe der Aussenschicht");
        let n_mid = render(&p, 200.0).matches("elevation-surface-pattern").count();
        assert!(n_mid < n_fine && n_mid > 0, "{n_mid} vs {n_fine}");
        assert_eq!(render(&p, 2000.0).matches("elevation-surface-pattern").count(), 0, "grob: weggelassen");
    }
}
