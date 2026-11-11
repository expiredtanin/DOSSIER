//! [173] Tests der Modelldarstellung: Rangfolge, Auflösung je Option, Standardstufen = heutiges Verhalten,
//! eigene Stufe ändert Tür, Fenster, Treppe und Wand.

use super::*;
use crate::plan::domains::{plan_domains, plan_domains_buf, PlanArgs};
use crate::plan::prim::Primitive;

fn sample() -> Project {
    serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
}

/// Alle Kategorie-Codes des Projekts sichtbar.
fn args_text(p: &Project, floor: &str, scale: f64, extra: serde_json::Value) -> String {
    let mut codes: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).collect();
    for w in &p.walls {
        codes.push(w.category_code.clone());
    }
    for o in p.openings.iter().flatten() {
        codes.push(o.category_code.clone());
    }
    for s in p.stairs.iter().flatten() {
        codes.push(s.category_code.clone());
    }
    let mut v = serde_json::json!({"floor": floor, "show": codes, "scale": scale});
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        for (k, x) in e {
            o.insert(k.clone(), x.clone());
        }
    }
    v.to_string()
}

fn buf(p: &Project, detail: f64, scale: f64, extra: serde_json::Value) -> Vec<u8> {
    plan_domains_buf(p, &PlanArgs::parse_in(p, detail, &args_text(p, "eg", scale, extra)).unwrap()).unwrap()
}

/// Linien je Klasse (Wände mit Öffnungen und Treppen).
fn lines(p: &Project, detail: f64, scale: f64, extra: serde_json::Value, cls: &str) -> usize {
    let d = plan_domains(p, &PlanArgs::parse_in(p, detail, &args_text(p, "eg", scale, extra)).unwrap()).unwrap();
    d.walls.iter().chain(d.stairs.iter()).filter(|q| matches!(q, Primitive::Line { cls: c, .. } if c == cls)).count()
}

fn arcs(p: &Project, detail: f64, scale: f64, extra: serde_json::Value) -> usize {
    let d = plan_domains(p, &PlanArgs::parse_in(p, detail, &args_text(p, "eg", scale, extra)).unwrap()).unwrap();
    d.walls.iter().filter(|q| matches!(q, Primitive::Arc { cls, .. } if cls == "door-swing")).count()
}

fn with_mv(mut p: Project, mv: ModelViewOption) -> Project {
    p.model_view_options = Some(vec![mv]);
    p
}

fn mv(json: serde_json::Value) -> ModelViewOption {
    let mut v = json;
    v["id"] = "mv".into();
    v["name"] = "Eigene".into();
    serde_json::from_value(v).unwrap()
}

fn select() -> serde_json::Value {
    serde_json::json!({"modelView": "mv"})
}

#[test]
fn standardstufen_wie_heute() {
    let p = sample();
    for (code, id) in [(0.0, "grob"), (1.0, "mittel"), (2.0, "fein")] {
        for scale in [20.0, 50.0, 100.0, 200.0, 500.0] {
            let heute = buf(&p, code, scale, serde_json::json!({}));
            // eingebaute Stufe ausdrücklich angefragt
            assert_eq!(heute, buf(&p, code, scale, serde_json::json!({"modelView": id})), "{id} 1:{scale}");
            // eingebaute Stufe an der Ebene
            let mut q = p.clone();
            q.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().model_view_option_id = Some(id.into());
            assert_eq!(heute, buf(&q, 1.0, scale, serde_json::json!({})), "Ebene {id} 1:{scale}");
            // eigene Stufe ohne Optionen über derselben Basis
            let detail = ["grob", "mittel", "fein"][code as usize];
            let q = with_mv(p.clone(), mv(serde_json::json!({"baseDetail": detail})));
            assert_eq!(heute, buf(&q, 1.0, scale, select()), "eigene leere Stufe {id} 1:{scale}");
            // leere Abschnitte sind ebenfalls „wie Basis"
            let q = with_mv(p.clone(), mv(serde_json::json!({"doors": {}, "windows": {}, "stairs": {}, "walls": {}, "slabs": {}, "site": {}, "roofs": {}, "columns": {}, "elevation": {}})));
            assert_eq!(heute, buf(&q, code, scale, select()), "leere Abschnitte {id} 1:{scale}");
        }
    }
}

#[test]
fn aufloesung_je_option_basis() {
    let o = resolve(None, Detail::Mittel, 100.0);
    assert_eq!(o.door.lintel(None, None), LintelLineStyle::Gestrichelt);
    assert_eq!(o.door.swing_angle(None), None);
    assert!(o.door.frame && !o.door.leaf_rect && o.door.swing_arc.is_none());
    assert!(!o.window.sill && !o.window.sash_frames && o.window.sash_symbols(None, None) && !o.window.plan_swing_arcs(None, None));
    assert_eq!(o.stair, StairOpts { walk_line: true, arrow: true, break_line: true, above_cut: true, handrail: Some(false), section_beyond: true, run_start_mm: 0.0, run_end_mm: 0.0, start_mark: false, step_numbers: false });
    assert_eq!(o.wall.layers, LayerMode::Simplified { force: false });
    assert_eq!(o.wall.thin_mm, THIN_LAYER_PAPER_MM);
    assert!(o.wall.reveals && !o.cut_hatch(None) && o.floor_finish(None).is_none() && o.terrain(None).is_none());
    let f = resolve(None, Detail::Fein, 100.0);
    assert!(f.door.leaf_rect && f.window.sill && f.window.sash_frames && f.stair.handrail == Some(true));
    assert_eq!(resolve(None, Detail::Mittel, 50.0).stair.handrail, Some(true), "1:50 doppelt");
}

#[test]
fn aufloesung_je_option_eigene_stufe() {
    let m = mv(serde_json::json!({
        "doors": {"lintelLineStyle": "keine", "swingAngle": 45, "swingArc": false, "frame": false, "leaf": "rect"},
        "windows": {"sashSymbols": false, "planSwingArcs": true, "sill": true, "sashFrames": true},
        "stairs": {"walkLine": false, "arrow": false, "breakLine": false, "aboveCut": "off", "handrail": "off"},
        "walls": {"layers": "core", "thinLayerMm": 0.8, "reveals": false, "cutHatch": true},
        "slabs": {"floorFinish": "all"},
        "site": {"terrain": false}
    }));
    let o = resolve(Some(&m), Detail::Mittel, 100.0);
    assert_eq!(o.door.lintel(None, None), LintelLineStyle::Keine);
    assert_eq!(o.door.swing_angle(None), Some(45.0));
    assert_eq!(o.door.swing_arc, Some(false));
    assert!(!o.door.frame && o.door.leaf_rect);
    assert!(!o.window.sash_symbols(None, None) && o.window.plan_swing_arcs(None, None) && o.window.sill && o.window.sash_frames);
    assert_eq!(o.stair, StairOpts { walk_line: false, arrow: false, break_line: false, above_cut: false, handrail: None, section_beyond: true, run_start_mm: 0.0, run_end_mm: 0.0, start_mark: false, step_numbers: false });
    assert_eq!(o.wall.layers, LayerMode::Core);
    assert_eq!(o.wall.thin_mm, 0.8);
    assert!(!o.wall.reveals && o.cut_hatch(None));
    assert_eq!(o.floor_finish(None), Some(FloorFinishDisplay::All));
    assert_eq!(o.terrain(None), Some(false));
    let s = resolve(Some(&mv(serde_json::json!({"stairs": {"handrail": "single"}, "walls": {"layers": "simplified"}}))), Detail::Fein, 20.0);
    assert_eq!(s.stair.handrail, Some(false));
    assert!(s.simplify_thin(20.0), "vereinfacht auch in fein/1:20");
    let a = resolve(Some(&mv(serde_json::json!({"walls": {"layers": "all"}}))), Detail::Mittel, 100.0);
    assert!(!a.simplify_thin(100.0));
}

#[test]
fn rangfolge_element_typ_modelldarstellung_basis() {
    let m = mv(serde_json::json!({"doors": {"lintelLineStyle": "punktiert", "swingAngle": 30}, "windows": {"sashSymbols": false, "planSwingArcs": true}, "walls": {"cutHatch": true}, "slabs": {"floorFinish": "wet"}, "site": {"terrain": true}}));
    let o = resolve(Some(&m), Detail::Mittel, 100.0);
    use LintelLineStyle::*;
    // Element > Typ > Modelldarstellung > Basis
    assert_eq!(o.door.lintel(Some(Durchgehend), Some(Keine)), Durchgehend);
    assert_eq!(o.door.lintel(None, Some(Keine)), Keine);
    assert_eq!(o.door.lintel(None, None), Punktiert);
    assert_eq!(resolve(None, Detail::Mittel, 100.0).door.lintel(None, None), Gestrichelt);
    assert_eq!(o.door.swing_angle(Some(80.0)), Some(80.0));
    assert_eq!(o.door.swing_angle(None), Some(30.0));
    assert!(o.window.sash_symbols(Some(true), Some(false)));
    assert!(!o.window.sash_symbols(None, Some(false)));
    assert!(o.window.sash_symbols(None, Some(true)));
    assert!(!o.window.sash_symbols(None, None));
    assert!(!o.window.plan_swing_arcs(Some(false), None));
    assert!(o.window.plan_swing_arcs(None, None));
    // Ebene > Modelldarstellung
    assert!(!o.cut_hatch(Some(false)));
    assert_eq!(o.floor_finish(Some(FloorFinishDisplay::Off)), Some(FloorFinishDisplay::Off));
    assert_eq!(o.terrain(Some(false)), Some(false));
    assert!(o.cut_hatch(None));
}

#[test]
fn angefragt_vor_ebene_und_basis_detail() {
    let mut p = with_mv(sample(), mv(serde_json::json!({"baseDetail": "fein"})));
    assert_eq!(selected_id(&p, "eg", None), None);
    p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().model_view_option_id = Some("mv".into());
    assert_eq!(selected_id(&p, "eg", None), Some("mv"));
    assert_eq!(selected_id(&p, "eg", Some("grob")), Some("grob"), "angefragt vor Ebene");
    // Basis „fein" der Stufe an der Ebene ersetzt den angefragten Detailgrad „mittel".
    let a = PlanArgs::parse_in(&p, 1.0, &args_text(&p, "eg", 100.0, serde_json::json!({}))).unwrap();
    assert_eq!(a.detail, Detail::Fein);
    let fein = buf(&sample(), 2.0, 100.0, serde_json::json!({}));
    assert_eq!(fein, buf(&p, 1.0, 100.0, serde_json::json!({})), "eigene Stufe mit Basis fein = fein");
    assert_eq!(base_of(&p, "mittel"), Some(Detail::Mittel));
    assert_eq!(find_by_name(&p, "eigene").map(|m| m.id.as_str()), Some("mv"));
}

#[test]
fn tuer_mit_eigener_stufe_sieht_anders_aus() {
    let p = sample();
    let none = serde_json::json!({});
    assert!(lines(&p, 1.0, 50.0, none.clone(), "door-lintel") > 0, "Sturzlinien heute");
    let q = with_mv(p.clone(), mv(serde_json::json!({"doors": {"lintelLineStyle": "keine", "swingArc": false}})));
    assert_eq!(lines(&q, 1.0, 50.0, select(), "door-lintel"), 0, "Sturzlinie keine");
    assert!(arcs(&p, 1.0, 50.0, none.clone()) > 0);
    assert_eq!(arcs(&q, 1.0, 50.0, select()), 0, "ohne Aufschlagbogen");
    // Element geht vor: Sturzlinie an der Tür gesetzt
    let mut r = q.clone();
    for o in r.openings.iter_mut().flatten().filter(|o| o.kind == ElementKind::Door) {
        o.lintel_line_style = Some(LintelLineStyle::Durchgehend);
    }
    assert!(lines(&r, 1.0, 50.0, select(), "door-lintel") > 0, "Element vor Modelldarstellung");
    // Aufschlagbogen in der Übersicht 1:500 erzwingen
    let s = with_mv(p.clone(), mv(serde_json::json!({"doors": {"swingArc": true}})));
    assert_eq!(arcs(&p, 0.0, 500.0, none), 0);
    assert!(arcs(&s, 0.0, 500.0, select()) > 0);
}

#[test]
fn fenster_mit_eigener_stufe_sieht_anders_aus() {
    let p = sample();
    let none = serde_json::json!({});
    assert_eq!(lines(&p, 1.0, 50.0, none.clone(), "window-sash"), 0, "mittel: keine Flügelrahmen");
    let q = with_mv(p.clone(), mv(serde_json::json!({"windows": {"sashFrames": true, "sill": true}})));
    assert!(lines(&q, 1.0, 50.0, select(), "window-sash") > 0, "Flügelrahmen in mittel");
    assert!(lines(&q, 1.0, 50.0, select(), "window-sill") > lines(&p, 1.0, 50.0, none.clone(), "window-sill"), "Fensterbank in mittel");
    let f = with_mv(p.clone(), mv(serde_json::json!({"windows": {"sashFrames": false, "sill": false}})));
    assert!(lines(&p, 2.0, 50.0, none.clone(), "window-sash") > 0);
    assert_eq!(lines(&f, 2.0, 50.0, select(), "window-sash"), 0, "fein ohne Flügelrahmen");
    assert!(lines(&f, 2.0, 50.0, select(), "window-sill") < lines(&p, 2.0, 50.0, none, "window-sill"), "fein ohne Fensterbank");
}

#[test]
fn treppe_mit_eigener_stufe_sieht_anders_aus() {
    let p = sample();
    let none = serde_json::json!({});
    for cls in ["stair-run", "stair-break"] {
        assert!(lines(&p, 1.0, 50.0, none.clone(), cls) > 0, "{cls} heute");
    }
    let q = with_mv(p.clone(), mv(serde_json::json!({"stairs": {"walkLine": false, "arrow": false, "breakLine": false, "aboveCut": "off"}})));
    for cls in ["stair-run", "stair-arrow", "stair-break"] {
        assert_eq!(lines(&q, 1.0, 50.0, select(), cls), 0, "{cls} aus");
    }
    let d = plan_domains(&q, &PlanArgs::parse_in(&q, 1.0, &args_text(&q, "eg", 50.0, select())).unwrap()).unwrap();
    assert!(!d.stairs.iter().any(|x| matches!(x, Primitive::Line { dash: Some(Some(_)), .. })), "keine gestrichelten Stufen über Schnitt");
    assert!(d.stairs.iter().any(|x| matches!(x, Primitive::Line { cls, .. } if cls == "stair-tread")), "Tritte unter dem Schnitt bleiben");
}

#[test]
fn treppe_handlauf_aus_einfach_doppelt() {
    let mut p = sample();
    for t in p.stair_types.iter_mut().flatten() {
        t.railing = Some(StairTypeRailing::Beide);
    }
    let n = |p: &Project, s: &str| lines(p, 1.0, 100.0, serde_json::json!({"modelView": s}), "stair-handrail");
    let base = n(&p, "mittel");
    assert!(base > 0, "Handlauf heute (1:100 einfach)");
    let off = with_mv(p.clone(), mv(serde_json::json!({"stairs": {"handrail": "off"}})));
    assert_eq!(n(&off, "mv"), 0);
    let dbl = with_mv(p.clone(), mv(serde_json::json!({"stairs": {"handrail": "double"}})));
    assert!(n(&dbl, "mv") > base, "doppelt hat mehr Linien");
}

#[test]
fn wand_schichten_nach_modelldarstellung() {
    let p = sample();
    let polys = |p: &Project, detail: f64, extra: serde_json::Value| {
        let d = plan_domains(p, &PlanArgs::parse_in(p, detail, &args_text(p, "eg", 50.0, extra)).unwrap()).unwrap();
        d.walls.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "layer-joint")).count()
    };
    let fein = polys(&p, 2.0, serde_json::json!({}));
    let core = with_mv(p.clone(), mv(serde_json::json!({"walls": {"layers": "core"}})));
    assert!(fein > 0);
    assert_eq!(polys(&core, 2.0, select()), 0, "nur Kern: keine Fugen");
    let all = with_mv(p.clone(), mv(serde_json::json!({"walls": {"layers": "all"}})));
    let mittel = polys(&p, 1.0, serde_json::json!({}));
    assert!(polys(&all, 1.0, select()) > mittel, "alle Schichten in mittel 1:50: mehr Fugen als vereinfacht");
}

#[test]
fn ansicht_oeffnungslinien_nach_modelldarstellung() {
    let p = sample();
    let level = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap().clone();
    let run = |p: &Project, l: &DrawingLevel| crate::queries::run_bin(p, "elevationPlan", &[0.0, 0.0, 100.0], &serde_json::json!({"level": l}).to_string()).unwrap();
    let heute = run(&p, &level);
    let q = with_mv(p.clone(), mv(serde_json::json!({"windows": {"sashSymbols": false}})));
    let mut l = level.clone();
    l.model_view_option_id = Some("mv".into());
    assert_eq!(heute, run(&q, &level), "ohne Wahl unverändert");
    assert_ne!(heute, run(&q, &l), "Öffnungslinien aus");
    let e = with_mv(p.clone(), mv(serde_json::json!({})));
    assert_eq!(heute, run(&e, &l), "leere Stufe unverändert");
}

#[test]
fn tuer_zarge_blatt_winkel_nach_modelldarstellung() {
    let p = sample();
    let door_polys = |p: &Project, extra: serde_json::Value| {
        let d = plan_domains(p, &PlanArgs::parse_in(p, 2.0, &args_text(p, "eg", 50.0, extra)).unwrap()).unwrap();
        let door: Vec<String> = p.openings.iter().flatten().filter(|o| o.kind == ElementKind::Door).map(|o| o.id.clone()).collect();
        d.walls.iter().filter(|q| matches!(q, Primitive::Polygon { opening_id: Some(id), stroke, .. } if door.contains(id) && stroke != "none")).count()
    };
    let heute = door_polys(&p, serde_json::json!({}));
    let ohne = with_mv(p.clone(), mv(serde_json::json!({"doors": {"frame": false}})));
    assert!(door_polys(&ohne, select()) < heute, "ohne Zarge/Rahmen weniger Umrisse ({heute})");
    // Öffnungswinkel 45°: der Bogen endet anders.
    let arc_end = |p: &Project, extra: serde_json::Value| {
        let d = plan_domains(p, &PlanArgs::parse_in(p, 1.0, &args_text(p, "eg", 50.0, extra)).unwrap()).unwrap();
        d.walls.iter().find_map(|q| match q {
            Primitive::Arc { cls, from, to, .. } if cls == "door-swing" => Some((from.x, from.y, to.x, to.y)),
            _ => None,
        })
    };
    let w45 = with_mv(p.clone(), mv(serde_json::json!({"doors": {"swingAngle": 45}})));
    assert_ne!(arc_end(&p, serde_json::json!({})), arc_end(&w45, select()));
}

#[test]
fn ausschnitt_und_vorlage_waehlen_die_modelldarstellung() {
    let p = with_mv(sample(), mv(serde_json::json!({"baseDetail": "fein", "doors": {"lintelLineStyle": "keine"}})));
    let snap: ViewSnapshot = serde_json::from_value(serde_json::json!({"id": "s", "name": "S", "viewType": "grundriss", "view3d": "iso", "scaleDenominator": 50,
        "detail": "mittel", "activeLevelId": "eg", "layerVisibility": {}, "drawingVisibility": {}, "modelViewOptionId": "mv"})).unwrap();
    let a = crate::sheet_viewports::viewport_args(&p, &snap, 50.0, true);
    assert_eq!(a.model_view.as_deref(), Some("mv"));
    assert_eq!(a.detail, Detail::Fein, "Basis der Stufe");
    // Die Vorlage setzt das Feld an der Ebene (wie die übrigen Ebenen-Felder).
    let t = ViewTemplate { id: "t".into(), name: "T".into(), model_view_option_id: Some("mv".into()), ..Default::default() };
    let l = crate::sheet_viewports::level_with_template(p.floor("eg").unwrap(), &t);
    assert_eq!(l.model_view_option_id.as_deref(), Some("mv"));
}

/// Fenster „vereinfacht" (3 Linien): auch bei mittel/fein nur Leibungen und Mitte; Wettbewerb 1:200 nutzt es.
#[test]
fn fenster_vereinfacht_drei_linien() {
    let p = sample();
    let none = serde_json::json!({});
    let sash_fein = lines(&p, 2.0, 50.0, none.clone(), "window-sash");
    assert!(sash_fein > 0);
    let q = with_mv(p.clone(), mv(serde_json::json!({"windows": {"simplified": true}})));
    for d in [1.0, 2.0] {
        assert_eq!(lines(&q, d, 50.0, select(), "window-sash"), 0, "keine Flügel");
        assert_eq!(lines(&q, d, 50.0, select(), "window-sill"), 0, "keine Bank");
        assert_eq!(lines(&q, d, 50.0, select(), "window-glass"), lines(&p, 0.0, 50.0, none.clone(), "window-glass"), "nur der Mittelstrich");
    }
    let o = resolve(None, Detail::Mittel, 200.0);
    assert!(!o.window.simplified && !o.window.shading_box);
    let w = crate::standards::model_views().into_iter().find(|v| v["id"] == "std-mv-wettbewerb-200").unwrap();
    assert_eq!(w["windows"]["simplified"], true);
}

/// Storenkasten (Untersicht) im Grundriss: Basis aus, mit der Option an.
#[test]
fn storenkasten_nur_mit_option() {
    let mut p = sample();
    for t in p.window_types.iter_mut().flatten() {
        t.shading = Some(serde_json::from_value(serde_json::json!({"create": true, "kind": "rollladen", "mount": "sturz", "box": {"width": 0.0, "height": 0.25, "depth": 0.2}})).unwrap());
    }
    let none = serde_json::json!({});
    assert_eq!(lines(&p, 2.0, 50.0, none.clone(), "window-shading"), 0, "Basis: aus");
    let q = with_mv(p.clone(), mv(serde_json::json!({"windows": {"shadingBox": true}})));
    assert!(lines(&q, 2.0, 50.0, select(), "window-shading") > 0, "Option an");
}
