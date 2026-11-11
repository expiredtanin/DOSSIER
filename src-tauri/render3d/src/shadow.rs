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
//    eine Box (eigene Bauteile ohne Gelaende/Importe), die Tiefe auf die GANZE Szene. Ein
//    Schatten liegt im Lichtraum immer auf derselben x/y-Stelle wie sein Werfer, also deckt die
//    Box alle Schatten ihrer Bauteile und alle Schatten AUF ihnen ab — ohne die Aufloesung an ein
//    km-grosses Gelaende zu verschenken. Ausserhalb gilt „besonnt".
//  • [`cascades`] ([186]): zwei Kaskaden. Kaskade 0 passt eng auf das GEBAEUDE (Waende, Decken und
//    alles, was ihren Grundriss beruehrt: Dach, Oeffnungen, Treppen) — 2048 Texel auf ~25 m ≈ 1.2 cm;
//    Kaskade 1 auf alle eigenen Bauteile samt Baeumen, Stuetzmauern, Baugrube. Vorher eine einzige
//    Kaskade ueber den ganzen Fokus: ein Baum oder Koerper weit weg vom Haus machte die Texel am
//    Gebaeude grob und den Schatten dort unscharf. Zeigt die Kamera nur einen Teil des Gebaeudes
//    (Nahsicht auf Erker, Fensterleibung), passt Kaskade 0 auf diesen Ausschnitt ([`view_region`],
//    [`view_box`]): 4096 Texel auf wenige Meter statt aufs ganze Haus — sonst zeigen Schatten unter
//    Dachrand/Attika und in Leibungen ausgefranste, weiche Treppenkanten. Die Box ist auf ein grobes
//    Raster gerundet, der Tiefenpass laeuft nur, wenn sie wechselt; Fenster auf das Texel-Raster
//    gerastet und in 0.5-m-Stufen bemessen, damit kleine Modell- oder Kamera-Aenderungen die
//    Schattenkanten nicht verschieben/flimmern lassen ([`light_view_proj`]).
//  • [`caster_indices`]: Dreiecke, die Schatten werfen — ohne Glas (Glas wirft keinen Schatten).

use crate::math::{cross, dot, look_at, mul, normalize, sub, transform_point, Bounds3, Mat4};
use crate::types::{Camera, Projection};
use crate::types::FLOATS_PER_VERTEX;

/// Albedo der Verglasung aus dem Kern (`core/src/model3d.rs`, `PART_RGB[0]`). Dreiecke mit genau
/// dieser Vertexfarbe gelten als Glas und werfen keinen Schatten. Bei Aenderung dort hier nachziehen.
pub const GLASS_RGB: [f32; 3] = [0.62, 0.76, 0.85];

/// Standard-Kantenlaenge der Schattentextur der Kaskade 0 (Texel). [186] 4096 (64 MB, Depth32) statt
/// 2048: am Gebaeude ≈ 0.7 cm je Texel, auch flach beschienene Flaechen bleiben scharf.
pub const DEFAULT_SHADOW_MAP_SIZE: u32 = 4096;

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

/// Stufe (m), auf die die Fensterbreite einer Kaskade aufgerundet wird: kleine Modell-Aenderungen
/// lassen Texelgroesse und -raster gleich ([186], keine wandernden Schattenkanten beim Editieren).
pub const WINDOW_STEP: f32 = 0.5;

/// Licht-View-Projektion (spalten-major, Clip-z in [0, 1] wie `math::orthographic`): orthografisch
/// entlang `-dir_to_light`. x/y umfassen die Ecken von `focus` (plus Rand), z die Ecken von `all`
/// und `focus`. `None` bei leerer/kaputter Eingabe.
///
/// [186] Die Licht-Kamera steht fest im Ursprung (nur die Sonnenrichtung dreht sie); das Fenster ist
/// je Achse in [`WINDOW_STEP`]-Stufen bemessen und bei `size` Texeln auf das Texel-Raster gerastet.
/// So bleibt das Raster bei kleinen Verschiebungen des Modells liegen.
pub fn light_view_proj(dir_to_light: [f32; 3], focus: Bounds3, all: Bounds3, size: u32) -> Option<Mat4> {
    let d = normalize(dir_to_light);
    if dot(d, d) < 0.5 || !finite_box(&focus) {
        return None;
    }
    let all = if finite_box(&all) { all } else { focus };
    // Hoch oben stehende Sonne: „oben" der Lichtkamera nach Norden statt Y.
    let up = if d[1].abs() > 0.99 { [0.0, 0.0, 1.0] } else { [0.0, 1.0, 0.0] };
    let view = look_at(d, [0.0, 0.0, 0.0], up);
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
    // Rand: 2 % + 0.5 m seitlich (PCF-Kern am Rand), 1 m in der Tiefe. Breite je Achse in
    // `WINDOW_STEP`-Stufen, untere Ecke aufs Texel-Raster; zwei Texel Reserve fuer die Rundung.
    let n_tex = size.max(1) as f32;
    let axis = |a0: f32, a1: f32| -> (f32, f32) {
        let w = (((a1 - a0) * 1.04 + 1.0) / WINDOW_STEP).ceil() * WINDOW_STEP;
        let texel = w / n_tex;
        let lo = ((0.5 * (a0 + a1) - 0.5 * w) / texel).floor() * texel - texel;
        (lo, lo + w + 2.0 * texel)
    };
    let ((x0, x1), (y0, y1)) = (axis(x0, x1), axis(y0, y1));
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

/// Ausdehnungen fuer die Schatten-Kaskaden ([186], `scene::Scene::shadow_bounds`), world.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShadowBounds {
    /// Gebaeude: Waende, Decken und eigene Netze, die deren Grundriss beruehren (Dach, Oeffnungen).
    pub core: Bounds3,
    /// Alle eigenen Bauteile ohne Gelaende/Importe (auch Baeume, Stuetzmauern, freie Koerper).
    pub focus: Bounds3,
    /// Das ganze Netz (Tiefe).
    pub all: Bounds3,
}

/// Zahl der Schatten-Kaskaden (Ebenen der Schattentextur).
pub const CASCADES: usize = 2;

/// [186] Licht-Matrizen der Kaskaden (Texturgroessen `size`, `size_far`): 0 = eng aufs Gebaeude, 1 = alle
/// eigenen Bauteile. `None` bei kaputter Eingabe (dann keine Schatten).
/// `view`: Box der Nahsicht ([`view_box`]); dann passt Kaskade 0 auf sie statt aufs ganze Gebaeude.
pub fn cascades(dir_to_light: [f32; 3], b: &ShadowBounds, view: Option<Bounds3>, size: u32, size_far: u32) -> Option<[Mat4; CASCADES]> {
    let fine = light_view_proj(dir_to_light, view.unwrap_or(b.core), b.all, size)?;
    let coarse = light_view_proj(dir_to_light, b.focus, b.all, size_far)?;
    Some([fine, coarse])
}

/// [186] Bereich (world-Box) um das, worauf die Kamera blickt: Sichtpyramide bzw. -quader von der halben
/// bis zur 1.3-fachen Zielentfernung (davor ist bei der Orbit-Kamera meist leerer Raum, dahinter ist im
/// Bild klein; beides faellt auf Kaskade 1). `None` bei kaputter Kamera.
pub fn view_region(cam: &Camera, aspect: f32) -> Option<Bounds3> {
    let dist = crate::math::length(sub(cam.target, cam.eye));
    if !(dist > 1e-6) || !dist.is_finite() || !(aspect > 0.0) || !aspect.is_finite() {
        return None;
    }
    let f = normalize(sub(cam.target, cam.eye));
    let r = normalize(cross(f, cam.up));
    let u = cross(r, f);
    if !r.iter().all(|v| v.is_finite()) || dot(r, r) < 0.5 {
        return None;
    }
    let (near_t, far) = (0.5 * dist, 1.3 * dist);
    let mut lo = [f32::INFINITY; 3];
    let mut hi = [f32::NEG_INFINITY; 3];
    let mut add = |t: f32, hw: f32, hh: f32| {
        for (a, b) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            for k in 0..3 {
                let v = cam.eye[k] + f[k] * t + r[k] * hw * a + u[k] * hh * b;
                lo[k] = lo[k].min(v);
                hi[k] = hi[k].max(v);
            }
        }
    };
    match cam.projection {
        Projection::Perspective => {
            let th = (cam.fov_y * 0.5).tan();
            if !(th > 0.0) || !th.is_finite() {
                return None;
            }
            add(near_t, near_t * th * aspect, near_t * th);
            add(far, far * th * aspect, far * th);
        }
        Projection::Orthographic => {
            let h = cam.ortho_half_height;
            if !(h > 0.0) || !h.is_finite() {
                return None;
            }
            add(near_t, h * aspect, h);
            add(far, h * aspect, h);
        }
    }
    let b = (lo, hi);
    finite_box(&b).then_some(b)
}

/// [186] Box der Kaskade 0, wenn die Kamera nur einen Teil des Gebaeudes zeigt (Nahsicht, Detail):
/// Gebaeude ∩ Sichtbereich, nach aussen auf ein Zweierpotenz-Raster (≥ 1/8 der Ausdehnung) gerundet,
/// damit kleine Kamerabewegungen die Box (und den Tiefenpass) nicht aendern. `None`, wenn der
/// Ausschnitt nicht deutlich (< 75 %) kleiner ist als das Gebaeude — dann gilt die feste Gebaeude-Box.
///
/// `prev` = Box des letzten Frames (Hysterese): Sie bleibt, solange sie den neuen Ausschnitt ganz
/// enthaelt und hoechstens 1.5-mal so gross ist — beim Drehen und Schieben wechselt die Box (und der
/// Tiefenpass) so nur selten, die Schattenkanten stehen.
pub fn view_box(prev: Option<Bounds3>, core: Bounds3, view: Option<Bounds3>) -> Option<Bounds3> {
    let v = view?;
    if !finite_box(&core) {
        return None;
    }
    let mut lo = [0.0f32; 3];
    let mut hi = [0.0f32; 3];
    for k in 0..3 {
        lo[k] = core.0[k].max(v.0[k]);
        hi[k] = core.1[k].min(v.1[k]);
        if !(hi[k] > lo[k]) {
            return None;
        }
    }
    let side = |b: &Bounds3| (b.1[0] - b.0[0]).max(b.1[2] - b.0[2]).max(b.1[1] - b.0[1]);
    if let Some(p) = prev.filter(finite_box) {
        let holds = (0..3).all(|k| p.0[k] <= lo[k] && p.1[k] >= hi[k]);
        if holds && side(&p) <= 1.5 * side(&(lo, hi)) && side(&p) < 0.75 * side(&core) {
            return Some(p);
        }
    }
    let ext = (0..3).map(|k| hi[k] - lo[k]).fold(0.0f32, f32::max);
    let g = 2f32.powf((ext / 8.0).max(0.25).log2().ceil());
    for k in 0..3 {
        // 10 % Luft je Seite, damit die naechsten Frames noch hineinpassen (Hysterese oben).
        lo[k] = (((lo[k] - 0.1 * ext) / g).floor() * g).max(core.0[k]);
        hi[k] = (((hi[k] + 0.1 * ext) / g).ceil() * g).min(core.1[k]);
    }
    (side(&(lo, hi)) < 0.75 * side(&core)).then_some((lo, hi))
}

/// Kantenlaenge der Schattentextur der Kaskade 1 zu der der Kaskade 0 (halb, hoechstens 2048).
pub fn far_map_size(size: u32) -> u32 {
    (size / 2).clamp(256, 2048)
}

/// [186] Braucht es Kaskade 1? Nur wenn die eigenen Bauteile seitlich deutlich (> 2 m) ueber das
/// Gebaeude hinausreichen (Baum, Koerper, Stuetzmauer abseits); sonst deckt Kaskade 0 alles ab.
pub fn far_cascade_needed(b: &ShadowBounds) -> bool {
    [0, 2].iter().any(|&i| b.focus.0[i] < b.core.0[i] - 2.0 || b.focus.1[i] > b.core.1[i] + 2.0) || b.focus.1[1] > b.core.1[1] + 2.0
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
            let m = light_view_proj(dir, focus, all, 2048).expect("Matrix");
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
        assert!(light_view_proj([0.0, 0.0, 0.0], b, b, 2048).is_none());
        assert!(light_view_proj([0.0, 1.0, 0.0], ([f32::NAN; 3], [1.0; 3]), b, 2048).is_none());
        // Kaputte Gesamt-Box: die Fokus-Box genuegt.
        assert!(light_view_proj([0.3, 1.0, 0.2], b, ([f32::NAN; 3], [1.0; 3]), 2048).is_some());
        assert!(light_view_proj([0.3, 1.0, 0.2], b, b, 0).is_some(), "Groesse 0 ohne Panik");
    }

    #[test]
    fn texelgroesse_folgt_dem_frustum() {
        let focus: Bounds3 = ([0.0, 0.0, 0.0], [20.0, 10.0, 20.0]);
        let m = light_view_proj([0.0, 1.0, 0.0], focus, focus, 2048).unwrap();
        let t = texel_world_size(&m, 2048);
        // Draufsicht: Frustum ≈ 21.4 m → ≈ 1 cm je Texel.
        assert!(t > 0.005 && t < 0.02, "{t}");
    }

    /// Musterhaus komplex (world = Ost, Hoehe, Nord; Masse aus `dossier-cli … model3d`): Haus samt
    /// Stuetzmauer, Carport und Dach 24 × 14.6 × 20.5 m, Gelaende 48 × 35 m; dazu ein Baum 60 m vom Haus
    /// (vorher machte er die einzige Kaskade grob). Mit zwei Kaskaden bleibt der Schatten am Haus fein.
    fn musterhaus() -> ShadowBounds {
        ShadowBounds {
            core: ([-6.7, -2.8, -4.2], [17.4, 11.8, 16.3]),
            focus: ([-6.7, -2.8, -7.2], [60.0, 11.8, 16.3]),
            all: ([-16.0, -3.4, -13.1], [60.0, 11.8, 21.1]),
        }
    }

    /// [186] Kaskade 0 umfasst das ganze Gebaeude (x/y in [-1, 1], z in [0, 1]) mit Texeln ≤ 1 cm bei
    /// jedem Sonnenstand des Jahres; Kaskade 1 alle eigenen Bauteile; Gelaende-Tiefe in beiden.
    #[test]
    fn kaskaden_gebaeude_fein_und_ganz_im_frustum() {
        let b = musterhaus();
        for (az, el) in [(60.0, 5.0), (90.0, 12.0), (135.0, 25.0), (157.0, 63.0), (180.0, 66.0), (180.0, 19.0), (250.0, 12.0), (300.0, 8.0), (10.0, 89.5)] {
            let dir = sun_dir_world(az, el).unwrap();
            let [fine, coarse] = cascades(dir, &b, None, DEFAULT_SHADOW_MAP_SIZE, far_map_size(DEFAULT_SHADOW_MAP_SIZE)).expect("Matrizen");
            for (m, bx) in [(&fine, b.core), (&coarse, b.focus)] {
                for c in corners(bx) {
                    let p = clip(m, c);
                    assert!(p[0].abs() < 1.0 && p[1].abs() < 1.0 && (0.0..=1.0).contains(&p[2]), "az {az} el {el}: {p:?}");
                }
                for c in corners(b.all) {
                    assert!((0.0..=1.0).contains(&clip(m, c)[2]), "Gelaende-Tiefe az {az} el {el}");
                }
            }
            let t = texel_world_size(&fine, DEFAULT_SHADOW_MAP_SIZE);
            assert!(t <= 0.01, "Texel am Gebaeude az {az} el {el}: {} cm", t * 100.0);
            // Eine Kaskade ueber alles (wie vorher) waere hier mehr als doppelt so grob.
            assert!(texel_world_size(&coarse, far_map_size(DEFAULT_SHADOW_MAP_SIZE)) > 2.0 * t);
            assert!(far_cascade_needed(&b));
        }
    }

    /// [186] Texel-Raster: Waechst das Modell um 1 cm (Wand verschoben), bleiben Texelgroesse und Raster
    /// gleich — ein fester Weltpunkt liegt an derselben Stelle im Texel (keine wandernden Schattenkanten).
    #[test]
    fn texelraster_steht_bei_kleiner_aenderung() {
        let b = musterhaus();
        let dir = sun_dir_world(135.0, 25.0).unwrap();
        let size = DEFAULT_SHADOW_MAP_SIZE;
        let a = light_view_proj(dir, b.core, b.all, size).unwrap();
        let mut moved = b.core;
        moved.1[0] += 0.01;
        moved.0[2] -= 0.01;
        let m = light_view_proj(dir, moved, b.all, size).unwrap();
        assert_eq!(texel_world_size(&a, size), texel_world_size(&m, size));
        for p in [[3.3, 0.0, 4.4], [12.1, 7.7, 2.2], [-0.4, 11.0, 15.0]] {
            let texel = |mx: &Mat4| {
                let c = clip(mx, p);
                [(c[0] * 0.5 + 0.5) * size as f32, (0.5 - c[1] * 0.5) * size as f32]
            };
            let (ta, tm) = (texel(&a), texel(&m));
            for k in 0..2 {
                let (fa, fm) = (ta[k] - ta[k].floor(), tm[k] - tm[k].floor());
                assert!((fa - fm).abs() < 0.02 || (fa - fm).abs() > 0.98, "{p:?}: {ta:?} {tm:?}");
            }
        }
    }

    fn cam(eye: [f32; 3], target: [f32; 3]) -> Camera {
        serde_json::from_value(serde_json::json!({ "eye": eye, "target": target, "up": [0.0, 1.0, 0.0] })).unwrap()
    }

    /// [186] Nahsicht auf den Erker (Abstand 3.7 m, wie im Bildschirmfoto des Maintainers): Kaskade 0 passt auf den Ausschnitt, Texel ≤ 4.5 mm (statt
    /// ≈ 8 mm aufs ganze Haus, vorher mit 2048 Texeln ≈ 16 mm); der sichtbare Fassadenpunkt liegt im Frustum. Leichte Kamerabewegung aendert
    /// die Box nicht (kein neuer Tiefenpass, kein Flimmern); Gesamtansicht: keine Nahsicht-Box.
    #[test]
    fn nahsicht_kaskade_auf_den_ausschnitt() {
        let b = musterhaus();
        let target = [16.5, 4.0, 5.0];
        let c = cam([20.0, 5.0, 4.0], target);
        let vb = view_box(None, b.core, view_region(&c, 1.5)).expect("Nahsicht");
        let dir = sun_dir_world(136.0, 60.0).unwrap();
        let [fine, _] = cascades(dir, &b, Some(vb), DEFAULT_SHADOW_MAP_SIZE, 2048).unwrap();
        let t = texel_world_size(&fine, DEFAULT_SHADOW_MAP_SIZE);
        assert!(t <= 0.0045, "Texel Nahsicht {} mm", t * 1000.0);
        let [whole_house, _] = cascades(dir, &b, None, DEFAULT_SHADOW_MAP_SIZE, 2048).unwrap();
        assert!(t < 0.6 * texel_world_size(&whole_house, DEFAULT_SHADOW_MAP_SIZE));
        let p = clip(&fine, target);
        assert!(p[0].abs() < 1.0 && p[1].abs() < 1.0 && (0.0..=1.0).contains(&p[2]), "{p:?}");
        let c2 = cam([20.05, 5.02, 3.97], [16.52, 4.0, 5.01]);
        assert_eq!(view_box(Some(vb), b.core, view_region(&c2, 1.5)), Some(vb), "kleine Bewegung, gleiche Box");
        // Weit weg geschoben: neue Box.
        let c3 = cam([10.0, 5.5, 18.0], [4.0, 4.0, 16.0]);
        assert_ne!(view_box(Some(vb), b.core, view_region(&c3, 1.5)), Some(vb));
        let whole = cam([60.0, 40.0, -40.0], [5.0, 4.0, 6.0]);
        assert!(view_box(Some(vb), b.core, view_region(&whole, 1.5)).is_none());
        // Kaputte Kamera: keine Box, keine Panik.
        assert!(view_region(&cam([1.0, 1.0, 1.0], [1.0, 1.0, 1.0]), 1.5).is_none());
        assert!(view_region(&c, f32::NAN).is_none());
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
