//! Ansichts-Geometrie ([K3c]): Verdeckungs-Clipping, Punkt-Verdeckung, Schlagschatten und
//! XOR-Umriss frontaler Flächengruppen (`toElevation.ts`: `clipSegmentVisible`, `isPointOccluded`,
//! `buildShadows`, `xorOutlineEdges`). Flächenaufbau, Stil, Painter-Ordnung und Pick-IDs bleiben in
//! TS. Rechenreihenfolge und Zahlsemantik wie dort.
//!
//! ## Verdecker (`occ`)
//! `[n, (tiefe, k, u0, v0 … u(k-1), v(k-1)) × n]`.
//!
//! ## Segmente
//! `clip_segments(occ, segs)` mit `segs = [m, (ax, ay, bx, by, tiefe) × m]` →
//! `[m, (c, (ax, ay, bx, by) × c) × m]` (sichtbare Teilstücke je Segment, c = 0 ganz verdeckt).
//!
//! ## Punkte
//! `occluded_points(occ, pts)` mit `pts = [m, (u, v, tiefe) × m]` → `[m, 0/1 × m]`.
//!
//! ## Schatten
//! `shadows(walls, slabs)`, je `[n, (tiefe, tiefeMin, k, u, v …) × n]` (Wände: tiefeMin ungenutzt) →
//! `[r, (tiefe, k, u, v …) × r]`.
//!
//! ## XOR-Umriss
//! `xor_outline(polys)` mit `[n, (k, u, v …) × n]` → `[e, (ax, ay, bx, by) × e]`.

use crate::jsnum::{max, min, round};
use std::collections::HashMap;

const OCC_MARGIN: f64 = 2e-3;
const EPS: f64 = 1e-6;
const MAX_SHADOW_DELTA: f64 = 1.2;
const SUN_U: f64 = 1.0;
const SUN_V: f64 = -1.0;

type P = (f64, f64);

struct Occ {
    poly: Vec<P>,
    bbox: [f64; 4], // uMin, uMax, vMin, vMax
    depth: f64,
}

fn bbox_of(pts: &[P]) -> [f64; 4] {
    let (mut u_min, mut u_max, mut v_min, mut v_max) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for &(u, v) in pts {
        if u < u_min {
            u_min = u;
        }
        if u > u_max {
            u_max = u;
        }
        if v < v_min {
            v_min = v;
        }
        if v > v_max {
            v_max = v;
        }
    }
    [u_min, u_max, v_min, v_max]
}

/// Liest `[n, (kopf…, k, pts…) × n]`; `head` = Zahl der Kopfwerte je Eintrag. `None` bei Unsinn.
fn read_polys(f: &[f64], head: usize) -> Option<Vec<(Vec<f64>, Vec<P>)>> {
    if f.is_empty() || f.iter().any(|v| !v.is_finite()) || f[0] < 0.0 {
        return None;
    }
    let n = f[0] as usize;
    let mut i = 1;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        if i + head >= f.len() {
            return None;
        }
        let h = f[i..i + head].to_vec();
        let k = f[i + head];
        if k < 0.0 {
            return None;
        }
        let k = k as usize;
        i += head + 1;
        if i + 2 * k > f.len() {
            return None;
        }
        out.push((h, (0..k).map(|j| (f[i + 2 * j], f[i + 2 * j + 1])).collect()));
        i += 2 * k;
    }
    (i == f.len()).then_some(out)
}

fn read_occ(f: &[f64]) -> Option<Vec<Occ>> {
    Some(
        read_polys(f, 1)?
            .into_iter()
            .map(|(h, poly)| Occ { bbox: bbox_of(&poly), poly, depth: h[0] })
            .collect(),
    )
}

fn segment_inside_poly_interval(a: P, b: P, poly: &[P]) -> Option<(f64, f64)> {
    let n = poly.len();
    if n < 3 {
        return None;
    }
    let mut area = 0.0;
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        area += p.0 * q.1 - q.0 * p.1;
    }
    let sign = if area >= 0.0 { 1.0 } else { -1.0 };
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let (mut t0, mut t1) = (0.0, 1.0);
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        let ex = q.0 - p.0;
        let ey = q.1 - p.1;
        let c0 = sign * (ex * (a.1 - p.1) - ey * (a.0 - p.0));
        let cd = sign * (ex * dy - ey * dx);
        if cd.abs() < 1e-12 {
            if c0 < 0.0 {
                return None;
            }
        } else {
            let t_hit = -c0 / cd;
            if cd > 0.0 {
                t0 = max(t0, t_hit);
            } else {
                t1 = min(t1, t_hit);
            }
            if t0 > t1 {
                return None;
            }
        }
    }
    (t0 <= t1).then_some((t0, t1))
}

fn clip_segment_visible(a: P, b: P, depth: f64, occ: &[Occ]) -> Vec<(P, P)> {
    let mut cuts: Vec<(f64, f64)> = Vec::new();
    let seg_min = (min(a.0, b.0), min(a.1, b.1));
    let seg_max = (max(a.0, b.0), max(a.1, b.1));
    for o in occ {
        if o.depth >= depth - OCC_MARGIN {
            continue;
        }
        if o.bbox[1] < seg_min.0 || o.bbox[0] > seg_max.0 {
            continue;
        }
        if o.bbox[3] < seg_min.1 || o.bbox[2] > seg_max.1 {
            continue;
        }
        if let Some(iv) = segment_inside_poly_interval(a, b, &o.poly) {
            if iv.1 - iv.0 > 1e-6 {
                cuts.push(iv);
            }
        }
    }
    if cuts.is_empty() {
        return vec![(a, b)];
    }
    cuts.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    let at = |t: f64| -> P { (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t) };
    let mut out = Vec::new();
    let mut cursor = 0.0;
    for (s, e) in cuts {
        if s > cursor + 1e-6 {
            out.push((at(cursor), at(min(s, 1.0))));
        }
        cursor = max(cursor, e);
        if cursor >= 1.0 {
            break;
        }
    }
    if cursor < 1.0 - 1e-6 {
        out.push((at(cursor), at(1.0)));
    }
    out
}

pub fn clip_segments(occ: &[f64], segs: &[f64]) -> Vec<f64> {
    let Some(occ) = read_occ(occ) else { return Vec::new() };
    if segs.is_empty() || segs.iter().any(|v| !v.is_finite()) || segs[0] < 0.0 || segs.len() != 1 + 5 * segs[0] as usize {
        return Vec::new();
    }
    let m = segs[0] as usize;
    let mut f = vec![m as f64];
    for k in 0..m {
        let s = &segs[1 + 5 * k..6 + 5 * k];
        let parts = clip_segment_visible((s[0], s[1]), (s[2], s[3]), s[4], &occ);
        f.push(parts.len() as f64);
        for (a, b) in parts {
            f.extend([a.0, a.1, b.0, b.1]);
        }
    }
    f
}

fn point_in_poly(pt: P, poly: &[P]) -> bool {
    let mut inside = false;
    let mut j = poly.len().wrapping_sub(1);
    for i in 0..poly.len() {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if (yi > pt.1) != (yj > pt.1) && pt.0 < ((xj - xi) * (pt.1 - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn occluded_points(occ: &[f64], pts: &[f64]) -> Vec<f64> {
    let Some(occ) = read_occ(occ) else { return Vec::new() };
    if pts.is_empty() || pts.iter().any(|v| !v.is_finite()) || pts[0] < 0.0 || pts.len() != 1 + 3 * pts[0] as usize {
        return Vec::new();
    }
    let m = pts[0] as usize;
    let mut f = vec![m as f64];
    for k in 0..m {
        let (u, v, depth) = (pts[1 + 3 * k], pts[2 + 3 * k], pts[3 + 3 * k]);
        let hit = occ.iter().any(|o| {
            o.depth < depth - OCC_MARGIN
                && !(u < o.bbox[0] || u > o.bbox[1] || v < o.bbox[2] || v > o.bbox[3])
                && point_in_poly((u, v), &o.poly)
        });
        f.push(if hit { 1.0 } else { 0.0 });
    }
    f
}

fn clip_polygon_to_rect(poly: &[P], r: [f64; 4]) -> Vec<P> {
    fn clip(input: &[P], inside: impl Fn(P) -> bool, intersect: impl Fn(P, P) -> P) -> Vec<P> {
        let mut out = Vec::new();
        for i in 0..input.len() {
            let a = input[i];
            let b = input[(i + 1) % input.len()];
            let (ain, bin) = (inside(a), inside(b));
            if ain {
                out.push(a);
            }
            if ain != bin {
                out.push(intersect(a, b));
            }
        }
        out
    }
    let lerp = |a: P, b: P, t: f64| -> P { (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t) };
    let (u_min, u_max, v_min, v_max) = (r[0], r[1], r[2], r[3]);
    let mut p = poly.to_vec();
    p = clip(&p, |q| q.0 >= u_min, |a, b| lerp(a, b, (u_min - a.0) / (b.0 - a.0)));
    if p.len() < 3 {
        return Vec::new();
    }
    p = clip(&p, |q| q.0 <= u_max, |a, b| lerp(a, b, (u_max - a.0) / (b.0 - a.0)));
    if p.len() < 3 {
        return Vec::new();
    }
    p = clip(&p, |q| q.1 >= v_min, |a, b| lerp(a, b, (v_min - a.1) / (b.1 - a.1)));
    if p.len() < 3 {
        return Vec::new();
    }
    p = clip(&p, |q| q.1 <= v_max, |a, b| lerp(a, b, (v_max - a.1) / (b.1 - a.1)));
    if p.len() < 3 {
        return Vec::new();
    }
    p
}

pub fn shadows(walls: &[f64], slabs: &[f64]) -> Vec<f64> {
    let (Some(walls), Some(slabs)) = (read_polys(walls, 2), read_polys(slabs, 2)) else {
        return Vec::new();
    };
    let mut res: Vec<(f64, Vec<P>)> = Vec::new();
    for (sh, spts) in &slabs {
        let so = bbox_of(spts);
        for (wh, wpts) in &walls {
            let wo = bbox_of(wpts);
            let delta = wh[0] - sh[1];
            if delta <= EPS || delta > MAX_SHADOW_DELTA {
                continue;
            }
            if so[1] <= wo[0] + EPS || so[0] >= wo[1] - EPS {
                continue;
            }
            let v_top = so[2];
            let par = [
                (so[0], v_top),
                (so[1], v_top),
                (so[1] + delta * SUN_U, v_top + delta * SUN_V),
                (so[0] + delta * SUN_U, v_top + delta * SUN_V),
            ];
            let clipped = clip_polygon_to_rect(&par, wo);
            if clipped.len() >= 3 {
                res.push((wh[0], clipped));
            }
        }
    }
    let mut f = vec![res.len() as f64];
    for (d, pts) in res {
        f.push(d);
        f.push(pts.len() as f64);
        for p in pts {
            f.extend([p.0, p.1]);
        }
    }
    f
}

pub fn xor_outline(polys: &[f64]) -> Vec<f64> {
    let Some(polys) = read_polys(polys, 0) else { return Vec::new() };
    const EPS_AX: f64 = 1e-6;
    let key_of = |x: f64| round(x * 1e5);
    // Gruppen in Einfügereihenfolge (wie `Map`; -0 und 0 sind derselbe Schlüssel).
    let mut horiz: Vec<(f64, Vec<(f64, f64)>)> = Vec::new();
    let mut vert: Vec<(f64, Vec<(f64, f64)>)> = Vec::new();
    let mut hidx: HashMap<i64, usize> = HashMap::new();
    let mut vidx: HashMap<i64, usize> = HashMap::new();
    let mut out: Vec<(P, P)> = Vec::new();
    fn add(list: &mut Vec<(f64, Vec<(f64, f64)>)>, idx: &mut HashMap<i64, usize>, k: f64, iv: (f64, f64)) {
        let slot = *idx.entry(k as i64).or_insert_with(|| {
            list.push((k, Vec::new()));
            list.len() - 1
        });
        list[slot].1.push(iv);
    }
    for (_, poly) in &polys {
        for i in 0..poly.len() {
            let a = poly[i];
            let b = poly[(i + 1) % poly.len()];
            if (a.1 - b.1).abs() < EPS_AX {
                add(&mut horiz, &mut hidx, key_of(a.1), (min(a.0, b.0), max(a.0, b.0)));
            } else if (a.0 - b.0).abs() < EPS_AX {
                add(&mut vert, &mut vidx, key_of(a.0), (min(a.1, b.1), max(a.1, b.1)));
            } else {
                out.push((a, b));
            }
        }
    }
    let sweep = |m: &Vec<(f64, Vec<(f64, f64)>)>, emit: &mut dyn FnMut(f64, f64, f64)| {
        for (k, ivs) in m {
            let mut evs: Vec<(f64, i32)> = Vec::new();
            for &(s, e) in ivs {
                if e - s < 1e-9 {
                    continue;
                }
                evs.push((s, 1));
                evs.push((e, -1));
            }
            evs.sort_by(|p, q| {
                let d = p.0 - q.0;
                let c = if d != 0.0 { d } else { (q.1 - p.1) as f64 };
                c.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut count = 0i32;
            let mut start = 0.0;
            let coord = k / 1e5;
            for (x, d) in evs {
                let was_odd = count % 2 == 1;
                count += d;
                let is_odd = count % 2 == 1;
                if !was_odd && is_odd {
                    start = x;
                } else if was_odd && !is_odd && x - start > 1e-9 {
                    emit(coord, start, x);
                }
            }
        }
    };
    sweep(&horiz, &mut |v, s, e| out.push(((s, v), (e, v))));
    sweep(&vert, &mut |u, s, e| out.push(((u, s), (u, e))));
    let mut f = vec![out.len() as f64];
    for (a, b) in out {
        f.extend([a.0, a.1, b.0, b.1]);
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdecktes_segment_wird_zerschnitten() {
        // Verdecker [1,2]×[-1,1] vor einer Linie bei v=0 von u=0..3.
        let occ = [1.0, 0.0, 4.0, 1.0, -1.0, 2.0, -1.0, 2.0, 1.0, 1.0, 1.0];
        let f = clip_segments(&occ, &[1.0, 0.0, 0.0, 3.0, 0.0, 1.0]);
        assert_eq!(f, vec![1.0, 2.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 3.0, 0.0]);
        // Tiefer als die Linie: kein Effekt.
        let f = clip_segments(&occ, &[1.0, 0.0, 0.0, 3.0, 0.0, -1.0]);
        assert_eq!(f, vec![1.0, 1.0, 0.0, 0.0, 3.0, 0.0]);
    }

    #[test]
    fn xor_hebt_innenkante_auf() {
        let sq = |x0: f64, x1: f64| [4.0, x0, 0.0, x1, 0.0, x1, 1.0, x0, 1.0];
        let mut inp = vec![2.0];
        inp.extend(sq(0.0, 1.0));
        inp.extend(sq(1.0, 2.0));
        let f = xor_outline(&inp);
        // Oben/unten je 2 Teilstücke (an der Naht nicht verschmolzen) + 2 senkrechte Aussenkanten;
        // die Innenkante bei u=1 hebt sich auf.
        assert_eq!(f[0], 6.0);
    }

    #[test]
    fn unsinn_ist_leer() {
        assert!(clip_segments(&[f64::NAN], &[0.0]).is_empty());
        assert!(shadows(&[1.0], &[0.0]).is_empty());
        assert!(xor_outline(&[1.0, 5.0, 0.0]).is_empty());
    }
}
