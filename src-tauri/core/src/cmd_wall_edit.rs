//! Editier-Befehle für Wände, gerade und gebogen ([113], Anschluss an `cmd_edit.rs`): dieselben Befehle
//! wie für 2D-Zeichnungen — Trim, Extend, Bruch/Teilen (am Punkt, an den Schnittpunkten), Verketten
//! (kollinear bzw. auf demselben Kreis), Verrunden zweier Wände (L-Ecke am Achsschnittpunkt, mit Radius
//! eine Bogenwand dazwischen) und Offset (parallele Kopie).
//!
//! Gerechnet wird auf der Achse in ihrem Parameter `s` (Meter entlang der Achse, bei Bogenwänden
//! Bogenlänge; [`Axis::local`] liefert `s` auch über die Enden hinaus). Jede Änderung beschreibt sich als
//! Teilstücke `[s0, s1]` der alten Achse ([`Plan`]); daraus folgen:
//! - **Wände**: das erste Stück behält id und Attribute, weitere Stücke sind Kopien mit neuer id.
//! - **Öffnungen** (`position` = Abstand auf der Achse): das Stück, in dem ihre Mitte liegt, wird Wirt,
//!   die Lage wird auf das Stück umgerechnet (und in das Stück geklemmt); liegt die Mitte in keinem
//!   Stück (weggeschnitten) oder passt die Öffnung nicht mehr, entfällt sie.
//! - **Bemassung** ([38]): Bezüge auf die Wand werden auf das passende Stück umgeschrieben (Anteil `t`
//!   neu); Wandende-Bezüge folgen bei Trim/Extend/Verrunden dem verschobenen Ende. Ein Punkt im
//!   weggeschnittenen Teil verliert seinen Anteil und gilt als `lost` (Marke, Objekt-Info). Die Lage
//!   schreibt danach das Nachführen (`dim_assoc::sync_ops`) in derselben Undo-Stufe.
//! - **Anschlüsse** (`joins.rs`) rechnet der Kern geometrisch aus den Endpunkten: Trim/Extend auf eine
//!   Wandachse ergeben T-Stösse, Verrunden L-Ecken bzw. tangentiale Übergänge.
//!
//! Grenzen (Schneider) sind die Achsen (Option „Fläche": die beiden Aussenflächen) der übrigen Wände des
//! Geschosses, 2D-Linien/-Polylinien (mit Bögen)/-Rechtecke/-Kreise/-Bögen und Achsraster der Ebene.

use crate::cmd_transform::{IdGen, Shapes};
use crate::grips::{arr, field, js_num, num_of, pt, truthy, with, with_all, xy};
use crate::joins::Line;
use crate::model::{DimFeature, DimRef};
use crate::ops::{id_of, Op};
use crate::wall_arc::{circle_circle, circle_line, WallArc};
use kernel2d::Vec2 as P;
use serde_json::{Map, Value};
use std::f64::consts::TAU;

/// Kleinste Wandlänge (Meter), kürzere Stücke entstehen nicht.
pub const MIN_LEN: f64 = 1e-3;
/// Parameter-Toleranz (Meter).
const EPS_S: f64 = 1e-6;
/// Kollinear/konzentrisch (Meter).
const EPS_GEO: f64 = 1e-5;
/// Pick-Toleranz neben dem Wandkörper (Meter, wie `cmd_edit::HIT_TOL`).
const HIT_TOL: f64 = 0.25;

fn p_of(v: Option<&Value>) -> P {
    let (x, y) = xy(v.unwrap_or(&Value::Null));
    P::new(x, y)
}
fn ptv(p: P) -> Value {
    pt(p.x, p.y)
}
fn fin(p: P) -> bool {
    p.x.is_finite() && p.y.is_finite()
}
fn dist(a: P, b: P) -> f64 {
    (b.x - a.x).hypot(b.y - a.y)
}
fn cross(a: P, b: P) -> f64 {
    a.x * b.y - a.y * b.x
}
fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    field(v, k).and_then(Value::as_str)
}

pub fn walls(root: &Map<String, Value>) -> &[Value] {
    arr(root.get("walls"))
}

pub fn find_wall<'a>(root: &'a Map<String, Value>, id: &str) -> Option<&'a Value> {
    walls(root).iter().find(|w| id_of(w) == Some(id))
}

fn editable(w: &Value) -> bool {
    !truthy(field(w, "locked"))
}

// ── Achse ───────────────────────────────────────────────────────────────────

/// Wandachse (gerade oder Kreisbogen) mit Parameter `s` (Meter ab Start).
#[derive(Clone, Debug)]
pub struct Axis {
    pub a: P,
    pub b: P,
    pub arc: Option<WallArc>,
    pub len: f64,
    u: P,
    /// Vorzeichen des Modell-Bulge (Bogenwand).
    sign: f64,
}

impl Axis {
    pub fn new(a: P, b: P, bulge: Option<f64>) -> Option<Axis> {
        if !fin(a) || !fin(b) {
            return None;
        }
        let arc = WallArc::of(a, b, bulge);
        let l = dist(a, b);
        if l < 1e-9 {
            return None;
        }
        let u = P::new((b.x - a.x) / l, (b.y - a.y) / l);
        let len = arc.map_or(l, |w| w.length());
        Some(Axis { a, b, arc, len, u, sign: bulge.unwrap_or(0.0).signum() })
    }

    pub fn of(w: &Value) -> Option<Axis> {
        Axis::new(p_of(field(w, "start")), p_of(field(w, "end")), field(w, "bulge").and_then(Value::as_f64))
    }

    /// Weltpunkt bei (s, n), `n` links der Laufrichtung.
    pub fn point(&self, s: f64, n: f64) -> P {
        match &self.arc {
            Some(w) => w.point(s, n),
            None => P::new(self.a.x + self.u.x * s - self.u.y * n, self.a.y + self.u.y * s + self.u.x * n),
        }
    }

    /// Wandlokale Koordinaten (s, n) eines Punkts.
    pub fn local(&self, p: P) -> (f64, f64) {
        match &self.arc {
            Some(w) => w.local(p),
            None => {
                let d = P::new(p.x - self.a.x, p.y - self.a.y);
                (d.x * self.u.x + d.y * self.u.y, -d.x * self.u.y + d.y * self.u.x)
            }
        }
    }

    /// Teilstück `[s0, s1]` als neue Achse: Start, Ende, Bulge (`None` = gerade). `None` = zu kurz
    /// oder (Bogen) ein Vollkreis.
    pub fn piece(&self, s0: f64, s1: f64) -> Option<(P, P, Option<f64>)> {
        if !(s1 - s0 >= MIN_LEN) {
            return None;
        }
        let (p0, p1) = (self.point(s0, 0.0), self.point(s1, 0.0));
        match &self.arc {
            None => Some((p0, p1, None)),
            Some(w) => {
                let sweep = w.sweep.abs() * (s1 - s0) / self.len;
                if sweep >= TAU - 1e-3 {
                    return None;
                }
                Some((p0, p1, Some(self.sign * (sweep / 4.0).tan())))
            }
        }
    }

    /// Parameter der Schnittpunkte des Trägers (Gerade bzw. Vollkreis) mit der Grenze.
    fn hits(&self, b: &Bound) -> Vec<f64> {
        let pts: Vec<P> = match (&self.arc, b) {
            (None, Bound::Seg(p, q)) => {
                let d = P::new(q.x - p.x, q.y - p.y);
                let den = cross(self.u, d);
                if den.abs() < 1e-12 {
                    return vec![];
                }
                let ap = P::new(p.x - self.a.x, p.y - self.a.y);
                let t = cross(ap, self.u) / den;
                if !(-1e-9..=1.0 + 1e-9).contains(&t) {
                    return vec![];
                }
                vec![P::new(p.x + d.x * t, p.y + d.y * t)]
            }
            (None, Bound::Arc { c, r, a0, sweep }) => circle_line(*c, *r, &Line { point: self.a, dir: self.u }).into_iter().filter(|x| on_arc(*c, *a0, *sweep, *x)).collect(),
            (Some(w), Bound::Seg(p, q)) => {
                let d = P::new(q.x - p.x, q.y - p.y);
                let dd = d.x * d.x + d.y * d.y;
                circle_line(w.center, w.r, &Line { point: *p, dir: d })
                    .into_iter()
                    .filter(|x| {
                        let t = ((x.x - p.x) * d.x + (x.y - p.y) * d.y) / dd;
                        (-1e-9..=1.0 + 1e-9).contains(&t)
                    })
                    .collect()
            }
            (Some(w), Bound::Arc { c, r, a0, sweep }) => circle_circle(w.center, w.r, *c, *r).into_iter().filter(|x| on_arc(*c, *a0, *sweep, *x)).collect(),
        };
        pts.into_iter().filter(|p| fin(*p)).map(|p| self.local(p).0).filter(|s| s.is_finite()).collect()
    }

    /// Umriss eines Stücks `[s0, s1]` zwischen den Linien `lo`/`hi` (Bögen in Stationen).
    fn outline(&self, s0: f64, s1: f64, lo: f64, hi: f64) -> Vec<(f64, f64)> {
        let n = match &self.arc {
            Some(w) => ((w.segments(w.r_max(lo, hi)) as f64 * (s1 - s0).abs() / self.len).ceil() as usize).clamp(1, 512),
            None => 1,
        };
        let st: Vec<f64> = (0..=n).map(|i| s0 + (s1 - s0) * i as f64 / n as f64).collect();
        let mut out: Vec<(f64, f64)> = st.iter().map(|s| self.point(*s, lo)).map(|p| (p.x, p.y)).collect();
        out.extend(st.iter().rev().map(|s| self.point(*s, hi)).map(|p| (p.x, p.y)));
        out
    }
}

/// Liegt `x` auf dem Bogen (Mittelpunkt `c`, Startwinkel `a0`, Schwenk `sweep` mit Vorzeichen)?
fn on_arc(c: P, a0: f64, sweep: f64, x: P) -> bool {
    if sweep.abs() >= TAU - 1e-12 {
        return true;
    }
    let ang = (x.y - c.y).atan2(x.x - c.x);
    let rel = ((ang - a0) * sweep.signum()).rem_euclid(TAU);
    rel <= sweep.abs() + 1e-9 || rel >= TAU - 1e-9
}

/// Linien der Wand quer zur Achse: (erste Fläche, zweite Fläche) wie `dim_assoc::wall_geo`.
pub fn faces(root: &Map<String, Value>, w: &Value) -> (f64, f64) {
    let layers: Vec<f64> = str_of(w, "wallTypeId")
        .and_then(|id| arr(root.get("wallTypes")).iter().find(|t| id_of(t) == Some(id)))
        .map(|t| arr(field(t, "layers")).iter().map(|l| field(l, "thickness").and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(0.0)).collect())
        .unwrap_or_default();
    let total: f64 = layers.iter().sum();
    let half = total / 2.0;
    let r = match (field(w, "referenceOffset").and_then(Value::as_f64), str_of(w, "referenceLine")) {
        (Some(v), _) if v.is_finite() => crate::joins::Reference::Offset(v),
        (_, Some("left")) => crate::joins::Reference::Left,
        (_, Some("right")) => crate::joins::Reference::Right,
        _ => crate::joins::Reference::Center,
    };
    let off = crate::joins::reference_offset(r, total);
    (off - half, off + half)
}

// ── Grenzen ─────────────────────────────────────────────────────────────────

/// Grenze eines Trims/einer Verlängerung: Strecke oder Bogen (Schwenk mit Vorzeichen).
#[derive(Clone, Debug)]
pub enum Bound {
    Seg(P, P),
    Arc { c: P, r: f64, a0: f64, sweep: f64 },
}

/// Linie `n` einer Wand über die Länge plus `ext` an beiden Enden als Grenze.
fn wall_bound(ax: &Axis, n: f64, ext: f64) -> Bound {
    match &ax.arc {
        None => Bound::Seg(ax.point(-ext, n), ax.point(ax.len + ext, n)),
        Some(w) => {
            let r = w.radius_at(n);
            let sweep = (w.sweep * (ax.len + 2.0 * ext) / ax.len).clamp(-TAU, TAU);
            Bound::Arc { c: w.center, r, a0: w.angle_at(-ext), sweep }
        }
    }
}

/// Grenzen einer 2D-Zeichnung (Linie, Polylinie mit Bögen, Rechteck, Kreis, Bogen, Achsraster).
fn drawing_bounds(d: &Value, level: &str, out: &mut Vec<Bound>) {
    let g = field(d, "geom").unwrap_or(&Value::Null);
    match str_of(g, "shape").unwrap_or("") {
        "line" => out.push(Bound::Seg(p_of(field(g, "a")), p_of(field(g, "b")))),
        "rect" => {
            let (a, b) = (p_of(field(g, "min")), p_of(field(g, "max")));
            let c = [a, P::new(b.x, a.y), b, P::new(a.x, b.y)];
            for i in 0..4 {
                out.push(Bound::Seg(c[i], c[(i + 1) % 4]));
            }
        }
        "polyline" => {
            let pts: Vec<P> = arr(field(g, "pts")).iter().map(|v| p_of(Some(v))).collect();
            let n = pts.len();
            let segs = if truthy(field(g, "closed")) && n > 2 { n } else { n.saturating_sub(1) };
            let bulge = arr(field(g, "bulge"));
            for i in 0..segs {
                let (a, b) = (pts[i], pts[(i + 1) % n]);
                let bv = num_of(bulge.get(i));
                match kernel2d::bulge_arc(a, b, bv).filter(|_| bv.abs() > 1e-9) {
                    Some(arc) => out.push(Bound::Arc { c: arc.center, r: arc.r, a0: arc.a0, sweep: arc.sweep }),
                    None => out.push(Bound::Seg(a, b)),
                }
            }
        }
        "circle" => out.push(Bound::Arc { c: p_of(field(g, "center")), r: num_of(field(g, "r")), a0: 0.0, sweep: TAU }),
        "arc" => {
            let (a0, a1) = (num_of(field(g, "a0")), num_of(field(g, "a1")));
            let mut sweep = (a1 - a0).rem_euclid(TAU);
            if sweep < 1e-12 {
                sweep = TAU;
            }
            out.push(Bound::Arc { c: p_of(field(g, "center")), r: num_of(field(g, "r")), a0, sweep });
        }
        "grid" => {
            let Ok(geom) = serde_json::from_value::<crate::model::Drawing2DGeom>(g.clone()) else { return };
            let Some(spec) = crate::grid::Spec::of(&geom) else { return };
            for ax in spec.axes() {
                match ax.shape {
                    crate::grid::Shape::Line { a, b } => out.push(Bound::Seg(P::new(a.0, a.1), P::new(b.0, b.1))),
                    crate::grid::Shape::Arc { c, r, a0, a1 } => out.push(Bound::Arc { c: P::new(c.0, c.1), r, a0, sweep: a1 - a0 }),
                }
            }
            let _ = level;
        }
        _ => {}
    }
}

/// Alle Grenzen für die Wand `target`: übrige Wände des Geschosses (Achse oder, `face`, beide Flächen,
/// je um die halbe Dicke über die Enden verlängert, damit Ecken greifen), 2D-Zeichnungen und Achsraster.
pub fn bounds(root: &Map<String, Value>, target: &Value, face: bool) -> Vec<Bound> {
    let level = str_of(target, "floorId").unwrap_or("");
    let tid = id_of(target);
    let mut out = Vec::new();
    for w in walls(root) {
        if id_of(w) == tid || str_of(w, "floorId") != Some(level) {
            continue;
        }
        let Some(ax) = Axis::of(w) else { continue };
        let (lo, hi) = faces(root, w);
        let ext = (hi - lo) / 2.0;
        if face && hi - lo > 1e-9 {
            out.push(wall_bound(&ax, lo, ext));
            out.push(wall_bound(&ax, hi, ext));
        } else {
            out.push(wall_bound(&ax, 0.0, ext));
        }
    }
    for d in arr(root.get("drawings2d")) {
        let on = str_of(d, "levelId") == Some(level)
            || (str_of(field(d, "geom").unwrap_or(&Value::Null), "shape") == Some("grid")
                && serde_json::from_value::<crate::model::Drawing2D>(d.clone()).is_ok_and(|dd| crate::grid::visible_on(&dd, level)));
        if on {
            drawing_bounds(d, level, &mut out);
        }
    }
    out
}

/// Sortierte, entdoppelte Schnitt-Parameter der Achse mit allen Grenzen.
fn cuts(ax: &Axis, bs: &[Bound]) -> Vec<f64> {
    let mut s: Vec<f64> = bs.iter().flat_map(|b| ax.hits(b)).collect();
    s.sort_by(|a, b| a.total_cmp(b));
    s.dedup_by(|a, b| (*a - *b).abs() < EPS_S);
    s
}

// ── Treffer ─────────────────────────────────────────────────────────────────

/// Abstand des Punkts zum Wandkörper (0 innen), `None` ausserhalb der Länge.
pub fn wall_distance(root: &Map<String, Value>, w: &Value, at: P) -> Option<f64> {
    let ax = Axis::of(w)?;
    let (s, n) = ax.local(at);
    if !(s >= -HIT_TOL && s <= ax.len + HIT_TOL) {
        return None;
    }
    let (lo, hi) = faces(root, w);
    let d = if n < lo { lo - n } else if n > hi { n - hi } else { 0.0 };
    let along = if s < 0.0 { -s } else if s > ax.len { s - ax.len } else { 0.0 };
    Some(d.hypot(along))
}

/// Nächste bearbeitbare Wand des Geschosses unter dem Punkt (Abstand < `HIT_TOL`), mit Abstand.
pub fn pick_wall<'a>(root: &'a Map<String, Value>, level: &str, at: P) -> Option<(&'a Value, f64)> {
    let mut best: Option<(&Value, f64)> = None;
    for w in walls(root) {
        if str_of(w, "floorId") != Some(level) || !editable(w) {
            continue;
        }
        if let Some(d) = wall_distance(root, w, at) {
            if d < HIT_TOL && best.map_or(true, |b| d < b.1) {
                best = Some((w, d));
            }
        }
    }
    best
}

// ── Plan einer Änderung ─────────────────────────────────────────────────────

/// Teilstücke einer Wand: `(id, s0, s1)` im Parameter der alten Achse (`None` = alte id).
pub struct Plan<'a> {
    pub src: &'a Value,
    pub ax: Axis,
    pub pieces: Vec<(f64, f64)>,
    /// Wandende-Bezüge folgen dem ersten/letzten Stück (Trim, Extend, Verrunden).
    pub follow_ends: bool,
}

/// Neue Wand als Kopie von `src` (Fillet-Bogen, Offset).
pub struct NewWall<'a> {
    pub src: &'a Value,
    pub a: P,
    pub b: P,
    pub bulge: Option<f64>,
}

#[derive(Default)]
pub struct Edit<'a> {
    pub plans: Vec<Plan<'a>>,
    pub extra: Vec<NewWall<'a>>,
}

impl Edit<'_> {
    fn changes(&self) -> bool {
        !self.extra.is_empty() || self.plans.iter().any(|p| p.pieces.len() != 1 || p.pieces[0].0.abs() > EPS_S || (p.pieces[0].1 - p.ax.len).abs() > EPS_S)
    }
}

fn geom_fields(a: P, b: P, bulge: Option<f64>) -> Vec<(&'static str, Value)> {
    let mut f = vec![("start", ptv(a)), ("end", ptv(b))];
    if let Some(bv) = bulge {
        f.push(("bulge", js_num(bv)));
    }
    f
}

/// Ziel eines alten Wand-Parameterbereichs: neue id, `[s0, s1]` im alten Parameter.
struct Target {
    id: String,
    s0: f64,
    s1: f64,
}

/// Abbildung alte Wand → neue Wände (für Öffnungen und Bemassung).
struct Remap {
    old: String,
    len: f64,
    ax: Axis,
    targets: Vec<Target>,
    follow_ends: bool,
}

impl Remap {
    fn containing(&self, s: f64) -> Option<&Target> {
        self.targets.iter().find(|t| s >= t.s0 - EPS_S && s <= t.s1 + EPS_S)
    }
    fn nearest(&self, s: f64) -> Option<&Target> {
        let gap = |t: &Target| if s < t.s0 { t.s0 - s } else if s > t.s1 { s - t.s1 } else { 0.0 };
        self.targets.iter().min_by(|a, b| gap(a).total_cmp(&gap(b)))
    }
    fn first(&self) -> Option<&Target> {
        self.targets.iter().min_by(|a, b| a.s0.total_cmp(&b.s0))
    }
    fn last(&self) -> Option<&Target> {
        self.targets.iter().max_by(|a, b| a.s1.total_cmp(&b.s1))
    }
}

/// Öffnungen der umgebauten Wände umhängen/umrechnen/löschen.
fn opening_ops(root: &Map<String, Value>, maps: &[Remap]) -> Vec<Op> {
    let mut ops = Vec::new();
    let mut gone = Vec::new();
    for o in arr(root.get("openings")) {
        let Some(m) = str_of(o, "hostWallId").and_then(|h| maps.iter().find(|m| m.old == h)) else { continue };
        let (pos, width) = (num_of(field(o, "position")), num_of(field(o, "width")));
        let c = pos + width / 2.0;
        let t = m.containing(c);
        let Some(t) = t.filter(|t| width <= t.s1 - t.s0 + EPS_S) else {
            if let Some(id) = id_of(o) {
                gone.push(id.to_string());
            }
            continue;
        };
        let np = (pos - t.s0).min(t.s1 - t.s0 - width).max(0.0);
        let same_host = str_of(o, "hostWallId") == Some(t.id.as_str());
        if same_host && (np - pos).abs() < 1e-12 {
            continue;
        }
        ops.push(Op::Replace { collection: "openings".into(), entity: with_all(o, vec![("hostWallId", Value::String(t.id.clone())), ("position", js_num(np))]) });
    }
    if !gone.is_empty() {
        ops.push(Op::Remove { collection: "openings".into(), ids: gone });
    }
    ops
}

/// Bezüge der Bemassung auf umgebaute Wände umschreiben ([38]).
fn dim_ops(root: &Map<String, Value>, maps: &[Remap]) -> Vec<Op> {
    let mut ops = Vec::new();
    for d in arr(root.get("drawings2d")) {
        let Some(g) = field(d, "geom").filter(|g| str_of(g, "shape") == Some("dimension")) else { continue };
        let Some(rv) = field(g, "refs") else { continue };
        let Ok(mut refs) = serde_json::from_value::<Vec<Option<DimRef>>>(rv.clone()) else { continue };
        let pts: Vec<P> = arr(field(g, "pts")).iter().map(|v| p_of(Some(v))).collect();
        let mut changed = false;
        for (i, r) in refs.iter_mut().enumerate() {
            let Some(r) = r.as_mut() else { continue };
            let here = pts.get(i).copied().unwrap_or(P::new(f64::NAN, f64::NAN));
            if let Some(m) = maps.iter().find(|m| m.old == r.id) {
                match r.feature {
                    DimFeature::Wall => {
                        let Some(t) = r.t else { continue };
                        let s = t * m.len;
                        let hit = if m.follow_ends && t == 0.0 {
                            m.first().map(|x| (x, 0.0))
                        } else if m.follow_ends && t == 1.0 {
                            m.last().map(|x| (x, 1.0))
                        } else {
                            m.containing(s).map(|x| (x, ((s - x.s0) / (x.s1 - x.s0)).clamp(0.0, 1.0)))
                        };
                        match hit {
                            Some((x, nt)) => {
                                r.id = x.id.clone();
                                r.t = Some(nt);
                            }
                            None => {
                                r.t = None;
                                r.lost = Some(true);
                            }
                        }
                        changed = true;
                    }
                    DimFeature::Intersection | DimFeature::Center | DimFeature::Rim => {
                        let s = if fin(here) { m.ax.local(here).0 } else { 0.0 };
                        if let Some(x) = m.nearest(s) {
                            r.id = x.id.clone();
                            changed = true;
                        }
                    }
                    _ => {}
                }
            }
            if let Some(m) = r.id2.as_deref().and_then(|id2| maps.iter().find(|m| m.old == id2)) {
                let s = if fin(here) { m.ax.local(here).0 } else { 0.0 };
                if let Some(x) = m.nearest(s) {
                    r.id2 = Some(x.id.clone());
                    changed = true;
                }
            }
        }
        if changed {
            let ng = with(g, "refs", serde_json::to_value(&refs).unwrap_or(Value::Null));
            ops.push(Op::Replace { collection: "drawings2d".into(), entity: with(d, "geom", ng) });
        }
    }
    ops
}

/// Ops einer Änderung (eine Undo-Stufe).
pub fn commit(root: &Map<String, Value>, e: &Edit, ids: &mut IdGen) -> Vec<Op> {
    if !e.changes() {
        return vec![];
    }
    let mut ops = Vec::new();
    let mut added = Vec::new();
    let mut maps = Vec::new();
    for p in &e.plans {
        let Some(old) = id_of(p.src) else { continue };
        let mut targets = Vec::new();
        for (k, (s0, s1)) in p.pieces.iter().enumerate() {
            let Some((a, b, bulge)) = p.ax.piece(*s0, *s1) else { continue };
            let id = if k == 0 { old.to_string() } else { ids.next("wall") };
            let mut f = geom_fields(a, b, bulge);
            if k == 0 {
                ops.push(Op::Replace { collection: "walls".into(), entity: with_all(p.src, f) });
            } else {
                f.push(("id", Value::String(id.clone())));
                added.push(with_all(p.src, f));
            }
            targets.push(Target { id, s0: *s0, s1: *s1 });
        }
        if targets.is_empty() {
            ops.push(Op::Remove { collection: "walls".into(), ids: vec![old.to_string()] });
        }
        maps.push(Remap { old: old.to_string(), len: p.ax.len, ax: p.ax.clone(), targets, follow_ends: p.follow_ends });
    }
    for n in &e.extra {
        let mut f = geom_fields(n.a, n.b, n.bulge);
        f.push(("id", Value::String(ids.next("wall"))));
        let w = with_all(n.src, f);
        // Gerade Kopie einer Bogenwand: kein Bulge.
        let w = if n.bulge.is_none() { without(&w, "bulge") } else { w };
        added.push(w);
    }
    if !added.is_empty() {
        ops.push(Op::Add { collection: "walls".into(), items: added, at: None });
    }
    ops.extend(opening_ops(root, &maps));
    ops.extend(dim_ops(root, &maps));
    ops
}

fn without(v: &Value, k: &str) -> Value {
    let mut m = v.as_object().cloned().unwrap_or_default();
    m.remove(k);
    Value::Object(m)
}

/// Vorschau: Umriss jedes Ergebnis-Stücks.
pub fn preview(root: &Map<String, Value>, e: &Edit, out: &mut Shapes) {
    for p in &e.plans {
        let (lo, hi) = faces(root, p.src);
        for (s0, s1) in &p.pieces {
            if p.ax.piece(*s0, *s1).is_some() {
                out.poly(&p.ax.outline(*s0, *s1, lo, hi));
            }
        }
    }
    for n in &e.extra {
        let (lo, hi) = faces(root, n.src);
        if let Some(ax) = Axis::new(n.a, n.b, n.bulge) {
            out.poly(&ax.outline(0.0, ax.len, lo, hi));
        }
    }
}

// ── Befehle ─────────────────────────────────────────────────────────────────

fn plan(w: &Value, follow_ends: bool) -> Option<Plan<'_>> {
    editable(w).then_some(())?;
    Some(Plan { src: w, ax: Axis::of(w)?, pieces: vec![], follow_ends })
}

/// Trim: das angeklickte Stück zwischen den nächsten Schnitten (bzw. bis zum Ende) entfällt.
pub fn trim<'a>(root: &'a Map<String, Value>, w: &'a Value, at: P, face: bool) -> Option<Edit<'a>> {
    let mut p = plan(w, true)?;
    let s = p.ax.local(at).0;
    let c: Vec<f64> = cuts(&p.ax, &bounds(root, w, face)).into_iter().filter(|x| *x > EPS_S && *x < p.ax.len - EPS_S).collect();
    let lo = c.iter().copied().filter(|x| *x < s).last();
    let hi = c.iter().copied().find(|x| *x > s);
    if lo.is_none() && hi.is_none() {
        return None;
    }
    if let Some(lo) = lo {
        p.pieces.push((0.0, lo));
    }
    if let Some(hi) = hi {
        p.pieces.push((hi, p.ax.len));
    }
    p.pieces.retain(|(a, b)| b - a >= MIN_LEN);
    Some(Edit { plans: vec![p], extra: vec![] })
}

/// Extend: das dem Punkt nähere Ende bis zur nächsten Grenze dahinter verlängern.
pub fn extend<'a>(root: &'a Map<String, Value>, w: &'a Value, at: P, face: bool) -> Option<Edit<'a>> {
    let mut p = plan(w, true)?;
    let start = dist(at, p.ax.a) <= dist(at, p.ax.b);
    let c = cuts(&p.ax, &bounds(root, w, face));
    let len = p.ax.len;
    let piece = if start { c.iter().copied().filter(|x| *x < -EPS_S).last().map(|s0| (s0, len)) } else { c.iter().copied().find(|x| *x > len + EPS_S).map(|s1| (0.0, s1)) }?;
    p.ax.piece(piece.0, piece.1)?;
    p.pieces.push(piece);
    Some(Edit { plans: vec![p], extra: vec![] })
}

/// Bruch zwischen zwei Punkten (gleicher Punkt = Teilen an dieser Stelle).
pub fn break_at<'a>(w: &'a Value, p1: P, p2: P) -> Option<Edit<'a>> {
    let mut p = plan(w, false)?;
    let len = p.ax.len;
    let (s1, s2) = (p.ax.local(p1).0.clamp(0.0, len), p.ax.local(p2).0.clamp(0.0, len));
    let (lo, hi) = if s1 <= s2 { (s1, s2) } else { (s2, s1) };
    if hi - lo < MIN_LEN {
        if lo < MIN_LEN || lo > len - MIN_LEN {
            return None;
        }
        p.pieces = vec![(0.0, lo), (lo, len)];
    } else {
        p.follow_ends = true;
        p.pieces = [(0.0, lo), (hi, len)].into_iter().filter(|(a, b)| b - a >= MIN_LEN).collect();
    }
    Some(Edit { plans: vec![p], extra: vec![] })
}

/// Teilen an allen Schnittpunkten mit den Grenzen (Achsen der übrigen Wände, 2D, Achsraster).
pub fn split_at_intersections<'a>(root: &'a Map<String, Value>, w: &'a Value) -> Option<Edit<'a>> {
    let mut p = plan(w, false)?;
    let len = p.ax.len;
    let mut last = 0.0;
    for s in cuts(&p.ax, &bounds(root, w, false)) {
        if s >= last + MIN_LEN && s <= len - MIN_LEN {
            p.pieces.push((last, s));
            last = s;
        }
    }
    if p.pieces.is_empty() {
        return None;
    }
    p.pieces.push((last, len));
    Some(Edit { plans: vec![p], extra: vec![] })
}

/// Offset: parallele (bei Bogenwänden konzentrische) Kopie im Achsabstand `d` (links positiv).
pub fn offset(w: &Value, d: f64) -> Option<Edit<'_>> {
    let ax = Axis::of(w)?;
    if !d.is_finite() || d.abs() < 1e-9 {
        return None;
    }
    if let Some(a) = &ax.arc {
        if a.radius_at(d) < MIN_LEN {
            return None;
        }
    }
    let (a, b) = (ax.point(0.0, d), ax.point(ax.len, d));
    let bulge = ax.arc.map(|_| num_of(field(w, "bulge")));
    Some(Edit { plans: vec![], extra: vec![NewWall { src: w, a, b, bulge }] })
}

/// Seite des Punkts zur Wand (+1 links, −1 rechts).
pub fn side(w: &Value, at: P) -> Option<f64> {
    let (_, n) = Axis::of(w)?.local(at);
    Some(if n >= 0.0 { 1.0 } else { -1.0 })
}

/// Schnittpunkte der Träger zweier Achsen.
fn carrier_hits(a: &Axis, b: &Axis) -> Vec<P> {
    match (&a.arc, &b.arc) {
        (None, None) => kernel2d::line_intersect(a.a, a.u, b.a, b.u).into_iter().collect(),
        (None, Some(w)) => circle_line(w.center, w.r, &Line { point: a.a, dir: a.u }),
        (Some(w), None) => circle_line(w.center, w.r, &Line { point: b.a, dir: b.u }),
        (Some(v), Some(w)) => circle_circle(v.center, v.r, w.center, w.r),
    }
}

/// Behaltener Bereich einer Wand bis zum Eckpunkt `s_x`: die Seite des Klicks `s_c`.
fn keep(ax: &Axis, s_x: f64, s_c: f64) -> Option<(f64, f64)> {
    let r = if s_c <= s_x { (0.0, s_x) } else { (s_x, ax.len) };
    ax.piece(r.0, r.1).map(|_| r)
}

/// Verrunden zweier Wände: beide bis zum Achsschnittpunkt (nächst den Klicks) stutzen bzw. verlängern
/// (L-Ecke); mit Radius `r > 0` (nur gerade Wände) enden sie an den Tangentenpunkten und eine
/// Bogenwand (Kopie der ersten Wand) schliesst tangential an.
pub fn fillet<'a>(w1: &'a Value, p1: P, w2: &'a Value, p2: P, r: f64) -> Option<Edit<'a>> {
    if id_of(w1) == id_of(w2) {
        return None;
    }
    let (mut a, mut b) = (plan(w1, true)?, plan(w2, true)?);
    let x = carrier_hits(&a.ax, &b.ax).into_iter().filter(|x| fin(*x)).min_by(|x, y| (dist(*x, p1) + dist(*x, p2)).total_cmp(&(dist(*y, p1) + dist(*y, p2))))?;
    let (ka, kb) = (keep(&a.ax, a.ax.local(x).0, a.ax.local(p1).0)?, keep(&b.ax, b.ax.local(x).0, b.ax.local(p2).0)?);
    let r = if r.is_finite() { r.max(0.0) } else { 0.0 };
    if r < 1e-6 {
        a.pieces.push(ka);
        b.pieces.push(kb);
        return Some(Edit { plans: vec![a, b], extra: vec![] });
    }
    if a.ax.arc.is_some() || b.ax.arc.is_some() {
        return None;
    }
    let toward_a = ka.0 == 0.0;
    let toward_b = kb.0 == 0.0;
    let far_a = if toward_a { a.ax.a } else { a.ax.b };
    let far_b = if toward_b { b.ax.a } else { b.ax.b };
    let f = kernel2d::fillet_corner(x, far_a, far_b, r)?;
    let (sa, sb) = (a.ax.local(f.tangent_a).0, b.ax.local(f.tangent_b).0);
    let ra = if toward_a { (0.0, sa) } else { (sa, a.ax.len) };
    let rb = if toward_b { (0.0, sb) } else { (sb, b.ax.len) };
    // Eine Seite darf ganz im Bogen aufgehen: dann entfällt sie (keine Null-Wand).
    let mx = P::new(x.x - f.center.x, x.y - f.center.y);
    let ml = mx.x.hypot(mx.y);
    if !(ml > 1e-12) {
        return None;
    }
    let apex = P::new(f.center.x + mx.x / ml * f.radius, f.center.y + mx.y / ml * f.radius);
    let (s, e) = if toward_a { (f.tangent_a, f.tangent_b) } else { (f.tangent_b, f.tangent_a) };
    let bulge = crate::bulge::from_sagitta_point(s.x, s.y, e.x, e.y, apex.x, apex.y);
    if !(bulge.is_finite() && bulge.abs() > 1e-9) {
        return None;
    }
    a.pieces.push(ra);
    b.pieces.push(rb);
    a.pieces.retain(|(s0, s1)| s1 - s0 >= MIN_LEN);
    b.pieces.retain(|(s0, s1)| s1 - s0 >= MIN_LEN);
    Some(Edit { plans: vec![a, b], extra: vec![NewWall { src: w1, a: s, b: e, bulge: Some(bulge) }] })
}

/// Verketten: gewählte Wände desselben Geschosses und Wandtyps, die mit der ersten kollinear (gleiche
/// Laufrichtung) bzw. auf demselben Kreis (gleicher Drehsinn) liegen, werden eine Wand über die
/// Gesamtspanne (Lücken werden geschlossen). Die erste behält id und Attribute.
pub fn join_ops(root: &Map<String, Value>, ids_sel: &[String]) -> Vec<Op> {
    let sel: Vec<&Value> = walls(root).iter().filter(|w| editable(w) && id_of(w).is_some_and(|i| ids_sel.iter().any(|x| x == i))).collect();
    let Some((first, rest)) = sel.split_first() else { return vec![] };
    let Some(ax) = Axis::of(first) else { return vec![] };
    let same = |w: &Value, k: &str| field(w, k) == field(first, k);
    // Lage jeder Partnerwand auf der ersten Achse: Versatz ihres Starts.
    let mut members: Vec<(&Value, Axis, f64)> = Vec::new();
    for w in rest {
        let Some(bx) = Axis::of(w) else { continue };
        if !same(w, "floorId") || !same(w, "wallTypeId") {
            continue;
        }
        let ok = match (&ax.arc, &bx.arc) {
            (None, None) => {
                let (_, n0) = ax.local(bx.a);
                let (_, n1) = ax.local(bx.b);
                n0.abs() < EPS_GEO && n1.abs() < EPS_GEO && bx.u.x * ax.u.x + bx.u.y * ax.u.y > 0.0
            }
            (Some(v), Some(u)) => dist(v.center, u.center) < EPS_GEO && (v.r - u.r).abs() < EPS_GEO && v.sweep.signum() == u.sweep.signum(),
            _ => false,
        };
        if ok {
            members.push((w, bx.clone(), ax.local(bx.a).0));
        }
    }
    if members.is_empty() {
        return vec![];
    }
    let lo = members.iter().map(|m| m.2).fold(0.0_f64, f64::min);
    let hi = members.iter().map(|m| m.2 + m.1.len).fold(ax.len, f64::max);
    let Some((a, b, bulge)) = ax.piece(lo, hi) else { return vec![] };
    let new_id = id_of(first).unwrap_or("").to_string();
    let mut ops = vec![Op::Replace { collection: "walls".into(), entity: with_all(first, geom_fields(a, b, bulge)) }];
    ops.push(Op::Remove { collection: "walls".into(), ids: members.iter().filter_map(|m| id_of(m.0)).map(str::to_owned).collect() });
    let mut maps = vec![Remap { old: new_id.clone(), len: ax.len, ax: ax.clone(), targets: vec![Target { id: new_id.clone(), s0: lo, s1: hi }], follow_ends: false }];
    for (w, bx, off) in &members {
        maps.push(Remap { old: id_of(w).unwrap_or("").to_string(), len: bx.len, ax: bx.clone(), targets: vec![Target { id: new_id.clone(), s0: lo - off, s1: hi - off }], follow_ends: false });
    }
    ops.extend(opening_ops(root, &maps));
    ops.extend(dim_ops(root, &maps));
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Document;
    use serde_json::json;
    use std::f64::consts::PI;

    fn wall(id: &str, a: (f64, f64), b: (f64, f64), bulge: Option<f64>) -> Value {
        let mut w = json!({"id": id, "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": a.0, "y": a.1}, "end": {"x": b.0, "y": b.1}, "wallTypeId": "wt", "height": 2.6});
        if let Some(b) = bulge {
            w["bulge"] = json!(b);
        }
        w
    }
    fn opening(id: &str, host: &str, pos: f64, width: f64) -> Value {
        json!({"id": id, "type": "opening", "hostWallId": host, "categoryCode": "21", "kind": "window", "position": pos, "width": width, "height": 1.2, "sillHeight": 0.9})
    }
    fn dim(id: &str, refs: Value, pts: Value) -> Value {
        json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "dimension", "pts": pts, "offset": 1.0, "refs": refs}})
    }
    fn project(walls: Vec<Value>, openings: Vec<Value>, drawings: Vec<Value>) -> Map<String, Value> {
        json!({
            "id": "p", "name": "T", "lineStyles": [], "hatches": [], "components": [],
            "wallTypes": [{"id": "wt", "name": "W", "layers": [{"componentId": "c", "thickness": 0.2}]}],
            "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.6, "cutHeight": 1.0, "baseElevation": 0}],
            "layers": [], "walls": walls, "openings": openings, "ceilings": [], "stairs": [], "rooms": [], "drawings2d": drawings, "context": []
        })
        .as_object()
        .unwrap()
        .clone()
    }
    /// Ops über das Dokument anwenden (mit Bemassungs-Nachführung) und die neue Wurzel liefern.
    fn apply(root: &Map<String, Value>, ops: Vec<Op>) -> Map<String, Value> {
        let mut d = Document::from_json(&Value::Object(root.clone()).to_string()).unwrap();
        d.commit(ops, None, 0.0, false).unwrap();
        d.root().clone()
    }
    fn w_of<'a>(r: &'a Map<String, Value>, id: &str) -> &'a Value {
        find_wall(r, id).unwrap()
    }
    fn xy_of(v: &Value) -> (f64, f64) {
        (v["x"].as_f64().unwrap(), v["y"].as_f64().unwrap())
    }
    fn close(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6
    }
    fn commit_edit(r: &Map<String, Value>, e: Option<Edit>) -> Map<String, Value> {
        let ops = commit(r, &e.expect("Änderung"), &mut IdGen::new("s"));
        assert!(!ops.is_empty());
        apply(r, ops)
    }

    /// T: Wand a (0,0)→(10,0), Querwand b bei x = 6; Öffnung in a bei 1..2 und bei 7..8; Bemassung an
    /// a's Ende (t = 1) und a's Mitte des rechten Teils (t = 0.75).
    fn t_case() -> Map<String, Value> {
        project(
            vec![wall("a", (0.0, 0.0), (10.0, 0.0), None), wall("b", (6.0, -3.0), (6.0, 3.0), None)],
            vec![opening("o1", "a", 1.0, 1.0), opening("o2", "a", 7.0, 1.0)],
            vec![dim("d", json!([{"id": "a", "feature": "wall", "t": 0.0}, {"id": "a", "feature": "wall", "t": 0.75}, {"id": "a", "feature": "wall", "t": 1.0}]), json!([{"x": 0, "y": 0}, {"x": 7.5, "y": 0}, {"x": 10, "y": 0}]))],
        )
    }

    #[test]
    fn trim_gerade_wand_an_querwand() {
        let r = t_case();
        let e = trim(&r, w_of(&r, "a"), P::new(8.0, 0.0), false);
        let n = commit_edit(&r, e);
        let a = w_of(&n, "a");
        assert!(close(xy_of(&a["end"]), (6.0, 0.0)));
        // o2 lag im weggeschnittenen Teil → weg; o1 bleibt.
        let os: Vec<&str> = arr(n.get("openings")).iter().filter_map(id_of).collect();
        assert_eq!(os, vec!["o1"]);
        // Ende folgt (t = 1 → neues Ende), der Punkt im weggeschnittenen Teil ist verloren.
        let g = &arr(n.get("drawings2d"))[0]["geom"];
        assert!(close(xy_of(&g["pts"][2]), (6.0, 0.0)));
        assert_eq!(g["refs"][1]["lost"], json!(true));
        assert!(g["refs"][0]["lost"].is_null());
    }

    #[test]
    fn trim_mittelstueck_teilt_und_haengt_oeffnungen_um() {
        let mut r = t_case();
        r.get_mut("walls").unwrap().as_array_mut().unwrap().push(wall("c", (3.0, -3.0), (3.0, 3.0), None));
        let e = trim(&r, w_of(&r, "a"), P::new(4.5, 0.0), false);
        let n = commit_edit(&r, e);
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (3.0, 0.0)));
        let new = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        assert!(close(xy_of(&new["start"]), (6.0, 0.0)));
        let o2 = arr(n.get("openings")).iter().find(|o| o["id"] == "o2").unwrap();
        assert_eq!(o2["hostWallId"], "wall-s-1");
        assert!((o2["position"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        // Bemassung: t = 0.75 (x = 7.5) liegt auf dem neuen Stück, Lage bleibt.
        let g = &arr(n.get("drawings2d"))[0]["geom"];
        assert_eq!(g["refs"][1]["id"], "wall-s-1");
        assert!(close(xy_of(&g["pts"][1]), (7.5, 0.0)));
        assert_eq!(g["refs"][2]["id"], "wall-s-1");
    }

    #[test]
    fn extend_bis_zur_achse_und_flaeche() {
        let r = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (6.0, -3.0), (6.0, 3.0), None)], vec![], vec![]);
        let n = commit_edit(&r, extend(&r, w_of(&r, "a"), P::new(3.9, 0.0), false));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (6.0, 0.0)));
        let n = commit_edit(&r, extend(&r, w_of(&r, "a"), P::new(3.9, 0.0), true));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.9, 0.0)));
        // Start verlängern: Öffnungen behalten ihre Weltlage.
        let r = project(vec![wall("a", (2.0, 0.0), (8.0, 0.0), None), wall("b", (0.0, -3.0), (0.0, 3.0), None)], vec![opening("o", "a", 1.0, 1.0)], vec![]);
        let n = commit_edit(&r, extend(&r, w_of(&r, "a"), P::new(2.1, 0.0), false));
        assert!(close(xy_of(&w_of(&n, "a")["start"]), (0.0, 0.0)));
        assert!((arr(n.get("openings"))[0]["position"].as_f64().unwrap() - 3.0).abs() < 1e-9);
    }

    #[test]
    fn bogenwand_trim_extend_split() {
        // Halbkreis (−5,0)→(5,0) um (0,0), Scheitel unten oder oben je nach Bulge; Gerade x = 0 schneidet.
        let arc = wall("a", (-5.0, 0.0), (5.0, 0.0), Some(1.0));
        let r = project(vec![arc, wall("b", (0.0, -8.0), (0.0, 8.0), None)], vec![opening("o", "a", 6.0, 1.0)], vec![]);
        let ax = Axis::of(w_of(&r, "a")).unwrap();
        let len = ax.len;
        assert!((len - 5.0 * PI).abs() < 1e-9);
        let mid = ax.point(len / 2.0, 0.0);
        assert!(mid.x.abs() < 1e-9);
        // Split an den Schnittpunkten: zwei Viertelbögen, die Öffnung (Mitte 6.5 < len/2 ≈ 7.85) bleibt auf dem ersten.
        let n = commit_edit(&r, split_at_intersections(&r, w_of(&r, "a")));
        let a = w_of(&n, "a");
        assert!(close(xy_of(&a["end"]), (mid.x, mid.y)));
        assert!((a["bulge"].as_f64().unwrap() - (PI / 8.0).tan()).abs() < 1e-9);
        let b2 = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        assert!(close(xy_of(&b2["end"]), (5.0, 0.0)));
        assert_eq!(arr(n.get("openings"))[0]["hostWallId"], "a");
        // Trim des zweiten Viertels: die Öffnung mit Mitte 6.5 < 7.85 bleibt.
        let p = ax.point(len * 0.75, 0.0);
        let n = commit_edit(&r, trim(&r, w_of(&r, "a"), p, false));
        let a = w_of(&n, "a");
        assert!(close(xy_of(&a["end"]), (mid.x, mid.y)));
        assert_eq!(arr(n.get("openings")).len(), 1);
        // Extend: Viertelbogen auf demselben Kreis bis zur Geraden x = 4 (Treffer (4, 3)).
        let q = wall("q", (-5.0, 0.0), (mid.x, mid.y), Some((PI / 8.0).tan()));
        let r = project(vec![q, wall("g", (4.0, -8.0), (4.0, 8.0), None)], vec![], vec![]);
        let n = commit_edit(&r, extend(&r, w_of(&r, "q"), P::new(mid.x, mid.y), false));
        let q = w_of(&n, "q");
        assert!(close(xy_of(&q["end"]), (4.0, 3.0)));
        let sweep = PI - 3.0_f64.atan2(4.0);
        assert!((q["bulge"].as_f64().unwrap() - (sweep / 4.0).tan()).abs() < 1e-9);
    }

    #[test]
    fn teilen_am_punkt_und_bruch() {
        let r = t_case();
        let n = commit_edit(&r, break_at(w_of(&r, "a"), P::new(4.0, 0.1), P::new(4.0, 0.1)));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (4.0, 0.0)));
        let o2 = arr(n.get("openings")).iter().find(|o| o["id"] == "o2").unwrap();
        assert_eq!(o2["hostWallId"], "wall-s-1");
        assert!((o2["position"].as_f64().unwrap() - 3.0).abs() < 1e-9);
        // Bemassung: Ende (t = 1) liegt jetzt auf dem zweiten Stück bei t = 1.
        let g = &arr(n.get("drawings2d"))[0]["geom"];
        assert_eq!(g["refs"][2]["id"], "wall-s-1");
        assert_eq!(g["refs"][2]["t"], json!(1.0));
        // Bruch 2..3 entfernt das Stück dazwischen; o1 (1..2) bleibt am ersten Stück.
        let n = commit_edit(&r, break_at(w_of(&r, "a"), P::new(2.5, 0.0), P::new(3.5, 0.0)));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (2.5, 0.0)));
        assert_eq!(arr(n.get("openings")).len(), 2);
    }

    #[test]
    fn verketten_gerade_und_bogen() {
        let r = project(
            vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (4.0, 0.0), (10.0, 0.0), None)],
            vec![opening("o", "b", 1.0, 1.0)],
            vec![dim("d", json!([{"id": "a", "feature": "wall", "t": 0.0}, {"id": "b", "feature": "wall", "t": 1.0}]), json!([{"x": 0, "y": 0}, {"x": 10, "y": 0}]))],
        );
        let n = apply(&r, join_ops(&r, &["a".into(), "b".into()]));
        assert_eq!(arr(n.get("walls")).len(), 1);
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (10.0, 0.0)));
        let o = &arr(n.get("openings"))[0];
        assert_eq!(o["hostWallId"], "a");
        assert!((o["position"].as_f64().unwrap() - 5.0).abs() < 1e-9);
        let g = &arr(n.get("drawings2d"))[0]["geom"];
        assert_eq!(g["refs"][1]["id"], "a");
        assert!(close(xy_of(&g["pts"][1]), (10.0, 0.0)));
        // Gegenläufig: nicht verketten.
        let r2 = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (10.0, 0.0), (4.0, 0.0), None)], vec![], vec![]);
        assert!(join_ops(&r2, &["a".into(), "b".into()]).is_empty());
        // Zwei Viertelbögen desselben Kreises (um (0,0), unten herum) → Halbkreis.
        let t = (PI / 8.0).tan();
        let r3 = project(vec![wall("a", (-5.0, 0.0), (0.0, -5.0), Some(-t)), wall("b", (0.0, -5.0), (5.0, 0.0), Some(-t))], vec![], vec![]);
        let c = Axis::of(w_of(&r3, "a")).unwrap().arc.unwrap().center;
        assert!(close((c.x, c.y), (0.0, 0.0)));
        let n = apply(&r3, join_ops(&r3, &["a".into(), "b".into()]));
        let a = w_of(&n, "a");
        assert!(close(xy_of(&a["end"]), (5.0, 0.0)));
        assert!((a["bulge"].as_f64().unwrap() + 1.0).abs() < 1e-9);
    }

    #[test]
    fn verrunden_l_ecke_und_radius() {
        // a läuft nach rechts bis x = 4 (zu kurz), b senkrecht bei x = 6 über y = 0 hinaus.
        let r = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (6.0, 5.0), (6.0, -2.0), None)], vec![opening("o", "b", 1.0, 1.0)], vec![]);
        let (a, b) = (w_of(&r, "a"), w_of(&r, "b"));
        let n = commit_edit(&r, fillet(a, P::new(2.0, 0.0), b, P::new(6.0, 3.0), 0.0));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (6.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["end"]), (6.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["start"]), (6.0, 5.0)));
        // Radius 1: Tangentenpunkte (5,0) und (6,1), Bogenwand dazwischen.
        let n = commit_edit(&r, fillet(a, P::new(2.0, 0.0), b, P::new(6.0, 3.0), 1.0));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["end"]), (6.0, 1.0)));
        let arcw = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        assert!(close(xy_of(&arcw["start"]), (5.0, 0.0)));
        assert!(close(xy_of(&arcw["end"]), (6.0, 1.0)));
        let ax = Axis::of(arcw).unwrap();
        let m = ax.point(ax.len / 2.0, 0.0);
        let c = (5.0, 1.0);
        assert!(((m.x - c.0).hypot(m.y - c.1) - 1.0).abs() < 1e-9);
        assert!(m.x > 5.0 && m.y < 1.0, "Bogen nach aussen zur Ecke");
        // Öffnung in b (1..2 ab Start (6,5)) bleibt.
        assert_eq!(arr(n.get("openings"))[0]["position"], json!(1.0));
    }

    #[test]
    fn offset_gerade_und_bogen() {
        let r = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("c", (-5.0, 0.0), (5.0, 0.0), Some(1.0))], vec![], vec![]);
        let n = commit_edit(&r, offset(w_of(&r, "a"), 1.5));
        let w = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        assert!(close(xy_of(&w["start"]), (0.0, 1.5)));
        assert!(close(xy_of(&w["end"]), (4.0, 1.5)));
        let n = commit_edit(&r, offset(w_of(&r, "c"), 1.0));
        let w = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        let ax = Axis::of(w).unwrap();
        let c = Axis::of(w_of(&r, "c")).unwrap().arc.unwrap();
        assert!((ax.arc.unwrap().r - c.radius_at(1.0)).abs() < 1e-9);
        assert_eq!(w["bulge"].as_f64(), Some(1.0));
    }

    #[test]
    fn treffer_und_gesperrt() {
        let mut r = t_case();
        assert_eq!(pick_wall(&r, "eg", P::new(8.0, 0.05)).map(|w| id_of(w.0)), Some(Some("a")));
        r.get_mut("walls").unwrap().as_array_mut().unwrap()[0]["locked"] = json!(true);
        assert!(trim(&r, w_of(&r, "a"), P::new(8.0, 0.0), false).is_none());
        assert_ne!(pick_wall(&r, "eg", P::new(8.0, 0.05)).map(|w| id_of(w.0)), Some(Some("a")));
    }

    #[test]
    fn trim_an_2d_linie_und_achsraster() {
        let r = project(vec![wall("a", (0.0, 0.0), (10.0, 0.0), None)], vec![], vec![json!({"id": "l", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": 3, "y": -1}, "b": {"x": 3, "y": 1}}})]);
        let n = commit_edit(&r, trim(&r, w_of(&r, "a"), P::new(1.0, 0.0), false));
        assert!(close(xy_of(&w_of(&n, "a")["start"]), (3.0, 0.0)));
    }
}
