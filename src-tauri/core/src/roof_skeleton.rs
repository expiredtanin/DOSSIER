//! Dachflächen über beliebigen einfachen Grundrissen (L/T/U/Z, Fünfeck, schiefe Winkel):
//! echte Flächen mit Graten UND Kehlen statt der Bounding-Box-Vereinfachung aus [`crate::roof`].
//!
//! Modell (Straight-Skeleton-Dach bei gleicher Neigung ringsum): jede Traufkante e „regiert“
//! in ihrem Keil — begrenzt von der Kante selbst und den Winkelhalbierenden an ihren Enden (an
//! einer einspringenden Ecke wird die Halbierende zur Kehle). Die Dachhöhe ist die NIEDRIGSTE
//! Ebene aller Kanten, deren Keil den Punkt enthält:
//!   z(p) = e + tan(Neigung) · min{ dist(p, Gerade f) | p ∈ Keil(f) }.
//! Die Fläche von e = (Traufpolygon ∩ Keil(e)) minus alle Bereiche, in denen eine andere Kante
//! tiefer liegt (Polygon-Booleans aus [`crate::polygon_bool`]). Danach in KONVEXE Teilflächen
//! zerlegt (Ohr-Schnitt + Hertel–Mehlhorn), weil Renderer/Schnitt konvexe Flächen erwarten.
//!
//! Portiert aus `src/geometry/roofSkeleton.ts` (TS-Fassung gelöscht).

use crate::flat::Polygon;
use crate::polygon_bool;
use std::collections::HashSet;

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

/// Walm-/Sattel-/Mansarddach-Flächen über dem Traufring `eaves_in` (beliebige Orientierung)
/// bei Neigung `tan` und Traufhöhe `e`. `ridge_axis` gesetzt → Satteldach: Kanten quer zu
/// dieser Firstrichtung sind senkrechte Giebel (Ortgang). `knee` → Mansarde.
pub fn hip_roof(eaves_in: &[P2], tan: f64, e: f64, ridge_axis: Option<Axis>, knee: Option<Knee>) -> SkeletonRoof {
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
    let is_gable: Vec<bool> = edges
        .iter()
        .map(|ed| match ridge_axis {
            None => false,
            Some(Axis::X) => (ed.b[0] - ed.a[0]).abs() < (ed.b[1] - ed.a[1]).abs(),
            Some(Axis::Y) => (ed.b[1] - ed.a[1]).abs() < (ed.b[0] - ed.a[0]).abs(),
        })
        .collect();
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
    // Giebelflächen: Profil = alle Flächenecken auf der Giebelkante, nach Lage sortiert.
    for (k, ed) in edges.iter().enumerate() {
        if !is_gable[k] {
            continue;
        }
        let len2 = (ed.b[0] - ed.a[0]).powi(2) + (ed.b[1] - ed.a[1]).powi(2);
        let mut top: Vec<(f64, P3)> = Vec::new();
        for pl in &out.planes {
            for &v in pl {
                let t = ((v[0] - ed.a[0]) * (ed.b[0] - ed.a[0]) + (v[1] - ed.a[1]) * (ed.b[1] - ed.a[1])) / len2;
                if dist(k, [v[0], v[1]]).abs() < 1e-5 && t > -1e-6 && t < 1.0 + 1e-6 {
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
            continue;
        }
        let mut poly: Vec<P3> = vec![[ed.a[0], ed.a[1], e], [ed.b[0], ed.b[1], e]];
        poly.extend(prof.iter().rev().map(|p| p.1));
        out.gables.push(poly);
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
}
