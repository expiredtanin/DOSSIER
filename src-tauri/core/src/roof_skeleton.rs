//! Dachflächen über beliebigen einfachen Grundrissen (L/T/U/Z, Fünfeck, schiefe Winkel, mit
//! [`weighted_roof`] auch Höfe und Neigung je Kante): echte Flächen mit Graten UND Kehlen statt
//! der Bounding-Box-Vereinfachung aus [`crate::roof`].
//!
//! Seit [B2] über den gewichteten Straight Skeleton ([`crate::skeleton`]): jede Traufkante läuft
//! mit 1/tan(Neigung) nach innen, Giebelkanten stehen; die Fläche, die eine Kante dabei
//! überstreicht, ist ihre Dachfläche, Höhe = Traufhöhe + tan · Abstand zur Traufkante. Danach in
//! KONVEXE Teilflächen zerlegt (Ohr-Schnitt + Hertel–Mehlhorn), weil Renderer/Schnitt konvexe
//! Flächen erwarten. Giebelwände schliessen auch die Stufe, die ein Giebel an einer
//! einspringenden Ecke ins Dach schneidet.
//!
//! Rückfall, wenn der Skeleton scheitert (Budget, Degeneration): das frühere Keil-Verfahren
//! [`hip_roof_wedge`] (je Kante ihr Keil zwischen den Winkelhalbierenden, Höhe = tiefste Ebene;
//! Polygon-Booleans aus [`crate::polygon_bool`]) — portiert aus `src/geometry/roofSkeleton.ts`.
//! Es ist bei Split-Ereignissen falsch (s. Tests `alt_falsch_*`).

use crate::flat::Polygon;
use crate::polygon_bool;
use crate::skeleton::{self, SkeletonError};
use std::collections::{HashMap, HashSet};

/// Grundriss-Punkt (x, y) in Metern.
pub type P2 = [f64; 2];
/// 3D-Punkt (x, y, z = Höhe) in Metern.
pub type P3 = [f64; 3];
/// Grundriss-Linie.
pub type Line = [P2; 2];

/// Firstrichtung: entlang der X- oder Y-Achse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

/// Mansarde: ab Traufabstand `d` flacher (Steigung `tan_up`).
#[derive(Clone, Copy, Debug)]
pub struct Knee {
    pub d: f64,
    pub tan_up: f64,
}

/// Ergebnis: Dachflächen (konvex, 3D), Grundriss-Linien, Firsthöhe.
#[derive(Clone, Debug, Default)]
pub struct SkeletonRoof {
    pub planes: Vec<Vec<P3>>,
    pub ridges: Vec<Line>,
    pub hips: Vec<Line>,
    /// Knicklinien der Mansarde.
    pub breaks: Vec<Line>,
    /// Senkrechte Giebelflächen (nur Satteldach, s. `ridge_axis`).
    pub gables: Vec<Vec<P3>>,
    pub ridge_height: f64,
}

/// Ausgabe-Raster (Meter): entfernt Rundungsrauschen der Polygon-Booleans.
const SNAP: f64 = 1e-6;
fn snap(v: f64) -> f64 {
    (v / SNAP).round() * SNAP
}

/// Eingabe-Raster der Polygon-Booleans: exakt zusammenfallende Punkte.
const ROUND: f64 = 1e-9;
fn rnd(v: f64) -> f64 {
    (v / ROUND).round() * ROUND
}

/// Signierte Fläche (CCW > 0).
pub fn signed_area(pts: &[P2]) -> f64 {
    let n = pts.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = pts[i];
        let q = pts[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

/// Doppelte und kollineare Punkte entfernen.
pub fn clean_ring(pts: &[P2]) -> Vec<P2> {
    let n = pts.len();
    let mut out: Vec<P2> = (0..n)
        .filter(|&i| {
            let p = pts[i];
            let q = pts[(i + 1) % n];
            (p[0] - q[0]).hypot(p[1] - q[1]) > 1e-9
        })
        .map(|i| pts[i])
        .collect();
    let mut changed = true;
    while changed && out.len() > 3 {
        changed = false;
        let m = out.len();
        for i in 0..m {
            let a = out[(i + m - 1) % m];
            let b = out[i];
            let c = out[(i + 1) % m];
            let cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
            if cr.abs() < 1e-9 {
                out.remove(i);
                changed = true;
                break;
            }
        }
    }
    out
}

fn axis_parallel(p: P2, q: P2) -> bool {
    (p[0] - q[0]).abs() < 1e-9 || (p[1] - q[1]).abs() < 1e-9
}

/// Ob alle Kanten achsparallel sind (und es mehr als ein Rechteck ist).
pub fn is_rectilinear_non_rect(outline: &[P2]) -> bool {
    let pts = clean_ring(outline);
    let n = pts.len();
    n > 4 && (0..n).all(|i| axis_parallel(pts[i], pts[(i + 1) % n]))
}

/// Versatz je Kante: überall gleich oder je Kante (a, b) verschieden (Traufe/Ortgang).
pub enum Offset<'a> {
    Const(f64),
    PerEdge(&'a dyn Fn(P2, P2) -> f64),
}

/// Ring (CCW) nach aussen versetzen (Traufüberstand) — Gehrung an jeder Ecke (Schnitt der
/// beiden versetzten Kantengeraden), auch bei schiefen Winkeln.
pub fn offset_ring(ring: &[P2], dist: Offset) -> Vec<P2> {
    if let Offset::Const(d) = dist {
        if d <= 0.0 {
            return ring.to_vec();
        }
    }
    let n = ring.len();
    // Aussen-Normale (Einheit) + Versatz je Kante (CCW → rechte Normale).
    let edges: Vec<(f64, f64, f64)> = (0..n)
        .map(|i| {
            let p = ring[i];
            let q = ring[(i + 1) % n];
            let len = (q[0] - p[0]).hypot(q[1] - p[1]);
            let len = if len == 0.0 { 1.0 } else { len };
            let d = match &dist {
                Offset::Const(d) => *d,
                Offset::PerEdge(f) => f(p, q),
            };
            ((q[1] - p[1]) / len, -(q[0] - p[0]) / len, d)
        })
        .collect();
    (0..n)
        .map(|i| {
            let p = ring[i];
            let a = edges[(i + n - 1) % n];
            let b = edges[i];
            let det = a.0 * b.1 - a.1 * b.0;
            // (fast) kollineare Nachbarkanten: einfach entlang der Normale versetzen.
            if det.abs() < 1e-6 {
                return [p[0] + a.0 * a.2, p[1] + a.1 * a.2];
            }
            let mut dx = (a.2 * b.1 - b.2 * a.1) / det;
            let mut dy = (a.0 * b.2 - b.0 * a.2) / det;
            // Sehr spitze Ecken: Gehrungsspitze begrenzen.
            let lim = 4.0 * a.2.max(b.2);
            let len = dx.hypot(dy);
            if len > lim && len > 0.0 {
                dx *= lim / len;
                dy *= lim / len;
            }
            [p[0] + dx, p[1] + dy]
        })
        .collect()
}

/// Schneiden sich zwei Strecken echt (nicht nur an einem gemeinsamen Endpunkt)?
fn segments_cross(a: P2, b: P2, c: P2, d: P2) -> bool {
    let o = |p: P2, q: P2, r: P2| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    let (d1, d2, d3, d4) = (o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b));
    d1 * d2 < -1e-12 && d3 * d4 < -1e-12
}

/// Ob der Umriss ein einfaches (selbstüberschneidungsfreies) Polygon ist, das KEIN
/// achsparalleles Rechteck ist — dafür liefert [`hip_roof`] für gleichmässig geneigte Dächer
/// (Walm/Zelt) die echten Flächen statt der Bounding-Box.
pub fn is_skeleton_roofable(outline: &[P2]) -> bool {
    let pts = clean_ring(outline);
    let n = pts.len();
    if n < 3 {
        return false;
    }
    if n == 4 && (0..n).all(|i| axis_parallel(pts[i], pts[(i + 1) % n])) {
        return false; // Rechteck: Bounding-Box-Dach reicht
    }
    if signed_area(&pts).abs() < 1e-6 {
        return false;
    }
    for i in 0..n {
        for j in (i + 2)..n {
            if i == 0 && j == n - 1 {
                continue; // benachbarte Kanten
            }
            if segments_cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]) {
                return false;
            }
        }
    }
    true
}

/// Konvexes Polygon gegen die Halbebene f(p) ≥ 0 schneiden (Sutherland–Hodgman).
pub fn clip_half(poly: &[P2], f: impl Fn(P2) -> f64) -> Vec<P2> {
    let n = poly.len();
    let mut out = Vec::with_capacity(n + 2);
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let fa = f(a);
        let fb = f(b);
        if fa >= 0.0 {
            out.push(a);
        }
        if (fa >= 0.0) != (fb >= 0.0) {
            let t = fa / (fa - fb);
            out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        }
    }
    out
}

fn to_ring(pts: &[P2]) -> Vec<P2> {
    pts.iter().map(|p| [rnd(p[0]), rnd(p[1])]).collect()
}

struct Edge {
    a: P2,
    b: P2,
    /// Innen-Normale (Einheit).
    n: P2,
}

/// Ob die Kante a→b quer zur Firstrichtung liegt (Satteldach: senkrechter Giebel/Ortgang).
fn is_gable_edge(a: P2, b: P2, ridge_axis: Option<Axis>) -> bool {
    match ridge_axis {
        None => false,
        Some(Axis::X) => (b[0] - a[0]).abs() < (b[1] - a[1]).abs(),
        Some(Axis::Y) => (b[1] - a[1]).abs() < (b[0] - a[0]).abs(),
    }
}

/// Walm-/Sattel-/Mansarddach-Flächen über dem Traufring `eaves_in` (beliebige Orientierung)
/// bei Neigung `tan` und Traufhöhe `e`. `ridge_axis` gesetzt → Satteldach: Kanten quer zu
/// dieser Firstrichtung sind senkrechte Giebel (Ortgang). `knee` → Mansarde.
///
/// Rechnet über den gewichteten Straight Skeleton ([`crate::skeleton`], [B2]); scheitert er
/// (Budget, Degeneration), gilt das bisherige Keil-Verfahren [`hip_roof_wedge`].
pub fn hip_roof(eaves_in: &[P2], tan: f64, e: f64, ridge_axis: Option<Axis>, knee: Option<Knee>) -> SkeletonRoof {
    let mut eaves = clean_ring(eaves_in);
    if eaves.len() < 3 || eaves.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()) {
        return SkeletonRoof::default();
    }
    if signed_area(&eaves) < 0.0 {
        eaves.reverse();
    }
    let n = eaves.len();
    let slopes: Vec<Option<f64>> = (0..n).map(|i| (!is_gable_edge(eaves[i], eaves[(i + 1) % n], ridge_axis)).then_some(tan)).collect();
    match weighted_roof(&[eaves.clone()], &slopes, e, knee, None) {
        Ok(r) => r,
        Err(_) => hip_roof_wedge(&eaves, tan, e, ridge_axis, knee),
    }
}

/// Dach über dem Traufring `rings[0]` (CCW) mit Höfen `rings[1..]` (je CW), Neigung je Kante
/// (`slopes[i]` = tan der Neigung der Kante i, Ring für Ring nummeriert; `None` = senkrechter
/// Giebel), Traufhöhe `e`, optional Mansardknick (nur sinnvoll bei gleicher Neigung ringsum).
/// Flächen aus dem gewichteten Straight Skeleton: jede Kante läuft mit 1/tan nach innen, so
/// dass alle Flächen gleich schnell steigen; Höhe eines Punkts = e + tan · Abstand zur eigenen
/// Traufkante (exakt eben). `budget` s. [`skeleton::faces`].
pub fn weighted_roof(rings: &[Vec<P2>], slopes: &[Option<f64>], e: f64, knee: Option<Knee>, budget: Option<usize>) -> Result<SkeletonRoof, SkeletonError> {
    let pts: Vec<P2> = rings.iter().flatten().copied().collect();
    let n = pts.len();
    if slopes.len() != n || n < 3 {
        return Err(SkeletonError::Input("je Kante eine Neigung"));
    }
    let e = if e.is_finite() { e } else { 0.0 };
    // Kanten: Anfang, Ende, Innen-Normale; Ring für Ring.
    let mut edges: Vec<(P2, P2, P2)> = Vec::with_capacity(n);
    for r in rings {
        for i in 0..r.len() {
            let (a, b) = (r[i], r[(i + 1) % r.len()]);
            let len = (b[0] - a[0]).hypot(b[1] - a[1]);
            let len = if len == 0.0 { 1.0 } else { len };
            edges.push((a, b, [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]));
        }
    }
    let tans: Vec<Option<f64>> = slopes.iter().map(|s| s.map(|t| if t.is_finite() { t.max(0.0) } else { 0.0 })).collect();
    let tmax = tans.iter().flatten().copied().fold(0.0, f64::max);
    // Geschwindigkeit je Kante: gleiche Neigung → 1 (Zeit = Abstand); flachere Kanten schneller.
    // Flache Kanten (tan 0) neben geneigten: auf 1/1000 der steilsten begrenzt.
    let speeds: Vec<f64> = tans
        .iter()
        .map(|s| match s {
            None => 0.0,
            Some(_) if tmax <= 0.0 => 1.0,
            Some(t) => tmax / t.max(tmax * 1e-3),
        })
        .collect();
    let all_same = tans.iter().flatten().all(|t| *t == tmax);
    let speeds: Vec<f64> = if all_same { speeds.iter().map(|s| if *s > 0.0 { 1.0 } else { 0.0 }).collect() } else { speeds };
    let faces = skeleton::faces(rings, &speeds, budget)?;
    let dist = |k: usize, p: P2| (p[0] - edges[k].0[0]) * edges[k].2[0] + (p[1] - edges[k].0[1]) * edges[k].2[1];
    let mut out = SkeletonRoof::default();
    // Linie → (Fläche, First?, Index): eine zweite Fläche derselben Ebene macht sie unsichtbar.
    let mut line_keys: HashMap<[i64; 4], (usize, bool, usize)> = HashMap::new();
    let mut hidden: HashSet<(bool, usize)> = HashSet::new();
    let coplanar = |k: usize, f: usize| {
        tans[k] == tans[f] && (edges[k].2[0] - edges[f].2[0]).abs() < 1e-9 && (edges[k].2[1] - edges[f].2[1]).abs() < 1e-9 && dist(f, edges[k].0).abs() < 1e-9
    };
    let on_seg = |k: usize, p: P2| {
        let (a, b, _) = edges[k];
        let len2 = (b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2);
        let len2 = if len2 == 0.0 { 1.0 } else { len2 };
        let t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2;
        dist(k, p).abs() < 1e-5 && t > -1e-6 && t < 1.0 + 1e-6
    };
    let on_eaves = |p: P2, q: P2| (0..n).any(|k| on_seg(k, p) && on_seg(k, q));
    for (k, loops) in faces.iter().enumerate() {
        let Some(tan) = tans[k] else { continue };
        let z = |p: P2| {
            let d = dist(k, p).max(0.0);
            match knee {
                Some(kn) => e + tan * d.min(kn.d) + kn.tan_up * (d - kn.d).max(0.0),
                None => e + tan * d,
            }
        };
        let rings2: Vec<Vec<P2>> = loops
            .iter()
            .map(|l| clean_ring(&l.iter().map(|(p, _)| *p).collect::<Vec<_>>()))
            .filter(|r| r.len() >= 3 && signed_area(r).abs() >= 1e-6)
            .collect();
        let Some(outer) = rings2.first() else { continue };
        let holes = &rings2[1..];
        let shape = if holes.is_empty() { outer.clone() } else { crate::polygon_holes::merge_holes(outer, holes, 0.0).ring };
        for piece in convex_pieces(&shape) {
            let parts = match knee {
                Some(kn) => vec![clip_half(&piece, |p| kn.d - dist(k, p)), clip_half(&piece, |p| dist(k, p) - kn.d)],
                None => vec![piece.clone()],
            };
            for part in parts {
                if part.len() < 3 || signed_area(&part).abs() < 1e-9 {
                    continue;
                }
                out.planes.push(part.iter().map(|&p| [p[0], p[1], z(p)]).collect());
            }
            if let Some(kn) = knee {
                let low = clip_half(&piece, |p| kn.d - dist(k, p));
                let m = low.len();
                for i in 0..m {
                    let p = low[i];
                    let q = low[(i + 1) % m];
                    if (dist(k, p) - kn.d).abs() < 1e-6 && (dist(k, q) - kn.d).abs() < 1e-6 {
                        out.breaks.push([p, q]);
                    }
                }
            }
        }
        // Grat-/Kehl-/Firstlinien: Flächenränder, die nicht auf der Traufe liegen.
        for ring in &rings2 {
            let m = ring.len();
            for i in 0..m {
                let p = ring[i];
                let q = ring[(i + 1) % m];
                if on_eaves(p, q) {
                    continue;
                }
                let r = |v: f64| (v * 1e5).round() as i64;
                let kp = [r(p[0]), r(p[1])];
                let kq = [r(q[0]), r(q[1])];
                let key = if kp < kq { [kp[0], kp[1], kq[0], kq[1]] } else { [kq[0], kq[1], kp[0], kp[1]] };
                if let Some(&(f, ridge, idx)) = line_keys.get(&key) {
                    // Grenze zweier Flächen derselben Ebene (zwei Traufkanten einer Flucht):
                    // keine Kante im Dach, nicht zeichnen.
                    if f != k && coplanar(k, f) {
                        hidden.insert((ridge, idx));
                    }
                    continue;
                }
                let (zp, zq) = (z(p), z(q));
                out.ridge_height = out.ridge_height.max(zp - e).max(zq - e);
                let ridge = (zp - zq).abs() < 1e-6;
                let list = if ridge { &mut out.ridges } else { &mut out.hips };
                line_keys.insert(key, (k, ridge, list.len()));
                list.push([p, q]);
            }
        }
    }
    for (ridge, list) in [(true, &mut out.ridges), (false, &mut out.hips)] {
        let mut i = 0;
        list.retain(|_| {
            i += 1;
            !hidden.contains(&(ridge, i - 1))
        });
    }
    // Giebelwände: je Gerade einer stehenden Kante (deckungsgleiche Giebel nur einmal).
    let mut lines_done: Vec<usize> = Vec::new();
    for (k, &(a, b, nk)) in edges.iter().enumerate() {
        let same_line = |j: usize| tans[j].is_none() && dist(k, edges[j].0).abs() < 1e-9 && dist(k, edges[j].1).abs() < 1e-9 && nk[0] * edges[j].2[0] + nk[1] * edges[j].2[1] > 0.0;
        if tans[k].is_some() || lines_done.iter().any(|&j| same_line(j)) {
            continue;
        }
        lines_done.push(k);
        // Alle gleichgerichteten Giebel auf dieser Geraden: ihre Abschnitte (Lage entlang a→b).
        let len = (b[0] - a[0]).hypot(b[1] - a[1]).max(1e-12);
        let along = |p: P2| ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len;
        let ranges: Vec<(f64, f64)> = (0..n).filter(|&j| same_line(j)).map(|j| (along(edges[j].0), along(edges[j].1))).map(|(x, y)| (x.min(y), x.max(y))).collect();
        out.gables.extend(gable_walls(&out.planes, a, b, &ranges, e));
    }
    Ok(out)
}

/// Senkrechte Giebelwände auf der Geraden der stehenden Kante a→b: zwischen der tieferen und der
/// höheren Dachfläche beidseits der Geraden; auf den Giebelkanten (`ranges`, Lage entlang a→b)
/// liegt aussen die Traufhöhe `e`.
/// Steht der Giebel an einer einspringenden Ecke, läuft die Stufe im Dach über die Kante hinaus
/// weiter, bis beide Seiten wieder gleich hoch sind — die Wand reicht bis dorthin (das alte
/// Verfahren nahm nur die Flächenecken auf der Kante und liess dort ein Loch).
fn gable_walls(planes: &[Vec<P3>], a: P2, b: P2, ranges: &[(f64, f64)], e: f64) -> Vec<Vec<P3>> {
    let len = (b[0] - a[0]).hypot(b[1] - a[1]);
    if !(len > 1e-9) {
        return Vec::new();
    }
    let u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let nrm = [-u[1], u[0]];
    let off = |p: P2| (p[0] - a[0]) * nrm[0] + (p[1] - a[1]) * nrm[1];
    let along = |p: P2| (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
    // Flächenränder auf der Geraden: (t0, z0, t1, z1, Seite links?).
    let mut segs: Vec<(f64, f64, f64, f64, bool)> = Vec::new();
    for pl in planes {
        let m = pl.len();
        if m < 3 {
            continue;
        }
        let c = pl.iter().fold([0.0, 0.0], |s, v| [s[0] + v[0] / m as f64, s[1] + v[1] / m as f64]);
        let left = off(c) > 0.0;
        for i in 0..m {
            let (p, q) = (pl[i], pl[(i + 1) % m]);
            if off([p[0], p[1]]).abs() > 1e-6 || off([q[0], q[1]]).abs() > 1e-6 {
                continue;
            }
            let (tp, tq) = (along([p[0], p[1]]), along([q[0], q[1]]));
            if (tq - tp).abs() < 1e-9 {
                continue;
            }
            segs.push(if tp < tq { (tp, p[2], tq, q[2], left) } else { (tq, q[2], tp, p[2], left) });
        }
    }
    let mut ts: Vec<f64> = segs.iter().flat_map(|s| [s.0, s.2]).chain(ranges.iter().flat_map(|r| [r.0, r.1])).collect();
    ts.sort_by(|x, y| x.total_cmp(y));
    ts.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
    // Höhe einer Seite im Intervall (t0, t1) als (z bei t0, z bei t1).
    let side = |left: bool, t0: f64, t1: f64| -> Option<(f64, f64)> {
        let mid = (t0 + t1) / 2.0;
        if let Some(s) = segs.iter().find(|s| s.4 == left && s.0 <= mid && mid <= s.2) {
            let at = |t: f64| s.1 + (s.3 - s.1) * (t - s.0) / (s.2 - s.0);
            return Some((at(t0), at(t1)));
        }
        ranges.iter().any(|r| mid > r.0 && mid < r.1).then_some((e, e))
    };
    let mut walls: Vec<Vec<P3>> = Vec::new();
    let (mut bottom, mut top): (Vec<(f64, f64)>, Vec<(f64, f64)>) = (Vec::new(), Vec::new());
    let mut flush = |bottom: &mut Vec<(f64, f64)>, top: &mut Vec<(f64, f64)>| {
        let mut ring: Vec<(f64, f64)> = std::mem::take(bottom);
        ring.extend(top.drain(..).rev());
        ring.dedup_by(|x, y| (x.0 - y.0).abs() < 1e-9 && (x.1 - y.1).abs() < 1e-9);
        if ring.len() > 2 && ring.first().zip(ring.last()).is_some_and(|(x, y)| (x.0 - y.0).abs() < 1e-9 && (x.1 - y.1).abs() < 1e-9) {
            ring.pop();
        }
        if ring.len() >= 3 {
            walls.push(ring.iter().map(|&(t, z)| [a[0] + u[0] * t, a[1] + u[1] * t, z]).collect());
        }
    };
    for w in ts.windows(2) {
        let (t0, t1) = (w[0], w[1]);
        let (Some(l), Some(r)) = (side(true, t0, t1), side(false, t0, t1)) else {
            flush(&mut bottom, &mut top);
            continue;
        };
        // Kreuzen sich die beiden Seiten im Intervall, dort teilen.
        let (d0, d1) = (l.0 - r.0, l.1 - r.1);
        let pieces: Vec<(f64, f64)> = if d0 * d1 < 0.0 {
            let tm = t0 + d0 / (d0 - d1) * (t1 - t0);
            vec![(t0, tm), (tm, t1)]
        } else {
            vec![(t0, t1)]
        };
        for (pa, pb) in pieces {
            let at = |s: (f64, f64), t: f64| s.0 + (s.1 - s.0) * (t - t0) / (t1 - t0);
            let (la, lb, ra, rb) = (at(l, pa), at(l, pb), at(r, pa), at(r, pb));
            let (lo0, hi0, lo1, hi1) = (la.min(ra), la.max(ra), lb.min(rb), lb.max(rb));
            if hi0 - lo0 < 1e-9 && hi1 - lo1 < 1e-9 {
                flush(&mut bottom, &mut top);
                continue;
            }
            bottom.extend([(pa, lo0), (pb, lo1)]);
            top.extend([(pa, hi0), (pb, hi1)]);
        }
    }
    flush(&mut bottom, &mut top);
    walls
}

/// Senkrechte Giebelfläche über der Kante a→b: Profil aus allen Flächenecken auf der Kante.
fn gable_face(planes: &[Vec<P3>], a: P2, b: P2, e: f64, dist: impl Fn(P2) -> f64) -> Option<Vec<P3>> {
    let len2 = (b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2);
    let mut top: Vec<(f64, P3)> = Vec::new();
    for pl in planes {
        for &v in pl {
            let t = ((v[0] - a[0]) * (b[0] - a[0]) + (v[1] - a[1]) * (b[1] - a[1])) / len2;
            if dist([v[0], v[1]]).abs() < 1e-5 && t > -1e-6 && t < 1.0 + 1e-6 {
                top.push((t, v));
            }
        }
    }
    top.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut prof: Vec<(f64, P3)> = Vec::new();
    for (i, p) in top.iter().enumerate() {
        if i == 0 || (p.0 - top[i - 1].0).abs() > 1e-6 {
            prof.push(*p);
        }
    }
    if prof.len() < 2 {
        return None;
    }
    let mut poly: Vec<P3> = vec![[a[0], a[1], e], [b[0], b[1], e]];
    poly.extend(prof.iter().rev().map(|p| p.1));
    Some(poly)
}

/// Bisheriges Keil-Verfahren (vor [B2]): Rückfall, wenn der Skeleton scheitert. Richtig für
/// konvexe und die meisten rechtwinkligen Grundrisse; bei Split-Ereignissen (eine Ecke läuft
/// in eine ferne Kante) kann eine Kante in einem Bereich „regieren“, den ihre Wellenfront nie
/// erreicht.
fn hip_roof_wedge(eaves_in: &[P2], tan: f64, e: f64, ridge_axis: Option<Axis>, knee: Option<Knee>) -> SkeletonRoof {
    let mut eaves = clean_ring(eaves_in);
    if eaves.len() < 3 || eaves.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()) {
        return SkeletonRoof::default();
    }
    if signed_area(&eaves) < 0.0 {
        eaves.reverse();
    }
    let n = eaves.len();
    let edges: Vec<Edge> = (0..n)
        .map(|i| {
            let a = eaves[i];
            let b = eaves[(i + 1) % n];
            let len = (b[0] - a[0]).hypot(b[1] - a[1]);
            let len = if len == 0.0 { 1.0 } else { len };
            Edge { a, b, n: [-(b[1] - a[1]) / len, (b[0] - a[0]) / len] }
        })
        .collect();
    // Giebelkante = quer zur Firstrichtung: keine Neigung, begrenzt nur die Nachbarkeile.
    let is_gable: Vec<bool> = edges.iter().map(|ed| is_gable_edge(ed.a, ed.b, ridge_axis)).collect();
    let dist = |k: usize, p: P2| (p[0] - edges[k].a[0]) * edges[k].n[0] + (p[1] - edges[k].a[1]) * edges[k].n[1];
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in &eaves {
        min_x = min_x.min(p[0]);
        min_y = min_y.min(p[1]);
        max_x = max_x.max(p[0]);
        max_y = max_y.max(p[1]);
    }
    let pad = (max_x - min_x + max_y - min_y) * 2.0 + 10.0;
    let big = [[min_x - pad, min_y - pad], [max_x + pad, min_y - pad], [max_x + pad, max_y + pad], [min_x - pad, max_y + pad]];
    // Keil je Kante: Innenseite der Kante ∩ Innenseiten der beiden Halbierenden.
    let wedge: Vec<Vec<P2>> = (0..n)
        .map(|k| {
            let ed = &edges[k];
            let prev = &edges[(k + n - 1) % n];
            let next = &edges[(k + 1) % n];
            // An Giebelkanten steht die Keilgrenze senkrecht zur Traufe (= Verlängerung des Giebels).
            let bis_a = if is_gable[(k + n - 1) % n] { ed.n } else { [ed.n[0] + prev.n[0], ed.n[1] + prev.n[1]] };
            let bis_b = if is_gable[(k + 1) % n] { ed.n } else { [ed.n[0] + next.n[0], ed.n[1] + next.n[1]] };
            let side = |o: P2, dir: P2, r: P2| {
                let s = (dir[0] * (r[1] - o[1]) - dir[1] * (r[0] - o[0])).signum();
                let s = if s == 0.0 || s.is_nan() { 1.0 } else { s };
                move |p: P2| s * (dir[0] * (p[1] - o[1]) - dir[1] * (p[0] - o[0]))
            };
            let mut w = clip_half(&big, |p| dist(k, p));
            // Giebelgrenze minimal nach aussen schieben: deckungsgleich mit der Traufring-Kante
            // würde der Polygon-Boolean an kollinearen Segmenten scheitern.
            let len = (ed.b[0] - ed.a[0]).hypot(ed.b[1] - ed.a[1]);
            let len = if len == 0.0 { 1.0 } else { len };
            let ux = (ed.b[0] - ed.a[0]) / len * 1e-4;
            let uy = (ed.b[1] - ed.a[1]) / len * 1e-4;
            let oa = if is_gable[(k + n - 1) % n] { [ed.a[0] - ux, ed.a[1] - uy] } else { ed.a };
            let ob = if is_gable[(k + 1) % n] { [ed.b[0] + ux, ed.b[1] + uy] } else { ed.b };
            w = clip_half(&w, side(oa, bis_a, ed.b));
            w = clip_half(&w, side(ob, bis_b, ed.a));
            w
        })
        .collect();
    let eaves_poly: Vec<Polygon> = vec![vec![to_ring(&eaves)]];
    let mut out = SkeletonRoof::default();
    let mut line_keys: HashSet<[i64; 4]> = HashSet::new();
    // Liegt der Punkt auf der Traufkante k (Gerade UND innerhalb der Strecke)?
    let on_seg = |k: usize, p: P2| {
        let Edge { a, b, .. } = edges[k];
        let len2 = (b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2);
        let len2 = if len2 == 0.0 { 1.0 } else { len2 };
        let t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2;
        dist(k, p).abs() < 1e-5 && t > -1e-6 && t < 1.0 + 1e-6
    };
    let on_eaves = |p: P2, q: P2| (0..n).any(|k| on_seg(k, p) && on_seg(k, q));

    for k in 0..n {
        if is_gable[k] || wedge[k].len() < 3 {
            continue;
        }
        let mut face = polygon_bool::intersection(&eaves_poly, &[vec![to_ring(&wedge[k])]]);
        // Bereiche, in denen eine andere Kante tiefer liegt, abziehen.
        let mut subtract: Vec<Polygon> = Vec::new();
        for f in 0..n {
            if f == k || is_gable[f] || wedge[f].len() < 3 {
                continue;
            }
            // Deckungsgleiche Ebenen (gleiche Gerade/Normale, z. B. zwei Traufkanten einer Flucht
            // mit Versatz dazwischen): g ≡ 0 — nur EINE der beiden Flächen darf die andere
            // abziehen, sonst fällt der überlappende Teil aus beiden heraus (Lücke im Dach).
            let coplanar = (edges[k].n[0] - edges[f].n[0]).abs() < 1e-9
                && (edges[k].n[1] - edges[f].n[1]).abs() < 1e-9
                && dist(f, edges[k].a).abs() < 1e-9;
            if coplanar && f > k {
                continue;
            }
            // dist_f(p) < dist_k(p)  ⇔  g(p) = dist_k(p) − dist_f(p) > 0
            let lower = clip_half(&wedge[f], |p| dist(k, p) - dist(f, p));
            if lower.len() >= 3 && signed_area(&lower).abs() > 1e-9 {
                subtract.push(vec![to_ring(&lower)]);
            }
        }
        if !subtract.is_empty() && !face.is_empty() {
            face = polygon_bool::difference(&face, &subtract);
        }
        let z = |p: P2| {
            let d = dist(k, p).max(0.0);
            match knee {
                Some(kn) => e + tan * d.min(kn.d) + kn.tan_up * (d - kn.d).max(0.0),
                None => e + tan * d,
            }
        };
        for poly in &face {
            let Some(ring) = poly.first() else { continue };
            let outer = clean_ring(&ring.iter().map(|p| [snap(p[0]), snap(p[1])]).collect::<Vec<_>>());
            if outer.len() < 3 || signed_area(&outer).abs() < 1e-6 {
                continue;
            }
            for piece in convex_pieces(&outer) {
                // Mansarde: Teilfläche an der Knicklinie (Traufabstand = knee.d) teilen.
                let parts = match knee {
                    Some(kn) => vec![clip_half(&piece, |p| kn.d - dist(k, p)), clip_half(&piece, |p| dist(k, p) - kn.d)],
                    None => vec![piece.clone()],
                };
                for part in parts {
                    if part.len() < 3 || signed_area(&part).abs() < 1e-9 {
                        continue;
                    }
                    out.planes.push(part.iter().map(|&p| [p[0], p[1], z(p)]).collect());
                }
                if let Some(kn) = knee {
                    let low = clip_half(&piece, |p| kn.d - dist(k, p));
                    let m = low.len();
                    for i in 0..m {
                        let p = low[i];
                        let q = low[(i + 1) % m];
                        if (dist(k, p) - kn.d).abs() < 1e-6 && (dist(k, q) - kn.d).abs() < 1e-6 {
                            out.breaks.push([p, q]);
                        }
                    }
                }
            }
            // Grat-/Kehl-/Firstlinien: Flächenränder, die nicht auf der Traufe liegen.
            let m = outer.len();
            for i in 0..m {
                let p = outer[i];
                let q = outer[(i + 1) % m];
                if on_eaves(p, q) {
                    continue;
                }
                let r = |v: f64| (v * 1e5).round() as i64;
                let kp = [r(p[0]), r(p[1])];
                let kq = [r(q[0]), r(q[1])];
                let key = if kp < kq { [kp[0], kp[1], kq[0], kq[1]] } else { [kq[0], kq[1], kp[0], kp[1]] };
                if !line_keys.insert(key) {
                    continue;
                }
                let (zp, zq) = (z(p), z(q));
                out.ridge_height = out.ridge_height.max(zp - e).max(zq - e);
                if (zp - zq).abs() < 1e-6 {
                    out.ridges.push([p, q]);
                } else {
                    out.hips.push([p, q]);
                }
            }
        }
    }
    for (k, ed) in edges.iter().enumerate() {
        if is_gable[k] {
            if let Some(g) = gable_face(&out.planes, ed.a, ed.b, e, |p| dist(k, p)) {
                out.gables.push(g);
            }
        }
    }
    out
}

// ── Konvexe Zerlegung ───────────────────────────────────────────────────────

fn cross(o: P2, a: P2, b: P2) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

fn is_convex(poly: &[P2]) -> bool {
    let n = poly.len();
    (0..n).all(|i| cross(poly[i], poly[(i + 1) % n], poly[(i + 2) % n]) >= -1e-12)
}

/// Ohr-Schnitt eines einfachen CCW-Polygons → Dreiecke (Indizes).
fn ear_clip(poly: &[P2]) -> Vec<Vec<usize>> {
    let mut idx: Vec<usize> = (0..poly.len()).collect();
    let mut tris = Vec::new();
    let in_tri = |p: P2, a: P2, b: P2, c: P2| cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
    let mut guard = 0;
    while idx.len() > 3 && guard < 10000 {
        guard += 1;
        let mut cut = false;
        let m = idx.len();
        for i in 0..m {
            let (ia, ib, ic) = (idx[(i + m - 1) % m], idx[i], idx[(i + 1) % m]);
            let (a, b, c) = (poly[ia], poly[ib], poly[ic]);
            if cross(a, b, c) <= 1e-12 {
                continue; // einspringend/entartet
            }
            if idx.iter().any(|&j| j != ia && j != ib && j != ic && in_tri(poly[j], a, b, c)) {
                continue;
            }
            tris.push(vec![ia, ib, ic]);
            idx.remove(i);
            cut = true;
            break;
        }
        if !cut {
            break; // numerisch entartet: Rest als Fächer
        }
    }
    for i in 1..idx.len().saturating_sub(1) {
        tris.push(vec![idx[0], idx[i], idx[i + 1]]);
    }
    tris
}

/// Konvexe Teilpolygone (beliebiger Umlaufsinn, Ausgabe CCW): Ohr-Schnitt, dann
/// Hertel–Mehlhorn-Verschmelzen.
pub fn convex_pieces(poly_in: &[P2]) -> Vec<Vec<P2>> {
    let mut poly = poly_in.to_vec();
    if signed_area(&poly) < 0.0 {
        poly.reverse();
    }
    if is_convex(&poly) {
        return vec![poly];
    }
    let mut pieces = ear_clip(&poly);
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..pieces.len() {
            for j in (i + 1)..pieces.len() {
                let (a, b) = (&pieces[i], &pieces[j]);
                // Gemeinsame Kante (u→v in A, v→u in B) suchen.
                for s in 0..a.len() {
                    let u = a[s];
                    let v = a[(s + 1) % a.len()];
                    let Some(t) = (0..b.len()).find(|&k| b[k] == v && b[(k + 1) % b.len()] == u) else { continue };
                    // A ab v rundum bis u, dann B ab u (ohne u) bis vor v.
                    let mut cand: Vec<usize> = (0..a.len()).map(|k| a[(s + 1 + k) % a.len()]).collect();
                    cand.extend((2..b.len()).map(|k| b[(t + k) % b.len()]));
                    if is_convex(&cand.iter().map(|&q| poly[q]).collect::<Vec<_>>()) {
                        let (lo, hi) = (i.min(j), i.max(j));
                        pieces.remove(hi);
                        pieces.remove(lo);
                        pieces.push(cand);
                        merged = true;
                        break 'outer;
                    }
                }
            }
        }
    }
    pieces.into_iter().map(|pc| pc.into_iter().map(|q| poly[q]).collect()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: [P2; 6] = [[0.0, 0.0], [11.0, 0.0], [11.0, 4.0], [8.0, 4.0], [8.0, 6.0], [0.0, 6.0]];

    fn plan_area(pts: &[P3]) -> f64 {
        signed_area(&pts.iter().map(|p| [p[0], p[1]]).collect::<Vec<_>>()).abs()
    }

    #[test]
    fn walm_auf_l_deckt_grundriss_mit_kehle() {
        let r = hip_roof(&L, 1.0, 0.0, None, None);
        let total: f64 = r.planes.iter().map(|p| plan_area(p)).sum();
        assert!((total - 60.0).abs() < 1e-6, "{total}");
        assert!((r.ridge_height - 3.0).abs() < 1e-6);
        for p in &r.planes {
            assert_eq!(convex_pieces(&p.iter().map(|v| [v[0], v[1]]).collect::<Vec<_>>()).len(), 1);
        }
        // Kehle: einspringende Ecke (8,4) steigt zum Kehlpunkt (6,2).
        let hit = |a: P2, b: P2| (a == [8.0, 4.0] && b == [6.0, 2.0]) || (b == [8.0, 4.0] && a == [6.0, 2.0]);
        assert!(r.hips.iter().any(|l| hit(l[0], l[1])), "{:?}", r.hips);
    }

    #[test]
    fn sattel_auf_l_hat_drei_giebel() {
        let r = hip_roof(&L, 1.0, 0.0, Some(Axis::X), None);
        let total: f64 = r.planes.iter().map(|p| plan_area(p)).sum();
        assert!((total - 60.0).abs() < 1e-6);
        assert_eq!(r.gables.len(), 3);
        let g = r.gables.iter().find(|g| g.iter().all(|v| v[0] == 0.0)).unwrap();
        assert!((g.iter().map(|v| v[2]).fold(0.0, f64::max) - 3.0).abs() < 1e-6);
    }

    #[test]
    fn mansarde_knick_teilt_flaechen() {
        let r = hip_roof(&L, 1.0, 0.0, None, Some(Knee { d: 1.0, tan_up: 0.0 }));
        let total: f64 = r.planes.iter().map(|p| plan_area(p)).sum();
        assert!((total - 60.0).abs() < 1e-6);
        assert!(!r.breaks.is_empty());
        assert!((r.ridge_height - 1.0).abs() < 1e-6);
    }

    #[test]
    fn erkennung_der_umrisse() {
        assert!(is_rectilinear_non_rect(&L));
        let rect = [[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]];
        assert!(!is_rectilinear_non_rect(&rect));
        assert!(!is_skeleton_roofable(&rect));
        assert!(is_skeleton_roofable(&[[0.0, 0.0], [8.0, 0.0], [10.0, 5.0], [4.0, 8.0], [-2.0, 5.0]]));
        // Schleife (Achterform) ist nicht einfach.
        assert!(!is_skeleton_roofable(&[[0.0, 0.0], [4.0, 4.0], [4.0, 0.0], [0.0, 4.0]]));
        // Kollineare und doppelte Punkte fallen weg.
        assert_eq!(clean_ring(&[[0.0, 0.0], [2.0, 0.0], [4.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]]).len(), 4);
    }

    #[test]
    fn konvexe_zerlegung_erhaelt_flaeche() {
        let pcs = convex_pieces(&L);
        assert!(pcs.len() >= 2);
        let total: f64 = pcs.iter().map(|p| signed_area(p)).sum();
        assert!((total - 60.0).abs() < 1e-9);
        for p in &pcs {
            assert!(is_convex(p));
        }
    }

    #[test]
    fn versatz_mit_gehrung() {
        let o = offset_ring(&L, Offset::Const(0.5));
        assert_eq!(o[0], [-0.5, -0.5]);
        assert_eq!(o[3], [8.5, 4.5]);
        let f = |a: P2, b: P2| if (b[0] - a[0]).abs() > (b[1] - a[1]).abs() { 0.5 } else { 1.0 };
        let o = offset_ring(&L, Offset::PerEdge(&f));
        assert_eq!(o[0], [-1.0, -0.5]);
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(hip_roof(&[], 1.0, 0.0, None, None).planes.is_empty());
        assert!(hip_roof(&[[0.0, 0.0], [1.0, 1.0]], 1.0, 0.0, None, None).planes.is_empty());
        // NaN-Punkte fallen beim Säubern weg, der Rest bleibt ein gültiges Dach.
        let r = hip_roof(&[[f64::NAN, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.5]], 1.0, 0.0, None, None);
        assert!(r.planes.iter().flatten().all(|v| v.iter().all(|c| c.is_finite())));
        let _ = hip_roof(&L, f64::NAN, f64::INFINITY, Some(Axis::Y), Some(Knee { d: f64::NAN, tan_up: f64::NAN }));
        assert!(convex_pieces(&[]).len() <= 1);
        let _ = convex_pieces(&[[0.0, 0.0], [1.0, 0.0]]);
        let _ = offset_ring(&[], Offset::Const(1.0));
        assert!(!is_skeleton_roofable(&[]));
        assert!(!is_rectilinear_non_rect(&[]));
    }

    // ── [B2] Skeleton gegen das bisherige Keil-Verfahren ────────────────────

    /// Dachhöhe an (x, y) über die Flächen (None = ausserhalb).
    fn height_at(planes: &[Vec<P3>], x: f64, y: f64) -> Option<f64> {
        crate::roof::roof_underside_at(planes, 0.0, x, y)
    }

    fn total_area(r: &SkeletonRoof) -> f64 {
        r.planes.iter().map(|p| plan_area(p)).sum()
    }

    fn bbox(ring: &[P2]) -> (f64, f64, f64, f64) {
        ring.iter().fold((f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY), |b, p| (b.0.min(p[0]), b.1.min(p[1]), b.2.max(p[0]), b.3.max(p[1])))
    }

    fn in_ring(p: P2, ring: &[P2]) -> bool {
        let n = ring.len();
        let mut inside = false;
        for i in 0..n {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
        }
        inside
    }

    /// Grösste Höhenabweichung zweier Dächer auf einem Raster über dem Grundriss (Rasterpunkte
    /// leicht verschoben, damit sie nicht auf Graten liegen); None, wenn nur eines einen Punkt deckt.
    fn max_dz(a: &SkeletonRoof, b: &SkeletonRoof, ring: &[P2]) -> Option<f64> {
        let (x0, y0, x1, y1) = bbox(ring);
        let mut worst: f64 = 0.0;
        let steps = 41;
        for i in 0..steps {
            for j in 0..steps {
                let x = x0 + (x1 - x0) * (i as f64 + 0.5123) / steps as f64;
                let y = y0 + (y1 - y0) * (j as f64 + 0.4871) / steps as f64;
                match (height_at(&a.planes, x, y), height_at(&b.planes, x, y)) {
                    (Some(za), Some(zb)) => worst = worst.max((za - zb).abs()),
                    (None, None) => {}
                    _ => return None,
                }
            }
        }
        Some(worst)
    }

    /// Ebene einer Fläche über die Newell-Normale: (a, b, c) mit c = Grundriss-Anteil.
    fn newell(pl: &[P3]) -> (f64, f64, f64) {
        let (mut a, mut b, mut c) = (0.0, 0.0, 0.0);
        for i in 0..pl.len() {
            let (p, q) = (pl[i], pl[(i + 1) % pl.len()]);
            a += (p[1] - q[1]) * (p[2] + q[2]);
            b += (p[2] - q[2]) * (p[0] + q[0]);
            c += (p[0] - q[0]) * (p[1] + q[1]);
        }
        (a, b, c)
    }

    /// Grösster Höhensprung zwischen Flächen: Höhe jeder Flächenecke gegen die Höhe jeder anderen
    /// Fläche, die den Punkt (inkl. Rand) enthält. Ein geschlossenes Dach hat keine Sprünge;
    /// zusammen mit „Grundflächen-Summe = Grundriss“ heisst das auch: keine Überlappung.
    fn jumps(r: &SkeletonRoof) -> Vec<(f64, f64, f64, f64)> {
        let inside = |pl: &[P3], x: f64, y: f64| {
            let m = pl.len();
            let s = signed_area(&pl.iter().map(|v| [v[0], v[1]]).collect::<Vec<_>>()).signum();
            (0..m).all(|i| {
                let (p, q) = (pl[i], pl[(i + 1) % m]);
                let l = (q[0] - p[0]).hypot(q[1] - p[1]).max(1e-12);
                s * ((q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])) / l >= -1e-6
            })
        };
        let mut out = Vec::new();
        for (i, pi) in r.planes.iter().enumerate() {
            for v in pi {
                for (j, pj) in r.planes.iter().enumerate() {
                    if i == j || pj.len() < 3 || !inside(pj, v[0], v[1]) {
                        continue;
                    }
                    let (a, b, c) = newell(pj);
                    if c.abs() < 1e-9 {
                        continue;
                    }
                    let z = pj[0][2] - (a * (v[0] - pj[0][0]) + b * (v[1] - pj[0][1])) / c;
                    if (z - v[2]).abs() > 1e-12 {
                        out.push((v[0], v[1], z.min(v[2]), z.max(v[2])));
                    }
                }
            }
        }
        out
    }

    fn max_jump(r: &SkeletonRoof) -> f64 {
        jumps(r).iter().map(|j| j.3 - j.2).fold(0.0, f64::max)
    }

    /// Grösster Sprung, den keine Giebelwand schliesst (Wand senkrecht über dem Punkt, deckt die
    /// Mitte des Sprungs).
    fn open_jump(r: &SkeletonRoof) -> f64 {
        let covered = |x: f64, y: f64, z: f64| {
            r.gables.iter().any(|g| {
                let (a, b) = (g[0], g.iter().copied().find(|q| (q[0] - g[0][0]).hypot(q[1] - g[0][1]) > 1e-6).unwrap_or(g[0]));
                let l = (b[0] - a[0]).hypot(b[1] - a[1]);
                if l < 1e-9 {
                    return false;
                }
                let u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
                if ((x - a[0]) * -u[1] + (y - a[1]) * u[0]).abs() > 1e-6 {
                    return false;
                }
                let tz: Vec<P2> = g.iter().map(|q| [(q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1], q[2]]).collect();
                let t = (x - a[0]) * u[0] + (y - a[1]) * u[1];
                in_ring([t, z], &tz)
            })
        };
        jumps(r).iter().filter(|j| j.3 - j.2 > 1e-9 && !covered(j.0, j.1, (j.2 + j.3) / 2.0)).map(|j| j.3 - j.2).fold(0.0, f64::max)
    }

    /// Wie weit das Dach höchstens über e + tan · (Abstand zum Umriss) steigt. Beim echten
    /// Straight-Skeleton-Dach (gleiche Neigung) nie: die Wellenfront hat jeden Punkt spätestens
    /// nach seinem Randabstand erreicht — ein positiver Wert zeigt ein falsches Dach.
    fn above_boundary_distance(r: &SkeletonRoof, rings: &[Vec<P2>], tan: f64, e: f64) -> f64 {
        let seg = |p: P2, a: P2, b: P2| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
        };
        let mut worst = f64::NEG_INFINITY;
        for pl in &r.planes {
            for v in pl {
                let d = rings.iter().flat_map(|ring| (0..ring.len()).map(move |i| seg([v[0], v[1]], ring[i], ring[(i + 1) % ring.len()]))).fold(f64::INFINITY, f64::min);
                worst = worst.max(v[2] - e - tan * d);
            }
        }
        worst
    }

    /// Ein richtiges Dach: deckt den Grundriss genau (Summe der Grundflächen und jeder
    /// Rasterpunkt gedeckt), springt nirgends.
    fn assert_sound(r: &SkeletonRoof, rings: &[Vec<P2>], what: &str) {
        let area: f64 = rings.iter().map(|x| signed_area(x)).sum::<f64>().abs();
        assert!((total_area(r) - area).abs() < 1e-6 * area.max(1.0), "{what}: Fläche {} statt {area}", total_area(r));
        assert!(open_jump(r) < 1e-9, "{what}: offener Sprung {}", open_jump(r));
        if r.gables.is_empty() {
            assert!(max_jump(r) < 1e-9, "{what}: Sprung {}", max_jump(r));
        }
        let (x0, y0, x1, y1) = bbox(&rings[0]);
        for i in 0..23 {
            for j in 0..23 {
                let p = [x0 + (x1 - x0) * (i as f64 + 0.5123) / 23.0, y0 + (y1 - y0) * (j as f64 + 0.4871) / 23.0];
                let inside = rings.iter().filter(|ring| in_ring(p, ring)).count() % 2 == 1;
                assert_eq!(height_at(&r.planes, p[0], p[1]).is_some(), inside, "{what}: Deckung bei {p:?}");
            }
        }
    }

    /// Ob jede Linie von `a` auf Linien von `b` liegt (Stückelung darf sich unterscheiden);
    /// mit `flat` (Dach, Umriss): Stellen, an denen dieses Dach quer zur Linie eben weiterläuft
    /// (Linie ohne Knick, keine Dachkante) oder die auf dem Umriss liegen, zählen als gedeckt.
    fn lines_cover(a: &[Line], b: &[Line], flat: Option<(&SkeletonRoof, &[P2])>) -> bool {
        let near = |p: P2, l: &Line| {
            let (dx, dy) = (l[1][0] - l[0][0], l[1][1] - l[0][1]);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 { (((p[0] - l[0][0]) * dx + (p[1] - l[0][1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            (p[0] - l[0][0] - t * dx).hypot(p[1] - l[0][1] - t * dy)
        };
        let on = |p: P2, l: &Line| near(p, l) < 1e-6;
        a.iter().all(|l| {
            (1..8).all(|i| {
                let f = i as f64 / 8.0;
                let p = [l[0][0] + f * (l[1][0] - l[0][0]), l[0][1] + f * (l[1][1] - l[0][1])];
                b.iter().any(|m| on(p, m)) || flat.is_some_and(|(r, ring)| flat_across(r, l, p) || (0..ring.len()).any(|k| near(p, &[ring[k], ring[(k + 1) % ring.len()]]) < 2e-4))
            })
        })
    }

    /// Ob das Dach bei `m` quer über die Linie `l` eben weiterläuft.
    fn flat_across(r: &SkeletonRoof, l: &Line, m: P2) -> bool {
        let len = (l[1][0] - l[0][0]).hypot(l[1][1] - l[0][1]);
        let nv = [-(l[1][1] - l[0][1]) / len * 1e-3, (l[1][0] - l[0][0]) / len * 1e-3];
        let z = |k: f64| height_at(&r.planes, m[0] + k * nv[0], m[1] + k * nv[1]);
        match (z(-2.0), z(-1.0), z(1.0), z(2.0)) {
            (Some(a), Some(b), Some(c), Some(d)) => ((c - b) - (d - a) / 2.0).abs() < 1e-6,
            _ => false,
        }
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 33) as f64 / (1u64 << 31) as f64
        }
        /// Masse auf 5 cm gerundet, wie gezeichnete Grundrisse.
        fn dim(&mut self, lo: f64, hi: f64) -> f64 {
            ((lo + self.next() * (hi - lo)) * 20.0).round() / 20.0
        }
    }

    /// Zufällige rechtwinklige Grundrisse: L, T, U (achsparallel), Treppe (gestufte Flanken).
    fn random_footprint(rng: &mut Rng, kind: usize) -> Vec<P2> {
        let (w, d) = (rng.dim(6.0, 20.0), rng.dim(6.0, 16.0));
        match kind % 4 {
            0 => {
                let (a, b) = (rng.dim(2.0, w - 2.0), rng.dim(2.0, d - 2.0));
                vec![[0.0, 0.0], [w, 0.0], [w, b], [a, b], [a, d], [0.0, d]]
            }
            1 => {
                let (s, b) = (rng.dim(1.5, w / 2.0 - 0.5), rng.dim(2.0, d - 2.0));
                vec![[s, 0.0], [w - s, 0.0], [w - s, b], [w, b], [w, d], [0.0, d], [0.0, b], [s, b]]
            }
            2 => {
                let (s, b) = (rng.dim(1.5, w / 2.0 - 0.5), rng.dim(1.5, d - 1.5));
                vec![[0.0, 0.0], [w, 0.0], [w, d], [w - s, d], [w - s, b], [s, b], [s, d], [0.0, d]]
            }
            _ => {
                let steps = 2 + (rng.next() * 3.0) as usize;
                let (mut right, mut left): (Vec<P2>, Vec<P2>) = (vec![], vec![]);
                let mut y = 0.0;
                for _ in 0..steps {
                    let (xr, xl, h) = (rng.dim(2.0, 10.0), -rng.dim(2.0, 10.0), rng.dim(1.0, 6.0));
                    right.extend([[xr, y], [xr, y + h]]);
                    left.splice(0..0, [[xl, y + h], [xl, y]]);
                    y += h;
                }
                right.extend(left);
                clean_ring(&right)
            }
        }
    }

    /// Parität: auf zufälligen L/T/U/Treppen-Grundrissen (Walm, Sattel X/Y, Mansarde) liefern
    /// Skeleton und altes Keil-Verfahren dieselbe Dachfläche (Höhe auf 1e-9 gleich, gleiche
    /// Firsthöhe, gleich viele Giebel) — ausser wo das alte Verfahren nachweislich falsch ist
    /// (deckt den Grundriss doppelt bzw. springt). Das neue ist immer richtig.
    #[test]
    fn paritaet_mit_keilverfahren_auf_l_t_u() {
        let mut rng = Rng(7);
        // gleich | nur Giebelwände anders (Stufe an einspringender Ecke jetzt geschlossen) |
        // alt deckt falsch (doppelt/Lücke) | alt springt ohne Wand
        let mut count = [0usize; 4];
        for round in 0..800 {
            let ring = random_footprint(&mut rng, round);
            let tan = (rng.dim(15.0, 60.0) * std::f64::consts::PI / 180.0).tan();
            let (axis, knee) = match (round / 4) % 4 {
                0 => (None, None),
                1 => (Some(Axis::X), None),
                2 => (Some(Axis::Y), None),
                _ => (None, Some(Knee { d: 1.0, tan_up: 0.3 })),
            };
            let new = hip_roof(&ring, tan, 3.0, axis, knee);
            let old = hip_roof_wedge(&ring, tan, 3.0, axis, knee);
            let what = format!("{ring:?} {axis:?} {knee:?}");
            assert_sound(&new, &[ring.clone()], &what);
            let area = signed_area(&ring).abs();
            let dz = max_dz(&new, &old, &ring);
            let same_surface = dz.is_some_and(|d| d < 1e-9) && (new.ridge_height - old.ridge_height).abs() < 1e-9;
            let k = if same_surface && open_jump(&old) < 1e-9 {
                // Gleiche Dachfläche: auch Linien und Giebel gleich — bis auf Linien des alten
                // Verfahrens zwischen zwei Flächen derselben Ebene (keine Dachkante, jetzt weg).
                for (x, y, kind) in [(&new.ridges, &old.ridges, "First"), (&new.hips, &old.hips, "Grat"), (&new.breaks, &old.breaks, "Knick")] {
                    assert!(lines_cover(x, y, None) && lines_cover(y, x, Some((&old, &ring))), "{what}: {kind} {x:?} {y:?}");
                }
                assert_eq!(new.gables.len(), old.gables.len(), "{what}");
                0
            } else if same_surface {
                // Gleiche Dachfläche, aber die Stufe an einem Giebel in der einspringenden Ecke
                // war offen: jetzt mit Giebelwand geschlossen (Linien dort anders).
                1
            } else if (total_area(&old) - area).abs() > 1e-6 {
                2
            } else {
                assert!(open_jump(&old) > 1e-6, "abweichend, aber alt nicht falsch: {what} dz={dz:?}");
                3
            };
            count[k] += 1;
        }
        eprintln!("L/T/U/Treppe: {} gleich, {} nur Giebelwand geschlossen, {} alt deckt falsch, {} alt springt", count[0], count[1], count[2], count[3]);
        // Dachflächen gleich in > 98 % der Fälle; der Rest: alt deckte doppelt (Bucht-Giebel).
        assert!(count[0] + count[1] > 780 && count[3] == 0, "{count:?}");
    }

    /// Zufällige schiefwinklige, stark konkave Grundrisse (Sterne, Split-Ereignisse überall):
    /// das neue Dach ist immer richtig; das alte weicht oft ab und ist dann nachweislich falsch
    /// (steigt über den Randabstand, springt oder deckt doppelt).
    #[test]
    fn sterne_neu_richtig_alt_oft_falsch() {
        let mut rng = Rng(99);
        let (mut same, mut old_wrong) = (0, 0);
        for _ in 0..400 {
            let n = 5 + (rng.next() * 9.0) as usize;
            let ring: Vec<P2> = (0..n)
                .map(|i| {
                    let a = (i as f64 + rng.next() * 0.8) / n as f64 * std::f64::consts::TAU;
                    let r = 3.0 + rng.next() * 7.0;
                    [r * a.cos(), r * a.sin()]
                })
                .collect();
            if !is_skeleton_roofable(&ring) {
                continue;
            }
            let new = hip_roof(&ring, 1.0, 0.0, None, None);
            let rings = [ring.clone()];
            assert_sound(&new, &rings, &format!("{ring:?}"));
            assert!(above_boundary_distance(&new, &rings, 1.0, 0.0) < 1e-9, "{ring:?}");
            let old = hip_roof_wedge(&ring, 1.0, 0.0, None, None);
            if max_dz(&new, &old, &ring).is_some_and(|d| d < 1e-6) {
                same += 1;
                continue;
            }
            let area = signed_area(&ring).abs();
            let wrong = (total_area(&old) - area).abs() > 1e-6 || max_jump(&old) > 1e-6 || above_boundary_distance(&old, &rings, 1.0, 0.0) > 1e-5;
            assert!(wrong, "abweichend, aber alt nicht falsch: {ring:?}");
            old_wrong += 1;
        }
        eprintln!("Sterne: {same} gleich, {old_wrong} alt falsch");
        assert!(old_wrong > 100);
    }

    /// Fünfeck mit einspringender Ecke (Split-Ereignis): das alte Verfahren liess eine Kante in
    /// einem Bereich regieren, den ihre Wellenfront nie erreicht — First 6.49 m statt 3.50 m.
    #[test]
    fn alt_falsch_fuenfeck_mit_split() {
        let ring = vec![[1.813878404284597, 2.674811495947053], [-4.6640880609681865, 6.5257083984972075], [-7.477739292833127, -0.45841940910353607], [-0.7089480591605644, -3.3078293252888984], [4.024603417619533, -7.732432853365041]];
        let new = hip_roof(&ring, 1.0, 0.0, None, None);
        let old = hip_roof_wedge(&ring, 1.0, 0.0, None, None);
        assert_sound(&new, &[ring.clone()], "Fünfeck");
        assert!((new.ridge_height - 3.500343883146626).abs() < 1e-6, "{}", new.ridge_height);
        assert!(old.ridge_height > 6.4);
        assert!(above_boundary_distance(&old, &[ring], 1.0, 0.0) > 1.0);
    }

    /// U mit Firstrichtung X: die Innenflanken der Bucht sind Giebel. Das alte Verfahren deckte
    /// die Flügel doppelt (Fläche 104.04 statt 98.84 m²).
    #[test]
    fn alt_falsch_u_sattel_mit_giebeln_in_der_bucht() {
        let u = vec![[0.0, 0.0], [17.2, 0.0], [17.2, 6.7], [10.6, 6.7], [10.6, 2.6], [6.6, 2.6], [6.6, 6.7], [0.0, 6.7]];
        let new = hip_roof(&u, 1.0, 0.0, Some(Axis::X), None);
        assert_sound(&new, &[u.clone()], "U");
        assert_eq!(new.gables.len(), 4);
        let old = hip_roof_wedge(&u, 1.0, 0.0, Some(Axis::X), None);
        assert!(total_area(&old) > 104.0);
    }

    /// Gleichzeitige Ereignisse: Quadrat → Zeltspitze; Kreuz → alle Kehlen und Grate treffen sich.
    #[test]
    fn gleichzeitige_ereignisse() {
        let sq = vec![[0.0, 0.0], [6.0, 0.0], [6.0, 6.0], [0.0, 6.0]];
        let r = hip_roof(&sq, 1.0, 0.0, None, None);
        assert_sound(&r, &[sq], "Quadrat");
        assert_eq!((r.planes.len(), r.ridges.len(), r.hips.len()), (4, 0, 4));
        assert!((r.ridge_height - 3.0).abs() < 1e-12);
        let cross = vec![[2.0, 0.0], [4.0, 0.0], [4.0, 2.0], [6.0, 2.0], [6.0, 4.0], [4.0, 4.0], [4.0, 6.0], [2.0, 6.0], [2.0, 4.0], [0.0, 4.0], [0.0, 2.0], [2.0, 2.0]];
        let r = hip_roof(&cross, 1.0, 0.0, None, None);
        assert_sound(&r, &[cross.clone()], "Kreuz");
        assert!((r.ridge_height - 1.0).abs() < 1e-12);
        assert!(above_boundary_distance(&r, &[cross], 1.0, 0.0) < 1e-12);
    }

    /// Schiefwinklig: Parallelogramm mit Walm; Satteldach mit Giebeln auf den schrägen Kanten
    /// (quer zur Firstrichtung).
    #[test]
    fn schiefwinklig_und_giebel_auf_schraeger_kante() {
        let para = vec![[0.0, 0.0], [10.0, 0.0], [13.0, 5.0], [3.0, 5.0]];
        let r = hip_roof(&para, 0.5, 2.0, None, None);
        assert_sound(&r, &[para.clone()], "Parallelogramm");
        assert!(above_boundary_distance(&r, &[para.clone()], 0.5, 2.0) < 1e-9);
        let s = hip_roof(&para, 0.5, 2.0, Some(Axis::X), None);
        assert_sound(&s, &[para.clone()], "Parallelogramm Sattel");
        assert_eq!(s.gables.len(), 2);
        // First in halber Tiefe, auf voller Länge bis an die schrägen Giebel.
        assert!((s.ridge_height - 1.25).abs() < 1e-12);
        for g in &s.gables {
            assert!(g.iter().any(|v| (v[2] - 3.25).abs() < 1e-12 && (v[1] - 2.5).abs() < 1e-12), "{g:?}");
        }
    }

    /// Neigung je Kante und Hof (heute nicht im Modell, s. TODO [26]): direkt über
    /// [`weighted_roof`]. Jede Fläche steigt mit der Neigung ihrer Traufkante.
    #[test]
    fn neigung_je_kante_und_hof() {
        // Rechteck 10×4: Süd 30°, Nord 60°, Ost/West Giebel → First näher an Nord.
        let ring = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [0.0, 4.0]];
        let (ts, tn) = ((30f64).to_radians().tan(), (60f64).to_radians().tan());
        let r = weighted_roof(&[ring.clone()], &[Some(ts), None, Some(tn), None], 0.0, None, None).unwrap();
        assert_sound(&r, &[ring.clone()], "Neigung je Kante");
        // ts·y = tn·(4−y) → y = 4·tn/(ts+tn) = 3; Höhe = ts·3.
        assert!((r.ridge_height - 3.0 * ts).abs() < 1e-9, "{}", r.ridge_height);
        assert_eq!(r.gables.len(), 2);
        for pl in &r.planes {
            let (a, b, c) = newell(pl);
            let slope = a.hypot(b) / c.abs();
            assert!((slope - ts).abs() < 1e-9 || (slope - tn).abs() < 1e-9, "{slope}");
        }
        // Hof 4×4 in 12×12 (Loch im Uhrzeigersinn): Firstring auf Höhe 2·tan.
        let rings = vec![vec![[0.0, 0.0], [12.0, 0.0], [12.0, 12.0], [0.0, 12.0]], vec![[4.0, 4.0], [4.0, 8.0], [8.0, 8.0], [8.0, 4.0]]];
        let r = weighted_roof(&rings, &[Some(1.0); 8], 3.0, None, None).unwrap();
        assert_sound(&r, &rings, "Hof");
        assert!((r.ridge_height - 2.0).abs() < 1e-9);
        assert_eq!(r.ridges.len(), 4);
        assert!(above_boundary_distance(&r, &rings, 1.0, 3.0) < 1e-9);
        // Hof mit Giebel an der Nordkante des Hofs.
        let mut slopes = vec![Some(1.0); 8];
        slopes[5] = None;
        let g = weighted_roof(&rings, &slopes, 0.0, None, None).unwrap();
        assert_sound(&g, &rings, "Hof mit Giebel");
        assert_eq!(g.gables.len(), 1);
    }

    #[test]
    fn budget_und_rueckfall() {
        let u = vec![[0.0, 0.0], [12.0, 0.0], [12.0, 9.0], [8.0, 9.0], [8.0, 4.0], [4.0, 4.0], [4.0, 9.0], [0.0, 9.0]];
        assert_eq!(weighted_roof(&[u.clone()], &[Some(1.0); 8], 0.0, None, Some(2)).unwrap_err(), SkeletonError::Budget);
        assert!(matches!(weighted_roof(&[u.clone()], &[Some(1.0); 3], 0.0, None, None), Err(SkeletonError::Input(_))));
        // Selbstüberschneidender Ring: Skeleton scheitert → Keil-Verfahren, kein Panic.
        let _ = hip_roof(&[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [5.0, -5.0], [0.0, 10.0]], 1.0, 0.0, None, None);
        let _ = weighted_roof(&[u.clone()], &[Some(f64::NAN); 8], f64::NAN, Some(Knee { d: f64::NAN, tan_up: f64::NAN }), None);
        assert!(weighted_roof(&[u], &[None; 8], 0.0, None, None).is_err());
    }
}
