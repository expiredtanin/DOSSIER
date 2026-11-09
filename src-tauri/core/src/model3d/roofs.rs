//! Dächer im 3D: Schichtkörper je Dachfläche mit Gehrung an Graten und Kehlen, Löcher für Dachfenster
//! und durchdringende Bauteile (`emit_roofs()`), Dachschichten für den Live-Schnitt
//! (`emit_roof_cut_layers()`). Aufgerufen von `parts()` (`mod.rs`), dem Schnitt und der Ansicht.

use super::*;

pub(super) type V3 = [f64; 3];
const ROOF_RGB: Rgb = [0.72, 0.45, 0.36];
const EPS: f64 = 1e-4;

/// Eine Dachschicht für den Live-Schnitt (`RRoofLayer`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RRoofLayer {
    pub polygon: Vec<V3>,
    pub normal: V3,
    pub thickness: f64,
    pub color: Rgb,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut: Option<RCutMeta>,
}

fn push_fan_triangles(positions: &mut Vec<f64>, indices: &mut Vec<u32>, pts: &[V3], flip: bool) {
    if pts.len() < 3 {
        return;
    }
    let base = (positions.len() / 3) as u32;
    for p in pts {
        positions.extend(*p);
    }
    for i in 1..pts.len() as u32 - 1 {
        if flip {
            indices.extend([base, base + i + 1, base + i]);
        } else {
            indices.extend([base, base + i, base + i + 1]);
        }
    }
}

/// Newell-Normale einer Dachfläche, nach oben orientiert (`planeNormalUp`).
pub(crate) fn plane_normal_up(pts: &[V3]) -> V3 {
    let (mut nx, mut ny, mut nz) = (0.0, 0.0, 0.0);
    for i in 0..pts.len() {
        let c = pts[i];
        let d = pts[(i + 1) % pts.len()];
        nx += (c[1] - d[1]) * (c[2] + d[2]);
        ny += (c[2] - d[2]) * (c[0] + d[0]);
        nz += (c[0] - d[0]) * (c[1] + d[1]);
    }
    let len = hypot(&[nx, ny, nz]);
    let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    let u = [nx / len, ny / len, nz / len];
    if u[2] < 0.0 {
        [-u[0], -u[1], -u[2]]
    } else {
        u
    }
}

fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Gehrte Versatz-Ecken aller Dachflächen (`mitredRoofOffsets`). [G9]: an einem Punkt, an dem
/// mehr als zwei Flächen zusammentreffen (Walm-/Zeltspitze, Kehlpunkt, konvexe Teilstücke einer
/// Fläche), bekommen ALLE Flächen dieselbe versetzte Ecke — Ausgleich über alle beteiligten
/// Ebenen (kleinste Quadrate) statt je Fläche paarweise mit zwei Nachbarn; sonst klaffen dort
/// Lücken und der Dachkörper ist nicht geschlossen.
pub(super) struct Mitre<'a> {
    planes: &'a [Vec<V3>],
    normals: Vec<V3>,
    neighbor: Vec<Vec<isize>>,
    pub(super) shared: Vec<Vec<bool>>,
    /// Je Fläche und Ecke: alle (Fläche, Ecke) am selben Punkt (inkl. sich selbst).
    incident: Vec<Vec<Vec<(usize, usize)>>>,
}

impl<'a> Mitre<'a> {
    pub(super) fn new(planes: &'a [Vec<V3>]) -> Self {
        let key = |p: &V3| (round(p[0] * 1e5) as i64, round(p[1] * 1e5) as i64, round(p[2] * 1e5) as i64);
        let ek = |a: &V3, b: &V3| {
            let (ka, kb) = (key(a), key(b));
            if ka <= kb { (ka, kb) } else { (kb, ka) }
        };
        let mut owners: HashMap<_, Vec<usize>> = HashMap::new();
        for (i, pts) in planes.iter().enumerate() {
            for k in 0..pts.len() {
                owners.entry(ek(&pts[k], &pts[(k + 1) % pts.len()])).or_default().push(i);
            }
        }
        let normals: Vec<V3> = planes.iter().map(|p| plane_normal_up(p)).collect();
        let neighbor: Vec<Vec<isize>> = planes
            .iter()
            .enumerate()
            .map(|(i, pts)| {
                (0..pts.len())
                    .map(|k| {
                        owners
                            .get(&ek(&pts[k], &pts[(k + 1) % pts.len()]))
                            .and_then(|o| o.iter().find(|&&x| x != i))
                            .map_or(-1, |&j| j as isize)
                    })
                    .collect()
            })
            .collect();
        let shared = neighbor.iter().map(|row| row.iter().map(|&j| j >= 0).collect()).collect();
        let mut at_point: HashMap<_, Vec<(usize, usize)>> = HashMap::new();
        for (i, pts) in planes.iter().enumerate() {
            for (k, p) in pts.iter().enumerate() {
                at_point.entry(key(p)).or_default().push((i, k));
            }
        }
        let incident = planes.iter().map(|pts| pts.iter().map(|p| at_point.get(&key(p)).cloned().unwrap_or_default()).collect()).collect();
        Mitre { planes, normals, neighbor, shared, incident }
    }

    fn edge_plane(&self, i: usize, k: usize, d: f64) -> (V3, f64) {
        let pts = &self.planes[i];
        let a = pts[k];
        let b = pts[(k + 1) % pts.len()];
        let j = self.neighbor[i][k];
        if j >= 0 {
            let j = j as usize;
            return (self.normals[j], dot3(self.normals[j], self.planes[j][0]) - d);
        }
        let dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let m = cross3(dir, self.normals[i]);
        (m, dot3(m, a))
    }

    fn solve(rows: [(V3, f64); 3]) -> Option<V3> {
        let [(a, ca), (b, cb), (c, cc)] = rows;
        let bc = cross3(b, c);
        let det = dot3(a, bc);
        if det.abs() < 1e-9 {
            return None;
        }
        let cxa = cross3(c, a);
        let axb = cross3(a, b);
        Some([
            (ca * bc[0] + cb * cxa[0] + cc * axb[0]) / det,
            (ca * bc[1] + cb * cxa[1] + cc * axb[1]) / det,
            (ca * bc[2] + cb * cxa[2] + cc * axb[2]) / det,
        ])
    }

    /// Versetzte Ecke `k` der Fläche `i` aus ihrer Versatzebene und den Ebenen ihrer beiden Randkanten
    /// (Nachbar-Versatzebene bzw. Seitenebene an der Traufe); ohne Lösung die Normalen-Verschiebung.
    fn pair_corner(&self, i: usize, k: usize, d: f64) -> V3 {
        let pts = &self.planes[i];
        let n = self.normals[i];
        let p = pts[k];
        let prev = (k + pts.len() - 1) % pts.len();
        let fallback = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
        let own = (n, dot3(n, pts[0]) - d);
        let near = |q: V3| hypot(&[q[0] - fallback[0], q[1] - fallback[1], q[2] - fallback[2]]) <= 4.0 * d + 0.5;
        match Self::solve([own, self.edge_plane(i, prev, d), self.edge_plane(i, k, d)]) {
            Some(q) if near(q) => q,
            _ => fallback,
        }
    }

    pub(super) fn at(&self, i: usize, d: f64) -> Vec<V3> {
        let pts = &self.planes[i];
        let n = self.normals[i];
        if d <= EPS {
            return pts.clone();
        }
        (0..pts.len())
            .map(|k| {
                let p = pts[k];
                let prev = (k + pts.len() - 1) % pts.len();
                let fallback = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
                if !self.shared[i][prev] && !self.shared[i][k] {
                    return fallback;
                }
                let near = |q: V3| hypot(&[q[0] - fallback[0], q[1] - fallback[1], q[2] - fallback[2]]) <= 4.0 * d + 0.5;
                // Zwei Flächen am Punkt: wie bisher paarweise (exakt, unverändert).
                let pairwise = || self.pair_corner(i, k, d);
                let inc = &self.incident[i][k];
                if inc.len() == 2 {
                    // Verschieden geneigte Flächen ([26], Neigung je Kante): die Traufen-Seitenebenen beider
                    // Flächen schneiden die Gratgerade an verschiedenen Stellen — beide Flächen nehmen dann
                    // den Mittelpunkt (liegt weiter auf beiden Versatzebenen), sonst klafft dort eine Lücke.
                    // Bei gleicher Neigung fallen beide Punkte zusammen: unverändert.
                    let q1 = pairwise();
                    let &(j, kj) = inc.iter().find(|&&(a, b)| (a, b) != (i, k)).unwrap_or(&(i, k));
                    if j != i {
                        let q2 = self.pair_corner(j, kj, d);
                        let gap = hypot(&[q2[0] - q1[0], q2[1] - q1[1], q2[2] - q1[2]]);
                        if gap > 1e-9 && gap < 4.0 * d + 0.5 {
                            let m = [(q1[0] + q2[0]) / 2.0, (q1[1] + q2[1]) / 2.0, (q1[2] + q2[2]) / 2.0];
                            let on = |a: usize| (dot3(self.normals[a], m) - (dot3(self.normals[a], self.planes[a][0]) - d)).abs() < 1e-7;
                            if on(i) && on(j) {
                                return m;
                            }
                        }
                    }
                    return q1;
                }
                if inc.len() <= 2 {
                    return pairwise();
                }
                match self.common(inc, d) {
                    Some(q) if near(q) => q,
                    _ => pairwise(),
                }
            })
            .collect()
    }

    /// Gemeinsame versetzte Ecke aller Flächen `inc` (Fläche, Ecke) an einem Punkt: kleinste
    /// Quadrate über alle verschiedenen Ebenen (Flächen um `d` versetzt, Ränder ohne Nachbarn als
    /// Seitenebene), schwach zum Mittel der Normalen-Versätze gezogen (macht unterbestimmte Fälle
    /// eindeutig: eine Ebene → Normalenversatz, zwei → nächster Punkt der Schnittgeraden).
    /// Treffen sich die Ebenen in einem Punkt, ist es dieser.
    fn common(&self, inc: &[(usize, usize)], d: f64) -> Option<V3> {
        let mut rows: Vec<(V3, f64)> = Vec::new();
        let mut push = |(m, c): (V3, f64)| {
            let l = hypot(&m);
            if !(l > 1e-12) {
                return;
            }
            let (m, c) = ([m[0] / l, m[1] / l, m[2] / l], c / l);
            let same = |r: &(V3, f64)| {
                (hypot(&[r.0[0] - m[0], r.0[1] - m[1], r.0[2] - m[2]]) < 1e-9 && (r.1 - c).abs() < 1e-9)
                    || (hypot(&[r.0[0] + m[0], r.0[1] + m[1], r.0[2] + m[2]]) < 1e-9 && (r.1 + c).abs() < 1e-9)
            };
            if !rows.iter().any(same) {
                rows.push((m, c));
            }
        };
        let mut f = [0.0; 3];
        for &(j, kk) in inc {
            let pts = &self.planes[j];
            let nj = self.normals[j];
            push((nj, dot3(nj, pts[0]) - d));
            let prev = (kk + pts.len() - 1) % pts.len();
            for e in [prev, kk] {
                if !self.shared[j][e] {
                    push(self.edge_plane(j, e, d));
                }
            }
            let p = pts[kk];
            for a in 0..3 {
                f[a] += (p[a] - nj[a] * d) / inc.len() as f64;
            }
        }
        let normal_eq = |rows: &[(V3, f64)]| {
            let mut m = [[0.0; 3]; 3];
            let mut b = [0.0; 3];
            for (n, c) in rows {
                for r in 0..3 {
                    for col in 0..3 {
                        m[r][col] += n[r] * n[col];
                    }
                    b[r] += n[r] * c;
                }
            }
            Self::solve([(m[0], b[0]), (m[1], b[1]), (m[2], b[2])])
        };
        if let Some(q) = normal_eq(&rows) {
            return q.iter().all(|v| v.is_finite()).then_some(q);
        }
        // Unterbestimmt (Ebenen schneiden sich in einer Geraden, z. B. zwei Teilstücke am
        // Mansardknick): der Punkt der Geraden, der dem Mittel der Normalen-Versätze am nächsten ist.
        let (n1, _) = *rows.first()?;
        let n2 = rows.iter().map(|r| cross3(n1, r.0)).max_by(|a, b| hypot(a).total_cmp(&hypot(b)))?;
        let l = hypot(&n2);
        if !(l > 1e-6) {
            // Nur eine Richtung: Mittel auf die (gemittelte) Ebene legen.
            let c = rows.iter().map(|r| r.1 * dot3(r.0, n1).signum()).sum::<f64>() / rows.len() as f64;
            let t = c - dot3(n1, f);
            return Some([f[0] + n1[0] * t, f[1] + n1[1] * t, f[2] + n1[2] * t]);
        }
        let dir = [n2[0] / l, n2[1] / l, n2[2] / l];
        rows.push((dir, dot3(dir, f)));
        let q = normal_eq(&rows)?;
        q.iter().all(|v| v.is_finite()).then_some(q)
    }
}

pub(super) fn push_roof_slab_between(positions: &mut Vec<f64>, indices: &mut Vec<u32>, top: &[V3], bottom: &[V3], shared: &[bool]) {
    let mut nz = 0.0;
    for i in 0..top.len() {
        let a = top[i];
        let b = top[(i + 1) % top.len()];
        nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let ccw = nz > 0.0;
    push_fan_triangles(positions, indices, top, !ccw);
    push_fan_triangles(positions, indices, bottom, ccw);
    for i in 0..top.len() {
        if shared[i] {
            continue;
        }
        let j = (i + 1) % top.len();
        let base = (positions.len() / 3) as u32;
        positions.extend(top[i]);
        positions.extend(bottom[i]);
        positions.extend(bottom[j]);
        positions.extend(top[j]);
        if ccw {
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        } else {
            indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
        }
    }
}

/// Je Dachfläche ein geschlossenes Prisma der Schicht `d0`–`d1` unter der Oberkante (alle Seiten, auch
/// die gemeinsamen) — Eingabe der Körper-Booleans ([G5], `roof_assembly`).
pub(crate) fn roof_plane_prisms(planes: &[Vec<V3>], d0: f64, d1: f64) -> Vec<crate::solid_bool::Mesh> {
    let mitre = Mitre::new(planes);
    let mut out = Vec::new();
    for (i, plane) in planes.iter().enumerate() {
        if plane.len() < 3 {
            continue;
        }
        let (mut positions, mut indices) = (Vec::new(), Vec::new());
        push_roof_slab_between(&mut positions, &mut indices, &mitre.at(i, d0), &mitre.at(i, d1), &vec![false; plane.len()]);
        out.push(crate::solid_bool::Mesh { positions, indices });
    }
    out
}

/// Dachfenster-Loch in einer Dachfläche ([103]): Ecken auf der Dach-Oberkante (Gegenuhrzeigersinn um
/// `n`) und die Normale.
pub(crate) struct RoofHoleRect {
    pub corners: [V3; 4],
    pub n: V3,
}

fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Schneidet aus einer ebenen, konvexen Fläche die Rechtecke `holes` (senkrecht zur Fläche) aus:
/// konvexe Reststücke, gleicher Drehsinn wie `poly` (Sutherland-Hodgman je Rechteck-Kante).
pub(crate) fn clip_plane_holes(poly: &[V3], holes: &[RoofHoleRect]) -> Vec<Vec<V3>> {
    let Some(first) = holes.first() else { return vec![poly.to_vec()] };
    let n = first.n;
    let e1 = {
        let d = sub3(first.corners[1], first.corners[0]);
        let l = dot3(d, d).sqrt().max(1e-12);
        [d[0] / l, d[1] / l, d[2] / l]
    };
    let e2 = cross3(n, e1);
    let offs = poly.first().map_or(0.0, |q| dot3(*q, n));
    let to2 = |q: V3| [dot3(q, e1), dot3(q, e2)];
    let lift = |q: [f64; 2]| -> V3 { [e1[0] * q[0] + e2[0] * q[1] + n[0] * offs, e1[1] * q[0] + e2[1] * q[1] + n[1] * offs, e1[2] * q[0] + e2[2] * q[1] + n[2] * offs] };
    let clip = |pts: &[[f64; 2]], a: [f64; 2], b: [f64; 2], keep_left: bool| -> Vec<[f64; 2]> {
        let side = |p: [f64; 2]| {
            let c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
            if keep_left { c } else { -c }
        };
        let mut out = Vec::new();
        for i in 0..pts.len() {
            let (p, q) = (pts[i], pts[(i + 1) % pts.len()]);
            let (sp, sq) = (side(p), side(q));
            if sp >= 0.0 {
                out.push(p);
            }
            if (sp >= 0.0) != (sq >= 0.0) {
                let t = sp / (sp - sq);
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
        out
    };
    let area = |pts: &[[f64; 2]]| (0..pts.len()).map(|i| pts[i][0] * pts[(i + 1) % pts.len()][1] - pts[(i + 1) % pts.len()][0] * pts[i][1]).sum::<f64>().abs() / 2.0;
    let mut pieces: Vec<Vec<[f64; 2]>> = vec![poly.iter().map(|q| to2(*q)).collect()];
    for h in holes {
        let r: Vec<[f64; 2]> = h.corners.iter().map(|q| to2(*q)).collect();
        let mut next = Vec::new();
        for piece in pieces {
            let mut rest = piece;
            for k in 0..4 {
                let (a, b) = (r[k], r[(k + 1) % 4]);
                let outside = clip(&rest, a, b, false);
                if outside.len() >= 3 && area(&outside) > 1e-10 {
                    next.push(outside);
                }
                rest = clip(&rest, a, b, true);
                if rest.len() < 3 {
                    break;
                }
            }
        }
        pieces = next;
    }
    pieces.into_iter().map(|pc| pc.into_iter().map(lift).collect()).collect()
}

/// Wie [`push_roof_slab_between`], mit Dachfenster-Löchern: Deck-/Bodenfläche als Reststücke, dazu je
/// Loch vier Leibungen von `d0` bis `d1` unter der Dach-Oberkante.
fn push_roof_slab_with_holes(positions: &mut Vec<f64>, indices: &mut Vec<u32>, top: &[V3], bottom: &[V3], shared: &[bool], holes: &[RoofHoleRect], d0: f64, d1: f64) {
    let mut nz = 0.0;
    for i in 0..top.len() {
        let a = top[i];
        let b = top[(i + 1) % top.len()];
        nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let ccw = nz > 0.0;
    for pc in clip_plane_holes(top, holes) {
        push_fan_triangles(positions, indices, &pc, !ccw);
    }
    for pc in clip_plane_holes(bottom, holes) {
        push_fan_triangles(positions, indices, &pc, ccw);
    }
    for i in 0..top.len() {
        if shared[i] {
            continue;
        }
        let j = (i + 1) % top.len();
        let base = (positions.len() / 3) as u32;
        positions.extend(top[i]);
        positions.extend(bottom[i]);
        positions.extend(bottom[j]);
        positions.extend(top[j]);
        if ccw {
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        } else {
            indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
        }
    }
    for h in holes {
        let at = |q: V3, d: f64| [q[0] - h.n[0] * d, q[1] - h.n[1] * d, q[2] - h.n[2] * d];
        let center = [0, 1, 2].map(|k| h.corners.iter().map(|c| c[k]).sum::<f64>() / 4.0);
        for k in 0..4 {
            // Laibung nur, soweit die Kante über DIESER Fläche liegt ([148]: ein Loch über mehreren
            // koplanaren Teilflächen eines Flach-/Pultdachs bekommt jede Laibung genau einmal).
            let Some((a, b)) = clip_segment_xy(h.corners[k], h.corners[(k + 1) % 4], top) else { continue };
            let quad = [at(a, d0), at(b, d0), at(b, d1), at(a, d1)];
            let nrm = cross3(sub3(quad[1], quad[0]), sub3(quad[3], quad[0]));
            let mid = [0, 1, 2].map(|c| (a[c] + b[c]) / 2.0);
            let inward = dot3(nrm, sub3(center, mid)) > 0.0;
            let base = (positions.len() / 3) as u32;
            for q in quad {
                positions.extend(q);
            }
            if inward {
                indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
            } else {
                indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
            }
        }
    }
}

/// Strecke a→b (auf der Dachebene) auf die konvexe Fläche `poly` beschnitten (Aufsicht); `None`, wenn
/// nichts (Länge > 1e-9) übrig bleibt.
fn clip_segment_xy(a: V3, b: V3, poly: &[V3]) -> Option<(V3, V3)> {
    let n = poly.len();
    let area: f64 = (0..n).map(|i| poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]).sum();
    let sign = if area < 0.0 { -1.0 } else { 1.0 };
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for i in 0..n {
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        // Abstand links der Kante p→q (innen bei CCW), linear in t.
        let side = |r: V3| sign * ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
        let (fa, fb) = (side(a), side(b));
        let tol = 1e-9 * (q[0] - p[0]).hypot(q[1] - p[1]).max(1.0);
        if fa < -tol && fb < -tol {
            return None;
        }
        if fa < -tol || fb < -tol {
            let t = fa / (fa - fb);
            if fa < fb {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
    if (t1 - t0) * len <= 1e-9 {
        return None;
    }
    let lerp = |t: f64| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    Some((if t0 <= 0.0 { a } else { lerp(t0) }, if t1 >= 1.0 { b } else { lerp(t1) }))
}

/// Ob sich zwei konvexe Polygone in der Aufsicht mit Fläche überdecken (Trennachsen).
fn convex_overlap_xy(a: &[V3], b: &[V3]) -> bool {
    let separated = |p: &[V3], q: &[V3]| {
        (0..p.len()).any(|i| {
            let (u, v) = (p[i], p[(i + 1) % p.len()]);
            let ax = [-(v[1] - u[1]), v[0] - u[0]];
            let proj = |r: &V3| ax[0] * r[0] + ax[1] * r[1];
            let (pmin, pmax) = p.iter().map(proj).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)));
            let (qmin, qmax) = q.iter().map(proj).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)));
            let tol = 1e-9 * ax[0].hypot(ax[1]).max(1.0);
            pmax <= qmin + tol || qmax <= pmin + tol
        })
    };
    a.len() >= 3 && b.len() >= 3 && !separated(a, b) && !separated(b, a)
}

/// Dachfenster-Löcher je Dachfläche eines Dachs (Index in `Project::roofs`). Ein Loch gehört zu seiner
/// Wirtsfläche und zu jeder koplanaren Nachbarfläche, die es überdeckt ([148]: Flach-/Pultdach als
/// konvexe Teilflächen einer Ebene).
pub(crate) fn roof_holes_by_plane(p: &Project, roof_index: usize, planes: &[Vec<V3>]) -> Vec<Vec<RoofHoleRect>> {
    let mut out: Vec<Vec<RoofHoleRect>> = (0..planes.len()).map(|_| Vec::new()).collect();
    for (o, f) in crate::opening_shape::roof_openings(p, roof_index) {
        let Some(host) = f.plane.filter(|&i| i < planes.len()) else { continue };
        let corners = crate::opening_shape::host_rect_plan(&f, o.width, o.height);
        let (hn, h0) = (plane_normal_up(&planes[host]), planes[host][0]);
        for (i, pl) in planes.iter().enumerate() {
            let coplanar = || {
                let n = plane_normal_up(pl);
                pl.len() >= 3 && dot3(n, hn) > 1.0 - 1e-9 && dot3(hn, sub3(pl[0], h0)).abs() < 1e-6
            };
            if i == host || (coplanar() && convex_overlap_xy(pl, &corners)) {
                out[i].push(RoofHoleRect { corners, n: f.n });
            }
        }
    }
    out
}

fn roof_color(p: &Project, override_color: Option<Rgb>, component_id: &str) -> Result<Rgb, String> {
    if let Some(c) = override_color {
        return Ok(c);
    }
    if component_id.is_empty() {
        return Ok(ROOF_RGB);
    }
    // Hängendes Bauteil (Datei/Import): Dach-Vorgabefarbe.
    Ok(p.component(component_id).map_or(ROOF_RGB, |c| hex_to_rgb(&c.color, ROOF_RGB)))
}

/// Dächer als geschlossene, geschichtete Dreiecks-Meshes (`emitRoofs`).
pub fn emit_roofs(p: &Project, only_roof: Option<&str>) -> Result<Vec<RMesh>, String> {
    let maps = material_color_maps(p, only_roof);
    let mut out = Vec::new();
    let nb = crate::roof_assembly::neighbors_rc(p);
    for (ri, roof) in p.roofs.as_deref().unwrap_or(&[]).iter().enumerate().filter(|(_, r)| only_roof.is_none_or(|id| r.id == id)) {
        let override_color = roof.color.as_deref().filter(|c| !c.is_empty()).map(|c| hex_to_rgb(c, ROOF_RGB));
        // Verschnittene Dächer und Gauben ([G5]): Körper aus `roof_assembly`.
        if let Some(solids) = crate::roof_assembly::roof_solids_with(p, ri, &nb) {
            for part in &solids.parts {
                let wall = part.role == crate::roof_assembly::Role::DormerWall;
                let color = if wall {
                    p.component(&part.component_id).map_or(WALL_RGB, |c| hex_to_rgb(&c.color, WALL_RGB))
                } else {
                    roof_color(p, override_color, &part.component_id)?
                };
                let material_index = if (wall || override_color.is_none()) && !part.component_id.is_empty() { material_layer(p, &maps, &part.component_id) } else { None };
                let (positions, indices) = crate::roof_assembly::unshared(&part.mesh);
                out.push(RMesh {
                    crease_angle: None, positions, indices, kind: "extrusion", color, vertex_colors: None, material_index });
            }
            continue;
        }
        let eaves_z = p.roof_base_elevation(roof);
        let g = crate::roof::roof_geometry(&roof.params(), eaves_z);
        let mitre = Mitre::new(&g.planes);
        let holes = roof_holes_by_plane(p, ri, &g.planes);
        let mut offset_above = 0.0;
        for layer in p.roof_layers(roof) {
            let t = layer.thickness.max(0.0);
            if t <= EPS {
                continue;
            }
            let color = roof_color(p, override_color, &layer.component_id)?;
            let material_index = if override_color.is_none() && !layer.component_id.is_empty() { material_layer(p, &maps, &layer.component_id) } else { None };
            let (mut positions, mut indices) = (Vec::new(), Vec::new());
            for (i, plane) in g.planes.iter().enumerate() {
                if plane.len() < 3 {
                    continue;
                }
                let top = mitre.at(i, offset_above);
                let bottom = mitre.at(i, offset_above + t);
                if holes[i].is_empty() {
                    push_roof_slab_between(&mut positions, &mut indices, &top, &bottom, &mitre.shared[i]);
                } else {
                    push_roof_slab_with_holes(&mut positions, &mut indices, &top, &bottom, &mitre.shared[i], &holes[i], offset_above, offset_above + t);
                }
            }
            if !indices.is_empty() {
                out.push(RMesh {
                    crease_angle: None, positions, indices, kind: "extrusion", color, vertex_colors: None, material_index });
            }
            offset_above += t;
        }
    }
    Ok(out)
}

/// Dachschicht-Eingabe für den 3D-Live-Schnitt (`emitRoofCutLayers`).
pub fn emit_roof_cut_layers(p: &Project) -> Result<Vec<RRoofLayer>, String> {
    let mut out = Vec::new();
    for (ri, roof) in p.roofs.as_deref().unwrap_or(&[]).iter().enumerate() {
        let eaves_z = p.roof_base_elevation(roof);
        let g = crate::roof::roof_geometry(&roof.params(), eaves_z);
        let override_color = roof.color.as_deref().filter(|c| !c.is_empty()).map(|c| hex_to_rgb(c, ROOF_RGB));
        let holes = roof_holes_by_plane(p, ri, &g.planes);
        let mut offset_above = 0.0;
        for layer in p.roof_layers(roof) {
            let t = layer.thickness.max(0.0);
            if t <= EPS {
                continue;
            }
            let color = roof_color(p, override_color, &layer.component_id)?;
            let line = resolve_cut_line_style(p, &layer);
            let cut = (line.0.is_some() || line.1.is_some()).then(|| RCutMeta { line_color: line.0, line_weight: line.1, ..Default::default() });
            for (i, plane) in g.planes.iter().enumerate() {
                let nrm = plane_normal_up(plane);
                let polygon: Vec<V3> = plane.iter().map(|q| [q[0] - nrm[0] * offset_above, q[1] - nrm[1] * offset_above, q[2] - nrm[2] * offset_above]).collect();
                // Dachfenster ([103]): Reststücke statt der ganzen Fläche (Loch im Live-Schnitt).
                for polygon in clip_plane_holes(&polygon, &holes[i]) {
                    out.push(RRoofLayer { polygon, normal: nrm, thickness: t, color, cut: cut.clone() });
                }
            }
            offset_above += t;
        }
    }
    Ok(out)
}
