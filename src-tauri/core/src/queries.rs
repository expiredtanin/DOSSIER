//! Abfragen auf dem Projekt-Dokument ([K4] S2): eine Tabelle von Name → Rechnung, die als JSON
//! antwortet. TS ruft sie über `ProjectDocument.query(name, args, text)`.

use crate::model::Project;
use crate::{export_schedule, flaechen, kennzahlen, model3d, room_program, site_rules, sun};

fn json<T: serde::Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

/// Führt die Abfrage `name` aus. `args`: Zahlen, `text`: ein Text (z. B. eine id).
pub fn run(p: &Project, name: &str, args: &[f64], text: &str) -> Result<String, String> {
    match (name, args.len()) {
        ("kennzahlen", _) => json(&kennzahlen::compute(p)),
        ("areaTable", _) => json(&flaechen::area_table(p)),
        ("ivhb", _) => {
            let opt: flaechen::IvhbOptions = if text.trim().is_empty() { Default::default() } else { serde_json::from_str(text).map_err(|e| format!("ivhb: {e}"))? };
            json(&flaechen::ivhb(p, &opt))
        }
        ("programCompare", _) => json(&room_program::compare(p)),
        ("programLayout", _) => {
            let opt: room_program::LayoutOptions = if text.trim().is_empty() { Default::default() } else { serde_json::from_str(text).map_err(|e| format!("programLayout: {e}"))? };
            json(&room_program::layout(p, &opt))
        }
        ("siteCheck", _) => json(&site_rules::check_project(p)),
        ("buildingFootprint", _) => json(&site_rules::building_footprint(p)),
        ("modelTop", _) => json(&site_rules::model_top(p)),
        ("shadows", 2) => json(&site_rules::area_out(&sun::shadow_polygons_project(p, sun::SunPosition { azimuth: args[0], elevation: args[1] }))),
        ("materialMaps", _) => json(&model3d::wall_material_color_maps(p)),
        ("slabs", _) => json(&model3d::emit_slabs(p)),
        ("columnMeshes", _) => json(&model3d::emit_columns(p)),
        ("walls", 1) => json(&model3d::emit_walls(p, args[0] != 0.0)?),
        ("openingMeshes", 1) => json(&model3d::emit_opening_meshes(p, args[0])),
        ("stairSlabs", 1) => json(&model3d::emit_stairs(p, args[0] != 0.0)),
        ("stairMeshes", _) => json(&model3d::emit_stair_meshes(p)),
        ("stairRailings", _) => json(&model3d::emit_stair_railings(p)),
        ("roofMeshes", _) => json(&model3d::emit_roofs(p, if text.is_empty() { None } else { Some(text) })?),
        ("roofCutLayers", _) => json(&model3d::emit_roof_cut_layers(p)?),
        ("scheduleRows", _) => json(&export_schedule::schedule_rows(p)),
        ("scheduleCsv", 1) => Ok(export_schedule::export_schedule_csv(p, text, args[0] != 0.0)),
        ("pickGeometry", _) => json(&model3d::pick_geometry(p)?),
        ("model3dParts", 3) => json(&model3d::parts(p, args[0] != 0.0, args[1], args[2] != 0.0)?),
        _ => Err(format!("Unbekannte Abfrage: {name}")),
    }
}

/// Abfragen mit binärer Antwort (Plan-Puffer v2, s. `plan_buf.rs`).
pub fn run_bin(p: &Project, name: &str, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    match (name, args.len()) {
        ("planDomains", 1) => crate::plan::domains::plan_domains_buf(p, &crate::plan::domains::PlanArgs::parse(args[0], text)?),
        _ => Err(format!("Unbekannte Abfrage: {name}")),
    }
}
