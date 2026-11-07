//! Plan → SVG-Text ohne DOM ([K3d], früher `src/export/planToSvgString.ts`): für `dossier-cli plan`,
//! MCP und Referenzbild-Tests, direkt aus den Abschnitten eines zusammengesetzten Plans
//! ([`crate::plan::parts`]). Koordinaten in Metern (Y nach oben → SVG gespiegelt), Strichstärken
//! aus Papier-mm über den Massstab; Schraffur-Muster werden nur mit `hatch` ausgebreitet (sonst nur Grundfüllung),
//! Bilder und Textpfade fehlen — gedacht für Kontrolle und Diffs, nicht für Druck. Byte-gleich zur
//! TS-Fassung (Zahlen wie `String(Math.round(v·1e5)/1e5)`, Texte aus dem Text-JSON des Puffers).

use crate::js_fmt::js_number;
use crate::hatch::{self, Pattern, V2};
use crate::jsnum;
use crate::plan::print_svg::{hatch_dash_paper, hatch_lines, is_generated, quantize_pen};
use crate::plan::buf::{whole, F_COLOR, F_DASH_LIST, F_GREYED, F_OPACITY, T_ARC, T_CIRCLE, T_DRAWING_ARC, T_DRAWING_TEXT, T_LINE, T_POLYGON, T_TEXT};
use crate::plan::line_ends::LineEnds;
use crate::plan::parts::Part;
use crate::plan::scene::stitch_runs_members;
use std::collections::HashMap;
use serde_json::Value;
use std::f64::consts::PI;

/// [140] Raumstempel (Text-JSON eines `text`-Primitivs) als `<text>`-Block wie gemessen und wie die Plan-Ansicht
/// ([`crate::text_layout::stamp_block`]): Name mit seinen Auszeichnungen (Stempel: 12 pt fett), Zusatzzeilen
/// 0.8 × Grundgrösse, Zeilenvorschub 1.3, Block um den Anker zentriert; Schrift Inter (Rückfall sans-serif).
/// `x`/`y0` = Anker in SVG-Koordinaten, `mm_to_m` = Modell-Meter je Papier-mm.
fn stamp_svg(v: &Value, x: f64, y0: f64, mm_to_m: f64) -> String {
    use crate::model::RichTextDoc;
    use crate::text_layout::{stamp_block, stamp_line_offsets, LineAlign, PT_TO_MM};
    let doc: RichTextDoc = v.get("doc").and_then(|d| serde_json::from_value(d.clone()).ok()).unwrap_or_default();
    let extra: Vec<crate::plan::prim::StampLine> = v.get("extraLines").and_then(|d| serde_json::from_value(d.clone()).ok()).unwrap_or_default();
    let rows: Vec<(&str, LineAlign)> = extra.iter().map(|l| (l.text.as_str(), LineAlign::of(Some(l.align)))).collect();
    let color = jstr(v, "color").unwrap_or("");
    let o = op_json(v);
    // In Papier-mm setzen (Schriftgrössen auf 1/1000 gerundet), dann in Modell-Meter umrechnen.
    let placed = stamp_block(&doc, &rows, jnum(v, "basePt"), PT_TO_MM, color, 0.0);
    let dx = stamp_line_offsets(&placed);
    placed
        .iter()
        .zip(dx)
        .filter(|(p, _)| p.line.tspans.iter().any(|t| !t.text.is_empty()))
        .map(|(p, dx)| {
            let spans: String = p
                .line
                .tspans
                .iter()
                .map(|t| {
                    let mut a = format!(" font-size=\"{}\" fill=\"{}\"", num(t.font_size * mm_to_m), esc(&t.fill));
                    if let Some(w) = t.font_weight() {
                        a.push_str(&format!(" font-weight=\"{w}\""));
                    }
                    if let Some(st) = t.font_style() {
                        a.push_str(&format!(" font-style=\"{st}\""));
                    }
                    if let Some(f) = &t.font_family {
                        a.push_str(&format!(" font-family=\"{}\"", esc(f)));
                    }
                    format!("<tspan{a}>{}</tspan>", esc(&t.text))
                })
                .collect();
            format!("<text x=\"{}\" y=\"{}\" font-family=\"Inter, sans-serif\" text-anchor=\"{}\"{o}>{spans}</text>", num(x + dx * mm_to_m), num(y0 + p.y * mm_to_m), p.line.align.anchor())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `num()`: gerundet auf 1e-5, nicht endlich → "0".
fn num(v: f64) -> String {
    if v.is_finite() {
        js_number(jsnum::round(v * 1e5) / 1e5)
    } else {
        "0".into()
    }
}

/// `esc()` für Attribut- und Textinhalt.
fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            _ => o.push(c),
        }
    }
    o
}

/// Optionen und Ausmass (wie `SvgStringOptions` + `plan.bounds`).
pub struct SvgOptions {
    pub scale_denominator: f64,
    pub margin_m: f64,
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    /// Schraffurlinien ausbreiten (wie der Druckpfad, an der Fläche beschnitten); Standard aus.
    pub hatch: bool,
    /// Linienenden und -ecken ([146]) als Attribute eines umschliessenden `<g>`.
    pub line_ends: LineEnds,
}

/// Volle, offene Striche gleicher Farbe/Breite/Deckkraft, am Ende zusammengenäht ([146]): Wand-Umrisse
/// zweier Wände treffen sich an der Ecke als EIN Zug mit Ecke (Gehrung) statt mit zwei flachen Enden.
/// Jeder Zug steht an der Stelle seines spätesten Laufs (Zeichen-Reihenfolge wie bisher).
#[derive(Default)]
struct Stitcher {
    groups: Vec<(String, Vec<Vec<V2>>, Vec<usize>)>,
    of: HashMap<String, usize>,
}

impl Stitcher {
    /// `attrs` = ` stroke=… stroke-width=…{op}`; `slot` = Platzhalter in `out`.
    fn add(&mut self, attrs: String, run: Vec<V2>, slot: usize) {
        let gi = *self.of.entry(attrs.clone()).or_insert_with(|| {
            self.groups.push((attrs, Vec::new(), Vec::new()));
            self.groups.len() - 1
        });
        self.groups[gi].1.push(run);
        self.groups[gi].2.push(slot);
    }

    fn finish(self, out: &mut [String], xs: &dyn Fn(f64) -> String, ys: &dyn Fn(f64) -> String) {
        for (attrs, runs, slots) in self.groups {
            for (pts, closed, members) in stitch_runs_members(&runs) {
                if pts.len() < 2 {
                    continue;
                }
                let slot = members.iter().map(|&m| slots[m]).max().unwrap_or(0);
                let el = if !closed && pts.len() == 2 {
                    format!("<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"{attrs}/>", xs(pts[0].x), ys(pts[0].y), xs(pts[1].x), ys(pts[1].y))
                } else {
                    let pl = pts.iter().map(|q| format!("{},{}", xs(q.x), ys(q.y))).collect::<Vec<_>>().join(" ");
                    let tag = if closed { "polygon" } else { "polyline" };
                    format!("<{tag} points=\"{pl}\" fill=\"none\"{attrs}/>")
                };
                if out[slot].is_empty() {
                    out[slot] = el;
                } else {
                    out[slot].push('\n');
                    out[slot].push_str(&el);
                }
            }
        }
    }
}

/// Zahl aus JSON (null/fehlend → NaN wie `undefined`/`NaN` in JS-Rechnungen).
fn jnum(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn jstr<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// `op(p)` aus JSON-Feldern: greyed (wahr) bzw. opacity < 1.
fn op_json(v: &Value) -> String {
    let greyed = match v.get("greyed") {
        Some(Value::Bool(b)) => *b,
        _ => false,
    };
    op(greyed, v.get("opacity").map(|o| o.as_f64().unwrap_or(f64::NAN)))
}

fn op(greyed: bool, opacity: Option<f64>) -> String {
    if greyed {
        " opacity=\"0.35\"".into()
    } else {
        match opacity {
            Some(o) if o < 1.0 => format!(" opacity=\"{}\"", num(o)),
            _ => String::new(),
        }
    }
}

/// Gestrichelter Zug aus aneinander anschliessenden Linien gleicher Darstellung ([153]).
struct DashRun {
    /// Attribute ohne Geometrie (Farbe, Breite, Muster, Deckkraft).
    key: String,
    /// Muster in Papier-mm.
    dash: Vec<f64>,
    pts: Vec<V2>,
    /// Platz in der Ausgabe (erste Linie des Zugs).
    slot: usize,
}

/// Schreibt einen Zug als `<line>`/`<polyline>` mit der Musterphase ([`super::line_pattern::phase`]):
/// beide Enden möglichst auf einem Strich, Phase über die Ecken.
fn flush_dash_run(run: Option<DashRun>, out: &mut [String], mm_to_m: f64, xs: &dyn Fn(f64) -> String, ys: &dyn Fn(f64) -> String) {
    let Some(r) = run else { return };
    let len: f64 = r.pts.windows(2).map(|w| crate::jsmath::hypot2(w[1].x - w[0].x, w[1].y - w[0].y)).sum();
    let ph = if mm_to_m > 0.0 { super::line_pattern::phase(len / mm_to_m, &r.dash) } else { 0.0 };
    let off = if ph > 1e-9 { format!(" stroke-dashoffset=\"{}\"", num(ph * mm_to_m)) } else { String::new() };
    out[r.slot] = if r.pts.len() == 2 {
        format!("<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"{}{off}/>", xs(r.pts[0].x), ys(r.pts[0].y), xs(r.pts[1].x), ys(r.pts[1].y), r.key)
    } else {
        format!("<polyline points=\"{}\" fill=\"none\"{}{off}/>", r.pts.iter().map(|q| format!("{},{}", xs(q.x), ys(q.y))).collect::<Vec<_>>().join(" "), r.key)
    };
}

/// SVG-Text des Plans; `None` bei kaputtem Puffer.
pub fn plan_svg(parts: &mut [Part], o: &SvgOptions) -> Option<String> {
    let n = o.scale_denominator;
    let margin = o.margin_m;
    let mm_to_m = n / 1000.0;
    let x0 = o.min_x - margin;
    let w = o.max_x - o.min_x + 2.0 * margin;
    let h = o.max_y - o.min_y + 2.0 * margin;
    let top = o.max_y + margin;
    let xs = |x: f64| num(x);
    let ys = |y: f64| num(top - y);
    let mut out: Vec<String> = Vec::new();
    let mut stitch = Stitcher::default();
    // [153] Gestrichelte Linien, die aneinander anschliessen, als EIN Zug (Phase über die Ecken).
    let mut run: Option<DashRun> = None;
    for part in parts.iter_mut() {
        let hatches = if o.hatch { part.view.hatch_table()? } else { Vec::new() };
        for i in part.from..part.to {
            let rec = part.view.rec(i)?;
            let f = rec.f.clone();
            let fl = rec.flags;
            if rec.tag != T_LINE || fl & F_DASH_LIST == 0 {
                flush_dash_run(run.take(), &mut out, mm_to_m, &xs, &ys);
            }
            let greyed = fl & F_GREYED != 0;
            let opacity = |k: usize| (fl & F_OPACITY != 0).then_some(f[k]);
            let dash_attr = |part: &Part| -> Option<String> {
                if fl & F_DASH_LIST == 0 {
                    return Some(String::new());
                }
                let (o, len) = rec.dash?;
                let d = part.view.pool(o, len)?;
                if d.is_empty() {
                    return Some(String::new());
                }
                // Punkte (AN = 0) brauchen runde Kappen, sonst sind sie unsichtbar ([96]).
                let cap = if d.iter().any(|v| *v == 0.0) { " stroke-linecap=\"round\"" } else { "" };
                Some(format!(" stroke-dasharray=\"{}\"{cap}", d.iter().map(|v| num(v * mm_to_m)).collect::<Vec<_>>().join(" ")))
            };
            match rec.tag {
                T_POLYGON => {
                    let pts = part.view.pool_pts(whole(f[5])?, whole(f[6])?)?;
                    if pts.len() < 3 {
                        continue;
                    }
                    let pl = pts.iter().map(|q| format!("{},{}", xs(q.x), ys(q.y))).collect::<Vec<_>>().join(" ");
                    let fill = esc(part.str(f[0]).unwrap_or(""));
                    let stroke = esc(part.str(f[1]).unwrap_or(""));
                    // Nicht gestrichene Kanten (Stossfugen, Lücken an Anschlüssen): Fläche ohne Strich,
                    // die übrigen Kanten als offener Pfad — wie der GPU-Pfad (`stroke_polygon_outline`).
                    let nse: Vec<usize> = match rec.nse {
                        Some((o, len)) => part.view.pool(o, len)?.iter().filter(|e| e.is_finite() && **e >= 0.0).map(|e| *e as usize).collect(),
                        None => Vec::new(),
                    };
                    if !nse.is_empty() && stroke != "none" && !stroke.is_empty() {
                        out.push(format!("<polygon points=\"{pl}\" fill=\"{fill}\" stroke=\"none\"{}/>", op(greyed, opacity(4))));
                        // Sichtbare Kantenläufe zum Zusammennähen ([146]), Kanten in Ring-Reihenfolge.
                        let nse_f: Vec<f64> = nse.iter().map(|&e| e as f64).collect();
                        let attrs = format!(" stroke=\"{stroke}\" stroke-width=\"{}\"{}", num(f[2] * mm_to_m), op(greyed, opacity(4)));
                        for run in crate::plan::scene::visible_edge_runs(&pts, &nse_f) {
                            out.push(String::new());
                            stitch.add(attrs.clone(), run, out.len() - 1);
                        }
                    } else {
                        out.push(format!(
                            "<polygon points=\"{pl}\" fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{}\"{}/>",
                            num(f[2] * mm_to_m),
                            op(greyed, opacity(4))
                        ));
                    }
                    // [140] Schraffur auch bei Kantenläufen (Wandschichten mit offenen Kanten).
                    if o.hatch && f[3] >= 0.0 {
                        let (_, h, color) = hatches.get(whole(f[3])?)?.clone();
                        if h.pattern != Pattern::None && h.pattern != Pattern::Solid && h.kind != hatch::HatchKind::Image {
                            let hc = if color >= 0 { esc(&part.view.string(color as usize)?) } else { "#000".into() };
                            let k = 1000.0 / n;
                            let pen = num(quantize_pen(h.line_weight) * mm_to_m);
                            let dash = hatch_dash_paper(&h, k);
                            let da = if dash.is_empty() {
                                String::new()
                            } else {
                                let cap = if dash.iter().any(|v| *v == 0.0) { " stroke-linecap=\"round\"" } else { "" };
                                format!(" stroke-dasharray=\"{}\"{cap}", dash.iter().map(|v| num(v * mm_to_m)).collect::<Vec<_>>().join(" "))
                            };
                            let mut runs: Vec<Vec<V2>> = Vec::new();
                            if h.random {
                                runs.extend(hatch::build_random_hatch_runs(&pts, &h, None).into_iter().filter(|r| r.len() >= 2).map(|r| vec![r[0], r[r.len() - 1]]));
                            } else if is_generated(h.pattern) {
                                runs.extend(hatch::build_hatch_runs(&pts, &h));
                            } else {
                                let pts_mm: Vec<V2> = pts.iter().map(|q| V2 { x: q.x * k, y: q.y * k }).collect();
                                runs.extend(hatch_lines(&pts_mm, &h, k).into_iter().map(|(a, b)| vec![V2 { x: a.x / k, y: a.y / k }, V2 { x: b.x / k, y: b.y / k }]));
                            }
                            for run in runs {
                                match run.len() {
                                    0 | 1 => {}
                                    2 => out.push(format!(
                                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{hc}\" stroke-width=\"{pen}\"{da}{}/>",
                                        xs(run[0].x), ys(run[0].y), xs(run[1].x), ys(run[1].y), op(greyed, opacity(4))
                                    )),
                                    _ => out.push(format!(
                                        "<polyline points=\"{}\" fill=\"none\" stroke=\"{hc}\" stroke-width=\"{pen}\"{da}{}/>",
                                        run.iter().map(|q| format!("{},{}", xs(q.x), ys(q.y))).collect::<Vec<_>>().join(" "),
                                        op(greyed, opacity(4))
                                    )),
                                }
                            }
                        }
                    }
                }
                T_LINE => {
                    let color = if fl & F_COLOR != 0 { esc(part.str(f[1]).unwrap_or("")) } else { "#000".into() };
                    let dash = dash_attr(part)?;
                    if !dash.is_empty() {
                        // Muster (Papier-mm) für die Phase; Zug fortsetzen oder neu beginnen.
                        let (po, plen) = rec.dash?;
                        let pat = part.view.pool(po, plen)?;
                        let key = format!(" stroke=\"{color}\" stroke-width=\"{}\"{dash}{}", num(f[2] * mm_to_m), op(greyed, opacity(3)));
                        let (a, b) = (V2 { x: f[4], y: f[5] }, V2 { x: f[6], y: f[7] });
                        if let Some(r) = run.as_mut().filter(|r| r.key == key && r.pts.last().is_some_and(|p| (p.x - a.x).abs() < 1e-9 && (p.y - a.y).abs() < 1e-9)) {
                            r.pts.push(b);
                        } else {
                            flush_dash_run(run.take(), &mut out, mm_to_m, &xs, &ys);
                            out.push(String::new());
                            run = Some(DashRun { key, dash: pat, pts: vec![a, b], slot: out.len() - 1 });
                        }
                        continue;
                    }
                    flush_dash_run(run.take(), &mut out, mm_to_m, &xs, &ys);
                    // [146] Volle Linien: mit Kantenläufen gleicher Farbe/Breite zusammennähen (Ecke statt
                    // zweier Enden); Enden und Ecken erben die Projekt-Einstellung vom `<g>`.
                    if f[2] > 0.0 {
                        out.push(String::new());
                        let attrs = format!(" stroke=\"{color}\" stroke-width=\"{}\"{}", num(f[2] * mm_to_m), op(greyed, opacity(3)));
                        stitch.add(attrs, vec![V2 { x: f[4], y: f[5] }, V2 { x: f[6], y: f[7] }], out.len() - 1);
                        continue;
                    }
                    out.push(format!(
                        "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{color}\" stroke-width=\"{}\"{dash}{}/>",
                        xs(f[4]),
                        ys(f[5]),
                        xs(f[6]),
                        ys(f[7]),
                        num(f[2] * mm_to_m),
                        op(greyed, opacity(3))
                    ));
                }
                T_ARC => {
                    let (cx, cy, fx, fy, tx, ty, r) = (f[4], f[5], f[6], f[7], f[8], f[9], f[10]);
                    let a0 = jsnum::atan2(fy - cy, fx - cx);
                    let mut sweep = jsnum::atan2(ty - cy, tx - cx) - a0;
                    while sweep < 0.0 && sweep.is_finite() {
                        sweep += PI * 2.0;
                    }
                    let dash = dash_attr(part)?;
                    out.push(format!(
                        "<path d=\"M {} {} A {} {} 0 {} 0 {} {}\" fill=\"none\" stroke=\"#000\" stroke-width=\"{}\"{dash}{}/>",
                        xs(fx),
                        ys(fy),
                        num(r),
                        num(r),
                        if sweep > PI { 1 } else { 0 },
                        xs(tx),
                        ys(ty),
                        num(f[2] * mm_to_m),
                        op(greyed, opacity(3))
                    ));
                }
                T_CIRCLE => {
                    let fill = esc(part.str(f[0]).unwrap_or(""));
                    let stroke = esc(part.str(f[1]).unwrap_or(""));
                    let dash = dash_attr(part)?;
                    out.push(format!(
                        "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{}\"{dash}{}/>",
                        xs(f[4]),
                        ys(f[5]),
                        num(f[6]),
                        num(f[2] * mm_to_m),
                        op(greyed, opacity(3))
                    ));
                }
                T_DRAWING_ARC => {
                    let (cx, cy, r, a0, a1) = (f[3], f[4], f[5], f[6], f[7]);
                    let sx = cx + r * jsnum::cos(a0);
                    let sy = cy + r * jsnum::sin(a0);
                    let ex = cx + r * jsnum::cos(a1);
                    let ey = cy + r * jsnum::sin(a1);
                    let mut sweep = a1 - a0;
                    while sweep < 0.0 && sweep.is_finite() {
                        sweep += PI * 2.0;
                    }
                    let stroke = esc(part.str(f[0]).unwrap_or(""));
                    let dash = dash_attr(part)?;
                    out.push(format!(
                        "<path d=\"M {} {} A {} {} 0 {} 0 {} {}\" fill=\"none\" stroke=\"{stroke}\" stroke-width=\"{}\"{dash}{}/>",
                        xs(sx),
                        ys(sy),
                        num(r),
                        num(r),
                        if sweep > PI { 1 } else { 0 },
                        xs(ex),
                        ys(ey),
                        num(f[1] * mm_to_m),
                        op(greyed, opacity(2))
                    ));
                }
                T_DRAWING_TEXT | T_TEXT => {
                    // Texte reisen als JSON (nur im Text-Modus der Abschnitte; sonst fehlen sie).
                    let Some(js) = part.str(f[0]).map(str::to_owned) else { continue };
                    let Ok(v) = serde_json::from_str::<Value>(&js) else { continue };
                    let at = v.get("at").cloned().unwrap_or(Value::Null);
                    let (ax, ay) = (jnum(&at, "x"), jnum(&at, "y"));
                    if rec.tag == T_DRAWING_TEXT {
                        let angle = jnum(&v, "angle");
                        out.push(format!(
                            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"{}\" font-family=\"sans-serif\" transform=\"rotate({} {} {})\"{}>{}</text>",
                            xs(ax),
                            ys(ay),
                            num(jnum(&v, "heightM")),
                            esc(jstr(&v, "color").unwrap_or("")),
                            num(-(angle * 180.0) / PI),
                            xs(ax),
                            ys(ay),
                            op_json(&v),
                            esc(jstr(&v, "text").unwrap_or(""))
                        ));
                    } else {
                        out.push(stamp_svg(&v, ax, top - ay, mm_to_m));
                    }
                }
                _ => {}
            }
        }
        flush_dash_run(run.take(), &mut out, mm_to_m, &xs, &ys);
    }
    stitch.finish(&mut out, &xs, &ys);
    out.retain(|s| !s.is_empty());
    Some(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{} 0 {} {}\" width=\"{}mm\" height=\"{}mm\">\n<rect x=\"{}\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"#ffffff\"/>\n<g {}>\n{}\n</g>\n</svg>\n",
        num(x0),
        num(w),
        num(h),
        num(w * 1000.0 / n),
        num(h * 1000.0 / n),
        num(x0),
        num(w),
        num(h),
        o.line_ends.svg_attrs(),
        out.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zahlen_und_escapes() {
        assert_eq!(num(1.234567), "1.23457");
        assert_eq!(num(f64::NAN), "0");
        assert_eq!(num(-0.000001), "0");
        assert_eq!(esc("a<b & \"c\">"), "a&lt;b &amp; &quot;c&quot;&gt;");
        assert_eq!(op(false, Some(0.5)), " opacity=\"0.5\"");
        assert_eq!(op(true, Some(0.5)), " opacity=\"0.35\"");
        assert_eq!(op(false, Some(1.0)), "");
    }

    /// [140] Raumstempel wie gemessen (`stamp_block`): Name in seinen Auszeichnungen (fett, eigene Grösse),
    /// Zusatzzeilen 0.8 ×, Block um den Anker zentriert, Schrift Inter mit sans-serif-Rückfall.
    #[test]
    fn raumstempel_wie_gemessen() {
        use crate::model::{Align, Marks, Vec2};
        use crate::plan::buf::{View, Writer};
        use crate::plan::prim::{Primitive, StampLine};
        let bold = Marks { bold: Some(true), size_pt: Some(12.0), ..Default::default() };
        let doc = crate::text_layout::doc_from_text("Wohnen", &bold);
        let mut w = Writer::new(true);
        let g = w.begin_group();
        w.push(&Primitive::Text { at: Vec2 { x: 2.0, y: 2.0 }, doc, extra_lines: vec![StampLine { text: "20.00 m²".into(), align: Align::Center }], base_pt: 10.0, color: "#111111".into(), room_id: Some("r".into()), greyed: None, opacity: None });
        w.end_group(g);
        let bytes = w.finish();
        let view = View::parse(&bytes).unwrap();
        let n = view.len();
        let mut parts = vec![Part::new(view, 0, n).unwrap()];
        let o = SvgOptions { scale_denominator: 100.0, margin_m: 0.0, min_x: 0.0, min_y: 0.0, max_x: 4.0, max_y: 4.0, hatch: false, line_ends: LineEnds::default() };
        let svg = plan_svg(&mut parts, &o).unwrap();
        let texts: Vec<&str> = svg.lines().filter(|l| l.starts_with("<text")).collect();
        assert_eq!(texts.len(), 2, "{svg}");
        assert!(texts.iter().all(|t| t.contains("font-family=\"Inter, sans-serif\"")), "{texts:?}");
        // 12 pt = 4.233 mm Papier = 0.4233 m bei 1:100; Zusatzzeile 0.8 × 10 pt = 0.28222 m.
        assert!(texts[0].contains("font-size=\"0.4233\"") && texts[0].contains("font-weight=\"700\""), "{}", texts[0]);
        assert!(texts[1].contains("font-size=\"0.28222\"") && !texts[1].contains("font-weight") && texts[1].contains("text-anchor=\"middle\""), "{}", texts[1]);
        let x = |t: &str| t.split("x=\"").nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
        // Linksbündiger Name beginnt am linken Rand des um den Anker zentrierten Blocks (breiteste Zeile).
        let w = crate::text_layout::text_width_em("Wohnen", true) * 0.4233;
        assert!(texts[0].contains("text-anchor=\"start\"") && (x(texts[0]) - (2.0 - w / 2.0)).abs() < 1e-4, "{}", texts[0]);
        assert_eq!(x(texts[1]), 2.0);
        // Block um den Anker (SVG y = 4 − 2 = 2) zentriert: erste Grundlinie darüber, zweite darunter.
        let y = |t: &str| t.split("y=\"").nth(1).unwrap().split('"').next().unwrap().parse::<f64>().unwrap();
        assert!(y(texts[0]) < 2.0 && y(texts[1]) > 2.0, "{texts:?}");
    }

    /// [146] Wand-Umrisse als volle Linie bzw. offene Kantenläufe (Stossfugen nicht gestrichen) werden
    /// an der gemeinsamen Ecke zu EINEM Zug genäht (Gehrung statt zweier flacher Enden = keine Kerbe);
    /// Enden und Ecken stehen einmal am umschliessenden `<g>`.
    #[test]
    fn umriss_ecke_als_zug() {
        use crate::model::Vec2;
        use crate::plan::buf::{View, Writer};
        use crate::plan::prim::Primitive;
        let v = |x: f64, y: f64| Vec2 { x, y };
        let mut w = Writer::new(false);
        let g = w.begin_group();
        w.push(&Primitive::Polygon {
            pts: vec![v(0.0, 0.0), v(4.0, 0.0), v(3.7, 0.3), v(0.3, 0.3)],
            fill: "#fff".into(),
            stroke: "#000".into(),
            stroke_width_mm: 0.5,
            hatch: crate::plan::style::no_hatch(),
            greyed: None,
            opacity: None,
            no_stroke_edges: Some(vec![1.0, 3.0]),
            wall_id: None,
            drawing_id: None,
            ceiling_id: None,
            opening_id: None,
            stair_id: None,
            room_id: None,
            extruded_solid_id: None,
            context_object_id: None,
            column_id: None,
            roof_id: None,
            section_line_id: None,
        });
        w.push(&Primitive::Line { a: v(0.0, 0.0), b: v(0.0, 4.0), cls: "wall-outline".into(), weight_mm: 0.5, dash: None, zigzag: None, motif: None, color: Some("#000".into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None });
        w.end_group(g);
        let bytes = w.finish();
        let view = View::parse(&bytes).unwrap();
        let n = view.len();
        let mut parts = vec![Part::new(view, 0, n).unwrap()];
        let opts = |line_ends| SvgOptions { scale_denominator: 50.0, margin_m: 0.5, min_x: 0.0, min_y: 0.0, max_x: 4.0, max_y: 4.0, hatch: false, line_ends };
        let svg = plan_svg(&mut parts, &opts(LineEnds::default())).unwrap();
        assert!(svg.contains("<g stroke-linecap=\"butt\" stroke-linejoin=\"miter\" stroke-miterlimit=\"4\">"), "{svg}");
        assert!(!svg.contains("<path"), "keine einzelnen Kantenläufe mehr: {svg}");
        // Lauf (4,0)→(0,0) des Polygons und die Linie (0,0)→(0,4) bilden einen Zug mit Ecke in (0,0).
        let pl = svg.lines().find(|l| l.starts_with("<polyline")).unwrap();
        assert!(pl.contains("points=\"4,4.5 0,4.5 0,0.5\"") || pl.contains("points=\"0,0.5 0,4.5 4,4.5\""), "{pl}");
        assert!(!pl.contains("linecap"), "{pl}");
        let mut parts = vec![Part::new(View::parse(&bytes).unwrap(), 0, n).unwrap()];
        let svg = plan_svg(&mut parts, &opts(LineEnds { cap: 1, join: 2 })).unwrap();
        assert!(svg.contains("<g stroke-linecap=\"round\" stroke-linejoin=\"bevel\""), "{svg}");
    }
}
