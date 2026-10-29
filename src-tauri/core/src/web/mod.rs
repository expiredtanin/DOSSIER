//! wasm-bindgen-Fassade (Feature "web"). Je Kern-Modul eine eigene Datei `web/<modul>.rs`
//! (parallele Arbeit ohne Konflikte). Eingaben/Ausgaben als flache `f64`-Puffer (s. `flat`).
//! Kaputte Eingaben ergeben ein leeres Ergebnis statt eines Panics (ein Panic legt das ganze
//! WASM-Modul lahm, [14]).

mod kernel2d;
mod polygon;
mod roof;
mod sun;
mod site_rules;
mod kennzahlen;
mod bulge;
mod stair;
mod room_area;
mod room_boundary;
mod polygon_holes;
mod plan_buf;
mod project_format;
mod gpu_compile;
mod delaunay;
mod document;
mod ops;
mod voids;
mod curves;
mod hatch;
mod skeleton;
mod plan_scene;
mod plan_pick;
mod snap;
mod plan_svg;
mod plan_dxf;
mod plan_print_svg;
mod layers;
mod pens;
mod layout_model;
mod parametric_walls;
mod reorder;
mod text_layout;
mod grips;
mod project_refs;
mod commands;
mod import;
mod cmd_create;
mod area_report;
mod rich_text;
mod geo_mesh;
mod opening_presets;

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}
