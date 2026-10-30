//! Gelände ([T6]): TIN aus Höhenlinien mit Bruchkanten, Glättung ohne Überschwingen, Höhenlinien,
//! Höhenabfrage und Gelände-Prisma.
//!
//!  • Bruchkanten: die Konturen werden auf `max_edge` verdichtet, über `delaunay.rs` trianguliert und
//!    fehlende Kontur-Kanten per Kantentausch erzwungen (Sloan 1993, constrained Delaunay); danach
//!    Lawson-Tausch nur an freien Kanten. So schneidet kein Dreieck eine Höhenlinie.
//!  • Flache Dreiecke (alle drei Ecken auf derselben Höhenlinie, Kuppen/Mulden/Talböden) bekommen einen
//!    Schwerpunkt, dessen Höhe aus den Eckgradienten extrapoliert und auf ±0.45·Äquidistanz begrenzt
//!    wird — so entstehen keine neuen Höhenlinien.
//!  • Glättung: adaptive Kantenteilung (1→2/3/4 je Dreieck, rissfrei) mit Hermite-Mittelpunkt aus den
//!    Eckgradienten (kleinste Quadrate über den 1-Ring). Ohne Überschwingen: der Mittelpunkt bleibt im
//!    Höhenbereich der Kantenenden (gleiche Höhen: ±0.45·Äquidistanz); Kontur-Kanten bleiben exakt.
//!    Geteilt wird, wo die Abweichung zur linearen Fläche > `tol` oder die Kante > `max_edge` ist.
//!
//! Höhen sind Rohwerte des Netzes (bei swissALTI3D/DXF meist m ü. M.); den Bezug zum Modell (±0.00)
//! liefert [`datum`].

use crate::delaunay::{orient2d, triangulate};
use std::collections::{HashMap, HashSet, VecDeque};

pub type P2 = [f64; 2];

/// Dreiecksnetz (2.5D): Lage, Höhe, Dreiecke gegen den Uhrzeigersinn.
#[derive(Clone, Debug, Default)]
pub struct Tin {
    pub xy: Vec<P2>,
    pub z: Vec<f64>,
    pub tris: Vec<[u32; 3]>,
}

/// Positiv, wenn a, b, c gegen den Uhrzeigersinn liegen (Vorzeichen exakt).
pub fn orient(a: P2, b: P2, c: P2) -> f64 {
    -orient2d(a[0], a[1], b[0], b[1], c[0], c[1])
}

fn key(a: u32, b: u32) -> (u32, u32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

fn dist(a: P2, b: P2) -> f64 {
    (b[0] - a[0]).hypot(b[1] - a[1])
}

impl Tin {
    pub fn from_flat(positions: &[f64], indices: &[f64]) -> Tin {
        let n = positions.len() / 3;
        let mut t = Tin { xy: Vec::with_capacity(n), z: Vec::with_capacity(n), tris: Vec::new() };
        for i in 0..n {
            t.xy.push([positions[3 * i], positions[3 * i + 1]]);
            t.z.push(positions[3 * i + 2]);
        }
        for c in indices.chunks_exact(3) {
            let v = [c[0] as usize, c[1] as usize, c[2] as usize];
            if v.iter().any(|&i| i >= n) || !c.iter().all(|x| x.is_finite() && *x >= 0.0) {
                continue;
            }
            let (a, b, cc) = (t.xy[v[0]], t.xy[v[1]], t.xy[v[2]]);
            if !(a.iter().chain(&b).chain(&cc).all(|x| x.is_finite())) {
                continue;
            }
            let o = orient(a, b, cc);
            if o > 0.0 {
                t.tris.push([v[0] as u32, v[1] as u32, v[2] as u32]);
            } else if o < 0.0 {
                t.tris.push([v[0] as u32, v[2] as u32, v[1] as u32]);
            }
        }
        t
    }

    /// Flache Arrays (x, y, z …) und Indizes; `dz` wird zu jeder Höhe addiert.
    pub fn to_flat(&self, dz: f64) -> (Vec<f64>, Vec<f64>) {
        let mut pos = Vec::with_capacity(self.z.len() * 3);
        for (p, z) in self.xy.iter().zip(&self.z) {
            pos.extend([p[0], p[1], z + dz]);
        }
        (pos, self.tris.iter().flat_map(|t| t.iter().map(|&i| i as f64)).collect())
    }

    pub fn z_range(&self) -> (f64, f64) {
        self.z.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &z| (a.min(z), b.max(z)))
    }

    pub fn bbox(&self) -> [f64; 4] {
        let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in &self.xy {
            b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
        }
        b
    }
}

// ── Höhenabfrage ─────────────────────────────────────────────────────────────

/// Raster-Index der Dreiecke für Punktabfragen.
pub struct TinIndex<'a> {
    pub tin: &'a Tin,
    b: [f64; 4],
    cell: f64,
    nx: usize,
    ny: usize,
    cells: Vec<Vec<u32>>,
}

impl<'a> TinIndex<'a> {
    pub fn new(tin: &'a Tin) -> TinIndex<'a> {
        let b = tin.bbox();
        let n = tin.tris.len().max(1) as f64;
        let (w, h) = ((b[2] - b[0]).max(1e-9), (b[3] - b[1]).max(1e-9));
        let cell = if b[0].is_finite() { (w * h / n).sqrt().max(1e-6) * 1.5 } else { 1.0 };
        let nx = if b[0].is_finite() { ((w / cell) as usize + 1).min(4096) } else { 1 };
        let ny = if b[0].is_finite() { ((h / cell) as usize + 1).min(4096) } else { 1 };
        let cell_x = w / nx as f64;
        let cell = cell_x.max(h / ny as f64);
        let mut cells = vec![Vec::new(); nx * ny];
        let mut s = TinIndex { tin, b, cell, nx, ny, cells: Vec::new() };
        for (ti, t) in tin.tris.iter().enumerate() {
            let p = t.map(|i| tin.xy[i as usize]);
            let (x0, x1) = (p[0][0].min(p[1][0]).min(p[2][0]), p[0][0].max(p[1][0]).max(p[2][0]));
            let (y0, y1) = (p[0][1].min(p[1][1]).min(p[2][1]), p[0][1].max(p[1][1]).max(p[2][1]));
            let (i0, j0) = s.cell_of(x0, y0);
            let (i1, j1) = s.cell_of(x1, y1);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    cells[j * nx + i].push(ti as u32);
                }
            }
        }
        s.cells = cells;
        s
    }

    fn cell_of(&self, x: f64, y: f64) -> (usize, usize) {
        let i = ((x - self.b[0]) / self.cell).floor().max(0.0) as usize;
        let j = ((y - self.b[1]) / self.cell).floor().max(0.0) as usize;
        (i.min(self.nx - 1), j.min(self.ny - 1))
    }

    /// Höhe am Punkt (x, y); `None` ausserhalb des Netzes.
    pub fn z_at(&self, x: f64, y: f64) -> Option<f64> {
        if !(x >= self.b[0] - 1e-9 && x <= self.b[2] + 1e-9 && y >= self.b[1] - 1e-9 && y <= self.b[3] + 1e-9) {
            return None;
        }
        let (i, j) = self.cell_of(x, y);
        let t = self.tin;
        for &ti in &self.cells[j * self.nx + i] {
            let [a, b, c] = t.tris[ti as usize].map(|k| k as usize);
            let (pa, pb, pc) = (t.xy[a], t.xy[b], t.xy[c]);
            let d = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
            if d.abs() < 1e-300 {
                continue;
            }
            let l1 = ((x - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (y - pa[1])) / d;
            let l2 = ((pb[0] - pa[0]) * (y - pa[1]) - (x - pa[0]) * (pb[1] - pa[1])) / d;
            let l0 = 1.0 - l1 - l2;
            const E: f64 = -1e-9;
            if l0 >= E && l1 >= E && l2 >= E {
                return Some(l0 * t.z[a] + l1 * t.z[b] + l2 * t.z[c]);
            }
        }
        None
    }
}

// ── Constrained Delaunay ─────────────────────────────────────────────────────

struct Cdt {
    xy: Vec<P2>,
    tris: Vec<[u32; 3]>,
    alive: Vec<bool>,
    /// gerichtete Kante → Dreieck
    edge: HashMap<(u32, u32), usize>,
    /// Ecke → ein anliegendes Dreieck
    vt: Vec<usize>,
    fixed: HashSet<(u32, u32)>,
}

impl Cdt {
    fn new(xy: Vec<P2>) -> Option<Cdt> {
        let coords: Vec<f64> = xy.iter().flat_map(|p| [p[0], p[1]]).collect();
        let raw = triangulate(&coords);
        if raw.is_empty() {
            return None;
        }
        let mut c = Cdt { vt: vec![usize::MAX; xy.len()], xy, tris: Vec::new(), alive: Vec::new(), edge: HashMap::new(), fixed: HashSet::new() };
        // delaunator liefert alle Dreiecke gleich orientiert; kollineare Splitter (Fläche 0) bleiben,
        // sonst entstünden Löcher in der Nachbarschaft — sie folgen der gemeinsamen Orientierung.
        let flip = raw.chunks_exact(3).map(|t| orient(c.xy[t[0] as usize], c.xy[t[1] as usize], c.xy[t[2] as usize])).find(|o| *o != 0.0).is_some_and(|o| o < 0.0);
        for t in raw.chunks_exact(3) {
            c.push(if flip { [t[0], t[2], t[1]] } else { [t[0], t[1], t[2]] });
        }
        Some(c)
    }

    fn push(&mut self, v: [u32; 3]) -> usize {
        let i = self.tris.len();
        self.tris.push(v);
        self.alive.push(true);
        self.link(i);
        i
    }

    fn link(&mut self, i: usize) {
        let v = self.tris[i];
        for k in 0..3 {
            self.edge.insert((v[k], v[(k + 1) % 3]), i);
            self.vt[v[k] as usize] = i;
        }
    }

    fn unlink(&mut self, i: usize) {
        let v = self.tris[i];
        for k in 0..3 {
            if self.edge.get(&(v[k], v[(k + 1) % 3])) == Some(&i) {
                self.edge.remove(&(v[k], v[(k + 1) % 3]));
            }
        }
    }

    fn third(&self, t: usize, a: u32, b: u32) -> u32 {
        let v = self.tris[t];
        *v.iter().find(|&&x| x != a && x != b).unwrap_or(&v[0])
    }

    fn has_edge(&self, a: u32, b: u32) -> bool {
        self.edge.contains_key(&(a, b)) || self.edge.contains_key(&(b, a))
    }

    /// Tauscht die Diagonale a–b (beide Seiten vorhanden, Viereck konvex — vom Aufrufer geprüft).
    fn flip(&mut self, a: u32, b: u32) -> Option<(u32, u32)> {
        let t1 = *self.edge.get(&(a, b))?;
        let t2 = *self.edge.get(&(b, a))?;
        let c = self.third(t1, a, b);
        let d = self.third(t2, b, a);
        self.unlink(t1);
        self.unlink(t2);
        self.tris[t1] = [a, d, c];
        self.tris[t2] = [d, b, c];
        self.link(t1);
        self.link(t2);
        Some((c, d))
    }

    fn convex(&self, a: u32, b: u32, c: u32, d: u32) -> bool {
        let p = |i: u32| self.xy[i as usize];
        let (o1, o2) = (orient(p(c), p(d), p(a)), orient(p(c), p(d), p(b)));
        (o1 > 0.0 && o2 < 0.0) || (o1 < 0.0 && o2 > 0.0)
    }

    fn quad(&self, a: u32, b: u32) -> Option<(u32, u32)> {
        let t1 = *self.edge.get(&(a, b))?;
        let t2 = *self.edge.get(&(b, a))?;
        Some((self.third(t1, a, b), self.third(t2, b, a)))
    }

    /// Dreiecke um die Ecke `a`.
    fn around(&self, a: u32) -> Vec<usize> {
        let start = self.vt[a as usize];
        if start == usize::MAX || !self.alive[start] {
            return Vec::new();
        }
        let mut out = vec![start];
        // gegen den Uhrzeigersinn: über die Kante (a, q) des Dreiecks (a, p, q) zum Nachbarn mit (q, a)…
        for dir in 0..2 {
            let mut t = start;
            loop {
                let v = self.tris[t];
                let k = v.iter().position(|&x| x == a).unwrap_or(0);
                let (p, q) = (v[(k + 1) % 3], v[(k + 2) % 3]);
                let next = if dir == 0 { self.edge.get(&(a, q)) } else { self.edge.get(&(p, a)) };
                match next {
                    Some(&n) if n != start => {
                        if out.contains(&n) {
                            break;
                        }
                        out.push(n);
                        t = n;
                    }
                    _ => break,
                }
                if out.len() > 4096 {
                    break;
                }
            }
        }
        out
    }

    /// Kanten, welche die Strecke a–b kreuzen; `Err(Some(v))`, wenn die Ecke v auf der Strecke liegt.
    fn crossings(&self, a: u32, b: u32) -> Result<Vec<(u32, u32)>, Option<u32>> {
        let p = |i: u32| self.xy[i as usize];
        let (pa, pb) = (p(a), p(b));
        let on_seg = |v: u32| {
            let q = p(v);
            orient(pa, pb, q) == 0.0 && (q[0] - pa[0]) * (pb[0] - pa[0]) + (q[1] - pa[1]) * (pb[1] - pa[1]) > 0.0 && dist(pa, q) < dist(pa, pb)
        };
        let mut first = None;
        for t in self.around(a) {
            let v = self.tris[t];
            let k = v.iter().position(|&x| x == a).unwrap_or(0);
            let (q1, q2) = (v[(k + 1) % 3], v[(k + 2) % 3]);
            if on_seg(q1) {
                return Err(Some(q1));
            }
            if on_seg(q2) {
                return Err(Some(q2));
            }
            if orient(pa, p(q1), pb) > 0.0 && orient(pa, p(q2), pb) < 0.0 {
                first = Some((q1, q2));
                break;
            }
        }
        let Some((mut x, mut y)) = first else { return Err(None) };
        let mut out = Vec::new();
        for _ in 0..100_000 {
            out.push((x, y));
            let Some(&n) = self.edge.get(&(y, x)) else { return Err(None) };
            let r = self.third(n, y, x);
            if r == b {
                return Ok(out);
            }
            let o = orient(pa, pb, p(r));
            if o == 0.0 {
                return Err(Some(r));
            }
            if (o > 0.0) == (orient(pa, pb, p(x)) > 0.0) {
                x = r;
            } else {
                y = r;
            }
        }
        Err(None)
    }

    fn proper_cross(&self, a: u32, b: u32, c: u32, d: u32) -> bool {
        if c == a || c == b || d == a || d == b {
            return false;
        }
        let p = |i: u32| self.xy[i as usize];
        let (o1, o2) = (orient(p(a), p(b), p(c)), orient(p(a), p(b), p(d)));
        let (o3, o4) = (orient(p(c), p(d), p(a)), orient(p(c), p(d), p(b)));
        o1 * o2 < 0.0 && o3 * o4 < 0.0
    }

    /// Erzwingt die Kante a–b (Sloan). `false`, wenn sie nicht einzufügen war (kreuzende Bruchkante).
    fn insert_constraint(&mut self, a: u32, b: u32, depth: u32) -> bool {
        if a == b {
            return true;
        }
        if self.has_edge(a, b) {
            self.fixed.insert(key(a, b));
            return true;
        }
        let cross = match self.crossings(a, b) {
            Ok(c) => c,
            Err(Some(v)) if depth < 64 => return self.insert_constraint(a, v, depth + 1) & self.insert_constraint(v, b, depth + 1),
            Err(_) => return false,
        };
        if cross.iter().any(|&(u, v)| self.fixed.contains(&key(u, v))) {
            return false;
        }
        let mut q: VecDeque<(u32, u32)> = cross.into();
        let mut guard = 0usize;
        let limit = 64 * q.len() + 256;
        while let Some((u, v)) = q.pop_front() {
            guard += 1;
            if guard > limit {
                return false;
            }
            let Some((c, d)) = self.quad(u, v) else { return false };
            if !self.convex(u, v, c, d) {
                q.push_back((u, v));
                continue;
            }
            let Some((c, d)) = self.flip(u, v) else { return false };
            if self.proper_cross(a, b, c, d) {
                q.push_back((c, d));
            }
        }
        let ok = self.has_edge(a, b);
        if ok {
            self.fixed.insert(key(a, b));
        }
        ok
    }

    /// Lawson-Tausch an freien Kanten (Delaunay ausserhalb der Bruchkanten).
    fn lawson(&mut self) {
        let mut stack: Vec<(u32, u32)> = self.edge.keys().filter(|(a, b)| a < b).copied().collect();
        let mut guard = 0usize;
        let limit = 20 * stack.len() + 1000;
        while let Some((a, b)) = stack.pop() {
            guard += 1;
            if guard > limit {
                break;
            }
            if self.fixed.contains(&key(a, b)) {
                continue;
            }
            let Some((c, d)) = self.quad(a, b) else { continue };
            if !self.convex(a, b, c, d) || !self.in_circle(a, b, c, d) {
                continue;
            }
            if self.flip(a, b).is_some() {
                stack.extend([(a, d), (d, b), (b, c), (c, a)]);
            }
        }
    }

    /// d liegt im Umkreis von (a, b, c) (a, b, c gegen den Uhrzeigersinn).
    fn in_circle(&self, a: u32, b: u32, c: u32, d: u32) -> bool {
        let p = |i: u32| self.xy[i as usize];
        let (pa, pb, pc, pd) = (p(a), p(b), p(c), p(d));
        let (adx, ady, bdx, bdy, cdx, cdy) = (pa[0] - pd[0], pa[1] - pd[1], pb[0] - pd[0], pb[1] - pd[1], pc[0] - pd[0], pc[1] - pd[1]);
        let det = (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
        let scale = (adx * adx + ady * ady + bdx * bdx + bdy * bdy + cdx * cdx + cdy * cdy).powi(2);
        det > 1e-12 * scale
    }

    /// Entfernt Randdreiecke mit freier Randkante länger als `max_len` und stumpfem Gegenwinkel (konkave
    /// Ränder, Schritt für Schritt).
    fn trim_hull(&mut self, max_len: f64) {
        for _ in 0..64 {
            let mut changed = false;
            for i in 0..self.tris.len() {
                if !self.alive[i] {
                    continue;
                }
                let v = self.tris[i];
                // Splitter über einer Bucht: lange freie Randkante mit stumpfem Gegenwinkel (> 120°).
                let long_border = (0..3).any(|k| {
                    let (a, b, c) = (v[k], v[(k + 1) % 3], v[(k + 2) % 3]);
                    let (pa, pb, pc) = (self.xy[a as usize], self.xy[b as usize], self.xy[c as usize]);
                    let (u, w) = ([pa[0] - pc[0], pa[1] - pc[1]], [pb[0] - pc[0], pb[1] - pc[1]]);
                    let cos = (u[0] * w[0] + u[1] * w[1]) / (u[0].hypot(u[1]) * w[0].hypot(w[1])).max(1e-300);
                    !self.edge.contains_key(&(b, a)) && !self.fixed.contains(&key(a, b)) && dist(pa, pb) > max_len && cos < -0.5
                });
                if long_border {
                    self.unlink(i);
                    self.alive[i] = false;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }

    fn live(&self) -> Vec<[u32; 3]> {
        self.tris.iter().zip(&self.alive).filter(|(_, a)| **a).map(|(t, _)| *t).collect()
    }
}

/// Punkte (x, y, z) mit Bruchkanten (Indexpaare) → TIN. Doppelte Punkte (≤ `merge`) werden vereinigt
/// (der erste gewinnt). `trim` > 0 entfernt lange Randdreiecke. Die erzwungenen Kanten kommen mit zurück.
pub fn constrained_tin(pts: &[[f64; 3]], constraints: &[(u32, u32)], merge: f64, trim: f64) -> (Tin, HashSet<(u32, u32)>) {
    let merge = merge.max(1e-9);
    let mut grid: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
    let mut map = vec![u32::MAX; pts.len()];
    let mut xy: Vec<P2> = Vec::new();
    let mut z: Vec<f64> = Vec::new();
    for (i, p) in pts.iter().enumerate() {
        if !(p[0].is_finite() && p[1].is_finite() && p[2].is_finite()) {
            continue;
        }
        let (gx, gy) = ((p[0] / merge).floor() as i64, (p[1] / merge).floor() as i64);
        let mut hit = None;
        'n: for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(c) = grid.get(&(gx + dx, gy + dy)) {
                    for &k in c {
                        if dist(xy[k as usize], [p[0], p[1]]) <= merge {
                            hit = Some(k);
                            break 'n;
                        }
                    }
                }
            }
        }
        map[i] = match hit {
            Some(k) => k,
            None => {
                let k = xy.len() as u32;
                xy.push([p[0], p[1]]);
                z.push(p[2]);
                grid.entry((gx, gy)).or_default().push(k);
                k
            }
        };
    }
    let Some(mut cdt) = Cdt::new(xy.clone()) else { return (Tin { xy, z, tris: Vec::new() }, HashSet::new()) };
    for &(a, b) in constraints {
        let (Some(&a), Some(&b)) = (map.get(a as usize), map.get(b as usize)) else { continue };
        if a == u32::MAX || b == u32::MAX || a == b {
            continue;
        }
        cdt.insert_constraint(a, b, 0);
    }
    cdt.lawson();
    if trim > 0.0 {
        cdt.trim_hull(trim);
    }
    let fixed = std::mem::take(&mut cdt.fixed);
    (Tin { tris: cdt.live(), xy, z }, fixed)
}

// ── Gradienten, flache Dreiecke, Glättung ────────────────────────────────────

fn neighbours(t: &Tin) -> Vec<Vec<u32>> {
    let mut nb: Vec<Vec<u32>> = vec![Vec::new(); t.xy.len()];
    for tr in &t.tris {
        for k in 0..3 {
            let (a, b) = (tr[k], tr[(k + 1) % 3]);
            if !nb[a as usize].contains(&b) {
                nb[a as usize].push(b);
            }
            if !nb[b as usize].contains(&a) {
                nb[b as usize].push(a);
            }
        }
    }
    nb
}

/// Gradient je Ecke: gewichtete kleinste Quadrate einer Ebene durch die Ecke über ihren 1-Ring.
pub fn gradients(t: &Tin) -> Vec<P2> {
    let nb = neighbours(t);
    (0..t.xy.len())
        .map(|i| {
            let (mut sxx, mut sxy, mut syy, mut sxz, mut syz) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for &j in &nb[i] {
                let (dx, dy, dz) = (t.xy[j as usize][0] - t.xy[i][0], t.xy[j as usize][1] - t.xy[i][1], t.z[j as usize] - t.z[i]);
                let w = 1.0 / (dx * dx + dy * dy).max(1e-12);
                sxx += w * dx * dx;
                sxy += w * dx * dy;
                syy += w * dy * dy;
                sxz += w * dx * dz;
                syz += w * dy * dz;
            }
            let ridge = 1e-6 * (sxx + syy) + 1e-300;
            let (a, b, d) = (sxx + ridge, sxy, syy + ridge);
            let det = a * d - b * b;
            if !(det.abs() > 1e-300) {
                return [0.0, 0.0];
            }
            [(d * sxz - b * syz) / det, (a * syz - b * sxz) / det]
        })
        .collect()
}

/// Kleinster Abstand zweier Konturhöhen (Äquidistanz), 1 m, wenn nicht bestimmbar.
pub fn interval_of(levels: &[f64]) -> f64 {
    let mut l: Vec<f64> = levels.iter().copied().filter(|z| z.is_finite()).collect();
    l.sort_by(|a, b| a.total_cmp(b));
    l.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    l.windows(2).map(|w| w[1] - w[0]).fold(f64::INFINITY, f64::min).min(1e6).max(0.0).max(if l.len() < 2 { 1.0 } else { 0.0 })
}

/// Schwerpunkt in flache Dreiecke (alle Ecken gleich hoch), Höhe aus den Eckgradienten.
pub fn fix_flat(t: &mut Tin, fixed: &HashSet<(u32, u32)>, interval: f64) {
    let g = gradients(t);
    let across: HashMap<(u32, u32), u32> = t.tris.iter().flat_map(|tr| (0..3).map(move |k| ((tr[k], tr[(k + 1) % 3]), tr[(k + 2) % 3]))).collect();
    let cap = 0.45 * interval;
    let mut out = Vec::with_capacity(t.tris.len());
    let tris = std::mem::take(&mut t.tris);
    for tr in tris {
        let [a, b, c] = tr.map(|i| i as usize);
        let z0 = t.z[a];
        let flat = (t.z[b] - z0).abs() < 1e-9 && (t.z[c] - z0).abs() < 1e-9;
        // Nur, wenn mind. eine Kante frei ist (sonst echte Ebene zwischen drei Bruchkanten).
        let free = (0..3).any(|k| !fixed.contains(&key(tr[k], tr[(k + 1) % 3])));
        let (pa, pb, pc) = (t.xy[a], t.xy[b], t.xy[c]);
        let l2 = dist(pa, pb).max(dist(pb, pc)).max(dist(pc, pa)).powi(2);
        let sliver = orient(pa, pb, pc).abs() < 1e-6 * l2;
        if !flat || !free || sliver {
            out.push(tr);
            continue;
        }
        let m = [(t.xy[a][0] + t.xy[b][0] + t.xy[c][0]) / 3.0, (t.xy[a][1] + t.xy[b][1] + t.xy[c][1]) / 3.0];
        let mut est = 0.0;
        for &i in &[a, b, c] {
            est += t.z[i] + g[i][0] * (m[0] - t.xy[i][0]) + g[i][1] * (m[1] - t.xy[i][1]);
        }
        // Richtung aus den Nachbarn jenseits der freien Kanten: liegt dort nur Höheres (Tieferes), nur
        // hinauf (hinab); ohne Auskunft (Kuppe/Mulde innerhalb einer Linie) frei nach den Gradienten.
        let (mut up, mut down) = (false, false);
        for k in 0..3 {
            let (u, v) = (tr[k], tr[(k + 1) % 3]);
            if fixed.contains(&key(u, v)) {
                continue;
            }
            if let Some(&o) = across.get(&(v, u)) {
                let dz = t.z[o as usize] - z0;
                up |= dz > 1e-9;
                down |= dz < -1e-9;
            }
        }
        if !up && !down {
            up = true;
            down = true;
        }
        let zm = z0 + (est / 3.0 - z0).clamp(if down { -cap } else { 0.0 }, if up { cap } else { 0.0 });
        let k = t.xy.len() as u32;
        t.xy.push(m);
        t.z.push(zm);
        out.extend([[tr[0], tr[1], k], [tr[1], tr[2], k], [tr[2], tr[0], k]]);
    }
    t.tris = out;
}

/// Ein Schritt adaptiver Teilung. `true`, wenn geteilt wurde.
pub fn refine(t: &mut Tin, fixed: &mut HashSet<(u32, u32)>, interval: f64, tol: f64, max_edge: f64) -> bool {
    let g = gradients(t);
    let cap = 0.45 * interval;
    let mut mid: HashMap<(u32, u32), u32> = HashMap::new();
    let tris = std::mem::take(&mut t.tris);
    // Höhenbereich der gegenüberliegenden Ecken je Kante (Begrenzung bei gleich hohen Enden).
    let mut opp: HashMap<(u32, u32), (f64, f64)> = HashMap::new();
    for tr in &tris {
        for k in 0..3 {
            let zo = t.z[tr[(k + 2) % 3] as usize];
            let e = opp.entry(key(tr[k], tr[(k + 1) % 3])).or_insert((zo, zo));
            *e = (e.0.min(zo), e.1.max(zo));
        }
    }
    for tr in &tris {
        for k in 0..3 {
            let e = key(tr[k], tr[(k + 1) % 3]);
            if mid.contains_key(&e) {
                continue;
            }
            let (a, b) = (e.0 as usize, e.1 as usize);
            let (pa, pb) = (t.xy[a], t.xy[b]);
            let len = dist(pa, pb);
            let (za, zb) = (t.z[a], t.z[b]);
            let lin = (za + zb) / 2.0;
            let is_fixed = fixed.contains(&e);
            let zm = if is_fixed && (za - zb).abs() < 1e-9 {
                lin
            } else {
                let d = [pb[0] - pa[0], pb[1] - pa[1]];
                let h = lin + ((g[a][0] - g[b][0]) * d[0] + (g[a][1] - g[b][1]) * d[1]) / 8.0;
                if (za - zb).abs() < 1e-9 {
                    let (olo, ohi) = opp.get(&e).copied().unwrap_or((za, za));
                    za + (h - za).clamp((olo - za).max(-cap).min(0.0), (ohi - za).min(cap).max(0.0))
                } else {
                    // streng zwischen den Enden (sonst entstünden neue flache Dreiecke)
                    let (lo, hi) = (za.min(zb), za.max(zb));
                    h.clamp(lo + 0.1 * (hi - lo), hi - 0.1 * (hi - lo))
                }
            };
            if (zm - lin).abs() > tol || len > max_edge {
                let m = t.xy.len() as u32;
                t.xy.push([(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0]);
                t.z.push(zm);
                mid.insert(e, m);
                if is_fixed {
                    fixed.insert(key(e.0, m));
                    fixed.insert(key(m, e.1));
                }
            }
        }
    }
    if mid.is_empty() {
        t.tris = tris;
        return false;
    }
    let mut out = Vec::with_capacity(tris.len() * 2);
    for tr in tris {
        let m: [Option<u32>; 3] = std::array::from_fn(|k| mid.get(&key(tr[k], tr[(k + 1) % 3])).copied());
        match m.iter().filter(|x| x.is_some()).count() {
            0 => out.push(tr),
            3 => {
                let (m0, m1, m2) = (m[0].unwrap(), m[1].unwrap(), m[2].unwrap());
                out.extend([[tr[0], m0, m2], [m0, tr[1], m1], [m2, m1, tr[2]], [m0, m1, m2]]);
            }
            1 => {
                let k = m.iter().position(|x| x.is_some()).unwrap();
                let (a, b, c) = (tr[k], tr[(k + 1) % 3], tr[(k + 2) % 3]);
                let mm = m[k].unwrap();
                out.extend([[a, mm, c], [mm, b, c]]);
            }
            _ => {
                // Zwei Kanten geteilt: k = die ungeteilte Kante (c→a), Ecke b zwischen den Mittelpunkten.
                let k = m.iter().position(|x| x.is_none()).unwrap();
                let (c, a, b) = (tr[k], tr[(k + 1) % 3], tr[(k + 2) % 3]);
                let (mab, mbc) = (m[(k + 1) % 3].unwrap(), m[(k + 2) % 3].unwrap());
                out.push([mab, b, mbc]);
                // Viereck a, mab, mbc, c über die kürzere Diagonale.
                if dist(t.xy[a as usize], t.xy[mbc as usize]) <= dist(t.xy[mab as usize], t.xy[c as usize]) {
                    out.extend([[a, mab, mbc], [a, mbc, c]]);
                } else {
                    out.extend([[a, mab, c], [mab, mbc, c]]);
                }
            }
        }
    }
    t.tris = out;
    true
}

// ── Gelände aus Höhenlinien ──────────────────────────────────────────────────

/// Eine Höhenlinie: Höhe, Stützpunkte, geschlossen.
#[derive(Clone, Debug)]
pub struct ContourIn {
    pub z: f64,
    pub pts: Vec<P2>,
    pub closed: bool,
}

/// Optionen: `smooth` = Glättungsstufen (0 = reines TIN mit Bruchkanten), `max_edge` = Verdichtung und
/// grösste Kante (≤ 0 → automatisch), `breaklines` = Konturen erzwingen.
#[derive(Clone, Copy, Debug)]
pub struct TerrainOpts {
    pub smooth: u32,
    pub max_edge: f64,
    pub breaklines: bool,
}

impl Default for TerrainOpts {
    fn default() -> Self {
        TerrainOpts { smooth: 2, max_edge: 0.0, breaklines: true }
    }
}

const MAX_TRIS: usize = 1_500_000;

/// Gelände-TIN aus Höhenlinien und Einzelpunkten (x, y, z).
pub fn terrain_from_contours(contours: &[ContourIn], points: &[[f64; 3]], o: TerrainOpts) -> Tin {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let all: Vec<P2> = contours.iter().flat_map(|c| c.pts.iter().copied()).chain(points.iter().map(|p| [p[0], p[1]])).collect();
    for p in &all {
        if p[0].is_finite() && p[1].is_finite() {
            b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
        }
    }
    if !b[0].is_finite() {
        return Tin::default();
    }
    let diag = (b[2] - b[0]).hypot(b[3] - b[1]);
    let max_edge = if o.max_edge > 0.0 { o.max_edge } else { (diag / 150.0).clamp(0.25, 10.0) };
    let interval = interval_of(&contours.iter().map(|c| c.z).collect::<Vec<_>>());
    let mut pts: Vec<[f64; 3]> = Vec::new();
    let mut cons: Vec<(u32, u32)> = Vec::new();
    for c in contours {
        let z = if c.z.is_finite() { c.z } else { 0.0 };
        let ring: Vec<P2> = c.pts.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
        if ring.is_empty() {
            continue;
        }
        let n = ring.len();
        let segs = if c.closed && n > 2 { n } else { n - 1 };
        let start = pts.len() as u32;
        pts.push([ring[0][0], ring[0][1], z]);
        for i in 0..segs {
            let (a, q) = (ring[i], ring[(i + 1) % n]);
            let steps = if o.breaklines { (dist(a, q) / max_edge).ceil().max(1.0) as usize } else { 1 };
            for s in 1..=steps {
                if c.closed && i + 1 == n && s == steps {
                    break;
                }
                let f = s as f64 / steps as f64;
                pts.push([a[0] + (q[0] - a[0]) * f, a[1] + (q[1] - a[1]) * f, z]);
                let k = pts.len() as u32 - 1;
                cons.push((k - 1, k));
            }
        }
        if c.closed && n > 2 {
            cons.push((pts.len() as u32 - 1, start));
        }
    }
    pts.extend(points.iter().copied());
    if !o.breaklines {
        cons.clear();
    }
    let (mut t, mut fixed) = constrained_tin(&pts, &cons, 1e-6 * diag.max(1.0), 6.0 * max_edge);
    if t.tris.is_empty() {
        return t;
    }
    if o.smooth > 0 {
        fix_flat(&mut t, &fixed, interval);
        let tol = 0.02 * interval;
        for _ in 0..o.smooth.min(4) {
            if t.tris.len() * 4 > MAX_TRIS || !refine(&mut t, &mut fixed, interval, tol, max_edge) {
                break;
            }
        }
    }
    t
}

// ── Höhenlinien aus dem TIN ──────────────────────────────────────────────────

/// Eine erzeugte Höhenlinie.
#[derive(Clone, Debug)]
pub struct Isoline {
    pub level: f64,
    pub pts: Vec<P2>,
    pub closed: bool,
}

/// Höhenlinien bei `base + k·interval` (k ganzzahlig) im Höhenbereich des Netzes. Ecken genau auf einer
/// Höhe zählen als „oben" (keine doppelten Linien).
pub fn isolines(t: &Tin, interval: f64, base: f64) -> Vec<Isoline> {
    if !(interval > 0.0) || t.tris.is_empty() {
        return Vec::new();
    }
    let (zmin, zmax) = t.z_range();
    if !((zmax - zmin) / interval < 20_000.0) {
        return Vec::new();
    }
    // Stufe → Segmente (Kantenschlüssel, Kantenschlüssel)
    let mut segs: HashMap<i64, Vec<((u32, u32), (u32, u32))>> = HashMap::new();
    for tr in &t.tris {
        let zs = tr.map(|i| t.z[i as usize]);
        let (lo, hi) = (zs[0].min(zs[1]).min(zs[2]), zs[0].max(zs[1]).max(zs[2]));
        let k0 = ((lo - base) / interval).ceil() as i64;
        let k1 = ((hi - base) / interval).floor() as i64;
        for k in k0..=k1 {
            let h = base + k as f64 * interval;
            let up = zs.map(|z| z >= h);
            if up[0] == up[1] && up[1] == up[2] {
                continue;
            }
            let mut e = Vec::with_capacity(2);
            for i in 0..3 {
                if up[i] != up[(i + 1) % 3] {
                    e.push(key(tr[i], tr[(i + 1) % 3]));
                }
            }
            if e.len() == 2 {
                segs.entry(k).or_default().push((e[0], e[1]));
            }
        }
    }
    let mut keys: Vec<i64> = segs.keys().copied().collect();
    keys.sort();
    let mut out = Vec::new();
    for k in keys {
        let h = base + k as f64 * interval;
        let list = &segs[&k];
        let at = |e: (u32, u32)| -> P2 {
            let (a, b) = (e.0 as usize, e.1 as usize);
            let (za, zb) = (t.z[a], t.z[b]);
            let s = if (zb - za).abs() < 1e-300 { 0.5 } else { ((h - za) / (zb - za)).clamp(0.0, 1.0) };
            [t.xy[a][0] + (t.xy[b][0] - t.xy[a][0]) * s, t.xy[a][1] + (t.xy[b][1] - t.xy[a][1]) * s]
        };
        let mut by_edge: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
        for (i, (a, b)) in list.iter().enumerate() {
            by_edge.entry(*a).or_default().push(i);
            by_edge.entry(*b).or_default().push(i);
        }
        let mut used = vec![false; list.len()];
        for s0 in 0..list.len() {
            if used[s0] {
                continue;
            }
            used[s0] = true;
            // in beide Richtungen verlängern
            let mut chain: VecDeque<(u32, u32)> = VecDeque::from([list[s0].0, list[s0].1]);
            for dir in 0..2 {
                loop {
                    let end = if dir == 0 { *chain.back().unwrap() } else { *chain.front().unwrap() };
                    let next = by_edge.get(&end).and_then(|v| v.iter().copied().find(|&i| !used[i]));
                    let Some(i) = next else { break };
                    used[i] = true;
                    let other = if list[i].0 == end { list[i].1 } else { list[i].0 };
                    if dir == 0 {
                        chain.push_back(other);
                    } else {
                        chain.push_front(other);
                    }
                }
            }
            let closed = chain.len() > 3 && chain.front() == chain.back();
            let mut pts: Vec<P2> = Vec::with_capacity(chain.len());
            for e in chain {
                let p = at(e);
                if pts.last().is_none_or(|q: &P2| dist(*q, p) > 1e-9) {
                    pts.push(p);
                }
            }
            if closed && pts.len() > 1 && dist(pts[0], *pts.last().unwrap()) < 1e-9 {
                pts.pop();
            }
            if pts.len() >= 2 {
                out.push(Isoline { level: h, pts, closed });
            }
        }
    }
    out
}

// ── Gelände-Prisma ───────────────────────────────────────────────────────────

/// Geschlossenes Prisma: Oberfläche, senkrechte Ränder bis `base`, Boden (gespiegelte Oberfläche).
/// Rückgabe: Ecken (x, y, z) und Dreiecke (aussen gegen den Uhrzeigersinn).
pub fn prism(t: &Tin, base: f64) -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let n = t.xy.len() as u32;
    let mut v: Vec<[f64; 3]> = t.xy.iter().zip(&t.z).map(|(p, z)| [p[0], p[1], *z]).collect();
    v.extend(t.xy.iter().map(|p| [p[0], p[1], base]));
    let mut f: Vec<[u32; 3]> = t.tris.clone();
    f.extend(t.tris.iter().map(|tr| [tr[0] + n, tr[2] + n, tr[1] + n]));
    let directed: HashSet<(u32, u32)> = t.tris.iter().flat_map(|tr| (0..3).map(move |k| (tr[k], tr[(k + 1) % 3]))).collect();
    for &(a, b) in &directed {
        if !directed.contains(&(b, a)) {
            // Randkante a→b (Fläche links): Wand nach aussen.
            f.push([b, a, a + n]);
            f.push([b, a + n, b + n]);
        }
    }
    (v, f)
}

/// Volumen eines geschlossenen, nach aussen orientierten Netzes (Divergenzsatz).
pub fn mesh_volume(v: &[[f64; 3]], f: &[[u32; 3]]) -> f64 {
    let mut s = 0.0;
    for t in f {
        let [a, b, c] = t.map(|i| v[i as usize]);
        s += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    s / 6.0
}

/// Jede gerichtete Kante hat genau eine Gegenkante (geschlossen und konsistent orientiert).
pub fn watertight(f: &[[u32; 3]]) -> bool {
    let mut m: HashMap<(u32, u32), i32> = HashMap::new();
    for t in f {
        for k in 0..3 {
            *m.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
        }
    }
    m.iter().all(|(&(a, b), &c)| c == 1 && m.get(&(b, a)) == Some(&1))
}

// ── Bezug zum Modell ─────────────────────────────────────────────────────────

/// Höhenbezug des Geländes: Modellhöhe = Rohhöhe − `datum`. Ist `referenceElevationMasl` gesetzt und
/// liegen die Rohhöhen näher bei diesem Wert als bei 0 (Gelände in m ü. M.), gilt er als Bezug; sonst 0.
pub fn datum(reference_masl: Option<f64>, z: &[f64]) -> f64 {
    let Some(r) = reference_masl.filter(|r| r.is_finite() && *r != 0.0) else { return 0.0 };
    if z.is_empty() {
        return 0.0;
    }
    let mut s: Vec<f64> = z.iter().copied().filter(|v| v.is_finite()).collect();
    if s.is_empty() {
        return 0.0;
    }
    s.sort_by(|a, b| a.total_cmp(b));
    let med = s[s.len() / 2];
    if (med - r).abs() < med.abs() {
        r
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(cx: f64, cy: f64, r: f64, n: usize) -> Vec<P2> {
        (0..n).map(|i| {
            let a = i as f64 / n as f64 * std::f64::consts::TAU;
            [cx + r * a.cos(), cy + r * a.sin()]
        }).collect()
    }

    /// Kegel-Hügel: Kreise r = 50 − 10·k auf Höhe k (k = 0..4).
    fn hill() -> Vec<ContourIn> {
        (0..5).map(|k| ContourIn { z: k as f64, pts: ring(0.0, 0.0, 50.0 - 10.0 * k as f64, 48), closed: true }).collect()
    }

    #[test]
    fn orient_vorzeichen() {
        assert!(orient([0.0, 0.0], [1.0, 0.0], [0.0, 1.0]) > 0.0);
    }

    #[test]
    fn bruchkanten_werden_erzwungen() {
        // Zwei lange, eng benachbarte Linien: ohne Erzwingen kreuzen Delaunay-Kanten die Linie.
        let a = ContourIn { z: 0.0, pts: vec![[0.0, 0.0], [100.0, 0.0]], closed: false };
        let b = ContourIn { z: 1.0, pts: vec![[0.0, 1.0], [50.0, 0.5], [100.0, 1.0]], closed: false };
        let pts = [[50.0, -0.3, 0.0], [20.0, 0.2, 0.5]];
        let o = TerrainOpts { smooth: 0, max_edge: 1000.0, breaklines: true };
        let t = terrain_from_contours(&[a, b], &pts, o);
        let edges: HashSet<(u32, u32)> = t.tris.iter().flat_map(|tr| (0..3).map(move |k| key(tr[k], tr[(k + 1) % 3]))).collect();
        let find = |p: P2| t.xy.iter().position(|q| dist(*q, p) < 1e-9).unwrap() as u32;
        assert!(edges.contains(&key(find([0.0, 0.0]), find([100.0, 0.0]))));
        assert!(edges.contains(&key(find([0.0, 1.0]), find([50.0, 0.5]))));
        assert!(edges.contains(&key(find([50.0, 0.5]), find([100.0, 1.0]))));
    }

    #[test]
    fn glatter_huegel_ohne_ueberschwingen() {
        let t = terrain_from_contours(&hill(), &[], TerrainOpts::default());
        assert!(t.tris.len() > 500);
        let (lo, hi) = t.z_range();
        // Kuppe angehoben, aber unter der nächsten Äquidistanz; nichts unter 0.
        assert!(lo >= -1e-9 && hi > 4.0 && hi < 4.5, "{lo} {hi}");
        // Flache Dreiecke (Terrassen-Artefakt des reinen TIN) praktisch verschwunden.
        let (mut flat, mut all) = (0.0, 0.0);
        for tr in &t.tris {
            let z = tr.map(|i| t.z[i as usize]);
            let p = tr.map(|i| t.xy[i as usize]);
            let a = orient(p[0], p[1], p[2]) / 2.0;
            all += a;
            if (z[0] - z[1]).abs() < 1e-9 && (z[1] - z[2]).abs() < 1e-9 {
                flat += a;
            }
        }
        assert!(flat < 0.002 * all, "{flat} / {all}");
        // Höhenlinien bei ganzen Metern: je Stufe eine geschlossene Linie in der Nähe des Eingangskreises.
        let iso = isolines(&t, 1.0, 0.0);
        for k in 1..4 {
            let ls: Vec<&Isoline> = iso.iter().filter(|l| (l.level - k as f64).abs() < 1e-9).collect();
            assert_eq!(ls.len(), 1, "Stufe {k}");
            assert!(ls[0].closed);
            for p in &ls[0].pts {
                let r = p[0].hypot(p[1]);
                assert!((r - (50.0 - 10.0 * k as f64)).abs() < 0.6, "r={r} k={k}");
            }
        }
        // Monoton: Halbstufe liegt zwischen den Kreisen.
        let idx = TinIndex::new(&t);
        let z = idx.z_at(35.0, 0.0).unwrap();
        assert!(z > 1.0 && z < 2.0, "{z}");
    }

    #[test]
    fn prisma_dicht_und_volumen() {
        let t = terrain_from_contours(&hill(), &[], TerrainOpts { smooth: 1, ..Default::default() });
        let (v, f) = prism(&t, -2.0);
        assert!(watertight(&f));
        // Volumen = ∫ (z + 2) dA über die Dreiecke.
        let mut integ = 0.0;
        for tr in &t.tris {
            let [a, b, c] = tr.map(|i| i as usize);
            let area = orient(t.xy[a], t.xy[b], t.xy[c]) / 2.0;
            integ += area * ((t.z[a] + t.z[b] + t.z[c]) / 3.0 + 2.0);
        }
        let vol = mesh_volume(&v, &f);
        assert!((vol - integ).abs() < 1e-6 * integ, "{vol} {integ}");
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(terrain_from_contours(&[], &[], TerrainOpts::default()).tris.is_empty());
        let c = ContourIn { z: f64::NAN, pts: vec![[f64::NAN, 0.0], [1.0, 1.0]], closed: true };
        assert!(terrain_from_contours(&[c], &[], TerrainOpts::default()).tris.is_empty());
        // Sich kreuzende Bruchkanten: kein Hängen, kein Panic.
        let a = ContourIn { z: 0.0, pts: vec![[0.0, 0.0], [10.0, 10.0]], closed: false };
        let b = ContourIn { z: 1.0, pts: vec![[0.0, 10.0], [10.0, 0.0]], closed: false };
        let t = terrain_from_contours(&[a, b], &[], TerrainOpts { smooth: 1, max_edge: 100.0, breaklines: true });
        assert!(!t.tris.is_empty());
        assert_eq!(datum(Some(450.0), &[452.0, 455.0]), 450.0);
        assert_eq!(datum(Some(450.0), &[2.0, 5.0]), 0.0);
        assert_eq!(datum(None, &[452.0]), 0.0);
    }
}
