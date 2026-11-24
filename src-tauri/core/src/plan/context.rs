//! Projektglobale Referenzen im Grundriss auf dem Dokument ([K3d]): Kontext-Konturen (Höhenlinien,
//! Fussabdruck importierter Gebäude, Rahmen von Gelände-Meshes, Pick-Bänder) und Schnittführungs-
//! Symbole der Schnitt-/Ansichtsebenen — Rust-Gegenstück zu `generatePlan/{context,sections}.ts`.
//! Die Geometrie liegt in `plan_misc.rs`; die Meshes werden direkt aus dem Dokument gelesen.

use crate::jsnum::ClampSafe;
use super::domains::Ctx;
use super::overrides::{js_space, js_trim};
use super::prim::Primitive;
use super::style::no_hatch;
use crate::model::*;

const CONTEXT_LINE_COLOR: &str = "#9aa3ad";
const CONTEXT_LINE_MM: f64 = 0.1;
/// Kategorie der Schnittführungs-Symbole (Referenzen).
/// [180] Schnitt-/Ansichtsmarken liegen auf der Standard-Klasse „Schnittmarken" (früher „90 Referenzen").
const SECTION_LINE_CATEGORY: &str = crate::standards::SECTION_MARK_CATEGORY;
const SECTION_LINE_INK: &str = "#1f242c";
const SECTION_LINE_MM: f64 = 0.18;
/// [176] Kräftige Endstücke und Blickrichtungs-Schenkel.
const SECTION_LINE_MARK_MM: f64 = 0.5;
const SECTION_LINE_DASH: [f64; 4] = super::line_pattern::SECTION_LINE;
/// [176] Beschriftungshöhe in Papier-mm (Modell-Meter = mm · Massstab/1000).
const SECTION_LABEL_MM: f64 = 3.5;
/// [296] Präsentationsblatt: so weit (Papier-mm) darf eine Schnitt-/Ansichtslinie über das Haus hinausreichen; mit ihrer Marke
/// (`MARKS_MARGIN_MM`) bleibt sie im Ausschnitt des Plakats (`MARKS_REACH_MM`) und bläht ein gewöhnliches Blatt kaum auf.
const SECTION_OVERSHOOT_MM: f64 = 15.0;

/// [276] Farbe, Strichstärken und Linientyp einer Schnitt-/Ansichtslinie: Stift (aktiver Stiftsatz) > Linientyp > Basis.
struct LineInk {
    color: String,
    main_w: f64,
    mark_w: f64,
    main_dash: Option<Vec<f64>>,
    piece_dash: Option<Vec<f64>>,
    zigzag: Option<LineStyleZigzag>,
    motif: Option<LineStyleMotif>,
    /// Zickzack/Motiv gelten für die Hauptlinie (`full`) bzw. die Endstücke (`ends`).
    styled_ends: bool,
}

fn line_ink(p: &Project, level: &DrawingLevel, look: &crate::plan::misc::SectionLook) -> LineInk {
    let ls = level.line_style_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.line_style(id));
    let pen = level.line_pen_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| {
        let set = p.pen_sets.as_deref()?.iter().find(|s| Some(&s.id) == p.active_pen_set_id.as_ref())?;
        Some(set.pens.get(id).map_or((crate::pens::PEN_FALLBACK_COLOR.to_string(), crate::pens::PEN_FALLBACK_WEIGHT), |st| (st.color.clone(), st.weight)))
    });
    let ends = look.line == SectionLineMode::Ends;
    let pen_w = pen.as_ref().map(|x| x.1).filter(|w| w.is_finite() && *w > 0.0);
    let color = pen.as_ref().map(|x| x.0.clone()).or_else(|| ls.map(|l| l.color.clone()).filter(|c| !c.is_empty())).unwrap_or_else(|| SECTION_LINE_INK.to_string());
    LineInk {
        color,
        main_w: pen_w.unwrap_or(SECTION_LINE_MM),
        mark_w: if ends || look.line == SectionLineMode::None { pen_w.unwrap_or(SECTION_LINE_MARK_MM) } else { pen_w.map_or(SECTION_LINE_MARK_MM, |w| w.max(SECTION_LINE_MARK_MM)) },
        main_dash: match ls {
            Some(l) => l.dash.clone().filter(|d| !d.is_empty()),
            None => Some(SECTION_LINE_DASH.to_vec()),
        },
        piece_dash: if ends { ls.and_then(|l| l.dash.clone()).filter(|d| !d.is_empty()) } else { None },
        zigzag: ls.filter(|l| l.kind == Some(LineStyleKind::Zigzag)).and_then(|l| l.zigzag.clone()),
        motif: ls.filter(|l| l.kind == Some(LineStyleKind::Custom)).and_then(|l| l.motif.clone()),
        styled_ends: ends,
    }
}

impl LineInk {
    /// Linie `a`–`b`: `main` = dünne Hauptlinie, sonst kräftiges Stück bzw. Schenkel.
    fn line(&self, a: Vec2, b: Vec2, main: bool, greyed: Option<bool>) -> Primitive {
        let styled = main != self.styled_ends;
        Primitive::Line {
            a,
            b,
            cls: "section-line".into(),
            weight_mm: if main { self.main_w } else { self.mark_w },
            dash: if main { Some(self.main_dash.clone()) } else { self.piece_dash.clone().map(Some) },
            zigzag: if styled { self.zigzag.clone() } else { None },
            motif: if styled { self.motif.clone() } else { None },
            color: Some(self.color.clone().into()),
            drawing_id: None,
            opening_id: None,
            stair_id: None,
            greyed,
            opacity: None,
        }
    }
}

fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

fn context_line(a: Vec2, b: Vec2) -> Primitive {
    Primitive::Line { a, b, cls: "context-line".into(), weight_mm: CONTEXT_LINE_MM, dash: None, zigzag: None, motif: None, color: Some(CONTEXT_LINE_COLOR.into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None }
}

pub(super) fn pick_band(pts: Vec<Vec2>, context_id: Option<&str>, section_id: Option<&str>) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: "none".into(),
        stroke: "none".into(),
        stroke_width_mm: 0.0,
        hatch: Box::new(no_hatch()),
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

/// Gelände- und Umgebungs-Elemente (`Project.context`, [181]); sichtbar nach ihrer Klasse. Die
/// Höhenlinien-Beschriftungen weichen den Zeichnungen des Geschosses aus (`drawings::stamp_obstacle_prims`).
pub fn plan_context(c: &Ctx, out: &mut Vec<Primitive>) {
    plan_context_with(c, out, c.drawn_obstacles());
}

/// Wie [`plan_context`], mit den schon gesammelten Hindernissen der Zeichnungen (Bemassung, Koten, Texte …).
pub fn plan_context_with(c: &Ctx, out: &mut Vec<Primitive>, drawing_obstacles: &super::stamp_place::Obstacles) {
    // [137] Pick-Flächen der Baugruben zuletzt (zuoberst): sie liegen im Rahmen des Geländes, das sonst
    // jeden Klick in der Grube fängt.
    let mut late: Vec<Primitive> = Vec::new();
    // [140]/[150] Höhenlinien, Böschungsschraffur und Beschriftungen enden am Fussabdruck des Geschosses.
    let mut house_cache: Option<Vec<Vec<Vec2>>> = None;
    // [207] Situationsplan: Kontextgebäude gefüllt; die Höhenlinien enden auch an ihnen.
    let sit = super::situation::opts(c);
    let mut house = || -> Vec<Vec<Vec2>> {
        house_cache
            .get_or_insert_with(|| {
                let mut h = terrain_footprint(c.p, &c.a.floor);
                if let Some(s) = &sit {
                    h.extend(super::situation::own_rings(c.p));
                    h.extend(super::situation::context_rings(c, s));
                } else {
                    h.extend(filled_context_rings(c));
                }
                h
            })
            .clone()
    };
    let mut label_obst: Option<super::stamp_place::Obstacles> = None;
    // [152] Importierte Netze im Geschoss nach dem Ansichtsbereich (`mesh_plan.rs`); sonst Fussabdruck.
    let meshes_done = sit.is_none() && super::mesh_plan::plan_meshes(c, out);
    for obj in c.p.context.as_deref().unwrap_or(&[]) {
        if meshes_done && matches!(obj, ContextObject::ImportedMesh(_)) {
            continue;
        }
        // [181] Sichtbarkeit allein über die Klasse (kein „ohne Kategorie immer sichtbar", kein Einzel-Ausblenden).
        let code = Some(obj.category_code());
        if !c.shown(obj.category_code()) {
            continue;
        }
        if matches!(obj, ContextObject::TerrainMesh(_) | ContextObject::ContourSet(_) | ContextObject::Excavation(_)) && !terrain_shown(c) {
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
                    let bb = rings_bbox(&rings);
                    for i in 0..seg_end {
                        for (a, b) in outside_bb(pts[i], pts[(i + 1) % pts.len()], &rings, bb) {
                            out.push(context_line(a, b));
                        }
                    }
                }
            }
            ContextObject::ImportedMesh(m) if sit.is_some() => {
                if let Some(s) = &sit {
                    super::situation::context_mesh(c, s, m, out);
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
                    o.extend(c.bubble_obstacles());
                    // [157] Baugruben (Sohle, Böschungsoberkante, Böschungsschraffur): keine Höhenkote darauf.
                    for q in out.iter().filter(|q| matches!(q, Primitive::Line { cls, color: Some(k), .. } if cls == "context-line" && k == EXCAVATION_INK)) {
                        o.add_prim(q);
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

/// [256] Grundflächen der sichtbaren Netze auf Klassen mit Füllung (Nachbargebäude hellgrau, `style::class_cut_style`):
/// die Höhenlinien enden an ihnen wie am eigenen Haus, statt über die graue Fläche zu laufen.
fn filled_context_rings(c: &Ctx) -> Vec<Vec<Vec2>> {
    let mut out = Vec::new();
    for o in c.p.context.as_deref().unwrap_or(&[]) {
        let ContextObject::ImportedMesh(m) = o else { continue };
        if !c.shown(&m.category_code) || super::style::class_cut_style(c.p, &m.category_code).is_none() {
            continue;
        }
        for poly in super::situation::mesh_polygons(&m.positions, &m.indices) {
            if let Some(r) = poly.first().filter(|r| r.len() >= 3) {
                out.push(r.iter().map(|q| v2(q[0], q[1])).collect());
            }
        }
    }
    out
}

/// [157] Sohle und Böschungsoberkante der Baugruben, die dieser Grundriss zeigt (Gelände sichtbar, Kategorie
/// der Baugrube gezeigt), als Strecken — Hindernisse der Aussenbemassung und der Schnittmarken-Beschriftung.
pub(super) fn excavation_segments(c: &Ctx) -> Vec<([f64; 2], [f64; 2])> {
    let pits: Vec<&Excavation> = crate::excavation::excavations(c.p).into_iter().filter(|e| c.shown(&e.category_code)).collect();
    if pits.is_empty() || !terrain_shown(c) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for e in pits {
        let ring: Vec<[f64; 2]> = e.ring().iter().filter(|q| q.x.is_finite() && q.y.is_finite()).map(|q| [q.x, q.y]).collect();
        for i in 0..ring.len() {
            out.push((ring[i], ring[(i + 1) % ring.len()]));
        }
        for t in crate::excavation::terrains(c.p) {
            let st = crate::excavation::site_terrain(c.p, t);
            if let Some((_, _, daylight)) = st.items.iter().find(|(id, ..)| *id == e.id) {
                for l in daylight {
                    out.extend(l.windows(2).map(|w| (w[0], w[1])));
                }
                break;
            }
        }
    }
    out
}

/// [157] Gelände, Höhenlinien und Baugruben in diesem Grundriss: Feld `showTerrain` der Ebene, sonst nur im
/// Geschoss nächst ±0.00 (`extras::ground_floor_id`) und in der Situation (ab 1:500). Ohne Geschoss-Ebenen
/// bzw. für eine unbekannte Ebene immer (Ausschnitte, Tests).
pub(super) fn terrain_shown(c: &Ctx) -> bool {
    // [173] Ebene > Modelldarstellung > automatisch.
    let level = c.p.drawing_levels.iter().find(|l| l.id == c.a.floor && l.kind == DrawingLevelKind::Floor);
    if let Some(v) = c.mv().terrain(level.and_then(|l| l.show_terrain)) {
        return v;
    }
    terrain_shown_on(c.p, &c.a.floor, c.a.scale)
}

/// [`terrain_shown`] für Ebene `floor` im Massstab 1:`scale`.
fn terrain_shown_on(p: &Project, floor: &str, scale: f64) -> bool {
    let lvl = p.drawing_levels.iter().find(|l| l.id == floor && l.kind == DrawingLevelKind::Floor);
    if let Some(v) = lvl.and_then(|l| l.show_terrain) {
        return v;
    }
    match (lvl, super::extras::ground_floor_id(p)) {
        (Some(l), Some(g)) => l.id == g || scale >= 500.0 - 1e-9,
        _ => true,
    }
}

/// [33] Linien (und Beschriftungen) nach den Element-Aktionen einer Regel: Farbe, Strichstärke, Linienstil.
pub(super) fn restyle_lines(p: &Project, a: &super::overrides::Actions, prims: &mut [Primitive]) {
    let dash = super::overrides::linetype_dash(p, a.linetype_id.as_deref());
    for q in prims {
        match q {
            Primitive::Line { color, weight_mm, dash: d, .. } => {
                if let Some(c) = &a.color {
                    *color = Some(c.clone().into());
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
        parts.extend(ring(&c.ring()));
    }
    for r in p.rooms.as_deref().unwrap_or(&[]).iter().filter(|r| on(&r.floor_id)) {
        parts.extend(ring(&r.ring()));
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]).iter().filter(|s| on(&s.level_id) && s.operation.as_deref() != Some("subtract")) {
        parts.extend(ring(&s.points));
    }
    if parts.is_empty() {
        return Vec::new();
    }
    crate::polygon_bool::union(&parts).into_iter().filter_map(|poly| poly.into_iter().next()).filter(|r| r.len() >= 3).map(|r| r.iter().map(|q| v2(q[0], q[1])).collect()).collect()
}

pub(super) fn seg_dist(q: Vec2, a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((q.x - a[0]) * dx + (q.y - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (q.x - a[0] - t * dx).hypot(q.y - a[1] - t * dy)
}

pub(super) fn inside(q: Vec2, ring: &[Vec2]) -> bool {
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
    outside_bb(a, b, rings, rings_bbox(rings))
}

/// [159] Achsparalleles Rechteck `[x0, y0, x1, y1]` um alle Ringe (für [`outside_bb`]).
pub(super) fn rings_bbox(rings: &[Vec<Vec2>]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for q in rings.iter().flatten() {
        b = [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)];
    }
    b
}

/// Wie [`outside`] mit dem vorab gerechneten Rechteck `bb` um alle `rings` ([`rings_bbox`]): eine Strecke ganz
/// daneben bleibt ohne Kantentest ganz (dasselbe Ergebnis: keine Kante in der Nähe, Anfang in keinem Ring).
pub(super) fn outside_bb(a: Vec2, b: Vec2, rings: &[Vec<Vec2>], bb: [f64; 4]) -> Vec<(Vec2, Vec2)> {
    if a.x.max(b.x) < bb[0] || a.x.min(b.x) > bb[2] || a.y.max(b.y) < bb[1] || a.y.min(b.y) > bb[3] {
        return vec![(a, b)];
    }
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
/// [327] Suchraster über die Kanten der Ringe für [`HouseIndex::outside`]: Höhenlinien bestehen aus Zehntausenden kurzen
/// Strecken, der Fussabdruck (Haus, Terrassen, Baugrube) aus vielen Kanten. Je Strecke nur die Kanten ihrer Zellen;
/// der Punkt-im-Ring-Test zählt nur die Kanten des waagrechten Streifens des Punkts. Dasselbe Ergebnis wie [`outside_bb`].
pub(super) struct HouseIndex<'a> {
    rings: &'a [Vec<Vec2>],
    bb: [f64; 4],
    grid: super::stamp_place::BoxGrid,
    /// Kante `k` = (Ring, Index des Anfangspunkts).
    edges: Vec<(u32, u32)>,
    /// Kanten je waagrechtem Streifen (alle Streifen, die die Kante in y überdeckt): der Punkt-im-Ring-Test zählt nur
    /// Kanten, die die Höhe des Punkts überspannen.
    rows: Vec<Vec<u32>>,
    row_h: f64,
    scratch: std::cell::RefCell<Vec<u32>>,
}

impl<'a> HouseIndex<'a> {
    pub(super) fn new(rings: &'a [Vec<Vec2>]) -> HouseIndex<'a> {
        let bb = rings_bbox(rings);
        let mut edges = Vec::new();
        let mut boxes = Vec::new();
        for (ri, r) in rings.iter().enumerate() {
            let n = r.len();
            for i in 0..n {
                let (p, q) = (r[i], r[(i + 1) % n]);
                edges.push((ri as u32, i as u32));
                boxes.push([p.x.min(q.x), p.y.min(q.y), p.x.max(q.x), p.y.max(q.y)]);
            }
        }
        let n_rows = edges.len().clamp(1, 2048);
        let row_h = ((bb[3] - bb[1]) / n_rows as f64).max(1e-9);
        let mut rows = vec![Vec::new(); if edges.is_empty() || !bb.iter().all(|v| v.is_finite()) { 0 } else { n_rows }];
        if !rows.is_empty() {
            for (k, b) in boxes.iter().enumerate() {
                if !(b[1].is_finite() && b[3].is_finite()) {
                    // Unsinnige Kante: in alle Streifen (der Test selbst verwirft sie wie bisher).
                    rows.iter_mut().for_each(|r| r.push(k as u32));
                    continue;
                }
                let row = |y: f64| (((y - bb[1]) / row_h).floor().max(0.0) as usize).min(n_rows - 1);
                for r in row(b[1])..=row(b[3]) {
                    rows[r].push(k as u32);
                }
            }
        }
        HouseIndex { rings, bb, grid: super::stamp_place::BoxGrid::new(&boxes), edges, rows, row_h, scratch: Default::default() }
    }

    /// Liegt `q` in einem Ring? Wie [`inside`] je Ring (gleiche Rechnung je Kante), aber nur über die Kanten des Streifens.
    fn inside_any(&self, q: Vec2) -> bool {
        if self.rows.is_empty() || self.rings.len() > 128 || !(q.y >= self.bb[1] && q.y <= self.bb[3]) {
            // Ausserhalb der Höhe aller Ringe überspannt keine Kante den Punkt; sonst (Sonderfälle) voll rechnen.
            return if self.rows.is_empty() || self.rings.len() > 128 { self.rings.iter().any(|r| inside(q, r)) } else { false };
        }
        let row = (((q.y - self.bb[1]) / self.row_h).floor().max(0.0) as usize).min(self.rows.len() - 1);
        let mut odd: u128 = 0;
        for &k in &self.rows[row] {
            let (ri, i) = self.edges[k as usize];
            let r = &self.rings[ri as usize];
            // Kante r[i]–r[i+1]; in [`inside`] ist a der spätere, b der frühere Punkt.
            let (b, a) = (r[i as usize], r[(i as usize + 1) % r.len()]);
            if (a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x {
                odd ^= 1u128 << ri;
            }
        }
        odd != 0
    }

    /// Überlappt (oder berührt) der Ring `ring` (Rechteck einer Beschriftung) einen der Ringe? Dasselbe Ergebnis wie
    /// `stamp_place::convex_overlap` je Ring mit Rechteck-Vorprüfung: eine Ecke des einen im anderen oder Kanten kreuzen sich.
    pub(super) fn overlaps(&self, ring: &[[f64; 2]]) -> bool {
        use super::stamp_place::{point_in_ring, ring_bbox, segs_cross};
        if ring.len() < 3 {
            return false;
        }
        let b = ring_bbox(ring);
        let bb = self.bb;
        if b[2] < bb[0] || b[0] > bb[2] || b[3] < bb[1] || b[1] > bb[3] {
            return false;
        }
        // Erste Ecke eines Rings im Rechteck der Beschriftung?
        if self.rings.iter().any(|h| h.len() >= 3 && point_in_ring(ring, [h[0].x, h[0].y])) {
            return true;
        }
        let mut scratch = self.scratch.borrow_mut();
        // Kanten kreuzen sich?
        self.grid.query(b, &mut scratch);
        let n = ring.len();
        for &k in scratch.iter() {
            let (ri, i) = self.edges[k as usize];
            let r = &self.rings[ri as usize];
            if r.len() < 3 {
                continue;
            }
            let (p, q) = (r[i as usize], r[(i as usize + 1) % r.len()]);
            // Kanten neben dem Rechteck der Beschriftung können sie weder kreuzen noch berühren.
            if p.x.max(q.x) < b[0] || p.x.min(q.x) > b[2] || p.y.max(q.y) < b[1] || p.y.min(q.y) > b[3] {
                continue;
            }
            if (0..n).any(|j| segs_cross([p.x, p.y], [q.x, q.y], ring[j], ring[(j + 1) % n])) {
                return true;
            }
        }
        // Erste Ecke der Beschriftung in einem Ring?
        let q = v2(ring[0][0], ring[0][1]);
        if self.rings.iter().all(|r| r.len() >= 3) {
            self.inside_any(q)
        } else {
            self.rings.iter().any(|r| r.len() >= 3 && inside(q, r))
        }
    }

    /// Teile der Strecke a–b ausserhalb aller Ringe (wie [`outside_bb`]).
    pub(super) fn outside(&self, a: Vec2, b: Vec2) -> Vec<(Vec2, Vec2)> {
        let bb = self.bb;
        if a.x.max(b.x) < bb[0] || a.x.min(b.x) > bb[2] || a.y.max(b.y) < bb[1] || a.y.min(b.y) > bb[3] {
            return vec![(a, b)];
        }
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let (lo_x, hi_x, lo_y, hi_y) = (a.x.min(b.x), a.x.max(b.x), a.y.min(b.y), a.y.max(b.y));
        let mut scratch = self.scratch.borrow_mut();
        self.grid.query([lo_x, lo_y, hi_x, hi_y], &mut scratch);
        let mut ts = vec![0.0, 1.0];
        let mut near = false;
        for &k in scratch.iter() {
            let (ri, i) = self.edges[k as usize];
            let r = &self.rings[ri as usize];
            let (p, q) = (r[i as usize], r[(i as usize + 1) % r.len()]);
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
        let at = |t: f64| v2(a.x + dx * t, a.y + dy * t);
        if !near {
            // Ganz innerhalb (ohne Kantenberührung) oder ganz ausserhalb.
            return if self.inside_any(a) { vec![] } else { vec![(a, b)] };
        }
        ts.sort_by(|x, y| x.total_cmp(y));
        ts.windows(2).filter(|w| w[1] - w[0] > 1e-9 && !self.inside_any(at((w[0] + w[1]) / 2.0))).map(|w| (at(w[0]), at(w[1]))).collect()
    }
}

const EXCAVATION_INK: &str = "#1f242c";
/// [68] Warnmarke: Arbeitsraum zu schmal.
const WS_WARN_INK: &str = "#d6001c";

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
        let s = if self.closed && l > 0.0 { s.rem_euclid(l) } else { s.clamp_safe(0.0, l) };
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
        let mut visit = |r: std::ops::Range<usize>| {
            for i in r {
                let (c, q) = (self.cum[i], self.pts[i]);
                let within = if self.closed && l > 0.0 { (c - s0).rem_euclid(l) < s1 - s0 } else { c > s0 && c < s1 };
                if within {
                    d = d.max(seg_dist(v2(q[0], q[1]), a, b));
                }
            }
        };
        // [159] Nur die Ecken in Frage (Bogenlänge sortiert; Obermenge mit Spiel, die Bedingung oben entscheidet
        // wie zuvor) statt aller Ecken je Kandidat.
        let eps = 1e-6 * l.max(1.0);
        let range = |lo: f64, hi: f64| self.cum.partition_point(|c| *c < lo)..self.cum.partition_point(|c| *c <= hi);
        if self.closed && l > 0.0 {
            if s1 - s0 >= l - eps {
                visit(0..self.pts.len());
            } else {
                let a0 = s0.rem_euclid(l);
                let a1 = a0 + (s1 - s0);
                // Der Bogen [a0, a1) und sein Stück über das Ende hinaus (Bogenlängen ab 0 wieder); doppelt
                // besuchte Ecken ändern das Maximum nicht.
                visit(range(a0 - eps, a1 + eps));
                visit(range(a0 - l - eps, a1 - l + eps));
                visit(range(a0 + l - eps, a1 + l + eps));
            }
        } else {
            visit(range(s0 - eps, s1 + eps));
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
        // [159] Rechteck zuerst: eine Strecke neben dem Rechteck des Rings berührt ihn nicht.
        let hit = |a: [f64; 2], c: [f64; 2]| a[0].max(c[0]) >= b[0] && a[0].min(c[0]) <= b[2] && a[1].max(c[1]) >= b[1] && a[1].min(c[1]) <= b[3];
        ids.iter().filter(|i| {
            let (a, c, _) = self.segs[**i];
            hit(a, c) && super::stamp_place::seg_hits_ring(a, c, ring)
        }).count()
    }
}

/// [159] Höhenlinien eines Geländes für den Grundriss: Linienzüge, je Strecke gezeichnet (Ausdünnung nach
/// Massstab) und das Raster der gezeichneten Strecken für die Beschriftung.
struct ContourData {
    isos: Vec<Iso>,
    drawn: Vec<Vec<bool>>,
    grid: SegGrid,
}

type ContourKey = (u64, u64, i64, u64);
thread_local! {
    static CONTOURS: std::cell::RefCell<Vec<(ContourKey, std::rc::Rc<ContourData>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn contour_data(st: &crate::excavation::SiteTerrain, iv: f64, every: i64, scale: f64) -> ContourData {
    let text_h = 0.002 * scale;
    let tin = st.current();
    let idx = st.index_current();
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
    ContourData { isos, drawn, grid }
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
    use std::hash::{Hash, Hasher};
    // [159] Das Ergebnis hängt nur am Gelände, an Äquidistanz/Zähllinien, am Massstab, am Fussabdruck und an den
    // Hindernissen: bei gleichen Eingaben (z. B. eine Innenwand verschoben) aus dem Zwischenspeicher.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for r in house {
        r.len().hash(&mut h);
        for q in r {
            (q.x.to_bits(), q.y.to_bits()).hash(&mut h);
        }
    }
    // [256] Die Linien setzen vor Masszahlen, Texten und Koten aus: deren Aussparungen gehören zum Schlüssel.
    let key: LinesKey = (st.key, iv.to_bits(), every, c.a.scale.max(1.0).to_bits(), h.finish(), obst.sig() ^ c.line_gaps().sig().rotate_left(31));
    if let Some(v) = CONTOUR_LINES.with(|m| m.borrow().iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())) {
        // [179] Mit Luft: sonst verdoppelt das spätere Anhängen (Pick-Flächen) den ganzen Puffer (~20 MB kopieren).
        out.reserve(v.len() + 4096);
        out.extend(v.iter().cloned());
        return;
    }
    let start = out.len();
    contour_prims(c, &st, iv, every, out, house, obst);
    let v = std::rc::Rc::new(out[start..].to_vec());
    CONTOUR_LINES.with(|m| {
        let mut m = m.borrow_mut();
        m.insert(0, (key, v));
        m.truncate(2);
    });
}

type LinesKey = (u64, u64, i64, u64, u64, u64);
thread_local! {
    static CONTOUR_LINES: std::cell::RefCell<Vec<(LinesKey, std::rc::Rc<Vec<Primitive>>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// [`terrain_contours`] ohne Zwischenspeicher.
fn contour_prims(c: &Ctx, st: &crate::excavation::SiteTerrain, iv: f64, every: i64, out: &mut Vec<Primitive>, house: &[Vec<Vec2>], obst: &super::stamp_place::Obstacles) {
    let scale = c.a.scale.max(1.0);
    let text_h = 0.002 * scale;
    // [159] Linien, Ausdünnung und Raster hängen nur am Gelände, an der Äquidistanz und am Massstab: zwischengespeichert.
    let key = (st.key, iv.to_bits(), every, scale.to_bits());
    let data = CONTOURS.with(|m| m.borrow().iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())).unwrap_or_else(|| {
        let v = std::rc::Rc::new(contour_data(st, iv, every, scale));
        CONTOURS.with(|m| {
            let mut m = m.borrow_mut();
            m.insert(0, (key, v.clone()));
            m.truncate(4);
        });
        v
    });
    let ContourData { isos, drawn, grid } = &*data;
    let obst_grid = super::stamp_place::ObstacleGrid::new(obst, 4.0 * text_h);
    let house_idx = HouseIndex::new(house);
    let in_house = |ring: &[[f64; 2]]| house_idx.overlaps(ring);
    // Beschriftungen: Zähllinien, längste zuerst.
    let digits = if iv.fract() == 0.0 { 0 } else { 1 };
    let mut order: Vec<usize> = (0..isos.len()).filter(|i| isos[*i].index && isos[*i].len() >= 12.0 * text_h).collect();
    order.sort_by(|a, b| isos[*b].len().total_cmp(&isos[*a].len()).then(isos[*a].level.total_cmp(&isos[*b].level)));
    let spacing = CONTOUR_LABEL_SPACING_MM / 1000.0 * scale;
    let step = 0.001 * scale;
    let (pad_house, pad_label) = (0.3 * text_h, 0.5 * text_h);
    let mut placed: Vec<(Vec<[f64; 2]>, [f64; 4])> = Vec::new();
    // Je Linie: Lücken (Bogenlänge) unter den Beschriftungen.
    let mut gaps: Vec<Vec<(f64, f64)>> = vec![Vec::new(); isos.len()];
    for li in order {
        let l = &isos[li];
        let len = l.len();
        let text = crate::js_fmt::to_fixed(l.level, digits);
        let hw = crate::text_layout::text_width_em(&text, false) * text_h / 2.0;
        let hv = 0.6 * text_h;
        let reserve = hw + 0.4 * text_h;
        let n = ((len / spacing).floor() as usize).clamp(1, 10_000); // [258] Obergrenze (Massstab ~0)
        let sec = len / n as f64;
        let mut mine: Vec<f64> = Vec::new();
        for i in 0..n {
            let target = (i as f64 + 0.5) * sec;
            let (lo, hi) = if l.closed { (i as f64 * sec, (i + 1) as f64 * sec) } else { ((i as f64 * sec).max(reserve), ((i + 1) as f64 * sec).min(len - reserve)) };
            if hi < lo {
                continue;
            }
            // [150] Erst im Abschnitt auf einer wenig gekreuzten Stelle, sonst entlang der Linie verschoben (ganze
            // Linie, nächste Stelle zur Zielmitte zuerst), erst zuletzt auf dem Bündel — statt ganz ohne Beschriftung.
            let whole = if l.closed { (0.0, len) } else { (reserve, len - reserve) };
            let search = |lo: f64, hi: f64, max_x: usize| -> Option<(usize, f64, [f64; 2], [f64; 2])> {
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
                    if in_house(&padded) || obst_grid.hits_convex(&padded) {
                        continue;
                    }
                    let grown = rot_rect(m, u, hw + pad_label, hv + pad_label / 2.0);
                    // [159] Rechteck zuerst (getrennte Rechtecke überlappen nicht).
                    let gb = super::stamp_place::ring_bbox(&grown);
                    if placed.iter().any(|(r, rb)| rb[2] >= gb[0] && rb[0] <= gb[2] && rb[3] >= gb[1] && rb[1] <= gb[3] && super::stamp_place::convex_overlap(r, &grown)) {
                        continue;
                    }
                    let x = grid.crossings(&rot_rect(m, u, hw, hv), li);
                    if x > max_x {
                        continue;
                    }
                    if best.as_ref().is_none_or(|b| x < b.0) {
                        best = Some((x, s, m, u));
                    }
                    if x == 0 {
                        break;
                    }
                }
                best
            };
            let best = search(lo, hi, 1).or_else(|| search(whole.0, whole.1, 1)).or_else(|| search(lo, hi, usize::MAX));
            let Some((_, s, m, u)) = best else { continue };
            mine.push(s);
            let r = rot_rect(m, u, hw, hv);
            let rb = super::stamp_place::ring_bbox(&r);
            placed.push((r, rb));
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
                // [256] … und vor Masszahlen, Texten und Höhenkoten der Zeichnungen (Höhenlinien durch „17.39“, komplex EG Süd).
                for (p0, p1) in house_idx.outside(pt(f0), pt(f1)).into_iter().flat_map(|(p, q)| c.cut_at_gaps(p, q)) {
                    out.push(ink_line(p0, p1, w, TERRAIN_INK, None));
                }
            }
        }
    }
}

/// [68] Baugrube im Grundriss: Sohle (Böschungsfuss) und Böschungsoberkante, Böschungsschraffur.
/// [150] Böschungsoberkante und -schraffur (Gelände) enden am Fussabdruck `house`; [157] die Sohle auch.
/// [191] Grösster Abstand (m), in dem ein Stück der Sohle als auf dem Gebäude-Umriss liegend gilt: ein Bogen der Sohle
/// und derselbe Bogen am Gebäude sind verschieden fein geteilt (Pfeilhöhe ≤ 5 mm) und liefen sonst als Splitter mal
/// innen, mal aussen.
const SOLE_ON_HOUSE: f64 = 6e-3;

/// [157] Teile der Sohle ausserhalb des Gebäudes; Stücke auf dem Gebäude-Umriss (beide Enden und Mitte näher als
/// [`SOLE_ON_HOUSE`]) zeichnet das Gebäude selbst.
fn sole_pieces(ring: &[Vec2], house: &[Vec<Vec2>]) -> Vec<(Vec2, Vec2)> {
    let near = |q: Vec2| house.iter().any(|r| (0..r.len()).any(|i| seg_dist(q, [r[i].x, r[i].y], [r[(i + 1) % r.len()].x, r[(i + 1) % r.len()].y]) < SOLE_ON_HOUSE));
    let mut out = Vec::new();
    for i in 0..ring.len() {
        for (a, b) in outside(ring[i], ring[(i + 1) % ring.len()], house) {
            if near(a) && near(b) && near(v2((a.x + b.x) / 2.0, (a.y + b.y) / 2.0)) {
                continue;
            }
            out.push((a, b));
        }
    }
    out
}

fn excavation_lines(c: &Ctx, e: &Excavation, out: &mut Vec<Primitive>, bands: &mut Vec<Primitive>, house: &[Vec<Vec2>]) {
    // [191] Bögen fein geteilt (Punkte auf dem Kreis): die Ausgaben fassen die Sohle wieder zu echten Bögen ([169]).
    let ring: Vec<Vec2> = e.ring().iter().copied().filter(|q| q.x.is_finite() && q.y.is_finite()).collect();
    if ring.len() < 3 {
        return;
    }
    // [157] Die Sohle endet ebenfalls am Gebäude: wo es über die Grube reicht (Anbau ohne Untergeschoss),
    // liegt sie unter dem Boden — vorher lief sie als 0.25-mm-Linie quer durch den Raum.
    for (a, b) in sole_pieces(&ring, house) {
        out.push(ink_line(a, b, 0.25, EXCAVATION_INK, None));
    }
    // [137] Pick-Fläche = Wirkbereich (Sohle + Böschungen), ohne Gelände nur die Sohle.
    let hull = crate::excavation::terrains(c.p).into_iter().map(|t| crate::excavation::affected_hull(&crate::excavation::site_terrain(c.p, t), &e.id)).find(|h| h.len() >= 3);
    let band = hull.map_or_else(|| ring.clone(), |h| h.iter().map(|q| v2(q[0], q[1])).collect());
    bands.push(pick_band(band, Some(&e.id), None));
    let spacing = (0.004 * c.a.scale.max(1.0)).max(0.2);
    let house_bb = rings_bbox(house);
    for t in crate::excavation::terrains(c.p) {
        let st = crate::excavation::site_terrain(c.p, t);
        let Some((_, spec, daylight)) = st.items.iter().find(|(id, ..)| *id == e.id) else { continue };
        for l in daylight {
            for w in l.windows(2) {
                for (a, b) in outside_bb(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), house, house_bb) {
                    out.push(ink_line(a, b, 0.18, EXCAVATION_INK, None));
                }
            }
        }
        if let Some(hatch) = crate::excavation::slope_hatch_of(&st, &e.id, spec, spacing) {
            for &(a, b) in hatch.iter() {
                for (a, b) in outside_bb(v2(a[0], a[1]), v2(b[0], b[1]), house, house_bb) {
                    out.push(ink_line(a, b, 0.1, EXCAVATION_INK, None));
                }
            }
        }
        // [68] Verbauwand als Wandband an der Kante: Dicke nach aussen, Schraffur der Verbauart; Pick wählt die Baugrube.
        // [191] Zusammenhängende verbaute Kanten (auch die Teilkanten eines Bogens) als EIN Band.
        let bands = spec.shoring_bands();
        if !bands.is_empty() {
            let hatch = crate::plan::style::resolve_hatch(c.p, crate::excavation::shoring_hatch_id(spec.shore_kind), None, None, None)
                .unwrap_or_else(no_hatch);
            // [199] Das Band endet am Fussabdruck des Geschosses wie Sohle und Böschung (Rühlwand unter einem Anbau ohne
            // Untergeschoss lief sonst über Wände, Boden und Raumstempel).
            let house_polys: Vec<crate::flat::Polygon> = house.iter().map(|r| vec![r.iter().map(|q| [q.x, q.y]).collect()]).collect();
            for b in bands {
                let ring: Vec<[f64; 2]> = b.polygon();
                let pieces: Vec<Vec<[f64; 2]>> = if house_polys.is_empty() {
                    vec![ring]
                } else {
                    crate::polygon_bool::difference(&[vec![ring]], &house_polys).into_iter().filter_map(|poly| poly.into_iter().next()).filter(|r| r.len() >= 3).collect()
                };
                for piece in pieces {
                    let mut band = super::section::polygon(piece.iter().map(|p| v2(p[0], p[1])).collect(), crate::plan::style::HATCH_PAPER, EXCAVATION_INK, 0.25, hatch.clone());
                    if let Primitive::Polygon { context_object_id, .. } = &mut band {
                        *context_object_id = Some(e.id.clone());
                    }
                    out.push(band);
                }
            }
        }
        // [68] Arbeitsraum zu schmal (enge Nische, gekappte Ecke): rotes Kreuz an der Stelle.
        if let Some(chk) = crate::excavation::working_space_check(spec).filter(|w| !w.ok) {
            let r = 0.0025 * c.a.scale.max(1.0);
            for s in chk.spots {
                for (dx, dy) in [(1.0, 1.0), (1.0, -1.0)] {
                    out.push(ink_line(v2(s[0] - dx * r, s[1] - dy * r), v2(s[0] + dx * r, s[1] + dy * r), 0.35, WS_WARN_INK, None));
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

/// [176] Ansichtsmarker als eigenes Symbol: nur ein flaches gefülltes Dreieck in Blickrichtung (kein Kreis, keine Linie),
/// die Bezeichnung waagrecht dahinter (auf der dem Blick abgewandten Seite); Pick-Band über Dreieck und Text.
#[allow(clippy::too_many_arguments)]
fn view_marker(c: &Ctx, level: &DrawingLevel, p0: Vec2, p1: Vec2, sign: f64, k: f64, tag: &str, greyed: Option<bool>, obst: &mut super::stamp_place::Obstacles, out: &mut Vec<Primitive>) {
    let look = c.mv().mark_look(level);
    let ink = line_ink(c.p, level, &look);
    // [276] Die Linie selbst (Basis: keine) liegt exakt auf der Ansichtslinie.
    {
        let f = crate::plan::misc::view_line_parts((p0.x, p0.y), (p1.x, p1.y), k, &look);
        let mut i = 1;
        for _ in 0..f.first().copied().unwrap_or(0.0) as usize {
            let (a, b) = (v2(f[i + 2], f[i + 3]), v2(f[i + 4], f[i + 5]));
            let main = f[i + 1] == 0.0;
            let pieces = if main { c.cut_at_gaps(a, b) } else { vec![(a, b)] };
            for (a, b) in pieces {
                let line = ink.line(a, b, main, greyed);
                obst.add_prim(&line);
                out.push(line);
            }
            i += 6;
        }
    }
    let h = SECTION_LABEL_MM * k;
    let w = crate::text_layout::text_width_em(tag, false) * h;
    // [199] Steht der Marker auf der Bemassung (Massketten rücken bei 1:200 auf 7 mm Abstand hinaus), rückt er
    // gegen die Blickrichtung weg vom Gebäude, in 1-mm-Schritten bis 40 mm Papier, bis er frei ist.
    // [270] Ebenso weicht er den Schnittmarken und schon gesetzten Ansichtsmarken (`obst`) aus, dort auch seitlich entlang
    // seiner Linie (bis 15 mm, seitlich 1.5-fach gewichtet): Ansichtsmarke „Süd“ nicht mehr auf dem Ende von Schnitt B.
    let len = (p1.x - p0.x).hypot(p1.y - p0.y);
    let bn = if len > 1e-9 { v2(-(p1.y - p0.y) / len * sign, (p1.x - p0.x) / len * sign) } else { v2(0.0, 0.0) };
    let ul = if len > 1e-9 { v2((p1.x - p0.x) / len, (p1.y - p0.y) / len) } else { v2(0.0, 0.0) };
    let at = |(s, t): (f64, f64)| {
        let (dx, dy) = (-bn.x * s + ul.x * t, -bn.y * s + ul.y * t);
        crate::plan::misc::view_symbol(p0.x + dx, p0.y + dy, p1.x + dx, p1.y + dy, sign, k, w, look.marker, look.label)
    };
    let band = |f: &[f64]| -> Option<Vec<[f64; 2]>> {
        let mut i = 1;
        for _ in 0..f.first().copied().unwrap_or(0.0) as usize {
            match f.get(i).copied()? {
                3.0 => i += 7,
                5.0 => i += 3,
                2.0 => i += 6,
                _ => return Some((0..4).map(|j| [f[i + 1 + 2 * j], f[i + 2 + 2 * j]]).collect()),
            }
        }
        None
    };
    // Dreieck und Bezeichnung (ohne das Pick-Band dazwischen) gegen die Marken.
    let parts = |f: &[f64]| -> Vec<Vec<[f64; 2]>> {
        let mut out = Vec::new();
        let mut i = 1;
        for _ in 0..f.first().copied().unwrap_or(0.0) as usize {
            match f.get(i).copied() {
                Some(3.0) if f.len() >= i + 7 => {
                    out.push((0..3).map(|j| [f[i + 1 + 2 * j], f[i + 2 + 2 * j]]).collect());
                    i += 7;
                }
                Some(5.0) if f.len() >= i + 3 => {
                    let (x, y, pad) = (f[i + 1], f[i + 2], 0.1 * h);
                    out.push(vec![[x - pad, y - pad], [x + w + pad, y - pad], [x + w + pad, y + 0.75 * h + pad], [x - pad, y + 0.75 * h + pad]]);
                    i += 3;
                }
                Some(2.0) => i += 6,
                Some(_) => i += 9,
                None => break,
            }
        }
        out
    };
    let dims = c.dims_obstacles();
    let mut cands: Vec<(f64, f64)> = Vec::new();
    for s in 0..=40 {
        for t in -15..=15 {
            cands.push((s as f64, t as f64));
        }
    }
    cands.sort_by(|a, b| (a.0 + 1.5 * a.1.abs()).total_cmp(&(b.0 + 1.5 * b.1.abs())).then(a.1.abs().total_cmp(&b.1.abs())).then(b.1.total_cmp(&a.1)));
    let free = |f: &Vec<f64>| band(f).is_none_or(|r| !dims.hits_convex(&r)) && parts(f).iter().all(|r| !obst.hits_convex(r));
    let f = cands.iter().map(|&(s, t)| at((s * k, t * k))).find(free).unwrap_or_else(|| at((0.0, 0.0)));
    if f.is_empty() {
        return;
    }
    let mut i = 1;
    for _ in 0..f[0] as usize {
        if f[i] == 2.0 {
            let line = ink.line(v2(f[i + 2], f[i + 3]), v2(f[i + 4], f[i + 5]), false, greyed);
            obst.add_prim(&line);
            out.push(line);
            i += 6;
        } else if f[i] == 3.0 {
            let pts: Vec<Vec2> = (0..3).map(|j| v2(f[i + 1 + 2 * j], f[i + 2 + 2 * j])).collect();
            let ring: Vec<[f64; 2]> = pts.iter().map(|q| [q.x, q.y]).collect();
            obst.area(ring);
            let mut tri = pick_band(pts, None, None);
            if let Primitive::Polygon { fill, .. } = &mut tri {
                *fill = ink.color.clone().into();
            }
            out.push(tri);
            i += 7;
        } else if f[i] == 5.0 {
            let at = v2(f[i + 1], f[i + 2]);
            i += 3;
            if !(w > 0.0) {
                continue;
            }
            let pad = 0.1 * h;
            obst.area(vec![[at.x - pad, at.y - pad], [at.x + w + pad, at.y - pad], [at.x + w + pad, at.y + 0.75 * h + pad], [at.x - pad, at.y + 0.75 * h + pad]]);
            out.push(Primitive::DrawingText {
                at,
                text: tag.to_string(),
                height_m: h,
                angle: 0.0,
                color: ink.color.clone().into(),
                marks: None,
                wrap_width: None,
                doc: None,
                drawing_id: None,
                greyed,
                opacity: None,
            });
        } else {
            let pts = (0..4).map(|j| v2(f[i + 1 + 2 * j], f[i + 2 + 2 * j])).collect();
            out.push(pick_band(pts, None, Some(&level.id)));
            i += 9;
        }
    }
}

/// [296] Umriss aller Gebäuderinge, rundum um `pad` Meter erweitert; `None` ohne Gebäude.
fn house_box(rings: &[Vec<Vec2>], pad: f64) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    for q in rings.iter().flatten().filter(|q| q.x.is_finite() && q.y.is_finite()) {
        b = Some(b.map_or([q.x, q.y, q.x, q.y], |b| [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)]));
    }
    b.map(|b| [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad])
}

/// [296] Anfang und Ende eines Linienzugs auf den Kasten `bx` kürzen (nur das erste und das letzte Stück; schneidet es den Kasten
/// nicht, bleibt es unverändert).
fn clip_ends(path: &mut [(f64, f64)], bx: [f64; 4]) {
    let n = path.len();
    if n < 2 {
        return;
    }
    // Parameterbereich [t0, t1] des Stücks a→b innerhalb des Kastens (Liang-Barsky).
    let range = |a: (f64, f64), b: (f64, f64)| -> Option<(f64, f64)> {
        let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
        for (d, lo, hi, o) in [(b.0 - a.0, bx[0], bx[2], a.0), (b.1 - a.1, bx[1], bx[3], a.1)] {
            if d.abs() < 1e-12 {
                if o < lo || o > hi {
                    return None;
                }
            } else {
                let (u, v) = ((lo - o) / d, (hi - o) / d);
                t0 = t0.max(u.min(v));
                t1 = t1.min(u.max(v));
            }
        }
        (t0 < t1).then_some((t0, t1))
    };
    let at = |a: (f64, f64), b: (f64, f64), t: f64| (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
    let (a, b) = (path[0], path[1]);
    let first = range(a, b);
    let (c, d) = (path[n - 2], path[n - 1]);
    let last = range(c, d);
    if let Some((t0, _)) = first {
        path[0] = at(a, b, t0);
    }
    if let Some((_, t1)) = last {
        path[n - 1] = at(c, d, t1);
    }
}

/// Schnittführungs-Symbole aller Schnitt-/Ansichtsebenen mit Linie (`addSectionLines`).
pub fn plan_section_lines(c: &Ctx, out: &mut Vec<Primitive>) {
    if !c.derived_shown(SECTION_LINE_CATEGORY) {
        return;
    }
    // Auf freien Zeichnungsebenen (Blätter wie „Raumprogramm", Detail) gehören die Symbole nicht hin:
    // sie beziehen sich auf die Geschoss-Grundrisse.
    if c.p.drawing_levels.iter().any(|l| l.id == c.a.floor && matches!(l.kind, DrawingLevelKind::Drawing)) {
        return;
    }
    let greyed = Some(c.greyed(SECTION_LINE_CATEGORY));
    // [176] Marken und Beschriftung in fester Papiergrösse, unabhängig vom Massstab (k = Modell-Meter je Papier-mm).
    let n = if c.a.scale.is_finite() && c.a.scale > 0.0 { c.a.scale } else { 100.0 };
    let k = n / 1000.0;
    // [157] Beschriftungen zuletzt: sie weichen Masszahlen, Texten, Achsblasen, allen Linien und Marken der
    // Schnittführungen und den schon gesetzten Beschriftungen aus.
    let mut labels: Vec<(Vec2, String, Vec2, Vec2, String)> = Vec::new();
    let mut obst = super::stamp_place::Obstacles::default();
    // [270] Erst die Schnitte, dann die Ansichtsmarken: diese weichen den Schnittmarken aus (`view_marker`).
    let sections = c.p.drawing_levels.iter().filter(|l| matches!(l.kind, DrawingLevelKind::Section));
    let elevations = c.p.drawing_levels.iter().filter(|l| matches!(l.kind, DrawingLevelKind::Elevation));
    // [296] Auswahl der Marken: Einträge `91:<Ebenen-Id>` in `show` (Präsentationsblatt) beschränken die Marken auf diese Ebenen;
    // ohne solche Einträge zeigt die Klasse alle.
    let only: Vec<&str> = c.a.show.iter().filter_map(|k| k.strip_prefix("91:")).collect();
    for level in sections.chain(elevations).filter(|l| only.is_empty() || only.contains(&l.id.as_str())) {
        let Some([p0, p1]) = level.line_points else { continue };
        let tag = section_label_tag(&level.name);
        let label_w = crate::text_layout::text_width_em(&tag, false) * SECTION_LABEL_MM * k;
        let sign = level.direction_sign.unwrap_or(1.0);
        if matches!(level.kind, DrawingLevelKind::Elevation) {
            view_marker(c, level, p0, p1, sign, k, &tag, greyed, &mut obst, out);
            continue;
        }
        // [176] Geknickte Schnittlinie: Anfang, Knickpunkte, Ende.
        let mut path: Vec<(f64, f64)> = vec![(p0.x, p0.y)];
        path.extend(level.bend_points.iter().flatten().map(|q| (q.x, q.y)));
        path.push((p1.x, p1.y));
        // [296] Präsentationsblatt: Enden, die weit über das Haus hinausreichen, werden gekürzt (die Linie bleibt ganz und samt Marken
        // im Ausschnitt statt am Rand abgeschnitten).
        if !only.is_empty() {
            if let Some(bx) = house_box(c.house_rings(), SECTION_OVERSHOOT_MM * k) {
                clip_ends(&mut path, bx);
            }
        }
        let look = c.mv().mark_look(level);
        let ink = line_ink(c.p, level, &look);
        let marked = look.marked_ends();
        let f = crate::plan::misc::section_polyline_look(&path, sign, k, label_w, &look);
        if f.is_empty() {
            continue;
        }
        // Richtungen je Ende: Blickrichtung (Pfeil) und entlang der Linie nach aussen (erstes bzw. letztes Segment).
        let seg_dir = |a: (f64, f64), b: (f64, f64)| {
            let l = (b.0 - a.0).hypot(b.1 - a.1);
            if l < 1e-6 { None } else { Some(((b.0 - a.0) / l, (b.1 - a.1) / l)) }
        };
        let m = path.len();
        let first = (1..m).find_map(|i| seg_dir(path[0], path[i])).unwrap_or((1.0, 0.0));
        let last = (0..m - 1).rev().find_map(|i| seg_dir(path[i], path[m - 1])).unwrap_or((1.0, 0.0));
        let ends = [(v2(-first.0, -first.1), v2(-first.1 * sign, first.0 * sign)), (v2(last.0, last.1), v2(-last.1 * sign, last.0 * sign))];
        let mut end_no = 0;
        let n = f[0] as usize;
        let mut i = 1;
        for _ in 0..n {
            if f[i] == 2.0 {
                let main = f[i + 1] == 0.0;
                let (a, b) = (v2(f[i + 2], f[i + 3]), v2(f[i + 4], f[i + 5]));
                // [256] Die strichpunktierte Linie setzt vor Masszahlen, Texten und Höhenkoten aus (Kote „±0.00“ auf A-A,
                // Musterhaus komplex EG/DG); die kräftigen Endstücke bleiben ganz.
                let pieces = if main { c.cut_at_gaps(a, b) } else { vec![(a, b)] };
                for (a, b) in pieces {
                    let line = ink.line(a, b, main, greyed);
                    obst.add_prim(&line);
                    out.push(line);
                }
                i += 6;
            } else if f[i] == 3.0 {
                let pts: Vec<Vec2> = (0..3).map(|j| v2(f[i + 1 + 2 * j], f[i + 2 + 2 * j])).collect();
                // [270] Pfeile sind Hindernis für Ansichtsmarken und Beschriftungen.
                obst.area(pts.iter().map(|q| [q.x, q.y]).collect());
                let mut tri = pick_band(pts, None, None);
                if let Primitive::Polygon { fill, .. } = &mut tri {
                    *fill = ink.color.clone().into();
                }
                out.push(tri);
                i += 7;
            } else if f[i] == 5.0 {
                let (outward, bn) = ends[marked.get(end_no).copied().unwrap_or(1).min(1)];
                end_no += 1;
                labels.push((v2(f[i + 1], f[i + 2]), tag.clone(), bn, outward, ink.color.clone()));
                i += 3;
            } else {
                let pts = (0..4).map(|j| v2(f[i + 1 + 2 * j], f[i + 2 + 2 * j])).collect();
                out.push(pick_band(pts, None, Some(&level.id)));
                i += 9;
            }
        }
    }
    if labels.is_empty() {
        return;
    }
    obst.extend(c.drawn_obstacles());
    obst.extend(c.bubble_obstacles());
    // [157] Sohle, Böschungsoberkante und Böschungsschraffur der sichtbaren Baugruben.
    if !excavation_segments(c).is_empty() {
        let house = terrain_footprint(c.p, &c.a.floor);
        let (mut pit, mut bands) = (Vec::new(), Vec::new());
        for e in crate::excavation::excavations(c.p).into_iter().filter(|e| c.shown(&e.category_code)) {
            excavation_lines(c, e, &mut pit, &mut bands, &house);
        }
        for q in &pit {
            obst.add_prim(q);
        }
    }
    let h = SECTION_LABEL_MM * k;
    // Kandidaten (Vielfache der Schrifthöhe): vor der Spitze, weiter hinaus entlang der Linie bzw. des Pfeils.
    // [157] Nach Abstand zur Marke sortiert (die Beschriftung bleibt so nah wie möglich; vorher kamen z. B. (4, 0)
    // und (5, 0) vor (1, 3)), auch zur Gegenseite der Blickrichtung (leicht benachteiligt), bis 6 Schrifthöhen
    // hinaus für Marken hinter Massketten und Böschung.
    let mut steps: Vec<(f64, f64)> = Vec::new();
    for out_i in -1..=6 {
        for bn_i in -2..=4 {
            let (so, sb) = (out_i as f64, bn_i as f64);
            let d = so.hypot(sb);
            if d <= 6.0 && !(bn_i < 0 && out_i != 0 && d > 3.0) {
                steps.push((so, sb));
            }
        }
    }
    let cost = |&(so, sb): &(f64, f64)| so.hypot(sb) + if sb < 0.0 || so < 0.0 { 0.5 } else { 0.0 };
    steps.sort_by(|a, b| cost(a).total_cmp(&cost(b)).then(a.0.total_cmp(&b.0).reverse()).then(a.1.total_cmp(&b.1).reverse()));
    let steps = &steps;
    for (at, tag, bn, outward, ink_color) in labels {
        let w = crate::text_layout::text_width_em(&tag, false) * h;
        let rect = |a: Vec2| -> Vec<[f64; 2]> {
            let pad = 0.1 * h;
            vec![[a.x - pad, a.y - pad], [a.x + w + pad, a.y - pad], [a.x + w + pad, a.y + 0.75 * h + pad], [a.x - pad, a.y + 0.75 * h + pad]]
        };
        let cand = |(s_out, s_bn): (f64, f64)| v2(at.x + (outward.x * s_out + bn.x * s_bn) * h, at.y + (outward.y * s_out + bn.y * s_bn) * h);
        let best = steps.iter().map(|&st| cand(st)).find(|&a| !obst.hits_convex(&rect(a))).unwrap_or_else(|| {
            steps
                .iter()
                .map(|&st| cand(st))
                .map(|a| (a, obst.overlap(v2(a.x + w / 2.0, a.y + 0.375 * h), w / 2.0, 0.375 * h)))
                .fold((at, f64::INFINITY), |b, x| if x.1 < b.1 { x } else { b })
                .0
        });
        obst.area(rect(best));
        out.push(Primitive::DrawingText {
            at: best,
            text: tag,
            height_m: h,
            angle: 0.0,
            color: ink_color.into(),
            marks: None,
            wrap_width: None,
            doc: None,
            drawing_id: None,
            greyed,
            opacity: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [327] Das Suchraster liefert dasselbe wie die volle Rechnung: Strecken ausserhalb der Ringe ([`outside_bb`]) und
    /// Überlappung eines Rechtecks mit den Ringen (`convex_overlap` je Ring mit Rechteck-Vorprüfung), auf vielen
    /// zufälligen Strecken und Rechtecken um ein L-förmiges Haus mit Bogen, Hof und einem zweiten Ring.
    #[test]
    fn house_index_wie_volle_rechnung() {
        let mut house: Vec<Vec<Vec2>> = vec![
            vec![v2(0.0, 0.0), v2(10.0, 0.0), v2(10.0, 4.0), v2(5.0, 4.0), v2(5.0, 9.0), v2(0.0, 9.0)],
            (0..40).map(|i| { let t = i as f64 / 40.0 * std::f64::consts::TAU; v2(14.0 + 2.0 * t.cos(), 3.0 + 2.0 * t.sin()) }).collect(),
            vec![v2(-6.0, -3.0), v2(-2.0, -3.5), v2(-3.0, 1.0)],
        ];
        house.push(vec![v2(20.0, 20.0), v2(21.0, 20.0)]); // entarteter Ring
        let idx = HouseIndex::new(&house);
        let bb = rings_bbox(&house);
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let house_p: Vec<Vec<[f64; 2]>> = house.iter().map(|r| r.iter().map(|q| [q.x, q.y]).collect()).collect();
        let house_b: Vec<[f64; 4]> = house_p.iter().map(|r| super::super::stamp_place::ring_bbox(r)).collect();
        for k in 0..20_000 {
            let len = if k % 3 == 0 { 8.0 } else { 0.4 };
            let a = v2(-9.0 + 34.0 * rnd(), -6.0 + 30.0 * rnd());
            let b = v2(a.x + len * (rnd() - 0.5), a.y + len * (rnd() - 0.5));
            // Auch Strecken genau auf Kanten und durch Ecken.
            let (a, b) = if k % 50 == 0 { (v2(2.0, 0.0), v2(8.0, 0.0)) } else if k % 51 == 0 { (v2(10.0, -1.0), v2(10.0, 5.0)) } else { (a, b) };
            let want = outside_bb(a, b, &house, bb);
            let got = idx.outside(a, b);
            assert_eq!(want.len(), got.len(), "Strecke {a:?}–{b:?}");
            for (w, g) in want.iter().zip(&got) {
                assert!(w.0.x == g.0.x && w.0.y == g.0.y && w.1.x == g.1.x && w.1.y == g.1.y, "Strecke {a:?}–{b:?}: {w:?} / {g:?}");
            }
            let (m, u, hw, hv) = ([a.x, a.y], { let l = (b.x - a.x).hypot(b.y - a.y).max(1e-9); [(b.x - a.x) / l, (b.y - a.y) / l] }, 0.2 + rnd(), 0.1 + 0.3 * rnd());
            let rect = rot_rect(m, u, hw, hv);
            let rb = super::super::stamp_place::ring_bbox(&rect);
            let want = house_p.iter().zip(&house_b).any(|(h, hb)| hb[2] >= rb[0] && hb[0] <= rb[2] && hb[3] >= rb[1] && hb[1] <= rb[3] && super::super::stamp_place::convex_overlap(h, &rect));
            assert_eq!(want, idx.overlaps(&rect), "Rechteck {rect:?}");
        }
    }

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
            category_code: "02".into(),
            ..Default::default()
        };
        let pit = Excavation {
            id: "bg".into(),
            category_code: "02".into(),
            outline: vec![v2(20.0, 15.0), v2(30.0, 15.0), v2(30.0, 25.0), v2(20.0, 25.0)],
            bottom: 1.0,
            ..Default::default()
        };
        let cs = ContourSet {
            id: "hl".into(),
            category_code: "02".into(),
            contours: vec![Contour { z: 0.0, pts: vec![v2(-20.0, -5.0), v2(80.0, 50.0)], ..Default::default() }],
            ..Default::default()
        };
        // Reihenfolge wie im Musterhaus komplex: Höhenlinien, Baugrube, dann das daraus erzeugte Gelände.
        let p = Project { context: Some(vec![ContextObject::ContourSet(cs), ContextObject::Excavation(pit), ContextObject::TerrainMesh(t)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02", "02"], "scale": 100}"#).unwrap();
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        assert_eq!(top_context(&out, 25.0, 20.0).as_deref(), Some("bg"), "Sohle");
        // Ostseite: Gelände 3 m bei x = 30, Sohle 1 m → 2 m Böschung (45°) bis x ≈ 32.
        assert_eq!(top_context(&out, 31.0, 20.0).as_deref(), Some("bg"), "Böschung");
        assert_eq!(top_context(&out, 50.0, 5.0).as_deref(), Some("t"), "Gelände");
        assert_eq!(top_context(&out, -10.0, 0.0).as_deref(), Some("hl"), "Höhenlinien");
        assert_eq!(top_context(&out, -30.0, 0.0), None);
    }

    /// [157]/[176] Schnitt-/Ansichtsmarken in fester Papiergrösse (8 mm Schenkel in jedem Massstab), die
    /// Beschriftung steht vor der Pfeilspitze (auch bei senkrechtem Pfeil nicht auf dem Pfeil, „Nord“ oben) und
    /// zählt zum Ausmass des Plans (oben nicht abgeschnitten).
    #[test]
    fn schnittmarken_papiergroesse_beschriftung_frei() {
        let level = |name: &str, a: [f64; 2], b: [f64; 2]| -> DrawingLevel {
            serde_json::from_value(serde_json::json!({ "id": name, "name": name, "kind": if name.starts_with("Schnitt") { "section" } else { "elevation" }, "visible": true, "locked": false,
                "linePoints": [{ "x": a[0], "y": a[1] }, { "x": b[0], "y": b[1] }] })).unwrap()
        };
        // Pfeil nach unten (Ansicht Nord, oben im Plan) und nach links/rechts.
        let p = Project { drawing_levels: vec![level("Ansicht Nord", [10.0, 20.0], [0.0, 20.0]), level("Ansicht West", [-5.0, 10.0], [-5.0, 0.0]), level("Ansicht Ost", [15.0, 0.0], [15.0, 10.0]), level("Schnitt A-A", [0.0, 5.0], [60.0, 5.0])], ..Default::default() };
        let run = |scale: f64| {
            let a = super::super::domains::PlanArgs::parse(1.0, &format!(r#"{{"show": ["02", "90"], "scale": {scale}, "global": true}}"#)).unwrap();
            let mut out = Vec::new();
            plan_section_lines(&Ctx::new(&p, &a), &mut out);
            out
        };
        let marks = |out: &[Primitive]| -> Vec<(Vec2, Vec2)> { out.iter().filter_map(|q| match q { Primitive::Line { a, b, dash: None, .. } => Some((*a, *b)), _ => None }).collect() };
        let len = |m: &[(Vec2, Vec2)]| m.iter().map(|(a, b)| (b.x - a.x).hypot(b.y - a.y)).fold(0.0, f64::max);
        // [176] Auf dem Papier überall gleich gross (8 mm Schenkel): im Modell proportional zum Massstab.
        let (m50, m100, m500) = (marks(&run(50.0)), marks(&run(100.0)), marks(&run(500.0)));
        assert!((len(&m50) / len(&m100) - 0.5).abs() < 1e-9, "{} {}", len(&m50), len(&m100));
        assert!((len(&m500) / len(&m100) - 5.0).abs() < 1e-9, "{} {}", len(&m100), len(&m500));
        for scale in [100.0, 500.0] {
            let out = run(scale);
            let m = marks(&out);
            for q in &out {
                let Primitive::DrawingText { at, text, height_m, .. } = q else { continue };
                // Schriftkasten (Inter-Breite, Versalhöhe 0.75) gegen alle Markenstriche.
                let w = crate::text_layout::text_width_em(text, false) * height_m;
                let (x0, y0, x1, y1) = (at.x, at.y, at.x + w, at.y + 0.75 * height_m);
                for (a, b) in &m {
                    for k in 0..=20 {
                        let t = k as f64 / 20.0;
                        let (x, y) = (a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
                        assert!(!(x > x0 && x < x1 && y > y0 && y < y1), "1:{scale} {text} {at:?} auf Strich {a:?}–{b:?}");
                    }
                }
            }
        }
        // Ausmass des Plans umfasst die Beschriftung der Ansicht Nord (über y = 20).
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02", "90"], "scale": 100, "global": true}"#).unwrap();
        let d = super::super::domains::plan_domains(&p, &a).unwrap();
        let top = out_top(&run(100.0));
        assert!(d.bounds.is_some_and(|b| b[3] >= top - 1e-9), "{:?} < {top}", d.bounds);
    }

    /// [176] Ansichtsmarker: nur flaches gefülltes Dreieck (Basis 6 mm, Höhe 3 mm) in Blickrichtung, Bezeichnung waagrecht
    /// dahinter (gegen den Blick), kein Kreis, keine Linie; Pick-Band trägt die Ebenen-ID.
    #[test]
    fn ansichtsmarker_ist_dreieck_mit_bezeichnung() {
        let p = Project {
            drawing_levels: vec![serde_json::from_value(serde_json::json!({ "id": "n", "name": "Ansicht Süd", "kind": "elevation", "visible": true, "locked": false,
                "linePoints": [{ "x": 0.0, "y": -2.0 }, { "x": 10.0, "y": -2.0 }] })).unwrap()],
            ..Default::default()
        };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02", "90"], "scale": 100, "global": true}"#).unwrap();
        let mut out = Vec::new();
        plan_section_lines(&Ctx::new(&p, &a), &mut out);
        assert!(!out.iter().any(|q| matches!(q, Primitive::Line { .. } | Primitive::Arc { .. })), "keine Linie, kein Kreis");
        let tri = out.iter().find_map(|q| match q { Primitive::Polygon { pts, fill, .. } if fill != "none" => Some(pts.clone()), _ => None }).unwrap();
        // Blickrichtung +y (Linie von links nach rechts, Vorzeichen 1): Spitze 3 mm · 100 = 0.3 m über der Linie, Basis 0.6 m breit.
        assert!((tri[0].y - (-2.0 + 0.3)).abs() < 1e-9 && (tri[0].x - 5.0).abs() < 1e-9, "{tri:?}");
        assert!(((tri[1].x - tri[2].x).abs() - 0.6).abs() < 1e-9, "{tri:?}");
        assert!(out.iter().any(|q| matches!(q, Primitive::Polygon { section_line_id: Some(id), .. } if id == "n")));
        let t = out.iter().find_map(|q| match q { Primitive::DrawingText { at, text, height_m, .. } => Some((*at, text.clone(), *height_m)), _ => None }).unwrap();
        assert_eq!(t.1, "Süd");
        // Text hinter der Basis (unterhalb der Linie), waagrecht um die Mitte, ohne das Dreieck zu überlappen.
        let w = crate::text_layout::text_width_em("Süd", false) * t.2;
        assert!(t.0.y + 0.75 * t.2 < -2.0 && ((t.0.x + w / 2.0) - 5.0).abs() < 1e-9, "{t:?}");
    }

    /// [199] Ansichtsmarker auf einer Masskette (bei 1:200 rücken die Ketten auf 7 mm Papierabstand hinaus): er rückt
    /// gegen die Blickrichtung, bis Dreieck und Bezeichnung frei von der Bemassung sind; frei bleibt er, wo er ist.
    #[test]
    fn ansichtsmarker_weicht_der_bemassung_aus() {
        let mk = |dim_y: f64| Project {
            drawing_levels: vec![serde_json::from_value(serde_json::json!({ "id": "n", "name": "Ansicht Süd", "kind": "elevation", "visible": true, "locked": false,
                "linePoints": [{ "x": 0.0, "y": -2.0 }, { "x": 10.0, "y": -2.0 }] })).unwrap()],
            drawings2d: vec![serde_json::from_value(serde_json::json!({ "id": "m", "type": "drawing2d", "levelId": "eg", "categoryCode": "02",
                "geom": { "shape": "dimension", "pts": [{ "x": 0.0, "y": 0.0 }, { "x": 4.0, "y": 0.0 }, { "x": 10.0, "y": 0.0 }], "offset": dim_y } })).unwrap()],
            ..Default::default()
        };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["02", "90"], "scale": 200}"#).unwrap();
        let tri = |p: &Project| {
            let mut out = Vec::new();
            plan_section_lines(&Ctx::new(p, &a), &mut out);
            out.iter().find_map(|q| match q { Primitive::Polygon { pts, fill, .. } if fill != "none" => Some(pts.clone()), _ => None }).unwrap()
        };
        // Frei (Kette weit weg): Spitze 3 mm · 200 = 0.6 m über der Linie.
        assert!((tri(&mk(-8.0))[0].y - (-2.0 + 0.6)).abs() < 1e-9);
        // Masslinie bei y = -1.8 (Überstand der Hilfslinien bis -2.0): Marker und Bezeichnung rücken darunter weg.
        let p = mk(-1.8);
        let t = tri(&p);
        assert!(t[0].y <= -2.0 + 1e-9, "{t:?}");
        let c = Ctx::new(&p, &a);
        let ring: Vec<[f64; 2]> = t.iter().map(|q| [q.x, q.y]).collect();
        assert!(!c.dims_obstacles().hits_convex(&ring), "{t:?}");
    }

    /// [270] ([266] Befund 8) Ansichtsmarken weichen den Schnittmarken aus: die Ansichtslinien Süd/Nord haben ihre Mitte genau
    /// auf den Enden von Schnitt B (wie im Wettbewerbs-Durchlauf: „Süd“ auf der Marke B). Dreieck und Bezeichnung der
    /// Ansichtsmarke berühren weder Linie, Endstrich noch Pfeil des Schnitts, liegen nahe an ihrer Linie (≤ 15 mm Papier) und
    /// zeigen weiter in Blickrichtung; frei stehende Marken bleiben in der Mitte.
    #[test]
    fn ansichtsmarken_weichen_schnittmarken_aus() {
        let lv = |v: serde_json::Value| -> DrawingLevel { serde_json::from_value(v).unwrap() };
        let sec = || lv(serde_json::json!({ "id": "b", "name": "Schnitt B-B", "kind": "section", "visible": true, "locked": false,
            "linePoints": [{ "x": 6.0, "y": -3.0 }, { "x": 6.0, "y": 13.0 }], "directionSign": 1 }));
        let elev = |id: &str, name: &str, a: (f64, f64), b: (f64, f64)| lv(serde_json::json!({ "id": id, "name": name, "kind": "elevation", "visible": true,
            "locked": false, "linePoints": [{ "x": a.0, "y": a.1 }, { "x": b.0, "y": b.1 }], "directionSign": 1 }));
        let both = Project { drawing_levels: vec![elev("s", "Ansicht Süd", (0.0, -3.0), (12.0, -3.0)), sec(), elev("n", "Ansicht Nord", (12.0, 13.0), (0.0, 13.0)), elev("o", "Ansicht Ost", (15.0, -1.0), (15.0, 11.0))], ..Default::default() };
        let only_sec = Project { drawing_levels: vec![sec()], ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02", "90"], "scale": 100, "global": true}"#).unwrap();
        let run = |p: &Project| {
            let mut out = Vec::new();
            plan_section_lines(&Ctx::new(p, &a), &mut out);
            out
        };
        let tris = |out: &[Primitive]| -> Vec<Vec<[f64; 2]>> {
            out.iter().filter_map(|q| match q { Primitive::Polygon { pts, fill, .. } if fill != "none" => Some(pts.iter().map(|v| [v.x, v.y]).collect()), _ => None }).collect()
        };
        // Sichtbare Schnittmarke B: Linien und Pfeile.
        let s = run(&only_sec);
        let segs: Vec<[[f64; 2]; 2]> = s.iter().filter_map(|q| match q { Primitive::Line { a, b, .. } => Some([[a.x, a.y], [b.x, b.y]]), _ => None }).collect();
        let arrows = tris(&s);
        let out = run(&both);
        let same = |t: &Vec<[f64; 2]>| arrows.iter().any(|r| r.iter().zip(t).all(|(p, q)| (p[0] - q[0]).abs() + (p[1] - q[1]).abs() < 1e-9));
        let marks: Vec<Vec<[f64; 2]>> = tris(&out).into_iter().filter(|t| !same(t)).collect();
        assert_eq!(marks.len(), 3, "drei Ansichtsmarken: {marks:?}");
        let h = SECTION_LABEL_MM * 0.1;
        let labels: Vec<(String, Vec<[f64; 2]>)> = out
            .iter()
            .filter_map(|q| match q {
                Primitive::DrawingText { at, text, height_m, .. } if text != "B-B" => {
                    let w = crate::text_layout::text_width_em(text, false) * height_m;
                    Some((text.clone(), vec![[at.x, at.y], [at.x + w, at.y], [at.x + w, at.y + 0.75 * h], [at.x, at.y + 0.75 * h]]))
                }
                _ => None,
            })
            .collect();
        assert_eq!(labels.len(), 3, "{labels:?}");
        let hit = |ring: &[[f64; 2]]| segs.iter().any(|g| super::super::stamp_place::seg_hits_ring(g[0], g[1], ring)) || arrows.iter().any(|r| super::super::stamp_place::convex_overlap(r, ring));
        for t in &marks {
            assert!(!hit(t), "Ansichtsmarke auf der Schnittmarke: {t:?}");
        }
        for (name, r) in &labels {
            assert!(!hit(r), "Bezeichnung {name} auf der Schnittmarke: {r:?}");
        }
        // Nahe an der eigenen Linie, Spitze weiter in Blickrichtung; Ost (frei) unverschoben in der Mitte.
        let tip_of = |t: &Vec<[f64; 2]>| t[0];
        let sued = marks.iter().find(|t| (t[1][1] - t[2][1]).abs() < 1e-9 && t[0][1] > t[1][1]).expect("Süd zeigt nach Norden");
        assert!((tip_of(sued)[0] - 6.0).abs() <= 1.5 && (sued[1][1] - (-3.0)).abs() <= 1.5, "Süd nahe der Linie: {sued:?}");
        let nord = marks.iter().find(|t| (t[1][1] - t[2][1]).abs() < 1e-9 && t[0][1] < t[1][1]).expect("Nord zeigt nach Süden");
        assert!((tip_of(nord)[0] - 6.0).abs() <= 1.5 && (nord[1][1] - 13.0).abs() <= 1.5, "Nord nahe der Linie: {nord:?}");
        let ost = marks.iter().find(|t| (t[1][0] - t[2][0]).abs() < 1e-9).expect("Ost");
        assert!((ost[1][0] - 15.0).abs() < 1e-9 && ((ost[1][1] + ost[2][1]) / 2.0 - 5.0).abs() < 1e-9, "Ost bleibt in der Mitte: {ost:?}");
    }

    /// Projekt mit einem Schnitt (`kind` "section") oder einer Ansicht; `lv` ergänzt Felder der Ebene, `mv` die Modelldarstellung "m".
    fn look_project(kind: &str, lv: serde_json::Value, mv: Option<serde_json::Value>) -> Project {
        let mut lvl = serde_json::json!({ "id": "s", "name": "Schnitt A-A", "kind": kind, "visible": true, "locked": false,
            "linePoints": [{ "x": 0.0, "y": 0.0 }, { "x": 10.0, "y": 0.0 }] });
        for (k, v) in lv.as_object().unwrap() {
            lvl[k] = v.clone();
        }
        let mut p = Project { drawing_levels: vec![serde_json::from_value(lvl).unwrap()], ..Default::default() };
        if let Some(m) = mv {
            let mut o = serde_json::json!({ "id": "m", "name": "M" });
            for (k, v) in m.as_object().unwrap() {
                o[k] = v.clone();
            }
            p.model_view_options = Some(vec![serde_json::from_value(o).unwrap()]);
        }
        p
    }

    fn run_lines(p: &Project, mv: bool) -> Vec<Primitive> {
        let a = super::super::domains::PlanArgs::parse(1.0, &format!(r#"{{"show": ["02", "90"], "scale": 100, "global": true{}}}"#, if mv { r#", "modelView": "m""# } else { "" })).unwrap();
        let mut out = Vec::new();
        plan_section_lines(&Ctx::new(p, &a), &mut out);
        out
    }

    /// (dünne Linien, kräftige Linien, Dreiecke, Texte)
    fn count_parts(out: &[Primitive]) -> (usize, usize, usize, usize) {
        let thin = out.iter().filter(|q| matches!(q, Primitive::Line { dash: Some(_), .. })).count();
        let heavy = out.iter().filter(|q| matches!(q, Primitive::Line { dash: None, weight_mm, .. } if *weight_mm > 0.4)).count();
        let tri = out.iter().filter(|q| matches!(q, Primitive::Polygon { fill, .. } if fill != "none")).count();
        let txt = out.iter().filter(|q| matches!(q, Primitive::DrawingText { .. })).count();
        (thin, heavy, tri, txt)
    }

    /// [176] Schnittmarke als L: Ebenenfeld `marker`/`lineMode` bzw. Vorgabe der Modelldarstellung (`sectionMarks`); die
    /// Ebene geht vor. L mit "ends": keine dünne Linie, kein Dreieck.
    #[test]
    fn schnittmarke_als_l_nach_ebene_und_modelldarstellung() {
        let mvl = serde_json::json!({ "sectionMarks": { "lineMode": "ends", "marker": "lAngle" } });
        let base = run_lines(&look_project("section", serde_json::json!({}), Some(mvl.clone())), false);
        let (thin, heavy, tri, txt) = count_parts(&base);
        assert!(thin == 0 && tri == 2 && heavy == 4 && txt == 2, "Basis = Pfeil an kräftigen Enden ([302]): {:?}", count_parts(&base));
        let l = run_lines(&look_project("section", serde_json::json!({ "lineMode": "ends", "marker": "lAngle" }), None), false);
        assert_eq!(count_parts(&l), (0, 4, 0, 2), "je Ende zwei Schenkel");
        let via_mv = run_lines(&look_project("section", serde_json::json!({}), Some(mvl.clone())), true);
        assert_eq!(count_parts(&via_mv), (0, 4, 0, 2), "Vorgabe der Modelldarstellung");
        let ebene = run_lines(&look_project("section", serde_json::json!({ "marker": "arrow", "lineMode": "full" }), Some(mvl)), true);
        assert_eq!(count_parts(&ebene), (1, 4, 2, 2), "Ebene geht vor");
    }

    /// [296] Enden, die weit über das Haus hinausreichen, werden auf den Kasten gekürzt; Stücke ausserhalb bleiben.
    #[test]
    fn linienenden_auf_kasten_kuerzen() {
        let v = |x: f64, y: f64| Vec2 { x, y };
        let bx = house_box(&[vec![v(0.0, 0.0), v(10.0, 0.0), v(10.0, 8.0), v(0.0, 8.0)]], 2.0).unwrap();
        assert_eq!(bx, [-2.0, -2.0, 12.0, 10.0]);
        let mut p = [(-50.0, 4.0), (60.0, 4.0)];
        clip_ends(&mut p, bx);
        assert!((p[0].0 + 2.0).abs() < 1e-9 && (p[1].0 - 12.0).abs() < 1e-9 && p[0].1 == 4.0, "{p:?}");
        let mut inside = [(1.0, 1.0), (5.0, 5.0)];
        clip_ends(&mut inside, bx);
        assert_eq!(inside, [(1.0, 1.0), (5.0, 5.0)]);
        let mut away = [(100.0, 100.0), (200.0, 100.0)];
        clip_ends(&mut away, bx);
        assert_eq!(away, [(100.0, 100.0), (200.0, 100.0)]);
    }

    /// [296] Einträge `91:<Id>` in `show` beschränken die Marken auf die gewählten Schnitte/Ansichten.
    #[test]
    fn marken_nur_der_gewaehlten_ebenen() {
        let mut p = look_project("section", serde_json::json!({}), None);
        let mut b = p.drawing_levels[0].clone();
        b.id = "t".into();
        b.name = "Schnitt B-B".into();
        p.drawing_levels.push(b);
        let run = |show: &str| {
            let a = super::super::domains::PlanArgs::parse(1.0, &format!(r#"{{"show": [{show}], "scale": 100, "global": true}}"#)).unwrap();
            let mut out = Vec::new();
            plan_section_lines(&Ctx::new(&p, &a), &mut out);
            out.iter().filter(|q| matches!(q, Primitive::DrawingText { .. })).count()
        };
        assert_eq!(run(r#""02", "90""#), 4, "ohne Auswahl alle");
        assert_eq!(run(r#""02", "90", "91:t""#), 2, "nur B-B");
        assert_eq!(run(r#""02", "90", "91:s", "91:t""#), 4);
    }

    /// [276] Varianten im Grundriss: Linie keine/Enden, Dreieck, nur Anfang, ohne Beschriftung; Pick-Band bleibt immer.
    #[test]
    fn schnittlinie_varianten_im_grundriss() {
        let run = |lv: serde_json::Value| run_lines(&look_project("section", lv, None), false);
        assert_eq!(count_parts(&run(serde_json::json!({ "lineMode": "none", "marker": "triangle" }))), (0, 0, 2, 2));
        assert_eq!(count_parts(&run(serde_json::json!({ "lineMode": "none", "marker": "none", "markerLabel": false }))), (0, 0, 0, 0));
        assert_eq!(count_parts(&run(serde_json::json!({ "lineMode": "full", "markerAt": "start" }))), (1, 3, 1, 1));
        assert_eq!(count_parts(&run(serde_json::json!({ "lineMode": "full", "markerLabel": false }))), (1, 4, 2, 0));
        let leer = run(serde_json::json!({ "lineMode": "none", "marker": "none", "markerLabel": false }));
        assert!(leer.iter().any(|q| matches!(q, Primitive::Polygon { section_line_id: Some(_), .. })), "Pick-Band bleibt");
        // Nur Anfang: die Beschriftung steht am Anfang (links, x < 0), nicht am Ende.
        let start = run(serde_json::json!({ "markerAt": "start" }));
        let x = start.iter().find_map(|q| if let Primitive::DrawingText { at, .. } = q { Some(at.x) } else { None }).unwrap();
        assert!(x < 3.0, "Anfang: {x}");
        let end = run(serde_json::json!({ "markerAt": "end" }));
        let x = end.iter().find_map(|q| if let Primitive::DrawingText { at, .. } = q { Some(at.x) } else { None }).unwrap();
        assert!(x > 7.0, "Ende: {x}");
    }

    /// [276] Linientyp und Stift der Linie: Stift (Farbe, Stärke) und Linientyp (Muster) wirken auf die Hauptlinie.
    #[test]
    fn schnittlinie_linientyp_und_stift() {
        let mut p = look_project("section", serde_json::json!({ "lineStyleId": "ls", "linePenId": "pen" }), None);
        p.line_styles.push(serde_json::from_value(serde_json::json!({ "id": "ls", "name": "Punkt", "color": "#00ff00", "dash": [0.0, 1.0] })).unwrap());
        p.active_pen_set_id = Some("set".into());
        p.pen_sets = Some(vec![serde_json::from_value(serde_json::json!({ "id": "set", "name": "S", "pens": { "pen": { "color": "#ff0000", "weight": 0.35 } } })).unwrap()]);
        let out = run_lines(&p, false);
        let main = out.iter().find_map(|q| match q {
            Primitive::Line { dash: Some(d), weight_mm, color, .. } => Some((d.clone(), *weight_mm, color.clone())),
            _ => None,
        });
        let (d, w, col) = main.expect("Hauptlinie");
        assert_eq!(d, Some(vec![0.0, 1.0]));
        assert!((w - 0.35).abs() < 1e-12);
        assert_eq!(col.as_deref(), Some("#ff0000"));
        // Ohne Stift: Farbe des Linientyps.
        p.drawing_levels[0].line_pen_id = None;
        let out = run_lines(&p, false);
        assert!(out.iter().any(|q| matches!(q, Primitive::Line { color: Some(c), dash: Some(_), .. } if &**c == "#00ff00")));
    }

    /// [276] Ansicht: Basis wie bisher (nur Dreieck + Bezeichnung, keine Linie); mit Linie, Pfeil oder ohne Zeichen.
    #[test]
    fn ansichtslinie_varianten() {
        let run = |lv: serde_json::Value| run_lines(&look_project("elevation", lv, None), false);
        assert_eq!(count_parts(&run(serde_json::json!({}))), (0, 0, 1, 1));
        assert_eq!(count_parts(&run(serde_json::json!({ "lineMode": "full" }))), (1, 2, 1, 1));
        assert_eq!(count_parts(&run(serde_json::json!({ "lineMode": "ends", "marker": "none" }))), (0, 2, 0, 1));
        assert_eq!(count_parts(&run(serde_json::json!({ "marker": "arrow" }))), (0, 1, 1, 1));
        assert_eq!(count_parts(&run(serde_json::json!({ "marker": "none", "markerLabel": false }))), (0, 0, 0, 0));
        let mv = serde_json::json!({ "elevationMarks": { "lineMode": "full" } });
        assert_eq!(count_parts(&run_lines(&look_project("elevation", serde_json::json!({}), Some(mv)), true)), (1, 2, 1, 1), "Vorgabe Ansichten");
    }

    /// [176] Geknickter Schnitt: Knickpunkte aus `bendPoints` erscheinen als kräftige Stücke im Grundriss; ohne
    /// Knickpunkte (altes Format) bleibt die gerade Linie; Beschriftung nur an den zwei Enden.
    #[test]
    fn geknickter_schnitt_zeigt_knickstuecke() {
        let mk = |bend: serde_json::Value| -> Project {
            Project {
                drawing_levels: vec![serde_json::from_value(serde_json::json!({ "id": "s", "name": "Schnitt A-A", "kind": "section", "visible": true, "locked": false,
                    "linePoints": [{ "x": 0.0, "y": 0.0 }, { "x": 10.0, "y": 8.0 }], "bendPoints": bend })).unwrap()],
                ..Default::default()
            }
        };
        let run = |p: &Project| {
            let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02", "90"], "scale": 100, "global": true}"#).unwrap();
            let mut out = Vec::new();
            plan_section_lines(&Ctx::new(p, &a), &mut out);
            out
        };
        let heavy_at = |out: &[Primitive], x: f64, y: f64| out.iter().any(|q| matches!(q, Primitive::Line { a, b, dash: None, weight_mm, .. } if *weight_mm > 0.4 && ((a.x - x).hypot(a.y - y) < 1e-9 || (b.x - x).hypot(b.y - y) < 1e-9)));
        let gerade = run(&mk(serde_json::json!([])));
        assert!(!heavy_at(&gerade, 10.0, 0.0));
        let out = run(&mk(serde_json::json!([{ "x": 10.0, "y": 0.0 }])));
        assert!(heavy_at(&out, 10.0, 0.0), "kräftige Stücke am Knick");
        assert_eq!(out.iter().filter(|q| matches!(q, Primitive::DrawingText { .. })).count(), 2);
        assert_eq!(out.iter().filter(|q| matches!(q, Primitive::Polygon { section_line_id: Some(_), .. })).count(), 2, "Pick-Band je Segment");
    }

    /// [157] Beschriftung der Schnitt-/Ansichtsmarken weicht Masszahlen und Texten des Geschosses aus („B-B“ lag
    /// auf „15.39“) sowie den Marken und Beschriftungen anderer Schnittlinien (Situation 1:500: „West“/„Nord“ an
    /// der Ecke ineinander).
    #[test]
    fn schnittmarke_weicht_masszahl_und_nachbarmarke_aus() {
        let level = |name: &str, a: [f64; 2], b: [f64; 2]| -> DrawingLevel {
            serde_json::from_value(serde_json::json!({ "id": name, "name": name, "kind": if name.starts_with("Schnitt") { "section" } else { "elevation" }, "visible": true, "locked": false,
                "linePoints": [{ "x": a[0], "y": a[1] }, { "x": b[0], "y": b[1] }] })).unwrap()
        };
        let labels = |out: &[Primitive]| -> Vec<(String, Vec<[f64; 2]>)> {
            out.iter()
                .filter_map(|q| match q {
                    Primitive::DrawingText { at, text, height_m, .. } => {
                        let w = crate::text_layout::text_width_em(text, false) * height_m;
                        let h = 0.75 * height_m;
                        Some((text.clone(), vec![[at.x, at.y], [at.x + w, at.y], [at.x + w, at.y + h], [at.x, at.y + h]]))
                    }
                    _ => None,
                })
                .collect()
        };
        let run = |p: &Project, scale: f64| {
            let a = super::super::domains::PlanArgs::parse(1.0, &format!(r#"{{"floor": "eg", "show": ["02", "90", "80"], "scale": {scale}}}"#)).unwrap();
            let mut out = Vec::new();
            plan_section_lines(&Ctx::new(p, &a), &mut out);
            out
        };
        // 1) Schnitt B-B: Masszahl genau dort, wo die Beschriftung ohne Hindernis stünde.
        let mut p = Project { drawing_levels: vec![level("Schnitt B-B", [0.0, 5.0], [20.0, 5.0])], ..Default::default() };
        let free = labels(&run(&p, 100.0));
        let (_, r) = free.iter().find(|(t, _)| t == "B-B").unwrap().clone();
        let txt: Drawing2D = serde_json::from_value(serde_json::json!({ "id": "m", "type": "drawing2d", "levelId": "eg", "categoryCode": "80",
            "geom": { "shape": "text", "at": { "x": r[0][0], "y": r[0][1] }, "text": "15.39", "height": 0.25, "angle": 0 } })).unwrap();
        p.drawings2d = vec![txt];
        let mut o = super::super::stamp_place::Obstacles::default();
        o.text(v2(r[0][0], r[0][1]), "15.39", 0.25, 0.0);
        let moved = labels(&run(&p, 100.0));
        assert_eq!(moved.len(), 2);
        for (t, r2) in &moved {
            assert!(!o.hits_convex(r2), "{t} auf der Masszahl: {r2:?}");
            // Bleibt bei seiner Marke (höchstens 3 m vom freien Platz).
            let near = free.iter().filter(|(t0, _)| t0 == t).map(|(_, r0)| (r0[0][0] - r2[0][0]).hypot(r0[0][1] - r2[0][1])).fold(f64::INFINITY, f64::min);
            assert!(near < 3.0, "{t} zu weit weg: {near}");
        }
        // 2) Situation 1:500: Ansichten Nord (Pfeil nach unten) und West (Pfeil nach rechts) treffen sich an der Ecke.
        let p = Project { drawing_levels: vec![level("Ansicht Nord", [12.0, 20.0], [0.0, 20.0]), level("Ansicht West", [-0.5, 19.0], [-0.5, 0.0]), level("Ansicht Süd", [0.0, -1.0], [12.0, -1.0]), level("Ansicht Ost", [12.5, 0.0], [12.5, 19.0])], ..Default::default() };
        let out = run(&p, 500.0);
        let ls = labels(&out);
        assert_eq!(ls.len(), 4, "ein Ansichtsmarker trägt eine Bezeichnung");
        let marks: Vec<(Vec2, Vec2)> = out.iter().filter_map(|q| match q { Primitive::Line { a, b, dash: None, .. } => Some((*a, *b)), _ => None }).collect();
        for i in 0..ls.len() {
            for j in i + 1..ls.len() {
                assert!(!super::super::stamp_place::convex_overlap(&ls[i].1, &ls[j].1), "{} über {}", ls[i].0, ls[j].0);
            }
            for (a, b) in &marks {
                assert!(!super::super::stamp_place::seg_hits_ring([a.x, a.y], [b.x, b.y], &ls[i].1), "{} auf Marke {a:?}–{b:?}", ls[i].0);
            }
        }
    }

    fn out_top(out: &[Primitive]) -> f64 {
        out.iter().filter_map(|q| if let Primitive::DrawingText { at, height_m, .. } = q { Some(at.y + height_m) } else { None }).fold(f64::NEG_INFINITY, f64::max)
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
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 30.0, 0.0, 3.0, 30.0, 10.0, 3.0, 0.0, 10.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.5), ..Default::default() };
        let mut v: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let wall = |id: &str, a: [f64; 2], b: [f64; 2]| serde_json::json!({"id": id, "type": "wall", "floorId": v["drawingLevels"][0]["id"], "categoryCode": "20", "wallTypeId": v["walls"][0]["wallTypeId"], "start": {"x": a[0], "y": a[1]}, "end": {"x": b[0], "y": b[1]}, "height": 3});
        let walls = serde_json::json!([wall("a", [12.0, -2.0], [18.0, -2.0]), wall("b", [18.0, -2.0], [18.0, 12.0]), wall("c", [18.0, 12.0], [12.0, 12.0]), wall("d", [12.0, 12.0], [12.0, -2.0])]);
        v["walls"] = walls;
        v["openings"] = serde_json::json!([]);
        let mut p: Project = serde_json::from_value(v).unwrap();
        p.context = Some(vec![ContextObject::TerrainMesh(t)]);
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02"], "scale": 100}"#).unwrap();
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

    /// [256] Nachbargebäude auf einer Klasse mit Füllung (hellgrau): die Höhenlinien enden an ihnen; ohne Füllung
    /// (Umriss) laufen sie weiter.
    #[test]
    fn hoehenlinien_enden_am_gefuellten_nachbarn() {
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 30.0, 0.0, 3.0, 30.0, 10.0, 3.0, 0.0, 10.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.5), ..Default::default() };
        let (positions, indices) = crate::mesh_view::tests::cube(12.0, 18.0, -2.0, 12.0, 0.0, 6.0);
        let nb = ContextObject::ImportedMesh(ImportedMesh { id: "n".into(), category_code: "12".into(), positions, indices, ..Default::default() });
        let mut p = Project { context: Some(vec![ContextObject::TerrainMesh(t), nb]), ..Default::default() };
        p.layers = vec![LayerCategory { code: "12".into(), name: "Gebäude".into(), color: "#888888".into(), lw: 0.25, visible: true, fill: Some("#d9d9d9".into()), ..Default::default() }];
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02", "12"], "scale": 100}"#).unwrap();
        let inside = |p: &Project| {
            let mut out = Vec::new();
            plan_context(&Ctx::new(p, &a), &mut out);
            out.iter().any(|q| matches!(q, Primitive::Line { a, b, color: Some(c), .. } if c == TERRAIN_INK && (a.x - 15.0).abs() < 1e-6 && (a.y + b.y) / 2.0 > 0.0 && (a.y + b.y) / 2.0 < 10.0))
        };
        assert!(!inside(&p), "Höhenlinie im gefüllten Nachbarn");
        p.layers[0].fill = None;
        assert!(inside(&p), "ohne Füllung läuft sie durch");
    }

    /// [256] Höhenlinien setzen vor Masszahlen und Texten aus (Musterhaus komplex EG Süd: Höhenlinien durch „1.79“,
    /// „3.60“, „17.39“ und „Hebeschiebetür …“) — gleiche Regel wie die Baulinie (`cut_site_lines`).
    #[test]
    fn hoehenlinien_setzen_vor_masszahlen_aus() {
        // z = x/10 über x 0..30: senkrechte Höhenlinien je 0.5 m, eine bei x = 15.
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 30.0, 0.0, 3.0, 30.0, 10.0, 3.0, 0.0, 10.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.5), ..Default::default() };
        let mut p = Project { context: Some(vec![ContextObject::TerrainMesh(t)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["02", "80"], "scale": 100}"#).unwrap();
        let at15 = |p: &Project| {
            let mut out = Vec::new();
            plan_context(&Ctx::new(p, &a), &mut out);
            out.iter().filter_map(|q| match q { Primitive::Line { a, b, color: Some(c), .. } if c == TERRAIN_INK && (a.x - 15.0).abs() < 1e-6 && (b.x - 15.0).abs() < 1e-6 => Some((*a, *b)), _ => None }).collect::<Vec<_>>()
        };
        let span = |l: &[(Vec2, Vec2)]| l.iter().map(|(a, b)| (b.y - a.y).abs()).sum::<f64>();
        let before = at15(&p);
        assert!(span(&before) > 9.9, "{before:?}");
        // Masskette 10..20 bei y = 5: Masszahl „10.00“ mittig über x = 15.
        let dim: Drawing2D = serde_json::from_value(serde_json::json!({ "id": "m", "type": "drawing2d", "levelId": "eg", "categoryCode": "80",
            "geom": { "shape": "dimension", "pts": [{ "x": 10.0, "y": 5.0 }, { "x": 20.0, "y": 5.0 }], "offset": 0.0 } })).unwrap();
        p.drawings2d.push(dim);
        let txt = super::super::drawings::stamp_obstacle_prims(&Ctx::new(&p, &a)).into_iter().find_map(|q| match q { Primitive::DrawingText { at, text, height_m, .. } => Some((at, text, height_m)), _ => None }).expect("Masszahl");
        let w = crate::text_layout::text_width_em(&txt.1, false) * txt.2;
        let (x0, x1, y0, y1) = (txt.0.x, txt.0.x + w, txt.0.y - 0.25 * txt.2, txt.0.y + 0.95 * txt.2);
        assert!(x0 < 15.0 && x1 > 15.0, "Masszahl über x = 15: {txt:?}");
        let after = at15(&p);
        assert!(after.len() > before.len(), "Höhenlinie geteilt: {after:?}");
        for (a, b) in &after {
            let (lo, hi) = (a.y.min(b.y), a.y.max(b.y));
            assert!(hi <= y0 + 1e-9 || lo >= y1 - 1e-9, "Höhenlinie durch die Masszahl: {lo}..{hi} gegen {y0}..{y1}");
        }
        // Nur um die Masszahl (mit Rand), nicht mehr.
        assert!(span(&after) > span(&before) - (y1 - y0) - 0.2, "{after:?}");
    }

    /// [140] Steile Stellen (Stützmauer, Böschung): Höhenlinien enger als 0.6 mm auf dem Papier werden
    /// ausgedünnt (jede zweite, sonst nur Zähllinien); im flachen Teil bleiben alle.
    #[test]
    fn hoehenlinien_ausgeduennt_wo_zu_eng() {
        // x 0..10 flach (z = 0.1 x), x 10..11 steil (z 1 → 11).
        let t = TerrainMesh {
            id: "t".into(),
            category_code: "02".into(),
            positions: vec![0.0, 0.0, 0.0, 10.0, 0.0, 1.0, 10.0, 10.0, 1.0, 0.0, 10.0, 0.0, 11.0, 0.0, 11.0, 11.0, 10.0, 11.0],
            indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0, 1.0, 4.0, 5.0, 1.0, 5.0, 2.0],
            contour_interval: Some(0.1),
            ..Default::default()
        };
        let p = Project { context: Some(vec![ContextObject::TerrainMesh(t)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02"], "scale": 100}"#).unwrap();
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
            category_code: "02".into(),
            contour_interval: Some(1.0),
            ..Default::default()
        };
        let pit = Excavation {
            id: "bg".into(),
            category_code: "02".into(),
            outline: vec![v2(20.0, 15.0), v2(30.0, 15.0), v2(30.0, 25.0), v2(20.0, 25.0)],
            bottom: 1.0,
            ..Default::default()
        };
        let p = Project { context: Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02", "02"], "scale": 100}"#).unwrap();
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
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 40.0, 0.0, 0.0, 40.0, 30.0, 3.0, 0.0, 30.0, 3.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.1), ..Default::default() };
        p.context = Some(vec![ContextObject::TerrainMesh(t)]);
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02"], "floor": "eg", "scale": 100}"#).unwrap();
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

    /// [157] Die Sohle der Baugrube liegt unter dem Gebäude, wo es über die Grube reicht (Eingangs-Anbau ohne
    /// Untergeschoss): dort keine Sohlenlinie quer durch den Raum (vorher 0.25 mm durch „E.07 Eingang“);
    /// ausserhalb des Gebäudes bleibt sie.
    #[test]
    fn baugrubensohle_endet_am_gebaeude() {
        let mut p = sample_with_walls(serde_json::json!([
            ["h1", "eg", 14.0, 0.0, 26.0, 0.0], ["h2", "eg", 26.0, 0.0, 26.0, 8.0], ["h3", "eg", 26.0, 8.0, 14.0, 8.0], ["h4", "eg", 14.0, 8.0, 14.0, 0.0],
            ["a1", "eg", 18.5, 8.0, 18.5, 12.0], ["a2", "eg", 18.5, 12.0, 21.5, 12.0], ["a3", "eg", 21.5, 12.0, 21.5, 8.0]
        ]));
        // Grube mit Arbeitsraum: Nordrand bei y = 10 läuft durch den Anbau.
        let pit = Excavation { id: "bg".into(), category_code: "02".into(), outline: vec![v2(12.0, -2.0), v2(28.0, -2.0), v2(28.0, 10.0), v2(12.0, 10.0)], bottom: -3.0, ..Default::default() };
        p.context = Some(vec![ContextObject::Excavation(pit)]);
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02"], "floor": "eg", "scale": 100}"#).unwrap();
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        let sohle: Vec<(Vec2, Vec2)> = out.iter().filter_map(|q| match q { Primitive::Line { a, b, color: Some(c), weight_mm, .. } if c == EXCAVATION_INK && (*weight_mm - 0.25).abs() < 1e-9 => Some((*a, *b)), _ => None }).collect();
        let north: Vec<&(Vec2, Vec2)> = sohle.iter().filter(|(a, b)| (a.y - 10.0).abs() < 1e-9 && (b.y - 10.0).abs() < 1e-9).collect();
        assert!(north.iter().any(|(a, b)| a.x.min(b.x) < 13.0), "Sohle ausserhalb fehlt: {north:?}");
        for (a, b) in &north {
            let m = (a.x + b.x) / 2.0;
            assert!(!(m > 18.5 && m < 21.5), "Sohle im Anbau: {a:?}–{b:?}");
        }
        assert_eq!(sohle.iter().filter(|(a, b)| (a.x - 12.0).abs() < 1e-9 && (b.x - 12.0).abs() < 1e-9).count(), 1, "Westrand ganz");
    }

    /// [68] Verbau als Wandband im Grundriss (mit Schraffur der Verbauart, Pick = Baugrube) und rotes Kreuz, wo der
    /// Arbeitsraum an einer engen Nische nicht reicht.
    #[test]
    fn verbauband_und_arbeitsraum_marke() {
        let mut p = sample_with_walls(serde_json::json!([["h1", "eg", 14.0, 0.0, 26.0, 0.0]]));
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, -10.0, 0.0, 40.0, -10.0, 0.0, 40.0, 30.0, 0.0, 0.0, 30.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
        let mut pit = Excavation { id: "bg".into(), category_code: "02".into(), outline: vec![v2(12.0, -2.0), v2(28.0, -2.0), v2(28.0, 10.0), v2(12.0, 10.0)], bottom: -3.0, edge_shoring: Some(vec![true, false, false, false]), shoring_kind: Some("soldierPile".into()), ..Default::default() };
        p.context = Some(vec![ContextObject::TerrainMesh(t.clone()), ContextObject::Excavation(pit.clone())]);
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["02", "90", "80", "02"], "scale": 100}"#).unwrap();
        let c = Ctx::new(&p, &a);
        let mut ctx = Vec::new();
        plan_context(&c, &mut ctx);
        let bands: Vec<&Primitive> = ctx.iter().filter(|q| matches!(q, Primitive::Polygon { stroke, context_object_id: Some(id), .. } if stroke == EXCAVATION_INK && id == "bg")).collect();
        assert_eq!(bands.len(), 1, "ein Band für die eine verbaute Kante");
        assert!(!ctx.iter().any(|q| matches!(q, Primitive::Line { color: Some(k), .. } if k == WS_WARN_INK)), "kein Arbeitsraum, keine Marke");
        // Enge Nische mit Arbeitsraum: Marken.
        pit.outline = vec![v2(12.0, -2.0), v2(28.0, -2.0), v2(28.0, 10.0), v2(20.5, 10.0), v2(20.5, 3.0), v2(19.5, 3.0), v2(19.5, 10.0), v2(12.0, 10.0)];
        pit.edge_shoring = None;
        pit.working_space = Some(1.0);
        p.context = Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit)]);
        let c = Ctx::new(&p, &a);
        let mut ctx = Vec::new();
        plan_context(&c, &mut ctx);
        assert!(ctx.iter().any(|q| matches!(q, Primitive::Line { color: Some(k), .. } if k == WS_WARN_INK)));
    }

    /// [199] Verbauwand unter einem Anbau (Musterhaus komplex: Rühlwand der UG-Grube unter dem Eingang im EG): das Band
    /// endet am Fussabdruck des Geschosses wie Sohle und Böschung, statt über Wände, Boden und Raumstempel zu laufen.
    #[test]
    fn verbauband_endet_am_gebaeude() {
        let mut p = sample_with_walls(serde_json::json!([
            ["a1", "eg", 18.0, -4.0, 22.0, -4.0], ["a2", "eg", 22.0, -4.0, 22.0, 1.0], ["a3", "eg", 22.0, 1.0, 18.0, 1.0], ["a4", "eg", 18.0, 1.0, 18.0, -4.0]
        ]));
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, -10.0, 0.0, 40.0, -10.0, 0.0, 40.0, 30.0, 0.0, 0.0, 30.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
        let pit = Excavation { id: "bg".into(), category_code: "02".into(), outline: vec![v2(12.0, -2.0), v2(28.0, -2.0), v2(28.0, 10.0), v2(12.0, 10.0)], bottom: -3.0, edge_shoring: Some(vec![true, false, false, false]), shoring_kind: Some("soldierPile".into()), ..Default::default() };
        p.context = Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit)]);
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["02", "90", "80", "02", "20"], "scale": 100}"#).unwrap();
        let c = Ctx::new(&p, &a);
        let mut ctx = Vec::new();
        plan_context(&c, &mut ctx);
        let bands: Vec<&Vec<Vec2>> = ctx.iter().filter_map(|q| match q { Primitive::Polygon { pts, stroke, context_object_id: Some(id), fill, .. } if stroke == EXCAVATION_INK && id == "bg" && fill != "none" => Some(pts), _ => None }).collect();
        assert_eq!(bands.len(), 2, "Band links und rechts des Anbaus: {bands:?}");
        for b in &bands {
            assert!(b.iter().all(|q| q.x <= 17.9 + 1e-6 || q.x >= 22.1 - 1e-6), "Band im Anbau: {b:?}");
        }
    }

    /// [191] Baugrube mit Bogenkante (Ostkante Halbkreis nach aussen, mit Verbau): die Sohle liegt auf dem Kreis und
    /// fügt sich zu EINEM echten Bogen ([169]), der Verbau ist EIN Band über den ganzen Bogen.
    #[test]
    fn baugrube_mit_bogenkante() {
        use crate::plan::arc_fit::{fit, Seg, Shape, TOL};
        let mut p = sample_with_walls(serde_json::json!([]));
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, -20.0, 0.0, 50.0, -20.0, 0.0, 50.0, 30.0, 0.0, 0.0, 30.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
        let pit = Excavation { id: "bg".into(), category_code: "02".into(), outline: vec![v2(12.0, -2.0), v2(28.0, -2.0), v2(28.0, 10.0), v2(12.0, 10.0)], outline_bulge: Some(vec![0.0, -1.0, 0.0, 0.0]), bottom: -3.0, edge_shoring: Some(vec![false, true, false, false]), ..Default::default() };
        p.context = Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit)]);
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["02", "90", "80", "02"], "scale": 100}"#).unwrap();
        let c = Ctx::new(&p, &a);
        let mut ctx = Vec::new();
        plan_context(&c, &mut ctx);
        let sohle: Vec<Vec<crate::hatch::V2>> = ctx.iter().filter_map(|q| match q { Primitive::Line { a, b, weight_mm, color: Some(k), .. } if k == EXCAVATION_INK && *weight_mm == 0.25 => Some(vec![crate::hatch::V2 { x: a.x, y: a.y }, crate::hatch::V2 { x: b.x, y: b.y }]), _ => None }).collect();
        let on_arc = sohle.iter().filter(|r| r[0].x > 28.0 + 1e-6).count();
        assert!(on_arc >= 40, "{on_arc} Teilstücke auf dem Bogen");
        for r in sohle.iter().filter(|r| r[0].x > 28.0 + 1e-6) {
            assert!(((r[0].x - 28.0).hypot(r[0].y - 4.0) - 6.0).abs() < 1e-9);
        }
        let chains = crate::plan::scene::stitch_runs(sohle);
        assert_eq!(chains.len(), 1, "Sohle ein geschlossener Zug");
        let (pts, closed) = &chains[0];
        let mut pts = pts.clone();
        if *closed && pts.len() > 1 {
            pts.pop();
        }
        let Some(Shape::Path { segs, .. }) = fit(&pts, *closed, TOL) else { panic!("kein Pfad") };
        let arcs: Vec<f64> = segs.iter().filter_map(|s| if let Seg::Arc { r, sweep, .. } = s { Some(r * sweep.abs()) } else { None }).collect();
        assert!((arcs.iter().sum::<f64>() - 6.0 * std::f64::consts::PI).abs() < 1e-6, "{arcs:?}");
        assert!(!arcs.is_empty() && arcs.len() <= 2, "{arcs:?}");
        let bands = ctx.iter().filter(|q| matches!(q, Primitive::Polygon { stroke, context_object_id: Some(id), .. } if stroke == EXCAVATION_INK && id == "bg")).count();
        assert_eq!(bands, 1, "ein Verbauband über den Bogen");
    }

    /// [191] Sohle auf dem Gebäude-Umriss: derselbe Bogen am Gebäude und an der Baugrube, verschieden fein geteilt —
    /// keine Splitter; ein Stück ausserhalb bleibt.
    #[test]
    fn sohle_auf_gebaeudebogen_ohne_splitter() {
        let arc = |n: usize, r: f64| -> Vec<Vec2> {
            let mut v = vec![v2(0.0, -2.0), v2(4.0, -2.0)];
            v.extend((1..n).map(|k| { let t = -std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * k as f64 / n as f64; v2(4.0 + r * t.cos(), r * t.sin()) }));
            v.extend([v2(4.0, 2.0), v2(0.0, 2.0)]);
            v
        };
        let house = vec![arc(48, 2.0)];
        assert!(sole_pieces(&arc(31, 2.0), &house).is_empty(), "{:?}", sole_pieces(&arc(31, 2.0), &house));
        // Grube 1 m weiter westlich: das Stück westlich des Hauses bleibt.
        let pit = vec![v2(-1.0, -2.0), v2(4.0, -2.0), v2(4.0, 2.0), v2(-1.0, 2.0)];
        let p = sole_pieces(&pit, &house);
        assert!(p.iter().any(|(a, b)| (a.x + 1.0).abs() < 1e-9 && (b.x + 1.0).abs() < 1e-9), "{p:?}");
    }

    /// [157] Schnittmarken-Beschriftung nicht auf der Böschungsschraffur: Sohle, Böschungsoberkante und Schraffur
    /// der sichtbaren Baugrube sind Hindernisse („B-B“ lag im Musterhaus komplex in der Böschung).
    #[test]
    fn schnittmarke_nicht_auf_der_boeschung() {
        let mut p = sample_with_walls(serde_json::json!([["h1", "eg", 14.0, 0.0, 26.0, 0.0]]));
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, -10.0, 0.0, 40.0, -10.0, 0.0, 40.0, 30.0, 0.0, 0.0, 30.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
        let pit = Excavation { id: "bg".into(), category_code: "02".into(), outline: vec![v2(12.0, -2.0), v2(28.0, -2.0), v2(28.0, 10.0), v2(12.0, 10.0)], bottom: -3.0, slope: Some(45.0), ..Default::default() };
        p.context = Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit)]);
        // Schnittlinie mit den Enden in der West- und Ostböschung.
        p.drawing_levels.push(serde_json::from_value(serde_json::json!({ "id": "s", "name": "Schnitt B-B", "kind": "section", "visible": true, "locked": false,
            "linePoints": [{ "x": 10.5, "y": 4.0 }, { "x": 29.5, "y": 4.0 }] })).unwrap());
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["02", "90", "80", "02"], "scale": 100}"#).unwrap();
        let c = Ctx::new(&p, &a);
        let mut out = Vec::new();
        plan_section_lines(&c, &mut out);
        let mut ctx = Vec::new();
        plan_context(&c, &mut ctx);
        let pit_lines: Vec<(Vec2, Vec2)> = ctx.iter().filter_map(|q| match q { Primitive::Line { a, b, color: Some(k), .. } if k == EXCAVATION_INK => Some((*a, *b)), _ => None }).collect();
        assert!(!pit_lines.is_empty());
        let mut n = 0;
        for q in &out {
            let Primitive::DrawingText { at, text, height_m, .. } = q else { continue };
            if text != "B-B" {
                continue;
            }
            n += 1;
            // [157] Beschriftung bleibt nah an ihrer Marke (höchstens 6 Schrifthöhen von einem Linienende).
            let near = [v2(10.5, 4.0), v2(29.5, 4.0)].iter().map(|e| (at.x - e.x).hypot(at.y - e.y)).fold(f64::INFINITY, f64::min);
            assert!(near <= 6.0 * height_m + 1.0, "{text} {near:.2} m von der Marke");
            let w = crate::text_layout::text_width_em(text, false) * height_m;
            let flat = [at.x, at.y, at.x + w, at.y, at.x + w, at.y + 0.75 * height_m, at.x, at.y + 0.75 * height_m];
            for (a, b) in &pit_lines {
                for k in 0..=20 {
                    let f = k as f64 / 20.0;
                    assert!(!crate::plan::pick::point_in_polygon(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, &flat), "{text} auf der Böschung bei {at:?}");
                }
            }
        }
        assert_eq!(n, 2);
    }

    /// [157] Aussenbemassung und Böschung: zeigt der Grundriss die Baugrube und schneidet eine Kette der
    /// automatischen Aussenbemassung sie, rücken beim Zeichnen alle Ketten dieser Seite hinter die
    /// Böschungsoberkante (Abstände bleiben); ohne Gelände im Grundriss stehen sie wie im Modell.
    #[test]
    fn aussenbemassung_rueckt_hinter_die_boeschung() {
        let mut p = sample_with_walls(serde_json::json!([
            ["h1", "eg", 14.0, 0.0, 26.0, 0.0], ["h2", "eg", 26.0, 0.0, 26.0, 8.0], ["h3", "eg", 26.0, 8.0, 14.0, 8.0], ["h4", "eg", 14.0, 8.0, 14.0, 0.0]
        ]));
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, -10.0, 0.0, 40.0, -10.0, 0.0, 40.0, 30.0, 0.0, 0.0, 30.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
        // Sohle 2 m ausserhalb, 3 m tief, 45°: Böschungsoberkante West bei x ≈ 9.
        let pit = Excavation { id: "bg".into(), category_code: "02".into(), outline: vec![v2(12.0, -2.0), v2(28.0, -2.0), v2(28.0, 10.0), v2(12.0, 10.0)], bottom: -3.0, slope: Some(45.0), ..Default::default() };
        p.context = Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit)]);
        let dim = |id: &str, off: f64| serde_json::from_value::<Drawing2D>(serde_json::json!({"id": id, "type": "drawing2d", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "dimension", "pts": [{"x": 13.8, "y": 0}, {"x": 13.8, "y": 8}], "offset": off}})).unwrap();
        p.drawings2d = vec![dim("autodim-eg-west-openings", 1.0), dim("autodim-eg-west-total", 2.4), dim("eigene", 1.5)];
        // Masslinien (senkrecht, über die ganze Kette) je Zeichnung.
        let lines = |p: &Project| -> Vec<(String, f64)> {
            let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "scale": 100, "show": ["02", "20"]}"#).unwrap();
            let mut out = Vec::new();
            for q in super::super::drawings::stamp_obstacle_prims(&Ctx::new(p, &a)) {
                if let Primitive::Line { a, b, drawing_id: Some(id), .. } = q {
                    if (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() > 7.9 {
                        out.push((id, a.x));
                    }
                }
            }
            out
        };
        let x = |l: &[(String, f64)], id: &str| l.iter().find(|(i, _)| i == id).map(|(_, x)| *x).unwrap();
        let l = lines(&p);
        let daylight = 9.0;
        assert!(x(&l, "autodim-eg-west-openings") < daylight - 0.3, "{l:?}");
        assert!((x(&l, "autodim-eg-west-openings") - x(&l, "autodim-eg-west-total") - 1.4).abs() < 1e-9, "Abstand bleibt: {l:?}");
        assert!((x(&l, "eigene") - 12.3).abs() < 1e-9, "eigene Masse bleiben: {l:?}");
        // Ohne Gelände im Grundriss: wie im Modell.
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().show_terrain = Some(false);
        let l = lines(&p);
        assert!((x(&l, "autodim-eg-west-openings") - 12.8).abs() < 1e-9 && (x(&l, "autodim-eg-west-total") - 11.4).abs() < 1e-9, "{l:?}");
    }

    /// [157] Gelände, Höhenlinien und Baugrube erscheinen standardmässig nur im Geschoss nächst ±0.00 (und in der
    /// Situation ab 1:500), nicht im Obergeschoss; das Feld `showTerrain` der Ebene übersteuert beides.
    #[test]
    fn gelaende_nur_im_erdgeschoss() {
        let mut p = sample_with_walls(serde_json::json!([["h1", "eg", 14.0, 0.0, 26.0, 0.0]]));
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 40.0, 0.0, 0.0, 40.0, 30.0, 3.0, 0.0, 30.0, 3.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.1), ..Default::default() };
        let pit = Excavation { id: "bg".into(), category_code: "02".into(), outline: vec![v2(12.0, -2.0), v2(28.0, -2.0), v2(28.0, 10.0), v2(12.0, 10.0)], bottom: -3.0, ..Default::default() };
        let cs = ContourSet { id: "hl".into(), category_code: "02".into(), contours: vec![Contour { pts: vec![v2(0.0, 20.0), v2(40.0, 20.0)], ..Default::default() }], ..Default::default() };
        p.context = Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit), ContextObject::ContourSet(cs)]);
        let count = |p: &Project, floor: &str, scale: f64| {
            let a = super::super::domains::PlanArgs::parse(1.0, &format!(r#"{{"show": ["02"], "floor": "{floor}", "scale": {scale}}}"#)).unwrap();
            let mut out = Vec::new();
            plan_context(&Ctx::new(p, &a), &mut out);
            out.iter().filter(|q| matches!(q, Primitive::Line { color: Some(c), .. } if c == TERRAIN_INK || c == EXCAVATION_INK || c == CONTEXT_LINE_COLOR)).count()
        };
        assert!(count(&p, "eg", 100.0) > 10, "EG zeigt das Gelände");
        assert_eq!(count(&p, "og", 100.0), 0, "OG ohne Gelände");
        assert!(count(&p, "og", 500.0) > 10, "Situation 1:500 mit Gelände");
        p.drawing_levels.iter_mut().find(|l| l.id == "og").unwrap().show_terrain = Some(true);
        assert!(count(&p, "og", 100.0) > 10, "OG mit „Gelände zeigen“");
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().show_terrain = Some(false);
        assert_eq!(count(&p, "eg", 100.0), 0, "EG mit „Gelände zeigen“ aus");
    }

    /// [157] Höhenkoten nicht auf der Baugrube: die Beschriftung einer Höhenlinie liegt nicht auf Sohle,
    /// Böschungsoberkante oder Böschungsschraffur (vorher „-2.5“/„-2.2“ in der Böschung, Musterhaus komplex EG).
    #[test]
    fn hoehenkoten_nicht_auf_der_baugrube() {
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 60.0, 0.0, 6.0, 60.0, 40.0, 6.0, 0.0, 40.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.1), ..Default::default() };
        let pit = Excavation { id: "bg".into(), category_code: "02".into(), outline: vec![v2(20.0, 5.0), v2(40.0, 5.0), v2(40.0, 35.0), v2(20.0, 35.0)], bottom: 0.5, ..Default::default() };
        let p = Project { context: Some(vec![ContextObject::Excavation(pit), ContextObject::TerrainMesh(t)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"show": ["02", "02"], "scale": 100}"#).unwrap();
        let mut out = Vec::new();
        plan_context(&Ctx::new(&p, &a), &mut out);
        let pit_lines: Vec<(Vec2, Vec2)> = out.iter().filter_map(|q| match q { Primitive::Line { a, b, color: Some(c), .. } if c == EXCAVATION_INK => Some((*a, *b)), _ => None }).collect();
        let labels: Vec<(String, Vec<[f64; 2]>)> = out.iter().filter_map(label_rect).collect();
        assert!(!pit_lines.is_empty() && !labels.is_empty(), "{} {}", pit_lines.len(), labels.len());
        for (t, r) in &labels {
            let flat: Vec<f64> = r.iter().flat_map(|q| [q[0], q[1]]).collect();
            for (a, b) in &pit_lines {
                for k in 0..=20 {
                    let f = k as f64 / 20.0;
                    let (x, y) = (a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
                    assert!(!crate::plan::pick::point_in_polygon(x, y, &flat), "Kote {t} auf der Baugrube: {a:?}–{b:?}");
                }
            }
        }
    }

    /// [150] Beschriftungen der Höhenlinien überdecken sich nicht (auch wo die Zähllinien eng liegen), halten
    /// Abstand entlang der Linie und liegen nicht auf der Bemassung.
    #[test]
    fn hoehenlinien_beschriftungen_kollisionsfrei() {
        // Steil: z = 4·y über 40 × 10 m → Zähllinien (z = 0.5 k) alle 0.125 m = 1.25 mm Papier.
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 40.0, 0.0, 0.0, 40.0, 10.0, 40.0, 0.0, 10.0, 40.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.1), ..Default::default() };
        let dim: Drawing2D = serde_json::from_value(serde_json::json!({ "id": "d", "type": "drawing2d", "levelId": "eg", "categoryCode": "80", "geom": { "shape": "dimension", "pts": [{ "x": 2.0, "y": 5.0 }, { "x": 38.0, "y": 5.0 }], "offset": 0.0 } })).unwrap();
        let p = Project { context: Some(vec![ContextObject::TerrainMesh(t)]), drawings2d: vec![dim], ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["02", "80"], "scale": 100}"#).unwrap();
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

    /// [150] Hindernis (z. B. Raumstempel ausserhalb seines Raums) auf einem Teil der Linien: die Beschriftungen
    /// rücken entlang der Linie auf freie Stellen, statt zu fehlen; keine liegt auf dem Hindernis.
    #[test]
    fn hoehenlinien_beschriftung_rueckt_vom_hindernis_weg() {
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 40.0, 0.0, 0.0, 40.0, 10.0, 40.0, 0.0, 10.0, 40.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], contour_interval: Some(0.1), ..Default::default() };
        let p = Project { context: Some(vec![ContextObject::TerrainMesh(t)]), ..Default::default() };
        let a = super::super::domains::PlanArgs::parse(1.0, r#"{"floor": "eg", "show": ["02"], "scale": 100}"#).unwrap();
        let c = Ctx::new(&p, &a);
        let run = |o: &super::super::stamp_place::Obstacles| {
            let mut out = Vec::new();
            plan_context_with(&c, &mut out, o);
            out.iter().filter_map(label_rect).collect::<Vec<_>>()
        };
        let free = run(&super::super::stamp_place::Obstacles::default());
        assert!(free.len() >= 6, "{}", free.len());
        // Stempel-Rechteck mitten auf dem Gelände (4 × 8 m): keine Beschriftung darauf, aber auch nicht weniger.
        let mut o = super::super::stamp_place::Obstacles::default();
        o.area(vec![[16.0, 1.0], [24.0, 1.0], [24.0, 9.0], [16.0, 9.0]]);
        let moved = run(&o);
        for (t, r) in &moved {
            assert!(!o.hits_convex(r), "Beschriftung {t} auf dem Stempel");
        }
        assert!(moved.len() >= free.len(), "Beschriftungen fehlen: {} statt {}", moved.len(), free.len());
    }

    #[test]
    fn label_tag_wie_ts() {
        assert_eq!(section_label_tag("Schnitt A"), "A");
        assert_eq!(section_label_tag("  Ansicht   Süd "), "Süd");
        assert_eq!(section_label_tag("Längsschnitt"), "Längsschnitt");
        assert_eq!(section_label_tag("   "), "");
        assert_eq!(section_label_tag("a\u{A0}b"), "b");
    }

    /// [159] Zwischengespeicherte Höhenlinien = neu gerechnete: gleiches Ergebnis beim zweiten Aufruf (aus dem
    /// Speicher), nach einem anderen Massstab und ohne Speicher (`contour_prims`).
    #[test]
    fn hoehenlinien_aus_dem_zwischenspeicher_wie_neu() {
        let t = TerrainMesh { id: "t".into(), category_code: "02".into(), positions: vec![0.0, 0.0, 0.0, 40.0, 0.0, 2.0, 40.0, 30.0, 9.0, 0.0, 30.0, 4.0, 20.0, 15.0, 7.5], indices: vec![0.0, 1.0, 4.0, 1.0, 2.0, 4.0, 2.0, 3.0, 4.0, 3.0, 0.0, 4.0], contour_interval: Some(0.1), ..Default::default() };
        let mut p = sample_with_walls(serde_json::json!([["w1", "eg", 5, 5, 15, 5], ["w2", "eg", 15, 5, 15, 12], ["w3", "eg", 15, 12, 5, 12], ["w4", "eg", 5, 12, 5, 5]]));
        p.context = Some(vec![ContextObject::TerrainMesh(t.clone())]);
        let run = |scale: f64| {
            let a = super::super::domains::PlanArgs::parse(1.0, &format!(r#"{{"floor": "eg", "show": ["02", "80"], "scale": {scale}}}"#)).unwrap();
            let c = Ctx::new(&p, &a);
            let mut out = Vec::new();
            plan_context(&c, &mut out);
            let (house, mut fresh) = (terrain_footprint(&p, "eg"), Vec::new());
            let st = crate::excavation::site_terrain(&p, &t);
            contour_prims(&c, &st, 0.1, 5, &mut fresh, &house, &Default::default());
            (out, fresh)
        };
        let (a1, f1) = run(100.0);
        assert!(a1.iter().filter(|q| matches!(q, Primitive::DrawingText { .. })).count() >= 2 && a1.len() > 100);
        let (a2, _) = run(50.0);
        let (a3, f3) = run(100.0);
        assert_eq!(a1, a3, "aus dem Speicher wie beim ersten Mal");
        assert_ne!(a1, a2);
        assert_eq!(f1, f3);
        // Ohne Zwischenspeicher: dieselben Höhenlinien-Primitive (nach dem Rahmen und der Pick-Fläche).
        let tail: Vec<&Primitive> = a3.iter().skip(5).collect();
        assert_eq!(tail, f3.iter().collect::<Vec<_>>());
    }

    /// [159] Rechteck-Vortest in `outside_bb` = ohne: zufällige Strecken um zwei Ringe.
    #[test]
    fn ausserhalb_mit_rechteck_wie_ohne() {
        let rings = vec![vec![v2(0.0, 0.0), v2(4.0, 0.0), v2(4.0, 3.0), v2(0.0, 3.0)], vec![v2(6.0, 1.0), v2(9.0, 1.0), v2(7.5, 4.0)]];
        let old = |a: Vec2, b: Vec2| -> Vec<(Vec2, Vec2)> {
            // Fassung vor [159]: immer alle Kanten.
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let (lo_x, hi_x, lo_y, hi_y) = (a.x.min(b.x), a.x.max(b.x), a.y.min(b.y), a.y.max(b.y));
            let mut ts = vec![0.0, 1.0];
            let mut near = false;
            for r in &rings {
                for i in 0..r.len() {
                    let (p, q) = (r[i], r[(i + 1) % r.len()]);
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
                return if rings.iter().any(|r| inside(a, r)) { vec![] } else { vec![(a, b)] };
            }
            ts.sort_by(|x, y| x.total_cmp(y));
            ts.windows(2).filter(|w| w[1] - w[0] > 1e-9 && !rings.iter().any(|r| inside(at((w[0] + w[1]) / 2.0), r))).map(|w| (at(w[0]), at(w[1]))).collect()
        };
        let mut r = super::super::cache::tests::Rng(7);
        let bb = rings_bbox(&rings);
        for _ in 0..20_000 {
            let mut c = || r.next() * 16.0 - 3.0;
            let (a, b) = (v2(c(), c()), v2(c(), c()));
            assert_eq!(outside_bb(a, b, &rings, bb), old(a, b), "{a:?} {b:?}");
        }
    }

    /// [159] `Iso::bend` über den Bereich der Bogenlänge = über alle Ecken (offen und geschlossen, auch über das Ende).
    #[test]
    fn knick_ueber_bereich_wie_ueber_alle() {
        let mut r = super::super::cache::tests::Rng(3);
        for closed in [false, true] {
            let mut pts: Vec<[f64; 2]> = (0..40).map(|i| [i as f64 * 0.7 + r.next() * 0.3, (i as f64 * 0.4).sin() * 2.0 + r.next() * 0.2]).collect();
            if closed {
                pts.push(pts[0]);
            }
            let mut cum = vec![0.0];
            for w in pts.windows(2) {
                cum.push(cum[cum.len() - 1] + (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]));
            }
            let iso = Iso { level: 0.0, index: true, pts, cum, closed };
            let l = iso.len();
            let all = |s0: f64, s1: f64| {
                let (a, b) = (iso.at(s0), iso.at(s1));
                let mut d: f64 = 0.0;
                for (i, q) in iso.pts.iter().enumerate() {
                    let c = iso.cum[i];
                    let within = if iso.closed && l > 0.0 { (c - s0).rem_euclid(l) < s1 - s0 } else { c > s0 && c < s1 };
                    if within {
                        d = d.max(seg_dist(v2(q[0], q[1]), a, b));
                    }
                }
                d
            };
            for k in 0..5000 {
                let s = r.next() * l * 1.2 - 0.1 * l;
                let h = if k % 50 == 0 { l * (0.9 + r.next() * 0.2) } else { r.next() * 3.0 };
                // Auch genau auf Ecken.
                let s = if k % 7 == 0 { iso.cum[k % iso.cum.len()] + h } else { s };
                assert_eq!(iso.bend(s - h, s + h).to_bits(), all(s - h, s + h).to_bits(), "closed={closed} s={s} h={h}");
            }
        }
    }
}
