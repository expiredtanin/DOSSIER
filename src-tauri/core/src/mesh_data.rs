//! OBJ-/STL-/glTF-Export: Sammler im Kern ([K4] S2, [C11]; vorher `buildScene` in
//! `src/export/exportMesh.ts`). Liest das Projekt-Dokument und erzeugt die Szene als flachen Puffer
//! für den Schreiber `src-tauri/fileio/src/mesh_export.rs` (Kodierung dort, FLAT_VERSION 1): ein
//! Knoten je Bauteil-Vorkommen mit Teil-Netzen je Material, Materialtabelle, Geschosse.
//!
//! Dreiecks-Quelle wie im 3D-Viewer:
//!   • Wände: Schicht-Bänder (`emit_walls`), gelochte Bänder öffnungsgenau (`wall_cut_mesh`, inkl.
//!     Laibungen), lochlose als 8-Ecken-Box.
//!   • Decken und Extrusionen: Umriss-Prisma (Ear-Clipping-Kappen + Mantel); Extrusionen mit `taper`
//!     (oberer Ring zum Schwerpunkt verjüngt) — bewusst die Prisma-Näherung, nicht die truck-Körper.
//!   • Dächer, Stützen, Treppen (Tritte, Laufplatte, Handlauf), Öffnungsteile (je Öffnung ein
//!     Knoten): dieselben `emit_*`-Ableitungen wie das 3D, je Bauteil mit einem Projekt aufgerufen,
//!     das nur dieses Bauteil enthält (die Ableitungen liefern keine ids).
//!   • Gelände und importierte Meshes (Farbe der Quelle, falls gesetzt).
//! Achsen intern Modell (x, y, z-hoch) → Welt (x, z, y); der Schreiber stellt die Rechtshändigkeit
//! her (Datei (x, z, −y), Norden = −Z). Geschlossene Teile werden nach aussen gewickelt
//! (`orient_outward`), da render3d doppelseitig zeichnet. Zahlsemantik und Reihenfolge wie die
//! frühere TS-Fassung: die Dateien bleiben zeichengleich.

use crate::export_flat::{orient_outward, Flat};
use crate::jsmath::hypot2;
use crate::jsnum::{max, min};
use crate::model::*;
use crate::model3d::{self, RMesh, RWall};
use crate::style::{hex_to_rgb, Rgb};
use crate::wall_mesh_cut::{wall_cut_mesh_checked, CutWall};
use std::collections::HashMap;

const FLAT_VERSION: f64 = 1.0;

/// Was in die Szene kommt (Standard: alles).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeshOptions {
    /// Verglasung und Rahmenteile je Öffnung als eigener Knoten.
    pub opening_parts: bool,
    /// Gelände und importierte Kontext-Meshes.
    pub context: bool,
    /// Geschoss als Eltern-Knoten (nur glTF; OBJ/STL: aus).
    pub by_level: bool,
}

impl Default for MeshOptions {
    fn default() -> Self {
        MeshOptions { opening_parts: true, context: true, by_level: true }
    }
}

/// Teil-Netz mit EINEM Material, lokale Indizes.
struct Prim {
    material: f64,
    positions: Vec<f64>,
    indices: Vec<f64>,
}

/// Ein Bauteil-Vorkommen mit ≥ 1 Teil-Netz.
struct Group {
    name: String,
    kind: &'static str,
    id: String,
    level: f64,
    prims: Vec<Prim>,
}

impl Group {
    fn new(name: String, kind: &'static str, id: &str, level: f64) -> Self {
        Group { name, kind, id: id.to_string(), level, prims: Vec::new() }
    }
    fn prim(&mut self, material: f64) -> &mut Prim {
        self.prims.push(Prim { material, positions: Vec::new(), indices: Vec::new() });
        self.prims.last_mut().unwrap()
    }
}

/// Material der Szene: Farbe sRGB 0..1, Alpha < 1 = transparent (Glas).
struct Material {
    name: String,
    rgba: [f64; 4],
    metallic: f64,
    roughness: f64,
}

/// Materialtabelle: gleiche Farbe + Name = ein Material (Schlüssel wie in TS als Text).
#[derive(Default)]
struct Materials {
    list: Vec<Material>,
    by_key: HashMap<String, usize>,
}

impl Materials {
    fn get(&mut self, name: &str, rgb: Rgb, alpha: f64, metallic: f64, roughness: f64) -> f64 {
        use crate::js_fmt::js_number as n;
        let key = format!("{name}|{},{},{}|{}|{}|{}", n(rgb[0]), n(rgb[1]), n(rgb[2]), n(alpha), n(metallic), n(roughness));
        if let Some(&i) = self.by_key.get(&key) {
            return i as f64;
        }
        let i = self.list.len();
        self.list.push(Material { name: name.to_string(), rgba: [rgb[0], rgb[1], rgb[2], alpha], metallic, roughness });
        self.by_key.insert(key, i);
        i as f64
    }
    fn solid(&mut self, name: &str, rgb: Rgb) -> f64 {
        self.get(name, rgb, 1.0, 0.0, 0.9)
    }
}

/// OBJ-Gruppennamen ohne Leerraum/Sonderzeichen (je UTF-16-Einheit ein `_`, wie das JS-RegExp).
fn sanitize_name(id: &str) -> String {
    let mut out = String::new();
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    if out.is_empty() {
        "x".to_string()
    } else {
        out
    }
}

/// Die 6 Quader-Seiten (Bits: 0 Achse, 1 Höhe, 2 Dicke), aussen gewunden; je Quadrupel 2 Dreiecke.
const BOX_QUADS: [[usize; 4]; 6] = [[4, 6, 7, 5], [1, 3, 2, 0], [2, 3, 7, 6], [4, 5, 1, 0], [1, 5, 7, 3], [2, 6, 4, 0]];

/// Voller Wand-Schicht-Quader ohne Öffnungen (lochlose Bänder); entartete Bänder fallen weg.
fn push_wall_box(g: &mut Prim, w: &RWall) {
    let [sx, sy] = w.start;
    let [ex, ey] = w.end;
    let dx = ex - sx;
    let dz = ey - sy;
    let len = hypot2(dx, dz);
    if len < 1e-9 || w.height <= 1e-9 || w.thickness <= 1e-9 {
        return;
    }
    let ax = dx / len;
    let az = dz / len;
    // Normale = Welt-Hoch × Achse: (az, 0, −ax).
    let nx = az;
    let nz = -ax;
    let half_len = len / 2.0;
    let half_height = w.height / 2.0;
    let half_thick = w.thickness / 2.0;
    let cx = (sx + ex) / 2.0;
    let cz = (sy + ey) / 2.0;
    let cy = w.base_elevation + w.height / 2.0;
    let base = (g.positions.len() / 3) as f64;
    // Kanten ±Dicke/2 an den Schnittlinien (Gehrung, T-Stoss, schräge Aussparung) enden lassen.
    let clip = |px: f64, pz: f64, cut: Option<[f64; 4]>| -> (f64, f64) {
        let Some([qx, qz, dx2, dz2]) = cut else { return (px, pz) };
        let denom = ax * dz2 - az * dx2;
        if denom.abs() < 1e-9 {
            return (px, pz);
        }
        let t = ((qx - px) * dz2 - (qz - pz) * dx2) / denom;
        (px + ax * t, pz + az * t)
    };
    for i in 0..8 {
        let sl = if i & 1 != 0 { 1.0 } else { -1.0 };
        let sh = if i & 2 != 0 { 1.0 } else { -1.0 };
        let st = if i & 4 != 0 { 1.0 } else { -1.0 };
        let cut = if sl > 0.0 { w.end_cut } else { w.start_cut };
        if cut.is_some() {
            let (px, pz) = clip(cx + sl * half_len * ax + st * half_thick * nx, cz + sl * half_len * az + st * half_thick * nz, cut);
            g.positions.extend_from_slice(&[px, cy + sh * half_height, pz]);
            continue;
        }
        g.positions.extend_from_slice(&[cx + sl * half_len * ax + st * half_thick * nx, cy + sh * half_height, cz + sl * half_len * az + st * half_thick * nz]);
    }
    for [a, b, c, d] in BOX_QUADS {
        let (a, b, c, d) = (base + a as f64, base + b as f64, base + c as f64, base + d as f64);
        g.indices.extend_from_slice(&[a, b, c, a, c, d]);
    }
}

/// Ecken an Wandanfang/-ende (Welt x, Höhe, y) längs der Achse auf die Schnittlinien schieben
/// (`RWall::start_cut`/`end_cut`); die Mantelflächen bleiben eben, weil sich nur Endpunkte längs
/// der Achse verschieben.
fn shift_cut_ends(pos: &mut [f64], w: &RWall) {
    if w.start_cut.is_none() && w.end_cut.is_none() {
        return;
    }
    let [sx, sy] = w.start;
    let (dx, dy) = (w.end[0] - sx, w.end[1] - sy);
    let len = hypot2(dx, dy);
    if len < 1e-9 {
        return;
    }
    let (ax, ay) = (dx / len, dy / len);
    // Achsmass, an dem die Längslinie (Querversatz `t`) die Schnittlinie trifft.
    let at = |c: [f64; 4], t: f64| -> Option<f64> {
        let (px, py) = (sx - ay * t, sy + ax * t);
        let denom = ax * c[3] - ay * c[2];
        if denom.abs() < 1e-9 {
            return None;
        }
        Some(((c[0] - px) * c[3] - (c[1] - py) * c[2]) / denom)
    };
    for v in pos.chunks_exact_mut(3) {
        let (rx, ry) = (v[0] - sx, v[2] - sy);
        let a = rx * ax + ry * ay;
        let t = -rx * ay + ry * ax;
        let target = if a.abs() < 1e-6 {
            w.start_cut.and_then(|c| at(c, t))
        } else if (a - len).abs() < 1e-6 {
            w.end_cut.and_then(|c| at(c, t))
        } else {
            None
        };
        if let Some(na) = target {
            v[0] += ax * (na - a);
            v[2] += ay * (na - a);
        }
    }
}

/// Signierte Fläche eines Modell-XY-Umrisses (Shoelace); ≥ 0 = CCW.
fn signed_area_xy(pts: &[Vec2]) -> f64 {
    let mut a = 0.0;
    let n = pts.len();
    for i in 0..n {
        let j = if i == 0 { n - 1 } else { i - 1 };
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    a / 2.0
}

/// Extrudiertes Umriss-Prisma (Decke, Treppen-Tritt, Extrusion): Kappen + Mantel, aussen gewunden;
/// `taper` (0..1) verjüngt den oberen Ring linear zum Schwerpunkt.
fn push_prism(g: &mut Prim, outline: &[Vec2], z_bottom: f64, z_top: f64, taper: f64) {
    if outline.len() < 3 || z_top - z_bottom <= 1e-9 {
        return;
    }
    let ccw: Vec<Vec2> = if signed_area_xy(outline) >= 0.0 { outline.to_vec() } else { outline.iter().rev().copied().collect() };
    let n = ccw.len();
    let (mut cx, mut cy) = (0.0, 0.0);
    for p in &ccw {
        cx += p.x;
        cy += p.y;
    }
    cx /= n as f64;
    cy /= n as f64;
    let t = min(1.0, max(0.0, taper));
    let base = (g.positions.len() / 3) as f64;
    for p in &ccw {
        g.positions.extend_from_slice(&[p.x, z_bottom, p.y]);
    }
    for p in &ccw {
        g.positions.extend_from_slice(&[cx + (p.x - cx) * (1.0 - t), z_top, cy + (p.y - cy) * (1.0 - t)]);
    }
    let nf = n as f64;
    let cap = crate::gpu_compile::triangulate(&ccw.iter().map(|p| crate::hatch::v2(p.x, p.y)).collect::<Vec<_>>());
    for tri in cap.chunks_exact(3) {
        let (a, b, c) = (tri[0] as f64, tri[1] as f64, tri[2] as f64);
        g.indices.extend_from_slice(&[base + a, base + b, base + c]);
        g.indices.extend_from_slice(&[base + nf + a, base + nf + c, base + nf + b]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        let (bi, bj, ti, tj) = (base + i as f64, base + j as f64, base + nf + i as f64, base + nf + j as f64);
        g.indices.extend_from_slice(&[bi, ti, tj, bi, tj, bj]);
    }
}

/// Modell-Netz (x, y, z-hoch) anhängen: Achsen nach Welt (x, z, y), Wicklung umgekehrt (Spiegelung);
/// `closed` ⇒ nach aussen gewickelt. Indizes ausserhalb und NaN fallen weg.
fn append_model_mesh(prim: &mut Prim, positions: &[f64], indices: &[f64], closed: bool) {
    let mut pos: Vec<f64> = Vec::with_capacity(positions.len());
    let mut i = 0;
    while i + 2 < positions.len() {
        pos.extend_from_slice(&[positions[i], positions[i + 2], positions[i + 1]]);
        i += 3;
    }
    let nv = (pos.len() / 3) as f64;
    // Nur ganzzahlige Indizes auf endliche Ecken (Importe/Dateien können Unsinn tragen); die
    // übrigen Ecken bleiben endlich (0), damit der Puffer lesbar bleibt.
    let bad: Vec<bool> = pos.chunks_exact(3).map(|c| !c.iter().all(|v| v.is_finite())).collect();
    for v in pos.iter_mut().filter(|v| !v.is_finite()) {
        *v = 0.0;
    }
    let ok = |v: f64| v >= 0.0 && v < nv && v.fract() == 0.0 && !bad[v as usize];
    let mut tri: Vec<f64> = Vec::new();
    let mut i = 0;
    while i + 2 < indices.len() {
        let (a, b, c) = (indices[i], indices[i + 1], indices[i + 2]);
        if ok(a) && ok(b) && ok(c) {
            tri.extend_from_slice(&[a, c, b]);
        }
        i += 3;
    }
    let idx: Vec<f64> = if closed && tri.iter().all(|v| v.fract() == 0.0) {
        let t: Vec<u32> = tri.iter().map(|&v| v as u32).collect();
        orient_outward(&pos, &t).into_iter().map(f64::from).collect()
    } else {
        tri
    };
    let base = (prim.positions.len() / 3) as f64;
    prim.positions.extend_from_slice(&pos);
    prim.indices.extend(idx.iter().map(|i| base + i));
}

fn u32s(v: &[u32]) -> Vec<f64> {
    v.iter().map(|&i| f64::from(i)).collect()
}

/// Standardfarbe der Extrusionen (wie `SLAB_RGB`).
const SLAB_COLOR: Rgb = [0.86, 0.86, 0.88];
/// Verglasung und Rahmenteile aus `emit_opening_meshes` (Farben `PART_RGB`).
const GLASS_COLOR: Rgb = [0.62, 0.76, 0.85];
const OPENING_PART_NAMES: [(Rgb, &str); 5] = [
    ([0.85, 0.85, 0.83], "Blendrahmen"),
    ([0.88, 0.88, 0.9], "Fluegelrahmen"),
    ([0.8, 0.8, 0.78], "Fensterbank/Zarge"),
    ([0.25, 0.27, 0.3], "Schwelle"),
    ([0.93, 0.9, 0.85], "Tuerblatt"),
];
const TERRAIN_RGB: Rgb = [169.0 / 255.0, 176.0 / 255.0, 162.0 / 255.0];
const IMPORTED_RGB: Rgb = [159.0 / 255.0, 166.0 / 255.0, 174.0 / 255.0];

fn same_rgb(a: &Rgb, b: &Rgb) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
}

/// Die Szene als flacher Puffer (s. Modulkopf).
pub fn mesh_export_data(src: &Project, opt: &MeshOptions) -> Result<Flat, String> {
    let mut p = src.clone();
    let mut groups: Vec<Group> = Vec::new();
    let mut mats = Materials::default();
    let walls = model3d::emit_walls(&p, true)?;
    let slabs = model3d::emit_slabs(&p);
    let levels: Vec<(String, String)> = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).map(|l| (l.id.clone(), l.name.clone())).collect();
    let level_of = |floor_id: Option<&str>| -> f64 { floor_id.and_then(|id| levels.iter().position(|l| l.0 == id)).map_or(-1.0, |i| i as f64) };
    let component_name = |p: &Project, id: Option<&str>, fallback: &str| -> String {
        id.and_then(|id| p.component(id)).map(|c| c.name.as_str()).filter(|n| !n.is_empty()).unwrap_or(fallback).to_string()
    };

    // Wände: alle Schicht-Bänder DERSELBEN Wand-Id in EINE Gruppe.
    let mut wall_group: HashMap<String, usize> = HashMap::new();
    let mut wall_floor: HashMap<&str, &str> = HashMap::new();
    for w in &p.walls {
        wall_floor.insert(&w.id, &w.floor_id);
    }
    for w in &walls {
        let gi = match wall_group.get(&w.wall_id) {
            Some(&i) => i,
            None => {
                groups.push(Group::new(format!("Wand_{}", sanitize_name(&w.wall_id)), "wall", &w.wall_id, level_of(wall_floor.get(w.wall_id.as_str()).copied())));
                wall_group.insert(w.wall_id.clone(), groups.len() - 1);
                groups.len() - 1
            }
        };
        let mat = mats.solid(&component_name(&p, w.cut.as_ref().and_then(|c| c.component_id.as_deref()), "Wand"), w.color);
        let prim = groups[gi].prim(mat);
        if w.holes.as_ref().is_some_and(|h| !h.is_empty()) {
            // Öffnungsgenau inkl. Laibungen (Welt x, Höhe, y), wie im 3D.
            let cut = wall_cut_mesh_checked(&CutWall {
                start: w.start,
                end: w.end,
                thickness: w.thickness,
                base_elevation: w.base_elevation,
                height: w.height,
                holes: w.holes.as_deref().unwrap_or(&[]).iter().map(|h| [h.from, h.to, h.z_bottom, h.z_top]).collect(),
            });
            let mut cut = cut;
            shift_cut_ends(&mut cut, w);
            let base = (prim.positions.len() / 3) as f64;
            prim.positions.extend_from_slice(&cut);
            prim.indices.extend((0..cut.len() / 3).map(|i| base + i as f64));
        } else {
            push_wall_box(prim, w);
        }
    }

    // Decken: ein Prisma je Platte.
    let mut ceiling_floor: HashMap<&str, &str> = HashMap::new();
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        ceiling_floor.insert(&c.id, &c.floor_id);
    }
    for s in &slabs {
        let mut g = Group::new(format!("Decke_{}", sanitize_name(&s.ceiling_id)), "slab", &s.ceiling_id, level_of(ceiling_floor.get(s.ceiling_id.as_str()).copied()));
        let outline: Vec<Vec2> = s.outline.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect();
        let mat = mats.solid(&component_name(&p, s.cut.as_ref().and_then(|c| c.component_id.as_deref()), "Decke"), s.color);
        push_prism(g.prim(mat), &outline, s.z_bottom, s.z_top, 0.0);
        groups.push(g);
    }

    // Extrudierte Profile: Prisma je Körper (Prisma-Näherung statt truck-Körper).
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.points.len() < 3 || s.height <= 0.0 {
            continue;
        }
        let base_z = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let mut g = Group::new(format!("Extrusion_{}", sanitize_name(&s.id)), "extrusion", &s.id, level_of(Some(&s.level_id)));
        let mat = mats.solid("Extrusion", SLAB_COLOR);
        push_prism(g.prim(mat), &s.points, base_z, base_z + s.height, s.taper.unwrap_or(0.0));
        groups.push(g);
    }

    // Dächer, Stützen, Treppen: je Bauteil EIN Aufruf der 3D-Ableitung mit nur diesem Bauteil.
    let add_meshes = |g: &mut Group, mats: &mut Materials, meshes: &[RMesh], name: &str| {
        for m in meshes {
            if m.indices.is_empty() {
                continue;
            }
            let mat = mats.solid(name, m.color);
            append_model_mesh(g.prim(mat), &m.positions, &u32s(&m.indices), true);
        }
    };
    let roofs = p.roofs.take();
    for roof in roofs.as_deref().unwrap_or(&[]) {
        let mut g = Group::new(format!("Dach_{}", sanitize_name(&roof.id)), "roof", &roof.id, level_of(Some(&roof.floor_id)));
        p.roofs = Some(vec![roof.clone()]);
        add_meshes(&mut g, &mut mats, &model3d::emit_roofs(&p, None)?, "Dach");
        groups.push(g);
    }
    p.roofs = roofs;
    let columns = p.columns.take();
    for col in columns.as_deref().unwrap_or(&[]) {
        let mut g = Group::new(format!("Stuetze_{}", sanitize_name(&col.id)), "column", &col.id, level_of(Some(&col.floor_id)));
        p.columns = Some(vec![col.clone()]);
        let name = component_name(&p, col.component_id.as_deref(), "Stuetze");
        add_meshes(&mut g, &mut mats, &model3d::emit_columns(&p), &name);
        groups.push(g);
    }
    p.columns = columns;
    let stairs = p.stairs.take();
    for st in stairs.as_deref().unwrap_or(&[]) {
        let mut g = Group::new(format!("Treppe_{}", sanitize_name(&st.id)), "stair", &st.id, level_of(Some(&st.floor_id)));
        p.stairs = Some(vec![st.clone()]);
        for s in model3d::emit_stairs(&p, false) {
            let outline: Vec<Vec2> = s.outline.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect();
            let mat = mats.solid("Treppe", s.color);
            push_prism(g.prim(mat), &outline, s.z_bottom, s.z_top, 0.0);
        }
        add_meshes(&mut g, &mut mats, &model3d::emit_stair_meshes(&p), "Treppe");
        add_meshes(&mut g, &mut mats, &model3d::emit_stair_railings(&p), "Handlauf");
        groups.push(g);
    }
    p.stairs = stairs;

    // Öffnungsteile: je Öffnung ein Knoten mit Glas und Rahmenteilen als Teil-Netze je Material;
    // die Ableitung nur mit der Wirtswand und dieser Öffnung.
    if opt.opening_parts {
        let all_walls = std::mem::take(&mut p.walls);
        let openings = p.openings.take();
        for op in openings.as_deref().unwrap_or(&[]) {
            let Some(host) = all_walls.iter().find(|w| w.id == op.host_wall_id) else { continue };
            p.walls = vec![host.clone()];
            p.openings = Some(vec![op.clone()]);
            let parts = model3d::emit_opening_meshes(&p, 1.0);
            if parts.is_empty() {
                continue;
            }
            let (prefix, kind) = match op.kind {
                ElementKind::Window => ("Fenster", "window"),
                ElementKind::Door => ("Tuer", "door"),
                ElementKind::Unknown => ("Tuer", ""),
            };
            let mut g = Group::new(format!("{prefix}_{}", sanitize_name(&op.id)), kind, &op.id, level_of(Some(&host.floor_id)));
            let mut prims: HashMap<&str, usize> = HashMap::new();
            for m in &parts {
                let glass = same_rgb(&m.color, &GLASS_COLOR);
                let name = if glass { "Glas" } else { OPENING_PART_NAMES.iter().find(|(c, _)| same_rgb(c, &m.color)).map_or("Oeffnungsteil", |x| x.1) };
                let pi = match prims.get(name) {
                    Some(&i) => i,
                    None => {
                        // Glas transparent und glatt (BLEND), Rahmen matt.
                        let mat = if glass { mats.get(name, m.color, 0.35, 0.0, 0.05) } else { mats.get(name, m.color, 1.0, 0.0, 0.6) };
                        g.prim(mat);
                        prims.insert(name, g.prims.len() - 1);
                        g.prims.len() - 1
                    }
                };
                append_model_mesh(&mut g.prims[pi], &m.positions, &u32s(&m.indices), true);
            }
            groups.push(g);
        }
        p.walls = all_walls;
        p.openings = openings;
    }

    // Gelände und importierte Meshes (IFC/DXF): Farbe der Quelle, falls gesetzt.
    if opt.context {
        for obj in p.context.as_deref().unwrap_or(&[]) {
            let (terrain, id, name, color, positions, indices) = match obj {
                ContextObject::TerrainMesh(m) => (true, &m.id, &m.name, None, &m.positions, &m.indices),
                ContextObject::ImportedMesh(m) => (false, &m.id, &m.name, m.color.as_deref(), &m.positions, &m.indices),
                _ => continue,
            };
            if positions.len() < 9 || indices.len() < 3 {
                continue;
            }
            let rgb = match (terrain, color.filter(|c| !c.is_empty())) {
                (false, Some(c)) => hex_to_rgb(c, IMPORTED_RGB),
                (true, _) => TERRAIN_RGB,
                _ => IMPORTED_RGB,
            };
            let mut g = Group::new(format!("{}_{}", if terrain { "Gelaende" } else { "Kontext" }, sanitize_name(id)), if terrain { "terrain" } else { "context" }, id, -1.0);
            let mat_name = if terrain { "Gelaende" } else if name.is_empty() { "Kontext" } else { name.as_str() };
            let mat = mats.solid(mat_name, rgb);
            append_model_mesh(g.prim(mat), positions, indices, false);
            groups.push(g);
        }
    }

    // Flacher Puffer (Gegenstück zu `mesh_export.rs`).
    let mut f = Flat::new(FLAT_VERSION);
    f.num(if opt.by_level { 1.0 } else { 0.0 });
    f.num(mats.list.len() as f64);
    for m in &mats.list {
        let n = f.str(&m.name);
        f.nums(&[n, m.rgba[0], m.rgba[1], m.rgba[2], m.rgba[3], m.metallic, m.roughness]);
    }
    f.num(levels.len() as f64);
    for (id, name) in &levels {
        let (a, b) = (f.str(id), f.str(name));
        f.nums(&[a, b]);
    }
    let groups: Vec<&Group> = groups.iter().filter(|g| g.prims.iter().any(|p| !p.indices.is_empty())).collect();
    f.num(groups.len() as f64);
    for g in groups {
        let (name, kind, id) = (f.str(&g.name), f.str(g.kind), f.str(&g.id));
        f.nums(&[name, kind, id, g.level, g.prims.len() as f64]);
        for pr in &g.prims {
            f.nums(&[pr.material, (pr.positions.len() / 3) as f64]);
            f.nums(&pr.positions);
            f.num((pr.indices.len() / 3) as f64);
            f.nums(&pr.indices);
        }
    }
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    #[test]
    fn namen_wie_js() {
        assert_eq!(sanitize_name("W 1/ä"), "W_1__");
        assert_eq!(sanitize_name("a😀b"), "a__b");
        assert_eq!(sanitize_name(""), "x");
    }

    #[test]
    fn beispielprojekt_knoten_und_materialien() {
        let f = mesh_export_data(&sample(), &MeshOptions::default()).unwrap();
        assert_eq!(f.nums[0], FLAT_VERSION);
        for want in ["Wand_W1", "Decke_C1", "Dach_RF1", "Treppe_ST1", "Fenster_O1", "Tuer_D1", "Glas"] {
            assert!(f.strings.iter().any(|s| s == want), "fehlt: {want}");
        }
        let f2 = mesh_export_data(&sample(), &MeshOptions { opening_parts: false, ..Default::default() }).unwrap();
        assert!(!f2.strings.iter().any(|s| s == "Fenster_O1"));
        assert!(f2.nums.len() < f.nums.len());
    }

    #[test]
    fn prisma_aussen_gewickelt() {
        let mut g = Group::new("x".into(), "slab", "x", -1.0);
        let sq = [Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 0.0, y: 1.0 }, Vec2 { x: 1.0, y: 1.0 }, Vec2 { x: 1.0, y: 0.0 }];
        push_prism(g.prim(0.0), &sq, 0.0, 1.0, 0.0);
        let pr = &g.prims[0];
        assert_eq!(pr.positions.len(), 8 * 3);
        assert_eq!(pr.indices.len(), (2 * 2 + 4 * 2) * 3);
        // Geschlossen und konsistent gewickelt: Betrag des Volumens = 1 (Einheitswürfel).
        let idx: Vec<u32> = pr.indices.iter().map(|&i| i as u32).collect();
        let mut v = 0.0;
        for t in idx.chunks_exact(3) {
            let q = |i: u32| &pr.positions[i as usize * 3..i as usize * 3 + 3];
            let (a, b, c) = (q(t[0]), q(t[1]), q(t[2]));
            v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
        }
        assert!(((v / 6.0).abs() - 1.0).abs() < 1e-12, "{v}");
    }

    #[test]
    fn kaputtes_kontext_netz_ohne_panik() {
        let mut p = Project { id: "k".into(), ..Default::default() };
        p.context = Some(vec![ContextObject::ImportedMesh(ImportedMesh { id: "m".into(), positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, f64::NAN], indices: vec![0.0, 1.0, 9.0, 0.0, 1.0, 2.0, f64::NAN, 0.0, 1.0], ..Default::default() })]);
        let f = mesh_export_data(&p, &MeshOptions::default()).unwrap();
        assert!(f.strings.iter().any(|s| s == "Kontext_m"));
    }

    /// Gebrochene Indizes und nicht endliche Ecken (Datei/Import) dürfen nicht in den Puffer: der
    /// Leser (`fileio`) verlangt ganzzahlige Indizes und endliche Zahlen.
    #[test]
    fn nur_ganzzahlige_indizes_und_endliche_ecken() {
        let mut g = Prim { material: 0.0, positions: Vec::new(), indices: Vec::new() };
        let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, f64::NAN];
        append_model_mesh(&mut g, &pos, &[0.0, 1.0, 2.0, 0.0, 1.5, 2.0, 1.0, 2.0, 3.0], false);
        assert_eq!(g.indices, vec![0.0, 2.0, 1.0], "nur das ganzzahlige Dreieck ohne NaN-Ecke");
        assert!(g.positions.iter().all(|v| v.is_finite()));
        assert_eq!(g.positions.len(), 12);
    }
}
