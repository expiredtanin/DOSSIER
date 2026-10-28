//! Delaunay-Triangulierung ([K1]): Port von `delaunator` 5.1.0 (Volodymyr Agafonkin / Mapbox, ISC-Lizenz,
//! https://github.com/mapbox/delaunator) samt exaktem
//! `orient2d` (robust-predicates). Dieselbe Reihenfolge der Schritte wie in JS, damit Dreiecke und
//! deren Indizes bitgleich herauskommen — auch bei kozirkulären Punkten (Raster). Verwendet vom
//! Gelände-TIN (`model/terrain.ts`) und den Kontext-Gebäuden (`io/geoContext.ts`).
//!
//! `triangulate(coords)` mit `coords = [x0, y0, x1, y1 …]` → Dreiecks-Indizes (je drei, gegen den
//! Uhrzeigersinn); leer bei < 3 Punkten, nur kollinearen Punkten oder nicht endlichen Werten.

const EPSILON: f64 = 1.0 / 4503599627370496.0; // 2^-52
const EDGE_STACK_LEN: usize = 512;

// ── exaktes orient2d ───────────────────────────────────────────────────────

fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let x = a + b;
    let bv = x - a;
    let av = x - bv;
    (x, (a - av) + (b - bv))
}

fn two_product(a: f64, b: f64) -> (f64, f64) {
    let x = a * b;
    (x, a.mul_add(b, -x))
}

/// Summe einer Expansion (aufsteigend, nicht überlappend) und eines Doubles.
fn grow(e: &[f64], b: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity(e.len() + 1);
    let mut q = b;
    for &x in e {
        let (s, t) = two_sum(q, x);
        q = s;
        if t != 0.0 {
            out.push(t);
        }
    }
    if q != 0.0 || out.is_empty() {
        out.push(q);
    }
    out
}

fn scale(e: &[f64], b: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity(2 * e.len());
    let (mut q, h) = two_product(e[0], b);
    if h != 0.0 {
        out.push(h);
    }
    for &x in &e[1..] {
        let (p1, p0) = two_product(x, b);
        let (sum, h) = two_sum(q, p0);
        if h != 0.0 {
            out.push(h);
        }
        let (q2, h2) = two_sum(p1, sum);
        q = q2;
        if h2 != 0.0 {
            out.push(h2);
        }
    }
    if q != 0.0 || out.is_empty() {
        out.push(q);
    }
    out
}

fn sum(e: &[f64], f: &[f64]) -> Vec<f64> {
    let mut out = e.to_vec();
    for &x in f {
        out = grow(&out, x);
    }
    out
}

fn estimate_sign(e: &[f64]) -> f64 {
    for &x in e.iter().rev() {
        if x != 0.0 {
            return x;
        }
    }
    0.0
}

/// Wie `orient2d` aus `robust-predicates`: Vorzeichen exakt (negativ, wenn a, b, c gegen den
/// Uhrzeigersinn liegen — Konvention dieses Pakets), Betrag nur die schnelle Näherung.
pub fn orient2d(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
    const EPS: f64 = 1.1102230246251565e-16; // 2^-53
    const CCW_ERR_BOUND_A: f64 = (3.0 + 16.0 * EPS) * EPS;
    let detleft = (ay - cy) * (bx - cx);
    let detright = (ax - cx) * (by - cy);
    let det = detleft - detright;
    let detsum = (detleft + detright).abs();
    if det.abs() >= CCW_ERR_BOUND_A * detsum {
        return det;
    }
    // exakt: (ay-cy)(bx-cx) - (ax-cx)(by-cy); jede Differenz als 2-Term-Expansion
    let (acx, acx_t) = two_sum(ax, -cx);
    let (bcx, bcx_t) = two_sum(bx, -cx);
    let (acy, acy_t) = two_sum(ay, -cy);
    let (bcy, bcy_t) = two_sum(by, -cy);
    let prod = |a: &[f64; 2], b: &[f64; 2]| -> Vec<f64> { sum(&scale(a, b[0]), &scale(a, b[1])) };
    let left = prod(&[acy_t, acy], &[bcx_t, bcx]);
    let right = prod(&[acx_t, acx], &[bcy_t, bcy]);
    let neg: Vec<f64> = right.iter().map(|v| -v).collect();
    estimate_sign(&sum(&left, &neg))
}

// ── Delaunator ─────────────────────────────────────────────────────────────

fn dist(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = ax - bx;
    let dy = ay - by;
    dx * dx + dy * dy
}

fn in_circle(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, px: f64, py: f64) -> bool {
    let dx = ax - px;
    let dy = ay - py;
    let ex = bx - px;
    let ey = by - py;
    let fx = cx - px;
    let fy = cy - py;
    let ap = dx * dx + dy * dy;
    let bp = ex * ex + ey * ey;
    let cp = fx * fx + fy * fy;
    dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0.0
}

fn circumradius(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let ex = cx - ax;
    let ey = cy - ay;
    let bl = dx * dx + dy * dy;
    let cl = ex * ex + ey * ey;
    let d = 0.5 / (dx * ey - dy * ex);
    let x = (ey * bl - dy * cl) * d;
    let y = (dx * cl - ex * bl) * d;
    x * x + y * y
}

fn circumcenter(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> (f64, f64) {
    let dx = bx - ax;
    let dy = by - ay;
    let ex = cx - ax;
    let ey = cy - ay;
    let bl = dx * dx + dy * dy;
    let cl = ex * ex + ey * ey;
    let d = 0.5 / (dx * ey - dy * ex);
    (ax + (ey * bl - dy * cl) * d, ay + (dx * cl - ex * bl) * d)
}

fn pseudo_angle(dx: f64, dy: f64) -> f64 {
    let p = dx / (dx.abs() + dy.abs());
    (if dy > 0.0 { 3.0 - p } else { 1.0 + p }) / 4.0
}

fn quicksort(ids: &mut [u32], dists: &[f64], left: isize, right: isize) {
    if right - left <= 20 {
        for i in left + 1..=right {
            let temp = ids[i as usize];
            let temp_dist = dists[temp as usize];
            let mut j = i - 1;
            while j >= left && dists[ids[j as usize] as usize] > temp_dist {
                ids[(j + 1) as usize] = ids[j as usize];
                j -= 1;
            }
            ids[(j + 1) as usize] = temp;
        }
    } else {
        let median = (left + right) >> 1;
        let mut i = left + 1;
        let mut j = right;
        ids.swap(median as usize, i as usize);
        if dists[ids[left as usize] as usize] > dists[ids[right as usize] as usize] {
            ids.swap(left as usize, right as usize);
        }
        if dists[ids[i as usize] as usize] > dists[ids[right as usize] as usize] {
            ids.swap(i as usize, right as usize);
        }
        if dists[ids[left as usize] as usize] > dists[ids[i as usize] as usize] {
            ids.swap(left as usize, i as usize);
        }
        let temp = ids[i as usize];
        let temp_dist = dists[temp as usize];
        loop {
            loop {
                i += 1;
                if !(dists[ids[i as usize] as usize] < temp_dist) {
                    break;
                }
            }
            loop {
                j -= 1;
                if !(dists[ids[j as usize] as usize] > temp_dist) {
                    break;
                }
            }
            if j < i {
                break;
            }
            ids.swap(i as usize, j as usize);
        }
        ids[(left + 1) as usize] = ids[j as usize];
        ids[j as usize] = temp;
        if right - i + 1 >= j - left {
            quicksort(ids, dists, i, right);
            quicksort(ids, dists, left, j - 1);
        } else {
            quicksort(ids, dists, left, j - 1);
            quicksort(ids, dists, i, right);
        }
    }
}

struct State<'a> {
    coords: &'a [f64],
    triangles: Vec<u32>,
    halfedges: Vec<i32>,
    hull_prev: Vec<u32>,
    hull_tri: Vec<u32>,
    hull_start: usize,
    edge_stack: [u32; EDGE_STACK_LEN],
}

impl State<'_> {
    fn link(&mut self, a: usize, b: i32) {
        self.halfedges[a] = b;
        if b != -1 {
            self.halfedges[b as usize] = a as i32;
        }
    }

    fn add_triangle(&mut self, i0: u32, i1: u32, i2: u32, a: i32, b: i32, c: i32) -> usize {
        let t = self.triangles.len();
        self.triangles.extend([i0, i1, i2]);
        self.halfedges.extend([-1, -1, -1]);
        self.link(t, a);
        self.link(t + 1, b);
        self.link(t + 2, c);
        t
    }

    fn legalize(&mut self, a_in: usize) -> usize {
        let mut a = a_in;
        let mut i = 0usize;
        let mut ar;
        loop {
            let b = self.halfedges[a];
            let a0 = a - a % 3;
            ar = a0 + (a + 2) % 3;
            if b == -1 {
                if i == 0 {
                    break;
                }
                i -= 1;
                a = self.edge_stack[i] as usize;
                continue;
            }
            let b = b as usize;
            let b0 = b - b % 3;
            let al = a0 + (a + 1) % 3;
            let bl = b0 + (b + 2) % 3;
            let p0 = self.triangles[ar] as usize;
            let pr = self.triangles[a] as usize;
            let pl = self.triangles[al] as usize;
            let p1 = self.triangles[bl] as usize;
            let c = self.coords;
            let illegal = in_circle(
                c[2 * p0], c[2 * p0 + 1], c[2 * pr], c[2 * pr + 1], c[2 * pl], c[2 * pl + 1], c[2 * p1], c[2 * p1 + 1],
            );
            if illegal {
                self.triangles[a] = p1 as u32;
                self.triangles[b] = p0 as u32;
                let hbl = self.halfedges[bl];
                if hbl == -1 {
                    let mut e = self.hull_start;
                    loop {
                        if self.hull_tri[e] as usize == bl {
                            self.hull_tri[e] = a as u32;
                            break;
                        }
                        e = self.hull_prev[e] as usize;
                        if e == self.hull_start {
                            break;
                        }
                    }
                }
                self.link(a, hbl);
                let har = self.halfedges[ar];
                self.link(b, har);
                self.link(ar, bl as i32);
                let br = b0 + (b + 1) % 3;
                if i < EDGE_STACK_LEN {
                    self.edge_stack[i] = br as u32;
                    i += 1;
                }
            } else {
                if i == 0 {
                    break;
                }
                i -= 1;
                a = self.edge_stack[i] as usize;
            }
        }
        ar
    }
}

pub fn triangulate(coords: &[f64]) -> Vec<u32> {
    let n = coords.len() >> 1;
    if n < 3 || coords.len() != 2 * n || coords.iter().any(|v| !v.is_finite()) {
        return Vec::new();
    }
    let max_triangles = if n * 2 >= 5 { 2 * n - 5 } else { 0 };
    let hash_size = (n as f64).sqrt().ceil() as usize;
    let mut hull_next = vec![0u32; n];
    let mut hull_hash = vec![-1i32; hash_size];
    let mut st = State {
        coords,
        triangles: Vec::with_capacity(max_triangles * 3),
        halfedges: Vec::with_capacity(max_triangles * 3),
        hull_prev: vec![0u32; n],
        hull_tri: vec![0u32; n],
        hull_start: 0,
        edge_stack: [0; EDGE_STACK_LEN],
    };
    let mut ids: Vec<u32> = (0..n as u32).collect();
    let mut dists = vec![0.0f64; n];

    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for i in 0..n {
        let x = coords[2 * i];
        let y = coords[2 * i + 1];
        if x < min_x {
            min_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if x > max_x {
            max_x = x;
        }
        if y > max_y {
            max_y = y;
        }
    }
    let cx = (min_x + max_x) / 2.0;
    let cy = (min_y + max_y) / 2.0;

    let (mut i0, mut i1, mut i2) = (0usize, 0usize, 0usize);
    let mut min_dist = f64::INFINITY;
    for i in 0..n {
        let d = dist(cx, cy, coords[2 * i], coords[2 * i + 1]);
        if d < min_dist {
            i0 = i;
            min_dist = d;
        }
    }
    let i0x = coords[2 * i0];
    let i0y = coords[2 * i0 + 1];
    let mut min_dist = f64::INFINITY;
    for i in 0..n {
        if i == i0 {
            continue;
        }
        let d = dist(i0x, i0y, coords[2 * i], coords[2 * i + 1]);
        if d < min_dist && d > 0.0 {
            i1 = i;
            min_dist = d;
        }
    }
    let mut i1x = coords[2 * i1];
    let mut i1y = coords[2 * i1 + 1];
    let mut min_radius = f64::INFINITY;
    for i in 0..n {
        if i == i0 || i == i1 {
            continue;
        }
        let r = circumradius(i0x, i0y, i1x, i1y, coords[2 * i], coords[2 * i + 1]);
        if r < min_radius {
            i2 = i;
            min_radius = r;
        }
    }
    let mut i2x = coords[2 * i2];
    let mut i2y = coords[2 * i2 + 1];
    if min_radius == f64::INFINITY {
        return Vec::new(); // alle Punkte kollinear: keine Dreiecke
    }
    if orient2d(i0x, i0y, i1x, i1y, i2x, i2y) < 0.0 {
        std::mem::swap(&mut i1, &mut i2);
        std::mem::swap(&mut i1x, &mut i2x);
        std::mem::swap(&mut i1y, &mut i2y);
    }
    let (ccx, ccy) = circumcenter(i0x, i0y, i1x, i1y, i2x, i2y);
    for i in 0..n {
        dists[i] = dist(coords[2 * i], coords[2 * i + 1], ccx, ccy);
    }
    quicksort(&mut ids, &dists, 0, n as isize - 1);

    let hash_key = |x: f64, y: f64| -> usize {
        let v = (pseudo_angle(x - ccx, y - ccy) * hash_size as f64).floor();
        if v.is_nan() {
            0
        } else {
            (v as i64).rem_euclid(hash_size as i64) as usize
        }
    };

    st.hull_start = i0;
    hull_next[i0] = i1 as u32;
    st.hull_prev[i2] = i1 as u32;
    hull_next[i1] = i2 as u32;
    st.hull_prev[i0] = i2 as u32;
    hull_next[i2] = i0 as u32;
    st.hull_prev[i1] = i0 as u32;
    st.hull_tri[i0] = 0;
    st.hull_tri[i1] = 1;
    st.hull_tri[i2] = 2;
    hull_hash[hash_key(i0x, i0y)] = i0 as i32;
    hull_hash[hash_key(i1x, i1y)] = i1 as i32;
    hull_hash[hash_key(i2x, i2y)] = i2 as i32;
    st.add_triangle(i0 as u32, i1 as u32, i2 as u32, -1, -1, -1);

    let (mut xp, mut yp) = (0.0f64, 0.0f64);
    for k in 0..n {
        let i = ids[k] as usize;
        let x = coords[2 * i];
        let y = coords[2 * i + 1];
        if k > 0 && (x - xp).abs() <= EPSILON && (y - yp).abs() <= EPSILON {
            continue;
        }
        xp = x;
        yp = y;
        if i == i0 || i == i1 || i == i2 {
            continue;
        }
        let mut start = 0usize;
        let key = hash_key(x, y);
        for j in 0..hash_size {
            let s = hull_hash[(key + j) % hash_size];
            start = if s < 0 { usize::MAX } else { s as usize };
            if s != -1 && start != hull_next[start] as usize {
                break;
            }
        }
        if start == usize::MAX {
            continue;
        }
        start = st.hull_prev[start] as usize;
        let mut e = start;
        let mut found = true;
        loop {
            let q = hull_next[e] as usize;
            if orient2d(x, y, coords[2 * e], coords[2 * e + 1], coords[2 * q], coords[2 * q + 1]) >= 0.0 {
                e = q;
                if e == start {
                    found = false;
                    break;
                }
            } else {
                break;
            }
        }
        if !found {
            continue;
        }
        let mut t = st.add_triangle(e as u32, i as u32, hull_next[e], -1, -1, st.hull_tri[e] as i32);
        st.hull_tri[i] = st.legalize(t + 2) as u32;
        st.hull_tri[e] = t as u32;

        let mut nn = hull_next[e] as usize;
        loop {
            let q = hull_next[nn] as usize;
            if orient2d(x, y, coords[2 * nn], coords[2 * nn + 1], coords[2 * q], coords[2 * q + 1]) < 0.0 {
                t = st.add_triangle(nn as u32, i as u32, q as u32, st.hull_tri[i] as i32, -1, st.hull_tri[nn] as i32);
                st.hull_tri[i] = st.legalize(t + 2) as u32;
                hull_next[nn] = nn as u32;
                nn = q;
            } else {
                break;
            }
        }
        if e == start {
            loop {
                let q = st.hull_prev[e] as usize;
                if orient2d(x, y, coords[2 * q], coords[2 * q + 1], coords[2 * e], coords[2 * e + 1]) < 0.0 {
                    t = st.add_triangle(q as u32, i as u32, e as u32, -1, st.hull_tri[e] as i32, st.hull_tri[q] as i32);
                    st.legalize(t + 2);
                    st.hull_tri[q] = t as u32;
                    hull_next[e] = e as u32;
                        e = q;
                } else {
                    break;
                }
            }
        }
        st.hull_start = e;
        st.hull_prev[i] = e as u32;
        hull_next[e] = i as u32;
        st.hull_prev[nn] = i as u32;
        hull_next[i] = nn as u32;
        hull_hash[hash_key(x, y)] = i as i32;
        hull_hash[hash_key(coords[2 * e], coords[2 * e + 1])] = e as i32;
    }
    st.triangles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quadrat_ergibt_zwei_dreiecke() {
        let t = triangulate(&[0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]);
        assert_eq!(t.len(), 6);
    }

    #[test]
    fn kollinear_und_zu_wenig_sind_leer() {
        assert!(triangulate(&[0.0, 0.0, 1.0, 1.0, 2.0, 2.0]).is_empty());
        assert!(triangulate(&[0.0, 0.0, 1.0, 1.0]).is_empty());
        assert!(triangulate(&[0.0, f64::NAN, 1.0, 1.0, 2.0, 5.0]).is_empty());
    }

    #[test]
    fn orient_ist_exakt() {
        // fast kollinear: nur mit exakter Arithmetik korrekt
        let a = (0.5, 0.5);
        let b = (12.0, 12.0);
        let c = (24.0, 24.0);
        assert_eq!(orient2d(a.0, a.1, b.0, b.1, c.0, c.1), 0.0);
        assert!(orient2d(0.0, 0.0, 1.0, 0.0, 0.0, 1.0) < 0.0);
        assert!(orient2d(0.0, 0.0, 0.0, 1.0, 1.0, 0.0) > 0.0);
    }
}
