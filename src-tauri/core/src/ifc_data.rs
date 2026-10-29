//! IFC-Export: Sammler im Kern ([K4] S2, [B5]; vorher `src/export/exportIfc.ts`, `ifcOpenings.ts`,
//! `ifcClassification.ts`). Liest das Projekt-Dokument und erzeugt den flachen Puffer, den der
//! Schreiber in `src-tauri/fileio/src/ifc_export.rs` zur STEP-Datei macht (Kodierung dort im Kopf,
//! FLAT_VERSION 4). TS gibt nur noch Optionen (Schema, Klassifikation) und den Zeitstempel weiter und
//! reicht die Bytes an `fileio` (zwei WASM-Module, keine gemischten Crates).
//!
//! Abbildung (Einzelheiten im Kopf von `ifc_export.rs` und in `TODO.md` [B5]):
//!   • Geschosse: je "floor"-Ebene ein IfcBuildingStorey; Bauteile mit verwaister Geschoss-id hängen
//!     am Gebäude (Struktur −1, Basis 0).
//!   • Wand: Schicht-Bänder wie im 3D (`emit_walls`). Extrusion je Band + IfcOpeningElement, wenn das
//!     exakt dasselbe ergibt wie das 3D (`bands_match_openings`), sonst öffnungsgenaues Netz
//!     (`wall_cut_mesh`, Achsentausch mit Wicklungsumkehr, Closed nach `is_watertight`).
//!   • Decke, Öffnung (Füllungs-Parameter für `ifc_openings.rs`), Treppe (`ifc_stairs.rs`),
//!     Extrusion, Raum (SIA 416), Zonen, Geschoss-Kennwerte, Dach (Schicht-Netze wie im 3D), Stütze.
//!   • Basismengen (`ifc_quantities.rs`), Psets nur mit Modellwerten.
//!   • Klassifikation (Option): eBKP-H-Hauptgruppen je Bauteilart (Quelle CRB, SN 506 511:2020;
//!     Wand/Decke/Stütze/Treppe = C, Dach = F, Fenster = E, Tür und Raum ohne — nicht geraten) und/oder
//!     die Ebene des Modells als System „Dossier-Ebenen" (Code = `categoryCode`, Name = Ebenenname).
//!     Das Modell führt KEINEN eBKP-H-Code; `categoryCode` ist die Grafik-Ebene.
//! Georeferenz: mit `geoAnchor` liegt die ganze Geometrie in LV95 (`geo_rebase`).
//! Zahlsemantik und Reihenfolge wie die frühere TS-Fassung: die Dateien bleiben zeichengleich.

use crate::export_flat::{js_trim, Flat};
use crate::geo_rebase::{lv95_to_wgs84, project_to_world_coords};
use crate::ifc_quantities::{self as qty, Cutout, Qty, QtyKind};
use crate::ifc_stairs::{stair_parts, FlightBody, StairParts};
use crate::jsmath::hypot2;
use crate::jsnum::{max, min};
use crate::model::*;
use crate::model3d::{self, RWall};
use crate::wall_mesh_cut::{is_watertight, wall_cut_mesh_checked, CutWall};
use std::collections::HashMap;

const FLAT_VERSION: f64 = 4.0;
const REC_WALL_SOLIDS: f64 = 1.0;
const REC_WALL_MESH: f64 = 2.0;
const REC_CEILING: f64 = 3.0;
const REC_OPENING: f64 = 4.0;
const REC_STAIR: f64 = 5.0;
const REC_EXTRUSION: f64 = 6.0;
const REC_SPACE: f64 = 7.0;
const REC_END_SPACES: f64 = 8.0;
const REC_ROOF: f64 = 9.0;
const REC_COLUMN: f64 = 10.0;
const REC_END_COLUMNS: f64 = 11.0;
const REC_CLASSIFICATION: f64 = 12.0;
const REC_ZONE: f64 = 13.0;
const REC_ATTACH: f64 = 14.0;

/// Toleranz des Kerns (`wall_bands.rs::EPS`) für „Öffnung trifft Band".
const BAND_EPS: f64 = 1e-4;
/// Wie weit der Öffnungskörper beidseits über die Wandflächen vorsteht (keine koplanaren Booleans).
const OPENING_OVERSHOOT: f64 = 0.02;

/// Optionen des IFC-Exports.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IfcOptions {
    /// IFC2x3 statt IFC4.
    pub ifc2x3: bool,
    /// eBKP-H-Hauptgruppen je Bauteilart.
    pub ebkph: bool,
    /// `categoryCode` als System „Dossier-Ebenen".
    pub layer_codes: bool,
    /// Zeitstempel (Sekunden seit 1970) und dieselbe Zeit als ISO-Text ohne Sekundenbruchteil.
    pub now: f64,
    pub iso: String,
}

// ── Puffer-Bausteine (Reihenfolge der Aufrufe = Reihenfolge der Zeichenketten) ─────────────────

/// Pset-Eigenschaft (0 IfcIdentifier, 1 IfcBoolean, 2 IfcPositiveRatioMeasure, 3–5 Mengen, 6 IfcLabel,
/// 7 IfcThermalTransmittanceMeasure).
enum Prop {
    Ident(&'static str, String),
    Bool(&'static str, bool),
    Ratio(&'static str, f64),
    /// IfcLabel (Freitext wie Feuerwiderstand).
    Label(&'static str, String),
    /// IfcThermalTransmittanceMeasure, W/(m²K).
    Thermal(&'static str, f64),
    Qty(&'static str, QtyKind, f64),
}

struct Pset {
    name: &'static str,
    props: Vec<Prop>,
}

struct TypeRef<'a> {
    kind: f64,
    id: &'a str,
    name: &'a str,
    predefined: &'a str,
    layers: Vec<(&'a str, &'a str, f64)>,
}

/// Typ (id, Name, Schichten: Bauteil-id, Bauteilname, Dicke) als Datensatz-Verweis.
type TypeData = (String, String, Vec<(String, String, f64)>);

fn type_ref<'a>(t: &'a TypeData, kind: f64, predefined: &'a str) -> TypeRef<'a> {
    TypeRef { kind, id: &t.0, name: &t.1, predefined, layers: t.2.iter().map(|(a, b, c)| (a.as_str(), b.as_str(), *c)).collect() }
}

/// `IsExternal`/`LoadBearing` für Wand und Decke, nur mit Angabe im Modell.
fn structure_props(external: Option<bool>, load_bearing: Option<bool>) -> Vec<Prop> {
    let mut v = Vec::new();
    v.extend(external.map(|e| Prop::Bool("IsExternal", e)));
    v.extend(load_bearing.map(|b| Prop::Bool("LoadBearing", b)));
    v
}

fn ident(name: &'static str, v: &str) -> Prop {
    Prop::Ident(name, v.to_string())
}

/// Basismengen als Pset `Qto_…` (nur wenn Mengen vorliegen).
fn qto(name: &'static str, quantities: Vec<Qty>) -> Vec<Pset> {
    if quantities.is_empty() {
        return vec![];
    }
    vec![Pset { name, props: quantities.into_iter().map(|q| Prop::Qty(q.name, q.kind, q.value)).collect() }]
}

fn w_pts(f: &mut Flat, pts: &[Vec2]) {
    f.num(pts.len() as f64);
    for p in pts {
        f.nums(&[p.x, p.y]);
    }
}

fn w_mesh(f: &mut Flat, positions: &[f64], indices: &[u32], closed: bool) {
    f.num((positions.len() / 3) as f64).nums(positions);
    f.num((indices.len() / 3) as f64);
    for &i in indices {
        f.num(i as f64);
    }
    f.num(if closed { 1.0 } else { 0.0 });
}

fn w_type(f: &mut Flat, t: Option<&TypeRef>) {
    let Some(t) = t else {
        f.num(0.0);
        return;
    };
    let (id, name, pre) = (f.str(t.id), f.str(t.name), f.str(t.predefined));
    f.nums(&[1.0, t.kind, id, name, pre, t.layers.len() as f64]);
    for &(cid, cname, thickness) in &t.layers {
        let (a, b) = (f.str(cid), f.str(cname));
        f.nums(&[a, b, thickness]);
    }
}

fn w_psets(f: &mut Flat, list: &[Pset]) {
    f.num(list.len() as f64);
    for ps in list {
        let n = f.str(ps.name);
        f.nums(&[n, ps.props.len() as f64]);
        for p in &ps.props {
            match p {
                Prop::Ident(name, v) => {
                    let (a, b) = (f.str(name), f.str(v));
                    f.nums(&[a, 0.0, b]);
                }
                Prop::Bool(name, v) => {
                    let a = f.str(name);
                    f.nums(&[a, 1.0, if *v { 1.0 } else { 0.0 }]);
                }
                Prop::Ratio(name, v) => {
                    let a = f.str(name);
                    f.nums(&[a, 2.0, *v]);
                }
                Prop::Label(name, v) => {
                    let (a, b) = (f.str(name), f.str(v));
                    f.nums(&[a, 6.0, b]);
                }
                Prop::Thermal(name, v) => {
                    let a = f.str(name);
                    f.nums(&[a, 7.0, *v]);
                }
                Prop::Qty(name, kind, v) => {
                    let a = f.str(name);
                    let code = match kind {
                        QtyKind::Length => 3.0,
                        QtyKind::Area => 4.0,
                        QtyKind::Volume => 5.0,
                    };
                    f.nums(&[a, code, *v]);
                }
            }
        }
    }
}

/// Kopf eines Bauteil-Datensatzes: `[art, struktur, id, name]`.
fn w_head(f: &mut Flat, rec: f64, structure: f64, id: &str, name: &str) {
    let (a, b) = (f.str(id), f.str(name));
    f.nums(&[rec, structure, a, b]);
}

// ── Geometrie-Helfer (Welt-Meter) ───────────────────────────────────────────

fn sub(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 { x: a.x - b.x, y: a.y - b.y }
}
fn normalize(v: Vec2) -> Vec2 {
    let l = hypot2(v.x, v.y);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    Vec2 { x: v.x / l, y: v.y / l }
}
fn left_normal(u: Vec2) -> Vec2 {
    Vec2 { x: -u.y, y: u.x }
}
fn add_scaled(p: Vec2, d: Vec2, s: f64) -> Vec2 {
    Vec2 { x: p.x + d.x * s, y: p.y + d.y * s }
}
fn dot(a: Vec2, b: Vec2) -> f64 {
    a.x * b.x + a.y * b.y
}
fn v2(p: [f64; 2]) -> Vec2 {
    Vec2 { x: p[0], y: p[1] }
}

/// Rechteck `[from,to]` entlang der Wandachse × `[n_lo,n_hi]` quer dazu (Welt-XY, CCW).
fn axis_rect(wall: &Wall, from: f64, to: f64, n_lo: f64, n_hi: f64) -> Vec<Vec2> {
    let u = normalize(sub(wall.end, wall.start));
    let n = left_normal(u);
    let a = add_scaled(wall.start, u, from);
    let b = add_scaled(wall.start, u, to);
    vec![add_scaled(a, n, n_lo), add_scaled(b, n, n_lo), add_scaled(b, n, n_hi), add_scaled(a, n, n_hi)]
}

/// Sortierung `byFrom` (Anfang, dann Unterkante; NaN gilt als gleich wie in `Array.sort`).
fn by_from(p: &[f64; 4], q: &[f64; 4]) -> std::cmp::Ordering {
    let d = p[0] - q[0];
    let d = if d != 0.0 && !d.is_nan() { d } else { p[2] - q[2] };
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

/// Ob die Schicht-Bänder einer Wand exakt „Quader minus Öffnungen" sind: kein Band mit schräger
/// Oberkante, und jedes Band trägt genau die Öffnungen als Löcher, die es in der Höhe trifft — in
/// derselben Grösse. Dann ergibt Extrusion je Band minus IfcOpeningElement denselben Körper wie das 3D.
fn bands_match_openings(wall: &Wall, bands: &[&RWall], cutouts: &[Cutout]) -> bool {
    let u = normalize(sub(wall.end, wall.start));
    for b in bands {
        if b.top_drop.is_some_and(|d| d[0].abs() > 1e-9 || d[1].abs() > 1e-9) {
            return false;
        }
        let a = dot(Vec2 { x: b.start[0] - wall.start.x, y: b.start[1] - wall.start.y }, u);
        let zb = b.base_elevation;
        let zt = b.base_elevation + b.height;
        let mut expected: Vec<[f64; 4]> =
            cutouts.iter().filter(|h| h.z_top > zb + BAND_EPS && h.z_bottom < zt - BAND_EPS).map(|h| [h.from - a, h.to - a, h.z_bottom, h.z_top]).collect();
        expected.sort_by(by_from);
        let mut actual: Vec<[f64; 4]> = b.holes.as_deref().unwrap_or(&[]).iter().map(|h| [h.from, h.to, h.z_bottom, h.z_top]).collect();
        actual.sort_by(by_from);
        if expected.len() != actual.len() {
            return false;
        }
        for (e, x) in expected.iter().zip(&actual) {
            for k in 0..4 {
                if !((e[k] - x[k]).abs() <= 1e-6) {
                    return false;
                }
            }
        }
    }
    true
}

/// Ausdehnung aller Bänder quer zur Wandachse (entlang der linken Normalen ab `wall.start`).
fn cross_extent(wall: &Wall, bands: &[&RWall]) -> (f64, f64) {
    let n = left_normal(normalize(sub(wall.end, wall.start)));
    let (mut n_lo, mut n_hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for b in bands {
        let off = dot(Vec2 { x: b.start[0] - wall.start.x, y: b.start[1] - wall.start.y }, n);
        n_lo = min(n_lo, off - b.thickness / 2.0);
        n_hi = max(n_hi, off + b.thickness / 2.0);
    }
    (n_lo, n_hi)
}

/// Vereinfachter Bounding-Footprint einer Treppe (gerade: Lauf-Rechteck; sonst achsparallele Box der
/// Kontrollpunkte bzw. des Wendel-Kreises, um die halbe Laufbreite erweitert).
fn stair_footprint(st: &Stair) -> Vec<Vec2> {
    let half_w = max(st.width, 0.0) / 2.0;
    if st.shape == StairShape::Straight {
        let u = normalize(st.dir);
        let n = left_normal(u);
        let end = add_scaled(st.start, u, st.run_length);
        return vec![add_scaled(st.start, n, -half_w), add_scaled(end, n, -half_w), add_scaled(end, n, half_w), add_scaled(st.start, n, half_w)];
    }
    let truthy = |v: Option<f64>| v.filter(|x| *x != 0.0 && !x.is_nan());
    let mut pts = vec![st.start];
    let u = normalize(st.dir);
    let corner = add_scaled(st.start, u, st.run_length);
    pts.push(corner);
    if st.shape == StairShape::L {
        if let (Some(run2), Some(turn)) = (truthy(st.run2_length), truthy(st.turn)) {
            let n = left_normal(u);
            pts.push(add_scaled(corner, Vec2 { x: n.x * turn, y: n.y * turn }, run2));
        }
    }
    if st.shape == StairShape::Spiral {
        if let Some(c) = st.center {
            let r = st.radius.unwrap_or(0.0) + half_w;
            return vec![Vec2 { x: c.x - r, y: c.y - r }, Vec2 { x: c.x + r, y: c.y - r }, Vec2 { x: c.x + r, y: c.y + r }, Vec2 { x: c.x - r, y: c.y + r }];
        }
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in &pts {
        min_x = min(min_x, p.x);
        min_y = min(min_y, p.y);
        max_x = max(max_x, p.x);
        max_y = max(max_y, p.y);
    }
    min_x -= half_w;
    min_y -= half_w;
    max_x += half_w;
    max_y += half_w;
    vec![Vec2 { x: min_x, y: min_y }, Vec2 { x: max_x, y: min_y }, Vec2 { x: max_x, y: max_y }, Vec2 { x: min_x, y: max_y }]
}

fn roof_predefined(s: RoofShape) -> &'static str {
    match s {
        RoofShape::Flach => "FLAT_ROOF",
        RoofShape::Pult => "SHED_ROOF",
        RoofShape::Sattel => "GABLE_ROOF",
        RoofShape::Walm => "HIP_ROOF",
        RoofShape::Mansarde => "MANSARD_ROOF",
        RoofShape::Zelt => "HIPPED_GABLE_ROOF",
        RoofShape::Unknown => "NOTDEFINED",
    }
}

// ── Türen und Fenster (Parameter für `fileio/src/ifc_openings.rs`) ─────────────────────────────


/// Ein Eintrag der Flügeltabelle (`SashDef`): Pfosten?, Pfostenbreite, feste Breite?, Breite.
#[derive(Debug, Clone, PartialEq)]
struct FillSash {
    post: bool,
    post_width: Option<f64>,
    fixed: bool,
    width: Option<f64>,
}

/// Parameter der Füllung einer Öffnung (Kodierung FILL im Kopf von `ifc_export.rs`), aus Typ und
/// Öffnung; fehlende Typwerte bleiben „keine", die Standardmasse kennt nur `fileio`.
#[derive(Debug, Clone, PartialEq)]
struct FillParams {
    frame_depth: Option<f64>,
    inset: Option<f64>,
    inset_outside: bool,
    frame_width: Option<f64>,
    /// Fenster: Flügelzahl, Scheiben (1–3), Flügeltabelle.
    wing_count: f64,
    panes: f64,
    sashes: Vec<FillSash>,
    /// Tür: 0 Dreh, 1 Schiebe (auch Hebeschiebe), 2 reine Wandöffnung, 3 Pendel.
    door_kind: f64,
    leaf_count: f64,
    /// +1 Aufschlag links der Achse, −1 rechts; Richtung +1 innen, −1 aussen.
    swing_sign: f64,
    dir_sign: f64,
    hinge_at_start: bool,
    transom_height: f64,
    glazed: bool,
    glazing_ratio: Option<f64>,
}

fn fill_params(p: &Project, o: &Opening) -> FillParams {
    let is_door = o.kind == ElementKind::Door;
    let dt = if is_door { p.door_type(o) } else { None };
    let wt = if is_door { None } else { p.window_type(o) };
    FillParams {
        frame_depth: dt.map_or(wt.and_then(|t| t.frame_depth), |t| t.frame_depth),
        inset: dt.map_or(wt.and_then(|t| t.inset_from_face), |t| t.inset_from_face),
        inset_outside: match (dt, wt) {
            (Some(t), _) => matches!(t.inset_face, None | Some(DoorTypeInsetFace::Aussen)),
            (None, Some(t)) => matches!(t.inset_face, None | Some(WindowTypeInsetFace::Aussen)),
            _ => true,
        },
        frame_width: dt.map_or(wt.and_then(|t| t.frame_width), |t| t.frame_width),
        wing_count: o.wing_count.or(wt.map(|t| t.wing_count)).unwrap_or(1.0),
        panes: wt.map_or(2.0, |t| match t.glazing_panes {
            Some(v) if v != 0.0 && !v.is_nan() => v,
            _ => match t.glazing {
                WindowTypeGlazing::Dreifach => 3.0,
                WindowTypeGlazing::Zweifach => 2.0,
                _ => 1.0,
            },
        }),
        sashes: wt
            .and_then(|t| t.sashes.as_deref())
            .unwrap_or(&[])
            .iter()
            .map(|s| FillSash { post: s.kind == SashDefKind::Pfosten, post_width: s.post_width, fixed: s.auto_width == Some(false), width: s.width })
            .collect(),
        // Türart: Typ vor Öffnung.
        door_kind: match dt.map(|t| t.kind) {
            Some(DoorTypeKind::Schiebe | DoorTypeKind::Hebeschiebe) => 1.0,
            Some(DoorTypeKind::Pendel) => 3.0,
            Some(DoorTypeKind::Wandoeffnung) => 2.0,
            Some(_) => 0.0,
            None if o.door_type == Some(OpeningDoorType::Wandoeffnung) => 2.0,
            None => 0.0,
        },
        leaf_count: dt.map_or(1.0, |t| t.leaf_count),
        swing_sign: if matches!(o.swing, None | Some(SwingSide::Left)) { 1.0 } else { -1.0 },
        dir_sign: if matches!(o.opening_dir, None | Some(OpeningOpeningDir::In)) { 1.0 } else { -1.0 },
        hinge_at_start: matches!(o.hinge, None | Some(OpeningHinge::Start)),
        transom_height: dt.and_then(|t| t.transom_height).unwrap_or(0.0),
        glazed: dt.is_some_and(|t| t.leaf_style == DoorTypeLeafStyle::Glas),
        glazing_ratio: dt.and_then(|t| t.glazing_ratio),
    }
}

/// FILL schreiben: Wandachse, Achs-Intervall und Höhen der Öffnung, Querausdehnung der Wand
/// (`host` = n_lo aussen, n_hi), dann die Parameter.
fn w_fill(f: &mut Flat, wall: &Wall, c: &Cutout, host: (f64, f64), x: &FillParams) {
    let opt = |f: &mut Flat, v: Option<f64>| {
        f.nums(&[if v.is_some() { 1.0 } else { 0.0 }, v.unwrap_or(0.0)]);
    };
    let flag = |b: bool| if b { 1.0 } else { 0.0 };
    f.nums(&[wall.start.x, wall.start.y, wall.end.x, wall.end.y, c.from, c.to, c.z_bottom, c.z_top, host.0, host.1]);
    opt(f, x.frame_depth);
    opt(f, x.inset);
    f.num(flag(x.inset_outside));
    opt(f, x.frame_width);
    f.nums(&[x.wing_count, x.panes, x.sashes.len() as f64]);
    for s in &x.sashes {
        f.num(flag(s.post));
        opt(f, s.post_width);
        f.num(flag(s.fixed));
        opt(f, s.width);
    }
    f.nums(&[x.door_kind, x.leaf_count, x.swing_sign, x.dir_sign, flag(x.hinge_at_start), x.transom_height, flag(x.glazed)]);
    opt(f, x.glazing_ratio);
}

/// Ebene (Code, Name) eines Bauteils als Klassifikation; ohne Code `None`, ohne bekannte Ebene der
/// Code als Name.
fn layer_classification(p: &Project, category_code: &str) -> Option<(String, String)> {
    let code = js_trim(category_code);
    if code.is_empty() {
        return None;
    }
    Some((code.to_string(), p.layer_category(code).map_or(code, |l| l.name.as_str()).to_string()))
}


// ── Klassifikation ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Wall,
    Slab,
    Roof,
    Column,
    Stair,
    Window,
    Door,
    Space,
}

/// eBKP-H-Hauptgruppe zur Bauteilart, oder `None` (Tür, Raum: nicht eindeutig).
fn ebkph_group(k: Kind) -> Option<(&'static str, &'static str)> {
    match k {
        Kind::Wall | Kind::Slab | Kind::Column | Kind::Stair => Some(("C", "Konstruktion Gebäude")),
        Kind::Roof => Some(("F", "Bedachung Gebäude")),
        Kind::Window => Some(("E", "Äussere Wandbekleidung Gebäude")),
        Kind::Door | Kind::Space => None,
    }
}

fn w_classification(f: &mut Flat, system: (&str, &str, &str), refs: &[(String, String, String)]) {
    if refs.is_empty() {
        return;
    }
    let (a, b, c) = (f.str(system.0), f.str(system.1), f.str(system.2));
    f.nums(&[REC_CLASSIFICATION, a, b, c, refs.len() as f64]);
    for (key, code, name) in refs {
        let (a, b, c) = (f.str(key), f.str(code), f.str(name));
        f.nums(&[a, b, c]);
    }
}

fn sia_key(c: SiaCategory) -> String {
    serde_json::to_value(c).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn sia_label(key: &str) -> &'static str {
    match key {
        "HNF" => "Hauptnutzfläche",
        "NNF" => "Nebennutzfläche",
        "VF" => "Verkehrsfläche",
        "FF" => "Funktionsfläche",
        "KGF" => "Konstruktionsfläche",
        "AGF" => "Aussengeschossfläche",
        _ => "",
    }
}

const SIA_CATEGORIES: [SiaCategory; 6] = [SiaCategory::HNF, SiaCategory::NNF, SiaCategory::VF, SiaCategory::FF, SiaCategory::KGF, SiaCategory::AGF];

/// Der flache IFC-Puffer aus dem Projekt (s. Modulkopf).
pub fn ifc_export_data(src: &Project, opt: &IfcOptions) -> Result<Flat, String> {
    // Georeferenziert: die ganze Geometrie auf die echten LV95-Koordinaten (ohne Bezug unverändert).
    let mut p = project_to_world_coords(src);
    let mut f = Flat::new(FLAT_VERSION);

    // Je "floor"-Ebene ein IfcBuildingStorey (Elevation = baseElevation).
    let floors: Vec<DrawingLevel> = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).cloned().collect();
    let mut storey_of: HashMap<&str, usize> = HashMap::new();
    let storey_base: Vec<f64> = floors.iter().map(|l| l.base_elevation.unwrap_or(0.0)).collect();
    for (i, fl) in floors.iter().enumerate() {
        storey_of.insert(fl.id.as_str(), i);
    }
    let structure_of = |floor_id: &str| -> f64 { storey_of.get(floor_id).map_or(-1.0, |&i| i as f64) };
    let base_of = |structure: f64| -> f64 { if structure < 0.0 { 0.0 } else { storey_base[structure as usize] } };

    // Kopf: RefElevation = reale Datumshöhe (informativ), RefLatitude/-Longitude des Bezugspunkts.
    let anchor = p.geo_anchor.clone();
    let lat_lon = anchor.as_ref().map(|a| (a.lv95.e, a.lv95.n)).filter(|(e, n)| e.is_finite() && n.is_finite()).map(|(e, n)| lv95_to_wgs84(e, n)).filter(|(la, lo)| la.is_finite() && lo.is_finite());
    let (pid, pname) = (f.str(&p.id), f.str(&p.name));
    let iso = f.str(&opt.iso);
    f.nums(&[
        pid,
        pname,
        opt.now,
        iso,
        if anchor.is_some() { 1.0 } else { 0.0 },
        anchor.as_ref().and_then(|a| a.height).unwrap_or(f64::NAN),
        lat_lon.map_or(f64::NAN, |x| x.0),
        lat_lon.map_or(f64::NAN, |x| x.1),
        if opt.ifc2x3 { 1.0 } else { 0.0 },
        floors.len() as f64,
    ]);
    for (i, fl) in floors.iter().enumerate() {
        let (a, b) = (f.str(&fl.id), f.str(&fl.name));
        f.nums(&[a, b, storey_base[i]]);
    }

    // Klassifikation: je geschriebenem Bauteil Schlüssel (wie für die GUID), Art und Ebene; `fileio`
    // überspringt Schlüssel ohne geschriebenes Bauteil.
    let mut classified: Vec<(String, Kind, String)> = Vec::new();

    let component_name = |p: &Project, id: &str| -> String { p.component(id).map_or_else(|| id.to_string(), |c| c.name.clone()) };

    // ── Wände ──────────────────────────────────────────────────────────────
    let all_bands = model3d::emit_walls(&p, true)?;
    let mut bands_by_wall: HashMap<&str, Vec<&RWall>> = HashMap::new();
    for b in &all_bands {
        bands_by_wall.entry(b.wall_id.as_str()).or_default().push(b);
    }
    let no_bands: Vec<&RWall> = Vec::new();
    let mut host_extent: HashMap<String, (f64, f64)> = HashMap::new();
    let mut cutouts_by_wall: HashMap<String, Vec<(usize, Cutout)>> = HashMap::new();
    let mut mesh_walls: Vec<usize> = Vec::new();
    let openings: Vec<Opening> = p.openings.clone().unwrap_or_default();
    let wall_ident = |p: &Project, wall: &Wall, quantities: Vec<Qty>| -> (String, Option<TypeData>, Vec<Pset>) {
        let q = qto("Qto_WallBaseQuantities", quantities);
        // Aussen/tragend nur mit Angabe im Modell (nichts erfunden).
        let mut props: Vec<Prop> = Vec::new();
        match p.wall_type(wall) {
            Some(wt) => {
                let layers = wt.layers.iter().map(|l| (l.component_id.clone(), component_name(p, &l.component_id), l.thickness)).collect();
                props.push(ident("Reference", &wt.name));
                props.extend(structure_props(wall.is_external, wall.load_bearing));
                let mut ps = vec![Pset { name: "Pset_WallCommon", props }];
                ps.extend(q);
                (wt.name.clone(), Some((wt.id.clone(), wt.name.clone(), layers)), ps)
            }
            None => {
                props.extend(structure_props(wall.is_external, wall.load_bearing));
                let mut ps = if props.is_empty() { Vec::new() } else { vec![Pset { name: "Pset_WallCommon", props }] };
                ps.extend(q);
                (wall.id.clone(), None, ps)
            }
        }
    };
    let cutouts_of = |p: &Project, wall: &Wall| -> Vec<(usize, Cutout)> {
        let mut out = Vec::new();
        let (zb, zt) = p.wall_vertical_extent(wall);
        let axis = hypot2(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
        for (k, o) in openings.iter().enumerate().filter(|(_, o)| o.host_wall_id == wall.id) {
            let from = max(0.0, min(o.position, axis));
            let to = max(from, min(o.position + o.width, axis));
            if to - from < 1e-4 {
                continue;
            }
            let bottom = zb + max(0.0, o.sill_height);
            let top = min(zt, bottom + o.height);
            out.push((k, Cutout { from, to, z_bottom: bottom, z_top: top }));
        }
        out
    };

    for (wi, wall) in p.walls.iter().enumerate() {
        let all = bands_by_wall.get(wall.id.as_str()).unwrap_or(&no_bands);
        let bands: Vec<&RWall> = all.iter().copied().filter(|b| hypot2(b.end[0] - b.start[0], b.end[1] - b.start[1]) > 1e-9 && b.height > 1e-9 && b.thickness > 1e-9).collect();
        if bands.is_empty() {
            continue; // degenerierte Wand / keine Geometrie
        }
        let cutouts = cutouts_of(&p, wall);
        let plain: Vec<Cutout> = cutouts.iter().map(|x| x.1).collect();
        cutouts_by_wall.insert(wall.id.clone(), cutouts);
        classified.push((format!("wall/{}", wall.id), Kind::Wall, wall.category_code.clone()));
        if !bands_match_openings(wall, &bands, &plain) {
            mesh_walls.push(wi);
            continue;
        }
        let structure = structure_of(&wall.floor_id);
        let (name, ty, psets) = wall_ident(&p, wall, qty::wall_quantities(wall.start, wall.end, &bands, &plain, None));
        // Wandsystem: Placement am Wandanfang, X = Achse, Y = linke Normale; IfcMaterialLayerSetUsage nur,
        // wenn die Typ-Schichten den Querschnitt der Bänder füllen (sonst wäre der Offset gelogen).
        let extent = cross_extent(wall, &bands);
        let layer_sum = ty.as_ref().map_or(0.0, |t| t.2.iter().fold(0.0, |a, l| a + l.2));
        let usage = ty.is_some() && layer_sum > 0.0 && (extent.1 - extent.0 - layer_sum).abs() < 1e-3;
        w_head(&mut f, REC_WALL_SOLIDS, structure, &wall.id, &name);
        w_type(&mut f, ty.as_ref().map(|t| type_ref(t, 0.0, "STANDARD")).as_ref());
        w_psets(&mut f, &psets);
        let u = normalize(sub(wall.end, wall.start));
        f.nums(&[1.0, wall.start.x, wall.start.y, u.x, u.y, hypot2(wall.end.x - wall.start.x, wall.end.y - wall.start.y), if usage { 1.0 } else { 0.0 }, if usage { extent.0 } else { 0.0 }]);
        f.num(bands.len() as f64);
        let base = base_of(structure);
        for b in &bands {
            let (s, e) = (v2(b.start), v2(b.end));
            let n = left_normal(normalize(sub(e, s)));
            let h = b.thickness / 2.0;
            w_pts(&mut f, &[add_scaled(s, n, -h), add_scaled(e, n, -h), add_scaled(e, n, h), add_scaled(s, n, h)]);
            f.nums(&[b.base_elevation - base, b.height]);
        }
        host_extent.insert(wall.id.clone(), extent);
    }
    // Netz-Weg: alle Bänder einer Wand zu EINEM Face-Set; Modell-Welt (x, Höhe, y) → IFC (x, y, z),
    // die Spiegelung kehrt die Wicklung um, daher (a, c, b). Z relativ zur Geschoss-UK.
    for &wi in &mesh_walls {
        let wall = &p.walls[wi];
        let structure = structure_of(&wall.floor_id);
        let base = base_of(structure);
        let bands = bands_by_wall.get(wall.id.as_str()).unwrap_or(&no_bands);
        let (mut positions, mut indices) = (Vec::<f64>::new(), Vec::<u32>::new());
        for b in bands {
            let cut = wall_cut_mesh_checked(&CutWall {
                start: b.start,
                end: b.end,
                thickness: b.thickness,
                base_elevation: b.base_elevation,
                height: b.height,
                holes: b.holes.as_deref().unwrap_or(&[]).iter().map(|h| [h.from, h.to, h.z_bottom, h.z_top]).collect(),
            });
            let at = (positions.len() / 3) as u32;
            for c in cut.chunks_exact(3) {
                positions.extend_from_slice(&[c[0], c[2], c[1] - base]);
            }
            let n = (cut.len() / 3) as u32;
            let mut i = 0;
            while i + 2 < n {
                indices.extend_from_slice(&[at + i, at + i + 2, at + i + 1]);
                i += 3;
            }
        }
        if indices.is_empty() {
            continue;
        }
        // Closed nur, wenn das Netz nachweislich dicht und aussen orientiert ist.
        let closed = is_watertight(&positions, &indices, 1e-6);
        let net = closed.then(|| crate::export_flat::mesh_volume(&positions, &indices));
        let plain: Vec<Cutout> = cutouts_by_wall.get(&wall.id).map_or_else(Vec::new, |v| v.iter().map(|x| x.1).collect());
        let mut quantities = qty::wall_quantities(wall.start, wall.end, bands, &plain, net);
        if net.is_none() {
            let gross = quantities.iter().find(|x| x.name == "GrossVolume").map_or(f64::NAN, |x| x.value);
            if let Some(nv) = quantities.iter_mut().find(|x| x.name == "NetVolume") {
                nv.value = max(0.0, gross - qty::hole_volume(bands));
            }
        }
        let (name, ty, psets) = wall_ident(&p, wall, quantities);
        w_head(&mut f, REC_WALL_MESH, structure, &wall.id, &name);
        w_type(&mut f, ty.as_ref().map(|t| type_ref(t, 0.0, "STANDARD")).as_ref());
        w_psets(&mut f, &psets);
        w_mesh(&mut f, &positions, &indices, closed);
        host_extent.insert(wall.id.clone(), cross_extent(wall, bands));
    }

    // ── Decken ─────────────────────────────────────────────────────────────
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        if c.outline.len() < 3 {
            continue;
        }
        let (z_bottom, z_top) = p.ceiling_vertical_extent(c);
        let structure = structure_of(&c.floor_id);
        classified.push((format!("slab/{}", c.id), Kind::Slab, c.category_code.clone()));
        let mut name = c.id.clone();
        let mut ty: Option<TypeData> = None;
        let mut psets: Vec<Pset> = Vec::new();
        let mut slab_props: Vec<Prop> = Vec::new();
        if let Some((id, tname, layers)) = model3d::ceiling_type_ref(&p, c) {
            name = tname.to_string();
            ty = Some((id.to_string(), tname.to_string(), layers.iter().map(|l| (l.component_id.clone(), component_name(&p, &l.component_id), l.thickness)).collect()));
            slab_props.push(ident("Reference", tname));
        }
        slab_props.extend(structure_props(c.is_external, c.load_bearing));
        if !slab_props.is_empty() {
            psets.push(Pset { name: "Pset_SlabCommon", props: slab_props });
        }
        // Aussparungen (wie im 3D) als innere Ringe des Profils; Netto zieht sie ab.
        let inner: Vec<&[Vec2]> = c.openings.as_deref().unwrap_or(&[]).iter().filter(|r| r.len() >= 3).map(|r| r.as_slice()).collect();
        psets.extend(qto("Qto_SlabBaseQuantities", qty::slab_quantities(&c.outline, &inner, z_top - z_bottom)));
        w_head(&mut f, REC_CEILING, structure, &c.id, &name);
        w_type(&mut f, ty.as_ref().map(|t| type_ref(t, 1.0, "FLOOR")).as_ref());
        w_psets(&mut f, &psets);
        w_pts(&mut f, &c.outline);
        f.num(inner.len() as f64);
        for r in &inner {
            w_pts(&mut f, r);
        }
        f.nums(&[z_bottom - base_of(structure), z_top - z_bottom]);
    }

    // ── Öffnungen: IfcOpeningElement in der Wand, IfcDoor/IfcWindow darin ───
    for wall in &p.walls {
        let Some(&host) = host_extent.get(&wall.id) else { continue };
        let structure = structure_of(&wall.floor_id);
        for &(k, c) in cutouts_by_wall.get(&wall.id).map_or(&[][..], |v| v.as_slice()) {
            let o = &openings[k];
            let depth = c.z_top - c.z_bottom;
            if !(depth > 1e-6) {
                continue;
            }
            let is_door = o.kind == ElementKind::Door;
            classified.push((format!("fill/{}", o.id), if is_door { Kind::Door } else { Kind::Window }, o.category_code.clone()));
            let mut props: Vec<Prop> = Vec::new();
            let pset_name = if is_door {
                let dt = p.door_type(o);
                if let Some(dt) = dt {
                    props.push(ident("Reference", &dt.name));
                    if dt.leaf_style == DoorTypeLeafStyle::Glas {
                        if let Some(ratio) = dt.glazing_ratio.filter(|r| *r > 0.0 && *r <= 1.0) {
                            props.push(Prop::Ratio("GlazingAreaFraction", ratio));
                        }
                    }
                }
                "Pset_DoorCommon"
            } else {
                if let Some(wt) = p.window_type(o) {
                    props.push(ident("Reference", &wt.name));
                }
                "Pset_WindowCommon"
            };
            // Nummer ersetzt den Typnamen als Reference; Kennwerte nur mit Angabe im Modell.
            if let Some(mark) = o.mark.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
                props.retain(|x| !matches!(x, Prop::Ident("Reference", _)));
                props.insert(0, ident("Reference", mark));
            }
            if let Some(e) = crate::opening_schedule::opening_external(&p, o) {
                props.push(Prop::Bool("IsExternal", e));
            }
            let label = |name: &'static str, v: &Option<String>| v.as_deref().map(str::trim).filter(|x| !x.is_empty()).map(|x| Prop::Label(name, x.to_string()));
            props.extend(label("FireRating", &o.fire_rating));
            props.extend(label("AcousticRating", &o.sound_class));
            props.extend(o.u_value.filter(|u| *u > 0.0).map(|u| Prop::Thermal("ThermalTransmittance", u)));
            props.extend(label("SecurityRating", &o.burglary_class));
            let mut psets = vec![Pset { name: pset_name, props }];
            psets.extend(qto(if is_door { "Qto_DoorBaseQuantities" } else { "Qto_WindowBaseQuantities" }, qty::opening_quantities(c.to - c.from, depth)));
            let label = crate::plan::walls::opening_label(o);
            let a = f.str(&wall.id);
            let oid = f.str(&o.id);
            let lab = f.str(&label);
            f.nums(&[REC_OPENING, a, structure, oid, if is_door { 1.0 } else { 0.0 }, lab]);
            w_pts(&mut f, &axis_rect(wall, c.from, c.to, host.0 - OPENING_OVERSHOOT, host.1 + OPENING_OVERSHOOT));
            f.nums(&[c.z_bottom - base_of(structure), depth, c.to - c.from]);
            w_fill(&mut f, wall, &c, host, &fill_params(&p, o));
            w_psets(&mut f, &psets);
        }
    }

    // ── Treppen: Läufe, Podest, Geländer wie im 3D; ohne Teile der Fussabdruck-Quader ──
    let stairs = p.stairs.take();
    for st in stairs.as_deref().unwrap_or(&[]) {
        let footprint = stair_footprint(st);
        if footprint.len() < 3 {
            continue;
        }
        let (z_bottom, z_top) = p.stair_vertical_extent(st);
        let structure = structure_of(&st.floor_id);
        classified.push((format!("stair/{}", st.id), Kind::Stair, st.category_code.clone()));
        let predefined = match st.shape {
            StairShape::Straight => "STRAIGHT_RUN_STAIR",
            StairShape::Spiral => "SPIRAL_STAIR",
            _ => "QUARTER_TURN_STAIR",
        };
        let base = base_of(structure);
        p.stairs = Some(vec![st.clone()]);
        let parts = stair_parts(&p, st, base);
        w_stair(&mut f, structure, &st.id, predefined, &footprint, z_bottom - base, z_top - z_bottom, &parts);
    }
    p.stairs = stairs;

    // ── Extrudierte Körper → IfcBuildingElementProxy ───────────────────────
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.points.len() < 3 {
            continue;
        }
        let base = floors.iter().find(|fl| fl.id == s.level_id).and_then(|fl| fl.base_elevation).unwrap_or(0.0);
        let structure = structure_of(&s.level_id);
        let id = f.str(&s.id);
        f.nums(&[REC_EXTRUSION, structure, id]);
        w_pts(&mut f, &s.points);
        f.nums(&[base - base_of(structure), s.height]);
    }

    // ── Räume → IfcSpace (im Geschoss aggregiert), Basismengen, SIA-416-Kategorie ──
    let mut room_areas: Vec<(String, String, SiaCategory, f64)> = Vec::new();
    for room in p.rooms.as_deref().unwrap_or(&[]) {
        if room.boundary.len() < 3 {
            continue;
        }
        let structure = structure_of(&room.floor_id);
        let height = floors.iter().find(|fl| fl.id == room.floor_id).and_then(|fl| fl.floor_height).filter(|h| *h != 0.0 && !h.is_nan() && *h > 0.0).unwrap_or(2.5);
        let external = room.sia_category == SiaCategory::AGF;
        let ring: Vec<[f64; 2]> = room.boundary.iter().map(|v| [v.x, v.y]).collect();
        let area = crate::room_area::evaluate(&ring, 0.0);
        room_areas.push((room.id.clone(), room.floor_id.clone(), room.sia_category, area.net));
        classified.push((format!("space/{}", room.id), Kind::Space, room.category_code.clone()));
        let number = room.stamp.as_ref().and_then(|s| s.number.as_deref()).filter(|n| !n.is_empty());
        let mut common: Vec<Prop> = Vec::new();
        if let Some(n) = number {
            common.push(ident("Reference", n));
        }
        common.push(Prop::Bool("IsExternal", external));
        let (id, name, long) = (f.str(&room.id), f.str(number.unwrap_or(&room.id)), f.str(&room.name));
        f.nums(&[REC_SPACE, structure, id, name, long, if external { 1.0 } else { 0.0 }, height]);
        w_pts(&mut f, &room.boundary);
        let cat = f.str(&sia_key(room.sia_category));
        f.nums(&[area.net, area.gross, cat]);
        w_psets(&mut f, &[Pset { name: "Pset_SpaceCommon", props: common }]);
    }
    f.num(REC_END_SPACES);

    // SIA 416: je vorkommender Kategorie eine IfcZone mit den Räumen.
    for cat in SIA_CATEGORIES {
        let members: Vec<&(String, String, SiaCategory, f64)> = room_areas.iter().filter(|r| r.2 == cat).collect();
        if members.is_empty() {
            continue;
        }
        let net = members.iter().fold(0.0, |a, r| a + r.3);
        let key = sia_key(cat);
        let (k, n, l) = (f.str(&format!("sia416/{key}")), f.str(&key), f.str(sia_label(&key)));
        f.nums(&[REC_ZONE, k, n, l, members.len() as f64]);
        for r in &members {
            let id = f.str(&r.0);
            f.num(id);
        }
        w_psets(
            &mut f,
            &[
                Pset { name: "CH_Zone", props: vec![ident("SIA416", &key)] },
                Pset { name: "CH_Qto_SIA416", props: vec![Prop::Qty("NetFloorArea", QtyKind::Area, max(0.0, net))] },
            ],
        );
    }
    // Geschoss-Kennwerte: GF/NGF als Basismenge des IfcBuildingStorey, alle SIA-416-Flächen als CH_Qto_SIA416.
    for fl in &floors {
        let rooms: Vec<(usize, f64)> = room_areas.iter().filter(|r| r.1 == fl.id).map(|r| (SIA_CATEGORIES.iter().position(|c| *c == r.2).unwrap_or(usize::MAX), r.3)).collect();
        if rooms.is_empty() {
            continue;
        }
        let b = crate::room_area::balance(&rooms);
        let by_key = |k: &str| -> f64 {
            match k {
                "NF" => b.agg_area[0],
                "NGF" => b.agg_area[1],
                "GF" => b.agg_area[2],
                _ => crate::room_area::CATEGORIES.iter().position(|c| *c == k).map_or(0.0, |i| b.leaf_area[i]),
            }
        };
        let key = f.str(&format!("storey/{}", fl.id));
        f.nums(&[REC_ATTACH, key]);
        w_psets(
            &mut f,
            &[
                Pset {
                    name: "Qto_BuildingStoreyBaseQuantities",
                    props: vec![Prop::Qty("GrossFloorArea", QtyKind::Area, max(0.0, by_key("GF"))), Prop::Qty("NetFloorArea", QtyKind::Area, max(0.0, by_key("NGF")))],
                },
                Pset {
                    name: "CH_Qto_SIA416",
                    props: ["HNF", "NNF", "NF", "VF", "FF", "NGF", "KGF", "AGF", "GF"].iter().map(|k| Prop::Qty(k, QtyKind::Area, max(0.0, by_key(k)))).collect(),
                },
            ],
        );
    }

    // ── Dächer → IfcRoof (Schicht-Netze wie im 3D, ein Face-Set je Dach, Modell ist Z-oben) ──
    let roofs = p.roofs.take();
    for roof in roofs.as_deref().unwrap_or(&[]) {
        let structure = structure_of(&roof.floor_id);
        let base = base_of(structure);
        classified.push((format!("roof/{}", roof.id), Kind::Roof, roof.category_code.clone()));
        p.roofs = Some(vec![roof.clone()]);
        let meshes = model3d::emit_roofs(&p, None)?;
        let (mut positions, mut indices) = (Vec::<f64>::new(), Vec::<u32>::new());
        for m in &meshes {
            let at = (positions.len() / 3) as u32;
            for c in m.positions.chunks_exact(3) {
                positions.extend_from_slice(&[c[0], c[1], c[2] - base]);
            }
            indices.extend(m.indices.iter().map(|i| at + i));
        }
        if indices.is_empty() {
            continue;
        }
        let mut closed = is_watertight(&positions, &indices, 1e-6);
        if !closed {
            let flipped: Vec<u32> = indices.chunks_exact(3).flat_map(|t| [t[0], t[2], t[1]]).collect();
            if is_watertight(&positions, &flipped, 1e-6) {
                indices = flipped;
                closed = true;
            }
        }
        let predefined = roof_predefined(roof.shape);
        let roof_type = roof.roof_type_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.roof_types.as_deref().unwrap_or(&[]).iter().find(|t| t.id == id));
        // Ein Dach ist Gebäudehülle: IsExternal folgt aus der Bauteilart.
        let mut props: Vec<Prop> = Vec::new();
        if let Some(t) = roof_type {
            props.push(ident("Reference", &t.name));
        }
        props.push(Prop::Bool("IsExternal", true));
        let planes = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof)).planes;
        let mut psets = vec![Pset { name: "Pset_RoofCommon", props }];
        psets.extend(qto("Qto_RoofBaseQuantities", qty::roof_quantities(&planes)));
        let ty = roof_type.map(|t| (t.id.clone(), t.name.clone(), t.layers.iter().map(|l| (l.component_id.clone(), component_name(&p, &l.component_id), l.thickness)).collect::<Vec<_>>()));
        let (id, name, pre) = (f.str(&roof.id), f.str(roof_type.map_or("Dach", |t| t.name.as_str())), f.str(predefined));
        f.nums(&[REC_ROOF, structure, id, name, pre]);
        w_type(&mut f, ty.as_ref().map(|t| type_ref(t, 2.0, predefined)).as_ref());
        w_psets(&mut f, &psets);
        w_mesh(&mut f, &positions, &indices, closed);
    }
    p.roofs = roofs;

    // ── Stützen → IfcColumn (Profil-Extrusion, Material = Bauteil) ──────────
    for col in p.columns.as_deref().unwrap_or(&[]) {
        let footprint = model3d::column_footprint(col);
        if footprint.len() < 3 {
            continue;
        }
        let (z_bottom, z_top) = p.column_vertical_extent(col);
        if !(z_top > z_bottom) {
            continue;
        }
        let structure = structure_of(&col.floor_id);
        classified.push((format!("column/{}", col.id), Kind::Column, col.category_code.clone()));
        let label = crate::plan::domains::column_label(col);
        let mut psets = vec![Pset { name: "Pset_ColumnCommon", props: vec![ident("Reference", &label)] }];
        psets.extend(qto("Qto_ColumnBaseQuantities", qty::column_quantities(&footprint, z_top - z_bottom)));
        let (id, lab) = (f.str(&col.id), f.str(&label));
        f.nums(&[REC_COLUMN, structure, id, lab]);
        w_pts(&mut f, &footprint);
        let comp = col.component_id.as_deref().filter(|s| !s.is_empty());
        let cid = comp.map_or(-1.0, |c| f.str(c));
        let cname = comp.map_or(-1.0, |c| {
            let n = component_name(&p, c);
            f.str(&n)
        });
        f.nums(&[z_bottom - base_of(structure), z_top - z_bottom, cid, cname]);
        w_psets(&mut f, &psets);
    }
    f.num(REC_END_COLUMNS);

    // ── Klassifikation (Optionen), am Ende: alle Bauteile sind geschrieben ──
    if opt.ebkph {
        let refs: Vec<(String, String, String)> =
            classified.iter().filter_map(|(key, kind, _)| ebkph_group(*kind).map(|(c, n)| (key.clone(), c.to_string(), n.to_string()))).collect();
        w_classification(&mut f, ("eBKP-H", "CRB Schweizerische Zentralstelle für Baurationalisierung", "SN 506 511:2020"), &refs);
    }
    if opt.layer_codes {
        let refs: Vec<(String, String, String)> =
            classified.iter().filter_map(|(key, _, code)| layer_classification(&p, code).map(|(c, n)| (key.clone(), c, n))).collect();
        w_classification(&mut f, ("Dossier-Ebenen", "Dossier", ""), &refs);
    }
    Ok(f)
}

#[allow(clippy::too_many_arguments)]
fn w_stair(f: &mut Flat, structure: f64, id: &str, predefined: &str, footprint: &[Vec2], z_rel: f64, depth: f64, parts: &StairParts) {
    let (a, b) = (f.str(id), f.str(predefined));
    f.nums(&[REC_STAIR, structure, a, b]);
    w_pts(f, footprint);
    f.nums(&[z_rel, depth]);
    w_psets(f, &[]);
    f.num(parts.flights.len() as f64);
    for fl in &parts.flights {
        let n = f.str(&fl.name);
        f.nums(&[n, fl.risers, fl.treads, fl.riser_height, fl.tread_length]);
        let p = f.str(fl.predefined);
        f.num(p);
        w_psets(f, &qto("Qto_StairFlightBaseQuantities", fl.quantities.clone()));
        match &fl.body {
            FlightBody::Mesh(m) => {
                f.num(1.0);
                w_mesh(f, &m.positions, &m.indices, false);
            }
            FlightBody::Solids(solids) => {
                f.nums(&[0.0, solids.len() as f64]);
                for s in solids {
                    w_pts(f, &s.pts);
                    f.nums(&[s.z_rel, s.depth]);
                }
            }
        }
    }
    match &parts.landing {
        Some(l) => {
            let n = f.str("Podest");
            f.nums(&[1.0, n]);
            w_pts(f, &l.pts);
            f.nums(&[l.z_rel, l.depth]);
            w_psets(f, &qto("Qto_SlabBaseQuantities", l.quantities.clone()));
        }
        None => {
            f.num(0.0);
        }
    }
    match &parts.rail {
        Some(r) => {
            let (n, pre) = (f.str("Handlauf"), f.str("HANDRAIL"));
            f.nums(&[1.0, n, pre]);
            w_psets(f, &qto("Qto_RailingBaseQuantities", r.quantities.clone()));
            w_mesh(f, &r.mesh.positions, &r.mesh.indices, false);
        }
        None => {
            f.num(0.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export_flat::from_bytes;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    fn strings(f: &Flat) -> Vec<String> {
        let (_, text) = from_bytes(&f.to_bytes()).unwrap();
        text.split('\0').map(String::from).collect()
    }

    #[test]
    fn beispielprojekt_alle_bauteile() {
        let opt = IfcOptions { ebkph: true, layer_codes: true, now: 1.0, iso: "2026-10-29T10:00:00".into(), ..Default::default() };
        let f = ifc_export_data(&sample(), &opt).unwrap();
        assert_eq!(f.nums[0], FLAT_VERSION);
        let s = strings(&f);
        for want in ["W1", "Pset_WallCommon", "Qto_WallBaseQuantities", "Pset_DoorCommon", "Qto_SlabBaseQuantities", "Qto_StairFlightBaseQuantities", "Pset_RoofCommon", "sia416/HNF", "storey/eg", "eBKP-H", "Dossier-Ebenen", "Wände"] {
            assert!(s.iter().any(|x| x == want), "fehlt: {want}");
        }
    }

    #[test]
    fn georeferenz_verschiebt_und_setzt_breite() {
        let mut p = sample();
        p.geo_anchor = Some(ProjectGeoAnchor { lv95: ProjectGeoAnchorLv95 { e: 2_683_000.0, n: 1_247_000.0, ..Default::default() }, model: Vec2 { x: 0.0, y: 0.0 }, height: Some(400.0), ..Default::default() });
        let f = ifc_export_data(&p, &IfcOptions::default()).unwrap();
        // Kopf: [Version, id, name, now, iso, hasGeo, refElevation, lat, lon, schema, nStoreys …]
        assert_eq!(f.nums[5], 1.0);
        assert_eq!(f.nums[6], 400.0);
        assert!((f.nums[7] - 47.37).abs() < 0.1 && (f.nums[8] - 8.54).abs() < 0.1, "{} {}", f.nums[7], f.nums[8]);
        assert!(f.nums.iter().any(|v| *v > 2_683_000.0));
    }

    #[test]
    fn leeres_projekt_und_unbekannter_wandtyp() {
        let mut p = Project { id: "leer".into(), ..Default::default() };
        let f = ifc_export_data(&p, &IfcOptions::default()).unwrap();
        assert_eq!(f.nums.last(), Some(&REC_END_COLUMNS));
        // Hängender Wandtyp (Datei/Import): Export mit dem Rückfall-Typ statt Abbruch.
        p = sample();
        p.walls[0].wall_type_id = "fehlt".into();
        let f = ifc_export_data(&p, &IfcOptions::default()).unwrap();
        assert_eq!(f.nums.last(), Some(&REC_END_COLUMNS));
    }

    #[test]
    fn treppen_fussabdruck() {
        let st = Stair { shape: StairShape::Spiral, center: Some(Vec2 { x: 1.0, y: 1.0 }), radius: Some(1.0), width: 1.0, ..Default::default() };
        assert_eq!(stair_footprint(&st)[0], Vec2 { x: -0.5, y: -0.5 });
        let st = Stair { shape: StairShape::Straight, dir: Vec2 { x: 0.0, y: 2.0 }, run_length: 3.0, width: 1.0, ..Default::default() };
        assert_eq!(stair_footprint(&st)[2], Vec2 { x: -0.5, y: 3.0 });
    }

    fn opening(kind: ElementKind, type_id: Option<&str>) -> Opening {
        Opening { id: "O".into(), host_wall_id: "W".into(), kind, position: 1.0, width: 1.2, height: 1.2, type_id: type_id.map(String::from), ..Default::default() }
    }

    #[test]
    fn fenster_parameter_aus_typ_und_oeffnung() {
        let mut p = Project::default();
        p.window_types = Some(vec![WindowType {
            id: "wt".into(),
            kind: OpeningKind::Dreh,
            wing_count: 3.0,
            glazing: WindowTypeGlazing::Dreifach,
            frame_width: Some(0.09),
            frame_depth: Some(0.1),
            inset_from_face: Some(0.05),
            inset_face: Some(WindowTypeInsetFace::Innen),
            sashes: Some(vec![
                SashDef { kind: SashDefKind::Fluegel, auto_width: Some(false), width: Some(0.5), ..Default::default() },
                SashDef { kind: SashDefKind::Pfosten, post_width: Some(0.1), ..Default::default() },
                SashDef { kind: SashDefKind::Fluegel, ..Default::default() },
            ]),
            ..Default::default()
        }]);
        let o = Opening { wing_count: Some(2.0), ..opening(ElementKind::Window, Some("wt")) };
        let x = fill_params(&p, &o);
        assert_eq!((x.frame_depth, x.frame_width, x.inset, x.inset_outside, x.wing_count, x.panes), (Some(0.1), Some(0.09), Some(0.05), false, 2.0, 3.0));
        assert_eq!(
            x.sashes,
            vec![
                FillSash { post: false, post_width: None, fixed: true, width: Some(0.5) },
                FillSash { post: true, post_width: Some(0.1), fixed: false, width: None },
                FillSash { post: false, post_width: None, fixed: false, width: None },
            ]
        );
        // Ohne Typ: nichts vom Typ, zwei Scheiben, ein Flügel.
        let x = fill_params(&p, &opening(ElementKind::Window, None));
        assert_eq!((x.frame_depth, x.inset_outside, x.wing_count, x.panes, x.sashes.len()), (None, true, 1.0, 2.0, 0));
    }

    #[test]
    fn tuer_parameter() {
        let mut p = Project::default();
        let dt = |kind| DoorType { id: "dt".into(), kind, leaf_count: 2.0, leaf_style: DoorTypeLeafStyle::Glas, glazing_ratio: Some(0.36), transom_height: Some(0.4), ..Default::default() };
        p.door_types = Some(vec![dt(DoorTypeKind::Schiebe)]);
        let o = Opening { hinge: Some(OpeningHinge::End), swing: Some(SwingSide::Right), opening_dir: Some(OpeningOpeningDir::Out), ..opening(ElementKind::Door, Some("dt")) };
        let x = fill_params(&p, &o);
        assert_eq!((x.door_kind, x.leaf_count, x.swing_sign, x.dir_sign, x.hinge_at_start, x.transom_height, x.glazed, x.glazing_ratio), (1.0, 2.0, -1.0, -1.0, false, 0.4, true, Some(0.36)));
        let x = fill_params(&p, &opening(ElementKind::Door, None));
        assert_eq!((x.door_kind, x.leaf_count, x.swing_sign, x.dir_sign, x.hinge_at_start, x.transom_height, x.glazed), (0.0, 1.0, 1.0, 1.0, true, 0.0, false));
        let wo = Opening { door_type: Some(OpeningDoorType::Wandoeffnung), ..opening(ElementKind::Door, None) };
        assert_eq!(fill_params(&p, &wo).door_kind, 2.0);
        p.door_types = Some(vec![dt(DoorTypeKind::Wandoeffnung)]);
        assert_eq!(fill_params(&p, &opening(ElementKind::Door, Some("dt"))).door_kind, 2.0);
    }

    #[test]
    fn klassifikation_ebkph_und_ebenen() {
        assert_eq!(ebkph_group(Kind::Wall), Some(("C", "Konstruktion Gebäude")));
        for k in [Kind::Slab, Kind::Column, Kind::Stair] {
            assert_eq!(ebkph_group(k).map(|g| g.0), Some("C"));
        }
        assert_eq!(ebkph_group(Kind::Roof), Some(("F", "Bedachung Gebäude")));
        assert_eq!(ebkph_group(Kind::Window), Some(("E", "Äussere Wandbekleidung Gebäude")));
        assert_eq!(ebkph_group(Kind::Door), None);
        assert_eq!(ebkph_group(Kind::Space), None);
        let p = sample();
        assert_eq!(layer_classification(&p, "20").map(|x| x.0), Some("20".to_string()));
        assert_eq!(layer_classification(&p, "25").map(|x| x.1), Some("Stützen".to_string()));
        assert_eq!(layer_classification(&p, "777"), Some(("777".to_string(), "777".to_string())));
        assert_eq!(layer_classification(&p, ""), None);
        assert_eq!(layer_classification(&p, " "), None);
    }
}
