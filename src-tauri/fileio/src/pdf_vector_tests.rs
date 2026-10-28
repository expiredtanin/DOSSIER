// Tests zu `pdf_vector.rs` / `pdf_object.rs`: synthetische PDFs (klassische Tabelle und
// XRef-/Objekt-Streams, komprimiert und unkomprimiert), Rundreise Koordinaten/Farben/Strichstärken,
// Form-XObjects, CTM-Drehung, /Rotate, Text, kaputte und verschlüsselte Dateien.

use super::*;
use std::io::Write;

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

/// Kleiner PDF-Schreiber für Tests.
#[derive(Default)]
struct Builder {
    objs: Vec<(u32, Vec<u8>)>,
    trailer_extra: String,
}

impl Builder {
    fn obj(&mut self, n: u32, body: &str) -> &mut Self {
        self.objs.push((n, body.as_bytes().to_vec()));
        self
    }
    fn stream(&mut self, n: u32, extra: &str, data: &[u8], compress: bool) -> &mut Self {
        let (data, filter) = if compress { (deflate(data), "/Filter /FlateDecode ") } else { (data.to_vec(), "") };
        let mut body = format!("<< /Length {} {}{} >>\nstream\n", data.len(), filter, extra).into_bytes();
        body.extend_from_slice(&data);
        body.extend_from_slice(b"\nendstream");
        self.objs.push((n, body));
        self
    }
    /// Klassische Querverweistabelle.
    fn finish(&self) -> Vec<u8> {
        let mut out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
        let max = self.objs.iter().map(|o| o.0).max().unwrap_or(0);
        let mut offs = vec![0usize; max as usize + 1];
        for (n, body) in &self.objs {
            offs[*n as usize] = out.len();
            out.extend_from_slice(format!("{n} 0 obj\n").as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", max + 1).as_bytes());
        for off in offs.iter().skip(1) {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!("trailer\n<< /Size {} /Root 1 0 R {} >>\nstartxref\n{xref}\n%%EOF\n", max + 1, self.trailer_extra).as_bytes(),
        );
        out
    }
    /// PDF 1.5: alle Nicht-Stream-Objekte in einem Objekt-Stream, XRef-Stream mit PNG-Prädiktor (Up).
    fn finish_compressed(&self) -> Vec<u8> {
        let mut out = b"%PDF-1.5\n".to_vec();
        let max = self.objs.iter().map(|o| o.0).max().unwrap_or(0);
        let stm_num = max + 1;
        let xref_num = max + 2;
        let is_stream = |b: &[u8]| b.windows(6).any(|w| w == b"stream");
        // Objekt-Stream
        let mut header = String::new();
        let mut body = Vec::new();
        let mut in_stm = Vec::new();
        for (n, b) in &self.objs {
            if !is_stream(b) {
                header.push_str(&format!("{n} {} ", body.len()));
                body.extend_from_slice(b);
                body.push(b'\n');
                in_stm.push(*n);
            }
        }
        let mut data = header.clone().into_bytes();
        let first = data.len();
        data.extend_from_slice(&body);
        let comp = deflate(&data);
        // Einträge: (typ, f2, f3)
        let mut entries: Vec<(u8, u32, u16)> = vec![(0, 0, 65535); xref_num as usize + 1];
        for (n, b) in &self.objs {
            if is_stream(b) {
                entries[*n as usize] = (1, out.len() as u32, 0);
                out.extend_from_slice(format!("{n} 0 obj\n").as_bytes());
                out.extend_from_slice(b);
                out.extend_from_slice(b"\nendobj\n");
            }
        }
        for (k, n) in in_stm.iter().enumerate() {
            entries[*n as usize] = (2, stm_num, k as u16);
        }
        entries[stm_num as usize] = (1, out.len() as u32, 0);
        out.extend_from_slice(
            format!("{stm_num} 0 obj\n<< /Type /ObjStm /N {} /First {first} /Length {} /Filter /FlateDecode >>\nstream\n", in_stm.len(), comp.len())
                .as_bytes(),
        );
        out.extend_from_slice(&comp);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        let xref_off = out.len();
        entries[xref_num as usize] = (1, xref_off as u32, 0);
        // Zeilen mit W [1 4 2], PNG-Up-Prädiktor
        let row_len = 7usize;
        let mut raw = Vec::new();
        let mut prev = vec![0u8; row_len];
        for (t, f2, f3) in &entries {
            let mut row = vec![*t];
            row.extend_from_slice(&f2.to_be_bytes());
            row.extend_from_slice(&f3.to_be_bytes());
            raw.push(2u8);
            for i in 0..row_len {
                raw.push(row[i].wrapping_sub(prev[i]));
            }
            prev = row;
        }
        let comp = deflate(&raw);
        out.extend_from_slice(
            format!(
                "{xref_num} 0 obj\n<< /Type /XRef /Size {} /W [1 4 2] /Root 1 0 R /Length {} /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> >>\nstream\n",
                xref_num + 1,
                comp.len()
            )
            .as_bytes(),
        );
        out.extend_from_slice(&comp);
        out.extend_from_slice(format!("\nendstream\nendobj\nstartxref\n{xref_off}\n%%EOF\n").as_bytes());
        out
    }
}

/// Einseitiges PDF mit Inhalt `content` und Ressourcen `res` (Objekt 5).
fn page_pdf(content: &str, res: &str, page_extra: &str, compress: bool) -> Builder {
    let mut b = Builder::default();
    b.obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
        .obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>")
        .obj(3, &format!("<< /Type /Page /Parent 2 0 R /Resources 5 0 R /Contents 4 0 R {page_extra} >>"))
        .stream(4, "", content.as_bytes(), compress)
        .obj(5, res);
    b
}

fn near(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6
}

const LINES: &str = "1 0 0 RG 2 w 10 20 m 110 20 l S\n0 0 1 rg 50 60 100 40 re f\n0.5 G 0.5 w [6 3] 0 d 0 0 m 10 10 l 20 0 l h S";

fn check_lines(p: &PdfPage) {
    assert_eq!(p.page_count, 1);
    assert_eq!((p.width, p.height), (595.0, 842.0));
    assert_eq!(p.paths.len(), 3, "{:?}", p.paths);
    let a = &p.paths[0];
    assert_eq!(a.pts, vec![[10.0, 20.0], [110.0, 20.0]]);
    assert_eq!(a.stroke, Some(0xff0000));
    assert_eq!(a.fill, None);
    assert_eq!(a.line_width, 2.0);
    assert!(!a.closed);
    let r = &p.paths[1];
    assert!(r.closed);
    assert_eq!(r.stroke, None);
    assert_eq!(r.fill, Some(0x0000ff));
    assert_eq!(r.pts, vec![[50.0, 60.0], [150.0, 60.0], [150.0, 100.0], [50.0, 100.0]]);
    let t = &p.paths[2];
    assert!(t.closed);
    assert_eq!(t.stroke, Some(0x808080));
    assert_eq!(t.line_width, 0.5);
    assert_eq!(t.dash, vec![6.0, 3.0]);
    assert_eq!(t.pts.len(), 3);
}

#[test]
fn uncompressed_roundtrip() {
    let pdf = page_pdf(LINES, "<< >>", "", false).finish();
    check_lines(&read_pdf_page(pdf, 0).unwrap());
}

#[test]
fn compressed_content_roundtrip() {
    let pdf = page_pdf(LINES, "<< >>", "", true).finish();
    check_lines(&read_pdf_page(pdf, 0).unwrap());
}

#[test]
fn xref_and_object_streams() {
    let pdf = page_pdf(LINES, "<< >>", "", true).finish_compressed();
    check_lines(&read_pdf_page(pdf.clone(), 0).unwrap());
    assert_eq!(pdf_page_count(pdf).unwrap(), 1);
}

#[test]
fn broken_xref_is_reconstructed() {
    let mut pdf = page_pdf(LINES, "<< >>", "", false).finish();
    // startxref zeigt ins Leere.
    let p = pdf.windows(9).rposition(|w| w == b"startxref").unwrap();
    pdf.truncate(p);
    pdf.extend_from_slice(b"startxref\n999999\n%%EOF\n");
    check_lines(&read_pdf_page(pdf, 0).unwrap());
    // Ganz ohne Querverweis und Trailer.
    let mut pdf = page_pdf(LINES, "<< >>", "", true).finish();
    let x = pdf.windows(5).rposition(|w| w == b"xref\n").unwrap();
    pdf.truncate(x);
    check_lines(&read_pdf_page(pdf, 0).unwrap());
}

#[test]
fn colors_cmyk_gray_iccbased_indexed() {
    let content = "0 0 0 1 K 1 0 0 0 k 0 0 m 10 0 l 10 10 l B\n/CS0 CS 0 1 0 SC /CS1 cs 1 sc 0 0 m 5 5 l 0 5 l b\n/CS2 cs 0.5 scn 0 0 10 10 re f";
    let res = "<< /ColorSpace << /CS0 [/ICCBased 6 0 R] /CS1 [/Indexed /DeviceRGB 1 <000000FF8000>] /CS2 [/Separation /Black /DeviceCMYK 7 0 R] >> >>";
    let mut b = page_pdf(content, res, "", false);
    b.stream(6, "/N 3", b"", false).obj(7, "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 0 1] /N 1 >>");
    let p = read_pdf_page(b.finish(), 0).unwrap();
    assert_eq!(p.paths.len(), 3);
    assert_eq!(p.paths[0].stroke, Some(0x000000));
    assert_eq!(p.paths[0].fill, Some(0x00ffff));
    assert_eq!(p.paths[1].stroke, Some(0x00ff00));
    assert_eq!(p.paths[1].fill, Some(0xff8000));
    assert_eq!(p.paths[2].fill, Some(0x808080));
}

#[test]
fn ctm_rotation_and_scale() {
    // 90° gedreht und verdoppelt, um (100,100) verschoben.
    let content = "q 0 2 -2 0 100 100 cm 3 w 0 0 m 10 0 l S Q 0 0 m 1 1 l S";
    let p = read_pdf_page(page_pdf(content, "<< >>", "", false).finish(), 0).unwrap();
    assert!(near(p.paths[0].pts[0], [100.0, 100.0]));
    assert!(near(p.paths[0].pts[1], [100.0, 120.0]));
    assert!((p.paths[0].line_width - 6.0).abs() < 1e-9);
    // Q stellt die CTM wieder her.
    assert!(near(p.paths[1].pts[1], [1.0, 1.0]));
    assert_eq!(p.paths[1].line_width, 1.0);
}

#[test]
fn page_rotate_and_cropbox() {
    let content = "0 0 m 100 0 l S";
    let p = read_pdf_page(page_pdf(content, "<< >>", "/Rotate 90", false).finish(), 0).unwrap();
    assert_eq!((p.width, p.height), (842.0, 595.0));
    assert_eq!(p.rotate, 90);
    // (x,y) → (y, w - x): Ursprung oben links, x-Achse zeigt nach unten.
    assert!(near(p.paths[0].pts[0], [0.0, 595.0]));
    assert!(near(p.paths[0].pts[1], [0.0, 495.0]));
    let p = read_pdf_page(page_pdf("10 10 m 20 10 l S", "<< >>", "/CropBox [10 10 210 310]", false).finish(), 0).unwrap();
    assert_eq!((p.width, p.height), (200.0, 300.0));
    assert!(near(p.paths[0].pts[0], [0.0, 0.0]));
    let p = read_pdf_page(page_pdf(content, "<< >>", "/Rotate 270", false).finish(), 0).unwrap();
    assert!(near(p.paths[0].pts[0], [842.0, 0.0]));
    assert!(near(p.paths[0].pts[1], [842.0, 100.0]));
}

#[test]
fn bezier_circle_is_tessellated_within_tolerance() {
    // Kreis r = 100 um (200,200) aus vier Kubiken (k = 0.5523).
    let k = 55.228475;
    let content = format!(
        "300 200 m 300 {a} {b} 300 200 300 c {c} 300 100 {a} 100 200 c 100 {c} {c} 100 200 100 c {b} 100 300 {c} 300 200 c h S",
        a = 200.0 + k,
        b = 200.0 + k,
        c = 200.0 - k
    );
    let p = read_pdf_page(page_pdf(&content, "<< >>", "", false).finish(), 0).unwrap();
    assert_eq!(p.paths.len(), 1);
    let path = &p.paths[0];
    assert!(path.closed);
    assert!(path.pts.len() > 32, "zu grob: {}", path.pts.len());
    for q in &path.pts {
        let r = ((q[0] - 200.0).powi(2) + (q[1] - 200.0).powi(2)).sqrt();
        assert!((r - 100.0).abs() < 0.1, "r = {r}");
    }
}

#[test]
fn form_xobject_nested_with_matrix_and_cycle() {
    let content = "q 1 0 0 1 100 0 cm /Fm1 Do Q /Fm1 Do 0 0 m 1 0 l S";
    let res = "<< /XObject << /Fm1 6 0 R >> >>";
    let mut b = page_pdf(content, res, "", false);
    // Fm1: Matrix verschiebt um (0,50), zeichnet eine Linie und ruft Fm2 (eigene Ressourcen).
    b.stream(6, "/Type /XObject /Subtype /Form /BBox [0 0 1000 1000] /Matrix [1 0 0 1 0 50] /Resources << /XObject << /Fm2 7 0 R >> >>", b"0 0 1 RG 0 0 m 10 0 l S /Fm2 Do", true);
    // Fm2: skaliert ×2 und ruft sich selbst (Zyklus muss abbrechen).
    b.stream(7, "/Subtype /Form /BBox [0 0 1000 1000] /Matrix [2 0 0 2 0 0] /Resources << /XObject << /Fm2 7 0 R >> >>", b"0 0 m 0 10 l S /Fm2 Do", false);
    let p = read_pdf_page(b.finish(), 0).unwrap();
    assert_eq!(p.paths.len(), 5, "{:?}", p.paths);
    assert!(near(p.paths[0].pts[0], [100.0, 50.0]));
    assert!(near(p.paths[0].pts[1], [110.0, 50.0]));
    assert_eq!(p.paths[0].stroke, Some(0x0000ff));
    assert!(near(p.paths[1].pts[1], [100.0, 70.0]));
    // Farbe aus der Form wirkt nicht nach aussen (Form läuft in q/Q).
    assert!(near(p.paths[2].pts[0], [0.0, 50.0]));
    assert_eq!(p.paths[3].stroke, Some(0x0000ff));
    assert_eq!(p.paths[4].stroke, Some(0));
}

#[test]
fn text_with_widths_tounicode_and_merge() {
    let content = "BT /F1 10 Tf 1 0 0 1 100 200 Tm (AB) Tj (C) Tj ET\n\
                   BT /F2 20 Tf 0 1 -1 0 300 300 Tm <00410042> Tj ET\n\
                   BT 3 Tr /F1 10 Tf 0 0 Td (unsichtbar) Tj ET\n\
                   BT 0 Tr /F1 12 Tf 50 50 Td [(Wand)-600(Nord)] TJ ET";
    let res = "<< /Font << /F1 6 0 R /F2 7 0 R >> >>";
    let mut b = page_pdf(content, res, "", false);
    b.obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Helvetica /FirstChar 65 /LastChar 67 /Widths [600 700 500] >>");
    b.obj(7, "<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H /DescendantFonts [8 0 R] /ToUnicode 9 0 R >>");
    b.obj(8, "<< /Type /Font /Subtype /CIDFontType2 /DW 1000 /W [65 [500 500]] >>");
    b.stream(
        9,
        "",
        b"begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <0041> <00C4> <0042> <00DF> endbfchar endcmap",
        true,
    );
    let p = read_pdf_page(b.finish(), 0).unwrap();
    assert_eq!(p.texts.len(), 3, "{:?}", p.texts);
    let t = &p.texts[0];
    assert_eq!(t.text, "ABC");
    assert_eq!(t.font, "Helvetica");
    assert!(near([t.x, t.y], [100.0, 200.0]));
    assert!((t.size - 10.0).abs() < 1e-9);
    assert_eq!(t.angle, 0.0);
    let u = &p.texts[1];
    assert_eq!(u.text, "Äß");
    assert!((u.angle - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    assert!((u.size - 20.0).abs() < 1e-9);
    assert_eq!(p.texts[2].text, "Wand Nord");
}

#[test]
fn inline_image_is_skipped() {
    let content = "q 10 0 0 10 0 0 cm BI /W 2 /H 2 /BPC 8 /CS /G ID \x00EI\x7f\x01 EI Q 0 0 m 5 5 l S";
    let p = read_pdf_page(page_pdf(content, "<< >>", "", false).finish(), 0).unwrap();
    assert_eq!(p.images, 1);
    assert_eq!(p.paths.len(), 1);
    assert!(near(p.paths[0].pts[1], [5.0, 5.0]));
}

#[test]
fn multi_page_inherited_mediabox() {
    let mut b = Builder::default();
    b.obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
        .obj(2, "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /MediaBox [0 0 100 200] >>")
        .obj(3, "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>")
        .stream(4, "", b"0 0 m 1 1 l S", false)
        .obj(6, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents [7 0 R 8 0 R] >>")
        .stream(7, "", b"0 0 m 2 2 l", false)
        .stream(8, "", b"S 0 0 m 3 3 l S", true);
    let pdf = b.finish();
    let p0 = read_pdf_page(pdf.clone(), 0).unwrap();
    assert_eq!((p0.page_count, p0.width, p0.height), (2, 100.0, 200.0));
    let p1 = read_pdf_page(pdf.clone(), 1).unwrap();
    assert_eq!((p1.width, p1.height, p1.page_index), (300.0, 300.0, 1));
    assert_eq!(p1.paths.len(), 2);
    assert!(read_pdf_page(pdf, 2).is_err());
}

#[test]
fn encrypted_is_rejected() {
    let mut b = page_pdf(LINES, "<< >>", "", false);
    b.obj(9, "<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>");
    b.trailer_extra = "/Encrypt 9 0 R".into();
    let e = read_pdf_page(b.finish(), 0).unwrap_err();
    assert!(e.contains("verschlüsselt"), "{e}");
}

#[test]
fn garbage_never_panics() {
    for pdf in [page_pdf(LINES, "<< >>", "", true).finish(), page_pdf(LINES, "<< >>", "", true).finish_compressed()] {
        // Abschneiden an jeder Stelle.
        for cut in (0..pdf.len()).step_by(7) {
            let _ = read_pdf_page(pdf[..cut].to_vec(), 0);
        }
        // Einzelne Bytes verfälschen (deterministischer Pseudozufall).
        let mut seed = 0x1234_5678u32;
        for _ in 0..400 {
            let mut m = pdf.clone();
            for _ in 0..4 {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let i = seed as usize % m.len();
                m[i] = (seed >> 8) as u8;
            }
            let _ = read_pdf_page(m, 0);
        }
    }
    // Absichtlich bösartige Inhalte.
    for content in [
        "q q q q Q Q Q Q Q Q Q 1 0 0 1 1e308 1e308 cm 0 0 m 1e308 1e308 l S",
        "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[",
        "(((((( unbalanced", "<< /A << /B", "BI /W 1 ID xxxx", "m l c v y re h S f B", "/Fm1 Do /X Do",
        "BT /F9 10 Tf (x) Tj 0 0 0 0 0 0 Tm (y) Tj ET", "0 0 m NaN NaN l S",
    ] {
        let _ = read_pdf_page(page_pdf(content, "<< /XObject << /Fm1 9 0 R >> >>", "", false).finish(), 0);
    }
}

#[test]
fn encode_layout() {
    let p = read_pdf_page(page_pdf("1 0 0 RG 2 w 10 20 m 110 20 l S BT /F1 10 Tf 5 6 Td (Hi) Tj ET", "<< >>", "", false).finish(), 0).unwrap();
    let (g, s) = encode(&p);
    assert_eq!(g[0], 2.0);
    assert_eq!(&g[1..5], &[1.0, 0.0, 595.0, 842.0]);
    // media×4, crop×4, rotate, truncated, images
    let mut i = 5 + 8 + 3;
    assert_eq!(g[i], 1.0);
    i += 1;
    assert_eq!(&g[i..i + 6], &[2.0, 0xff0000 as f64, -1.0, 2.0, 0.0, 2.0]);
    i += 6;
    assert_eq!(&g[i..i + 4], &[10.0, 20.0, 110.0, 20.0]);
    i += 4;
    assert_eq!(g[i], 1.0);
    assert_eq!(s[g[i + 1] as usize], "Hi");
    assert_eq!(&g[i + 3..i + 5], &[5.0, 6.0]);
}

#[test]
fn constant_alpha_from_extgstate() {
    let content = "/T gs 0 0 1 rg 0 0 10 10 re f /H gs 0 0 0 rg 0 0 m 5 0 l 5 5 l f";
    let res = "<< /ExtGState << /T << /ca 0 >> /H << /ca 0.5 /CA 1 >> >> >>";
    let p = read_pdf_page(page_pdf(content, res, "", false).finish(), 0).unwrap();
    // Unsichtbare Fläche fehlt, halbe Deckkraft wird mit Weiss gemischt.
    assert_eq!(p.paths.len(), 1);
    assert_eq!(p.paths[0].fill, Some(0x808080));
}

// ── [76] Kreise/Bögen, Strichmuster, Clips ───────────────────────────────────

fn circle_content(cx: f64, cy: f64, r: f64, op: &str) -> String {
    let k = 0.5522847498 * r;
    format!(
        "{} {} m {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c h {op}",
        cx + r, cy,
        cx + r, cy + k, cx + k, cy + r, cx, cy + r,
        cx - k, cy + r, cx - r, cy + k, cx - r, cy,
        cx - r, cy - k, cx - k, cy - r, cx, cy - r,
        cx + k, cy - r, cx + r, cy - k, cx + r, cy,
    )
}

fn read(content: &str) -> PdfPage {
    read_pdf_page(page_pdf(content, "<< >>", "", false).finish(), 0).unwrap()
}

#[test]
fn circle_from_four_beziers_becomes_curve() {
    let p = read(&circle_content(200.0, 300.0, 40.0, "S"));
    assert_eq!(p.paths.len(), 1);
    let c = p.paths[0].curve.expect("Kreis erkannt");
    assert!(c.circle);
    assert!((c.cx - 200.0).abs() < 1e-3 && (c.cy - 300.0).abs() < 1e-3 && (c.r - 40.0).abs() < 1e-2, "{c:?}");
    assert!(p.paths[0].pts.len() > 16, "Vieleck bleibt zusätzlich erhalten");
}

#[test]
fn circle_with_fill_keeps_curve_and_tiny_circle_works() {
    let p = read(&format!("0 1 0 rg {}", circle_content(100.0, 100.0, 40.0, "B")));
    assert!(p.paths[0].curve.is_some());
    assert_eq!(p.paths[0].fill, Some(0x00ff00));
    let p = read(&circle_content(100.0, 100.0, 0.5, "S"));
    assert!(p.paths[0].curve.is_some_and(|c| c.circle));
}

#[test]
fn quarter_arc_becomes_arc() {
    // Viertelbogen um (200,200) r 100 von (300,200) nach (200,300).
    let k = 55.228475;
    let content = format!("300 200 m 300 {y} {x} 300 200 300 c S", y = 200.0 + k, x = 200.0 + k);
    let p = read(&content);
    let c = p.paths[0].curve.expect("Bogen");
    assert!(!c.circle);
    assert!((c.cx - 200.0).abs() < 1e-2 && (c.cy - 200.0).abs() < 1e-2 && (c.r - 100.0).abs() < 1e-2, "{c:?}");
    assert!(c.a0.abs() < 1e-3 && (c.a1 - std::f64::consts::FRAC_PI_2).abs() < 1e-3, "{c:?}");
    // Türschwung mit CTM-Verschiebung und Skalierung ×2 bleibt ein Bogen.
    let p = read(&format!("2 0 0 2 10 20 cm 150 100 m 150 {y} {x} 150 100 150 c S", y = 100.0 + k / 2.0, x = 100.0 + k / 2.0));
    let c = p.paths[0].curve.expect("Bogen mit CTM");
    assert!((c.cx - 210.0).abs() < 1e-2 && (c.cy - 220.0).abs() < 1e-2 && (c.r - 100.0).abs() < 1e-2, "{c:?}");
}

#[test]
fn ellipse_rounded_rect_and_wave_are_not_curves() {
    // Ellipse 2:1 (Kubik-Näherung)
    let k = 0.5522847498;
    let (rx, ry) = (100.0, 50.0);
    let (cx, cy) = (200.0, 200.0);
    let e = format!(
        "{} {} m {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c h S",
        cx + rx, cy,
        cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry,
        cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy,
        cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry,
        cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy,
    );
    assert!(read(&e).paths[0].curve.is_none(), "Ellipse");
    // Rechteck mit gerundeter Ecke: Linien + Kubik → kein Kreis
    let r = read("0 0 m 100 0 l 100 90 l 90 100 100 100 100 100 c 0 100 l h S");
    assert!(r.paths[0].curve.is_none());
    assert!(read("0 0 m 10 20 20 -20 30 0 c S").paths[0].curve.is_none(), "S-Kurve");
    assert!(read("0 0 m 100 0 l S").paths[0].curve.is_none());
}

#[test]
fn dash_patterns_are_normalised() {
    // ungerade Länge: wiederholt sich gespiegelt → verdoppelt; mit CTM ×2 skaliert
    let p = read("[3] 0 d 0 0 m 10 0 l S 2 0 0 2 0 0 cm [4 1 2] 1 d 0 5 m 10 5 l S [0 0] 0 d 0 9 m 9 9 l S");
    assert_eq!(p.paths[0].dash, vec![3.0, 3.0]);
    assert_eq!(p.paths[1].dash, vec![8.0, 2.0, 4.0, 8.0, 2.0, 4.0]);
    assert!(p.paths[2].dash.is_empty(), "[0 0] = durchgezogen");
}

#[test]
fn rect_clip_cuts_lines_and_fills() {
    let p = read("50 50 100 100 re W n 0 0 m 200 200 l S 0 1 0 rg 100 100 100 100 re f 300 300 m 400 400 l S");
    assert_eq!(p.paths.len(), 2, "{:?}", p.paths);
    assert!(near(p.paths[0].pts[0], [50.0, 50.0]) && near(p.paths[0].pts[1], [150.0, 150.0]), "{:?}", p.paths[0].pts);
    let f = &p.paths[1];
    assert_eq!(f.fill, Some(0x00ff00));
    let (minx, maxx) = f.pts.iter().fold((f64::MAX, f64::MIN), |a, q| (a.0.min(q[0]), a.1.max(q[0])));
    assert!((minx - 100.0).abs() < 1e-9 && (maxx - 150.0).abs() < 1e-9, "{:?}", f.pts);
}

#[test]
fn clip_is_restored_by_q_and_nested_clips_intersect() {
    let p = read("q 0 0 100 100 re W n 50 0 100 100 re W n 0 50 m 200 50 l S Q 0 70 m 200 70 l S");
    assert_eq!(p.paths.len(), 2);
    // Schnitt beider Rechtecke: x ∈ [50, 100]
    assert!(near(p.paths[0].pts[0], [50.0, 50.0]) && near(p.paths[0].pts[1], [100.0, 50.0]), "{:?}", p.paths[0].pts);
    // nach Q wieder ungeclippt (nur die Seite begrenzt)
    assert!(near(p.paths[1].pts[1], [200.0, 70.0]));
}

#[test]
fn clip_painting_operator_still_paints_unclipped() {
    // „W f": die Fläche selbst wird noch ungeclippt gemalt, erst danach wirkt der Clip.
    let p = read("0 0 10 10 re W f 0 5 m 100 5 l S");
    assert_eq!(p.paths.len(), 2);
    assert!(near(p.paths[1].pts[1], [10.0, 5.0]));
}

#[test]
fn polygon_clip_triangle_and_evenodd() {
    // Dreieck als Clip: Linie y = 20 schneidet es bei x ∈ [0, 60] (Dreieck (0,0)-(80,0)-(0,80))
    let p = read("0 0 m 80 0 l 0 80 l h W n 0 20 m 100 20 l S");
    assert_eq!(p.paths.len(), 1);
    assert!(near(p.paths[0].pts[0], [0.0, 20.0]) && near(p.paths[0].pts[1], [60.0, 20.0]), "{:?}", p.paths[0].pts);
    // L-förmiger (konkaver) Clip: Linie durch die Kerbe → nur Teil im L
    let p = read("0 0 m 100 0 l 100 50 l 50 50 l 50 100 l 0 100 l h W n 0 70 m 120 70 l S");
    assert_eq!(p.paths.len(), 1, "{:?}", p.paths);
    assert!(near(p.paths[0].pts[1], [50.0, 70.0]), "{:?}", p.paths[0].pts);
}

#[test]
fn form_bbox_clips_content_and_cropbox_clips_page() {
    let res = "<< /XObject << /Fm1 6 0 R >> >>";
    let mut b = page_pdf("/Fm1 Do 0 -10 m 0 30 l S", res, "", false);
    b.stream(6, "/Type /XObject /Subtype /Form /BBox [0 0 50 50] /Matrix [1 0 0 1 100 100]", b"-20 25 m 80 25 l S", false);
    let p = read_pdf_page(b.finish(), 0).unwrap();
    assert_eq!(p.paths.len(), 2, "{:?}", p.paths);
    // Form-BBox (0..50) + Matrix (100,100): Linie y = 125 nur von x = 100 bis 150.
    assert!(near(p.paths[0].pts[0], [100.0, 125.0]) && near(p.paths[0].pts[1], [150.0, 125.0]), "{:?}", p.paths[0].pts);
    // Seite: Linie ragt unter den Rand (y < 0) → auf die Seite beschnitten.
    assert!(near(p.paths[1].pts[0], [0.0, 0.0]) && near(p.paths[1].pts[1], [0.0, 30.0]), "{:?}", p.paths[1].pts);
}

#[test]
fn clipped_text_is_dropped_and_fill_stroke_split() {
    let res = "<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>";
    let content = "0 0 100 100 re W n BT /F1 10 Tf 10 10 Td (innen) Tj 1 0 0 1 300 300 Tm (aussen) Tj ET 0 0 1 rg 1 0 0 RG 90 90 50 50 re B";
    let p = read_pdf_page(page_pdf(content, res, "", false).finish(), 0).unwrap();
    assert_eq!(p.texts.len(), 1);
    assert_eq!(p.texts[0].text, "innen");
    // Teilweise sichtbare gefüllte+gestrichene Fläche: Fläche (beschnitten) + Umriss-Stücke
    let fills: Vec<_> = p.paths.iter().filter(|q| q.fill.is_some()).collect();
    let strokes: Vec<_> = p.paths.iter().filter(|q| q.stroke.is_some()).collect();
    assert_eq!(fills.len(), 1);
    assert!(fills[0].stroke.is_none() && fills[0].pts.iter().all(|q| q[0] <= 100.0 + 1e-9 && q[1] <= 100.0 + 1e-9));
    assert!(!strokes.is_empty());
    assert!(strokes.iter().all(|q| q.fill.is_none() && !q.closed));
}

#[test]
fn clipped_circle_loses_curve_unclipped_keeps_it() {
    let p = read(&format!("0 0 100 100 re W n {} {}", circle_content(50.0, 50.0, 20.0, "S"), circle_content(100.0, 50.0, 20.0, "S")));
    assert_eq!(p.paths.len(), 2);
    assert!(p.paths[0].curve.is_some());
    assert!(p.paths[1].curve.is_none(), "angeschnittener Kreis ist kein Kreis mehr");
}

#[test]
fn encode_carries_curve() {
    let p = read(&circle_content(200.0, 300.0, 40.0, "S"));
    let (g, _) = encode(&p);
    let i = 5 + 8 + 3 + 1;
    let flags = g[i] as u32;
    assert_eq!(flags & 16, 16, "Kurven-Flag");
    assert_eq!(flags & 32, 32, "Kreis-Flag");
    let nd = g[i + 4] as usize;
    let np = g[i + 5 + nd] as usize;
    let c = i + 6 + nd + 2 * np;
    assert!((g[c] - 200.0).abs() < 1e-2 && (g[c + 1] - 300.0).abs() < 1e-2 && (g[c + 2] - 40.0).abs() < 1e-2);
}
