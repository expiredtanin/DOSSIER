//! Rust-Kern von Dossier. Wächst etappenweise aus dem TS-Kern (`src/model`, `src/geometry`,
//! `src/plan`, …) heraus; jede umgestellte Funktion verschwindet dort (keine Doppelspur).
//! TS ruft den Kern synchron über `src/engine/coreWasm.ts` auf (einmal beim Start geladen).
//!
//! Datenübergabe: flache `f64`-Puffer (s. [`flat`]), kein JSON — schnell und ohne Serde-Kosten.

pub mod export_schedule;
pub mod flat;
pub mod flat_write;
pub mod polygon_bool;
pub mod roof;
pub mod roof_skeleton;
pub mod flat_read;
pub mod sun;
pub mod site_rules;
pub mod auto_dimensions;
pub mod kennzahlen;
pub mod flaechen;
pub mod room_program;
pub mod bulge;
pub mod stair;
pub mod joins;
pub mod wall_bands;
pub mod room_area;
pub mod room_boundary;
pub mod polygon_holes;
pub mod js_fmt;
pub mod jsmath;
pub mod stairs3d;
pub mod mesh3d;
pub mod ceilings3d;
pub mod columns3d;
pub mod drawing2d_3d;
pub mod openings3d;
pub mod wall_mesh_cut;
pub mod jsnum;
pub mod hatch;
pub mod hatch_flat;
pub mod plan;
pub mod plan_buf;
pub mod project_format;
pub mod queries;
pub mod gpu_compile;
pub mod plan_stairs;
pub mod plan_walls;
pub mod opening_geom;
pub mod plan_openings;
pub mod delaunay;
pub mod document;
pub mod ops;
pub mod mesh_section;
pub mod model;
pub mod model3d;
pub mod style;
pub mod plan_elevation;
pub mod plan_misc;
pub mod plan_section;
pub mod voids;
pub mod curves;
pub mod skeleton;
pub mod plan_parts;
pub mod plan_scene;
pub mod plan_pick;
pub mod snap;

#[cfg(feature = "web")]
mod web;
