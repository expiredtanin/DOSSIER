//! [115] Netze der freien Körper (`extrudedSolids`) im Kern: die B-Rep-Beschreibung eines Körpers
//! (`SolidSpec`, `cmd_solid::extruded_solid_spec`, dieselbe, die truck für 3D und STEP bekommt) wird hier
//! direkt tesselliert — Prisma mit Eckenradius/Fase und Löchern, Prisma in beliebiger Ebene, Loft,
//! Rotationskörper, Quader, Kugel, Zylinder, Kegel, Torus, fertiges Netz, Verschiebung/Abbildung;
//! Booleans über Manifold (`solid_bool.rs`). So haben Schnitt, Ansicht, Blatt-Ausschnitte und die CLI
//! dieselben Körper-Netze ohne den asynchronen truck-Umweg über TS.
//!
//! Gekrümmte Flächen als Facetten mit Sehnenabweichung [`TOL`]; jedes Ergebnis geht durch Manifold
//! (verschweisst, geschlossen, nach aussen orientiert). Unbaubares ⇒ `None` (nie Panik).

use crate::model::Project;
use crate::plan::section::BodyMesh;
use crate::solid_bool::{Mesh, Solid};
use serde_json::Value;
use std::f64::consts::PI;

/// Sehnenabweichung (Meter) gekrümmter Flächen (wie die Schnitt-Netze bisher über truck, 5 mm wie im 3D).
pub const TOL: f64 = 0.005;

type P3 = [f64; 3];

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64).filter(|x| x.is_finite())
}

fn num_or(v: &Value, k: &str, d: f64) -> f64 {
    num(v, k).unwrap_or(d)
}

fn vec3(v: &Value, k: &str) -> Option<P3> {
    let a = v.get(k)?.as_array()?;
    if a.len() != 3 {
        return None;
    }
    let mut out = [0.0; 3];
    for (o, x) in out.iter_mut().zip(a) {
        *o = x.as_f64().filter(|x| x.is_finite())?;
    }
    Some(out)
}

fn nums(v: Option<&Value>) -> Option<Vec<f64>> {
    v?.as_array()?.iter().map(|x| x.as_f64().filter(|x| x.is_finite())).collect()
}

/// Flache x/y-Liste zu Punkten; doppelter Schlusspunkt und aufeinanderfolgende Doppelpunkte entfallen.
fn pairs(flat: &[f64]) -> Option<Vec<[f64; 2]>> {
    if flat.len() % 2 != 0 {
        return None;
    }
    let mut v: Vec<[f64; 2]> = Vec::with_capacity(flat.len() / 2);
    for c in flat.chunks_exact(2) {
        if v.last().is_none_or(|l| (l[0] - c[0]).abs() > 1e-10 || (l[1] - c[1]).abs() > 1e-10) {
            v.push([c[0], c[1]]);
        }
    }
    while v.len() >= 2 && (v[0][0] - v[v.len() - 1][0]).abs() <= 1e-10 && (v[0][1] - v[v.len() - 1][1]).abs() <= 1e-10 {
        v.pop();
    }
    (v.len() >= 3).then_some(v)
}

fn area(r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum::<f64>() / 2.0
}

fn ccw(mut r: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    if area(&r) < 0.0 {
        r.reverse();
    }
    r
}

/// Facetten eines Kreises vom Radius `r` für die Sehnenabweichung [`TOL`] (Vielfaches von 4, 12…128).
fn segments(r: f64) -> usize {
    let n = if r > TOL { (PI / (1.0 - TOL / r).acos()).ceil() } else { 12.0 };
    let n = (n as usize).clamp(12, 128);
    n.div_ceil(4) * 4
}

/// Ecken im Abstand `d` abschrägen (je Ecke auf die halbe kürzere Kante begrenzt; wie truck `chamfer_ring`).
fn chamfer_ring(ring: &[[f64; 2]], d: f64) -> Vec<[f64; 2]> {
    let n = ring.len();
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        let (p0, v, p1) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
        let (a, b) = ([p0[0] - v[0], p0[1] - v[1]], [p1[0] - v[0], p1[1] - v[1]]);
        let (la, lb) = (a[0].hypot(a[1]), b[0].hypot(b[1]));
        if la < 1e-9 || lb < 1e-9 || (a[0] * b[0] + a[1] * b[1]) / (la * lb) < -1.0 + 1e-6 {
            out.push(v);
            continue;
        }
        let t = d.min(la / 2.0).min(lb / 2.0);
        out.push([v[0] + a[0] / la * t, v[1] + a[1] / la * t]);
        out.push([v[0] + b[0] / lb * t, v[1] + b[1] / lb * t]);
    }
    out
}

/// Ecken mit Kreisbögen vom Radius `radius` verrunden (wie truck `rounded_ring_wire`: je Ecke auf die halbe
/// kürzere Nachbarkante begrenzt, fast gestreckte Ecken bleiben scharf), Bögen als Facetten.
fn round_ring(ring: &[[f64; 2]], radius: f64) -> Vec<[f64; 2]> {
    let n = ring.len();
    let mut out = Vec::new();
    for i in 0..n {
        let (p0, v, p1) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
        let (a, b) = ([p0[0] - v[0], p0[1] - v[1]], [p1[0] - v[0], p1[1] - v[1]]);
        let (la, lb) = (a[0].hypot(a[1]), b[0].hypot(b[1]));
        if la < 1e-9 || lb < 1e-9 {
            out.push(v);
            continue;
        }
        let (d0, d1) = ([a[0] / la, a[1] / la], [b[0] / lb, b[1] / lb]);
        let theta = (d0[0] * d1[0] + d0[1] * d1[1]).clamp(-1.0, 1.0).acos();
        if theta > PI - 1e-3 || theta < 1e-3 {
            out.push(v);
            continue;
        }
        let tan_half = (theta / 2.0).tan();
        let t = (radius / tan_half).min(la / 2.0).min(lb / 2.0);
        let r = t * tan_half;
        let (bx, by) = (d0[0] + d1[0], d0[1] + d1[1]);
        let bl = bx.hypot(by);
        let c = [v[0] + bx / bl * (r / (theta / 2.0).sin()), v[1] + by / bl * (r / (theta / 2.0).sin())];
        let (s, e) = ([v[0] + d0[0] * t, v[1] + d0[1] * t], [v[0] + d1[0] * t, v[1] + d1[1] * t]);
        let (a0, mut a1) = ((s[1] - c[1]).atan2(s[0] - c[0]), (e[1] - c[1]).atan2(e[0] - c[0]));
        // Kürzerer Bogen (Spannweite π − θ).
        while a1 - a0 > PI {
            a1 -= 2.0 * PI;
        }
        while a1 - a0 < -PI {
            a1 += 2.0 * PI;
        }
        let k = ((segments(r) as f64) * (a1 - a0).abs() / (2.0 * PI)).ceil().max(1.0) as usize;
        for j in 0..=k {
            let ang = a0 + (a1 - a0) * j as f64 / k as f64;
            out.push([c[0] + r * ang.cos(), c[1] + r * ang.sin()]);
        }
    }
    let mut ded: Vec<[f64; 2]> = Vec::with_capacity(out.len());
    for q in out {
        if ded.last().is_none_or(|l: &[f64; 2]| (l[0] - q[0]).abs() > 1e-9 || (l[1] - q[1]).abs() > 1e-9) {
            ded.push(q);
        }
    }
    while ded.len() > 1 && (ded[0][0] - ded[ded.len() - 1][0]).abs() <= 1e-9 && (ded[0][1] - ded[ded.len() - 1][1]).abs() <= 1e-9 {
        ded.pop();
    }
    ded
}

fn cross(a: P3, b: P3) -> P3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: P3) -> Option<P3> {
    let l = dot(a, a).sqrt();
    (l > 1e-12).then(|| [a[0] / l, a[1] / l, a[2] / l])
}

/// Ebener Deckel eines Rings (Newell-Normale, Ohrenschnitt); Dreiecke im Drehsinn des Rings.
fn cap(ring: &[P3]) -> Vec<[usize; 3]> {
    let n = ring.len();
    let mut nv = [0.0; 3];
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        nv[0] += (a[1] - b[1]) * (a[2] + b[2]);
        nv[1] += (a[2] - b[2]) * (a[0] + b[0]);
        nv[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let Some(nz) = norm(nv) else { return Vec::new() };
    let helper = if nz[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let Some(e1) = norm(cross(helper, nz)) else { return Vec::new() };
    let e2 = cross(nz, e1);
    let flat: Vec<[f64; 2]> = ring.iter().map(|q| [dot(*q, e1), dot(*q, e2)]).collect();
    crate::solid_bool::ear_clip(&flat)
}

/// Röhre durch Ringe gleicher Punktzahl: Seitenflächen zwischen aufeinanderfolgenden Ringen, mit `wrap` auch
/// vom letzten zum ersten (Torus, volle Drehung), sonst ebene Deckel an beiden Enden. Zusammenfallende
/// Ecken (Pole, Spitzen, Achse) ergeben entartete Dreiecke, die das Verschweissen entfernt.
fn tube(rings: &[Vec<P3>], wrap: bool) -> Mesh {
    let m = rings.len();
    let n = rings.first().map_or(0, Vec::len);
    if m < 2 || n < 3 || rings.iter().any(|r| r.len() != n) {
        return Mesh::default();
    }
    let mut positions = Vec::with_capacity(m * n * 3);
    for r in rings {
        for q in r {
            positions.extend_from_slice(q);
        }
    }
    let at = |i: usize, k: usize| (i * n + k % n) as u32;
    let mut indices = Vec::new();
    let steps = if wrap { m } else { m - 1 };
    for i in 0..steps {
        let j = (i + 1) % m;
        for k in 0..n {
            let (a, b, c, d) = (at(i, k), at(i, k + 1), at(j, k + 1), at(j, k));
            indices.extend([a, b, c, a, c, d]);
        }
    }
    if !wrap {
        for t in cap(&rings[0]) {
            indices.extend([at(0, t[0]), at(0, t[2]), at(0, t[1])]);
        }
        for t in cap(&rings[m - 1]) {
            indices.extend([at(m - 1, t[0]), at(m - 1, t[1]), at(m - 1, t[2])]);
        }
    }
    Mesh { positions, indices }
}

/// Verwundene Seitenflächen (Loft zwischen gedrehten Ringen: Regelflächen, nicht eben) fein als Gitter
/// aus [`RULED_STEPS`]² Vierecken statt je zwei Dreiecken — sonst zeigt die Ansicht die Diagonale als Knick.
/// Ebene Seiten bleiben, wie sie sind.
fn ruled(rings: &[Vec<P3>]) -> Vec<Vec<P3>> {
    let n = rings.first().map_or(0, Vec::len);
    if rings.len() < 2 || n < 3 || rings.iter().any(|r| r.len() != n) {
        return rings.to_vec();
    }
    let twisted = rings.windows(2).any(|w| {
        (0..n).any(|k| {
            let (a, b, c, d) = (w[0][k], w[0][(k + 1) % n], w[1][(k + 1) % n], w[1][k]);
            let Some(nv) = norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]])) else { return false };
            dot(nv, [d[0] - a[0], d[1] - a[1], d[2] - a[2]]).abs() > 1e-6
        })
    });
    if !twisted {
        return rings.to_vec();
    }
    let k = RULED_STEPS;
    let lerp = |p: P3, q: P3, t: f64| [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    // Jede Kante in k Stücke (in allen Ringen gleich), dann k − 1 Zwischenringe je Spanne.
    let dense: Vec<Vec<P3>> = rings.iter().map(|r| (0..n).flat_map(|i| (0..k).map(move |j| (i, j))).map(|(i, j)| lerp(r[i], r[(i + 1) % n], j as f64 / k as f64)).collect()).collect();
    let mut out = Vec::with_capacity((dense.len() - 1) * k + 1);
    for w in dense.windows(2) {
        for j in 0..k {
            let t = j as f64 / k as f64;
            out.push(w[0].iter().zip(&w[1]).map(|(p, q)| lerp(*p, *q, t)).collect());
        }
    }
    out.push(dense[dense.len() - 1].clone());
    out
}

/// Teilung verwundener Loft-Seiten je Richtung (s. [`ruled`]).
const RULED_STEPS: usize = 8;

fn solid(m: &Mesh) -> Option<Solid> {
    Solid::new(m).ok()
}

fn ring_at(r: &[[f64; 2]], z: f64) -> Vec<P3> {
    r.iter().map(|q| [q[0], q[1], z]).collect()
}

/// Löcher (Ringe in der Ebene des Profils, `place`) als Prismen über die ganze Tiefe abziehen.
fn minus_holes(body: Solid, holes: &[Vec<[f64; 2]>], place: &dyn Fn(&[[f64; 2]]) -> Mesh) -> Option<Solid> {
    let mut s = body;
    for h in holes {
        let hs = solid(&place(h))?;
        s = s.difference(&hs).ok()?;
    }
    Some(s)
}

fn holes_of(spec: &Value) -> Option<Vec<Vec<[f64; 2]>>> {
    match spec.get("holes") {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Array(a)) => a.iter().map(|h| nums(Some(h)).and_then(|f| pairs(&f)).map(ccw)).collect(),
        _ => None,
    }
}

fn affine(m: &Mesh, f: &dyn Fn(P3) -> P3) -> Mesh {
    let positions = m.positions.chunks_exact(3).flat_map(|q| f([q[0], q[1], q[2]])).collect();
    Mesh { positions, indices: m.indices.clone() }
}

/// Körper einer B-Rep-Beschreibung (`SolidSpec`, Felder wie `trucksolid::brep::SolidSpec`).
pub fn spec_solid(spec: &Value, depth: usize) -> Option<Solid> {
    if depth > 64 {
        return None;
    }
    let kind = spec.get("kind")?.as_str()?;
    match kind {
        "extrude" => {
            let h = num(spec, "height").filter(|h| *h > 0.0)?;
            let z0 = num_or(spec, "z0", 0.0);
            let mut outer = ccw(pairs(&nums(spec.get("points"))?)?);
            let ch = num_or(spec, "chamfer", 0.0);
            if ch > 1e-6 {
                outer = chamfer_ring(&outer, ch);
            }
            let cr = num_or(spec, "cornerRadius", 0.0);
            if cr > 1e-6 {
                outer = round_ring(&outer, cr);
            }
            let body = solid(&tube(&[ring_at(&outer, z0), ring_at(&outer, z0 + h)], false))?;
            let e = 1e-3;
            minus_holes(body, &holes_of(spec)?, &|r| tube(&[ring_at(r, z0 - e), ring_at(r, z0 + h + e)], false))
        }
        "extrudePlane" => {
            let (o, u, v) = (vec3(spec, "origin")?, vec3(spec, "uAxis")?, vec3(spec, "vAxis")?);
            let depth_m = num(spec, "depth").filter(|d| *d != 0.0)?;
            let n = norm(cross(u, v))?;
            let place = |r: &[[f64; 2]], off: f64| -> Vec<P3> { r.iter().map(|q| [o[0] + u[0] * q[0] + v[0] * q[1] + n[0] * off, o[1] + u[1] * q[0] + v[1] * q[1] + n[1] * off, o[2] + u[2] * q[0] + v[2] * q[1] + n[2] * off]).collect() };
            let mut front = pairs(&nums(spec.get("points"))?)?;
            let back = nums(spec.get("pointsBack")).unwrap_or_default();
            let mut back = if back.is_empty() { front.clone() } else { pairs(&back)? };
            if front.len() != back.len() {
                return None;
            }
            if area(&front) < 0.0 {
                front.reverse();
                back.reverse();
            }
            let body = solid(&tube(&[place(&front, 0.0), place(&back, depth_m)], false))?;
            let e = 1e-3 * depth_m.signum();
            minus_holes(body, &holes_of(spec)?, &|r| tube(&[place(r, -e), place(r, depth_m + e)], false))
        }
        "loft" => {
            let secs = spec.get("sections")?.as_array()?;
            let rings: Vec<Vec<P3>> = secs.iter().map(|s| Some(ring_at(&ccw(pairs(&nums(s.get("points"))?)?), num(s, "z")?))).collect::<Option<_>>()?;
            solid(&tube(&ruled(&rings), false))
        }
        "revolve" => {
            let prof = pairs(&nums(spec.get("profile"))?)?;
            if prof.iter().any(|q| q[0] < -1e-9) {
                return None;
            }
            let (cx, cy) = (num_or(spec, "cx", 0.0), num_or(spec, "cy", 0.0));
            let angle = num_or(spec, "angleDeg", 360.0).to_radians().clamp(1e-3, 2.0 * PI);
            let r_max = prof.iter().fold(0.0_f64, |m, q| m.max(q[0]));
            let full = angle >= 2.0 * PI - 1e-6;
            let k = ((segments(r_max) as f64 * angle / (2.0 * PI)).ceil() as usize).max(2);
            let count = if full { k } else { k + 1 };
            let rings: Vec<Vec<P3>> = (0..count)
                .map(|i| {
                    let a = angle * i as f64 / k as f64;
                    let (c, s) = (a.cos(), a.sin());
                    prof.iter().map(|q| [cx + q[0].max(0.0) * c, cy + q[0].max(0.0) * s, q[1]]).collect()
                })
                .collect();
            solid(&tube(&rings, full))
        }
        "cuboid" => {
            let (lo, hi) = (vec3(spec, "min")?, vec3(spec, "max")?);
            if (0..3).any(|i| hi[i] - lo[i] <= 0.0) {
                return None;
            }
            let r = [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]];
            solid(&tube(&[ring_at(&r, lo[2]), ring_at(&r, hi[2])], false))
        }
        "cylinder" | "cone" => {
            let (cx, cy, z0, r, h) = (num(spec, "cx")?, num(spec, "cy")?, num_or(spec, "z0", 0.0), num(spec, "r")?, num(spec, "height")?);
            if !(r > 0.0 && h > 0.0) {
                return None;
            }
            let n = segments(r);
            let circle = |rr: f64, z: f64| -> Vec<P3> { (0..n).map(|i| 2.0 * PI * i as f64 / n as f64).map(|a| [cx + rr * a.cos(), cy + rr * a.sin(), z]).collect() };
            let top = if kind == "cone" { 0.0 } else { r };
            solid(&tube(&[circle(r, z0), circle(top, z0 + h)], false))
        }
        "sphere" => {
            let (c, r) = (vec3(spec, "center")?, num(spec, "r")?);
            if !(r > 0.0) {
                return None;
            }
            let n = segments(r);
            let m = n / 2;
            let rings: Vec<Vec<P3>> = (0..=m)
                .map(|i| {
                    let phi = -PI / 2.0 + PI * i as f64 / m as f64;
                    let (rr, z) = (r * phi.cos(), c[2] + r * phi.sin());
                    (0..n).map(|j| 2.0 * PI * j as f64 / n as f64).map(|a| [c[0] + rr * a.cos(), c[1] + rr * a.sin(), z]).collect()
                })
                .collect();
            solid(&tube(&rings, false))
        }
        "torus" => {
            let (c, big, small) = (vec3(spec, "center")?, num(spec, "major")?, num(spec, "minor")?);
            if !(small > 0.0 && big > small) {
                return None;
            }
            let (n, m) = (segments(big + small), segments(small));
            let rings: Vec<Vec<P3>> = (0..n)
                .map(|i| {
                    let a = 2.0 * PI * i as f64 / n as f64;
                    (0..m)
                        .map(|j| {
                            let b = 2.0 * PI * j as f64 / m as f64;
                            let rr = big + small * b.cos();
                            [c[0] + rr * a.cos(), c[1] + rr * a.sin(), c[2] + small * b.sin()]
                        })
                        .collect()
                })
                .collect();
            solid(&tube(&rings, true))
        }
        "mesh" => {
            let pos = nums(spec.get("positions"))?;
            let idx = nums(spec.get("indices"))?;
            if idx.iter().any(|&i| !(i >= 0.0) || i.fract() != 0.0 || i as usize >= pos.len() / 3) {
                return None;
            }
            solid(&Mesh { positions: pos, indices: idx.iter().map(|&i| i as u32).collect() })
        }
        "translate" => {
            let v = vec3(spec, "v")?;
            let inner = spec_solid(spec.get("solid")?, depth + 1)?.to_mesh_raw();
            solid(&affine(&inner, &|q| [q[0] + v[0], q[1] + v[1], q[2] + v[2]]))
        }
        "transform" => {
            let m = nums(spec.get("m"))?;
            if m.len() != 12 {
                return None;
            }
            let inner = spec_solid(spec.get("solid")?, depth + 1)?.to_mesh_raw();
            solid(&affine(&inner, &|q| {
                [m[0] * q[0] + m[1] * q[1] + m[2] * q[2] + m[3], m[4] * q[0] + m[5] * q[1] + m[6] * q[2] + m[7], m[8] * q[0] + m[9] * q[1] + m[10] * q[2] + m[11]]
            }))
        }
        "boolean" => {
            let a = spec_solid(spec.get("a")?, depth + 1)?;
            let b = spec_solid(spec.get("b")?, depth + 1)?;
            match spec.get("op")?.as_str()? {
                "union" => a.union(&b).ok(),
                "difference" => a.difference(&b).ok(),
                "intersection" => a.intersection(&b).ok(),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Netz einer B-Rep-Beschreibung (geschlossen, aussen orientiert); unbaubar oder leer ⇒ `None`.
pub fn spec_mesh(spec: &Value) -> Option<Mesh> {
    let m = spec_solid(spec, 0)?.to_mesh_raw();
    (!m.is_empty()).then_some(m)
}

/// Senkrechtes Prisma eines Abzugskörpers: rechnet der Schnitt selbst (`subtract_voids_in_section`), kein Netz
/// nötig (wie bisher `isVoid` in `toSection.ts`).
fn is_prism_void(s: &crate::model::ExtrudedSolid) -> bool {
    s.operation.as_deref() == Some("subtract") && s.brep.is_none() && s.taper.unwrap_or(0.0) < 1e-6 && s.points.len() >= 3 && s.height > 0.0
}

/// Netz eines Körpers mit UK auf seinem Geschoss (gemerkt nach Inhalt).
pub fn body_mesh(p: &Project, s: &crate::model::ExtrudedSolid) -> Option<std::rc::Rc<Option<Mesh>>> {
    let floor_z = if s.level_id.is_empty() { 0.0 } else { p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) };
    let v = serde_json::to_value(s).ok()?;
    let hash = crate::solid_bool::ContentHash::default().json(&v).f64(floor_z).finish();
    Some(crate::solid_bool::cached(&format!("body-mesh:{}", s.id), hash, || crate::cmd_solid::extruded_solid_spec(&v, floor_z).and_then(|spec| spec_mesh(&spec))))
}

/// Die Netze der freien Körper für Schnitt und Ansicht (Index in `extrudedSolids` + Netz). Senkrechte
/// Prismen-Abzugskörper fehlen (der Schnitt rechnet sie selbst), alle übrigen Abzugskörper sind dabei.
pub fn body_meshes(p: &Project) -> Vec<BodyMesh> {
    let mut out = Vec::new();
    for (index, s) in p.extruded_solids.as_deref().unwrap_or(&[]).iter().enumerate() {
        if is_prism_void(s) {
            continue;
        }
        let Some(m) = body_mesh(p, s) else { continue };
        let Some(m) = m.as_ref() else { continue };
        out.push(BodyMesh { index, positions: m.positions.clone(), indices: m.indices.iter().map(|&i| i as f64).collect() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vol(spec: Value) -> f64 {
        let m = spec_mesh(&spec).expect("Netz");
        assert!(m.is_closed(), "geschlossen");
        m.volume()
    }

    #[test]
    fn grundkoerper_volumen() {
        assert!((vol(json!({"kind":"cuboid","min":[0,0,0],"max":[2,3,4]})) - 24.0).abs() < 1e-9);
        assert!((vol(json!({"kind":"extrude","points":[0,0,2,0,2,1,0,1],"height":3,"z0":1})) - 6.0).abs() < 1e-9);
        // Loch 1×0.5 über die ganze Höhe.
        assert!((vol(json!({"kind":"extrude","points":[0,0,2,0,2,1,0,1],"holes":[[0.5,0.25,1.5,0.25,1.5,0.75,0.5,0.75]],"height":1})) - 1.5).abs() < 1e-9);
        let pi = std::f64::consts::PI;
        let cyl = vol(json!({"kind":"cylinder","cx":0,"cy":0,"z0":0,"r":1,"height":2}));
        assert!((cyl - 2.0 * pi).abs() < 0.02 * 2.0 * pi, "{cyl}");
        let cone = vol(json!({"kind":"cone","cx":0,"cy":0,"z0":0,"r":1,"height":3}));
        assert!((cone - pi).abs() < 0.02 * pi, "{cone}");
        let sph = vol(json!({"kind":"sphere","center":[0,0,1],"r":1}));
        assert!((sph - 4.0 / 3.0 * pi).abs() < 0.03 * 4.0, "{sph}");
        let tor = vol(json!({"kind":"torus","center":[0,0,0.5],"major":2,"minor":0.5}));
        assert!((tor - 2.0 * pi * pi * 2.0 * 0.25).abs() < 0.03 * 10.0, "{tor}");
        // Kegelstumpf als Rotationskörper (Profil mit Achskante), halbe Drehung.
        let fr = vol(json!({"kind":"revolve","profile":[0,0,1,0,1,1,0,1],"angleDeg":180}));
        assert!((fr - pi / 2.0).abs() < 0.02 * pi, "{fr}");
        // Pyramidenstumpf (Loft) 2×2 → 1×1, h = 3: V = h/3 (A1 + A2 + √(A1 A2)) = 7.
        assert!((vol(json!({"kind":"loft","sections":[{"z":0,"points":[0,0,2,0,2,2,0,2]},{"z":3,"points":[0.5,0.5,1.5,0.5,1.5,1.5,0.5,1.5]}]})) - 7.0).abs() < 1e-9);
        // Verwundener Loft (Quadrat → um 45° gedrehtes Quadrat): fein geteilt, geschlossen, Volumen plausibel.
        let tw = spec_mesh(&json!({"kind":"loft","sections":[{"z":0,"points":[0,0,2,0,2,2,0,2]},{"z":1,"points":[1,-0.4,2.4,1,1,2.4,-0.4,1]}]})).unwrap();
        assert!(tw.is_closed() && tw.indices.len() / 3 > 2 * 4 * RULED_STEPS * RULED_STEPS && tw.volume() > 3.0 && tw.volume() < 4.5, "{}", tw.volume());
        // Fase 0.5 an einem 2×2-Quadrat: vier Dreiecke à 0.125 weg.
        assert!((vol(json!({"kind":"extrude","points":[0,0,2,0,2,2,0,2],"height":1,"chamfer":0.5})) - 3.5).abs() < 1e-9);
        // Eckenradius 0.5: 4 − (4 − π)·0.25.
        let rr = vol(json!({"kind":"extrude","points":[0,0,2,0,2,2,0,2],"height":1,"cornerRadius":0.5}));
        assert!((rr - (4.0 - (4.0 - pi) * 0.25)).abs() < 0.01, "{rr}");
    }

    #[test]
    fn verschieben_abbilden_und_booleans() {
        let cube = json!({"kind":"cuboid","min":[0,0,0],"max":[1,1,1]});
        let m = spec_mesh(&json!({"kind":"translate","v":[5,0,2],"solid":cube})).unwrap();
        let (lo, hi) = m.bounds().unwrap();
        assert!((lo[0] - 5.0).abs() < 1e-9 && (hi[2] - 3.0).abs() < 1e-9);
        // Spiegelung: Volumen bleibt positiv (Orientierung nachgeführt).
        assert!((vol(json!({"kind":"transform","m":[-1,0,0,0,0,1,0,0,0,0,1,0],"solid":cube})) - 1.0).abs() < 1e-9);
        let big = json!({"kind":"cuboid","min":[0,0,0],"max":[2,2,2]});
        assert!((vol(json!({"kind":"boolean","op":"difference","a":big,"b":cube})) - 7.0).abs() < 1e-9);
        assert!((vol(json!({"kind":"boolean","op":"union","a":big,"b":{"kind":"cuboid","min":[1,1,1],"max":[3,3,3]}})) - 15.0).abs() < 1e-9);
        assert!((vol(json!({"kind":"boolean","op":"intersection","a":big,"b":{"kind":"cuboid","min":[1,1,1],"max":[3,3,3]}})) - 1.0).abs() < 1e-9);
        // Unsinn: kein Netz, keine Panik.
        for bad in [json!({"kind":"cuboid","min":[0,0,0],"max":[0,1,1]}), json!({"kind":"sphere","center":[0,0],"r":1}), json!({"kind":"x"}), json!(null), json!({"kind":"extrude","points":[0,0,1,1],"height":1})] {
            assert!(spec_mesh(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn koerper_des_projekts_auf_geschosshoehe() {
        use crate::model::{DrawingLevel, ExtrudedSolid, Vec2};
        let pt = |x: f64, y: f64| Vec2 { x, y };
        let p = Project {
            drawing_levels: vec![DrawingLevel { id: "og".into(), base_elevation: Some(3.0), ..Default::default() }],
            extruded_solids: Some(vec![
                ExtrudedSolid { id: "k".into(), level_id: "og".into(), points: vec![pt(0.0, 0.0), pt(1.0, 0.0), pt(1.0, 1.0), pt(0.0, 1.0)], height: 2.0, ..Default::default() },
                ExtrudedSolid { id: "v".into(), level_id: "og".into(), points: vec![pt(0.0, 0.0), pt(1.0, 0.0), pt(1.0, 1.0)], height: 2.0, operation: Some("subtract".into()), ..Default::default() },
            ]),
            ..Default::default()
        };
        let b = body_meshes(&p);
        assert_eq!(b.len(), 1, "Prismen-Abzugskörper rechnet der Schnitt selbst");
        let zs: Vec<f64> = b[0].positions.chunks_exact(3).map(|q| q[2]).collect();
        assert!(zs.iter().all(|z| (*z - 3.0).abs() < 1e-9 || (*z - 5.0).abs() < 1e-9), "{zs:?}");
    }
}
