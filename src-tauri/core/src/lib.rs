//! Rust-Kern von Dossier. Wächst etappenweise aus dem TS-Kern (`src/model`, `src/geometry`,
//! `src/plan`, …) heraus; jede umgestellte Funktion verschwindet dort (keine Doppelspur).
//! TS ruft den Kern synchron über `src/engine/coreWasm.ts` auf (einmal beim Start geladen).
//!
//! Datenübergabe: flache `f64`-Puffer (s. [`flat`]), kein JSON — schnell und ohne Serde-Kosten.

pub mod flat;
pub mod polygon_bool;
pub mod roof;
pub mod roof_skeleton;
pub mod flat_read;
pub mod sun;
pub mod site_rules;
pub mod auto_dimensions;
pub mod kennzahlen;
pub mod bulge;
pub mod stair;
pub mod room_area;
pub mod room_boundary;
pub mod polygon_holes;

#[cfg(feature = "web")]
mod web;
