//! Plan → SVG-Text ohne DOM ([K3d], früher `src/export/planToSvgString.ts`): für `dossier-cli plan`,
//! MCP und Referenzbild-Tests, direkt aus den Abschnitten eines zusammengesetzten Plans
//! ([`crate::plan_parts`]). Koordinaten in Metern (Y nach oben → SVG gespiegelt), Strichstärken
//! aus Papier-mm über den Massstab; Schraffur-Muster werden nicht ausgebreitet (nur Grundfüllung),
//! Bilder und Textpfade fehlen — gedacht für Kontrolle und Diffs, nicht für Druck. Byte-gleich zur
//! TS-Fassung (Zahlen wie `String(Math.round(v·1e5)/1e5)`, Texte aus dem Text-JSON des Puffers).

use crate::js_fmt::js_number;
use crate::jsnum;
use crate::plan_buf::{whole, F_COLOR, F_DASH_LIST, F_GREYED, F_OPACITY, T_ARC, T_CIRCLE, T_DRAWING_ARC, T_DRAWING_TEXT, T_LINE, T_POLYGON, T_TEXT};
use crate::plan_parts::Part;
use serde_json::Value;
use std::f64::consts::PI;

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
    for part in parts.iter_mut() {
        for i in part.from..part.to {
            let rec = part.view.rec(i)?;
            let f = rec.f.clone();
            let fl = rec.flags;
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
                        let k = pts.len();
                        let mut d = String::new();
                        for e in 0..k {
                            if nse.contains(&e) {
                                continue;
                            }
                            if e == 0 || nse.contains(&(e - 1)) {
                                d.push_str(&format!("M{},{}", xs(pts[e].x), ys(pts[e].y)));
                            }
                            let q = pts[(e + 1) % k];
                            d.push_str(&format!(" L{},{}", xs(q.x), ys(q.y)));
                        }
                        out.push(format!("<polygon points=\"{pl}\" fill=\"{fill}\" stroke=\"none\"{}/>", op(greyed, opacity(4))));
                        if !d.is_empty() {
                            out.push(format!(
                                "<path d=\"{d}\" fill=\"none\" stroke=\"{stroke}\" stroke-width=\"{}\" stroke-linejoin=\"round\"{}/>",
                                num(f[2] * mm_to_m),
                                op(greyed, opacity(4))
                            ));
                        }
                        continue;
                    }
                    out.push(format!(
                        "<polygon points=\"{pl}\" fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{}\" stroke-linejoin=\"round\"{}/>",
                        num(f[2] * mm_to_m),
                        op(greyed, opacity(4))
                    ));
                }
                T_LINE => {
                    let color = if fl & F_COLOR != 0 { esc(part.str(f[1]).unwrap_or("")) } else { "#000".into() };
                    let dash = dash_attr(part)?;
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
                        let size = (jnum(&v, "basePt") * 0.3528) * mm_to_m;
                        // plainText(doc): Absätze (Runs verkettet) mit "\n".
                        let doc = v.get("doc").and_then(|d| d.get("paragraphs")).and_then(Value::as_array);
                        let plain = doc
                            .map(|ps| {
                                ps.iter()
                                    .map(|p| p.get("runs").and_then(Value::as_array).map(|rs| rs.iter().map(|r| jstr(r, "text").unwrap_or("")).collect::<String>()).unwrap_or_default())
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        let mut lines = vec![plain];
                        if let Some(ex) = v.get("extraLines").and_then(Value::as_array) {
                            for l in ex {
                                lines.push(jstr(l, "text").unwrap_or("").to_owned());
                            }
                        }
                        let color = esc(jstr(&v, "color").unwrap_or(""));
                        let o = op_json(&v);
                        for (k, ln) in lines.iter().filter(|s| !s.is_empty()).enumerate() {
                            out.push(format!(
                                "<text x=\"{}\" y=\"{}\" font-size=\"{}\" fill=\"{color}\" font-family=\"sans-serif\" text-anchor=\"middle\"{o}>{}</text>",
                                xs(ax),
                                num(top - ay + k as f64 * size * 1.2),
                                num(size),
                                esc(ln)
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Some(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{} 0 {} {}\" width=\"{}mm\" height=\"{}mm\">\n<rect x=\"{}\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"#ffffff\"/>\n{}\n</svg>\n",
        num(x0),
        num(w),
        num(h),
        num(w * 1000.0 / n),
        num(h * 1000.0 / n),
        num(x0),
        num(w),
        num(h),
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
}
