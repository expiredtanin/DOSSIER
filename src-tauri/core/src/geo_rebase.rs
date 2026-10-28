//! Ursprungs-Verschiebung des ganzen Projekts ([K4] S2, vorher `model/geoRebase.ts`): reine,
//! verlustfreie Translation aller Modell-Koordinaten um einen festen Vektor. `geoAnchor` wandert
//! mit, damit der LV95-Bezug exakt erhalten bleibt. Nur Translation — keine Rotation (Achsen- und
//! Winkelfelder blieben sonst falsch). Richtungsvektoren (z. B. `Stair.dir`) bleiben unangetastet.

use crate::model::*;

fn shift(p: Vec2, dx: f64, dy: f64) -> Vec2 {
    Vec2 { x: p.x + dx, y: p.y + dy }
}

fn shift_all(pts: &mut [Vec2], dx: f64, dy: f64) {
    for p in pts {
        *p = shift(*p, dx, dy);
    }
}

fn shift_geom(g: &mut Drawing2DGeom, dx: f64, dy: f64) {
    use Drawing2DGeom::*;
    match g {
        Line { a, b } | Xline { a, b } | Ray { a, b } => {
            *a = shift(*a, dx, dy);
            *b = shift(*b, dx, dy);
        }
        Polyline { pts, .. } | Bezier { pts } | Spline { pts, .. } | Dimension { pts, .. } => shift_all(pts, dx, dy),
        Rect { min, max } | Image { min, max, .. } => {
            *min = shift(*min, dx, dy);
            *max = shift(*max, dx, dy);
        }
        Circle { center, .. } | Arc { center, .. } | Ellipse { center, .. } => *center = shift(*center, dx, dy),
        Kote { at, .. } | Detailref { at, .. } | Scalebar { at, .. } | Pointmarker { at } | Block { at, .. } => *at = shift(*at, dx, dy),
        Text { at, leader_target, leader_bend_points, path_pts, .. } => {
            *at = shift(*at, dx, dy);
            if let Some(t) = leader_target {
                *t = shift(*t, dx, dy);
            }
            if let Some(v) = leader_bend_points {
                shift_all(v, dx, dy);
            }
            if let Some(v) = path_pts {
                shift_all(v, dx, dy);
            }
        }
    }
}

fn shift_context(o: &mut ContextObject, dx: f64, dy: f64) {
    match o {
        ContextObject::ContourSet(s) => {
            for c in &mut s.contours {
                shift_all(&mut c.pts, dx, dy);
                if let Some(cv) = &mut c.curve {
                    cv.cx += dx;
                    cv.cy += dy;
                }
            }
        }
        ContextObject::Image(i) => {
            i.min = shift(i.min, dx, dy);
            i.max = shift(i.max, dx, dy);
        }
        ContextObject::ImportedMesh(m) => shift_positions(&mut m.positions, dx, dy),
        ContextObject::TerrainMesh(m) => shift_positions(&mut m.positions, dx, dy),
    }
}

/// Nur x/y (Grundriss) verschieben, die Höhe bleibt.
fn shift_positions(pos: &mut [f64], dx: f64, dy: f64) {
    for c in pos.chunks_exact_mut(3) {
        c[0] += dx;
        c[1] += dy;
    }
}

/// Verschiebt sämtliche Modell-Koordinaten (`translateProject`).
pub fn translate_project(p: &Project, dx: f64, dy: f64) -> Project {
    if dx == 0.0 && dy == 0.0 {
        return p.clone();
    }
    let mut out = p.clone();
    for w in &mut out.walls {
        w.start = shift(w.start, dx, dy);
        w.end = shift(w.end, dx, dy);
    }
    for c in out.ceilings.iter_mut().flatten() {
        shift_all(&mut c.outline, dx, dy);
        for h in c.openings.iter_mut().flatten() {
            shift_all(h, dx, dy);
        }
    }
    for r in out.roofs.iter_mut().flatten() {
        shift_all(&mut r.outline, dx, dy);
    }
    for s in out.stairs.iter_mut().flatten() {
        s.start = shift(s.start, dx, dy);
        s.center = s.center.map(|c| shift(c, dx, dy));
    }
    for r in out.rooms.iter_mut().flatten() {
        shift_all(&mut r.boundary, dx, dy);
        r.stamp_anchor = r.stamp_anchor.map(|a| shift(a, dx, dy));
    }
    for c in out.columns.iter_mut().flatten() {
        c.position = shift(c.position, dx, dy);
    }
    for s in out.extruded_solids.iter_mut().flatten() {
        shift_all(&mut s.points, dx, dy);
        if let Some(c) = &mut s.circle {
            c.center = shift(c.center, dx, dy);
        }
    }
    for d in &mut out.drawings2d {
        shift_geom(&mut d.geom, dx, dy);
    }
    for o in out.context.iter_mut().flatten() {
        shift_context(o, dx, dy);
    }
    for l in &mut out.drawing_levels {
        if let Some(pts) = &mut l.line_points {
            pts[0] = shift(pts[0], dx, dy);
            pts[1] = shift(pts[1], dx, dy);
        }
    }
    if let Some(a) = &mut out.geo_anchor {
        a.model = shift(a.model, dx, dy);
    }
    out
}

/// LV95-Ursprung: die reale Landeskoordinate, die auf den Modell-Nullpunkt abgebildet wird.
pub fn project_geo_origin(p: &Project) -> Option<(f64, f64)> {
    let a = p.geo_anchor.as_ref()?;
    Some((a.lv95.e - a.model.x, a.lv95.n - a.model.y))
}

/// Kopie mit Geometrie in realen Weltkoordinaten (LV95) für Modell-Exporte; ohne Bezug unverändert.
pub fn project_to_world_coords(p: &Project) -> Project {
    match project_geo_origin(p) {
        Some((e, n)) => translate_project(p, e, n),
        None => p.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verschiebt_alles_und_haelt_den_anker() {
        let mut p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        p.geo_anchor = Some(ProjectGeoAnchor { lv95: ProjectGeoAnchorLv95 { e: 2_600_000.0, n: 1_200_000.0, ..Default::default() }, model: Vec2 { x: 1.0, y: 2.0 }, ..Default::default() });
        let w = project_to_world_coords(&p);
        assert_eq!(w.walls[0].start.x, p.walls[0].start.x + 2_599_999.0);
        assert_eq!(w.walls[0].start.y, p.walls[0].start.y + 1_199_998.0);
        // Der Anker wandert mit: das verschobene Modell liegt bereits in Landeskoordinaten (Ursprung 0, 0).
        assert_eq!(project_geo_origin(&w), Some((0.0, 0.0)));
        assert_eq!(project_to_world_coords(&Project { geo_anchor: None, ..p.clone() }), Project { geo_anchor: None, ..p });
    }
}
