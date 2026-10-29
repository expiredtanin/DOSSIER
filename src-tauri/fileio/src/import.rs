// DXF/DWG lesen (acadrust) → Kontext-Geometrie für den Import-Dialog (`src/io/dxfParser.ts`,
// `dwgParser.ts`, danach `io/dxfToDrawings.ts`). Ersetzt den früheren TS-Parser (dxf-parser) und
// libredwg-web; Tessellierung und Abbildung folgen dem früheren `dxfParser.ts`, damit der
// nachgelagerte Fluss unverändert bleibt.
//
// Ergebnis je Datei:
//   • Konturen (LINE, LWPOLYLINE/POLYLINE inkl. Bulges, ARC, CIRCLE, ELLIPSE, SPLINE, HATCH-Ränder
//     gefüllt) mit z-Höhe, Ebene, ggf. wahrer Kreis-/Bogengeometrie (`curve`).
//   • Texte (TEXT/MTEXT, MTEXT von Formatcodes gesäubert).
//   • Dreiecks-Meshes je Ebene (3DFACE, Polyface-/Polygon-Mesh, MESH).
//   • INSERT rekursiv aufgelöst (Basispunkt, Skalierung, Drehung, Raster), Ebene „0" erbt die
//     Ebene der Referenz (CAD-Regel), Tiefe begrenzt.
//   • Ebenenfarben, $INSUNITS, Entity-Histogramm (Diagnose).
//   • SOLID/TRACE (gefüllte 3-/4-Ecke) als gefüllte geschlossene Konturen, DIMENSION über den
//     Anonymblock (`*D…`) als Linien/Text, LEADER/MULTILEADER als Linien (+ Text), ATTRIB (an INSERTs)
//     und ATTDEF (in Blöcken ohne passendes ATTRIB) als Text.
//   • `$INSUNITS` wird angewendet: alle Koordinaten, Radien und Texthöhen kommen in Metern an
//     (`unit_scale`); 0/unbekannt = Faktor 1 (1:1 wie bisher).
//   • Beschriftung ([`crate::text`], [`crate::annotation`]): MTEXT-Formatcodes, Ausrichtung/Drehung
//     von TEXT/MTEXT/ATTRIB (auf Grundlinien-Anfang umgerechnet, mehrzeilige MTEXT je Zeile ein Text),
//     Pfeilspitzen an DIMENSION/LEADER/MULTILEADER, Bemassungen ohne Anonymblock aus Definitions-
//     punkten und Stil, Spline-Führungslinien, MULTILEADER mit Block-Inhalt.
//   • Papierbereich: `layouts` listet die Layouts; [`import_layout`] liest eines statt des
//     Modellraums (Viewport-Inhalt, also die Modellansicht im Layout, fehlt).
//
// Übergabe an JS als flacher f64-Puffer + String-Tabelle (`encode`), Aufbau dort beschrieben.
// Kaputte Dateien ergeben `Err(String)`; die Geometrie-Abbildung selbst ist panikfrei (alle
// Indizes geprüft, NaN-Werte verworfen).

use std::collections::HashMap;
use std::f64::consts::{PI, TAU};
use std::io::Cursor;
use std::sync::Arc;

use acadrust::entities::{
    AttachmentPoint, AttributeDefinition, AttributeEntity, BoundaryEdge, BoundaryPath, Dimension, Ellipse, Hatch,
    HorizontalAlignment, Insert, Leader, LwPolyline, Mesh, MultiLeader, PolyfaceMesh, Solid, Spline,
    Text as AText, TextHorizontalAlignment, TextVerticalAlignment, VerticalAlignment,
};
use acadrust::entities::multileader::{
    BlockContentConnectionType, LeaderContentType, MultiLeaderPathType, TextAttachmentPointType,
};
use acadrust::objects::ObjectType;
use acadrust::Handle;
use acadrust::entities::polygon_mesh::PolygonMesh;
use acadrust::io::dxf::DxfReaderConfiguration;
use acadrust::{CadDocument, DwgReadOptions, DwgReader, DxfReader, EntityType, Vector3};

use crate::annotation::{self as ann, ArrowKind, DimStyleVals, Shape};
use crate::common::{detect_kind, layer_color_rgb, SourceKind};
use crate::text::{self as txt, HAlign, Hz, VAlign};

/// Winkelauflösung der Tessellierung (~5.6° pro Segment), wie bisher in TS.
const CURVE_STEP: f64 = PI / 32.0;
/// Obergrenze der Segmentzahl (Schutz gegen entartete Eingaben).
const CURVE_MAX_SEG: usize = 256;
/// Schutz gegen zyklische/tief verschachtelte Blockreferenzen.
const MAX_INSERT_DEPTH: usize = 8;
/// Fallback-Schrifthöhe (Meter), wenn die Höhe fehlt/0 ist.
const DEFAULT_TEXT_HEIGHT: f64 = 0.25;
/// Obergrenze der Array-Zellen eines INSERT (MINSERT) — Schutz gegen 65535×65535.
const MAX_ARRAY_CELLS: usize = 100_000;

/// Wahre Kreis-/Bogengeometrie einer Kontur (Winkel in Radiant, CCW).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Curve {
    pub circle: bool,
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    pub a0: f64,
    pub a1: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    pub layer: String,
    pub z: f64,
    pub pts: Vec<[f64; 2]>,
    pub closed: bool,
    pub filled: bool,
    pub curve: Option<Curve>,
    /// Polylinie mit Bögen (LWPOLYLINE/POLYLINE, Schraffur-Rand aus einer Polylinie): die Stützpunkte
    /// `[x, y, bulge]` (abgebildet, in Metern), damit die 2D-Zeichnung echte Bogen-Segmente bekommt
    /// statt des fein zerlegten Linienzugs (`pts` bleibt tesselliert für Kontext und Fang). Nur wenn
    /// mindestens ein Segment ein Bogen ist und die Abbildung Kreise erhält (gleichmässig skaliert,
    /// gedreht, ggf. gespiegelt — dann mit umgekehrtem Vorzeichen). Kataster-Fund 29.10.: Strassen-
    /// parzellen hatten nach dem Zerlegen über 600 Stützpunkte und keine Griffe mehr.
    pub bulge_verts: Option<Vec<[f64; 3]>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Text {
    pub layer: String,
    pub x: f64,
    pub y: f64,
    pub height: f64,
    pub angle: f64,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MeshBucket {
    pub layer: String,
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportData {
    pub kind: SourceKind,
    /// `$INSUNITS` (0 = ohne Einheit, 1 = Zoll, 4 = mm, 5 = cm, 6 = m …) — roh aus der Datei.
    pub ins_units: i16,
    /// Faktor, mit dem alle Längen auf Meter umgerechnet wurden ([`unit_scale`]); 1 bei 0/unbekannt.
    pub unit_scale: f64,
    /// Ebene → Farbe `0xRRGGBB` (nur Ebenen mit Farbe), in Tabellenreihenfolge.
    pub layer_colors: Vec<(String, u32)>,
    pub contours: Vec<Contour>,
    pub texts: Vec<Text>,
    /// Je Ebene ein Puffer, in Reihenfolge des ersten Auftretens; leere werden nicht ausgegeben.
    pub meshes: Vec<MeshBucket>,
    /// Entity-Typ → Anzahl (inkl. aufgelöster Block-Inhalte), in Reihenfolge des ersten Auftretens.
    pub entity_counts: Vec<(String, u32)>,
    pub total: u32,
    /// Papierbereich-Layouts der Datei mit Inhalt (ohne „Model"), in Reiter-Reihenfolge.
    pub layouts: Vec<LayoutInfo>,
    /// Name des gelesenen Layouts; `None` = Modellraum.
    pub layout: Option<String>,
    /// Die Datei war beschädigt/abgeschnitten und wurde tolerant (teilweise) gelesen.
    pub recovered: bool,
}

/// Ein Papierbereich-Layout (Plankopf, Ansichtsfenster auf das Modell).
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutInfo {
    pub name: String,
    /// Zeichnungs-Entities im Layout (ohne Ansichtsfenster).
    pub entities: u32,
}

// ── Einlesen ──────────────────────────────────────────────────────────────────

/// Geteilter, unveränderlicher Puffer für acadrust (`Read + Seek + 'static`), damit der zweite
/// (tolerante) Leseversuch keine weitere Kopie der Datei braucht.
#[derive(Clone)]
struct SharedBytes(Arc<Vec<u8>>);

impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// Liest DXF (ASCII/Binär) oder DWG. Erst streng; schlägt das fehl, tolerant (failsafe) — liefert
/// auch das nichts, kommt die ursprüngliche Fehlermeldung zurück.
pub fn read_document(bytes: &[u8]) -> Result<(SourceKind, CadDocument), String> {
    read_document_owned(bytes.to_vec())
}

/// Wie [`read_document`], übernimmt den Puffer (keine Kopie).
pub fn read_document_owned(bytes: Vec<u8>) -> Result<(SourceKind, CadDocument), String> {
    read_document_flagged(bytes).map(|(kind, doc, _)| (kind, doc))
}

/// Grösste lesbare Datei: im WASM (32 Bit) sind es 4 GB Adressraum, Puffer + Dokument brauchen ein
/// Vielfaches der Dateigrösse — darüber lieber eine klare Meldung als ein Speicherabbruch.
pub const MAX_INPUT_BYTES: usize = 1_500_000_000;

/// Offensichtlich keine DXF/DWG-Datei: leer, zu gross, oder Text ohne DXF-Struktur. Fängt den
/// häufigen Fall (falsche Datei gewählt, leerer Download) mit verständlicher Meldung ab, bevor
/// acadrust darauf losgelassen wird.
fn precheck(bytes: &[u8], kind: SourceKind) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Die Datei ist leer.".to_string());
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "Die Datei ist zu gross ({} MB, höchstens {} MB): bitte in AutoCAD in kleinere Teile aufteilen (WBLOCK) oder bereinigen (PURGE).",
            bytes.len() / 1_000_000,
            MAX_INPUT_BYTES / 1_000_000
        ));
    }
    if kind == SourceKind::Dxf && !bytes.starts_with(b"AutoCAD Binary DXF") {
        // ASCII-DXF: „SECTION" steht in den ersten Zeilen (Kommentare 999 davor sind möglich).
        let head = &bytes[..bytes.len().min(1 << 20)];
        let has = head.windows(7).any(|w| w.eq_ignore_ascii_case(b"SECTION"));
        if !has {
            return Err("Keine DXF- oder DWG-Datei erkannt (Kennung fehlt). Wurde die richtige Datei gewählt?".to_string());
        }
    }
    Ok(())
}

/// Wie [`read_document_owned`], dazu ein Flag: `true`, wenn nur der tolerante Zweitversuch gelang
/// (beschädigte oder abgeschnittene Datei, Inhalt unvollständig).
pub fn read_document_flagged(bytes: Vec<u8>) -> Result<(SourceKind, CadDocument, bool), String> {
    let kind = detect_kind(&bytes);
    precheck(&bytes, kind)?;
    let shared = SharedBytes(Arc::new(bytes));
    match read_with(kind, shared.clone(), false) {
        Ok(doc) => Ok((kind, doc, false)),
        Err(err) => match read_with(kind, shared, true) {
            Ok(doc) if doc.entities().next().is_some() => Ok((kind, doc, true)),
            _ => Err(err),
        },
    }
}

/// Anzahl der in acadrust abgefangenen Panics (nur nativ: im WASM bricht ein Panic die Instanz ab).
/// Diagnose für den Fuzz-Test, der beschädigte Dateien einspielt.
pub static READ_PANICS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn read_with(kind: SourceKind, bytes: SharedBytes, failsafe: bool) -> Result<CadDocument, String> {
    // acadrust darf keinen Panic bis hierher durchreichen (nativ abgefangen; im WASM bricht ein
    // Panic die Instanz ab, dort läuft jeder Import in einem eigenen Worker).
    let res = std::panic::catch_unwind(move || match kind {
        SourceKind::Dxf => {
            let config = DxfReaderConfiguration { failsafe, ..Default::default() };
            DxfReader::from_reader(Cursor::new(bytes))
                .map(|r| r.with_configuration(config))
                .and_then(|r| r.read())
                .map_err(|e| format!("DXF nicht lesbar: {e}"))
        }
        SourceKind::Dwg => {
            let options = if failsafe { DwgReadOptions::failsafe() } else { DwgReadOptions::default() };
            DwgReader::from_stream_with_options(Cursor::new(bytes), options)
                .read()
                .map_err(|e| format!("DWG nicht lesbar: {e}"))
        }
    });
    res.unwrap_or_else(|_| {
        READ_PANICS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Err("Datei nicht lesbar: beschädigter Inhalt (interner Fehler beim Lesen)".to_string())
    })
}

/// Datei lesen und abbilden.
pub fn import_bytes(bytes: &[u8]) -> Result<ImportData, String> {
    import_owned(bytes.to_vec())
}

/// Wie [`import_bytes`], übernimmt den Puffer.
pub fn import_owned(bytes: Vec<u8>) -> Result<ImportData, String> {
    let (kind, doc, recovered) = read_document_flagged(bytes)?;
    let mut data = map_document(kind, &doc);
    data.recovered = recovered;
    Ok(data)
}

/// Wie [`import_owned`], liest aber das Papierbereich-Layout `name` statt des Modellraums
/// (Gross-/Kleinschreibung egal). Unbekannter Name → Fehler mit den vorhandenen Layouts.
pub fn import_layout(bytes: Vec<u8>, name: &str) -> Result<ImportData, String> {
    let (kind, doc, recovered) = read_document_flagged(bytes)?;
    let mut data = map_document_space(kind, &doc, &Space::Layout(name))?;
    data.recovered = recovered;
    Ok(data)
}

// ── Abbildung ─────────────────────────────────────────────────────────────────

/// Meter je Zeicheneinheit nach `$INSUNITS` (AutoCAD-Codes). 0 (ohne Einheit) und Unbekanntes
/// ergeben 1.0: die Koordinaten bleiben dann wie in der Datei.
pub fn unit_scale(ins_units: i16) -> f64 {
    match ins_units {
        1 | 22 => 0.0254,                // Zoll (22 = US-Survey-Zoll, Unterschied < 1e-5)
        2 => 0.3048,                     // Fuss
        3 => 1609.344,                   // Meile
        4 => 0.001,                      // Millimeter
        5 => 0.01,                       // Zentimeter
        6 => 1.0,                        // Meter
        7 => 1000.0,                     // Kilometer
        8 => 2.54e-8,                    // Mikrozoll
        9 => 2.54e-5,                    // Mil
        10 => 0.9144,                    // Yard
        11 => 1e-10,                     // Ångström
        12 => 1e-9,                      // Nanometer
        13 => 1e-6,                      // Mikrometer
        14 => 0.1,                       // Dezimeter
        15 => 10.0,                      // Dekameter
        16 => 100.0,                     // Hektometer
        17 => 1e9,                       // Gigameter
        18 => 1.495_978_707e11,          // Astronomische Einheit
        19 => 9.460_730_472_580_8e15,    // Lichtjahr
        20 => 3.085_677_581_491_4e16,    // Parsec
        21 => 1200.0 / 3937.0,           // US-Survey-Fuss
        23 => 3600.0 / 3937.0,           // US-Survey-Yard
        24 => 6_336_000.0 / 3937.0,      // US-Survey-Meile
        _ => 1.0,
    }
}

/// 2D-Affinabbildung + z: `[x', y'] = M·[x, y] + t`, `z' = z·zs + zo`.
#[derive(Debug, Clone, Copy)]
struct Xf {
    m00: f64,
    m01: f64,
    m10: f64,
    m11: f64,
    tx: f64,
    ty: f64,
    zs: f64,
    zo: f64,
}

const IDENTITY: Xf = Xf { m00: 1.0, m01: 0.0, m10: 0.0, m11: 1.0, tx: 0.0, ty: 0.0, zs: 1.0, zo: 0.0 };

impl Xf {
    fn is_identity(&self) -> bool {
        self.m00 == 1.0
            && self.m01 == 0.0
            && self.m10 == 0.0
            && self.m11 == 1.0
            && self.tx == 0.0
            && self.ty == 0.0
            && self.zs == 1.0
            && self.zo == 0.0
    }
    fn xy(&self, x: f64, y: f64) -> [f64; 2] {
        if self.is_identity() {
            return [x, y];
        }
        [self.m00 * x + self.m01 * y + self.tx, self.m10 * x + self.m11 * y + self.ty]
    }
    fn z(&self, z: f64) -> f64 {
        z * self.zs + self.zo
    }
    /// `self ∘ inner` (inner zuerst).
    fn compose(&self, inner: &Xf) -> Xf {
        Xf {
            m00: self.m00 * inner.m00 + self.m01 * inner.m10,
            m01: self.m00 * inner.m01 + self.m01 * inner.m11,
            m10: self.m10 * inner.m00 + self.m11 * inner.m10,
            m11: self.m10 * inner.m01 + self.m11 * inner.m11,
            tx: self.m00 * inner.tx + self.m01 * inner.ty + self.tx,
            ty: self.m10 * inner.tx + self.m11 * inner.ty + self.ty,
            zs: self.zs * inner.zs,
            zo: self.zs * inner.zo + self.zo,
        }
    }
    /// Ähnlichkeitsabbildung (gleichmässig skaliert, gedreht, nicht gespiegelt) → (Massstab, Drehung).
    fn similarity(&self) -> Option<(f64, f64)> {
        let det = self.m00 * self.m11 - self.m01 * self.m10;
        if det <= 0.0 {
            return None;
        }
        let s = det.sqrt();
        let tol = 1e-9 * s.max(1.0);
        if (self.m00 - self.m11).abs() > tol || (self.m01 + self.m10).abs() > tol {
            return None;
        }
        Some((s, self.m10.atan2(self.m00)))
    }
    /// Winkeltreue Abbildung (gleichmässig skaliert und gedreht, ggf. gespiegelt)? `Some(true)` =
    /// gespiegelt (Bögen laufen andersherum), `None` = verzerrt (aus Kreisen werden Ellipsen).
    fn conformal(&self) -> Option<bool> {
        let det = self.m00 * self.m11 - self.m01 * self.m10;
        if !(det.is_finite() && det != 0.0) {
            return None;
        }
        let tol = 1e-9 * det.abs().sqrt().max(1.0);
        if det > 0.0 && (self.m00 - self.m11).abs() <= tol && (self.m01 + self.m10).abs() <= tol {
            return Some(false);
        }
        if det < 0.0 && (self.m00 + self.m11).abs() <= tol && (self.m01 - self.m10).abs() <= tol {
            return Some(true);
        }
        None
    }
    /// Längenmassstab (für Texthöhen): Wurzel der Determinante.
    fn scale(&self) -> f64 {
        (self.m00 * self.m11 - self.m01 * self.m10).abs().sqrt()
    }
}

struct Mapper<'a> {
    doc: &'a CadDocument,
    contours: Vec<Contour>,
    texts: Vec<Text>,
    meshes: Vec<MeshBucket>,
    mesh_index: HashMap<String, usize>,
    counts: Vec<(String, u32)>,
    count_index: HashMap<&'static str, usize>,
    total: u32,
    /// ATTRIB-Tags (grossgeschrieben) des gerade aufgelösten INSERT: dazu gehörige ATTDEFs im Block
    /// zeigen nicht ihren Vorgabewert (AutoCAD zeichnet statt dessen das ATTRIB der Referenz).
    insert_tags: Vec<std::collections::HashSet<String>>,
    /// Attributwerte eines MULTILEADER-Blocks (Tag in Grossbuchstaben → Text), für ATTDEFs im Block.
    ml_attrs: Vec<HashMap<String, String>>,
    /// Bemassungsstile, einmal gelesen.
    dim_styles: HashMap<String, DimStyleVals>,
}

/// Welcher Raum der Datei abgebildet wird.
#[derive(Debug, Clone, Copy)]
pub enum Space<'a> {
    Model,
    Layout(&'a str),
}

/// Ein Layout der Datei: Name, Blockname des Papierbereichs, Papiereinheit (0 Zoll, 1 mm, 2 Pixel).
struct LayoutRef {
    name: String,
    block: String,
    paper_units: i16,
    tab: i16,
}

/// Papierbereich-Layouts (ohne das Modell-Layout), nach Reiter-Reihenfolge.
fn layout_refs(doc: &CadDocument) -> Vec<LayoutRef> {
    let mut out: Vec<LayoutRef> = doc
        .objects
        .values()
        .filter_map(|o| match o {
            ObjectType::Layout(l) if !l.name.eq_ignore_ascii_case("Model") => {
                let block = doc
                    .block_records
                    .iter()
                    .find(|b| b.handle == l.block_record || (!b.layout.is_null() && b.layout == l.handle))?;
                Some(LayoutRef { name: l.name.clone(), block: block.name.clone(), paper_units: l.plot_paper_units, tab: l.tab_order })
            }
            _ => None,
        })
        .collect();
    out.sort_by(|a, b| a.tab.cmp(&b.tab).then_with(|| a.name.cmp(&b.name)));
    out
}

/// Ganzes Dokument abbilden: Modellraum (ohne Papierbereich), INSERTs aufgelöst.
pub fn map_document(kind: SourceKind, doc: &CadDocument) -> ImportData {
    // Der Modellraum gibt es immer; nur ein Layout kann fehlen.
    map_document_space(kind, doc, &Space::Model).unwrap_or_else(|_| empty_data(kind))
}

fn empty_data(kind: SourceKind) -> ImportData {
    ImportData {
        kind,
        ins_units: 0,
        unit_scale: 1.0,
        layer_colors: Vec::new(),
        contours: Vec::new(),
        texts: Vec::new(),
        meshes: Vec::new(),
        entity_counts: Vec::new(),
        total: 0,
        layouts: Vec::new(),
        layout: None,
        recovered: false,
    }
}

/// Wie [`map_document`] für einen wählbaren Raum.
pub fn map_document_space(kind: SourceKind, doc: &CadDocument, space: &Space) -> Result<ImportData, String> {
    let mut m = Mapper {
        doc,
        contours: Vec::new(),
        texts: Vec::new(),
        meshes: Vec::new(),
        mesh_index: HashMap::new(),
        counts: Vec::new(),
        count_index: HashMap::new(),
        total: 0,
        insert_tags: Vec::new(),
        ml_attrs: Vec::new(),
        dim_styles: HashMap::new(),
    };
    let model_scale = {
        let s = unit_scale(doc.header.insertion_units);
        if s.is_finite() && s > 0.0 {
            s
        } else {
            1.0
        }
    };
    let layouts = layout_refs(doc);
    let (scale, layout_name, entities): (f64, Option<String>, Vec<&EntityType>) = match space {
        Space::Model => {
            let model: Vec<&EntityType> = if doc.block_records.get("*Model_Space").is_some() {
                doc.model_space_entities().collect()
            } else {
                doc.entities().collect()
            };
            (model_scale, None, model)
        }
        Space::Layout(name) => {
            let Some(l) = layouts.iter().find(|l| l.name.eq_ignore_ascii_case(name.trim())) else {
                let have: Vec<&str> = layouts.iter().map(|l| l.name.as_str()).collect();
                return Err(format!("Layout „{name}“ nicht gefunden (vorhanden: {}).", have.join(", ")));
            };
            // Papierbereich: Einheit des Papiers (mm/Zoll), nicht die des Modells.
            let scale = match l.paper_units {
                0 => 0.0254,
                1 => 0.001,
                _ => model_scale,
            };
            (scale, Some(l.name.clone()), doc.entities_in_block(&l.block).collect())
        }
    };
    let root = Xf { m00: scale, m11: scale, zs: scale, ..IDENTITY };
    for e in entities {
        m.entity(e, &root, None, 0);
    }
    let layer_colors = doc
        .layers
        .iter()
        .filter_map(|l| layer_color_rgb(&l.color).map(|c| (l.name.clone(), c)))
        .collect();
    let meshes = m.meshes.into_iter().filter(|b| !b.indices.is_empty()).collect();
    // Nur Layouts mit Inhalt melden: jede Datei trägt ein leeres „Layout1" mit, das niemanden
    // interessiert (importieren lässt es sich trotzdem über seinen Namen).
    let layout_infos = layouts
        .iter()
        .map(|l| LayoutInfo {
            name: l.name.clone(),
            entities: doc.entities_in_block(&l.block).filter(|e| !matches!(e, EntityType::Viewport(_))).count() as u32,
        })
        .filter(|l| l.entities > 0)
        .collect();
    Ok(ImportData {
        kind,
        ins_units: doc.header.insertion_units,
        unit_scale: scale,
        layer_colors,
        contours: m.contours,
        texts: m.texts,
        meshes,
        entity_counts: m.counts,
        total: m.total,
        layouts: layout_infos,
        layout: layout_name,
        recovered: false,
    })
}

fn finite2(p: &Vector3) -> bool {
    p.x.is_finite() && p.y.is_finite()
}

fn fz(z: f64) -> f64 {
    if z.is_finite() {
        z
    } else {
        0.0
    }
}

/// Segmentzahl für eine Winkelspanne (Radiant): mind. 2, gedeckelt.
fn segments_for(sweep: f64) -> usize {
    let n = (sweep.abs() / CURVE_STEP).ceil();
    if !n.is_finite() {
        return CURVE_MAX_SEG;
    }
    (n as usize).clamp(2, CURVE_MAX_SEG)
}

impl<'a> Mapper<'a> {
    fn count(&mut self, name: &'static str) {
        self.total += 1;
        match self.count_index.get(name) {
            Some(&i) => self.counts[i].1 += 1,
            None => {
                self.count_index.insert(name, self.counts.len());
                self.counts.push((name.to_string(), 1));
            }
        }
    }

    fn bucket(&mut self, layer: &str) -> &mut MeshBucket {
        let key = if layer.is_empty() { "0" } else { layer };
        let i = match self.mesh_index.get(key) {
            Some(&i) => i,
            None => {
                self.mesh_index.insert(key.to_string(), self.meshes.len());
                self.meshes.push(MeshBucket { layer: key.to_string(), ..Default::default() });
                self.meshes.len() - 1
            }
        };
        &mut self.meshes[i]
    }

    fn push_contour(&mut self, layer: &str, z: f64, pts: Vec<[f64; 2]>, closed: bool, xf: &Xf) {
        if pts.len() < 2 {
            return;
        }
        let pts = if xf.is_identity() { pts } else { pts.iter().map(|p| xf.xy(p[0], p[1])).collect() };
        self.contours.push(Contour {
            layer: layer.to_string(),
            z: xf.z(z),
            pts,
            closed,
            filled: false,
            curve: None,
            bulge_verts: None,
        });
    }

    /// Polylinie mit Bulges: tesselliert wie bisher, dazu (wenn sinnvoll) die Stützpunkte mit Bulge
    /// ([`Contour::bulge_verts`]).
    fn push_bulged(&mut self, layer: &str, z: f64, verts: &[(Vector3, f64)], closed: bool, xf: &Xf) {
        let before = self.contours.len();
        self.push_contour(layer, z, bulge_points(verts, closed), closed, xf);
        if self.contours.len() == before {
            return;
        }
        if let Some(bv) = bulge_vertices(verts, xf) {
            if let Some(c) = self.contours.last_mut() {
                c.bulge_verts = Some(bv);
            }
        }
    }

    /// Eine Entity unter einer Abbildung. `inherit` = Ebene der umgebenden Referenz (Ebene „0"
    /// in Blöcken erbt sie).
    fn entity(&mut self, e: &EntityType, xf: &Xf, inherit: Option<&str>, depth: usize) {
        let ent = e.as_entity();
        if ent.common().invisible {
            return;
        }
        self.count(ent.entity_type());
        let own = ent.common().layer.as_str();
        let layer_owned: String = match inherit {
            Some(parent) if own == "0" || own.is_empty() => parent.to_string(),
            _ => if own.is_empty() { "0".to_string() } else { own.to_string() },
        };
        let layer = layer_owned.as_str();
        match e {
            EntityType::Line(l) => {
                if !finite2(&l.start) || !finite2(&l.end) {
                    return;
                }
                let pts = vec![[l.start.x, l.start.y], [l.end.x, l.end.y]];
                self.push_contour(layer, fz(l.start.z), pts, false, xf);
            }
            EntityType::LwPolyline(p) => self.lwpolyline(p, layer, xf),
            EntityType::Polyline2D(p) => {
                let verts: Vec<(Vector3, f64)> = p
                    .vertices
                    .iter()
                    .filter(|v| v.flags.bits() & 16 == 0) // Spline-Rahmen weglassen
                    .map(|v| (v.location, v.bulge))
                    .collect();
                let z = match verts.iter().find(|(v, _)| finite2(v)) {
                    Some((v, _)) if v.z != 0.0 && v.z.is_finite() => v.z,
                    _ => fz(p.elevation),
                };
                let closed = p.flags.is_closed();
                self.push_bulged(layer, z, &verts, closed, xf);
            }
            EntityType::Polyline3D(p) => {
                let verts: Vec<(Vector3, f64)> =
                    p.vertices.iter().filter(|v| v.flags & 16 == 0).map(|v| (v.position, 0.0)).collect();
                let z = verts.iter().find(|(v, _)| finite2(v)).map(|(v, _)| fz(v.z)).unwrap_or(fz(p.elevation));
                let pts = bulge_points(&verts, false);
                self.push_contour(layer, z, pts, p.flags.closed, xf);
            }
            EntityType::Polyline(p) => {
                let verts: Vec<(Vector3, f64)> = p
                    .vertices
                    .iter()
                    .filter(|v| v.flags.bits() & 16 == 0)
                    .map(|v| (v.location, 0.0))
                    .collect();
                let z = verts.iter().find(|(v, _)| finite2(v)).map(|(v, _)| fz(v.z)).unwrap_or(0.0);
                let pts = bulge_points(&verts, false);
                self.push_contour(layer, z, pts, p.flags.is_closed(), xf);
            }
            EntityType::Arc(a) => self.arc(a.center, a.radius, a.start_angle, a.end_angle, layer, xf),
            EntityType::Circle(c) => self.circle(c.center, c.radius, layer, xf),
            EntityType::Ellipse(el) => self.ellipse(el, layer, xf),
            EntityType::Spline(s) => self.spline(s, layer, xf),
            EntityType::Hatch(h) => self.hatch(h, layer, xf),
            EntityType::Text(t) => self.text_entity(t, layer, xf),
            EntityType::MText(t) => {
                let h = if t.height > 0.0 && t.height.is_finite() { t.height } else { DEFAULT_TEXT_HEIGHT };
                let rot = if t.rotation.is_finite() { t.rotation } else { 0.0 };
                let attach = mtext_attach(t.attachment_point);
                self.mtext_block(&t.value, t.insertion_point, h, rot, attach, t.line_spacing_factor, layer, xf);
            }
            EntityType::Face3D(f) => {
                let mut cs = vec![f.first_corner, f.second_corner, f.third_corner];
                if f.fourth_corner != f.third_corner {
                    cs.push(f.fourth_corner);
                }
                let cs: Vec<Vector3> = cs.into_iter().filter(finite2).collect();
                if cs.len() < 3 {
                    return;
                }
                let b = self.bucket(layer);
                let idx: Vec<u32> = cs.iter().map(|c| push_vertex(b, xf, c)).collect();
                push_tri(b, idx[0], idx[1], idx[2]);
                if idx.len() >= 4 {
                    push_tri(b, idx[0], idx[2], idx[3]);
                }
            }
            EntityType::PolyfaceMesh(p) => self.polyface(p, layer, xf),
            EntityType::PolygonMesh(p) => self.polygon_mesh(p, layer, xf),
            EntityType::Mesh(mesh) => self.mesh(mesh, layer, xf),
            EntityType::Insert(ins) => self.insert(ins, layer, xf, depth),
            EntityType::Solid(sol) => self.solid(sol, layer, xf),
            EntityType::Dimension(dim) => self.dimension(dim, layer, xf, depth),
            EntityType::Leader(l) => self.leader(l, layer, xf),
            EntityType::MultiLeader(ml) => self.multileader(ml, layer, xf, depth),
            EntityType::AttributeEntity(a) => self.attrib(a, layer, xf),
            EntityType::AttributeDefinition(a) => self.attdef(a, layer, xf, depth),
            _ => {}
        }
    }

    fn lwpolyline(&mut self, p: &LwPolyline, layer: &str, xf: &Xf) {
        let verts: Vec<(Vector3, f64)> = p
            .vertices
            .iter()
            .map(|v| (Vector3::new(v.location.x, v.location.y, 0.0), v.bulge))
            .collect();
        self.push_bulged(layer, fz(p.elevation), &verts, p.is_closed, xf);
    }

    fn arc(&mut self, c: Vector3, r: f64, start: f64, end: f64, layer: &str, xf: &Xf) {
        if !finite2(&c) || !r.is_finite() || r <= 0.0 {
            return;
        }
        let start = if start.is_finite() { start } else { 0.0 };
        let end = if end.is_finite() { end } else { TAU };
        let mut sweep = end - start;
        if sweep <= 0.0 {
            sweep += TAU;
        }
        let segs = segments_for(sweep);
        let pts: Vec<[f64; 2]> = (0..=segs)
            .map(|i| {
                let t = start + (sweep * i as f64) / segs as f64;
                [c.x + r * t.cos(), c.y + r * t.sin()]
            })
            .collect();
        let curve = Curve { circle: false, cx: c.x, cy: c.y, r, a0: start, a1: start + sweep };
        self.push_curve(layer, fz(c.z), pts, false, curve, xf);
    }

    fn circle(&mut self, c: Vector3, r: f64, layer: &str, xf: &Xf) {
        if !finite2(&c) || !r.is_finite() || r <= 0.0 {
            return;
        }
        let segs = segments_for(TAU);
        let pts: Vec<[f64; 2]> = (0..segs)
            .map(|i| {
                let t = (TAU * i as f64) / segs as f64;
                [c.x + r * t.cos(), c.y + r * t.sin()]
            })
            .collect();
        let curve = Curve { circle: true, cx: c.x, cy: c.y, r, a0: 0.0, a1: TAU };
        self.push_curve(layer, fz(c.z), pts, true, curve, xf);
    }

    /// Kontur mit wahrer Kurve; unter einer Nicht-Ähnlichkeitsabbildung (Zerrung, Spiegelung)
    /// bleibt nur der Linienzug.
    fn push_curve(&mut self, layer: &str, z: f64, pts: Vec<[f64; 2]>, closed: bool, curve: Curve, xf: &Xf) {
        let curve = if xf.is_identity() {
            Some(curve)
        } else {
            xf.similarity().map(|(s, rot)| {
                let [cx, cy] = xf.xy(curve.cx, curve.cy);
                Curve { cx, cy, r: curve.r * s, a0: curve.a0 + rot, a1: curve.a1 + rot, ..curve }
            })
        };
        let before = self.contours.len();
        self.push_contour(layer, z, pts, closed, xf);
        if self.contours.len() > before {
            if let Some(c) = self.contours.last_mut() {
                c.curve = curve;
            }
        }
    }

    fn ellipse(&mut self, el: &Ellipse, layer: &str, xf: &Xf) {
        let c = el.center;
        let maj = el.major_axis;
        let ratio = el.minor_axis_ratio;
        if !finite2(&c) || !finite2(&maj) || !ratio.is_finite() {
            return;
        }
        let pts_and_full = ellipse_points(c.x, c.y, maj.x, maj.y, ratio, el.start_parameter, el.end_parameter);
        let (pts, full) = pts_and_full;
        self.push_contour(layer, fz(c.z), pts, full, xf);
    }

    fn spline(&mut self, s: &Spline, layer: &str, xf: &Xf) {
        let cps: Vec<[f64; 2]> = s.control_points.iter().filter(|p| finite2(p)).map(|p| [p.x, p.y]).collect();
        let fps: Vec<[f64; 2]> = s.fit_points.iter().filter(|p| finite2(p)).map(|p| [p.x, p.y]).collect();
        let knots: Vec<f64> = s.knots.iter().copied().filter(|k| k.is_finite()).collect();
        let closed = s.flags.closed;
        let first_z = |vs: &[Vector3]| vs.iter().find(|v| v.z.is_finite()).map(|v| v.z).unwrap_or(0.0);
        let z = if !cps.is_empty() { first_z(&s.control_points) } else { first_z(&s.fit_points) };
        let pts = if let Some(p) = sample_bspline(&cps, &knots, s.degree as i64) {
            p
        } else if let Some(p) = sample_periodic(&cps, &knots, s.degree as i64) {
            p
        } else if fps.len() >= 2 {
            fps
        } else if cps.len() >= 2 {
            cps
        } else {
            return;
        };
        self.push_contour(layer, z, pts, closed, xf);
    }

    fn hatch(&mut self, h: &Hatch, layer: &str, xf: &Xf) {
        let z = fz(h.elevation);
        for path in &h.paths {
            let pts = hatch_loop(path);
            if pts.len() < 2 {
                continue;
            }
            let before = self.contours.len();
            self.push_contour(layer, z, pts, true, xf);
            if self.contours.len() > before {
                // Rand aus genau einer Polylinie mit Bögen: Stützpunkte mit Bulge behalten.
                let bv = match path.edges.as_slice() {
                    [BoundaryEdge::Polyline(pl)] => {
                        let verts: Vec<(Vector3, f64)> =
                            pl.vertices.iter().map(|v| (Vector3::new(v.x, v.y, 0.0), v.z)).collect();
                        bulge_vertices(&verts, xf)
                    }
                    _ => None,
                };
                if let Some(c) = self.contours.last_mut() {
                    c.filled = true;
                    c.bulge_verts = bv;
                }
            }
        }
    }

    fn text(&mut self, raw: &str, at: Vector3, height: f64, angle: f64, layer: &str, xf: &Xf) {
        if raw.is_empty() || !finite2(&at) {
            return;
        }
        let [x, y] = xf.xy(at.x, at.y);
        let angle = if angle.is_finite() { angle } else { 0.0 };
        let (height, angle) = if xf.is_identity() {
            (height, angle)
        } else {
            (height * xf.scale(), angle + xf.m10.atan2(xf.m00))
        };
        self.texts.push(Text { layer: layer.to_string(), x, y, height, angle, text: raw.to_string() });
    }

    fn polyface(&mut self, p: &PolyfaceMesh, layer: &str, xf: &Xf) {
        if p.vertices.len() < 3 {
            return;
        }
        let b = self.bucket(layer);
        let base = (b.positions.len() / 3) as i64;
        for v in &p.vertices {
            push_vertex(b, xf, &v.location);
        }
        let n = p.vertices.len() as i64;
        for f in &p.faces {
            let ring: Vec<u32> = [f.index1, f.index2, f.index3, f.index4]
                .iter()
                .map(|i| i64::from(*i).abs())
                .filter(|i| *i >= 1 && *i <= n)
                .map(|i| (base + i - 1) as u32)
                .collect();
            fan(b, &ring);
        }
    }

    fn polygon_mesh(&mut self, p: &PolygonMesh, layer: &str, xf: &Xf) {
        let m = p.m_vertex_count.max(0) as usize;
        let n = p.n_vertex_count.max(0) as usize;
        if m < 2 || n < 2 || p.vertices.len() < m * n {
            return;
        }
        let b = self.bucket(layer);
        let base = (b.positions.len() / 3) as u32;
        for v in p.vertices.iter().take(m * n) {
            push_vertex(b, xf, &v.location);
        }
        let closed_m = p.is_closed_m();
        let closed_n = p.is_closed_n();
        let rows = if closed_m { m } else { m - 1 };
        let cols = if closed_n { n } else { n - 1 };
        let id = |i: usize, j: usize| base + ((i % m) * n + (j % n)) as u32;
        for i in 0..rows {
            for j in 0..cols {
                fan(b, &[id(i, j), id(i, j + 1), id(i + 1, j + 1), id(i + 1, j)]);
            }
        }
    }

    fn mesh(&mut self, mesh: &Mesh, layer: &str, xf: &Xf) {
        if mesh.vertices.is_empty() {
            return;
        }
        let b = self.bucket(layer);
        let base = (b.positions.len() / 3) as u32;
        for v in &mesh.vertices {
            push_vertex(b, xf, v);
        }
        let n = mesh.vertices.len();
        for f in &mesh.faces {
            if f.vertices.iter().any(|&i| i >= n) {
                continue;
            }
            let ring: Vec<u32> = f.vertices.iter().map(|&i| base + i as u32).collect();
            fan(b, &ring);
        }
    }

    /// SOLID/TRACE: gefülltes 3-/4-Eck. DXF speichert die Ecken als 1, 2, 4, 3 (Schleife ohne
    /// Überkreuzung: erste, zweite, vierte, dritte); fallen dritte und vierte Ecke zusammen, ist es
    /// ein Dreieck.
    fn solid(&mut self, s: &Solid, layer: &str, xf: &Xf) {
        let mut cs = vec![s.first_corner, s.second_corner];
        if s.fourth_corner != s.third_corner {
            cs.push(s.fourth_corner);
        }
        cs.push(s.third_corner);
        if !cs.iter().all(finite2) {
            return;
        }
        let pts: Vec<[f64; 2]> = cs.iter().map(|c| [c.x, c.y]).collect();
        self.push_filled(layer, fz(s.first_corner.z), pts, xf);
    }

    /// Gefüllte, geschlossene Kontur (SOLID/TRACE; wie ein HATCH-Rand).
    fn push_filled(&mut self, layer: &str, z: f64, pts: Vec<[f64; 2]>, xf: &Xf) {
        let before = self.contours.len();
        self.push_contour(layer, z, pts, true, xf);
        if self.contours.len() > before {
            if let Some(c) = self.contours.last_mut() {
                c.filled = true;
            }
        }
    }

    /// Einzeiliger Text: Ausrichtung (72/73 mit Ausrichtpunkt), Breitenfaktor, `%%`-Codes.
    fn text_entity(&mut self, t: &AText, layer: &str, xf: &Xf) {
        let value = txt::decode_percent_codes(&t.value);
        if value.is_empty() || !finite2(&t.insertion_point) {
            return;
        }
        let h = if t.height > 0.0 && t.height.is_finite() { t.height } else { DEFAULT_TEXT_HEIGHT };
        let hz = match t.horizontal_alignment {
            TextHorizontalAlignment::Left => Hz::Left,
            TextHorizontalAlignment::Center => Hz::Center,
            TextHorizontalAlignment::Right => Hz::Right,
            TextHorizontalAlignment::Aligned => Hz::Aligned,
            TextHorizontalAlignment::Middle => Hz::Middle,
            TextHorizontalAlignment::Fit => Hz::Fit,
        };
        let vt = match t.vertical_alignment {
            TextVerticalAlignment::Baseline => VAlign::Baseline,
            TextVerticalAlignment::Bottom => VAlign::Bottom,
            TextVerticalAlignment::Middle => VAlign::Middle,
            TextVerticalAlignment::Top => VAlign::Top,
        };
        let align = t.alignment_point.filter(finite2).map(|a| [a.x, a.y]);
        let rot = if t.rotation.is_finite() { t.rotation } else { 0.0 };
        let ins = t.insertion_point;
        let (pos, height, angle) = txt::place_single(&value, [ins.x, ins.y], align, hz, vt, h, t.width_factor, rot);
        self.text(&value, Vector3::new(pos[0], pos[1], ins.z), height, angle, layer, xf);
    }

    /// MTEXT: Formatcodes aufgelöst, Anhängepunkt und Drehung angewendet; je Zeile ein Text (die
    /// Zeilen stehen mit Standard-Zeilenabstand untereinander, ohne Umbruch an der Spaltenbreite).
    #[allow(clippy::too_many_arguments)]
    fn mtext_block(
        &mut self,
        raw: &str,
        at: Vector3,
        height: f64,
        rot: f64,
        attach: (HAlign, VAlign),
        spacing: f64,
        layer: &str,
        xf: &Xf,
    ) {
        if !finite2(&at) {
            return;
        }
        let lines = txt::mtext_lines(raw);
        if lines.is_empty() {
            return;
        }
        let placed = txt::layout_block([at.x, at.y], attach.0, attach.1, &lines, height, 1.0, rot, spacing);
        for (pos, line) in placed {
            if !line.is_empty() {
                self.text(&line, Vector3::new(pos[0], pos[1], at.z), height, rot, layer, xf);
            }
        }
    }

    /// Geometrie aus [`crate::annotation`] (Weltkoordinaten) unter der Abbildung `xf` ausgeben.
    fn emit_shapes(&mut self, shapes: Vec<Shape>, z: f64, layer: &str, xf: &Xf) {
        for s in shapes {
            match s {
                Shape::Poly { pts, closed, filled } => {
                    if filled {
                        self.push_filled(layer, z, pts, xf);
                    } else {
                        self.push_contour(layer, z, pts, closed, xf);
                    }
                }
                Shape::Text { at, height, angle, text } => {
                    self.text(&text, Vector3::new(at[0], at[1], z), height, angle, layer, xf);
                }
            }
        }
    }

    /// Bemassungsstil `name` (sonst „Standard") als Zahlen für [`crate::annotation`].
    fn dim_style_vals(&mut self, name: &str) -> DimStyleVals {
        let key = name.to_ascii_uppercase();
        if let Some(v) = self.dim_styles.get(&key) {
            return v.clone();
        }
        let doc = self.doc;
        let arrow = |n: &str, h: Handle| -> ArrowKind {
            if !n.is_empty() {
                ann::arrow_kind(n)
            } else {
                ann::arrow_kind(block_name_of(doc, h).unwrap_or(""))
            }
        };
        let v = match doc.dim_styles.get(name).or_else(|| doc.dim_styles.get("Standard")) {
            None => DimStyleVals::default(),
            Some(d) => {
                let (a1, a2) = if d.dimsah {
                    (arrow(&d.dimblk1_name, d.dimblk1), arrow(&d.dimblk2_name, d.dimblk2))
                } else {
                    let a = arrow(&d.dimblk_name, d.dimblk);
                    (a, a)
                };
                let leader_arrow = match block_name_of(doc, d.dimldrblk) {
                    Some(n) => ann::arrow_kind(n),
                    None => a1,
                };
                DimStyleVals {
                    asz: d.dimasz,
                    tsz: d.dimtsz,
                    txt: d.dimtxt,
                    gap: d.dimgap,
                    exo: d.dimexo,
                    exe: d.dimexe,
                    scale: d.dimscale,
                    dec: d.dimdec,
                    adec: d.dimadec,
                    zin: d.dimzin,
                    dsep: d.dimdsep,
                    post: d.dimpost.clone(),
                    lfac: d.dimlfac,
                    rnd: d.dimrnd,
                    tad: d.dimtad,
                    cen: d.dimcen,
                    arrow1: a1,
                    arrow2: a2,
                    leader_arrow,
                    se1: d.dimse1,
                    se2: d.dimse2,
                    sd1: d.dimsd1,
                    sd2: d.dimsd2,
                }
            }
        };
        self.dim_styles.insert(key, v.clone());
        v
    }

    /// DIMENSION: Steht die Zeichnung im Anonymblock (`*D…`, Gruppencode 2), wird er wie ein INSERT
    /// ohne Verschiebung aufgelöst (Pfeile, Linien und Text stehen dort fertig in Weltkoordinaten).
    /// Fehlt der Block (Dateien aus Skripten, LibreCAD, DWG ohne Block), baut [`Self::synth_dimension`]
    /// die Bemassung aus Definitionspunkten und Stil; Arten ohne Aufbau behalten den Massstext.
    fn dimension(&mut self, d: &Dimension, layer: &str, xf: &Xf, depth: usize) {
        if depth >= MAX_INSERT_DEPTH {
            return;
        }
        let base = d.base();
        let doc = self.doc;
        let entities: Vec<&EntityType> = doc
            .block_records
            .get(&base.block_name)
            .map(|b| b.entity_handles.iter().filter_map(|h| doc.get_entity(*h)).collect())
            .unwrap_or_default();
        if !entities.is_empty() {
            for e in entities {
                self.entity(e, xf, Some(layer), depth + 1);
            }
            return;
        }
        if let Some((shapes, z)) = self.synth_dimension(d) {
            self.emit_shapes(shapes, z, layer, xf);
            return;
        }
        // Rückfall: nur der Text (Benutzertext, sonst gemessener Wert); `<>` = Messwert.
        let measure = format_measure(base.actual_measurement);
        let value = match &base.user_text {
            Some(t) if !t.is_empty() => t.replace("<>", &measure),
            _ => measure,
        };
        self.text(&value, base.text_middle_point, DEFAULT_TEXT_HEIGHT, base.text_rotation, layer, xf);
    }

    /// Bemassung aus Definitionspunkten und Stil (lineare, ausgerichtete, Radius-, Durchmesser-,
    /// Winkelbemassung). `None` für Koordinaten-, Bogenlängen- und Radius-mit-Knick-Bemassungen
    /// sowie bei unbrauchbaren Punkten.
    fn synth_dimension(&mut self, d: &Dimension) -> Option<(Vec<Shape>, f64)> {
        let base = d.base();
        let st = self.dim_style_vals(&base.style_name);
        let xy = |p: Vector3| [p.x, p.y];
        // Textmitte der Datei; (0, 0) heisst „nicht gesetzt" (Skript-Dateien ohne Rendering).
        let tm = base.text_middle_point;
        let text_mid = (finite2(&tm) && (tm.x != 0.0 || tm.y != 0.0)).then(|| xy(tm));
        let user = base.user_text.as_deref();
        let shapes = match d {
            Dimension::Linear(l) => {
                let lin = ann::LinearDim {
                    p1: xy(l.first_point),
                    p2: xy(l.second_point),
                    def: xy(l.definition_point),
                    angle: l.rotation,
                    text_mid,
                    user_text: user,
                    text_rotation: base.text_rotation,
                };
                (ann::linear_dimension(&lin, &st), l.first_point.z)
            }
            Dimension::Aligned(a) => {
                let (p1, p2) = (xy(a.first_point), xy(a.second_point));
                let lin = ann::LinearDim {
                    p1,
                    p2,
                    def: xy(a.definition_point),
                    angle: (p2[1] - p1[1]).atan2(p2[0] - p1[0]),
                    text_mid,
                    user_text: user,
                    text_rotation: base.text_rotation,
                };
                (ann::linear_dimension(&lin, &st), a.first_point.z)
            }
            // acadrust: `angle_vertex` = Mittelpunkt, `definition_point` = Punkt auf dem Kreis.
            Dimension::Radius(r) => {
                (ann::radial_dimension(xy(r.angle_vertex), xy(r.definition_point), false, text_mid, user, &st), r.definition_point.z)
            }
            Dimension::Diameter(dm) => {
                let c = dm.center();
                (ann::radial_dimension(xy(c), xy(dm.definition_point), true, text_mid, user, &st), dm.definition_point.z)
            }
            Dimension::Angular3Pt(a) => (
                ann::angular_3pt(xy(a.angle_vertex), xy(a.first_point), xy(a.second_point), xy(a.definition_point), text_mid, user, &st),
                a.angle_vertex.z,
            ),
            Dimension::Angular2Ln(a) => (
                ann::angular_2line(
                    (xy(a.first_point), xy(a.second_point)),
                    (xy(a.angle_vertex), xy(a.definition_point)),
                    xy(a.dimension_arc),
                    text_mid,
                    user,
                    &st,
                ),
                a.first_point.z,
            ),
            _ => return None,
        };
        if shapes.0.is_empty() {
            return None;
        }
        Some((shapes.0, fz(shapes.1)))
    }

    /// LEADER: Führungslinie als Linienzug (Spline-Pfad tesselliert) mit Pfeilspitze am ersten
    /// Punkt (Pfeilart `DIMLDRBLK` des Stils, Grösse `DIMASZ·DIMSCALE`).
    fn leader(&mut self, l: &Leader, layer: &str, xf: &Xf) {
        let mut pts: Vec<[f64; 2]> = l.vertices.iter().filter(|v| finite2(v)).map(|v| [v.x, v.y]).collect();
        let z = l.vertices.iter().find(|v| v.z.is_finite()).map(|v| v.z).unwrap_or(0.0);
        if l.path_type == acadrust::entities::LeaderPathType::Spline {
            pts = ann::spline_through(&pts);
        }
        if l.arrow_enabled && pts.len() >= 2 {
            let st = self.dim_style_vals(&l.dimension_style);
            let size = if l.arrow_size > 0.0 && l.arrow_size.is_finite() { l.arrow_size } else { st.arrow_size() };
            let dir = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
            let shapes = ann::arrow(st.leader_arrow, pts[0], dir, size);
            self.emit_shapes(shapes, z, layer, xf);
        }
        self.push_contour(layer, z, pts, false, xf);
    }

    /// MULTILEADER: je Führungslinie ein Linienzug (zur Anschlussstelle hin geordnet, mit
    /// Landestrecke; Spline-Pfad tesselliert) samt Pfeilspitze, dazu der Inhalt: Text (mit
    /// Anhängepunkt und Drehung) oder Block (mit Skalierung, Drehung und Attributtexten).
    fn multileader(&mut self, ml: &MultiLeader, layer: &str, xf: &Xf, depth: usize) {
        let ctx = &ml.context;
        let invisible = ml.path_type == MultiLeaderPathType::Invisible;
        let scale = if ctx.scale_factor.is_finite() && ctx.scale_factor > 0.0 { ctx.scale_factor } else { 1.0 };
        let positive = |v: f64| v.is_finite() && v > 0.0;
        for root in &ctx.leader_roots {
            let cp = root.connection_point;
            let landing = if ml.enable_landing && root.landing_distance.is_finite() && root.landing_distance != 0.0 {
                let d = root.direction;
                let len = (d.x * d.x + d.y * d.y).sqrt();
                (len > 1e-12 && finite2(&cp))
                    .then(|| [cp.x + d.x / len * root.landing_distance, cp.y + d.y / len * root.landing_distance])
            } else {
                None
            };
            for line in &root.lines {
                let mut pts: Vec<[f64; 2]> = line.points.iter().filter(|p| finite2(p)).map(|p| [p.x, p.y]).collect();
                if pts.is_empty() {
                    continue;
                }
                if finite2(&cp) {
                    let d2 = |p: &[f64; 2]| (p[0] - cp.x).powi(2) + (p[1] - cp.y).powi(2);
                    if d2(&pts[0]) < d2(&pts[pts.len() - 1]) {
                        pts.reverse(); // letzter Punkt = Anschlussstelle
                    }
                    if d2(&pts[pts.len() - 1]) > 1e-18 {
                        pts.push([cp.x, cp.y]);
                    }
                }
                let spline = line.path_type == MultiLeaderPathType::Spline
                    || (line.path_type == MultiLeaderPathType::StraightLineSegments && ml.path_type == MultiLeaderPathType::Spline);
                if spline {
                    pts = ann::spline_through(&pts);
                }
                if finite2(&cp) {
                    if let Some(l) = landing {
                        pts.push(l);
                    }
                }
                let z = line.points.iter().find(|p| p.z.is_finite()).map(|p| p.z).unwrap_or(0.0);
                if invisible {
                    continue;
                }
                // Pfeilspitze am freien Ende (erster Punkt).
                if pts.len() >= 2 {
                    let kind = match line.arrowhead_handle.or(ml.arrowhead_handle) {
                        Some(h) => match block_name_of(self.doc, h) {
                            Some(n) => ann::arrow_kind(n),
                            None => ArrowKind::ClosedFilled,
                        },
                        None => ArrowKind::ClosedFilled,
                    };
                    let size = [ctx.arrowhead_size, line.arrowhead_size * scale, ml.arrowhead_size * scale]
                        .into_iter()
                        .find(|v| positive(*v))
                        .unwrap_or_else(|| DimStyleVals::default().asz);
                    let dir = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
                    let shapes = ann::arrow(kind, pts[0], dir, size);
                    self.emit_shapes(shapes, z, layer, xf);
                }
                self.push_contour(layer, z, pts, false, xf);
            }
        }
        if ctx.has_text_contents && ml.content_type != LeaderContentType::Block && !ctx.text_string.trim().is_empty() {
            let h = [ctx.text_height, ml.text_height]
                .into_iter()
                .find(|h| *h > 0.0 && h.is_finite())
                .unwrap_or(DEFAULT_TEXT_HEIGHT);
            let rot = if ctx.text_rotation.is_finite() && ctx.text_rotation != 0.0 {
                ctx.text_rotation
            } else {
                let d = ctx.text_direction;
                if finite2(&d) && d.x.hypot(d.y) > 1e-12 { d.y.atan2(d.x) } else { 0.0 }
            };
            let ha = match ctx.text_attachment_point {
                TextAttachmentPointType::Left => HAlign::Left,
                TextAttachmentPointType::Center => HAlign::Center,
                TextAttachmentPointType::Right => HAlign::Right,
            };
            self.mtext_block(&ctx.text_string, ctx.text_location, h, rot, (ha, VAlign::Top), ctx.line_spacing_factor, layer, xf);
        }
        if ctx.has_block_contents || ml.content_type == LeaderContentType::Block {
            self.multileader_block(ml, layer, xf, depth);
        }
    }

    /// Block-Inhalt eines MULTILEADER: an `block_content_location`, mit Block-Skalierung und -Drehung.
    /// Anschluss „Block-Umfang" = Mittelpunkt des Umfangs liegt auf dem Punkt (statt des Basispunkts).
    fn multileader_block(&mut self, ml: &MultiLeader, layer: &str, xf: &Xf, depth: usize) {
        if depth >= MAX_INSERT_DEPTH {
            return;
        }
        let ctx = &ml.context;
        let doc = self.doc;
        let Some(h) = ctx.block_content_handle.or(ml.block_content_handle) else { return };
        let Some(block) = doc.block_records.iter().find(|b| b.handle == h) else { return };
        if block.entity_handles.is_empty() {
            return;
        }
        let loc = ctx.block_content_location;
        if !finite2(&loc) {
            return;
        }
        let num = |v: f64, d: f64| if v.is_finite() && v != 0.0 { v } else { d };
        let sc = ctx.block_content_scale;
        let scale = [num(sc.x, 1.0), num(sc.y, 1.0), num(sc.z, 1.0)];
        let rot = if ctx.block_rotation.is_finite() { ctx.block_rotation } else { 0.0 };
        // Attributtexte: ATTDEF-Tag → Text der Referenz.
        let mut values: HashMap<String, String> = HashMap::new();
        for a in &ml.block_attributes {
            let Some(def) = a.attribute_definition_handle.and_then(|h| doc.get_entity(h)) else { continue };
            if let EntityType::AttributeDefinition(ad) = def {
                values.insert(ad.tag.to_ascii_uppercase(), a.text.clone());
            }
        }
        let (c0, t0) = (self.contours.len(), self.texts.len());
        self.ml_attrs.push(values);
        self.place_block(block, loc, scale, rot, (1, 1, 0.0, 0.0), std::collections::HashSet::new(), layer, xf, depth);
        self.ml_attrs.pop();
        let connection = if ctx.block_connection_type == BlockContentConnectionType::BlockExtents {
            ml.block_connection_type
        } else {
            ctx.block_connection_type
        };
        if connection == BlockContentConnectionType::BlockExtents {
            // Umfang der neuen Geometrie in Ausgabekoordinaten → Mittelpunkt auf den Zielpunkt schieben.
            let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
            for c in &self.contours[c0..] {
                for p in &c.pts {
                    lo = [lo[0].min(p[0]), lo[1].min(p[1])];
                    hi = [hi[0].max(p[0]), hi[1].max(p[1])];
                }
            }
            for t in &self.texts[t0..] {
                lo = [lo[0].min(t.x), lo[1].min(t.y)];
                hi = [hi[0].max(t.x), hi[1].max(t.y)];
            }
            if lo[0] <= hi[0] {
                let target = xf.xy(loc.x, loc.y);
                let (dx, dy) = (target[0] - (lo[0] + hi[0]) / 2.0, target[1] - (lo[1] + hi[1]) / 2.0);
                for c in &mut self.contours[c0..] {
                    for p in &mut c.pts {
                        p[0] += dx;
                        p[1] += dy;
                    }
                    if let Some(cv) = c.curve.as_mut() {
                        cv.cx += dx;
                        cv.cy += dy;
                    }
                }
                for t in &mut self.texts[t0..] {
                    t.x += dx;
                    t.y += dy;
                }
            }
        }
    }

    /// ATTRIB (Wert eines Block-Attributs, steht in Weltkoordinaten): als Text mit Ausrichtung,
    /// Breitenfaktor und Drehung; mehrzeilige (MTEXT-)Attribute je Zeile; unsichtbare entfallen.
    fn attrib(&mut self, a: &AttributeEntity, layer: &str, xf: &Xf) {
        if a.flags.invisible || a.value.is_empty() {
            return;
        }
        let h = if a.height > 0.0 && a.height.is_finite() { a.height } else { DEFAULT_TEXT_HEIGHT };
        if let Some(m) = a.embedded_mtext.as_deref().filter(|_| a.is_multiline) {
            let mh = if m.height > 0.0 && m.height.is_finite() { m.height } else { h };
            let rot = if m.rotation.is_finite() { m.rotation } else { 0.0 };
            self.mtext_block(&m.value, m.insertion_point, mh, rot, mtext_attach(m.attachment_point), m.line_spacing_factor, layer, xf);
            return;
        }
        self.aligned_text(
            &a.value,
            a.insertion_point,
            a.alignment_point,
            a.horizontal_alignment,
            a.vertical_alignment,
            h,
            a.width_factor,
            a.rotation,
            layer,
            xf,
        );
    }

    /// Einzeiliger Text eines ATTRIB/ATTDEF mit Ausrichtung.
    #[allow(clippy::too_many_arguments)]
    fn aligned_text(
        &mut self,
        raw: &str,
        ins: Vector3,
        align: Vector3,
        ha: HorizontalAlignment,
        va: VerticalAlignment,
        height: f64,
        wf: f64,
        rot: f64,
        layer: &str,
        xf: &Xf,
    ) {
        let value = txt::decode_percent_codes(raw);
        if value.is_empty() || !finite2(&ins) {
            return;
        }
        let hz = match ha {
            HorizontalAlignment::Left => Hz::Left,
            HorizontalAlignment::Center => Hz::Center,
            HorizontalAlignment::Right => Hz::Right,
            HorizontalAlignment::Aligned => Hz::Aligned,
            HorizontalAlignment::Middle => Hz::Middle,
            HorizontalAlignment::Fit => Hz::Fit,
        };
        let vt = match va {
            VerticalAlignment::Baseline => VAlign::Baseline,
            VerticalAlignment::Bottom => VAlign::Bottom,
            VerticalAlignment::Middle => VAlign::Middle,
            VerticalAlignment::Top => VAlign::Top,
        };
        let align = finite2(&align).then(|| [align.x, align.y]);
        let rot = if rot.is_finite() { rot } else { 0.0 };
        let (pos, height, angle) = txt::place_single(&value, [ins.x, ins.y], align, hz, vt, height, wf, rot);
        self.text(&value, Vector3::new(pos[0], pos[1], ins.z), height, angle, layer, xf);
    }

    /// ATTDEF: in einem Block zeigt AutoCAD den Vorgabewert nur, wenn die Referenz kein passendes
    /// ATTRIB trägt (oder das Attribut konstant ist); ausserhalb eines Blocks gilt Wert bzw. Tag.
    /// Bei MULTILEADER-Blöcken ersetzt der Text des Attributs den Vorgabewert.
    fn attdef(&mut self, a: &AttributeDefinition, layer: &str, xf: &Xf, depth: usize) {
        if a.flags.invisible {
            return;
        }
        let tag = a.tag.to_ascii_uppercase();
        let ml_value = if depth > 0 { self.ml_attrs.last().and_then(|m| m.get(&tag)).cloned() } else { None };
        let covered = ml_value.is_none()
            && depth > 0
            && !a.flags.constant
            && self.insert_tags.last().is_some_and(|tags| tags.contains(&tag));
        if covered {
            return;
        }
        let value = match &ml_value {
            Some(v) => v.as_str(),
            None if a.default_value.is_empty() => a.tag.as_str(),
            None => a.default_value.as_str(),
        };
        if value.is_empty() {
            return;
        }
        let h = if a.height > 0.0 && a.height.is_finite() { a.height } else { DEFAULT_TEXT_HEIGHT };
        self.aligned_text(
            value,
            a.insertion_point,
            a.alignment_point,
            a.horizontal_alignment,
            a.vertical_alignment,
            h,
            a.width_factor,
            a.rotation,
            layer,
            xf,
        );
    }

    /// INSERT: Block-Inhalt je Rasterzelle mit `Welt = P + R(θ)·(S·(p − Basis) + Versatz)`.
    fn insert(&mut self, ins: &Insert, layer: &str, xf: &Xf, depth: usize) {
        if depth >= MAX_INSERT_DEPTH {
            return;
        }
        let doc = self.doc;
        let Some(block) = doc.block_records.get(&ins.block_name) else {
            return;
        };
        if block.entity_handles.is_empty() {
            return;
        }
        let num = |v: f64, d: f64| if v.is_finite() { v } else { d };
        let scale = [num(ins.x_scale(), 1.0), num(ins.y_scale(), 1.0), num(ins.z_scale(), 1.0)];
        let rot = num(ins.rotation, 0.0);
        let ip = ins.insert_point;
        if !finite2(&ip) {
            return;
        }
        let nc = usize::from(ins.column_count.max(1));
        let nr = usize::from(ins.row_count.max(1));
        let (nc, nr) = if nc * nr > MAX_ARRAY_CELLS { (1, 1) } else { (nc, nr) };
        let grid = (nc, nr, num(ins.column_spacing, 0.0), num(ins.row_spacing, 0.0));
        let tags = ins.attributes.iter().map(|a| a.tag.to_ascii_uppercase()).collect();
        self.place_block(block, ip, scale, rot, grid, tags, layer, xf, depth);
        // ATTRIBs der Referenz stehen schon in Weltkoordinaten (nicht unter der Block-Abbildung).
        for a in &ins.attributes {
            self.count("ATTRIB");
            let own = a.common.layer.as_str();
            let attr_layer = if own == "0" || own.is_empty() { layer } else { own };
            self.attrib(a, attr_layer, xf);
        }
    }

    /// Block-Inhalt platziert: Einfügepunkt `ip`, Skalierung, Drehung, Raster
    /// `(Spalten, Zeilen, Spaltenabstand, Zeilenabstand)`; `tags` = ATTRIB-Tags der Referenz.
    #[allow(clippy::too_many_arguments)]
    fn place_block(
        &mut self,
        block: &acadrust::tables::BlockRecord,
        ip: Vector3,
        scale: [f64; 3],
        rot: f64,
        grid: (usize, usize, f64, f64),
        tags: std::collections::HashSet<String>,
        layer: &str,
        xf: &Xf,
        depth: usize,
    ) {
        let doc = self.doc;
        let num = |v: f64, d: f64| if v.is_finite() { v } else { d };
        let [sx, sy, sz] = scale;
        let (sin, cos) = rot.sin_cos();
        let bp = block.base_point;
        let (bx, by, bz) = (num(bp.x, 0.0), num(bp.y, 0.0), num(bp.z, 0.0));
        let (nc, nr, dc, dr) = grid;
        let entities: Vec<&EntityType> = block.entity_handles.iter().filter_map(|h| doc.get_entity(*h)).collect();
        self.insert_tags.push(tags);
        for row in 0..nr {
            for col in 0..nc {
                let offx = col as f64 * dc;
                let offy = row as f64 * dr;
                // Lokal: v = S·(p − B) + off;  Welt: P + R·v.
                let m00 = cos * sx;
                let m01 = -sin * sy;
                let m10 = sin * sx;
                let m11 = cos * sy;
                let lx = -bx * sx + offx;
                let ly = -by * sy + offy;
                let local = Xf {
                    m00,
                    m01,
                    m10,
                    m11,
                    tx: ip.x + (cos * lx - sin * ly),
                    ty: ip.y + (sin * lx + cos * ly),
                    zs: sz,
                    zo: fz(ip.z) - bz * sz,
                };
                let world = xf.compose(&local);
                for e in &entities {
                    self.entity(e, &world, Some(layer), depth + 1);
                }
            }
        }
        self.insert_tags.pop();
    }
}

/// Blockname eines Block-Eintrags über sein Handle (z. B. Pfeilblock `_DOT` aus `DIMBLK`).
fn block_name_of(doc: &CadDocument, h: Handle) -> Option<&str> {
    if h.is_null() {
        return None;
    }
    doc.block_records.iter().find(|b| b.handle == h).map(|b| b.name.as_str())
}

/// MTEXT-Anhängepunkt → (horizontal, vertikal).
fn mtext_attach(a: AttachmentPoint) -> (HAlign, VAlign) {
    match a {
        AttachmentPoint::TopLeft => (HAlign::Left, VAlign::Top),
        AttachmentPoint::TopCenter => (HAlign::Center, VAlign::Top),
        AttachmentPoint::TopRight => (HAlign::Right, VAlign::Top),
        AttachmentPoint::MiddleLeft => (HAlign::Left, VAlign::Middle),
        AttachmentPoint::MiddleCenter => (HAlign::Center, VAlign::Middle),
        AttachmentPoint::MiddleRight => (HAlign::Right, VAlign::Middle),
        AttachmentPoint::BottomLeft => (HAlign::Left, VAlign::Bottom),
        AttachmentPoint::BottomCenter => (HAlign::Center, VAlign::Bottom),
        AttachmentPoint::BottomRight => (HAlign::Right, VAlign::Bottom),
    }
}

/// Messwert als Text (höchstens 3 Nachkommastellen, ohne Nullen am Ende).
fn format_measure(v: f64) -> String {
    if !v.is_finite() {
        return String::new();
    }
    let s = format!("{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn push_vertex(b: &mut MeshBucket, xf: &Xf, v: &Vector3) -> u32 {
    let idx = (b.positions.len() / 3) as u32;
    let [x, y] = xf.xy(if v.x.is_finite() { v.x } else { 0.0 }, if v.y.is_finite() { v.y } else { 0.0 });
    b.positions.push(x);
    b.positions.push(y);
    b.positions.push(xf.z(fz(v.z)));
    idx
}

/// Dreieck, sofern nicht entartet (gleiche Indizes) und alle Indizes gültig.
fn push_tri(b: &mut MeshBucket, a: u32, c1: u32, c2: u32) {
    if a == c1 || c1 == c2 || a == c2 {
        return;
    }
    let n = (b.positions.len() / 3) as u32;
    if a >= n || c1 >= n || c2 >= n {
        return;
    }
    b.indices.extend_from_slice(&[a, c1, c2]);
}

fn fan(b: &mut MeshBucket, ring: &[u32]) {
    if ring.len() < 3 {
        return;
    }
    for i in 1..ring.len() - 1 {
        push_tri(b, ring[0], ring[i], ring[i + 1]);
    }
}

/// Polylinien-Stützpunkte mit Bulges: je Segment mit Bulge ≠ 0 ein tessellierter Bogen
/// (Öffnungswinkel 4·atan(bulge), positiv = CCW). Bei geschlossenen Linien auch das
/// Schlusssegment, ohne den Startpunkt zu wiederholen.
fn bulge_points(verts: &[(Vector3, f64)], closed: bool) -> Vec<[f64; 2]> {
    let vs: Vec<([f64; 2], f64)> = verts
        .iter()
        .filter(|(v, _)| finite2(v))
        .map(|(v, b)| ([v.x, v.y], if b.is_finite() { *b } else { 0.0 }))
        .collect();
    let n = vs.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let (p, bulge) = vs[i];
        out.push(p);
        if i + 1 == n && !closed {
            break;
        }
        if bulge.abs() < 1e-12 {
            continue;
        }
        let q = vs[(i + 1) % n].0;
        arc_between(&mut out, p, q, bulge);
    }
    out
}

/// Stützpunkte `[x, y, bulge]` unter der Abbildung `xf` (nicht endliche Punkte weggelassen wie in
/// [`bulge_points`]), oder `None`, wenn kein Segment ein Bogen ist oder `xf` Kreise verzerrt.
fn bulge_vertices(verts: &[(Vector3, f64)], xf: &Xf) -> Option<Vec<[f64; 3]>> {
    let vs: Vec<([f64; 2], f64)> = verts
        .iter()
        .filter(|(v, _)| finite2(v))
        .map(|(v, b)| ([v.x, v.y], if b.is_finite() { *b } else { 0.0 }))
        .collect();
    if vs.len() < 2 || !vs.iter().any(|(_, b)| b.abs() >= 1e-12) {
        return None;
    }
    let mirrored = if xf.is_identity() { false } else { xf.conformal()? };
    let sign = if mirrored { -1.0 } else { 1.0 };
    Some(
        vs.iter()
            .map(|(p, b)| {
                let [x, y] = xf.xy(p[0], p[1]);
                [x, y, if b.abs() < 1e-12 { 0.0 } else { sign * b }]
            })
            .collect(),
    )
}

/// Zwischenpunkte (ohne Anfang und Ende) des Bulge-Bogens von `p` nach `q`.
fn arc_between(out: &mut Vec<[f64; 2]>, p: [f64; 2], q: [f64; 2], bulge: f64) {
    let dx = q[0] - p[0];
    let dy = q[1] - p[1];
    let chord = dx.hypot(dy);
    if chord == 0.0 || !chord.is_finite() {
        return;
    }
    let theta = 4.0 * bulge.atan();
    // Mittelpunkt links der Sehne (CCW) im Abstand (c/2)/tan(θ/2).
    let h = (chord / 2.0) / (theta / 2.0).tan();
    let (nx, ny) = (-dy / chord, dx / chord);
    let cx = p[0] + dx / 2.0 + nx * h;
    let cy = p[1] + dy / 2.0 + ny * h;
    let r = (p[0] - cx).hypot(p[1] - cy);
    let a0 = (p[1] - cy).atan2(p[0] - cx);
    let segs = segments_for(theta);
    for k in 1..segs {
        let t = a0 + theta * k as f64 / segs as f64;
        out.push([cx + r * t.cos(), cy + r * t.sin()]);
    }
}

/// Ellipsen-Linienzug; `true` = voller Umlauf (geschlossen, ohne Schluss-Duplikat).
fn ellipse_points(cx: f64, cy: f64, ax: f64, ay: f64, ratio: f64, start: f64, end: f64) -> (Vec<[f64; 2]>, bool) {
    let bx = -ay * ratio;
    let by = ax * ratio;
    let start = if start.is_finite() { start } else { 0.0 };
    let end = if end.is_finite() { end } else { TAU };
    let mut sweep = end - start;
    if sweep <= 0.0 {
        sweep += TAU;
    }
    let full = (sweep - TAU).abs() < 1e-9;
    let segs = segments_for(sweep);
    let last = if full { segs - 1 } else { segs };
    let pts = (0..=last)
        .map(|i| {
            let t = start + (sweep * i as f64) / segs as f64;
            let (st, ct) = t.sin_cos();
            [cx + ax * ct + bx * st, cy + ay * ct + by * st]
        })
        .collect();
    (pts, full)
}

/// Knoten-Span (The NURBS Book, A2.1), geklemmt auf [p, n].
fn find_span(n: usize, p: usize, t: f64, u: &[f64]) -> usize {
    if t >= u[n + 1] {
        return n;
    }
    if t <= u[p] {
        return p;
    }
    let mut low = p;
    let mut high = n + 1;
    let mut mid = (low + high) / 2;
    // Schleifenschutz: höchstens log2-viele Schritte bei sortierten Knoten; bei unsortierten
    // Knoten nach |U| Schritten abbrechen.
    let mut guard = u.len() * 2 + 8;
    while (t < u[mid] || t >= u[mid + 1]) && guard > 0 {
        if t < u[mid] {
            high = mid;
        } else {
            low = mid;
        }
        mid = (low + high) / 2;
        guard -= 1;
    }
    mid
}

fn de_boor(cps: &[[f64; 2]], u: &[f64], p: usize, t: f64) -> [f64; 2] {
    let n = cps.len() - 1;
    let span = find_span(n, p, t, u);
    let mut d: Vec<[f64; 2]> = (0..=p).map(|j| cps[span - p + j]).collect();
    for r in 1..=p {
        for j in (r..=p).rev() {
            let i = span - p + j;
            let denom = u[i + p - r + 1] - u[i];
            let a = if denom == 0.0 { 0.0 } else { (t - u[i]) / denom };
            d[j] = [(1.0 - a) * d[j - 1][0] + a * d[j][0], (1.0 - a) * d[j - 1][1] + a * d[j][1]];
        }
    }
    d[p]
}

/// Nicht-rationale B-Spline über [U[p], U[n+1]] abtasten, wenn |U| = |P| + Grad + 1; sonst `None`.
fn sample_bspline(cps: &[[f64; 2]], knots: &[f64], degree: i64) -> Option<Vec<[f64; 2]>> {
    if cps.len() < 2 || degree < 1 || knots.len() != cps.len() + degree as usize + 1 {
        return None;
    }
    let p = degree as usize;
    if p > cps.len() - 1 {
        // Grad grösser als Kontrollpunkte erlauben: Span-Index wäre ausserhalb.
        return None;
    }
    let samples = (cps.len() * 8).clamp(16, CURVE_MAX_SEG);
    let n = cps.len() - 1;
    let t0 = knots[p];
    let t1 = knots[n + 1];
    Some(
        (0..=samples)
            .map(|i| {
                let t = if i == samples { t1 } else { t0 + ((t1 - t0) * i as f64) / samples as f64 };
                de_boor(cps, knots, p, t)
            })
            .collect(),
    )
}

/// Periodische B-Spline (DWG/DXF speichern dann nur |P| + 1 Knoten): Kontrollpunkte um `Grad`
/// Stück zyklisch fortsetzen, Knoten periodisch erweitern, über eine Periode abtasten.
fn sample_periodic(cps: &[[f64; 2]], knots: &[f64], degree: i64) -> Option<Vec<[f64; 2]>> {
    let n = cps.len();
    if degree < 1 || n < 2 || knots.len() != n + 1 {
        return None;
    }
    let p = degree as usize;
    let period = knots[n] - knots[0];
    if period.is_nan() || period <= 0.0 || p > n {
        return None;
    }
    let ext_cps: Vec<[f64; 2]> = (0..n + p).map(|i| cps[i % n]).collect();
    // Knoten u_j für j = −p … n+p (Länge n + 2p + 1), u_{j±n} = u_j ± T.
    let ext_knots: Vec<f64> = (0..n + 2 * p + 1)
        .map(|k| {
            let j = k as i64 - p as i64;
            let wraps = j.div_euclid(n as i64);
            let r = j.rem_euclid(n as i64) as usize;
            knots[r] + wraps as f64 * period
        })
        .collect();
    let mut pts = sample_bspline(&ext_cps, &ext_knots, degree)?;
    // Geschlossene Kurve: Schlusspunkt = Startpunkt, der Ring schliesst ohnehin.
    pts.pop();
    Some(pts)
}

/// Ein HATCH-Randpfad → Stützpunkte (Polylinie mit Bulges, Linien-, Bogen-, Ellipsen-,
/// Spline-Kanten). Linienkanten liefern nur ihren Startpunkt (der Ring schliesst).
fn hatch_loop(path: &BoundaryPath) -> Vec<[f64; 2]> {
    let mut pts: Vec<[f64; 2]> = Vec::new();
    for edge in &path.edges {
        match edge {
            BoundaryEdge::Polyline(pl) => {
                let verts: Vec<(Vector3, f64)> =
                    pl.vertices.iter().map(|v| (Vector3::new(v.x, v.y, 0.0), v.z)).collect();
                pts.extend(bulge_points(&verts, true));
            }
            BoundaryEdge::Line(l) => {
                if l.start.x.is_finite() && l.start.y.is_finite() {
                    pts.push([l.start.x, l.start.y]);
                }
            }
            BoundaryEdge::CircularArc(a) => {
                if !(a.center.x.is_finite() && a.center.y.is_finite() && a.radius > 0.0) {
                    continue;
                }
                let (cx, cy, r) = (a.center.x, a.center.y, a.radius);
                for t in edge_params(a.start_angle, a.end_angle, a.counter_clockwise) {
                    pts.push([cx + r * t.cos(), cy + r * t.sin()]);
                }
            }
            BoundaryEdge::EllipticArc(e) => {
                let (cx, cy) = (e.center.x, e.center.y);
                let (mx, my) = (e.major_axis_endpoint.x, e.major_axis_endpoint.y);
                let ratio = e.minor_axis_ratio;
                if ![cx, cy, mx, my, ratio].iter().all(|v| v.is_finite()) {
                    continue;
                }
                let (bx, by) = (-my * ratio, mx * ratio);
                // Im Uhrzeigersinn gespeicherte Parameter sind wie beim Bogen gespiegelt.
                let (s, en) = if e.counter_clockwise {
                    (e.start_angle, e.end_angle)
                } else {
                    (TAU - e.start_angle, TAU - e.end_angle)
                };
                for t in edge_params(s, en, e.counter_clockwise) {
                    let (st, ct) = t.sin_cos();
                    pts.push([cx + mx * ct + bx * st, cy + my * ct + by * st]);
                }
            }
            BoundaryEdge::Spline(s) => {
                let cps: Vec<[f64; 2]> = s.control_points.iter().map(|p| [p.x, p.y]).collect();
                match sample_bspline(&cps, &s.knots, i64::from(s.degree)) {
                    Some(sampled) => pts.extend(sampled),
                    None => pts.extend(cps),
                }
            }
        }
    }
    pts
}

/// Parameter einer Bogenkante von `s` nach `e` in Laufrichtung, Spanne auf (0, 2π].
fn edge_params(s: f64, e: f64, ccw: bool) -> Vec<f64> {
    if !s.is_finite() || !e.is_finite() {
        return Vec::new();
    }
    let raw = if ccw { e - s } else { s - e };
    let mut sweep = raw.rem_euclid(TAU);
    if sweep == 0.0 {
        sweep = TAU;
    }
    let dir = if ccw { 1.0 } else { -1.0 };
    let segs = segments_for(sweep);
    (0..=segs).map(|i| s + dir * (sweep * i as f64) / segs as f64).collect()
}

// ── Flache Kodierung ─────────────────────────────────────────────────────────

/// Kodierung für JS: `(geom, strings)`. Strings (Ebenen, Texte, Entity-Typen) stehen einmal in
/// der Tabelle, `geom` verweist per Index darauf. Aufbau von `geom`:
///
/// ```text
/// [3 (Version), kind (0 DXF, 1 DWG), insUnits, total,
///  nLayerColors, (layer, rgb)…,
///  nCounts, (type, count)…,
///  nContours, (layer, flags, z, [kind, cx, cy, r, a0, a1 wenn flags&4], nPts, x, y …,
///              [nVerts, (x, y, bulge)… wenn flags&8])…,
///  nTexts, (layer, text, x, y, height, angle)…,
///  nMeshes, (layer, nPos, nIdx, positions…, indices…)…,
///  nLayouts, (name, entities)…, recovered (0/1), layoutName (String-Index, −1 = Modellraum)]
/// ```
/// `flags`: 1 = geschlossen, 2 = gefüllt, 4 = Kurve (kind 0 Bogen, 1 Kreis), 8 = Stützpunkte mit
/// Bulge ([`Contour::bulge_verts`]).
pub fn encode(data: &ImportData) -> (Vec<f64>, Vec<String>) {
    let mut strings: Vec<String> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut s = |v: &str| -> f64 {
        if let Some(&i) = index.get(v) {
            return i as f64;
        }
        index.insert(v.to_string(), strings.len());
        strings.push(v.to_string());
        (strings.len() - 1) as f64
    };
    let mut g: Vec<f64> = Vec::with_capacity(16 + data.contours.iter().map(|c| 4 + c.pts.len() * 2).sum::<usize>());
    g.push(3.0);
    g.push(match data.kind {
        SourceKind::Dxf => 0.0,
        SourceKind::Dwg => 1.0,
    });
    g.push(f64::from(data.ins_units));
    g.push(data.unit_scale);
    g.push(f64::from(data.total));
    g.push(data.layer_colors.len() as f64);
    for (name, rgb) in &data.layer_colors {
        g.push(s(name));
        g.push(f64::from(*rgb));
    }
    g.push(data.entity_counts.len() as f64);
    for (name, n) in &data.entity_counts {
        g.push(s(name));
        g.push(f64::from(*n));
    }
    g.push(data.contours.len() as f64);
    for c in &data.contours {
        g.push(s(&c.layer));
        let flags = u8::from(c.closed)
            | (u8::from(c.filled) << 1)
            | (u8::from(c.curve.is_some()) << 2)
            | (u8::from(c.bulge_verts.is_some()) << 3);
        g.push(f64::from(flags));
        g.push(c.z);
        if let Some(cv) = c.curve {
            g.extend_from_slice(&[if cv.circle { 1.0 } else { 0.0 }, cv.cx, cv.cy, cv.r, cv.a0, cv.a1]);
        }
        g.push(c.pts.len() as f64);
        for p in &c.pts {
            g.push(p[0]);
            g.push(p[1]);
        }
        if let Some(bv) = &c.bulge_verts {
            g.push(bv.len() as f64);
            for v in bv {
                g.extend_from_slice(v);
            }
        }
    }
    g.push(data.texts.len() as f64);
    for t in &data.texts {
        g.push(s(&t.layer));
        g.push(s(&t.text));
        g.extend_from_slice(&[t.x, t.y, t.height, t.angle]);
    }
    g.push(data.meshes.len() as f64);
    for m in &data.meshes {
        g.push(s(&m.layer));
        g.push((m.positions.len() / 3) as f64);
        g.push(m.indices.len() as f64);
        g.extend_from_slice(&m.positions);
        g.extend(m.indices.iter().map(|i| f64::from(*i)));
    }
    g.push(data.layouts.len() as f64);
    for l in &data.layouts {
        g.push(s(&l.name));
        g.push(f64::from(l.entities));
    }
    g.push(if data.recovered { 1.0 } else { 0.0 });
    g.push(match &data.layout {
        Some(name) => s(name),
        None => -1.0,
    });
    (g, strings)
}

#[cfg(test)]
#[path = "import_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "import_robust_tests.rs"]
mod robust_tests;
