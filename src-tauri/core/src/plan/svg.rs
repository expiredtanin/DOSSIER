//! Plan → SVG-Text ohne DOM ([K3d], früher `src/export/planToSvgString.ts`): für `dossier-cli plan`,
//! MCP und Referenzbild-Tests, direkt aus den Abschnitten eines zusammengesetzten Plans
//! ([`crate::plan::parts`]). Koordinaten in Metern (Y nach oben → SVG gespiegelt), Strichstärken
//! aus Papier-mm über den Massstab; Schraffur-Muster werden nur mit `hatch` ausgebreitet (sonst nur Grundfüllung),
//! Vollflächen-Schraffur (Füllung) und Bild-Schraffur (`<pattern>`) nur mit `hatch`, Textpfade fehlen — gedacht für Kontrolle und Diffs, nicht für Druck. Byte-gleich zur
//! TS-Fassung (Zahlen wie `String(Math.round(v·1e5)/1e5)`, Texte aus dem Text-JSON des Puffers).

use crate::js_fmt::js_number;
use crate::hatch::{self, Pattern, V2};
use crate::jsnum;
use crate::plan::print_svg::{hatch_dash_paper, hatch_runs, image_tile, quantize_pen};
use crate::plan::buf::{whole, F_COLOR, F_DASH_LIST, F_GREYED, F_OPACITY, T_ARC, T_CIRCLE, T_DRAWING_ARC, T_DRAWING_TEXT, T_LINE, T_POLYGON, T_TEXT};
use crate::plan::line_ends::LineEnds;
use crate::plan::parts::Part;
use crate::plan::scene::stitch_runs_members;
use crate::plan::arc_fit;
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

    fn finish(self, out: &mut [String], xs: &dyn Fn(f64) -> String, ys: &dyn Fn(f64) -> String, top: f64) {
        for (attrs, runs, slots) in self.groups {
            for (pts, closed, members) in stitch_runs_members(&runs) {
                if pts.len() < 2 {
                    continue;
                }
                let slot = members.iter().map(|&m| slots[m]).max().unwrap_or(0);
                // [169] Bögen (runde Stütze, Bogenwand) als Kreis bzw. Pfad mit `A`.
                let (g, _) = shape_el(&pts, closed, xs, ys, top);
                let el = if g.starts_with("line ") { format!("<{g}{attrs}/>") } else { format!("<{g} fill=\"none\"{attrs}/>") };
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

/// [157] Haarstrich (Papier-mm) gegen die Fuge zwischen aneinanderstossenden dunklen Flächen. [171] 0.12 statt
/// 0.05: ab etwa 12 px/mm (Zoom in Chromium, Vorschau) blieb bei 0.05 mm (0.6 px) eine helle Haarlinie zwischen den
/// Schichten der schwarzen Schnittfläche (1:100); 0.12 mm deckt sie, die Fläche wächst nur um 0.06 mm.
pub(crate) const SEAM_MM: f64 = 0.12;

/// [157] Deckend dunkle Füllfarbe (`#rgb`, `#rrggbb`, `#rrggbbff`; jeder Kanal ≤ 0x40), die zwischen zwei
/// Flächen eine helle Haarfuge zeigt (Chromium/PDF glätten aneinanderstossende Flächen einzeln): solche
/// Flächen ohne eigenen Strich bekommen einen Haarstrich [`SEAM_MM`] in ihrer Farbe — schwarze
/// Schnittflächen (Wandecken, Schichten im Schnitt 1:100) bleiben ohne helle Linien dazwischen.
pub(crate) fn seam_fill(fill: &str) -> bool {
    let h = fill.trim().strip_prefix('#').unwrap_or("");
    let ch = |i: usize, n: usize| u8::from_str_radix(&h[i * n..i * n + n], 16).ok().map(|v| if n == 1 { v * 17 } else { v });
    let (rgb, alpha) = match h.len() {
        3 if h.is_ascii() => ([ch(0, 1), ch(1, 1), ch(2, 1)], Some(255)),
        6 | 8 if h.is_ascii() => ([ch(0, 2), ch(1, 2), ch(2, 2)], if h.len() == 8 { u8::from_str_radix(&h[6..8], 16).ok() } else { Some(255) }),
        _ => return false,
    };
    alpha == Some(255) && rgb.iter().all(|c| c.is_some_and(|c| c <= 0x40))
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

/// [169] Geometrie eines Rings oder Zugs als Element-Anfang (Tag und Geometrie-Attribute): ganzer Kreis als
/// `circle`, Zug mit erkannten Bögen als `path` mit `A`-Befehlen ([`arc_fit`]), sonst `polygon`/`polyline`
/// bzw. `line`. Zweiter Wert = Länge (für die Musterphase).
fn shape_el(pts: &[V2], closed: bool, xs: &dyn Fn(f64) -> String, ys: &dyn Fn(f64) -> String, top: f64) -> (String, f64) {
    if let Some(sh) = arc_fit::fit(pts, closed, arc_fit::TOL) {
        let len = arc_fit::length(&sh);
        if let arc_fit::Shape::Circle { c, r, .. } = sh {
            return (format!("circle cx=\"{}\" cy=\"{}\" r=\"{}\"", xs(c.x), ys(c.y), num(r)), len);
        }
        let d = arc_fit::svg_d(&sh, &|p| V2 { x: p.x, y: top - p.y }, 1.0, &num);
        return (format!("path d=\"{d}\""), len);
    }
    let mut len: f64 = pts.windows(2).map(|w| crate::jsmath::hypot2(w[1].x - w[0].x, w[1].y - w[0].y)).sum();
    if !closed && pts.len() == 2 {
        return (format!("line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"", xs(pts[0].x), ys(pts[0].y), xs(pts[1].x), ys(pts[1].y)), len);
    }
    if closed && pts.len() > 1 {
        len += crate::jsmath::hypot2(pts[0].x - pts[pts.len() - 1].x, pts[0].y - pts[pts.len() - 1].y);
    }
    let pl = pts.iter().map(|q| format!("{},{}", xs(q.x), ys(q.y))).collect::<Vec<_>>().join(" ");
    (format!("{} points=\"{pl}\"", if closed { "polygon" } else { "polyline" }), len)
}

/// [153]/[169] `stroke-dashoffset` eines gestrichelten Bogens der Modell-Länge `len_m` (Muster in Papier-mm).
fn arc_dash_offset(part: &Part, rec: &crate::plan::buf::Rec, len_m: f64, mm_to_m: f64) -> String {
    if rec.flags & F_DASH_LIST == 0 || !(mm_to_m > 0.0) {
        return String::new();
    }
    let Some(d) = rec.dash.and_then(|(o, n)| part.view.pool(o, n)) else { return String::new() };
    let ph = super::line_pattern::phase(len_m / mm_to_m, &d);
    if ph > 1e-9 {
        format!(" stroke-dashoffset=\"{}\"", num(ph * mm_to_m))
    } else {
        String::new()
    }
}

/// [153] `stroke-dasharray` eines gestrichelten Vollkreises vom Umfang `circ_m`: Muster auf ganze Wiederholungen
/// gestreckt ([`super::line_pattern::fit_closed`]), damit es an der Naht schliesst; `None` ohne Strichliste.
fn circle_dash_attr(part: &Part, rec: &crate::plan::buf::Rec, circ_m: f64, mm_to_m: f64) -> Option<String> {
    if rec.flags & F_DASH_LIST == 0 || !(mm_to_m > 0.0) {
        return None;
    }
    let d = rec.dash.and_then(|(o, n)| part.view.pool(o, n))?;
    if d.is_empty() {
        return None;
    }
    let fit = super::line_pattern::fit_closed(&d, circ_m / mm_to_m);
    let cap = if fit.iter().any(|v| *v == 0.0) { " stroke-linecap=\"round\"" } else { "" };
    Some(format!(" stroke-dasharray=\"{}\"{cap}", fit.iter().map(|v| num(v * mm_to_m)).collect::<Vec<_>>().join(" ")))
}

/// Gestrichelter Zug aus aneinander anschliessenden Linien gleicher Darstellung ([153]).
struct DashRun {
    /// Attribute ohne Geometrie (Farbe, Breite, Muster, Deckkraft).
    key: String,
    /// Das `stroke-dasharray`-Attribut (samt Kappe) darin, für den geschlossenen Zug ersetzbar.
    dash_attr: String,
    /// Muster in Papier-mm.
    dash: Vec<f64>,
    pts: Vec<V2>,
    /// Platz in der Ausgabe (erste Linie des Zugs).
    slot: usize,
}

/// Schreibt einen Zug als `<line>`/`<polyline>` mit der Musterphase ([`super::line_pattern::phase`]):
/// beide Enden möglichst auf einem Strich, Phase über die Ecken.
fn flush_dash_run(run: Option<DashRun>, out: &mut [String], mm_to_m: f64, xs: &dyn Fn(f64) -> String, ys: &dyn Fn(f64) -> String, top: f64) {
    let Some(mut r) = run else { return };
    // [153] Geschlossener Zug (Rechteck, Vieleck, Ellipse): Muster über den Gesamtumfang auf ganze
    // Wiederholungen gestreckt, Naht schliesst, Phase läuft über die Ecken.
    let closed = r.pts.len() > 3 && (r.pts[0].x - r.pts[r.pts.len() - 1].x).abs() < 1e-9 && (r.pts[0].y - r.pts[r.pts.len() - 1].y).abs() < 1e-9;
    if closed {
        r.pts.pop();
    }
    // [169] Bögen im Zug als `A`; Phase über die Länge mit Bögen.
    let (g, len) = shape_el(&r.pts, closed, xs, ys, top);
    if closed && mm_to_m > 0.0 {
        let fit = super::line_pattern::fit_closed(&r.dash, len / mm_to_m);
        let cap = if fit.iter().any(|v| *v == 0.0) { " stroke-linecap=\"round\"" } else { "" };
        let attr = format!(" stroke-dasharray=\"{}\"{cap}", fit.iter().map(|v| num(v * mm_to_m)).collect::<Vec<_>>().join(" "));
        r.key = r.key.replacen(&r.dash_attr, &attr, 1);
    }
    let ph = if closed || !(mm_to_m > 0.0) { 0.0 } else { super::line_pattern::phase(len / mm_to_m, &r.dash) };
    let off = if ph > 1e-9 { format!(" stroke-dashoffset=\"{}\"", num(ph * mm_to_m)) } else { String::new() };
    out[r.slot] = if g.starts_with("line ") { format!("<{g}{}{off}/>", r.key) } else { format!("<{g} fill=\"none\"{}{off}/>", r.key) };
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
    // [133] Muster der Bild-Schraffuren (je Bild einmal).
    let mut defs: Vec<String> = Vec::new();
    let mut patterns: HashMap<String, String> = HashMap::new();
    // [153] Gestrichelte Linien, die aneinander anschliessen, als EIN Zug (Phase über die Ecken).
    let mut run: Option<DashRun> = None;
    for part in parts.iter_mut() {
        let hatches = if o.hatch { part.view.hatch_table()? } else { Vec::new() };
        for i in part.from..part.to {
            let rec = part.view.rec(i)?;
            let f = rec.f.clone();
            let fl = rec.flags;
            if rec.tag != T_LINE || fl & F_DASH_LIST == 0 {
                flush_dash_run(run.take(), &mut out, mm_to_m, &xs, &ys, top);
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
                    // [169] Ganzer Kreis bzw. Ring mit Bögen als `<circle>`/`<path>`; Schraffur am fein
                    // nachtesselierten Ring beschnitten (endet am Bogen, nicht an der Sehne).
                    let (geo, _) = shape_el(&pts, true, &xs, &ys, top);
                    let hatch_pts = if geo.starts_with("polygon") { pts.clone() } else { arc_fit::refine(&pts, true, arc_fit::TOL, &arc_fit::fine_segments).unwrap_or_else(|| pts.clone()) };
                    let mut fill = esc(part.str(f[0]).unwrap_or(""));
                    let stroke = esc(part.str(f[1]).unwrap_or(""));
                    // [133] Schraffur-Eintrag der Fläche; Vollfläche füllt in Schraffurfarbe (wie Druck/PDF).
                    let hent = if o.hatch && f[3] >= 0.0 { Some(hatches.get(whole(f[3])?)?.clone()) } else { None };
                    if let Some((_, h, color)) = &hent {
                        if h.pattern == Pattern::Solid && h.kind != hatch::HatchKind::Image {
                            fill = if *color >= 0 { esc(&part.view.string(*color as usize)?) } else { "#000".into() };
                        }
                    }
                    // Nicht gestrichene Kanten (Stossfugen, Lücken an Anschlüssen): Fläche ohne Strich,
                    // die übrigen Kanten als offener Pfad — wie der GPU-Pfad (`stroke_polygon_outline`).
                    let nse: Vec<usize> = match rec.nse {
                        Some((o, len)) => part.view.pool(o, len)?.iter().filter(|e| e.is_finite() && **e >= 0.0).map(|e| *e as usize).collect(),
                        None => Vec::new(),
                    };
                    // [157] Dunkle, deckende Fläche ohne eigenen Strich: Haarstrich in der Füllfarbe gegen die Fuge.
                    let seam = !greyed && opacity(4).is_none_or(|a| a >= 1.0) && seam_fill(&fill);
                    let seam_attr = || format!(" stroke=\"{fill}\" stroke-width=\"{}\"", num(SEAM_MM * mm_to_m));
                    if !nse.is_empty() && stroke != "none" && !stroke.is_empty() {
                        let st = if seam { seam_attr() } else { " stroke=\"none\"".to_string() };
                        out.push(format!("<{geo} fill=\"{fill}\"{st}{}/>", op(greyed, opacity(4))));
                        // Sichtbare Kantenläufe zum Zusammennähen ([146]), Kanten in Ring-Reihenfolge.
                        let nse_f: Vec<f64> = nse.iter().map(|&e| e as f64).collect();
                        let attrs = format!(" stroke=\"{stroke}\" stroke-width=\"{}\"{}", num(f[2] * mm_to_m), op(greyed, opacity(4)));
                        for run in crate::plan::scene::visible_edge_runs(&pts, &nse_f) {
                            out.push(String::new());
                            stitch.add(attrs.clone(), run, out.len() - 1);
                        }
                    } else if seam && (stroke == "none" || stroke.is_empty() || !(f[2] > 0.0)) {
                        out.push(format!("<{geo} fill=\"{fill}\"{}{}/>", seam_attr(), op(greyed, opacity(4))));
                    } else {
                        out.push(format!(
                            "<{geo} fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{}\"{}/>",
                            num(f[2] * mm_to_m),
                            op(greyed, opacity(4))
                        ));
                    }
                    // [133] Bild-Schraffur: gekacheltes `<pattern>` über die Fläche (wie Druck/PDF), Umriss darüber.
                    if let Some((json, h, _)) = &hent {
                        if h.kind == hatch::HatchKind::Image && *json >= 0 {
                            let j: Value = serde_json::from_str(&part.view.string(*json as usize)?).unwrap_or(Value::Null);
                            if let Some(img) = j.get("image").filter(|v| v.is_object()) {
                                let key = img.to_string();
                                let id = match patterns.get(&key) {
                                    Some(id) => id.clone(),
                                    None => {
                                        let id = format!("imgpat-{}", patterns.len());
                                        let (tw, th, rot) = image_tile(img);
                                        let (tw, th) = (num(tw * mm_to_m), num(th * mm_to_m));
                                        let tf = if rot != 0.0 { format!(" patternTransform=\"rotate({})\"", num(rot)) } else { String::new() };
                                        defs.push(format!(
                                            "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" width=\"{tw}\" height=\"{th}\"{tf}><image href=\"{}\" x=\"0\" y=\"0\" width=\"{tw}\" height=\"{th}\" preserveAspectRatio=\"none\"/></pattern>",
                                            esc(jstr(img, "src").unwrap_or(""))
                                        ));
                                        patterns.insert(key, id.clone());
                                        id
                                    }
                                };
                                out.push(format!("<{geo} fill=\"url(#{id})\" stroke=\"none\"{}/>", op(greyed, opacity(4))));
                                if nse.is_empty() && stroke != "none" && !stroke.is_empty() && f[2] > 0.0 {
                                    out.push(format!("<{geo} fill=\"none\" stroke=\"{stroke}\" stroke-width=\"{}\"{}/>", num(f[2] * mm_to_m), op(greyed, opacity(4))));
                                }
                            }
                        }
                    }
                    // [140] Schraffur auch bei Kantenläufen (Wandschichten mit offenen Kanten).
                    if let Some((_, h, color)) = &hent {
                        if h.pattern != Pattern::None && h.pattern != Pattern::Solid && h.kind == hatch::HatchKind::Vector {
                            let hc = if *color >= 0 { esc(&part.view.string(*color as usize)?) } else { "#000".into() };
                            let k = 1000.0 / n;
                            let pen = num(quantize_pen(h.line_weight) * mm_to_m);
                            let dash = hatch_dash_paper(h, k);
                            let da = if dash.is_empty() {
                                String::new()
                            } else {
                                let cap = if dash.iter().any(|v| *v == 0.0) { " stroke-linecap=\"round\"" } else { "" };
                                format!(" stroke-dasharray=\"{}\"{cap}", dash.iter().map(|v| num(v * mm_to_m)).collect::<Vec<_>>().join(" "))
                            };
                            // [166] Alle Vektor-Schraffuren aus dem Kern-Generator wie Szene/PDF/Druck-SVG (Winkel-Lesart
                            // der SVG-Kachel, polare Schraffur der Bogenwand); [133] Löcher: Ring mit Brücke, even-odd.
                            for run in hatch_runs(&hatch_pts, h) {
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
                            flush_dash_run(run.take(), &mut out, mm_to_m, &xs, &ys, top);
                            out.push(String::new());
                            run = Some(DashRun { key, dash_attr: dash.clone(), dash: pat, pts: vec![a, b], slot: out.len() - 1 });
                        }
                        continue;
                    }
                    flush_dash_run(run.take(), &mut out, mm_to_m, &xs, &ys, top);
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
                    let dash = dash_attr(part)? + &arc_dash_offset(part, &rec, r * sweep.abs(), mm_to_m);
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
                    let dash = circle_dash_attr(part, &rec, f[6] * PI * 2.0, mm_to_m).map_or_else(|| dash_attr(part), Some)?;
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
                    let dash = dash_attr(part)? + &arc_dash_offset(part, &rec, r * sweep.abs(), mm_to_m);
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
        flush_dash_run(run.take(), &mut out, mm_to_m, &xs, &ys, top);
    }
    stitch.finish(&mut out, &xs, &ys, top);
    out.retain(|s| !s.is_empty());
    Some(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{} 0 {} {}\" width=\"{}mm\" height=\"{}mm\">\n<rect x=\"{}\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"#ffffff\"/>\n{}<g {}>\n{}\n</g>\n</svg>\n",
        num(x0),
        num(w),
        num(h),
        num(w * 1000.0 / n),
        num(h * 1000.0 / n),
        num(x0),
        num(w),
        num(h),
        if defs.is_empty() { String::new() } else { format!("<defs>{}</defs>\n", defs.concat()) },
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

    /// [157] Haarfuge: zwei schwarze Schnittflächen (Wandecke, Schichten im Schnitt 1:100) stossen aneinander;
    /// jede deckend dunkle Fläche ohne Strich bekommt einen Haarstrich in ihrer Farbe, der die Fuge schliesst
    /// (Chromium/PDF glätten die Kanten einzeln → helle Linie). Helle oder durchscheinende Flächen nicht.
    #[test]
    fn schwarze_flaechen_ohne_haarfuge() {
        use crate::model::Vec2;
        use crate::plan::buf::{View, Writer};
        use crate::plan::prim::Primitive;
        let v = |x: f64, y: f64| Vec2 { x, y };
        let poly = |pts: Vec<Vec2>, fill: &str, nse: Option<Vec<f64>>| Primitive::Polygon {
            pts,
            fill: fill.into(),
            stroke: if nse.is_some() { "#1a1a1a".into() } else { "none".into() },
            stroke_width_mm: if nse.is_some() { 0.25 } else { 0.0 },
            hatch: Box::new(crate::plan::style::no_hatch()),
            greyed: None,
            opacity: None,
            no_stroke_edges: nse,
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
        };
        let mut w = Writer::new(false);
        let g = w.begin_group();
        w.push(&poly(vec![v(0.0, 0.0), v(2.0, 0.0), v(2.0, 0.3), v(0.0, 0.3)], "#0f0f0f", None));
        w.push(&poly(vec![v(2.0, 0.0), v(4.0, 0.0), v(4.0, 0.3), v(2.0, 0.3)], "#111111", Some(vec![3.0])));
        w.push(&poly(vec![v(0.0, 1.0), v(4.0, 1.0), v(4.0, 2.0)], "#ffffff", None));
        w.push(&poly(vec![v(0.0, 3.0), v(4.0, 3.0), v(4.0, 4.0)], "#3c3c3c29", None));
        w.end_group(g);
        let bytes = w.finish();
        let view = View::parse(&bytes).unwrap();
        let n = view.len();
        let mut parts = vec![Part::new(view, 0, n).unwrap()];
        let o = SvgOptions { scale_denominator: 100.0, margin_m: 0.5, min_x: 0.0, min_y: 0.0, max_x: 4.0, max_y: 4.0, hatch: false, line_ends: LineEnds::default() };
        let svg = plan_svg(&mut parts, &o).unwrap();
        let polys: Vec<&str> = svg.lines().filter(|l| l.starts_with("<polygon")).collect();
        assert_eq!(polys.len(), 4, "{svg}");
        assert!(polys[0].contains("fill=\"#0f0f0f\" stroke=\"#0f0f0f\" stroke-width=\"0.012\""), "{}", polys[0]);
        assert!(polys[1].contains("fill=\"#111111\" stroke=\"#111111\" stroke-width=\"0.012\""), "Kantenlauf-Fläche: {}", polys[1]);
        assert!(polys[2].contains("stroke=\"none\""), "weiss: {}", polys[2]);
        assert!(polys[3].contains("stroke=\"none\""), "durchscheinend: {}", polys[3]);
        assert!(seam_fill("#000") && seam_fill("#1a1a1aff") && !seam_fill("#6e6e6e") && !seam_fill("none") && !seam_fill("#00000080"));
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
            hatch: Box::new(crate::plan::style::no_hatch()),
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

    /// [169] Runde Stütze (32-Eck) als `<circle>`, Bogenwand-Band mit offenen Stirnkanten als Pfad mit `A`,
    /// gestrichelter Bogen mit Musterphase.
    #[test]
    fn kreise_und_boegen_statt_vielecke() {
        use crate::model::Vec2;
        use crate::plan::buf::{View, Writer};
        use crate::plan::prim::Primitive;
        let v = |x: f64, y: f64| Vec2 { x, y };
        let poly = |pts: Vec<Vec2>, nse: Option<Vec<f64>>| Primitive::Polygon {
            pts,
            fill: "#ffffff".into(),
            stroke: "#000000".into(),
            stroke_width_mm: 0.35,
            hatch: Box::new(crate::plan::style::no_hatch()),
            greyed: None,
            opacity: None,
            no_stroke_edges: nse,
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
        };
        let col: Vec<Vec2> = (0..32).map(|i| { let t = PI * 2.0 * i as f64 / 32.0; v(1.0 + 0.15 * t.cos(), 1.0 + 0.15 * t.sin()) }).collect();
        let n = 12;
        let mut band: Vec<Vec2> = (0..=n).map(|i| { let t = PI / 2.0 * i as f64 / n as f64; v(5.0 * t.cos(), 5.0 * t.sin()) }).collect();
        band.extend((0..=n).rev().map(|i| { let t = PI / 2.0 * i as f64 / n as f64; v(4.7 * t.cos(), 4.7 * t.sin()) }));
        // Stirnkanten (Index n und 2n+1) nicht gestrichen.
        let nse = vec![n as f64, (2 * n + 1) as f64];
        let mut w = Writer::new(false);
        let g = w.begin_group();
        w.push(&poly(col, None));
        w.push(&poly(band, Some(nse)));
        w.push(&Primitive::Arc { center: v(0.0, 0.0), from: v(2.0, 0.0), to: v(0.0, 2.0), r: 2.0, cls: "door-swing".into(), weight_mm: 0.18, dash: Some(Some(vec![2.0, 1.0])), color: None, opening_id: None, stair_id: None, greyed: None, opacity: None });
        w.end_group(g);
        let bytes = w.finish();
        let view = View::parse(&bytes).unwrap();
        let len = view.len();
        let mut parts = vec![Part::new(view, 0, len).unwrap()];
        let o = SvgOptions { scale_denominator: 50.0, margin_m: 0.5, min_x: -1.0, min_y: -1.0, max_x: 6.0, max_y: 6.0, hatch: false, line_ends: LineEnds::default() };
        let svg = plan_svg(&mut parts, &o).unwrap();
        let circle = svg.lines().find(|l| l.starts_with("<circle")).unwrap_or_else(|| panic!("{svg}"));
        assert!(circle.contains("cx=\"1\" cy=\"5.5\" r=\"0.15\"") && circle.contains("stroke=\"#000000\""), "{circle}");
        assert!(!svg.contains("<polygon"), "{svg}");
        // Band: Fläche als Pfad mit zwei Bögen, sichtbare Kanten (die zwei Bögen) als offene Pfade.
        let paths: Vec<&str> = svg.lines().filter(|l| l.starts_with("<path")).collect();
        assert!(paths.iter().any(|p| p.matches(" A ").count() == 2 && p.contains(" Z\"") && p.contains("fill=\"#ffffff\"")), "{paths:?}");
        assert_eq!(paths.iter().filter(|p| p.matches(" A ").count() == 1 && p.contains("fill=\"none\"") && p.contains("stroke=\"#000000\"")).count(), 2, "{paths:?}");
        // Gestrichelter Viertelbogen r = 2 m: Länge π m = 62.83 mm Papier, Muster 2/1 mm → Phase ≠ 0.
        let arc = paths.iter().find(|p| p.contains("stroke-dasharray")).unwrap();
        assert!(arc.contains("stroke-dashoffset"), "{arc}");
    }
}
