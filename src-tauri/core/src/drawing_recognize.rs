//! Bauteile aus Zeichnung erkennen ([154]): aus den 2D-Linien eines Grundrisses (meist ein DXF/DWG-Import
//! aus ArchiCAD, Vectorworks, AutoCAD) werden editierbare Wände, Öffnungen und Räume.
//!
//! Ablauf ([`analyze`], rein geometrisch, ohne Projekt):
//! 1. **Linien** (Linien, Polylinien-Kanten, Rechtecke; Bögen aus `arc` und Polylinien-Bulges) nach Richtung
//!    gebündelt (±0.3°, Bündel höchstens 1° breit) und je Bündel auf Lage `c` (Abstand quer) + Intervall `t`
//!    projiziert; deckungsgleiche Stücke verschmelzen (gleicher Layer: auch Stoss an Stoss).
//! 2. **Wandpaare**: parallele Linien im Abstand 5–60 cm, Überlappung ≥ 50 % der kürzeren. Gierig nach
//!    Abstand (mit Füllung/Schraffur dazwischen zuerst), je Linienseite belegt jedes Stück höchstens einmal.
//!    Drei Linien übereinander (Schichtlinie, Achslinie) verschmelzen zu einer dicken Wand. Gibt es Layer
//!    mit Wand-Namen („Wand“, „Mauer“, „A-WALL“ …), zählen für die Paare nur deren Linien.
//! 3. **Läufe**: Stücke derselben Achse und Dicke werden eine Wand; Lücken bis 1.5 m immer, bis 4 m nur mit
//!    Tür-/Fenster-Hinweis darin. Dünne „Wände“ im Band einer dickeren (Fensterrahmen) entfallen.
//! 4. **Stösse**: Wandenden auf die Achse einer anderen Wand gezogen (L/T, Ende im Band ± 5 cm; mit
//!    Tür-/Fenster-Hinweis bis 4 m, Tür in der Ecke). Wände laufen um den Schwerpunkt herum (erste Schicht
//!    = rechts = aussen, wie [B4]).
//! 5. **Öffnungen**: was auf der Achse weder von Wandstücken noch vom Band einer kreuzenden Wand gedeckt
//!    ist (≥ 30 cm): Türbogen (50–130°, Zentrum an einem Pfosten, Radius = Breite bzw. halbe Breite bei zwei
//!    Bögen) → Tür mit Anschlag und Aufschlagseite; Linien parallel zur Wand im Band → Fenster; sonst
//!    Wanddurchbruch.
//! 6. **Räume**: Zellen der Wandachsen (`kernel2d::detect_rooms`, lichter Umriss), Name aus dem grössten Text
//!    darin, SIA-Kategorie (HNF …) und Flächenangabe („17.01 m²“, Abweichung > 5 % → unklar).
//!
//! Konzentrische Bögen im Abstand 5–60 cm werden Bogenwände (ohne Öffnungen und Stösse). Ergebnis als Ops
//! (ein Undo-Schritt, [`ops`]), Vorschau ([`preview`]) und Bericht ([`report`], erkannt / unklar mit Grund).

use crate::cmd_create::{add_op, category_color, has_category, obj, pv, pvs, s, s_of, Ctx, V};
use crate::cmd_transform::{IdGen, Shapes};
use crate::json_util::js_num;
use crate::jsmath::hypot2;
use crate::jsnum::{atan2, cos, sin, tan};
use crate::model::{Drawing2DGeom, LayerCategory, Project};
use crate::ops::Op;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::f64::consts::PI;

/// Wanddicke (m): kleinste und grösste.
pub const MIN_THICK: f64 = 0.05;
pub const MAX_THICK: f64 = 0.60;
/// Richtungs-Toleranz paralleler Linien (1°).
const PAR_TOL: f64 = 0.017_453_292_519_943_295;
/// Kette der Richtungs-Bündel (0.3°).
const ANG_CHAIN: f64 = 0.005_235_987_755_982_988;
/// Gleiche Lage quer (deckungsgleiche Linien).
const COL_TOL: f64 = 0.002;
/// Kürzestes Wandstück.
const MIN_PIECE: f64 = 0.05;
/// Lücken bis hier gehören immer zur Wand (Öffnung), bis [`GAP_MAX`] nur mit Hinweis.
const GAP_FREE: f64 = 1.5;
const GAP_MAX: f64 = 4.0;
/// Kleinste Öffnung.
const MIN_OPENING: f64 = 0.3;
/// Schutz vor quadratischem Aufwand.
const MAX_SEGS: usize = 60_000;
const MAX_ARCS: usize = 6_000;
/// Höchstzahl der Einträge „unklar“ im Bericht.
const MAX_UNCLEAR: usize = 200;

// ── Eingabe ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Seg {
    pub a: V,
    pub b: V,
    pub layer: usize,
}

/// Kreisbogen gegen den Uhrzeigersinn von `a0` über `sweep` (> 0).
#[derive(Clone, Debug)]
pub struct ArcIn {
    pub c: V,
    pub r: f64,
    pub a0: f64,
    pub sweep: f64,
    pub layer: usize,
}

#[derive(Clone, Debug)]
pub struct TextIn {
    pub at: V,
    pub text: String,
    pub h: f64,
    pub angle: f64,
}

/// Gefüllte/schraffierte geschlossene Fläche (Bestätigung + Material-Hinweis).
#[derive(Clone, Debug)]
pub struct FillIn {
    pub ring: Vec<V>,
    pub layer: usize,
    /// Name der Schraffur (Material-Hinweis), falls bekannt.
    pub hatch: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Input {
    /// Layer-Namen (Kategorie-Namen; beim DXF-Import = DXF-Layer).
    pub layers: Vec<String>,
    pub segs: Vec<Seg>,
    pub arcs: Vec<ArcIn>,
    pub texts: Vec<TextIn>,
    pub fills: Vec<FillIn>,
}

impl Input {
    pub fn layer(&mut self, name: &str) -> usize {
        if let Some(i) = self.layers.iter().position(|l| l == name) {
            return i;
        }
        self.layers.push(name.to_string());
        self.layers.len() - 1
    }
}

// ── Ergebnis ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct RWall {
    pub a: V,
    pub b: V,
    /// Bogenwand: Modell-Bulge (positiv = Uhrzeigersinn, s. `wall_arc`).
    pub bulge: Option<f64>,
    pub t: f64,
    /// Material-Hinweis (Gruppe, s. [`MATERIALS`]).
    pub material: Option<&'static str>,
    /// Füllung/Schraffur zwischen den Linien gefunden.
    pub filled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RKind {
    /// Tür: Scharnier am Ende (sonst am Anfang), Blatt rechts der Wandrichtung, Flügelzahl.
    Door { hinge_end: bool, swing_right: bool, leaves: u8 },
    Window,
    Void,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ROpening {
    pub wall: usize,
    /// Abstand des ersten Pfostens vom Wandanfang.
    pub pos: f64,
    pub width: f64,
    pub kind: RKind,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RRoom {
    pub ring: Vec<V>,
    pub name: Option<String>,
    pub sia: Option<&'static str>,
    pub area_text: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Unclear {
    pub code: &'static str,
    pub at: V,
}

#[derive(Clone, Debug, Default)]
pub struct Recognition {
    pub walls: Vec<RWall>,
    pub openings: Vec<ROpening>,
    pub rooms: Vec<RRoom>,
    pub unclear: Vec<Unclear>,
    /// Nur Linien auf Wand-Layern verwendet.
    pub layer_filter: bool,
}

impl Recognition {
    fn flag(&mut self, code: &'static str, at: V) {
        if self.unclear.len() < MAX_UNCLEAR && at.0.is_finite() && at.1.is_finite() {
            self.unclear.push(Unclear { code, at });
        }
    }
    pub fn count(&self, f: impl Fn(&RKind) -> bool) -> usize {
        self.openings.iter().filter(|o| f(&o.kind)).count()
    }
}

// ── Vektoren ─────────────────────────────────────────────────────────────────

fn add(a: V, b: V) -> V {
    (a.0 + b.0, a.1 + b.1)
}
fn sub(a: V, b: V) -> V {
    (a.0 - b.0, a.1 - b.1)
}
fn mul(a: V, k: f64) -> V {
    (a.0 * k, a.1 * k)
}
fn dot(a: V, b: V) -> f64 {
    a.0 * b.0 + a.1 * b.1
}
fn cross(a: V, b: V) -> f64 {
    a.0 * b.1 - a.1 * b.0
}
fn len(a: V) -> f64 {
    hypot2(a.0, a.1)
}
fn fin(p: V) -> bool {
    p.0.is_finite() && p.1.is_finite()
}

fn polygon_area(r: &[V]) -> f64 {
    let n = r.len();
    let mut s = 0.0;
    for i in 0..n {
        s += cross(r[i], r[(i + 1) % n]);
    }
    s / 2.0
}

fn point_in(r: &[V], p: V) -> bool {
    let n = r.len();
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (r[i], r[j]);
        if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Winkel in [0, 2π).
fn wrap2pi(a: f64) -> f64 {
    let mut x = a % (2.0 * PI);
    if x < 0.0 {
        x += 2.0 * PI;
    }
    if x >= 2.0 * PI - 1e-12 {
        x = 0.0;
    }
    x
}

// ── Layer- und Material-Hinweise ─────────────────────────────────────────────

/// Layer-Namen, die Wände tragen (Teilwort, klein).
const WALL_WORDS: [&str; 6] = ["wand", "wände", "waende", "mauer", "wall", "murs"];

pub fn wallish_layer(name: &str) -> bool {
    let l = name.to_lowercase();
    WALL_WORDS.iter().any(|w| l.contains(w))
}

/// Material-Gruppen: (Gruppe, Teilwörter, kurze Wörter nur als ganzes Wort).
const MATERIALS: [(&str, &[&str], &[&str]); 6] = [
    ("beton", &["beton", "concrete"], &["stb", "sb"]),
    ("mauerwerk", &["mauerwerk", "backstein", "ziegel", "brick", "masonry"], &["mw", "bks"]),
    ("kalksandstein", &["kalksand"], &["ks"]),
    ("holz", &["holz", "wood", "timber"], &[]),
    ("daemmung", &["dämm", "daemm", "insul"], &[]),
    ("leichtbau", &["gips", "drywall", "leichtbau", "trockenbau"], &["gk", "gkb"]),
];

pub fn material_of(text: &str) -> Option<&'static str> {
    let l = text.to_lowercase();
    let words: Vec<&str> = l.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    MATERIALS.iter().find(|(_, long, short)| long.iter().any(|w| l.contains(w)) || words.iter().any(|w| short.contains(w))).map(|m| m.0)
}

// ── Tessellierte Bögen ───────────────────────────────────────────────────────

/// Kreis durch drei Punkte (relativ zum ersten gerechnet: Landeskoordinaten bleiben genau).
fn circle3(a: V, b: V, c: V) -> Option<(V, f64)> {
    let (b, c) = (sub(b, a), sub(c, a));
    let d = 2.0 * cross(b, c);
    if d.abs() < 1e-12 {
        return None;
    }
    let (b2, c2) = (dot(b, b), dot(c, c));
    let u = ((c.1 * b2 - b.1 * c2) / d, (b.0 * c2 - c.0 * b2) / d);
    let r = len(u);
    (r.is_finite() && fin(u)).then_some((add(a, u), r))
}

/// Grösste Kantenlänge und Drehung je Ecke eines tessellierten Bogens; Abstand der Ecken vom Kreis.
const TESS_MAX_EDGE: f64 = 2.0;
const TESS_MAX_TURN: f64 = 0.436_332_312_998_582_4; // 25°
const TESS_MIN_TURN: f64 = 0.003_490_658_503_988_659; // 0.2°
const TESS_TOL: f64 = 0.003;

/// Linienzug (offen; geschlossen mit wiederholtem Anfang) in Strecken und Bögen: ≥ 3 kurze Kanten mit
/// gleichsinniger Drehung (0.2–25° je Ecke), deren Ecken auf einem Kreis liegen (± 3 mm, r ≤ 100 m),
/// werden ein Bogen (DXF-Exporte zerlegen Bögen oft in Sehnen).
fn fit_arcs(pts: &[V], layer: usize, segs: &mut Vec<Seg>, arcs: &mut Vec<ArcIn>) {
    if pts.len() < 2 {
        return;
    }
    let nseg = pts.len() - 1;
    let short = |k: usize| len(sub(pts[k + 1], pts[k])) <= TESS_MAX_EDGE;
    let turn = |k: usize| {
        let (d1, d2) = (sub(pts[k + 1], pts[k]), sub(pts[k + 2], pts[k + 1]));
        atan2(cross(d1, d2), dot(d1, d2))
    };
    let mut i = 0;
    while i < nseg {
        let mut j = i;
        if short(i) && i + 1 < nseg {
            let t0 = turn(i);
            if (TESS_MIN_TURN..=TESS_MAX_TURN).contains(&t0.abs()) {
                while j + 1 < nseg && short(j + 1) {
                    let t = turn(j);
                    if t * t0 <= 0.0 || !(TESS_MIN_TURN..=TESS_MAX_TURN).contains(&t.abs()) {
                        break;
                    }
                    j += 1;
                }
            }
            if j - i + 1 >= 3 {
                if let Some(arc) = fit_run(&pts[i..=j + 1], t0, layer) {
                    arcs.push(arc);
                    i = j + 1;
                    continue;
                }
            }
        }
        segs.push(Seg { a: pts[i], b: pts[i + 1], layer });
        i += 1;
    }
}

fn fit_run(p: &[V], turn: f64, layer: usize) -> Option<ArcIn> {
    let (s, e) = (p[0], p[p.len() - 1]);
    let (c, r) = circle3(s, p[p.len() / 2], e)?;
    if r > 100.0 || p.iter().any(|q| (len(sub(*q, c)) - r).abs() > TESS_TOL) {
        return None;
    }
    let ang = |q: V| wrap2pi(atan2(q.1 - c.1, q.0 - c.0));
    let (from, to) = if turn > 0.0 { (s, e) } else { (e, s) };
    let a0 = ang(from);
    let mut sweep = wrap2pi(ang(to) - a0);
    if sweep < 1e-9 {
        sweep = 2.0 * PI;
    }
    Some(ArcIn { c, r, a0, sweep, layer })
}

// ── Einlesen aus dem Projekt ─────────────────────────────────────────────────

fn flatten_names(list: &[LayerCategory], out: &mut HashMap<String, String>) {
    for c in list {
        out.insert(c.code.clone(), c.name.clone());
        if let Some(ch) = &c.children {
            flatten_names(ch, out);
        }
    }
}

/// Bogen aus einer Polylinien-Kante mit Modell-Bulge (gegen den Uhrzeigersinn normalisiert).
fn bulge_arc(a: V, b: V, bulge: f64, layer: usize) -> Option<ArcIn> {
    let k = kernel2d::bulge_arc(kernel2d::Vec2::new(a.0, a.1), kernel2d::Vec2::new(b.0, b.1), bulge)?;
    if !(k.r.is_finite() && k.r > 1e-6 && k.sweep.is_finite()) {
        return None;
    }
    let (a0, sweep) = if k.sweep >= 0.0 { (k.a0, k.sweep) } else { (k.a0 + k.sweep, -k.sweep) };
    Some(ArcIn { c: (k.center.x, k.center.y), r: k.r, a0: wrap2pi(a0), sweep, layer })
}

/// Linien, Bögen, Texte und Füllungen der Zeichnungen: `ids` (Auswahl) oder alle der Ebene `level`.
pub fn collect(p: &Project, level: &str, ids: &[String]) -> Input {
    let mut names = HashMap::new();
    flatten_names(&p.layers, &mut names);
    let hatch_names: HashMap<&str, &str> = p.hatches.iter().map(|h| (h.id.as_str(), h.name.as_str())).collect();
    let mut inp = Input::default();
    let pick: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    for d in &p.drawings2d {
        if if pick.is_empty() { d.level_id != level } else { !pick.contains(d.id.as_str()) } {
            continue;
        }
        let lname = names.get(&d.category_code).cloned().unwrap_or_else(|| d.category_code.clone());
        let layer = inp.layer(&lname);
        let filled = d.fill_color.is_some() || d.hatch_id.is_some() || d.background.is_some();
        let hatch = d.hatch_id.as_deref().and_then(|h| hatch_names.get(h)).map(|s| s.to_string());
        let fill = |inp: &mut Input, ring: Vec<V>| {
            if filled && ring.len() >= 3 {
                inp.fills.push(FillIn { ring, layer, hatch: hatch.clone() });
            }
        };
        match &d.geom {
            Drawing2DGeom::Line { a, b } => inp.segs.push(Seg { a: (a.x, a.y), b: (b.x, b.y), layer }),
            Drawing2DGeom::Polyline { pts, closed, bulge, .. } if bulge.as_ref().is_none_or(|b| b.iter().all(|x| !(x.abs() > 1e-9))) => {
                let mut v: Vec<V> = pts.iter().map(|q| (q.x, q.y)).collect();
                if *closed && v.len() >= 3 {
                    v.push(v[0]);
                }
                fit_arcs(&v, layer, &mut inp.segs, &mut inp.arcs);
                if *closed {
                    fill(&mut inp, pts.iter().map(|q| (q.x, q.y)).collect());
                }
            }
            Drawing2DGeom::Polyline { pts, closed, bulge, .. } => {
                let n = pts.len();
                let m = if *closed { n } else { n.saturating_sub(1) };
                for i in 0..m {
                    let (a, b) = ((pts[i].x, pts[i].y), (pts[(i + 1) % n].x, pts[(i + 1) % n].y));
                    let bl = bulge.as_ref().and_then(|v| v.get(i).copied()).filter(|b| b.is_finite() && b.abs() > 1e-9);
                    match bl.and_then(|bl| bulge_arc(a, b, bl, layer)) {
                        Some(arc) => inp.arcs.push(arc),
                        None => inp.segs.push(Seg { a, b, layer }),
                    }
                }
                if *closed {
                    fill(&mut inp, pts.iter().map(|q| (q.x, q.y)).collect());
                }
            }
            Drawing2DGeom::Rect { min, max } => {
                let c = [(min.x, min.y), (max.x, min.y), (max.x, max.y), (min.x, max.y)];
                for i in 0..4 {
                    inp.segs.push(Seg { a: c[i], b: c[(i + 1) % 4], layer });
                }
                fill(&mut inp, c.to_vec());
            }
            Drawing2DGeom::Arc { center, r, a0, a1 } => {
                let mut sweep = a1 - a0;
                while sweep <= 0.0 && sweep.is_finite() {
                    sweep += 2.0 * PI;
                }
                if r.is_finite() && *r > 1e-6 && sweep.is_finite() && a0.is_finite() {
                    inp.arcs.push(ArcIn { c: (center.x, center.y), r: *r, a0: wrap2pi(*a0), sweep: sweep.min(2.0 * PI), layer });
                }
            }
            Drawing2DGeom::Circle { center, r } => {
                if r.is_finite() && *r > 1e-6 {
                    inp.arcs.push(ArcIn { c: (center.x, center.y), r: *r, a0: 0.0, sweep: 2.0 * PI, layer });
                }
            }
            Drawing2DGeom::Text { at, text, height, angle, .. } => {
                inp.texts.push(TextIn { at: (at.x, at.y), text: text.clone(), h: *height, angle: *angle });
            }
            _ => {}
        }
    }
    inp.segs.retain(|s| fin(s.a) && fin(s.b) && len(sub(s.b, s.a)) > 1e-4);
    inp.arcs.retain(|a| fin(a.c) && a.r.is_finite() && a.a0.is_finite());
    inp.texts.retain(|t| fin(t.at) && !t.text.trim().is_empty());
    inp
}

// ── 1. Linien bündeln ────────────────────────────────────────────────────────

/// Linie im Rahmen ihres Richtungs-Bündels.
#[derive(Clone, Debug)]
struct Line {
    cl: usize,
    c: f64,
    t0: f64,
    t1: f64,
    layer: usize,
    wallish: bool,
}

#[derive(Clone, Copy, Debug)]
struct Frame {
    u: V,
    n: V,
}

impl Frame {
    fn of_angle(th: f64) -> Frame {
        let u = (cos(th), sin(th));
        Frame { u, n: (-u.1, u.0) }
    }
    fn at(&self, c: f64, t: f64) -> V {
        add(mul(self.n, c), mul(self.u, t))
    }
}

/// Richtungs-Bündel: Rahmen je Bündel, Bündel je Strecke.
fn bundle(segs: &[(V, V)]) -> (Vec<Frame>, Vec<usize>) {
    let ang: Vec<f64> = segs
        .iter()
        .map(|(a, b)| {
            let mut th = atan2(b.1 - a.1, b.0 - a.0);
            if th < 0.0 {
                th += PI;
            }
            if th >= PI - 1e-12 {
                th -= PI;
            }
            th
        })
        .collect();
    let mut idx: Vec<usize> = (0..segs.len()).collect();
    idx.sort_by(|&i, &j| ang[i].total_cmp(&ang[j]));
    let mut cl_of = vec![0usize; segs.len()];
    let mut starts: Vec<f64> = Vec::new();
    let mut prev = f64::NEG_INFINITY;
    for &i in &idx {
        let th = ang[i];
        if starts.is_empty() || th - prev > ANG_CHAIN || th - starts[starts.len() - 1] > PAR_TOL {
            starts.push(th);
        }
        cl_of[i] = starts.len() - 1;
        prev = th;
    }
    // Rundum: Bündel knapp unter π gehört zum Bündel bei 0.
    if starts.len() > 1 && starts[0] < ANG_CHAIN {
        let last = starts.len() - 1;
        let max_last = idx.iter().filter(|&&i| cl_of[i] == last).map(|&i| ang[i]).fold(0.0, f64::max);
        if max_last > PI - ANG_CHAIN && max_last - starts[last] < PAR_TOL {
            for c in cl_of.iter_mut() {
                if *c == last {
                    *c = 0;
                }
            }
            starts.pop();
        }
    }
    (starts.iter().map(|&th| Frame::of_angle(th)).collect(), cl_of)
}

/// Strecken auf ihr Bündel projizieren und deckungsgleiche verschmelzen.
fn lines_of(segs: &[Seg], wallish: &[bool], frames: &[Frame], cl_of: &[usize]) -> Vec<Line> {
    let mut raw: Vec<Line> = segs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let f = frames[cl_of[i]];
            let (ta, tb) = (dot(f.u, s.a), dot(f.u, s.b));
            Line { cl: cl_of[i], c: (dot(f.n, s.a) + dot(f.n, s.b)) / 2.0, t0: ta.min(tb), t1: ta.max(tb), layer: s.layer, wallish: wallish[s.layer] }
        })
        .collect();
    raw.sort_by(|a, b| a.cl.cmp(&b.cl).then(a.c.total_cmp(&b.c)));
    let mut out = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let mut j = i + 1;
        while j < raw.len() && raw[j].cl == raw[i].cl && raw[j].c - raw[j - 1].c <= COL_TOL && raw[j].c - raw[i].c <= 2.0 * COL_TOL {
            j += 1;
        }
        let mut g: Vec<Line> = raw[i..j].to_vec();
        g.sort_by(|a, b| a.t0.total_cmp(&b.t0));
        let mut cur = g[0].clone();
        for l in g.into_iter().skip(1) {
            let joins = l.t0 <= cur.t1 - 1e-3 || (l.t0 <= cur.t1 + 1e-3 && l.layer == cur.layer);
            if joins {
                cur.t1 = cur.t1.max(l.t1);
                if l.wallish && !cur.wallish {
                    cur.layer = l.layer;
                    cur.wallish = true;
                }
            } else {
                out.push(std::mem::replace(&mut cur, l));
            }
        }
        out.push(cur);
        i = j;
    }
    out
}

// ── Intervalle ───────────────────────────────────────────────────────────────

/// Vereinigung (sortiert, verschmolzen).
fn union(mut iv: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    iv.retain(|i| i.1 > i.0);
    iv.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for i in iv {
        match out.last_mut() {
            Some(l) if i.0 <= l.1 + 1e-6 => l.1 = l.1.max(i.1),
            _ => out.push(i),
        }
    }
    out
}

/// `[a, b]` ohne die Intervalle `used` (vereinigt).
fn subtract(a: f64, b: f64, used: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut cur = a;
    for &(u0, u1) in used {
        if u1 <= cur {
            continue;
        }
        if u0 >= b {
            break;
        }
        if u0 > cur {
            out.push((cur, u0.min(b)));
        }
        cur = cur.max(u1);
        if cur >= b {
            break;
        }
    }
    if cur < b {
        out.push((cur, b));
    }
    out
}

// ── 2. Wandpaare ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Piece {
    cl: usize,
    /// Untere / obere Linie (nach `c`).
    lo: usize,
    hi: usize,
    c: f64,
    t: f64,
    s0: f64,
    s1: f64,
    filled: bool,
    material: Option<&'static str>,
}

struct Ctx2<'a> {
    inp: &'a Input,
    frames: Vec<Frame>,
    lines: Vec<Line>,
    /// Alle Strecken (alle Layer) mit ihrem Bündel, für die Fenster-Hinweise.
    all: Vec<(V, V)>,
    /// Bögen, die eine Tür sein können (nicht als Wand verwendet).
    door_arcs: Vec<usize>,
}

fn fill_at(inp: &Input, p: V) -> Option<&FillIn> {
    inp.fills.iter().find(|f| {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for q in &f.ring {
            x0 = x0.min(q.0);
            y0 = y0.min(q.1);
            x1 = x1.max(q.0);
            y1 = y1.max(q.1);
        }
        p.0 >= x0 && p.0 <= x1 && p.1 >= y0 && p.1 <= y1 && point_in(&f.ring, p)
    })
}

fn pieces(cx: &Ctx2) -> Vec<Piece> {
    struct Cand {
        i: usize,
        j: usize,
        d: f64,
        t0: f64,
        t1: f64,
        filled: bool,
        material: Option<&'static str>,
    }
    let lines = &cx.lines;
    let mut by_cl: Vec<Vec<usize>> = vec![Vec::new(); cx.frames.len()];
    for (i, l) in lines.iter().enumerate() {
        by_cl[l.cl].push(i);
    }
    let mut cands = Vec::new();
    for (cl, ids) in by_cl.iter_mut().enumerate() {
        ids.sort_by(|&a, &b| lines[a].c.total_cmp(&lines[b].c));
        let f = cx.frames[cl];
        for (k, &i) in ids.iter().enumerate() {
            let li = &lines[i];
            for &j in &ids[k + 1..] {
                let lj = &lines[j];
                let d = lj.c - li.c;
                if d > MAX_THICK + 1e-3 {
                    break;
                }
                if d < MIN_THICK - 1e-3 {
                    continue;
                }
                let (t0, t1) = (li.t0.max(lj.t0), li.t1.min(lj.t1));
                let ov = t1 - t0;
                if ov < MIN_PIECE || ov < 0.5 * (li.t1 - li.t0).min(lj.t1 - lj.t0) - 1e-9 {
                    continue;
                }
                let mid = f.at(li.c + d / 2.0, (t0 + t1) / 2.0);
                let fill = fill_at(cx.inp, mid);
                let material = fill
                    .and_then(|f| f.hatch.as_deref().and_then(material_of).or_else(|| material_of(&cx.inp.layers[f.layer])))
                    .or_else(|| material_of(&cx.inp.layers[li.layer]))
                    .or_else(|| material_of(&cx.inp.layers[lj.layer]));
                cands.push(Cand { i, j, d, t0, t1, filled: fill.is_some(), material });
            }
        }
    }
    cands.sort_by(|a, b| (!a.filled).cmp(&!b.filled).then(a.d.total_cmp(&b.d)).then((b.t1 - b.t0).total_cmp(&(a.t1 - a.t0))));
    // Belegung je Linie und Seite: 0 = oben (+n), 1 = unten (−n).
    let mut used: Vec<[Vec<(f64, f64)>; 2]> = vec![[Vec::new(), Vec::new()]; lines.len()];
    let mut out = Vec::new();
    for c in cands {
        let mut busy = used[c.i][0].clone();
        busy.extend(used[c.j][1].iter().copied());
        let busy = union(busy);
        let free = subtract(c.t0, c.t1, &busy);
        for (s0, s1) in free.into_iter().filter(|f| f.1 - f.0 >= MIN_PIECE) {
            used[c.i][0].push((s0, s1));
            used[c.j][1].push((s0, s1));
            used[c.i][0] = union(std::mem::take(&mut used[c.i][0]));
            used[c.j][1] = union(std::mem::take(&mut used[c.j][1]));
            out.push(Piece { cl: lines[c.i].cl, lo: c.i, hi: c.j, c: lines[c.i].c + c.d / 2.0, t: c.d, s0, s1, filled: c.filled, material: c.material });
        }
    }
    stack(out, lines)
}

/// Drei Linien übereinander (Schicht-/Achslinie): Paare unten–Mitte und Mitte–oben → eine Wand.
fn stack(mut ps: Vec<Piece>, lines: &[Line]) -> Vec<Piece> {
    loop {
        let mut found = None;
        'outer: for (a, p) in ps.iter().enumerate() {
            for (b, q) in ps.iter().enumerate() {
                if a == b || q.lo != p.hi || q.cl != p.cl || p.t + q.t > MAX_THICK + 1e-3 {
                    continue;
                }
                // Nur Schichten über (fast) dieselbe Strecke: der Abschluss einer anstossenden Wand (kurze
                // Querlinie) ist keine Schichtlinie.
                let (s0, s1) = (p.s0.max(q.s0), p.s1.min(q.s1));
                if s1 - s0 >= MIN_PIECE && s1 - s0 >= 0.5 * (p.s1 - p.s0).max(q.s1 - q.s0) {
                    found = Some((a, b, s0, s1));
                    break 'outer;
                }
            }
        }
        let Some((a, b, s0, s1)) = found else { return ps };
        let (p, q) = (ps[a].clone(), ps[b].clone());
        let (clo, chi) = (lines[p.lo].c, lines[q.hi].c);
        let mut add = vec![Piece {
            cl: p.cl,
            lo: p.lo,
            hi: q.hi,
            c: (clo + chi) / 2.0,
            t: chi - clo,
            s0,
            s1,
            filled: p.filled || q.filled,
            material: p.material.or(q.material),
        }];
        // Reste ausserhalb der gemeinsamen Strecke nur, wenn sie wie eigene Wände lang sind.
        for r in [&p, &q] {
            for (r0, r1) in [(r.s0, s0), (s1, r.s1)] {
                if r1 - r0 >= 0.5 {
                    add.push(Piece { s0: r0, s1: r1, ..r.clone() });
                }
            }
        }
        let (hi, lo) = (a.max(b), a.min(b));
        ps.remove(hi);
        ps.remove(lo);
        ps.extend(add);
    }
}

// ── Hinweise in einer Lücke ──────────────────────────────────────────────────

/// Türbogen? (Öffnungswinkel 50–130°, Radius 0.3–2 m.)
fn door_like(a: &ArcIn) -> bool {
    a.sweep >= 50f64.to_radians() && a.sweep <= 130f64.to_radians() && a.r >= 0.3 && a.r <= 2.0
}

fn arc_mid(a: &ArcIn) -> V {
    let m = a.a0 + a.sweep / 2.0;
    add(a.c, (a.r * cos(m), a.r * sin(m)))
}

/// Wand-Rahmen einer Lücke: Ursprung `o`, Richtung `u`, Normale `n`, Achse bei n = 0.
#[derive(Clone, Copy)]
struct Band {
    o: V,
    u: V,
    n: V,
    t: f64,
}

impl Band {
    fn st(&self, p: V) -> (f64, f64) {
        let d = sub(p, self.o);
        (dot(d, self.u), dot(d, self.n))
    }
}

/// Türbögen an der Lücke `[g0, g1]`: (Bogen, am Anfang?, ganze Breite?).
fn door_arcs_at(cx: &Ctx2, b: &Band, g0: f64, g1: f64) -> Vec<(usize, bool, bool)> {
    let w = g1 - g0;
    let mut out = Vec::new();
    for &k in &cx.door_arcs {
        let a = &cx.inp.arcs[k];
        let (sc, nc) = b.st(a.c);
        if nc.abs() > b.t / 2.0 + 0.15 {
            continue;
        }
        let at_start = (sc - g0).abs() <= 0.15;
        let at_end = (sc - g1).abs() <= 0.15;
        if !(at_start || at_end) {
            continue;
        }
        let full = (a.r - w).abs() <= 0.12 * w + 0.05;
        let half = (a.r - w / 2.0).abs() <= 0.06 * w + 0.05;
        if full || half {
            out.push((k, at_start && (!at_end || (sc - g0).abs() <= (sc - g1).abs()), full));
        }
    }
    out
}

/// Fensterlinien: parallel zur Wand, im Band (nicht auf den Wandflächen), über ≥ 50 % der Lücke.
fn window_lines_at(cx: &Ctx2, b: &Band, g0: f64, g1: f64) -> usize {
    let w = g1 - g0;
    let sin_tol = PAR_TOL.sin();
    cx.all
        .iter()
        .filter(|(p, q)| {
            let d = sub(*q, *p);
            let l = len(d);
            if l < 1e-6 || cross(mul(d, 1.0 / l), b.u).abs() > sin_tol {
                return false;
            }
            let ((s0, n0), (s1, n1)) = (b.st(*p), b.st(*q));
            let n = (n0 + n1) / 2.0;
            let ov = s0.max(s1).min(g1) - s0.min(s1).max(g0);
            // Nicht viel länger als die Lücke (keine durchlaufende Achs-/Deckenlinie).
            n.abs() < b.t / 2.0 - 0.005 && ov >= 0.5 * w && l <= w + 0.4
        })
        .count()
}

fn evidence(cx: &Ctx2, b: &Band, g0: f64, g1: f64) -> bool {
    !door_arcs_at(cx, b, g0, g1).is_empty() || window_lines_at(cx, b, g0, g1) > 0
}

// ── 3. Läufe ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Run {
    cl: usize,
    c: f64,
    t: f64,
    s0: f64,
    s1: f64,
    cover: Vec<(f64, f64)>,
    filled: bool,
    material: Option<&'static str>,
}

fn runs(cx: &Ctx2, mut ps: Vec<Piece>) -> Vec<Run> {
    ps.sort_by(|a, b| a.cl.cmp(&b.cl).then(a.c.total_cmp(&b.c)));
    // Gruppen gleicher Achse und Dicke.
    let mut groups: Vec<Vec<Piece>> = Vec::new();
    for p in ps {
        match groups.iter_mut().rev().take_while(|g| g[0].cl == p.cl && p.c - g[0].c <= 0.01).find(|g| (g[0].t - p.t).abs() <= 0.006) {
            Some(g) => g.push(p),
            None => groups.push(vec![p]),
        }
    }
    let mut out: Vec<Run> = Vec::new();
    for mut g in groups {
        g.sort_by(|a, b| a.s0.total_cmp(&b.s0));
        let f = cx.frames[g[0].cl];
        let mk = |p: &Piece| Run { cl: p.cl, c: p.c, t: p.t, s0: p.s0, s1: p.s1, cover: vec![(p.s0, p.s1)], filled: p.filled, material: p.material };
        let mut cur = mk(&g[0]);
        for p in g.iter().skip(1) {
            let gap = p.s0 - cur.s1;
            let band = Band { o: f.at(cur.c, 0.0), u: f.u, n: f.n, t: cur.t };
            let merge = gap <= GAP_FREE || (gap <= GAP_MAX && evidence(cx, &band, cur.s1, p.s0));
            if merge {
                cur.s1 = cur.s1.max(p.s1);
                cur.cover.push((p.s0, p.s1));
                cur.filled |= p.filled;
                cur.material = cur.material.or(p.material);
            } else {
                out.push(std::mem::replace(&mut cur, mk(p)));
            }
        }
        out.push(cur);
    }
    // Was ganz im Band einer grösseren Wand liegt, entfällt: Fensterrahmen/Brüstung (dünn, gleiche Richtung)
    // und Scheinpaare aus Abschlusslinien anstossender oder durchlaufender Wände (quer).
    let corners = |r: &Run| -> [V; 4] {
        let f = cx.frames[r.cl];
        let h = r.t / 2.0;
        [f.at(r.c - h, r.s0), f.at(r.c + h, r.s0), f.at(r.c + h, r.s1), f.at(r.c - h, r.s1)]
    };
    let inside = |p: V, q: &Run| {
        let f = cx.frames[q.cl];
        let (s, n) = (dot(p, f.u), dot(p, f.n) - q.c);
        s >= q.s0 - 0.005 && s <= q.s1 + 0.005 && n.abs() <= q.t / 2.0 + 0.005
    };
    let area = |r: &Run| r.t * (r.s1 - r.s0);
    let keep: Vec<bool> = out
        .iter()
        .enumerate()
        .map(|(i, r)| !out.iter().enumerate().any(|(j, q)| j != i && area(q) > area(r) + 1e-9 && corners(r).iter().all(|p| inside(*p, q))))
        .collect();
    out.into_iter().zip(keep).filter(|(_, k)| *k).map(|(r, _)| r).collect()
}

// ── 4. Stösse ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct W {
    a: V,
    b: V,
    t: f64,
    /// Gedeckte Strecken auf der Achse (Weltpunkte).
    cover: Vec<(V, V)>,
    filled: bool,
    material: Option<&'static str>,
}

impl W {
    fn dir(&self) -> V {
        let d = sub(self.b, self.a);
        mul(d, 1.0 / len(d))
    }
    fn length(&self) -> f64 {
        len(sub(self.b, self.a))
    }
    fn band(&self) -> Band {
        let u = self.dir();
        Band { o: self.a, u, n: (-u.1, u.0), t: self.t }
    }
}

/// Schnitt der Achsen: (λ auf `w` ab `p` in Richtung `u`, μ auf `q` ab `q.a`).
fn intersect(p: V, u: V, q: &W) -> Option<(f64, f64)> {
    let uq = q.dir();
    let den = cross(u, uq);
    if !(den.abs() >= PAR_TOL.sin() * 10.0) {
        return None;
    }
    let d = sub(q.a, p);
    Some((cross(d, uq) / den, cross(d, u) / den))
}

fn join(cx: &Ctx2, ws: &mut [W]) {
    let n = ws.len();
    let mut target: Vec<[Option<V>; 2]> = vec![[None, None]; n];
    for i in 0..n {
        if !(ws[i].length() > 1e-6) {
            continue;
        }
        for e in 0..2 {
            let w = &ws[i];
            let u = w.dir();
            let (p, out) = if e == 0 { (w.a, mul(u, -1.0)) } else { (w.b, u) };
            let mut best: Option<(f64, V)> = None;
            for (j, q) in ws.iter().enumerate() {
                if j == i || !(q.length() > 1e-6) {
                    continue;
                }
                let Some((lam, mu)) = intersect(p, out, q) else { continue };
                // Am Kreuz- oder T-Stoss enden auch die anderen Wände an Flächen: Spiel bis halbe Höchstdicke.
                let ql = q.length();
                if mu < -(MAX_THICK / 2.0 + 0.05) || mu > ql + MAX_THICK / 2.0 + 0.05 {
                    continue;
                }
                let reach = q.t / 2.0 + 0.05;
                let ok = if lam.abs() <= reach {
                    true
                } else if lam > reach && lam <= q.t / 2.0 + GAP_MAX {
                    // Tür/Fenster in der Ecke: Lücke zwischen Wandende und Fläche der anderen Wand.
                    let b = w.band();
                    let (g0, g1) = if e == 0 { (-(lam - q.t / 2.0), 0.0) } else { (w.length(), w.length() + lam - q.t / 2.0) };
                    g1 - g0 >= MIN_OPENING && evidence(cx, &b, g0, g1)
                } else {
                    false
                };
                if ok && best.is_none_or(|(l, _)| lam.abs() < l) {
                    best = Some((lam.abs(), add(p, mul(out, lam))));
                }
            }
            target[i][e] = best.map(|b| b.1);
        }
    }
    for (w, t) in ws.iter_mut().zip(target) {
        if let Some(a) = t[0] {
            w.a = a;
        }
        if let Some(b) = t[1] {
            w.b = b;
        }
    }
}

/// Kreuzende/anstossende Wände decken ihr Band auf der Achse der anderen.
fn cross_cover(ws: &mut [W]) {
    let n = ws.len();
    let mut add_cov: Vec<Vec<(V, V)>> = vec![Vec::new(); n];
    for i in 0..n {
        for j in i + 1..n {
            let (wi, wj) = (&ws[i], &ws[j]);
            let ui = wi.dir();
            let Some((lam, mu)) = intersect(wi.a, ui, wj) else { continue };
            let tol = 1e-3;
            if lam < -tol - wj.t / 2.0 || lam > wi.length() + tol + wj.t / 2.0 || mu < -tol - wi.t / 2.0 || mu > wj.length() + tol + wi.t / 2.0 {
                continue;
            }
            let sin = cross(ui, wj.dir()).abs();
            let x = add(wi.a, mul(ui, lam));
            let hi = wj.t / 2.0 / sin;
            add_cov[i].push((add(x, mul(ui, -hi)), add(x, mul(ui, hi))));
            let uj = wj.dir();
            let hj = wi.t / 2.0 / sin;
            add_cov[j].push((add(x, mul(uj, -hj)), add(x, mul(uj, hj))));
        }
    }
    for (w, c) in ws.iter_mut().zip(add_cov) {
        w.cover.extend(c);
    }
}

// ── Bogenwände ───────────────────────────────────────────────────────────────

/// Konzentrische Bogenpaare → Bogenwände; gibt die verwendeten Bögen zurück.
/// Bogenwand: Achse als Kreisbogen gegen den Uhrzeigersinn.
#[derive(Clone, Debug)]
struct ArcW {
    c: V,
    r: f64,
    a0: f64,
    sweep: f64,
    t: f64,
    material: Option<&'static str>,
    filled: bool,
}

impl ArcW {
    fn at(&self, a: f64) -> V {
        add(self.c, (self.r * cos(a), self.r * sin(a)))
    }
    fn wall(&self) -> RWall {
        let snap = |p: V| ((p.0 * 1e6).round() / 1e6, (p.1 * 1e6).round() / 1e6);
        // Gegen den Uhrzeigersinn = negativer Modell-Bulge.
        RWall {
            a: snap(self.at(self.a0)),
            b: snap(self.at(self.a0 + self.sweep)),
            bulge: Some(-tan(self.sweep / 4.0)),
            t: (self.t * 1e6).round() / 1e6,
            material: self.material,
            filled: self.filled,
        }
    }
}

/// Gerade Wandenden auf die Achse einer Bogenwand ziehen (Ende im Band ± 5 cm, nahe einem Bogenende); das
/// Bogenende rückt auf denselben Punkt.
fn join_arcs(ws: &mut [W], arcs: &mut [ArcW]) {
    for w in ws.iter_mut() {
        if !(w.length() > 1e-6) {
            continue;
        }
        for e in 0..2 {
            let u = w.dir();
            let (p, out) = if e == 0 { (w.a, mul(u, -1.0)) } else { (w.b, u) };
            let mut best: Option<(f64, usize, f64, V)> = None;
            for (k, a) in arcs.iter().enumerate() {
                // Gerade p + λ·out mit dem Kreis |x − c| = r.
                let f = sub(p, a.c);
                let (bq, cq) = (dot(f, out), dot(f, f) - a.r * a.r);
                let disc = bq * bq - cq;
                if disc < 0.0 {
                    continue;
                }
                for lam in [-bq - disc.sqrt(), -bq + disc.sqrt()] {
                    if !(lam.abs() <= a.t / 2.0 + 0.05) {
                        continue;
                    }
                    let x = add(p, mul(out, lam));
                    let ang = wrap2pi(atan2(x.1 - a.c.1, x.0 - a.c.0));
                    // Winkel-Abstand zum nächsten Bogenende (als Bogenlänge).
                    let d0 = wrap2pi(a.a0 - ang).min(wrap2pi(ang - a.a0));
                    let e1 = a.a0 + a.sweep;
                    let d1 = wrap2pi(e1 - ang).min(wrap2pi(ang - e1));
                    if d0.min(d1) * a.r > w.t / 2.0 + 0.3 {
                        continue;
                    }
                    if best.is_none_or(|b| lam.abs() < b.0) {
                        best = Some((lam.abs(), k, ang, x));
                    }
                }
            }
            let Some((_, k, ang, x)) = best else { continue };
            if e == 0 {
                w.a = x;
            } else {
                w.b = x;
            }
            let a = &mut arcs[k];
            let e1 = a.a0 + a.sweep;
            let d0 = wrap2pi(a.a0 - ang).min(wrap2pi(ang - a.a0));
            let d1 = wrap2pi(e1 - ang).min(wrap2pi(ang - e1));
            if d0 <= d1 {
                // Anfang verschieben, Ende bleibt.
                let delta = wrap2pi(ang - a.a0 + PI) - PI;
                a.a0 = wrap2pi(ang);
                a.sweep -= delta;
            } else {
                let delta = wrap2pi(ang - e1 + PI) - PI;
                a.sweep += delta;
            }
        }
    }
}

/// Bogenstücke derselben Achse (Mittelpunkt ± 1 cm, Radius ± 5 mm, gleiche Dicke) mit Lücke bis 1.5 m (bis
/// 4 m mit Fensterbogen darin) werden eine Bogenwand; die Lücken Öffnungen (Lage und Breite als Bogenlänge auf
/// der Achse): konzentrische Bögen im Band → Fenster, sonst Wanddurchbruch. Rückgabe: Wände und Öffnungen
/// (Index der Wand, Lage, Breite, Art).
#[allow(clippy::type_complexity)]
fn merge_arc_walls(inp: &Input, arcs: Vec<ArcW>, used: &[bool]) -> (Vec<ArcW>, Vec<(usize, f64, f64, RKind)>) {
    let mut groups: Vec<Vec<ArcW>> = Vec::new();
    for a in arcs {
        match groups.iter_mut().find(|g| len(sub(g[0].c, a.c)) <= 0.01 && (g[0].r - a.r).abs() <= 0.005 && (g[0].t - a.t).abs() <= 0.006) {
            Some(g) => g.push(a),
            None => groups.push(vec![a]),
        }
    }
    // Fensterbogen in der Lücke [g0, g1] (Winkel, gegen den Uhrzeigersinn) der Achse `w`?
    let window_in = |w: &ArcW, g0: f64, g1: f64| {
        inp.arcs.iter().enumerate().any(|(k, a)| {
            if used.get(k).copied().unwrap_or(false) || len(sub(a.c, w.c)) > 0.01 || (a.r - w.r).abs() >= w.t / 2.0 - 0.005 {
                return false;
            }
            let gap = g1 - g0;
            let off = wrap2pi(a.a0 - g0);
            let ov = [off, off - 2.0 * PI].iter().map(|o| (o + a.sweep).min(gap) - o.max(0.0)).fold(0.0, f64::max);
            ov >= 0.5 * gap
        })
    };
    let mut walls = Vec::new();
    let mut openings = Vec::new();
    for mut g in groups {
        g.sort_by(|a, b| a.a0.total_cmp(&b.a0));
        // Beim grössten Zwischenraum beginnen (Kreis).
        let n = g.len();
        let gap_after = |i: usize| wrap2pi(g[(i + 1) % n].a0 - (g[i].a0 + g[i].sweep));
        let start = if n > 1 { (0..n).max_by(|&i, &j| gap_after(i).total_cmp(&gap_after(j))).map_or(0, |i| (i + 1) % n) } else { 0 };
        g.rotate_left(start);
        let mut cur = g[0].clone();
        let mut gaps: Vec<(f64, f64)> = Vec::new();
        let flush = |cur: &ArcW, gaps: &mut Vec<(f64, f64)>, walls: &mut Vec<ArcW>, openings: &mut Vec<(usize, f64, f64, RKind)>| {
            let k = walls.len();
            for (g0, g1) in gaps.drain(..) {
                let kind = if window_in(cur, g0, g1) { RKind::Window } else { RKind::Void };
                let r6 = |x: f64| (x * 1e6).round() / 1e6;
                openings.push((k, r6((g0 - cur.a0) * cur.r), r6((g1 - g0) * cur.r), kind));
            }
            walls.push(cur.clone());
        };
        for a in g.into_iter().skip(1) {
            let end = cur.a0 + cur.sweep;
            let gap = wrap2pi(a.a0 - end);
            let total = cur.sweep + gap + a.sweep;
            let len_gap = gap * cur.r;
            let merge = total < 2.0 * PI - 1e-6 && (len_gap <= GAP_FREE || (len_gap <= GAP_MAX && window_in(&cur, end, end + gap)));
            if merge {
                if len_gap >= MIN_OPENING {
                    gaps.push((end, end + gap));
                }
                cur.sweep = total;
                cur.filled |= a.filled;
                cur.material = cur.material.or(a.material);
            } else {
                flush(&cur, &mut gaps, &mut walls, &mut openings);
                cur = a;
            }
        }
        flush(&cur, &mut gaps, &mut walls, &mut openings);
    }
    (walls, openings)
}

fn arc_walls(inp: &Input, use_arc: &[bool], out: &mut Vec<ArcW>) -> Vec<bool> {
    let arcs = &inp.arcs;
    let mut used = vec![false; arcs.len()];
    if arcs.len() > MAX_ARCS {
        return used;
    }
    let mut cands = Vec::new();
    for i in 0..arcs.len() {
        for j in 0..arcs.len() {
            let (a, b) = (&arcs[i], &arcs[j]);
            if !use_arc[i] || !use_arc[j] || b.r <= a.r || len(sub(a.c, b.c)) > 0.01 {
                continue;
            }
            let d = b.r - a.r;
            if !(MIN_THICK - 1e-3..=MAX_THICK + 1e-3).contains(&d) {
                continue;
            }
            // Gemeinsamer Winkelbereich (Kreisintervalle).
            let shift = wrap2pi(b.a0 - a.a0);
            let mut best = (0.0, 0.0);
            for off in [shift, shift - 2.0 * PI] {
                let (s0, s1) = (off.max(0.0), (off + b.sweep).min(a.sweep));
                if s1 - s0 > best.1 - best.0 {
                    best = (s0, s1);
                }
            }
            let ov = best.1 - best.0;
            let rm = (a.r + b.r) / 2.0;
            if ov * rm < MIN_PIECE || ov < 0.5 * a.sweep.min(b.sweep) - 1e-9 {
                continue;
            }
            cands.push((d, i, j, a.a0 + best.0, ov));
        }
    }
    cands.sort_by(|x, y| x.0.total_cmp(&y.0));
    for (d, i, j, a0, sweep) in cands {
        if used[i] || used[j] {
            continue;
        }
        used[i] = true;
        used[j] = true;
        let (c, r) = (arcs[i].c, arcs[i].r + d / 2.0);
        // Vollkreis: zwei Halbbögen (Anfang ≠ Ende).
        let parts = if sweep > 2.0 * PI - 1e-3 { vec![(a0, PI), (a0 + PI, PI)] } else { vec![(a0, sweep)] };
        for (s, sw) in parts {
            let material = material_of(&inp.layers[arcs[i].layer]).or_else(|| material_of(&inp.layers[arcs[j].layer]));
            let mid = s + sw / 2.0;
            let filled = fill_at(inp, add(c, (r * cos(mid), r * sin(mid)))).is_some();
            out.push(ArcW { c, r, a0: wrap2pi(s), sweep: sw, t: d, material, filled });
        }
    }
    used
}

// ── Räume ────────────────────────────────────────────────────────────────────

const SIA: [&str; 6] = ["HNF", "NNF", "VF", "FF", "KGF", "AGF"];

/// Flächenangabe („17.01 m²“, „17,0 m2“, „17 qm“).
pub fn parse_area(text: &str) -> Option<f64> {
    let t = text.trim();
    let l = t.to_lowercase();
    let k = ["m²", "m2", "qm"].iter().filter_map(|u| l.find(u)).min()?;
    let num: String = l[..k].trim().chars().rev().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',' || *c == '\'').collect::<Vec<_>>().into_iter().rev().collect();
    let v: f64 = num.replace('\'', "").replace(',', ".").parse().ok()?;
    (v > 0.0 && v.is_finite()).then_some(v)
}

fn sia_of(text: &str) -> Option<&'static str> {
    let first = text.split(|c: char| !c.is_alphanumeric()).find(|w| !w.is_empty())?;
    SIA.iter().find(|s| **s == first).copied()
}

/// Text als Raumname brauchbar (Buchstaben, keine Fläche, keine SIA-Angabe)?
fn name_like(text: &str) -> bool {
    parse_area(text).is_none() && sia_of(text).is_none() && text.chars().any(char::is_alphabetic)
}

fn text_points(t: &TextIn) -> [V; 2] {
    let w = 0.3 * t.h * t.text.chars().count() as f64;
    let (c, s) = (cos(t.angle), sin(t.angle));
    [t.at, add(t.at, (c * w - s * t.h / 2.0, s * w + c * t.h / 2.0))]
}

fn rooms(inp: &Input, walls: &[RWall], rec: &mut Recognition) {
    let mut segs = Vec::new();
    for w in walls {
        let pts = crate::wall_arc::axis_polyline(w.a, w.b, w.bulge, 0.0, w.t);
        for q in pts.windows(2) {
            segs.push(kernel2d::WallSegment { a: kernel2d::Vec2::new(q[0].0, q[0].1), b: kernel2d::Vec2::new(q[1].0, q[1].1), thickness: w.t });
        }
    }
    // Zellen der Achsen, dann die Wandbänder abziehen: lichter Umriss an den echten Wandflächen (der
    // Innen-Versatz von `detect_rooms` nähme die mittlere Dicke aller Wände).
    let found = kernel2d::detect_rooms(&segs, 0.05, 0.5, false);
    let bands: Vec<(Vec<[f64; 2]>, [f64; 4])> = walls
        .iter()
        .filter_map(|w| {
            let band = match crate::wall_arc::band_preview(w.a, w.b, w.bulge, w.t) {
                Some((b, _)) => b,
                None => {
                    let d = sub(w.b, w.a);
                    let l = len(d);
                    if !(l > 1e-9) {
                        return None;
                    }
                    let n = mul((-d.1 / l, d.0 / l), w.t / 2.0);
                    vec![add(w.a, n), add(w.b, n), sub(w.b, n), sub(w.a, n)]
                }
            };
            let bb = band.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, p| [b[0].min(p.0), b[1].min(p.1), b[2].max(p.0), b[3].max(p.1)]);
            Some((band.iter().map(|p| [p.0, p.1]).collect(), bb))
        })
        .collect();
    let mut used_text = vec![false; inp.texts.len()];
    for cell in found {
        let cell: Vec<[f64; 2]> = cell.iter().map(|p| [p.x, p.y]).collect();
        let bb = cell.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, p| [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]);
        let cut: Vec<Vec<Vec<[f64; 2]>>> = bands.iter().filter(|(_, b)| b[0] <= bb[2] && b[2] >= bb[0] && b[1] <= bb[3] && b[3] >= bb[1]).map(|(r, _)| vec![r.clone()]).collect();
        let rest = crate::polygon_bool::difference(&[vec![cell]], &cut);
        let Some(best) = rest.iter().filter_map(|p| p.first()).max_by(|a, b| {
            let ar = |r: &Vec<[f64; 2]>| polygon_area(&r.iter().map(|q| (q[0], q[1])).collect::<Vec<_>>()).abs();
            ar(a).total_cmp(&ar(b))
        }) else {
            continue;
        };
        let ring: Vec<V> = best.iter().map(|q| ((q[0] * 1e6).round() / 1e6, (q[1] * 1e6).round() / 1e6)).collect();
        if ring.len() < 3 || polygon_area(&ring).abs() < 0.5 {
            continue;
        }
        let inside: Vec<usize> = (0..inp.texts.len()).filter(|&k| text_points(&inp.texts[k]).iter().any(|p| point_in(&ring, *p))).collect();
        let mut name: Option<&TextIn> = None;
        let mut sia = None;
        let mut area_text = None;
        for &k in &inside {
            let t = &inp.texts[k];
            used_text[k] = true;
            if let Some(a) = parse_area(&t.text) {
                area_text = area_text.or(Some((a, t.at)));
            } else if let Some(s) = sia_of(&t.text) {
                sia = sia.or(Some(s));
            } else if name_like(&t.text) && name.is_none_or(|n| t.h > n.h + 1e-9) {
                name = Some(t);
            }
        }
        // Raumnummer allein („1.07“) als Name.
        let name = name.map(|t| t.text.trim().to_string()).or_else(|| {
            inside.iter().map(|&k| inp.texts[k].text.trim()).find(|t| parse_area(t).is_none() && sia_of(t).is_none() && t.chars().any(|c| c.is_ascii_digit())).map(str::to_string)
        });
        if let Some((a, at)) = area_text {
            let real = polygon_area(&ring).abs();
            if (real - a).abs() > 0.05 * a {
                rec.flag("areaMismatch", at);
            }
        }
        rec.rooms.push(RRoom { ring, name, sia, area_text: area_text.map(|a| a.0) });
    }
    for (k, t) in inp.texts.iter().enumerate() {
        if !used_text[k] && parse_area(&t.text).is_some() {
            rec.flag("areaOutside", t.at);
        }
    }
}

// ── Gesamtablauf ─────────────────────────────────────────────────────────────

pub fn analyze(inp: &Input) -> Recognition {
    let mut rec = Recognition::default();
    if inp.segs.len() > MAX_SEGS {
        rec.flag("tooMany", inp.segs.first().map_or((0.0, 0.0), |s| s.a));
        return rec;
    }
    let wallish: Vec<bool> = inp.layers.iter().map(|l| wallish_layer(l)).collect();
    let n_wallish = inp.segs.iter().filter(|s| wallish[s.layer]).count() + inp.arcs.iter().filter(|a| wallish[a.layer]).count();
    rec.layer_filter = n_wallish >= 4;
    let use_layer = |l: usize| !rec.layer_filter || wallish[l];

    // Bogenwände zuerst (ihre Bögen sind keine Türbögen).
    let use_arc: Vec<bool> = inp.arcs.iter().map(|a| use_layer(a.layer)).collect();
    let mut arc_ws = Vec::new();
    let arc_used = arc_walls(inp, &use_arc, &mut arc_ws);

    let pair_segs: Vec<Seg> = inp.segs.iter().filter(|s| use_layer(s.layer)).cloned().collect();
    let ends: Vec<(V, V)> = pair_segs.iter().map(|s| (s.a, s.b)).collect();
    let (frames, cl_of) = bundle(&ends);
    let lines = lines_of(&pair_segs, &wallish, &frames, &cl_of);
    let door_arcs: Vec<usize> = (0..inp.arcs.len()).filter(|&k| !arc_used[k] && door_like(&inp.arcs[k])).collect();
    let cx = Ctx2 { inp, frames, lines, all: inp.segs.iter().map(|s| (s.a, s.b)).collect(), door_arcs };

    let ps = pieces(&cx);
    // Unpaarige Wandlinien (nur mit Wand-Layern aussagekräftig).
    if rec.layer_filter {
        let mut paired = vec![false; cx.lines.len()];
        for p in &ps {
            paired[p.lo] = true;
            paired[p.hi] = true;
        }
        for (i, l) in cx.lines.iter().enumerate() {
            if !paired[i] && l.t1 - l.t0 >= 0.5 && l.wallish {
                rec.flag("lineUnpaired", cx.frames[l.cl].at(l.c, (l.t0 + l.t1) / 2.0));
            }
        }
    }
    let rs = runs(&cx, ps);
    let mut ws: Vec<W> = rs
        .iter()
        .map(|r| {
            let f = cx.frames[r.cl];
            W {
                a: f.at(r.c, r.s0),
                b: f.at(r.c, r.s1),
                t: r.t,
                cover: r.cover.iter().map(|&(s0, s1)| (f.at(r.c, s0), f.at(r.c, s1))).collect(),
                filled: r.filled,
                material: r.material,
            }
        })
        .collect();
    // Zweimal: ein in der Ecke verlängertes Ende (Tür) erreicht erst danach die Achse der anderen Wand.
    join(&cx, &mut ws);
    join(&cx, &mut ws);
    join_arcs(&mut ws, &mut arc_ws);
    let snap = |p: V| ((p.0 * 1e6).round() / 1e6, (p.1 * 1e6).round() / 1e6);
    for w in ws.iter_mut() {
        w.a = snap(w.a);
        w.b = snap(w.b);
        w.t = (w.t * 1e6).round() / 1e6;
    }
    ws.retain(|w| w.length() >= 0.1);
    // Umlauf um den Schwerpunkt: rechts (erste Schicht) = aussen.
    let (mut sx, mut sy, mut sl) = (0.0, 0.0, 0.0);
    for w in &ws {
        let m = mul(add(w.a, w.b), 0.5);
        let l = w.length();
        sx += m.0 * l;
        sy += m.1 * l;
        sl += l;
    }
    if sl > 0.0 {
        let g = (sx / sl, sy / sl);
        for w in ws.iter_mut() {
            let u = w.dir();
            let right = (u.1, -u.0);
            if dot(sub(mul(add(w.a, w.b), 0.5), g), right) < -1e-9 {
                std::mem::swap(&mut w.a, &mut w.b);
            }
        }
    }
    cross_cover(&mut ws);

    // Öffnungen.
    let mut arc_taken = vec![false; inp.arcs.len()];
    for (wi, w) in ws.iter().enumerate() {
        let b = w.band();
        let l = w.length();
        let cov = union(
            w.cover
                .iter()
                .map(|(p, q)| {
                    let (s0, s1) = (b.st(*p).0, b.st(*q).0);
                    (s0.min(s1).max(0.0), s0.max(s1).min(l))
                })
                .collect(),
        );
        for (g0, g1) in subtract(0.0, l, &cov) {
            let wdt = g1 - g0;
            if wdt < MIN_OPENING {
                continue;
            }
            let mid = add(b.o, mul(b.u, (g0 + g1) / 2.0));
            let arcs: Vec<(usize, bool, bool)> = door_arcs_at(&cx, &b, g0, g1).into_iter().filter(|a| !arc_taken[a.0]).collect();
            let kind = if let Some(&(k, at_start, _)) = arcs.iter().find(|a| a.2) {
                arc_taken[k] = true;
                let (_, nm) = b.st(arc_mid(&inp.arcs[k]));
                RKind::Door { hinge_end: !at_start, swing_right: nm < 0.0, leaves: 1 }
            } else if !arcs.is_empty() {
                // Zwei halbe Bögen: zweiflüglig (Anschlag am ersten Bogen).
                let (k, at_start, _) = arcs[0];
                for a in &arcs {
                    arc_taken[a.0] = true;
                }
                let (_, nm) = b.st(arc_mid(&inp.arcs[k]));
                let leaves = if arcs.iter().any(|a| a.1) && arcs.iter().any(|a| !a.1) { 2 } else { 1 };
                if leaves == 1 {
                    rec.flag("doorHalf", mid);
                }
                RKind::Door { hinge_end: !at_start, swing_right: nm < 0.0, leaves }
            } else if window_lines_at(&cx, &b, g0, g1) > 0 {
                RKind::Window
            } else if wdt > GAP_FREE + 1e-6 {
                rec.flag("gapWide", mid);
                continue;
            } else {
                RKind::Void
            };
            let r6 = |x: f64| (x * 1e6).round() / 1e6;
            rec.openings.push(ROpening { wall: wi, pos: r6(g0), width: r6(wdt), kind });
        }
    }
    for &k in &cx.door_arcs {
        if !arc_taken[k] {
            rec.flag("doorArc", inp.arcs[k].c);
        }
    }

    rec.walls = ws.iter().map(|w| RWall { a: w.a, b: w.b, bulge: None, t: w.t, material: w.material, filled: w.filled }).collect();
    arc_ws.retain(|a| a.sweep > 1e-6 && a.sweep * a.r >= 0.1);
    let (arc_ws, arc_openings) = merge_arc_walls(inp, arc_ws, &arc_used);
    let base = rec.walls.len();
    rec.walls.extend(arc_ws.iter().map(ArcW::wall));
    rec.openings.extend(arc_openings.into_iter().map(|(k, pos, width, kind)| ROpening { wall: base + k, pos, width, kind }));
    let walls = rec.walls.clone();
    rooms(inp, &walls, &mut rec);
    rec
}

// ── Anfrage → Ergebnis ───────────────────────────────────────────────────────

/// Quell-Ebene (`src`, sonst aktive Ebene) und Auswahl (`ids`) der Anfrage.
fn input_of(p: &Project, v: &Value, level: &str) -> Input {
    let src = v.get("src").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(level);
    let ids: Vec<String> = v.get("ids").and_then(|x| serde_json::from_value(x.clone()).ok()).unwrap_or_default();
    collect(p, src, &ids)
}

pub fn recognize(p: &Project, v: &Value, level: &str) -> Recognition {
    analyze(&input_of(p, v, level))
}

/// Gesamtdicke eines Wandtyps.
fn type_thickness(t: &crate::model::WallType) -> f64 {
    t.layers.iter().fold(0.0, |s, l| s + l.thickness)
}

/// Wandtyp für Dicke + Material: vorhanden (±5 mm, gleiches Material bevorzugt) oder neu.
fn wall_type_for(p: &Project, v: &Value, ctx: &Ctx, t: f64, material: Option<&'static str>, made: &mut Vec<(f64, Option<&'static str>, String, Value)>, ids: &mut IdGen) -> String {
    let comp_matches = |cid: &str| -> bool {
        material.is_some_and(|m| {
            p.components.iter().any(|c| c.id == cid && (material_of(&c.id) == Some(m) || material_of(&c.name) == Some(m)))
        })
    };
    let mut best: Option<(bool, f64, &str)> = None;
    for wt in &p.wall_types {
        let d = (type_thickness(wt) - t).abs();
        if d > 0.005 {
            continue;
        }
        let m = wt.layers.iter().any(|l| comp_matches(&l.component_id));
        if best.is_none_or(|(bm, bd, _)| (m && !bm) || (m == bm && d < bd)) {
            best = Some((m, d, &wt.id));
        }
    }
    if let Some((_, _, id)) = best {
        return id.to_string();
    }
    if let Some(m) = made.iter().find(|m| (m.0 - t).abs() <= 0.005 && m.1 == material) {
        return m.2.clone();
    }
    // Neu: einschichtig, Baustoff nach Hinweis, sonst ein tragender Baustoff des Projekts (Mauerwerk,
    // Kalksandstein, Beton), sonst die dickste Schicht des aktiven Wandtyps, sonst der erste Baustoff.
    let group_of = |c: &crate::model::Component| material_of(&c.id).or_else(|| material_of(&c.name));
    let comp = material
        .and_then(|m| p.components.iter().find(|c| group_of(c) == Some(m)))
        .or_else(|| ["mauerwerk", "kalksandstein", "beton"].iter().find_map(|m| p.components.iter().find(|c| group_of(c) == Some(*m))))
        .map(|c| c.id.clone())
        .or_else(|| {
            p.wall_types.iter().find(|w| w.id == ctx.wall_type).and_then(|w| w.layers.iter().max_by(|a, b| a.thickness.total_cmp(&b.thickness))).map(|l| l.component_id.clone())
        })
        .or_else(|| p.components.first().map(|c| c.id.clone()))
        .unwrap_or_default();
    let id = ids.next("WT");
    let cm = crate::js_fmt::to_fixed(t * 100.0, 1);
    let cm = cm.strip_suffix(".0").unwrap_or(&cm).to_string();
    let tmpl = v.get("typeName").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("Wand {cm} cm");
    let wt = json!({"id": id, "name": tmpl.replace("{cm}", &cm), "layers": [{"componentId": comp, "thickness": js_num((t * 1000.0).round() / 1000.0)}]});
    made.push((t, material, id.clone(), wt));
    id
}

fn door_type(p: &Project, leaves: u8) -> Option<String> {
    let list = p.door_types.as_ref()?;
    list.iter()
        .find(|d| matches!(d.kind, crate::model::DoorTypeKind::Dreh) && (d.leaf_count - leaves as f64).abs() < 0.5)
        .or_else(|| list.iter().find(|d| matches!(d.kind, crate::model::DoorTypeKind::Dreh)))
        .map(|d| d.id.clone())
}

fn cat(p: &Project, code: &str, ctx: &Ctx) -> String {
    if has_category(p, code) { code.to_string() } else { ctx.cat.to_string() }
}

/// Ops: neue Wandtypen, Wände, Öffnungen, Räume (ein Undo-Schritt).
pub fn ops(p: &Project, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let rec = recognize(p, v, ctx.level);
    if rec.walls.is_empty() {
        return Vec::new();
    }
    let height = ctx.floor_height.unwrap_or(2.6);
    let (wcat, ocat, rcat) = (cat(p, "20", ctx), cat(p, "21", ctx), cat(p, "60", ctx));
    let mut made = Vec::new();
    let mut walls = Vec::new();
    let mut wall_ids = Vec::new();
    for w in &rec.walls {
        let type_id = wall_type_for(p, v, ctx, w.t, w.material, &mut made, ids);
        let id = ids.next("W");
        let mut f = vec![("id", s(&id)), ("type", s("wall")), ("floorId", s(ctx.level)), ("categoryCode", s(&wcat)), ("start", pv(w.a)), ("end", pv(w.b))];
        if let Some(b) = w.bulge {
            f.push(("bulge", js_num(b)));
        }
        f.push(("wallTypeId", s(&type_id)));
        f.push(("height", js_num(height)));
        walls.push(obj(f));
        wall_ids.push(id);
    }
    let door_h = 2.1f64.min(height - 0.1).max(0.5);
    let sill = 0.9f64.min((height - 0.6).max(0.0));
    let win_h = 1.2f64.min(height - sill - 0.1).max(0.3);
    let window_type = p.window_types.as_ref().and_then(|l| l.first()).map(|w| w.id.clone());
    let mut openings = Vec::new();
    for o in &rec.openings {
        let mut f = vec![("id", s(&ids.next("O"))), ("type", s("opening")), ("hostWallId", s(&wall_ids[o.wall])), ("categoryCode", s(&ocat))];
        match o.kind {
            RKind::Door { hinge_end, swing_right, leaves } => {
                f.push(("kind", s("door")));
                if let Some(t) = door_type(p, leaves) {
                    f.push(("typeId", s(&t)));
                }
                f.extend([("position", js_num(o.pos)), ("width", js_num(o.width)), ("height", js_num(door_h)), ("sillHeight", js_num(0.0))]);
                f.push(("swing", s(if swing_right { "right" } else { "left" })));
                f.push(("hinge", s(if hinge_end { "end" } else { "start" })));
            }
            RKind::Window => {
                f.push(("kind", s("window")));
                if let Some(t) = &window_type {
                    f.push(("typeId", s(t)));
                }
                f.extend([("position", js_num(o.pos)), ("width", js_num(o.width)), ("height", js_num(win_h)), ("sillHeight", js_num(sill))]);
            }
            RKind::Void => {
                f.push(("kind", s("door")));
                f.extend([("position", js_num(o.pos)), ("width", js_num(o.width)), ("height", js_num(door_h)), ("sillHeight", js_num(0.0))]);
                f.push(("doorType", s("wandoeffnung")));
            }
        }
        openings.push(obj(f));
    }
    let tmpl = v.get("roomName").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("Raum {n}");
    let mut k = p.rooms.as_ref().map_or(0, Vec::len);
    let mut rooms = Vec::new();
    for r in &rec.rooms {
        k += 1;
        let name = r.name.clone().unwrap_or_else(|| tmpl.replace("{n}", &k.to_string()));
        let doc = json!({ "version": 1, "paragraphs": [{ "runs": [{ "text": name, "marks": {} }], "align": "center" }] });
        rooms.push(obj(vec![
            ("id", s(&ids.next("RM"))),
            ("type", s("room")),
            ("floorId", s(ctx.level)),
            ("categoryCode", s(&rcat)),
            ("siaCategory", s(r.sia.unwrap_or("HNF"))),
            ("name", s(&name)),
            ("boundary", pvs(&r.ring)),
            ("color", category_color(p, &rcat, "#4a4a4a")),
            ("stampDoc", doc),
        ]));
    }
    let mut out = Vec::new();
    if !made.is_empty() {
        out.extend(add_op("wallTypes", made.into_iter().map(|m| m.3).collect()));
    }
    out.extend(add_op("walls", walls));
    if !openings.is_empty() {
        out.extend(add_op("openings", openings));
    }
    if !rooms.is_empty() {
        out.extend(add_op("rooms", rooms));
    }
    out
}

/// Zähler `[Wände, Türen, Fenster, Durchbrüche, Räume, unklar]`.
pub fn counts(r: &Recognition) -> [usize; 6] {
    [
        r.walls.len(),
        r.count(|k| matches!(k, RKind::Door { .. })),
        r.count(|k| matches!(k, RKind::Window)),
        r.count(|k| matches!(k, RKind::Void)),
        r.rooms.len(),
        r.unclear.len(),
    ]
}

/// Vorschau: Wandbänder, Öffnungen (Tür: Bogen + Blatt, Fenster: zwei Linien, Durchbruch: Kreuz), Räume,
/// unklare Stellen (kleines Kreuz). `info` = [`counts`]. `false` = nichts erkannt.
pub fn preview(p: &Project, v: &Value, ctx: &Ctx, out: &mut Shapes, info: &mut Vec<f64>) -> bool {
    let r = recognize(p, v, ctx.level);
    for w in &r.walls {
        if let Some((band, axis)) = crate::wall_arc::band_preview(w.a, w.b, w.bulge, w.t) {
            out.poly(&band);
            out.poly_open(&axis);
            continue;
        }
        let d = sub(w.b, w.a);
        let u = mul(d, 1.0 / len(d));
        let n = mul((-u.1, u.0), w.t / 2.0);
        out.poly(&[add(w.a, n), add(w.b, n), sub(w.b, n), sub(w.a, n)]);
    }
    for o in &r.openings {
        let w = &r.walls[o.wall];
        let d = sub(w.b, w.a);
        let u = mul(d, 1.0 / len(d));
        let n = (-u.1, u.0);
        let at = |s: f64, k: f64| add(add(w.a, mul(u, s)), mul(n, k));
        let (s0, s1, h) = (o.pos, o.pos + o.width, w.t / 2.0);
        match o.kind {
            RKind::Door { hinge_end, swing_right, leaves } => {
                let side = if swing_right { -1.0 } else { 1.0 };
                // Bogen von der Schliess- (auf der Achse) in die Offenstellung (quer, Aufschlagseite).
                let leaf = |hinge: f64, toward: f64, r: f64, out: &mut Shapes| {
                    let pts: Vec<V> = (0..=12)
                        .map(|i| {
                            let a = (i as f64 / 12.0) * PI / 2.0;
                            at(hinge + toward * r * cos(a), side * r * sin(a))
                        })
                        .collect();
                    out.poly_open(&pts);
                    out.line(at(hinge, 0.0), at(hinge, side * r));
                };
                if leaves >= 2 {
                    leaf(s0, 1.0, o.width / 2.0, out);
                    leaf(s1, -1.0, o.width / 2.0, out);
                } else if hinge_end {
                    leaf(s1, -1.0, o.width, out);
                } else {
                    leaf(s0, 1.0, o.width, out);
                }
            }
            RKind::Window => {
                out.line(at(s0, h / 3.0), at(s1, h / 3.0));
                out.line(at(s0, -h / 3.0), at(s1, -h / 3.0));
            }
            RKind::Void => {
                out.line(at(s0, h), at(s1, -h));
                out.line(at(s0, -h), at(s1, h));
            }
        }
    }
    for room in &r.rooms {
        out.poly(&room.ring);
    }
    for u in &r.unclear {
        let k = 0.15;
        out.line((u.at.0 - k, u.at.1 - k), (u.at.0 + k, u.at.1 + k));
        out.line((u.at.0 - k, u.at.1 + k), (u.at.0 + k, u.at.1 - k));
    }
    info.extend(counts(&r).iter().map(|&c| c as f64));
    !r.walls.is_empty()
}

/// Bericht (Abfrage `recognize`): Zähler, Layer-Filter, unklare Stellen mit Grund (i18n-Schlüssel der Hülle).
pub fn report(p: &Project, v: &Value) -> Value {
    let level = s_of(v, "level");
    let r = recognize(p, v, level);
    let c = counts(&r);
    let filled = r.walls.iter().filter(|w| w.filled).count();
    let arcs = r.walls.iter().filter(|w| w.bulge.is_some()).count();
    let unnamed = r.rooms.iter().filter(|x| x.name.is_none()).count();
    let mut thick: Vec<f64> = r.walls.iter().map(|w| (w.t * 1000.0).round() / 1000.0).collect();
    thick.sort_by(f64::total_cmp);
    thick.dedup();
    json!({
        "walls": c[0], "doors": c[1], "windows": c[2], "voids": c[3], "rooms": c[4],
        "arcWalls": arcs, "filledWalls": filled, "unnamedRooms": unnamed,
        "thicknesses": thick.iter().map(|t| js_num(*t)).collect::<Vec<_>>(),
        "layerFilter": r.layer_filter,
        "unclear": r.unclear.iter().map(|u| json!({"code": u.code, "x": js_num(u.at.0), "y": js_num(u.at.1)})).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
#[path = "drawing_recognize_tests.rs"]
mod tests;
