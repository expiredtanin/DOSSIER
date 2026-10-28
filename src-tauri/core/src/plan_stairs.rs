//! Treppen-Symbol im Grundriss ([K3a]): Tritte, Lauflinie, Pfeil, Podest, SIA-Bruchlinie und
//! Aussenlinie als flache Primitivliste. Port von `src/plan/generatePlan/stairs.ts`; die Geometrie
//! kommt aus `kernel2d` (`stair_geometry`, `stair_cut`, `stair_outline`), Farbe, Pick-ID und
//! Graustufen setzt der Aufrufer.
//!
//! Eingabe: Treppen-Parameter (16 Zahlen, s. `stair.rs`), Gesamt-Steighöhe, Schnitthöhe über der
//! Treppen-UK, Strichstärke `lw_mm` (Papier-mm), `filled_arrow` (0/1).
//!
//! Ausgabe `[n, Eintrag × n]`, Reihenfolge = Zeichenreihenfolge:
//! ```text
//! 1 polygon  [1, strokeMm, gefüllt (0 = nur Umriss, 1 = Füllung in Strichfarbe), nPts, x, y …]
//! 2 line     [2, cls, weightMm, gestrichelt (0|1), ax, ay, bx, by]
//! 3 arc      [3, weightMm, cx, cy, fromX, fromY, toX, toY, r]            (cls immer stair-outline)
//! cls        0 stair-outline · 1 stair-tread · 2 stair-break · 3 stair-run · 4 stair-arrow
//! ```
//! Gestrichelte Linien tragen das Strichmuster `[0.12, 0.08]` (Meter, `DASH`).

use crate::jsnum;
use crate::stair::decode_params;
use kernel2d::{stair_cut, stair_geometry, stair_outline, Vec2};
use std::collections::HashSet;

pub const DASH: [f64; 2] = [0.12, 0.08];

const CLS_OUTLINE: f64 = 0.0;
const CLS_TREAD: f64 = 1.0;
const CLS_BREAK: f64 = 2.0;
const CLS_RUN: f64 = 3.0;
const CLS_ARROW: f64 = 4.0;

#[derive(Default)]
struct Out {
    buf: Vec<f64>,
    n: usize,
}

impl Out {
    fn polygon(&mut self, pts: &[Vec2], stroke_mm: f64, filled: bool) {
        self.n += 1;
        self.buf.extend([1.0, stroke_mm, if filled { 1.0 } else { 0.0 }, pts.len() as f64]);
        for p in pts {
            self.buf.extend([p.x, p.y]);
        }
    }
    fn line(&mut self, cls: f64, a: Vec2, b: Vec2, weight_mm: f64, dashed: bool) {
        self.n += 1;
        self.buf.extend([2.0, cls, weight_mm, if dashed { 1.0 } else { 0.0 }, a.x, a.y, b.x, b.y]);
    }
    fn arc(&mut self, weight_mm: f64, c: Vec2, from: Vec2, to: Vec2, r: f64) {
        self.n += 1;
        self.buf.extend([3.0, weight_mm, c.x, c.y, from.x, from.y, to.x, to.y, r]);
    }
}

pub fn plan_stair(params: &[f64], total_rise: f64, cut_rise: f64, lw_mm: f64, filled_arrow: bool) -> Vec<f64> {
    let Some(p) = decode_params(params) else { return Vec::new() };
    if !(total_rise.is_finite() && cut_rise.is_finite() && lw_mm.is_finite()) {
        return Vec::new();
    }
    let geo = stair_geometry(&p, total_rise);
    let cut = stair_cut(&geo, cut_rise);
    let below: HashSet<i64> = cut.below_indices.iter().copied().collect();
    let mut o = Out::default();

    for tr in &geo.treads {
        let is_below = below.contains(&tr.index);
        o.polygon(&tr.pts, lw_mm * 0.7, false);
        if tr.pts.len() >= 3 {
            o.line(CLS_TREAD, tr.pts[1], tr.pts[2], lw_mm * if is_below { 1.0 } else { 0.6 }, !is_below);
        }
    }
    if let Some(l) = &geo.landing {
        if l.len() >= 3 {
            o.polygon(l, lw_mm * 0.7, false);
        }
    }
    if let Some(lines) = &cut.break_line {
        for (a, b) in lines {
            o.line(CLS_BREAK, *a, *b, lw_mm, false);
        }
    }
    for w in geo.run_line.windows(2) {
        o.line(CLS_RUN, w[0], w[1], lw_mm, false);
    }
    let (h1, tip, h2) = geo.arrow.head;
    if filled_arrow {
        o.polygon(&[h1, tip, h2], lw_mm, true);
    } else {
        o.line(CLS_ARROW, h1, tip, lw_mm, false);
        o.line(CLS_ARROW, h2, tip, lw_mm, false);
    }

    let outline = stair_outline(&p);
    if let Some(poly) = &outline.polygon {
        if poly.len() >= 3 {
            o.polygon(poly, lw_mm, false);
        }
    }
    if let Some(s) = &outline.spiral {
        for (a, b) in &s.lines {
            o.line(CLS_OUTLINE, *a, *b, lw_mm, false);
        }
        for (c, r, a0, a1) in &s.arcs {
            let from = Vec2::new(c.x + r * jsnum::cos(*a0), c.y + r * jsnum::sin(*a0));
            let to = Vec2::new(c.x + r * jsnum::cos(*a1), c.y + r * jsnum::sin(*a1));
            o.arc(lw_mm, *c, from, to, *r);
        }
    }

    let mut out = Vec::with_capacity(o.buf.len() + 1);
    out.push(o.n as f64);
    out.extend(o.buf);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAN: f64 = f64::NAN;

    fn straight() -> Vec<f64> {
        vec![0.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, NAN, NAN, NAN, NAN, 1.2, 16.0, NAN, 0.0]
    }

    /// Zählt Einträge je Tag und prüft, dass der Puffer genau aufgeht.
    fn tags(buf: &[f64]) -> Vec<f64> {
        let n = buf[0] as usize;
        let mut i = 1;
        let mut t = Vec::new();
        for _ in 0..n {
            t.push(buf[i]);
            i += match buf[i] as i64 {
                1 => 4 + 2 * buf[i + 3] as usize,
                2 => 8,
                3 => 9,
                _ => panic!("unbekannter Tag"),
            };
        }
        assert_eq!(i, buf.len());
        t
    }

    #[test]
    fn gerade_treppe_hat_tritte_lauflinie_pfeil_und_aussenlinie() {
        let b = plan_stair(&straight(), 2.8, 1.0, 0.25, false);
        let t = tags(&b);
        // 16 Tritte × (Polygon + Kante) + 2 Bruchstriche + Lauflinie + 2 Pfeilflügel + Aussenlinie
        assert_eq!(t.iter().filter(|x| **x == 1.0).count(), 16 + 1);
        assert!(t.iter().filter(|x| **x == 2.0).count() >= 16 + 2 + 2);
        // erster Tritt liegt unter der Schnittebene: durchgezogen, volle Stärke
        assert_eq!(&b[1 + 4 + 8 + 1..][..3], &[1.0, 0.25, 0.0]);
    }

    #[test]
    fn gefuellter_pfeil_ist_ein_dreieck() {
        let offen = tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, false));
        let voll = tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, true));
        assert_eq!(voll.len() + 1, offen.len());
    }

    #[test]
    fn wendel_liefert_boegen() {
        let p = vec![2.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, 0.0, 0.0, 1.5, 270.0, 1.0, 14.0, NAN, 0.0];
        let t = tags(&plan_stair(&p, 2.8, 1.0, 0.25, false));
        assert_eq!(t.iter().filter(|x| **x == 3.0).count(), 2);
    }

    #[test]
    fn unsinn_ergibt_leeres_ergebnis() {
        assert!(plan_stair(&[1.0, 2.0], 2.8, 1.0, 0.25, false).is_empty());
        assert!(plan_stair(&straight(), NAN, 1.0, 0.25, false).is_empty());
        let mut kaputt = straight();
        kaputt[1] = NAN;
        assert!(plan_stair(&kaputt, 2.8, 1.0, 0.25, false).is_empty());
    }
}
