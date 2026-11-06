//! Griff-Ziehen ([128]): die reine Rechnung je Mausschritt eines 2D-Griff-Zugs (vorher in
//! `src/state/useGripEditing.ts`). Die Hülle hält nur Zustand (Locks, ausstehende Züge, Vorschau) und
//! fragt hier, wohin ein Griff fällt:
//!
//! - Länge/Winkel-Eingabe (Tab-Felder): Punkt aus Anker + gelockten Werten ([`polar_point`]), Anzeige-
//!   Werte ([`polar`]);
//! - Shift-Achsen-Lock eines Eckpunkts: Welt-H/V am Nachbar-Griff plus die Flucht der beiden fixen
//!   Nachbarkanten ([`axis_lock`]);
//! - Kanten-Griff: geführte Kante (nur entlang der Aussennormale, Raster/Geometrie-Snap) bzw. freie Kante
//!   (Ortho, Raster), mit oder ohne gelockte Felder ([`edge_target`]);
//! - Höhen-Griffe im Schnitt (Wand-Oberkante, Fenster Ober-/Unterkante, [`sheet_height`]);
//! - Öffnung entlang der Wirtswand ([`opening_slide_sheet`]; der Griff-Zug selbst: `crate::opening_slide`), Griff-Lagen von
//!   Öffnung, Treppe, Bogenwand und Baugrube;
//! - koinzidente Ecken anderer gewählter Elemente beim Körper-Verschieben ([`coincident`]).
//!
//! Zahlen wie in JS (`jsnum`: min/max/round, Trigonometrie über libm); NaN steht für „fehlt".

use crate::jsmath::hypot2;
use crate::jsnum;
use std::f64::consts::PI;

pub type P = (f64, f64);

fn sub(a: P, b: P) -> P {
    (a.0 - b.0, a.1 - b.1)
}

fn add(a: P, b: P) -> P {
    (a.0 + b.0, a.1 + b.1)
}

fn scale(a: P, s: f64) -> P {
    (a.0 * s, a.1 * s)
}

fn dot(a: P, b: P) -> f64 {
    a.0 * b.0 + a.1 * b.1
}

/// `normalize` aus `model/geometry.ts`: Nullvektor bleibt null (Länge 0 → 1).
fn normalize(a: P) -> P {
    let l = hypot2(a.0, a.1);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    (a.0 / l, a.1 / l)
}

/// Winkel in Grad (−180, 180] wie `Math.atan2(dy, dx) * 180 / Math.PI`.
fn deg(dx: f64, dy: f64) -> f64 {
    (jsnum::atan2(dy, dx) * 180.0) / PI
}

/// Länge, Winkel (Grad, [0, 360)) und Abstand entlang `normal` von `anchor` nach `p` (Felder, Cursor-HUD).
pub fn polar(anchor: P, p: P, normal: P) -> (f64, f64, f64) {
    let (dx, dy) = sub(p, anchor);
    let ang = ((deg(dx, dy) % 360.0) + 360.0) % 360.0;
    (hypot2(dx, dy), ang, dx * normal.0 + dy * normal.1)
}

/// Punkt aus Anker + Länge/Winkel (Grad); ungelockte Werte (`None`) folgen dem rohen Cursor `raw`.
pub fn polar_point(anchor: P, length: Option<f64>, angle: Option<f64>, raw: P) -> P {
    let (dx, dy) = sub(raw, anchor);
    let length = length.unwrap_or_else(|| hypot2(dx, dy));
    let a = angle.unwrap_or_else(|| deg(dx, dy)) * (PI / 180.0);
    (anchor.0 + jsnum::cos(a) * length, anchor.1 + jsnum::sin(a) * length)
}

/// Die fixen Polygon-Nachbarn des Punkts `i` eines Rings (`closed`) bzw. einer Kette: (vorher, nachher).
pub fn ring_neighbors(n: usize, i: usize, closed: bool) -> (Option<usize>, Option<usize>) {
    let prev = if i > 0 { Some(i - 1) } else if closed && n > 0 { Some(n - 1) } else { None };
    let next = if i + 1 < n { Some(i + 1) } else if closed { Some(0) } else { None };
    let prev = prev.filter(|&p| p != i);
    let next = next.filter(|&q| q != i && Some(q) != prev);
    (prev, next)
}

/// `raw` auf die nächstliegende Achse (Stützpunkt, Richtung) projizieren; entartete Richtungen zählen nicht.
fn closest_axis_point(raw: P, candidates: &[(P, P)]) -> Option<P> {
    let mut best = None;
    let mut best_dist = f64::INFINITY;
    for &(point, dir) in candidates {
        let len = hypot2(dir.0, dir.1);
        if len < 1e-9 {
            continue;
        }
        let u = (dir.0 / len, dir.1 / len);
        let rel = sub(raw, point);
        let t = rel.0 * u.0 + rel.1 * u.1;
        let proj = add(point, scale(u, t));
        let dist = hypot2(raw.0 - proj.0, raw.1 - proj.1);
        if dist < best_dist {
            best_dist = dist;
            best = Some(proj);
        }
    }
    best
}

/// Shift-Achsen-Lock eines gezogenen Punkt-Griffs: Welt-H/V durch den Nachbar-Griff `anchor` und — bei einem
/// Vielecks-Eckpunkt (`ring` = Punkte des Elements, `index` = gezogener Punkt, `origin` = Lage vor dem Zug) —
/// die Flucht der beiden fixen Nachbarkanten in ihrer ursprünglichen Richtung. Die nächstliegende Achse gewinnt.
pub fn axis_lock(raw: P, anchor: P, origin: Option<P>, ring: &[P], index: usize, closed: bool) -> P {
    let mut c = vec![(anchor, (1.0, 0.0)), (anchor, (0.0, 1.0))];
    if let Some(o) = origin {
        if index < ring.len() {
            let (prev, next) = ring_neighbors(ring.len(), index, closed);
            if let Some(p) = prev.map(|k| ring[k]) {
                c.push((p, sub(o, p)));
            }
            if let Some(q) = next.map(|k| ring[k]) {
                c.push((q, sub(q, o)));
            }
        }
    }
    // H/V sind nie entartet: es gibt immer einen Treffer.
    closest_axis_point(raw, &c).unwrap_or(raw)
}

/// Kanten-Griff (Mitte `mid` beim Grab, Aussennormale `normal`; `free` = offene Kette).
#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub mid: P,
    pub normal: P,
    pub free: bool,
}

/// Wie die Maus/Tastatur einen Kanten-Griff führt.
#[derive(Clone, Copy, Debug, Default)]
pub struct EdgeDrive {
    /// Feld-Controller offen: Ziel aus Anker + Locks (fehlende Werte folgen dem Cursor), ohne Raster/Ortho.
    pub locked: bool,
    pub length: Option<f64>,
    pub angle: Option<f64>,
    pub shift: bool,
    /// Rasterweite (0 = kein Raster).
    pub grid: f64,
    /// Gefangener Geometrie-Snap (nur geführte Kanten).
    pub snapped: Option<P>,
}

/// Zielpunkt eines Kanten-Zugs relativ zum Anker `edge.mid`. Geführt: nur die Komponente entlang der
/// Normale (Geometrie-Snap vor Raster); frei: voller Cursor, Shift = Ortho zum Anker, Raster auf das Delta.
pub fn edge_target(edge: Edge, raw: P, d: EdgeDrive) -> P {
    let anchor = edge.mid;
    if d.locked {
        if edge.free {
            return polar_point(anchor, d.length, d.angle, raw);
        }
        let len = d.length.unwrap_or_else(|| dot(sub(raw, anchor), edge.normal));
        return add(anchor, scale(edge.normal, len));
    }
    let gs = d.grid;
    if edge.free {
        let mut pt = raw;
        if d.shift {
            let (dx, dy) = sub(raw, anchor);
            pt = if dx.abs() >= dy.abs() { (raw.0, anchor.1) } else { (anchor.0, raw.1) };
        }
        if gs > 0.0 {
            let dx = jsnum::round((pt.0 - anchor.0) / gs) * gs;
            let dy = jsnum::round((pt.1 - anchor.1) / gs) * gs;
            pt = (anchor.0 + dx, anchor.1 + dy);
        }
        return pt;
    }
    let cursor = d.snapped.unwrap_or(raw);
    let rel = sub(cursor, anchor);
    let mut offset = rel.0 * edge.normal.0 + rel.1 * edge.normal.1;
    if d.snapped.is_none() && gs > 0.0 {
        offset = jsnum::round(offset / gs) * gs;
    }
    add(anchor, scale(edge.normal, offset))
}

/// Art eines Höhen-Griffs im Schnitt/in der Ansicht.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HeightGrip {
    WallTop,
    OpeningTop,
    OpeningBottom,
}

/// Ergebnis eines Höhen-Griff-Zugs: neue Ober-/Unterkante im Blatt und die Werte fürs Bauteil
/// (Wand/Öffnung `height`; Fenster-Unterkante zusätzlich `sill_height`), auf mm gerundet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HeightDrag {
    pub top: f64,
    pub bottom: f64,
    pub height: f64,
    pub sill_height: Option<f64>,
}

/// Höhen-Griff auf die Blatt-Höhe `y` ziehen (1-cm-Raster, `free` = Strg ohne Raster). `base` = Geschoss-
/// Höhe, `top`/`bottom` = heutige Ober-/Unterkante im Blatt. Mindestmasse: Wand 0.30 m, Öffnung 0.20 m.
pub fn sheet_height(kind: HeightGrip, base: f64, top: f64, bottom: f64, y: f64, free: bool) -> HeightDrag {
    let v = if free { y } else { jsnum::round(y * 100.0) / 100.0 };
    let mm = |x: f64| jsnum::round(x * 1000.0) / 1000.0;
    match kind {
        HeightGrip::WallTop => {
            let t = jsnum::max(base + 0.3, v);
            HeightDrag { top: t, bottom, height: mm(t - base), sill_height: None }
        }
        HeightGrip::OpeningTop => {
            let t = jsnum::max(bottom + 0.2, v);
            HeightDrag { top: t, bottom, height: mm(t - bottom), sill_height: None }
        }
        HeightGrip::OpeningBottom => {
            let b = jsnum::min(top - 0.2, jsnum::max(base, v));
            HeightDrag { top, bottom: b, height: mm(top - b), sill_height: Some(mm(b - base)) }
        }
    }
}

/// Mittelpunkt-Griff einer Öffnung (Breite `width`, `position` = Abstand des ersten Pfostens) auf der Wandachse.
pub fn opening_wall_grip(ws: P, we: P, bulge: f64, position: f64, width: f64) -> P {
    // Bogenwand ([T2], [144]): Punkt auf dem Bogen bei der Bogenlänge der Öffnungsmitte.
    if let Some(a) = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ws.0, ws.1), kernel2d::Vec2::new(we.0, we.1), Some(bulge)) {
        let q = a.point(position + width / 2.0, 0.0);
        return (q.x, q.y);
    }
    add(ws, scale(normalize(sub(we, ws)), position + width / 2.0))
}

/// Öffnung im Schnitt-Blatt waagrecht ziehen: Blatt-Delta `du` (gesamt, entlang der Schnitt-Achse `u_axis`)
/// → neue `position` (geklemmt) und das dazu passende, tatsächlich wirksame Blatt-Delta. `None`, wenn die
/// Wand fast quer zur Schnittlinie steht (|u · Wandrichtung| < 0.15).
pub fn opening_slide_sheet(ws: P, we: P, u_axis: P, position: f64, width: f64, du: f64) -> Option<(f64, f64)> {
    let axis = normalize(sub(we, ws));
    let factor = dot(u_axis, axis);
    if factor.abs() < 0.15 {
        return None;
    }
    let len = hypot2(we.0 - ws.0, we.1 - ws.1);
    let pos = jsnum::max(0.0, jsnum::min(len - width, position + du * factor));
    Some((pos, (pos - position) / factor))
}

/// Bewegpunkt einer Treppe: Wendeltreppe im Zentrum (sonst Start), sonst Mitte des ersten Laufs.
pub fn stair_handle(spiral: bool, center: Option<P>, start: P, dir: P, run_length: f64) -> P {
    if spiral {
        return center.unwrap_or(start);
    }
    add(start, scale(normalize(dir), run_length / 2.0))
}

/// Griffe einer Wand: Start, Ende und bei einer Bogenwand ([T2]) der Bogenscheitel (Pfeilhöhe = halbe
/// Sehne · bulge, links der Sehne).
pub fn wall_grips(s: P, e: P, bulge: f64) -> Vec<P> {
    if bulge == 0.0 || bulge.is_nan() {
        return vec![s, e];
    }
    let h = hypot2(e.0 - s.0, e.1 - s.1) / 2.0;
    let d = sub(e, s);
    let apex = add(scale(add(s, e), 0.5), scale(normalize((-d.1, d.0)), h * bulge));
    vec![s, e, apex]
}

/// [68] Griffe einer Baugrube: Umriss-Ecken, dann der Sohlen-Griff (Eckpunkt-Mittel, y + Sohlenhöhe).
pub fn excavation_grips(outline: &[P], bottom: f64) -> Vec<P> {
    let n = outline.len().max(1) as f64;
    let cx = outline.iter().fold(0.0, |a, q| a + q.0) / n;
    let cy = outline.iter().fold(0.0, |a, q| a + q.1) / n;
    let mut out = outline.to_vec();
    out.push((cx, cy + bottom));
    out
}

/// Toleranz für gemeinsame Ecken beim Körper-Verschieben (m, wie beim 3D-Zug).
pub const COINCIDENT_TOL: f64 = 0.05;

/// Koinzidente Punkte anderer gewählter Elemente (`groups`, je Element seine Griff-Punkte) an jeder Ecke
/// (`corners`) des verschobenen Elements: (Element, Punkt) in der Reihenfolge Ecke → Element → Punkt,
/// jeder Punkt höchstens einmal.
pub fn coincident(corners: &[P], groups: &[Vec<P>]) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for c in corners {
        for (g, pts) in groups.iter().enumerate() {
            for (i, q) in pts.iter().enumerate() {
                if hypot2(c.0 - q.0, c.1 - q.1) <= COINCIDENT_TOL && !out.contains(&(g, i)) {
                    out.push((g, i));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: P, b: P) -> bool {
        (a.0 - b.0).abs() < 1e-12 && (a.1 - b.1).abs() < 1e-12
    }

    #[test]
    fn polar_werte() {
        let (l, a, o) = polar((1.0, 1.0), (1.0, 3.0), (0.0, 1.0));
        assert_eq!((l, a, o), (2.0, 90.0, 2.0));
        // Winkel immer in [0, 360).
        assert_eq!(polar((0.0, 0.0), (0.0, -1.0), (1.0, 0.0)).1, 270.0);
        assert_eq!(polar((0.0, 0.0), (-1.0, -0.0), (1.0, 0.0)).1, 180.0);
    }

    #[test]
    fn polar_punkt_mit_und_ohne_lock() {
        // Beide gelockt: Cursor zählt nicht.
        assert!(close(polar_point((1.0, 0.0), Some(2.0), Some(90.0), (9.0, 9.0)), (1.0, 2.0)));
        // Nur Länge gelockt: Richtung vom Cursor.
        assert!(close(polar_point((0.0, 0.0), Some(5.0), None, (3.0, 0.0)), (5.0, 0.0)));
        // Nur Winkel gelockt: Länge vom Cursor.
        assert!(close(polar_point((0.0, 0.0), None, Some(180.0), (0.0, 2.0)), (-2.0, 0.0)));
        // Nichts gelockt: der Cursor selbst.
        assert!(close(polar_point((0.0, 0.0), None, None, (0.3, -0.4)), (0.3, -0.4)));
    }

    #[test]
    fn nachbarn_ring_und_kette() {
        assert_eq!(ring_neighbors(4, 0, true), (Some(3), Some(1)));
        assert_eq!(ring_neighbors(4, 3, true), (Some(2), Some(0)));
        assert_eq!(ring_neighbors(4, 0, false), (None, Some(1)));
        assert_eq!(ring_neighbors(4, 3, false), (Some(2), None));
        // Zweipunkt-Ring: der zweite Nachbar wäre derselbe Punkt.
        assert_eq!(ring_neighbors(2, 0, true), (Some(1), None));
        assert_eq!(ring_neighbors(1, 0, true), (None, None));
    }

    #[test]
    fn achsen_lock_welt_und_flucht() {
        // Ohne Ring: Welt-H/V durch den Anker.
        assert!(close(axis_lock((3.0, 0.4), (0.0, 0.0), None, &[], 0, false), (3.0, 0.0)));
        assert!(close(axis_lock((0.2, 3.0), (0.0, 0.0), None, &[], 0, false), (0.0, 3.0)));
        // Schräge Nachbarkante (0,0)→(1,1), Eckpunkt 1 vorher bei (1,1): Flucht der Kante gewinnt.
        let ring = [(0.0, 0.0), (1.0, 1.0), (1.0, 3.0)];
        let p = axis_lock((2.1, 1.9), (0.0, 0.0), Some((1.0, 1.0)), &ring, 1, false);
        assert!(close(p, (2.0, 2.0)), "{p:?}");
        // Koinzidenter Nachbar (Richtung null) wird übersprungen.
        let ring = [(1.0, 1.0), (1.0, 1.0)];
        assert!(close(axis_lock((3.0, 0.4), (0.0, 0.0), Some((1.0, 1.0)), &ring, 1, false), (3.0, 0.0)));
    }

    #[test]
    fn kante_gefuehrt_raster_und_snap() {
        let e = Edge { mid: (0.0, 0.0), normal: (0.0, 1.0), free: false };
        // Nur die Normalen-Komponente zählt, Raster 0.5.
        let p = edge_target(e, (7.0, 1.3), EdgeDrive { grid: 0.5, ..Default::default() });
        assert!(close(p, (0.0, 1.5)));
        // Geometrie-Snap gewinnt vor dem Raster.
        let p = edge_target(e, (7.0, 1.3), EdgeDrive { grid: 0.5, snapped: Some((2.0, 1.27)), ..Default::default() });
        assert!(close(p, (0.0, 1.27)));
        // Gelockt: der Feldwert, ohne Raster.
        let p = edge_target(e, (7.0, 1.3), EdgeDrive { locked: true, length: Some(0.25), grid: 0.5, ..Default::default() });
        assert!(close(p, (0.0, 0.25)));
        // Gelockt ohne Wert: live entlang der Normale.
        let p = edge_target(e, (7.0, 1.3), EdgeDrive { locked: true, ..Default::default() });
        assert!(close(p, (0.0, 1.3)));
    }

    #[test]
    fn kante_frei_ortho_und_raster() {
        let e = Edge { mid: (1.0, 1.0), normal: (0.0, 1.0), free: true };
        let p = edge_target(e, (3.2, 1.4), EdgeDrive { shift: true, ..Default::default() });
        assert!(close(p, (3.2, 1.0)));
        let p = edge_target(e, (3.2, 1.4), EdgeDrive { grid: 1.0, ..Default::default() });
        assert!(close(p, (3.0, 1.0)));
        let p = edge_target(e, (3.2, 1.4), EdgeDrive { locked: true, length: Some(2.0), angle: Some(0.0), ..Default::default() });
        assert!(close(p, (3.0, 1.0)));
    }

    #[test]
    fn hoehen_griffe() {
        // Wand: 1-cm-Raster, Mindesthöhe 0.30 über dem Geschoss.
        let r = sheet_height(HeightGrip::WallTop, 3.0, 5.6, 3.0, 5.7349, false);
        assert_eq!((r.top, r.height, r.sill_height), (5.73, 2.73, None));
        let r = sheet_height(HeightGrip::WallTop, 3.0, 5.6, 3.0, 2.0, false);
        assert_eq!(r.height, 0.3);
        // Strg: ohne Raster.
        assert_eq!(sheet_height(HeightGrip::WallTop, 0.0, 2.0, 0.0, 2.3456, true).height, 2.346);
        // Fenster oben: Mindesthöhe 0.20 über der Unterkante.
        let r = sheet_height(HeightGrip::OpeningTop, 0.0, 2.1, 0.9, 0.5, false);
        assert_eq!((r.top, r.height), (1.1, 0.2));
        // Fenster unten: zwischen Geschoss und Oberkante − 0.20, Oberkante bleibt.
        let r = sheet_height(HeightGrip::OpeningBottom, 0.0, 2.1, 0.9, 0.6, false);
        assert_eq!((r.bottom, r.top, r.sill_height, r.height), (0.6, 2.1, Some(0.6), 1.5));
        let r = sheet_height(HeightGrip::OpeningBottom, 0.0, 2.1, 0.9, -1.0, false);
        assert_eq!(r.sill_height, Some(0.0));
        let r = sheet_height(HeightGrip::OpeningBottom, 0.0, 2.1, 0.9, 3.0, false);
        assert_eq!(r.height, 0.2);
    }

    #[test]
    fn oeffnung_entlang_der_wand() {
        let (s, e) = ((0.0, 0.0), (5.0, 0.0));
        assert!(close(opening_wall_grip(s, e, 0.0, 1.0, 1.2), (1.6, 0.0)));
        // Bogenwand (Halbkreis, Radius 2.5): Mitte bei Bogenlänge 2.5·π/2 = Scheitel.
        let q = opening_wall_grip(s, e, 1.0, 2.5 * std::f64::consts::FRAC_PI_2 - 0.6, 1.2);
        assert!(close((q.0, q.1.abs()), (2.5, 2.5)), "{q:?}");
    }

    #[test]
    fn oeffnung_im_schnitt() {
        let (s, e) = ((0.0, 0.0), (5.0, 0.0));
        // Schnitt-Achse gegen die Wand: Faktor −1.
        assert_eq!(opening_slide_sheet(s, e, (-1.0, 0.0), 1.0, 1.2, 0.5), Some((0.5, 0.5)));
        // Geklemmt: wirksames Delta passt zur Klemmung.
        assert_eq!(opening_slide_sheet(s, e, (1.0, 0.0), 1.0, 1.2, 10.0), Some((3.8, 2.8)));
        // Quer geschnittene Wand: keine Bewegung.
        assert_eq!(opening_slide_sheet(s, e, (0.1, 0.995), 1.0, 1.2, 1.0), None);
    }

    #[test]
    fn treppe_wand_baugrube() {
        assert!(close(stair_handle(false, None, (1.0, 1.0), (0.0, 2.0), 4.0), (1.0, 3.0)));
        assert!(close(stair_handle(true, Some((5.0, 5.0)), (1.0, 1.0), (0.0, 2.0), 4.0), (5.0, 5.0)));
        assert!(close(stair_handle(true, None, (1.0, 1.0), (0.0, 2.0), 4.0), (1.0, 1.0)));
        assert_eq!(wall_grips((0.0, 0.0), (4.0, 0.0), 0.0).len(), 2);
        let g = wall_grips((0.0, 0.0), (4.0, 0.0), 0.5);
        assert!(close(g[2], (2.0, 1.0)), "{g:?}");
        let pit = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)];
        let g = excavation_grips(&pit, -2.0);
        assert_eq!(g.len(), 5);
        assert!(close(g[4], (2.0, 0.0)));
        assert!(close(excavation_grips(&[], 1.0)[0], (0.0, 1.0)));
    }

    #[test]
    fn koinzidente_ecken() {
        let corners = [(0.0, 0.0), (4.0, 0.0)];
        let groups = vec![vec![(4.03, 0.0), (4.0, 3.0)], vec![(9.0, 9.0)], vec![(0.0, 0.04), (0.0, 0.02), (4.0, 0.0)]];
        assert_eq!(coincident(&corners, &groups), vec![(2, 0), (2, 1), (0, 0), (2, 2)]);
    }
}
