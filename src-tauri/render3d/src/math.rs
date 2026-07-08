// 4x4-Matrix-Mathematik + Kamera (View/Projektion + Orbit). Handgerechnet,
// spalten-major (WebGL/wgpu-Konvention: `m[col*4 + row]`), damit die Matrizen
// ohne Umsortieren direkt als Uniform hochladbar sind.
//
// WARUM handgerechnet statt `glam`:
//  - Die serde-only Standard-Schicht (`default`-Feature) soll — wie in render2d —
//    ohne zusaetzliche Crates headless test- und baubar bleiben. `glam` waere eine
//    weitere Abhaengigkeit in genau der Schicht, die schlank bleiben muss.
//  - Der benoetigte Umfang ist klein (perspective/ortho/look_at + Orbit) und exakt
//    testbar. Ein spaeterer Wechsel zu `glam` (nur in der GPU-Schicht) bleibt
//    moeglich, ohne die Tests der Mesh-/Kamera-Logik anzufassen.
//
// WICHTIG (Clip-Z-Konvention): wgpu/WebGPU erwartet Tiefe in [0, 1] (NICHT [-1, 1]
// wie OpenGL). Die Projektionen hier bilden daher auf den [0, 1]-Bereich ab.

use crate::types::{Camera, CameraPreset, Projection};

/// 4x4-Matrix, spalten-major (`m[col*4 + row]`).
pub type Mat4 = [f32; 16];

/// Einheitsmatrix.
pub fn identity() -> Mat4 {
    let mut m = [0.0f32; 16];
    m[0] = 1.0;
    m[5] = 1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    m
}

/// Matrix-Produkt `a * b` (spalten-major). Ergebnis wirkt als `(a*b) * v`.
pub fn mul(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut m = [0.0f32; 16];
    for col in 0..4 {
        for row in 0..4 {
            let mut sum = 0.0f32;
            for k in 0..4 {
                // a[k-te Spalte][row] * b[col-te Spalte][k]
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            m[col * 4 + row] = sum;
        }
    }
    m
}

/// Wendet die Matrix auf einen Punkt (w=1) an und liefert die kartesische xyz
/// (nach Division durch w). Fuer Tests / Punkt-Projektion.
pub fn transform_point(m: &Mat4, p: [f32; 3]) -> [f32; 4] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
    ]
}

// --- Vektor-Helfer (3D) ------------------------------------------------------

#[inline]
pub fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
pub fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
pub fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
pub fn length(a: [f32; 3]) -> f32 {
    dot(a, a).sqrt()
}

#[inline]
pub fn normalize(a: [f32; 3]) -> [f32; 3] {
    let l = length(a);
    if l > 1e-9 {
        [a[0] / l, a[1] / l, a[2] / l]
    } else {
        [0.0, 0.0, 0.0]
    }
}

/// Right-handed `look_at`-View-Matrix (Kamera blickt von `eye` auf `center`,
/// mit `up`). Spalten-major, Konvention wie three.js/gluLookAt: die Kamera
/// schaut entlang -Z im View-Raum.
pub fn look_at(eye: [f32; 3], center: [f32; 3], up: [f32; 3]) -> Mat4 {
    // f = Blickrichtung (vorwaerts), s = rechts, u = echtes Up.
    let f = normalize(sub(center, eye));
    let s = normalize(cross(f, up));
    let u = cross(s, f);

    let mut m = identity();
    // Rotationsanteil (Zeilen = s, u, -f).
    m[0] = s[0];
    m[4] = s[1];
    m[8] = s[2];
    m[1] = u[0];
    m[5] = u[1];
    m[9] = u[2];
    m[2] = -f[0];
    m[6] = -f[1];
    m[10] = -f[2];
    // Translationsanteil.
    m[12] = -dot(s, eye);
    m[13] = -dot(u, eye);
    m[14] = dot(f, eye);
    m
}

/// Perspektivische Projektion (right-handed), Clip-Z in [0, 1] (wgpu-Konvention).
/// `fov_y` in Radiant, `aspect` = Breite/Hoehe.
pub fn perspective(fov_y: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
    let f = 1.0 / (fov_y * 0.5).tan();
    let mut m = [0.0f32; 16];
    m[0] = f / aspect;
    m[5] = f;
    // Tiefen-Abbildung auf [0,1] (zNear -> 0, zFar -> 1).
    m[10] = far / (near - far);
    m[11] = -1.0;
    m[14] = (near * far) / (near - far);
    m
}

/// Orthografische Projektion (right-handed), Clip-Z in [0, 1] (wgpu-Konvention).
/// Symmetrisches Volumen [-h*aspect, h*aspect] x [-h, h], h = `half_height`.
pub fn orthographic(half_height: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
    let right = half_height * aspect;
    let top = half_height;
    let mut m = identity();
    m[0] = 1.0 / right;
    m[5] = 1.0 / top;
    // z: [near, far] -> [0, 1] (near -> 0).
    m[10] = 1.0 / (near - far);
    m[14] = near / (near - far);
    m
}

/// Projektionsmatrix aus einer `Camera` + Seitenverhaeltnis (Breite/Hoehe).
pub fn projection_matrix(cam: &Camera, aspect: f32) -> Mat4 {
    match cam.projection {
        Projection::Perspective => perspective(cam.fov_y, aspect, cam.near, cam.far),
        Projection::Orthographic => {
            orthographic(cam.ortho_half_height, aspect, cam.near, cam.far)
        }
    }
}

/// View-Matrix aus einer `Camera`.
pub fn view_matrix(cam: &Camera) -> Mat4 {
    look_at(cam.eye, cam.target, cam.up)
}

/// Kombinierte View-Projektions-Matrix (`proj * view`), fertig fuer das Uniform.
pub fn view_projection(cam: &Camera, aspect: f32) -> Mat4 {
    let v = view_matrix(cam);
    let p = projection_matrix(cam, aspect);
    mul(&p, &v)
}

/// Orbit-Kamera: berechnet die Augen-Position aus Ziel + Kugel-Koordinaten.
///  - `yaw`   : Drehung um die Y-Achse (Azimut), Radiant.
///  - `pitch` : Erhebung ueber die XZ-Ebene, Radiant (geklemmt, siehe unten).
///  - `dist`  : Abstand vom Ziel.
/// Y-up: Hoehe = dist*sin(pitch); horizontaler Radius = dist*cos(pitch).
pub fn orbit_eye(target: [f32; 3], yaw: f32, pitch: f32, dist: f32) -> [f32; 3] {
    // Pitch klemmen, damit die Kamera nicht ueber den Pol kippt (Gimbal-Flip).
    let limit = std::f32::consts::FRAC_PI_2 - 0.01;
    let p = pitch.clamp(-limit, limit);
    let r = dist * p.cos();
    [
        target[0] + r * yaw.cos(),
        target[1] + dist * p.sin(),
        target[2] + r * yaw.sin(),
    ]
}

/// Baut eine `Camera` fuer eines der Kardinal-/Iso-Presets (ROADMAP §11).
/// `target` ist das Blickziel (Modell-Mitte), `dist` der Abstand. Alle Presets
/// ausser `Persp` sind orthografisch (Front/Back/Top/Side/Left achsparallel,
/// die Iso-Varianten diagonal); nur Persp ist perspektivisch.
///
/// Achs-Konvention (wie die three.js-Sicht, s. `applyView3d` in Viewport3D.tsx):
/// +Z = vorne (Front blickt von +Z entlang -Z), +X = rechts (Side blickt von
/// +X entlang -X). Back/Left sind exakt die Gegenrichtungen (-Z/-X); es gibt
/// noch KEINEN Nordwinkel — die Kardinalrichtungen sind rein modellrelativ
/// (Vorne/Rechts/Hinten/Links im UI, keine Himmelsrichtungen).
pub fn preset_camera(preset: CameraPreset, target: [f32; 3], dist: f32) -> Camera {
    let mut cam = Camera {
        target,
        ..Camera::default()
    };
    // Iso-Distanz-Helfer: Augenabstand-Komponente je Achse, sodass der
    // tatsaechliche eye-target-Abstand exakt `dist` bleibt (d*sqrt(3) == dist,
    // wie bei den bisherigen Front/Top/Side-Presets), damit alle Iso-Varianten
    // das Modell gleich gross zeigen.
    let iso_d = dist / 3.0_f32.sqrt();
    match preset {
        // Blick entlang -Z (von vorne), orthografisch.
        CameraPreset::Front => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0], target[1], target[2] + dist];
            cam.up = [0.0, 1.0, 0.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Blick entlang +Z (von hinten) — Gegenrichtung von Front.
        CameraPreset::Back => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0], target[1], target[2] - dist];
            cam.up = [0.0, 1.0, 0.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Blick von oben entlang -Y (Grundriss), orthografisch. Up = -Z, damit
        // Modell-Y (world +Z) im Bild nach unten zeigt (wie die 2D-Plan-Sicht).
        CameraPreset::Top => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0], target[1] + dist, target[2]];
            cam.up = [0.0, 0.0, -1.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Blick entlang -X (von der rechten Seite), orthografisch.
        CameraPreset::Side => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0] + dist, target[1], target[2]];
            cam.up = [0.0, 1.0, 0.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Blick entlang +X (von der linken Seite) — Gegenrichtung von Side.
        CameraPreset::Left => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0] - dist, target[1], target[2]];
            cam.up = [0.0, 1.0, 0.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Isometrischer Ueberblick von vorne-oben-rechts (Default-Iso).
        // Echte Isometrie ist per Definition parallelprojiziert (keine
        // perspektivische Verzerrung, Kantenlaengen bleiben massstabsgetreu).
        CameraPreset::Iso => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0] + iso_d, target[1] + iso_d, target[2] + iso_d];
            cam.up = [0.0, 1.0, 0.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Isometrischer Ueberblick von vorne-oben-links.
        CameraPreset::IsoFrontLeft => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0] - iso_d, target[1] + iso_d, target[2] + iso_d];
            cam.up = [0.0, 1.0, 0.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Isometrischer Ueberblick von hinten-oben-rechts.
        CameraPreset::IsoBackRight => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0] + iso_d, target[1] + iso_d, target[2] - iso_d];
            cam.up = [0.0, 1.0, 0.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Isometrischer Ueberblick von hinten-oben-links.
        CameraPreset::IsoBackLeft => {
            cam.projection = Projection::Orthographic;
            cam.eye = [target[0] - iso_d, target[1] + iso_d, target[2] - iso_d];
            cam.up = [0.0, 1.0, 0.0];
            cam.ortho_half_height = dist * 0.5;
        }
        // Freie perspektivische Standard-Ansicht (leicht von vorn-oben-rechts).
        CameraPreset::Persp => {
            cam.projection = Projection::Perspective;
            cam.eye = orbit_eye(
                target,
                std::f32::consts::FRAC_PI_4,
                0.5,
                dist,
            );
            cam.up = [0.0, 1.0, 0.0];
        }
    }
    cam
}
