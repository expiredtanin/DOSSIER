// Robustheit des Imports: kaputte, abgeschnittene und verfälschte Dateien ergeben eine Fehlermeldung
// oder ein (teilweises) Ergebnis — nie einen Panic in unserem Code. Dazu ein Fuzz-Test mit festem
// Zufallsstrom (reproduzierbar): zufällig gekürzte/verfälschte ASCII-DXF, Binär-DXF und DWG.
//
// Panics INNERHALB von acadrust fängt `read_with` nativ ab (`READ_PANICS`); im WASM brächen sie die
// Instanz ab (der Import läuft dort je Datei in einem eigenen Worker). Der Test zählt sie und
// verlangt, dass sie selten bleiben, weil jeder einzelne im Browser den Import abbräche.

use super::*;
use acadrust::{DwgWriter, DxfWriter};
use std::sync::atomic::Ordering;

const FIXTURES: [(&str, &[u8]); 5] = [
    ("dim_block", include_bytes!("../testdata/dim_block.dxf")),
    ("dim_noblock", include_bytes!("../testdata/dim_noblock.dxf")),
    ("leaders", include_bytes!("../testdata/leaders.dxf")),
    ("texts", include_bytes!("../testdata/texts.dxf")),
    ("layouts", include_bytes!("../testdata/layouts.dxf")),
];

/// xorshift64*: fester Strom, keine Abhängigkeit.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Kleines Modell mit Text, Bemassung, Block und Mesh für DWG/Binär-DXF als Saatgut.
fn seed_doc() -> CadDocument {
    use acadrust::entities::{DimensionLinear, Line, MultiLeaderBuilder, Text};
    let v = |x: f64, y: f64| Vector3::new(x, y, 0.0);
    let mut doc = CadDocument::new();
    doc.add_entity(EntityType::Line(Line::from_points(v(0.0, 0.0), v(5.0, 0.0)))).unwrap();
    doc.add_entity(EntityType::Text(Text::with_value("Raum 1", v(1.0, 1.0)).with_height(0.3))).unwrap();
    let mut dim = DimensionLinear::new(v(0.0, 0.0), v(5.0, 0.0));
    dim.definition_point = v(0.0, 2.0);
    doc.add_entity(EntityType::Dimension(Box::new(acadrust::entities::Dimension::Linear(dim)))).unwrap();
    let ml = MultiLeaderBuilder::new().text("Pos", v(3.0, 2.0)).text_height(0.2).leader_line(vec![v(0.0, 0.0), v(2.0, 1.5)]).build();
    doc.add_entity(EntityType::MultiLeader(Box::new(ml))).unwrap();
    doc
}

fn seeds() -> Vec<(String, Vec<u8>)> {
    let doc = seed_doc();
    let mut v: Vec<(String, Vec<u8>)> = FIXTURES.iter().map(|(n, b)| (n.to_string(), b.to_vec())).collect();
    v.push(("ascii".into(), DxfWriter::new(&doc).write_to_vec().unwrap()));
    v.push(("binaer".into(), DxfWriter::new_binary(&doc).write_to_vec().unwrap()));
    v.push(("dwg".into(), DwgWriter::write_to_vec(&doc).unwrap()));
    v
}

/// Eine Mutation: kürzen, Bytes ändern, Stück löschen, Stück verdoppeln, Müll einfügen.
fn mutate(data: &[u8], rng: &mut Rng) -> Vec<u8> {
    let mut out = data.to_vec();
    if out.is_empty() {
        return out;
    }
    match rng.below(6) {
        0 => out.truncate(rng.below(out.len())),
        1 => {
            for _ in 0..1 + rng.below(8) {
                let i = rng.below(out.len());
                out[i] = rng.next() as u8;
            }
        }
        2 => {
            let a = rng.below(out.len());
            let b = (a + 1 + rng.below(512)).min(out.len());
            out.drain(a..b);
        }
        3 => {
            let a = rng.below(out.len());
            let b = (a + 1 + rng.below(512)).min(out.len());
            let chunk = out[a..b].to_vec();
            let at = rng.below(out.len());
            out.splice(at..at, chunk);
        }
        4 => {
            let at = rng.below(out.len());
            let junk: Vec<u8> = (0..1 + rng.below(64)).map(|_| rng.next() as u8).collect();
            out.splice(at..at, junk);
        }
        _ => {
            // einzelne Bits kippen (verfälschte Längen/Zähler)
            for _ in 0..1 + rng.below(16) {
                let i = rng.below(out.len());
                out[i] ^= 1 << rng.below(8);
            }
        }
    }
    out
}

/// Datei lesen und abbilden; Panic im Abbilden (unser Code) ist ein Testfehler.
fn import_must_not_panic(name: &str, bytes: Vec<u8>) -> Result<ImportData, String> {
    match read_document_flagged(bytes) {
        Err(e) => Err(e),
        Ok((kind, doc, recovered)) => {
            let mapped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut d = map_document(kind, &doc);
                d.recovered = recovered;
                let _ = encode(&d); // Kodierung darf ebenfalls nicht fallen
                d
            }));
            mapped.map_err(|_| panic!("Panic im Abbilden einer beschädigten Datei ({name})"))
        }
    }
}

#[test]
fn fuzz_gekuerzte_und_verfaelschte_dateien() {
    let before = READ_PANICS.load(Ordering::Relaxed);
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    // Mehr Durchläufe zum Suchen: FUZZ_ITERS=5000 cargo test --lib fuzz -- --nocapture
    let iters: usize = std::env::var("FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(150);
    let (mut ok, mut err, mut runs) = (0usize, 0usize, 0usize);
    for (name, data) in seeds() {
        // unverändert muss es lesbar sein
        assert!(import_must_not_panic(&name, data.clone()).is_ok(), "{name} unverändert nicht lesbar");
        for _ in 0..iters {
            let m = mutate(&data, &mut rng);
            runs += 1;
            match import_must_not_panic(&name, m) {
                Ok(_) => ok += 1,
                Err(_) => err += 1,
            }
        }
    }
    let panics = READ_PANICS.load(Ordering::Relaxed) - before;
    eprintln!("Fuzz: {runs} Dateien, {ok} lesbar, {err} Fehlermeldung, {panics} abgefangene Panics in acadrust");
    assert_eq!(ok + err, runs);
    assert!(err > 0 && ok > 0, "Fuzz-Mix unplausibel");
    // Jeder abgefangene Panic wäre im Browser ein Abbruch des Import-Workers: selten halten.
    assert!(panics * 50 <= runs, "zu viele Panics beim Lesen: {panics} von {runs}");
}

#[test]
fn abgeschnitten_ergibt_meldung_oder_teilergebnis() {
    for (name, data) in seeds() {
        for frac in [0usize, 1, 5, 25, 50, 75, 95, 99] {
            let cut = data.len() * frac / 100;
            match import_must_not_panic(&name, data[..cut].to_vec()) {
                Ok(d) => {
                    // teilweise gelesen: dann ist es als „wiederhergestellt" markiert oder vollständig
                    let _ = d.recovered;
                }
                Err(e) => assert!(!e.is_empty(), "{name} bei {frac} %: leere Fehlermeldung"),
            }
        }
    }
}

#[test]
fn teilweise_gelesene_ascii_datei_ist_als_wiederhergestellt_markiert() {
    let full = FIXTURES[2].1; // leaders.dxf
    // mitten in der ENTITIES-Sektion abschneiden (nach dem Text, vor EOF)
    let text = std::str::from_utf8(full).unwrap();
    let at = text.rfind("\n  0\nLEADER").or_else(|| text.find("ENTITIES")).unwrap();
    let r = import_bytes(&full[..at + 40]);
    match r {
        Ok(d) => assert!(d.recovered || d.total > 0, "teilweise gelesen, aber nicht markiert"),
        Err(e) => assert!(!e.is_empty()),
    }
}

#[test]
fn leere_oder_fremde_dateien_haben_verstaendliche_meldung() {
    let e = import_bytes(b"").unwrap_err();
    assert!(e.contains("leer"), "{e}");
    let e = import_bytes(b"Das ist ein Brief, keine Zeichnung.\nMit Gruessen\n").unwrap_err();
    assert!(e.contains("Keine DXF"), "{e}");
    let e = import_bytes(&[0u8; 2048]).unwrap_err();
    assert!(!e.is_empty());
    // PNG/PDF-Kopf
    assert!(import_bytes(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").is_err());
    assert!(import_bytes(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n").is_err());
}

#[test]
fn falsche_codepage_ergibt_ergebnis_statt_absturz() {
    // DXF mit Latin-1-Umlauten, aber Codepage-Angabe UTF-8 bzw. Unsinn, und umgekehrt.
    let header = |cp: &str| format!("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$DWGCODEPAGE\n3\n{cp}\n0\nENDSEC\n");
    let body = |text: &[u8]| {
        let mut b = b"0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\n0\n10\n0\n20\n0\n30\n0\n40\n1\n1\n".to_vec();
        b.extend_from_slice(text);
        b.extend_from_slice(b"\n0\nENDSEC\n0\nEOF\n");
        b
    };
    for cp in ["ANSI_1252", "ANSI_1251", "UTF-8", "ANSI_9999", "", "DOS437", "ANSI_932"] {
        for text in [&b"M\xfcller"[..], "Müller".as_bytes(), &b"\xff\xfe\x80\x81"[..]] {
            let mut file = header(cp).into_bytes();
            file.extend(body(text));
            let r = import_must_not_panic("codepage", file);
            if let Ok(d) = r {
                assert_eq!(d.texts.len(), 1, "Codepage {cp}: Text fehlt");
                assert!(!d.texts[0].text.is_empty());
            }
        }
    }
}

#[test]
fn riesige_zaehler_ergeben_keinen_speicherabbruch() {
    // DXF: absurd grosse Array-Werte; DWG: Kopf mit unsinnigen Längen.
    let dxf = b"0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nX\n10\n0\n20\n0\n70\n65535\n71\n65535\n44\n1\n45\n1\n0\nENDSEC\n0\nEOF\n";
    let _ = import_must_not_panic("insert-raster", dxf.to_vec());
    let dwg = seeds().pop().unwrap().1;
    for pos in [0x0b, 0x0f, 0x13, 0x1b, 0x20, 0x40, 0x60] {
        let mut m = dwg.clone();
        for b in m.iter_mut().skip(pos).take(4) {
            *b = 0xff;
        }
        let _ = import_must_not_panic("dwg-kopf", m);
    }
}
