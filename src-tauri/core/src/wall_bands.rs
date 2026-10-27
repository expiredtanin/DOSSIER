//! Wand-Schichtbänder für 3D/STL/OBJ/IFC: zerlegt EINE Wand in quer zur Dicke gestapelte
//! Materialbänder und schneidet daraus achsparallele Körper — mit Gehrungs-/Anschluss-Cuts
//! (aus [`crate::joins`]), Nah-Putz-Aussparungen der Durchgangswand, Decken-Dominanz pro Schicht,
//! Öffnungs-Löchern und schräger Oberkante unter Dachflächen (`top_drop`). Portiert aus
//! `src/plan/toWalls3d/bands.ts`; dort bleiben das Sammeln aus dem `Project` (Wandtyp, Öffnungen,
//! Decken-/Dachaufbau, Höhen) und die Darstellungs-Metadaten (Farbe, Schraffur, Material).
//!
//! Zwei Pfade wie in TS: `layered` (3D-Viewer: ein Körper je Band über die volle Achse, Öffnungen
//! als Löcher) und Schnitt-Eingabe (Pfeiler/Brüstung/Sturz-Segmente ohne Löcher).

use crate::joins::{js_hypot, reference_offset, Line, Reference, WallCuts};
use crate::roof::roof_underside_at;
use kernel2d::{add, dot, left_normal, line_intersect, point_in_outline, scale, sub, Vec2};

/// Toleranz der Wand-Ableitung (`EPS` in `toWalls3d/shared.ts`).
pub const EPS: f64 = 1e-4;
/// Schrittweite (Meter) der Dach-Unterkanten-Abtastung.
const ROOF_CLIP_STEP: f64 = 0.15;

/// Ein Schicht-Band: Dicke und Verschneidungs-Rang (`None`: keine Decken-Subtraktion).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BandIn {
    pub thickness: f64,
    pub priority: Option<f64>,
}

/// Eine Öffnung der Wand: Achsen-Intervall (Meter ab Wandstart), absolute z-Ausdehnung und ob
/// die innerste Schicht an der Laibung zurückspringt (`WindowType.innerLayerRecess`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OpeningIn {
    pub from: f64,
    pub to: f64,
    pub z_bottom: f64,
    pub z_top: f64,
    pub recess_inner_layer: bool,
}

/// Eine Decke desselben Geschosses: z-Ausdehnung, Umriss, Schichten (Dicke, Rang; `None` =
/// Bauteil unbekannt). `layers = None`: Deckentyp unbekannt.
#[derive(Clone, Debug, PartialEq)]
pub struct CeilingIn {
    pub z_bottom: f64,
    pub z_top: f64,
    pub outline: Vec<Vec2>,
    pub layers: Option<Vec<(f64, Option<f64>)>>,
}

/// Ein Dach desselben Geschosses: Traufhöhe, Summe der Schichtdicken, Traufe-Umriss, Flächen.
#[derive(Clone, Debug, PartialEq)]
pub struct RoofIn {
    pub eaves_z: f64,
    pub total_thickness: f64,
    pub eaves: Vec<[f64; 2]>,
    pub planes: Vec<Vec<[f64; 3]>>,
}

/// Terminierung am Deckenanschluss (`Wall.sliceTermination`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Termination {
    Both,
    Below,
    Above,
}

/// Eine Wand mit allem, was die Bänder brauchen.
#[derive(Clone, Debug, PartialEq)]
pub struct WallIn {
    pub start: Vec2,
    pub end: Vec2,
    pub z_bottom: f64,
    pub z_top: f64,
    pub layered: bool,
    /// `true`: Bänder sind die Wandschichten (Versätze gestapelt); `false`: EIN Band über die
    /// ganze Dicke, Versatz = Referenzversatz.
    pub stacked: bool,
    pub reference: Reference,
    /// Wanddicke für die grobe Grundriss-Hülle (Decken-Vorfilter).
    pub thickness_safe: f64,
    pub termination: Termination,
    pub bands: Vec<BandIn>,
    pub openings: Vec<OpeningIn>,
    pub cuts: WallCuts,
}

/// Decken und Dächer eines Geschosses — einmal je Geschoss gelesen, für alle seine Wände; die
/// Grundriss-Hüllen werden dabei vorab bestimmt.
#[derive(Clone, Debug, Default)]
pub struct FloorContext {
    ceilings: Vec<(CeilingIn, Bounds)>,
    roofs: Vec<(RoofIn, Bounds)>,
}

impl FloorContext {
    pub fn new(ceilings: Vec<CeilingIn>, roofs: Vec<RoofIn>) -> Self {
        FloorContext {
            ceilings: ceilings
                .into_iter()
                .map(|c| {
                    let b = outline_bounds(c.outline.iter().map(|p| (p.x, p.y)));
                    (c, b)
                })
                .collect(),
            roofs: roofs
                .into_iter()
                .map(|r| {
                    let b = outline_bounds(r.eaves.iter().map(|p| (p[0], p[1])));
                    (r, b)
                })
                .collect(),
        }
    }
}

/// Ein Wandkörper: Band-Index, Achse (versetzt), z-Bereich, Absenkung der Oberkante am
/// Anfang/Ende (`None` = flach), Löcher `[from, to, zBottom, zTop]` relativ zum Körper-Start.
#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub band: usize,
    pub start: Vec2,
    pub end: Vec2,
    pub z_bottom: f64,
    pub z_top: f64,
    pub top_drop: Option<[f64; 2]>,
    pub holes: Vec<[f64; 4]>,
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

fn wall_bounds(w: &WallIn, half: f64) -> Bounds {
    Bounds {
        min_x: w.start.x.min(w.end.x) - half,
        max_x: w.start.x.max(w.end.x) + half,
        min_y: w.start.y.min(w.end.y) - half,
        max_y: w.start.y.max(w.end.y) + half,
    }
}

fn outline_bounds(pts: impl Iterator<Item = (f64, f64)>) -> Bounds {
    let mut b = Bounds { min_x: f64::INFINITY, max_x: f64::NEG_INFINITY, min_y: f64::INFINITY, max_y: f64::NEG_INFINITY };
    for (x, y) in pts {
        if x < b.min_x {
            b.min_x = x;
        }
        if x > b.max_x {
            b.max_x = x;
        }
        if y < b.min_y {
            b.min_y = y;
        }
        if y > b.max_y {
            b.max_y = y;
        }
    }
    b
}

fn bounds_overlap(a: Bounds, b: Bounds) -> bool {
    a.min_x <= b.max_x + EPS && a.max_x >= b.min_x - EPS && a.min_y <= b.max_y + EPS && a.max_y >= b.min_y - EPS
}

/// Decken-„Cutter": z-Band einer Deckenschicht, ihr Rang und der Decken-Umriss.
struct Cutter<'a> {
    z_bottom: f64,
    z_top: f64,
    priority: f64,
    outline: &'a [Vec2],
}

/// Decken, die die Wand pro Schicht einschneiden: dasselbe Geschoss (Aufrufer), vertikale
/// Überlappung, grober Grundriss-Überlapp; je Deckenschicht ein eigener Cutter (proportional auf
/// die Decken-z-Spanne verteilt, oben → unten), sonst einer über die volle Höhe mit dem höchsten
/// Rang.
fn ceiling_cutters<'a>(w: &WallIn, ctx: &'a FloorContext) -> Vec<Cutter<'a>> {
    let wb = wall_bounds(w, w.thickness_safe / 2.0);
    let mut out = Vec::new();
    for (c, cb) in &ctx.ceilings {
        if c.outline.len() < 3 {
            continue;
        }
        if c.z_bottom >= w.z_top - EPS || c.z_top <= w.z_bottom + EPS {
            continue;
        }
        if !bounds_overlap(wb, *cb) {
            continue;
        }
        let total = c.layers.as_ref().map_or(0.0, |ls| ls.iter().fold(0.0, |s, l| s + l.0));
        match &c.layers {
            Some(ls) if !ls.is_empty() && total > EPS => {
                let span = c.z_top - c.z_bottom;
                let mut prefix_top = 0.0;
                for &(th, prio) in ls {
                    let t = (th / total) * span;
                    let layer_top = c.z_top - prefix_top;
                    let layer_bottom = layer_top - t;
                    prefix_top += t;
                    if let Some(p) = prio {
                        out.push(Cutter { z_bottom: layer_bottom, z_top: layer_top, priority: p, outline: &c.outline });
                    }
                }
            }
            _ => {
                // Höchster Rang aller Schichten; ein unbekanntes Bauteil (oder Typ) → kein Cutter.
                let Some(ls) = &c.layers else { continue };
                let mut best: Option<f64> = None;
                let mut known = true;
                for &(_, p) in ls {
                    match p {
                        Some(p) => {
                            if best.map_or(true, |b| p > b) {
                                best = Some(p);
                            }
                        }
                        None => known = false,
                    }
                }
                if let (true, Some(p)) = (known, best) {
                    out.push(Cutter { z_bottom: c.z_bottom, z_top: c.z_top, priority: p, outline: &c.outline });
                }
            }
        }
    }
    out
}

/// Achsen-Teilintervalle in `[lo, hi]`, auf denen die Mittellinie eines Bands (Querversatz
/// `offset`) im Umriss liegt: Raster ~5 cm (min. 32 Schritte), Übergänge per Bisektion.
fn band_coverage(w: &WallIn, u: Vec2, n: Vec2, offset: f64, outline: &[Vec2], lo: f64, hi: f64) -> Vec<[f64; 2]> {
    if hi - lo <= EPS {
        return vec![];
    }
    let base = add(w.start, scale(n, offset));
    let inside = |t: f64| point_in_outline(add(base, scale(u, t)), outline);
    let steps = 32f64.max(((hi - lo) / 0.05).ceil()) as usize;
    let dt = (hi - lo) / steps as f64;
    let mut out = Vec::new();
    let mut prev_inside = inside(lo);
    let mut start = if prev_inside { Some(lo) } else { None };
    let mut prev_t = lo;
    for i in 1..=steps {
        let t = if i == steps { hi } else { lo + i as f64 * dt };
        let now = inside(t);
        if now != prev_inside {
            let cross = bisect(&inside, prev_t, t);
            if now {
                start = Some(cross);
            } else if let Some(s) = start.take() {
                out.push([s, cross]);
            }
        }
        prev_inside = now;
        prev_t = t;
    }
    if let Some(s) = start {
        out.push([s, hi]);
    }
    out
}

fn bisect(inside: &impl Fn(f64) -> bool, a: f64, b: f64) -> f64 {
    let a_inside = inside(a);
    let (mut lo, mut hi) = (a, b);
    let mut i = 0;
    while i < 40 && hi - lo > EPS * 0.01 {
        let mid = (lo + hi) / 2.0;
        if inside(mid) == a_inside {
            lo = mid;
        } else {
            hi = mid;
        }
        i += 1;
    }
    (lo + hi) / 2.0
}

/// `[lo, hi]` minus die (geklemmten, vereinigten) Intervalle `holes`.
fn subtract_spans(lo: f64, hi: f64, holes: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut clipped: Vec<[f64; 2]> = holes
        .iter()
        .map(|&[a, b]| [lo.max(a.min(b)), hi.min(a.max(b))])
        .filter(|&[a, b]| b > a + EPS)
        .collect();
    clipped.sort_by(|p, q| p[0].partial_cmp(&q[0]).unwrap_or(std::cmp::Ordering::Equal));
    let mut parts = Vec::new();
    let mut cursor = lo;
    for [a, b] in clipped {
        if a > cursor + EPS {
            parts.push([cursor, a]);
        }
        if b > cursor {
            cursor = b;
        }
    }
    if cursor < hi - EPS {
        parts.push([cursor, hi]);
    }
    parts
}

/// Decken-z-Cutter auf `[lo, hi]` je Terminierung: ausstanzen (beide), unter der Decke enden,
/// über der Decke beginnen.
fn terminate_or_subtract(lo: f64, hi: f64, cutters: &[[f64; 2]], term: Termination) -> Vec<[f64; 2]> {
    if cutters.is_empty() {
        return vec![[lo, hi]];
    }
    match term {
        Termination::Below => {
            let clip_top = cutters.iter().fold(f64::INFINITY, |m, c| m.min(c[0]));
            let top = clip_top.min(hi);
            if top > lo + EPS {
                vec![[lo, top]]
            } else {
                vec![]
            }
        }
        Termination::Above => {
            let clip_bottom = cutters.iter().fold(f64::NEG_INFINITY, |m, c| m.max(c[1]));
            let bottom = clip_bottom.max(lo);
            if bottom < hi - EPS {
                vec![[bottom, hi]]
            } else {
                vec![]
            }
        }
        Termination::Both => subtract_spans(lo, hi, cutters),
    }
}

/// Achsen-Distanz, an der die Band-Mittellinie die Schnittlinie trifft (`None`: parallel).
fn band_cut_distance(w: &WallIn, u: Vec2, n: Vec2, offset: f64, cut: &Line) -> Option<f64> {
    let base = add(w.start, scale(n, offset));
    let hit = line_intersect(base, u, cut.point, cut.dir)?;
    Some(dot(sub(hit, w.start), u))
}

/// Sammelt die Körper; `emit_piece` des layered-Pfads je Band.
struct Emitter<'a> {
    w: &'a WallIn,
    out: Vec<Piece>,
}

impl Emitter<'_> {
    /// `pushSegment`: Achsenstück [from, to] × [zb, zt], quer um `offset` versetzt.
    fn push(&mut self, band: usize, from: f64, to: f64, zb: f64, zt: f64, offset: f64, holes: Vec<[f64; 4]>, drop: [f64; 2]) {
        if to - from <= EPS || zt - zb <= EPS {
            return;
        }
        let (dx, dy) = (self.w.end.x - self.w.start.x, self.w.end.y - self.w.start.y);
        let len = js_hypot(dx, dy);
        if len < 1e-9 {
            return;
        }
        let (ux, uy) = (dx / len, dy / len);
        let (ox, oy) = (-uy * offset, ux * offset);
        let s = self.w.start;
        self.out.push(Piece {
            band,
            start: Vec2::new(s.x + ux * from + ox, s.y + uy * from + oy),
            end: Vec2::new(s.x + ux * to + ox, s.y + uy * to + oy),
            z_bottom: zb,
            z_top: zt,
            top_drop: (drop[0] > EPS || drop[1] > EPS).then_some(drop),
            holes,
        });
    }
}

/// Oberkante des Bands unter den Dächern: Dach-Unterkante entlang der Achse abtasten, zu geraden
/// Stücken (Toleranz 2 mm) zusammenfassen, Knicke exakt als Schnitt der Nachbargeraden; je Stück
/// ein Körper mit schräger Oberkante. Ohne Dach darüber: ein Körper, unverändert.
#[allow(clippy::too_many_arguments)]
fn clip_to_roofs(w: &WallIn, ctx: &FloorContext, u: Vec2, n: Vec2, offset: f64, a: f64, bb: f64, zb: f64, zt: f64, emit: &mut dyn FnMut(f64, f64, f64, f64, f64)) {
    if zt - zb <= EPS || bb - a <= EPS {
        return;
    }
    let wb = wall_bounds(w, offset.abs() + 0.01);
    let roofs: Vec<&RoofIn> = ctx.roofs.iter().filter(|(r, rb)| r.eaves_z + 50.0 >= zb && bounds_overlap(wb, *rb)).map(|(r, _)| r).collect();
    if roofs.is_empty() {
        emit(a, bb, zb, zt, zt);
        return;
    }
    let span = bb - a;
    let count = 1usize.max((span / ROOF_CLIP_STEP).ceil() as usize);
    let top_at = |t: f64| {
        let tt = (bb - 1e-3).min((a + 1e-3).max(t));
        let p = add(add(w.start, scale(u, tt)), scale(n, offset));
        let mut clip = zt;
        for r in &roofs {
            if let Some(under) = roof_underside_at(&r.planes, r.total_thickness, p.x, p.y) {
                if under < clip {
                    clip = under;
                }
            }
        }
        zb.max(clip)
    };
    let mut ts = Vec::with_capacity(count + 1);
    let mut tops = Vec::with_capacity(count + 1);
    for i in 0..=count {
        ts.push(a + (span * i as f64) / count as f64);
        tops.push(top_at(ts[i]));
    }
    const TOL: f64 = 0.002;
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i0 = 0;
    while i0 < count {
        let mut i1 = i0 + 1;
        while i1 < count {
            let k = i1 + 1;
            let slope = (tops[k] - tops[i0]) / (ts[k] - ts[i0]);
            let ok = (i0 + 1..=k).all(|m| (tops[i0] + slope * (ts[m] - ts[i0]) - tops[m]).abs() <= TOL);
            if !ok {
                break;
            }
            i1 = k;
        }
        runs.push((i0, i1));
        i0 = i1;
    }
    let line = |r: (usize, usize)| {
        let m = (tops[r.1] - tops[r.0]) / (ts[r.1] - ts[r.0]);
        (m, tops[r.0] - m * ts[r.0])
    };
    let mut cuts = vec![a];
    for r in 0..runs.len().saturating_sub(1) {
        let l1 = line(runs[r]);
        let l2 = line(runs[r + 1]);
        let lo = ts[runs[r].1 - 1];
        let hi = ts[count.min(runs[r].1 + 1)];
        let mut x = ts[runs[r].1];
        if (l1.0 - l2.0).abs() > 1e-9 {
            let cx = (l2.1 - l1.1) / (l1.0 - l2.0);
            if cx >= lo && cx <= hi {
                x = cx;
            }
        }
        cuts.push(x);
    }
    cuts.push(bb);
    for (k, &r) in runs.iter().enumerate() {
        let (sa, sb) = (cuts[k], cuts[k + 1]);
        if sb - sa <= EPS {
            continue;
        }
        let value_at = |x: f64| {
            let l = line(r);
            zt.min(zb.max(l.0 * x + l.1))
        };
        let (z0, z1) = (value_at(sa), value_at(sb));
        if z0.max(z1) - zb > EPS {
            emit(sa, sb, zb, z0, z1);
        }
    }
}

/// Band-Versätze (Mitte je Band, entlang der linken Normalen, relativ zur Achse).
fn band_offsets(w: &WallIn) -> Vec<f64> {
    if !w.stacked {
        return w.bands.iter().map(|b| reference_offset(w.reference, b.thickness)).collect();
    }
    let total = w.bands.iter().fold(0.0, |s, b| s + b.thickness);
    let ref_off = reference_offset(w.reference, total);
    let mut prefix = 0.0;
    w.bands
        .iter()
        .map(|b| {
            let o = ref_off - total / 2.0 + prefix + b.thickness / 2.0;
            prefix += b.thickness;
            o
        })
        .collect()
}

/// Alle Körper EINER Wand, in der Reihenfolge der früheren TS-Emission.
pub fn wall_bands(w: &WallIn, ctx: &FloorContext) -> Vec<Piece> {
    let mut em = Emitter { w, out: Vec::new() };
    let axis_len = js_hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    if axis_len < 1e-9 || w.z_top - w.z_bottom <= EPS {
        return em.out;
    }
    let offsets = band_offsets(w);
    let (z_bottom, z_top) = (w.z_bottom, w.z_top);
    let mut cutouts = w.openings.clone();
    cutouts.sort_by(|a, b| a.from.partial_cmp(&b.from).unwrap_or(std::cmp::Ordering::Equal));

    if !w.layered {
        // Schnitt-Pfad: Pfeiler/Brüstung/Sturz, je Segment alle Bänder.
        let seg = |em: &mut Emitter, from: f64, to: f64, zb: f64, zt: f64| {
            for (i, &off) in offsets.iter().enumerate() {
                em.push(i, from, to, zb, zt, off, vec![], [0.0, 0.0]);
            }
        };
        if cutouts.is_empty() {
            seg(&mut em, 0.0, axis_len, z_bottom, z_top);
            return em.out;
        }
        let mut cursor = 0.0f64;
        for c in &cutouts {
            let seg_from = cursor.max(c.from);
            if c.from > cursor {
                seg(&mut em, cursor, c.from, z_bottom, z_top);
            }
            if c.to > seg_from {
                if c.z_bottom > z_bottom + EPS {
                    seg(&mut em, seg_from, c.to, z_bottom, c.z_bottom);
                }
                if c.z_top < z_top - EPS {
                    seg(&mut em, seg_from, c.to, c.z_top, z_top);
                }
            }
            cursor = cursor.max(c.to);
        }
        if cursor < axis_len {
            seg(&mut em, cursor, axis_len, z_bottom, z_top);
        }
        return em.out;
    }

    let cuts = &w.cuts;
    let u = Vec2::new((w.end.x - w.start.x) / axis_len, (w.end.y - w.start.y) / axis_len);
    let n = left_normal(u);
    let cutters = ceiling_cutters(w, ctx);
    let n_bands = w.bands.len();

    for (li, b) in w.bands.iter().enumerate() {
        let off = offsets[li];
        // (1) Cuts an den Achsenenden (pro Schicht, falls materialbewusst).
        let (s_cut, e_cut) = match &cuts.layer_cuts {
            Some(lc) => (lc.start.get(li).copied().flatten(), lc.end.get(li).copied().flatten()),
            None => (cuts.start_cut, cuts.end_cut),
        };
        let mut from0 = 0.0;
        let mut to0 = axis_len;
        if let Some(c) = s_cut {
            if let Some(d) = band_cut_distance(w, u, n, off, &c) {
                from0 = d;
            }
        }
        if let Some(c) = e_cut {
            if let Some(d) = band_cut_distance(w, u, n, off, &c) {
                to0 = d;
            }
        }

        // (2) Nah-Putz-Aussparungen, die dieses Band quer treffen.
        let band_lo = off - b.thickness / 2.0;
        let band_hi = off + b.thickness / 2.0;
        let axis_holes: Vec<[f64; 2]> = cuts
            .span_cutouts
            .iter()
            .filter(|c| band_lo < c.off_a.max(c.off_b) - EPS && band_hi > c.off_a.min(c.off_b) + EPS)
            .map(|c| [c.from, c.to])
            .collect();
        let axis_pieces = subtract_spans(from0, to0, &axis_holes);

        // (3) Decken-Subtraktion je Band dort, wo der Decken-Umriss die Band-Mittellinie deckt.
        let mut band_z_cuts: Vec<[f64; 4]> = Vec::new(); // from, to, zBottom, zTop
        if let Some(bp) = b.priority {
            for cc in &cutters {
                if cc.priority <= bp {
                    continue;
                }
                for [ca, cb] in band_coverage(w, u, n, off, cc.outline, from0, to0) {
                    band_z_cuts.push([ca, cb, cc.z_bottom, cc.z_top]);
                }
            }
        }

        let innermost = li == n_bands - 1;
        let recess = b.thickness;
        let mut emit_piece = |a: f64, bb: f64, zb: f64, zt_start: f64, zt_end: f64| {
            emit_band_piece(&mut em, li, off, &cutouts, innermost, recess, a, bb, zb, zt_start, zt_end);
        };

        for [a, bb] in axis_pieces {
            let local: Vec<[f64; 4]> = band_z_cuts
                .iter()
                .map(|c| [a.max(c[0]), bb.min(c[1]), c[2], c[3]])
                .filter(|c| c[1] > c[0] + EPS)
                .collect();
            if local.is_empty() {
                clip_to_roofs(w, ctx, u, n, off, a, bb, z_bottom, z_top, &mut emit_piece);
                continue;
            }
            let mut xs = vec![a, bb];
            for c in &local {
                xs.push(c[0]);
                xs.push(c[1]);
            }
            xs.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
            xs.dedup();
            for i in 0..xs.len() - 1 {
                let (xa, xb) = (xs[i], xs[i + 1]);
                if xb - xa <= EPS {
                    continue;
                }
                let mid = (xa + xb) / 2.0;
                let z_cutters: Vec<[f64; 2]> = local.iter().filter(|c| c[0] <= mid && c[1] >= mid).map(|c| [c[2], c[3]]).collect();
                for [zb, zt] in terminate_or_subtract(z_bottom, z_top, &z_cutters, w.termination) {
                    clip_to_roofs(w, ctx, u, n, off, xa, xb, zb, zt, &mut emit_piece);
                }
            }
        }
    }
    em.out
}

/// Ein Körper eines Bands im layered-Pfad: Öffnungs-Löcher auf den Körper-Start umrechnen (an der
/// innersten Schicht mit Laibungs-Rücksprung geweitet); schräge Oberkante mit Löchern geht in
/// render3d nicht → gestuft annähern.
#[allow(clippy::too_many_arguments)]
fn emit_band_piece(em: &mut Emitter, li: usize, off: f64, cutouts: &[OpeningIn], innermost: bool, recess: f64, a: f64, bb: f64, zb: f64, zt_start: f64, zt_end: f64) {
    let zt = zt_start.max(zt_end);
    let holes: Vec<[f64; 4]> = cutouts
        .iter()
        .filter(|h| h.z_top > zb + EPS && h.z_bottom < zt - EPS)
        .map(|h| {
            if innermost && h.recess_inner_layer {
                [h.from - a - recess, h.to - a + recess, h.z_bottom - recess, h.z_top + recess]
            } else {
                [h.from - a, h.to - a, h.z_bottom, h.z_top]
            }
        })
        .collect();
    if !holes.is_empty() && (zt_start - zt_end).abs() > EPS {
        let k = 1usize.max(((bb - a) / ROOF_CLIP_STEP).ceil() as usize);
        for i in 0..k {
            let sa = a + ((bb - a) * i as f64) / k as f64;
            let sb = a + ((bb - a) * (i + 1) as f64) / k as f64;
            let zm = zt_start + ((zt_end - zt_start) * (i as f64 + 0.5)) / k as f64;
            emit_band_piece(em, li, off, cutouts, innermost, recess, sa, sb, zb, zm, zm);
        }
        return;
    }
    em.push(li, a, bb, zb, zt, off, holes, [zt - zt_start, zt - zt_end]);
}

// ── Flache Kodierung ─────────────────────────────────────────────────────────
//
// Geschosse: [nGeschosse, (nDecken, (zBottom, zTop, nPkt, (x, y)…, typOk, nSchichten,
//   (dicke, prio|NaN)…)…, nDächer, (traufZ, schichtdicke, nPkt, (x, y)…, nFlächen,
//   (m, (x, y, z)…)…)…)…]
// Wände: [nWände, (geschoss, sx, sy, ex, ey, zBottom, zTop, layered, stacked, refKind, refValue,
//   dickeHülle, terminierung (0 beide, 1 unten, 2 oben), nBänder, (dicke, prio|NaN)…,
//   nÖffnungen, (from, to, zBottom, zTop, rücksprung)…, <Cuts wie joins::encode_cuts>)…]
//   geschoss: Index in die Geschosse (ausserhalb = ohne Decken/Dächer).
// Ausgabe: [nWände, (nKörper, (band, x1, y1, x2, y2, zBottom, zTop, schräg 0/1, drop0, drop1,
//   nLöcher, (from, to, zBottom, zTop)…)…)…] — nWände < Eingabe, wenn der Puffer mittendrin
//   kaputt ist; eine Wand mit ungültigen Werten (NaN …) hat keine Körper.

use crate::flat_read::Reader;

fn fin(v: &[f64]) -> bool {
    v.iter().all(|x| x.is_finite())
}

/// Liest die Decken und Dächer eines Geschosses; einzelne ungültige fallen weg.
fn decode_context(r: &mut Reader) -> Option<FloorContext> {
    let nc = r.count()?;
    let mut ceilings = Vec::with_capacity(nc.min(1 << 12));
    for _ in 0..nc {
        let (czb, czt) = (r.num()?, r.num()?);
        let outline = r.ring()?;
        let type_ok = r.num()? != 0.0;
        let nl = r.count()?;
        let mut layers = Vec::with_capacity(nl.min(1 << 10));
        let mut ok = fin(&[czb, czt]) && outline.iter().all(|p| fin(p));
        for _ in 0..nl {
            let (t, p) = (r.num()?, r.num()?);
            ok &= t.is_finite() && !p.is_infinite();
            layers.push((t, (!p.is_nan()).then_some(p)));
        }
        if ok {
            let outline = outline.into_iter().map(|p| Vec2::new(p[0], p[1])).collect();
            ceilings.push(CeilingIn { z_bottom: czb, z_top: czt, outline, layers: type_ok.then_some(layers) });
        }
    }
    let nr = r.count()?;
    let mut roofs = Vec::with_capacity(nr.min(1 << 12));
    for _ in 0..nr {
        let (ez, total) = (r.num()?, r.num()?);
        let eaves = r.ring()?;
        let np = r.count()?;
        let mut planes = Vec::with_capacity(np.min(1 << 12));
        for _ in 0..np {
            let m = r.count()?;
            planes.push(r.points3(m)?);
        }
        if fin(&[ez, total]) && eaves.iter().all(|p| fin(p)) && planes.iter().flatten().all(|p| fin(p)) {
            roofs.push(RoofIn { eaves_z: ez, total_thickness: total, eaves, planes });
        }
    }
    Some(FloorContext::new(ceilings, roofs))
}

/// Liest eine Wand: `None` = Puffer kaputt (Abbruch), `Some((geschoss, None))` = Werte ungültig.
fn decode_wall(r: &mut Reader) -> Option<(f64, Option<WallIn>)> {
    let floor = r.num()?;
    let (sx, sy, ex, ey, zb, zt) = (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
    let (layered, stacked, kind, value, thick, term) = (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
    let mut ok = fin(&[sx, sy, ex, ey, zb, zt, thick]);
    let reference = match kind as i64 {
        1 => Reference::Left,
        2 => Reference::Right,
        3 => {
            ok &= value.is_finite();
            Reference::Offset(value)
        }
        _ => Reference::Center,
    };
    let termination = match term as i64 {
        1 => Termination::Below,
        2 => Termination::Above,
        _ => Termination::Both,
    };
    let nb = r.count()?;
    let mut bands = Vec::with_capacity(nb.min(1 << 10));
    for _ in 0..nb {
        let (t, p) = (r.num()?, r.num()?);
        ok &= t.is_finite() && !p.is_infinite();
        bands.push(BandIn { thickness: t, priority: (!p.is_nan()).then_some(p) });
    }
    let no = r.count()?;
    let mut openings = Vec::with_capacity(no.min(1 << 12));
    for _ in 0..no {
        let o = [r.num()?, r.num()?, r.num()?, r.num()?];
        let recess = r.num()? != 0.0;
        ok &= fin(&o);
        openings.push(OpeningIn { from: o[0], to: o[1], z_bottom: o[2], z_top: o[3], recess_inner_layer: recess });
    }
    let cuts = crate::joins::decode_cuts(r)?;
    let wall = WallIn {
        start: Vec2::new(sx, sy),
        end: Vec2::new(ex, ey),
        z_bottom: zb,
        z_top: zt,
        layered: layered != 0.0,
        stacked: stacked != 0.0,
        reference,
        thickness_safe: thick,
        termination,
        bands,
        openings,
        cuts,
    };
    Some((floor, ok.then_some(wall)))
}

fn encode_pieces(out: &mut Vec<f64>, pieces: &[Piece]) {
    out.push(pieces.len() as f64);
    for p in pieces {
        out.extend([p.band as f64, p.start.x, p.start.y, p.end.x, p.end.y, p.z_bottom, p.z_top]);
        match p.top_drop {
            Some([d0, d1]) => out.extend([1.0, d0, d1]),
            None => out.extend([0.0, 0.0, 0.0]),
        }
        out.push(p.holes.len() as f64);
        for h in &p.holes {
            out.extend(h);
        }
    }
}

/// Wände + Geschosse flach → Körper je Wand flach (s. Kodierung oben); nie ein Panic.
pub fn wall_bands_flat(walls: &[f64], floors: &[f64]) -> Vec<f64> {
    let mut fr = Reader::new(floors);
    let mut contexts = Vec::new();
    if let Some(n) = fr.count() {
        for _ in 0..n {
            match decode_context(&mut fr) {
                Some(c) => contexts.push(c),
                None => break,
            }
        }
    }
    let empty = FloorContext::default();
    let mut out = vec![0.0];
    let mut r = Reader::new(walls);
    let Some(n) = r.count() else { return out };
    let mut done = 0usize;
    for _ in 0..n {
        let Some((floor, wall)) = decode_wall(&mut r) else { break };
        let ctx = if floor >= 0.0 && floor.fract() == 0.0 { contexts.get(floor as usize).unwrap_or(&empty) } else { &empty };
        let pieces = wall.map(|w| wall_bands(&w, ctx)).unwrap_or_default();
        encode_pieces(&mut out, &pieces);
        done += 1;
    }
    out[0] = done as f64;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::joins::{compute_joins, JoinLayer, JoinWall, SpanCutout};

    fn base(start: (f64, f64), end: (f64, f64), bands: Vec<BandIn>) -> WallIn {
        WallIn {
            start: Vec2::new(start.0, start.1),
            end: Vec2::new(end.0, end.1),
            z_bottom: 0.0,
            z_top: 2.6,
            layered: true,
            stacked: true,
            reference: Reference::Center,
            thickness_safe: bands.iter().map(|b| b.thickness).sum(),
            termination: Termination::Both,
            bands,
            openings: vec![],
            cuts: WallCuts::default(),
        }
    }
    fn band(t: f64, p: f64) -> BandIn {
        BandIn { thickness: t, priority: Some(p) }
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }
    fn bands_of(w: &WallIn) -> Vec<Piece> {
        wall_bands(w, &FloorContext::default())
    }
    /// Achsen-Länge eines Körpers.
    fn plen(p: &Piece) -> f64 {
        js_hypot(p.end.x - p.start.x, p.end.y - p.start.y)
    }

    #[test]
    fn schichten_gestapelt_und_referenzversetzt() {
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.1, 10.0), band(0.2, 50.0)]);
        let p = bands_of(&w);
        assert_eq!(p.len(), 2);
        assert!(close(p[0].start.y, -0.1) && close(p[1].start.y, 0.05));
        w.reference = Reference::Left; // Stapel um die halbe Dicke nach +n verschoben
        let p = bands_of(&w);
        assert!(close(p[0].start.y, 0.05) && close(p[1].start.y, 0.2));
    }

    #[test]
    fn l_ecke_kuerzt_und_verlaengert_je_band() {
        let jw = |s: (f64, f64), e: (f64, f64)| JoinWall {
            start: Vec2::new(s.0, s.1),
            end: Vec2::new(e.0, e.1),
            reference: Reference::Center,
            layers: Some(vec![JoinLayer { thickness: 0.1, component: Some(0), priority: 10.0 }, JoinLayer { thickness: 0.2, component: Some(1), priority: 50.0 }]),
        };
        let cuts = compute_joins(&[jw((0.0, 0.0), (4.0, 0.0)), jw((4.0, 0.0), (4.0, 3.0))]).unwrap();
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.1, 10.0), band(0.2, 50.0)]);
        w.cuts = cuts[0].clone();
        let p = bands_of(&w);
        // Gehrung: das aussen liegende Band (−n, unten) ist länger als das innere.
        assert!(close(p[0].end.x, 4.0 + 0.1) && close(p[1].end.x, 4.0 - 0.05), "{p:?}");
        assert!(close(p[0].start.x, 0.0));
    }

    #[test]
    fn t_stoss_aussparung_bricht_band_auf() {
        let mut w = base((0.0, 0.0), (6.0, 0.0), vec![band(0.02, 10.0), band(0.15, 50.0), band(0.015, 10.0)]);
        w.cuts.span_cutouts.push(SpanCutout { from: 2.0, to: 2.15, off_a: 0.0925, off_b: 0.0775 });
        let p = bands_of(&w);
        // Aussenputz und Kern durchgehend, Innenputz (Band 2) in zwei Stücken.
        assert_eq!(p.iter().filter(|q| q.band == 2).count(), 2);
        assert_eq!(p.iter().filter(|q| q.band == 1).count(), 1);
    }

    #[test]
    fn oeffnung_am_rand_und_ruecksprung() {
        let mut w = base((0.0, 0.0), (3.0, 0.0), vec![band(0.15, 50.0), band(0.02, 10.0)]);
        w.openings.push(OpeningIn { from: 0.0, to: 0.9, z_bottom: 0.0, z_top: 2.1, recess_inner_layer: false });
        w.openings.push(OpeningIn { from: 2.0, to: 3.0, z_bottom: 0.9, z_top: 2.1, recess_inner_layer: true });
        let p = bands_of(&w);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].holes.len(), 2);
        assert_eq!(p[0].holes[1], [2.0, 3.0, 0.9, 2.1]);
        let r = p[1].holes[1];
        assert!(close(r[0], 1.98) && close(r[1], 3.02) && close(r[2], 0.88) && close(r[3], 2.12));
        // Schnitt-Pfad: Pfeiler/Brüstung/Sturz ohne Löcher.
        w.layered = false;
        w.stacked = false;
        w.bands = vec![BandIn { thickness: 0.17, priority: None }];
        let s = bands_of(&w);
        // Sturz Tür, Pfeiler, Brüstung + Sturz Fenster (Tür bis zum Rand: kein Pfeiler davor).
        assert_eq!(s.len(), 4, "{s:?}");
        assert!(s.iter().all(|q| q.holes.is_empty() && q.top_drop.is_none()));
    }

    #[test]
    fn decke_hoeherer_prioritaet_schneidet_nur_schwache_baender() {
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.15, 50.0), band(0.02, 10.0)]);
        w.z_top = 3.0;
        let outline = vec![Vec2::new(-1.0, -1.0), Vec2::new(5.0, -1.0), Vec2::new(5.0, 5.0), Vec2::new(-1.0, 5.0)];
        let ctx = FloorContext::new(vec![CeilingIn { z_bottom: 2.6, z_top: 2.8, outline, layers: Some(vec![(0.2, Some(30.0))]) }], vec![]);
        let p = wall_bands(&w, &ctx);
        assert_eq!(p.iter().filter(|q| q.band == 0).count(), 1); // Kern (50) läuft durch
        let weak: Vec<_> = p.iter().filter(|q| q.band == 1).collect();
        assert_eq!(weak.len(), 2);
        assert!(close(weak[0].z_top, 2.6) && close(weak[1].z_bottom, 2.8));
        // Terminierung „below": endet an der Deckenunterkante, kein Rest darüber.
        w.termination = Termination::Below;
        let p = wall_bands(&w, &ctx);
        assert_eq!(p.iter().filter(|q| q.band == 1).count(), 1);
    }

    #[test]
    fn wand_unter_pultdach_bekommt_schraege_oberkante() {
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.2, 50.0)]);
        w.z_top = 5.0;
        // Ebene z = 2 + 0.5·x über [−1, 5]².
        let plane = vec![[-1.0, -1.0, 1.5], [5.0, -1.0, 4.5], [5.0, 5.0, 4.5], [-1.0, 5.0, 1.5]];
        let roof = RoofIn { eaves_z: 1.5, total_thickness: 0.0, eaves: plane.iter().map(|p| [p[0], p[1]]).collect(), planes: vec![plane] };
        let ctx = FloorContext::new(vec![], vec![roof]);
        let p = wall_bands(&w, &ctx);
        assert_eq!(p.len(), 1, "{p:?}");
        let d = p[0].top_drop.unwrap();
        // Abtastung 1 mm innerhalb der Enden (wie TS) → Toleranz 1e-3.
        let near = |a: f64, b: f64| (a - b).abs() < 1e-3;
        assert!(near(p[0].z_top, 4.0) && near(d[0], 2.0) && d[1] == 0.0, "{p:?}");
        // Mit Öffnung: gestuft, ohne top_drop.
        w.openings.push(OpeningIn { from: 1.0, to: 2.0, z_bottom: 0.0, z_top: 2.0, recess_inner_layer: false });
        let p = wall_bands(&w, &ctx);
        assert!(p.len() > 10 && p.iter().all(|q| q.top_drop.is_none()));
        let total: f64 = p.iter().map(plen).sum();
        assert!(close(total, 4.0));
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert_eq!(wall_bands_flat(&[], &[]), vec![0.0]);
        assert_eq!(wall_bands_flat(&[f64::NAN; 40], &[f64::NAN]), vec![0.0]);
        assert_eq!(wall_bands_flat(&[0.0; 3], &[1.0, 5.0]), vec![0.0]);
        // Nulllänge, umgekehrte Höhen, Öffnung ausserhalb, Bänder ohne Dicke, entartete Decke/Dach.
        let mut w = base((1.0, 1.0), (1.0, 1.0), vec![band(0.2, 50.0)]);
        assert!(bands_of(&w).is_empty());
        w.end = Vec2::new(2.0, 1.0);
        w.z_top = -1.0;
        assert!(bands_of(&w).is_empty());
        w.z_top = 2.0;
        w.openings.push(OpeningIn { from: 5.0, to: -3.0, z_bottom: 9.0, z_top: -9.0, recess_inner_layer: true });
        w.bands.push(band(0.0, 1.0));
        let ctx = FloorContext::new(
            vec![CeilingIn { z_bottom: 0.5, z_top: 0.5, outline: vec![Vec2::new(0.0, 0.0); 3], layers: Some(vec![]) }],
            vec![RoofIn { eaves_z: 0.0, total_thickness: 0.0, eaves: vec![], planes: vec![vec![]] }],
        );
        let _ = wall_bands(&w, &ctx);

        // Flach: zwei Wände (die zweite mit NaN-Koordinate → keine Körper), ein Geschoss.
        let wall = |x: f64| {
            let mut b = vec![0.0, x, 1.0, 2.0, 1.0, 0.0, 2.0, 1.0, 1.0, 0.0, 0.0, 0.2, 0.0, 1.0, 0.2, 50.0, 0.0];
            crate::joins::encode_cuts(&mut b, &WallCuts::default());
            b
        };
        let mut buf = vec![2.0];
        buf.extend(wall(1.0));
        buf.extend(wall(f64::NAN));
        let floors = [1.0, 0.0, 0.0];
        let out = wall_bands_flat(&buf, &floors);
        assert_eq!(out[0], 2.0);
        assert_eq!(out[1], 1.0); // ein Körper
        assert_eq!(*out.last().unwrap(), 0.0); // zweite Wand: keine Körper
        // Abgeschnittener Puffer: nur die vollständige erste Wand.
        assert_eq!(wall_bands_flat(&buf[..buf.len() - 1], &floors)[0], 1.0);
        // Kaputte Geschosse: Wände ohne Decken/Dächer.
        assert_eq!(wall_bands_flat(&buf, &[3.0, 1.0])[0], 2.0);
    }
}
