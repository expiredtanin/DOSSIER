//! Geteilte Ecken-Normalen eines Dreiecksnetzes ([T4], verschoben aus `render3d/src/mesh.rs` [201]): EINE Funktion für die
//! 3D-Anzeige (`render3d`, glatt schattierte Netzkörper) und die Mesh-Exporte (`fileio/mesh_export.rs`, glTF/OBJ-Normalen).

/// [T4] Geteilte Normalen ("split normals") je Dreiecks-Ecke: Summe der flaechengewichteten Normalen
/// aller Dreiecke an derselben Lage (verschweisst ueber die Lage, 0.01 mm Raster), deren Normale um
/// hoechstens `crease_deg` von der des Dreiecks abweicht. Entartete Dreiecke/kaputte Indizes: `None`.
pub fn smooth_corner_normals(indices: &[u32], vcount: usize, vworld: &dyn Fn(usize) -> [f32; 3], crease_deg: f32) -> Vec<Option<[[f32; 3]; 3]>> {
    use std::collections::HashMap;
    let key = |p: [f32; 3]| [(p[0] as f64 * 1e5).round() as i64, (p[1] as f64 * 1e5).round() as i64, (p[2] as f64 * 1e5).round() as i64];
    let mut weld: HashMap<[i64; 3], usize> = HashMap::new();
    let mut id = vec![usize::MAX; vcount];
    for (i, slot) in id.iter_mut().enumerate() {
        let n = weld.len();
        *slot = *weld.entry(key(vworld(i))).or_insert(n);
    }
    let tris: Vec<Option<([usize; 3], [f32; 3], [f32; 3])>> = indices
        .chunks_exact(3)
        .map(|t| {
            let v = [t[0] as usize, t[1] as usize, t[2] as usize];
            if v.iter().any(|&i| i >= vcount) {
                return None;
            }
            let (a, b, c) = (vworld(v[0]), vworld(v[1]), vworld(v[2]));
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let g = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
            let l = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            (l >= 1e-12 && l.is_finite()).then(|| ([id[v[0]], id[v[1]], id[v[2]]], g, [g[0] / l, g[1] / l, g[2] / l]))
        })
        .collect();
    let mut around: Vec<Vec<usize>> = vec![Vec::new(); weld.len()];
    for (k, t) in tris.iter().enumerate() {
        if let Some((w, _, _)) = t {
            for &v in w {
                if around[v].last() != Some(&k) {
                    around[v].push(k);
                }
            }
        }
    }
    let cos = crease_deg.min(180.0).to_radians().cos() - 1e-6;
    tris.iter()
        .map(|t| {
            let (w, _, nt) = t.as_ref()?;
            let corner = |v: usize| {
                let mut s = [0.0f32; 3];
                for &f in &around[v] {
                    if let Some((_, g, nf)) = &tris[f] {
                        if nf[0] * nt[0] + nf[1] * nt[1] + nf[2] * nt[2] >= cos {
                            s = [s[0] + g[0], s[1] + g[1], s[2] + g[2]];
                        }
                    }
                }
                let l = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
                if l > 1e-20 && l.is_finite() {
                    [s[0] / l, s[1] / l, s[2] / l]
                } else {
                    *nt
                }
            };
            Some([corner(w[0]), corner(w[1]), corner(w[2])])
        })
        .collect()
}
