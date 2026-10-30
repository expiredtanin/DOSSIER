//! Automatische Aussenbemassung ([81]); aus `geometry/autoDimensions.ts`. Je Gebäudeseite (Süd,
//! Ost, Nord, West) bis zu drei Massketten ausserhalb des Grundrisses, von innen nach aussen:
//!   1. Öffnungen — Gebäudeecken der Seite plus Leibungen der Fenster/Türen in Wänden dieser Seite,
//!   2. Vor-/Rücksprünge — die Ecken der nach dieser Seite schauenden Aussenkanten (nur bei Stufung),
//!   3. Gesamtmass.
//! Grundlage ist die vereinigte Grundfläche der Wände des Geschosses (an verbundenen Enden um die
//! halbe Dicke verlängert, damit Aussenecken voll sind). Nur achsparallele Kanten werden bemasst;
//! schiefe Wände fehlen in den Ketten. Bogenwände ([T2]) gehen mit ihrem Kreisring in die Grundfläche
//! ein; liegt ihre gewölbte Seite aussen, bekommen sie eine eigene Bogenmass-Kette (Ecken und
//! Leibungen auf dieser Fläche, gemessen entlang des Bogens). TS liefert Wände (Achse + Dicke) und Öffnungs-Leibungen,
//! baut aus den Ketten die Bemassungs-Objekte.

use crate::flat::{Polygon, Ring};
use crate::flat_read::signed_area;
use crate::polygon_bool;

pub type Vec2 = [f64; 2];

/// Wand des Geschosses: Achse und Dicke.
#[derive(Clone, Copy, Debug)]
pub struct WallIn {
    pub start: Vec2,
    pub end: Vec2,
    pub thickness: f64,
    /// Versatz der Wandmitte von der Achse (links der Laufrichtung positiv): Wände mit Referenzlinie
    /// links/rechts oder -versatz liegen nicht mittig auf ihrer Achse.
    pub shift: f64,
    /// Modell-Bulge der Achse (0 = gerade, [T2]).
    pub bulge: f64,
}

impl WallIn {
    pub fn arc(&self) -> Option<crate::wall_arc::WallArc> {
        crate::wall_arc::WallArc::of(kernel2d::Vec2::new(self.start[0], self.start[1]), kernel2d::Vec2::new(self.end[0], self.end[1]), Some(self.bulge))
    }
}

/// Öffnung: Index der Wirtswand in der Wandliste, Leibungspunkte auf der Achse (Bogenwand: auf dem
/// Achsbogen).
#[derive(Clone, Copy, Debug)]
pub struct OpeningIn {
    pub wall: usize,
    pub jamb_start: Vec2,
    pub jamb_end: Vec2,
}

/// Seiten in fester Reihenfolge (Index = Seite): Süd, Ost, Nord, West — Aussennormalen.
pub const SIDES: [Vec2; 4] = [[0.0, -1.0], [1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]];

/// Ketten (Index = Kette): Öffnungen, Vor-/Rücksprünge, Gesamt.
pub const CHAIN_OPENINGS: usize = 0;
pub const CHAIN_STEPS: usize = 1;
pub const CHAIN_TOTAL: usize = 2;
/// Abstand der Ketten von der äussersten Kante in Papier-mm (1:100 → 1.0 / 1.7 / 2.4 m).
const CHAIN_MM: [f64; 3] = [10.0, 17.0, 24.0];

/// Eine Masskette.
#[derive(Clone, Debug, PartialEq)]
pub struct DimChain {
    pub side: usize,
    pub chain: usize,
    pub pts: Vec<Vec2>,
    /// Abstand der Masslinie (Modell-Meter, positiv = aussen).
    pub offset: f64,
    /// Je Punkt das Merkmal, aus dem er stammt (Grundriss-Ecke bzw. Leibung auf der Aussenfläche;
    /// das äusserste bei gleicher Lage) — für die assoziative Bemassung ([38]).
    pub src: Vec<Vec2>,
    /// [T2] Bogenmass-Kette einer Bogenwand: (Bogenmitte, Wand-Index); `side` ist dann ohne Bedeutung.
    pub arc: Option<(Vec2, usize)>,
}

const EPS: f64 = 1e-6;
fn dot(a: Vec2, b: Vec2) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn finite2(p: Vec2) -> bool {
    p[0].is_finite() && p[1].is_finite()
}

fn wall_rect(w: &WallIn, t: f64, ext_start: f64, ext_end: f64) -> Ring {
    let (dx, dy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
    let len = dx.hypot(dy);
    let (ux, uy) = (dx / len, dy / len);
    let (nx, ny) = (-uy * (t / 2.0), ux * (t / 2.0));
    let sh = if w.shift.is_finite() { w.shift } else { 0.0 };
    let a = [w.start[0] - ux * ext_start - uy * sh, w.start[1] - uy * ext_start + ux * sh];
    let b = [w.end[0] + ux * ext_end - uy * sh, w.end[1] + uy * ext_end + ux * sh];
    vec![[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]
}

/// Liegt `p` auf einer anderen Wandachse (Ende oder dazwischen)? Dann ist das Wandende verbunden.
fn connected(p: Vec2, self_idx: usize, walls: &[WallIn]) -> bool {
    for (i, o) in walls.iter().enumerate() {
        if i == self_idx {
            continue;
        }
        let (dx, dy) = (o.end[0] - o.start[0], o.end[1] - o.start[1]);
        let l2 = dx * dx + dy * dy;
        if !(l2 >= EPS) {
            continue;
        }
        let t = (((p[0] - o.start[0]) * dx + (p[1] - o.start[1]) * dy) / l2).clamp(0.0, 1.0);
        if (o.start[0] + t * dx - p[0]).hypot(o.start[1] + t * dy - p[1]) < 1e-3 {
            return true;
        }
    }
    false
}

/// Aussenringe der vereinigten Wand-Grundfläche (gegen den Uhrzeigersinn).
fn outer_rings(walls: &[WallIn]) -> Vec<Ring> {
    let mut parts: Vec<Polygon> = vec![];
    for (i, w) in walls.iter().enumerate() {
        if !finite2(w.start) || !finite2(w.end) || !((w.end[0] - w.start[0]).hypot(w.end[1] - w.start[1]) >= EPS) {
            continue;
        }
        let t = if w.thickness.is_finite() && w.thickness > 0.0 { w.thickness } else { 0.3 };
        let es = if connected(w.start, i, walls) { t / 2.0 } else { 0.0 };
        let ee = if connected(w.end, i, walls) { t / 2.0 } else { 0.0 };
        // Bogenwand: Kreisring-Sektor (Enden um die halbe Dicke entlang des Bogens verlängert).
        if let Some(a) = w.arc() {
            let st = a.stations(-es, a.length() + ee, a.r_max(-t / 2.0, t / 2.0));
            let mut ring: Ring = st.iter().map(|&s| a.point(s, t / 2.0)).map(|q| [q.x, q.y]).collect();
            ring.extend(st.iter().rev().map(|&s| a.point(s, -t / 2.0)).map(|q| [q.x, q.y]));
            parts.push(vec![ring]);
            continue;
        }
        parts.push(vec![wall_rect(w, t, es, ee)]);
    }
    if parts.is_empty() {
        return vec![];
    }
    polygon_bool::union(&parts)
        .into_iter()
        .filter_map(|p| p.into_iter().next())
        .map(|mut r| {
            if signed_area(&r) < 0.0 {
                r.reverse();
            }
            r
        })
        .collect()
}

/// Werte zusammenfassen, die näher als 1 mm beieinander liegen (sortiert).
fn unique_sorted(vals: &[f64]) -> Vec<f64> {
    let mut s: Vec<f64> = vals.iter().copied().filter(|v| v.is_finite()).collect();
    s.sort_by(f64::total_cmp);
    let mut out: Vec<f64> = vec![];
    for v in s {
        if out.last().map_or(true, |l| v - l > 1e-3) {
            out.push(v);
        }
    }
    out
}

/// Massketten eines Geschosses. `scale_denominator` bestimmt den Abstand der Ketten
/// (Papier-mm → Modell-Meter).
pub fn auto_exterior_dimensions(walls: &[WallIn], openings: &[OpeningIn], scale_denominator: f64) -> Vec<DimChain> {
    let rings = outer_rings(walls);
    if rings.is_empty() {
        return vec![];
    }
    let scale = if scale_denominator.is_finite() && scale_denominator > 0.0 { scale_denominator } else { 100.0 };
    let mut out = vec![];
    for (side, &n) in SIDES.iter().enumerate() {
        // Laufrichtung so, dass die linke Normale = Aussennormale ist (positiver Abstand = aussen).
        let u = [n[1], -n[0]];
        let (mut s_max, mut t_min, mut t_max) = (f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        let mut corners = vec![];
        // Merkmale (Lage entlang u, Punkt, Tiefe entlang n) für `src`.
        let mut feats: Vec<(f64, Vec2, f64)> = vec![];
        // Kanten, die nach `n` schauen: Aussennormale (rechte Normale eines CCW-Rings) ≈ n.
        let mut faces: Vec<(f64, f64, f64)> = vec![];
        for ring in &rings {
            for &p in ring {
                feats.push((dot(p, u), p, dot(p, n)));
                s_max = s_max.max(dot(p, n));
                t_min = t_min.min(dot(p, u));
                t_max = t_max.max(dot(p, u));
            }
            for i in 0..ring.len() {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let len = dx.hypot(dy);
                if len < EPS {
                    continue;
                }
                if dot([dy / len, -dx / len], n) < 1.0 - 1e-6 {
                    continue; // nur achsparallele, nach n schauende Kanten
                }
                let (ta, tb) = (dot(a, u), dot(b, u));
                faces.push((dot(a, n), ta.min(tb), ta.max(tb)));
                corners.push(ta);
                corners.push(tb);
            }
        }
        if faces.is_empty() {
            continue;
        }

        // Öffnungen in Wänden, deren Aussenseite auf einer dieser Kanten liegt.
        let mut jambs = vec![];
        for o in openings {
            let Some(w) = walls.get(o.wall).filter(|w| w.arc().is_none()) else { continue };
            let (dx, dy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
            let len = dx.hypot(dy);
            if !(len >= EPS) || dot([dx / len, dy / len], n).abs() > 1e-6 {
                continue; // Wand quer zu n
            }
            let t = if w.thickness.is_finite() && w.thickness > 0.0 { w.thickness } else { 0.3 };
            let left = [-dy / len, dx / len];
            let outer_s = dot(w.start, n) + (if w.shift.is_finite() { w.shift } else { 0.0 }) * dot(left, n) + t / 2.0;
            let (ja, jb) = (dot(o.jamb_start, u), dot(o.jamb_end, u));
            if !ja.is_finite() || !jb.is_finite() {
                continue;
            }
            let on_face = faces
                .iter()
                .any(|&(s, t0, t1)| (s - outer_s).abs() < 1e-3 && ja.min(jb) >= t0 - 1e-3 && ja.max(jb) <= t1 + 1e-3);
            if on_face {
                jambs.push(ja);
                jambs.push(jb);
                for j in [o.jamb_start, o.jamb_end] {
                    let k = outer_s - dot(j, n);
                    feats.push((dot(j, u), [j[0] + n[0] * k, j[1] + n[1] * k], outer_s + 1.0));
                }
            }
        }

        let steps = unique_sorted(&corners);
        let mut chains: Vec<(usize, Vec<f64>)> = vec![];
        if !jambs.is_empty() {
            let mut all = steps.clone();
            all.extend(jambs);
            chains.push((CHAIN_OPENINGS, unique_sorted(&all)));
        }
        if steps.len() > 2 {
            chains.push((CHAIN_STEPS, steps));
        }
        chains.push((CHAIN_TOTAL, vec![t_min, t_max]));

        for (chain, ts) in chains {
            if ts.len() < 2 {
                continue;
            }
            let pts: Vec<Vec2> = ts.iter().map(|&t| [u[0] * t + n[0] * s_max, u[1] * t + n[1] * s_max]).collect();
            // Leibungen vor Ecken (Tiefe + 1), sonst die äusserste Ecke gleicher Lage.
            let src = ts
                .iter()
                .zip(&pts)
                .map(|(&t, &p)| feats.iter().filter(|f| (f.0 - t).abs() <= 1e-3).max_by(|a, b| a.2.total_cmp(&b.2)).map_or(p, |f| f.1))
                .collect();
            out.push(DimChain { side, chain, pts, offset: CHAIN_MM[chain] / 1000.0 * scale, src, arc: None });
        }
    }
    out.extend(arc_chains(walls, openings, &rings, scale));
    out
}

/// [T2] Bogenmass-Ketten: je Bogenwand, deren gewölbte (äussere) Fläche auf dem Umriss liegt — Ecken
/// (äusserste Umriss-Punkte auf diesem Kreis) und Leibungen, gemessen entlang des Bogens.
fn arc_chains(walls: &[WallIn], openings: &[OpeningIn], rings: &[Ring], scale: f64) -> Vec<DimChain> {
    let mut out = Vec::new();
    for (wi, w) in walls.iter().enumerate() {
        let Some(a) = w.arc() else { continue };
        let t = if w.thickness.is_finite() && w.thickness > 0.0 { w.thickness } else { 0.3 };
        // Gewölbte Seite = grösserer Radius.
        let n_out = if a.radius_at(t / 2.0) > a.radius_at(-t / 2.0) { t / 2.0 } else { -t / 2.0 };
        let r_out = a.radius_at(n_out);
        let len = a.length();
        let on_circle = |q: &Vec2| ((q[0] - a.center.x).hypot(q[1] - a.center.y) - r_out).abs() < 1e-4;
        // Liegt die gewölbte Fläche auf dem Umriss (Ring-Punkte auf dem Kreis auch im mittleren Teil)?
        let ss: Vec<f64> = rings.iter().flatten().filter(|q| on_circle(q)).map(|q| a.local(kernel2d::Vec2::new(q[0], q[1])).0).filter(|s| *s > -t && *s < len + t).collect();
        let (lo, hi) = ss.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &s| (l.min(s), h.max(s)));
        if !ss.iter().any(|s| *s > len / 4.0 && *s < 3.0 * len / 4.0) {
            continue;
        }
        let mut st = vec![lo, hi];
        for o in openings.iter().filter(|o| o.wall == wi) {
            for j in [o.jamb_start, o.jamb_end] {
                if finite2(j) {
                    let s = a.local(kernel2d::Vec2::new(j[0], j[1])).0;
                    if s > lo && s < hi {
                        st.push(s);
                    }
                }
            }
        }
        let st = unique_sorted(&st);
        if st.len() < 2 {
            continue;
        }
        let pts: Vec<Vec2> = st.iter().map(|&s| a.point(s, n_out)).map(|q| [q.x, q.y]).collect();
        out.push(DimChain { side: 0, chain: CHAIN_OPENINGS, src: pts.clone(), pts, offset: CHAIN_MM[CHAIN_OPENINGS] / 1000.0 * scale, arc: Some(([a.center.x, a.center.y], wi)) });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L-förmiger Grundriss aus 0.3-m-Wänden (Achsen).
    fn l_walls() -> Vec<WallIn> {
        let axis = [[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [4.0, 6.0], [4.0, 9.0], [0.0, 9.0]];
        (0..axis.len()).map(|i| WallIn { start: axis[i], end: axis[(i + 1) % axis.len()], thickness: 0.3, shift: 0.0, bulge: 0.0 }).collect()
    }
    fn lengths(pts: &[Vec2]) -> Vec<f64> {
        pts.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).collect()
    }
    fn total(d: &DimChain) -> f64 {
        lengths(&d.pts).iter().sum()
    }

    #[test]
    fn gesamtmass_vier_seiten() {
        let dims = auto_exterior_dimensions(&l_walls(), &[], 100.0);
        let totals: Vec<&DimChain> = dims.iter().filter(|d| d.chain == CHAIN_TOTAL).collect();
        assert_eq!(totals.len(), 4);
        for d in totals {
            let want = if d.side % 2 == 0 { 10.3 } else { 9.3 };
            assert!((total(d) - want).abs() < 1e-6, "{d:?}");
            assert!((d.offset - 2.4).abs() < 1e-12);
        }
    }

    #[test]
    fn stufung_nur_nord_und_ost() {
        let dims = auto_exterior_dimensions(&l_walls(), &[], 100.0);
        let steps: Vec<&DimChain> = dims.iter().filter(|d| d.chain == CHAIN_STEPS).collect();
        let mut sides: Vec<usize> = steps.iter().map(|d| d.side).collect();
        sides.sort();
        assert_eq!(sides, vec![1, 2]);
        let north = steps.iter().find(|d| d.side == 2).unwrap();
        let mut l: Vec<f64> = lengths(&north.pts).iter().map(|v| (v * 1000.0).round() / 1000.0).collect();
        l.sort_by(f64::total_cmp);
        assert_eq!(l, vec![4.3, 6.0]);
    }

    #[test]
    fn oeffnungskette() {
        // Fenster 1.5 m breit, Mitte bei 2 m auf der Südwand.
        let o = OpeningIn { wall: 0, jamb_start: [1.25, 0.0], jamb_end: [2.75, 0.0] };
        let dims = auto_exterior_dimensions(&l_walls(), &[o], 100.0);
        let south = dims.iter().find(|d| d.side == 0 && d.chain == CHAIN_OPENINGS).unwrap();
        assert_eq!(lengths(&south.pts).len(), 3);
        assert!((total(south) - 10.3).abs() < 1e-6);
        assert!(south.pts.iter().all(|p| (p[1] + 0.15).abs() < 1e-6));
        assert!((south.offset - 1.0).abs() < 1e-12);
    }

    /// Wand mit Referenzlinie links: die Achse liegt an der Innenkante, die Aussenmasse stimmen trotzdem.
    #[test]
    fn nicht_mittige_wand_misst_die_echte_flaeche() {
        // Achse y = 0, Körper y 0 … 0.3 (shift +0.15), Öffnung 1 … 2 m.
        let w = [WallIn { start: [0.0, 0.0], end: [5.0, 0.0], thickness: 0.3, shift: 0.15, bulge: 0.0 }];
        let o = OpeningIn { wall: 0, jamb_start: [1.0, 0.0], jamb_end: [2.0, 0.0] };
        let dims = auto_exterior_dimensions(&w, &[o], 100.0);
        let south = dims.iter().find(|d| d.side == 0 && d.chain == CHAIN_TOTAL).unwrap();
        let north = dims.iter().find(|d| d.side == 2 && d.chain == CHAIN_TOTAL).unwrap();
        // Masslinie Süd liegt 1.0 m (1:100) vor der Südfläche y = 0; Nord vor y = 0.3.
        let south_y = south.pts[0][1] - south.offset * 1.0 * 0.0;
        assert!((south_y - 0.0).abs() < 1e-6 || (south_y - 0.3).abs() < 1e-6, "{south_y}");
        assert!((north.pts[0][1] - 0.3).abs() < 1e-6, "{:?}", north.pts);
        assert!((south.pts[0][1] - 0.0).abs() < 1e-6, "{:?}", south.pts);
        // Leibungen der Öffnung hängen an der Nordfläche (y = 0.3), nicht an y = 0.15.
        let op = dims.iter().find(|d| d.side == 2 && d.chain == CHAIN_OPENINGS).unwrap();
        assert!(op.src.iter().all(|q| (q[1] - 0.3).abs() < 1e-6), "{:?}", op.src);
    }

    /// [T2] Rechteck mit Bogenwand im Süden (nach aussen gewölbt): Gesamtmass schliesst den Bogen ein,
    /// Bogenmass-Kette auf der Aussenfläche (Ecken + Leibungen) entlang des Bogens.
    #[test]
    fn bogenwand_bogenmass() {
        let mut w = vec![
            WallIn { start: [0.0, 0.0], end: [10.0, 0.0], thickness: 0.3, shift: 0.0, bulge: -0.4 },
            WallIn { start: [10.0, 0.0], end: [10.0, 6.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
            WallIn { start: [10.0, 6.0], end: [0.0, 6.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
            WallIn { start: [0.0, 6.0], end: [0.0, 0.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
        ];
        let a = w[0].arc().unwrap();
        let jamb = |s: f64| {
            let q = a.point(s, 0.0);
            [q.x, q.y]
        };
        let o = OpeningIn { wall: 0, jamb_start: jamb(4.0), jamb_end: jamb(5.5) };
        let dims = auto_exterior_dimensions(&w, &[o], 100.0);
        let arc: Vec<&DimChain> = dims.iter().filter(|d| d.arc.is_some()).collect();
        assert_eq!(arc.len(), 1);
        let d = arc[0];
        let (c, wi) = d.arc.unwrap();
        assert_eq!(wi, 0);
        assert!((c[0] - a.center.x).abs() < 1e-9 && (c[1] - a.center.y).abs() < 1e-9);
        assert_eq!(d.pts.len(), 4, "zwei Ecken, zwei Leibungen");
        let r_out = a.radius_at(if a.radius_at(0.15) > a.radius_at(-0.15) { 0.15 } else { -0.15 });
        assert!(d.pts.iter().all(|q| ((q[0] - c[0]).hypot(q[1] - c[1]) - r_out).abs() < 1e-6));
        // Öffnung entlang der Aussenfläche: 1.5 m Achse · r_out / r.
        let ang = |q: Vec2| (q[1] - c[1]).atan2(q[0] - c[0]);
        let mut da = (ang(d.pts[2]) - ang(d.pts[1])).abs();
        if da > std::f64::consts::PI {
            da = 2.0 * std::f64::consts::PI - da;
        }
        assert!((da * r_out - 1.5 * r_out / a.r).abs() < 1e-6, "{}", da * r_out);
        // Süd-Gesamtmass schliesst den Bogen ein (Scheitel unter y = 0).
        let south = dims.iter().find(|d| d.arc.is_none() && d.side == 0 && d.chain == CHAIN_TOTAL).unwrap();
        assert!(south.pts[0][1] < -1.0, "{:?}", south.pts);
        // Nach innen gewölbt: keine Bogenmass-Kette.
        w[0].bulge = 0.4;
        assert!(auto_exterior_dimensions(&w, &[], 100.0).iter().all(|d| d.arc.is_none()));
    }

    #[test]
    fn unsinn_ohne_panik() {
        assert!(auto_exterior_dimensions(&[], &[], 100.0).is_empty());
        let bad = [
            WallIn { start: [f64::NAN, 0.0], end: [1.0, 0.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
            WallIn { start: [0.0, 0.0], end: [0.0, 0.0], thickness: 0.3, shift: 0.0, bulge: 0.0 },
        ];
        let o = OpeningIn { wall: 7, jamb_start: [0.0, 0.0], jamb_end: [1.0, 0.0] };
        assert!(auto_exterior_dimensions(&bad, &[o], f64::NAN).is_empty());
        // Dicke NaN → 0.3; Öffnung mit NaN-Leibung wird übergangen.
        let w = [WallIn { start: [0.0, 0.0], end: [5.0, 0.0], thickness: f64::NAN, shift: 0.0, bulge: 0.0 }];
        let o = OpeningIn { wall: 0, jamb_start: [f64::NAN, 0.0], jamb_end: [1.0, 0.0] };
        let dims = auto_exterior_dimensions(&w, &[o], 0.0);
        assert!(dims.iter().all(|d| d.chain != CHAIN_OPENINGS));
        assert!(dims.iter().any(|d| d.side == 0 && (total(d) - 5.0).abs() < 1e-6));
    }
}
