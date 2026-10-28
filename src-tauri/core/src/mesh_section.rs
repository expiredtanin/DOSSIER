//! Ebenenschnitt beliebiger Dreiecksnetze ([K3c], vorher `plan/meshSection.ts`): senkrechte Ebene
//! (Schnitt: u entlang der Ebene, v = Höhe) oder waagrechte (Grundriss auf Schnitthöhe). Geschlossene
//! Netze ergeben Ringe, offene (Gelände) Linienzüge. Ecken exakt auf der Ebene werden der „hinteren"
//! Seite zugeschlagen (`d > 0` = vorn), damit sich die Segmente schliessen. Rechenreihenfolge wie in
//! TS (Punkt-Schlüssel auf 1e-6 gerundet mit `Math.round`).
//!
//! ## Schnitt
//! `cut(positions, indices, plane)` mit `plane = [0, px, py, dx, dy]` (senkrecht) oder `[1, z]`
//! (waagrecht) → `[nRinge, (k, u, v …) × nRinge, nZüge, (k, u, v …) × nZüge]`; leer bei Unsinn.
//!
//! ## Ringe → Flächen
//! `rings_to_polygons(in)` mit `in = [n, (k, u, v …) × n]` → `[p, (r, (k, u, v …) × r) × p]`
//! (Aussenring zuerst, dann Löcher; Schachtelungstiefe gerade = aussen).

use crate::jsnum::round;
use std::collections::{HashMap, VecDeque};

type P = (f64, f64);
const QUANT: f64 = 1e6;

fn key(p: P) -> (i64, i64) {
    (round(p.0 * QUANT) as i64, round(p.1 * QUANT) as i64)
}

fn chain(segs: &[(P, P)]) -> (Vec<Vec<P>>, Vec<Vec<P>>) {
    let mut by_start: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    let mut by_end: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, s) in segs.iter().enumerate() {
        by_start.entry(key(s.0)).or_default().push(i);
        by_end.entry(key(s.1)).or_default().push(i);
    }
    let mut used = vec![false; segs.len()];
    fn take(m: &mut HashMap<(i64, i64), Vec<usize>>, k: (i64, i64), used: &[bool]) -> Option<usize> {
        let l = m.get_mut(&k)?;
        while let Some(i) = l.pop() {
            if !used[i] {
                return Some(i);
            }
        }
        None
    }
    let mut rings = Vec::new();
    let mut lines = Vec::new();
    for i in 0..segs.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut pts: VecDeque<P> = VecDeque::from([segs[i].0, segs[i].1]);
        let start_key = key(pts[0]);
        loop {
            let k = key(*pts.back().unwrap());
            if k == start_key && pts.len() > 2 {
                break;
            }
            let Some(n) = take(&mut by_start, k, &used) else { break };
            used[n] = true;
            pts.push_back(segs[n].1);
        }
        if key(*pts.back().unwrap()) == start_key && pts.len() > 3 {
            pts.pop_back();
            rings.push(pts.into_iter().collect());
            continue;
        }
        let mut closed = false;
        loop {
            let k = key(pts[0]);
            let Some(n) = take(&mut by_end, k, &used) else { break };
            used[n] = true;
            pts.push_front(segs[n].0);
            if key(pts[0]) == key(*pts.back().unwrap()) {
                pts.pop_front();
                rings.push(pts.iter().copied().collect());
                closed = true;
                break;
            }
        }
        if !closed && pts.len() >= 2 {
            lines.push(pts.into_iter().collect());
        }
    }
    (rings, lines)
}

pub fn cut(positions: &[f64], indices: &[f64], plane: &[f64]) -> Vec<f64> {
    let nv = positions.len() / 3;
    let vertical = match plane.first() {
        Some(&k) if k == 0.0 && plane.len() == 5 => true,
        Some(&k) if k == 1.0 && plane.len() == 2 => false,
        _ => return Vec::new(),
    };
    if positions.iter().chain(indices).chain(plane).any(|v| !v.is_finite())
        || indices.iter().any(|&i| i < 0.0 || i.fract() != 0.0 || i as usize >= nv)
    {
        return Vec::new();
    }
    let mut dist = vec![0.0; nv];
    let mut c0 = vec![0.0; nv];
    let mut c1 = vec![0.0; nv];
    for i in 0..nv {
        let (x, y, z) = (positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        if vertical {
            let (px, py, dx, dy) = (plane[1], plane[2], plane[3], plane[4]);
            dist[i] = (x - px) * dy - (y - py) * dx;
            c0[i] = (x - px) * dx + (y - py) * dy;
            c1[i] = z;
        } else {
            dist[i] = z - plane[1];
            c0[i] = x;
            c1[i] = y;
        }
    }
    let mut edge_pt: HashMap<(usize, usize), P> = HashMap::new();
    let mut crossing = |a: usize, b: usize| -> P {
        let k = if a < b { (a, b) } else { (b, a) };
        *edge_pt.entry(k).or_insert_with(|| {
            let t = dist[a] / (dist[a] - dist[b]);
            (c0[a] + (c0[b] - c0[a]) * t, c1[a] + (c1[b] - c1[a]) * t)
        })
    };
    let mut segs: Vec<(P, P)> = Vec::new();
    let mut t = 0;
    while t + 2 < indices.len() {
        let (a, b, c) = (indices[t] as usize, indices[t + 1] as usize, indices[t + 2] as usize);
        t += 3;
        let (sa, sb, sc) = (dist[a] > 0.0, dist[b] > 0.0, dist[c] > 0.0);
        if sa == sb && sb == sc {
            continue;
        }
        let odd = if sa != sb && sa != sc { a } else if sb != sa && sb != sc { b } else { c };
        let o1 = if odd == a { b } else if odd == b { c } else { a };
        let o2 = if odd == a { c } else if odd == b { a } else { b };
        let p = crossing(odd, o1);
        let q = crossing(odd, o2);
        if (p.0 - q.0).abs() < 1e-9 && (p.1 - q.1).abs() < 1e-9 {
            continue;
        }
        segs.push(if dist[odd] > 0.0 { (q, p) } else { (p, q) });
    }
    let (rings, lines) = chain(&segs);
    let mut f = vec![rings.len() as f64];
    for r in &rings {
        push_ring(&mut f, r);
    }
    f.push(lines.len() as f64);
    for l in &lines {
        push_ring(&mut f, l);
    }
    f
}

fn push_ring(f: &mut Vec<f64>, r: &[P]) {
    f.push(r.len() as f64);
    for p in r {
        f.extend([p.0, p.1]);
    }
}

fn ring_area(r: &[P]) -> f64 {
    let mut a = 0.0;
    for i in 0..r.len() {
        let p = r[i];
        let q = r[(i + 1) % r.len()];
        a += p.0 * q.1 - q.0 * p.1;
    }
    a / 2.0
}

fn point_in_ring(p: P, r: &[P]) -> bool {
    let mut inside = false;
    let mut j = r.len() - 1;
    for i in 0..r.len() {
        let (xi, yi) = r[i];
        let (xj, yj) = r[j];
        if (yi > p.1) != (yj > p.1) && p.0 < ((xj - xi) * (p.1 - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn rings_to_polygons(inp: &[f64]) -> Vec<f64> {
    if inp.is_empty() || inp.iter().any(|v| !v.is_finite()) || inp[0] < 0.0 {
        return Vec::new();
    }
    let n = inp[0] as usize;
    let mut rings: Vec<Vec<P>> = Vec::with_capacity(n);
    let mut i = 1;
    for _ in 0..n {
        let Some(&k) = inp.get(i) else { return Vec::new() };
        if k < 0.0 || i + 1 + 2 * k as usize > inp.len() {
            return Vec::new();
        }
        let k = k as usize;
        rings.push((0..k).map(|j| (inp[i + 1 + 2 * j], inp[i + 2 + 2 * j])).collect());
        i += 1 + 2 * k;
    }
    if i != inp.len() {
        return Vec::new();
    }
    let mut items: Vec<(Vec<P>, f64)> = rings
        .into_iter()
        .filter(|r| r.len() >= 3 && ring_area(r).abs() > 1e-12)
        .map(|r| {
            let a = ring_area(&r).abs();
            (r, a)
        })
        .collect();
    items.sort_by(|a, b| (b.1 - a.1).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut depth = vec![0usize; items.len()];
    let mut parent: Vec<Option<usize>> = vec![None; items.len()];
    for i in 0..items.len() {
        for j in (0..i).rev() {
            if point_in_ring(items[i].0[0], &items[j].0) {
                parent[i] = Some(j);
                depth[i] = depth[j] + 1;
                break;
            }
        }
    }
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut idx: HashMap<usize, usize> = HashMap::new();
    for i in 0..items.len() {
        if depth[i] % 2 == 0 {
            idx.insert(i, out.len());
            out.push(vec![i]);
        }
    }
    for i in 0..items.len() {
        if depth[i] % 2 == 1 {
            if let Some(owner) = parent[i].and_then(|p| idx.get(&p)) {
                out[*owner].push(i);
            }
        }
    }
    let mut f = vec![out.len() as f64];
    for poly in &out {
        f.push(poly.len() as f64);
        for &r in poly {
            push_ring(&mut f, &items[r].0);
        }
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Würfel 0..2 (12 Dreiecke, nach aussen gewunden).
    fn cube() -> (Vec<f64>, Vec<f64>) {
        let mut p = Vec::new();
        for z in [0.0, 2.0] {
            for y in [0.0, 2.0] {
                for x in [0.0, 2.0] {
                    p.extend([x, y, z]);
                }
            }
        }
        let f = [
            0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
        ];
        (p, f.iter().map(|&i| i as f64).collect())
    }

    #[test]
    fn waagrechter_schnitt_ergibt_einen_ring() {
        let (p, f) = cube();
        let r = cut(&p, &f, &[1.0, 1.0]);
        assert_eq!(r[0], 1.0);
        // Die Diagonalen der Seitenflächen liefern Zwischenpunkte: 4 Ecken + 4 Mitten.
        assert_eq!(r[1], 8.0);
        assert_eq!(r[2 + 16], 0.0); // keine Linienzüge
    }

    #[test]
    fn ebene_ausserhalb_ist_leer_aber_gueltig() {
        let (p, f) = cube();
        assert_eq!(cut(&p, &f, &[1.0, 10.0]), vec![0.0, 0.0]);
    }

    #[test]
    fn unsinn_ist_leer() {
        assert!(cut(&[0.0, 0.0, 0.0], &[0.0, 1.0, 2.0], &[1.0, 0.0]).is_empty());
        assert!(cut(&[0.0; 9], &[0.0, 1.0, 2.0], &[7.0]).is_empty());
    }

    #[test]
    fn loch_gehoert_zum_aussenring() {
        let outer = [4.0, 0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0];
        let hole = [4.0, 4.0, 4.0, 6.0, 4.0, 6.0, 6.0, 4.0, 6.0];
        let mut inp = vec![2.0];
        inp.extend(outer);
        inp.extend(hole);
        let f = rings_to_polygons(&inp);
        assert_eq!(&f[..3], &[1.0, 2.0, 4.0]);
    }
}
