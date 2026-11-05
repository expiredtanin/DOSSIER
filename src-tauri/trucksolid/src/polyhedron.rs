// [T1] Polyeder-Körper: geschlossenes Dreiecks-Mesh → echter truck-B-Rep-Körper mit ebenen Flächen.
//
// Ablauf: Eingabe prüfen → Eckpunkte verschweissen → entartete/doppelte Dreiecke verwerfen →
// Kanten-Mannigfaltigkeit prüfen (jede gerichtete Kante genau einmal, Gegenkante vorhanden) →
// komplanare Nachbardreiecke zu Flächenregionen zusammenfassen → Randschleifen je Region
// (Aussenrand + Löcher) → kollineare Zwischenpunkte zwischen genau zwei Regionen entfernen →
// truck: Ecken, geteilte Kanten (Geraden), Flächen (`Face::try_new` auf eigener Ebene), Shell,
// `Solid::try_new`.
//
// Nie Panic (WASM bricht sonst ab): nur `try_*`-Konstruktoren von truck, Kanten nie zwischen
// derselben Ecke, jeder Fehler wird `Err` → der Aufrufer bleibt beim bisherigen Mesh-Verhalten.
// Bewusst nicht unterstützt (→ `Err`): offene/nicht-mannigfaltige Netze, T-Stösse, mehrere
// getrennte Teile oder Hohlräume, Flächen, die sich an einer Ecke selbst berühren.

use std::collections::{HashMap, HashSet, VecDeque};
use truck_modeling::*;

type Res<T> = std::result::Result<T, String>;

/// Obergrenze der Dreiecke (Laufzeit im WASM; grössere Netze bleiben Mesh).
const MAX_TRIS: usize = 200_000;

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

struct Union(Vec<usize>);
impl Union {
    fn find(&mut self, mut i: usize) -> usize {
        while self.0[i] != i {
            self.0[i] = self.0[self.0[i]];
            i = self.0[i];
        }
        i
    }
    fn join(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.0[ra] = rb;
        }
    }
}

/// Bereinigtes, geschlossenes, mannigfaltiges Netz (verschweisste Ecken, aussen orientiert).
struct Clean {
    pts: Vec<V3>,
    tris: Vec<[usize; 3]>,
    scale: f64,
}

fn clean(positions: &[f64], indices: &[u32]) -> Res<Clean> {
    if positions.is_empty() || positions.len() % 3 != 0 || indices.len() % 3 != 0 {
        return Err("Polyeder: Puffer unvollständig".into());
    }
    if indices.len() / 3 < 4 || indices.len() / 3 > MAX_TRIS {
        return Err("Polyeder: Dreieckszahl ausserhalb des Bereichs".into());
    }
    if positions.iter().any(|x| !x.is_finite()) {
        return Err("Polyeder: ungültige Koordinate".into());
    }
    let n = positions.len() / 3;
    if indices.iter().any(|&i| i as usize >= n) {
        return Err("Polyeder: Index ausserhalb".into());
    }
    let raw: Vec<V3> = positions.chunks(3).map(|c| [c[0], c[1], c[2]]).collect();
    let (mut lo, mut hi) = (raw[0], raw[0]);
    for p in &raw {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let scale = norm(sub(hi, lo));
    if !(scale > 1e-9) {
        return Err("Polyeder: ohne Ausdehnung".into());
    }
    // Verschweissen auf einem Raster (Nachbarzellen mitprüfen).
    let weld = 1e-9 * scale.max(1.0);
    let cell = |p: V3| -> [i64; 3] {
        [
            (p[0] / weld).floor() as i64,
            (p[1] / weld).floor() as i64,
            (p[2] / weld).floor() as i64,
        ]
    };
    let mut grid: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    let mut pts: Vec<V3> = Vec::new();
    let mut remap = vec![0usize; n];
    for (i, p) in raw.iter().enumerate() {
        let c = cell(*p);
        let mut found = None;
        'outer: for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) {
                        for &j in list {
                            if norm(sub(pts[j], *p)) <= weld {
                                found = Some(j);
                                break 'outer;
                            }
                        }
                    }
                }
            }
        }
        remap[i] = found.unwrap_or_else(|| {
            pts.push(*p);
            grid.entry(c).or_default().push(pts.len() - 1);
            pts.len() - 1
        });
    }
    // Entartete und doppelte Dreiecke verwerfen; gegenläufige Paare (Innenhaut) heben sich auf.
    let min_area2 = (1e-12 * scale * scale).powi(2);
    let canon = |t: [usize; 3]| -> [usize; 3] {
        let m = (0..3).min_by_key(|&k| t[k]).unwrap_or(0);
        [t[m], t[(m + 1) % 3], t[(m + 2) % 3]]
    };
    let mut seen: HashSet<[usize; 3]> = HashSet::new();
    let mut tris: Vec<[usize; 3]> = Vec::new();
    for t in indices.chunks(3) {
        let t = [
            remap[t[0] as usize],
            remap[t[1] as usize],
            remap[t[2] as usize],
        ];
        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
            continue;
        }
        let c = cross(sub(pts[t[1]], pts[t[0]]), sub(pts[t[2]], pts[t[0]]));
        if dot(c, c) <= min_area2 {
            continue;
        }
        let k = canon(t);
        if seen.insert(k) {
            tris.push(k);
        }
    }
    let rev: HashSet<[usize; 3]> = tris
        .iter()
        .filter(|t| seen.contains(&canon([t[0], t[2], t[1]])))
        .copied()
        .collect();
    tris.retain(|t| !rev.contains(t));
    if tris.len() < 4 {
        return Err("Polyeder: zu wenige Dreiecke".into());
    }
    // Aussen orientieren (Volumen positiv).
    let vol: f64 = tris
        .iter()
        .map(|t| dot(pts[t[0]], cross(pts[t[1]], pts[t[2]])))
        .sum::<f64>()
        / 6.0;
    if vol.abs() <= 1e-12 * scale.powi(3) {
        return Err("Polyeder: ohne Volumen".into());
    }
    if vol < 0.0 {
        tris.iter_mut().for_each(|t| t.swap(1, 2));
    }
    Ok(Clean { pts, tris, scale })
}

/// Baut den B-Rep-Körper; `Err`, wenn das Netz kein geschlossenes, mannigfaltiges Polyeder ist.
pub fn polyhedron_solid(positions: &[f64], indices: &[u32]) -> Res<Solid> {
    let Clean { pts, tris, scale } = clean(positions, indices)?;
    // Gerichtete Kanten: jede genau einmal, jede mit Gegenkante.
    let mut edge_tri: HashMap<(usize, usize), usize> = HashMap::new();
    for (ti, t) in tris.iter().enumerate() {
        for k in 0..3 {
            if edge_tri.insert((t[k], t[(k + 1) % 3]), ti).is_some() {
                return Err("Polyeder: nicht mannigfaltige Kante".into());
            }
        }
    }
    if edge_tri
        .keys()
        .any(|&(a, b)| !edge_tri.contains_key(&(b, a)))
    {
        return Err("Polyeder: Netz nicht geschlossen".into());
    }
    // Zusammenhang (ein Teil, keine Hohlräume).
    let mut uf = Union((0..tris.len()).collect());
    for (&(a, b), &ti) in &edge_tri {
        uf.join(ti, edge_tri[&(b, a)]);
    }
    let r0 = uf.find(0);
    if (1..tris.len()).any(|i| uf.find(i) != r0) {
        return Err("Polyeder: mehrere getrennte Teile".into());
    }
    // Komplanare Regionen (Wachstum ab Saat-Dreieck, Ebene der Saat als Massstab).
    let unit_n: Vec<V3> = tris
        .iter()
        .map(|t| {
            let c = cross(sub(pts[t[1]], pts[t[0]]), sub(pts[t[2]], pts[t[0]]));
            let l = norm(c);
            [c[0] / l, c[1] / l, c[2] / l]
        })
        .collect();
    let dist_tol = 1e-9 * scale.max(1.0);
    let mut region = vec![usize::MAX; tris.len()];
    let mut regions: Vec<Vec<usize>> = Vec::new();
    for seed in 0..tris.len() {
        if region[seed] != usize::MAX {
            continue;
        }
        let (n, o) = (unit_n[seed], pts[tris[seed][0]]);
        let rid = regions.len();
        let mut members = vec![seed];
        region[seed] = rid;
        let mut queue = VecDeque::from([seed]);
        while let Some(ti) = queue.pop_front() {
            let t = tris[ti];
            for k in 0..3 {
                let nb = edge_tri[&(t[(k + 1) % 3], t[k])];
                if region[nb] != usize::MAX {
                    continue;
                }
                let flat = dot(unit_n[nb], n) > 1.0 - 1e-12
                    && tris[nb]
                        .iter()
                        .all(|&v| dot(sub(pts[v], o), n).abs() <= dist_tol);
                if flat {
                    region[nb] = rid;
                    members.push(nb);
                    queue.push_back(nb);
                }
            }
        }
        regions.push(members);
    }
    // Regionen je Ecke (für das Entfernen kollinearer Zwischenpunkte).
    let mut vert_regions: Vec<Vec<usize>> = vec![Vec::new(); pts.len()];
    for (ti, t) in tris.iter().enumerate() {
        for &v in t {
            if !vert_regions[v].contains(&region[ti]) {
                vert_regions[v].push(region[ti]);
            }
        }
    }
    // Randschleifen je Region.
    let mut loops_of: Vec<Vec<Vec<usize>>> = Vec::with_capacity(regions.len());
    for (rid, members) in regions.iter().enumerate() {
        let mut next: HashMap<usize, usize> = HashMap::new();
        for &ti in members {
            let t = tris[ti];
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                if region[edge_tri[&(b, a)]] != rid && next.insert(a, b).is_some() {
                    return Err("Polyeder: Fläche berührt sich an einer Ecke".into());
                }
            }
        }
        let mut loops = Vec::new();
        let mut used: HashSet<usize> = HashSet::new();
        let mut starts: Vec<usize> = next.keys().copied().collect();
        starts.sort_unstable();
        for s in starts {
            if used.contains(&s) {
                continue;
            }
            let mut lp = vec![s];
            used.insert(s);
            let mut cur = next[&s];
            while cur != s {
                if !used.insert(cur) || lp.len() > next.len() {
                    return Err("Polyeder: Randschleife nicht geschlossen".into());
                }
                lp.push(cur);
                cur = *next.get(&cur).ok_or("Polyeder: Randschleife offen")?;
            }
            loops.push(lp);
        }
        if loops.is_empty() {
            return Err("Polyeder: Fläche ohne Rand".into());
        }
        loops_of.push(loops);
    }
    // Kollineare Zwischenpunkte entfernen (nur an Ecken zwischen genau zwei Regionen: dort
    // haben beide Schleifen dieselben Nachbarn, die Kanten bleiben geteilt).
    let mut drop: HashSet<usize> = HashSet::new();
    for loops in &loops_of {
        for lp in loops {
            let m = lp.len();
            for i in 0..m {
                let (a, v, b) = (lp[(i + m - 1) % m], lp[i], lp[(i + 1) % m]);
                if vert_regions[v].len() != 2 {
                    continue;
                }
                let (da, db) = (sub(pts[v], pts[a]), sub(pts[b], pts[v]));
                let (la, lb) = (norm(da), norm(db));
                if norm(cross(da, db)) <= 1e-12 * la * lb && dot(da, db) > 0.0 {
                    drop.insert(v);
                }
            }
        }
    }
    for loops in loops_of.iter_mut() {
        for lp in loops.iter_mut() {
            lp.retain(|v| !drop.contains(v));
            if lp.len() < 3 {
                return Err("Polyeder: Randschleife entartet".into());
            }
        }
    }
    // truck-Topologie.
    let mut verts: HashMap<usize, Vertex> = HashMap::new();
    let mut vertex = |i: usize| -> Vertex {
        verts
            .entry(i)
            .or_insert_with(|| builder::vertex(Point3::new(pts[i][0], pts[i][1], pts[i][2])))
            .clone()
    };
    let mut edges: HashMap<(usize, usize), Edge> = HashMap::new();
    let mut faces: Vec<Face> = Vec::with_capacity(regions.len());
    for (rid, loops) in loops_of.iter().enumerate() {
        // Ebene: Normale der Saat, Ursprung = erste Ecke des Aussenrands.
        let newell = |lp: &[usize]| -> V3 {
            let mut s = [0.0; 3];
            for i in 0..lp.len() {
                let c = cross(pts[lp[i]], pts[lp[(i + 1) % lp.len()]]);
                s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]];
            }
            s
        };
        let n = unit_n[regions[rid][0]];
        let outer = (0..loops.len())
            .max_by(|&i, &j| dot(newell(&loops[i]), n).total_cmp(&dot(newell(&loops[j]), n)))
            .unwrap_or(0);
        if dot(newell(&loops[outer]), n) <= 0.0 {
            return Err("Polyeder: Aussenrand falsch orientiert".into());
        }
        let mut wires: Vec<Wire> = Vec::with_capacity(loops.len());
        for li in std::iter::once(outer).chain((0..loops.len()).filter(|&i| i != outer)) {
            let lp = &loops[li];
            let mut w = Wire::new();
            for i in 0..lp.len() {
                let (a, b) = (lp[i], lp[(i + 1) % lp.len()]);
                let key = (a.min(b), a.max(b));
                let e = match edges.get(&key) {
                    Some(e) => e.clone(),
                    None => {
                        let (v0, v1) = (vertex(key.0), vertex(key.1));
                        let curve = Curve::Line(Line(v0.point(), v1.point()));
                        let e = Edge::try_new(&v0, &v1, curve)
                            .map_err(|e| format!("Polyeder: Kante {e:?}"))?;
                        edges.insert(key, e.clone());
                        e
                    }
                };
                w.push_back(if a == key.0 { e } else { e.inverse() });
            }
            wires.push(w);
        }
        let o = pts[loops[outer][0]];
        let helper = if n[0].abs() < 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let u = cross(helper, n);
        let lu = norm(u);
        let u = [u[0] / lu, u[1] / lu, u[2] / lu];
        let v = cross(n, u);
        let plane = Plane::new(
            Point3::new(o[0], o[1], o[2]),
            Point3::new(o[0] + u[0], o[1] + u[1], o[2] + u[2]),
            Point3::new(o[0] + v[0], o[1] + v[1], o[2] + v[2]),
        );
        let f = Face::try_new(wires, Surface::Plane(plane))
            .map_err(|e| format!("Polyeder: Fläche {e:?}"))?;
        faces.push(f);
    }
    let shell: Shell = faces.into_iter().collect();
    Solid::try_new(vec![shell]).map_err(|e| format!("Polyeder: Körper {e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use truck_meshalgo::prelude::*;

    /// Würfel [0,1]³ aus 12 Dreiecken (Ecken je Fläche eigen: 24 Punkte → Verschweissen nötig).
    fn cube() -> (Vec<f64>, Vec<u32>) {
        let quads: [[V3; 4]; 6] = [
            [[0., 0., 0.], [0., 1., 0.], [1., 1., 0.], [1., 0., 0.]],
            [[0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]],
            [[0., 0., 0.], [1., 0., 0.], [1., 0., 1.], [0., 0., 1.]],
            [[0., 1., 0.], [0., 1., 1.], [1., 1., 1.], [1., 1., 0.]],
            [[0., 0., 0.], [0., 0., 1.], [0., 1., 1.], [0., 1., 0.]],
            [[1., 0., 0.], [1., 1., 0.], [1., 1., 1.], [1., 0., 1.]],
        ];
        let (mut p, mut ix) = (Vec::new(), Vec::new());
        for q in quads {
            let b = (p.len() / 3) as u32;
            q.iter().for_each(|v| p.extend_from_slice(v));
            ix.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
        }
        (p, ix)
    }

    /// Prisma über einem Ring (z 0..h), Deckel als Fächer um den Schwerpunkt (komplanare Dreiecke),
    /// Mantel je Segment zwei Dreiecke.
    fn prism(ring: &[(f64, f64)], h: f64) -> (Vec<f64>, Vec<u32>) {
        let n = ring.len() as u32;
        let mut p = Vec::new();
        for &z in &[0.0, h] {
            ring.iter()
                .for_each(|&(x, y)| p.extend_from_slice(&[x, y, z]));
        }
        let (cx, cy) = (
            ring.iter().map(|q| q.0).sum::<f64>() / n as f64,
            ring.iter().map(|q| q.1).sum::<f64>() / n as f64,
        );
        p.extend_from_slice(&[cx, cy, 0.0, cx, cy, h]);
        let (cb, ct) = (2 * n, 2 * n + 1);
        let mut ix = Vec::new();
        for i in 0..n {
            let j = (i + 1) % n;
            ix.extend_from_slice(&[cb, j, i, ct, n + i, n + j]);
            ix.extend_from_slice(&[i, j, n + j, i, n + j, n + i]);
        }
        (p, ix)
    }

    fn volume(s: &Solid) -> f64 {
        use truck_meshalgo::analyzers::CalcVolume;
        s.triangulation(0.01).to_polygon().volume()
    }

    #[test]
    fn wuerfel_aus_zwoelf_dreiecken_hat_sechs_flaechen() {
        let (p, ix) = cube();
        let s = polyhedron_solid(&p, &ix).unwrap();
        assert_eq!(s.boundaries()[0].len(), 6);
        assert_eq!(s.boundaries()[0].edge_iter().count() / 2, 12);
        assert!((volume(&s) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn verkehrt_orientierter_wuerfel_wird_gewendet() {
        let (p, mut ix) = cube();
        ix.chunks_mut(3).for_each(|t| t.swap(1, 2));
        let s = polyhedron_solid(&p, &ix).unwrap();
        assert!((volume(&s) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn l_prisma_mit_faecherdeckel_wird_zu_acht_flaechen() {
        // L: 2×2 ohne Viertel; Fächer um den Schwerpunkt (liegt innerhalb des L).
        let ring = [(0., 0.), (2., 0.), (2., 1.), (1., 1.), (1., 2.), (0., 2.)];
        let (p, ix) = prism(&ring, 3.0);
        let s = polyhedron_solid(&p, &ix).unwrap();
        assert_eq!(s.boundaries()[0].len(), 8);
        assert!((volume(&s) - 9.0).abs() < 1e-9);
    }

    #[test]
    fn kollineare_zwischenpunkte_fallen_weg() {
        // Rechteck mit zusätzlichem Punkt in der Mitte einer Seite → Kante wird wieder eine.
        let ring = [(0., 0.), (1., 0.), (2., 0.), (2., 1.), (0., 1.)];
        let (p, ix) = prism(&ring, 1.0);
        let s = polyhedron_solid(&p, &ix).unwrap();
        // Mantel: zwei komplanare Segmente verschmelzen → 4 Seiten + 2 Deckel.
        assert_eq!(s.boundaries()[0].len(), 6);
        assert_eq!(s.boundaries()[0].edge_iter().count() / 2, 12);
        assert!((volume(&s) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn offenes_netz_faellt_zurueck() {
        let (p, ix) = cube();
        assert!(polyhedron_solid(&p, &ix[..ix.len() - 6]).is_err());
    }

    #[test]
    fn entartete_und_doppelte_dreiecke_werden_toleriert() {
        let (mut p, mut ix) = cube();
        // Doppeltes Dreieck, Nullfläche (wiederholter Index), kollineares Splitter-Dreieck aus 3
        // gleichen Punkten unter anderem Index.
        ix.extend_from_slice(&[0, 1, 2, 0, 0, 1]);
        let b = (p.len() / 3) as u32;
        p.extend_from_slice(&[1., 1., 1., 1., 1., 1., 1., 1., 1.]);
        ix.extend_from_slice(&[b, b + 1, b + 2]);
        let s = polyhedron_solid(&p, &ix).unwrap();
        assert_eq!(s.boundaries()[0].len(), 6);
    }

    #[test]
    fn unsinn_wird_abgelehnt_ohne_panic() {
        assert!(polyhedron_solid(&[], &[]).is_err());
        assert!(polyhedron_solid(&[0.0, 1.0], &[0, 0, 0]).is_err());
        let (mut p, ix) = cube();
        p[0] = f64::NAN;
        assert!(polyhedron_solid(&p, &ix).is_err());
        let (p, mut ix) = cube();
        ix[0] = 999;
        assert!(polyhedron_solid(&p, &ix).is_err());
        // Zwei getrennte Würfel → (noch) kein B-Rep.
        let (p1, ix1) = cube();
        let mut p2 = p1.clone();
        p2.extend(p1.chunks(3).flat_map(|c| [c[0] + 3.0, c[1], c[2]]));
        let mut ix2 = ix1.clone();
        ix2.extend(ix1.iter().map(|i| i + 24));
        assert!(polyhedron_solid(&p2, &ix2).is_err());
        // Zwei Würfel, die sich an einer Kante berühren → nicht mannigfaltig.
        let mut p3 = p1.clone();
        p3.extend(p1.chunks(3).flat_map(|c| [c[0] + 1.0, c[1] + 1.0, c[2]]));
        assert!(polyhedron_solid(&p3, &ix2).is_err());
    }

    #[test]
    fn rahmen_mit_loch_im_deckel() {
        // Quadratischer Ring 3×3 mit Loch 1×1 (Deckel mit Loch, Innen-Mantel).
        let o = [(0., 0.), (3., 0.), (3., 3.), (0., 3.)];
        let i = [(1., 1.), (2., 1.), (2., 2.), (1., 2.)];
        let mut p = Vec::new();
        for &z in &[0.0, 1.0] {
            o.iter()
                .chain(i.iter())
                .for_each(|&(x, y)| p.extend_from_slice(&[x, y, z]));
        }
        // Indizes: unten o 0..4, i 4..8; oben o 8..12, i 12..16.
        let mut ix: Vec<u32> = Vec::new();
        for k in 0..4u32 {
            let l = (k + 1) % 4;
            // Deckel (oben, +z): o_k, o_l, i_l, i_k
            ix.extend_from_slice(&[8 + k, 8 + l, 12 + l, 8 + k, 12 + l, 12 + k]);
            // Boden (−z)
            ix.extend_from_slice(&[k, 4 + l, l, k, 4 + k, 4 + l]);
            // Aussenmantel
            ix.extend_from_slice(&[k, l, 8 + l, k, 8 + l, 8 + k]);
            // Innenmantel (Normale nach innen zum Loch)
            ix.extend_from_slice(&[4 + k, 12 + l, 4 + l, 4 + k, 12 + k, 12 + l]);
        }
        let s = polyhedron_solid(&p, &ix).unwrap();
        assert_eq!(s.boundaries()[0].len(), 10);
        assert!((volume(&s) - 8.0).abs() < 1e-9);
    }
}
