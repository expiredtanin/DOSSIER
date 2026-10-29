//! Mesh-Aufbereitung des swissBUILDINGS3D-Imports ([K4], früher `src/io/swissBuildings3d.ts`): Zuschnitt auf
//! eine Bounding-Box, Zerlegen in zusammenhängende Gebäude, Dachüberstand-Untersichten entfernen.
//! Eingabe flach: `pos` = `[x, y, z, …]`, `idx` = Dreiecks-Indizes (als `f64`); Ergebnis wie die TS-Fassung
//! mit kompaktierten Positionen (nicht referenzierte Ecken entfernt, Indizes neu vergeben).
//! Ein Index ausserhalb der Positionen liest NaN (wie `undefined` in JS).

use std::collections::HashMap;

use crate::jsnum;

/// Kompaktiertes Mesh.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    pub pos: Vec<f64>,
    pub idx: Vec<f64>,
}

fn at(pos: &[f64], i: usize) -> f64 {
    pos.get(i).copied().unwrap_or(f64::NAN)
}

/// Index als Ecke; negativ/NaN/gebrochen → `None`.
fn vert(i: f64) -> Option<usize> {
    if i >= 0.0 && i.fract() == 0.0 && i < 4e9 {
        Some(i as usize)
    } else {
        None
    }
}

/// Baut ein kompaktiertes Mesh aus Dreiecken (Index-Tripel in Reihenfolge).
fn compact(pos: &[f64], tris: impl Iterator<Item = [usize; 3]>) -> Mesh {
    let mut remap: HashMap<usize, f64> = HashMap::new();
    let mut out = Mesh::default();
    for t in tris {
        for old in t {
            let ni = *remap.entry(old).or_insert_with(|| {
                let n = (out.pos.len() / 3) as f64;
                out.pos.extend_from_slice(&[at(pos, old * 3), at(pos, old * 3 + 1), at(pos, old * 3 + 2)]);
                n
            });
            out.idx.push(ni);
        }
    }
    out
}

fn tris(idx: &[f64]) -> impl Iterator<Item = [f64; 3]> + '_ {
    idx.chunks_exact(3).map(|c| [c[0], c[1], c[2]])
}

/// Zuschnitt auf `[xMin, yMin, xMax, yMax]`: ein Dreieck bleibt, sobald mindestens eine Ecke in der Box liegt.
pub fn clip_to_bbox(pos: &[f64], idx: &[f64], bbox: [f64; 4]) -> Mesh {
    let [x0, y0, x1, y1] = bbox;
    let in_box = |i: f64| match vert(i) {
        Some(v) => {
            let (x, y) = (at(pos, v * 3), at(pos, v * 3 + 1));
            x >= x0 && x <= x1 && y >= y0 && y <= y1
        }
        None => false,
    };
    let kept = tris(idx).filter(|t| in_box(t[0]) || in_box(t[1]) || in_box(t[2]));
    // Ungültige Indizes in behaltenen Dreiecken (nur bei kaputter Eingabe): Ecke 0 statt Absturz.
    compact(pos, kept.map(|t| [vert(t[0]).unwrap_or(0), vert(t[1]).unwrap_or(0), vert(t[2]).unwrap_or(0)]))
}

const BASE_CAP_TOL: f64 = 0.05;
const SOFFIT_DOWN_THRESHOLD: f64 = -0.35;

/// Entfernt Untersichten von Dachüberständen (Dreiecke mit Normale deutlich nach unten, nicht auf Grundmauer-Höhe).
/// `None` = Mesh unverändert lassen (zu klein).
pub fn strip_overhang_soffits(pos: &[f64], idx: &[f64]) -> Option<Mesh> {
    if idx.len() < 3 || pos.len() < 9 {
        return None;
    }
    let mut min_z = f64::INFINITY;
    let mut i = 2;
    while i < pos.len() {
        if pos[i] < min_z {
            min_z = pos[i];
        }
        i += 3;
    }
    let mut kept: Vec<[usize; 3]> = Vec::new();
    for t in tris(idx) {
        let (a, b, c) = (vert(t[0]).unwrap_or(0), vert(t[1]).unwrap_or(0), vert(t[2]).unwrap_or(0));
        let (ax, ay, az) = (at(pos, a * 3), at(pos, a * 3 + 1), at(pos, a * 3 + 2));
        let (bx, by, bz) = (at(pos, b * 3), at(pos, b * 3 + 1), at(pos, b * 3 + 2));
        let (cx, cy, cz) = (at(pos, c * 3), at(pos, c * 3 + 1), at(pos, c * 3 + 2));
        let is_base_cap = az <= min_z + BASE_CAP_TOL && bz <= min_z + BASE_CAP_TOL && cz <= min_z + BASE_CAP_TOL;
        if is_base_cap {
            kept.push([a, b, c]);
            continue;
        }
        let (ux, uy, uz) = (bx - ax, by - ay, bz - az);
        let (vx, vy, vz) = (cx - ax, cy - ay, cz - az);
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len > 1e-9 && nz / len < SOFFIT_DOWN_THRESHOLD {
            continue;
        }
        kept.push([a, b, c]);
    }
    Some(compact(pos, kept.into_iter()))
}

/// Zerlegt in räumlich zusammenhängende Komponenten (Vertices per `weld_mm` verschweisst, Union-Find über
/// Dreieckskanten). Reihenfolge = erstes Auftreten im Dreiecks-Strom. Weniger als zwei Komponenten → leere Liste
/// (der Aufrufer behält das Mesh).
pub fn split_components(pos: &[f64], idx: &[f64], weld_mm: f64) -> Vec<Mesh> {
    let vcount = pos.len() / 3;
    let q = weld_mm / 1000.0;
    let canon_bits = |v: f64| -> u64 {
        let r = jsnum::round(v / q);
        if r.is_nan() {
            f64::NAN.to_bits()
        } else if r == 0.0 {
            0.0f64.to_bits()
        } else {
            r.to_bits()
        }
    };
    let mut weld: HashMap<[u64; 3], usize> = HashMap::new();
    let mut canonical = vec![0usize; vcount];
    for (i, c) in canonical.iter_mut().enumerate() {
        let key = [canon_bits(pos[i * 3]), canon_bits(pos[i * 3 + 1]), canon_bits(pos[i * 3 + 2])];
        *c = *weld.entry(key).or_insert(i);
    }
    let mut parent: Vec<usize> = (0..vcount).collect();
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        let mut r = x;
        while parent[r] != r {
            r = parent[r];
        }
        while parent[x] != r {
            let next = parent[x];
            parent[x] = r;
            x = next;
        }
        r
    }
    let valid = |t: &[f64; 3]| -> Option<[usize; 3]> {
        let (a, b, c) = (vert(t[0])?, vert(t[1])?, vert(t[2])?);
        (a < vcount && b < vcount && c < vcount).then_some([a, b, c])
    };
    for t in tris(idx) {
        if let Some([a, b, c]) = valid(&t) {
            for (p, q2) in [(canonical[a], canonical[b]), (canonical[b], canonical[c])] {
                let (ra, rb) = (find(&mut parent, p), find(&mut parent, q2));
                if ra != rb {
                    parent[ra] = rb;
                }
            }
        }
    }
    let mut order: HashMap<usize, usize> = HashMap::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for t in tris(idx) {
        if let Some([a, b, c]) = valid(&t) {
            let root = find(&mut parent, canonical[a]);
            let g = *order.entry(root).or_insert_with(|| {
                groups.push(Vec::new());
                groups.len() - 1
            });
            groups[g].extend_from_slice(&[a, b, c]);
        }
    }
    if groups.len() <= 1 {
        return Vec::new();
    }
    groups.iter().map(|g| compact(pos, g.chunks_exact(3).map(|c| [c[0], c[1], c[2]]))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zuschnitt_kompaktiert() {
        // zwei Dreiecke, das zweite weit weg
        let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 100.0, 100.0, 0.0, 101.0, 100.0, 0.0, 100.0, 101.0, 0.0];
        let idx = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0];
        let m = clip_to_bbox(&pos, &idx, [-1.0, -1.0, 5.0, 5.0]);
        assert_eq!(m.idx, vec![0.0, 1.0, 2.0]);
        assert_eq!(m.pos.len(), 9);
        // Ecke in der Box genügt
        assert_eq!(clip_to_bbox(&pos, &idx, [100.5, 99.0, 102.0, 100.5]).idx.len(), 3);
    }

    #[test]
    fn komponenten_verschweisst() {
        // zwei getrennte Dreiecke mit getrennten Indizes, ein drittes teilt Ecke (per Position) mit dem ersten
        let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 10.0, 0.0, 0.0, 11.0, 0.0, 0.0, 10.0, 1.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 1.0, 0.0];
        let idx = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let parts = split_components(&pos, &idx, 1.0);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].idx.len(), 6);
        assert_eq!(parts[1].idx.len(), 3);
        assert!(split_components(&pos, &idx[..3], 1.0).is_empty());
    }

    #[test]
    fn soffit_faellt_weg_sockel_bleibt() {
        // Sockel-Deckel (z = 0) nach unten, Soffit (z = 3) nach unten, Dach nach oben
        let pos = [
            0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, // nach unten (a,b,c im Uhrzeigersinn) auf Grund
            0.0, 0.0, 3.0, 0.0, 1.0, 3.0, 1.0, 0.0, 3.0, // Soffit
            0.0, 0.0, 3.0, 1.0, 0.0, 3.0, 0.0, 1.0, 3.5, // nach oben
        ];
        let idx = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let m = strip_overhang_soffits(&pos, &idx).unwrap();
        assert_eq!(m.idx.len(), 6);
        assert!(strip_overhang_soffits(&pos[..6], &idx[..3]).is_none());
    }
}
