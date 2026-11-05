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

/// Kontext-Schicht (`addContextContours`). Objekte ohne Kategorie bleiben immer sichtbar.
pub fn plan_context(c: &Ctx, out: &mut Vec<Primitive>) {
    // [137] Pick-Flächen der Baugruben zuletzt (zuoberst): sie liegen im Rahmen des Geländes, das sonst
    // jeden Klick in der Grube fängt.
    let mut late: Vec<Primitive> = Vec::new();
    // [140] Höhenlinien enden an der Gebäudegrundfläche (statt quer durch die Räume zu laufen).
    let mut house_cache: Option<Vec<Vec<Vec2>>> = None;
    let mut house = || -> Vec<Vec<Vec2>> { house_cache.get_or_insert_with(|| building_rings(c.p)).clone() };
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
        // [137] Einzeln ausgeblendetes Gelände (Kategorie bleibt sichtbar).
        if matches!(obj, ContextObject::TerrainMesh(t) if t.hidden == Some(true)) {
            continue;
        }
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
                terrain_contours(c, t, out, &house());
            }
            ContextObject::Excavation(e) => excavation_lines(c, e, out, &mut late),
            ContextObject::Image(_) => {}
        }
    }
    out.append(&mut late);
}

const TERRAIN_INK: &str = "#7a5b3a";
/// [140] Kleinster Papierabstand (mm) zwischen Höhenlinien; enger werden Zwischenlinien ausgelassen.
const CONTOUR_MIN_GAP_MM: f64 = 0.6;

/// [140] Aussenringe der Gebäudegrundfläche (Wände und Körper aller Geschosse vereinigt, ohne Innenhöfe/Räume).
pub(super) fn building_rings(p: &Project) -> Vec<Vec<Vec2>> {
    crate::site_rules::building_footprint(p).into_iter().filter_map(|poly| poly.into_iter().next()).filter(|r| r.len() >= 3).collect()
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

/// [T6] Höhenlinien aus dem Gelände-Netz (samt Baugruben) in der Äquidistanz `contourInterval`; jede
/// `contourIndexEvery`-te ist Zähllinie (dicker, mit Höhenangabe, lesbar gedreht).
fn terrain_contours(c: &Ctx, t: &TerrainMesh, out: &mut Vec<Primitive>, house: &[Vec<Vec2>]) {
    let Some(iv) = t.contour_interval.filter(|v| v.is_finite() && *v > 0.0) else { return };
    let every = t.contour_index_every.filter(|v| v.is_finite() && *v >= 1.0).map_or(5, |v| v.round() as i64);
    let st = crate::excavation::site_terrain(c.p, t);
    let text_h = 0.002 * c.a.scale.max(1.0);
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
        if g > 1e-12 { iv / g * 1000.0 / c.a.scale.max(1.0) } else { f64::INFINITY }
    };
    for l in crate::terrain::isolines(tin, iv, 0.0) {
        let k = (l.level / iv).round() as i64;
        let index = k.rem_euclid(every) == 0;
        // [140] Zähllinie mittel (0.18), Höhenlinie fein (0.1): Gelände bleibt unter dem Gebäude zurück.
        let w = if index { 0.18 } else { 0.1 };
        let n = l.pts.len();
        let segs = if l.closed { n } else { n - 1 };
        let seg_len = |i: usize| (l.pts[(i + 1) % n][0] - l.pts[i][0]).hypot(l.pts[(i + 1) % n][1] - l.pts[i][1]);
        let len: f64 = (0..segs).map(seg_len).sum();
        // Beschriftung in der Mitte der Zähllinie (nur, wenn sie lang genug ist); die Linie wird dort unterbrochen.
        let text = crate::js_fmt::to_fixed(l.level, if iv.fract() == 0.0 { 0 } else { 1 });
        let half = 0.3 * text_h * text.chars().count() as f64;
        let gap = (index && len >= 12.0 * text_h).then(|| (len / 2.0 - half - 0.4 * text_h, len / 2.0 + half + 0.4 * text_h));
        let mut acc = 0.0;
        for i in 0..segs {
            let (a, b) = (l.pts[i], l.pts[(i + 1) % n]);
            let d = seg_len(i);
            // [140] Zu eng (< 0.6 mm auf dem Papier): nur jede zweite, bei < 0.3 mm nur die Zähllinien.
            if !index {
                let s = spacing_mm((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0);
                if s < CONTOUR_MIN_GAP_MM && (k.rem_euclid(2) != 0 || 2.0 * s < CONTOUR_MIN_GAP_MM) {
                    acc += d;
                    continue;
                }
            }
            // Anteile (Bruchteile 0..1) des Segments ausserhalb der Lücke.
            let mut spans = vec![(0.0, 1.0)];
            if let (Some((g0, g1)), true) = (gap, d > 0.0) {
                let (f0, f1) = (((g0 - acc) / d).clamp(0.0, 1.0), ((g1 - acc) / d).clamp(0.0, 1.0));
                spans = [(0.0, f0), (f1, 1.0)].into_iter().filter(|(x, y)| y - x > 1e-9).collect();
            }
            for (f0, f1) in spans {
                let pt = |f: f64| v2(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
                for (p0, p1) in outside(pt(f0), pt(f1), house) {
                    out.push(ink_line(p0, p1, w, TERRAIN_INK, None));
                }
            }
            acc += d;
        }
        let Some(_) = gap else { continue };
        let mut acc = 0.0;
        for i in 0..segs {
            let (a, b) = (l.pts[i], l.pts[(i + 1) % n]);
            let d = seg_len(i);
            if acc + d >= len / 2.0 && d > 0.0 {
                let f = (len / 2.0 - acc) / d;
                let mut ang = (b[1] - a[1]).atan2(b[0] - a[0]);
                if ang > std::f64::consts::FRAC_PI_2 || ang <= -std::f64::consts::FRAC_PI_2 {
                    ang += std::f64::consts::PI;
                }
                // Text mittig auf die Linie (Breite ≈ 0.6 · Höhe je Zeichen, Grundlinie ≈ −0.35 · Höhe).
                let (c, s) = (ang.cos(), ang.sin());
                let m = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
                out.push(Primitive::DrawingText {
                    at: v2(m.0 - c * half + s * 0.35 * text_h, m.1 - s * half - c * 0.35 * text_h),
                    text,
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
                break;
            }
            acc += d;
        }
    }
}

/// [68] Baugrube im Grundriss: Sohle (Böschungsfuss) und Böschungsoberkante, Böschungsschraffur.
fn excavation_lines(c: &Ctx, e: &Excavation, out: &mut Vec<Primitive>, bands: &mut Vec<Primitive>) {
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
                out.push(ink_line(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), 0.18, EXCAVATION_INK, None));
            }
        }
        if let Some(before) = crate::excavation::terrain_before(&st, &e.id) {
            for (a, b) in crate::excavation::slope_hatch(&before, spec, spacing) {
                out.push(ink_line(v2(a[0], a[1]), v2(b[0], b[1]), 0.1, EXCAVATION_INK, None));
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

    #[test]
    fn label_tag_wie_ts() {
        assert_eq!(section_label_tag("Schnitt A"), "A");
        assert_eq!(section_label_tag("  Ansicht   Süd "), "Süd");
        assert_eq!(section_label_tag("Längsschnitt"), "Längsschnitt");
        assert_eq!(section_label_tag("   "), "");
        assert_eq!(section_label_tag("a\u{A0}b"), "b");
    }
}
