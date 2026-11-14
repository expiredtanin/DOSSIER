//! Tests des IFC-Schreibers (aus `ifc_export.rs` verschoben, [164]): GUIDs, Zeichenketten, Zahlenformat, Entitäten, Schemas IFC4/IFC2x3, Fehlerfälle.

use super::*;

#[test]
fn strings_wie_ts() {
    assert_eq!(ifc_string("Gebäude"), "'Geb\\X2\\00E4\\X0\\ude'");
    assert_eq!(ifc_string("Grösse Ü"), "'Gr\\X2\\00F6\\X0\\sse \\X2\\00DC\\X0\\'");
    assert_eq!(ifc_string("it's a\\b"), "'it''s a\\\\b'");
    assert_eq!(ifc_string("äö"), "'\\X2\\00E400F6\\X0\\'");
    assert_eq!(ifc_string("a😀"), "'a\\X4\\0001F600\\X0\\'");
    assert_eq!(ifc_string("a\nb"), "'a\\X2\\000A\\X0\\b'");
    assert_eq!(ifc_string(""), "''");
    // BMP und Ausserhalb im selben Lauf: neuer Block bei Breitenwechsel.
    assert_eq!(ifc_string("ä😀"), "'\\X2\\00E4\\X0\\\\X4\\0001F600\\X0\\'");
}

#[test]
fn reals_wie_tofixed() {
    assert_eq!(fmt_real(0.0), "0.0");
    assert_eq!(fmt_real(-0.0), "0.0");
    assert_eq!(fmt_real(1.0), "1.0");
    assert_eq!(fmt_real(100.0), "100.0");
    assert_eq!(fmt_real(0.00001), "0.00001");
    assert_eq!(fmt_real(-2.5), "-2.5");
    assert_eq!(fmt_real(0.1 + 0.2), "0.3");
    assert_eq!(fmt_real(2.6), "2.6");
    assert_eq!(fmt_real(-1e-9), "-0.0");
    assert_eq!(fmt_real(1e-9), "0.0");
    assert_eq!(fmt_real(0.999_999_6), "1.0");
    assert_eq!(fmt_real(2_600_000.123_456_7), "2600000.123457");
    // Gleichstand (exakt darstellbar): toFixed rundet auf, nicht auf gerade.
    assert_eq!(fmt_real(0.007_812_5), "0.007813");
    assert_eq!(fmt_real(0.023_437_5), "0.023438");
    assert_eq!(fmt_real(-0.007_812_5), "-0.007813");
    // Sehr grosse Werte (Langpfad).
    assert_eq!(fmt_real(1e15), "1000000000000000.0");
    assert_eq!(fmt_real(f64::NAN), "0.0");
}

#[test]
fn guid_wie_ts() {
    // Werte aus der TS-Fassung (Golden vom 28.10., Projekt-id "t").
    assert_eq!(ifc_guid("t/project"), "2fgJPaxQwDyuZfE6V6_Rif");
    assert_eq!(ifc_guid("t/site"), "3rG4QSmdUCaBHFz1QMCvjw");
    assert_eq!(ifc_guid("t/wall/W1"), "0n_zVrPdE0cg_UxWSd1GmA");
    assert_eq!(ifc_guid("t/wall/W1"), ifc_guid("t/wall/W1"));
    assert_ne!(ifc_guid("t/wall/W1"), ifc_guid("t/wall/W2"));
}

/// Baut flache Puffer für die Tests (Gegenstück zu `FlatIfc` in `exportIfc.ts`).
struct B {
    f: Vec<f64>,
    s: Vec<String>,
    /// 0 = IFC4, 1 = IFC2x3 (im META).
    schema: f64,
}
impl B {
    fn new() -> Self {
        B { f: vec![FLAT_VERSION], s: Vec::new(), schema: 0.0 }
    }
    fn v2() -> Self {
        B { schema: 1.0, ..B::new() }
    }
    /// META ab `has_geo`: Geo-Flag, Höhe, Breite/Länge (nur mit Geo), Versatz LV95 ([259]), Schema, Anzahl Geschosse.
    fn meta_tail(&mut self, geo: bool, elevation: f64, storeys: f64) {
        let (lat, lon) = if geo { (47.376_9, 8.541_7) } else { (f64::NAN, f64::NAN) };
        let (e, n) = if geo { (2_683_000.0, 1_247_000.0) } else { (0.0, 0.0) };
        self.f.extend([if geo { 1.0 } else { 0.0 }, elevation, lat, lon, e, n, self.schema, storeys]);
    }
    fn s(&mut self, x: &str) -> f64 {
        self.s.push(x.to_string());
        (self.s.len() - 1) as f64
    }
    fn n(&mut self, v: &[f64]) {
        self.f.extend_from_slice(v);
    }
    fn str(&mut self, x: &str) {
        let i = self.s(x);
        self.f.push(i);
    }
    fn pts(&mut self, p: &[(f64, f64)]) {
        self.f.push(p.len() as f64);
        for (x, y) in p {
            self.f.extend([*x, *y]);
        }
    }
    fn no_type(&mut self) {
        self.f.push(0.0);
    }
    /// OPENING-Datensatz (Gegenstück zu `FlatIfc.opening`), Füllung als Parameter.
    #[allow(clippy::too_many_arguments)]
    fn opening(&mut self, wall: &str, id: &str, is_door: bool, name: &str, void_pts: &[(f64, f64)], void_z: f64, depth: f64, width: f64, fill: &FillParams) {
        self.n(&[REC_OPENING]);
        self.str(wall);
        self.n(&[-1.0]);
        self.str(id);
        self.n(&[if is_door { 1.0 } else { 0.0 }]);
        self.str(name);
        self.pts(void_pts);
        self.n(&[void_z, depth, width]);
        self.fill(fill);
        self.no_psets();
    }
    fn opt(&mut self, v: Option<f64>) {
        self.n(&[if v.is_some() { 1.0 } else { 0.0 }, v.unwrap_or(0.0)]);
    }
    fn fill(&mut self, p: &FillParams) {
        self.n(&[p.wall_start.0, p.wall_start.1, p.wall_end.0, p.wall_end.1, p.from, p.to, p.z_bottom, p.z_top, p.n_lo, p.n_hi]);
        self.opt(p.frame_depth);
        self.opt(p.inset);
        self.n(&[if p.inset_outside { 1.0 } else { 0.0 }]);
        self.opt(p.frame_width);
        self.n(&[p.wing_count, p.panes as f64, p.sashes.len() as f64]);
        for s in &p.sashes {
            self.n(&[if s.post { 1.0 } else { 0.0 }]);
            self.opt(s.post_width);
            self.n(&[if s.fixed { 1.0 } else { 0.0 }]);
            self.opt(s.width);
        }
        let k = match p.door_kind {
            DoorKind::Swing => 0.0,
            DoorKind::Sliding => 1.0,
            DoorKind::WallOpening => 2.0,
            DoorKind::DoubleSwing => 3.0,
        };
        self.n(&[k, p.leaf_count, p.swing_sign, p.dir_sign, if p.hinge_at_start { 1.0 } else { 0.0 }, p.transom_height]);
        self.n(&[if p.glazed { 1.0 } else { 0.0 }]);
        self.opt(p.glazing_ratio);
    }
    fn wall_type(&mut self) {
        self.n(&[1.0, 0.0]);
        self.str("T1");
        self.str("Aussenwand");
        self.str("STANDARD");
        self.f.push(2.0);
        for (c, name, t) in [("c1", "Beton", 0.2), ("c2", "Dämmung", 0.12)] {
            self.str(c);
            self.str(name);
            self.f.push(t);
        }
    }
    fn ref_pset(&mut self, set: &str, v: &str) {
        self.f.push(1.0);
        self.str(set);
        self.f.push(1.0);
        self.str("Reference");
        self.f.push(0.0);
        self.str(v);
    }
    fn no_psets(&mut self) {
        self.f.push(0.0);
    }
    /// Ein Satz mit Mengen (`kind` 3 Länge, 4 Fläche, 5 Volumen).
    fn qto(&mut self, set: &str, q: &[(&str, f64, f64)]) {
        self.f.push(1.0);
        self.str(set);
        self.f.push(q.len() as f64);
        for (n, kind, v) in q {
            self.str(n);
            self.n(&[*kind, *v]);
        }
    }
    fn mesh_tetra(&mut self) {
        self.n(&[4.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        self.n(&[4.0, 0.0, 2.0, 1.0, 0.0, 1.0, 3.0, 1.0, 2.0, 3.0, 2.0, 0.0, 3.0]);
        self.f.push(1.0);
    }
    fn data(&self) -> (&[f64], String) {
        (&self.f, self.s.join("\0"))
    }
}

const SQUARE: [(f64, f64); 4] = [(0.0, 0.0), (5.0, 0.0), (5.0, 0.4), (0.0, 0.4)];

/// Ein Projekt mit je einem Bauteil jeder Art; zwei Wände gleichen Typs (Pset/Typ müssen sich teilen).
/// Füllungs-Parameter: Wand (sx, sy) → (ex, ey), Achs-Intervall, Höhen, Dicke ±0.2.
fn fill(is_door: bool, wall: [f64; 4], from: f64, to: f64, z0: f64, z1: f64) -> FillParams {
    FillParams {
        wall_start: (wall[0], wall[1]),
        wall_end: (wall[2], wall[3]),
        from,
        to,
        z_bottom: z0,
        z_top: z1,
        n_lo: -0.2,
        n_hi: 0.2,
        is_door,
        inset_outside: true,
        wing_count: 1.0,
        panes: 2,
        leaf_count: 1.0,
        swing_sign: 1.0,
        dir_sign: 1.0,
        hinge_at_start: true,
        ..Default::default()
    }
}

fn full_house(with_geo: bool) -> B {
    full_house_in(B::new(), with_geo)
}

fn full_house_in(mut b: B, with_geo: bool) -> B {
    b.str("t");
    b.str("Haus Ä");
    b.n(&[1_700_000_000.0]);
    b.str("2026-10-28T12:00:00");
    b.meta_tail(with_geo, if with_geo { 421.5 } else { f64::NAN }, 1.0);
    b.str("eg");
    b.str("Erdgeschoss");
    b.n(&[0.0]);
    for wid in ["W1", "W2"] {
        b.n(&[REC_WALL_SOLIDS, 0.0]);
        b.str(wid);
        b.str("Aussenwand");
        b.wall_type();
        b.ref_pset("Pset_WallCommon", "Aussenwand");
        // W1 mit Wandsystem (Achse, LayerSetUsage), W2 ohne (altes Verhalten).
        if wid == "W1" {
            b.n(&[1.0, 0.0, 0.0, 1.0, 0.0, 5.0, 1.0, -0.2]);
        } else {
            b.n(&[0.0]);
        }
        b.n(&[1.0]);
        b.pts(&SQUARE);
        b.n(&[0.0, 2.6]);
    }
    // Öffnung in W1: Tür mit Zarge, Blatt und Glas.
    // Scharnier am Ende, Aufschlag nach +Y: LEFT; Oberlicht gibt Glas.
    b.opening(
        "W1", "T1", true, "Haustür",
        &[(1.0, -0.02), (1.9, -0.02), (1.9, 0.42), (1.0, 0.42)], 0.0, 2.1, 0.9,
        &FillParams { hinge_at_start: false, transom_height: 0.4, ..fill(true, [0.0, 0.0, 5.0, 0.0], 1.0, 1.9, 0.0, 2.1) },
    );
    // Decke, Treppe, Extrusion.
    b.n(&[REC_CEILING, 0.0]);
    b.str("D1");
    b.str("Decke");
    b.no_type();
    b.no_psets();
    b.pts(&SQUARE);
    b.n(&[0.0, 2.6, 0.2]);
    b.n(&[REC_STAIR, 0.0]);
    b.str("S1");
    b.str("STRAIGHT_RUN_STAIR");
    b.pts(&SQUARE);
    b.n(&[0.0, 2.6]);
    b.no_psets();
    b.n(&[0.0, 0.0, 0.0, 0.0]);
    b.n(&[REC_EXTRUSION, -1.0]);
    b.str("X1");
    b.pts(&SQUARE);
    b.n(&[0.0, 1.0]);
    // Raum.
    b.n(&[REC_SPACE, 0.0]);
    b.str("R1");
    b.str("101");
    b.str("Wohnen");
    b.n(&[0.0, 2.5]);
    b.pts(&SQUARE);
    b.n(&[1.9, 2.0]);
    b.str("HNF");
    b.f.push(1.0);
    b.str("Pset_SpaceCommon");
    b.f.push(2.0);
    b.str("Reference");
    b.f.push(0.0);
    b.str("101");
    b.str("IsExternal");
    b.n(&[1.0, 0.0]);
    b.n(&[REC_END_SPACES]);
    // Dach mit Typ.
    b.n(&[REC_ROOF, 0.0]);
    b.str("Ro1");
    b.str("Satteldach");
    b.str("GABLE_ROOF");
    b.n(&[1.0, 2.0]);
    b.str("RT1");
    b.str("Satteldach");
    b.str("GABLE_ROOF");
    b.n(&[1.0]);
    b.str("c1");
    b.str("Beton");
    b.n(&[0.3]);
    b.ref_pset("Pset_RoofCommon", "Satteldach");
    b.mesh_tetra();
    // Stütze mit Material.
    b.n(&[REC_COLUMN, 0.0]);
    b.str("C1");
    b.str("Stütze 30");
    b.pts(&SQUARE);
    b.n(&[0.0, 2.6]);
    b.str("c1");
    b.str("Beton");
    b.ref_pset("Pset_ColumnCommon", "Stütze 30");
    b.n(&[REC_END_COLUMNS]);
    b
}

fn build(b: &B) -> Result<String, String> {
    let (f, s) = b.data();
    build_ifc(f, &s)
}

/// Jede `#n` ist definiert, keine Nummer doppelt, Nummern lückenlos ab 1.
fn check_structure(ifc: &str) {
    let mut defined = std::collections::HashSet::new();
    let mut order = Vec::new();
    for line in ifc.lines() {
        if let Some(rest) = line.strip_prefix('#') {
            let (num, _) = rest.split_once('=').expect("Entity ohne =");
            let n: usize = num.parse().expect("Nummer");
            assert!(defined.insert(n), "doppelte Nummer #{n}");
            order.push(n);
        }
    }
    assert!(order.iter().copied().eq(1..=order.len()), "Nummern nicht lückenlos");
    for line in ifc.lines().filter(|l| l.starts_with('#')) {
        let body = line.split_once('=').unwrap().1;
        let mut chars = body.chars().peekable();
        let mut in_str = false;
        while let Some(c) = chars.next() {
            if c == '\'' {
                in_str = !in_str;
            } else if c == '#' && !in_str {
                let mut num = String::new();
                while let Some(&d) = chars.peek() {
                    if d.is_ascii_digit() {
                        num.push(d);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let n: usize = num.parse().expect("Referenz");
                assert!(defined.contains(&n), "hängende Referenz #{n} in {line}");
            }
        }
    }
}

fn count(ifc: &str, ty: &str) -> usize {
    let head = format!("{ty}(");
    ifc.lines().filter(|l| l.split_once('=').is_some_and(|(_, b)| b.starts_with(&head))).count()
}

#[test]
fn volles_haus_ist_wohlgeformt() {
    let ifc = build(&full_house(true)).unwrap();
    assert!(ifc.starts_with("ISO-10303-21;\nHEADER;\n"));
    assert!(ifc.contains("FILE_SCHEMA(('IFC4'));"));
    assert!(ifc.ends_with("ENDSEC;\nEND-ISO-10303-21;\n"));
    assert!(ifc.is_ascii(), "Datei muss reines ASCII sein");
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCWALL"), 2);
    assert_eq!(count(&ifc, "IFCSLAB"), 1);
    assert_eq!(count(&ifc, "IFCROOF"), 1);
    assert_eq!(count(&ifc, "IFCCOLUMN"), 1);
    assert_eq!(count(&ifc, "IFCSTAIR"), 1);
    assert_eq!(count(&ifc, "IFCSPACE"), 1);
    assert_eq!(count(&ifc, "IFCDOOR"), 1);
    assert_eq!(count(&ifc, "IFCOPENINGELEMENT"), 1);
    assert_eq!(count(&ifc, "IFCRELVOIDSELEMENT"), 1);
    assert_eq!(count(&ifc, "IFCRELFILLSELEMENT"), 1);
    assert_eq!(count(&ifc, "IFCBUILDINGELEMENTPROXY"), 1);
    assert_eq!(count(&ifc, "IFCBUILDINGSTOREY"), 1);
    assert_eq!(count(&ifc, "IFCPROJECTEDCRS"), 1);
    assert_eq!(count(&ifc, "IFCMAPCONVERSION"), 1);
    // [259] Versatz des lokalen Ursprungs nach LV95, Höhe von ±0.00 = RefElevation.
    assert!(ifc.contains(",2683000.0,1247000.0,421.5,1.0,0.0,1.0);"), "IfcMapConversion mit Versatz");
    assert!(ifc.contains(",421.5,$,$);"), "RefElevation");
    assert!(ifc.contains("'Haus \\X2\\00C4\\X0\\'"));
    // Gleiche Wandtypen teilen Typ, Materialschichten und Pset.
    assert_eq!(count(&ifc, "IFCWALLTYPE"), 1);
    assert_eq!(count(&ifc, "IFCMATERIALLAYERSET"), 2); // Wandtyp + Dachtyp
    assert_eq!(count(&ifc, "IFCMATERIAL"), 2); // Beton (geteilt mit Dachtyp und Stütze) + Dämmung
    assert_eq!(count(&ifc, "IFCRELDEFINESBYTYPE"), 2);
    assert_eq!(count(&ifc, "IFCPROPERTYSET"), 5); // Wall, Space, Roof, Column + CH_Raum (Tür ohne Pset)
    // Eingliederung: Geschoss (Wände, Decke, Treppe, Tür, Dach, Stütze) und Gebäude (Extrusion).
    assert_eq!(count(&ifc, "IFCRELCONTAINEDINSPATIALSTRUCTURE"), 2);
    // Project→Site, Site→Building, Building→Storeys, Geschoss→Räume.
    assert_eq!(count(&ifc, "IFCRELAGGREGATES"), 4);
}

/// Zeile der ersten Entität eines Typs.
/// Pset-Kodierung mit Einträgen `(Name, Art, Wert)`; Art 0 = IfcIdentifier (Wert = Text), 4 = Fläche.
fn put_pset(b: &mut B, name: &str, props: &[(&str, f64, Result<&str, f64>)]) {
    b.f.push(1.0);
    b.str(name);
    b.f.push(props.len() as f64);
    for (n, kind, v) in props {
        b.str(n);
        b.f.push(*kind);
        match v {
            Ok(text) => b.str(text),
            Err(x) => b.f.push(*x),
        }
    }
}

/// Klassifikation (eBKP-H), Zone (SIA 416) und Geschoss-Mengen: Entitäten, Zuordnung, dauerhafte GUIDs.
#[test]
fn klassifikation_zone_und_geschossmengen() {
    let mut b = full_house(false);
    b.n(&[REC_ZONE]);
    b.str("sia416/HNF");
    b.str("HNF");
    b.str("Hauptnutzfläche");
    b.n(&[2.0]);
    b.str("R1");
    b.str("R9"); // unbekannt: übersprungen
    put_pset(&mut b, "CH_Zone", &[("SIA416", 0.0, Ok("HNF"))]);
    // Zweiter Satz im selben PSETS-Block geht nicht (Zahl steht vorn) — Mengen separat über ATTACH.
    b.n(&[REC_ATTACH]);
    b.str("zone/sia416/HNF");
    put_pset(&mut b, "CH_Qto_SIA416", &[("NetFloorArea", 4.0, Err(1.9))]);
    b.n(&[REC_ATTACH]);
    b.str("storey/eg");
    put_pset(&mut b, "Qto_BuildingStoreyBaseQuantities", &[("GrossFloorArea", 4.0, Err(2.4)), ("NetFloorArea", 4.0, Err(1.9))]);
    // Zone ohne auflösbaren Raum: nichts schreiben.
    b.n(&[REC_ZONE]);
    b.str("sia416/FF");
    b.str("FF");
    b.str("Funktionsfläche");
    b.n(&[1.0]);
    b.str("R9");
    b.f.push(0.0);
    b.n(&[REC_CLASSIFICATION]);
    b.str("eBKP-H");
    b.str("CRB");
    b.str("SN 506 511:2020");
    b.n(&[6.0]);
    for (k, code, name) in [
        ("wall/W1", "C", "Konstruktion Gebäude"),
        ("wall/W2", "C", "Konstruktion Gebäude"),
        ("fill/T1", "E", "Äussere Wandbekleidung Gebäude"),
        ("roof/Ro1", "F", "Bedachung Gebäude"),
        ("wall/Gibtsnicht", "C", "Konstruktion Gebäude"),
        ("space/R1", "", ""),
    ] {
        b.str(k);
        b.str(code);
        b.str(name);
    }
    // System ohne auflösbares Bauteil: nicht schreiben.
    b.n(&[REC_CLASSIFICATION]);
    b.str("Leer");
    b.str("");
    b.str("");
    b.n(&[1.0]);
    b.str("wall/nope");
    b.str("X");
    b.str("X");
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCCLASSIFICATION"), 1);
    // Codes C, E, F; der Eintrag ohne Code und der unbekannte Schlüssel fallen weg.
    assert_eq!(count(&ifc, "IFCCLASSIFICATIONREFERENCE"), 3);
    assert_eq!(count(&ifc, "IFCRELASSOCIATESCLASSIFICATION"), 3);
    let sys = first_line(&ifc, "IFCCLASSIFICATION");
    assert!(sys.contains("'CRB','SN 506 511:2020',$,'eBKP-H',$,$,$"), "{sys}");
    // Erste Beziehung (Code C): beide Wände.
    let rel_c = first_line(&ifc, "IFCRELASSOCIATESCLASSIFICATION");
    assert!(rel_c.contains(",(#") && rel_c.matches(",#").count() + rel_c.matches("(#").count() >= 3, "{rel_c}");
    assert_eq!(count(&ifc, "IFCZONE"), 1);
    assert_eq!(count(&ifc, "IFCRELASSIGNSTOGROUP"), 1);
    let zone = first_line(&ifc, "IFCZONE");
    assert!(zone.contains(",'HNF',$,$,'Hauptnutzfl\\X2\\00E4\\X0\\che'"), "{zone}");
    assert!(ifc.contains("'Qto_BuildingStoreyBaseQuantities'"));
    assert!(ifc.contains("'CH_Qto_SIA416'"));
    assert!(ifc.contains("'CH_Zone'"));
    // Dauerhaft: gleiche Eingabe, gleiche Datei.
    assert_eq!(ifc, build(&b).unwrap());
}

#[test]
fn klassifikation_leere_codes_wohlgeformt_und_ohne_zone_nichts() {
    // Ohne die neuen Datensätze ändert sich nichts: keine Klassifikation, keine Zone.
    let ifc = build(&full_house(false)).unwrap();
    assert_eq!(count(&ifc, "IFCCLASSIFICATION"), 0);
    assert_eq!(count(&ifc, "IFCZONE"), 0);
    // Abgeschnittene neue Datensätze: Fehler statt Panic.
    for cut in 1..6 {
        let mut b = full_house(false);
        b.n(&[REC_CLASSIFICATION]);
        b.str("a");
        b.str("b");
        b.str("c");
        b.n(&[3.0]);
        let n = b.f.len();
        b.f.truncate(n - cut.min(3));
        let (f, s) = b.data();
        let _ = build_ifc(f, &s); // darf Err sein, nie panicken
    }
}

fn first_line<'a>(ifc: &'a str, ty: &str) -> &'a str {
    let head = format!("{ty}(");
    ifc.lines().find(|l| l.split_once('=').is_some_and(|(_, b)| b.starts_with(&head))).unwrap_or_else(|| panic!("{ty} fehlt"))
}

/// Kopf (META) eines Mini-Projekts ohne Geschoss.
fn mini() -> B {
    mini_in(B::new())
}

fn mini_in(mut b: B) -> B {
    b.str("t");
    b.str("H");
    b.n(&[1_700_000_000.0]);
    b.str("2026-10-28T12:00:00");
    b.meta_tail(false, f64::NAN, 0.0);
    b
}

/// [T2] Bogenwand: Netz-Körper plus Achse als IfcTrimmedCurve auf IfcCircle (Uhrzeigersinn = .F.).
#[test]
fn bogenwand_mit_kreisachse() {
    let mut b = mini();
    b.n(&[REC_WALL_ARC, -1.0]);
    b.str("WA");
    b.str("Bogen");
    b.no_type();
    b.no_psets();
    b.n(&[2.5, 0.0, 2.5, std::f64::consts::PI, -std::f64::consts::PI]);
    b.mesh_tetra();
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCWALL"), 1);
    assert_eq!(count(&ifc, "IFCCIRCLE"), 1);
    let t = first_line(&ifc, "IFCTRIMMEDCURVE");
    assert!(t.contains("(IFCPARAMETERVALUE(3.141593)),(IFCPARAMETERVALUE(0.0)),.F.,.PARAMETER.);"), "{t}");
    assert!(ifc.contains("'Axis','Curve2D'"));
    // Ungültiger Radius: Fehler statt Panik.
    let mut b = mini();
    b.n(&[REC_WALL_ARC, -1.0]);
    b.str("WA");
    b.str("Bogen");
    b.no_type();
    b.no_psets();
    b.n(&[2.5, 0.0, 0.0, 0.0, 1.0]);
    b.mesh_tetra();
    assert!(build(&b).is_err());
}

/// [T2] Bogenwand als Profil-Extrusion: Kreisbögen in einer IfcCompositeCurve, Achse dazu.
#[test]
fn bogenwand_als_bogenprofil() {
    let mut b = mini();
    b.n(&[REC_WALL_ARC_SOLID, -1.0]);
    b.str("WA");
    b.str("Bogen");
    b.no_type();
    b.no_psets();
    b.n(&[2.5, 0.0, 2.5, std::f64::consts::PI, -std::f64::consts::PI]);
    // Halbkreisring r 2.4 … 2.6 um (5, 0): aussen im Gegenuhrzeigersinn, innen zurück im Uhrzeigersinn.
    b.n(&[1.0, 4.0, 7.6, 0.0, 1.0, 2.4, 0.0, 0.0, 2.6, 0.0, -1.0, 7.4, 0.0, 0.0, 0.0, 2.6]);
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCWALL"), 1);
    assert_eq!(count(&ifc, "IFCCOMPOSITECURVE("), 1);
    assert_eq!(count(&ifc, "IFCCOMPOSITECURVESEGMENT"), 4);
    assert_eq!(count(&ifc, "IFCCIRCLE"), 3, "zwei Profilbögen und die Achse");
    assert!(ifc.contains(",2.6);") && ifc.contains(",2.4);"), "Radien 2.6 und 2.4");
    assert!(ifc.contains(".F.,.PARAMETER.") && ifc.contains(".T.,.PARAMETER."));
    assert!(ifc.contains("'Body','SweptSolid'") && ifc.contains("'Axis','Curve2D'"));
    // Kaputtes Profil: Fehler statt Panik.
    let mut b = mini();
    b.n(&[REC_WALL_ARC_SOLID, -1.0]);
    b.str("WA");
    b.str("Bogen");
    b.no_type();
    b.no_psets();
    b.n(&[2.5, 0.0, 2.5, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
    assert!(build(&b).is_err());
}

#[test]
fn wand_mit_achse_und_layer_set_usage() {
    let ifc = build(&full_house(false)).unwrap();
    check_structure(&ifc);
    // Nur W1 hat Wandsystem: eine Usage, eine Axis-Darstellung, ein Axis-Kontext.
    assert_eq!(count(&ifc, "IFCMATERIALLAYERSETUSAGE"), 1);
    assert_eq!(count(&ifc, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT"), 1);
    let usage = first_line(&ifc, "IFCMATERIALLAYERSETUSAGE");
    assert!(usage.contains(".AXIS2.,.POSITIVE.,-0.2,$"), "{usage}");
    // Die Usage verweist auf das LayerSet des Typs (dasselbe wie die Typ-Zuordnung).
    let set_no: usize = usage.split("(#").nth(1).unwrap().split(',').next().unwrap().parse().unwrap();
    assert!(ifc.contains(&format!("#{set_no}=IFCMATERIALLAYERSET(")));
    // Axis: IfcPolyline von (0,0) nach (5,0) in Kurve2D.
    assert!(ifc.contains("'Axis','Curve2D'"));
    assert!(ifc.contains("IFCCARTESIANPOINT((5.0,0.0))"));
    assert!(ifc.contains("IFCDIRECTION((1.0,0.0,0.0))"));
}

#[test]
fn gedrehte_wand_rechnet_profil_und_oeffnung_ins_wandsystem() {
    // Wand von (10,20) nach (10,25): u = (0,1), linke Normale = (−1,0).
    let mut b = mini();
    b.n(&[REC_WALL_SOLIDS, -1.0]);
    b.str("W");
    b.str("Wand");
    b.no_type();
    b.no_psets();
    b.n(&[1.0, 10.0, 20.0, 0.0, 1.0, 5.0, 0.0, 0.0]);
    b.n(&[1.0]);
    b.pts(&[(10.2, 20.0), (10.2, 25.0), (9.8, 25.0), (9.8, 20.0)]);
    b.n(&[0.0, 2.6]);
    b.opening(
        "W", "O", false, "Fenster",
        &[(10.3, 21.0), (10.3, 22.0), (9.7, 22.0), (9.7, 21.0)], 0.9, 1.2, 1.0,
        &fill(false, [10.0, 20.0, 10.0, 25.0], 1.0, 2.0, 0.9, 2.1),
    );
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    // Wandprofil lokal: x = Länge entlang u, y = linke Normale (10.2 → −0.2, 9.8 → 0.2).
    assert!(ifc.contains("IFCCARTESIANPOINT((0.0,-0.2))"));
    assert!(ifc.contains("IFCCARTESIANPOINT((5.0,0.2))"));
    // Öffnung lokal bei x = 1…2, quer −0.3…0.3.
    assert!(ifc.contains("IFCCARTESIANPOINT((1.0,-0.3))"));
    assert!(ifc.contains("IFCCARTESIANPOINT((2.0,0.3))"));
    assert!(ifc.contains("IFCDIRECTION((0.0,1.0,0.0))"));
    // Ohne Typ keine Usage, trotzdem Axis.
    assert_eq!(count(&ifc, "IFCMATERIALLAYERSETUSAGE"), 0);
    assert!(ifc.contains("'Axis','Curve2D'"));
}

#[test]
fn tuer_hat_getrennte_koerper_mit_stilen_und_operation() {
    let ifc = build(&full_house(false)).unwrap();
    check_structure(&ifc);
    let door = first_line(&ifc, "IFCDOOR");
    assert!(door.contains(".DOOR.,.SINGLE_SWING_LEFT.,$);"), "{door}");
    // Zwölf Körper in EINER Darstellung, je ein IfcStyledItem, drei Stile (Rahmen, Blatt, Glas): Zarge und
    // Kämpfer je Querband (vor dem Blatt 2 Pfosten + Sturz + Kämpfer; im Blattband [105] um den Falz
    // ausgespart: 4 Pfostenstücke + Sturz + Kämpfer), Oberlicht-Glas, Blatt.
    assert_eq!(count(&ifc, "IFCSTYLEDITEM"), 12);
    assert_eq!(count(&ifc, "IFCSURFACESTYLE"), 3);
    assert_eq!(count(&ifc, "IFCSURFACESTYLERENDERING"), 3);
    assert!(ifc.contains("IFCSURFACESTYLE('Glas',.BOTH.,"));
    assert!(ifc.contains("IFCSURFACESTYLERENDERING(#"));
    let shapes = ifc.lines().filter(|l| l.contains("IFCSHAPEREPRESENTATION") && l.contains("'SweptSolid'") && l.matches('#').count() == 14).count();
    assert!(shapes >= 1, "Darstellung mit 12 Körpern fehlt");
    // Füllungs-Placement mit Richtung (0,1,0) relativ zur Öffnung; Ursprung lokal.
    assert!(ifc.contains("IFCCARTESIANPOINT((1.45,0.0,0.0))"));
}

#[test]
fn fenster_ohne_teile_hat_keine_darstellung_und_enum_ist_geprueft() {
    let mut b = full_house(false);
    let w1 = [0.0, 0.0, 5.0, 0.0];
    b.opening("W1", "F1", false, "Fenster", &SQUARE, 0.9, 1.2, 1.2, &FillParams { wing_count: 2.0, ..fill(false, w1, 2.0, 3.2, 0.9, 2.1) });
    b.opening("W1", "T2", true, "Wandöffnung", &SQUARE, 0.0, 2.1, 1.0, &FillParams { door_kind: DoorKind::WallOpening, ..fill(true, w1, 3.0, 4.0, 0.0, 2.1) });
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    let win = first_line(&ifc, "IFCWINDOW");
    assert!(win.contains(".WINDOW.,.DOUBLE_PANEL_VERTICAL.,$);"), "{win}");
    let hole = ifc.lines().filter(|l| l.contains("IFCDOOR(")).find(|l| l.contains(",$,$,2.1,1.0,.DOOR.,$,$);"));
    assert!(hole.is_some(), "Wandöffnung ohne Darstellung und Ausführung");
    // Kaputte Parameter: Fehler, nie Panic.
    let bad_params = [
        FillParams { panes: 0, ..fill(false, w1, 1.0, 2.0, 0.9, 2.1) },
        FillParams { swing_sign: 0.0, ..fill(true, w1, 1.0, 2.0, 0.0, 2.1) },
        FillParams { wing_count: f64::NAN, ..fill(false, w1, 1.0, 2.0, 0.9, 2.1) },
        FillParams { sashes: vec![Sash::default(); MAX_SASHES + 1], ..fill(false, w1, 1.0, 2.0, 0.9, 2.1) },
        // Wand ohne Länge: keine Richtung.
        fill(false, [1.0, 1.0, 1.0, 1.0], 0.0, 1.0, 0.0, 1.0),
    ];
    for p in bad_params {
        let mut bad = full_house(false);
        bad.opening("W1", "F9", false, "Fenster", &SQUARE, 0.9, 1.2, 1.2, &p);
        assert!(build(&bad).is_err(), "{p:?}");
    }
    // Unbekannte Türart.
    let mut bad = full_house(false);
    bad.opening("W1", "T9", true, "Tür", &SQUARE, 0.0, 2.1, 1.0, &fill(true, w1, 1.0, 2.0, 0.0, 2.1));
    let at = bad.f.len() - 1 /* psets */ - 3 /* glazed, ratio-opt */ - 6;
    bad.f[at] = 7.0;
    assert!(build(&bad).is_err());
}

#[test]
fn schiefe_achsrichtung_ist_fehler() {
    let mut b = mini();
    b.n(&[REC_WALL_SOLIDS, -1.0]);
    b.str("W");
    b.str("Wand");
    b.no_type();
    b.no_psets();
    b.n(&[1.0, 0.0, 0.0, 2.0, 0.0, 5.0, 0.0, 0.0, 0.0]);
    assert!(build(&b).is_err());
}

#[test]
fn ohne_georeferenz_und_deterministisch() {
    let b = full_house(false);
    let ifc = build(&b).unwrap();
    assert_eq!(count(&ifc, "IFCPROJECTEDCRS"), 0);
    assert!(!ifc.contains(",421.5,"));
    assert_eq!(ifc, build(&b).unwrap(), "zweimal bauen = gleiche Datei");
    // GlobalIds eindeutig.
    let mut seen = std::collections::HashSet::new();
    for l in ifc.lines().filter(|l| l.starts_with('#')) {
        let body = l.split_once('(').unwrap().1;
        if let Some(rest) = body.strip_prefix('\'') {
            if rest.len() > 22 && rest.as_bytes()[22] == b'\'' {
                assert!(seen.insert(rest[..22].to_string()), "doppelte GlobalId {}", &rest[..22]);
            }
        }
    }
    assert!(seen.len() > 20);
}

#[test]
fn basismengen_je_bauteil_eigen_mit_dauerhafter_guid() {
    let mut b = mini();
    for id in ["W1", "W2"] {
        b.n(&[REC_WALL_SOLIDS, -1.0]);
        b.str(id);
        b.str("Wand");
        b.no_type();
        b.qto("Qto_WallBaseQuantities", &[("Length", 3.0, 5.0), ("GrossSideArea", 4.0, 13.0), ("NetVolume", 5.0, 3.25), ("Width", 3.0, -1e-9)]);
        b.n(&[0.0, 1.0]);
        b.pts(&SQUARE);
        b.n(&[0.0, 2.6]);
    }
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    // Gleicher Inhalt, trotzdem je Wand ein eigener Satz (Mengen gehören dem Bauteil).
    assert_eq!(count(&ifc, "IFCELEMENTQUANTITY"), 2);
    assert_eq!(count(&ifc, "IFCPROPERTYSET"), 0);
    assert_eq!(count(&ifc, "IFCQUANTITYLENGTH"), 4);
    assert_eq!(count(&ifc, "IFCQUANTITYAREA"), 2);
    assert_eq!(count(&ifc, "IFCQUANTITYVOLUME"), 2);
    assert!(ifc.contains("IFCQUANTITYLENGTH('Length',$,$,5.0,$)"));
    assert!(ifc.contains("IFCQUANTITYAREA('GrossSideArea',$,$,13.0,$)"));
    assert!(ifc.contains("IFCQUANTITYVOLUME('NetVolume',$,$,3.25,$)"));
    // Negative (Rundungs-)Werte werden auf 0 geklemmt (IFC verlangt ≥ 0).
    assert!(ifc.contains("IFCQUANTITYLENGTH('Width',$,$,0.0,$)"));
    assert_eq!(count(&ifc, "IFCRELDEFINESBYPROPERTIES"), 2);
    let set = first_line(&ifc, "IFCELEMENTQUANTITY");
    assert!(set.contains("'Qto_WallBaseQuantities',$,$,("), "{set}");
    // Deterministisch, GUIDs verschieden je Wand.
    assert_eq!(ifc, build(&b).unwrap());
    let guids: Vec<&str> = ifc.lines().filter(|l| l.contains("=IFCELEMENTQUANTITY(")).map(|l| &l[l.find('(').unwrap() + 2..][..22]).collect();
    assert_eq!(guids.len(), 2);
    assert_ne!(guids[0], guids[1]);
    // Eine andere Reihenfolge der Bauteile ändert die GUIDs nicht.
    assert!(ifc.contains(&ifc_guid("t/wall/W1/Qto_WallBaseQuantities")));
    assert!(ifc.contains(&ifc_guid("t/wall/W2/Qto_WallBaseQuantities")));
}

#[test]
fn decke_mit_aussparung_hat_profil_mit_loechern() {
    let mut b = mini();
    b.n(&[REC_CEILING, -1.0]);
    b.str("D1");
    b.str("Decke");
    b.no_type();
    b.qto("Qto_SlabBaseQuantities", &[("GrossArea", 4.0, 2.0), ("NetArea", 4.0, 1.5)]);
    b.pts(&SQUARE);
    b.n(&[2.0]);
    b.pts(&[(1.0, 0.1), (2.0, 0.1), (2.0, 0.3), (1.0, 0.3)]);
    b.pts(&[(3.0, 0.1), (4.0, 0.1), (4.0, 0.3)]);
    b.n(&[2.6, 0.2]);
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCARBITRARYPROFILEDEFWITHVOIDS"), 1);
    assert_eq!(count(&ifc, "IFCARBITRARYCLOSEDPROFILEDEF"), 0);
    let prof = first_line(&ifc, "IFCARBITRARYPROFILEDEFWITHVOIDS");
    assert!(prof.contains(".AREA.,$,#"), "{prof}");
    // Aussen- und zwei Innenkurven, jede geschlossen (Punkt 1 wiederholt).
    assert_eq!(count(&ifc, "IFCPOLYLINE"), 3);
    assert_eq!(count(&ifc, "IFCEXTRUDEDAREASOLID"), 1);
    // Ohne Aussparung bleibt es das einfache Profil.
    let plain = build(&full_house(false)).unwrap();
    assert_eq!(count(&plain, "IFCARBITRARYPROFILEDEFWITHVOIDS"), 0);
}

/// [191] Decke mit Bogenkante und runder Aussparung: Profil als IfcCompositeCurve mit IfcTrimmedCurve/IfcCircle.
#[test]
fn decke_mit_bogenkante_hat_zusammengesetzte_kurve() {
    let mut b = mini();
    b.n(&[REC_CEILING_ARC, -1.0]);
    b.str("D1");
    b.str("Decke");
    b.no_type();
    b.qto("Qto_SlabBaseQuantities", &[("GrossArea", 4.0, 2.0), ("NetArea", 4.0, 1.5)]);
    // Quadrat, rechte Kante Halbkreis nach aussen (Scheitel rechts der Kante 1 -> 2 = negativer Bulge).
    b.n(&[4.0, 0.0, 0.0, 0.0, 2.0, 0.0, -1.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0]);
    b.n(&[1.0]);
    b.n(&[3.0, 0.2, 0.2, 0.0, 0.8, 0.2, 0.0, 0.5, 0.8, 0.0]);
    b.n(&[2.6, 0.2]);
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCARBITRARYPROFILEDEFWITHVOIDS"), 1);
    assert_eq!(count(&ifc, "IFCCOMPOSITECURVE("), 1);
    assert_eq!(count(&ifc, "IFCCOMPOSITECURVESEGMENT"), 4);
    assert_eq!(count(&ifc, "IFCCIRCLE"), 1);
    assert_eq!(count(&ifc, "IFCTRIMMEDCURVE"), 1);
    // Aussparung ohne Bögen bleibt Linienzug.
    assert_eq!(count(&ifc, "IFCPOLYLINE"), 4);
    // [259] Punkt und Winkel als Trimmung, massgebend der Winkel (ifcopenshell liess den Bogen sonst fallen).
    let t = first_line(&ifc, "IFCTRIMMEDCURVE");
    assert!(t.contains(",IFCPARAMETERVALUE(") && t.ends_with(".F.,.PARAMETER.);"), "{t}");
}

/// Treppe mit zwei Läufen (Prismen), Podest und Geländer (Mesh).
fn stair_with_parts(b: &mut B) {
    b.n(&[REC_STAIR, -1.0]);
    b.str("S1");
    b.str("QUARTER_TURN_STAIR");
    b.pts(&SQUARE);
    b.n(&[0.0, 2.6]);
    b.no_psets();
    b.n(&[2.0]);
    for (k, name) in ["Lauf 1", "Lauf 2"].iter().enumerate() {
        b.str(name);
        b.n(&[7.0, 7.0, 0.1857, 0.28]);
        b.str("STRAIGHT");
        if k == 0 {
            // Zwei Mengensätze: Basismengen + eigene Dossier-Mengen (Untersicht).
            b.f.push(2.0);
            for (set, (n, kind, v)) in [("Qto_StairFlightBaseQuantities", ("Length", 3.0, 2.0)), ("Dossier_Qto_StairFlight", ("SoffitArea", 4.0, 7.5))] {
                b.str(set);
                b.f.push(1.0);
                b.str(n);
                b.n(&[kind, v]);
            }
        } else {
            b.qto("Qto_StairFlightBaseQuantities", &[("Length", 3.0, 2.0), ("GrossVolume", 5.0, 1.0)]);
        }
        b.n(&[0.0, 2.0]);
        b.pts(&SQUARE);
        b.n(&[0.0, 0.2 * (k + 1) as f64]);
        b.pts(&SQUARE);
        b.n(&[0.5, 0.4]);
    }
    b.n(&[1.0]);
    b.str("Podest");
    b.pts(&SQUARE);
    b.n(&[0.0, 1.3]);
    b.no_psets();
    // zwei Geländer: Handlauf und [155] Absturzsicherung
    b.n(&[2.0]);
    b.str("Handlauf");
    b.str("HANDRAIL");
    b.no_psets();
    b.mesh_tetra();
    b.str("Absturzsicherung");
    b.str("GUARDRAIL");
    b.no_psets();
    b.mesh_tetra();
    b.n(&[1.0]);
    b.str("Spindel");
    b.pts(&SQUARE);
    b.n(&[0.0, 2.6]);
    b.qto("Qto_ColumnBaseQuantities", &[("NetVolume", 5.0, 0.1)]);
}

#[test]
fn treppe_mit_laeufen_podest_und_gelaender() {
    let b = full_house(false);
    let mut m = mini();
    stair_with_parts(&mut m);
    let ifc = build(&m).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCSTAIR"), 1);
    assert_eq!(count(&ifc, "IFCSTAIRFLIGHT"), 2);
    assert_eq!(count(&ifc, "IFCRAILING"), 2);
    assert!(ifc.contains(".GUARDRAIL.") && ifc.contains(".HANDRAIL."));
    assert_eq!(count(&ifc, "IFCSLAB"), 1);
    assert!(ifc.contains(".LANDING.);"), "Podest als IfcSlab(LANDING)");
    assert_eq!(count(&ifc, "IFCCOLUMN"), 1, "Spindel als IfcColumn");
    assert!(first_line(&ifc, "IFCCOLUMN").contains("'Spindel'"));
    let stair = first_line(&ifc, "IFCSTAIR");
    assert!(stair.contains(",$,$,.QUARTER_TURN_STAIR.);") && !stair.contains("#,#"), "{stair}");
    let flight = first_line(&ifc, "IFCSTAIRFLIGHT");
    assert!(flight.contains(",7,7,0.1857,0.28,.STRAIGHT.);"), "{flight}");
    // Beide Läufe + Spindel: Menge je Teil; Treppe, Läufe, Podest, Geländer, Spindel in EINER Aggregation, nur die Treppe im Geschoss/Gebäude.
    assert_eq!(count(&ifc, "IFCELEMENTQUANTITY"), 4);
    assert!(ifc.contains("IFCQUANTITYAREA('SoffitArea',$,$,7.5,$)"), "Dossier_Qto_… als Menge");
    assert_eq!(count(&ifc, "IFCPROPERTYSINGLEVALUE"), 0);
    let agg = ifc.lines().find(|l| l.contains("IFCRELAGGREGATES(") && l.matches('#').count() == 9).expect("Aggregation der Treppe");
    assert!(agg.contains(",#"), "{agg}");
    let contained = first_line(&ifc, "IFCRELCONTAINEDINSPATIALSTRUCTURE");
    assert_eq!(contained.matches('#').count(), 4, "nur die Treppe (Nummer, Owner, Treppe, Gebäude): {contained}");
    // Läufe als Prismen, Geländer als Dreiecks-Netz.
    assert_eq!(count(&ifc, "IFCEXTRUDEDAREASOLID"), 6); // 2 Läufe × 2 Prismen + Podest + Spindel
    assert_eq!(count(&ifc, "IFCTRIANGULATEDFACESET"), 2);
    // Ohne Teile: Ersatzkörper (Fussabdruck) wie vorher.
    let fallback = build(&b).unwrap();
    assert_eq!(count(&fallback, "IFCSTAIRFLIGHT"), 0);
    assert_eq!(count(&fallback, "IFCSTAIR"), 1);
    // Lauf mit Mesh-Form.
    let mut g = mini();
    g.n(&[REC_STAIR, -1.0]);
    g.str("S2");
    g.str("STRAIGHT_RUN_STAIR");
    g.pts(&SQUARE);
    g.n(&[0.0, 2.6]);
    g.no_psets();
    g.n(&[1.0]);
    g.str("Lauf");
    g.n(&[15.0, 14.0, 0.17, 0.29]);
    g.str("STRAIGHT");
    g.no_psets();
    g.n(&[1.0]);
    g.mesh_tetra();
    g.n(&[0.0, 0.0, 0.0]);
    let mesh = build(&g).unwrap();
    check_structure(&mesh);
    assert_eq!(count(&mesh, "IFCSTAIRFLIGHT"), 1);
    assert_eq!(count(&mesh, "IFCTRIANGULATEDFACESET"), 1);
    // Kaputte Lauf-Form: Fehler, nie Panic.
    let mut bad = mini();
    bad.n(&[REC_STAIR, -1.0]);
    bad.str("S3");
    bad.str("STRAIGHT_RUN_STAIR");
    bad.pts(&SQUARE);
    bad.n(&[0.0, 2.6]);
    bad.no_psets();
    bad.n(&[1.0]);
    bad.str("Lauf");
    bad.n(&[1.0, 1.0, 0.17, 0.29]);
    bad.str("STRAIGHT");
    bad.no_psets();
    bad.n(&[9.0]);
    assert!(build(&bad).is_err());
}

fn full_house_2x3(with_geo: bool) -> String {
    build(&full_house_in(B::v2(), with_geo)).unwrap()
}

/// GlobalId (erster Parameter) der ersten Entität eines Typs.
fn guid_of(ifc: &str, ty: &str) -> String {
    let l = first_line(ifc, ty);
    l[l.find('(').unwrap() + 2..][..22].to_string()
}

#[test]
fn ifc2x3_kopf_und_entitaeten() {
    let ifc = full_house_2x3(true);
    assert!(ifc.contains("FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');"));
    assert!(ifc.contains("FILE_SCHEMA(('IFC2X3'));"));
    assert!(ifc.is_ascii());
    check_structure(&ifc);
    // Nur Entitäten, die es in IFC2x3 gibt.
    for gone in ["IFCTRIANGULATEDFACESET", "IFCCARTESIANPOINTLIST3D", "IFCROOFTYPE", "IFCMAPCONVERSION", "IFCPROJECTEDCRS"] {
        assert_eq!(count(&ifc, gone), 0, "{gone}");
    }
    // W1 hat Achse + Usage (StandardCase), W2 nicht (IfcWall).
    assert_eq!(count(&ifc, "IFCWALLSTANDARDCASE"), 1);
    assert_eq!(count(&ifc, "IFCWALL"), 1);
    assert_eq!(count(&ifc, "IFCMATERIALLAYERSETUSAGE"), 1);
    assert!(first_line(&ifc, "IFCMATERIALLAYERSETUSAGE").ends_with(".AXIS2.,.POSITIVE.,-0.2);"));
    // Wand ohne PredefinedType (8 Attribute), Stütze ebenso.
    assert!(first_line(&ifc, "IFCWALL").ends_with(",$);") && first_line(&ifc, "IFCWALL").matches(',').count() == 7, "{}", first_line(&ifc, "IFCWALL"));
    assert!(first_line(&ifc, "IFCCOLUMN").ends_with(",$);"), "{}", first_line(&ifc, "IFCCOLUMN"));
    // Material-Schicht und -Satz in der kurzen 2x3-Form.
    assert!(first_line(&ifc, "IFCMATERIAL").ends_with("');") && !first_line(&ifc, "IFCMATERIAL").contains(",$,$"));
    assert!(first_line(&ifc, "IFCMATERIALLAYER").ends_with(",$);") && first_line(&ifc, "IFCMATERIALLAYER").matches(',').count() == 2);
    // Tür: nur Höhe und Breite; Ausführung im IfcDoorStyle, verbunden über IfcRelDefinesByType.
    let door = first_line(&ifc, "IFCDOOR");
    assert!(door.ends_with(",$,2.1,0.9);"), "{door}");
    let style = first_line(&ifc, "IFCDOORSTYLE");
    assert!(style.contains(",$,$,$,$,$,.SINGLE_SWING_LEFT.,.NOTDEFINED.,.F.,.F.);"), "{style}");
    assert_eq!(count(&ifc, "IFCWINDOWSTYLE"), 0);
    assert_eq!(count(&ifc, "IFCRELDEFINESBYTYPE"), 2); // Wandtyp + Türstil
    // Öffnung ohne PredefinedType; Raum, Treppe, Dach in der 2x3-Form.
    assert!(first_line(&ifc, "IFCOPENINGELEMENT").ends_with(",$);") && !first_line(&ifc, "IFCOPENINGELEMENT").contains(".OPENING."));
    assert!(first_line(&ifc, "IFCROOF").ends_with(".GABLE_ROOF.);"));
    assert!(first_line(&ifc, "IFCSTAIR").ends_with(".STRAIGHT_RUN_STAIR.);"));
    // Dach: Netz als Brep (dicht), Schichten direkt am Dach (kein Typ).
    assert_eq!(count(&ifc, "IFCFACETEDBREP"), 1);
    assert_eq!(count(&ifc, "IFCCLOSEDSHELL"), 1);
    assert_eq!(count(&ifc, "IFCFACE"), 4);
    assert_eq!(count(&ifc, "IFCPOLYLOOP"), 4);
    assert!(ifc.contains("'Body','Brep'"));
    assert_eq!(count(&ifc, "IFCRELASSOCIATESMATERIAL"), 4); // Wandtyp, Usage, Dachschichten, Stütze
    // Stile der Teilrollen über IfcPresentationStyleAssignment.
    assert_eq!(count(&ifc, "IFCPRESENTATIONSTYLEASSIGNMENT"), 3);
    // Mengen ohne Formula.
    assert!(first_line(&ifc, "IFCQUANTITYAREA").ends_with(",$,$,1.9);"), "{}", first_line(&ifc, "IFCQUANTITYAREA"));
}

#[test]
fn ifc2x3_georeferenz_ueber_site_und_epset() {
    let ifc = full_house_2x3(true);
    let site = first_line(&ifc, "IFCSITE");
    assert!(site.contains(".ELEMENT.,(47,22,36,840000),(8,32,30,120000),421.5,$,$);"), "{site}");
    assert!(ifc.contains("'ePSet_ProjectedCRS'") && ifc.contains("'ePSet_MapConversion'"));
    assert!(ifc.contains("IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$)"));
    assert!(ifc.contains("IFCPROPERTYSINGLEVALUE('Scale',$,IFCREAL(1.0),$)"));
    // Ohne Georeferenz keine Winkel und keine Sätze.
    let plain = full_house_2x3(false);
    assert!(first_line(&plain, "IFCSITE").contains(".ELEMENT.,$,$,$,$,$);"));
    assert!(!plain.contains("ePSet_"));
    // IFC4 behält CRS + Abbildung und schreibt keine Winkel.
    let v4 = build(&full_house(true)).unwrap();
    assert!(first_line(&v4, "IFCSITE").contains(".ELEMENT.,$,$,421.5,$,$);"));
    assert!(!v4.contains("ePSet_"));
}

#[test]
fn winkel_in_grad_minuten_sekunden() {
    assert_eq!(compound_angle(47.376_9, 90.0), "(47,22,36,840000)");
    assert_eq!(compound_angle(-0.5, 90.0), "(0,-30,0,0)");
    assert_eq!(compound_angle(-47.5, 90.0), "(-47,-30,0,0)");
    assert_eq!(compound_angle(0.0, 90.0), "(0,0,0,0)");
    // Kein Überlauf auf 60 Sekunden: 59.9999999° rundet sauber hoch.
    assert_eq!(compound_angle(10.999_999_999_9, 90.0), "(11,0,0,0)");
    assert_eq!(compound_angle(1000.0, 90.0), "(90,0,0,0)");
}

#[test]
fn ifc2x3_gleiche_guids_wie_ifc4() {
    let (a, b) = (build(&full_house(true)).unwrap(), full_house_2x3(true));
    for ty in ["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSLAB", "IFCSPACE", "IFCROOF", "IFCCOLUMN", "IFCSTAIR", "IFCDOOR", "IFCOPENINGELEMENT", "IFCWALLTYPE", "IFCELEMENTQUANTITY"] {
        assert_eq!(guid_of(&a, ty), guid_of(&b, ty), "{ty}");
    }
    // Wand W1: StandardCase trägt die GlobalId des IfcWall.
    assert_eq!(guid_of(&b, "IFCWALLSTANDARDCASE"), ifc_guid("t/wall/W1"));
    assert_eq!(b, full_house_2x3(true));
}

/// [103]/[G3] Öffnungskörper als gedrehte Profil-Extrusion im Dach, Füllung als Netz.
#[test]
fn dachfenster_oeffnungskoerper() {
    for v2 in [false, true] {
        let mut b = mini_in(if v2 { B::v2() } else { B::new() });
        b.n(&[REC_ROOF, -1.0]);
        b.str("R");
        b.str("Dach");
        b.str("GABLE_ROOF");
        b.no_type();
        b.no_psets();
        b.n(&[4.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0]);
        b.n(&[2.0, 0.0, 1.0, 2.0, 0.0, 2.0, 3.0]);
        b.f.push(0.0);
        b.n(&[REC_OPENING_SOLID]);
        b.str("roof/R");
        b.n(&[-1.0]);
        b.str("DF");
        b.n(&[0.0]);
        b.str("Dachfenster");
        b.pts(&[(0.0, 0.0), (0.78, 0.0), (0.78, 1.18), (0.0, 1.18)]);
        b.n(&[0.1, 0.2, 0.3, 1.0, 0.0, 0.0, 0.0, 0.5, -0.866, 1.3, 1.18, 0.78]);
        b.no_psets();
        b.n(&[3.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 2.0, 0.0]);
        // Unbekannter Wirt: übersprungen.
        b.n(&[REC_OPENING_SOLID]);
        b.str("roof/X");
        b.n(&[-1.0]);
        b.str("DX");
        b.n(&[0.0]);
        b.str("x");
        b.pts(&[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]);
        b.n(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]);
        b.no_psets();
        b.n(&[0.0, 0.0, 0.0]);
        let ifc = build(&b).unwrap();
        check_structure(&ifc);
        assert_eq!(count(&ifc, "IFCOPENINGELEMENT"), 1);
        assert_eq!(count(&ifc, "IFCWINDOW"), 1);
        assert_eq!(count(&ifc, "IFCRELVOIDSELEMENT"), 1);
        assert_eq!(count(&ifc, "IFCRELFILLSELEMENT"), 1);
        assert!(ifc.contains("IFCDIRECTION((0.0,0.5,-0.866))"), "Extrusionsrichtung = −Normale");
        assert_eq!(count(&ifc, "IFCARBITRARYCLOSEDPROFILEDEF"), 1);
    }
}

#[test]
fn ifc2x3_offenes_netz_ist_shell_based_surface_model() {
    let mut b = mini_in(B::v2());
    b.n(&[REC_ROOF, -1.0]);
    b.str("R");
    b.str("Dach");
    b.str("FLAT_ROOF");
    b.no_type();
    b.no_psets();
    // Zwei Dreiecke (offen) plus ein entartetes (doppelte Ecke).
    b.n(&[4.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0]);
    b.n(&[3.0, 0.0, 1.0, 2.0, 0.0, 2.0, 3.0, 0.0, 0.0, 1.0]);
    b.f.push(0.0);
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCSHELLBASEDSURFACEMODEL"), 1);
    assert_eq!(count(&ifc, "IFCOPENSHELL"), 1);
    assert_eq!(count(&ifc, "IFCFACE"), 2);
    assert_eq!(count(&ifc, "IFCCARTESIANPOINT"), 6); // Ursprung, 4 Ecken (je einmal), Placement
    assert!(ifc.contains("'Body','SurfaceModel'"));
    assert_eq!(count(&ifc, "IFCFACETEDBREP"), 0);
}

/// [149] Baum: IFC4 IfcGeographicElement (USERDEFINED, ObjectType „Baum"), IFC2x3 IfcBuildingElementProxy;
/// Netz und Höhe (Mengen) am Element, GlobalId aus `tree/<id>`.
#[test]
fn baum_als_geografisches_element() {
    for v2 in [false, true] {
        let mut b = mini_in(if v2 { B::v2() } else { B::new() });
        b.n(&[REC_TREE, -1.0]);
        b.str("T1");
        b.str("Quercus robur");
        b.qto("Dossier_Qto_Tree", &[("Height", 3.0, 12.0), ("CrownDiameter", 3.0, 6.0)]);
        // Tetraeder (geschlossen).
        b.n(&[4.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 12.0]);
        b.n(&[4.0, 0.0, 2.0, 1.0, 0.0, 1.0, 3.0, 1.0, 2.0, 3.0, 0.0, 3.0, 2.0, 0.0]);
        let ifc = build(&b).unwrap();
        check_structure(&ifc);
        let (ty, other) = if v2 { ("IFCBUILDINGELEMENTPROXY", "IFCGEOGRAPHICELEMENT") } else { ("IFCGEOGRAPHICELEMENT", "IFCBUILDINGELEMENTPROXY") };
        assert_eq!(count(&ifc, ty), 1, "{ifc}");
        assert_eq!(count(&ifc, other), 0);
        let line = ifc.lines().find(|l| l.contains(&format!("={ty}("))).unwrap();
        assert!(line.contains("'Quercus robur'") && line.contains("'Baum'"), "{line}");
        assert_eq!(line.ends_with(".USERDEFINED.);"), !v2, "{line}");
        assert!(line.contains(&ifc_guid("t/tree/T1")), "{line}");
        assert!(ifc.contains("'Height'") && ifc.contains("IFCQUANTITYLENGTH"));
        assert_eq!(count(&ifc, "IFCRELCONTAINEDINSPATIALSTRUCTURE"), 1);
    }
}

/// [259] Kontext: Gelände als IfcGeographicElement TERRAIN, Nachbar als Proxy „Kontext"; beide am IfcSite (eigene
/// Eingliederung, nicht im Gebäude/Geschoss), Klasse als Beschreibung. IFC2x3: beide als Proxy.
#[test]
fn kontext_am_grundstueck() {
    for v2 in [false, true] {
        let mut b = mini_in(if v2 { B::v2() } else { B::new() });
        for (kind, id, name, class) in [(1.0, "T", "Gelände", "02 Gelände"), (0.0, "N", "Nachbargebäude", "12 Gebäude")] {
            b.n(&[REC_CONTEXT, kind]);
            b.str(id);
            b.str(name);
            b.str(class);
            b.n(&[3.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 1.0]);
            b.n(&[1.0, 0.0, 1.0, 2.0, 0.0]);
        }
        let ifc = build(&b).unwrap();
        check_structure(&ifc);
        let site = ifc.lines().find(|l| l.contains("=IFCSITE(")).unwrap().split('=').next().unwrap().to_string();
        let terrain = ifc.lines().find(|l| l.contains(&ifc_string("Gelände")) && l.contains(&ifc_guid("t/context/T"))).unwrap();
        let neighbour = ifc.lines().find(|l| l.contains(&ifc_guid("t/context/N"))).unwrap();
        if v2 {
            assert!(terrain.contains("=IFCBUILDINGELEMENTPROXY(") && terrain.ends_with(",$);"), "{terrain}");
            assert_eq!(count(&ifc, "IFCGEOGRAPHICELEMENT"), 0);
        } else {
            assert!(terrain.contains("=IFCGEOGRAPHICELEMENT(") && terrain.ends_with(".TERRAIN.);"), "{terrain}");
            assert!(neighbour.contains("=IFCBUILDINGELEMENTPROXY(") && neighbour.ends_with(".USERDEFINED.);"), "{neighbour}");
        }
        assert!(neighbour.contains(&format!("{},'Kontext'", ifc_string("12 Gebäude"))), "{neighbour}");
        let contains: Vec<&str> = ifc.lines().filter(|l| l.contains("=IFCRELCONTAINEDINSPATIALSTRUCTURE(")).collect();
        assert_eq!(contains.len(), 1, "nur der Kontext ist eingegliedert");
        assert!(contains[0].ends_with(&format!(",{site});")), "{}", contains[0]);
        assert!(contains[0].contains(&ifc_guid("t/contains/site")));
    }
}

#[test]
fn ifc2x3_fenster_stil_klassifikation_zone_treppe() {
    let mut b = full_house_in(B::v2(), false);
    let w1 = [0.0, 0.0, 5.0, 0.0];
    b.opening("W1", "F1", false, "Fenster", &SQUARE, 0.9, 1.2, 1.2, &FillParams { wing_count: 2.0, ..fill(false, w1, 2.0, 3.2, 0.9, 2.1) });
    b.opening("W1", "T2", true, "Wandöffnung", &SQUARE, 0.0, 2.1, 1.0, &FillParams { door_kind: DoorKind::WallOpening, ..fill(true, w1, 3.0, 4.0, 0.0, 2.1) });
    b.n(&[REC_ZONE]);
    b.str("sia416/HNF");
    b.str("HNF");
    b.str("Hauptnutzfläche");
    b.n(&[1.0]);
    b.str("R1");
    b.f.push(0.0);
    b.n(&[REC_CLASSIFICATION]);
    b.str("eBKP-H");
    b.str("");
    b.str("");
    b.n(&[1.0]);
    b.str("wall/W1");
    b.str("C");
    b.str("Konstruktion");
    stair_with_parts(&mut b);
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    let win = first_line(&ifc, "IFCWINDOWSTYLE");
    assert!(win.contains(",$,$,$,$,$,.NOTDEFINED.,.DOUBLE_PANEL_VERTICAL.,.F.,.F.);"), "{win}");
    // Wandöffnung: Tür ohne Ausführung → Stil NOTDEFINED; Tür 1 hat eigenen Stil.
    assert_eq!(count(&ifc, "IFCDOORSTYLE"), 2);
    assert!(ifc.contains(",.NOTDEFINED.,.NOTDEFINED.,.F.,.F.);"));
    let hole = ifc.lines().find(|l| l.contains("IFCDOOR(") && l.contains(",$,$,2.1,1.0);"));
    assert!(hole.is_some());
    // Klassifikation: Pflichtfelder als '', keine IFC4-Zusatzfelder.
    assert!(first_line(&ifc, "IFCCLASSIFICATION").ends_with("('','',$,'eBKP-H');") || first_line(&ifc, "IFCCLASSIFICATION").contains("'','',$,'eBKP-H');"), "{}", first_line(&ifc, "IFCCLASSIFICATION"));
    assert!(first_line(&ifc, "IFCCLASSIFICATIONREFERENCE").contains("$,'C','Konstruktion',#"), "{}", first_line(&ifc, "IFCCLASSIFICATIONREFERENCE"));
    assert!(!first_line(&ifc, "IFCCLASSIFICATIONREFERENCE").ends_with(",$,$);"));
    // Zone: Langname als Beschreibung.
    assert!(first_line(&ifc, "IFCZONE").contains(",'HNF','Hauptnutzfl\\X2\\00E4\\X0\\che',$);"), "{}", first_line(&ifc, "IFCZONE"));
    // Treppenlauf: NumberOfRiser… ohne PredefinedType.
    assert!(first_line(&ifc, "IFCSTAIRFLIGHT").ends_with(",7,7,0.1857,0.28);"), "{}", first_line(&ifc, "IFCSTAIRFLIGHT"));
    assert_eq!(count(&ifc, "IFCTRIANGULATEDFACESET"), 0);
    assert_eq!(count(&ifc, "IFCFACETEDBREP"), 3); // Dach + zwei Geländer (Handlauf, Absturzsicherung)
}

#[test]
fn unbekanntes_schema_ist_fehler() {
    let mut b = mini();
    let n = b.f.len();
    b.f[n - 2] = 2.0;
    assert!(build(&b).is_err());
    b.f[n - 2] = 0.5;
    assert!(build(&b).is_err());
}

#[test]
fn leeres_projekt_ist_gueltig() {
    let mut b = B::new();
    b.str("p");
    b.str("");
    b.n(&[1.0]);
    b.str("iso");
    b.meta_tail(false, f64::NAN, 0.0);
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert!(ifc.contains("IFCPROJECT('"));
    assert!(ifc.contains("'Projekt'") && ifc.contains("'Geb\\X2\\00E4\\X0\\ude'"));
    assert!(ifc.contains("FILE_NAME('modell.ifc'"));
    assert_eq!(count(&ifc, "IFCBUILDINGSTOREY"), 0);
    assert_eq!(count(&ifc, "IFCRELAGGREGATES"), 2);
}

/// [208] Leerer Zeitstempel = anonyme Abgabe: weder Programm noch Person noch aktuelle Zeit im Kopf und in der Owner-History.
#[test]
fn anonyme_abgabe_ohne_erzeuger_und_zeit() {
    let mut b = B::new();
    b.str("p");
    b.str("FALKE 7");
    b.n(&[946_684_800.0]);
    b.str("");
    b.meta_tail(false, f64::NAN, 0.0);
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert!(!ifc.to_lowercase().contains("dossier"), "{ifc}");
    assert!(ifc.contains("FILE_NAME('FALKE 7.ifc','2000-01-01T00:00:00',(''),(''),'','',''"));
    assert!(ifc.contains("IFCORGANIZATION($,'-'") && ifc.contains("IFCAPPLICATION(#"));
    assert!(ifc.contains("IFCPROJECT('") && ifc.contains("'FALKE 7'"));
}

#[test]
fn oeffnung_ohne_wirtswand_wird_uebersprungen() {
    let mut b = B::new();
    b.str("p");
    b.str("x");
    b.n(&[1.0]);
    b.str("iso");
    b.meta_tail(false, f64::NAN, 0.0);
    b.opening("gibt-es-nicht", "O1", false, "Fenster", &SQUARE, 0.0, 1.0, 1.0, &fill(false, [0.0, 0.0, 5.0, 0.0], 0.0, 1.0, 0.0, 1.0));
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCOPENINGELEMENT"), 0);
}

#[test]
fn kaputte_puffer_ergeben_fehler_nie_panic() {
    assert!(build_ifc(&[], "").is_err());
    assert!(build_ifc(&[2.0], "").is_err());
    assert!(build_ifc(&[FLAT_VERSION], "").is_err()); // META fehlt
    assert!(build_ifc(&[FLAT_VERSION, 0.0, 0.0, f64::NAN], "a\0b").is_err());
    assert!(build_ifc(&[FLAT_VERSION, 5.0], "a").is_err()); // Zeichenketten-Index ausserhalb
    let b = full_house(true);
    let (f, s) = b.data();
    // An jeder Stelle abgeschnitten: nie Panic (Fehler oder, auf Datensatzgrenzen, Erfolg).
    for n in 0..f.len() {
        let _ = build_ifc(&f[..n], &s);
    }
    // Jedes Element einzeln verdorben (NaN, ∞, −1, riesig, gebrochen): nie Panic.
    for i in 0..f.len() {
        for bad in [f64::NAN, f64::INFINITY, -1.0, 1e30, 0.5] {
            let mut g = f.to_vec();
            g[i] = bad;
            let _ = build_ifc(&g, &s);
        }
    }
    // Dasselbe im Schema IFC2x3 (eigene Zweige für Netze, Stile, Zonen, Klassifikation).
    let b = full_house_in(B::v2(), true);
    let (f, s) = b.data();
    for n in 0..f.len() {
        let _ = build_ifc(&f[..n], &s);
    }
    for i in 0..f.len() {
        for bad in [f64::NAN, f64::INFINITY, -1.0, 1e30, 0.5] {
            let mut g = f.to_vec();
            g[i] = bad;
            let _ = build_ifc(&g, &s);
        }
    }
    // Unbekannter Datensatz, Geschoss-Index ausserhalb, Dreiecks-Index ausserhalb.
    let mut g = vec![FLAT_VERSION, 0.0, 0.0, 1.0, 0.0, 0.0, f64::NAN, f64::NAN, f64::NAN, 0.0, 0.0, 0.0, 0.0, 99.0];
    assert!(build_ifc(&g, "a").is_err());
    g[13] = REC_STAIR;
    g.extend([3.0]);
    assert!(build_ifc(&g, "a").is_err());
    let mut m = B::new();
    m.str("p");
    m.str("x");
    m.n(&[1.0]);
    m.str("i");
    m.meta_tail(false, f64::NAN, 0.0);
    m.n(&[REC_ROOF, -1.0]);
    m.str("R");
    m.str("R");
    m.str("FLAT_ROOF");
    m.no_type();
    m.no_psets();
    m.n(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]); // Index 1 bei nur 1 Punkt
    let (f, s) = m.data();
    assert!(build_ifc(f, &s).is_err());
}

/// [141] Stütze mit zwei Höhenabschnitten: EIN IfcColumn, zwei Extrusionen in einer Darstellung; die
/// Mengen (Volumen = Summe) stehen im Qto.
#[test]
fn stuetze_mit_hoehenabschnitten() {
    let mut b = mini();
    b.n(&[REC_COLUMN_PIECES, -1.0]);
    b.str("C2");
    b.str("Stütze 30");
    b.n(&[2.0]);
    b.pts(&SQUARE);
    b.n(&[0.0, 1.5]);
    b.pts(&SQUARE);
    b.n(&[1.5, 1.1]);
    b.str("c1");
    b.str("Beton");
    b.qto("Qto_ColumnBaseQuantities", &[("NetVolume", 5.0, 0.27)]);
    b.n(&[REC_END_COLUMNS]);
    let ifc = build(&b).unwrap();
    check_structure(&ifc);
    assert_eq!(count(&ifc, "IFCCOLUMN"), 1);
    assert_eq!(count(&ifc, "IFCEXTRUDEDAREASOLID"), 2, "eine Extrusion je Höhenabschnitt");
    assert_eq!(count(&ifc, "IFCSHAPEREPRESENTATION"), 1, "eine Darstellung für beide Extrusionen");
    assert!(ifc.contains("IFCQUANTITYVOLUME('NetVolume'") && ifc.contains("0.27"), "Summenvolumen");
    assert_eq!(count(&ifc, "IFCRELASSOCIATESMATERIAL"), 1);
    // Zweiter Abschnitt sitzt 1.5 m über dem ersten.
    assert!(ifc.contains("IFCCARTESIANPOINT((0.0,0.0,1.5))"), "Versatz des oberen Abschnitts");
}

/// [259] Dreieckssuppe → verbundenes Netz: gleiche Ecken (auf 6 Stellen) einmal, Dreieck mit doppelter Ecke fällt weg.
#[test]
fn netz_wird_verschweisst() {
    let soup = Mesh {
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.000_000_1, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0, 5.0, 5.0],
        indices: vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
        closed: true,
    };
    let m = weld(&soup);
    assert_eq!(m.positions.len() / 3, 4, "{:?}", m.positions);
    assert_eq!(m.indices, vec![0, 1, 2, 1, 3, 2]);
    assert!(m.closed);
}
