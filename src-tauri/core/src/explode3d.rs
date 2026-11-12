//! Explosionsaxonometrie ([65]): Geschosse im 3D senkrecht auseinandergezogen (Präsentation).
//!
//! Jedes Geschoss (nach `baseElevation` sortiert, Index ab dem tiefsten) wird um `Index × Abstand`
//! angehoben; jedes Bauteil folgt seinem Geschoss (`floorId`), Öffnungen ihrem Wirt (Wand, Dach,
//! Decke), 2D-Boden-Spuren ihrem Geschoss (`levelId`), Abzugskörper wirken am ursprünglichen Ort
//! und wandern mit dem Bauteil. Kontext (Gelände, Importe) bleibt stehen. Nur das 3D-Modell, die
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
        for t in p.trees.as_deref().unwrap_or(&[]) {
            floor_of.insert(&t.id, &t.floor_id);
        }
        // [137] Freie Körper (Pick, Hervorhebung) folgen ihrem Geschoss.
        for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
            floor_of.insert(&s.id, &s.level_id);
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
    // [216] Körper des Bandes: Modell-Koordinaten (x, y, z), z = Höhe.
    if let Some(b) = w.body.as_mut() {
        for c in b.positions.chunks_exact_mut(3) {
            c[2] += dz;
        }
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
    parts_filtered(p, layered, detail, for_section, gap, &model3d::ClassFilter::none())
}

/// Wie [`parts`], ohne die Teile ausgeblendeter Klassen ([180], `model3d::parts_filtered`).
pub fn parts_filtered(p: &Project, layered: bool, detail: f64, for_section: bool, gap: f64, filter: &model3d::ClassFilter) -> Result<Parts, String> {
    let Some(ex) = Explode::new(p, gap) else { return model3d::parts_filtered(p, layered, detail, for_section, filter) };
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
        solid_meshes: model3d::emit_solids(p),
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
        q.trees = p.trees.as_ref().map(|v| v.iter().filter(|t| pick(&t.floor_id)).cloned().collect());
        q.stairs = p.stairs.as_ref().map(|v| v.iter().filter(|s| pick(&s.floor_id)).cloned().collect());
        q.roofs = p.roofs.as_ref().map(|v| v.iter().filter(|r| pick(&r.floor_id)).cloned().collect());
        q.openings = p.openings.as_ref().map(|v| v.iter().filter(|o| filter.keep_opening(o) && pick(ex.floor_of.get(o.id.as_str()).copied().unwrap_or(""))).cloned().collect());
        // [180] Herkunft der Teile zeigt in die Listen von `q` (bzw. `p` für die Absturzsicherung).
        let kept = |pp: &Project, mut v: Vec<RMesh>| {
            v.retain(|m| filter.keep_owner(pp, m.owner));
            v
        };
        out.column_meshes.extend(shifted(kept(&q, model3d::emit_columns(&q)), dz, shift_mesh));
        out.column_meshes.extend(shifted(kept(&q, model3d::emit_trees(&q)), dz, shift_mesh));
        out.stair_meshes.extend(shifted(kept(&q, model3d::emit_stair_meshes(&q)), dz, shift_mesh));
        // Handläufe folgen der Treppe, die Absturzsicherung der Decke mit dem Loch (Geschoss `g`, [155]).
        out.stair_railings.extend(shifted(kept(&q, model3d::emit_stair_handrails(&q)), dz, shift_mesh));
        if let Some(fid) = g {
            out.stair_railings.extend(shifted(kept(p, model3d::emit_stair_guards_on(p, fid)), dz, shift_mesh));
        }
        out.roof_meshes.extend(shifted(kept(&q, model3d::emit_roofs(&q, None)?), dz, shift_mesh));
        let mut layers = model3d::emit_roof_cut_layers(&q)?;
        layers.retain(|l| filter.keep_owner(&q, l.owner));
        out.roof_layers.extend(shifted(layers, dz, shift_roof_layer));
        // Öffnungen brauchen alle Dächer (Dachfenster-Wirt liegt im selben Geschoss, Rest schadet nicht).
        q.roofs = p.roofs.clone();
        out.opening_meshes.extend(shifted(model3d::emit_opening_meshes(&q, detail), dz, shift_mesh));
    }
    filter.retain_walls(&mut out);
    out.slabs.retain(|s| !filter.hides(&s.ceiling_id));
    out.context_meshes.retain(|m| filter.keep_owner(p, m.owner));
    // [115] Freie Körper heben sich mit ihrem Geschoss.
    out.solid_meshes.retain(|m| filter.keep_owner(p, m.owner));
    for m in &mut out.solid_meshes {
        let dz = m.owner.id(p).map_or(0.0, |id| ex.of(id));
        shift_mesh(m, dz);
    }
    Ok(out)
}

/// Versatz je Geschoss-id (3D-Griffe und Arbeitsebene, `levelId`).
pub fn floor_offsets(p: &Project, gap: f64) -> HashMap<String, f64> {
    Explode::new(p, gap).map(|ex| ex.by_floor.iter().map(|(k, v)| (k.to_string(), *v)).collect()).unwrap_or_default()
}

/// Abzugskörper ([`crate::solid_specs::void_cuts`]) für die Teile aus [`parts`] mit demselben Abstand.
pub fn void_cuts(p: &Project, parts: &Parts, gap: f64) -> crate::solid_specs::VoidCuts {
    let ex = Explode::new(p, gap);
    let of = |id: &str| ex.as_ref().map_or(0.0, |e| e.of(id));
    let wall_dz = |i: usize| of(&parts.walls[i].wall_id);
    let slab_dz = |i: usize| of(&parts.slabs[i].ceiling_id);
    crate::solid_specs::void_cuts_lifted(p, &parts.walls, &parts.slabs, &wall_dz, &slab_dz)
}

/// Boden-Spuren der 2D-Zeichnungen, je Geschoss angehoben (`gap` ≤ 0: wie `drawing_line_verts`).
pub fn drawing_line_verts(p: &Project, gap: f64) -> Vec<f32> {
    model3d::drawing_line_verts_lifted(p, &floor_offsets(p, gap))
}

/// Wie [`drawing_line_verts`], ohne Zeichnungen ausgeblendeter Klassen ([180]).
pub fn drawing_line_verts_filtered(p: &Project, gap: f64, filter: &model3d::ClassFilter) -> Vec<f32> {
    model3d::drawing_line_verts_filtered(p, &floor_offsets(p, gap), filter)
}

/// Pick-Geometrie passend zu [`parts`]; Kontext bleibt stehen wie im Modell.
pub fn pick_geometry(p: &Project, gap: f64) -> Result<PickGeometry, String> {
    let mut g = model3d::pick_geometry(p)?;
    let Some(ex) = Explode::new(p, gap) else { return Ok(g) };
    let offsets = floor_offsets(p, gap);
    g.drawings = model3d::pick_drawing_segs(p, &offsets);
    g.drawing_meshes = model3d::pick_drawing_meshes(p, &offsets);
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
    // Handläufe folgen der Treppe; die Absturzsicherung steht auf dem Geschoss der Decke mit dem Loch ([155]).
    let (rails, guards) = model3d::pick_stair_railings_split(p);
    g.stair_meshes = rails;
    for m in &mut g.stair_meshes {
        let dz = ex.of(&m.stair_id);
        for v in m.tris.iter_mut().flatten() {
            v[1] += dz;
        }
    }
    for (floor, mut m) in guards {
        let dz = ex.floor(&floor);
        for v in m.tris.iter_mut().flatten() {
            v[1] += dz;
        }
        g.stair_meshes.push(m);
    }
    for c in &mut g.columns {
        let dz = ex.of(&c.column_id);
        for v in c.tris.iter_mut().flatten() {
            v[1] += dz;
        }
    }
    for t in &mut g.trees {
        let dz = ex.of(&t.tree_id);
        for v in t.tris.iter_mut().flatten() {
            v[1] += dz;
        }
    }
    for o in &mut g.opening_meshes {
        let dz = ex.of(&o.opening_id);
        for v in o.tris.iter_mut().flatten() {
            v[1] += dz;
        }
    }
    for s in &mut g.solids {
        let dz = ex.of(&s.solid_id);
        for v in s.tris.iter_mut().flatten() {
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
            ],
            "drawings2d": [
                {"id": "d2", "type": "drawing2d", "levelId": "OG", "categoryCode": "", "geom": {"shape": "line", "a": {"x": 0, "y": 1}, "b": {"x": 4, "y": 1}}}
            ],
            "extrudedSolids": [
                {"id": "v1", "type": "extrudedSolid", "levelId": "EG", "operation": "subtract", "points": [{"x": 1, "y": -1}, {"x": 2, "y": -1}, {"x": 2, "y": 1}, {"x": 1, "y": 1}], "height": 10.0}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn abzugskoerper_wandern_mit_dem_geschoss() {
        let p = project();
        let parts = parts(&p, true, 2.0, false, 3.0).unwrap();
        let cuts = void_cuts(&p, &parts, 3.0);
        // Körper (EG, 0–10 m) trifft beide Wände; die OG-Wand liegt 3 m höher, ihr Körper ebenso.
        let z0 = |i: usize| -> f64 {
            let (_, spec) = cuts.walls.iter().find(|(j, _)| *j == i).expect("Wand getroffen");
            spec["b"]["z0"].as_f64().unwrap()
        };
        let idx = |id: &str| parts.walls.iter().position(|w| w.wall_id == id).unwrap();
        assert!((z0(idx("w1")) - 0.0).abs() < 1e-9);
        assert!((z0(idx("w2")) - 3.0).abs() < 1e-9);
        let base = model3d::parts(&p, true, 2.0, false).unwrap();
        let plain = crate::solid_specs::void_cuts(&p, &base.walls, &base.slabs);
        assert_eq!(plain.walls.len(), cuts.walls.len());
        assert_eq!(serde_json::to_string(&void_cuts(&p, &base, 0.0)).unwrap(), serde_json::to_string(&plain).unwrap());
    }

    #[test]
    fn boden_spuren_folgen_dem_geschoss() {
        let p = project();
        let a = drawing_line_verts(&p, 0.0);
        let b = drawing_line_verts(&p, 2.0);
        assert_eq!(a, model3d::drawing_line_verts(&p));
        assert_eq!(a.len(), b.len());
        assert!(!a.is_empty());
        // Welt (x, Höhe, y): Höhe = Index 1.
        for (x, y) in a.chunks_exact(6).zip(b.chunks_exact(6)) {
            assert!((y[1] - x[1] - 2.0).abs() < 1e-5);
        }
        let pa = model3d::pick_geometry(&p).unwrap();
        let pb = pick_geometry(&p, 2.0).unwrap();
        assert!((pb.drawings[0].base_elevation - pa.drawings[0].base_elevation - 2.0).abs() < 1e-9);
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

    /// [155] Die Absturzsicherung steht auf der Decke mit dem Loch (Geschoss darüber), nicht beim Geschoss der Treppe.
    #[test]
    fn absturzsicherung_folgt_dem_geschoss_der_decke() {
        let mut p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        let hole = vec![crate::model::Vec2 { x: 3.2, y: 1.6 }, crate::model::Vec2 { x: 4.2, y: 1.6 }, crate::model::Vec2 { x: 4.2, y: 3.6 }, crate::model::Vec2 { x: 3.2, y: 3.6 }];
        p.ceilings.as_mut().unwrap()[0].openings = Some(vec![hole]);
        let gap = 3.0;
        let og_dz = floor_offsets(&p, gap)["og"];
        assert!(og_dz > 0.0);
        let guard = model3d::stair_guard_meshes(&p);
        assert_eq!(guard.len(), 1);
        let base_z = guard[0].1.positions.chunks(3).map(|q| q[2]).fold(f64::INFINITY, f64::min);
        // 3D-Körper: ein Mesh beginnt genau auf dem Boden des OG plus dessen Versatz.
        let ex = parts(&p, true, 2.0, false, gap).unwrap();
        let base = model3d::parts(&p, true, 2.0, false).unwrap();
        assert_eq!(ex.stair_railings.len(), base.stair_railings.len());
        let mins: Vec<f64> = ex.stair_railings.iter().map(|m| m.positions.chunks_exact(3).map(|c| c[2]).fold(f64::INFINITY, f64::min)).collect();
        assert!(mins.iter().any(|z| (z - (base_z + og_dz)).abs() < 1e-6), "{mins:?} {base_z}");
        assert!(!mins.iter().any(|z| (z - base_z).abs() < 1e-6), "Sicherung nicht am Geschoss der Treppe: {mins:?}");
        // Pick: höchster Punkt (Welt-y) der Treppen-Geländer liegt über dem Versatz des OG.
        let top = |g: &PickGeometry| g.stair_meshes.iter().flat_map(|m| m.tris.iter().flatten()).map(|v| v[1]).fold(f64::NEG_INFINITY, f64::max);
        let (pa, pb) = (model3d::pick_geometry(&p).unwrap(), pick_geometry(&p, gap).unwrap());
        assert!(top(&pb) > top(&pa) + og_dz - 0.2, "{} {}", top(&pb), top(&pa));
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
