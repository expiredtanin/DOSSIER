// Bogen-Segmente (DXF-„bulge" = tan(Δ/4), Δ = Öffnungswinkel von a nach b) im
// 2D-Kern: Offset, Quick-Trim, Verlängern, Segment-Löschen und Verketten von
// Polylinien, deren Kanten Kreisbögen sein dürfen. Konvention wie im Modell:
// `bulge[i]` krümmt die Kante pts[i]→pts[i+1] (geschlossen zusätzlich
// pts[n-1]→pts[0]); ein fehlender Eintrag oder 0 bedeutet Gerade.
//
// Die Bogen-Grundformeln (`bulge_arc`, `bulge_between_angles`) entsprechen
// `src/geometry/bulge.ts` (dort weiter für Darstellung/Griffe genutzt).

use crate::{
    add, circle_circle_intersect, dist, line_circle_intersect, line_intersect, offset_segment,
    polyline_edges, project_param, scale, segment_circle_intersect, segment_intersect, sub, Polyline,
    Vec2, EPS,
};
use std::cmp::Ordering;
use std::f64::consts::PI;

/// Toleranz der Bogen-Formeln (wie `bulge.ts`): |bulge| darunter gilt als Gerade.
const BULGE_EPS: f64 = 1e-9;
const TAU: f64 = PI * 2.0;

/// Winkel auf [0, 2π) (wie TS `((x % TAU) + TAU) % TAU`; Rust-`%` rundet wie JS).
fn norm_angle(x: f64) -> f64 {
    ((x % TAU) + TAU) % TAU
}

/// Kreisbogen-Parameter eines bulge-Segments.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BulgeArc {
    pub center: Vec2,
    pub r: f64,
    pub a0: f64,
    pub a1: f64,
    /// Schwenkwinkel von a0 nach a1 mit Vorzeichen (positiv = CCW).
    pub sweep: f64,
}

/// Kreisbogen aus zwei Endpunkten + bulge; None bei (nahezu) 0 oder entarteter Sehne.
pub fn bulge_arc(a: Vec2, b: Vec2, bulge: f64) -> Option<BulgeArc> {
    if bulge.abs() < BULGE_EPS {
        return None;
    }
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let chord = dx.hypot(dy);
    if chord < BULGE_EPS {
        return None;
    }
    let ux = dx / chord;
    let uy = dy / chord;
    let nx = -uy;
    let ny = ux; // Links-Normale von a→b
    let h = chord / 2.0;
    let s = h * bulge; // Pfeilhöhe, Vorzeichen wie bulge
    let mx = (a.x + b.x) / 2.0;
    let my = (a.y + b.y) / 2.0;
    let r_signed = (h * h + s * s) / (2.0 * s);
    let cx = mx + nx * (s - r_signed);
    let cy = my + ny * (s - r_signed);
    let r = r_signed.abs();
    let apex_x = mx + nx * s;
    let apex_y = my + ny * s;
    let a0 = (a.y - cy).atan2(a.x - cx);
    let a1 = (b.y - cy).atan2(b.x - cx);
    let a_apex = (apex_y - cy).atan2(apex_x - cx);
    // Schwenkrichtung = die, die den Apex unterwegs passiert.
    let ccw_sweep = norm_angle(a1 - a0);
    let ccw_passes_apex = norm_angle(a_apex - a0) <= ccw_sweep + 1e-7;
    let sweep = if ccw_passes_apex { ccw_sweep } else { -(TAU - ccw_sweep) };
    Some(BulgeArc { center: Vec2::new(cx, cy), r, a0, a1, sweep })
}

/// Punkt auf dem Kreis (center, r) beim Winkel `a`.
pub fn point_on_circle(center: Vec2, r: f64, a: f64) -> Vec2 {
    Vec2::new(center.x + r * a.cos(), center.y + r * a.sin())
}

/// bulge aus einem Punkt `p` relativ zur Sehne a-b (Umkehrung von s = h·bulge).
pub fn bulge_from_sagitta_point(a: Vec2, b: Vec2, p: Vec2) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let chord = dx.hypot(dy);
    if chord < BULGE_EPS {
        return 0.0;
    }
    let ux = dx / chord;
    let uy = dy / chord;
    let nx = -uy;
    let ny = ux;
    let h = chord / 2.0;
    let mx = (a.x + b.x) / 2.0;
    let my = (a.y + b.y) / 2.0;
    let s = (p.x - mx) * nx + (p.y - my) * ny;
    s / h
}

/// bulge des Teilbogens desselben Kreises von `a_from` nach `a_to` in Richtung
/// `sweep_sign` (+1 CCW, −1 CW), über einen echten Punkt in der Winkel-Mitte.
pub fn bulge_between_angles(center: Vec2, r: f64, a_from: f64, a_to: f64, sweep_sign: f64) -> f64 {
    let delta = if sweep_sign > 0.0 { norm_angle(a_to - a_from) } else { -norm_angle(a_from - a_to) };
    let mid = a_from + delta / 2.0;
    let p = point_on_circle(center, r, a_from);
    let q = point_on_circle(center, r, a_to);
    let m = point_on_circle(center, r, mid);
    bulge_from_sagitta_point(p, q, m)
}

/// bulge-Eintrag `i` (fehlend → 0, also Gerade).
fn bulge_at(bulge: &[f64], i: usize) -> f64 {
    bulge.get(i).copied().unwrap_or(0.0)
}

fn sweep_sign_of(sweep: f64) -> f64 {
    if sweep >= 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// Polylinie mit bulge-Werten je Kante.
#[derive(Clone, Debug, PartialEq)]
pub struct BulgePolyline {
    pub pts: Vec<Vec2>,
    pub closed: bool,
    pub bulge: Vec<f64>,
}

// --- Offset ------------------------------------------------------------------

/// Konzentrischer Bogen einer Offset-Kante.
#[derive(Clone, Copy)]
struct OffsetArc {
    center: Vec2,
    r: f64,
    sweep_sign: f64,
}

/// Rohe Offset-Kante: Gerade (`arc: None`) oder konzentrischer Bogen.
#[derive(Clone, Copy)]
struct OffsetEdge {
    a: Vec2,
    b: Vec2,
    arc: Option<OffsetArc>,
}

fn offset_edge_for(a: Vec2, b: Vec2, bulge: f64, d: f64) -> OffsetEdge {
    let Some(arc) = bulge_arc(a, b, bulge) else {
        let (oa, ob) = offset_segment(a, b, d);
        return OffsetEdge { a: oa, b: ob, arc: None };
    };
    let sweep_sign = sweep_sign_of(arc.sweep);
    // Bei CCW-Bogen zeigt „links" (+d) nach innen (Radius sinkt), bei CW umgekehrt.
    let new_r = (arc.r - d * sweep_sign).max(0.001);
    OffsetEdge {
        a: point_on_circle(arc.center, new_r, arc.a0),
        b: point_on_circle(arc.center, new_r, arc.a1),
        arc: Some(OffsetArc { center: arc.center, r: new_r, sweep_sign }),
    }
}

/// Kandidat, der `fallback` am nächsten liegt.
fn nearest_to(cands: &[Vec2], fallback: Vec2) -> Option<Vec2> {
    let mut best = *cands.first()?;
    let mut best_d = dist(best, fallback);
    for &c in &cands[1..] {
        let dd = dist(c, fallback);
        if dd < best_d {
            best_d = dd;
            best = c;
        }
    }
    Some(best)
}

/// Gehrungspunkt zweier Offset-Kanten (Gerade/Bogen in allen Kombinationen).
fn join_offset_edges(e1: &OffsetEdge, e2: &OffsetEdge, fallback: Vec2) -> Vec2 {
    let cands = match (e1.arc, e2.arc) {
        (None, None) => {
            return line_intersect(e1.a, sub(e1.b, e1.a), e2.a, sub(e2.b, e2.a)).unwrap_or(fallback)
        }
        (Some(c), None) => line_circle_intersect(e2.a, e2.b, c.center, c.r),
        (None, Some(c)) => line_circle_intersect(e1.a, e1.b, c.center, c.r),
        (Some(c1), Some(c2)) => circle_circle_intersect(c1.center, c1.r, c2.center, c2.r),
    };
    nearest_to(&cands, fallback).unwrap_or(fallback)
}

fn angle_of(center: Vec2, p: Vec2) -> f64 {
    (p.y - center.y).atan2(p.x - center.x)
}

/// Offset einer Polylinie MIT Bogen-Segmenten um `d` (links positiv). Bögen
/// bleiben konzentrisch; an den Nahtstellen wird auf Gehrung geschnitten und der
/// bulge aus den tatsächlichen Endpunkt-Winkeln neu hergeleitet.
pub fn offset_polyline_with_bulge(pts: &[Vec2], bulge: &[f64], d: f64, closed: bool) -> (Vec<Vec2>, Vec<f64>) {
    let n = pts.len();
    if n < 2 {
        return (pts.to_vec(), Vec::new());
    }
    let edge_count = if closed { n } else { n - 1 };
    let edges: Vec<OffsetEdge> = (0..edge_count)
        .map(|i| offset_edge_for(pts[i], pts[(i + 1) % n], bulge_at(bulge, i), d))
        .collect();

    let mut verts: Vec<Vec2> = Vec::with_capacity(n);
    if !closed {
        verts.push(edges[0].a);
        for i in 0..edges.len() - 1 {
            verts.push(join_offset_edges(&edges[i], &edges[i + 1], edges[i].b));
        }
        verts.push(edges[edges.len() - 1].b);
    } else {
        let m = edges.len();
        for i in 0..m {
            let prev = &edges[(i + m - 1) % m];
            let curr = &edges[i];
            verts.push(join_offset_edges(prev, curr, curr.a));
        }
    }

    let mut out_bulge = vec![0.0; edge_count];
    for (i, e) in edges.iter().enumerate() {
        let Some(arc) = e.arc else { continue };
        let v_start = verts[i];
        let v_end = if closed { verts[(i + 1) % edge_count] } else { verts[i + 1] };
        let a_from = angle_of(arc.center, v_start);
        let a_to = angle_of(arc.center, v_end);
        out_bulge[i] = bulge_between_angles(arc.center, arc.r, a_from, a_to, arc.sweep_sign);
    }
    (verts, out_bulge)
}

// --- Trim --------------------------------------------------------------------

/// Kante einer bulge-Polylinie: Gerade oder Bogen (mit Start-Winkel und Schwenk).
#[derive(Clone, Copy)]
struct BulgeEdge {
    a: Vec2,
    b: Vec2,
    arc: Option<BulgeArc>,
}

fn build_bulge_edges(pts: &[Vec2], bulge: &[f64], closed: bool) -> Vec<BulgeEdge> {
    let n = pts.len();
    let edge_count = if closed { n } else { n.saturating_sub(1) };
    (0..edge_count)
        .map(|i| {
            let a = pts[i];
            let b = pts[(i + 1) % n];
            BulgeEdge { a, b, arc: bulge_arc(a, b, bulge_at(bulge, i)) }
        })
        .collect()
}

/// Punkt einer Kante bei Parameter t ∈ [0,1].
fn point_on_edge_at(e: &BulgeEdge, t: f64) -> Vec2 {
    match e.arc {
        None => add(e.a, scale(sub(e.b, e.a), t)),
        Some(arc) => point_on_circle(arc.center, arc.r, arc.a0 + arc.sweep * t),
    }
}

/// Winkel-Parameter t (ungeklemmt) eines Punktes auf dem Vollkreis des Bogens.
fn t_on_arc(arc: &BulgeArc, p: Vec2) -> f64 {
    let angle_p = angle_of(arc.center, p);
    let raw = if arc.sweep >= 0.0 { norm_angle(angle_p - arc.a0) } else { -norm_angle(arc.a0 - angle_p) };
    if arc.sweep != 0.0 {
        raw / arc.sweep
    } else {
        0.0
    }
}

/// Nächster Punkt + Parameter t ∈ [0,1] einer Kante zu `p`.
fn closest_on_edge(e: &BulgeEdge, p: Vec2) -> (Vec2, f64) {
    match e.arc {
        None => {
            let t = project_param(p, e.a, e.b).min(1.0).max(0.0);
            (add(e.a, scale(sub(e.b, e.a), t)), t)
        }
        Some(arc) => {
            let t = if arc.sweep != 0.0 { t_on_arc(&arc, p).min(1.0).max(0.0) } else { 0.0 };
            (point_on_edge_at(e, t), t)
        }
    }
}

/// Liegt ein Punkt auf dem Vollkreis innerhalb der tatsächlichen Bogen-Spanne?
fn on_arc_span(arc: &BulgeArc, p: Vec2) -> bool {
    let t = t_on_arc(arc, p);
    t >= -EPS && t <= 1.0 + EPS
}

/// Parameter t auf `target`, an denen `cutter` sie trifft (Gerade/Bogen je Seite).
/// Treffer eines Bogen-Schneiders zählen nur innerhalb seiner Spanne.
fn edge_intersect_ts(target: &BulgeEdge, cutter: &BulgeEdge) -> Vec<f64> {
    match (target.arc, cutter.arc) {
        (None, None) => segment_intersect(target.a, target.b, cutter.a, cutter.b, EPS)
            .map(|h| vec![h.t])
            .unwrap_or_default(),
        (Some(ta), None) => segment_circle_intersect(cutter.a, cutter.b, ta.center, ta.r)
            .into_iter()
            .map(|p| t_on_arc(&ta, p))
            .collect(),
        (None, Some(ca)) => segment_circle_intersect(target.a, target.b, ca.center, ca.r)
            .into_iter()
            .filter(|p| on_arc_span(&ca, *p))
            .map(|p| project_param(p, target.a, target.b))
            .collect(),
        (Some(ta), Some(ca)) => circle_circle_intersect(ta.center, ta.r, ca.center, ca.r)
            .into_iter()
            .filter(|p| on_arc_span(&ca, *p))
            .map(|p| t_on_arc(&ta, p))
            .collect(),
    }
}

/// bulge des Teilbogens t0..t1 (Gerade → 0; ganze Kante → `orig`).
fn sub_bulge(edge: &BulgeEdge, orig: f64, t0: f64, t1: f64) -> f64 {
    let Some(arc) = edge.arc else { return 0.0 };
    if t0 <= EPS && t1 >= 1.0 - EPS {
        return orig;
    }
    bulge_between_angles(arc.center, arc.r, arc.a0 + arc.sweep * t0, arc.a0 + arc.sweep * t1, sweep_sign_of(arc.sweep))
}

fn nearest_param_on_bulge_chain(edges: &[BulgeEdge], p: Vec2) -> f64 {
    let mut best = 0.0;
    let mut best_d = f64::INFINITY;
    for (ei, e) in edges.iter().enumerate() {
        let (point, t) = closest_on_edge(e, p);
        let d = dist(p, point);
        if d < best_d {
            best_d = d;
            best = ei as f64 + t;
        }
    }
    best
}

#[derive(Clone, Copy)]
struct Cut {
    edge: usize,
    t: f64,
    point: Vec2,
}

/// Quick-Trim wie `trim_polyline`, aber Ziel-Kurve UND Schneider dürfen
/// Bogen-Segmente tragen. Liefert die verbleibenden Ketten inkl. bulge.
pub fn trim_polyline_with_bulge(
    pts: &[Vec2],
    bulge: &[f64],
    closed: bool,
    cutters: &[BulgePolyline],
    pick: Vec2,
) -> Vec<BulgePolyline> {
    let edges = build_bulge_edges(pts, bulge, closed);
    let bulge_full: Vec<f64> =
        edges.iter().enumerate().map(|(i, e)| if e.arc.is_some() { bulge_at(bulge, i) } else { 0.0 }).collect();
    if edges.is_empty() {
        return vec![BulgePolyline { pts: pts.to_vec(), closed, bulge: Vec::new() }];
    }

    let cutter_edges: Vec<Vec<BulgeEdge>> =
        cutters.iter().map(|c| build_bulge_edges(&c.pts, &c.bulge, c.closed)).collect();
    let mut raw: Vec<Cut> = Vec::new();
    for (ei, e) in edges.iter().enumerate() {
        for ces in &cutter_edges {
            for ce in ces {
                for t in edge_intersect_ts(e, ce) {
                    if t > EPS && t < 1.0 - EPS {
                        raw.push(Cut { edge: ei, t, point: point_on_edge_at(e, t) });
                    }
                }
            }
        }
    }
    raw.sort_by(|p, q| p.edge.cmp(&q.edge).then(p.t.partial_cmp(&q.t).unwrap_or(Ordering::Equal)));
    let mut cut: Vec<Cut> = Vec::new();
    for h in raw {
        if let Some(prev) = cut.last() {
            if prev.edge == h.edge && (prev.t - h.t).abs() < 1e-6 {
                continue;
            }
        }
        cut.push(h);
    }
    if cut.is_empty() {
        return vec![BulgePolyline { pts: pts.to_vec(), closed, bulge: bulge_full }];
    }

    // Kette von (from_edge, from_t, from_point) bis (to_edge, to_t, to_point),
    // vorwärts entlang der Kanten (mit Umlauf bei geschlossenen Ketten).
    let total = edges.len();
    let span = |from_edge: usize, from_t: f64, from_point: Vec2, to_edge: usize, to_t: f64, to_point: Vec2| {
        let mut out_pts = vec![from_point];
        let mut out_bulge: Vec<f64> = Vec::new();
        let mut push = |p: Vec2, seg_bulge: f64, out_pts: &mut Vec<Vec2>| {
            if dist(out_pts[out_pts.len() - 1], p) <= EPS {
                return; // Nullstrecke überspringen
            }
            out_pts.push(p);
            out_bulge.push(seg_bulge);
        };
        let mut e = from_edge;
        let mut cur_t = from_t;
        let mut steps = 0usize;
        while steps <= total && e != to_edge {
            push(edges[e].b, sub_bulge(&edges[e], bulge_full[e], cur_t, 1.0), &mut out_pts);
            cur_t = 0.0;
            e = (e + 1) % total;
            steps += 1;
        }
        push(to_point, sub_bulge(&edges[to_edge], bulge_full[to_edge], cur_t, to_t), &mut out_pts);
        (out_pts, out_bulge)
    };

    let pick_pos = nearest_param_on_bulge_chain(&edges, pick);
    let cut_pos: Vec<f64> = cut.iter().map(|c| c.edge as f64 + c.t).collect();

    if !closed {
        let mut lo: Option<usize> = None;
        let mut hi = cut.len();
        for i in 0..cut.len() {
            if cut_pos[i] <= pick_pos {
                lo = Some(i);
            } else {
                hi = i;
                break;
            }
        }
        let mut result = Vec::new();
        if let Some(lo) = lo {
            let c = cut[lo];
            let (p, b) = span(0, 0.0, pts[0], c.edge, c.t, c.point);
            if p.len() >= 2 {
                result.push(BulgePolyline { pts: p, closed: false, bulge: b });
            }
        }
        if hi < cut.len() {
            let c = cut[hi];
            let (p, b) = span(c.edge, c.t, c.point, total - 1, 1.0, pts[pts.len() - 1]);
            if p.len() >= 2 {
                result.push(BulgePolyline { pts: p, closed: false, bulge: b });
            }
        }
        return result;
    }

    if cut.len() == 1 {
        return vec![BulgePolyline { pts: pts.to_vec(), closed: true, bulge: bulge_full }];
    }
    let mut seg = 0usize;
    for i in 0..cut.len() {
        let a = cut_pos[i];
        let b = cut_pos[(i + 1) % cut.len()];
        let inside = if i == cut.len() - 1 { pick_pos >= a || pick_pos <= b } else { pick_pos >= a && pick_pos <= b };
        if inside {
            seg = i;
            break;
        }
    }
    let from = cut[(seg + 1) % cut.len()];
    let to = cut[seg];
    let (p, b) = span(from.edge, from.t, from.point, to.edge, to.t, to.point);
    if p.len() < 2 {
        return Vec::new();
    }
    vec![BulgePolyline { pts: p, closed: false, bulge: b }]
}

// --- Extend ------------------------------------------------------------------

/// Verlängert ein Bogen-Segment a→b (bulge) über das gewählte Ende hinaus
/// (gleicher Kreis, gleiche Schwenkrichtung) bis zur nächsten GERADEN Schneider-
/// Kante. `at_end`: über b hinaus (a fest), sonst über a hinaus (b fest).
/// Liefert neuen Endpunkt + neuen bulge, None bei Geraden oder ohne Treffer.
pub fn extend_bulge_segment(a: Vec2, b: Vec2, bulge: f64, at_end: bool, cutters: &[Polyline]) -> Option<(Vec2, f64)> {
    let arc = bulge_arc(a, b, bulge)?;
    let sweep_sign = sweep_sign_of(arc.sweep);
    let mut best_delta: Option<f64> = None;
    let mut best_angle = 0.0;
    for c in cutters {
        for (b1, b2) in polyline_edges(&c.pts, c.closed) {
            for p in segment_circle_intersect(b1, b2, arc.center, arc.r) {
                let theta = angle_of(arc.center, p);
                let delta = match (at_end, sweep_sign > 0.0) {
                    (true, true) => norm_angle(theta - arc.a1),
                    (true, false) => norm_angle(arc.a1 - theta),
                    (false, true) => norm_angle(arc.a0 - theta),
                    (false, false) => norm_angle(theta - arc.a0),
                };
                if delta < EPS {
                    continue; // trifft den Endpunkt selbst
                }
                if best_delta.map_or(true, |bd| delta < bd) {
                    best_delta = Some(delta);
                    best_angle = theta;
                }
            }
        }
    }
    best_delta?;
    let point = point_on_circle(arc.center, arc.r, best_angle);
    let new_bulge = if at_end {
        bulge_between_angles(arc.center, arc.r, arc.a0, best_angle, sweep_sign)
    } else {
        bulge_between_angles(arc.center, arc.r, best_angle, arc.a1, sweep_sign)
    };
    Some((point, new_bulge))
}

// --- Segment löschen / Verketten ---------------------------------------------

/// Wie `remove_segment`, trägt aber das bulge-Array mit (ohne Dedup, damit die
/// Indizes von pts und bulge zusammenpassen).
pub fn remove_segment_with_bulge(pts: &[Vec2], bulge: &[f64], closed: bool, edge_index: usize) -> BulgePolyline {
    let n = pts.len();
    if n == 0 {
        return BulgePolyline { pts: Vec::new(), closed: false, bulge: Vec::new() };
    }
    if closed {
        let out_pts = (1..=n).map(|k| pts[(edge_index + k) % n]).collect();
        let out_bulge = (1..n).map(|k| bulge_at(bulge, (edge_index + k) % n)).collect();
        return BulgePolyline { pts: out_pts, closed: false, bulge: out_bulge };
    }
    let slice = |v: &[f64], from: usize, to: usize| -> Vec<f64> {
        let to = to.min(v.len());
        if from >= to {
            Vec::new()
        } else {
            v[from..to].to_vec()
        }
    };
    if edge_index == 0 {
        return BulgePolyline { pts: pts[1..].to_vec(), closed: false, bulge: slice(bulge, 1, bulge.len()) };
    }
    if edge_index >= n - 1 {
        return BulgePolyline {
            pts: pts[..n - 1].to_vec(),
            closed: false,
            bulge: slice(bulge, 0, bulge.len().saturating_sub(1)),
        };
    }
    let left = pts[..edge_index + 1].to_vec();
    let right = pts[edge_index + 1..].to_vec();
    if left.len() >= right.len() {
        BulgePolyline { pts: left, closed: false, bulge: slice(bulge, 0, edge_index) }
    } else {
        BulgePolyline { pts: right, closed: false, bulge: slice(bulge, edge_index + 1, bulge.len()) }
    }
}

/// Kehrt ein bulge-Array um (Reihenfolge und Vorzeichen) — für rückwärts gelaufene Ketten.
fn reverse_bulge(b: &[f64]) -> Vec<f64> {
    b.iter().rev().map(|v| -v).collect()
}

/// Eingabe für `join_chains_with_bulge`: fehlendes bulge = lauter Geraden.
#[derive(Clone, Debug)]
pub struct BulgeChainInput {
    pub pts: Vec<Vec2>,
    pub closed: bool,
    pub bulge: Option<Vec<f64>>,
}

/// Wie `join_chains`, trägt aber je Kette das bulge-Array mit. Muss eine Kette
/// umgedreht werden, kehren sich Reihenfolge UND Vorzeichen ihrer bulge-Werte um.
pub fn join_chains_with_bulge(polylines: &[BulgeChainInput]) -> Vec<BulgePolyline> {
    let mut closed_out: Vec<BulgePolyline> = Vec::new();
    let mut open: Vec<(Vec<Vec2>, Vec<f64>)> = Vec::new();
    for pl in polylines {
        let bulge = pl.bulge.clone().unwrap_or_else(|| vec![0.0; pl.pts.len().saturating_sub(1)]);
        if pl.closed {
            closed_out.push(BulgePolyline { pts: pl.pts.clone(), closed: true, bulge });
        } else if !pl.pts.is_empty() {
            open.push((pl.pts.clone(), bulge));
        }
    }

    let eq = |p: Vec2, q: Vec2| crate::vec_equal(p, q, EPS);
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..open.len() {
            for j in i + 1..open.len() {
                let (ap, ab) = &open[i];
                let (bp, bb) = &open[j];
                let (a_s, a_e) = (ap[0], ap[ap.len() - 1]);
                let (b_s, b_e) = (bp[0], bp[bp.len() - 1]);
                let combined = if eq(a_e, b_s) {
                    let pts = ap.iter().chain(&bp[1..]).copied().collect();
                    Some((pts, [ab.as_slice(), bb.as_slice()].concat()))
                } else if eq(a_e, b_e) {
                    // B rückwärts anhängen: alle Kanten von B kehren sich um.
                    let pts = ap.iter().chain(bp[..bp.len() - 1].iter().rev()).copied().collect();
                    Some((pts, [ab.clone(), reverse_bulge(bb)].concat()))
                } else if eq(a_s, b_e) {
                    let pts = bp.iter().chain(&ap[1..]).copied().collect();
                    Some((pts, [bb.as_slice(), ab.as_slice()].concat()))
                } else if eq(a_s, b_s) {
                    let pts = bp.iter().rev().chain(&ap[1..]).copied().collect();
                    Some((pts, [reverse_bulge(bb), ab.clone()].concat()))
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

    let mut out = closed_out;
    for (pts, bulge) in open {
        if pts.len() > 2 && eq(pts[0], pts[pts.len() - 1]) {
            out.push(BulgePolyline { pts: pts[..pts.len() - 1].to_vec(), closed: true, bulge });
        } else {
            out.push(BulgePolyline { pts, closed: false, bulge });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: f64 = 1e-6;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2::new(x, y)
    }

    fn close(a: Vec2, x: f64, y: f64) -> bool {
        (a.x - x).abs() < P && (a.y - y).abs() < P
    }

    fn line(pts: &[(f64, f64)]) -> Polyline {
        Polyline { pts: pts.iter().map(|&(x, y)| v(x, y)).collect(), closed: false }
    }

    fn bline(pts: &[(f64, f64)], bulge: &[f64]) -> BulgePolyline {
        BulgePolyline { pts: pts.iter().map(|&(x, y)| v(x, y)).collect(), closed: false, bulge: bulge.to_vec() }
    }

    #[test]
    fn bulge_arc_halbkreis() {
        let arc = bulge_arc(v(-1.0, 0.0), v(1.0, 0.0), 1.0).unwrap();
        assert!(close(arc.center, 0.0, 0.0));
        assert!((arc.r - 1.0).abs() < P);
        assert!((arc.sweep + PI).abs() < P || (arc.sweep - PI).abs() < P);
        assert!(bulge_arc(v(0.0, 0.0), v(1.0, 0.0), 0.0).is_none());
        assert!(bulge_arc(v(1.0, 1.0), v(1.0, 1.0), 1.0).is_none());
    }

    #[test]
    fn bulge_between_angles_halbkreis_ist_eins() {
        let arc = bulge_arc(v(-1.0, 0.0), v(1.0, 0.0), 1.0).unwrap();
        let b = bulge_between_angles(arc.center, arc.r, arc.a0, arc.a1, sweep_sign_of(arc.sweep));
        assert!((b - 1.0).abs() < P);
    }

    #[test]
    fn offset_halbkreis_konzentrisch() {
        let (p, b) = offset_polyline_with_bulge(&[v(-1.0, 0.0), v(1.0, 0.0)], &[1.0], 0.3, false);
        assert!(close(p[0], -1.3, 0.0) && close(p[1], 1.3, 0.0));
        assert!((b[0] - 1.0).abs() < P);
        let (p, _) = offset_polyline_with_bulge(&[v(-1.0, 0.0), v(1.0, 0.0)], &[1.0], -0.3, false);
        assert!(close(p[0], -0.7, 0.0) && close(p[1], 0.7, 0.0));
    }

    #[test]
    fn offset_gerade_ohne_bulge() {
        let (p, b) = offset_polyline_with_bulge(&[v(0.0, 0.0), v(2.0, 0.0)], &[], 0.5, false);
        assert_eq!(p, vec![v(0.0, 0.5), v(2.0, 0.5)]);
        assert_eq!(b, vec![0.0]);
        let (p, b) = offset_polyline_with_bulge(&[v(0.0, 0.0)], &[], 0.5, false);
        assert_eq!((p.len(), b.len()), (1, 0));
    }

    #[test]
    fn trim_halbkreis_am_apex() {
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let rest = trim_polyline_with_bulge(
            &[v(-1.0, 0.0), v(1.0, 0.0)],
            &[1.0],
            false,
            &[bline(&[(0.0, -5.0), (0.0, 5.0)], &[])],
            v(s, s),
        );
        assert_eq!(rest.len(), 1);
        assert!(close(rest[0].pts[0], -1.0, 0.0) && close(rest[0].pts[1], 0.0, 1.0));
        let arc = bulge_arc(rest[0].pts[0], rest[0].pts[1], rest[0].bulge[0]).unwrap();
        assert!(close(arc.center, 0.0, 0.0) && (arc.r - 1.0).abs() < 1e-5);
    }

    #[test]
    fn trim_bogen_gegen_bogen_nur_in_spanne() {
        let pick = v((2.0 * PI / 3.0).cos(), (2.0 * PI / 3.0).sin());
        let rest =
            trim_polyline_with_bulge(&[v(-1.0, 0.0), v(1.0, 0.0)], &[1.0], false, &[bline(&[(0.0, 0.0), (2.0, 0.0)], &[1.0])], pick);
        assert_eq!(rest.len(), 1);
        assert!(close(rest[0].pts[0], 0.5, 3f64.sqrt() / 2.0));
        // Unterer Halbkreis als Schneider: Treffer ausserhalb seiner Spanne → kein Schnitt.
        let rest = trim_polyline_with_bulge(
            &[v(-1.0, 0.0), v(1.0, 0.0)],
            &[1.0],
            false,
            &[bline(&[(0.0, 0.0), (2.0, 0.0)], &[-1.0])],
            v(0.0, 1.0),
        );
        assert_eq!(rest, vec![bline(&[(-1.0, 0.0), (1.0, 0.0)], &[1.0])]);
    }

    #[test]
    fn trim_geschlossen_entfernt_bogen_um_pick() {
        // Quadrat, senkrechte Gerade x=0.5 schneidet unten und oben; Pick links.
        let sq = [v(0.0, 0.0), v(1.0, 0.0), v(1.0, 1.0), v(0.0, 1.0)];
        let rest = trim_polyline_with_bulge(&sq, &[], true, &[bline(&[(0.5, -1.0), (0.5, 2.0)], &[])], v(0.0, 0.5));
        assert_eq!(rest.len(), 1);
        assert!(!rest[0].closed);
        assert!(close(rest[0].pts[0], 0.5, 0.0));
        assert!(close(rest[0].pts[rest[0].pts.len() - 1], 0.5, 1.0));
        assert_eq!(rest[0].bulge.len(), rest[0].pts.len() - 1);
    }

    #[test]
    fn extend_bogen_bis_tangente() {
        let cutter = [line(&[(-10.0, -1.0), (10.0, -1.0)])];
        for at_end in [true, false] {
            let (p, b) = extend_bulge_segment(v(-1.0, 0.0), v(1.0, 0.0), 1.0, at_end, &cutter).unwrap();
            assert!(close(p, 0.0, -1.0));
            let arc = if at_end { bulge_arc(v(-1.0, 0.0), p, b) } else { bulge_arc(p, v(1.0, 0.0), b) }.unwrap();
            assert!(close(arc.center, 0.0, 0.0) && (arc.r - 1.0).abs() < P);
        }
        assert!(extend_bulge_segment(v(-1.0, 0.0), v(1.0, 0.0), 1.0, true, &[line(&[(-10.0, 5.0), (10.0, 5.0)])]).is_none());
        assert!(extend_bulge_segment(v(-1.0, 0.0), v(1.0, 0.0), 0.0, true, &cutter).is_none());
    }

    #[test]
    fn remove_segment_mit_bulge() {
        let pts = [v(-1.0, 0.0), v(1.0, 0.0), v(2.0, 0.0), v(3.0, 0.0), v(4.0, 0.0)];
        let r = remove_segment_with_bulge(&pts, &[1.0, 0.0, 0.0, 0.0], false, 1);
        assert_eq!(r.pts, pts[2..].to_vec());
        assert_eq!(r.bulge, vec![0.0, 0.0]);
        let r = remove_segment_with_bulge(&pts[..3], &[1.0, 0.0], false, 0);
        assert_eq!((r.pts, r.bulge), (pts[1..3].to_vec(), vec![0.0]));
        let r = remove_segment_with_bulge(&pts[..3], &[1.0, 0.5, 0.25], true, 1);
        assert_eq!(r.pts, vec![pts[2], pts[0], pts[1]]);
        assert_eq!(r.bulge, vec![0.25, 1.0]);
        assert!(remove_segment_with_bulge(&[], &[], true, 3).pts.is_empty());
    }

    #[test]
    fn join_mit_bulge_dreht_vorzeichen() {
        let inp = |pts: &[(f64, f64)], b: Option<Vec<f64>>| BulgeChainInput {
            pts: pts.iter().map(|&(x, y)| v(x, y)).collect(),
            closed: false,
            bulge: b,
        };
        // Start trifft Start: b wird umgedreht.
        let out = join_chains_with_bulge(&[inp(&[(-1.0, 0.0), (1.0, 0.0)], Some(vec![1.0])), inp(&[(-1.0, 0.0), (-3.0, 0.0)], None)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pts, vec![v(-3.0, 0.0), v(-1.0, 0.0), v(1.0, 0.0)]);
        assert_eq!(out[0].bulge, vec![-0.0, 1.0]);
        // Ende trifft Ende: b rückwärts angehängt, ALLE seine bulge-Werte umgedreht.
        let out = join_chains_with_bulge(&[
            inp(&[(0.0, 0.0), (1.0, 0.0)], Some(vec![0.0])),
            inp(&[(3.0, 0.0), (2.0, 0.0), (1.0, 0.0)], Some(vec![0.5, 0.25])),
        ]);
        assert_eq!(out[0].pts, vec![v(0.0, 0.0), v(1.0, 0.0), v(2.0, 0.0), v(3.0, 0.0)]);
        assert_eq!(out[0].bulge, vec![0.0, -0.25, -0.5]);
    }
}
