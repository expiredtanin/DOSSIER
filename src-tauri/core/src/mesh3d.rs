//! Gemeinsame Mesh-Ausgabe der 3D-Ableitungen (`stairs3d`, `columns3d`): ein Dreiecksnetz je
//! Eingabeelement, flach kodiert als `[n, (quelle, nPos, nIdx, positionen…, indizes…)…]`.
//! `quelle` ist der Index des Elements in der Eingabe, damit TS Farbe und Id zuordnen kann.

pub struct Mesh {
    pub src: usize,
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

pub fn encode_meshes(meshes: &[Mesh]) -> Vec<f64> {
    let total: usize = meshes.iter().map(|m| 3 + m.positions.len() + m.indices.len()).sum();
    let mut out = Vec::with_capacity(1 + total);
    out.push(meshes.len() as f64);
    for m in meshes {
        out.extend([m.src as f64, m.positions.len() as f64, m.indices.len() as f64]);
        out.extend(&m.positions);
        out.extend(m.indices.iter().map(|&i| i as f64));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kodierung() {
        let m = Mesh { src: 2, positions: vec![0.0, 1.0, 2.0], indices: vec![0, 0, 0] };
        assert_eq!(encode_meshes(&[m]), vec![1.0, 2.0, 3.0, 3.0, 0.0, 1.0, 2.0, 0.0, 0.0, 0.0]);
        assert_eq!(encode_meshes(&[]), vec![0.0]);
    }
}
