//! Öffnungs-Geometrie im Grundriss ([K3a]): Pfosten, Lücke, Türblätter und das Fenster-Symbol
//! (Rahmen, Glaslinien, Flügel- und Stulpmarken). Port von `src/geometry/opening.ts`; Rechen-
//! reihenfolge und Zahlsemantik wie in TS (`Math.hypot` über `jsmath`, `Math.min/max/round`
//! über `jsnum`, `cos/sin` über `jsnum`), damit die Ausgabe bitgleich bleibt.

use crate::jsmath::hypot2;
use crate::jsnum::{cos, max, min, round, sin};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct V {
    pub x: f64,
    pub y: f64,
}

pub fn v(x: f64, y: f64) -> V {
    V { x, y }
}
pub fn sub(a: V, b: V) -> V {
    v(a.x - b.x, a.y - b.y)
}
pub fn add(a: V, b: V) -> V {
    v(a.x + b.x, a.y + b.y)
}
pub fn scale(a: V, s: f64) -> V {
    v(a.x * s, a.y * s)
}
pub fn dot(p: V, q: V) -> f64 {
    p.x * q.x + p.y * q.y
}
pub fn normalize(a: V) -> V {
    let l = hypot2(a.x, a.y);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    v(a.x / l, a.y / l)
}
pub fn left_normal(a: V) -> V {
    v(-a.y, a.x)
}
pub fn along(p1: V, p2: V, d: f64) -> V {
    add(p1, scale(normalize(sub(p2, p1)), d))
}

const DEG: f64 = std::f64::consts::PI / 180.0;
const DEFAULT_POST_WIDTH: f64 = 0.06;
const DEFAULT_FRAME_DEPTH: f64 = 0.07;

/// Wand für die Öffnungs-Geometrie: Achse, aufgelöste Dicke und Referenzversatz.
#[derive(Clone, Copy, Debug)]
pub struct WallRef {
    pub start: V,
    pub end: V,
    pub total: f64,
    pub ref_off: f64,
}

impl WallRef {
    pub fn frame(&self) -> (V, V) {
        let u = normalize(sub(self.end, self.start));
        (u, left_normal(u))
    }
}

/// Öffnungs-Intervall entlang der Achse (auf die Achslänge geklemmt) oder `None` (entartet).
pub fn opening_interval(w: &WallRef, position: f64, width: f64) -> Option<(f64, f64)> {
    let axis = hypot2(w.end.x - w.start.x, w.end.y - w.start.y);
    let from = max(0.0, min(position, axis));
    let to = max(from, min(position + width, axis));
    if to - from < 1e-4 {
        None
    } else {
        Some((from, to))
    }
}

pub fn opening_jambs(w: &WallRef, position: f64, width: f64) -> Option<(V, V)> {
    let (from, to) = opening_interval(w, position, width)?;
    Some((along(w.start, w.end, from), along(w.start, w.end, to)))
}

/// Lücken-Rechteck über die volle Wanddicke (jambStart+n/2 → jambEnd+n/2 → jambEnd−n/2 → jambStart−n/2).
pub fn opening_gap_quad(w: &WallRef, position: f64, width: f64) -> Option<Vec<V>> {
    let (js, je) = opening_jambs(w, position, width)?;
    let n = w.frame().1;
    let outer = w.ref_off + w.total / 2.0;
    let inner = w.ref_off - w.total / 2.0;
    Some(vec![add(js, scale(n, outer)), add(je, scale(n, outer)), add(je, scale(n, inner)), add(js, scale(n, inner))])
}

#[derive(Clone, Copy, Debug)]
pub struct DoorLeaf {
    pub hinge: V,
    pub open_end: V,
    pub closed_end: V,
    pub radius: f64,
}

fn compute_leaf(hinge: V, closed_dir: V, swing_dir: V, angle: f64, width: f64) -> DoorLeaf {
    let open_dir = v(closed_dir.x * cos(angle) + swing_dir.x * sin(angle), closed_dir.y * cos(angle) + swing_dir.y * sin(angle));
    DoorLeaf { hinge, open_end: add(hinge, scale(open_dir, width)), closed_end: add(hinge, scale(closed_dir, width)), radius: width }
}

/// Tür-Parameter: `swing_right`, `open_out`, `hinge_end` (false = Start), `swing_angle` in Grad.
#[derive(Clone, Copy, Debug)]
pub struct DoorParams {
    pub swing_right: bool,
    pub open_out: bool,
    pub hinge_end: bool,
    pub swing_angle: f64,
}

/// Türblätter (1 oder 2 Flügel); leer bei entarteter Öffnung.
pub fn door_leaves(w: &WallRef, position: f64, width: f64, p: &DoorParams, leaf_count: f64) -> Vec<DoorLeaf> {
    let Some((js, je)) = opening_jambs(w, position, width) else { return Vec::new() };
    let (u, n) = w.frame();
    let wd = hypot2(je.x - js.x, je.y - js.y);
    let swing_sign = if p.swing_right { -1.0 } else { 1.0 };
    let dir_sign = if p.open_out { -1.0 } else { 1.0 };
    let swing_dir = scale(n, swing_sign * dir_sign);
    let angle = p.swing_angle * DEG;
    if leaf_count >= 2.0 {
        let hw = wd / 2.0;
        return vec![compute_leaf(js, u, swing_dir, angle, hw), compute_leaf(je, scale(u, -1.0), swing_dir, angle, hw)];
    }
    let (hinge, closed_dir) = if p.hinge_end { (je, scale(u, -1.0)) } else { (js, u) };
    vec![compute_leaf(hinge, closed_dir, swing_dir, angle, wd)]
}

/// Eintrag der Flügeleinteilung.
#[derive(Clone, Copy, Debug)]
pub struct Sash {
    pub post: bool,
    /// `false` ⇔ `autoWidth === false`.
    pub auto_width: bool,
    /// feste Breite (nur wenn `!auto_width`), NaN = nicht gesetzt
    pub width: f64,
    pub post_width: f64,
    pub operable: bool,
}

#[derive(Clone, Debug)]
pub struct WindowSpec {
    pub sashes: Vec<Sash>,
    pub frame_width: f64,
    /// NaN = nicht gesetzt
    pub frame_depth: f64,
    /// NaN = nicht gesetzt
    pub inset_from_face: f64,
    pub inset_inner: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Detail {
    Grob,
    Mittel,
    Fein,
}

#[derive(Default, Clone, Debug)]
pub struct WindowSymbol {
    pub frame: Vec<V>,
    pub glass_lines: Vec<(V, V)>,
    pub mullion_lines: Vec<(V, V)>,
    pub sash_frames: Vec<Vec<V>>,
    pub meeting_marks: Vec<Vec<V>>,
    pub jamb_marks: Vec<Vec<V>>,
}

fn or_zero(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else {
        x
    }
}

fn sash_segments(sashes: &[Sash], total_width: f64) -> Vec<(usize, f64, f64)> {
    if sashes.is_empty() {
        return Vec::new();
    }
    let post_w = |s: &Sash| max(0.0, if s.post_width.is_nan() { DEFAULT_POST_WIDTH } else { s.post_width });
    let fixed_w = |s: &Sash| max(0.0, or_zero(s.width));
    let mut fixed_sum = 0.0;
    let mut auto_count = 0.0;
    for s in sashes {
        if s.post {
            fixed_sum += post_w(s);
        } else if !s.auto_width {
            fixed_sum += fixed_w(s);
        } else {
            auto_count += 1.0;
        }
    }
    let remaining = max(0.0, total_width - fixed_sum);
    let auto_width = if auto_count > 0.0 { remaining / auto_count } else { 0.0 };
    let mut segs = Vec::with_capacity(sashes.len());
    let mut cursor = 0.0;
    for (i, s) in sashes.iter().enumerate() {
        let w = if s.post {
            post_w(s)
        } else if !s.auto_width {
            fixed_w(s)
        } else {
            auto_width
        };
        segs.push((i, cursor, cursor + w));
        cursor += w;
    }
    segs
}

/// Fenster-Symbol; `spec` nur mit auflösbarem Typ (sonst Alt-Pfad mit `wing_count`, NaN = 1).
pub fn window_symbol(
    w: &WallRef,
    position: f64,
    width: f64,
    glass_count: f64,
    spec: Option<&WindowSpec>,
    wing_count: f64,
    detail: Detail,
) -> Option<WindowSymbol> {
    let (js, je) = opening_jambs(w, position, width)?;
    let n = w.frame().1;
    let total = w.total;
    let ref_off = w.ref_off;
    let outer = ref_off + total / 2.0;
    let inner = ref_off - total / 2.0;

    if let Some(spec) = spec.filter(|s| !s.sashes.is_empty()) {
        let fw = max(0.01, spec.frame_width);
        let depth = min(total, if !spec.frame_depth.is_nan() && spec.frame_depth > 1e-9 { spec.frame_depth } else { DEFAULT_FRAME_DEPTH });
        let inset = max(0.0, or_zero(spec.inset_from_face));
        let half_t = total / 2.0;
        let sign = if spec.inset_inner { 1.0 } else { -1.0 };
        let mut front_rel = sign * (half_t - inset);
        let mut back_rel = front_rel - sign * depth;
        front_rel = max(-half_t, min(half_t, front_rel));
        back_rel = max(-half_t, min(half_t, back_rel));
        let frame_outer_n = ref_off + max(front_rel, back_rel);
        let frame_inner_n = ref_off + min(front_rel, back_rel);
        let band_depth = frame_outer_n - frame_inner_n;
        let g_mid_base = (frame_outer_n + frame_inner_n) / 2.0;

        let frame = vec![
            add(js, scale(n, frame_outer_n)),
            add(je, scale(n, frame_outer_n)),
            add(je, scale(n, frame_inner_n)),
            add(js, scale(n, frame_inner_n)),
        ];
        let mut sym = WindowSymbol { frame, ..Default::default() };

        if detail == Detail::Grob {
            sym.glass_lines.push((add(js, scale(n, g_mid_base)), add(je, scale(n, g_mid_base))));
            return Some(sym);
        }
        let fein = detail == Detail::Fein;
        let axis_width = hypot2(je.x - js.x, je.y - js.y);
        let segs = sash_segments(&spec.sashes, axis_width);
        let reveal = if fein { min(band_depth * 0.3, fw * 0.7) } else { 0.0 };
        let frame_block = |u_center: f64, half_u: f64| -> Vec<V> {
            let a = along(js, je, u_center - half_u);
            let b = along(js, je, u_center + half_u);
            vec![add(a, scale(n, frame_outer_n)), add(b, scale(n, frame_outer_n)), add(b, scale(n, frame_inner_n)), add(a, scale(n, frame_inner_n))]
        };
        sym.jamb_marks.push(frame_block(fw / 2.0, fw / 2.0));
        sym.jamb_marks.push(frame_block(axis_width - fw / 2.0, fw / 2.0));
        for i in 0..segs.len().saturating_sub(1) {
            let u_pos = segs[i].2;
            if fein {
                sym.meeting_marks.push(frame_block(u_pos - fw / 2.0, fw / 2.0));
                sym.meeting_marks.push(frame_block(u_pos + fw / 2.0, fw / 2.0));
            } else {
                sym.meeting_marks.push(frame_block(u_pos, fw / 2.0));
            }
        }
        for &(si, from, to) in &segs {
            let s = &spec.sashes[si];
            if s.post {
                continue;
            }
            let clear_from = from + fw;
            let clear_to = to - fw;
            if clear_to - clear_from <= 1e-6 {
                continue;
            }
            if !fein {
                continue;
            }
            let g_outer_n = frame_outer_n - if s.operable { reveal } else { 0.0 };
            let g_inner_n = frame_inner_n + if s.operable { reveal } else { 0.0 };
            if s.operable {
                let s_from = along(js, je, clear_from);
                let s_to = along(js, je, clear_to);
                sym.sash_frames.push(vec![
                    add(s_from, scale(n, g_outer_n)),
                    add(s_to, scale(n, g_outer_n)),
                    add(s_to, scale(n, g_inner_n)),
                    add(s_from, scale(n, g_inner_n)),
                ]);
            }
        }
        return Some(sym);
    }

    // Alt-Pfad
    let frame = vec![add(js, scale(n, outer)), add(je, scale(n, outer)), add(je, scale(n, inner)), add(js, scale(n, inner))];
    let mut sym = WindowSymbol { frame, ..Default::default() };
    let count = max(1.0, glass_count);
    let mut i = 0.0;
    while i < count {
        let spread = total / 8.0;
        let off = ref_off + if count == 1.0 { 0.0 } else { (i - (count - 1.0) / 2.0) * spread * 2.0 };
        sym.glass_lines.push((add(js, scale(n, off)), add(je, scale(n, off))));
        i += 1.0;
    }
    let wc = if wing_count.is_nan() { 1.0 } else { wing_count };
    let wings = max(1.0, min(4.0, round(wc)));
    if wings > 1.0 {
        let post_depth = total * 0.6;
        let p_outer = ref_off + post_depth / 2.0;
        let p_inner = ref_off - post_depth / 2.0;
        let mut k = 1.0;
        while k < wings {
            let t = k / wings;
            let on_axis = add(js, scale(sub(je, js), t));
            sym.mullion_lines.push((add(on_axis, scale(n, p_outer)), add(on_axis, scale(n, p_inner))));
            k += 1.0;
        }
    }
    Some(sym)
}
