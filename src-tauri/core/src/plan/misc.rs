//! Kleine Plan-Bausteine ([K3a]): Kontext-Mesh-Fussabdruck und -Rahmen (`generatePlan/context.ts`),
//! Schnittführungs-Symbol (`sections.ts`) und Linienenden (`endMarks.ts`). Stil, Farbe, Pick-IDs und
//! Beschriftungstext setzt TS; Rechenreihenfolge und Zahlsemantik wie dort (`Math.hypot`, `Math.round`).
//!
//! ## Kontext-Mesh
//! `context_footprint(positions, indices)` → `[n, ax, ay, bx, by …]` (Sockelkanten, entdoppelt).
//! `bbox(positions)` → `[minX, minY, maxX, maxY]` oder leer.
//!
//! ## Schnittführung
//! `section_line(p0x, p0y, p1x, p1y, vorzeichen)` → `[n, Eintrag × n]` in Zeichenreihenfolge (leer
//! bei zu kurzer Linie):
//! ```text
//! 2 line     [2, art (0 dünn Strich-Punkt | 1 kräftig: Endstück/Schenkel), ax, ay, bx, by]
//! 3 triangle  [3, x0, y0, x1, y1, x2, y2]           (gefüllte Pfeilspitze, [176])
//! 5 label    [5, x, y]                              (unten links; Kurz-Tag setzt der Aufrufer)
//! 1 polygon  [1, x0, y0 … x3, y3]                   (unsichtbares Pick-Band)
//! ```
//! Ansicht ([176]): `view_marker_sized` → `[3, 4 circle [4, cx, cy, r], 3 triangle, 1 polygon]`.
//!
//! ## Linienende
//! `end_mark(x, y, dx, dy, art, mm, massstab)` → `[verkuerzung, n, Eintrag × n]` (leer = nichts):
//! ```text
//! art 1 arrow · 2 arrowOpen · 3 dot · 4 tick · 5 square
//! 1 polygon  [1, nPts, x, y …]        gefüllt in Strichfarbe
//! 2 line     [2, ax, ay, bx, by]
//! 4 circle   [4, cx, cy, r]           gefüllt in Strichfarbe
//! ```

use crate::jsmath::hypot2;
use crate::jsnum::round;
use std::collections::HashSet;

const FOOTPRINT_Z_TOL: f64 = 0.6;
// [176] Papier-mm
const SECTION_END_PIECE_MM: f64 = 12.0;
const SECTION_BEND_PIECE_MM: f64 = 6.0;
const SECTION_LEG_MM: f64 = 8.0;
const SECTION_HEAD_LEN_MM: f64 = 3.5;
const SECTION_HEAD_HALF_MM: f64 = 1.3;
const SECTION_LABEL_MM: f64 = 3.5;
const SECTION_PICK_HALF: f64 = 0.3;
/// [176] Ansichtsmarker: Kreis Ø 8 mm, Pfeilspitze 3.5 mm lang und 3.2 mm breit.
pub const VIEW_MARKER_R_MM: f64 = 4.0;
const VIEW_MARKER_TIP_MM: f64 = 3.5;
const VIEW_MARKER_HALF_MM: f64 = 1.6;
const ARROW_ASPECT: f64 = 0.32;

/// Ganzzahl-Schlüssel für die Quantisierung; NaN/∞ bekommen feste Platzhalter (wie ihre Textform in JS).
fn qkey(v: f64) -> i64 {
    if v.is_nan() {
        i64::MIN
    } else if v == f64::INFINITY {
        i64::MAX
    } else if v == f64::NEG_INFINITY {
        i64::MIN + 1
    } else {
        v as i64
    }
}

pub fn context_footprint(positions: &[f64], indices: &[f64]) -> Vec<f64> {
    let vcount = positions.len() / 3;
    if vcount < 3 || indices.len() < 3 {
        return Vec::new();
    }
    let mut min_z = f64::INFINITY;
    let mut i = 2;
    while i < positions.len() {
        if positions[i] < min_z {
            min_z = positions[i];
        }
        i += 3;
    }
    if !min_z.is_finite() {
        return Vec::new();
    }
    let z_limit = min_z + FOOTPRINT_Z_TOL;
    let q = |v: f64| round(v * 100.0);
    let mut seen: HashSet<((i64, i64), (i64, i64))> = HashSet::new();
    let mut lines: Vec<f64> = Vec::new();
    let mut count = 0usize;
    let mut edge = |ia: f64, ib: f64, lines: &mut Vec<f64>, count: &mut usize| {
        // Indizes wie in TS: Zahlen ohne Prüfung auf Ganzzahligkeit; ausserhalb → Kante verwerfen
        if !(ia >= 0.0 && ib >= 0.0) || ia.fract() != 0.0 || ib.fract() != 0.0 {
            return;
        }
        let (ia, ib) = (ia as usize, ib as usize);
        if ia >= vcount || ib >= vcount {
            return;
        }
        let za = positions[ia * 3 + 2];
        let zb = positions[ib * 3 + 2];
        if za > z_limit || zb > z_limit {
            return;
        }
        let (ax, ay) = (positions[ia * 3], positions[ia * 3 + 1]);
        let (bx, by) = (positions[ib * 3], positions[ib * 3 + 1]);
        let ka = (qkey(q(ax)), qkey(q(ay)));
        let kb = (qkey(q(bx)), qkey(q(by)));
        if ka == kb {
            return;
        }
        let key = if ka < kb { (ka, kb) } else { (kb, ka) };
        if !seen.insert(key) {
            return;
        }
        lines.extend([ax, ay, bx, by]);
        *count += 1;
    };
    let mut k = 0;
    while k + 2 < indices.len() {
        let (a, b, c) = (indices[k], indices[k + 1], indices[k + 2]);
        edge(a, b, &mut lines, &mut count);
        edge(b, c, &mut lines, &mut count);
        edge(c, a, &mut lines, &mut count);
        k += 3;
    }
    let mut out = vec![count as f64];
    out.extend(lines);
    out
}

pub fn bbox(positions: &[f64]) -> Vec<f64> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut i = 0;
    while i + 2 < positions.len() {
        let (x, y) = (positions[i], positions[i + 1]);
        if x < min_x {
            min_x = x;
        }
        if x > max_x {
            max_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if y > max_y {
            max_y = y;
        }
        i += 3;
    }
    if !min_x.is_finite() {
        return Vec::new();
    }
    vec![min_x, min_y, max_x, max_y]
}

pub fn section_line(p0x: f64, p0y: f64, p1x: f64, p1y: f64, sign: f64) -> Vec<f64> {
    section_line_sized(p0x, p0y, p1x, p1y, sign, 0.1, SECTION_LABEL_MM * 0.1 * 1.5)
}

/// [176] Schnittmarke in fester Papiergrösse: `mm` = Modell-Meter je Papier-mm (Massstab/1000),
/// Beschriftung (Breite `label_w`, Schrift `SECTION_LABEL_MM · mm`, Ankerpunkt unten links) mit ihrem Kasten vor
/// der Pfeilspitze, in Pfeilrichtung abgesetzt. Kräftige Endstücke (Art 1) längs der Linie, dazwischen dünn (Art 0);
/// an jedem Ende ein kräftiger Schenkel in Blickrichtung mit gefülltem Dreieck (Eintrag 3).
/// Ansichten haben ihr eigenes Symbol (`view_marker_sized`).
pub fn section_line_sized(p0x: f64, p0y: f64, p1x: f64, p1y: f64, sign: f64, mm: f64, label_w: f64) -> Vec<f64> {
    section_polyline_sized(&[(p0x, p0y), (p1x, p1y)], sign, mm, label_w)
}

/// [176] Geknickte Schnittlinie `pts` (Anfang, Knicke, Ende): wie `section_line_sized`, dazu an jedem Knick kräftige
/// Stücke (6 mm) auf beiden Seiten; Schenkel/Dreieck/Beschriftung an den Enden gehören zum ersten bzw. letzten
/// Segment; je Segment ein Pick-Band. Mit zwei Punkten identisch zur geraden Linie. Segmente unter 1 µm entfallen.
pub fn section_polyline_sized(pts: &[(f64, f64)], sign: f64, mm: f64, label_w: f64) -> Vec<f64> {
    if pts.len() < 2 || !pts.iter().all(|p| p.0.is_finite() && p.1.is_finite()) || ![sign, mm, label_w].iter().all(|x| x.is_finite()) || !(mm > 0.0) {
        return Vec::new();
    }
    let mut pts: Vec<(f64, f64)> = pts.to_vec();
    pts.dedup_by(|b, a| hypot2(b.0 - a.0, b.1 - a.1) < 1e-6);
    if pts.len() < 2 {
        return Vec::new();
    }
    let leg = SECTION_LEG_MM * mm;
    let label_h = SECTION_LABEL_MM * mm * 0.75;
    let segs = pts.len() - 1;
    // Einheitsrichtung je Segment.
    let dirs: Vec<(f64, f64)> = (0..segs)
        .map(|i| {
            let (ax, ay) = (pts[i + 1].0 - pts[i].0, pts[i + 1].1 - pts[i].1);
            let l = hypot2(ax, ay);
            (ax / l, ay / l)
        })
        .collect();
    let mut o: Vec<f64> = Vec::new();
    let mut n = 0usize;
    let line = |o: &mut Vec<f64>, n: &mut usize, art: f64, a: (f64, f64), b: (f64, f64)| {
        o.extend([2.0, art, a.0, a.1, b.0, b.1]);
        *n += 1;
    };
    // Endstück: höchstens ein Drittel des Segments, damit bei kurzen Segmenten noch ein dünnes Stück bleibt;
    // an den Knicken das kürzere Knickstück.
    for i in 0..segs {
        let (a, b, (ux, uy)) = (pts[i], pts[i + 1], dirs[i]);
        let len = hypot2(b.0 - a.0, b.1 - a.1);
        let ps = (if i == 0 { SECTION_END_PIECE_MM } else { SECTION_BEND_PIECE_MM } * mm).min(len / 3.0);
        let pe = (if i == segs - 1 { SECTION_END_PIECE_MM } else { SECTION_BEND_PIECE_MM } * mm).min(len / 3.0);
        line(&mut o, &mut n, 1.0, a, (a.0 + ux * ps, a.1 + uy * ps));
        line(&mut o, &mut n, 0.0, (a.0 + ux * ps, a.1 + uy * ps), (b.0 - ux * pe, b.1 - uy * pe));
        line(&mut o, &mut n, 1.0, (b.0 - ux * pe, b.1 - uy * pe), b);
    }
    let (head_l, head_hw) = (SECTION_HEAD_LEN_MM * mm, SECTION_HEAD_HALF_MM * mm);
    for (end, (ux, uy)) in [(pts[0], dirs[0]), (pts[segs], dirs[segs - 1])] {
        let (bnx, bny) = (-uy * sign, ux * sign);
        let tip = (end.0 + bnx * leg, end.1 + bny * leg);
        line(&mut o, &mut n, 1.0, end, tip);
        let hb = (tip.0 - bnx * head_l, tip.1 - bny * head_l);
        o.extend([3.0, tip.0, tip.1, hb.0 + ux * head_hw, hb.1 + uy * head_hw, hb.0 - ux * head_hw, hb.1 - uy * head_hw]);
        n += 1;
        // Kastenmitte vor der Spitze: Abstand + halbe Ausdehnung des Kastens in Pfeilrichtung.
        let reach = mm * 1.0 + bnx.abs() * label_w / 2.0 + bny.abs() * label_h / 2.0;
        let (cx, cy) = (tip.0 + bnx * reach, tip.1 + bny * reach);
        o.extend([5.0, cx - label_w / 2.0, cy - label_h / 2.0]);
        n += 1;
    }
    let ph = SECTION_PICK_HALF.max(1.2 * mm);
    for i in 0..segs {
        let (a, b, (ux, uy)) = (pts[i], pts[i + 1], dirs[i]);
        let (ox, oy) = (-uy * ph, ux * ph);
        o.push(1.0);
        o.extend([a.0 + ox, a.1 + oy, b.0 + ox, b.1 + oy, b.0 - ox, b.1 - oy, a.0 - ox, a.1 - oy]);
        n += 1;
    }
    let mut out = vec![n as f64];
    out.extend(o);
    out
}

/// [176] Ansichtsmarker (eigenes Symbol statt Schnittlinie): Kreis (Ø 8 mm Papier) in der Mitte der Ansichtslinie
/// `p0`–`p1`, daran ein gefülltes Dreieck in Blickrichtung (`sign` wie bei der Schnittlinie). `mm` = Modell-Meter je
/// Papier-mm. Ergebnis `[n, Eintrag × n]` mit `4 circle [4, cx, cy, r]`, `3 triangle` und `1 polygon` (Pick-Band);
/// die Bezeichnung setzt der Aufrufer. Leer bei zu kurzer Linie oder Unsinn.
pub fn view_marker_sized(p0x: f64, p0y: f64, p1x: f64, p1y: f64, sign: f64, mm: f64) -> Vec<f64> {
    if ![p0x, p0y, p1x, p1y, sign, mm].iter().all(|x| x.is_finite()) || !(mm > 0.0) {
        return Vec::new();
    }
    let (ax, ay) = (p1x - p0x, p1y - p0y);
    let len = hypot2(ax, ay);
    if len < 1e-6 {
        return Vec::new();
    }
    let (ux, uy) = (ax / len, ay / len);
    let (bnx, bny) = (-uy * sign, ux * sign);
    let (cx, cy) = ((p0x + p1x) / 2.0, (p0y + p1y) / 2.0);
    let r = VIEW_MARKER_R_MM * mm;
    let (tip_l, hw) = (VIEW_MARKER_TIP_MM * mm, VIEW_MARKER_HALF_MM * mm);
    let base = (cx + bnx * r, cy + bny * r);
    let tip = (base.0 + bnx * tip_l, base.1 + bny * tip_l);
    let mut o = vec![4.0, cx, cy, r];
    o.extend([3.0, tip.0, tip.1, base.0 + ux * hw, base.1 + uy * hw, base.0 - ux * hw, base.1 - uy * hw]);
    let back = (cx - bnx * r, cy - bny * r);
    o.push(1.0);
    o.extend([back.0 + ux * r, back.1 + uy * r, tip.0 + ux * r, tip.1 + uy * r, tip.0 - ux * r, tip.1 - uy * r, back.0 - ux * r, back.1 - uy * r]);
    let mut out = vec![3.0];
    out.extend(o);
    out
}

pub fn end_mark(x: f64, y: f64, dx: f64, dy: f64, art: f64, mm: f64, scale_denominator: f64) -> Vec<f64> {
    if ![x, y, dx, dy, mm, scale_denominator].iter().all(|v| v.is_finite()) {
        return Vec::new();
    }
    let len = hypot2(dx, dy);
    if len < 1e-9 {
        return Vec::new();
    }
    let size = (mm / 1000.0) * scale_denominator;
    let (ux, uy) = (dx / len, dy / len);
    let (nx, ny) = (-uy, ux);
    let base = (x - ux * size, y - uy * size);
    let half = size * ARROW_ASPECT;
    let wing_a = (base.0 + nx * half, base.1 + ny * half);
    let wing_b = (base.0 - nx * half, base.1 - ny * half);
    let at = (x, y);
    let mut o: Vec<f64> = Vec::new();
    let mut n = 0usize;
    let mut shorten = 0.0;
    let line = |o: &mut Vec<f64>, n: &mut usize, a: (f64, f64), b: (f64, f64)| {
        o.extend([2.0, a.0, a.1, b.0, b.1]);
        *n += 1;
    };
    match art as i64 {
        1 => {
            o.extend([1.0, 3.0, at.0, at.1, wing_a.0, wing_a.1, wing_b.0, wing_b.1]);
            n += 1;
            shorten = size;
        }
        2 => {
            line(&mut o, &mut n, wing_a, at);
            line(&mut o, &mut n, wing_b, at);
        }
        3 => {
            o.extend([4.0, x, y, size * 0.25]);
            n += 1;
        }
        4 => {
            let tx = (ux + nx) / std::f64::consts::SQRT_2;
            let ty = (uy + ny) / std::f64::consts::SQRT_2;
            let h = size / 2.0;
            line(&mut o, &mut n, (x - tx * h, y - ty * h), (x + tx * h, y + ty * h));
        }
        5 => {
            let h = size * 0.3;
            o.extend([
                1.0, 4.0,
                x + (ux + nx) * h, y + (uy + ny) * h,
                x + (ux - nx) * h, y + (uy - ny) * h,
                x + (-ux - nx) * h, y + (-uy - ny) * h,
                x + (-ux + nx) * h, y + (-uy + ny) * h,
            ]);
            n += 1;
        }
        _ => return Vec::new(),
    }
    let mut out = vec![shorten, n as f64];
    out.extend(o);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sockelkanten_werden_entdoppelt() {
        // zwei Dreiecke mit gemeinsamer Kante, alle auf z=0; ein Punkt hoch → Kanten dorthin entfallen
        let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.5, 0.5, 9.0];
        let idx = [0.0, 1.0, 2.0, 0.0, 2.0, 3.0, 0.0, 1.0, 4.0];
        let f = context_footprint(&pos, &idx);
        assert_eq!(f[0], 5.0); // 4 Aussenkanten + Diagonale
        assert_eq!(f.len(), 1 + 5 * 4);
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(context_footprint(&[0.0, 1.0], &[0.0]).is_empty());
        assert!(bbox(&[]).is_empty());
        assert!(section_line(0.0, 0.0, 0.0, 0.0, 1.0).is_empty());
        assert!(section_line(f64::NAN, 0.0, 1.0, 0.0, 1.0).is_empty());
        assert!(end_mark(0.0, 0.0, 0.0, 0.0, 1.0, 3.0, 100.0).is_empty());
        assert!(end_mark(0.0, 0.0, 1.0, 0.0, 99.0, 3.0, 100.0).is_empty());
    }

    #[test]
    fn schnittlinie_hat_hauptlinie_marken_label_und_pickband() {
        let f = section_line(0.0, 0.0, 4.0, 0.0, 1.0);
        // 3 Linienstücke + 2 × (Schenkel + Dreieck + Label) + Pick = 10
        assert_eq!(f[0], 10.0);
    }

    /// [176] Ansichtsmarker: Kreis Ø 8 mm in der Linienmitte, Dreieck in Blickrichtung, kein Linienstück.
    #[test]
    fn ansichtsmarker_kreis_dreieck_pick() {
        let f = view_marker_sized(0.0, 0.0, 10.0, 0.0, 1.0, 0.2);
        assert_eq!(f[0], 3.0);
        assert_eq!(f[1..5], [4.0, 5.0, 0.0, 0.8]);
        // Dreieck: Spitze 0.8 + 0.7 m in +y (Blickrichtung bei sign 1).
        assert!((f[6] - 5.0).abs() < 1e-12 && (f[7] - 1.5).abs() < 1e-12);
        assert!(view_marker_sized(0.0, 0.0, 0.0, 0.0, 1.0, 0.2).is_empty());
        assert!(view_marker_sized(f64::NAN, 0.0, 1.0, 0.0, 1.0, 0.2).is_empty());
    }

    /// [176] Fixe Papiergrösse: Schenkel 8 mm, Endstück 12 mm; Ansicht ohne kräftige Endstücke.
    #[test]
    fn schnittlinie_papiermm_endstuecke_und_ansicht() {
        let f = section_line_sized(0.0, 0.0, 10.0, 0.0, 1.0, 0.2, 1.0);
        // Endstück 1: art 1 von (0,0) bis 12 mm · 0.2 = 2.4 m; Mitte dünn; Schenkel 8 mm · 0.2 = 1.6 m in Blickrichtung (+y bei sign 1: n = (0,1)).
        let near = |x: &[f64], y: &[f64]| x.iter().zip(y).all(|(a, b)| (a - b).abs() < 1e-9);
        assert!(near(&f[1..7], &[2.0, 1.0, 0.0, 0.0, 2.4, 0.0]));
        assert!(near(&f[7..13], &[2.0, 0.0, 2.4, 0.0, 7.6, 0.0]));
        let leg = &f[19..25];
        assert_eq!(leg[1], 1.0);
        assert!((leg[5] - 1.6).abs() < 1e-12 && leg[4].abs() < 1e-12, "{leg:?}");
    }

    /// [176] Geknickte Schnittlinie: kräftige Knickstücke (6 mm) beidseits des Knicks, Schenkel nur an den Enden,
    /// Pick-Band je Segment; zwei Punkte = gerade Linie.
    #[test]
    fn geknickte_schnittlinie_hat_knickstuecke() {
        let straight = section_line_sized(0.0, 0.0, 10.0, 0.0, 1.0, 0.2, 1.0);
        assert_eq!(section_polyline_sized(&[(0.0, 0.0), (10.0, 0.0)], 1.0, 0.2, 1.0), straight);
        let f = section_polyline_sized(&[(0.0, 0.0), (10.0, 0.0), (10.0, 8.0)], 1.0, 0.2, 1.0);
        // 2 × 3 Linienstücke + 2 × (Schenkel, Dreieck, Label) + 2 Pick-Bänder
        assert_eq!(f[0], 14.0);
        // Segment 1 endet am Knick mit kräftigem Stück 6 mm · 0.2 = 1.2 m: art 1 von (8.8, 0) nach (10, 0).
        let near = |x: &[f64], y: &[f64]| x.iter().zip(y).all(|(a, b)| (a - b).abs() < 1e-9);
        assert!(near(&f[13..19], &[2.0, 1.0, 8.8, 0.0, 10.0, 0.0]), "{:?}", &f[13..19]);
        // Segment 2 beginnt am Knick mit kräftigem Stück nach oben.
        assert!(near(&f[19..25], &[2.0, 1.0, 10.0, 0.0, 10.0, 1.2]), "{:?}", &f[19..25]);
        assert!(section_polyline_sized(&[(0.0, 0.0), (0.0, 0.0)], 1.0, 0.2, 1.0).is_empty());
    }

    #[test]
    fn gefuellter_pfeil_verkuerzt_die_linie() {
        let a = end_mark(0.0, 0.0, 1.0, 0.0, 1.0, 3.0, 100.0);
        assert!((a[0] - 0.3).abs() < 1e-12);
        assert_eq!(end_mark(0.0, 0.0, 1.0, 0.0, 2.0, 3.0, 100.0)[0], 0.0);
    }
}
