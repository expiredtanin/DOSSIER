// Vektor-PDF lesen ([76] Vektorfang auf PDF): Pfade und Texte einer Seite aus dem Content-Stream.
//
// Fachplaner schicken Pläne oft als aus ArchiCAD/Revit/AutoCAD geplottete Vektor-PDFs. Dieses Modul
// interpretiert den Content-Stream einer Seite (eigener kleiner Interpreter über `pdf_object.rs`):
//   • Pfade: m l c v y h re, Malen mit S s f F f* B B* b b* n, Bézier-Kurven adaptiv tesselliert
//     (Toleranz [`FLAT_TOL`] in pt). Reine Bézier-Teilpfade, die auf einem Kreis liegen, werden
//     zusätzlich als Kreis/Bogen gemeldet (`PdfPath::curve`, s. `pdf_geom.rs`).
//   • Clip: W/W* (Rechteck exakt, Polygon für Linien exakt, für Flächen bei konvexem Clip exakt, sonst
//     an der Hüllbox), Form-/Seiten-BBox als Rechteck-Clip; Texte ausserhalb entfallen.
//   • Grafikzustand: q/Q, cm (CTM), w, d, gs (ExtGState /LW /D), Farben G g RG rg K k CS cs SC sc
//     SCN scn (DeviceGray/RGB/CMYK, ICCBased nach /N, CalGray/CalRGB, Separation/DeviceN als
//     Tönung von Schwarz, Indexed mit Tabelle, Pattern → letzte Farbe).
//   • Form-XObjects (Do) rekursiv mit /Matrix und eigenen /Resources; Bild-XObjects und Inline-
//     Bilder (BI … ID … EI) werden nur gezählt.
//   • Text (optional): BT/ET, Tf Tm Td TD T* TL Tc Tw Tz Ts Tr, Tj TJ ' " — je Zeichenkette ein Text
//     mit Einfügepunkt, Grösse, Winkel und Farbe; Schrift nur als Name. Unicode über /ToUnicode
//     (bfchar/bfrange), sonst WinAnsi; Breiten aus /Widths bzw. /W (Type0) für den Vorschub.
//     Unsichtbarer Text (Tr 3/7, z. B. OCR-Ebene von Scans) wird weggelassen.
//
// Koordinaten: PDF-Punkte (1 pt = 1/72 Zoll), schon in die ANGEZEIGTE Seite umgerechnet: Ursprung
// links unten an der CropBox, y nach oben, /Rotate angewendet (Breite/Höhe entsprechend getauscht).
// Linienbreiten und Strichmuster sind mit der CTM skaliert (ebenfalls pt).
//
// Budget: höchstens [`MAX_OPS`] Operatoren und [`MAX_POINTS`] Punkte je Seite, Form-Tiefe
// [`MAX_FORM_DEPTH`]; darüber wird abgebrochen und `truncated` gesetzt. Kaputte/verschlüsselte
// Dateien → `Err`, nie ein Panic.

use std::collections::HashMap;
use std::rc::Rc;

use crate::pdf_geom::{fit_curve, Clip, Cubic};
pub use crate::pdf_geom::PdfCurve;
use crate::pdf_object::{is_ws, parse_from, Dict, Doc, Lexer, Obj, Stream, Tok};

/// Sehnenfehler der Bézier-Tessellierung (pt, ≈ 0.02 mm Papier).
pub const FLAT_TOL: f64 = 0.05;
/// Höchstzahl Segmente je Bézier.
const MAX_BEZIER_SEG: usize = 64;
/// Operator-Budget je Seite (Schutz gegen riesige/zyklisch wiederverwendete Inhalte).
pub const MAX_OPS: usize = 20_000_000;
/// Punkte-Budget je Seite.
pub const MAX_POINTS: usize = 8_000_000;
/// Höchstzahl Texte je Seite.
const MAX_TEXTS: usize = 500_000;
/// Verschachtelung von Form-XObjects.
const MAX_FORM_DEPTH: usize = 16;
/// Tiefe des q/Q-Stapels.
const MAX_GSTACK: usize = 512;
/// Höchstzahl Seiten im Seitenbaum.
const MAX_PAGES: usize = 100_000;

type M = [f64; 6];
const IDENT: M = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a` dann `b` (PDF-Zeilenvektor-Konvention: p' = p × a × b).
fn mul(a: &M, b: &M) -> M {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}
fn apply(m: &M, x: f64, y: f64) -> [f64; 2] {
    [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}
fn scale_of(m: &M) -> f64 {
    (m[0] * m[3] - m[1] * m[2]).abs().sqrt()
}

/// Ein gemalter Teilpfad (je Teilpfad ein Eintrag; ein gefüllter Pfad mit Loch ergibt zwei).
#[derive(Debug, Clone, PartialEq)]
pub struct PdfPath {
    pub pts: Vec<[f64; 2]>,
    pub closed: bool,
    /// Strichfarbe 0xRRGGBB, `None` = nicht gestrichen.
    pub stroke: Option<u32>,
    /// Füllfarbe 0xRRGGBB, `None` = nicht gefüllt.
    pub fill: Option<u32>,
    pub even_odd: bool,
    /// Linienbreite in pt (0 = Haarlinie).
    pub line_width: f64,
    /// Strichmuster in pt (leer = durchgezogen; Länge immer gerade, Phase entfällt).
    pub dash: Vec<f64>,
    /// Erkannter Kreis/Bogen (Bézier-Folge), `pts` bleibt als Vieleck erhalten.
    pub curve: Option<PdfCurve>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdfText {
    pub text: String,
    /// Schriftname (BaseFont ohne Teilmengen-Präfix, sonst Ressourcenname).
    pub font: String,
    /// Einfügepunkt (Grundlinie, Anfang), pt.
    pub x: f64,
    pub y: f64,
    /// Schriftgrösse (Höhe des Em-Quadrats) in pt.
    pub size: f64,
    /// Drehung in Radiant (CCW).
    pub angle: f64,
    pub color: u32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PdfPage {
    pub page_count: u32,
    /// 0-basiert.
    pub page_index: u32,
    /// Angezeigte Seitengrösse (CropBox, nach /Rotate) in pt.
    pub width: f64,
    pub height: f64,
    pub media_box: [f64; 4],
    pub crop_box: [f64; 4],
    pub rotate: i32,
    pub paths: Vec<PdfPath>,
    pub texts: Vec<PdfText>,
    /// Bild-XObjects und Inline-Bilder (nicht übernommen).
    pub images: u32,
    /// Budget überschritten, Seite nur teilweise gelesen.
    pub truncated: bool,
}

/// Zahl der Seiten eines PDF.
pub fn pdf_page_count(bytes: Vec<u8>) -> Result<u32, String> {
    let doc = Doc::load(bytes)?;
    Ok(collect_pages(&doc).len() as u32)
}

/// Liest Seite `page_index` (0-basiert) eines PDF.
pub fn read_pdf_page(bytes: Vec<u8>, page_index: usize) -> Result<PdfPage, String> {
    let doc = Doc::load(bytes)?;
    let pages = collect_pages(&doc);
    if pages.is_empty() {
        return Err("PDF ohne Seiten".into());
    }
    let Some(pg) = pages.get(page_index) else {
        return Err(format!("Seite {} gibt es nicht (die Datei hat {} Seiten)", page_index + 1, pages.len()));
    };
    let mut out = PdfPage { page_count: pages.len() as u32, page_index: page_index as u32, ..Default::default() };
    let media = pg.media.unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let crop = pg.crop.map(|c| intersect(c, media)).unwrap_or(media);
    let rot = pg.rotate.rem_euclid(360) / 90 * 90;
    let (w, h) = (crop[2] - crop[0], crop[3] - crop[1]);
    let t: M = [1.0, 0.0, 0.0, 1.0, -crop[0], -crop[1]];
    let r: M = match rot {
        90 => [0.0, -1.0, 1.0, 0.0, 0.0, w],
        180 => [-1.0, 0.0, 0.0, -1.0, w, h],
        270 => [0.0, 1.0, -1.0, 0.0, h, 0.0],
        _ => IDENT,
    };
    out.media_box = media;
    out.crop_box = crop;
    out.rotate = rot;
    (out.width, out.height) = if rot == 90 || rot == 270 { (h, w) } else { (w, h) };

    let content = page_content(&doc, &pg.dict);
    let mut it = Interp::new(&doc, mul(&t, &r));
    // Seite (CropBox) begrenzt die Zeichnung wie in einem PDF-Betrachter.
    it.gs.clips.push(Rc::new(Clip::from_rect([0.0, 0.0, out.width, out.height])));
    let res = pg.resources.clone().unwrap_or_default();
    it.run(&content, &Rc::new(res), 0);
    it.flush_text();
    out.paths = it.paths;
    out.texts = it.texts;
    out.images = it.images;
    out.truncated = it.truncated;
    Ok(out)
}

fn intersect(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let r = [a[0].max(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].min(b[3])];
    if r[2] > r[0] && r[3] > r[1] {
        r
    } else {
        b
    }
}

struct PageRef {
    dict: Dict,
    resources: Option<Dict>,
    media: Option<[f64; 4]>,
    crop: Option<[f64; 4]>,
    rotate: i32,
}

fn rect(doc: &Doc, o: &Obj) -> Option<[f64; 4]> {
    let a = doc.resolve(o);
    let a = a.as_array()?;
    if a.len() < 4 {
        return None;
    }
    let v: Vec<f64> = a.iter().take(4).filter_map(|x| doc.resolve(x).as_f64()).collect();
    if v.len() < 4 {
        return None;
    }
    let r = [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])];
    (r[2] > r[0] && r[3] > r[1]).then_some(r)
}

/// Seitenbaum ablaufen (vererbte Resources/MediaBox/CropBox/Rotate, Zyklen abgefangen).
fn collect_pages(doc: &Doc) -> Vec<PageRef> {
    let mut out = Vec::new();
    let Some(cat) = doc.catalog() else { return out };
    let Some(root) = cat.get("Pages") else { return out };
    let mut seen = std::collections::HashSet::new();
    walk_pages(doc, root, None, None, None, 0, &mut seen, &mut out, 0);
    out
}

#[allow(clippy::too_many_arguments)]
fn walk_pages(
    doc: &Doc,
    node: &Obj,
    res: Option<Dict>,
    media: Option<[f64; 4]>,
    crop: Option<[f64; 4]>,
    rotate: i32,
    seen: &mut std::collections::HashSet<u32>,
    out: &mut Vec<PageRef>,
    depth: usize,
) {
    if depth > 64 || out.len() >= MAX_PAGES {
        return;
    }
    if let Obj::Ref(n, _) = node {
        if !seen.insert(*n) {
            return;
        }
    }
    let Some(d) = doc.resolve(node).as_dict().cloned() else { return };
    let res = match doc.dget(&d, "Resources") {
        Obj::Dict(r) => Some(r),
        _ => res,
    };
    let media = d.get("MediaBox").and_then(|m| rect(doc, m)).or(media);
    let crop = d.get("CropBox").and_then(|m| rect(doc, m)).or(crop);
    let rotate = doc.dget(&d, "Rotate").as_i64().map(|r| r as i32).unwrap_or(rotate);
    let is_tree = d.get("Type").and_then(Obj::as_name) == Some("Pages") || d.contains_key("Kids");
    if is_tree {
        if let Obj::Array(kids) = doc.dget(&d, "Kids") {
            for k in &kids {
                walk_pages(doc, k, res.clone(), media, crop, rotate, seen, out, depth + 1);
            }
        }
    } else {
        out.push(PageRef { dict: d, resources: res, media, crop, rotate });
    }
}

fn page_content(doc: &Doc, page: &Dict) -> Vec<u8> {
    let mut out = Vec::new();
    let mut push = |o: &Obj| {
        if let Obj::Stream(s) = doc.resolve(o) {
            if let Some(d) = doc.decode(&s) {
                out.extend_from_slice(&d);
                out.push(b'\n');
            }
        }
    };
    match page.get("Contents").map(|c| doc.resolve(c)) {
        Some(Obj::Array(a)) => a.iter().for_each(&mut push),
        Some(o @ Obj::Stream(_)) => push(&o),
        _ => {}
    }
    out
}

// ── Farben ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Cs {
    Gray,
    Rgb,
    Cmyk,
    /// Separation/DeviceN: Tönung von Schwarz (Komponentenzahl).
    Tint(usize),
    Indexed { base: Box<Cs>, lookup: Rc<Vec<u8>>, hival: usize },
    Lab,
    Pattern,
}

fn clamp01(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}
fn rgb(r: f64, g: f64, b: f64) -> u32 {
    let c = |v: f64| (clamp01(v) * 255.0).round() as u32;
    c(r) << 16 | c(g) << 8 | c(b)
}
fn cmyk(c: f64, m: f64, y: f64, k: f64) -> u32 {
    let k = clamp01(k);
    rgb((1.0 - clamp01(c)) * (1.0 - k), (1.0 - clamp01(m)) * (1.0 - k), (1.0 - clamp01(y)) * (1.0 - k))
}

/// Deckkraft anwenden: unsichtbar (≈ 0) → nicht gemalt, teilweise → mit Weiss gemischt (Papier).
fn with_alpha(c: Option<u32>, a: f64) -> Option<u32> {
    let c = c?;
    if a <= 0.004 {
        return None;
    }
    if a >= 0.996 {
        return Some(c);
    }
    let mix = |v: u32| 1.0 - a * (1.0 - (v & 0xff) as f64 / 255.0);
    Some(rgb(mix(c >> 16), mix(c >> 8), mix(c)))
}

impl Cs {
    fn comps(&self) -> usize {
        match self {
            Cs::Gray | Cs::Indexed { .. } | Cs::Pattern => 1,
            Cs::Rgb | Cs::Lab => 3,
            Cs::Cmyk => 4,
            Cs::Tint(n) => *n,
        }
    }
    /// Startfarbe nach dem Setzen des Farbraums.
    fn initial(&self) -> Option<u32> {
        match self {
            Cs::Indexed { .. } => self.color(&[0.0]),
            Cs::Tint(n) => self.color(&vec![1.0; *n]),
            Cs::Pattern => None,
            _ => Some(0),
        }
    }
    fn color(&self, v: &[f64]) -> Option<u32> {
        let g = |i: usize| v.get(i).copied().unwrap_or(0.0);
        Some(match self {
            Cs::Gray => rgb(g(0), g(0), g(0)),
            Cs::Rgb => rgb(g(0), g(1), g(2)),
            Cs::Cmyk => cmyk(g(0), g(1), g(2), g(3)),
            Cs::Lab => {
                let l = g(0) / 100.0;
                rgb(l, l, l)
            }
            Cs::Tint(_) => {
                let t = clamp01(v.iter().copied().fold(0.0, f64::max));
                rgb(1.0 - t, 1.0 - t, 1.0 - t)
            }
            Cs::Indexed { base, lookup, hival } => {
                let i = (g(0).max(0.0) as usize).min(*hival);
                let n = base.comps();
                let comps: Vec<f64> = (0..n).map(|k| lookup.get(i * n + k).copied().unwrap_or(0) as f64 / 255.0).collect();
                return base.color(&comps);
            }
            Cs::Pattern => return None,
        })
    }
}

fn cs_from_obj(doc: &Doc, o: &Obj, res: &Dict, depth: usize) -> Cs {
    if depth > 8 {
        return Cs::Gray;
    }
    match doc.resolve(o) {
        Obj::Name(n) => match n.as_str() {
            "DeviceGray" | "G" | "CalGray" => Cs::Gray,
            "DeviceRGB" | "RGB" | "CalRGB" => Cs::Rgb,
            "DeviceCMYK" | "CMYK" => Cs::Cmyk,
            "Pattern" => Cs::Pattern,
            other => {
                // Benannter Farbraum aus /Resources /ColorSpace.
                if let Obj::Dict(csd) = doc.dget(res, "ColorSpace") {
                    if let Some(def) = csd.get(other) {
                        return cs_from_obj(doc, def, res, depth + 1);
                    }
                }
                Cs::Gray
            }
        },
        Obj::Array(a) => {
            let kind = a.first().map(|k| doc.resolve(k)).and_then(|k| k.as_name().map(str::to_owned)).unwrap_or_default();
            match kind.as_str() {
                "ICCBased" => {
                    let n = a.get(1).map(|s| doc.resolve(s)).and_then(|s| s.as_dict().and_then(|d| doc.dget(d, "N").as_i64()));
                    match n {
                        Some(1) => Cs::Gray,
                        Some(4) => Cs::Cmyk,
                        _ => Cs::Rgb,
                    }
                }
                "CalGray" => Cs::Gray,
                "CalRGB" => Cs::Rgb,
                "Lab" => Cs::Lab,
                "Separation" => Cs::Tint(1),
                "DeviceN" => Cs::Tint(a.get(1).map(|n| doc.resolve(n)).and_then(|n| n.as_array().map(|x| x.len())).unwrap_or(1).max(1)),
                "Pattern" => Cs::Pattern,
                "Indexed" | "I" => {
                    let base = a.get(1).map(|b| cs_from_obj(doc, b, res, depth + 1)).unwrap_or(Cs::Rgb);
                    let hival = a.get(2).and_then(|h| doc.resolve(h).as_i64()).unwrap_or(0).clamp(0, 255) as usize;
                    let lookup = match a.get(3).map(|l| doc.resolve(l)) {
                        Some(Obj::Str(s)) => s,
                        Some(Obj::Stream(s)) => doc.decode(&s).unwrap_or_default(),
                        _ => Vec::new(),
                    };
                    Cs::Indexed { base: Box::new(base), lookup: Rc::new(lookup), hival }
                }
                _ => Cs::Gray,
            }
        }
        _ => Cs::Gray,
    }
}

// ── Schriften ─────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct Font {
    name: String,
    /// Bytes je Zeichencode (1 einfache Schriften, 2 Type0).
    code_len: usize,
    widths: HashMap<u32, f64>,
    default_width: f64,
    to_unicode: HashMap<u32, String>,
    /// /Differences einfacher Schriften: Code → Zeichen.
    differences: HashMap<u32, char>,
}

impl Font {
    fn width(&self, code: u32) -> f64 {
        self.widths.get(&code).copied().unwrap_or(self.default_width)
    }
    fn decode_code(&self, code: u32) -> String {
        if let Some(s) = self.to_unicode.get(&code) {
            return s.clone();
        }
        if let Some(c) = self.differences.get(&code) {
            return c.to_string();
        }
        if self.code_len == 1 {
            return win_ansi(code as u8).to_string();
        }
        String::new()
    }
}

/// WinAnsiEncoding (Latin-1 mit den CP1252-Zeichen 0x80–0x9F).
fn win_ansi(b: u8) -> char {
    const HI: [u16; 32] = [
        0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152,
        0xFFFD, 0x017D, 0xFFFD, 0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122,
        0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178,
    ];
    match b {
        0x80..=0x9F => char::from_u32(HI[(b - 0x80) as usize] as u32).unwrap_or('?'),
        _ => b as char,
    }
}

/// Glyphname → Zeichen (nur die in Plänen üblichen Namen; `uniXXXX`, Ein-Zeichen-Namen).
fn glyph_char(name: &str) -> Option<char> {
    let mut it = name.chars();
    if let (Some(c), None) = (it.next(), it.next()) {
        return Some(c);
    }
    if let Some(h) = name.strip_prefix("uni") {
        if h.len() >= 4 {
            return u32::from_str_radix(&h[..4], 16).ok().and_then(char::from_u32);
        }
    }
    const NAMES: &[(&str, char)] = &[
        ("space", ' '), ("period", '.'), ("comma", ','), ("hyphen", '-'), ("minus", '−'), ("colon", ':'),
        ("semicolon", ';'), ("slash", '/'), ("parenleft", '('), ("parenright", ')'), ("plus", '+'),
        ("equal", '='), ("percent", '%'), ("degree", '°'), ("plusminus", '±'), ("multiply", '×'),
        ("zero", '0'), ("one", '1'), ("two", '2'), ("three", '3'), ("four", '4'), ("five", '5'), ("six", '6'),
        ("seven", '7'), ("eight", '8'), ("nine", '9'), ("adieresis", 'ä'), ("odieresis", 'ö'), ("udieresis", 'ü'),
        ("Adieresis", 'Ä'), ("Odieresis", 'Ö'), ("Udieresis", 'Ü'), ("germandbls", 'ß'), ("eacute", 'é'),
        ("egrave", 'è'), ("agrave", 'à'), ("ecircumflex", 'ê'), ("ccedilla", 'ç'), ("quotesingle", '\''),
        ("quotedbl", '"'), ("underscore", '_'), ("asterisk", '*'), ("numbersign", '#'), ("ampersand", '&'),
        ("bracketleft", '['), ("bracketright", ']'), ("twosuperior", '²'), ("threesuperior", '³'),
        ("endash", '–'), ("emdash", '—'), ("bullet", '•'), ("periodcentered", '·'), ("mu", 'µ'),
    ];
    NAMES.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)
}

fn utf16be(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks(2).map(|c| (c[0] as u16) << 8 | *c.get(1).unwrap_or(&0) as u16).collect();
    String::from_utf16_lossy(&units)
}

fn be(b: &[u8]) -> u32 {
    b.iter().take(4).fold(0u32, |a, &x| (a << 8) | x as u32)
}

/// ToUnicode-CMap lesen (codespacerange, bfchar, bfrange). Gibt (Codelänge, Tabelle) zurück.
fn parse_cmap(data: &[u8]) -> (Option<usize>, HashMap<u32, String>) {
    let mut map = HashMap::new();
    let mut code_len = None;
    let mut lx = Lexer::new(data, 0);
    let mut total = 0usize;
    loop {
        match lx.next_tok() {
            Tok::Eof => break,
            Tok::Kw(b"begincodespacerange") => {
                if let Tok::Str(lo) = lx.next_tok() {
                    code_len.get_or_insert(lo.len().clamp(1, 4));
                }
            }
            Tok::Kw(b"beginbfchar") => loop {
                match lx.next_tok() {
                    Tok::Str(src) => {
                        let dst = match lx.next_tok() {
                            Tok::Str(d) => utf16be(&d),
                            Tok::Name(n) => glyph_char(&n).map(String::from).unwrap_or_default(),
                            _ => String::new(),
                        };
                        if total < 200_000 {
                            map.insert(be(&src), dst);
                            total += 1;
                        }
                    }
                    _ => break,
                }
            },
            Tok::Kw(b"beginbfrange") => loop {
                let Tok::Str(lo) = lx.next_tok() else { break };
                let Tok::Str(hi) = lx.next_tok() else { break };
                let (lo_v, hi_v) = (be(&lo), be(&hi));
                if hi_v < lo_v || hi_v - lo_v > 65_535 {
                    let _ = parse_obj_skip(&mut lx);
                    continue;
                }
                match lx.next_tok() {
                    Tok::Str(dst) => {
                        let mut units: Vec<u16> =
                            dst.chunks(2).map(|c| (c[0] as u16) << 8 | *c.get(1).unwrap_or(&0) as u16).collect();
                        for code in lo_v..=hi_v {
                            if total >= 200_000 {
                                break;
                            }
                            map.insert(code, String::from_utf16_lossy(&units));
                            total += 1;
                            if let Some(last) = units.last_mut() {
                                *last = last.wrapping_add(1);
                            }
                        }
                    }
                    Tok::ArrOpen => {
                        let mut code = lo_v;
                        loop {
                            match lx.next_tok() {
                                Tok::Str(d) => {
                                    if total < 200_000 && code <= hi_v {
                                        map.insert(code, utf16be(&d));
                                        total += 1;
                                    }
                                    code = code.saturating_add(1);
                                }
                                Tok::ArrClose | Tok::Eof => break,
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            },
            _ => {}
        }
    }
    (code_len, map)
}

fn parse_obj_skip(lx: &mut Lexer) -> Option<Obj> {
    crate::pdf_object::parse_obj(lx, false)
}

fn load_font(doc: &Doc, fo: &Obj, res_name: &str) -> Font {
    let mut f = Font { name: res_name.to_string(), code_len: 1, default_width: 500.0, ..Default::default() };
    let Some(d) = doc.resolve(fo).as_dict().cloned() else { return f };
    if let Some(base) = doc.dget(&d, "BaseFont").as_name() {
        // Teilmengen-Präfix „ABCDEF+" weglassen.
        let b = match base.split_once('+') {
            Some((pre, rest)) if pre.len() == 6 => rest,
            _ => base,
        };
        f.name = b.to_string();
    }
    let subtype = doc.dget(&d, "Subtype").as_name().unwrap_or("").to_string();
    if subtype == "Type0" {
        f.code_len = 2;
        f.default_width = 1000.0;
        if let Obj::Array(desc) = doc.dget(&d, "DescendantFonts") {
            if let Some(dd) = desc.first().map(|x| doc.resolve(x)).and_then(|x| x.as_dict().cloned()) {
                if let Some(dw) = doc.dget(&dd, "DW").as_f64() {
                    f.default_width = dw;
                }
                if let Obj::Array(w) = doc.dget(&dd, "W") {
                    let w: Vec<Obj> = w.iter().map(|x| doc.resolve(x)).collect();
                    let mut i = 0usize;
                    while i < w.len() && f.widths.len() < 200_000 {
                        let Some(c0) = w[i].as_i64() else { break };
                        match w.get(i + 1) {
                            Some(Obj::Array(ws)) => {
                                for (k, x) in ws.iter().enumerate() {
                                    if let Some(v) = doc.resolve(x).as_f64() {
                                        f.widths.insert((c0.max(0) as u32).saturating_add(k as u32), v);
                                    }
                                }
                                i += 2;
                            }
                            Some(c1) => {
                                let (Some(c1), Some(v)) = (c1.as_i64(), w.get(i + 2).and_then(Obj::as_f64)) else { break };
                                let (a, b) = (c0.max(0) as u32, c1.max(0) as u32);
                                if b >= a && b - a <= 65_535 {
                                    for c in a..=b {
                                        f.widths.insert(c, v);
                                    }
                                }
                                i += 3;
                            }
                            None => break,
                        }
                    }
                }
            }
        }
    } else {
        let first = doc.dget(&d, "FirstChar").as_i64().unwrap_or(0).clamp(0, 255) as u32;
        if let Obj::Array(ws) = doc.dget(&d, "Widths") {
            for (k, x) in ws.iter().enumerate().take(256) {
                if let Some(v) = doc.resolve(x).as_f64() {
                    f.widths.insert(first + k as u32, v);
                }
            }
        }
        if let Obj::Dict(fd) = doc.dget(&d, "FontDescriptor") {
            if let Some(mw) = doc.dget(&fd, "MissingWidth").as_f64() {
                if mw > 0.0 {
                    f.default_width = mw;
                }
            }
        }
        if subtype == "Type3" {
            // Type3: Breiten in Glyphen-Einheiten (FontMatrix), grob auf 1/1000 normiert.
            if let Obj::Array(fm) = doc.dget(&d, "FontMatrix") {
                if let Some(s) = fm.first().and_then(|x| doc.resolve(x).as_f64()) {
                    let k = s * 1000.0;
                    for v in f.widths.values_mut() {
                        *v *= k;
                    }
                }
            }
        }
        if let Obj::Dict(enc) = doc.dget(&d, "Encoding") {
            if let Obj::Array(diff) = doc.dget(&enc, "Differences") {
                let mut code = 0u32;
                for x in &diff {
                    match doc.resolve(x) {
                        Obj::Int(c) => code = c.clamp(0, 255) as u32,
                        Obj::Name(n) => {
                            if let Some(ch) = glyph_char(&n) {
                                f.differences.insert(code, ch);
                            }
                            code = code.saturating_add(1);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    if let Obj::Stream(s) = doc.dget(&d, "ToUnicode") {
        if let Some(data) = doc.decode(&s) {
            let (len, map) = parse_cmap(&data);
            if let Some(l) = len {
                f.code_len = l;
            }
            f.to_unicode = map;
        }
    }
    f
}

/// Strichmuster aus dem Operanden-Array: ungerade Länge wiederholt sich gespiegelt → verdoppelt
/// (Phase entfällt); nur Nullen = durchgezogen.
fn dash_from(arr: &[Obj]) -> Vec<f64> {
    let d: Vec<f64> = arr.iter().filter_map(Obj::as_f64).map(f64::abs).take(16).collect();
    let d = if d.len() % 2 == 1 { [d.clone(), d].concat() } else { d };
    if d.iter().all(|v| *v == 0.0) {
        Vec::new()
    } else {
        d
    }
}

/// Einen Pfad an einem Clip beschneiden: ausserhalb → weg, innen → unverändert, sonst Fläche
/// (gefüllte, geschlossene Pfade) und Umriss getrennt beschnitten (Kreis/Bogen entfällt dann).
fn clip_path(clip: &Clip, p: PdfPath, out: &mut Vec<PdfPath>) {
    if clip.misses(&p.pts) {
        return;
    }
    if clip.contains_all(&p.pts) {
        out.push(p);
        return;
    }
    if p.fill.is_some() && p.closed {
        if let Some(pts) = clip.clip_polygon(&p.pts) {
            out.push(PdfPath { pts, closed: true, stroke: None, curve: None, ..p.clone() });
        }
    }
    if p.stroke.is_some() {
        for pts in clip.clip_polyline(&p.pts, p.closed) {
            out.push(PdfPath { pts, closed: false, fill: None, curve: None, ..p.clone() });
        }
    }
}

// ── Interpreter ───────────────────────────────────────────────────────────────

#[derive(Clone)]
struct GState {
    ctm: M,
    stroke: Option<u32>,
    fill: Option<u32>,
    stroke_cs: Cs,
    fill_cs: Cs,
    lw: f64,
    dash: Vec<f64>,
    /// Konstante Deckkraft (ExtGState /CA Strich, /ca Füllung).
    stroke_alpha: f64,
    fill_alpha: f64,
    font: Option<Rc<Font>>,
    font_size: f64,
    /// Aktive Clip-Bereiche (alle müssen erfüllt sein), Seitenkoordinaten.
    clips: Vec<Rc<Clip>>,
    char_sp: f64,
    word_sp: f64,
    hscale: f64,
    leading: f64,
    rise: f64,
    render_mode: i64,
}

struct Sub {
    pts: Vec<[f64; 2]>,
    closed: bool,
    /// Kubische Segmente (Seitenkoordinaten) und Zahl der geraden Segmente — für die Kreiserkennung.
    cubics: Vec<Cubic>,
    lines: usize,
}

/// Höchstzahl gleichzeitiger Clip-Bereiche.
const MAX_CLIPS: usize = 16;

/// Offener Text, an den die nächste Zeichenkette angehängt werden kann (gleiche Zeile).
struct PendingText {
    item: PdfText,
    end: [f64; 2],
    /// Einfügepunkt liegt ausserhalb des Clips → nicht übernehmen.
    clipped: bool,
}

struct Interp<'d> {
    doc: &'d Doc,
    gs: GState,
    stack: Vec<GState>,
    subs: Vec<Sub>,
    /// `W`/`W*` gesehen (Wert = gerade-ungerade): wirkt nach dem nächsten Malen/`n`.
    pending_clip: Option<bool>,
    cur: Option<[f64; 2]>,
    start: Option<[f64; 2]>,
    tm: M,
    tlm: M,
    paths: Vec<PdfPath>,
    texts: Vec<PdfText>,
    pending: Option<PendingText>,
    images: u32,
    truncated: bool,
    ops: usize,
    points: usize,
    fonts: HashMap<u32, Rc<Font>>,
    forms: Vec<u32>,
}

impl<'d> Interp<'d> {
    fn new(doc: &'d Doc, base: M) -> Self {
        Interp {
            doc,
            gs: GState {
                ctm: base,
                stroke: Some(0),
                fill: Some(0),
                stroke_cs: Cs::Gray,
                fill_cs: Cs::Gray,
                lw: 1.0,
                dash: Vec::new(),
                stroke_alpha: 1.0,
                fill_alpha: 1.0,
                font: None,
                font_size: 0.0,
                clips: Vec::new(),
                char_sp: 0.0,
                word_sp: 0.0,
                hscale: 1.0,
                leading: 0.0,
                rise: 0.0,
                render_mode: 0,
            },
            stack: Vec::new(),
            subs: Vec::new(),
            pending_clip: None,
            cur: None,
            start: None,
            tm: IDENT,
            tlm: IDENT,
            paths: Vec::new(),
            texts: Vec::new(),
            pending: None,
            images: 0,
            truncated: false,
            ops: 0,
            points: 0,
            fonts: HashMap::new(),
            forms: Vec::new(),
        }
    }

    fn run(&mut self, content: &[u8], res: &Rc<Dict>, depth: usize) {
        let mut lx = Lexer::new(content, 0);
        let mut operands: Vec<Obj> = Vec::with_capacity(8);
        loop {
            if self.truncated {
                return;
            }
            let t = lx.next_tok();
            match t {
                Tok::Eof => break,
                Tok::Kw(op) => {
                    self.ops += 1;
                    if self.ops > MAX_OPS {
                        self.truncated = true;
                        return;
                    }
                    if op == b"BI" {
                        self.skip_inline_image(&mut lx);
                    } else {
                        self.op(op, &operands, res, depth);
                    }
                    operands.clear();
                }
                Tok::DictClose | Tok::ArrClose | Tok::BraceOpen | Tok::BraceClose => {}
                other => {
                    if let Some(o) = parse_from(&mut lx, other, false, 0) {
                        if operands.len() < 64 {
                            operands.push(o);
                        }
                    }
                }
            }
        }
    }

    fn skip_inline_image(&mut self, lx: &mut Lexer) {
        self.images += 1;
        // Schlüssel/Werte bis „ID", dann Binärdaten bis „EI" (mit Trenner davor und danach).
        loop {
            match lx.next_tok() {
                Tok::Eof => return,
                Tok::Kw(b"ID") => break,
                _ => {}
            }
        }
        let buf = lx.buf;
        let mut i = lx.pos + 1;
        while i + 1 < buf.len() {
            if buf[i] == b'E'
                && buf[i + 1] == b'I'
                && i > 0
                && is_ws(buf[i - 1])
                && buf.get(i + 2).is_none_or(|&c| is_ws(c))
            {
                lx.pos = i + 2;
                return;
            }
            i += 1;
        }
        lx.pos = buf.len();
    }

    fn nums(ops: &[Obj]) -> Vec<f64> {
        ops.iter().filter_map(Obj::as_f64).collect()
    }

    fn point(&self, x: f64, y: f64) -> [f64; 2] {
        apply(&self.gs.ctm, x, y)
    }

    fn move_to(&mut self, p: [f64; 2]) {
        if let Some(last) = self.subs.last() {
            if last.pts.len() == 1 && !last.closed {
                self.subs.pop();
            }
        }
        self.subs.push(Sub { pts: vec![p], closed: false, cubics: Vec::new(), lines: 0 });
        self.cur = Some(p);
        self.start = Some(p);
        self.points += 1;
    }

    /// Offenen Teilpfad sicherstellen (nach `h` beginnt ein neuer am Startpunkt).
    fn ensure_sub(&mut self, fallback: [f64; 2]) {
        let need_new = match self.subs.last() {
            None => true,
            Some(s) => s.closed,
        };
        if need_new {
            let st = self.start.or(self.cur).unwrap_or(fallback);
            self.subs.push(Sub { pts: vec![st], closed: false, cubics: Vec::new(), lines: 0 });
        }
    }

    fn line_to(&mut self, p: [f64; 2]) {
        self.ensure_sub(p);
        if let Some(s) = self.subs.last_mut() {
            s.lines += 1;
        }
        self.push_pt(p);
    }

    /// Punkt an den offenen Teilpfad hängen (Zähler und Budget).
    fn push_pt(&mut self, p: [f64; 2]) {
        if let Some(s) = self.subs.last_mut() {
            s.pts.push(p);
        }
        self.cur = Some(p);
        self.points += 1;
        if self.points > MAX_POINTS {
            self.truncated = true;
        }
    }

    fn curve_to(&mut self, p1: [f64; 2], p2: [f64; 2], p3: [f64; 2]) {
        let Some(p0) = self.cur else {
            self.move_to(p3);
            return;
        };
        // Wang: n = sqrt(3/4 · max|Δ²| / tol).
        let dd = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| ((a[0] - 2.0 * b[0] + c[0]).powi(2) + (a[1] - 2.0 * b[1] + c[1]).powi(2)).sqrt();
        let m = dd(p0, p1, p2).max(dd(p1, p2, p3));
        let n = if m.is_finite() { ((0.75 * m / FLAT_TOL).sqrt().ceil() as usize).clamp(1, MAX_BEZIER_SEG) } else { 1 };
        self.ensure_sub(p3);
        if let Some(s) = self.subs.last_mut() {
            s.cubics.push([p0, p1, p2, p3]);
        }
        for k in 1..=n {
            let t = k as f64 / n as f64;
            let u = 1.0 - t;
            let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            self.push_pt([
                a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
            ]);
        }
    }

    fn close_path(&mut self) {
        if let Some(s) = self.subs.last_mut() {
            if !s.closed && !s.pts.is_empty() {
                s.closed = true;
            }
        }
        self.cur = self.start;
    }

    fn paint(&mut self, stroke: bool, fill: bool, even_odd: bool) {
        let subs = std::mem::take(&mut self.subs);
        self.cur = None;
        self.start = None;
        // Ein W/W* vor dem Malen wirkt erst NACH dem Malen dieses Pfades.
        let new_clip = self.pending_clip.take().and_then(|eo| {
            let polys = subs.iter().map(|s| s.pts.clone()).collect();
            Clip::from_polys(polys, eo)
        });
        if stroke || fill {
            self.emit(subs, stroke, fill, even_odd);
        }
        if let Some(c) = new_clip {
            if self.gs.clips.len() < MAX_CLIPS {
                self.gs.clips.push(Rc::new(c));
            }
        }
    }

    fn emit(&mut self, subs: Vec<Sub>, stroke: bool, fill: bool, even_odd: bool) {
        let lw = self.gs.lw * scale_of(&self.gs.ctm);
        let sc = scale_of(&self.gs.ctm);
        let dash: Vec<f64> = self.gs.dash.iter().map(|d| d * sc).collect();
        let stroke_c = if stroke { with_alpha(self.gs.stroke, self.gs.stroke_alpha) } else { None };
        let fill_c = if fill { with_alpha(self.gs.fill, self.gs.fill_alpha) } else { None };
        if stroke_c.is_none() && fill_c.is_none() {
            return;
        }
        for s in subs {
            let mut pts: Vec<[f64; 2]> = Vec::with_capacity(s.pts.len());
            for p in s.pts {
                if !(p[0].is_finite() && p[1].is_finite()) {
                    continue;
                }
                if pts.last().is_some_and(|q: &[f64; 2]| (q[0] - p[0]).abs() < 1e-9 && (q[1] - p[1]).abs() < 1e-9) {
                    continue;
                }
                pts.push(p);
            }
            let mut closed = s.closed || fill_c.is_some();
            if pts.len() > 2 {
                let (f, l) = (pts[0], pts[pts.len() - 1]);
                if (f[0] - l[0]).abs() < 1e-9 && (f[1] - l[1]).abs() < 1e-9 {
                    pts.pop();
                    closed = true;
                }
            }
            if pts.len() < 2 || (fill_c.is_some() && stroke_c.is_none() && pts.len() < 3) {
                continue;
            }
            if pts.len() == 2 {
                closed = false;
            }
            // Reine Bézier-Folge auf einem Kreis → Kreis/Bogen (nur gestrichen, sonst nützt der Fang nichts).
            let curve = if stroke_c.is_some() && s.lines == 0 && !s.cubics.is_empty() {
                fit_curve(&s.cubics, s.closed || fill_c.is_some())
            } else {
                None
            };
            self.push_path(PdfPath {
                pts,
                closed,
                stroke: stroke_c,
                fill: if closed { fill_c } else { None },
                even_odd,
                line_width: if lw.is_finite() { lw } else { 0.0 },
                dash: dash.clone(),
                curve,
            });
        }
    }

    /// Pfad nach Anwendung aller aktiven Clips anhängen.
    fn push_path(&mut self, path: PdfPath) {
        let mut pieces = vec![path];
        for clip in self.gs.clips.iter() {
            let mut next = Vec::with_capacity(pieces.len());
            for p in pieces {
                clip_path(clip, p, &mut next);
            }
            pieces = next;
            if pieces.is_empty() {
                return;
            }
        }
        self.paths.extend(pieces);
    }

    fn set_color(&mut self, stroke: bool, ops: &[Obj]) {
        let v = Self::nums(ops);
        let cs = if stroke { &self.gs.stroke_cs } else { &self.gs.fill_cs };
        let c = if matches!(cs, Cs::Pattern) {
            // Muster: bisherige Farbe behalten.
            return;
        } else {
            cs.color(&v)
        };
        if stroke {
            self.gs.stroke = c;
        } else {
            self.gs.fill = c;
        }
    }

    fn font_for(&mut self, res: &Rc<Dict>, name: &str) -> Option<Rc<Font>> {
        let fonts = self.doc.dget(res, "Font");
        let fo = fonts.as_dict()?.get(name)?.clone();
        // Zwischenspeicher nur für indirekte Schriften (Objektnummer ist eindeutig).
        let key = if let Obj::Ref(n, _) = fo { Some(n) } else { None };
        if let Some(f) = key.and_then(|k| self.fonts.get(&k)) {
            return Some(f.clone());
        }
        let f = Rc::new(load_font(self.doc, &fo, name));
        if let Some(k) = key {
            self.fonts.insert(k, f.clone());
        }
        Some(f)
    }

    fn show(&mut self, parts: &[Obj]) {
        let Some(font) = self.gs.font.clone() else { return };
        let invisible = matches!(self.gs.render_mode, 3 | 7);
        let size = self.gs.font_size;
        let th = self.gs.hscale;
        let trm0 = mul(&self.tm, &self.gs.ctm);
        let origin = apply(&trm0, 0.0, self.gs.rise);
        let height = size.abs() * (trm0[2] * trm0[2] + trm0[3] * trm0[3]).sqrt();
        let angle = trm0[1].atan2(trm0[0]);
        let mut text = String::new();
        for part in parts {
            match part {
                Obj::Str(s) => {
                    let cl = font.code_len.max(1);
                    for chunk in s.chunks(cl) {
                        let code = be(chunk);
                        text.push_str(&font.decode_code(code));
                        let w0 = font.width(code) / 1000.0;
                        let ws = if cl == 1 && code == 32 { self.gs.word_sp } else { 0.0 };
                        let tx = (w0 * size + self.gs.char_sp + ws) * th;
                        self.tm = mul(&[1.0, 0.0, 0.0, 1.0, tx, 0.0], &self.tm);
                    }
                }
                o => {
                    if let Some(n) = o.as_f64() {
                        let tx = -n / 1000.0 * size * th;
                        self.tm = mul(&[1.0, 0.0, 0.0, 1.0, tx, 0.0], &self.tm);
                        // Grosse Lücke in TJ = Wortabstand.
                        if n < -250.0 && !text.ends_with(' ') && !text.is_empty() {
                            text.push(' ');
                        }
                    }
                }
            }
        }
        if invisible || height <= 0.0 || !height.is_finite() || !origin[0].is_finite() || !origin[1].is_finite() {
            return;
        }
        let end = apply(&mul(&self.tm, &self.gs.ctm), 0.0, self.gs.rise);
        let text = text.trim_end_matches('\0').to_string();
        if text.trim().is_empty() {
            // Leerzeichen allein: nur als Trenner an einen offenen Text hängen.
            if let Some(p) = &mut self.pending {
                if !p.item.text.ends_with(' ') {
                    p.item.text.push(' ');
                }
                p.end = end;
            }
            return;
        }
        let color = self.gs.fill.unwrap_or(0);
        if let Some(p) = &mut self.pending {
            let gap = ((origin[0] - p.end[0]).powi(2) + (origin[1] - p.end[1]).powi(2)).sqrt();
            let same = (p.item.size - height).abs() <= 0.02 * height
                && (p.item.angle - angle).abs() < 1e-3
                && p.item.font == font.name
                && p.item.color == color;
            // Richtung prüfen: der neue Anfang liegt in Schreibrichtung hinter dem alten Ende.
            let along = (origin[0] - p.end[0]) * angle.cos() + (origin[1] - p.end[1]) * angle.sin();
            if same && gap < 0.6 * height && along > -0.2 * height {
                if gap > 0.15 * height && !p.item.text.ends_with(' ') {
                    p.item.text.push(' ');
                }
                p.item.text.push_str(&text);
                p.end = end;
                return;
            }
        }
        self.flush_text();
        let clipped = !self.gs.clips.iter().all(|c| c.inside(origin));
        self.pending = Some(PendingText {
            item: PdfText { text, font: font.name.clone(), x: origin[0], y: origin[1], size: height, angle, color },
            end,
            clipped,
        });
    }

    fn flush_text(&mut self) {
        if let Some(p) = self.pending.take() {
            if self.texts.len() < MAX_TEXTS && !p.clipped {
                let mut it = p.item;
                it.text = it.text.trim().to_string();
                if !it.text.is_empty() {
                    self.texts.push(it);
                }
            }
        }
    }

    fn do_xobject(&mut self, name: &str, res: &Rc<Dict>, depth: usize) {
        let xo = self.doc.dget(res, "XObject");
        let Some(entry) = xo.as_dict().and_then(|d| d.get(name)).cloned() else { return };
        let refnum = if let Obj::Ref(n, _) = entry { Some(n) } else { None };
        let Obj::Stream(s) = self.doc.resolve(&entry) else { return };
        match s.dict.get("Subtype").and_then(Obj::as_name) {
            Some("Image") => self.images += 1,
            Some("Form") => {
                if depth >= MAX_FORM_DEPTH || refnum.is_some_and(|n| self.forms.contains(&n)) {
                    return;
                }
                self.run_form(&s, refnum, res, depth);
            }
            _ => {}
        }
    }

    fn run_form(&mut self, s: &Rc<Stream>, refnum: Option<u32>, res: &Rc<Dict>, depth: usize) {
        let Some(data) = self.doc.decode(s) else { return };
        let m: M = match self.doc.dget(&s.dict, "Matrix") {
            Obj::Array(a) if a.len() >= 6 => {
                let v: Vec<f64> = a.iter().take(6).map(|x| self.doc.resolve(x).as_f64().unwrap_or(0.0)).collect();
                [v[0], v[1], v[2], v[3], v[4], v[5]]
            }
            _ => IDENT,
        };
        let form_res = match self.doc.dget(&s.dict, "Resources") {
            Obj::Dict(d) => Rc::new(d),
            _ => res.clone(),
        };
        let saved = self.gs.clone();
        let saved_stack = self.stack.len();
        let saved_subs = std::mem::take(&mut self.subs);
        self.gs.ctm = mul(&m, &self.gs.ctm);
        // /BBox der Form beschneidet ihren Inhalt (Rechteck bzw. Parallelogramm nach der CTM).
        if let Some(bb) = s.dict.get("BBox").and_then(|b| rect(self.doc, b)) {
            let poly: Vec<[f64; 2]> = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]]
                .iter()
                .map(|q| apply(&self.gs.ctm, q[0], q[1]))
                .collect();
            if let Some(c) = Clip::from_polys(vec![poly], false) {
                if self.gs.clips.len() < MAX_CLIPS {
                    self.gs.clips.push(Rc::new(c));
                }
            }
        }
        if let Some(n) = refnum {
            self.forms.push(n);
        }
        self.run(&data, &form_res, depth + 1);
        if refnum.is_some() {
            self.forms.pop();
        }
        self.stack.truncate(saved_stack);
        self.gs = saved;
        self.subs = saved_subs;
    }

    fn op(&mut self, op: &[u8], a: &[Obj], res: &Rc<Dict>, depth: usize) {
        let n = Self::nums(a);
        let f = |i: usize| n.get(i).copied().unwrap_or(0.0);
        match op {
            // Pfadaufbau
            b"m" if n.len() >= 2 => {
                let p = self.point(f(0), f(1));
                self.move_to(p);
            }
            b"l" if n.len() >= 2 => {
                let p = self.point(f(0), f(1));
                self.line_to(p);
            }
            b"c" if n.len() >= 6 => {
                let (p1, p2, p3) = (self.point(f(0), f(1)), self.point(f(2), f(3)), self.point(f(4), f(5)));
                self.curve_to(p1, p2, p3);
            }
            b"v" if n.len() >= 4 => {
                let p1 = self.cur.unwrap_or(self.point(f(0), f(1)));
                let (p2, p3) = (self.point(f(0), f(1)), self.point(f(2), f(3)));
                self.curve_to(p1, p2, p3);
            }
            b"y" if n.len() >= 4 => {
                let (p1, p3) = (self.point(f(0), f(1)), self.point(f(2), f(3)));
                self.curve_to(p1, p3, p3);
            }
            b"h" => self.close_path(),
            b"re" if n.len() >= 4 => {
                let (x, y, w, h) = (f(0), f(1), f(2), f(3));
                let p0 = self.point(x, y);
                self.move_to(p0);
                let (p1, p2, p3) = (self.point(x + w, y), self.point(x + w, y + h), self.point(x, y + h));
                self.line_to(p1);
                self.line_to(p2);
                self.line_to(p3);
                self.close_path();
            }
            // Malen
            b"S" => self.paint(true, false, false),
            b"s" => {
                self.close_path();
                self.paint(true, false, false);
            }
            b"f" | b"F" => self.paint(false, true, false),
            b"f*" => self.paint(false, true, true),
            b"B" => self.paint(true, true, false),
            b"B*" => self.paint(true, true, true),
            b"b" => {
                self.close_path();
                self.paint(true, true, false);
            }
            b"b*" => {
                self.close_path();
                self.paint(true, true, true);
            }
            b"n" => self.paint(false, false, false),
            b"W" | b"W*" => self.pending_clip = Some(op == b"W*"),
            // Grafikzustand
            b"q" => {
                if self.stack.len() < MAX_GSTACK {
                    self.stack.push(self.gs.clone());
                }
            }
            b"Q" => {
                if let Some(g) = self.stack.pop() {
                    self.gs = g;
                }
            }
            b"cm" if n.len() >= 6 => {
                let m = [f(0), f(1), f(2), f(3), f(4), f(5)];
                if m.iter().all(|v| v.is_finite()) {
                    self.gs.ctm = mul(&m, &self.gs.ctm);
                }
            }
            b"w" if !n.is_empty() => self.gs.lw = f(0).abs(),
            b"d" => {
                if let Some(Obj::Array(arr)) = a.first() {
                    self.gs.dash = dash_from(arr);
                }
            }
            b"gs" => {
                if let Some(Obj::Name(nm)) = a.first() {
                    if let Some(egs) = self.doc.dget(res, "ExtGState").as_dict().and_then(|d| d.get(nm)).map(|o| self.doc.resolve(o)) {
                        if let Some(egs) = egs.as_dict() {
                            if let Some(a) = self.doc.dget(egs, "CA").as_f64() {
                                self.gs.stroke_alpha = clamp01(a);
                            }
                            if let Some(a) = self.doc.dget(egs, "ca").as_f64() {
                                self.gs.fill_alpha = clamp01(a);
                            }
                            if let Some(lw) = self.doc.dget(egs, "LW").as_f64() {
                                self.gs.lw = lw.abs();
                            }
                            if let Obj::Array(da) = self.doc.dget(egs, "D") {
                                if let Some(Obj::Array(arr)) = da.first() {
                                    self.gs.dash = dash_from(arr);
                                }
                            }
                        }
                    }
                }
            }
            // Farben
            b"G" => {
                self.gs.stroke_cs = Cs::Gray;
                self.gs.stroke = Some(rgb(f(0), f(0), f(0)));
            }
            b"g" => {
                self.gs.fill_cs = Cs::Gray;
                self.gs.fill = Some(rgb(f(0), f(0), f(0)));
            }
            b"RG" => {
                self.gs.stroke_cs = Cs::Rgb;
                self.gs.stroke = Some(rgb(f(0), f(1), f(2)));
            }
            b"rg" => {
                self.gs.fill_cs = Cs::Rgb;
                self.gs.fill = Some(rgb(f(0), f(1), f(2)));
            }
            b"K" => {
                self.gs.stroke_cs = Cs::Cmyk;
                self.gs.stroke = Some(cmyk(f(0), f(1), f(2), f(3)));
            }
            b"k" => {
                self.gs.fill_cs = Cs::Cmyk;
                self.gs.fill = Some(cmyk(f(0), f(1), f(2), f(3)));
            }
            b"CS" | b"cs" => {
                if let Some(o) = a.first() {
                    let cs = cs_from_obj(self.doc, o, res, 0);
                    let init = cs.initial();
                    if op == b"CS" {
                        self.gs.stroke_cs = cs;
                        if init.is_some() {
                            self.gs.stroke = init;
                        }
                    } else {
                        self.gs.fill_cs = cs;
                        if init.is_some() {
                            self.gs.fill = init;
                        }
                    }
                }
            }
            b"SC" | b"SCN" => self.set_color(true, a),
            b"sc" | b"scn" => self.set_color(false, a),
            // XObjects
            b"Do" => {
                if let Some(Obj::Name(nm)) = a.first() {
                    let nm = nm.clone();
                    self.do_xobject(&nm, res, depth);
                }
            }
            // Text
            b"BT" => {
                self.tm = IDENT;
                self.tlm = IDENT;
            }
            b"ET" => {}
            b"Tf" => {
                if let (Some(Obj::Name(nm)), Some(sz)) = (a.first(), a.get(1).and_then(Obj::as_f64)) {
                    let nm = nm.clone();
                    self.gs.font = self.font_for(res, &nm).or_else(|| {
                        Some(Rc::new(Font { name: nm.clone(), code_len: 1, default_width: 500.0, ..Default::default() }))
                    });
                    self.gs.font_size = sz;
                }
            }
            b"Tc" if !n.is_empty() => self.gs.char_sp = f(0),
            b"Tw" if !n.is_empty() => self.gs.word_sp = f(0),
            b"Tz" if !n.is_empty() => self.gs.hscale = f(0) / 100.0,
            b"TL" if !n.is_empty() => self.gs.leading = f(0),
            b"Ts" if !n.is_empty() => self.gs.rise = f(0),
            b"Tr" if !n.is_empty() => self.gs.render_mode = f(0) as i64,
            b"Td" if n.len() >= 2 => {
                self.tlm = mul(&[1.0, 0.0, 0.0, 1.0, f(0), f(1)], &self.tlm);
                self.tm = self.tlm;
            }
            b"TD" if n.len() >= 2 => {
                self.gs.leading = -f(1);
                self.tlm = mul(&[1.0, 0.0, 0.0, 1.0, f(0), f(1)], &self.tlm);
                self.tm = self.tlm;
            }
            b"Tm" if n.len() >= 6 => {
                let m = [f(0), f(1), f(2), f(3), f(4), f(5)];
                if m.iter().all(|v| v.is_finite()) {
                    self.tlm = m;
                    self.tm = m;
                }
            }
            b"T*" => self.next_line(),
            b"Tj" => self.show(a),
            b"TJ" => {
                if let Some(Obj::Array(arr)) = a.first() {
                    let arr = arr.clone();
                    self.show(&arr);
                }
            }
            b"'" => {
                self.next_line();
                self.show(a);
            }
            b"\"" if a.len() >= 3 => {
                self.gs.word_sp = f(0);
                self.gs.char_sp = f(1);
                self.next_line();
                self.show(&a[2..]);
            }
            _ => {}
        }
    }

    fn next_line(&mut self) {
        self.tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -self.gs.leading], &self.tlm);
        self.tm = self.tlm;
    }
}

// ── Übergabe an JS ────────────────────────────────────────────────────────────

/// Flacher Puffer + String-Tabelle für die WASM-Grenze (TS: `src/io/pdfVector.ts`).
///
/// ```text
/// [2 (Version), pageCount, pageIndex, width, height, media×4, crop×4, rotate, truncated, images,
///  nPaths, je Pfad: flags (1 geschlossen, 2 Strich, 4 Füllung, 8 gerade-ungerade, 16 Kreis/Bogen, 32 voller Kreis),
///                   strichRGB (-1 = keine), füllRGB (-1 = keine), linienbreite, nDash, dash…, nPts, x,y…, [bei Flag 16: cx, cy, r, a0, a1],
///  nTexts, je Text: textIdx, fontIdx, x, y, grösse, winkel, farbe]
/// ```
pub fn encode(p: &PdfPage) -> (Vec<f64>, Vec<String>) {
    let mut g: Vec<f64> = Vec::with_capacity(32 + p.paths.iter().map(|x| 8 + x.dash.len() + 2 * x.pts.len()).sum::<usize>());
    let mut strings: Vec<String> = Vec::new();
    let mut idx: HashMap<String, usize> = HashMap::new();
    let mut s = |v: &str, strings: &mut Vec<String>| -> f64 {
        if let Some(&i) = idx.get(v) {
            return i as f64;
        }
        strings.push(v.to_string());
        idx.insert(v.to_string(), strings.len() - 1);
        (strings.len() - 1) as f64
    };
    g.extend_from_slice(&[2.0, p.page_count as f64, p.page_index as f64, p.width, p.height]);
    g.extend_from_slice(&p.media_box);
    g.extend_from_slice(&p.crop_box);
    g.extend_from_slice(&[p.rotate as f64, if p.truncated { 1.0 } else { 0.0 }, p.images as f64]);
    g.push(p.paths.len() as f64);
    for path in &p.paths {
        let flags = u8::from(path.closed)
            | u8::from(path.stroke.is_some()) << 1
            | u8::from(path.fill.is_some()) << 2
            | u8::from(path.even_odd) << 3
            | u8::from(path.curve.is_some()) << 4
            | u8::from(path.curve.is_some_and(|c| c.circle)) << 5;
        g.push(flags as f64);
        g.push(path.stroke.map(|c| c as f64).unwrap_or(-1.0));
        g.push(path.fill.map(|c| c as f64).unwrap_or(-1.0));
        g.push(path.line_width);
        g.push(path.dash.len() as f64);
        g.extend_from_slice(&path.dash);
        g.push(path.pts.len() as f64);
        for q in &path.pts {
            g.push(q[0]);
            g.push(q[1]);
        }
        if let Some(c) = path.curve {
            g.extend_from_slice(&[c.cx, c.cy, c.r, c.a0, c.a1]);
        }
    }
    g.push(p.texts.len() as f64);
    for t in &p.texts {
        let ti = s(&t.text, &mut strings);
        let fi = s(&t.font, &mut strings);
        g.extend_from_slice(&[ti, fi, t.x, t.y, t.size, t.angle, t.color as f64]);
    }
    (g, strings)
}

#[cfg(test)]
#[path = "pdf_vector_tests.rs"]
mod tests;
