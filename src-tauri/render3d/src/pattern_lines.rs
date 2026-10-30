//! Ansichtsschraffur auf den Flächen ([100]) im 3D: Linien aus dem Kern (`surface_pattern3d`), je Linie
//! `ax ay az bx by bz r g b maske`. Die Maske sagt, in welchen Stufen der Massstabs-Leiter
//! [`LOD_SCALES`] (wie im Kern) die Linie vorkommt. Je Linie wird aus dem Bildschirm-Massstab an ihrer
//! Lage die passende Stufe gewählt und nur deren Linien gezeichnet: nah alle Fugen, weiter weg jede
//! 2./4./8. Linie, sehr weit keine — so entsteht kein Moiré. Gezeichnet nur in den Kanten-Stilen.

use crate::types::{Camera, Projection};

/// Massstabs-Leiter (Bit i der Maske = Stufe i), identisch zu `dossier_core::surface_pattern3d::LOD_SCALES`.
pub const LOD_SCALES: [f32; 7] = [25.0, 50.0, 100.0, 200.0, 400.0, 800.0, 1600.0];
/// Floats je Linie im Eingabepuffer.
pub const PATTERN_STRIDE: usize = 10;
/// Bildschirm-mm je Geräte-Pixel für die Umrechnung px/m → Massstab (0.7 mm Papier ≈ 4 px).
const MM_PER_PX: f32 = 0.175;

/// Geräte-Pixel je Meter an der Stelle `p` (Welt) für die Kamera.
pub fn px_per_m(camera: &Camera, viewport_h: f32, p: [f32; 3]) -> f32 {
    match camera.projection {
        Projection::Orthographic => viewport_h / (2.0 * camera.ortho_half_height.max(1e-6)),
        Projection::Perspective => {
            let f = [camera.target[0] - camera.eye[0], camera.target[1] - camera.eye[1], camera.target[2] - camera.eye[2]];
            let fl = (f[0] * f[0] + f[1] * f[1] + f[2] * f[2]).sqrt().max(1e-9);
            let d = ((p[0] - camera.eye[0]) * f[0] + (p[1] - camera.eye[1]) * f[1] + (p[2] - camera.eye[2]) * f[2]) / fl;
            if d <= camera.near.max(1e-4) {
                return 0.0;
            }
            viewport_h / (2.0 * d * (camera.fov_y * 0.5).tan())
        }
    }
}

/// Stufe (Index in [`LOD_SCALES`]) für einen Bildschirm-Massstab: die feinste Stufe, deren Massstab
/// mindestens so grob ist wie die Ansicht; `None`, wenn die Ansicht gröber als die gröbste Stufe ist.
pub fn lod_level(px_per_m: f32) -> Option<usize> {
    if !(px_per_m > 0.0) || !px_per_m.is_finite() {
        return None;
    }
    let scale = 1000.0 / (px_per_m * MM_PER_PX);
    LOD_SCALES.iter().position(|&s| s >= scale * 0.999)
}

/// Sichtbare Musterlinien als LineList-Vertices `[pos, rgb]` (2 je Linie) für die Kamera.
pub fn select_pattern_lines(data: &[f32], camera: &Camera, viewport_h: f32) -> Vec<f32> {
    let mut out = Vec::new();
    for c in data.chunks_exact(PATTERN_STRIDE) {
        if c.iter().any(|v| !v.is_finite()) {
            continue;
        }
        let mid = [(c[0] + c[3]) * 0.5, (c[1] + c[4]) * 0.5, (c[2] + c[5]) * 0.5];
        let Some(level) = lod_level(px_per_m(camera, viewport_h, mid)) else { continue };
        let mask = c[9] as u32;
        if mask & (1 << level) == 0 {
            continue;
        }
        out.extend_from_slice(&[c[0], c[1], c[2], c[6], c[7], c[8], c[3], c[4], c[5], c[6], c[7], c[8]]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(z: f32, mask: u8) -> [f32; PATTERN_STRIDE] {
        [0.0, 0.0, z, 1.0, 0.0, z, 0.2, 0.2, 0.2, mask as f32]
    }

    #[test]
    fn ausduennung_nach_abstand() {
        let cam = Camera { eye: [0.0, 0.0, 0.0], target: [0.0, 0.0, -1.0], ..Default::default() };
        // Linie A nur in der feinsten Stufe, Linie B in allen Stufen bis 1:400.
        let a = line(-3.0, 0b0000001);
        let b = line(-3.0, 0b0011111);
        let near: Vec<f32> = [a, b].concat();
        // Nah (3 m, 1000 px Höhe): beide sichtbar.
        assert_eq!(select_pattern_lines(&near, &cam, 1000.0).len(), 24);
        // Weit (60 m): nur B.
        let far: Vec<f32> = [line(-60.0, 0b0000001), line(-60.0, 0b0011111)].concat();
        assert_eq!(select_pattern_lines(&far, &cam, 1000.0).len(), 12);
        // Sehr weit (3 km): keine.
        let very: Vec<f32> = [line(-3000.0, 0b1111111)].concat();
        assert!(select_pattern_lines(&very, &cam, 1000.0).is_empty());
        // Hinter der Kamera: keine.
        assert!(select_pattern_lines(&line(3.0, 0b1111111), &cam, 1000.0).is_empty());
    }

    #[test]
    fn stufen_monoton() {
        assert_eq!(lod_level(1e6), Some(0));
        let mut last = 0;
        for k in 1..200 {
            if let Some(l) = lod_level(1000.0 / k as f32) {
                assert!(l >= last);
                last = l;
            }
        }
        assert_eq!(lod_level(0.0), None);
        assert_eq!(lod_level(f32::NAN), None);
    }
}
