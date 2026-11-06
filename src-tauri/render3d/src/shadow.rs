// Schatten im 3D ([64]): Sonnenrichtung und Licht-Matrix des Shadow-Mappings (GPU-frei, testbar).
//
// Die Sonne ist ein gerichtetes Licht. Der Tiefenpass (`gpu.rs`, `SHADOW_WGSL`) rendert die Szene
// orthografisch aus der Sonnenrichtung in eine Tiefentextur; die Flaechen-Shader vergleichen jedes
// Fragment mit ihr (PCF). Hier liegt nur die Mathematik:
//
//  • [`sun_dir_world`]: Azimut/Hoehe (Kern `sun.rs`: Grad von Nord im Uhrzeigersinn, Grad ueber dem
//    Horizont) → Richtung ZUR Sonne in world (Y oben). Achsen wie die Bauteile (`mesh.rs`):
//    world = (Ost, Hoehe, Nord). Sonne unter dem Horizont → `None` (keine Schatten).
//  • [`light_view_proj`]: Licht-View-Projektion. Die Seitenausdehnung (x/y im Lichtraum) passt auf
//    die FOKUS-Box (eigene Bauteile ohne Gelaende/Importe), die Tiefe auf die GANZE Szene. Ein
//    Schatten liegt im Lichtraum immer auf derselben x/y-Stelle wie sein Werfer, also deckt die
//    Fokus-Box alle Schatten der Bauteile und alle Schatten AUF den Bauteilen ab — ohne die
//    Aufloesung an ein km-grosses Gelaende zu verschenken. Ausserhalb gilt „besonnt".
//    Eine Kaskade genuegt so: 2048 Texel auf ~30 m Gebaeude ≈ 1.5 cm.
//  • [`caster_indices`]: Dreiecke, die Schatten werfen — ohne Glas (Glas wirft keinen Schatten).

use crate::math::{dot, look_at, mul, normalize, transform_point, Bounds3, Mat4};
use crate::types::FLOATS_PER_VERTEX;

/// Albedo der Verglasung aus dem Kern (`core/src/model3d.rs`, `PART_RGB[0]`). Dreiecke mit genau
/// dieser Vertexfarbe gelten als Glas und werfen keinen Schatten. Bei Aenderung dort hier nachziehen.
pub const GLASS_RGB: [f32; 3] = [0.62, 0.76, 0.85];

/// Standard-Kantenlaenge der Schattentextur (Texel).
pub const DEFAULT_SHADOW_MAP_SIZE: u32 = 2048;

/// Richtung ZUR Sonne (world, normiert) aus Azimut (° von Nord im Uhrzeigersinn) und Hoehe (°).
/// `None`, wenn die Sonne nicht ueber dem Horizont steht oder die Werte unbrauchbar sind.
pub fn sun_dir_world(azimuth_deg: f64, elevation_deg: f64) -> Option<[f32; 3]> {
    if !azimuth_deg.is_finite() || !elevation_deg.is_finite() || elevation_deg <= 0.0 {
        return None;
    }
    let (az, el) = (azimuth_deg.to_radians(), elevation_deg.to_radians());
    let (east, north, up) = (az.sin() * el.cos(), az.cos() * el.cos(), el.sin());
    // Bauteile: world = (x, Hoehe, y) mit Modell x = Ost, y = Nord.
    Some([east as f32, up as f32, north as f32])
}

fn corners((lo, hi): Bounds3) -> [[f32; 3]; 8] {
    let mut out = [[0.0; 3]; 8];
    for (i, c) in out.iter_mut().enumerate() {
        *c = [
            if i & 1 == 0 { lo[0] } else { hi[0] },
            if i & 2 == 0 { lo[1] } else { hi[1] },
            if i & 4 == 0 { lo[2] } else { hi[2] },
        ];
    }
    out
}

fn finite_box(b: &Bounds3) -> bool {
    b.0.iter().chain(b.1.iter()).all(|v| v.is_finite()) && (0..3).all(|i| b.0[i] <= b.1[i])
}

/// Licht-View-Projektion (spalten-major, Clip-z in [0, 1] wie `math::orthographic`): orthografisch
/// entlang `-dir_to_light`. x/y umfassen die Ecken von `focus` (plus Rand), z die Ecken von `all`
/// und `focus`. `None` bei leerer/kaputter Eingabe.
pub fn light_view_proj(dir_to_light: [f32; 3], focus: Bounds3, all: Bounds3) -> Option<Mat4> {
    let d = normalize(dir_to_light);
    if dot(d, d) < 0.5 || !finite_box(&focus) {
        return None;
    }
    let all = if finite_box(&all) { all } else { focus };
    let center = [
        (focus.0[0] + focus.1[0]) * 0.5,
        (focus.0[1] + focus.1[1]) * 0.5,
        (focus.0[2] + focus.1[2]) * 0.5,
    ];
    // Hoch oben stehende Sonne: „oben" der Lichtkamera nach Norden statt Y.
    let up = if d[1].abs() > 0.99 { [0.0, 0.0, 1.0] } else { [0.0, 1.0, 0.0] };
    let view = look_at([center[0] + d[0], center[1] + d[1], center[2] + d[2]], center, up);
    let (mut x0, mut x1, mut y0, mut y1) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
    for c in corners(focus) {
        let v = transform_point(&view, c);
        x0 = x0.min(v[0]);
        x1 = x1.max(v[0]);
        y0 = y0.min(v[1]);
        y1 = y1.max(v[1]);
    }
    // Tiefe = -z im View-Raum (die Lichtkamera blickt entlang -z).
    let (mut n, mut f) = (f32::INFINITY, f32::NEG_INFINITY);
    for c in corners(all).into_iter().chain(corners(focus)) {
        let depth = -transform_point(&view, c)[2];
        n = n.min(depth);
        f = f.max(depth);
    }
    // Rand: 2 % + 0.5 m seitlich (PCF-Kern am Rand), 1 m in der Tiefe.
    let pad = |a: f32, b: f32| (b - a) * 0.02 + 0.5;
    let (px, py) = (pad(x0, x1), pad(y0, y1));
    let (x0, x1, y0, y1) = (x0 - px, x1 + px, y0 - py, y1 + py);
    let (n, f) = (n - 1.0, f + 1.0);
    if !(x1 > x0 && y1 > y0 && f > n) || ![x0, x1, y0, y1, n, f].iter().all(|v| v.is_finite()) {
        return None;
    }
    let mut proj = [0.0f32; 16];
    proj[0] = 2.0 / (x1 - x0);
    proj[5] = 2.0 / (y1 - y0);
    proj[10] = -1.0 / (f - n);
    proj[12] = -(x1 + x0) / (x1 - x0);
    proj[13] = -(y1 + y0) / (y1 - y0);
    proj[14] = -n / (f - n);
    proj[15] = 1.0;
    Some(mul(&proj, &view))
}

/// Weltgroesse eines Schatten-Texels (Meter) fuer die Normalen-Verschiebung gegen Schattenakne:
/// die groessere Seite des Licht-Frustums durch die Textur-Kantenlaenge.
pub fn texel_world_size(light: &Mat4, size: u32) -> f32 {
    // Zeile r der Matrix = Skalierung 2/Breite mal eine Einheits-Zeile der Rotation.
    let row = |r: usize| (light[r] * light[r] + light[r + 4] * light[r + 4] + light[r + 8] * light[r + 8]).sqrt();
    let (rx, ry) = (row(0), row(1));
    if size == 0 || !(rx > 0.0 && ry > 0.0) {
        return 0.0;
    }
    (2.0 / rx).max(2.0 / ry) / size as f32
}

fn is_glass(verts: &[f32], i: usize) -> bool {
    let b = i * FLOATS_PER_VERTEX + 6;
    match verts.get(b..b + 3) {
        Some(c) => (0..3).all(|k| (c[k] - GLASS_RGB[k]).abs() < 1e-3),
        None => false,
    }
}

/// Indizes der schattenwerfenden Dreiecke eines Netzes (`[pos, normal, color]`, s. `types`):
/// alle ausser Glas. Kaputte Indizes fallen weg.
pub fn caster_indices(verts: &[f32], indices: &[u32]) -> Vec<u32> {
    let n = verts.len() / FLOATS_PER_VERTEX;
    let mut out = Vec::with_capacity(indices.len());
    for t in indices.chunks_exact(3) {
        let ok = t.iter().all(|&i| (i as usize) < n);
        if ok && !t.iter().all(|&i| is_glass(verts, i as usize)) {
            out.extend_from_slice(t);
        }
    }
    out
}

/// Ausdehnung (world) der Ecken `from..` eines Netzes; `None` wenn leer.
pub fn verts_bounds(verts: &[f32], from_vertex: usize) -> Option<Bounds3> {
    let mut lo = [f32::INFINITY; 3];
    let mut hi = [f32::NEG_INFINITY; 3];
    for v in verts.chunks_exact(FLOATS_PER_VERTEX).skip(from_vertex) {
        for k in 0..3 {
            if v[k].is_finite() {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
    }
    (lo.iter().chain(hi.iter()).all(|v| v.is_finite())).then_some((lo, hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(m: &Mat4, p: [f32; 3]) -> [f32; 3] {
        let v = transform_point(m, p);
        [v[0] / v[3], v[1] / v[3], v[2] / v[3]]
    }

    #[test]
    fn sonnenrichtung_achsen() {
        // Sueden, 45°: zur Sonne = nach Sueden (world -z) und oben.
        let s = sun_dir_world(180.0, 45.0).unwrap();
        assert!(s[0].abs() < 1e-6 && (s[1] - 0.7071).abs() < 1e-3 && (s[2] + 0.7071).abs() < 1e-3, "{s:?}");
        // Osten, flach: +x.
        let e = sun_dir_world(90.0, 10.0).unwrap();
        assert!(e[0] > 0.98 && e[2].abs() < 1e-6, "{e:?}");
        // Norden: +z (Modell-y).
        let n = sun_dir_world(0.0, 30.0).unwrap();
        assert!(n[2] > 0.8 && n[0].abs() < 1e-6);
        // Laenge 1.
        let l = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
        assert!((l - 1.0).abs() < 1e-5);
    }

    #[test]
    fn sonne_unter_dem_horizont_keine_richtung() {
        assert!(sun_dir_world(180.0, -3.0).is_none());
        assert!(sun_dir_world(180.0, 0.0).is_none());
        assert!(sun_dir_world(f64::NAN, 20.0).is_none());
    }

    #[test]
    fn sonnenrichtung_aus_dem_kern_sonnenstand() {
        // Zuerich, 21.6. 12:30 MESZ ≈ 10:30 UTC: Sonne im Sueden-Suedosten, hoch.
        // Werte aus `core::sun::sun_position` (Azimut ≈ 157°, Hoehe ≈ 63°), hier fest eingesetzt.
        let d = sun_dir_world(157.0, 63.0).unwrap();
        assert!(d[1] > 0.85, "hoch: {d:?}");
        assert!(d[2] < 0.0 && d[0] > 0.0, "Sued-Suedost: {d:?}");
    }

    /// Alle Punkte der Fokus-Box liegen im Licht-Frustum (x/y in [-1,1], z in [0,1]), ebenso die
    /// Gelaende-Ecken in der Tiefe; naeher an der Sonne = kleinere Tiefe.
    #[test]
    fn szene_liegt_im_licht_frustum() {
        let focus: Bounds3 = ([-6.0, -3.0, -4.0], [14.0, 9.5, 10.0]);
        let all: Bounds3 = ([-200.0, -12.0, -200.0], [200.0, 20.0, 200.0]);
        for (az, el) in [(90.0, 8.0), (135.0, 25.0), (180.0, 64.0), (250.0, 12.0), (300.0, 40.0), (10.0, 89.5)] {
            let dir = sun_dir_world(az, el).unwrap();
            let m = light_view_proj(dir, focus, all).expect("Matrix");
            for c in corners(focus) {
                let p = clip(&m, c);
                assert!(p[0].abs() <= 1.0 && p[1].abs() <= 1.0, "az {az} el {el}: {p:?}");
                assert!((0.0..=1.0).contains(&p[2]), "az {az} el {el}: {p:?}");
            }
            for c in corners(all) {
                let z = clip(&m, c)[2];
                assert!((0.0..=1.0).contains(&z), "Gelaende-Tiefe az {az} el {el}: {z}");
            }
            // Ein Punkt Richtung Sonne versetzt liegt naeher (kleinere Tiefe).
            let mid = [4.0, 3.0, 3.0];
            let toward = [mid[0] + dir[0] * 2.0, mid[1] + dir[1] * 2.0, mid[2] + dir[2] * 2.0];
            assert!(clip(&m, toward)[2] < clip(&m, mid)[2]);
            // Gleiche x/y im Lichtraum fuer Werfer und seinen Schatten auf dem Boden.
            let roof = [4.0, 9.0, 3.0];
            let t = roof[1] / dir[1];
            let ground = [roof[0] - dir[0] * t, 0.0, roof[2] - dir[2] * t];
            let (a, b) = (clip(&m, roof), clip(&m, ground));
            assert!((a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4, "{a:?} {b:?}");
        }
    }

    #[test]
    fn kaputte_eingaben_ohne_matrix() {
        let b: Bounds3 = ([0.0; 3], [1.0; 3]);
        assert!(light_view_proj([0.0, 0.0, 0.0], b, b).is_none());
        assert!(light_view_proj([0.0, 1.0, 0.0], ([f32::NAN; 3], [1.0; 3]), b).is_none());
        // Kaputte Gesamt-Box: die Fokus-Box genuegt.
        assert!(light_view_proj([0.3, 1.0, 0.2], b, ([f32::NAN; 3], [1.0; 3])).is_some());
    }

    #[test]
    fn texelgroesse_folgt_dem_frustum() {
        let focus: Bounds3 = ([0.0, 0.0, 0.0], [20.0, 10.0, 20.0]);
        let m = light_view_proj([0.0, 1.0, 0.0], focus, focus).unwrap();
        let t = texel_world_size(&m, 2048);
        // Draufsicht: Frustum ≈ 21.4 m → ≈ 1 cm je Texel.
        assert!(t > 0.005 && t < 0.02, "{t}");
    }

    #[test]
    fn glas_wirft_keinen_schatten() {
        let v = |c: [f32; 3]| [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, c[0], c[1], c[2]];
        let mut verts = Vec::new();
        for c in [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], GLASS_RGB, GLASS_RGB, GLASS_RGB] {
            verts.extend_from_slice(&v(c));
        }
        let idx = [0, 1, 2, 3, 4, 5, 0, 1, 99];
        assert_eq!(caster_indices(&verts, &idx), vec![0, 1, 2]);
        assert_eq!(verts_bounds(&verts, 3), Some(([0.0; 3], [0.0; 3])));
        assert_eq!(verts_bounds(&verts, 6), None);
    }
}
