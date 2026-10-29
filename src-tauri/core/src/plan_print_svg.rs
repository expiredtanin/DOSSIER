//! Druck-SVG eines Plans für Layout-Viewports und den PDF-Altpfad ([K3d], früher der Primitiv-Teil
//! von `src/export/planToPrintSvg.ts`): liest den zusammengesetzten Plan ([`crate::plan_parts`]) und
//! liefert die SVG-Knoten in Papier-Millimetern als flache Anweisungsliste, die TS 1:1 als DOM-Knoten
//! anlegt (gleiche Elemente, Attribute und Reihenfolge wie die TS-Fassung — die Zahlen formatiert wie
//! `String(Math.round(v * 1000) / 1000)`). Schraffuren als geklippte Vektorlinien, Zickzack/Motiv als
//! Polylinie, Bögen als `<path>`.
//!
//! In TS bleiben: der `<svg>`-Rahmen und das weisse Blatt, die Bild-Schraffur-`<pattern>` (laufende
//! Ids im Dokument) und die Einzeltexte (Text-Layout `wrapDocToLines`). Dafür stehen Anweisungen in
//! der Liste.
//!
//! Format: Datensätze getrennt durch `\x1e`, Felder durch `\x1f`:
//! - `E`, Ebene (0 = ins `<svg>`, 1 = in die offene Gruppe), Tag, dann Name/Wert-Paare;
//! - `G`, Deckkraft (leer = keine) — öffnet eine `<g>`; `g` schliesst sie (hängt sie ans `<svg>`);
//! - `I`, Punkte-Attribut, Bild-JSON — Bild-Schraffur: `<pattern>` anlegen und ein Polygon damit füllen;
//! - `T`, Plan-Index, Deckkraft — Einzeltext an dieser Stelle.

use crate::hatch::{self, Hatch, Motif, Pattern, V2};
use crate::js_fmt::js_number;
use crate::jsnum;
use crate::plan_buf::{whole, Rec, View, F_COLOR, F_DASH_NULL, F_OPACITY, T_ARC, T_CIRCLE, T_DRAWING_ARC, T_DRAWING_TEXT, T_IMAGE, T_LINE, T_POLYGON};
use crate::plan_parts::{greyed_of, Part};
use std::f64::consts::PI;

/// Optionen: Massstab-Nenner, Blatt (mm) und Ausmass des Plans (`Plan.bounds`).
pub struct PrintOptions {
    pub scale_denominator: f64,
    pub page_w: f64,
    pub page_h: f64,
    pub bounds: [f64; 4],
}

/// Standard-Stift-Stufen (mm).
const PEN_STEPS: [f64; 7] = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0];
const MIN_PEN_MM: f64 = 0.13;

/// Mm-Strichstärke auf die nächste Stift-Stufe (`quantizePen`).
fn quantize_pen(mm: f64) -> f64 {
    let w = jsnum::max(MIN_PEN_MM, mm);
    for s in PEN_STEPS {
        if w <= s + 1e-6 {
            return s;
        }
    }
    PEN_STEPS[PEN_STEPS.len() - 1]
}

/// `String(Math.round(v * 1000) / 1000)`.
fn r3(v: f64) -> String {
    js_number(jsnum::round(v * 1000.0) / 1000.0)
}

/// Strichmuster als Attribut (`dash.map(round).join(" ")`).
fn dash_attr(d: &[f64]) -> String {
    d.iter().map(|v| r3(*v)).collect::<Vec<_>>().join(" ")
}

/// Anweisungsliste.
struct Out {
    s: String,
    first: bool,
}

impl Out {
    fn rec(&mut self, fields: &[&str]) {
        if !self.first {
            self.s.push('\u{1e}');
        }
        self.first = false;
        self.s.push_str(&fields.join("\u{1f}"));
    }

    fn el(&mut self, depth: u8, tag: &str, attrs: &[(&str, String)]) {
        let d = depth.to_string();
        let mut f: Vec<&str> = vec!["E", &d, tag];
        for (k, v) in attrs {
            f.push(k);
            f.push(v);
        }
        self.rec(&f);
    }
}

/// Papier-Abbildung (Welt-Meter → mm, Y gespiegelt, zentriert).
#[derive(Clone, Copy)]
struct Map {
    off_x: f64,
    off_y: f64,
    min_x: f64,
    max_y: f64,
    k: f64,
}

impl Map {
    fn at(&self, x: f64, y: f64) -> V2 {
        V2 { x: self.off_x + (x - self.min_x) * self.k, y: self.off_y + (self.max_y - y) * self.k }
    }
}

fn pts_attr(p: &[V2]) -> String {
    p.iter().map(|q| format!("{},{}", r3(q.x), r3(q.y))).collect::<Vec<_>>().join(" ")
}

fn poly_node(pts: &str, fill: &str, stroke: &str, stroke_mm: f64) -> Vec<(&'static str, String)> {
    let mut a = vec![("points", pts.to_string()), ("fill", fill.to_string())];
    if stroke != "none" && stroke_mm > 0.0 {
        a.push(("stroke", stroke.to_string()));
        a.push(("stroke-width", js_number(stroke_mm)));
        a.push(("stroke-linejoin", "round".to_string()));
    } else {
        a.push(("stroke", "none".to_string()));
    }
    a
}

fn line_attrs(a: V2, b: V2, color: &str, stroke_mm: f64, dash: Option<&[f64]>) -> Vec<(&'static str, String)> {
    let mut v = vec![
        ("x1", r3(a.x)),
        ("y1", r3(a.y)),
        ("x2", r3(b.x)),
        ("y2", r3(b.y)),
        ("stroke", color.to_string()),
        ("stroke-width", js_number(stroke_mm)),
        ("stroke-linecap", "round".to_string()),
    ];
    if let Some(d) = dash.filter(|d| !d.is_empty()) {
        v.push(("stroke-dasharray", dash_attr(d)));
    }
    v
}

fn polyline_attrs(pts: &[V2], color: &str, stroke_mm: f64, dash: Option<&[f64]>) -> Vec<(&'static str, String)> {
    let mut v = vec![
        ("points", pts_attr(pts)),
        ("fill", "none".to_string()),
        ("stroke", color.to_string()),
        ("stroke-width", js_number(stroke_mm)),
        ("stroke-linecap", "round".to_string()),
        ("stroke-linejoin", "round".to_string()),
    ];
    if let Some(d) = dash.filter(|d| !d.is_empty()) {
        v.push(("stroke-dasharray", dash_attr(d)));
    }
    v
}

/// Strichmuster + runde Kappe bei Punkten (Bögen, Kreise).
fn push_dash(v: &mut Vec<(&'static str, String)>, dash: Option<&[f64]>) {
    if let Some(d) = dash.filter(|d| !d.is_empty()) {
        v.push(("stroke-dasharray", dash_attr(d)));
        if d.iter().any(|x| *x == 0.0) {
            v.push(("stroke-linecap", "round".to_string()));
        }
    }
}

/// Parallele Linien im Winkel/Abstand, aufs Polygon geklippt (`fillParallel`).
fn fill_parallel(poly: &[V2], angle: f64, spacing: f64, out: &mut Vec<(V2, V2)>) {
    if poly.len() < 3 || spacing <= 0.0 {
        return;
    }
    let dir = V2 { x: jsnum::cos(angle), y: jsnum::sin(angle) };
    let nrm = V2 { x: -dir.y, y: dir.x };
    let mut t_min = f64::INFINITY;
    let mut t_max = f64::NEG_INFINITY;
    for p in poly {
        let t = p.x * nrm.x + p.y * nrm.y;
        if t < t_min {
            t_min = t;
        }
        if t > t_max {
            t_max = t;
        }
    }
    let mut t = (t_min / spacing).ceil() * spacing;
    while t <= t_max {
        let mut xs: Vec<f64> = Vec::new();
        let n = poly.len();
        let mut j = n - 1;
        for i in 0..n {
            let a = poly[j];
            let b = poly[i];
            j = i;
            let ta = a.x * nrm.x + a.y * nrm.y;
            let tb = b.x * nrm.x + b.y * nrm.y;
            if ta == tb {
                continue;
            }
            let f = (t - ta) / (tb - ta);
            if f < 0.0 || f > 1.0 {
                continue;
            }
            let px = a.x + (b.x - a.x) * f;
            let py = a.y + (b.y - a.y) * f;
            xs.push(px * dir.x + py * dir.y);
        }
        if xs.len() >= 2 {
            // `xs.sort((u, v) => u - v)`: stabil; NaN zählt als gleich.
            xs.sort_by(|u, v| (u - v).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut k = 0;
            while k + 1 < xs.len() {
                let (u0, u1) = (xs[k], xs[k + 1]);
                k += 2;
                if u1 - u0 < 1e-6 {
                    continue;
                }
                out.push((V2 { x: nrm.x * t + dir.x * u0, y: nrm.y * t + dir.y * u0 }, V2 { x: nrm.x * t + dir.x * u1, y: nrm.y * t + dir.y * u1 }));
            }
        }
        t += spacing;
    }
}

/// Schraffurlinien in Papier-mm (`hatchLines`).
fn hatch_lines(poly_mm: &[V2], h: &Hatch, mm_per_m: f64) -> Vec<(V2, V2)> {
    let unit_mm = (1.0 / 90.0) * mm_per_m;
    let tile_mm = (if h.pattern == Pattern::Insulation { 10.0 } else { 8.0 }) * h.scale * unit_mm;
    let spacing = jsnum::max(0.5, tile_mm);
    let angle = (h.angle * PI) / 180.0;
    let mut segs = Vec::new();
    fill_parallel(poly_mm, angle, spacing, &mut segs);
    if h.pattern == Pattern::Crosshatch {
        fill_parallel(poly_mm, angle + PI / 2.0, spacing, &mut segs);
    }
    if h.pattern == Pattern::Insulation {
        fill_parallel(poly_mm, angle - PI / 4.0, spacing, &mut segs);
    }
    segs
}

fn num(o: &serde_json::Value, k: &str) -> f64 {
    o.get(k).and_then(|x| x.as_f64()).unwrap_or(f64::NAN)
}

/// Deckkraft-Attribut (`dim · max(0, objOpacity)`, nur unter 1).
fn opacity_of(greyed: bool, obj: f64) -> String {
    let combined = (if greyed { 0.3 } else { 1.0 }) * jsnum::max(0.0, obj);
    if combined < 1.0 {
        js_number(combined)
    } else {
        String::new()
    }
}

/// Ein Eintrag als Knoten.
fn entry(out: &mut Out, view: &View, i: usize, gi: usize, hatches: &[(i32, Hatch, i32)], m: Map) -> Option<()> {
    let rec: Rec = view.rec(i)?;
    let f = &rec.f;
    let k = m.k;
    let s = |idx: f64| -> Option<String> {
        if idx == -1.0 {
            Some("undefined".to_string())
        } else {
            view.string(whole(idx)?)
        }
    };
    let dash = |rec: &Rec| -> Option<Option<Vec<f64>>> {
        if rec.flags & F_DASH_NULL != 0 {
            return Some(None);
        }
        match rec.dash {
            Some((o, n)) => Some(Some(view.pool(o, n)?)),
            None => Some(None),
        }
    };
    let greyed = greyed_of(&rec, false) == Some(true);
    let obj = |at: usize| if rec.flags & F_OPACITY != 0 { f[at] } else { 1.0 };
    match rec.tag {
        T_POLYGON => {
            let pts: Vec<V2> = view.pool(whole(f[5])?, whole(f[6])?.checked_mul(2)?)?.chunks_exact(2).map(|c| V2 { x: c[0], y: c[1] }).collect();
            let opacity = opacity_of(greyed, obj(4));
            let pts_mm: Vec<V2> = pts.iter().map(|p| m.at(p.x, p.y)).collect();
            let attr = pts_attr(&pts_mm);
            let sw = f[2];
            let stroke_mm = if sw > 0.0 { quantize_pen(sw) } else { 0.0 };
            let fill = s(f[0])?;
            let stroke = s(f[1])?;
            out.rec(&["G", &opacity]);
            // Ohne Schraffur-Eintrag wie „none“.
            let (json, h, color) = if f[3] >= 0.0 { hatches.get(whole(f[3])?)?.clone() } else { (-1, empty_hatch(), -1) };
            let image: Option<String> = if h.kind == hatch::HatchKind::Image && json >= 0 {
                let j: serde_json::Value = serde_json::from_str(&view.string(json as usize)?).ok()?;
                j.get("image").filter(|v| v.is_object()).map(|v| v.to_string())
            } else {
                None
            };
            let hatch_color = if color >= 0 { view.string(color as usize)? } else { "undefined".to_string() };
            if let Some(img) = image {
                if fill != "none" {
                    out.el(1, "polygon", &poly_node(&attr, &fill, "none", 0.0));
                }
                out.rec(&["I", &attr, &img]);
                if stroke_mm > 0.0 {
                    out.el(1, "polygon", &poly_node(&attr, "none", &stroke, stroke_mm));
                }
            } else if h.pattern == Pattern::None {
                out.el(1, "polygon", &poly_node(&attr, &fill, &stroke, stroke_mm));
            } else if h.pattern == Pattern::Solid {
                out.el(1, "polygon", &poly_node(&attr, &hatch_color, &stroke, stroke_mm));
            } else {
                if fill != "none" {
                    out.el(1, "polygon", &poly_node(&attr, &fill, "none", 0.0));
                }
                let pen = quantize_pen(h.line_weight);
                if h.random {
                    for run in hatch::build_random_hatch_runs(&pts, &h, None) {
                        if run.len() < 2 {
                            continue;
                        }
                        let (a, b) = (run[0], run[run.len() - 1]);
                        out.el(1, "line", &line_attrs(m.at(a.x, a.y), m.at(b.x, b.y), &hatch_color, pen, None));
                    }
                } else {
                    // Strichmuster der Schraffur (null und [] gleich: keins).
                    for (a, b) in hatch_lines(&pts_mm, &h, k) {
                        out.el(1, "line", &line_attrs(a, b, &hatch_color, pen, Some(&h.dash)));
                    }
                }
                if stroke_mm > 0.0 {
                    out.el(1, "polygon", &poly_node(&attr, "none", &stroke, stroke_mm));
                }
            }
            out.rec(&["g"]);
        }
        T_LINE => {
            let a = m.at(f[4], f[5]);
            let b = m.at(f[6], f[7]);
            let color = if rec.flags & F_COLOR != 0 { s(f[1])? } else { "#111111".to_string() };
            let pen = quantize_pen(f[2]);
            let d = dash(&rec)?;
            let mut attrs = if let Some((amp, wav)) = rec.zigzag {
                let p = hatch::zigzag_points(a, b, amp, wav).unwrap_or_else(|| vec![a, b]);
                polyline_attrs(&p, &color, pen, d.as_deref())
            } else if let Some((length, o, n)) = rec.motif {
                let pts: Vec<V2> = view.pool(o, n.checked_mul(2)?)?.chunks_exact(2).map(|c| V2 { x: c[0], y: c[1] }).collect();
                let p = hatch::motif_points_opt(a, b, &Motif { points: pts, length }, 1.0).unwrap_or_else(|| vec![a, b]);
                polyline_attrs(&p, &color, pen, d.as_deref())
            } else {
                line_attrs(a, b, &color, pen, d.as_deref())
            };
            let tag = if rec.zigzag.is_some() || rec.motif.is_some() { "polyline" } else { "line" };
            let o = opacity_of(greyed, obj(3));
            if !o.is_empty() {
                attrs.push(("opacity", o));
            }
            out.el(0, tag, &attrs);
        }
        T_ARC => {
            let c = m.at(f[4], f[5]);
            let from = m.at(f[6], f[7]);
            let to = m.at(f[8], f[9]);
            let r = f[10] * k;
            let cross = (from.x - c.x) * (to.y - c.y) - (from.y - c.y) * (to.x - c.x);
            let sweep = if cross > 0.0 { 1 } else { 0 };
            let d = format!("M {} {} A {} {} 0 0 {} {} {}", r3(from.x), r3(from.y), r3(r), r3(r), sweep, r3(to.x), r3(to.y));
            let mut attrs = vec![("d", d), ("fill", "none".to_string()), ("stroke", "#111111".to_string()), ("stroke-width", js_number(quantize_pen(f[2])))];
            push_dash(&mut attrs, dash(&rec)?.as_deref());
            let o = opacity_of(greyed, obj(3));
            if !o.is_empty() {
                attrs.push(("opacity", o));
            }
            out.el(0, "path", &attrs);
        }
        T_CIRCLE => {
            let c = m.at(f[4], f[5]);
            let fill = s(f[0])?;
            let mut attrs = vec![
                ("cx", r3(c.x)),
                ("cy", r3(c.y)),
                ("r", r3(f[6] * k)),
                ("fill", if !fill.is_empty() && fill != "none" { fill } else { "none".to_string() }),
                ("stroke", s(f[1])?),
                ("stroke-width", js_number(quantize_pen(f[2]))),
            ];
            push_dash(&mut attrs, dash(&rec)?.as_deref());
            let o = opacity_of(greyed, obj(3));
            if !o.is_empty() {
                attrs.push(("opacity", o));
            }
            out.el(0, "circle", &attrs);
        }
        T_DRAWING_ARC => {
            let tau = PI * 2.0;
            let (cx, cy, r, a0, a1) = (f[3], f[4], f[5], f[6], f[7]);
            let from = m.at(cx + r * jsnum::cos(a0), cy + r * jsnum::sin(a0));
            let to = m.at(cx + r * jsnum::cos(a1), cy + r * jsnum::sin(a1));
            let rr = r * k;
            let sweep = (((a1 - a0) % tau) + tau) % tau;
            let large = if sweep > PI { 1 } else { 0 };
            let d = format!("M {} {} A {} {} 0 {} 1 {} {}", r3(from.x), r3(from.y), r3(rr), r3(rr), large, r3(to.x), r3(to.y));
            let mut attrs = vec![("d", d), ("fill", "none".to_string()), ("stroke", s(f[0])?), ("stroke-width", js_number(quantize_pen(f[1])))];
            push_dash(&mut attrs, dash(&rec)?.as_deref());
            let o = opacity_of(greyed, obj(2));
            if !o.is_empty() {
                attrs.push(("opacity", o));
            }
            out.el(0, "path", &attrs);
        }
        T_DRAWING_TEXT | T_IMAGE => {
            let j: serde_json::Value = serde_json::from_str(&view.string(whole(f[0])?)?).ok()?;
            let jg = j.get("greyed").and_then(|g| g.as_bool()).unwrap_or(false);
            if rec.tag == T_DRAWING_TEXT {
                let obj = j.get("opacity").and_then(|o| o.as_f64()).unwrap_or(1.0);
                out.rec(&["T", &gi.to_string(), &opacity_of(jg, obj)]);
            } else {
                let (min, max) = (j.get("min")?, j.get("max")?);
                let (x0, y0, x1, y1) = (num(min, "x"), num(min, "y"), num(max, "x"), num(max, "y"));
                let w = (x1 - x0) * k;
                let h = (y1 - y0) * k;
                if w <= 0.0 || h <= 0.0 {
                    return Some(());
                }
                let tl = m.at(x0, y1);
                let mut attrs = vec![
                    ("href", j.get("src").and_then(|v| v.as_str()).unwrap_or("undefined").to_string()),
                    ("x", r3(tl.x)),
                    ("y", r3(tl.y)),
                    ("width", r3(w)),
                    ("height", r3(h)),
                    ("preserveAspectRatio", "none".to_string()),
                ];
                // Bilder: eigene Deckkraft getrennt (gedimmt × 0.45), sonst nur das Dimmen.
                let op = num(&j, "opacity");
                if op < 1.0 {
                    attrs.push(("opacity", js_number(op * if jg { 0.45 } else { 1.0 })));
                } else {
                    let o = opacity_of(jg, 1.0);
                    if !o.is_empty() {
                        attrs.push(("opacity", o));
                    }
                }
                out.el(0, "image", &attrs);
            }
        }
        _ => {}
    }
    Some(())
}

fn empty_hatch() -> Hatch {
    Hatch {
        pattern: Pattern::None,
        kind: hatch::HatchKind::Vector,
        random: false,
        scale: 1.0,
        angle: 0.0,
        line_weight: 0.0,
        origin: None,
        seed: None,
        density: None,
        length_min: None,
        length_max: None,
        dash: Vec::new(),
        motif: None,
    }
}

/// Anweisungsliste des Druck-SVG (Format s. Modulkopf); `None` bei kaputtem Puffer.
pub fn print_svg_ops(parts: &mut [Part], o: &PrintOptions) -> Option<String> {
    let k = 1000.0 / o.scale_denominator;
    let [min_x, min_y, max_x, max_y] = o.bounds;
    let content_w = (max_x - min_x) * k;
    let content_h = (max_y - min_y) * k;
    let m = Map { off_x: (o.page_w - content_w) / 2.0, off_y: (o.page_h - content_h) / 2.0, min_x, max_y, k };
    let mut out = Out { s: String::new(), first: true };
    let mut gi = 0usize;
    for part in parts.iter_mut() {
        let hatches = part.view.hatch_table()?;
        for i in part.from..part.to {
            entry(&mut out, &part.view, i, gi, &hatches, m)?;
            gi += 1;
        }
    }
    Some(out.s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stift_stufen_und_runden() {
        assert_eq!(quantize_pen(0.0), 0.13);
        assert_eq!(quantize_pen(0.2), 0.25);
        assert_eq!(quantize_pen(3.0), 1.0);
        assert_eq!(r3(1.23456), "1.235");
        assert_eq!(r3(-0.0001), "0");
        assert_eq!(dash_attr(&[2.0, 0.5]), "2 0.5");
    }

    #[test]
    fn schraffur_parallel_geklippt() {
        let sq = [V2 { x: 0.0, y: 0.0 }, V2 { x: 10.0, y: 0.0 }, V2 { x: 10.0, y: 10.0 }, V2 { x: 0.0, y: 10.0 }];
        let mut segs = Vec::new();
        fill_parallel(&sq, 0.0, 2.0, &mut segs);
        // Waagrechte Linien bei y = 0, 2, …, 10 über die volle Breite.
        assert_eq!(segs.len(), 6);
        assert!(segs.iter().all(|(a, b)| (b.x - a.x - 10.0).abs() < 1e-9 || (a.x - b.x - 10.0).abs() < 1e-9));
    }
}
