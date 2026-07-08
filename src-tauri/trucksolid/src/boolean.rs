// Boolesche Operationen (Union/Differenz/Schnitt) zwischen zwei Dreiecks-Meshes.
// Mesh-Ebenen-CSG via csgrs (BSP-Baum) statt truck-modeling-Booleans — letztere
// sind bei koinzidenten/tangentialen Flächen instabil (siehe PENDENZEN.md,
// truck-Integration Phase 4, monstertruck-solid-Spike). csgrs erwies sich im
// Spike an genau diesem Fall (Extrusion bündig/eingebunden in eine Wand,
// deckungsgleicher Querschnitt) als exakt korrekt.

use csgrs::csg::CSG;
use csgrs::mesh::Mesh as CsgMesh;
use csgrs::polygon::Polygon;
use csgrs::triangulated::Triangulated3D;
use csgrs::vertex::Vertex;
use nalgebra::Point3;
use serde::{Deserialize, Serialize};

/// Eingabe-Mesh für eine boolesche Operation: flache f64-Positionen (Modell-
/// Meter) + Dreiecks-Indizes. Getrennt von `MeshOutput` (dort f32, da Render-
/// Ausgabe) — hier f64, da Eingabe aus Modelldaten und Präzision für die BSP-
/// Klassifikation an koinzidenten Flächen zählt.
#[derive(Deserialize)]
pub struct BooleanMeshInput {
    pub a_positions: Vec<f64>,
    pub a_indices: Vec<u32>,
    pub b_positions: Vec<f64>,
    pub b_indices: Vec<u32>,
    /// "union" | "difference" | "intersection"
    pub op: String,
}

#[derive(Serialize)]
pub struct BooleanMeshOutput {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    /// Ob das Ergebnis leer ist (z. B. Schnitt zweier sich nur berührender
    /// Körper) — csgrs liefert das als Trimesh-Fehler statt eines leeren
    /// Meshes zurück, hier auf einen sauberen Fall normalisiert.
    pub empty: bool,
}

fn mesh_from_triangles(positions: &[f64], indices: &[u32]) -> Result<CsgMesh<()>, String> {
    if indices.len() % 3 != 0 {
        return Err("indices müssen Dreiecke sein (Vielfaches von 3)".into());
    }
    let n_verts = positions.len() / 3;
    let mut polygons = Vec::with_capacity(indices.len() / 3);
    for tri in indices.chunks(3) {
        let mut pts = [Point3::origin(); 3];
        for (k, &i) in tri.iter().enumerate() {
            let idx = i as usize;
            if idx >= n_verts {
                return Err(format!("Index {idx} außerhalb der Positions-Liste"));
            }
            let o = idx * 3;
            pts[k] = Point3::new(positions[o], positions[o + 1], positions[o + 2]);
        }
        let normal = (pts[1] - pts[0]).cross(&(pts[2] - pts[0]));
        let verts = vec![
            Vertex::new(pts[0], normal),
            Vertex::new(pts[1], normal),
            Vertex::new(pts[2], normal),
        ];
        polygons.push(Polygon::new(verts, ()));
    }
    Ok(CsgMesh::from_polygons(&polygons, ()))
}

fn triangles_from_mesh(m: &CsgMesh<()>) -> (Vec<f32>, Vec<u32>) {
    let mut positions: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut next = 0u32;
    m.visit_triangles(|tri| {
        for v in &tri {
            positions.push(v.position.x as f32);
            positions.push(v.position.y as f32);
            positions.push(v.position.z as f32);
        }
        indices.push(next);
        indices.push(next + 1);
        indices.push(next + 2);
        next += 3;
    });
    (positions, indices)
}

pub fn boolean_mesh_core(
    a_positions: &[f64],
    a_indices: &[u32],
    b_positions: &[f64],
    b_indices: &[u32],
    op: &str,
) -> Result<BooleanMeshOutput, String> {
    let a = mesh_from_triangles(a_positions, a_indices)?;
    let b = mesh_from_triangles(b_positions, b_indices)?;
    let result = match op {
        "union" => a.union(&b),
        "difference" => a.difference(&b),
        "intersection" => a.intersection(&b),
        other => return Err(format!("unbekannte boolesche Operation: {other}")),
    };
    let (positions, indices) = triangles_from_mesh(&result);
    Ok(BooleanMeshOutput {
        empty: indices.is_empty(),
        positions,
        indices,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cuboid(x: f64, y: f64, z: f64, w: f64, l: f64, h: f64) -> (Vec<f64>, Vec<u32>) {
        let corners = [
            (x, y, z),
            (x + w, y, z),
            (x + w, y + l, z),
            (x, y + l, z),
            (x, y, z + h),
            (x + w, y, z + h),
            (x + w, y + l, z + h),
            (x, y + l, z + h),
        ];
        let mut positions = Vec::with_capacity(24);
        for (cx, cy, cz) in corners {
            positions.push(cx);
            positions.push(cy);
            positions.push(cz);
        }
        // 12 Dreiecke, konsistent nach außen orientiert (Rechte-Hand-Regel).
        let indices: Vec<u32> = vec![
            0, 2, 1, 0, 3, 2, // unten (-z)
            4, 5, 6, 4, 6, 7, // oben (+z)
            0, 5, 4, 0, 1, 5, // -y
            1, 6, 5, 1, 2, 6, // +x
            2, 7, 6, 2, 3, 7, // +y
            3, 4, 7, 3, 0, 4, // -x
        ];
        (positions, indices)
    }

    fn volume_of(positions: &[f32], indices: &[u32]) -> f64 {
        // Divergenztheorem (Tetraeder vom Ursprung), robust für beliebige geschlossene Dreiecksmeshes.
        let mut vol = 0.0f64;
        for tri in indices.chunks(3) {
            let mut p = [[0.0f64; 3]; 3];
            for (k, &i) in tri.iter().enumerate() {
                let o = i as usize * 3;
                p[k] = [
                    positions[o] as f64,
                    positions[o + 1] as f64,
                    positions[o + 2] as f64,
                ];
            }
            vol += (p[0][0] * (p[1][1] * p[2][2] - p[2][1] * p[1][2])
                - p[0][1] * (p[1][0] * p[2][2] - p[2][0] * p[1][2])
                + p[0][2] * (p[1][0] * p[2][1] - p[2][0] * p[1][1]))
                / 6.0;
        }
        vol.abs()
    }

    #[test]
    fn union_of_overlapping_cuboids() {
        let (ap, ai) = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        let (bp, bi) = cuboid(0.5, 0.5, 0.5, 1.0, 1.0, 1.0);
        let r = boolean_mesh_core(&ap, &ai, &bp, &bi, "union").unwrap();
        assert!(!r.empty);
        assert!((volume_of(&r.positions, &r.indices) - 1.875).abs() < 1e-6);
    }

    #[test]
    fn intersection_of_overlapping_cuboids() {
        let (ap, ai) = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        let (bp, bi) = cuboid(0.5, 0.5, 0.5, 1.0, 1.0, 1.0);
        let r = boolean_mesh_core(&ap, &ai, &bp, &bi, "intersection").unwrap();
        assert!(!r.empty);
        assert!((volume_of(&r.positions, &r.indices) - 0.125).abs() < 1e-6);
    }

    /// Praxisfall: Extrusion 0.1m in eine Wand eingebunden, deckungsgleicher
    /// Querschnitt — genau der Fall, an dem monstertruck-solid scheiterte.
    #[test]
    fn wall_minus_embedded_extrusion_matching_cross_section() {
        let wall = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        let embedded = cuboid(0.9, 0.0, 0.0, 1.0, 1.0, 1.0);
        let r = boolean_mesh_core(&wall.0, &wall.1, &embedded.0, &embedded.1, "difference").unwrap();
        assert!(!r.empty);
        assert!((volume_of(&r.positions, &r.indices) - 0.9).abs() < 1e-6);
    }

    #[test]
    fn flush_touching_union_is_exact() {
        let a = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        let b = cuboid(1.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        let r = boolean_mesh_core(&a.0, &a.1, &b.0, &b.1, "union").unwrap();
        assert!(!r.empty);
        assert!((volume_of(&r.positions, &r.indices) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_non_triangle_indices() {
        let (ap, _) = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        let bad_indices = vec![0u32, 1, 2, 3];
        assert!(boolean_mesh_core(&ap, &bad_indices, &ap, &bad_indices, "union").is_err());
    }

    #[test]
    fn rejects_unknown_op() {
        let (ap, ai) = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        assert!(boolean_mesh_core(&ap, &ai, &ap, &ai, "xor").is_err());
    }
}
