//! [216] Schnittflächen geschlossener Netz-Körper im 3D-Live-Schnitt.
//!
//! Wände mit Formöffnungen (Rund, Rund-/Spitzbogen, frei), Bogenwände und Wände unter einer Dachfläche kommen aus dem
//! Kern als EIN Körper je Wandschicht (`core/src/model3d/wall_body.rs`, Manifold) und erreichen render3d als Netz
//! (`MeshInput` mit `section`), nicht als Prismen. Ihr Schnitt lässt sich nicht aus Rechtecken bilden (die Stücke
//! hätten nur das umschreibende Rechteck-Loch): hier wird das Netz selbst mit der Ebene geschnitten — Dreieck für
//! Dreieck eine Strecke in (u, v) —, die Fläche nach der Gerade-ungerade-Regel in waagrechte Trapeze zerlegt (konvex,
//! für die Fächer-Triangulierung der Cap-Pipeline) und der Umriss sind die Strecken selbst (keine Fugen zwischen den
//! Trapezen). Die Dominanz der Rechteck-Bänder (`section_boolean`) wirkt in eine Richtung: ein Band mit STRIKT höherer
//! Priorität schneidet Trapeze und Umriss des Körpers weg; der Körper selbst schneidet keine Bänder.

use crate::section::SectionPlane;
use crate::types::MeshInput;

/// Strecke in Schnittkoordinaten (u, v), Meter.
pub type Seg = ([f64; 2], [f64; 2]);

/// Toleranz für gleiche Höhen/Längen (Meter).
const EPS: f64 = 1e-7;

/// Schnittstrecken des Netzes `m` (Modell-Koordinaten `[x, y, z = Höhe]`) mit der Ebene. Ecken genau auf der Ebene
/// zählen zur Rückseite (symbolische Verschiebung): je Dreieck mit Ecken beider Seiten genau eine Strecke; die
/// Schnittpunkte einer gemeinsamen Kante sind in beiden Dreiecken bitgleich (immer von der Vorder- zur Rückecke
/// gerechnet).
pub fn slice_mesh(plane: &SectionPlane, m: &MeshInput) -> Vec<Seg> {
    let n = [plane.normal[0] as f64, plane.normal[1] as f64, plane.normal[2] as f64];
    let o = [plane.point[0] as f64, plane.point[1] as f64, plane.point[2] as f64];
    let ua = plane.u_axis();
    let ua = [ua[0] as f64, ua[1] as f64, ua[2] as f64];
    let nv = m.positions.len() / 3;
    // Welt (x, Höhe, y) aus Modell (x, y, z).
    let world = |i: usize| -> Option<[f64; 3]> {
        let c = m.positions.get(3 * i..3 * i + 3)?;
        let w = [c[0] as f64, c[2] as f64, c[1] as f64];
        w.iter().all(|x| x.is_finite()).then_some(w)
    };
    let dist = |p: [f64; 3]| (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2];
    let uv = |p: [f64; 3]| [(p[0] - o[0]) * ua[0] + (p[1] - o[1]) * ua[1] + (p[2] - o[2]) * ua[2], p[1]];
    // Schnittpunkt der Kante zwischen Vorderecke `a` (d < 0) und Rückecke `b` (d >= 0).
    let cross = |a: ([f64; 3], f64), b: ([f64; 3], f64)| -> [f64; 2] {
        let t = a.1 / (a.1 - b.1);
        uv([a.0[0] + (b.0[0] - a.0[0]) * t, a.0[1] + (b.0[1] - a.0[1]) * t, a.0[2] + (b.0[2] - a.0[2]) * t])
    };
    let mut out = Vec::new();
    for tri in m.indices.chunks_exact(3) {
        let idx = [tri[0] as usize, tri[1] as usize, tri[2] as usize];
        if idx.iter().any(|&i| i >= nv) {
            continue;
        }
        let (Some(p0), Some(p1), Some(p2)) = (world(idx[0]), world(idx[1]), world(idx[2])) else { continue };
        let v = [(p0, dist(p0)), (p1, dist(p1)), (p2, dist(p2))];
        let front: Vec<usize> = (0..3).filter(|&k| v[k].1 < 0.0).collect();
        let pts: Vec<[f64; 2]> = match front.len() {
            1 => {
                let f = front[0];
                let (b, c) = ((f + 1) % 3, (f + 2) % 3);
                vec![cross(v[f], v[b]), cross(v[f], v[c])]
            }
            2 => {
                let back = (0..3).find(|k| !front.contains(k)).unwrap_or(0);
                vec![cross(v[front[0]], v[back]), cross(v[front[1]], v[back])]
            }
            _ => continue,
        };
        if (pts[0][0] - pts[1][0]).abs() > EPS || (pts[0][1] - pts[1][1]).abs() > EPS {
            out.push((pts[0], pts[1]));
        }
    }
    out
}

/// Gerade-ungerade-Füllung geschlossener Streckenzüge als waagrechte Trapeze `[(u, v0), (u, v0), (u, v1), (u, v1)]`
/// (konvex). Höhenstreifen mit ungerader Kreuzungszahl (offenes Netz) bleiben leer.
pub fn even_odd_trapezoids(segs: &[Seg]) -> Vec<[[f64; 2]; 4]> {
    let mut vs: Vec<f64> = segs.iter().flat_map(|s| [s.0[1], s.1[1]]).collect();
    vs.sort_by(|a, b| a.total_cmp(b));
    vs.dedup_by(|b, a| (*b - *a).abs() < EPS);
    // Nicht waagrechte Strecken, nach unterer Höhe sortiert: (v_lo, v_hi, u_lo, u_hi) mit u an v_lo/v_hi.
    let mut live: Vec<(f64, f64, f64, f64)> = segs
        .iter()
        .filter(|s| (s.0[1] - s.1[1]).abs() >= EPS)
        .map(|s| if s.0[1] < s.1[1] { (s.0[1], s.1[1], s.0[0], s.1[0]) } else { (s.1[1], s.0[1], s.1[0], s.0[0]) })
        .collect();
    live.sort_by(|a, b| a.0.total_cmp(&b.0));
    let u_at = |s: &(f64, f64, f64, f64), v: f64| s.2 + (s.3 - s.2) * ((v - s.0) / (s.1 - s.0)).clamp(0.0, 1.0);
    let mut out = Vec::new();
    let mut next = 0;
    let mut active: Vec<(f64, f64, f64, f64)> = Vec::new();
    for w in vs.windows(2) {
        let (v0, v1) = (w[0], w[1]);
        active.retain(|s| s.1 > v0 + EPS);
        while next < live.len() && live[next].0 <= v0 + EPS {
            if live[next].1 > v0 + EPS {
                active.push(live[next]);
            }
            next += 1;
        }
        if active.len() < 2 || active.len() % 2 == 1 {
            continue;
        }
        let vm = 0.5 * (v0 + v1);
        let mut xs: Vec<(f64, f64, f64)> = active.iter().map(|s| (u_at(s, vm), u_at(s, v0), u_at(s, v1))).collect();
        xs.sort_by(|a, b| a.0.total_cmp(&b.0));
        for pair in xs.chunks_exact(2) {
            let (a, b) = (pair[0], pair[1]);
            if b.0 - a.0 > EPS {
                out.push([[a.1, v0], [b.1, v0], [b.2, v1], [a.2, v1]]);
            }
        }
    }
    out
}

/// Achsparalleles Rechteck `[u_min, u_max, v_min, v_max]`.
pub type Rect = [f64; 4];

/// Konvexes Polygon geschnitten mit der Halbebene `sign * (coord - c) <= 0` (Achse 0 = u, 1 = v).
fn clip_half(poly: &[[f64; 2]], axis: usize, c: f64, sign: f64) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    let inside = |p: &[f64; 2]| sign * (p[axis] - c) <= 0.0;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        let (ia, ib) = (inside(&a), inside(&b));
        if ia {
            out.push(a);
        }
        if ia != ib {
            let t = (c - a[axis]) / (b[axis] - a[axis]);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    out
}

fn area(poly: &[[f64; 2]]) -> f64 {
    let mut s = 0.0;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        s += a[0] * b[1] - b[0] * a[1];
    }
    0.5 * s.abs()
}

/// Konvexes Polygon ohne das Rechteck `r`: bis zu vier konvexe Reste (links, rechts, darunter, darüber).
pub fn subtract_rect(poly: &[[f64; 2]], r: Rect) -> Vec<Vec<[f64; 2]>> {
    let (lo_u, hi_u, lo_v, hi_v) = poly.iter().fold((f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY), |a, p| {
        (a.0.min(p[0]), a.1.max(p[0]), a.2.min(p[1]), a.3.max(p[1]))
    });
    if hi_u <= r[0] + EPS || lo_u >= r[1] - EPS || hi_v <= r[2] + EPS || lo_v >= r[3] - EPS {
        return vec![poly.to_vec()];
    }
    let mid = clip_half(&clip_half(poly, 0, r[0], -1.0), 0, r[1], 1.0);
    [clip_half(poly, 0, r[0], 1.0), clip_half(poly, 0, r[1], -1.0), clip_half(&mid, 1, r[2], 1.0), clip_half(&mid, 1, r[3], -1.0)]
        .into_iter()
        .filter(|p| p.len() >= 3 && area(p) > EPS * EPS)
        .collect()
}

/// Strecke ohne das Rechteck `r` (0–2 Reste).
pub fn subtract_rect_seg(s: Seg, r: Rect) -> Vec<Seg> {
    let d = [s.1[0] - s.0[0], s.1[1] - s.0[1]];
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (axis, lo, hi) in [(0usize, r[0], r[1]), (1, r[2], r[3])] {
        let (p, dd) = (s.0[axis], d[axis]);
        if dd.abs() < 1e-15 {
            if p <= lo + EPS || p >= hi - EPS {
                return vec![s];
            }
            continue;
        }
        let (a, b) = ((lo - p) / dd, (hi - p) / dd);
        t0 = t0.max(a.min(b));
        t1 = t1.min(a.max(b));
    }
    if t1 - t0 <= 1e-12 {
        return vec![s];
    }
    let at = |t: f64| [s.0[0] + d[0] * t, s.0[1] + d[1] * t];
    let mut out = Vec::new();
    if t0 > 1e-9 {
        out.push((s.0, at(t0)));
    }
    if t1 < 1.0 - 1e-9 {
        out.push((at(t1), s.1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::MeshKind;

    /// Kreis (Mittelpunkt, Radius) als Ring mit `n` Ecken.
    fn circle(c: [f64; 2], r: f64, n: usize) -> Vec<[f64; 2]> {
        (0..n).map(|k| {
            let a = std::f64::consts::TAU * k as f64 / n as f64;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        }).collect()
    }

    /// Wand entlang x (`0..len`, Höhe `0..h`, quer `±t/2`) mit einem Loch `hole` (Ring in (x, z)), als geschlossenes
    /// Netz: Ansichtsflächen aus den Trapezen der Gerade-ungerade-Füllung, Mantel und Leibungen als Vierecke.
    fn wall_with_hole(len: f64, h: f64, t: f64, hole: &[[f64; 2]]) -> MeshInput {
        let outer = vec![[0.0, 0.0], [len, 0.0], [len, h], [0.0, h]];
        let mut segs: Vec<Seg> = Vec::new();
        for ring in [&outer[..], hole] {
            for i in 0..ring.len() {
                segs.push((ring[i], ring[(i + 1) % ring.len()]));
            }
        }
        let mut pos: Vec<f32> = Vec::new();
        let mut idx: Vec<u32> = Vec::new();
        let mut quad = |q: [[f64; 3]; 4]| {
            let b = (pos.len() / 3) as u32;
            for p in q {
                pos.extend([p[0] as f32, p[1] as f32, p[2] as f32]);
            }
            idx.extend([b, b + 1, b + 2, b, b + 2, b + 3]);
        };
        for tz in even_odd_trapezoids(&segs) {
            for y in [-t / 2.0, t / 2.0] {
                quad(tz.map(|p| [p[0], y, p[1]]));
            }
        }
        for (a, b) in &segs {
            quad([[a[0], -t / 2.0, a[1]], [b[0], -t / 2.0, b[1]], [b[0], t / 2.0, b[1]], [a[0], t / 2.0, a[1]]]);
        }
        MeshInput { positions: pos, indices: idx, kind: MeshKind::Imported, color: None, material_index: None, vertex_colors: vec![], crease_angle: None, section: None }
    }

    fn covered(traps: &[[[f64; 2]; 4]], p: [f64; 2]) -> bool {
        traps.iter().any(|t| {
            (0..4).all(|i| {
                let (a, b) = (t[i], t[(i + 1) % 4]);
                let c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
                c >= -1e-9
            }) || (0..4).all(|i| {
                let (a, b) = (t[i], t[(i + 1) % 4]);
                (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 1e-9
            })
        })
    }

    /// Schnitt längs durch eine Wand mit Rundfenster: die Schnittfläche hat ein rundes Loch, nicht das umschreibende
    /// Rechteck (Punkte zwischen Kreis und Rechteck sind Wand), der Umriss folgt dem Kreis.
    #[test]
    fn laengsschnitt_zeigt_rundes_loch() {
        let m = wall_with_hole(3.0, 2.5, 0.3, &circle([1.5, 1.2], 0.5, 48));
        let plane = SectionPlane::looking_plus_y(0.0);
        let segs = slice_mesh(&plane, &m);
        let traps = even_odd_trapezoids(&segs);
        assert!(!traps.is_empty());
        // u = x (Blick nach +Y, rechts = +X), v = Höhe.
        assert!(covered(&traps, [0.5, 0.5]), "Wand neben dem Fenster");
        assert!(covered(&traps, [1.5, 2.3]), "Wand über dem Fenster");
        assert!(!covered(&traps, [1.5, 1.2]), "Fenstermitte offen");
        assert!(!covered(&traps, [1.5, 1.65]), "im Kreis offen");
        assert!(covered(&traps, [1.95, 1.65]), "Ecke des Rechtecks zwischen Kreis und Rechteck ist Wand");
        assert!(covered(&traps, [1.05, 0.75]), "untere Ecke ebenso");
        // Umriss: Rechteck aussen + Kreis (jede Kreis-Strecke im Abstand ≈ r vom Mittelpunkt).
        let on_circle = segs.iter().filter(|s| {
            let r = |p: [f64; 2]| ((p[0] - 1.5).powi(2) + (p[1] - 1.2).powi(2)).sqrt();
            (r(s.0) - 0.5).abs() < 3e-3 && (r(s.1) - 0.5).abs() < 3e-3
        });
        assert!(on_circle.count() >= 40, "Kreis im Umriss");
    }

    /// Querschnitt neben der Fenstermitte: die lichte Höhe ist die des Kreises an dieser Stelle, nicht die des Rechtecks.
    #[test]
    fn querschnitt_neben_der_mitte_folgt_dem_kreis() {
        let m = wall_with_hole(3.0, 2.5, 0.3, &circle([1.5, 1.2], 0.5, 96));
        let plane = SectionPlane::looking_plus_x(1.8);
        let traps = even_odd_trapezoids(&slice_mesh(&plane, &m));
        // Kreis bei x = 1.8: v in 1.2 ± 0.4.
        assert!(covered(&traps, [0.0, 0.75]));
        assert!(covered(&traps, [0.0, 1.65]), "über dem Kreis (im Rechteck-Loch) ist Wand");
        assert!(!covered(&traps, [0.0, 1.2]));
        assert!(!covered(&traps, [0.0, 0.85]));
        assert!(covered(&traps, [0.14, 2.0]) && !covered(&traps, [0.16, 2.0]), "Wanddicke 0.3");
    }

    /// Ganzer Live-Schnitt-Pfad (`section_fill`): Körper mit Schnitt-Stil liefert Caps mit rundem Loch und Umrisslinien;
    /// eine Decke höherer Priorität schneidet den Körper weg, ein Netz ohne `section` gibt keine Caps.
    #[test]
    fn live_schnitt_mit_koerper_netz_und_dominanz() {
        use crate::section_fill::{build_cut_cap_lines_with, build_cut_caps_with, CAP_FLOATS_PER_VERTEX};
        use crate::types::{CutBandMeta, MeshSection, SlabInput};
        let mut m = wall_with_hole(3.0, 2.5, 0.3, &circle([1.5, 1.2], 0.5, 48));
        let plane = SectionPlane::looking_plus_y(0.0);
        assert!(build_cut_caps_with(&plane, &[], &[], &[], &[m.clone()]).is_empty(), "ohne `section` kein Cap");
        let meta = |p: i32| CutBandMeta { join_priority: Some(p), component_id: None, line_color: None, line_weight: None };
        m.section = Some(MeshSection { hatch: None, cut: Some(meta(10)) });
        let slab: SlabInput = serde_json::from_str(r#"{"outline":[[-1,-1],[4,-1],[4,1],[-1,1]],"zBottom":2.3,"zTop":2.6}"#).unwrap();
        let slab = SlabInput { cut: Some(meta(100)), ..slab };
        let caps = build_cut_caps_with(&plane, &[], &[slab.clone()], &[], &[m.clone()]);
        // Dreiecke in (u, v) aus den Vertex-Attributen 3/4.
        let tris: Vec<[[f64; 2]; 3]> = caps
            .chunks_exact(CAP_FLOATS_PER_VERTEX * 3)
            .map(|t| std::array::from_fn(|k| [t[k * CAP_FLOATS_PER_VERTEX + 3] as f64, t[k * CAP_FLOATS_PER_VERTEX + 4] as f64]))
            .collect();
        let hits = |p: [f64; 2]| {
            tris.iter().filter(|t| {
                let s = |a: [f64; 2], b: [f64; 2]| (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
                let (d0, d1, d2) = (s(t[0], t[1]), s(t[1], t[2]), s(t[2], t[0]));
                (d0 >= -1e-9 && d1 >= -1e-9 && d2 >= -1e-9) || (d0 <= 1e-9 && d1 <= 1e-9 && d2 <= 1e-9)
            }).count()
        };
        assert!(hits([1.95, 1.65]) >= 1, "Wand zwischen Kreis und Rechteck");
        assert_eq!(hits([1.5, 1.2]), 0, "Fenster offen");
        assert_eq!(hits([1.5, 1.65]), 0, "im Kreis offen");
        assert!(hits([0.5, 2.0]) >= 1);
        // Über 2.3 nur die Decke (ein Dreieck-Treffer an einer Stelle abseits der Diagonale), nicht dazu die Wand.
        assert_eq!(hits([0.37, 2.41]), 1, "Decke schneidet die Wand weg");
        let lines = build_cut_cap_lines_with(&plane, &[], &[slab], &[], &[m]);
        assert!(!lines.is_empty());
    }

    #[test]
    fn rechteck_abzug_von_polygon_und_strecke() {
        let sq = vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];
        let rest = subtract_rect(&sq, [0.5, 1.0, 1.5, 3.0]);
        let a: f64 = rest.iter().map(|p| area(p)).sum();
        assert!((a - (4.0 - 0.25)).abs() < 1e-9, "{a}");
        assert_eq!(subtract_rect(&sq, [3.0, 4.0, 0.0, 1.0]).len(), 1);
        let s = subtract_rect_seg(([0.0, 1.0], [2.0, 1.0]), [0.5, 1.0, 0.0, 3.0]);
        assert_eq!(s.len(), 2);
        assert!((s[0].1[0] - 0.5).abs() < 1e-12 && (s[1].0[0] - 1.0).abs() < 1e-12);
    }
}
