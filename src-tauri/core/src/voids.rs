//! Abzugskörper in Grundriss und Schnitt ([K3c], vorher `plan/voids.ts`): Polygon minus Schneider mit
//! Schlüsselloch-Stegen für Löcher, nicht gestrichene Kanten, Strecke ausserhalb von Ringen und die
//! Schnitt-Rechtecke eines senkrechten Prismas. Die Auswahl, welche Körper welches Bauteil treffen,
//! bleibt in TS (Modell). Rechenreihenfolge wie dort.
//!
//! ## Flaches Format
//! Ringliste `[n, (k, x, y …) × n]`.
//! - `keyhole(ringe)` → `[k, x, y …, nStege, i …]` (Ringe offen oder geschlossen).
//! - `subtract_rings(pts, schneider, nicht_gestrichen)`: `pts = [k, x, y …]`, `schneider = Ringliste`,
//!   `nicht_gestrichen = [m, i …]` → `[-1]` (keine Überschneidung — Original unverändert) oder
//!   `[n, (k, x, y …, m, i …) × n]`.
//! - `segment_outside(ax, ay, bx, by, schneider)` → `[n, (t0, t1) × n]`.
//! - `section_rects(pts, base_x, base_y, u_x, u_y)` → `[n, (u0, u1) × n]`.
//!
//! Abweichung zur TS-Fassung: der Überschneidungstest nahm den Schnitt mit ALLEN Schneidern
//! gleichzeitig; mit zwei getrennten Aussparungen fiel dann jede Subtraktion weg. Jetzt gilt die
//! Vereinigung der Schneider.

use crate::flat_read::{signed_area, Reader};
use crate::jsmath::hypot2;
use crate::jsnum::max;
use crate::polygon_bool;

type Pair = [f64; 2];
const EPS: f64 = 1e-7;

fn open_ring(r: &[Pair]) -> Vec<Pair> {
    if r.len() > 1 {
        let a = r[0];
        let b = r[r.len() - 1];
        if (a[0] - b[0]).abs() < EPS && (a[1] - b[1]).abs() < EPS {
            return r[..r.len() - 1].to_vec();
        }
    }
    r.to_vec()
}

/// Löcher per Steg in den Aussenring einhängen; liefert Punkte und Stegkanten-Indizes.
pub fn keyhole(poly: &[Vec<Pair>]) -> (Vec<Pair>, Vec<usize>) {
    let mut outer = open_ring(&poly[0]);
    let mut bridges: Vec<usize> = Vec::new();
    let mut holes: Vec<Vec<Pair>> = poly[1..].iter().map(|h| open_ring(h)).filter(|h| h.len() >= 3).collect();
    let max_x = |h: &Vec<Pair>| h.iter().fold(f64::NEG_INFINITY, |m, p| max(m, p[0]));
    holes.sort_by(|a, b| (max_x(b) - max_x(a)).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    for hole in holes {
        let mut hi = 0;
        for i in 1..hole.len() {
            if hole[i][0] > hole[hi][0] {
                hi = i;
            }
        }
        let h = hole[hi];
        let mut oi = 0;
        let mut best = f64::INFINITY;
        for (i, p) in outer.iter().enumerate() {
            let d = hypot2(p[0] - h[0], p[1] - h[1]);
            if d < best {
                best = d;
                oi = i;
            }
        }
        let mut hole_seq: Vec<Pair> = hole[hi..].to_vec();
        hole_seq.extend_from_slice(&hole[..hi]);
        hole_seq.push(h);
        let mut next: Vec<Pair> = outer[..=oi].to_vec();
        next.extend_from_slice(&hole_seq);
        next.push(outer[oi]);
        next.extend_from_slice(&outer[oi + 1..]);
        let shift = hole_seq.len() + 1;
        for b in bridges.iter_mut() {
            if *b > oi {
                *b += shift;
            }
        }
        bridges.push(oi);
        bridges.push(oi + hole_seq.len());
        outer = next;
    }
    (outer, bridges)
}

fn on_segment(a: Pair, b: Pair, p: Pair, q: Pair) -> bool {
    let tol = 1e-6;
    let dx = q[0] - p[0];
    let dy = q[1] - p[1];
    let len = hypot2(dx, dy);
    if len < EPS {
        return false;
    }
    let dist = |r: Pair| ((r[0] - p[0]) * dy - (r[1] - p[1]) * dx).abs() / len;
    let t = |r: Pair| ((r[0] - p[0]) * dx + (r[1] - p[1]) * dy) / (len * len);
    dist(a) < tol && dist(b) < tol && t(a) > -tol && t(a) < 1.0 + tol && t(b) > -tol && t(b) < 1.0 + tol
}

/// Math.sign: NaN bleibt NaN, ±0 bleibt 0.
fn js_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        x
    } else {
        x.signum()
    }
}

pub struct Piece {
    pub pts: Vec<Pair>,
    pub no_stroke: Vec<usize>,
}

/// `None` = keine Überschneidung (Original unverändert lassen).
pub fn subtract_rings(pts: &[Pair], cutters: &[Vec<Pair>], no_stroke: &[usize]) -> Option<Vec<Piece>> {
    if pts.len() < 3 || cutters.is_empty() {
        return None;
    }
    let subject = vec![pts.to_vec()];
    let clips: Vec<Vec<Vec<Pair>>> = cutters.iter().filter(|c| c.len() >= 3).map(|c| vec![c.clone()]).collect();
    if clips.is_empty() {
        return None;
    }
    let all_clips = polygon_bool::union(&clips);
    if polygon_bool::intersection(&[subject.clone()], &all_clips).is_empty() {
        return None;
    }
    let diff = polygon_bool::difference(&[subject], &clips);
    let area0 = signed_area(pts).abs();
    let mut out = Vec::new();
    for poly in &diff {
        // Ringe wie im TS-Pfad geschlossen übergeben (der Kern liefert offene Ringe).
        let closed: Vec<Vec<Pair>> = poly
            .iter()
            .map(|r| {
                let mut c = r.clone();
                if let Some(&f) = r.first() {
                    c.push(f);
                }
                c
            })
            .collect();
        let (kp, bridges) = keyhole(&closed);
        if kp.len() < 3 || signed_area(&open_ring(&closed[0])).abs() < area0 * 1e-9 {
            continue;
        }
        let same_dir = js_sign(signed_area(&kp)) == js_sign(signed_area(pts)) || signed_area(pts) == 0.0;
        let ring_pts: Vec<Pair> = if same_dir { kp } else { kp.into_iter().rev().collect() };
        let n = ring_pts.len();
        let bridge_set: std::collections::HashSet<usize> = if same_dir {
            bridges.iter().copied().collect()
        } else {
            bridges.iter().map(|&i| (n + n - 2 - i.min(n + n - 2)) % n).collect()
        };
        let mut ns = Vec::new();
        for i in 0..n {
            let a = ring_pts[i];
            let b = ring_pts[(i + 1) % n];
            if bridge_set.contains(&i) {
                ns.push(i);
                continue;
            }
            for &e in no_stroke {
                if e < pts.len() {
                    let p = pts[e];
                    let q = pts[(e + 1) % pts.len()];
                    if on_segment(a, b, p, q) {
                        ns.push(i);
                        break;
                    }
                }
            }
        }
        out.push(Piece { pts: ring_pts, no_stroke: ns });
    }
    Some(out)
}

fn point_in_ring(x: f64, y: f64, r: &[Pair]) -> bool {
    let mut inside = false;
    let mut j = r.len().wrapping_sub(1);
    for i in 0..r.len() {
        let [xi, yi] = r[i];
        let [xj, yj] = r[j];
        if (yi > y) != (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Teile der Strecke a→b ausserhalb aller Ringe, als Parameter-Intervalle.
pub fn segment_outside(a: Pair, b: Pair, cutters: &[Vec<Pair>]) -> Vec<(f64, f64)> {
    let mut ts = vec![0.0, 1.0];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    for r in cutters {
        for i in 0..r.len() {
            let p = r[i];
            let q = r[(i + 1) % r.len()];
            let ex = q[0] - p[0];
            let ey = q[1] - p[1];
            let den = dx * ey - dy * ex;
            if den.abs() < 1e-14 {
                continue;
            }
            let t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den;
            let u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
            if t > 0.0 && t < 1.0 && u >= -1e-9 && u <= 1.0 + 1e-9 {
                ts.push(t);
            }
        }
    }
    ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for i in 0..ts.len() - 1 {
        let (t0, t1) = (ts[i], ts[i + 1]);
        if t1 - t0 < 1e-9 {
            continue;
        }
        let tm = (t0 + t1) / 2.0;
        let mx = a[0] + dx * tm;
        let my = a[1] + dy * tm;
        if cutters.iter().any(|r| point_in_ring(mx, my, r)) {
            continue;
        }
        match out.last_mut() {
            Some(last) if (last.1 - t0).abs() < 1e-9 => last.1 = t1,
            _ => out.push((t0, t1)),
        }
    }
    out
}

/// u-Intervalle der Schnittspur durch ein senkrechtes Prisma (`pts` = Grundriss).
pub fn section_rects(pts: &[Pair], base: Pair, u_dir: Pair) -> Vec<(f64, f64)> {
    let n = pts.len();
    let side = |p: Pair| (p[0] - base[0]) * u_dir[1] - (p[1] - base[1]) * u_dir[0];
    let mut ts: Vec<f64> = Vec::new();
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let sa = side(a);
        let sb = side(b);
        if (sa > 0.0) == (sb > 0.0) {
            continue;
        }
        let t = sa / (sa - sb);
        let px = a[0] + (b[0] - a[0]) * t;
        let py = a[1] + (b[1] - a[1]) * t;
        ts.push((px - base[0]) * u_dir[0] + (py - base[1]) * u_dir[1]);
    }
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < ts.len() {
        let (u0, u1) = (ts[i], ts[i + 1]);
        i += 2;
        if u1 - u0 < 1e-6 {
            continue;
        }
        out.push((u0, u1));
    }
    out
}

// ── Bindungen (flach) ──────────────────────────────────────────────────────

fn read_rings(r: &mut Reader) -> Option<Vec<Vec<Pair>>> {
    let n = r.count()?;
    (0..n).map(|_| r.ring()).collect()
}

fn finite(rings: &[Vec<Pair>]) -> bool {
    rings.iter().all(|r| r.iter().all(|p| p[0].is_finite() && p[1].is_finite()))
}

fn push_ring(f: &mut Vec<f64>, r: &[Pair]) {
    f.push(r.len() as f64);
    for p in r {
        f.extend(*p);
    }
}

pub fn keyhole_flat(inp: &[f64]) -> Vec<f64> {
    let mut r = Reader::new(inp);
    let Some(rings) = read_rings(&mut r) else { return Vec::new() };
    if rings.is_empty() || !finite(&rings) || rings[0].is_empty() {
        return Vec::new();
    }
    let (pts, bridges) = keyhole(&rings);
    let mut f = Vec::new();
    push_ring(&mut f, &pts);
    f.push(bridges.len() as f64);
    f.extend(bridges.iter().map(|&b| b as f64));
    f
}

pub fn subtract_rings_flat(pts: &[f64], cutters: &[f64], no_stroke: &[f64]) -> Vec<f64> {
    let (mut rp, mut rc, mut rn) = (Reader::new(pts), Reader::new(cutters), Reader::new(no_stroke));
    let (Some(p), Some(c)) = (rp.ring(), read_rings(&mut rc)) else { return Vec::new() };
    let Some(m) = rn.count() else { return Vec::new() };
    let Some(ns) = (0..m).map(|_| rn.count()).collect::<Option<Vec<usize>>>() else { return Vec::new() };
    if !finite(&c) || !finite(&[p.clone()]) {
        return Vec::new();
    }
    match subtract_rings(&p, &c, &ns) {
        None => vec![-1.0],
        Some(pieces) => {
            let mut f = vec![pieces.len() as f64];
            for pc in &pieces {
                push_ring(&mut f, &pc.pts);
                f.push(pc.no_stroke.len() as f64);
                f.extend(pc.no_stroke.iter().map(|&i| i as f64));
            }
            f
        }
    }
}

pub fn segment_outside_flat(a: &[f64], cutters: &[f64]) -> Vec<f64> {
    let mut rc = Reader::new(cutters);
    let Some(c) = read_rings(&mut rc) else { return Vec::new() };
    if a.len() != 4 || a.iter().any(|v| !v.is_finite()) || !finite(&c) {
        return Vec::new();
    }
    let parts = segment_outside([a[0], a[1]], [a[2], a[3]], &c);
    let mut f = vec![parts.len() as f64];
    for (t0, t1) in parts {
        f.extend([t0, t1]);
    }
    f
}

pub fn section_rects_flat(pts: &[f64], base_u: &[f64]) -> Vec<f64> {
    let mut r = Reader::new(pts);
    let Some(p) = r.ring() else { return Vec::new() };
    if base_u.len() != 4 || base_u.iter().any(|v| !v.is_finite()) || !finite(&[p.clone()]) || p.is_empty() {
        return Vec::new();
    }
    let rects = section_rects(&p, [base_u[0], base_u[1]], [base_u[2], base_u[3]]);
    let mut f = vec![rects.len() as f64];
    for (u0, u1) in rects {
        f.extend([u0, u1]);
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Pair> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    #[test]
    fn loch_wird_per_steg_eingehaengt() {
        let r = subtract_rings(&sq(0.0, 0.0, 4.0, 2.0), &[sq(1.0, 0.5, 2.0, 1.5)], &[]).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].pts.len(), 10);
        assert_eq!(r[0].no_stroke.len(), 2);
    }

    #[test]
    fn ohne_ueberschneidung_none() {
        assert!(subtract_rings(&sq(0.0, 0.0, 1.0, 1.0), &[sq(5.0, 5.0, 6.0, 6.0)], &[]).is_none());
    }

    #[test]
    fn zwei_getrennte_aussparungen_wirken_beide() {
        let r = subtract_rings(&sq(0.0, 0.0, 10.0, 2.0), &[sq(1.0, -1.0, 2.0, 3.0), sq(6.0, -1.0, 7.0, 3.0)], &[]).unwrap();
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn strecke_wird_geteilt() {
        let parts = segment_outside([0.0, 0.5], [4.0, 0.5], &[sq(1.0, 0.0, 2.0, 1.0)]);
        assert_eq!(parts.len(), 2);
        assert!((parts[0].1 - 0.25).abs() < 1e-12 && (parts[1].0 - 0.5).abs() < 1e-12);
    }

    #[test]
    fn unsinn_ist_leer() {
        assert!(keyhole_flat(&[f64::NAN]).is_empty());
        assert!(subtract_rings_flat(&[3.0, 0.0], &[0.0], &[0.0]).is_empty());
        assert!(section_rects_flat(&[3.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0], &[0.0]).is_empty());
    }
}
