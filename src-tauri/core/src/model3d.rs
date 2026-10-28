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
    let mut ceilings: Vec<&Ceiling> = Vec::new();
    let mut layers_of: Vec<Option<&[Layer]>> = Vec::new();
    let mut w = FlatWriter::new();
    let count = w.slot();
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
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
        ceilings.push(c);
        layers_of.push(layers);
    }
    if ceilings.is_empty() {
        return vec![];
    }
    w.set(count, ceilings.len() as f64);
    let mut out = Vec::new();
    for d in crate::ceilings3d::ceilings(&w.done()) {
        let c = ceilings[d.ceiling];
        let layers = layers_of[d.ceiling];
        let outline: Vec<RVec2> = d.ring.clone();
        for (layer_idx, z_bottom, z_top) in d.slabs {
            let Some(layers) = layers.filter(|_| layer_idx >= 0) else {
                out.push(RSlab { outline: outline.clone(), z_bottom, z_top, color: SLAB_RGB, ceiling_id: c.id.clone(), hatch: None, cut: None, monolith: None });
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
    for r in p.roofs.as_deref().unwrap_or(&[]) {
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

fn wall_reference(w: &Wall) -> Reference {
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
fn wall_openings(p: &Project, w: &Wall, with_recess: bool) -> Vec<OpeningIn> {
    let wr = wall_ref(p, w);
    let (zb, zt) = p.wall_vertical_extent(w);
    let mut out = Vec::new();
    for o in p.openings_of_wall(&w.id) {
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
            let layers = p.wall_type(w).map(|wt| {
                wt.layers
                    .iter()
                    .map(|l| {
                        let comp = p.component(&l.component_id);
                        let idx = comp.map(|c| {
                            let n = comp_index.len() as u32;
                            *comp_index.entry(c.id.as_str()).or_insert(n)
                        });
                        JoinLayer { thickness: l.thickness, component: idx, priority: comp.map_or(f64::NAN, |c| c.join_priority) }
                    })
                    .collect::<Vec<_>>()
            });
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
            Err(joins::JoinError::UnknownWallType(i)) => return Err(format!("Unbekannter Wandtyp: {}", walls[i].wall_type_id)),
            Err(joins::JoinError::UnknownComponent(i)) => {
                let bad = walls[i];
                let missing = p.wall_type(bad).and_then(|t| t.layers.iter().find(|l| p.component(&l.component_id).is_none())).map(|l| l.component_id.clone()).unwrap_or_default();
                return Err(format!("Unbekanntes Bauteil-Material: {missing}"));
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
            openings: wall_openings(p, wall, true),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beispielprojekt_hat_decken_und_gueltige_farben() {
        let p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        let slabs = emit_slabs(&p);
        assert!(!slabs.is_empty());
        assert!(slabs.iter().all(|s| s.z_top > s.z_bottom && s.outline.len() >= 3));
    }
}
