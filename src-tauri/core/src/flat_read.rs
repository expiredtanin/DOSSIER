//! Lesehilfe für flache `f64`-Puffer mit eigenem Aufbau (Prismen, Wände, Räume …): liest Zahlen
//! der Reihe nach; jede Methode gibt bei zu kurzen oder kaputten Daten `None` zurück, damit die
//! Bindungen ein leeres Ergebnis statt eines Panics liefern.

pub struct Reader<'a> {
    buf: &'a [f64],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [f64]) -> Self {
        Reader { buf, pos: 0 }
    }

    /// Nächste Zahl (darf NaN/∞ sein — Prüfung beim Aufrufer).
    pub fn num(&mut self) -> Option<f64> {
        let v = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }

    /// Nächste Anzahl: endlich, ganzzahlig, nicht negativ, begrenzt.
    pub fn count(&mut self) -> Option<usize> {
        let v = self.num()?;
        if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v < 1e9 {
            Some(v as usize)
        } else {
            None
        }
    }

    /// `n` Punkte (x, y).
    pub fn points(&mut self, n: usize) -> Option<Vec<[f64; 2]>> {
        if self.buf.len().saturating_sub(self.pos) < 2 * n {
            return None;
        }
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push([self.num()?, self.num()?]);
        }
        Some(out)
    }

    /// Anzahl, dann so viele Punkte (x, y).
    pub fn ring(&mut self) -> Option<Vec<[f64; 2]>> {
        let n = self.count()?;
        self.points(n)
    }

    /// `n` Punkte (x, y, z).
    pub fn points3(&mut self, n: usize) -> Option<Vec<[f64; 3]>> {
        if self.buf.len().saturating_sub(self.pos) < 3 * n {
            return None;
        }
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push([self.num()?, self.num()?, self.num()?]);
        }
        Some(out)
    }
}

/// `[x0, y0, x1, y1, …]` → Punkte (ein überzähliger Rest fällt weg).
pub fn pairs(buf: &[f64]) -> Vec<[f64; 2]> {
    buf.chunks_exact(2).map(|c| [c[0], c[1]]).collect()
}

/// Fläche mit Vorzeichen (gegen den Uhrzeigersinn positiv), Ring offen.
pub fn signed_area(r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = r[i];
        let q = r[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liest_und_bricht_sauber_ab() {
        let mut r = Reader::new(&[2.0, 0.0, 0.0, 1.0, 1.0, 5.0]);
        assert_eq!(r.ring(), Some(vec![[0.0, 0.0], [1.0, 1.0]]));
        assert_eq!(r.count(), Some(5));
        assert_eq!(r.num(), None);
        assert_eq!(Reader::new(&[3.0, 1.0]).ring(), None);
        assert_eq!(Reader::new(&[f64::NAN]).count(), None);
        assert_eq!(Reader::new(&[1e300]).ring(), None);
    }

    #[test]
    fn flaeche() {
        assert_eq!(signed_area(&[[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]]), 4.0);
        assert_eq!(signed_area(&[]), 0.0);
    }
}
