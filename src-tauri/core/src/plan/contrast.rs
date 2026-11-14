//! [256] Kontrast auf dunkler Füllung: Linien, die auf einer schwarzen Schnittfläche liegen (ab 1:100 die
//! Sammelfläche der Wände, `style::solid_cut`), verschwinden in ihr. Die Plan-Erzeugung zeichnet den Teil
//! einer solchen Linie, der IN der dunklen Fläche liegt, in der Kontrastfarbe (weiss); ausserhalb bleibt
//! sie unverändert. Genutzt für Öffnungs-Symbole über/unter der Schnittebene in einer geschlossenen Wand
//! (Rundfenster, hohes Bad-Fenster: SIA-Praxis, die Öffnung über Schnitt bleibt lesbar). Wirkt auf die
//! Plan-Primitive selbst — Bildschirm, Plan-SVG, Druck-SVG/PDF und DXF bekommen dieselben Stücke.

use super::prim::Primitive;
use crate::model::Vec2;

/// Kontrastfarbe auf dunkler Füllung.
pub const CONTRAST_INK: &str = "#ffffff";

/// Linien auf dem Rand der Fläche (Wandflucht) bleiben dunkel: Abstand zum Rand mindestens so viel (m).
const EDGE_EPS: f64 = 2e-4;

/// Relative Helligkeit (0 schwarz … 1 weiss), unter der eine Füllung als dunkel gilt.
const DARK_LUMA: f64 = 0.3;

/// Dunkle, deckende Füllung (z. B. `HATCH_INK`)? Transparente oder halbtransparente Füllungen nicht.
pub fn is_dark_fill(fill: &str, opacity: Option<f64>) -> bool {
    if opacity.is_some_and(|o| !(o >= 0.5)) {
        return false;
    }
    let Some([r, g, b, a]) = super::buf::parse_color(fill) else { return false };
    a >= 0.5 && 0.2126 * r + 0.7152 * g + 0.0722 * b < DARK_LUMA
}

/// Dunkle Flächen mit Hüllrechteck.
pub struct DarkRings {
    rings: Vec<(Vec<Vec2>, [f64; 4])>,
}

impl DarkRings {
    /// Flächen aus `prims`, deren Füllung dunkel ist und die `pick` annimmt.
    pub fn collect(prims: &[Primitive], pick: impl Fn(&Primitive) -> bool) -> Self {
        let mut rings = Vec::new();
        for q in prims {
            if let Primitive::Polygon { pts, fill, opacity, .. } = q {
                if pts.len() >= 3 && is_dark_fill(fill, *opacity) && pick(q) && pts.iter().all(|p| p.x.is_finite() && p.y.is_finite()) {
                    let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
                    for p in pts {
                        bb = [bb[0].min(p.x), bb[1].min(p.y), bb[2].max(p.x), bb[3].max(p.y)];
                    }
                    rings.push((pts.clone(), bb));
                }
            }
        }
        Self { rings }
    }

    pub fn is_empty(&self) -> bool {
        self.rings.is_empty()
    }

    /// Punkt echt in einer dunklen Fläche (nicht auf ihrem Rand).
    fn inside(&self, p: Vec2) -> bool {
        self.rings.iter().any(|(r, bb)| {
            p.x > bb[0] - EDGE_EPS && p.x < bb[2] + EDGE_EPS && p.y > bb[1] - EDGE_EPS && p.y < bb[3] + EDGE_EPS && in_ring(r, p) && edge_dist(r, p) > EDGE_EPS
        })
    }

    /// Parameter (0..1), an denen die Strecke a→b einen Flächenrand kreuzt.
    fn crossings(&self, a: Vec2, b: Vec2, ts: &mut Vec<f64>) {
        let (lo_x, hi_x, lo_y, hi_y) = (a.x.min(b.x), a.x.max(b.x), a.y.min(b.y), a.y.max(b.y));
        for (r, bb) in &self.rings {
            if hi_x < bb[0] - EDGE_EPS || lo_x > bb[2] + EDGE_EPS || hi_y < bb[1] - EDGE_EPS || lo_y > bb[3] + EDGE_EPS {
                continue;
            }
            let n = r.len();
            for i in 0..n {
                let (c, d) = (r[i], r[(i + 1) % n]);
                let (dx, dy, ex, ey) = (b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y);
                let den = dx * ey - dy * ex;
                if den.abs() < 1e-15 {
                    continue;
                }
                let t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
                let u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
                if t > 0.0 && t < 1.0 && (-1e-9..=1.0 + 1e-9).contains(&u) {
                    ts.push(t);
                }
            }
        }
    }
}

fn in_ring(r: &[Vec2], p: Vec2) -> bool {
    let mut inside = false;
    let mut j = r.len() - 1;
    for i in 0..r.len() {
        let (a, b) = (r[i], r[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn edge_dist(r: &[Vec2], p: Vec2) -> f64 {
    let n = r.len();
    let mut best = f64::INFINITY;
    for i in 0..n {
        let (a, b) = (r[i], r[(i + 1) % n]);
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (qx, qy) = (a.x + dx * t - p.x, a.y + dy * t - p.y);
        best = best.min((qx * qx + qy * qy).sqrt());
    }
    best
}

/// Abschnitte `(t0, t1, drinnen)` einer Strecke, benachbarte gleiche zusammengefasst.
fn split_runs(ts: &mut Vec<f64>, at: impl Fn(f64) -> bool) -> Vec<(f64, f64, bool)> {
    ts.push(0.0);
    ts.push(1.0);
    ts.sort_by(|a, b| a.total_cmp(b));
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let mut runs: Vec<(f64, f64, bool)> = Vec::new();
    for w in ts.windows(2) {
        let inside = at((w[0] + w[1]) / 2.0);
        match runs.last_mut() {
            Some(l) if l.2 == inside => l.1 = w[1],
            _ => runs.push((w[0], w[1], inside)),
        }
    }
    runs
}

fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    Vec2 { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/// Linien und Bögen in `prims[from..to]`: der Teil in einer dunklen Fläche wird als eigenes Stück in
/// [`CONTRAST_INK`] ans ENDE von `prims` gehängt (über allen Füllungen), der Rest bleibt an seinem Platz.
/// Flächen und andere Primitive bleiben unverändert. Rückgabe: Zahl der hellen Stücke.
pub fn light_on_dark(prims: &mut Vec<Primitive>, from: usize, to: usize, dark: &DarkRings) -> usize {
    if dark.is_empty() || from >= to || to > prims.len() {
        return 0;
    }
    let mut keep: Vec<Primitive> = Vec::with_capacity(to - from);
    let mut light: Vec<Primitive> = Vec::new();
    for q in prims.drain(from..to) {
        match &q {
            Primitive::Line { a, b, .. } if a.x.is_finite() && a.y.is_finite() && b.x.is_finite() && b.y.is_finite() => {
                let (a, b) = (*a, *b);
                let mut ts = Vec::new();
                dark.crossings(a, b, &mut ts);
                let runs = split_runs(&mut ts, |t| dark.inside(lerp(a, b, t)));
                if runs.len() == 1 && !runs[0].2 {
                    keep.push(q);
                    continue;
                }
                for (t0, t1, inside) in runs {
                    let mut s = q.clone();
                    if let Primitive::Line { a: sa, b: sb, color, .. } = &mut s {
                        *sa = lerp(a, b, t0);
                        *sb = lerp(a, b, t1);
                        if inside {
                            *color = Some(CONTRAST_INK.into());
                        }
                    }
                    if inside { light.push(s) } else { keep.push(s) }
                }
            }
            Primitive::Arc { center, from: af, to: at, r, .. } if r.is_finite() && *r > 0.0 => {
                // Bogen gegen den Uhrzeigersinn von `from` nach `to` (wie die SVG-Ausgabe), in Stücken abgetastet.
                let (c, r) = (*center, *r);
                let a0 = crate::jsnum::atan2(af.y - c.y, af.x - c.x);
                let mut sweep = crate::jsnum::atan2(at.y - c.y, at.x - c.x) - a0;
                while sweep < 0.0 && sweep.is_finite() {
                    sweep += std::f64::consts::PI * 2.0;
                }
                if !sweep.is_finite() || sweep <= 0.0 {
                    keep.push(q);
                    continue;
                }
                let pt = |t: f64| {
                    let a = a0 + sweep * t;
                    Vec2 { x: c.x + r * crate::jsnum::cos(a), y: c.y + r * crate::jsnum::sin(a) }
                };
                const N: usize = 32;
                let mut ts: Vec<f64> = (1..N).map(|k| k as f64 / N as f64).collect();
                let runs = split_runs(&mut ts, |t| dark.inside(pt(t)));
                if runs.len() == 1 && !runs[0].2 {
                    keep.push(q);
                    continue;
                }
                for (t0, t1, inside) in runs {
                    let mut s = q.clone();
                    if let Primitive::Arc { from: sf, to: st, color, .. } = &mut s {
                        *sf = if t0 <= 0.0 { *af } else { pt(t0) };
                        *st = if t1 >= 1.0 { *at } else { pt(t1) };
                        if inside {
                            *color = Some(CONTRAST_INK.into());
                        }
                    }
                    if inside { light.push(s) } else { keep.push(s) }
                }
            }
            _ => keep.push(q),
        }
    }
    let n = light.len();
    prims.splice(from..from, keep);
    prims.extend(light);
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }
    fn poly(pts: Vec<Vec2>, fill: &str) -> Primitive {
        Primitive::Polygon { pts, fill: fill.into(), stroke: "none".into(), stroke_width_mm: 0.0, hatch: Box::new(super::super::style::no_hatch()), greyed: None, opacity: None, no_stroke_edges: None, wall_id: Some("w".into()), drawing_id: None, ceiling_id: None, opening_id: None, stair_id: None, room_id: None, extruded_solid_id: None, context_object_id: None, column_id: None, roof_id: None, section_line_id: None }
    }
    fn line(a: Vec2, b: Vec2) -> Primitive {
        Primitive::Line { a, b, cls: "view-range".into(), weight_mm: 0.18, dash: Some(Some(vec![1.2, 0.25, 0.15, 0.25])), zigzag: None, motif: None, color: Some("#1a1a1a".into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None }
    }

    #[test]
    fn dunkle_fuellung() {
        assert!(is_dark_fill("#0f0f0f", None));
        assert!(!is_dark_fill("#d9d9d9", None));
        assert!(!is_dark_fill("#0f0f0f", Some(0.2)));
        assert!(!is_dark_fill("#4a4a4a00", None));
        assert!(!is_dark_fill("none", None));
    }

    #[test]
    fn nur_der_teil_in_der_schwarzen_flaeche_wird_hell() {
        let wall = poly(vec![v(0.0, 0.0), v(4.0, 0.0), v(4.0, 0.3), v(0.0, 0.3)], "#0f0f0f");
        // Quer durch die Wand und darüber hinaus; dazu eine Linie auf der Wandflucht und eine ausserhalb.
        let mut prims = vec![wall, line(v(1.0, -0.5), v(1.0, 0.8)), line(v(0.5, 0.0), v(3.5, 0.0)), line(v(0.0, 2.0), v(4.0, 2.0))];
        let dark = DarkRings::collect(&prims, |_| true);
        let n = light_on_dark(&mut prims, 1, 4, &dark);
        assert_eq!(n, 1);
        let col = |q: &Primitive| match q {
            Primitive::Line { color, .. } => color.as_deref().map(str::to_string),
            _ => None,
        };
        // Das helle Stück liegt zuletzt (über allen Füllungen) und genau in der Wand.
        let Primitive::Line { a, b, .. } = prims.last().unwrap() else { panic!() };
        assert_eq!(col(prims.last().unwrap()).as_deref(), Some(CONTRAST_INK));
        assert!((a.y - 0.0).abs() < 1e-9 && (b.y - 0.3).abs() < 1e-9, "{a:?} {b:?}");
        // Aussen bleibt dunkel: zwei Reststücke der Querlinie, Flucht- und Aussenlinie unverändert.
        let dark_lines = prims.iter().filter(|q| col(q).as_deref() == Some("#1a1a1a")).count();
        assert_eq!(dark_lines, 4);
        assert!(matches!(&prims[0], Primitive::Polygon { .. }));
    }

    #[test]
    fn helle_flaeche_aendert_nichts() {
        let wall = poly(vec![v(0.0, 0.0), v(4.0, 0.0), v(4.0, 0.3), v(0.0, 0.3)], "#ffffff");
        let mut prims = vec![wall, line(v(1.0, -0.5), v(1.0, 0.8))];
        let before = prims.clone();
        let dark = DarkRings::collect(&prims, |_| true);
        assert_eq!(light_on_dark(&mut prims, 1, 2, &dark), 0);
        assert_eq!(prims, before);
    }

    #[test]
    fn bogen_in_der_wand_wird_hell() {
        let wall = poly(vec![v(-1.0, -0.15), v(1.0, -0.15), v(1.0, 0.15), v(-1.0, 0.15)], "#0f0f0f");
        let arc = Primitive::Arc { center: v(0.0, 0.0), from: v(0.1, 0.0), to: v(-0.1, 0.0), r: 0.1, cls: "view-range".into(), weight_mm: 0.18, dash: None, color: None, opening_id: None, stair_id: None, greyed: None, opacity: None };
        let mut prims = vec![wall, arc];
        let dark = DarkRings::collect(&prims, |_| true);
        assert_eq!(light_on_dark(&mut prims, 1, 2, &dark), 1);
        assert_eq!(prims.len(), 2);
        assert!(matches!(&prims[1], Primitive::Arc { color: Some(c), .. } if c == CONTRAST_INK));
    }
}
