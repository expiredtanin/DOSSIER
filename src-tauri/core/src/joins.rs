//! Wand-Verschneidung (Gehrung, T-Stoss, Kreuzung): berechnet je Wand die optionalen
//! Schnittlinien an Start- und Endpunkt, materialbewusste Pro-Schicht-Cuts am T-Stoss und die
//! Nah-Putz-Aussparungen der Durchgangswand. Portiert aus `src/model/joins.ts`; gesammelt wird im
//! Kern (`model3d/walls.rs` für 3D, `plan/walls.rs` für den Grundriss).
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
    /// [141] Zweite Schnittlinie am Anfang/Ende (Y-Knoten: der dritte Ast stösst an die Flächen beider
    /// Eckwände). `start_cut`/`end_cut` gilt im Querversatz (links der Laufrichtung) unter dem
    /// Schnittpunkt beider Linien, `*_cut2` darüber. Grundriss (`wall_poche.rs` `knee_band`) und 3D
    /// (`wall_bands.rs`: das Band über den Knick wird quer geteilt, je Teil eine Linie).
    pub start_cut2: Option<Line>,
    pub end_cut2: Option<Line>,
    /// [141] Die Wand liegt ganz in einer kollinearen Wand gleichen Typs (gleiches Band): im Grundriss
    /// nicht zeichnen, die umfassende Wand zeigt den Körper.
    pub covered: bool,
    /// [141] Anfang/Ende liegt an der Stossfuge einer kollinearen Wand gleichen Typs (`merge_collinear`):
    /// ein Körper mit der Nachbarwand, in der Ansicht keine Stirnfläche, im Schnitt-Pfad dort gestutzt.
    pub collinear: [bool; 2],
    /// [141] Anfang/Ende endet an einer Stützenkontur (`plan::wall_columns`, Stütze prioritärer oder
    /// gleiches Bauteil): auch der Schnitt-Pfad stutzt dort.
    pub at_column: [bool; 2],
    /// [141] Gerichtete Schichtmuster dieser Wand um 180° gedreht: Gehrung/Stossfuge zweier gleich
    /// orientierter Enden (Anfang an Anfang, Ende an Ende) spiegelt die Laufrichtung; gedreht gehen die
    /// Muster an der Schnittlinie spiegelbildlich ineinander über. Über die Ketten verbundener Wände
    /// zweifarbig verteilt (bei ungerader Masche gewinnt die erste Zuordnung).
    pub pattern_flip: bool,
    /// [175] Gerichtete Schichtmuster am Eckquadrat einer Gehrung (Anfang/Ende): eine der beiden Wände deckt
    /// das Quadrat der Schicht mit durchlaufendem Muster, die andere endet stumpf an dessen Grenze.
    pub pattern_corner: [Option<PatternCorner>; 2],
    /// [141] Prioritärere Stützen (oder gleiches Bauteil), die den Wandkörper überlappen: Grundriss-Kontur
    /// (konvex) und Höhenbereich `[z_unten, z_oben]`. Das 3D (`model3d::carve_at_columns`) spart sie aus den
    /// Wandkörpern aus — runde Stütze an der Kontur, Wand durch/breiter als die Stütze, Stütze kürzer als die
    /// Wand. Nur 3D/Schnitt/Ansicht/IFC; der Grundriss beschneidet seine Flächen selbst.
    pub column_carves: Vec<(Vec<Vec2>, [f64; 2])>,
}

/// [175] Rolle einer Wand an einer Gehrung für gerichtete Schichtmuster: `owner` deckt das Eckquadrat der
/// Schicht; `other_dir` = Einheitsrichtung der anderen Wand vom Knoten weg.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PatternCorner {
    pub owner: bool,
    pub other_dir: Vec2,
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

/// Gemeinsame Schnittlinie zweier Enden (Gehrung, Stossfuge).
fn set_pair(result: &mut [WallCuts], a: WallEnd, b: WallEnd, cut: Line) {
    set_cut(result, a, cut);
    set_cut(result, b, cut);
}

/// [141] Drehung der Schichtmuster (`pattern_flip`): Enden mit derselben Schnittlinie sind gekoppelt
/// (Gehrung, Stossfuge); Ende an Anfang behält die Richtung, gleich orientierte Enden drehen. Zweifarbig
/// über die Kopplungen, Konflikte (ungerade Maschen) bleiben bei der ersten Zuordnung.
fn assign_pattern_flip(result: &mut [WallCuts]) {
    let key = |l: &Line| [l.point.x, l.point.y, l.dir.x, l.dir.y].map(f64::to_bits);
    let mut by_line: HashMap<[u64; 4], Vec<(usize, End)>> = HashMap::new();
    for (i, c) in result.iter().enumerate() {
        for (cut, end) in [(&c.start_cut, End::Start), (&c.end_cut, End::End)] {
            if let Some(l) = cut {
                by_line.entry(key(l)).or_default().push((i, end));
            }
        }
    }
    let mut links: Vec<Vec<(usize, bool)>> = vec![Vec::new(); result.len()];
    let mut groups: Vec<&Vec<(usize, End)>> = by_line.values().filter(|g| g.len() == 2 && g[0].0 != g[1].0).collect();
    groups.sort_by_key(|g| (g[0].0, g[1].0));
    for g in groups {
        let flip = g[0].1 == g[1].1;
        links[g[0].0].push((g[1].0, flip));
        links[g[1].0].push((g[0].0, flip));
    }
    let mut seen = vec![false; result.len()];
    for root in 0..result.len() {
        if seen[root] {
            continue;
        }
        seen[root] = true;
        let mut stack = vec![root];
        while let Some(w) = stack.pop() {
            for &(o, flip) in &links[w] {
                if !seen[o] {
                    seen[o] = true;
                    result[o].pattern_flip = result[w].pattern_flip != flip;
                    stack.push(o);
                }
            }
        }
    }
}

/// [175] Gehrung zweier gerader Wände mit gleicher Schichtfolge (von der Innenseite der Ecke gezählt) und
/// einem Winkel von 50° bis 130°: die längere Wand (bei Gleichstand die zuerst gezeichnete) deckt das
/// Eckquadrat jeder Schicht (`WallCuts::pattern_corner`). Sonst bleibt es bei der Gehrungslinie.
fn assign_pattern_corner(walls: &[JoinWall], a: WallEnd, b: WallEnd, result: &mut [WallCuts]) {
    let (wa, wb) = (&walls[a.wall], &walls[b.wall]);
    if is_arc(wa) || is_arc(wb) {
        return;
    }
    let out_dir = |w: &JoinWall, e: End| {
        let u = dir_of(w);
        if e == End::Start { u } else { scale(u, -1.0) }
    };
    let (da, db) = (out_dir(wa, a.end), out_dir(wb, b.end));
    let c = dot(da, db);
    if !(-0.64..=0.64).contains(&c) {
        return;
    }
    // Schichtdicken von der Innenseite der Ecke aus (Schicht 0 liegt rechts der Laufrichtung).
    let from_inner = |w: &JoinWall, other: Vec2| -> Option<Vec<f64>> {
        let mut t: Vec<f64> = w.layers.as_deref()?.iter().map(|l| l.thickness).collect();
        if dot(left_normal(dir_of(w)), other) > 0.0 {
            t.reverse();
        }
        Some(t)
    };
    let (Some(ta), Some(tb)) = (from_inner(wa, db), from_inner(wb, da)) else { return };
    if ta.is_empty() || ta.len() != tb.len() || ta.iter().zip(&tb).any(|(x, y)| (x - y).abs() > 1e-9) {
        return;
    }
    let (la, lb) = (len(sub(wa.end, wa.start)), len(sub(wb.end, wb.start)));
    let a_owns = la > lb + 1e-9 || ((la - lb).abs() <= 1e-9 && a.wall < b.wall);
    let set = |result: &mut [WallCuts], we: WallEnd, owner: bool, other_dir: Vec2| {
        result[we.wall].pattern_corner[if we.end == End::Start { 0 } else { 1 }] = Some(PatternCorner { owner, other_dir });
    };
    set(result, a, a_owns, db);
    set(result, b, !a_owns, da);
}

/// Berechnet für jede Wand (Index = Eingabe-Reihenfolge) die Gehrungs-/Anschluss-Schnittlinien.
/// `walls` ist die bereits gefilterte Wandmenge (z. B. ein Geschoss).
pub fn compute_joins(walls: &[JoinWall]) -> Result<Vec<WallCuts>, JoinError> {
    let mut result = vec![WallCuts::default(); walls.len()];

    // Knotenkarte in Einfüge-Reihenfolge: gerundeter Endpunkt → dort endende Wandenden.
    // [141] Enden, die nur fast aufeinander liegen (Fanglücke ≤ JOIN_SNAP), gehören zum selben Knoten.
    let mut index: HashMap<(u64, u64), usize> = HashMap::new();
    let mut junctions: Vec<Vec<WallEnd>> = Vec::new();
    let mut reps: Vec<Vec2> = Vec::new();
    let mut push = |p: Vec2, we: WallEnd| {
        let key = round_key(p);
        let near = index.get(&key).copied().or_else(|| reps.iter().position(|r| len(sub(*r, p)) <= JOIN_SNAP));
        match near {
            Some(k) => {
                if !junctions[k].iter().any(|e| e.wall == we.wall) {
                    junctions[k].push(we);
                }
            }
            None => {
                index.insert(key, junctions.len());
                junctions.push(vec![we]);
                reps.push(p);
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
                    set_pair(&mut result, ends[0], ends[1], cut);
                    assign_pattern_corner(walls, ends[0], ends[1], &mut result);
                }
            }
            3.. => apply_node(walls, ends, &mut result)?,
            // Freies Ende (Fall 2 unten).
            _ => {}
        }
    }

    merge_collinear(walls, &mut result);

    // Fall 2: jedes noch ungeschnittene Ende gegen die Mittelspanne aller anderen Wände prüfen
    // (Mittelspannen-T und „+"-Kreuzung). Bereits geschnittene Enden bleiben unangetastet.
    for ends in &junctions {
        for &we in ends {
            let c = &result[we.wall];
            let cut = match we.end {
                End::Start => c.start_cut,
                End::End => c.end_cut,
            };
            if cut.is_none() && !c.covered {
                apply_mid_span_tee(walls, we, &mut result)?;
            }
        }
    }
    assign_pattern_flip(&mut result);
    Ok(result)
}

/// [141] Zwei gerade Wände liegen im selben Band: parallele Achsen, gleiche Schichtfolge (gegenläufig
/// gespiegelt) und deckungsgleiche Flächen. `Some(gegenläufig)`.
/// Bogenwände (Teil 4): gleicher Kreis (Mitte, Radius der Bandmitte), Laufsinn = Drehsinn.
fn same_band(walls: &[JoinWall], a: usize, b: usize) -> Option<bool> {
    let (wa, wb) = (&walls[a], &walls[b]);
    if len(sub(wa.end, wa.start)) < 1e-9 || len(sub(wb.end, wb.start)) < 1e-9 {
        return None;
    }
    let (arc_a, arc_b) = (arc_of(wa), arc_of(wb));
    if arc_a.is_some() != arc_b.is_some() {
        return None;
    }
    if let (Some(ca), Some(cb)) = (arc_a, arc_b) {
        let reversed = ca.sigma() != cb.sigma();
        if len(sub(ca.center, cb.center)) > 1e-6 || !same_layers(wa, wb, reversed)? {
            return None;
        }
        let t = wa.layers.as_deref()?.iter().fold(0.0, |s, l| s + l.thickness);
        let mid = |w: &JoinWall, c: &WallArc| c.radius_at(reference_offset(w.reference, t));
        return ((mid(wa, &ca) - mid(wb, &cb)).abs() < 1e-6).then_some(reversed);
    }
    let (ua, ub) = (dir_of(wa), dir_of(wb));
    if kernel2d::cross(ua, ub).abs() > 1e-6 {
        return None;
    }
    let reversed = dot(ua, ub) < 0.0;
    if !same_layers(wa, wb, reversed)? {
        return None;
    }
    let la = wa.layers.as_deref()?;
    let t = la.iter().fold(0.0, |s, l| s + l.thickness);
    let na = left_normal(ua);
    let ca = add(wa.start, scale(na, reference_offset(wa.reference, t)));
    let cb = add(wb.start, scale(left_normal(ub), reference_offset(wb.reference, t)));
    (dot(sub(cb, ca), na).abs() < 1e-6).then_some(reversed)
}

/// Gleiche Schichtfolge (gegenläufig gespiegelt), alle Bauteile bekannt.
fn same_layers(wa: &JoinWall, wb: &JoinWall, reversed: bool) -> Option<bool> {
    let (la, lb) = (wa.layers.as_deref()?, wb.layers.as_deref()?);
    if la.is_empty() || la.len() != lb.len() {
        return None;
    }
    let same = |x: &JoinLayer, y: &JoinLayer| (x.thickness - y.thickness).abs() < 1e-9 && x.component.is_some() && x.component == y.component;
    Some(if reversed { la.iter().zip(lb.iter().rev()).all(|(x, y)| same(x, y)) } else { la.iter().zip(lb).all(|(x, y)| same(x, y)) })
}

/// [141] Kollineare Wände gleichen Typs im selben Band verschmelzen zu einem Körper: stumpf aneinander
/// (Enden im Knoten ohne Gehrung) eine Stossfuge als Schnitt (keine Trennlinie), überlappend wird die
/// spätere Wand an der früheren gestutzt, eine ganz enthaltene Wand ist verdeckt (`covered`). Enden
/// mit schon gesetztem Schnitt (Ecke, T) bleiben unangetastet.
fn merge_collinear(walls: &[JoinWall], result: &mut [WallCuts]) {
    let cut_of = |c: &WallCuts, e: End| match e {
        End::Start => c.start_cut,
        End::End => c.end_cut,
    };
    for a in 0..walls.len() {
        for b in a + 1..walls.len() {
            if result[a].covered || result[b].covered || same_band(walls, a, b).is_none() {
                continue;
            }
            let wa = &walls[a];
            let u = dir_of(wa);
            // Bogen (Teil 4): Achsmass = Bogenlänge, Fuge radial.
            let arc = arc_of(wa);
            let a1 = arc.map_or_else(|| len(sub(wa.end, wa.start)), |c| c.length());
            let tb = |p: Vec2| arc.map_or_else(|| dot(sub(p, wa.start), u), |c| c.local(p).0);
            let (s, e) = match (arc, arc_of(&walls[b])) {
                // Bogen: Ende über die eigene Bogenlänge (der Rahmen von a wickelt sonst beim Ring um).
                (Some(ca), Some(cb)) => {
                    let s = tb(walls[b].start);
                    (s, s + if ca.sigma() == cb.sigma() { cb.length() } else { -cb.length() })
                }
                _ => (tb(walls[b].start), tb(walls[b].end)),
            };
            if arc.is_some() {
                // Stumpf im Knoten (auch beide Enden, Ring aus zwei Bögen): schon radial gestossen.
                for ea in [End::Start, End::End] {
                    for eb in [End::Start, End::End] {
                        let (ca, cb) = (cut_of(&result[a], ea), cut_of(&result[b], eb));
                        if len(sub(point_of(wa, ea), point_of(&walls[b], eb))) <= JOIN_SNAP && ca.is_some() && ca == cb {
                            result[a].collinear[(ea == End::End) as usize] = true;
                            result[b].collinear[(eb == End::End) as usize] = true;
                        }
                    }
                }
            }
            // b im Rahmen von a: unteres/oberes Ende.
            let (lo, lo_end, hi, hi_end) = if s <= e { (s, End::Start, e, End::End) } else { (e, End::End, s, End::Start) };
            if hi < -JOIN_SNAP || lo > a1 + JOIN_SNAP {
                continue;
            }
            if lo >= -JOIN_SNAP && hi <= a1 + JOIN_SNAP {
                result[b].covered = true;
                continue;
            }
            if lo <= JOIN_SNAP && hi >= a1 - JOIN_SNAP {
                result[a].covered = true;
                continue;
            }
            // Teilüberlappung oder Stoss: die Fuge liegt am Ende von a, das in b liegt.
            let (a_end, t, b_end) = if lo > 0.0 { (End::End, a1, lo_end) } else { (End::Start, 0.0, hi_end) };
            let joint = match arc {
                Some(c) => Line { point: c.point(t, 0.0), dir: c.normal(t) },
                None => Line { point: add(wa.start, scale(u, t)), dir: left_normal(u) },
            };
            if cut_of(&result[a], a_end).is_some() || cut_of(&result[b], b_end).is_some() {
                continue;
            }
            // Stoss mitten auf einer dritten Wand („+"-Kreuzung): die beiden stossen dort an (Fall 2).
            if ((lo - a1).abs() <= JOIN_SNAP || hi.abs() <= JOIN_SNAP) && (0..walls.len()).any(|w| w != a && w != b && inside_span(walls, w, joint.point)) {
                continue;
            }
            set_pair(result, WallEnd { wall: a, end: a_end }, WallEnd { wall: b, end: b_end }, joint);
            result[a].collinear[(a_end == End::End) as usize] = true;
            result[b].collinear[(b_end == End::End) as usize] = true;
        }
    }
}

/// Punkt liegt in der inneren Spanne des Wandbands `wi` (gerade Wand, Fangtoleranz wie Fall 2).
fn inside_span(walls: &[JoinWall], wi: usize, p: Vec2) -> bool {
    let w = &walls[wi];
    let l = len(sub(w.end, w.start));
    if is_arc(w) || l < 1e-9 {
        return false;
    }
    let Ok(t) = thickness(walls, wi) else { return false };
    let u = dir_of(w);
    let along = dot(sub(p, w.start), u);
    let perp = dot(sub(p, w.start), left_normal(u));
    along > 1e-4 && along < l - 1e-4 && (perp - reference_offset(w.reference, t)).abs() <= t / 2.0 + JOIN_SNAP
}

/// [141] Fangtoleranz der Verschneidung (m): Enden mit kleinerem Abstand bilden einen Knoten, ein
/// freies Ende so nah vor einer Wandfläche stösst an sie.
pub const JOIN_SNAP: f64 = 0.01;

/// Rang einer Wand im Knoten: höchste Schicht-Priorität, dann Dicke.
fn wall_rank(walls: &[JoinWall], i: usize) -> R<(f64, f64)> {
    let ls = layers_of(walls, i)?;
    Ok((ls.iter().fold(f64::NEG_INFINITY, |m, l| m.max(l.priority)), ls.iter().fold(0.0, |s, l| s + l.thickness)))
}

fn rank_lt(a: (f64, f64), b: (f64, f64)) -> bool {
    a.0 < b.0 || (a.0 == b.0 && a.1 < b.1 - 1e-9)
}

/// [141] Knoten mit ≥ 3 Enden: das stärkste Wandpaar (Rang der schwächeren Wand; bei Gleichstand
/// der Durchgang) verbindet sich — kollinear als Durchgang, sonst auf Gehrung —, alle übrigen Enden
/// stossen an dieses Paar (Abzweig am Durchgang wie am T, an der Ecke an die zuerst getroffene Fläche).
/// Vorher: nur drei Enden mit kollinearem Paar (der Durchgang auch aus Wänden ungleichen Typs, etwa
/// Aussen- und Innenwand, während die Aussenwand-Ecke offen blieb), vier Enden blieben rechtwinklig.
fn apply_node(walls: &[JoinWall], ends: &[WallEnd], result: &mut [WallCuts]) -> R<()> {
    // Nulllängen-Wände tragen nichts bei.
    let ends: Vec<WallEnd> = ends.iter().copied().filter(|e| len(sub(walls[e.wall].end, walls[e.wall].start)) > 1e-9).collect();
    let ends = &ends[..];
    let n = ends.len();
    if n < 2 {
        return Ok(());
    }
    if n == 2 {
        if let Some(cut) = miter_line(walls, ends[0].wall, ends[0].end, ends[1].wall)? {
            set_pair(result, ends[0], ends[1], cut);
        }
        return Ok(());
    }
    let arcs = ends.iter().any(|e| is_arc(&walls[e.wall]));
    let into: Vec<Vec2> = ends
        .iter()
        .map(|e| {
            let u = dir_at(&walls[e.wall], e.end);
            if e.end == End::Start {
                u
            } else {
                scale(u, -1.0)
            }
        })
        .collect();
    let mut rank = Vec::with_capacity(n);
    for e in ends {
        // Unbekannter Wandtyp: schwächste Wand (der Fehler kommt, wo ihre Dicke gebraucht wird).
        rank.push(wall_rank(walls, e.wall).unwrap_or((f64::NEG_INFINITY, 0.0)));
    }
    let mut best: Option<(usize, usize, (f64, f64), bool)> = None;
    for i in 0..n {
        for k in i + 1..n {
            let c = dot(into[i], into[k]);
            let parallel = 1.0 - c.abs() < 1e-6;
            if parallel && c > 0.0 {
                continue; // gleichgerichtet übereinander: kein Paar
            }
            let r = if rank_lt(rank[i], rank[k]) { rank[i] } else { rank[k] };
            let better = match best {
                None => true,
                Some((_, _, br, bs)) => rank_lt(br, r) || (!rank_lt(r, br) && parallel && !bs),
            };
            if better {
                best = Some((i, k, r, parallel));
            }
        }
    }
    let Some((i, k, _, straight)) = best else { return Ok(()) };
    if n == 3 && straight {
        return apply_t_junction(walls, ends, result);
    }
    let others: Vec<usize> = (0..n).filter(|&b| b != i && b != k).collect();
    if straight {
        for b in others {
            t_branch(walls, ends[i], ends[k], ends[b], arcs, result)?;
        }
        return Ok(());
    }
    if let Some(cut) = miter_line(walls, ends[i].wall, ends[i].end, ends[k].wall)? {
        set_pair(result, ends[i], ends[k], cut);
    }
    for b in others {
        let bw = &walls[ends[b].wall];
        let p = point_of(bw, ends[b].end);
        // [141] Y-Knoten: liegt die Ecke der beiden zugewandten Flächen im Band des Asts, endet er an
        // beiden (Kerbe bzw. Spitze) statt nur an einer (vorher überlappte er die andere Eckwand).
        if y_notch(walls, ends, &into, i, k, b, arcs, result)? {
            continue;
        }
        // Zugewandte Fläche jeder Eckwand; der Abzweig endet an der, die er (von seinem fernen Ende
        // her) zuerst trifft.
        let mut pick: Option<(usize, f64)> = None;
        for &q in &[i, k] {
            let qi = ends[q].wall;
            let qw = &walls[qi];
            let tq = thickness(walls, qi)?;
            let uq = dir_at(qw, ends[q].end);
            let nq = left_normal(uq);
            let facing = dot(nq, into[b]);
            if facing.abs() < 1e-6 {
                continue;
            }
            let sign = if facing > 0.0 { 1.0 } else { -1.0 };
            let face = add(point_of(qw, ends[q].end), scale(nq, reference_offset(qw.reference, tq) + sign * tq / 2.0));
            let Some(hit) = line_intersect(p, into[b], face, uq) else { continue };
            let t = dot(sub(hit, p), into[b]);
            if pick.map_or(true, |(_, bt)| t > bt) {
                pick = Some((qi, t));
            }
        }
        if let Some((qi, _)) = pick {
            let (along, perp) = local_of(&walls[qi], p);
            tee_on(walls, ends[b], qi, perp, along, result)?;
        }
    }
    Ok(())
}

/// [141] Y-Knoten: der Ast `b` stösst an das Eckpaar `i`/`k`. Die beiden ihm zugewandten Flächen
/// treffen sich in der Ecke K (Aussenecke: Kerbe, Innenecke: Spitze). Liegt K im Band des Asts, bekommt
/// er beide Flächen als Schnitt — je Seite von K die Fläche der Eckwand, die auf dieser Seite liegt
/// (`*_cut` unter, `*_cut2` über K im Querversatz des Asts). `false`: K liegt ausserhalb (eine Fläche
/// genügt, Stoss wie bisher).
///
/// Bogenwände (`arcs`, Teil 4): Seiten über die Tangenten am Knoten, K als Schnitt der Flächenkurven
/// (Gerade/Kreis). Die Fläche einer Bogen-Eckwand wird zur Geraden durch K und den Treffer der Ast-Fläche
/// dieser Seite (Sehne wie am T-Stoss auf einen Bogen, exakt an beiden Ast-Flächen und in K).
#[allow(clippy::too_many_arguments)]
fn y_notch(walls: &[JoinWall], ends: &[WallEnd], into: &[Vec2], i: usize, k: usize, b: usize, arcs: bool, result: &mut [WallCuts]) -> R<bool> {
    let bi = ends[b].wall;
    let bw = &walls[bi];
    let u_b = if arcs { dir_at(bw, ends[b].end) } else { dir_of(bw) };
    // (Gerade der Fläche am Knoten, Seite, Flächenkurve, Bogen?)
    let mut faces: Vec<(Line, f64, Curve, bool)> = Vec::with_capacity(2);
    for &q in &[i, k] {
        let qi = ends[q].wall;
        let qw = &walls[qi];
        let tq = thickness(walls, qi)?;
        let uq = if arcs { dir_at(qw, ends[q].end) } else { dir_of(qw) };
        let nq = left_normal(uq);
        let facing = dot(nq, into[b]);
        if facing.abs() < 1e-6 {
            return Ok(false);
        }
        let sign = if facing > 0.0 { 1.0 } else { -1.0 };
        let off = reference_offset(qw.reference, tq) + sign * tq / 2.0;
        let point = add(point_of(qw, ends[q].end), scale(nq, off));
        faces.push((Line { point, dir: uq }, dot(into[q], left_normal(u_b)), offset_curve(qw, off), is_arc(qw)));
    }
    let (lo, hi) = match (faces[0].1 > 1e-6, faces[1].1 > 1e-6, faces[0].1 < -1e-6, faces[1].1 < -1e-6) {
        (false, true, true, _) => (faces[0].clone(), faces[1].clone()),
        (true, false, _, true) => (faces[1].clone(), faces[0].clone()),
        _ => return Ok(false),
    };
    let Some(mut corner) = line_intersect(lo.0.point, lo.0.dir, hi.0.point, hi.0.dir) else { return Ok(false) };
    if lo.3 || hi.3 {
        let Some(c) = hit_near(&lo.2, &hi.2, corner) else { return Ok(false) };
        corner = c;
    }
    let tb = thickness(walls, bi)?;
    let node = point_of(bw, ends[b].end);
    if len(sub(corner, node)) > 4.0 * (tb + thickness(walls, ends[i].wall)? + thickness(walls, ends[k].wall)?) {
        return Ok(false);
    }
    let ob = reference_offset(bw.reference, tb);
    let perp = if arcs { local_of(bw, corner).1 } else { dot(sub(corner, bw.start), left_normal(dir_of(bw))) };
    if perp <= ob - tb / 2.0 + 1e-6 || perp >= ob + tb / 2.0 - 1e-6 {
        return Ok(false);
    }
    // Fläche einer Bogen-Eckwand: Gerade durch K und den Treffer der Ast-Fläche dieser Seite.
    let line_of = |f: &(Line, f64, Curve, bool), side_off: f64| -> Option<Line> {
        if !f.3 {
            return Some(f.0);
        }
        let h = hit_near(&offset_curve(bw, side_off), &f.2, corner)?;
        let d = sub(h, corner);
        (len(d) > 1e-9).then_some(Line { point: corner, dir: d })
    };
    let (Some(lo_l), Some(hi_l)) = (line_of(&lo, ob - tb / 2.0), line_of(&hi, ob + tb / 2.0)) else { return Ok(false) };
    set_cut(result, ends[b], lo_l);
    let c = &mut result[bi];
    match ends[b].end {
        End::Start => c.start_cut2 = Some(hi_l),
        End::End => c.end_cut2 = Some(hi_l),
    }
    Ok(true)
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
    // [141] Flächen von B durch B's eigenes Ende (Fangtoleranz: die Enden liegen nur fast aufeinander).
    let b_at_start = len(sub(b.start, j)) <= len(sub(b.end, j));
    let jb = if b_at_start { b.start } else { b.end };
    let p_lb = add(jb, scale(n_b, off_b + t_b / 2.0));
    let p_rb = add(jb, scale(n_b, off_b - t_b / 2.0));

    let d_a = if a_end == End::Start { u_a } else { scale(u_a, -1.0) };
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
        // [141] Nur im selben Band (gleicher Kreis und Typ); sonst freie radiale Enden mit Stosslinie
        // (Materialwechsel wie bei kollinearen geraden Wänden ungleichen Typs).
        return Ok((dot(d_a, d_b) < 0.0 && (!(is_arc(a) && is_arc(b)) || same_band(walls, ai, bi).is_some())).then_some(Line { point: j, dir: n_a }));
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
    t_branch(walls, ends[t0], ends[t1], ends[branch_idx], arcs, result)
}

/// Abzweig `branch_end` am Durchgang `through_end`/`other_end` (T-Knoten; am Kreuz-Knoten je Abzweig).
fn t_branch(walls: &[JoinWall], through_end: WallEnd, other_end: WallEnd, branch_end: WallEnd, arcs: bool, result: &mut [WallCuts]) -> R<()> {
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
    set_pair(result, through_end, other_end, joint);
    apply_layer_cuts(walls, result, branch_end, ti, Some(other_end.wall), face_cut, j, u_t, sign)
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

    // Rückgrat der Durchgangswand: die tragende Schicht — grösstes Produkt aus joinPriority und Dicke
    // (erste gewinnt). [141] Vorher die höchste Priorität allein: bei der Holzständerwand die äussere
    // Lattung (41), der Backstein-Abzweig (50) lief durch Gipskarton, Dämmung und Holzfaser bis aussen.
    let score = |l: &JoinLayer| l.priority * l.thickness;
    let mut backbone = (component(ti, &through_layers[0])?, through_layers[0].priority);
    let mut backbone_idx = 0;
    for (i, l) in through_layers.iter().enumerate() {
        let c = component(ti, l)?;
        if score(l) > score(&through_layers[backbone_idx]) {
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

    // (Wand, perp, dist, distAlong)
    let mut best: Option<(usize, f64, f64, f64)> = None;
    for (wi, w) in walls.iter().enumerate() {
        // [141] Verdeckte Wand (in einer kollinearen gleichen Typs): der Stoss gilt der umfassenden.
        if wi == fi || result[wi].covered {
            continue;
        }
        if let Some(a) = arc_of(w) {
            let (dist_along, perp) = a.local(p);
            if dist_along <= END_GAP || dist_along >= a.length() - END_GAP {
                continue;
            }
            let tw = thickness(walls, wi)?;
            let dist = (perp - reference_offset(w.reference, tw)).abs();
            if dist > tw / 2.0 + JOIN_SNAP {
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
        // [141] Abstand zum Wandband (Referenzlinie beachtet); ein Ende knapp vor der Fläche fängt.
        let dist = (perp - reference_offset(w.reference, tw)).abs();
        if dist > tw / 2.0 + JOIN_SNAP {
            continue;
        }
        if best.map_or(true, |b| dist < b.2) {
            best = Some((wi, perp, dist, dist_along));
        }
    }
    let Some((wi, perp, _, dist_along)) = best else { return Ok(()) };
    tee_on(walls, free, wi, perp, dist_along, result)
}

/// Freies Ende `free` stösst an die Seite der Wand `wi` (Achsmass `dist_along`, Querversatz `perp`
/// des Endes im Rahmen von `wi`): Schnitt an der zugewandten Fläche, materialbewusst je Schicht.
fn tee_on(walls: &[JoinWall], free: WallEnd, wi: usize, perp: f64, dist_along: f64, result: &mut [WallCuts]) -> R<()> {
    let free_wall = &walls[free.wall];
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
    Some(WallCuts { start_cut, end_cut, layer_cuts, span_cutouts, ..Default::default() })
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
    /// [141] Kreuz-Knoten aus vier Enden (vorher „Stern", rechtwinklig übereinander): ein Paar läuft
    /// durch (Stossfuge), die beiden anderen stossen an seine Flächen.
    #[test]
    fn kreuz_knoten_durchgang_und_zwei_abzweige() {
        let w = vec![mono((0.0, 5.0), (5.0, 5.0), 0.3), mono((5.0, 5.0), (10.0, 5.0), 0.3), mono((5.0, 5.0), (5.0, 0.0), 0.3), mono((5.0, 5.0), (5.0, 10.0), 0.3)];
        let c = compute_joins(&w).unwrap();
        let j0 = c[0].end_cut.unwrap();
        let j1 = c[1].start_cut.unwrap();
        assert!(close(j0.point.x, 5.0) && close(j0.dir.x, 0.0) && close(j1.point.x, 5.0));
        assert!(close(c[2].start_cut.unwrap().point.y, 4.85), "{:?}", c[2]);
        assert!(close(c[3].start_cut.unwrap().point.y, 5.15), "{:?}", c[3]);
    }

    /// [141] Knoten aus Aussenwand-Ecke und Innenwand, die kollinear mit einem Aussenwand-Schenkel
    /// weiterläuft (Anbau): die Aussenwände bilden die Gehrung, die Innenwand stösst an; vorher lief
    /// Aussenwand plus Innenwand als Durchgang und die Ecke blieb offen.
    #[test]
    fn knoten_ecke_vor_ungleichem_durchgang() {
        let ext = || vec![JoinLayer { thickness: 0.4, component: Some(0), priority: 50.0 }];
        let int = || vec![JoinLayer { thickness: 0.12, component: Some(1), priority: 50.0 }];
        let w = vec![wall((5.0, 10.0), (0.0, 10.0), ext()), wall((5.0, 15.0), (5.0, 10.0), ext()), wall((10.0, 10.0), (5.0, 10.0), int())];
        let c = compute_joins(&w).unwrap();
        let m0 = c[0].start_cut.unwrap();
        let m1 = c[1].end_cut.unwrap();
        assert_eq!(m0, m1);
        assert!(close((m0.dir.x / m0.dir.y).abs(), 1.0), "Gehrung 45°: {m0:?}");
        let e = c[2].end_cut.unwrap();
        assert!(close(e.point.x, 5.2) && close(e.dir.x, 0.0), "{e:?}");
    }

    /// [141] Holzständerwand mit Backstein-Abzweig: das Rückgrat ist die Ständer-/Dämmschicht (grösstes
    /// Produkt Rang × Dicke), nicht die äussere Lattung mit der höchsten Priorität — der Kern des
    /// Abzweigs endet an der Innenfläche der Dämmschicht statt die ganze Wand zu durchstossen.
    #[test]
    fn rueckgrat_holzstaenderwand_ist_die_staenderschicht() {
        let l = |t: f64, c: u32, p: f64| JoinLayer { thickness: t, component: Some(c), priority: p };
        let holz = vec![l(0.024, 0, 41.0), l(0.04, 1, 1.0), l(0.06, 2, 24.0), l(0.2385, 3, 20.0), l(0.015, 4, 35.0), l(0.0125, 5, 12.0)];
        let total: f64 = holz.iter().map(|x| x.thickness).sum();
        let iw = vec![l(0.01, 6, 10.0), l(0.125, 7, 50.0), l(0.01, 6, 10.0)];
        let w = vec![wall((0.0, 0.0), (10.0, 0.0), holz), wall((4.0, 0.0), (4.0, 3.0), iw)];
        let c = compute_joins(&w).unwrap();
        let lc = c[1].layer_cuts.as_ref().unwrap();
        // Gipskarton und Holzwerkstoff (+n-Seite) liegen vor dem Rückgrat: 0.0275 m.
        assert!(close(lc.start[1].unwrap().point.y, total / 2.0 - 0.0275), "{:?}", lc.start[1]);
    }

    /// [141] Fanglücke: Enden 4 mm auseinander bilden trotzdem die Gehrung, ein Abzweig 5 mm vor der
    /// Fläche stösst an (vorher rechtwinklige Enden mit Lücke bzw. Überlappung).
    #[test]
    fn fangluecke_wenige_millimeter() {
        let w = vec![mono((0.0, 0.0), (5.0, 0.0), 0.3), mono((5.004, 0.003), (5.004, 4.0), 0.3), mono((2.0, 3.84), (2.0, 0.155), 0.1)];
        let c = compute_joins(&w).unwrap();
        let (a, b) = (c[0].end_cut.unwrap(), c[1].start_cut.unwrap());
        assert_eq!(a, b);
        let on = |x: f64, y: f64| (kernel2d::cross(a.dir, sub(Vec2 { x, y }, a.point))).abs() < 1e-9;
        assert!(on(5.154, -0.15) && on(4.854, 0.15), "{a:?}");
        let s = c[2].end_cut.unwrap();
        assert!(close(s.point.y, 0.15) && close(s.dir.y, 0.0), "{s:?}");
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
        for mut c in compute_joins(&w).unwrap() {
            // [175] Wie `pattern_flip` nur für den Grundriss im Kern, nicht Teil der Kodierung.
            c.pattern_corner = Default::default();
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

    // ── [141] Teil 4: Bogenwände an Wandknoten ──

    fn polar(r: f64, deg: f64) -> (f64, f64) {
        let a = deg.to_radians();
        (r * a.cos(), r * a.sin())
    }
    /// Querversatz eines Punkts zur Achse der Wand (Bogen: zur Kreisachse).
    fn perp_of(w: &JoinWall, p: Vec2) -> f64 {
        local_of(w, p).1
    }

    /// Y-Knoten mit Bogenwand: der dritte Ast endet an BEIDEN zugewandten Flächen des Eckpaars (Knick K
    /// auf beiden Flächen), auch wenn der Ast oder eine Eckwand ein Bogen ist.
    #[test]
    fn bogen_y_knoten_ast_an_beiden_flaechen() {
        let t = 0.3;
        let cases: Vec<(&str, Vec<JoinWall>)> = vec![
            ("Ast Bogen", vec![mono((0.0, 0.0), polar(3.0, 0.0), t), mono((0.0, 0.0), polar(3.0, 120.0), t), arc_wall((0.0, 0.0), polar(3.0, 240.0), 0.2, t)]),
            ("Ast Bogen gegenläufig", vec![mono((0.0, 0.0), polar(3.0, 0.0), t), mono((0.0, 0.0), polar(3.0, 120.0), t), arc_wall(polar(3.0, 240.0), (0.0, 0.0), -0.25, t)]),
            ("Eckwand Bogen", vec![arc_wall((0.0, 0.0), polar(3.0, 0.0), 0.15, t), mono((0.0, 0.0), polar(3.0, 120.0), t), mono((0.0, 0.0), polar(3.0, 240.0), t)]),
            ("alle Bogen", vec![arc_wall((0.0, 0.0), polar(3.0, 0.0), -0.15, t), arc_wall(polar(3.0, 120.0), (0.0, 0.0), 0.2, t), arc_wall((0.0, 0.0), polar(3.0, 240.0), 0.1, t)]),
        ];
        for (what, w) in cases {
            let c = compute_joins(&w).unwrap();
            let b = &c[2];
            let (lo, hi) = if w[2].start == Vec2::new(0.0, 0.0) { (b.start_cut, b.start_cut2) } else { (b.end_cut, b.end_cut2) };
            let (lo, hi) = (lo.expect(what), hi.unwrap_or_else(|| panic!("{what}: zweite Schnittlinie")));
            let k = line_intersect(lo.point, lo.dir, hi.point, hi.dir).unwrap();
            // K liegt auf je einer Fläche beider Eckwände und im Band des Asts.
            for q in 0..2 {
                assert!(close(perp_of(&w[q], k).abs(), t / 2.0), "{what}: K {k:?} nicht auf Fläche von {q}");
            }
            assert!(perp_of(&w[2], k).abs() < t / 2.0, "{what}: K ausserhalb des Asts");
            // Jede Linie trifft die Ast-Fläche auf ihrer Seite dort, wo diese die Eckwand-Fläche trifft.
            for (l, side) in [(lo, -1.0), (hi, 1.0)] {
                let face = offset_curve(&w[2], side * t / 2.0);
                let hits = match face {
                    Curve::Line(f) => line_intersect(l.point, l.dir, f.point, f.dir).into_iter().collect::<Vec<_>>(),
                    Curve::Circle(cc, r) => crate::wall_arc::circle_line(cc, r, &l),
                };
                let h = nearest(hits, k).expect("Treffer");
                let on = (0..2).filter(|&q| close(perp_of(&w[q], h).abs(), t / 2.0)).count();
                assert!(on >= 1, "{what}: Linie {side} trifft die Astfläche nicht auf einer Eckwand-Fläche ({h:?})");
            }
        }
    }

    /// Bogen um den Ursprung im Gegenuhrzeigersinn (Modell-Bulge: positiv = Scheitel links → hier negativ).
    fn arc_ccw(r: f64, a0: f64, a1: f64, t: f64) -> JoinWall {
        arc_wall(polar(r, a0), polar(r, a1), -((a1 - a0).to_radians() / 4.0).tan(), t)
    }

    /// Bogenwände mit gleichem Kreis und Typ: stumpf (Stossfuge, beide Enden `collinear`), überlappend
    /// (die spätere an der früheren gestutzt, radial), ganz enthalten (`covered`); anderer Radius bleibt
    /// getrennt.
    #[test]
    fn bogen_kollinear_gleicher_kreis() {
        let t = 0.2;
        // Stumpf.
        let c = compute_joins(&[arc_ccw(4.0, 0.0, 60.0, t), arc_ccw(4.0, 60.0, 120.0, t)]).unwrap();
        assert!(c[0].collinear[1] && c[1].collinear[0], "{c:?}");
        // Überlappend: Fuge radial am Ende der ersten (80°).
        let c = compute_joins(&[arc_ccw(4.0, 0.0, 80.0, t), arc_ccw(4.0, 50.0, 120.0, t)]).unwrap();
        let j = c[0].end_cut.expect("Fuge");
        assert_eq!(c[1].start_cut, Some(j));
        assert!(c[0].collinear[1] && c[1].collinear[0]);
        let (px, py) = polar(4.0, 80.0);
        assert!(dist(&j, Vec2::new(px, py)) < 1e-9 && dist(&j, Vec2::new(0.0, 0.0)) < 1e-9, "radial: {j:?}");
        // Gegenläufig (symmetrischer Typ).
        let c = compute_joins(&[arc_ccw(4.0, 0.0, 80.0, t), arc_wall(polar(4.0, 120.0), polar(4.0, 50.0), (70f64.to_radians() / 4.0).tan(), t)]).unwrap();
        assert!(c[0].collinear[1] && c[1].collinear[1], "{c:?}");
        // Ganz enthalten.
        let c = compute_joins(&[arc_ccw(4.0, 0.0, 120.0, t), arc_ccw(4.0, 30.0, 60.0, t)]).unwrap();
        assert!(c[1].covered && !c[0].covered);
        // Ring aus zwei Halbkreisen: beide Stösse sind Stossfugen, keine Wand verdeckt.
        let c = compute_joins(&[arc_ccw(4.0, 0.0, 180.0, t), arc_ccw(4.0, 180.0, 360.0, t)]).unwrap();
        assert!(c.iter().all(|k| !k.covered && k.collinear == [true; 2]), "{c:?}");
        // Anderer Radius: getrennt.
        let c = compute_joins(&[arc_ccw(4.0, 0.0, 80.0, t), arc_ccw(4.5, 50.0, 120.0, t)]).unwrap();
        assert!(!c[0].covered && !c[1].covered && c[0].collinear == [false; 2] && c[1].collinear == [false; 2]);
    }
}
