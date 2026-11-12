//! Editier-Befehle für Wände, gerade und gebogen ([113], Anschluss an `cmd_edit.rs`): dieselben Befehle
//! wie für 2D-Zeichnungen — Trim, Extend, Bruch/Teilen (am Punkt, an den Schnittpunkten), Verketten
//! (kollinear bzw. auf demselben Kreis, auch gegenläufig), Verrunden zweier Wände (L-Ecke am
//! Achsschnittpunkt, mit Radius eine tangentiale Bogenwand dazwischen — gerade und Bogenwände), Fasen
//! (gerade Wand dazwischen) und Offset (parallele Kopie). Dazu die Wände als Grenzen für Trim/Extend von
//! 2D-Kurven (`wall_cutters`, `extend_to_walls`).
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
use crate::json_util::{arr, as_copy, field, js_num, pt, with, with_all};
use crate::joins::Line;
use crate::model::{DimFeature, DimRef, Drawing2D, Drawing2DGeom, Project, Vec2, Wall, WallReferenceLine};
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

fn p_of(v: &Vec2) -> P {
    P::new(v.x, v.y)
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
pub fn walls(p: &Project) -> &[Wall] {
    &p.walls
}

pub fn find_wall<'a>(p: &'a Project, id: &str) -> Option<&'a Wall> {
    p.walls.iter().find(|w| w.id == id)
}

/// Das rohe Element (verlustfreier Baum) zu einer id: Ops schreiben es mit geänderten Feldern zurück.
fn raw<'a>(root: &'a Map<String, Value>, collection: &str, id: &str) -> Option<&'a Value> {
    arr(root.get(collection)).iter().find(|e| id_of(e) == Some(id))
}

fn editable(w: &Wall) -> bool {
    !w.locked.unwrap_or(false)
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

    pub fn of(w: &Wall) -> Option<Axis> {
        Axis::new(p_of(&w.start), p_of(&w.end), w.bulge)
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
pub fn faces(p: &Project, w: &Wall) -> (f64, f64) {
    let total: f64 = p.wall_types.iter().find(|t| t.id == w.wall_type_id).map_or(0.0, |t| t.layers.iter().map(|l| Some(l.thickness).filter(|x| x.is_finite()).unwrap_or(0.0)).sum());
    let half = total / 2.0;
    let r = match (w.reference_offset, w.reference_line) {
        (Some(v), _) if v.is_finite() => crate::joins::Reference::Offset(v),
        (_, Some(WallReferenceLine::Left)) => crate::joins::Reference::Left,
        (_, Some(WallReferenceLine::Right)) => crate::joins::Reference::Right,
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
fn drawing_bounds(d: &Drawing2D, out: &mut Vec<Bound>) {
    match &d.geom {
        Drawing2DGeom::Line { a, b } => out.push(Bound::Seg(p_of(a), p_of(b))),
        Drawing2DGeom::Rect { min, max } => {
            let (a, b) = (p_of(min), p_of(max));
            let c = [a, P::new(b.x, a.y), b, P::new(a.x, b.y)];
            for i in 0..4 {
                out.push(Bound::Seg(c[i], c[(i + 1) % 4]));
            }
        }
        Drawing2DGeom::Polyline { pts, closed, bulge, holes } => {
            // Inseln ([77]) begrenzen wie der Umriss.
            for h in holes.iter().flatten() {
                let h: Vec<P> = h.iter().map(p_of).collect();
                for i in 0..h.len() {
                    out.push(Bound::Seg(h[i], h[(i + 1) % h.len()]));
                }
            }
            let pts: Vec<P> = pts.iter().map(p_of).collect();
            let n = pts.len();
            let segs = if *closed && n > 2 { n } else { n.saturating_sub(1) };
            for i in 0..segs {
                let (a, b) = (pts[i], pts[(i + 1) % n]);
                let bv = bulge.as_ref().and_then(|b| b.get(i)).copied().unwrap_or(f64::NAN);
                match kernel2d::bulge_arc(a, b, bv).filter(|_| bv.abs() > 1e-9) {
                    Some(arc) => out.push(Bound::Arc { c: arc.center, r: arc.r, a0: arc.a0, sweep: arc.sweep }),
                    None => out.push(Bound::Seg(a, b)),
                }
            }
        }
        Drawing2DGeom::Circle { center, r } => out.push(Bound::Arc { c: p_of(center), r: *r, a0: 0.0, sweep: TAU }),
        Drawing2DGeom::Arc { center, r, a0, a1 } => {
            let mut sweep = (a1 - a0).rem_euclid(TAU);
            if sweep < 1e-12 {
                sweep = TAU;
            }
            out.push(Bound::Arc { c: p_of(center), r: *r, a0: *a0, sweep });
        }
        g @ Drawing2DGeom::Grid { .. } => {
            let Some(spec) = crate::grid::Spec::of(g) else { return };
            for ax in spec.axes() {
                match ax.shape {
                    crate::grid::Shape::Line { a, b } => out.push(Bound::Seg(P::new(a.0, a.1), P::new(b.0, b.1))),
                    crate::grid::Shape::Arc { c, r, a0, a1 } => out.push(Bound::Arc { c: P::new(c.0, c.1), r, a0, sweep: a1 - a0 }),
                }
            }
        }
        _ => {}
    }
}

/// Alle Grenzen für die Wand `target`: übrige Wände des Geschosses (Achse oder, `face`, beide Flächen,
/// je um die halbe Dicke über die Enden verlängert, damit Ecken greifen), 2D-Zeichnungen und Achsraster.
pub fn bounds(p: &Project, target: &Wall, face: bool) -> Vec<Bound> {
    let level = target.floor_id.as_str();
    let mut out = Vec::new();
    for (ax, n, ext) in wall_lines(p, level, Some(&target.id), face) {
        out.push(wall_bound(&ax, n, ext));
    }
    for d in &p.drawings2d {
        if d.level_id == level || (matches!(d.geom, Drawing2DGeom::Grid { .. }) && crate::grid::visible_on(d, level)) {
            drawing_bounds(d, &mut out);
        }
    }
    out
}

/// Grenzlinien der Wände eines Geschosses (ohne `skip`): Achse bzw. (`face`) beide Aussenflächen, als
/// (Achse, Querlage `n`, Überstand an beiden Enden = halbe Dicke).
fn wall_lines(p: &Project, level: &str, skip: Option<&str>, face: bool) -> Vec<(Axis, f64, f64)> {
    let mut out = Vec::new();
    for w in walls(p) {
        if Some(w.id.as_str()) == skip || w.floor_id != level {
            continue;
        }
        let Some(ax) = Axis::of(w) else { continue };
        let (lo, hi) = faces(p, w);
        let ext = (hi - lo) / 2.0;
        if face && hi - lo > 1e-9 {
            out.push((ax.clone(), lo, ext));
            out.push((ax, hi, ext));
        } else {
            out.push((ax, 0.0, ext));
        }
    }
    out
}

/// Wände des Geschosses als Schneider für 2D-Kurven (Trim, [113]): je Grenzlinie Start, Ende und
/// Polylinien-Bulge (`0` = gerade).
pub fn wall_cutters(p: &Project, level: &str, face: bool) -> Vec<(P, P, f64)> {
    wall_lines(p, level, None, face)
        .into_iter()
        .filter_map(|(ax, n, ext)| {
            let (_, _, bulge) = ax.piece(-ext, ax.len + ext)?;
            let (a, b) = (ax.point(-ext, n), ax.point(ax.len + ext, n));
            (fin(a) && fin(b)).then_some((a, b, bulge.unwrap_or(0.0)))
        })
        .collect()
}

/// Verlängerung einer 2D-Kurve an Wänden (Extend, [113]): Endstück `a → b` (Bulge wie Polylinien) bis
/// zur nächsten Wand-Grenzlinie vor dem Start (`at_start`) bzw. hinter dem Ende. Ergebnis: Zuwachs
/// (Meter entlang des Stücks), neuer Endpunkt, neuer Bulge des Endstücks (`None` = gerade).
pub fn extend_to_walls(p: &Project, level: &str, a: P, b: P, bulge: Option<f64>, at_start: bool, face: bool) -> Option<(f64, P, Option<f64>)> {
    let ax = Axis::new(a, b, bulge)?;
    let bs: Vec<Bound> = wall_lines(p, level, None, face).iter().map(|(w, n, ext)| wall_bound(w, *n, *ext)).collect();
    let c = cuts(&ax, &bs);
    let len = ax.len;
    let (s0, s1) = if at_start { (c.iter().copied().filter(|x| *x < -EPS_S).last()?, len) } else { (0.0, c.iter().copied().find(|x| *x > len + EPS_S)?) };
    let (na, nb, nbulge) = ax.piece(s0, s1)?;
    Some(if at_start { (-s0, na, nbulge) } else { (s1 - len, nb, nbulge) })
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
pub fn wall_distance(p: &Project, w: &Wall, at: P) -> Option<f64> {
    let ax = Axis::of(w)?;
    let (s, n) = ax.local(at);
    if !(s >= -HIT_TOL && s <= ax.len + HIT_TOL) {
        return None;
    }
    let (lo, hi) = faces(p, w);
    let d = if n < lo { lo - n } else if n > hi { n - hi } else { 0.0 };
    let along = if s < 0.0 { -s } else if s > ax.len { s - ax.len } else { 0.0 };
    Some(d.hypot(along))
}

/// Nächste bearbeitbare Wand des Geschosses unter dem Punkt (Abstand < `HIT_TOL`), mit Abstand.
pub fn pick_wall<'a>(p: &'a Project, level: &str, at: P) -> Option<(&'a Wall, f64)> {
    let mut best: Option<(&Wall, f64)> = None;
    for w in walls(p) {
        if w.floor_id != level || !editable(w) {
            continue;
        }
        if let Some(d) = wall_distance(p, w, at) {
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
    pub src: &'a Wall,
    pub ax: Axis,
    pub pieces: Vec<(f64, f64)>,
    /// Wandende-Bezüge folgen dem ersten/letzten Stück (Trim, Extend, Verrunden).
    pub follow_ends: bool,
}

/// Neue Wand als Kopie von `src` (Fillet-Bogen, Offset).
pub struct NewWall<'a> {
    pub src: &'a Wall,
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
    /// Gegenläufig verkettet: `ax` ist die gekehrte alte Achse, Lagen der alten Wand werden gespiegelt
    /// (`s ↦ len − s`), Türen kehren Aufschlag und Scharnier.
    rev: bool,
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
fn opening_ops(root: &Map<String, Value>, p: &Project, maps: &[Remap]) -> Vec<Op> {
    let mut ops = Vec::new();
    let mut gone = Vec::new();
    for o in p.openings.iter().flatten() {
        let Some(m) = maps.iter().find(|m| m.old == o.host_wall_id) else { continue };
        let width = o.width;
        let pos = if m.rev { m.len - o.position - width } else { o.position };
        let c = pos + width / 2.0;
        let t = m.containing(c);
        let Some(t) = t.filter(|t| width <= t.s1 - t.s0 + EPS_S) else {
            gone.push(o.id.clone());
            continue;
        };
        let np = (pos - t.s0).min(t.s1 - t.s0 - width).max(0.0);
        let same_host = o.host_wall_id == t.id;
        if same_host && (np - pos).abs() < 1e-12 && !m.rev {
            continue;
        }
        let Some(ro) = raw(root, "openings", &o.id) else { continue };
        let mut f = vec![("hostWallId", Value::String(t.id.clone())), ("position", js_num(np))];
        if m.rev {
            f.extend(reversed_door(ro));
        }
        ops.push(Op::Replace { collection: "openings".into(), entity: with_all(ro, f) });
    }
    if !gone.is_empty() {
        ops.push(Op::Remove { collection: "openings".into(), ids: gone });
    }
    ops
}

/// Tür an einer gekehrten Wand: Aufschlag (Seite der Achse) und Scharnier (Start/Ende) wechseln, damit
/// sie in der Welt gleich bleibt (fehlend = links bzw. Start).
fn reversed_door(o: &Value) -> Vec<(&'static str, Value)> {
    let door = field(o, "kind").and_then(Value::as_str) == Some("door") || field(o, "swing").is_some();
    if !door {
        return vec![];
    }
    let s = |k: &str| field(o, k).and_then(Value::as_str).unwrap_or("");
    vec![
        ("swing", Value::String(if s("swing") == "right" { "left" } else { "right" }.into())),
        ("hinge", Value::String(if s("hinge") == "end" { "start" } else { "end" }.into())),
    ]
}

/// Bezüge der Bemassung auf umgebaute Wände umschreiben ([38]).
fn dim_ops(root: &Map<String, Value>, p: &Project, maps: &[Remap]) -> Vec<Op> {
    let mut ops = Vec::new();
    for d in &p.drawings2d {
        let Drawing2DGeom::Dimension { pts, refs: Some(refs), .. } = &d.geom else { continue };
        let mut refs: Vec<Option<DimRef>> = refs.clone();
        let pts: Vec<P> = pts.iter().map(p_of).collect();
        let mut changed = false;
        for (i, r) in refs.iter_mut().enumerate() {
            let Some(r) = r.as_mut() else { continue };
            let here = pts.get(i).copied().unwrap_or(P::new(f64::NAN, f64::NAN));
            if let Some(m) = maps.iter().find(|m| m.old == r.id) {
                match r.feature {
                    DimFeature::Wall => {
                        let Some(t) = r.t else { continue };
                        let t = if m.rev { 1.0 - t } else { t };
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
            let Some(rd) = raw(root, "drawings2d", &d.id) else { continue };
            let ng = with(field(rd, "geom").unwrap_or(&Value::Null), "refs", serde_json::to_value(&refs).unwrap_or(Value::Null));
            ops.push(Op::Replace { collection: "drawings2d".into(), entity: with(rd, "geom", ng) });
        }
    }
    ops
}

/// Ops einer Änderung (eine Undo-Stufe).
pub fn commit(root: &Map<String, Value>, pr: &Project, e: &Edit, ids: &mut IdGen) -> Vec<Op> {
    if !e.changes() {
        return vec![];
    }
    let mut ops = Vec::new();
    let mut added = Vec::new();
    let mut maps = Vec::new();
    for p in &e.plans {
        let old = p.src.id.as_str();
        let Some(src) = raw(root, "walls", old) else { continue };
        let mut targets = Vec::new();
        for (k, (s0, s1)) in p.pieces.iter().enumerate() {
            let Some((a, b, bulge)) = p.ax.piece(*s0, *s1) else { continue };
            let id = if k == 0 { old.to_string() } else { ids.next("wall") };
            let mut f = geom_fields(a, b, bulge);
            if k == 0 {
                ops.push(Op::Replace { collection: "walls".into(), entity: with_all(src, f) });
            } else {
                f.push(("id", Value::String(id.clone())));
                added.push(with_all(&as_copy(src), f));
            }
            targets.push(Target { id, s0: *s0, s1: *s1 });
        }
        if targets.is_empty() {
            ops.push(Op::Remove { collection: "walls".into(), ids: vec![old.to_string()] });
        }
        maps.push(Remap { old: old.to_string(), len: p.ax.len, ax: p.ax.clone(), targets, follow_ends: p.follow_ends, rev: false });
    }
    for n in &e.extra {
        let Some(src) = raw(root, "walls", &n.src.id) else { continue };
        let mut f = geom_fields(n.a, n.b, n.bulge);
        f.push(("id", Value::String(ids.next("wall"))));
        let w = with_all(&as_copy(src), f);
        // Gerade Kopie einer Bogenwand: kein Bulge.
        let w = if n.bulge.is_none() { without(&w, "bulge") } else { w };
        added.push(w);
    }
    if !added.is_empty() {
        ops.push(Op::Add { collection: "walls".into(), items: added, at: None });
    }
    ops.extend(opening_ops(root, pr, &maps));
    ops.extend(dim_ops(root, pr, &maps));
    ops
}

fn without(v: &Value, k: &str) -> Value {
    let mut m = v.as_object().cloned().unwrap_or_default();
    m.remove(k);
    Value::Object(m)
}

/// Vorschau: Umriss jedes Ergebnis-Stücks.
pub fn preview(pr: &Project, e: &Edit, out: &mut Shapes) {
    for p in &e.plans {
        let (lo, hi) = faces(pr, p.src);
        for (s0, s1) in &p.pieces {
            if p.ax.piece(*s0, *s1).is_some() {
                out.poly(&p.ax.outline(*s0, *s1, lo, hi));
            }
        }
    }
    for n in &e.extra {
        let (lo, hi) = faces(pr, n.src);
        if let Some(ax) = Axis::new(n.a, n.b, n.bulge) {
            out.poly(&ax.outline(0.0, ax.len, lo, hi));
        }
    }
}

// ── Befehle ─────────────────────────────────────────────────────────────────

fn plan(w: &Wall, follow_ends: bool) -> Option<Plan<'_>> {
    editable(w).then_some(())?;
    Some(Plan { src: w, ax: Axis::of(w)?, pieces: vec![], follow_ends })
}

/// Trim: das angeklickte Stück zwischen den nächsten Schnitten (bzw. bis zum Ende) entfällt.
pub fn trim<'a>(root: &'a Project, w: &'a Wall, at: P, face: bool) -> Option<Edit<'a>> {
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
pub fn extend<'a>(root: &'a Project, w: &'a Wall, at: P, face: bool) -> Option<Edit<'a>> {
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
pub fn break_at<'a>(w: &'a Wall, p1: P, p2: P) -> Option<Edit<'a>> {
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
pub fn split_at_intersections<'a>(root: &'a Project, w: &'a Wall) -> Option<Edit<'a>> {
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
pub fn offset(w: &Wall, d: f64) -> Option<Edit<'_>> {
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
    let bulge = ax.arc.map(|_| w.bulge.unwrap_or(f64::NAN));
    Some(Edit { plans: vec![], extra: vec![NewWall { src: w, a, b, bulge }] })
}

/// Seite des Punkts zur Wand (+1 links, −1 rechts).
pub fn side(w: &Wall, at: P) -> Option<f64> {
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

/// Ecke zweier Wände: Pläne beider Wände, Achsschnittpunkt (nächst den Klicks) und die behaltenen
/// Bereiche bis dorthin (Seite des jeweiligen Klicks).
struct WallCorner<'a> {
    a: Plan<'a>,
    b: Plan<'a>,
    x: P,
    ka: (f64, f64),
    kb: (f64, f64),
}

impl WallCorner<'_> {
    /// Behält Wand a den Bereich ab ihrem Start (Ecke am Ende)?
    fn toward_a(&self) -> bool {
        self.ka.0 == 0.0
    }
    fn toward_b(&self) -> bool {
        self.kb.0 == 0.0
    }
    /// Achsparameter der Ecke auf a bzw. b.
    fn sx(&self) -> (f64, f64) {
        (if self.toward_a() { self.ka.1 } else { self.ka.0 }, if self.toward_b() { self.kb.1 } else { self.kb.0 })
    }
    /// Beide Wände enden bei `sa`/`sb` (Parameter der eigenen Achse); eine Seite darf ganz entfallen.
    fn cut_to(&mut self, sa: f64, sb: f64) {
        let ra = if self.toward_a() { (0.0, sa) } else { (sa, self.a.ax.len) };
        let rb = if self.toward_b() { (0.0, sb) } else { (sb, self.b.ax.len) };
        self.a.pieces.push(ra);
        self.b.pieces.push(rb);
        self.a.pieces.retain(|(s0, s1)| s1 - s0 >= MIN_LEN);
        self.b.pieces.retain(|(s0, s1)| s1 - s0 >= MIN_LEN);
    }
    /// Verbindungswand von a nach b in Laufrichtung der Kette (a → Verbindung → b bzw. umgekehrt).
    fn link(&self, ta: P, tb: P) -> (P, P) {
        if self.toward_a() {
            (ta, tb)
        } else {
            (tb, ta)
        }
    }
}

fn wall_corner<'a>(w1: &'a Wall, p1: P, w2: &'a Wall, p2: P) -> Option<WallCorner<'a>> {
    if w1.id == w2.id {
        return None;
    }
    let (a, b) = (plan(w1, true)?, plan(w2, true)?);
    let x = carrier_hits(&a.ax, &b.ax).into_iter().filter(|x| fin(*x)).min_by(|x, y| (dist(*x, p1) + dist(*x, p2)).total_cmp(&(dist(*y, p1) + dist(*y, p2))))?;
    let (ka, kb) = (keep(&a.ax, a.ax.local(x).0, a.ax.local(p1).0)?, keep(&b.ax, b.ax.local(x).0, b.ax.local(p2).0)?);
    Some(WallCorner { a, b, x, ka, kb })
}

/// Träger einer um `d` versetzten Achse: Gerade (Punkt, Richtung) oder Kreis (Mitte, Radius).
enum Carrier {
    Line(P, P),
    Circle(P, f64),
}

fn carrier(ax: &Axis, d: f64) -> Option<Carrier> {
    match &ax.arc {
        None => Some(Carrier::Line(ax.point(0.0, d), ax.u)),
        Some(w) => {
            let r = w.radius_at(d);
            (r > 1e-9).then_some(Carrier::Circle(w.center, r))
        }
    }
}

fn carrier_cross(a: &Carrier, b: &Carrier) -> Vec<P> {
    match (a, b) {
        (Carrier::Line(p, u), Carrier::Line(q, v)) => kernel2d::line_intersect(*p, *u, *q, *v).into_iter().collect(),
        (Carrier::Line(p, u), Carrier::Circle(c, r)) | (Carrier::Circle(c, r), Carrier::Line(p, u)) => circle_line(*c, *r, &Line { point: *p, dir: *u }),
        (Carrier::Circle(c1, r1), Carrier::Circle(c2, r2)) => circle_circle(*c1, *r1, *c2, *r2),
    }
}

/// Fusspunkt von `c` auf der Achse (Gerade bzw. Kreis).
fn foot(ax: &Axis, c: P) -> Option<P> {
    match &ax.arc {
        None => {
            let t = (c.x - ax.a.x) * ax.u.x + (c.y - ax.a.y) * ax.u.y;
            Some(P::new(ax.a.x + ax.u.x * t, ax.a.y + ax.u.y * t))
        }
        Some(w) => {
            let d = dist(c, w.center);
            (d > 1e-12).then(|| P::new(w.center.x + (c.x - w.center.x) / d * w.r, w.center.y + (c.y - w.center.y) / d * w.r))
        }
    }
}

/// Verrundung mit Bogenwand(en) ([113]): Mittelpunkt des Kreises mit Radius `r`, der beide Träger
/// berührt und dessen Berührpunkte in den behaltenen Bereichen liegen (nächst der Ecke); Ergebnis
/// Mitte und die Parameter der Berührpunkte auf a und b.
fn arc_fillet(k: &WallCorner, r: f64) -> Option<(P, f64, f64)> {
    let (sxa, sxb) = k.sx();
    let inside = |ax: &Axis, toward: bool, sx: f64, s: f64| {
        if toward {
            s <= sx + EPS_S && (ax.arc.is_none() || s >= -EPS_S)
        } else {
            s >= sx - EPS_S && (ax.arc.is_none() || s <= ax.len + EPS_S)
        }
    };
    let mut best: Option<(f64, P, f64, f64)> = None;
    for da in [r, -r] {
        for db in [r, -r] {
            let (Some(ca), Some(cb)) = (carrier(&k.a.ax, da), carrier(&k.b.ax, db)) else { continue };
            for c in carrier_cross(&ca, &cb).into_iter().filter(|c| fin(*c)) {
                let (Some(ta), Some(tb)) = (foot(&k.a.ax, c), foot(&k.b.ax, c)) else { continue };
                let (sa, sb) = (k.a.ax.local(ta).0, k.b.ax.local(tb).0);
                if !(inside(&k.a.ax, k.toward_a(), sxa, sa) && inside(&k.b.ax, k.toward_b(), sxb, sb)) {
                    continue;
                }
                let score = (sxa - sa).abs() + (sxb - sb).abs();
                if best.map_or(true, |b| score < b.0) {
                    best = Some((score, c, sa, sb));
                }
            }
        }
    }
    best.map(|b| (b.1, b.2, b.3))
}

/// Verrunden zweier Wände: beide bis zum Achsschnittpunkt (nächst den Klicks) stutzen bzw. verlängern
/// (L-Ecke); mit Radius `r > 0` enden sie an den Tangentenpunkten und eine Bogenwand (Kopie der ersten
/// Wand) schliesst tangential an — auch zwischen Bogenwänden bzw. Bogen und Gerade.
pub fn fillet<'a>(w1: &'a Wall, p1: P, w2: &'a Wall, p2: P, r: f64) -> Option<Edit<'a>> {
    let mut k = wall_corner(w1, p1, w2, p2)?;
    let r = if r.is_finite() { r.max(0.0) } else { 0.0 };
    if r < 1e-6 {
        k.a.pieces.push(k.ka);
        k.b.pieces.push(k.kb);
        return Some(Edit { plans: vec![k.a, k.b], extra: vec![] });
    }
    if k.a.ax.arc.is_some() || k.b.ax.arc.is_some() {
        let (c, sa, sb) = arc_fillet(&k, r)?;
        let (ta, tb) = (k.a.ax.point(sa, 0.0), k.b.ax.point(sb, 0.0));
        // Scheitel: der Kreispunkt auf der Seite der Ecke.
        let m = P::new((ta.x + tb.x) / 2.0 - c.x, (ta.y + tb.y) / 2.0 - c.y);
        let ml = m.x.hypot(m.y);
        let dir = if ml > 1e-9 { P::new(m.x / ml, m.y / ml) } else { let d = dist(ta, tb).max(1e-12); P::new(-(tb.y - ta.y) / d, (tb.x - ta.x) / d) };
        let ap = [P::new(c.x + dir.x * r, c.y + dir.y * r), P::new(c.x - dir.x * r, c.y - dir.y * r)];
        let apex = if dist(ap[0], k.x) <= dist(ap[1], k.x) { ap[0] } else { ap[1] };
        let (s, e) = k.link(ta, tb);
        let bulge = crate::bulge::from_sagitta_point(s.x, s.y, e.x, e.y, apex.x, apex.y);
        if !(bulge.is_finite() && bulge.abs() > 1e-9) {
            return None;
        }
        k.cut_to(sa, sb);
        return Some(Edit { plans: vec![k.a, k.b], extra: vec![NewWall { src: w1, a: s, b: e, bulge: Some(bulge) }] });
    }
    let WallCorner { mut a, mut b, x, ka, kb } = k;
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

/// Fasen zweier Wände ([113]): beide enden im Abstand `d` (entlang der Achse, bei Bogenwänden
/// Bogenlänge) vor dem Achsschnittpunkt; eine gerade Wand (Kopie der ersten) verbindet die Enden.
/// `d = 0` ergibt die L-Ecke wie Verrunden ohne Radius.
pub fn chamfer<'a>(w1: &'a Wall, p1: P, w2: &'a Wall, p2: P, d: f64) -> Option<Edit<'a>> {
    let mut k = wall_corner(w1, p1, w2, p2)?;
    let d = if d.is_finite() { d.max(0.0) } else { 0.0 };
    if d < 1e-6 {
        k.a.pieces.push(k.ka);
        k.b.pieces.push(k.kb);
        return Some(Edit { plans: vec![k.a, k.b], extra: vec![] });
    }
    let (sxa, sxb) = k.sx();
    let sa = if k.toward_a() { sxa - d } else { sxa + d };
    let sb = if k.toward_b() { sxb - d } else { sxb + d };
    // Das Fasen-Ende muss auf der behaltenen Wand liegen (sonst ginge sie ganz verloren).
    let ok = |ax: &Axis, toward: bool, s: f64| if toward { s >= -EPS_S } else { s <= ax.len + EPS_S };
    if !(ok(&k.a.ax, k.toward_a(), sa) && ok(&k.b.ax, k.toward_b(), sb)) {
        return None;
    }
    let (ta, tb) = (k.a.ax.point(sa, 0.0), k.b.ax.point(sb, 0.0));
    if dist(ta, tb) < MIN_LEN {
        return None;
    }
    let (s, e) = k.link(ta, tb);
    k.cut_to(sa, sb);
    Some(Edit { plans: vec![k.a, k.b], extra: vec![NewWall { src: w1, a: s, b: e, bulge: None }] })
}

/// Verketten: gewählte Wände desselben Geschosses und Wandtyps, die mit der ersten kollinear bzw. auf
/// demselben Kreis liegen, werden eine Wand über die Gesamtspanne (Lücken werden geschlossen). Die erste
/// behält id, Attribute und Laufrichtung (damit die Schichtseite); gegenläufige Partner werden gekehrt —
/// ihre Öffnungen behalten die Weltlage, Türen kehren Aufschlag und Scharnier.
pub fn join_ops(root: &Map<String, Value>, pr: &Project, ids_sel: &[String]) -> Vec<Op> {
    let sel: Vec<&Wall> = walls(pr).iter().filter(|w| editable(w) && ids_sel.iter().any(|x| *x == w.id)).collect();
    let Some((first, rest)) = sel.split_first() else { return vec![] };
    let Some(ax) = Axis::of(first) else { return vec![] };
    let Some(first_raw) = raw(root, "walls", &first.id) else { return vec![] };
    // Lage jeder Partnerwand auf der ersten Achse: Versatz ihres Starts.
    let mut members: Vec<(&Wall, Axis, f64, bool)> = Vec::new();
    for w in rest {
        let Some(bx) = Axis::of(w) else { continue };
        if w.floor_id != first.floor_id || w.wall_type_id != first.wall_type_id {
            continue;
        }
        // Gleichläufig oder gegenläufig (dann mit gekehrter Achse).
        let same = match (&ax.arc, &bx.arc) {
            (None, None) => {
                let (_, n0) = ax.local(bx.a);
                let (_, n1) = ax.local(bx.b);
                (n0.abs() < EPS_GEO && n1.abs() < EPS_GEO).then(|| bx.u.x * ax.u.x + bx.u.y * ax.u.y > 0.0)
            }
            (Some(v), Some(u)) => (dist(v.center, u.center) < EPS_GEO && (v.r - u.r).abs() < EPS_GEO).then(|| v.sweep.signum() == u.sweep.signum()),
            _ => None,
        };
        let Some(same) = same else { continue };
        let bx = if same {
            bx
        } else {
            let Some(r) = Axis::new(bx.b, bx.a, w.bulge.map(|b| -b)) else { continue };
            r
        };
        members.push((w, bx.clone(), ax.local(bx.a).0, !same));
    }
    if members.is_empty() {
        return vec![];
    }
    let lo = members.iter().map(|m| m.2).fold(0.0_f64, f64::min);
    let hi = members.iter().map(|m| m.2 + m.1.len).fold(ax.len, f64::max);
    let Some((a, b, bulge)) = ax.piece(lo, hi) else { return vec![] };
    let new_id = first.id.clone();
    let mut ops = vec![Op::Replace { collection: "walls".into(), entity: with_all(first_raw, geom_fields(a, b, bulge)) }];
    ops.push(Op::Remove { collection: "walls".into(), ids: members.iter().map(|m| m.0.id.clone()).collect() });
    let mut maps = vec![Remap { old: new_id.clone(), len: ax.len, ax: ax.clone(), targets: vec![Target { id: new_id.clone(), s0: lo, s1: hi }], follow_ends: false, rev: false }];
    for (w, bx, off, rev) in &members {
        maps.push(Remap { old: w.id.clone(), len: bx.len, ax: bx.clone(), targets: vec![Target { id: new_id.clone(), s0: lo - off, s1: hi - off }], follow_ends: false, rev: *rev });
    }
    ops.extend(opening_ops(root, pr, &maps));
    ops.extend(dim_ops(root, pr, &maps));
    ops
}

/// Ein Wandende, das beim Verbinden auf einen Achsschnittpunkt `x` rückt.
struct Move {
    i: usize,
    at_end: bool,
    x: P,
}

/// Lage des Achsschnittpunkts zu einer Wand: nahe einem Ende (Abstand, Ende?) oder im Innern.
enum Spot {
    End(f64, bool),
    Inner,
}

fn spot(ax: &Axis, x: P, tol: f64) -> Option<Spot> {
    let s = ax.local(x).0;
    let (d0, d1) = (s.abs(), (s - ax.len).abs());
    if d0.min(d1) <= tol {
        Some(Spot::End(d0.min(d1), d1 < d0))
    } else if s > 0.0 && s < ax.len {
        Some(Spot::Inner)
    } else {
        None
    }
}

/// T-Stoss ([190]): Punkt, an dem die Achse des Abzweigs (`ab`, Ende `at_end`) auf die dem Abzweig
/// zugewandte Fläche der Durchgangswand `wt` trifft. Dort endet der Abzweig; `joins.rs`
/// (`apply_mid_span_tee`) schneidet ihn an dieser Fläche, es bleibt kein Überstand im Durchgang.
fn tee_face_point(pr: &Project, ab: &Axis, at_end: bool, wt: &Wall, at: &Axis) -> Option<P> {
    let far = if at_end { ab.a } else { ab.b };
    let (lo, hi) = faces(pr, wt);
    let face = if at.local(far).1 >= 0.0 { hi } else { lo };
    kernel2d::line_intersect(ab.a, ab.u, at.point(0.0, face), at.u).filter(|x| fin(*x))
}

/// Verbinden von Ecken ([190], Archicad-Art): gewählte gerade Wände eines Geschosses, deren Achsen sich
/// nicht sauber treffen, werden bis zum Achsschnittpunkt verlängert bzw. gekürzt. Zwei Enden nahe am
/// Schnittpunkt ergeben eine L-Ecke (beide rücken), ein Ende nahe am Schnittpunkt, der im Innern der
/// anderen Wand liegt, einen T-Stoss (nur das Ende rückt, an die zugewandte Fläche der Durchgangswand). Toleranz je Paar: grösser von 0.5 m und der
/// doppelten Wanddicke. Jedes Ende rückt höchstens einmal (nahe Paare zuerst). Die Gehrung bzw. der
/// Anschluss folgt aus den Enden (`joins.rs`); Öffnungen und Bemassung führt [`commit`] nach (wie
/// Trim/Extend — Öffnungen bleiben im Plan stehen). Wände in `skip` (schon kollinear verkettet) und
/// Bogenwände bleiben aussen vor. Parallele Wände (auch versetzte) werden nicht angefasst.
pub fn connect_ops(root: &Map<String, Value>, pr: &Project, ids_sel: &[String], skip: &[String]) -> Vec<Op> {
    let sel: Vec<(&Wall, Axis)> = walls(pr)
        .iter()
        .filter(|w| editable(w) && ids_sel.contains(&w.id) && !skip.contains(&w.id))
        .filter_map(|w| Axis::of(w).filter(|a| a.arc.is_none()).map(|a| (w, a)))
        .collect();
    // Kandidaten: (Kosten, Bewegungen)
    let mut cands: Vec<(f64, Vec<Move>)> = Vec::new();
    for i in 0..sel.len() {
        for j in i + 1..sel.len() {
            let ((wi, ai), (wj, aj)) = (&sel[i], &sel[j]);
            if wi.floor_id != wj.floor_id {
                continue;
            }
            let den = cross(ai.u, aj.u);
            if den.abs() < 0.02 {
                continue;
            }
            let t = cross(P::new(aj.a.x - ai.a.x, aj.a.y - ai.a.y), aj.u) / den;
            let x = P::new(ai.a.x + ai.u.x * t, ai.a.y + ai.u.y * t);
            if !fin(x) {
                continue;
            }
            let thick = |w: &Wall| {
                let (lo, hi) = faces(pr, w);
                (hi - lo).abs()
            };
            let tol = 0.5_f64.max(2.0 * thick(wi).max(thick(wj)));
            match (spot(ai, x, tol), spot(aj, x, tol)) {
                (Some(Spot::End(da, ea)), Some(Spot::End(db, eb))) => cands.push((da + db, vec![Move { i, at_end: ea, x }, Move { i: j, at_end: eb, x }])),
                (Some(Spot::End(da, ea)), Some(Spot::Inner)) => cands.push((da, vec![Move { i, at_end: ea, x: tee_face_point(pr, ai, ea, wj, aj).unwrap_or(x) }])),
                (Some(Spot::Inner), Some(Spot::End(db, eb))) => cands.push((db, vec![Move { i: j, at_end: eb, x: tee_face_point(pr, aj, eb, wi, ai).unwrap_or(x) }])),
                _ => {}
            }
        }
    }
    cands.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut span: Vec<(f64, f64)> = sel.iter().map(|(_, a)| (0.0, a.len)).collect();
    let mut used: Vec<(usize, bool)> = Vec::new();
    for (_, moves) in &cands {
        if moves.iter().any(|m| used.contains(&(m.i, m.at_end))) {
            continue;
        }
        // Keine Wand darf dabei (fast) verschwinden.
        let next: Vec<(usize, (f64, f64))> = moves
            .iter()
            .map(|m| {
                let s = sel[m.i].1.local(m.x).0;
                (m.i, if m.at_end { (span[m.i].0, s) } else { (s, span[m.i].1) })
            })
            .collect();
        if next.iter().any(|(_, (a, b))| !(b - a >= 0.05)) {
            continue;
        }
        for (m, (i, sp)) in moves.iter().zip(next) {
            span[i] = sp;
            used.push((m.i, m.at_end));
        }
    }
    let plans: Vec<Plan> = sel
        .iter()
        .zip(&span)
        .filter(|((_, a), (s0, s1))| s0.abs() > EPS_S || (s1 - a.len).abs() > EPS_S)
        .map(|((w, a), sp)| Plan { src: w, ax: a.clone(), pieces: vec![*sp], follow_ends: true })
        .collect();
    if plans.is_empty() {
        return vec![];
    }
    commit(root, pr, &Edit { plans, extra: vec![] }, &mut IdGen::new("join"))
}

/// Hinweis für die Hülle, wenn Verbinden ([190]) bei gewählten Wänden nichts bewirkt: i18n-Schlüssel, bei
/// Zahlen mit `|`-getrennten Werten dahinter (`cmd.join.far|0.73|0.50` = Abstand, Toleranz in Metern).
/// `None`, wenn kein Grund erkennbar ist (die Hülle zeigt dann den allgemeinen Hinweis).
pub fn join_hint(pr: &Project, ids_sel: &[String]) -> Option<String> {
    let sel: Vec<&Wall> = walls(pr).iter().filter(|w| ids_sel.contains(&w.id)).collect();
    if sel.len() < 2 {
        return None;
    }
    let free: Vec<&Wall> = sel.iter().copied().filter(|w| editable(w)).collect();
    if free.len() < 2 {
        return Some("cmd.join.locked".into());
    }
    let straight: Vec<(&Wall, Axis)> = free.iter().filter_map(|w| Axis::of(w).filter(|a| a.arc.is_none()).map(|a| (*w, a))).collect();
    if straight.len() < 2 {
        return Some("cmd.join.arc".into());
    }
    let (mut same_floor, mut parallel, mut met, mut crossing) = (false, false, false, false);
    let mut far: Option<(f64, f64)> = None;
    for i in 0..straight.len() {
        for j in i + 1..straight.len() {
            let ((wi, ai), (wj, aj)) = (&straight[i], &straight[j]);
            if wi.floor_id != wj.floor_id {
                continue;
            }
            same_floor = true;
            let den = cross(ai.u, aj.u);
            if den.abs() < 0.02 {
                parallel = true;
                continue;
            }
            let t = cross(P::new(aj.a.x - ai.a.x, aj.a.y - ai.a.y), aj.u) / den;
            let x = P::new(ai.a.x + ai.u.x * t, ai.a.y + ai.u.y * t);
            if !fin(x) {
                continue;
            }
            // Abstand des Schnittpunkts zur Wand: 0 im Innern, sonst zum nächsten Ende.
            let gap = |a: &Axis| {
                let s = a.local(x).0;
                if s > 0.0 && s < a.len {
                    (0.0, true)
                } else {
                    (s.abs().min((s - a.len).abs()), false)
                }
            };
            let ((gi, ini), (gj, inj)) = (gap(ai), gap(aj));
            let thick = |w: &Wall| {
                let (lo, hi) = faces(pr, w);
                (hi - lo).abs()
            };
            let tol = 0.5_f64.max(2.0 * thick(wi).max(thick(wj)));
            if ini && inj {
                crossing = true;
            } else if gi.max(gj) < 1e-6 {
                met = true;
            } else if gi.max(gj) > tol {
                let g = gi.max(gj);
                if far.map_or(true, |f| g < f.0) {
                    far = Some((g, tol));
                }
            }
        }
    }
    if !same_floor {
        return Some("cmd.join.floors".into());
    }
    if let Some((g, tol)) = far {
        return Some(format!("cmd.join.far|{g:.2}|{tol:.2}"));
    }
    if met {
        return Some("cmd.join.met".into());
    }
    if crossing {
        return Some("cmd.join.cross".into());
    }
    parallel.then(|| "cmd.join.parallel".into())
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
        raw(r, "walls", id).unwrap()
    }
    fn typed(r: &Map<String, Value>) -> Project {
        Document::from_json(&Value::Object(r.clone()).to_string()).unwrap().project().unwrap().clone()
    }
    fn xy_of(v: &Value) -> (f64, f64) {
        (v["x"].as_f64().unwrap(), v["y"].as_f64().unwrap())
    }
    fn close(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6
    }
    fn commit_edit(r: &Map<String, Value>, p: &Project, e: Option<Edit>) -> Map<String, Value> {
        let ops = commit(r, p, &e.expect("Änderung"), &mut IdGen::new("s"));
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
        let pr = typed(&r);
        let e = trim(&pr, find_wall(&pr, "a").unwrap(), P::new(8.0, 0.0), false);
        let n = commit_edit(&r, &pr, e);
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
        r.get_mut("walls").unwrap().as_array_mut().unwrap()[0]["ifcGlobalId"] = "0AbcDEFghijKLMNOPQRSt1".into();
        let pr = typed(&r);
        let e = trim(&pr, find_wall(&pr, "a").unwrap(), P::new(4.5, 0.0), false);
        let n = commit_edit(&r, &pr, e);
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (3.0, 0.0)));
        let new = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        // [201] Das abgetrennte Stück ist eine neue Wand: GlobalId bleibt nur beim Original.
        assert_eq!(w_of(&n, "a")["ifcGlobalId"], "0AbcDEFghijKLMNOPQRSt1");
        assert!(new.get("ifcGlobalId").is_none());
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
        let pr = typed(&r);
        let n = commit_edit(&r, &pr, extend(&pr, find_wall(&pr, "a").unwrap(), P::new(3.9, 0.0), false));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (6.0, 0.0)));
        let n = commit_edit(&r, &pr, extend(&pr, find_wall(&pr, "a").unwrap(), P::new(3.9, 0.0), true));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.9, 0.0)));
        // Start verlängern: Öffnungen behalten ihre Weltlage.
        let r = project(vec![wall("a", (2.0, 0.0), (8.0, 0.0), None), wall("b", (0.0, -3.0), (0.0, 3.0), None)], vec![opening("o", "a", 1.0, 1.0)], vec![]);
        let pr = typed(&r);
        let n = commit_edit(&r, &pr, extend(&pr, find_wall(&pr, "a").unwrap(), P::new(2.1, 0.0), false));
        assert!(close(xy_of(&w_of(&n, "a")["start"]), (0.0, 0.0)));
        assert!((arr(n.get("openings"))[0]["position"].as_f64().unwrap() - 3.0).abs() < 1e-9);
    }

    #[test]
    fn bogenwand_trim_extend_split() {
        // Halbkreis (−5,0)→(5,0) um (0,0), Scheitel unten oder oben je nach Bulge; Gerade x = 0 schneidet.
        let arc = wall("a", (-5.0, 0.0), (5.0, 0.0), Some(1.0));
        let r = project(vec![arc, wall("b", (0.0, -8.0), (0.0, 8.0), None)], vec![opening("o", "a", 6.0, 1.0)], vec![]);
        let pr = typed(&r);
        let ax = Axis::of(find_wall(&typed(&r), "a").unwrap()).unwrap();
        let len = ax.len;
        assert!((len - 5.0 * PI).abs() < 1e-9);
        let mid = ax.point(len / 2.0, 0.0);
        assert!(mid.x.abs() < 1e-9);
        // Split an den Schnittpunkten: zwei Viertelbögen, die Öffnung (Mitte 6.5 < len/2 ≈ 7.85) bleibt auf dem ersten.
        let n = commit_edit(&r, &pr, split_at_intersections(&pr, find_wall(&pr, "a").unwrap()));
        let a = w_of(&n, "a");
        assert!(close(xy_of(&a["end"]), (mid.x, mid.y)));
        assert!((a["bulge"].as_f64().unwrap() - (PI / 8.0).tan()).abs() < 1e-9);
        let b2 = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        assert!(close(xy_of(&b2["end"]), (5.0, 0.0)));
        assert_eq!(arr(n.get("openings"))[0]["hostWallId"], "a");
        // Trim des zweiten Viertels: die Öffnung mit Mitte 6.5 < 7.85 bleibt.
        let p = ax.point(len * 0.75, 0.0);
        let n = commit_edit(&r, &pr, trim(&pr, find_wall(&pr, "a").unwrap(), p, false));
        let a = w_of(&n, "a");
        assert!(close(xy_of(&a["end"]), (mid.x, mid.y)));
        assert_eq!(arr(n.get("openings")).len(), 1);
        // Extend: Viertelbogen auf demselben Kreis bis zur Geraden x = 4 (Treffer (4, 3)).
        let q = wall("q", (-5.0, 0.0), (mid.x, mid.y), Some((PI / 8.0).tan()));
        let r = project(vec![q, wall("g", (4.0, -8.0), (4.0, 8.0), None)], vec![], vec![]);
        let pr = typed(&r);
        let n = commit_edit(&r, &pr, extend(&pr, find_wall(&pr, "q").unwrap(), P::new(mid.x, mid.y), false));
        let q = w_of(&n, "q");
        assert!(close(xy_of(&q["end"]), (4.0, 3.0)));
        let sweep = PI - 3.0_f64.atan2(4.0);
        assert!((q["bulge"].as_f64().unwrap() - (sweep / 4.0).tan()).abs() < 1e-9);
    }

    #[test]
    fn teilen_am_punkt_und_bruch() {
        let r = t_case();
        let pr = typed(&r);
        let n = commit_edit(&r, &pr, break_at(find_wall(&pr, "a").unwrap(), P::new(4.0, 0.1), P::new(4.0, 0.1)));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (4.0, 0.0)));
        let o2 = arr(n.get("openings")).iter().find(|o| o["id"] == "o2").unwrap();
        assert_eq!(o2["hostWallId"], "wall-s-1");
        assert!((o2["position"].as_f64().unwrap() - 3.0).abs() < 1e-9);
        // Bemassung: Ende (t = 1) liegt jetzt auf dem zweiten Stück bei t = 1.
        let g = &arr(n.get("drawings2d"))[0]["geom"];
        assert_eq!(g["refs"][2]["id"], "wall-s-1");
        assert_eq!(g["refs"][2]["t"], json!(1.0));
        // Bruch 2..3 entfernt das Stück dazwischen; o1 (1..2) bleibt am ersten Stück.
        let n = commit_edit(&r, &pr, break_at(find_wall(&pr, "a").unwrap(), P::new(2.5, 0.0), P::new(3.5, 0.0)));
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
        let n = apply(&r, join_ops(&r, &typed(&r), &["a".into(), "b".into()]));
        assert_eq!(arr(n.get("walls")).len(), 1);
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (10.0, 0.0)));
        let o = &arr(n.get("openings"))[0];
        assert_eq!(o["hostWallId"], "a");
        assert!((o["position"].as_f64().unwrap() - 5.0).abs() < 1e-9);
        let g = &arr(n.get("drawings2d"))[0]["geom"];
        assert_eq!(g["refs"][1]["id"], "a");
        assert!(close(xy_of(&g["pts"][1]), (10.0, 0.0)));
        // Gegenläufig, aber nicht kollinear: nicht verketten.
        let r2 = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (10.0, 0.5), (4.0, 0.5), None)], vec![], vec![]);
        assert!(join_ops(&r2, &typed(&r2), &["a".into(), "b".into()]).is_empty());
        // Zwei Viertelbögen desselben Kreises (um (0,0), unten herum) → Halbkreis.
        let t = (PI / 8.0).tan();
        let r3 = project(vec![wall("a", (-5.0, 0.0), (0.0, -5.0), Some(-t)), wall("b", (0.0, -5.0), (5.0, 0.0), Some(-t))], vec![], vec![]);
        let c = Axis::of(find_wall(&typed(&r3), "a").unwrap()).unwrap().arc.unwrap().center;
        assert!(close((c.x, c.y), (0.0, 0.0)));
        let n = apply(&r3, join_ops(&r3, &typed(&r3), &["a".into(), "b".into()]));
        let a = w_of(&n, "a");
        assert!(close(xy_of(&a["end"]), (5.0, 0.0)));
        assert!((a["bulge"].as_f64().unwrap() + 1.0).abs() < 1e-9);
    }

    #[test]
    fn verrunden_l_ecke_und_radius() {
        // a läuft nach rechts bis x = 4 (zu kurz), b senkrecht bei x = 6 über y = 0 hinaus.
        let r = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (6.0, 5.0), (6.0, -2.0), None)], vec![opening("o", "b", 1.0, 1.0)], vec![]);
        let pr = typed(&r);
        let (a, b) = (find_wall(&pr, "a").unwrap(), find_wall(&pr, "b").unwrap());
        let n = commit_edit(&r, &pr, fillet(a, P::new(2.0, 0.0), b, P::new(6.0, 3.0), 0.0));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (6.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["end"]), (6.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["start"]), (6.0, 5.0)));
        // Radius 1: Tangentenpunkte (5,0) und (6,1), Bogenwand dazwischen.
        let n = commit_edit(&r, &pr, fillet(a, P::new(2.0, 0.0), b, P::new(6.0, 3.0), 1.0));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["end"]), (6.0, 1.0)));
        let arcw = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        assert!(close(xy_of(&arcw["start"]), (5.0, 0.0)));
        assert!(close(xy_of(&arcw["end"]), (6.0, 1.0)));
        let ax = Axis::of(find_wall(&typed(&n), "wall-s-1").unwrap()).unwrap();
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
        let pr = typed(&r);
        let n = commit_edit(&r, &pr, offset(find_wall(&pr, "a").unwrap(), 1.5));
        let w = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        assert!(close(xy_of(&w["start"]), (0.0, 1.5)));
        assert!(close(xy_of(&w["end"]), (4.0, 1.5)));
        let n = commit_edit(&r, &pr, offset(find_wall(&pr, "c").unwrap(), 1.0));
        let w = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        let ax = Axis::of(find_wall(&typed(&n), "wall-s-1").unwrap()).unwrap();
        let c = Axis::of(find_wall(&typed(&r), "c").unwrap()).unwrap().arc.unwrap();
        assert!((ax.arc.unwrap().r - c.radius_at(1.0)).abs() < 1e-9);
        assert_eq!(w["bulge"].as_f64(), Some(1.0));
    }

    #[test]
    fn treffer_und_gesperrt() {
        let mut r = t_case();
        let pr = typed(&r);
        assert_eq!(pick_wall(&pr, "eg", P::new(8.0, 0.05)).map(|w| w.0.id.as_str()), Some("a"));
        r.get_mut("walls").unwrap().as_array_mut().unwrap()[0]["locked"] = json!(true);
        let pr = typed(&r);
        assert!(trim(&pr, find_wall(&pr, "a").unwrap(), P::new(8.0, 0.0), false).is_none());
        assert_ne!(pick_wall(&pr, "eg", P::new(8.0, 0.05)).map(|w| w.0.id.as_str()), Some("a"));
    }

    #[test]
    fn trim_an_2d_linie_und_achsraster() {
        let r = project(vec![wall("a", (0.0, 0.0), (10.0, 0.0), None)], vec![], vec![json!({"id": "l", "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": 3, "y": -1}, "b": {"x": 3, "y": 1}}})]);
        let pr = typed(&r);
        let n = commit_edit(&r, &pr, trim(&pr, find_wall(&pr, "a").unwrap(), P::new(1.0, 0.0), false));
        assert!(close(xy_of(&w_of(&n, "a")["start"]), (3.0, 0.0)));
    }

    /// Halbkreis-Bogenwand um (0,0), R 5, von (−5,0) über (0,5) nach (5,0); Gerade b bei x = 3 nach oben.
    fn arc_line_case() -> Map<String, Value> {
        project(vec![wall("a", (-5.0, 0.0), (5.0, 0.0), Some(1.0)), wall("b", (3.0, -2.0), (3.0, 8.0), None)], vec![opening("o", "a", 1.0, 1.0)], vec![])
    }

    #[test]
    fn verrunden_mit_radius_bogen_und_gerade() {
        let r = arc_line_case();
        let pr = typed(&r);
        let (a, b) = (find_wall(&pr, "a").unwrap(), find_wall(&pr, "b").unwrap());
        // Klick auf a links oben (Teil bis zum Schnitt (3,4) bleibt), auf b oberhalb des Schnitts.
        let n = commit_edit(&r, &pr, fillet(a, P::new(-4.0, 3.0), b, P::new(3.0, 7.0), 1.0));
        // Verrundungskreis: ausserhalb des Kreises (Abstand 6) und links von b (x = 2) → Mitte (2, √32).
        let c = (2.0, 32f64.sqrt());
        let ta = (5.0 * c.0 / 6.0, 5.0 * c.1 / 6.0);
        let tb = (3.0, c.1);
        let wa = w_of(&n, "a");
        assert!(close(xy_of(&wa["start"]), (-5.0, 0.0)));
        assert!(close(xy_of(&wa["end"]), ta), "{:?}", wa["end"]);
        assert!(wa["bulge"].as_f64().unwrap() > 0.0, "Bogenwand bleibt auf demselben Kreis");
        assert!(close(xy_of(&w_of(&n, "b")["start"]), tb));
        let f = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").expect("Bogenwand dazwischen");
        assert!(close(xy_of(&f["start"]), ta) && close(xy_of(&f["end"]), tb));
        let np = typed(&n);
        let ax = Axis::of(find_wall(&np, "wall-s-1").unwrap()).unwrap();
        let fa = ax.arc.expect("Bogen");
        assert!(close((fa.center.x, fa.center.y), c) && (fa.r - 1.0).abs() < 1e-9);
        let m = ax.point(ax.len / 2.0, 0.0);
        assert!(dist(m, P::new(3.0, 4.0)) < dist(P::new(2.0 * c.0 - m.x, 2.0 * c.1 - m.y), P::new(3.0, 4.0)), "Bogen auf der Seite der Ecke");
        // Tangential: Richtung der Bogenwand am Start = Richtung von a am Ende.
        let axa = Axis::of(find_wall(&np, "a").unwrap()).unwrap();
        let (t1, t2) = (axa.arc.unwrap().tangent(axa.len), fa.tangent(0.0));
        assert!((t1.x - t2.x).abs() < 1e-6 && (t1.y - t2.y).abs() < 1e-6);
        // Öffnung (Lage ab Start, Start unverändert) bleibt.
        assert_eq!(arr(n.get("openings"))[0]["position"], json!(1.0));
        assert_eq!(arr(n.get("openings"))[0]["hostWallId"], "a");
    }

    #[test]
    fn verrunden_mit_radius_zwei_bogenwaende() {
        // Zwei Halbkreise R 5 um (0,0) und (8,0), oben herum; Schnitt bei (4,3).
        let r = project(vec![wall("a", (-5.0, 0.0), (5.0, 0.0), Some(1.0)), wall("b", (3.0, 0.0), (13.0, 0.0), Some(1.0))], vec![], vec![]);
        let pr = typed(&r);
        let (a, b) = (find_wall(&pr, "a").unwrap(), find_wall(&pr, "b").unwrap());
        let e = fillet(a, P::new(-3.0, 4.0), b, P::new(11.0, 4.0), 1.0).expect("Verrundung");
        let n = commit_edit(&r, &pr, Some(e));
        // Verrundungskreis aussen an beiden: Mitte (4, √(36−16)).
        let c = (4.0, 20f64.sqrt());
        let np = typed(&n);
        let fa = Axis::of(find_wall(&np, "wall-s-1").unwrap()).unwrap().arc.unwrap();
        assert!(close((fa.center.x, fa.center.y), c), "{:?}", fa.center);
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.0 * c.0 / 6.0, 5.0 * c.1 / 6.0)));
        assert!(close(xy_of(&w_of(&n, "b")["start"]), (8.0 + 5.0 * (c.0 - 8.0) / 6.0, 5.0 * c.1 / 6.0)));
    }

    #[test]
    fn fasen_gerade_und_bogen() {
        let r = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (6.0, 5.0), (6.0, -2.0), None)], vec![opening("o", "b", 1.0, 1.0)], vec![]);
        let pr = typed(&r);
        let (a, b) = (find_wall(&pr, "a").unwrap(), find_wall(&pr, "b").unwrap());
        let n = commit_edit(&r, &pr, chamfer(a, P::new(2.0, 0.0), b, P::new(6.0, 3.0), 1.0));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["end"]), (6.0, 1.0)));
        let f = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").expect("Fasenwand");
        assert!(close(xy_of(&f["start"]), (5.0, 0.0)) && close(xy_of(&f["end"]), (6.0, 1.0)));
        assert!(f.get("bulge").is_none());
        assert_eq!(arr(n.get("openings"))[0]["position"], json!(1.0));
        // Distanz 0 = L-Ecke wie Verrunden ohne Radius.
        let n = commit_edit(&r, &pr, chamfer(a, P::new(2.0, 0.0), b, P::new(6.0, 3.0), 0.0));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (6.0, 0.0)));
        assert_eq!(arr(n.get("walls")).len(), 2);
        // Bogen: Distanz als Bogenlänge ab dem Schnittpunkt (3,4).
        let r = arc_line_case();
        let pr = typed(&r);
        let (a, b) = (find_wall(&pr, "a").unwrap(), find_wall(&pr, "b").unwrap());
        let n = commit_edit(&r, &pr, chamfer(a, P::new(-4.0, 3.0), b, P::new(3.0, 7.0), 1.0));
        let ang = 4f64.atan2(3.0) + 1.0 / 5.0;
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.0 * ang.cos(), 5.0 * ang.sin())));
        assert!(close(xy_of(&w_of(&n, "b")["start"]), (3.0, 5.0)));
        let f = arr(n.get("walls")).iter().find(|w| w["id"] == "wall-s-1").unwrap();
        assert!(f.get("bulge").is_none(), "Fase ist gerade, auch von einer Bogenwand");
        assert_eq!(arr(n.get("openings"))[0]["hostWallId"], "a");
    }

    #[test]
    fn verketten_gegenlaeufig_kehrt_oeffnungen() {
        let mut door = opening("d", "b", 1.0, 1.0);
        door["kind"] = json!("door");
        door["swing"] = json!("left");
        door["hinge"] = json!("start");
        let r = project(
            vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (10.0, 0.0), (4.0, 0.0), None)],
            vec![door],
            vec![dim("m", json!([{"id": "b", "feature": "wall", "t": 0.0}, {"id": "a", "feature": "wall", "t": 0.0}]), json!([{"x": 10, "y": 0}, {"x": 0, "y": 0}]))],
        );
        let n = apply(&r, join_ops(&r, &typed(&r), &["a".into(), "b".into()]));
        assert_eq!(arr(n.get("walls")).len(), 1);
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (10.0, 0.0)));
        // Tür lag bei x 8..9 (ab (10,0) rückwärts 1..2) → Lage 8 auf a, Aufschlag/Scharnier gekehrt.
        let o = &arr(n.get("openings"))[0];
        assert_eq!(o["hostWallId"], "a");
        assert!((o["position"].as_f64().unwrap() - 8.0).abs() < 1e-9);
        assert_eq!((&o["swing"], &o["hinge"]), (&json!("right"), &json!("end")));
        // Bemassung auf b's Start (10,0) zeigt jetzt auf a's Ende.
        let g = &arr(n.get("drawings2d"))[0]["geom"];
        assert_eq!(g["refs"][0]["id"], "a");
        assert!((g["refs"][0]["t"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        assert!(close(xy_of(&g["pts"][0]), (10.0, 0.0)));
        // Bogen: zweiter Viertelbogen gegenläufig (gleicher Kreis, umgekehrter Drehsinn).
        let t = (PI / 8.0).tan();
        let r3 = project(vec![wall("a", (-5.0, 0.0), (0.0, -5.0), Some(-t)), wall("b", (5.0, 0.0), (0.0, -5.0), Some(t))], vec![], vec![]);
        let n = apply(&r3, join_ops(&r3, &typed(&r3), &["a".into(), "b".into()]));
        assert_eq!(arr(n.get("walls")).len(), 1);
        let a = w_of(&n, "a");
        assert!(close(xy_of(&a["end"]), (5.0, 0.0)));
        assert!((a["bulge"].as_f64().unwrap() + 1.0).abs() < 1e-9);
    }

    #[test]
    fn verbinden_l_ecke_mit_luecke_und_ueberstand() {
        // a endet 0.3 vor der Ecke, b beginnt 0.3 daneben; Fenster in a bei 1..2 und in b (ab Start).
        let r = project(
            vec![wall("a", (0.0, 0.0), (5.7, 0.0), None), wall("b", (6.0, 0.3), (6.0, 4.4), None)],
            vec![opening("o1", "a", 1.0, 1.0), opening("o2", "b", 1.0, 1.0)],
            vec![],
        );
        let n = apply(&r, connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (6.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["start"]), (6.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "a")["start"]), (0.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["end"]), (6.0, 4.4)));
        // Öffnungen bleiben im Plan stehen: o2 lag bei y = 1.3, jetzt Position 1.3 ab neuem Start.
        let o2 = arr(n.get("openings")).iter().find(|o| o["id"] == "o2").unwrap();
        assert!((o2["position"].as_f64().unwrap() - 1.3).abs() < 1e-9);
        let o1 = arr(n.get("openings")).iter().find(|o| o["id"] == "o1").unwrap();
        assert!((o1["position"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        // Überstand: a ragt über b hinaus → gekürzt.
        let r = project(vec![wall("a", (0.0, 0.0), (6.4, 0.0), None), wall("b", (6.0, 0.0), (6.0, 4.0), None)], vec![], vec![]);
        let n = apply(&r, connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (6.0, 0.0)));
        // Schon sauber oder zu weit weg: nichts.
        let r = project(vec![wall("a", (0.0, 0.0), (6.0, 0.0), None), wall("b", (6.0, 0.0), (6.0, 4.0), None)], vec![], vec![]);
        assert!(connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]).is_empty());
        let r = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (6.0, 0.0), (6.0, 4.0), None)], vec![], vec![]);
        assert!(connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]).is_empty());
    }

    #[test]
    fn verbinden_t_stoss_und_kollinear_unberuehrt() {
        // a endet 0.3 vor der Querwand b (die weiter durchläuft): nur a rückt, b bleibt.
        let r = project(vec![wall("a", (0.0, 0.0), (5.7, 0.0), None), wall("b", (6.0, -3.0), (6.0, 3.0), None)], vec![opening("o", "a", 1.0, 1.0)], vec![]);
        let n = apply(&r, connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.9, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["start"]), (6.0, -3.0)));
        assert!(close(xy_of(&w_of(&n, "b")["end"]), (6.0, 3.0)));
        assert_eq!(arr(n.get("openings")).len(), 1);
        // Kollinear und parallel versetzt: connect_ops fasst nichts an.
        let r = project(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (4.2, 0.0), (8.0, 0.0), None), wall("c", (4.0, 0.5), (8.0, 0.5), None)], vec![], vec![]);
        assert!(connect_ops(&r, &typed(&r), &["a".into(), "b".into(), "c".into()], &[]).is_empty());
    }

    #[test]
    fn verbinden_mehr_als_zwei_waende_und_ein_undo_schritt() {
        // U-Form mit Lücken: a–b und b–c.
        let r = project(
            vec![wall("a", (0.0, 0.0), (5.8, 0.0), None), wall("b", (6.0, 0.2), (6.0, 3.8), None), wall("c", (6.0, 4.0), (0.2, 4.0), None)],
            vec![],
            vec![],
        );
        let ops = connect_ops(&r, &typed(&r), &["a".into(), "b".into(), "c".into()], &[]);
        let n = apply(&r, ops);
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (6.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["start"]), (6.0, 0.0)));
        assert!(close(xy_of(&w_of(&n, "b")["end"]), (6.0, 4.0)));
        assert!(close(xy_of(&w_of(&n, "c")["start"]), (6.0, 4.0)));
    }

    #[test]
    fn verbinden_t_stoss_endet_an_der_zugewandten_flaeche() {
        // Wandtyp 0.2 m, Mitte: Fläche der Querwand b bei x = 5.9 bzw. 6.1.
        let r = project(vec![wall("a", (0.0, 0.0), (5.7, 0.0), None), wall("b", (6.0, -3.0), (6.0, 3.0), None)], vec![], vec![]);
        let n = apply(&r, connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.9, 0.0)));
        // Überstand durch die Querwand hindurch: gekürzt auf die Fläche.
        let r = project(vec![wall("a", (0.0, 0.0), (6.4, 0.0), None), wall("b", (6.0, -3.0), (6.0, 3.0), None)], vec![], vec![]);
        let n = apply(&r, connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.9, 0.0)));
        // Abzweig von der anderen Seite (Start am Durchgang): Fläche x = 6.1.
        let r = project(vec![wall("a", (6.3, 0.0), (9.0, 0.0), None), wall("b", (6.0, -3.0), (6.0, 3.0), None)], vec![], vec![]);
        let n = apply(&r, connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]));
        assert!(close(xy_of(&w_of(&n, "a")["start"]), (6.1, 0.0)));
        // Referenzlinie links: Band x = 5.8 … 6.0.
        let mut b = wall("b", (6.0, -3.0), (6.0, 3.0), None);
        b["referenceLine"] = json!("left");
        let r = project(vec![wall("a", (0.0, 0.0), (5.5, 0.0), None), b], vec![], vec![]);
        let n = apply(&r, connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]));
        assert!(close(xy_of(&w_of(&n, "a")["end"]), (5.8, 0.0)));
    }

    #[test]
    fn verbinden_t_stoss_passt_zu_den_wand_joins() {
        use crate::joins::{compute_joins, JoinLayer, JoinWall, Reference};
        use kernel2d::Vec2;
        let r = project(vec![wall("a", (0.0, 0.0), (5.7, 0.0), None), wall("b", (6.0, -3.0), (6.0, 3.0), None)], vec![], vec![]);
        let n = apply(&r, connect_ops(&r, &typed(&r), &["a".into(), "b".into()], &[]));
        let jw = |id: &str| {
            let w = w_of(&n, id);
            let (s, e) = (xy_of(&w["start"]), xy_of(&w["end"]));
            JoinWall {
                start: Vec2 { x: s.0, y: s.1 },
                end: Vec2 { x: e.0, y: e.1 },
                reference: Reference::Center,
                layers: Some(vec![JoinLayer { thickness: 0.2, component: Some(0), priority: 1.0 }]),
                bulge: None,
            }
        };
        let cuts = compute_joins(&[jw("a"), jw("b")]).unwrap();
        // a bekommt einen Schnitt an der Fläche x = 5.9 (senkrecht zu a), b bleibt durchgehend.
        let cut = cuts[0].end_cut.expect("T-Anschluss: Schnitt am Ende von a");
        assert!((cut.point.x - 5.9).abs() < 1e-9 && cut.dir.x.abs() < 1e-9);
        assert!(cuts[1].start_cut.is_none() && cuts[1].end_cut.is_none());
    }

    #[test]
    fn verbinden_hinweis_nennt_den_grund() {
        let ids = ["a".to_string(), "b".to_string()];
        let hint = |ws: Vec<Value>| {
            let r = project(ws, vec![], vec![]);
            join_hint(&typed(&r), &ids)
        };
        // Zu weit auseinander: Abstand 1.7 m zur Ecke, Toleranz 0.5 m.
        assert_eq!(hint(vec![wall("a", (0.0, 0.0), (4.3, 0.0), None), wall("b", (6.0, 0.0), (6.0, 4.0), None)]).as_deref(), Some("cmd.join.far|1.70|0.50"));
        // Parallel (versetzt).
        assert_eq!(hint(vec![wall("a", (0.0, 0.0), (4.0, 0.0), None), wall("b", (0.0, 1.0), (4.0, 1.0), None)]).as_deref(), Some("cmd.join.parallel"));
        // Treffen sich schon.
        assert_eq!(hint(vec![wall("a", (0.0, 0.0), (6.0, 0.0), None), wall("b", (6.0, 0.0), (6.0, 4.0), None)]).as_deref(), Some("cmd.join.met"));
        // Kreuzung.
        assert_eq!(hint(vec![wall("a", (0.0, 0.0), (6.0, 0.0), None), wall("b", (3.0, -2.0), (3.0, 2.0), None)]).as_deref(), Some("cmd.join.cross"));
        // Bogenwand.
        assert_eq!(hint(vec![wall("a", (0.0, 0.0), (6.0, 0.0), Some(0.5)), wall("b", (6.0, 0.0), (6.0, 4.0), None)]).as_deref(), Some("cmd.join.arc"));
        // Eine Wand allein: kein besonderer Grund.
        let r = project(vec![wall("a", (0.0, 0.0), (6.0, 0.0), None)], vec![], vec![]);
        assert_eq!(join_hint(&typed(&r), &["a".to_string()]), None);
    }
}
