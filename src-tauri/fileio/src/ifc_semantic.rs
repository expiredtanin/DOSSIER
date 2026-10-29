// IFC-Import zu echten Bauteilen ([B4], zweite Stufe von [25]): erkennt in einer IFC-Datei Bauteile,
// die sich sicher als Dossier-Objekte abbilden lassen, und liefert deren Kennwerte (Achse, Dicke,
// Höhe, Umriss …) in Metern. Die TS-Seite (`src/io/ifcElements.ts`) baut daraus Wände, Decken,
// Stützen, Öffnungen, Räume und Geschosse; alles andere bleibt Kontext-Mesh (`ifc_import.rs`).
//
// Eigener Code. Erkannt wird über die Form des Körpers (Weltkoordinaten, ohne Öffnungen), nicht über
// den Darstellungstyp — so gilt dasselbe für Extrusionen, B-Reps und Dreiecksnetze:
//   - Wand (IfcWall, IfcWallStandardCase): Grundriss-Hülle → kleinstes umschliessendes Rechteck
//     (Länge ≥ Dicke), unten eben (≥ 60 % des Rechtecks), oben eben auf mindestens 35 % (Giebel- und
//     Pultwände fallen heraus, vom Dach angeschnittene Aussenschichten nicht), Volumen 70–100 % von
//     Rechteck × Höhe (Gehrungen, Schicht-Bänder). Achse = Mittellinie; Enden, die in einer
//     anderen Wand desselben Geschosses liegen, werden auf deren Achse gezogen (L-Ecke, T-Stoss).
//     Schichten aus IfcMaterialLayerSet(Usage) des Bauteils oder seines Typs. Die Seite der ersten
//     Schicht (Dossier: rechts der Achsrichtung): aus IfcMaterialLayerSetUsage, sonst aus einzeln
//     extrudierten Schicht-Bändern, sonst aussen (weg vom Schwerpunkt aller Wände des Geschosses).
//   - Öffnungen der Wand (IfcRelVoidsElement): Körper quaderförmig in Wandrichtung, durch die ganze
//     Wanddicke → Tür (IfcDoor als Füllung), Fenster (IfcWindow) oder Wanddurchbruch (ohne Füllung).
//     Ist eine Öffnung nicht so abbildbar, bleibt die ganze Wand (samt Füllungen) Mesh.
//   - Decke (IfcSlab, nicht Teil eines Daches o. Ä.): senkrechtes Prisma — Ober- und Unterseite
//     eben und gleich gross, Volumen = Fläche × Dicke; ein Umriss, Löcher und durchgehende Öffnungen
//     werden Deckenöffnungen.
//   - Stütze (IfcColumn): Prisma mit Rechteck- oder Kreis-Querschnitt.
//   - Raum (IfcSpace): Prisma mit einem Umriss ohne Löcher; Name (LongName), SIA-416-Kategorie aus
//     der Eigenschaft `SIA416` (Dossier-Export) falls vorhanden.
//   - Geschosse (IfcBuildingStorey): Name, Höhe (Platzierung, sonst Elevation).
//   - Klassifikation (IfcRelAssociatesClassification → IfcClassificationReference, Bauteil oder Typ) an jedem
//     erkannten Bauteil (`Info::classifications`); IfcZone (IfcRelAssignsToGroup) liefert dem Raum die
//     SIA-416-Kategorie, wenn er keine eigene `SIA416`-Eigenschaft trägt.
//
// Unsinn ergibt „nicht erkannt" (bleibt Mesh), nie Panic.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::ifc_import::{class_name, signed_volume, Classification, Mesh, Reader, Rels, V2};
use crate::ifc_step::Value;

/// Höchstzahl Dreiecke je untersuchtem Körper.
const MAX_BODY_TRIS: usize = 400_000;
/// Toleranz für „gleiche Höhe" (m).
const ZTOL: f64 = 1e-4;
/// Rasterweite beim Verschweissen von Punkten (1/m → 0.01 mm).
const WELD: f64 = 1e5;

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct Storey {
    pub id: u64,
    pub global_id: String,
    pub name: String,
    /// Höhe der Geschoss-Platzierung (m).
    pub elevation: f64,
}

/// Eine Materialschicht; `thickness` 0 = einziges Material ohne Schichtdicke (ganze Dicke).
#[derive(Clone, Debug, Default)]
pub struct MatLayer {
    pub material: String,
    pub thickness: f64,
    pub color: Option<[f64; 4]>,
}

/// Gemeinsame Angaben eines erkannten Bauteils.
#[derive(Clone, Debug, Default)]
pub struct Info {
    pub product: u64,
    pub global_id: String,
    pub class: String,
    pub name: Option<String>,
    /// Index in [`Semantic::storeys`].
    pub storey: Option<usize>,
    pub color: Option<[f64; 4]>,
    /// Name des Typs (IfcWallType …) oder des Schichtaufbaus.
    pub type_name: Option<String>,
    pub layers: Vec<MatLayer>,
    /// Klassifikationen (eBKP-H, BKP ...) des Bauteils, sonst seines Typs.
    pub classifications: Vec<Classification>,
    /// Eigenschaften aus `Pset_*Common` (IsExternal, LoadBearing, FireRating, AcousticRating,
    /// ThermalTransmittance, SecurityRating, Reference) als Text; Wahrheitswerte "true"/"false".
    pub common: BTreeMap<String, String>,
}

/// Eigenschaften der gemeinsamen Psets, die ins Modell übernommen werden.
const COMMON_PROPS: [&str; 7] = ["IsExternal", "LoadBearing", "FireRating", "AcousticRating", "ThermalTransmittance", "SecurityRating", "Reference"];

#[derive(Clone, Debug, Default)]
pub struct Wall {
    pub info: Info,
    /// Achse (Mitte der Wanddicke); die erste Schicht liegt rechts der Richtung start → end.
    pub start: V2,
    pub end: V2,
    pub z0: f64,
    pub z1: f64,
    pub thickness: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum OpeningKind {
    #[default]
    Door,
    Window,
    /// Öffnung ohne Füllung.
    Hole,
}

#[derive(Clone, Debug, Default)]
pub struct Opening {
    /// Füllung (Tür/Fenster), bei `Hole` die IfcOpeningElement.
    pub info: Info,
    /// Index in [`Semantic::walls`].
    pub host: usize,
    pub kind: OpeningKind,
    /// Abstand vom Wand-Start entlang der Achse (m).
    pub position: f64,
    pub width: f64,
    /// Brüstung über Wand-Unterkante.
    pub sill: f64,
    pub height: f64,
    /// Ausführung: IfcDoorTypeOperationEnum (Tür) bzw. IfcWindowTypePartitioningEnum (Fenster) vom
    /// Bauteil, sonst vom Typ (IfcDoorType/IfcWindowType, IFC2x3 IfcDoorStyle/IfcWindowStyle);
    /// NOTDEFINED/USERDEFINED → `None`.
    pub operation: Option<String>,
    /// Tür: Aufschlag (+Y der Tür-Platzierung, IFC) links (+1) bzw. rechts (−1) der Wandachse; 0 = unbekannt.
    pub swing: i8,
    /// Tür: Scharnier am Wandanfang (+1) bzw. -ende (−1) nach LEFT/RIGHT der Ausführung (IFC: von der
    /// Aufschlagseite gesehen; LEFT = Scharnier auf +X der Tür-Platzierung); 0 = unbekannt.
    pub hinge: i8,
}

#[derive(Clone, Debug, Default)]
pub struct Slab {
    pub info: Info,
    pub outline: Vec<V2>,
    pub holes: Vec<Vec<V2>>,
    pub z0: f64,
    pub z1: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Profile {
    Rect { width: f64, depth: f64 },
    Round { radius: f64 },
}

#[derive(Clone, Debug)]
pub struct Column {
    pub info: Info,
    pub center: V2,
    /// Drehung des Rechtecks (rad, Breite entlang der gedrehten x-Achse).
    pub rotation: f64,
    pub profile: Profile,
    pub z0: f64,
    pub z1: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Space {
    pub info: Info,
    pub long_name: Option<String>,
    pub sia: Option<String>,
    pub boundary: Vec<V2>,
    pub z0: f64,
    pub z1: f64,
}

/// Erkannte Bauteile einer Datei.
#[derive(Clone, Debug, Default)]
pub struct Semantic {
    /// Nach Höhe sortiert.
    pub storeys: Vec<Storey>,
    pub walls: Vec<Wall>,
    pub openings: Vec<Opening>,
    pub slabs: Vec<Slab>,
    pub columns: Vec<Column>,
    pub spaces: Vec<Space>,
    /// Kandidaten (Wand, Decke, Stütze, Raum), die nicht sicher abbildbar waren, je Klasse.
    pub kept: BTreeMap<String, usize>,
    /// Bauteile, die nicht mehr als Mesh kommen (erkannte Bauteile, Füllungen, Öffnungen).
    pub converted: HashSet<u64>,
}

// ---------------------------------------------------------------------------
// 2D-Hilfen
// ---------------------------------------------------------------------------

fn sub2(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}
fn dot2(a: V2, b: V2) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn cross2(a: V2, b: V2) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn len2(a: V2) -> f64 {
    a[0].hypot(a[1])
}
fn lerp_dir(o: V2, d: V2, s: f64) -> V2 {
    [o[0] + d[0] * s, o[1] + d[1] * s]
}
/// Linke Normale.
fn left(d: V2) -> V2 {
    [-d[1], d[0]]
}
fn unit2(a: V2) -> Option<V2> {
    let l = len2(a);
    (l.is_finite() && l > 1e-12).then(|| [a[0] / l, a[1] / l])
}
/// Fläche mit Vorzeichen (gegen den Uhrzeigersinn > 0).
fn area2(r: &[V2]) -> f64 {
    let n = r.len();
    (0..n).map(|i| cross2(r[i], r[(i + 1) % n])).sum::<f64>() / 2.0
}

fn weld_key(p: V2) -> (i64, i64) {
    ((p[0] * WELD).round() as i64, (p[1] * WELD).round() as i64)
}

/// Konvexe Hülle (Andrew), gegen den Uhrzeigersinn, ohne kollineare Punkte.
fn convex_hull(pts: &[V2]) -> Vec<V2> {
    let mut seen = HashSet::new();
    let mut p: Vec<V2> = pts.iter().copied().filter(|q| q[0].is_finite() && q[1].is_finite() && seen.insert(weld_key(*q))).collect();
    if p.len() < 3 {
        return p;
    }
    p.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    let mut lower: Vec<V2> = Vec::new();
    for &q in &p {
        while lower.len() >= 2 && cross2(sub2(lower[lower.len() - 1], lower[lower.len() - 2]), sub2(q, lower[lower.len() - 2])) <= 1e-12 {
            lower.pop();
        }
        lower.push(q);
    }
    let mut upper: Vec<V2> = Vec::new();
    for &q in p.iter().rev() {
        while upper.len() >= 2 && cross2(sub2(upper[upper.len() - 1], upper[upper.len() - 2]), sub2(q, upper[upper.len() - 2])) <= 1e-12 {
            upper.pop();
        }
        upper.push(q);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Kleinstes umschliessendes Rechteck: Richtung `d` (entlang der längeren Seite, nach +x bzw. +y
/// gedreht) und Ausdehnung [u0,u1] × [v0,v1] in (d, left(d)).
fn min_area_rect(pts: &[V2]) -> Option<(V2, f64, f64, f64, f64)> {
    let hull = convex_hull(pts);
    if hull.len() < 3 {
        return None;
    }
    let mut best: Option<(f64, V2, f64, f64, f64, f64)> = None;
    for i in 0..hull.len() {
        let Some(d) = unit2(sub2(hull[(i + 1) % hull.len()], hull[i])) else { continue };
        let n = left(d);
        let (mut u0, mut u1, mut v0, mut v1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for &q in &hull {
            let (u, v) = (dot2(q, d), dot2(q, n));
            u0 = u0.min(u);
            u1 = u1.max(u);
            v0 = v0.min(v);
            v1 = v1.max(v);
        }
        let a = (u1 - u0) * (v1 - v0);
        if best.as_ref().is_none_or(|b| a < b.0 * (1.0 - 1e-9)) {
            best = Some((a, d, u0, u1, v0, v1));
        }
    }
    let (_, mut d, mut u0, mut u1, mut v0, mut v1) = best?;
    if v1 - v0 > u1 - u0 {
        // Längere Seite als Richtung: d' = left(d) → u' = v, v' = −u.
        d = left(d);
        let (a0, a1) = (v0, v1);
        v0 = -u1;
        v1 = -u0;
        u0 = a0;
        u1 = a1;
    }
    if d[0] < -1e-9 || (d[0].abs() <= 1e-9 && d[1] < 0.0) {
        d = [-d[0], -d[1]];
        (u0, u1) = (-u1, -u0);
        (v0, v1) = (-v1, -v0);
    }
    Some((d, u0, u1, v0, v1))
}

/// Entfernt doppelte und kollineare Punkte eines geschlossenen Rings.
fn simplify_ring(r: &[V2]) -> Vec<V2> {
    let mut out: Vec<V2> = Vec::with_capacity(r.len());
    for &p in r {
        if out.last().is_none_or(|q| len2(sub2(p, *q)) > 1e-7) {
            out.push(p);
        }
    }
    while out.len() > 1 && len2(sub2(out[0], out[out.len() - 1])) <= 1e-7 {
        out.pop();
    }
    let mut changed = true;
    while changed && out.len() >= 3 {
        changed = false;
        let n = out.len();
        for i in 0..n {
            let (a, b, c) = (out[(i + n - 1) % n], out[i], out[(i + 1) % n]);
            let (ab, bc) = (sub2(b, a), sub2(c, b));
            if cross2(ab, bc).abs() <= 1e-9 * (len2(ab) * len2(bc)).max(1e-12) && dot2(ab, bc) >= 0.0 {
                out.remove(i);
                changed = true;
                break;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Körperform
// ---------------------------------------------------------------------------

/// Kennwerte eines (möglichen) senkrechten Prismas.
struct Shape {
    z0: f64,
    z1: f64,
    /// Fläche der nach oben zeigenden Dreiecke auf z1 bzw. nach unten auf z0.
    top_area: f64,
    bottom_area: f64,
    volume: f64,
    /// Randschleifen der Oberseite (aussen gegen den Uhrzeigersinn, Löcher im Uhrzeigersinn).
    loops: Vec<Vec<V2>>,
    /// Alle Punkte im Grundriss.
    plan: Vec<V2>,
}

fn shape(m: &Mesh) -> Option<Shape> {
    if m.indices.len() < 12 || m.positions.len() < 12 {
        return None;
    }
    let (mut z0, mut z1) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut plan = Vec::with_capacity(m.positions.len() / 3);
    for c in m.positions.chunks_exact(3) {
        if !(c[0].is_finite() && c[1].is_finite() && c[2].is_finite()) {
            return None;
        }
        z0 = z0.min(c[2]);
        z1 = z1.max(c[2]);
        plan.push([c[0], c[1]]);
    }
    if !(z1 - z0 > 1e-3) {
        return None;
    }
    let p = |i: u32| -> Option<[f64; 3]> {
        let k = i as usize * 3;
        m.positions.get(k..k + 3).map(|s| [s[0], s[1], s[2]])
    };
    let (mut top_area, mut bottom_area) = (0.0, 0.0);
    let mut top: Vec<[V2; 3]> = Vec::new();
    for t in m.indices.chunks_exact(3) {
        let (a, b, c) = (p(t[0])?, p(t[1])?, p(t[2])?);
        let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        let at = |z: f64| (a[2] - z).abs() <= ZTOL && (b[2] - z).abs() <= ZTOL && (c[2] - z).abs() <= ZTOL;
        if at(z1) && nz > 0.0 {
            top_area += nz / 2.0;
            top.push([[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]]);
        } else if at(z0) && nz < 0.0 {
            bottom_area -= nz / 2.0;
        }
    }
    Some(Shape { z0, z1, top_area, bottom_area, volume: signed_volume(&m.positions, &m.indices), loops: boundary_loops(&top), plan })
}

/// Randschleifen einer Dreiecksmenge (gleich orientiert): Kanten ohne Gegenkante, verkettet.
fn boundary_loops(tris: &[[V2; 3]]) -> Vec<Vec<V2>> {
    let mut index: HashMap<(i64, i64), usize> = HashMap::new();
    let mut pts: Vec<V2> = Vec::new();
    let mut id = |p: V2| -> usize {
        *index.entry(weld_key(p)).or_insert_with(|| {
            pts.push(p);
            pts.len() - 1
        })
    };
    let mut edges: HashMap<(usize, usize), i32> = HashMap::new();
    for t in tris {
        let (a, b, c) = (id(t[0]), id(t[1]), id(t[2]));
        if a == b || b == c || a == c {
            continue;
        }
        for (u, v) in [(a, b), (b, c), (c, a)] {
            match edges.get_mut(&(v, u)) {
                Some(n) if *n > 0 => *n -= 1,
                _ => *edges.entry((u, v)).or_insert(0) += 1,
            }
        }
    }
    let mut next: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut count = 0;
    let mut keys: Vec<(usize, usize)> = edges.iter().filter(|(_, n)| **n > 0).map(|(k, _)| *k).collect();
    keys.sort_unstable();
    for (u, v) in keys {
        next.entry(u).or_default().push(v);
        count += 1;
    }
    let mut loops = Vec::new();
    let mut starts: Vec<usize> = next.keys().copied().collect();
    starts.sort_unstable();
    for s in starts {
        while next.get(&s).is_some_and(|l| !l.is_empty()) {
            let mut ring = vec![pts[s]];
            let mut cur = s;
            let mut ok = false;
            for _ in 0..=count {
                let Some(v) = next.get_mut(&cur).and_then(|l| l.pop()) else { break };
                if v == s {
                    ok = true;
                    break;
                }
                ring.push(pts[v]);
                cur = v;
            }
            if ok {
                let r = simplify_ring(&ring);
                if r.len() >= 3 {
                    loops.push(r);
                }
            }
        }
    }
    loops
}

/// Senkrechtes Prisma: Ober-/Unterseite gleich, Volumen = Fläche × Höhe. Liefert Umriss (aussen,
/// gegen den Uhrzeigersinn) und Löcher; `None`, wenn nicht so oder mehr als ein Umriss.
fn prism(s: &Shape) -> Option<(Vec<V2>, Vec<Vec<V2>>)> {
    let h = s.z1 - s.z0;
    let a = s.top_area;
    if !(a > 1e-4 && (s.bottom_area - a).abs() <= 0.01 * a && (s.volume - a * h).abs() <= 0.01 * a * h) {
        return None;
    }
    let mut outer: Option<Vec<V2>> = None;
    let mut holes = Vec::new();
    for l in &s.loops {
        if area2(l) > 0.0 {
            if outer.is_some() {
                return None;
            }
            outer = Some(l.clone());
        } else {
            holes.push(l.iter().rev().copied().collect::<Vec<V2>>());
        }
    }
    let outer = outer?;
    // Flächen der Schleifen müssen die Oberseite ergeben.
    let sum = area2(&outer) - holes.iter().map(|h| area2(h)).sum::<f64>();
    ((sum - a).abs() <= 0.01 * a).then_some((outer, holes))
}

/// Ausdehnung eines Körpers im Rahmen (Ursprung `o`, Richtung `d`, Normale `left(d)`):
/// [u0,u1,v0,v1,z0,z1] und Füllgrad (Volumen / Quader).
fn box_in_frame(m: &Mesh, o: V2, d: V2) -> Option<([f64; 6], f64)> {
    let n = left(d);
    let mut b = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
    for c in m.positions.chunks_exact(3) {
        let q = sub2([c[0], c[1]], o);
        let (u, v) = (dot2(q, d), dot2(q, n));
        b[0] = b[0].min(u);
        b[1] = b[1].max(u);
        b[2] = b[2].min(v);
        b[3] = b[3].max(v);
        b[4] = b[4].min(c[2]);
        b[5] = b[5].max(c[2]);
    }
    let bv = (b[1] - b[0]) * (b[3] - b[2]) * (b[5] - b[4]);
    if !(bv.is_finite() && bv > 1e-9) {
        return None;
    }
    Some((b, signed_volume(&m.positions, &m.indices) / bv))
}

// ---------------------------------------------------------------------------
// Erkennung
// ---------------------------------------------------------------------------

/// Wand in Arbeit (vor dem Ziehen der Enden).
struct WallCand {
    info: Info,
    start: V2,
    end: V2,
    z0: f64,
    z1: f64,
    thickness: f64,
    /// Öffnungen: (IfcOpeningElement, Füllung, Art, Körper).
    openings: Vec<(u64, Option<u64>, OpeningKind, Mesh)>,
    /// Seite der ersten Schicht laut IfcMaterialLayerSetUsage: Richtung in Weltkoordinaten.
    usage_side: Option<V2>,
    /// Darstellungselemente einzeln (Schicht-Bänder).
    items: Vec<Mesh>,
}

struct Ctx<'r, 'a> {
    r: &'r mut Reader<'a>,
    rels: &'r Rels,
    type_of: HashMap<u64, u64>,
    fills: HashMap<u64, Vec<u64>>,
    sia: HashMap<u64, String>,
    common: HashMap<u64, BTreeMap<String, String>>,
    storey_index: HashMap<u64, usize>,
}

impl Ctx<'_, '_> {
    /// Ausführung, Aufschlagseite und Scharnier einer Tür/eines Fensters (s. [`Opening`]); `d` =
    /// Richtung der (endgültigen) Wandachse.
    fn operation(&mut self, id: u64, d: V2) -> (Option<String>, i8, i8) {
        let f = self.r.f;
        let Some(e) = f.get(id) else { return (None, 0, 0) };
        let pick = |v: Option<&Value>| v.and_then(|v| v.as_enum()).filter(|x| *x != "NOTDEFINED" && *x != "USERDEFINED").map(str::to_string);
        // IFC4: IfcDoor.OperationType / IfcWindow.PartitioningType (12. Attribut).
        let own = if e.ty.starts_with("IFCDOOR") || e.ty.starts_with("IFCWINDOW") { pick(e.arg(11)) } else { None };
        let op = own.or_else(|| {
            let t = f.get(*self.type_of.get(&id)?)?;
            match t.ty.as_str() {
                "IFCDOORTYPE" | "IFCWINDOWTYPE" => pick(t.arg(10)),
                "IFCDOORSTYLE" => pick(t.arg(8)),
                "IFCWINDOWSTYLE" => pick(t.arg(9)),
                _ => None,
            }
        });
        // Seite nur mit bekannter Ausführung (ohne sie ist die Platzierung oft einfach die der Wand).
        if !e.ty.starts_with("IFCDOOR") || op.is_none() {
            return (op, 0, 0);
        }
        let Some(place) = e.arg(5).and_then(|v| v.as_ref_id()) else { return (op, 0, 0) };
        let xf = self.r.object_placement(place, 0);
        let x = xf.apply_dir([1.0, 0.0, 0.0]);
        let y = xf.apply_dir([0.0, 1.0, 0.0]);
        let (Some(x), Some(y)) = (unit2([x[0], x[1]]), unit2([y[0], y[1]])) else { return (op, 0, 0) };
        let side = |v: f64| if v > 0.5 { 1 } else if v < -0.5 { -1 } else { 0 };
        let swing = side(dot2(y, left(d)));
        let hinge = match op.as_deref() {
            Some(o) if !o.starts_with("DOUBLE_DOOR") && (o.ends_with("LEFT") || o.ends_with("RIGHT")) => {
                let h = if o.ends_with("LEFT") { x } else { [-x[0], -x[1]] };
                -side(dot2(h, d))
            }
            _ => 0,
        };
        (op, swing, hinge)
    }

    fn info(&self, id: u64, color: Option<[f64; 4]>) -> Info {
        let f = self.r.f;
        let Some(e) = f.get(id) else { return Info::default() };
        let mat = self.material_id(id);
        let (layers, _, set_name) = self.layers(id);
        let type_name = self
            .type_of
            .get(&id)
            .and_then(|t| f.get(*t))
            .and_then(|t| t.arg(2))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or(set_name);
        Info {
            product: id,
            global_id: e.arg(0).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            class: class_name(&e.ty),
            name: e.arg(2).and_then(|v| v.as_str()).map(str::to_string),
            storey: self.rels.storey_id(f, id).and_then(|s| self.storey_index.get(&s).copied()),
            color: color.or_else(|| mat.and_then(|m| self.rels.resolve_material_color(f, m))),
            type_name,
            layers,
            classifications: {
                let own = self.rels.classifications(f, id);
                if own.is_empty() {
                    self.type_of.get(&id).map(|t| self.rels.classifications(f, *t)).unwrap_or_default()
                } else {
                    own
                }
            },
            common: self.common.get(&id).cloned().unwrap_or_default(),
        }
    }

    /// SIA-416-Kategorie eines Raums aus seinen Zonen (IfcZone über IfcRelAssignsToGroup): Eigenschaft
    /// `SIA416` der Zone (Dossier-Export), sonst der Zonenname, wenn er eine Kategorie ist.
    fn zone_sia(&self, id: u64) -> Option<String> {
        let f = self.r.f;
        for g in self.rels.groups_of.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
            let Some(z) = f.get(*g) else { continue };
            if z.ty != "IFCZONE" {
                continue;
            }
            if let Some(v) = self.sia.get(g) {
                return Some(v.clone());
            }
            let name = z.arg(2).and_then(|v| v.as_str()).unwrap_or("").trim().to_uppercase();
            // SIA 416 schreibt KF; unser Modell heisst KGF.
            let name = if name == "KF" { "KGF".to_string() } else { name };
            if ["HNF", "NNF", "VF", "FF", "KGF", "AGF"].contains(&name.as_str()) {
                return Some(name);
            }
        }
        None
    }

    /// Material des Bauteils, sonst seines Typs.
    fn material_id(&self, id: u64) -> Option<u64> {
        self.rels.material_of.get(&id).or_else(|| self.type_of.get(&id).and_then(|t| self.rels.material_of.get(t))).copied()
    }

    /// Schichten, Richtungssinn (POSITIVE = true) der IfcMaterialLayerSetUsage, Name des Aufbaus.
    fn layers(&self, id: u64) -> (Vec<MatLayer>, Option<bool>, Option<String>) {
        let f = self.r.f;
        let scale = self.r.len_scale;
        let Some(mut m) = self.material_id(id) else { return (Vec::new(), None, None) };
        let mut sense = None;
        let mat_name = |mid: Option<u64>| -> Option<(String, Option<[f64; 4]>)> {
            let mid = mid?;
            let e = f.get(mid)?;
            (e.ty == "IFCMATERIAL").then(|| (e.arg(0).and_then(|v| v.as_str()).unwrap_or("").to_string(), self.rels.resolve_material_color(f, mid)))
        };
        let single = |mid: Option<u64>| -> Vec<MatLayer> {
            mat_name(mid).map(|(material, color)| vec![MatLayer { material, thickness: 0.0, color }]).unwrap_or_default()
        };
        for _ in 0..4 {
            let Some(e) = f.get(m) else { break };
            match e.ty.as_str() {
                "IFCMATERIALLAYERSETUSAGE" => {
                    sense = e.arg(2).and_then(|v| v.as_enum()).map(|s| s != "NEGATIVE");
                    match e.arg(0).and_then(|v| v.as_ref_id()) {
                        Some(n) => m = n,
                        None => break,
                    }
                }
                "IFCMATERIALLAYERSET" => {
                    let mut out = Vec::new();
                    for l in e.arg(0).and_then(|v| v.as_list()).unwrap_or(&[]) {
                        let Some(le) = l.as_ref_id().and_then(|i| f.get(i)) else { continue };
                        if le.ty != "IFCMATERIALLAYER" {
                            continue;
                        }
                        let t = le.arg(1).and_then(|v| v.as_f64()).map(|t| t * scale).unwrap_or(0.0);
                        let (material, color) = mat_name(le.arg(0).and_then(|v| v.as_ref_id())).unwrap_or_default();
                        if t.is_finite() && t >= 0.0 {
                            out.push(MatLayer { material, thickness: t, color });
                        }
                    }
                    let name = e.arg(1).and_then(|v| v.as_str()).map(str::to_string);
                    return (out, sense, name);
                }
                "IFCMATERIAL" => return (single(Some(m)), sense, None),
                "IFCMATERIALLIST" => {
                    return (single(e.arg(0).and_then(|v| v.as_list()).and_then(|l| l.first()).and_then(|v| v.as_ref_id())), sense, None)
                }
                "IFCMATERIALCONSTITUENTSET" | "IFCMATERIALPROFILESET" => {
                    let first = e.arg(2).and_then(|v| v.as_list()).and_then(|l| l.first()).and_then(|v| v.as_ref_id()).and_then(|i| f.get(i));
                    let name = e.arg(0).and_then(|v| v.as_str()).map(str::to_string);
                    return (single(first.and_then(|c| c.arg(2)).and_then(|v| v.as_ref_id())), sense, name);
                }
                "IFCMATERIALPROFILESETUSAGE" => match e.arg(0).and_then(|v| v.as_ref_id()) {
                    Some(n) => m = n,
                    None => break,
                },
                _ => break,
            }
        }
        (Vec::new(), sense, None)
    }

    fn body(&mut self, id: u64) -> Option<(Mesh, Option<[f64; 4]>)> {
        let (m, c) = self.r.product_body(id, MAX_BODY_TRIS)?;
        (!m.is_empty() && m.triangle_count() <= MAX_BODY_TRIS).then_some((m, c))
    }

    /// Wand aus dem Körper; `None` = nicht sicher abbildbar.
    fn wall(&mut self, id: u64) -> Option<WallCand> {
        let (mesh, color) = self.body(id)?;
        let s = shape(&mesh)?;
        let (d, u0, u1, v0, v1) = min_area_rect(&s.plan)?;
        let (len, t, h) = (u1 - u0, v1 - v0, s.z1 - s.z0);
        if !(t >= 0.01 && t <= 2.0 && len >= t.max(0.05) && h >= 0.05) {
            return None;
        }
        let rect = len * t;
        let ratio = s.volume / (rect * h);
        if !((0.7..=1.0 + 1e-3).contains(&ratio) && s.top_area >= 0.35 * rect && s.bottom_area >= 0.6 * rect) {
            return None;
        }
        let n = left(d);
        let vc = (v0 + v1) / 2.0;
        let base = [n[0] * vc, n[1] * vc];
        let start = lerp_dir(base, d, u0);
        let end = lerp_dir(base, d, u1);

        // Öffnungen: quaderförmig, durch die ganze Wand, Füllung Tür/Fenster oder keine.
        let mut openings = Vec::new();
        for &o in self.rels.voids.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
            let (om, _) = self.body(o)?;
            let (b, fill) = box_in_frame(&om, start, d)?;
            let through = b[2] <= -t / 2.0 + 1e-3 && b[3] >= t / 2.0 - 1e-3;
            let inside = b[0] >= -0.01 && b[1] <= len + 0.01 && b[5] > s.z0 + 0.01 && b[4] < s.z1 - 0.01;
            if !(through && inside && (0.95..=1.0 + 1e-3).contains(&fill)) {
                return None;
            }
            let fillings = self.fills.get(&o).cloned().unwrap_or_default();
            let (filling, kind) = match fillings.as_slice() {
                [] => (None, OpeningKind::Hole),
                [x] => {
                    let ty = self.r.f.get(*x).map(|e| e.ty.as_str()).unwrap_or("");
                    if ty.starts_with("IFCDOOR") {
                        (Some(*x), OpeningKind::Door)
                    } else if ty.starts_with("IFCWINDOW") {
                        (Some(*x), OpeningKind::Window)
                    } else {
                        return None;
                    }
                }
                _ => return None,
            };
            openings.push((o, filling, kind, om));
        }

        let (layers, sense, _) = self.layers(id);
        // IfcMaterialLayerSetUsage: Schichten ab der Referenzlinie in +y (POSITIVE) bzw. −y der
        // Bauteil-Platzierung → erste Schicht auf der −y- bzw. +y-Seite.
        let usage_side = match (sense, layers.len() > 1) {
            (Some(pos), true) => {
                let f = self.r.f;
                let place = f.get(id).and_then(|e| e.arg(5)).and_then(|v| v.as_ref_id());
                let xf = place.map(|p| self.r.object_placement(p, 0));
                xf.and_then(|x| {
                    let y = x.apply_dir([0.0, 1.0, 0.0]);
                    unit2([y[0], y[1]]).map(|y| if pos { [-y[0], -y[1]] } else { y })
                })
            }
            _ => None,
        };
        let items = if layers.len() > 1 && usage_side.is_none() { self.r.product_item_meshes(id, MAX_BODY_TRIS) } else { Vec::new() };
        Some(WallCand { info: self.info(id, color), start, end, z0: s.z0, z1: s.z1, thickness: t, openings, usage_side, items })
    }

    fn slab(&mut self, id: u64) -> Option<Slab> {
        let (mesh, color) = self.body(id)?;
        let s = shape(&mesh)?;
        if s.z1 - s.z0 > 3.0 {
            return None;
        }
        let (outline, mut holes) = prism(&s)?;
        for &o in self.rels.voids.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
            if self.fills.get(&o).is_some_and(|l| !l.is_empty()) {
                return None;
            }
            let (om, _) = self.body(o)?;
            let os = shape(&om)?;
            if !(os.z0 <= s.z0 + 1e-3 && os.z1 >= s.z1 - 1e-3) {
                return None;
            }
            let (ring, inner) = prism(&os)?;
            if !inner.is_empty() {
                return None;
            }
            holes.push(ring);
        }
        Some(Slab { info: self.info(id, color), outline, holes, z0: s.z0, z1: s.z1 })
    }

    fn column(&mut self, id: u64) -> Option<Column> {
        let (mesh, color) = self.body(id)?;
        let s = shape(&mesh)?;
        let (ring, holes) = prism(&s)?;
        if !holes.is_empty() {
            return None;
        }
        let n = ring.len();
        let c = ring.iter().fold([0.0, 0.0], |a, p| [a[0] + p[0] / n as f64, a[1] + p[1] / n as f64]);
        let profile;
        let mut rotation = 0.0;
        let mut center = c;
        if n == 4 {
            let e: Vec<V2> = (0..4).map(|i| sub2(ring[(i + 1) % 4], ring[i])).collect();
            let square = (0..4).all(|i| dot2(e[i], e[(i + 1) % 4]).abs() <= 1e-6 * len2(e[i]) * len2(e[(i + 1) % 4]));
            if !square {
                return None;
            }
            // Breite entlang der Kante, deren Winkel am nächsten bei 0 liegt.
            let pick = (0..2).min_by(|&i, &j| {
                let a = |k: usize| e[k][1].atan2(e[k][0]).rem_euclid(std::f64::consts::PI);
                let dist = |x: f64| x.min(std::f64::consts::PI - x);
                dist(a(i)).total_cmp(&dist(a(j)))
            })?;
            let mut ang = e[pick][1].atan2(e[pick][0]).rem_euclid(std::f64::consts::PI);
            if ang > std::f64::consts::FRAC_PI_2 {
                ang -= std::f64::consts::PI;
            }
            rotation = if ang.abs() < 1e-9 { 0.0 } else { ang };
            profile = Profile::Rect { width: len2(e[pick]), depth: len2(e[(pick + 1) % 4]) };
        } else if n >= 8 {
            let rs: Vec<f64> = ring.iter().map(|p| len2(sub2(*p, c))).collect();
            let r = rs.iter().sum::<f64>() / n as f64;
            if !(r > 1e-3 && rs.iter().all(|x| (x - r).abs() <= 0.01 * r)) {
                return None;
            }
            center = c;
            profile = Profile::Round { radius: rs.iter().copied().fold(0.0, f64::max) };
        } else {
            return None;
        }
        Some(Column { info: self.info(id, color), center, rotation, profile, z0: s.z0, z1: s.z1 })
    }

    fn space(&mut self, id: u64) -> Option<Space> {
        let (mesh, color) = self.body(id)?;
        let s = shape(&mesh)?;
        let (boundary, holes) = prism(&s)?;
        if !holes.is_empty() {
            return None;
        }
        let f = self.r.f;
        let long_name = f.get(id).and_then(|e| e.arg(7)).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
        Some(Space { info: self.info(id, color), long_name, sia: self.sia.get(&id).cloned().or_else(|| self.zone_sia(id)), boundary, z0: s.z0, z1: s.z1 })
    }
}

/// Zieht Wand-Enden, die in einer anderen Wand desselben Geschosses liegen, auf deren Achse.
fn snap_ends(walls: &mut [WallCand]) {
    let orig: Vec<(V2, V2, f64)> = walls.iter().map(|w| (w.start, w.end, w.thickness)).collect();
    for i in 0..walls.len() {
        let (a, b, ti) = orig[i];
        let Some(di) = unit2(sub2(b, a)) else { continue };
        let li = len2(sub2(b, a));
        for end in 0..2 {
            let p = if end == 0 { a } else { b };
            let mut best: Option<(f64, V2)> = None;
            for (j, &(c, e, tj)) in orig.iter().enumerate() {
                if i == j
                    || walls[i].info.storey != walls[j].info.storey
                    || walls[i].z1.min(walls[j].z1) - walls[i].z0.max(walls[j].z0) < 0.01
                {
                    continue;
                }
                let Some(dj) = unit2(sub2(e, c)) else { continue };
                let lj = len2(sub2(e, c));
                let sin = cross2(di, dj);
                if sin.abs() < 0.17 {
                    continue;
                }
                let s = cross2(sub2(c, a), dj) / sin;
                let x = lerp_dir(a, di, s);
                let dist = len2(sub2(p, x));
                if dist > tj / 2.0 / sin.abs() + 0.03 {
                    continue;
                }
                // Schnittpunkt auf der anderen Wand (verlängert um die halbe eigene Dicke) und auf
                // der richtigen Hälfte der eigenen Wand.
                let tx = dot2(sub2(x, c), dj);
                let reach = ti / 2.0 / sin.abs() + 0.03;
                if tx < -reach || tx > lj + reach || (end == 0 && s > li / 2.0) || (end == 1 && s < li / 2.0) {
                    continue;
                }
                if best.is_none_or(|(bd, _)| dist < bd) {
                    best = Some((dist, x));
                }
            }
            if let Some((_, x)) = best {
                if end == 0 {
                    walls[i].start = x;
                } else {
                    walls[i].end = x;
                }
            }
        }
    }
}

/// Seite der ersten Schicht als Vorzeichen bezüglich `left(d)`: +1 links, −1 rechts, 0 unbekannt —
/// aus einzeln extrudierten Schicht-Bändern (jedes Band = genau eine Schicht).
fn side_from_bands(w: &WallCand, d: V2) -> i32 {
    let total: f64 = w.info.layers.iter().map(|l| l.thickness).sum();
    if w.items.len() < 2 || (total - w.thickness).abs() > 0.005 {
        return 0;
    }
    let mid = [(w.start[0] + w.end[0]) / 2.0, (w.start[1] + w.end[1]) / 2.0];
    // Grenzen der Schichten, erste Schicht links (+v) bzw. rechts (−v).
    let bands = |sign: f64| -> Vec<(f64, f64)> {
        let mut acc = total / 2.0;
        w.info
            .layers
            .iter()
            .map(|l| {
                let (o0, o1) = (acc - l.thickness, acc);
                acc -= l.thickness;
                if sign > 0.0 { (o0, o1) } else { (-o1, -o0) }
            })
            .collect()
    };
    let score = |b: &[(f64, f64)]| -> usize {
        w.items
            .iter()
            .filter_map(|m| box_in_frame(m, mid, d))
            .filter(|(r, _)| b.iter().any(|(o0, o1)| (r[2] - o0).abs() <= 0.002 && (r[3] - o1).abs() <= 0.002))
            .count()
    };
    let (l, r) = (score(&bands(1.0)), score(&bands(-1.0)));
    (l as i32 - r as i32).signum()
}

/// Erkennt alle sicher abbildbaren Bauteile.
pub(crate) fn analyze(r: &mut Reader, rels: &Rels, ids: &[u64]) -> Semantic {
    let f = r.f;
    let refs = |v: Option<&Value>| -> Vec<u64> { v.and_then(|v| v.as_list()).unwrap_or(&[]).iter().filter_map(|x| x.as_ref_id()).collect() };
    let mut type_of = HashMap::new();
    let mut fills: HashMap<u64, Vec<u64>> = HashMap::new();
    let mut sia = HashMap::new();
    let mut common: HashMap<u64, BTreeMap<String, String>> = HashMap::new();
    let mut storeys = Vec::new();
    for &id in ids {
        let Some(e) = f.get(id) else { continue };
        match e.ty.as_str() {
            "IFCRELDEFINESBYTYPE" => {
                if let Some(t) = e.arg(5).and_then(|v| v.as_ref_id()) {
                    for o in refs(e.arg(4)) {
                        type_of.entry(o).or_insert(t);
                    }
                }
            }
            "IFCRELFILLSELEMENT" => {
                if let (Some(o), Some(x)) = (e.arg(4).and_then(|v| v.as_ref_id()), e.arg(5).and_then(|v| v.as_ref_id())) {
                    fills.entry(o).or_default().push(x);
                }
            }
            "IFCRELDEFINESBYPROPERTIES" => {
                let Some(ps) = e.arg(5).and_then(|v| v.as_ref_id()).and_then(|i| f.get(i)) else { continue };
                if ps.ty != "IFCPROPERTYSET" {
                    continue;
                }
                let is_common = ps.arg(2).and_then(|v| v.as_str()).is_some_and(|n| n.starts_with("Pset_") && n.ends_with("Common"));
                for p in refs(ps.arg(4)) {
                    let Some(pe) = f.get(p) else { continue };
                    if is_common && pe.ty == "IFCPROPERTYSINGLEVALUE" {
                        let name = pe.arg(0).and_then(|v| v.as_str()).unwrap_or("");
                        let inner = match pe.arg(2) {
                            Some(Value::Typed(_, a)) if a.len() == 1 => Some(&a[0]),
                            other => other,
                        };
                        let text = match inner {
                            Some(Value::Enum(e)) if e == "T" => Some("true".to_string()),
                            Some(Value::Enum(e)) if e == "F" => Some("false".to_string()),
                            Some(v) => v.as_str().map(str::to_string).or_else(|| v.as_f64().map(|x| x.to_string())),
                            None => None,
                        };
                        if let (true, Some(text)) = (COMMON_PROPS.contains(&name), text) {
                            for o in refs(e.arg(4)) {
                                common.entry(o).or_default().entry(name.to_string()).or_insert_with(|| text.clone());
                            }
                        }
                        continue;
                    }
                    if pe.ty != "IFCPROPERTYSINGLEVALUE" || pe.arg(0).and_then(|v| v.as_str()) != Some("SIA416") {
                        continue;
                    }
                    let val = match pe.arg(2) {
                        Some(Value::Typed(_, args)) => args.first().and_then(|v| v.as_str()),
                        Some(v) => v.as_str(),
                        None => None,
                    };
                    if let Some(val) = val {
                        for o in refs(e.arg(4)) {
                            sia.entry(o).or_insert_with(|| val.to_string());
                        }
                    }
                }
            }
            "IFCBUILDINGSTOREY" => {
                let elevation = match e.arg(5).and_then(|v| v.as_ref_id()) {
                    Some(p) if f.get(p).is_some() => r.object_placement(p, 0).origin()[2],
                    _ => e.arg(9).and_then(|v| v.as_f64()).map(|z| z * r.len_scale).unwrap_or(0.0),
                };
                if elevation.is_finite() {
                    storeys.push(Storey {
                        id,
                        global_id: e.arg(0).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        name: e.arg(2).and_then(|v| v.as_str()).or_else(|| e.arg(7).and_then(|v| v.as_str())).unwrap_or("").to_string(),
                        elevation,
                    });
                }
            }
            _ => {}
        }
    }
    storeys.sort_by(|a, b| a.elevation.total_cmp(&b.elevation));
    let storey_index = storeys.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
    let mut cx = Ctx { r, rels, type_of, fills, sia, common, storey_index };
    let mut out = Semantic { storeys, ..Default::default() };

    let spatial = |id: u64| f.get(id).is_some_and(|e| matches!(e.ty.as_str(), "IFCBUILDINGSTOREY" | "IFCBUILDING" | "IFCSITE" | "IFCSPACE"));
    let mut walls = Vec::new();
    for &id in ids {
        let Some(e) = f.get(id) else { continue };
        let ty = e.ty.as_str();
        let candidate = matches!(ty, "IFCWALL" | "IFCWALLSTANDARDCASE" | "IFCSLAB" | "IFCSLABSTANDARDCASE" | "IFCCOLUMN" | "IFCCOLUMNSTANDARDCASE" | "IFCSPACE");
        let has_shape = e.arg(6).and_then(|v| v.as_ref_id()).and_then(|i| f.get(i)).is_some_and(|s| s.ty == "IFCPRODUCTDEFINITIONSHAPE");
        if !candidate || !has_shape {
            continue;
        }
        // Teil eines anderen Bauteils (Dachplatte, Wand einer Vorhangfassade …) bleibt Mesh.
        let part = rels.parent.get(&id).is_some_and(|p| !spatial(*p));
        let ok = !part
            && match ty {
                "IFCWALL" | "IFCWALLSTANDARDCASE" => cx.wall(id).map(|w| walls.push(w)).is_some(),
                "IFCSLAB" | "IFCSLABSTANDARDCASE" => cx.slab(id).map(|s| out.slabs.push(s)).is_some(),
                "IFCCOLUMN" | "IFCCOLUMNSTANDARDCASE" => cx.column(id).map(|c| out.columns.push(c)).is_some(),
                _ => cx.space(id).map(|s| out.spaces.push(s)).is_some(),
            };
        if ok {
            out.converted.insert(id);
            out.converted.extend(rels.voids.get(&id).map(Vec::as_slice).unwrap_or(&[]));
        } else {
            *out.kept.entry(class_name(ty)).or_insert(0) += 1;
        }
    }

    snap_ends(&mut walls);
    // Schwerpunkt der Wände je Geschoss (für „aussen").
    let mut centers: HashMap<Option<usize>, (V2, f64)> = HashMap::new();
    for w in &walls {
        let l = len2(sub2(w.end, w.start));
        let e = centers.entry(w.info.storey).or_insert(([0.0, 0.0], 0.0));
        e.0[0] += (w.start[0] + w.end[0]) / 2.0 * l;
        e.0[1] += (w.start[1] + w.end[1]) / 2.0 * l;
        e.1 += l;
    }
    for w in walls {
        let Some(d) = unit2(sub2(w.end, w.start)) else { continue };
        let n = left(d);
        let asymmetric = {
            let l = &w.info.layers;
            (0..l.len()).any(|i| (l[i].thickness - l[l.len() - 1 - i].thickness).abs() > 1e-6 || l[i].material != l[l.len() - 1 - i].material)
        };
        // Seite der ersten Schicht (+1 = links von d); Dossier legt sie rechts.
        let mut side = 0;
        if asymmetric {
            if let Some(u) = w.usage_side {
                side = dot2(u, n).signum() as i32;
            }
            if side == 0 {
                side = side_from_bands(&w, d);
            }
        }
        if side == 0 {
            // Aussen = weg vom Schwerpunkt aller Wände des Geschosses.
            if let Some((c, l)) = centers.get(&w.info.storey).filter(|(_, l)| *l > 0.0) {
                let mid = [(w.start[0] + w.end[0]) / 2.0, (w.start[1] + w.end[1]) / 2.0];
                let to = sub2(mid, [c[0] / l, c[1] / l]);
                side = if dot2(to, n) > 1e-9 { 1 } else { -1 };
            }
        }
        let (start, end) = if side > 0 { (w.end, w.start) } else { (w.start, w.end) };
        let d = if side > 0 { [-d[0], -d[1]] } else { d };
        let host = out.walls.len();
        let len = len2(sub2(end, start));
        for (o, filling, kind, mesh) in &w.openings {
            let Some((b, _)) = box_in_frame(mesh, start, d) else { continue };
            let u0 = b[0].max(0.0);
            let u1 = b[1].min(len);
            let z0 = b[4].max(w.z0);
            let z1 = b[5].min(w.z1);
            let info = cx.info(filling.unwrap_or(*o), None);
            let (operation, swing, hinge) = match filling {
                Some(x) => cx.operation(*x, d),
                None => (None, 0, 0),
            };
            if let Some(x) = filling {
                out.converted.insert(*x);
            }
            out.openings.push(Opening {
                info,
                host,
                kind: *kind,
                position: u0,
                width: u1 - u0,
                sill: z0 - w.z0,
                height: z1 - z0,
                operation,
                swing,
                hinge,
            });
        }
        out.walls.push(Wall { info: w.info, start, end, z0: w.z0, z1: w.z1, thickness: w.thickness });
    }
    out
}

// ---------------------------------------------------------------------------
// Flache Kodierung für JS: Texte/Verweise als JSON, Zahlen in einem Float64Array.
//   wall:    sx, sy, ex, ey, z0, z1, thickness
//   opening: position, width, sill, height, swing (±1/0), hinge (±1/0)
//   slab:    z0, z1, nRings, (nPts, x, y, …)*   (erster Ring = Umriss)
//   column:  cx, cy, rotation, z0, z1, a, b      (rect: Breite, Tiefe; round: Radius, 0)
//   space:   z0, z1, nPts, x, y, …
// ---------------------------------------------------------------------------

#[cfg(feature = "web")]
pub(crate) fn encode(s: &Semantic) -> (serde_json::Value, Vec<f64>) {
    use serde_json::json;
    let mut data: Vec<f64> = Vec::new();
    let mut elements = Vec::new();
    let info = |i: &Info| {
        json!({
            "globalId": i.global_id,
            "ifcClass": i.class,
            "name": i.name,
            "storey": i.storey,
            "color": i.color,
            "typeName": i.type_name,
            "layers": i.layers.iter().map(|l| json!({ "material": l.material, "thickness": l.thickness, "color": l.color })).collect::<Vec<_>>(),
            "classifications": crate::ifc_import::classifications_json(&i.classifications),
            "common": i.common,
        })
    };
    let mut push = |kind: &str, i: &Info, extra: serde_json::Value, nums: Vec<f64>, data: &mut Vec<f64>| {
        let mut v = info(i);
        let at = data.len();
        data.extend(nums);
        v["kind"] = json!(kind);
        v["at"] = json!(at);
        v["n"] = json!(data.len() - at);
        if let (Some(o), Some(x)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in x {
                o.insert(k.clone(), val.clone());
            }
        }
        elements.push(v);
    };
    let ring = |r: &[V2], out: &mut Vec<f64>| {
        out.push(r.len() as f64);
        for p in r {
            out.extend_from_slice(p);
        }
    };
    for w in &s.walls {
        push("wall", &w.info, json!({}), vec![w.start[0], w.start[1], w.end[0], w.end[1], w.z0, w.z1, w.thickness], &mut data);
    }
    for o in &s.openings {
        let kind = match o.kind {
            OpeningKind::Door => "door",
            OpeningKind::Window => "window",
            OpeningKind::Hole => "hole",
        };
        push(
            "opening",
            &o.info,
            json!({ "host": o.host, "openingKind": kind, "operation": o.operation }),
            vec![o.position, o.width, o.sill, o.height, o.swing as f64, o.hinge as f64],
            &mut data,
        );
    }
    for sl in &s.slabs {
        let mut nums = vec![sl.z0, sl.z1, (1 + sl.holes.len()) as f64];
        ring(&sl.outline, &mut nums);
        for h in &sl.holes {
            ring(h, &mut nums);
        }
        push("slab", &sl.info, json!({}), nums, &mut data);
    }
    for c in &s.columns {
        let (kind, a, b) = match c.profile {
            Profile::Rect { width, depth } => ("rect", width, depth),
            Profile::Round { radius } => ("round", radius, 0.0),
        };
        push("column", &c.info, json!({ "profile": kind }), vec![c.center[0], c.center[1], c.rotation, c.z0, c.z1, a, b], &mut data);
    }
    for sp in &s.spaces {
        let mut nums = vec![sp.z0, sp.z1];
        ring(&sp.boundary, &mut nums);
        push("space", &sp.info, json!({ "longName": sp.long_name, "sia": sp.sia }), nums, &mut data);
    }
    let storeys: Vec<_> = s.storeys.iter().map(|st| json!({ "globalId": st.global_id, "name": st.name, "elevation": st.elevation })).collect();
    // Nicht endliche Zahlen gäbe es nur bei Unsinn; JSON/JS-Seite verwirft sie.
    for v in data.iter_mut() {
        if !v.is_finite() {
            *v = 0.0;
        }
    }
    (json!({ "storeys": storeys, "elements": elements, "kept": s.kept }), data)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ifc_import::import_ifc_opts;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-6
    }
    fn close2(a: V2, b: V2) -> bool {
        close(a[0], b[0]) && close(a[1], b[1])
    }

    /// Gerüst: Projekt in `unit`, Gebäude, Geschosse EG (z = 0) und OG (z = 3), dazu `body`.
    fn file(unit: &str, body: &str) -> String {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0proj',$,'P',$,$,$,$,$,#2);\n#2=IFCUNITASSIGNMENT((#3,#4));\n{unit}\n\
#4=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n\
#10=IFCCARTESIANPOINT((0.,0.,0.));\n#11=IFCDIRECTION((0.,0.,1.));\n#12=IFCDIRECTION((1.,0.,0.));\n\
#13=IFCAXIS2PLACEMENT3D(#10,$,$);\n#14=IFCLOCALPLACEMENT($,#13);\n\
#20=IFCBUILDING('0bldg',$,'B',$,$,#14,$,$,.ELEMENT.,$,$,$);\n\
#22=IFCLOCALPLACEMENT(#14,#13);\n#23=IFCBUILDINGSTOREY('0eg',$,'EG',$,$,#22,$,$,.ELEMENT.,0.);\n\
#24=IFCCARTESIANPOINT((0.,0.,3.));\n#25=IFCAXIS2PLACEMENT3D(#24,$,$);\n#26=IFCLOCALPLACEMENT(#14,#25);\n\
#27=IFCBUILDINGSTOREY('0og',$,'OG',$,$,#26,$,$,.ELEMENT.,3.);\n\
#28=IFCRELAGGREGATES('0agg',$,$,$,#20,(#23,#27));\n\
{body}\n\
ENDSEC;\nEND-ISO-10303-21;\n"
        )
    }
    const METRE: &str = "#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);";
    const MILLI: &str = "#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);";

    /// Rechteck-Extrusion als Bauteil `class` mit id `#n`, Platzierung relativ zu `#22` (EG).
    /// Profil: Mitte (cx,cy), Grösse (x,y), Höhe h, Drehung der Platzierung um z (Richtung dx,dy).
    #[allow(clippy::too_many_arguments)]
    fn rect_product(n: u64, class: &str, at: (f64, f64, f64), dir: (f64, f64), size: (f64, f64), h: f64, extra: &str) -> String {
        let b = n * 10;
        format!(
            "#{p}=IFCCARTESIANPOINT(({x},{y},{z}));#{d}=IFCDIRECTION(({dx},{dy},0.));#{a}=IFCAXIS2PLACEMENT3D(#{p},#11,#{d});\
#{lp}=IFCLOCALPLACEMENT(#22,#{a});#{pp}=IFCCARTESIANPOINT(({cx},{cy}));#{a2}=IFCAXIS2PLACEMENT2D(#{pp},$);\
#{pr}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#{a2},{sx},{sy});#{ex}=IFCEXTRUDEDAREASOLID(#{pr},#13,#11,{h});\
#{rep}=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#{ex}));#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\
#{n}={class}('g{n}',$,'E{n}',$,$,#{lp},#{ps},$,${extra});#{rc}=IFCRELCONTAINEDINSPATIALSTRUCTURE('r{n}',$,$,$,(#{n}),#23);\n",
            p = b + 1,
            d = b + 2,
            a = b + 3,
            lp = b + 4,
            pp = b + 5,
            a2 = b + 6,
            pr = b + 7,
            ex = b + 8,
            rep = b + 9,
            ps = b + 10_000,
            rc = b + 20_000,
            x = at.0,
            y = at.1,
            z = at.2,
            dx = dir.0,
            dy = dir.1,
            cx = size.0 / 2.0,
            cy = 0.0,
            sx = size.0,
            sy = size.1,
        )
    }

    fn sem(src: &str) -> (crate::ifc_import::IfcImport, Semantic) {
        let r = import_ifc_opts(src.as_bytes(), true).expect("lesbar");
        let s = r.elements.clone().expect("Bauteile");
        (r, s)
    }

    #[test]
    fn rectangle_walls_with_l_corner_and_t_junction() {
        // Wand A: (−0.15,0) → (5.15,0), 0.3 dick, 2.5 hoch; Wand B: (5,0) → (5,4), über die Ecke gezogen
        // (Körper bis zur Aussenkante); Wand C: Innenwand x = 2, endet an der Innenfläche von A.
        let a = rect_product(100, "IFCWALL", (-0.15, 0.0, 0.0), (1.0, 0.0), (5.3, 0.3), 2.5, "");
        let b = rect_product(200, "IFCWALLSTANDARDCASE", (5.0, -0.15, 0.0), (0.0, 1.0), (4.15, 0.3), 2.5, "");
        let c = rect_product(300, "IFCWALL", (2.0, 0.15, 0.0), (0.0, 1.0), (2.0, 0.1), 2.5, "");
        let (r, s) = sem(&file(METRE, &format!("{a}{b}{c}")));
        assert_eq!(s.walls.len(), 3, "{:?}", s.kept);
        assert!(r.products.is_empty(), "erkannte Wände nicht als Mesh");
        assert_eq!(s.storeys.len(), 2);
        assert_eq!((s.storeys[0].name.as_str(), s.storeys[1].elevation), ("EG", 3.0));
        let find = |g: &str| s.walls.iter().find(|w| w.info.global_id == g).unwrap();
        let wa = find("g100");
        let ends = |w: &Wall| {
            let mut e = [w.start, w.end];
            e.sort_by(|p, q| p[0].total_cmp(&q[0]).then(p[1].total_cmp(&q[1])));
            e
        };
        // Links ohne Partner: bleibt bis zur Körperkante; rechts auf die Achse von B gezogen.
        assert!(close2(ends(wa)[0], [-0.15, 0.0]) && close2(ends(wa)[1], [5.0, 0.0]), "{wa:?}");
        assert!(close(wa.thickness, 0.3) && close(wa.z0, 0.0) && close(wa.z1, 2.5));
        assert_eq!(wa.info.storey, Some(0));
        let wb = find("g200");
        assert!(close2(ends(wb)[0], [5.0, 0.0]) && close2(ends(wb)[1], [5.0, 4.0]), "{wb:?}");
        let wc = find("g300");
        assert!(close2(ends(wc)[0], [2.0, 0.0]) && close2(ends(wc)[1], [2.0, 2.15]), "{wc:?}");
        assert!(close(wc.thickness, 0.1));
    }

    #[test]
    fn door_window_and_hole_in_wall_with_layer_set_usage() {
        // Wand (0,0) → (6,0), 0.3 dick (in mm), Schichten 0.02 / 0.28 mit Usage POSITIVE → erste
        // Schicht auf −y der Platzierung = rechts der Richtung +x.
        let wall = rect_product(100, "IFCWALL", (0.0, 0.0, 0.0), (1.0, 0.0), (6000.0, 300.0), 2800.0, "");
        // Öffnungen: Platzierung relativ zur Wand; Quader x ∈ [1,1.9], y über die Wand, z ∈ [0,2.1].
        let opening = |n: u64, x0: f64, w: f64, z0: f64, h: f64| -> String {
            let b = n * 10;
            format!(
                "#{p}=IFCCARTESIANPOINT(({x0},-200.,{z0}));#{a}=IFCAXIS2PLACEMENT3D(#{p},$,$);#{lp}=IFCLOCALPLACEMENT(#1004,#{a});\
#{pp}=IFCCARTESIANPOINT(({cx},200.));#{a2}=IFCAXIS2PLACEMENT2D(#{pp},$);#{pr}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#{a2},{w},400.);\
#{ex}=IFCEXTRUDEDAREASOLID(#{pr},#13,#11,{h});#{rep}=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#{ex}));\
#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));#{n}=IFCOPENINGELEMENT('o{n}',$,$,$,$,#{lp},#{ps},$,.OPENING.);\
#{rv}=IFCRELVOIDSELEMENT('v{n}',$,$,$,#100,#{n});\n",
                p = b + 1,
                a = b + 2,
                lp = b + 3,
                pp = b + 4,
                a2 = b + 5,
                pr = b + 6,
                ex = b + 7,
                rep = b + 8,
                ps = b + 9,
                rv = b + 10_000,
                cx = w / 2.0,
            )
        };
        let fill = |n: u64, o: u64, class: &str| format!("#{n}={class}('f{n}',$,'F{n}',$,$,#1004,$,$,$,$,$,$,$);#{r}=IFCRELFILLSELEMENT('rf{n}',$,$,$,#{o},#{n});\n", r = n + 1);
        let layers = "#900=IFCMATERIAL('Putz',$,$);#901=IFCMATERIAL('Beton',$,$);#902=IFCMATERIALLAYER(#900,20.,$,$,$,$,$);\
#903=IFCMATERIALLAYER(#901,280.,$,$,$,$,$);#904=IFCMATERIALLAYERSET((#902,#903),'AW 30',$);\
#905=IFCMATERIALLAYERSETUSAGE(#904,.AXIS2.,.POSITIVE.,-150.,$);#906=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#100),#905);\n";
        let src = file(
            MILLI,
            &format!(
                "{wall}{}{}{}{}{}{layers}",
                opening(500, 1000.0, 900.0, 0.0, 2100.0),
                opening(600, 3000.0, 1200.0, 900.0, 1300.0),
                opening(700, 5000.0, 800.0, 0.0, 2000.0),
                fill(800, 500, "IFCDOOR"),
                fill(810, 600, "IFCWINDOW"),
            ),
        );
        let (r, s) = sem(&src);
        assert_eq!(s.walls.len(), 1, "{:?}", s.kept);
        let w = &s.walls[0];
        // Erste Schicht (Putz) auf −y der Platzierung, Dossier: rechts → Richtung +x bleibt.
        assert!(close2(w.start, [0.0, 0.0]) && close2(w.end, [6.0, 0.0]), "{w:?}");
        assert_eq!(w.info.layers.len(), 2);
        assert!(close(w.info.layers[0].thickness, 0.02) && w.info.layers[0].material == "Putz");
        assert_eq!(w.info.type_name.as_deref(), Some("AW 30"));
        assert_eq!(s.openings.len(), 3);
        let o: Vec<_> = s.openings.iter().map(|o| (o.kind, (o.position * 1e6).round() / 1e6, (o.width * 1e6).round() / 1e6, (o.sill * 1e6).round() / 1e6, (o.height * 1e6).round() / 1e6)).collect();
        assert_eq!(o[0], (OpeningKind::Door, 1.0, 0.9, 0.0, 2.1));
        assert_eq!(o[1], (OpeningKind::Window, 3.0, 1.2, 0.9, 1.3));
        assert_eq!(o[2], (OpeningKind::Hole, 5.0, 0.8, 0.0, 2.0));
        assert_eq!(s.openings[0].info.global_id, "f800");
        assert_eq!(s.openings[2].info.global_id, "o700");
        assert!(r.products.is_empty());
        assert!(r.skipped_products.is_empty(), "{:?}", r.skipped_products);

        // NEGATIVE → erste Schicht links von +x → Richtung umgekehrt, Positionen ab dem neuen Start.
        let (_, s) = sem(&src.replace(".POSITIVE.", ".NEGATIVE."));
        let w = &s.walls[0];
        assert!(close2(w.start, [6.0, 0.0]) && close2(w.end, [0.0, 0.0]), "{w:?}");
        assert!(close(s.openings[0].position, 6.0 - 1.9));
        // Ohne Ausführung und Platzierung: nichts abgeleitet.
        assert_eq!((s.openings[0].operation.as_deref(), s.openings[0].swing, s.openings[0].hinge), (None, 0, 0));

        // Tür-Ausführung ([B4]): OperationType am Bauteil, eigene Platzierung in der Öffnungsmitte mit
        // X = −x (Y = Z × X = −y = Aufschlag nach rechts der Wandachse +x). LEFT = Scharnier auf +X der
        // Tür = −x-Seite = Wandanfang. Fenster: PartitioningType am Typ (IfcRelDefinesByType).
        let door = "#800=IFCDOOR('f800',$,'F800',$,$,#820,$,$,2100.,900.,.DOOR.,.SINGLE_SWING_LEFT.,$);\
#821=IFCCARTESIANPOINT((1450.,0.,0.));#822=IFCDIRECTION((-1.,0.,0.));#823=IFCAXIS2PLACEMENT3D(#821,#11,#822);#820=IFCLOCALPLACEMENT(#1004,#823);";
        let window = "#830=IFCWINDOWTYPE('wt',$,'Fenster 2',$,$,$,$,$,$,.WINDOW.,.DOUBLE_PANEL_VERTICAL.,$,$);\
#831=IFCRELDEFINESBYTYPE('dt',$,$,$,(#810),#830);";
        let src2 = src.replace("#800=IFCDOOR('f800',$,'F800',$,$,#1004,$,$,$,$,$,$,$);", door) + "";
        let src2 = src2.replace("#906=IFCRELASSOCIATESMATERIAL", &format!("{window}#906=IFCRELASSOCIATESMATERIAL"));
        let (_, s) = sem(&src2);
        let d = &s.openings[0];
        assert_eq!((d.operation.as_deref(), d.swing, d.hinge), (Some("SINGLE_SWING_LEFT"), -1, 1), "{d:?}");
        assert_eq!(s.openings[1].operation.as_deref(), Some("DOUBLE_PANEL_VERTICAL"));
        // Umgekehrte Wand: Scharnier am Ende, Aufschlag links der neuen Richtung.
        let (_, s) = sem(&src2.replace(".POSITIVE.", ".NEGATIVE."));
        assert_eq!((s.openings[0].swing, s.openings[0].hinge), (1, -1));
        // RIGHT: Scharnier auf −X der Tür = +x-Seite = Wandende.
        let (_, s) = sem(&src2.replace(".SINGLE_SWING_LEFT.", ".SINGLE_SWING_RIGHT."));
        assert_eq!((s.openings[0].swing, s.openings[0].hinge), (-1, -1));
        // Zweiflüglig: Seite ohne Scharnier-Angabe; NOTDEFINED zählt nicht.
        let (_, s) = sem(&src2.replace(".SINGLE_SWING_LEFT.", ".DOUBLE_DOOR_SINGLE_SWING."));
        assert_eq!((s.openings[0].operation.as_deref(), s.openings[0].swing, s.openings[0].hinge), (Some("DOUBLE_DOOR_SINGLE_SWING"), -1, 0));
        let (_, s) = sem(&src2.replace(".SINGLE_SWING_LEFT.", ".NOTDEFINED."));
        assert_eq!(s.openings[0].operation, None);
    }

    #[test]
    fn wall_with_niche_or_round_shape_stays_mesh() {
        // Öffnung nur halb durch die Wand (Nische): ganze Wand bleibt Mesh, samt Füllung.
        let wall = rect_product(100, "IFCWALL", (0.0, 0.0, 0.0), (1.0, 0.0), (4.0, 0.3), 2.5, "");
        let niche = "#501=IFCCARTESIANPOINT((1.,0.,0.5));#502=IFCAXIS2PLACEMENT3D(#501,$,$);#503=IFCLOCALPLACEMENT(#1004,#502);\
#504=IFCCARTESIANPOINT((0.5,0.));#505=IFCAXIS2PLACEMENT2D(#504,$);#506=IFCRECTANGLEPROFILEDEF(.AREA.,$,#505,1.,0.2);\
#507=IFCEXTRUDEDAREASOLID(#506,#13,#11,1.);#508=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#507));\
#509=IFCPRODUCTDEFINITIONSHAPE($,$,(#508));#500=IFCOPENINGELEMENT('o',$,$,$,$,#503,#509,$,.RECESS.);\
#510=IFCRELVOIDSELEMENT('v',$,$,$,#100,#500);";
        let (r, s) = sem(&file(METRE, &format!("{wall}{niche}")));
        assert!(s.walls.is_empty());
        assert_eq!(s.kept.get("IfcWall"), Some(&1));
        assert_eq!(r.products.len(), 1);
        assert_eq!(r.voids_applied, 1);
        // Runde Wand (Kreisprofil) ist kein Rechteck.
        let round = "#101=IFCCARTESIANPOINT((0.,0.));#102=IFCAXIS2PLACEMENT2D(#101,$);#103=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,#102,3.,0.3);\
#104=IFCEXTRUDEDAREASOLID(#103,#13,#11,2.5);#105=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#104));\
#106=IFCPRODUCTDEFINITIONSHAPE($,$,(#105));#100=IFCWALL('w',$,$,$,$,#22,#106,$,$);";
        let (r, s) = sem(&file(METRE, round));
        assert!(s.walls.is_empty());
        assert_eq!(r.products.len(), 1);
    }

    #[test]
    fn slab_with_hole_and_opening_columns_and_space() {
        // Decke 6 × 4, 0.25 dick, OK auf 3.0, Loch 1 × 1 im Profil und Öffnung 0.5 × 0.5 durch.
        let slab = "#101=IFCCARTESIANPOINT((0.,0.));#102=IFCCARTESIANPOINT((6.,0.));#103=IFCCARTESIANPOINT((6.,4.));#104=IFCCARTESIANPOINT((0.,4.));\
#105=IFCPOLYLINE((#101,#102,#103,#104,#101));#106=IFCCARTESIANPOINT((1.,1.));#107=IFCCARTESIANPOINT((2.,1.));#108=IFCCARTESIANPOINT((2.,2.));\
#109=IFCCARTESIANPOINT((1.,2.));#110=IFCPOLYLINE((#106,#107,#108,#109,#106));#111=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#105,(#110));\
#112=IFCCARTESIANPOINT((0.,0.,2.75));#113=IFCAXIS2PLACEMENT3D(#112,$,$);#114=IFCEXTRUDEDAREASOLID(#111,#113,#11,0.25);\
#115=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#114));#116=IFCPRODUCTDEFINITIONSHAPE($,$,(#115));\
#100=IFCSLAB('s',$,'Decke',$,$,#22,#116,$,.FLOOR.);#117=IFCRELCONTAINEDINSPATIALSTRUCTURE('rs',$,$,$,(#100,#300,#400,#500),#23);\
#201=IFCCARTESIANPOINT((4.,2.,2.5));#202=IFCAXIS2PLACEMENT3D(#201,$,$);#203=IFCLOCALPLACEMENT(#22,#202);\
#204=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.5,0.5);#205=IFCEXTRUDEDAREASOLID(#204,#13,#11,1.);\
#206=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#205));#207=IFCPRODUCTDEFINITIONSHAPE($,$,(#206));\
#200=IFCOPENINGELEMENT('o',$,$,$,$,#203,#207,$,.OPENING.);#208=IFCRELVOIDSELEMENT('v',$,$,$,#100,#200);\
#301=IFCCARTESIANPOINT((3.,3.,0.));#302=IFCDIRECTION((0.,1.,0.));#303=IFCAXIS2PLACEMENT3D(#301,#11,#302);#304=IFCLOCALPLACEMENT(#22,#303);\
#305=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.4,0.3);#306=IFCEXTRUDEDAREASOLID(#305,#13,#11,2.75);\
#307=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#306));#308=IFCPRODUCTDEFINITIONSHAPE($,$,(#307));\
#300=IFCCOLUMN('c1',$,'S1',$,$,#304,#308,$,$);\
#401=IFCCARTESIANPOINT((1.,3.,0.));#402=IFCAXIS2PLACEMENT3D(#401,$,$);#403=IFCLOCALPLACEMENT(#22,#402);\
#404=IFCCIRCLEPROFILEDEF(.AREA.,$,$,0.15);#405=IFCEXTRUDEDAREASOLID(#404,#13,#11,2.75);\
#406=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#405));#407=IFCPRODUCTDEFINITIONSHAPE($,$,(#406));\
#400=IFCCOLUMN('c2',$,'S2',$,$,#403,#407,$,$);\
#501=IFCCARTESIANPOINT((0.,0.));#502=IFCCARTESIANPOINT((3.,0.));#503=IFCCARTESIANPOINT((3.,2.));#504=IFCCARTESIANPOINT((0.,2.));\
#505=IFCPOLYLINE((#501,#502,#503,#504,#501));#506=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#505);#507=IFCEXTRUDEDAREASOLID(#506,#13,#11,2.5);\
#508=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#507));#509=IFCPRODUCTDEFINITIONSHAPE($,$,(#508));\
#500=IFCSPACE('sp',$,'1.01',$,$,#22,#509,'K\\X2\\00FC\\X0\\che',.ELEMENT.,.INTERNAL.,$);\
#510=IFCPROPERTYSINGLEVALUE('SIA416',$,IFCLABEL('HNF'),$);#511=IFCPROPERTYSET('ps',$,'CH_Raum',$,(#510));\
#512=IFCRELDEFINESBYPROPERTIES('rp',$,$,$,(#500),#511);";
        let (r, s) = sem(&file(METRE, slab));
        assert!(r.products.is_empty(), "{:?}", r.products.iter().map(|p| &p.class).collect::<Vec<_>>());
        assert_eq!(s.slabs.len(), 1, "{:?}", s.kept);
        let sl = &s.slabs[0];
        assert!(close(sl.z0, 2.75) && close(sl.z1, 3.0));
        assert_eq!(sl.outline.len(), 4);
        assert!(close(area2(&sl.outline), 24.0));
        assert_eq!(sl.holes.len(), 2);
        let mut ha: Vec<f64> = sl.holes.iter().map(|h| area2(h).abs()).collect();
        ha.sort_by(f64::total_cmp);
        assert!(close(ha[0], 0.25) && close(ha[1], 1.0), "{ha:?}");
        assert_eq!(s.columns.len(), 2);
        let c1 = s.columns.iter().find(|c| c.info.global_id == "c1").unwrap();
        // Profil 0.4 (x) × 0.3, Platzierung um 90° gedreht → Breite 0.3 entlang x, Tiefe 0.4.
        assert!(close2(c1.center, [3.0, 3.0]) && close(c1.rotation, 0.0), "{c1:?}");
        assert_eq!(c1.profile.round(), Profile::Rect { width: 0.3, depth: 0.4 });
        let c2 = s.columns.iter().find(|c| c.info.global_id == "c2").unwrap();
        match c2.profile {
            Profile::Round { radius } => assert!(close(radius, 0.15)),
            p => panic!("{p:?}"),
        }
        assert!(close2(c2.center, [1.0, 3.0]));
        assert_eq!(s.spaces.len(), 1);
        let sp = &s.spaces[0];
        assert_eq!((sp.long_name.as_deref(), sp.sia.as_deref(), sp.info.name.as_deref()), (Some("Küche"), Some("HNF"), Some("1.01")));
        assert!(close(area2(&sp.boundary), 6.0));
        assert!(r.skipped_products.is_empty(), "{:?}", r.skipped_products);
    }

    /// Raum (3 x 2, ohne eigene SIA-Eigenschaft) mit `extra` (Zone, Klassifikation ...) dahinter.
    fn space_file(extra: &str) -> String {
        let body = format!(
            "#501=IFCCARTESIANPOINT((0.,0.));#502=IFCCARTESIANPOINT((3.,0.));#503=IFCCARTESIANPOINT((3.,2.));#504=IFCCARTESIANPOINT((0.,2.));\
#505=IFCPOLYLINE((#501,#502,#503,#504,#501));#506=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#505);#507=IFCEXTRUDEDAREASOLID(#506,#13,#11,2.5);\
#508=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#507));#509=IFCPRODUCTDEFINITIONSHAPE($,$,(#508));\
#500=IFCSPACE('sp',$,'1.01',$,$,#22,#509,'Bad',.ELEMENT.,.INTERNAL.,$);\
#520=IFCRELAGGREGATES('as',$,$,$,#23,(#500));\n{extra}"
        );
        file(METRE, &body)
    }

    #[test]
    fn zone_name_and_zone_property_give_sia_category() {
        // Zone heisst wie die Kategorie.
        let (_, s) = sem(&space_file("#600=IFCZONE('z',$,'nnf',$,$,$);#601=IFCRELASSIGNSTOGROUP('ag',$,$,$,(#500),$,#600);"));
        assert_eq!(s.spaces.len(), 1, "{:?}", s.kept);
        assert_eq!(s.spaces[0].sia.as_deref(), Some("NNF"));
        // SIA 416 schreibt KF, das Modell KGF.
        let (_, s) = sem(&space_file("#600=IFCZONE('z',$,'KF',$,$,$);#601=IFCRELASSIGNSTOGROUP('ag',$,$,$,(#500),$,#600);"));
        assert_eq!(s.spaces[0].sia.as_deref(), Some("KGF"));
        // Eigenschaft der Zone (Dossier-Export) schlägt den Namen.
        let zone = "#600=IFCZONE('z',$,'Zone 7',$,$,$);#601=IFCRELASSIGNSTOGROUP('ag',$,$,$,(#500),$,#600);\
#602=IFCPROPERTYSINGLEVALUE('SIA416',$,IFCLABEL('VF'),$);#603=IFCPROPERTYSET('zp',$,'CH_Zone',$,(#602));\
#604=IFCRELDEFINESBYPROPERTIES('zr',$,$,$,(#600),#603);";
        let (_, s) = sem(&space_file(zone));
        assert_eq!(s.spaces[0].sia.as_deref(), Some("VF"));
        // Beliebiger Zonenname ohne Eigenschaft: keine Kategorie (kein Raten); eine IfcGroup zählt nicht.
        let (_, s) = sem(&space_file("#600=IFCZONE('z',$,'Wohnung 3',$,$,$);#601=IFCRELASSIGNSTOGROUP('ag',$,$,$,(#500),$,#600);"));
        assert_eq!(s.spaces[0].sia, None);
        let (_, s) = sem(&space_file("#600=IFCGROUP('z',$,'HNF',$,$);#601=IFCRELASSIGNSTOGROUP('ag',$,$,$,(#500),$,#600);"));
        assert_eq!(s.spaces[0].sia, None);
        // Eigene Raum-Eigenschaft hat Vorrang vor der Zone.
        let own = "#600=IFCZONE('z',$,'HNF',$,$,$);#601=IFCRELASSIGNSTOGROUP('ag',$,$,$,(#500),$,#600);\
#610=IFCPROPERTYSINGLEVALUE('SIA416',$,IFCLABEL('FF'),$);#611=IFCPROPERTYSET('rp',$,'CH_Raum',$,(#610));\
#612=IFCRELDEFINESBYPROPERTIES('rr',$,$,$,(#500),#611);";
        let (_, s) = sem(&space_file(own));
        assert_eq!(s.spaces[0].sia.as_deref(), Some("FF"));
    }

    #[test]
    fn common_pset_properties_are_read() {
        let psets = "#620=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);#621=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI30'),$);\
#622=IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCTHERMALTRANSMITTANCEMEASURE(1.3),$);#623=IFCPROPERTYSINGLEVALUE('Fremd',$,IFCLABEL('x'),$);\
#624=IFCPROPERTYSET('cp',$,'Pset_DoorCommon',$,(#620,#621,#622,#623));#625=IFCRELDEFINESBYPROPERTIES('cr',$,$,$,(#500),#624);";
        let (_, s) = sem(&space_file(psets));
        let c = &s.spaces[0].info.common;
        assert_eq!((c.get("IsExternal").map(String::as_str), c.get("FireRating").map(String::as_str), c.get("ThermalTransmittance").map(String::as_str)), (Some("true"), Some("EI30"), Some("1.3")));
        assert!(!c.contains_key("Fremd"), "nur bekannte Eigenschaften");
    }

    #[test]
    fn classification_references_of_element_type_and_mesh() {
        // Stütze (Bauteil) mit eBKP-H, Raum mit Klassifikation über verschachtelte Referenz, BKP am Typ,
        // dazu ein Dach (bleibt Mesh) mit Klassifikation.
        let col = rect_product(40, "IFCCOLUMN", (1.0, 1.0, 0.0), (1.0, 0.0), (0.4, 0.4), 2.75, "");
        let roof = rect_product(41, "IFCROOF", (1.0, 1.0, 3.0), (1.0, 0.0), (4.0, 3.0), 0.3, "");
        let cls = "#700=IFCCLASSIFICATION('CRB','2020',$,'eBKP-H',$,$,$);\
#701=IFCCLASSIFICATIONREFERENCE($,'C','Konstruktion Geb\\X2\\00E4\\X0\\ude',#700,$,$);\
#702=IFCRELASSOCIATESCLASSIFICATION('c1',$,$,$,(#40),#701);\
#703=IFCCLASSIFICATIONREFERENCE($,'C02',$,#701,$,$);\
#704=IFCRELASSOCIATESCLASSIFICATION('c2',$,$,$,(#41),#703);\
#705=IFCCLASSIFICATIONREFERENCE($,'  ',$,#700,$,$);\
#706=IFCRELASSOCIATESCLASSIFICATION('c3',$,$,$,(#40),#705);\
#707=IFCRELASSOCIATESCLASSIFICATION('c4',$,$,$,(#40),#700);";
        let (r, s) = sem(&file(METRE, &format!("{col}{roof}{cls}")));
        assert_eq!(s.columns.len(), 1, "{:?}", s.kept);
        let c = &s.columns[0].info.classifications;
        // Leerer Code und ein blosses IfcClassification (ohne Code) zählen nicht.
        assert_eq!(c.len(), 1, "{c:?}");
        assert_eq!((c[0].system.as_str(), c[0].code.as_str(), c[0].name.as_deref()), ("eBKP-H", "C", Some("Konstruktion Gebäude")));
        // Roof bleibt Mesh, die Klassifikation kommt trotzdem mit (verschachtelte Referenz: System von oben).
        let p = r.products.iter().find(|p| p.class == "IfcRoof").expect("Dach als Mesh");
        assert_eq!(p.classifications.len(), 1);
        assert_eq!((p.classifications[0].system.as_str(), p.classifications[0].code.as_str(), p.classifications[0].name.as_deref()), ("eBKP-H", "C02", None));
    }

    #[test]
    fn classification_from_type_and_ifc2x3_layout() {
        // Klassifikation am Typ (IfcRelDefinesByType) erbt das Bauteil; Wandtyp ohne Bauteil-Eigenes.
        let col = rect_product(40, "IFCCOLUMN", (1.0, 1.0, 0.0), (1.0, 0.0), (0.4, 0.4), 2.75, "");
        let cls = "#710=IFCCOLUMNTYPE('ct',$,'S30',$,$,$,$,$,$,.COLUMN.);\
#711=IFCRELDEFINESBYTYPE('dt',$,$,$,(#40),#710);\
#712=IFCCLASSIFICATION('CRB',$,$,'BKP',$,$,$);\
#713=IFCCLASSIFICATIONREFERENCE($,'214',$,#712,$,$);\
#714=IFCRELASSOCIATESCLASSIFICATION('c5',$,$,$,(#710),#713);";
        let (_, s) = sem(&file(METRE, &format!("{col}{cls}")));
        let c = &s.columns[0].info.classifications;
        assert_eq!(c.len(), 1, "{c:?}");
        assert_eq!((c[0].system.as_str(), c[0].code.as_str()), ("BKP", "214"));
    }

    impl Profile {
        /// Auf 1e-9 gerundet (Vergleich in Tests).
        fn round(self) -> Profile {
            let r = |x: f64| (x * 1e9).round() / 1e9;
            match self {
                Profile::Rect { width, depth } => Profile::Rect { width: r(width), depth: r(depth) },
                Profile::Round { radius } => Profile::Round { radius: r(radius) },
            }
        }
    }

    #[test]
    fn helpers_rect_hull_loops() {
        let pts = [[0.0, 0.0], [4.0, 1.0], [3.5, 3.0], [-0.5, 2.0], [1.0, 1.0]];
        let (d, u0, u1, v0, v1) = min_area_rect(&pts).unwrap();
        assert!((u1 - u0) >= (v1 - v0) && d[0] >= 0.0);
        assert!(convex_hull(&[[0.0, 0.0]]).len() == 1);
        assert!(min_area_rect(&[[0.0, 0.0], [1.0, 1.0]]).is_none());
        assert!(simplify_ring(&[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [0.0, 0.0]]).len() == 4);
        assert!(boundary_loops(&[]).is_empty());
    }

    #[test]
    fn nonsense_never_panics() {
        for src in [
            file(METRE, "#100=IFCWALL('w',$,$,$,$,#999,#998,$,$);#998=IFCPRODUCTDEFINITIONSHAPE($,$,(#997));#997=IFCSHAPEREPRESENTATION($,'Body',$,(#1));"),
            file(METRE, "#100=IFCSLAB('s',$,$,$,$,$,$,$,$);#101=IFCRELVOIDSELEMENT('v',$,$,$,#100,#100);#102=IFCRELFILLSELEMENT('f',$,$,$,#100,#100);"),
            file(METRE, "#100=IFCMATERIALLAYERSETUSAGE(#100,.AXIS2.,.POSITIVE.,0.,$);#101=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#102),#100);#102=IFCWALL('w',$,$,$,$,$,$,$,$);"),
            file(METRE, "#100=IFCBUILDINGSTOREY('x',$,$,$,$,#100,$,$,$,1e400);"),
        ] {
            let _ = import_ifc_opts(src.as_bytes(), true);
        }
    }
}
