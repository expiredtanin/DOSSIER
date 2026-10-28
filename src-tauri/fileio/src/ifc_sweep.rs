// IFC-Import ([B3]): Körper aus Profil-Querschnitten — Rotation (IfcRevolvedAreaSolid) und Sweep
// entlang einer Leitkurve (IfcSweptDiskSolid, IfcFixedReferenceSweptAreaSolid,
// IfcSurfaceCurveSweptAreaSolid). Eigener Code.
//
// Gemeinsamer Kern ist `loft`: dieselben Profilringe (Ring 0 aussen gegen den Uhrzeigersinn, Löcher
// im Uhrzeigersinn, wie bei der Extrusion) werden an `n` Querschnitten in den Raum gesetzt, benachbarte
// Querschnitte mit Vierecken verbunden und Anfang/Ende mit der Profil-Dreieckszerlegung gedeckelt.
// Die Orientierung wird zuletzt über das Volumen geprüft (negativ → umdrehen); so spielt es keine
// Rolle, ob ein Rahmen links- oder rechtshändig ausfällt.
//
// Knicke der Leitkurve werden auf Gehrung geschnitten: der Querschnitt am Knick liegt in der Ebene
// mit der Winkelhalbierenden als Normale, entlang der ankommenden Richtung dorthin verschoben. Das
// Volumen eines Rohrs ist dann Querschnittsfläche × Länge der Leitkurve (wie bei ifcopenshell).

use crate::ifc_import::{arc_segments, prepare_rings, signed_volume, Mesh, V2, V3};

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> Option<V3> {
    let l = dot(a, a).sqrt();
    (l > 1e-12 && l.is_finite()).then(|| scale(a, 1.0 / l))
}
/// Dreht `v` um die Einheitsachse `k` um `phi` (Rodrigues).
fn rotate(v: V3, k: V3, phi: f64) -> V3 {
    let (s, c) = phi.sin_cos();
    add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1.0 - c)))
}
/// Irgendeine Einheitsrichtung senkrecht zu `t`.
fn any_perp(t: V3) -> V3 {
    let h = if t[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    norm(cross(h, t)).unwrap_or([0.0, 0.0, 1.0])
}

/// Höchstzahl Querschnitte × Profilpunkte je Körper.
const MAX_LOFT_POINTS: usize = 2_000_000;

/// Setzt die (vorbereiteten) Ringe an `nsec` Querschnitten ab (`place(i, p)`), verbindet sie und
/// deckelt Anfang und Ende, wenn `caps`.
fn loft(rings: &[Vec<V2>], tris: &[[usize; 3]], nsec: usize, place: impl Fn(usize, V2) -> V3, caps: bool) -> Mesh {
    let mut mesh = Mesh::default();
    let npts: usize = rings.iter().map(|r| r.len()).sum();
    if nsec < 2 || npts.saturating_mul(nsec) > MAX_LOFT_POINTS {
        return mesh;
    }
    // Mantel: je Profilkante ein Streifen mit eigenen Ecken (scharfe Profilkanten), entlang der
    // Leitkurve gemeinsam.
    for r in rings {
        for e in 0..r.len() {
            let (a, b) = (r[e], r[(e + 1) % r.len()]);
            let base = mesh.vcount();
            for i in 0..nsec {
                mesh.push_v(place(i, a));
                mesh.push_v(place(i, b));
            }
            for i in 0..nsec as u32 - 1 {
                let (a0, b0, a1, b1) = (base + 2 * i, base + 2 * i + 1, base + 2 * i + 2, base + 2 * i + 3);
                mesh.tri(a0, b0, b1);
                mesh.tri(a0, b1, a1);
            }
        }
    }
    if caps {
        let flat: Vec<V2> = rings.iter().flatten().copied().collect();
        let s0 = mesh.vcount();
        for p in &flat {
            mesh.push_v(place(0, *p));
        }
        let s1 = mesh.vcount();
        for p in &flat {
            mesh.push_v(place(nsec - 1, *p));
        }
        for t in tris {
            mesh.tri(s0 + t[0] as u32, s0 + t[2] as u32, s0 + t[1] as u32);
            mesh.tri(s1 + t[0] as u32, s1 + t[1] as u32, s1 + t[2] as u32);
        }
    }
    if mesh.positions.iter().any(|v| !v.is_finite()) {
        return Mesh::default();
    }
    if signed_volume(&mesh.positions, &mesh.indices) < 0.0 {
        mesh.flip_all();
    }
    mesh
}

/// Rotationskörper: Profil in der XY-Ebene, gedreht um die Achse durch `o` mit Richtung `d` (beide in
/// der Profilebene) um `angle` (rad, Vorzeichen = Drehsinn um `d`).
pub(crate) fn revolve(rings: &[Vec<V2>], o: V2, d: V2, angle: f64) -> Mesh {
    let Some(k) = norm([d[0], d[1], 0.0]) else { return Mesh::default() };
    if !(angle.is_finite() && angle.abs() > 1e-9) {
        return Mesh::default();
    }
    let angle = angle.clamp(-std::f64::consts::TAU, std::f64::consts::TAU);
    let Some((rings, tris)) = prepare_rings(rings) else { return Mesh::default() };
    let a = [o[0], o[1], 0.0];
    // Grösster Abstand zur Achse bestimmt die Unterteilung.
    let rmax = rings.iter().flatten().map(|p| {
        let v = sub([p[0], p[1], 0.0], a);
        let r = sub(v, scale(k, dot(v, k)));
        dot(r, r).sqrt()
    }).fold(0.0, f64::max);
    let n = arc_segments(angle, rmax).max(if angle.abs() > 3.0 { 12 } else { 2 });
    let full = (angle.abs() - std::f64::consts::TAU).abs() < 1e-6;
    let place = |i: usize, p: V2| -> V3 {
        let phi = angle * i as f64 / n as f64;
        add(a, rotate(sub([p[0], p[1], 0.0], a), k, phi))
    };
    loft(&rings, &tris, n + 1, place, !full)
}

/// Rahmen-Vorgabe eines Sweeps.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Frame {
    /// Profil-X = Vorgabe senkrecht zur Tangente projiziert (IfcFixedReferenceSweptAreaSolid; bei
    /// IfcSurfaceCurveSweptAreaSolid auf einer Ebene deren Normale, wie ifcopenshell).
    FixedX(V3),
    /// Mitgeführt ohne Verdrehung (IfcSweptDiskSolid: gleichgültig, Kreis).
    Transport,
}

/// Sweep des Profils entlang der Leitkurve `path` (Profil-Z = Tangente).
pub(crate) fn sweep(rings: &[Vec<V2>], path: &[V3], frame: Frame) -> Mesh {
    let mut pts: Vec<V3> = Vec::with_capacity(path.len());
    for p in path {
        if !p.iter().all(|v| v.is_finite()) {
            continue;
        }
        if pts.last().is_some_and(|q| dot(sub(*p, *q), sub(*p, *q)) < 1e-18) {
            continue;
        }
        pts.push(*p);
    }
    if pts.len() < 2 {
        return Mesh::default();
    }
    let Some((rings, tris)) = prepare_rings(rings) else { return Mesh::default() };
    let n = pts.len();
    let tang: Vec<V3> = (0..n - 1).map(|k| norm(sub(pts[k + 1], pts[k])).unwrap_or([0.0, 0.0, 1.0])).collect();
    // Rahmen (X, Y) je Abschnitt, rechtshändig mit T = X × Y.
    let mut frames: Vec<(V3, V3)> = Vec::with_capacity(n - 1);
    for (k, &t) in tang.iter().enumerate() {
        let prev = frames.last().map(|f| f.0);
        let proj = |v: V3| norm(sub(v, scale(t, dot(v, t))));
        let x = match frame {
            Frame::FixedX(r) => proj(r).or(prev.and_then(proj)).unwrap_or_else(|| any_perp(t)),
            Frame::Transport => match prev {
                None => any_perp(t),
                Some(px) => {
                    // Kleinste Drehung von der vorigen Tangente auf diese.
                    let t0 = tang[k - 1];
                    let ax = cross(t0, t);
                    let s = dot(ax, ax).sqrt();
                    let rotated = match norm(ax) {
                        Some(axn) => rotate(px, axn, s.atan2(dot(t0, t))),
                        None => px,
                    };
                    proj(rotated).unwrap_or_else(|| any_perp(t))
                }
            },
        };
        frames.push((x, cross(t, x)));
    }
    // Querschnitte als (Knoten, Abschnitt): mitgeführte Rahmen passen an jedem Knick zueinander (ein
    // Querschnitt je Knoten); feste Rahmen nicht — dort je Abschnitt eigener Anfang und eigenes Ende,
    // verbunden durch einen flachen Streifen in der Gehrungsebene (ohne Volumen).
    let secs: Vec<(usize, usize)> = match frame {
        Frame::Transport => (0..n).map(|i| (i, i.saturating_sub(1))).collect(),
        _ => (0..n - 1).flat_map(|k| [(k, k), (k + 1, k)]).collect(),
    };
    let place = |s: usize, p: V2| -> V3 {
        let (i, k) = secs[s];
        let (x, y) = frames[k];
        let q = add(pts[i], add(scale(x, p[0]), scale(y, p[1])));
        if i == 0 || i == n - 1 {
            return q;
        }
        // Gehrung: entlang der Abschnitts-Tangente in die Halbierungsebene des Knotens schieben.
        let t = tang[k];
        let m = norm(add(tang[i - 1], tang[i])).unwrap_or(t);
        let c = dot(t, m).max(0.1);
        sub(q, scale(t, dot(sub(q, pts[i]), m) / c))
    };
    loft(&rings, &tris, secs.len(), place, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vol(m: &Mesh) -> f64 {
        signed_volume(&m.positions, &m.indices)
    }
    fn square(lo: V2, hi: V2) -> Vec<Vec<V2>> {
        vec![vec![lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]]]
    }
    fn circle(r: f64, n: usize) -> Vec<V2> {
        (0..n).map(|i| {
            let t = std::f64::consts::TAU * i as f64 / n as f64;
            [r * t.cos(), r * t.sin()]
        }).collect()
    }

    #[test]
    fn revolve_full_and_partial() {
        // Rechteck x ∈ [2,3], y ∈ [0,1] um die y-Achse: Pappus 2π · 2.5 · 1.
        let pi = std::f64::consts::PI;
        let full = revolve(&square([2.0, 0.0], [3.0, 1.0]), [0.0, 0.0], [0.0, 1.0], 2.0 * pi);
        let want = 2.0 * pi * 2.5;
        assert!((vol(&full) - want).abs() / want < 0.01, "{}", vol(&full));
        // Viertel, beide Drehsinne, Deckel geschlossen.
        for a in [pi / 2.0, -pi / 2.0] {
            let q = revolve(&square([2.0, 0.0], [3.0, 1.0]), [0.0, 0.0], [0.0, 1.0], a);
            assert!((vol(&q) - want / 4.0).abs() / (want / 4.0) < 0.01, "{}", vol(&q));
        }
        // Profil auf der anderen Seite der Achse und Achse verschoben.
        let q = revolve(&square([-3.0, 0.0], [-2.0, 1.0]), [0.0, 5.0], [0.0, -1.0], pi);
        assert!((vol(&q) - want / 2.0).abs() / (want / 2.0) < 0.01, "{}", vol(&q));
        assert!(revolve(&square([0.0, 0.0], [1.0, 1.0]), [0.0, 0.0], [0.0, 0.0], 1.0).is_empty());
        assert!(revolve(&square([0.0, 0.0], [1.0, 1.0]), [0.0, 0.0], [0.0, 1.0], f64::NAN).is_empty());
    }

    #[test]
    fn sweep_bent_tube_volume_is_area_times_length() {
        // Rohr (Kreis 48 Ecken, Polygon-Fläche exakt bekannt) entlang eines räumlichen Polygonzugs.
        let n = 48;
        let ring = circle(0.05, n);
        let area = 0.5 * n as f64 * 0.05f64.powi(2) * (std::f64::consts::TAU / n as f64).sin();
        let path = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [2.0, 3.0, 0.0], [2.0, 3.0, 1.0], [4.0, 5.0, 2.0]];
        let length: f64 = path.windows(2).map(|w| dot(sub(w[1], w[0]), sub(w[1], w[0])).sqrt()).sum();
        for f in [Frame::Transport, Frame::FixedX([0.0, 0.0, 1.0])] {
            let m = sweep(&[ring.clone()], &path, f);
            assert!((vol(&m) - area * length).abs() < 1e-9, "{f:?}: {} ≠ {}", vol(&m), area * length);
        }
        // Hohlrohr.
        let mut inner = circle(0.03, n);
        inner.reverse();
        let ia = 0.5 * n as f64 * 0.03f64.powi(2) * (std::f64::consts::TAU / n as f64).sin();
        let m = sweep(&[ring, inner], &path, Frame::Transport);
        assert!((vol(&m) - (area - ia) * length).abs() < 1e-9, "{}", vol(&m));
    }

    #[test]
    fn sweep_fixed_reference_orients_profile() {
        // Rechteck 0.4 (x) × 0.1 (y) entlang +X, Referenz X = Welt-Z: Profil-x steht senkrecht.
        let m = sweep(&square([-0.2, -0.05], [0.2, 0.05]), &[[0.0; 3], [3.0, 0.0, 0.0]], Frame::FixedX([0.0, 0.0, 1.0]));
        let zs: Vec<f64> = m.positions.chunks_exact(3).map(|c| c[2]).collect();
        let ys: Vec<f64> = m.positions.chunks_exact(3).map(|c| c[1]).collect();
        let span = |v: &[f64]| v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min);
        assert!((span(&zs) - 0.4).abs() < 1e-12 && (span(&ys) - 0.1).abs() < 1e-12);
        assert!((vol(&m) - 0.12).abs() < 1e-12);
    }

    #[test]
    fn sweep_nonsense_is_empty() {
        let r = square([0.0, 0.0], [1.0, 1.0]);
        assert!(sweep(&r, &[[0.0; 3]], Frame::Transport).is_empty());
        assert!(sweep(&r, &[[0.0; 3], [0.0; 3], [f64::NAN; 3]], Frame::Transport).is_empty());
        assert!(sweep(&[vec![[0.0, 0.0], [1.0, 1.0]]], &[[0.0; 3], [1.0, 0.0, 0.0]], Frame::Transport).is_empty());
        // Umkehr der Leitkurve (180°): kein Panic, endlich.
        let m = sweep(&r, &[[0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]], Frame::Transport);
        assert!(m.positions.iter().all(|v| v.is_finite()));
    }
}
