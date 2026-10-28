//! Render-Szene aus dem Plan-Puffer ([K3d], früher `planToRenderScene` in
//! `src/plan/toRenderScene.ts`): Füllungen, Umrisse, Polylinien, Bögen und Linien für render2d,
//! direkt aus den Abschnitten eines zusammengesetzten Plans ([`crate::plan_parts`]) — ohne Umweg
//! über `Primitive[]`. Texte setzt TS (Text-Layout bleibt dort) und gibt sie fertig mit.
//!
//! Bitgleich zur TS-Fassung: Farben wie `toRgba`, CSS-Klassen-Farben/-Deckkraft, Dimmen,
//! Maler-Reihenfolge `z`, Verkettung der 2D-Zeichenlinien, Kantenläufe mit Naht über
//! Polygon-Grenzen hinweg, Schraffur-Läufe, Zickzack/Motiv, Kreis-Tessellierung.
//!
//! Zwei Ausgaben: [`encode_scene_bin`] (render2d-Szene v1, s. `render2d/src/scene_bin.rs`) und
//! [`encode_scene_f64`] (verlustfrei für den Druck-/SVG-Export und `--format json`):
//! ```text
//! [nFills, nOutlines, nPolylines, nArcs, nLines]
//! Füllung   n, z, r, g, b, a, x, y …
//! Umriss    n, z, widthMm, dash, r, g, b, a, x, y …
//! Polylinie n, z, widthMm, dash, r, g, b, a, x, y …
//! Bogen     r, widthMm, dash, r, g, b, a, cx, cy, fx, fy, tx, ty
//! Linie     z, widthMm, dash, r, g, b, a, ax, ay, bx, by
//! dash = −2 (Feld fehlt) · −1 (null) · k ≥ 0 (k Werte folgen)
//! ```

use crate::hatch::{self, v2, HatchKind, Motif, Pattern, V2, DASH_MM_TO_M};
use crate::jsnum;
use crate::plan::overrides::js_trim;
use crate::plan_buf::{js_parse_hex, whole, Rec, F_COLOR, F_DASH_LIST, F_DASH_NULL, F_MOTIF, F_NSE, F_ZIGZAG};
use crate::plan_buf::{T_ARC, T_CIRCLE, T_DRAWING_ARC, T_DRAWING_TEXT, T_IMAGE, T_LINE, T_POLYGON, T_TEXT};
use crate::plan_parts::{greyed_of, in_ranges, pick_id, Part};
use std::collections::HashMap;
use std::f64::consts::PI;

pub type Rgba = [f64; 4];

/// Strichmuster eines Szenen-Elements.
#[derive(Clone, Debug, PartialEq)]
pub enum SDash {
    /// Feld fehlt (Umrisse, Schraffur-Läufe, Zickzack/Motiv, Nähte).
    Absent,
    Null,
    List(Vec<f64>),
}

impl SDash {
    fn list(&self) -> &[f64] {
        match self {
            SDash::List(l) => l,
            _ => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SFill {
    pub pts: Vec<V2>,
    pub color: Rgba,
    pub z: f64,
}

/// Umriss (geschlossen) oder Polylinie (offen).
#[derive(Clone, Debug, PartialEq)]
pub struct SStroke {
    pub pts: Vec<V2>,
    pub color: Rgba,
    pub width_mm: f64,
    pub dash: SDash,
    pub z: f64,
    /// `widthMm` in Bildschirm-Einheiten (render2d-Flag; heute von keinem Primitiv gesetzt).
    pub width_screen: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SArc {
    pub center: V2,
    pub from: V2,
    pub to: V2,
    pub r: f64,
    pub color: Rgba,
    pub width_mm: f64,
    pub dash: SDash,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SLine {
    pub a: V2,
    pub b: V2,
    pub color: Rgba,
    pub width_mm: f64,
    pub dash: SDash,
    pub z: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scene {
    pub fills: Vec<SFill>,
    pub outlines: Vec<SStroke>,
    pub polylines: Vec<SStroke>,
    pub arcs: Vec<SArc>,
    pub lines: Vec<SLine>,
}

// ── Farben (wie `toRgba`/`withOpacity` der TS-Fassung) ──────────────────────────────────────────

const DEFAULT_LINE: &str = "#1a1a1a";
const INK: Rgba = [0.1, 0.1, 0.1, 1.0];
/// Fester Grauton gedimmter Primitive (wie `GREY_RGB` in `gpu_compile.rs`).
const GREY_RGB: f64 = 0.549;

/// CSS-Strichfarbe je Linienklasse (Spiegel der `.plan-svg .<cls>`-Regeln in styles.css).
fn cls_stroke(cls: Option<&str>) -> Option<&'static str> {
    match cls? {
        "door-leaf" | "door-swing" | "door-frame" | "window-glass" => Some("#1a1a1a"),
        "wall-axis" => Some("#4a453e"),
        _ => None,
    }
}

fn cls_opacity(cls: Option<&str>) -> f64 {
    match cls {
        Some("wall-axis") => 0.85,
        Some("context-line") => 0.7,
        _ => 1.0,
    }
}

/// Hex-/Namens-Farbe → RGBA (0…1) oder `None` bei "none"/leer — wie `toRgba(input, 1)`.
pub fn to_rgba(input: Option<&str>) -> Option<Rgba> {
    let input = input?;
    if input.is_empty() {
        return None;
    }
    let alpha = 1.0;
    let mut h: String = js_trim(input).to_lowercase();
    if h == "none" || h == "transparent" {
        return None;
    }
    if !h.starts_with('#') {
        h = match h.as_str() {
            "black" => "#000000".into(),
            "white" => "#ffffff".into(),
            "red" => "#ff0000".into(),
            _ => return Some([0.0, 0.0, 0.0, alpha]),
        };
    }
    let mut u: Vec<u16> = h.encode_utf16().skip(1).collect();
    if u.len() == 3 || u.len() == 4 {
        u = u.iter().flat_map(|&c| [c, c]).collect();
    }
    if u.len() != 6 && u.len() != 8 {
        return Some([0.0, 0.0, 0.0, alpha]);
    }
    let r = js_parse_hex(&u[0..2]) / 255.0;
    let g = js_parse_hex(&u[2..4]) / 255.0;
    let b = js_parse_hex(&u[4..6]) / 255.0;
    let a = if u.len() == 8 { js_parse_hex(&u[6..8]) / 255.0 } else { alpha };
    if ![r, g, b, a].iter().all(|v| v.is_finite()) {
        return Some([0.0, 0.0, 0.0, alpha]);
    }
    Some([r, g, b, a])
}

fn with_opacity(col: Rgba, cls: Option<&str>, greyed: bool) -> Rgba {
    let o = cls_opacity(cls);
    let rgb = if greyed { [GREY_RGB, GREY_RGB, GREY_RGB, col[3]] } else { col };
    if o == 1.0 {
        rgb
    } else {
        [rgb[0], rgb[1], rgb[2], rgb[3] * o]
    }
}

fn with_fill_opacity(col: Rgba, greyed: bool) -> Rgba {
    if greyed {
        [1.0, 1.0, 1.0, col[3]]
    } else {
        col
    }
}

/// Strichfarbe einer line/arc: CSS-Klassen-Farbe > Modell-Farbe > Tinte.
fn stroke_color_for(cls: Option<&str>, color: Option<&str>) -> Rgba {
    to_rgba(Some(cls_stroke(cls).or(color).unwrap_or(DEFAULT_LINE))).unwrap_or(INK)
}

// ── Schlüssel wie JS-Strings von Zahlen ─────────────────────────────────────────────────────────

/// Zahl als Schlüssel mit der Gleichheit von `String(x)`: −0 = 0, alle NaN gleich.
#[inline]
fn num_key(x: f64) -> u64 {
    if x.is_nan() {
        0x7ff8_0000_0000_0000
    } else if x == 0.0 {
        0
    } else {
        x.to_bits()
    }
}

/// Gleichheit wie `JSON.stringify(a ?? null) === JSON.stringify(b ?? null)` für Strichmuster.
fn same_dash_json(a: &SDash, b: &SDash) -> bool {
    match (a, b) {
        (SDash::List(x), SDash::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| (!p.is_finite() && !q.is_finite()) || p == q)
        }
        (SDash::List(_), _) | (_, SDash::List(_)) => false,
        _ => true,
    }
}

#[inline]
fn same_pt(a: V2, b: V2) -> bool {
    (a.x - b.x).abs() < 1e-6 && (a.y - b.y).abs() < 1e-6
}

// ── Kantenläufe (wie `visibleEdgeRuns`/`stitchRuns`) ────────────────────────────────────────────

/// Sichtbare Kantenläufe eines Rings (die Kanten aus `no_stroke` fehlen).
pub fn visible_edge_runs(pts: &[V2], no_stroke: &[f64]) -> Vec<Vec<V2>> {
    let n = pts.len();
    let nf = n as f64;
    let mut skip: Vec<u64> = no_stroke.iter().map(|&i| num_key(((i % nf) + nf) % nf)).collect();
    skip.sort_unstable();
    skip.dedup();
    if skip.len() >= n || n < 2 {
        return Vec::new();
    }
    let visible = |i: isize| -> bool {
        let k = ((i as f64 % nf) + nf) % nf;
        skip.binary_search(&num_key(k)).is_err()
    };
    let mut runs = Vec::new();
    for s in 0..n as isize {
        if !visible(s) || visible(s - 1 + n as isize) {
            continue;
        }
        let mut run = vec![pts[s as usize]];
        let mut j = s;
        while visible(j) && ((j - s) as usize) < n {
            run.push(pts[((j + 1) as usize) % n]);
            j += 1;
        }
        runs.push(run);
    }
    runs
}

const STITCH_EPS: f64 = 1e-5;

#[inline]
fn cell_of(p: V2) -> (f64, f64) {
    (jsnum::round(p.x / STITCH_EPS), jsnum::round(p.y / STITCH_EPS))
}

#[inline]
fn stitch_key(p: V2) -> (u64, u64) {
    let (x, y) = cell_of(p);
    (num_key(x), num_key(y))
}

/// Näht Kantenläufe über Polygon-Grenzen hinweg zusammen (genau zwei Enden je Stelle).
/// Ergebnis: (Punkte, geschlossen). Gleiche Wahl wie die lineare Suche der TS-Fassung (der
/// erste passende Lauf in Pool-Reihenfolge); ein Raster über den Endpunkten findet die Kandidaten.
pub fn stitch_runs(runs: Vec<Vec<V2>>) -> Vec<(Vec<V2>, bool)> {
    let mut end_count: HashMap<(u64, u64), u32> = HashMap::new();
    for r in &runs {
        for p in [r[0], r[r.len() - 1]] {
            *end_count.entry(stitch_key(p)).or_insert(0) += 1;
        }
    }
    let joinable = |p: V2| end_count.get(&stitch_key(p)) == Some(&2);
    // Raster: Zelle (gerundet) → Läufe mit einem Ende darin. `same_pt` (< 1e-6) liegt höchstens
    // eine Zelle daneben.
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    let cell_int = |p: V2| -> Option<(i64, i64)> {
        let (x, y) = cell_of(p);
        (x.is_finite() && y.is_finite() && x.abs() < 9e15 && y.abs() < 9e15).then_some((x as i64, y as i64))
    };
    // Enden ausserhalb des Rasters (NaN/riesig) — immer prüfen.
    let mut wild: Vec<usize> = Vec::new();
    for (i, r) in runs.iter().enumerate() {
        for p in [r[0], r[r.len() - 1]] {
            match cell_int(p) {
                Some(c) => grid.entry(c).or_default().push(i),
                None => wild.push(i),
            }
        }
    }
    let mut used = vec![false; runs.len()];
    let mut out = Vec::new();
    let mut cand: Vec<usize> = Vec::new();
    for seed in 0..runs.len() {
        if used[seed] {
            continue;
        }
        used[seed] = true;
        let mut chain = runs[seed].clone();
        let mut extended = true;
        while extended && !(chain.len() > 2 && same_pt(chain[0], chain[chain.len() - 1])) {
            extended = false;
            let head = chain[0];
            let tail = chain[chain.len() - 1];
            cand.clear();
            for p in [tail, head] {
                if let Some((cx, cy)) = cell_int(p) {
                    for dx in -1..=1 {
                        for dy in -1..=1 {
                            if let Some(l) = grid.get(&(cx + dx, cy + dy)) {
                                cand.extend(l.iter().copied().filter(|&i| !used[i]));
                            }
                        }
                    }
                } else {
                    // Kein Raster-Platz: alle Läufe prüfen (wie die lineare Suche).
                    cand.extend((0..runs.len()).filter(|&i| !used[i]));
                }
            }
            cand.extend(wild.iter().copied().filter(|&i| !used[i]));
            cand.sort_unstable();
            cand.dedup();
            let jt = joinable(tail);
            let jh = joinable(head);
            for &ci in &cand {
                let c = &runs[ci];
                let cs = c[0];
                let ce = c[c.len() - 1];
                if jt && same_pt(tail, cs) {
                    chain.extend_from_slice(&c[1..]);
                } else if jt && same_pt(tail, ce) {
                    chain.extend(c.iter().rev().skip(1).copied());
                } else if jh && same_pt(head, ce) {
                    let mut n = c.clone();
                    n.extend_from_slice(&chain[1..]);
                    chain = n;
                } else if jh && same_pt(head, cs) {
                    let mut n: Vec<V2> = c.iter().rev().copied().collect();
                    n.extend_from_slice(&chain[1..]);
                    chain = n;
                } else {
                    continue;
                }
                used[ci] = true;
                extended = true;
                break;
            }
        }
        let closed = chain.len() > 3 && same_pt(chain[0], chain[chain.len() - 1]);
        if closed {
            chain.pop();
        }
        out.push((chain, closed));
    }
    out
}

// ── Szene ────────────────────────────────────────────────────────────────────────────────────────

/// Quelle eines laufenden, verketteten 2D-Zeichnungs-Zugs.
struct RunSrc {
    cls: Option<String>,
    color: Option<String>,
    weight: f64,
    dash: SDash,
    greyed: bool,
}

struct EdgeGroup {
    color: Rgba,
    width_mm: f64,
    runs: Vec<Vec<V2>>,
    z: f64,
}

struct Builder {
    s: Scene,
    zc: f64,
    cur: Option<(Vec<V2>, RunSrc)>,
    groups: Vec<EdgeGroup>,
    group_of: HashMap<[u64; 5], usize>,
}

impl Builder {
    fn z(&mut self) -> f64 {
        let z = self.zc;
        self.zc += 1.0;
        z
    }

    fn flush(&mut self) {
        if let Some((pts, src)) = self.cur.take() {
            if pts.len() >= 2 {
                let col = with_opacity(stroke_color_for(src.cls.as_deref(), src.color.as_deref()), src.cls.as_deref(), src.greyed);
                let closed = pts.len() > 2 && same_pt(pts[0], pts[pts.len() - 1]);
                let dash = match src.dash {
                    SDash::Absent => SDash::Null,
                    d => d,
                };
                let z = self.z();
                if closed {
                    let mut p = pts;
                    p.pop();
                    self.s.outlines.push(SStroke { pts: p, color: col, width_mm: src.weight, dash, z, width_screen: false });
                } else {
                    self.s.polylines.push(SStroke { pts, color: col, width_mm: src.weight, dash, z, width_screen: false });
                }
            }
        }
    }

    fn edge_run(&mut self, run: Vec<V2>, color: Rgba, width_mm: f64, z: f64) {
        let k = [num_key(color[0]), num_key(color[1]), num_key(color[2]), num_key(color[3]), num_key(width_mm)];
        let gi = match self.group_of.get(&k) {
            Some(&g) => g,
            None => {
                self.groups.push(EdgeGroup { color, width_mm, runs: Vec::new(), z });
                self.group_of.insert(k, self.groups.len() - 1);
                self.groups.len() - 1
            }
        };
        let g = &mut self.groups[gi];
        g.runs.push(run);
        g.z = jsnum::max(g.z, z);
    }
}

/// Strichmuster eines Eintrags (`dash ?? null`).
fn dash_of(part: &Part, rec: &Rec) -> Option<SDash> {
    if rec.flags & F_DASH_NULL != 0 {
        Some(SDash::Null)
    } else if rec.flags & F_DASH_LIST != 0 {
        let (o, n) = rec.dash?;
        Some(SDash::List(part.view.pool(o, n)?))
    } else {
        Some(SDash::Null)
    }
}

/// Render-Szene aus den Abschnitten; `None` bei kaputtem Puffer.
pub fn build_scene(parts: &mut [Part], greyed_ranges: &[(usize, usize)]) -> Option<Scene> {
    let mut b = Builder { s: Scene::default(), zc: 0.0, cur: None, groups: Vec::new(), group_of: HashMap::new() };
    let mut gi = 0usize; // Index im zusammengesetzten Plan
    for part in parts.iter_mut() {
        // Farben dieses Puffers (String-Index → RGBA), einmal je String.
        let mut colors: HashMap<i64, Option<Rgba>> = HashMap::new();
        let mut hatches: Option<Vec<(i32, hatch::Hatch, i32)>> = None;
        for i in part.from..part.to {
            let forced = !greyed_ranges.is_empty() && in_ranges(greyed_ranges, gi);
            gi += 1;
            let rec = part.view.rec(i)?;
            let greyed = greyed_of(&rec, forced) == Some(true);
            let f = rec.f.clone();
            let mut color = |part: &mut Part, idx: f64| -> Option<Rgba> {
                if idx < 0.0 {
                    return None;
                }
                let k = idx as i64;
                if let Some(c) = colors.get(&k) {
                    return *c;
                }
                let c = to_rgba(part.str(idx));
                colors.insert(k, c);
                c
            };
            match rec.tag {
                T_POLYGON => {
                    b.flush();
                    let pts = part.view.pool_pts(whole(f[5])?, whole(f[6])?)?;
                    if pts.len() < 2 {
                        continue;
                    }
                    if let Some(fc) = color(part, f[0]) {
                        if pts.len() >= 3 {
                            let z = b.z();
                            b.s.fills.push(SFill { pts: pts.clone(), color: with_fill_opacity(fc, greyed), z });
                        }
                    }
                    if f[3] != -1.0 {
                        if hatches.is_none() {
                            hatches = Some(part.view.hatch_table()?);
                        }
                        let (_, h, hc) = hatches.as_ref()?.get(whole(f[3])?)?.clone();
                        if h.kind != HatchKind::Image && h.kind != HatchKind::Gradient && h.pattern != Pattern::None && h.pattern != Pattern::Solid {
                            let hatch_col = with_opacity(color(part, hc as f64).unwrap_or(INK), None, greyed);
                            let hatch_mm = if h.line_weight > 0.0 { h.line_weight } else { 0.13 };
                            let runs = if pts.len() < 3 { Vec::new() } else { hatch::build_hatch_runs(&pts, &h) };
                            let runs = hatch::apply_dash_runs(runs, &h.dash);
                            let hz = b.z();
                            for run in runs {
                                if run.len() >= 2 {
                                    b.s.polylines.push(SStroke { pts: run, color: hatch_col, width_mm: hatch_mm, dash: SDash::Absent, z: hz, width_screen: false });
                                }
                            }
                        }
                    }
                    if let Some(raw) = color(part, f[1]) {
                        let w = f[2];
                        if w > 0.0 {
                            let sc = with_opacity(raw, None, greyed);
                            let nse = match (rec.flags & F_NSE != 0, rec.nse) {
                                (true, Some((o, n))) => part.view.pool(o, n)?,
                                _ => Vec::new(),
                            };
                            if nse.is_empty() {
                                let z = b.z();
                                b.s.outlines.push(SStroke { pts, color: sc, width_mm: w, dash: SDash::Absent, z, width_screen: false });
                            } else {
                                let rz = b.z();
                                for run in visible_edge_runs(&pts, &nse) {
                                    b.edge_run(run, sc, w, rz);
                                }
                            }
                        }
                    }
                }
                T_LINE => {
                    let cls = part.str(f[0]).map(str::to_owned);
                    let col_s = if rec.flags & F_COLOR != 0 { part.str(f[1]).map(str::to_owned) } else { None };
                    let a = v2(f[4], f[5]);
                    let bb = v2(f[6], f[7]);
                    let w = f[2];
                    if rec.flags & F_ZIGZAG != 0 {
                        b.flush();
                        let (amp, wav) = rec.zigzag?;
                        let zp = hatch::zigzag_points(a, bb, amp * DASH_MM_TO_M, wav * DASH_MM_TO_M).unwrap_or_else(|| vec![a, bb]);
                        let col = with_opacity(stroke_color_for(cls.as_deref(), col_s.as_deref()), cls.as_deref(), greyed);
                        if zp.len() >= 2 {
                            let z = b.z();
                            b.s.polylines.push(SStroke { pts: zp, color: col, width_mm: w, dash: SDash::Absent, z, width_screen: false });
                        }
                    } else if rec.flags & F_MOTIF != 0 {
                        b.flush();
                        let (length, o, n) = rec.motif?;
                        let m = Motif { length, points: part.view.pool_pts(o, n)? };
                        let mp = hatch::motif_points(a, bb, &m, DASH_MM_TO_M);
                        let col = with_opacity(stroke_color_for(cls.as_deref(), col_s.as_deref()), cls.as_deref(), greyed);
                        if mp.len() >= 2 {
                            let z = b.z();
                            b.s.polylines.push(SStroke { pts: mp, color: col, width_mm: w, dash: SDash::Absent, z, width_screen: false });
                        }
                    } else {
                        let dash = dash_of(part, &rec)?;
                        let drawing = match pick_id(&part.view, &rec, 2) {
                            Some(s) => part.str(s).is_some_and(|s| !s.is_empty()),
                            None => false,
                        };
                        if drawing {
                            let src = RunSrc { cls, color: col_s, weight: w, dash, greyed };
                            let cont = match &b.cur {
                                Some((pts, c)) => {
                                    c.cls == src.cls
                                        && c.weight == src.weight
                                        && c.color.as_deref().unwrap_or("") == src.color.as_deref().unwrap_or("")
                                        && same_dash_json(&c.dash, &src.dash)
                                        && same_pt(pts[pts.len() - 1], a)
                                }
                                None => false,
                            };
                            if cont {
                                b.cur.as_mut()?.0.push(bb);
                            } else {
                                b.flush();
                                b.cur = Some((vec![a, bb], src));
                            }
                        } else {
                            b.flush();
                            let col = with_opacity(stroke_color_for(cls.as_deref(), col_s.as_deref()), cls.as_deref(), greyed);
                            let z = b.z();
                            b.s.lines.push(SLine { a, b: bb, color: col, width_mm: w, dash, z });
                        }
                    }
                }
                T_ARC => {
                    b.flush();
                    let cls = part.str(f[0]).map(str::to_owned);
                    let col = with_opacity(stroke_color_for(cls.as_deref(), None), cls.as_deref(), greyed);
                    let dash = dash_of(part, &rec)?;
                    b.s.arcs.push(SArc { center: v2(f[4], f[5]), from: v2(f[6], f[7]), to: v2(f[8], f[9]), r: f[10], color: col, width_mm: f[2], dash });
                }
                T_CIRCLE | T_DRAWING_ARC => {
                    b.flush();
                    let circle = rec.tag == T_CIRCLE;
                    let stroke = if circle { f[1] } else { f[0] };
                    let col = with_opacity(color(part, stroke).unwrap_or(INK), None, greyed);
                    let (w, c, r) = if circle { (f[2], v2(f[4], f[5]), f[6]) } else { (f[1], v2(f[3], f[4]), f[5]) };
                    let tau = PI * 2.0;
                    let a0 = if circle { 0.0 } else { f[6] };
                    let sweep = if circle { tau } else { (((f[7] - f[6]) % tau) + tau) % tau };
                    let n = jsnum::max(8.0, (sweep / (PI / 32.0)).ceil());
                    let mut pts = Vec::new();
                    let mut k = 0.0f64;
                    while k <= n {
                        let t = a0 + (sweep * k) / n;
                        pts.push(v2(c.x + r * jsnum::cos(t), c.y + r * jsnum::sin(t)));
                        k += 1.0;
                    }
                    let dash = dash_of(part, &rec)?;
                    let z = b.z();
                    b.s.polylines.push(SStroke { pts, color: col, width_mm: w, dash, z, width_screen: false });
                }
                // Text, Einzeltext, Bild: Zeilen setzt TS; hier nur den Linienzug abschliessen
                // (Textpfad und Platzhalter berühren ihn nicht, wie in der TS-Fassung).
                T_TEXT | T_DRAWING_TEXT | T_IMAGE => b.flush(),
                _ => {}
            }
        }
    }
    b.flush();
    let groups = std::mem::take(&mut b.groups);
    for g in groups {
        for (pts, closed) in stitch_runs(g.runs) {
            if pts.len() < 2 {
                continue;
            }
            let s = SStroke { pts, color: g.color, width_mm: g.width_mm, dash: SDash::Absent, z: g.z, width_screen: false };
            if closed {
                b.s.outlines.push(s);
            } else {
                b.s.polylines.push(s);
            }
        }
    }
    Some(b.s)
}

// ── Ausgaben ─────────────────────────────────────────────────────────────────────────────────────

/// Eine Textzeile (von TS gesetzt) für die render2d-Szene.
pub struct SText {
    pub pos: V2,
    pub size_mm: f64,
    pub color: Rgba,
    /// 0 links · 1 Mitte · 2 rechts
    pub align: u32,
    pub content: Vec<u8>,
}

/// Texte aus `[x, y, sizeMm, r, g, b, a, align, nBytes]*` und den UTF-8-Bytes; `None` bei Unsinn.
pub fn texts_from(nums: &[f64], bytes: &[u8]) -> Option<Vec<SText>> {
    if nums.len() % 9 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(nums.len() / 9);
    let mut o = 0usize;
    for t in nums.chunks_exact(9) {
        let n = whole(t[8])?;
        let content = bytes.get(o..o.checked_add(n)?)?.to_vec();
        o += n;
        out.push(SText { pos: v2(t[0], t[1]), size_mm: t[2], color: [t[3], t[4], t[5], t[6]], align: whole(t[7])? as u32, content });
    }
    (o == bytes.len()).then_some(out)
}

/// `z >>> 0` (ToUint32).
fn u32_of(z: f64) -> u32 {
    jsnum::to_int32(z) as u32
}

/// render2d-Szene v1 (Format s. `render2d/src/scene_bin.rs`), gleiche Bytes wie die frühere
/// TS-Kodierung `encodeRenderScene`.
pub fn encode_scene_bin(s: &Scene, texts: &[SText]) -> Vec<u8> {
    let mut n_pts = 0usize;
    let mut n_dash = 0usize;
    for f in &s.fills {
        n_pts += f.pts.len();
    }
    for o in s.outlines.iter().chain(&s.polylines) {
        n_pts += o.pts.len();
        n_dash += o.dash.list().len();
    }
    for a in &s.arcs {
        n_dash += a.dash.list().len();
    }
    for l in &s.lines {
        n_dash += l.dash.list().len();
    }
    n_pts += s.arcs.len() * 3 + s.lines.len() * 2 + texts.len();
    let str_bytes: usize = texts.iter().map(|t| t.content.len()).sum();
    let words = s.fills.len() * 6 + s.outlines.len() * 8 + s.polylines.len() * 9 + s.arcs.len() * 7 + s.lines.len() * 7 + texts.len() * 8;
    let total = 48 + n_pts * 16 + n_dash * 4 + words * 4 + str_bytes;
    let mut pts: Vec<u8> = Vec::with_capacity(n_pts * 16);
    let mut dash: Vec<u8> = Vec::with_capacity(n_dash * 4);
    let mut rec: Vec<u8> = Vec::with_capacity(words * 4);
    let mut strs: Vec<u8> = Vec::with_capacity(str_bytes);
    let pt = |pts: &mut Vec<u8>, p: V2| {
        pts.extend_from_slice(&p.x.to_le_bytes());
        pts.extend_from_slice(&p.y.to_le_bytes());
    };
    let u = |rec: &mut Vec<u8>, v: u32| rec.extend_from_slice(&v.to_le_bytes());
    let f = |rec: &mut Vec<u8>, v: f64| rec.extend_from_slice(&(v as f32).to_le_bytes());
    let col = |rec: &mut Vec<u8>, c: &Rgba| {
        for &v in c {
            rec.extend_from_slice(&(v as f32).to_le_bytes());
        }
    };
    let dashes = |dash: &mut Vec<u8>, d: &SDash| -> u32 {
        let l = d.list();
        for &v in l {
            dash.extend_from_slice(&(v as f32).to_le_bytes());
        }
        l.len() as u32
    };
    for x in &s.fills {
        u(&mut rec, x.pts.len() as u32);
        u(&mut rec, u32_of(x.z));
        col(&mut rec, &x.color);
        for &p in &x.pts {
            pt(&mut pts, p);
        }
    }
    for x in &s.outlines {
        u(&mut rec, x.pts.len() as u32);
        u(&mut rec, u32_of(x.z));
        f(&mut rec, x.width_mm);
        let n = dashes(&mut dash, &x.dash);
        u(&mut rec, n);
        col(&mut rec, &x.color);
        for &p in &x.pts {
            pt(&mut pts, p);
        }
    }
    for x in &s.polylines {
        u(&mut rec, x.pts.len() as u32);
        u(&mut rec, u32_of(x.z));
        f(&mut rec, x.width_mm);
        let n = dashes(&mut dash, &x.dash);
        u(&mut rec, n);
        u(&mut rec, x.width_screen as u32);
        col(&mut rec, &x.color);
        for &p in &x.pts {
            pt(&mut pts, p);
        }
    }
    for a in &s.arcs {
        f(&mut rec, a.r);
        f(&mut rec, a.width_mm);
        let n = dashes(&mut dash, &a.dash);
        u(&mut rec, n);
        col(&mut rec, &a.color);
        pt(&mut pts, a.center);
        pt(&mut pts, a.from);
        pt(&mut pts, a.to);
    }
    for l in &s.lines {
        f(&mut rec, l.width_mm);
        let n = dashes(&mut dash, &l.dash);
        u(&mut rec, n);
        u(&mut rec, u32_of(l.z));
        col(&mut rec, &l.color);
        pt(&mut pts, l.a);
        pt(&mut pts, l.b);
    }
    for t in texts {
        f(&mut rec, t.size_mm);
        u(&mut rec, t.align);
        u(&mut rec, strs.len() as u32);
        u(&mut rec, t.content.len() as u32);
        col(&mut rec, &t.color);
        pt(&mut pts, t.pos);
        strs.extend_from_slice(&t.content);
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"DR2S");
    for v in [1u32, s.fills.len() as u32, s.outlines.len() as u32, s.polylines.len() as u32, s.arcs.len() as u32, s.lines.len() as u32, texts.len() as u32, n_pts as u32, n_dash as u32, str_bytes as u32, 0] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&pts);
    out.extend_from_slice(&dash);
    out.extend_from_slice(&rec);
    out.extend_from_slice(&strs);
    out
}

fn push_dash(out: &mut Vec<f64>, d: &SDash) {
    match d {
        SDash::Absent => out.push(-2.0),
        SDash::Null => out.push(-1.0),
        SDash::List(l) => {
            out.push(l.len() as f64);
            out.extend_from_slice(l);
        }
    }
}

/// Verlustfreie Ausgabe (Format s. Dateikopf).
pub fn encode_scene_f64(s: &Scene) -> Vec<f64> {
    let mut out = vec![s.fills.len() as f64, s.outlines.len() as f64, s.polylines.len() as f64, s.arcs.len() as f64, s.lines.len() as f64];
    for x in &s.fills {
        out.extend_from_slice(&[x.pts.len() as f64, x.z]);
        out.extend_from_slice(&x.color);
        for p in &x.pts {
            out.extend_from_slice(&[p.x, p.y]);
        }
    }
    for x in s.outlines.iter().chain(&s.polylines) {
        out.extend_from_slice(&[x.pts.len() as f64, x.z, x.width_mm]);
        push_dash(&mut out, &x.dash);
        out.extend_from_slice(&x.color);
        for p in &x.pts {
            out.extend_from_slice(&[p.x, p.y]);
        }
    }
    for a in &s.arcs {
        out.extend_from_slice(&[a.r, a.width_mm]);
        push_dash(&mut out, &a.dash);
        out.extend_from_slice(&a.color);
        out.extend_from_slice(&[a.center.x, a.center.y, a.from.x, a.from.y, a.to.x, a.to.y]);
    }
    for l in &s.lines {
        out.extend_from_slice(&[l.z, l.width_mm]);
        push_dash(&mut out, &l.dash);
        out.extend_from_slice(&l.color);
        out.extend_from_slice(&[l.a.x, l.a.y, l.b.x, l.b.y]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn farben_wie_to_rgba() {
        assert_eq!(to_rgba(Some("#fff")), Some([1.0, 1.0, 1.0, 1.0]));
        assert_eq!(to_rgba(Some(" Black ")), Some([0.0, 0.0, 0.0, 1.0]));
        assert_eq!(to_rgba(Some("none")), None);
        assert_eq!(to_rgba(Some("")), None);
        assert_eq!(to_rgba(None), None);
        assert_eq!(to_rgba(Some("rgb(1,2,3)")), Some([0.0, 0.0, 0.0, 1.0]));
        assert_eq!(to_rgba(Some("#12345")), Some([0.0, 0.0, 0.0, 1.0]));
        assert_eq!(to_rgba(Some("#zz0000")), Some([0.0, 0.0, 0.0, 1.0]));
        let c = to_rgba(Some("#ff000080")).unwrap();
        assert_eq!(c[3], 128.0 / 255.0);
    }

    /// Beispielszene; MUSS mit `sample()` in `render2d/src/scene_bin.rs` übereinstimmen
    /// (gemeinsame Bytes: `render2d/tests/fixtures/scene_v1.bin`).
    fn sample() -> (Scene, Vec<SText>) {
        let st = |pts: Vec<V2>, color: Rgba, width_mm: f64, dash: SDash, z: f64, width_screen: bool| SStroke { pts, color, width_mm, dash, z, width_screen };
        let s = Scene {
            fills: vec![
                SFill { pts: vec![v2(0.0, 0.0), v2(4.0, 0.0), v2(4.0, 3.0)], color: [0.5, 0.25, 0.75, 1.0], z: 0.0 },
                SFill { pts: vec![v2(1.5, 1.5), v2(2.5, 1.5), v2(2.5, 2.5), v2(1.5, 2.5)], color: [1.0, 1.0, 1.0, 0.5], z: 7.0 },
            ],
            outlines: vec![st(vec![v2(0.0, 0.0), v2(4.0, 0.0), v2(4.0, 3.0)], [0.0, 0.0, 0.0, 1.0], 0.25, SDash::List(vec![2.0, 1.0]), 1.0, false)],
            polylines: vec![
                st(vec![v2(0.0, 0.0), v2(1.0, 1.0)], [0.25, 0.25, 0.25, 1.0], 0.5, SDash::Null, 2.0, false),
                st(vec![v2(5.0, 5.0), v2(6.0, 5.0), v2(6.0, 6.0)], [0.5, 0.5, 0.5, 1.0], 1.0, SDash::List(vec![1.0]), 3.0, true),
            ],
            arcs: vec![SArc { center: v2(1.0, 1.0), from: v2(2.0, 1.0), to: v2(1.0, 2.0), r: 1.0, color: [1.0, 0.0, 0.0, 1.0], width_mm: 0.125, dash: SDash::Absent }],
            lines: vec![SLine { a: v2(0.0, 0.0), b: v2(2600000.5, 1200000.25), color: [0.0, 0.5, 0.0, 1.0], width_mm: 0.35, dash: SDash::List(vec![3.0, 1.0, 0.5, 1.0]), z: 4.0 }],
        };
        let t = |x: f64, y: f64, content: &str, size_mm: f64, color: Rgba, align: u32| SText { pos: v2(x, y), size_mm, color, align, content: content.as_bytes().to_vec() };
        let texts = vec![
            t(1.0, 2.0, "Küche 12,5 m²", 2.5, [0.0, 0.0, 0.0, 1.0], 1),
            t(3.0, 4.0, "", 2.0, [0.0, 0.0, 0.0, 1.0], 2),
            t(5.0, 6.0, "A", 1.0, [0.0, 0.0, 1.0, 1.0], 0),
        ];
        (s, texts)
    }

    #[test]
    fn szene_bin_wie_fixture() {
        const FIXTURE: &[u8] = include_bytes!("../../render2d/tests/fixtures/scene_v1.bin");
        let (s, t) = sample();
        assert_eq!(encode_scene_bin(&s, &t), FIXTURE);
        // Leere Szene = reiner Kopf; Landeskoordinaten bleiben f64.
        assert_eq!(encode_scene_bin(&Scene::default(), &[]).len(), 48);
        let mut l = Scene::default();
        l.lines.push(SLine { a: v2(2600000.123456, 1200000.654321), b: v2(0.0, 0.0), color: [0.0; 4], width_mm: 0.1, dash: SDash::Null, z: 0.0 });
        let b = encode_scene_bin(&l, &[]);
        assert_eq!(f64::from_le_bytes(b[48..56].try_into().unwrap()), 2600000.123456);
    }

    #[test]
    fn kantenlaeufe_und_naht() {
        let sq = vec![v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0), v2(0.0, 1.0)];
        // Kante 3 (0,1)→(0,0) unterdrückt: ein Lauf über drei Kanten.
        let runs = visible_edge_runs(&sq, &[3.0]);
        assert_eq!(runs, vec![vec![v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0), v2(0.0, 1.0)]]);
        assert!(visible_edge_runs(&sq, &[0.0, 1.0, 2.0, 3.0]).is_empty());
        // Zwei Läufe, die sich zu einem Ring schliessen.
        let a = vec![v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0)];
        let b = vec![v2(1.0, 1.0), v2(0.0, 1.0), v2(0.0, 0.0)];
        let s = stitch_runs(vec![a, b]);
        assert_eq!(s.len(), 1);
        assert!(s[0].1);
        assert_eq!(s[0].0.len(), 4);
    }
}
