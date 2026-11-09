//! Trim, Extend, Split, Bruch und Verketten (Join) von Polylinien mit Schnittkanten; gerufen von den Bearbeitungsbefehlen über `dossier-core`.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use crate::*;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

// --- Trim / Split / Join -----------------------------------------------------
// Reine Geometrie auf Polylinien (`Vec2[]` + `closed`). Struktur- und
// reihenfolgeabhaengig — Sortier-Reihenfolge, Dedup-Schwellen (1e-6) und die
// greedy-Verbindungslogik von joinChains muessen EXAKT wie TS sein.

/// Polylinie / Cutter / Kette: `{pts, closed}` (Port des TS-`{pts, closed}`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Polyline {
    pub pts: Vec<Vec2>,
    pub closed: bool,
}

/// Ein Schnitt-Treffer auf einer Kante: Kantenindex + Parameter + Punkt.
#[derive(Clone, Copy)]
struct EdgeHit {
    edge: usize,
    t: f64,
    point: Vec2,
}

/// Lineare Interpolation zweier Punkte.
fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    add(a, scale(sub(b, a), t))
}

/// Entfernt aufeinanderfolgende (nahezu) gleiche Punkte (kein Ringschluss).
fn dedupe_consecutive(pts: &[Vec2]) -> Vec<Vec2> {
    let mut out: Vec<Vec2> = Vec::new();
    for &p in pts {
        if out.is_empty() || !vec_equal(out[out.len() - 1], p, EPS) {
            out.push(p);
        }
    }
    out
}

/// Dedup aufeinanderfolgender Punkte UND schliessender Duplikat-Endpunkt.
fn dedupe_ring(pts: &[Vec2]) -> Vec<Vec2> {
    let mut out = dedupe_consecutive(pts);
    if out.len() > 1 && vec_equal(out[0], out[out.len() - 1], EPS) {
        out.pop();
    }
    out
}

/// Vergleichsfunktion `(edge, t)` wie TS `(p.edge-q.edge) || (p.t-q.t)`, stabil.
fn cmp_edge_t(p: &EdgeHit, q: &EdgeHit) -> Ordering {
    p.edge
        .cmp(&q.edge)
        .then(p.t.partial_cmp(&q.t).unwrap_or(Ordering::Equal))
}

/// Zerschneidet eine STRECKE an allen inneren Cutter-Schnitten (t ∈ (EPS,1-EPS)).
pub fn split_segment_by_cutters(a1: Vec2, a2: Vec2, cutters: &[Polyline]) -> Vec<(Vec2, Vec2)> {
    let mut ts: Vec<f64> = vec![0.0, 1.0];
    for c in cutters {
        for h in segment_polyline_hits(a1, a2, &c.pts, c.closed) {
            if h.t > EPS && h.t < 1.0 - EPS {
                ts.push(h.t);
            }
        }
    }
    ts.sort_by(|p, q| p.partial_cmp(q).unwrap_or(Ordering::Equal));
    let da = sub(a2, a1);
    let mut pieces: Vec<(Vec2, Vec2)> = Vec::new();
    for i in 0..ts.len() - 1 {
        if ts[i + 1] - ts[i] < 1e-6 {
            continue;
        }
        pieces.push((add(a1, scale(da, ts[i])), add(a1, scale(da, ts[i + 1]))));
    }
    pieces
}

/// Trim: schneidet an den Cuttern und VERWIRFT das dem `pick` naechste Teilstueck.
pub fn trim_segment(a1: Vec2, a2: Vec2, cutters: &[Polyline], pick: Vec2) -> Vec<(Vec2, Vec2)> {
    let pieces = split_segment_by_cutters(a1, a2, cutters);
    if pieces.len() <= 1 {
        return pieces;
    }
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for (i, pc) in pieces.iter().enumerate() {
        let d = point_segment_distance(pick, pc.0, pc.1);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    pieces
        .into_iter()
        .enumerate()
        .filter(|(i, _)| *i != best)
        .map(|(_, p)| p)
        .collect()
}

/// Globaler Lauf-Parameter (edgeIndex + t) des dem Punkt naechsten Kettenpunktes.
fn nearest_param_on_chain(edges: &[(Vec2, Vec2)], p: Vec2) -> f64 {
    let mut best = 0.0;
    let mut best_d = f64::INFINITY;
    for (ei, &(a, b)) in edges.iter().enumerate() {
        let t = project_param(p, a, b).min(1.0).max(0.0);
        let q = add(a, scale(sub(b, a), t));
        let d = dist(p, q);
        if d < best_d {
            best_d = d;
            best = ei as f64 + t;
        }
    }
    best
}

/// Quick-Trim einer ganzen Kurve an einem Klickpunkt (siehe TS-Doku).
pub fn trim_polyline(pts: &[Vec2], closed: bool, cutters: &[Polyline], pick: Vec2) -> Vec<Polyline> {
    let edges = polyline_edges(pts, closed);
    if edges.is_empty() {
        return vec![Polyline { pts: pts.to_vec(), closed }];
    }
    let mut cuts: Vec<EdgeHit> = Vec::new();
    for ei in 0..edges.len() {
        let (a1, a2) = edges[ei];
        for c in cutters {
            for h in segment_polyline_hits(a1, a2, &c.pts, c.closed) {
                if h.t > EPS && h.t < 1.0 - EPS {
                    cuts.push(EdgeHit { edge: ei, t: h.t, point: h.point });
                }
            }
        }
    }
    cuts.sort_by(cmp_edge_t);
    let mut cut: Vec<EdgeHit> = Vec::new();
    for h in cuts {
        if let Some(prev) = cut.last() {
            if prev.edge == h.edge && (prev.t - h.t).abs() < 1e-6 {
                continue;
            }
        }
        cut.push(h);
    }
    if cut.is_empty() {
        return vec![Polyline { pts: pts.to_vec(), closed }];
    }

    if !closed {
        let pick_pos = nearest_param_on_chain(&edges, pick);
        let cut_pos: Vec<f64> = cut.iter().map(|c| c.edge as f64 + c.t).collect();
        let mut lo_idx: isize = -1;
        let mut hi_idx: usize = cut.len();
        for i in 0..cut.len() {
            if cut_pos[i] <= pick_pos {
                lo_idx = i as isize;
            } else {
                hi_idx = i;
                break;
            }
        }
        let mut result: Vec<Polyline> = Vec::new();
        if lo_idx >= 0 {
            let c = cut[lo_idx as usize];
            let mut head: Vec<Vec2> = pts[..c.edge + 1].to_vec();
            head.push(c.point);
            let d = dedupe_consecutive(&head);
            if d.len() >= 2 {
                result.push(Polyline { pts: d, closed: false });
            }
        }
        if hi_idx < cut.len() {
            let c = cut[hi_idx];
            let mut tail: Vec<Vec2> = vec![c.point];
            for k in c.edge + 1..pts.len() {
                tail.push(pts[k]);
            }
            let d = dedupe_consecutive(&tail);
            if d.len() >= 2 {
                result.push(Polyline { pts: d, closed: false });
            }
        }
        return result;
    }

    // Geschlossen.
    if cut.len() == 1 {
        return vec![Polyline { pts: pts.to_vec(), closed: true }];
    }
    let total = edges.len();
    let span = |e_x: usize, p_x: Vec2, e_y: usize, p_y: Vec2| -> Vec<Vec2> {
        let mut out: Vec<Vec2> = vec![p_x];
        let mut e = e_x;
        let mut steps = 0usize;
        while steps <= total {
            if e == e_y {
                break;
            }
            out.push(edges[e].1);
            e = (e + 1) % total;
            steps += 1;
        }
        out.push(p_y);
        dedupe_consecutive(&out)
    };
    let pick_pos = nearest_param_on_chain(&edges, pick);
    let cut_pos: Vec<f64> = cut.iter().map(|c| c.edge as f64 + c.t).collect();
    let mut seg: isize = -1;
    for i in 0..cut.len() {
        let a = cut_pos[i];
        let b = cut_pos[(i + 1) % cut.len()];
        let inside = if i == cut.len() - 1 {
            pick_pos >= a || pick_pos <= b
        } else {
            pick_pos >= a && pick_pos <= b
        };
        if inside {
            seg = i as isize;
            break;
        }
    }
    if seg < 0 {
        seg = 0;
    }
    let seg = seg as usize;
    let from = cut[(seg + 1) % cut.len()];
    let to = cut[seg];
    let chain = span(from.edge, from.point, to.edge, to.point);
    if chain.len() < 2 {
        return Vec::new();
    }
    vec![Polyline { pts: chain, closed: false }]
}

/// Verlaengert das gewaehlte Ende bis zur naechsten Cutter-Kante (oder None).
pub fn extend_segment(
    a1: Vec2,
    a2: Vec2,
    end: &str,
    cutters: &[Polyline],
) -> Option<(Vec2, Vec2)> {
    let mut best_t: Option<f64> = None;
    for c in cutters {
        for (b1, b2) in polyline_edges(&c.pts, c.closed) {
            let h = match line_segment_intersect(a1, a2, b1, b2, EPS) {
                Some(h) => h,
                None => continue,
            };
            if end == "end" && h.t > 1.0 + EPS {
                if best_t.map_or(true, |bt| h.t < bt) {
                    best_t = Some(h.t);
                }
            } else if end == "start" && h.t < -EPS {
                if best_t.map_or(true, |bt| h.t > bt) {
                    best_t = Some(h.t);
                }
            }
        }
    }
    let bt = best_t?;
    let da = sub(a2, a1);
    let hit_point = add(a1, scale(da, bt));
    Some(if end == "end" {
        (a1, hit_point)
    } else {
        (hit_point, a2)
    })
}

/// Teilt eine Polylinie an EINEM Punkt P = lerp(pts[edgeIndex], next, t).
pub fn split_polyline_at_param(
    pts: &[Vec2],
    closed: bool,
    edge_index: usize,
    t: f64,
) -> Vec<Vec<Vec2>> {
    let n = pts.len();
    if n < 2 || edge_index >= n {
        return vec![pts.to_vec()];
    }
    let a = pts[edge_index];
    let b = pts[(edge_index + 1) % n];
    let p = lerp(a, b, t);
    let at_start = t <= EPS;
    let at_end = t >= 1.0 - EPS;

    if !closed {
        let mut left: Vec<Vec2> = pts[..edge_index + 1].to_vec();
        if !at_start && !at_end {
            left.push(p);
        } else if at_end {
            left.push(b);
        }
        let mut right: Vec<Vec2> = Vec::new();
        if !at_start && !at_end {
            right.push(p);
        } else if at_start {
            right.push(a);
        }
        for i in edge_index + 1..n {
            right.push(pts[i]);
        }
        let pieces: Vec<Vec<Vec2>> = [left, right]
            .into_iter()
            .filter(|s| s.len() >= 2)
            .collect();
        return if !pieces.is_empty() {
            pieces
        } else {
            vec![pts.to_vec()]
        };
    }

    let mut out: Vec<Vec2> = Vec::new();
    if !at_start {
        out.push(p);
    }
    for k in 1..=n {
        out.push(pts[(edge_index + k) % n]);
    }
    if !at_start {
        out.push(p);
    } else {
        out.push(a);
    }
    vec![dedupe_consecutive(&out)]
}

/// Teilt ein GESCHLOSSENES Polygon an zwei Randpunkten via Sehne (2 Ringe).
pub fn split_closed_by_chord(
    pts: &[Vec2],
    i: usize,
    ti: f64,
    j: usize,
    tj: f64,
) -> Option<(Vec<Vec2>, Vec<Vec2>)> {
    let n = pts.len();
    if n < 3 || i == j || i >= n || j >= n {
        return None;
    }
    let (ia, ta, ib, tb) = if i > j {
        (j, tj, i, ti)
    } else {
        (i, ti, j, tj)
    };
    let p_a = lerp(pts[ia], pts[(ia + 1) % n], ta);
    let p_b = lerp(pts[ib], pts[(ib + 1) % n], tb);
    let mut arc1: Vec<Vec2> = vec![p_a];
    for k in ia + 1..=ib {
        arc1.push(pts[k % n]);
    }
    arc1.push(p_b);
    let mut arc2: Vec<Vec2> = vec![p_b];
    for k in ib + 1..=ia + n {
        arc2.push(pts[k % n]);
    }
    arc2.push(p_a);
    Some((dedupe_ring(&arc1), dedupe_ring(&arc2)))
}

/// Entfernt das Segment `edge_index` (offen: laengeres Stueck; geschlossen: auftrennen).
pub fn remove_segment(pts: &[Vec2], closed: bool, edge_index: usize) -> Polyline {
    let n = pts.len();
    if closed && n > 0 {
        let mut out: Vec<Vec2> = Vec::new();
        for k in 1..=n {
            out.push(pts[(edge_index + k) % n]);
        }
        return Polyline { pts: dedupe_consecutive(&out), closed: false };
    }
    if n == 0 {
        return Polyline { pts: Vec::new(), closed: false };
    }
    if edge_index == 0 {
        return Polyline { pts: pts[1..].to_vec(), closed: false };
    }
    if edge_index >= n - 1 {
        return Polyline { pts: pts[..n - 1].to_vec(), closed: false };
    }
    let left = pts[..edge_index + 1].to_vec();
    let right = pts[edge_index + 1..].to_vec();
    if left.len() >= right.len() {
        Polyline { pts: left, closed: false }
    } else {
        Polyline { pts: right, closed: false }
    }
}

/// Nächste Position (Kantenindex, geklemmter Parameter) auf einer Punktfolge zu
/// `pt`; None bei < 2 Punkten. Grundlage für BREAK.
pub fn nearest_on_polyline(pts: &[Vec2], closed: bool, pt: Vec2) -> Option<(usize, f64)> {
    let n = pts.len();
    if n < 2 {
        return None;
    }
    let edge_count = if closed { n } else { n - 1 };
    let mut best: Option<(usize, f64)> = None;
    let mut best_d = f64::INFINITY;
    for i in 0..edge_count {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let t = project_param(pt, a, b).min(1.0).max(0.0);
        let d = dist(pt, lerp(a, b, t));
        if d < best_d {
            best_d = d;
            best = Some((i, t));
        }
    }
    best
}

/// Entfernt den Abschnitt ZWISCHEN zwei Positionen (Kantenindex, t) einer OFFENEN
/// Kurve (BREAK, Zwei-Punkt-Variante; Reihenfolge egal). Bis zu zwei Reststücke.
/// Positionen ausserhalb der Kurve → leer.
pub fn break_curve(pts: &[Vec2], hit1: (usize, f64), hit2: (usize, f64)) -> Vec<Vec<Vec2>> {
    let pos = |h: (usize, f64)| h.0 as f64 + h.1;
    let (lo, hi) = if pos(hit1) <= pos(hit2) { (hit1, hit2) } else { (hit2, hit1) };
    if lo.0 + 1 >= pts.len() || hi.0 + 1 >= pts.len() {
        return Vec::new();
    }
    let p1 = lerp(pts[lo.0], pts[lo.0 + 1], lo.1);
    let p2 = lerp(pts[hi.0], pts[hi.0 + 1], hi.1);
    let mut left = pts[..lo.0 + 1].to_vec();
    left.push(p1);
    let mut right = vec![p2];
    right.extend_from_slice(&pts[hi.0 + 1..]);
    [dedupe_consecutive(&left), dedupe_consecutive(&right)].into_iter().filter(|s| s.len() >= 2).collect()
}

/// Kanten einer (offenen ODER implizit geschlossenen) Punktliste.
fn polyline_edges_auto(pts: &[Vec2]) -> Vec<(Vec2, Vec2)> {
    let closed = pts.len() > 2 && vec_equal(pts[0], pts[pts.len() - 1], EPS);
    if closed {
        polyline_edges(&pts[..pts.len() - 1], true)
    } else {
        polyline_edges(pts, false)
    }
}

/// Offene Polylinie an gegebenen EdgeHits (auf ihren Kanten) zerschneiden.
fn split_open_by_edge_hits(pts: &[Vec2], hits: &[EdgeHit]) -> Vec<Vec<Vec2>> {
    if pts.is_empty() {
        return Vec::new();
    }
    let mut pieces: Vec<Vec<Vec2>> = Vec::new();
    let mut cur: Vec<Vec2> = vec![pts[0]];
    let mut hi = 0usize;
    for ei in 0..pts.len() - 1 {
        while hi < hits.len() && hits[hi].edge == ei {
            let p = hits[hi].point;
            cur.push(p);
            pieces.push(cur.clone());
            cur = vec![p];
            hi += 1;
        }
        cur.push(pts[ei + 1]);
    }
    pieces.push(cur);
    pieces
        .into_iter()
        .map(|s| dedupe_consecutive(&s))
        .filter(|s| s.len() >= 2)
        .collect()
}

/// Offene Polylinie an einer Liste von Schnitt-PUNKTEN (auf dem Zug) zerschneiden.
fn split_open_at_hits(pts: &[Vec2], cut_points: &[Vec2]) -> Vec<Vec<Vec2>> {
    if cut_points.is_empty() {
        return vec![pts.to_vec()];
    }
    let mut hits: Vec<EdgeHit> = Vec::new();
    for ei in 0..pts.len().saturating_sub(1) {
        let a = pts[ei];
        let b = pts[ei + 1];
        for &cp in cut_points {
            let t = project_param(cp, a, b);
            if t > EPS && t < 1.0 - EPS && point_segment_distance(cp, a, b) < 1e-6 {
                hits.push(EdgeHit { edge: ei, t, point: cp });
            }
        }
    }
    hits.sort_by(cmp_edge_t);
    split_open_by_edge_hits(pts, &hits)
}

/// Teilt das Ziel an allen Schnittpunkten mit den anderen Polylinien.
pub fn split_at_intersections(
    target_pts: &[Vec2],
    closed: bool,
    others: &[Vec<Vec2>],
) -> Vec<Vec<Vec2>> {
    let edges = polyline_edges(target_pts, closed);
    let mut hits: Vec<EdgeHit> = Vec::new();
    for ei in 0..edges.len() {
        let (a1, a2) = edges[ei];
        for o in others {
            for (b1, b2) in polyline_edges_auto(o) {
                if let Some(h) = segment_intersect(a1, a2, b1, b2, EPS) {
                    hits.push(EdgeHit { edge: ei, t: h.t, point: h.point });
                }
            }
        }
    }
    hits.sort_by(cmp_edge_t);
    let mut dedup: Vec<EdgeHit> = Vec::new();
    for h in hits {
        if let Some(prev) = dedup.last() {
            if prev.edge == h.edge && (prev.t - h.t).abs() < 1e-6 {
                continue;
            }
        }
        if h.t <= EPS || h.t >= 1.0 - EPS {
            continue;
        }
        dedup.push(h);
    }
    if dedup.is_empty() {
        return vec![target_pts.to_vec()];
    }
    if closed {
        if dedup.len() == 2 {
            return match split_closed_by_chord(
                target_pts, dedup[0].edge, dedup[0].t, dedup[1].edge, dedup[1].t,
            ) {
                Some((a, b)) => vec![a, b],
                None => vec![target_pts.to_vec()],
            };
        }
        let opened = split_polyline_at_param(target_pts, true, dedup[0].edge, dedup[0].t)
            .into_iter()
            .next()
            .unwrap_or_default();
        let cut_pts: Vec<Vec2> = dedup[1..].iter().map(|h| h.point).collect();
        return split_open_at_hits(&opened, &cut_pts);
    }
    split_open_by_edge_hits(target_pts, &dedup)
}

/// Verschmilzt Polylinien an koinzidenten Endpunkten zu laengeren Ketten.
/// Greedy `i<j`-erster-Treffer-dann-Neustart — reihenfolgeabhaengig, exakt wie TS.
pub fn join_chains(polylines: &[Polyline]) -> Vec<Polyline> {
    let mut closed_out: Vec<Polyline> = Vec::new();
    let mut open: Vec<Vec<Vec2>> = Vec::new();
    for pl in polylines {
        if pl.closed {
            closed_out.push(Polyline { pts: pl.pts.clone(), closed: true });
        } else if pl.pts.len() >= 2 {
            open.push(pl.pts.clone());
        } else if pl.pts.len() == 1 {
            open.push(pl.pts.clone());
        }
    }

    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..open.len() {
            for j in i + 1..open.len() {
                let a = &open[i];
                let b = &open[j];
                let a_s = a[0];
                let a_e = a[a.len() - 1];
                let b_s = b[0];
                let b_e = b[b.len() - 1];
                let combined: Option<Vec<Vec2>> = if vec_equal(a_e, b_s, EPS) {
                    let mut v = a.clone();
                    v.extend_from_slice(&b[1..]);
                    Some(v)
                } else if vec_equal(a_e, b_e, EPS) {
                    let mut v = a.clone();
                    let mut rev: Vec<Vec2> = b[..b.len() - 1].to_vec();
                    rev.reverse();
                    v.extend(rev);
                    Some(v)
                } else if vec_equal(a_s, b_e, EPS) {
                    let mut v = b.clone();
                    v.extend_from_slice(&a[1..]);
                    Some(v)
                } else if vec_equal(a_s, b_s, EPS) {
                    let mut v: Vec<Vec2> = b.clone();
                    v.reverse();
                    v.extend_from_slice(&a[1..]);
                    Some(v)
                } else {
                    None
                };
                if let Some(c) = combined {
                    open.remove(j);
                    open[i] = c;
                    merged = true;
                    break 'outer;
                }
            }
        }
    }

    let mut out: Vec<Polyline> = closed_out;
    for chain in open {
        if chain.len() > 2 && vec_equal(chain[0], chain[chain.len() - 1], EPS) {
            out.push(Polyline { pts: chain[..chain.len() - 1].to_vec(), closed: true });
        } else {
            out.push(Polyline { pts: chain, closed: false });
        }
    }
    out
}
