//! Ellipse, Bezier und Splines tessellieren ([K1]): Port von `src/geometry/curves.ts`. Punkte als flache
//! `[x0, y0, x1, y1, …]`. Rechenreihenfolge wie in TS; `cos/sin/pow` über `jsnum` (bitgleich zur
//! JS-Engine). Unsinn (zu viele Schritte) → leer, nie Panic.

use crate::jsnum::{cos, pow, sin};

const MAX_STEPS: usize = 100_000;

fn pts_of(f: &[f64]) -> Vec<(f64, f64)> {
    f.chunks_exact(2).map(|c| (c[0], c[1])).collect()
}

fn flat(p: &[(f64, f64)]) -> Vec<f64> {
    p.iter().flat_map(|q| [q.0, q.1]).collect()
}

pub fn ellipse(cx: f64, cy: f64, rx: f64, ry: f64, rotation: f64, n: f64) -> Vec<f64> {
    if !(n >= 0.0) || n > MAX_STEPS as f64 {
        return Vec::new();
    }
    let n = n as usize;
    let (cos_r, sin_r) = (cos(rotation), sin(rotation));
    let mut out = Vec::with_capacity(2 * n);
    for i in 0..n {
        let t = (i as f64 / n as f64) * std::f64::consts::PI * 2.0;
        let lx = rx * cos(t);
        let ly = ry * sin(t);
        out.push(cx + lx * cos_r - ly * sin_r);
        out.push(cy + lx * sin_r + ly * cos_r);
    }
    out
}

fn cubic_point(p0: (f64, f64), p1: (f64, f64), p2: (f64, f64), p3: (f64, f64), t: f64) -> (f64, f64) {
    let u = 1.0 - t;
    let a = u * u * u;
    let b = 3.0 * u * u * t;
    let c = 3.0 * u * t * t;
    let d = t * t * t;
    (a * p0.0 + b * p1.0 + c * p2.0 + d * p3.0, a * p0.1 + b * p1.1 + c * p2.1 + d * p3.1)
}

pub fn bezier_chain(f: &[f64], segs_per_curve: f64) -> Vec<f64> {
    let pts = pts_of(f);
    if pts.len() < 4 {
        return flat(&pts);
    }
    if !(segs_per_curve >= 0.0) || segs_per_curve > 4096.0 {
        return Vec::new();
    }
    let segs = segs_per_curve as usize;
    let mut out = vec![pts[0]];
    let mut i = 0;
    while i + 3 < pts.len() {
        for s in 1..=segs {
            out.push(cubic_point(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], s as f64 / segs as f64));
        }
        i += 3;
    }
    flat(&out)
}

fn cr_point(pts: &[(f64, f64)], i: i64, closed: bool) -> (f64, f64) {
    let n = pts.len() as i64;
    if closed {
        return pts[(((i % n) + n) % n) as usize];
    }
    if i < 0 {
        return pts[0];
    }
    if i >= n {
        return pts[(n - 1) as usize];
    }
    pts[i as usize]
}

pub fn catmull_rom(f: &[f64], closed: bool, segs_per_span: f64) -> Vec<f64> {
    let pts = pts_of(f);
    if pts.len() < 3 {
        return flat(&pts);
    }
    if !(segs_per_span >= 0.0) || segs_per_span > 4096.0 {
        return Vec::new();
    }
    let segs = segs_per_span as usize;
    let mut out: Vec<(f64, f64)> = Vec::new();
    let spans = if closed { pts.len() } else { pts.len() - 1 };
    for i in 0..spans as i64 {
        let p0 = cr_point(&pts, i - 1, closed);
        let p1 = cr_point(&pts, i, closed);
        let p2 = cr_point(&pts, i + 1, closed);
        let p3 = cr_point(&pts, i + 2, closed);
        for s in 0..segs {
            let t = s as f64 / segs as f64;
            let t2 = t * t;
            let t3 = t2 * t;
            let x = 0.5
                * (2.0 * p1.0 + (-p0.0 + p2.0) * t + (2.0 * p0.0 - 5.0 * p1.0 + 4.0 * p2.0 - p3.0) * t2 + (-p0.0 + 3.0 * p1.0 - 3.0 * p2.0 + p3.0) * t3);
            let y = 0.5
                * (2.0 * p1.1 + (-p0.1 + p2.1) * t + (2.0 * p0.1 - 5.0 * p1.1 + 4.0 * p2.1 - p3.1) * t2 + (-p0.1 + 3.0 * p1.1 - 3.0 * p2.1 + p3.1) * t3);
            out.push((x, y));
        }
    }
    if !closed {
        out.push(pts[pts.len() - 1]);
    }
    flat(&out)
}

fn bspline_seg_point(p0: (f64, f64), p1: (f64, f64), p2: (f64, f64), p3: (f64, f64), t: f64) -> (f64, f64) {
    let t2 = t * t;
    let t3 = t2 * t;
    let b0 = pow(1.0 - t, 3.0) / 6.0;
    let b1 = (3.0 * t3 - 6.0 * t2 + 4.0) / 6.0;
    let b2 = (-3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0) / 6.0;
    let b3 = t3 / 6.0;
    (p0.0 * b0 + p1.0 * b1 + p2.0 * b2 + p3.0 * b3, p0.1 * b0 + p1.1 * b1 + p2.1 * b2 + p3.1 * b3)
}

pub fn uniform_bspline(f: &[f64], closed: bool, segs_per_span: f64) -> Vec<f64> {
    let pts = pts_of(f);
    if pts.len() < 3 {
        return flat(&pts);
    }
    if !(segs_per_span >= 0.0) || segs_per_span > 4096.0 {
        return Vec::new();
    }
    let segs = segs_per_span as usize;
    let mut out: Vec<(f64, f64)> = Vec::new();
    if closed {
        let n = pts.len() as i64;
        let at = |i: i64| pts[(((i % n) + n) % n) as usize];
        for i in 0..n {
            for s in 0..segs {
                out.push(bspline_seg_point(at(i - 1), at(i), at(i + 1), at(i + 2), s as f64 / segs as f64));
            }
        }
        return flat(&out);
    }
    let last = pts[pts.len() - 1];
    let mut padded = vec![pts[0], pts[0]];
    padded.extend_from_slice(&pts);
    padded.push(last);
    padded.push(last);
    let spans = padded.len() - 3;
    for i in 0..spans {
        for s in 0..segs {
            out.push(bspline_seg_point(padded[i], padded[i + 1], padded[i + 2], padded[i + 3], s as f64 / segs as f64));
        }
    }
    out.push(last);
    flat(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ellipse_hat_n_punkte_und_beginnt_rechts() {
        let e = ellipse(1.0, 2.0, 3.0, 1.0, 0.0, 64.0);
        assert_eq!(e.len(), 128);
        assert!((e[0] - 4.0).abs() < 1e-12 && (e[1] - 2.0).abs() < 1e-12);
        assert!(ellipse(0.0, 0.0, 1.0, 1.0, 0.0, 1e9).is_empty());
    }

    #[test]
    fn bezier_endet_im_letzten_anker() {
        let f = [0.0, 0.0, 1.0, 2.0, 2.0, 2.0, 3.0, 0.0];
        let b = bezier_chain(&f, 24.0);
        assert_eq!(b.len(), 2 * 25);
        assert_eq!(&b[b.len() - 2..], &[3.0, 0.0]);
        assert_eq!(bezier_chain(&[0.0, 0.0, 1.0, 1.0], 24.0), vec![0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn spline_beruehrt_die_enden_offen() {
        let f = [0.0, 0.0, 1.0, 1.0, 2.0, 0.0, 3.0, 1.0];
        let c = catmull_rom(&f, false, 16.0);
        assert_eq!((c[0], c[1]), (0.0, 0.0));
        assert_eq!(&c[c.len() - 2..], &[3.0, 1.0]);
        let b = uniform_bspline(&f, false, 16.0);
        assert!((b[0]).abs() < 1e-9);
        assert_eq!(&b[b.len() - 2..], &[3.0, 1.0]);
        assert_eq!(uniform_bspline(&f, true, 16.0).len(), 2 * 4 * 16);
    }
}
