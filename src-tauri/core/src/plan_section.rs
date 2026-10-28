//! Schnitt-Bänder ([K3c]): Dominanz-Subtraktion und Verschmelzung achsparalleler Schnitt-Rechtecke
//! (`toSection.ts`: `subtractDominantBands`, `mergeSameComponentBands`) sowie die Vereinigung zu
//! Aussenringen (`unionRectOutlines`). Stil, Füllung, Schraffur und Herkunft hängen in TS an den
//! Bändern; Rust rechnet nur auf Rechtecken. Rechenreihenfolge wie in TS.
//!
//! ## Dominanz
//! `dominant_bands(in)` mit `in = [n, Band × n]`, Band = `[gueltig, uMin, uMax, vMin, vMax, prio, comp]`
//! (`gueltig` 0 = weniger als 3 Ecken; `prio` NaN = keine; `comp` < 0 = keine Komponente) →
//! `[m, Eintrag × m]`, Eintrag = `[quelle, istRechteck, uMin, uMax, vMin, vMax]`. `istRechteck` 0 =
//! Quellband unverändert übernehmen, sonst neues Rechteck mit Stil von `quelle`.
//!
//! ## Umrisse
//! `union_outlines(in)` mit `in = [n, (uMin, uMax, vMin, vMax) × n]` → `[r, (k, x, y × k) × r]`.

use crate::jsnum::{max, min};
use std::collections::HashMap;

const RECT_EPS: f64 = 1e-6;

#[derive(Clone, Copy)]
struct Rect {
    u_min: f64,
    u_max: f64,
    v_min: f64,
    v_max: f64,
}

#[derive(Clone, Copy)]
struct Band {
    rect: Option<Rect>,
    prio: Option<f64>,
    comp: Option<i64>,
}

struct Out {
    src: usize,
    rect: Option<Rect>,
}

fn subtract_rect(base: Rect, cutter: Rect) -> Vec<Rect> {
    let o_min_u = max(base.u_min, cutter.u_min);
    let o_max_u = min(base.u_max, cutter.u_max);
    let o_min_v = max(base.v_min, cutter.v_min);
    let o_max_v = min(base.v_max, cutter.v_max);
    if o_max_u - o_min_u <= RECT_EPS || o_max_v - o_min_v <= RECT_EPS {
        return vec![base];
    }
    let mut out = Vec::new();
    let mut push = |r: Rect| {
        if r.u_max - r.u_min > RECT_EPS && r.v_max - r.v_min > RECT_EPS {
            out.push(r);
        }
    };
    push(Rect { u_min: base.u_min, u_max: o_min_u, v_min: base.v_min, v_max: base.v_max });
    push(Rect { u_min: o_max_u, u_max: base.u_max, v_min: base.v_min, v_max: base.v_max });
    push(Rect { u_min: o_min_u, u_max: o_max_u, v_min: base.v_min, v_max: o_min_v });
    push(Rect { u_min: o_min_u, u_max: o_max_u, v_min: o_max_v, v_max: base.v_max });
    out
}

fn rect_union_if_rect(a: Rect, b: Rect) -> Option<Rect> {
    let e = RECT_EPS;
    let a_in_b = b.u_min - a.u_min <= e && a.u_max - b.u_max <= e && b.v_min - a.v_min <= e && a.v_max - b.v_max <= e;
    if a_in_b {
        return Some(b);
    }
    let b_in_a = a.u_min - b.u_min <= e && b.u_max - a.u_max <= e && a.v_min - b.v_min <= e && b.v_max - a.v_max <= e;
    if b_in_a {
        return Some(a);
    }
    let u_aligned = (a.u_min - b.u_min).abs() <= e && (a.u_max - b.u_max).abs() <= e;
    let v_aligned = (a.v_min - b.v_min).abs() <= e && (a.v_max - b.v_max).abs() <= e;
    let v_touch = a.v_max >= b.v_min - e && b.v_max >= a.v_min - e;
    let u_touch = a.u_max >= b.u_min - e && b.u_max >= a.u_min - e;
    if (u_aligned && v_touch) || (v_aligned && u_touch) {
        return Some(Rect {
            u_min: min(a.u_min, b.u_min),
            u_max: max(a.u_max, b.u_max),
            v_min: min(a.v_min, b.v_min),
            v_max: max(a.v_max, b.v_max),
        });
    }
    None
}

fn merge_same_component(bands: &[Band], list: Vec<Out>) -> Vec<Out> {
    let mut out = list;
    let mut merged = true;
    while merged {
        merged = false;
        let mut i = 0;
        while i < out.len() && !merged {
            let bi = bands[out[i].src];
            // Verschmolzene Rechtecke erben Komponente/Priorität des Quellbands.
            if bi.comp.is_none() || bi.prio.is_none() {
                i += 1;
                continue;
            }
            let ri = match out[i].rect.or(bi.rect) {
                Some(r) => r,
                None => {
                    i += 1;
                    continue;
                }
            };
            for j in i + 1..out.len() {
                let bj = bands[out[j].src];
                if bj.comp != bi.comp || bj.prio != bi.prio {
                    continue;
                }
                let rj = match out[j].rect.or(bj.rect) {
                    Some(r) => r,
                    None => continue,
                };
                if let Some(u) = rect_union_if_rect(ri, rj) {
                    out[i].rect = Some(u);
                    out.remove(j);
                    merged = true;
                    break;
                }
            }
            i += 1;
        }
    }
    out
}

pub fn dominant_bands(inp: &[f64]) -> Vec<f64> {
    if inp.is_empty() || !inp[0].is_finite() || inp[0] < 0.0 {
        return Vec::new();
    }
    let n = inp[0] as usize;
    if inp.len() != 1 + 7 * n {
        return Vec::new();
    }
    let bands: Vec<Band> = (0..n)
        .map(|k| {
            let b = &inp[1 + 7 * k..8 + 7 * k];
            Band {
                rect: (b[0] != 0.0).then_some(Rect { u_min: b[1], u_max: b[2], v_min: b[3], v_max: b[4] }),
                prio: (!b[5].is_nan()).then_some(b[5]),
                comp: (b[6] >= 0.0).then_some(b[6] as i64),
            }
        })
        .collect();
    let mut out: Vec<Out> = Vec::new();
    for i in 0..n {
        let (base, prio) = match (bands[i].rect, bands[i].prio) {
            (Some(r), Some(p)) => (r, p),
            _ => {
                out.push(Out { src: i, rect: None });
                continue;
            }
        };
        let mut pieces = vec![base];
        for j in 0..n {
            if pieces.is_empty() {
                break;
            }
            if j == i {
                continue;
            }
            let (cutter, other) = match (bands[j].rect, bands[j].prio) {
                (Some(c), Some(p)) => (c, p),
                _ => continue,
            };
            if other <= prio {
                continue;
            }
            let mut next = Vec::new();
            for p in pieces {
                next.extend(subtract_rect(p, cutter));
            }
            pieces = next;
        }
        for p in pieces {
            out.push(Out { src: i, rect: Some(p) });
        }
    }
    let out = merge_same_component(&bands, out);
    let mut f = Vec::with_capacity(1 + 6 * out.len());
    f.push(out.len() as f64);
    for o in &out {
        match o.rect {
            Some(r) => f.extend([o.src as f64, 1.0, r.u_min, r.u_max, r.v_min, r.v_max]),
            None => f.extend([o.src as f64, 0.0, 0.0, 0.0, 0.0, 0.0]),
        }
    }
    f
}

fn signed_area(ring: &[(f64, f64)]) -> f64 {
    let mut a = 0.0;
    for i in 0..ring.len() {
        let (x0, y0) = ring[i];
        let (x1, y1) = ring[(i + 1) % ring.len()];
        a += x0 * y1 - x1 * y0;
    }
    a / 2.0
}

fn sorted_unique(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v.dedup_by(|a, b| *a == *b);
    v
}

pub fn union_outlines(inp: &[f64]) -> Vec<f64> {
    if inp.is_empty() || !inp[0].is_finite() || inp[0] < 0.0 {
        return Vec::new();
    }
    let n = inp[0] as usize;
    if inp.len() != 1 + 4 * n || inp.iter().any(|v| !v.is_finite()) {
        return Vec::new();
    }
    let rects: Vec<Rect> = (0..n)
        .map(|k| Rect { u_min: inp[1 + 4 * k], u_max: inp[2 + 4 * k], v_min: inp[3 + 4 * k], v_max: inp[4 + 4 * k] })
        .collect();
    let xs = sorted_unique(rects.iter().flat_map(|r| [r.u_min, r.u_max]).collect());
    let ys = sorted_unique(rects.iter().flat_map(|r| [r.v_min, r.v_max]).collect());
    if xs.len() < 2 || ys.len() < 2 {
        return vec![0.0];
    }
    let nx = xs.len() - 1;
    let ny = ys.len() - 1;
    let mut cell = vec![vec![false; ny]; nx];
    for i in 0..nx {
        for j in 0..ny {
            let cx = (xs[i] + xs[i + 1]) / 2.0;
            let cy = (ys[j] + ys[j + 1]) / 2.0;
            cell[i][j] = rects.iter().any(|r| cx > r.u_min && cx < r.u_max && cy > r.v_min && cy < r.v_max);
        }
    }
    let at = |i: isize, j: isize| i >= 0 && j >= 0 && (i as usize) < nx && (j as usize) < ny && cell[i as usize][j as usize];
    // Gerichtete Randkanten in Einfügereihenfolge (wie `Map`: erneutes `set` behält die Position).
    let mut keys: Vec<(usize, usize)> = Vec::new();
    let mut next: HashMap<(usize, usize), (usize, usize)> = HashMap::new();
    let mut set = |k: (usize, usize), v: (usize, usize)| {
        if next.insert(k, v).is_none() {
            keys.push(k);
        }
    };
    for i in 0..nx {
        for j in 0..ny {
            if !cell[i][j] {
                continue;
            }
            let (ii, jj) = (i as isize, j as isize);
            if !at(ii, jj - 1) {
                set((i, j), (i + 1, j));
            }
            if !at(ii + 1, jj) {
                set((i + 1, j), (i + 1, j + 1));
            }
            if !at(ii, jj + 1) {
                set((i + 1, j + 1), (i, j + 1));
            }
            if !at(ii - 1, jj) {
                set((i, j + 1), (i, j));
            }
        }
    }
    let mut rings: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut used: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    for &start in &keys {
        if used.contains(&start) {
            continue;
        }
        let mut ring: Vec<(f64, f64)> = Vec::new();
        let mut k = start;
        while !used.contains(&k) {
            used.insert(k);
            ring.push((xs[k.0], ys[k.1]));
            match next.get(&k) {
                Some(&nk) => k = nk,
                None => break,
            }
        }
        let len = ring.len();
        let simple: Vec<(f64, f64)> = ring
            .iter()
            .enumerate()
            .filter(|(idx, p)| {
                let a = ring[(idx + len - 1) % len];
                let b = ring[(idx + 1) % len];
                !((a.0 == p.0 && p.0 == b.0) || (a.1 == p.1 && p.1 == b.1))
            })
            .map(|(_, p)| *p)
            .collect();
        if simple.len() >= 4 && signed_area(&simple) > 0.0 {
            rings.push(simple);
        }
    }
    let mut f = vec![rings.len() as f64];
    for r in &rings {
        f.push(r.len() as f64);
        for p in r {
            f.push(p.0);
            f.push(p.1);
        }
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    fn band(u0: f64, u1: f64, v0: f64, v1: f64, prio: f64, comp: f64) -> [f64; 7] {
        [1.0, u0, u1, v0, v1, prio, comp]
    }

    #[test]
    fn hoehere_prioritaet_schneidet_weg() {
        let mut inp = vec![2.0];
        inp.extend(band(0.0, 1.0, 0.0, 1.0, 10.0, 0.0));
        inp.extend(band(0.0, 1.0, 0.5, 1.0, 100.0, 1.0));
        let f = dominant_bands(&inp);
        // Basis behält die untere Hälfte, Cutter bleibt ganz.
        assert_eq!(f[0], 2.0);
        assert_eq!(&f[1..7], &[0.0, 1.0, 0.0, 1.0, 0.0, 0.5]);
    }

    fn r(u0: f64, u1: f64, v0: f64, v1: f64) -> Rect {
        Rect { u_min: u0, u_max: u1, v_min: v0, v_max: v1 }
    }

    #[test]
    fn rechteck_subtraktion() {
        // Kein Überlapp, nur Berührung, volle Überdeckung, Ecke, Randstreifen.
        assert_eq!(subtract_rect(r(0.0, 1.0, 0.0, 1.0), r(2.0, 3.0, 2.0, 3.0)).len(), 1);
        assert_eq!(subtract_rect(r(0.0, 1.0, 0.0, 1.0), r(1.0, 2.0, 0.0, 1.0)).len(), 1);
        assert!(subtract_rect(r(1.0, 2.0, 1.0, 2.0), r(0.0, 3.0, 0.0, 3.0)).is_empty());
        let ecke = subtract_rect(r(0.0, 2.0, 0.0, 2.0), r(1.0, 3.0, 1.0, 3.0));
        let flaeche: f64 = ecke.iter().map(|x| (x.u_max - x.u_min) * (x.v_max - x.v_min)).sum();
        assert_eq!((ecke.len(), flaeche), (2, 3.0));
        let rand = subtract_rect(r(0.0, 2.0, 0.0, 2.0), r(-1.0, 3.0, 1.0, 3.0));
        assert_eq!(rand.len(), 1);
        assert_eq!((rand[0].v_min, rand[0].v_max), (0.0, 1.0));
    }

    #[test]
    fn gleiche_komponente_verschmilzt() {
        let mut inp = vec![2.0];
        inp.extend(band(0.0, 1.0, 0.0, 1.0, 10.0, 3.0));
        inp.extend(band(1.0, 2.0, 0.0, 1.0, 10.0, 3.0));
        let f = dominant_bands(&inp);
        assert_eq!(f[0], 1.0);
        assert_eq!(&f[1..7], &[0.0, 1.0, 0.0, 2.0, 0.0, 1.0]);
    }

    #[test]
    fn l_form_ergibt_einen_ring() {
        let f = union_outlines(&[2.0, 0.0, 2.0, 0.0, 1.0, 0.0, 1.0, 0.0, 2.0]);
        assert_eq!(f[0], 1.0);
        assert_eq!(f[1], 6.0);
    }

    #[test]
    fn unsinn_ist_leer() {
        assert!(dominant_bands(&[f64::NAN]).is_empty());
        assert!(dominant_bands(&[2.0, 1.0]).is_empty());
        assert!(union_outlines(&[1.0, f64::NAN, 1.0, 0.0, 1.0]).is_empty());
    }
}
