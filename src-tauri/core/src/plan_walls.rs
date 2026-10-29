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

#[derive(Clone, Copy)]
struct Cutout {
    from: f64,
    to: f64,
    off_a: f64,
    off_b: f64,
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
        span_cutouts.push(Cutout { from: r.num()?, to: r.num()?, off_a: r.num()?, off_b: r.num()? });
    }
    let n_gap = r.count()?;
    let mut gaps = Vec::with_capacity(n_gap);
    for _ in 0..n_gap {
        gaps.push((r.num()?, r.num()?));
    }
    // [103] Schichteinzug (optional): je Leibung und Schicht Rücksprung und Zusatzstücke.
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
        let seg_cutouts: Vec<Cutout> = span_cutouts
            .iter()
            .filter(|c| min(c.from, c.to) < e - CUTOUT_EPS && max(c.from, c.to) > s + CUTOUT_EPS)
            .copied()
            .collect();
        let seg_adj: Vec<&Adj> = adj.iter().filter(|a| (a.dir > 0.0 && (a.jamb - e).abs() < 1e-6) || (a.dir < 0.0 && (a.jamb - s).abs() < 1e-6)).collect();
        if !seg_adj.is_empty() {
            let seg = Seg { s, e, p1, p2, wstart, wend, axis_len, sc, ec };
            adjusted_segment(&mut o, &seg, &thick, ref_off - total / 2.0, &layer_cuts, &seg_cutouts, &seg_adj, &band_join_edges);
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
            let mut band_holes: Vec<(f64, f64)> = Vec::new();
            for c in &seg_cutouts {
                let c_lo = min(c.off_a, c.off_b);
                let c_hi = max(c.off_a, c.off_b);
                if band_lo < c_hi - CUTOUT_EPS && band_hi > c_lo + CUTOUT_EPS {
                    band_holes.push((c.from, c.to));
                }
            }
            for (a, b) in subtract_intervals(s, e, &band_holes) {
                let bsc = if a <= s + CUTOUT_EPS { layer_start_cut } else { None };
                let bec = if b >= e - CUTOUT_EPS { layer_end_cut } else { None };
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
                let mut fuge_holes: Vec<(f64, f64)> = Vec::new();
                for c in &seg_cutouts {
                    let c_lo = min(c.off_a, c.off_b);
                    let c_hi = max(c.off_a, c.off_b);
                    if off >= c_lo - CUTOUT_EPS && off <= c_hi + CUTOUT_EPS {
                        fuge_holes.push((c.from, c.to));
                    }
                }
                for (a, b) in subtract_intervals(s, e, &fuge_holes) {
                    let jsc = if a <= s + CUTOUT_EPS { sc } else { None };
                    let jec = if b >= e - CUTOUT_EPS { ec } else { None };
                    let jq = clipped_band(axis_pt(a), axis_pt(b), off, off, jsc, jec);
                    o.line(LINE_JOINT, li, jq[0], jq[1]);
                }
            }
        }

        let off_lo = ref_off - total / 2.0;
        let off_hi = ref_off + total / 2.0;
        let mut holes_hi: Vec<(f64, f64)> = Vec::new();
        let mut holes_lo: Vec<(f64, f64)> = Vec::new();
        for c in &seg_cutouts {
            if (c.off_a - off_hi).abs() < 1e-6 {
                holes_hi.push((c.from, c.to));
            } else if (c.off_a - off_lo).abs() < 1e-6 {
                holes_lo.push((c.from, c.to));
            }
        }
        let mut outline_no_stroke = band_join_edges.clone();
        if !holes_hi.is_empty() {
            outline_no_stroke.push(2.0);
        }
        if !holes_lo.is_empty() {
            outline_no_stroke.push(0.0);
        }
        o.polygon(ART_OUTLINE, 0, &outline_no_stroke, &clipped_band(p1, p2, off_lo, off_hi, sc, ec));
        let mut near_edge = |edge_off: f64, holes: &[(f64, f64)]| {
            for (a, b) in subtract_intervals(s, e, holes) {
                let nsc = if a <= s + CUTOUT_EPS { sc } else { None };
                let nec = if b >= e - CUTOUT_EPS { ec } else { None };
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

// ── Schichteinzug an Leibungen ([103]) ──────────────────────────────────────

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
