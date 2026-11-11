//! [115] Freie Körper (`extrudedSolids`) im 3D: das Netz aus dem Kern (`solid_mesh::body_mesh_3d`, dieselbe
//! B-Rep-Beschreibung wie Grundriss, Schnitt, Ansicht und STEP), Farbe und Textur aus dem Bauteil
//! (`componentId`), sonst das Körper-Orange. Abzugskörper sind kein Material (sie wirken über
//! `solid_specs::void_cuts` auf Wände und Decken). Ersetzt die früheren asynchronen truck-Netze der TS-Seite.

use super::*;

/// Körper ohne Bauteil: warmes Orange (hebt sie von Wand/Decke/Kontext ab, wie bisher im 3D).
pub const SOLID_RGB: Rgb = [0.85, 0.55, 0.25];
/// Knickwinkel (Grad) der glatten Schattierung: Facetten gekrümmter Flächen glatt, echte Kanten scharf.
const SOLID_CREASE_DEG: f64 = 30.0;

/// Die freien Körper als Netze (Modell-Meter, z = Höhe), Herkunft `Owner::Solid(Index)`.
pub fn emit_solids(p: &Project) -> Vec<RMesh> {
    let maps = material_color_maps(p, None);
    let mut out = Vec::new();
    for (i, s) in p.extruded_solids.as_deref().unwrap_or(&[]).iter().enumerate() {
        if s.operation.as_deref() == Some("subtract") || !(s.height > 0.0) {
            continue;
        }
        let Some(m) = crate::solid_mesh::body_mesh_3d(p, s) else { continue };
        let Some(m) = m.as_ref() else { continue };
        let comp = s.component_id.as_deref().filter(|c| !c.is_empty());
        let color = comp.and_then(|c| p.component(c)).map_or(SOLID_RGB, |c| hex_to_rgb(&c.color, SOLID_RGB));
        let material_index = comp.and_then(|c| material_layer(p, &maps, c));
        out.push(RMesh {
            positions: m.positions.clone(),
            indices: m.indices.clone(),
            kind: "extrusion",
            color,
            vertex_colors: None,
            material_index,
            crease_angle: Some(SOLID_CREASE_DEG),
            owner: Owner::Solid(i),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Zwei Geschosse, ein Zylinder-Körper (OG, Klasse 40, Bauteil „holz"), ein Quader (EG, ohne Bauteil), ein
    /// Abzugskörper und eine Wand, die er trifft.
    fn project(hidden: &[&str]) -> Project {
        let layers: Vec<serde_json::Value> = ["20", "40", "41"].iter().map(|c| serde_json::json!({"code": c, "name": c, "color": "#000000", "visible": !hidden.contains(c)})).collect();
        let sq = |x: f64, y: f64, s: f64| serde_json::json!([{"x": x, "y": y}, {"x": x + s, "y": y}, {"x": x + s, "y": y + s}, {"x": x, "y": y + s}]);
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "wallTypes": [], "layers": layers, "openings": [],
            "components": [{"id": "holz", "name": "Holz", "color": "#336699", "hatchId": "", "joinPriority": 5}],
            "drawingLevels": [
                {"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0.0},
                {"id": "OG", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 3.0}],
            "walls": [{"id": "w1", "type": "wall", "floorId": "EG", "categoryCode": "20", "start": {"x": 0, "y": 10}, "end": {"x": 6, "y": 10}, "wallTypeId": "", "height": 2.8}],
            "extrudedSolids": [
                {"id": "zyl", "type": "extrudedSolid", "levelId": "OG", "categoryCode": "40", "componentId": "holz", "points": [], "circle": {"center": {"x": 2, "y": 2}, "r": 0.5}, "height": 1.0},
                {"id": "box", "type": "extrudedSolid", "levelId": "EG", "categoryCode": "41", "points": sq(5.0, 0.0, 1.0), "height": 2.0},
                {"id": "loch", "type": "extrudedSolid", "levelId": "EG", "categoryCode": "41", "points": sq(2.0, 9.5, 1.0), "height": 2.0, "baseOffset": 0.5, "operation": "subtract"}]
        }))
        .unwrap()
    }

    fn solid_ids(p: &Project, parts: &Parts) -> Vec<String> {
        parts.solid_meshes.iter().filter_map(|m| m.owner.id(p).map(String::from)).collect()
    }

    /// [115] Freie Körper reisen als Kern-Netz in den 3D-Teilen: Herkunft, Farbe aus dem Bauteil, glatt
    /// schattiert, feine Facetten (Fugen unter dem Kantenwinkel), ohne Abzugskörper.
    #[test]
    fn parts_enthalten_freie_koerper_als_netz() {
        let p = project(&[]);
        let parts = parts(&p, true, 2.0, false).unwrap();
        assert_eq!(solid_ids(&p, &parts), ["zyl", "box"]);
        let zyl = &parts.solid_meshes[0];
        assert_eq!(zyl.color, hex_to_rgb("#336699", SOLID_RGB));
        assert_eq!(parts.solid_meshes[1].color, SOLID_RGB);
        assert!(zyl.crease_angle.is_some());
        // Zylinder r 0.5 auf dem OG (UK 3, OK 4): ≥ 48 Ecken auf dem Umfang.
        let zs: Vec<f64> = zyl.positions.chunks_exact(3).map(|q| q[2]).collect();
        assert!(zs.iter().all(|z| (z - 3.0).abs() < 1e-9 || (z - 4.0).abs() < 1e-9), "{zs:?}");
        assert!(zs.iter().filter(|z| (*z - 3.0).abs() < 1e-9).count() >= crate::solid_mesh::MIN_SEG_3D);
        let m = crate::solid_bool::Mesh { positions: zyl.positions.clone(), indices: zyl.indices.clone() };
        let exact = std::f64::consts::PI * 0.25;
        assert!(m.is_closed() && (m.volume() - exact).abs() < 0.01 * exact, "{}", m.volume());
        // JSON-Teil `solidMeshes` (der Kern-Cache schreibt denselben Text, s. model3d_cache-Tests).
        let v = serde_json::to_value(&parts).unwrap();
        assert_eq!(v["solidMeshes"].as_array().unwrap().len(), 2);
    }

    /// [180] Klasse aus ⇒ Körper fehlt im 3D und im Pick; Explosion hebt ihn mit seinem Geschoss.
    #[test]
    fn klasse_und_explosion() {
        for (q, text) in [(project(&["40"]), String::new()), (project(&[]), r#"{"hide":["40"]}"#.to_string())] {
            let f = ClassFilter::from_text(&q, &text);
            let parts = parts_filtered(&q, true, 2.0, false, &f).unwrap();
            assert_eq!(solid_ids(&q, &parts), ["box"]);
            let ex = crate::explode3d::parts_filtered(&q, true, 2.0, false, 2.0, &f).unwrap();
            assert_eq!(solid_ids(&q, &ex), ["box"]);
            let mut g = crate::explode3d::pick_geometry(&q, 0.0).unwrap();
            f.retain_pick(&mut g);
            assert_eq!(g.solids.iter().map(|s| s.solid_id.as_str()).collect::<Vec<_>>(), ["box"]);
        }
        let p = project(&[]);
        let ex = crate::explode3d::parts(&p, true, 2.0, false, 2.0).unwrap();
        let dz = crate::explode3d::floor_offsets(&p, 2.0)["OG"];
        assert!(dz > 0.0);
        let zmin = ex.solid_meshes[0].positions.chunks_exact(3).map(|q| q[2]).fold(f64::INFINITY, f64::min);
        assert!((zmin - 3.0 - dz).abs() < 1e-9, "{zmin}");
        // Pick: Dreiecke des Netzes (Welt: x, Höhe, y), angehoben wie das Bild.
        let g = crate::explode3d::pick_geometry(&p, 2.0).unwrap();
        let zyl = g.solids.iter().find(|s| s.solid_id == "zyl").unwrap();
        assert_eq!(zyl.tris.len(), ex.solid_meshes[0].indices.len() / 3);
        let hmin = zyl.tris.iter().flatten().map(|v| v[1]).fold(f64::INFINITY, f64::min);
        assert!((hmin - 3.0 - dz).abs() < 1e-9, "{hmin}");
    }

    /// [115] Abzugskörper schneiden Wände im Kern (Netz statt truck-Spezifikation); Kennwerte aus dem Kern-Netz.
    #[test]
    fn abzug_als_netz_und_kennwerte() {
        let p = project(&[]);
        let parts = parts(&p, false, 2.0, false).unwrap();
        let cuts = crate::solid_specs::void_cuts(&p, &parts.walls, &parts.slabs);
        assert_eq!(cuts.walls.len(), 1);
        let vm = crate::solid_specs::void_meshes(&cuts, &parts.walls, &parts.slabs);
        assert_eq!(vm.walls.len(), 1);
        let (i, _, m) = &vm.walls[0];
        let w = &parts.walls[*i];
        assert_eq!(m.color, w.color);
        let mesh = crate::solid_bool::Mesh { positions: m.positions.clone(), indices: m.indices.clone() };
        let full = 6.0 * w.thickness * 2.8;
        assert!((mesh.volume() - (full - w.thickness * 1.0 * 2.0)).abs() < 1e-6, "{}", mesh.volume());
        let box_props = crate::solid_mesh::solid_props(&p, "box").unwrap();
        assert!((box_props.volume - 2.0).abs() < 1e-9 && (box_props.area - 10.0).abs() < 1e-9 && box_props.closed);
        assert!((box_props.centroid[0] - 5.5).abs() < 1e-9 && (box_props.centroid[2] - 1.0).abs() < 1e-9);
        assert!(crate::solid_mesh::solid_props(&p, "nix").is_none());
    }
}
