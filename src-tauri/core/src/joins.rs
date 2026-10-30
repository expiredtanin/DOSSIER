//! Wand-Verschneidung (Gehrung, T-Stoss, Kreuzung): berechnet je Wand die optionalen
//! Schnittlinien an Start- und Endpunkt, materialbewusste Pro-Schicht-Cuts am T-Stoss und die
//! Nah-Putz-Aussparungen der Durchgangswand. Portiert aus `src/model/joins.ts`; gesammelt wird im
//! Kern (`model3d.rs` für 3D, `plan/walls.rs` für den Grundriss).
//!
//! Behandelt: L-Ecken (zwei Wandenden im Knoten), T-Knoten (drei Enden, zwei kollinear),
//! Mittelspannen-T-Stösse (freies Ende trifft auf die Seite einer anderen Wand) und
//! „+"-Kreuzungen (zwei kollineare Enden auf der Achse einer durchlaufenden Wand). Echte
//! Stern-Knoten (≥ 4 Enden ohne Durchgang) bleiben rechtwinklig.
//!
//! Die Rechenschritte folgen der TS-Fassung Operation für Operation (gleiche Term-Reihenfolge),
//! damit das Ergebnis bitgleich bleibt.

use crate::wall_arc::{curve_hits, nearest, Curve, WallArc};
use kernel2d::{add, dot, left_normal, line_intersect, scale, sub, Vec2};
use std::collections::HashMap;

/// Referenzlinie einer Wand (`Wall.referenceLine` / `referenceOffset`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reference {
    Center,
    Left,
    Right,
    /// Freier Versatz (Meter), übersteuert die benannte Referenzlinie.
    Offset(f64),
}

/// Querversatz der Wandachse gegenüber der Wandmitte (`wallReferenceOffset` in `model/wall.ts`).
pub fn reference_offset(r: Reference, total_thickness: f64) -> f64 {
    let half = total_thickness / 2.0;
    match r {
        // Math.max(-half, Math.min(half, v)) — Reihenfolge wie TS.
        Reference::Offset(v) => (-half).max(half.min(v)),
        Reference::Left => half,
        Reference::Right => -half,
        Reference::Center => 0.0,
    }
}

/// Eine Schicht des Wandtyps: Dicke, Bauteil-Identität (`None` = Bauteil unbekannt) und
/// Verschneidungs-Rang (`Component.joinPriority`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JoinLayer {
    pub thickness: f64,
    pub component: Option<u32>,
    pub priority: f64,
}

/// Eine Wand für die Verschneidung. `layers = None`: Wandtyp unbekannt.
#[derive(Clone, Debug, PartialEq)]
pub struct JoinWall {
    pub start: Vec2,
    pub end: Vec2,
    pub reference: Reference,
    pub layers: Option<Vec<JoinLayer>>,
    /// Bogenwand ([T2], Modell-Bulge); `None` = gerade.
    pub bulge: Option<f64>,
}

/// Unendliche Gerade (Stützpunkt + Richtung, nicht normiert).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line {
    pub point: Vec2,
    pub dir: Vec2,
}

/// Pro-Schicht-Cuts eines materialbewussten T-Stosses (`LayerCuts` in TS).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayerCuts {
    pub start: Vec<Option<Line>>,
    pub end: Vec<Option<Line>>,
    pub start_side: Vec<Option<Line>>,
    pub end_side: Vec<Option<Line>>,
}

/// Aussparung der Nah-Putz-Zone einer Durchgangswand: ein Parallelogramm im Achsmass der Wand.
/// `from`/`to` gelten auf der Fläche (`off_a`), `from_b`/`to_b` auf der Rückgrat-Nahfläche
/// (`off_b`); bei schrägem Abzweig sind die Seiten schräg (Kanten des Abzweig-Kerns), bei
/// rechtwinkligem gilt `from_b = from`, `to_b = to`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpanCutout {
    pub from: f64,
    pub to: f64,
    pub off_a: f64,
    pub off_b: f64,
    pub from_b: f64,
    pub to_b: f64,
}

impl SpanCutout {
    /// Achsmass der beiden schrägen Seiten im Querversatz `off` (linear zwischen `off_a`/`off_b`).
    pub fn at(&self, off: f64) -> (f64, f64) {
        let d = self.off_b - self.off_a;
        let t = if d.abs() < 1e-12 { 0.0 } else { (off - self.off_a) / d };
        (self.from + (self.from_b - self.from) * t, self.to + (self.to_b - self.to) * t)
    }
}

/// Schnittlinien einer Wand (`WallCuts` in TS).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WallCuts {
    pub start_cut: Option<Line>,
    pub end_cut: Option<Line>,
    pub layer_cuts: Option<LayerCuts>,
    pub span_cutouts: Vec<SpanCutout>,
}

/// Eine benötigte Angabe fehlt: Wandtyp oder Bauteil der Wand mit diesem Index ist unbekannt
/// (TS wirft dann denselben Fehler wie früher `getWallType`/`getComponent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinError {
    UnknownWallType(usize),
    UnknownComponent(usize),
}

/// Verschneidungs-Entscheidung zweier Bauteile am Stoss (`resolveJoinPriority` in TS).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinResolution {
    /// Gleiche Priorität und gleiche Komponente: verschmelzen, kein Cut.
    Merge,
    /// `b` gewinnt, `a` wird getrimmt.
    TrimA,
    /// `a` gewinnt, `b` wird getrimmt.
    TrimB,
    /// Gleiche Priorität, verschiedene Komponente: keine Rangfolge (getrimmt wie bisher).
    Coexist,
}

pub fn resolve_join_priority(prio_a: f64, prio_b: f64, same_component: bool) -> JoinResolution {
    if prio_a == prio_b {
        if same_component {
            JoinResolution::Merge
        } else {
            JoinResolution::Coexist
        }
    } else if prio_a > prio_b {
        JoinResolution::TrimB
    } else {
        JoinResolution::TrimA
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum End {
    Start,
    End,
}

#[derive(Clone, Copy, Debug)]
struct WallEnd {
    wall: usize,
    end: End,
}

type R<T> = Result<T, JoinError>;

fn layers_of(walls: &[JoinWall], i: usize) -> R<&[JoinLayer]> {
    walls[i].layers.as_deref().ok_or(JoinError::UnknownWallType(i))
}

/// `wallTypeThickness`: Summe der Schichtdicken (Reihenfolge wie `reduce`).
fn thickness(walls: &[JoinWall], i: usize) -> R<f64> {
    Ok(layers_of(walls, i)?.iter().fold(0.0, |s, l| s + l.thickness))
}

fn component(i: usize, l: &JoinLayer) -> R<u32> {
    l.component.ok_or(JoinError::UnknownComponent(i))
}

/// `Math.hypot(x, y)` wie V8 (Skalierung mit dem Maximum, kompensierte Summe) — `f64::hypot`
/// rundet im letzten Bit teils anders, das Ergebnis soll aber bitgleich zur TS-Fassung bleiben.
pub fn js_hypot(x: f64, y: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs());
    if ax.is_infinite() || ay.is_infinite() {
        return f64::INFINITY;
    }
    if ax.is_nan() || ay.is_nan() {
        return f64::NAN;
    }
    let max = ax.max(ay);
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut comp = 0.0;
    for v in [ax, ay] {
        let n = v / max;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    sum.sqrt() * max
}

/// Vektorlänge wie `len` in `model/geometry.ts`.
pub fn len(a: Vec2) -> f64 {
    js_hypot(a.x, a.y)
}

/// Normieren wie `normalize` in `model/geometry.ts` (Länge 0 → Divisor 1).
pub fn normalize(a: Vec2) -> Vec2 {
    let l = len(a);
    let l = if l == 0.0 { 1.0 } else { l };
    Vec2::new(a.x / l, a.y / l)
}

/// `Math.round` (halbe Werte nach +∞).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// Knoten-Schlüssel wie `roundKey` in TS (Raster 1e-4; −0 = 0; alle NaN gleich).
fn round_key(p: Vec2) -> (u64, u64) {
    let r = |v: f64| {
        let q = js_round(v * 1e4) / 1e4;
        if q.is_nan() {
            f64::NAN.to_bits()
        } else if q == 0.0 {
            0
        } else {
            q.to_bits()
        }
    };
    (r(p.x), r(p.y))
}

fn point_of(w: &JoinWall, e: End) -> Vec2 {
    match e {
        End::Start => w.start,
        End::End => w.end,
    }
}

/// Achsrichtung start→end, normiert.
fn dir_of(w: &JoinWall) -> Vec2 {
    normalize(sub(w.end, w.start))
}

// ── Bogenwände ([T2]) ───────────────────────────────────────────────────────
//
// Gerade Wände rechnen unverändert (bitgleich); sobald eine beteiligte Wand ein Bogen ist, werden
// die Flächen als Versatzkurven (Gerade/Kreis) geschnitten und die Schnittlinie als Gerade durch
// die exakten Flächen-Treffer gelegt (Aussen- und Innenecke exakt).

fn arc_of(w: &JoinWall) -> Option<WallArc> {
    WallArc::of(w.start, w.end, w.bulge)
}

fn is_arc(w: &JoinWall) -> bool {
    arc_of(w).is_some()
}

/// Laufrichtung (start→end) am Ende `e`: Tangente bei Bögen.
fn dir_at(w: &JoinWall, e: End) -> Vec2 {
    match arc_of(w) {
        None => dir_of(w),
        Some(a) => match e {
            End::Start => a.tangent(0.0),
            End::End => a.tangent(a.length()),
        },
    }
}

/// Versatzkurve `off` (links der Laufrichtung) einer Wand.
fn offset_curve(w: &JoinWall, off: f64) -> Curve {
    match arc_of(w) {
        None => {
            let u = dir_of(w);
            Curve::Line(Line { point: add(w.start, scale(left_normal(u), off)), dir: u })
        }
        Some(a) => Curve::Circle(a.center, a.radius_at(off)),
    }
}

fn hit_near(a: &Curve, b: &Curve, near: Vec2) -> Option<Vec2> {
    nearest(curve_hits(a, b), near)
}

/// (Achsmass, Querversatz) eines Punkts im Rahmen der Wand.
fn local_of(w: &JoinWall, p: Vec2) -> (f64, f64) {
    match arc_of(w) {
        None => {
            let u = dir_of(w);
            (dot(sub(p, w.start), u), dot(sub(p, w.start), left_normal(u)))
        }
        Some(a) => a.local(p),
    }
}

/// Gerade durch die Treffer der beiden Abzweig-Flächen (`bi`) mit der Versatzkurve `off` der
/// Durchgangswand `ti`, nahe `near`; `None`, wenn eine Fläche sie nicht trifft.
fn chord_cut(walls: &[JoinWall], bi: usize, ti: usize, off: f64, near: Vec2) -> R<Option<Line>> {
    let tb = thickness(walls, bi)?;
    let ob = reference_offset(walls[bi].reference, tb);
    let face = offset_curve(&walls[ti], off);
    let h1 = hit_near(&offset_curve(&walls[bi], ob + tb / 2.0), &face, near);
    let h2 = hit_near(&offset_curve(&walls[bi], ob - tb / 2.0), &face, near);
    Ok(match (h1, h2) {
        (Some(a), Some(b)) if len(sub(b, a)) > 1e-9 => Some(Line { point: a, dir: sub(b, a) }),
        _ => None,
    })
}

fn set_cut(result: &mut [WallCuts], we: WallEnd, cut: Line) {
    let c = &mut result[we.wall];
    match we.end {
        End::Start => c.start_cut = Some(cut),
        End::End => c.end_cut = Some(cut),
    }
}

/// Berechnet für jede Wand (Index = Eingabe-Reihenfolge) die Gehrungs-/Anschluss-Schnittlinien.
/// `walls` ist die bereits gefilterte Wandmenge (z. B. ein Geschoss).
pub fn compute_joins(walls: &[JoinWall]) -> Result<Vec<WallCuts>, JoinError> {
    let mut result = vec![WallCuts::default(); walls.len()];

    // Knotenkarte in Einfüge-Reihenfolge: gerundeter Endpunkt → dort endende Wandenden.
    let mut index: HashMap<(u64, u64), usize> = HashMap::new();
    let mut junctions: Vec<Vec<WallEnd>> = Vec::new();
    let mut push = |p: Vec2, we: WallEnd| {
        let key = round_key(p);
        match index.get(&key) {
            Some(&k) => junctions[k].push(we),
            None => {
                index.insert(key, junctions.len());
                junctions.push(vec![we]);
            }
        }
    };
    for (i, w) in walls.iter().enumerate() {
        push(w.start, WallEnd { wall: i, end: End::Start });
        push(w.end, WallEnd { wall: i, end: End::End });
    }

    for ends in &junctions {
        match ends.len() {
            2 => {
                if let Some(cut) = miter_line(walls, ends[0].wall, ends[0].end, ends[1].wall)? {
                    set_cut(&mut result, ends[0], cut);
                    set_cut(&mut result, ends[1], cut);
                }
            }
            3 => apply_t_junction(walls, ends, &mut result)?,
            // Freies Ende (Fall 2 unten) bzw. echter Stern-Knoten (bleibt rechtwinklig).
            _ => {}
        }
    }

    // Fall 2: jedes noch ungeschnittene Ende gegen die Mittelspanne aller anderen Wände prüfen
    // (Mittelspannen-T und „+"-Kreuzung). Bereits geschnittene Enden bleiben unangetastet.
    for ends in &junctions {
        for &we in ends {
            let c = &result[we.wall];
            let cut = match we.end {
                End::Start => c.start_cut,
                End::End => c.end_cut,
            };
            if cut.is_none() {
                apply_mid_span_tee(walls, we, &mut result)?;
            }
        }
    }
    Ok(result)
}

/// Gemeinsame Gehrungslinie zweier Wände A, B im Knoten (orientierungsbasierte Flächen-Paarung:
/// Aussen mit Aussen, Innen mit Innen — robust auch bei spitzen Winkeln). `None` bei kollinearen
/// Achsen.
fn miter_line(walls: &[JoinWall], ai: usize, a_end: End, bi: usize) -> R<Option<Line>> {
    if is_arc(&walls[ai]) || is_arc(&walls[bi]) {
        return miter_line_arc(walls, ai, a_end, bi);
    }
    let (a, b) = (&walls[ai], &walls[bi]);
    let j = point_of(a, a_end);
    let t_a = thickness(walls, ai)?;
    let t_b = thickness(walls, bi)?;
    let u_a = dir_of(a);
    let u_b = dir_of(b);
    let n_a = left_normal(u_a);
    let n_b = left_normal(u_b);
    let off_a = reference_offset(a.reference, t_a);
    let off_b = reference_offset(b.reference, t_b);

    let p_la = add(j, scale(n_a, off_a + t_a / 2.0));
    let p_ra = add(j, scale(n_a, off_a - t_a / 2.0));
    let p_lb = add(j, scale(n_b, off_b + t_b / 2.0));
    let p_rb = add(j, scale(n_b, off_b - t_b / 2.0));

    let d_a = if a_end == End::Start { u_a } else { scale(u_a, -1.0) };
    let b_at_start = len(sub(b.start, j)) <= len(sub(b.end, j));
    let d_b = if b_at_start { u_b } else { scale(u_b, -1.0) };

    let b_outer = if dot(n_b, d_a) < 0.0 { p_lb } else { p_rb };
    let b_inner = if dot(n_b, d_a) < 0.0 { p_rb } else { p_lb };
    let a_left_is_outer = dot(n_a, d_b) < 0.0;
    let b_for_left = if a_left_is_outer { b_outer } else { b_inner };
    let b_for_right = if a_left_is_outer { b_inner } else { b_outer };

    let (Some(c1), Some(c2)) = (line_intersect(p_la, u_a, b_for_left, u_b), line_intersect(p_ra, u_a, b_for_right, u_b)) else {
        return Ok(None);
    };
    let dir = sub(c2, c1);
    if len(dir) < 1e-9 {
        return Ok(None);
    }
    Ok(Some(Line { point: c1, dir }))
}

/// [`miter_line`] mit Bogenwand: Tangenten für die Flächen-Paarung, Flächen als Versatzkurven.
/// Bei tangentialem Übergang (Bogen setzt sich fort) eine radiale Stossfuge.
fn miter_line_arc(walls: &[JoinWall], ai: usize, a_end: End, bi: usize) -> R<Option<Line>> {
    let (a, b) = (&walls[ai], &walls[bi]);
    let j = point_of(a, a_end);
    let t_a = thickness(walls, ai)?;
    let t_b = thickness(walls, bi)?;
    let b_at_start = len(sub(b.start, j)) <= len(sub(b.end, j));
    let b_end = if b_at_start { End::Start } else { End::End };
    let u_a = dir_at(a, a_end);
    let u_b = dir_at(b, b_end);
    let n_a = left_normal(u_a);
    let n_b = left_normal(u_b);
    let off_a = reference_offset(a.reference, t_a);
    let off_b = reference_offset(b.reference, t_b);
    let d_a = if a_end == End::Start { u_a } else { scale(u_a, -1.0) };
    let d_b = if b_at_start { u_b } else { scale(u_b, -1.0) };
    if kernel2d::cross(u_a, u_b).abs() < 1e-6 {
        // Tangentialer Übergang: rechtwinklig (radial) stossen, als Schnitt markiert (keine Fuge).
        return Ok((dot(d_a, d_b) < 0.0).then_some(Line { point: j, dir: n_a }));
    }
    let (lb, rb) = (off_b + t_b / 2.0, off_b - t_b / 2.0);
    let (b_outer, b_inner) = if dot(n_b, d_a) < 0.0 { (lb, rb) } else { (rb, lb) };
    let a_left_is_outer = dot(n_a, d_b) < 0.0;
    let (b_for_left, b_for_right) = if a_left_is_outer { (b_outer, b_inner) } else { (b_inner, b_outer) };
    // Treffer nächst der Tangenten-Schätzung (sonst nächst dem Knoten).
    let corner = |oa: f64, ob: f64| -> Option<Vec2> {
        let guess = line_intersect(add(j, scale(n_a, oa)), u_a, add(j, scale(n_b, ob)), u_b).filter(|g| len(sub(*g, j)) < 10.0 * (t_a + t_b + 1.0)).unwrap_or(j);
        hit_near(&offset_curve(a, oa), &offset_curve(b, ob), guess)
    };
    let (Some(c1), Some(c2)) = (corner(off_a + t_a / 2.0, b_for_left), corner(off_a - t_a / 2.0, b_for_right)) else {
        return Ok(None);
    };
    let dir = sub(c2, c1);
    if len(dir) < 1e-9 {
        return Ok(None);
    }
    Ok(Some(Line { point: c1, dir }))
}

/// Fall 1 — T-Knoten: drei Enden im Knoten, zwei davon kollinear (Durchgang). Der Abzweig bekommt
/// einen Schnitt an der ihm zugewandten Fläche der Durchgangswand; ohne kollineares Paar bleibt
/// der Knoten rechtwinklig.
fn apply_t_junction(walls: &[JoinWall], ends: &[WallEnd], result: &mut [WallCuts]) -> R<()> {
    let arcs = ends.iter().any(|e| is_arc(&walls[e.wall]));
    let dirs: Vec<Vec2> = ends.iter().map(|e| if arcs { dir_at(&walls[e.wall], e.end) } else { dir_of(&walls[e.wall]) }).collect();
    let mut through: Option<(usize, usize)> = None;
    'outer: for i in 0..3 {
        for k in i + 1..3 {
            if 1.0 - dot(dirs[i], dirs[k]).abs() < 1e-6 {
                through = Some((i, k));
                break 'outer;
            }
        }
    }
    let Some((t0, t1)) = through else { return Ok(()) };
    let branch_idx = (0..3).find(|&i| i != t0 && i != t1).unwrap_or(0);
    let branch_end = ends[branch_idx];
    let through_end = ends[t0];
    let (bi, ti) = (branch_end.wall, through_end.wall);
    let through_wall = &walls[ti];

    let j = point_of(through_wall, through_end.end);
    let t_t = thickness(walls, ti)?;
    let u_t = if arcs { dir_at(through_wall, through_end.end) } else { dir_of(through_wall) };
    let n_t = left_normal(u_t);
    let off_t = reference_offset(through_wall.reference, t_t);

    let u_branch = if arcs { dir_at(&walls[bi], branch_end.end) } else { dir_of(&walls[bi]) };
    let d_branch = if branch_end.end == End::Start { u_branch } else { scale(u_branch, -1.0) };
    let sign = if dot(n_t, d_branch) >= 0.0 { 1.0 } else { -1.0 };
    let face_point = add(j, scale(n_t, off_t + sign * (t_t / 2.0)));
    let mut face_cut = Line { point: face_point, dir: u_t };
    if arcs {
        if let Some(c) = chord_cut(walls, bi, ti, off_t + sign * (t_t / 2.0), face_point)? {
            face_cut = c;
        }
    }

    set_cut(result, branch_end, face_cut);
    // Die Durchgangs-Hälften stossen rechtwinklig aneinander; als Schnitt markiert, damit die
    // Stossfuge nicht als Umriss gezeichnet wird (eine durchlaufende Wand).
    let joint = Line { point: j, dir: n_t };
    set_cut(result, ends[t0], joint);
    set_cut(result, ends[t1], joint);
    apply_layer_cuts(walls, result, branch_end, ti, Some(ends[t1].wall), face_cut, j, u_t, sign)
}

/// Materialbewusste Pro-Schicht-Erweiterung eines T-Stoss-Cuts: Abzweig-Schichten gleichen
/// Materials wie das Rückgrat der Durchgangswand (oder prioritärer) laufen bis zur
/// Rückgrat-Nahfläche durch; angrenzende getrimmte Schichten bekommen eine seitliche Linie; die
/// Durchgangswand (am Knoten-T beide Hälften, `other_half`) bekommt eine Nah-Putz-Aussparung über
/// die Kernbreite — exakt dort, wo die Kern-Kanten des (auch schrägen) Abzweigs die Fläche und die
/// Rückgrat-Nahfläche kreuzen. Setzt `layer_cuts` nur,
/// wenn mindestens eine Schicht verschmilzt.
#[allow(clippy::too_many_arguments)]
fn apply_layer_cuts(
    walls: &[JoinWall],
    result: &mut [WallCuts],
    branch_end: WallEnd,
    ti: usize,
    other_half: Option<usize>,
    face_cut: Line,
    axis_point: Vec2,
    through_dir: Vec2,
    sign: f64,
) -> R<()> {
    let bi = branch_end.wall;
    let branch_layers = layers_of(walls, bi)?;
    let through_layers = layers_of(walls, ti)?;
    if branch_layers.is_empty() || through_layers.is_empty() {
        return Ok(());
    }

    // Rückgrat der Durchgangswand: Schicht mit der höchsten joinPriority (erste gewinnt).
    let mut backbone = (component(ti, &through_layers[0])?, through_layers[0].priority);
    let mut backbone_idx = 0;
    for (i, l) in through_layers.iter().enumerate() {
        let c = component(ti, l)?;
        if l.priority > backbone.1 {
            backbone = (c, l.priority);
            backbone_idx = i;
        }
    }

    let n = branch_layers.len();
    let mut merged = vec![false; n];
    for (i, l) in branch_layers.iter().enumerate() {
        let c = component(bi, l)?;
        // "merge" (gleiches Rückgrat-Material) oder "trim-b" (Abzweig-Schicht selbst prioritärer)
        // → die Schicht läuft durch.
        merged[i] = matches!(resolve_join_priority(l.priority, backbone.1, c == backbone.0), JoinResolution::Merge | JoinResolution::TrimB);
    }
    if !merged.iter().any(|&m| m) {
        return Ok(());
    }

    let lc = result[bi].layer_cuts.get_or_insert_with(|| LayerCuts {
        start: vec![None; n],
        end: vec![None; n],
        start_side: vec![None; n],
        end_side: vec![None; n],
    });
    if lc.start.len() != n {
        return Ok(());
    }

    let t_t = through_layers.iter().fold(0.0, |s, l| s + l.thickness);
    let off_t = reference_offset(walls[ti].reference, t_t);
    let near = |i: usize| if sign > 0.0 { i > backbone_idx } else { i < backbone_idx };
    let mut near_plaster = 0.0;
    for (i, l) in through_layers.iter().enumerate() {
        if near(i) {
            near_plaster += l.thickness;
        }
    }
    let n_t = left_normal(through_dir);
    let merge_point = add(axis_point, scale(n_t, off_t + sign * (t_t / 2.0 - near_plaster)));
    let mut merge_cut = Line { point: merge_point, dir: through_dir };
    let arcs = is_arc(&walls[bi]) || is_arc(&walls[ti]) || other_half.is_some_and(|o| is_arc(&walls[o]));
    if arcs {
        if let Some(c) = chord_cut(walls, bi, ti, off_t + sign * (t_t / 2.0 - near_plaster), merge_point)? {
            merge_cut = c;
        }
    }
    let merge_point = merge_cut.point;
    let side_line = merge_cut;

    // Materialien des Nah-Putzes (Komponenten sind hier alle bekannt, s. Rückgrat-Suche).
    let near_comps: Vec<Option<u32>> = through_layers.iter().enumerate().filter(|(i, _)| near(*i)).map(|(_, l)| l.component).collect();

    let (face_arr, side_arr) = match branch_end.end {
        End::Start => (&mut lc.start, &mut lc.start_side),
        End::End => (&mut lc.end, &mut lc.end_side),
    };
    for i in 0..n {
        face_arr[i] = Some(if merged[i] { merge_cut } else { face_cut });
        let adj_merged = !merged[i] && ((i > 0 && merged[i - 1]) || (i + 1 < n && merged[i + 1]));
        let merges_with_near = near_comps.contains(&branch_layers[i].component);
        side_arr[i] = if adj_merged && !merges_with_near { Some(side_line) } else { None };
    }

    // Durchgangswand-Aussparung über die Kernbreite des Abzweigs. Ohne Nah-Putz (Kern trifft direkt
    // auf die Fläche) ist sie flach (`off_a = off_b`): nur die Flächenlinie bekommt dort eine Lücke.
    {
        let total_branch = branch_layers.iter().fold(0.0, |s, l| s + l.thickness);
        let ref_off_branch = reference_offset(walls[bi].reference, total_branch);
        let mut b_off = ref_off_branch - total_branch / 2.0;
        let mut core_lo = f64::INFINITY;
        let mut core_hi = f64::NEG_INFINITY;
        for (i, l) in branch_layers.iter().enumerate() {
            let th = l.thickness;
            if merged[i] {
                if b_off < core_lo {
                    core_lo = b_off;
                }
                if b_off + th > core_hi {
                    core_hi = b_off + th;
                }
            }
            b_off += th;
        }
        if core_hi > core_lo && arcs {
            // Bogen: Kern-Kanten als Versatzkurven, Achsmass als Bogenlänge.
            let bw = &walls[bi];
            let edge_lo = offset_curve(bw, core_lo);
            let edge_hi = offset_curve(bw, core_hi);
            for wi in std::iter::once(ti).chain(other_half) {
                let w = &walls[wi];
                let off_a = local_of(w, face_cut.point).1;
                let off_b = local_of(w, merge_point).1;
                let along = |edge: &Curve, off: f64| -> Option<f64> {
                    let hit = hit_near(edge, &offset_curve(w, off), axis_point)?;
                    Some(local_of(w, hit).0)
                };
                let (Some(a_lo), Some(a_hi), Some(b_lo), Some(b_hi)) = (along(&edge_lo, off_a), along(&edge_hi, off_a), along(&edge_lo, off_b), along(&edge_hi, off_b)) else {
                    continue;
                };
                let s = if a_lo <= a_hi {
                    SpanCutout { from: a_lo, to: a_hi, off_a, off_b, from_b: b_lo, to_b: b_hi }
                } else {
                    SpanCutout { from: a_hi, to: a_lo, off_a, off_b, from_b: b_hi, to_b: b_lo }
                };
                result[wi].span_cutouts.push(s);
            }
        } else if core_hi > core_lo {
            let bw = &walls[bi];
            let n_branch = left_normal(dir_of(bw));
            let u_branch = dir_of(bw);
            let edge_lo = add(bw.start, scale(n_branch, core_lo));
            let edge_hi = add(bw.start, scale(n_branch, core_hi));
            let face_pt = face_cut.point;
            for wi in std::iter::once(ti).chain(other_half) {
                let w = &walls[wi];
                let u_w = dir_of(w);
                let n_w = left_normal(u_w);
                // Flächen im Rahmen der Wand `wi` (die andere Hälfte kann gegenläufig sein).
                let off_a = dot(sub(face_pt, w.start), n_w);
                let off_b = dot(sub(merge_point, w.start), n_w);
                let along = |edge: Vec2, off: f64| -> Option<f64> {
                    let hit = line_intersect(edge, u_branch, add(w.start, scale(n_w, off)), u_w)?;
                    Some(dot(sub(hit, w.start), u_w))
                };
                let (Some(a_lo), Some(a_hi), Some(b_lo), Some(b_hi)) = (along(edge_lo, off_a), along(edge_hi, off_a), along(edge_lo, off_b), along(edge_hi, off_b)) else {
                    continue;
                };
                let s = if a_lo <= a_hi {
                    SpanCutout { from: a_lo, to: a_hi, off_a, off_b, from_b: b_lo, to_b: b_hi }
                } else {
                    SpanCutout { from: a_hi, to: a_lo, off_a, off_b, from_b: b_hi, to_b: b_lo }
                };
                result[wi].span_cutouts.push(s);
            }
        }
    }
    Ok(())
}

/// Fall 2 — Mittelspannen-T-Stoss: trifft das Ende `free` auf die innere Spanne einer anderen
/// Wand (senkrecht höchstens halbe Dicke + 1 mm entfernt), bekommt es einen Schnitt an deren
/// zugewandter Fläche; bei mehreren Treffern gewinnt die nächstliegende Wand.
fn apply_mid_span_tee(walls: &[JoinWall], free: WallEnd, result: &mut [WallCuts]) -> R<()> {
    let fi = free.wall;
    let free_wall = &walls[fi];
    let p = point_of(free_wall, free.end);
    const END_GAP: f64 = 1e-4;
    const TOL: f64 = 1e-3;

    // (Wand, perp, dist, distAlong)
    let mut best: Option<(usize, f64, f64, f64)> = None;
    for (wi, w) in walls.iter().enumerate() {
        if wi == fi {
            continue;
        }
        if let Some(a) = arc_of(w) {
            let (dist_along, perp) = a.local(p);
            if dist_along <= END_GAP || dist_along >= a.length() - END_GAP {
                continue;
            }
            let tw = thickness(walls, wi)?;
            let dist = perp.abs();
            if dist > tw / 2.0 + TOL {
                continue;
            }
            if best.map_or(true, |b| dist < b.2) {
                best = Some((wi, perp, dist, dist_along));
            }
            continue;
        }
        let u = dir_of(w);
        let w_len = len(sub(w.end, w.start));
        if w_len < 1e-9 {
            continue;
        }
        let rel = sub(p, w.start);
        let dist_along = dot(rel, u);
        if dist_along <= END_GAP || dist_along >= w_len - END_GAP {
            continue;
        }
        let perp = dot(rel, left_normal(u));
        let tw = thickness(walls, wi)?;
        let dist = perp.abs();
        if dist > tw / 2.0 + TOL {
            continue;
        }
        if best.map_or(true, |b| dist < b.2) {
            best = Some((wi, perp, dist, dist_along));
        }
    }
    let Some((wi, perp, _, dist_along)) = best else { return Ok(()) };
    if is_arc(&walls[wi]) || is_arc(free_wall) {
        return mid_span_tee_arc(walls, free, wi, perp, dist_along, result);
    }

    let w = &walls[wi];
    let tw = thickness(walls, wi)?;
    let u_w = dir_of(w);
    let n_w = left_normal(u_w);
    let off_w = reference_offset(w.reference, tw);
    let d_free = if free.end == End::Start { dir_of(free_wall) } else { scale(dir_of(free_wall), -1.0) };
    let facing = dot(n_w, d_free);
    let sign = if facing.abs() > 1e-6 {
        if facing >= 0.0 {
            1.0
        } else {
            -1.0
        }
    } else if perp >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let face_point = add(w.start, scale(n_w, off_w + sign * (tw / 2.0)));
    let face_cut = Line { point: face_point, dir: u_w };

    set_cut(result, free, face_cut);
    let axis_point = add(w.start, scale(u_w, dist_along));
    apply_layer_cuts(walls, result, free, wi, None, face_cut, axis_point, u_w, sign)
}

/// [`apply_mid_span_tee`] mit Bogenwand (Durchgang oder freies Ende).
fn mid_span_tee_arc(walls: &[JoinWall], free: WallEnd, wi: usize, perp: f64, dist_along: f64, result: &mut [WallCuts]) -> R<()> {
    let w = &walls[wi];
    let tw = thickness(walls, wi)?;
    let (u_w, axis_point) = match arc_of(w) {
        Some(a) => (a.tangent(dist_along), a.point(dist_along, 0.0)),
        None => {
            let u = dir_of(w);
            (u, add(w.start, scale(u, dist_along)))
        }
    };
    let n_w = left_normal(u_w);
    let off_w = reference_offset(w.reference, tw);
    let u_free = dir_at(&walls[free.wall], free.end);
    let d_free = if free.end == End::Start { u_free } else { scale(u_free, -1.0) };
    let facing = dot(n_w, d_free);
    let sign = if facing.abs() > 1e-6 {
        if facing >= 0.0 {
            1.0
        } else {
            -1.0
        }
    } else if perp >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let face_point = add(axis_point, scale(n_w, off_w + sign * (tw / 2.0)));
    let face_cut = chord_cut(walls, free.wall, wi, off_w + sign * (tw / 2.0), face_point)?.unwrap_or(Line { point: face_point, dir: u_w });
    set_cut(result, free, face_cut);
    apply_layer_cuts(walls, result, free, wi, None, face_cut, axis_point, u_w, sign)
}

// ── Flache Kodierung ─────────────────────────────────────────────────────────
//
// Wände: [n, (sx, sy, ex, ey, refKind, refValue, typeOk, nLayers, (dicke, bauteil, prio)…)…]
//   refKind: 0 Mitte, 1 links, 2 rechts, 3 freier Versatz (refValue); bauteil < 0 = unbekannt.
// Cuts einer Wand: [start(5), end(5), nLC, (start, end, startSide, endSide je nLC × 5),
//   nSpan, (from, to, offA, offB, fromB, toB)…]; Linie = (gesetzt 0/1, px, py, dx, dy).

/// Liest die Wände; `None` bei kaputten/unendlichen Daten.
pub fn decode_walls(buf: &[f64]) -> Option<Vec<JoinWall>> {
    let mut r = crate::flat_read::Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let (sx, sy, ex, ey) = (r.num()?, r.num()?, r.num()?, r.num()?);
        let (kind, value) = (r.num()?, r.num()?);
        let type_ok = r.num()? != 0.0;
        let nl = r.count()?;
        if ![sx, sy, ex, ey].iter().all(|v| v.is_finite()) {
            return None;
        }
        let reference = match kind as i64 {
            1 => Reference::Left,
            2 => Reference::Right,
            3 if value.is_finite() => Reference::Offset(value),
            3 => return None,
            _ => Reference::Center,
        };
        let mut layers = Vec::with_capacity(nl.min(1 << 10));
        for _ in 0..nl {
            let (t, c, p) = (r.num()?, r.num()?, r.num()?);
            if !t.is_finite() {
                return None;
            }
            let component = (c.is_finite() && c >= 0.0 && c < 4e9).then_some(c as u32);
            // Unbekanntes Bauteil: Priorität spielt keine Rolle (Fehler, sobald gebraucht).
            let priority = if component.is_some() { p } else { f64::NAN };
            layers.push(JoinLayer { thickness: t, component, priority });
        }
        out.push(JoinWall { start: Vec2::new(sx, sy), end: Vec2::new(ex, ey), reference, layers: type_ok.then_some(layers), bulge: None });
    }
    Some(out)
}

fn push_line(out: &mut Vec<f64>, l: &Option<Line>) {
    match l {
        Some(l) => out.extend([1.0, l.point.x, l.point.y, l.dir.x, l.dir.y]),
        None => out.extend([0.0; 5]),
    }
}

/// Hängt die Cuts einer Wand flach an.
pub fn encode_cuts(out: &mut Vec<f64>, c: &WallCuts) {
    push_line(out, &c.start_cut);
    push_line(out, &c.end_cut);
    match &c.layer_cuts {
        Some(lc) => {
            out.push(lc.start.len() as f64);
            for arr in [&lc.start, &lc.end, &lc.start_side, &lc.end_side] {
                for l in arr {
                    push_line(out, l);
                }
            }
        }
        None => out.push(0.0),
    }
    out.push(c.span_cutouts.len() as f64);
    for s in &c.span_cutouts {
        out.extend([s.from, s.to, s.off_a, s.off_b, s.from_b, s.to_b]);
    }
}

fn read_line(r: &mut crate::flat_read::Reader) -> Option<Option<Line>> {
    let (set, px, py, dx, dy) = (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
    if set == 0.0 {
        return Some(None);
    }
    if ![px, py, dx, dy].iter().all(|v| v.is_finite()) {
        return None;
    }
    Some(Some(Line { point: Vec2::new(px, py), dir: Vec2::new(dx, dy) }))
}

/// Liest die Cuts einer Wand (Gegenstück zu [`encode_cuts`]).
pub fn decode_cuts(r: &mut crate::flat_read::Reader) -> Option<WallCuts> {
    let start_cut = read_line(r)?;
    let end_cut = read_line(r)?;
    let n = r.count()?;
    let layer_cuts = if n > 0 {
        if n > 1 << 12 {
            return None;
        }
        let mut arrs: [Vec<Option<Line>>; 4] = Default::default();
        for a in arrs.iter_mut() {
            for _ in 0..n {
                a.push(read_line(r)?);
            }
        }
        let [start, end, start_side, end_side] = arrs;
        Some(LayerCuts { start, end, start_side, end_side })
    } else {
        None
    };
    let m = r.count()?;
    let mut span_cutouts = Vec::with_capacity(m.min(1 << 10));
    for _ in 0..m {
        let s = SpanCutout { from: r.num()?, to: r.num()?, off_a: r.num()?, off_b: r.num()?, from_b: r.num()?, to_b: r.num()? };
        if ![s.from, s.to, s.off_a, s.off_b, s.from_b, s.to_b].iter().all(|v| v.is_finite()) {
            return None;
        }
        span_cutouts.push(s);
    }
    Some(WallCuts { start_cut, end_cut, layer_cuts, span_cutouts })
}

/// Ergebnis flach: `[0, (cuts je Wand)…]`; Fehler `[1, wandIndex]` (Wandtyp bzw. Bauteil
/// unbekannt — TS wirft); kaputte Eingabe: leer.
pub fn compute_joins_flat(buf: &[f64]) -> Vec<f64> {
    let Some(walls) = decode_walls(buf) else { return vec![] };
    match compute_joins(&walls) {
        Ok(cuts) => {
            let mut out = vec![0.0];
            for c in &cuts {
                encode_cuts(&mut out, c);
            }
            out
        }
        Err(JoinError::UnknownWallType(i)) | Err(JoinError::UnknownComponent(i)) => vec![1.0, i as f64],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(t: f64, c: u32, p: f64) -> JoinLayer {
        JoinLayer { thickness: t, component: Some(c), priority: p }
    }
    fn wall(s: (f64, f64), e: (f64, f64), layers: Vec<JoinLayer>) -> JoinWall {
        JoinWall { start: Vec2::new(s.0, s.1), end: Vec2::new(e.0, e.1), reference: Reference::Center, layers: Some(layers), bulge: None }
    }
    fn mono(s: (f64, f64), e: (f64, f64), t: f64) -> JoinWall {
        wall(s, e, vec![layer(t, 0, 10.0)])
    }
    /// Abstand eines Punkts von der Geraden.
    fn dist(l: &Line, p: Vec2) -> f64 {
        kernel2d::cross(l.dir, sub(p, l.point)).abs() / len(l.dir)
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn l_ecke_gehrung_auf_diagonale() {
        let w = vec![mono((0.0, 0.0), (5.0, 0.0), 0.4), mono((5.0, 0.0), (5.0, 4.0), 0.4)];
        let c = compute_joins(&w).unwrap();
        let a = c[0].end_cut.unwrap();
        assert_eq!(c[1].start_cut, Some(a));
        // Aussen-Apex (5.2, -0.2), Innen-Apex (4.8, 0.2).
        assert!(dist(&a, Vec2::new(5.2, -0.2)) < 1e-9 && dist(&a, Vec2::new(4.8, 0.2)) < 1e-9);
        assert_eq!(c[0].start_cut, None);
    }

    #[test]
    fn spitze_ecke_paart_aussen_mit_aussen() {
        let w = vec![mono((0.0, 0.0), (4.0, 0.0), 0.2), mono((4.0, 0.0), (1.0, 1.0), 0.2)];
        let c = compute_joins(&w).unwrap();
        let cut = c[0].end_cut.unwrap();
        // Gleiche Dicken: die Gehrung ist die Winkelhalbierende durch den Knoten (über Kreuz
        // gepaart stünde sie senkrecht dazu).
        let bis = add(Vec2::new(-1.0, 0.0), normalize(Vec2::new(-3.0, 1.0)));
        assert!(kernel2d::cross(normalize(cut.dir), normalize(bis)).abs() < 1e-9, "{cut:?}");
        assert!(dist(&cut, Vec2::new(4.0, 0.0)) < 1e-9);
    }

    #[test]
    fn t_knoten_schneidet_nur_abzweig() {
        let w = vec![mono((0.0, 0.0), (3.0, 0.0), 0.3), mono((3.0, 0.0), (6.0, 0.0), 0.3), mono((3.0, 0.0), (3.0, 4.0), 0.2)];
        let c = compute_joins(&w).unwrap();
        // Durchgang: rechtwinklige Stossfuge der beiden Hälften (nicht gezeichnet).
        assert!(close(c[0].end_cut.unwrap().dir.x, 0.0) && close(c[1].start_cut.unwrap().point.x, 3.0));
        assert_eq!(c[0].start_cut, None);
        let cut = c[2].start_cut.unwrap();
        assert!(close(cut.point.y, 0.15) && close(cut.dir.y, 0.0));
    }

    #[test]
    fn mittelspannen_t_und_kreuzung() {
        // Durchlaufende Wand, oben ein Abzweig, unten/oben eine Kreuzung aus zwei Hälften.
        let w = vec![
            mono((0.0, 0.0), (10.0, 0.0), 0.3),
            mono((2.0, 0.0), (2.0, 3.0), 0.2),
            mono((6.0, -3.0), (6.0, 0.0), 0.2),
            mono((6.0, 0.0), (6.0, 3.0), 0.2),
        ];
        let c = compute_joins(&w).unwrap();
        assert!(close(c[1].start_cut.unwrap().point.y, 0.15));
        assert!(close(c[2].end_cut.unwrap().point.y, -0.15));
        assert!(close(c[3].start_cut.unwrap().point.y, 0.15));
        // Gleiches Bauteil ohne Nah-Putz: flache Aussparungen (nur Lücke in der Flächenlinie), je Anschluss eine.
        assert!(c[0].start_cut.is_none() && c[0].end_cut.is_none() && c[0].layer_cuts.is_none());
        assert_eq!(c[0].span_cutouts.len(), 3);
        assert!(c[0].span_cutouts.iter().all(|s| s.off_a == s.off_b && close(s.to - s.from, 0.2) && s.from_b == s.from));
    }

    #[test]
    fn freies_ende_bleibt_rechtwinklig() {
        let w = vec![mono((0.0, 0.0), (10.0, 0.0), 0.3), mono((2.0, 1.0), (2.0, 3.0), 0.2)];
        assert_eq!(compute_joins(&w).unwrap(), vec![WallCuts::default(); 2]);
    }

    #[test]
    fn materialbewusster_t_stoss() {
        // Durchgang: Putz(0) 0.02 | Backstein(1, prio 50) 0.15 | Putz(0) 0.015; Abzweig gleich.
        let lay = || vec![layer(0.02, 0, 10.0), layer(0.15, 1, 50.0), layer(0.015, 0, 10.0)];
        let w = vec![wall((0.0, 0.0), (10.0, 0.0), lay()), wall((4.0, 0.0), (4.0, 3.0), lay())];
        let c = compute_joins(&w).unwrap();
        let lc = c[1].layer_cuts.as_ref().unwrap();
        let total: f64 = 0.185;
        // Kern läuft bis zur Rückgrat-Nahfläche (Nah-Putz 0.015 auf der +n-Seite).
        assert!(close(lc.start[1].unwrap().point.y, total / 2.0 - 0.015));
        assert!(close(lc.start[0].unwrap().point.y, total / 2.0));
        // Putz-Schichten sind materialgleich mit dem Nah-Putz → keine Seitenlinie.
        assert_eq!(lc.start_side, vec![None; 3]);
        assert_eq!(lc.end, vec![None; 3]);
        // Durchgangswand bekommt die Nah-Putz-Aussparung über die Kernbreite.
        let s = c[0].span_cutouts[0];
        assert!(close(s.off_a, total / 2.0) && close(s.off_b, total / 2.0 - 0.015));
        assert!(close(s.to - s.from, 0.15), "{s:?}");
    }

    // Aus `model/joins.test.ts` übernommen ([K3d]: der TS-Sammler ist weg).
    #[test]
    fn stern_knoten_bleibt_rechtwinklig() {
        let w = vec![mono((0.0, 5.0), (5.0, 5.0), 0.3), mono((5.0, 5.0), (10.0, 5.0), 0.3), mono((5.0, 5.0), (5.0, 0.0), 0.3), mono((5.0, 5.0), (5.0, 10.0), 0.3)];
        for c in compute_joins(&w).unwrap() {
            assert!(c.start_cut.is_none() && c.end_cut.is_none());
        }
    }

    #[test]
    fn rangfolge_zweier_bauteile() {
        use JoinResolution::*;
        assert_eq!(resolve_join_priority(50.0, 50.0, true), Merge);
        assert_eq!(resolve_join_priority(20.0, 20.0, false), Coexist);
        assert_eq!(resolve_join_priority(10.0, 50.0, false), TrimA);
        assert_eq!(resolve_join_priority(50.0, 10.0, false), TrimB);
        assert_eq!(resolve_join_priority(100.0, 50.0, false), TrimB);
        assert_eq!(resolve_join_priority(50.0, 100.0, false), TrimA);
    }

    #[test]
    fn l_ecke_ohne_aussparung_und_abzweig_ohne_materialgleichheit() {
        let c = compute_joins(&[mono((0.0, 0.0), (5.0, 0.0), 0.4), mono((5.0, 0.0), (5.0, 4.0), 0.4)]).unwrap();
        assert!(c.iter().all(|k| k.span_cutouts.is_empty()));
        // Durchgang Putz|Backstein|Putz, Abzweig nur Putz (kein Bauteil des Rückgrats): kein layerCuts.
        let lay = || vec![layer(0.015, 0, 10.0), layer(0.12, 1, 50.0), layer(0.015, 0, 10.0)];
        let w = vec![wall((0.0, 0.0), (5.0, 0.0), lay()), wall((5.0, 0.0), (10.0, 0.0), lay()), wall((5.0, 0.0), (5.0, 3.0), vec![layer(0.1, 0, 10.0)])];
        let c = compute_joins(&w).unwrap();
        assert!(c[2].layer_cuts.is_none());
        assert!(c[2].start_cut.is_some());
    }

    /// Aussenwand-Aufbau wie im Beispielhaus: Aussenputz | Dämmung | Backstein (Rückgrat) | Innenputz.
    fn aw() -> Vec<JoinLayer> {
        vec![layer(0.02, 0, 10.0), layer(0.16, 1, 20.0), layer(0.15, 2, 50.0), layer(0.015, 3, 10.0)]
    }

    /// Wo die Kante (Versatz `o` quer zur Abzweig-Achse durch `b0` mit Winkel `th`) die Gerade
    /// y = f der waagrechten Durchgangswand trifft (x-Koordinate) — unabhängige Referenz.
    fn x_on_face(b0: Vec2, th: f64, o: f64, f: f64) -> f64 {
        let (s, c) = th.sin_cos();
        let t = (f - b0.y - o * c) / s;
        b0.x - o * s + t * c
    }

    #[test]
    fn schraeger_t_stoss_schneidet_an_der_flaeche_15_bis_165_grad() {
        for deg in (15..=165).step_by(15) {
            let th = (deg as f64).to_radians();
            let b0 = Vec2::new(5.0, 0.0);
            let b1 = Vec2::new(5.0 + 3.0 * th.cos(), 3.0 * th.sin());
            for (lay, total) in [(vec![layer(0.25, 0, 10.0)], 0.25), (aw(), 0.345)] {
                // Mittelspannen-T und Knoten-T (Durchgang aus zwei Hälften).
                let mid = vec![wall((0.0, 0.0), (10.0, 0.0), lay.clone()), wall((b0.x, b0.y), (b1.x, b1.y), lay.clone())];
                let node = vec![wall((0.0, 0.0), (5.0, 0.0), lay.clone()), wall((5.0, 0.0), (10.0, 0.0), lay.clone()), wall((b0.x, b0.y), (b1.x, b1.y), lay.clone())];
                for w in [mid, node] {
                    let bi = w.len() - 1;
                    let c = compute_joins(&w).unwrap();
                    let cut = c[bi].start_cut.unwrap();
                    // Schnitt liegt auf der zugewandten Fläche y = total/2, parallel zur Durchgangswand.
                    assert!(close(cut.dir.y, 0.0) && close(cut.point.y, total / 2.0), "{deg}° {cut:?}");
                }
            }
        }
    }

    #[test]
    fn schraege_nahputz_aussparung_folgt_dem_abzweig_15_bis_165_grad() {
        let total = 0.345;
        let (off_a, off_b) = (total / 2.0, total / 2.0 - 0.015);
        // Rückgrat-Kante des Abzweigs (Backstein) quer zur Achse.
        let (core_lo, core_hi) = (-total / 2.0 + 0.18, -total / 2.0 + 0.33);
        for deg in (15..=165).step_by(15) {
            let th = (deg as f64).to_radians();
            let b0 = Vec2::new(5.0, 0.0);
            let b1 = Vec2::new(5.0 + 3.0 * th.cos(), 3.0 * th.sin());
            let mid = vec![wall((0.0, 0.0), (10.0, 0.0), aw()), wall((b0.x, b0.y), (b1.x, b1.y), aw())];
            let node = vec![wall((0.0, 0.0), (5.0, 0.0), aw()), wall((5.0, 0.0), (10.0, 0.0), aw()), wall((b0.x, b0.y), (b1.x, b1.y), aw())];
            for w in [mid, node] {
                let c = compute_joins(&w).unwrap();
                let through: Vec<usize> = (0..w.len() - 1).collect();
                // Aussparung je Durchgangs-Hälfte, in deren Achsmass (Start x = 0 bzw. 5).
                let mut hits = 0;
                for &ti in &through {
                    let x0 = w[ti].start.x;
                    for s in &c[ti].span_cutouts {
                        hits += 1;
                        assert!(close(s.off_a, off_a) && close(s.off_b, off_b), "{deg}° {s:?}");
                        let xa = [x_on_face(b0, th, core_lo, off_a), x_on_face(b0, th, core_hi, off_a)];
                        let xb = [x_on_face(b0, th, core_lo, off_b), x_on_face(b0, th, core_hi, off_b)];
                        let (lo, hi) = if xa[0] < xa[1] { (0, 1) } else { (1, 0) };
                        assert!(close(s.from + x0, xa[lo]) && close(s.to + x0, xa[hi]), "{deg}° {s:?} {xa:?}");
                        assert!(close(s.from_b + x0, xb[lo]) && close(s.to_b + x0, xb[hi]), "{deg}° {s:?} {xb:?}");
                        // Breite = Kernbreite / sin θ (nicht · sin θ).
                        assert!(close(s.to - s.from, 0.15 / th.sin()), "{deg}°");
                    }
                }
                assert_eq!(hits, through.len(), "{deg}°: jede Durchgangs-Hälfte bekommt die Aussparung");
            }
        }
    }

    #[test]
    fn hypot_wie_js() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(0.0, -0.0), 0.0);
        assert!(js_hypot(f64::NAN, 1.0).is_nan());
        assert_eq!(js_hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
        assert_eq!(normalize(Vec2::new(0.0, 0.0)), Vec2::new(0.0, 0.0));
    }

    #[test]
    fn referenzlinie() {
        assert_eq!(reference_offset(Reference::Left, 0.4), 0.2);
        assert_eq!(reference_offset(Reference::Right, 0.4), -0.2);
        assert_eq!(reference_offset(Reference::Offset(5.0), 0.4), 0.2);
        assert_eq!(reference_offset(Reference::Offset(-0.05), 0.4), -0.05);
    }

    #[test]
    fn unbekannter_typ_nur_wenn_gebraucht() {
        let mut w = vec![mono((0.0, 0.0), (5.0, 0.0), 0.4), mono((5.0, 0.0), (5.0, 4.0), 0.4), mono((20.0, 0.0), (25.0, 0.0), 0.4)];
        w[2].layers = None;
        assert!(compute_joins(&w).is_ok()); // freistehend → nie gebraucht
        w[1].layers = None;
        assert_eq!(compute_joins(&w), Err(JoinError::UnknownWallType(1)));
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(compute_joins_flat(&[]).is_empty());
        assert!(compute_joins_flat(&[f64::NAN]).is_empty());
        assert!(compute_joins_flat(&[1.0, 0.0, 0.0]).is_empty());
        assert!(compute_joins_flat(&[1.0, f64::NAN, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0]).is_empty());
        assert_eq!(compute_joins_flat(&[0.0]), vec![0.0]);
        // Nulllängen-Wände und deckungsgleiche Enden.
        let w = [
            3.0, //
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.2, 0.0, 10.0, // Nulllänge, eine Schicht
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, // Nulllänge, ohne Schichten
            0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, // Wandtyp unbekannt
        ];
        let out = compute_joins_flat(&w);
        assert_eq!(out.first(), Some(&0.0));
        // Kaputte Cuts lesen.
        let mut r = crate::flat_read::Reader::new(&[1.0, 0.0]);
        assert!(decode_cuts(&mut r).is_none());
    }

    #[test]
    fn cuts_hin_und_zurueck() {
        let lay = || vec![layer(0.02, 0, 10.0), layer(0.15, 1, 50.0), layer(0.015, 0, 10.0)];
        let w = vec![wall((0.0, 0.0), (10.0, 0.0), lay()), wall((4.0, 0.0), (4.0, 3.0), lay()), wall((10.0, 0.0), (10.0, 5.0), lay())];
        for c in compute_joins(&w).unwrap() {
            let mut buf = vec![];
            encode_cuts(&mut buf, &c);
            let mut r = crate::flat_read::Reader::new(&buf);
            assert_eq!(decode_cuts(&mut r), Some(c));
        }
    }

    // ── Bogenwände ([T2]) ──

    fn arc_wall(s: (f64, f64), e: (f64, f64), b: f64, t: f64) -> JoinWall {
        JoinWall { bulge: Some(b), ..mono(s, e, t) }
    }
    fn on_circle(p: Vec2, c: (f64, f64), r: f64) -> bool {
        (len(sub(p, Vec2::new(c.0, c.1))) - r).abs() < 1e-9
    }
    fn ends(l: &Line) -> [Vec2; 2] {
        [l.point, add(l.point, l.dir)]
    }

    #[test]
    fn bogen_l_ecke_exakt_auf_flaechen() {
        // Gerade (0,0)→(5,0), dann Halbkreis (5,0)→(10,0) mit Scheitel oben (Mitte (7.5,0), r 2.5).
        let w = vec![mono((0.0, 0.0), (5.0, 0.0), 0.3), arc_wall((5.0, 0.0), (10.0, 0.0), 1.0, 0.3)];
        let c = compute_joins(&w).unwrap();
        let cut = c[0].end_cut.unwrap();
        assert_eq!(Some(cut), c[1].start_cut);
        for p in ends(&cut) {
            assert!(close(p.y.abs(), 0.15), "{p:?}");
            assert!(on_circle(p, (7.5, 0.0), 2.35) || on_circle(p, (7.5, 0.0), 2.65), "{p:?}");
        }
        // Aussenecke unten rechts, Innenecke oben links.
        let [a, b] = ends(&cut);
        let (lo, hi) = if a.y < b.y { (a, b) } else { (b, a) };
        assert!(close(lo.x, 7.5 - (2.35f64 * 2.35 - 0.0225).sqrt()) && close(hi.x, 7.5 - (2.65f64 * 2.65 - 0.0225).sqrt()));
    }

    #[test]
    fn bogen_ring_stoesst_radial_ohne_fuge() {
        let w = vec![arc_wall((0.0, 0.0), (10.0, 0.0), 1.0, 0.3), arc_wall((10.0, 0.0), (0.0, 0.0), 1.0, 0.3)];
        let c = compute_joins(&w).unwrap();
        for cut in [c[0].start_cut, c[0].end_cut, c[1].start_cut, c[1].end_cut] {
            let cut = cut.expect("radiale Stossfuge");
            assert!(close(cut.dir.y, 0.0) && close(cut.point.y, 0.0));
        }
    }

    #[test]
    fn gerader_abzweig_auf_bogen_mittelspanne() {
        // Halbkreis unten (CCW, Mitte (5,0), r 5); Abzweig vom tiefsten Punkt nach unten.
        let w = vec![arc_wall((0.0, 0.0), (10.0, 0.0), -1.0, 0.3), mono((5.0, -5.0), (5.0, -9.0), 0.2)];
        let c = compute_joins(&w).unwrap();
        let cut = c[1].start_cut.unwrap();
        for p in ends(&cut) {
            assert!(on_circle(p, (5.0, 0.0), 5.15), "{p:?}");
            assert!(close(p.x - 5.0, 0.1) || close(p.x - 5.0, -0.1));
        }
        assert!(c[0].start_cut.is_none() && c[0].end_cut.is_none());
    }

    #[test]
    fn bogen_abzweig_auf_gerade_und_t_knoten() {
        // Bogen-Abzweig trifft die Mittelspanne einer geraden Wand: Schnitt liegt auf deren Fläche.
        let mid = vec![mono((0.0, 0.0), (10.0, 0.0), 0.3), arc_wall((5.0, 0.0), (8.0, 3.0), 0.4, 0.2)];
        let node = vec![mono((0.0, 0.0), (5.0, 0.0), 0.3), mono((5.0, 0.0), (10.0, 0.0), 0.3), arc_wall((5.0, 0.0), (8.0, 3.0), 0.4, 0.2)];
        for w in [mid, node] {
            let bi = w.len() - 1;
            let c = compute_joins(&w).unwrap();
            let cut = c[bi].start_cut.unwrap();
            let arc = WallArc::of(w[bi].start, w[bi].end, w[bi].bulge).unwrap();
            for p in ends(&cut) {
                assert!(close(p.y, 0.15), "{p:?}");
                let (_, n) = arc.local(p);
                assert!(close(n.abs(), 0.1), "{n}");
            }
        }
    }

    #[test]
    fn bogen_bogen_ecke_auf_beiden_kreisen() {
        // Zwei Viertelbögen, die sich im Punkt (5,0) unter einem Knick treffen.
        let b = (std::f64::consts::PI / 8.0).tan();
        let w = vec![arc_wall((0.0, 0.0), (5.0, 0.0), b, 0.25), arc_wall((5.0, 0.0), (8.0, 4.0), 0.2, 0.25)];
        let c = compute_joins(&w).unwrap();
        let cut = c[0].end_cut.unwrap();
        let a0 = WallArc::of(w[0].start, w[0].end, w[0].bulge).unwrap();
        let a1 = WallArc::of(w[1].start, w[1].end, w[1].bulge).unwrap();
        for p in ends(&cut) {
            assert!(close(a0.local(p).1.abs(), 0.125) && close(a1.local(p).1.abs(), 0.125), "{p:?}");
        }
    }

    #[test]
    fn bogen_mehrschichtig_t_mit_nahputz() {
        // Mehrschichtiger Bogen-Abzweig auf gerade Aussenwand: Kern läuft bis zur Rückgrat-Fläche,
        // Aussparung in der Durchgangswand.
        let w = vec![wall((0.0, 0.0), (10.0, 0.0), aw()), JoinWall { bulge: Some(0.3), ..wall((5.0, 0.0), (9.0, 4.0), aw()) }];
        let c = compute_joins(&w).unwrap();
        let lc = c[1].layer_cuts.as_ref().expect("Schicht-Cuts");
        let merge = lc.start[2].unwrap();
        assert!(close(merge.point.y, 0.345 / 2.0 - 0.015) && close(merge.dir.y, 0.0));
        assert_eq!(c[0].span_cutouts.len(), 1);
        let s = c[0].span_cutouts[0];
        assert!(s.to > s.from && s.from > 4.5 && s.to < 6.0, "{s:?}");
    }
}
