//! Treppen-Symbol im Grundriss ([K3a]): Tritte, Lauflinie, Pfeil, Podest, SIA-Bruchlinie und
//! Aussenlinie als flache Primitivliste. Port von `src/plan/generatePlan/stairs.ts`; die Geometrie
//! kommt aus `kernel2d` (`stair_geometry`, `stair_cut`, `stair_outline`), Farbe, Pick-ID und
//! Graustufen setzt der Aufrufer (`plan/stairs.rs`, [K3d]).
//!
//! Eingabe: Treppen-Parameter (22 Zahlen, s. `stair.rs`), Gesamt-Steighöhe, Schnitthöhe über der
//! Treppen-UK, Strichstärke `lw_mm` (Papier-mm), `filled_arrow` (0/1).
//!
//! Ausgabe `[n, Eintrag × n]`, Reihenfolge = Zeichenreihenfolge:
//! ```text
//! 1 polygon  [1, strokeMm, gefüllt (0 = nur Umriss, 1 = Füllung in Strichfarbe), nPts, x, y …]
//! 2 line     [2, cls, weightMm, gestrichelt (0|1), ax, ay, bx, by]
//! 3 arc      [3, weightMm, cx, cy, fromX, fromY, toX, toY, r]            (cls immer stair-outline)
//! cls        0 stair-outline · 1 stair-tread · 2 stair-break · 3 stair-run · 4 stair-arrow · 5 stair-handrail
//! ```
//! Gestrichelte Linien tragen das Strichmuster `[0.12, 0.08]` (Meter, `DASH`).
//!
//! [151] Handlauf (`railing` 0 keiner, 1 links, 2 rechts, 3 beide): Achse aus [`crate::stair_rail`] (wie im
//! 3D), unter der Bruchhöhe ausgezogen, darüber gestrichelt; `double` (1:50/fein) zeichnet die beiden
//! Rohrkanten statt der Achse. Strichstärke [`HANDRAIL_MM`] (Tusche 0.1 mm).

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
const CLS_HANDRAIL: f64 = 5.0;
/// Strichstärke des Handlaufs (Papier-mm).
pub const HANDRAIL_MM: f64 = 0.1;

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

/// Ecken des Säulenkreises im Grundriss.
const COLUMN_SEGMENTS: usize = 48;

#[allow(clippy::too_many_arguments)]
pub fn plan_stair(params: &[f64], total_rise: f64, cut_rise: f64, lw_mm: f64, filled_arrow: bool, column_r: f64, railing: u8, double: bool) -> Vec<f64> {
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
    for l in geo.landing.iter().chain(geo.landing2.iter()) {
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

    // Mittelsäule (Spindel) der Wendel: reicht über die ganze Steighöhe, also geschnitten, sobald die
    // Schnittebene innerhalb der Treppe liegt.
    if let (true, Some(c)) = (p.shape == "spiral" && column_r.is_finite() && column_r > 0.0, p.center) {
        let r = column_r.min(5.0);
        let pts: Vec<Vec2> = (0..COLUMN_SEGMENTS)
            .map(|k| {
                let a = std::f64::consts::TAU * k as f64 / COLUMN_SEGMENTS as f64;
                Vec2::new(c.x + r * jsnum::cos(a), c.y + r * jsnum::sin(a))
            })
            .collect();
        let cut = cut_rise > 0.0 && cut_rise < total_rise;
        o.polygon(&pts, lw_mm, cut);
    }

    // [151] Handlauf: über der Bruchhöhe (Mitte des ersten geschnittenen Tritts) gestrichelt.
    let z_break = cut.above_indices.first().and_then(|i| geo.treads.iter().find(|t| t.index == *i)).map(|t| (t.base_rise + t.top_rise) / 2.0);
    let r = crate::stair_rail::RAIL_THICK / 2.0;
    for rail in crate::stair_rail::rails(&p, &geo, railing) {
        for (pts, dashed) in crate::stair_rail::plan_pieces(&rail, z_break) {
            let lines: Vec<Vec<[f64; 2]>> = if double {
                vec![crate::stair_rail::offset_polyline(&pts, r), crate::stair_rail::offset_polyline(&pts, -r)]
            } else {
                vec![pts]
            };
            for l in lines {
                for w in l.windows(2) {
                    o.line(CLS_HANDRAIL, Vec2::new(w[0][0], w[0][1]), Vec2::new(w[1][0], w[1][1]), HANDRAIL_MM, dashed);
                }
            }
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
        let b = plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false);
        let t = tags(&b);
        // 16 Tritte × (Polygon + Kante) + 2 Bruchstriche + Lauflinie + 2 Pfeilflügel + Aussenlinie
        assert_eq!(t.iter().filter(|x| **x == 1.0).count(), 16 + 1);
        assert!(t.iter().filter(|x| **x == 2.0).count() >= 16 + 2 + 2);
        // erster Tritt liegt unter der Schnittebene: durchgezogen, volle Stärke
        assert_eq!(&b[1 + 4 + 8 + 1..][..3], &[1.0, 0.25, 0.0]);
    }

    #[test]
    fn gefuellter_pfeil_ist_ein_dreieck() {
        let offen = tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false));
        let voll = tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, true, 0.0, 0, false));
        assert_eq!(voll.len() + 1, offen.len());
    }

    #[test]
    fn wendel_liefert_boegen() {
        let p = vec![2.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, 0.0, 0.0, 1.5, 270.0, 1.0, 14.0, NAN, 0.0];
        let t = tags(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 0, false));
        assert_eq!(t.iter().filter(|x| **x == 3.0).count(), 2);
    }

    /// Letztes Polygon im Puffer: (gefüllt, Punkte).
    fn last_polygon(buf: &[f64]) -> Option<(bool, Vec<[f64; 2]>)> {
        let n = buf[0] as usize;
        let mut i = 1;
        let mut last = None;
        for _ in 0..n {
            match buf[i] as i64 {
                1 => {
                    let k = buf[i + 3] as usize;
                    last = Some((buf[i + 2] != 0.0, (0..k).map(|j| [buf[i + 4 + 2 * j], buf[i + 5 + 2 * j]]).collect()));
                    i += 4 + 2 * k;
                }
                2 => i += 8,
                _ => i += 9,
            }
        }
        last
    }

    #[test]
    fn wendel_saeule_geschnitten_gefuellt_sonst_umriss() {
        let p = vec![2.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, 0.0, 0.0, 1.5, 270.0, 1.0, 14.0, NAN, 0.0];
        let ohne = tags(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 0, false));
        let mit = plan_stair(&p, 2.8, 1.0, 0.25, false, 0.15, 0, false);
        assert_eq!(tags(&mit).len(), ohne.len() + 1);
        let (filled, pts) = last_polygon(&mit).unwrap();
        assert!(filled, "Schnitthöhe in der Treppe: Säule geschnitten (Poché)");
        assert_eq!(pts.len(), COLUMN_SEGMENTS);
        assert!(pts.iter().all(|q| (q[0].hypot(q[1]) - 0.15).abs() < 1e-12), "Kreis um das Zentrum");
        // Schnittebene über der Treppe: nur Umriss.
        let (filled, _) = last_polygon(&plan_stair(&p, 2.8, 3.5, 0.25, false, 0.15, 0, false)).unwrap();
        assert!(!filled);
        // Gerade Treppe: keine Säule.
        assert_eq!(tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.15, 0, false)).len(), tags(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 0, false)).len());
        // Unsinn-Radius: keine Säule, kein Panic.
        assert_eq!(tags(&plan_stair(&p, 2.8, 1.0, 0.25, false, NAN, 0, false)).len(), ohne.len());
    }

    /// Linien je Klasse: (cls, gestrichelt, a, b).
    fn lines(buf: &[f64]) -> Vec<(f64, bool, [f64; 2], [f64; 2])> {
        let n = buf[0] as usize;
        let mut i = 1;
        let mut out = Vec::new();
        for _ in 0..n {
            match buf[i] as i64 {
                1 => i += 4 + 2 * buf[i + 3] as usize,
                2 => {
                    out.push((buf[i + 1], buf[i + 3] != 0.0, [buf[i + 4], buf[i + 5]], [buf[i + 6], buf[i + 7]]));
                    i += 8;
                }
                _ => i += 9,
            }
        }
        out
    }

    fn handrail(buf: &[f64]) -> Vec<(bool, [f64; 2], [f64; 2])> {
        lines(buf).into_iter().filter(|l| l.0 == CLS_HANDRAIL).map(|l| (l.1, l.2, l.3)).collect()
    }

    /// [151] Formen mit Geländer: gerade, L, U, U mit Mittellauf, gerade mit Podest, Wendel (21er-Puffer).
    fn forms() -> Vec<(&'static str, Vec<f64>)> {
        let mut v = vec![("gerade", straight())];
        let l = vec![1.0, 0.0, 0.0, 1.0, 0.0, 2.0, 1.5, 1.0, NAN, NAN, NAN, NAN, 1.0, 16.0, NAN, 0.0];
        v.push(("L", l));
        let u = vec![3.0, 0.0, 0.0, 1.0, 0.0, 2.5, 2.5, 1.0, NAN, NAN, NAN, NAN, 1.0, 17.0, NAN, 0.0, 0.2, NAN, NAN, NAN, NAN];
        let mut um = u.clone();
        um[19] = 2.0;
        v.push(("U", u));
        v.push(("U Mittellauf", um));
        v.push(("gerade mit Podest", vec![4.0, 0.0, 0.0, 1.0, 0.0, 2.0, 2.0, NAN, NAN, NAN, NAN, NAN, 1.0, 16.0, NAN, 0.0, NAN, 1.2, 8.0, NAN, NAN]));
        v.push(("Wendel", vec![2.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, 0.0, 0.0, 1.5, 270.0, 1.0, 14.0, NAN, 0.0]));
        v
    }

    #[test]
    fn handlauf_je_form_unten_ausgezogen_oben_gestrichelt() {
        for (name, p) in forms() {
            assert!(handrail(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 0, false)).is_empty(), "{name}: ohne Geländer");
            let one = handrail(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 1, false));
            let both = handrail(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 3, false));
            assert!(!one.is_empty() && both.len() > one.len(), "{name}");
            // Schnitt bei 1 m: unten ausgezogen, darüber gestrichelt
            assert!(one.iter().any(|l| !l.0) && one.iter().any(|l| l.0), "{name}: {one:?}");
            // Schnitt über der Treppe: alles ausgezogen
            assert!(handrail(&plan_stair(&p, 2.8, 3.5, 0.25, false, 0.0, 3, false)).iter().all(|l| !l.0), "{name}");
            // fein (1:50): Doppellinie im Abstand des Rohrdurchmessers
            let fine = handrail(&plan_stair(&p, 2.8, 1.0, 0.25, false, 0.0, 1, true));
            assert_eq!(fine.len(), 2 * one.len(), "{name}");
        }
        // Tusche: dünn (0.1 mm)
        let b = plan_stair(&forms()[0].1, 2.8, 1.0, 0.25, false, 0.0, 1, false);
        let n = b[0] as usize;
        let mut i = 1;
        for _ in 0..n {
            match b[i] as i64 {
                1 => i += 4 + 2 * b[i + 3] as usize,
                2 => {
                    if b[i + 1] == CLS_HANDRAIL {
                        assert_eq!(b[i + 2], HANDRAIL_MM);
                    }
                    i += 8;
                }
                _ => i += 9,
            }
        }
    }

    #[test]
    fn handlauf_gerade_lage_und_bruch() {
        // gerade Treppe 3 m nach +x, 1 m breit, 16 Steigungen à 0.175: Bruch-Tritt = erster über 1 m
        // (Index 5, Oberkante 1.05), Mitte bei x = 5.5 · 3/16
        let one = handrail(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 1, false));
        assert_eq!(one.len(), 2);
        let y = 0.6 - crate::stair_rail::RAIL_INSET;
        assert!(one.iter().all(|l| (l.1[1] - y).abs() < 1e-9 && (l.2[1] - y).abs() < 1e-9));
        let x_break = 5.5 * 3.0 / 16.0;
        assert!(!one[0].0 && (one[0].2[0] - x_break).abs() < 1e-9 && one[1].0);
        // Doppellinie ± Rohrradius
        let fine = handrail(&plan_stair(&straight(), 2.8, 1.0, 0.25, false, 0.0, 1, true));
        let ys: Vec<f64> = fine.iter().map(|l| l.1[1]).collect();
        let r = crate::stair_rail::RAIL_THICK / 2.0;
        assert!(ys.iter().any(|v| (v - y - r).abs() < 1e-9) && ys.iter().any(|v| (v - y + r).abs() < 1e-9));
    }

    #[test]
    fn unsinn_ergibt_leeres_ergebnis() {
        assert!(plan_stair(&[1.0, 2.0], 2.8, 1.0, 0.25, false, 0.1, 0, false).is_empty());
        assert!(plan_stair(&straight(), NAN, 1.0, 0.25, false, 0.0, 0, false).is_empty());
        let mut kaputt = straight();
        kaputt[1] = NAN;
        assert!(plan_stair(&kaputt, 2.8, 1.0, 0.25, false, 0.0, 0, false).is_empty());
    }
}
