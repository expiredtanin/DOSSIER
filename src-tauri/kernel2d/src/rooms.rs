//! Raum-Erkennung aus Wandsegmenten (planarer Graph, Flächen, Raum aus Punkt, Flächen mit Inseln); gerufen vom Raum-Werkzeug über `dossier-core`.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use crate::*;
use serde::{Deserialize, Serialize};

// --- Raum-Erkennung (roomBoundary.ts, Slice 3) -------------------------------
// Lokale Konstanten exakt wie TS (EPS=1e-9, normalize-Guard 1e-12).

const RB_EPS: f64 = 1e-9;

/// normalize (roomBoundary-Variante): Guard `l < 1e-12 → {0,0}` (NICHT `l||1`).
#[inline]
fn rb_normalize(a: Vec2) -> Vec2 {
    let l = len(a);
    if l < 1e-12 { Vec2 { x: 0.0, y: 0.0 } } else { Vec2 { x: a.x / l, y: a.y / l } }
}

/// cross (lokal, identisch zur globalen).
#[inline]
fn rb_cross(a: Vec2, b: Vec2) -> f64 {
    a.x * b.y - a.y * b.x
}

// ── Planarer Graph ────────────────────────────────────────────────────────────

struct RbNode {
    p: Vec2,
}

struct RbUEdge {
    u: usize,
    v: usize,
}

struct RbSplit {
    t: f64,
    p: Vec2,
}

/// Baut den planaren Graphen aus Mittellinien-Segmenten (Port von `buildPlanarGraph`).
fn build_planar_graph(segments: &[(Vec2, Vec2)], snap: f64) -> (Vec<RbNode>, Vec<RbUEdge>) {
    let mut nodes: Vec<RbNode> = Vec::new();

    let add_node = |nodes: &mut Vec<RbNode>, p: Vec2| -> usize {
        for i in 0..nodes.len() {
            if dist(nodes[i].p, p) <= snap {
                return i;
            }
        }
        nodes.push(RbNode { p: Vec2 { x: p.x, y: p.y } });
        nodes.len() - 1
    };

    // Rohe Segmente: degenerate (zu kurze) herausfiltern.
    let raw: Vec<(Vec2, Vec2)> = segments
        .iter()
        .filter(|(a, b)| dist(*a, *b) > snap)
        .cloned()
        .collect();

    let mut per_segment: Vec<Vec<RbSplit>> = raw
        .iter()
        .map(|(a, b)| vec![RbSplit { t: 0.0, p: *a }, RbSplit { t: 1.0, p: *b }])
        .collect();

    for i in 0..raw.len() {
        for j in i + 1..raw.len() {
            let (aa, ab) = raw[i];
            let (ba, bb) = raw[j];
            let da = sub(ab, aa);
            let db = sub(bb, ba);
            let denom = rb_cross(da, db);
            if denom.abs() < RB_EPS {
                continue;
            }
            let t = rb_cross(sub(ba, aa), db) / denom;
            let s = rb_cross(sub(ba, aa), da) / denom;
            let tol_t = snap / len(da).max(1e-9);
            let tol_s = snap / len(db).max(1e-9);
            if t < -tol_t || t > 1.0 + tol_t || s < -tol_s || s > 1.0 + tol_s {
                continue;
            }
            let p = add(aa, scale(da, t));
            per_segment[i].push(RbSplit { t, p });
            per_segment[j].push(RbSplit { t: s, p });
        }
    }

    let mut edge_set: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    let mut edges: Vec<RbUEdge> = Vec::new();

    let push_edge = |edges: &mut Vec<RbUEdge>, edge_set: &mut std::collections::HashSet<(usize, usize)>, u: usize, v: usize| {
        if u == v { return; }
        let key = if u < v { (u, v) } else { (v, u) };
        if edge_set.contains(&key) { return; }
        edge_set.insert(key);
        edges.push(RbUEdge { u, v });
    };

    for i in 0..raw.len() {
        per_segment[i].sort_by(|p, q| p.t.partial_cmp(&q.t).unwrap_or(std::cmp::Ordering::Equal));
        let mut prev: Option<usize> = None;
        let mut prev_t = f64::NEG_INFINITY;
        for sp in &per_segment[i] {
            if sp.t - prev_t < 1e-9 && prev.is_some() {
                continue;
            }
            let idx = add_node(&mut nodes, sp.p);
            if let Some(pr) = prev {
                if idx != pr {
                    push_edge(&mut edges, &mut edge_set, pr, idx);
                }
            }
            prev = Some(idx);
            prev_t = sp.t;
        }
    }

    (nodes, edges)
}

// ── Face-Extraktion ───────────────────────────────────────────────────────────

struct RbHalfEdge {
    from: usize,
    to: usize,
    angle: f64,
    used: bool,
}

/// Extrahiert die minimalen geschlossenen Maschen (Port von `extractFaces`).
fn extract_faces(nodes: &[RbNode], edges: &[RbUEdge]) -> Vec<Vec<usize>> {
    // Aussenmaschen verwerfen: nur CCW (positive Flaeche) behalten.
    extract_all_faces(nodes, edges).into_iter().filter(|f| {
        let poly: Vec<Vec2> = f.iter().map(|&n| nodes[n].p).collect();
        signed_area(&poly) > RB_EPS
    }).collect()
}

/// Alle Maschen-Umläufe: innere CCW, die Aussenränder je Zusammenhangskomponente CW.
fn extract_all_faces(nodes: &[RbNode], edges: &[RbUEdge]) -> Vec<Vec<usize>> {
    let mut half_edges: Vec<RbHalfEdge> = Vec::new();
    let mut outgoing: Vec<Vec<usize>> = (0..nodes.len()).map(|_| Vec::new()).collect();

    let angle_of = |from: usize, to: usize| -> f64 {
        let d = sub(nodes[to].p, nodes[from].p);
        d.y.atan2(d.x)
    };

    for e in edges {
        let h1 = half_edges.len();
        half_edges.push(RbHalfEdge { from: e.u, to: e.v, angle: angle_of(e.u, e.v), used: false });
        outgoing[e.u].push(h1);
        let h2 = half_edges.len();
        half_edges.push(RbHalfEdge { from: e.v, to: e.u, angle: angle_of(e.v, e.u), used: false });
        outgoing[e.v].push(h2);
    }

    // Abgehende Halbkanten je Knoten nach Winkel sortieren (stabil).
    for list in outgoing.iter_mut() {
        list.sort_by(|&h1, &h2| half_edges[h1].angle.partial_cmp(&half_edges[h2].angle).unwrap_or(std::cmp::Ordering::Equal));
    }

    // Positionsindex je Halbkante in der sortierten Liste seines from-Knotens.
    let mut pos_in_list: Vec<usize> = vec![0; half_edges.len()];
    for list in &outgoing {
        for (k, &h) in list.iter().enumerate() {
            pos_in_list[h] = k;
        }
    }

    // Zwilling: Paare liegen benachbart (2i, 2i+1).
    let twin = |h: usize| -> usize { if h % 2 == 0 { h + 1 } else { h - 1 } };

    let mut faces: Vec<Vec<usize>> = Vec::new();
    let max_steps = half_edges.len() + 2;

    for start in 0..half_edges.len() {
        if half_edges[start].used {
            continue;
        }
        let mut face_nodes: Vec<usize> = Vec::new();
        let mut h = start;
        let mut guard = 0;
        loop {
            half_edges[h].used = true;
            face_nodes.push(half_edges[h].from);
            let tw = twin(h);
            let to = half_edges[h].to;
            let list = &outgoing[to];
            let pos = pos_in_list[tw];
            let next_pos = if pos == 0 { list.len() - 1 } else { pos - 1 };
            h = list[next_pos];
            guard += 1;
            if h == start || guard >= max_steps {
                break;
            }
        }
        if face_nodes.len() >= 3 {
            faces.push(face_nodes);
        }
    }
    faces
}

// ── Innen-Offset ──────────────────────────────────────────────────────────────

/// Versetzt ein CCW-Polygon um `d` nach innen (Port von `offsetInward`).
fn offset_inward(poly: &[Vec2], d: f64) -> Vec<Vec2> {
    let n = poly.len();
    if n < 3 || d <= 0.0 {
        return poly.to_vec();
    }
    // CCW sicherstellen.
    let pts_owned: Vec<Vec2>;
    let pts: &[Vec2] = if signed_area(poly) > 0.0 {
        poly
    } else {
        pts_owned = { let mut v = poly.to_vec(); v.reverse(); v };
        &pts_owned
    };
    // Verschobene Kanten: linke Normale zeigt ins Innere bei CCW.
    let shifted: Vec<(Vec2, Vec2)> = (0..n).map(|i| {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let dir = rb_normalize(sub(b, a));
        let nrm = left_normal(dir);
        (add(a, scale(nrm, d)), dir)
    }).collect();

    let mut out: Vec<Vec2> = Vec::new();
    for i in 0..n {
        let prev = &shifted[(i + n - 1) % n];
        let curr = &shifted[i];
        let denom = rb_cross(prev.1, curr.1);
        if denom.abs() < 1e-9 {
            out.push(curr.0);
            continue;
        }
        let t = rb_cross(sub(curr.0, prev.0), curr.1) / denom;
        out.push(add(prev.0, scale(prev.1, t)));
    }
    out
}

/// Dedupliziert aufeinanderfolgende nahezu gleiche Punkte im Ring (Port von
/// `dedupeRing`, Toleranz 1e-7 wie TS).
fn dedupe_ring_rb(pts: &[Vec2]) -> Vec<Vec2> {
    let tol = 1e-7_f64;
    let mut out: Vec<Vec2> = Vec::new();
    for &p in pts {
        if let Some(&last) = out.last() {
            if dist(last, p) <= tol {
                continue;
            }
        }
        out.push(p);
    }
    if out.len() > 1 {
        let first = out[0];
        if dist(first, *out.last().unwrap()) <= tol {
            out.pop();
        }
    }
    out
}

/// Durchschnittliche Wanddicke (Port von `averageThickness`).
fn average_thickness(walls: &[WallSegment]) -> f64 {
    if walls.is_empty() {
        return 0.0;
    }
    let s: f64 = walls.iter().map(|w| w.thickness).sum();
    s / walls.len() as f64
}

// ── Oeffentliche Structs (Raumerkennung) ───────────────────────────────

/// Wandsegment (Port von `WallSegment`): Mittellinie a→b mit Dicke.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WallSegment {
    pub a: Vec2,
    pub b: Vec2,
    pub thickness: f64,
}

/// Wand-Innenflaeche (Port von `WallFace`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WallFace {
    pub a: Vec2,
    pub b: Vec2,
}

// ── Oeffentliche Funktionen ───────────────────────────────────────────────────

/// pointInPolygon (roomBoundary-Variante, KEIN Nenner-Guard — `b.y - a.y + 0`).
pub fn rb_point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let mut inside = false;
    let n = poly.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let a = poly[i];
        let b = poly[j];
        let intersects =
            (a.y > p.y) != (b.y > p.y)
            && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
        if intersects {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Erkennt geschlossene Raeume aus Wandsegmenten (Port von `detectRooms`).
pub fn detect_rooms(
    walls: &[WallSegment],
    gap_tol: f64,
    min_area: f64,
    offset_to_inner: bool,
) -> Vec<Vec<Vec2>> {
    if walls.len() < 3 {
        return Vec::new();
    }
    let segs: Vec<(Vec2, Vec2)> = walls.iter().map(|w| (w.a, w.b)).collect();
    let (nodes, edges) = build_planar_graph(&segs, gap_tol);
    if edges.len() < 3 {
        return Vec::new();
    }
    let faces = extract_faces(&nodes, &edges);
    let half = average_thickness(walls) / 2.0;

    let mut rooms: Vec<Vec<Vec2>> = Vec::new();
    for f in faces {
        let raw: Vec<Vec2> = f.iter().map(|&n| nodes[n].p).collect();
        let mut poly = dedupe_ring_rb(&raw);
        if poly.len() < 3 {
            continue;
        }
        if offset_to_inner && half > 0.0 {
            poly = dedupe_ring_rb(&offset_inward(&poly, half));
            if poly.len() < 3 {
                continue;
            }
        }
        if polygon_area(&poly) < min_area {
            continue;
        }
        // Kanonisch CCW zurueckgeben.
        if signed_area(&poly) < 0.0 {
            poly.reverse();
        }
        rooms.push(poly);
    }
    rooms
}

/// Klick-in-Raum-Fallback (Port von `roomFromPointInside`).
pub fn room_from_point_inside(
    point: Vec2,
    walls: &[WallSegment],
    gap_tol: f64,
    offset_to_inner: bool,
) -> Option<Vec<Vec2>> {
    if walls.len() < 3 {
        return None;
    }
    let segs: Vec<(Vec2, Vec2)> = walls.iter().map(|w| (w.a, w.b)).collect();
    let (nodes, edges) = build_planar_graph(&segs, gap_tol);
    if edges.len() < 3 {
        return None;
    }
    let faces = extract_faces(&nodes, &edges);
    let half = average_thickness(walls) / 2.0;

    let mut best: Option<Vec<Vec2>> = None;
    let mut best_area = f64::INFINITY;

    for f in faces {
        let raw: Vec<Vec2> = f.iter().map(|&n| nodes[n].p).collect();
        let raw = dedupe_ring_rb(&raw);
        if raw.len() < 3 {
            continue;
        }
        if !rb_point_in_polygon(point, &raw) {
            continue;
        }
        let area = polygon_area(&raw);
        if area >= best_area {
            continue;
        }
        let mut inner = raw.clone();
        if offset_to_inner && half > 0.0 {
            let off = dedupe_ring_rb(&offset_inward(&raw, half));
            if off.len() >= 3 {
                inner = off;
            }
        }
        if signed_area(&inner) < 0.0 {
            inner.reverse();
        }
        best = Some(inner);
        best_area = area;
    }

    best
}

/// Klick-Tracer auf bereits berechneten Wand-Innenflaechen (Port von
/// `roomFromPointInsideFaces`).
pub fn room_from_point_inside_faces(
    point: Vec2,
    wall_faces: &[WallFace],
    gap_tol: f64,
) -> Option<Vec<Vec2>> {
    if wall_faces.len() < 3 {
        return None;
    }
    let segs: Vec<(Vec2, Vec2)> = wall_faces.iter().map(|f| (f.a, f.b)).collect();
    let (nodes, edges) = build_planar_graph(&segs, gap_tol);
    if edges.len() < 3 {
        return None;
    }
    let faces = extract_faces(&nodes, &edges);

    let mut best: Option<Vec<Vec2>> = None;
    let mut best_area = f64::INFINITY;

    for f in faces {
        let raw: Vec<Vec2> = f.iter().map(|&n| nodes[n].p).collect();
        let poly = dedupe_ring_rb(&raw);
        if poly.len() < 3 {
            continue;
        }
        if !rb_point_in_polygon(point, &poly) {
            continue;
        }
        let area = polygon_area(&poly);
        if area < best_area {
            let mut out = poly;
            if signed_area(&out) < 0.0 {
                out.reverse();
            }
            best = Some(out);
            best_area = area;
        }
    }

    best
}

/// Zauberstab ([77]): kleinste Masche um `point` wie [`room_from_point_inside_faces`] (CCW), dazu ihre
/// Inseln (CW): Aussenränder der Zusammenhangskomponenten des Graphen, die die Masche nicht berühren und
/// ganz in ihr liegen. Nur die äussersten Inseln (eine Insel in einer Insel ist kein Loch des Lochs).
pub fn region_with_islands(point: Vec2, wall_faces: &[WallFace], gap_tol: f64) -> Option<(Vec<Vec2>, Vec<Vec<Vec2>>)> {
    if wall_faces.len() < 3 {
        return None;
    }
    let segs: Vec<(Vec2, Vec2)> = wall_faces.iter().map(|f| (f.a, f.b)).collect();
    let (nodes, edges) = build_planar_graph(&segs, gap_tol);
    if edges.len() < 3 {
        return None;
    }
    // Zusammenhangskomponenten (Union-Find über die Kanten).
    let mut parent: Vec<usize> = (0..nodes.len()).collect();
    fn root(p: &mut [usize], mut i: usize) -> usize {
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    for e in &edges {
        let (a, b) = (root(&mut parent, e.u), root(&mut parent, e.v));
        parent[a] = b;
    }
    let faces = extract_all_faces(&nodes, &edges);
    let ring_of = |f: &[usize]| dedupe_ring_rb(&f.iter().map(|&n| nodes[n].p).collect::<Vec<_>>());

    let mut best: Option<(Vec<Vec2>, usize)> = None;
    let mut best_area = f64::INFINITY;
    // Aussenrand je Komponente: der CW-Umlauf mit der grössten Fläche.
    let mut outer: std::collections::HashMap<usize, (f64, Vec<Vec2>)> = std::collections::HashMap::new();
    for f in &faces {
        let poly = ring_of(f);
        if poly.len() < 3 {
            continue;
        }
        let comp = root(&mut parent, f[0]);
        let sa = signed_area(&poly);
        if sa > RB_EPS {
            if rb_point_in_polygon(point, &poly) {
                let area = polygon_area(&poly);
                if area < best_area {
                    best_area = area;
                    best = Some((poly, comp));
                }
            }
        } else if sa < -RB_EPS && outer.get(&comp).is_none_or(|(a, _)| -sa > *a) {
            outer.insert(comp, (-sa, poly));
        }
    }
    let (ring, comp) = best?;
    let mut cands: Vec<Vec<Vec2>> = outer
        .into_iter()
        .filter(|(c, (_, r))| *c != comp && rb_point_in_polygon(r[0], &ring) && !rb_point_in_polygon(point, r))
        .map(|(_, (_, r))| r)
        .collect();
    // Stabile Reihenfolge (HashMap): nach erstem Punkt.
    cands.sort_by(|a, b| (a[0].x, a[0].y).partial_cmp(&(b[0].x, b[0].y)).unwrap_or(std::cmp::Ordering::Equal));
    let holes: Vec<Vec<Vec2>> = cands
        .iter()
        .enumerate()
        .filter(|(i, r)| !cands.iter().enumerate().any(|(j, o)| j != *i && rb_point_in_polygon(r[0], o)))
        .map(|(_, r)| r.clone())
        .collect();
    let mut out = ring;
    if signed_area(&out) < 0.0 {
        out.reverse();
    }
    Some((out, holes))
}
