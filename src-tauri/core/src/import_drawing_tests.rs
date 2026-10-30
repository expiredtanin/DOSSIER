use super::*;
use crate::import_context::{classification_suffix, ensure_context_categories, ifc_meshes, mesh_objects_to_meshes, stamp36, IfcProduct, MeshObject};

/// DXF-Puffer (Version 3) wie `fileio/src/import.rs::encode`: Layer „A" (rot) und „B", eine Linie,
/// eine Polylinie mit Bogen, ein Kreis, eine Schraffur, ein Text, ein Mesh auf „0".
fn sample() -> (Vec<f64>, Vec<String>) {
    let s: Vec<String> = ["A", "B", "LINE", "Wohnen", "0"].iter().map(|x| x.to_string()).collect();
    let mut g = vec![3.0, 0.0, 6.0, 1.0, 5.0];
    g.extend([2.0, 0.0, 16711680.0, 1.0, 255.0]); // Ebenenfarben
    g.extend([1.0, 2.0, 5.0]); // Entity-Zähler
    g.push(4.0); // Konturen
    g.extend([0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 4.0, 0.0]); // Linie
    g.extend([1.0, 8.0, 0.0, 3.0, 0.0, 0.0, 1.0, 0.5, 2.0, 0.0]); // Polylinie (tesselliert) …
    g.extend([2.0, 0.0, 0.0, 0.5, 2.0, 0.0, 0.0]); // … + Stützpunkte mit Bulge
    g.extend([0.0, 4.0, 0.0, 1.0, 10.0, 10.0, 2.0, 0.0, 6.283, 0.0]); // Kreis ohne Punkte
    g.extend([1.0, 3.0, 0.0, 3.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0]); // Schraffur, geschlossen
    g.extend([1.0, 1.0, 3.0, 5.0, 6.0, 0.25, 0.0]); // Text
    g.extend([1.0, 4.0, 3.0, 3.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 2.0]); // Mesh
    g.extend([0.0, 0.0, -1.0]); // Layouts, recovered, layout
    (g, s)
}

fn chunked(g: &[f64]) -> Vec<f64> {
    let mut out = vec![1.0, g.len() as f64];
    out.extend_from_slice(g);
    out
}

fn project() -> Map<String, Value> {
    json!({
        "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false}],
        "layers": [{"code": "20", "name": "Wände", "color": "#000", "lw": 0.5, "visible": true, "locked": false},
                   {"code": "30", "name": "b", "color": "#000", "lw": 0.5, "visible": true, "locked": false}],
        "lineStyles": [], "drawings2d": [], "context": [],
    })
    .as_object()
    .unwrap()
    .clone()
}

fn decision(v: Value) -> Decision {
    serde_json::from_value(v).unwrap()
}

#[test]
fn dekodiert_den_puffer() {
    let (g, s) = sample();
    let d = decode_drawing(&g, &s, "", 1000.0).unwrap();
    assert_eq!(d.contours.len(), 4);
    assert_eq!(d.texts.len(), 1);
    assert_eq!(d.meshes.len(), 1);
    assert_eq!(d.meshes[0].name, "DXF-Mesh");
    assert_eq!(d.layer_colors["A"], json!("#ff0000"));
    assert_eq!(d.layer_colors["B"], json!("#0000ff"));
    let sum = summary_json(&d);
    assert_eq!(sum["contours"], json!(4));
    assert_eq!(sum["layers"], json!(["A", "B"]));
    assert_eq!(sum["diagnostics"], json!({"entityCounts": {"LINE": 5}, "total": 5}));
    assert_eq!(sum["unitScale"], json!(1));
    assert_eq!(sum["recovered"], json!(false));
    // Kaputte Puffer: Fehler statt Panic.
    for n in 0..g.len() {
        let _ = decode_drawing(&g[..n], &s, "", 0.0);
    }
    assert!(decode_drawing(&[2.0], &s, "", 0.0).is_err());
    assert!(read_source(&[5.0, 1.0], "[[]]", &Source::default(), 0.0).is_err());
}

#[test]
fn ops_neue_zeichnung_mit_layer_kategorien() {
    let (g, s) = sample();
    let d = read_source(&chunked(&g), &serde_json::to_string(&vec![s]).unwrap(), &Source::default(), 0.0).unwrap();
    let dec = decision(json!({"target": {"kind": "new", "name": " "}, "categoryMode": "byLayer", "activeCategoryCode": "20",
        "importMeshes": true, "levelNameTemplate": "Zeichnung {n}", "parentName": "Import x"}));
    let r = import_ops(&project(), &d, &dec, 1234.0);
    assert_eq!(r.level_id, "drawing-1234");
    assert_eq!(r.drawings, 5);
    assert_eq!(r.meshes, 1);
    let ops: Vec<Value> = r.ops.iter().map(Op::to_json).collect();
    assert_eq!(ops[0]["items"][0], json!({"id": "drawing-1234", "name": "Zeichnung 1", "kind": "drawing", "visible": true, "locked": false}));
    let drawings = &ops[1]["items"];
    assert_eq!(drawings[0]["geom"], json!({"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 4, "y": 0}}));
    assert_eq!(drawings[0]["categoryCode"], json!("31"));
    // Bulge: Modell = − DXF.
    assert_eq!(drawings[1]["geom"]["bulge"], json!([-0.5, 0]));
    // „B" passt (ohne Gross-/Kleinschreibung) auf die vorhandene Kategorie „b".
    assert_eq!(drawings[1]["categoryCode"], json!("30"));
    assert_eq!(drawings[2]["geom"], json!({"shape": "circle", "center": {"x": 10, "y": 10}, "r": 2}));
    assert_eq!(drawings[3]["fillColor"], json!("#c8c8c8"));
    assert_eq!(drawings[4]["geom"], json!({"shape": "text", "at": {"x": 5, "y": 6}, "text": "Wohnen", "height": 0.25, "angle": 0}));
    assert_eq!(ops[2]["collection"], json!("context"));
    assert!(ops[2]["items"][0].get("layer").is_none());
    // Kategorien: „Import x" mit A, B; dazu „05 Kontext" mit „10 Situation".
    let layers = &ops[3]["value"];
    assert_eq!(layers[2]["name"], json!("Import x"));
    assert_eq!(layers[2]["code"], json!("32"));
    assert_eq!(layers[2]["children"].as_array().unwrap().len(), 1);
    assert_eq!(layers[2]["children"][0], json!({"code": "31", "name": "A", "color": "#ff0000", "lw": 0.18, "visible": true, "locked": false}));
    assert_eq!(layers[3]["code"], json!("05"));
    assert_eq!(layers[3]["children"][0]["code"], json!("10"));
}

#[test]
fn ops_aktive_kategorie_und_ausschnittsmitte() {
    let (g, s) = sample();
    let d = decode_drawing(&g, &s, "", 0.0).unwrap();
    let dec = decision(json!({"target": {"kind": "existing", "levelId": "eg"}, "categoryMode": "active", "activeCategoryCode": "20", "viewCenter": [100.0, 50.0]}));
    let r = import_ops(&project(), &d, &dec, 0.0);
    assert_eq!(r.ops.len(), 1);
    let ops = r.ops[0].to_json();
    // Umriss x 0…12, y 0…12 → Mitte (6, 6).
    assert_eq!(ops["items"][0]["geom"]["a"], json!({"x": 94, "y": 44}));
    assert!(ops["items"].as_array().unwrap().iter().all(|d| d["categoryCode"] == json!("20") && d["levelId"] == json!("eg")));
}

#[test]
fn pdf_mit_strichmuster() {
    let page = PdfPage {
        page_count: 1.0,
        page_index: 0.0,
        width: 595.0,
        height: 842.0,
        rotate: 0.0,
        truncated: false,
        images: 0.0,
        paths: vec![
            PdfPath { pts: vec![[72.0, 100.0], [172.0, 100.0]], closed: false, stroke: Some("#ff0000".into()), fill: None, line_width: 0.5, dash: vec![3.0, 2.0], curve: None },
            PdfPath { pts: vec![[0.0, 0.0], [595.0, 0.0], [595.0, 842.0], [0.0, 842.0]], closed: true, stroke: None, fill: Some("#ffffff".into()), line_width: 0.0, dash: vec![], curve: None },
        ],
        texts: vec![],
    };
    let d = pdf_to_import(&page, 100.0, true);
    assert_eq!(d.contours.len(), 1);
    assert_eq!(d.contours[0].layer, "PDF 0.18 #ff0000 (Strich 1.05/0.7)");
    assert_eq!(d.layer_dashes, vec![("PDF 0.18 #ff0000 (Strich 1.05/0.7)".to_string(), vec![1.05, 0.7])]);
    let dec = decision(json!({"target": {"kind": "existing", "levelId": "eg"}, "categoryMode": "byLayer", "activeCategoryCode": "20", "dashStyleTemplate": "PDF-Strich {pattern}"}));
    let r = import_ops(&project(), &d, &dec, 0.0);
    let ops: Vec<Value> = r.ops.iter().map(Op::to_json).collect();
    assert_eq!(ops[0]["items"][0], json!({"id": "pdf-dash-1_05_0_7", "name": "PDF-Strich 1.05/0.7", "color": "#1a1a1a", "dash": [1.05, 0.7]}));
    assert_eq!(ops[1]["items"][0]["lineStyleId"], json!("pdf-dash-1_05_0_7"));
    let info = pdf_page_info(&page);
    assert_eq!(info["layers"], json!({"PDF 0.18 #ff0000 (Strich 1.05/0.7)": 1, "PDF Fläche #ffffff": 1}));
}

#[test]
fn strichmuster_zu_linienstilen() {
    assert!(same_dash(&[1.05, 0.7], &[1.0, 0.7]));
    assert!(!same_dash(&[3.0, 1.0], &[1.0, 3.0]));
    assert!(!same_dash(&[1.0, 1.0], &[1.0, 1.0, 1.0, 1.0]));
    let solid = json!({"id": "thin", "name": "Volllinie", "color": "#111", "dash": null});
    let dashed = json!({"id": "d", "name": "Strich", "color": "#111", "dash": [1, 0.7]});
    let dashes: Vec<(String, Vec<f64>)> =
        vec![("a".into(), vec![1.05, 0.7]), ("b".into(), vec![2.8, 1.4]), ("c".into(), vec![2.8, 1.4]), ("d".into(), vec![0.05, 0.7, 2.8, 0.7])];
    let (created, by_layer) = plan_dash_styles(&dashes, &[solid.clone(), dashed], "S {pattern}");
    assert_eq!(by_layer["a"], "d");
    assert_eq!(created.len(), 2);
    assert_eq!(by_layer["b"], by_layer["c"]);
    assert_eq!(created[0], json!({"id": "pdf-dash-2_8_1_4", "name": "S 2.8/1.4", "color": "#1a1a1a", "dash": [2.8, 1.4]}));
    assert_eq!(created[1]["dash"], json!([0.05, 0.7, 2.8, 0.7]));
    // Gleiche id schon vergeben → Zähler.
    let taken = json!({"id": "pdf-dash-2_8_1_4", "kind": "dot", "dash": [2.8, 1.4]});
    let (created, _) = plan_dash_styles(&dashes[1..2], &[taken], "{pattern}");
    assert_eq!(created[0]["id"], json!("pdf-dash-2_8_1_4-2"));
    assert!(plan_dash_styles(&[], &[solid], "").0.is_empty());
}

#[test]
fn ifc_meshes_farbe_und_globalid() {
    let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let idx = [0.0, 2.0, 1.0, 0.0, 1.0, 3.0];
    let product = |color: Option<Vec<f64>>, gid: &str| IfcProduct {
        global_id: gid.into(),
        ifc_class: "IfcWall".into(),
        name: Some("Wand".into()),
        storey: Some("EG".into()),
        color,
        classifications: vec![],
        positions: &pos,
        indices: &idx,
    };
    let m = ifc_meshes(&[product(Some(vec![1.0, 0.5, 0.0, 0.8]), "2O2Fr$t4X7Zf8NOew3FLOH")], "x.ifc", "product", [0.0, 0.0], 0.0);
    assert_eq!(m[0]["color"], json!("#ff8000"));
    assert_eq!(m[0]["ifcGlobalId"], json!("2O2Fr$t4X7Zf8NOew3FLOH"));
    assert_eq!(m[0]["name"], json!("EG: Wand"));
    assert_eq!(m[0]["layer"], json!("IfcWall"));
    let n = ifc_meshes(&[product(None, "")], "x.ifc", "product", [0.0, 0.0], 0.0);
    assert!(n[0].get("color").is_none() && n[0].get("ifcGlobalId").is_none());
    // Zusammengelegt: gemeinsame Farbe nur, wenn alle gleich; Indizes versetzt.
    let red = || Some(vec![1.0, 0.0, 0.0, 1.0]);
    let g = ifc_meshes(&[product(red(), "a"), product(red(), "b")], "x.ifc", "class", [10.0, 0.0], 0.0);
    assert_eq!(g[0]["color"], json!("#ff0000"));
    assert_eq!(g[0]["name"], json!("x: EG IfcWall (2)"));
    assert_eq!(g[0]["indices"].as_array().unwrap()[6], json!(4));
    assert_eq!(g[0]["positions"][0], json!(10));
    let h = ifc_meshes(&[product(red(), "a"), product(Some(vec![0.0, 0.0, 1.0, 1.0]), "b")], "x.ifc", "class", [0.0, 0.0], 0.0);
    assert!(h[0].get("color").is_none());
    assert_eq!(classification_suffix(&[]), "");
    assert_eq!(classification_suffix(&[json!({"system": "", "code": "214", "name": null})]), " [214]");
}

#[test]
fn kontext_kategorien() {
    let mut l = vec![json!({"code": "20"})];
    assert!(ensure_context_categories(&mut l, ["10", "31", "20"]));
    assert_eq!(l[1]["code"], json!("05"));
    assert_eq!(l[1]["children"][0]["name"], json!("Situation"));
    assert_eq!(l[2]["code"], json!("31"));
    assert!(!ensure_context_categories(&mut l, ["10"]));
    assert!(ensure_context_categories(&mut l, ["02"]));
    assert_eq!(l[1]["children"][1]["code"], json!("02"));
}

#[test]
fn meshes_mitte_und_gruppen() {
    assert_eq!(stamp36(1_700_000_000_000.0), "loyw3v28");
    let obj = |g: &str, x: f64| MeshObject { name: String::new(), group: g.into(), color: Some(vec![1.0, 0.5, 0.0, 1.0]), positions: vec![x, 0.0, 1.0, x + 2.0, 2.0, 3.0], indices: vec![0.0, 1.0, 0.0] };
    let m = mesh_objects_to_meshes(&[obj("", 0.0), obj("g", 10.0)], "haus.obj", "center", None, "auto", 0.0);
    assert_eq!(m[0]["name"], json!("haus 1"));
    assert_eq!(m[0]["layer"], json!("haus"));
    assert_eq!(m[0]["color"], json!("#ff8000"));
    assert_eq!(m[0]["positions"], json!([-6, -1, 0, -4, 1, 2]));
    let m = mesh_objects_to_meshes(&[obj("g", 0.0), obj("g", 10.0)], "haus.obj", "original", None, "merge", 0.0);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0]["name"], json!("haus: g (2)"));
    assert_eq!(m[0]["indices"], json!([0, 1, 0, 2, 3, 2]));
    // Viele Objekte („auto"): je Gruppe + Farbe zusammengelegt.
    let many: Vec<MeshObject> = (0..2100).map(|i| obj(if i % 2 == 1 { "A" } else { "B" }, 0.0)).collect();
    let m = mesh_objects_to_meshes(&many, "x.obj", "original", None, "auto", 0.0);
    assert_eq!(m.len(), 2);
    assert_eq!(m[0]["indices"].as_array().unwrap().len(), 1050 * 3);
    assert_eq!(m[0]["color"], json!("#ff8000"));
}

/// Zeitmessung (nativ, von Hand): `IMPORT_BENCH=<geom-Datei>` mit `<geom>.strings.json` daneben.
#[test]
#[ignore]
fn zeitmessung_kataster() {
    let Ok(path) = std::env::var("IMPORT_BENCH") else { return };
    let bytes = std::fs::read(&path).unwrap();
    let geom: Vec<f64> = bytes.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let strings: Vec<String> = serde_json::from_str(&std::fs::read_to_string(path.replace(".geom", ".strings.json")).unwrap()).unwrap();
    let t = std::time::Instant::now();
    let d = decode_drawing(&geom, &strings, "", 0.0).unwrap();
    eprintln!("dekodieren {:?}", t.elapsed());
    let mut root = project();
    root.insert("drawingLevels".into(), json!([]));
    let dec = decision(json!({"target": {"kind": "new", "name": "K"}, "categoryMode": "byLayer", "activeCategoryCode": "20", "parentName": "I"}));
    let t = std::time::Instant::now();
    let r = import_ops(&root, &d, &dec, 0.0);
    eprintln!("ops {:?}", t.elapsed());
    let t = std::time::Instant::now();
    let mut out = Vec::new();
    for op in &r.ops {
        serde_json::to_writer(&mut out, &op.to_json()).unwrap();
    }
    eprintln!("json {:?} ({} MB)", t.elapsed(), out.len() / 1_000_000);
    let mut doc = crate::document::Document::from_json(&Value::Object(root).to_string()).unwrap();
    let t = std::time::Instant::now();
    doc.commit(r.ops, None, 0.0, false).unwrap();
    eprintln!("commit {:?}", t.elapsed());
}
