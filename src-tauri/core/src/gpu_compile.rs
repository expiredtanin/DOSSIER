//! GPU-Kompilierung des Grundrisses ([K3b], früher `glPlanCompile.ts`): Plan-Puffer
//! (`plan_buf`) → Vertex-/Index-Puffer und Zeichen-Batches für den nativen Metal-Renderer
//! (`native_embed.rs`/`render2d/chunks.rs`) und den WebGL-Pfad.
//!
//! - Polygone → Ear-Clipping (konkav-fähig) in Bildschirm-Raum (`sx = mx·90`, `sy = −my·90`),
//!   relativ zum ersten abgelegten Punkt (lokaler Ursprung gegen f32-Auflösungsverlust).
//! - Striche → butt-endige Segment-Quads mit Normale + Seiten-Flag (bildschirmkonstante Breite
//!   im Shader), runde Joins/Kappen als Fächer; Schraffur, Zickzack, Motive, Bögen und Kreise
//!   werden vorher zu Linienzügen tesselliert (`hatch`).
//! - Batches: aufeinanderfolgende Indizes gleicher Farbe (+ Breite) werden zusammengefasst.
//!
//! Ausgabe (`compile_flat`) als EIN `u32`-Puffer (eine Kopie über die WASM-Grenze):
//! ```text
//! [M, 0, meta (M × f64 als je zwei u32, little-endian), fillPos (f32-Bits), fillIdx,
//!  lineVerts (f32-Bits bzw. gepackt), lineIdx]
//! meta = [originX, originY, minX, minY, maxX, maxY, nFillPos, nFillIdx, nLineVerts, nLineIdx,
//!         nFillBatches, nLineBatches,
//!         nFillBatches × (start, count, r, g, b, a),
//!         nLineBatches × (start, count, r, g, b, a, strokeMm, screenPx),
//!         nDashInst, nDashBatches, nDashBatches × (start, count, r, g, b, a, strokeMm, lineAt)]
//! danach (hinter lineIdx): dashInst = nDashInst × 16 f32-Bits
//! ```
//! Gestrichelte Striche (Linien, Bögen, Kreise mit Strichmuster) gehen wie im Szenen-Pfad von
//! render2d (`DashSegment`, `DASH_LINE_WGSL`) je Segment als EINE Instanz an die Strich-Pipeline:
//! `[ax, ay, bx, by, s0, runLen, total, count, dash0..dash7]` in Bildschirm-Einheiten (Punkte relativ
//! zu `origin`), der Fragment-Shader setzt Striche/Lücken/runde Enden. Muster mit mehr als
//! [`MAX_LINE_DASH`] Einträgen (nach Verdoppeln) zerlegt weiter die CPU (`apply_dash_runs`).
//! Muster-Längen wie im Szenen-Pfad: Papier-mm × [`LINE_DASH_MM_TO_M`] (Referenz 1:100).
//! `lineAt` = Anzahl Linien-Indizes vor dem Strich-Batch: der Renderer zeichnet ihn vor dem ersten
//! Linien-Batch mit `start >= lineAt` (Maler-Reihenfolge; kein Linien-Batch überspannt ein `lineAt`).
//! Linien-Vertices: 6 × f32 (x, y, nx, ny, side, miter=1) oder gepackt 3 Wörter (x, y als
//! f32-Bits, dann snorm8 nx | ny | side | miter=127).
//! Die Rechenreihenfolge folgt der TS-Fassung Operation für Operation: Vertex-Puffer bitgleich.

use crate::hatch::{self, v2, Hatch, HatchKind, Pattern, Run, V2, DASH_MM_TO_M};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::plan_buf::{self, PlanBuf, Prim, Style};
use std::f64::consts::PI;

const PX_PER_M: f64 = 90.0;
/// Grauton gedimmter Linien (wie `GREY_RGB` in `toRenderScene.ts`).
pub const GREY_RGB: f64 = 0.549;
const DEFAULT_INK: [f64; 4] = [0.1, 0.1, 0.1, 1.0];

type Rgba = [f64; 4];

pub struct FillBatch {
    pub start: u32,
    pub count: u32,
    pub color: Rgba,
}

pub struct LineBatch {
    pub start: u32,
    pub count: u32,
    pub color: Rgba,
    pub stroke_mm: f64,
    pub screen_px: bool,
}

/// Instanz-Bereich gestrichelter Segmente mit Farbe + Strichbreite (Papier-mm).
pub struct DashBatch {
    pub start: u32,
    pub count: u32,
    pub color: Rgba,
    pub stroke_mm: f64,
    /// Linien-Indizes vor diesem Batch (Maler-Reihenfolge, s. Modulkopf).
    pub line_at: u32,
}

/// Höchstzahl Einträge eines Strichmusters im Shader (wie `render2d::MAX_LINE_DASH`).
pub const MAX_LINE_DASH: usize = 8;
/// f32 je Strich-Instanz (wie `DashInstance` in render2d: ab, run, dash[8]).
pub const DASH_INST_FLOATS: usize = 16;
/// Papier-mm → Modell-Meter für Linien-Strichmuster: `N/1000` bei der Referenz-Skala 1:100, wie der
/// Szenen-Pfad (`render2d::tessellate`, `DASH_MM_TO_M` dort). Schraffur-Striche nehmen die an die
/// Musterkachel gekoppelte `hatch::DASH_MM_TO_M`.
pub const LINE_DASH_MM_TO_M: f64 = 100.0 / 1000.0;

/// Strichmuster einer Linie so umgerechnet, dass `hatch::apply_dash_runs` (rechnet mit
/// `hatch::DASH_MM_TO_M`) in [`LINE_DASH_MM_TO_M`] zerlegt.
fn line_dash_for_runs(dash: &[f64]) -> Vec<f64> {
    dash.iter().map(|d| d * (LINE_DASH_MM_TO_M / DASH_MM_TO_M)).collect()
}

/// Ergebnis der Kompilierung (Bildschirm-Raum relativ zu `origin`).
pub struct GpuOut {
    pub fill_pos: Vec<f32>,
    pub fill_idx: Vec<u32>,
    pub fill_batches: Vec<FillBatch>,
    /// f32-Bits (ungepackt, 6 je Vertex) bzw. gepackte Wörter (3 je Vertex).
    pub line_verts: Vec<u32>,
    pub line_idx: Vec<u32>,
    pub line_batches: Vec<LineBatch>,
    /// Strich-Instanzen ([`DASH_INST_FLOATS`] je Segment), s. Modulkopf.
    pub dash_inst: Vec<f32>,
    pub dash_batches: Vec<DashBatch>,
    pub origin: (f64, f64),
    /// Modell-Bounds (Meter): (minX, minY, maxX, maxY), ±∞ wenn leer.
    pub bounds: (f64, f64, f64, f64),
}

// ── Triangulierung ─────────────────────────────────────────────────────────

fn signed_area(pts: &[V2]) -> f64 {
    let n = pts.len();
    let mut a = 0.0;
    let mut j = n - 1;
    for i in 0..n {
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
        j = i;
    }
    a / 2.0
}

#[inline]
fn cross(a: V2, b: V2, c: V2) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

#[inline]
fn point_in_tri(a: V2, b: V2, c: V2, p: V2) -> bool {
    let d1 = cross(a, b, p);
    let d2 = cross(b, c, p);
    let d3 = cross(c, a, p);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Ear-Clipping eines einfachen (lochfreien) Polygons, konvex oder konkav. Indizes auf `pts`;
/// leer bei < 3 Ecken. Enthalten-Test nur gegen reflexe Ecken, Ohren per verketteter Liste.
pub fn triangulate(pts: &[V2]) -> Vec<u32> {
    let n = pts.len();
    if n < 3 {
        return Vec::new();
    }
    let mut order: Vec<usize> = (0..n).collect();
    if signed_area(pts) < 0.0 {
        order.reverse();
    }
    let mut next = vec![0usize; n];
    let mut prev = vec![0usize; n];
    for i in 0..n {
        next[order[i]] = order[(i + 1) % n];
        prev[order[i]] = order[(i + n - 1) % n];
    }
    // Reflex-Menge: Liste + Position (Reihenfolge ist für das Ergebnis belanglos — nur „liegt
    // irgendeine reflexe Ecke im Ohr?“ zählt).
    let mut reflex: Vec<usize> = Vec::new();
    let mut pos = vec![usize::MAX; n];
    let is_reflex = |i: usize, prev: &[usize], next: &[usize]| cross(pts[prev[i]], pts[i], pts[next[i]]) <= 0.0;
    fn add(i: usize, reflex: &mut Vec<usize>, pos: &mut [usize]) {
        if pos[i] == usize::MAX {
            pos[i] = reflex.len();
            reflex.push(i);
        }
    }
    fn del(i: usize, reflex: &mut Vec<usize>, pos: &mut [usize]) {
        let p = pos[i];
        if p != usize::MAX {
            let last = *reflex.last().unwrap();
            reflex.swap_remove(p);
            if last != i {
                pos[last] = p;
            }
            pos[i] = usize::MAX;
        }
    }
    for &i in &order {
        if is_reflex(i, &prev, &next) {
            add(i, &mut reflex, &mut pos);
        }
    }
    let mut tris: Vec<u32> = Vec::new();
    let mut remaining = n;
    let mut i = order[0];
    let mut no_ear_streak = 0usize;
    let mut guard: u64 = 0;
    let max_guard = (n as u64) * (n as u64) + 16;
    while remaining > 3 && {
        let g = guard;
        guard += 1;
        g < max_guard
    } {
        let a = prev[i];
        let b = i;
        let c = next[i];
        let mut is_ear = pos[b] == usize::MAX;
        if is_ear {
            for &vi in &reflex {
                if vi == a || vi == b || vi == c {
                    continue;
                }
                if point_in_tri(pts[a], pts[b], pts[c], pts[vi]) {
                    is_ear = false;
                    break;
                }
            }
        }
        if is_ear {
            tris.extend_from_slice(&[a as u32, b as u32, c as u32]);
            next[a] = c;
            prev[c] = a;
            del(b, &mut reflex, &mut pos);
            remaining -= 1;
            if is_reflex(a, &prev, &next) {
                add(a, &mut reflex, &mut pos);
            } else {
                del(a, &mut reflex, &mut pos);
            }
            if is_reflex(c, &prev, &next) {
                add(c, &mut reflex, &mut pos);
            } else {
                del(c, &mut reflex, &mut pos);
            }
            i = a;
            no_ear_streak = 0;
        } else {
            i = c;
            no_ear_streak += 1;
            if no_ear_streak > remaining {
                break;
            }
        }
    }
    if remaining == 3 {
        tris.extend_from_slice(&[prev[i] as u32, i as u32, next[i] as u32]);
    }
    tris
}

// ── Farben ─────────────────────────────────────────────────────────────────

/// Gedimmt → fester Grauton; Objekt-Deckkraft in den Alphakanal (wie `dim` in TS).
fn dim(color: Rgba, s: &Style) -> Rgba {
    let c = if s.greyed { [GREY_RGB, GREY_RGB, GREY_RGB, color[3]] } else { color };
    match s.opacity {
        Some(o) if !(o >= 1.0) => [c[0], c[1], c[2], c[3] * jsnum::max(0.0, o)],
        _ => c,
    }
}

/// Wie `dim`, aber gedimmte Flächen bleiben weiss.
fn dim_fill(color: Rgba, s: &Style) -> Rgba {
    let c = if s.greyed { [1.0, 1.0, 1.0, color[3]] } else { color };
    match s.opacity {
        Some(o) if !(o >= 1.0) => [c[0], c[1], c[2], c[3] * jsnum::max(0.0, o)],
        _ => c,
    }
}

#[inline]
fn same_rgba(a: &Rgba, b: &Rgba) -> bool {
    a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3]
}

/// `weightMm || 0.18`.
#[inline]
fn weight_or_default(w: f64) -> f64 {
    if w == 0.0 || w.is_nan() {
        0.18
    } else {
        w
    }
}

/// `Math.round(Math.max(-1, Math.min(1, v)) * 127) & 0xff`. Der Wert liegt in [−127, 127], NaN
/// ergibt 0; das Vorzeichen einer Null spielt nach `& 0xff` keine Rolle.
#[inline]
fn snorm8(v: f64) -> u32 {
    if v.is_nan() {
        return 0;
    }
    let x = (if v > 1.0 {
        1.0
    } else if v < -1.0 {
        -1.0
    } else {
        v
    }) * 127.0;
    let c = x.ceil();
    let r = if c - 0.5 > x { c - 1.0 } else { c };
    ((r as i32) & 0xff) as u32
}

/// Gepacktes Normalen-Wort: snorm8 nx | ny | side | miter (=127).
#[inline]
fn normal_word(nx: f64, ny: f64, side: f64) -> u32 {
    snorm8(nx) | (snorm8(ny) << 8) | (snorm8(side) << 16) | (127 << 24)
}

/// Fächer-Zentrum (1, 0, 0) gepackt.
const CENTER_WORD: u32 = 127 | (127 << 24);

#[inline]
fn left_normal(d: V2) -> V2 {
    v2(-d.y, d.x)
}

// ── Kompilierer ────────────────────────────────────────────────────────────

struct Compiler {
    packed: bool,
    fill_pos: Vec<f32>,
    fill_idx: Vec<u32>,
    fill_batches: Vec<FillBatch>,
    line_verts: Vec<u32>,
    line_idx: Vec<u32>,
    line_batches: Vec<LineBatch>,
    dash_inst: Vec<f32>,
    dash_batches: Vec<DashBatch>,
    origin_x: f64,
    origin_y: f64,
    origin_set: bool,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    /// Wiederverwendeter Punktpuffer für `stroke_polyline`.
    scratch: Vec<V2>,
    seg_dir: Vec<Option<V2>>,
    seg_ang: Vec<[Option<f64>; 2]>,
}

impl Compiler {
    #[inline]
    fn scr(&mut self, p: V2) -> V2 {
        let sx = p.x * PX_PER_M;
        let sy = -p.y * PX_PER_M;
        if !self.origin_set {
            self.origin_x = sx;
            self.origin_y = sy;
            self.origin_set = true;
        }
        v2(sx - self.origin_x, sy - self.origin_y)
    }

    #[inline]
    fn track(&mut self, mx: f64, my: f64) {
        if mx < self.min_x {
            self.min_x = mx;
        }
        if my < self.min_y {
            self.min_y = my;
        }
        if mx > self.max_x {
            self.max_x = mx;
        }
        if my > self.max_y {
            self.max_y = my;
        }
    }

    fn add_fill_batch(&mut self, count: usize, color: Rgba) {
        if let Some(last) = self.fill_batches.last_mut() {
            if same_rgba(&last.color, &color) {
                last.count += count as u32;
                return;
            }
        }
        self.fill_batches.push(FillBatch { start: (self.fill_idx.len() - count) as u32, count: count as u32, color });
    }

    fn add_line_batch(&mut self, count: usize, color: Rgba, stroke_mm: f64, screen_px: bool) {
        // Nicht über einen dazwischen gezeichneten Strich-Batch hinweg zusammenfassen.
        let dash_after = self.dash_batches.last().map_or(0, |d| d.line_at);
        if let Some(last) = self.line_batches.last_mut().filter(|l| dash_after <= l.start) {
            if last.stroke_mm == stroke_mm && last.screen_px == screen_px && same_rgba(&last.color, &color) {
                last.count += count as u32;
                return;
            }
        }
        self.line_batches.push(LineBatch { start: (self.line_idx.len() - count) as u32, count: count as u32, color, stroke_mm, screen_px });
    }

    fn add_dash_batch(&mut self, count: usize, color: Rgba, stroke_mm: f64) {
        let line_at = self.line_idx.len() as u32;
        if let Some(last) = self.dash_batches.last_mut() {
            // Nur ohne Linien dazwischen (sonst ginge die Maler-Reihenfolge verloren).
            if last.line_at == line_at && last.stroke_mm == stroke_mm && same_rgba(&last.color, &color) {
                last.count += count as u32;
                return;
            }
        }
        let start = (self.dash_inst.len() / DASH_INST_FLOATS - count) as u32;
        self.dash_batches.push(DashBatch { start, count: count as u32, color, stroke_mm, line_at });
    }

    /// Linienzug mit Strichmuster `dash` (Papier-mm): gültiges Muster bis [`MAX_LINE_DASH`]
    /// Einträge → Shader-Instanzen; längeres → CPU-Zerlegung; ungültiges/fehlendes → durchgezogen.
    fn stroke_styled(&mut self, pts_m: &[V2], closed: bool, dash: Option<&[f64]>, color: Rgba, stroke_mm: f64) {
        let Some(d) = dash.filter(|d| !d.is_empty()) else {
            return self.stroke_polyline(pts_m, closed, color, stroke_mm, false);
        };
        match dash_cycle_m(d) {
            Some(cycle) if cycle.len() <= MAX_LINE_DASH => self.stroke_dashed(pts_m, closed, &cycle, color, stroke_mm),
            Some(_) => {
                let mut run = pts_m.to_vec();
                if closed && pts_m.len() > 2 {
                    run.push(pts_m[0]);
                }
                for piece in hatch::apply_dash_runs(vec![run], &line_dash_for_runs(d)) {
                    self.stroke_polyline(&piece, false, color, stroke_mm, false);
                }
            }
            None => self.stroke_polyline(pts_m, closed, color, stroke_mm, false),
        }
    }

    /// Gestrichelter Linienzug (Modell-Meter) mit gültigem Zyklus `cycle_m` (Meter, gerade Länge):
    /// je Segment eine Instanz mit Lauflänge, Phase über den ganzen Zug (wie `apply_dash_runs`);
    /// Segmente kürzer als 1e-12 m entfallen. Ein geschlossener Zug wird um die Schlusskante ergänzt.
    fn stroke_dashed(&mut self, pts_m: &[V2], closed: bool, cycle_m: &[f64], color: Rgba, stroke_mm: f64) {
        if pts_m.len() < 2 {
            return;
        }
        let close = closed && pts_m.len() > 2 && (pts_m[0].x != pts_m[pts_m.len() - 1].x || pts_m[0].y != pts_m[pts_m.len() - 1].y);
        let n_seg = pts_m.len() - 1 + usize::from(close);
        let seg = |i: usize| (pts_m[i], pts_m[(i + 1) % pts_m.len()]);
        let mut run = 0.0f64;
        for i in 0..n_seg {
            let (a, b) = seg(i);
            let l = hypot2(b.x - a.x, b.y - a.y);
            if l >= 1e-12 {
                run += l;
            }
        }
        if !(run > 0.0) || !run.is_finite() {
            return;
        }
        let mut dash = [0.0f32; MAX_LINE_DASH];
        for (d, c) in dash.iter_mut().zip(cycle_m) {
            *d = (c * PX_PER_M) as f32;
        }
        let total: f64 = cycle_m.iter().sum::<f64>() * PX_PER_M;
        let before = self.dash_inst.len();
        let mut s0 = 0.0f64;
        for i in 0..n_seg {
            let (a, b) = seg(i);
            let l = hypot2(b.x - a.x, b.y - a.y);
            if !(l >= 1e-12) {
                continue;
            }
            let sa = self.scr(a);
            let sb = self.scr(b);
            self.track(a.x, a.y);
            self.track(b.x, b.y);
            self.dash_inst.extend_from_slice(&[
                sa.x as f32,
                sa.y as f32,
                sb.x as f32,
                sb.y as f32,
                (s0 * PX_PER_M) as f32,
                (run * PX_PER_M) as f32,
                total as f32,
                cycle_m.len() as f32,
            ]);
            self.dash_inst.extend_from_slice(&dash);
            s0 += l;
        }
        let n = (self.dash_inst.len() - before) / DASH_INST_FLOATS;
        if n > 0 {
            self.add_dash_batch(n, color, stroke_mm);
        }
    }

    #[inline]
    fn push_vert(&mut self, p: V2, nx: f64, ny: f64, side: f64) -> u32 {
        let w = if self.packed { normal_word(nx, ny, side) } else { 0 };
        self.push_vert_w(p, w, nx, ny, side)
    }

    /// Wie `push_vert`, mit bereits gepacktem Normalen-Wort `w` (nur im gepackten Layout benutzt).
    #[inline]
    fn push_vert_w(&mut self, p: V2, w: u32, nx: f64, ny: f64, side: f64) -> u32 {
        if self.packed {
            self.line_verts.extend_from_slice(&[(p.x as f32).to_bits(), (p.y as f32).to_bits(), w]);
            (self.line_verts.len() / 3 - 1) as u32
        } else {
            self.line_verts.extend_from_slice(&[
                (p.x as f32).to_bits(),
                (p.y as f32).to_bits(),
                (nx as f32).to_bits(),
                (ny as f32).to_bits(),
                (side as f32).to_bits(),
                1.0f32.to_bits(),
            ]);
            (self.line_verts.len() / 6 - 1) as u32
        }
    }

    /// Kreisbogen-Fächer um `p` (Radius = halbe Strichbreite im Shader).
    fn add_fan_arc(&mut self, p: V2, a_from: f64, a_to: f64, stroke_mm: f64) {
        let delta = a_to - a_from;
        let step_angle = if stroke_mm <= 0.35 { PI / 3.0 } else { PI / 10.0 };
        let steps = jsnum::max(1.0, (delta.abs() / step_angle).ceil());
        let i_center = self.push_vert_w(p, CENTER_WORD, 1.0, 0.0, 0.0);
        let mut prev = self.push_vert(p, jsnum::cos(a_from), jsnum::sin(a_from), 1.0);
        let mut s = 1.0;
        while s <= steps {
            let t = a_from + (delta * s) / steps;
            let cur = self.push_vert(p, jsnum::cos(t), jsnum::sin(t), 1.0);
            self.line_idx.extend_from_slice(&[i_center, prev, cur]);
            prev = cur;
            s += 1.0;
        }
    }

    /// Zusammenhängender Linienzug (Modell-Meter) mit runden Kappen/Ecken.
    fn stroke_polyline(&mut self, pts_m: &[V2], closed: bool, color: Rgba, stroke_mm: f64, screen_px: bool) {
        let mut s_pts = std::mem::take(&mut self.scratch);
        s_pts.clear();
        for &p in pts_m {
            let s = self.scr(p);
            if let Some(l) = s_pts.last() {
                if (l.x - s.x).abs() < 1e-6 && (l.y - s.y).abs() < 1e-6 {
                    continue;
                }
            }
            s_pts.push(s);
            self.track(p.x, p.y);
        }
        if closed && s_pts.len() > 1 {
            let f = s_pts[0];
            let l = s_pts[s_pts.len() - 1];
            if (f.x - l.x).abs() < 1e-6 && (f.y - l.y).abs() < 1e-6 {
                s_pts.pop();
            }
        }
        let k = s_pts.len();
        if k < 2 {
            self.scratch = s_pts;
            return;
        }
        let start_idx_len = self.line_idx.len();
        let segs = if closed { k } else { k - 1 };
        let mut seg_dir = std::mem::take(&mut self.seg_dir);
        seg_dir.clear();
        for i in 0..segs {
            let from = s_pts[i];
            let to = s_pts[(i + 1) % k];
            let dx = to.x - from.x;
            let dy = to.y - from.y;
            let len = hypot2(dx, dy);
            seg_dir.push(if len < 1e-9 { None } else { Some(v2(dx / len, dy / len)) });
        }
        for i in 0..segs {
            let Some(d) = seg_dir[i] else { continue };
            let n = left_normal(d);
            let a = s_pts[i];
            let b = s_pts[(i + 1) % k];
            let (wp, wm) = if self.packed { (normal_word(n.x, n.y, 1.0), normal_word(n.x, n.y, -1.0)) } else { (0, 0) };
            let i0 = self.push_vert_w(a, wp, n.x, n.y, 1.0);
            let i1 = self.push_vert_w(a, wm, n.x, n.y, -1.0);
            let i2 = self.push_vert_w(b, wp, n.x, n.y, 1.0);
            let i3 = self.push_vert_w(b, wm, n.x, n.y, -1.0);
            self.line_idx.extend_from_slice(&[i0, i1, i2, i1, i3, i2]);
        }
        // Winkel der (ggf. gespiegelten) Segment-Normalen: jede Normale dient zwei Ecken bzw.
        // einer Ecke und einer Kappe — `atan2` nur einmal je Segment und Richtung (gleiche
        // Eingabe, also derselbe Wert).
        let mut seg_ang = std::mem::take(&mut self.seg_ang);
        seg_ang.clear();
        seg_ang.resize(segs, [None, None]);
        let mut ang = |seg: usize, sign: f64| -> f64 {
            let slot = if sign > 0.0 { 0 } else { 1 };
            if let Some(a) = seg_ang[seg][slot] {
                return a;
            }
            let n = left_normal(seg_dir[seg].unwrap_or(v2(0.0, 0.0)));
            let a = jsnum::atan2(sign * n.y, sign * n.x);
            seg_ang[seg][slot] = Some(a);
            a
        };
        for v in 0..k {
            let has_in = closed || v > 0;
            let has_out = closed || v < k - 1;
            let i_in = (v + segs - 1) % segs;
            let i_out = v % segs;
            let d_in = if has_in { seg_dir[i_in] } else { None };
            let d_out = if has_out { seg_dir[i_out] } else { None };
            let p = s_pts[v];
            match (d_in, d_out) {
                (Some(d1), Some(d2)) => {
                    // Runder Übergang nur auf der äusseren Seite der Ecke.
                    let turn = d1.x * d2.y - d1.y * d2.x;
                    let dot = d1.x * d2.x + d1.y * d2.y;
                    if turn.abs() < 1e-6 && dot > 0.0 {
                        continue;
                    }
                    if dot < -0.9999 {
                        // ~180°-Umkehr: voller Kreis.
                        let a0 = ang(i_in, 1.0);
                        self.add_fan_arc(p, a0, a0 + 2.0 * PI, stroke_mm);
                        continue;
                    }
                    let outer = if turn > 0.0 { -1.0 } else { 1.0 };
                    let a1 = ang(i_in, outer);
                    let a2 = ang(i_out, outer);
                    let mut delta = a2 - a1;
                    while delta <= -PI {
                        delta += 2.0 * PI;
                    }
                    while delta > PI {
                        delta -= 2.0 * PI;
                    }
                    if delta.abs() < 1e-4 {
                        continue;
                    }
                    self.add_fan_arc(p, a1, a1 + delta, stroke_mm);
                }
                // Runde Kappen an offenen Enden (Start bulgt rückwärts, Ende vorwärts).
                (None, Some(_)) => {
                    let a0 = ang(i_out, 1.0);
                    self.add_fan_arc(p, a0, a0 + PI, stroke_mm);
                }
                (Some(_), None) => {
                    let a0 = ang(i_in, 1.0);
                    self.add_fan_arc(p, a0, a0 + -PI, stroke_mm);
                }
                (None, None) => {}
            }
        }
        let count = self.line_idx.len() - start_idx_len;
        self.add_line_batch(count, color, stroke_mm, screen_px);
        self.scratch = s_pts;
        self.seg_dir = seg_dir;
        self.seg_ang = seg_ang;
    }

    /// Polygon-Umriss ohne die Kanten in `no_stroke` (offene Züge, gerade Enden an Lücken).
    fn stroke_polygon_outline(&mut self, pts: &[V2], color: Rgba, stroke_mm: f64, no_stroke: &[f64]) {
        let n = pts.len();
        if no_stroke.is_empty() || n < 2 {
            self.stroke_polyline(pts, true, color, stroke_mm, false);
            return;
        }
        let nf = n as f64;
        // Menge wie `new Set(noStroke.map(i => ((i % n) + n) % n))` (SameValueZero).
        let mut keys: Vec<f64> = no_stroke
            .iter()
            .map(|&i| {
                let k = ((i % nf) + nf) % nf;
                // −0/+0 und alle NaN sind je derselbe Schlüssel.
                if k.is_nan() {
                    f64::NAN
                } else if k == 0.0 {
                    0.0
                } else {
                    k
                }
            })
            .collect();
        let mut skip = vec![false; n];
        for &kk in &keys {
            if kk >= 0.0 && kk < nf && kk.fract() == 0.0 {
                skip[kk as usize] = true;
            }
        }
        keys.sort_by(|a, b| a.total_cmp(b));
        keys.dedup_by(|a, b| a.to_bits() == b.to_bits());
        if keys.len() >= n {
            return;
        }
        let visible = |i: usize| !skip[i % n];
        let mut run: Vec<V2> = Vec::new();
        for s in 0..n {
            if !visible(s) || visible(s + n - 1) {
                continue;
            }
            run.clear();
            run.push(pts[s]);
            let mut j = s;
            while visible(j) {
                run.push(pts[(j + 1) % n]);
                j += 1;
                if j - s >= n {
                    break;
                }
            }
            self.stroke_polyline(&run, false, color, stroke_mm, false);
        }
    }

    fn push_fill(&mut self, pts: &[V2], tris: &[u32], color: Rgba) {
        let base = (self.fill_pos.len() / 2) as u32;
        for &pt in pts {
            let s = self.scr(pt);
            self.fill_pos.push(s.x as f32);
            self.fill_pos.push(s.y as f32);
            self.track(pt.x, pt.y);
        }
        for &t in tris {
            self.fill_idx.push(base + t);
        }
        self.add_fill_batch(tris.len(), color);
    }
}

/// Strichmuster (Papier-mm) → Zyklus in Modell-Metern wie `split_dash` in render2d: negative Werte
/// zu 0, Nullen weg, ungerade Länge verdoppelt. `None` = kein gültiges Muster (durchgezogen).
fn dash_cycle_m(dash: &[f64]) -> Option<Vec<f64>> {
    // Nullen bleiben stehen ([96]): AN = 0 ist ein Punkt (rund, wie im Szenen-Pfad `render2d`).
    let pat: Vec<f64> = dash.iter().map(|&d| if d.is_finite() { jsnum::max(0.0, d) * LINE_DASH_MM_TO_M } else { 0.0 }).collect();
    if pat.iter().all(|&d| d <= 0.0) {
        return None;
    }
    let cycle: Vec<f64> = if pat.len() % 2 == 0 { pat } else { [pat.as_slice(), pat.as_slice()].concat() };
    let total: f64 = cycle.iter().sum();
    (total > 1e-9 && total.is_finite()).then_some(cycle)
}

/// Segmentzahl eines Bogens: Sagitta < ~0.5 px über `px_per_meter`, sonst fester Rückfall.
fn arc_segments(r: f64, sweep_abs: f64, px_per_meter: f64, min_fallback: f64) -> f64 {
    if px_per_meter > 0.0 {
        let r_px = r * px_per_meter;
        let theta = if r_px > 0.5 { 2.0 * jsnum::acos(1.0 - 0.5 / r_px) } else { PI };
        jsnum::min(2048.0, jsnum::max(8.0, (sweep_abs / theta).ceil()))
    } else {
        jsnum::max(min_fallback, ((sweep_abs / (PI / 2.0)) * 16.0).ceil())
    }
}

fn color_or_ink(plan: &PlanBuf, idx: i32) -> Rgba {
    plan.color(idx).unwrap_or(DEFAULT_INK)
}

/// Hatch zeichnet Musterlinien (nicht Bild/Verlauf, nicht none/solid)?
fn hatch_draws_lines(h: &Hatch) -> bool {
    h.kind != HatchKind::Image && h.kind != HatchKind::Gradient && h.pattern != Pattern::None && h.pattern != Pattern::Solid
}

/// Kompiliert die Primitive eines Plan-Puffers. `px_per_meter` steuert nur die Bogen-
/// Tessellierung (0 = zoomunabhängig). `packed` = kompakte Linien-Vertices (nativer Renderer).
pub fn compile(plan: &PlanBuf, px_per_meter: f64, packed: bool) -> GpuOut {
    let mut c = Compiler {
        packed,
        fill_pos: Vec::new(),
        fill_idx: Vec::new(),
        fill_batches: Vec::new(),
        line_verts: Vec::new(),
        line_idx: Vec::new(),
        line_batches: Vec::new(),
        dash_inst: Vec::new(),
        dash_batches: Vec::new(),
        origin_x: 0.0,
        origin_y: 0.0,
        origin_set: false,
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
        scratch: Vec::new(),
        seg_dir: Vec::new(),
        seg_ang: Vec::new(),
    };
    let prims = &plan.prims;
    let plain_line = |p: &Prim| matches!(p, Prim::Line { zigzag: None, motif: None, .. });

    // Zusammenhängende, gleich gestylte Einzel-Linien eines Elements als EIN Zug (zwei echte
    // Kappen statt 2N). Läuft VOR allen anderen Primitiven, wie in der TS-Fassung.
    let mut merged = vec![false; prims.len()];
    let mut pts: Vec<V2> = Vec::new();
    let mut i = 0;
    while i < prims.len() {
        let Prim::Line { style, color, weight_mm, a, b, zigzag: None, motif: None, dash, .. } = &prims[i] else {
            i += 1;
            continue;
        };
        pts.clear();
        pts.push(*a);
        pts.push(*b);
        let mut j = i + 1;
        while j < prims.len() {
            match &prims[j] {
                Prim::Line { chain: true, a: aj, b: bj, .. } if plain_line(&prims[j]) => {
                    let last = pts[pts.len() - 1];
                    if aj.x != last.x || aj.y != last.y {
                        break;
                    }
                    pts.push(*bj);
                    j += 1;
                }
                _ => break,
            }
        }
        if j - i > 1 {
            let col = dim(color_or_ink(plan, *color), style);
            c.stroke_styled(&pts, false, dash.as_deref(), col, weight_or_default(*weight_mm));
            for m in merged.iter_mut().take(j).skip(i) {
                *m = true;
            }
        }
        i = j;
    }

    for (idx, prim) in prims.iter().enumerate() {
        if merged[idx] {
            continue;
        }
        match prim {
            Prim::Placeholder => {}
            Prim::Polygon { style, fill, stroke, stroke_width_mm, hatch, pts, no_stroke_edges } => {
                if let Some(fc) = plan.color(*fill) {
                    let tris = triangulate(pts);
                    if !tris.is_empty() {
                        c.push_fill(pts, &tris, dim_fill(fc, style));
                    }
                }
                if let Some(h) = (*hatch >= 0).then(|| plan.hatches.get(*hatch as usize)).flatten() {
                    if hatch_draws_lines(&h.hatch) {
                        let hatch_color = dim(color_or_ink(plan, h.color), style);
                        let hatch_mm = if h.hatch.line_weight > 0.0 { h.hatch.line_weight } else { 0.13 };
                        let runs: Vec<Run> = hatch::apply_dash_runs(hatch::build_hatch_runs(pts, &h.hatch), &hatch::hatch_dash(&h.hatch));
                        for run in &runs {
                            c.stroke_polyline(run, false, hatch_color, hatch_mm, false);
                        }
                    }
                }
                if let Some(sc) = plan.color(*stroke) {
                    if *stroke_width_mm > 0.0 && pts.len() >= 2 {
                        c.stroke_polygon_outline(pts, dim(sc, style), *stroke_width_mm, no_stroke_edges);
                    }
                }
            }
            Prim::Line { style, color, weight_mm, a, b, zigzag, motif, dash, .. } => {
                let col = dim(color_or_ink(plan, *color), style);
                let w = weight_or_default(*weight_mm);
                if let Some((amp, wav)) = zigzag {
                    let zpts = hatch::zigzag_points(*a, *b, amp * DASH_MM_TO_M, wav * DASH_MM_TO_M).unwrap_or_else(|| vec![*a, *b]);
                    c.stroke_polyline(&zpts, false, col, w, false);
                } else if let Some(m) = motif {
                    let mpts = hatch::motif_points(*a, *b, m, DASH_MM_TO_M);
                    c.stroke_polyline(&mpts, false, col, w, false);
                } else {
                    c.stroke_styled(&[*a, *b], false, dash.as_deref(), col, w);
                }
            }
            Prim::Arc { style, color, weight_mm, center, from, to, r, dash } => {
                let col = dim(color_or_ink(plan, *color), style);
                let stroke_mm = weight_or_default(*weight_mm);
                let a0 = jsnum::atan2(from.y - center.y, from.x - center.x);
                let a1 = jsnum::atan2(to.y - center.y, to.x - center.x);
                let mut d = a1 - a0;
                while d <= -PI {
                    d += 2.0 * PI;
                }
                while d > PI {
                    d -= 2.0 * PI;
                }
                let segs = arc_segments(*r, d.abs(), px_per_meter, 4.0);
                let mut arc_pts = vec![*from];
                let mut k = 1.0;
                while k <= segs {
                    let t = a0 + (d * k) / segs;
                    arc_pts.push(v2(center.x + r * jsnum::cos(t), center.y + r * jsnum::sin(t)));
                    k += 1.0;
                }
                c.stroke_styled(&arc_pts, false, dash.as_deref(), col, stroke_mm);
            }
            Prim::Circle { style, fill, stroke, weight_mm, center, r, dash } => {
                draw_circle_like(&mut c, plan, style, Some(*fill), *stroke, *weight_mm, *center, *r, None, px_per_meter, dash.as_deref());
            }
            Prim::DrawingArc { style, stroke, weight_mm, center, r, a0, a1, dash } => {
                draw_circle_like(&mut c, plan, style, None, *stroke, *weight_mm, *center, *r, Some((*a0, *a1)), px_per_meter, dash.as_deref());
            }
        }
    }

    GpuOut {
        fill_pos: c.fill_pos,
        fill_idx: c.fill_idx,
        fill_batches: c.fill_batches,
        line_verts: c.line_verts,
        line_idx: c.line_idx,
        line_batches: c.line_batches,
        dash_inst: c.dash_inst,
        dash_batches: c.dash_batches,
        origin: (c.origin_x, c.origin_y),
        bounds: (c.min_x, c.min_y, c.max_x, c.max_y),
    }
}

/// 2D-Kreis (`fill` gesetzt, geschlossen) bzw. 2D-Bogen (`arc` = (a0, a1), CCW, offen).
#[allow(clippy::too_many_arguments)]
fn draw_circle_like(
    c: &mut Compiler,
    plan: &PlanBuf,
    style: &Style,
    fill: Option<i32>,
    stroke: i32,
    weight_mm: f64,
    center: V2,
    r: f64,
    arc: Option<(f64, f64)>,
    px_per_meter: f64,
    dash: Option<&[f64]>,
) {
    let stroke_col = dim(color_or_ink(plan, stroke), style);
    let stroke_mm = weight_or_default(weight_mm);
    const TAU: f64 = PI * 2.0;
    let (a0, sweep) = match arc {
        Some((a0, a1)) => {
            let s = ((a1 - a0) % TAU + TAU) % TAU;
            (a0, if s == 0.0 || s.is_nan() { TAU } else { s })
        }
        None => (0.0, TAU),
    };
    let segs = arc_segments(r, sweep, px_per_meter, 8.0);
    let mut pts = Vec::new();
    let mut i = 0.0;
    while i <= segs {
        let t = a0 + (sweep * i) / segs;
        pts.push(v2(center.x + r * jsnum::cos(t), center.y + r * jsnum::sin(t)));
        i += 1.0;
    }
    if let Some(fi) = fill {
        if let Some(fc) = plan.color(fi) {
            // Ring ohne den doppelten Schlusspunkt (`pts.slice(0, segs)`).
            let n = if segs >= 0.0 { (segs as usize).min(pts.len()) } else { 0 };
            let ring = &pts[..n];
            let tris = triangulate(ring);
            if !tris.is_empty() {
                c.push_fill(ring, &tris, dim_fill(fc, style));
            }
        }
    }
    c.stroke_styled(&pts, fill.is_some(), dash, stroke_col, stroke_mm);
}

/// Flache Ausgabe (s. Modulkopf) für die Primitive `[from, to)` eines Plan-Puffers (v2); leer bei
/// unlesbarem Puffer oder ungültigem Bereich.
pub fn compile_flat(bytes: &[u8], from: usize, to: usize, px_per_meter: f64, packed: bool) -> Vec<u32> {
    let Some(plan) = plan_buf::View::parse(bytes).and_then(|v| v.gpu(from, to)) else { return Vec::new() };
    let o = compile(&plan, px_per_meter, packed);
    let mut meta: Vec<f64> = vec![
        o.origin.0,
        o.origin.1,
        o.bounds.0,
        o.bounds.1,
        o.bounds.2,
        o.bounds.3,
        o.fill_pos.len() as f64,
        o.fill_idx.len() as f64,
        o.line_verts.len() as f64,
        o.line_idx.len() as f64,
        o.fill_batches.len() as f64,
        o.line_batches.len() as f64,
    ];
    for b in &o.fill_batches {
        meta.extend_from_slice(&[b.start as f64, b.count as f64, b.color[0], b.color[1], b.color[2], b.color[3]]);
    }
    for b in &o.line_batches {
        meta.extend_from_slice(&[
            b.start as f64,
            b.count as f64,
            b.color[0],
            b.color[1],
            b.color[2],
            b.color[3],
            b.stroke_mm,
            if b.screen_px { 1.0 } else { 0.0 },
        ]);
    }
    meta.push((o.dash_inst.len() / DASH_INST_FLOATS) as f64);
    meta.push(o.dash_batches.len() as f64);
    for b in &o.dash_batches {
        meta.extend_from_slice(&[b.start as f64, b.count as f64, b.color[0], b.color[1], b.color[2], b.color[3], b.stroke_mm, b.line_at as f64]);
    }
    let mut out = Vec::with_capacity(2 + meta.len() * 2 + o.fill_pos.len() + o.fill_idx.len() + o.line_verts.len() + o.line_idx.len() + o.dash_inst.len());
    out.push(meta.len() as u32);
    out.push(0);
    for m in &meta {
        let bits = m.to_bits();
        out.push(bits as u32);
        out.push((bits >> 32) as u32);
    }
    out.extend(o.fill_pos.iter().map(|v| v.to_bits()));
    out.extend_from_slice(&o.fill_idx);
    out.extend_from_slice(&o.line_verts);
    out.extend_from_slice(&o.line_idx);
    out.extend(o.dash_inst.iter().map(|v| v.to_bits()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan_buf::HatchEntry;

    fn st() -> Style {
        Style { greyed: false, opacity: None }
    }

    fn line(ax: f64, bx: f64, chain: bool) -> Prim {
        Prim::Line {
            style: st(),
            color: 0,
            weight_mm: 0.18,
            a: v2(ax, 0.0),
            b: v2(bx, 0.0),
            chain,
            zigzag: None,
            motif: None,
            dash: None,
        }
    }

    fn plan(prims: Vec<Prim>) -> PlanBuf {
        PlanBuf { colors: vec![[0.0, 0.0, 0.0, 1.0], [0.5, 0.5, 0.5, 1.0]], hatches: vec![], prims }
    }

    fn line_idx_count(p: &PlanBuf) -> u32 {
        compile(p, 90.0, false).line_batches.iter().map(|b| b.count).sum()
    }

    #[test]
    fn triangulierung_konvex_konkav() {
        let sq = [v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0), v2(0.0, 1.0)];
        assert_eq!(triangulate(&sq).len(), 6);
        let l = [v2(0.0, 0.0), v2(2.0, 0.0), v2(2.0, 1.0), v2(1.0, 1.0), v2(1.0, 2.0), v2(0.0, 2.0)];
        let t = triangulate(&l);
        assert_eq!(t.len(), 12);
        let area: f64 = t.chunks(3).map(|c| cross(l[c[0] as usize], l[c[1] as usize], l[c[2] as usize]).abs() / 2.0).sum();
        assert!((area - 3.0).abs() < 1e-12);
        let mut cw = l;
        cw.reverse();
        assert_eq!(triangulate(&cw).len(), 12);
        assert!(triangulate(&sq[..2]).is_empty());
    }

    #[test]
    fn punkte_bleiben_im_strichmuster() {
        // [96] Strichpunktlinie: Strich, Lücke, Punkt (0), Lücke — vier Einträge, AN/AUS nicht verschoben.
        let c = dash_cycle_m(&[12.0, 1.5, 0.0, 1.5]).unwrap();
        assert_eq!(c, vec![12.0 * LINE_DASH_MM_TO_M, 1.5 * LINE_DASH_MM_TO_M, 0.0, 1.5 * LINE_DASH_MM_TO_M]);
        assert_eq!(dash_cycle_m(&[0.0, 1.0]).unwrap().len(), 2, "Punktlinie");
        assert!(dash_cycle_m(&[0.0, 0.0]).is_none());
        assert!(dash_cycle_m(&[f64::NAN]).is_none());
    }

    #[test]
    fn linienzug_wird_zusammengefasst() {
        let single = line_idx_count(&plan(vec![line(0.0, 1.0, false)]));
        let merged = line_idx_count(&plan(vec![line(0.0, 1.0, false), line(1.0, 2.0, true), line(2.0, 3.0, true)]));
        assert_eq!(merged, single + 2 * 6);
        let apart = line_idx_count(&plan(vec![line(0.0, 1.0, false), line(1.0, 2.0, false)]));
        assert_eq!(apart, 2 * single);
    }

    #[test]
    fn polygon_mit_fuellung_schraffur_umriss() {
        let mut p = plan(vec![Prim::Polygon {
            style: Style { greyed: true, opacity: Some(0.5) },
            fill: 1,
            stroke: 0,
            stroke_width_mm: 0.5,
            hatch: 0,
            pts: vec![v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0), v2(0.0, 1.0)],
            no_stroke_edges: vec![0.0],
        }]);
        p.hatches.push(HatchEntry {
            hatch: Hatch {
                pattern: Pattern::Diagonal,
                kind: HatchKind::Vector,
                random: false,
                scale: 1.0,
                angle: 45.0,
                line_weight: 0.0,
                origin: None,
                seed: None,
                density: None,
                length_min: None,
                length_max: None,
                dash: vec![],
                motif: None,
                polar: None,
            },
            color: -1,
        });
        let o = compile(&p, 90.0, true);
        assert_eq!(o.fill_idx.len(), 6);
        assert_eq!(o.fill_batches[0].color, [1.0, 1.0, 1.0, 0.5]);
        // Schraffur (0.13 mm, grau) und Umriss (0.5 mm) als eigene Batches.
        assert_eq!(o.line_batches.len(), 2);
        assert_eq!(o.line_batches[0].color, [GREY_RGB, GREY_RGB, GREY_RGB, 0.5]);
        assert_eq!(o.line_batches[0].stroke_mm, 0.13);
        assert_eq!(o.line_batches[1].stroke_mm, 0.5);
        assert_eq!(o.line_verts.len() % 3, 0);
        assert_eq!(o.origin, (0.0, 0.0));
    }

    #[test]
    fn kreis_und_bogen() {
        let p = plan(vec![
            Prim::Circle { style: st(), fill: 1, stroke: 0, weight_mm: 0.0, center: v2(1.0, 1.0), r: 1.0, dash: None },
            Prim::DrawingArc { style: st(), stroke: 0, weight_mm: 0.5, center: v2(0.0, 0.0), r: 1.0, a0: 0.0, a1: 0.0, dash: None },
            Prim::Placeholder,
        ]);
        let o = compile(&p, 0.0, false);
        assert!(!o.fill_idx.is_empty());
        assert_eq!(o.line_batches.len(), 2);
        assert_eq!(o.bounds, (-1.0, -1.0, 2.0, 2.0));
    }

    #[test]
    fn kaputter_puffer_leer() {
        assert!(compile_flat(&[1, 2, 3], 0, 0, 90.0, true).is_empty());
        let mut w = plan_buf::Writer::new(false);
        w.push(&crate::plan::prim::Primitive::Line {
            a: crate::model::Vec2 { x: 0.0, y: 0.0 },
            b: crate::model::Vec2 { x: f64::NAN, y: 0.0 },
            cls: "c".into(),
            weight_mm: 0.18,
            dash: None,
            zigzag: None,
            motif: None,
            color: None,
            drawing_id: None,
            opening_id: None,
            stair_id: None,
            greyed: None,
            opacity: None,
        });
        let enc = w.finish();
        assert!(!compile_flat(&enc, 0, 1, 90.0, true).is_empty());
        assert!(compile_flat(&enc, 0, 2, 90.0, true).is_empty(), "Bereich ausserhalb");
        assert!(!compile_flat(&enc, 1, 1, 90.0, true).is_empty(), "leerer Bereich = leere Geometrie");
    }
    // --- Strichmuster im Shader (Chunk-Pfad, gleiche Instanzen wie render2d `DashSegment`) ---

    fn dashed(ax: f64, bx: f64, chain: bool, dash: Vec<f64>) -> Prim {
        Prim::Line { style: st(), color: 0, weight_mm: 0.25, a: v2(ax, 0.0), b: v2(bx, 0.0), chain, zigzag: None, motif: None, dash: Some(dash) }
    }

    /// Instanz `i` als (a, b, s0, run_len, total, count, dash[8]).
    fn inst(o: &GpuOut, i: usize) -> &[f32] {
        &o.dash_inst[i * DASH_INST_FLOATS..(i + 1) * DASH_INST_FLOATS]
    }

    #[test]
    fn gestrichelte_linie_als_shader_instanz() {
        let o = compile(&plan(vec![dashed(1.0, 4.0, false, vec![0.12, 0.08])]), 90.0, true);
        assert!(o.line_idx.is_empty() && o.line_verts.is_empty(), "keine durchgezogenen Striche mehr");
        assert_eq!(o.dash_inst.len(), DASH_INST_FLOATS);
        let d = inst(&o, 0);
        // Bildschirm-Raum relativ zum Ursprung (erster Punkt).
        assert_eq!(o.origin, (90.0, -0.0));
        assert_eq!(&d[..4], &[0.0, 0.0, 270.0, 0.0]);
        assert_eq!((d[4], d[5], d[7]), (0.0, 270.0, 2.0));
        let (on, off) = ((0.12 * LINE_DASH_MM_TO_M * PX_PER_M) as f32, (0.08 * LINE_DASH_MM_TO_M * PX_PER_M) as f32);
        assert_eq!((d[8], d[9]), (on, off));
        assert!((d[6] - (on + off)).abs() < 1e-4);
        assert!(d[10..].iter().all(|&v| v == 0.0));
        assert_eq!(o.dash_batches.len(), 1);
        assert_eq!((o.dash_batches[0].start, o.dash_batches[0].count, o.dash_batches[0].stroke_mm), (0, 1, 0.25));
        assert_eq!(o.bounds, (1.0, 0.0, 4.0, 0.0));
    }

    #[test]
    fn gestrichelter_zug_phase_laeuft_durch() {
        // Verkettete Linien: ein Zug, Phase über die Ecke, ungerades Muster verdoppelt.
        let o = compile(&plan(vec![dashed(0.0, 1.0, false, vec![1.0]), dashed(1.0, 3.0, true, vec![1.0])]), 90.0, true);
        assert_eq!(o.dash_inst.len(), 2 * DASH_INST_FLOATS);
        assert_eq!(inst(&o, 1)[4], 90.0);
        assert_eq!(inst(&o, 1)[5], 270.0);
        assert_eq!(inst(&o, 1)[7], 2.0);
        assert_eq!(o.dash_batches.len(), 1);
        assert_eq!(o.dash_batches[0].count, 2);
        // Einzeln (nicht verkettet): jede Linie beginnt ihr Muster neu.
        let o = compile(&plan(vec![dashed(0.0, 1.0, false, vec![1.0]), dashed(1.0, 3.0, false, vec![1.0])]), 90.0, true);
        assert_eq!(inst(&o, 1)[4], 0.0);
        assert_eq!(inst(&o, 1)[5], 180.0);
    }

    #[test]
    fn ungueltiges_muster_durchgezogen_langes_muster_zerlegt() {
        let solid = compile(&plan(vec![line(0.0, 1.0, false)]), 90.0, true);
        let o = compile(&plan(vec![dashed(0.0, 1.0, false, vec![0.0, -1.0])]), 90.0, true);
        assert!(o.dash_inst.is_empty());
        assert_eq!(o.line_idx.len(), solid.line_idx.len(), "Nullmuster = durchgezogen");
        let o = compile(&plan(vec![dashed(0.0, 1.0, false, vec![])]), 90.0, true);
        assert!(o.dash_inst.is_empty() && o.line_idx.len() == solid.line_idx.len());
        // 9 Einträge → verdoppelt 18 > MAX_LINE_DASH: CPU-Zerlegung (mehrere Stücke).
        let o = compile(&plan(vec![dashed(0.0, 1.0, false, vec![1.0; 9])]), 90.0, true);
        assert!(o.dash_inst.is_empty());
        assert!(o.line_idx.len() > 2 * solid.line_idx.len());
    }

    #[test]
    fn gestrichelte_boegen_und_kreise() {
        let d = Some(vec![2.0, 1.0]);
        let p = plan(vec![
            Prim::Arc { style: st(), color: 0, weight_mm: 0.18, center: v2(0.0, 0.0), from: v2(1.0, 0.0), to: v2(0.0, 1.0), r: 1.0, dash: d.clone() },
            Prim::Circle { style: st(), fill: 1, stroke: 0, weight_mm: 0.18, center: v2(3.0, 0.0), r: 1.0, dash: d.clone() },
            Prim::DrawingArc { style: st(), stroke: 0, weight_mm: 0.18, center: v2(0.0, 0.0), r: 2.0, a0: 0.0, a1: 1.0, dash: d },
        ]);
        let o = compile(&p, 90.0, true);
        assert!(o.line_idx.is_empty(), "alle Striche gestrichelt");
        assert!(!o.fill_idx.is_empty(), "Kreisfüllung bleibt");
        let n = o.dash_inst.len() / DASH_INST_FLOATS;
        assert!(n > 20);
        // Kreis: geschlossen, die Lauflänge reicht um den ganzen Umfang.
        let circle_run = (0..n).map(|i| inst(&o, i)[5]).fold(0.0f32, f32::max);
        assert!((circle_run as f64 - 2.0 * PI * PX_PER_M).abs() < 2.0, "Kreisumfang {circle_run}");
        // gleiche Farbe/Breite → ein Batch
        assert_eq!(o.dash_batches.len(), 1);
        assert_eq!(o.dash_batches[0].count as usize, n);
    }

    /// Auf der Achse deckt eine Instanz genau die Stücke der CPU-Zerlegung (`apply_dash_runs`,
    /// gleiche Semantik wie die frühere `split_dash`-Zerlegung in render2d): Spiegel des
    /// Fragment-Shaders (`DASH_LINE_WGSL`) für y = 0 und Breite → 0.
    #[test]
    fn deckung_auf_der_achse_wie_zerlegung() {
        let mut seed = 777u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f64 / (1u32 << 24) as f64
        };
        for case in 0..150 {
            let n = 1 + (rnd() * 4.0) as usize;
            let pat: Vec<f64> = (0..n).map(|_| 0.5 + rnd() * 8.0).collect();
            // Zug aus 1–4 kollinearen Stücken entlang x.
            let mut xs = vec![0.0];
            for _ in 0..1 + case % 4 {
                xs.push(xs[xs.len() - 1] + 0.05 + rnd() * 1.5);
            }
            let prims: Vec<Prim> = xs.windows(2).enumerate().map(|(i, w)| dashed(w[0], w[1], i > 0, pat.clone())).collect();
            let o = compile(&plan(prims), 90.0, true);
            let runs = hatch::apply_dash_runs(vec![xs.iter().map(|&x| v2(x, 0.0)).collect()], &line_dash_for_runs(&pat));
            let total_len = xs[xs.len() - 1];
            for _ in 0..300 {
                let x = rnd() * total_len;
                let old = runs.iter().any(|r| x >= r[0].x - 1e-9 && x <= r[r.len() - 1].x + 1e-9);
                let new = (0..o.dash_inst.len() / DASH_INST_FLOATS).any(|i| {
                    let d = inst(&o, i);
                    let sx = (x * PX_PER_M) as f32 - (d[0] + o.origin.0 as f32);
                    let (s0, s1) = (d[4], d[4] + (d[2] - d[0]));
                    let s = d[4] + sx;
                    if s < s0 || s > s1 {
                        return false;
                    }
                    let (total, cnt) = (d[6], d[7] as usize);
                    let k = (s / total).floor();
                    let m = s - k * total;
                    let mut acc = 0.0f32;
                    let mut on = true;
                    for (j, &len) in d[8..8 + cnt].iter().enumerate() {
                        if m >= acc && m < acc + len {
                            on = j % 2 == 0;
                        }
                        acc += len;
                    }
                    on
                });
                // An den Strichgrenzen entscheidet die Rundung — dort nicht vergleichen.
                let near_edge = runs.iter().any(|r| (x - r[0].x).abs() < 1e-4 || (x - r[r.len() - 1].x).abs() < 1e-4);
                assert!(old == new || near_edge, "Fall {case}: x={x} alt {old} neu {new}");
            }
        }
    }

    /// Maler-Reihenfolge: Linie, gestrichelte Linie, Linie (gleicher Stil) bleiben drei Batches in
    /// dieser Folge — die zweite Linie deckt die gestrichelte (z. B. verdeckte Kante unter einer Wand).
    #[test]
    fn strich_batches_in_maler_reihenfolge() {
        let o = compile(&plan(vec![line(0.0, 1.0, false), dashed(0.0, 1.0, false, vec![2.0, 1.0]), dashed(0.0, 2.0, false, vec![2.0, 1.0]), line(2.0, 3.0, false)]), 90.0, true);
        assert_eq!(o.line_batches.len(), 2, "keine Zusammenfassung über den Strich-Batch hinweg");
        assert_eq!(o.dash_batches.len(), 1, "zwei gestrichelte ohne Linie dazwischen = ein Batch");
        assert_eq!(o.dash_batches[0].count, 2);
        assert_eq!(o.dash_batches[0].line_at, o.line_batches[0].count);
        assert_eq!(o.line_batches[1].start, o.dash_batches[0].line_at);
        // Ohne Strich dazwischen werden gleich gestylte Linien weiter zusammengefasst.
        let o = compile(&plan(vec![line(0.0, 1.0, false), line(2.0, 3.0, false)]), 90.0, true);
        assert_eq!(o.line_batches.len(), 1);
    }

    #[test]
    fn flache_ausgabe_traegt_strich_instanzen() {
        let mut w = plan_buf::Writer::new(false);
        w.push(&crate::plan::prim::Primitive::Line {
            a: crate::model::Vec2 { x: 0.0, y: 0.0 },
            b: crate::model::Vec2 { x: 2.0, y: 0.0 },
            cls: "c".into(),
            weight_mm: 0.35,
            dash: Some(Some(vec![3.0, 1.0])),
            zigzag: None,
            motif: None,
            color: Some("#ff0000".into()),
            drawing_id: None,
            opening_id: None,
            stair_id: None,
            greyed: None,
            opacity: None,
        });
        let enc = w.finish();
        let out = compile_flat(&enc, 0, 1, 90.0, true);
        let m = out[0] as usize;
        let meta: Vec<f64> = (0..m).map(|i| f64::from_bits(out[2 + 2 * i] as u64 | ((out[3 + 2 * i] as u64) << 32))).collect();
        let (n_fill, n_line) = (meta[10] as usize, meta[11] as usize);
        assert_eq!((n_fill, n_line), (0, 0));
        let k = 12 + 6 * n_fill + 8 * n_line;
        assert_eq!(meta[k], 1.0, "eine Instanz");
        assert_eq!(meta[k + 1], 1.0, "ein Strich-Batch");
        assert_eq!(&meta[k + 2..k + 10], &[0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.35, 0.0]);
        assert_eq!(meta.len(), k + 10);
        let data = &out[2 + 2 * m..];
        let (nfp, nfi, nlv, nli) = (meta[6] as usize, meta[7] as usize, meta[8] as usize, meta[9] as usize);
        let dash = &data[nfp + nfi + nlv + nli..];
        assert_eq!(dash.len(), DASH_INST_FLOATS);
        assert_eq!(f32::from_bits(dash[2]), 180.0);
        assert_eq!(f32::from_bits(dash[7]), 2.0);
    }
}
