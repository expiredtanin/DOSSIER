//! Projektglobale Referenzen im Grundriss auf dem Dokument ([K3d]): Kontext-Konturen (Höhenlinien,
//! Fussabdruck importierter Gebäude, Rahmen von Gelände-Meshes, Pick-Bänder) und Schnittführungs-
//! Symbole der Schnitt-/Ansichtsebenen — Rust-Gegenstück zu `generatePlan/{context,sections}.ts`.
//! Die Geometrie liegt in `plan_misc.rs`; die Meshes werden direkt aus dem Dokument gelesen.

use super::domains::Ctx;
use super::overrides::{js_space, js_trim};
use super::prim::Primitive;
use super::style::no_hatch;
use crate::model::*;

const CONTEXT_LINE_COLOR: &str = "#9aa3ad";
const CONTEXT_LINE_MM: f64 = 0.1;
/// Kategorie der Schnittführungs-Symbole (Referenzen).
const SECTION_LINE_CATEGORY: &str = "90";
const SECTION_LINE_INK: &str = "#1f242c";
const SECTION_LINE_MM: f64 = 0.18;
const SECTION_LINE_MARK_MM: f64 = 0.25;
const SECTION_LINE_DASH: [f64; 4] = [6.0, 1.5, 0.4, 1.5];
const SECTION_LABEL_H: f64 = 0.5;

fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

fn context_line(a: Vec2, b: Vec2) -> Primitive {
    Primitive::Line { a, b, cls: "context-line".into(), weight_mm: CONTEXT_LINE_MM, dash: None, zigzag: None, motif: None, color: Some(CONTEXT_LINE_COLOR.into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None }
}

fn pick_band(pts: Vec<Vec2>, context_id: Option<&str>, section_id: Option<&str>) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: "none".into(),
        stroke: "none".into(),
        stroke_width_mm: 0.0,
        hatch: no_hatch(),
        greyed: None,
        opacity: None,
        no_stroke_edges: None,
        wall_id: None,
        drawing_id: None,
        ceiling_id: None,
        opening_id: None,
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: context_id.map(String::from),
        column_id: None,
        roof_id: None,
        section_line_id: section_id.map(String::from),
    }
}

/// Rahmen-Ecken eines Meshes (x/y), `None` ohne Punkte.
fn bbox_corners(positions: &[f64]) -> Option<Vec<Vec2>> {
    let b = crate::plan::misc::bbox(positions);
    (b.len() == 4).then(|| vec![v2(b[0], b[1]), v2(b[2], b[1]), v2(b[2], b[3]), v2(b[0], b[3])])
}

/// Kontext-Schicht (`addContextContours`). Objekte ohne Kategorie bleiben immer sichtbar. Die
/// Höhenlinien-Beschriftungen weichen den Zeichnungen des Geschosses aus (`drawings::stamp_obstacle_prims`).
pub fn plan_context(c: &Ctx, out: &mut Vec<Primitive>) {
    let mut o = super::stamp_place::Obstacles::default();
    for q in super::drawings::stamp_obstacle_prims(c) {
        o.add_prim(&q);
    }
    plan_context_with(c, out, &o);
}

/// Wie [`plan_context`], mit den schon gesammelten Hindernissen der Zeichnungen (Bemassung, Koten, Texte …).
pub fn plan_context_with(c: &Ctx, out: &mut Vec<Primitive>, drawing_obstacles: &super::stamp_place::Obstacles) {
    // [137] Pick-Flächen der Baugruben zuletzt (zuoberst): sie liegen im Rahmen des Geländes, das sonst
    // jeden Klick in der Grube fängt.
    let mut late: Vec<Primitive> = Vec::new();
    // [140]/[150] Höhenlinien, Böschungsschraffur und Beschriftungen enden am Fussabdruck des Geschosses.
    let mut house_cache: Option<Vec<Vec<Vec2>>> = None;
    let mut house = || -> Vec<Vec<Vec2>> { house_cache.get_or_insert_with(|| terrain_footprint(c.p, &c.a.floor)).clone() };
    let mut label_obst: Option<super::stamp_place::Obstacles> = None;
    for obj in c.p.context.as_deref().unwrap_or(&[]) {
        let code = match obj {
            ContextObject::ImportedMesh(m) => m.category_code.as_deref(),
            ContextObject::ContourSet(s) => s.category_code.as_deref(),
            ContextObject::TerrainMesh(t) => t.category_code.as_deref(),
            ContextObject::Image(i) => i.category_code.as_deref(),
            ContextObject::Excavation(e) => e.category_code.as_deref(),
        };
        if code.is_some_and(|k| !c.shown(k)) {
            continue;
        }
        // [137] Einzeln ausgeblendetes Gelände bzw. importiertes Netz (Kategorie bleibt sichtbar).
        if matches!(obj, ContextObject::TerrainMesh(t) if t.hidden == Some(true)) || matches!(obj, ContextObject::ImportedMesh(m) if m.hidden == Some(true)) {
            continue;
        }
        // [33] Gelände und Höhenlinien über Regeln (Bauteilart „Gelände“): Ausblenden, Linie (Farbe, Stärke, Linienstil).
        let tov = match obj {
            ContextObject::TerrainMesh(t) => super::overrides::terrain_override(c.p, c.rule_view(), code, &t.name),
            ContextObject::ContourSet(s) => super::overrides::terrain_override(c.p, c.rule_view(), code, &s.name),
            _ => None,
        };
        if tov.as_ref().is_some_and(|(a, _)| a.hidden()) {
            continue;
        }
        let start = out.len();
        match obj {
            ContextObject::ContourSet(s) => {
                // [137] Rahmen als Pick-Fläche (unter dem daraus erzeugten Gelände; Cmd+Klick schaltet durch).
                let all: Vec<f64> = s.contours.iter().flat_map(|k| k.pts.iter().flat_map(|q| [q.x, q.y, 0.0])).collect();
                if let Some(pts) = bbox_corners(&all) {
                    out.push(pick_band(pts, Some(&s.id), None));
                }
                for k in &s.contours {
                    let pts = &k.pts;
                    if pts.len() < 2 {
                        continue;
                    }
                    let seg_end = if k.closed { pts.len() } else { pts.len() - 1 };
                    let rings = house();
                    for i in 0..seg_end {
                        for (a, b) in outside(pts[i], pts[(i + 1) % pts.len()], &rings) {
                            out.push(context_line(a, b));
                        }
                    }
                }
            }
            ContextObject::ImportedMesh(m) => {
                let f = crate::plan::misc::context_footprint(&m.positions, &m.indices);
                let n = f.first().copied().unwrap_or(0.0) as usize;
                for i in 0..n {
                    out.push(context_line(v2(f[1 + 4 * i], f[2 + 4 * i]), v2(f[3 + 4 * i], f[4 + 4 * i])));
                }
                if let Some(pts) = bbox_corners(&m.positions) {
                    out.push(pick_band(pts, Some(&m.id), None));
                }
            }
            ContextObject::TerrainMesh(t) => {
                if let Some(q) = bbox_corners(&t.positions) {
                    for i in 0..4 {
                        out.push(context_line(q[i], q[(i + 1) % 4]));
                    }
                    out.push(pick_band(q, Some(&t.id), None));
                }
                // [150] Beschriftungen weichen auch den Blasen der Achsraster aus.
                let obst = label_obst.get_or_insert_with(|| {
                    let mut o = drawing_obstacles.clone();
                    for q in super::drawings::grid_bubble_prims(c) {
                        o.add_prim(&q);
                    }
                    o
                });
                terrain_contours(c, t, out, &house(), obst);
            }
            ContextObject::Excavation(e) => excavation_lines(c, e, out, &mut late, &house()),
            ContextObject::Image(_) => {}
        }
        if let Some((a, _)) = &tov {
            restyle_lines(c.p, a, &mut out[start..]);
        }
    }
    out.append(&mut late);
}

/// [33] Linien (und Beschriftungen) nach den Element-Aktionen einer Regel: Farbe, Strichstärke, Linienstil.
pub(super) fn restyle_lines(p: &Project, a: &super::overrides::Actions, prims: &mut [Primitive]) {
    let dash = super::overrides::linetype_dash(p, a.linetype_id.as_deref());
    for q in prims {
        match q {
            Primitive::Line { color, weight_mm, dash: d, .. } => {
                if let Some(c) = &a.color {
                    *color = Some(c.clone());
                }
                if let Some(w) = a.lineweight.filter(|w| w.is_finite() && *w >= 0.0) {
                    *weight_mm = w;
                }
                if let Some(x) = &dash {
                    *d = Some(x.clone());
                }
            }
            Primitive::DrawingText { color, .. } => {
                if let Some(c) = &a.color {
                    *color = c.clone();
                }
            }
            _ => {}
        }
    }
}

/// [140] Gelände/Höhenlinien grau statt braun.
const TERRAIN_INK: &str = "#6e6e6e";
/// [140] Kleinster Papierabstand (mm) zwischen Höhenlinien; enger werden Zwischenlinien ausgelassen.
const CONTOUR_MIN_GAP_MM: f64 = 0.6;

/// [140] Aussenringe der Gebäudegrundfläche (Wände und Körper aller Geschosse vereinigt, ohne Innenhöfe/Räume).
pub(super) fn building_rings(p: &Project) -> Vec<Vec<Vec2>> {
    crate::site_rules::building_footprint(p).into_iter().filter_map(|poly| poly.into_iter().next()).filter(|r| r.len() >= 3).collect()
}

/// [150] Fussabdruck des Gebäudes für das Gelände im Grundriss von `floor`: Wände (auch Bogenwände; gerade
/// Wände an angeschlossenen Enden um die halbe Dicke verlängert, damit Ecken geschlossen sind), Decken/
/// Bodenplatten, Räume und Körper des Geschosses und des Erdgeschosses (Geschoss nächst ±0.00), vereinigt
/// über den Kern (i_overlay). Je Teil nur der Aussenring: von Wänden umschlossene Bereiche ohne Raum/Decke
/// (Anbau, Innenhof) zählen dazu. Ohne Geschoss-Ebenen alle Bauteile.
pub(super) fn terrain_footprint(p: &Project, floor: &str) -> Vec<Vec<Vec2>> {
    let mut floors: Vec<&str> = Vec::new();
    if p.drawing_levels.iter().any(|l| l.id == floor && l.kind == DrawingLevelKind::Floor) {
        floors.push(floor);
    }
    if let Some(g) = super::extras::ground_floor_id(p) {
        floors.push(g);
    }
    let on = |f: &str| floors.is_empty() || floors.contains(&f);
    let ok = |q: &Vec2| q.x.is_finite() && q.y.is_finite();
    let mut parts: Vec<crate::flat::Polygon> = Vec::new();
    let walls: Vec<(&Wall, f64)> = p.walls.iter().filter(|w| on(&w.floor_id) && ok(&w.start) && ok(&w.end)).map(|w| (w, p.wall_thickness(w, 0.2))).filter(|(w, t)| t.is_finite() && *t >= 0.0 && (w.end.x - w.start.x).hypot(w.end.y - w.start.y) > 1e-9).collect();
    let plain: Vec<Vec<[f64; 2]>> = walls.iter().map(|(w, t)| crate::wall_arc::arc_footprint(w, *t).unwrap_or_else(|| crate::site_rules::wall_corners(w.start, w.end, *t))).collect();
    let plain_v: Vec<Vec<Vec2>> = plain.iter().map(|r| r.iter().map(|a| v2(a[0], a[1])).collect()).collect();
    // Ende angeschlossen: liegt (1 cm Toleranz) auf/in einer anderen Wand.
    let joined = |i: usize, q: Vec2| plain.iter().enumerate().any(|(j, r)| j != i && (inside(q, &plain_v[j]) || (0..r.len()).any(|k| seg_dist(q, r[k], r[(k + 1) % r.len()]) < 0.01)));
    for (i, (w, t)) in walls.iter().enumerate() {
        if w.bulge.is_some_and(|b| b.abs() > 1e-9) {
            parts.push(vec![plain[i].clone()]);
            continue;
        }
        let l = (w.end.x - w.start.x).hypot(w.end.y - w.start.y);
        let (ux, uy) = ((w.end.x - w.start.x) / l, (w.end.y - w.start.y) / l);
        let (e0, e1) = (if joined(i, w.start) { t / 2.0 } else { 0.0 }, if joined(i, w.end) { t / 2.0 } else { 0.0 });
        parts.push(vec![crate::site_rules::wall_corners(v2(w.start.x - ux * e0, w.start.y - uy * e0), v2(w.end.x + ux * e1, w.end.y + uy * e1), *t)]);
    }
    let ring = |pts: &[Vec2]| -> Option<crate::flat::Polygon> { (pts.len() >= 3 && pts.iter().all(ok)).then(|| vec![pts.iter().map(|q| [q.x, q.y]).collect()]) };
    for c in p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|c| on(&c.floor_id)) {
        parts.extend(ring(&c.outline));
    }
    for r in p.rooms.as_deref().unwrap_or(&[]).iter().filter(|r| on(&r.floor_id)) {
        parts.extend(ring(&r.boundary));
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]).iter().filter(|s| on(&s.level_id) && s.operation.as_deref() != Some("subtract")) {
        parts.extend(ring(&s.points));
    }
    if parts.is_empty() {
        return Vec::new();
    }
    crate::polygon_bool::union(&parts).into_iter().filter_map(|poly| poly.into_iter().next()).filter(|r| r.len() >= 3).map(|r| r.iter().map(|q| v2(q[0], q[1])).collect()).collect()
}

fn seg_dist(q: Vec2, a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((q.x - a[0]) * dx + (q.y - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (q.x - a[0] - t * dx).hypot(q.y - a[1] - t * dy)
}

fn inside(q: Vec2, ring: &[Vec2]) -> bool {
    let mut c = false;
    let n = ring.len();
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + n - 1) % n]);
        if (a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x {
            c = !c;
        }
    }
    c
}

/// Teile der Strecke a–b ausserhalb aller `rings`.
pub(super) fn outside(a: Vec2, b: Vec2, rings: &[Vec<Vec2>]) -> Vec<(Vec2, Vec2)> {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let (lo_x, hi_x, lo_y, hi_y) = (a.x.min(b.x), a.x.max(b.x), a.y.min(b.y), a.y.max(b.y));
    let mut ts = vec![0.0, 1.0];
    let mut near = false;
    for r in rings {
        let n = r.len();
        for i in 0..n {
            let (p, q) = (r[i], r[(i + 1) % n]);
            if p.x.max(q.x) < lo_x || p.x.min(q.x) > hi_x || p.y.max(q.y) < lo_y || p.y.min(q.y) > hi_y {
                continue;
            }
            near = true;
            let (ex, ey) = (q.x - p.x, q.y - p.y);
            let den = dx * ey - dy * ex;
            if den.abs() < 1e-15 {
                continue;
            }
            let t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / den;
            let u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / den;
            if t > 0.0 && t < 1.0 && (0.0..=1.0).contains(&u) {
                ts.push(t);
            }
        }
    }
    let at = |t: f64| v2(a.x + dx * t, a.y + dy * t);
    if !near {
        // Ganz innerhalb (ohne Kantenberührung) oder ganz ausserhalb.
        return if rings.iter().any(|r| inside(a, r)) { vec![] } else { vec![(a, b)] };
    }
    ts.sort_by(|x, y| x.total_cmp(y));
    ts.windows(2).filter(|w| w[1] - w[0] > 1e-9 && !rings.iter().any(|r| inside(at((w[0] + w[1]) / 2.0), r))).map(|w| (at(w[0]), at(w[1]))).collect()
}
const EXCAVATION_INK: &str = "#1f242c";

fn ink_line(a: Vec2, b: Vec2, w: f64, color: &str, dash: Option<Vec<f64>>) -> Primitive {
    Primitive::Line { a, b, cls: "context-line".into(), weight_mm: w, dash: dash.map(Some), zigzag: None, motif: None, color: Some(color.into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None }
}

/// [150] Abstand (Papier-mm) der Beschriftungen entlang einer Zähllinie: je volle Strecke dieser Länge eine.
const CONTOUR_LABEL_SPACING_MM: f64 = 150.0;

/// [150] Eine Höhenlinie als Linienzug mit Bogenlänge (geschlossen: erster Punkt am Ende wiederholt).
struct Iso {
    level: f64,
    index: bool,
    pts: Vec<[f64; 2]>,
    cum: Vec<f64>,
    closed: bool,
}

impl Iso {
    fn len(&self) -> f64 {
        *self.cum.last().unwrap_or(&0.0)
    }

    /// Punkt bei Bogenlänge `s` (geschlossen: modulo Länge).
    fn at(&self, s: f64) -> [f64; 2] {
        let l = self.len();
        let s = if self.closed && l > 0.0 { s.rem_euclid(l) } else { s.clamp(0.0, l) };
        let i = self.cum.partition_point(|c| *c <= s).clamp(1, self.pts.len() - 1);
        let (a, b) = (self.pts[i - 1], self.pts[i]);
        let d = self.cum[i] - self.cum[i - 1];
        let f = if d > 0.0 { (s - self.cum[i - 1]) / d } else { 0.0 };
        [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
    }

    /// Grösster Abstand der Ecken zwischen `s0` und `s1` von der Sehne (gerade genug für eine Beschriftung?).
    fn bend(&self, s0: f64, s1: f64) -> f64 {
        let (a, b) = (self.at(s0), self.at(s1));
        let l = self.len();
        let mut d: f64 = 0.0;
        for (i, q) in self.pts.iter().enumerate() {
            let c = self.cum[i];
            let within = if self.closed && l > 0.0 { (c - s0).rem_euclid(l) < s1 - s0 } else { c > s0 && c < s1 };
            if within {
                d = d.max(seg_dist(v2(q[0], q[1]), a, b));
            }
        }
        d
    }
}

/// [150] Rechteck um `m` (Richtung `u`, halbe Länge `hu`, halbe Höhe `hv`).
fn rot_rect(m: [f64; 2], u: [f64; 2], hu: f64, hv: f64) -> Vec<[f64; 2]> {
    let n = [-u[1], u[0]];
    [(-hu, -hv), (hu, -hv), (hu, hv), (-hu, hv)].iter().map(|(a, b)| [m[0] + u[0] * a + n[0] * b, m[1] + u[1] * a + n[1] * b]).collect()
}

/// [150] Strecken der gezeichneten Höhenlinien in einem Raster (Zelle `cell`) für die Frage „wie viele andere
/// Linien kreuzt diese Beschriftung?“.
struct SegGrid {
    cell: f64,
    map: std::collections::HashMap<(i64, i64), Vec<usize>>,
    segs: Vec<([f64; 2], [f64; 2], usize)>,
}

impl SegGrid {
    fn new(cell: f64) -> Self {
        SegGrid { cell, map: Default::default(), segs: Vec::new() }
    }

    fn key(&self, x: f64, y: f64) -> (i64, i64) {
        ((x / self.cell).floor() as i64, (y / self.cell).floor() as i64)
    }

    fn add(&mut self, a: [f64; 2], b: [f64; 2], line: usize) {
        let i = self.segs.len();
        self.segs.push((a, b, line));
        let (k0, k1) = (self.key(a[0].min(b[0]), a[1].min(b[1])), self.key(a[0].max(b[0]), a[1].max(b[1])));
        if (k1.0 - k0.0 + 1).saturating_mul(k1.1 - k0.1 + 1) > 10_000 {
            return;
        }
        for x in k0.0..=k1.0 {
            for y in k0.1..=k1.1 {
                self.map.entry((x, y)).or_default().push(i);
            }
        }
    }

    /// Anzahl Strecken anderer Linien als `line`, die den Ring berühren.
    fn crossings(&self, ring: &[[f64; 2]], line: usize) -> usize {
        let b = super::stamp_place::ring_bbox(ring);
        let (k0, k1) = (self.key(b[0], b[1]), self.key(b[2], b[3]));
        let mut ids: Vec<usize> = Vec::new();
        for x in k0.0..=k1.0 {
            for y in k0.1..=k1.1 {
                if let Some(v) = self.map.get(&(x, y)) {
                    ids.extend(v.iter().copied().filter(|i| self.segs[*i].2 != line));
                }
            }
        }
        ids.sort_unstable();
        ids.dedup();
        ids.iter().filter(|i| super::stamp_place::seg_hits_ring(self.segs[**i].0, self.segs[**i].1, ring)).count()
    }
}

/// [T6] Höhenlinien aus dem Gelände-Netz (samt Baugruben) in der Äquidistanz `contourInterval`; jede
/// `contourIndexEvery`-te ist Zähllinie (dicker, mit Höhenangabe, lesbar gedreht). [150] Linien enden am
/// Fussabdruck `house`; Beschriftungen liegen ausserhalb davon, nicht auf `obst` (Bemassung, Koten, Texte),
/// nicht übereinander, je Zähllinie alle [`CONTOUR_LABEL_SPACING_MM`] eine (nahe der Abschnittsmitte, wo sie
/// am wenigsten andere Linien kreuzt und die Linie gerade genug ist).
fn terrain_contours(c: &Ctx, t: &TerrainMesh, out: &mut Vec<Primitive>, house: &[Vec<Vec2>], obst: &super::stamp_place::Obstacles) {
    let Some(iv) = t.contour_interval.filter(|v| v.is_finite() && *v > 0.0) else { return };
    let every = t.contour_index_every.filter(|v| v.is_finite() && *v >= 1.0).map_or(5, |v| v.round() as i64);
    let st = crate::excavation::site_terrain(c.p, t);
    let scale = c.a.scale.max(1.0);
    let text_h = 0.002 * scale;
    let tin = st.current();
    let idx = crate::terrain::TinIndex::new(tin);
    // [140] Papierabstand (mm) benachbarter Höhenlinien am Punkt: Äquidistanz / Gefälle des Dreiecks.
    let spacing_mm = |x: f64, y: f64| -> f64 {
        let Some(([a, b, cc], _)) = idx.bary_at(x, y) else { return f64::INFINITY };
        let (pa, pb, pc) = (tin.xy[a], tin.xy[b], tin.xy[cc]);
        let (ux, uy, uz) = (pb[0] - pa[0], pb[1] - pa[1], tin.z[b] - tin.z[a]);
        let (vx, vy, vz) = (pc[0] - pa[0], pc[1] - pa[1], tin.z[cc] - tin.z[a]);
        let d = ux * vy - vx * uy;
        if d.abs() < 1e-12 {
            return f64::INFINITY;
        }
        let g = ((uz * vy - vz * uy) / d).hypot((ux * vz - vx * uz) / d);
        if g > 1e-12 { iv / g * 1000.0 / scale } else { f64::INFINITY }
    };
    // Linien, je Strecke gezeichnet oder (zu eng) ausgelassen.
    let mut isos: Vec<Iso> = Vec::new();
    let mut drawn: Vec<Vec<bool>> = Vec::new();
    for l in crate::terrain::isolines(tin, iv, 0.0) {
        if l.pts.len() < 2 {
            continue;
        }
        let k = (l.level / iv).round() as i64;
        let index = k.rem_euclid(every) == 0;
        let mut pts = l.pts.clone();
        if l.closed {
            pts.push(pts[0]);
        }
        let mut cum = vec![0.0];
        for w in pts.windows(2) {
            cum.push(cum[cum.len() - 1] + (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]));
        }
        // [140] Zu eng (< 0.6 mm auf dem Papier): nur jede zweite, bei < 0.3 mm nur die Zähllinien.
        let d: Vec<bool> = pts
            .windows(2)
            .map(|w| {
                index || {
                    let s = spacing_mm((w[0][0] + w[1][0]) / 2.0, (w[0][1] + w[1][1]) / 2.0);
                    !(s < CONTOUR_MIN_GAP_MM && (k.rem_euclid(2) != 0 || 2.0 * s < CONTOUR_MIN_GAP_MM))
                }
            })
            .collect();
        isos.push(Iso { level: l.level, index, pts, cum, closed: l.closed });
        drawn.push(d);
    }
    let mut grid = SegGrid::new((4.0 * text_h).max(1e-6));
    for (li, (l, d)) in isos.iter().zip(&drawn).enumerate() {
        for (i, w) in l.pts.windows(2).enumerate() {
            if d[i] {
                grid.add(w[0], w[1], li);
            }
        }
    }
    let house_p: Vec<Vec<[f64; 2]>> = house.iter().map(|r| r.iter().map(|q| [q.x, q.y]).collect()).collect();
    let house_b: Vec<[f64; 4]> = house_p.iter().map(|r| super::stamp_place::ring_bbox(r)).collect();
    let in_house = |ring: &[[f64; 2]]| {
        let b = super::stamp_place::ring_bbox(ring);
        house_p.iter().zip(&house_b).any(|(h, hb)| hb[2] >= b[0] && hb[0] <= b[2] && hb[3] >= b[1] && hb[1] <= b[3] && super::stamp_place::convex_overlap(h, ring))
    };
    // Beschriftungen: Zähllinien, längste zuerst.
    let digits = if iv.fract() == 0.0 { 0 } else { 1 };
    let mut order: Vec<usize> = (0..isos.len()).filter(|i| isos[*i].index && isos[*i].len() >= 12.0 * text_h).collect();
    order.sort_by(|a, b| isos[*b].len().total_cmp(&isos[*a].len()).then(isos[*a].level.total_cmp(&isos[*b].level)));
    let spacing = CONTOUR_LABEL_SPACING_MM / 1000.0 * scale;
    let step = 0.001 * scale;
    let (pad_house, pad_label) = (0.3 * text_h, 0.5 * text_h);
    let mut placed: Vec<Vec<[f64; 2]>> = Vec::new();
    // Je Linie: Lücken (Bogenlänge) unter den Beschriftungen.
    let mut gaps: Vec<Vec<(f64, f64)>> = vec![Vec::new(); isos.len()];
    for li in order {
        let l = &isos[li];
        let len = l.len();
        let text = crate::js_fmt::to_fixed(l.level, digits);
        let hw = crate::text_layout::text_width_em(&text, false) * text_h / 2.0;
        let hv = 0.6 * text_h;
        let reserve = hw + 0.4 * text_h;
        let n = ((len / spacing).floor() as usize).max(1);
        let sec = len / n as f64;
        let mut mine: Vec<f64> = Vec::new();
        for i in 0..n {
            let target = (i as f64 + 0.5) * sec;
            let (lo, hi) = if l.closed { (i as f64 * sec, (i + 1) as f64 * sec) } else { ((i as f64 * sec).max(reserve), ((i + 1) as f64 * sec).min(len - reserve)) };
            if hi < lo {
                continue;
            }
            let mut cands: Vec<f64> = Vec::new();
            let mut s = lo;
            while s <= hi + 1e-12 && cands.len() < 20_000 {
                cands.push(s);
                s += step;
            }
            cands.sort_by(|a, b| (a - target).abs().total_cmp(&(b - target).abs()));
            let mut best: Option<(usize, f64, [f64; 2], [f64; 2])> = None;
            for s in cands {
                if mine.iter().any(|m| {
                    let d = (s - m).abs();
                    (if l.closed { d.min(len - d) } else { d }) < spacing / 2.5
                }) {
                    continue;
                }
                let (a, b) = (l.at(s - hw), l.at(s + hw));
                let cl = (b[0] - a[0]).hypot(b[1] - a[1]);
                if !(cl > 1.6 * hw) || l.bend(s - hw, s + hw) > 0.3 * text_h {
                    continue;
                }
                let u = [(b[0] - a[0]) / cl, (b[1] - a[1]) / cl];
                let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
                let padded = rot_rect(m, u, hw + pad_house, hv + pad_house);
                if in_house(&padded) || obst.hits_convex(&padded) {
                    continue;
                }
                let grown = rot_rect(m, u, hw + pad_label, hv + pad_label / 2.0);
                if placed.iter().any(|r| super::stamp_place::convex_overlap(r, &grown)) {
                    continue;
                }
                let x = grid.crossings(&rot_rect(m, u, hw, hv), li);
                // Auf einem Bündel (Stützmauer, Baugrubenwand): lieber keine Beschriftung.
                if x > 1 {
                    continue;
                }
                if best.as_ref().is_none_or(|b| x < b.0) {
                    best = Some((x, s, m, u));
                }
                if x == 0 {
                    break;
                }
            }
            let Some((_, s, m, u)) = best else { continue };
            mine.push(s);
            placed.push(rot_rect(m, u, hw, hv));
            gaps[li].push((s - reserve, s + reserve));
            // Lesbar gedreht; Text mittig auf die Linie (Grundlinie ≈ −0.35 · Höhe).
            let mut ang = u[1].atan2(u[0]);
            if ang > std::f64::consts::FRAC_PI_2 || ang <= -std::f64::consts::FRAC_PI_2 {
                ang += std::f64::consts::PI;
            }
            let (cs, sn) = (ang.cos(), ang.sin());
            out.push(Primitive::DrawingText {
                at: v2(m[0] - cs * hw + sn * 0.35 * text_h, m[1] - sn * hw - cs * 0.35 * text_h),
                text: text.clone(),
                height_m: text_h,
                angle: ang,
                color: TERRAIN_INK.into(),
                marks: None,
                wrap_width: None,
                doc: None,
                drawing_id: None,
                greyed: None,
                opacity: None,
            });
        }
    }
    // Linien: ohne die Lücken unter den Beschriftungen, ausserhalb des Fussabdrucks.
    for (li, l) in isos.iter().enumerate() {
        // [140] Zähllinie mittel (0.18), Höhenlinie fein (0.1): Gelände bleibt unter dem Gebäude zurück.
        let w = if l.index { 0.18 } else { 0.1 };
        let len = l.len();
        let mut g: Vec<(f64, f64)> = Vec::new();
        for &(g0, g1) in &gaps[li] {
            g.push((g0, g1));
            if l.closed {
                g.push((g0 + len, g1 + len));
                g.push((g0 - len, g1 - len));
            }
        }
        for (i, seg) in l.pts.windows(2).enumerate() {
            if !drawn[li][i] {
                continue;
            }
            let (s0, d) = (l.cum[i], l.cum[i + 1] - l.cum[i]);
            let mut spans = vec![(0.0f64, 1.0f64)];
            if d > 0.0 {
                for &(g0, g1) in &g {
                    let (f0, f1) = (((g0 - s0) / d).clamp(0.0, 1.0), ((g1 - s0) / d).clamp(0.0, 1.0));
                    if f1 - f0 <= 1e-12 {
                        continue;
                    }
                    spans = spans.into_iter().flat_map(|(x, y)| [(x, y.min(f0)), (x.max(f1), y)]).filter(|(x, y)| y - x > 1e-9).collect();
                }
            }
            let (a, b) = (seg[0], seg[1]);
            for (f0, f1) in spans {
                let pt = |f: f64| v2(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
                for (p0, p1) in outside(pt(f0), pt(f1), house) {
                    out.push(ink_line(p0, p1, w, TERRAIN_INK, None));
                }
            }
        }
    }
}

/// [68] Baugrube im Grundriss: Sohle (Böschungsfuss) und Böschungsoberkante, Böschungsschraffur.
/// [150] Böschungsoberkante und -schraffur (Gelände) enden am Fussabdruck `house`; die Sohle bleibt.
fn excavation_lines(c: &Ctx, e: &Excavation, out: &mut Vec<Primitive>, bands: &mut Vec<Primitive>, house: &[Vec<Vec2>]) {
    let ring: Vec<Vec2> = e.outline.iter().copied().filter(|q| q.x.is_finite() && q.y.is_finite()).collect();
    if ring.len() < 3 {
        return;
    }
    for i in 0..ring.len() {
        out.push(ink_line(ring[i], ring[(i + 1) % ring.len()], 0.25, EXCAVATION_INK, None));
    }
    // [137] Pick-Fläche = Wirkbereich (Sohle + Böschungen), ohne Gelände nur die Sohle.
    let hull = crate::excavation::terrains(c.p).into_iter().map(|t| crate::excavation::affected_hull(&crate::excavation::site_terrain(c.p, t), &e.id)).find(|h| h.len() >= 3);
    let band = hull.map_or_else(|| ring.clone(), |h| h.iter().map(|q| v2(q[0], q[1])).collect());
    bands.push(pick_band(band, Some(&e.id), None));
    let spacing = (0.004 * c.a.scale.max(1.0)).max(0.2);
    for t in crate::excavation::terrains(c.p) {
        let st = crate::excavation::site_terrain(c.p, t);
        let Some((_, spec, daylight)) = st.items.iter().find(|(id, ..)| *id == e.id) else { continue };
        for l in daylight {
            for w in l.windows(2) {
                for (a, b) in outside(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), house) {
                    out.push(ink_line(a, b, 0.18, EXCAVATION_INK, None));
                }
            }
        }
        if let Some(before) = crate::excavation::terrain_before(&st, &e.id) {
            for (a, b) in crate::excavation::slope_hatch(&before, spec, spacing) {
                for (a, b) in outside(v2(a[0], a[1]), v2(b[0], b[1]), house) {
                    out.push(ink_line(a, b, 0.1, EXCAVATION_INK, None));
                }
            }
        }
        break;
    }
}

/// Kurz-Tag eines Schnitt-Labels: letztes Wort des Namens, sonst der ganze (getrimmte) Name.
pub fn section_label_tag(name: &str) -> String {
    let t = js_trim(name);
    let parts: Vec<&str> = t.split(js_space).filter(|s| !s.is_empty()).collect();
    if parts.len() > 1 {
        parts[parts.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// Schnittführungs-Symbole aller Schnitt-/Ansichtsebenen mit Linie (`addSectionLines`).
pub fn plan_section_lines(c: &Ctx, out: &mut Vec<Primitive>) {
    if !c.shown(SECTION_LINE_CATEGORY) {
        return;
    }
    // Auf freien Zeichnungsebenen (Blätter wie „Raumprogramm", Detail) gehören die Symbole nicht hin:
    // sie beziehen sich auf die Geschoss-Grundrisse.
    if c.p.drawing_levels.iter().any(|l| l.id == c.a.floor && matches!(l.kind, DrawingLevelKind::Drawing)) {
        return;
    }
    let greyed = Some(c.greyed(SECTION_LINE_CATEGORY));
    for level in &c.p.drawing_levels {
        if !matches!(level.kind, DrawingLevelKind::Section | DrawingLevelKind::Elevation) {
            continue;
        }
        let Some([p0, p1]) = level.line_points else { continue };
        let f = crate::plan::misc::section_line(p0.x, p0.y, p1.x, p1.y, level.direction_sign.unwrap_or(1.0));
        if f.is_empty() {
            continue;
        }
        let n = f[0] as usize;
        let mut i = 1;
        for _ in 0..n {
            if f[i] == 2.0 {
                let main = f[i + 1] == 0.0;
                out.push(Primitive::Line {
                    a: v2(f[i + 2], f[i + 3]),
                    b: v2(f[i + 4], f[i + 5]),
                    cls: "section-line".into(),
                    weight_mm: if main { SECTION_LINE_MM } else { SECTION_LINE_MARK_MM },
                    dash: main.then(|| Some(SECTION_LINE_DASH.to_vec())),
                    zigzag: None,
                    motif: None,
                    color: Some(SECTION_LINE_INK.into()),
                    drawing_id: None,
                    opening_id: None,
                    stair_id: None,
                    greyed,
                    opacity: None,
                });
                i += 6;
            } else if f[i] == 5.0 {
                out.push(Primitive::DrawingText {
                    at: v2(f[i + 1], f[i + 2]),
                    text: section_label_tag(&level.name),
                    height_m: SECTION_LABEL_H,
                    angle: 0.0,
                    color: SECTION_LINE_INK.into(),
                    marks: None,
                    wrap_width: None,
                    doc: None,
                    drawing_id: None,
                    greyed,
                    opacity: None,
                });
                i += 3;
            } else {
                let pts = (0..4).map(|j| v2(f[i + 1 + 2 * j], f[i + 2 + 2 * j])).collect();
                out.push(pick_band(pts, None, Some(&level.id)));
                i += 9;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Oberstes Kontext-Pick-Band unter dem Punkt (wie `PickIndex::polygons_at` mit Maske „Kontext").
    fn top_context(out: &[Primitive], x: f64, y: f64) -> Option<String> {
        out.iter().rev().find_map(|q| match q {
            Primitive::Polygon { pts, context_object_id: Some(id), .. } => {
                let flat: Vec<f64> = pts.iter().flat_map(|v| [v.x, v.y]).collect();
                crate::plan::pick::point_in_polygon(x, y, &flat).then(|| id.clone())
            }
            _ => None,
        })
    }

    /// [137] Auswahl im Grundriss: Klick in die Baugrube (Sohle und Böschung) wählt die Baugrube, auch wenn
    /// das Gelände in der Liste später kommt; daneben das Gelände; ausserhalb des Geländes die Höhenlinien.
    #[test]
    fn auswahl_gelaende_baugrube_hoehenlinien() {
        let t = TerrainMesh {
            id: "t".into(),
            positions: vec![0.0, 0.0, 0.0, 60.0, 0.0, 6.0, 60.0, 40.0, 6.0, 0.0, 40.0, 0.0],
            indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
            category_code: Some("02".into()),
            ..Default::default()
        };
        let pit = Excavation {
            id: "bg".into(),
            outline: vec![v2(20.0, 15.0), v2(30.0, 15.0), v2(30.0, 25.0), v2(20.0, 25.0)],
            bottom: 1.0,
            ..Default::default()
        };
        let cs = ContourSet {
            id: "hl".into(),
            contours: vec![Contour { z: 0.0, pts: vec![v2(-20.0, -5.0), v2(80.0, 50.0)], ..Default::default() }],
            ..Default::default()
        };
        // Reihenfolge wie im Musterhaus komplex: Höhenlinien, Baugrube, dann das daraus erzeugte Gelände.
        let p = Project { context: Some(vec![ContextObject::ContourSet(cs), ContextObject::Excavation(pit), ContextObject::TerrainMesh(t)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02"], "scale": 100}"#).unwrap();
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        assert_eq!(top_context(&out, 25.0, 20.0).as_deref(), Some("bg"), "Sohle");
        // Ostseite: Gelände 3 m bei x = 30, Sohle 1 m → 2 m Böschung (45°) bis x ≈ 32.
        assert_eq!(top_context(&out, 31.0, 20.0).as_deref(), Some("bg"), "Böschung");
        assert_eq!(top_context(&out, 50.0, 5.0).as_deref(), Some("t"), "Gelände");
        assert_eq!(top_context(&out, -10.0, 0.0).as_deref(), Some("hl"), "Höhenlinien");
        assert_eq!(top_context(&out, -30.0, 0.0), None);
    }

    /// [140] Höhenlinien enden an der Gebäudegrundfläche (Wände vereinigt, ganzer Aussenring).
    #[test]
    fn hoehenlinien_enden_am_gebaeude() {
        let ring = [v2(0.0, 0.0), v2(10.0, 0.0), v2(10.0, 8.0), v2(0.0, 8.0)];
        let rings = vec![ring.to_vec()];
        // Quer durch: nur die beiden Stücke ausserhalb bleiben.
        let parts = outside(v2(-5.0, 4.0), v2(15.0, 4.0), &rings);
        assert_eq!(parts.len(), 2);
        assert!((parts[0].1.x - 0.0).abs() < 1e-9 && (parts[1].0.x - 10.0).abs() < 1e-9);
        // Ganz innen (im Raum, keine Kante in der Nähe): weg; ganz aussen: bleibt.
        assert!(outside(v2(4.0, 4.0), v2(5.0, 4.0), &rings).is_empty());
        assert_eq!(outside(v2(20.0, 4.0), v2(25.0, 4.0), &rings).len(), 1);
        // Im Plan: Gelände z = x/10, Haus aus vier Wänden 12..18 × 0..10 → keine Höhenlinie bei x = 15 im Haus.
        let t = TerrainMesh { id: "t".into(), positions: vec![0.0, 0.0, 0.0, 30.0, 0.0, 3.0, 30.0, 10.0, 3.0, 0.0, 10.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.5), ..Default::default() };
        let mut v: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let wall = |id: &str, a: [f64; 2], b: [f64; 2]| serde_json::json!({"id": id, "type": "wall", "floorId": v["drawingLevels"][0]["id"], "categoryCode": "20", "wallTypeId": v["walls"][0]["wallTypeId"], "start": {"x": a[0], "y": a[1]}, "end": {"x": b[0], "y": b[1]}, "height": 3});
        let walls = serde_json::json!([wall("a", [12.0, -2.0], [18.0, -2.0]), wall("b", [18.0, -2.0], [18.0, 12.0]), wall("c", [18.0, 12.0], [12.0, 12.0]), wall("d", [12.0, 12.0], [12.0, -2.0])]);
        v["walls"] = walls;
        v["openings"] = serde_json::json!([]);
        let mut p: Project = serde_json::from_value(v).unwrap();
        p.context = Some(vec![ContextObject::TerrainMesh(t)]);
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"scale": 100}"#).unwrap();
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        let lines: Vec<(Vec2, Vec2)> = out.iter().filter_map(|q| match q { Primitive::Line { a, b, color: Some(c), .. } if c == TERRAIN_INK => Some((*a, *b)), _ => None }).collect();
        assert!(lines.iter().any(|(a, _)| (a.x - 5.0).abs() < 1e-6), "Höhenlinie ausserhalb fehlt");
        assert!(lines.iter().all(|(a, b)| !((a.x - 15.0).abs() < 1e-6 && (a.y + b.y) / 2.0 > 0.0 && (a.y + b.y) / 2.0 < 10.0)), "Höhenlinie im Haus");
        // [33] Regel für Gelände (Bauteilart „Gelände“): Linie umgefärbt/gestrichelt, dann ausgeblendet.
        let rule = |actions: serde_json::Value| -> OverrideRule {
            serde_json::from_value(serde_json::json!({"id": "t", "name": "t", "enabled": true, "condition": {"type": "element_kind", "operator": "equals", "value": "terrain"}, "actions": actions})).unwrap()
        };
        p.override_rules = Some(vec![rule(serde_json::json!({"color": "#00aa00", "linetypeId": "hatch-dash"}))]);
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        let ls: Vec<_> = out.iter().filter_map(|q| match q { Primitive::Line { color, dash, .. } => Some((color.clone(), dash.clone())), _ => None }).collect();
        assert!(!ls.is_empty() && ls.iter().all(|(c, d)| c.as_deref() == Some("#00aa00") && d == &Some(Some(vec![0.35, 0.3]))));
        p.override_rules = Some(vec![rule(serde_json::json!({"hide": true}))]);
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        assert!(out.is_empty(), "Gelände samt Höhenlinien und Pick-Fläche ausgeblendet");
    }

    /// [140] Steile Stellen (Stützmauer, Böschung): Höhenlinien enger als 0.6 mm auf dem Papier werden
    /// ausgedünnt (jede zweite, sonst nur Zähllinien); im flachen Teil bleiben alle.
    #[test]
    fn hoehenlinien_ausgeduennt_wo_zu_eng() {
        // x 0..10 flach (z = 0.1 x), x 10..11 steil (z 1 → 11).
        let t = TerrainMesh {
            id: "t".into(),
            positions: vec![0.0, 0.0, 0.0, 10.0, 0.0, 1.0, 10.0, 10.0, 1.0, 0.0, 10.0, 0.0, 11.0, 0.0, 11.0, 11.0, 10.0, 11.0],
            indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0, 1.0, 4.0, 5.0, 1.0, 5.0, 2.0],
            contour_interval: Some(0.1),
            ..Default::default()
        };
        let p = Project { context: Some(vec![ContextObject::TerrainMesh(t)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"scale": 100}"#).unwrap();
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        let xs: Vec<f64> = out.iter().filter_map(|q| match q { Primitive::Line { a, b, color: Some(c), .. } if c == TERRAIN_INK && (a.x - b.x).abs() < 1e-9 => Some(a.x), _ => None }).collect();
        let flat = xs.iter().filter(|x| **x > 0.5 && **x < 9.5).count();
        let steep: Vec<f64> = xs.iter().copied().filter(|x| *x > 10.05 && *x < 10.95).collect();
        assert_eq!(flat, 18, "flach: alle neun Linien (je zwei Dreiecke)");
        // Steil: Abstand 1 mm = 0.01 mm Papier → nur Zähllinien (jede 5.: z = 1.5, 2 … 10.5).
        assert!(!steep.is_empty() && steep.len() <= 3 * 19, "{steep:?}");
        assert!(steep.iter().all(|x| { let z = 1.0 + (x - 10.0) * 10.0; ((z * 2.0).round() - z * 2.0).abs() < 1e-6 }), "nur Zähllinien: {steep:?}");
    }

    /// [T6]/[68] Höhenlinien (Zähllinien dicker + beschriftet) und Baugrube (Sohle, Oberkante, Schraffur).
    #[test]
    fn hoehenlinien_und_baugrube() {
        // Ebene schräg: z = x/10 über 0..40 m → Linien bei x = 10, 20, 30 (Äquidistanz 1), Zähllinie bei 0/5 m.
        let t = TerrainMesh {
            id: "t".into(),
            positions: vec![0.0, 0.0, 0.0, 60.0, 0.0, 6.0, 60.0, 40.0, 6.0, 0.0, 40.0, 0.0],
            indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
            category_code: Some("02".into()),
            contour_interval: Some(1.0),
            ..Default::default()
        };
        let pit = Excavation {
            id: "bg".into(),
            outline: vec![v2(20.0, 15.0), v2(30.0, 15.0), v2(30.0, 25.0), v2(20.0, 25.0)],
            bottom: 1.0,
            ..Default::default()
        };
        let p = Project { context: Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02"], "scale": 100}"#).unwrap();
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        let w = |m: f64| out.iter().filter(|q| matches!(q, Primitive::Line { weight_mm, color: Some(c), .. } if *weight_mm == m && c == TERRAIN_INK)).count();
        assert!(w(0.1) > 4 && w(0.18) > 0, "{} {}", w(0.1), w(0.18));
        let labels: Vec<&str> = out.iter().filter_map(|q| if let Primitive::DrawingText { text, .. } = q { Some(text.as_str()) } else { None }).collect();
        assert!(labels.contains(&"5"), "{labels:?}");
        let ex = out.iter().filter(|q| matches!(q, Primitive::Line { color: Some(c), .. } if c == EXCAVATION_INK)).count();
        assert!(ex > 20, "{ex}");
        // Die Zähllinie ist unter ihrer Beschriftung unterbrochen: keine Linie läuft durch den Textmittelpunkt.
        let at = out.iter().find_map(|q| if let Primitive::DrawingText { text, at, .. } = q { (text == "5").then_some(*at) } else { None }).unwrap();
        let near = out.iter().filter(|q| matches!(q, Primitive::Line { a, b, weight_mm, color: Some(c), .. }
            if *weight_mm == 0.18 && c == TERRAIN_INK && (a.x.min(b.x) - 0.01..=a.x.max(b.x) + 0.01).contains(&at.x) && (a.y.min(b.y) - 0.01..=a.y.max(b.y) + 0.01).contains(&at.y))).count();
        assert_eq!(near, 0, "Linie läuft durch das Etikett bei {at:?}");
    }

    /// Gedrehtes Rechteck einer Höhenlinien-Beschriftung (wie `Obstacles::text`).
    fn label_rect(q: &Primitive) -> Option<(String, Vec<[f64; 2]>)> {
        let Primitive::DrawingText { at, text, height_m: h, angle, .. } = q else { return None };
        let w = crate::text_layout::text_width_em(text, false) * h;
        let (c, s) = (angle.cos(), angle.sin());
        let ring = [[0.0, -0.25 * h], [w, -0.25 * h], [w, 0.95 * h], [0.0, 0.95 * h]].iter().map(|q| [at.x + q[0] * c - q[1] * s, at.y + q[0] * s + q[1] * c]).collect();
        Some((text.clone(), ring))
    }

    fn sample_with_walls(walls: serde_json::Value) -> Project {
        let mut v: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let wt = v["walls"][0]["wallTypeId"].clone();
        let mut ws = Vec::new();
        for w in walls.as_array().unwrap() {
            ws.push(serde_json::json!({"id": w[0], "type": "wall", "floorId": w[1], "categoryCode": "20", "wallTypeId": wt, "start": {"x": w[2], "y": w[3]}, "end": {"x": w[4], "y": w[5]}, "height": 3}));
        }
        v["walls"] = serde_json::Value::Array(ws);
        for k in ["openings", "rooms", "ceilings", "stairs", "roofs", "extrudedSolids", "columns", "drawings2d"] {
            if v.get(k).is_some() {
                v[k] = serde_json::json!([]);
            }
        }
        serde_json::from_value(v).unwrap()
    }

    /// [150] Ein Anbau, der nur von Wänden umschlossen ist (kein Raum, keine Decke), gehört zum Fussabdruck:
    /// keine Höhenlinie und keine Beschriftung darin. Wände anderer Geschosse (ausser dem Erdgeschoss) schneiden
    /// die Höhenlinien des Geschosses nicht.
    #[test]
    fn hoehenlinie_durch_umschlossenen_anbau_ausgespart() {
        let mut p = sample_with_walls(serde_json::json!([
            ["h1", "eg", 14.0, 0.0, 26.0, 0.0], ["h2", "eg", 26.0, 0.0, 26.0, 8.0], ["h3", "eg", 26.0, 8.0, 14.0, 8.0], ["h4", "eg", 14.0, 8.0, 14.0, 0.0],
            // Anbau Nord: drei Wände an die Hausmauer, innen kein Raum.
            ["a1", "eg", 18.5, 8.0, 18.5, 12.0], ["a2", "eg", 18.5, 12.0, 21.5, 12.0], ["a3", "eg", 21.5, 12.0, 21.5, 8.0],
            // Obergeschoss: Wand frei über dem Gelände (Auskragung) — im EG-Grundriss kein Schnitt.
            ["o1", "og", 30.0, 20.0, 38.0, 20.0]
        ]));
        // Gelände z = y/10 über 40 × 30 m: Höhenlinien waagrecht je 1 m, Zähllinien je 5 m (z = 0.5, 1.0 …).
        let t = TerrainMesh { id: "t".into(), positions: vec![0.0, 0.0, 0.0, 40.0, 0.0, 0.0, 40.0, 30.0, 3.0, 0.0, 30.0, 3.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.1), ..Default::default() };
        p.context = Some(vec![ContextObject::TerrainMesh(t)]);
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "scale": 100}"#).unwrap();
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        let lines: Vec<(Vec2, Vec2)> = out.iter().filter_map(|q| match q { Primitive::Line { a, b, color: Some(c), .. } if c == TERRAIN_INK => Some((*a, *b)), _ => None }).collect();
        let in_annex = |x: f64, y: f64| x > 18.4 && x < 21.6 && y > 7.9 && y < 12.1;
        let in_house = |x: f64, y: f64| (x > 13.9 && x < 26.1 && y > -0.1 && y < 8.1) || in_annex(x, y);
        assert!(lines.iter().any(|(a, b)| (a.y - 10.0).abs() < 1e-6 && (b.y - 10.0).abs() < 1e-6), "Höhenlinie y = 10 fehlt ganz");
        for (a, b) in &lines {
            let m = ((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
            assert!(!in_annex(m.0, m.1), "Höhenlinie im Anbau: {a:?}–{b:?}");
            assert!(!in_house(m.0, m.1), "Höhenlinie im Haus: {a:?}–{b:?}");
        }
        // Die OG-Wand bei y = 20 schneidet die Höhenlinie im EG nicht.
        assert!(lines.iter().any(|(a, b)| (a.y - 20.0).abs() < 1e-6 && a.x.min(b.x) < 34.0 && a.x.max(b.x) > 34.0), "Höhenlinie unter der OG-Wand fehlt");
        // Beschriftungen ausserhalb des Gebäudes; die Zähllinie y = 10 (z = 1.0) ist trotzdem beschriftet.
        let labels: Vec<(String, Vec<[f64; 2]>)> = out.iter().filter_map(label_rect).collect();
        assert!(labels.iter().any(|(t, _)| t == "1.0"), "{:?}", labels.iter().map(|l| &l.0).collect::<Vec<_>>());
        for (t, r) in &labels {
            assert!(r.iter().all(|q| !in_house(q[0], q[1])), "Beschriftung {t} im Gebäude: {r:?}");
        }
    }

    /// [150] Beschriftungen der Höhenlinien überdecken sich nicht (auch wo die Zähllinien eng liegen), halten
    /// Abstand entlang der Linie und liegen nicht auf der Bemassung.
    #[test]
    fn hoehenlinien_beschriftungen_kollisionsfrei() {
        // Steil: z = 4·y über 40 × 10 m → Zähllinien (z = 0.5 k) alle 0.125 m = 1.25 mm Papier.
        let t = TerrainMesh { id: "t".into(), positions: vec![0.0, 0.0, 0.0, 40.0, 0.0, 0.0, 40.0, 10.0, 40.0, 0.0, 10.0, 40.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.1), ..Default::default() };
        let dim: Drawing2D = serde_json::from_value(serde_json::json!({ "id": "d", "type": "drawing2d", "levelId": "eg", "categoryCode": "80", "geom": { "shape": "dimension", "pts": [{ "x": 2.0, "y": 5.0 }, { "x": 38.0, "y": 5.0 }], "offset": 0.0 } })).unwrap();
        let p = Project { context: Some(vec![ContextObject::TerrainMesh(t)]), drawings2d: vec![dim], ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["80"], "scale": 100}"#).unwrap();
        let c = Ctx::new(&p, &a);
        let mut out = Vec::new();
        plan_context(&c, &mut out);
        let labels: Vec<(String, Vec<[f64; 2]>)> = out.iter().filter_map(label_rect).collect();
        assert!(labels.len() >= 6, "zu wenige Beschriftungen: {}", labels.len());
        for i in 0..labels.len() {
            for j in i + 1..labels.len() {
                assert!(!super::super::stamp_place::convex_overlap(&labels[i].1, &labels[j].1), "{} über {}", labels[i].0, labels[j].0);
            }
        }
        // Gleiche Linie: mindestens 50 mm Papier (5 m) auseinander.
        let mid = |r: &[[f64; 2]]| ((r[0][0] + r[2][0]) / 2.0, (r[0][1] + r[2][1]) / 2.0);
        for i in 0..labels.len() {
            for j in i + 1..labels.len() {
                if labels[i].0 == labels[j].0 {
                    let (a, b) = (mid(&labels[i].1), mid(&labels[j].1));
                    assert!((a.0 - b.0).hypot(a.1 - b.1) > 5.0, "{} doppelt zu nah", labels[i].0);
                }
            }
        }
        // Nicht auf der Bemassung.
        let mut o = super::super::stamp_place::Obstacles::default();
        for q in super::super::drawings::stamp_obstacle_prims(&c) {
            o.add_prim(&q);
        }
        assert!(!o.is_empty());
        for (t, r) in &labels {
            assert!(!o.hits_convex(r), "Beschriftung {t} auf der Bemassung");
        }
    }

    #[test]
    fn label_tag_wie_ts() {
        assert_eq!(section_label_tag("Schnitt A"), "A");
        assert_eq!(section_label_tag("  Ansicht   Süd "), "Süd");
        assert_eq!(section_label_tag("Längsschnitt"), "Längsschnitt");
        assert_eq!(section_label_tag("   "), "");
        assert_eq!(section_label_tag("a\u{A0}b"), "b");
    }
}
