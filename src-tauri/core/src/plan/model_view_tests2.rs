//! [173] Etappe 2 der Modelldarstellung: Schnitt (Schichten, Bodenaufbau, Öffnungsdetail, Treppen), Decken,
//! Dächer, Stützen im Grundriss, Ansicht (Schatten, Materialschraffur, Fensterteilung), „nur Kern" als echte
//! Kerndicke, Schwelle, Sturzlinie der Fenster, Blatt-Ausschnitt und 3D. Ohne Wahl bleibt alles gleich.

use super::*;
use crate::plan::domains::{plan_domains, PlanArgs};
use crate::plan::prim::Primitive;

fn sample() -> Project {
    serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
}

fn with_mv(mut p: Project, json: serde_json::Value) -> Project {
    let mut v = json;
    v["id"] = "mv".into();
    v["name"] = "Eigene".into();
    p.model_view_options = Some(vec![serde_json::from_value(v).unwrap()]);
    p
}

fn set_level_mv(p: &mut Project, level: &str, id: &str) {
    p.drawing_levels.iter_mut().find(|l| l.id == level).unwrap().model_view_option_id = Some(id.into());
}

/// Schnitt „schnitt-a" quer durch das Fenster O1 (Wand W1) gelegt.
fn through_window(mut p: Project) -> Project {
    let o = p.openings.as_deref().unwrap().iter().find(|o| o.id == "O1").unwrap().clone();
    let w = p.walls.iter().find(|w| w.id == o.host_wall_id).unwrap().clone();
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = dx.hypot(dy);
    let (ux, uy) = (dx / l, dy / l);
    let t = o.position + o.width / 2.0;
    let (mx, my) = (w.start.x + ux * t, w.start.y + uy * t);
    let lv = p.drawing_levels.iter_mut().find(|l| l.id == "schnitt-a").unwrap();
    let mut v = serde_json::to_value(&*lv).unwrap();
    v["linePoints"] = serde_json::json!([{"x": mx + uy * 3.0, "y": my - ux * 3.0}, {"x": mx - uy * 3.0, "y": my + ux * 3.0}]);
    *lv = serde_json::from_value(v).unwrap();
    p
}

fn section_text(p: &Project, scale: f64, detail: &str, extra: serde_json::Value) -> String {
    let level = p.drawing_levels.iter().find(|l| l.id == "schnitt-a").unwrap();
    let mut v = serde_json::json!({"level": level, "scale": scale, "detail": detail});
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        for (k, x) in e {
            o.insert(k.clone(), x.clone());
        }
    }
    v.to_string()
}

fn section_buf(p: &Project, scale: f64, detail: &str, extra: serde_json::Value) -> Vec<u8> {
    crate::queries::run_bin(p, "sectionPlan", &[1.0, 1.0, 0.0], &section_text(p, scale, detail, extra)).unwrap()
}

fn prims_of(buf: &[u8]) -> Vec<Primitive> {
    crate::plan::buf::View::parse(buf).and_then(|v| v.prims()).unwrap_or_default()
}

fn section(p: &Project, scale: f64, detail: &str) -> Vec<Primitive> {
    prims_of(&section_buf(p, scale, detail, serde_json::json!({})))
}

fn count(prims: &[Primitive], f: impl Fn(&Primitive) -> bool) -> usize {
    prims.iter().filter(|q| f(q)).count()
}

fn line_cls(prims: &[Primitive], cls: &str) -> usize {
    count(prims, |q| matches!(q, Primitive::Line { cls: c, .. } if c == cls))
}

fn area(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    ((0..n).map(|i| pts[i].x * pts[(i + 1) % n].y - pts[(i + 1) % n].x * pts[i].y).sum::<f64>() / 2.0).abs()
}

fn plan(p: &Project, floor: &str, detail: f64, scale: f64) -> crate::plan::domains::DomainPrims {
    let mut codes: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).collect();
    codes.extend(p.walls.iter().map(|w| w.category_code.clone()));
    codes.extend(p.openings.iter().flatten().map(|o| o.category_code.clone()));
    codes.extend(p.ceilings.iter().flatten().map(|o| o.category_code.clone()));
    codes.extend(p.roofs.iter().flatten().map(|o| o.category_code.clone()));
    codes.extend(p.columns.iter().flatten().map(|o| o.category_code.clone()));
    let text = serde_json::json!({"floor": floor, "show": codes, "scale": scale}).to_string();
    plan_domains(p, &PlanArgs::parse_in(p, detail, &text).unwrap()).unwrap()
}

fn elevation(p: &Project, shadows: f64) -> Vec<u8> {
    let level = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
    crate::queries::run_bin(p, "elevationPlan", &[0.0, shadows, 100.0], &serde_json::json!({"level": level}).to_string()).unwrap()
}

#[test]
fn schnitt_und_ansicht_ohne_wahl_unveraendert() {
    let p = sample();
    for (detail, scale) in [("mittel", 50.0), ("mittel", 100.0), ("fein", 100.0), ("grob", 200.0)] {
        let heute = section_buf(&p, scale, detail, serde_json::json!({}));
        let mut q = p.clone();
        set_level_mv(&mut q, "schnitt-a", detail);
        assert_eq!(heute, section_buf(&q, scale, detail, serde_json::json!({})), "eingebaute Stufe {detail} 1:{scale}");
        let mut e = with_mv(p.clone(), serde_json::json!({"doors": {}, "windows": {}, "stairs": {}, "walls": {}, "slabs": {}, "roofs": {}, "columns": {}, "elevation": {}}));
        set_level_mv(&mut e, "schnitt-a", "mv");
        assert_eq!(heute, section_buf(&e, scale, detail, serde_json::json!({})), "leere Stufe {detail} 1:{scale}");
    }
    // Ansicht: Schatten „nicht gesetzt" (2) ohne Stufe = aus.
    assert_eq!(elevation(&p, 0.0), elevation(&p, 2.0));
    let mut e = with_mv(p.clone(), serde_json::json!({"elevation": {}, "windows": {}}));
    set_level_mv(&mut e, "ansicht-sued", "mv");
    assert_eq!(elevation(&p, 0.0), elevation(&e, 2.0), "leere Stufe");
}

#[test]
fn schnitt_schichten_alle_vereinfacht_kern() {
    let p = sample();
    let walls_at = |p: &Project, scale: f64, detail: &str| {
        let s = section(p, scale, detail);
        let n = count(&s, |q| matches!(q, Primitive::Polygon { wall_id: Some(_), .. }));
        let a: f64 = s.iter().map(|q| match q { Primitive::Polygon { wall_id: Some(_), pts, .. } => area(pts), _ => 0.0 }).sum();
        (n, a)
    };
    let (n0, a0) = walls_at(&p, 50.0, "mittel");
    let mut k = with_mv(p.clone(), serde_json::json!({"walls": {"layers": "core"}}));
    set_level_mv(&mut k, "schnitt-a", "mv");
    let (n2, a2) = walls_at(&k, 50.0, "mittel");
    assert!(n2 < n0 && a2 < a0 - 1e-3, "nur Kern: weniger und kleinere Flächen ({n2}/{n0}, {a2}/{a0})");
    // 1:100 mit schraffierten Schnittflächen: „vereinfacht" auch in „fein", „alle" auch in „mittel".
    let mut h = p.clone();
    h.drawing_levels.iter_mut().find(|l| l.id == "schnitt-a").unwrap().cut_hatch = Some(true);
    let (mittel, am) = walls_at(&h, 100.0, "mittel");
    let (fein, _) = walls_at(&h, 100.0, "fein");
    assert!(mittel < fein, "heute: mittel fasst dünne Schichten zusammen ({mittel} < {fein})");
    let mut s = with_mv(h.clone(), serde_json::json!({"walls": {"layers": "simplified"}}));
    set_level_mv(&mut s, "schnitt-a", "mv");
    let (n1, a1) = walls_at(&s, 100.0, "fein");
    assert_eq!(n1, mittel, "vereinfacht in fein");
    assert!((a1 - am).abs() < 1e-3 * am, "gleiche Fläche");
    let mut all = with_mv(h.clone(), serde_json::json!({"walls": {"layers": "all"}}));
    set_level_mv(&mut all, "schnitt-a", "mv");
    assert_eq!(walls_at(&all, 100.0, "mittel").0, fein, "alle Schichten in mittel");
}

#[test]
fn schnitt_deckenaufbau_und_kern() {
    let p = sample();
    let slabs = |p: &Project| count(&section(p, 50.0, "mittel"), |q| matches!(q, Primitive::Polygon { ceiling_id: Some(_), .. }));
    let n0 = slabs(&p);
    assert!(n0 >= 3, "drei Deckenschichten ({n0})");
    let mut m = with_mv(p.clone(), serde_json::json!({"slabs": {"buildUp": "merged"}}));
    set_level_mv(&mut m, "schnitt-a", "mv");
    assert!(slabs(&m) < n0, "Bodenaufbau als eine Fläche");
    let mut k = with_mv(p.clone(), serde_json::json!({"slabs": {"layers": "core"}}));
    set_level_mv(&mut k, "schnitt-a", "mv");
    assert!(slabs(&k) < slabs(&m), "nur tragende Schicht");
}

#[test]
fn schnitt_oeffnungsdetail() {
    let mut p = through_window(sample());
    for t in p.window_types.iter_mut().flatten() {
        t.lintel_height = Some(0.2);
        t.sill_board = Some(WindowTypeSillBoard::Beide);
    }
    let ops = |p: &Project| count(&section(p, 50.0, "fein"), |q| matches!(q, Primitive::Polygon { opening_id: Some(_), .. } | Primitive::Line { opening_id: Some(_), .. }));
    let n0 = ops(&p);
    let mut q = with_mv(p.clone(), serde_json::json!({"windows": {"sectionDetail": false}, "doors": {"sectionDetail": false}}));
    set_level_mv(&mut q, "schnitt-a", "mv");
    assert!(n0 > 0 && ops(&q) < n0, "ohne Detail weniger Teile ({} < {n0})", ops(&q));
}

#[test]
fn schnitt_treppen_hinter_dem_schnitt_und_handlauf() {
    let mut p = sample();
    for t in p.stair_types.iter_mut().flatten() {
        t.railing = Some(StairTypeRailing::Beide);
    }
    let vis = |p: &Project| line_cls(&section(p, 50.0, "mittel"), "section-visible");
    let n0 = vis(&p);
    let mut r = with_mv(p.clone(), serde_json::json!({"stairs": {"handrail": "off"}}));
    set_level_mv(&mut r, "schnitt-a", "mv");
    let n1 = vis(&r);
    let mut b = with_mv(p.clone(), serde_json::json!({"stairs": {"sectionBeyond": false}}));
    set_level_mv(&mut b, "schnitt-a", "mv");
    let n2 = vis(&b);
    assert!(n1 < n0, "ohne Handlauf weniger Kanten ({n1} < {n0})");
    assert!(n2 < n1, "ohne Treppen hinter dem Schnitt noch weniger ({n2} < {n1})");
}

#[test]
fn grundriss_decken_daecher_stuetzen() {
    let mut p = sample();
    p.columns = Some(vec![Column { id: "S1".into(), floor_id: "eg".into(), category_code: "20".into(), position: Vec2 { x: 2.0, y: 2.0 }, profile: ColumnProfile::Rect { width: 0.3, depth: 0.3 }, height: 2.6, component_id: p.components.first().map(|c| c.id.clone()), ..Default::default() }]);
    let col = |p: &Project, scale: f64| {
        plan(p, "eg", 1.0, scale).columns.iter().find_map(|q| match q {
            Primitive::Polygon { fill, hatch, column_id: Some(_), .. } => Some((fill.clone(), hatch.pattern)),
            _ => None,
        })
    };
    let base100 = col(&p, 100.0).unwrap();
    assert_eq!(base100.0, crate::plan::style::HATCH_INK, "ab 1:100 schwarz");
    let mat = with_mv(p.clone(), serde_json::json!({"columns": {"cutFill": "material"}}));
    let mut m = mat.clone();
    set_level_mv(&mut m, "eg", "mv");
    assert_ne!(col(&m, 100.0).unwrap().0, crate::plan::style::HATCH_INK, "Schraffur auch in 1:100");
    let mut e = with_mv(p.clone(), serde_json::json!({"columns": {"cutFill": "empty"}}));
    set_level_mv(&mut e, "eg", "mv");
    assert_eq!(col(&e, 50.0).unwrap(), (crate::plan::style::HATCH_PAPER.to_string(), HatchPattern::None));
    let mut s = with_mv(p.clone(), serde_json::json!({"columns": {"cutFill": "solid"}}));
    set_level_mv(&mut s, "eg", "mv");
    assert_eq!(col(&s, 50.0).unwrap().0, crate::plan::style::HATCH_INK);
    // Decken-Umriss
    let outl = |p: &Project, f: &str| plan(p, f, 1.0, 50.0).ceilings.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "ceiling-outline")).count();
    // Eine Decke ausserhalb der Wände (Vordach): ihr Umriss liegt frei.
    let mut ce = p.ceilings.as_deref().unwrap()[0].clone();
    ce.id = "C-frei".into();
    for q in ce.outline.iter_mut() {
        q.x += 30.0;
    }
    p.ceilings.as_mut().unwrap().push(ce);
    let floor = p.ceilings.as_deref().unwrap()[0].floor_id.clone();
    assert!(outl(&p, &floor) > 0);
    let mut o = with_mv(p.clone(), serde_json::json!({"slabs": {"outline": false}}));
    set_level_mv(&mut o, &floor, "mv");
    assert_eq!(outl(&o, &floor), 0, "Deckenumriss aus");
    // Dachrand über dem Schnitt
    let roof_lines = |p: &Project| plan(p, "og", 1.0, 100.0).roofs.iter().filter(|q| matches!(q, Primitive::Line { .. })).count();
    let r0 = roof_lines(&p);
    let mut r = with_mv(p.clone(), serde_json::json!({"roofs": {"overhead": false}}));
    set_level_mv(&mut r, "og", "mv");
    assert!(r0 > 0 && roof_lines(&r) < r0, "Dachrand über Schnitt aus ({r0})");
}

#[test]
fn ansicht_schatten_schraffur_fensterteilung() {
    let p = sample();
    let off = elevation(&p, 0.0);
    let mut s = with_mv(p.clone(), serde_json::json!({"elevation": {"shadows": true}}));
    set_level_mv(&mut s, "ansicht-sued", "mv");
    assert_eq!(elevation(&s, 2.0), elevation(&p, 1.0), "Schatten aus der Stufe = Schatten an");
    assert_eq!(elevation(&s, 0.0), off, "Ebene (aus) geht vor");
    let mut d = with_mv(p.clone(), serde_json::json!({"windows": {"elevationDivision": false}}));
    set_level_mv(&mut d, "ansicht-sued", "mv");
    assert_ne!(elevation(&d, 0.0), off, "ohne Fensterteilung");
    // Materialschraffur: Ansichtsmuster auf einem Baustoff der Aussenwand.
    let mut m = p.clone();
    for c in m.components.iter_mut() {
        c.surface_pattern = Some(serde_json::from_value(serde_json::json!({"kind": "lines", "spacing": 0.3})).unwrap());
    }
    let pat = |p: &Project| prims_of(&elevation(p, 0.0)).iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "elevation-surface-pattern")).count();
    assert!(pat(&m) > 0, "Muster heute");
    let mut h = with_mv(m.clone(), serde_json::json!({"elevation": {"materialHatch": false}}));
    set_level_mv(&mut h, "ansicht-sued", "mv");
    assert_eq!(pat(&h), 0, "Materialschraffur aus");
}

#[test]
fn nur_kern_mit_echter_kerndicke() {
    let p = sample();
    let wall_area = |p: &Project| -> f64 {
        plan(p, "eg", 2.0, 50.0).walls.iter().map(|q| match q { Primitive::Polygon { wall_id: Some(_), fill, stroke, opening_id: None, pts, .. } if fill != "none" || stroke == "none" => area(pts), _ => 0.0 }).sum()
    };
    let a0 = wall_area(&p);
    let mut k = with_mv(p.clone(), serde_json::json!({"walls": {"layers": "core"}}));
    set_level_mv(&mut k, "eg", "mv");
    let a1 = wall_area(&k);
    assert!(a1 < 0.95 * a0, "Kern dünner als die ganze Wand ({a1} < {a0})");
    assert!(a1 > 0.2 * a0);
}

#[test]
fn schwelle_und_sturzlinie() {
    let p = sample();
    let n = |p: &Project, cls: &str| plan(p, "eg", 1.0, 50.0).walls.iter().filter(|q| matches!(q, Primitive::Line { cls: c, .. } if c == cls)).count();
    assert_eq!(n(&p, "door-threshold"), 0, "Basis: keine Schwelle");
    let mut all = with_mv(p.clone(), serde_json::json!({"doors": {"threshold": "all"}}));
    set_level_mv(&mut all, "eg", "mv");
    assert!(n(&all, "door-threshold") > 0);
    let mut ls = with_mv(p.clone(), serde_json::json!({"doors": {"threshold": "liftSlide"}}));
    set_level_mv(&mut ls, "eg", "mv");
    assert_eq!(n(&ls, "door-threshold"), 0, "keine Hebeschiebetür");
    for t in ls.door_types.iter_mut().flatten() {
        t.kind = DoorTypeKind::Hebeschiebe;
    }
    assert!(n(&ls, "door-threshold") > 0, "Hebeschiebetür");
    assert_eq!(n(&p, "window-lintel"), 0, "Basis: keine Sturzlinie am Fenster");
    let mut l = with_mv(p.clone(), serde_json::json!({"windows": {"lintelLine": true}}));
    set_level_mv(&mut l, "eg", "mv");
    assert!(n(&l, "window-lintel") > 0);
    for o in l.openings.iter_mut().flatten() {
        o.lintel_line_style = Some(LintelLineStyle::Keine);
    }
    assert_eq!(n(&l, "window-lintel"), 0, "Element geht vor");
}

#[test]
fn ausschnitt_waehlt_stufe_im_schnitt() {
    let p = with_mv(sample(), serde_json::json!({"walls": {"layers": "core"}}));
    let base = section_buf(&p, 50.0, "mittel", serde_json::json!({}));
    assert_ne!(base, section_buf(&p, 50.0, "mittel", serde_json::json!({"modelView": "mv"})), "angefragt");
    let snap = |mv: Option<&str>| -> ViewSnapshot {
        let mut v = serde_json::json!({"id": "s", "name": "S", "viewType": "grundriss", "view3d": "iso", "scaleDenominator": 50, "detail": "mittel", "activeLevelId": "schnitt-a", "layerVisibility": {}, "drawingVisibility": {}});
        if let Some(m) = mv {
            v["modelViewOptionId"] = m.into();
        }
        for w in &p.walls {
            v["layerVisibility"][w.category_code.as_str()] = true.into();
        }
        serde_json::from_value(v).unwrap()
    };
    let a = crate::sheet_viewports::snapshot_buf(&p, &snap(None), 50.0, None);
    let b = crate::sheet_viewports::snapshot_buf(&p, &snap(Some("mv")), 50.0, None);
    assert!(a.is_some() && a != b, "Blatt-Ausschnitt mit eigener Stufe");
}

#[test]
fn dreid_handlauf_und_detail() {
    let mut p = sample();
    for t in p.stair_types.iter_mut().flatten() {
        t.railing = Some(StairTypeRailing::Beide);
    }
    let parts = |p: &Project, text: &str| -> serde_json::Value { serde_json::from_str(&crate::queries::run(p, "model3dParts", &[1.0, 2.0, 0.0], text).unwrap()).unwrap() };
    let base = parts(&p, "");
    assert!(!base["stairRailings"].as_array().unwrap().is_empty());
    let q = with_mv(p.clone(), serde_json::json!({"stairs": {"handrail": "off"}, "baseDetail": "grob"}));
    let v = parts(&q, r#"{"modelView": "mv"}"#);
    assert!(v["stairRailings"].as_array().unwrap().is_empty(), "Handlauf aus");
    assert_ne!(v["openingMeshes"], base["openingMeshes"], "Öffnungen nach Basis grob");
    assert_eq!(parts(&q, ""), base, "ohne Wahl unverändert");
}

#[test]
fn lauflinie_versatz_und_antrittspunkt() {
    let p = sample();
    let run = |p: &Project| -> (f64, usize) {
        let d = plan(p, "eg", 1.0, 50.0);
        let l: f64 = d.stairs.iter().map(|q| match q { Primitive::Line { cls, a, b, .. } if cls == "stair-run" => (b.x - a.x).hypot(b.y - a.y), _ => 0.0 }).sum();
        (l, d.stairs.iter().filter(|q| matches!(q, Primitive::Polygon { .. })).count())
    };
    let (l0, n0) = run(&p);
    assert!(l0 > 0.0);
    let mut q = with_mv(p.clone(), serde_json::json!({"stairs": {"runStartMm": 2, "runEndMm": 3, "startMark": true}}));
    set_level_mv(&mut q, "eg", "mv");
    let (l1, n1) = run(&q);
    // 2 + 3 mm Papier bei 1:50 = 0.25 m kürzer.
    assert!((l0 - l1 - 0.25).abs() < 1e-6, "Versatz ({l0} → {l1})");
    assert_eq!(n1, n0 + 1, "Antrittspunkt");
}

/// Sample mit dem Standard-Steildach (Holz gedämmt) auf RF1 und den Standard-Baustoffen.
fn with_std_roof(mut p: Project) -> Project {
    for v in crate::standards::components() {
        let c: Component = serde_json::from_value(v).unwrap();
        if !p.components.iter().any(|x| x.id == c.id) {
            p.components.push(c);
        }
    }
    let rt: RoofType = serde_json::from_value(crate::standards::roof_types()[0].clone()).unwrap();
    p.roofs.as_mut().unwrap()[0].roof_type_id = Some(rt.id.clone());
    p.roof_types.get_or_insert_with(Vec::new).push(rt);
    p
}

/// [173] „Nur Kern" beim Steildach in Holz: die Sparrenlage (Mineralwolle 22 cm), nicht die 15-mm-Beplankung.
#[test]
fn schnitt_dach_nur_kern_ist_sparrenlage() {
    let p = with_std_roof(sample());
    let roof_area = |p: &Project| -> f64 { section(p, 50.0, "mittel").iter().map(|q| match q { Primitive::Polygon { pts, fill, roof_id: Some(_), .. } if fill != "none" => area(pts), _ => 0.0 }).sum() };
    let mut a = with_mv(p.clone(), serde_json::json!({"roofs": {"layers": "all"}}));
    let mut k = with_mv(p.clone(), serde_json::json!({"roofs": {"layers": "core"}}));
    set_level_mv(&mut a, "schnitt-a", "mv");
    set_level_mv(&mut k, "schnitt-a", "mv");
    let (aa, ak) = (roof_area(&a), roof_area(&k));
    assert!(aa > 0.0 && ak > 0.0);
    // Kern 0.22 von 0.4075 m Gesamtdicke (die Beplankung allein wäre 0.015).
    let r = ak / aa;
    assert!(r > 0.4 && r < 0.65, "Kernanteil {r}");
}

/// [173] Geschnittenes Dach im Grundriss: Schichten nach der Stufe (alle, vereinfacht, nur Kern); der Kern
/// liegt in der Dachfläche als Streifen der Breite Schichtdicke / sin(Neigung).
#[test]
fn grundriss_dach_geschnitten_schichten() {
    let mut p = sample();
    {
        let r = &mut p.roofs.as_mut().unwrap()[0];
        r.roof_type_id = Some("roof-warm".into());
        // Traufe 0.6 m unter der Schnitthöhe des OG (2.6 + 1.0): das Dach ist geschnitten.
        r.base_elevation = Some(3.0);
    }
    let cut_polys = |p: &Project, scale: f64| -> Vec<(String, f64)> {
        plan(p, "og", 1.0, scale)
            .roofs
            .iter()
            .filter_map(|q| match q {
                Primitive::Polygon { pts, fill, roof_id: Some(_), .. } if fill != "none" => Some((fill.clone(), area(pts))),
                _ => None,
            })
            .collect()
    };
    let base = cut_polys(&p, 50.0);
    assert!(!base.is_empty(), "geschnittenes Dach zeigt Schnittflächen");
    let stage = |layers: &str| {
        let mut q = with_mv(p.clone(), serde_json::json!({"roofs": {"layers": layers}}));
        set_level_mv(&mut q, "og", "mv");
        cut_polys(&q, 50.0)
    };
    let all = stage("all");
    let core = stage("core");
    let planes = 2;
    assert_eq!(all.len(), 3 * planes, "alle Schichten je Dachfläche");
    assert_eq!(core.len(), planes, "nur Kern: eine Fläche je Dachfläche");
    // Kern = Dämmung 22 cm, Neigung 30°: Streifen 0.22 / sin 30° = 0.44 m breit, 4 m + 2 × 0.4 Vordach lang.
    let a: f64 = core.iter().map(|c| c.1).sum();
    let want = 2.0 * 0.22 / 0.5 * 5.8;
    assert!((a - want).abs() < 0.1 * want, "Kernfläche {a} ≈ {want}");
    // Vereinfacht in 1:50 (Basis „mittel"): der Innenputz (0.25 mm Papier) geht in der Dämmung auf.
    assert!(base.len() < all.len(), "{} < {}", base.len(), all.len());
    // Dach ganz über der Schnittebene: keine Schnittflächen.
    p.roofs.as_mut().unwrap()[0].base_elevation = None;
    assert!(cut_polys(&p, 50.0).is_empty());
}

/// [184] (Profil-Flächen, Linien) der geschnittenen Öffnung O1 im Schnitt.
fn o1_parts(p: &Project, scale: f64, detail: &str) -> (usize, usize) {
    let s = section(p, scale, detail);
    let profiles = count(&s, |q| matches!(q, Primitive::Polygon { opening_id: Some(id), fill, .. } if id == "O1" && fill != "none"));
    let lines = count(&s, |q| matches!(q, Primitive::Line { opening_id: Some(id), .. } if id == "O1"));
    (profiles, lines)
}

#[test]
fn schnitt_fenster_stufen_wie_grundriss() {
    let mut p = through_window(sample());
    for t in p.window_types.iter_mut().flatten() {
        t.lintel_height = Some(0.2);
        t.sill_board = Some(WindowTypeSillBoard::Beide);
    }
    // 1:200 mittel gilt wie im Grundriss als grob: nur ein Strich, kein Profil.
    assert_eq!(o1_parts(&p, 200.0, "mittel"), (0, 1), "1:200 grob: ein Mittelstrich");
    assert_eq!(o1_parts(&p, 50.0, "grob"), (0, 1));
    // Mittel: einfacher Rahmen + Glaslinie + Fensterbank als Fläche; fein: volles Profil (mehr Flächen: Sturz).
    let (mp, ml) = o1_parts(&p, 50.0, "mittel");
    let (fp, fl) = o1_parts(&p, 50.0, "fein");
    assert!(mp >= 2 && ml == 1, "mittel: Rahmen {mp}, Linien {ml}");
    assert!(fp > mp && fl >= 1, "fein: Profil {fp} > mittel {mp}");
    // Stufe mit „Vereinfacht" macht auch bei 1:50 fein einen Strich.
    let mut q = with_mv(p.clone(), serde_json::json!({"baseDetail": "fein", "windows": {"simplified": true}}));
    set_level_mv(&mut q, "schnitt-a", "mv");
    assert_eq!(o1_parts(&q, 50.0, "fein"), (0, 1), "simplified: grob");
}

#[test]
fn schnitt_storenkasten_nur_mit_option() {
    let mut p = through_window(sample());
    for t in p.window_types.iter_mut().flatten() {
        t.shading = Some(serde_json::from_value(serde_json::json!({"create": true, "mount": "vorgesetzt", "box": {"width": 1.0, "height": 0.2, "depth": 0.15}})).unwrap());
    }
    let n = |p: &Project| o1_parts(p, 50.0, "fein").0;
    let n0 = n(&p);
    let mut q = with_mv(p.clone(), serde_json::json!({"baseDetail": "fein", "windows": {"shadingBox": true}}));
    set_level_mv(&mut q, "schnitt-a", "mv");
    assert!(n(&q) > n0, "Storenkasten nur mit Option ({} > {n0})", n(&q));
}
