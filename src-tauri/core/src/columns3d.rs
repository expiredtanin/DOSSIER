//! Stützen im 3D (aus `src/plan/toWalls3d/columns.ts`): geschlossenes Prisma-Mesh aus dem
//! Grundriss-Querschnitt (Rechteck oder tesselliertes Kreis-Prisma) zwischen zwei Höhen.
//! TS liefert Querschnitt (`columnFootprint`) und Höhen (`columnVerticalExtent`) und färbt ein.
//!
//! Eingabe: `[n, (zUnten, zOben, nPkt, x, y …)…]`; Ausgabe: `[n, (stütze, nPos, nIdx, …)…]`
//! (s. [`crate::mesh3d`]). Stützen mit < 3 Punkten oder Höhe ≤ 1e-4 entfallen einzeln; Unsinn
//! (NaN, kaputter Puffer) ergibt ein leeres Ergebnis.

use crate::flat_read::Reader;
use crate::mesh3d::Mesh;

const EPS: f64 = 1e-4;

/// Prisma über dem (konvexen) Querschnitt `foot`; Deckel als Dreiecksfächer ab Punkt 0.
pub fn prism(foot: &[[f64; 2]], z_bottom: f64, z_top: f64) -> (Vec<f64>, Vec<u32>) {
    let n = foot.len();
    let mut positions = Vec::with_capacity(6 * n);
    for p in foot {
        positions.extend([p[0], p[1], z_bottom]);
    }
    for p in foot {
        positions.extend([p[0], p[1], z_top]);
    }
    let mut indices = Vec::with_capacity(6 * n + 6 * n.saturating_sub(2));
    let nn = n as u32;
    for i in 0..nn {
        let j = (i + 1) % nn;
        let (b0, b1, t0, t1) = (i, j, i + nn, j + nn);
        indices.extend([b0, b1, t1, b0, t1, t0]);
    }
    for i in 1..nn.saturating_sub(1) {
        indices.extend([0, i, i + 1]);
        indices.extend([nn, nn + i, nn + i + 1]);
    }
    (positions, indices)
}

pub fn columns(buf: &[f64]) -> Vec<Mesh> {
    let mut out = Vec::new();
    let mut r = Reader::new(buf);
    let Some(n) = r.count() else { return out };
    for i in 0..n {
        let (Some(z_bottom), Some(z_top)) = (r.num(), r.num()) else { return Vec::new() };
        let Some(foot) = r.ring() else { return Vec::new() };
        let finite = z_bottom.is_finite() && z_top.is_finite() && foot.iter().all(|p| p[0].is_finite() && p[1].is_finite());
        if !finite || foot.len() < 3 || z_top - z_bottom <= EPS {
            continue;
        }
        let (positions, indices) = prism(&foot, z_bottom, z_top);
        out.push(Mesh { src: i, positions, indices });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square() -> Vec<f64> {
        vec![4.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]
    }

    #[test]
    fn rechteck_prisma() {
        let mut buf = vec![1.0, 0.0, 3.0];
        buf.extend(square());
        let m = columns(&buf);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].positions.len(), 24);
        assert_eq!(&m[0].positions[0..3], &[0.0, 0.0, 0.0]);
        assert_eq!(&m[0].positions[12..15], &[0.0, 0.0, 3.0]);
        // 4 Mantel-Quads + 2 Deckel zu je 2 Dreiecken = 12 Dreiecke
        assert_eq!(m[0].indices.len(), 36);
        assert_eq!(&m[0].indices[0..6], &[0, 1, 5, 0, 5, 4]);
        assert_eq!(&m[0].indices[24..30], &[0, 1, 2, 4, 5, 6]);
    }

    #[test]
    fn auslassungen_behalten_den_index() {
        let mut buf = vec![3.0, 0.0, 0.00005];
        buf.extend(square()); // zu flach
        buf.extend([0.0, 2.0, 2.0, 0.0, 0.0, 1.0, 1.0]); // nur 2 Punkte
        buf.extend([1.0, 2.0]);
        buf.extend(square());
        let m = columns(&buf);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].src, 2);
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(columns(&[]).is_empty());
        assert!(columns(&[f64::NAN]).is_empty());
        assert!(columns(&[2.0, 0.0, 1.0]).is_empty());
        assert!(columns(&[1.0, 0.0, 1.0, 1e300]).is_empty());
        let mut nan = vec![1.0, f64::NAN, 3.0];
        nan.extend(square());
        assert!(columns(&nan).is_empty());
        let mut inf = vec![1.0, 0.0, f64::INFINITY];
        inf.extend(square());
        assert!(columns(&inf).is_empty());
    }
}
