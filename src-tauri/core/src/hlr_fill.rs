//! Sichtbare Teilflächen ([G4]): exakte Sichtbarkeit der Füllungen, passend zu den Kanten aus `hlr.rs`.
//!
//! Eingabe sind ebene Flächen in Ansichtskoordinaten `(u, v, d)` wie in `hlr` (`d` = Tiefe, grösser = weiter
//! weg). Für jede Fläche `F` ist der verdeckte Teil die Vereinigung über alle Flächen `G` von
//! „Umriss von `G` ∩ Halbebene, in der `G` näher liegt als `F`" — zwei Ebenen: die Tiefendifferenz ist linear in
//! `(u, v)`, also eine Halbebene, auch bei Flächen, die einander durchdringen. Sichtbar ist `F` minus diese
//! Vereinigung (2D-Booleans, i_overlay). Gleiche Tiefe (gemeinsame Kante, koplanar, anstossend) verdeckt nicht.
//!
//! Vorauswahl: 2D-Raster der Umrisse, Tiefenbereich, Tiefendifferenz an den Ecken von `G`; ganz von einem
//! konvexen Verdecker gedeckte Flächen entfallen ohne Boolean. Flächen ohne Verdecker bleiben unverändert
//! (`None`), damit sichtbare Flächen genau ihren Umriss behalten.

use crate::flat::Polygon;

pub type V3 = [f64; 3];

/// Ebene einer Fläche `d = c0 + cu·u + cv·v` mit Umriss und Ausdehnung.
struct Prep {
    poly: Vec<[f64; 2]>,
    bb: [f64; 4],
    dmin: f64,
    dmax: f64,
    plane: Option<[f64; 3]>,
    convex: bool,
}

fn prepare(pts: &[V3]) -> Option<Prep> {
    if pts.len() < 3 || pts.iter().any(|p| p.iter().any(|v| !v.is_finite())) {
        return None;
    }
    // Newell-Normale; Ebene nur, wenn die Fläche nicht auf der Kante steht.
    let mut n = [0.0; 3];
    for i in 0..pts.len() {
        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if !(l > 0.0) {
        return None;
    }
    let poly: Vec<[f64; 2]> = pts.iter().map(|p| [p[0], p[1]]).collect();
    let area = poly.iter().zip(poly.iter().cycle().skip(1)).map(|(a, b)| a[0] * b[1] - b[0] * a[1]).sum::<f64>() / 2.0;
    let plane = if (n[2] / l).abs() > 1e-9 && area.abs() > 1e-12 {
        // Ebene durch den Schwerpunkt der Ecken (robust bei leicht unebenen Flächen).
        let m = pts.len() as f64;
        let c = pts.iter().fold([0.0; 3], |c, p| [c[0] + p[0] / m, c[1] + p[1] / m, c[2] + p[2] / m]);
        let (cu, cv) = (-n[0] / n[2], -n[1] / n[2]);
        Some([c[2] - cu * c[0] - cv * c[1], cu, cv])
    } else {
        None
    };
    let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let (mut dmin, mut dmax) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in pts {
        bb = [bb[0].min(p[0]), bb[1].min(p[1]), bb[2].max(p[0]), bb[3].max(p[1])];
        dmin = dmin.min(p[2]);
        dmax = dmax.max(p[2]);
    }
    let convex = is_convex(&poly);
    Some(Prep { poly, bb, dmin, dmax, plane, convex })
}

fn is_convex(poly: &[[f64; 2]]) -> bool {
    let n = poly.len();
    let (mut pos, mut neg) = (false, false);
    for i in 0..n {
        let (a, b, c) = (poly[i], poly[(i + 1) % n], poly[(i + 2) % n]);
        let z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        pos |= z > 1e-12;
        neg |= z < -1e-12;
    }
    !(pos && neg)
}

fn inside_closed(p: [f64; 2], poly: &[[f64; 2]], tol: f64) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[j], poly[i]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (qx, qy) = (a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
        if qx * qx + qy * qy <= tol * tol {
            return true;
        }
        if (b[1] > p[1]) != (a[1] > p[1]) && p[0] < (a[0] - b[0]) * (p[1] - b[1]) / (a[1] - b[1]) + b[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Liegt `p` näher als `tol` an einer Kante des Rings?
fn near_edge(p: [f64; 2], poly: &[[f64; 2]], tol: f64) -> bool {
    (0..poly.len()).any(|i| {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (qx, qy) = (a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
        qx * qx + qy * qy <= tol * tol
    })
}

/// Polygon auf die Halbebene `h0 + hu·u + hv·v > 0` zuschneiden (Sutherland-Hodgman, auch nicht konvex).
fn clip_half(poly: &[[f64; 2]], h: [f64; 3]) -> Vec<[f64; 2]> {
    let f = |p: [f64; 2]| h[0] + h[1] * p[0] + h[2] * p[1];
    let mut out = Vec::with_capacity(poly.len() + 2);
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        let (fa, fb) = (f(a), f(b));
        if fa > 0.0 {
            out.push(a);
        }
        if (fa > 0.0) != (fb > 0.0) {
            let t = fa / (fa - fb);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    out
}

/// Ebene `d = c0 + cu·u + cv·v` der Fläche (`[c0, cu, cv]`); `None` auf der Kante oder bei Unsinn.
pub fn plane(pts: &[V3]) -> Option<[f64; 3]> {
    prepare(pts)?.plane
}

/// Sichtbare Teile jeder Fläche: `None` = ganz sichtbar (Umriss unverändert), sonst die sichtbaren Polygone
/// (Aussenring + Löcher; leer = ganz verdeckt). `eps`: erst so weit (m) vor einer Fläche verdeckt eine andere.
/// Flächen auf der Kante (ohne Ausdehnung in der Zeichenebene) verdecken nichts und bleiben `None`.
pub fn visible_regions(faces: &[Vec<V3>], eps: f64) -> Vec<Option<Vec<Polygon>>> {
    let prep: Vec<Option<Prep>> = faces.iter().map(|f| prepare(f)).collect();
    let occ: Vec<usize> = (0..faces.len()).filter(|&i| prep[i].as_ref().is_some_and(|p| p.plane.is_some())).collect();
    let mut out: Vec<Option<Vec<Polygon>>> = vec![None; faces.len()];
    if occ.len() < 2 {
        return out;
    }
    // 2D-Raster der Verdecker.
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for &i in &occ {
        let b = prep[i].as_ref().map(|p| p.bb).unwrap_or_default();
        lo = [lo[0].min(b[0]), lo[1].min(b[1])];
        hi = [hi[0].max(b[2]), hi[1].max(b[3])];
    }
    let side = ((occ.len() as f64).sqrt().ceil() as usize).clamp(1, 512);
    let cell = |x: f64, k: usize| -> usize {
        if !(hi[k] > lo[k]) {
            return 0;
        }
        let c = ((x - lo[k]) / (hi[k] - lo[k]) * side as f64).floor();
        if c.is_nan() { 0 } else { c.clamp(0.0, (side - 1) as f64) as usize }
    };
    let mut grid: Vec<Vec<u32>> = vec![Vec::new(); side * side];
    for &i in &occ {
        let b = prep[i].as_ref().map(|p| p.bb).unwrap_or_default();
        for y in cell(b[1], 1)..=cell(b[3], 1) {
            for x in cell(b[0], 0)..=cell(b[2], 0) {
                grid[y * side + x].push(i as u32);
            }
        }
    }
    let tol = 1e-7;
    let mut stamp = vec![u32::MAX; faces.len()];
    let mut clips: Vec<Polygon> = Vec::new();
    for &fi in &occ {
        let f = prep[fi].as_ref().expect("Fläche");
        let pf = f.plane.expect("Ebene");
        clips.clear();
        let mut hidden = false;
        'cells: for y in cell(f.bb[1], 1)..=cell(f.bb[3], 1) {
            for x in cell(f.bb[0], 0)..=cell(f.bb[2], 0) {
                for &gi in &grid[y * side + x] {
                    let gi = gi as usize;
                    if gi == fi || stamp[gi] == fi as u32 {
                        continue;
                    }
                    stamp[gi] = fi as u32;
                    let g = prep[gi].as_ref().expect("Verdecker");
                    // Überlappung mit Fläche (nicht nur am Rand) und überhaupt näher.
                    if g.bb[0] >= f.bb[2] - tol || g.bb[2] <= f.bb[0] + tol || g.bb[1] >= f.bb[3] - tol || g.bb[3] <= f.bb[1] + tol || g.dmin >= f.dmax - eps {
                        continue;
                    }
                    let pg = g.plane.expect("Ebene");
                    // Tiefendifferenz F − G (positiv: G liegt näher), linear; an den Ecken von G.
                    let h = [pf[0] - pg[0] - eps, pf[1] - pg[1], pf[2] - pg[2]];
                    let (mut hmin, mut hmax) = (f64::INFINITY, f64::NEG_INFINITY);
                    for q in &g.poly {
                        let v = h[0] + h[1] * q[0] + h[2] * q[1];
                        hmin = hmin.min(v);
                        hmax = hmax.max(v);
                    }
                    if hmax <= 0.0 {
                        continue;
                    }
                    if hmin > 0.0 {
                        // Ganz näher: deckt ein konvexer Verdecker die ganze Fläche, ist sie unsichtbar.
                        if g.convex && g.bb[0] <= f.bb[0] + tol && g.bb[1] <= f.bb[1] + tol && g.bb[2] >= f.bb[2] - tol && g.bb[3] >= f.bb[3] - tol && f.poly.iter().all(|q| inside_closed(*q, &g.poly, tol)) {
                            hidden = true;
                            break 'cells;
                        }
                        clips.push(vec![g.poly.clone()]);
                    } else {
                        let c = clip_half(&g.poly, h);
                        if c.len() >= 3 {
                            clips.push(vec![c]);
                        }
                    }
                }
            }
        }
        if hidden {
            out[fi] = Some(Vec::new());
        } else if !clips.is_empty() {
            let rest = crate::polygon_bool::difference(&[vec![f.poly.clone()]], &clips);
            // Haarfeine Reste (Rundung am Rand des Verdeckers) entfallen.
            let area = |r: &Vec<[f64; 2]>| r.iter().zip(r.iter().cycle().skip(1)).map(|(a, b)| a[0] * b[1] - b[0] * a[1]).sum::<f64>().abs() / 2.0;
            let whole = area(&f.poly);
            let rest: Vec<Polygon> = rest.into_iter().filter(|p| p.first().is_some_and(|r| area(r) > 1e-10)).collect();
            // Nichts weggeschnitten (Verdecker nur am Rand): Umriss unverändert lassen.
            let kept: f64 = rest.iter().map(|p| p.iter().enumerate().map(|(k, r)| if k == 0 { area(r) } else { -area(r) }).sum::<f64>()).sum();
            if !(rest.len() == 1 && rest[0].len() == 1 && (kept - whole).abs() <= 1e-9 * whole.max(1.0)) {
                out[fi] = Some(rest);
            }
        }
    }
    out
}

/// Teile der Strecke `a → b`, die in den Polygonen (Aussenring + Löcher, gerade/ungerade je Polygon) liegen.
pub fn clip_segment_to(a: [f64; 2], b: [f64; 2], polys: &[&Polygon]) -> Vec<([f64; 2], [f64; 2])> {
    let (du, dv) = (b[0] - a[0], b[1] - a[1]);
    let len = (du * du + dv * dv).sqrt();
    if !(len > 0.0) {
        return Vec::new();
    }
    let (umin, umax, vmin, vmax) = (a[0].min(b[0]), a[0].max(b[0]), a[1].min(b[1]), a[1].max(b[1]));
    let mut ivs: Vec<(f64, f64)> = Vec::new();
    let mut ts: Vec<f64> = Vec::new();
    for poly in polys {
        let Some(outer) = poly.first() else { continue };
        let bb = outer.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]);
        if bb[0] > umax + 1e-9 || bb[2] < umin - 1e-9 || bb[1] > vmax + 1e-9 || bb[3] < vmin - 1e-9 {
            continue;
        }
        ts.clear();
        ts.extend([0.0, 1.0]);
        for r in poly.iter() {
            for i in 0..r.len() {
                let (p, q) = (r[i], r[(i + 1) % r.len()]);
                let (ex, ey) = (q[0] - p[0], q[1] - p[1]);
                let den = du * ey - dv * ex;
                if den.abs() < 1e-18 {
                    continue;
                }
                let (wx, wy) = (p[0] - a[0], p[1] - a[1]);
                let t = (wx * ey - wy * ex) / den;
                let s = (wx * dv - wy * du) / den;
                if t > 0.0 && t < 1.0 && (-1e-9..=1.0 + 1e-9).contains(&s) {
                    ts.push(t);
                }
            }
        }
        ts.sort_by(f64::total_cmp);
        for w in ts.windows(2) {
            if w[1] - w[0] <= 1e-12 {
                continue;
            }
            let t = (w[0] + w[1]) / 2.0;
            let m = [a[0] + du * t, a[1] + dv * t];
            // Rand zählt dazu (Musterlinien enden auf dem Umriss ihrer Fläche).
            let tol = 1e-7;
            let mut inside = inside_closed(m, outer, tol);
            for h in poly.iter().skip(1) {
                // Im Loch nur echt innen (sein Rand gehört zur Fläche).
                if inside && inside_closed(m, h, 0.0) && !near_edge(m, h, tol) {
                    inside = false;
                }
            }
            if inside {
                ivs.push((w[0], w[1]));
            }
        }
    }
    ivs.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (s, e) in ivs {
        match merged.last_mut() {
            Some(l) if s <= l.1 + 1e-12 => l.1 = l.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    let min_t = 1e-6 / len;
    merged
        .into_iter()
        .filter(|(s, e)| e - s > min_t)
        .map(|(s, e)| ([a[0] + du * s, a[1] + dv * s], [a[0] + du * e, a[1] + dv * e]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(u0: f64, v0: f64, u1: f64, v1: f64, d: f64) -> Vec<V3> {
        vec![[u0, v0, d], [u1, v0, d], [u1, v1, d], [u0, v1, d]]
    }
    fn area(polys: &[Polygon]) -> f64 {
        let a = |r: &Vec<[f64; 2]>| r.iter().zip(r.iter().cycle().skip(1)).map(|(a, b)| a[0] * b[1] - b[0] * a[1]).sum::<f64>().abs() / 2.0;
        polys.iter().map(|p| p.iter().enumerate().map(|(k, r)| if k == 0 { a(r) } else { -a(r) }).sum::<f64>()).sum()
    }

    #[test]
    fn verdeckt_teilweise_ganz_und_gar_nicht() {
        // Hinten 0…4 × 0…2 bei d = 5, davor 1…2 × 0…1 bei d = 1 (Loch am Rand), davor ganz deckend 10…12 bei d = 1
        // über 10.5…11.5 bei d = 3; daneben frei.
        let f = vec![rect(0.0, 0.0, 4.0, 2.0, 5.0), rect(1.0, 0.0, 2.0, 1.0, 1.0), rect(10.0, 0.0, 12.0, 2.0, 1.0), rect(10.5, 0.5, 11.5, 1.5, 3.0), rect(20.0, 0.0, 21.0, 1.0, 1.0)];
        let r = visible_regions(&f, 1e-5);
        assert!((area(r[0].as_ref().unwrap()) - 7.0).abs() < 1e-6);
        assert!(r[1].is_none() && r[2].is_none() && r[4].is_none());
        assert_eq!(r[3].as_ref().map(|v| v.len()), Some(0));
    }

    #[test]
    fn durchdringende_flaechen_je_zur_haelfte() {
        // Zwei Scheiben, die sich bei u = 1 durchdringen: links liegt A vorn, rechts B.
        let a = vec![[0.0, 0.0, 1.0], [2.0, 0.0, 3.0], [2.0, 1.0, 3.0], [0.0, 1.0, 1.0]];
        let b = vec![[0.0, 0.0, 3.0], [2.0, 0.0, 1.0], [2.0, 1.0, 1.0], [0.0, 1.0, 3.0]];
        let r = visible_regions(&[a, b], 1e-5);
        for k in 0..2 {
            let v = r[k].as_ref().unwrap();
            assert!((area(v) - 1.0).abs() < 1e-4, "{k}: {v:?}");
            let cx = v[0][0].iter().map(|q| q[0]).sum::<f64>() / v[0][0].len() as f64;
            assert!(if k == 0 { cx < 1.0 } else { cx > 1.0 }, "{k}: {v:?}");
        }
    }

    #[test]
    fn gleiche_tiefe_verdeckt_nicht() {
        let f = vec![rect(0.0, 0.0, 2.0, 1.0, 1.0), rect(1.0, 0.0, 3.0, 1.0, 1.0)];
        let r = visible_regions(&f, 1e-5);
        assert!(r[0].is_none() && r[1].is_none());
    }

    #[test]
    fn strecke_im_polygon_mit_loch() {
        let p: Polygon = vec![vec![[0.0, 0.0], [4.0, 0.0], [4.0, 2.0], [0.0, 2.0]], vec![[1.0, 0.5], [1.0, 1.5], [2.0, 1.5], [2.0, 0.5]]];
        let s = clip_segment_to([-1.0, 1.0], [5.0, 1.0], &[&p]);
        assert_eq!(s.len(), 2, "{s:?}");
        assert!((s[0].0[0] - 0.0).abs() < 1e-9 && (s[0].1[0] - 1.0).abs() < 1e-9 && (s[1].0[0] - 2.0).abs() < 1e-9 && (s[1].1[0] - 4.0).abs() < 1e-9);
    }

    #[test]
    fn unsinn_ohne_panik() {
        let r = visible_regions(&[vec![[f64::NAN, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0]], vec![], rect(0.0, 0.0, 1.0, 1.0, 2.0)], 1e-5);
        assert!(r.iter().all(|x| x.is_none()));
        assert!(clip_segment_to([0.0, 0.0], [0.0, 0.0], &[]).is_empty());
    }
}
