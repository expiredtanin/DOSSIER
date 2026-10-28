// Boolesche Operationen auf geschlossenen Dreiecksnetzen über BSP-Bäume ([B3]: IFC-Öffnungen,
// IfcBooleanResult, Halbräume).
//
// Herkunft: Verfahren von csg.js (Evan Wallace, https://github.com/evanw/csg.js, Datei `csg.js`,
// MIT License, Copyright (c) 2011 Evan Wallace) — Ebenen-Teilung der Polygone, BSP-Aufbau,
// `clipTo`/`invert` und die drei Operationen. In Rust neu geschrieben und angepasst: Bäume in einem
// Feld statt rekursiver Knoten, alle Durchläufe iterativ (tiefe Bäume würden im WASM den Stapel
// sprengen), Arbeitsbudget statt unbeschränkter Teilung, Ursprung in die Mitte des ersten Körpers
// geschoben (Landeskoordinaten), Ebenen über die Newell-Normale. Siehe NOTICE.
//
// Eigenschaften: Eingaben müssen geschlossen und aussen orientiert sein; das Ergebnis ist
// geschlossen (mit T-Stössen, für Anzeige und Volumen ohne Belang). Über dem Budget oder bei
// unbrauchbarer Eingabe → `None`, der Aufrufer behält dann den ersten Operanden.

type V3 = [f64; 3];

/// Abstand, ab dem ein Punkt nicht mehr auf einer Ebene liegt (m).
const EPS: f64 = 1e-5;
/// Höchstzahl Polygon-Teilungsschritte je Operation.
const BUDGET: usize = 3_000_000;
/// Höchstzahl Dreiecke je Operand.
const MAX_INPUT_TRIS: usize = 200_000;

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn lerp(a: V3, b: V3, t: f64) -> V3 {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

#[derive(Clone, Copy, Debug)]
struct Plane {
    n: V3,
    w: f64,
}

impl Plane {
    /// Ebene eines (konvexen) Polygons über die Newell-Normale; entartet → `None`.
    fn of(pts: &[V3]) -> Option<Plane> {
        let mut n = [0.0; 3];
        for i in 0..pts.len() {
            let a = pts[i];
            let b = pts[(i + 1) % pts.len()];
            n[0] += (a[1] - b[1]) * (a[2] + b[2]);
            n[1] += (a[2] - b[2]) * (a[0] + b[0]);
            n[2] += (a[0] - b[0]) * (a[1] + b[1]);
        }
        let l = dot(n, n).sqrt();
        // Fläche = l/2; unter ~1e-12 m² ist die Normale nicht verlässlich.
        if !(l.is_finite() && l > 2e-12) {
            return None;
        }
        let n = [n[0] / l, n[1] / l, n[2] / l];
        Some(Plane { n, w: dot(n, pts[0]) })
    }
    fn flip(&mut self) {
        self.n = [-self.n[0], -self.n[1], -self.n[2]];
        self.w = -self.w;
    }
}

#[derive(Clone, Debug)]
struct Poly {
    pts: Vec<V3>,
    plane: Plane,
}

impl Poly {
    fn flip(&mut self) {
        self.pts.reverse();
        self.plane.flip();
    }
}

const COPLANAR: u8 = 0;
const FRONT: u8 = 1;
const BACK: u8 = 2;
const SPANNING: u8 = 3;

/// Ergebnis einer Teilung an einer Ebene.
#[derive(Default)]
struct Split {
    co_front: Vec<Poly>,
    co_back: Vec<Poly>,
    front: Vec<Poly>,
    back: Vec<Poly>,
}

/// Teilt `poly` an `plane` (wie `CSG.Plane.splitPolygon`).
fn split(plane: &Plane, poly: Poly, out: &mut Split) {
    let mut kind = 0u8;
    let types: Vec<u8> = poly
        .pts
        .iter()
        .map(|p| {
            let t = dot(plane.n, *p) - plane.w;
            let k = if t < -EPS {
                BACK
            } else if t > EPS {
                FRONT
            } else {
                COPLANAR
            };
            kind |= k;
            k
        })
        .collect();
    match kind {
        COPLANAR => {
            if dot(plane.n, poly.plane.n) > 0.0 {
                out.co_front.push(poly);
            } else {
                out.co_back.push(poly);
            }
        }
        FRONT => out.front.push(poly),
        BACK => out.back.push(poly),
        _ => {
            let n = poly.pts.len();
            let mut f = Vec::with_capacity(n + 1);
            let mut b = Vec::with_capacity(n + 1);
            for i in 0..n {
                let j = (i + 1) % n;
                let (ti, tj) = (types[i], types[j]);
                let (vi, vj) = (poly.pts[i], poly.pts[j]);
                if ti != BACK {
                    f.push(vi);
                }
                if ti != FRONT {
                    b.push(vi);
                }
                if (ti | tj) == SPANNING {
                    let den = dot(plane.n, sub(vj, vi));
                    let t = if den.abs() > 1e-300 { (plane.w - dot(plane.n, vi)) / den } else { 0.5 };
                    let v = lerp(vi, vj, t.clamp(0.0, 1.0));
                    f.push(v);
                    b.push(v);
                }
            }
            if f.len() >= 3 {
                out.front.push(Poly { pts: f, plane: poly.plane });
            }
            if b.len() >= 3 {
                out.back.push(Poly { pts: b, plane: poly.plane });
            }
        }
    }
}

#[derive(Default)]
struct Node {
    plane: Option<Plane>,
    front: Option<usize>,
    back: Option<usize>,
    polys: Vec<Poly>,
}

/// BSP-Baum; Knoten 0 ist die Wurzel.
struct Bsp {
    nodes: Vec<Node>,
}

struct OutOfBudget;

fn spend(budget: &mut usize, n: usize) -> Result<(), OutOfBudget> {
    *budget = budget.checked_sub(n).ok_or(OutOfBudget)?;
    Ok(())
}

impl Bsp {
    fn new(polys: Vec<Poly>, budget: &mut usize) -> Result<Bsp, OutOfBudget> {
        let mut b = Bsp { nodes: vec![Node::default()] };
        b.build(polys, budget)?;
        Ok(b)
    }

    fn child(&mut self, ni: usize, front: bool) -> usize {
        let existing = if front { self.nodes[ni].front } else { self.nodes[ni].back };
        if let Some(c) = existing {
            return c;
        }
        let c = self.nodes.len();
        self.nodes.push(Node::default());
        if front {
            self.nodes[ni].front = Some(c);
        } else {
            self.nodes[ni].back = Some(c);
        }
        c
    }

    /// Fügt Polygone ein (`CSG.Node.build`).
    fn build(&mut self, polys: Vec<Poly>, budget: &mut usize) -> Result<(), OutOfBudget> {
        let mut stack = vec![(0usize, polys)];
        while let Some((ni, polys)) = stack.pop() {
            if polys.is_empty() {
                continue;
            }
            spend(budget, polys.len())?;
            let plane = *self.nodes[ni].plane.get_or_insert(polys[0].plane);
            let mut s = Split::default();
            for p in polys {
                split(&plane, p, &mut s);
            }
            self.nodes[ni].polys.append(&mut s.co_front);
            self.nodes[ni].polys.append(&mut s.co_back);
            if !s.front.is_empty() {
                let c = self.child(ni, true);
                stack.push((c, s.front));
            }
            if !s.back.is_empty() {
                let c = self.child(ni, false);
                stack.push((c, s.back));
            }
        }
        Ok(())
    }

    /// Entfernt die Teile von `polys`, die in diesem Körper liegen (`CSG.Node.clipPolygons`).
    fn clip_polygons(&self, polys: Vec<Poly>, budget: &mut usize) -> Result<Vec<Poly>, OutOfBudget> {
        if self.nodes[0].plane.is_none() {
            return Ok(polys);
        }
        let mut out = Vec::new();
        let mut stack = vec![(0usize, polys)];
        while let Some((ni, polys)) = stack.pop() {
            let node = &self.nodes[ni];
            let Some(plane) = node.plane else {
                out.extend(polys);
                continue;
            };
            spend(budget, polys.len())?;
            let mut s = Split::default();
            for p in polys {
                split(&plane, p, &mut s);
            }
            let mut front = s.front;
            front.append(&mut s.co_front);
            let mut back = s.back;
            back.append(&mut s.co_back);
            match node.front {
                Some(c) => stack.push((c, front)),
                None => out.extend(front),
            }
            if let Some(c) = node.back {
                stack.push((c, back));
            }
        }
        Ok(out)
    }

    /// Entfernt aus allen Knoten die Teile innerhalb von `other` (`CSG.Node.clipTo`).
    fn clip_to(&mut self, other: &Bsp, budget: &mut usize) -> Result<(), OutOfBudget> {
        for i in 0..self.nodes.len() {
            let ps = std::mem::take(&mut self.nodes[i].polys);
            self.nodes[i].polys = other.clip_polygons(ps, budget)?;
        }
        Ok(())
    }

    /// Innen ↔ aussen (`CSG.Node.invert`).
    fn invert(&mut self) {
        for n in &mut self.nodes {
            for p in &mut n.polys {
                p.flip();
            }
            if let Some(pl) = &mut n.plane {
                pl.flip();
            }
            std::mem::swap(&mut n.front, &mut n.back);
        }
    }

    fn all(&self) -> Vec<Poly> {
        self.nodes.iter().flat_map(|n| n.polys.iter().cloned()).collect()
    }
}

/// Boolesche Operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Union,
    Difference,
    Intersection,
}

fn bbox(pos: &[f64]) -> Option<(V3, V3)> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for c in pos.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(c[k]);
            hi[k] = hi[k].max(c[k]);
        }
    }
    (lo[0] <= hi[0]).then_some((lo, hi))
}

fn to_polys(pos: &[f64], idx: &[u32], shift: V3) -> Vec<Poly> {
    let p = |i: u32| -> Option<V3> {
        let k = i as usize * 3;
        let s = pos.get(k..k + 3)?;
        Some([s[0] - shift[0], s[1] - shift[1], s[2] - shift[2]])
    };
    idx.chunks_exact(3)
        .filter_map(|t| {
            let pts = vec![p(t[0])?, p(t[1])?, p(t[2])?];
            let plane = Plane::of(&pts)?;
            Some(Poly { pts, plane })
        })
        .collect()
}

/// `a op b` für zwei Netze (`positions` flach x,y,z, `indices` je 3). Ergebnis als neues Netz;
/// `None` bei unbrauchbarer Eingabe oder überschrittenem Budget.
pub fn boolean(a_pos: &[f64], a_idx: &[u32], b_pos: &[f64], b_idx: &[u32], op: Op) -> Option<(Vec<f64>, Vec<u32>)> {
    if a_idx.len() / 3 > MAX_INPUT_TRIS || b_idx.len() / 3 > MAX_INPUT_TRIS {
        return None;
    }
    if !a_pos.iter().chain(b_pos.iter()).all(|v| v.is_finite()) {
        return None;
    }
    let (alo, ahi) = bbox(a_pos)?;
    let Some((blo, bhi)) = bbox(b_pos) else {
        // Leerer zweiter Operand.
        return match op {
            Op::Union | Op::Difference => Some((a_pos.to_vec(), a_idx.to_vec())),
            Op::Intersection => Some((Vec::new(), Vec::new())),
        };
    };
    let disjoint = (0..3).any(|k| alo[k] > bhi[k] + EPS || blo[k] > ahi[k] + EPS);
    if disjoint {
        return match op {
            Op::Difference => Some((a_pos.to_vec(), a_idx.to_vec())),
            Op::Intersection => Some((Vec::new(), Vec::new())),
            Op::Union => {
                let base = (a_pos.len() / 3) as u32;
                let mut pos = a_pos.to_vec();
                pos.extend_from_slice(b_pos);
                let mut idx = a_idx.to_vec();
                idx.extend(b_idx.iter().map(|i| i + base));
                Some((pos, idx))
            }
        };
    }
    // Ursprung in die Mitte von a: kleine Zahlen auch in Landeskoordinaten.
    let shift = [(alo[0] + ahi[0]) / 2.0, (alo[1] + ahi[1]) / 2.0, (alo[2] + ahi[2]) / 2.0];
    let pa = to_polys(a_pos, a_idx, shift);
    let pb = to_polys(b_pos, b_idx, shift);
    if pa.is_empty() {
        return Some((Vec::new(), Vec::new()));
    }
    let mut budget = BUDGET;
    let polys = run(pa, pb, op, &mut budget).ok()?;
    let mut pos = Vec::new();
    let mut idx = Vec::new();
    for p in polys {
        let base = (pos.len() / 3) as u32;
        for v in &p.pts {
            pos.extend_from_slice(&[v[0] + shift[0], v[1] + shift[1], v[2] + shift[2]]);
        }
        for k in 1..p.pts.len() as u32 - 1 {
            idx.extend_from_slice(&[base, base + k, base + k + 1]);
        }
    }
    Some((pos, idx))
}

fn run(pa: Vec<Poly>, pb: Vec<Poly>, op: Op, budget: &mut usize) -> Result<Vec<Poly>, OutOfBudget> {
    let mut a = Bsp::new(pa, budget)?;
    let mut b = Bsp::new(pb, budget)?;
    match op {
        Op::Union => {
            a.clip_to(&b, budget)?;
            b.clip_to(&a, budget)?;
            b.invert();
            b.clip_to(&a, budget)?;
            b.invert();
            a.build(b.all(), budget)?;
        }
        Op::Difference => {
            a.invert();
            a.clip_to(&b, budget)?;
            b.clip_to(&a, budget)?;
            b.invert();
            b.clip_to(&a, budget)?;
            b.invert();
            a.build(b.all(), budget)?;
            a.invert();
        }
        Op::Intersection => {
            a.invert();
            b.clip_to(&a, budget)?;
            b.invert();
            a.clip_to(&b, budget)?;
            b.clip_to(&a, budget)?;
            a.build(b.all(), budget)?;
            a.invert();
        }
    }
    Ok(a.all())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Quader [lo, hi] als 12 Dreiecke, aussen orientiert.
    fn cuboid(lo: V3, hi: V3) -> (Vec<f64>, Vec<u32>) {
        let c = |i: usize| [if i & 1 == 0 { lo[0] } else { hi[0] }, if i & 2 == 0 { lo[1] } else { hi[1] }, if i & 4 == 0 { lo[2] } else { hi[2] }];
        let pos: Vec<f64> = (0..8).flat_map(c).collect();
        let quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        let idx = quads.iter().flat_map(|q| [q[0], q[1], q[2], q[0], q[2], q[3]]).collect();
        (pos, idx)
    }
    fn vol(m: &(Vec<f64>, Vec<u32>)) -> f64 {
        crate::ifc_import::signed_volume(&m.0, &m.1)
    }

    #[test]
    fn cuboid_helper_is_outward() {
        assert!((vol(&cuboid([0.0; 3], [1.0, 2.0, 3.0])) - 6.0).abs() < 1e-12);
    }

    #[test]
    fn wall_minus_flush_opening() {
        // Wand 4 × 0.3 × 3, Öffnung bündig mit beiden Wandflächen und dem Boden: 3.6 − 0.6.
        let wall = cuboid([0.0, 0.0, 0.0], [4.0, 0.3, 3.0]);
        let open = cuboid([1.0, 0.0, 0.0], [2.0, 0.3, 2.0]);
        let r = boolean(&wall.0, &wall.1, &open.0, &open.1, Op::Difference).unwrap();
        assert!((vol(&r) - 3.0).abs() < 1e-9, "{}", vol(&r));
        // Öffnung länger als die Wand dick ist (häufig): gleiches Ergebnis.
        let open = cuboid([1.0, -0.1, 0.5], [2.0, 0.4, 2.0]);
        let r = boolean(&wall.0, &wall.1, &open.0, &open.1, Op::Difference).unwrap();
        assert!((vol(&r) - (3.6 - 0.3 * 1.5)).abs() < 1e-9, "{}", vol(&r));
    }

    #[test]
    fn union_and_intersection_of_overlapping_cuboids() {
        let a = cuboid([0.0; 3], [2.0, 2.0, 2.0]);
        let b = cuboid([1.0, 1.0, 1.0], [3.0, 3.0, 3.0]);
        let u = boolean(&a.0, &a.1, &b.0, &b.1, Op::Union).unwrap();
        assert!((vol(&u) - 15.0).abs() < 1e-9, "{}", vol(&u));
        let i = boolean(&a.0, &a.1, &b.0, &b.1, Op::Intersection).unwrap();
        assert!((vol(&i) - 1.0).abs() < 1e-9, "{}", vol(&i));
        let d = boolean(&a.0, &a.1, &b.0, &b.1, Op::Difference).unwrap();
        assert!((vol(&d) - 7.0).abs() < 1e-9, "{}", vol(&d));
    }

    #[test]
    fn far_from_origin_and_disjoint() {
        // Landeskoordinaten: Ursprung wird verschoben, Ergebnis bleibt genau.
        let o = [2_600_000.0, 1_200_000.0, 500.0];
        let at = |lo: V3, hi: V3| cuboid([lo[0] + o[0], lo[1] + o[1], lo[2] + o[2]], [hi[0] + o[0], hi[1] + o[1], hi[2] + o[2]]);
        let wall = at([0.0, 0.0, 0.0], [4.0, 0.3, 3.0]);
        let open = at([1.0, -0.1, 0.5], [2.0, 0.4, 2.0]);
        let mut r = boolean(&wall.0, &wall.1, &open.0, &open.1, Op::Difference).unwrap();
        // Volumen erst nach Rückschub rechnen (sonst Auslöschung in der Volumenformel selbst).
        for c in r.0.chunks_exact_mut(3) {
            for k in 0..3 {
                c[k] -= o[k];
            }
        }
        assert!((vol(&r) - 3.15).abs() < 1e-6, "{}", vol(&r));
        let far = cuboid([10.0; 3], [11.0; 3]);
        let r = boolean(&wall.0, &wall.1, &far.0, &far.1, Op::Difference).unwrap();
        assert_eq!(r.1.len(), wall.1.len());
        let r = boolean(&wall.0, &wall.1, &far.0, &far.1, Op::Intersection).unwrap();
        assert!(r.1.is_empty());
    }

    #[test]
    fn nonsense_gives_none_or_empty() {
        let a = cuboid([0.0; 3], [1.0; 3]);
        assert!(boolean(&[f64::NAN; 9], &[0, 1, 2], &a.0, &a.1, Op::Difference).is_none());
        assert!(boolean(&[], &[], &a.0, &a.1, Op::Difference).is_none());
        // Kaputte Indizes werden übergangen.
        let r = boolean(&a.0, &[0, 1, 99], &a.0, &a.1, Op::Difference);
        assert!(r.is_some_and(|r| r.1.is_empty()));
        let (r, _) = boolean(&a.0, &a.1, &[], &[], Op::Difference).unwrap();
        assert_eq!(r.len(), a.0.len());
    }
}
