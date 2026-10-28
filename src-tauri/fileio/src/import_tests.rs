// Tests zu `import.rs`: Abbildung wie der frühere TS-Parser (Tessellierung, Winkel, Blöcke,
// Schraffuren, Meshes, Texte), dazu Bulges, Binär-DXF und DWG per Rundreise (acadrust schreibt).

use super::*;
use acadrust::entities::{
    AttributeDefinition, AttributeEntity, Block, Dimension, DimensionLinear, Face3D, Leader, Line, LwVertex,
    MultiLeaderBuilder, Solid, Text as AText,
};
use acadrust::tables::BlockRecord;
use acadrust::{DwgWriter, DxfWriter, Handle, Vector2};

/// Minimales DXF aus Gruppencode/Wert-Paaren (nur ENTITIES, ggf. BLOCKS davor).
fn dxf(blocks: &[&[&str]], entities: &[&[&str]]) -> Vec<u8> {
    let mut l: Vec<&str> = Vec::new();
    if !blocks.is_empty() {
        l.extend(["0", "SECTION", "2", "BLOCKS"]);
        for b in blocks {
            l.extend_from_slice(b);
        }
        l.extend(["0", "ENDSEC"]);
    }
    l.extend(["0", "SECTION", "2", "ENTITIES"]);
    for e in entities {
        l.extend_from_slice(e);
    }
    l.extend(["0", "ENDSEC", "0", "EOF"]);
    l.join("\n").into_bytes()
}

fn only_contour(data: &ImportData) -> &Contour {
    assert_eq!(data.contours.len(), 1, "genau eine Kontur erwartet: {:?}", data.contours);
    &data.contours[0]
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn kreis_geschlossen_64_punkte_mit_kurve() {
    let d = import_bytes(&dxf(&[], &[&["0", "CIRCLE", "8", "0", "10", "10", "20", "20", "30", "5", "40", "4"]])).unwrap();
    let c = only_contour(&d);
    assert!(c.closed);
    assert_eq!(c.z, 5.0);
    assert_eq!(c.pts.len(), 64);
    assert!(close(c.pts[0][0], 14.0) && close(c.pts[0][1], 20.0));
    let cv = c.curve.unwrap();
    assert!(cv.circle && cv.r == 4.0 && cv.cx == 10.0);
}

#[test]
fn bogen_viertel_und_umlaufend() {
    let d = import_bytes(&dxf(&[], &[&["0", "ARC", "8", "0", "10", "0", "20", "0", "30", "0", "40", "10", "50", "0", "51", "90"]])).unwrap();
    let c = only_contour(&d);
    assert!(!c.closed);
    assert_eq!(c.pts.len(), 17);
    assert!(close(c.pts[16][0], 0.0) && close(c.pts[16][1], 10.0));
    assert!(close(c.curve.unwrap().a1, PI / 2.0));
    let d = import_bytes(&dxf(&[], &[&["0", "ARC", "8", "0", "10", "0", "20", "0", "30", "0", "40", "5", "50", "270", "51", "90"]])).unwrap();
    let c = only_contour(&d);
    assert_eq!(c.pts.len(), 33);
    assert!((c.pts[16][0] - 5.0).abs() < 1e-6);
}

#[test]
fn ellipse_voller_umlauf() {
    let tau = format!("{}", TAU);
    let d = import_bytes(&dxf(
        &[],
        &[&["0", "ELLIPSE", "8", "0", "10", "0", "20", "0", "30", "0", "11", "10", "21", "0", "31", "0", "40", "0.5", "41", "0", "42", &tau]],
    ))
    .unwrap();
    let c = only_contour(&d);
    assert!(c.closed);
    let max_y = c.pts.iter().map(|p| p[1]).fold(f64::MIN, f64::max);
    assert!((max_y - 5.0).abs() < 1e-6);
}

#[test]
fn spline_grad2_und_stuetzpunkte() {
    let d = import_bytes(&dxf(
        &[],
        &[&[
            "0", "SPLINE", "8", "0", "71", "2", "40", "0", "40", "0", "40", "0", "40", "1", "40", "1", "40", "1", "10", "0", "20", "0", "30", "0", "10", "5",
            "20", "10", "30", "0", "10", "10", "20", "0", "30", "0",
        ]],
    ))
    .unwrap();
    let c = only_contour(&d);
    let mid = c.pts[c.pts.len() / 2];
    assert!((mid[0] - 5.0).abs() < 1e-6 && (mid[1] - 5.0).abs() < 1e-6);
    let d = import_bytes(&dxf(&[], &[&["0", "SPLINE", "8", "0", "71", "3", "11", "0", "21", "0", "31", "0", "11", "1", "21", "2", "31", "0", "11", "3", "21", "4", "31", "0"]])).unwrap();
    assert_eq!(only_contour(&d).pts.len(), 3);
}

#[test]
fn insert_verschachtelt_gedreht_und_raster() {
    let line: &[&str] = &["0", "LINE", "8", "0", "10", "0", "20", "0", "30", "0", "11", "1", "21", "0", "31", "0"];
    let mut inner: Vec<&str> = vec!["0", "BLOCK", "8", "0", "2", "inner", "10", "0", "20", "0", "30", "0", "70", "0"];
    inner.extend_from_slice(line);
    inner.extend(["0", "ENDBLK"]);
    let outer: &[&str] = &[
        "0", "BLOCK", "8", "0", "2", "outer", "10", "0", "20", "0", "30", "0", "70", "0", "0", "INSERT", "2", "inner", "10", "2", "20", "0", "30", "0", "0", "ENDBLK",
    ];
    let d = import_bytes(&dxf(&[&inner, outer], &[&["0", "INSERT", "2", "outer", "10", "0", "20", "3", "30", "0"]])).unwrap();
    let c = only_contour(&d);
    assert!(close(c.pts[0][0], 2.0) && close(c.pts[0][1], 3.0) && close(c.pts[1][0], 3.0));

    let d = import_bytes(&dxf(&[&inner], &[&["0", "INSERT", "2", "inner", "10", "0", "20", "0", "30", "0", "50", "90"]])).unwrap();
    let c = only_contour(&d);
    assert!(c.pts[1][0].abs() < 1e-9 && close(c.pts[1][1], 1.0));

    let d = import_bytes(&dxf(&[&inner], &[&["0", "INSERT", "2", "inner", "10", "0", "20", "0", "30", "0", "70", "2", "44", "10"]])).unwrap();
    assert_eq!(d.contours.len(), 2);
    assert!(close(d.contours[1].pts[0][0], 10.0));
}

#[test]
fn block_ebene_null_erbt_referenzebene() {
    let blk: &[&str] = &[
        "0", "BLOCK", "8", "0", "2", "b", "10", "0", "20", "0", "30", "0", "70", "0", "0", "LINE", "8", "0", "10", "0", "20", "0", "30", "0", "11", "1", "21", "0",
        "31", "0", "0", "LINE", "8", "EIGEN", "10", "0", "20", "0", "30", "0", "11", "1", "21", "1", "31", "0", "0", "ENDBLK",
    ];
    let d = import_bytes(&dxf(&[blk], &[&["0", "INSERT", "8", "REF", "2", "b", "10", "0", "20", "0", "30", "0"]])).unwrap();
    let layers: Vec<&str> = d.contours.iter().map(|c| c.layer.as_str()).collect();
    assert_eq!(layers, ["REF", "EIGEN"]);
}

#[test]
fn schraffur_polylinie_kanten_und_bogen() {
    let d = import_bytes(&dxf(
        &[],
        &[&[
            "0", "HATCH", "8", "0", "2", "SOLID", "70", "1", "91", "1", "92", "3", "72", "0", "73", "1", "93", "4", "10", "0", "20", "0", "10", "10", "20", "0", "10",
            "10", "20", "10", "10", "0", "20", "10", "97", "0",
        ]],
    ))
    .unwrap();
    let c = only_contour(&d);
    assert!(c.closed && c.filled);
    assert_eq!(c.pts.len(), 4);

    let d = import_bytes(&dxf(
        &[],
        &[&["0", "HATCH", "8", "0", "2", "SOLID", "70", "1", "91", "1", "92", "1", "93", "1", "72", "2", "10", "0", "20", "0", "40", "5", "50", "0", "51", "180", "73", "1", "97", "0"]],
    ))
    .unwrap();
    let c = only_contour(&d);
    assert!(close(c.pts[0][0], 5.0));
    let last = c.pts[c.pts.len() - 1];
    assert!((last[0] + 5.0).abs() < 1e-6 && last[1].abs() < 1e-6);
}

#[test]
fn polyface_netz_dreieck() {
    let d = import_bytes(&dxf(
        &[],
        &[&[
            "0", "POLYLINE", "8", "0", "70", "64", "0", "VERTEX", "8", "0", "70", "192", "10", "0.0", "20", "0.0", "30", "0.0", "0", "VERTEX", "8", "0", "70", "192",
            "10", "1.0", "20", "0.0", "30", "0.0", "0", "VERTEX", "8", "0", "70", "192", "10", "0.0", "20", "1.0", "30", "0.0", "0", "VERTEX", "8", "0", "70", "128",
            "10", "0.0", "20", "0.0", "30", "0.0", "71", "1", "72", "-2", "73", "3", "0", "SEQEND",
        ]],
    ))
    .unwrap();
    assert_eq!(d.meshes.len(), 1);
    assert_eq!(d.meshes[0].positions.len(), 9);
    assert_eq!(d.meshes[0].indices, vec![0, 1, 2]);
}

#[test]
fn texte_und_mtext_gesaeubert() {
    let d = import_bytes(&dxf(
        &[],
        &[
            &["0", "TEXT", "8", "0", "10", "5", "20", "3", "30", "0", "40", "0.5", "50", "90", "1", "Hallo"],
            &["0", "MTEXT", "8", "0", "10", "1", "20", "2", "30", "0", "40", "0.3", "50", "0", "1", "Welt\\Pzeile2"],
            &["0", "TEXT", "8", "0", "10", "0", "20", "0", "30", "0", "1", "X"],
        ],
    ))
    .unwrap();
    assert_eq!(d.texts.len(), 3);
    assert!(close(d.texts[0].angle, PI / 2.0) && d.texts[0].text == "Hallo");
    assert_eq!(d.texts[1].text, "Welt zeile2");
    // Fehlende Höhe: acadrust setzt den Vorgabewert der Entity (> 0).
    assert!(d.texts[2].height > 0.0);
}

#[test]
fn mtext_formatcodes() {
    assert_eq!(sanitize_mtext("{\\fArial|b1;Fett}\\~und\\pmehr"), "Fett und mehr");
    assert_eq!(sanitize_mtext("  a\\\\b  "), "a\\b");
    assert_eq!(sanitize_mtext("\\H2.5x;gross"), "gross");
}

#[test]
fn bulge_halbkreis() {
    // Zwei Punkte mit Bulge 1 → Halbkreis über die Sehne (CCW = rechts herum nach unten).
    let verts = vec![(Vector3::new(0.0, 0.0, 0.0), 1.0), (Vector3::new(2.0, 0.0, 0.0), 0.0)];
    let pts = bulge_points(&verts, false);
    assert_eq!(pts.len(), 2 + segments_for(PI) - 1);
    for p in &pts {
        assert!(((p[0] - 1.0).hypot(p[1]) - 1.0).abs() < 1e-9);
    }
    // Positiver Bulge = CCW von (0,0) nach (2,0) → Bogen unterhalb der Sehne.
    assert!(pts[pts.len() / 2][1] < -0.9);
    // Geschlossen: Schlusssegment mit Bulge ebenfalls tesselliert, Start nicht wiederholt.
    let verts = vec![(Vector3::new(0.0, 0.0, 0.0), 0.0), (Vector3::new(2.0, 0.0, 0.0), 1.0)];
    let pts = bulge_points(&verts, true);
    assert_eq!(pts.len(), 2 + segments_for(PI) - 1);
    assert!(pts[pts.len() / 2][1] > 0.9);
}

#[test]
fn ebenenfarben_und_einheiten() {
    let mut doc = CadDocument::new();
    let mut l = acadrust::Layer::new("Rot");
    l.color = acadrust::Color::Index(1);
    doc.layers.add(l).unwrap();
    doc.header.insertion_units = 6;
    let d = map_document(SourceKind::Dxf, &doc);
    assert!(d.layer_colors.contains(&("Rot".to_string(), 0xff0000)));
    assert!(d.layer_colors.contains(&("0".to_string(), crate::common::INK_FOR_WHITE)));
    assert_eq!(d.ins_units, 6);
}

/// Testdokument: Linie, Bulge-Polylinie, Text, 3DFACE auf Ebene „Dach", ein Block mit Linie
/// per INSERT (verschoben).
fn sample_doc() -> CadDocument {
    let mut doc = CadDocument::new();
    for name in ["Wand", "Dach"] {
        doc.layers.add(acadrust::Layer::new(name)).unwrap();
    }
    doc.add_entity(EntityType::Line(Line::from_points(Vector3::new(0.0, 0.0, 0.0), Vector3::new(3.0, 4.0, 0.0)))).unwrap();
    let mut pl = LwPolyline::new();
    pl.vertices.push(LwVertex::with_bulge(Vector2::new(0.0, 0.0), 1.0));
    pl.vertices.push(LwVertex::new(Vector2::new(2.0, 0.0)));
    pl.common.layer = "Wand".into();
    doc.add_entity(EntityType::LwPolyline(pl)).unwrap();
    doc.add_entity(EntityType::Text(AText::with_value("Raum 1", Vector3::new(1.0, 1.0, 0.0)).with_height(0.3))).unwrap();
    let mut f = Face3D::new(
        Vector3::new(0.0, 0.0, 3.0),
        Vector3::new(1.0, 0.0, 3.0),
        Vector3::new(1.0, 1.0, 3.0),
        Vector3::new(0.0, 1.0, 3.0),
    );
    f.common.layer = "Dach".into();
    doc.add_entity(EntityType::Face3D(f)).unwrap();

    let mut record = BlockRecord::new("B");
    record.handle = doc.allocate_handle();
    let owner: Handle = record.handle;
    doc.block_records.add(record).unwrap();
    let mut marker = Block::new("B", Vector3::ZERO);
    marker.common.owner_handle = owner;
    let marker_handle = doc.add_entity(EntityType::Block(marker)).unwrap();
    doc.block_records.get_mut("B").unwrap().block_entity_handle = marker_handle;
    let mut bl = Line::from_points(Vector3::ZERO, Vector3::new(1.0, 0.0, 0.0));
    bl.common.owner_handle = owner;
    doc.add_entity(EntityType::Line(bl)).unwrap();
    doc.add_entity(EntityType::Insert(Insert::new("B", Vector3::new(10.0, 20.0, 0.0)))).unwrap();
    doc
}

fn check_sample(d: &ImportData) {
    let lines: Vec<&Contour> = d.contours.iter().filter(|c| c.pts.len() == 2).collect();
    assert_eq!(lines.len(), 2, "{:?}", d.contours);
    assert!(lines.iter().any(|c| close(c.pts[1][0], 3.0) && close(c.pts[1][1], 4.0)));
    assert!(lines.iter().any(|c| close(c.pts[0][0], 10.0) && close(c.pts[1][0], 11.0) && close(c.pts[1][1], 20.0)));
    let arc = d.contours.iter().find(|c| c.layer == "Wand").expect("Bulge-Polylinie");
    assert!(arc.pts.len() > 10);
    assert_eq!(d.texts.len(), 1);
    assert_eq!(d.texts[0].text, "Raum 1");
    assert_eq!(d.meshes.len(), 1);
    assert_eq!(d.meshes[0].layer, "Dach");
    assert_eq!(d.meshes[0].indices.len(), 6);
}

#[test]
fn rundreise_ascii_binaer_dwg() {
    let doc = sample_doc();
    check_sample(&map_document(SourceKind::Dxf, &doc));

    let ascii = DxfWriter::new(&doc).write_to_vec().unwrap();
    check_sample(&import_bytes(&ascii).unwrap());

    let binary = DxfWriter::new_binary(&doc).write_to_vec().unwrap();
    assert!(binary.starts_with(b"AutoCAD Binary DXF"));
    let d = import_bytes(&binary).unwrap();
    assert_eq!(d.kind, SourceKind::Dxf);
    check_sample(&d);

    let dwg = DwgWriter::write_to_vec(&doc).unwrap();
    let d = import_bytes(&dwg).unwrap();
    assert_eq!(d.kind, SourceKind::Dwg);
    check_sample(&d);
}

#[test]
fn kaputte_dateien_ergeben_fehler() {
    assert!(import_bytes(b"").is_err() || import_bytes(b"").unwrap().contours.is_empty());
    assert!(import_bytes(b"AC1032\x00\x01\x02 kein dwg").is_err());
    let r = import_bytes(&[0xffu8; 4096]);
    assert!(r.is_err() || r.unwrap().contours.is_empty());
    // Abgeschnittenes DWG: Fehler statt Panic.
    let dwg = DwgWriter::write_to_vec(&sample_doc()).unwrap();
    for cut in [16, 100, dwg.len() / 2] {
        let _ = import_bytes(&dwg[..cut]);
    }
}

#[test]
fn kodierung_aufbau() {
    let d = import_bytes(&dxf(
        &[],
        &[&["0", "CIRCLE", "8", "K", "10", "1", "20", "2", "30", "0", "40", "1"], &["0", "TEXT", "8", "K", "10", "0", "20", "0", "30", "0", "40", "1", "1", "T"]],
    ))
    .unwrap();
    let (g, s) = encode(&d);
    assert_eq!(g[0], 2.0);
    assert_eq!(g[1], 0.0);
    assert_eq!(g[3], 1.0); // Einheitenfaktor (ohne $INSUNITS: 1)
    // Schichtfarben/Zählungen überspringen bis zur Kontur.
    let mut i = 5;
    let n_lc = g[i] as usize;
    i += 1 + 2 * n_lc;
    let n_counts = g[i] as usize;
    i += 1 + 2 * n_counts;
    assert_eq!(g[i], 1.0); // eine Kontur
    assert_eq!(s[g[i + 1] as usize], "K");
    assert_eq!(g[i + 2], 5.0); // geschlossen + Kurve
    assert_eq!(g[i + 4], 1.0); // Kreis
}

#[test]
fn periodische_spline_geschlossen() {
    // Uniform kubisch, periodisch über ein Quadrat: glatte geschlossene Kurve im Inneren.
    let cps = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
    let pts = sample_periodic(&cps, &[0.0, 1.0, 2.0, 3.0, 4.0], 3).unwrap();
    assert!(pts.len() >= 16);
    for p in &pts {
        assert!(p[0] > 0.4 && p[0] < 9.6 && p[1] > 0.4 && p[1] < 9.6, "{p:?}");
    }
    // Start und (weggelassener) Endpunkt fallen zusammen: der letzte Punkt liegt nahe dem ersten.
    let (a, b) = (pts[0], pts[pts.len() - 1]);
    assert!((a[0] - b[0]).hypot(a[1] - b[1]) < 2.0);
    assert!(sample_periodic(&cps, &[0.0, 1.0], 3).is_none());
}

// ── $INSUNITS ────────────────────────────────────────────────────────────────

/// DXF mit Kopf-Variable `$INSUNITS` und einer Linie, einem Kreis (r = 2) und einem Text (h = 1).
fn dxf_units(units: &str) -> Vec<u8> {
    let mut l = vec!["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", units, "0", "ENDSEC"];
    l.extend(["0", "SECTION", "2", "ENTITIES"]);
    l.extend(["0", "LINE", "8", "0", "10", "1000", "20", "2000", "30", "500", "11", "3000", "21", "2000", "31", "500"]);
    l.extend(["0", "CIRCLE", "8", "0", "10", "0", "20", "0", "30", "0", "40", "2"]);
    l.extend(["0", "TEXT", "8", "0", "10", "100", "20", "200", "30", "0", "40", "1", "1", "T"]);
    l.extend(["0", "ENDSEC", "0", "EOF"]);
    l.join("\n").into_bytes()
}

fn plain_line(d: &ImportData) -> &Contour {
    d.contours.iter().find(|c| c.curve.is_none()).unwrap()
}

#[test]
fn einheiten_faktoren() {
    assert_eq!(unit_scale(0), 1.0);
    assert_eq!(unit_scale(6), 1.0);
    assert_eq!(unit_scale(4), 0.001);
    assert_eq!(unit_scale(5), 0.01);
    assert_eq!(unit_scale(1), 0.0254);
    assert_eq!(unit_scale(2), 0.3048);
    assert_eq!(unit_scale(14), 0.1);
    assert_eq!(unit_scale(7), 1000.0);
    assert_eq!(unit_scale(-3), 1.0);
    assert_eq!(unit_scale(999), 1.0);
}

#[test]
fn insunits_millimeter_rechnet_in_meter() {
    let d = import_bytes(&dxf_units("4")).unwrap();
    assert_eq!((d.ins_units, d.unit_scale), (4, 0.001));
    let line = plain_line(&d);
    assert!(close(line.pts[0][0], 1.0) && close(line.pts[0][1], 2.0) && close(line.pts[1][0], 3.0));
    assert!(close(line.z, 0.5));
    let circle = d.contours.iter().find(|c| c.curve.is_some()).unwrap().curve.unwrap();
    assert!(close(circle.r, 0.002));
    assert!(close(d.texts[0].x, 0.1) && close(d.texts[0].y, 0.2) && close(d.texts[0].height, 0.001));
}

#[test]
fn insunits_zentimeter_und_zoll() {
    let d = import_bytes(&dxf_units("5")).unwrap();
    assert!(close(plain_line(&d).pts[1][0], 30.0));
    let d = import_bytes(&dxf_units("1")).unwrap();
    assert!(close(plain_line(&d).pts[0][0], 25.4));
}

#[test]
fn insunits_meter_ohne_einheit_und_unbekannt_bleiben_unveraendert() {
    for u in ["6", "0", "77"] {
        let d = import_bytes(&dxf_units(u)).unwrap();
        assert_eq!(d.unit_scale, 1.0, "{u}");
        let line = plain_line(&d);
        assert_eq!((line.pts[0][0], line.pts[1][0]), (1000.0, 3000.0), "{u}");
    }
    // Ohne $INSUNITS im Kopf: wie bisher 1:1.
    let d = import_bytes(&dxf(&[], &[&["0", "LINE", "8", "0", "10", "5", "20", "0", "30", "0", "11", "6", "21", "0", "31", "0"]])).unwrap();
    assert_eq!(d.unit_scale, 1.0);
    assert_eq!(d.contours[0].pts[0][0], 5.0);
}

#[test]
fn insunits_wirkt_auch_in_bloecken_und_meshes() {
    let mut doc = CadDocument::new();
    doc.header.insertion_units = 4;
    add_block(&mut doc, "B", vec![EntityType::Line(Line::from_points(Vector3::ZERO, Vector3::new(1000.0, 0.0, 0.0)))]);
    let mut ins = Insert::new("B", Vector3::new(2000.0, 0.0, 0.0));
    ins.rotation = std::f64::consts::FRAC_PI_2;
    doc.add_entity(EntityType::Insert(ins)).unwrap();
    doc.add_entity(EntityType::Face3D(Face3D::new(
        Vector3::new(0.0, 0.0, 1000.0),
        Vector3::new(1000.0, 0.0, 1000.0),
        Vector3::new(1000.0, 1000.0, 1000.0),
        Vector3::new(0.0, 1000.0, 1000.0),
    )))
    .unwrap();
    let d = map_document(SourceKind::Dxf, &doc);
    let c = only_contour(&d);
    assert!(close(c.pts[0][0], 2.0) && close(c.pts[1][0], 2.0) && close(c.pts[1][1], 1.0));
    assert!(close(d.meshes[0].positions[2], 1.0) && close(d.meshes[0].positions[3], 1.0));
}

// ── SOLID/TRACE, DIMENSION, LEADER, MULTILEADER, ATTRIB/ATTDEF ──────────────────

/// Legt einen Block mit Inhalt an (Eintrag in der Blocktabelle + BLOCK-Marke + Entitäten).
fn add_block(doc: &mut CadDocument, name: &str, entities: Vec<EntityType>) {
    let mut record = BlockRecord::new(name);
    record.handle = doc.allocate_handle();
    let owner: Handle = record.handle;
    doc.block_records.add(record).unwrap();
    let mut marker = Block::new(name, Vector3::ZERO);
    marker.common.owner_handle = owner;
    let marker_handle = doc.add_entity(EntityType::Block(marker)).unwrap();
    doc.block_records.get_mut(name).unwrap().block_entity_handle = marker_handle;
    for mut e in entities {
        e.common_mut().owner_handle = owner;
        doc.add_entity(e).unwrap();
    }
}

fn v(x: f64, y: f64) -> Vector3 {
    Vector3::new(x, y, 0.0)
}

/// Dokument als (Modell direkt, ASCII-DXF, DWG) — alle drei Wege müssen dasselbe liefern.
fn all_paths(doc: &CadDocument) -> Vec<ImportData> {
    vec![
        map_document(SourceKind::Dxf, doc),
        import_bytes(&DxfWriter::new(doc).write_to_vec().unwrap()).unwrap(),
        import_bytes(&DwgWriter::write_to_vec(doc).unwrap()).unwrap(),
    ]
}

#[test]
fn solid_viereck_in_dxf_reihenfolge_und_dreieck() {
    let mut doc = CadDocument::new();
    doc.layers.add(acadrust::Layer::new("S")).unwrap();
    // Ecken 1, 2, 3, 4 wie in der Datei: Umlaufreihenfolge ist 1, 2, 4, 3.
    let mut quad = Solid::new(v(0.0, 0.0), v(2.0, 0.0), v(0.0, 1.0), v(2.0, 1.0));
    quad.common.layer = "S".into();
    doc.add_entity(EntityType::Solid(quad)).unwrap();
    doc.add_entity(EntityType::Solid(Solid::new(v(5.0, 0.0), v(6.0, 0.0), v(5.0, 1.0), v(5.0, 1.0)))).unwrap();
    for d in all_paths(&doc) {
        assert_eq!(d.contours.len(), 2, "{:?}", d.contours);
        let q = &d.contours[0];
        assert!(q.filled && q.closed);
        assert_eq!(q.layer, "S");
        assert_eq!(q.pts, vec![[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]]);
        let t = &d.contours[1];
        assert!(t.filled && t.closed);
        assert_eq!(t.pts, vec![[5.0, 0.0], [6.0, 0.0], [5.0, 1.0]]);
    }
}

#[test]
fn trace_wird_wie_solid_gelesen() {
    let d = import_bytes(&dxf(
        &[],
        &[&["0", "TRACE", "8", "T", "10", "0", "20", "0", "30", "0", "11", "1", "21", "0", "31", "0", "12", "0", "22", "1", "32", "0", "13", "1", "23", "1", "33", "0"]],
    ))
    .unwrap();
    let c = only_contour(&d);
    assert!(c.filled && c.closed);
    assert_eq!(c.pts, vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
}

/// Bemassung samt Anonymblock `*D1` (Massline + Hilfslinie + Massstext).
fn dim_doc() -> CadDocument {
    let mut doc = CadDocument::new();
    add_block(
        &mut doc,
        "*D1",
        vec![
            EntityType::Line(Line::from_points(v(0.0, 1.0), v(4.0, 1.0))),
            EntityType::Line(Line::from_points(v(0.0, 0.0), v(0.0, 1.2))),
            EntityType::Text(AText::with_value("4.00", v(2.0, 1.1)).with_height(0.18)),
        ],
    );
    let mut dim = DimensionLinear::new(v(0.0, 0.0), v(4.0, 0.0));
    dim.base.block_name = "*D1".into();
    dim.base.common.layer = "Bem".into();
    doc.add_entity(EntityType::Dimension(Box::new(Dimension::Linear(dim)))).unwrap();
    doc
}

#[test]
fn bemassung_ueber_anonymblock() {
    for d in all_paths(&dim_doc()) {
        assert_eq!(d.contours.len(), 2, "{:?}", d.contours);
        assert!(d.contours.iter().all(|c| c.layer == "Bem" || c.layer == "0"));
        assert!(d.contours.iter().any(|c| close(c.pts[1][0], 4.0)));
        assert_eq!(d.texts.len(), 1);
        assert_eq!(d.texts[0].text, "4.00");
        assert!(close(d.texts[0].height, 0.18));
        assert!(d.entity_counts.iter().any(|(n, _)| n.starts_with("DIMENSION")));
    }
}

#[test]
fn bemassung_ohne_block_zeigt_massstext() {
    let mut doc = CadDocument::new();
    let mut dim = DimensionLinear::new(v(0.0, 0.0), v(3.5, 0.0));
    dim.base.text_middle_point = v(1.75, 0.5);
    doc.add_entity(EntityType::Dimension(Box::new(Dimension::Linear(dim)))).unwrap();
    let d = map_document(SourceKind::Dxf, &doc);
    assert!(d.contours.is_empty());
    assert_eq!(d.texts.len(), 1);
    assert_eq!(d.texts[0].text, "3.5");
    assert!(close(d.texts[0].x, 1.75));
}

#[test]
fn bemassung_in_millimetern_wird_umgerechnet() {
    let mut doc = dim_doc();
    doc.header.insertion_units = 4;
    let d = map_document(SourceKind::Dxf, &doc);
    assert!(d.contours.iter().any(|c| close(c.pts[1][0], 0.004)));
    assert!(close(d.texts[0].height, 0.00018));
}

#[test]
fn leader_linienzug() {
    let mut doc = CadDocument::new();
    doc.layers.add(acadrust::Layer::new("F")).unwrap();
    let l = Leader::new().with_vertex(v(0.0, 0.0)).with_vertex(v(1.0, 1.0)).with_vertex(v(2.0, 1.0)).with_layer("F");
    doc.add_entity(EntityType::Leader(l)).unwrap();
    let d = map_document(SourceKind::Dxf, &doc);
    let c = only_contour(&d);
    assert_eq!(c.layer, "F");
    assert!(!c.closed);
    assert_eq!(c.pts, vec![[0.0, 0.0], [1.0, 1.0], [2.0, 1.0]]);
}

#[test]
fn multileader_linie_und_text() {
    let mut doc = CadDocument::new();
    let ml = MultiLeaderBuilder::new()
        .text("Beton C25/30", v(3.0, 2.0))
        .text_height(0.2)
        .leader_line(vec![v(0.0, 0.0), v(2.0, 1.5)])
        .build();
    doc.add_entity(EntityType::MultiLeader(Box::new(ml))).unwrap();
    let d = map_document(SourceKind::Dxf, &doc);
    assert!(!d.contours.is_empty(), "keine Führungslinie");
    let c = &d.contours[0];
    assert!(!c.closed && c.pts.len() >= 2);
    assert!(c.pts.iter().any(|p| close(p[0], 0.0) && close(p[1], 0.0)));
    assert_eq!(d.texts.len(), 1);
    assert_eq!(d.texts[0].text, "Beton C25/30");
    assert!(close(d.texts[0].height, 0.2));
    assert!(close(d.texts[0].x, 3.0) && close(d.texts[0].y, 2.0));
}

/// Block mit ATTDEFs (Raumnummer, Fläche, unsichtbar) und einem INSERT mit nur einem ATTRIB.
fn attrib_doc() -> CadDocument {
    let mut doc = CadDocument::new();
    let nr = AttributeDefinition::new("NR".into(), "Nummer".into(), "000".into()).with_position(v(0.5, 0.5)).with_height(0.2);
    let area = AttributeDefinition::new("FLAECHE".into(), "Fläche".into(), "0 m²".into()).with_position(v(0.5, 0.1)).with_height(0.1);
    let hidden = AttributeDefinition::new("GEHEIM".into(), "".into(), "x".into()).with_invisible();
    let frame = Line::from_points(v(0.0, 0.0), v(1.0, 0.0));
    add_block(
        &mut doc,
        "RAUM",
        vec![
            EntityType::Line(frame),
            EntityType::AttributeDefinition(nr),
            EntityType::AttributeDefinition(area),
            EntityType::AttributeDefinition(hidden),
        ],
    );
    let mut ins = Insert::new("RAUM", v(10.0, 20.0));
    // ATTRIB-Positionen stehen in Weltkoordinaten.
    ins.attributes.push(AttributeEntity::new("NR".into(), "101".into()).with_position(v(10.5, 20.5)).with_height(0.2));
    doc.add_entity(EntityType::Insert(ins)).unwrap();
    doc
}

#[test]
fn attrib_und_attdef_als_text() {
    let doc = attrib_doc();
    let paths = [map_document(SourceKind::Dxf, &doc), import_bytes(&DxfWriter::new(&doc).write_to_vec().unwrap()).unwrap()];
    for d in paths {
        // NR kommt als ATTRIB (101, Weltposition), nicht als Vorgabewert 000; FLAECHE hat kein
        // ATTRIB → Vorgabewert mit der Einfügeverschiebung; GEHEIM ist unsichtbar.
        let mut texts: Vec<(&str, f64, f64)> = d.texts.iter().map(|t| (t.text.as_str(), t.x, t.y)).collect();
        texts.sort_by(|a, b| a.0.cmp(b.0));
        assert_eq!(texts.len(), 2, "{texts:?}");
        assert_eq!(texts[0].0, "0 m²");
        assert!(close(texts[0].1, 10.5) && close(texts[0].2, 20.1), "{texts:?}");
        assert_eq!(texts[1].0, "101");
        assert!(close(texts[1].1, 10.5) && close(texts[1].2, 20.5), "{texts:?}");
    }
}

#[test]
fn attrib_in_zentimeterzeichnung() {
    let mut doc = attrib_doc();
    doc.header.insertion_units = 5; // cm
    let d = map_document(SourceKind::Dxf, &doc);
    let a = d.texts.iter().find(|t| t.text == "101").unwrap();
    assert!(close(a.x, 0.105) && close(a.height, 0.002));
}
