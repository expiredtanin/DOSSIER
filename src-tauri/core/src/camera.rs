//! [213] Kameras (`Project.cameras`): Auflösung zu Augpunkt, Ziel und Blickrichtung in Modell-Koordinaten
//! (z oben, Meter), Brennweite ↔ Bildwinkel. Das Planzeichen entsteht in `plan/cameras.rs`; die TS-Seite
//! (`src/model/cameraView.ts`) liefert daraus die Ansicht der 3D-Kamera (`cameraToView`).

use crate::jsnum;
use crate::model::*;

/// Präfix der Pick-Id im Feld `contextObjectId` der Plan-Primitive (`@` = keine Kontext-Element-Id).
pub const CAMERA_PICK_PREFIX: &str = "@camera:";
/// Vorgabe der Augenhöhe über dem Geschoss (m) und des vertikalen Bildwinkels (Grad; wie `FOV_Y` des 3D).
pub const DEFAULT_EYE_HEIGHT: f64 = 1.6;
pub const DEFAULT_FOV_DEG: f64 = 50.0;
/// Sichthöhe bei Axonometrie/Parallel ohne Angabe (m).
pub const DEFAULT_ORTHO_HEIGHT: f64 = 10.0;
/// Bildverhältnis für den Sichtkegel im Grundriss (Breite/Höhe).
pub const ASPECT: f64 = 16.0 / 9.0;
/// Sensorhöhe für die Kleinbild-Brennweite (mm).
pub const SENSOR_HEIGHT_MM: f64 = 24.0;
/// Bildwinkel-Grenzen (Grad), wie `camera3dFromViewCamera`.
pub const MIN_FOV_DEG: f64 = 5.0;
pub const MAX_FOV_DEG: f64 = 120.0;

/// Aufgelöste Kamera in Modell-Koordinaten.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraGeom {
    pub eye: [f64; 3],
    pub target: [f64; 3],
    /// Grundriss-Richtung (Bogenmass, 0 = +x), aus Standpunkt → Ziel.
    pub yaw: f64,
    /// Abstand Standpunkt → Ziel im Grundriss (m, ≥ 0).
    pub plan_dist: f64,
    pub fov_deg: f64,
    pub perspective: bool,
    pub ortho_height: f64,
}

/// Brennweite (mm, Kleinbild, 24 mm Sensorhöhe) zum vertikalen Bildwinkel.
pub fn focal_mm(fov_deg: f64) -> f64 {
    SENSOR_HEIGHT_MM / 2.0 / jsnum::tan(fov_deg.to_radians() / 2.0)
}

/// Vertikaler Bildwinkel (Grad) zur Brennweite (mm).
pub fn fov_deg_from_focal(mm: f64) -> f64 {
    2.0 * jsnum::atan(SENSOR_HEIGHT_MM / 2.0 / mm).to_degrees()
}

/// Bildwinkel in den zulässigen Bereich (Vorgabe bei NaN/≤ 0).
pub fn clamp_fov(fov_deg: f64) -> f64 {
    if fov_deg.is_finite() && fov_deg > 0.0 {
        fov_deg.clamp(MIN_FOV_DEG, MAX_FOV_DEG)
    } else {
        DEFAULT_FOV_DEG
    }
}

impl CameraGeom {
    /// Auflösung gegen das Projekt; `None` bei unbrauchbarer Lage (NaN).
    pub fn of(p: &Project, c: &Camera) -> Option<CameraGeom> {
        let floor_z = p.floor(&c.floor_id).and_then(|l| l.base_elevation).filter(|z| z.is_finite()).unwrap_or(0.0);
        Self::at(c, floor_z)
    }

    /// Wie [`CameraGeom::of`] mit gegebener Höhe der Geschoss-OK.
    pub fn at(c: &Camera, floor_z: f64) -> Option<CameraGeom> {
        let eye_h = if c.eye_height.is_finite() { c.eye_height } else { DEFAULT_EYE_HEIGHT };
        let (px, py, tx, ty, tz) = (c.position.x, c.position.y, c.target.x, c.target.y, c.target_height);
        if ![px, py, tx, ty, tz].iter().all(|v| v.is_finite()) {
            return None;
        }
        let (dx, dy) = (tx - px, ty - py);
        let plan_dist = dx.hypot(dy);
        let eye_z = floor_z + eye_h;
        Some(CameraGeom {
            eye: [px, py, eye_z],
            target: [tx, ty, tz],
            yaw: if plan_dist > 1e-9 { jsnum::atan2(dy, dx) } else { 0.0 },
            plan_dist,
            fov_deg: clamp_fov(c.fov_deg),
            perspective: c.projection == CameraProjection::Perspective || c.projection == CameraProjection::Unknown,
            ortho_height: c.ortho_height.filter(|h| h.is_finite() && *h > 0.0).unwrap_or(DEFAULT_ORTHO_HEIGHT),
        })
    }

    /// Blickrichtung (normiert); `None`, wenn Standpunkt und Ziel zusammenfallen.
    pub fn direction(&self) -> Option<[f64; 3]> {
        let d = [self.target[0] - self.eye[0], self.target[1] - self.eye[1], self.target[2] - self.eye[2]];
        let l = d[0].hypot(d[1]).hypot(d[2]);
        (l > 1e-9).then(|| [d[0] / l, d[1] / l, d[2] / l])
    }
}

/// Griffe im Grundriss (Modell-Meter) beim Massstab 1:`scale`: 0 Standpunkt, 1 Ziel, 2 rechter Rand der fernen
/// Sichtlinie (Perspektive: Bildwinkel, Axonometrie/Parallel: Sichtbreite).
pub fn grip_points(c: &Camera, scale: f64) -> Vec<(f64, f64)> {
    let Some(g) = CameraGeom::at(c, 0.0) else { return vec![] };
    let a = crate::plan::cameras::view_area(&g, if scale.is_finite() && scale > 0.0 { scale / 1000.0 } else { 0.1 });
    vec![(g.eye[0], g.eye[1]), (g.target[0], g.target[1]), (a[2].x, a[2].y)]
}

/// Kamera nach dem Ziehen des Griffs `index` an `(x, y)`; `None` bei unbekanntem Griff oder NaN.
/// 0 setzt den Standpunkt (Ziel bleibt), 1 das Ziel, 2 den Bildwinkel (Perspektive: aus dem Winkel zur Blickachse,
/// 5° bis 120° vertikal) bzw. die Sichtbreite (Axonometrie/Parallel: aus dem Abstand zur Blickachse).
pub fn grip_edit(c: &Camera, index: f64, x: f64, y: f64) -> Option<Camera> {
    if !(x.is_finite() && y.is_finite()) {
        return None;
    }
    let g = CameraGeom::at(c, 0.0)?;
    let mut n = c.clone();
    match index {
        i if i == 0.0 => n.position = Vec2 { x, y },
        i if i == 1.0 => n.target = Vec2 { x, y },
        i if i == 2.0 => {
            let (dx, dy) = (x - g.eye[0], y - g.eye[1]);
            if g.perspective {
                if dx.hypot(dy) < 1e-9 {
                    return None;
                }
                let mut a = jsnum::atan2(dy, dx) - g.yaw;
                a = jsnum::atan2(jsnum::sin(a), jsnum::cos(a)).abs();
                let h = a.clamp(0.5_f64.to_radians(), 75.0_f64.to_radians());
                n.fov_deg = clamp_fov((2.0 * jsnum::atan(jsnum::tan(h) / ASPECT)).to_degrees());
            } else {
                let side = (-jsnum::sin(g.yaw)) * dx + jsnum::cos(g.yaw) * dy;
                n.ortho_height = Some((2.0 * side.abs() / ASPECT).max(0.1));
            }
        }
        _ => return None,
    }
    Some(n)
}

/// Kamera um `(dx, dy)` verschoben (Standpunkt und Ziel).
pub fn moved(c: &Camera, dx: f64, dy: f64) -> Option<Camera> {
    if !(dx.is_finite() && dy.is_finite()) {
        return None;
    }
    let mut n = c.clone();
    n.position = Vec2 { x: c.position.x + dx, y: c.position.y + dy };
    n.target = Vec2 { x: c.target.x + dx, y: c.target.y + dy };
    Some(n)
}

/// Bezeichnung (Objekt-Info, Beschriftung): Name, sonst „Kamera".
pub fn label(c: &Camera) -> String {
    let n = c.name.trim();
    if n.is_empty() { "Kamera".to_string() } else { n.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera(json: serde_json::Value) -> Camera {
        let mut base = serde_json::json!({
            "id": "k1", "type": "camera", "name": "Süd", "floorId": "eg", "categoryCode": "92", "position": {"x": 1, "y": 2},
            "eyeHeight": 1.6, "target": {"x": 1, "y": 12}, "targetHeight": 1.6, "fovDeg": 50, "projection": "perspective"
        });
        for (k, v) in json.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn project() -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "p", "walls": [], "layers": [],
            "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "baseElevation": 3.0}]
        }))
        .unwrap()
    }

    #[test]
    fn augenhoehe_ueber_geschoss_und_richtung() {
        let g = CameraGeom::of(&project(), &camera(serde_json::json!({}))).unwrap();
        assert_eq!(g.eye, [1.0, 2.0, 4.6]);
        assert!((g.yaw - std::f64::consts::FRAC_PI_2).abs() < 1e-12);
        assert!((g.plan_dist - 10.0).abs() < 1e-12);
        assert!(g.perspective);
        let d = g.direction().unwrap();
        assert!(d[1] > 0.9 && d[2] < 0.0, "Ziel liegt tiefer als das Auge");
    }

    #[test]
    fn ohne_geschoss_null_und_nan_verworfen() {
        let g = CameraGeom::of(&Project::default(), &camera(serde_json::json!({"projection": "parallel", "orthoHeight": 6}))).unwrap();
        assert_eq!(g.eye[2], 1.6);
        assert!(!g.perspective);
        assert_eq!(g.ortho_height, 6.0);
        let mut c = camera(serde_json::json!({}));
        c.position.x = f64::NAN;
        assert!(CameraGeom::of(&project(), &c).is_none());
    }

    #[test]
    fn brennweite_und_bildwinkel_umkehrbar() {
        assert!((focal_mm(fov_deg_from_focal(35.0)) - 35.0).abs() < 1e-9);
        // 24 mm Sensorhöhe, 35 mm Brennweite: rund 37.8°.
        assert!((fov_deg_from_focal(35.0) - 37.85).abs() < 0.05);
        assert_eq!(clamp_fov(f64::NAN), DEFAULT_FOV_DEG);
        assert_eq!(clamp_fov(500.0), MAX_FOV_DEG);
    }

    #[test]
    fn griffe_standpunkt_ziel_winkel() {
        let c = camera(serde_json::json!({}));
        let pts = grip_points(&c, 100.0);
        assert_eq!(pts.len(), 3);
        assert_eq!(pts[0], (1.0, 2.0));
        assert_eq!(pts[1], (1.0, 12.0));
        // Ziehen des Winkel-Griffs auf den heutigen Punkt ändert den Bildwinkel nicht.
        let same = grip_edit(&c, 2.0, pts[2].0, pts[2].1).unwrap();
        assert!((same.fov_deg - 50.0).abs() < 1e-9, "{}", same.fov_deg);
        // Weiter öffnen: 45° zur Blickachse ergibt einen grösseren Bildwinkel.
        let wide = grip_edit(&c, 2.0, 1.0 + 10.0, 2.0 + 10.0).unwrap();
        assert!(wide.fov_deg > 50.0);
        assert_eq!(grip_edit(&c, 0.0, 5.0, 6.0).unwrap().position, Vec2 { x: 5.0, y: 6.0 });
        assert_eq!(grip_edit(&c, 1.0, 5.0, 6.0).unwrap().target, Vec2 { x: 5.0, y: 6.0 });
        assert!(grip_edit(&c, 7.0, 0.0, 0.0).is_none());
        assert!(grip_edit(&c, 0.0, f64::NAN, 0.0).is_none());
        // Parallelprojektion: Sichtbreite aus dem Abstand zur Achse.
        let par = camera(serde_json::json!({"projection": "parallel", "orthoHeight": 4}));
        let w = grip_points(&par, 100.0)[2];
        let edit = grip_edit(&par, 2.0, w.0 - 1.0, w.1).unwrap();
        assert!((edit.ortho_height.unwrap() - 2.0 * (4.0 * ASPECT / 2.0 + 1.0) / ASPECT).abs() < 1e-9);
        let m = moved(&c, 1.0, -1.0).unwrap();
        assert_eq!((m.position, m.target), (Vec2 { x: 2.0, y: 1.0 }, Vec2 { x: 2.0, y: 11.0 }));
    }

    #[test]
    fn modell_aus_json_verlustfrei() {
        let c = camera(serde_json::json!({"sunWhen": "2026-06-21T08:00:00Z", "orthoHeight": 8}));
        let back: Camera = serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
        assert_eq!(back, c);
        assert_eq!(label(&Camera::default()), "Kamera");
    }
}
