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

/// Abfragen auf der rohen Projekt-Wurzel (JSON-Baum, verlustfrei; Antwort JSON). `text`: Argument als Text/JSON.
pub fn run_root(root: &serde_json::Map<String, serde_json::Value>, name: &str, text: &str) -> Result<String, String> {
    match name {
        // Stiftsätze ([K4] S3, `pens.rs`): Ops statt Projekt-Kopien.
        "penRebakeOps" => json(&crate::pens::rebake_ops(root)),
        "penDeleteOps" => json(&crate::pens::delete_pen_ops(root, text)),
        "penSeedOps" => {
            let a: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("penSeedOps: {e}"))?;
            json(&crate::pens::seed_standard_ops(root, a["id"].as_str().unwrap_or(""), a["name"].as_str().unwrap_or("")))
        }
        // Layout-Blätter ([K4] S3, `layout_model.rs`): Seiten des Ordner-PDF (`text` = Ordner-id) und Titelblock
        // (`text` = JSON `{layout, master, today}`).
        "folderPdfPages" => json(
            &crate::layout_model::folder_pdf_pages(root, text)
                .iter()
                .map(|p| serde_json::json!({"layout": p.layout, "widthMm": p.width_mm, "heightMm": p.height_mm}))
                .collect::<Vec<_>>(),
        ),
        "layoutTitleBlock" => {
            let a: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("layoutTitleBlock: {e}"))?;
            json(&crate::layout_model::resolve_title_block(root, &a["layout"], &a["master"], a["today"].as_str().unwrap_or("")))
        }
        // Verschiebung des Projekts ([K4] S3, `geo_translate.rs`): `text` = JSON `[dx, dy]`; `translatePatch` liefert
        // die verschobenen Listen + Geo-Anker (für `{...project, ...patch}`), `translateOps` die Ops dazu.
        "translatePatch" | "translateOps" => {
            let [dx, dy]: [f64; 2] = serde_json::from_str(text).map_err(|e| format!("{name}: {e}"))?;
            if name == "translatePatch" {
                json(&crate::geo_translate::project_patch(root, dx, dy))
            } else {
                json(&crate::geo_translate::translate_ops(root, dx, dy))
            }
        }
        // Export-Scope „nur Auswahl" ([K4] S3, `selection_filter.rs`): `text` = JSON der ids je Art (`GroupMembership`).
        "selectionFilterPatch" => {
            let m: crate::groups::Membership = serde_json::from_str(text).map_err(|e| format!("selectionFilterPatch: {e}"))?;
            json(&crate::selection_filter::filter_patch(root, &m))
        }
        _ => Err(format!("Unbekannte Wurzel-Abfrage: {name}")),
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
            // Strichstärken nach Massstab wie im übrigen Plan.
            let post = Some(crate::plan::extras::Post { mono: false, lw: crate::plan::extras::line_weight_factor(p, args[0]) }).filter(crate::plan::extras::Post::active);
            buf_with(post, |sink| drawings::underlay_lines(&c, &args[2..], args[1] != 0.0, sink))
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
        // Grundriss-Unterlage unter Schnitt/Ansicht: `planDomains`-Argumente + `level`, `minY`.
        ("planUnderlay", 1) => {
            let a = domains::PlanArgs::parse(args[0], text)?;
            let (line, sign, min_y) = crate::plan::underlay::parse_args(text)?;
            let bytes = domains::plan_domains_buf(p, &a)?;
            let prims = crate::plan_buf::View::parse(&bytes).and_then(|v| v.prims()).ok_or("planUnderlay: Plan-Puffer unlesbar")?;
            Ok(crate::plan::underlay::underlay_buf(&crate::plan::underlay::underlay_primitives(line, sign, prims, min_y)))
        }
        ("sectionPlan", _) => crate::plan::section::section_plan_buf(p, args, text),
        ("elevationPlan", _) => crate::plan::elevation::elevation_plan_buf(p, args, text),
        _ => Err(format!("Unbekannte Abfrage: {name}")),
    }
}

/// Wie [`run_bin`] auf dem Dokument: `planDomains` mit den Plan-Caches des Dokuments (`plan/cache.rs`).
pub fn run_bin_doc(d: &mut crate::document::Document, name: &str, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    let model_err = |e: String| format!("Projekt passt nicht zum Kern-Modell: {e}");
    if name == "planDomains" && args.len() == 1 {
        let a = crate::plan::domains::PlanArgs::parse(args[0], text)?;
        // Schlüssel der Zeichnungs-Stücke, die der Aufrufer schon hat (`"have": [k…]`).
        let have: std::collections::HashSet<u64> = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|v| v.get("have").and_then(|h| h.as_array()).map(|h| h.iter().filter_map(|k| k.as_f64()).filter(|k| *k >= 0.0 && k.fract() == 0.0).map(|k| k as u64).collect()))
            .unwrap_or_default();
        let (p, revs, cache) = d.project_cached().map_err(model_err)?;
        return crate::plan::domains::plan_domains_cached(p, revs, cache, &a, &have).map(|o| o.encode());
    }
    if name == "planUnderlay" && args.len() == 1 {
        // Der Grundriss kommt aus den Plan-Caches (wie `generatePlan` desselben Geschosses).
        let a = crate::plan::domains::PlanArgs::parse(args[0], text)?;
        let (line, sign, min_y) = crate::plan::underlay::parse_args(text)?;
        let (p, revs, cache) = d.project_cached().map_err(model_err)?;
        let out = crate::plan::domains::plan_domains_cached(p, revs, cache, &a, &Default::default())?;
        let prims = crate::plan::underlay::plan_out_primitives(&out)?;
        return Ok(crate::plan::underlay::underlay_buf(&crate::plan::underlay::underlay_primitives(line, sign, prims, min_y)));
    }
    run_bin(d.project().map_err(model_err)?, name, args, text)
}

/// Plan-Puffer (eine Gruppe, ohne Inhalts-Hashes), in den `f` die Zeichnungs-Primitive schreibt.
fn buf_of(f: impl FnOnce(&mut crate::plan::drawings::Sink) -> Result<(), String>) -> Result<Vec<u8>, String> {
    buf_with(None, f)
}

/// Wie [`buf_of`] mit Nachbearbeitung (`extras::Post`).
fn buf_with(post: Option<crate::plan::extras::Post>, f: impl FnOnce(&mut crate::plan::drawings::Sink) -> Result<(), String>) -> Result<Vec<u8>, String> {
    use crate::plan::drawings::{Keep, Sink, Target};
    let mut w = crate::plan_buf::Writer::new(false);
    w.post = post;
    let start = w.begin_group();
    f(&mut Sink::new(Target::Buf(&mut w), Keep::All))?;
    w.end_group(start);
    Ok(w.finish())
}
