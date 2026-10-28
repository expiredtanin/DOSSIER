// Beschriftungs-Geometrie für den Import: Pfeilspitzen und Bemassungen, die nicht als fertiger
// Anonymblock (`*D…`) in der Datei stehen, sowie Führungslinien-Splines.
//
// Reine 2D-Funktionen in Weltkoordinaten (Ergebnis: [`Shape`]), unabhängig von acadrust; der
// Import (`import.rs`) liest Bemassungsstil und Definitionspunkte und gibt hier die Zahlen hinein.
// Abgebildet ist das, was AutoCAD für Standard-Einstellungen zeichnet — keine Wiedergabe jedes
// DIM-Schalters (Textrahmen, Toleranzen, Alternativeinheiten, Architektur-/Ingenieureinheiten fehlen).
//
// Pfeilspitzen (Bemassungsstil `DIMBLK`/`DIMLDRBLK`, Blockname des Pfeils):
//   ""/_CLOSEDFILLED gefülltes Dreieck · _CLOSEDBLANK/_CLOSED Dreieck · _OPEN/_OPEN30/_OPEN90 offenes V ·
//   _DOT/_DOTSMALL gefüllter Punkt · _DOTBLANK/_SMALL/_ORIGIN Kreis · _ARCHTICK/_OBLIQUE Schrägstrich ·
//   _BOXFILLED/_BOXBLANK Quadrat · _NONE ohne. Unbekannte (eigene Blöcke) fallen auf das gefüllte
//   Dreieck zurück.

use std::f64::consts::{FRAC_PI_2, PI, TAU};

use crate::text::{self, HAlign, VAlign};

#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    Poly { pts: Vec<[f64; 2]>, closed: bool, filled: bool },
    Text { at: [f64; 2], height: f64, angle: f64, text: String },
}

fn line(a: [f64; 2], b: [f64; 2]) -> Shape {
    Shape::Poly { pts: vec![a, b], closed: false, filled: false }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrowKind {
    ClosedFilled,
    ClosedBlank,
    Open,
    Open30,
    Open90,
    Dot,
    DotSmall,
    DotBlank,
    Origin,
    Oblique,
    BoxFilled,
    BoxBlank,
    None,
}

/// Pfeilart aus dem Blocknamen (ohne Beachtung der Gross-/Kleinschreibung, `_` am Anfang optional).
pub fn arrow_kind(name: &str) -> ArrowKind {
    let n = name.trim().trim_start_matches('_').to_ascii_uppercase();
    match n.as_str() {
        "" | "CLOSEDFILLED" => ArrowKind::ClosedFilled,
        "CLOSEDBLANK" | "CLOSED" | "DATUMBLANK" => ArrowKind::ClosedBlank,
        "OPEN" => ArrowKind::Open,
        "OPEN30" => ArrowKind::Open30,
        "OPEN90" => ArrowKind::Open90,
        "DOT" => ArrowKind::Dot,
        "DOTSMALL" => ArrowKind::DotSmall,
        "DOTBLANK" => ArrowKind::DotBlank,
        "SMALL" | "ORIGIN" | "ORIGIN2" => ArrowKind::Origin,
        "ARCHTICK" | "OBLIQUE" | "INTEGRAL" => ArrowKind::Oblique,
        "BOXFILLED" => ArrowKind::BoxFilled,
        "BOXBLANK" => ArrowKind::BoxBlank,
        "NONE" => ArrowKind::None,
        _ => ArrowKind::ClosedFilled,
    }
}

fn add(a: [f64; 2], b: [f64; 2], k: f64) -> [f64; 2] {
    [a[0] + b[0] * k, a[1] + b[1] * k]
}

fn norm(v: [f64; 2]) -> Option<[f64; 2]> {
    let l = v[0].hypot(v[1]);
    (l.is_finite() && l > 1e-12).then(|| [v[0] / l, v[1] / l])
}

fn circle_pts(c: [f64; 2], r: f64) -> Vec<[f64; 2]> {
    (0..16)
        .map(|i| {
            let t = TAU * i as f64 / 16.0;
            [c[0] + r * t.cos(), c[1] + r * t.sin()]
        })
        .collect()
}

/// Pfeilspitze mit Spitze `tip`; `dir` zeigt von der Spitze in Richtung des Pfeilkörpers (also
/// entlang der Linie, an der der Pfeil sitzt, von der Spitze weg).
pub fn arrow(kind: ArrowKind, tip: [f64; 2], dir: [f64; 2], size: f64) -> Vec<Shape> {
    let Some(d) = norm(dir) else { return Vec::new() };
    if !(size.is_finite() && size > 0.0) || !tip.iter().all(|v| v.is_finite()) {
        return Vec::new();
    }
    let p = [-d[1], d[0]];
    let base = add(tip, d, size);
    match kind {
        ArrowKind::None => Vec::new(),
        ArrowKind::ClosedFilled | ArrowKind::ClosedBlank => {
            let pts = vec![tip, add(base, p, size / 6.0), add(base, p, -size / 6.0)];
            vec![Shape::Poly { pts, closed: true, filled: kind == ArrowKind::ClosedFilled }]
        }
        ArrowKind::Open | ArrowKind::Open30 | ArrowKind::Open90 => {
            let half: f64 = if kind == ArrowKind::Open90 { PI / 4.0 } else { PI / 12.0 };
            let w = size * half.tan();
            vec![Shape::Poly { pts: vec![add(base, p, w), tip, add(base, p, -w)], closed: false, filled: false }]
        }
        ArrowKind::Dot => vec![Shape::Poly { pts: circle_pts(tip, size / 2.0), closed: true, filled: true }],
        ArrowKind::DotSmall => vec![Shape::Poly { pts: circle_pts(tip, size / 4.0), closed: true, filled: true }],
        ArrowKind::DotBlank => vec![Shape::Poly { pts: circle_pts(tip, size / 2.0), closed: true, filled: false }],
        ArrowKind::Origin => vec![Shape::Poly { pts: circle_pts(tip, size / 4.0), closed: true, filled: false }],
        ArrowKind::Oblique => {
            let s = size / 2.0;
            let v = [d[0] + p[0], d[1] + p[1]];
            vec![line(add(tip, v, -s), add(tip, v, s))]
        }
        ArrowKind::BoxFilled | ArrowKind::BoxBlank => {
            let h = size / 2.0;
            let pts = vec![
                add(add(tip, d, -h), p, -h),
                add(add(tip, d, h), p, -h),
                add(add(tip, d, h), p, h),
                add(add(tip, d, -h), p, h),
            ];
            vec![Shape::Poly { pts, closed: true, filled: kind == ArrowKind::BoxFilled }]
        }
    }
}

/// Spline durch Stützpunkte (Catmull-Rom, je Feld 8 Teilstücke) — Form einer LEADER/MULTILEADER mit
/// Spline-Pfad. Weniger als 3 Punkte bleiben unverändert.
pub fn spline_through(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let at = |i: isize| pts[i.clamp(0, n as isize - 1) as usize];
    let mut out = vec![pts[0]];
    for i in 0..n as isize - 1 {
        let (p0, p1, p2, p3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
        for s in 1..=8 {
            let t = s as f64 / 8.0;
            let (t2, t3) = (t * t, t * t * t);
            let f = |k: usize| {
                0.5 * ((2.0 * p1[k])
                    + (-p0[k] + p2[k]) * t
                    + (2.0 * p0[k] - 5.0 * p1[k] + 4.0 * p2[k] - p3[k]) * t2
                    + (-p0[k] + 3.0 * p1[k] - 3.0 * p2[k] + p3[k]) * t3)
            };
            out.push([f(0), f(1)]);
        }
    }
    out
}

// ── Bemassung ─────────────────────────────────────────────────────────────────

/// Die für den Aufbau nötigen Werte des Bemassungsstils (Namen wie die DIM-Variablen).
#[derive(Debug, Clone, PartialEq)]
pub struct DimStyleVals {
    /// DIMASZ Pfeilgrösse
    pub asz: f64,
    /// DIMTSZ Schrägstrich-Grösse (> 0 ersetzt die Pfeile)
    pub tsz: f64,
    /// DIMTXT Texthöhe
    pub txt: f64,
    /// DIMGAP Abstand Text–Linie (Betrag)
    pub gap: f64,
    /// DIMEXO Abstand Hilfslinie–Objekt
    pub exo: f64,
    /// DIMEXE Überstand der Hilfslinie
    pub exe: f64,
    /// DIMSCALE Gesamtmassstab (0 = 1)
    pub scale: f64,
    /// DIMDEC Nachkommastellen
    pub dec: i16,
    /// DIMADEC Nachkommastellen von Winkeln (< 0 = wie DIMDEC)
    pub adec: i16,
    /// DIMZIN Nullenunterdrückung (4 = führende, 8 = nachlaufende)
    pub zin: i16,
    /// DIMDSEP Dezimaltrenner (Zeichencode, 0 = Punkt)
    pub dsep: i16,
    /// DIMPOST Vor-/Nachsilbe, `<>` = Wert
    pub post: String,
    /// DIMLFAC Längenfaktor
    pub lfac: f64,
    /// DIMRND Rundung
    pub rnd: f64,
    /// DIMTAD Text über der Linie (> 0) oder in der Linie (0)
    pub tad: i16,
    /// DIMCEN Mittelpunktmarke (> 0 Kreuz)
    pub cen: f64,
    /// Pfeil an Anfang/Ende der Massline
    pub arrow1: ArrowKind,
    pub arrow2: ArrowKind,
    /// Pfeil der Führungslinien (DIMLDRBLK)
    pub leader_arrow: ArrowKind,
    /// Hilfslinien unterdrückt (DIMSE1/DIMSE2) und Masslinien-Hälften unterdrückt (DIMSD1/DIMSD2)
    pub se1: bool,
    pub se2: bool,
    pub sd1: bool,
    pub sd2: bool,
}

impl Default for DimStyleVals {
    /// AutoCAD-Vorgaben für Architekturzeichnungen in Metern (DIMASZ 0,18 usw.).
    fn default() -> Self {
        DimStyleVals {
            asz: 0.18,
            tsz: 0.0,
            txt: 0.18,
            gap: 0.09,
            exo: 0.0625,
            exe: 0.18,
            scale: 1.0,
            dec: 2,
            adec: -1,
            zin: 0,
            dsep: 0,
            post: String::new(),
            lfac: 1.0,
            rnd: 0.0,
            tad: 0,
            cen: 0.09,
            arrow1: ArrowKind::ClosedFilled,
            arrow2: ArrowKind::ClosedFilled,
            leader_arrow: ArrowKind::ClosedFilled,
            se1: false,
            se2: false,
            sd1: false,
            sd2: false,
        }
    }
}

impl DimStyleVals {
    fn s(&self) -> f64 {
        if self.scale.is_finite() && self.scale > 0.0 {
            self.scale
        } else {
            1.0
        }
    }
    fn positive(v: f64, fallback: f64) -> f64 {
        if v.is_finite() && v > 0.0 {
            v
        } else {
            fallback
        }
    }
    /// Pfeilgrösse einschliesslich Massstab.
    pub fn arrow_size(&self) -> f64 {
        let d = DimStyleVals::default();
        Self::positive(if self.tsz > 0.0 { self.tsz * 2.0 } else { self.asz }, d.asz) * self.s()
    }
    pub fn text_height(&self) -> f64 {
        Self::positive(self.txt, DimStyleVals::default().txt) * self.s()
    }
    fn gap_s(&self) -> f64 {
        let g = self.gap.abs();
        (if g.is_finite() && g > 0.0 { g } else { DimStyleVals::default().gap }) * self.s()
    }
    fn exo_s(&self) -> f64 {
        (if self.exo.is_finite() { self.exo.max(0.0) } else { 0.0 }) * self.s()
    }
    fn exe_s(&self) -> f64 {
        (if self.exe.is_finite() { self.exe.max(0.0) } else { 0.0 }) * self.s()
    }
    fn kinds(&self) -> (ArrowKind, ArrowKind) {
        if self.tsz > 0.0 {
            (ArrowKind::Oblique, ArrowKind::Oblique)
        } else {
            (self.arrow1, self.arrow2)
        }
    }
}

/// Messwert als Text nach Stil: Längenfaktor, Rundung, Nachkommastellen, Nullenunterdrückung,
/// Dezimaltrenner, Vor-/Nachsilbe (`<>` = Platzhalter).
pub fn format_dim_value(v: f64, st: &DimStyleVals) -> String {
    if !v.is_finite() {
        return String::new();
    }
    let mut v = if st.lfac.is_finite() && st.lfac != 0.0 { v * st.lfac } else { v };
    if st.rnd.is_finite() && st.rnd > 0.0 {
        v = (v / st.rnd).round() * st.rnd;
    }
    let s = number_text(v, st.dec.clamp(0, 16) as usize, st);
    apply_post(&s, &st.post)
}

fn number_text(v: f64, dec: usize, st: &DimStyleVals) -> String {
    let mut s = format!("{v:.dec$}");
    if s.starts_with("-") && s[1..].chars().all(|c| c == '0' || c == '.') {
        s.remove(0); // „-0,00" vermeiden
    }
    if st.zin & 8 != 0 && s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    if st.zin & 4 != 0 {
        if let Some(rest) = s.strip_prefix("0.") {
            s = format!(".{rest}");
        } else if let Some(rest) = s.strip_prefix("-0.") {
            s = format!("-.{rest}");
        }
    }
    if st.dsep > 0 {
        if let Some(c) = char::from_u32(st.dsep as u32) {
            if c != '.' {
                s = s.replace('.', &c.to_string());
            }
        }
    }
    s
}

fn apply_post(s: &str, post: &str) -> String {
    if post.is_empty() {
        s.to_string()
    } else if post.contains("<>") {
        post.replace("<>", s)
    } else {
        format!("{s}{post}")
    }
}

/// Text einer Bemassung: Benutzertext (`<>` = Messwert) oder der Messwert; leerer Benutzertext
/// (ein Leerzeichen) unterdrückt den Text.
pub fn dim_text(user: Option<&str>, measured: &str) -> String {
    match user {
        Some(t) if !t.is_empty() => text::mtext_plain(&t.replace("<>", measured)),
        _ => measured.to_string(),
    }
}

/// Lesbare Textdrehung: Winkel in (−90°, 90°], damit der Text nie auf dem Kopf steht.
pub fn readable_angle(a: f64) -> f64 {
    let mut a = a.rem_euclid(TAU);
    if a > PI {
        a -= TAU;
    }
    if a > FRAC_PI_2 + 1e-9 {
        a -= PI;
    } else if a <= -FRAC_PI_2 + 1e-9 {
        a += PI;
    }
    a
}

/// Zentrierter Text mit Mittelpunkt `mid`.
fn centered_text(mid: [f64; 2], height: f64, angle: f64, text: &str) -> Shape {
    let w = text::text_width(text, height, 1.0);
    let at = text::baseline_start(mid, HAlign::Center, VAlign::Middle, w, height, angle);
    Shape::Text { at, height, angle, text: text.to_string() }
}

fn finite_pt(p: [f64; 2]) -> bool {
    p[0].is_finite() && p[1].is_finite()
}

/// Eingaben einer linearen/ausgerichteten Bemassung (Weltkoordinaten, Ebene).
pub struct LinearDim<'a> {
    pub p1: [f64; 2],
    pub p2: [f64; 2],
    /// Punkt auf der Masslinie (Gruppe 10)
    pub def: [f64; 2],
    /// Richtung der Masslinie (Radiant)
    pub angle: f64,
    /// Textmittelpunkt aus der Datei; `None` = automatisch (über/in der Masslinie)
    pub text_mid: Option<[f64; 2]>,
    /// Benutzertext
    pub user_text: Option<&'a str>,
    /// Textdrehung aus der Datei (0 = entlang der Masslinie)
    pub text_rotation: f64,
}

/// Lineare oder ausgerichtete Bemassung: Hilfslinien, Masslinie mit Pfeilen, Text.
pub fn linear_dimension(d: &LinearDim, st: &DimStyleVals) -> Vec<Shape> {
    if !(finite_pt(d.p1) && finite_pt(d.p2) && finite_pt(d.def) && d.angle.is_finite()) {
        return Vec::new();
    }
    let u = [d.angle.cos(), d.angle.sin()];
    let v = [-u[1], u[0]];
    let dot = |a: [f64; 2], b: [f64; 2]| a[0] * b[0] + a[1] * b[1];
    let sub = |a: [f64; 2], b: [f64; 2]| [a[0] - b[0], a[1] - b[1]];
    let off1 = dot(sub(d.def, d.p1), v);
    let off2 = dot(sub(d.def, d.p2), v);
    let q1 = add(d.p1, v, off1);
    let q2 = add(d.p2, v, off2);
    let len = dot(sub(q2, q1), u);
    let measured = format_dim_value(len.abs(), st);
    let mut out = Vec::new();

    // Hilfslinien: vom Objektpunkt (mit Abstand) bis über die Masslinie hinaus.
    let (exo, exe) = (st.exo_s(), st.exe_s());
    for (p, q, off, suppress) in [(d.p1, q1, off1, st.se1), (d.p2, q2, off2, st.se2)] {
        if suppress || off.abs() <= exo {
            continue;
        }
        let sg = off.signum();
        out.push(line(add(p, v, sg * exo), add(q, v, sg * exe)));
    }
    if len.abs() < 1e-9 {
        return out;
    }
    let dir = [u[0] * len.signum(), u[1] * len.signum()];
    let asz = st.arrow_size();
    let (k1, k2) = st.kinds();
    let ticks = matches!(k1, ArrowKind::Oblique);
    // Passen die Pfeile nicht zwischen die Hilfslinien, zeigen sie von aussen auf die Linie.
    let inside = ticks || len.abs() >= 2.2 * asz;
    let (d1, d2) = if inside { (dir, [-dir[0], -dir[1]]) } else { ([-dir[0], -dir[1]], dir) };
    if !st.sd1 {
        out.extend(arrow(k1, q1, d1, asz));
    }
    if !st.sd2 {
        out.extend(arrow(k2, q2, d2, asz));
    }

    // Text: Datei-Position oder über der Mitte (DIMTAD) bzw. in der Linie.
    let th = st.text_height();
    let text_angle = if d.text_rotation.abs() > 1e-12 { d.text_rotation } else { readable_angle(d.angle) };
    let mid = [(q1[0] + q2[0]) / 2.0, (q1[1] + q2[1]) / 2.0];
    let label = dim_text(d.user_text, &measured);
    let tw = text::text_width(&label, th, 1.0);
    let up = [-text_angle.sin(), text_angle.cos()];
    let (text_at, in_line) = match d.text_mid {
        Some(p) if finite_pt(p) => (p, false),
        _ if st.tad > 0 => (add(mid, up, st.gap_s() + th / 2.0), false),
        _ => (mid, true),
    };
    // Masslinie; liegt der Text mittig darin, wird sie um den Text unterbrochen.
    let tail = if inside { 0.0 } else { 1.5 * asz };
    let a = add(q1, dir, -tail);
    let b = add(q2, dir, tail);
    let on_line = |p: [f64; 2]| (dot(sub(p, q1), v)).abs() < 1e-6;
    if (in_line || on_line(text_at)) && !label.is_empty() && inside && tw + 2.0 * st.gap_s() < len.abs() - 2.0 * asz {
        let t = dot(sub(text_at, q1), dir);
        let half = tw / 2.0 + st.gap_s();
        let pa = add(q1, dir, t - half);
        let pb = add(q1, dir, t + half);
        if !st.sd1 {
            out.push(line(a, pa));
        }
        if !st.sd2 {
            out.push(line(pb, b));
        }
    } else {
        out.push(line(a, b));
    }
    if !label.is_empty() {
        out.push(centered_text(text_at, th, text_angle, &label));
    }
    out
}

/// Radius-/Durchmesserbemassung. `center` = Kreismittelpunkt, `on_arc` = Punkt auf dem Kreis.
pub fn radial_dimension(
    center: [f64; 2],
    on_arc: [f64; 2],
    diameter: bool,
    text_mid: Option<[f64; 2]>,
    user_text: Option<&str>,
    st: &DimStyleVals,
) -> Vec<Shape> {
    if !(finite_pt(center) && finite_pt(on_arc)) {
        return Vec::new();
    }
    let Some(out_dir) = norm([on_arc[0] - center[0], on_arc[1] - center[1]]) else { return Vec::new() };
    let r = (on_arc[0] - center[0]).hypot(on_arc[1] - center[1]);
    let asz = st.arrow_size();
    let (k1, k2) = st.kinds();
    let mut out = Vec::new();
    let inward = [-out_dir[0], -out_dir[1]];
    let measured = {
        let v = if diameter { 2.0 * r } else { r };
        let prefix = if diameter { "Ø" } else { "R" };
        format!("{prefix}{}", format_dim_value(v, st))
    };
    let label = dim_text(user_text, &measured);
    let th = st.text_height();
    let angle = 0.0;
    if diameter {
        let far = [center[0] - out_dir[0] * r, center[1] - out_dir[1] * r];
        out.push(line(far, on_arc));
        out.extend(arrow(k1, on_arc, inward, asz));
        out.extend(arrow(k2, far, out_dir, asz));
    } else {
        out.push(line(center, on_arc));
        out.extend(arrow(k1, on_arc, inward, asz));
    }
    // Mittelpunktmarke
    if st.cen > 0.0 && st.cen.is_finite() {
        let c = st.cen * st.s();
        out.push(line([center[0] - c, center[1]], [center[0] + c, center[1]]));
        out.push(line([center[0], center[1] - c], [center[0], center[1] + c]));
    }
    let tw = text::text_width(&label, th, 1.0);
    let at = match text_mid {
        Some(p) if finite_pt(p) => p,
        _ => {
            // ausserhalb des Kreises, in Verlängerung der Linie
            let reach = asz + st.gap_s() + tw / 2.0;
            let p = add(on_arc, out_dir, reach);
            out.push(line(on_arc, add(on_arc, out_dir, asz + tw + 2.0 * st.gap_s())));
            p
        }
    };
    if !label.is_empty() {
        out.push(centered_text(at, th, angle, &label));
    }
    out
}

/// Winkel von `a` nach `b` gegen den Uhrzeigersinn, in [0, 2π).
fn ccw_sweep(a: f64, b: f64) -> f64 {
    (b - a).rem_euclid(TAU)
}

/// Winkelbemassung: Bogen um `center` mit Radius `r` von `a1` über `sweep` (CCW), Pfeile an den
/// Enden (tangential), Hilfslinien von `ext` (Abstand vom Mittelpunkt, bis zu dem die Objektlinie
/// reicht) bis zum Bogen.
pub fn angular_arc(
    center: [f64; 2],
    r: f64,
    a1: f64,
    sweep: f64,
    ext: [Option<f64>; 2],
    text_mid: Option<[f64; 2]>,
    user_text: Option<&str>,
    st: &DimStyleVals,
) -> Vec<Shape> {
    if !(finite_pt(center) && r.is_finite() && r > 1e-9 && a1.is_finite() && sweep.is_finite() && sweep > 1e-9) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let segs = ((sweep / (PI / 32.0)).ceil() as usize).clamp(4, 256);
    let pts: Vec<[f64; 2]> = (0..=segs)
        .map(|i| {
            let t = a1 + sweep * i as f64 / segs as f64;
            [center[0] + r * t.cos(), center[1] + r * t.sin()]
        })
        .collect();
    out.push(Shape::Poly { pts, closed: false, filled: false });
    let (exo, exe) = (st.exo_s(), st.exe_s());
    for (k, (ang, dist)) in [(a1, ext[0]), (a1 + sweep, ext[1])].into_iter().enumerate() {
        let u = [ang.cos(), ang.sin()];
        if let Some(dd) = dist {
            let suppressed = if k == 0 { st.se1 } else { st.se2 };
            if !suppressed && dd + exo < r {
                out.push(line(add(center, u, dd + exo), add(center, u, r + exe)));
            }
        }
    }
    let asz = st.arrow_size();
    let (k1, k2) = st.kinds();
    let t1 = [-a1.sin(), a1.cos()];
    let a2 = a1 + sweep;
    let t2 = [a2.sin(), -a2.cos()];
    // Passt der Bogen nicht zwischen die Pfeile, zeigen sie nach aussen.
    let fits = sweep * r >= 2.2 * asz;
    let (t1, t2) = if fits { (t1, t2) } else { ([-t1[0], -t1[1]], [-t2[0], -t2[1]]) };
    out.extend(arrow(k1, [center[0] + r * a1.cos(), center[1] + r * a1.sin()], t1, asz));
    out.extend(arrow(k2, [center[0] + r * a2.cos(), center[1] + r * a2.sin()], t2, asz));
    let adec = if st.adec >= 0 { st.adec } else { st.dec };
    let deg = sweep.to_degrees();
    let measured = {
        let vals = DimStyleVals { dec: adec, post: String::new(), lfac: 1.0, rnd: 0.0, ..st.clone() };
        format!("{}°", number_text(deg, adec.clamp(0, 16) as usize, &vals))
    };
    let label = dim_text(user_text, &measured);
    let th = st.text_height();
    let mid_a = a1 + sweep / 2.0;
    let at = match text_mid {
        Some(p) if finite_pt(p) => p,
        _ => add(center, [mid_a.cos(), mid_a.sin()], r + st.gap_s() + th / 2.0),
    };
    if !label.is_empty() {
        out.push(centered_text(at, th, readable_angle(mid_a + FRAC_PI_2), &label));
    }
    out
}

/// Winkelbemassung aus drei Punkten: Scheitel `vertex`, Schenkelpunkte `p1`/`p2`, `arc_pt` bestimmt
/// Bogenradius und die Seite (die Hälfte, in der der Bogenpunkt liegt).
pub fn angular_3pt(
    vertex: [f64; 2],
    p1: [f64; 2],
    p2: [f64; 2],
    arc_pt: [f64; 2],
    text_mid: Option<[f64; 2]>,
    user_text: Option<&str>,
    st: &DimStyleVals,
) -> Vec<Shape> {
    if !(finite_pt(vertex) && finite_pt(p1) && finite_pt(p2) && finite_pt(arc_pt)) {
        return Vec::new();
    }
    let ang = |p: [f64; 2]| (p[1] - vertex[1]).atan2(p[0] - vertex[0]);
    let dist = |p: [f64; 2]| (p[0] - vertex[0]).hypot(p[1] - vertex[1]);
    let r = dist(arc_pt);
    let (a1, a2, ap) = (ang(p1), ang(p2), ang(arc_pt));
    // Bogen von a1 nach a2 (CCW); liegt der Bogenpunkt nicht darin, ist es der Gegenbogen.
    let (start, sweep, e0, e1) = if ccw_sweep(a1, ap) <= ccw_sweep(a1, a2) {
        (a1, ccw_sweep(a1, a2), dist(p1), dist(p2))
    } else {
        (a2, ccw_sweep(a2, a1), dist(p2), dist(p1))
    };
    angular_arc(vertex, r, start, sweep, [Some(e0), Some(e1)], text_mid, user_text, st)
}

/// Schnittpunkt zweier Geraden (Punkt + Richtung); `None` bei Parallelen.
fn intersect(p: [f64; 2], d: [f64; 2], q: [f64; 2], e: [f64; 2]) -> Option<[f64; 2]> {
    let den = d[0] * e[1] - d[1] * e[0];
    if den.abs() < 1e-12 * (d[0].hypot(d[1]) * e[0].hypot(e[1])).max(1e-300) {
        return None;
    }
    let t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
    Some([p[0] + d[0] * t, p[1] + d[1] * t])
}

/// Winkelbemassung aus zwei Linien (`l1`, `l2` je Anfang/Ende) und einem Bogenpunkt.
pub fn angular_2line(
    l1: ([f64; 2], [f64; 2]),
    l2: ([f64; 2], [f64; 2]),
    arc_pt: [f64; 2],
    text_mid: Option<[f64; 2]>,
    user_text: Option<&str>,
    st: &DimStyleVals,
) -> Vec<Shape> {
    let pts = [l1.0, l1.1, l2.0, l2.1, arc_pt];
    if !pts.iter().all(|p| finite_pt(*p)) {
        return Vec::new();
    }
    let d1 = [l1.1[0] - l1.0[0], l1.1[1] - l1.0[1]];
    let d2 = [l2.1[0] - l2.0[0], l2.1[1] - l2.0[1]];
    let Some(v) = intersect(l1.0, d1, l2.0, d2) else { return Vec::new() };
    let ap = (arc_pt[1] - v[1]).atan2(arc_pt[0] - v[0]);
    let r = (arc_pt[0] - v[0]).hypot(arc_pt[1] - v[1]);
    // Strahlenpaar (±d1, ±d2), dessen kleinerer Sektor den Bogenpunkt enthält.
    let base1 = d1[1].atan2(d1[0]);
    let base2 = d2[1].atan2(d2[0]);
    let mut best: Option<(f64, f64, f64)> = None; // (start, sweep, ...)
    for s1 in [0.0, PI] {
        for s2 in [0.0, PI] {
            let (a, b) = (base1 + s1, base2 + s2);
            for (start, end) in [(a, b), (b, a)] {
                let sweep = ccw_sweep(start, end);
                if sweep > 1e-9 && ccw_sweep(start, ap) <= sweep && best.map_or(true, |(_, bs, _)| sweep < bs) {
                    best = Some((start, sweep, 0.0));
                }
            }
        }
    }
    let Some((start, sweep, _)) = best else { return Vec::new() };
    // Reichweite der Objektlinien entlang der Strahlen (grösster Abstand der Endpunkte in Strahlrichtung).
    let reach = |ang: f64, line: ([f64; 2], [f64; 2])| {
        let u = [ang.cos(), ang.sin()];
        [line.0, line.1].iter().map(|p| (p[0] - v[0]) * u[0] + (p[1] - v[1]) * u[1]).fold(f64::MIN, f64::max)
    };
    let on1 = |ang: f64| {
        let d = ccw_sweep(ang, base1).min(ccw_sweep(base1, ang));
        if d < 1e-6 { Some(reach(ang, l1)) } else { Some(reach(ang, l2)) }
    };
    let ext = [on1(start).filter(|d| *d > 0.0), on1(start + sweep).filter(|d| *d > 0.0)];
    angular_arc(v, r, start, sweep, ext, text_mid, user_text, st)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filled_polys(s: &[Shape]) -> Vec<&Vec<[f64; 2]>> {
        s.iter().filter_map(|x| if let Shape::Poly { pts, filled: true, .. } = x { Some(pts) } else { None }).collect()
    }
    fn texts(s: &[Shape]) -> Vec<(&str, [f64; 2], f64)> {
        s.iter().filter_map(|x| if let Shape::Text { at, text, angle, .. } = x { Some((text.as_str(), *at, *angle)) } else { None }).collect()
    }

    #[test]
    fn pfeilarten_aus_namen() {
        assert_eq!(arrow_kind(""), ArrowKind::ClosedFilled);
        assert_eq!(arrow_kind("_ArchTick"), ArrowKind::Oblique);
        assert_eq!(arrow_kind("DOT"), ArrowKind::Dot);
        assert_eq!(arrow_kind("_OPEN30"), ArrowKind::Open30);
        assert_eq!(arrow_kind("_NONE"), ArrowKind::None);
        assert_eq!(arrow_kind("MeinBlock"), ArrowKind::ClosedFilled);
    }

    #[test]
    fn dreieck_spitze_und_breite() {
        let a = arrow(ArrowKind::ClosedFilled, [1.0, 2.0], [1.0, 0.0], 0.6);
        let f = filled_polys(&a);
        assert_eq!(f.len(), 1);
        let p = f[0];
        assert_eq!(p[0], [1.0, 2.0]);
        assert!((p[1][0] - 1.6).abs() < 1e-12 && (p[1][1] - 2.1).abs() < 1e-12);
        assert!((p[2][1] - 1.9).abs() < 1e-12);
        assert!(arrow(ArrowKind::None, [0.0, 0.0], [1.0, 0.0], 1.0).is_empty());
        assert!(arrow(ArrowKind::ClosedFilled, [0.0, 0.0], [0.0, 0.0], 1.0).is_empty());
        assert!(arrow(ArrowKind::ClosedFilled, [f64::NAN, 0.0], [1.0, 0.0], 1.0).is_empty());
    }

    #[test]
    fn strich_punkt_und_offen() {
        match &arrow(ArrowKind::Oblique, [0.0, 0.0], [1.0, 0.0], 1.0)[0] {
            Shape::Poly { pts, filled: false, closed: false } => {
                // 45°-Strich um die Spitze, Gesamtlänge = Grösse·√2
                assert!((pts[0][0] + 0.5).abs() < 1e-12 && (pts[0][1] + 0.5).abs() < 1e-12);
                assert!((pts[1][0] - 0.5).abs() < 1e-12 && (pts[1][1] - 0.5).abs() < 1e-12);
            }
            s => panic!("{s:?}"),
        }
        assert_eq!(filled_polys(&arrow(ArrowKind::Dot, [0.0, 0.0], [1.0, 0.0], 1.0)).len(), 1);
        match &arrow(ArrowKind::Open90, [0.0, 0.0], [1.0, 0.0], 1.0)[0] {
            Shape::Poly { pts, closed: false, .. } => {
                assert_eq!(pts.len(), 3);
                assert!((pts[0][1] - 1.0).abs() < 1e-9 && (pts[2][1] + 1.0).abs() < 1e-9);
            }
            s => panic!("{s:?}"),
        }
    }

    #[test]
    fn spline_geht_durch_stuetzpunkte() {
        let pts = [[0.0, 0.0], [1.0, 1.0], [2.0, 0.0], [3.0, 1.0]];
        let s = spline_through(&pts);
        assert_eq!(s.len(), 1 + 3 * 8);
        for p in pts {
            assert!(s.iter().any(|q| (q[0] - p[0]).abs() < 1e-12 && (q[1] - p[1]).abs() < 1e-12), "{p:?}");
        }
        assert_eq!(spline_through(&pts[..2]), pts[..2].to_vec());
    }

    #[test]
    fn wert_formatierung() {
        let st = DimStyleVals { dec: 2, ..Default::default() };
        assert_eq!(format_dim_value(5.0, &st), "5.00");
        assert_eq!(format_dim_value(5.0, &DimStyleVals { zin: 8, ..st.clone() }), "5");
        assert_eq!(format_dim_value(0.5, &DimStyleVals { zin: 12, ..st.clone() }), ".5");
        assert_eq!(format_dim_value(1234.5, &DimStyleVals { dsep: 44, ..st.clone() }), "1234,50");
        assert_eq!(format_dim_value(12.0, &DimStyleVals { post: "<>mm".into(), dec: 0, ..st.clone() }), "12mm");
        assert_eq!(format_dim_value(12.0, &DimStyleVals { post: " m".into(), dec: 1, ..st.clone() }), "12.0 m");
        assert_eq!(format_dim_value(1.0, &DimStyleVals { lfac: 1000.0, dec: 0, ..st.clone() }), "1000");
        assert_eq!(format_dim_value(1.234, &DimStyleVals { rnd: 0.05, ..st.clone() }), "1.25");
        assert_eq!(format_dim_value(f64::NAN, &st), "");
        assert_eq!(dim_text(Some("ca. <> m"), "5.00"), "ca. 5.00 m");
        assert_eq!(dim_text(Some(" "), "5.00"), "");
        assert_eq!(dim_text(None, "5.00"), "5.00");
    }

    #[test]
    fn lesbare_winkel() {
        assert!((readable_angle(0.0)).abs() < 1e-12);
        assert!((readable_angle(PI) - 0.0).abs() < 1e-9);
        assert!((readable_angle(PI * 0.75) - (-PI / 4.0)).abs() < 1e-9);
        assert!((readable_angle(-PI * 0.75) - (PI / 4.0)).abs() < 1e-9);
    }

    #[test]
    fn lineare_bemassung_horizontal() {
        let st = DimStyleVals { asz: 0.25, txt: 0.25, tad: 1, exo: 0.0, exe: 0.1, dec: 2, ..Default::default() };
        let d = LinearDim { p1: [0.0, 0.0], p2: [5.0, 0.0], def: [0.0, 3.0], angle: 0.0, text_mid: None, user_text: None, text_rotation: 0.0 };
        let s = linear_dimension(&d, &st);
        // zwei Hilfslinien (x=0 und x=5, y 0 → 3.1), Masslinie y=3, zwei gefüllte Pfeile, Text
        let lines: Vec<_> = s.iter().filter_map(|x| if let Shape::Poly { pts, filled: false, .. } = x { Some(pts.clone()) } else { None }).collect();
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().any(|p| p[0] == [0.0, 0.0] && (p[1][1] - 3.1).abs() < 1e-12));
        assert!(lines.iter().any(|p| p[0] == [0.0, 3.0] && p[1] == [5.0, 3.0]));
        let f = filled_polys(&s);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0][0], [0.0, 3.0]);
        assert!((f[0][1][0] - 0.25).abs() < 1e-12);
        assert_eq!(f[1][0], [5.0, 3.0]);
        assert!((f[1][1][0] - 4.75).abs() < 1e-12);
        let t = texts(&s);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].0, "5.00");
        assert!(t[0].2.abs() < 1e-12);
        // Text über der Linie, zentriert um x = 2.5: Grundlinien-Anfang links davon
        assert!(t[0].1[0] < 2.5 && t[0].1[1] > 3.0);
    }

    #[test]
    fn lineare_bemassung_senkrecht_und_ausgerichtet() {
        let st = DimStyleVals { asz: 0.2, tad: 1, exo: 0.0, exe: 0.0, ..Default::default() };
        // senkrecht: Masslinie bei x = -2, Richtung 90°
        let d = LinearDim { p1: [0.0, 0.0], p2: [0.0, 4.0], def: [-2.0, 0.0], angle: FRAC_PI_2, text_mid: None, user_text: None, text_rotation: 0.0 };
        let s = linear_dimension(&d, &st);
        let t = texts(&s);
        assert_eq!(t[0].0, "4.00");
        assert!((t[0].2 - FRAC_PI_2).abs() < 1e-9, "senkrechte Bemassung: Text von unten nach oben lesbar");
        // ausgerichtet entlang (3,4)
        let a = (4.0f64).atan2(3.0);
        let d = LinearDim { p1: [0.0, 0.0], p2: [3.0, 4.0], def: [-0.8, 0.6], angle: a, text_mid: None, user_text: Some("ca. <>"), text_rotation: 0.0 };
        let s = linear_dimension(&d, &st);
        assert_eq!(texts(&s)[0].0, "ca. 5.00");
        assert!((texts(&s)[0].2 - a).abs() < 1e-9);
    }

    #[test]
    fn kurze_bemassung_pfeile_aussen() {
        let st = DimStyleVals { asz: 0.5, tad: 1, exo: 0.0, exe: 0.0, ..Default::default() };
        let d = LinearDim { p1: [0.0, 0.0], p2: [0.5, 0.0], def: [0.0, 1.0], angle: 0.0, text_mid: None, user_text: None, text_rotation: 0.0 };
        let s = linear_dimension(&d, &st);
        let f = filled_polys(&s);
        // erster Pfeil zeigt nach links (Körper bei x < 0)
        assert!(f[0][1][0] < 0.0);
    }

    #[test]
    fn text_in_der_linie_unterbricht_sie() {
        let st = DimStyleVals { asz: 0.2, tad: 0, exo: 0.0, exe: 0.0, ..Default::default() };
        let d = LinearDim { p1: [0.0, 0.0], p2: [6.0, 0.0], def: [0.0, 1.0], angle: 0.0, text_mid: None, user_text: None, text_rotation: 0.0 };
        let s = linear_dimension(&d, &st);
        let dim_lines: Vec<_> = s
            .iter()
            .filter_map(|x| if let Shape::Poly { pts, filled: false, .. } = x { Some(pts.clone()) } else { None })
            .filter(|p| p[0][1] == 1.0 && p[1][1] == 1.0)
            .collect();
        assert_eq!(dim_lines.len(), 2);
    }

    #[test]
    fn radius_und_durchmesser() {
        let st = DimStyleVals { asz: 0.25, ..Default::default() };
        let s = radial_dimension([20.0, 0.0], [22.0, 0.0], false, None, None, &st);
        assert_eq!(texts(&s)[0].0, "R2.00");
        let f = filled_polys(&s);
        assert_eq!(f[0][0], [22.0, 0.0]);
        assert!(f[0][1][0] < 22.0, "Pfeilkörper zeigt zur Mitte");
        let s = radial_dimension([0.0, 0.0], [3.0, 0.0], true, None, None, &st);
        assert_eq!(texts(&s)[0].0, "Ø6.00");
        assert_eq!(filled_polys(&s).len(), 2);
        assert!(radial_dimension([0.0, 0.0], [0.0, 0.0], true, None, None, &st).is_empty());
    }

    #[test]
    fn winkel_aus_drei_punkten() {
        let st = DimStyleVals { asz: 0.2, adec: 1, ..Default::default() };
        // Scheitel (0,0), Schenkel 0° und 90°, Bogen bei Radius 2 im ersten Quadranten
        let s = angular_3pt([0.0, 0.0], [3.0, 0.0], [0.0, 3.0], [1.4, 1.4], None, None, &st);
        assert_eq!(texts(&s)[0].0, "90.0°");
        // Bogenpunkt im dritten Quadranten: Gegenbogen mit 270°
        let s = angular_3pt([0.0, 0.0], [3.0, 0.0], [0.0, 3.0], [-1.4, -1.4], None, None, &st);
        assert_eq!(texts(&s)[0].0, "270.0°");
    }

    #[test]
    fn winkel_aus_zwei_linien() {
        let st = DimStyleVals { asz: 0.2, adec: 0, ..Default::default() };
        // Linien durch den Ursprung (x- und y-Achse), Bogenpunkt im ersten Quadranten
        let s = angular_2line(([1.0, 0.0], [4.0, 0.0]), ([0.0, 1.0], [0.0, 4.0]), [1.0, 1.0], None, None, &st);
        assert_eq!(texts(&s)[0].0, "90°");
        // Parallele Linien: nichts
        assert!(angular_2line(([0.0, 0.0], [1.0, 0.0]), ([0.0, 1.0], [1.0, 1.0]), [0.5, 0.5], None, None, &st).is_empty());
    }

    #[test]
    fn unsinn_ergibt_nichts() {
        let st = DimStyleVals::default();
        let d = LinearDim { p1: [f64::NAN, 0.0], p2: [1.0, 0.0], def: [0.0, 1.0], angle: 0.0, text_mid: None, user_text: None, text_rotation: 0.0 };
        assert!(linear_dimension(&d, &st).is_empty());
        let d = LinearDim { p1: [0.0, 0.0], p2: [0.0, 0.0], def: [0.0, 0.0], angle: 0.0, text_mid: None, user_text: None, text_rotation: 0.0 };
        let _ = linear_dimension(&d, &st); // Länge 0: kein Panic
    }
}
