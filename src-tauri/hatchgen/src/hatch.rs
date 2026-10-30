//! Schraffur- und Linienmuster-Geometrie des Grundrisses ([K3b], früher `glPlanHatch.ts`):
//! Linie/Segment/Polylinie gegen ein (konkaves) Polygon clippen (even-odd, halb-offene Kanten),
//! Geradenscharen (diagonal/kreuz/Doppellinie/eigenes Motiv), Schicht-Muster über die ganze Dicke
//! (Dämmschlange, Zickzack, Welle, Holzkreuz, [109]), Erdreich, Kies, deterministische Random-
//! Schraffur (mulberry32, modellraum-stabil), Strichmuster (`apply_dash_runs`), Zickzack und
//! Motiv-Kachelung entlang einer Strecke.
//!
//! Alles in Modell-Metern; die Muster bilden die SVG-`<pattern>`-Kacheln 1:1 nach (Bildschirm-
//! Raum `sx = mx·90`, Kachel 8·scale px bzw. 14×10·scale px). Die Rechenreihenfolge folgt der
//! TS-Fassung Operation für Operation (Bitgleichheit, s. `jsnum`).

use crate::jsmath::hypot2;
use crate::jsnum;
use std::f64::consts::PI;

/// Punkt in Modell-Metern.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct V2 {
    pub x: f64,
    pub y: f64,
}

#[inline]
pub const fn v2(x: f64, y: f64) -> V2 {
    V2 { x, y }
}

/// Zusammenhängender Linienzug (≥ 2 Punkte).
pub type Run = Vec<V2>;

/// Bildschirm-Einheiten je Meter (wie `PlanView.toScreen`).
pub const PX_PER_M: f64 = 90.0;
/// px (Bildschirm-Raum) → Meter.
pub const PX_TO_M: f64 = 1.0 / PX_PER_M;
/// mm-Papier → Modell-Meter des Musterraums (wie SVG-`dashArray`: `dash·(1/0.13)` px).
pub const DASH_MM_TO_M: f64 = (1.0 / 0.13) * PX_TO_M;

/// Muster einer Schraffur (`HatchPattern`). Unbekannte Muster zeichnen wie `Diagonal`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pattern {
    None = 0,
    Solid = 1,
    Diagonal = 2,
    Crosshatch = 3,
    Insulation = 4,
    Custom = 5,
    InsulationHard = 6,
    InsulationWave = 7,
    Timber = 8,
    Earth = 9,
    Gravel = 10,
    Stone = 11,
    Dots = 12,
}

impl Pattern {
    pub fn from_code(c: f64) -> Pattern {
        match c as i64 {
            0 => Pattern::None,
            1 => Pattern::Solid,
            3 => Pattern::Crosshatch,
            4 => Pattern::Insulation,
            5 => Pattern::Custom,
            6 => Pattern::InsulationHard,
            7 => Pattern::InsulationWave,
            8 => Pattern::Timber,
            9 => Pattern::Earth,
            10 => Pattern::Gravel,
            11 => Pattern::Stone,
            12 => Pattern::Dots,
            _ => Pattern::Diagonal,
        }
    }
}

/// Schraffur-Typ (`HatchRender.kind`): Vektor, Bild, Verlauf. Bild/Verlauf zeichnet die GPU
/// nicht als Linien (Rückfall auf die Füllung).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HatchKind {
    Vector = 0,
    Image = 1,
    Gradient = 2,
}

impl HatchKind {
    pub fn from_code(c: f64) -> HatchKind {
        match c as i64 {
            1 => HatchKind::Image,
            2 => HatchKind::Gradient,
            _ => HatchKind::Vector,
        }
    }
}

/// Wiederhol-Motiv: offene Polylinie einer Einheitszelle, `x` entlang, `y` quer.
#[derive(Clone, Debug, PartialEq)]
pub struct Motif {
    pub points: Vec<V2>,
    pub length: f64,
}

/// Aufgelöste Schraffur (`HatchRender`) ohne Farbe/Bild/Verlauf-Details.
#[derive(Clone, Debug, PartialEq)]
pub struct Hatch {
    pub pattern: Pattern,
    pub kind: HatchKind,
    /// `lines === "random"`.
    pub random: bool,
    pub scale: f64,
    pub angle: f64,
    pub line_weight: f64,
    pub origin: Option<V2>,
    pub seed: Option<f64>,
    pub density: Option<f64>,
    pub length_min: Option<f64>,
    pub length_max: Option<f64>,
    /// Strichmuster der Musterlinien (mm); leer = durchgezogen.
    pub dash: Vec<f64>,
    pub motif: Option<Motif>,
}

// ── Clipping ────────────────────────────────────────────────────────────────

fn bbox(poly: &[V2]) -> (f64, f64, f64, f64) {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in poly {
        if p.x < min_x {
            min_x = p.x;
        }
        if p.y < min_y {
            min_y = p.y;
        }
        if p.x > max_x {
            max_x = p.x;
        }
        if p.y > max_y {
            max_y = p.y;
        }
    }
    (min_x, min_y, max_x, max_y)
}

/// Unendliche Linie (Aufpunkt `p0`, Einheitsrichtung `dir`) gegen ein einfaches Polygon:
/// innenliegende Segmente (even-odd, halb-offene Kantenkonvention an Ecken).
pub fn clip_line_to_polygon(p0: V2, dir: V2, poly: &[V2]) -> Vec<(V2, V2)> {
    let n = poly.len();
    if n < 3 {
        return Vec::new();
    }
    let nx = -dir.y;
    let ny = dir.x;
    let side = |p: V2| (p.x - p0.x) * nx + (p.y - p0.y) * ny;
    let mut ts: Vec<f64> = Vec::new();
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let sa = side(a);
        let sb = side(b);
        if sa > 0.0 && sb > 0.0 {
            continue;
        }
        if sa < 0.0 && sb < 0.0 {
            continue;
        }
        if sa == 0.0 && sb == 0.0 {
            continue;
        }
        if sa == 0.0 && sb < 0.0 {
            continue;
        }
        if sb == 0.0 && sa < 0.0 {
            continue;
        }
        let denom = sa - sb;
        let u = if denom != 0.0 { sa / denom } else { 0.0 };
        let ix = a.x + (b.x - a.x) * u;
        let iy = a.y + (b.y - a.y) * u;
        ts.push((ix - p0.x) * dir.x + (iy - p0.y) * dir.y);
    }
    if ts.len() < 2 {
        return Vec::new();
    }
    // Wie `Array.sort((x, y) => x - y)`: stabil, NaN-Vergleiche zählen als gleich.
    ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let mut segs = Vec::new();
    let mut i = 0;
    while i + 1 < ts.len() {
        let t0 = ts[i];
        let t1 = ts[i + 1];
        i += 2;
        if t1 - t0 < 1e-9 {
            continue;
        }
        segs.push((v2(p0.x + dir.x * t0, p0.y + dir.y * t0), v2(p0.x + dir.x * t1, p0.y + dir.y * t1)));
    }
    segs
}

/// Endliches Segment [a,b] gegen ein (konkaves) Polygon: innenliegende Teilstücke.
pub fn clip_segment_to_polygon(a: V2, b: V2, poly: &[V2]) -> Vec<(V2, V2)> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len = hypot2(dx, dy);
    if len < 1e-12 {
        return Vec::new();
    }
    let dir = v2(dx / len, dy / len);
    let mut out = Vec::new();
    for (sa, sb) in clip_line_to_polygon(a, dir, poly) {
        let t0 = (sa.x - a.x) * dir.x + (sa.y - a.y) * dir.y;
        let t1 = (sb.x - a.x) * dir.x + (sb.y - a.y) * dir.y;
        let lo = jsnum::max(0.0, jsnum::min(t0, t1));
        let hi = jsnum::min(len, jsnum::max(t0, t1));
        if hi - lo < 1e-9 {
            continue;
        }
        out.push((v2(a.x + dir.x * lo, a.y + dir.y * lo), v2(a.x + dir.x * hi, a.y + dir.y * hi)));
    }
    out
}

/// Polylinie gegen ein (konkaves) Polygon als zusammenhängende Innen-Läufe.
pub fn clip_polyline_to_polygon(pts: &[V2], poly: &[V2]) -> Vec<Run> {
    if pts.len() < 2 || poly.len() < 3 {
        return Vec::new();
    }
    const EPS: f64 = 1e-9;
    let near = |p: V2, q: V2| (p.x - q.x).abs() < EPS && (p.y - q.y).abs() < EPS;
    let mut runs: Vec<Run> = Vec::new();
    let mut cur: Option<Run> = None;
    fn close_run(cur: &mut Option<Run>, runs: &mut Vec<Run>) {
        if let Some(c) = cur.take() {
            if c.len() >= 2 {
                runs.push(c);
            }
        }
    }
    for i in 0..pts.len() - 1 {
        let a = pts[i];
        let b = pts[i + 1];
        for (sa, sb) in clip_segment_to_polygon(a, b, poly) {
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let ta = (sa.x - a.x) * dx + (sa.y - a.y) * dy;
            let tb = (sb.x - a.x) * dx + (sb.y - a.y) * dy;
            let s = if ta <= tb { sa } else { sb };
            let e = if ta <= tb { sb } else { sa };
            match cur.as_mut() {
                Some(c) if near(*c.last().unwrap(), s) => c.push(e),
                _ => {
                    close_run(&mut cur, &mut runs);
                    cur = Some(vec![s, e]);
                }
            }
        }
        if let Some(c) = cur.as_ref() {
            if !near(*c.last().unwrap(), b) {
                close_run(&mut cur, &mut runs);
            }
        }
    }
    close_run(&mut cur, &mut runs);
    runs
}

/// Schar paralleler, aufs Polygon geclippter Linien (Richtung `angle_rad`, Abstand `spacing_m`,
/// Phase `offset_m`, Raster-Anker `anchor` = Modellursprung bzw. `hatchOrigin`).
pub fn hatch_line_family(poly: &[V2], angle_rad: f64, spacing_m: f64, offset_m: f64, anchor: V2) -> Vec<(V2, V2)> {
    if poly.len() < 3 || spacing_m <= 1e-9 {
        return Vec::new();
    }
    let (min_x, min_y, max_x, max_y) = bbox(poly);
    if !(max_x > min_x) && !(max_y > min_y) {
        return Vec::new();
    }
    let dir = v2(jsnum::cos(angle_rad), jsnum::sin(angle_rad));
    let nrm = v2(-dir.y, dir.x);
    let center = anchor;
    let (mut d_min, mut d_max) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in poly {
        let d = (p.x - center.x) * nrm.x + (p.y - center.y) * nrm.y;
        if d < d_min {
            d_min = d;
        }
        if d > d_max {
            d_max = d;
        }
    }
    let mut segs = Vec::new();
    let first = ((d_min - offset_m) / spacing_m).floor() - 1.0;
    let last = ((d_max - offset_m) / spacing_m).ceil() + 1.0;
    // Unendliche Ausdehnung (TS lief hier endlos): nichts zeichnen.
    if !(last - first).is_finite() {
        return segs;
    }
    let mut k = first;
    while k <= last {
        let d = offset_m + k * spacing_m;
        let p0 = v2(center.x + nrm.x * d, center.y + nrm.y * d);
        segs.extend(clip_line_to_polygon(p0, dir, poly));
        k += 1.0;
    }
    segs
}

fn rotate(v: V2, rad: f64) -> V2 {
    let c = jsnum::cos(rad);
    let s = jsnum::sin(rad);
    v2(v.x * c - v.y * s, v.x * s + v.y * c)
}

/// SVG-Drehung (im Uhrzeigersinn, Grad) → Modellwinkel (Bogenmass, CCW).
fn to_model_angle_rad(screen_deg: f64) -> f64 {
    (-screen_deg * PI) / 180.0
}

// ── Strichmuster ────────────────────────────────────────────────────────────

/// Strichmuster der Musterlinien einer Schraffur (mm im Musterraum, für [`apply_dash_runs`]): skaliert
/// mit der Musterskala wie der Linienabstand (Kachel `8 · scale`), damit Strich/Lücke zum Abstand passen
/// — sonst ist der Strich bei feinen Mustern (Estrich 0.35) länger als die Linie in einer dünnen Schicht
/// und die Schraffur wirkt durchgezogen. Gilt in Szene, Chunk-Pfad, Druck-SVG und DXF gleich.
pub fn hatch_dash(h: &Hatch) -> Vec<f64> {
    let k = if !h.random && h.scale.is_finite() && h.scale > 0.0 { h.scale } else { 1.0 };
    h.dash.iter().map(|d| d * k).collect()
}

/// Zerlegt Läufe entlang eines Strichmusters (`dash` in mm-Papier, [an, aus, …]; ungerade
/// Länge wird verdoppelt). Die Phase läuft über Stützpunkte hinweg durch.
pub fn apply_dash_runs(runs: Vec<Run>, dash: &[f64]) -> Vec<Run> {
    if dash.is_empty() {
        return runs;
    }
    let pat: Vec<f64> = dash.iter().map(|&d| jsnum::max(0.0, d) * DASH_MM_TO_M).filter(|&d| d > 0.0).collect();
    if pat.is_empty() {
        return runs;
    }
    let cycle: Vec<f64> = if pat.len() % 2 == 0 { pat } else { pat.iter().chain(pat.iter()).copied().collect() };
    let mut total = 0.0;
    for &d in &cycle {
        total += d;
    }
    if total <= 1e-9 {
        return runs;
    }
    let mut out: Vec<Run> = Vec::new();
    for run in &runs {
        if run.len() < 2 {
            continue;
        }
        let mut idx = 0usize;
        let mut dash_left = cycle[0];
        let mut on = true;
        let mut piece: Option<Run> = Some(vec![run[0]]);
        for i in 0..run.len() - 1 {
            let mut a = run[i];
            let b = run[i + 1];
            let mut seg_len = hypot2(b.x - a.x, b.y - a.y);
            if seg_len < 1e-12 {
                continue;
            }
            let ux = (b.x - a.x) / seg_len;
            let uy = (b.y - a.y) / seg_len;
            while seg_len > 1e-9 {
                let step = jsnum::min(seg_len, dash_left);
                let mid = v2(a.x + ux * step, a.y + uy * step);
                if on {
                    piece.get_or_insert_with(|| vec![a]).push(mid);
                }
                a = mid;
                seg_len -= step;
                dash_left -= step;
                if dash_left <= 1e-9 {
                    if on {
                        if let Some(p) = piece.take() {
                            if p.len() >= 2 {
                                out.push(p);
                            }
                        }
                    }
                    on = !on;
                    idx += 1;
                    dash_left = cycle[idx % cycle.len()];
                    if on {
                        piece = Some(vec![a]);
                    }
                }
            }
        }
        if let Some(p) = piece.take() {
            if p.len() >= 2 {
                out.push(p);
            }
        }
    }
    out
}

// ── Muster ──────────────────────────────────────────────────────────────────

/// Schraffur eines Polygons als zusammenhängende Läufe (Modell-Meter); Bild/Verlauf liefern
/// hier keine Linien (die Aufrufer filtern sie vorher).
pub fn build_hatch_runs(poly: &[V2], hatch: &Hatch) -> Vec<Run> {
    if poly.len() < 3 {
        return Vec::new();
    }
    let pattern = hatch.pattern;
    if pattern == Pattern::None || pattern == Pattern::Solid {
        return Vec::new();
    }
    let scale = if hatch.scale > 1e-6 { hatch.scale } else { 1.0 };
    if hatch.kind == HatchKind::Vector && hatch.random {
        return build_random_hatch_runs(poly, hatch, Some(scale));
    }
    match pattern {
        Pattern::Insulation => return insulation_runs(poly, hatch, scale),
        Pattern::InsulationHard => return zigzag_band_runs(poly, hatch, scale),
        Pattern::InsulationWave => return wave_band_runs(poly, hatch, scale),
        Pattern::Timber => return timber_band_runs(poly, hatch, scale),
        Pattern::Earth => return earth_runs(poly, hatch, scale),
        Pattern::Gravel => return gravel_runs(poly, hatch, scale),
        Pattern::Dots => return dots_runs(poly, hatch, scale),
        _ => {}
    }
    let spacing_m = 8.0 * scale * PX_TO_M;
    let rot = to_model_angle_rad(hatch.angle);
    let dir1 = rotate(v2(0.0, -1.0), rot);
    let a1 = jsnum::atan2(dir1.y, dir1.x);
    let anchor = hatch.origin.unwrap_or(v2(0.0, 0.0));
    let mut runs: Vec<Run> = hatch_line_family(poly, a1, spacing_m, 0.0, anchor)
        .into_iter()
        .map(|(a, b)| match (&hatch.motif, pattern) {
            (Some(m), Pattern::Custom) => motif_points(a, b, m, scale * DASH_MM_TO_M),
            _ => vec![a, b],
        })
        .collect();
    if pattern == Pattern::Crosshatch {
        for (a, b) in hatch_line_family(poly, a1 + PI / 2.0, spacing_m, 0.0, anchor) {
            runs.push(vec![a, b]);
        }
    }
    // Naturstein: jede Musterlinie als Doppellinie (zweite um 18 % des Abstands versetzt).
    if pattern == Pattern::Stone {
        for (a, b) in hatch_line_family(poly, a1, spacing_m, 0.18 * spacing_m, anchor) {
            runs.push(vec![a, b]);
        }
    }
    runs
}

// ── Schicht-Muster (SIA 400, [109]) ──────────────────────────────────────────
//
// Dämmschlange, Zickzack, Welle und Holzkreuz spannen über die GANZE Schichtdicke: das Polygon wird
// im Musterrahmen (u = Laufrichtung = Schraffurwinkel, bei Wänden wandbezogen also die Wandachse;
// v quer dazu) vermessen, die Dicke ist seine Ausdehnung in v. Sehr breite Flächen (keine Schicht,
// z. B. eine freie 2D-Fläche) werden in Bänder von etwa `BAND_ROW_M` geteilt.

/// Bis zu dieser Dicke (m · scale) zeichnet ein Schichtmuster EINE Schlange über die ganze Dicke.
const BAND_MAX_M: f64 = 0.6;
/// Bandhöhe (m · scale) beim Teilen breiter Flächen.
const BAND_ROW_M: f64 = 0.3;
/// Kleinste Musterlänge (m): dünne Schichten werden nicht zu Brei.
const BAND_MIN_PITCH_M: f64 = 0.012;
/// Grenze der Stützpunkte je Muster (Schutz gegen entartete Eingaben).
const BAND_MAX_POINTS: f64 = 400_000.0;

/// Musterrahmen eines Polygons: Achsen, Ausdehnung in u, Bänder (Mitte v, halbe Höhe).
struct Band {
    u: V2,
    v: V2,
    u0: f64,
    u1: f64,
    /// Phase entlang u (Projektion des Ankers): benachbarte Flächen setzen gleich an.
    ua: f64,
    rows: Vec<(f64, f64)>,
}

impl Band {
    fn at(&self, u: f64, v: f64) -> V2 {
        v2(self.u.x * u + self.v.x * v, self.u.y * u + self.v.y * v)
    }
}

fn band_frame(poly: &[V2], hatch: &Hatch, scale: f64) -> Option<Band> {
    let rot = to_model_angle_rad(hatch.angle);
    let u = rotate(v2(1.0, 0.0), rot);
    let v = rotate(v2(0.0, 1.0), rot);
    let (mut u0, mut u1, mut v0, mut v1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for p in poly {
        let pu = p.x * u.x + p.y * u.y;
        let pv = p.x * v.x + p.y * v.y;
        u0 = u0.min(pu);
        u1 = u1.max(pu);
        v0 = v0.min(pv);
        v1 = v1.max(pv);
    }
    let t = v1 - v0;
    if !(u1 > u0) || !(t > 1e-6) || !(u1 - u0).is_finite() || !t.is_finite() {
        return None;
    }
    let n = if t <= BAND_MAX_M * scale { 1.0 } else { (t / (BAND_ROW_M * scale)).ceil() };
    if !(n.is_finite()) || n > 10_000.0 {
        return None;
    }
    let h = t / n;
    let rows = (0..n as usize).map(|i| (v0 + (i as f64 + 0.5) * h, h / 2.0)).collect();
    let anchor = hatch.origin.unwrap_or(v2(0.0, 0.0));
    Some(Band { u, v, u0, u1, ua: anchor.x * u.x + anchor.y * u.y, rows })
}

/// Linienzug aus `f(x) → (Δu, v)` über die Bandlänge, `x` in Schritten `dx`, geclippt.
fn band_curve(poly: &[V2], b: &Band, vc: f64, margin: f64, dx: f64, f: impl Fn(f64) -> (f64, f64)) -> Vec<Run> {
    let x0 = ((b.u0 - b.ua - margin) / dx).floor() * dx;
    let x1 = b.u1 - b.ua + margin;
    if !(dx > 1e-9) || (x1 - x0) / dx > BAND_MAX_POINTS {
        return Vec::new();
    }
    let mut pts = Vec::new();
    let mut x = x0;
    while x <= x1 + 1e-12 {
        let (du, dv) = f(x);
        pts.push(b.at(b.ua + du, vc + dv));
        x += dx;
    }
    clip_polyline_to_polygon(&pts, poly)
}

/// Dämmschlange (SIA 400, weiche Dämmung): fortlaufende, sich überlappende Schlaufen über die
/// ganze Schichtdicke — eine „Sinuslinie mit Schlaufen" (projizierte Schraubenlinie):
/// `u = a·t + R·sin t`, `v = h·cos t`, Steigung `P = 2πa` ≈ 0.45 · Dicke, Schlaufenbreite `R` = ⅔ P.
fn insulation_runs(poly: &[V2], hatch: &Hatch, scale: f64) -> Vec<Run> {
    let Some(b) = band_frame(poly, hatch, scale) else { return Vec::new() };
    let mut runs = Vec::new();
    for &(vc, half) in &b.rows {
        let pitch = (0.45 * 2.0 * half * scale).max(BAND_MIN_PITCH_M);
        let a = pitch / (2.0 * PI);
        let r = pitch * (2.0 / 3.0);
        // Parameter t läuft gleichmässig; 36 Stützpunkte je Schlaufe.
        let dt = 2.0 * PI / 36.0;
        runs.extend(band_curve(poly, &b, vc, r + pitch, a * dt, |x| {
            let t = x / a;
            (a * t + r * jsnum::sin(t), half * jsnum::cos(t))
        }));
    }
    runs
}

/// Hartschaum (EPS/XPS): Zickzack über die ganze Dicke, halbe Periode = 0.5 · Dicke · scale.
fn zigzag_band_runs(poly: &[V2], hatch: &Hatch, scale: f64) -> Vec<Run> {
    let Some(b) = band_frame(poly, hatch, scale) else { return Vec::new() };
    let mut runs = Vec::new();
    for &(vc, half) in &b.rows {
        let hp = (0.5 * 2.0 * half * scale).max(BAND_MIN_PITCH_M);
        runs.extend(band_curve(poly, &b, vc, hp, hp, |x| {
            let k = jsnum::round(x / hp);
            (x, if (k as i64).rem_euclid(2) == 0 { half } else { -half })
        }));
    }
    runs
}

/// Holzfaser-Dämmung: Sinuswelle über die ganze Dicke, Periode = 1.2 · Dicke · scale.
fn wave_band_runs(poly: &[V2], hatch: &Hatch, scale: f64) -> Vec<Run> {
    let Some(b) = band_frame(poly, hatch, scale) else { return Vec::new() };
    let mut runs = Vec::new();
    for &(vc, half) in &b.rows {
        let period = (1.2 * 2.0 * half * scale).max(BAND_MIN_PITCH_M);
        let w = 2.0 * PI / period;
        runs.extend(band_curve(poly, &b, vc, period, period / 32.0, |x| (x, half * jsnum::cos(w * x))));
    }
    runs
}

/// Holz im Querschnitt: Diagonalkreuz je quadratischem Feld (Seite = Dicke · scale) — zwei
/// gegenläufige Zickzacks über die ganze Dicke.
fn timber_band_runs(poly: &[V2], hatch: &Hatch, scale: f64) -> Vec<Run> {
    let Some(b) = band_frame(poly, hatch, scale) else { return Vec::new() };
    let mut runs = Vec::new();
    for &(vc, half) in &b.rows {
        let side = (2.0 * half * scale).max(BAND_MIN_PITCH_M);
        for sign in [1.0, -1.0] {
            runs.extend(band_curve(poly, &b, vc, side, side, |x| {
                let k = jsnum::round(x / side);
                (x, if (k as i64).rem_euclid(2) == 0 { sign * half } else { -sign * half })
            }));
        }
    }
    runs
}

/// Rasterzellen (i, j) über das Polygon im Musterrahmen (Zellgrösse `cell`), mit Zellen-Grenze.
fn cells_over(poly: &[V2], u: V2, v: V2, cell: f64) -> Option<(f64, f64, f64, f64)> {
    let (mut u0, mut u1, mut v0, mut v1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for p in poly {
        let pu = p.x * u.x + p.y * u.y;
        let pv = p.x * v.x + p.y * v.y;
        u0 = u0.min(pu);
        u1 = u1.max(pu);
        v0 = v0.min(pv);
        v1 = v1.max(pv);
    }
    let (i0, i1, j0, j1) = ((u0 / cell).floor(), (u1 / cell).floor(), (v0 / cell).floor(), (v1 / cell).floor());
    let n = (i1 - i0 + 1.0) * (j1 - j0 + 1.0);
    (n.is_finite() && n <= 250_000.0 && cell > 1e-9).then_some((i0, i1, j0, j1))
}

/// Erdreich: Flechtmuster — je Zelle drei kurze parallele Striche, von Zelle zu Zelle um 90°
/// gewechselt (mit dem Schraffurwinkel gedreht, Standard 45°). Zelle 0.15 m · scale.
fn earth_runs(poly: &[V2], hatch: &Hatch, scale: f64) -> Vec<Run> {
    let rot = to_model_angle_rad(hatch.angle);
    let (u, v) = (rotate(v2(1.0, 0.0), rot), rotate(v2(0.0, 1.0), rot));
    let cell = 0.15 * scale;
    let Some((i0, i1, j0, j1)) = cells_over(poly, u, v, cell) else { return Vec::new() };
    let at = |a: f64, b: f64| v2(u.x * a + v.x * b, u.y * a + v.y * b);
    let mut runs = Vec::new();
    let mut j = j0;
    while j <= j1 {
        let mut i = i0;
        while i <= i1 {
            let along_u = (i + j).rem_euclid(2.0) == 0.0;
            for k in [0.25, 0.5, 0.75] {
                let (a, b) = if along_u {
                    (at((i + 0.15) * cell, (j + k) * cell), at((i + 0.85) * cell, (j + k) * cell))
                } else {
                    (at((i + k) * cell, (j + 0.15) * cell), at((i + k) * cell, (j + 0.85) * cell))
                };
                for (sa, sb) in clip_segment_to_polygon(a, b, poly) {
                    runs.push(vec![sa, sb]);
                }
            }
            i += 1.0;
        }
        j += 1.0;
    }
    runs
}

/// Kies: kleine Kreise (Ø 25–55 % der Zelle) auf gestreutem Raster, modellraum-stabil.
/// Zelle 0.05 m · scale.
fn gravel_runs(poly: &[V2], hatch: &Hatch, scale: f64) -> Vec<Run> {
    let cell = 0.05 * scale;
    let Some((i0, i1, j0, j1)) = cells_over(poly, v2(1.0, 0.0), v2(0.0, 1.0), cell) else { return Vec::new() };
    let seed = hatch.seed.unwrap_or(0.0);
    let mut runs = Vec::new();
    let mut j = j0;
    while j <= j1 {
        let mut i = i0;
        while i <= i1 {
            let mut rnd = Mulberry32 { a: hash_cell(i, j, seed) };
            let r = cell * (0.125 + 0.15 * rnd.next());
            let cx = (i + 0.5) * cell + (rnd.next() - 0.5) * (cell - 2.0 * r);
            let cy = (j + 0.5) * cell + (rnd.next() - 0.5) * (cell - 2.0 * r);
            let ring: Vec<V2> = (0..=12).map(|k| {
                let a = k as f64 * PI / 6.0;
                v2(cx + r * jsnum::cos(a), cy + r * jsnum::sin(a))
            }).collect();
            runs.extend(clip_polyline_to_polygon(&ring, poly));
            i += 1.0;
        }
        j += 1.0;
    }
    runs
}

/// Punktfeld (Putz, SIA 400): feine, ruhige Punkte im versetzten Raster, entlang der Schicht ausgerichtet
/// (Schichtmuster: Laufrichtung = Schraffurwinkel, Bänder wie bei der Dämmung). Teilung entlang u = 0.05 m ·
/// scale; die Reihen füllen die Schichtdicke gleichmässig (Reihenabstand ≈ 0.87 · Teilung, mindestens eine
/// Reihe in der Schichtmitte, damit auch dünne Putzschichten Punkte bekommen). Jeder Punkt ein winziger
/// Strich (30 % der Teilung); nur Punkte, die ganz in der Fläche liegen (ruhiger Rand).
fn dots_runs(poly: &[V2], hatch: &Hatch, scale: f64) -> Vec<Run> {
    let Some(b) = band_frame(poly, hatch, scale) else { return Vec::new() };
    let pitch = (0.05 * scale).max(0.004);
    let half_dot = 0.15 * pitch;
    if (b.u1 - b.u0) / pitch > BAND_MAX_POINTS {
        return Vec::new();
    }
    let mut runs = Vec::new();
    for &(vc, half) in &b.rows {
        let k = (2.0 * half / (0.87 * pitch)).round().max(1.0);
        if k > 5_000.0 {
            continue;
        }
        let step = 2.0 * half / k;
        let mut r = 0.0;
        while r < k {
            let v = vc - half + (r + 0.5) * step;
            let shift = if r.rem_euclid(2.0) == 0.0 { 0.0 } else { 0.5 };
            let mut i = ((b.u0 - b.ua) / pitch).floor() - 1.0;
            while b.ua + (i + shift) * pitch <= b.u1 + pitch {
                let cu = b.ua + (i + shift) * pitch;
                let (a, e) = (b.at(cu - half_dot, v), b.at(cu + half_dot, v));
                let kept = clip_segment_to_polygon(a, e, poly);
                if kept.len() == 1 && hypot2(kept[0].1.x - kept[0].0.x, kept[0].1.y - kept[0].0.y) > 1.9 * half_dot {
                    runs.push(vec![a, e]);
                }
                i += 1.0;
            }
            r += 1.0;
        }
    }
    runs
}

// ── Random-Schraffur ────────────────────────────────────────────────────────

/// mulberry32 (deterministischer 32-bit-PRNG).
struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5);
        let a = self.a;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// Faltet Kennwerte (gequantelt ·1000) zu einem 32-bit-Seed (FNV-artig).
fn hash_seed(vals: &[f64]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for &v in vals {
        let q = jsnum::to_int32(jsnum::round(v * 1000.0)) as u32;
        h ^= q & 0xffff;
        h = h.wrapping_mul(0x01000193);
        h ^= (q >> 16) & 0xffff;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

/// Hash einer Modellraum-Zelle (absolute Indizes) plus Seed.
fn hash_cell(ix: f64, iy: f64, seed: f64) -> u32 {
    let mut h: u32 = 0x811c9dc5 ^ (jsnum::to_int32(seed) as u32);
    h = (h ^ jsnum::to_int32(ix) as u32).wrapping_mul(0x01000193);
    h = (h ^ jsnum::to_int32(iy) as u32).wrapping_mul(0x01000193);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b3c6d);
    h ^= h >> 12;
    h
}

/// Streut kurze Striche modellraum-stabil über ein Polygon (eine Zelle je Strich).
pub fn scatter_strokes(
    poly: &[V2],
    cell: f64,
    base_angle_rad: f64,
    seed: f64,
    stroke_len: f64,
    len_min: Option<f64>,
    len_max: Option<f64>,
) -> Vec<Run> {
    if poly.len() < 3 || cell <= 1e-9 || stroke_len <= 1e-9 {
        return Vec::new();
    }
    let (min_x, min_y, max_x, max_y) = bbox(poly);
    if !(max_x > min_x) || !(max_y > min_y) {
        return Vec::new();
    }
    let mut eff = cell;
    let mut ix0 = (min_x / eff).floor();
    let mut ix1 = (max_x / eff).floor();
    let mut iy0 = (min_y / eff).floor();
    let mut iy1 = (max_y / eff).floor();
    const MAX_CELLS: f64 = 250000.0;
    let cells = (ix1 - ix0 + 1.0) * (iy1 - iy0 + 1.0);
    if cells > MAX_CELLS {
        eff = cell * (cells / MAX_CELLS).sqrt();
        ix0 = (min_x / eff).floor();
        ix1 = (max_x / eff).floor();
        iy0 = (min_y / eff).floor();
        iy1 = (max_y / eff).floor();
    }
    if !(ix1 - ix0).is_finite() || !(iy1 - iy0).is_finite() {
        return Vec::new();
    }
    let range = match (len_min, len_max) {
        (Some(lo), Some(hi)) if lo > 1e-9 && hi >= lo => Some((lo, hi)),
        _ => None,
    };
    let mut runs = Vec::new();
    let mut iy = iy0;
    while iy <= iy1 {
        let mut ix = ix0;
        while ix <= ix1 {
            let mut rnd = Mulberry32 { a: hash_cell(ix, iy, seed) };
            let cx = (ix + rnd.next()) * eff;
            let cy = (iy + rnd.next()) * eff;
            let ang = base_angle_rad + (rnd.next() * 2.0 - 1.0) * PI;
            let len = match range {
                Some((lo, hi)) => lo + rnd.next() * (hi - lo),
                None => stroke_len * (0.6 + 0.8 * rnd.next()),
            };
            let half = len * 0.5;
            let dx = jsnum::cos(ang) * half;
            let dy = jsnum::sin(ang) * half;
            let a = v2(cx - dx, cy - dy);
            let b = v2(cx + dx, cy + dy);
            for (sa, sb) in clip_segment_to_polygon(a, b, poly) {
                runs.push(vec![sa, sb]);
            }
            ix += 1.0;
        }
        iy += 1.0;
    }
    runs
}

/// Random-Vektor-Schraffur (Kies/Splitt), Dichte/Strichlänge an die Kachel (8·scale px) gekoppelt.
pub fn build_random_hatch_runs(poly: &[V2], hatch: &Hatch, scale: Option<f64>) -> Vec<Run> {
    let s = scale.unwrap_or(if hatch.scale > 1e-6 { hatch.scale } else { 1.0 });
    let density = match hatch.density {
        Some(d) if d > 1e-6 => d,
        _ => 1.0,
    };
    let cell = (8.0 * s * PX_TO_M) / density;
    let stroke_len = cell * 1.1;
    let seed = hash_seed(&[hatch.angle, s, density, hatch.seed.unwrap_or(0.0)]);
    let base = to_model_angle_rad(hatch.angle);
    let len_min = hatch.length_min.map(|v| v * DASH_MM_TO_M);
    let len_max = hatch.length_max.map(|v| v * DASH_MM_TO_M);
    scatter_strokes(poly, cell, base, seed as f64, stroke_len, len_min, len_max)
}

// ── Zickzack / Motiv ────────────────────────────────────────────────────────

/// Zickzack (Dreieckswelle [0,+A,0,−A] je Viertel-Wellenlänge) entlang [a,b]. `None` =
/// entartet (Aufrufer nimmt `[a, b]`).
pub fn zigzag_points(a: V2, b: V2, amplitude: f64, wavelength: f64) -> Option<Vec<V2>> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let l = hypot2(dx, dy);
    if l < 1e-12 || wavelength <= 1e-9 || amplitude <= 0.0 {
        return None;
    }
    let ux = dx / l;
    let uy = dy / l;
    let nx = -uy;
    let ny = ux;
    let quarter = wavelength / 4.0;
    let steps = jsnum::max(1.0, jsnum::round(l / quarter));
    const TRI: [f64; 4] = [0.0, 1.0, 0.0, -1.0];
    let mut pts = Vec::new();
    let mut i = 0.0f64;
    while i <= steps {
        let t = jsnum::min(l, i * quarter);
        let off = amplitude * TRI[(i as u64 % 4) as usize];
        pts.push(v2(a.x + ux * t + nx * off, a.y + uy * t + ny * off));
        i += 1.0;
    }
    // (TS warf hier bei NaN-Länge; ohne Punkte gilt die Strecke.)
    let last = *pts.last()?;
    if (last.x - b.x).abs() > 1e-9 || (last.y - b.y).abs() > 1e-9 {
        pts.push(v2(b.x, b.y));
    }
    Some(pts)
}

/// Kachelt ein Motiv entlang [a,b] (Punkte und Länge ·`scale`), am Ende exakt bei `L`
/// geclippt. `None` = entartet (Aufrufer nimmt `[a, b]`).
pub fn motif_points(a: V2, b: V2, motif: &Motif, scale: f64) -> Vec<V2> {
    motif_points_opt(a, b, motif, scale).unwrap_or_else(|| vec![a, b])
}

pub fn motif_points_opt(a: V2, b: V2, motif: &Motif, scale: f64) -> Option<Vec<V2>> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let l = hypot2(dx, dy);
    let cell = motif.length * scale;
    if l < 1e-12 || cell <= 1e-9 || motif.points.len() < 2 {
        return None;
    }
    let ux = dx / l;
    let uy = dy / l;
    let nx = -uy;
    let ny = ux;
    let to_world = |ax: f64, off: f64| v2(a.x + ux * ax + nx * off, a.y + uy * ax + ny * off);
    let mut out = Vec::new();
    let reps = (l / cell).ceil() + 1.0;
    let mut last: Option<(f64, f64)> = None;
    let mut r = 0.0f64;
    while r < reps {
        let base = r * cell;
        for p in &motif.points {
            let ax = base + p.x * scale;
            let off = p.y * scale;
            if let Some((lax, loff)) = last {
                if (ax - lax).abs() < 1e-9 && (off - loff).abs() < 1e-9 {
                    continue;
                }
            }
            if ax > l + 1e-9 {
                if let Some((lax, loff)) = last {
                    if ax > lax + 1e-12 && l - lax > 1e-9 {
                        let tt = (l - lax) / (ax - lax);
                        out.push(to_world(l, loff + (off - loff) * tt));
                    }
                }
                return if out.len() >= 2 { Some(out) } else { None };
            }
            out.push(to_world(ax, off));
            last = Some((ax, off));
        }
        r += 1.0;
    }
    if out.len() >= 2 {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square() -> Vec<V2> {
        vec![v2(0.0, 0.0), v2(1.0, 0.0), v2(1.0, 1.0), v2(0.0, 1.0)]
    }

    fn hatch(pattern: Pattern) -> Hatch {
        Hatch {
            pattern,
            kind: HatchKind::Vector,
            random: false,
            scale: 1.0,
            angle: 45.0,
            line_weight: 0.13,
            origin: None,
            seed: None,
            density: None,
            length_min: None,
            length_max: None,
            dash: Vec::new(),
            motif: None,
        }
    }

    #[test]
    fn linie_durch_quadrat() {
        let s = clip_line_to_polygon(v2(-1.0, 0.5), v2(1.0, 0.0), &square());
        assert_eq!(s.len(), 1);
        assert!((s[0].0.x - 0.0).abs() < 1e-12 && (s[0].1.x - 1.0).abs() < 1e-12);
        assert!(clip_line_to_polygon(v2(-1.0, 5.0), v2(1.0, 0.0), &square()).is_empty());
    }

    #[test]
    fn konkav_zwei_stuecke() {
        // U-Form: Linie bei y=0.75 trifft beide Schenkel.
        let u = vec![v2(0.0, 0.0), v2(3.0, 0.0), v2(3.0, 1.0), v2(2.0, 1.0), v2(2.0, 0.5), v2(1.0, 0.5), v2(1.0, 1.0), v2(0.0, 1.0)];
        assert_eq!(clip_line_to_polygon(v2(-1.0, 0.75), v2(1.0, 0.0), &u).len(), 2);
    }

    #[test]
    fn muster_liefern_linien() {
        let sq = square();
        assert!(!build_hatch_runs(&sq, &hatch(Pattern::Diagonal)).is_empty());
        let d = build_hatch_runs(&sq, &hatch(Pattern::Diagonal)).len();
        assert!(build_hatch_runs(&sq, &hatch(Pattern::Crosshatch)).len() > d);
        assert!(!build_hatch_runs(&sq, &hatch(Pattern::Insulation)).is_empty());
        assert!(build_hatch_runs(&sq, &hatch(Pattern::Solid)).is_empty());
        assert!(build_hatch_runs(&sq, &hatch(Pattern::None)).is_empty());
        let mut r = hatch(Pattern::Diagonal);
        r.random = true;
        let a = build_hatch_runs(&sq, &r);
        assert!(!a.is_empty());
        assert_eq!(a, build_hatch_runs(&sq, &r));
        r.seed = Some(8.0);
        assert_ne!(a, build_hatch_runs(&sq, &r));
    }

    #[test]
    fn unendliches_polygon_haengt_nicht() {
        let p = vec![v2(0.0, 0.0), v2(f64::INFINITY, 0.0), v2(1.0, 1.0)];
        assert!(build_hatch_runs(&p, &hatch(Pattern::Diagonal)).is_empty());
        assert!(build_hatch_runs(&p, &hatch(Pattern::Insulation)).is_empty());
    }

    fn band(len: f64, t: f64) -> Vec<V2> {
        vec![v2(0.0, 0.0), v2(len, 0.0), v2(len, t), v2(0.0, t)]
    }

    fn extent(runs: &[Run], f: impl Fn(&V2) -> f64) -> (f64, f64) {
        runs.iter().flatten().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(f(p)), hi.max(f(p))))
    }

    /// [109] Schicht-Muster spannen über die ganze Schichtdicke und laufen entlang der Schicht.
    #[test]
    fn schichtmuster_ueber_ganze_dicke() {
        for pat in [Pattern::Insulation, Pattern::InsulationHard, Pattern::InsulationWave, Pattern::Timber] {
            let mut h = hatch(pat);
            h.angle = 0.0;
            let runs = build_hatch_runs(&band(1.0, 0.16), &h);
            assert!(!runs.is_empty(), "{pat:?}");
            let (lo, hi) = extent(&runs, |p| p.y);
            assert!(lo < 0.005 && hi > 0.155, "{pat:?}: {lo}..{hi}");
            let (ulo, uhi) = extent(&runs, |p| p.x);
            assert!(ulo < 0.02 && uhi > 0.98, "{pat:?}: {ulo}..{uhi}");
            // Wand senkrecht (Winkel −90°): Muster läuft in y, spannt die Dicke in x.
            h.angle = -90.0;
            let vert: Vec<V2> = band(1.0, 0.16).iter().map(|p| v2(p.y, p.x)).collect();
            let (xlo, xhi) = extent(&build_hatch_runs(&vert, &h), |p| p.x);
            assert!(xlo < 0.005 && xhi > 0.155, "{pat:?} senkrecht: {xlo}..{xhi}");
        }
    }

    /// Die Dämmschlange bildet Schlaufen (läuft stellenweise zurück), Steigung ≈ 0.45 · Dicke.
    #[test]
    fn daemmschlange_hat_schlaufen() {
        let mut h = hatch(Pattern::Insulation);
        h.angle = 0.0;
        let runs = build_hatch_runs(&band(2.0, 0.2), &h);
        let back = runs.iter().any(|r| r.windows(2).any(|w| w[1].x < w[0].x - 1e-6));
        assert!(back, "Schlaufen fehlen");
        // Scheitel oben: Anzahl Annäherungen an die Oberkante ≈ Länge / Steigung (2.0 / 0.09 ≈ 22).
        let tops = runs.iter().flat_map(|r| r.windows(3)).filter(|w| w[1].y > w[0].y && w[1].y >= w[2].y && w[1].y > 0.199).count();
        assert!((19..=25).contains(&tops), "{tops}");
    }

    /// Breite Flächen werden in Bänder geteilt (keine riesige Schlange).
    #[test]
    fn breite_flaeche_in_baender() {
        let mut h = hatch(Pattern::InsulationHard);
        h.angle = 0.0;
        let runs = build_hatch_runs(&band(1.0, 1.2), &h);
        let max_rise = runs.iter().flat_map(|r| r.windows(2)).map(|w| (w[1].y - w[0].y).abs()).fold(0.0, f64::max);
        assert!(max_rise < 0.31 && max_rise > 0.29, "{max_rise}");
    }

    #[test]
    fn erdreich_kies_naturstein() {
        let sq = band(1.0, 1.0);
        for pat in [Pattern::Earth, Pattern::Gravel, Pattern::Stone] {
            let runs = build_hatch_runs(&sq, &hatch(pat));
            assert!(!runs.is_empty(), "{pat:?}");
            let (lo, hi) = extent(&runs, |p| p.x);
            assert!(lo >= -1e-9 && hi <= 1.0 + 1e-9, "{pat:?} ausserhalb");
        }
        // Kies: geschlossene Kreise, gleiche Fläche → gleiche Steine (modellraum-stabil).
        let a = build_hatch_runs(&sq, &hatch(Pattern::Gravel));
        assert_eq!(a, build_hatch_runs(&sq, &hatch(Pattern::Gravel)));
        assert!(a.iter().filter(|r| r.len() == 13 && r[0] == r[12]).count() > 300);
        // Naturstein: doppelt so viele Linien wie Diagonal.
        let d = build_hatch_runs(&sq, &hatch(Pattern::Diagonal)).len() as f64;
        let st = build_hatch_runs(&sq, &hatch(Pattern::Stone)).len() as f64;
        assert!((st / d - 2.0).abs() < 0.1, "{st} / {d}");
    }

    /// Putz: ruhiges Punktfeld entlang der Schicht, nur ganze Punkte, stabil, versetzte Reihen; auch eine
    /// dünne Putzschicht (1.5 cm) bekommt mindestens eine Reihe.
    #[test]
    fn putz_punktfeld() {
        let mut h = hatch(Pattern::Dots);
        h.angle = 0.0;
        h.scale = 0.4; // Teilung 2 cm
        let sq = band(1.0, 0.1);
        let runs = build_hatch_runs(&sq, &h);
        // 10 cm: 5 Reihen à ~50 Punkte
        assert!((200..300).contains(&runs.len()), "{}", runs.len());
        assert!(runs.iter().all(|r| r.len() == 2 && (r[1].x - r[0].x - 0.006).abs() < 1e-9 && r[0].y == r[1].y), "Punkte sind winzige Striche");
        let (lo, hi) = extent(&runs, |p| p.x);
        assert!(lo >= 0.0 && hi <= 1.0);
        assert_eq!(runs, build_hatch_runs(&sq, &h));
        let (ylo, yhi) = extent(&runs, |p| p.y);
        assert!(ylo > 0.0 && yhi < 0.1);
        // dünne Schicht
        let thin = build_hatch_runs(&band(1.0, 0.015), &h);
        assert!(thin.len() > 30, "{}", thin.len());
        assert!(thin.iter().all(|r| r[0].y >= 0.0 && r[0].y <= 0.015));
        // versetzte Reihen: mindestens zwei Phasen in x
        let mut phases: Vec<i64> = runs.iter().map(|r| ((r[0].x / 0.02).rem_euclid(1.0) * 100.0).round() as i64 % 100).collect();
        phases.sort();
        phases.dedup();
        assert!(phases.len() >= 2, "{phases:?}");
    }

    #[test]
    fn schichtmuster_entartet_leer() {
        let p = vec![v2(0.0, 0.0), v2(f64::INFINITY, 0.0), v2(1.0, 1.0)];
        for pat in [Pattern::InsulationHard, Pattern::InsulationWave, Pattern::Timber, Pattern::Earth, Pattern::Gravel, Pattern::Stone, Pattern::Dots] {
            assert!(build_hatch_runs(&p, &hatch(pat)).is_empty(), "{pat:?}");
        }
        // Linie ohne Dicke
        assert!(build_hatch_runs(&[v2(0.0, 0.0), v2(1.0, 0.0), v2(2.0, 0.0)], &hatch(Pattern::Insulation)).is_empty());
    }

    #[test]
    fn strichmuster_zerlegt() {
        let run = vec![v2(0.0, 0.0), v2(1.0, 0.0)];
        let on = 0.5 / DASH_MM_TO_M; // 0.5 m an, 0.5 m aus → genau ein Strich
        let out = apply_dash_runs(vec![run.clone()], &[on]);
        assert_eq!(out.len(), 1);
        assert!((out[0][1].x - 0.5).abs() < 1e-9);
        assert_eq!(apply_dash_runs(vec![run.clone()], &[]).len(), 1);
        assert_eq!(apply_dash_runs(vec![run], &[0.0, -1.0]).len(), 1);
    }

    #[test]
    fn schraffur_strich_folgt_musterskala() {
        // SIA Estrich: Musterskala 0.35, Strich [1, 0.7] mm → Strich/Lücke im Verhältnis zum Abstand.
        let mut h = hatch(Pattern::Diagonal);
        h.scale = 0.35;
        h.dash = vec![1.0, 0.7];
        let d = hatch_dash(&h);
        assert!((d[0] - 0.35).abs() < 1e-12 && (d[1] - 0.245).abs() < 1e-12);
        // 8 cm Estrich-Schicht: jede Musterlinie (≈ 11 cm) zerfällt in mehrere Striche.
        let band = vec![v2(0.0, 0.0), v2(2.0, 0.0), v2(2.0, 0.08), v2(0.0, 0.08)];
        let solid = build_hatch_runs(&band, &h);
        let dashed = apply_dash_runs(solid.clone(), &d);
        assert!(dashed.len() >= solid.len() * 2, "{} vs {}", dashed.len(), solid.len());
        h.random = true;
        assert_eq!(hatch_dash(&h), vec![1.0, 0.7]);
    }

    #[test]
    fn zickzack_und_motiv() {
        let z = zigzag_points(v2(0.0, 0.0), v2(8.0, 0.0), 1.0, 4.0).unwrap();
        assert_eq!(z.len(), 9);
        assert_eq!(z[1], v2(1.0, 1.0));
        assert!(zigzag_points(v2(0.0, 0.0), v2(1.0, 0.0), 0.0, 4.0).is_none());
        let m = Motif { points: vec![v2(0.0, 0.0), v2(2.0, 1.0), v2(4.0, 0.0)], length: 4.0 };
        let p = motif_points(v2(0.0, 0.0), v2(12.0, 0.0), &m, 1.0);
        assert_eq!(p.first(), Some(&v2(0.0, 0.0)));
        assert_eq!(p.last(), Some(&v2(12.0, 0.0)));
        let short = Motif { points: vec![v2(0.0, 0.0)], length: 4.0 };
        assert_eq!(motif_points(v2(0.0, 0.0), v2(4.0, 0.0), &short, 1.0), vec![v2(0.0, 0.0), v2(4.0, 0.0)]);
    }

    #[test]
    fn mulberry_wie_js() {
        // Referenz aus JS: mulberry32(1)() = 0.6270739405881613
        let mut r = Mulberry32 { a: 1 };
        assert_eq!(r.next(), 0.6270739405881613);
    }
}
