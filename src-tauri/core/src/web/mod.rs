//! wasm-bindgen-Fassade (Feature "web"). Je Kern-Modul eine eigene Datei `web/<modul>.rs`
//! (parallele Arbeit ohne Konflikte). Eingaben/Ausgaben als flache `f64`-Puffer (s. `flat`).
//! Kaputte Eingaben ergeben ein leeres Ergebnis statt eines Panics (ein Panic legt das ganze
//! WASM-Modul lahm, [14]).

pub mod kernel2d;
pub mod polygon;
pub mod roof;
pub mod sun;
pub mod site_rules;
pub mod kennzahlen;
pub mod bulge;
pub mod stair;
pub mod room_area;
pub mod room_boundary;
pub mod polygon_holes;
pub mod plan_buf;
pub mod project_format;
pub mod gpu_compile;
pub mod delaunay;
pub mod document;
pub mod ops;
pub mod voids;
pub mod curves;
pub mod hatch;
pub mod skeleton;
pub mod plan_scene;
pub mod plan_pick;
pub mod snap;
pub mod plan_svg;
pub mod plan_dxf;
pub mod plan_print_svg;
pub mod layers;
pub mod pens;
pub mod layout_model;
pub mod clash_broad;
pub mod parametric_walls;
pub mod reorder;
pub mod text_layout;
pub mod grips;
pub mod grip_drag;
pub mod competition;
pub mod project_refs;
pub mod commands;
pub mod import;
pub mod cmd_create;
pub mod area_report;
pub mod rich_text;
pub mod geo_mesh;
pub mod opening_presets;
pub mod furniture_lib;
pub mod solid_bool;
pub mod line_pattern;
pub mod fonts;

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}
