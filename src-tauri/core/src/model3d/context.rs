//! Kontext im 3D: Gelände und importierte Netze als `RMesh`, ausgeblendete Kategorien weggelassen
//! (`emit_context_meshes()`). Aufgerufen von `parts()` (`mod.rs`) und der Pick-Geometrie.

use super::*;

const TERRAIN_RGB: Rgb = [169.0 / 255.0, 176.0 / 255.0, 162.0 / 255.0];
const IMPORTED_RGB: Rgb = [159.0 / 255.0, 166.0 / 255.0, 174.0 / 255.0];

fn indices_u32(v: &[f64]) -> Vec<u32> {
    v.iter().map(|&i| i as u32).collect()
}

/// Codes ausgeblendeter Kategorien samt Kindern einer ausgeblendeten Elternebene.
pub(super) fn hidden_category_codes(cats: &[crate::model::LayerCategory]) -> std::collections::HashSet<&str> {
    fn walk<'a>(list: &'a [crate::model::LayerCategory], parent_hidden: bool, out: &mut std::collections::HashSet<&'a str>) {
        for c in list {
            let hidden = parent_hidden || !c.visible;
            if hidden {
                out.insert(c.code.as_str());
            }
            walk(c.children.as_deref().unwrap_or(&[]), hidden, out);
        }
    }
    let mut out = std::collections::HashSet::new();
    walk(cats, false, &mut out);
    out
}

/// Rohe Kontext-Meshes: Gelände-TIN und importierte Volumen (`emitMeshes`).
pub fn emit_context_meshes(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    // [T6]/[114] Ebenen-Sichtbarkeit: ein ausgeblendetes Gelände (Kategorie „02") verschwindet auch im 3D.
    let hidden = hidden_category_codes(&p.layers);
    for obj in p.context.as_deref().unwrap_or(&[]) {
        // [181] Sichtbarkeit allein über die Klasse.
        if hidden.contains(obj.category_code()) {
            continue;
        }
        match obj {
            ContextObject::TerrainMesh(m) if m.positions.len() >= 9 && m.indices.len() >= 3 => {
                // [T6] Baugruben schneiden das Gelände; Höhen im Modellbezug (Luftbild-Farben auf das geänderte Netz übertragen).
                let (pos, idx, _) = crate::excavation::terrain_model_mesh(p, m);
                out.push(RMesh {
                    crease_angle: None,
                    positions: pos.into_owned(),
                    indices: indices_u32(&idx),
                    kind: "terrain",
                    color: TERRAIN_RGB,
                    vertex_colors: crate::excavation::terrain_vertex_colors(p, m),
                    material_index: None,
                })
            }
            ContextObject::ImportedMesh(m) if m.positions.len() >= 9 && m.indices.len() >= 3 => out.push(RMesh {
                positions: m.positions.clone(),
                indices: indices_u32(&m.indices),
                kind: "imported",
                color: IMPORTED_RGB,
                vertex_colors: None,
                material_index: None,
                crease_angle: (m.smooth_shading == Some(true)).then(|| m.crease_angle.filter(|a| a.is_finite() && *a > 0.0).unwrap_or(DEFAULT_CREASE_DEG).min(180.0)),
            }),
            _ => {}
        }
    }
    out
}
