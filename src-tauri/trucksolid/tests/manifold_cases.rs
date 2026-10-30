// [107] Manifold-Booleans: 14 Fälle aus dem Spike (bündige Flächen, Gaube, Dach-L-Ecke,
// 30 Öffnungen, 200 Quader, Splitter). Erwartet: Erfolg, geschlossenes Netz, Volumen auf 1e-9.
use std::collections::HashMap;

use trucksolid::boolean::boolean_mesh_f64;

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Union,
    Diff,
    Inter,
}

#[derive(Clone)]
enum Shape {
    Box([f64; 3], [f64; 3]),
    Prism { origin: [f64; 3], u: [f64; 3], v: [f64; 3], pts: Vec<[f64; 2]>, depth: f64 },
}

#[derive(Clone, Default)]
struct M {
    p: Vec<f64>,
    t: Vec<u32>,
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn mesh_of(s: &Shape) -> M {
    match s {
        Shape::Box(a, b) => {
            let pts = vec![[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
            mesh_of(&Shape::Prism { origin: [0.0, 0.0, a[2]], u: [1.0, 0.0, 0.0], v: [0.0, 1.0, 0.0], pts, depth: b[2] - a[2] })
        }
        Shape::Prism { origin, u, v, pts, depth } => {
            let n = cross(*u, *v);
            let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            let d = [n[0] / l * depth, n[1] / l * depth, n[2] / l * depth];
            let mut pts = pts.clone();
            let area: f64 = (0..pts.len())
                .map(|i| {
                    let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                    a[0] * b[1] - b[0] * a[1]
                })
                .sum();
            if area < 0.0 {
                pts.reverse();
            }
            let k = pts.len() as u32;
            let mut m = M::default();
            for layer in 0..2 {
                for q in &pts {
                    for c in 0..3 {
                        m.p.push(origin[c] + u[c] * q[0] + v[c] * q[1] + if layer == 1 { d[c] } else { 0.0 });
                    }
                }
            }
            for i in 1..k - 1 {
                m.t.extend([0, i + 1, i]);
                m.t.extend([k, k + i, k + i + 1]);
            }
            for i in 0..k {
                let j = (i + 1) % k;
                m.t.extend([i, j, k + j, i, k + j, k + i]);
            }
            m
        }
    }
}

fn volume(m: &M) -> f64 {
    let mut v = 0.0;
    for t in m.t.chunks(3) {
        let p = |i: u32| {
            let o = i as usize * 3;
            [m.p[o], m.p[o + 1], m.p[o + 2]]
        };
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let x = cross(b, c);
        v += a[0] * x[0] + a[1] * x[1] + a[2] * x[2];
    }
    v / 6.0
}

fn open_edges(m: &M) -> usize {
    let mut e: HashMap<(u32, u32), i32> = HashMap::new();
    for t in m.t.chunks(3) {
        for i in 0..3 {
            *e.entry((t[i], t[(i + 1) % 3])).or_default() += 1;
        }
    }
    e.iter().filter(|(&(a, b), &c)| c != 1 || e.get(&(b, a)).copied().unwrap_or(0) != 1).count()
}

fn bx(a: [f64; 3], b: [f64; 3]) -> Shape {
    Shape::Box(a, b)
}
fn gable_x() -> Shape {
    Shape::Prism { origin: [0.0; 3], u: [0.0, 1.0, 0.0], v: [0.0, 0.0, 1.0], pts: vec![[0.0, 0.0], [8.0, 0.0], [4.0, 3.0]], depth: 10.0 }
}
fn dormer() -> Shape {
    Shape::Prism { origin: [0.0, 10.0, 0.0], u: [1.0, 0.0, 0.0], v: [0.0, 0.0, 1.0], pts: vec![[4.0, 0.0], [6.0, 0.0], [5.0, 2.0]], depth: 8.0 }
}
fn gable_y_l() -> Shape {
    Shape::Prism { origin: [0.0, 8.0, 0.0], u: [1.0, 0.0, 0.0], v: [0.0, 0.0, 1.0], pts: vec![[0.0, 0.0], [8.0, 0.0], [4.0, 3.0]], depth: 18.0 }
}

fn case(name: &str) -> (Shape, Vec<(Op, Shape)>, f64) {
    let wall = bx([0.0, 0.0, 0.0], [5.0, 0.3, 3.0]);
    match name {
        "flush_void" => (wall, vec![(Op::Diff, bx([1.0, 0.0, 2.0], [2.0, 0.3, 3.0]))], 4.5 - 0.3),
        "flush_end" => (wall, vec![(Op::Diff, bx([4.0, -0.1, 0.0], [5.0, 0.4, 1.0]))], 4.5 - 0.3),
        "flush_union" => (wall, vec![(Op::Union, bx([5.0, 0.0, 0.0], [7.0, 0.3, 3.0]))], 4.5 + 1.8),
        "dormer_union" => (gable_x(), vec![(Op::Union, dormer())], 120.0 + 5.0 + 29.0 / 36.0),
        "dormer_cut" => (dormer(), vec![(Op::Diff, gable_x())], 5.0 + 29.0 / 36.0),
        "roof_l_union" => (gable_x(), vec![(Op::Union, gable_y_l())], 272.0),
        "roof_l_inter" => (gable_x(), vec![(Op::Inter, gable_y_l())], 64.0),
        "openings30_flush" | "openings30_over" => {
            let (y0, y1) = if name.ends_with("flush") { (0.0, 0.3) } else { (-0.1, 0.4) };
            let steps = (0..30)
                .map(|i| {
                    let x = 0.3 + 0.65 * i as f64;
                    (Op::Diff, bx([x, y0, 0.9], [x + 0.4, y1, 2.1]))
                })
                .collect();
            (bx([0.0, 0.0, 0.0], [20.0, 0.3, 3.0]), steps, 20.0 * 0.3 * 3.0 - 30.0 * 0.4 * 0.3 * 1.2)
        }
        "union200_touch" | "union200_overlap" => {
            let s = if name.ends_with("touch") { 1.0 } else { 0.9 };
            let mut steps = vec![];
            for i in 0..20 {
                for j in 0..10 {
                    if i + j > 0 {
                        steps.push((Op::Union, bx([i as f64 * s, j as f64 * s, 0.0], [i as f64 * s + 1.0, j as f64 * s + 1.0, 1.0])));
                    }
                }
            }
            (bx([0.0; 3], [1.0, 1.0, 1.0]), steps, (19.0 * s + 1.0) * (9.0 * s + 1.0))
        }
        "sliver_1e7" => (wall, vec![(Op::Diff, bx([1.0, 1e-7, 1.0], [2.0, 0.5, 2.0]))], 4.5 - (0.3 - 1e-7)),
        "sliver_1e10" => (wall, vec![(Op::Diff, bx([1.0, -1e-10, 1.0], [2.0, 0.3 + 1e-10, 2.0]))], 4.5 - 0.3),
        "sliver_rot" => {
            let (c, s) = (1e-6f64.cos(), 1e-6f64.sin());
            let p = Shape::Prism { origin: [1.0, 0.8, 1.0], u: [c, s, 0.0], v: [0.0, 0.0, 1.0], pts: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], depth: 1.0 };
            (wall, vec![(Op::Diff, p)], 4.5 - 0.3)
        }
        _ => panic!("unbekannter Fall {name}"),
    }
}

const ALL: &[&str] = &[
    "flush_void", "flush_end", "flush_union", "dormer_union", "dormer_cut", "roof_l_union", "roof_l_inter",
    "openings30_flush", "openings30_over", "union200_touch", "union200_overlap", "sliver_1e7", "sliver_1e10", "sliver_rot",
];

fn run(name: &str) -> (M, f64) {
    let (base, steps, expect) = case(name);
    let mut acc = mesh_of(&base);
    for (op, s) in &steps {
        let b = mesh_of(s);
        let n = match op {
            Op::Union => "union",
            Op::Diff => "difference",
            Op::Inter => "intersection",
        };
        let r = boolean_mesh_f64(&acc.p, &acc.t, &b.p, &b.t, n).unwrap_or_else(|e| panic!("{name}: {e}"));
        acc = M { p: r.positions, t: r.indices };
    }
    (acc, expect)
}

#[test]
fn all_cases_exact_and_watertight() {
    for name in ALL {
        let (m, expect) = run(name);
        assert!(!m.t.is_empty(), "{name}: leer");
        assert_eq!(open_edges(&m), 0, "{name}: Netz offen");
        let rel = (volume(&m) - expect).abs() / expect;
        assert!(rel < 1e-9, "{name}: Volumen {} statt {expect} (rel {rel:e})", volume(&m));
    }
}

#[test]
fn union200_overlap_is_simplified() {
    // Exakter Modus liefert ohne Zusammenfassen 2118 Dreiecke, zusammengefasst 920 oder weniger.
    let (m, _) = run("union200_overlap");
    assert!(m.t.len() / 3 <= 1000, "{} Dreiecke", m.t.len() / 3);
}

#[test]
fn inside_out_input_is_flipped() {
    let mut a = mesh_of(&bx([0.0; 3], [1.0, 1.0, 1.0]));
    a.t.chunks_mut(3).for_each(|t| t.swap(1, 2));
    let b = mesh_of(&bx([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]));
    let r = boolean_mesh_f64(&a.p, &a.t, &b.p, &b.t, "union").unwrap();
    assert!((volume(&M { p: r.positions, t: r.indices }) - 1.875).abs() < 1e-9);
}

#[test]
fn rejects_broken_input() {
    let a = mesh_of(&bx([0.0; 3], [1.0, 1.0, 1.0]));
    let mut open = a.clone();
    open.t.truncate(open.t.len() - 3);
    assert!(boolean_mesh_f64(&open.p, &open.t, &a.p, &a.t, "union").is_err());
    let mut nan = a.clone();
    nan.p[4] = f64::NAN;
    assert!(boolean_mesh_f64(&nan.p, &nan.t, &a.p, &a.t, "union").is_err());
    let mut oob = a.clone();
    oob.t[0] = 99;
    assert!(boolean_mesh_f64(&oob.p, &oob.t, &a.p, &a.t, "union").is_err());
    assert!(boolean_mesh_f64(&[], &[], &a.p, &a.t, "union").is_err());
}
