// Export einer flachen 2D-Zeichnung (Plan → Modell-Space in Metern) als DXF oder DWG über acadrust.
// Ersetzt den handgeschriebenen DXF-Text-Writer (`src/export/dxfWriter.ts`, gelöscht): TS sammelt aus dem
// `Plan` Ebenen und Entitäten (`src/export/exportDxf.ts`), Rust baut daraus ein `CadDocument` und
// schreibt es.
//
// Versionen (Entscheid 28.10., [C1]/[C2]):
//   - DXF: **R2018 (AC1032), ASCII.** Ab R2007 sind DXF-Texte UTF-8 — Umlaute in Ebenen- und Textnamen
//     kommen ohne Code-Page-Umweg an (der alte Writer schrieb UTF-8 unter einem AC1015-Kopf, was streng
//     genommen falsch war: R2000 erwartet ANSI_1252). R2018 ist zudem acadrusts eigene Standardversion
//     (am besten geprüfter Pfad) und trägt True-Color und Linienstärken. Gängige CAD-Programme lesen sie.
//   - DWG: **R2018 (AC1032).** acadrust schreibt R2000 bis R2018; geprüft (28.10., Rundreise acadrust +
//     Gegenlesen mit libredwg, über das Dossier selbst DWG importiert) lesen sich alle Versionen mit
//     bitgleichen Koordinaten zurück. R2000 verliert aber die True-Color der Ebenen (nur ACI) und R2000/
//     R2004 speichern Texte in ANSI_1252 (Zeichen wie „≥“ werden zu \U+2265). Ab R2007 sind DWG-Texte
//     UTF-16 und Farben 24-Bit; R2018 ist acadrusts Standardversion und gleich der DXF-Version. Preis:
//     CAD-Programme vor 2018 öffnen die Datei nicht — wer das braucht, stellt `DWG_VERSION` auf AC1015
//     (Test `dwg_roundtrip_r2000` hält diesen Weg offen).
//
// Flache Kodierung (Muster `src-tauri/core/src/flat.rs`: Zahlen als `f64`-Puffer, kein JSON für
// Geometrie). Zeichenketten (Ebenennamen, Texte) kommen getrennt als eine Zeichenkette, Teile durch
// `\0` getrennt; im Zahlenpuffer steht ihr Index.
//
//   [FLAT_VERSION, Datensatz, Datensatz, …]
//   LAYER    = 1, name_idx, rgb (0xRRGGBB, −1 = keine → ACI 7), lineweight (1/100 mm, −3 = Standard)
//   LINE     = 2, layer, x1, y1, x2, y2
//   POLYLINE = 3, layer, closed (0/1), n, x0, y0, …, x(n−1), y(n−1)
//   ARC      = 4, layer, cx, cy, r, start (rad), end (rad)      (gegen den Uhrzeigersinn, DXF-Konvention)
//   CIRCLE   = 5, layer, cx, cy, r
//   TEXT     = 6, layer, text_idx, x, y, height, rotation (rad)
//   HATCH    = 7, layer, mode (0 = Vollfüllung, 1 = Linienmuster), rgb (0xRRGGBB, −1 = nach Ebene),
//              n_dash, d0 … d(n_dash−1) (Strichmuster in m: an, aus, an, aus …; 0 = durchgezogen),
//              n_fam, (angle (rad), spacing (m)) × n_fam, n, x0, y0, … x(n−1), y(n−1)   (äusserer Rand)
//
// `layer` ist der Index des LAYER-Datensatzes (Reihenfolge des Auftretens, ab 0), er muss vorher
// stehen. Schraffuren sind echte HATCH-Entitäten ([C2], 28.10.): Vollfüllung (`SOLID`) oder ein
// Linienmuster, das hier aus Winkel und Linienabstand der Dossier-Schraffur gebaut wird (je Linienschar
// eine Musterzeile, Basispunkt Ursprung — wie die Phase der bisherigen Schraffurlinien; Versatz =
// Abstand senkrecht zur Linie, schon gedreht, wie DXF es speichert). Der Rand ist eine geschlossene
// Polylinien-Kante. Zufallsstriche (`random`) haben kein Musteräquivalent: TS gibt sie weiter als
// LINE-Datensätze aus.
//
// Fehlerverhalten: ein kaputter Puffer (falsche Version, unbekannter Datensatz, abgeschnitten, Index
// ausserhalb) ergibt einen Fehler, nie einen Panic. Einzelne Entitäten mit NaN/∞ werden übersprungen
// (der alte Writer schrieb dafür „0.0“ — eine Linie zum Nullpunkt ist schlechter als keine).

use acadrust::entities::{
    BoundaryEdge, BoundaryPath, BoundaryPathFlags, Hatch, HatchPattern, HatchPatternLine, HatchPatternType,
    PolylineEdge,
};
use acadrust::{
    Arc, CadDocument, Circle, Color, DwgWriter, DxfVersion, DxfWriter, EntityType, Layer, Line,
    LineWeight, LwPolyline, Text, Vector2, Vector3,
};

/// Version der flachen Kodierung (erstes Element des Puffers).
pub const FLAT_VERSION: f64 = 1.0;

pub const REC_LAYER: f64 = 1.0;
pub const REC_LINE: f64 = 2.0;
pub const REC_POLYLINE: f64 = 3.0;
pub const REC_ARC: f64 = 4.0;
pub const REC_CIRCLE: f64 = 5.0;
pub const REC_TEXT: f64 = 6.0;
pub const REC_HATCH: f64 = 7.0;

/// DXF-Ausgabeversion (s. Kopf).
pub const DXF_VERSION: DxfVersion = DxfVersion::AC1032;
/// DWG-Ausgabeversion (s. Kopf).
pub const DWG_VERSION: DxfVersion = DxfVersion::AC1032;

/// Liest den Puffer fortlaufend; jeder Zugriff prüft die Länge (kein Panic).
struct Reader<'a> {
    buf: &'a [f64],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }
    fn f(&mut self) -> Result<f64, String> {
        let v = *self
            .buf
            .get(self.pos)
            .ok_or_else(|| format!("Puffer abgeschnitten bei {}", self.pos))?;
        self.pos += 1;
        Ok(v)
    }
    /// Nicht-negative Ganzzahl (Index, Anzahl); NaN/negativ/gebrochen = Fehler.
    fn idx(&mut self) -> Result<usize, String> {
        let v = self.f()?;
        if !v.is_finite() || v < 0.0 || v.fract() != 0.0 || v > u32::MAX as f64 {
            return Err(format!("ungültiger Index {v} bei {}", self.pos - 1));
        }
        Ok(v as usize)
    }
    fn take(&mut self, n: usize) -> Result<&'a [f64], String> {
        let end = self.pos.checked_add(n).ok_or("Überlauf")?;
        let s = self
            .buf
            .get(self.pos..end)
            .ok_or_else(|| format!("Puffer abgeschnitten bei {}", self.pos))?;
        self.pos = end;
        Ok(s)
    }
}

/// Bereinigt einen Ebenennamen wie der alte Writer: DXF-verbotene Zeichen (< > / \ " : ; ? * | = `)
/// und Leerraum werden zu „_“, leer → "0". Umlaute bleiben.
pub fn sanitize_layer_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut in_space = false;
    for ch in name.trim().chars() {
        if ch.is_whitespace() {
            if !in_space {
                out.push('_');
            }
            in_space = true;
            continue;
        }
        in_space = false;
        out.push(if "<>/\\\":;?*|=`".contains(ch) { '_' } else { ch });
    }
    if out.is_empty() {
        "0".to_string()
    } else {
        out
    }
}

/// Einzeiliger TEXT: Zeilenumbrüche werden zu einem Leerzeichen.
fn sanitize_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_break = false;
    for ch in value.chars() {
        if ch == '\r' || ch == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            in_break = false;
            out.push(ch);
        }
    }
    out
}

fn all_finite(v: &[f64]) -> bool {
    v.iter().all(|x| x.is_finite())
}

fn line_weight(v: f64) -> LineWeight {
    if !v.is_finite() || v < 0.0 {
        return LineWeight::Default;
    }
    // Gültige DXF-Stufen enden bei 211 (2.11 mm).
    LineWeight::Value(v.round().min(211.0) as i16)
}

fn layer_color(rgb: f64) -> Color {
    if !rgb.is_finite() || !(0.0..=16_777_215.0).contains(&rgb) {
        return Color::Index(7);
    }
    let v = rgb as u32;
    Color::from_rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

/// Obergrenzen gegen Unsinn im Puffer (Musterzeilen und Striche je Schraffur).
const MAX_HATCH_FAMILIES: usize = 8;
const MAX_HATCH_DASHES: usize = 16;

/// HATCH aus Rand und Muster. `families` = (Winkel in rad, Linienabstand in m); `dashes` = Strichmuster
/// in m (an, aus, …), leer = durchgezogen. Leere Schar-Liste = Vollfüllung.
fn make_hatch(pts: &[f64], solid: bool, families: &[(f64, f64)], dashes: &[f64]) -> Hatch {
    let mut hatch = if solid {
        Hatch::solid()
    } else {
        let mut pattern = HatchPattern::new("DOSSIER");
        pattern.description = "Dossier-Schraffur".to_string();
        for &(angle, spacing) in families {
            pattern.add_line(HatchPatternLine {
                angle,
                base_point: Vector2::new(0.0, 0.0),
                // Versatz zur nächsten Linie: Abstand senkrecht zur Richtung, im Weltsystem.
                offset: Vector2::new(-spacing * angle.sin(), spacing * angle.cos()),
                // DXF: positiv = Strich, negativ = Lücke.
                dash_lengths: dashes.iter().enumerate().map(|(i, d)| if i % 2 == 0 { *d } else { -*d }).collect(),
            });
        }
        let mut h = Hatch::with_pattern(pattern);
        h.pattern_type = HatchPatternType::Custom;
        h
    };
    let mut path = BoundaryPath::with_flags(BoundaryPathFlags::from_bits(1 | 2)); // äusserer Rand, Polylinie
    path.add_edge(BoundaryEdge::Polyline(PolylineEdge::new(
        pts.chunks_exact(2).map(|p| Vector2::new(p[0], p[1])).collect(),
        true,
    )));
    hatch.add_path(path);
    hatch
}

/// Baut aus der flachen Zeichnung ein acadrust-Dokument (Einheit Meter, metrisch).
pub fn build_document(flat: &[f64], strings: &str) -> Result<CadDocument, String> {
    let strs: Vec<&str> = if strings.is_empty() { Vec::new() } else { strings.split('\0').collect() };
    let str_at = |i: usize| -> Result<&str, String> {
        strs.get(i).copied().ok_or_else(|| format!("Zeichenkette {i} fehlt"))
    };

    let mut r = Reader { buf: flat, pos: 0 };
    if r.f()? != FLAT_VERSION {
        return Err("unbekannte Version der flachen Zeichnung".into());
    }

    let mut doc = CadDocument::new();
    doc.header.insertion_units = 6; // Meter
    doc.header.measurement = 1; // metrisch
    // Ebenen-Index (Datensatzreihenfolge) → bereinigter Name.
    let mut layers: Vec<String> = Vec::new();

    while !r.done() {
        let tag = r.f()?;
        if tag == REC_LAYER {
            let name = sanitize_layer_name(str_at(r.idx()?)?);
            let rgb = r.f()?;
            let lw = r.f()?;
            // Idempotent über den Namen (erster gewinnt, wie bisher); Ebene "0" gibt es immer.
            if !doc.layers.contains(&name) {
                let mut layer = Layer::new(name.clone());
                layer.color = layer_color(rgb);
                layer.line_weight = line_weight(lw);
                doc.layers.add(layer).map_err(|e| format!("Ebene {name}: {e}"))?;
            }
            layers.push(name);
            continue;
        }
        let li = r.idx()?;
        let layer = layers.get(li).ok_or_else(|| format!("Ebene {li} nicht definiert"))?.clone();
        let entity = if tag == REC_LINE {
            let v = r.take(4)?;
            all_finite(v).then(|| EntityType::Line(Line::from_coords(v[0], v[1], 0.0, v[2], v[3], 0.0)))
        } else if tag == REC_POLYLINE {
            let closed = r.f()? != 0.0;
            let n = r.idx()?;
            let v = r.take(n.checked_mul(2).ok_or("Überlauf")?)?;
            (n >= 2 && all_finite(v)).then(|| {
                let mut pl = LwPolyline::from_points(v.chunks_exact(2).map(|p| Vector2::new(p[0], p[1])).collect());
                pl.is_closed = closed;
                EntityType::LwPolyline(pl)
            })
        } else if tag == REC_ARC {
            let v = r.take(5)?;
            (all_finite(v) && v[2] > 0.0)
                .then(|| EntityType::Arc(Arc::from_coords(v[0], v[1], 0.0, v[2], v[3], v[4])))
        } else if tag == REC_CIRCLE {
            let v = r.take(3)?;
            (all_finite(v) && v[2] > 0.0).then(|| EntityType::Circle(Circle::from_coords(v[0], v[1], 0.0, v[2])))
        } else if tag == REC_TEXT {
            let value = sanitize_text(str_at(r.idx()?)?);
            let v = r.take(4)?;
            (all_finite(v) && v[2] > 0.0).then(|| {
                EntityType::Text(Text::with_value(value, Vector3::new(v[0], v[1], 0.0)).with_height(v[2]).with_rotation(v[3]))
            })
        } else if tag == REC_HATCH {
            let mode = r.f()?;
            let rgb = r.f()?;
            let n_dash = r.idx()?;
            if n_dash > MAX_HATCH_DASHES {
                return Err(format!("zu viele Striche ({n_dash}) bei {}", r.pos - 1));
            }
            let dashes = r.take(n_dash)?;
            let n_fam = r.idx()?;
            if n_fam > MAX_HATCH_FAMILIES {
                return Err(format!("zu viele Linienscharen ({n_fam}) bei {}", r.pos - 1));
            }
            let fam = r.take(n_fam.checked_mul(2).ok_or("Überlauf")?)?;
            let n = r.idx()?;
            let pts = r.take(n.checked_mul(2).ok_or("Überlauf")?)?;
            let solid = mode == 0.0;
            let families: Vec<(f64, f64)> = fam.chunks_exact(2).map(|f| (f[0], f[1])).collect();
            // Muster nur mit endlichen, positiven Abständen und Strichen (sonst rechnet CAD ins Leere).
            let valid = n >= 3
                && all_finite(pts)
                && (solid
                    || (!families.is_empty()
                        && families.iter().all(|(a, s)| a.is_finite() && s.is_finite() && *s > 1e-6)
                        && dashes.iter().all(|d| d.is_finite() && *d >= 0.0)
                        && (dashes.is_empty() || dashes.iter().sum::<f64>() > 1e-9)));
            valid.then(|| {
                let mut h = make_hatch(pts, solid, &families, dashes);
                if rgb.is_finite() && (0.0..=16_777_215.0).contains(&rgb) {
                    h.common.color = layer_color(rgb);
                }
                EntityType::Hatch(Box::new(h))
            })
        } else {
            return Err(format!("unbekannter Datensatz {tag} bei {}", r.pos - 1));
        };
        if let Some(mut e) = entity {
            e.common_mut().layer = layer;
            doc.add_entity(e).map_err(|e| format!("Entität: {e}"))?;
        }
    }
    Ok(doc)
}

/// Flache Zeichnung → DXF-Bytes (ASCII, R2018, UTF-8).
pub fn export_dxf(flat: &[f64], strings: &str) -> Result<Vec<u8>, String> {
    let doc = build_document(flat, strings)?;
    DxfWriter::new(&doc)
        .with_version(DXF_VERSION)
        .write_to_vec()
        .map_err(|e| format!("DXF schreiben: {e}"))
}

/// Flache Zeichnung → DWG-Bytes (R2018).
pub fn export_dwg(flat: &[f64], strings: &str) -> Result<Vec<u8>, String> {
    export_dwg_version(flat, strings, DWG_VERSION)
}

/// Wie [`export_dwg`], mit wählbarer Version (R2000 … R2018).
pub fn export_dwg_version(flat: &[f64], strings: &str, version: DxfVersion) -> Result<Vec<u8>, String> {
    let mut doc = build_document(flat, strings)?;
    doc.version = version;
    DwgWriter::write_to_vec(&doc).map_err(|e| format!("DWG schreiben: {e}"))
}

// ---------------------------------------------------------------------------
// WASM-Fassade (Feature "web"): eigene Bindungen hier statt in `lib.rs`, damit Import und Export
// getrennt bearbeitet werden können. Unsinn ergibt ein leeres Ergebnis (TS meldet den Fehler).
// ---------------------------------------------------------------------------

#[cfg(feature = "web")]
mod web {
    use wasm_bindgen::prelude::*;

    /// Flache Zeichnung → DXF-Bytes (R2018 ASCII); leer bei kaputtem Puffer.
    #[wasm_bindgen]
    pub fn export_dxf_flat(flat: &[f64], strings: &str) -> Vec<u8> {
        super::export_dxf(flat, strings).unwrap_or_default()
    }

    /// Flache Zeichnung → DWG-Bytes (R2018); leer bei kaputtem Puffer.
    #[wasm_bindgen]
    pub fn export_dwg_flat(flat: &[f64], strings: &str) -> Vec<u8> {
        super::export_dwg(flat, strings).unwrap_or_default()
    }

    /// Fehlertext zur letzten Eingabe (leer = in Ordnung) — für Meldungen auf der TS-Seite.
    #[wasm_bindgen]
    pub fn export_check_flat(flat: &[f64], strings: &str) -> String {
        match super::build_document(flat, strings) {
            Ok(_) => String::new(),
            Err(e) => e,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests: Rundreise über acadrusts eigene Leser (DXF und DWG).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use acadrust::{DwgReader, DxfReader};
    use std::io::Cursor;

    /// LV95-Koordinaten mit voller f64-Genauigkeit (weit vom Nullpunkt).
    const E: f64 = 2_600_123.456_789_012_3;
    const N: f64 = 1_200_456.987_654_321;

    /// Kleine Zeichnung mit allen Datensatzarten, LV95-Koordinaten und Umlauten.
    fn sample() -> (Vec<f64>, String) {
        let strings = ["21_Aussenwände", "SYMBOLS", "Küche / Essen", "Grösse ≥ 2 m²"].join("\0");
        let (e, n) = (E, N);
        let flat = vec![
            FLAT_VERSION,
            REC_LAYER, 0.0, 0x8a_5a_44 as f64, 50.0,
            REC_LAYER, 1.0, 0x11_11_11 as f64, 18.0,
            REC_LINE, 0.0, e, n, e + 4.0, n + 0.25,
            REC_POLYLINE, 0.0, 1.0, 4.0, e, n, e + 4.0, n, e + 4.0, n + 3.0, e, n + 3.0,
            REC_ARC, 1.0, e + 1.0, n + 1.0, 0.9, 0.0, std::f64::consts::FRAC_PI_2,
            REC_CIRCLE, 1.0, e + 2.0, n + 2.0, 0.5,
            REC_TEXT, 0.0, 2.0, e + 0.5, n + 0.5, 0.25, 0.3,
            REC_TEXT, 1.0, 3.0, e + 0.5, n + 1.5, 0.2, 0.0,
        ];
        (flat, strings)
    }

    fn read_dxf(bytes: Vec<u8>) -> CadDocument {
        DxfReader::from_reader(Cursor::new(bytes)).unwrap().read().unwrap()
    }
    fn read_dwg(bytes: Vec<u8>) -> CadDocument {
        DwgReader::from_stream(Cursor::new(bytes)).read().unwrap()
    }

    /// Prüft Ebenen, Entitäten und exakte f64-Koordinaten nach der Rundreise.
    fn check(doc: &CadDocument) {
        let (e, n) = (E, N);
        let wall = doc.layers.get("21_Aussenwände").expect("Ebene mit Umlaut");
        assert_eq!(wall.color.rgb(), Some((0x8a, 0x5a, 0x44)));
        assert_eq!(wall.line_weight, LineWeight::Value(50));
        assert!(doc.layers.get("SYMBOLS").is_some());

        let ents: Vec<&EntityType> = doc.entities().collect();
        let count = |t: &str| ents.iter().filter(|x| x.as_entity().entity_type() == t).count();
        assert_eq!(count("LINE"), 1);
        assert_eq!(count("LWPOLYLINE"), 1);
        assert_eq!(count("ARC"), 1);
        assert_eq!(count("CIRCLE"), 1);
        assert_eq!(count("TEXT"), 2);
        assert_eq!(ents.len(), 6);

        for ent in &ents {
            match ent {
                EntityType::Line(l) => {
                    assert_eq!(l.common.layer, "21_Aussenwände");
                    // Georeferenz: LV95 bleibt bitgenau (f64).
                    assert_eq!((l.start.x, l.start.y), (e, n));
                    assert_eq!((l.end.x, l.end.y), (e + 4.0, n + 0.25));
                }
                EntityType::LwPolyline(p) => {
                    assert!(p.is_closed);
                    assert_eq!(p.vertices.len(), 4);
                    assert_eq!((p.vertices[2].location.x, p.vertices[2].location.y), (e + 4.0, n + 3.0));
                }
                EntityType::Arc(a) => {
                    assert_eq!(a.common.layer, "SYMBOLS");
                    assert_eq!((a.center.x, a.center.y, a.radius), (e + 1.0, n + 1.0, 0.9));
                    assert!(a.start_angle.abs() < 1e-12);
                    assert!((a.end_angle - std::f64::consts::FRAC_PI_2).abs() < 1e-12);
                }
                EntityType::Circle(c) => assert_eq!((c.center.x, c.center.y, c.radius), (e + 2.0, n + 2.0, 0.5)),
                EntityType::Text(t) if t.common.layer == "21_Aussenwände" => {
                    assert_eq!(t.value, "Küche / Essen");
                    assert_eq!((t.insertion_point.x, t.insertion_point.y), (e + 0.5, n + 0.5));
                    assert!((t.height - 0.25).abs() < 1e-12);
                    assert!((t.rotation - 0.3).abs() < 1e-12);
                }
                EntityType::Text(t) => assert_eq!(t.value, "Grösse ≥ 2 m²"),
                other => panic!("unerwartet: {}", other.as_entity().entity_type()),
            }
        }
    }

    #[test]
    fn dxf_roundtrip_r2018() {
        let (flat, strings) = sample();
        let bytes = export_dxf(&flat, &strings).unwrap();
        let text = String::from_utf8(bytes.clone()).expect("R2018-DXF ist UTF-8");
        assert!(text.contains("AC1032"));
        assert!(text.contains("21_Aussenwände"));
        let doc = read_dxf(bytes);
        assert_eq!(doc.header.insertion_units, 6);
        check(&doc);
    }

    #[test]
    fn dwg_roundtrip_r2018() {
        let (flat, strings) = sample();
        let bytes = export_dwg(&flat, &strings).unwrap();
        assert_eq!(&bytes[..6], b"AC1032");
        let doc = read_dwg(bytes);
        assert_eq!(doc.version, DxfVersion::AC1032);
        assert_eq!(doc.header.insertion_units, 6);
        check(&doc);
    }

    /// Rückfallweg R2000: Geometrie, Ebenen und Umlaute bleiben; die Ebenenfarbe wird zur nächsten ACI.
    #[test]
    fn dwg_roundtrip_r2000() {
        let (flat, strings) = sample();
        let bytes = export_dwg_version(&flat, &strings, DxfVersion::AC1015).unwrap();
        assert_eq!(&bytes[..6], b"AC1015");
        let doc = read_dwg(bytes);
        let wall = doc.layers.get("21_Aussenwände").expect("Ebene mit Umlaut");
        assert!(matches!(wall.color, Color::Index(_)));
        assert_eq!(wall.line_weight, LineWeight::Value(50));
        let texts: Vec<&str> = doc
            .entities()
            .filter_map(|e| if let EntityType::Text(t) = e { Some(t.value.as_str()) } else { None })
            .collect();
        assert!(texts.contains(&"Küche / Essen"));
        let line = doc.entities().find_map(|e| if let EntityType::Line(l) = e { Some(l.clone()) } else { None }).unwrap();
        assert_eq!((line.start.x, line.start.y), (E, N));
        assert_eq!(doc.entities().count(), 6);
    }

    #[test]
    fn layer_names_sanitized_and_deduplicated() {
        assert_eq!(sanitize_layer_name("  10 Wand: tragend/aussen "), "10_Wand__tragend_aussen");
        assert_eq!(sanitize_layer_name("   "), "0");
        assert_eq!(sanitize_layer_name("Gelände"), "Gelände");
        let flat = vec![FLAT_VERSION, REC_LAYER, 0.0, -1.0, 25.0, REC_LAYER, 0.0, 0.0, 13.0, REC_LINE, 1.0, 0.0, 0.0, 1.0, 1.0];
        let doc = read_dxf(export_dxf(&flat, "A B").unwrap());
        let l = doc.layers.get("A_B").unwrap();
        assert_eq!(l.line_weight, LineWeight::Value(25)); // erster gewinnt
        assert_eq!(doc.entities().next().unwrap().as_entity().layer(), "A_B");
    }

    #[test]
    fn broken_buffers_are_errors_not_panics() {
        assert!(export_dxf(&[], "").is_err());
        assert!(export_dxf(&[2.0], "").is_err()); // falsche Version
        assert!(export_dxf(&[FLAT_VERSION, 99.0], "").is_err()); // unbekannter Datensatz
        assert!(export_dxf(&[FLAT_VERSION, REC_LINE, 0.0, 0.0, 0.0, 1.0, 1.0], "").is_err()); // Ebene fehlt
        assert!(export_dxf(&[FLAT_VERSION, REC_LAYER, 0.0, -1.0, 25.0, REC_LINE, 0.0, 0.0], "a").is_err()); // abgeschnitten
        assert!(export_dxf(&[FLAT_VERSION, REC_LAYER, 5.0, -1.0, 25.0], "a").is_err()); // Zeichenkette fehlt
        assert!(export_dxf(&[FLAT_VERSION, REC_LAYER, 0.0, -1.0, 25.0, REC_POLYLINE, 0.0, 0.0, f64::NAN], "a").is_err());
        assert!(export_dxf(&[FLAT_VERSION, REC_LAYER, 0.0, -1.0, 25.0, REC_POLYLINE, 0.0, 0.0, 1e12], "a").is_err());
        assert!(export_dwg(&[f64::NAN], "").is_err());
    }

    #[test]
    fn non_finite_entities_are_skipped() {
        let flat = vec![
            FLAT_VERSION, REC_LAYER, 0.0, -1.0, 25.0,
            REC_LINE, 0.0, f64::NAN, 0.0, 1.0, 1.0,
            REC_CIRCLE, 0.0, 0.0, 0.0, f64::INFINITY,
            REC_LINE, 0.0, 0.0, 0.0, 1.0, 1.0,
        ];
        let doc = read_dxf(export_dxf(&flat, "P").unwrap());
        assert_eq!(doc.entities().count(), 1);
    }

    /// HATCH-Rundreise: Vollfüllung und Linienmuster (zwei Scharen, gestrichelt) mit Rand, Farbe, Ebene.
    fn hatch_sample() -> (Vec<f64>, String) {
        let (e, n) = (E, N);
        let flat = vec![
            FLAT_VERSION,
            REC_LAYER, 0.0, -1.0, 13.0,
            // Vollfüllung, Farbe 0x336699
            REC_HATCH, 0.0, 0.0, 0x33_66_99 as f64, 0.0, 0.0, 4.0, e, n, e + 4.0, n, e + 4.0, n + 3.0, e, n + 3.0,
            // Kreuzschraffur 45° / 135° (Abstand 0.1 m), durchgezogen, Farbe nach Ebene
            REC_HATCH, 0.0, 1.0, -1.0, 0.0, 2.0, std::f64::consts::FRAC_PI_4, 0.1, 3.0 * std::f64::consts::FRAC_PI_4, 0.1,
            4.0, e, n, e + 4.0, n, e + 4.0, n + 3.0, e, n + 3.0,
            // Gestrichelt: 0.05 an, 0.02 aus
            REC_HATCH, 0.0, 1.0, 0x11_11_11 as f64, 2.0, 0.05, 0.02, 1.0, 0.0, 0.25,
            3.0, e, n, e + 2.0, n, e + 1.0, n + 1.0,
        ];
        (flat, "HATCH".to_string())
    }

    fn check_hatches(doc: &CadDocument) {
        let hs: Vec<&Hatch> = doc.entities().filter_map(|x| if let EntityType::Hatch(h) = x { Some(h.as_ref()) } else { None }).collect();
        assert_eq!(hs.len(), 3);
        // Vollfüllung
        assert!(hs[0].is_solid);
        assert_eq!(hs[0].common.color.rgb(), Some((0x33, 0x66, 0x99)));
        assert_eq!(hs[0].common.layer, "HATCH");
        // Kreuzschraffur
        assert!(!hs[1].is_solid);
        assert_eq!(hs[1].pattern.lines.len(), 2);
        let l0 = &hs[1].pattern.lines[0];
        assert!((l0.angle - std::f64::consts::FRAC_PI_4).abs() < 1e-9);
        // Versatz: Abstand 0.1 senkrecht zur 45°-Richtung.
        assert!((l0.offset.x + 0.1 * std::f64::consts::FRAC_PI_4.sin()).abs() < 1e-9);
        assert!((l0.offset.y - 0.1 * std::f64::consts::FRAC_PI_4.cos()).abs() < 1e-9);
        assert!(l0.dash_lengths.is_empty());
        assert!(matches!(hs[1].common.color, Color::ByLayer));
        // Gestrichelt: positiv = Strich, negativ = Lücke
        let l = &hs[2].pattern.lines[0];
        assert_eq!(l.dash_lengths, vec![0.05, -0.02]);
        assert!((l.offset.y - 0.25).abs() < 1e-9 && l.offset.x.abs() < 1e-9);
        // Rand: eine Polylinienkante, Koordinaten bitgleich
        for h in &hs {
            assert_eq!(h.paths.len(), 1);
            assert!(!h.paths[0].edges.is_empty());
        }
        let edge = |h: &Hatch| match &h.paths[0].edges[0] {
            BoundaryEdge::Polyline(p) => p.vertices.iter().map(|v| (v.x, v.y)).collect::<Vec<_>>(),
            // Beim Lesen aus DXF/DWG darf der Rand auch als Linienkanten kommen.
            BoundaryEdge::Line(_) => h
                .paths[0]
                .edges
                .iter()
                .filter_map(|e| if let BoundaryEdge::Line(l) = e { Some((l.start.x, l.start.y)) } else { None })
                .collect(),
            _ => panic!("unerwartete Randkante"),
        };
        let first = edge(hs[0]);
        assert_eq!(first.len(), 4);
        assert_eq!(first[0], (E, N));
        assert_eq!(first[2], (E + 4.0, N + 3.0));
    }

    #[test]
    fn hatch_roundtrip_dxf_und_dwg() {
        let (flat, strings) = hatch_sample();
        check_hatches(&read_dxf(export_dxf(&flat, &strings).unwrap()));
        check_hatches(&read_dwg(export_dwg(&flat, &strings).unwrap()));
    }

    #[test]
    fn hatch_dxf_text_hat_hatch_und_musterzeilen() {
        let (flat, strings) = hatch_sample();
        let text = String::from_utf8(export_dxf(&flat, &strings).unwrap()).unwrap();
        // Entität = Gruppencode 0 mit Wert HATCH (der Ebenenname HATCH steht unter Code 2/8).
        let lines: Vec<&str> = text.lines().map(str::trim).collect();
        let entities = lines.windows(2).filter(|w| w[0] == "0" && w[1] == "HATCH").count();
        assert_eq!(entities, 3);
        assert!(text.contains("DOSSIER"));
    }

    #[test]
    fn kaputte_hatches_werden_verworfen_oder_sind_fehler() {
        let head = [FLAT_VERSION, REC_LAYER, 0.0, -1.0, 13.0];
        let sq = [4.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0];
        let mk = |pre: &[f64]| {
            let mut v = head.to_vec();
            v.push(REC_HATCH);
            v.extend_from_slice(pre);
            v.extend_from_slice(&sq);
            v
        };
        // Muster ohne Scharen, Abstand 0, NaN-Winkel, negativer/leerer Strich: übersprungen.
        for pre in [
            &[0.0, 1.0, -1.0, 0.0, 0.0][..],
            &[0.0, 1.0, -1.0, 0.0, 1.0, 0.5, 0.0],
            &[0.0, 1.0, -1.0, 0.0, 1.0, f64::NAN, 0.1],
            &[0.0, 1.0, -1.0, 1.0, -0.1, 1.0, 0.5, 0.1],
            &[0.0, 1.0, -1.0, 2.0, 0.0, 0.0, 1.0, 0.5, 0.1],
        ] {
            let doc = read_dxf(export_dxf(&mk(pre), "P").unwrap());
            assert_eq!(doc.entities().count(), 0, "{pre:?}");
        }
        // Rand mit NaN oder < 3 Punkten: übersprungen.
        let mut bad = head.to_vec();
        bad.extend_from_slice(&[REC_HATCH, 0.0, 0.0, -1.0, 0.0, 0.0, 3.0, 0.0, 0.0, 1.0, f64::NAN, 1.0, 1.0]);
        assert_eq!(read_dxf(export_dxf(&bad, "P").unwrap()).entities().count(), 0);
        let mut two = head.to_vec();
        two.extend_from_slice(&[REC_HATCH, 0.0, 0.0, -1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 1.0]);
        assert_eq!(read_dxf(export_dxf(&two, "P").unwrap()).entities().count(), 0);
        // Zu viele Scharen/Striche, abgeschnitten: Fehler statt Panic.
        assert!(export_dxf(&mk(&[0.0, 1.0, -1.0, 0.0, 99.0]), "P").is_err());
        assert!(export_dxf(&mk(&[0.0, 1.0, -1.0, 99.0]), "P").is_err());
        assert!(export_dxf(&[FLAT_VERSION, REC_LAYER, 0.0, -1.0, 13.0, REC_HATCH, 0.0, 0.0, -1.0, 0.0, 0.0, 5.0, 1.0], "P").is_err());
        // Farbe ausserhalb → ByLayer statt Absturz.
        let mut col = head.to_vec();
        col.extend_from_slice(&[REC_HATCH, 0.0, 0.0, 1e12, 0.0, 0.0]);
        col.extend_from_slice(&sq);
        let doc = read_dxf(export_dxf(&col, "P").unwrap());
        assert!(matches!(doc.entities().next().unwrap().as_entity().common().color, Color::ByLayer));
    }
}
