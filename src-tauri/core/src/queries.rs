//! Abfragen auf dem Projekt-Dokument ([K4] S2): eine Tabelle von Name → Rechnung, die als JSON
//! antwortet. TS ruft sie über `ProjectDocument.query(name, args, text)`.

use crate::model::Project;
use crate::{export_schedule, flaechen, kennzahlen, model3d, room_program, site_rules, sun};

fn json<T: serde::Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

/// Wie [`run`] auf dem Dokument: das 3D-Modell (`model3dParts` ohne Explosion) über den Cache des
/// Dokuments ([58], `model3d_cache`) — gleiches JSON wie [`run`].
pub fn run_doc(d: &mut crate::document::Document, name: &str, args: &[f64], text: &str) -> Result<String, String> {
    let explode = args.get(4).copied().is_some_and(|g| g.is_finite() && g > 0.0);
    // `model3dPartsDelta`: wie `model3dParts` (ohne Explosion), `args[5]` = Laufnummer der letzten Antwort
    // des Aufrufers (0 = alles), Antwort als Änderung (`model3d_cache::write_delta`).
    let delta = (name == "model3dPartsDelta").then(|| args.get(5).copied().filter(|m| m.is_finite() && *m >= 0.0).unwrap_or(0.0) as u64);
    // [173] Mit Modelldarstellung (`text`) ohne den Cache (eigene Teile, s. `model3d_mv`).
    // [272] Mit Varianten ohne den Cache (die Teile hängen an der Kombination).
    // Die Änderungs-Abfrage bleibt beim Cache (die Hülle fragt bei Varianten `model3dParts`, `toWalls3d.ts`).
    let options = name == "model3dParts" && d.project().is_ok_and(crate::design_options::active);
    if (name == "model3dParts" || delta.is_some()) && args.len() >= 3 && !explode && model3d_mv_id(text).is_none() && !text.contains("\"renovation\"") && !options {
        let voids = args.get(3).is_some_and(|v| *v != 0.0);
        // [214] Ohne Abzugskörper braucht es die Wände/Decken nicht als Werte (spart das Kopieren): leere `voidMeshes`.
        if voids && crate::plan::extras::void_prisms(d.project()?).is_empty() {
            let out = d.model3d_parts_with(args[0] != 0.0, args[1], args[2] != 0.0, false, delta, text)?;
            return with_void_meshes(out.json, &crate::solid_specs::VoidMeshes::default());
        }
        let out = d.model3d_parts_with(args[0] != 0.0, args[1], args[2] != 0.0, voids, delta, text)?;
        if voids {
            let p = d.project()?;
            let cuts = crate::solid_specs::void_cuts(p, &out.parts.walls, &out.parts.slabs);
            return with_void_meshes(out.json, &crate::solid_specs::void_meshes(&cuts, &out.parts.walls, &out.parts.slabs));
        }
        return Ok(out.json);
    }
    let p = d.project().map_err(|e| format!("Projekt passt nicht zum Kern-Modell: {e}"))?;
    run(p, name, args, text)
}

/// Das JSON-Objekt der Teile um `voidMeshes` ergänzen (hinten angefügt statt über `serde_json::Value`).
fn with_void_meshes(mut parts: String, cuts: &crate::solid_specs::VoidMeshes) -> Result<String, String> {
    if parts.pop() != Some('}') {
        return Err("model3dParts: kein JSON-Objekt".into());
    }
    parts.push_str(",\"voidMeshes\":");
    parts.push_str(&json(cuts)?);
    parts.push('}');
    Ok(parts)
}

/// [173] Modelldarstellung des 3D-Modells: `text` = `{"modelView": id}` (sonst keine).
fn model3d_mv_id(text: &str) -> Option<String> {
    let t = text.trim();
    if !t.starts_with('{') {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(t).ok()?.get("modelView")?.as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// [173] 3D nach der Modelldarstellung: Öffnungsdetail nach ihrer Basis (sonst `detail`, 0 grob … 2 fein),
/// Handlauf aus, wenn sie ihn ausschaltet. (Detailcode, Handlauf)
fn model3d_mv(p: &Project, text: &str, detail: f64) -> (f64, bool) {
    let Some(id) = model3d_mv_id(text) else { return (detail, true) };
    let base = crate::plan::model_view::base_of(p, &id).map_or(detail, |d| match d {
        crate::plan::style::Detail::Grob => 0.0,
        crate::plan::style::Detail::Mittel => 1.0,
        crate::plan::style::Detail::Fein => 2.0,
    });
    let o = crate::plan::model_view::for_view(p, Some(&id), crate::plan::style::Detail::Fein, 50.0);
    (base, o.stair.handrail.is_some())
}

/// [271] Projekt im Umbau-Zustand des Texts (`renovation::view_from_text`), [272] in der Variantenkombination des
/// Texts (`designOptions`, sonst die Hauptvarianten), sonst unverändert.
fn renovation_state<'a>(p: &'a Project, text: &str) -> std::borrow::Cow<'a, Project> {
    crate::renovation::project_for_text(p, text)
}

/// [272] Projekt in der Kombination eines JSON-Texts (`designOptions`, Umbaufilter), sonst in den Hauptvarianten;
/// für Abfragen, deren Text keine Darstellung ist (dann zählt nur ein JSON-Objekt).
fn options_state<'a>(p: &'a Project, text: &str) -> std::borrow::Cow<'a, Project> {
    crate::renovation::project_for_text(p, if text.trim_start().starts_with('{') { text } else { "" })
}

/// Führt die Abfrage `name` aus. `args`: Zahlen, `text`: ein Text (z. B. eine id).
pub fn run(p: &Project, name: &str, args: &[f64], text: &str) -> Result<String, String> {
    match (name, args.len()) {
        // [271] Mit Umbau-Zustand (`text` = Filter-Id, z. B. „bestand“ oder „endzustand“; leer = alles).
        ("kennzahlen", _) => json(&kennzahlen::compute(&renovation_state(p, text))),
        ("areaTable", _) => json(&flaechen::area_table(&renovation_state(p, text))),
        // [278] Wohnungsspiegel (Nutzungseinheiten); mit `text` = `{"head": [...]}` als CSV.
        ("unitSchedule", _) => {
            let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
            let sched = crate::unit_schedule::unit_schedule(&options_state(p, text));
            match v.get("head").and_then(|h| h.as_array()) {
                Some(h) => json(&crate::unit_schedule::schedule_csv(&sched, &h.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())),
                None => json(&sched),
            }
        }
        // [271] Umbaufilter (eingebaute und eigene) für die Oberfläche.
        ("renovationFilters", _) => json(&crate::renovation::filter_list(p)),
        // [275] Aufgelöste Umbau-Farben (Vorgabe, Projekt, Etappen) für Muster in der Oberfläche.
        ("renovationStyles", _) => Ok(crate::renovation::styles_json(p).to_string()),
        // [274] Typ-Paar Bestand → Sanierungstyp (Editor, Vorschau) bzw. alle Paare mit Zählern (Umbau-Panel).
        ("renovationPair", _) => json(&crate::renovation::build_up::pair_json(p, text)),
        ("renovationPairs", _) => json(&crate::renovation::build_up::pairs_json(p)),
        // [209] Kostenschätzung grob; `costDefaults` mit Text „gf“/„gv“ = Beispielwerte der Methode.
        ("costEstimate", _) => json(&crate::kosten::estimate(&renovation_state(p, text))),
        // [272] Varianten: Sätze mit Varianten und Zahl der Elemente; Vergleich der Kennzahlen/Kosten je Kombination
        // (`text` = `{"renovation", "renovationPhase"}` oder leer); CSV mit Spaltenköpfen (`text` = `{"head": [...]}`).
        ("designOptionInfo", _) => Ok(crate::design_options::info(p).to_string()),
        ("designOptionCompare", _) => {
            let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
            let s = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty());
            let rows = crate::design_options::compare_scope(p, s("renovation"), s("renovationPhase"), v.get("all").and_then(|x| x.as_bool()).unwrap_or(false));
            match v.get("head").and_then(|h| h.as_array()) {
                Some(h) => json(&crate::design_options::compare_csv(&rows, &h.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())),
                None => json(&rows),
            }
        }
        ("costDefaults", _) => json(&crate::kosten::default_estimate(if text.trim() == "gf" { crate::model::CostMethod::Gf } else { crate::model::CostMethod::Gv })),
        ("ivhb", _) => {
            let opt: flaechen::IvhbOptions = if text.trim().is_empty() { Default::default() } else { serde_json::from_str(text).map_err(|e| format!("ivhb: {e}"))? };
            json(&flaechen::ivhb(&options_state(p, text), &opt))
        }
        // [255] Baurecht-Nachweis (Vorgaben der Parzelle gegen Kennzahlen); Text = `IvhbOptions` als JSON.
        ("siteProof", _) => {
            let opt: flaechen::IvhbOptions = if text.trim().is_empty() { Default::default() } else { serde_json::from_str(text).map_err(|e| format!("siteProof: {e}"))? };
            json(&crate::site_proof::site_proof(&options_state(p, text), &opt))
        }
        ("programCompare", _) => json(&room_program::compare(&options_state(p, text))),
        ("programLayout", _) => {
            let opt: room_program::LayoutOptions = if text.trim().is_empty() { Default::default() } else { serde_json::from_str(text).map_err(|e| format!("programLayout: {e}"))? };
            json(&room_program::layout(p, &opt))
        }
        ("siteCheck", _) => json(&site_rules::check_project(&options_state(p, text))),
        // [215] Cycles-Szene (XML + Bilddateien) aus dem Projekt; Text = `CyclesOptions` als JSON (camelCase).
        ("cyclesScene", _) => {
            let o: crate::cycles_scene::CyclesOptions = if text.trim().is_empty() { Default::default() } else { serde_json::from_str(text).map_err(|e| format!("cyclesScene: {e}"))? };
            // [271] Umbau-Farben nur auf Wunsch (`renovationColors`); Ausgeblendetes (Umbaufilter, Variante) fehlt immer.
            let styled: std::collections::HashMap<String, String> = if o.renovation_colors {
                crate::renovation::view_from_text(p, text).map(|v| {
                    let r = v.resolve(p);
                    r.faces.into_iter().chain(r.styled).map(|(k, s)| (k, s.fill)).collect()
                }).unwrap_or_default()
            } else {
                Default::default()
            };
            json(&crate::cycles_scene::cycles_scene_styled(&options_state(p, text), &o, &styled)?)
        }
        ("dormerStatus", _) => json(&crate::dormer::status(p)),
        ("excavationQuantities", _) => json(&crate::excavation::quantities(p)),
        ("buildingFootprint", _) => json(&site_rules::building_footprint(&options_state(p, text))),
        ("modelTop", _) => json(&site_rules::model_top(&options_state(p, text))),
        // [142] Drittes Argument: Schnitthöhe des Grundrisses (Decken/Dächer darunter fangen den Schatten).
        ("shadows", 2 | 3) => json(&site_rules::area_out(&sun::shadow_polygons_project(&options_state(p, text), sun::SunPosition { azimuth: args[0], elevation: args[1] }, args.get(2).copied().filter(|c| c.is_finite())))),
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
        ("scheduleRows", _) => json(&export_schedule::schedule_rows(&options_state(p, text))),
        ("openingSchedule", _) => json(&crate::opening_schedule::opening_schedule(&options_state(p, text))),
        ("elementSchedule", _) => json(&crate::u_value::element_schedule(&options_state(p, text))),
        ("roomBook", _) => json(&crate::room_book::room_book(&options_state(p, text))),
        ("sheetTables", _) => Ok(crate::sheet_table::query(p, text).to_string()),
        ("sheetTableCatalog", _) => Ok(crate::sheet_table::catalog_json().to_string()),
        ("presentationSheet", _) => Ok(crate::presentation_sheet::query(p, text)?.to_string()),
        ("uValue", _) => json(&crate::u_value::query(p, text)),
        // [33] Schichtfunktion je Bauteil, aus dem Baustoff abgeleitet (Vorgabe im Aufbau-Editor, wenn `Layer.function` fehlt).
        ("componentLayerFunctions", _) => json(&crate::plan::overrides::component_functions(p)),
        ("surfaceOpening", _) => json(&crate::opening_shape::surface_opening_info(p, text)),
        ("openingPreview", _) => json(&crate::opening_preview::opening_preview(p, text)),
        ("scheduleCsv", 1) => Ok(export_schedule::export_schedule_csv(p, text, args[0] != 0.0)),
        // `args[0]`: Explosionsabstand ([65], fehlt/0 = aus).
        // Versatz je Geschoss-id ([65]; `args[0]` = Abstand, ≤ 0 = leer): 3D-Griffe und Arbeitsebene.
        ("explodeOffsets", _) => json(&crate::explode3d::floor_offsets(p, args.first().copied().unwrap_or(0.0))),
        // [180] Ohne die Elemente ausgeblendeter Klassen (`text` = `{"hide": [codes]}`, s. `model3d::ClassFilter`).
        ("pickGeometry", _) => {
            // [272] Elemente anderer Varianten nicht picken.
            let q = options_state(p, text);
            let p = q.as_ref();
            let mut g = crate::explode3d::pick_geometry(p, args.first().copied().unwrap_or(0.0))?;
            model3d::ClassFilter::from_text(p, text).retain_pick(&mut g);
            json(&g)
        }
        // [115] Kennwerte eines freien Körpers (`text` = id) aus seinem Kern-Netz; `null` ohne Netz.
        ("solidProps", _) => json(&crate::solid_mesh::solid_props(p, text)),
        ("modelJson", _) => crate::model::to_value_typed_only(p).map(|v| v.to_string()).map_err(|e| e.to_string()),
        // Mit Abzugskörpern (`args[3]` ≠ 0) zusätzlich `voidMeshes`: die getroffenen Wände/Decken als
        // Netze „Bauteil − Körper" (`solid_specs::void_meshes`, Manifold).
        // `args[4]`: Explosionsabstand ([65], `explode3d.rs`; Körper und Abzugskörper wandern mit dem Geschoss).
        // [180] Ohne die Teile ausgeblendeter Klassen (`text` = `{"hide": [codes], "modelView": …}`).
        ("model3dParts", n) if n >= 3 => {
            // [272] Explosion in der Kombination des Texts (sonst Hauptvarianten); ohne Explosion unten mit Umbaufilter.
            let opt_p = options_state(p, text);
            let explode = args.get(4).copied().filter(|g| g.is_finite() && *g > 0.0);
            let filter = model3d::ClassFilter::from_text(p, text);
            if let Some(gap) = explode {
                let p = opt_p.as_ref();
                let mut parts = crate::explode3d::parts_filtered(p, args[0] != 0.0, args[1], args[2] != 0.0, gap, &filter)?;
                // [271] Umbau-Farben wie im 3D-Fenster ohne Explosion (Ausgeblendetes fehlt schon über `opt_p`).
                if let Some(r) = crate::renovation::view_from_text(p, text).map(|v| v.resolve(p)) {
                    crate::renovation::color_parts(p, &mut parts, &r);
                }
                let mut v = serde_json::to_value(&parts).map_err(|e| e.to_string())?;
                if args.get(3).is_some_and(|v| *v != 0.0) {
                    let cuts = crate::explode3d::void_cuts(p, &parts, gap);
                    v["voidMeshes"] = serde_json::to_value(crate::solid_specs::void_meshes(&cuts, &parts.walls, &parts.slabs)).map_err(|e| e.to_string())?;
                }
                return Ok(v.to_string());
            }
            // [271] Umbaufilter (`text` = `{"renovation": …, "renovationPhase": …}`): Ausgeblendetes fehlt, Farben je Status.
            // [272] Dazu die Bearbeitungsvariante des 3D-Fensters (`designOptionEdit`, grau ausserhalb).
            let ren = crate::renovation::screen_view_from_text(p, text).map(|v| v.resolve(p));
            let filtered = ren.as_ref().and_then(|r| r.project(p));
            let p = filtered.as_ref().unwrap_or(p);
            let (detail, rails) = model3d_mv(p, text, args[1]);
            let mut parts = model3d::parts_filtered(p, args[0] != 0.0, detail, args[2] != 0.0, &filter)?;
            if let Some(r) = &ren {
                crate::renovation::color_parts(p, &mut parts, r);
            }
            if !rails {
                parts.stair_railings.clear();
            }
            if args.get(3).is_some_and(|v| *v != 0.0) {
                let cuts = crate::solid_specs::void_cuts(p, &parts.walls, &parts.slabs);
                return with_void_meshes(json(&parts)?, &crate::solid_specs::void_meshes(&cuts, &parts.walls, &parts.slabs));
            }
            json(&parts)
        }
        // STEP-Export: alle Bauteile als truck-Spezifikationen (`solid_specs::project_solid_specs`).
        ("projectSolidSpecs", _) => json(&crate::solid_specs::project_solid_specs(&options_state(p, text))?),
        // [33] Von einer Regel „Ausblenden“ ausgeblendete Elemente (ids, sortiert): `args[0]` = Massstab 1:N
        // (fehlt/NaN = ohne Massstab-Kriterium), `text` = Darstellung ("plan", "section", "elevation").
        ("hiddenElements", _) => {
            let view = match text {
                "section" => "section",
                "elevation" => "elevation",
                _ => "plan",
            };
            let scale = args.first().copied().filter(|s| s.is_finite() && *s > 0.0);
            let v = crate::plan::overrides::RuleView { scale, on: None, view: Some(view) };
            let mut ids: Vec<String> = crate::plan::overrides::hidden_elements(p, v).into_iter().collect();
            ids.sort_unstable();
            json(&ids)
        }
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

/// Wie [`run_root`] auf dem Dokument; Befehle (`cmdOps`, [K4] S3, `commands.rs`: `text` = JSON `{cmd, …}`,
/// Antwort `{ops}`) lesen dazu die typisierte Sicht ([124]).
pub fn run_root_doc(d: &mut crate::document::Document, name: &str, text: &str) -> Result<String, String> {
    if name == "cmdOps" {
        let (p, lk) = d.project_lookup()?;
        return crate::commands::ops_json(lk.root, p, text);
    }
    // [202] Griffe mit Dokument (`grips::run_doc`: Treppe nimmt ihr Deckenloch mit).
    if name == "gripOps" {
        let req: crate::grips::Request = serde_json::from_str(text).map_err(|e| format!("gripOps: {e}"))?;
        return Ok(crate::grips::result_json(&crate::grips::run_doc(d, &req)?));
    }
    run_root(&d.lookup(), name, text)
}

/// Abfragen auf der rohen Projekt-Wurzel (JSON-Baum, verlustfrei; Antwort JSON). `text`: Argument als Text/JSON.
/// Elemente per id sucht `lk` (im Dokument über dessen Positions-Index).
pub fn run_root(lk: &crate::document::Lookup, name: &str, text: &str) -> Result<String, String> {
    let root = lk.root;
    match name {
        // Stiftsätze ([K4] S3, `pens.rs`): Ops statt Projekt-Kopien.
        "penRebakeOps" => json(&crate::pens::rebake_ops(root)),
        // [272] Varianten (`design_options.rs`): `text` = JSON `{set, option?, sel?, stamp?}`; Antwort Ops (ein Undo-Schritt).
        "designOptionAcceptOps" | "designOptionDeleteOps" | "designOptionAssignOps" | "designOptionCopyOps" => {
            let a: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("{name}: {e}"))?;
            let s = |k: &str| a.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let (set, option) = (s("set"), s("option"));
            let target = (!set.is_empty() && !option.is_empty()).then_some((set.as_str(), option.as_str()));
            let sel: crate::design_options::Selection = a.get("sel").and_then(|x| serde_json::from_value(x.clone()).ok()).unwrap_or_default();
            json(&match name {
                "designOptionAcceptOps" => crate::design_options::accept_ops(root, &set, &option),
                "designOptionDeleteOps" if option.is_empty() => crate::design_options::delete_set_ops(root, &set),
                "designOptionDeleteOps" => crate::design_options::delete_option_ops(root, &set, &option),
                "designOptionAssignOps" => crate::design_options::assign_ops(root, &sel, target),
                _ => crate::design_options::copy_ops(root, &sel, target, &s("stamp")),
            })
        }
        // [272] Benannte Kombination löschen (`text` = `{"id"}`): samt Verweisen an Ebenen, Vorlagen, Ausschnitten, Viewports.
        "designOptionCombinationDeleteOps" => {
            let a: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("{name}: {e}"))?;
            json(&crate::design_options::delete_combination_ops(root, a.get("id").and_then(|x| x.as_str()).unwrap_or("")))
        }
        "penDeleteOps" => json(&crate::pens::delete_pen_ops(root, text)),
        // Standard-Bibliothek ([100]–[102], `standards.rs`): fehlende Standard-Ressourcen als Ops.
        "standardsMergeOps" => json(&crate::standards::merge_ops_in(root, crate::standards::Lang::parse(text))),
        // „Standards aktualisieren" ([109]): Abweichungen vom heutigen Standard / Ops für die gewählten (`text` = JSON-Liste `"<Liste>:<id>"`).
        "standardsUpdatePlan" => json(&crate::standards::update_plan(root, crate::standards::Lang::parse(text))),
        "standardsUpdateOps" => {
            // [264] `text` = `{"selected": [...], "lang": "de"|"en"}` (Sprache der anzuhängenden Standards).
            let a: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("standardsUpdateOps: {e}"))?;
            let sel: Vec<String> = serde_json::from_value(a["selected"].clone()).map_err(|e| format!("standardsUpdateOps: {e}"))?;
            json(&crate::standards::update_ops(root, &sel, crate::standards::Lang::parse(a["lang"].as_str().unwrap_or(""))))
        }
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
        // Griff-Änderungen ([K4] S3, `grips.rs`): `text` = JSON der Anfrage; Antwort `{ops, notice}` (ohne Commit).
        // Befehle ([K4] S3, `commands.rs`): `text` = JSON `{cmd, …}`; Antwort `{ops}`.
        "gripOps" => {
            let req: crate::grips::Request = serde_json::from_str(text).map_err(|e| format!("gripOps: {e}"))?;
            Ok(crate::grips::result_json(&crate::grips::run(lk, &req)?))
        }
        // Objekt-Info der Auswahl ([K4] S3, `selection_info.rs`): `text` = JSON der gewählten ids je Art; Antwort
        // `Selection` (TS) oder null, Zahlen mit Nicht-endlich-Marken.
        "selectionInfo" => {
            let a: crate::selection_info::SelArgs = serde_json::from_str(text).map_err(|e| format!("selectionInfo: {e}"))?;
            crate::selection_info::derive(lk, &a).map(crate::selection_info::J::into_string)
        }
        // Bounding-Boxen von Zeichnungen (Ausrichten/Verteilen): `text` = JSON der ids.
        "drawingBBoxes" => {
            let ids: Vec<String> = serde_json::from_str(text).map_err(|e| format!("drawingBBoxes: {e}"))?;
            Ok(crate::selection_info::drawing_bboxes(root, &ids).into_string())
        }
        // UK/OK von Wänden und Decken (3D-Griffe): `text` = `{walls: […], ceilings: […]}` (ganze Elemente).
        "verticalExtents" => {
            let a: crate::selection_info::ExtentArgs = serde_json::from_str(text).map_err(|e| format!("verticalExtents: {e}"))?;
            Ok(crate::selection_info::vertical_extents(root, &a).into_string())
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

/// Abfragen mit binärer Antwort (Plan-Puffer v2, s. `plan/buf.rs`).
pub fn run_bin(p: &Project, name: &str, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    use crate::plan::{domains, drawings};
    match (name, args.len()) {
        ("planDomains", 1) => crate::plan::domains::plan_domains_buf(p, &crate::plan::domains::PlanArgs::parse_in(p, args[0], text)?),
        // Export-Sammler ([K4], [B5], [C11]): flacher Puffer für `fileio` (Byte-Hülle `export_flat.rs`).
        ("ifcExportData", 4 | 5) => {
            // 5. Argument [259]: Kontext (Gelände, Nachbarn) mitgeben.
            // [272] `text` = Zeitstempel (ISO) oder `{"iso", "designOptions", "renovation"}`: Kombination der Ansicht.
            let json_text = text.trim_start().starts_with('{');
            let iso = if json_text { serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("iso").and_then(|x| x.as_str()).map(String::from)).unwrap_or_default() } else { text.to_string() };
            let q = options_state(p, text);
            let opt = crate::ifc_data::IfcOptions { now: args[0], ifc2x3: args[1] != 0.0, ebkph: args[2] != 0.0, layer_codes: args[3] != 0.0, context: args.get(4).is_some_and(|v| *v != 0.0), iso };
            crate::ifc_data::ifc_export_data(&q, &opt).map(|f| f.to_bytes())
        }
        ("meshExportData", 3 | 4) => {
            // 4. Argument [227]: Baugruben weglassen (hinterfüllt).
            let opt = crate::mesh_data::MeshOptions { opening_parts: args[0] != 0.0, context: args[1] != 0.0, by_level: args[2] != 0.0, backfilled: args.get(3).is_some_and(|v| *v != 0.0) };
            crate::mesh_data::mesh_export_data(&options_state(p, text), &opt).map(|f| f.to_bytes())
        }
        // Gruppen der kompakten Linien-Unterlage (gleiche Argumente wie `planDomains`), als f64.
        ("drawingUnderlay", 1) => {
            let a = domains::PlanArgs::parse(args[0], text)?;
            Ok(drawings::underlay_groups(&domains::Ctx::new(p, &a)).iter().flat_map(|v| v.to_le_bytes()).collect())
        }
        // Linien der Zeichnungen `[Massstab, Schalter, Index…]` (Index in `drawings2d`), mit Override-Regeln;
        // Schalter: Bit 1 = gedimmt, Bit 2 = Schwarz-Weiss ([140]).
        ("drawingLines", n) if n >= 2 => {
            let mut a = domains::PlanArgs::parse(1.0, "{}")?;
            a.scale = args[0];
            let c = domains::Ctx::new(p, &a);
            let flags = if args[1].is_finite() && args[1] >= 0.0 { args[1] as u32 } else { 0 };
            // Strichstärken nach Massstab wie im übrigen Plan.
            let post = Some(crate::plan::extras::Post { mono: flags & 2 != 0, lw: crate::plan::extras::line_weight_factor(p, args[0]), sketch: 0.0, keep: Default::default() }).filter(crate::plan::extras::Post::active);
            buf_with(post, |sink| drawings::underlay_lines(&c, &args[2..], flags & 1 != 0, sink))
        }
        // Primitive einer Zeichnung (JSON in `text`, ohne Override-Regeln) beim Massstab `args[0]`.
        ("drawingPrims", 1) => {
            let d: crate::model::Drawing2D = serde_json::from_str(text).map_err(|e| format!("drawingPrims: {e}"))?;
            let a = domains::PlanArgs::parse(1.0, "{}")?;
            let c = domains::Ctx::new(p, &a);
            buf_of(|sink| drawings::emit(&c, &d, drawings::Attrs::of(&c, &d), &d.geom, false, args[0], sink, 0))
        }
        // Automatische Höhenkoten im Schnitt/in der Ansicht für das Ausmass `[minX, minY, maxX, maxY]`, [208] dazu
        // die Massstabszahl (fehlt = 1:100).
        ("levelMarkers", 4 | 5) => {
            let mut w = crate::plan::buf::Writer::new(false);
            w.group(&drawings::level_markers(p, [args[0], args[1], args[2], args[3]], args.get(4).copied().unwrap_or(100.0)));
            Ok(w.finish())
        }
        // Umriss-Linien der 3D-Auswahl (`highlight3d.rs`): `text` = JSON der ids je Art + `rgb`; Antwort f32-LE.
        ("selectionHighlight", _) => {
            let a: crate::highlight3d::Args = serde_json::from_str(text).map_err(|e| format!("selectionHighlight: {e}"))?;
            Ok(crate::highlight3d::selection_highlight_lines(p, &a)?.iter().flat_map(|v| v.to_le_bytes()).collect())
        }
        // [205] Pausfolie: Teil-Abfragen der Quelle, ausgerichtet, verschoben/gedreht, gefärbt (`plan/trace.rs`).
        ("tracePlan", _) => {
            let a = crate::plan::trace::TraceArgs::parse(text)?;
            let mut prims = Vec::new();
            for part in &a.parts {
                prims.extend(bin_prims(&run_bin(p, &part.name, &part.args, &part.text)?)?);
            }
            Ok(crate::plan::trace::trace_buf(&crate::plan::trace::trace_primitives(p, &a, prims)))
        }
        ("sectionPlan", _) => crate::plan::section::section_plan_buf(p, args, text),
        ("elevationPlan", _) => crate::plan::elevation::elevation_plan_buf(p, args, text),
        // [266] 3D-Dokument: Vektor-Axonometrie/-Perspektive mit verdeckten Kanten (`plan/axo.rs`).
        ("axoPlan", _) => crate::plan::axo::axo_plan_buf(p, args, text),
        _ => Err(format!("Unbekannte Abfrage: {name}")),
    }
}

/// Wie [`run_bin`] auf dem Dokument: `planDomains` mit den Plan-Caches des Dokuments (`plan/cache.rs`).
pub fn run_bin_doc(d: &mut crate::document::Document, name: &str, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    let model_err = |e: String| format!("Projekt passt nicht zum Kern-Modell: {e}");
    if name == "planDomains" && args.len() == 1 {
        let mut a = crate::plan::domains::PlanArgs::parse(args[0], text)?;
        // Schlüssel der Zeichnungs-Stücke, die der Aufrufer schon hat (`"have": [k…]`).
        let have: std::collections::HashSet<u64> = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|v| v.get("have").and_then(|h| h.as_array()).map(|h| h.iter().filter_map(|k| k.as_f64()).filter(|k| *k >= 0.0 && k.fract() == 0.0).map(|k| k as u64).collect()))
            .unwrap_or_default();
        let (p, revs, cache) = d.project_cached().map_err(model_err)?;
        a.apply_model_view(p);
        return crate::plan::domains::plan_domains_cached(p, revs, cache, &a, &have).map(|o| o.encode());
    }
    if name == "tracePlan" {
        // [205] Teil-Abfragen auf dem Dokument (Grundrisse aus den Plan-Caches wie `generatePlan`).
        let a = crate::plan::trace::TraceArgs::parse(text)?;
        let mut prims = Vec::new();
        for part in &a.parts {
            if part.name == "planDomains" && part.args.len() == 1 {
                let mut pa = crate::plan::domains::PlanArgs::parse(part.args[0], &part.text)?;
                let (p, revs, cache) = d.project_cached().map_err(model_err)?;
                pa.apply_model_view(p);
                let out = crate::plan::domains::plan_domains_cached(p, revs, cache, &pa, &Default::default())?;
                prims.extend(crate::plan::underlay::plan_out_primitives(&out)?);
            } else {
                prims.extend(bin_prims(&run_bin_doc(d, &part.name, &part.args, &part.text)?)?);
            }
        }
        let p = d.project().map_err(model_err)?;
        return Ok(crate::plan::trace::trace_buf(&crate::plan::trace::trace_primitives(p, &a, prims)));
    }
    run_bin(d.project().map_err(model_err)?, name, args, text)
}

/// Primitive eines (einfachen) Plan-Puffers.
fn bin_prims(bytes: &[u8]) -> Result<Vec<crate::plan::prim::Primitive>, String> {
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    crate::plan::buf::View::parse(bytes).and_then(|v| v.prims()).ok_or_else(|| "tracePlan: Plan-Puffer unlesbar".to_string())
}

/// Plan-Puffer (eine Gruppe, ohne Inhalts-Hashes), in den `f` die Zeichnungs-Primitive schreibt.
fn buf_of(f: impl FnOnce(&mut crate::plan::drawings::Sink) -> Result<(), String>) -> Result<Vec<u8>, String> {
    buf_with(None, f)
}

/// Wie [`buf_of`] mit Nachbearbeitung (`extras::Post`).
fn buf_with(post: Option<crate::plan::extras::Post>, f: impl FnOnce(&mut crate::plan::drawings::Sink) -> Result<(), String>) -> Result<Vec<u8>, String> {
    use crate::plan::drawings::{Keep, Sink, Target};
    let mut w = crate::plan::buf::Writer::new(false);
    w.post = post;
    let start = w.begin_group();
    f(&mut Sink::new(Target::Buf(&mut w), Keep::All))?;
    w.end_group(start);
    Ok(w.finish())
}

#[cfg(test)]
#[path = "export_view_tests.rs"]
mod export_view_tests;
