// Nativer wgpu-3D-Renderer fuer die CAD-Modellsicht.
//
// Aufbau in Schichten (bewusst getrennt, siehe Feature-Flags in Cargo.toml):
//  - `types`   : serde-only Eingabe (geflachte Waende, Kamera) + Mesh-Ausgabe.
//  - `mesh`    : Wand-Extrusion (Band aus Achse+Dicke, hochgezogen auf Hoehe).
//                GPU-frei, headless per `cargo test` pruefbar. Kern-Port der
//                three.js-`ExtrudeGeometry`-Wanderzeugung.
//  - `math`    : Mat4 + Kamera (View/Projektion, Perspektive + Orthografie,
//                die fuenf Presets) + Orbit-Helfer. Handgerechnet, testbar.
//  - `shaders` : WGSL-Quelle (View-Projektion + Directional-Light).
//  - `gpu`     : wgpu-Pipeline mit Tiefenpuffer + Backface-Culling (Feature "render").
//  - `bin/spike3d` : winit-Fenster mit Orbit-Kamera (Feature "window").
//
// Standard-Build (`cargo test`/`cargo build` ohne Features) enthaelt nur die
// GPU-freien Schichten und ist damit unabhaengig von einer Display-Session.

pub mod math;
pub mod mesh;
pub mod shaders;
pub mod types;

#[cfg(feature = "render")]
pub mod gpu;

pub use math::{
    look_at, orbit_eye, orthographic, perspective, preset_camera, projection_matrix,
    view_matrix, view_projection, Mat4,
};
pub use mesh::{build_walls_mesh, extrude_wall};
pub use types::{
    Camera, CameraPreset, Mesh, Point2, Projection, Rgb, WallInput, FLOATS_PER_VERTEX,
};

// --- Tests: Mesh-Erzeugung (Muster wie render2d/tessellate) -------------------

#[cfg(test)]
mod tests {
    use super::mesh::{build_walls_mesh, extrude_wall, INDICES_PER_BOX, VERTS_PER_BOX};
    use super::types::{Mesh, WallInput, FLOATS_PER_VERTEX};

    /// Bequemer Bau einer achsparallelen Wand entlang +X.
    fn wall_x(len: f32, thickness: f32, height: f32) -> WallInput {
        WallInput {
            start: [0.0, 0.0],
            end: [len, 0.0],
            thickness,
            height,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
        }
    }

    /// Liest Position + Normale eines Vertex (index i) aus dem interleaved Puffer.
    fn vert(mesh: &Mesh, i: usize) -> ([f32; 3], [f32; 3]) {
        let b = i * FLOATS_PER_VERTEX;
        (
            [mesh.verts[b], mesh.verts[b + 1], mesh.verts[b + 2]],
            [mesh.verts[b + 3], mesh.verts[b + 4], mesh.verts[b + 5]],
        )
    }

    #[test]
    fn eine_wand_hat_quader_zaehlung() {
        // Eine Wand -> ein Quader: 24 Vertices, 36 Indizes (12 Dreiecke).
        let mesh = build_walls_mesh(&[wall_x(3.0, 0.2, 2.5)]);
        assert_eq!(mesh.vertex_count(), VERTS_PER_BOX, "24 Vertices je Quader");
        assert_eq!(mesh.indices.len(), INDICES_PER_BOX, "36 Indizes je Quader");
        assert_eq!(mesh.triangle_count(), 12, "12 Dreiecke je Quader");
        // Kein Index zeigt ausserhalb des Puffers.
        let max_idx = *mesh.indices.iter().max().unwrap();
        assert!((max_idx as usize) < mesh.vertex_count());
    }

    #[test]
    fn mehrere_waende_addieren_sich() {
        let mesh = build_walls_mesh(&[
            wall_x(3.0, 0.2, 2.5),
            WallInput {
                start: [3.0, 0.0],
                end: [3.0, 4.0],
                thickness: 0.2,
                height: 2.5,
                base_elevation: 0.0,
                color: [0.8, 0.8, 0.8],
            },
        ]);
        assert_eq!(mesh.vertex_count(), 2 * VERTS_PER_BOX);
        assert_eq!(mesh.indices.len(), 2 * INDICES_PER_BOX);
    }

    #[test]
    fn bounding_box_deckt_dicke_laenge_hoehe_ab() {
        // Wand entlang +X, Laenge 3, Dicke 0.2 -> Band in Z von -0.1..0.1;
        // Hoehe 2.5 ab Basis 0. world: (x, y=hoehe, z=grundriss.y).
        let mesh = build_walls_mesh(&[wall_x(3.0, 0.2, 2.5)]);
        let (min, max) = mesh.bounds();
        // X: 0..3 (Achsenlaenge).
        assert!((min[0] - 0.0).abs() < 1e-5, "min x == 0");
        assert!((max[0] - 3.0).abs() < 1e-5, "max x == 3");
        // Y: 0..2.5 (Hoehe).
        assert!((min[1] - 0.0).abs() < 1e-5, "min y == 0");
        assert!((max[1] - 2.5).abs() < 1e-5, "max y == 2.5");
        // Z: -0.1..0.1 (halbe Dicke je Seite).
        assert!((min[2] + 0.1).abs() < 1e-5, "min z == -0.1");
        assert!((max[2] - 0.1).abs() < 1e-5, "max z == 0.1");
    }

    #[test]
    fn basis_hoehe_verschiebt_in_y() {
        let mut w = wall_x(3.0, 0.2, 2.5);
        w.base_elevation = 3.0; // Obergeschoss.
        let mesh = build_walls_mesh(&[w]);
        let (min, max) = mesh.bounds();
        assert!((min[1] - 3.0).abs() < 1e-5, "Unterkante auf Basis 3.0");
        assert!((max[1] - 5.5).abs() < 1e-5, "Oberkante 3.0 + 2.5");
    }

    #[test]
    fn deckel_normale_zeigt_nach_oben() {
        // Der Deckel wird als erstes Quad angehaengt (Vertices 0..3): Normale +Y.
        let mesh = build_walls_mesh(&[wall_x(3.0, 0.2, 2.5)]);
        let (_, n0) = vert(&mesh, 0);
        assert!((n0[0]).abs() < 1e-6);
        assert!((n0[1] - 1.0).abs() < 1e-6, "Deckel-Normale +Y");
        assert!((n0[2]).abs() < 1e-6);
    }

    #[test]
    fn mantel_normalen_zeigen_nach_aussen() {
        // Wand entlang +X: die +n-Seite liegt bei z=+0.1 (n = leftNormal von +X =
        // (0,1) im Grundriss -> world +Z), die -n-Seite bei z=-0.1. Fuer JEDE
        // Mantelflaechen-Normale muss gelten: sie zeigt vom Wand-Zentrum weg.
        let mesh = build_walls_mesh(&[wall_x(3.0, 0.2, 2.5)]);
        // Wand-Zentrum in world.
        let center = [1.5f32, 1.25, 0.0];
        // Alle Vertices durchgehen; fuer jede Flaeche muss die Normale eine
        // positive Komponente in Richtung (Vertex - Zentrum) haben (zeigt raus).
        let n = mesh.vertex_count();
        for i in 0..n {
            let (p, nor) = vert(&mesh, i);
            let out = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
            let d = out[0] * nor[0] + out[1] * nor[1] + out[2] * nor[2];
            // >= 0: die Normale weist nie ins Innere (Backface-Culling korrekt).
            assert!(
                d >= -1e-5,
                "Vertex {i}: Normale zeigt nach innen (dot={d})"
            );
        }
    }

    #[test]
    fn diagonale_wand_hat_gleiche_zaehlung() {
        // Auch nicht-achsparallele Waende extrudieren korrekt (nur andere Ecken).
        let w = WallInput {
            start: [0.0, 0.0],
            end: [2.0, 2.0],
            thickness: 0.3,
            height: 3.0,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
        };
        let mut mesh = Mesh::default();
        extrude_wall(&mut mesh, &w);
        assert_eq!(mesh.vertex_count(), VERTS_PER_BOX);
        // Hoehe deckt Y 0..3 ab.
        let (min, max) = mesh.bounds();
        assert!((min[1]).abs() < 1e-5 && (max[1] - 3.0).abs() < 1e-5);
    }

    #[test]
    fn degenerierte_wand_erzeugt_nichts() {
        // Start == Ende -> keine Richtung -> uebersprungen (kein Absturz).
        let w = WallInput {
            start: [1.0, 1.0],
            end: [1.0, 1.0],
            thickness: 0.2,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
        };
        let mesh = build_walls_mesh(&[w]);
        assert_eq!(mesh.vertex_count(), 0);
        assert!(mesh.indices.is_empty());
    }

    // --- Kamera / Matrizen ----------------------------------------------------

    #[test]
    fn look_at_setzt_kamera_ins_zentrum() {
        use super::math::{transform_point, view_matrix};
        use super::types::Camera;
        let cam = Camera {
            eye: [0.0, 0.0, 5.0],
            target: [0.0, 0.0, 0.0],
            up: [0.0, 1.0, 0.0],
            ..Camera::default()
        };
        let v = view_matrix(&cam);
        // Das Blickziel (Ursprung) liegt im View-Raum vor der Kamera bei z=-5
        // (Kamera schaut entlang -Z).
        let p = transform_point(&v, [0.0, 0.0, 0.0]);
        assert!((p[0]).abs() < 1e-5 && (p[1]).abs() < 1e-5);
        assert!((p[2] + 5.0).abs() < 1e-5, "Ziel bei view-z = -5");
    }

    #[test]
    fn perspektive_klemmt_z_in_null_bis_eins() {
        use super::math::{perspective, transform_point};
        let m = perspective(60.0_f32.to_radians(), 1.0, 1.0, 100.0);
        // Punkt auf der Nah-Ebene (view-z = -near) -> clip-z/w == 0.
        let near = transform_point(&m, [0.0, 0.0, -1.0]);
        assert!((near[2] / near[3]).abs() < 1e-4, "Nah-Ebene -> z=0");
        // Punkt auf der Fern-Ebene (view-z = -far) -> clip-z/w == 1.
        let far = transform_point(&m, [0.0, 0.0, -100.0]);
        assert!(((far[2] / far[3]) - 1.0).abs() < 1e-4, "Fern-Ebene -> z=1");
    }

    #[test]
    fn orbit_eye_haelt_abstand_ein() {
        use super::math::orbit_eye;
        let target = [1.0, 0.0, 2.0];
        let e = orbit_eye(target, 0.7, 0.4, 10.0);
        let d = ((e[0] - target[0]).powi(2)
            + (e[1] - target[1]).powi(2)
            + (e[2] - target[2]).powi(2))
        .sqrt();
        assert!((d - 10.0).abs() < 1e-4, "Abstand == dist");
    }

    #[test]
    fn presets_setzen_projektionsart() {
        use super::math::preset_camera;
        use super::types::{CameraPreset, Projection};
        let t = [0.0, 0.0, 0.0];
        assert_eq!(
            preset_camera(CameraPreset::Top, t, 10.0).projection,
            Projection::Orthographic
        );
        assert_eq!(
            preset_camera(CameraPreset::Front, t, 10.0).projection,
            Projection::Orthographic
        );
        assert_eq!(
            preset_camera(CameraPreset::Side, t, 10.0).projection,
            Projection::Orthographic
        );
        assert_eq!(
            preset_camera(CameraPreset::Iso, t, 10.0).projection,
            Projection::Perspective
        );
        assert_eq!(
            preset_camera(CameraPreset::Persp, t, 10.0).projection,
            Projection::Perspective
        );
        // Top blickt von oben herab: eye.y > target.y.
        let top = preset_camera(CameraPreset::Top, t, 10.0);
        assert!(top.eye[1] > t[1], "Top-Kamera ueber dem Ziel");
    }

    /// Validiert die WGSL-Quelle headless ueber naga (Parser + Validator) — faengt
    /// Syntax-/Typfehler ohne GPU/Display ab. Nur mit Feature "render", weil naga
    /// sonst nicht mitgebaut wird (Muster: render2d).
    #[cfg(feature = "render")]
    #[test]
    fn wgsl_quelle_ist_valide() {
        use naga::valid::{Capabilities, ValidationFlags, Validator};
        let src = super::shaders::MESH_WGSL;
        let module = naga::front::wgsl::parse_str(src)
            .unwrap_or_else(|e| panic!("mesh: WGSL-Parse-Fehler: {e:?}"));
        let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
        validator
            .validate(&module)
            .unwrap_or_else(|e| panic!("mesh: WGSL-Validierung fehlgeschlagen: {e:?}"));
    }
}
