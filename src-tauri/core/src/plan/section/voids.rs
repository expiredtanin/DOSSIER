//! Aussparungen im Schnitt: Abzugskörper, Körper mit Abzugs-Rolle und Taschen in Wänden werden als
//! Ringe aus den Schnitt-Bändern abgezogen (Polygon-Booleans über den Kern). Aufgerufen von
//! `compute_section()` (`mod.rs`).

use super::*;

pub(super) fn encode_rings(rings: &[&[[f64; 2]]]) -> Vec<f64> {
    let mut b = vec![rings.len() as f64];
    for r in rings {
        b.push(r.len() as f64);
        for q in *r {
            b.extend(q);
        }
    }
    b
}

/// `subtractVoidsInSection`.
pub(super) fn subtract_voids_in_section(cuts: Vec<Cut>, p: &Project, base: (f64, f64), u: (f64, f64)) -> Vec<Cut> {
    let mut rects: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut any = false;
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if !is_void_solid(s) {
            continue;
        }
        any = true;
        let z0 = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + s.base_offset.unwrap_or(0.0);
        let z1 = z0 + s.height;
        let mut pts = vec![s.points.len() as f64];
        for q in &s.points {
            pts.extend([q.x, q.y]);
        }
        let f = crate::voids::section_rects_flat(&pts, &[base.0, base.1, u.0, u.1]);
        for k in 0..f.first().copied().unwrap_or(0.0) as usize {
            let (u0, u1) = (f[1 + 2 * k], f[2 + 2 * k]);
            rects.push(vec![[u0, z0], [u1, z0], [u1, z1], [u0, z1]]);
        }
    }
    if !any || rects.is_empty() {
        return cuts;
    }
    subtract_rings_from_cuts(cuts, &rects)
}

/// [G1] Ob ein Körper-Netz zu einem Abzugskörper gehört.
pub(super) fn is_subtract_body(p: &Project, b: &BodyMesh) -> bool {
    p.extruded_solids.as_deref().and_then(|s| s.get(b.index)).is_some_and(|s| s.operation.as_deref() == Some("subtract"))
}

/// [G1] Abzugskörper beliebiger Form: Netz mit der Ebene schneiden, Flächen (Löcher als Schlüsselloch)
/// von allen bisherigen Schnittflächen abziehen.
pub(super) fn subtract_body_voids_in_section(cuts: Vec<Cut>, voids: &[&BodyMesh], base: (f64, f64), u: (f64, f64)) -> Vec<Cut> {
    let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
    for b in voids {
        let (r, _) = cut_mesh(&b.positions, &b.indices, base, u);
        for poly in rings_to_polygons(&r) {
            rings.push(if poly.len() > 1 { keyhole(&poly).0 } else { poly[0].clone() });
        }
    }
    rings.retain(|r| r.len() >= 3);
    if rings.is_empty() {
        return cuts;
    }
    subtract_rings_from_cuts(cuts, &rings)
}

/// Zieht `rings` von jeder Schnittfläche ab (Ränder auf den Schnittkanten ohne Strich); Fehlschlag ⇒ unverändert.
fn subtract_rings_from_cuts(cuts: Vec<Cut>, rings: &[Vec<[f64; 2]>]) -> Vec<Cut> {
    let refs: Vec<&[[f64; 2]]> = rings.iter().map(|r| r.as_slice()).collect();
    let cutters = encode_rings(&refs);
    let mut out = Vec::with_capacity(cuts.len());
    for cp in cuts {
        if cp.pts.len() < 3 {
            out.push(cp);
            continue;
        }
        let ring = &encode_rings(&[cp.pts.as_slice()])[1..];
        let nse = cp.nse.as_deref().unwrap_or(&[]);
        let mut ns = vec![nse.len() as f64];
        ns.extend(nse);
        let f = crate::voids::subtract_rings_flat(ring, &cutters, &ns);
        if f.is_empty() || f[0] < 0.0 {
            out.push(cp);
            continue;
        }
        let mut i = 1;
        for _ in 0..f[0] as usize {
            let n = f[i] as usize;
            i += 1;
            let pts: Vec<[f64; 2]> = (0..n).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect();
            i += 2 * n;
            let m = f[i] as usize;
            i += 1;
            let nse: Vec<f64> = f[i..i + m].to_vec();
            i += m;
            out.push(Cut { pts, nse: (!nse.is_empty()).then_some(nse), ..cp.clone() });
        }
    }
    out
}

/// [95] Taschen der Taschen-Schiebetüren aus den geschnittenen Wandschichten aussparen (Hohlraum samt
/// Blattbahn über die Türhöhe, wie im 3D-Körper).
pub(super) fn subtract_pockets_in_section(cuts: Vec<Cut>, p: &Project, base: (f64, f64), u: (f64, f64)) -> Vec<Cut> {
    let by_wall = p.openings_by_wall();
    let mut rects: Vec<Vec<[f64; 2]>> = Vec::new();
    for w in &p.walls {
        let Some(ops) = by_wall.get(w.id.as_str()) else { continue };
        let arc = crate::wall_arc::WallArc::of_wall(w);
        let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
        let l = hypot2(dx, dy);
        if !(l > 1e-9) {
            continue;
        }
        let (ux, uy) = (dx / l, dy / l);
        for [u0, u1, n0, n1, z0, z1] in model3d::wall_pocket_cuts(p, w, ops) {
            // Grundriss der Tasche; Bogenwand ([T2]): Ring entlang des Bogens (Achsmass = Bogenlänge).
            let ring: Vec<[f64; 2]> = match arc {
                Some(a) => {
                    let st = a.stations(u0, u1, a.r_max(n0, n1));
                    let side = |n: f64| st.iter().map(move |&s| a.point(s, n)).map(|q| [q.x, q.y]);
                    side(n0).chain(side(n1).rev()).collect()
                }
                None => {
                    let at = |a: f64, n: f64| [w.start.x + ux * a - uy * n, w.start.y + uy * a + ux * n];
                    vec![at(u0, n0), at(u1, n0), at(u1, n1), at(u0, n1)]
                }
            };
            let mut pts = vec![ring.len() as f64];
            for q in ring {
                pts.extend(q);
            }
            let f = crate::voids::section_rects_flat(&pts, &[base.0, base.1, u.0, u.1]);
            for k in 0..f.first().copied().unwrap_or(0.0) as usize {
                let (a, b) = (f[1 + 2 * k], f[2 + 2 * k]);
                rects.push(vec![[a, z0], [b, z0], [b, z1], [a, z1]]);
            }
        }
    }
    if rects.is_empty() {
        return cuts;
    }
    let refs: Vec<&[[f64; 2]]> = rects.iter().map(|r| r.as_slice()).collect();
    let cutters = encode_rings(&refs);
    let mut out = Vec::with_capacity(cuts.len());
    for cp in cuts {
        if cp.pts.len() < 3 || cp.kind != Kind::Wall {
            out.push(cp);
            continue;
        }
        let ring = &encode_rings(&[cp.pts.as_slice()])[1..];
        let nse = cp.nse.as_deref().unwrap_or(&[]);
        let mut ns = vec![nse.len() as f64];
        ns.extend(nse);
        let f = crate::voids::subtract_rings_flat(ring, &cutters, &ns);
        if f.is_empty() || f[0] < 0.0 {
            out.push(cp);
            continue;
        }
        let mut i = 1;
        for _ in 0..f[0] as usize {
            let n = f[i] as usize;
            i += 1;
            let pts: Vec<[f64; 2]> = (0..n).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect();
            i += 2 * n;
            let m = f[i] as usize;
            i += 1;
            let nse: Vec<f64> = f[i..i + m].to_vec();
            i += m;
            out.push(Cut { pts, nse: (!nse.is_empty()).then_some(nse), ..cp.clone() });
        }
    }
    out
}

/// Liest `[n, (k, u, v …) × n]` ab `i`.
pub(super) fn read_rings(f: &[f64], i: &mut usize) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    let n = f[*i] as usize;
    *i += 1;
    for _ in 0..n {
        let k = f[*i] as usize;
        *i += 1;
        out.push((0..k).map(|j| [f[*i + 2 * j], f[*i + 2 * j + 1]]).collect());
        *i += 2 * k;
    }
    out
}
