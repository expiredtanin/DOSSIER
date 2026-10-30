//! Wand-Poché und Decken-Umriss im Grundriss ([K3a]): die Geometrie der früheren `generatePlan/walls.ts`
//! und `ceilings.ts` (Segmente zwischen Öffnungen, Gehrungsbänder, Schichtfugen, Durchgangswand-
//! Aussparungen, Verdeckung von Decken-Umrissen durch Wand-Footprints). Stil (Bauteil, Schraffur,
//! Farbe, Strichstärke, Linienstil der Fuge) löst `plan/walls.rs` auf dem Dokument auf und ordnet
//! ihn über den Schichtindex zu ([K3d]).
//!
//! Rechenreihenfolge und Zahlsemantik wie in TS (`Math.hypot` über `jsmath`, `Math.min/max` über
//! `jsnum`), damit die Ausgabe bitgleich bleibt.
//!
//! ## Wand-Poché
//! Eingabe (alles `f64`): `[sx, sy, ex, ey, dicke, refOff, grob (0|1), nurAnsicht (0|1), nSchichten,
//! dicke × n, startCut, endCut, hatLayerCuts, (je Schicht: start, end, startSide, endSide)×n,
//! nAussparungen, (from, to, offA, offB)×m, nLuecken, (from, to)×k]` mit einer Linie als
//! `[vorhanden (0|1), px, py, dx, dy]`.
//!
//! Ausgabe `[n, Eintrag × n]` in Zeichenreihenfolge:
//! ```text
//! 1 polygon  [1, art, schicht, nOhneStrich, kante…, x0,y0 … x3,y3]
//!            art 0 Ansichts-Umriss · 1 Sammelfläche (grob) · 2 Schichtband · 3 Wand-Umriss
//! 2 line     [2, art, schicht, ax, ay, bx, by]
//!            art 0 layer-joint-l · 1 layer-joint · 2 wall-outline
//! ```
//!
//! ## Decken-Umriss
//! [`ceiling_outline_lines`]: freie Teilstücke der Umrisskanten gegen die Wand-Footprints; Aufrufer
//! ist die Decken-Domäne auf dem Dokument (`plan/domains.rs`, [K3d]).

use crate::flat_read::Reader;
use crate::jsmath::hypot2;
use crate::jsnum::{max, min};

pub const CUTOUT_EPS: f64 = 1e-9;

#[derive(Clone, Copy, Debug, PartialEq)]
struct V {
    x: f64,
    y: f64,
}

fn v(x: f64, y: f64) -> V {
    V { x, y }
}
fn sub(a: V, b: V) -> V {
    v(a.x - b.x, a.y - b.y)
}
fn add(a: V, b: V) -> V {
    v(a.x + b.x, a.y + b.y)
}
fn scale(a: V, s: f64) -> V {
    v(a.x * s, a.y * s)
}
fn dot(p: V, q: V) -> f64 {
    p.x * q.x + p.y * q.y
}
fn cross(p: V, q: V) -> f64 {
    p.x * q.y - p.y * q.x
}
fn normalize(a: V) -> V {
    let l = hypot2(a.x, a.y);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    v(a.x / l, a.y / l)
}
fn left_normal(a: V) -> V {
    v(-a.y, a.x)
}
fn along(p1: V, p2: V, d: f64) -> V {
    add(p1, scale(normalize(sub(p2, p1)), d))
}
fn line_intersect(a: V, da: V, b: V, db: V) -> Option<V> {
    let denom = cross(da, db);
    if denom.abs() < 1e-9 {
        return None;
    }
    let t = cross(sub(b, a), db) / denom;
    Some(add(a, scale(da, t)))
}

#[derive(Clone, Copy, Debug)]
struct Line {
    point: V,
    dir: V,
}

fn clipped_band(start: V, end: V, off_a: f64, off_b: f64, sc: Option<Line>, ec: Option<Line>) -> [V; 4] {
    let u = normalize(sub(end, start));
    let n = left_normal(u);
    let edge_start = |off: f64| {
        let base = add(start, scale(n, off));
        match sc {
            None => base,
            Some(c) => line_intersect(base, u, c.point, c.dir).unwrap_or(base),
        }
    };
    let edge_end = |off: f64| {
        let base = add(end, scale(n, off));
        match ec {
            None => base,
            Some(c) => line_intersect(base, u, c.point, c.dir).unwrap_or(base),
        }
    };
    [edge_start(off_a), edge_end(off_a), edge_end(off_b), edge_start(off_b)]
}

/// Loch-Intervalle vom Segment `[s,e]` abziehen (wie `subtractIntervals` in TS).
pub fn subtract_intervals(s: f64, e: f64, holes: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut clipped: Vec<(f64, f64)> = holes
        .iter()
        .map(|&(a, b)| (max(s, min(a, b)), min(e, max(a, b))))
        .filter(|&(a, b)| b > a + CUTOUT_EPS)
        .collect();
    clipped.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut parts = Vec::new();
    let mut cursor = s;
    for (a, b) in clipped {
        if a > cursor + CUTOUT_EPS {
            parts.push((cursor, a));
        }
        if b > cursor {
            cursor = b;
        }
    }
    if cursor < e - CUTOUT_EPS {
        parts.push((cursor, e));
    }
    parts
}

#[derive(Clone, Copy, Debug)]
struct Footprint {
    a: V,
    u: V,
    m: V,
    len: f64,
    half: f64,
    ref_off: f64,
}

fn clip_slab(f0: f64, fd: f64, lo: f64, hi: f64) -> Option<(f64, f64)> {
    if fd.abs() < 1e-12 {
        return if f0 >= lo - CUTOUT_EPS && f0 <= hi + CUTOUT_EPS { Some((0.0, 1.0)) } else { None };
    }
    let mut ta = (lo - f0) / fd;
    let mut tb = (hi - f0) / fd;
    if ta > tb {
        std::mem::swap(&mut ta, &mut tb);
    }
    Some((ta, tb))
}

/// Intervall `[t0,t1] ⊆ [0,1]`, über das `pa→pb` im Wand-Footprint liegt.
fn segment_inside(pa: V, pb: V, fp: &Footprint) -> Option<(f64, f64)> {
    let d = sub(pb, pa);
    let rel = sub(pa, fp.a);
    let su = clip_slab(dot(rel, fp.u), dot(d, fp.u), -fp.half, fp.len + fp.half)?;
    let sm = clip_slab(dot(rel, fp.m), dot(d, fp.m), fp.ref_off - fp.half, fp.ref_off + fp.half)?;
    let t0 = max(max(0.0, su.0), sm.0);
    let t1 = min(min(1.0, su.1), sm.1);
    if t1 > t0 + CUTOUT_EPS {
        Some((t0, t1))
    } else {
        None
    }
}

// ── Decken-Umriss ───────────────────────────────────────────────────────────

/// Wand-Footprint (OBB) für das Verdecken von Decken-Umrissen (`buildWallFootprints` in TS).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WallFootprint {
    pub a: [f64; 2],
    pub u: [f64; 2],
    pub m: [f64; 2],
    pub len: f64,
    pub half: f64,
    pub ref_off: f64,
}

/// Footprint einer Wand aus Achse, Dicke und Referenz-Querversatz.
pub fn wall_footprint(start: [f64; 2], end: [f64; 2], thickness: f64, ref_off: f64) -> WallFootprint {
    let (s, e) = (v(start[0], start[1]), v(end[0], end[1]));
    let u = normalize(sub(e, s));
    let m = left_normal(u);
    WallFootprint { a: start, u: [u.x, u.y], m: [m.x, m.y], len: hypot2(e.x - s.x, e.y - s.y), half: thickness / 2.0, ref_off }
}

/// Freie Teilstücke der Umrisskanten eines Decken-Rings (ohne Brückenkanten), die nicht unter einem
/// Wand-Footprint liegen.
pub fn ceiling_outline_lines(ring: &[[f64; 2]], bridge: &[usize], fps: &[WallFootprint]) -> Vec<[[f64; 2]; 2]> {
    let fps: Vec<Footprint> = fps
        .iter()
        .map(|f| Footprint { a: v(f.a[0], f.a[1]), u: v(f.u[0], f.u[1]), m: v(f.m[0], f.m[1]), len: f.len, half: f.half, ref_off: f.ref_off })
        .collect();
    let ring: Vec<V> = ring.iter().map(|p| v(p[0], p[1])).collect();
    let n = ring.len();
    let mut out = Vec::new();
    for i in 0..n {
        if bridge.contains(&i) {
            continue;
        }
        let a = ring[i];
        let b = ring[(i + 1) % n];
        let holes: Vec<(f64, f64)> = fps.iter().filter_map(|fp| segment_inside(a, b, fp)).collect();
        let d = sub(b, a);
        for (t0, t1) in subtract_intervals(0.0, 1.0, &holes) {
            let p = add(a, scale(d, t0));
            let q = add(a, scale(d, t1));
            out.push([[p.x, p.y], [q.x, q.y]]);
        }
    }
    out
}

// ── Wand-Poché ──────────────────────────────────────────────────────────────

struct LayerCuts {
    start: Vec<Option<Line>>,
    end: Vec<Option<Line>>,
    start_side: Vec<Option<Line>>,
    end_side: Vec<Option<Line>>,
}

/// Nah-Putz-Aussparung (Parallelogramm, s. `joins::SpanCutout`): `from`/`to` auf `off_a`,
/// `from_b`/`to_b` auf `off_b`.
#[derive(Clone, Copy)]
struct Cutout {
    from: f64,
    to: f64,
    off_a: f64,
    off_b: f64,
    from_b: f64,
    to_b: f64,
}

impl Cutout {
    fn lo(&self) -> f64 {
        min(min(self.from, self.to), min(self.from_b, self.to_b))
    }
    fn hi(&self) -> f64 {
        max(max(self.from, self.to), max(self.from_b, self.to_b))
    }
}

/// Loch im Achsmass (auf der Mittellinie eines Bands) samt den schrägen Seitenlinien (Welt) und
/// deren Achsmass-Spanne `(min, max)` über die Banddicke.
#[derive(Clone, Copy)]
struct Hole {
    a: f64,
    b: f64,
    la: Line,
    lb: Line,
    la_rng: (f64, f64),
    lb_rng: (f64, f64),
}

/// Wandrahmen für die Löcher: Start, Achsrichtung, Links-Normale.
#[derive(Clone, Copy)]
struct Frame {
    o: V,
    u: V,
    n: V,
}

impl Frame {
    /// Achsmass, an dem die Gerade `l` die Längslinie im Querversatz `off` trifft.
    fn pos(&self, l: &Line, off: f64) -> Option<f64> {
        let hit = line_intersect(add(self.o, scale(self.n, off)), self.u, l.point, l.dir)?;
        Some(dot(sub(hit, self.o), self.u))
    }
}

/// Löcher der Aussparungen im Band `[lo, hi]` (bei Linien `lo = hi`).
fn holes_at(cs: &[&Cutout], lo: f64, hi: f64, f: Frame) -> Vec<Hole> {
    let pt = |d: f64, o: f64| add(add(f.o, scale(f.u, d)), scale(f.n, o));
    let at = |c: &Cutout, off: f64| {
        let d = c.off_b - c.off_a;
        let t = if d.abs() < 1e-12 { 0.0 } else { (off - c.off_a) / d };
        (c.from + (c.from_b - c.from) * t, c.to + (c.to_b - c.to) * t)
    };
    cs.iter()
        .map(|c| {
            let side = |p: f64, q: f64| {
                let (a, b) = (pt(p, c.off_a), pt(q, c.off_b));
                let dir = sub(b, a);
                // Entartet (off_a = off_b): senkrecht zur Achse.
                Line { point: a, dir: if hypot2(dir.x, dir.y) < 1e-12 { f.n } else { dir } }
            };
            let (x0, x1) = at(c, (lo + hi) / 2.0);
            let ((p0, q0), (p1, q1)) = (at(c, lo), at(c, hi));
            let (rp, rq) = ((min(p0, p1), max(p0, p1)), (min(q0, q1), max(q0, q1)));
            let (l0, l1) = (side(c.from, c.from_b), side(c.to, c.to_b));
            if x0 <= x1 {
                Hole { a: x0, b: x1, la: l0, lb: l1, la_rng: rp, lb_rng: rq }
            } else {
                Hole { a: x1, b: x0, la: l1, lb: l0, la_rng: rq, lb_rng: rp }
            }
        })
        .collect()
}

/// Wie [`subtract_intervals`], aber jedes Teilstück trägt die Schnittlinien an seinen Enden: am
/// Segmentende `s`/`e` `s_cut`/`e_cut`, an einem Loch dessen schräge Seite. Ragt eine schräge
/// Lochseite über ein rechtwinkliges Segmentende ins Band (Knoten-T: Loch auf der Nachbarhälfte),
/// endet das Band an ihr; Teilstücke, deren Enden sich über die Banddicke `[lo, hi]` kreuzen,
/// entfallen (die Nachbarhälfte deckt sie). Gleiche Regeln wie `wall_bands::subtract_spans_cut`.
#[allow(clippy::too_many_arguments)]
fn subtract_holes(s: f64, e: f64, holes: &[Hole], s_cut: Option<Line>, e_cut: Option<Line>, f: Frame, lo: f64, hi: f64) -> Vec<(f64, f64, Option<Line>, Option<Line>)> {
    let (mut s, mut e, mut s_cut, mut e_cut) = (s, e, s_cut, e_cut);
    {
        if let Some(h) = holes.iter().filter(|h| h.a >= e - CUTOUT_EPS && h.la_rng.0 < e - CUTOUT_EPS).min_by(|p, q| p.a.total_cmp(&q.a)) {
            e = h.a;
            e_cut = Some(h.la);
        }
    }
    {
        if let Some(h) = holes.iter().filter(|h| h.b <= s + CUTOUT_EPS && h.lb_rng.1 > s + CUTOUT_EPS).max_by(|p, q| p.b.total_cmp(&q.b)) {
            s = h.b;
            s_cut = Some(h.lb);
        }
    }
    let mut clipped: Vec<Hole> = holes.iter().map(|h| Hole { a: max(s, h.a), b: min(e, h.b), ..*h }).filter(|h| h.b > h.a + CUTOUT_EPS).collect();
    clipped.sort_by(|p, q| p.a.partial_cmp(&q.a).unwrap_or(std::cmp::Ordering::Equal));
    let mut parts = Vec::new();
    let (mut cursor, mut cursor_line) = (s, s_cut);
    for h in clipped {
        if h.a > cursor + CUTOUT_EPS {
            parts.push((cursor, h.a, cursor_line, Some(h.la)));
        }
        if h.b > cursor {
            cursor = h.b;
            cursor_line = Some(h.lb);
        }
    }
    if cursor < e - CUTOUT_EPS {
        parts.push((cursor, e, cursor_line, e_cut));
    }
    if !holes.is_empty() {
        parts.retain(|&(a, b, sc, ec)| {
            [lo, hi].iter().all(|&off| {
                let ps = sc.and_then(|l| f.pos(&l, off)).unwrap_or(a);
                let pe = ec.and_then(|l| f.pos(&l, off)).unwrap_or(b);
                pe > ps + CUTOUT_EPS
            })
        });
    }
    parts
}

fn read_line(r: &mut Reader) -> Option<Option<Line>> {
    let has = r.num()?;
    let (px, py, dx, dy) = (r.num()?, r.num()?, r.num()?, r.num()?);
    Some(if has != 0.0 { Some(Line { point: v(px, py), dir: v(dx, dy) }) } else { None })
}

#[derive(Default)]
struct Out {
    buf: Vec<f64>,
    n: usize,
}

impl Out {
    fn polygon(&mut self, art: f64, layer: usize, no_stroke: &[f64], pts: &[V; 4]) {
        self.n += 1;
        self.buf.extend([1.0, art, layer as f64, no_stroke.len() as f64]);
        self.buf.extend_from_slice(no_stroke);
        for p in pts {
            self.buf.extend([p.x, p.y]);
        }
    }
    fn line(&mut self, art: f64, layer: usize, a: V, b: V) {
        self.n += 1;
        self.buf.extend([2.0, art, layer as f64, a.x, a.y, b.x, b.y]);
    }
}

const ART_VIEW: f64 = 0.0;
const ART_GROB: f64 = 1.0;
const ART_BAND: f64 = 2.0;
const ART_OUTLINE: f64 = 3.0;
const LINE_JOINT_L: f64 = 0.0;
const LINE_JOINT: f64 = 1.0;
const LINE_OUTLINE: f64 = 2.0;

fn join_edges(sc: Option<Line>, ec: Option<Line>) -> Vec<f64> {
    let mut e = Vec::new();
    if ec.is_some() {
        e.push(1.0);
    }
    if sc.is_some() {
        e.push(3.0);
    }
    e
}

pub fn wall_poche(buf: &[f64]) -> Vec<f64> {
    wall_poche_inner(buf).unwrap_or_default()
}

fn wall_poche_inner(buf: &[f64]) -> Option<Vec<f64>> {
    let mut r = Reader::new(buf);
    let (sx, sy, ex, ey) = (r.num()?, r.num()?, r.num()?, r.num()?);
    let (total, ref_off) = (r.num()?, r.num()?);
    let grob = r.num()? != 0.0;
    let view_only = r.num()? != 0.0;
    let n_layers = r.count()?;
    let mut thick = Vec::with_capacity(n_layers);
    for _ in 0..n_layers {
        thick.push(r.num()?);
    }
    let start_cut = read_line(&mut r)?;
    let end_cut = read_line(&mut r)?;
    let has_layer_cuts = r.num()? != 0.0;
    let mut layer_cuts = None;
    if has_layer_cuts {
        let mut lc = LayerCuts { start: vec![], end: vec![], start_side: vec![], end_side: vec![] };
        for _ in 0..n_layers {
            lc.start.push(read_line(&mut r)?);
            lc.end.push(read_line(&mut r)?);
            lc.start_side.push(read_line(&mut r)?);
            lc.end_side.push(read_line(&mut r)?);
        }
        layer_cuts = Some(lc);
    }
    let n_cut = r.count()?;
    let mut span_cutouts = Vec::with_capacity(n_cut);
    for _ in 0..n_cut {
        span_cutouts.push(Cutout { from: r.num()?, to: r.num()?, off_a: r.num()?, off_b: r.num()?, from_b: r.num()?, to_b: r.num()? });
    }
    let n_gap = r.count()?;
    let mut gaps = Vec::with_capacity(n_gap);
    for _ in 0..n_gap {
        gaps.push((r.num()?, r.num()?));
    }
    // [106] Schichteinzug (optional): je Leibung und Schicht Rücksprung und Zusatzstücke.
    let mut adj: Vec<Adj> = Vec::new();
    if let Some(n_adj) = r.count() {
        for _ in 0..n_adj {
            let (jamb, dir, layer, shift) = (r.num()?, r.num()?, r.count()?, r.num()?);
            let n_p = r.count()?;
            let mut pieces = Vec::with_capacity(n_p);
            for _ in 0..n_p {
                pieces.push([r.num()?, r.num()?, r.num()?, r.num()?]);
            }
            if jamb.is_finite() && shift.is_finite() && layer < n_layers && pieces.iter().flatten().all(|v| v.is_finite()) {
                adj.push(Adj { jamb, dir, layer, shift: max(0.0, shift), pieces });
            }
        }
    }
    if !(sx.is_finite() && sy.is_finite() && ex.is_finite() && ey.is_finite() && total.is_finite() && ref_off.is_finite()) {
        return None;
    }

    let wstart = v(sx, sy);
    let wend = v(ex, ey);
    let axis_len = hypot2(ex - sx, ey - sy);
    let mut segments: Vec<(f64, f64)> = Vec::new();
    let mut cursor = 0.0;
    for &(from, to) in &gaps {
        if from > cursor {
            segments.push((cursor, from));
        }
        cursor = max(cursor, to);
    }
    if cursor < axis_len {
        segments.push((cursor, axis_len));
    }

    let mut o = Out::default();
    for &(s, e) in &segments {
        let p1 = along(wstart, wend, s);
        let p2 = along(wstart, wend, e);
        let sc = if s <= 1e-6 { start_cut } else { None };
        let ec = if e >= axis_len - 1e-6 { end_cut } else { None };

        if view_only {
            o.polygon(ART_VIEW, 0, &join_edges(sc, ec), &clipped_band(p1, p2, ref_off - total / 2.0, ref_off + total / 2.0, sc, ec));
            continue;
        }
        if grob {
            o.polygon(ART_GROB, 0, &join_edges(sc, ec), &clipped_band(p1, p2, ref_off - total / 2.0, ref_off + total / 2.0, sc, ec));
            continue;
        }

        let band_join_edges = join_edges(sc, ec);
        let seg_cutouts: Vec<&Cutout> = span_cutouts.iter().filter(|c| c.lo() < e - CUTOUT_EPS && c.hi() > s + CUTOUT_EPS).collect();
        let u_w = normalize(sub(wend, wstart));
        let fr = Frame { o: wstart, u: u_w, n: left_normal(u_w) };
        let seg_adj: Vec<&Adj> = adj.iter().filter(|a| (a.dir > 0.0 && (a.jamb - e).abs() < 1e-6) || (a.dir < 0.0 && (a.jamb - s).abs() < 1e-6)).collect();
        if !seg_adj.is_empty() {
            let seg = Seg { s, e, p1, p2, wstart, wend, axis_len, sc, ec };
            let seg_cut_vals: Vec<Cutout> = seg_cutouts.iter().map(|c| **c).collect();
            adjusted_segment(&mut o, &seg, &thick, ref_off - total / 2.0, &layer_cuts, &seg_cut_vals, &seg_adj, &band_join_edges);
            continue;
        }
        let axis_pt = |d: f64| if d == s { p1 } else if d == e { p2 } else { along(wstart, wend, d) };
        let mut off = ref_off - total / 2.0;
        for li in 0..n_layers {
            let layer_start_cut = if s <= 1e-6 {
                match &layer_cuts {
                    Some(lc) => lc.start[li],
                    None => sc,
                }
            } else {
                None
            };
            let layer_end_cut = if e >= axis_len - 1e-6 {
                match &layer_cuts {
                    Some(lc) => lc.end[li],
                    None => ec,
                }
            } else {
                None
            };
            let band_lo = off;
            let band_hi = off + thick[li];
            let band_cs: Vec<&Cutout> = seg_cutouts
                .iter()
                .filter(|c| band_lo < max(c.off_a, c.off_b) - CUTOUT_EPS && band_hi > min(c.off_a, c.off_b) + CUTOUT_EPS)
                .copied()
                .collect();
            let band_holes = holes_at(&band_cs, band_lo, band_hi, fr);
            for (a, b, bsc, bec) in subtract_holes(s, e, &band_holes, layer_start_cut, layer_end_cut, fr, band_lo, band_hi) {
                o.polygon(ART_BAND, li, &band_join_edges, &clipped_band(axis_pt(a), axis_pt(b), off, off + thick[li], bsc, bec));
            }
            let side_start = if s <= 1e-6 { layer_cuts.as_ref().and_then(|lc| lc.start_side[li]) } else { None };
            let side_end = if e >= axis_len - 1e-6 { layer_cuts.as_ref().and_then(|lc| lc.end_side[li]) } else { None };
            if side_start.is_some() || side_end.is_some() {
                let u_seg = normalize(sub(p2, p1));
                let n_seg = left_normal(u_seg);
                let side_point = |base: V, layer_off: f64, cut: Line| {
                    let pt = add(base, scale(n_seg, layer_off));
                    line_intersect(pt, u_seg, cut.point, cut.dir).unwrap_or(pt)
                };
                if let Some(c) = side_start {
                    o.line(LINE_JOINT_L, li, side_point(p1, off, c), side_point(p1, off + thick[li], c));
                }
                if let Some(c) = side_end {
                    o.line(LINE_JOINT_L, li, side_point(p2, off, c), side_point(p2, off + thick[li], c));
                }
            }
            off += thick[li];
            if li + 1 < n_layers {
                let fuge_cs: Vec<&Cutout> = seg_cutouts
                    .iter()
                    .filter(|c| off >= min(c.off_a, c.off_b) - CUTOUT_EPS && off <= max(c.off_a, c.off_b) + CUTOUT_EPS)
                    .copied()
                    .collect();
                // Fuge neben einer durchlaufenden (verschmolzenen) Schicht: sie trennt diese bis zu
                // ihrem Ende von der Nah-Schicht der Durchgangswand — also bis zum weiter reichenden
                // der beiden Schicht-Schnitte statt nur bis zur Fläche.
                let reach = |own: Option<Line>, pair: [Option<Line>; 2], start: bool| -> Option<Line> {
                    let pos = |l: &Option<Line>| l.as_ref().and_then(|l| fr.pos(l, off));
                    let mut best = own;
                    for l in pair.into_iter().flatten() {
                        let further = match (pos(&Some(l)), pos(&best)) {
                            (Some(p), Some(q)) => (start && p < q - CUTOUT_EPS) || (!start && p > q + CUTOUT_EPS),
                            _ => false,
                        };
                        if further {
                            best = Some(l);
                        }
                    }
                    best
                };
                let (fsc, fec) = match &layer_cuts {
                    Some(lc) => (
                        if s <= 1e-6 { reach(sc, [lc.start[li], lc.start[li + 1]], true) } else { sc },
                        if e >= axis_len - 1e-6 { reach(ec, [lc.end[li], lc.end[li + 1]], false) } else { ec },
                    ),
                    None => (sc, ec),
                };
                for (a, b, jsc, jec) in subtract_holes(s, e, &holes_at(&fuge_cs, off, off, fr), fsc, fec, fr, off, off) {
                    let jq = clipped_band(axis_pt(a), axis_pt(b), off, off, jsc, jec);
                    o.line(LINE_JOINT, li, jq[0], jq[1]);
                }
            }
        }

        let off_lo = ref_off - total / 2.0;
        let off_hi = ref_off + total / 2.0;
        let cs_hi: Vec<&Cutout> = seg_cutouts.iter().filter(|c| (c.off_a - off_hi).abs() < 1e-6).copied().collect();
        let cs_lo: Vec<&Cutout> = seg_cutouts.iter().filter(|c| (c.off_a - off_hi).abs() >= 1e-6 && (c.off_a - off_lo).abs() < 1e-6).copied().collect();
        let holes_hi = holes_at(&cs_hi, off_hi, off_hi, fr);
        let holes_lo = holes_at(&cs_lo, off_lo, off_lo, fr);
        let mut outline_no_stroke = band_join_edges.clone();
        if !holes_hi.is_empty() {
            outline_no_stroke.push(2.0);
        }
        if !holes_lo.is_empty() {
            outline_no_stroke.push(0.0);
        }
        o.polygon(ART_OUTLINE, 0, &outline_no_stroke, &clipped_band(p1, p2, off_lo, off_hi, sc, ec));
        let mut near_edge = |edge_off: f64, holes: &[Hole]| {
            for (a, b, nsc, nec) in subtract_holes(s, e, holes, sc, ec, fr, edge_off, edge_off) {
                let jq = clipped_band(axis_pt(a), axis_pt(b), edge_off, edge_off, nsc, nec);
                o.line(LINE_OUTLINE, 0, jq[0], jq[1]);
            }
        };
        if !holes_hi.is_empty() {
            near_edge(off_hi, &holes_hi);
        }
        if !holes_lo.is_empty() {
            near_edge(off_lo, &holes_lo);
        }
    }
    let mut out = Vec::with_capacity(o.buf.len() + 1);
    out.push(o.n as f64);
    out.extend(o.buf);
    Some(out)
}

// ── Schichteinzug an Leibungen ([106]) ──────────────────────────────────────

/// Anschluss einer Schicht an einer Leibung: `jamb` Achsmass der Rohbaukante, `dir` > 0 ⇒ die
/// Öffnung liegt bei grösserem Achsmass (Segment endet hier), < 0 ⇒ Segment beginnt hier;
/// `pieces` = `[x0, x1, o0, o1]` (x ab Rohbaukante in die Öffnung, o quer ab Aussenfläche).
struct Adj {
    jamb: f64,
    dir: f64,
    layer: usize,
    shift: f64,
    pieces: Vec<[f64; 4]>,
}

struct Seg {
    s: f64,
    e: f64,
    p1: V,
    p2: V,
    wstart: V,
    wend: V,
    axis_len: f64,
    sc: Option<Line>,
    ec: Option<Line>,
}

/// Segment mit Schichteinzug: Schichtbänder je Schicht verkürzt bzw. um Zusatzstücke ergänzt;
/// Umriss und Fugen aus dem Raster der Teilflächen (Kante zwischen Fläche und Leere = Umriss,
/// zwischen zwei Schichten = Fuge, an Aussparungen nichts), Wandenden mit ihrem Gehrungsschnitt.
#[allow(clippy::too_many_arguments)]
fn adjusted_segment(o: &mut Out, g: &Seg, thick: &[f64], off0: f64, layer_cuts: &Option<LayerCuts>, cutouts: &[Cutout], adj: &[&Adj], band_join_edges: &[f64]) {
    let (s, e) = (g.s, g.e);
    let axis_pt = |d: f64| if d == s { g.p1 } else if d == e { g.p2 } else { along(g.wstart, g.wend, d) };
    let n_layers = thick.len();
    let mut offs = vec![off0];
    for t in thick {
        let last = *offs.last().expect("nicht leer");
        offs.push(last + t);
    }
    let (off_lo, off_hi) = (off0, offs[n_layers]);
    let mut rects: Vec<(f64, f64, f64, f64, usize)> = Vec::new();
    for li in 0..n_layers {
        let (mut a, mut b) = (s, e);
        for ad in adj.iter().filter(|ad| ad.layer == li) {
            if ad.dir > 0.0 {
                b = min(b, e - ad.shift);
            } else {
                a = max(a, s + ad.shift);
            }
        }
        let (lo, hi) = (offs[li], offs[li + 1]);
        let holes: Vec<(f64, f64)> = cutouts.iter().filter(|c| lo < max(c.off_a, c.off_b) - CUTOUT_EPS && hi > min(c.off_a, c.off_b) + CUTOUT_EPS).map(|c| (c.from, c.to)).collect();
        let start_cut = if s <= 1e-6 { layer_cuts.as_ref().map_or(g.sc, |lc| lc.start[li]) } else { None };
        let end_cut = if e >= g.axis_len - 1e-6 { layer_cuts.as_ref().map_or(g.ec, |lc| lc.end[li]) } else { None };
        if b - a > CUTOUT_EPS {
            for (pa, pb) in subtract_intervals(a, b, &holes) {
                let bsc = if pa <= s + CUTOUT_EPS { start_cut } else { None };
                let bec = if pb >= e - CUTOUT_EPS { end_cut } else { None };
                o.polygon(ART_BAND, li, band_join_edges, &clipped_band(axis_pt(pa), axis_pt(pb), lo, hi, bsc, bec));
                rects.push((pa, pb, lo, hi, li));
            }
        }
        // Seitenfugen an Wandenden (wie im Normalfall).
        let side_start = if s <= 1e-6 { layer_cuts.as_ref().and_then(|lc| lc.start_side[li]) } else { None };
        let side_end = if e >= g.axis_len - 1e-6 { layer_cuts.as_ref().and_then(|lc| lc.end_side[li]) } else { None };
        let u_seg = normalize(sub(g.p2, g.p1));
        let n_seg = left_normal(u_seg);
        let side_point = |base: V, layer_off: f64, cut: Line| {
            let pt = add(base, scale(n_seg, layer_off));
            line_intersect(pt, u_seg, cut.point, cut.dir).unwrap_or(pt)
        };
        if let Some(c) = side_start {
            o.line(LINE_JOINT_L, li, side_point(g.p1, lo, c), side_point(g.p1, hi, c));
        }
        if let Some(c) = side_end {
            o.line(LINE_JOINT_L, li, side_point(g.p2, lo, c), side_point(g.p2, hi, c));
        }
    }
    for ad in adj {
        for pc in &ad.pieces {
            let (x0, x1) = if ad.dir > 0.0 { (ad.jamb + pc[0], ad.jamb + pc[1]) } else { (ad.jamb - pc[1], ad.jamb - pc[0]) };
            let (y0, y1) = (off0 + pc[2], off0 + pc[3]);
            if x1 - x0 <= CUTOUT_EPS || y1 - y0 <= CUTOUT_EPS {
                continue;
            }
            o.polygon(ART_BAND, ad.layer, &[], &clipped_band(axis_pt(x0), axis_pt(x1), y0, y1, None, None));
            rects.push((x0, x1, y0, y1, ad.layer));
        }
    }
    // Raster der Teilflächen.
    let mut xs: Vec<f64> = vec![s, e];
    let mut ys: Vec<f64> = offs.clone();
    for r in &rects {
        xs.extend([r.0, r.1]);
        ys.extend([r.2, r.3]);
    }
    let sort = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        v.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    };
    sort(&mut xs);
    sort(&mut ys);
    let (nx, ny) = (xs.len().saturating_sub(1), ys.len().saturating_sub(1));
    const EMPTY: i64 = -1;
    const CUT: i64 = -2;
    let mut cell = vec![EMPTY; nx * ny];
    for i in 0..nx {
        let xm = (xs[i] + xs[i + 1]) / 2.0;
        for j in 0..ny {
            let ym = (ys[j] + ys[j + 1]) / 2.0;
            cell[i * ny + j] = match rects.iter().find(|r| xm > r.0 && xm < r.1 && ym > r.2 && ym < r.3) {
                Some(r) => r.4 as i64,
                None if ym > off_lo && ym < off_hi && cutouts.iter().any(|c| xm > min(c.from, c.to) && xm < max(c.from, c.to)) => CUT,
                None => EMPTY,
            };
        }
    }
    let at = |i: i64, j: i64| -> i64 {
        if i < 0 || j < 0 || i as usize >= nx || j as usize >= ny {
            EMPTY
        } else {
            cell[i as usize * ny + j as usize]
        }
    };
    // 0 keine Kante · 1 Umriss · 2+k Fuge der Schicht k.
    let kind = |a: i64, b: i64| -> i64 {
        if a == b || a == CUT || b == CUT {
            0
        } else if a == EMPTY || b == EMPTY {
            1
        } else {
            2 + a.min(b)
        }
    };
    let emit = |o: &mut Out, k: i64, a: V, b: V| {
        if k == 1 {
            o.line(LINE_OUTLINE, 0, a, b);
        } else if k >= 2 {
            o.line(LINE_JOINT, (k - 2) as usize, a, b);
        }
    };
    // Längskanten (entlang der Achse) bei y = ys[j].
    for j in 0..=ny {
        let y = ys[j];
        let mut i = 0;
        while i < nx {
            let k = kind(at(i as i64, j as i64 - 1), at(i as i64, j as i64));
            let mut i1 = i + 1;
            while i1 < nx && kind(at(i1 as i64, j as i64 - 1), at(i1 as i64, j as i64)) == k {
                i1 += 1;
            }
            if k != 0 {
                let (x0, x1) = (xs[i], xs[i1]);
                let sc = if x0 <= s + CUTOUT_EPS { g.sc } else { None };
                let ec = if x1 >= e - CUTOUT_EPS { g.ec } else { None };
                let q = clipped_band(axis_pt(x0), axis_pt(x1), y, y, sc, ec);
                emit(o, k, q[0], q[1]);
            }
            i = i1;
        }
    }
    // Querkanten bei x = xs[i] (an Wandenden mit Gehrung: deren Schnittlinie).
    for i in 0..=nx {
        let x = xs[i];
        let mut j = 0;
        while j < ny {
            let k = kind(at(i as i64 - 1, j as i64), at(i as i64, j as i64));
            let mut j1 = j + 1;
            while j1 < ny && kind(at(i as i64 - 1, j1 as i64), at(i as i64, j1 as i64)) == k {
                j1 += 1;
            }
            if k != 0 {
                let (y0, y1) = (ys[j], ys[j1]);
                if (x - s).abs() < CUTOUT_EPS && g.sc.is_some() {
                    let q = clipped_band(g.p1, g.p2, y0, y1, g.sc, None);
                    emit(o, k, q[0], q[3]);
                } else if (x - e).abs() < CUTOUT_EPS && g.ec.is_some() {
                    let q = clipped_band(g.p1, g.p2, y0, y1, None, g.ec);
                    emit(o, k, q[1], q[2]);
                } else {
                    let base = axis_pt(x);
                    let n = left_normal(normalize(sub(g.wend, g.wstart)));
                    emit(o, k, add(base, scale(n, y0)), add(base, scale(n, y1)));
                }
            }
            j = j1;
        }
    }
    // Keine Umriss-Fläche: nicht jede Ausgabe lässt einzelne Kanten weg (SVG); die Linien oben ersetzen sie.
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_LINE: [f64; 5] = [0.0; 5];

    fn wall(len: f64, grob: bool, gaps: &[(f64, f64)]) -> Vec<f64> {
        let mut b = vec![0.0, 0.0, len, 0.0, 0.3, 0.0, grob as u8 as f64, 0.0, 2.0, 0.1, 0.2];
        b.extend(NO_LINE);
        b.extend(NO_LINE);
        b.extend([0.0, 0.0, gaps.len() as f64]);
        for g in gaps {
            b.extend([g.0, g.1]);
        }
        b
    }

    fn count(out: &[f64], tag: f64) -> usize {
        let (mut i, mut n) = (1, 0);
        for _ in 0..out[0] as usize {
            let t = out[i];
            if t == tag {
                n += 1;
            }
            i += if t == 1.0 { 4 + out[i + 3] as usize + 8 } else { 7 };
        }
        assert_eq!(i, out.len());
        n
    }

    // ── Schräger T-Stoss mit materialbewusster Verschneidung ──────────────────

    enum Prim {
        Poly(f64, usize, Vec<V>),
        Line(f64, V, V),
    }

    fn parse(out: &[f64]) -> Vec<Prim> {
        let (mut i, mut v) = (1, Vec::new());
        for _ in 0..out[0] as usize {
            if out[i] == 1.0 {
                let q = i + 4 + out[i + 3] as usize;
                v.push(Prim::Poly(out[i + 1], out[i + 2] as usize, (0..4).map(|j| super::v(out[q + 2 * j], out[q + 2 * j + 1])).collect()));
                i = q + 8;
            } else {
                v.push(Prim::Line(out[i + 1], super::v(out[i + 3], out[i + 4]), super::v(out[i + 5], out[i + 6])));
                i += 7;
            }
        }
        v
    }

    /// Eingabe wie `encode_wall_poche` (Referenz Mitte) aus Wand und Cuts der Verschneidung.
    fn poche_of(w: &crate::joins::JoinWall, c: &crate::joins::WallCuts) -> Vec<f64> {
        let th: Vec<f64> = w.layers.as_ref().unwrap().iter().map(|l| l.thickness).collect();
        let total: f64 = th.iter().sum();
        let mut b = vec![w.start.x, w.start.y, w.end.x, w.end.y, total, 0.0, 0.0, 0.0, th.len() as f64];
        b.extend(&th);
        let line = |b: &mut Vec<f64>, l: Option<crate::joins::Line>| match l {
            Some(l) => b.extend([1.0, l.point.x, l.point.y, l.dir.x, l.dir.y]),
            None => b.extend(NO_LINE),
        };
        line(&mut b, c.start_cut);
        line(&mut b, c.end_cut);
        match &c.layer_cuts {
            Some(lc) => {
                b.push(1.0);
                for i in 0..th.len() {
                    line(&mut b, lc.start[i]);
                    line(&mut b, lc.end[i]);
                    line(&mut b, lc.start_side[i]);
                    line(&mut b, lc.end_side[i]);
                }
            }
            None => b.push(0.0),
        }
        b.push(c.span_cutouts.len() as f64);
        for k in &c.span_cutouts {
            b.extend([k.from, k.to, k.off_a, k.off_b, k.from_b, k.to_b]);
        }
        b.push(0.0);
        b
    }

    fn inside(poly: &[V], p: V) -> bool {
        // Konvexes Viereck: Punkt strikt innen (1e-7), beliebiger Umlaufsinn.
        let mut sgn = 0.0;
        for i in 0..poly.len() {
            let c = cross(sub(poly[(i + 1) % poly.len()], poly[i]), sub(p, poly[i]));
            if c.abs() < 1e-7 {
                return false;
            }
            if sgn == 0.0 {
                sgn = c.signum();
            } else if c.signum() != sgn {
                return false;
            }
        }
        true
    }

    #[test]
    fn schraeger_t_stoss_grundriss_exakt_15_bis_165_grad() {
        use crate::joins::{compute_joins, JoinLayer, JoinWall, Reference};
        let lay = || vec![JoinLayer { thickness: 0.02, component: Some(0), priority: 10.0 }, JoinLayer { thickness: 0.16, component: Some(1), priority: 20.0 }, JoinLayer { thickness: 0.15, component: Some(2), priority: 50.0 }, JoinLayer { thickness: 0.015, component: Some(3), priority: 10.0 }];
        let jw = |s: (f64, f64), e: (f64, f64)| JoinWall { start: kernel2d::Vec2::new(s.0, s.1), end: kernel2d::Vec2::new(e.0, e.1), reference: Reference::Center, layers: Some(lay()) };
        let face = 0.345 / 2.0;
        let merge = face - 0.015;
        for deg in (15..=165).step_by(15) {
            let th = (deg as f64).to_radians();
            let b1 = (5.0 + 3.0 * th.cos(), 3.0 * th.sin());
            // Mittelspannen-T und Knoten-T (Durchgang aus zwei Hälften).
            for walls in [vec![jw((0.0, 0.0), (10.0, 0.0)), jw((5.0, 0.0), b1)], vec![jw((0.0, 0.0), (5.0, 0.0)), jw((5.0, 0.0), (10.0, 0.0)), jw((5.0, 0.0), b1)]] {
            let deg = format!("{deg}° ({} Wände)", walls.len());
            let bi = walls.len() - 1;
            let cuts = compute_joins(&walls).unwrap();
            let thr: Vec<Prim> = (0..bi).flat_map(|i| parse(&wall_poche(&poche_of(&walls[i], &cuts[i])))).collect();
            let br = parse(&wall_poche(&poche_of(&walls[bi], &cuts[bi])));
            // Wahre Kreuzung der Kern-Kanten (Backstein, quer 0.0075 … 0.1575) mit Fläche und Rückgrat.
            let x_at = |o: f64, f: f64| {
                let t = (f - o * th.cos()) / th.sin();
                5.0 - o * th.sin() + t * th.cos()
            };
            let (xa0, xa1) = (x_at(0.0075, face).min(x_at(0.1575, face)), x_at(0.0075, face).max(x_at(0.1575, face)));
            let (xb0, xb1) = (x_at(0.0075, merge).min(x_at(0.1575, merge)), x_at(0.0075, merge).max(x_at(0.1575, merge)));

            // (1) Flächenlinie der Durchgangswand: Lücke genau über der Kern-Kreuzung.
            let face_lines: Vec<(f64, f64)> = thr
                .iter()
                .filter_map(|p| match p {
                    Prim::Line(a, p, q) if *a == LINE_OUTLINE && (p.y - face).abs() < 1e-9 => Some((p.x.min(q.x), p.x.max(q.x))),
                    _ => None,
                })
                .collect();
            let on_face = |x: f64| face_lines.iter().any(|&(a, b)| a <= x && x <= b);
            assert!(face_lines.iter().any(|l| (l.1 - xa0).abs() < 1e-9) && face_lines.iter().any(|l| (l.0 - xa1).abs() < 1e-9), "{deg} {face_lines:?} {xa0} {xa1}");
            assert!(on_face(xa0 - 1e-4) && on_face(xa1 + 1e-4) && !on_face((xa0 + xa1) / 2.0), "{deg} {face_lines:?}");

            // (2) Umriss des Abzweigs endet genau auf der Fläche.
            let outline = br.iter().find_map(|p| match p {
                Prim::Poly(a, _, pts) if *a == ART_OUTLINE => Some(pts.clone()),
                _ => None,
            });
            let o = outline.unwrap();
            assert!((o[0].y - face).abs() < 1e-9 && (o[3].y - face).abs() < 1e-9, "{deg}° {:?}", o);

            // (3) Kern-Band des Abzweigs endet auf der Rückgrat-Fläche, genau an den Lochseiten.
            let core = br.iter().find_map(|p| match p {
                Prim::Poly(a, 2, pts) if *a == ART_BAND => Some(pts.clone()),
                _ => None,
            });
            let c = core.unwrap();
            let mut ends = [c[0].x, c[3].x];
            ends.sort_by(|a, b| a.partial_cmp(b).unwrap());
            assert!((c[0].y - merge).abs() < 1e-9 && (c[3].y - merge).abs() < 1e-9, "{deg}°");
            assert!((ends[0] - xb0).abs() < 1e-9 && (ends[1] - xb1).abs() < 1e-9, "{deg}° {ends:?} {xb0} {xb1}");
            // Fugen beidseits des Kerns laufen bis zur Rückgrat-Fläche (Kern gegen Nah-Putz), die
            // übrige bleibt an der Fläche.
            let joints: Vec<f64> = br
                .iter()
                .filter_map(|p| match p {
                    Prim::Line(a, p, q) if *a == LINE_JOINT => Some(p.y.min(q.y)),
                    _ => None,
                })
                .collect();
            assert_eq!(joints.len(), 3, "{deg}");
            assert!((joints[0] - face).abs() < 1e-9 && (joints[1] - merge).abs() < 1e-9 && (joints[2] - merge).abs() < 1e-9, "{deg} {joints:?}");

            // (4) Keine Schraffur der Durchgangswand im Kern des Abzweigs, keine Linie quer durch die Lücke.
            // Mitte des Lochs und nahe seiner beiden schrägen Seiten (auf halber Putzdicke).
            let (l, r) = ((xa0 + xb0) / 2.0, (xa1 + xb1) / 2.0);
            let probes = [super::v((l + r) / 2.0, (face + merge) / 2.0), super::v(l * 0.97 + r * 0.03, (face + merge) / 2.0), super::v(l * 0.03 + r * 0.97, (face + merge) / 2.0)];
            for p in thr.iter() {
                if let Prim::Poly(a, _, pts) = p {
                    if *a == ART_BAND {
                        for q in &probes {
                            assert!(!inside(pts, *q), "{deg}° Band der Durchgangswand deckt {q:?}");
                        }
                    }
                }
                if let Prim::Line(_, p, q) = p {
                    for y in [face, merge] {
                        if (p.y - y).abs() < 1e-9 && (q.y - y).abs() < 1e-9 {
                            let (g0, g1) = if y == face { (xa0, xa1) } else { (xb0, xb1) };
                            let m = (g0 + g1) / 2.0;
                            assert!(!(p.x.min(q.x) < m && p.x.max(q.x) > m), "{deg}° Linie quer durch die Lücke bei y={y}");
                        }
                    }
                }
            }
            }
        }
    }

    #[test]
    fn intervalle_abziehen() {
        assert_eq!(subtract_intervals(0.0, 5.0, &[]), vec![(0.0, 5.0)]);
        assert_eq!(subtract_intervals(0.0, 5.0, &[(1.0, 2.0), (1.5, 3.0)]), vec![(0.0, 1.0), (3.0, 5.0)]);
        assert!(subtract_intervals(0.0, 5.0, &[(-1.0, 9.0)]).is_empty());
    }

    #[test]
    fn wand_ohne_luecke_hat_zwei_baender_fuge_und_umriss() {
        let o = wall_poche(&wall(4.0, false, &[]));
        assert_eq!(count(&o, 1.0), 3); // 2 Bänder + Umriss
        assert_eq!(count(&o, 2.0), 1); // 1 Fuge
    }

    #[test]
    fn luecke_teilt_die_wand_in_zwei_segmente() {
        let o = wall_poche(&wall(4.0, false, &[(1.0, 2.0)]));
        assert_eq!(count(&o, 1.0), 6);
        assert_eq!(count(&wall_poche(&wall(4.0, true, &[(1.0, 2.0)])), 1.0), 2);
    }

    /// Polygone (art, schicht, Ecken) der Ausgabe.
    fn polys(out: &[f64]) -> Vec<(f64, usize, Vec<(f64, f64)>)> {
        let (mut i, mut v) = (1, Vec::new());
        for _ in 0..out[0] as usize {
            if out[i] == 1.0 {
                let q = i + 4 + out[i + 3] as usize;
                v.push((out[i + 1], out[i + 2] as usize, (0..4).map(|k| (out[q + 2 * k], out[q + 2 * k + 1])).collect()));
                i = q + 8;
            } else {
                i += 7;
            }
        }
        v
    }

    #[test]
    fn schichteinzug_kuerzt_band_und_setzt_stueck() {
        let mut b = wall(4.0, false, &[(1.0, 2.0)]);
        // Innere Schicht (1) an der Leibung bei 1.0 um 5 cm zurück; äussere (0) bei 2.0 3 cm über den Rahmen.
        b.extend([2.0, 1.0, 1.0, 1.0, 0.05, 0.0, 2.0, -1.0, 0.0, 0.0, 1.0, 0.0, 0.03, 0.0, 0.1]);
        let o = wall_poche(&b);
        let p = polys(&o);
        let band1: Vec<_> = p.iter().filter(|x| x.0 == ART_BAND && x.1 == 1).collect();
        assert!(band1.iter().any(|x| x.2.iter().any(|q| (q.0 - 0.95).abs() < 1e-9)));
        // Zusatzstück der äusseren Schicht in der Öffnung (x 1.97 … 2.0).
        assert!(p.iter().any(|x| x.0 == ART_BAND && x.1 == 0 && x.2.iter().any(|q| (q.0 - 1.97).abs() < 1e-9)));
        // Umriss als Linien, Stufe am Rücksprung (Querlinie bei x = 0.95).
        let mut i = 1;
        let mut step = false;
        for _ in 0..o[0] as usize {
            if o[i] == 1.0 {
                i += 4 + o[i + 3] as usize + 8;
            } else {
                if o[i + 1] == LINE_OUTLINE && (o[i + 3] - 0.95).abs() < 1e-9 && (o[i + 5] - 0.95).abs() < 1e-9 {
                    step = true;
                }
                i += 7;
            }
        }
        assert!(step);
        // Ohne Block wie bisher.
        assert_eq!(count(&wall_poche(&wall(4.0, false, &[(1.0, 2.0)])), 1.0), 6);
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(wall_poche(&[1.0, 2.0]).is_empty());
        let mut b = wall(4.0, false, &[]);
        b[0] = f64::NAN;
        assert!(wall_poche(&b).is_empty());
    }

    #[test]
    fn decken_umriss_wird_von_wand_verdeckt() {
        // Quadrat 4×4, Wand entlang der unteren Kante (Mitte y=0, Dicke 0.4)
        let ring = [[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]];
        let fp = wall_footprint([0.0, 0.0], [4.0, 0.0], 0.4, 0.0);
        assert_eq!(fp, WallFootprint { a: [0.0, 0.0], u: [1.0, 0.0], m: [0.0, 1.0], len: 4.0, half: 0.2, ref_off: 0.0 });
        let o = ceiling_outline_lines(&ring, &[], &[fp]);
        assert_eq!(o.len(), 3); // untere Kante entfällt, drei freie Kanten
        // Brückenkanten werden nie gestrichen.
        assert_eq!(ceiling_outline_lines(&ring, &[1], &[fp]).len(), 2);
    }
}
