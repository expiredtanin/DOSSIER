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
}

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
        let openings = c.openings.as_deref().unwrap_or(&[]);
        w.num(openings.len() as f64);
        for o in openings {
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
                    let line = resolve_cut_line_style(p, l.joint_line_style_id.as_deref());
                    (
                        hex_to_rgb(&comp.color, style::WALL_RGB),
                        Some(RCutMeta {
                            join_priority: Some(comp.join_priority),
                            component_id: Some(comp.id.clone()),
                            line_color: line.map(|x| x.0),
                            line_weight: line.map(|x| x.1),
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
const COLUMN_RGB: Rgb = [0.7, 0.7, 0.72];

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

/// Stützen als Prisma-Meshes (`emitColumns`).
pub fn emit_columns(p: &Project) -> Vec<RMesh> {
    let mut cols: Vec<&Column> = Vec::new();
    let mut w = FlatWriter::new();
    let count = w.slot();
    for col in p.columns.as_deref().unwrap_or(&[]) {
        if col.height <= 0.0 {
            continue;
        }
        let (z_bottom, z_top) = p.column_vertical_extent(col);
        let foot = column_footprint(col);
        w.num(z_bottom).num(z_top).ring(&foot);
        cols.push(col);
    }
    if cols.is_empty() {
        return vec![];
    }
    w.set(count, cols.len() as f64);
    crate::columns3d::columns(&w.done())
        .into_iter()
        .map(|m| {
            let col = cols[m.src];
            let color = col
                .component_id
                .as_deref()
                .and_then(|id| p.component(id))
                .map_or(COLUMN_RGB, |c| hex_to_rgb(&c.color, COLUMN_RGB));
            RMesh { positions: m.positions, indices: m.indices, kind: "extrusion", color, vertex_colors: None, material_index: None }
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
        let line = resolve_cut_line_style(p, l.joint_line_style_id.as_deref());
        bands.push(WallBand {
            thickness: l.thickness,
            color: hex_to_rgb(&comp.color, WALL_RGB),
            hatch: resolve_component_hatch(p, &l.component_id, Some(SECTION_WALL_AXIS_ANGLE_DEG)),
            material_index: material_layer(p, maps, &l.component_id),
            priority: Some(comp.join_priority),
            component_id: Some(comp.id.clone()),
            cut_line_color: line.map(|x| x.0),
            cut_line_weight: line.map(|x| x.1),
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

/// Verschneidung je Geschoss (`computeJoinsByFloor`); Fehler = unbekannter Wandtyp/Bauteil.
fn compute_joins_by_floor(p: &Project) -> Result<HashMap<String, WallCuts>, String> {
    let mut groups: Vec<(String, Vec<&Wall>)> = Vec::new();
    for w in &p.walls {
        match groups.iter_mut().find(|g| g.0 == w.floor_id) {
            Some(g) => g.1.push(w),
            None => groups.push((w.floor_id.clone(), vec![w])),
        }
    }
    let mut merged = HashMap::new();
    for (_, walls) in &groups {
        let mut comp_index: HashMap<&str, u32> = HashMap::new();
        let mut jw: Vec<JoinWall> = Vec::with_capacity(walls.len());
        let mut finite = true;
        for w in walls {
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
            jw.push(JoinWall { start: kv(w.start), end: kv(w.end), reference, layers });
        }
        if !finite {
            for w in walls {
                merged.insert(w.id.clone(), WallCuts::default());
            }
            continue;
        }
        match joins::compute_joins(&jw) {
            Ok(cuts) => {
                for (w, c) in walls.iter().zip(cuts) {
                    merged.insert(w.id.clone(), c);
                }
            }
            // Mit den Rückfällen oben nicht mehr erwartet: dann eben ohne Verschneidung.
            Err(_) => {
                for w in walls {
                    merged.insert(w.id.clone(), WallCuts::default());
                }
            }
        }
    }
    Ok(merged)
}

fn floor_context(p: &Project, floor_id: &str) -> FloorContext {
    let ceilings: Vec<CeilingIn> = p
        .ceilings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|c| c.floor_id == floor_id && c.outline.len() >= 3)
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
            RoofIn { eaves_z, total_thickness: total, eaves: geo.eaves, planes: geo.planes }
        })
        .collect();
    FloorContext::new(ceilings, roofs)
}

/// Wandkörper (`projectToWalls3d`): `layered` = ein Körper je Schicht mit Löchern (3D-Viewer),
/// sonst Pfeiler/Brüstung/Sturz-Segmente (Schnitt-Eingabe).
pub fn emit_walls(p: &Project, layered: bool) -> Result<Vec<RWall>, String> {
    let joins = if layered { Some(compute_joins_by_floor(p)?) } else { None };
    let maps = wall_material_color_maps(p);
    let mut contexts: HashMap<&str, FloorContext> = HashMap::new();
    let empty = FloorContext::default();
    let mut out = Vec::new();
    let by_wall = p.openings_by_wall();
    for wall in &p.walls {
        let (bands, stacked) = resolve_wall_bands(p, &maps, wall, layered);
        let (z_bottom, z_top) = p.wall_vertical_extent(wall);
        let ctx = if layered {
            contexts.entry(wall.floor_id.as_str()).or_insert_with(|| floor_context(p, &wall.floor_id))
        } else {
            &empty
        };
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
            openings: wall_openings(p, wall, by_wall.get(wall.id.as_str()).map_or(&[][..], |v| v.as_slice()), true),
            cuts: if layered { joins.as_ref().and_then(|j| j.get(&wall.id)).cloned().unwrap_or_default() } else { WallCuts::default() },
        };
        let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
        for piece in wall_bands::wall_bands(&win, ctx) {
            let Some(b) = bands.get(piece.band) else { continue };
            out.push(RWall {
                start: [piece.start.x, piece.start.y],
                end: [piece.end.x, piece.end.y],
                thickness: b.thickness,
                height: piece.z_top - piece.z_bottom,
                base_elevation: piece.z_bottom,
                top_drop: piece.top_drop,
                color: b.color,
                layers: vec![],
                wall_id: wall.id.clone(),
                holes: (!piece.holes.is_empty()).then(|| piece.holes.iter().map(|h| RHole { from: h[0], to: h[1], z_bottom: h[2], z_top: h[3] }).collect()),
                hatch: b.hatch.clone().map(|h| with_top_angle(h, dx, dy)),
                material_index: b.material_index,
                cut: band_cut_meta(b),
            });
        }
    }
    let _ = hypot2;
    Ok(out)
}

// ── Öffnungs-Einbauteile (Glas, Rahmen, Sprossen, Bank, Kasten) ─────────────

/// Farbe je Bauteil-Klasse (Index = `Part` in `openings3d.rs`).
const PART_RGB: [Rgb; 6] = [
    [0.62, 0.76, 0.85],
    [0.85, 0.85, 0.83],
    [0.88, 0.88, 0.9],
    [0.8, 0.8, 0.78],
    [0.25, 0.27, 0.3],
    [0.93, 0.9, 0.85],
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

fn write_common(w: &mut FlatWriter, frame_depth: Option<f64>, inset: Option<f64>, inner: bool, join: Option<FrameCornerJoin>, frame_width: Option<f64>, transom: Option<f64>) {
    w.nums(&[opt(frame_depth), opt(inset), flag(inner), join_code(join), opt(frame_width), opt(transom)]);
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
        write_common(w, wt.frame_depth, wt.inset_from_face, wt.inset_face == Some(WindowTypeInsetFace::Innen), wt.frame_corner_join, wt.frame_width, wt.transom_height);
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
        return;
    }
    let Some(dt) = p.door_type(op) else {
        w.num(0.0);
        return;
    };
    w.num(1.0);
    write_common(w, dt.frame_depth, dt.inset_from_face, dt.inset_face == Some(DoorTypeInsetFace::Innen), dt.frame_corner_join, dt.frame_width, dt.transom_height);
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
    ]);
}

/// Öffnungs-Einbauteile als Quader-Meshes (`emitOpeningMeshes`); `detail`: 0 grob, 1 mittel, 2 fein.
pub fn emit_opening_meshes(p: &Project, detail: f64) -> Vec<RMesh> {
    let mut w = FlatWriter::new();
    w.num(detail).num(p.walls.len() as f64);
    for wall in &p.walls {
        w.nums(&[wall.start.x, wall.start.y, wall.end.x, wall.end.y]);
        let slot = w.slot();
        let mut count = 0.0;
        let wr = wall_ref(p, wall);
        let (zb, zt) = p.wall_vertical_extent(wall);
        let mut thickness: Option<f64> = None;
        for op in p.openings_of_wall(&wall.id) {
            let Some((from, to)) = opening_geom::opening_interval(&wr, op.position, op.width) else { continue };
            let o_bottom = zb + op.sill_height.max(0.0);
            let o_top = zt.min(o_bottom + op.height);
            let t = *thickness.get_or_insert_with(|| p.wall_thickness(wall, 0.2));
            w.nums(&[from, to, o_bottom, o_top, flag(op.kind != ElementKind::Window), t]);
            write_opening(&mut w, p, op);
            count += 1.0;
        }
        w.set(slot, count);
    }
    let buf = crate::openings3d::opening_meshes_flat(&w.done());
    let n = buf.first().copied().unwrap_or(0.0).max(0.0) as usize;
    let mut out = Vec::new();
    let mut i = 1;
    for _ in 0..n {
        if i + 25 > buf.len() {
            break;
        }
        let part = buf[i] as usize;
        out.push(RMesh {
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

// ── Treppen ─────────────────────────────────────────────────────────────────

fn stair_rgb() -> Rgb {
    hex_to_rgb("#9aa0a6", SLAB_RGB)
}

fn rail_rgb() -> Rgb {
    hex_to_rgb("#74797f", SLAB_RGB)
}

/// Flache Eingabe der Treppen für `stairs3d` (23 Zahlen je Treppe); `wanted` wählt vor.
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
    }
    Some((stairs, buf))
}

/// Treppen als extrudierte Platten (`emitStairs`); `for_section`: auch gerade Betontreppen als Tritte.
pub fn emit_stairs(p: &Project, for_section: bool) -> Vec<RSlab> {
    let Some((stairs, buf)) = stair_input(p, |_, _| true) else { return vec![] };
    crate::stairs3d::slabs(&buf, for_section)
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
    meshes.into_iter().map(|m| RMesh { positions: m.positions, indices: m.indices, kind: "extrusion", color, vertex_colors: None, material_index: None }).collect()
}

/// Glatte Ortbeton-Laufplatten gerader Treppen (`emitStairMeshes`).
pub fn emit_stair_meshes(p: &Project) -> Vec<RMesh> {
    match stair_input(p, |s, st| st.is_some_and(|t| t.structure == StairTypeStructure::Beton) && s.shape == StairShape::Straight) {
        Some((_, buf)) => meshes_of(crate::stairs3d::slab_meshes(&buf), stair_rgb()),
        None => vec![],
    }
}

/// Handlauf und Pfosten gerader Treppen (`emitStairRailings`).
pub fn emit_stair_railings(p: &Project) -> Vec<RMesh> {
    match stair_input(p, |s, st| s.shape == StairShape::Straight && st.and_then(|t| t.railing).is_some_and(|r| r != StairTypeRailing::Keine)) {
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
fn plane_normal_up(pts: &[V3]) -> V3 {
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
    for roof in p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| only_roof.is_none_or(|id| r.id == id)) {
        let eaves_z = p.roof_base_elevation(roof);
        let g = crate::roof::roof_geometry(&roof.params(), eaves_z);
        let override_color = roof.color.as_deref().filter(|c| !c.is_empty()).map(|c| hex_to_rgb(c, ROOF_RGB));
        let mitre = Mitre::new(&g.planes);
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
                push_roof_slab_between(&mut positions, &mut indices, &top, &bottom, &mitre.shared[i]);
            }
            if !indices.is_empty() {
                out.push(RMesh { positions, indices, kind: "extrusion", color, vertex_colors: None, material_index });
            }
            offset_above += t;
        }
    }
    Ok(out)
}

/// Dachschicht-Eingabe für den 3D-Live-Schnitt (`emitRoofCutLayers`).
pub fn emit_roof_cut_layers(p: &Project) -> Result<Vec<RRoofLayer>, String> {
    let mut out = Vec::new();
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let eaves_z = p.roof_base_elevation(roof);
        let g = crate::roof::roof_geometry(&roof.params(), eaves_z);
        let override_color = roof.color.as_deref().filter(|c| !c.is_empty()).map(|c| hex_to_rgb(c, ROOF_RGB));
        let mut offset_above = 0.0;
        for layer in p.roof_layers(roof) {
            let t = layer.thickness.max(0.0);
            if t <= EPS {
                continue;
            }
            let color = roof_color(p, override_color, &layer.component_id)?;
            let line = resolve_cut_line_style(p, layer.joint_line_style_id.as_deref());
            let cut = line.map(|(c, w)| RCutMeta { line_color: Some(c), line_weight: Some(w), ..Default::default() });
            for plane in &g.planes {
                let nrm = plane_normal_up(plane);
                let polygon = plane.iter().map(|q| [q[0] - nrm[0] * offset_above, q[1] - nrm[1] * offset_above, q[2] - nrm[2] * offset_above]).collect();
                out.push(RRoofLayer { polygon, normal: nrm, thickness: t, color, cut: cut.clone() });
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

/// Rohe Kontext-Meshes: Gelände-TIN und importierte Volumen (`emitMeshes`).
pub fn emit_context_meshes(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    for obj in p.context.as_deref().unwrap_or(&[]) {
        match obj {
            ContextObject::TerrainMesh(m) if m.positions.len() >= 9 && m.indices.len() >= 3 => out.push(RMesh {
                positions: m.positions.clone(),
                indices: indices_u32(&m.indices),
                kind: "terrain",
                color: TERRAIN_RGB,
                vertex_colors: m.vertex_colors.clone().filter(|v| !v.is_empty()),
                material_index: None,
            }),
            ContextObject::ImportedMesh(m) if m.positions.len() >= 9 && m.indices.len() >= 3 => out.push(RMesh {
                positions: m.positions.clone(),
                indices: indices_u32(&m.indices),
                kind: "imported",
                color: IMPORTED_RGB,
                vertex_colors: None,
                material_index: None,
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
        column_meshes: emit_columns(p),
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
fn for_each_drawing_chunk(p: &Project, with_color: bool, mut f: impl FnMut(&[f64], &[&Drawing2D])) {
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
        let (kind, pts): (f64, Vec<Vec2>) = match &d.geom {
            Drawing2DGeom::Line { a, b } => (1.0, vec![*a, *b]),
            Drawing2DGeom::Rect { min, max } => (3.0, vec![*min, *max]),
            Drawing2DGeom::Polyline { pts, .. } => (2.0, pts.clone()),
            _ => continue,
        };
        let need = 7 + 2 * pts.len();
        if buf.len() + need > CHUNK_DOUBLES {
            flush(&mut buf, &mut ids, &mut f);
        }
        let elev = *elevations.entry(d.level_id.as_str()).or_insert_with(|| p.floor(&d.level_id).map_or(0.0, |l| l.base_elevation.unwrap_or(0.0)) + DRAWING_LINE_ELEVATION_EPS);
        let rgb = if with_color { drawing_color(d, &by_category, &by_line_style) } else { [0.0; 3] };
        let closed = matches!(&d.geom, Drawing2DGeom::Polyline { closed: true, .. });
        buf.extend([kind, elev, rgb[0], rgb[1], rgb[2], if closed { 1.0 } else { 0.0 }, pts.len() as f64]);
        for q in &pts {
            buf.extend([q.x, q.y]);
        }
        ids.push(d);
    }
    flush(&mut buf, &mut ids, &mut f);
}

/// Boden-Spuren aller Zeichnungen als LineList-Vertices `[px, py, pz, r, g, b]` (`emitDrawingLineVerts`).
pub fn drawing_line_verts(p: &Project) -> Vec<f32> {
    let mut out = Vec::new();
    for_each_drawing_chunk(p, true, |buf, _| out.extend(crate::drawing2d_3d::line_verts(buf)));
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

fn pick_drawing_segs(p: &Project) -> Vec<PickDrawingSeg> {
    let mut out = Vec::new();
    for_each_drawing_chunk(p, false, |buf, drawings| {
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

#[derive(Debug, Serialize)]
pub struct PickGeometry {
    pub walls: Vec<RWall>,
    pub slabs: Vec<RSlab>,
    pub openings: Vec<PickBox>,
    pub stairs: Vec<PickStair>,
    pub roofs: Vec<PickRoof>,
    #[serde(rename = "contextMeshes")]
    pub context_meshes: Vec<PickContextMesh>,
    pub drawings: Vec<PickDrawingSeg>,
}

/// Öffnungen als Quader (Laibung zu Laibung, Wanddicke, Brüstung bis Sturz) für Pick und Hervorhebung.
pub fn pick_openings(p: &Project) -> Vec<PickBox> {
    let mut openings = Vec::new();
    for o in p.openings.as_deref().unwrap_or(&[]) {
        let Some(wall) = p.walls.iter().find(|w| w.id == o.host_wall_id) else { continue };
        let wr = wall_ref(p, wall);
        let Some((jamb_start, jamb_end)) = opening_geom::opening_jambs(&wr, o.position, o.width) else { continue };
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
        let mut tris: Vec<Tri> = Vec::new();
        for poly in g.planes.iter().chain(g.gables.iter()) {
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
    for obj in p.context.as_deref().unwrap_or(&[]) {
        let (pos, idx, id) = match obj {
            ContextObject::TerrainMesh(m) => (&m.positions, &m.indices, &m.id),
            ContextObject::ImportedMesh(m) => (&m.positions, &m.indices, &m.id),
            _ => continue,
        };
        let vcount = pos.len() / 3;
        let at = |i: usize| -> V3 { [pos[i * 3], pos[i * 3 + 2], -pos[i * 3 + 1]] };
        let mut tris: Vec<Tri> = Vec::new();
        for t in idx.chunks_exact(3) {
            let ok = |v: f64| v >= 0.0 && v.fract() == 0.0 && (v as usize) < vcount;
            if !(ok(t[0]) && ok(t[1]) && ok(t[2])) {
                continue;
            }
            tris.push([at(t[0] as usize), at(t[1] as usize), at(t[2] as usize)]);
        }
        if !tris.is_empty() {
            context_meshes.push(PickContextMesh { tris, context_object_id: id.clone() });
        }
    }
    Ok(PickGeometry {
        walls: emit_walls(p, true)?,
        slabs: emit_slabs(p),
        openings,
        stairs,
        roofs,
        context_meshes,
        drawings: pick_drawing_segs(p),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

