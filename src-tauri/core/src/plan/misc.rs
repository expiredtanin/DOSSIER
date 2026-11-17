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
//! Darstellung ([276], [`SectionLook`]): Linie `full` (dünn + kräftige Endstücke) | `ends` (nur Endstücke) | `none`; Marke je Ende
//! (`markerAt`) `arrow` (Schenkel + Dreieck) | `lAngle` (Schenkel, mit dem Endstück ein L) | `triangle` | `none`; Beschriftung an/aus.
//! `section_polyline_look`; Ansicht: `view_symbol` (Zeichen in der Mitte), `view_line_parts` (Linie).

//! Ansicht ([176]): `view_marker_sized` → `[n, 3 triangle (flach), 5 label, 1 polygon]`, kein Kreis.
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
use crate::model::{SectionLineMode, SectionMarker, SectionMarkerAt};
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
/// [176] L-Marke: langer Schenkel längs der Linie, kurzer in Blickrichtung.
const L_LONG_MM: f64 = 12.0;
const L_SHORT_MM: f64 = 6.0;
/// [176] Ansichtsmarker: flaches gefülltes Dreieck, Basis 6 mm, Höhe 3 mm in Blickrichtung.
const VIEW_MARKER_HEIGHT_MM: f64 = 3.0;
const VIEW_MARKER_HALF_MM: f64 = 3.0;
/// [276] Marke „Dreieck" an Schnittenden: Höhe und halbe Basis in Papier-mm.
const TRIANGLE_HEIGHT_MM: f64 = 4.5;
const TRIANGLE_HALF_MM: f64 = 2.0;
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
    section_polyline_look(pts, sign, mm, label_w, &SectionLook::default())
}

/// [276] Darstellung einer Schnittlinie: Linie, Endstücke, Marke und Beschriftung.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SectionLook {
    pub line: SectionLineMode,
    /// Länge der Endstücke in Papier-mm (an Knicken die Hälfte).
    pub end_mm: f64,
    pub marker: SectionMarker,
    pub at: SectionMarkerAt,
    pub label: bool,
}

impl Default for SectionLook {
    /// Heutiges Bild des Schnitts: dünne Linie mit kräftigen Endstücken, Pfeil an beiden Enden, Beschriftung.
    fn default() -> Self {
        SectionLook { line: SectionLineMode::Full, end_mm: SECTION_END_PIECE_MM, marker: SectionMarker::Arrow, at: SectionMarkerAt::Both, label: true }
    }
}

impl SectionLook {
    /// Welche Enden eine Marke tragen (0 = Anfang, 1 = Ende).
    pub fn marked_ends(&self) -> Vec<usize> {
        if self.marker == SectionMarker::None && !self.label {
            return Vec::new();
        }
        match self.at {
            SectionMarkerAt::Start => vec![0],
            SectionMarkerAt::End => vec![1],
            _ => vec![0, 1],
        }
    }
}

/// [276] Die Linienstücke einer Linie `pts` nach `look.line`: `[2, art, ax, ay, bx, by]` je Stück (Art 0 dünne Hauptlinie,
/// Art 1 kräftiges End-/Knickstück), Endstücke höchstens ein Drittel des Segments.
fn line_parts(pts: &[(f64, f64)], dirs: &[(f64, f64)], mm: f64, look: &SectionLook, o: &mut Vec<f64>, n: &mut usize) {
    if look.line == SectionLineMode::None {
        return;
    }
    let segs = pts.len() - 1;
    let end_mm = if look.end_mm.is_finite() && look.end_mm > 0.0 { look.end_mm } else { SECTION_END_PIECE_MM };
    let bend_mm = end_mm / 2.0;
    let mut line = |art: f64, a: (f64, f64), b: (f64, f64)| {
        o.extend([2.0, art, a.0, a.1, b.0, b.1]);
        *n += 1;
    };
    for i in 0..segs {
        let (a, b, (ux, uy)) = (pts[i], pts[i + 1], dirs[i]);
        let len = hypot2(b.0 - a.0, b.1 - a.1);
        let ps = (if i == 0 { end_mm } else { bend_mm } * mm).min(len / 3.0);
        let pe = (if i == segs - 1 { end_mm } else { bend_mm } * mm).min(len / 3.0);
        line(1.0, a, (a.0 + ux * ps, a.1 + uy * ps));
        if look.line != SectionLineMode::Ends {
            line(0.0, (a.0 + ux * ps, a.1 + uy * ps), (b.0 - ux * pe, b.1 - uy * pe));
        }
        line(1.0, (b.0 - ux * pe, b.1 - uy * pe), b);
    }
}

/// [176]/[276] Schnittlinie nach `look`: Linie (`line_parts`), je Marke (Ende laut `look.at`): `arrow` = Schenkel (8 mm) in
/// Blickrichtung mit gefülltem Dreieck, `lAngle` = Schenkel 6 mm (zusammen mit dem Endstück ein L), `triangle` = nur ein
/// gefülltes Dreieck am Ende, `none` = nichts; Beschriftung (wenn `look.label`) vor der Spitze bzw. neben dem Ende;
/// je Segment ein Pick-Band. Kurzes Beispiel: `Default` = bisheriger Pfeil.
pub fn section_polyline_look(pts: &[(f64, f64)], sign: f64, mm: f64, label_w: f64, look: &SectionLook) -> Vec<f64> {
    if pts.len() < 2 || !pts.iter().all(|p| p.0.is_finite() && p.1.is_finite()) || ![sign, mm, label_w].iter().all(|x| x.is_finite()) || !(mm > 0.0) {
        return Vec::new();
    }
    let mut pts: Vec<(f64, f64)> = pts.to_vec();
    pts.dedup_by(|b, a| hypot2(b.0 - a.0, b.1 - a.1) < 1e-6);
    if pts.len() < 2 {
        return Vec::new();
    }
    let label_h = SECTION_LABEL_MM * mm * 0.75;
    let segs = pts.len() - 1;
    let dirs: Vec<(f64, f64)> = (0..segs)
        .map(|i| {
            let (ax, ay) = (pts[i + 1].0 - pts[i].0, pts[i + 1].1 - pts[i].1);
            let l = hypot2(ax, ay);
            (ax / l, ay / l)
        })
        .collect();
    let mut o: Vec<f64> = Vec::new();
    let mut n = 0usize;
    line_parts(&pts, &dirs, mm, look, &mut o, &mut n);
    let (head_l, head_hw) = (SECTION_HEAD_LEN_MM * mm, SECTION_HEAD_HALF_MM * mm);
    for which in look.marked_ends() {
        let (end, (ux, uy)) = if which == 0 { (pts[0], dirs[0]) } else { (pts[segs], dirs[segs - 1]) };
        let (bnx, bny) = (-uy * sign, ux * sign);
        // Spitze der Marke und Richtung, in der die Beschriftung davor steht.
        let (tip, label_dir) = match look.marker {
            SectionMarker::Arrow => {
                let tip = (end.0 + bnx * SECTION_LEG_MM * mm, end.1 + bny * SECTION_LEG_MM * mm);
                o.extend([2.0, 1.0, end.0, end.1, tip.0, tip.1]);
                n += 1;
                let hb = (tip.0 - bnx * head_l, tip.1 - bny * head_l);
                o.extend([3.0, tip.0, tip.1, hb.0 + ux * head_hw, hb.1 + uy * head_hw, hb.0 - ux * head_hw, hb.1 - uy * head_hw]);
                n += 1;
                (tip, (bnx, bny))
            }
            SectionMarker::Triangle => {
                // Gefülltes Dreieck am Ende, Basis auf der Linie quer zur Blickrichtung (zeigt in Blickrichtung).
                let tip = (end.0 + bnx * TRIANGLE_HEIGHT_MM * mm, end.1 + bny * TRIANGLE_HEIGHT_MM * mm);
                let hw = TRIANGLE_HALF_MM * mm;
                o.extend([3.0, tip.0, tip.1, end.0 + ux * hw, end.1 + uy * hw, end.0 - ux * hw, end.1 - uy * hw]);
                n += 1;
                (tip, (bnx, bny))
            }
            SectionMarker::LAngle => {
                let tip = (end.0 + bnx * L_SHORT_MM * mm, end.1 + bny * L_SHORT_MM * mm);
                o.extend([2.0, 1.0, end.0, end.1, tip.0, tip.1]);
                n += 1;
                // Beschriftung neben dem Ende des kurzen Schenkels, nach aussen (längs der Linie, vom Ende weg).
                (tip, if which == 0 { (-ux, -uy) } else { (ux, uy) })
            }
            _ => (end, if which == 0 { (-ux, -uy) } else { (ux, uy) }),
        };
        if look.label {
            // Kastenmitte vor der Spitze: Abstand + halbe Ausdehnung des Kastens in Richtung `label_dir`.
            let reach = mm * 1.0 + label_dir.0.abs() * label_w / 2.0 + label_dir.1.abs() * label_h / 2.0;
            let (cx, cy) = (tip.0 + label_dir.0 * reach, tip.1 + label_dir.1 * reach);
            o.extend([5.0, cx - label_w / 2.0, cy - label_h / 2.0]);
            n += 1;
        }
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

/// [176] Ansichtsmarker (eigenes Symbol statt Schnittlinie): nur ein flaches gefülltes Dreieck (Basis 6 mm, Höhe 3 mm
/// Papier) in Blickrichtung (`sign` wie bei der Schnittlinie) mit der Basis in der Mitte der Ansichtslinie `p0`–`p1`,
/// dahinter (auf der dem Blick abgewandten Seite) waagrecht die Bezeichnung (Breite `label_w`, Schrift
/// `SECTION_LABEL_MM · mm`). `mm` = Modell-Meter je Papier-mm. Ergebnis `[n, Eintrag × n]` mit `3 triangle`,
/// `5 label [5, x, y]` (unten links) und `1 polygon` (Pick-Band über Dreieck und Text). Kein Kreis, keine Linie.
/// Leer bei zu kurzer Linie oder Unsinn.
pub fn view_marker_sized(p0x: f64, p0y: f64, p1x: f64, p1y: f64, sign: f64, mm: f64, label_w: f64) -> Vec<f64> {
    view_symbol(p0x, p0y, p1x, p1y, sign, mm, label_w, SectionMarker::Triangle, true)
}

/// [276] Ansichtsmarke nach Art: `Triangle` = wie [`view_marker_sized`]; `Arrow` = kräftiger Schenkel (8 mm) in Blickrichtung
/// mit gefülltem Dreieck (Eintrag `2 line` + `3 triangle`); sonst (`None`) kein Zeichen. Bezeichnung (wenn `label`) hinter
/// der Mitte der Linie; das Pick-Band reicht über Zeichen und Text.
#[allow(clippy::too_many_arguments)]
pub fn view_symbol(p0x: f64, p0y: f64, p1x: f64, p1y: f64, sign: f64, mm: f64, label_w: f64, marker: SectionMarker, label: bool) -> Vec<f64> {
    if ![p0x, p0y, p1x, p1y, sign, mm, label_w].iter().all(|x| x.is_finite()) || !(mm > 0.0) {
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
    let mut o: Vec<f64> = Vec::new();
    let mut n = 0.0;
    let (mut tip, mut hw) = ((cx, cy), VIEW_MARKER_HALF_MM * mm);
    match marker {
        SectionMarker::Arrow => {
            tip = (cx + bnx * SECTION_LEG_MM * mm, cy + bny * SECTION_LEG_MM * mm);
            hw = SECTION_HEAD_HALF_MM * mm;
            let hb = (tip.0 - bnx * SECTION_HEAD_LEN_MM * mm, tip.1 - bny * SECTION_HEAD_LEN_MM * mm);
            o.extend([2.0, 1.0, cx, cy, tip.0, tip.1, 3.0, tip.0, tip.1, hb.0 + ux * hw, hb.1 + uy * hw, hb.0 - ux * hw, hb.1 - uy * hw]);
            n += 2.0;
        }
        SectionMarker::None => {}
        _ => {
            tip = (cx + bnx * VIEW_MARKER_HEIGHT_MM * mm, cy + bny * VIEW_MARKER_HEIGHT_MM * mm);
            o.extend([3.0, tip.0, tip.1, cx + ux * hw, cy + uy * hw, cx - ux * hw, cy - uy * hw]);
            n += 1.0;
        }
    }
    // Bezeichnung hinter der Basis (gegen die Blickrichtung): Mitte im Abstand 1 mm + halbe Kastenausdehnung.
    let label_h = SECTION_LABEL_MM * mm * 0.75;
    let ext = bnx.abs() * label_w / 2.0 + bny.abs() * label_h / 2.0;
    let reach = mm * 1.0 + ext;
    let (lx, ly) = (cx - bnx * reach, cy - bny * reach);
    let back_d = if label {
        o.extend([5.0, lx - label_w / 2.0, ly - label_h / 2.0]);
        n += 1.0;
        reach + ext
    } else {
        0.0
    };
    // Pick-Band: orientiertes Rechteck von der Rückseite des Textes bis zur Spitze, breit genug für Zeichen und Text.
    let half_u = if label { hw.max(ux.abs() * label_w / 2.0 + uy.abs() * label_h / 2.0) } else { hw.max(mm) };
    let back = (cx - bnx * back_d, cy - bny * back_d);
    o.push(1.0);
    o.extend([back.0 + ux * half_u, back.1 + uy * half_u, tip.0 + ux * half_u, tip.1 + uy * half_u, tip.0 - ux * half_u, tip.1 - uy * half_u, back.0 - ux * half_u, back.1 - uy * half_u]);
    n += 1.0;
    let mut out = vec![n];
    out.extend(o);
    out
}

/// [276] Linienstücke der Ansichtslinie `p0`–`p1` nach `look.line` (`[n, 2 line × n]`, Art 0/1 wie bei der Schnittlinie).
pub fn view_line_parts(p0: (f64, f64), p1: (f64, f64), mm: f64, look: &SectionLook) -> Vec<f64> {
    let l = hypot2(p1.0 - p0.0, p1.1 - p0.1);
    if !(l > 1e-6) || ![p0.0, p0.1, p1.0, p1.1, mm].iter().all(|x| x.is_finite()) || !(mm > 0.0) {
        return Vec::new();
    }
    let (mut o, mut n) = (Vec::new(), 0usize);
    line_parts(&[p0, p1], &[((p1.0 - p0.0) / l, (p1.1 - p0.1) / l)], mm, look, &mut o, &mut n);
    let mut out = vec![n as f64];
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

    /// [176] Ansichtsmarker: nur flaches Dreieck (Basis 6 mm, Höhe 3 mm) in Blickrichtung, Bezeichnung dahinter, Pick-Band.
    #[test]
    fn ansichtsmarker_dreieck_label_pick() {
        let f = view_marker_sized(0.0, 0.0, 10.0, 0.0, 1.0, 0.2, 1.0);
        // Dreieck, Label, Pick (kein Kreis).
        assert_eq!(f[0], 3.0);
        assert_eq!(f[1], 3.0);
        // Spitze: Mitte (5, 0) + 3 mm · 0.2 in +y; Basis ± 3 mm · 0.2 längs der Linie.
        let near = |x: &[f64], y: &[f64]| x.iter().zip(y).all(|(a, b)| (a - b).abs() < 1e-9);
        assert!(near(&f[2..8], &[5.0, 0.6, 5.6, 0.0, 4.4, 0.0]), "{:?}", &f[2..8]);
        // Label hinter der Basis (y < 0), waagrecht um x = 5 zentriert, ohne das Dreieck zu berühren.
        assert_eq!(f[8], 5.0);
        let label_h = 3.5 * 0.2 * 0.75;
        assert!((f[9] - 4.5).abs() < 1e-9 && f[10] + 0.0 < 0.0 && f[10] + label_h <= -0.2 + 1e-9, "{:?}", &f[8..11]);
        assert_eq!(f[11], 1.0);
        assert!(view_marker_sized(0.0, 0.0, 0.0, 0.0, 1.0, 0.2, 1.0).is_empty());
        assert!(view_marker_sized(f64::NAN, 0.0, 1.0, 0.0, 1.0, 0.2, 1.0).is_empty());
    }

    const L_LOOK: SectionLook = SectionLook { line: SectionLineMode::Ends, end_mm: 12.0, marker: SectionMarker::LAngle, at: SectionMarkerAt::Both, label: true };

    /// Zählt Einträge je Art (2 line art 0, 2 line art 1, 3 triangle, 5 label, 1 polygon).
    fn kinds(f: &[f64]) -> (usize, usize, usize, usize, usize) {
        let (mut i, mut r) = (1, (0, 0, 0, 0, 0));
        for _ in 0..f[0] as usize {
            match f[i] {
                2.0 => {
                    if f[i + 1] == 0.0 { r.0 += 1 } else { r.1 += 1 }
                    i += 6;
                }
                3.0 => {
                    r.2 += 1;
                    i += 7;
                }
                5.0 => {
                    r.3 += 1;
                    i += 3;
                }
                _ => {
                    r.4 += 1;
                    i += 9;
                }
            }
        }
        r
    }

    /// [276] Varianten: Linie durchgehend/Enden/keine, Marke Pfeil/L/Dreieck/keine, Ende Anfang/Ende, ohne Beschriftung.
    #[test]
    fn darstellung_varianten() {
        let pts = [(0.0, 0.0), (10.0, 0.0)];
        let run = |l: SectionLook| kinds(&section_polyline_look(&pts, 1.0, 0.2, 1.0, &l));
        let base = SectionLook::default();
        // (dünn, kräftig, Dreieck, Label, Pick)
        assert_eq!(run(base), (1, 4, 2, 2, 1));
        assert_eq!(run(SectionLook { line: SectionLineMode::Ends, ..base }), (0, 4, 2, 2, 1));
        assert_eq!(run(SectionLook { line: SectionLineMode::None, ..base }), (0, 2, 2, 2, 1));
        assert_eq!(run(SectionLook { line: SectionLineMode::None, marker: SectionMarker::Triangle, ..base }), (0, 0, 2, 2, 1));
        assert_eq!(run(SectionLook { line: SectionLineMode::None, marker: SectionMarker::None, label: false, ..base }), (0, 0, 0, 0, 1));
        assert_eq!(run(SectionLook { marker: SectionMarker::Triangle, at: SectionMarkerAt::Start, ..base }), (1, 2, 1, 1, 1));
        assert_eq!(run(SectionLook { marker: SectionMarker::LAngle, at: SectionMarkerAt::End, label: false, ..base }), (1, 3, 0, 0, 1));
        // Dreieck am Ende: Basis auf der Linie, Spitze in Blickrichtung.
        let f = section_polyline_look(&pts, 1.0, 0.2, 1.0, &SectionLook { line: SectionLineMode::None, marker: SectionMarker::Triangle, at: SectionMarkerAt::End, label: false, ..base });
        assert_eq!(f[0], 2.0);
        assert!((f[2] - 10.0).abs() < 1e-9 && (f[3] - 0.9).abs() < 1e-9, "{f:?}");
        // Länge der Endstücke.
        let f = section_polyline_look(&pts, 1.0, 0.2, 1.0, &SectionLook { end_mm: 15.0, marker: SectionMarker::None, label: false, ..base });
        assert!((f[5] - 3.0).abs() < 1e-9, "15 mm · 0.2 = 3 m: {f:?}");
    }

    /// [276] Ansicht: Dreieck (heute), Pfeil, keine Marke; Linie nur bei `full`/`ends`.
    #[test]
    fn ansicht_zeichen_und_linie() {
        let sym = |m, label| kinds(&view_symbol(0.0, 0.0, 10.0, 0.0, 1.0, 0.2, 1.0, m, label));
        assert_eq!(sym(SectionMarker::Triangle, true), (0, 0, 1, 1, 1));
        assert_eq!(view_symbol(0.0, 0.0, 10.0, 0.0, 1.0, 0.2, 1.0, SectionMarker::Triangle, true), view_marker_sized(0.0, 0.0, 10.0, 0.0, 1.0, 0.2, 1.0));
        assert_eq!(sym(SectionMarker::Arrow, true), (0, 1, 1, 1, 1));
        assert_eq!(sym(SectionMarker::None, false), (0, 0, 0, 0, 1));
        let look = SectionLook::default();
        assert_eq!(kinds(&view_line_parts((0.0, 0.0), (10.0, 0.0), 0.2, &look)), (1, 2, 0, 0, 0));
        assert_eq!(kinds(&view_line_parts((0.0, 0.0), (10.0, 0.0), 0.2, &SectionLook { line: SectionLineMode::Ends, ..look })), (0, 2, 0, 0, 0));
        assert_eq!(view_line_parts((0.0, 0.0), (10.0, 0.0), 0.2, &SectionLook { line: SectionLineMode::None, ..look })[0], 0.0);
    }

    /// [176] L-Marke: je Ende zwei kräftige Linien (12 mm längs der Linie nach innen, 6 mm in Blickrichtung), keine
    /// dünne Linie, kein Dreieck; Label ausserhalb neben dem kurzen Schenkel; Pick-Band je Segment.
    #[test]
    fn l_marke_zwei_schenkel_je_ende_ohne_linie() {
        let f = section_polyline_look(&[(0.0, 0.0), (10.0, 0.0)], 1.0, 0.2, 1.0, &L_LOOK);
        // 2 × (langer + kurzer Schenkel + Label) + 1 Pick = 7
        assert_eq!(f[0], 7.0);
        let near = |x: &[f64], y: &[f64]| x.iter().zip(y).all(|(a, b)| (a - b).abs() < 1e-9);
        assert!(near(&f[1..7], &[2.0, 1.0, 0.0, 0.0, 2.4, 0.0]), "lang links");
        assert!(near(&f[7..13], &[2.0, 1.0, 7.6, 0.0, 10.0, 0.0]), "lang rechts");
        assert!(near(&f[13..19], &[2.0, 1.0, 0.0, 0.0, 0.0, 1.2]), "kurz links");
        // Label links: ausserhalb (x < 0) auf Höhe des kurzen Schenkels (y ≈ 1.2).
        assert_eq!(f[19], 5.0);
        assert!(f[20] + 1.0 < 0.0 && (f[21] + 3.5 * 0.2 * 0.75 / 2.0 - 1.2).abs() < 1e-9, "{:?}", &f[19..22]);
        // Weder dünne Linie (art 0) noch Dreieck (3).
        let mut i = 1;
        for _ in 0..7 {
            match f[i] {
                2.0 => {
                    assert_eq!(f[i + 1], 1.0);
                    i += 6;
                }
                5.0 => i += 3,
                1.0 => i += 9,
                t => panic!("unerwarteter Eintrag {t}"),
            }
        }
        // Pfeil unverändert.
        assert_eq!(section_polyline_look(&[(0.0, 0.0), (10.0, 0.0)], 1.0, 0.2, 1.0, &SectionLook::default()), section_line_sized(0.0, 0.0, 10.0, 0.0, 1.0, 0.2, 1.0));
    }

    /// [176] L-Marke mit Knick: Knickstücke (6 mm) bleiben, Schenkel nur an den Enden.
    #[test]
    fn l_marke_geknickt_behaelt_knickstuecke() {
        let f = section_polyline_look(&[(0.0, 0.0), (10.0, 0.0), (10.0, 8.0)], 1.0, 0.2, 1.0, &L_LOOK);
        // 4 Endstücke/Knickstücke je Segment 2 = 4, 2 kurze Schenkel, 2 Label, 2 Pick = 10
        assert_eq!(f[0], 10.0);
        let near = |x: &[f64], y: &[f64]| x.iter().zip(y).all(|(a, b)| (a - b).abs() < 1e-9);
        assert!(near(&f[7..13], &[2.0, 1.0, 8.8, 0.0, 10.0, 0.0]));
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
