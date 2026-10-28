// IFC-Import als Mesh ([B3], erste Stufe von [25]): liest aus einer IFC-Datei (IFC2x3, IFC4, IFC4.3)
// je Bauteil (IfcProduct mit Körper-Darstellung) GlobalId, Klasse, Name, Geschoss, Farbe und
// Dreiecke in Metern (Weltkoordinaten der Datei, Z = Höhe). Daraus werden auf der TS-Seite
// importierte Kontext-Meshes (`src/io/ifcImport.ts`); echte Bauteile erkennt auf Wunsch
// `ifc_semantic.rs` ([B4], `import_ifc_opts(…, true)`), sie fehlen dann unter den Meshes.
//
// Eigener Code (nichts aus BIMCraft `import.rs` übernommen; BIMCraft rechnet in mm, hier Meter).
//
// Unterstützt:
//   - Platzierung: IfcLocalPlacement-Ketten mit IfcAxis2Placement3D/2D, IfcGridPlacement (Schnittpunkt
//     der versetzten Rasterachsen, `ifc_brep.rs`).
//   - Körper: IfcExtrudedAreaSolid, IfcFacetedBrep(+WithVoids), IfcShellBasedSurfaceModel,
//     IfcFaceBasedSurfaceModel, IfcTriangulatedFaceSet, IfcPolygonalFaceSet, IfcMappedItem
//     (IfcCartesianTransformationOperator3D, auch ungleichmässig), IfcBlock, IfcCsgSolid,
//     IfcBooleanResult/IfcBooleanClippingResult (alle drei Operationen über BSP-CSG `csg.rs`; zweiter
//     Operand auch IfcHalfSpaceSolid/IfcBoxedHalfSpace/IfcPolygonalBoundedHalfSpace auf IfcPlane),
//     IfcRevolvedAreaSolid, IfcSweptDiskSolid(+Polygonal), IfcFixedReferenceSweptAreaSolid,
//     IfcSurfaceCurveSweptAreaSolid auf Ebene (`ifc_sweep.rs`; StartParam/EndParam als Parameter der
//     Leitkurve bzw. IFC4.3-Länge), IfcAdvancedBrep(+WithVoids) und IfcFaceSurface mit Ebene, Zylinder,
//     Kegel, Kugel, Torus und (rationaler) B-Spline-Fläche, getrimmt über den Parameterraum
//     (`ifc_brep.rs` liest, `ifc_nurbs.rs` zerlegt).
//   - Öffnungen: IfcRelVoidsElement — der Körper der IfcOpeningElement wird vom Wirt abgezogen (auch
//     vom Teil eines Ganzen, z. B. Platten eines IfcRoof). Scheitert der Boolean → Öffnung gezählt
//     und ausgelassen, Wirt bleibt ganz.
//   - Profile: Arbitrary(+WithVoids), Rectangle(+Hollow, Rounded), Circle(+Hollow),
//     I/L/U/T-Profil (mit Ausrundung, ohne Kantenradien/Neigungen), Derived, Composite.
//   - Kurven (2D und räumlich): IfcPolyline, IfcIndexedPolyCurve (Linien + Bögen),
//     IfcCompositeCurve, IfcTrimmedCurve auf Kreis/Ellipse/Linie/B-Spline, IfcCircle, IfcEllipse,
//     IfcBSplineCurveWithKnots(+Rational).
//   - Einheiten: IfcSIUnit mit Präfix, IfcConversionBasedUnit (Fuss, Zoll, Grad).
//   - Farbe: IfcStyledItem (IfcSurfaceStyleRendering/Shading) am Körper, sonst am Material.
//   - Geschoss: IfcRelContainedInSpatialStructure, aufwärts über IfcRelAggregates.
// Übersprungen und gezählt: alles andere (z. B. IfcSectionedSpine, IFC4.3-Trassierung, Flächen aus
// Extrusion/Rotation einer Kurve);
// IfcOpeningElement/IfcSpace/IfcAnnotation/IfcGrid als Bauteile.
//
// Grenzen: Dateigrösse/Instanzen (`ifc_step`), Dreiecke gesamt, Verschachtelung von Mapped Items und
// Platzierungen, Punkte je Fläche. Unsinn ergibt Fehler oder leere Bauteile, nie Panic.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::csg;
use crate::ifc_step::{self, Entity, StepFile, Value};
use crate::ifc_sweep::{self, Frame};

#[path = "ifc_brep.rs"]
mod brep;
use brep::nearest_param;

/// Höchstzahl Dreiecke über alle Bauteile; darüber wird abgebrochen (`truncated`).
pub const MAX_TRIANGLES: usize = 15_000_000;
const MAX_MAP_DEPTH: usize = 8;
const MAX_PLACEMENT_DEPTH: usize = 64;
const MAX_CURVE_DEPTH: usize = 16;
const MAX_LOOP_POINTS: usize = 200_000;
/// Höchstzahl Auswertungen von Darstellungselementen über die ganze Datei.
const MAX_ITEM_EVALS: usize = 5_000_000;
/// Grösster zulässiger Koordinatenbetrag (m); weiter draussen gilt ein Wert als Unsinn.
const MAX_COORD: f64 = 1e8;
/// Sehnenfehler beim Zerlegen von Kreisen/Bögen (m).
const CHORD_TOL: f64 = 0.002;

pub(crate) type V2 = [f64; 2];
pub(crate) type V3 = [f64; 3];

// ---------------------------------------------------------------------------
// Vektoren und affine Abbildungen
// ---------------------------------------------------------------------------

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn len(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn norm(a: V3) -> Option<V3> {
    let l = len(a);
    (l > 1e-12 && l.is_finite()).then(|| scale(a, 1.0 / l))
}

/// Affine Abbildung p' = R·p + t (R zeilenweise).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Xf {
    r: [[f64; 3]; 3],
    t: V3,
}

impl Xf {
    pub const IDENTITY: Xf = Xf { r: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], t: [0.0; 3] };

    /// Aus Achsen (Spalten) und Ursprung.
    fn from_axes(x: V3, y: V3, z: V3, o: V3) -> Xf {
        Xf { r: [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]], t: o }
    }
    pub fn apply(&self, p: V3) -> V3 {
        let r = &self.r;
        [
            r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2] + self.t[0],
            r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2] + self.t[1],
            r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2] + self.t[2],
        ]
    }
    /// self ∘ o (zuerst o, dann self).
    fn then_after(&self, o: &Xf) -> Xf {
        let mut r = [[0.0; 3]; 3];
        for (i, row) in r.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = (0..3).map(|k| self.r[i][k] * o.r[k][j]).sum();
            }
        }
        let t0 = Xf { r: self.r, t: [0.0; 3] }.apply(o.t);
        Xf { r, t: add(t0, self.t) }
    }
    /// Umkehrabbildung; nicht umkehrbar → `None`.
    pub(crate) fn inverse(&self) -> Option<Xf> {
        let d = self.det();
        if !(d.is_finite() && d.abs() > 1e-15) {
            return None;
        }
        let r = &self.r;
        let c = |i: usize, j: usize| {
            let (i1, i2, j1, j2) = ((i + 1) % 3, (i + 2) % 3, (j + 1) % 3, (j + 2) % 3);
            r[j1][i1] * r[j2][i2] - r[j1][i2] * r[j2][i1]
        };
        let mut inv = [[0.0; 3]; 3];
        for (i, row) in inv.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = c(i, j) / d;
            }
        }
        let m = Xf { r: inv, t: [0.0; 3] };
        let t = m.apply(self.t);
        Some(Xf { r: inv, t: scale(t, -1.0) })
    }
    fn det(&self) -> f64 {
        let r = &self.r;
        r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
            + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0])
    }
    fn is_finite(&self) -> bool {
        self.r.iter().flatten().chain(self.t.iter()).all(|v| v.is_finite())
    }
    /// Ursprung (Verschiebung) der Abbildung.
    pub(crate) fn origin(&self) -> V3 {
        self.t
    }
    /// Bildet eine Richtung ab (ohne Verschiebung).
    pub(crate) fn apply_dir(&self, v: V3) -> V3 {
        Xf { r: self.r, t: [0.0; 3] }.apply(v)
    }
}

/// 2D-Abbildung p' = A·p + t (für Profil-Lagen).
#[derive(Clone, Copy, Debug)]
struct Xf2 {
    a: [[f64; 2]; 2],
    t: V2,
}

impl Xf2 {
    const IDENTITY: Xf2 = Xf2 { a: [[1.0, 0.0], [0.0, 1.0]], t: [0.0, 0.0] };
    fn apply(&self, p: V2) -> V2 {
        [
            self.a[0][0] * p[0] + self.a[0][1] * p[1] + self.t[0],
            self.a[1][0] * p[0] + self.a[1][1] * p[1] + self.t[1],
        ]
    }
}

// ---------------------------------------------------------------------------
// Dreiecksnetz
// ---------------------------------------------------------------------------

/// Dreiecksnetz: `positions` flach (x,y,z), `indices` je 3.
#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub(crate) fn vcount(&self) -> u32 {
        (self.positions.len() / 3) as u32
    }
    pub(crate) fn push_v(&mut self, p: V3) -> u32 {
        let i = self.vcount();
        self.positions.extend_from_slice(&p);
        i
    }
    pub(crate) fn tri(&mut self, a: u32, b: u32, c: u32) {
        self.indices.extend_from_slice(&[a, b, c]);
    }
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }
    /// Hängt `o` abgebildet mit `xf` an (Spiegelung → Wicklung umkehren).
    fn append(&mut self, o: &Mesh, xf: &Xf) {
        let base = self.vcount();
        for p in o.positions.chunks_exact(3) {
            let q = xf.apply([p[0], p[1], p[2]]);
            self.positions.extend_from_slice(&q);
        }
        let flip = xf.det() < 0.0;
        for t in o.indices.chunks_exact(3) {
            if flip {
                self.tri(base + t[0], base + t[2], base + t[1]);
            } else {
                self.tri(base + t[0], base + t[1], base + t[2]);
            }
        }
    }
    pub(crate) fn flip_all(&mut self) {
        for t in self.indices.chunks_exact_mut(3) {
            t.swap(1, 2);
        }
    }
}

/// Achsparalleler Hüllquader eines Netzes.
fn mesh_bbox(m: &Mesh) -> Option<(V3, V3)> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for c in m.positions.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(c[k]);
            hi[k] = hi[k].max(c[k]);
        }
    }
    (lo[0] <= hi[0] && lo.iter().chain(hi.iter()).all(|v| v.is_finite())).then_some((lo, hi))
}

/// Vorzeichenbehaftetes Volumen (Divergenzsatz); bei geschlossenen, aussen orientierten Netzen > 0.
pub fn signed_volume(positions: &[f64], indices: &[u32]) -> f64 {
    let p = |i: u32| -> V3 {
        let k = i as usize * 3;
        match positions.get(k..k + 3) {
            Some(s) => [s[0], s[1], s[2]],
            None => [0.0; 3],
        }
    };
    indices.chunks_exact(3).map(|t| dot(p(t[0]), cross(p(t[1]), p(t[2]))) / 6.0).sum()
}

// ---------------------------------------------------------------------------
// Dreieckszerlegung
// ---------------------------------------------------------------------------

fn area2(r: &[V2]) -> f64 {
    let n = r.len();
    (0..n).map(|i| {
        let a = r[i];
        let b = r[(i + 1) % n];
        a[0] * b[1] - b[0] * a[1]
    }).sum::<f64>() / 2.0
}

/// Ring säubern: nur endliche Punkte, keine doppelten Folgepunkte, Schlusspunkt ≠ Startpunkt.
fn clean_ring2(r: &[V2]) -> Vec<V2> {
    let mut out: Vec<V2> = Vec::with_capacity(r.len());
    for &p in r {
        if !(p[0].is_finite() && p[1].is_finite()) {
            continue;
        }
        if out.last().is_some_and(|q| (q[0] - p[0]).abs() < 1e-9 && (q[1] - p[1]).abs() < 1e-9) {
            continue;
        }
        out.push(p);
    }
    while out.len() > 1 {
        let (f, l) = (out[0], out[out.len() - 1]);
        if (f[0] - l[0]).abs() < 1e-9 && (f[1] - l[1]).abs() < 1e-9 {
            out.pop();
        } else {
            break;
        }
    }
    out
}

/// Polygon mit Löchern (Ring 0 = aussen) → Dreiecke als Indizes in die aneinandergehängten Ringe,
/// alle gegen den Uhrzeigersinn.
fn triangulate2d(rings: &[Vec<V2>]) -> Vec<[usize; 3]> {
    let total: usize = rings.iter().map(|r| r.len()).sum();
    if rings.is_empty() || rings[0].len() < 3 || total > MAX_LOOP_POINTS {
        return Vec::new();
    }
    let mut flat = Vec::with_capacity(total * 2);
    let mut holes = Vec::new();
    let mut pts: Vec<V2> = Vec::with_capacity(total);
    for (k, r) in rings.iter().enumerate() {
        if k > 0 {
            holes.push(pts.len());
        }
        for p in r {
            flat.push(p[0]);
            flat.push(p[1]);
            pts.push(*p);
        }
    }
    let idx = if rings.len() == 1 && pts.len() == 3 {
        vec![0, 1, 2]
    } else {
        match earcutr::earcut(&flat, &holes, 2) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        }
    };
    let mut out = Vec::with_capacity(idx.len() / 3);
    for t in idx.chunks_exact(3) {
        let (a, b, c) = (t[0], t[1], t[2]);
        if a >= pts.len() || b >= pts.len() || c >= pts.len() {
            continue;
        }
        let (pa, pb, pc) = (pts[a], pts[b], pts[c]);
        let cr = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
        if cr > 0.0 {
            out.push([a, b, c]);
        } else if cr < 0.0 {
            out.push([a, c, b]);
        }
    }
    out
}

/// Ebenes 3D-Polygon mit Löchern → Dreiecke, orientiert nach der Newell-Normale des Aussenrings.
fn triangulate3d(rings: &[Vec<V3>], out: &mut Mesh) {
    let Some(outer) = rings.first() else { return };
    if outer.len() < 3 {
        return;
    }
    if rings.len() == 1 && outer.len() == 3 {
        let a = out.push_v(outer[0]);
        let b = out.push_v(outer[1]);
        let c = out.push_v(outer[2]);
        out.tri(a, b, c);
        return;
    }
    let mut n = [0.0; 3];
    for i in 0..outer.len() {
        let a = outer[i];
        let b = outer[(i + 1) % outer.len()];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let Some(n) = norm(n) else { return };
    let helper = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let Some(u) = norm(cross(helper, n)) else { return };
    let v = cross(n, u);
    let o = outer[0];
    let rings2: Vec<Vec<V2>> = rings
        .iter()
        .map(|r| r.iter().map(|p| {
            let d = sub(*p, o);
            [dot(d, u), dot(d, v)]
        }).collect())
        .collect();
    let tris = triangulate2d(&rings2);
    if tris.is_empty() {
        return;
    }
    let base = out.vcount();
    for r in rings {
        for p in r {
            out.push_v(*p);
        }
    }
    for t in tris {
        out.tri(base + t[0] as u32, base + t[1] as u32, base + t[2] as u32);
    }
}

/// Profilringe (Ring 0 aussen, weitere Löcher) säubern, ausrichten (aussen gegen, Löcher im
/// Uhrzeigersinn) und in Dreiecke zerlegen; nichts Brauchbares → `None`.
pub(crate) fn prepare_rings(rings: &[Vec<V2>]) -> Option<(Vec<Vec<V2>>, Vec<[usize; 3]>)> {
    let mut rings: Vec<Vec<V2>> = rings.iter().map(|r| clean_ring2(r)).filter(|r| r.len() >= 3).collect();
    if rings.is_empty() {
        return None;
    }
    for (k, r) in rings.iter_mut().enumerate() {
        let a = area2(r);
        if (k == 0 && a < 0.0) || (k > 0 && a > 0.0) {
            r.reverse();
        }
    }
    let tris = triangulate2d(&rings);
    (!tris.is_empty()).then_some((rings, tris))
}

/// Extrudiert ein Profil (Ring 0 aussen, weitere Löcher, in der XY-Ebene) entlang `h`.
fn extrude(rings: &[Vec<V2>], h: V3) -> Mesh {
    let mut mesh = Mesh::default();
    if h[2].abs() < 1e-9 || !h.iter().all(|v| v.is_finite()) {
        return mesh;
    }
    let Some((rings, tris)) = prepare_rings(rings) else { return mesh };
    let flat: Vec<V2> = rings.iter().flatten().copied().collect();
    // Boden (Normale −h) und Deckel (+h).
    let b0 = mesh.vcount();
    for p in &flat {
        mesh.push_v([p[0], p[1], 0.0]);
    }
    let t0 = mesh.vcount();
    for p in &flat {
        mesh.push_v([p[0] + h[0], p[1] + h[1], h[2]]);
    }
    for t in &tris {
        mesh.tri(b0 + t[0] as u32, b0 + t[2] as u32, b0 + t[1] as u32);
        mesh.tri(t0 + t[0] as u32, t0 + t[1] as u32, t0 + t[2] as u32);
    }
    // Mantel: je Kante ein Viereck mit eigenen Ecken (scharfe Kanten für die Schattierung).
    for r in &rings {
        for i in 0..r.len() {
            let a = r[i];
            let b = r[(i + 1) % r.len()];
            let a0 = mesh.push_v([a[0], a[1], 0.0]);
            let b0 = mesh.push_v([b[0], b[1], 0.0]);
            let b1 = mesh.push_v([b[0] + h[0], b[1] + h[1], h[2]]);
            let a1 = mesh.push_v([a[0] + h[0], a[1] + h[1], h[2]]);
            mesh.tri(a0, b0, b1);
            mesh.tri(a0, b1, a1);
        }
    }
    if h[2] < 0.0 {
        mesh.flip_all();
    }
    mesh
}

/// Anzahl Segmente für einen Bogen mit Öffnungswinkel `span` und Radius `r`.
pub(crate) fn arc_segments(span: f64, r: f64) -> usize {
    let span = span.abs();
    if !(span.is_finite() && r.is_finite()) || r <= 0.0 {
        return 1;
    }
    let step = if r <= CHORD_TOL { std::f64::consts::FRAC_PI_4 } else { 2.0 * (1.0 - CHORD_TOL / r).acos() };
    let step = step.clamp(std::f64::consts::PI / 64.0, std::f64::consts::FRAC_PI_4);
    ((span / step).ceil() as usize).clamp(1, 256)
}

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------

/// Eine Klassifikations-Zuordnung (IfcRelAssociatesClassification -> IfcClassificationReference), z. B.
/// eBKP-H `C` "Konstruktion Gebäude".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Classification {
    /// Name des Systems (IfcClassification.Name, sonst Source), z. B. `eBKP-H`.
    pub system: String,
    /// Code (IfcClassificationReference.Identification bzw. IFC2x3 ItemReference).
    pub code: String,
    pub name: Option<String>,
}

/// Klassifikationen als JSON für die JS-Seite (`system`, `code`, `name`).
#[cfg(feature = "web")]
pub(crate) fn classifications_json(list: &[Classification]) -> Vec<serde_json::Value> {
    list.iter().map(|c| serde_json::json!({ "system": c.system, "code": c.code, "name": c.name })).collect()
}

/// Ein importiertes Bauteil.
#[derive(Clone, Debug, Default)]
pub struct IfcProductMesh {
    pub global_id: String,
    /// IFC-Klasse in Schreibweise des Schemas (`IfcWall`), unbekannte gross (`IFCFOO`).
    pub class: String,
    pub name: Option<String>,
    pub storey: Option<String>,
    /// RGBA 0..1.
    pub color: Option<[f64; 4]>,
    /// Klassifikationen des Bauteils (eBKP-H, BKP, Uniclass ...).
    pub classifications: Vec<Classification>,
    pub mesh: Mesh,
}

/// Ergebnis eines IFC-Imports mit Bericht.
#[derive(Clone, Debug, Default)]
pub struct IfcImport {
    pub schema: String,
    /// Meter je Längeneinheit der Datei.
    pub length_scale: f64,
    pub products: Vec<IfcProductMesh>,
    /// Übersprungene Geometrie-Elemente je IFC-Typ (gross geschrieben).
    pub skipped_items: BTreeMap<String, usize>,
    /// Bewusst ausgelassene Bauteile je Klasse (Öffnungen, Räume, …).
    pub skipped_products: BTreeMap<String, usize>,
    /// Bauteile mit Darstellung, aus der keine Dreiecke wurden.
    pub products_without_geometry: usize,
    /// Boolesche Körper, von denen nur der erste Operand übernommen wurde (Boolean gescheitert oder
    /// zweiter Operand unlesbar).
    pub simplified_booleans: usize,
    /// Öffnungen (IfcRelVoidsElement), die abgezogen wurden (je Wirt und Öffnung).
    pub voids_applied: usize,
    /// Öffnungen, die nicht abgezogen werden konnten (ohne Körper, Boolean gescheitert).
    pub voids_ignored: usize,
    /// Unlesbare STEP-Anweisungen.
    pub parse_errors: usize,
    /// Abbruch wegen Dreiecks-Obergrenze.
    pub truncated: bool,
    /// Erkannte Bauteile ([B4]), nur mit [`import_ifc_opts`]`(…, true)`.
    pub elements: Option<crate::ifc_semantic::Semantic>,
}

/// Bauteilklassen, die als Mesh keinen Sinn ergeben (Volumen-Hilfskörper, Beschriftung).
const SKIP_CLASSES: &[&str] = &[
    "IFCOPENINGELEMENT",
    "IFCOPENINGSTANDARDCASE",
    "IFCSPACE",
    "IFCANNOTATION",
    "IFCGRID",
    "IFCVIRTUALELEMENT",
    "IFCSPATIALZONE",
];

/// Darstellungen, die keinen Körper zeigen.
const NON_BODY_REPS: &[&str] = &[
    "AXIS", "FOOTPRINT", "BOX", "ANNOTATION", "PROFILE", "CLEARANCE", "COG", "REFERENCE", "LIGHTING", "SURVEYPOINTS",
];

// ---------------------------------------------------------------------------
// Leser
// ---------------------------------------------------------------------------

pub(crate) struct Reader<'a> {
    pub(crate) f: &'a StepFile,
    pub(crate) len_scale: f64,
    angle_scale: f64,
    placements: HashMap<u64, Xf>,
    item_colors: HashMap<u64, [f64; 4]>,
    skipped: BTreeMap<String, usize>,
    simplified: usize,
    /// Elemente, die gerade ausgewertet werden (Zyklen in Booleschen/Mapped-Ketten).
    active: HashSet<u64>,
    /// Restbudget an Element-Auswertungen (schützt vor exponentiellen DAGs).
    budget: usize,
    /// Zerlegte Kanten (IfcEdgeCurve-id → Punkte vom Anfang zum Ende), von Nachbarseiten geteilt.
    edge_cache: HashMap<u64, Vec<V3>>,
    /// Rasterachse → IfcGrid (für IfcGridPlacement), beim ersten Bedarf gesammelt.
    grid_axes: Option<HashMap<u64, u64>>,
}

impl<'a> Reader<'a> {
    fn ent(&self, id: u64) -> Option<&'a Entity> {
        self.f.get(id)
    }
    fn ent_v(&self, v: Option<&Value>) -> Option<(u64, &'a Entity)> {
        let id = v?.as_ref_id()?;
        Some((id, self.ent(id)?))
    }
    fn skip(&mut self, ty: &str) {
        *self.skipped.entry(if ty.is_empty() { "(komplex)".to_string() } else { ty.to_string() }).or_insert(0) += 1;
    }

    /// Punkt in Metern (2D-Punkte bekommen z = 0).
    fn point(&self, v: Option<&Value>) -> Option<V3> {
        let (_, e) = self.ent_v(v)?;
        if e.ty != "IFCCARTESIANPOINT" {
            return None;
        }
        let c = e.arg(0)?.as_list()?;
        let x = c.first()?.as_f64()?;
        let y = c.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let z = c.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let p = scale([x, y, z], self.len_scale);
        p.iter().all(|v| v.abs() < MAX_COORD).then_some(p)
    }
    /// Richtung (ohne Einheit), nicht normiert.
    fn direction(&self, v: Option<&Value>) -> Option<V3> {
        let (_, e) = self.ent_v(v)?;
        if e.ty != "IFCDIRECTION" {
            return None;
        }
        let c = e.arg(0)?.as_list()?;
        let x = c.first()?.as_f64()?;
        let y = c.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let z = c.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0);
        Some([x, y, z])
    }
    fn length(&self, v: Option<&Value>) -> Option<f64> {
        v?.as_f64().map(|x| x * self.len_scale).filter(|x| x.abs() < MAX_COORD)
    }

    /// IfcAxis2Placement3D/2D → Abbildung (fehlend = Identität).
    fn axis_placement(&self, v: Option<&Value>) -> Xf {
        let Some((_, e)) = self.ent_v(v) else { return Xf::IDENTITY };
        match e.ty.as_str() {
            "IFCAXIS2PLACEMENT3D" => {
                let o = self.point(e.arg(0)).unwrap_or([0.0; 3]);
                let z = self.direction(e.arg(1)).and_then(norm).unwrap_or([0.0, 0.0, 1.0]);
                let xr = self.direction(e.arg(2)).unwrap_or([1.0, 0.0, 0.0]);
                // X senkrecht zu Z (Gram-Schmidt); bei paralleler Vorgabe eine Ersatzachse.
                let x = norm(sub(xr, scale(z, dot(xr, z))))
                    .or_else(|| {
                        let alt = if z[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
                        norm(sub(alt, scale(z, dot(alt, z))))
                    })
                    .unwrap_or([1.0, 0.0, 0.0]);
                let y = cross(z, x);
                Xf::from_axes(x, y, z, o)
            }
            "IFCAXIS2PLACEMENT2D" => {
                let x2 = self.axis2d(e);
                Xf::from_axes([x2.a[0][0], x2.a[1][0], 0.0], [x2.a[0][1], x2.a[1][1], 0.0], [0.0, 0.0, 1.0], [x2.t[0], x2.t[1], 0.0])
            }
            _ => Xf::IDENTITY,
        }
    }

    fn axis2d(&self, e: &Entity) -> Xf2 {
        let o = self.point(e.arg(0)).unwrap_or([0.0; 3]);
        let d = self.direction(e.arg(1)).unwrap_or([1.0, 0.0, 0.0]);
        let l = (d[0] * d[0] + d[1] * d[1]).sqrt();
        let (cx, sx) = if l > 1e-12 && l.is_finite() { (d[0] / l, d[1] / l) } else { (1.0, 0.0) };
        Xf2 { a: [[cx, -sx], [sx, cx]], t: [o[0], o[1]] }
    }
    fn placement2d(&self, v: Option<&Value>) -> Xf2 {
        match self.ent_v(v) {
            Some((_, e)) if e.ty == "IFCAXIS2PLACEMENT2D" => self.axis2d(e),
            _ => Xf2::IDENTITY,
        }
    }

    /// Objekt-Platzierung in Weltkoordinaten (IfcLocalPlacement-Kette, zwischengespeichert).
    pub(crate) fn object_placement(&mut self, id: u64, depth: usize) -> Xf {
        if let Some(x) = self.placements.get(&id) {
            return *x;
        }
        let Some(e) = self.ent(id) else { return Xf::IDENTITY };
        let xf = if e.ty == "IFCLOCALPLACEMENT" && depth < MAX_PLACEMENT_DEPTH {
            let local = self.axis_placement(e.arg(1));
            match e.arg(0).and_then(|v| v.as_ref_id()) {
                Some(parent) if parent != id => self.object_placement(parent, depth + 1).then_after(&local),
                _ => local,
            }
        } else if e.ty == "IFCGRIDPLACEMENT" && depth < MAX_PLACEMENT_DEPTH {
            // Vorläufig eintragen: Zyklen über das Raster enden bei der Identität.
            self.placements.insert(id, Xf::IDENTITY);
            match self.grid_placement(e, depth) {
                Some(x) => x,
                None => {
                    self.skip("IFCGRIDPLACEMENT (unlesbar)");
                    Xf::IDENTITY
                }
            }
        } else {
            if e.ty != "IFCLOCALPLACEMENT" {
                let ty = e.ty.clone();
                self.skip(&ty);
            }
            Xf::IDENTITY
        };
        let xf = if xf.is_finite() { xf } else { Xf::IDENTITY };
        self.placements.insert(id, xf);
        xf
    }

    /// IfcCartesianTransformationOperator3D(+NonUniform) → Abbildung.
    fn transform_operator(&self, v: Option<&Value>) -> Xf {
        let Some((_, e)) = self.ent_v(v) else { return Xf::IDENTITY };
        match e.ty.as_str() {
            "IFCCARTESIANTRANSFORMATIONOPERATOR3D" | "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM" => {
                let a1 = self.direction(e.arg(0));
                let a2 = self.direction(e.arg(1));
                let o = self.point(e.arg(2)).unwrap_or([0.0; 3]);
                let s = e.arg(3).and_then(|v| v.as_f64()).unwrap_or(1.0);
                let a3 = self.direction(e.arg(4));
                let (s2, s3) = if e.ty.ends_with("NONUNIFORM") {
                    (e.arg(5).and_then(|v| v.as_f64()).unwrap_or(s), e.arg(6).and_then(|v| v.as_f64()).unwrap_or(s))
                } else {
                    (s, s)
                };
                // IfcBaseAxis: U3 = Axis3, U1 = Axis1 ⟂ U3, U2 = Axis2 ⟂ U1,U3 (Richtung behält Spiegelung).
                let u3 = a3.and_then(norm).unwrap_or([0.0, 0.0, 1.0]);
                let u1 = a1
                    .and_then(|a| norm(sub(a, scale(u3, dot(a, u3)))))
                    .or_else(|| {
                        let alt = if u3[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
                        norm(sub(alt, scale(u3, dot(alt, u3))))
                    })
                    .unwrap_or([1.0, 0.0, 0.0]);
                let def2 = cross(u3, u1);
                let u2 = a2
                    .and_then(|a| norm(sub(sub(a, scale(u3, dot(a, u3))), scale(u1, dot(a, u1)))))
                    .unwrap_or(def2);
                Xf::from_axes(scale(u1, s), scale(u2, s2), scale(u3, s3), o)
            }
            _ => Xf::IDENTITY,
        }
    }

    /// 2D-Transformationsoperator (für IfcDerivedProfileDef).
    fn transform_operator2d(&self, v: Option<&Value>) -> Xf2 {
        let Some((_, e)) = self.ent_v(v) else { return Xf2::IDENTITY };
        if !e.ty.starts_with("IFCCARTESIANTRANSFORMATIONOPERATOR2D") {
            return Xf2::IDENTITY;
        }
        let a1 = self.direction(e.arg(0)).unwrap_or([1.0, 0.0, 0.0]);
        let o = self.point(e.arg(2)).unwrap_or([0.0; 3]);
        let s = e.arg(3).and_then(|v| v.as_f64()).unwrap_or(1.0);
        let s2 = if e.ty.ends_with("NONUNIFORM") { e.arg(4).and_then(|v| v.as_f64()).unwrap_or(s) } else { s };
        let l = (a1[0] * a1[0] + a1[1] * a1[1]).sqrt();
        let (c, sn) = if l > 1e-12 && l.is_finite() { (a1[0] / l, a1[1] / l) } else { (1.0, 0.0) };
        let mut u2 = [-sn, c];
        if let Some(a2) = self.direction(e.arg(1)) {
            if a2[0] * u2[0] + a2[1] * u2[1] < 0.0 {
                u2 = [sn, -c];
            }
        }
        Xf2 { a: [[c * s, u2[0] * s2], [sn * s, u2[1] * s2]], t: [o[0], o[1]] }
    }

    // ---- Kurven (2D, für Profile) ----------------------------------------------------------

    /// Kurve in der Profilebene (z der 3D-Kurve verworfen).
    fn curve2d(&mut self, v: Option<&Value>, depth: usize) -> Option<Vec<V2>> {
        Some(self.curve(v, depth)?.into_iter().map(|p| [p[0], p[1]]).collect())
    }

    /// Kurve → Punktfolge (offen; Schlusspunkt kann dem Start entsprechen); 2D-Kurven mit z = 0.
    fn curve(&mut self, v: Option<&Value>, depth: usize) -> Option<Vec<V3>> {
        Some(self.curve_t(v, depth)?.into_iter().map(|(_, p)| p).collect())
    }

    /// Kurve → (Parameter, Punkt)-Folge in der Parametrisierung der Kurve (für StartParam/EndParam):
    /// Polylinie Punktnummer ab 0, Kreis/Ellipse Winkel in der Winkeleinheit der Datei, Linie t (Punkt
    /// = Ort + t·Vektor), B-Spline Knotenparameter, IfcIndexedPolyCurve je Segment 1, zusammengesetzte
    /// Kurven Segmente aneinander (je Länge ihres Parameterbereichs). Parameter steigen (Gegensinn: ab
    /// Start gezählt).
    fn curve_t(&mut self, v: Option<&Value>, depth: usize) -> Option<Vec<(f64, V3)>> {
        let (_, e) = self.ent_v(v)?;
        if depth > MAX_CURVE_DEPTH {
            return None;
        }
        match e.ty.as_str() {
            "IFCPOLYLINE" => Some(
                e.arg(0)?.as_list()?.iter().filter_map(|v| self.point(Some(v))).take(MAX_LOOP_POINTS).enumerate().map(|(i, p)| (i as f64, p)).collect(),
            ),
            "IFCINDEXEDPOLYCURVE" => self.indexed_poly_curve(e),
            "IFCCOMPOSITECURVE" => {
                let mut out: Vec<(f64, V3)> = Vec::new();
                let mut offset = 0.0;
                for seg in e.arg(0)?.as_list()? {
                    let (_, s) = self.ent_v(Some(seg))?;
                    if !s.ty.ends_with("COMPOSITECURVESEGMENT") {
                        self.skip(&s.ty.clone());
                        return None;
                    }
                    let same = s.arg(1).and_then(|v| v.as_enum()) != Some("F");
                    let mut pts = self.curve_t(s.arg(2), depth + 1)?;
                    if !same {
                        pts.reverse();
                    }
                    let (Some(f), Some(l)) = (pts.first().map(|x| x.0), pts.last().map(|x| x.0)) else { continue };
                    let sign = if l >= f { 1.0 } else { -1.0 };
                    let pts: Vec<(f64, V3)> = pts.into_iter().map(|(t, p)| (offset + (t - f) * sign, p)).collect();
                    offset += (l - f).abs();
                    let mut pts = pts.into_iter();
                    if let (Some(last), Some(first)) = (out.last(), pts.as_slice().first()) {
                        if len(sub(last.1, first.1)) < 1e-9 {
                            pts.next();
                        }
                    }
                    out.extend(pts);
                    if out.len() > MAX_LOOP_POINTS {
                        return None;
                    }
                }
                Some(out)
            }
            "IFCTRIMMEDCURVE" => self.trimmed_curve(e),
            "IFCCIRCLE" | "IFCELLIPSE" => {
                let (pl, rx, ry) = self.conic(e)?;
                let n = arc_segments(std::f64::consts::TAU, rx.max(ry)).max(12);
                let a = self.angle_scale;
                Some((0..n).map(|i| {
                    let t = std::f64::consts::TAU * i as f64 / n as f64;
                    (t / a, pl.apply([rx * t.cos(), ry * t.sin(), 0.0]))
                }).collect())
            }
            "IFCBSPLINECURVEWITHKNOTS" | "IFCRATIONALBSPLINECURVEWITHKNOTS" => {
                let c = self.bspline_curve(e)?;
                let (a, b) = c.domain();
                let pts = c.sample(a, b);
                (pts.len() >= 2).then_some(pts)
            }
            other => {
                let other = other.to_string();
                self.skip(&other);
                None
            }
        }
    }

    /// Kreis/Ellipse → (Lage, Halbachse x, Halbachse y).
    fn conic(&self, e: &Entity) -> Option<(Xf, f64, f64)> {
        let pl = self.axis_placement(e.arg(0));
        let rx = self.length(e.arg(1))?;
        let ry = if e.ty == "IFCELLIPSE" { self.length(e.arg(2))? } else { rx };
        (rx > 0.0 && ry > 0.0).then_some((pl, rx, ry))
    }

    fn indexed_poly_curve(&self, e: &Entity) -> Option<Vec<(f64, V3)>> {
        let (_, pl) = self.ent_v(e.arg(0))?;
        if pl.ty != "IFCCARTESIANPOINTLIST2D" && pl.ty != "IFCCARTESIANPOINTLIST3D" {
            return None;
        }
        let coords: Vec<V3> = pl
            .arg(0)?
            .as_list()?
            .iter()
            .take(MAX_LOOP_POINTS)
            .map(|c| {
                let c = c.as_list().unwrap_or(&[]);
                let x = c.first().and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
                let y = c.get(1).and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
                let z = c.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0);
                let p = scale([x, y, z], self.len_scale);
                if p.iter().all(|v| v.abs() < MAX_COORD) { p } else { [f64::NAN; 3] }
            })
            .collect();
        let at = |i: &Value| -> Option<V3> {
            let k = i.as_i64()?;
            (k >= 1).then(|| coords.get(k as usize - 1).copied()).flatten()
        };
        let segs = match e.arg(1) {
            Some(Value::List(s)) => s,
            _ => return Some(coords.iter().enumerate().map(|(i, p)| (i as f64, *p)).collect()),
        };
        let mut out: Vec<(f64, V3)> = Vec::new();
        let push = |out: &mut Vec<(f64, V3)>, t: f64, p: V3| {
            if !out.last().is_some_and(|q| len(sub(q.1, p)) < 1e-12) {
                out.push((t, p));
            }
        };
        // Parameter: je Liniensegment bzw. Bogen eine Einheit.
        let mut t0 = 0.0;
        for s in segs {
            let Value::Typed(name, a) = s else { return None };
            let idx = a.first()?.as_list()?;
            match name.as_str() {
                "IFCLINEINDEX" => {
                    for (k, i) in idx.iter().enumerate() {
                        let t = if k == 0 { t0 } else { t0 + 1.0 };
                        if k > 0 {
                            t0 += 1.0;
                        }
                        push(&mut out, t, at(i)?);
                    }
                }
                "IFCARCINDEX" if idx.len() == 3 => {
                    let (p1, p2, p3) = (at(&idx[0])?, at(&idx[1])?, at(&idx[2])?);
                    let arc = arc3(p1, p2, p3);
                    let n = (arc.len() - 1).max(1) as f64;
                    for (k, p) in arc.into_iter().enumerate() {
                        push(&mut out, t0 + k as f64 / n, p);
                    }
                    t0 += 1.0;
                }
                _ => return None,
            }
            if out.len() > MAX_LOOP_POINTS {
                return None;
            }
        }
        Some(out)
    }

    fn trimmed_curve(&mut self, e: &Entity) -> Option<Vec<(f64, V3)>> {
        let (_, basis) = self.ent_v(e.arg(0))?;
        let sense = e.arg(3).and_then(|v| v.as_enum()) != Some("F");
        let master_param = e.arg(4).and_then(|v| v.as_enum()) == Some("PARAMETER");
        let trim = |r: &Self, v: Option<&Value>| -> (Option<f64>, Option<V3>) {
            let mut par = None;
            let mut pt = None;
            for t in v.and_then(|v| v.as_list()).unwrap_or(&[]) {
                match t {
                    Value::Typed(n, a) if n == "IFCPARAMETERVALUE" => par = a.first().and_then(|x| x.as_f64()),
                    Value::Ref(_) => pt = r.point(Some(t)),
                    _ => {}
                }
            }
            (par, pt)
        };
        let (p1, c1) = trim(self, e.arg(1));
        let (p2, c2) = trim(self, e.arg(2));
        match basis.ty.as_str() {
            "IFCCIRCLE" | "IFCELLIPSE" => {
                let (pl, rx, ry) = self.conic(basis)?;
                let inv = pl.inverse();
                // Winkel: aus Punkt (in Lage-Koordinaten) oder Parameter (Winkeleinheit der Datei).
                let ang = |par: Option<f64>, pt: Option<V3>| -> Option<f64> {
                    let from_pt = pt.and_then(|p| {
                        let l = inv?.apply(p);
                        Some((l[1] / ry).atan2(l[0] / rx))
                    });
                    let from_par = par.map(|t| t * self.angle_scale);
                    if master_param { from_par.or(from_pt) } else { from_pt.or(from_par) }
                };
                let a1 = ang(p1, c1)?;
                let a2 = ang(p2, c2)?;
                let tau = std::f64::consts::TAU;
                let span = if sense { (a2 - a1).rem_euclid(tau) } else { -((a1 - a2).rem_euclid(tau)) };
                let span = if span.abs() < 1e-12 { if sense { tau } else { -tau } } else { span };
                let n = arc_segments(span, rx.max(ry));
                let a = self.angle_scale;
                Some((0..=n).map(|i| {
                    let t = a1 + span * i as f64 / n as f64;
                    (t / a, pl.apply([rx * t.cos(), ry * t.sin(), 0.0]))
                }).collect())
            }
            "IFCLINE" => {
                let pnt = self.point(basis.arg(0))?;
                let (_, vec) = self.ent_v(basis.arg(1))?;
                let d = norm(self.direction(vec.arg(0))?)?;
                let m = self.length(vec.arg(1)).unwrap_or(1.0);
                let at = |t: f64| add(pnt, scale(d, m * t));
                let par_of = |p: V3| if m.abs() > 1e-300 { dot(sub(p, pnt), d) / m } else { 0.0 };
                let a = if master_param { p1.map(at).or(c1) } else { c1.or(p1.map(at)) }?;
                let b = if master_param { p2.map(at).or(c2) } else { c2.or(p2.map(at)) }?;
                let (ta, tb) = (par_of(a), par_of(b));
                Some(if sense { vec![(ta, a), (tb, b)] } else { vec![(tb, b), (ta, a)] })
            }
            "IFCBSPLINECURVEWITHKNOTS" | "IFCRATIONALBSPLINECURVEWITHKNOTS" => {
                let c = self.bspline_curve(basis)?;
                let full = c.sample(c.domain().0, c.domain().1);
                let t_of = |par: Option<f64>, pt: Option<V3>| -> Option<f64> {
                    let from_pt = pt.and_then(|p| nearest_param(&full, p));
                    if master_param { par.or(from_pt) } else { from_pt.or(par) }
                };
                let (t1, t2) = (t_of(p1, c1)?, t_of(p2, c2)?);
                let (lo, hi) = if t1 <= t2 { (t1, t2) } else { (t2, t1) };
                let mut pts = c.sample(lo, hi);
                // Gegensinn bzw. vertauschte Grenzen: rückwärts.
                if sense != (t1 <= t2) {
                    pts.reverse();
                }
                (pts.len() >= 2).then_some(pts)
            }
            _ => {
                // Andere Basiskurven (Klothoiden …) nicht unterstützt.
                let ty = basis.ty.clone();
                self.skip(&ty);
                None
            }
        }
    }
    // ---- Profile ---------------------------------------------------------------------------

    /// Profil → Flächen (je Fläche Ring 0 aussen, weitere Löcher) in Profil-Koordinaten.
    fn profile(&mut self, v: Option<&Value>, depth: usize) -> Option<Vec<Vec<Vec<V2>>>> {
        let (_, e) = self.ent_v(v)?;
        if depth > MAX_CURVE_DEPTH {
            return None;
        }
        let ty = e.ty.as_str();
        let placed = |pl: Xf2, rings: Vec<Vec<V2>>| -> Vec<Vec<Vec<V2>>> {
            vec![rings.into_iter().map(|r| r.into_iter().map(|p| pl.apply(p)).collect()).collect()]
        };
        let rect = |w: f64, h: f64| -> Vec<V2> { vec![[-w / 2.0, -h / 2.0], [w / 2.0, -h / 2.0], [w / 2.0, h / 2.0], [-w / 2.0, h / 2.0]] };
        let circle = |r: f64| -> Vec<V2> {
            let n = arc_segments(std::f64::consts::TAU, r).max(12);
            (0..n).map(|i| {
                let t = std::f64::consts::TAU * i as f64 / n as f64;
                [r * t.cos(), r * t.sin()]
            }).collect()
        };
        match ty {
            "IFCARBITRARYCLOSEDPROFILEDEF" => {
                let outer = self.curve2d(e.arg(2), depth + 1)?;
                Some(vec![vec![outer]])
            }
            "IFCARBITRARYPROFILEDEFWITHVOIDS" => {
                let outer = self.curve2d(e.arg(2), depth + 1)?;
                let mut rings = vec![outer];
                for c in e.arg(3).and_then(|v| v.as_list()).unwrap_or(&[]) {
                    if let Some(r) = self.curve2d(Some(c), depth + 1) {
                        rings.push(r);
                    }
                }
                Some(vec![rings])
            }
            "IFCRECTANGLEPROFILEDEF" | "IFCROUNDEDRECTANGLEPROFILEDEF" => {
                let pl = self.placement2d(e.arg(2));
                let (w, h) = (self.length(e.arg(3))?, self.length(e.arg(4))?);
                let r = if ty == "IFCROUNDEDRECTANGLEPROFILEDEF" { self.length(e.arg(5)).unwrap_or(0.0) } else { 0.0 };
                (w > 0.0 && h > 0.0).then(|| placed(pl, vec![fillet_ring(&rect(w, h), &[r; 4])]))
            }
            "IFCRECTANGLEHOLLOWPROFILEDEF" => {
                let pl = self.placement2d(e.arg(2));
                let (w, h, t) = (self.length(e.arg(3))?, self.length(e.arg(4))?, self.length(e.arg(5))?);
                let mut rings = vec![rect(w, h)];
                if t > 0.0 && 2.0 * t < w && 2.0 * t < h {
                    let mut inner = rect(w - 2.0 * t, h - 2.0 * t);
                    inner.reverse();
                    rings.push(inner);
                }
                (w > 0.0 && h > 0.0).then(|| placed(pl, rings))
            }
            "IFCCIRCLEPROFILEDEF" => {
                let pl = self.placement2d(e.arg(2));
                let r = self.length(e.arg(3))?;
                (r > 0.0).then(|| placed(pl, vec![circle(r)]))
            }
            "IFCCIRCLEHOLLOWPROFILEDEF" => {
                let pl = self.placement2d(e.arg(2));
                let (r, t) = (self.length(e.arg(3))?, self.length(e.arg(4))?);
                let mut rings = vec![circle(r)];
                if t > 0.0 && t < r {
                    let mut inner = circle(r - t);
                    inner.reverse();
                    rings.push(inner);
                }
                (r > 0.0).then(|| placed(pl, rings))
            }
            "IFCISHAPEPROFILEDEF" => {
                let pl = self.placement2d(e.arg(2));
                let (w, d, tw, tf) = (self.length(e.arg(3))?, self.length(e.arg(4))?, self.length(e.arg(5))?, self.length(e.arg(6))?);
                let (x, y, a, b) = (w / 2.0, d / 2.0, tw / 2.0, d / 2.0 - tf);
                let ring = vec![
                    [-x, -y], [x, -y], [x, -b], [a, -b], [a, b], [x, b], [x, y], [-x, y], [-x, b], [-a, b], [-a, -b], [-x, -b],
                ];
                // Ausrundung Steg/Flansch (FilletRadius) an den vier inneren Ecken.
                let fr = self.length(e.arg(7)).unwrap_or(0.0);
                let ring = fillet_ring(&ring, &[0.0, 0.0, 0.0, fr, fr, 0.0, 0.0, 0.0, 0.0, fr, fr, 0.0]);
                (w > 0.0 && d > 0.0 && tw > 0.0 && tf > 0.0).then(|| placed(pl, vec![ring]))
            }
            "IFCLSHAPEPROFILEDEF" => {
                let pl = self.placement2d(e.arg(2));
                let d = self.length(e.arg(3))?;
                let w = self.length(e.arg(4)).unwrap_or(d);
                let t = self.length(e.arg(5))?;
                let (x, y) = (w / 2.0, d / 2.0);
                let ring = vec![[-x, -y], [x, -y], [x, -y + t], [-x + t, -y + t], [-x + t, y], [-x, y]];
                let fr = self.length(e.arg(6)).unwrap_or(0.0);
                let ring = fillet_ring(&ring, &[0.0, 0.0, 0.0, fr, 0.0, 0.0]);
                (w > 0.0 && d > 0.0 && t > 0.0).then(|| placed(pl, vec![ring]))
            }
            "IFCUSHAPEPROFILEDEF" => {
                let pl = self.placement2d(e.arg(2));
                let (d, fw, tw, tf) = (self.length(e.arg(3))?, self.length(e.arg(4))?, self.length(e.arg(5))?, self.length(e.arg(6))?);
                let (x, y) = (fw / 2.0, d / 2.0);
                let ring = vec![[-x, -y], [x, -y], [x, -y + tf], [-x + tw, -y + tf], [-x + tw, y - tf], [x, y - tf], [x, y], [-x, y]];
                let fr = self.length(e.arg(7)).unwrap_or(0.0);
                let ring = fillet_ring(&ring, &[0.0, 0.0, 0.0, fr, fr, 0.0, 0.0, 0.0]);
                (d > 0.0 && fw > 0.0).then(|| placed(pl, vec![ring]))
            }
            "IFCTSHAPEPROFILEDEF" => {
                let pl = self.placement2d(e.arg(2));
                let (d, fw, tw, tf) = (self.length(e.arg(3))?, self.length(e.arg(4))?, self.length(e.arg(5))?, self.length(e.arg(6))?);
                let (x, y, a) = (fw / 2.0, d / 2.0, tw / 2.0);
                let ring = vec![[-a, -y], [a, -y], [a, y - tf], [x, y - tf], [x, y], [-x, y], [-x, y - tf], [-a, y - tf]];
                let fr = self.length(e.arg(7)).unwrap_or(0.0);
                let ring = fillet_ring(&ring, &[0.0, 0.0, fr, 0.0, 0.0, 0.0, 0.0, fr]);
                (d > 0.0 && fw > 0.0).then(|| placed(pl, vec![ring]))
            }
            "IFCDERIVEDPROFILEDEF" => {
                let parent = self.profile(e.arg(2), depth + 1)?;
                let op = self.transform_operator2d(e.arg(3));
                Some(parent.into_iter().map(|rings| rings.into_iter().map(|r| r.into_iter().map(|p| op.apply(p)).collect()).collect()).collect())
            }
            "IFCCOMPOSITEPROFILEDEF" => {
                let mut out = Vec::new();
                for p in e.arg(2)?.as_list()? {
                    out.extend(self.profile(Some(p), depth + 1)?);
                }
                Some(out)
            }
            other => {
                let other = other.to_string();
                self.skip(&other);
                None
            }
        }
    }

    // ---- Körper ----------------------------------------------------------------------------

    /// Ein Darstellungselement → Dreiecke (in Koordinaten des Elements) an `out` anhängen.
    /// `color` sammelt die erste gefundene Elementfarbe.
    fn item(&mut self, id: u64, out: &mut Mesh, depth: usize, color: &mut Option<[f64; 4]>) {
        if self.budget == 0 || !self.active.insert(id) {
            return;
        }
        self.budget -= 1;
        self.item_inner(id, out, depth, color);
        self.active.remove(&id);
    }

    fn item_inner(&mut self, id: u64, out: &mut Mesh, depth: usize, color: &mut Option<[f64; 4]>) {
        let Some(e) = self.ent(id) else { return };
        if color.is_none() {
            if let Some(c) = self.item_colors.get(&id) {
                *color = Some(*c);
            }
        }
        match e.ty.as_str() {
            "IFCEXTRUDEDAREASOLID" => {
                let Some(areas) = self.profile(e.arg(0), 0) else { return };
                let pos = self.axis_placement(e.arg(1));
                let Some(dir) = self.direction(e.arg(2)).and_then(norm) else { return };
                let Some(depth_m) = self.length(e.arg(3)) else { return };
                let h = scale(dir, depth_m);
                for rings in &areas {
                    let m = extrude(rings, h);
                    out.append(&m, &pos);
                }
            }
            "IFCFACETEDBREP" | "IFCFACETEDBREPWITHVOIDS" => {
                if let Some(v) = e.arg(0) {
                    self.shell(v, out);
                }
                for v in e.arg(1).and_then(|v| v.as_list()).unwrap_or(&[]) {
                    self.shell(v, out);
                }
            }
            "IFCADVANCEDBREP" | "IFCADVANCEDBREPWITHVOIDS" => {
                // Freiform-Brep: Seiten auf Ebenen, Zylindern, Kegeln, Kugeln, Tori, B-Spline-Flächen.
                let mut local = Mesh::default();
                if let Some(v) = e.arg(0) {
                    self.shell(v, &mut local);
                }
                for v in e.arg(1).and_then(|v| v.as_list()).unwrap_or(&[]) {
                    self.shell(v, &mut local);
                }
                // Aussen- und Hohlräume sind in sich richtig orientiert; das Ganze nach aussen.
                if signed_volume(&local.positions, &local.indices) < 0.0 {
                    local.flip_all();
                }
                out.append(&local, &Xf::IDENTITY);
            }
            "IFCSHELLBASEDSURFACEMODEL" | "IFCFACEBASEDSURFACEMODEL" => {
                for v in e.arg(0).and_then(|v| v.as_list()).unwrap_or(&[]) {
                    self.shell(v, out);
                }
            }
            "IFCTRIANGULATEDFACESET" | "IFCTRIANGULATEDIRREGULARNETWORK" => self.triangulated_face_set(e, out),
            "IFCPOLYGONALFACESET" => self.polygonal_face_set(e, out),
            "IFCMAPPEDITEM" => {
                if depth >= MAX_MAP_DEPTH {
                    self.skip("IFCMAPPEDITEM (zu tief)");
                    return;
                }
                let Some((_, map)) = self.ent_v(e.arg(0)) else { return };
                let origin = self.axis_placement(map.arg(0));
                let target = self.transform_operator(e.arg(1));
                let xf = target.then_after(&origin);
                let Some((_, rep)) = self.ent_v(map.arg(1)) else { return };
                let items: Vec<u64> = rep.arg(3).and_then(|v| v.as_list()).unwrap_or(&[]).iter().filter_map(|v| v.as_ref_id()).collect();
                let mut local = Mesh::default();
                for it in items {
                    self.item(it, &mut local, depth + 1, color);
                }
                if xf.is_finite() {
                    out.append(&local, &xf);
                }
            }
            "IFCBOOLEANRESULT" | "IFCBOOLEANCLIPPINGRESULT" => {
                if depth >= MAX_MAP_DEPTH * 4 {
                    return;
                }
                let op = match e.arg(0).and_then(|v| v.as_enum()) {
                    Some("UNION") => csg::Op::Union,
                    Some("INTERSECTION") => csg::Op::Intersection,
                    _ => csg::Op::Difference,
                };
                let mut a = Mesh::default();
                if let Some(id) = e.arg(1).and_then(|v| v.as_ref_id()) {
                    self.item(id, &mut a, depth + 1, color);
                }
                let b = match e.arg(2).and_then(|v| v.as_ref_id()) {
                    Some(id) => self.operand(id, &a, depth + 1),
                    None => Mesh::default(),
                };
                if a.is_empty() && op != csg::Op::Union {
                    return;
                }
                match csg::boolean(&a.positions, &a.indices, &b.positions, &b.indices, op) {
                    Some((positions, indices)) if !b.is_empty() => out.append(&Mesh { positions, indices }, &Xf::IDENTITY),
                    _ => {
                        // Rückfall: erster Operand (Vereinigung: beide nebeneinander).
                        out.append(&a, &Xf::IDENTITY);
                        if op == csg::Op::Union {
                            out.append(&b, &Xf::IDENTITY);
                        } else {
                            self.simplified += 1;
                        }
                    }
                }
            }
            "IFCREVOLVEDAREASOLID" => {
                let Some(areas) = self.profile(e.arg(0), 0) else { return };
                let pos = self.axis_placement(e.arg(1));
                let Some((_, ax)) = self.ent_v(e.arg(2)) else { return };
                let o = self.point(ax.arg(0)).unwrap_or([0.0; 3]);
                let Some(d) = self.direction(ax.arg(1)) else { return };
                let Some(angle) = e.arg(3).and_then(|v| v.as_f64()).map(|a| a * self.angle_scale) else { return };
                for rings in &areas {
                    let m = ifc_sweep::revolve(rings, [o[0], o[1]], [d[0], d[1]], angle);
                    out.append(&m, &pos);
                }
            }
            "IFCSWEPTDISKSOLID" | "IFCSWEPTDISKSOLIDPOLYGONAL" => {
                // Ausrundungen (Polygonal) werden nicht ausgewertet.
                let Some(path) = self.sweep_path(e, 0, 3, 4) else { return };
                let Some(r) = self.length(e.arg(1)).filter(|r| *r > 0.0) else { return };
                let n = arc_segments(std::f64::consts::TAU, r).max(24);
                let circle = |r: f64| -> Vec<V2> {
                    (0..n).map(|i| {
                        let t = std::f64::consts::TAU * i as f64 / n as f64;
                        [r * t.cos(), r * t.sin()]
                    }).collect()
                };
                let mut rings = vec![circle(r)];
                if let Some(ri) = self.length(e.arg(2)).filter(|ri| *ri > 0.0 && *ri < r) {
                    let mut inner = circle(ri);
                    inner.reverse();
                    rings.push(inner);
                }
                let m = ifc_sweep::sweep(&rings, &path, Frame::Transport);
                out.append(&m, &Xf::IDENTITY);
            }
            "IFCFIXEDREFERENCESWEPTAREASOLID" | "IFCSURFACECURVESWEPTAREASOLID" => {
                // Leitkurve im System von Position, begrenzt durch StartParam/EndParam.
                let Some(areas) = self.profile(e.arg(0), 0) else { return };
                let pos = self.axis_placement(e.arg(1));
                let Some(path) = self.sweep_path(e, 2, 3, 4) else { return };
                let frame = if e.ty == "IFCFIXEDREFERENCESWEPTAREASOLID" {
                    Frame::FixedX(self.direction(e.arg(5)).unwrap_or([1.0, 0.0, 0.0]))
                } else {
                    // Bezugsfläche: nur Ebenen; deren Normale wird Profil-X (Gegencheck ifcopenshell).
                    match self.ent_v(e.arg(5)) {
                        Some((_, pl)) if pl.ty == "IFCPLANE" => {
                            let x = self.axis_placement(pl.arg(0));
                            Frame::FixedX([x.r[0][2], x.r[1][2], x.r[2][2]])
                        }
                        Some((_, other)) => {
                            let ty = other.ty.clone();
                            self.skip(&format!("IFCSURFACECURVESWEPTAREASOLID ({ty})"));
                            return;
                        }
                        None => return,
                    }
                };
                for rings in &areas {
                    let m = ifc_sweep::sweep(rings, &path, frame);
                    out.append(&m, &pos);
                }
            }
            "IFCCSGSOLID" => {
                if let Some(a) = e.arg(0).and_then(|v| v.as_ref_id()) {
                    if depth < MAX_MAP_DEPTH * 4 {
                        self.item(a, out, depth + 1, color);
                    }
                }
            }
            "IFCBLOCK" => {
                let pos = self.axis_placement(e.arg(0));
                let (Some(x), Some(y), Some(z)) = (self.length(e.arg(1)), self.length(e.arg(2)), self.length(e.arg(3))) else { return };
                if x > 0.0 && y > 0.0 && z > 0.0 {
                    let m = extrude(&[vec![[0.0, 0.0], [x, 0.0], [x, y], [0.0, y]]], [0.0, 0.0, z]);
                    out.append(&m, &pos);
                }
            }
            other => {
                let other = other.to_string();
                self.skip(&other);
            }
        }
    }

    /// Zweiter Operand eines Booleschen Körpers: Halbräume als endliche Körper um `host`, sonst das
    /// Element selbst (eigene Farbe bleibt unbeachtet).
    fn operand(&mut self, id: u64, host: &Mesh, depth: usize) -> Mesh {
        let Some(e) = self.ent(id) else { return Mesh::default() };
        match e.ty.as_str() {
            "IFCHALFSPACESOLID" | "IFCBOXEDHALFSPACE" | "IFCPOLYGONALBOUNDEDHALFSPACE" => {
                if self.budget == 0 || !self.active.insert(id) {
                    return Mesh::default();
                }
                self.budget -= 1;
                let m = self.half_space(e, host).unwrap_or_default();
                self.active.remove(&id);
                m
            }
            _ => {
                let mut m = Mesh::default();
                self.item(id, &mut m, depth, &mut None);
                m
            }
        }
    }

    /// Halbraum (IfcHalfSpaceSolid, IfcBoxedHalfSpace, IfcPolygonalBoundedHalfSpace) als Quader bzw.
    /// Prisma, gross genug, um `host` ganz zu überdecken. Nur Ebenen als Grundfläche.
    fn half_space(&mut self, e: &Entity, host: &Mesh) -> Option<Mesh> {
        let (_, surf) = self.ent_v(e.arg(0))?;
        if surf.ty != "IFCPLANE" {
            let ty = format!("{} ({})", e.ty, surf.ty);
            self.skip(&ty);
            return None;
        }
        let plane = self.axis_placement(surf.arg(0));
        // AgreementFlag .T.: die Normale der Ebene zeigt vom Material weg → Material bei z ≤ 0.
        let below = e.arg(1).and_then(|v| v.as_enum()) != Some("F");
        let (lo, hi) = mesh_bbox(host)?;
        let c = scale(add(lo, hi), 0.5);
        let r = len(sub(hi, lo)) + 1.0;
        let lc = plane.inverse()?.apply(c);
        let zr = lc[2].abs() + r;
        let square = |cx: f64, cy: f64| vec![[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
        let slab = extrude(&[square(lc[0], lc[1])], [0.0, 0.0, zr]);
        let lift = Xf { r: Xf::IDENTITY.r, t: [0.0, 0.0, if below { -zr } else { 0.0 }] };
        let mut half = Mesh::default();
        half.append(&slab, &plane.then_after(&lift));
        if e.ty != "IFCPOLYGONALBOUNDEDHALFSPACE" {
            return Some(half);
        }
        // Prisma der Begrenzung (2D-Kurve in der XY-Ebene von Position) entlang Position-Z.
        let pos = self.axis_placement(e.arg(2));
        let boundary = self.curve2d(e.arg(3), 0)?;
        let pc = pos.inverse()?.apply(c);
        let l = pc[2].abs() + r;
        let prism = extrude(&[boundary], [0.0, 0.0, 2.0 * l]);
        let shift = Xf { r: Xf::IDENTITY.r, t: [0.0, 0.0, -l] };
        let mut bound = Mesh::default();
        bound.append(&prism, &pos.then_after(&shift));
        let (positions, indices) = csg::boolean(&half.positions, &half.indices, &bound.positions, &bound.indices, csg::Op::Intersection)?;
        Some(Mesh { positions, indices })
    }

    /// IfcClosedShell/IfcOpenShell/IfcConnectedFaceSet → Flächen.
    fn shell(&mut self, v: &Value, out: &mut Mesh) {
        let Some((_, sh)) = self.ent_v(Some(v)) else { return };
        let faces = sh.arg(0).and_then(|v| v.as_list()).unwrap_or(&[]);
        for f in faces {
            let Some((_, face)) = self.ent_v(Some(f)) else { continue };
            if face.ty != "IFCFACE" && face.ty != "IFCFACESURFACE" && face.ty != "IFCADVANCEDFACE" {
                continue;
            }
            let mut outer: Option<Vec<V3>> = None;
            let mut inner: Vec<Vec<V3>> = Vec::new();
            for b in face.arg(0).and_then(|v| v.as_list()).unwrap_or(&[]) {
                let Some((_, bound)) = self.ent_v(Some(b)) else { continue };
                let Some((_, lp)) = self.ent_v(bound.arg(0)) else { continue };
                let mut pts: Vec<V3> = match lp.ty.as_str() {
                    "IFCPOLYLOOP" => {
                        let mut pts: Vec<V3> = lp
                            .arg(0)
                            .and_then(|v| v.as_list())
                            .unwrap_or(&[])
                            .iter()
                            .take(MAX_LOOP_POINTS)
                            .filter_map(|p| self.point(Some(p)))
                            .collect();
                        pts.dedup_by(|a, b| len(sub(*a, *b)) < 1e-12);
                        if pts.len() > 1 && len(sub(pts[0], pts[pts.len() - 1])) < 1e-12 {
                            pts.pop();
                        }
                        pts
                    }
                    "IFCEDGELOOP" => match self.edge_loop(lp) {
                        Some(p) => p,
                        None => {
                            self.skip("IFCEDGELOOP (unlesbar)");
                            continue;
                        }
                    },
                    _ => {
                        let ty = lp.ty.clone();
                        self.skip(&ty);
                        continue;
                    }
                };
                if bound.arg(1).and_then(|v| v.as_enum()) == Some("F") {
                    pts.reverse();
                }
                if pts.len() < 3 {
                    continue;
                }
                if bound.ty == "IFCFACEOUTERBOUND" && outer.is_none() {
                    outer = Some(pts);
                } else {
                    inner.push(pts);
                }
            }
            // Ohne ausgezeichneten Aussenrand: der erste Rand ist aussen.
            let outer = match outer {
                Some(o) => o,
                None if !inner.is_empty() => inner.remove(0),
                None => continue,
            };
            let mut rings = vec![outer];
            rings.extend(inner);
            // Gekrümmte Trägerfläche (IfcAdvancedFace/IfcFaceSurface): über den Parameterraum.
            if face.ty != "IFCFACE" {
                if let Some(brep::FaceSurface::Curved(s)) = self.face_surface(face.arg(1)) {
                    let same = face.arg(2).and_then(|v| v.as_enum()) != Some("F");
                    if self.curved_face(&s, &rings, same, out) {
                        continue;
                    }
                }
            }
            triangulate3d(&rings, out);
        }
    }

    /// Koordinatenliste (IfcCartesianPointList3D) in Metern.
    fn point_list3d(&self, v: Option<&Value>) -> Option<Vec<V3>> {
        let (_, pl) = self.ent_v(v)?;
        if pl.ty != "IFCCARTESIANPOINTLIST3D" {
            return None;
        }
        Some(
            pl.arg(0)?
                .as_list()?
                .iter()
                .map(|c| {
                    let c = c.as_list().unwrap_or(&[]);
                    let g = |i: usize| {
                        let v = c.get(i).and_then(|v| v.as_f64()).unwrap_or(f64::NAN) * self.len_scale;
                        if v.abs() < MAX_COORD { v } else { f64::NAN }
                    };
                    [g(0), g(1), g(2)]
                })
                .collect(),
        )
    }

    /// PnIndex (IFC4 ADD1+): Liste ganzer Zahlen; die alte NormalIndex (Liste von Listen) wird ignoriert.
    fn pn_index(v: Option<&Value>) -> Option<Vec<i64>> {
        let l = v?.as_list()?;
        if l.first().is_some_and(|x| x.as_list().is_some()) {
            return None;
        }
        Some(l.iter().map(|x| x.as_i64().unwrap_or(0)).collect())
    }

    fn triangulated_face_set(&mut self, e: &Entity, out: &mut Mesh) {
        let Some(coords) = self.point_list3d(e.arg(0)) else { return };
        let pn = Self::pn_index(e.arg(4));
        let base = out.vcount();
        let resolve = |k: i64| -> Option<u32> {
            let k = match &pn {
                Some(pn) => *pn.get(usize::try_from(k - 1).ok()?)?,
                None => k,
            };
            let i = usize::try_from(k - 1).ok()?;
            let p = coords.get(i)?;
            p.iter().all(|v| v.is_finite()).then_some(i as u32)
        };
        let mut any = false;
        for t in e.arg(3).and_then(|v| v.as_list()).unwrap_or(&[]) {
            let Some(t) = t.as_list() else { continue };
            if t.len() != 3 {
                continue;
            }
            let ids: Option<Vec<u32>> = t.iter().map(|x| x.as_i64().and_then(resolve)).collect();
            if let Some(ids) = ids {
                if !any {
                    for p in &coords {
                        out.push_v(*p);
                    }
                    any = true;
                }
                out.tri(base + ids[0], base + ids[1], base + ids[2]);
            }
        }
    }

    fn polygonal_face_set(&mut self, e: &Entity, out: &mut Mesh) {
        let Some(coords) = self.point_list3d(e.arg(0)) else { return };
        let pn = Self::pn_index(e.arg(3));
        let resolve = |k: &Value| -> Option<V3> {
            let k = k.as_i64()?;
            let k = match &pn {
                Some(pn) => *pn.get(usize::try_from(k - 1).ok()?)?,
                None => k,
            };
            let p = *coords.get(usize::try_from(k - 1).ok()?)?;
            p.iter().all(|v| v.is_finite()).then_some(p)
        };
        let ring = |l: &[Value]| -> Option<Vec<V3>> { l.iter().take(MAX_LOOP_POINTS).map(resolve).collect() };
        for f in e.arg(2).and_then(|v| v.as_list()).unwrap_or(&[]) {
            let Some((_, face)) = self.ent_v(Some(f)) else { continue };
            let Some(outer) = face.arg(0).and_then(|v| v.as_list()).and_then(ring) else { continue };
            let mut rings = vec![outer];
            if face.ty == "IFCINDEXEDPOLYGONALFACEWITHVOIDS" {
                for h in face.arg(1).and_then(|v| v.as_list()).unwrap_or(&[]) {
                    if let Some(r) = h.as_list().and_then(ring) {
                        rings.push(r);
                    }
                }
            }
            triangulate3d(&rings, out);
        }
    }

    // ---- Bauteile ---------------------------------------------------------------------------

    /// Platzierung und Körper-Elemente (ids der Darstellungselemente) eines Bauteils; `None` ohne
    /// Körper-Darstellung.
    fn body_items(&mut self, id: u64) -> Option<(Xf, Vec<u64>)> {
        let f = self.f;
        let e = f.get(id)?;
        // IfcProduct: Representation (Attribut 7) zeigt auf eine IfcProductDefinitionShape.
        let shape = f.get(e.arg(6)?.as_ref_id()?)?;
        if shape.ty != "IFCPRODUCTDEFINITIONSHAPE" {
            return None;
        }
        let refs = |v: Option<&Value>| -> Vec<u64> { v.and_then(|v| v.as_list()).unwrap_or(&[]).iter().filter_map(|x| x.as_ref_id()).collect() };
        // Körper-Darstellungen wählen: „Body", sonst alle ausser Achse/Grundriss/Box/….
        let reps: Vec<&Entity> = refs(shape.arg(2)).into_iter().filter_map(|i| f.get(i)).filter(|r| r.ty == "IFCSHAPEREPRESENTATION").collect();
        let ident = |r: &Entity| r.arg(1).and_then(|v| v.as_str()).unwrap_or("").to_ascii_uppercase();
        let body: Vec<&Entity> = reps.iter().copied().filter(|r| ident(r) == "BODY").collect();
        let chosen: Vec<&Entity> =
            if body.is_empty() { reps.iter().copied().filter(|r| !NON_BODY_REPS.contains(&ident(r).as_str())).collect() } else { body };
        if chosen.is_empty() {
            return None;
        }
        let place = match e.arg(5).and_then(|v| v.as_ref_id()) {
            Some(p) => self.object_placement(p, 0),
            None => Xf::IDENTITY,
        };
        Some((place, chosen.iter().flat_map(|rep| refs(rep.arg(3))).collect()))
    }

    /// Körper eines Bauteils in Weltkoordinaten (ohne Öffnungen) und erste Elementfarbe; `None` ohne
    /// Körper-Darstellung. Hört nach etwa `max_tris` Dreiecken auf.
    pub(crate) fn product_body(&mut self, id: u64, max_tris: usize) -> Option<(Mesh, Option<[f64; 4]>)> {
        let (place, items) = self.body_items(id)?;
        let mut local = Mesh::default();
        let mut color = None;
        for it in items {
            self.item(it, &mut local, 0, &mut color);
            if local.triangle_count() > max_tris {
                break;
            }
        }
        let mut mesh = Mesh::default();
        mesh.append(&local, &place);
        Some((mesh, color))
    }

    /// Wie [`Self::product_body`], aber je Darstellungselement ein eigenes Netz (Weltkoordinaten) —
    /// für den Bauteil-Import ([B4]), der z. B. die Schicht-Bänder einer Wand einzeln braucht.
    pub(crate) fn product_item_meshes(&mut self, id: u64, max_tris: usize) -> Vec<Mesh> {
        let Some((place, items)) = self.body_items(id) else { return Vec::new() };
        let mut out = Vec::new();
        let mut total = 0;
        for it in items {
            let mut local = Mesh::default();
            let mut color = None;
            self.item(it, &mut local, 0, &mut color);
            total += local.triangle_count();
            let mut mesh = Mesh::default();
            mesh.append(&local, &place);
            out.push(mesh);
            if total > max_tris {
                break;
            }
        }
        out
    }

    // ---- Farben ----------------------------------------------------------------------------

    fn style_color(&self, styles: &[Value], depth: usize) -> Option<[f64; 4]> {
        if depth > 4 {
            return None;
        }
        for s in styles {
            let Some((_, st)) = self.ent_v(Some(s)) else { continue };
            let c = match st.ty.as_str() {
                "IFCPRESENTATIONSTYLEASSIGNMENT" => st.arg(0).and_then(|v| v.as_list()).and_then(|l| self.style_color(l, depth + 1)),
                "IFCSURFACESTYLE" => st.arg(2).and_then(|v| v.as_list()).and_then(|l| {
                    l.iter().find_map(|el| {
                        let (_, r) = self.ent_v(Some(el))?;
                        if r.ty != "IFCSURFACESTYLERENDERING" && r.ty != "IFCSURFACESTYLESHADING" {
                            return None;
                        }
                        let (_, col) = self.ent_v(r.arg(0))?;
                        if col.ty != "IFCCOLOURRGB" {
                            return None;
                        }
                        let ch = |i: usize| col.arg(i).and_then(|v| v.as_f64()).map(|x| x.clamp(0.0, 1.0));
                        let transp = r.arg(1).and_then(|v| v.as_f64()).unwrap_or(0.0).clamp(0.0, 1.0);
                        Some([ch(1)?, ch(2)?, ch(3)?, 1.0 - transp])
                    })
                }),
                _ => None,
            };
            if c.is_some() {
                return c;
            }
        }
        None
    }
}

/// Faktor (Meter bzw. Radiant je Einheit) einer IfcNamedUnit; `None` = andere Art.
fn unit_info(f: &StepFile, id: u64, depth: usize) -> Option<(String, f64)> {
    let e = f.get(id)?;
    if depth > 4 {
        return None;
    }
    match e.ty.as_str() {
        "IFCSIUNIT" => {
            let kind = e.arg(1)?.as_enum()?.to_string();
            let prefix = match e.arg(2).and_then(|v| v.as_enum()) {
                Some("EXA") => 1e18,
                Some("PETA") => 1e15,
                Some("TERA") => 1e12,
                Some("GIGA") => 1e9,
                Some("MEGA") => 1e6,
                Some("KILO") => 1e3,
                Some("HECTO") => 1e2,
                Some("DECA") => 1e1,
                Some("DECI") => 1e-1,
                Some("CENTI") => 1e-2,
                Some("MILLI") => 1e-3,
                Some("MICRO") => 1e-6,
                Some("NANO") => 1e-9,
                Some("PICO") => 1e-12,
                _ => 1.0,
            };
            Some((kind, prefix))
        }
        "IFCCONVERSIONBASEDUNIT" | "IFCCONVERSIONBASEDUNITWITHOFFSET" => {
            let kind = e.arg(1)?.as_enum()?.to_string();
            let m = f.get(e.arg(3)?.as_ref_id()?)?;
            let v = m.arg(0)?.as_f64()?;
            let (_, inner) = unit_info(f, m.arg(1)?.as_ref_id()?, depth + 1)?;
            let s = v * inner;
            (s.is_finite() && s > 0.0).then_some((kind, s))
        }
        _ => None,
    }
}

/// Längen- und Winkelfaktor aus der Einheitenzuweisung des Projekts (sonst aller Einheiten der Datei).
fn units(f: &StepFile, ids: &[u64]) -> (f64, f64) {
    let mut unit_ids: Vec<u64> = Vec::new();
    if let Some(p) = ids.iter().filter_map(|i| f.get(*i).map(|e| (i, e))).find(|(_, e)| e.ty == "IFCPROJECT") {
        if let Some(ua) = p.1.arg(8).and_then(|v| v.as_ref_id()).and_then(|i| f.get(i)) {
            unit_ids = ua.arg(0).and_then(|v| v.as_list()).unwrap_or(&[]).iter().filter_map(|v| v.as_ref_id()).collect();
        }
    }
    if unit_ids.is_empty() {
        unit_ids = ids.iter().copied().filter(|i| f.get(*i).is_some_and(|e| e.ty == "IFCSIUNIT")).collect();
    }
    let mut len_scale = 1.0;
    let mut angle_scale = 1.0;
    for u in unit_ids {
        match unit_info(f, u, 0) {
            Some((k, s)) if k == "LENGTHUNIT" => len_scale = s,
            Some((k, s)) if k == "PLANEANGLEUNIT" => angle_scale = s,
            _ => {}
        }
    }
    (len_scale, angle_scale)
}

/// Beziehungen der Datei, die Mesh- und Bauteil-Import ([B4]) brauchen.
#[derive(Default)]
pub(crate) struct Rels {
    /// Bauteil → räumliche Struktur (IfcRelContainedInSpatialStructure).
    pub container: HashMap<u64, u64>,
    /// Teil → Ganzes (IfcRelAggregates).
    pub parent: HashMap<u64, u64>,
    /// Objekt (auch Typ) → Material (IfcRelAssociatesMaterial).
    pub material_of: HashMap<u64, u64>,
    /// Material → Farbe (IfcMaterialDefinitionRepresentation).
    pub material_color: HashMap<u64, [f64; 4]>,
    /// Wirt → Öffnungen (IfcRelVoidsElement).
    pub voids: HashMap<u64, Vec<u64>>,
    /// Objekt (auch Typ) → Klassifikationsverweise (IfcRelAssociatesClassification).
    pub classification_of: HashMap<u64, Vec<u64>>,
    /// Objekt → Gruppen/Zonen (IfcRelAssignsToGroup).
    pub groups_of: HashMap<u64, Vec<u64>>,
}

impl Rels {
    /// Material (auch Schichten/Profile/Bestandteile/Listen) → Farbe des ersten Materials.
    pub(crate) fn resolve_material_color(&self, f: &StepFile, mut m: u64) -> Option<[f64; 4]> {
        for _ in 0..6 {
            if let Some(c) = self.material_color.get(&m) {
                return Some(*c);
            }
            let e = f.get(m)?;
            let next = match e.ty.as_str() {
                "IFCMATERIALLAYERSETUSAGE" | "IFCMATERIALPROFILESETUSAGE" | "IFCMATERIALPROFILESETUSAGETAPERING" => e.arg(0),
                "IFCMATERIALLAYERSET" | "IFCMATERIALLIST" => e.arg(0).and_then(|v| v.as_list()).and_then(|l| l.first()),
                "IFCMATERIALPROFILESET" | "IFCMATERIALCONSTITUENTSET" => e.arg(2).and_then(|v| v.as_list()).and_then(|l| l.first()),
                "IFCMATERIALLAYER" => e.arg(0),
                "IFCMATERIALPROFILE" | "IFCMATERIALCONSTITUENT" => e.arg(2),
                _ => None,
            };
            m = next?.as_ref_id()?;
        }
        None
    }

    /// Klassifikationen eines Objekts (IfcClassificationReference mit Code; ein reines IfcClassification ohne
    /// Code zählt nicht), mit dem System aus `ReferencedSource` (über verschachtelte Verweise nach oben).
    pub(crate) fn classifications(&self, f: &StepFile, id: u64) -> Vec<Classification> {
        let mut out: Vec<Classification> = Vec::new();
        for &c in self.classification_of.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
            let Some(e) = f.get(c) else { continue };
            if e.ty != "IFCCLASSIFICATIONREFERENCE" {
                continue;
            }
            let code = e.arg(1).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if code.is_empty() {
                continue;
            }
            let name = e.arg(2).and_then(|v| v.as_str()).filter(|n| !n.is_empty()).map(str::to_string);
            // System: ReferencedSource, ggf. über weitere Referenzen bis zur IfcClassification.
            let mut system = String::new();
            let mut cur = e.arg(3).and_then(|v| v.as_ref_id());
            for _ in 0..8 {
                let Some(se) = cur.and_then(|i| f.get(i)) else { break };
                if se.ty == "IFCCLASSIFICATION" {
                    system = se
                        .arg(3)
                        .and_then(|v| v.as_str())
                        .filter(|n| !n.is_empty())
                        .or_else(|| se.arg(0).and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string();
                    break;
                }
                cur = se.arg(3).and_then(|v| v.as_ref_id());
            }
            let item = Classification { system, code, name };
            if !out.contains(&item) {
                out.push(item);
            }
        }
        out
    }

    /// Geschoss (IfcBuildingStorey-id) eines Bauteils: Enthaltensein, sonst aufwärts über Aggregation.
    pub(crate) fn storey_id(&self, f: &StepFile, mut id: u64) -> Option<u64> {
        for _ in 0..32 {
            let e = f.get(id)?;
            if e.ty == "IFCBUILDINGSTOREY" {
                return Some(id);
            }
            id = match self.container.get(&id) {
                Some(s) => *s,
                None => *self.parent.get(&id)?,
            };
        }
        None
    }

    fn gather(f: &StepFile, ids: &[u64], r: &mut Reader) -> Rels {
        let mut rels = Rels::default();
        let refs = |v: Option<&Value>| -> Vec<u64> { v.and_then(|v| v.as_list()).unwrap_or(&[]).iter().filter_map(|x| x.as_ref_id()).collect() };
        for &id in ids {
            let e = &f.entities[&id];
            match e.ty.as_str() {
                "IFCRELCONTAINEDINSPATIALSTRUCTURE" => {
                    if let Some(s) = e.arg(5).and_then(|v| v.as_ref_id()) {
                        for el in refs(e.arg(4)) {
                            rels.container.entry(el).or_insert(s);
                        }
                    }
                }
                "IFCRELAGGREGATES" => {
                    if let Some(p) = e.arg(4).and_then(|v| v.as_ref_id()) {
                        for c in refs(e.arg(5)) {
                            rels.parent.entry(c).or_insert(p);
                        }
                    }
                }
                "IFCRELASSOCIATESMATERIAL" => {
                    if let Some(m) = e.arg(5).and_then(|v| v.as_ref_id()) {
                        for o in refs(e.arg(4)) {
                            rels.material_of.entry(o).or_insert(m);
                        }
                    }
                }
                "IFCRELASSOCIATESCLASSIFICATION" => {
                    if let Some(c) = e.arg(5).and_then(|v| v.as_ref_id()) {
                        for o in refs(e.arg(4)) {
                            rels.classification_of.entry(o).or_default().push(c);
                        }
                    }
                }
                "IFCRELASSIGNSTOGROUP" => {
                    if let Some(g) = e.arg(6).and_then(|v| v.as_ref_id()) {
                        for o in refs(e.arg(4)) {
                            rels.groups_of.entry(o).or_default().push(g);
                        }
                    }
                }
                "IFCRELVOIDSELEMENT" => {
                    if let (Some(h), Some(o)) = (e.arg(4).and_then(|v| v.as_ref_id()), e.arg(5).and_then(|v| v.as_ref_id())) {
                        rels.voids.entry(h).or_default().push(o);
                    }
                }
                "IFCSTYLEDITEM" => {
                    if let Some(item) = e.arg(0).and_then(|v| v.as_ref_id()) {
                        if let Some(c) = e.arg(1).and_then(|v| v.as_list()).and_then(|l| r.style_color(l, 0)) {
                            r.item_colors.entry(item).or_insert(c);
                        }
                    }
                }
                "IFCMATERIALDEFINITIONREPRESENTATION" => {
                    if let Some(m) = e.arg(3).and_then(|v| v.as_ref_id()) {
                        'reps: for rep in refs(e.arg(2)) {
                            for it in refs(f.get(rep).and_then(|x| x.arg(3))) {
                                let Some(si) = f.get(it) else { continue };
                                if si.ty != "IFCSTYLEDITEM" {
                                    continue;
                                }
                                if let Some(c) = si.arg(1).and_then(|v| v.as_list()).and_then(|l| r.style_color(l, 0)) {
                                    rels.material_color.entry(m).or_insert(c);
                                    break 'reps;
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        rels
    }
}

/// Liest eine IFC-Datei als Meshes je Bauteil.
pub fn import_ifc(bytes: &[u8]) -> Result<IfcImport, String> {
    import_ifc_opts(bytes, false)
}

/// Wie [`import_ifc`]; mit `elements` werden zusätzlich echte Bauteile erkannt ([B4],
/// `ifc_semantic.rs`): Wände, Decken, Stützen, Türen/Fenster in Wandöffnungen, Räume, Geschosse.
/// Erkannte Bauteile (und ihre Türen/Fenster) fehlen dann in `products`.
pub fn import_ifc_opts(bytes: &[u8], elements: bool) -> Result<IfcImport, String> {
    let f = ifc_step::parse(bytes)?;
    if !f.schema.is_empty() && !f.schema.starts_with("IFC") {
        return Err(format!("kein IFC-Schema: {}", f.schema));
    }
    if f.entities.is_empty() {
        return Err("keine Instanzen gefunden".into());
    }
    let mut ids: Vec<u64> = f.entities.keys().copied().collect();
    ids.sort_unstable();
    let (len_scale, angle_scale) = units(&f, &ids);

    let mut r = Reader {
        f: &f,
        len_scale,
        angle_scale,
        placements: HashMap::new(),
        item_colors: HashMap::new(),
        skipped: BTreeMap::new(),
        simplified: 0,
        active: HashSet::new(),
        budget: MAX_ITEM_EVALS,
        edge_cache: HashMap::new(),
        grid_axes: None,
    };
    let mut result = IfcImport { schema: f.schema.clone(), length_scale: len_scale, parse_errors: f.errors, ..Default::default() };

    // Beziehungen: Geschoss-Zugehörigkeit, Aggregation, Material, Farben.
    let rels = Rels::gather(&f, &ids, &mut r);
    let voids = &rels.voids;
    let parent = &rels.parent;
    let material_of = &rels.material_of;
    let resolve_material_color = |m: u64| rels.resolve_material_color(&f, m);
    let storey_of = |id: u64| -> Option<String> {
        let s = f.get(rels.storey_id(&f, id)?)?;
        let name = s.arg(2).and_then(|v| v.as_str()).or_else(|| s.arg(7).and_then(|v| v.as_str()));
        Some(name.unwrap_or("").to_string())
    };

    // Bauteil-Import ([B4]): erkannte Bauteile kommen nicht als Mesh.
    let semantic = elements.then(|| crate::ifc_semantic::analyze(&mut r, &rels, &ids));
    let converted: HashSet<u64> = semantic.as_ref().map(|s| s.converted.clone()).unwrap_or_default();

    let mut total_tris = 0usize;
    for &id in &ids {
        let e = &f.entities[&id];
        let has_shape = e.arg(6).and_then(|v| v.as_ref_id()).and_then(|i| f.get(i)).is_some_and(|s| s.ty == "IFCPRODUCTDEFINITIONSHAPE");
        if !has_shape || converted.contains(&id) {
            continue;
        }
        if SKIP_CLASSES.contains(&e.ty.as_str()) {
            *result.skipped_products.entry(class_name(&e.ty)).or_insert(0) += 1;
            continue;
        }
        if total_tris >= MAX_TRIANGLES {
            result.truncated = true;
            break;
        }
        let Some((mut mesh, mut color)) = r.product_body(id, MAX_TRIANGLES - total_tris) else { continue };
        if mesh.is_empty() {
            result.products_without_geometry += 1;
            continue;
        }
        if total_tris + mesh.triangle_count() > MAX_TRIANGLES {
            result.truncated = true;
            break;
        }
        // Öffnungen abziehen: eigene und die des Ganzen, zu dem das Bauteil gehört (IfcRoof → Platten).
        let mut host = Some(id);
        for _ in 0..4 {
            let Some(h) = host else { break };
            for &o in voids.get(&h).map(Vec::as_slice).unwrap_or(&[]) {
                let cut = match r.product_body(o, MAX_TRIANGLES) {
                    Some((om, _)) if !om.is_empty() => csg::boolean(&mesh.positions, &mesh.indices, &om.positions, &om.indices, csg::Op::Difference),
                    _ => None,
                };
                match cut {
                    Some((positions, indices)) => {
                        mesh = Mesh { positions, indices };
                        result.voids_applied += 1;
                    }
                    None => result.voids_ignored += 1,
                }
            }
            host = parent.get(&h).copied();
        }
        if mesh.is_empty() {
            continue;
        }
        total_tris += mesh.triangle_count();
        if color.is_none() {
            color = material_of.get(&id).and_then(|m| resolve_material_color(*m));
        }
        result.products.push(IfcProductMesh {
            global_id: e.arg(0).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            class: class_name(&e.ty),
            name: e.arg(2).and_then(|v| v.as_str()).map(str::to_string),
            storey: storey_of(id),
            color,
            classifications: rels.classifications(&f, id),
            mesh,
        });
    }
    if r.budget == 0 {
        result.truncated = true;
    }
    result.skipped_items = r.skipped;
    result.simplified_booleans = r.simplified;
    result.elements = semantic;
    Ok(result)
}

/// IFC-Klassennamen in Schema-Schreibweise (die Datei schreibt nur Grossbuchstaben).
const CLASS_NAMES: &[&str] = &[
    "IfcActuator", "IfcAirTerminal", "IfcAirTerminalBox", "IfcAlarm", "IfcAnnotation", "IfcBeam", "IfcBeamStandardCase",
    "IfcBearing", "IfcBoiler", "IfcBridge", "IfcBridgePart", "IfcBuilding", "IfcBuildingElementPart",
    "IfcBuildingElementProxy", "IfcBuildingStorey", "IfcCableCarrierFitting", "IfcCableCarrierSegment",
    "IfcCableFitting", "IfcCableSegment", "IfcCaissonFoundation", "IfcChimney", "IfcCivilElement", "IfcColumn",
    "IfcColumnStandardCase", "IfcCourse", "IfcCovering", "IfcCurtainWall", "IfcDamper", "IfcDeepFoundation",
    "IfcDiscreteAccessory", "IfcDistributionChamberElement", "IfcDistributionControlElement",
    "IfcDistributionElement", "IfcDistributionFlowElement", "IfcDoor", "IfcDoorStandardCase", "IfcDuctFitting",
    "IfcDuctSegment", "IfcDuctSilencer", "IfcEarthworksCut", "IfcEarthworksElement", "IfcEarthworksFill",
    "IfcElectricAppliance", "IfcElectricDistributionBoard", "IfcElementAssembly", "IfcElementComponent",
    "IfcEnergyConversionDevice", "IfcFan", "IfcFastener", "IfcFilter", "IfcFireSuppressionTerminal",
    "IfcFlowController", "IfcFlowFitting", "IfcFlowMovingDevice", "IfcFlowSegment", "IfcFlowStorageDevice",
    "IfcFlowTerminal", "IfcFlowTreatmentDevice", "IfcFooting", "IfcFurnishingElement", "IfcFurniture",
    "IfcGeographicElement", "IfcGrid", "IfcKerb", "IfcLamp", "IfcLightFixture", "IfcMechanicalFastener", "IfcMember",
    "IfcMemberStandardCase", "IfcOpeningElement", "IfcOpeningStandardCase", "IfcPavement", "IfcPile",
    "IfcPipeFitting", "IfcPipeSegment", "IfcPlate", "IfcPlateStandardCase", "IfcProxy", "IfcPump", "IfcRail",
    "IfcRailing", "IfcRailway", "IfcRailwayPart", "IfcRamp", "IfcRampFlight", "IfcReinforcingBar",
    "IfcReinforcingMesh", "IfcRoad", "IfcRoadPart", "IfcRoof", "IfcSanitaryTerminal", "IfcShadingDevice", "IfcSign",
    "IfcSignal", "IfcSite", "IfcSlab", "IfcSlabElementedCase", "IfcSlabStandardCase", "IfcSpace", "IfcSpaceHeater", "IfcSpatialZone",
    "IfcStair", "IfcStairFlight", "IfcSurfaceFeature", "IfcSwitchingDevice", "IfcTank", "IfcTendon",
    "IfcTrackElement", "IfcTransportElement", "IfcUnitaryEquipment", "IfcValve", "IfcVirtualElement", "IfcWall",
    "IfcWallElementedCase", "IfcWallStandardCase", "IfcWasteTerminal", "IfcWindow", "IfcWindowStandardCase",
];

pub(crate) fn class_name(upper: &str) -> String {
    CLASS_NAMES.iter().find(|c| c.eq_ignore_ascii_case(upper)).map_or_else(|| upper.to_string(), |c| c.to_string())
}

/// Rundet die Ecken eines Rings mit den Radien `radii` (je Ecke, 0 = scharf). Passt ein Radius nicht
/// (Kanten zu kurz, Ecke gestreckt), bleibt die Ecke scharf.
fn fillet_ring(ring: &[V2], radii: &[f64]) -> Vec<V2> {
    let n = ring.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let c = ring[i];
        let r = radii.get(i).copied().unwrap_or(0.0);
        let (p, q) = (ring[(i + n - 1) % n], ring[(i + 1) % n]);
        let u1 = norm([p[0] - c[0], p[1] - c[1], 0.0]);
        let u2 = norm([q[0] - c[0], q[1] - c[1], 0.0]);
        let (Some(u1), Some(u2)) = (u1, u2) else {
            out.push(c);
            continue;
        };
        let theta = dot(u1, u2).clamp(-1.0, 1.0).acos();
        let t = if theta > 1e-6 && theta < std::f64::consts::PI - 1e-6 { r / (theta / 2.0).tan() } else { f64::INFINITY };
        let lp = len([p[0] - c[0], p[1] - c[1], 0.0]);
        let lq = len([q[0] - c[0], q[1] - c[1], 0.0]);
        if !(r > 0.0 && r.is_finite() && t.is_finite() && t <= lp / 2.0 + 1e-12 && t <= lq / 2.0 + 1e-12) {
            out.push(c);
            continue;
        }
        let Some(bis) = norm(add(u1, u2)) else {
            out.push(c);
            continue;
        };
        let m = r / (theta / 2.0).sin();
        let o = [c[0] + bis[0] * m, c[1] + bis[1] * m];
        let a1 = (c[1] + u1[1] * t - o[1]).atan2(c[0] + u1[0] * t - o[0]);
        let a2 = (c[1] + u2[1] * t - o[1]).atan2(c[0] + u2[0] * t - o[0]);
        // Kürzerer Bogen von a1 nach a2.
        let mut span = (a2 - a1).rem_euclid(std::f64::consts::TAU);
        if span > std::f64::consts::PI {
            span -= std::f64::consts::TAU;
        }
        let k = arc_segments(span, r).max(8); // kleine Radien: Sehnen sonst zu grob für die Fläche
        for j in 0..=k {
            let a = a1 + span * j as f64 / k as f64;
            out.push([o[0] + r * a.cos(), o[1] + r * a.sin()]);
        }
    }
    out
}

/// Bogen durch drei Punkte (Anfang, Zwischenpunkt, Ende) als Punktfolge inkl. Endpunkte, auch räumlich.
fn arc3(p1: V3, p2: V3, p3: V3) -> Vec<V3> {
    let u = sub(p2, p1);
    let w = sub(p3, p1);
    let n = cross(u, w);
    let nn = dot(n, n);
    if !(nn.is_finite() && nn > 1e-24) {
        return vec![p1, p2, p3];
    }
    // Umkreismittelpunkt; p1 → p2 → p3 läuft gegen den Uhrzeigersinn um n.
    let c = add(p1, scale(add(scale(cross(n, u), dot(w, w)), scale(cross(w, n), dot(u, u))), 1.0 / (2.0 * nn)));
    let r = len(sub(p1, c));
    let (Some(e1), Some(nz)) = (norm(sub(p1, c)), norm(n)) else { return vec![p1, p2, p3] };
    let e2 = cross(nz, e1);
    let d3 = sub(p3, c);
    let span = dot(d3, e2).atan2(dot(d3, e1)).rem_euclid(std::f64::consts::TAU);
    let n = arc_segments(span, r).max(2);
    let mut out: Vec<V3> = (0..n).map(|i| {
        let t = span * i as f64 / n as f64;
        add(c, add(scale(e1, r * t.cos()), scale(e2, r * t.sin())))
    }).collect();
    out.push(p3);
    out
}

// ---------------------------------------------------------------------------
// WASM-Fassade (Feature "web"): Geometrie flach (Float64Array/Uint32Array), Bericht als JSON.
// ---------------------------------------------------------------------------

#[cfg(feature = "web")]
mod web {
    use wasm_bindgen::prelude::*;

    /// Ergebnis für JS: `meta` (JSON: Bauteile mit Längen der Puffer, Bericht), `positions()`
    /// (alle Bauteile hintereinander, x,y,z in m), `indices()` (je Bauteil ab 0), `elementData()`
    /// (Zahlen der erkannten Bauteile, [B4], s. `ifc_semantic::encode`; leer beim reinen Mesh-Import).
    #[wasm_bindgen]
    pub struct IfcImportResult {
        meta: String,
        positions: Vec<f64>,
        indices: Vec<u32>,
        element_data: Vec<f64>,
    }

    #[wasm_bindgen]
    impl IfcImportResult {
        #[wasm_bindgen(getter)]
        pub fn meta(&self) -> String {
            self.meta.clone()
        }
        pub fn positions(&self) -> Vec<f64> {
            self.positions.clone()
        }
        pub fn indices(&self) -> Vec<u32> {
            self.indices.clone()
        }
        #[wasm_bindgen(js_name = elementData)]
        pub fn element_data(&self) -> Vec<f64> {
            self.element_data.clone()
        }
    }

    /// IFC-Bytes → Meshes je Bauteil. Unlesbare Datei → JS-Fehler mit Meldung (kein Panic).
    #[wasm_bindgen]
    pub fn import_ifc(bytes: &[u8]) -> Result<IfcImportResult, JsValue> {
        encode(super::import_ifc(bytes).map_err(|e| JsValue::from_str(&e))?)
    }

    /// Wie `import_ifc`, dazu echte Bauteile ([B4]): `meta.elements` (Wände, Öffnungen, Decken,
    /// Stützen, Räume; Texte und Verweise) mit Zahlen in `elementData()`, `meta.storeys`; erkannte
    /// Bauteile fehlen in den Meshes.
    #[wasm_bindgen]
    pub fn import_ifc_elements(bytes: &[u8]) -> Result<IfcImportResult, JsValue> {
        encode(super::import_ifc_opts(bytes, true).map_err(|e| JsValue::from_str(&e))?)
    }

    fn encode(r: super::IfcImport) -> Result<IfcImportResult, JsValue> {
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        let products: Vec<serde_json::Value> = r
            .products
            .iter()
            .map(|p| {
                positions.extend_from_slice(&p.mesh.positions);
                indices.extend_from_slice(&p.mesh.indices);
                serde_json::json!({
                    "globalId": p.global_id,
                    "ifcClass": p.class,
                    "name": p.name,
                    "storey": p.storey,
                    "color": p.color,
                    "classifications": super::classifications_json(&p.classifications),
                    "positionCount": p.mesh.positions.len(),
                    "indexCount": p.mesh.indices.len(),
                })
            })
            .collect();
        let mut meta = serde_json::json!({
            "schema": r.schema,
            "lengthScale": r.length_scale,
            "products": products,
            "skippedItems": r.skipped_items,
            "skippedProducts": r.skipped_products,
            "productsWithoutGeometry": r.products_without_geometry,
            "simplifiedBooleans": r.simplified_booleans,
            "voidsApplied": r.voids_applied,
            "voidsIgnored": r.voids_ignored,
            "parseErrors": r.parse_errors,
            "truncated": r.truncated,
        });
        let mut element_data = Vec::new();
        if let Some(sem) = &r.elements {
            let (v, data) = crate::ifc_semantic::encode(sem);
            meta["elements"] = v;
            element_data = data;
        }
        Ok(IfcImportResult { meta: meta.to_string(), positions, indices, element_data })
    }
}

// ---------------------------------------------------------------------------
// Tests: je Geometrietyp ein kleiner, von Hand geschriebener Fall mit bekanntem Volumen.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Gerüst: Projekt (Einheit), Gebäude, Geschoss „EG" (z = 3), ein Bauteil mit `items`.
    fn file(unit: &str, body: &str, items: &str, class: &str) -> String {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0proj',$,'P',$,$,$,$,$,#2);\n#2=IFCUNITASSIGNMENT((#3,#4));\n{unit}\n\
#4=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n\
#10=IFCCARTESIANPOINT((0.,0.,0.));\n#11=IFCDIRECTION((0.,0.,1.));\n#12=IFCDIRECTION((1.,0.,0.));\n\
#13=IFCAXIS2PLACEMENT3D(#10,$,$);\n#14=IFCLOCALPLACEMENT($,#13);\n\
#20=IFCBUILDING('0bldg',$,'B',$,$,#14,$,$,.ELEMENT.,$,$,$);\n\
#21=IFCCARTESIANPOINT((0.,0.,3.));\n#22=IFCAXIS2PLACEMENT3D(#21,$,$);\n#23=IFCLOCALPLACEMENT(#14,#22);\n\
#24=IFCBUILDINGSTOREY('0eg',$,'EG',$,$,#23,$,$,.ELEMENT.,3.);\n\
#25=IFCRELAGGREGATES('0agg',$,$,$,#20,(#24));\n\
#30=IFCLOCALPLACEMENT(#23,#13);\n\
{body}\n\
#90=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',({items}));\n\
#91=IFCSHAPEREPRESENTATION($,'Axis','Curve2D',(#92));\n#92=IFCPOLYLINE((#10,#21));\n\
#93=IFCPRODUCTDEFINITIONSHAPE($,$,(#91,#90));\n\
#94={class}('3aBcDeFgHiJkLmNoPqRsTu',$,'Teil',$,$,#30,#93,$,$);\n\
#95=IFCRELCONTAINEDINSPATIALSTRUCTURE('0rel',$,$,$,(#94),#24);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
        )
    }
    const METRE: &str = "#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);";
    const MILLI: &str = "#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);";

    fn one(src: &str) -> (IfcImport, IfcProductMesh) {
        let r = import_ifc(src.as_bytes()).expect("lesbar");
        assert_eq!(r.products.len(), 1, "{r:?}");
        let p = r.products[0].clone();
        (r, p)
    }
    fn vol(p: &IfcProductMesh) -> f64 {
        signed_volume(&p.mesh.positions, &p.mesh.indices)
    }
    fn bbox(p: &IfcProductMesh) -> (V3, V3) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for c in p.mesh.positions.chunks_exact(3) {
            for k in 0..3 {
                lo[k] = lo[k].min(c[k]);
                hi[k] = hi[k].max(c[k]);
            }
        }
        (lo, hi)
    }
    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn extruded_arbitrary_profile_with_hole_in_mm() {
        // 4 m × 2 m Platte mit 1 m × 1 m Loch, 300 mm dick; Einheit mm.
        let body = "#40=IFCCARTESIANPOINT((0.,0.));#41=IFCCARTESIANPOINT((4000.,0.));#42=IFCCARTESIANPOINT((4000.,2000.));#43=IFCCARTESIANPOINT((0.,2000.));\
#44=IFCPOLYLINE((#40,#41,#42,#43,#40));\
#45=IFCCARTESIANPOINT((1000.,500.));#46=IFCCARTESIANPOINT((2000.,500.));#47=IFCCARTESIANPOINT((2000.,1500.));#48=IFCCARTESIANPOINT((1000.,1500.));\
#49=IFCPOLYLINE((#45,#46,#47,#48,#45));\
#50=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#44,(#49));\
#51=IFCEXTRUDEDAREASOLID(#50,#13,#11,300.);";
        let (r, p) = one(&file(MILLI, body, "#51", "IFCSLAB"));
        assert!(close(r.length_scale, 0.001, 1e-15));
        assert!(close(vol(&p), (8.0 - 1.0) * 0.3, 1e-9), "{}", vol(&p));
        assert_eq!(p.class, "IfcSlab");
        assert_eq!(p.storey.as_deref(), Some("EG"));
        assert_eq!(p.name.as_deref(), Some("Teil"));
        assert_eq!(p.global_id, "3aBcDeFgHiJkLmNoPqRsTu");
        let (lo, hi) = bbox(&p);
        // Geschoss-Platzierung z = 3 m (in mm-Datei: 3 mm!) — Platzierung in Dateieinheit.
        assert!(close(lo[2], 0.003, 1e-12) && close(hi[2], 0.303, 1e-12), "{lo:?} {hi:?}");
        assert!(close(hi[0], 4.0, 1e-12) && close(hi[1], 2.0, 1e-12));
    }

    #[test]
    fn extruded_rectangle_circle_and_shapes() {
        let body = "#40=IFCCARTESIANPOINT((1.,2.));#41=IFCDIRECTION((0.,1.));#42=IFCAXIS2PLACEMENT2D(#40,#41);\
#50=IFCRECTANGLEPROFILEDEF(.AREA.,$,#42,0.4,0.2);#51=IFCEXTRUDEDAREASOLID(#50,$,#11,2.);\
#52=IFCCIRCLEPROFILEDEF(.AREA.,$,$,0.5);#53=IFCEXTRUDEDAREASOLID(#52,#13,#11,1.);\
#54=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,$,0.5,0.1);#55=IFCEXTRUDEDAREASOLID(#54,#13,#11,1.);\
#56=IFCISHAPEPROFILEDEF(.AREA.,$,$,0.2,0.3,0.01,0.02,$,$,$);#57=IFCEXTRUDEDAREASOLID(#56,#13,#11,1.);\
#58=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,$,0.4,0.2,0.05,$,$);#59=IFCEXTRUDEDAREASOLID(#58,#13,#11,1.);";
        let rect = 0.4 * 0.2 * 2.0;
        let (_, p) = one(&file(METRE, body, "#51", "IFCCOLUMN"));
        assert!(close(vol(&p), rect, 1e-12));
        let (lo, hi) = bbox(&p);
        // Profil um 90° gedreht und nach (1,2) verschoben: x-Ausdehnung 0.2, y 0.4.
        assert!(close(hi[0] - lo[0], 0.2, 1e-12) && close(hi[1] - lo[1], 0.4, 1e-12) && close(lo[0], 0.9, 1e-12));
        let pi = std::f64::consts::PI;
        let (_, p) = one(&file(METRE, body, "#53", "IFCCOLUMN"));
        assert!((vol(&p) - pi * 0.25).abs() / (pi * 0.25) < 0.01, "{}", vol(&p));
        let (_, p) = one(&file(METRE, body, "#55", "IFCCOLUMN"));
        let ring = pi * (0.25 - 0.16);
        assert!((vol(&p) - ring).abs() / ring < 0.01, "{}", vol(&p));
        let (_, p) = one(&file(METRE, body, "#57", "IFCBEAM"));
        let ishape = 2.0 * 0.2 * 0.02 + (0.3 - 0.04) * 0.01;
        assert!(close(vol(&p), ishape, 1e-12), "{}", vol(&p));
        let (_, p) = one(&file(METRE, body, "#59", "IFCMEMBER"));
        assert!(close(vol(&p), 0.4 * 0.2 - 0.3 * 0.1, 1e-12));
        // Mehrere Elemente in einer Darstellung addieren sich.
        let (_, p) = one(&file(METRE, body, "#51,#57", "IFCCOLUMN"));
        assert!(close(vol(&p), rect + ishape, 1e-12));
    }

    #[test]
    fn rounded_rectangle_and_i_shape_fillets() {
        let pi = std::f64::consts::PI;
        let body = "#40=IFCROUNDEDRECTANGLEPROFILEDEF(.AREA.,$,$,1.8,0.6,0.2);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);\
#42=IFCISHAPEPROFILEDEF(.AREA.,$,$,0.1,0.2,0.0056,0.0085,0.012,$,$);#43=IFCEXTRUDEDAREASOLID(#42,#13,#11,1.);\
#44=IFCROUNDEDRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.,0.9);#45=IFCEXTRUDEDAREASOLID(#44,#13,#11,1.);";
        let (_, p) = one(&file(METRE, body, "#41", "IFCSLAB"));
        let want = 1.8 * 0.6 - (4.0 - pi) * 0.04;
        assert!((vol(&p) - want).abs() / want < 0.002, "{}", vol(&p));
        let (_, p) = one(&file(METRE, body, "#43", "IFCCOLUMN"));
        let want = 2.0 * 0.1 * 0.0085 + (0.2 - 0.017) * 0.0056 + (4.0 - pi) * 0.012f64.powi(2);
        assert!((vol(&p) - want).abs() / want < 0.002, "{}", vol(&p));
        // T-Profil (halbes IPE300) mit Ausrundung: zwei Ecken.
        let t = "#40=IFCTSHAPEPROFILEDEF(.AREA.,$,$,0.15,0.15,0.0071,0.0107,0.015,$,$,$,$);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);";
        let (_, p) = one(&file(METRE, t, "#41", "IFCBEAM"));
        let want = 0.15 * 0.0107 + (0.15 - 0.0107) * 0.0071 + (4.0 - pi) / 4.0 * 2.0 * 0.015f64.powi(2);
        assert!((vol(&p) - want).abs() / want < 0.002, "{}", vol(&p));
        // Radius grösser als die halbe Kante: Ecken bleiben scharf.
        let (_, p) = one(&file(METRE, body, "#45", "IFCSLAB"));
        assert!(close(vol(&p), 1.0, 1e-12));
    }

    #[test]
    fn extrusion_slanted_and_downwards() {
        // Schräg (Richtung (1,0,1)) und Tiefe 2: Volumen = Fläche × Höhe = 1 × 2/√2.
        let body = "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#41=IFCDIRECTION((1.,0.,1.));#42=IFCEXTRUDEDAREASOLID(#40,#13,#41,2.);\
#43=IFCDIRECTION((0.,0.,-1.));#44=IFCEXTRUDEDAREASOLID(#40,#13,#43,2.);\
#45=IFCDIRECTION((1.,0.,0.));#46=IFCEXTRUDEDAREASOLID(#40,#13,#45,2.);";
        let (_, p) = one(&file(METRE, body, "#42", "IFCMEMBER"));
        assert!(close(vol(&p), 2.0 / 2f64.sqrt(), 1e-12));
        let (_, p) = one(&file(METRE, body, "#44", "IFCMEMBER"));
        assert!(close(vol(&p), 2.0, 1e-12), "nach unten bleibt aussen orientiert: {}", vol(&p));
        // Extrusion in der Profilebene: kein Körper.
        let r = import_ifc(file(METRE, body, "#46", "IFCMEMBER").as_bytes()).unwrap();
        assert_eq!(r.products.len(), 0);
        assert_eq!(r.products_without_geometry, 1);
    }

    #[test]
    fn faceted_brep_cube_with_placement_and_rotation() {
        // Einheitswürfel als 6 Polyloops; Bauteil-Platzierung gedreht (X → Y) und verschoben.
        let mut s = String::new();
        let pts = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)];
        for (i, p) in pts.iter().enumerate() {
            s += &format!("#{}=IFCCARTESIANPOINT(({}.,{}.,{}.));", 100 + i, p.0, p.1, p.2);
        }
        let faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
        let mut fids = Vec::new();
        for (k, f) in faces.iter().enumerate() {
            let (l, b, fc) = (200 + 3 * k, 201 + 3 * k, 202 + 3 * k);
            let ids: Vec<String> = f.iter().map(|i| format!("#{}", 100 + i)).collect();
            s += &format!("#{l}=IFCPOLYLOOP(({}));#{b}=IFCFACEOUTERBOUND(#{l},.T.);#{fc}=IFCFACE((#{b}));", ids.join(","));
            fids.push(format!("#{fc}"));
        }
        s += &format!("#300=IFCCLOSEDSHELL(({}));#301=IFCFACETEDBREP(#300);", fids.join(","));
        let src = file(METRE, &s, "#301", "IFCBUILDINGELEMENTPROXY")
            .replace("#30=IFCLOCALPLACEMENT(#23,#13);", "#30=IFCLOCALPLACEMENT(#23,#31);#31=IFCAXIS2PLACEMENT3D(#32,#11,#33);#32=IFCCARTESIANPOINT((10.,0.,0.));#33=IFCDIRECTION((0.,1.,0.));");
        let (_, p) = one(&src);
        assert!(close(vol(&p), 1.0, 1e-12));
        let (lo, hi) = bbox(&p);
        assert!(close(lo[0], 9.0, 1e-12) && close(hi[0], 10.0, 1e-12), "{lo:?} {hi:?}");
        assert!(close(lo[2], 3.0, 1e-12) && close(hi[2], 4.0, 1e-12));
        assert_eq!(p.mesh.triangle_count(), 12);
    }

    #[test]
    fn faceted_brep_face_with_inner_bound() {
        // Quadratische Fläche 2×2 mit 1×1-Loch (Fläche, kein Körper): Dreiecksfläche = 3.
        let s = "#100=IFCCARTESIANPOINT((0.,0.,0.));#101=IFCCARTESIANPOINT((2.,0.,0.));#102=IFCCARTESIANPOINT((2.,2.,0.));#103=IFCCARTESIANPOINT((0.,2.,0.));\
#104=IFCCARTESIANPOINT((0.5,0.5,0.));#105=IFCCARTESIANPOINT((1.5,0.5,0.));#106=IFCCARTESIANPOINT((1.5,1.5,0.));#107=IFCCARTESIANPOINT((0.5,1.5,0.));\
#110=IFCPOLYLOOP((#100,#101,#102,#103));#111=IFCPOLYLOOP((#104,#105,#106,#107));\
#112=IFCFACEOUTERBOUND(#110,.T.);#113=IFCFACEBOUND(#111,.F.);#114=IFCFACE((#113,#112));\
#115=IFCOPENSHELL((#114));#116=IFCSHELLBASEDSURFACEMODEL((#115));";
        let (_, p) = one(&file(METRE, s, "#116", "IFCCOVERING"));
        let pos = &p.mesh.positions;
        let mut area = 0.0;
        for t in p.mesh.indices.chunks_exact(3) {
            let g = |i: u32| [pos[i as usize * 3], pos[i as usize * 3 + 1], pos[i as usize * 3 + 2]];
            let n = cross(sub(g(t[1]), g(t[0])), sub(g(t[2]), g(t[0])));
            assert!(n[2] > 0.0, "nach oben orientiert");
            area += len(n) / 2.0;
        }
        assert!(close(area, 3.0, 1e-12), "{area}");
    }

    #[test]
    fn triangulated_and_polygonal_face_sets() {
        // Tetraeder (Volumen 1/6) als TriangulatedFaceSet, Würfel als PolygonalFaceSet.
        let s = "#100=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)),$);\
#101=IFCTRIANGULATEDFACESET(#100,$,.T.,((1,3,2),(1,2,4),(2,3,4),(3,1,4)),$);\
#102=IFCTRIANGULATEDFACESET(#100,$,.T.,((1,3,2),(1,2,4),(2,3,4),(3,1,4),(1,2,99)),(1,2,3,4));\
#110=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.)));\
#111=IFCINDEXEDPOLYGONALFACE((1,4,3,2));#112=IFCINDEXEDPOLYGONALFACE((5,6,7,8));#113=IFCINDEXEDPOLYGONALFACE((1,2,6,5));\
#114=IFCINDEXEDPOLYGONALFACE((2,3,7,6));#115=IFCINDEXEDPOLYGONALFACE((3,4,8,7));#116=IFCINDEXEDPOLYGONALFACE((4,1,5,8));\
#117=IFCPOLYGONALFACESET(#110,.T.,(#111,#112,#113,#114,#115,#116),$);";
        let (_, p) = one(&file(METRE, s, "#101", "IFCFURNITURE"));
        assert!(close(vol(&p), 1.0 / 6.0, 1e-12));
        // PnIndex + ungültiger Index (99) wird übersprungen.
        let (_, p) = one(&file(METRE, s, "#102", "IFCFURNITURE"));
        assert!(close(vol(&p), 1.0 / 6.0, 1e-12));
        assert_eq!(p.mesh.triangle_count(), 4);
        let (_, p) = one(&file(METRE, s, "#117", "IFCFURNITURE"));
        assert!(close(vol(&p), 1.0, 1e-12));
    }

    #[test]
    fn polygonal_face_with_voids() {
        let s = "#110=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,2.,0.),(0.,2.,0.),(0.5,0.5,0.),(0.5,1.5,0.),(1.5,1.5,0.),(1.5,0.5,0.)));\
#111=IFCINDEXEDPOLYGONALFACEWITHVOIDS((1,2,3,4),((5,6,7,8)));#117=IFCPOLYGONALFACESET(#110,$,(#111),$);";
        let (_, p) = one(&file(METRE, s, "#117", "IFCPLATE"));
        let pos = &p.mesh.positions;
        let area: f64 = p.mesh.indices.chunks_exact(3).map(|t| {
            let g = |i: u32| [pos[i as usize * 3], pos[i as usize * 3 + 1], pos[i as usize * 3 + 2]];
            len(cross(sub(g(t[1]), g(t[0])), sub(g(t[2]), g(t[0])))) / 2.0
        }).sum();
        assert!(close(area, 3.0, 1e-12));
    }

    #[test]
    fn mapped_item_with_scale_and_mirror() {
        // Würfel 1 m (TriangulatedFaceSet über PolygonalFaceSet) als Typ-Darstellung, zweimal eingesetzt:
        // einmal verschoben, einmal ungleichmässig skaliert (2, 3, 1) und gespiegelt.
        let s = "#110=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.)));\
#111=IFCINDEXEDPOLYGONALFACE((1,4,3,2));#112=IFCINDEXEDPOLYGONALFACE((5,6,7,8));#113=IFCINDEXEDPOLYGONALFACE((1,2,6,5));\
#114=IFCINDEXEDPOLYGONALFACE((2,3,7,6));#115=IFCINDEXEDPOLYGONALFACE((3,4,8,7));#116=IFCINDEXEDPOLYGONALFACE((4,1,5,8));\
#117=IFCPOLYGONALFACESET(#110,.T.,(#111,#112,#113,#114,#115,#116),$);\
#120=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#117));#121=IFCREPRESENTATIONMAP(#13,#120);\
#122=IFCCARTESIANPOINT((5.,0.,0.));#123=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#122,$,$);#124=IFCMAPPEDITEM(#121,#123);\
#125=IFCDIRECTION((-1.,0.,0.));#128=IFCDIRECTION((0.,1.,0.));#126=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM(#125,#128,#10,2.,$,3.,1.);#127=IFCMAPPEDITEM(#121,#126);";
        let (_, p) = one(&file(METRE, s, "#124", "IFCFURNITURE"));
        assert!(close(vol(&p), 1.0, 1e-12));
        let (lo, _) = bbox(&p);
        assert!(close(lo[0], 5.0, 1e-12));
        let (_, p) = one(&file(METRE, s, "#127", "IFCFURNITURE"));
        assert!(close(vol(&p), 6.0, 1e-12), "Spiegelung bleibt aussen orientiert: {}", vol(&p));
        let (lo, hi) = bbox(&p);
        assert!(close(lo[0], -2.0, 1e-12) && close(hi[0], 0.0, 1e-12) && close(hi[1] - lo[1], 3.0, 1e-12));
        // Rekursion (Mapped Item zeigt auf sich selbst über eine Darstellung): Abbruch, kein Überlauf.
        let rec = s.to_string() + "#130=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#132));#131=IFCREPRESENTATIONMAP(#13,#130);#132=IFCMAPPEDITEM(#131,#123);";
        let r = import_ifc(file(METRE, &rec, "#132", "IFCFURNITURE").as_bytes()).unwrap();
        assert_eq!(r.products.len(), 0);
    }

    #[test]
    fn curves_arcs_and_composite() {
        // Halbkreis-Profil über IfcIndexedPolyCurve (Linie + Bogen), IfcCompositeCurve mit getrimmtem Kreis
        // (Parameter in Grad) und IfcCircle direkt: Fläche π r²/2 bzw. π r².
        let pi = std::f64::consts::PI;
        let body = "#40=IFCCARTESIANPOINTLIST2D(((-1.,0.),(1.,0.),(0.,1.)));\
#41=IFCINDEXEDPOLYCURVE(#40,(IFCLINEINDEX((1,2)),IFCARCINDEX((2,3,1))),$);\
#42=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#41);#43=IFCEXTRUDEDAREASOLID(#42,#13,#11,1.);\
#50=IFCCARTESIANPOINT((0.,0.));#51=IFCAXIS2PLACEMENT2D(#50,$);#52=IFCCIRCLE(#51,1.);\
#53=IFCTRIMMEDCURVE(#52,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(180.)),.T.,.PARAMETER.);\
#54=IFCCARTESIANPOINT((-1.,0.));#55=IFCCARTESIANPOINT((1.,0.));#56=IFCPOLYLINE((#54,#55));\
#57=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#53);#58=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#56);\
#59=IFCCOMPOSITECURVE((#57,#58),.F.);#60=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#59);#61=IFCEXTRUDEDAREASOLID(#60,#13,#11,1.);\
#62=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#52);#63=IFCEXTRUDEDAREASOLID(#62,#13,#11,1.);";
        let (_, p) = one(&file(METRE, body, "#43", "IFCSLAB"));
        assert!((vol(&p) - pi / 2.0).abs() / (pi / 2.0) < 0.01, "{}", vol(&p));
        let deg = file(METRE, body, "#61", "IFCSLAB")
            .replace("#4=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);", "#4=IFCCONVERSIONBASEDUNIT(#5,.PLANEANGLEUNIT.,'DEGREE',#6);#5=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);#6=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.017453292519943295),#7);#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);");
        let (_, p) = one(&deg);
        assert!((vol(&p) - pi / 2.0).abs() / (pi / 2.0) < 0.01, "{}", vol(&p));
        let (_, p) = one(&file(METRE, body, "#63", "IFCSLAB"));
        assert!((vol(&p) - pi).abs() / pi < 0.01, "{}", vol(&p));
    }

    #[test]
    fn colors_from_styled_item_and_material() {
        let body = "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);\
#60=IFCCOLOURRGB($,0.5,0.25,1.);#61=IFCSURFACESTYLERENDERING(#60,0.2,$,$,$,$,$,$,.NOTDEFINED.);\
#62=IFCSURFACESTYLE('rot',.BOTH.,(#61));#63=IFCPRESENTATIONSTYLEASSIGNMENT((#62));#64=IFCSTYLEDITEM(#41,(#63),$);";
        let (_, p) = one(&file(METRE, body, "#41", "IFCWALL"));
        let c = p.color.unwrap();
        assert!(close(c[0], 0.5, 1e-12) && close(c[1], 0.25, 1e-12) && close(c[2], 1.0, 1e-12) && close(c[3], 0.8, 1e-12));
        // Über Material (IFC4: Stil direkt, ohne PresentationStyleAssignment), Wand mit Schichtsatz.
        let body2 = "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);\
#60=IFCCOLOURRGB($,0.1,0.2,0.3);#61=IFCSURFACESTYLESHADING(#60,$);#62=IFCSURFACESTYLE($,.BOTH.,(#61));#64=IFCSTYLEDITEM($,(#62),$);\
#65=IFCSTYLEDREPRESENTATION($,'Style','Material',(#64));#66=IFCMATERIAL('Beton',$,$);#67=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#65),#66);\
#68=IFCMATERIALLAYER(#66,0.2,$,$,$,$,$);#69=IFCMATERIALLAYERSET((#68),'W',$);#70=IFCMATERIALLAYERSETUSAGE(#69,.AXIS2.,.POSITIVE.,0.,$);\
#71=IFCRELASSOCIATESMATERIAL('0mat',$,$,$,(#94),#70);";
        let (_, p) = one(&file(METRE, body2, "#41", "IFCWALL"));
        let c = p.color.unwrap();
        assert!(close(c[0], 0.1, 1e-12) && close(c[2], 0.3, 1e-12) && close(c[3], 1.0, 1e-12));
    }

    #[test]
    fn booleans_difference_union_intersection() {
        // Würfel 1 m und obere Hälfte versetzt: A − B = 0.75, A ∪ B = 1.75, A ∩ B = 0.25.
        let body = "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);\
#46=IFCCARTESIANPOINT((0.5,0.,0.5));#47=IFCAXIS2PLACEMENT3D(#46,$,$);#42=IFCEXTRUDEDAREASOLID(#40,#47,#11,1.);\
#43=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#41,#42);#45=IFCBOOLEANRESULT(.UNION.,#41,#42);#48=IFCBOOLEANRESULT(.INTERSECTION.,#41,#42);\
#49=IFCBOOLEANRESULT(.DIFFERENCE.,#41,#99);#99=IFCBEZIERCURVE(1,(#10),.UNSPECIFIED.,.F.,.F.);";
        for (it, want) in [("#43", 0.75), ("#45", 1.75), ("#48", 0.25)] {
            let (r, p) = one(&file(METRE, body, it, "IFCWALL"));
            assert!(close(vol(&p), want, 1e-9), "{it}: {}", vol(&p));
            assert_eq!(r.simplified_booleans, 0);
        }
        // Unlesbarer zweiter Operand: erster Operand bleibt, gezählt.
        let (r, p) = one(&file(METRE, body, "#49", "IFCWALL"));
        assert!(close(vol(&p), 1.0, 1e-12));
        assert_eq!(r.simplified_booleans, 1);
    }

    #[test]
    fn half_spaces_clip_like_a_roof() {
        // Wand 4 × 0.3 × 3, oben schräg abgeschnitten: Ebene durch (0,0,2) mit Normale (−1,0,2)/√5,
        // Material darunter (.T.) wird abgezogen → bleibt unterhalb: Trapez (2 … 4 hoch).
        let body = "#40=IFCCARTESIANPOINT((2.,0.15));#41=IFCAXIS2PLACEMENT2D(#40,$);#42=IFCRECTANGLEPROFILEDEF(.AREA.,$,#41,4.,0.3);\
#43=IFCEXTRUDEDAREASOLID(#42,#13,#11,5.);\
#50=IFCCARTESIANPOINT((0.,0.,2.));#51=IFCDIRECTION((-1.,0.,2.));#52=IFCAXIS2PLACEMENT3D(#50,#51,$);#53=IFCPLANE(#52);\
#54=IFCHALFSPACESOLID(#53,.F.);#55=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#43,#54);\
#56=IFCHALFSPACESOLID(#53,.T.);#57=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#43,#56);\
#60=IFCCARTESIANPOINT((0.,0.));#61=IFCCARTESIANPOINT((2.,0.));#62=IFCCARTESIANPOINT((2.,1.));#63=IFCCARTESIANPOINT((0.,1.));\
#64=IFCPOLYLINE((#60,#61,#62,#63,#60));#65=IFCPOLYGONALBOUNDEDHALFSPACE(#53,.F.,#13,#64);#66=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#43,#65);\
#67=IFCBOXEDHALFSPACE(#53,.F.,$);#68=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#43,#67);";
        // Unter der Ebene: z ≤ 2 + x/2 → Fläche (2 + 4) / 2 · 4 = 12, mal 0.3.
        let (r, p) = one(&file(METRE, body, "#55", "IFCWALL"));
        assert!(close(vol(&p), 12.0 * 0.3, 1e-9), "{}", vol(&p));
        assert_eq!(r.simplified_booleans, 0);
        let (_, p) = one(&file(METRE, body, "#68", "IFCWALL"));
        assert!(close(vol(&p), 12.0 * 0.3, 1e-9), "{}", vol(&p));
        // Gegenteil: oberhalb bleibt 20 − 12 = 8.
        let (_, p) = one(&file(METRE, body, "#57", "IFCWALL"));
        assert!(close(vol(&p), 8.0 * 0.3, 1e-9), "{}", vol(&p));
        // Begrenzt auf x ∈ [0,2]: nur dort abgeschnitten (über 2 + x/2, x ∈ [0,2] → 5·2 − 5 = 5 weg).
        let (_, p) = one(&file(METRE, body, "#66", "IFCWALL"));
        assert!(close(vol(&p), (20.0 - 5.0) * 0.3, 1e-9), "{}", vol(&p));
    }

    #[test]
    fn openings_are_subtracted_from_host_and_aggregate_parts() {
        // Wand 4 × 0.3 × 3 mit Öffnung 1 × 2 (eigene Platzierung relativ zur Wand, tiefer als die Wand).
        let body = "#40=IFCCARTESIANPOINT((2.,0.15));#41=IFCAXIS2PLACEMENT2D(#40,$);#42=IFCRECTANGLEPROFILEDEF(.AREA.,$,#41,4.,0.3);\
#43=IFCEXTRUDEDAREASOLID(#42,#13,#11,3.);\
#500=IFCCARTESIANPOINT((1.,-0.1,0.5));#501=IFCAXIS2PLACEMENT3D(#500,$,$);#502=IFCLOCALPLACEMENT(#30,#501);\
#503=IFCCARTESIANPOINT((0.5,0.25));#504=IFCAXIS2PLACEMENT2D(#503,$);#505=IFCRECTANGLEPROFILEDEF(.AREA.,$,#504,1.,0.5);\
#506=IFCEXTRUDEDAREASOLID(#505,#13,#11,2.);#507=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#506));\
#508=IFCPRODUCTDEFINITIONSHAPE($,$,(#507));#509=IFCOPENINGELEMENT('0open',$,'Loch',$,$,#502,#508,$,.OPENING.);";
        let voids = "#510=IFCRELVOIDSELEMENT('0void',$,$,$,#94,#509);";
        let src = file(METRE, &format!("{body}{voids}"), "#43", "IFCWALL");
        let (r, p) = one(&src);
        assert!(close(vol(&p), 3.6 - 0.3 * 2.0, 1e-9), "{}", vol(&p));
        assert_eq!((r.voids_applied, r.voids_ignored), (1, 0));
        assert_eq!(r.skipped_products.get("IfcOpeningElement"), Some(&1));
        // Öffnung am Ganzen (IfcRoof ohne eigenen Körper), Bauteil ist Teil davon.
        let agg = "#600=IFCROOF('0roof',$,'Dach',$,$,#30,$,$,$);#601=IFCRELAGGREGATES('0ra',$,$,$,#600,(#94));\
#510=IFCRELVOIDSELEMENT('0void',$,$,$,#600,#509);";
        let (r, p) = one(&file(METRE, &format!("{body}{agg}"), "#43", "IFCSLAB"));
        assert!(close(vol(&p), 3.0, 1e-9), "{}", vol(&p));
        assert_eq!(r.voids_applied, 1);
        // Öffnung ohne Körper: gezählt, Wirt bleibt ganz.
        let none = "#510=IFCRELVOIDSELEMENT('0void',$,$,$,#94,#511);#511=IFCOPENINGELEMENT('0o2',$,$,$,$,#502,$,$,$);";
        let (r, p) = one(&file(METRE, &format!("{body}{none}"), "#43", "IFCWALL"));
        assert!(close(vol(&p), 3.6, 1e-9));
        assert_eq!((r.voids_applied, r.voids_ignored), (0, 1));
    }

    #[test]
    fn revolved_and_swept_solids() {
        let pi = std::f64::consts::PI;
        // Rechteck x ∈ [2,3], y ∈ [0,1], 90° um die Profil-y-Achse: Pappus π/2 · 2.5 · 1.
        let body = "#40=IFCCARTESIANPOINT((2.5,0.5));#41=IFCAXIS2PLACEMENT2D(#40,$);#42=IFCRECTANGLEPROFILEDEF(.AREA.,$,#41,1.,1.);\
#43=IFCDIRECTION((0.,1.,0.));#44=IFCAXIS1PLACEMENT(#10,#43);#45=IFCREVOLVEDAREASOLID(#42,#13,#44,1.5707963267948966);\
#50=IFCCARTESIANPOINT((4.,0.,0.));#51=IFCCARTESIANPOINT((4.,3.,0.));#52=IFCCARTESIANPOINT((4.,3.,2.));\
#53=IFCPOLYLINE((#10,#50,#51,#52));#54=IFCSWEPTDISKSOLID(#53,0.1,0.05,$,$);\
#55=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.4,0.2);#56=IFCFIXEDREFERENCESWEPTAREASOLID(#55,#13,#53,$,$,#11);\
#57=IFCPLANE(#13);#58=IFCSURFACECURVESWEPTAREASOLID(#55,#13,#53,$,$,#57);\
#59=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,1.,0.),(2.,0.,0.)));#60=IFCINDEXEDPOLYCURVE(#59,(IFCARCINDEX((1,2,3))),$);\
#61=IFCSWEPTDISKSOLID(#60,0.1,$,$,$);";
        let (r, p) = one(&file(METRE, body, "#45", "IFCMEMBER"));
        let want = pi / 2.0 * 2.5;
        assert!((vol(&p) - want).abs() / want < 0.01, "{}", vol(&p));
        assert!(r.skipped_items.is_empty(), "{:?}", r.skipped_items);
        // Rohr 0.1/0.05 entlang 4 + 3 + 2 m: Kreisring-Fläche (n-Eck, ≥ 24 Ecken) × 9.
        let (_, p) = one(&file(METRE, body, "#54", "IFCREINFORCINGBAR"));
        let want = pi * (0.01 - 0.0025) * 9.0;
        assert!((vol(&p) - want).abs() / want < 0.03, "{}", vol(&p));
        // Rechteck 0.4 × 0.2 entlang derselben Leitkurve: 0.08 × 9.
        for it in ["#56", "#58"] {
            let (r, p) = one(&file(METRE, body, it, "IFCRAILING"));
            assert!(close(vol(&p), 0.08 * 9.0, 1e-9), "{it}: {}", vol(&p));
            assert!(r.skipped_items.is_empty(), "{:?}", r.skipped_items);
        }
        // Halbkreis-Bogen (Radius 1) als räumliche Leitkurve: Länge π.
        let (_, p) = one(&file(METRE, body, "#61", "IFCRAILING"));
        let want = pi * 0.01 * pi;
        assert!((vol(&p) - want).abs() / want < 0.03, "{}", vol(&p));
    }

    #[test]
    fn unknown_items_are_counted() {
        let body = "#44=IFCSECTIONEDSPINE(#45,(),());";
        let r = import_ifc(file(METRE, body, "#44", "IFCWALL").as_bytes()).unwrap();
        assert_eq!(r.skipped_items.get("IFCSECTIONEDSPINE"), Some(&1));
        assert_eq!(r.products_without_geometry, 1);
    }

    #[test]
    fn skips_openings_and_spaces() {
        let body = "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);";
        let r = import_ifc(file(METRE, body, "#41", "IFCOPENINGELEMENT").as_bytes()).unwrap();
        assert!(r.products.is_empty());
        assert_eq!(r.skipped_products.get("IfcOpeningElement"), Some(&1));
        let r = import_ifc(file(METRE, body, "#41", "IFCSPACE").as_bytes()).unwrap();
        assert_eq!(r.skipped_products.get("IfcSpace"), Some(&1));
    }

    #[test]
    fn ifc2x3_feet_and_unknown_class() {
        // Fuss als Längeneinheit (IFC2x3-Stil), unbekannte Klasse behält Grossschreibung.
        let src = file("#3=IFCCONVERSIONBASEDUNIT(#5,.LENGTHUNIT.,'FOOT',#6);#5=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);#6=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.3048),#7);#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
            "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);", "#41", "IFCFOOBAR")
            .replace("IFC4", "IFC2X3");
        let (r, p) = one(&src);
        assert_eq!(r.schema, "IFC2X3");
        assert!(close(r.length_scale, 0.3048, 1e-15));
        assert!(close(vol(&p), 0.3048f64.powi(3), 1e-12));
        assert_eq!(p.class, "IFCFOOBAR");
    }

    /// Freie Beispieldateien (z. B. buildingSMART Sample-Test-Files), nur wenn `DOSSIER_IFC_SAMPLES` auf
    /// ein Verzeichnis zeigt: jede Datei muss lesbar sein und Bauteile liefern. Ausgabe je Datei mit
    /// `--nocapture`; der Gegencheck mit ifcopenshell läuft in `scripts/ifc-import-compare.py`.
    #[test]
    fn sample_files_if_present() {
        let Ok(dir) = std::env::var("DOSSIER_IFC_SAMPLES") else { return };
        let mut files = Vec::new();
        let mut stack = vec![std::path::PathBuf::from(dir)];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("ifc")) {
                    files.push(p);
                }
            }
        }
        files.sort();
        for f in files {
            let bytes = std::fs::read(&f).unwrap();
            let r = import_ifc(&bytes).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
            let tris: usize = r.products.iter().map(|p| p.mesh.triangle_count()).sum();
            eprintln!(
                "{}: {} {} Bauteile, {} Dreiecke, ohne Geometrie {}, übersprungen {:?}, Bauteile ausgelassen {:?}",
                f.display(), r.schema, r.products.len(), tris, r.products_without_geometry, r.skipped_items, r.skipped_products
            );
            assert!(!r.products.is_empty(), "{}", f.display());
        }
    }

    /// Synthetische Freiform-Fälle (`src/io/testdata/ifc-freeform-cases.ifc`, erzeugt von Hand):
    /// Volumen gegen Formel, Breps ohne Löcher zwischen den Seiten.
    #[test]
    fn freeform_cases_volumes_and_closed_breps() {
        let src = include_str!("../../../src/io/testdata/ifc-freeform-cases.ifc");
        let r = import_ifc(src.as_bytes()).unwrap();
        assert!(r.skipped_items.is_empty(), "{:?}", r.skipped_items);
        let pi = std::f64::consts::PI;
        let want = [
            ("1cyl", pi * 0.25 * 2.0, 0.01),
            ("2dome", 2.0 / 3.0 * pi, 0.01),
            ("3bspprofile", pi * 0.25, 0.005),
            ("4twist", 2.0 / 3.0, 0.005),
            ("5nurbscyl", pi * 0.25, 0.005),
            // StartParam 0.5 … EndParam 1.5 der Polylinie: 2 m + 1.5 m.
            ("6pipeparams", pi * 0.01 * 3.5, 0.02),
            // Viertelkreis R = 2.
            ("7pipearc", pi * 0.01 * pi, 0.02),
            ("8pipenurbs", pi * 0.01 * 2.0 * pi, 0.02),
        ];
        assert_eq!(r.products.len(), want.len());
        for (p, (name, v, rel)) in r.products.iter().zip(want) {
            assert!(p.global_id.starts_with(name), "{}", p.global_id);
            let got = vol(p);
            assert!((got - v).abs() / v < rel, "{name}: {got} ≠ {v}");
        }
        // Geschlossen (auch mit T-Stössen, wo gerade Kanten fein geteilt sind): die Flächenvektoren
        // aller Dreiecke heben sich auf.
        for p in r.products.iter().filter(|p| ["1cyl", "2dome", "4twist", "5nurbscyl"].iter().any(|n| p.global_id.starts_with(n))) {
            let at = |i: u32| {
                let k = i as usize * 3;
                [p.mesh.positions[k], p.mesh.positions[k + 1], p.mesh.positions[k + 2]]
            };
            let mut sum = [0.0; 3];
            let mut total = 0.0;
            for t in p.mesh.indices.chunks_exact(3) {
                let n = cross(sub(at(t[1]), at(t[0])), sub(at(t[2]), at(t[0])));
                sum = add(sum, n);
                total += len(n);
            }
            assert!(len(sum) < 1e-9 * total, "{}: {sum:?}", p.global_id);
        }
    }

    #[test]
    fn grid_placement_at_axis_intersection() {
        // Raster in (10, 0, 0) des Geschosses; U-Achse y = 2 (Gegensinn), V-Achse x = 3; Versatz 0.5
        // (links der umgedrehten U-Achse = −y) und 0.25 (links der V-Achse = −x), z 1.
        let body = "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.2,0.2);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);\
#50=IFCCARTESIANPOINT((0.,2.));#51=IFCCARTESIANPOINT((8.,2.));#52=IFCPOLYLINE((#50,#51));#53=IFCGRIDAXIS('1',#52,.F.);\
#54=IFCCARTESIANPOINT((3.,-5.));#55=IFCCARTESIANPOINT((3.,5.));#56=IFCPOLYLINE((#54,#55));#57=IFCGRIDAXIS('A',#56,.T.);\
#58=IFCCARTESIANPOINT((10.,0.,0.));#59=IFCAXIS2PLACEMENT3D(#58,$,$);#60=IFCLOCALPLACEMENT(#23,#59);\
#61=IFCGRID('0grid',$,$,$,$,#60,$,(#53),(#57),$,$);\
#62=IFCVIRTUALGRIDINTERSECTION((#53,#57),(0.5,0.25,1.));#63=IFCDIRECTION((0.,1.,0.));#64=IFCGRIDPLACEMENT(#62,#63);";
        let src = file(METRE, body, "#41", "IFCCOLUMN").replace("$,'Teil',$,$,#30,", "$,'Teil',$,$,#64,");
        let (r, p) = one(&src);
        assert!(r.skipped_items.is_empty(), "{:?}", r.skipped_items);
        let (lo, hi) = bbox(&p);
        let c = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0];
        // x = 10 + 3 − 0.25, y = 2 − 0.5, z = 3 (Geschoss) + 1.
        assert!(close(c[0], 12.75, 1e-9) && close(c[1], 1.5, 1e-9), "{c:?}");
        assert!(close(lo[2], 4.0, 1e-9) && close(hi[2], 5.0, 1e-9));
        assert!(close(vol(&p), 0.04, 1e-9));
        // IFC4.3-Form (PlacementRelTo vorne) gibt dasselbe.
        let src43 = src.replace("IFCGRIDPLACEMENT(#62,#63)", "IFCGRIDPLACEMENT(#60,#62,#63)");
        let (_, q) = one(&src43);
        assert_eq!(bbox(&q), (lo, hi));
    }

    #[test]
    fn nonsense_never_panics() {
        assert!(import_ifc(b"").is_err());
        assert!(import_ifc(b"not an ifc").is_err());
        assert!(import_ifc(b"ISO-10303-21;HEADER;FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));ENDSEC;DATA;#1=X();ENDSEC;").is_err());
        // Kaputte Referenzen, Zyklen, NaN, falsche Typen an jeder Stelle.
        let bad = [
            "#41=IFCEXTRUDEDAREASOLID(#41,#41,#41,#41);",
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,-1.,1.);",
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#40=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#42);#42=IFCPOLYLINE((#10,#10,#10));",
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#40=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#42);#42=IFCCOMPOSITECURVE((#43),.F.);#43=IFCCOMPOSITECURVESEGMENT(.C.,.T.,#42);",
            "#41=IFCTRIANGULATEDFACESET(#42,$,$,((1,2,3),(0,-1,5),('a',2,3)),((1)));#42=IFCCARTESIANPOINTLIST3D(((0.,0.),(1.,1.,1.),()));",
            "#41=IFCFACETEDBREP(#42);#42=IFCCLOSEDSHELL((#43,#41,$,1));#43=IFCFACE((#44));#44=IFCFACEOUTERBOUND(#45,.T.);#45=IFCPOLYLOOP((#10,#21,#10));",
            "#41=IFCMAPPEDITEM(#42,#43);#42=IFCREPRESENTATIONMAP(#13,#90);#43=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#11,#11,#10,0.,#11);",
            "#41=IFCBOOLEANRESULT(.UNION.,#41,#41);",
            "#41=IFCBOOLEANRESULT(.DIFFERENCE.,#42,#43);#42=IFCBOOLEANRESULT(.DIFFERENCE.,#41,#43);#43=IFCHALFSPACESOLID(#44,.T.);#44=IFCPLANE(#41);",
            "#41=IFCBOOLEANRESULT(.DIFFERENCE.,#42,#43);#42=IFCBLOCK(#13,1.,1.,1.);#43=IFCPOLYGONALBOUNDEDHALFSPACE(#44,.T.,#13,#45);#44=IFCPLANE(#13);#45=IFCPOLYLINE((#10,#10));",
            "#41=IFCREVOLVEDAREASOLID(#40,#13,#42,1.E300);#40=IFCCIRCLEPROFILEDEF(.AREA.,$,$,1.);#42=IFCAXIS1PLACEMENT(#10,#11);",
            "#41=IFCSWEPTDISKSOLID(#42,1.E-9,1.,$,$);#42=IFCPOLYLINE((#10,#10,#21));",
            "#41=IFCSWEPTDISKSOLID(#41,1.,$,$,$);",
            "#41=IFCSURFACECURVESWEPTAREASOLID(#40,#13,#92,$,$,#41);#40=IFCCIRCLEPROFILEDEF(.AREA.,$,$,1.);",
            "#41=IFCPOLYGONALFACESET(#42,$,(#43),(5,6));#42=IFCCARTESIANPOINTLIST3D(((0.,0.,0.)));#43=IFCINDEXEDPOLYGONALFACE((1,2,3));",
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#40=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#42);#42=IFCINDEXEDPOLYCURVE(#43,(IFCARCINDEX((1,1,1)),IFCLINEINDEX((9))),$);#43=IFCCARTESIANPOINTLIST2D(((0.,0.)));",
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.E308);#40=IFCCIRCLEPROFILEDEF(.AREA.,$,$,1.E308);",
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#40=IFCCIRCLEPROFILEDEF(.AREA.,$,$,1.E-300);",
            // Freiform ([25]): kaputte B-Splines, Kanten, Flächen, Zyklen.
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#40=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#42);#42=IFCBSPLINECURVEWITHKNOTS(3,(#10,#21),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,1.),.UNSPECIFIED.);",
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#40=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#42);#42=IFCRATIONALBSPLINECURVEWITHKNOTS(1,(#10,#21),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.,(1.,-1.));",
            "#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#40=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#42);#42=IFCBSPLINECURVEWITHKNOTS(99999,(#10,#21),.UNSPECIFIED.,.F.,.F.,(1,1),(1.,0.),.UNSPECIFIED.);",
            "#41=IFCADVANCEDBREP(#42);#42=IFCCLOSEDSHELL((#43));#43=IFCADVANCEDFACE((#44),#47,.T.);#44=IFCFACEOUTERBOUND(#45,.T.);#45=IFCEDGELOOP((#46));#46=IFCORIENTEDEDGE(*,*,#46,.T.);#47=IFCCYLINDRICALSURFACE(#13,1.);",
            "#41=IFCADVANCEDBREP(#42);#42=IFCCLOSEDSHELL((#43));#43=IFCADVANCEDFACE((#44),#47,.T.);#44=IFCFACEOUTERBOUND(#45,.T.);#45=IFCEDGELOOP((#46));#46=IFCORIENTEDEDGE(*,*,#48,.T.);#48=IFCEDGECURVE(#49,#49,#50,.T.);#49=IFCVERTEXPOINT(#10);#50=IFCCIRCLE(#13,0.);#47=IFCSPHERICALSURFACE(#13,-1.);",
            "#41=IFCADVANCEDBREP(#42);#42=IFCCLOSEDSHELL((#43));#43=IFCADVANCEDFACE((#44),#47,.T.);#44=IFCFACEOUTERBOUND(#45,.T.);#45=IFCEDGELOOP((#46));#46=IFCORIENTEDEDGE(*,*,#48,.T.);#48=IFCEDGECURVE(#49,#49,#50,.T.);#49=IFCVERTEXPOINT(#21);#50=IFCCIRCLE(#13,3.);#47=IFCBSPLINESURFACEWITHKNOTS(1,1,((#10,#21),(#21,#10)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,0.),(0.,1.),.UNSPECIFIED.);",
            "#41=IFCADVANCEDBREP(#42);#42=IFCCLOSEDSHELL((#43));#43=IFCADVANCEDFACE((#44),#47,.T.);#44=IFCFACEOUTERBOUND(#45,.T.);#45=IFCEDGELOOP((#46));#46=IFCORIENTEDEDGE(*,*,#48,.T.);#48=IFCEDGECURVE(#49,#49,#50,.T.);#49=IFCVERTEXPOINT(#21);#50=IFCCIRCLE(#13,1.E300);#47=IFCTOROIDALSURFACE(#13,1.,1.E300);",
            "#41=IFCSWEPTDISKSOLID(#92,0.1,$,IFCLENGTHMEASURE(1.E300),-5.);",
            "#41=IFCSWEPTDISKSOLID(#42,0.1,$,0.5,0.7);#42=IFCTRIMMEDCURVE(#43,(IFCPARAMETERVALUE(0.)),(#10),.F.,.PARAMETER.);#43=IFCBSPLINECURVEWITHKNOTS(1,(#10,#21),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.);",
        ];
        for b in bad {
            let _ = import_ifc(file(METRE, b, "#41", "IFCWALL").as_bytes());
        }
        // Raster-Platzierung mit Zyklus und kaputten Achsen.
        let grid = file(METRE, "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);#60=IFCGRIDPLACEMENT(#61,$);#61=IFCVIRTUALGRIDINTERSECTION((#62,#62),(1.,2.));#62=IFCGRIDAXIS('A',#92,.T.);#63=IFCGRID('g',$,$,$,$,#60,$,(#62),(#62),$,$);", "#41", "IFCWALL")
            .replace("#94=IFCWALL('3aBcDeFgHiJkLmNoPqRsTu',$,'Teil',$,$,#30,", "#94=IFCWALL('3aBcDeFgHiJkLmNoPqRsTu',$,'Teil',$,$,#60,");
        assert_eq!(import_ifc(grid.as_bytes()).unwrap().products.len(), 1);
        // Platzierungs-Zyklus.
        let cyc = file(METRE, "#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#41=IFCEXTRUDEDAREASOLID(#40,#13,#11,1.);", "#41", "IFCWALL")
            .replace("#14=IFCLOCALPLACEMENT($,#13);", "#14=IFCLOCALPLACEMENT(#30,#13);");
        let r = import_ifc(cyc.as_bytes()).unwrap();
        assert_eq!(r.products.len(), 1);
    }
}

