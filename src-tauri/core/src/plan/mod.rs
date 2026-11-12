//! Plan-Erzeugung auf dem Projekt-Dokument ([K3d]/[K4]): Rust-Gegenstück zu `src/plan/generatePlan.ts`
//! und `generatePlan/*.ts`.

pub mod prim;
pub mod style;
pub mod overrides;
pub mod domains;
pub mod walls;
pub mod stairs;
pub mod context;
pub mod drawings;
pub mod section;
pub mod elevation;
pub mod grid_view;
pub mod cache;
pub mod extras;
pub mod underlay;
pub mod trace;
pub mod view_range;
pub mod stair_symbol;
pub mod buf;
pub mod misc;
pub mod section_bands;
pub mod dxf;
pub mod svg;
pub mod text;
pub mod wall_poche;
pub mod print_svg;
pub mod scene;
pub mod openings;
pub mod parts;
pub mod elevation_geom;
pub mod pick;
pub mod sketch;
pub mod ceiling_plan;
pub mod line_ends;
pub mod line_pattern;
pub mod stamp_place;
pub mod floor_finish;
pub mod model_view;
pub mod trees;
pub mod cameras;
pub mod mesh_plan;
pub mod situation;
pub mod arc_fit;
pub(crate) mod seams;
pub(crate) mod wall_columns;
#[cfg(test)]
pub(crate) mod wall_join_tests;
#[cfg(test)]
mod wall_merge_tests;
#[cfg(test)]
mod hatch_dir_tests;
#[cfg(test)]
mod hatch_fill_tests;
#[cfg(test)]
mod arc_output_tests;
#[cfg(test)]
mod derived_class_tests;
#[cfg(test)]
mod autodim_text_tests;
