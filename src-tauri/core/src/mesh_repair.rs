//! Reparatur importierter Dreiecksnetze ([T5]): Ecken verschweissen (STL liefert jedes Dreieck mit eigenen
//! Ecken), entartete Dreiecke entfernen, kleine Löcher in sonst geschlossenen Netzen mit einem Fächer
//! schliessen. Reine Funktion über flache Puffer (`pos` = `[x, y, z, …]` in Metern, `idx` = Dreiecks-Indizes
//! als `f64`); Unsinn (NaN, Indizes ausserhalb) bleibt unverändert bzw. wird als entartet entfernt.

use std::collections::HashMap;

/// Verschweiss-Toleranz (Meter): 0.01 mm — fängt Rundungsdifferenzen der Formate, nicht echte Spalte.
pub const WELD_TOL: f64 = 1e-5;
/// Löcher mit höchstens so vielen Randkanten werden geschlossen.
pub const MAX_HOLE_EDGES: usize = 8;
/// Löcher nur schliessen, wenn höchstens dieser Anteil der Kanten am Rand liegt (sonst offene Fläche gewollt).
const MAX_BOUNDARY_SHARE: f64 = 0.05;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Repaired {
    pub pos: Vec<f64>,
    pub idx: Vec<f64>,
    /// Zusammengelegte Ecken.
    pub welded: usize,
    /// Entfernte entartete Dreiecke (doppelte Ecke, Fläche ≈ 0, ungültiger Index).
    pub degenerate: usize,
    /// Geschlossene Löcher.
    pub holes: usize,
}

fn tri_area2(p: &[[f64; 3]; 3]) -> f64 {
    let (a, b, c) = (p[0], p[1], p[2]);
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
}

pub fn repair(pos: &[f64], idx: &[f64]) -> Repaired {
    repair_with(pos, idx, MAX_BOUNDARY_SHARE)
}

/// Wie [`repair`], mit frei wählbarem Randanteil-Schutz (Tests, strenge Importe).
pub fn repair_with(pos: &[f64], idx: &[f64], max_boundary_share: f64) -> Repaired {
    let nv = pos.len() / 3;
    // 1) Verschweissen über ein Raster (Zelle = Toleranz); Nachbarzellen werden nicht geprüft — Ecken, die
    //    knapp über einer Zellgrenze liegen, bleiben getrennt (konservativ, nie falsch verbunden).
    let mut cell: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut map: Vec<Option<u32>> = vec![None; nv];
    let mut out_pos: Vec<f64> = Vec::new();
    for i in 0..nv {
        let p = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
        if !p.iter().all(|x| x.is_finite()) {
            continue;
        }
        let key = ((p[0] / WELD_TOL).round() as i64, (p[1] / WELD_TOL).round() as i64, (p[2] / WELD_TOL).round() as i64);
        let id = *cell.entry(key).or_insert_with(|| {
            out_pos.extend(p);
            (out_pos.len() / 3 - 1) as u32
        });
        map[i] = Some(id);
    }
    let welded = map.iter().flatten().count() - out_pos.len() / 3;
    // 2) Dreiecke übernehmen, entartete verwerfen
    let mut tris: Vec<[u32; 3]> = Vec::new();
    let mut degenerate = 0;
    for t in idx.chunks_exact(3) {
        let v: Vec<Option<u32>> = t.iter().map(|&k| if k >= 0.0 && k.fract() == 0.0 && (k as usize) < nv { map[k as usize] } else { None }).collect();
        let (Some(a), Some(b), Some(c)) = (v[0], v[1], v[2]) else {
            degenerate += 1;
            continue;
        };
        let p = |i: u32| [out_pos[3 * i as usize], out_pos[3 * i as usize + 1], out_pos[3 * i as usize + 2]];
        if a == b || b == c || a == c || tri_area2(&[p(a), p(b), p(c)]) < 1e-12 {
            degenerate += 1;
            continue;
        }
        tris.push([a, b, c]);
    }
    // 3) Löcher schliessen
    let holes = close_holes(&mut tris, max_boundary_share);
    Repaired { pos: out_pos, idx: tris.iter().flatten().map(|&k| k as f64).collect(), welded, degenerate, holes }
}

/// Kleine Randschleifen eines fast geschlossenen Netzes mit einem Fächer füllen; Anzahl geschlossener Löcher.
fn close_holes(tris: &mut Vec<[u32; 3]>, max_boundary_share: f64) -> usize {
    let mut directed: HashMap<(u32, u32), usize> = HashMap::new();
    for t in tris.iter() {
        for k in 0..3 {
            *directed.entry((t[k], t[(k + 1) % 3])).or_insert(0) += 1;
        }
    }
    // Randkanten: Kante a→b ohne Gegenkante b→a; Nicht-Mannigfaltigkeit (Kante mehrfach) → nichts anfassen
    if directed.values().any(|&n| n > 1) {
        return 0;
    }
    let boundary: Vec<(u32, u32)> = directed.keys().filter(|&&(a, b)| !directed.contains_key(&(b, a))).copied().collect();
    if boundary.is_empty() || boundary.len() as f64 > max_boundary_share * directed.len() as f64 {
        return 0;
    }
    // Der Rand läuft a→b; die fehlenden Dreiecke tragen b→a, der Deckel läuft also gegen die Randrichtung.
    let mut next: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(a, b) in &boundary {
        next.entry(a).or_default().push(b);
    }
    if next.values().any(|v| v.len() != 1) {
        return 0; // Rand verzweigt sich (Schmetterlingsecke) — nicht raten
    }
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut closed = 0;
    let mut starts: Vec<u32> = next.keys().copied().collect();
    starts.sort_unstable();
    for s in starts {
        if seen.contains(&s) {
            continue;
        }
        let mut ring = vec![s];
        let mut cur = s;
        let mut ok = true;
        loop {
            let n = next[&cur][0];
            if n == s {
                break;
            }
            if ring.len() >= MAX_HOLE_EDGES || !next.contains_key(&n) || ring.contains(&n) {
                ok = false;
                break;
            }
            ring.push(n);
            cur = n;
        }
        seen.extend(ring.iter().copied());
        if !ok || ring.len() < 3 {
            continue;
        }
        ring.reverse();
        for k in 1..ring.len() - 1 {
            tris.push([ring[0], ring[k], ring[k + 1]]);
        }
        closed += 1;
    }
    closed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Würfel mit eigenen Ecken je Dreieck (wie STL), Kantenlänge 1, nach aussen orientiert.
    fn soup(skip: &[usize]) -> (Vec<f64>, Vec<f64>) {
        let v = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.], [0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]];
        let f: [[usize; 3]; 12] = [
            [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
            [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
        ];
        let (mut pos, mut idx) = (Vec::new(), Vec::new());
        for (i, t) in f.iter().enumerate() {
            if skip.contains(&i) {
                continue;
            }
            for &k in t {
                idx.push((pos.len() / 3) as f64);
                pos.extend(v[k]);
            }
        }
        (pos, idx)
    }

    fn volume(r: &Repaired) -> f64 {
        r.idx
            .chunks(3)
            .map(|t| {
                let p = |i: f64| [r.pos[3 * i as usize], r.pos[3 * i as usize + 1], r.pos[3 * i as usize + 2]];
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
            })
            .sum()
    }

    #[test]
    fn stl_suppe_wird_verschweisst() {
        let (pos, idx) = soup(&[]);
        let r = repair(&pos, &idx);
        assert_eq!(r.pos.len() / 3, 8);
        assert_eq!(r.welded, 36 - 8);
        assert_eq!((r.degenerate, r.holes), (0, 0));
        assert!((volume(&r) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn entartete_dreiecke_fliegen_raus() {
        let (mut pos, mut idx) = soup(&[]);
        let n = (pos.len() / 3) as f64;
        pos.extend([5., 5., 5., 6., 6., 6., 7., 7., 7.]); // kollinear
        idx.extend([n, n + 1., n + 2.]);
        idx.extend([0., 0., 1.]); // doppelte Ecke
        idx.extend([0., 1., 9999.]); // Index ausserhalb
        let r = repair(&pos, &idx);
        assert_eq!(r.degenerate, 3);
        assert_eq!(r.idx.len(), 36);
    }

    #[test]
    fn offene_flaeche_bleibt_offen() {
        // Einzelnes Quadrat: Rand 100 % → gewollt offen
        let pos = [0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 1., 0.];
        let idx = [0., 1., 2., 0., 2., 3.];
        let r = repair(&pos, &idx);
        assert_eq!((r.holes, r.idx.len()), (0, 6));
    }

    #[test]
    fn loch_wird_mit_faecher_geschlossen_und_ist_nach_aussen_orientiert() {
        // Würfel ohne zwei Dreiecke (Deckel) → 4-Kanten-Loch; der Randanteil-Schutz (5 %) lässt es offen …
        let (pos, idx) = soup(&[2, 3]);
        assert_eq!(repair(&pos, &idx).holes, 0);
        // … ohne Schutz wird es geschlossen und das Netz ist wieder ein Würfel (Volumen 1, richtig herum)
        let r = repair_with(&pos, &idx, 1.0);
        assert_eq!(r.holes, 1);
        assert_eq!(r.idx.len(), 36);
        assert!((volume(&r) - 1.0).abs() < 1e-12, "Volumen {}", volume(&r));
    }

    #[test]
    fn grosses_loch_bleibt_offen() {
        // Kegelmantel ohne Boden: Randschleife mit 9 Kanten > MAX_HOLE_EDGES — wird nie geschlossen
        let n = 9;
        let mut pos = Vec::new();
        for k in 0..n {
            let a = std::f64::consts::TAU * k as f64 / n as f64;
            pos.extend([a.cos(), a.sin(), 0.0]);
        }
        pos.extend([0.0, 0.0, 1.0]);
        let mut idx = Vec::new();
        for k in 0..n {
            idx.extend([k as f64, ((k + 1) % n) as f64, n as f64]);
        }
        let r = repair_with(&pos, &idx, 1.0);
        assert_eq!(r.holes, 0);
    }
}
