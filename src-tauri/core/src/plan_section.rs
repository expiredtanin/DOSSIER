//! Schnitt-Bänder ([K3c]): Vereinigung achsparalleler Schnitt-Rechtecke zu Aussenringen
//! (`unionRectOutlines`) und Dach-Schnittspur. Die Dominanz-Subtraktion (`subtractDominantBands`) liegt
//! seit [125] gemeinsam mit dem 3D-Live-Schnitt in `dossier_hatch::section_dominance`. Rechenreihenfolge
//! wie in TS.
//!
//! ## Dach-Schnittspur
//! `roof_segments(base_x, base_y, u_x, u_y, planes)` mit `planes = [n, (k, x, y, z …) × n]` (Modell
//! [x, y, Höhe], konvexe Aufsicht-Polygone) → `[m, (tLo, tHi, zOben0, zOben1, cosNeigung) × m]`: die
//! Spur der senkrechten Schnittebene (Gerade `base + t·u`) je Dachfläche, nach `tLo` sortiert und
//! gleich geneigte, anstossende Teile verschmolzen (`appendRoofSections`).
//!
//! ## Umrisse
//! `union_outlines(in)` mit `in = [n, (uMin, uMax, vMin, vMax) × n]` → `[r, (k, x, y × k) × r]`.

use crate::jsnum::{max, min};
use dossier_hatch::section_dominance::Rect;
use std::collections::HashMap;

fn signed_area(ring: &[(f64, f64)]) -> f64 {
    let mut a = 0.0;
    for i in 0..ring.len() {
        let (x0, y0) = ring[i];
        let (x1, y1) = ring[(i + 1) % ring.len()];
        a += x0 * y1 - x1 * y0;
    }
    a / 2.0
}

fn sorted_unique(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v.dedup_by(|a, b| *a == *b);
    v
}

/// Zelle belegt, wenn ihr Mittelpunkt streng in einem Rechteck liegt. Die Mittelpunkte steigen
/// streng an, darum deckt jedes Rechteck einen zusammenhängenden Zellbereich (statt je Zelle alle
/// Rechtecke zu prüfen, s. [`occupancy_naive`]).
fn occupancy(rects: &[Rect], xs: &[f64], ys: &[f64]) -> Vec<Vec<bool>> {
    let (nx, ny) = (xs.len() - 1, ys.len() - 1);
    let cxs: Vec<f64> = (0..nx).map(|i| (xs[i] + xs[i + 1]) / 2.0).collect();
    let cys: Vec<f64> = (0..ny).map(|j| (ys[j] + ys[j + 1]) / 2.0).collect();
    let mut cell = vec![vec![false; ny]; nx];
    for r in rects {
        let (i0, i1) = (cxs.partition_point(|&c| c <= r.u_min), cxs.partition_point(|&c| c < r.u_max));
        let (j0, j1) = (cys.partition_point(|&c| c <= r.v_min), cys.partition_point(|&c| c < r.v_max));
        for col in cell.iter_mut().take(i1).skip(i0) {
            for c in col.iter_mut().take(j1).skip(j0) {
                *c = true;
            }
        }
    }
    cell
}

#[cfg(test)]
fn occupancy_naive(rects: &[Rect], xs: &[f64], ys: &[f64]) -> Vec<Vec<bool>> {
    let (nx, ny) = (xs.len() - 1, ys.len() - 1);
    let mut cell = vec![vec![false; ny]; nx];
    for i in 0..nx {
        for j in 0..ny {
            let cx = (xs[i] + xs[i + 1]) / 2.0;
            let cy = (ys[j] + ys[j + 1]) / 2.0;
            cell[i][j] = rects.iter().any(|r| cx > r.u_min && cx < r.u_max && cy > r.v_min && cy < r.v_max);
        }
    }
    cell
}

pub fn union_outlines(inp: &[f64]) -> Vec<f64> {
    if inp.is_empty() || !inp[0].is_finite() || inp[0] < 0.0 {
        return Vec::new();
    }
    let n = inp[0] as usize;
    if inp.len() != 1 + 4 * n || inp.iter().any(|v| !v.is_finite()) {
        return Vec::new();
    }
    let rects: Vec<Rect> = (0..n)
        .map(|k| Rect { u_min: inp[1 + 4 * k], u_max: inp[2 + 4 * k], v_min: inp[3 + 4 * k], v_max: inp[4 + 4 * k] })
        .collect();
    let xs = sorted_unique(rects.iter().flat_map(|r| [r.u_min, r.u_max]).collect());
    let ys = sorted_unique(rects.iter().flat_map(|r| [r.v_min, r.v_max]).collect());
    if xs.len() < 2 || ys.len() < 2 {
        return vec![0.0];
    }
    let nx = xs.len() - 1;
    let ny = ys.len() - 1;
    let cell = occupancy(&rects, &xs, &ys);
    let at = |i: isize, j: isize| i >= 0 && j >= 0 && (i as usize) < nx && (j as usize) < ny && cell[i as usize][j as usize];
    // Gerichtete Randkanten in Einfügereihenfolge (wie `Map`: erneutes `set` behält die Position).
    let mut keys: Vec<(usize, usize)> = Vec::new();
    let mut next: HashMap<(usize, usize), (usize, usize)> = HashMap::new();
    let mut set = |k: (usize, usize), v: (usize, usize)| {
        if next.insert(k, v).is_none() {
            keys.push(k);
        }
    };
    for i in 0..nx {
        for j in 0..ny {
            if !cell[i][j] {
                continue;
            }
            let (ii, jj) = (i as isize, j as isize);
            if !at(ii, jj - 1) {
                set((i, j), (i + 1, j));
            }
            if !at(ii + 1, jj) {
                set((i + 1, j), (i + 1, j + 1));
            }
            if !at(ii, jj + 1) {
                set((i + 1, j + 1), (i, j + 1));
            }
            if !at(ii - 1, jj) {
                set((i, j + 1), (i, j));
            }
        }
    }
    let mut rings: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut used: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    for &start in &keys {
        if used.contains(&start) {
            continue;
        }
        let mut ring: Vec<(f64, f64)> = Vec::new();
        let mut k = start;
        while !used.contains(&k) {
            used.insert(k);
            ring.push((xs[k.0], ys[k.1]));
            match next.get(&k) {
                Some(&nk) => k = nk,
                None => break,
            }
        }
        let len = ring.len();
        let simple: Vec<(f64, f64)> = ring
            .iter()
            .enumerate()
            .filter(|(idx, p)| {
                let a = ring[(idx + len - 1) % len];
                let b = ring[(idx + 1) % len];
                !((a.0 == p.0 && p.0 == b.0) || (a.1 == p.1 && p.1 == b.1))
            })
            .map(|(_, p)| *p)
            .collect();
        if simple.len() >= 4 && signed_area(&simple) > 0.0 {
            rings.push(simple);
        }
    }
    let mut f = vec![rings.len() as f64];
    for r in &rings {
        f.push(r.len() as f64);
        for p in r {
            f.push(p.0);
            f.push(p.1);
        }
    }
    f
}

/// Spur-Abschnitt auf einer Dachfläche.
#[derive(Clone, Copy)]
struct RoofSeg {
    t_lo: f64,
    t_hi: f64,
    z_top0: f64,
    z_top1: f64,
    cos_theta: f64,
}

pub fn roof_segments(bx: f64, by: f64, ux: f64, uy: f64, planes: &[f64]) -> Vec<f64> {
    if [bx, by, ux, uy].iter().any(|v| !v.is_finite()) || planes.iter().any(|v| !v.is_finite()) {
        return Vec::new();
    }
    let Some(&n) = planes.first() else { return Vec::new() };
    if n < 0.0 || n.fract() != 0.0 {
        return Vec::new();
    }
    let mut segs: Vec<RoofSeg> = Vec::new();
    let mut i = 1;
    for _ in 0..n as usize {
        let Some(&k) = planes.get(i) else { return Vec::new() };
        if k < 0.0 || k.fract() != 0.0 || i + 1 + 3 * k as usize > planes.len() {
            return Vec::new();
        }
        let k = k as usize;
        let pts: Vec<[f64; 3]> = (0..k).map(|j| [planes[i + 1 + 3 * j], planes[i + 2 + 3 * j], planes[i + 3 + 3 * j]]).collect();
        i += 1 + 3 * k;
        if k < 3 {
            continue;
        }
        let (mut a, mut b, mut c) = (0.0, 0.0, 0.0);
        for q in 0..k {
            let cc = pts[q];
            let d = pts[(q + 1) % k];
            a += (cc[1] - d[1]) * (cc[2] + d[2]);
            b += (cc[2] - d[2]) * (cc[0] + d[0]);
            c += (cc[0] - d[0]) * (cc[1] + d[1]);
        }
        if c.abs() < 1e-9 {
            continue;
        }
        let n_len = crate::jsmath::hypot(&[a, b, c]);
        let cos_theta = c.abs() / if n_len == 0.0 || n_len.is_nan() { 1.0 } else { n_len };
        let z_at = |x: f64, y: f64| -> f64 { pts[0][2] - (a * (x - pts[0][0]) + b * (y - pts[0][1])) / c };
        let (mut cx, mut cy) = (0.0, 0.0);
        for p in &pts {
            cx += p[0];
            cy += p[1];
        }
        cx /= k as f64;
        cy /= k as f64;
        let (mut t_lo, mut t_hi) = (f64::NEG_INFINITY, f64::INFINITY);
        let mut outside = false;
        let mut q = 0;
        while q < k && !outside {
            let pa = pts[q];
            let pb = pts[(q + 1) % k];
            let mut ex = -(pb[1] - pa[1]);
            let mut ey = pb[0] - pa[0];
            if ex * (cx - pa[0]) + ey * (cy - pa[1]) < 0.0 {
                ex = -ex;
                ey = -ey;
            }
            let denom = ex * ux + ey * uy;
            let dist = ex * (bx - pa[0]) + ey * (by - pa[1]);
            q += 1;
            if denom.abs() < 1e-12 {
                if dist < -1e-9 {
                    outside = true;
                }
                continue;
            }
            let t = -dist / denom;
            if denom > 0.0 {
                t_lo = max(t_lo, t);
            } else {
                t_hi = min(t_hi, t);
            }
        }
        if outside || t_hi - t_lo <= 1e-6 {
            continue;
        }
        let (x0, y0) = (bx + t_lo * ux, by + t_lo * uy);
        let (x1, y1) = (bx + t_hi * ux, by + t_hi * uy);
        segs.push(RoofSeg { t_lo, t_hi, z_top0: z_at(x0, y0), z_top1: z_at(x1, y1), cos_theta });
    }
    if i != planes.len() {
        return Vec::new();
    }
    segs.sort_by(|p, q| (p.t_lo - q.t_lo).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let slope = |x: &RoofSeg| (x.z_top1 - x.z_top0) / max(x.t_hi - x.t_lo, 1e-12);
    let line_z = |x: &RoofSeg, t: f64| x.z_top0 + slope(x) * (t - x.t_lo);
    let mut merged: Vec<RoofSeg> = Vec::new();
    for sg in segs {
        if let Some(last) = merged.last_mut() {
            if sg.t_lo <= last.t_hi + 1e-6
                && (line_z(last, sg.t_lo) - sg.z_top0).abs() < 1e-6
                && (slope(&sg) - slope(last)).abs() < 1e-6
                && (sg.cos_theta - last.cos_theta).abs() < 1e-6
            {
                let hi = max(last.t_hi, sg.t_hi);
                let z1 = line_z(last, hi);
                last.z_top1 = z1;
                last.t_hi = hi;
                continue;
            }
        }
        merged.push(sg);
    }
    let mut f = vec![merged.len() as f64];
    for m in &merged {
        f.extend([m.t_lo, m.t_hi, m.z_top0, m.z_top1, m.cos_theta]);
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn l_form_ergibt_einen_ring() {
        let f = union_outlines(&[2.0, 0.0, 2.0, 0.0, 1.0, 0.0, 1.0, 0.0, 2.0]);
        assert_eq!(f[0], 1.0);
        assert_eq!(f[1], 6.0);
    }

    #[test]
    fn pultdach_spur() {
        // Fläche 0..4 × 0..3, Höhe steigt in x von 3 auf 4 (Neigung 1/4); Schnitt entlang x bei y = 1.
        let planes = [1.0, 4.0, 0.0, 0.0, 3.0, 4.0, 0.0, 4.0, 4.0, 3.0, 4.0, 0.0, 3.0, 3.0];
        let f = roof_segments(-1.0, 1.0, 1.0, 0.0, &planes);
        assert_eq!(f[0], 1.0);
        assert_eq!((f[1], f[2]), (1.0, 5.0));
        assert!((f[3] - 3.0).abs() < 1e-12 && (f[4] - 4.0).abs() < 1e-12);
    }

    #[test]
    fn unsinn_ist_leer() {
        assert!(roof_segments(f64::NAN, 0.0, 1.0, 0.0, &[0.0]).is_empty());
        assert!(union_outlines(&[1.0, f64::NAN, 1.0, 0.0, 1.0]).is_empty());
    }
}

#[cfg(test)]
mod tests_schnell {
    use super::*;

    /// Belegung der Umriss-Zellen: Bereichs-Malen = Prüfung je Zelle gegen alle Rechtecke.
    #[test]
    fn umriss_belegung_wie_je_zelle() {
        let mut x: u64 = 777;
        let mut rnd = |m: u64| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (x >> 33) % m
        };
        for _ in 0..500 {
            let n = 1 + rnd(12) as usize;
            let rects: Vec<Rect> = (0..n)
                .map(|_| {
                    let (u0, v0) = (rnd(8) as f64 * 0.3, rnd(8) as f64 * 0.3);
                    Rect { u_min: u0, u_max: u0 + 0.3 * (1 + rnd(5)) as f64, v_min: v0, v_max: v0 + 0.3 * (1 + rnd(5)) as f64 }
                })
                .collect();
            let xs = sorted_unique(rects.iter().flat_map(|r| [r.u_min, r.u_max]).collect());
            let ys = sorted_unique(rects.iter().flat_map(|r| [r.v_min, r.v_max]).collect());
            assert_eq!(occupancy(&rects, &xs, &ys), occupancy_naive(&rects, &xs, &ys));
        }
    }
}
