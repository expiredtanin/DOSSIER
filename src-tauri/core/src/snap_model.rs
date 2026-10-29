//! Fang-Kandidaten aus dem Modell ([K4] S3, vorher `baseSegments`/`collectCircles`/`roomAnchors`/
//! `ellipseCenters` in `src/tools/snapping.ts`) und die Fang-Abfrage je Mausbewegung.
//!
//! **Sammeln** (einmal je Dokument-Stand, Geschoss und sichtbaren Ebenen, [`SnapCache::hold`]): zwei
//! Teile, damit eine Änderung an Wänden nicht die (vielen) Zeichnungen neu sammelt und umgekehrt:
//! - Modell: Strecken der Wandachsen und Schichtgrenzen, Raum-, Decken- (mit Aussparungen), Dach-,
//!   Treppen- und Stützen-Umrisse (Reihenfolge wie bisher), Kreise der runden Stützen und der
//!   Wendeltreppen-Bögen, Raum-Stempel-Anker (fixer Anker, sonst Flächenschwerpunkt).
//! - Zeichnungen: Strecken (Linie, Konstruktionslinie/Strahl weit verlängert, Polylinie (Sehnen),
//!   Rechteck, Bezier/Spline tesselliert), Kreise/Bögen, Ellipsen-Mittelpunkte.
//!
//! Schlüssel: Epoche + Feld-Stände des Dokuments (`Revs`), Geschoss, Ebenen-Codes. Ein unverändertes
//! Dokument liefert dieselbe Nummer; TS fragt je Mausbewegung nur noch mit ihr.
//!
//! **Abfrage** ([`query`]): Strecken-Fang (`snap.rs`) über beide Teile plus Entwurf und Blatt-
//! Geometrie; ab mehr als 2000 Zeichnungen im Projekt (Nahmodus, wie bisher) nur die Strecken bis
//! `6 · tol` vom Cursor, nach Abstand sortiert, Schnittpunkte unter den 64 nächsten. Dazu die
//! Blöcke Raum-Anker (Endpunkt) und Kreise (Mittelpunkt, Quadranten, Bogen-Endpunkte, Tangente vom
//! letzten Punkt) samt Ellipsen-Mittelpunkten. Bewertung wie in TS (`consider`); TS führt die Blöcke
//! in seiner Reihenfolge mit Teilpunkten, Parallele und Entwurfspunkten zusammen.

use crate::jsmath::hypot2;
use crate::jsnum;
use crate::model::{ColumnProfile, Drawing2DGeom, Project, SplineMode, Vec2, WallReferenceLine};
use crate::snap::{snap_segments, Best, Cand, SnapQuery, SnapSet, F_ENDPOINT, K_CENTER, K_ENDPOINT, K_QUADRANT, K_TANGENT};
use std::collections::HashSet;
use std::rc::Rc;

/// Mittelpunkt/Quadranten (Kreise, Ellipsen).
pub const F_CENTER: u32 = 32;
/// Tangente vom letzten Punkt an Kreise/Bögen.
pub const F_TANGENT: u32 = 64;
/// Strecken-Fang überhaupt (eine der Strecken-Arten oder Parallele aktiv: Verweilen braucht ihn).
pub const F_SEGS: u32 = 128;

/// Ab so vielen Zeichnungen im Projekt: nur Strecken in Cursornähe (`LARGE_DRAWINGS`).
const LARGE_DRAWINGS: usize = 2000;
/// Verlängerung von Konstruktionslinie/Strahl (Meter).
const XLINE_EXT: f64 = 1000.0;

type Seg = [f64; 4];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Circle {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    /// Bogen `(a0, a1)`; `None` = Vollkreis.
    pub arc: Option<(f64, f64)>,
}

/// Gesammelte Kandidaten eines Teils.
#[derive(Default)]
pub struct SnapPart {
    pub segs: SnapSet,
    pub circles: Vec<Circle>,
    pub anchors: Vec<(f64, f64)>,
    pub ellipses: Vec<(f64, f64)>,
}

fn seg(a: &Vec2, b: &Vec2) -> Seg {
    [a.x, a.y, b.x, b.y]
}

/// Kanten eines geschlossenen Polygons (`closedPolySegs`).
fn closed_poly(pts: &[Vec2], out: &mut Vec<Seg>) {
    for w in pts.windows(2) {
        out.push(seg(&w[0], &w[1]));
    }
    if pts.len() > 2 {
        out.push(seg(&pts[pts.len() - 1], &pts[0]));
    }
}

fn chain(pts: &[Vec2], out: &mut Vec<Seg>) {
    for w in pts.windows(2) {
        out.push(seg(&w[0], &w[1]));
    }
}

fn flat(pts: &[Vec2]) -> Vec<f64> {
    pts.iter().flat_map(|p| [p.x, p.y]).collect()
}

fn pts_of(f: &[f64]) -> Vec<Vec2> {
    f.chunks_exact(2).map(|c| Vec2 { x: c[0], y: c[1] }).collect()
}

/// Schichtgrenzen einer Wand (`wallLayerBoundarySegments`): äussere Fläche, jede Fuge, innere Fläche,
/// je parallel zur Achse um den kumulierten Versatz entlang der linken Normalen.
pub fn wall_layer_segments(p: &Project, w: &crate::model::Wall, out: &mut Vec<Seg>) {
    let Some(wt) = p.wall_type(w) else { return };
    let total = wt.layers.iter().fold(0.0, |s, l| s + l.thickness);
    let half = total / 2.0;
    let ref_off = match (w.reference_offset, &w.reference_line) {
        (Some(v), _) => jsnum::max(-half, jsnum::min(half, v)),
        (None, Some(WallReferenceLine::Left)) => half,
        (None, Some(WallReferenceLine::Right)) => -half,
        _ => 0.0,
    };
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = hypot2(dx, dy);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let (ux, uy) = (dx / l, dy / l);
    let (nx, ny) = (-uy, ux);
    let boundary = |o: f64| [w.start.x + nx * o, w.start.y + ny * o, w.end.x + nx * o, w.end.y + ny * o];
    let mut off = ref_off - total / 2.0;
    out.push(boundary(off));
    for layer in &wt.layers {
        off += layer.thickness;
        out.push(boundary(off));
    }
}

/// Modell-Teil eines Geschosses (alles ausser den 2D-Zeichnungen).
pub fn collect_model(p: &Project, level: &str, codes: &HashSet<String>) -> SnapPart {
    let vis = |floor: &str, code: &str| floor == level && codes.contains(code);
    let mut segs: Vec<Seg> = Vec::new();
    for w in &p.walls {
        if vis(&w.floor_id, &w.category_code) {
            segs.push(seg(&w.start, &w.end));
            wall_layer_segments(p, w, &mut segs);
        }
    }
    let mut anchors = Vec::new();
    for r in p.rooms.as_deref().unwrap_or(&[]) {
        if vis(&r.floor_id, &r.category_code) {
            closed_poly(&r.boundary, &mut segs);
        }
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        if vis(&c.floor_id, &c.category_code) {
            closed_poly(&c.outline, &mut segs);
            for hole in c.openings.as_deref().unwrap_or(&[]) {
                closed_poly(hole, &mut segs);
            }
        }
    }
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        if vis(&r.floor_id, &r.category_code) {
            closed_poly(&r.outline, &mut segs);
        }
    }
    let mut stair_arcs = Vec::new();
    for s in p.stairs.as_deref().unwrap_or(&[]) {
        if !vis(&s.floor_id, &s.category_code) {
            continue;
        }
        // `stairOutline`: `[0, n, Punkte…]` Polygon, `[1, 4 Punkte, 2 × (cx, cy, r, a0, a1)]` Wendel.
        let f = crate::stair::outline(&s.encode());
        match f.first() {
            Some(&k) if k == 0.0 && f.len() >= 2 => {
                let n = f[1] as usize;
                closed_poly(&pts_of(&f[2..(2 + 2 * n).min(f.len())]), &mut segs);
            }
            Some(_) if f.len() >= 19 => {
                segs.push([f[1], f[2], f[3], f[4]]);
                segs.push([f[5], f[6], f[7], f[8]]);
                for k in 0..2 {
                    let j = 9 + 5 * k;
                    stair_arcs.push(Circle { cx: f[j], cy: f[j + 1], r: f[j + 2], arc: Some((f[j + 3], f[j + 4])) });
                }
            }
            _ => {}
        }
    }
    let mut circles = Vec::new();
    for col in p.columns.as_deref().unwrap_or(&[]) {
        if !vis(&col.floor_id, &col.category_code) {
            continue;
        }
        match col.profile {
            ColumnProfile::Rect { .. } => closed_poly(&crate::model3d::column_footprint(col), &mut segs),
            ColumnProfile::Round { radius } => circles.push(Circle { cx: col.position.x, cy: col.position.y, r: radius, arc: None }),
        }
    }
    circles.extend(stair_arcs);
    for r in p.rooms.as_deref().unwrap_or(&[]) {
        if vis(&r.floor_id, &r.category_code) && r.boundary.len() >= 3 {
            anchors.push(match &r.stamp_anchor {
                Some(a) => (a.x, a.y),
                None => {
                    let c = crate::room_area::evaluate(&r.boundary.iter().map(|p| [p.x, p.y]).collect::<Vec<_>>(), 0.0).centroid;
                    (c[0], c[1])
                }
            });
        }
    }
    SnapPart { segs: SnapSet::new(segs), circles, anchors, ellipses: Vec::new() }
}

/// Strecken einer Zeichnung (`drawingSegs`).
fn drawing_segs(g: &Drawing2DGeom, out: &mut Vec<Seg>) {
    match g {
        Drawing2DGeom::Line { a, b } => out.push(seg(a, b)),
        Drawing2DGeom::Xline { a, b } | Drawing2DGeom::Ray { a, b } => {
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let len = hypot2(dx, dy);
            if len > 1e-6 {
                let (ux, uy) = (dx / len, dy / len);
                let end = [b.x + ux * XLINE_EXT, b.y + uy * XLINE_EXT];
                if matches!(g, Drawing2DGeom::Xline { .. }) {
                    out.push([a.x - ux * XLINE_EXT, a.y - uy * XLINE_EXT, end[0], end[1]]);
                } else {
                    out.push([a.x, a.y, end[0], end[1]]);
                }
            }
        }
        Drawing2DGeom::Polyline { pts, closed, .. } => {
            chain(pts, out);
            if *closed && pts.len() > 2 {
                out.push(seg(&pts[pts.len() - 1], &pts[0]));
            }
        }
        Drawing2DGeom::Rect { min, max } => {
            let (c2, c4) = (Vec2 { x: max.x, y: min.y }, Vec2 { x: min.x, y: max.y });
            out.extend([seg(min, &c2), seg(&c2, max), seg(max, &c4), seg(&c4, min)]);
        }
        Drawing2DGeom::Bezier { pts } => {
            if pts.len() < 4 {
                chain(pts, out);
            } else {
                chain(&pts_of(&crate::curves::bezier_chain(&flat(pts), 24.0)), out);
            }
        }
        Drawing2DGeom::Spline { pts, closed, mode } => {
            let closed = *closed && pts.len() > 2;
            let s = if pts.len() < 3 {
                pts.clone()
            } else if *mode == Some(SplineMode::Control) {
                pts_of(&crate::curves::uniform_bspline(&flat(pts), closed, 16.0))
            } else {
                pts_of(&crate::curves::catmull_rom(&flat(pts), closed, 16.0))
            };
            chain(&s, out);
            if closed && !s.is_empty() {
                out.push(seg(&s[s.len() - 1], &s[0]));
            }
        }
        _ => {}
    }
}

/// Zeichnungs-Teil eines Geschosses.
pub fn collect_drawings(p: &Project, level: &str, codes: &HashSet<String>) -> SnapPart {
    let mut segs: Vec<Seg> = Vec::new();
    let mut circles = Vec::new();
    let mut ellipses = Vec::new();
    for d in &p.drawings2d {
        if d.level_id != level || !codes.contains(&d.category_code) {
            continue;
        }
        match &d.geom {
            Drawing2DGeom::Circle { center, r } => circles.push(Circle { cx: center.x, cy: center.y, r: *r, arc: None }),
            Drawing2DGeom::Arc { center, r, a0, a1 } => circles.push(Circle { cx: center.x, cy: center.y, r: *r, arc: Some((*a0, *a1)) }),
            Drawing2DGeom::Ellipse { center, .. } => ellipses.push((center.x, center.y)),
            g => drawing_segs(g, &mut segs),
        }
    }
    SnapPart { segs: SnapSet::new(segs), circles, anchors: Vec::new(), ellipses }
}

/// Die Kandidaten eines Geschosses: Modell, Zeichnungen, Nahmodus.
#[derive(Clone)]
pub struct LevelSnap {
    pub model: Rc<SnapPart>,
    pub drawings: Rc<SnapPart>,
    pub near_mode: bool,
}

/// Eingabe einer Abfrage je Mausbewegung.
pub struct ModelQuery<'a> {
    /// Entwurfs-Strecken (Polylinie/Wand im Bau).
    pub draft: &'a [Seg],
    /// Blatt-Geometrie in Cursornähe (schon vorausgewählt, nächste zuerst).
    pub sheet: &'a [Seg],
    pub raw: (f64, f64),
    pub tol_m: f64,
    pub px_per_m: f64,
    pub flags: u32,
    pub last: Option<(f64, f64)>,
}

/// Ergebnis: nächste Strecke (Verweilen) und die Blöcke in TS-Reihenfolge.
#[derive(Debug, Default, PartialEq)]
pub struct ModelOut {
    pub dwell: Option<Seg>,
    /// Lot vom letzten Punkt, Strecken-Endpunkte.
    pub a: Option<Cand>,
    /// Raum-Stempel-Anker (Endpunkt).
    pub anchors: Option<Cand>,
    /// Mitte, Schnitt, Kante.
    pub b: Option<Cand>,
    /// Kreise (Mittelpunkt, Quadranten, Bogen-Endpunkte, Tangente), Ellipsen-Mittelpunkte.
    pub c: Option<Cand>,
}

/// Abstand Punkt–Strecke (`pointSegDist` in `geometry/drawingIndex.ts`).
fn point_seg_dist(p: (f64, f64), s: &Seg) -> f64 {
    let (dx, dy) = (s[2] - s[0], s[3] - s[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { ((p.0 - s[0]) * dx + (p.1 - s[1]) * dy) / len2 } else { 0.0 };
    let t = jsnum::max(0.0, jsnum::min(1.0, t));
    hypot2(p.0 - (s[0] + t * dx), p.1 - (s[1] + t * dy))
}

const TAU: f64 = std::f64::consts::PI * 2.0;

fn norm(x: f64) -> f64 {
    ((x % TAU) + TAU) % TAU
}

fn on_circle(c: &Circle, ang: f64) -> (f64, f64) {
    (c.cx + c.r * jsnum::cos(ang), c.cy + c.r * jsnum::sin(ang))
}

fn in_arc(c: &Circle, ang: f64) -> bool {
    let Some((a0, a1)) = c.arc else { return true };
    let s = norm(a1 - a0);
    // `norm(…) || TAU`: 0 und NaN → Vollkreis.
    let sweep = if s == 0.0 || s.is_nan() { TAU } else { s };
    norm(ang - a0) <= sweep + 1e-9
}

pub fn query(ls: &LevelSnap, q: &ModelQuery) -> ModelOut {
    let mut out = ModelOut::default();
    if q.flags & F_SEGS != 0 {
        let o = if ls.near_mode {
            let int_r = q.tol_m * 6.0;
            let mut cand: Vec<(Seg, f64)> = Vec::new();
            for part in [&ls.model, &ls.drawings] {
                for k in part.segs.near(q.raw.0, q.raw.1, int_r) {
                    let s = part.segs.segs[k as usize];
                    let d = point_seg_dist(q.raw, &s);
                    if d <= int_r {
                        cand.push((s, d));
                    }
                }
            }
            for s in q.draft {
                let d = point_seg_dist(q.raw, s);
                if d <= int_r {
                    cand.push((*s, d));
                }
            }
            cand.sort_by(|x, y| x.1.total_cmp(&y.1));
            let mut segs: Vec<Seg> = cand.iter().filter(|e| e.1 <= q.tol_m).map(|e| e.0).collect();
            let mut ints: Vec<Seg> = cand.iter().take(64).map(|e| e.0).collect();
            segs.extend_from_slice(q.sheet);
            ints.extend_from_slice(q.sheet);
            let sq = SnapQuery { bases: &[], extra: &segs, int_segs: Some(&ints), raw: q.raw, tol_m: q.tol_m, px_per_m: q.px_per_m, flags: q.flags, last: q.last };
            snap_segments(&sq)
        } else {
            let extra: Vec<Seg> = q.draft.iter().chain(q.sheet.iter()).copied().collect();
            let sq = SnapQuery {
                bases: &[&ls.model.segs, &ls.drawings.segs],
                extra: &extra,
                int_segs: None,
                raw: q.raw,
                tol_m: q.tol_m,
                px_per_m: q.px_per_m,
                flags: q.flags,
                last: q.last,
            };
            snap_segments(&sq)
        };
        out.dwell = o.dwell;
        out.a = o.a;
        out.b = o.b;
    }
    if q.flags & F_ENDPOINT != 0 {
        let mut best = Best::new(q.raw, q.tol_m, q.px_per_m);
        for &(x, y) in &ls.model.anchors {
            best.consider(x, y, K_ENDPOINT);
        }
        out.anchors = best.best;
    }
    let (center, endpoint, tangent) = (q.flags & F_CENTER != 0, q.flags & F_ENDPOINT != 0, q.flags & F_TANGENT != 0);
    if center || endpoint || tangent {
        let mut best = Best::new(q.raw, q.tol_m, q.px_per_m);
        for c in ls.drawings.circles.iter().chain(ls.model.circles.iter()) {
            if center {
                best.consider(c.cx, c.cy, K_CENTER);
                for k in 0..4 {
                    let ang = k as f64 * (std::f64::consts::PI / 2.0);
                    if in_arc(c, ang) {
                        let (x, y) = on_circle(c, ang);
                        best.consider(x, y, K_QUADRANT);
                    }
                }
            }
            if let (true, Some((a0, a1))) = (endpoint, c.arc) {
                let (x, y) = on_circle(c, a0);
                best.consider(x, y, K_ENDPOINT);
                let (x, y) = on_circle(c, a1);
                best.consider(x, y, K_ENDPOINT);
            }
            if let (true, Some((lx, ly))) = (tangent, q.last) {
                let (dx, dy) = (lx - c.cx, ly - c.cy);
                let d = hypot2(dx, dy);
                if d > c.r + 1e-9 {
                    let theta = jsnum::atan2(dy, dx);
                    let at_c = jsnum::acos(jsnum::min(1.0, c.r / d));
                    for sign in [1.0, -1.0] {
                        let ang = theta + sign * at_c;
                        if in_arc(c, ang) {
                            let (x, y) = on_circle(c, ang);
                            best.consider(x, y, K_TANGENT);
                        }
                    }
                }
            }
        }
        if center {
            for &(x, y) in &ls.drawings.ellipses {
                best.consider(x, y, K_CENTER);
            }
        }
        out.c = best.best;
    }
    out
}

/// Schlüssel eines gesammelten Teils.
#[derive(Clone, PartialEq, Debug)]
struct PartKey {
    doc: u32,
    epoch: u64,
    revs: Vec<u64>,
    level: String,
    codes: String,
}

/// Felder, aus denen der Modell-Teil sammelt (ändert sich eines, wird neu gesammelt).
const MODEL_FIELDS: [&str; 7] = ["walls", "wallTypes", "rooms", "ceilings", "roofs", "stairs", "columns"];
const DRAWING_FIELDS: [&str; 1] = ["drawings2d"];
/// So viele Teile je Art und abgelegte Geschosse bleiben (älteste fallen weg).
const KEEP: usize = 6;

/// Ist `level` die Blatt-Ebene eines Layouts (`DrawingLevel.layoutId`)?
fn is_sheet_level(root: &serde_json::Map<String, serde_json::Value>, level: &str) -> bool {
    root.get("drawingLevels").and_then(|v| v.as_array()).is_some_and(|ls| {
        ls.iter().any(|l| l.get("id").and_then(|v| v.as_str()) == Some(level) && l.get("layoutId").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()))
    })
}

/// Gesammelte Teile und abgelegte Geschosse (Nummer ≥ 1) über die Aufrufe hinweg.
#[derive(Default)]
pub struct SnapCache {
    model: Vec<(PartKey, Rc<SnapPart>)>,
    drawings: Vec<(PartKey, Rc<SnapPart>)>,
    held: Vec<(u32, LevelSnap)>,
    next: u32,
}

fn cached(list: &mut Vec<(PartKey, Rc<SnapPart>)>, key: PartKey, build: impl FnOnce() -> SnapPart) -> Rc<SnapPart> {
    if let Some(i) = list.iter().position(|e| e.0 == key) {
        let e = list.remove(i);
        let part = e.1.clone();
        list.push(e);
        return part;
    }
    let part = Rc::new(build());
    list.push((key, part.clone()));
    if list.len() > KEEP {
        list.remove(0);
    }
    part
}

impl SnapCache {
    /// Kandidaten des Geschosses `level` (sichtbare Ebenen `codes`) im Dokument `doc` (Nummer `doc_id`)
    /// sammeln bzw. wiederverwenden; Nummer für [`SnapCache::get`]. Dieselbe Nummer, solange sich die
    /// betroffenen Felder nicht ändern.
    pub fn hold(&mut self, doc_id: u32, doc: &mut crate::document::Document, level: &str, codes: &[String]) -> u32 {
        let mut sorted: Vec<&str> = codes.iter().map(String::as_str).collect();
        sorted.sort_unstable();
        sorted.dedup();
        let codes_key = sorted.join("\n");
        let set: HashSet<String> = sorted.iter().map(|s| (*s).to_owned()).collect();
        let near_mode = doc.root().get("drawings2d").and_then(|v| v.as_array()).map_or(0, Vec::len) > LARGE_DRAWINGS;
        let key = |fields: &[&str], revs: &crate::document::Revs| PartKey {
            doc: doc_id,
            epoch: revs.epoch(),
            revs: fields.iter().map(|f| revs.field(f)).collect(),
            level: level.to_owned(),
            codes: codes_key.clone(),
        };
        let (mut mk, dk) = (key(&MODEL_FIELDS, doc.revs()), key(&DRAWING_FIELDS, doc.revs()));
        // Blatt-Ebene eines Layouts ([93]): statt des (leeren) Modells die Inhalte der Viewports, auf das
        // Blatt abgebildet und geklippt (`sheet_viewports.rs`). Sie hängen am ganzen Projekt: neu
        // gesammelt bei jedem neuen Stand des Dokuments.
        let sheet = is_sheet_level(doc.root(), level);
        if sheet {
            mk.revs = vec![u64::MAX, doc.revs().max_except(&[])];
        }
        let model = cached(&mut self.model, mk, || {
            doc.project()
                .map(|p| match crate::sheet_viewports::layout_of_level(p, level).filter(|_| sheet) {
                    Some(l) => SnapPart { segs: SnapSet::new(crate::sheet_viewports::viewport_snap_segments(p, l)), ..SnapPart::default() },
                    None => collect_model(p, level, &set),
                })
                .unwrap_or_default()
        });
        let drawings = cached(&mut self.drawings, dk, || doc.project().map(|p| collect_drawings(p, level, &set)).unwrap_or_default());
        if let Some(e) = self.held.iter().find(|e| Rc::ptr_eq(&e.1.model, &model) && Rc::ptr_eq(&e.1.drawings, &drawings) && e.1.near_mode == near_mode) {
            return e.0;
        }
        self.next = self.next.wrapping_add(1).max(1);
        self.held.push((self.next, LevelSnap { model, drawings, near_mode }));
        if self.held.len() > KEEP {
            self.held.remove(0);
        }
        self.next
    }

    /// Abgelegtes Geschoss (`None` = Nummer unbekannt oder verdrängt).
    pub fn get(&self, id: u32) -> Option<&LevelSnap> {
        self.held.iter().find(|e| e.0 == id).map(|e| &e.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Document;
    use crate::snap::{F_INTERSECTION, F_MIDPOINT, F_ON_EDGE, F_PERPENDICULAR, K_INTERSECTION};
    use serde_json::json;

    fn doc(v: serde_json::Value) -> Document {
        Document::from_json(&v.to_string()).unwrap()
    }

    fn base() -> serde_json::Value {
        json!({
            "id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [],
            "wallTypes": [{"id": "aw", "name": "AW", "layers": [{"componentId": "c", "thickness": 0.1}, {"componentId": "c", "thickness": 0.15}, {"componentId": "c", "thickness": 0.2}]}],
            "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.6, "cutHeight": 1.0, "baseElevation": 0}],
            "layers": [{"code": "20", "name": "W", "color": "#000", "lw": 0.5, "visible": true, "locked": false}],
            "walls": [], "openings": [], "ceilings": [], "stairs": [], "rooms": [], "drawings2d": [], "context": []
        })
    }

    fn wall(r: Option<&str>) -> serde_json::Value {
        let mut w = json!({"id": "w", "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "wallTypeId": "aw", "height": 2.6});
        if let Some(r) = r {
            w["referenceLine"] = json!(r);
        }
        w
    }

    fn codes() -> Vec<String> {
        vec!["20".into()]
    }

    #[test]
    fn schichtgrenzen_der_wand_wie_im_grundriss() {
        // Gesamt 0.45; Mitte: −0.225, −0.125, +0.025, +0.225; links: +0, +0.1, +0.25, +0.45.
        for (r, offs) in [(None, [-0.225, -0.125, 0.025, 0.225]), (Some("left"), [0.0, 0.1, 0.25, 0.45]), (Some("right"), [-0.45, -0.35, -0.2, 0.0])] {
            let mut v = base();
            v["walls"] = json!([wall(r)]);
            let mut d = doc(v);
            let p = d.project().unwrap();
            let mut segs = Vec::new();
            wall_layer_segments(p, &p.walls[0], &mut segs);
            assert_eq!(segs.len(), 4);
            for (s, o) in segs.iter().zip(offs) {
                assert!((s[1] - o).abs() < 1e-12 && (s[3] - o).abs() < 1e-12, "{r:?}: {s:?} ≠ {o}");
                assert_eq!((s[0], s[2]), (0.0, 10.0));
            }
        }
        // Freier Fugen-Versatz übersteuert die Referenzlinie, auf ±T/2 geklemmt.
        for (off, first) in [(0.15, 0.15 - 0.225), (5.0, 0.0), (-5.0, -0.45)] {
            let mut v = base();
            v["walls"] = json!([wall(Some("left"))]);
            v["walls"][0]["referenceOffset"] = json!(off);
            let mut d = doc(v);
            let p = d.project().unwrap();
            let mut segs = Vec::new();
            wall_layer_segments(p, &p.walls[0], &mut segs);
            assert!((segs[0][1] - first).abs() < 1e-12, "{off}: {segs:?}");
        }
        // Unbekannter Wandtyp: keine Schichtgrenzen (die Achse bleibt).
        let mut v = base();
        v["walls"] = json!([wall(None)]);
        v["walls"][0]["wallTypeId"] = json!("fehlt");
        let mut d = doc(v);
        let ls = {
            let mut c = SnapCache::default();
            let id = c.hold(1, &mut d, "eg", &codes());
            c.get(id).unwrap().clone()
        };
        assert_eq!(ls.model.segs.segs, vec![[0.0, 0.0, 10.0, 0.0]]);
    }

    fn q(raw: (f64, f64), flags: u32, last: Option<(f64, f64)>) -> ModelQuery<'static> {
        ModelQuery { draft: &[], sheet: &[], raw, tol_m: 0.2, px_per_m: 100.0, flags, last }
    }

    #[test]
    fn kreise_anker_zeichnungen_und_reihenfolge_der_bloecke() {
        let mut v = base();
        v["rooms"] = json!([{"id": "r", "floorId": "eg", "categoryCode": "20", "siaCategory": "HNF", "name": "R", "color": "#fff",
            "boundary": [{"x": 0, "y": 0}, {"x": 4, "y": 0}, {"x": 4, "y": 2}, {"x": 0, "y": 2}]}]);
        v["drawings2d"] = json!([
            {"id": "c", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "circle", "center": {"x": 10, "y": 10}, "r": 1}},
            {"id": "a", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "arc", "center": {"x": 20, "y": 0}, "r": 1, "a0": 0, "a1": 1.5707963267948966}},
            {"id": "e", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "ellipse", "center": {"x": 30, "y": 0}, "rx": 2, "ry": 1, "rotation": 0}},
            {"id": "x", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "xline", "a": {"x": 0, "y": 5}, "b": {"x": 1, "y": 5}}},
            {"id": "h", "levelId": "og", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": 0, "y": 7}, "b": {"x": 1, "y": 7}}}
        ]);
        let mut d = doc(v);
        let mut cache = SnapCache::default();
        let id = cache.hold(1, &mut d, "eg", &codes());
        let ls = cache.get(id).unwrap();
        assert_eq!(ls.model.anchors, vec![(2.0, 1.0)]);
        assert_eq!(ls.drawings.ellipses, vec![(30.0, 0.0)]);
        assert_eq!(ls.drawings.circles.len(), 2);
        // Konstruktionslinie weit verlängert; die Linie auf „og“ fehlt.
        assert_eq!(ls.drawings.segs.segs, vec![[-1000.0, 5.0, 1001.0, 5.0]]);
        let all = F_SEGS | F_ENDPOINT | F_MIDPOINT | F_INTERSECTION | F_ON_EDGE | F_PERPENDICULAR | F_CENTER | F_TANGENT;
        assert_eq!(query(ls, &q((2.05, 1.0), all, None)).anchors.unwrap().kind, K_ENDPOINT);
        assert_eq!(query(ls, &q((11.0, 10.05), all, None)).c.unwrap().kind, K_QUADRANT);
        assert_eq!(query(ls, &q((10.0, 10.05), all, None)).c.unwrap().kind, K_CENTER);
        // Bogen: Quadrant bei 0 und π/2 (im Bogen), Endpunkte schlagen Quadranten (Priorität).
        assert_eq!(query(ls, &q((21.0, 0.05), all, None)).c.unwrap().kind, K_ENDPOINT);
        assert_eq!(query(ls, &q((30.05, 0.0), all, None)).c.unwrap().kind, K_CENTER);
        // Tangente vom letzten Punkt (10, 13) an den Kreis um (10, 10), r = 1.
        let t = query(ls, &q((10.95, 10.35), F_TANGENT, Some((10.0, 13.0)))).c.unwrap();
        assert_eq!(t.kind, K_TANGENT);
        // Schnitt Raumkante y = 2 mit … keiner; Kante des Raums trifft.
        let o = query(ls, &q((2.0, 2.05), all, None));
        assert_eq!(o.dwell, Some([4.0, 2.0, 0.0, 2.0]));
        assert!(o.b.is_some());
        // Ohne Strecken-Fang: kein Verweilen, keine Blöcke A/B.
        let o = query(ls, &q((2.0, 2.05), F_ENDPOINT, None));
        assert!(o.dwell.is_none() && o.a.is_none() && o.b.is_none());
    }

    #[test]
    fn gleiche_nummer_solange_nichts_relevantes_aendert_teile_einzeln_neu() {
        let mut v = base();
        v["walls"] = json!([wall(None)]);
        v["drawings2d"] = json!([{"id": "l", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": 0, "y": 5}, "b": {"x": 1, "y": 5}}}]);
        let mut d = doc(v);
        let mut cache = SnapCache::default();
        let a = cache.hold(1, &mut d, "eg", &codes());
        assert_eq!(cache.hold(1, &mut d, "eg", &codes()), a);
        // Andere Ebenen-Codes → andere Sammlung; Reihenfolge der Codes egal.
        let b = cache.hold(1, &mut d, "eg", &["20".into(), "99".into()]);
        assert_ne!(a, b);
        assert_eq!(cache.hold(1, &mut d, "eg", &["99".into(), "20".into()]), b);
        // Unbeteiligtes Feld geändert: dieselbe Nummer.
        d.apply(&crate::ops::ops_from_json(&json!([{"kind": "setField", "key": "parcelArea", "value": 5}])).unwrap()).unwrap();
        assert_eq!(cache.hold(1, &mut d, "eg", &codes()), a);
        // Wand geändert: Modell-Teil neu, Zeichnungs-Teil bleibt.
        let draw_before = cache.get(a).unwrap().drawings.clone();
        let mut w = wall(None);
        w["end"] = json!({"x": 12, "y": 0});
        d.apply(&[crate::ops::Op::Replace { collection: "walls".into(), entity: w }]).unwrap();
        let c = cache.hold(1, &mut d, "eg", &codes());
        assert_ne!(c, a);
        let ls = cache.get(c).unwrap();
        assert!(Rc::ptr_eq(&ls.drawings, &draw_before));
        assert_eq!(ls.model.segs.segs[0], [0.0, 0.0, 12.0, 0.0]);
        // Ein anderes Dokument unter derselben Nummer (neu geöffnet) sammelt neu.
        let mut d2 = doc(base());
        let e = cache.hold(1, &mut d2, "eg", &codes());
        assert!(cache.get(e).unwrap().model.segs.segs.is_empty());
    }

    #[test]
    fn nahmodus_nur_nahe_strecken_schnitt_unter_den_naechsten() {
        let mut v = base();
        let mut ds = Vec::new();
        for i in 0..2001 {
            let x = i as f64 * 3.0;
            ds.push(json!({"id": format!("d{i}"), "levelId": "eg", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": x, "y": -1}, "b": {"x": x, "y": 1}}}));
        }
        ds.push(json!({"id": "h", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": -10, "y": 0}, "b": {"x": 7000, "y": 0}}}));
        v["drawings2d"] = json!(ds);
        let mut d = doc(v);
        let mut cache = SnapCache::default();
        let id = cache.hold(1, &mut d, "eg", &codes());
        let ls = cache.get(id).unwrap();
        assert!(ls.near_mode);
        let o = query(ls, &q((3000.06, 0.04), F_SEGS | F_INTERSECTION | F_ON_EDGE, None));
        let b = o.b.unwrap();
        assert_eq!((b.x, b.y, b.kind), (3000.0, 0.0, K_INTERSECTION));
    }
}
