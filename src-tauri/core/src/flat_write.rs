//! Schreibhilfe für flache `f64`-Puffer (Gegenstück zu `FlatWriter` in `src/geometry/coreFlat.ts`
//! und zu `flat_read::Reader`): Rust-Sammler bauen damit dieselben Puffer, die die bestehenden
//! Kern-Funktionen (`ceilings3d`, `wall_bands` …) lesen.

use crate::model::Vec2;

#[derive(Default)]
pub struct FlatWriter {
    buf: Vec<f64>,
}

impl FlatWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn num(&mut self, v: f64) -> &mut Self {
        self.buf.push(v);
        self
    }

    pub fn nums(&mut self, v: &[f64]) -> &mut Self {
        self.buf.extend_from_slice(v);
        self
    }

    /// Platz für eine erst später bekannte Zahl; mit [`set`](Self::set) nachtragen.
    pub fn slot(&mut self) -> usize {
        self.buf.push(0.0);
        self.buf.len() - 1
    }

    pub fn set(&mut self, slot: usize, v: f64) -> &mut Self {
        self.buf[slot] = v;
        self
    }

    /// Nur die Punkte `x0, y0, x1, y1, …`.
    pub fn pts(&mut self, pts: &[Vec2]) -> &mut Self {
        for p in pts {
            self.buf.push(p.x);
            self.buf.push(p.y);
        }
        self
    }

    /// Anzahl, dann die Punkte.
    pub fn ring(&mut self, pts: &[Vec2]) -> &mut Self {
        self.buf.push(pts.len() as f64);
        self.pts(pts)
    }

    pub fn done(self) -> Vec<f64> {
        self.buf
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}
