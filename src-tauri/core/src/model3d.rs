//! 3D-Ableitung aus dem Projekt-Dokument ([K4] S2): Rust-Gegenstück zu `src/plan/toWalls3d.ts` und
//! `toWalls3d/*.ts`. Liefert das Modell-Bündel (`RModel3d`) für render3d, die Schnitt-Eingabe und
//! die Ansicht. Die Geometrie rechnen die bestehenden Kern-Module (`ceilings3d`, `columns3d`,
//! `wall_bands` …); hier werden sie aus dem typisierten `Project` gespeist und die Ergebnisse mit
//! Farbe, Schraffur und Ids versehen.

use crate::flat_write::FlatWriter;
use crate::jsnum::{cos, sin};
use crate::model::*;
use crate::style::{self, hex_to_rgb, resolve_component_hatch, resolve_cut_line_style, Rgb, SLAB_RGB};
use serde::Serialize;

pub type RVec2 = [f64; 2];

/// Schnitt-Verschneidungs-/Linienstil-Metadaten eines Bandes (`RCutMeta`).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RCutMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub join_priority: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_color: Option<Rgb>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_weight: Option<f64>,
}

/// Eine extrudierte Deckenplatte (`RSlab`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RSlab {
    pub outline: Vec<RVec2>,
    pub z_bottom: f64,
    pub z_top: f64,
    pub color: Rgb,
    pub ceiling_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hatch: Option<style::RHatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut: Option<RCutMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monolith: Option<String>,
    /// Herkunft der Platte (nur im Kern, nicht serialisiert): der Schnitt ordnet seine Bänder darüber
    /// der Decke bzw. Deckenschicht oder der Treppe zu, statt die Platten abzuzählen.
    #[serde(skip)]
    pub source: SlabSource,
}

/// Herkunft einer `RSlab`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SlabSource {
    #[default]
    None,
    /// Index in `Project::ceilings`; `layer` = Schicht des Deckentyps (`None` = ungeschichtet).
    Ceiling { index: usize, layer: Option<usize> },
    /// Index in `Project::stairs`.
    Stair { index: usize },
    /// [141] Index in `Project::columns` (Stützen-Prisma, je Höhenabschnitt von [`column_pieces`]).
    Column { index: usize },
}

/// Ein rohes Dreiecks-Mesh (`RMesh`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RMesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub kind: &'static str,
    pub color: Rgb,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertex_colors: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_index: Option<f64>,
    /// [T4] Glatt schattieren mit Knickwinkel (Grad), s. `render3d::types::MeshInput.creaseAngle`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crease_angle: Option<f64>,
}

/// [T4] Vorgabe-Knickwinkel (Grad) für glatt schattierte Import-Meshes.
pub const DEFAULT_CREASE_DEG: f64 = 30.0;

// ── Decken ──────────────────────────────────────────────────────────────────

/// Deckentyp (id, Name, Schichten): Deckentyp, sonst Wandtyp (`getCeilingType`).
pub fn ceiling_type_ref<'a>(p: &'a Project, c: &Ceiling) -> Option<(&'a str, &'a str, &'a [Layer])> {
    if let Some(id) = c.ceiling_type_id.as_deref() {
        if let Some(t) = p.ceiling_types.as_deref().and_then(|v| v.iter().find(|t| t.id == id)) {
            return Some((&t.id, &t.name, &t.layers));
        }
    }
    p.wall_types.iter().find(|t| t.id == c.wall_type_id).map(|t| (t.id.as_str(), t.name.as_str(), t.layers.as_slice()))
}

fn ceiling_layers<'a>(p: &'a Project, c: &Ceiling) -> Option<&'a [Layer]> {
    if let Some(id) = c.ceiling_type_id.as_deref() {
        if let Some(t) = p.ceiling_types.as_deref().and_then(|v| v.iter().find(|t| t.id == id)) {
            return Some(&t.layers);
        }
    }
    p.wall_types.iter().find(|t| t.id == c.wall_type_id).map(|t| t.layers.as_slice())
}

/// Deckenplatten (`emitSlabs`): eine Platte je Materiallage, oben→unten gestapelt.
pub fn emit_slabs(p: &Project) -> Vec<RSlab> {
    let mut ceilings: Vec<(usize, &Ceiling)> = Vec::new();
    let mut layers_of: Vec<Option<&[Layer]>> = Vec::new();
    let mut w = FlatWriter::new();
    let count = w.slot();
    for (ci, c) in p.ceilings.as_deref().unwrap_or(&[]).iter().enumerate() {
        if c.outline.len() < 3 {
            continue;
        }
        let (z_bottom, z_top) = p.ceiling_vertical_extent(c);
        let layers = ceiling_layers(p, c);
        w.ring(&c.outline);
        // Aussparungen inkl. der Deckenöffnungen ([103]).
        let openings = crate::opening_shape::ceiling_hole_rings(p, c);
        w.num(openings.len() as f64);
        for o in &openings {
            w.ring(o);
        }
        w.num(z_bottom).num(z_top).num(layers.map_or(0, |l| l.len()) as f64);
        for l in layers.unwrap_or(&[]) {
            w.num(l.thickness);
        }
        ceilings.push((ci, c));
        layers_of.push(layers);
    }
    if ceilings.is_empty() {
        return vec![];
    }
    w.set(count, ceilings.len() as f64);
    let mut out = Vec::new();
    for d in crate::ceilings3d::ceilings(&w.done()) {
        let (ci, c) = ceilings[d.ceiling];
        let layers = layers_of[d.ceiling];
        let outline: Vec<RVec2> = d.ring.clone();
        for (layer_idx, z_bottom, z_top) in d.slabs {
            let Some(layers) = layers.filter(|_| layer_idx >= 0) else {
                out.push(RSlab { outline: outline.clone(), z_bottom, z_top, color: SLAB_RGB, ceiling_id: c.id.clone(), hatch: None, cut: None, monolith: None, source: SlabSource::Ceiling { index: ci, layer: None } });
                continue;
            };
            let l = &layers[layer_idx as usize];
            let (color, cut) = match p.component(&l.component_id) {
                Some(comp) => {
                    let line = resolve_cut_line_style(p, l);
                    (
                        hex_to_rgb(&comp.color, style::WALL_RGB),
                        Some(RCutMeta {
                            join_priority: Some(comp.join_priority),
                            component_id: Some(comp.id.clone()),
                            line_color: line.0,
                            line_weight: line.1,
                        }),
                    )
                }
                None => (SLAB_RGB, None),
            };
            out.push(RSlab {
                outline: outline.clone(),
                z_bottom,
                z_top,
                color,
                ceiling_id: c.id.clone(),
                hatch: resolve_component_hatch(p, &l.component_id, None),
                cut,
                monolith: None,
                source: SlabSource::Ceiling { index: ci, layer: Some(layer_idx as usize) },
            });
        }
    }
    out
}

// ── Stützen ─────────────────────────────────────────────────────────────────

const COLUMN_ROUND_SEGMENTS: usize = 32;
pub(crate) const COLUMN_RGB: Rgb = [0.7, 0.7, 0.72];

/// Grundriss-Querschnitt einer Stütze (`columnFootprint`).
pub fn column_footprint(col: &Column) -> Vec<Vec2> {
    let (cx, cy) = (col.position.x, col.position.y);
    match &col.profile {
        ColumnProfile::Round { radius } => (0..COLUMN_ROUND_SEGMENTS)
            .map(|i| {
                let t = (i as f64 / COLUMN_ROUND_SEGMENTS as f64) * std::f64::consts::PI * 2.0;
                Vec2 { x: cx + radius * cos(t), y: cy + radius * sin(t) }
            })
            .collect(),
        ColumnProfile::Rect { width, depth } => {
            let (hw, hd) = (width / 2.0, depth / 2.0);
            let rot = col.rotation;
            let (c, s) = (cos(rot), sin(rot));
            [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
                .iter()
                .map(|&(x, y)| Vec2 { x: cx + x * c - y * s, y: cy + x * s + y * c })
                .collect()
        }
    }
}

/// [141] Körper einer Stütze als Prismen `(Querschnitt, z_unten, z_oben)`: in der Regel der volle
/// Querschnitt; endet eine prioritärere Wand in der Stütze (`plan::wall_columns::Rel::Wall`, wie im
/// Grundriss), ist das Wandband über deren Höhe ausgespart (Höhe in Abschnitte geteilt). Löcher im
/// Rest (Wand endet ganz innen) bleiben unbeschnitten.
pub fn column_pieces(p: &Project, col: &Column) -> Vec<(Vec<Vec2>, f64, f64)> {
    use crate::plan::wall_columns::{band_polys, end_in_column, relation, Rel};
    let fp = column_footprint(col);
    let (zb, zt) = p.column_vertical_extent(col);
    let full = vec![(fp.clone(), zb, zt)];
    if fp.len() < 3 || !(zt > zb) {
        return full;
    }
    let mut clips: Vec<(Vec<Vec2>, f64, f64)> = Vec::new();
    for w in p.walls.iter().filter(|w| w.floor_id == col.floor_id) {
        if end_in_column(w, &fp).is_none() || relation(p, w, col) != Rel::Wall {
            continue;
        }
        let (wb, wt) = p.wall_vertical_extent(w);
        let (z0, z1) = (wb.max(zb), wt.min(zt));
        if z1 - z0 <= 1e-6 {
            continue;
        }
        let total = p.wall_thickness(w, 0.2);
        let ro = joins::reference_offset(wall_reference(w), total);
        clips.extend(band_polys(w, ro - total / 2.0, ro + total / 2.0, true).into_iter().map(|q| (q, z0, z1)));
    }
    if clips.is_empty() {
        return full;
    }
    let mut zs: Vec<f64> = vec![zb, zt];
    for c in &clips {
        zs.extend([c.1, c.2]);
    }
    zs.sort_by(f64::total_cmp);
    zs.dedup_by(|a, b| (*a - *b).abs() <= 1e-6);
    let ring = |q: &[Vec2]| vec![q.iter().map(|v| [v.x, v.y]).collect::<Vec<[f64; 2]>>()];
    let mut out = Vec::new();
    for z in zs.windows(2) {
        let mid = (z[0] + z[1]) / 2.0;
        let active: Vec<crate::flat::Polygon> = clips.iter().filter(|c| c.1 <= mid && c.2 >= mid).map(|c| ring(&c.0)).collect();
        if active.is_empty() {
            out.push((fp.clone(), z[0], z[1]));
            continue;
        }
        for pl in crate::polygon_bool::difference(&[ring(&fp)], &active) {
            if pl.len() > 1 {
                return full;
            }
            out.push((pl[0].iter().map(|v| Vec2 { x: v[0], y: v[1] }).collect(), z[0], z[1]));
        }
    }
    out
}

/// Netz einer Stütze (Modell x, y, z): ein Prisma über dem Querschnitt; beschnittene Stützen
/// ([`column_pieces`]) je Abschnitt mit Ohrenschnitt-Deckel (Querschnitt nicht mehr konvex).
fn column_mesh(p: &Project, col: &Column) -> Option<(Vec<f64>, Vec<u32>)> {
    let pieces = column_pieces(p, col);
    let ok = |foot: &[[f64; 2]], z0: f64, z1: f64| z0.is_finite() && z1.is_finite() && foot.iter().all(|q| q[0].is_finite() && q[1].is_finite()) && foot.len() >= 3 && z1 - z0 > 1e-4;
    let fr = |q: &[Vec2]| q.iter().map(|v| [v.x, v.y]).collect::<Vec<[f64; 2]>>();
    if let [(foot, z0, z1)] = pieces.as_slice() {
        if foot.len() == column_footprint(col).len() {
            let foot = fr(foot);
            return ok(&foot, *z0, *z1).then(|| crate::columns3d::prism(&foot, *z0, *z1));
        }
    }
    let mut m = crate::solid_bool::Mesh::default();
    for (foot, z0, z1) in &pieces {
        let foot = fr(foot);
        if ok(&foot, *z0, *z1) {
            m.append(&crate::solid_bool::Mesh::prism(&foot, *z0, *z1));
        }
    }
    (!m.is_empty()).then_some((m.positions, m.indices))
}

/// [141] Stützen als lotrechte Prismen-Platten (Schnitt, Ansicht): je Höhenabschnitt der Querschnitt aus
/// [`column_pieces`], Herkunft `SlabSource::Column`.
pub fn column_slabs(p: &Project) -> Vec<RSlab> {
    let mut out = Vec::new();
    for (index, c) in p.columns.as_deref().unwrap_or(&[]).iter().enumerate() {
        if !(c.height > 0.0) {
            continue;
        }
        let color = c.component_id.as_deref().and_then(|id| p.component(id)).map_or(COLUMN_RGB, |k| hex_to_rgb(&k.color, COLUMN_RGB));
        for (foot, z_bottom, z_top) in column_pieces(p, c) {
            let outline: Vec<RVec2> = foot.iter().map(|q| [q.x, q.y]).collect();
            if z_top - z_bottom > 1e-6 && outline.iter().flatten().all(|v| v.is_finite()) {
                out.push(RSlab { outline, z_bottom, z_top, color, ceiling_id: c.id.clone(), hatch: None, cut: None, monolith: None, source: SlabSource::Column { index } });
            }
        }
    }
    out
}

/// Stützen als Prisma-Meshes (`emitColumns`).
pub fn emit_columns(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    for col in p.columns.as_deref().unwrap_or(&[]) {
        if col.height <= 0.0 {
            continue;
        }
        let Some((positions, indices)) = column_mesh(p, col) else { continue };
        let color = col
            .component_id
            .as_deref()
            .and_then(|id| p.component(id))
            .map_or(COLUMN_RGB, |c| hex_to_rgb(&c.color, COLUMN_RGB));
        out.push(RMesh { crease_angle: None, positions, indices, kind: "extrusion", color, vertex_colors: None, material_index: None });
    }
    out
}

/// [149] Bäume als Meshes: je Baum Stamm (Zylinder, 8 Seiten) und Krone (Rotationskörper, 8 Ringe × 12
/// Seiten; Form nach `shape`), Fuss auf dem Gelände (`tree::bases`). Im 3D bei den Stützen eingereiht.
pub fn emit_trees(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    let trees = p.trees.as_deref().unwrap_or(&[]);
    for (i, g) in crate::tree::geoms(p) {
        let (trunk_rgb, crown_rgb) = crate::tree::colors(&trees[i]);
        let (positions, indices) = g.trunk_mesh(8);
        out.push(RMesh { crease_angle: None, positions, indices, kind: "extrusion", color: trunk_rgb, vertex_colors: None, material_index: None });
        let (positions, indices) = g.crown_mesh(8, 12);
        out.push(RMesh { crease_angle: None, positions, indices, kind: "extrusion", color: crown_rgb, vertex_colors: None, material_index: None });
    }
    out
}

/// [149] Bäume als Welt-Dreiecke (Stamm + Krone, wie [`emit_trees`]) für den 3D-Pick.
pub fn pick_trees(p: &Project) -> Vec<PickTree> {
    let trees = p.trees.as_deref().unwrap_or(&[]);
    crate::tree::geoms(p)
        .into_iter()
        .map(|(i, g)| {
            let (tp, ti) = g.trunk_mesh(8);
            let (cp, ci) = g.crown_mesh(8, 12);
            let mut tris = extrusion_tris(&tp, &ti);
            tris.extend(extrusion_tris(&cp, &ci));
            PickTree { tris, tree_id: trees[i].id.clone() }
        })
        .collect()
}

// ── Wände ───────────────────────────────────────────────────────────────────

use crate::joins::{self, JoinLayer, JoinWall, Reference, WallCuts};
use crate::jsmath::hypot2;
use crate::jsnum::atan2;
use crate::opening_geom::{self, WallRef};
use crate::style::{dominant_layer, dominant_layer_color, dominant_layer_hatch, WALL_RGB};
use crate::wall_bands::{self, BandIn, CeilingIn, FloorContext, OpeningIn, RoofIn, Termination};
use kernel2d::Vec2 as KVec;
use std::collections::HashMap;

/// Absenkung der Oberkante (`topDrop`), Löcher und Metadaten je Wandkörper (`RWall`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RHole {
    pub from: f64,
    pub to: f64,
    pub z_bottom: f64,
    pub z_top: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RWall {
    pub start: RVec2,
    pub end: RVec2,
    pub thickness: f64,
    pub height: f64,
    pub base_elevation: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_drop: Option<[f64; 2]>,
    /// Ebene Oberkante unter einer Dachfläche ([G2]): `[z am Anfang (Mittellinie), dz/dx, dz/dy]`
    /// (Grundriss-Meter). Übersteuert `topDrop`; `height` ist dann der höchste Eckwert über der UK.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_plane: Option<[f64; 3]>,
    pub color: Rgb,
    pub layers: Vec<()>,
    pub wall_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holes: Option<Vec<RHole>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hatch: Option<style::RHatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut: Option<RCutMeta>,
    /// Schnittlinie `[px, py, dx, dy]` (Grundriss) am Anfang/Ende: Gehrung, T-Stoss-Fläche oder schräge
    /// Aussparungs-Seite; die Kanten ±Dicke/2 enden auf ihr ([108]). Fehlt: rechtwinklig bzw. die
    /// Gehrung, die render3d aus den Nachbar-Enden ableitet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_cut: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_cut: Option<[f64; 4]>,
    /// Anfang/Ende liegt an einer inneren Stossfuge einer Bogenwand ([T2], Sehnen-Teilkörper): dort
    /// keine sichtbare Stirnfläche (Ansicht).
    #[serde(skip)]
    pub joint: [bool; 2],
}

/// Textur-Karten-URLs der Bauteile in der Reihenfolge des ersten Auftretens: Wandtypen, dann
/// Decken, dann Dächer (`wallMaterialColorMaps`).
pub fn wall_material_color_maps(p: &Project) -> Vec<String> {
    material_color_maps(p, None)
}

/// Wie [`wall_material_color_maps`]; `only_roof` beschränkt die Dächer auf eines (IFC-Export).
pub fn material_color_maps(p: &Project, only_roof: Option<&str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::new();
    let mut consider = |id: &str| {
        if let Some(url) = p.component(id).and_then(|c| c.material.as_ref()).and_then(|m| m.color.as_deref()).filter(|u| !u.is_empty()) {
            if seen.insert(url.to_owned()) {
                list.push(url.to_owned());
            }
        }
    };
    for w in &p.walls {
        if let Some(t) = p.wall_type(w) {
            for l in &t.layers {
                consider(&l.component_id);
            }
        }
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        if let Some(layers) = ceiling_layers(p, c) {
            for l in layers {
                consider(&l.component_id);
            }
        }
    }
    for r in p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| only_roof.is_none_or(|id| r.id == id)) {
        for l in p.roof_layers(r) {
            if !l.component_id.is_empty() {
                consider(&l.component_id);
            }
        }
        for d in r.dormers.as_deref().unwrap_or(&[]) {
            for l in crate::dormer::wall_layers(p, d).iter().chain(crate::dormer::roof_layers(p, r, d).iter()) {
                if !l.component_id.is_empty() {
                    consider(&l.component_id);
                }
            }
        }
    }
    list
}

/// Textur-Ebene (1-basiert) der Farbkarte eines Bauteils (`resolveComponentMaterialLayer`).
fn material_layer(p: &Project, maps: &[String], component_id: &str) -> Option<f64> {
    let url = p.component(component_id)?.material.as_ref()?.color.as_deref().filter(|u| !u.is_empty())?;
    maps.iter().position(|m| m == url).map(|i| (i + 1) as f64)
}

struct WallBand {
    thickness: f64,
    color: Rgb,
    hatch: Option<style::RHatch>,
    material_index: Option<f64>,
    priority: Option<f64>,
    component_id: Option<String>,
    cut_line_color: Option<Rgb>,
    cut_line_weight: Option<f64>,
}

const SECTION_WALL_AXIS_ANGLE_DEG: f64 = 90.0;

fn plain_band(thickness: f64) -> WallBand {
    WallBand { thickness, color: WALL_RGB, hatch: None, material_index: None, priority: None, component_id: None, cut_line_color: None, cut_line_weight: None }
}

/// Schichtstapel EINER Wand als Bänder (`resolveWallBands`); `stacked` = Lagen einzeln gestapelt.
fn resolve_wall_bands(p: &Project, maps: &[String], wall: &Wall, layered: bool) -> (Vec<WallBand>, bool) {
    let fallback = || (vec![plain_band(0.2)], false);
    let Some(wt) = p.wall_type(wall) else { return fallback() };
    if wt.layers.is_empty() {
        return (vec![plain_band(Project::type_thickness(&wt.layers))], false);
    }
    if !layered {
        let total = Project::type_thickness(&wt.layers);
        let dominant = dominant_layer(&wt.layers).expect("nicht leer");
        return (
            vec![WallBand {
                thickness: total,
                color: dominant_layer_color(p, &wt.layers, WALL_RGB),
                hatch: dominant_layer_hatch(p, &wt.layers, Some(SECTION_WALL_AXIS_ANGLE_DEG)),
                material_index: material_layer(p, maps, &dominant.component_id),
                ..plain_band(0.0)
            }],
            false,
        );
    }
    let mut bands = Vec::with_capacity(wt.layers.len());
    for l in &wt.layers {
        let Some(comp) = p.component(&l.component_id) else { return fallback() };
        let line = resolve_cut_line_style(p, l);
        bands.push(WallBand {
            thickness: l.thickness,
            color: hex_to_rgb(&comp.color, WALL_RGB),
            hatch: resolve_component_hatch(p, &l.component_id, Some(SECTION_WALL_AXIS_ANGLE_DEG)),
            material_index: material_layer(p, maps, &l.component_id),
            priority: Some(comp.join_priority),
            component_id: Some(comp.id.clone()),
            cut_line_color: line.0,
            cut_line_weight: line.1,
        });
    }
    (bands, true)
}

fn band_cut_meta(b: &WallBand) -> Option<RCutMeta> {
    if b.priority.is_none() && b.component_id.is_none() && b.cut_line_color.is_none() && b.cut_line_weight.is_none() {
        return None;
    }
    Some(RCutMeta { join_priority: b.priority, component_id: b.component_id.clone(), line_color: b.cut_line_color, line_weight: b.cut_line_weight })
}

fn with_top_angle(mut h: style::RHatch, dx: f64, dy: f64) -> style::RHatch {
    let wall_angle = (atan2(dy, dx) * 180.0) / std::f64::consts::PI;
    let svg_angle = if h.relative_to_wall { h.base_angle - wall_angle } else { h.base_angle };
    let quarter = if h.pattern == 2.0 || h.pattern == 3.0 { 90.0 } else { 0.0 };
    h.top_angle = Some(-svg_angle + quarter);
    h
}

fn kv(v: Vec2) -> KVec {
    KVec::new(v.x, v.y)
}

pub(crate) fn wall_reference(w: &Wall) -> Reference {
    match (w.reference_offset, w.reference_line) {
        (Some(v), _) => Reference::Offset(v),
        (None, Some(WallReferenceLine::Left)) => Reference::Left,
        (None, Some(WallReferenceLine::Right)) => Reference::Right,
        _ => Reference::Center,
    }
}

fn wall_ref(p: &Project, w: &Wall) -> WallRef {
    let total = p.wall_thickness(w, 0.2);
    // Bogenwand ([T2]): abgewickelt (Achsmass = Bogenlänge).
    if let Some((_, v)) = crate::wall_arc::unrolled_wall(w) {
        return WallRef { start: opening_geom::v(v.start.x, v.start.y), end: opening_geom::v(v.end.x, v.end.y), total, ref_off: joins::reference_offset(wall_reference(w), total) };
    }
    WallRef { start: opening_geom::v(w.start.x, w.start.y), end: opening_geom::v(w.end.x, w.end.y), total, ref_off: joins::reference_offset(wall_reference(w), total) }
}

/// Öffnungs-Intervall und vertikale Lage aller Öffnungen einer Wand.
fn wall_openings(p: &Project, w: &Wall, openings: &[&Opening], with_recess: bool) -> Vec<OpeningIn> {
    let wr = wall_ref(p, w);
    let (zb, zt) = p.wall_vertical_extent(w);
    let mut out = Vec::new();
    for &o in openings {
        let Some((from, to)) = opening_geom::opening_interval(&wr, o.position, o.width) else { continue };
        let o_bottom = zb + o.sill_height.max(0.0);
        let o_top = zt.min(o_bottom + o.height);
        let recess = with_recess && o.kind == ElementKind::Window && p.window_type(o).and_then(|t| t.inner_layer_recess) == Some(true);
        out.push(OpeningIn { from, to, z_bottom: o_bottom, z_top: o_top, recess_inner_layer: recess });
    }
    out
}

/// Schichteinzug der Öffnungen einer Wand für die Schichtbänder ([106]); Intervall und Höhe wie
/// [`wall_openings`], damit `wall_bands` sie zuordnet.
fn wall_reveals(p: &Project, w: &Wall, openings: &[&Opening], n_bands: usize) -> Vec<wall_bands::RevealIn> {
    let (zb, zt) = p.wall_vertical_extent(w);
    let mut out = Vec::new();
    for &o in openings {
        let Some(r) = crate::opening_detail::opening_reveal(p, w, o) else { continue };
        if r.thick.len() != n_bands {
            continue;
        }
        let o_bottom = zb + o.sill_height.max(0.0);
        let o_top = zt.min(o_bottom + o.height);
        let mut shifts = vec![[0.0; 4]; n_bands];
        let mut pieces = Vec::new();
        for (k, side) in r.sides.iter().enumerate() {
            for a in side {
                shifts[a.layer][k] = a.shift;
                // Formöffnung ([G3]): Zusatzstücke laufen dem Umriss entlang (`shaped_wall_fill`).
                for pc in a.pieces.iter().filter(|_| !crate::opening_shape::is_shaped(o)) {
                    pieces.push((a.layer, k, *pc));
                }
            }
        }
        out.push(wall_bands::RevealIn { from: r.from, to: r.to, z_bottom: o_bottom, z_top: o_top, shifts, pieces });
    }
    out
}

/// Verschneidung je Geschoss (`computeJoinsByFloor`); Fehler = unbekannter Wandtyp/Bauteil.
fn compute_joins_by_floor(p: &Project) -> Result<HashMap<String, WallCuts>, String> {
    let mut merged = HashMap::new();
    for (_, idx) in floor_groups(p) {
        let (jw, finite) = floor_join_input(p, &idx);
        let mut cuts = floor_join_cuts(&jw, finite);
        trim_at_columns(p, &idx, &mut cuts);
        for (&i, c) in idx.iter().zip(cuts) {
            merged.insert(p.walls[i].id.clone(), c);
        }
    }
    Ok(merged)
}

/// [141] Wand endet in einer Stütze desselben Geschosses (wie im Grundriss, `plan::wall_columns`):
/// Stütze prioritärer oder gleiches Bauteil → das Wandende folgt der Stützenkontur. Nur wenn die Stütze
/// die ganze Wandhöhe deckt (sonst bliebe über/unter ihr eine Lücke); die prioritärere Wand beschneidet
/// umgekehrt die Stütze ([`column_pieces`]).
pub(crate) fn trim_at_columns(p: &Project, idx: &[usize], cuts: &mut [WallCuts]) {
    let Some(&first) = idx.first() else { return };
    let floor = p.walls[first].floor_id.as_str();
    let cols: Vec<(&Column, Vec<Vec2>, (f64, f64))> = p
        .columns
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|c| c.floor_id == floor && c.height > 0.0)
        .map(|c| (c, column_footprint(c), p.column_vertical_extent(c)))
        .collect();
    if cols.is_empty() {
        return;
    }
    for (k, &i) in idx.iter().enumerate() {
        let w = &p.walls[i];
        if cuts[k].covered {
            continue;
        }
        let (wb, wt) = p.wall_vertical_extent(w);
        let cover: Vec<(&Column, Vec<Vec2>)> = cols.iter().filter(|c| c.2 .0 <= wb + 1e-6 && c.2 .1 >= wt - 1e-6).map(|c| (c.0, c.1.clone())).collect();
        if !cover.is_empty() {
            crate::plan::wall_columns::trim_walls_at_columns(p, &[w], &cover, &mut cuts[k..k + 1]);
        }
    }
}

/// Schnitt-/Ansichts-Eingabe (ungeschichtet): von der Verschneidung nur, was den Körper ändert, ohne
/// Gehrungen (die vereinigt der Schnitt selbst) — verdeckte Wand, kollineare Stossfuge, Ende an einer
/// Stütze ([141]).
pub(crate) fn section_cuts(c: &WallCuts) -> WallCuts {
    WallCuts {
        covered: c.covered,
        collinear: c.collinear,
        at_column: c.at_column,
        start_cut: c.start_cut.filter(|_| c.collinear[0] || c.at_column[0]),
        end_cut: c.end_cut.filter(|_| c.collinear[1] || c.at_column[1]),
        ..Default::default()
    }
}

/// Wände je Geschoss (Positionen in `p.walls`), Geschosse in der Reihenfolge ihres ersten Auftretens.
pub(crate) fn floor_groups(p: &Project) -> Vec<(&str, Vec<usize>)> {
    let mut groups: Vec<(&str, Vec<usize>)> = Vec::new();
    let mut at: HashMap<&str, usize> = HashMap::new();
    for (i, w) in p.walls.iter().enumerate() {
        match at.get(w.floor_id.as_str()) {
            Some(&g) => groups[g].1.push(i),
            None => {
                at.insert(w.floor_id.as_str(), groups.len());
                groups.push((w.floor_id.as_str(), vec![i]));
            }
        }
    }
    groups
}

/// Eingabe der Verschneidung eines Geschosses (Wände `idx`) und ob sie endlich ist.
pub(crate) fn floor_join_input(p: &Project, idx: &[usize]) -> (Vec<JoinWall>, bool) {
    let mut comp_index: HashMap<&str, u32> = HashMap::new();
    let mut jw: Vec<JoinWall> = Vec::with_capacity(idx.len());
    let mut finite = true;
    for &i in idx {
        let w = &p.walls[i];
        // Hängende Wandtypen/Bauteile (Datei/Import) verschneiden mit den Rückfall-Werten.
        let layers = Some(
            p.wall_type_or_fallback(w)
                .layers
                .iter()
                .map(|l| {
                    let comp = p.component_or_fallback(&l.component_id);
                    let n = comp_index.len() as u32;
                    let idx = *comp_index.entry(comp.id.as_str()).or_insert(n);
                    JoinLayer { thickness: l.thickness, component: Some(idx), priority: comp.join_priority }
                })
                .collect::<Vec<_>>(),
        );
        let reference = wall_reference(w);
        finite &= [w.start.x, w.start.y, w.end.x, w.end.y].iter().all(|v| v.is_finite())
            && !matches!(reference, Reference::Offset(v) if !v.is_finite())
            && layers.as_ref().is_none_or(|l| l.iter().all(|x| x.thickness.is_finite()));
        jw.push(JoinWall { start: kv(w.start), end: kv(w.end), reference, layers, bulge: w.bulge });
    }
    (jw, finite)
}

/// Schnittlinien je Wand eines Geschosses (gleich lang wie `jw`); nicht endlich oder Fehler = ohne.
pub(crate) fn floor_join_cuts(jw: &[JoinWall], finite: bool) -> Vec<WallCuts> {
    if !finite {
        return vec![WallCuts::default(); jw.len()];
    }
    // Mit den Rückfällen oben nicht mehr erwartet: dann eben ohne Verschneidung.
    joins::compute_joins(jw).unwrap_or_else(|_| vec![WallCuts::default(); jw.len()])
}

pub(crate) fn floor_context(p: &Project, floor_id: &str, with_ceilings: bool) -> FloorContext {
    let ceilings: Vec<CeilingIn> = p
        .ceilings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|c| with_ceilings && c.floor_id == floor_id && c.outline.len() >= 3)
        .map(|c| {
            let (z_bottom, z_top) = p.ceiling_vertical_extent(c);
            CeilingIn {
                z_bottom,
                z_top,
                outline: c.outline.iter().map(|v| kv(*v)).collect(),
                layers: ceiling_layers(p, c).map(|ls| ls.iter().map(|l| (l.thickness, p.component(&l.component_id).map(|k| k.join_priority))).collect()),
            }
        })
        .collect();
    let roofs: Vec<RoofIn> = p
        .roofs
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|r| r.floor_id == floor_id)
        .map(|r| {
            let eaves_z = p.roof_base_elevation(r);
            let geo = crate::roof::roof_geometry(&r.params(), eaves_z);
            let total: f64 = p.roof_layers(r).iter().fold(0.0, |s, l| s + l.thickness.max(0.0));
            let mut ri = RoofIn::new(eaves_z, total, geo.eaves, geo.planes);
            // Gauben ([G2]): unter dem Gaubeninneren endet die Wand an der Gaubendach-Unterkante.
            for d in r.dormers.as_deref().unwrap_or(&[]) {
                if let Some(g) = crate::dormer::geometry(p, r, d) {
                    ri.facets.extend(g.under_facets());
                }
            }
            ri
        })
        .collect();
    FloorContext::new(ceilings, roofs)
}

/// Liegt der Achspunkt `p` eines Bogen-Teilkörpers an einer inneren Stossfuge (nicht an Anfang, Ende
/// oder einer Laibung)?
fn inner_joint(a: &crate::wall_arc::WallArc, _w: &Wall, keep: &[f64], p: KVec) -> bool {
    let (s, _) = a.local(p);
    keep.iter().all(|k| (s - k).abs() > 0.01)
}

/// Wandkörper (`projectToWalls3d`): `layered` = ein Körper je Schicht mit Löchern (3D-Viewer),
/// sonst Pfeiler/Brüstung/Sturz-Segmente (Schnitt-Eingabe).
pub fn emit_walls(p: &Project, layered: bool) -> Result<Vec<RWall>, String> {
    emit_walls_with(p, layered, true)
}

/// Wie [`emit_walls`]; `pockets = false` lässt die Taschen der Taschen-Schiebetüren im Körper ([95]) —
/// für Schnitt/Ansicht, die die Wand nach Schichten aufteilen und die Tasche selbst aussparen.
pub fn emit_walls_with(p: &Project, layered: bool, pockets: bool) -> Result<Vec<RWall>, String> {
    let joins = compute_joins_by_floor(p)?;
    let maps = wall_material_color_maps(p);
    let mut contexts: HashMap<&str, FloorContext> = HashMap::new();
    let mut out = Vec::new();
    let by_wall = p.openings_by_wall();
    for wall in &p.walls {
        // Schnitt-Eingabe: nur die Dächer ([G2]); Decken rechnet der Schnitt selbst (Dominanz).
        let ctx = contexts.entry(wall.floor_id.as_str()).or_insert_with(|| floor_context(p, &wall.floor_id, layered));
        let openings = by_wall.get(wall.id.as_str()).map_or(&[][..], |v| v.as_slice());
        let cuts = joins.get(&wall.id).map_or_else(WallCuts::default, |c| if layered { c.clone() } else { section_cuts(c) });
        wall_pieces(p, &maps, wall, ctx, openings, cuts, layered, pockets, &mut out);
    }
    Ok(out)
}

/// Die Körper EINER Wand (Schleifenrumpf von [`emit_walls_with`], hinten an `out` angehängt): hängt nur
/// von der Wand, ihren Öffnungen, ihren Schnittlinien `cuts` (Verschneidung mit den Nachbarn), dem
/// Geschoss-Kontext und den Typen/Materialien/Geschossen ab — der 3D-Cache ([58], `model3d_cache.rs`)
/// behält das Ergebnis je Wand.
#[allow(clippy::too_many_arguments)]
pub(crate) fn wall_pieces(p: &Project, maps: &[String], wall: &Wall, ctx: &FloorContext, openings: &[&Opening], cuts: WallCuts, layered: bool, pockets: bool, out: &mut Vec<RWall>) {
    // [141] Ganz in einer kollinearen Wand gleichen Typs: deren Körper zeigt sie mit (nicht doppelt).
    if cuts.covered {
        return;
    }
    {
        let (bands, stacked) = resolve_wall_bands(p, maps, wall, layered);
        let (z_bottom, z_top) = p.wall_vertical_extent(wall);
        let win = wall_bands::WallIn {
            start: kv(wall.start),
            end: kv(wall.end),
            z_bottom,
            z_top,
            layered,
            stacked,
            reference: wall_reference(wall),
            thickness_safe: p.wall_thickness(wall, 0.2),
            termination: match wall.slice_termination {
                Some(SliceTermination::Below) => Termination::Below,
                Some(SliceTermination::Above) => Termination::Above,
                _ => Termination::Both,
            },
            bands: bands.iter().map(|b| BandIn { thickness: b.thickness, priority: b.priority }).collect(),
            openings: wall_openings(p, wall, openings, true),
            cuts,
            roof_attach: wall.roof_attach,
            reveals: if layered && stacked { wall_reveals(p, wall, openings, bands.len()) } else { Vec::new() },
        };
        // Bogenwand ([T2]): Sehnen-Teilwände mit radialen Gehrungen.
        let arc = crate::wall_arc::WallArc::of_wall(wall);
        // Echte Enden der Bogenwand: Anfang, Ende, Laibungen.
        let keep: Vec<f64> = match arc {
            Some(a) => [0.0, a.length()].into_iter().chain(win.openings.iter().flat_map(|o| [o.from, o.to])).collect(),
            None => Vec::new(),
        };
        let wins = match arc {
            Some(a) => crate::wall_arc::chord_walls(&win, &a),
            None => vec![win],
        };
        let first_piece = out.len();
        // [95] Taschen (Achsmass; bei Bogenwänden = Bogenlänge, je Sehnen-Teilwand abgebildet).
        let pocket_cuts = if pockets { wall_pocket_cuts(p, wall, openings) } else { Vec::new() };
        for win in &wins {
        let win_first = out.len();
        let (dx, dy) = (win.end.x - win.start.x, win.end.y - win.start.y);
        for mut piece in wall_bands::wall_bands(win, ctx) {
            let Some(b) = bands.get(piece.band) else { continue };
            // Schnitt-Eingabe der Bogen-Teilwände: radiale Gehrungen auch ohne Schichtband-Pfad.
            if arc.is_some() && !layered {
                piece.start_cut = piece.start_cut.or(win.cuts.start_cut);
                piece.end_cut = piece.end_cut.or(win.cuts.end_cut);
            }
            out.push(RWall {
                start: [piece.start.x, piece.start.y],
                end: [piece.end.x, piece.end.y],
                thickness: piece.thickness.unwrap_or(b.thickness),
                height: piece.z_top - piece.z_bottom,
                base_elevation: piece.z_bottom,
                top_drop: piece.top_drop,
                top_plane: piece.top_plane.map(|c| [c[0] + c[1] * piece.start.x + c[2] * piece.start.y, c[1], c[2]]),
                color: b.color,
                layers: vec![],
                wall_id: wall.id.clone(),
                holes: (!piece.holes.is_empty()).then(|| piece.holes.iter().map(|h| RHole { from: h[0], to: h[1], z_bottom: h[2], z_top: h[3] }).collect()),
                hatch: b.hatch.clone().map(|h| with_top_angle(h, dx, dy)),
                material_index: b.material_index,
                cut: band_cut_meta(b),
                start_cut: piece.start_cut.map(|l| [l.point.x, l.point.y, l.dir.x, l.dir.y]),
                end_cut: piece.end_cut.map(|l| [l.point.x, l.point.y, l.dir.x, l.dir.y]),
                joint: {
                    let j = arc.map_or([false; 2], |a| [inner_joint(&a, wall, &keep, piece.start), inner_joint(&a, wall, &keep, piece.end)]);
                    [j[0] || piece.joint[0], j[1] || piece.joint[1]]
                },
            });
        }
        if let (Some(a), false) = (arc, pocket_cuts.is_empty()) {
            // Sehne pa→pb über die Bogenlänge [sa, sb]: Achsmass linear auf die Sehne abgebildet.
            let (sa, sb) = (a.local(win.start).0, a.local(win.end).0);
            let chord = hypot2(dx, dy);
            if (sb - sa).abs() > 1e-9 {
                let m = |u: f64| (u - sa) / (sb - sa) * chord;
                let cuts: Vec<[f64; 6]> = pocket_cuts.iter().map(|c| [m(c[0]), m(c[1]), c[2], c[3], c[4], c[5]]).collect();
                cut_wall_pockets([win.start.x, win.start.y], [dx, dy], &cuts, out, win_first);
            }
        }
        }
        if arc.is_none() && !pocket_cuts.is_empty() {
            cut_wall_pockets([wall.start.x, wall.start.y], [wall.end.x - wall.start.x, wall.end.y - wall.start.y], &pocket_cuts, out, first_piece);
        }
    }
}

/// [95] Taschen der Taschen-Schiebetüren einer Wand: je Tasche `[u0, u1, n0, n1, z0, z1]` im Wandrahmen
/// (Achsmass ab Wandstart, Querversatz zur Achse, absolute Höhen der Öffnung) — Hohlraum samt Blattbahn
/// durch die Öffnung (`Pocket::cut`).
pub(crate) fn wall_pocket_cuts(p: &Project, w: &Wall, openings: &[&Opening]) -> Vec<[f64; 6]> {
    let wr = wall_ref(p, w);
    let (zb, zt) = p.wall_vertical_extent(w);
    let mut out = Vec::new();
    for &o in openings {
        let Some(dt) = p.door_type(o).filter(|t| o.kind == ElementKind::Door && t.kind == DoorTypeKind::Tasche) else { continue };
        let count = crate::jsnum::max(1.0, crate::jsnum::round(dt.leaf_count));
        let hinge_end = o.hinge.is_some_and(|s| s != OpeningHinge::Start);
        let z0 = zb + o.sill_height.max(0.0);
        let z1 = zt.min(z0 + o.height);
        if z1 - z0 <= 1e-6 {
            continue;
        }
        for k in opening_geom::pocket_cavities(&wr, o.position, o.width, hinge_end, count) {
            let (u0, u1, n0, n1) = k.cut();
            out.push([u0, u1, n0, n1, z0, z1]);
        }
    }
    out
}

/// [95] Taschen `cuts` (`[u0, u1, n0, n1, z0, z1]` im Rahmen `origin` + Achsrichtung `dir`: gerade Wand
/// oder Sehnen-Teilwand einer Bogenwand) aus den Wandkörpern `pieces[from..]` ausschneiden: ein Körper,
/// der quer in die Tasche reicht, wird quer geteilt (aussen unverändert); der mittlere Teil entlang der
/// Achse um die Tasche geteilt, über ihr (und unter ihr bei Brüstung) bleibt Wand. Schräge Oberkante
/// (`top_plane`/`top_drop`): die Teile behalten die Dachebene, Höhe und Absenkung neu je Teil.
fn cut_wall_pockets(origin: [f64; 2], dir: [f64; 2], cuts: &[[f64; 6]], pieces: &mut Vec<RWall>, from: usize) {
    if cuts.is_empty() {
        return;
    }
    let l = hypot2(dir[0], dir[1]);
    if !(l > 1e-9) {
        return;
    }
    let (ux, uy) = (dir[0] / l, dir[1] / l);
    let (nx, ny) = (-uy, ux);
    let eps = 1e-6;
    for &c in cuts {
        let [cu0, cu1, cn0, cn1, cz0, cz1] = c;
        let tail = pieces.split_off(from);
        for w in tail {
            let (pdx, pdy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
            let len = hypot2(pdx, pdy);
            let rel = [w.start[0] - origin[0], w.start[1] - origin[1]];
            let (ps, pn) = (rel[0] * ux + rel[1] * uy, rel[0] * nx + rel[1] * ny);
            // Nur zur Wand parallele Körper (Laufrichtung wie die Wand).
            let parallel = len > 1e-9 && (pdx * ux + pdy * uy) > len * (1.0 - 1e-9);
            let (a, b) = (pn - w.thickness / 2.0, pn + w.thickness / 2.0);
            let (h0, h1) = (cu0 - ps, cu1 - ps);
            let zt = w.base_elevation + w.height;
            let hit = parallel && a < cn1 - eps && b > cn0 + eps && h0 < len - eps && h1 > eps && w.base_elevation < cz1 - eps && zt > cz0 + eps;
            if !hit {
                pieces.push(w);
                continue;
            }
            // Quer: [a, m0] aussen, [m0, m1] Tasche, [m1, b] aussen.
            let (m0, m1) = (a.max(cn0), b.min(cn1));
            let across = |w: &RWall, lo: f64, hi: f64| -> RWall {
                let sh = (lo + hi) / 2.0 - pn;
                let mut q = w.clone();
                q.start = [w.start[0] + nx * sh, w.start[1] + ny * sh];
                q.end = [w.end[0] + nx * sh, w.end[1] + ny * sh];
                q.thickness = hi - lo;
                if let Some(t) = &mut q.top_plane {
                    t[0] += t[1] * nx * sh + t[2] * ny * sh;
                }
                q
            };
            for (lo, hi) in [(a, m0), (m1, b)] {
                if hi - lo > eps {
                    pieces.push(across(&w, lo, hi));
                }
            }
            let mid = across(&w, m0, m1);
            // Entlang: [0, h0] und [h1, len] voll, [h0, h1] nur über/unter der Tasche.
            let (k0, k1) = (h0.max(0.0), h1.min(len));
            let part = |s: f64, e: f64, z0: f64, z1: f64| -> Option<RWall> {
                if e - s <= eps || z1 - z0 <= eps {
                    return None;
                }
                let mut q = mid.clone();
                q.start = [mid.start[0] + ux * s, mid.start[1] + uy * s];
                q.end = [mid.start[0] + ux * e, mid.start[1] + uy * e];
                q.base_elevation = z0;
                q.height = z1 - z0;
                if s > eps {
                    q.start_cut = None;
                    q.joint[0] = false;
                }
                if e < len - eps {
                    q.end_cut = None;
                    q.joint[1] = false;
                }
                if let Some(t) = &mut q.top_plane {
                    t[0] += t[1] * ux * s + t[2] * uy * s;
                }
                let holes: Vec<RHole> = mid
                    .holes
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|h| {
                        let (f, t) = (h.from.max(s), h.to.min(e));
                        let (hb, ht) = (h.z_bottom.max(z0), h.z_top.min(z1));
                        (t - f > eps && ht - hb > eps).then(|| RHole { from: f - s, to: t - s, z_bottom: hb, z_top: ht })
                    })
                    .collect();
                q.holes = (!holes.is_empty()).then_some(holes);
                Some(q)
            };
            let z_b = w.base_elevation;
            let below = part(k0, k1, z_b, cz0).map(|mut q| {
                // Unter der Tasche (Brüstung): waagrecht auf Taschen-UK.
                q.top_plane = None;
                q.top_drop = None;
                q
            });
            for mut q in [part(0.0, k0, z_b, zt), part(k0, k1, cz1, zt), below, part(k1, len, z_b, zt)].into_iter().flatten() {
                refit_sloped_top(&mut q);
                if q.height > eps {
                    pieces.push(q);
                }
            }
        }
    }
}

/// Teilkörper mit Dachebene (`top_plane`): Höhe = höchster Eckwert (höchstens die bisherige), Absenkung
/// der Mittellinie an Anfang/Ende (`top_drop`) neu.
fn refit_sloped_top(q: &mut RWall) {
    let Some(c) = q.top_plane else { return };
    let Some(fp) = wall_footprint(q) else { return };
    let at = |x: f64, y: f64| c[0] + c[1] * (x - q.start[0]) + c[2] * (y - q.start[1]);
    let zt = q.base_elevation + q.height;
    let top = fp.iter().map(|p| at(p[0], p[1])).fold(f64::NEG_INFINITY, f64::max).min(zt);
    q.height = top - q.base_elevation;
    let d = [top - at(q.start[0], q.start[1]), top - at(q.end[0], q.end[1])];
    q.top_drop = (d[0] > wall_bands::EPS || d[1] > wall_bands::EPS).then_some(d);
}

/// Grundriss-Ecken eines Wandkörpers an seinen Schnittlinien: Anfang +n, Ende +n, Ende −n, Anfang −n
/// (+n = linke Normale). `None` bei entarteter Achse.
pub(crate) fn wall_footprint(w: &RWall) -> Option<[[f64; 2]; 4]> {
    let (dx, dy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
    let l = hypot2(dx, dy);
    if !(l > 1e-9) || !(w.thickness > 0.0) {
        return None;
    }
    let (ux, uy) = (dx / l, dy / l);
    let (nx, ny) = (-uy, ux);
    let h = w.thickness / 2.0;
    let at = |p: [f64; 2], o: f64, cut: Option<[f64; 4]>| -> [f64; 2] {
        let q = [p[0] + nx * o, p[1] + ny * o];
        let Some([cx, cy, ex, ey]) = cut else { return q };
        let den = ux * ey - uy * ex;
        if den.abs() < 1e-12 {
            return q;
        }
        let t = ((cx - q[0]) * ey - (cy - q[1]) * ex) / den;
        if t.is_finite() && t.abs() < l {
            [q[0] + ux * t, q[1] + uy * t]
        } else {
            q
        }
    };
    Some([at(w.start, h, w.start_cut), at(w.end, h, w.end_cut), at(w.end, -h, w.end_cut), at(w.start, -h, w.start_cut)])
}

/// Oberkante eines Wandkörpers an einem Grundriss-Punkt (ebene Oberkante unter einem Dach, [G2]).
pub(crate) fn wall_top_at(w: &RWall, q: [f64; 2]) -> f64 {
    let zt = w.base_elevation + w.height;
    match w.top_plane {
        Some(c) => (c[0] + c[1] * (q[0] - w.start[0]) + c[2] * (q[1] - w.start[1])).clamp(w.base_elevation, zt),
        None => zt,
    }
}

/// Wandkörper mit ebener Oberkante als geschlossenes Netz (Modell x, y, z), ohne Löcher.
pub(crate) fn wall_piece_mesh(w: &RWall) -> Option<crate::solid_bool::Mesh> {
    let fp = wall_footprint(w)?;
    let zb = w.base_elevation;
    let m = crate::solid_bool::Mesh::prism_between(&fp, &|_, _| zb, &|x, y| wall_top_at(w, [x, y]));
    (!m.is_empty()).then_some(m)
}

/// Volumen eines Wandkörpers ohne Löcher: Grundfläche × Höhe im Schwerpunkt (exakt bei ebener Oberkante).
pub(crate) fn wall_piece_volume(w: &RWall) -> f64 {
    let Some(q) = wall_footprint(w) else { return 0.0 };
    let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for i in 0..4 {
        let (p0, p1) = (q[i], q[(i + 1) % 4]);
        let c = p0[0] * p1[1] - p1[0] * p0[1];
        a += c;
        cx += (p0[0] + p1[0]) * c;
        cy += (p0[1] + p1[1]) * c;
    }
    if a.abs() < 1e-15 {
        return 0.0;
    }
    (a / 2.0).abs() * (wall_top_at(w, [cx / (3.0 * a), cy / (3.0 * a)]) - w.base_elevation)
}

// ── Öffnungs-Einbauteile (Glas, Rahmen, Sprossen, Bank, Kasten) ─────────────

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

// ── Treppen ─────────────────────────────────────────────────────────────────

fn stair_rgb() -> Rgb {
    hex_to_rgb("#9aa0a6", SLAB_RGB)
}

fn rail_rgb() -> Rgb {
    hex_to_rgb("#74797f", SLAB_RGB)
}

/// Flache Eingabe der Treppen für `stairs3d` (24 Zahlen je Treppe); `wanted` wählt vor.
fn stair_input<'a>(p: &'a Project, wanted: impl Fn(&Stair, Option<&StairType>) -> bool) -> Option<(Vec<(usize, &'a Stair)>, Vec<f64>)> {
    let mut stairs: Vec<(usize, &Stair)> = Vec::new();
    let mut types: Vec<Option<&StairType>> = Vec::new();
    for (si, s) in p.stairs.as_deref().unwrap_or(&[]).iter().enumerate() {
        let st = p.stair_type(s);
        if !wanted(s, st) {
            continue;
        }
        stairs.push((si, s));
        types.push(st);
    }
    if stairs.is_empty() {
        return None;
    }
    let mut buf = vec![stairs.len() as f64];
    for (&(_, s), st) in stairs.iter().zip(&types) {
        let (z_bottom, z_top) = p.stair_vertical_extent(s);
        buf.extend(s.encode());
        buf.push(z_bottom);
        buf.push(z_top);
        buf.push(match st.map(|t| t.structure) {
            None | Some(StairTypeStructure::Massiv) => 0.0,
            Some(StairTypeStructure::Beton) => 1.0,
            _ => 2.0,
        });
        buf.push(st.map_or(0.04, |t| t.tread_thickness));
        buf.push(st.and_then(|t| t.nosing).unwrap_or(0.0));
        buf.push(if st.is_some_and(|t| t.closed_risers) { 1.0 } else { 0.0 });
        buf.push(match st.and_then(|t| t.railing) {
            Some(StairTypeRailing::Links) => 1.0,
            Some(StairTypeRailing::Rechts) => 2.0,
            Some(StairTypeRailing::Beide) => 3.0,
            _ => 0.0,
        });
        buf.push(s.center_column.filter(|r| r.is_finite() && *r > 0.0).unwrap_or(0.0));
    }
    Some((stairs, buf))
}

/// Treppen als extrudierte Platten (`emitStairs`); `for_section`: auch gerade Betontreppen als Tritte.
pub fn emit_stairs(p: &Project, for_section: bool) -> Vec<RSlab> {
    let Some((stairs, buf)) = stair_input(p, |_, _| true) else { return vec![] };
    stair_slabs(&stairs, crate::stairs3d::slabs(&buf, for_section))
}

/// [151] Treppen für die Ansicht: Ortbeton-Läufe (im 3D Netze) als ein Block je Tritt.
pub fn emit_stairs_elevation(p: &Project) -> Vec<RSlab> {
    let Some((stairs, buf)) = stair_input(p, |_, _| true) else { return vec![] };
    stair_slabs(&stairs, crate::stairs3d::slabs_coarse(&buf))
}

fn stair_slabs(stairs: &[(usize, &Stair)], slabs: Vec<crate::stairs3d::Slab>) -> Vec<RSlab> {
    slabs
        .into_iter()
        .map(|s| {
            let (si, stair) = stairs[s.src];
            RSlab {
                outline: s.pts,
                z_bottom: s.z_bottom,
                z_top: s.z_top,
                color: stair_rgb(),
                ceiling_id: stair.id.clone(),
                hatch: None,
                cut: None,
                monolith: s.monolith.then(|| stair.id.clone()),
                source: SlabSource::Stair { index: si },
            }
        })
        .collect()
}

fn meshes_of(meshes: Vec<crate::mesh3d::Mesh>, color: Rgb) -> Vec<RMesh> {
    meshes.into_iter().map(|m| RMesh {
                    crease_angle: None, positions: m.positions, indices: m.indices, kind: "extrusion", color, vertex_colors: None, material_index: None }).collect()
}

/// Glatte Ortbeton-Laufplatten (je Lauf: gerade, L, U, gerade mit Podest) und Wendelfläche (Schraubenfläche)
/// von Wendeltreppen (`emitStairMeshes`).
pub fn emit_stair_meshes(p: &Project) -> Vec<RMesh> {
    match stair_input(p, |s, st| st.is_some_and(|t| t.structure == StairTypeStructure::Beton) && s.shape != StairShape::Unknown) {
        Some((_, buf)) => meshes_of(crate::stairs3d::slab_meshes(&buf), stair_rgb()),
        None => vec![],
    }
}

/// [G1] Laufplatten der Betontreppen aus geraden Läufen (gerade, L, U, gerade mit Podest; [151]) je Treppe
/// (Index in `p.stairs`): Netze mit exakter Untersicht, für den Schnitt (`plan::section`).
pub fn stair_flight_meshes(p: &Project) -> Vec<(usize, crate::mesh3d::Mesh)> {
    match stair_input(p, |s, st| st.is_some_and(|t| t.structure == StairTypeStructure::Beton) && matches!(s.shape, StairShape::Straight | StairShape::L | StairShape::U | StairShape::StraightLanding)) {
        Some((stairs, buf)) => crate::stairs3d::slab_meshes(&buf).into_iter().filter_map(|m| stairs.get(m.src).map(|&(si, _)| (si, m))).collect(),
        None => vec![],
    }
}

/// Handlauf und Pfosten der Treppen (`emitStairRailings`); bei Wendeltreppen als Schraubensweep, bei
/// Podesttreppen (L, U, gerade mit Podest) über die Podeste ([151]).
pub fn emit_stair_railings(p: &Project) -> Vec<RMesh> {
    match stair_input(p, |s, st| s.shape != StairShape::Unknown && st.and_then(|t| t.railing).is_some_and(|r| r != StairTypeRailing::Keine)) {
        Some((_, buf)) => meshes_of(crate::stairs3d::railings(&buf), rail_rgb()),
        None => vec![],
    }
}

// ── Dächer ──────────────────────────────────────────────────────────────────

use crate::jsmath::hypot;
use crate::jsnum::round;

type V3 = [f64; 3];
const ROOF_RGB: Rgb = [0.72, 0.45, 0.36];
const EPS: f64 = 1e-4;

/// Eine Dachschicht für den Live-Schnitt (`RRoofLayer`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RRoofLayer {
    pub polygon: Vec<V3>,
    pub normal: V3,
    pub thickness: f64,
    pub color: Rgb,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut: Option<RCutMeta>,
}

fn push_fan_triangles(positions: &mut Vec<f64>, indices: &mut Vec<u32>, pts: &[V3], flip: bool) {
    if pts.len() < 3 {
        return;
    }
    let base = (positions.len() / 3) as u32;
    for p in pts {
        positions.extend(*p);
    }
    for i in 1..pts.len() as u32 - 1 {
        if flip {
            indices.extend([base, base + i + 1, base + i]);
        } else {
            indices.extend([base, base + i, base + i + 1]);
        }
    }
}

/// Newell-Normale einer Dachfläche, nach oben orientiert (`planeNormalUp`).
pub(crate) fn plane_normal_up(pts: &[V3]) -> V3 {
    let (mut nx, mut ny, mut nz) = (0.0, 0.0, 0.0);
    for i in 0..pts.len() {
        let c = pts[i];
        let d = pts[(i + 1) % pts.len()];
        nx += (c[1] - d[1]) * (c[2] + d[2]);
        ny += (c[2] - d[2]) * (c[0] + d[0]);
        nz += (c[0] - d[0]) * (c[1] + d[1]);
    }
    let len = hypot(&[nx, ny, nz]);
    let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    let u = [nx / len, ny / len, nz / len];
    if u[2] < 0.0 {
        [-u[0], -u[1], -u[2]]
    } else {
        u
    }
}

fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Gehrte Versatz-Ecken aller Dachflächen (`mitredRoofOffsets`). [G9]: an einem Punkt, an dem
/// mehr als zwei Flächen zusammentreffen (Walm-/Zeltspitze, Kehlpunkt, konvexe Teilstücke einer
/// Fläche), bekommen ALLE Flächen dieselbe versetzte Ecke — Ausgleich über alle beteiligten
/// Ebenen (kleinste Quadrate) statt je Fläche paarweise mit zwei Nachbarn; sonst klaffen dort
/// Lücken und der Dachkörper ist nicht geschlossen.
struct Mitre<'a> {
    planes: &'a [Vec<V3>],
    normals: Vec<V3>,
    neighbor: Vec<Vec<isize>>,
    shared: Vec<Vec<bool>>,
    /// Je Fläche und Ecke: alle (Fläche, Ecke) am selben Punkt (inkl. sich selbst).
    incident: Vec<Vec<Vec<(usize, usize)>>>,
}

impl<'a> Mitre<'a> {
    fn new(planes: &'a [Vec<V3>]) -> Self {
        let key = |p: &V3| (round(p[0] * 1e5) as i64, round(p[1] * 1e5) as i64, round(p[2] * 1e5) as i64);
        let ek = |a: &V3, b: &V3| {
            let (ka, kb) = (key(a), key(b));
            if ka <= kb { (ka, kb) } else { (kb, ka) }
        };
        let mut owners: HashMap<_, Vec<usize>> = HashMap::new();
        for (i, pts) in planes.iter().enumerate() {
            for k in 0..pts.len() {
                owners.entry(ek(&pts[k], &pts[(k + 1) % pts.len()])).or_default().push(i);
            }
        }
        let normals: Vec<V3> = planes.iter().map(|p| plane_normal_up(p)).collect();
        let neighbor: Vec<Vec<isize>> = planes
            .iter()
            .enumerate()
            .map(|(i, pts)| {
                (0..pts.len())
                    .map(|k| {
                        owners
                            .get(&ek(&pts[k], &pts[(k + 1) % pts.len()]))
                            .and_then(|o| o.iter().find(|&&x| x != i))
                            .map_or(-1, |&j| j as isize)
                    })
                    .collect()
            })
            .collect();
        let shared = neighbor.iter().map(|row| row.iter().map(|&j| j >= 0).collect()).collect();
        let mut at_point: HashMap<_, Vec<(usize, usize)>> = HashMap::new();
        for (i, pts) in planes.iter().enumerate() {
            for (k, p) in pts.iter().enumerate() {
                at_point.entry(key(p)).or_default().push((i, k));
            }
        }
        let incident = planes.iter().map(|pts| pts.iter().map(|p| at_point.get(&key(p)).cloned().unwrap_or_default()).collect()).collect();
        Mitre { planes, normals, neighbor, shared, incident }
    }

    fn edge_plane(&self, i: usize, k: usize, d: f64) -> (V3, f64) {
        let pts = &self.planes[i];
        let a = pts[k];
        let b = pts[(k + 1) % pts.len()];
        let j = self.neighbor[i][k];
        if j >= 0 {
            let j = j as usize;
            return (self.normals[j], dot3(self.normals[j], self.planes[j][0]) - d);
        }
        let dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let m = cross3(dir, self.normals[i]);
        (m, dot3(m, a))
    }

    fn solve(rows: [(V3, f64); 3]) -> Option<V3> {
        let [(a, ca), (b, cb), (c, cc)] = rows;
        let bc = cross3(b, c);
        let det = dot3(a, bc);
        if det.abs() < 1e-9 {
            return None;
        }
        let cxa = cross3(c, a);
        let axb = cross3(a, b);
        Some([
            (ca * bc[0] + cb * cxa[0] + cc * axb[0]) / det,
            (ca * bc[1] + cb * cxa[1] + cc * axb[1]) / det,
            (ca * bc[2] + cb * cxa[2] + cc * axb[2]) / det,
        ])
    }

    /// Versetzte Ecke `k` der Fläche `i` aus ihrer Versatzebene und den Ebenen ihrer beiden Randkanten
    /// (Nachbar-Versatzebene bzw. Seitenebene an der Traufe); ohne Lösung die Normalen-Verschiebung.
    fn pair_corner(&self, i: usize, k: usize, d: f64) -> V3 {
        let pts = &self.planes[i];
        let n = self.normals[i];
        let p = pts[k];
        let prev = (k + pts.len() - 1) % pts.len();
        let fallback = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
        let own = (n, dot3(n, pts[0]) - d);
        let near = |q: V3| hypot(&[q[0] - fallback[0], q[1] - fallback[1], q[2] - fallback[2]]) <= 4.0 * d + 0.5;
        match Self::solve([own, self.edge_plane(i, prev, d), self.edge_plane(i, k, d)]) {
            Some(q) if near(q) => q,
            _ => fallback,
        }
    }

    fn at(&self, i: usize, d: f64) -> Vec<V3> {
        let pts = &self.planes[i];
        let n = self.normals[i];
        if d <= EPS {
            return pts.clone();
        }
        (0..pts.len())
            .map(|k| {
                let p = pts[k];
                let prev = (k + pts.len() - 1) % pts.len();
                let fallback = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
                if !self.shared[i][prev] && !self.shared[i][k] {
                    return fallback;
                }
                let near = |q: V3| hypot(&[q[0] - fallback[0], q[1] - fallback[1], q[2] - fallback[2]]) <= 4.0 * d + 0.5;
                // Zwei Flächen am Punkt: wie bisher paarweise (exakt, unverändert).
                let pairwise = || self.pair_corner(i, k, d);
                let inc = &self.incident[i][k];
                if inc.len() == 2 {
                    // Verschieden geneigte Flächen ([26], Neigung je Kante): die Traufen-Seitenebenen beider
                    // Flächen schneiden die Gratgerade an verschiedenen Stellen — beide Flächen nehmen dann
                    // den Mittelpunkt (liegt weiter auf beiden Versatzebenen), sonst klafft dort eine Lücke.
                    // Bei gleicher Neigung fallen beide Punkte zusammen: unverändert.
                    let q1 = pairwise();
                    let &(j, kj) = inc.iter().find(|&&(a, b)| (a, b) != (i, k)).unwrap_or(&(i, k));
                    if j != i {
                        let q2 = self.pair_corner(j, kj, d);
                        let gap = hypot(&[q2[0] - q1[0], q2[1] - q1[1], q2[2] - q1[2]]);
                        if gap > 1e-9 && gap < 4.0 * d + 0.5 {
                            let m = [(q1[0] + q2[0]) / 2.0, (q1[1] + q2[1]) / 2.0, (q1[2] + q2[2]) / 2.0];
                            let on = |a: usize| (dot3(self.normals[a], m) - (dot3(self.normals[a], self.planes[a][0]) - d)).abs() < 1e-7;
                            if on(i) && on(j) {
                                return m;
                            }
                        }
                    }
                    return q1;
                }
                if inc.len() <= 2 {
                    return pairwise();
                }
                match self.common(inc, d) {
                    Some(q) if near(q) => q,
                    _ => pairwise(),
                }
            })
            .collect()
    }

    /// Gemeinsame versetzte Ecke aller Flächen `inc` (Fläche, Ecke) an einem Punkt: kleinste
    /// Quadrate über alle verschiedenen Ebenen (Flächen um `d` versetzt, Ränder ohne Nachbarn als
    /// Seitenebene), schwach zum Mittel der Normalen-Versätze gezogen (macht unterbestimmte Fälle
    /// eindeutig: eine Ebene → Normalenversatz, zwei → nächster Punkt der Schnittgeraden).
    /// Treffen sich die Ebenen in einem Punkt, ist es dieser.
    fn common(&self, inc: &[(usize, usize)], d: f64) -> Option<V3> {
        let mut rows: Vec<(V3, f64)> = Vec::new();
        let mut push = |(m, c): (V3, f64)| {
            let l = hypot(&m);
            if !(l > 1e-12) {
                return;
            }
            let (m, c) = ([m[0] / l, m[1] / l, m[2] / l], c / l);
            let same = |r: &(V3, f64)| {
                (hypot(&[r.0[0] - m[0], r.0[1] - m[1], r.0[2] - m[2]]) < 1e-9 && (r.1 - c).abs() < 1e-9)
                    || (hypot(&[r.0[0] + m[0], r.0[1] + m[1], r.0[2] + m[2]]) < 1e-9 && (r.1 + c).abs() < 1e-9)
            };
            if !rows.iter().any(same) {
                rows.push((m, c));
            }
        };
        let mut f = [0.0; 3];
        for &(j, kk) in inc {
            let pts = &self.planes[j];
            let nj = self.normals[j];
            push((nj, dot3(nj, pts[0]) - d));
            let prev = (kk + pts.len() - 1) % pts.len();
            for e in [prev, kk] {
                if !self.shared[j][e] {
                    push(self.edge_plane(j, e, d));
                }
            }
            let p = pts[kk];
            for a in 0..3 {
                f[a] += (p[a] - nj[a] * d) / inc.len() as f64;
            }
        }
        let normal_eq = |rows: &[(V3, f64)]| {
            let mut m = [[0.0; 3]; 3];
            let mut b = [0.0; 3];
            for (n, c) in rows {
                for r in 0..3 {
                    for col in 0..3 {
                        m[r][col] += n[r] * n[col];
                    }
                    b[r] += n[r] * c;
                }
            }
            Self::solve([(m[0], b[0]), (m[1], b[1]), (m[2], b[2])])
        };
        if let Some(q) = normal_eq(&rows) {
            return q.iter().all(|v| v.is_finite()).then_some(q);
        }
        // Unterbestimmt (Ebenen schneiden sich in einer Geraden, z. B. zwei Teilstücke am
        // Mansardknick): der Punkt der Geraden, der dem Mittel der Normalen-Versätze am nächsten ist.
        let (n1, _) = *rows.first()?;
        let n2 = rows.iter().map(|r| cross3(n1, r.0)).max_by(|a, b| hypot(a).total_cmp(&hypot(b)))?;
        let l = hypot(&n2);
        if !(l > 1e-6) {
            // Nur eine Richtung: Mittel auf die (gemittelte) Ebene legen.
            let c = rows.iter().map(|r| r.1 * dot3(r.0, n1).signum()).sum::<f64>() / rows.len() as f64;
            let t = c - dot3(n1, f);
            return Some([f[0] + n1[0] * t, f[1] + n1[1] * t, f[2] + n1[2] * t]);
        }
        let dir = [n2[0] / l, n2[1] / l, n2[2] / l];
        rows.push((dir, dot3(dir, f)));
        let q = normal_eq(&rows)?;
        q.iter().all(|v| v.is_finite()).then_some(q)
    }
}

fn push_roof_slab_between(positions: &mut Vec<f64>, indices: &mut Vec<u32>, top: &[V3], bottom: &[V3], shared: &[bool]) {
    let mut nz = 0.0;
    for i in 0..top.len() {
        let a = top[i];
        let b = top[(i + 1) % top.len()];
        nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let ccw = nz > 0.0;
    push_fan_triangles(positions, indices, top, !ccw);
    push_fan_triangles(positions, indices, bottom, ccw);
    for i in 0..top.len() {
        if shared[i] {
            continue;
        }
        let j = (i + 1) % top.len();
        let base = (positions.len() / 3) as u32;
        positions.extend(top[i]);
        positions.extend(bottom[i]);
        positions.extend(bottom[j]);
        positions.extend(top[j]);
        if ccw {
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        } else {
            indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
        }
    }
}

/// Je Dachfläche ein geschlossenes Prisma der Schicht `d0`–`d1` unter der Oberkante (alle Seiten, auch
/// die gemeinsamen) — Eingabe der Körper-Booleans ([G5], `roof_assembly`).
pub(crate) fn roof_plane_prisms(planes: &[Vec<V3>], d0: f64, d1: f64) -> Vec<crate::solid_bool::Mesh> {
    let mitre = Mitre::new(planes);
    let mut out = Vec::new();
    for (i, plane) in planes.iter().enumerate() {
        if plane.len() < 3 {
            continue;
        }
        let (mut positions, mut indices) = (Vec::new(), Vec::new());
        push_roof_slab_between(&mut positions, &mut indices, &mitre.at(i, d0), &mitre.at(i, d1), &vec![false; plane.len()]);
        out.push(crate::solid_bool::Mesh { positions, indices });
    }
    out
}

/// Dachfenster-Loch in einer Dachfläche ([103]): Ecken auf der Dach-Oberkante (Gegenuhrzeigersinn um
/// `n`) und die Normale.
pub(crate) struct RoofHoleRect {
    pub corners: [V3; 4],
    pub n: V3,
}

fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Schneidet aus einer ebenen, konvexen Fläche die Rechtecke `holes` (senkrecht zur Fläche) aus:
/// konvexe Reststücke, gleicher Drehsinn wie `poly` (Sutherland-Hodgman je Rechteck-Kante).
pub(crate) fn clip_plane_holes(poly: &[V3], holes: &[RoofHoleRect]) -> Vec<Vec<V3>> {
    let Some(first) = holes.first() else { return vec![poly.to_vec()] };
    let n = first.n;
    let e1 = {
        let d = sub3(first.corners[1], first.corners[0]);
        let l = dot3(d, d).sqrt().max(1e-12);
        [d[0] / l, d[1] / l, d[2] / l]
    };
    let e2 = cross3(n, e1);
    let offs = poly.first().map_or(0.0, |q| dot3(*q, n));
    let to2 = |q: V3| [dot3(q, e1), dot3(q, e2)];
    let lift = |q: [f64; 2]| -> V3 { [e1[0] * q[0] + e2[0] * q[1] + n[0] * offs, e1[1] * q[0] + e2[1] * q[1] + n[1] * offs, e1[2] * q[0] + e2[2] * q[1] + n[2] * offs] };
    let clip = |pts: &[[f64; 2]], a: [f64; 2], b: [f64; 2], keep_left: bool| -> Vec<[f64; 2]> {
        let side = |p: [f64; 2]| {
            let c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
            if keep_left { c } else { -c }
        };
        let mut out = Vec::new();
        for i in 0..pts.len() {
            let (p, q) = (pts[i], pts[(i + 1) % pts.len()]);
            let (sp, sq) = (side(p), side(q));
            if sp >= 0.0 {
                out.push(p);
            }
            if (sp >= 0.0) != (sq >= 0.0) {
                let t = sp / (sp - sq);
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
        out
    };
    let area = |pts: &[[f64; 2]]| (0..pts.len()).map(|i| pts[i][0] * pts[(i + 1) % pts.len()][1] - pts[(i + 1) % pts.len()][0] * pts[i][1]).sum::<f64>().abs() / 2.0;
    let mut pieces: Vec<Vec<[f64; 2]>> = vec![poly.iter().map(|q| to2(*q)).collect()];
    for h in holes {
        let r: Vec<[f64; 2]> = h.corners.iter().map(|q| to2(*q)).collect();
        let mut next = Vec::new();
        for piece in pieces {
            let mut rest = piece;
            for k in 0..4 {
                let (a, b) = (r[k], r[(k + 1) % 4]);
                let outside = clip(&rest, a, b, false);
                if outside.len() >= 3 && area(&outside) > 1e-10 {
                    next.push(outside);
                }
                rest = clip(&rest, a, b, true);
                if rest.len() < 3 {
                    break;
                }
            }
        }
        pieces = next;
    }
    pieces.into_iter().map(|pc| pc.into_iter().map(lift).collect()).collect()
}

/// Wie [`push_roof_slab_between`], mit Dachfenster-Löchern: Deck-/Bodenfläche als Reststücke, dazu je
/// Loch vier Leibungen von `d0` bis `d1` unter der Dach-Oberkante.
fn push_roof_slab_with_holes(positions: &mut Vec<f64>, indices: &mut Vec<u32>, top: &[V3], bottom: &[V3], shared: &[bool], holes: &[RoofHoleRect], d0: f64, d1: f64) {
    let mut nz = 0.0;
    for i in 0..top.len() {
        let a = top[i];
        let b = top[(i + 1) % top.len()];
        nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let ccw = nz > 0.0;
    for pc in clip_plane_holes(top, holes) {
        push_fan_triangles(positions, indices, &pc, !ccw);
    }
    for pc in clip_plane_holes(bottom, holes) {
        push_fan_triangles(positions, indices, &pc, ccw);
    }
    for i in 0..top.len() {
        if shared[i] {
            continue;
        }
        let j = (i + 1) % top.len();
        let base = (positions.len() / 3) as u32;
        positions.extend(top[i]);
        positions.extend(bottom[i]);
        positions.extend(bottom[j]);
        positions.extend(top[j]);
        if ccw {
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        } else {
            indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
        }
    }
    for h in holes {
        let at = |q: V3, d: f64| [q[0] - h.n[0] * d, q[1] - h.n[1] * d, q[2] - h.n[2] * d];
        let center = [0, 1, 2].map(|k| h.corners.iter().map(|c| c[k]).sum::<f64>() / 4.0);
        for k in 0..4 {
            // Laibung nur, soweit die Kante über DIESER Fläche liegt ([148]: ein Loch über mehreren
            // koplanaren Teilflächen eines Flach-/Pultdachs bekommt jede Laibung genau einmal).
            let Some((a, b)) = clip_segment_xy(h.corners[k], h.corners[(k + 1) % 4], top) else { continue };
            let quad = [at(a, d0), at(b, d0), at(b, d1), at(a, d1)];
            let nrm = cross3(sub3(quad[1], quad[0]), sub3(quad[3], quad[0]));
            let mid = [0, 1, 2].map(|c| (a[c] + b[c]) / 2.0);
            let inward = dot3(nrm, sub3(center, mid)) > 0.0;
            let base = (positions.len() / 3) as u32;
            for q in quad {
                positions.extend(q);
            }
            if inward {
                indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
            } else {
                indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
            }
        }
    }
}

/// Strecke a→b (auf der Dachebene) auf die konvexe Fläche `poly` beschnitten (Aufsicht); `None`, wenn
/// nichts (Länge > 1e-9) übrig bleibt.
fn clip_segment_xy(a: V3, b: V3, poly: &[V3]) -> Option<(V3, V3)> {
    let n = poly.len();
    let area: f64 = (0..n).map(|i| poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]).sum();
    let sign = if area < 0.0 { -1.0 } else { 1.0 };
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for i in 0..n {
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        // Abstand links der Kante p→q (innen bei CCW), linear in t.
        let side = |r: V3| sign * ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
        let (fa, fb) = (side(a), side(b));
        let tol = 1e-9 * (q[0] - p[0]).hypot(q[1] - p[1]).max(1.0);
        if fa < -tol && fb < -tol {
            return None;
        }
        if fa < -tol || fb < -tol {
            let t = fa / (fa - fb);
            if fa < fb {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
    if (t1 - t0) * len <= 1e-9 {
        return None;
    }
    let lerp = |t: f64| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    Some((if t0 <= 0.0 { a } else { lerp(t0) }, if t1 >= 1.0 { b } else { lerp(t1) }))
}

/// Ob sich zwei konvexe Polygone in der Aufsicht mit Fläche überdecken (Trennachsen).
fn convex_overlap_xy(a: &[V3], b: &[V3]) -> bool {
    let separated = |p: &[V3], q: &[V3]| {
        (0..p.len()).any(|i| {
            let (u, v) = (p[i], p[(i + 1) % p.len()]);
            let ax = [-(v[1] - u[1]), v[0] - u[0]];
            let proj = |r: &V3| ax[0] * r[0] + ax[1] * r[1];
            let (pmin, pmax) = p.iter().map(proj).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)));
            let (qmin, qmax) = q.iter().map(proj).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)));
            let tol = 1e-9 * ax[0].hypot(ax[1]).max(1.0);
            pmax <= qmin + tol || qmax <= pmin + tol
        })
    };
    a.len() >= 3 && b.len() >= 3 && !separated(a, b) && !separated(b, a)
}

/// Dachfenster-Löcher je Dachfläche eines Dachs (Index in `Project::roofs`). Ein Loch gehört zu seiner
/// Wirtsfläche und zu jeder koplanaren Nachbarfläche, die es überdeckt ([148]: Flach-/Pultdach als
/// konvexe Teilflächen einer Ebene).
pub(crate) fn roof_holes_by_plane(p: &Project, roof_index: usize, planes: &[Vec<V3>]) -> Vec<Vec<RoofHoleRect>> {
    let mut out: Vec<Vec<RoofHoleRect>> = (0..planes.len()).map(|_| Vec::new()).collect();
    for (o, f) in crate::opening_shape::roof_openings(p, roof_index) {
        let Some(host) = f.plane.filter(|&i| i < planes.len()) else { continue };
        let corners = crate::opening_shape::host_rect_plan(&f, o.width, o.height);
        let (hn, h0) = (plane_normal_up(&planes[host]), planes[host][0]);
        for (i, pl) in planes.iter().enumerate() {
            let coplanar = || {
                let n = plane_normal_up(pl);
                pl.len() >= 3 && dot3(n, hn) > 1.0 - 1e-9 && dot3(hn, sub3(pl[0], h0)).abs() < 1e-6
            };
            if i == host || (coplanar() && convex_overlap_xy(pl, &corners)) {
                out[i].push(RoofHoleRect { corners, n: f.n });
            }
        }
    }
    out
}

fn roof_color(p: &Project, override_color: Option<Rgb>, component_id: &str) -> Result<Rgb, String> {
    if let Some(c) = override_color {
        return Ok(c);
    }
    if component_id.is_empty() {
        return Ok(ROOF_RGB);
    }
    // Hängendes Bauteil (Datei/Import): Dach-Vorgabefarbe.
    Ok(p.component(component_id).map_or(ROOF_RGB, |c| hex_to_rgb(&c.color, ROOF_RGB)))
}

/// Dächer als geschlossene, geschichtete Dreiecks-Meshes (`emitRoofs`).
pub fn emit_roofs(p: &Project, only_roof: Option<&str>) -> Result<Vec<RMesh>, String> {
    let maps = material_color_maps(p, only_roof);
    let mut out = Vec::new();
    let nb = crate::roof_assembly::neighbors_rc(p);
    for (ri, roof) in p.roofs.as_deref().unwrap_or(&[]).iter().enumerate().filter(|(_, r)| only_roof.is_none_or(|id| r.id == id)) {
        let override_color = roof.color.as_deref().filter(|c| !c.is_empty()).map(|c| hex_to_rgb(c, ROOF_RGB));
        // Verschnittene Dächer und Gauben ([G5]): Körper aus `roof_assembly`.
        if let Some(solids) = crate::roof_assembly::roof_solids_with(p, ri, &nb) {
            for part in &solids.parts {
                let wall = part.role == crate::roof_assembly::Role::DormerWall;
                let color = if wall {
                    p.component(&part.component_id).map_or(WALL_RGB, |c| hex_to_rgb(&c.color, WALL_RGB))
                } else {
                    roof_color(p, override_color, &part.component_id)?
                };
                let material_index = if (wall || override_color.is_none()) && !part.component_id.is_empty() { material_layer(p, &maps, &part.component_id) } else { None };
                let (positions, indices) = crate::roof_assembly::unshared(&part.mesh);
                out.push(RMesh {
                    crease_angle: None, positions, indices, kind: "extrusion", color, vertex_colors: None, material_index });
            }
            continue;
        }
        let eaves_z = p.roof_base_elevation(roof);
        let g = crate::roof::roof_geometry(&roof.params(), eaves_z);
        let mitre = Mitre::new(&g.planes);
        let holes = roof_holes_by_plane(p, ri, &g.planes);
        let mut offset_above = 0.0;
        for layer in p.roof_layers(roof) {
            let t = layer.thickness.max(0.0);
            if t <= EPS {
                continue;
            }
            let color = roof_color(p, override_color, &layer.component_id)?;
            let material_index = if override_color.is_none() && !layer.component_id.is_empty() { material_layer(p, &maps, &layer.component_id) } else { None };
            let (mut positions, mut indices) = (Vec::new(), Vec::new());
            for (i, plane) in g.planes.iter().enumerate() {
                if plane.len() < 3 {
                    continue;
                }
                let top = mitre.at(i, offset_above);
                let bottom = mitre.at(i, offset_above + t);
                if holes[i].is_empty() {
                    push_roof_slab_between(&mut positions, &mut indices, &top, &bottom, &mitre.shared[i]);
                } else {
                    push_roof_slab_with_holes(&mut positions, &mut indices, &top, &bottom, &mitre.shared[i], &holes[i], offset_above, offset_above + t);
                }
            }
            if !indices.is_empty() {
                out.push(RMesh {
                    crease_angle: None, positions, indices, kind: "extrusion", color, vertex_colors: None, material_index });
            }
            offset_above += t;
        }
    }
    Ok(out)
}

/// Dachschicht-Eingabe für den 3D-Live-Schnitt (`emitRoofCutLayers`).
pub fn emit_roof_cut_layers(p: &Project) -> Result<Vec<RRoofLayer>, String> {
    let mut out = Vec::new();
    for (ri, roof) in p.roofs.as_deref().unwrap_or(&[]).iter().enumerate() {
        let eaves_z = p.roof_base_elevation(roof);
        let g = crate::roof::roof_geometry(&roof.params(), eaves_z);
        let override_color = roof.color.as_deref().filter(|c| !c.is_empty()).map(|c| hex_to_rgb(c, ROOF_RGB));
        let holes = roof_holes_by_plane(p, ri, &g.planes);
        let mut offset_above = 0.0;
        for layer in p.roof_layers(roof) {
            let t = layer.thickness.max(0.0);
            if t <= EPS {
                continue;
            }
            let color = roof_color(p, override_color, &layer.component_id)?;
            let line = resolve_cut_line_style(p, &layer);
            let cut = (line.0.is_some() || line.1.is_some()).then(|| RCutMeta { line_color: line.0, line_weight: line.1, ..Default::default() });
            for (i, plane) in g.planes.iter().enumerate() {
                let nrm = plane_normal_up(plane);
                let polygon: Vec<V3> = plane.iter().map(|q| [q[0] - nrm[0] * offset_above, q[1] - nrm[1] * offset_above, q[2] - nrm[2] * offset_above]).collect();
                // Dachfenster ([103]): Reststücke statt der ganzen Fläche (Loch im Live-Schnitt).
                for polygon in clip_plane_holes(&polygon, &holes[i]) {
                    out.push(RRoofLayer { polygon, normal: nrm, thickness: t, color, cut: cut.clone() });
                }
            }
            offset_above += t;
        }
    }
    Ok(out)
}

// ── Kontext und Bündel ──────────────────────────────────────────────────────

const TERRAIN_RGB: Rgb = [169.0 / 255.0, 176.0 / 255.0, 162.0 / 255.0];
const IMPORTED_RGB: Rgb = [159.0 / 255.0, 166.0 / 255.0, 174.0 / 255.0];

fn indices_u32(v: &[f64]) -> Vec<u32> {
    v.iter().map(|&i| i as u32).collect()
}

/// Codes ausgeblendeter Kategorien samt Kindern einer ausgeblendeten Elternebene.
fn hidden_category_codes(cats: &[crate::model::LayerCategory]) -> std::collections::HashSet<&str> {
    fn walk<'a>(list: &'a [crate::model::LayerCategory], parent_hidden: bool, out: &mut std::collections::HashSet<&'a str>) {
        for c in list {
            let hidden = parent_hidden || !c.visible;
            if hidden {
                out.insert(c.code.as_str());
            }
            walk(c.children.as_deref().unwrap_or(&[]), hidden, out);
        }
    }
    let mut out = std::collections::HashSet::new();
    walk(cats, false, &mut out);
    out
}

/// Rohe Kontext-Meshes: Gelände-TIN und importierte Volumen (`emitMeshes`).
pub fn emit_context_meshes(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    // [T6]/[114] Ebenen-Sichtbarkeit: ein ausgeblendetes Gelände (Kategorie „02") verschwindet auch im 3D.
    let hidden = hidden_category_codes(&p.layers);
    for obj in p.context.as_deref().unwrap_or(&[]) {
        let code = match obj {
            ContextObject::TerrainMesh(m) => m.category_code.as_deref(),
            ContextObject::ImportedMesh(m) => m.category_code.as_deref(),
            _ => None,
        };
        if code.is_some_and(|c| hidden.contains(c)) {
            continue;
        }
        match obj {
            // [137] Einzeln ausgeblendetes Gelände.
            ContextObject::TerrainMesh(m) if m.hidden == Some(true) => {}
            ContextObject::ImportedMesh(m) if m.hidden == Some(true) => {}
            ContextObject::TerrainMesh(m) if m.positions.len() >= 9 && m.indices.len() >= 3 => {
                // [T6] Baugruben schneiden das Gelände; Höhen im Modellbezug (Luftbild-Farben auf das geänderte Netz übertragen).
                let (pos, idx, _) = crate::excavation::terrain_model_mesh(p, m);
                out.push(RMesh {
                    crease_angle: None,
                    positions: pos.into_owned(),
                    indices: indices_u32(&idx),
                    kind: "terrain",
                    color: TERRAIN_RGB,
                    vertex_colors: crate::excavation::terrain_vertex_colors(p, m),
                    material_index: None,
                })
            }
            ContextObject::ImportedMesh(m) if m.positions.len() >= 9 && m.indices.len() >= 3 => out.push(RMesh {
                positions: m.positions.clone(),
                indices: indices_u32(&m.indices),
                kind: "imported",
                color: IMPORTED_RGB,
                vertex_colors: None,
                material_index: None,
                crease_angle: (m.smooth_shading == Some(true)).then(|| m.crease_angle.filter(|a| a.is_finite() && *a > 0.0).unwrap_or(DEFAULT_CREASE_DEG).min(180.0)),
            }),
            _ => {}
        }
    }
    out
}

/// Das 3D-Modell in Teilen: TS fügt die truck-Körper (asynchron) zwischen Kontext und Stützen ein.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Parts {
    pub walls: Vec<RWall>,
    pub slabs: Vec<RSlab>,
    pub context_meshes: Vec<RMesh>,
    pub column_meshes: Vec<RMesh>,
    pub opening_meshes: Vec<RMesh>,
    pub stair_meshes: Vec<RMesh>,
    pub stair_railings: Vec<RMesh>,
    pub roof_meshes: Vec<RMesh>,
    pub roof_layers: Vec<RRoofLayer>,
}

/// `detail`: 0 grob, 1 mittel, 2 fein.
pub fn parts(p: &Project, layered: bool, detail: f64, for_section: bool) -> Result<Parts, String> {
    let mut slabs = emit_slabs(p);
    slabs.extend(emit_stairs(p, for_section));
    Ok(Parts {
        walls: emit_walls(p, layered)?,
        slabs,
        context_meshes: emit_context_meshes(p),
        column_meshes: { let mut m = emit_columns(p); m.extend(emit_trees(p)); m },
        opening_meshes: emit_opening_meshes(p, detail),
        stair_meshes: emit_stair_meshes(p),
        stair_railings: emit_stair_railings(p),
        roof_meshes: emit_roofs(p, None)?,
        roof_layers: emit_roof_cut_layers(p)?,
    })
}

// ── 2D-Zeichnungen im 3D (Boden-Spuren) ─────────────────────────────────────

/// Doppelte je Charge an `drawing2d_3d` — begrenzt den Speicher bei Kataster-Importen.
const CHUNK_DOUBLES: usize = 1 << 18;
const DRAWING_LINE_ELEVATION_EPS: f64 = 0.01;
const DRAWING_PICK_TOLERANCE: f64 = 0.12;

/// Linienfarbe einer Zeichnung: color → Linienstil → Kategorie (`drawingColor3d`).
fn drawing_color(
    d: &Drawing2D,
    by_category: &HashMap<&str, &str>,
    by_line_style: &HashMap<&str, &str>,
) -> Rgb {
    let fb = style::DRAWING_LINE_FALLBACK_RGB;
    if let Some(c) = d.color.as_deref().filter(|c| !c.is_empty()) {
        return hex_to_rgb(c, fb);
    }
    if let Some(c) = d.line_style_id.as_deref().and_then(|id| by_line_style.get(id)) {
        return hex_to_rgb(c, fb);
    }
    by_category.get(d.category_code.as_str()).map_or(fb, |c| hex_to_rgb(c, fb))
}

/// Packt die darstellbaren Zeichnungen (Linie, Polylinie, Rechteck) in Chargen für `drawing2d_3d`.
/// `lift`: zusätzliche Höhe je Geschoss-id (Explosionsaxonometrie [65], `explode3d.rs`; leer = keine).
fn for_each_drawing_chunk(p: &Project, with_color: bool, lift: &HashMap<String, f64>, mut f: impl FnMut(&[f64], &[&Drawing2D])) {
    if p.drawings2d.is_empty() {
        return;
    }
    let cats = p.flat_categories();
    let by_category: HashMap<&str, &str> = cats.iter().filter(|c| !c.color.is_empty()).map(|c| (c.code.as_str(), c.color.as_str())).collect();
    let by_line_style: HashMap<&str, &str> = p.line_styles.iter().filter(|l| !l.color.is_empty()).map(|l| (l.id.as_str(), l.color.as_str())).collect();
    let mut elevations: HashMap<&str, f64> = HashMap::new();
    let mut buf: Vec<f64> = vec![0.0];
    let mut ids: Vec<&Drawing2D> = Vec::new();
    let flush = |buf: &mut Vec<f64>, ids: &mut Vec<&Drawing2D>, f: &mut dyn FnMut(&[f64], &[&Drawing2D])| {
        if ids.is_empty() {
            return;
        }
        buf[0] = ids.len() as f64;
        f(buf, ids);
        ids.clear();
        buf.truncate(1);
    };
    for d in &p.drawings2d {
        // Teile einer Zeichnung: (Art, Punkte); ein Achsraster mit `show3d` liefert je Achse eines.
        let parts: Vec<(f64, Vec<Vec2>)> = match &d.geom {
            Drawing2DGeom::Line { a, b } => vec![(1.0, vec![*a, *b])],
            Drawing2DGeom::Rect { min, max } => vec![(3.0, vec![*min, *max])],
            Drawing2DGeom::Polyline { pts, .. } => vec![(2.0, pts.clone())],
            Drawing2DGeom::Grid { show_3d: Some(true), .. } => crate::grid::Spec::of(&d.geom).map(|s| crate::grid::polylines_3d(&s)).unwrap_or_default().into_iter().map(|q| (2.0, q.into_iter().map(|(x, y)| Vec2 { x, y }).collect())).collect(),
            _ => continue,
        };
        let closed = matches!(&d.geom, Drawing2DGeom::Polyline { closed: true, .. });
        let elev = *elevations.entry(d.level_id.as_str()).or_insert_with(|| p.floor(&d.level_id).map_or(0.0, |l| l.base_elevation.unwrap_or(0.0)) + DRAWING_LINE_ELEVATION_EPS + lift.get(d.level_id.as_str()).copied().unwrap_or(0.0));
        let rgb = if with_color { drawing_color(d, &by_category, &by_line_style) } else { [0.0; 3] };
        for (kind, pts) in parts {
            let need = 7 + 2 * pts.len();
            if buf.len() + need > CHUNK_DOUBLES {
                flush(&mut buf, &mut ids, &mut f);
            }
            buf.extend([kind, elev, rgb[0], rgb[1], rgb[2], if closed { 1.0 } else { 0.0 }, pts.len() as f64]);
            for q in &pts {
                buf.extend([q.x, q.y]);
            }
            ids.push(d);
        }
    }
    flush(&mut buf, &mut ids, &mut f);
}

/// Boden-Spuren aller Zeichnungen als LineList-Vertices `[px, py, pz, r, g, b]` (`emitDrawingLineVerts`).
pub fn drawing_line_verts(p: &Project) -> Vec<f32> {
    drawing_line_verts_lifted(p, &HashMap::new())
}

/// Wie [`drawing_line_verts`], jede Spur um `lift[level_id]` angehoben (Explosion [65]).
pub fn drawing_line_verts_lifted(p: &Project, lift: &HashMap<String, f64>) -> Vec<f32> {
    let mut out = Vec::new();
    for_each_drawing_chunk(p, true, lift, |buf, _| out.extend(crate::drawing2d_3d::line_verts(buf)));
    out
}

/// Pick-Strecke einer Zeichnung (`PickDrawingSeg`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickDrawingSeg {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub base_elevation: f64,
    pub drawing_id: String,
}

pub(crate) fn pick_drawing_segs(p: &Project, lift: &HashMap<String, f64>) -> Vec<PickDrawingSeg> {
    let mut out = Vec::new();
    for_each_drawing_chunk(p, false, lift, |buf, drawings| {
        let f = crate::drawing2d_3d::pick_segs(buf, DRAWING_PICK_TOLERANCE);
        for c in f.chunks_exact(6) {
            out.push(PickDrawingSeg { start: [c[0], c[1]], end: [c[2], c[3]], base_elevation: c[4], drawing_id: drawings[c[5] as usize].id.clone() });
        }
    });
    out
}

// ── Pick-Geometrie ──────────────────────────────────────────────────────────

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

type Tri = [V3; 3];

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
    /// [137] Freie Körper (Prisma-Näherung; TS ersetzt sie durch das truck-Netz).
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
        let o_top = zt.min(o_bottom + o.height);
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
    // [137] Was im 3D nicht gezeichnet wird (Kategorie aus, Gelände einzeln aus), fängt auch keinen Klick.
    let hidden = hidden_category_codes(&p.layers);
    for obj in p.context.as_deref().unwrap_or(&[]) {
        let code = match obj {
            ContextObject::TerrainMesh(m) => m.category_code.as_deref(),
            ContextObject::ImportedMesh(m) => m.category_code.as_deref(),
            _ => None,
        };
        if code.is_some_and(|c| hidden.contains(c)) || matches!(obj, ContextObject::TerrainMesh(m) if m.hidden == Some(true)) || matches!(obj, ContextObject::ImportedMesh(m) if m.hidden == Some(true)) {
            continue;
        }
        let (pos, idx, id) = match obj {
            ContextObject::TerrainMesh(m) => {
                let (pos, idx, _) = crate::excavation::terrain_model_mesh(p, m);
                (pos, idx, &m.id)
            }
            ContextObject::ImportedMesh(m) => (std::borrow::Cow::Borrowed(m.positions.as_slice()), std::borrow::Cow::Borrowed(m.indices.as_slice()), &m.id),
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
    let Some((stairs, buf)) = stair_input(p, |s, st| s.shape != StairShape::Unknown && st.and_then(|t| t.railing).is_some_and(|r| r != StairTypeRailing::Keine)) else { return vec![] };
    let mut out: Vec<PickStairMesh> = Vec::new();
    for m in crate::stairs3d::railings(&buf) {
        let Some(&(_, stair)) = stairs.get(m.src) else { continue };
        let tris = extrusion_tris(&m.positions, &m.indices);
        match out.iter_mut().find(|o| o.stair_id == stair.id) {
            Some(o) => o.tris.extend(tris),
            None => out.push(PickStairMesh { tris, stair_id: stair.id.clone() }),
        }
    }
    out.retain(|o| !o.tris.is_empty());
    out
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

/// [137] Freie Körper (`extrudedSolids`, ohne Abzugskörper) als Prisma über dem Grundriss-Umriss: UK =
/// Geschoss-UK + `baseOffset`, OK = UK + `height`. Näherung für Loft/Rotation/Abzug/Verjüngung — die Hülle
/// (`pickGeometry` in `plan/toWalls3d.ts`) ersetzt die Dreiecke durch das truck-Netz, sobald es geladen ist.
pub fn pick_solids(p: &Project) -> Vec<PickSolid> {
    let mut out = Vec::new();
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") || !(s.height > 0.0) || s.points.len() < 3 {
            continue;
        }
        let z0 = solid_base_z(p, s);
        let foot: Vec<[f64; 2]> = s.points.iter().map(|q| [q.x, q.y]).collect();
        if !(z0.is_finite() && foot.iter().all(|q| q[0].is_finite() && q[1].is_finite())) {
            continue;
        }
        let (pos, idx) = crate::columns3d::prism(&foot, z0, z0 + s.height);
        let tris = extrusion_tris(&pos, &idx);
        if !tris.is_empty() {
            out.push(PickSolid { tris, solid_id: s.id.clone() });
        }
    }
    out
}

/// UK eines freien Körpers (Geschoss-UK + `baseOffset`), wie `emitExtrudedSolids`.
pub fn solid_base_z(p: &Project, s: &ExtrudedSolid) -> f64 {
    p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + s.base_offset.unwrap_or(0.0)
}

/// Modell-Netz (x, y, z = Höhe) eines plan-abgeleiteten Körpers (render3d `MeshKind::Extrusion`) als
/// Welt-Dreiecke (x, Höhe, y) — ohne Vorzeichenwechsel, anders als Gelände/Import (x, Höhe, −y).
fn extrusion_tris(pos: &[f64], idx: &[u32]) -> Vec<Tri> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// [149] Bäume im 3D (Stamm + Krone bei den Stützen-Meshes), im Pick und mit Fuss auf dem Gelände.
    #[test]
    fn baeume_im_3d_und_pick() {
        let mut p = sample();
        let n0 = parts(&p, true, 1.0, false).unwrap().column_meshes.len();
        p.trees = Some(vec![Tree { id: "T1".into(), r#type: "tree".into(), floor_id: "eg".into(), category_code: "13".into(), position: Vec2 { x: 20.0, y: 5.0 }, trunk_diameter: 0.4, crown_diameter: 6.0, crown_base: 3.0, height: 12.0, species: Some("Quercus robur".into()), ..Default::default() }, Tree { id: "T2".into(), shape: TreeShape::Conical, foliage: TreeFoliage::Conifer, base_offset: Some(0.5), ..Tree { id: "T1".into(), r#type: "tree".into(), floor_id: "eg".into(), category_code: "13".into(), position: Vec2 { x: 20.0, y: 5.0 }, trunk_diameter: 0.4, crown_diameter: 6.0, crown_base: 3.0, height: 12.0, species: Some("Quercus robur".into()), ..Default::default() } }]);
        let m = parts(&p, true, 1.0, false).unwrap().column_meshes;
        assert_eq!(m.len(), n0 + 4);
        let crown = &m[n0 + 1];
        assert_eq!(crown.color, crate::tree::CROWN_RGB);
        assert_eq!(m[n0 + 3].color, crate::tree::CONIFER_RGB);
        let zmax = crown.positions.chunks_exact(3).map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
        let base = p.floor("eg").map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        assert!((zmax - (base + 12.0)).abs() < 1e-9, "{zmax}");
        let z2 = m[n0 + 2].positions.chunks_exact(3).map(|q| q[2]).fold(f64::INFINITY, f64::min);
        assert!((z2 - (base + 0.5)).abs() < 1e-9, "Fuss mit Versatz: {z2}");
        // Wenige Dreiecke je Baum.
        assert!(m[n0..].iter().map(|x| x.indices.len() / 3).sum::<usize>() < 2 * 250);
        let g = pick_geometry(&p).unwrap();
        assert_eq!(g.trees.len(), 2);
        assert_eq!(g.trees[0].tree_id, "T1");
        // Welt-Dreiecke (x, Höhe, y): Höhe bis zur Spitze.
        let h = g.trees[0].tris.iter().flatten().map(|v| v[1]).fold(f64::NEG_INFINITY, f64::max);
        assert!((h - (base + 12.0)).abs() < 1e-9);
    }

    /// [112] Achsraster mit `show3d` erscheint als Boden-Spur (eine Strecke je Achse), ohne Flag nicht.
    #[test]
    fn achsraster_im_3d_nur_mit_flag() {
        let mk = |show: serde_json::Value| -> Project {
            serde_json::from_value(serde_json::json!({
                "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
                "drawingLevels": [{"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 1.0}],
                "drawings2d": [{"id": "G", "type": "drawing2d", "levelId": "F", "categoryCode": "20", "geom": {"shape": "grid", "origin": {"x": 0, "y": 0}, "angle": 0,
                    "a": [{"label": "1", "pos": 0}, {"label": "2", "pos": 4}], "b": [{"label": "A", "pos": 0}], "show3d": show}}]
            }))
            .unwrap()
        };
        assert!(drawing_line_verts(&mk(serde_json::json!(false))).is_empty());
        let v = drawing_line_verts(&mk(serde_json::json!(true)));
        // 3 Achsen × 1 Segment × 2 Endpunkte × 6 Zahlen.
        assert_eq!(v.len(), 3 * 2 * 6);
        assert!((v[1] - 1.01).abs() < 1e-4, "Höhe = Geschoss-UK + 0.01: {}", v[1]);
    }

    /// Walmdach 12×7 m: zwei Trapeze + zwei Walm-Dreiecke, First (3,3)-(8,3).
    fn walm_planes() -> Vec<Vec<V3>> {
        vec![
            vec![[-0.5, -0.5, 5.2], [11.5, -0.5, 5.2], [8.0, 3.0, 7.061], [3.0, 3.0, 7.061]],
            vec![[-0.5, 6.5, 5.2], [11.5, 6.5, 5.2], [8.0, 3.0, 7.061], [3.0, 3.0, 7.061]],
            vec![[-0.5, -0.5, 5.2], [-0.5, 6.5, 5.2], [3.0, 3.0, 7.061]],
            vec![[11.5, -0.5, 5.2], [11.5, 6.5, 5.2], [8.0, 3.0, 7.061]],
        ]
    }

    fn near(a: V3, b: V3) -> bool {
        hypot(&[a[0] - b[0], a[1] - b[1], a[2] - b[2]]) < 1e-6
    }

    /// [T6]/[114] Gelände in ausgeblendeter Kategorie kommt nicht ins 3D.
    #[test]
    fn gelaende_ausgeblendet_nicht_im_3d() {
        let t = crate::model::TerrainMesh { id: "t".into(), category_code: Some("02".into()), positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], indices: vec![0.0, 1.0, 2.0], ..Default::default() };
        let cat = |visible| crate::model::LayerCategory { code: "02".into(), name: "Gelände".into(), visible, ..Default::default() };
        let mk = |visible| Project { context: Some(vec![ContextObject::TerrainMesh(t.clone())]), layers: vec![cat(visible)], ..Default::default() };
        assert_eq!(emit_context_meshes(&mk(true)).len(), 1);
        assert!(emit_context_meshes(&mk(false)).is_empty());
        // Elternebene „05 Kontext" aus blendet das Kind „02" mit aus.
        let parent = |visible| crate::model::LayerCategory { code: "05".into(), name: "Kontext".into(), visible, children: Some(vec![cat(true)]), ..Default::default() };
        let pp = |visible| Project { layers: vec![parent(visible)], ..mk(true) };
        assert_eq!(emit_context_meshes(&pp(true)).len(), 1);
        assert!(emit_context_meshes(&pp(false)).is_empty());
    }

    /// [137] 3D-Picken: Dreiecke der Baugrube (Sohle, Böschung) tragen die Id der Baugrube, das übrige
    /// Gelände die des Netzes.
    #[test]
    fn pick_gelaende_und_baugrube_im_3d() {
        let t = crate::model::TerrainMesh {
            id: "t".into(),
            positions: vec![0.0, 0.0, 0.0, 60.0, 0.0, 6.0, 60.0, 40.0, 6.0, 0.0, 40.0, 0.0],
            indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
            ..Default::default()
        };
        let v = |x: f64, y: f64| crate::model::Vec2 { x, y };
        let pit = crate::model::Excavation { id: "bg".into(), outline: vec![v(20.0, 15.0), v(30.0, 15.0), v(30.0, 25.0), v(20.0, 25.0)], bottom: 1.0, ..Default::default() };
        let p = Project { context: Some(vec![ContextObject::Excavation(pit), ContextObject::TerrainMesh(t)]), ..Default::default() };
        let g = pick_geometry(&p).unwrap();
        let of = |id: &str| g.context_meshes.iter().find(|m| m.context_object_id == id).map(|m| m.tris.clone()).unwrap_or_default();
        let (bg, terr) = (of("bg"), of("t"));
        assert!(!bg.is_empty() && !terr.is_empty(), "{} {}", bg.len(), terr.len());
        // Welt (x, z, −y): alle Baugruben-Dreiecke liegen im Wirkbereich (x 18…32, y 13…27), Sohle auf 1 m dabei.
        for tri in &bg {
            let (cx, cy) = ((tri[0][0] + tri[1][0] + tri[2][0]) / 3.0, -(tri[0][2] + tri[1][2] + tri[2][2]) / 3.0);
            assert!((17.0..=33.0).contains(&cx) && (12.0..=28.0).contains(&cy), "{cx} {cy}");
        }
        assert!(bg.iter().any(|tri| tri.iter().all(|q| (q[1] - 1.0).abs() < 1e-6)));
    }

    /// [137] Stützen sind im 3D anwählbar: ihr Prisma kommt mit Id in die Pick-Geometrie (Welt: x, Höhe, y —
    /// wie render3d `Extrusion`; vorher −y, d. h. gespiegelt zur Darstellung).
    #[test]
    fn pick_stuetzen_im_3d() {
        let p: Project = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
            "drawingLevels": [{"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0.0}],
            "columns": [{"id": "k1", "type": "column", "floorId": "EG", "categoryCode": "25", "position": {"x": 2, "y": 3}, "profile": {"kind": "rect", "width": 0.3, "depth": 0.3}, "rotation": 0, "height": 2.5}],
            "drawings2d": []
        }))
        .unwrap();
        let g = pick_geometry(&p).unwrap();
        assert_eq!(g.columns.len(), 1);
        assert_eq!(g.columns[0].column_id, "k1");
        let v: Vec<&V3> = g.columns[0].tris.iter().flatten().collect();
        assert!(v.iter().all(|q| (q[0] - 2.0).abs() <= 0.15 + 1e-9 && (q[2] - 3.0).abs() <= 0.15 + 1e-9 && q[1] >= -1e-9 && q[1] <= 2.5 + 1e-9));
        assert!(v.iter().any(|q| (q[1] - 2.5).abs() < 1e-9));
    }

    fn solid_project() -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
            "drawingLevels": [
                {"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0.0},
                {"id": "OG", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 3.0}],
            "extrudedSolids": [
                {"id": "s1", "type": "extrudedSolid", "levelId": "OG", "points": [{"x": 1, "y": 2}, {"x": 3, "y": 2}, {"x": 3, "y": 5}, {"x": 1, "y": 5}], "height": 1.5, "baseOffset": 0.5},
                {"id": "v1", "type": "extrudedSolid", "levelId": "EG", "points": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "height": 1.0, "operation": "subtract"}],
            "drawings2d": []
        }))
        .unwrap()
    }

    /// [137] Freie Körper sind im 3D anwählbar: Prisma über dem Umriss (Welt x, Höhe, y), UK = Geschoss + Versatz;
    /// Abzugskörper (nur Umriss) nicht. Mit Explosion wandern sie mit ihrem Geschoss.
    #[test]
    fn pick_freie_koerper_im_3d() {
        let p = solid_project();
        let g = pick_geometry(&p).unwrap();
        assert_eq!(g.solids.len(), 1);
        assert_eq!(g.solids[0].solid_id, "s1");
        let v: Vec<&V3> = g.solids[0].tris.iter().flatten().collect();
        assert!(v.iter().all(|q| (1.0 - 1e-9..=3.0 + 1e-9).contains(&q[0]) && (2.0 - 1e-9..=5.0 + 1e-9).contains(&q[2]) && (3.5 - 1e-9..=5.0 + 1e-9).contains(&q[1])));
        assert!(v.iter().any(|q| (q[1] - 5.0).abs() < 1e-9) && v.iter().any(|q| (q[1] - 3.5).abs() < 1e-9));
        let e = crate::explode3d::pick_geometry(&p, 2.0).unwrap();
        let top = e.solids[0].tris.iter().flatten().map(|q| q[1]).fold(f64::NEG_INFINITY, f64::max);
        assert!((top - 7.0).abs() < 1e-9, "{top}");
    }

    /// [137] Dachfenster sind im 3D anwählbar (Netz mit Id); das Dach hat dort ein Loch statt der vollen Fläche.
    #[test]
    fn pick_dachfenster_im_3d() {
        let mut p = sample();
        p.openings.as_mut().unwrap().push(Opening {
            id: "DF".into(),
            kind: ElementKind::Window,
            width: 0.78,
            height: 1.18,
            host_roof_id: Some("RF1".into()),
            host_point: Some(Vec2 { x: 2.5, y: 1.0 }),
            ..Default::default()
        });
        let g = pick_geometry(&p).unwrap();
        let df = g.opening_meshes.iter().find(|m| m.opening_id == "DF").expect("Dachfenster in der Pick-Geometrie");
        assert!(df.tris.len() > 12);
        // Welt (x, Höhe, y): um den Wirtpunkt (2.5, 1.0).
        let (cx, cz) = df.tris.iter().flatten().fold((0.0, 0.0), |a, q| (a.0 + q[0], a.1 + q[2]));
        let n = (df.tris.len() * 3) as f64;
        assert!((cx / n - 2.5).abs() < 1.0 && (cz / n - 1.0).abs() < 1.5, "{} {}", cx / n, cz / n);
        assert!(g.roofs.iter().any(|r| r.roof_id == "RF1" && !r.tris.is_empty()));
    }

    /// [137] Einzeln ausgeblendetes Gelände (`hidden`) und Gelände einer ausgeblendeten Kategorie fehlen im 3D
    /// und in der Pick-Geometrie; ein zweites Netz bleibt.
    #[test]
    fn gelaende_einzeln_ausblenden() {
        let mk = |id: &str, hidden: Option<bool>, code: Option<&str>| {
            ContextObject::TerrainMesh(TerrainMesh {
                id: id.into(),
                positions: vec![0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 10.0, 1.0],
                indices: vec![0.0, 1.0, 2.0],
                hidden,
                category_code: code.map(Into::into),
                ..Default::default()
            })
        };
        let mut p = Project { context: Some(vec![mk("a", Some(true), None), mk("b", None, None), mk("c", Some(false), Some("02"))]), ..Default::default() };
        let ids = |p: &Project| pick_geometry(p).unwrap().context_meshes.iter().map(|m| m.context_object_id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&p), vec!["b", "c"]);
        assert_eq!(emit_context_meshes(&p).len(), 2);
        p.layers = serde_json::from_value(serde_json::json!([{"code": "02", "name": "Gelände", "color": "#000000", "visible": false}])).unwrap();
        assert_eq!(ids(&p), vec!["b"]);
        assert_eq!(emit_context_meshes(&p).len(), 1);
    }

    /// [T4] Import-Mesh glatt: Knickwinkel geht ans 3D (Vorgabe 30°), kantig ohne; JSON `creaseAngle`.
    #[test]
    fn import_mesh_glatt_mit_knickwinkel() {
        let mesh = |smooth: Option<bool>, crease: Option<f64>| {
            let m = ImportedMesh { id: "m".into(), positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], indices: vec![0.0, 1.0, 2.0], smooth_shading: smooth, crease_angle: crease, ..Default::default() };
            let p = Project { context: Some(vec![ContextObject::ImportedMesh(m)]), ..Default::default() };
            emit_context_meshes(&p).remove(0)
        };
        assert_eq!(mesh(None, Some(45.0)).crease_angle, None);
        assert_eq!(mesh(Some(true), None).crease_angle, Some(DEFAULT_CREASE_DEG));
        assert_eq!(mesh(Some(true), Some(12.5)).crease_angle, Some(12.5));
        assert_eq!(mesh(Some(true), Some(f64::NAN)).crease_angle, Some(DEFAULT_CREASE_DEG));
        let js = serde_json::to_value(mesh(Some(true), Some(12.5))).unwrap();
        assert_eq!(js["creaseAngle"], serde_json::json!(12.5));
        assert!(serde_json::to_value(mesh(None, None)).unwrap().get("creaseAngle").is_none());
    }

    #[test]
    fn gehrung_erkennt_first_und_grate_als_geteilt() {
        let planes = walm_planes();
        let m = Mitre::new(&planes);
        assert_eq!(m.shared[0], vec![false, true, true, true]); // Traufe, Grat, First, Grat
        assert_eq!(m.shared[2], vec![false, true, true]);
    }

    #[test]
    fn unterseiten_treffen_sich_am_first_apex() {
        let planes = walm_planes();
        let m = Mitre::new(&planes);
        let d = 0.27;
        let (a, b, c) = (m.at(0, d)[3], m.at(1, d)[3], m.at(2, d)[2]);
        assert!(near(a, b) && near(a, c));
        assert!(a[2] < 7.061);
        assert_eq!(m.at(0, 0.0), planes[0]);
        assert!(m.at(0, 0.2)[0][2] < 5.2);
    }

    fn sample() -> Project {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    /// [G3] Rundbogen: Füllkörper in Wandfarbe zwischen Rechteck-Loch und Bogen, Rahmen und Glas entlang
    /// des Umrisses; alle Quader innerhalb des Öffnungs-Rechtecks.
    #[test]
    fn formoeffnung_fuellkoerper_rahmen_glas() {
        let mut p = sample();
        let plain = emit_opening_meshes(&p, 2.0).len();
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.shape = Some(OpeningShape::Rundbogen);
        }
        let meshes = emit_opening_meshes(&p, 2.0);
        assert_ne!(meshes.len(), plain);
        let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap();
        let wall_rgb = resolve_wall_bands(&p, &wall_material_color_maps(&p), w1, false).0[0].color;
        let fills: Vec<&RMesh> = meshes.iter().filter(|m| m.color == wall_rgb).collect();
        assert!(fills.len() >= 10, "Bogenzwickel als Streifen: {}", fills.len());
        let (zb, _) = p.wall_vertical_extent(w1);
        // O1: x 3…4 an der Wand y = 0, Brüstung 0,9, Höhe 1,2: Füllung nur über dem Kämpfer (0,7).
        for m in &fills {
            for c in m.positions.chunks_exact(3) {
                assert!(c[0] > 3.0 - 1e-9 && c[0] < 4.0 + 1e-9 && c[2] >= zb + 0.9 + 0.7 - 1e-9 && c[2] <= zb + 2.1 + 1e-9, "{c:?}");
            }
        }
        assert!(meshes.iter().any(|m| m.color == PART_RGB[0]) && meshes.iter().any(|m| m.color == PART_RGB[1]));
    }

    /// [103] Dachfenster: jede Dachschicht bleibt ein geschlossener Körper mit Loch; Fensterteile kommen dazu.
    #[test]
    fn dachfenster_schneidet_alle_schichten() {
        let mut p = sample();
        let before = emit_roofs(&p, None).unwrap();
        p.openings.as_mut().unwrap().push(Opening {
            id: "DF".into(),
            kind: ElementKind::Window,
            width: 0.78,
            height: 1.18,
            host_roof_id: Some("RF1".into()),
            host_point: Some(Vec2 { x: 2.5, y: 1.0 }),
            ..Default::default()
        });
        let after = emit_roofs(&p, None).unwrap();
        assert_eq!(before.len(), after.len());
        for m in &after {
            assert!(crate::wall_mesh_cut::is_watertight(&m.positions, &m.indices, 1e-6), "Schicht dicht");
        }
        let vol = |ms: &[RMesh]| ms.iter().map(|m| crate::export_flat::mesh_volume(&m.positions, &m.indices)).sum::<f64>();
        let removed = vol(&before) - vol(&after);
        let t: f64 = p.roof_layers(&p.roofs.as_ref().unwrap()[0]).iter().map(|l| l.thickness).sum();
        assert!((removed - 0.78 * 1.18 * t).abs() < 1e-6, "Loch = Fläche × Dicke: {removed}");
        let parts = emit_opening_meshes(&p, 2.0).len() - emit_opening_meshes(&sample(), 2.0).len();
        assert!(parts >= 9, "Rahmen, Glas, Eindeckrahmen: {parts}");
        let layers = emit_roof_cut_layers(&p).unwrap().len();
        assert!(layers > emit_roof_cut_layers(&sample()).unwrap().len());
    }

    /// Flachdach auf L-Umriss ([148]): Körper = L × Dachaufbau (nicht Bounding-Box), jede Schicht dicht;
    /// ein Dachfenster genau über der Fuge zweier Teilflächen schneidet beide, Laibung nur einmal.
    #[test]
    fn flachdach_l_volumen_und_dachfenster_ueber_der_fuge() {
        let mut p = sample();
        let l = [(0.0, 0.0), (11.0, 0.0), (11.0, 4.0), (8.0, 4.0), (8.0, 6.0), (0.0, 6.0)];
        {
            let r = &mut p.roofs.as_mut().unwrap()[0];
            r.outline = l.iter().map(|&(x, y)| Vec2 { x, y }).collect();
            r.shape = crate::model::RoofShape::Flach;
            r.pitch_deg = 0.0;
            r.overhang = 0.0;
            r.overhang_gable = None;
        }
        let t: f64 = p.roof_layers(&p.roofs.as_ref().unwrap()[0]).iter().map(|l| l.thickness).sum();
        let vol = |ms: &[RMesh]| ms.iter().map(|m| crate::export_flat::mesh_volume(&m.positions, &m.indices)).sum::<f64>();
        let before = emit_roofs(&p, None).unwrap();
        assert!((vol(&before) - 60.0 * t).abs() < 1e-6, "L-Fläche × Dicke: {} statt {}", vol(&before), 60.0 * t);
        for m in &before {
            assert!(crate::wall_mesh_cut::is_watertight(&m.positions, &m.indices, 1e-6), "Schicht dicht");
            assert!(m.positions.chunks_exact(3).all(|c| !(c[0] > 8.0 + 1e-9 && c[1] > 4.0 + 1e-9)), "nichts über der Aussparung");
        }
        // Fuge = gemeinsame Kante zweier Teilflächen; Dachfenster mitten darauf.
        let g = crate::roof::roof_geometry(&p.roofs.as_ref().unwrap()[0].params(), 0.0);
        assert!(g.planes.len() >= 2);
        let (a, b) = (0..g.planes.len())
            .flat_map(|i| (0..g.planes[i].len()).map(move |k| (i, k)))
            .find_map(|(i, k)| {
                let pl = &g.planes[i];
                let (u, v) = (pl[k], pl[(k + 1) % pl.len()]);
                g.planes.iter().enumerate().any(|(j, q)| j != i && q.contains(&u) && q.contains(&v)).then_some((u, v))
            })
            .expect("Fuge");
        let mid = Vec2 { x: (a[0] + b[0]) / 2.0, y: (a[1] + b[1]) / 2.0 };
        p.openings.as_mut().unwrap().push(Opening { id: "DF".into(), kind: ElementKind::Window, width: 0.6, height: 0.6, host_roof_id: Some("RF1".into()), host_point: Some(mid), ..Default::default() });
        let after = emit_roofs(&p, None).unwrap();
        for m in &after {
            assert!(crate::wall_mesh_cut::is_watertight(&m.positions, &m.indices, 1e-6), "Schicht mit Loch über der Fuge dicht");
        }
        let removed = vol(&before) - vol(&after);
        assert!((removed - 0.36 * t).abs() < 1e-6, "Loch = Fläche × Dicke: {removed}");
    }

    /// [103] Deckenöffnung: Aussparung im Slab.
    #[test]
    fn deckenoeffnung_im_slab() {
        let mut p = sample();
        let n0: usize = emit_slabs(&p).iter().map(|s| s.outline.len()).sum();
        p.openings.as_mut().unwrap().push(Opening { id: "DO".into(), kind: ElementKind::Window, width: 1.0, height: 1.0, host_ceiling_id: Some("C1".into()), host_point: Some(Vec2 { x: 2.0, y: 2.0 }), ..Default::default() });
        let n1: usize = emit_slabs(&p).iter().map(|s| s.outline.len()).sum();
        assert!(n1 > n0, "Loch-Ring eingebunden");
    }

    #[test]
    fn beispielprojekt_hat_decken_und_gueltige_farben() {
        let p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        let slabs = emit_slabs(&p);
        assert!(!slabs.is_empty());
        assert!(slabs.iter().all(|s| s.z_top > s.z_bottom && s.outline.len() >= 3));
    }

    /// Dachkörper einer Schicht (Versatz `d0` bis `d1` unter der Oberkante) wie in `emit_roofs`.
    fn roof_slab_closed(planes: &[Vec<V3>], d0: f64, d1: f64) -> bool {
        let mitre = Mitre::new(planes);
        let (mut positions, mut indices) = (Vec::new(), Vec::new());
        for (i, plane) in planes.iter().enumerate() {
            if plane.len() >= 3 {
                push_roof_slab_between(&mut positions, &mut indices, &mitre.at(i, d0), &mitre.at(i, d1), &mitre.shared[i]);
            }
        }
        crate::wall_mesh_cut::is_watertight(&positions, &indices, 1e-6)
    }

    /// [G9] Gehrung an Punkten mit mehr als zwei Dachflächen (Zeltspitze auf Rechteck mit zwei
    /// Neigungen, Kehlpunkte, konvexe Teilstücke einer Skelett-Fläche, Mansardknick): jede
    /// Dachschicht ist ein geschlossener Körper. Vorher klafften dort Lücken (Zelt 7×5 m:
    /// 1.1e-3 m², Walm auf L: 0.77 m²).
    #[test]
    fn g9_dachschichten_geschlossen() {
        use crate::roof::{roof_geometry, MansardType, RoofParams, Shape};
        use crate::roof_skeleton::Axis;
        let l = vec![[0.0, 0.0], [11.0, 0.0], [11.0, 4.0], [8.0, 4.0], [8.0, 6.0], [0.0, 6.0]];
        let u = vec![[0.0, 0.0], [12.0, 0.0], [12.0, 9.0], [8.0, 9.0], [8.0, 4.0], [4.0, 4.0], [4.0, 9.0], [0.0, 9.0]];
        let rect = vec![[0.0, 0.0], [7.0, 0.0], [7.0, 5.0], [0.0, 5.0]];
        let star = vec![[0.0, 0.0], [8.0, 0.0], [10.0, 5.0], [4.0, 3.0], [-2.0, 5.0]];
        let skew = vec![[0.0, 0.0], [10.0, 0.0], [13.0, 5.0], [3.0, 5.0]];
        let shapes = [
            (Shape::Walm, MansardType::Giebel),
            (Shape::Zelt, MansardType::Giebel),
            (Shape::Sattel, MansardType::Giebel),
            (Shape::Mansarde, MansardType::Giebel),
            (Shape::Mansarde, MansardType::Walm),
            (Shape::Mansarde, MansardType::Zelt),
        ];
        for outline in [&rect, &l, &u, &star, &skew] {
            for (shape, mt) in shapes {
                for axis in [Axis::X, Axis::Y] {
                    let p = RoofParams {
                        outline: outline.clone(),
                        shape,
                        pitch_deg: 35.0,
                        pitch_upper_deg: None,
                        mansard_type: mt,
                        mansard_knee_ratio: None,
                        half_hip_ratio: None,
                        overhang: 0.5,
                        overhang_gable: None,
                        ridge_axis: axis,
                        holes: vec![],
                        edge_pitch_deg: None,
                    };
                    let g = roof_geometry(&p, 6.0);
                    for (d0, d1) in [(0.0, 0.3), (0.3, 0.42)] {
                        assert!(roof_slab_closed(&g.planes, d0, d1), "{outline:?} {shape:?} {mt:?} {axis:?} {d0}–{d1}");
                    }
                }
            }
        }
    }
    /// [26] Dächer mit Innenhof und Neigung je Kante: jede Dachschicht ist ein geschlossener Körper
    /// (auch an den Hofkanten, mit Giebeln und verschieden geneigten Kanten).
    #[test]
    fn dachschichten_mit_hof_und_kantenneigung_geschlossen() {
        use crate::roof::{roof_geometry, MansardType, RoofParams, Shape};
        use crate::roof_skeleton::Axis;
        let big = vec![[0.0, 0.0], [12.0, 0.0], [12.0, 8.0], [0.0, 8.0]];
        let court = vec![[4.0, 2.0], [4.0, 6.0], [8.0, 6.0], [8.0, 2.0]];
        let tri = vec![[2.0, 1.5], [2.0, 3.5], [3.5, 2.5]];
        let variants: Vec<(Vec<Vec<[f64; 2]>>, Option<Vec<Option<f64>>>)> = vec![
            (vec![court.clone()], None),
            (vec![court.clone(), vec![[9.0, 2.0], [9.0, 4.0], [11.0, 4.0], [11.0, 2.0]]], None),
            (vec![tri], None),
            (vec![], Some(vec![Some(20.0), Some(50.0), Some(30.0), Some(60.0)])),
            (vec![court.clone()], Some(vec![Some(20.0), None, Some(-1.0), Some(45.0), Some(10.0)])),
            (vec![], Some(vec![Some(-1.0), None, Some(-1.0), None])),
        ];
        for (holes, edges) in variants {
            for (shape, mt) in [(Shape::Walm, MansardType::Giebel), (Shape::Zelt, MansardType::Giebel), (Shape::Sattel, MansardType::Giebel), (Shape::Mansarde, MansardType::Giebel), (Shape::Mansarde, MansardType::Walm)] {
                for overhang in [0.0, 0.4] {
                    let p = RoofParams {
                        outline: big.clone(),
                        shape,
                        pitch_deg: 35.0,
                        pitch_upper_deg: None,
                        mansard_type: mt,
                        mansard_knee_ratio: None,
                        half_hip_ratio: None,
                        overhang,
                        overhang_gable: None,
                        ridge_axis: Axis::X,
                        holes: holes.clone(),
                        edge_pitch_deg: edges.clone(),
                    };
                    let g = roof_geometry(&p, 6.0);
                    assert!(!g.planes.is_empty());
                    // Mansarde mit Hof UND verschieden geneigten Kanten: die zweite Schicht (Versatz bis 0.42 m)
                    // ist dort schmaler als der Versatz — bekannte Grenze, nur die erste Schicht prüfen.
                    let layers: &[(f64, f64)] = if shape == Shape::Mansarde && !holes.is_empty() && edges.is_some() { &[(0.0, 0.3)] } else { &[(0.0, 0.3), (0.3, 0.42)] };
                    for &(d0, d1) in layers {
                        assert!(roof_slab_closed(&g.planes, d0, d1), "{holes:?} {edges:?} {shape:?} {mt:?} oh {overhang} {d0}–{d1}");
                    }
                }
            }
        }
    }

    /// [95] Taschen-Schiebetür: der Hohlraum (Blattbreite + 5 cm × 7 cm × Türhöhe) fehlt im Wandkörper,
    /// geschichtet wie einschichtig; Tasche auf der Bandseite.
    #[test]
    fn tasche_aus_dem_wandkoerper_ausgeschnitten() {
        use crate::plan::walls::tests::pocket_project;
        let vol = |ws: &[RWall]| -> f64 {
            ws.iter().map(|w| wall_piece_volume(w) - w.holes.as_deref().unwrap_or(&[]).iter().map(|h| (h.to - h.from) * (h.z_top - h.z_bottom) * w.thickness).sum::<f64>()).sum()
        };
        for layered in [false, true] {
            let full = vol(&emit_walls(&pocket_project(DoorTypeKind::Schiebe, None, 1.0), layered).unwrap());
            for (hinge, x_pocket, x_other) in [(None, 0.5, 2.5), (Some(OpeningHinge::End), 2.4, 0.5)] {
                let ws = emit_walls(&pocket_project(DoorTypeKind::Tasche, hinge, 1.0), layered).unwrap();
                let v = vol(&ws);
                assert!((full - v - 0.95 * 0.07 * 2.0).abs() < 1e-9, "{layered} {full} {v}");
                // Wandmitte (y = 0): in der Tasche kein Körper bis zur Türhöhe, darüber schon.
                let solid_at = |x: f64, z: f64| {
                    ws.iter().any(|w| {
                        let lo_hi = |a: f64, b: f64| (a.min(b), a.max(b));
                        let (x0, x1) = lo_hi(w.start[0], w.end[0]);
                        x0 < x && x < x1 && w.start[1].abs() < w.thickness / 2.0 && w.base_elevation < z && z < w.base_elevation + w.height
                    })
                };
                assert!(!solid_at(x_pocket, 1.0), "{layered} {hinge:?}");
                assert!(solid_at(x_pocket, 2.3), "{layered} {hinge:?}");
                assert!(solid_at(x_other, 1.0), "{layered} {hinge:?}");
            }
            let ws = emit_walls(&pocket_project(DoorTypeKind::Tasche, None, 2.0), layered).unwrap();
            assert!((full - vol(&ws) - 2.0 * 0.5 * 0.07 * 2.0).abs() < 1e-9, "zweiflügelig {layered}");
        }
    }

    /// [95][T2] Tasche in der Bogenwand (entlang der Sehnen-Teilkörper, Länge = Achsmass) und unter
    /// schräger Oberkante (Dachanschluss, `top_plane`/`top_drop`): Volumen −Hohlraum wie gerade.
    #[test]
    fn tasche_in_bogenwand_und_unter_dach() {
        use crate::plan::walls::tests::{pocket_project_with, POCKET_BULGE};
        let vol = |ws: &[RWall]| -> f64 {
            ws.iter().map(|w| wall_piece_volume(w) - w.holes.as_deref().unwrap_or(&[]).iter().map(|h| (h.to - h.from) * (h.z_top - h.z_bottom) * w.thickness).sum::<f64>()).sum()
        };
        for (bulge, roof, tol) in [(Some(POCKET_BULGE), false, 2e-4), (None, true, 1e-9)] {
            for layered in [false, true] {
                for (hinge, leaves, k) in [(None, 1.0, 0.95), (Some(OpeningHinge::End), 1.0, 0.95), (None, 2.0, 1.0)] {
                    let full = emit_walls(&pocket_project_with(DoorTypeKind::Schiebe, hinge, leaves, bulge, roof), layered).unwrap();
                    if roof {
                        assert!(full.iter().any(|w| w.top_plane.is_some() && w.top_drop.is_some()), "schräge Oberkante");
                    }
                    let ws = emit_walls(&pocket_project_with(DoorTypeKind::Tasche, hinge, leaves, bulge, roof), layered).unwrap();
                    let d = vol(&full) - vol(&ws);
                    assert!((d - k * 0.07 * 2.0).abs() < tol, "{bulge:?} {roof} {layered} {hinge:?} {leaves}: {d}");
                    // Unter dem Dach: Oberkante der Teilkörper weiter auf der Dachebene (nicht über die Ursprungshöhe).
                    for w in ws.iter().filter(|w| w.top_plane.is_some()) {
                        let fp = wall_footprint(w).unwrap();
                        let top = fp.iter().map(|q| wall_top_at(w, *q)).fold(f64::MIN, f64::max);
                        assert!(top <= w.base_elevation + w.height + 1e-9 && top > 2.0, "{w:?}");
                    }
                }
            }
        }
    }

    fn pick_base(extra: serde_json::Value) -> Project {
        let mut v = serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
            "drawingLevels": [{"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 1.0}],
            "drawings2d": []
        });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        serde_json::from_value(v).unwrap()
    }

    /// [137] Treppengeländer sind im 3D anwählbar: Handlauf-Dreiecke tragen die Treppen-Id und reichen über die Hülle.
    #[test]
    fn pick_treppengelaender_im_3d() {
        let mk = |railing: &str| {
            pick_base(serde_json::json!({
                "stairTypes": [{"id": "t", "name": "T", "structure": "massiv", "closedRisers": false, "treadThickness": 0.04, "railing": railing, "defaultWidth": 1.0}],
                "stairs": [{"id": "s1", "type": "stair", "floorId": "EG", "categoryCode": "35", "shape": "straight", "start": {"x": 0, "y": 0}, "dir": {"x": 1, "y": 0},
                    "runLength": 3.0, "width": 1.0, "stepCount": 16, "totalRise": 2.8, "typeId": "t"}]
            }))
        };
        assert!(pick_geometry(&mk("keine")).unwrap().stair_meshes.is_empty());
        let g = pick_geometry(&mk("beide")).unwrap();
        assert_eq!(g.stair_meshes.len(), 1);
        assert_eq!(g.stair_meshes[0].stair_id, "s1");
        assert!(!g.stair_meshes[0].tris.is_empty());
        let top = g.stair_meshes[0].tris.iter().flatten().map(|q| q[1]).fold(f64::MIN, f64::max);
        assert!(top > g.stairs[0].z_top, "Geländer über der OK der Treppe: {top} > {}", g.stairs[0].z_top);
    }

    /// [137] Kreis, Bogen und Text (Bäume, Symbole) bekommen flache Pick-Flächen auf Geschosshöhe.
    #[test]
    fn pick_kreis_bogen_text_im_3d() {
        let d = |id: &str, geom: serde_json::Value| serde_json::json!({"id": id, "type": "drawing2d", "levelId": "EG", "categoryCode": "20", "geom": geom});
        let p = pick_base(serde_json::json!({"drawings2d": [
            d("c", serde_json::json!({"shape": "circle", "center": {"x": 2, "y": 3}, "r": 1.5})),
            d("a", serde_json::json!({"shape": "arc", "center": {"x": 10, "y": 0}, "r": 2.0, "a0": 0.0, "a1": std::f64::consts::FRAC_PI_2})),
            d("t", serde_json::json!({"shape": "text", "at": {"x": 20, "y": 0}, "text": "Baum", "height": 0.5, "angle": 0.0})),
            d("l", serde_json::json!({"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 1, "y": 0}}))
        ]}));
        let g = pick_geometry(&p).unwrap();
        let ids: Vec<&str> = g.drawing_meshes.iter().map(|m| m.drawing_id.as_str()).collect();
        assert_eq!(ids, ["c", "a", "t"]);
        for m in &g.drawing_meshes {
            assert!(m.tris.iter().flatten().all(|q| (q[1] - 1.01).abs() < 1e-9), "Geschosshöhe + EPS");
        }
        // Scheibe: Mittelpunkt (2, 3) liegt in einem Dreieck, ein Punkt ausserhalb nicht.
        let inside = |tris: &[Tri], x: f64, z: f64| {
            tris.iter().any(|t| {
                let s = |a: V3, b: V3| (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);
                let (d1, d2, d3) = (s(t[0], t[1]), s(t[1], t[2]), s(t[2], t[0]));
                !((d1 < 0.0 || d2 < 0.0 || d3 < 0.0) && (d1 > 0.0 || d2 > 0.0 || d3 > 0.0))
            })
        };
        assert!(inside(&g.drawing_meshes[0].tris, 2.5, 3.5) && !inside(&g.drawing_meshes[0].tris, 4.0, 3.0));
        // Bogen: auf dem Bogen ja, im Zentrum nein.
        assert!(inside(&g.drawing_meshes[1].tris, 10.0 + 2.0 * 0.5f64.sqrt(), 2.0 * 0.5f64.sqrt()) && !inside(&g.drawing_meshes[1].tris, 10.0, 0.0));
        // Text: 4 Zeichen · 0.6 · 0.5 = 1.2 m breit.
        assert!(inside(&g.drawing_meshes[2].tris, 21.0, 0.2) && !inside(&g.drawing_meshes[2].tris, 22.0, 0.2));
    }

    /// [137] Einzeln ausgeblendetes importiertes Netz: weder im 3D noch als Pick-Dreiecke.
    #[test]
    fn importiertes_netz_einzeln_ausgeblendet() {
        let mk = |hidden: Option<bool>| Project {
            context: Some(vec![ContextObject::ImportedMesh(ImportedMesh { id: "m".into(), hidden, positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], indices: vec![0.0, 1.0, 2.0], ..Default::default() })]),
            ..Default::default()
        };
        assert_eq!(emit_context_meshes(&mk(None)).len(), 1);
        assert_eq!(pick_geometry(&mk(None)).unwrap().context_meshes.len(), 1);
        assert!(emit_context_meshes(&mk(Some(true))).is_empty());
        assert!(pick_geometry(&mk(Some(true))).unwrap().context_meshes.is_empty());
    }
}
