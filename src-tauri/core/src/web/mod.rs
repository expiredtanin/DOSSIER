//! wasm-bindgen-Fassade (Feature "web"). Je Kern-Modul eine eigene Datei `web/<modul>.rs`
//! (parallele Arbeit ohne Konflikte). Eingaben/Ausgaben als flache `f64`-Puffer (s. `flat`).
//! Kaputte Eingaben ergeben ein leeres Ergebnis statt eines Panics (ein Panic legt das ganze
//! WASM-Modul lahm, [14]).

mod kernel2d;
mod polygon;
mod roof;
mod sun;
mod site_rules;
mod auto_dimensions;
mod kennzahlen;
mod bulge;
mod stair;
mod joins;
mod room_area;
mod room_boundary;
mod polygon_holes;
mod drawing2d_3d;
mod wall_mesh_cut;
mod plan_buf;
mod project_format;
mod gpu_compile;
mod plan_stairs;
mod plan_walls;
mod plan_openings;
mod delaunay;
mod document;
mod mesh_section;
mod plan_elevation;
mod plan_misc;
mod plan_section;
mod voids;
mod curves;
mod hatch;

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Version des Kern-Moduls (für Diagnose/Startprotokoll).
#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
