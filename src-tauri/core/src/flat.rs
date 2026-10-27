//! Flache Kodierung von Mehrfach-Polygonen für die WASM-Grenze:
//! `[n_polys, (n_rings, (n_pts, x0, y0, x1, y1, …)…)…]`. Ringe offen (ohne Schlusspunkt),
//! Ring 0 eines Polygons ist der Aussenring, weitere sind Löcher.

/// Polygon = Ringe; Ring = Punkte.
pub type Ring = Vec<[f64; 2]>;
pub type Polygon = Vec<Ring>;

/// Liest Polygone; bei kaputten Daten (zu kurz, negative Zählungen) `None`.
pub fn decode(buf: &[f64]) -> Option<Vec<Polygon>> {
    let mut i = 0usize;
    let mut next = |buf: &[f64]| -> Option<f64> {
        let v = *buf.get(i)?;
        i += 1;
        Some(v)
    };
    let count = |v: f64| -> Option<usize> {
        if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v < 1e9 {
            Some(v as usize)
        } else {
            None
        }
    };
    let n_polys = count(next(buf)?)?;
    let mut out = Vec::with_capacity(n_polys.min(1 << 16));
    for _ in 0..n_polys {
        let n_rings = count(next(buf)?)?;
        let mut poly = Vec::with_capacity(n_rings.min(1 << 16));
        for _ in 0..n_rings {
            let n_pts = count(next(buf)?)?;
            let mut ring = Vec::with_capacity(n_pts.min(1 << 20));
            for _ in 0..n_pts {
                let x = next(buf)?;
                let y = next(buf)?;
                ring.push([x, y]);
            }
            poly.push(ring);
        }
        out.push(poly);
    }
    Some(out)
}

pub fn encode(polys: &[Polygon]) -> Vec<f64> {
    let mut out = vec![polys.len() as f64];
    for p in polys {
        out.push(p.len() as f64);
        for r in p {
            out.push(r.len() as f64);
            for pt in r {
                out.push(pt[0]);
                out.push(pt[1]);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hin_und_zurueck() {
        let polys = vec![vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], vec![[0.2, 0.2], [0.4, 0.2], [0.3, 0.3]]]];
        assert_eq!(decode(&encode(&polys)), Some(polys));
    }

    #[test]
    fn kaputte_daten() {
        assert_eq!(decode(&[]), None);
        assert_eq!(decode(&[1.0, 1.0, 3.0, 0.0]), None);
        assert_eq!(decode(&[-1.0]), None);
        assert_eq!(decode(&[f64::NAN]), None);
        assert_eq!(decode(&[0.0]), Some(vec![]));
    }
}
