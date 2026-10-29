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
        ("modelJson", _) => crate::model::to_value_typed_only(p).map(|v| v.to_string()).map_err(|e| e.to_string()),
        ("model3dParts", 3) => json(&model3d::parts(p, args[0] != 0.0, args[1], args[2] != 0.0)?),
        // Gruppen ([K4] S3, `groups.rs`): `text` = Gruppen-id bzw. JSON der Argumente.
        ("groupMembership", _) => json(&crate::groups::transitive_membership(p, text)),
        ("containingGroup", _) => {
            let a: GroupArgs = serde_json::from_str(text).map_err(|e| format!("containingGroup: {e}"))?;
            json(&crate::groups::containing_group_id(p, &a.kind, &a.id, &a.path))
        }
        ("expandToGroups", _) => {
            let a: GroupArgs = serde_json::from_str(text).map_err(|e| format!("expandToGroups: {e}"))?;
            let (expanded, group_ids) = crate::groups::expand_to_groups(p, &a.raw, &a.path);
            json(&serde_json::json!({"expanded": expanded, "groupIds": group_ids}))
        }
        // Ebenen ([K4] S3, `layers.rs`): Kategorie-Codes der Auswahl (`text` = JSON der ids je Art).
        ("selectionCategoryCodes", _) => {
            let sel: crate::layers::SelectionMembers = serde_json::from_str(text).map_err(|e| format!("selectionCategoryCodes: {e}"))?;
            json(&crate::layers::selection_category_codes(p, &sel))
        }
        _ => Err(format!("Unbekannte Abfrage: {name}")),
    }
}

/// Argumente der Gruppen-Abfragen (`containingGroup`: kind/id/path, `expandToGroups`: raw/path).
#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct GroupArgs {
    kind: String,
    id: String,
    path: Vec<String>,
    raw: crate::groups::Membership,
}

/// Abfragen mit binärer Antwort (Plan-Puffer v2, s. `plan_buf.rs`).
pub fn run_bin(p: &Project, name: &str, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    use crate::plan::{domains, drawings};
    match (name, args.len()) {
        ("planDomains", 1) => crate::plan::domains::plan_domains_buf(p, &crate::plan::domains::PlanArgs::parse(args[0], text)?),
        // Export-Sammler ([K4], [B5], [C11]): flacher Puffer für `fileio` (Byte-Hülle `export_flat.rs`).
        ("ifcExportData", 4) => {
            let opt = crate::ifc_data::IfcOptions { now: args[0], ifc2x3: args[1] != 0.0, ebkph: args[2] != 0.0, layer_codes: args[3] != 0.0, iso: text.to_string() };
            crate::ifc_data::ifc_export_data(p, &opt).map(|f| f.to_bytes())
        }
        ("meshExportData", 3) => {
            let opt = crate::mesh_data::MeshOptions { opening_parts: args[0] != 0.0, context: args[1] != 0.0, by_level: args[2] != 0.0 };
            crate::mesh_data::mesh_export_data(p, &opt).map(|f| f.to_bytes())
        }
        // Gruppen der kompakten Linien-Unterlage (gleiche Argumente wie `planDomains`), als f64.
        ("drawingUnderlay", 1) => {
            let a = domains::PlanArgs::parse(args[0], text)?;
            Ok(drawings::underlay_groups(&domains::Ctx::new(p, &a)).iter().flat_map(|v| v.to_le_bytes()).collect())
        }
        // Linien der Zeichnungen `[Massstab, gedimmt, Index…]` (Index in `drawings2d`), mit Override-Regeln.
        ("drawingLines", n) if n >= 2 => {
            let mut a = domains::PlanArgs::parse(1.0, "{}")?;
            a.scale = args[0];
            let c = domains::Ctx::new(p, &a);
            buf_of(|sink| drawings::underlay_lines(&c, &args[2..], args[1] != 0.0, sink))
        }
        // Primitive einer Zeichnung (JSON in `text`, ohne Override-Regeln) beim Massstab `args[0]`.
        ("drawingPrims", 1) => {
            let d: crate::model::Drawing2D = serde_json::from_str(text).map_err(|e| format!("drawingPrims: {e}"))?;
            let a = domains::PlanArgs::parse(1.0, "{}")?;
            let c = domains::Ctx::new(p, &a);
            buf_of(|sink| drawings::emit(&c, &d, drawings::Attrs::of(&c, &d), &d.geom, false, args[0], sink, 0))
        }
        // Automatische Höhenkoten im Schnitt/in der Ansicht für das Ausmass `[minX, minY, maxX, maxY]`.
        ("levelMarkers", 4) => {
            let mut w = crate::plan_buf::Writer::new(false);
            w.group(&drawings::level_markers(p, [args[0], args[1], args[2], args[3]]));
            Ok(w.finish())
        }
        _ => Err(format!("Unbekannte Abfrage: {name}")),
    }
}

/// Plan-Puffer (eine Gruppe, ohne Inhalts-Hashes), in den `f` die Zeichnungs-Primitive schreibt.
fn buf_of(f: impl FnOnce(&mut crate::plan::drawings::Sink) -> Result<(), String>) -> Result<Vec<u8>, String> {
    use crate::plan::drawings::{Keep, Sink, Target};
    let mut w = crate::plan_buf::Writer::new(false);
    let start = w.begin_group();
    f(&mut Sink::new(Target::Buf(&mut w), Keep::All))?;
    w.end_group(start);
    Ok(w.finish())
}
