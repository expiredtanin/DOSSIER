//! Explosionsaxonometrie ([65]): Geschosse im 3D senkrecht auseinandergezogen (Präsentation).
//!
//! Jedes Geschoss (nach `baseElevation` sortiert, Index ab dem tiefsten) wird um `Index × Abstand`
//! angehoben; jedes Bauteil folgt seinem Geschoss (`floorId`), Öffnungen ihrem Wirt (Wand, Dach,
//! Decke). Kontext (Gelände, Importe) und 2D-Boden-Spuren bleiben stehen. Nur das 3D-Modell, die
//! Pick-Geometrie und die Hervorhebung verschieben sich — Plan, Schnitt und Ansicht nie.

use crate::model::{DrawingLevelKind, Project};
use crate::model3d::{self, Parts, PickGeometry, RMesh, RRoofLayer, RSlab, RWall};
use std::collections::HashMap;

/// Versatz je Geschoss und Geschoss je Bauteil-id.
pub struct Explode<'a> {
    /// Geschoss-id → Versatz (m).
    by_floor: HashMap<&'a str, f64>,
    /// Bauteil-id (Wand, Decke, Dach, Treppe, Stütze, Öffnung) → Geschoss-id.
    floor_of: HashMap<&'a str, &'a str>,
}

impl<'a> Explode<'a> {
    /// `None` bei Abstand ≤ 0 oder ungültig (= aus).
    pub fn new(p: &'a Project, gap: f64) -> Option<Self> {
        if !(gap.is_finite() && gap > 0.0) {
            return None;
        }
        let mut floors: Vec<(&str, f64)> = p
            .drawing_levels
            .iter()
            .filter(|l| l.kind == DrawingLevelKind::Floor)
            .map(|l| (l.id.as_str(), l.base_elevation.filter(|z| z.is_finite()).unwrap_or(0.0)))
            .collect();
        floors.sort_by(|a, b| a.1.total_cmp(&b.1));
        let by_floor = floors.iter().enumerate().map(|(i, (id, _))| (*id, i as f64 * gap)).collect();
        let mut floor_of: HashMap<&str, &str> = HashMap::new();
        for w in &p.walls {
            floor_of.insert(&w.id, &w.floor_id);
        }
        for c in p.ceilings.as_deref().unwrap_or(&[]) {
            floor_of.insert(&c.id, &c.floor_id);
        }
        for r in p.roofs.as_deref().unwrap_or(&[]) {
            floor_of.insert(&r.id, &r.floor_id);
        }
        for s in p.stairs.as_deref().unwrap_or(&[]) {
            floor_of.insert(&s.id, &s.floor_id);
        }
        for c in p.columns.as_deref().unwrap_or(&[]) {
            floor_of.insert(&c.id, &c.floor_id);
        }
        for o in p.openings.as_deref().unwrap_or(&[]) {
            if let Some(f) = floor_of.get(o.host_wall_id.as_str()).copied() {
                floor_of.insert(&o.id, f);
            }
        }
        Some(Self { by_floor, floor_of })
    }

    /// Versatz eines Geschosses (unbekannt: 0).
    pub fn floor(&self, floor_id: &str) -> f64 {
        self.by_floor.get(floor_id).copied().unwrap_or(0.0)
    }

    /// Versatz eines Bauteils über sein Geschoss (unbekannt: 0).
    pub fn of(&self, id: &str) -> f64 {
        self.floor_of.get(id).map_or(0.0, |f| self.floor(f))
    }

    /// Gehört ein Bauteil mit Geschoss `floor_id` zur Gruppe `group` (`None` = Geschoss unbekannt)?
    fn in_group(&self, floor_id: &str, group: Option<&str>) -> bool {
        match group {
            Some(g) => floor_id == g,
            None => !self.by_floor.contains_key(floor_id),
        }
    }
}

pub fn shift_wall(w: &mut RWall, dz: f64) {
    w.base_elevation += dz;
    if let Some(tp) = w.top_plane.as_mut() {
        tp[0] += dz;
    }
    for h in w.holes.iter_mut().flatten() {
        h.z_bottom += dz;
        h.z_top += dz;
    }
}

pub fn shift_slab(s: &mut RSlab, dz: f64) {
    s.z_bottom += dz;
    s.z_top += dz;
}

/// Mesh im Modellraum (x, y, z = Höhe).
pub fn shift_mesh(m: &mut RMesh, dz: f64) {
    for c in m.positions.chunks_exact_mut(3) {
        c[2] += dz;
    }
}

fn shift_roof_layer(l: &mut RRoofLayer, dz: f64) {
    for q in &mut l.polygon {
        q[2] += dz;
    }
}

fn shifted<T>(mut v: Vec<T>, dz: f64, f: fn(&mut T, f64)) -> Vec<T> {
    if dz != 0.0 {
        for x in &mut v {
            f(x, dz);
        }
    }
    v
}

/// `model3d::parts` mit auseinandergezogenen Geschossen; `gap` ≤ 0 liefert genau `parts`.
pub fn parts(p: &Project, layered: bool, detail: f64, for_section: bool, gap: f64) -> Result<Parts, String> {
    let Some(ex) = Explode::new(p, gap) else { return model3d::parts(p, layered, detail, for_section) };
    let mut walls = model3d::emit_walls(p, layered)?;
    for w in &mut walls {
        shift_wall(w, ex.of(&w.wall_id));
    }
    // Decken und Treppen: `ceiling_id` ist die Decken- bzw. Treppen-id.
    let mut slabs = model3d::emit_slabs(p);
    slabs.extend(model3d::emit_stairs(p, for_section));
    for s in &mut slabs {
        shift_slab(s, ex.of(&s.ceiling_id));
    }
    // Mesh-Bauteile tragen keine id: je Geschoss nur dessen Stützen/Öffnungen/Treppen/Dächer emittieren.
    let mut q = p.clone();
    q.context = None;
    q.drawings2d.clear();
    let mut out = Parts {
        walls,
        slabs,
        context_meshes: model3d::emit_context_meshes(p),
        column_meshes: vec![],
        opening_meshes: vec![],
        stair_meshes: vec![],
        stair_railings: vec![],
        roof_meshes: vec![],
        roof_layers: vec![],
    };
    let mut groups: Vec<(Option<&str>, f64)> = ex.by_floor.iter().map(|(id, dz)| (Some(*id), *dz)).collect();
    groups.sort_by(|a, b| a.1.total_cmp(&b.1));
    groups.push((None, 0.0));
    for (g, dz) in groups {
        let pick = |fid: &str| ex.in_group(fid, g);
        q.columns = p.columns.as_ref().map(|v| v.iter().filter(|c| pick(&c.floor_id)).cloned().collect());
        q.stairs = p.stairs.as_ref().map(|v| v.iter().filter(|s| pick(&s.floor_id)).cloned().collect());
        q.roofs = p.roofs.as_ref().map(|v| v.iter().filter(|r| pick(&r.floor_id)).cloned().collect());
        q.openings = p.openings.as_ref().map(|v| v.iter().filter(|o| pick(ex.floor_of.get(o.id.as_str()).copied().unwrap_or(""))).cloned().collect());
        out.column_meshes.extend(shifted(model3d::emit_columns(&q), dz, shift_mesh));
        out.stair_meshes.extend(shifted(model3d::emit_stair_meshes(&q), dz, shift_mesh));
        out.stair_railings.extend(shifted(model3d::emit_stair_railings(&q), dz, shift_mesh));
        out.roof_meshes.extend(shifted(model3d::emit_roofs(&q, None)?, dz, shift_mesh));
        out.roof_layers.extend(shifted(model3d::emit_roof_cut_layers(&q)?, dz, shift_roof_layer));
        // Öffnungen brauchen alle Dächer (Dachfenster-Wirt liegt im selben Geschoss, Rest schadet nicht).
        q.roofs = p.roofs.clone();
        out.opening_meshes.extend(shifted(model3d::emit_opening_meshes(&q, detail), dz, shift_mesh));
    }
    Ok(out)
}

/// Versatz je Geschoss-id (für die TS-seitigen truck-Extrusionen, `levelId`).
pub fn floor_offsets(p: &Project, gap: f64) -> HashMap<String, f64> {
    Explode::new(p, gap).map(|ex| ex.by_floor.iter().map(|(k, v)| (k.to_string(), *v)).collect()).unwrap_or_default()
}

/// Pick-Geometrie passend zu [`parts`]; 2D-Spuren und Kontext bleiben stehen wie im Modell.
pub fn pick_geometry(p: &Project, gap: f64) -> Result<PickGeometry, String> {
    let mut g = model3d::pick_geometry(p)?;
    let Some(ex) = Explode::new(p, gap) else { return Ok(g) };
    for w in &mut g.walls {
        shift_wall(w, ex.of(&w.wall_id));
    }
    for s in &mut g.slabs {
        shift_slab(s, ex.of(&s.ceiling_id));
    }
    for o in &mut g.openings {
        o.base_elevation += ex.of(&o.opening_id);
    }
    for s in &mut g.stairs {
        let dz = ex.of(&s.stair_id);
        s.z_bottom += dz;
        s.z_top += dz;
    }
    // Dächer in Welt-Koordinaten (x, Höhe, y).
    for r in &mut g.roofs {
        let dz = ex.of(&r.roof_id);
        for v in r.tris.iter_mut().flatten() {
            v[1] += dz;
        }
    }
    Ok(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [],
            "drawingLevels": [
                {"id": "OG", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 3.0},
                {"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0.0}
            ],
            "walls": [
                {"id": "w1", "type": "wall", "floorId": "EG", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}, "wallTypeId": "", "height": 2.8},
                {"id": "w2", "type": "wall", "floorId": "OG", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}, "wallTypeId": "", "height": 2.8}
            ],
            "openings": [
                {"id": "o2", "type": "opening", "categoryCode": "21", "kind": "window", "hostWallId": "w2", "position": 2.5, "width": 1.0, "height": 1.2, "sillHeight": 0.9}
            ],
            "ceilings": [
                {"id": "c1", "type": "ceiling", "floorId": "EG", "categoryCode": "30", "wallTypeId": "", "outline": [{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 4}, {"x": 0, "y": 4}], "thickness": 0.25}
            ],
            "columns": [
                {"id": "k2", "type": "column", "floorId": "OG", "categoryCode": "25", "position": {"x": 2, "y": 2}, "profile": {"kind": "rect", "width": 0.3, "depth": 0.3}, "rotation": 0, "height": 2.5}
            ],
            "context": [
                {"type": "importedMesh", "id": "m", "name": "M", "positions": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], "indices": [0.0, 1.0, 2.0]}
            ]
        }))
        .unwrap()
    }

    fn min_z(meshes: &[RMesh]) -> f64 {
        meshes.iter().flat_map(|m| m.positions.chunks_exact(3).map(|c| c[2])).fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn abstand_null_ist_unveraendert() {
        let p = project();
        let a = serde_json::to_string(&model3d::parts(&p, true, 2.0, false).unwrap()).unwrap();
        let b = serde_json::to_string(&parts(&p, true, 2.0, false, 0.0).unwrap()).unwrap();
        assert_eq!(a, b);
        assert!(Explode::new(&p, f64::NAN).is_none());
        assert!(floor_offsets(&p, -1.0).is_empty());
    }

    #[test]
    fn geschosse_um_index_mal_abstand_versetzt() {
        let p = project();
        let base = model3d::parts(&p, true, 2.0, false).unwrap();
        let ex = parts(&p, true, 2.0, false, 3.0).unwrap();
        let wall = |parts: &Parts, id: &str| parts.walls.iter().find(|w| w.wall_id == id).unwrap().base_elevation;
        assert!((wall(&ex, "w1") - wall(&base, "w1")).abs() < 1e-9, "EG (tiefstes) bleibt");
        assert!((wall(&ex, "w2") - wall(&base, "w2") - 3.0).abs() < 1e-9, "OG um 1 × 3 m");
        let slab = |parts: &Parts| parts.slabs.iter().find(|s| s.ceiling_id == "c1").unwrap().z_bottom;
        assert!((slab(&ex) - slab(&base)).abs() < 1e-9);
        // Öffnung folgt der Wand, Stütze ihrem Geschoss.
        assert_eq!(ex.opening_meshes.len(), base.opening_meshes.len());
        assert!(!ex.opening_meshes.is_empty());
        assert!((min_z(&ex.opening_meshes) - min_z(&base.opening_meshes) - 3.0).abs() < 1e-9);
        assert_eq!(ex.column_meshes.len(), base.column_meshes.len());
        assert!((min_z(&ex.column_meshes) - min_z(&base.column_meshes) - 3.0).abs() < 1e-9);
        // Kontext bleibt stehen.
        assert_eq!(serde_json::to_string(&ex.context_meshes).unwrap(), serde_json::to_string(&base.context_meshes).unwrap());
        let off = floor_offsets(&p, 3.0);
        assert_eq!(off.get("EG"), Some(&0.0));
        assert_eq!(off.get("OG"), Some(&3.0));
    }

    #[test]
    fn pick_geometrie_folgt_dem_modell() {
        let p = project();
        let base = model3d::pick_geometry(&p).unwrap();
        let ex = pick_geometry(&p, 2.0).unwrap();
        let w2 = |g: &PickGeometry| g.walls.iter().find(|w| w.wall_id == "w2").unwrap().base_elevation;
        assert!((w2(&ex) - w2(&base) - 2.0).abs() < 1e-9);
        assert!((ex.openings[0].base_elevation - base.openings[0].base_elevation - 2.0).abs() < 1e-9);
    }

    #[test]
    fn hervorhebung_folgt_dem_modell() {
        let p = project();
        let args = |explode: f64| crate::highlight3d::Args { walls: vec!["w2".into()], explode, ..Default::default() };
        let a = crate::highlight3d::selection_highlight_lines(&p, &args(0.0)).unwrap();
        let b = crate::highlight3d::selection_highlight_lines(&p, &args(2.5)).unwrap();
        assert_eq!(a.len(), b.len());
        assert!(!a.is_empty());
        for (x, y) in a.chunks_exact(6).zip(b.chunks_exact(6)) {
            assert!((y[1] - x[1] - 2.5).abs() < 1e-5);
            assert_eq!(x[0], y[0]);
        }
    }
}
