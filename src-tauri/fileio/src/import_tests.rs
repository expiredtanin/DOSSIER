// Tests zu `import.rs`: Abbildung wie der frühere TS-Parser (Tessellierung, Winkel, Blöcke,
// Schraffuren, Meshes, Texte), dazu Bulges, Binär-DXF und DWG per Rundreise (acadrust schreibt).

use super::*;
use acadrust::entities::{Block, Face3D, Line, LwVertex, Text as AText};
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
    assert_eq!(g[0], 1.0);
    assert_eq!(g[1], 0.0);
    // Schichtfarben/Zählungen überspringen bis zur Kontur.
    let mut i = 4;
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
