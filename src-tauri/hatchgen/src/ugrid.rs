//! Eindimensionales Raster für Bereichs-Vorauswahlen ([K3c], Leistung): Schnitt/Ansicht prüften je
//! Kante, Punkt oder Fläche alle Verdecker bzw. alle Wände (quadratisch). Das Raster liefert nur
//! die Einträge, deren Intervall den Abfragebereich überhaupt berühren kann — in aufsteigender
//! Reihenfolge der Einträge, damit Aufrufer, deren Ergebnis von der Reihenfolge abhängt, bitgleich
//! bleiben. Die genaue Prüfung bleibt beim Aufrufer.

pub struct Grid1 {
    lo: f64,
    inv: f64,
    cells: Vec<Vec<u32>>,
    /// Einträge mit nicht endlichem Intervall: immer Kandidaten.
    always: Vec<u32>,
    n: usize,
}

impl Grid1 {
    /// Raster über die Intervalle `[a, b]` (Index = Position in `iv`).
    pub fn new(iv: &[(f64, f64)]) -> Grid1 {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        let mut always = Vec::new();
        for (i, &(a, b)) in iv.iter().enumerate() {
            if a.is_finite() && b.is_finite() {
                lo = lo.min(a.min(b));
                hi = hi.max(a.max(b));
            } else {
                always.push(i as u32);
            }
        }
        let count = iv.len() - always.len();
        let cells_n = if count == 0 || !(hi > lo) { 1 } else { ((count as f64).sqrt().ceil() as usize * 2).clamp(1, 1 << 14) };
        let inv = if cells_n > 1 { cells_n as f64 / (hi - lo) } else { 0.0 };
        let mut g = Grid1 { lo, inv, cells: vec![Vec::new(); cells_n], always, n: iv.len() };
        for (i, &(a, b)) in iv.iter().enumerate() {
            if a.is_finite() && b.is_finite() {
                let (c0, c1) = g.span(a.min(b), a.max(b));
                for c in c0..=c1 {
                    g.cells[c].push(i as u32);
                }
            }
        }
        g
    }

    fn span(&self, a: f64, b: f64) -> (usize, usize) {
        let last = self.cells.len() - 1;
        if self.inv == 0.0 {
            return (0, last.min(0));
        }
        let cell = |u: f64| -> usize {
            let c = ((u - self.lo) * self.inv).floor();
            if c.is_nan() {
                0
            } else {
                c.clamp(0.0, last as f64) as usize
            }
        };
        (cell(a), cell(b))
    }

    /// Kandidaten, deren Intervall `[a, b]` schneiden kann (aufsteigend, ohne Doppelte). Nicht
    /// endliche Abfragen liefern alle Einträge.
    pub fn query(&self, a: f64, b: f64, out: &mut Vec<u32>) {
        out.clear();
        if !(a.is_finite() && b.is_finite()) {
            out.extend(0..self.n as u32);
            return;
        }
        let (c0, c1) = self.span(a.min(b), a.max(b));
        for c in c0..=c1 {
            out.extend_from_slice(&self.cells[c]);
        }
        out.extend_from_slice(&self.always);
        out.sort_unstable();
        out.dedup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn findet_genau_die_ueberlappenden_als_obermenge() {
        let iv: Vec<(f64, f64)> = (0..200).map(|i| (i as f64 * 0.5, i as f64 * 0.5 + 1.0)).chain([(f64::NAN, 1.0)]).collect();
        let g = Grid1::new(&iv);
        let mut out = Vec::new();
        for q in [(-5.0, -4.0), (10.2, 10.3), (0.0, 100.0), (99.0, 120.0)] {
            g.query(q.0, q.1, &mut out);
            let exact: Vec<u32> = (0..iv.len() as u32).filter(|&i| { let (a, b) = iv[i as usize]; !(a.is_finite() && b.is_finite()) || (a <= q.1 && b >= q.0) }).collect();
            assert!(exact.iter().all(|i| out.contains(i)), "{q:?}");
            assert!(out.windows(2).all(|w| w[0] < w[1]));
        }
        g.query(f64::NAN, 1.0, &mut out);
        assert_eq!(out.len(), iv.len());
    }
}
