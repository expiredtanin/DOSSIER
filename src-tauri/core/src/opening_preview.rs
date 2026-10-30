//! Vorschau-Projekt einer Öffnung für den Fenster-/Tür-Dialog ([105]/[106]): die Wirtswand (gleicher
//! Wandtyp, gerade, Achse entlang x) mit NUR dieser Öffnung in der Mitte, ein Geschoss mit Schnitthöhe
//! durch die Öffnung, ein Schnitt quer durch die Öffnungsmitte und eine Ansicht von aussen. Die TS-Seite
//! rechnet daraus Grundriss, Schnitt und Ansicht wie für jedes Projekt (`src/plan/openingPreview.ts`).

use crate::model::*;

/// Rand links/rechts neben der Öffnung (Meter).
const MARGIN: f64 = 0.7;

pub const FLOOR_ID: &str = "preview-floor";
pub const SECTION_ID: &str = "preview-section";
pub const ELEVATION_ID: &str = "preview-elevation";

/// `None`: Öffnung oder Wirtswand fehlt.
pub fn opening_preview(p: &Project, opening_id: &str) -> Option<Project> {
    let o = p.openings.as_deref()?.iter().find(|o| o.id == opening_id)?;
    let host = p.walls.iter().find(|w| w.id == o.host_wall_id)?;
    let floor = p.drawing_levels.iter().find(|l| l.id == host.floor_id);
    let width = if o.width.is_finite() && o.width > 0.05 { o.width } else { 1.0 };
    let len = width + 2.0 * MARGIN;
    let total = p.wall_thickness(host, 0.2);

    let mut lvl = floor.cloned().unwrap_or_default();
    lvl.id = FLOOR_ID.into();
    lvl.name = "EG".into();
    lvl.kind = DrawingLevelKind::Floor;
    lvl.visible = true;
    lvl.base_elevation = Some(0.0);
    lvl.layout_id = None;
    // Schnitthöhe durch die Öffnung (Fenster mit hoher Brüstung erscheinen sonst nur in Aufsicht).
    let sill = if o.kind == ElementKind::Window { o.sill_height.max(0.0) } else { 0.0 };
    lvl.cut_height = Some(sill + o.height.max(0.1).min(3.0) / 2.0);

    let mut wall = host.clone();
    wall.id = "preview-wall".into();
    wall.floor_id = FLOOR_ID.into();
    wall.start = Vec2 { x: 0.0, y: 0.0 };
    wall.end = Vec2 { x: len, y: 0.0 };

    let mut op = o.clone();
    op.host_wall_id = wall.id.clone();
    op.position = MARGIN;
    op.width = width;

    let mid = MARGIN + width / 2.0;
    let reach = total.max(0.2) + 0.6;
    let mut section = DrawingLevel { id: SECTION_ID.into(), name: "Schnitt".into(), kind: DrawingLevelKind::Section, visible: true, ..Default::default() };
    section.line_points = Some([Vec2 { x: mid, y: -reach }, Vec2 { x: mid, y: reach }]);
    section.direction_sign = Some(1.0);
    section.level_marks = Some(false);
    let mut elevation = DrawingLevel { id: ELEVATION_ID.into(), name: "Ansicht".into(), kind: DrawingLevelKind::Elevation, visible: true, ..Default::default() };
    // Aussenfläche liegt rechts der Achse (−y): Ansicht von dort.
    elevation.line_points = Some([Vec2 { x: 0.0, y: -reach }, Vec2 { x: len, y: -reach }]);
    elevation.direction_sign = Some(1.0);
    elevation.level_marks = Some(false);

    Some(Project {
        format_version: p.format_version,
        id: "opening-preview".into(),
        name: "Vorschau".into(),
        line_styles: p.line_styles.clone(),
        text_styles: p.text_styles.clone(),
        hatches: p.hatches.clone(),
        components: p.components.clone(),
        wall_types: p.wall_types.iter().filter(|t| t.id == host.wall_type_id).cloned().collect(),
        door_types: p.door_types.clone(),
        window_types: p.window_types.clone(),
        pens: p.pens.clone(),
        pen_sets: p.pen_sets.clone(),
        active_pen_set_id: p.active_pen_set_id.clone(),
        layers: p.layers.clone(),
        drawing_levels: vec![lvl, section, elevation],
        walls: vec![wall],
        openings: Some(vec![op]),
        scale_line_weights: p.scale_line_weights,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vorschau_hat_wand_oeffnung_schnitt_und_ansicht() {
        let mut p = Project::default();
        p.drawing_levels.push(DrawingLevel { id: "eg".into(), kind: DrawingLevelKind::Floor, ..Default::default() });
        p.walls.push(Wall { id: "w".into(), floor_id: "eg".into(), start: Vec2 { x: 3.0, y: 4.0 }, end: Vec2 { x: 3.0, y: 12.0 }, ..Default::default() });
        p.openings = Some(vec![Opening { id: "o".into(), host_wall_id: "w".into(), kind: ElementKind::Window, position: 5.0, width: 1.2, height: 1.4, sill_height: 0.9, ..Default::default() }]);
        let q = opening_preview(&p, "o").unwrap();
        assert_eq!(q.walls.len(), 1);
        assert!((q.walls[0].end.x - 2.6).abs() < 1e-12);
        let o = &q.openings.as_ref().unwrap()[0];
        assert_eq!((o.position, o.width), (MARGIN, 1.2));
        assert_eq!(q.drawing_levels.len(), 3);
        assert!((q.drawing_levels[0].cut_height.unwrap() - 1.6).abs() < 1e-12);
        assert!(opening_preview(&p, "fehlt").is_none());
    }
}
