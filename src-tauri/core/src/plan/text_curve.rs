//! [207] Text entlang einer Kurve: Strassennamen aus dem Kataster-Import (Einzeltext auf der Klasse „Strasse“ mit Lage und
//! Drehung aus dem DXF) folgen der nächstgelegenen Strassenachse bzw. Strassenrand-Linie. Das Ergebnis sind einzelne Zeichen
//! mit Anker (Grundlinie, links) und Drehung; die Zeichnungs-Ableitung gibt sie als gewöhnliche `drawingText`-Primitive aus,
//! sodass Bildschirm-Szene, SVG, Druck-SVG/PDF und DXF ohne eigenen Pfad dasselbe lesen.
//!
//! Regeln: Das Wort wird mittig auf den nächstgelegenen Abschnitt gesetzt (Buchstabenabstand = Schriftbreite, ohne
//! Kerning wie das Text-Layout), die Grundlinie läuft parallel zur Kurve im Abstand, den die Grundlinie des DXF-Texts
//! dort hatte; die Leserichtung ist nie kopfüber (die Kurve wird bei Bedarf umgedreht). Verläuft die Kurve unter dem Text
//! gerade, oder liegt keine Kurve nahe und etwa parallel zur DXF-Drehung, bleibt es beim geraden Text (`None`).

use crate::model::Vec2;
use crate::text_layout::text_width_em;

/// Ein gesetztes Zeichen: Anker links auf der Grundlinie, Drehung in Radiant.
#[derive(Clone, Debug, PartialEq)]
pub struct CurveChar {
    pub ch: char,
    pub at: Vec2,
    pub angle: f64,
}

/// Höchstabstand der Textmitte von der Kurve, in Schrifthöhen.
const NEAR_HEIGHTS: f64 = 4.0;
/// Höchstabweichung zwischen DXF-Drehung und Kurvenrichtung (mod π).
const MAX_TURN: f64 = 35.0 * std::f64::consts::PI / 180.0;
/// Unter dieser Richtungsstreuung der Zeichen (≈ 1.7°) gilt die Kurve als gerade.
const STRAIGHT_RAD: f64 = 0.03;

fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

struct Curve {
    pts: Vec<Vec2>,
    /// Bogenlänge am Punkt i.
    cum: Vec<f64>,
}

impl Curve {
    fn new(pts: Vec<Vec2>) -> Self {
        let mut cum = Vec::with_capacity(pts.len());
        let mut s = 0.0;
        for (i, p) in pts.iter().enumerate() {
            if i > 0 {
                s += (p.x - pts[i - 1].x).hypot(p.y - pts[i - 1].y);
            }
            cum.push(s);
        }
        Curve { pts, cum }
    }

    fn len(&self) -> f64 {
        self.cum.last().copied().unwrap_or(0.0)
    }

    fn reversed(&self) -> Curve {
        Curve::new(self.pts.iter().rev().copied().collect())
    }

    /// Punkt bei Bogenlänge `s` (geklemmt).
    fn at(&self, s: f64) -> Vec2 {
        let s = s.clamp(0.0, self.len());
        let i = self.cum.partition_point(|c| *c < s).clamp(1, self.pts.len() - 1);
        let (a, b) = (self.pts[i - 1], self.pts[i]);
        let seg = self.cum[i] - self.cum[i - 1];
        let t = if seg > 0.0 { (s - self.cum[i - 1]) / seg } else { 0.0 };
        v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    }

    /// Nächster Punkt zu `p`: (Abstand, Bogenlänge).
    fn nearest(&self, p: Vec2) -> (f64, f64) {
        let mut best = (f64::INFINITY, 0.0);
        for i in 1..self.pts.len() {
            let (a, b) = (self.pts[i - 1], self.pts[i]);
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 { (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            let d = (p.x - (a.x + dx * t)).hypot(p.y - (a.y + dy * t));
            if d < best.0 {
                best = (d, self.cum[i - 1] + t * l2.sqrt());
            }
        }
        best
    }
}

/// Richtung (Radiant) der Sehne von `a` nach `b`.
fn heading(a: Vec2, b: Vec2) -> f64 {
    (b.y - a.y).atan2(b.x - a.x)
}

/// Winkelunterschied modulo π, in [0, π/2].
fn turn_mod_pi(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(std::f64::consts::PI);
    d.min(std::f64::consts::PI - d)
}

/// Lesbar (nicht kopfüber): Richtung im Bereich (−90°, 90°].
fn readable(a: f64) -> bool {
    let (c, s) = (a.cos(), a.sin());
    c > 1e-9 || (c.abs() <= 1e-9 && s > 0.0)
}

/// Setzt `text` (Schrifthöhe `height`, Anker `at` links auf der Grundlinie, Drehung `angle`) entlang der nächstgelegenen der
/// `axes`. `None`: kein Einzeiler, keine passende Kurve oder die Kurve ist unter dem Text gerade (dann bleibt der Text wie er ist).
pub fn text_on_curve(axes: &[&[Vec2]], text: &str, height: f64, at: Vec2, angle: f64) -> Option<Vec<CurveChar>> {
    if !(height.is_finite() && height > 0.0 && at.x.is_finite() && at.y.is_finite() && angle.is_finite()) || text.chars().count() < 2 || text.contains(['\n', '\r']) {
        return None;
    }
    let widths: Vec<f64> = text.chars().map(|c| text_width_em(c.encode_utf8(&mut [0; 4]), false) * height).collect();
    let total: f64 = widths.iter().sum();
    if !(total > 0.0) {
        return None;
    }
    let (dir, nor) = (v(angle.cos(), angle.sin()), v(-angle.sin(), angle.cos()));
    // Grundlinienmitte und sichtbare Mitte (halbe Höhe darüber) des Texts.
    let mid = v(at.x + dir.x * total / 2.0, at.y + dir.y * total / 2.0);
    let probe = v(mid.x + nor.x * height / 2.0, mid.y + nor.y * height / 2.0);
    let mut best: Option<(f64, &[Vec2])> = None;
    for pts in axes.iter().copied().filter(|a| a.len() >= 2) {
        let c = Curve::new(pts.to_vec());
        if !(c.len() >= total) {
            continue;
        }
        let d = c.nearest(probe).0;
        if d <= NEAR_HEIGHTS * height && best.as_ref().is_none_or(|b| d < b.0) {
            best = Some((d, pts));
        }
    }
    let mut curve = Curve::new(best?.1.to_vec());
    // Mitte des Texts auf der Kurve; Abschnitt so legen, dass er ganz auf ihr liegt.
    let place = |c: &Curve| {
        let s_mid = c.nearest(probe).1;
        let s0 = (s_mid - total / 2.0).clamp(0.0, c.len() - total);
        (s0, heading(c.at(s0), c.at(s0 + total)))
    };
    let (mut s0, mut head) = place(&curve);
    if turn_mod_pi(head, angle) > MAX_TURN {
        return None;
    }
    // Richtung der Kurve: wie die DXF-Drehung, dann nie kopfüber.
    let mut flip = (head.cos() * dir.x + head.sin() * dir.y) < 0.0;
    if flip {
        head += std::f64::consts::PI;
    }
    if !readable(head) {
        flip = !flip;
    }
    if flip {
        curve = curve.reversed();
        (s0, head) = place(&curve);
    }
    // Querversatz der Grundlinie zur Kurve, wie im DXF (links der Kurve positiv).
    let pm = curve.at(s0 + total / 2.0);
    let tm = heading(curve.at(s0), curve.at(s0 + total));
    let off = ((mid.x - pm.x) * -tm.sin() + (mid.y - pm.y) * tm.cos()).clamp(-NEAR_HEIGHTS * height, NEAR_HEIGHTS * height);
    let mut out = Vec::new();
    let mut s = s0;
    for (ch, w) in text.chars().zip(&widths) {
        let (pa, pb) = (curve.at(s), curve.at(s + w));
        let th = heading(pa, pb);
        let (cx, cy) = ((pa.x + pb.x) / 2.0 - th.sin() * off, (pa.y + pb.y) / 2.0 + th.cos() * off);
        if !ch.is_whitespace() {
            out.push(CurveChar { ch, at: v(cx - th.cos() * w / 2.0, cy - th.sin() * w / 2.0), angle: th });
        }
        s += w;
    }
    // Gerade unter dem Text: bleibt der Text, wie er ist.
    let head = heading(curve.at(s0), curve.at(s0 + total));
    let spread = out.iter().map(|c| turn_mod_pi(c.angle, head)).fold(0.0, f64::max);
    if spread < STRAIGHT_RAD {
        return None;
    }
    Some(out)
}

/// Linienzug eines Bogens (Mittelpunkt, Radius, Start-/Endwinkel, gegen den Uhrzeigersinn) mit höchstens ≈ 3° je Segment.
pub fn arc_points(c: Vec2, r: f64, a0: f64, a1: f64) -> Vec<Vec2> {
    if !(r.is_finite() && r > 0.0 && a0.is_finite() && a1.is_finite()) {
        return Vec::new();
    }
    let mut sweep = (a1 - a0).rem_euclid(std::f64::consts::TAU);
    if sweep == 0.0 {
        sweep = std::f64::consts::TAU;
    }
    let n = ((sweep / 0.05).ceil() as usize).clamp(1, 720);
    (0..=n).map(|i| a0 + sweep * i as f64 / n as f64).map(|a| v(c.x + r * a.cos(), c.y + r * a.sin())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dist_to_curve(pts: &[Vec2], p: Vec2) -> f64 {
        Curve::new(pts.to_vec()).nearest(p).0
    }

    fn width_of(name: &str, h: f64) -> f64 {
        name.chars().map(|c| text_width_em(&c.to_string(), false) * h).sum()
    }

    /// Kreisbogen R = 40 m um den Ursprung, von 20° bis 80°, fein tesselliert.
    fn bogen() -> Vec<Vec2> {
        arc_points(v(0.0, 0.0), 40.0, 20f64.to_radians(), 80f64.to_radians())
    }

    /// DXF-Text am Scheitel (50°), tangential gedreht, Grundlinie 0.5 h neben der Kurve (Text auf der Achse zentriert).
    fn dxf_text(name: &str, h: f64) -> (Vec2, f64) {
        let a = 50f64.to_radians();
        let tang = a + std::f64::consts::FRAC_PI_2;
        let w = width_of(name, h);
        let centre = v(40.0 * a.cos(), 40.0 * a.sin());
        let (dir, nor) = (v(tang.cos(), tang.sin()), v(-tang.sin(), tang.cos()));
        (v(centre.x - dir.x * w / 2.0 - nor.x * h / 2.0, centre.y - dir.y * w / 2.0 - nor.y * h / 2.0), tang)
    }

    #[test]
    fn buchstaben_liegen_auf_der_kurve_nicht_kopfueber_gleichmaessig() {
        let h = 1.0;
        let name = "Bahnhofstrasse";
        let (at, ang) = dxf_text(name, h);
        let chars = text_on_curve(&[&bogen()], name, h, at, ang).expect("gesetzt");
        assert_eq!(chars.len(), name.chars().count());
        let axis = bogen();
        let mut prev: Option<(Vec2, f64)> = None;
        for (c, w) in chars.iter().zip(name.chars().map(|c| text_width_em(&c.to_string(), false) * h)) {
            let mid = v(c.at.x + c.angle.cos() * w / 2.0, c.at.y + c.angle.sin() * w / 2.0);
            let d = dist_to_curve(&axis, mid);
            assert!((d - 0.5 * h).abs() < 0.06 * h, "Abstand {d} bei {}", c.ch);
            assert!(readable(c.angle), "kopfüber bei {} ({})", c.ch, c.angle);
            if let Some((p, pw)) = prev {
                let gap = (mid.x - p.x).hypot(mid.y - p.y);
                assert!((gap - (pw + w) / 2.0).abs() < 0.03 * h, "Vorschub {gap} bei {}", c.ch);
            }
            prev = Some((mid, w));
        }
        let (first, last) = (chars.first().unwrap().angle, chars.last().unwrap().angle);
        assert!((first - last).abs() > 0.1, "Zeichen drehen mit der Kurve");
    }

    #[test]
    fn mittig_auf_dem_naechsten_abschnitt() {
        let h = 1.0;
        let (at, ang) = dxf_text("Hauptstrasse", h);
        let chars = text_on_curve(&[&bogen()], "Hauptstrasse", h, at, ang).unwrap();
        let polar = |c: &CurveChar| c.at.y.atan2(c.at.x);
        let (a, b) = (polar(&chars[0]), polar(chars.last().unwrap()));
        assert!(((a + b) / 2.0 - 50f64.to_radians()).abs() < 0.03, "Mitte {}", (a + b) / 2.0);
    }

    #[test]
    fn umgekehrte_kurve_liest_trotzdem_richtig() {
        let h = 1.0;
        let (at, ang) = dxf_text("Seeweg", h);
        let mut rev = bogen();
        rev.reverse();
        let chars = text_on_curve(&[&rev], "Seeweg", h, at, ang).unwrap();
        let fwd = text_on_curve(&[&bogen()], "Seeweg", h, at, ang).unwrap();
        assert_eq!(chars.len(), fwd.len());
        for (a, b) in chars.iter().zip(&fwd) {
            assert_eq!(a.ch, b.ch);
            assert!((a.at.x - b.at.x).abs() < 1e-6 && (a.at.y - b.at.y).abs() < 1e-6);
        }
    }

    #[test]
    fn kopfueber_gedrehter_dxf_text_wird_lesbar() {
        let h = 1.0;
        let (at, ang) = dxf_text("Seeweg", h);
        let chars = text_on_curve(&[&bogen()], "Seeweg", h, at, ang + std::f64::consts::PI).unwrap();
        assert!(chars.iter().all(|c| readable(c.angle)));
    }

    #[test]
    fn gegenprobe_ohne_achse_oder_ferne_oder_quer_oder_gerade() {
        let h = 1.0;
        let (at, ang) = dxf_text("Bahnhofstrasse", h);
        assert!(text_on_curve(&[], "Bahnhofstrasse", h, at, ang).is_none(), "keine Achse");
        let fern = arc_points(v(0.0, 0.0), 60.0, 20f64.to_radians(), 80f64.to_radians());
        assert!(text_on_curve(&[&fern], "Bahnhofstrasse", h, at, ang).is_none(), "zu weit");
        assert!(text_on_curve(&[&bogen()], "Bahnhofstrasse", h, at, ang + 1.2).is_none(), "quer zur Achse");
        let gerade = vec![v(-50.0, 40.0), v(50.0, 40.0)];
        assert!(text_on_curve(&[&gerade], "Bahnhofstrasse", h, v(-3.0, 39.5), 0.0).is_none(), "gerade Achse bleibt gerader Text");
        assert!(text_on_curve(&[&bogen()], "X", h, at, ang).is_none(), "Einzelzeichen");
        assert!(text_on_curve(&[&bogen()], "A\nB", h, at, ang).is_none(), "mehrzeilig");
    }

    #[test]
    fn zu_kurze_kurve_und_unsinn() {
        let kurz = arc_points(v(0.0, 0.0), 40.0, 49f64.to_radians(), 51f64.to_radians());
        let (at, ang) = dxf_text("Bahnhofstrasse", 1.0);
        assert!(text_on_curve(&[&kurz], "Bahnhofstrasse", 1.0, at, ang).is_none());
        assert!(text_on_curve(&[&bogen()], "Seeweg", f64::NAN, at, ang).is_none());
        assert!(text_on_curve(&[&bogen()], "Seeweg", 1.0, v(f64::NAN, 0.0), ang).is_none());
        assert!(text_on_curve(&[&[v(1.0, 1.0), v(1.0, 1.0)]], "Seeweg", 1.0, at, ang).is_none());
    }
}
