// Boolesche Operationen (Union/Differenz/Schnitt) zwischen zwei Dreiecks-Meshes.
// Mesh-Ebenen-Boolean mit `manifold-rust` (Port von Manifold, exakter Modus) statt
// truck-B-Rep-Booleans (scheitern an koinzidenten Flächen) und statt des früheren
// csgrs-Fallbacks (offene Netze, langsam). Messung und Entscheid: TODO.md [107].
//
// Manifold nimmt innen-nach-aussen gedrehte Körper still an und rechnet dann falsch;
// deshalb werden die Eingaben vorher geprüft (endlich, geschlossen, Orientierung).

use std::collections::HashMap;

use manifold_rust::manifold::Manifold;
use manifold_rust::types::{BooleanEngine, Error, MeshGL64, OpType};
use serde::{Deserialize, Serialize};

/// Obergrenze Dreiecke je Eingabe (Schutz vor Speicher-/Zeitexplosion im WASM).
pub const MAX_TRIANGLES: usize = 500_000;

/// Eingabe-Mesh für eine boolesche Operation: flache f64-Positionen (Modell-
/// Meter) + Dreiecks-Indizes. Getrennt von `MeshOutput` (dort f32, da Render-
/// Ausgabe) — hier f64, da Eingabe aus Modelldaten.
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
    /// Ob das Ergebnis leer ist (z. B. Schnitt zweier sich nur berührender Körper).
    pub empty: bool,
}

/// Ergebnis in voller f64-Genauigkeit (Tests, Weiterverkettung).
pub struct BooleanMeshF64 {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

/// Prüft ein Eingabe-Mesh und liefert ein verschweisstes, nach aussen orientiertes Netz
/// (gleiche Koordinaten werden vereint; Null-Flächen-Dreiecke entfallen).
fn checked_mesh(positions: &[f64], indices: &[u32], what: &str) -> Result<MeshGL64, String> {
    if positions.len() % 3 != 0 || indices.len() % 3 != 0 {
        return Err(format!("{what}: Positionen/Indizes müssen Dreier-Gruppen sein"));
    }
    if indices.is_empty() {
        return Err(format!("{what}: leeres Netz"));
    }
    if indices.len() / 3 > MAX_TRIANGLES {
        return Err(format!("{what}: zu viele Dreiecke (> {MAX_TRIANGLES})"));
    }
    if positions.iter().any(|x| !x.is_finite()) {
        return Err(format!("{what}: nicht endliche Koordinaten"));
    }
    let n_in = positions.len() / 3;
    // Verschweissen über exakt gleiche Koordinaten (-0.0 == 0.0).
    let mut ids: HashMap<[u64; 3], u32> = HashMap::new();
    let mut verts: Vec<f64> = Vec::new();
    let mut map: Vec<u32> = Vec::with_capacity(n_in);
    for c in positions.chunks_exact(3) {
        let key = [(c[0] + 0.0).to_bits(), (c[1] + 0.0).to_bits(), (c[2] + 0.0).to_bits()];
        let next = ids.len() as u32;
        let id = *ids.entry(key).or_insert_with(|| {
            verts.extend_from_slice(&[c[0] + 0.0, c[1] + 0.0, c[2] + 0.0]);
            next
        });
        map.push(id);
    }
    let mut tris: Vec<u32> = Vec::with_capacity(indices.len());
    for t in indices.chunks_exact(3) {
        let mut m = [0u32; 3];
        for k in 0..3 {
            let i = t[k] as usize;
            if i >= n_in {
                return Err(format!("{what}: Index {i} außerhalb der Positions-Liste"));
            }
            m[k] = map[i];
        }
        if m[0] == m[1] || m[1] == m[2] || m[0] == m[2] {
            continue;
        }
        tris.extend_from_slice(&m);
    }
    if tris.is_empty() {
        return Err(format!("{what}: nur entartete Dreiecke"));
    }
    // Geschlossen und mannigfaltig: jede gerichtete Kante genau einmal, ihre Gegenkante auch.
    let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
    for t in tris.chunks_exact(3) {
        for k in 0..3 {
            *edges.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
        }
    }
    for (&(a, b), &c) in &edges {
        if c != 1 || edges.get(&(b, a)).copied() != Some(1) {
            return Err(format!("{what}: Netz nicht geschlossen/mannigfaltig"));
        }
    }
    // Orientierung: Volumen > 0 (Divergenzsatz, relativ zur Min-Ecke für Stabilität).
    let mut o = [f64::INFINITY; 3];
    for v in verts.chunks_exact(3) {
        for k in 0..3 {
            o[k] = o[k].min(v[k]);
        }
    }
    let p = |i: u32| {
        let j = i as usize * 3;
        [verts[j] - o[0], verts[j + 1] - o[1], verts[j + 2] - o[2]]
    };
    let mut vol = 0.0;
    for t in tris.chunks_exact(3) {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    if !vol.is_finite() || vol == 0.0 {
        return Err(format!("{what}: Volumen 0"));
    }
    if vol < 0.0 {
        tris.chunks_exact_mut(3).for_each(|t| t.swap(1, 2));
    }
    let mut g = MeshGL64::default();
    g.num_prop = 3;
    g.vert_properties = verts;
    g.tri_verts = tris.iter().map(|&i| i as u64).collect();
    Ok(g)
}

fn to_manifold(g: &MeshGL64, what: &str) -> Result<Manifold, String> {
    let m = Manifold::from_mesh_gl64(g);
    if m.status() != Error::NoError {
        return Err(format!("{what}: kein gültiger Körper ({:?})", m.status()));
    }
    Ok(m)
}

/// Boolean in f64. Fehler bei ungültigen Eingaben (offen, nicht endlich, leer …).
pub fn boolean_mesh_f64(
    a_positions: &[f64],
    a_indices: &[u32],
    b_positions: &[f64],
    b_indices: &[u32],
    op: &str,
) -> Result<BooleanMeshF64, String> {
    let op = match op {
        "union" => OpType::Add,
        "difference" => OpType::Subtract,
        "intersection" => OpType::Intersect,
        other => return Err(format!("unbekannte boolesche Operation: {other}")),
    };
    let a = to_manifold(&checked_mesh(a_positions, a_indices, "Körper A")?, "Körper A")?;
    let b = to_manifold(&checked_mesh(b_positions, b_indices, "Körper B")?, "Körper B")?;
    let r = match op {
        OpType::Add => a.union_with_engine(&b, BooleanEngine::Exact),
        OpType::Subtract => a.difference_with_engine(&b, BooleanEngine::Exact),
        OpType::Intersect => a.intersection_with_engine(&b, BooleanEngine::Exact),
    };
    if r.status() != Error::NoError {
        return Err(format!("Boolean fehlgeschlagen ({:?})", r.status()));
    }
    if r.is_empty() {
        return Ok(BooleanMeshF64 { positions: vec![], indices: vec![] });
    }
    // Koplanare Dreiecke und überzählige Knoten zusammenfassen (der exakte Modus liefert
    // sonst ein Mehrfaches an Dreiecken).
    let g = r.simplify(0.0).get_mesh_gl64(-1);
    let np = g.num_prop as usize;
    let positions: Vec<f64> = g.vert_properties.chunks_exact(np).flat_map(|v| [v[0], v[1], v[2]]).collect();
    let indices: Vec<u32> = g.tri_verts.iter().map(|&i| i as u32).collect();
    Ok(BooleanMeshF64 { positions, indices })
}

pub fn boolean_mesh_core(
    a_positions: &[f64],
    a_indices: &[u32],
    b_positions: &[f64],
    b_indices: &[u32],
    op: &str,
) -> Result<BooleanMeshOutput, String> {
    let r = boolean_mesh_f64(a_positions, a_indices, b_positions, b_indices, op)?;
    Ok(BooleanMeshOutput {
        empty: r.indices.is_empty(),
        positions: r.positions.iter().map(|x| *x as f32).collect(),
        indices: r.indices,
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
