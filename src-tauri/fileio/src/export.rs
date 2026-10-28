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
//   GRADIENT = 8, layer, rgb1 (0xRRGGBB), rgb2 (0xRRGGBB), angle (rad, Richtung rgb1 → rgb2, DXF-Konvention),
//              kind (0 = linear, 1 = radial: rgb1 in der Mitte, rgb2 am Rand), n, x0, y0, … (äusserer Rand)
//
// Seit [C2] (28.10., „Fachplaner-Export“) zusätzlich — alles rückwärtskompatibel (Version bleibt 1):
//   LTYPE    = 9,  name_idx, n, e0 … e(n−1)   Linientyp (Meter; > 0 Strich, < 0 Lücke, 0 Punkt); Index = Reihenfolge
//   LAYERLT  = 10, layer, ltype                Standard-Linientyp einer Ebene
//   PEN      = 11, ltype (−1 = nach Ebene)     gilt für alle folgenden Entitäten bis zum nächsten PEN
//   STYLE    = 12, name_idx, font_idx, bold, italic, width_factor   Textstil (TrueType-Schriftname); Index = Reihenfolge
//   TEXT2    = 13, layer, text_idx, x, y, height, rotation, halign (0 links, 1 Mitte, 2 rechts), style (−1 = Standard)
//   DIMSTYLE = 14, name_idx, textstyle (−1), scale, txt, tick, exo, exe, gap, dec, lfac, post_idx (−1)   (Papier-Meter, s. export_dim.rs)
//   DIM      = 15, layer, dimstyle, x1, y1, x2, y2, dx, dy (Punkt auf der Masslinie), has_text, tx, ty
//   BLOCK    = 16, name_idx, desc_idx (−1), n_att, (tag_idx, prompt_idx, default_idx, x, y, height) × n_att
//              — alle Entitätsdatensätze bis BLOCK_END gehören in die Blockdefinition (Koordinaten blocklokal)
//   BLOCK_END= 17
//   INSERT   = 18, layer, name_idx, x, y, rotation, sx, sy, n_att, (tag_idx, value_idx) × n_att
//   LAYOUT   = 19, name_idx, paper_w, paper_h (mm), vp_cx, vp_cy, vp_w, vp_h (mm), view_cx, view_cy (Modell-m), scale_denominator
//
// `layer` ist der Index des LAYER-Datensatzes (Reihenfolge des Auftretens, ab 0), er muss vorher
// stehen. Schraffuren sind echte HATCH-Entitäten ([C2], 28.10.): Vollfüllung (`SOLID`) oder ein
// Linienmuster, das hier aus Winkel und Linienabstand der Dossier-Schraffur gebaut wird (je Linienschar
// eine Musterzeile, Basispunkt Ursprung — wie die Phase der bisherigen Schraffurlinien; Versatz =
// Abstand senkrecht zur Linie, schon gedreht, wie DXF es speichert). Der Rand ist eine geschlossene
// Polylinien-Kante. Farbverläufe (GRADIENT, [C2], 28.10.) sind echte Gradient-HATCHs (Gruppencodes
// 450–470: Name LINEAR bzw. SPHERICAL, zwei Farbstützen 0 und 1, Winkel in Radiant). Zufallsstriche (`random`) haben kein Musteräquivalent: TS gibt sie weiter als
// LINE-Datensätze aus.
//
// Fehlerverhalten: ein kaputter Puffer (falsche Version, unbekannter Datensatz, abgeschnitten, Index
// ausserhalb) ergibt einen Fehler, nie einen Panic. Einzelne Entitäten mit NaN/∞ werden übersprungen
// (der alte Writer schrieb dafür „0.0“ — eine Linie zum Nullpunkt ist schlechter als keine).

use acadrust::entities::{
    BoundaryEdge, BoundaryPath, BoundaryPathFlags, Hatch, HatchGradientPattern, HatchPattern, HatchPatternLine,
    HatchPatternType, PolylineEdge,
};
use acadrust::entities::{
    AttributeDefinition, AttributeEntity, Insert, TextHorizontalAlignment, Viewport,
};
use acadrust::tables::{BlockRecord, LineType, LineTypeElement, TextStyle};
use acadrust::types::Handle;
use acadrust::{
    Arc, CadDocument, Circle, Color, DwgWriter, DxfVersion, DxfWriter, EntityType, Layer, Line,
    LineWeight, LwPolyline, Text, Vector2, Vector3,
};

use crate::export_dim::{build_aligned, into_entity, make_dimstyle, DimStyleDef};

/// Version der flachen Kodierung (erstes Element des Puffers).
pub const FLAT_VERSION: f64 = 1.0;

pub const REC_LAYER: f64 = 1.0;
pub const REC_LINE: f64 = 2.0;
pub const REC_POLYLINE: f64 = 3.0;
pub const REC_ARC: f64 = 4.0;
pub const REC_CIRCLE: f64 = 5.0;
pub const REC_TEXT: f64 = 6.0;
pub const REC_HATCH: f64 = 7.0;
pub const REC_GRADIENT: f64 = 8.0;
pub const REC_LTYPE: f64 = 9.0;
pub const REC_LAYER_LTYPE: f64 = 10.0;
pub const REC_PEN: f64 = 11.0;
pub const REC_STYLE: f64 = 12.0;
pub const REC_TEXT2: f64 = 13.0;
pub const REC_DIMSTYLE: f64 = 14.0;
pub const REC_DIM: f64 = 15.0;
pub const REC_BLOCK: f64 = 16.0;
pub const REC_BLOCK_END: f64 = 17.0;
pub const REC_INSERT: f64 = 18.0;
pub const REC_LAYOUT: f64 = 19.0;

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

/// Genormte CAD-Strichstärken (1/100 mm). Andere Werte kennt AutoCAD nicht; es rundet beim Lesen
/// uneinheitlich, darum rasten wir selbst auf die nächste Stufe ein.
const STD_LINE_WEIGHTS: [i16; 24] =
    [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

fn line_weight(v: f64) -> LineWeight {
    if !v.is_finite() || v < 0.0 {
        return LineWeight::Default;
    }
    let w = v.round().min(211.0) as i16;
    let nearest = STD_LINE_WEIGHTS.iter().copied().min_by_key(|s| (s - w).abs()).unwrap_or(25);
    LineWeight::Value(nearest)
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
    add_outer_boundary(&mut hatch, pts);
    hatch
}

/// Äusserer Rand als geschlossene Polylinien-Kante.
fn add_outer_boundary(hatch: &mut Hatch, pts: &[f64]) {
    let mut path = BoundaryPath::with_flags(BoundaryPathFlags::from_bits(1 | 2)); // äusserer Rand, Polylinie
    path.add_edge(BoundaryEdge::Polyline(PolylineEdge::new(
        pts.chunks_exact(2).map(|p| Vector2::new(p[0], p[1])).collect(),
        true,
    )));
    hatch.add_path(path);
}

/// Zweifarben-Verlauf als Gradient-HATCH (wie AutoCAD: Muster „SOLID“ + Gradient-Gruppencodes).
/// `radial` = Kugelverlauf (`SPHERICAL`), sonst `LINEAR` mit Drehwinkel `angle` (rad).
fn make_gradient_hatch(pts: &[f64], rgb1: u32, rgb2: u32, angle: f64, radial: bool) -> Hatch {
    let mut hatch = Hatch::solid();
    let mut g = HatchGradientPattern::new();
    g.enabled = true;
    g.angle = if radial { 0.0 } else { angle };
    g.shift = 0.0;
    g.is_single_color = false;
    g.name = if radial { "SPHERICAL" } else { "LINEAR" }.to_string();
    g.add_color(0.0, layer_color(rgb1 as f64));
    g.add_color(1.0, layer_color(rgb2 as f64));
    hatch.gradient_color = g;
    add_outer_boundary(&mut hatch, pts);
    hatch
}

/// Obergrenzen gegen Unsinn im Puffer.
const MAX_LTYPE_ELEMENTS: usize = 16;
const MAX_BLOCK_ATTS: usize = 32;

/// Blockname bereinigen: wie Ebenennamen, ein führendes `*` (= Anonymblock) wird zu `_`.
fn sanitize_block_name(name: &str) -> String {
    let n = sanitize_layer_name(name);
    if let Some(rest) = n.strip_prefix('*') {
        format!("_{rest}")
    } else {
        n
    }
}

/// Neuer Blockeintrag (BLOCK-Tabelle) mit eigenen Handles; Entitäten werden über `owner_handle` zugeordnet.
fn new_block_record(doc: &mut CadDocument, name: &str, anonymous: bool) -> Result<Handle, String> {
    let mut rec = BlockRecord::new(name);
    rec.handle = doc.allocate_handle();
    rec.block_entity_handle = doc.allocate_handle();
    rec.block_end_handle = doc.allocate_handle();
    rec.flags.anonymous = anonymous;
    let h = rec.handle;
    doc.block_records.add(rec).map_err(|e| format!("Block {name}: {e}"))?;
    Ok(h)
}

/// Eine Blockdefinition: Handle des Blockeintrags und ihre Attributdefinitionen (Tag, ATTDEF-Handle, Höhe).
struct BlockDef {
    atts: Vec<(String, Handle, f64)>,
}

/// Papierbereich: ein Layout in mm mit einem Ansichtsfenster auf den Modellbereich. `v` = Papierbreite,
/// Papierhöhe, Mittelpunkt (x, y) und Grösse (b, h) des Fensters auf dem Papier (mm), Mittelpunkt des
/// Bildausschnitts im Modell (m), Massstabsnenner. Massstab: 1 m Modell = 1000/Nenner mm Papier.
fn add_layout_with_viewport(doc: &mut CadDocument, name: &str, v: &[f64]) -> Result<(), String> {
    let (pw, ph, cx, cy, vw, vh) = (v[0], v[1], v[2], v[3], v[4], v[5]);
    let layout_handle = doc.add_layout(name).map_err(|e| format!("Layout {name}: {e}"))?;
    // Papiergrösse und Grenzen im Layout-Objekt; Blattviewport (ID 1) deckt das Papier.
    let mut overall = Handle::NULL;
    if let Some(acadrust::objects::ObjectType::Layout(l)) = doc.objects.get_mut(&layout_handle) {
        l.paper_width = pw;
        l.paper_height = ph;
        l.min_limits = (0.0, 0.0);
        l.max_limits = (pw, ph);
        l.min_extents = (0.0, 0.0, 0.0);
        l.max_extents = (pw, ph, 0.0);
        overall = l.viewport;
    }
    if let Some(EntityType::Viewport(vp)) = doc.get_entity_mut(overall) {
        vp.center = Vector3::new(pw / 2.0, ph / 2.0, 0.0);
        vp.width = pw;
        vp.height = ph;
        vp.view_center = Vector3::new(pw / 2.0, ph / 2.0, 0.0);
        vp.view_height = ph;
    }
    let mut vp = Viewport::new();
    vp.id = 2;
    vp.status = acadrust::entities::ViewportStatusFlags::default_on();
    vp.center = Vector3::new(cx, cy, 0.0);
    vp.width = vw;
    vp.height = vh;
    vp.view_center = Vector3::new(v[6], v[7], 0.0);
    vp.view_target = Vector3::new(v[6], v[7], 0.0);
    vp.set_scale(1000.0 / v[8]);
    vp.common.layer = "0".to_string();
    doc.add_entity_to_layout(EntityType::Viewport(Box::new(vp)), name)
        .map_err(|e| format!("Ansichtsfenster {name}: {e}"))?;
    Ok(())
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
    // Linientypen, Textstile, Bemassungsstile: Index (Datensatzreihenfolge) → Name bzw. Definition.
    let mut ltypes: Vec<String> = Vec::new();
    let mut styles: Vec<String> = Vec::new();
    let mut dimstyles: Vec<DimStyleDef> = Vec::new();
    let mut blocks: std::collections::HashMap<String, BlockDef> = std::collections::HashMap::new();
    let mut cur_ltype = String::new();
    let mut cur_block: Option<Handle> = None;
    let mut dim_counter = 0usize;

    // Optionaler Index: −1 = nicht gesetzt.
    let opt_idx = |v: f64, what: &str| -> Result<Option<usize>, String> {
        if v == -1.0 {
            Ok(None)
        } else if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v <= u32::MAX as f64 {
            Ok(Some(v as usize))
        } else {
            Err(format!("ungültiger Index {v} ({what})"))
        }
    };

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
        if tag == REC_LTYPE {
            let name = sanitize_layer_name(str_at(r.idx()?)?);
            let n = r.idx()?;
            if n > MAX_LTYPE_ELEMENTS {
                return Err(format!("zu viele Linientyp-Elemente ({n}) bei {}", r.pos - 1));
            }
            let el = r.take(n)?;
            let valid = n >= 2 && all_finite(el) && el.iter().map(|e| e.abs()).sum::<f64>() > 1e-9;
            // Ungültiges Muster: Index bleibt belegt, der Linientyp ist dann durchgezogen.
            if !valid || ["continuous", "bylayer", "byblock"].contains(&name.to_lowercase().as_str()) {
                ltypes.push("Continuous".to_string());
            } else {
                if !doc.line_types.contains(&name) {
                    let mut lt = LineType::new(name.clone());
                    lt.description = format!("Dossier {name}");
                    for &e in el {
                        lt.add_element(if e > 0.0 {
                            LineTypeElement::dash(e)
                        } else if e < 0.0 {
                            LineTypeElement::space(-e)
                        } else {
                            LineTypeElement::dot()
                        });
                    }
                    lt.pattern_length = el.iter().map(|e| e.abs()).sum();
                    doc.line_types.add(lt).map_err(|e| format!("Linientyp {name}: {e}"))?;
                }
                ltypes.push(name);
            }
            continue;
        }
        if tag == REC_LAYER_LTYPE {
            let li = r.idx()?;
            let ti = r.idx()?;
            let lname = layers.get(li).ok_or_else(|| format!("Ebene {li} nicht definiert"))?.clone();
            let lt = ltypes.get(ti).ok_or_else(|| format!("Linientyp {ti} nicht definiert"))?.clone();
            if lname != "0" && lt != "Continuous" {
                if let Some(layer) = doc.layers.get_mut(&lname) {
                    layer.line_type = lt;
                }
            }
            continue;
        }
        if tag == REC_PEN {
            cur_ltype = match opt_idx(r.f()?, "Linientyp")? {
                None => String::new(),
                Some(i) => ltypes.get(i).ok_or_else(|| format!("Linientyp {i} nicht definiert"))?.clone(),
            };
            if cur_ltype == "Continuous" {
                cur_ltype.clear();
            }
            continue;
        }
        if tag == REC_STYLE {
            let name = sanitize_layer_name(str_at(r.idx()?)?);
            let font = str_at(r.idx()?)?.trim().to_string();
            let bold = r.f()? != 0.0;
            let italic = r.f()? != 0.0;
            let width = r.f()?;
            if !doc.text_styles.contains(&name) {
                let mut st = TextStyle::with_truetype(name.clone(), if font.is_empty() { "Arial" } else { &font });
                st.font_file = String::new(); // Auflösung über den TrueType-Namen (XDATA), nicht über eine Datei
                st.true_type_font_flags = 34 | if bold { 0x0200_0000 } else { 0 } | if italic { 0x0100_0000 } else { 0 };
                if width.is_finite() && width > 0.0 {
                    st.width_factor = width;
                }
                doc.text_styles.add(st).map_err(|e| format!("Textstil {name}: {e}"))?;
            }
            styles.push(name);
            continue;
        }
        if tag == REC_DIMSTYLE {
            let name = sanitize_layer_name(str_at(r.idx()?)?);
            let ts = opt_idx(r.f()?, "Textstil")?;
            let v = r.take(8)?;
            let post = match opt_idx(r.f()?, "Format")? {
                Some(i) => str_at(i)?.to_string(),
                None => String::new(),
            };
            let def = DimStyleDef {
                name: name.clone(),
                text_style: match ts {
                    Some(i) => styles.get(i).ok_or_else(|| format!("Textstil {i} nicht definiert"))?.clone(),
                    None => "Standard".to_string(),
                },
                scale: v[0],
                txt: v[1],
                tick: v[2],
                exo: v[3],
                exe: v[4],
                gap: v[5],
                dec: if v[6].is_finite() { v[6] as i16 } else { -1 },
                lfac: v[7],
                post,
            };
            if def.is_valid() && !doc.dim_styles.contains(&name) {
                doc.dim_styles.add(make_dimstyle(&def)).map_err(|e| format!("Bemassungsstil {name}: {e}"))?;
            }
            dimstyles.push(def);
            continue;
        }
        if tag == REC_BLOCK {
            if cur_block.is_some() {
                return Err(format!("Block in Block bei {}", r.pos - 1));
            }
            let name = sanitize_block_name(str_at(r.idx()?)?);
            let desc = match opt_idx(r.f()?, "Beschreibung")? {
                Some(i) => str_at(i)?.to_string(),
                None => String::new(),
            };
            let n_att = r.idx()?;
            if n_att > MAX_BLOCK_ATTS {
                return Err(format!("zu viele Attribute ({n_att}) bei {}", r.pos - 1));
            }
            let h = new_block_record(&mut doc, &name, false)?;
            if let Some(br) = doc.block_records.get_mut(&name) {
                br.description = desc;
            }
            let mut atts = Vec::new();
            for _ in 0..n_att {
                let tag_s = str_at(r.idx()?)?.to_uppercase().replace(' ', "_");
                let prompt = str_at(r.idx()?)?.to_string();
                let default = str_at(r.idx()?)?.to_string();
                let v = r.take(3)?;
                if !all_finite(v) || v[2] <= 0.0 || tag_s.is_empty() {
                    continue;
                }
                let mut ad = AttributeDefinition::new(tag_s.clone(), prompt, default);
                ad.insertion_point = Vector3::new(v[0], v[1], 0.0);
                ad.height = v[2];
                ad.flags.invisible = true; // Daten, keine Beschriftung: erscheint nur im Attribut-Editor/in Tabellen
                ad.common.layer = "0".to_string();
                ad.common.owner_handle = h;
                let ah = doc.add_entity(EntityType::AttributeDefinition(ad)).map_err(|e| format!("ATTDEF: {e}"))?;
                atts.push((tag_s, ah, v[2]));
            }
            if !atts.is_empty() {
                if let Some(br) = doc.block_records.get_mut(&name) {
                    br.flags.has_attributes = true;
                }
            }
            blocks.insert(name, BlockDef { atts });
            cur_block = Some(h);
            continue;
        }
        if tag == REC_BLOCK_END {
            if cur_block.take().is_none() {
                return Err(format!("BLOCK_END ohne BLOCK bei {}", r.pos - 1));
            }
            continue;
        }
        if tag == REC_LAYOUT {
            let name = sanitize_layer_name(str_at(r.idx()?)?);
            let v = r.take(9)?;
            // Papier ≥ 10 mm, Ansichtsfenster ≥ 1 mm, Massstab > 0; sonst bleibt der Papierbereich weg.
            if all_finite(v) && v[0] >= 10.0 && v[1] >= 10.0 && v[4] >= 1.0 && v[5] >= 1.0 && v[8] > 0.0 && cur_block.is_none() {
                add_layout_with_viewport(&mut doc, &name, v)?;
            }
            continue;
        }
        let li = r.idx()?;
        let layer = layers.get(li).ok_or_else(|| format!("Ebene {li} nicht definiert"))?.clone();
        // Entitäten, die selbst Blöcke/mehrere Entitäten erzeugen (DIM), legen ihre Nebenentitäten selbst an.
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
        } else if tag == REC_TEXT2 {
            let value = sanitize_text(str_at(r.idx()?)?);
            let v = r.take(4)?;
            let halign = r.f()?;
            let style = opt_idx(r.f()?, "Textstil")?;
            let style_name = match style {
                Some(i) => styles.get(i).ok_or_else(|| format!("Textstil {i} nicht definiert"))?.clone(),
                None => "Standard".to_string(),
            };
            (all_finite(v) && v[2] > 0.0 && !value.trim().is_empty()).then(|| {
                let at = Vector3::new(v[0], v[1], 0.0);
                let mut t = Text::with_value(value, at).with_height(v[2]).with_rotation(v[3]);
                t.style = style_name;
                // TEXT 72/73: bei Mitte/rechts steht die Lage unter Gruppe 11 (Ausrichtungspunkt).
                if halign == 1.0 || halign == 2.0 {
                    t.horizontal_alignment =
                        if halign == 1.0 { TextHorizontalAlignment::Center } else { TextHorizontalAlignment::Right };
                    t.alignment_point = Some(at);
                }
                EntityType::Text(t)
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
        } else if tag == REC_GRADIENT {
            let rgb1 = r.f()?;
            let rgb2 = r.f()?;
            let angle = r.f()?;
            let kind = r.f()?;
            let n = r.idx()?;
            let pts = r.take(n.checked_mul(2).ok_or("Überlauf")?)?;
            let in_range = |c: f64| c.is_finite() && (0.0..=16_777_215.0).contains(&c);
            (n >= 3 && all_finite(pts) && angle.is_finite() && in_range(rgb1) && in_range(rgb2)).then(|| {
                EntityType::Hatch(Box::new(make_gradient_hatch(pts, rgb1 as u32, rgb2 as u32, angle, kind == 1.0)))
            })
        } else if tag == REC_DIM {
            let di = r.idx()?;
            let v = r.take(6)?;
            let has_text = r.f()? != 0.0;
            let t = r.take(2)?;
            let def = dimstyles.get(di).ok_or_else(|| format!("Bemassungsstil {di} nicht definiert"))?;
            let text_at = has_text.then(|| [t[0], t[1]]);
            let block_name = format!("*D{}", dim_counter + 1);
            match build_aligned(def, &block_name, &layer, [v[0], v[1]], [v[2], v[3]], [v[4], v[5]], text_at) {
                Some(built) if doc.dim_styles.contains(&def.name) => {
                    dim_counter += 1;
                    let bh = new_block_record(&mut doc, &block_name, true)?;
                    for mut be in built.block_entities {
                        be.common_mut().owner_handle = bh;
                        doc.add_entity(be).map_err(|e| format!("Bemassungsblock: {e}"))?;
                    }
                    Some(into_entity(built.entity))
                }
                _ => None,
            }
        } else if tag == REC_INSERT {
            let name = sanitize_block_name(str_at(r.idx()?)?);
            let v = r.take(5)?;
            let n_att = r.idx()?;
            if n_att > MAX_BLOCK_ATTS {
                return Err(format!("zu viele Attribute ({n_att}) bei {}", r.pos - 1));
            }
            let mut values: Vec<(String, String)> = Vec::new();
            for _ in 0..n_att {
                let tag_s = str_at(r.idx()?)?.to_uppercase().replace(' ', "_");
                let val = sanitize_text(str_at(r.idx()?)?);
                values.push((tag_s, val));
            }
            let def = blocks.get(&name).ok_or_else(|| format!("Block {name} nicht definiert"))?;
            (all_finite(v) && v[3].abs() > 1e-12 && v[4].abs() > 1e-12).then(|| {
                let at = Vector3::new(v[0], v[1], 0.0);
                let mut ins = Insert::new(name.clone(), at).with_rotation(v[2]).with_scale(v[3], v[4], 1.0);
                for (tag_s, ah, height) in &def.atts {
                    if let Some((_, val)) = values.iter().find(|(t, _)| t == tag_s) {
                        let mut a = AttributeEntity::new(tag_s.clone(), val.clone());
                        a.insertion_point = at;
                        a.alignment_point = at;
                        a.height = *height * v[3].abs();
                        a.rotation = v[2];
                        a.attdef_handle = *ah;
                        a.flags.invisible = true;
                        a.common.layer = layer.clone();
                        ins.attributes.push(a);
                    }
                }
                EntityType::Insert(ins)
            })
        } else {
            return Err(format!("unbekannter Datensatz {tag} bei {}", r.pos - 1));
        };
        if let Some(mut e) = entity {
            e.common_mut().layer = layer;
            // Linientyp nur auf Linien-artigen Entitäten (Schraffur/Text/Block tragen ihn nicht).
            if !cur_ltype.is_empty()
                && matches!(e, EntityType::Line(_) | EntityType::LwPolyline(_) | EntityType::Arc(_) | EntityType::Circle(_))
            {
                e.common_mut().linetype = cur_ltype.clone();
            }
            if let Some(owner) = cur_block {
                e.common_mut().owner_handle = owner;
            }
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

/// Flache Zeichnung → Binär-DXF-Bytes (R2018, UTF-8). acadrust hebt R2000/R2004 bei Binär-DXF selbst auf
/// R2010 an (BricsCAD lehnt die alten Köpfe ab); R2018 ist davon unberührt.
pub fn export_dxf_binary(flat: &[f64], strings: &str) -> Result<Vec<u8>, String> {
    let doc = build_document(flat, strings)?;
    DxfWriter::new_binary(&doc)
        .with_version(DXF_VERSION)
        .write_to_vec()
        .map_err(|e| format!("Binär-DXF schreiben: {e}"))
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

    /// Flache Zeichnung → Binär-DXF-Bytes (R2018); leer bei kaputtem Puffer.
    #[wasm_bindgen]
    pub fn export_dxf_binary_flat(flat: &[f64], strings: &str) -> Vec<u8> {
        super::export_dxf_binary(flat, strings).unwrap_or_default()
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

    /// Verlauf-HATCH: linear (45°) und radial, Farben, Name, Rand — DXF, Binär-DXF und DWG.
    fn gradient_sample() -> (Vec<f64>, String) {
        let (e, n) = (E, N);
        let flat = vec![
            FLAT_VERSION,
            REC_LAYER, 0.0, -1.0, 13.0,
            REC_GRADIENT, 0.0, 0xff_ff_ff as f64, 0x00_33_99 as f64, std::f64::consts::FRAC_PI_4, 0.0,
            4.0, e, n, e + 4.0, n, e + 4.0, n + 3.0, e, n + 3.0,
            REC_GRADIENT, 0.0, 0xff_00_00 as f64, 0x00_00_ff as f64, 0.0, 1.0,
            3.0, e, n, e + 2.0, n, e + 1.0, n + 1.0,
        ];
        (flat, "HATCH".to_string())
    }

    fn check_gradients(doc: &CadDocument) {
        let hs: Vec<&Hatch> = doc.entities().filter_map(|x| if let EntityType::Hatch(h) = x { Some(h.as_ref()) } else { None }).collect();
        assert_eq!(hs.len(), 2);
        for h in &hs {
            assert!(h.gradient_color.enabled);
            assert_eq!(h.gradient_color.colors.len(), 2);
            assert_eq!(h.common.layer, "HATCH");
            assert_eq!(h.paths.len(), 1);
        }
        let g = &hs[0].gradient_color;
        assert_eq!(g.name, "LINEAR");
        assert!((g.angle - std::f64::consts::FRAC_PI_4).abs() < 1e-9);
        assert_eq!(g.colors[0].color.rgb(), Some((0xff, 0xff, 0xff)));
        assert_eq!(g.colors[1].color.rgb(), Some((0x00, 0x33, 0x99)));
        assert_eq!(hs[1].gradient_color.name, "SPHERICAL");
        assert_eq!(hs[1].gradient_color.colors[0].color.rgb(), Some((0xff, 0, 0)));
    }

    #[test]
    fn gradient_roundtrip_dxf_binary_und_dwg() {
        let (flat, strings) = gradient_sample();
        check_gradients(&read_dxf(export_dxf(&flat, &strings).unwrap()));
        let bin = export_dxf_binary(&flat, &strings).unwrap();
        assert!(bin.starts_with(b"AutoCAD Binary DXF"));
        check_gradients(&read_dxf(bin));
        check_gradients(&read_dwg(export_dwg(&flat, &strings).unwrap()));
    }

    #[test]
    fn gradient_dxf_text_hat_gruppencodes_450_bis_470() {
        let (flat, strings) = gradient_sample();
        let text = String::from_utf8(export_dxf(&flat, &strings).unwrap()).unwrap();
        let lines: Vec<&str> = text.lines().map(str::trim).collect();
        let has = |code: &str, val: &str| lines.windows(2).any(|w| w[0] == code && w[1] == val);
        assert!(has("450", "1") && has("470", "LINEAR") && has("470", "SPHERICAL") && has("453", "2"));
    }

    #[test]
    fn kaputte_gradienten_werden_verworfen() {
        let head = [FLAT_VERSION, REC_LAYER, 0.0, -1.0, 13.0];
        let sq = [4.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0];
        for pre in [
            [f64::NAN, 0.0, 0.0, 0.0],
            [0.0, 1e12, 0.0, 0.0],
            [0.0, 0.0, f64::INFINITY, 0.0],
        ] {
            let mut v = head.to_vec();
            v.push(REC_GRADIENT);
            v.push(0.0);
            v.extend_from_slice(&pre);
            v.extend_from_slice(&sq);
            assert_eq!(read_dxf(export_dxf(&v, "P").unwrap()).entities().count(), 0, "{pre:?}");
        }
        // Weniger als 3 Randpunkte und abgeschnittener Puffer.
        let mut two = head.to_vec();
        two.extend_from_slice(&[REC_GRADIENT, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 1.0]);
        assert_eq!(read_dxf(export_dxf(&two, "P").unwrap()).entities().count(), 0);
        let mut cut = head.to_vec();
        cut.extend_from_slice(&[REC_GRADIENT, 0.0, 0.0, 0.0, 0.0]);
        assert!(export_dxf(&cut, "P").is_err());
        assert!(export_dxf_binary(&cut, "P").is_err());
    }

    #[test]
    fn binary_dxf_mit_allen_datensatzarten() {
        let (flat, strings) = sample();
        let bin = export_dxf_binary(&flat, &strings).unwrap();
        check(&read_dxf(bin));
        let (flat, strings) = hatch_sample();
        check_hatches(&read_dxf(export_dxf_binary(&flat, &strings).unwrap()));
    }

    // ── [C2] Fachplaner-Export: Linientypen, Textstile, Bemassung, Blöcke, Attribute ─────────────

    /// Zeichnung mit allen neuen Datensatzarten (LV95).
    fn cad_sample() -> (Vec<f64>, String) {
        let strings = [
            "21_Wände",         // 0 Ebene
            "0",                // 1 Ebene 0
            "DOSSIER_STRICH_0.3_0.1", // 2 Linientyp
            "DOSSIER",          // 3 Textstil
            "Helvetica Neue",   // 4 Schrift
            "DOSSIER_1-100",    // 5 Bemassungsstil
            "T_Tür_0.9x2.1",    // 6 Block
            "Tür 0.90 x 2.10",  // 7 Beschreibung
            "TYP",              // 8 Tag
            "Typ",              // 9 Prompt
            "Tür",              // 10 Vorgabe
            "BREITE",           // 11 Tag
            "0.90",             // 12 Wert
            "Fensterbank Küche",// 13 Text
        ]
        .join("\0");
        let (e, n) = (E, N);
        let flat = vec![
            FLAT_VERSION,
            REC_LAYER, 0.0, 0x8a_5a_44 as f64, 50.0,
            REC_LAYER, 1.0, -1.0, 25.0,
            REC_LTYPE, 2.0, 4.0, 0.03, -0.01, 0.03, -0.01,
            REC_LAYER_LTYPE, 0.0, 0.0,
            REC_STYLE, 3.0, 4.0, 1.0, 0.0, 1.0,
            REC_DIMSTYLE, 5.0, 0.0, 100.0, 0.004, 0.003, 0.001, 0.001, 0.0024, 2.0, 1.0, -1.0,
            // Block mit zwei Linien und einem Attribut-Paar (nur TYP definiert, BREITE unbekannt → ignoriert)
            REC_BLOCK, 6.0, 7.0, 1.0, 8.0, 9.0, 10.0, 0.0, 0.0, 0.1,
            REC_LINE, 1.0, 0.0, 0.0, 0.9, 0.0,
            REC_ARC, 1.0, 0.0, 0.0, 0.9, 0.0, std::f64::consts::FRAC_PI_2,
            REC_BLOCK_END,
            REC_PEN, 0.0,
            REC_LINE, 0.0, e, n, e + 4.0, n,
            REC_PEN, -1.0,
            REC_TEXT2, 0.0, 13.0, e + 2.0, n + 1.0, 0.2, 0.0, 1.0, 0.0,
            REC_DIM, 0.0, 0.0, e, n, e + 4.0, n, e, n - 1.0, 0.0, 0.0, 0.0,
            REC_INSERT, 0.0, 6.0, e + 1.0, n, 1.0, 1.0, 1.0, 1.0, 8.0, 12.0,
            REC_INSERT, 0.0, 6.0, e + 3.0, n, 0.0, 0.5, 0.5, 0.0,
        ];
        (flat, strings)
    }

    fn check_cad(doc: &CadDocument) {
        // Linientyp
        let lt = doc.line_types.get("DOSSIER_STRICH_0.3_0.1").expect("Linientyp");
        assert_eq!(lt.elements.len(), 4);
        assert!((lt.elements[0].length - 0.03).abs() < 1e-12 && (lt.elements[1].length + 0.01).abs() < 1e-12);
        let line = doc.model_space_entities().find_map(|x| if let EntityType::Line(l) = x { Some(l) } else { None }).expect("Linie");
        assert_eq!(line.common.linetype, "DOSSIER_STRICH_0.3_0.1");
        assert_eq!(doc.layers.get("21_Wände").unwrap().line_type, "DOSSIER_STRICH_0.3_0.1");
        // Textstil
        let st = doc.text_styles.get("DOSSIER").expect("Textstil");
        assert_eq!(st.true_type_font, "Helvetica Neue");
        // Text mit Mittelausrichtung
        let txt = doc.model_space_entities().find_map(|x| if let EntityType::Text(t) = x { Some(t) } else { None }).unwrap();
        assert_eq!(txt.value, "Fensterbank Küche");
        assert_eq!(txt.horizontal_alignment, TextHorizontalAlignment::Center);
        assert_eq!(txt.alignment_point.map(|p| (p.x, p.y)), Some((E + 2.0, N + 1.0)));
        // Bemassungsstil
        let ds = doc.dim_styles.get("DOSSIER_1-100").expect("Bemassungsstil");
        assert!((ds.dimscale - 100.0).abs() < 1e-12 && (ds.dimtxt - 0.004).abs() < 1e-12);
        assert!((ds.dimtsz - 0.0015).abs() < 1e-12 && ds.dimtad == 1);
        // Bemassung: echte DIMENSION mit Anonymblock
        let dim = doc
            .model_space_entities()
            .find_map(|x| if let EntityType::Dimension(d) = x { Some(d) } else { None })
            .expect("DIMENSION");
        assert!((dim.base().actual_measurement - 4.0).abs() < 1e-9, "{}", dim.base().actual_measurement);
        assert_eq!(dim.base().style_name, "DOSSIER_1-100");
        let block = dim.base().block_name.clone();
        assert!(block.starts_with("*D"), "{block}");
        let in_block: Vec<&EntityType> = doc.entities_in_block(&block).collect();
        assert_eq!(in_block.iter().filter(|e| matches!(e, EntityType::Line(_))).count(), 5);
        assert!(in_block.iter().any(|e| matches!(e, EntityType::Text(t) if t.value == "4.00")));
        // Block + INSERT + Attribut
        let br = doc.block_records.get("T_Tür_0.9x2.1").expect("Block");
        assert_eq!(br.description, "Tür 0.90 x 2.10");
        let content: Vec<&EntityType> = doc.entities_in_block("T_Tür_0.9x2.1").collect();
        assert_eq!(content.iter().filter(|e| matches!(e, EntityType::Line(_))).count(), 1);
        assert_eq!(content.iter().filter(|e| matches!(e, EntityType::Arc(_))).count(), 1);
        assert_eq!(content.iter().filter(|e| matches!(e, EntityType::AttributeDefinition(_))).count(), 1);
        let inserts: Vec<&Insert> =
            doc.model_space_entities().filter_map(|x| if let EntityType::Insert(i) = x { Some(i) } else { None }).collect();
        assert_eq!(inserts.len(), 2);
        assert_eq!(inserts[0].block_name, "T_Tür_0.9x2.1");
        assert_eq!((inserts[0].insert_point.x, inserts[0].insert_point.y), (E + 1.0, N));
        assert_eq!(inserts[0].attributes.len(), 1);
        assert_eq!(inserts[0].attributes[0].tag, "TYP");
        assert_eq!(inserts[0].attributes[0].value, "0.90"); // Wert 12 steht unter Tag 8 (TYP)
        assert!((inserts[1].x_scale() - 0.5).abs() < 1e-12);
        assert!(inserts[1].attributes.is_empty());
        // Die INSERTs und die Bemassung liegen im Modellbereich, Blockinhalt nicht.
        let model = doc.model_space_entities().count();
        assert!(doc.entities().count() > model);
    }

    #[test]
    fn fachplaner_export_rundreise_dxf_binaer_und_dwg() {
        let (flat, strings) = cad_sample();
        check_cad(&read_dxf(export_dxf(&flat, &strings).unwrap()));
        check_cad(&read_dxf(export_dxf_binary(&flat, &strings).unwrap()));
        check_cad(&read_dwg(export_dwg(&flat, &strings).unwrap()));
    }

    #[test]
    fn dxf_text_traegt_dimension_block_style_und_ltype() {
        let (flat, strings) = cad_sample();
        let text = String::from_utf8(export_dxf(&flat, &strings).unwrap()).unwrap();
        let lines: Vec<&str> = text.lines().map(str::trim).collect();
        let has = |code: &str, val: &str| lines.windows(2).any(|w| w[0] == code && w[1] == val);
        assert!(has("0", "DIMENSION") && has("100", "AcDbAlignedDimension"));
        assert!(has("2", "*D1"));
        assert!(has("0", "ATTDEF") && has("0", "ATTRIB"));
        assert!(has("2", "DOSSIER_STRICH_0.3_0.1") && has("2", "Helvetica Neue") == false);
        assert!(has("1000", "Helvetica Neue"));
        assert!(has("72", "1")); // TEXT zentriert
    }

    #[test]
    fn kaputte_cad_datensaetze_sind_fehler_oder_werden_verworfen() {
        let head = [FLAT_VERSION, REC_LAYER, 0.0, -1.0, 25.0];
        let mk = |rest: &[f64]| {
            let mut v = head.to_vec();
            v.extend_from_slice(rest);
            v
        };
        // Unbekannte Indizes → Fehler
        assert!(export_dxf(&mk(&[REC_DIM, 0.0, 5.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]), "P").is_err());
        assert!(export_dxf(&mk(&[REC_INSERT, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0]), "P").is_err()); // Block fehlt
        assert!(export_dxf(&mk(&[REC_PEN, 3.0]), "P").is_err());
        assert!(export_dxf(&mk(&[REC_BLOCK_END]), "P").is_err());
        assert!(export_dxf(&mk(&[REC_BLOCK, 0.0, -1.0, 0.0, REC_BLOCK, 0.0, -1.0, 0.0]), "P").is_err()); // Block im Block
        assert!(export_dxf(&mk(&[REC_LTYPE, 0.0, 99.0]), "P").is_err());
        assert!(export_dxf(&mk(&[REC_TEXT2, 0.0, 0.0, 0.0]), "P").is_err()); // abgeschnitten
        // Entartetes: DIM mit Länge 0 / NaN, INSERT mit Skalierung 0, leerer Text → übersprungen
        let ds = [REC_DIMSTYLE, 0.0, -1.0, 100.0, 0.004, 0.003, 0.001, 0.001, 0.0024, 2.0, 1.0, -1.0];
        let mut v = mk(&ds);
        v.extend_from_slice(&[REC_DIM, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 2.0, 0.0, 0.0, 0.0]);
        v.extend_from_slice(&[REC_DIM, 0.0, 0.0, f64::NAN, 1.0, 2.0, 1.0, 0.0, 2.0, 0.0, 0.0, 0.0]);
        v.extend_from_slice(&[REC_BLOCK, 0.0, -1.0, 0.0, REC_BLOCK_END, REC_INSERT, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        v.extend_from_slice(&[REC_TEXT2, 0.0, 0.0, 0.0, 0.0, 0.2, 0.0, 0.0, -1.0]);
        let doc = read_dxf(export_dxf(&v, "  ").unwrap());
        assert_eq!(doc.entities().filter(|e| !matches!(e, EntityType::Insert(_))).count(), 0);
        // Ungültiger Bemassungsstil (Massstab 0): DIM entfällt, Stil wird nicht geschrieben.
        let mut bad = mk(&[REC_DIMSTYLE, 0.0, -1.0, 0.0, 0.004, 0.003, 0.001, 0.001, 0.0024, 2.0, 1.0, -1.0]);
        bad.extend_from_slice(&[REC_DIM, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
        let doc = read_dxf(export_dxf(&bad, "S").unwrap());
        assert_eq!(doc.entities().count(), 0);
    }

    #[test]
    fn strichstaerken_rasten_auf_cad_stufen() {
        assert_eq!(line_weight(18.0), LineWeight::Value(18));
        assert_eq!(line_weight(17.0), LineWeight::Value(18));
        assert_eq!(line_weight(22.0), LineWeight::Value(20));
        assert_eq!(line_weight(1000.0), LineWeight::Value(211));
        assert_eq!(line_weight(-3.0), LineWeight::Default);
    }

    /// Papierbereich: Layout mit Blattviewport und einem Ansichtsfenster im Planmassstab.
    fn layout_flat() -> (Vec<f64>, String) {
        let flat = vec![
            FLAT_VERSION,
            REC_LAYER, 0.0, -1.0, 25.0,
            REC_LINE, 0.0, E, N, E + 10.0, N,
            // A3 quer, Fenster 400 x 277 mm um (210, 148), Ausschnitt um (E+5, N+3), 1:50
            REC_LAYOUT, 1.0, 420.0, 297.0, 210.0, 148.5, 400.0, 277.0, E + 5.0, N + 3.0, 50.0,
        ];
        (flat, "P\0Plan 1:50".to_string())
    }

    fn check_layout(doc: &CadDocument) {
        let layout = doc
            .objects
            .values()
            .find_map(|o| if let acadrust::objects::ObjectType::Layout(l) = o { (l.name == "Plan_1_50").then_some(l) } else { None })
            .or_else(|| doc.objects.values().find_map(|o| if let acadrust::objects::ObjectType::Layout(l) = o { (l.name.starts_with("Plan")).then_some(l) } else { None }))
            .expect("Layout");
        assert!((layout.paper_width - 420.0).abs() < 1e-9 && (layout.paper_height - 297.0).abs() < 1e-9);
        let vps: Vec<&acadrust::entities::Viewport> = doc
            .entities()
            .filter_map(|e| if let EntityType::Viewport(v) = e { Some(v.as_ref()) } else { None })
            .filter(|v| v.id == 2)
            .collect();
        assert_eq!(vps.len(), 1);
        let vp = vps[0];
        assert!((vp.width - 400.0).abs() < 1e-9 && (vp.height - 277.0).abs() < 1e-9);
        assert!((vp.view_center.x - (E + 5.0)).abs() < 1e-6 && (vp.view_center.y - (N + 3.0)).abs() < 1e-6);
        // 1:50 → 1 m = 20 mm Papier; Ausschnitt 277 mm / 20 = 13.85 m hoch.
        assert!((vp.view_height - 13.85).abs() < 1e-9, "{}", vp.view_height);
    }

    #[test]
    fn papierbereich_mit_ansichtsfenster_dxf_und_dwg() {
        let (flat, strings) = layout_flat();
        check_layout(&read_dxf(export_dxf(&flat, &strings).unwrap()));
        check_layout(&read_dwg(export_dwg(&flat, &strings).unwrap()));
    }

    #[test]
    fn entartetes_layout_wird_uebersprungen() {
        let (mut flat, strings) = layout_flat();
        let n = flat.len();
        flat[n - 1] = 0.0; // Massstab 0
        let doc = read_dxf(export_dxf(&flat, &strings).unwrap());
        assert!(doc.entities().all(|e| !matches!(e, EntityType::Viewport(_))));
    }
}
