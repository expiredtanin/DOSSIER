//! Treppengeometrie (gerade, L, U, Podest, Spindel), Umriss, Schnitt, Bounding-Box und Treffertest; gerufen von Plan, Schnitt und 3D über `dossier-core`.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use crate::*;
use serde::{Deserialize, Serialize};

pub const IDEAL_RISER: f64 = 0.17;
pub const IDEAL_TREAD: f64 = 0.29;
pub const MIN_STEPS: i64 = 2;
pub(crate) const DEG: f64 = std::f64::consts::PI / 180.0;

/// norm in stair.ts: `lenOf(a) || 1e-9` (NICHT EPS!).
#[inline]
fn stair_norm(a: Vec2) -> Vec2 {
    let l = len(a);
    let l = if l == 0.0 { 1e-9 } else { l };
    Vec2 { x: a.x / l, y: a.y / l }
}

/// Linke Normale (stair.ts `leftN`).
#[inline]
fn stair_left_n(u: Vec2) -> Vec2 {
    Vec2 { x: -u.y, y: u.x }
}

/// Sinnvolle Default-Stufenzahl (Port von `defaultStepCount`).
pub fn default_step_count(total_rise: f64, run_length: f64) -> i64 {
    let by_rise = (total_rise / IDEAL_RISER).round() as i64;
    let by_rise = if by_rise < MIN_STEPS { MIN_STEPS } else { by_rise };
    let max_by_run = if run_length > 0.0 {
        let v = (run_length / 0.24).floor() as i64 + 1;
        if v < MIN_STEPS { MIN_STEPS } else { v }
    } else {
        by_rise
    };
    let res = if by_rise < max_by_run { by_rise } else { max_by_run };
    if res < MIN_STEPS { MIN_STEPS } else { res }
}

/// Ein Tritt im Grundriss (Port von `TreadRect`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreadRect {
    pub pts: Vec<Vec2>,
    pub index: i64,
    pub top_rise: f64,
    pub base_rise: f64,
}

/// Vollstaendige abgeleitete Treppengeometrie (Port von `StairGeometry`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StairGeometry {
    pub treads: Vec<TreadRect>,
    pub landing: Option<Vec<Vec2>>,
    /// [151] Zweites Podest (U-Treppe mit Mittellauf: zweites Viertelpodest).
    #[serde(default)]
    pub landing2: Option<Vec<Vec2>>,
    pub riser_height: f64,
    pub tread_depth: f64,
    pub run_line: Vec<Vec2>,
    pub arrow: StairArrow,
    pub total_rise: f64,
}

/// Auf-/Abpfeil (Port von `arrow`-Typ in stair.ts).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StairArrow {
    pub shaft: (Vec2, Vec2),
    pub head: (Vec2, Vec2, Vec2),
}

/// Schnitt-Aufteilung (Port von `StairCut`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StairCut {
    pub below_indices: Vec<i64>,
    pub above_indices: Vec<i64>,
    pub break_line: Option<Vec<(Vec2, Vec2)>>,
}

/// Achsparallele BBox (Treppen, eigenes Struct um Konflikte zu vermeiden).
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StairBBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Tritt-Rechteck zwischen Achsparametern `a0..a1` entlang `dir`, Breite `half_w`
/// (Port der lokalen Hilfsfunktion `treadRect`).
fn tread_rect_pts(origin: Vec2, dir: Vec2, n: Vec2, a0: f64, a1: f64, half_w: f64) -> Vec<Vec2> {
    let p0 = add(origin, scale(dir, a0));
    let p1 = add(origin, scale(dir, a1));
    vec![
        add(p0, scale(n, half_w)),
        add(p1, scale(n, half_w)),
        add(p1, scale(n, -half_w)),
        add(p0, scale(n, -half_w)),
    ]
}

/// Auf-/Abpfeil aus der Lauflinie (Port von `arrowFor`).
fn arrow_for(run_line: &[Vec2], up: bool) -> StairArrow {
    let a = run_line[0];
    let b = run_line[run_line.len() - 1];
    let tip = if up { b } else { a };
    let from = if up {
        run_line[run_line.len() - 2]
    } else {
        run_line[1]
    };
    let dir = stair_norm(sub(tip, from));
    let n = stair_left_n(dir);
    let s = 0.22_f64;
    let back = add(tip, scale(dir, -s));
    let w1 = add(back, scale(n, s * 0.55));
    let w2 = add(back, scale(n, -s * 0.55));
    StairArrow { shaft: (a, b), head: (w1, tip, w2) }
}

/// Achteck-Approximation des Wendel-Auges (Port von `eyePolygon`, 12 Segmente).
fn eye_polygon(center: Vec2, r: f64) -> Vec<Vec2> {
    (0..12).map(|i| {
        let t = (i as f64 / 12.0) * std::f64::consts::PI * 2.0;
        Vec2 { x: center.x + r * t.cos(), y: center.y + r * t.sin() }
    }).collect()
}

/// Treppen-Parameter (enthaelt alle geometrisch relevanten
/// Felder des TS-Typs `Stair`; Modell-Semantik-Felder wie id/floorId werden
/// ignoriert).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StairParams {
    pub shape: String,
    pub start: Vec2,
    pub dir: Vec2,
    pub run_length: f64,
    #[serde(default)]
    pub run2_length: Option<f64>,
    #[serde(default)]
    pub turn: Option<i32>,
    #[serde(default)]
    pub center: Option<Vec2>,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub sweep: Option<f64>,
    pub width: f64,
    pub step_count: i64,
    #[serde(default)]
    pub up: Option<bool>,
    /// Bezugskante der gespeicherten Achse: "links" | "mitte" | "rechts" (fehlend = Mitte).
    #[serde(default)]
    pub referenz: Option<String>,
    /// [151] U: lichte Weite des Treppenauges zwischen erstem und letztem Lauf (Meter).
    #[serde(default)]
    pub gap: Option<f64>,
    /// [151] U / gerade mit Podest: Podesttiefe in Laufrichtung (Meter; fehlend = Laufbreite).
    #[serde(default)]
    pub landing_length: Option<f64>,
    /// [151] L / U / gerade mit Podest: Steigungen im ersten Lauf (fehlend = nach Lauflängen).
    #[serde(default)]
    pub run1_steps: Option<i64>,
    /// [151] U: Steigungen im Mittellauf quer über das Auge (zwei Viertelpodeste); fehlend/0 = Halbpodest.
    #[serde(default)]
    pub mid_steps: Option<i64>,
    /// [151] U: Versatz des letzten Laufs ins Podest hinein (Meter, entlang Lauf 1).
    #[serde(default)]
    pub run2_offset: Option<f64>,
    /// [151] U mit Mittellauf: Verschiebung des Mittellaufs im Auge zur Wendeseite hin (Meter; fehlend = mittig).
    /// Podest 1 wird um den Betrag tiefer, Podest 2 kürzer; begrenzt auf die Reserve im Auge.
    #[serde(default)]
    pub mid_offset: Option<f64>,
}

/// Achse auf die visuelle Treppen-MITTE versetzen (Referenz links/rechts): `start` und `center`
/// wandern um ±halbe Breite quer zur Laufrichtung. "mitte"/fehlend: unverändert.
/// `links` = Achse ist die linke Kante, die Mitte liegt eine halbe Breite rechts (−n).
fn stair_at_mid(stair: &StairParams, u: Vec2, half_w: f64) -> StairParams {
    let mut s = stair.clone();
    let mid_off = match stair.referenz.as_deref() {
        Some("links") => -half_w,
        Some("rechts") => half_w,
        _ => return s,
    };
    let c = scale(stair_left_n(u), mid_off);
    s.start = add(stair.start, c);
    s.center = stair.center.map(|ce| add(ce, c));
    s
}

/// Gerade Treppe (Port von `straightGeometry`).
fn straight_geometry(
    stair: &StairParams,
    total_rise: f64,
    steps: i64,
    riser_height: f64,
    half_w: f64,
    u: Vec2,
    n: Vec2,
) -> StairGeometry {
    let run_length = stair.run_length.max(0.1);
    let tread_depth = run_length / steps as f64;
    let mut treads: Vec<TreadRect> = Vec::new();
    for i in 0..steps {
        treads.push(TreadRect {
            pts: tread_rect_pts(stair.start, u, n, i as f64 * tread_depth, (i + 1) as f64 * tread_depth, half_w),
            index: i,
            base_rise: i as f64 * riser_height,
            top_rise: (i + 1) as f64 * riser_height,
        });
    }
    let run_line: Vec<Vec2> = vec![
        add(stair.start, scale(u, tread_depth * 0.5)),
        add(stair.start, scale(u, run_length - tread_depth * 0.15)),
    ];
    let up = stair.up.unwrap_or(true);
    StairGeometry {
        arrow: arrow_for(&run_line, up),
        treads,
        landing: None,
        landing2: None,
        riser_height,
        tread_depth,
        run_line,
        total_rise,
    }
}

/// L-Treppe (Port von `lGeometry`).
fn l_geometry(
    stair: &StairParams,
    total_rise: f64,
    steps: i64,
    riser_height: f64,
    half_w: f64,
    u: Vec2,
    n: Vec2,
) -> StairGeometry {
    let run1 = stair.run_length.max(0.1);
    let run2 = stair.run2_length.unwrap_or(stair.run_length).max(0.1);
    let turn = stair.turn.unwrap_or(1);
    let (s1, s2) = split_steps(steps - 1, run1, run2, stair.run1_steps);
    let td1 = run1 / s1 as f64;
    let td2 = run2 / s2 as f64;

    let mut treads: Vec<TreadRect> = Vec::new();
    let mut rise = 0.0_f64;
    for i in 0..s1 {
        treads.push(TreadRect {
            pts: tread_rect_pts(stair.start, u, n, i as f64 * td1, (i + 1) as f64 * td1, half_w),
            index: i,
            base_rise: rise,
            top_rise: rise + riser_height,
        });
        rise += riser_height;
    }
    let corner_center = add(stair.start, scale(u, run1 + half_w));
    let u2: Vec2 = if turn > 0 { n } else { scale(n, -1.0) };
    let n2 = stair_left_n(u2);
    let landing: Vec<Vec2> = vec![
        add(add(corner_center, scale(u, -half_w)), scale(n, half_w)),
        add(add(corner_center, scale(u, half_w)), scale(n, half_w)),
        add(add(corner_center, scale(u, half_w)), scale(n, -half_w)),
        add(add(corner_center, scale(u, -half_w)), scale(n, -half_w)),
    ];
    rise += riser_height; // Podest-Tritt
    let run2_start = add(corner_center, scale(u2, half_w));
    for i in 0..s2 {
        treads.push(TreadRect {
            pts: tread_rect_pts(run2_start, u2, n2, i as f64 * td2, (i + 1) as f64 * td2, half_w),
            index: s1 + 1 + i,
            base_rise: rise,
            top_rise: rise + riser_height,
        });
        rise += riser_height;
    }
    let run_line: Vec<Vec2> = vec![
        add(stair.start, scale(u, td1 * 0.5)),
        corner_center,
        add(run2_start, scale(u2, run2 - td2 * 0.15)),
    ];
    let up = stair.up.unwrap_or(true);
    StairGeometry {
        arrow: arrow_for(&run_line, up),
        treads,
        landing: Some(landing),
        landing2: None,
        riser_height,
        tread_depth: td1,
        run_line,
        total_rise,
    }
}

/// Stufen zweier Läufe: `body` Steigungen ohne Podest, Lauf 1 vorgegeben (auf 1 … body−1 begrenzt) oder
/// nach Lauflängen (wie bisher bei L), Lauf 2 der Rest (mindestens 1).
fn split_steps(body: i64, run1: f64, run2: f64, run1_steps: Option<i64>) -> (i64, i64) {
    let s1 = match run1_steps {
        Some(n) => n.min(body - 1).max(1),
        None => {
            let v = ((body as f64 * run1) / (run1 + run2)).round() as i64;
            if v < 1 { 1 } else { v }
        }
    };
    let s2 = {
        let v = body - s1;
        if v < 1 { 1 } else { v }
    };
    (s1, s2)
}

/// Endliche, nicht negative Länge oder Vorgabe.
fn len_or(v: Option<f64>, fallback: f64) -> f64 {
    match v {
        Some(x) if x.is_finite() && x >= 0.0 => x,
        _ => fallback,
    }
}

/// Vieleck gegen den Uhrzeigersinn, ohne doppelte und ohne kollineare Ecken.
fn clean_ccw(pts: Vec<Vec2>) -> Vec<Vec2> {
    let same = |a: Vec2, b: Vec2| (a.x - b.x).abs() <= 1e-9 && (a.y - b.y).abs() <= 1e-9;
    let mut v: Vec<Vec2> = Vec::with_capacity(pts.len());
    for p in pts {
        if v.last().map_or(true, |q| !same(*q, p)) {
            v.push(p);
        }
    }
    while v.len() > 1 && same(v[0], v[v.len() - 1]) {
        v.pop();
    }
    let mut changed = true;
    while changed && v.len() > 3 {
        changed = false;
        let n = v.len();
        for i in 0..n {
            let (a, b, c) = (v[(i + n - 1) % n], v[i], v[(i + 1) % n]);
            let cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
            if cr.abs() <= 1e-9 {
                v.remove(i);
                changed = true;
                break;
            }
        }
    }
    let area: f64 = (0..v.len())
        .map(|i| {
            let (a, b) = (v[i], v[(i + 1) % v.len()]);
            a.x * b.y - b.x * a.y
        })
        .sum();
    if area < 0.0 {
        v.reverse();
    }
    v
}

/// [151] Stufen der U-Treppe: (Mittellauf, Lauf 1, letzter Lauf); jedes Podest belegt eine Steigung.
fn u_counts(stair: &StairParams, steps: i64, run1: f64, run2: f64) -> (i64, i64, i64) {
    let want_mid = stair.mid_steps.unwrap_or(0).max(0);
    // Mittellauf: mindestens eine Steigung je Lauf und zwei Podeste übrig lassen.
    let mid = if want_mid > 0 { want_mid.min(steps - 4).max(0) } else { 0 };
    let landings = if mid > 0 { 2 } else { 1 };
    let (s1, s2) = split_steps(steps - landings - mid, run1, run2, stair.run1_steps);
    (mid, s1, s2)
}

/// [151] Masse einer U-Treppe im Laufsystem (u entlang Lauf 1, v zur Wendeseite).
struct UFrame {
    start: Vec2,
    u: Vec2,
    side: Vec2,
    half_w: f64,
    run1: f64,
    run2: f64,
    landing: f64,
    gap: f64,
    /// Abstand der Mittellinien von Lauf 1 und letztem Lauf.
    off: f64,
    /// Versatz des letzten Laufs ins Podest hinein.
    offset: f64,
    /// Steigungen im Mittellauf (0 = Halbpodest), Auftritt dort, Verlängerung von Podest 1 und Podest 2
    /// ins Auge (ungleich bei versetztem Mittellauf).
    mid: i64,
    td_mid: f64,
    ext: f64,
    ext2: f64,
}

impl UFrame {
    fn at(&self, u: f64, v: f64) -> Vec2 {
        add(add(self.start, scale(self.u, u)), scale(self.side, v))
    }
    fn of(stair: &StairParams, half_w: f64, u: Vec2, n: Vec2, td1: f64, mid: i64) -> Self {
        let w = 2.0 * half_w;
        let run1 = stair.run_length.max(0.1);
        let run2 = stair.run2_length.unwrap_or(stair.run_length).max(0.1);
        let gap = len_or(stair.gap, 0.1);
        let mut landing = len_or(stair.landing_length, w).max(0.1);
        let (td_mid, ext, ext2) = if mid > 0 {
            landing = landing.max(w);
            let td = td1.min(gap / mid as f64);
            let e = (gap - mid as f64 * td).max(0.0) / 2.0;
            let o = stair.mid_offset.filter(|o| o.is_finite()).unwrap_or(0.0).max(-e).min(e);
            (td, e + o, e - o)
        } else {
            (0.0, 0.0, 0.0)
        };
        let offset = stair.run2_offset.filter(|o| o.is_finite()).unwrap_or(0.0).max(-run1).min(landing);
        let side = if stair.turn.unwrap_or(1) > 0 { n } else { scale(n, -1.0) };
        UFrame { start: stair.start, u, side, half_w, run1, run2, landing, gap, off: w + gap, offset, mid, td_mid, ext, ext2 }
    }
    fn from_params(stair: &StairParams, half_w: f64, u: Vec2, n: Vec2) -> Self {
        let run1 = stair.run_length.max(0.1);
        let run2 = stair.run2_length.unwrap_or(stair.run_length).max(0.1);
        let (mid, s1, _) = u_counts(stair, stair.step_count.max(MIN_STEPS), run1, run2);
        UFrame::of(stair, half_w, u, n, run1 / s1 as f64, mid)
    }
    /// u der Wende (Lauflinie quer): Podestmitte bzw. Mitte des Mittellaufs.
    fn turn_u(&self) -> f64 {
        if self.mid > 0 {
            self.run1 + self.landing - self.half_w
        } else {
            self.run1 + self.landing / 2.0
        }
    }
    /// Podeste: Halbpodest (über beide Läufe und das Auge) bzw. zwei Viertelpodeste.
    fn landings(&self) -> (Vec<Vec2>, Option<Vec<Vec2>>) {
        let (hw, r1, o, off) = (self.half_w, self.run1, self.offset, self.off);
        let end = r1 + self.landing;
        if self.mid > 0 {
            let a = clean_ccw(vec![self.at(r1, -hw), self.at(end, -hw), self.at(end, hw + self.ext), self.at(r1, hw + self.ext)]);
            let v0 = off - hw - self.ext2;
            let b = clean_ccw(vec![self.at(r1 + o, v0), self.at(end, v0), self.at(end, off + hw), self.at(r1 + o, off + hw)]);
            return (a, Some(b));
        }
        let mid_v = hw + self.gap / 2.0;
        let a = vec![self.at(r1, -hw), self.at(end, -hw), self.at(end, off + hw), self.at(r1 + o, off + hw), self.at(r1 + o, mid_v), self.at(r1, mid_v)];
        (clean_ccw(a), None)
    }
    /// Aussenlinie: aussen um Lauf 1, Podest(e), letzten Lauf; innen um das Auge.
    fn outline(&self) -> Vec<Vec2> {
        let (hw, r1, o, off) = (self.half_w, self.run1, self.offset, self.off);
        let end = r1 + self.landing;
        let back = r1 + o - self.run2;
        let mut pts = vec![self.at(0.0, -hw), self.at(end, -hw), self.at(end, off + hw), self.at(back, off + hw), self.at(back, off - hw), self.at(r1 + o, off - hw)];
        if self.mid > 0 {
            // Innenkante des Mittellaufs (Podeste sind mindestens so tief wie der Lauf breit).
            let inner = end - 2.0 * hw;
            let (v0, v1) = (off - hw - self.ext2, hw + self.ext);
            pts.extend([self.at(r1 + o, v0), self.at(inner, v0), self.at(inner, v1), self.at(r1, v1)]);
        } else {
            let mid_v = hw + self.gap / 2.0;
            pts.extend([self.at(r1 + o, mid_v), self.at(r1, mid_v)]);
        }
        pts.extend([self.at(r1, hw), self.at(0.0, hw)]);
        clean_ccw(pts)
    }
}

/// [151] U-Treppe: Lauf 1, Halbpodest (oder zwei Viertelpodeste mit Mittellauf quer über das Auge),
/// letzter Lauf gegenläufig daneben. Tritt-Indizes wie bei L: jedes Podest belegt eine Steigung.
fn u_geometry(stair: &StairParams, total_rise: f64, steps: i64, riser_height: f64, half_w: f64, u: Vec2, n: Vec2) -> StairGeometry {
    let run1 = stair.run_length.max(0.1);
    let run2 = stair.run2_length.unwrap_or(stair.run_length).max(0.1);
    let (mid, s1, s2) = u_counts(stair, steps, run1, run2);
    let td1 = run1 / s1 as f64;
    let td2 = run2 / s2 as f64;
    let f = UFrame::of(stair, half_w, u, n, td1, mid);
    let mut treads: Vec<TreadRect> = Vec::new();
    let mut k = 0_i64;
    let mut push = |pts: Vec<Vec2>, k: &mut i64| {
        treads.push(TreadRect { pts, index: *k, base_rise: *k as f64 * riser_height, top_rise: (*k + 1) as f64 * riser_height });
        *k += 1;
    };
    for i in 0..s1 {
        push(tread_rect_pts(stair.start, u, n, i as f64 * td1, (i + 1) as f64 * td1, half_w), &mut k);
    }
    k += 1; // Podest
    if mid > 0 {
        // Mittellauf zur Wendeseite, mittig auf der Lauflinie der Wende.
        let mid_start = f.at(f.turn_u(), half_w + f.ext);
        let n_mid = stair_left_n(f.side);
        for i in 0..mid {
            push(tread_rect_pts(mid_start, f.side, n_mid, i as f64 * f.td_mid, (i + 1) as f64 * f.td_mid, half_w), &mut k);
        }
        k += 1; // zweites Podest
    }
    let u2 = scale(u, -1.0);
    let n2 = stair_left_n(u2);
    let run2_start = f.at(f.run1 + f.offset, f.off);
    for i in 0..s2 {
        push(tread_rect_pts(run2_start, u2, n2, i as f64 * td2, (i + 1) as f64 * td2, half_w), &mut k);
    }
    let tu = f.turn_u();
    let run_line: Vec<Vec2> = vec![
        add(stair.start, scale(u, td1 * 0.5)),
        f.at(tu, 0.0),
        f.at(tu, f.off),
        add(run2_start, scale(u2, run2 - td2 * 0.15)),
    ];
    let (l1, l2) = f.landings();
    let up = stair.up.unwrap_or(true);
    StairGeometry { arrow: arrow_for(&run_line, up), treads, landing: Some(l1), landing2: l2, riser_height, tread_depth: td1, run_line, total_rise }
}

/// [151] Gerade Treppe mit Zwischenpodest: Lauf 1, Podest, Lauf 2 in derselben Richtung.
fn landing_geometry(stair: &StairParams, total_rise: f64, steps: i64, riser_height: f64, half_w: f64, u: Vec2, n: Vec2) -> StairGeometry {
    let run1 = stair.run_length.max(0.1);
    let run2 = stair.run2_length.unwrap_or(stair.run_length).max(0.1);
    let land = len_or(stair.landing_length, 2.0 * half_w).max(0.1);
    let (s1, s2) = split_steps(steps - 1, run1, run2, stair.run1_steps);
    let td1 = run1 / s1 as f64;
    let td2 = run2 / s2 as f64;
    let mut treads: Vec<TreadRect> = Vec::new();
    for i in 0..s1 {
        treads.push(TreadRect {
            pts: tread_rect_pts(stair.start, u, n, i as f64 * td1, (i + 1) as f64 * td1, half_w),
            index: i,
            base_rise: i as f64 * riser_height,
            top_rise: (i + 1) as f64 * riser_height,
        });
    }
    let run2_start = add(stair.start, scale(u, run1 + land));
    for i in 0..s2 {
        let k = s1 + 1 + i;
        treads.push(TreadRect {
            pts: tread_rect_pts(run2_start, u, n, i as f64 * td2, (i + 1) as f64 * td2, half_w),
            index: k,
            base_rise: k as f64 * riser_height,
            top_rise: (k + 1) as f64 * riser_height,
        });
    }
    let landing = tread_rect_pts(stair.start, u, n, run1, run1 + land, half_w);
    let run_line: Vec<Vec2> = vec![add(stair.start, scale(u, td1 * 0.5)), add(run2_start, scale(u, run2 - td2 * 0.15))];
    let up = stair.up.unwrap_or(true);
    StairGeometry { arrow: arrow_for(&run_line, up), treads, landing: Some(landing), landing2: None, riser_height, tread_depth: td1, run_line, total_rise }
}

/// Wendeltreppe (Port von `spiralGeometry`).
fn spiral_geometry(
    stair: &StairParams,
    total_rise: f64,
    steps: i64,
    riser_height: f64,
    half_w: f64,
) -> StairGeometry {
    let center = stair.center.unwrap_or(stair.start);
    let radius = (half_w + 0.1).max(stair.radius.unwrap_or(stair.width));
    let sweep = stair.sweep.unwrap_or(270.0) * DEG;
    let start_vec = sub(stair.start, center);
    let a0 = start_vec.y.atan2(start_vec.x);
    let d_a = sweep / steps as f64;
    let r_in = (radius - half_w).max(0.02);
    let r_out = radius + half_w;

    let mut treads: Vec<TreadRect> = Vec::new();
    for i in 0..steps {
        let t0 = a0 + i as f64 * d_a;
        let t1 = a0 + (i + 1) as f64 * d_a;
        let pts: Vec<Vec2> = vec![
            Vec2 { x: center.x + r_in * t0.cos(), y: center.y + r_in * t0.sin() },
            Vec2 { x: center.x + r_out * t0.cos(), y: center.y + r_out * t0.sin() },
            Vec2 { x: center.x + r_out * t1.cos(), y: center.y + r_out * t1.sin() },
            Vec2 { x: center.x + r_in * t1.cos(), y: center.y + r_in * t1.sin() },
        ];
        treads.push(TreadRect {
            pts,
            index: i,
            base_rise: i as f64 * riser_height,
            top_rise: (i + 1) as f64 * riser_height,
        });
    }
    let n_seg = steps.max(2) as usize;
    let mut run_line: Vec<Vec2> = Vec::new();
    for i in 0..=n_seg {
        let tt = a0 + (sweep * i as f64) / n_seg as f64;
        run_line.push(Vec2 { x: center.x + radius * tt.cos(), y: center.y + radius * tt.sin() });
    }
    let tread_depth = (2.0 * std::f64::consts::PI * radius * (sweep / (2.0 * std::f64::consts::PI))) / steps as f64;
    let up = stair.up.unwrap_or(true);
    StairGeometry {
        arrow: arrow_for(&run_line, up),
        treads,
        landing: Some(eye_polygon(center, r_in)),
        landing2: None,
        riser_height,
        tread_depth,
        run_line,
        total_rise,
    }
}

/// Vollstaendige Treppengeometrie (Port von `stairGeometry`).
pub fn stair_geometry(stair: &StairParams, total_rise: f64) -> StairGeometry {
    let steps = (stair.step_count as i64).max(MIN_STEPS);
    let riser_height = total_rise / steps as f64;
    let half_w = (0.05_f64).max(stair.width / 2.0);
    let u = stair_norm(stair.dir);
    let n = stair_left_n(u);
    let s = stair_at_mid(stair, u, half_w);
    let stair = &s;

    if stair.shape == "spiral" {
        return spiral_geometry(stair, total_rise, steps, riser_height, half_w);
    }
    if stair.shape == "L" {
        return l_geometry(stair, total_rise, steps, riser_height, half_w, u, n);
    }
    if stair.shape == "U" {
        return u_geometry(stair, total_rise, steps, riser_height, half_w, u, n);
    }
    if stair.shape == "straightLanding" {
        return landing_geometry(stair, total_rise, steps, riser_height, half_w, u, n);
    }
    straight_geometry(stair, total_rise, steps, riser_height, half_w, u, n)
}

/// Aussenlinie einer Wendeltreppe: radiale Schliesslinien + Innen-/Aussenbogen.
#[derive(Clone, Debug)]
pub struct SpiralOutline {
    /// Radiale Abschlusslinien (Innenpunkt → Aussenpunkt) bei a0 und a1.
    pub lines: [(Vec2, Vec2); 2],
    /// Kreisbögen (Mittelpunkt, r, a0, a1): Innen- und Aussenkreis.
    pub arcs: [(Vec2, f64, f64, f64); 2],
}

/// Plan-Aussenlinie: genau eines von `polygon` (gerade/L) bzw. `spiral` (Wendel) ist gesetzt.
#[derive(Clone, Debug)]
pub struct StairOutline {
    pub polygon: Option<Vec<Vec2>>,
    pub spiral: Option<SpiralOutline>,
}

/// Linien-Schnittpunkt wie TS `lineIntersect2d` (det < 1e-9 → None).
fn stair_line_intersect(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2) -> Option<Vec2> {
    let det = d1.x * (-d2.y) - d1.y * (-d2.x);
    if det.abs() < 1e-9 {
        return None;
    }
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    let t = (dx * (-d2.y) - dy * (-d2.x)) / det;
    Some(Vec2 { x: p1.x + d1.x * t, y: p1.y + d1.y * t })
}

/// Aussenlinie einer Treppe im Grundriss (Port von `stairOutline`; Referenz wie in `stair_geometry`).
pub fn stair_outline(stair: &StairParams) -> StairOutline {
    let half_w = (0.05_f64).max(stair.width / 2.0);
    let u = stair_norm(stair.dir);
    let st = stair_at_mid(stair, u, half_w);
    let s = &st;
    let n = stair_left_n(u);
    if s.shape == "spiral" {
        let center = s.center.unwrap_or(s.start);
        let radius = (half_w + 0.1).max(s.radius.unwrap_or(s.width));
        let sweep = s.sweep.unwrap_or(270.0) * DEG;
        let sv = sub(s.start, center);
        let a0 = sv.y.atan2(sv.x);
        let a1 = a0 + sweep;
        let r_in = (radius - half_w).max(0.02);
        let r_out = radius + half_w;
        let at = |r: f64, a: f64| Vec2 { x: center.x + r * a.cos(), y: center.y + r * a.sin() };
        return StairOutline {
            polygon: None,
            spiral: Some(SpiralOutline {
                lines: [(at(r_in, a0), at(r_out, a0)), (at(r_in, a1), at(r_out, a1))],
                arcs: [(center, r_in, a0, a1), (center, r_out, a0, a1)],
            }),
        };
    }
    if s.shape == "L" {
        let l1 = s.run_length.max(1e-4);
        let turn = s.turn.unwrap_or(1);
        let u2 = if turn > 0 { n } else { scale(n, -1.0) };
        let n2 = stair_left_n(u2);
        let l2 = s.run2_length.unwrap_or(s.run_length).max(1e-4);
        let corner = add(s.start, scale(u, l1 + half_w));
        let run2_start = add(corner, scale(u2, half_w));
        let p0l = add(s.start, scale(n, half_w));
        let p0r = add(s.start, scale(n, -half_w));
        let end_run2 = add(run2_start, scale(u2, l2));
        let p3l = add(end_run2, scale(n2, half_w));
        let p3r = add(end_run2, scale(n2, -half_w));
        let corner_l = stair_line_intersect(p0l, u, p3l, scale(u2, -1.0))
            .unwrap_or_else(|| add(corner, scale(n, half_w)));
        let corner_r = stair_line_intersect(p0r, u, p3r, scale(u2, -1.0))
            .unwrap_or_else(|| add(corner, scale(n, -half_w)));
        return StairOutline { polygon: Some(vec![p0l, p0r, corner_r, p3r, p3l, corner_l]), spiral: None };
    }
    if s.shape == "U" {
        let f = UFrame::from_params(s, half_w, u, n);
        return StairOutline { polygon: Some(f.outline()), spiral: None };
    }
    let l = if s.shape == "straightLanding" {
        s.run_length.max(0.1) + len_or(s.landing_length, 2.0 * half_w).max(0.1) + s.run2_length.unwrap_or(s.run_length).max(0.1)
    } else {
        s.run_length.max(1e-4)
    };
    let end = add(s.start, scale(u, l));
    StairOutline {
        polygon: Some(vec![
            add(s.start, scale(n, half_w)),
            add(s.start, scale(n, -half_w)),
            add(end, scale(n, -half_w)),
            add(end, scale(n, half_w)),
        ]),
        spiral: None,
    }
}

/// Punkt-in-Polygon (Ray-Casting) — gleiches Muster wie `pointInOutline` /
/// stair.ts `pointInPolygon` (Nenner-Guard `|| 1e-12`).
pub fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let nn = poly.len();
    if nn == 0 {
        return false;
    }
    let mut inside = false;
    let mut j = nn - 1;
    for i in 0..nn {
        let a = poly[i];
        let b = poly[j];
        let denom = if b.y - a.y == 0.0 { 1e-12 } else { b.y - a.y };
        let intersect =
            (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / denom + a.x;
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Schnittaufteilung (Port von `stairCut`).
pub fn stair_cut(geo: &StairGeometry, cut_rise: f64) -> StairCut {
    let mut below: Vec<i64> = Vec::new();
    let mut above: Vec<i64> = Vec::new();
    let mut break_idx: i64 = -1;
    for tr in &geo.treads {
        if tr.top_rise <= cut_rise + 1e-6 {
            below.push(tr.index);
        } else {
            if break_idx < 0 {
                break_idx = tr.index;
            }
            above.push(tr.index);
        }
    }
    let break_line = if break_idx >= 0 {
        geo.treads.iter().find(|t| t.index == break_idx).map(|tr| {
            let (c0, c1, c2, c3) = (tr.pts[0], tr.pts[1], tr.pts[2], tr.pts[3]);
            let mid01 = scale(add(c0, c1), 0.5);
            let mid23 = scale(add(c2, c3), 0.5);
            let off = scale(stair_norm(sub(c1, c0)), 0.06);
            vec![
                (add(mid01, off), add(mid23, off)),
                (sub(mid01, off), sub(mid23, off)),
            ]
        })
    } else {
        None
    };
    StairCut { below_indices: below, above_indices: above, break_line }
}

/// Achsparallele BBox aller Tritte + Podest (Port von `stairBBox`).
pub fn stair_bbox(geo: &StairGeometry) -> StairBBox {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for tr in &geo.treads {
        for p in &tr.pts {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
    }
    for land in geo.landing.iter().chain(geo.landing2.iter()) {
        for p in land {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
    }
    if !min_x.is_finite() {
        return StairBBox { min_x: 0.0, min_y: 0.0, max_x: 0.0, max_y: 0.0 };
    }
    StairBBox { min_x, min_y, max_x, max_y }
}

/// Ob ein Punkt irgendeinen Tritt (oder das Podest) trifft (Port `pointHitsStair`).
pub fn point_hits_stair(p: Vec2, geo: &StairGeometry) -> bool {
    for tr in &geo.treads {
        if point_in_polygon(p, &tr.pts) {
            return true;
        }
    }
    for land in geo.landing.iter().chain(geo.landing2.iter()) {
        if point_in_polygon(p, land) {
            return true;
        }
    }
    false
}
