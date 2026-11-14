// IFC4-/IFC2x3-Schreiber ([B5], Port von `src/export/exportIfc.ts`): erzeugt aus einer flachen Bauteilliste die
// STEP-Datei (ISO 10303-21). TS sammelt aus Projekt und Plan (Wand-Bänder, Öffnungen, Dach-Meshes,
// Raumflächen, Georeferenz — alles Geometrie, die im TS-Modell lebt) und gibt sie fertig gerechnet
// weiter; Rust vergibt die Entitätsnummern und baut die Entitäten, GUIDs, Typen mit Materialschichten,
// Eigenschaftssätze (gleicher Inhalt = ein Pset), Beziehungen, Räume und die Georeferenz. Die Reihenfolge
// der Entitäten ist die der TS-Fassung (Golden-Vergleich 28.10.).
//
// Flache Kodierung (Muster `export.rs`): Zahlen als `f64`-Puffer, Zeichenketten getrennt als EINE
// Zeichenkette, Teile durch `\0` getrennt; im Zahlenpuffer steht ihr Index (−1 = keine).
//
//   [FLAT_VERSION, META, Datensatz, Datensatz, …]
//   META     = project_id, project_name, now (Sekunden, ganzzahlig), iso (Zeitstempel, Text; leer = anonyme Abgabe [208]:
//              neutrale Programm-/Personenangaben, fester Kopf-Zeitstempel), has_geo (0/1),
//              ref_elevation (m ü. M. von Modell-z 0 = ±0.00, NaN = keine), ref_lat, ref_lon (WGS84-Grad des
//              Modell-Ursprungs, NaN = keine; nur IFC2x3), eastings, northings (LV95 des Modell-Ursprungs, [259]),
//              schema (0 = IFC4, 1 = IFC2x3), n_storeys, (id, name, base) × n_storeys
//   PTS      = n, x0, y0, …, x(n−1), y(n−1)                   (Profil, offen; Rust schliesst es)
//   MESH     = n_verts, x, y, z, …, n_tris, i0, i1, i2, …, closed (0/1)      (Indizes 0-basiert)
//   TYPEREF  = has (0/1); wenn 1: kind (0 Wand, 1 Decke, 2 Dach), type_id, type_name, predefined (Text),
//              n_layers, (component_id, component_name, thickness) × n_layers
//   PSETS    = n, (name, n_props, (prop_name, kind, value) × n_props) × n
//              kind 0 = IfcIdentifier (value = Zeichenketten-Index), 1 = IfcBoolean (0/1),
//              2 = IfcPositiveRatioMeasure (value = Zahl), 6 = IfcLabel (Zeichenketten-Index),
//              7 = IfcThermalTransmittanceMeasure (Zahl),
//              3 = IfcQuantityLength, 4 = IfcQuantityArea, 5 = IfcQuantityVolume (value = Zahl, ≥ 0).
//              Heisst der Satz `Qto_…` (auch `CH_Qto_…`, `Dossier_Qto_…`), entsteht je Bauteil ein eigener IfcElementQuantity (Basismengen,
//              nie geteilt); sonst ein IfcPropertySet (gleicher Inhalt = ein Pset für alle Bauteile).
//   structure= Geschoss-Index oder −1 (Gebäude)
//
//   WALL_SOLIDS = 1, structure, id, name, TYPEREF, PSETS, FRAME, n_solids, (PTS, z_rel, depth) × n_solids
//     FRAME = has_frame (0/1); wenn 1: ox, oy, ux, uy (Wandanfang und Achsrichtung in Welt-XY, ux²+uy² = 1),
//             axis_len, usage (0/1), offset. Mit Rahmen sitzt das Placement am Wandanfang, X = Achse, Y = linke
//             Normale ([B5]: so ordnen Revit/ArchiCAD die Schichten der Achse zu); die PTS bleiben Welt-XY und
//             werden hier ins Wandsystem gerechnet. Dazu eine „Axis“-Darstellung (IfcPolyline 0 … axis_len)
//             und, bei usage = 1 und vorhandenem Typ, IfcMaterialLayerSetUsage (AXIS2, POSITIVE, `offset` =
//             Abstand der ersten Schicht von der Achse entlang +Y). Ohne Rahmen: Placement ohne Drehung wie bisher.
//   WALL_MESH   = 2, structure, id, name, TYPEREF, PSETS, MESH
//   WALL_ARC    = 16 ([T2] Bogenwand), structure, id, name, TYPEREF, PSETS, cx, cy, r, a0, sweep, MESH
//                 Körper als Netz (Sehnen-Zerlegung, Öffnungen ausgespart), dazu die Achse als
//                 IfcTrimmedCurve auf einem IfcCircle (Welt-XY; a0/sweep im Bogenmass, sweep < 0 =
//                 Uhrzeigersinn → SenseAgreement .F.).
//   WALL_ARC_SOLID = 17 ([T2] Bogenwand als Profil-Extrusion), structure, id, name, TYPEREF, PSETS, cx, cy, r,
//                 a0, sweep, n_solids, (n, (x, y, bulge) × n, z_rel, depth) × n_solids
//                 Je Profil IfcArbitraryClosedProfileDef aus einer IfcCompositeCurve (bulge ≠ 0: Kreisbogen
//                 zur nächsten Ecke als IfcTrimmedCurve auf IfcCircle, DXF-Sinn: positiv = Gegenuhrzeigersinn;
//                 sonst Strecke), IfcExtrudedAreaSolid in +Z; Achse wie WALL_ARC. Öffnungen schneiden über
//                 OPENING (IfcRelVoidsElement).
//   GRID        = 18 ([112] Achsraster → IfcGrid), structure, id, name, n_u, n_v, (label, PTS) × (n_u + n_v)
//                 Linienzüge in Welt-XY (Bögen schon in Sehnen zerlegt); Placement der Trägerstruktur, ohne Darstellung.
//   CEILING     = 3, structure, id, name, TYPEREF, PSETS, PTS, n_inner, PTS × n_inner, z_rel, depth
//                 (innere Ringe = Deckenaussparungen, IfcArbitraryProfileDefWithVoids)
//   CEILING_ARC = 21 ([191] Decke mit Bogenkanten): wie CEILING, aber jeder Ring als BPTS = n, (x, y, bulge) × n
//                 (bulge zur nächsten Ecke, DXF-Sinn); Profil als IfcCompositeCurve (Bögen: IfcTrimmedCurve auf IfcCircle)
//   SPACE_ARC   = 22 ([191]): wie SPACE (7), Umriss als BPTS
//   OPENING     = 4, wall_id, structure, opening_id, is_door (0/1), fill_name, PTS (Öffnungskörper), z_rel,
//                 depth, width, FILL, PSETS
//     FILL (Parameter aus dem Modell; Körper, Placement und OperationType/PartitioningType rechnet
//          `ifc_openings.rs`, Version 2 seit 28.10.; OPT = has (0/1), value):
//          wall_sx, wall_sy, wall_ex, wall_ey, from, to, z_bottom, z_top, n_lo, n_hi,
//          frame_depth OPT, inset OPT, inset_outside (0/1), frame_width OPT,
//          wing_count, panes (1–3), n_sashes, (post, post_width OPT, fixed, width OPT) × n_sashes,
//          door_kind (0 Dreh, 1 Schiebe, 2 Wandöffnung), leaf_count, swing_sign (±1), dir_sign (±1),
//          hinge_at_start (0/1), transom_height, glazed (0/1), glazing_ratio OPT
//     Die Füllung bekommt ein eigenes Placement (Ursprung = Öffnungsmitte auf der Achse, X = u, Y = linke
//     Normale von u; Tür: Y = Aufschlagrichtung); ohne Teile (Wandöffnung) kein Körper. Alle Teile
//     (0 Rahmen/Zarge, 1 Türblatt, 2 Glas) sind getrennte Körper in EINER Darstellung, je mit eigenem
//     IfcStyledItem (Farbe/Transparenz je Rolle).
//   OPENING_SOLID = 15 ([G3] Formöffnung, [103] Dach-/Deckenfenster): host ("wall/<id>", "roof/<id>",
//                 "slab/<id>"), structure, opening_id, is_door, fill_name, n, (x, y) × n (Profil), origin (3),
//                 x_dir (3), z_dir (3), depth, height, width, PSETS, MESH (Füllung, Welt rel. Geschoss-UK).
//     IfcOpeningElement = Profil-Extrusion entlang z_dir (Position origin/x_dir/z_dir) im Geschoss-
//     Placement, IfcRelVoidsElement zum Wirt; IfcWindow/IfcDoor mit dem Netz, IfcRelFillsElement.
//   STAIR       = 5, structure, id, predefined (Text), PTS, z_rel, depth (Ersatzkörper, nur ohne Läufe/Podest),
//                 PSETS, n_flights, FLIGHT × n_flights, n_landings, LANDING × n_landings, n_rails, RAIL × n_rails,
//                 has_column, [COLUMN]
//     FLIGHT  = name, n_risers, n_treads, riser_height, tread_length, predefined (Text, IfcStairFlightTypeEnum),
//               PSETS, shape (0 = Extrusionen, 1 = Dreiecks-Mesh), 0: n, (PTS, z_rel, depth) × n | 1: MESH
//     LANDING = name, PTS, z_rel, depth, PSETS                  (IfcSlab, PredefinedType LANDING)
//     RAIL    = name, predefined (Text, IfcRailingTypeEnum: HANDRAIL, [155] GUARDRAIL), PSETS, MESH
//     COLUMN  = name, PTS, z_rel, depth, PSETS                 (Mittelsäule/Spindel: IfcColumn, COLUMN)
//     Mit mindestens einem Lauf/Podest/Geländer ist die IfcStair selbst ohne Darstellung und fasst Läufe,
//     Podest und Geländer per IfcRelAggregates zusammen (nur die Treppe liegt im Geschoss).
//   EXTRUSION   = 6, structure, id, PTS, z_rel, depth
//   SPACE       = 7, structure, id, name, long_name, external (0/1), height (lichte Höhe), z_rel (Oberkante Boden über Geschoss),
//                 ceiling_height (FinishCeilingHeight, mittlere lichte Höhe), PTS, net_area, gross_area,
//                 sia_category, PSETS
//   END_SPACES  = 8   (bündelt die Räume je Geschoss zu IfcRelAggregates)
//   ROOF        = 9, structure, id, name, predefined (Text), TYPEREF, PSETS, MESH
//   COLUMN      = 10, structure, id, label, PTS, z_rel, depth, component_id (−1 = keine), component_name, PSETS
//   COLUMN_PIECES = 20, structure, id, label, n, (PTS, z_rel, depth) × n, component_id (−1 = keine),
//                 component_name, PSETS   ([141] Stütze mit Höhenabschnitten, je Abschnitt ein eigenes beschnittenes
//                 Profil; EIN IfcColumn mit n Extrusionen in einer SweptSolid-Darstellung, Placement auf dem tiefsten
//                 Abschnitt; Material und Materialzuordnung wie COLUMN; die Mengen stehen fertig in PSETS)
//   END_COLUMNS = 11  (Materialzuordnung der Stützen)
//   LAYERS      = 25, n_refs, (key, layer_name) x n_refs   ([259]) IfcPresentationLayerAssignment je Ebene (Name =
//                 "Code_Bezeichnung" wie im DXF); alle Darstellungen des Bauteils `key` (wie bei CLASSIFICATION, samt
//                 aggregierter Teile) liegen auf genau einer Ebene. (IFC4 erlaubt bei IfcPresentationLayerWithStyle nur
//                 Geometrie-Items; Sichtbarkeit/Sperre der Klasse wird daher nicht geschrieben.)
//   CLASSIFICATION = 12, name, source, edition (Text, leer = keine), n_refs, (key, code, ref_name) × n_refs
//                 ([B5], 28.10.) Ein Klassifikationssystem (IfcClassification) mit je Code einer
//                 IfcClassificationReference und EINER IfcRelAssociatesClassification für alle Bauteile mit
//                 diesem Code. `key` = Schlüssel des Bauteils wie für seine GlobalId (`wall/<id>`, `slab/<id>`,
//                 `roof/<id>`, `column/<id>`, `stair/<id>`, `fill/<Öffnungs-id>` (Tür/Fenster), `space/<id>`,
//                 `storey/<id>`); unbekannte Schlüssel werden übersprungen (kein Fehler). Gehört ans Ende
//                 (nach allen Bauteilen); ein System ohne auflösbares Bauteil entsteht nicht.
//   ZONE        = 13, key, name, long_name, n_spaces, (space_id) × n_spaces, PSETS
//                 IfcZone mit IfcRelAssignsToGroup der Räume (`space/<id>`-Entitäten; unbekannte ids werden
//                 übersprungen, ohne Raum keine Zone). GlobalId aus `zone/<key>`; Psets/Mengen wie bei Bauteilen.
//   ATTACH      = 14, key, PSETS   (Psets/Mengen an ein schon geschriebenes Bauteil/Geschoss, Schlüssel wie oben)
//   GUIDS       = 23 ([201] GlobalId-Rundreise), n, (key, guid) × n: übernommene GlobalIds importierter Bauteile.
//                 key = Bauteil-Schlüssel wie für die abgeleitete GlobalId (`wall/<id>`, `slab/<id>`, `roof/<id>`,
//                 `column/<id>`, `stair/<id>`, `space/<id>`, `extrusion/<id>`, `fill/<Öffnungs-id>`); guid = 22 Zeichen.
//                 Gehört VOR alle Bauteile. Doppelte oder ungültige GlobalIds werden verworfen (dann abgeleitet).
//   TREE        = 19 ([149] Baum), structure, id, name, PSETS, MESH (Stamm + Krone, Welt rel. Geschoss-UK)
//                 IFC4: IfcGeographicElement (ObjectType „Baum", PredefinedType USERDEFINED); IFC2x3 (kennt die
//                 Klasse nicht): IfcBuildingElementProxy mit ObjectType „Baum". GlobalId aus `tree/<id>`.
//   CONTEXT     = 24 ([259] Kontext, nur mit Option), kind (0 Netz auf Umgebungsklasse, 1 Gelände), id, name, class
//                 (Klasse als Text, leer = keine), MESH (Modell-Koordinaten, z absolut). Am IfcSite eingegliedert (nicht
//                 im Geschoss); Gelände: IfcGeographicElement TERRAIN, sonst IfcBuildingElementProxy (ObjectType „Kontext",
//                 USERDEFINED); IFC2x3 beides als Proxy. Description = Klasse. GlobalId aus `context/<id>`.
//
// Schema IFC2x3 (Coordination View 2.0, TC1; [B5] 28.10.): gleiche Datensätze, GUIDs, Psets und Mengen, aber
// die Entitäten des Schemas — Netze als IfcFacetedBrep (dicht) bzw. IfcShellBasedSurfaceModel (offen) statt
// IfcTriangulatedFaceSet, IfcWallStandardCase für Wände mit IfcMaterialLayerSetUsage, IfcDoorStyle/
// IfcWindowStyle statt OperationType am Bauteil, Dachschichten direkt am Dach (es gibt keinen IfcRoofType),
// Georeferenz als IfcSite.RefLatitude/RefLongitude plus ePSet_ProjectedCRS/ePSet_MapConversion am IfcProject,
// IfcPresentationStyleAssignment um die Oberflächenstile, Attributlisten nach IFC2X3_TC1.
//
// Danach folgen (am Pufferende) Typ-Zuordnungen, Eigenschaftssätze, räumliche Eingliederung und Fuss.
//
// Fehlerverhalten: ein kaputter Puffer (falsche Version, unbekannter Datensatz, abgeschnitten, Index
// ausserhalb, NaN/∞ in einer Koordinate) ergibt einen Fehler, nie einen Panic.
//
// Abweichungen zur TS-Fassung: Zeichenketten mit unpaarigen UTF-16-Surrogaten kommen über wasm-bindgen als
// U+FFFD an (TS schrieb `\X2\D800\X0\`); `\0` in Namen wird auf TS-Seite entfernt; NaN/∞ in Koordinaten
// ist ein Fehler statt der Zeichenkette „NaN“.

use std::collections::HashMap;

use crate::ifc_openings::{fill_geometry, DoorKind, FillParams, FillPart, Sash, MAX_SASHES};

/// Version der flachen Kodierung (erstes Element des Puffers). 3 seit 28.10.: Basismengen (Pset-Arten 3–5), Deckenaussparungen, Treppen mit Läufen.
/// 4 seit 28.10.: Schema-Wahl und Breite/Länge im META.
/// 5 seit 14.11. ([259]): Versatz des Modell-Ursprungs in LV95 im META, Geometrie bleibt lokal.
pub const FLAT_VERSION: f64 = 5.0;

/// IFC-Schema der Ausgabe.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Schema {
    Ifc4,
    Ifc2x3,
}

pub const REC_WALL_SOLIDS: f64 = 1.0;
pub const REC_WALL_MESH: f64 = 2.0;
pub const REC_CEILING: f64 = 3.0;
pub const REC_OPENING: f64 = 4.0;
pub const REC_STAIR: f64 = 5.0;
pub const REC_EXTRUSION: f64 = 6.0;
pub const REC_SPACE: f64 = 7.0;
pub const REC_END_SPACES: f64 = 8.0;
pub const REC_ROOF: f64 = 9.0;
pub const REC_COLUMN: f64 = 10.0;
pub const REC_END_COLUMNS: f64 = 11.0;
pub const REC_CLASSIFICATION: f64 = 12.0;
pub const REC_ZONE: f64 = 13.0;
pub const REC_ATTACH: f64 = 14.0;
pub const REC_OPENING_SOLID: f64 = 15.0;
pub const REC_WALL_ARC: f64 = 16.0;
pub const REC_WALL_ARC_SOLID: f64 = 17.0;
pub const REC_GRID: f64 = 18.0;
pub const REC_GUIDS: f64 = 23.0;
pub const REC_TREE: f64 = 19.0;
pub const REC_CONTEXT: f64 = 24.0;
pub const REC_LAYERS: f64 = 25.0;
pub const REC_COLUMN_PIECES: f64 = 20.0;
pub const REC_CEILING_ARC: f64 = 21.0;
pub const REC_SPACE_ARC: f64 = 22.0;

mod format;
mod reader;
mod types;
mod builder;
pub use format::*;
use reader::*;
use types::*;
use builder::*;

#[cfg(test)]
mod tests;

/// Ob die Eingabe überhaupt einen Datensatz verlangt — Hilfe für die Fehlermeldung.
fn rec_name(code: f64) -> &'static str {
    match code {
        c if c == REC_WALL_SOLIDS => "WALL_SOLIDS",
        c if c == REC_WALL_MESH => "WALL_MESH",
        c if c == REC_WALL_ARC => "WALL_ARC",
        c if c == REC_WALL_ARC_SOLID => "WALL_ARC_SOLID",
        c if c == REC_CEILING => "CEILING",
        c if c == REC_CEILING_ARC => "CEILING_ARC",
        c if c == REC_SPACE_ARC => "SPACE_ARC",
        c if c == REC_OPENING => "OPENING",
        c if c == REC_OPENING_SOLID => "OPENING_SOLID",
        c if c == REC_CLASSIFICATION => "CLASSIFICATION",
        c if c == REC_ZONE => "ZONE",
        c if c == REC_ATTACH => "ATTACH",
        c if c == REC_GRID => "GRID",
        c if c == REC_GUIDS => "GUIDS",
        c if c == REC_TREE => "TREE",
        c if c == REC_CONTEXT => "CONTEXT",
        c if c == REC_LAYERS => "LAYERS",
        c if c == REC_COLUMN_PIECES => "COLUMN_PIECES",
        _ => "?",
    }
}

/// Winkel in Grad als IfcCompoundPlaneAngleMeasure `(Grad,Minuten,Sekunden,Millionstel)`; alle Glieder tragen das
/// Vorzeichen des Winkels. `limit` = Betragsgrenze (90 Breite, 180 Länge), darüber wird geklemmt.
fn compound_angle(deg: f64, limit: f64) -> String {
    let neg = deg < 0.0;
    // In Millionstel Bogensekunden runden (ganzzahlig), dann zerlegen — so gibt es keine Überträge von 60.
    let total = (deg.abs().min(limit) * 3600.0 * 1_000_000.0).round() as i64;
    let micro = total % 1_000_000;
    let secs = total / 1_000_000;
    let (d, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    let sg = if neg { -1 } else { 1 };
    format!("({},{},{},{})", sg * d, sg * m, sg * s, sg * micro)
}

/// Zerlegt die Parameter einer Entity-Zeile `#n=TYPE(a,b,...);` auf oberster Ebene (Klammern und Strings beachtet).
fn split_args(line: &str) -> (String, Vec<String>) {
    let Some(open) = line.find('(') else { return (String::new(), vec![]) };
    let ty = line[line.find('=').map_or(0, |i| i + 1)..open].to_string();
    let body = line[open + 1..].trim_end_matches(';').trim_end_matches(')');
    let (mut out, mut cur, mut depth, mut quote) = (Vec::new(), String::new(), 0i32, false);
    for ch in body.chars() {
        match ch {
            '\'' => {
                quote = !quote;
                cur.push(ch);
            }
            '(' if !quote => {
                depth += 1;
                cur.push(ch);
            }
            ')' if !quote => {
                depth -= 1;
                cur.push(ch);
            }
            ',' if !quote && depth == 0 => out.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    out.push(cur);
    (ty, out)
}

fn ref_ids(arg: &str) -> Vec<usize> {
    arg.split('#').skip(1).filter_map(|t| t.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()).collect()
}

/// IfcRelAggregates: Eltern-Entitaet -> Teile.
fn aggregate_children(lines: &[String]) -> HashMap<usize, Vec<usize>> {
    let mut out: HashMap<usize, Vec<usize>> = HashMap::new();
    for l in lines.iter().filter(|l| l.contains("=IFCRELAGGREGATES(")) {
        let (_, a) = split_args(l);
        if let (Some(parent), Some(kids)) = (a.get(4).and_then(|x| ref_ids(x).first().copied()), a.get(5)) {
            out.entry(parent).or_default().extend(ref_ids(kids));
        }
    }
    out
}

/// Alle IfcShapeRepresentation eines Bauteils samt seiner aggregierten Teile (Treppenlaeufe ...).
fn shape_reps_of(lines: &[String], agg: &HashMap<usize, Vec<usize>>, entity: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let mut todo = vec![entity];
    let mut guard = 0;
    while let Some(e) = todo.pop() {
        guard += 1;
        if guard > 10_000 {
            break;
        }
        if let Some(l) = lines.get(e.wrapping_sub(1)) {
            let (_, a) = split_args(l);
            // Product: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation
            if let Some(def) = a.get(6).and_then(|x| ref_ids(x).first().copied()) {
                if let Some(dl) = lines.get(def.wrapping_sub(1)) {
                    let (ty, da) = split_args(dl);
                    if ty == "IFCPRODUCTDEFINITIONSHAPE" {
                        out.extend(da.get(2).map(|x| ref_ids(x)).unwrap_or_default());
                    }
                }
            }
        }
        if let Some(kids) = agg.get(&e) {
            todo.extend(kids.iter().copied());
        }
    }
    out
}


/// Baut aus dem flachen Puffer die STEP-Datei (IFC4 oder IFC2x3, je nach META). Fehler als Text.
pub fn build_ifc(flat: &[f64], strings: &str) -> Result<String, String> {
    let mut r = Reader { buf: flat, pos: 0, strings: strings.split('\0').collect() };
    let version = r.raw()?;
    if version != FLAT_VERSION {
        return Err(format!("unbekannte Version {version}"));
    }
    // ── META ──
    let project_id = r.string()?;
    let project_name = r.string()?;
    let now_f = r.f()?;
    if now_f.fract() != 0.0 {
        return Err("Zeitstempel nicht ganzzahlig".to_string());
    }
    let now = now_f as i64;
    let iso = r.string()?;
    // Leerer Zeitstempel = anonyme Abgabe ([208]): neutrale Erzeuger-/Autorangaben, fester Kopf-Zeitstempel.
    let anon = iso.is_empty();
    let iso = if anon { "2000-01-01T00:00:00".to_string() } else { iso };
    let has_geo = r.flag()?;
    let ref_elevation = r.raw()?;
    let (ref_lat, ref_lon) = (r.raw()?, r.raw()?);
    let (eastings, northings) = (r.f()?, r.f()?);
    let orthogonal_height = if ref_elevation.is_finite() { ref_elevation } else { 0.0 };
    let schema = match r.idx()? {
        0 => Schema::Ifc4,
        1 => Schema::Ifc2x3,
        k => return Err(format!("unbekanntes Schema {k} bei {}", r.pos - 1)),
    };
    let n_storeys = r.idx()?;
    let mut storey_defs = Vec::new();
    for _ in 0..n_storeys {
        let id = r.string()?;
        let name = r.string()?;
        let base = r.f()?;
        storey_defs.push((id, name, base));
    }

    let mut w = Builder {
        lines: Vec::new(),
        schema,
        project_id,
        owner_history: 0,
        context: 0,
        identity_axis: 0,
        extrude_dir: 0,
        building_entity: 0,
        building_placement: 0,
        site_entity: 0,
        site_placement: 0,
        storeys: Vec::new(),
        containment: Vec::new(),
        psets: Vec::new(),
        pset_index: HashMap::new(),
        qtos: Vec::new(),
        materials: HashMap::new(),
        types: Vec::new(),
        type_index: HashMap::new(),
        walls: HashMap::new(),
        guid_override: HashMap::new(),
        axis_context: 0,
        styles: [0; 3],
        spaces: Vec::new(),
        column_materials: Vec::new(),
        elements: HashMap::new(),
        fill_styles: Vec::new(),
    };
    let v2 = schema == Schema::Ifc2x3;
    let pname = |dflt: &str| if project_name.is_empty() { dflt.to_string() } else { project_name.clone() };

    // Geteilte Grundgeometrie: Ursprung, Z-Extrusionsrichtung, Identitäts-Placement.
    let origin = w.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(0.0)]));
    w.extrude_dir = w.add("IFCDIRECTION", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(1.0)]));
    w.identity_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin},$,$"));

    // Owner-History (minimal, aber vorhanden — manche Importer verlangen sie). Anonyme Abgabe ([208], leerer
    // Zeitstempel in META): keine Angabe zu Programm, Person oder Organisation — nur der Strich als Pflichtwert.
    let who = if anon { "-" } else { "dossier" };
    let app_version = if anon { "-" } else { "1.0" };
    let org = w.add("IFCORGANIZATION", format!("$,{},$,$,$", ifc_string(who)));
    // IFC2x3 verlangt FamilyName oder GivenName (WR1), IFC4 genügt die Kennung.
    let person = w.add(
        "IFCPERSON",
        if v2 { format!("{0},{0},$,$,$,$,$,$", ifc_string(who)) } else { format!("{},$,$,$,$,$,$,$", ifc_string(who)) },
    );
    let person_org = w.add("IFCPERSONANDORGANIZATION", format!("#{person},#{org},$"));
    let app = w.add(
        "IFCAPPLICATION",
        format!("#{org},{},{},{}", ifc_string(app_version), ifc_string(who), ifc_string(who)),
    );
    // ChangeAction ADDED verlangt ein LastModifiedDate (IFC4-Regel IfcOwnerHistory.CorrectChangeAction).
    w.owner_history = w.add(
        "IFCOWNERHISTORY",
        format!("#{person_org},#{app},$,{},{now},$,$,{now}", enum_("ADDED")),
    );

    // Einheiten (Meter, Radiant, m², m³).
    let len_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", enum_("LENGTHUNIT"), enum_("METRE")));
    let area_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", enum_("AREAUNIT"), enum_("SQUARE_METRE")));
    let vol_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", enum_("VOLUMEUNIT"), enum_("CUBIC_METRE")));
    let angle_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", enum_("PLANEANGLEUNIT"), enum_("RADIAN")));
    let unit_assignment = w.add(
        "IFCUNITASSIGNMENT",
        refs(&[len_unit, area_unit, vol_unit, angle_unit]),
    );

    // Geometrischer Kontext (3D, Precision 1e-5).
    w.context = w.add(
        "IFCGEOMETRICREPRESENTATIONCONTEXT",
        format!("$,{},3,{},#{},$", ifc_string("Model"), fmt_real(0.00001), w.identity_axis),
    );

    // Georeferenz ([259]): die Geometrie bleibt lokal (Modell-Meter, z 0 = ±0.00), IfcMapConversion verschiebt den
    // Ursprung nach LV95 (Eastings/Northings) und auf die Meereshöhe von ±0.00 (OrthogonalHeight); keine Drehung (das
    // Modell ist nach Norden ausgerichtet, x = Ost). IFC2x3 kennt beide Entitäten nicht und bekommt
    // ePSet_ProjectedCRS/ePSet_MapConversion am IfcProject (s. unten).
    if has_geo && !v2 {
        let crs = w.add(
            "IFCPROJECTEDCRS",
            format!(
                "{},{},{},$,{},$,#{len_unit}",
                ifc_string("EPSG:2056"),
                ifc_string("CH1903+ / LV95"),
                ifc_string("CH1903+"),
                ifc_string("Swiss Oblique Mercator")
            ),
        );
        w.add(
            "IFCMAPCONVERSION",
            format!(
                "#{},#{crs},{},{},{},{},{},{}",
                w.context,
                fmt_real(eastings),
                fmt_real(northings),
                fmt_real(orthogonal_height),
                fmt_real(1.0),
                fmt_real(0.0),
                fmt_real(1.0)
            ),
        );
    }

    // Räumliche Hierarchie: Project → Site → Building → Storeys.
    let site_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin},$,$"));
    let site_placement = w.add("IFCLOCALPLACEMENT", format!("$,#{site_axis}"));
    let building_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin},$,$"));
    w.building_placement = w.add("IFCLOCALPLACEMENT", format!("#{site_placement},#{building_axis}"));

    let g = w.gid("project");
    let project_entity = w.add(
        "IFCPROJECT",
        format!(
            "{g},#{},{},$,$,$,$,{},#{unit_assignment}",
            w.owner_history,
            ifc_string(&pname("Projekt")),
            refs(&[w.context])
        ),
    );
    // RefElevation (m ü. M.): rein informativ, die Geometrie wird nicht verschoben.
    let site_ref_elev = if ref_elevation.is_finite() { fmt_real(ref_elevation) } else { "$".to_string() };
    // IFC2x3: Breite/Länge des Bezugspunkts (WGS84) als IfcCompoundPlaneAngleMeasure; IFC4 trägt sie im CRS.
    let (site_lat, site_lon) = if v2 && has_geo && ref_lat.is_finite() && ref_lon.is_finite() {
        (compound_angle(ref_lat, 90.0), compound_angle(ref_lon, 180.0))
    } else {
        ("$".to_string(), "$".to_string())
    };
    let g = w.gid("site");
    let site_entity = w.add(
        "IFCSITE",
        format!(
            "{g},#{},{},$,$,#{site_placement},$,$,{},{site_lat},{site_lon},{site_ref_elev},$,$",
            w.owner_history,
            ifc_string("Standort"),
            enum_("ELEMENT")
        ),
    );
    let g = w.gid("building");
    w.building_entity = w.add(
        "IFCBUILDING",
        format!(
            "{g},#{},{},$,$,#{},$,$,{},$,$,$",
            w.owner_history,
            ifc_string(&pname("Gebäude")),
            w.building_placement,
            enum_("ELEMENT")
        ),
    );
    // Schlüssel für Mengen am Gebäude (ATTACH „building“, [259]) und die Kontext-Eingliederung am Grundstück.
    w.elements.insert("building".to_string(), w.building_entity);
    w.site_entity = site_entity;
    w.site_placement = site_placement;
    let g = w.gid("aggregates/site");
    w.add(
        "IFCRELAGGREGATES",
        format!("{g},#{},$,$,#{project_entity},{}", w.owner_history, refs(&[site_entity])),
    );
    let g = w.gid("aggregates/building");
    w.add(
        "IFCRELAGGREGATES",
        format!("{g},#{},$,$,#{site_entity},{}", w.owner_history, refs(&[w.building_entity])),
    );

    // IFC2x3-Georeferenz (Konvention buildingSMART): Koordinatensystem und Abbildung als Eigenschaftssätze am
    // IfcProject, mit demselben Versatz wie IfcMapConversion.
    if v2 && has_geo {
        let txt = |name: &str, ty: &str, v: &str| (name.to_string(), format!("{ty}({})", ifc_string(v)));
        let num = |name: &str, ty: &str, v: f64| (name.to_string(), format!("{ty}({})", fmt_real(v)));
        let crs = [
            txt("Name", "IFCLABEL", "EPSG:2056"),
            txt("Description", "IFCTEXT", "CH1903+ / LV95"),
            txt("GeodeticDatum", "IFCIDENTIFIER", "CH1903+"),
            txt("MapProjection", "IFCIDENTIFIER", "Swiss Oblique Mercator"),
            txt("MapUnit", "IFCLABEL", "METRE"),
        ];
        let conversion = [
            num("Eastings", "IFCLENGTHMEASURE", eastings),
            num("Northings", "IFCLENGTHMEASURE", northings),
            num("OrthogonalHeight", "IFCLENGTHMEASURE", orthogonal_height),
            num("XAxisAbscissa", "IFCREAL", 1.0),
            num("XAxisOrdinate", "IFCREAL", 0.0),
            num("Scale", "IFCREAL", 1.0),
        ];
        for (set, props) in [("ePSet_ProjectedCRS", &crs[..]), ("ePSet_MapConversion", &conversion[..])] {
            let ids: Vec<usize> = props
                .iter()
                .map(|(n, v)| w.add("IFCPROPERTYSINGLEVALUE", format!("{},$,{v},$", ifc_string(n))))
                .collect();
            let g = w.gid(&format!("project/{set}"));
            let pset = w.add("IFCPROPERTYSET", format!("{g},#{},{},$,{}", w.owner_history, ifc_string(set), refs(&ids)));
            let g = w.gid(&format!("project/{set}/rel"));
            w.add("IFCRELDEFINESBYPROPERTIES", format!("{g},#{},$,$,{},#{pset}", w.owner_history, refs(&[project_entity])));
        }
    }

    // Je Geschoss ein IfcBuildingStorey (Elevation = base).
    let mut storey_entities = Vec::new();
    for (id, name, base) in storey_defs {
        let pt = w.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(base)]));
        let axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{pt},$,$"));
        let placement = w.add("IFCLOCALPLACEMENT", format!("#{},#{axis}", w.building_placement));
        let g = w.gid(&format!("storey/{id}"));
        let entity = w.add(
            "IFCBUILDINGSTOREY",
            format!(
                "{g},#{},{},$,$,#{placement},$,$,{},{}",
                w.owner_history,
                ifc_string(&name),
                enum_("ELEMENT"),
                fmt_real(base)
            ),
        );
        w.elements.insert(format!("storey/{id}"), entity);
        w.storeys.push(Storey { id, entity, placement });
        storey_entities.push(entity);
    }
    if !storey_entities.is_empty() {
        let g = w.gid("aggregates/storeys");
        w.add(
            "IFCRELAGGREGATES",
            format!("{g},#{},$,$,#{},{}", w.owner_history, w.building_entity, refs(&storey_entities)),
        );
    }

    // ── Datensätze ──
    while !r.done() {
        let code = r.raw()?;
        match code {
            c if c == REC_WALL_SOLIDS => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let has_frame = r.flag()?;
                let (frame, axis_len, usage, offset) = if has_frame {
                    let (ox, oy, ux, uy) = (r.f()?, r.f()?, r.f()?, r.f()?);
                    if ((ux * ux + uy * uy) - 1.0).abs() > 1e-6 {
                        return Err(format!("Achsrichtung nicht normiert bei {}", r.pos - 1));
                    }
                    let (len, usage, offset) = (r.f()?, r.flag()?, r.f()?);
                    (Frame { ox, oy, ux, uy }, len, usage, offset)
                } else {
                    (Frame::WORLD, 0.0, false, 0.0)
                };
                let n = r.idx()?;
                let mut solids = Vec::new();
                for _ in 0..n {
                    let pts = frame.local_pts(&r.pts()?);
                    let z_rel = r.f()?;
                    let depth = r.f()?;
                    solids.push(w.emit_extrusion(&pts, z_rel, depth));
                }
                let parent = w.placement_of(structure);
                let (placement, shape) = if has_frame {
                    (w.emit_placement_frame(&frame, parent), w.emit_wall_shape(&solids, axis_len))
                } else {
                    (w.emit_placement(0.0, parent), w.emit_swept_shape(&solids))
                };
                // IFC2x3: IfcWallStandardCase verlangt genau eine IfcMaterialLayerSetUsage (WR1) — nur dann.
                let standard = v2 && has_frame && usage && ty.as_ref().is_some_and(|t| !t.layers.is_empty());
                let class = if standard { "IFCWALLSTANDARDCASE" } else { "IFCWALL" };
                let entity = w.finish_typed(class, format!("wall/{id}"), &name, &ty, &psets, structure, placement, shape, None, true);
                if has_frame && usage {
                    // Schichten des Typs der Wandachse zuordnen: erste Schicht (aussen) liegt bei `offset`
                    // von der Achse, die übrigen folgen in +Y (linke Normale).
                    let set = ty.as_ref().and_then(|t| w.layer_set_of(t));
                    if let Some(set) = set {
                        let u = w.add(
                            "IFCMATERIALLAYERSETUSAGE",
                            format!("#{set},{},{},{}{}", enum_("AXIS2"), enum_("POSITIVE"), fmt_real(offset), if v2 { "" } else { ",$" }),
                        );
                        let g = w.gid(&format!("wall/{id}/material"));
                        w.add(
                            "IFCRELASSOCIATESMATERIAL",
                            format!("{g},#{},$,$,{},#{u}", w.owner_history, refs(&[entity])),
                        );
                    }
                }
                w.walls.insert(id, (entity, placement, frame));
            }
            c if c == REC_WALL_MESH => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let mesh = r.mesh()?;
                let (placement, shape) = w.emit_triangulated_product(&mesh, w.placement_of(structure));
                let entity = w.finish_typed("IFCWALL", format!("wall/{id}"), &name, &ty, &psets, structure, placement, shape, None, true);
                w.walls.insert(id, (entity, placement, Frame::WORLD));
            }
            c if c == REC_WALL_ARC => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let (cx, cy, rad, a0, sweep) = (r.f()?, r.f()?, r.f()?, r.f()?, r.f()?);
                if !(rad > 0.0) || !(sweep.abs() > 1e-9) {
                    return Err(format!("Bogenachse ungültig bei {}", r.pos - 1));
                }
                let mesh = r.mesh()?;
                let (placement, shape) = w.emit_arc_wall_product(&mesh, (cx, cy, rad, a0, sweep), w.placement_of(structure));
                let entity = w.finish_typed("IFCWALL", format!("wall/{id}"), &name, &ty, &psets, structure, placement, shape, None, true);
                w.walls.insert(id, (entity, placement, Frame::WORLD));
            }
            c if c == REC_WALL_ARC_SOLID => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let (cx, cy, rad, a0, sweep) = (r.f()?, r.f()?, r.f()?, r.f()?, r.f()?);
                if !(rad > 0.0) || !(sweep.abs() > 1e-9) {
                    return Err(format!("Bogenachse ungültig bei {}", r.pos - 1));
                }
                let n = r.idx()?;
                let mut solids = Vec::new();
                for _ in 0..n {
                    let m = r.idx()?;
                    if m < 2 {
                        return Err(format!("Bogenprofil zu kurz bei {}", r.pos - 1));
                    }
                    let ring: Vec<(f64, f64, f64)> = r.take(m.checked_mul(3).ok_or("Überlauf")?)?.chunks_exact(3).map(|c| (c[0], c[1], c[2])).collect();
                    if ring.iter().any(|v| !(v.0.is_finite() && v.1.is_finite() && v.2.is_finite())) {
                        return Err(format!("Bogenprofil ungültig bei {}", r.pos - 1));
                    }
                    let (z_rel, depth) = (r.f()?, r.f()?);
                    solids.push(w.emit_bulge_extrusion(&ring, z_rel, depth));
                }
                let (placement, shape) = w.emit_arc_wall_solid_product(&solids, (cx, cy, rad, a0, sweep), w.placement_of(structure));
                let entity = w.finish_typed("IFCWALL", format!("wall/{id}"), &name, &ty, &psets, structure, placement, shape, None, true);
                w.walls.insert(id, (entity, placement, Frame::WORLD));
            }
            c if c == REC_CEILING || c == REC_CEILING_ARC => {
                let arcs = c == REC_CEILING_ARC;
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let pts = if arcs { r.bpts()? } else { r.pts()?.into_iter().map(|p| (p.0, p.1, 0.0)).collect() };
                let n_inner = r.idx()?;
                let mut inner = Vec::new();
                for _ in 0..n_inner {
                    inner.push(if arcs { r.bpts()? } else { r.pts()?.into_iter().map(|p| (p.0, p.1, 0.0)).collect::<Vec<_>>() });
                }
                let z_rel = r.f()?;
                let depth = r.f()?;
                let (placement, shape) = if arcs {
                    w.emit_box_product_voids_arcs(&pts, &inner, z_rel, depth, w.placement_of(structure))
                } else {
                    let plain: Vec<(f64, f64)> = pts.iter().map(|p| (p.0, p.1)).collect();
                    let plain_inner: Vec<Vec<(f64, f64)>> = inner.iter().map(|ring| ring.iter().map(|p| (p.0, p.1)).collect()).collect();
                    w.emit_box_product_voids(&plain, &plain_inner, z_rel, depth, w.placement_of(structure))
                };
                w.finish_typed("IFCSLAB", format!("slab/{id}"), &name, &ty, &psets, structure, placement, shape, Some(enum_("FLOOR")), true);
            }
            c if c == REC_OPENING => {
                let wall_id = r.string()?;
                let structure = r.structure(n_storeys)?;
                let opening_id = r.string()?;
                let is_door = r.flag()?;
                let fill_name = r.string()?;
                let void_pts = r.pts()?;
                let void_z = r.f()?;
                let depth = r.f()?;
                let width = r.f()?;
                let fill = fill_geometry(&r.fill_params(is_door)?);
                let (kind, parts) = (fill.kind, fill.parts);
                let ((fox, foy), (fux, fuy)) = (fill.origin, fill.u);
                if ((fux * fux + fuy * fuy) - 1.0).abs() > 1e-6 || !(fox.is_finite() && foy.is_finite()) {
                    return Err(format!("Füllungsrichtung nicht normiert bei {}", r.pos - 1));
                }
                if parts.iter().any(|p| !(p.z_rel.is_finite() && p.depth.is_finite() && p.pts.iter().all(|q| q.0.is_finite() && q.1.is_finite()))) {
                    return Err(format!("Füllung mit NaN/∞ bei {}", r.pos - 1));
                }
                let fill_frame = Frame { ox: fox, oy: foy, ux: fux, uy: fuy };
                let psets = r.psets()?;
                let Some(&(host_entity, host_placement, host_frame)) = w.walls.get(&wall_id) else {
                    continue; // Wirtswand nicht geschrieben (degeneriert)
                };
                // Die Geometrie kommt in Welt-XY; Wände mit eigenem Placement rechnen wir ins Wandsystem.
                let void_pts = if host_frame.is_world() { void_pts } else { host_frame.local_pts(&void_pts) };
                let (opening_placement, opening_shape) = w.emit_box_product(&void_pts, void_z, depth, host_placement);
                let g = w.gid(&format!("opening/{opening_id}"));
                let opening_entity = w.add(
                    "IFCOPENINGELEMENT",
                    format!(
                        "{g},#{},{},$,$,#{opening_placement},#{opening_shape},${}",
                        w.owner_history,
                        ifc_string(if is_door { "Türöffnung" } else { "Fensteröffnung" }),
                        if v2 { String::new() } else { format!(",{}", enum_("OPENING")) }
                    ),
                );
                let g = w.gid(&format!("voids/{opening_id}"));
                w.add(
                    "IFCRELVOIDSELEMENT",
                    format!("{g},#{},$,$,#{host_entity},#{opening_entity}", w.owner_history),
                );
                // Füllung: eigenes Placement (Ursprung/Richtung aus dem Modell, relativ zur Öffnung = zur Wand),
                // Körper in diesem System; ohne Teile (reine Wandöffnung) keine Darstellung.
                let fill_placement = w.emit_placement_frame(&fill_frame.relative_to(&host_frame), opening_placement);
                let fill_shape = if parts.is_empty() { "$".to_string() } else { format!("#{}", w.emit_parts_shape(&parts, &fill_frame)) };
                let g = w.gid(&format!("fill/{opening_id}"));
                let operation = kind.map(enum_).unwrap_or_else(|| "$".to_string());
                // IFC4: PredefinedType, OperationType/PartitioningType, UserDefined… am Bauteil; IFC2x3 hat nur
                // Höhe und Breite — die Ausführung steht im IfcDoorStyle/IfcWindowStyle (`fill_styles`).
                let tail = if v2 { String::new() } else { format!(",{},{operation},$", enum_(if is_door { "DOOR" } else { "WINDOW" })) };
                let fill_entity = w.add(
                    if is_door { "IFCDOOR" } else { "IFCWINDOW" },
                    format!(
                        "{g},#{},{},$,$,#{fill_placement},{fill_shape},$,{},{}{tail}",
                        w.owner_history,
                        ifc_string(&fill_name),
                        fmt_real(depth),
                        fmt_real(width)
                    ),
                );
                if v2 {
                    let op = kind.unwrap_or("NOTDEFINED").to_string();
                    if let Some((_, _, v)) = w.fill_styles.iter_mut().find(|(d, o, _)| *d == is_door && *o == op) {
                        v.push(fill_entity);
                    } else {
                        w.fill_styles.push((is_door, op, vec![fill_entity]));
                    }
                }
                let g = w.gid(&format!("fills/{opening_id}"));
                w.add(
                    "IFCRELFILLSELEMENT",
                    format!("{g},#{},$,$,#{opening_entity},#{fill_entity}", w.owner_history),
                );
                w.add_to_containment(structure, fill_entity);
                w.elements.insert(format!("fill/{opening_id}"), fill_entity);
                for p in &psets {
                    w.add_pset(p, fill_entity, &format!("fill/{opening_id}"));
                }
            }
            c if c == REC_OPENING_SOLID => {
                let host = r.string()?;
                let structure = r.structure(n_storeys)?;
                let opening_id = r.string()?;
                let is_door = r.flag()?;
                let fill_name = r.string()?;
                let profile = r.pts()?;
                let mut v = [0.0; 10];
                for x in v.iter_mut() {
                    *x = r.f()?;
                }
                let (height, width) = (r.f()?, r.f()?);
                let psets = r.psets()?;
                let mesh = r.mesh()?;
                if v.iter().any(|x| !x.is_finite()) || profile.len() < 3 || profile.iter().any(|q| !(q.0.is_finite() && q.1.is_finite())) {
                    return Err(format!("Öffnungskörper mit NaN/∞ bei {}", r.pos - 1));
                }
                let host_entity = match host.strip_prefix("wall/") {
                    Some(id) => w.walls.get(id).map(|x| x.0),
                    None => w.elements.get(&host).copied(),
                };
                let Some(host_entity) = host_entity else { continue };
                let parent = w.placement_of(structure);
                let polyline = w.emit_closed_polyline(&profile);
                let prof = w.add("IFCARBITRARYCLOSEDPROFILEDEF", format!("{},$,#{polyline}", enum_("AREA")));
                let o = w.add("IFCCARTESIANPOINT", list(&[fmt_real(v[0]), fmt_real(v[1]), fmt_real(v[2])]));
                let xd = w.add("IFCDIRECTION", list(&[fmt_real(v[3]), fmt_real(v[4]), fmt_real(v[5])]));
                let zd = w.add("IFCDIRECTION", list(&[fmt_real(v[6]), fmt_real(v[7]), fmt_real(v[8])]));
                let pos = w.add("IFCAXIS2PLACEMENT3D", format!("#{o},#{zd},#{xd}"));
                let solid = w.add("IFCEXTRUDEDAREASOLID", format!("#{prof},#{pos},#{},{}", w.extrude_dir, fmt_real(v[9].max(0.001))));
                let shape = w.emit_swept_shape(&[solid]);
                let opening_placement = w.emit_placement(0.0, parent);
                let g = w.gid(&format!("opening/{opening_id}"));
                let opening_entity = w.add(
                    "IFCOPENINGELEMENT",
                    format!(
                        "{g},#{},{},$,$,#{opening_placement},#{shape},${}",
                        w.owner_history,
                        ifc_string(if is_door { "Türöffnung" } else { "Fensteröffnung" }),
                        if v2 { String::new() } else { format!(",{}", enum_("OPENING")) }
                    ),
                );
                let g = w.gid(&format!("voids/{opening_id}"));
                w.add("IFCRELVOIDSELEMENT", format!("{g},#{},$,$,#{host_entity},#{opening_entity}", w.owner_history));
                let fill_placement = w.emit_placement(0.0, opening_placement);
                let fill_shape = if mesh.indices.is_empty() {
                    "$".to_string()
                } else {
                    let (item, rep_type) = if w.v2() { w.emit_face_brep(&mesh) } else { (w.emit_face_set(&mesh), "Tessellation") };
                    let rep = w.add("IFCSHAPEREPRESENTATION", format!("#{},{},{},{}", w.context, ifc_string("Body"), ifc_string(rep_type), refs(&[item])));
                    format!("#{}", w.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[rep]))))
                };
                let g = w.gid(&format!("fill/{opening_id}"));
                let tail = if v2 { String::new() } else { format!(",{},$,$", enum_(if is_door { "DOOR" } else { "WINDOW" })) };
                let fill_entity = w.add(
                    if is_door { "IFCDOOR" } else { "IFCWINDOW" },
                    format!("{g},#{},{},$,$,#{fill_placement},{fill_shape},$,{},{}{tail}", w.owner_history, ifc_string(&fill_name), fmt_real(height), fmt_real(width)),
                );
                let g = w.gid(&format!("fills/{opening_id}"));
                w.add("IFCRELFILLSELEMENT", format!("{g},#{},$,$,#{opening_entity},#{fill_entity}", w.owner_history));
                w.add_to_containment(structure, fill_entity);
                w.elements.insert(format!("fill/{opening_id}"), fill_entity);
                for p in &psets {
                    w.add_pset(p, fill_entity, &format!("fill/{opening_id}"));
                }
            }
            c if c == REC_STAIR => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let predefined = r.string()?;
                let pts = r.pts()?;
                let z_rel = r.f()?;
                let depth = r.f()?;
                let psets = r.psets()?;
                let mut flights = Vec::new();
                for _ in 0..r.idx()? {
                    flights.push(r.stair_flight()?);
                }
                let mut landings = Vec::new();
                for _ in 0..r.idx()? {
                    landings.push(r.stair_landing()?);
                }
                let mut rails = Vec::new();
                for _ in 0..r.idx()? {
                    rails.push(r.stair_rail()?);
                }
                let column = if r.flag()? { Some(r.stair_landing()?) } else { None };
                let key = format!("stair/{id}");
                let parent = w.placement_of(structure);
                let g = w.gid(&key);
                let entity = if flights.is_empty() && landings.is_empty() && rails.is_empty() && column.is_none() {
                    // Ohne Teile: ein Ersatzkörper (Fussabdruck) wie bisher.
                    let (placement, shape) = w.emit_box_product(&pts, z_rel, depth, parent);
                    w.emit_building_element("IFCSTAIR", g, "Treppe", placement, shape, Some(enum_(&predefined)))
                } else {
                    // Treppe ohne eigene Darstellung; Läufe, Podest und Geländer hängen per IfcRelAggregates daran.
                    let stair_placement = w.emit_placement(0.0, parent);
                    let stair = w.add(
                        "IFCSTAIR",
                        format!("{g},#{},{},$,$,#{stair_placement},$,$,{}", w.owner_history, ifc_string("Treppe"), enum_(&predefined)),
                    );
                    let mut parts = Vec::new();
                    for (k, f) in flights.iter().enumerate() {
                        let (placement, shape) = match &f.shape {
                            FlightShape::Solids(solids) => {
                                let ids: Vec<usize> = solids.iter().map(|(pts, z, d)| w.emit_extrusion(pts, *z, *d)).collect();
                                let shape = w.emit_swept_shape(&ids);
                                (w.emit_placement(0.0, stair_placement), shape)
                            }
                            FlightShape::Mesh(mesh) => w.emit_triangulated_product(mesh, stair_placement),
                        };
                        let fkey = format!("{key}/flight/{k}");
                        let guid = w.gid(&fkey);
                        // IFC2x3: NumberOfRiser, keine PredefinedType.
                        let flight_type = if v2 { String::new() } else { format!(",{}", enum_(&f.predefined)) };
                        let flight = w.add(
                            "IFCSTAIRFLIGHT",
                            format!(
                                "{guid},#{},{},$,$,#{placement},#{shape},$,{},{},{},{}{flight_type}",
                                w.owner_history,
                                ifc_string(&f.name),
                                f.risers,
                                f.treads,
                                fmt_real(f.riser_height),
                                fmt_real(f.tread_length)
                            ),
                        );
                        for p in &f.psets {
                            w.add_pset(p, flight, &fkey);
                        }
                        parts.push(flight);
                    }
                    for (k, l) in landings.iter().enumerate() {
                        let (placement, shape) = w.emit_box_product(&l.pts, l.z_rel, l.depth, stair_placement);
                        // erstes Podest mit dem bisherigen Schlüssel (stabile GlobalId)
                        let lkey = if k == 0 { format!("{key}/landing") } else { format!("{key}/landing/{k}") };
                        let guid = w.gid(&lkey);
                        let slab = w.emit_building_element("IFCSLAB", guid, &l.name, placement, shape, Some(enum_("LANDING")));
                        for p in &l.psets {
                            w.add_pset(p, slab, &lkey);
                        }
                        parts.push(slab);
                    }
                    for (k, rl) in rails.iter().enumerate() {
                        let (placement, shape) = w.emit_triangulated_product(&rl.mesh, stair_placement);
                        // erstes Geländer mit dem bisherigen Schlüssel (stabile GlobalId)
                        let rkey = if k == 0 { format!("{key}/railing") } else { format!("{key}/railing/{k}") };
                        let guid = w.gid(&rkey);
                        let railing = w.emit_building_element("IFCRAILING", guid, &rl.name, placement, shape, Some(enum_(&rl.predefined)));
                        for p in &rl.psets {
                            w.add_pset(p, railing, &rkey);
                        }
                        parts.push(railing);
                    }
                    if let Some(c) = &column {
                        let (placement, shape) = w.emit_box_product(&c.pts, c.z_rel, c.depth, stair_placement);
                        let ckey = format!("{key}/column");
                        let guid = w.gid(&ckey);
                        let col = w.emit_building_element("IFCCOLUMN", guid, &c.name, placement, shape, Some(enum_("COLUMN")));
                        for p in &c.psets {
                            w.add_pset(p, col, &ckey);
                        }
                        parts.push(col);
                    }
                    let g = w.gid(&format!("aggregates/{key}"));
                    w.add("IFCRELAGGREGATES", format!("{g},#{},$,$,#{stair},{}", w.owner_history, refs(&parts)));
                    stair
                };
                w.add_to_containment(structure, entity);
                w.elements.insert(key.clone(), entity);
                for p in &psets {
                    w.add_pset(p, entity, &key);
                }
            }
            c if c == REC_EXTRUSION => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let pts = r.pts()?;
                let z_rel = r.f()?;
                let depth = r.f()?;
                let (placement, shape) = w.emit_box_product(&pts, z_rel, depth, w.placement_of(structure));
                let g = w.gid(&format!("extrusion/{id}"));
                let entity = w.emit_building_element("IFCBUILDINGELEMENTPROXY", g, "Extrusion", placement, shape, None);
                w.add_to_containment(structure, entity);
                w.elements.insert(format!("extrusion/{id}"), entity);
            }
            c if c == REC_SPACE || c == REC_SPACE_ARC => {
                let arcs = c == REC_SPACE_ARC;
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let long_name = r.string()?;
                let external = r.flag()?;
                let height = r.f()?;
                let z_rel = r.f()?;
                let ceiling_height = r.f()?;
                let pts = if arcs { r.bpts()? } else { r.pts()?.into_iter().map(|p| (p.0, p.1, 0.0)).collect() };
                let net = r.f()?;
                let gross = r.f()?;
                let sia = r.string()?;
                let psets = r.psets()?;
                let (placement, shape) = if arcs {
                    w.emit_box_product_voids_arcs(&pts, &[], z_rel, height, w.placement_of(structure))
                } else {
                    let plain: Vec<(f64, f64)> = pts.iter().map(|p| (p.0, p.1)).collect();
                    w.emit_box_product(&plain, z_rel, height, w.placement_of(structure))
                };
                let g = w.gid(&format!("space/{id}"));
                let space = w.add(
                    "IFCSPACE",
                    format!(
                        "{g},#{},{},$,$,#{placement},#{shape},{},{},{},$",
                        w.owner_history,
                        ifc_string(&name),
                        ifc_string(&long_name),
                        enum_("ELEMENT"),
                        enum_(if external { "EXTERNAL" } else { "INTERNAL" })
                    ),
                );
                w.elements.insert(format!("space/{id}"), space);
                if let Some((_, v)) = w.spaces.iter_mut().find(|(s, _)| *s == structure) {
                    v.push(space);
                } else {
                    w.spaces.push((structure, vec![space]));
                }
                let q_net = w.emit_quantity("IFCQUANTITYAREA", "NetFloorArea", net);
                let q_gross = w.emit_quantity("IFCQUANTITYAREA", "GrossFloorArea", gross);
                let q_height = w.emit_quantity("IFCQUANTITYLENGTH", "Height", height);
                let q_ceiling = w.emit_quantity("IFCQUANTITYLENGTH", "FinishCeilingHeight", ceiling_height);
                let g = w.gid(&format!("space/{id}/qto"));
                let qto = w.add(
                    "IFCELEMENTQUANTITY",
                    format!(
                        "{g},#{},{},$,$,{}",
                        w.owner_history,
                        ifc_string("Qto_SpaceBaseQuantities"),
                        refs(&[q_net, q_gross, q_height, q_ceiling])
                    ),
                );
                let g = w.gid(&format!("space/{id}/qto-rel"));
                w.add(
                    "IFCRELDEFINESBYPROPERTIES",
                    format!("{g},#{},$,$,{},#{qto}", w.owner_history, refs(&[space])),
                );
                let sia_prop = w.add(
                    "IFCPROPERTYSINGLEVALUE",
                    format!("{},$,IFCLABEL({}),$", ifc_string("SIA416"), ifc_string(&sia)),
                );
                let g = w.gid(&format!("space/{id}/pset"));
                let pset = w.add(
                    "IFCPROPERTYSET",
                    format!("{g},#{},{},$,{}", w.owner_history, ifc_string("CH_Raum"), refs(&[sia_prop])),
                );
                let g = w.gid(&format!("space/{id}/pset-rel"));
                w.add(
                    "IFCRELDEFINESBYPROPERTIES",
                    format!("{g},#{},$,$,{},#{pset}", w.owner_history, refs(&[space])),
                );
                for p in &psets {
                    w.add_pset(p, space, &format!("space/{id}"));
                }
            }
            c if c == REC_END_SPACES => {
                let spaces = std::mem::take(&mut w.spaces);
                for (structure, ids) in spaces {
                    let g = w.gid(&format!("aggregates/spaces/{}", w.key_of(structure)));
                    w.add(
                        "IFCRELAGGREGATES",
                        format!("{g},#{},$,$,#{},{}", w.owner_history, w.entity_of(structure), refs(&ids)),
                    );
                }
            }
            c if c == REC_TREE => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let psets = r.psets()?;
                let mesh = r.mesh()?;
                let (placement, shape) = w.emit_triangulated_product(&mesh, w.placement_of(structure));
                let key = format!("tree/{id}");
                let g = w.gid(&key);
                let entity = if w.v2() {
                    w.add("IFCBUILDINGELEMENTPROXY", format!("{g},#{},{},$,{},#{placement},#{shape},$,$", w.owner_history, ifc_string(&name), ifc_string("Baum")))
                } else {
                    w.add("IFCGEOGRAPHICELEMENT", format!("{g},#{},{},$,{},#{placement},#{shape},$,{}", w.owner_history, ifc_string(&name), ifc_string("Baum"), enum_("USERDEFINED")))
                };
                w.add_to_containment(structure, entity);
                w.elements.insert(key.clone(), entity);
                for p in &psets {
                    w.add_pset(p, entity, &key);
                }
            }
            c if c == REC_CONTEXT => {
                // [259] Kontext am IfcSite: Gelände als IfcGeographicElement TERRAIN, Nachbarn als Proxy (IFC2x3: beide Proxy).
                let terrain = r.idx()? == 1;
                let id = r.string()?;
                let name = r.string()?;
                let class = r.string()?;
                let mesh = r.mesh()?;
                let (placement, shape) = w.emit_triangulated_product(&mesh, w.site_placement);
                let key = format!("context/{id}");
                let g = w.gid(&key);
                let description = if class.is_empty() { "$".to_string() } else { ifc_string(&class) };
                let object_type = ifc_string(if terrain { "Gelände" } else { "Kontext" });
                let head = format!("{g},#{},{},{description},{object_type},#{placement},#{shape},$", w.owner_history, ifc_string(&name));
                let entity = if terrain && !w.v2() {
                    w.add("IFCGEOGRAPHICELEMENT", format!("{head},{}", enum_("TERRAIN")))
                } else if w.v2() {
                    w.add("IFCBUILDINGELEMENTPROXY", format!("{head},$"))
                } else {
                    w.add("IFCBUILDINGELEMENTPROXY", format!("{head},{}", enum_("USERDEFINED")))
                };
                w.add_to_containment(SITE, entity);
                w.elements.insert(key, entity);
            }
            c if c == REC_ROOF => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let predefined = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let mesh = r.mesh()?;
                let (placement, shape) = w.emit_triangulated_product(&mesh, w.placement_of(structure));
                w.finish_typed("IFCROOF", format!("roof/{id}"), &name, &ty, &psets, structure, placement, shape, Some(enum_(&predefined)), false);
            }
            c if c == REC_COLUMN || c == REC_COLUMN_PIECES => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let label = r.string()?;
                let pieces: Vec<(Vec<(f64, f64)>, f64, f64)> = if c == REC_COLUMN {
                    let pts = r.pts()?;
                    vec![(pts, r.f()?, r.f()?)]
                } else {
                    let n = r.idx()?;
                    if n == 0 {
                        return Err(format!("Stütze ohne Abschnitte bei {}", r.pos - 1));
                    }
                    let mut v = Vec::new();
                    for _ in 0..n {
                        let pts = r.pts()?;
                        v.push((pts, r.f()?, r.f()?));
                    }
                    v
                };
                let component = r.opt_string()?;
                let component_name = r.opt_string()?;
                let psets = r.psets()?;
                let (placement, shape) = if let [(pts, z_rel, depth)] = pieces.as_slice() {
                    w.emit_box_product(pts, *z_rel, *depth, w.placement_of(structure))
                } else {
                    w.emit_pieces_product(&pieces, w.placement_of(structure))
                };
                let g = w.gid(&format!("column/{id}"));
                let entity = w.emit_building_element("IFCCOLUMN", g, &label, placement, shape, Some(enum_("COLUMN")));
                w.add_to_containment(structure, entity);
                w.elements.insert(format!("column/{id}"), entity);
                for p in &psets {
                    w.add_pset(p, entity, &format!("column/{id}"));
                }
                if let Some(cid) = component {
                    if let Some((_, _, v)) = w.column_materials.iter_mut().find(|(c, _, _)| *c == cid) {
                        v.push(entity);
                    } else {
                        let nm = component_name.unwrap_or_else(|| cid.clone());
                        w.column_materials.push((cid, nm, vec![entity]));
                    }
                }
            }
            c if c == REC_END_COLUMNS => {
                let mats = std::mem::take(&mut w.column_materials);
                for (cid, name, ids) in mats {
                    let g = w.gid(&format!("material/{cid}/columns"));
                    let material = w.material_of(&cid, &name);
                    w.add(
                        "IFCRELASSOCIATESMATERIAL",
                        format!("{g},#{},$,$,{},#{material}", w.owner_history, refs(&ids)),
                    );
                }
            }
            c if c == REC_CLASSIFICATION => {
                let name = r.string()?;
                let source = r.string()?;
                let edition = r.string()?;
                let n = r.idx()?;
                // Je Code in Reihenfolge des ersten Auftretens: (Name der Referenz, Bauteile).
                let mut by_code: Vec<(String, String, Vec<usize>)> = Vec::new();
                for _ in 0..n {
                    let key = r.string()?;
                    let code = r.string()?;
                    let ref_name = r.string()?;
                    if code.is_empty() {
                        continue; // ohne Code keine Referenz
                    }
                    let Some(&entity) = w.elements.get(&key) else { continue };
                    if let Some((_, _, v)) = by_code.iter_mut().find(|(c, _, _)| *c == code) {
                        if !v.contains(&entity) {
                            v.push(entity);
                        }
                    } else {
                        by_code.push((code, ref_name, vec![entity]));
                    }
                }
                if !by_code.is_empty() {
                    let opt = |s: &str| if s.is_empty() { "$".to_string() } else { ifc_string(s) };
                    // IFC2x3: Source und Edition sind Pflicht (leer = ''), keine Description/Location/Tokens.
                    let system = if v2 {
                        w.add("IFCCLASSIFICATION", format!("{},{},$,{}", ifc_string(&source), ifc_string(&edition), ifc_string(&name)))
                    } else {
                        w.add("IFCCLASSIFICATION", format!("{},{},$,{},$,$,$", opt(&source), opt(&edition), ifc_string(&name)))
                    };
                    for (code, ref_name, ids) in by_code {
                        let reference = w.add(
                            "IFCCLASSIFICATIONREFERENCE",
                            if v2 {
                                format!("$,{},{},#{system}", ifc_string(&code), opt(&ref_name))
                            } else {
                                format!("$,{},{},#{system},$,$", ifc_string(&code), opt(&ref_name))
                            },
                        );
                        let g = w.gid(&format!("classification/{name}/{code}"));
                        w.add(
                            "IFCRELASSOCIATESCLASSIFICATION",
                            format!("{g},#{},$,$,{},#{reference}", w.owner_history, refs(&ids)),
                        );
                    }
                }
            }
            c if c == REC_LAYERS => {
                let n = r.idx()?;
                // Je Ebene in Reihenfolge des ersten Auftretens: (Name, Flags, Darstellungen); jede Darstellung nur einmal.
                let mut by_layer: Vec<(String, Vec<usize>)> = Vec::new();
                let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
                let agg = aggregate_children(&w.lines);
                for _ in 0..n {
                    let key = r.string()?;
                    let name = r.string()?;
                    let Some(&entity) = w.elements.get(&key) else { continue };
                    let reps: Vec<usize> = shape_reps_of(&w.lines, &agg, entity).into_iter().filter(|x| seen.insert(*x)).collect();
                    if reps.is_empty() {
                        continue;
                    }
                    if let Some((_, v)) = by_layer.iter_mut().find(|(c, _)| *c == name) {
                        v.extend(reps);
                    } else {
                        by_layer.push((name, reps));
                    }
                }
                for (name, items) in by_layer {
                    // IfcPresentationLayerAssignment: Name, Description, AssignedItems, Identifier
                    w.add("IFCPRESENTATIONLAYERASSIGNMENT", format!("{},$,{},$", ifc_string(&name), refs(&items)));
                }
            }
            c if c == REC_ZONE => {
                let key = r.string()?;
                let name = r.string()?;
                let long_name = r.string()?;
                let n = r.idx()?;
                let mut members = Vec::new();
                for _ in 0..n {
                    let id = r.string()?;
                    if let Some(&e) = w.elements.get(&format!("space/{id}")) {
                        if !members.contains(&e) {
                            members.push(e);
                        }
                    }
                }
                let psets = r.psets()?;
                if members.is_empty() {
                    continue;
                }
                let zone_key = format!("zone/{key}");
                let g = w.gid(&zone_key);
                // IFC2x3: IfcZone hat kein LongName — der lange Name steht dort als Beschreibung.
                let zone = w.add(
                    "IFCZONE",
                    if v2 {
                        format!("{g},#{},{},{},$", w.owner_history, ifc_string(&name), ifc_string(&long_name))
                    } else {
                        format!("{g},#{},{},$,$,{}", w.owner_history, ifc_string(&name), ifc_string(&long_name))
                    },
                );
                let g = w.gid(&format!("{zone_key}/spaces"));
                w.add(
                    "IFCRELASSIGNSTOGROUP",
                    format!("{g},#{},$,$,{},$,#{zone}", w.owner_history, refs(&members)),
                );
                w.elements.insert(zone_key.clone(), zone);
                for p in &psets {
                    w.add_pset(p, zone, &zone_key);
                }
            }
            c if c == REC_GRID => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let (n_u, n_v) = (r.idx()?, r.idx()?);
                let mut axes = Vec::new();
                for _ in 0..n_u + n_v {
                    let tag = r.string()?;
                    let pts = r.pts()?;
                    let curve = w.emit_open_polyline(&pts);
                    axes.push(w.add("IFCGRIDAXIS", format!("{},#{curve},.T.", ifc_string(&tag))));
                }
                let placement = w.emit_placement(0.0, w.placement_of(structure));
                let g = w.gid(&format!("grid/{id}"));
                let u = refs(&axes[..n_u]);
                let v = refs(&axes[n_u..]);
                let entity = w.add(
                    "IFCGRID",
                    format!("{g},#{},{},$,$,#{placement},$,{u},{v},$", w.owner_history, ifc_string(&name)),
                );
                w.add_to_containment(structure, entity);
                w.elements.insert(format!("grid/{id}"), entity);
            }
            c if c == REC_GUIDS => {
                let n = r.idx()?;
                let mut used: std::collections::HashSet<String> = w.guid_override.values().cloned().collect();
                for _ in 0..n {
                    let key = r.string()?;
                    let guid = r.string()?;
                    // Nur gültige, bisher unbenutzte GlobalIds; sonst bleibt es bei der abgeleiteten.
                    if valid_guid(&guid) && used.insert(guid.clone()) {
                        w.guid_override.insert(key, guid);
                    }
                }
            }
            c if c == REC_ATTACH => {
                let key = r.string()?;
                let psets = r.psets()?;
                if let Some(&entity) = w.elements.get(&key) {
                    for p in &psets {
                        w.add_pset(p, entity, &key);
                    }
                }
            }
            other => return Err(format!("unbekannter Datensatz {other} ({}) bei {}", rec_name(other), r.pos - 1)),
        }
    }

    // ── Typ-Zuordnung (je Bauteiltyp eine IfcRelDefinesByType) ──
    let types = std::mem::take(&mut w.types);
    for t in &types {
        if t.occurrences.is_empty() {
            continue;
        }
        if t.type_id == 0 {
            // IFC2x3 ohne Typ (Dach): Schichten direkt am Bauteil.
            if t.layer_set != 0 {
                let g = w.gid(&format!("{}/occurrences/material", t.key));
                w.add(
                    "IFCRELASSOCIATESMATERIAL",
                    format!("{g},#{},$,$,{},#{}", w.owner_history, refs(&t.occurrences), t.layer_set),
                );
            }
            continue;
        }
        let g = w.gid(&format!("{}/occurrences", t.key));
        w.add(
            "IFCRELDEFINESBYTYPE",
            format!("{g},#{},$,$,{},#{}", w.owner_history, refs(&t.occurrences), t.type_id),
        );
    }

    // ── IFC2x3: Türen/Fenster mit IfcDoorStyle/IfcWindowStyle (Ausführung als Attribut des Styles) ──
    let fill_styles = std::mem::take(&mut w.fill_styles);
    for (is_door, op, occurrences) in &fill_styles {
        let (class, label) = if *is_door { ("IFCDOORSTYLE", "Tür") } else { ("IFCWINDOWSTYLE", "Fenster") };
        let key = format!("style/{}/{op}", if *is_door { "door" } else { "window" });
        let g = w.gid(&key);
        let name = if op == "NOTDEFINED" { label.to_string() } else { format!("{label} {op}") };
        // Tür: OperationType, ConstructionType; Fenster: ConstructionType, OperationType (Reihenfolge je Schema).
        let (first, second) = if *is_door { (enum_(op), enum_("NOTDEFINED")) } else { (enum_("NOTDEFINED"), enum_(op)) };
        let style = w.add(
            class,
            format!("{g},#{},{},$,$,$,$,$,{first},{second},.F.,.F.", w.owner_history, ifc_string(&name)),
        );
        let g = w.gid(&format!("{key}/occurrences"));
        w.add(
            "IFCRELDEFINESBYTYPE",
            format!("{g},#{},$,$,{},#{style}", w.owner_history, refs(occurrences)),
        );
    }

    // ── Eigenschaftssätze ──
    let psets = std::mem::take(&mut w.psets);
    for ps in &psets {
        let mut prop_ids = Vec::new();
        for (n, v) in &ps.props {
            prop_ids.push(w.add("IFCPROPERTYSINGLEVALUE", format!("{},$,{v},$", ifc_string(n))));
        }
        let g = w.gid(&format!("pset/{}", ps.key));
        let pset_id = w.add(
            "IFCPROPERTYSET",
            format!("{g},#{},{},$,{}", w.owner_history, ifc_string(&ps.name), refs(&prop_ids)),
        );
        let g = w.gid(&format!("pset/{}/rel", ps.key));
        w.add(
            "IFCRELDEFINESBYPROPERTIES",
            format!("{g},#{},$,$,{},#{pset_id}", w.owner_history, refs(&ps.related)),
        );
    }

    // ── Basismengen (je Bauteil ein IfcElementQuantity) ──
    let qtos = std::mem::take(&mut w.qtos);
    for q in &qtos {
        let mut ids = Vec::with_capacity(q.quantities.len());
        for (ty, name, value) in &q.quantities {
            // IFC verlangt Mengen ≥ 0.
            ids.push(w.emit_quantity(ty, name, value.max(0.0)));
        }
        let g = w.gid(&format!("{}/{}", q.owner_key, q.name));
        let set = w.add("IFCELEMENTQUANTITY", format!("{g},#{},{},$,$,{}", w.owner_history, ifc_string(&q.name), refs(&ids)));
        let g = w.gid(&format!("{}/{}/rel", q.owner_key, q.name));
        w.add("IFCRELDEFINESBYPROPERTIES", format!("{g},#{},$,$,{},#{set}", w.owner_history, refs(&[q.element])));
    }

    // ── Räumliche Eingliederung (gebündelt je Trägerstruktur) ──
    let containment = std::mem::take(&mut w.containment);
    for (structure, ids) in &containment {
        let g = w.gid(&format!("contains/{}", w.key_of(*structure)));
        w.add(
            "IFCRELCONTAINEDINSPATIALSTRUCTURE",
            format!("{g},#{},$,$,{},#{}", w.owner_history, refs(ids), w.entity_of(*structure)),
        );
    }

    // ── Kopf + Zusammenbau ──
    let file_name = format!("{}.ifc", pname("modell"));
    let mut out = String::with_capacity(w.lines.iter().map(|l| l.len() + 1).sum::<usize>() + 512);
    out.push_str("ISO-10303-21;\nHEADER;\n");
    let description = if v2 { "ViewDefinition [CoordinationView_V2.0]" } else { "" };
    out.push_str(&format!("FILE_DESCRIPTION({},{});\n", list(&[ifc_string(description)]), ifc_string("2;1")));
    out.push_str(&format!(
        "FILE_NAME({},{},{},{},{},{},{});\n",
        ifc_string(&file_name),
        ifc_string(&iso),
        list(&[ifc_string(if anon { "" } else { "dossier" })]),
        list(&[ifc_string(if anon { "" } else { "dossier" })]),
        ifc_string(if anon { "" } else { "dossier" }),
        ifc_string(if anon { "" } else { "dossier" }),
        ifc_string("")
    ));
    out.push_str(&format!("FILE_SCHEMA(('{}'));\nENDSEC;\n\nDATA;\n", if v2 { "IFC2X3" } else { "IFC4" }));
    for l in &w.lines {
        out.push_str(l);
        out.push('\n');
    }
    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    Ok(out)
}

// ---------------------------------------------------------------------------
// WASM-Fassade (nur bei Feature "web")
// ---------------------------------------------------------------------------

#[cfg(feature = "web")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// Flache Bauteilliste → IFC4-Text (STEP); leer bei kaputtem Puffer (Grund: `export_ifc_check_flat`).
    #[wasm_bindgen]
    pub fn export_ifc_flat(flat: &[f64], strings: &str) -> String {
        super::build_ifc(flat, strings).unwrap_or_default()
    }

    /// Fehlertext zur Eingabe (leer = in Ordnung) — für Meldungen auf der TS-Seite.
    #[wasm_bindgen]
    pub fn export_ifc_check_flat(flat: &[f64], strings: &str) -> String {
        match super::build_ifc(flat, strings) {
            Ok(_) => String::new(),
            Err(e) => e,
        }
    }

    /// Deterministische 22-stellige IFC-GUID aus einem Namen.
    #[wasm_bindgen]
    pub fn ifc_guid(name: &str) -> String {
        super::ifc_guid(name)
    }

    /// STEP-String-Literal (mit Apostrophen, `\X2\`/`\X4\` für Nicht-ASCII).
    #[wasm_bindgen]
    pub fn ifc_string(s: &str) -> String {
        super::ifc_string(s)
    }
}
