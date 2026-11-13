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
use crate::joins::{self, JoinLayer, JoinWall, Reference, WallCuts};
use crate::jsmath::hypot2;
use crate::jsnum::atan2;
use crate::opening_geom::{self, WallRef};
use crate::style::{dominant_layer, dominant_layer_color, dominant_layer_hatch, WALL_RGB};
use crate::wall_bands::{self, BandIn, CeilingIn, FloorContext, OpeningIn, RoofIn, Termination};
use kernel2d::Vec2 as KVec;
use std::collections::HashMap;
use crate::jsmath::hypot;
use crate::jsnum::round;

// Teile der 3D-Ableitung ([162] aus einer Datei aufgeteilt).
mod ceilings;
pub(crate) mod bearing;
mod columns;
mod walls;
mod wall_body;
mod openings;
mod stairs;
mod roofs;
mod context;
mod drawings;
mod pick;
mod classes;
mod solids;

pub use ceilings::*;
pub use columns::*;
pub use walls::*;
pub use openings::*;
pub use stairs::*;
pub use roofs::*;
pub use context::*;
pub use drawings::*;
pub use pick::*;
pub use classes::*;
pub use solids::*;

#[cfg(test)]
mod tests;

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
    /// [180] Herkunft (Element) für den Klassen-Filter; nur im Kern.
    #[serde(skip)]
    pub owner: Owner,
}

/// [T4] Vorgabe-Knickwinkel (Grad) für glatt schattierte Import-Meshes.
pub const DEFAULT_CREASE_DEG: f64 = 30.0;


// ── Bündel ───────────────────────────────────────────────────────────────────


/// Das 3D-Modell in Teilen.
#[derive(Debug, Clone, Default, Serialize)]
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
    /// [115] Freie Körper (`extrudedSolids` ohne Abzugskörper) als Kern-Netze ([`emit_solids`]).
    pub solid_meshes: Vec<RMesh>,
}

/// `detail`: 0 grob, 1 mittel, 2 fein.
/// Ohne Klassen-Filter (nur Kontext nach dem Ebenen-Baum); gefiltert: [`parts_filtered`].
pub fn parts(p: &Project, layered: bool, detail: f64, for_section: bool) -> Result<Parts, String> {
    parts_filtered(p, layered, detail, for_section, &ClassFilter::none())
}
