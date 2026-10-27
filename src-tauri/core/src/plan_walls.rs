//! Wand-Poché und Decken-Umriss im Grundriss ([K3a]): die Geometrie von `generatePlan/walls.ts`
//! und `ceilings.ts` (Segmente zwischen Öffnungen, Gehrungsbänder, Schichtfugen, Durchgangswand-
//! Aussparungen, Verdeckung von Decken-Umrissen durch Wand-Footprints). Stil (Bauteil, Schraffur,
//! Farbe, Strichstärke, Linienstil der Fuge) löst TS aus dem Modell auf und ordnet ihn über den
//! Schichtindex zu — das Modell bleibt bis [K4] in TS.
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
//! Eingabe `[nRing, x, y …, nBruecken, kante…, nFootprints, (ax, ay, ux, uy, mx, my, len, half,
//! refOff)×n]`; Ausgabe `[n, ax, ay, bx, by …]` (freie Teilstücke der Umrisskanten).

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

pub fn ceiling_outline(buf: &[f64]) -> Vec<f64> {
    (|| {
        let mut r = Reader::new(buf);
        let ring: Vec<V> = r.ring()?.into_iter().map(|p| v(p[0], p[1])).collect();
        let n_bridge = r.count()?;
        let mut bridge = Vec::with_capacity(n_bridge);
        for _ in 0..n_bridge {
            bridge.push(r.num()?);
        }
        let n_fp = r.count()?;
        let mut fps = Vec::with_capacity(n_fp);
        for _ in 0..n_fp {
            let a = [r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?];
            fps.push(Footprint { a: v(a[0], a[1]), u: v(a[2], a[3]), m: v(a[4], a[5]), len: a[6], half: a[7], ref_off: a[8] });
        }
        let n = ring.len();
        let mut lines: Vec<f64> = Vec::new();
        let mut count = 0usize;
        for i in 0..n {
            if bridge.contains(&(i as f64)) {
                continue;
            }
            let a = ring[i];
            let b = ring[(i + 1) % n];
            let holes: Vec<(f64, f64)> = fps.iter().filter_map(|fp| segment_inside(a, b, fp)).collect();
            let d = sub(b, a);
            for (t0, t1) in subtract_intervals(0.0, 1.0, &holes) {
                let p = add(a, scale(d, t0));
                let q = add(a, scale(d, t1));
                lines.extend([p.x, p.y, q.x, q.y]);
                count += 1;
            }
        }
        let mut out = vec![count as f64];
        out.extend(lines);
        Some(out)
    })()
    .unwrap_or_default()
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

    #[test]
    fn unsinn_ohne_panic() {
        assert!(wall_poche(&[1.0, 2.0]).is_empty());
        let mut b = wall(4.0, false, &[]);
        b[0] = f64::NAN;
        assert!(wall_poche(&b).is_empty());
        assert!(ceiling_outline(&[3.0, 0.0]).is_empty());
    }

    #[test]
    fn decken_umriss_wird_von_wand_verdeckt() {
        // Quadrat 4×4, Wand entlang der unteren Kante (Mitte y=0, Dicke 0.4)
        let mut b = vec![4.0, 0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0, 0.0, 1.0];
        b.extend([0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 4.0, 0.2, 0.0]);
        let o = ceiling_outline(&b);
        assert_eq!(o[0], 3.0); // untere Kante entfällt, drei freie Kanten
    }
}
