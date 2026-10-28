//! Objektfang auf Strecken ([K3d], früher die Schleifen in `src/tools/snapping.ts`): Lotfusspunkt
//! vom letzten Punkt, Endpunkte, Mittelpunkte, Schnittpunkte (unendliche Geraden) und Punkt auf
//! der Kante, dazu die nächste Strecke für die Verweil-Erkennung ("divide"). TS sammelt die
//! Strecken (Wandachsen, Schichtgrenzen, Umrisse, 2D-Zeichnung) einmal je Projekt/Geschoss und
//! legt sie hier ab; je Mausbewegung kommen nur Cursor, Toleranz und die wenigen Zusatzstrecken
//! (Entwurf, Blatt-Geometrie) dazu.
//!
//! Bewertung wie in TS: Kandidat nur bis `tol_m` Abstand, Punktzahl `distPx − Priorität`, der
//! erste mit der kleinsten Punktzahl gewinnt. Ergebnis in zwei Blöcken (die Reihenfolge in TS ist
//! Lot → Endpunkte (Strecken) → [Entwurfspunkte, Raum-Anker in TS] → Mitte → Schnitt → Kante),
//! TS führt sie mit seinen eigenen Kandidaten in derselben Reihenfolge zusammen.
//!
//! Schnittpunkte: nur Geraden, die näher als `tol_m` am Cursor vorbeigehen, können einen
//! Schnittpunkt in Reichweite haben — die übrigen Paare fallen vorab weg (früher alle Paare:
//! beim grossen Projekt ~25k Strecken → Sekunden je Mausbewegung). Die Reihenfolge der
//! verbleibenden Paare bleibt, das Ergebnis ist dasselbe.

use crate::jsmath::hypot;
use crate::jsnum;
use crate::plan_pick::{pad, BoxIndex};

/// Snap-Arten (Code in der Ausgabe).
pub const K_PERPENDICULAR: f64 = 0.0;
pub const K_ENDPOINT: f64 = 1.0;
pub const K_MIDPOINT: f64 = 2.0;
pub const K_INTERSECTION: f64 = 3.0;
pub const K_ON_EDGE: f64 = 4.0;

/// Prioritäts-Bonus in Pixeln (wie `PRIORITY` in snapping.ts).
fn priority(kind: f64) -> f64 {
    match kind as i32 {
        0 => 1.0,
        1 => 7.0,
        2 => 3.0,
        3 => 5.0,
        _ => 0.0,
    }
}

/// Welche Arten gefragt sind (Bits).
pub const F_PERPENDICULAR: u32 = 1;
pub const F_ENDPOINT: u32 = 2;
pub const F_MIDPOINT: u32 = 4;
pub const F_INTERSECTION: u32 = 8;
pub const F_ON_EDGE: u32 = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cand {
    pub x: f64,
    pub y: f64,
    pub kind: f64,
    pub dist_px: f64,
    pub score: f64,
}

struct Best {
    raw: (f64, f64),
    tol_m: f64,
    px_per_m: f64,
    best: Option<Cand>,
    best_score: f64,
}

impl Best {
    fn new(raw: (f64, f64), tol_m: f64, px_per_m: f64) -> Best {
        Best { raw, tol_m, px_per_m, best: None, best_score: f64::INFINITY }
    }

    #[inline]
    fn consider(&mut self, x: f64, y: f64, kind: f64) {
        let dx = x - self.raw.0;
        let dy = y - self.raw.1;
        // Schnell verwerfen (hypot ≥ max(|dx|, |dy|)); NaN fällt durch wie in TS.
        if dx.abs() > self.tol_m || dy.abs() > self.tol_m {
            return;
        }
        let d = hypot(&[dx, dy]);
        if d > self.tol_m {
            return;
        }
        let dist_px = d * self.px_per_m;
        let score = dist_px - priority(kind);
        if score < self.best_score {
            self.best_score = score;
            self.best = Some(Cand { x, y, kind, dist_px, score });
        }
    }
}

/// Lotfusspunkt von `p` auf die Strecke `a–b`, aufs Segment geklemmt (`perpFoot`).
#[inline]
fn perp_foot(px: f64, py: f64, s: &[f64; 4]) -> (f64, f64) {
    let dx = s[2] - s[0];
    let dy = s[3] - s[1];
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return (s[0], s[1]);
    }
    let mut t = ((px - s[0]) * dx + (py - s[1]) * dy) / len2;
    t = jsnum::max(0.0, jsnum::min(1.0, t));
    (s[0] + dx * t, s[1] + dy * t)
}

/// Schnittpunkt der Geraden durch `s` und `u` (`lineIntersect`), `None` bei (fast) parallel.
#[inline]
fn line_intersect(s: &[f64; 4], u: &[f64; 4]) -> Option<(f64, f64)> {
    let (dax, day) = (s[2] - s[0], s[3] - s[1]);
    let (dbx, dby) = (u[2] - u[0], u[3] - u[1]);
    let denom = dax * dby - day * dbx;
    if denom.abs() < 1e-9 {
        return None;
    }
    let t = ((u[0] - s[0]) * dby - (u[1] - s[1]) * dbx) / denom;
    Some((s[0] + dax * t, s[1] + day * t))
}

/// Kann die Gerade durch `s` einen Schnittpunkt in `tol_m` um `raw` tragen? (grosszügig;
/// entartete/unendliche Strecken: ja)
fn line_near(s: &[f64; 4], raw: (f64, f64), tol_m: f64) -> bool {
    let dx = s[2] - s[0];
    let dy = s[3] - s[1];
    let l = (dx * dx + dy * dy).sqrt();
    if !(l > 0.0) || !l.is_finite() {
        return true;
    }
    let d = ((raw.0 - s[0]) * dy - (raw.1 - s[1]) * dx).abs() / l;
    !(d > tol_m * (1.0 + 1e-6) + 1e-9 * (1.0 + raw.0.abs().max(raw.1.abs())))
}

/// Abgelegte Strecken mit Raster über ihren Bounding-Boxen.
#[derive(Default)]
pub struct SnapSet {
    pub segs: Vec<[f64; 4]>,
    ix: BoxIndex,
}

impl SnapSet {
    pub fn new(segs: Vec<[f64; 4]>) -> SnapSet {
        let ix = BoxIndex::build(
            segs.iter()
                .enumerate()
                .map(|(k, s)| {
                    let e = pad(s);
                    (k as u32, s[0].min(s[2]) - e, s[1].min(s[3]) - e, s[0].max(s[2]) + e, s[1].max(s[3]) + e)
                })
                .collect(),
        );
        SnapSet { segs, ix }
    }

    /// Strecken, die näher als `r` an `(x, y)` liegen können (aufsteigend). Alle Strecken-Fänge
    /// (Endpunkt, Mitte, Lot, Kante, Verweilen) liegen auf der Strecke und höchstens `tol_m` vom
    /// Cursor — die übrigen tragen nichts bei.
    fn near(&self, x: f64, y: f64, r: f64) -> Vec<u32> {
        if x.is_finite() && y.is_finite() && r.is_finite() && r >= 0.0 {
            self.ix.candidates(x, y, r * (1.0 + 1e-6) + pad(&[x, y]))
        } else {
            (0..self.segs.len() as u32).collect()
        }
    }
}

/// Eingabe einer Fang-Abfrage.
pub struct SnapQuery<'a> {
    /// Strecken in Fang-Reihenfolge: abgelegte, dann Zusatz.
    pub base: &'a SnapSet,
    pub extra: &'a [[f64; 4]],
    /// Strecken für Schnittpunkte; `None` = dieselben wie `base` + `extra`.
    pub int_segs: Option<&'a [[f64; 4]]>,
    pub raw: (f64, f64),
    pub tol_m: f64,
    pub px_per_m: f64,
    pub flags: u32,
    pub last: Option<(f64, f64)>,
}

/// Ergebnis: nächste Strecke (Verweilen), Block A (Lot, Endpunkte), Block B (Mitte, Schnitt, Kante).
pub struct SnapOut {
    pub dwell: Option<usize>,
    pub a: Option<Cand>,
    pub b: Option<Cand>,
}

pub fn snap_segments(q: &SnapQuery) -> SnapOut {
    let (rx, ry) = q.raw;
    let near_base = q.base.near(rx, ry, q.tol_m);
    let nb = q.base.segs.len();
    // Strecken in Fang-Reihenfolge (Index im Ganzen, Strecke): nahe abgelegte, dann Zusatz.
    let segs = || {
        near_base.iter().map(|&k| (k as usize, &q.base.segs[k as usize])).chain(q.extra.iter().enumerate().map(move |(k, s)| (nb + k, s)))
    };
    // Nächste Strecke für die Verweil-Erkennung (`nearestSegment` in snapping.ts).
    let mut dwell = None;
    let mut best_d = q.tol_m;
    for (i, s) in segs() {
        let (fx, fy) = perp_foot(rx, ry, s);
        let (dx, dy) = (fx - rx, fy - ry);
        if dx.abs() >= best_d || dy.abs() >= best_d {
            continue;
        }
        let d = hypot(&[dx, dy]);
        if d < best_d {
            best_d = d;
            dwell = Some(i);
        }
    }
    let mut a = Best::new(q.raw, q.tol_m, q.px_per_m);
    if q.flags & F_PERPENDICULAR != 0 {
        if let Some((lx, ly)) = q.last {
            for (_, s) in segs() {
                let (x, y) = perp_foot(lx, ly, s);
                a.consider(x, y, K_PERPENDICULAR);
            }
        }
    }
    if q.flags & F_ENDPOINT != 0 {
        for (_, s) in segs() {
            a.consider(s[0], s[1], K_ENDPOINT);
            a.consider(s[2], s[3], K_ENDPOINT);
        }
    }
    let mut b = Best::new(q.raw, q.tol_m, q.px_per_m);
    if q.flags & F_MIDPOINT != 0 {
        for (_, s) in segs() {
            b.consider((s[0] + s[2]) / 2.0, (s[1] + s[3]) / 2.0, K_MIDPOINT);
        }
    }
    if q.flags & F_INTERSECTION != 0 {
        let near: Vec<&[f64; 4]> = match q.int_segs {
            Some(l) => l.iter().filter(|s| line_near(s, q.raw, q.tol_m)).collect(),
            None => q.base.segs.iter().chain(q.extra.iter()).filter(|s| line_near(s, q.raw, q.tol_m)).collect(),
        };
        for i in 0..near.len() {
            for j in i + 1..near.len() {
                if let Some((x, y)) = line_intersect(near[i], near[j]) {
                    b.consider(x, y, K_INTERSECTION);
                }
            }
        }
    }
    if q.flags & F_ON_EDGE != 0 {
        for (_, s) in segs() {
            let (x, y) = perp_foot(rx, ry, s);
            b.consider(x, y, K_ON_EDGE);
        }
    }
    SnapOut { dwell, a: a.best, b: b.best }
}

/// Strecken aus `[ax, ay, bx, by, …]`.
pub fn segs_from(flat: &[f64]) -> Vec<[f64; 4]> {
    flat.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpunkt_vor_kante_schnitt_nur_nahe_geraden() {
        let segs = segs_from(&[0.0, 0.0, 10.0, 0.0, 5.0, -5.0, 5.0, 5.0, 100.0, 50.0, 200.0, 50.0]);
        let base = SnapSet::new(segs[..1].to_vec());
        let q = SnapQuery { base: &base, extra: &segs[1..], int_segs: None, raw: (5.05, 0.02), tol_m: 0.2, px_per_m: 100.0, flags: 31, last: None };
        let o = snap_segments(&q);
        assert_eq!(o.dwell, Some(0));
        assert_eq!(o.a, None);
        let b = o.b.unwrap();
        assert_eq!((b.x, b.y, b.kind), (5.0, 0.0, K_INTERSECTION));
        let q = SnapQuery { raw: (9.95, 0.0), ..q };
        assert_eq!(snap_segments(&q).a.unwrap().kind, K_ENDPOINT);
    }
}
