//! Rust-Kern von Dossier. Wächst etappenweise aus dem TS-Kern (`src/model`, `src/geometry`,
//! `src/plan`, …) heraus; jede umgestellte Funktion verschwindet dort (keine Doppelspur).
//! TS ruft den Kern synchron über `src/engine/coreWasm.ts` auf (einmal beim Start geladen).
//!
//! Datenübergabe: flache `f64`-Puffer (s. [`flat`]), kein JSON — schnell und ohne Serde-Kosten.

pub mod flat;
pub mod polygon_bool;

#[cfg(feature = "web")]
mod web;
