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

pub mod edges;
pub mod grid;
pub mod math;
pub mod mesh;
pub(crate) mod openings;
pub mod section;
pub mod section_boolean;
pub mod section_fill;
pub mod shaders;
pub mod types;

#[cfg(feature = "render")]
pub mod gpu;

// Browser-Bindings (wasm32 + WebGPU), nur mit Feature "web". Setzt "render" voraus
// (dieselbe GPU-Schicht wie das native Fenster), fuegt aber KEINE winit-Abhaengigkeit
// hinzu — die Canvas dient direkt als wgpu-Surface. Muster: render2d/src/web.rs.
#[cfg(feature = "web")]
pub mod web;

pub use math::{
    look_at, orbit_eye, orthographic, perspective, preset_camera, projection_matrix,
    view_matrix, view_projection, Mat4,
};
pub use mesh::{
    append_context_mesh, build_model_mesh, build_scene_mesh, build_walls_mesh,
    build_walls_mesh_textured, extrude_slab, extrude_wall, textured_from_mesh, triangulate,
};
pub use section::{
    cut_section, ComponentKind, ComponentRef, CutPolygon, SectionEdge, SectionOutput, SectionPlane,
};
pub use types::{
    Camera, CameraPreset, Mesh, MeshInput, MeshKind, Point2, Projection, Rgb, SlabInput,
    TexturedMesh, WallInput, FLOATS_PER_VERTEX, TEXTURED_FLOATS_PER_VERTEX,
};

// --- Tests: Mesh-Erzeugung (Muster wie render2d/tessellate) -------------------

#[cfg(test)]
mod tests {
    use super::mesh::{
        build_free_wall_end_caps, build_scene_mesh_textured, build_walls_mesh,
        build_walls_mesh_textured, extrude_wall, INDICES_PER_BOX, VERTS_PER_BOX,
    };
    use super::section_fill::CAP_FLOATS_PER_VERTEX;
    use super::types::{
        Hatch, Hole, Mesh, Opening, WallInput, WallLayer, FLOATS_PER_VERTEX,
        TEXTURED_FLOATS_PER_VERTEX,
    };

    /// Bequemer Bau einer achsparallelen Wand entlang +X.
    fn wall_x(len: f32, thickness: f32, height: f32) -> WallInput {
        WallInput {
            start: [0.0, 0.0],
            end: [len, 0.0],
            thickness,
            height,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
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
    fn texturierter_pfad_ist_geometrisch_deckungsgleich_mit_shaded() {
        // Der texturierte Wand-Pfad (`build_walls_mesh_textured`, [pos,normal,uv])
        // muss GEOMETRISCH bitgleich zum Alt-Pfad (`build_walls_mesh`,
        // [pos,normal,color]) sein: gleiche Vertex-/Index-Zahl und -Reihenfolge,
        // identische Positionen und Normalen. Nur der letzte Kanal (Farbe -> UV)
        // unterscheidet sich. So ist belegt, dass der additive UV-Kanal den
        // Alt-Pfad nicht beruehrt.
        let walls = [wall_x(3.0, 0.2, 2.5)];
        let shaded = build_walls_mesh(&walls);
        let tex = build_walls_mesh_textured(&walls);
        assert_eq!(tex.indices, shaded.indices, "Index-Puffer identisch");
        assert_eq!(
            tex.vertex_count(),
            shaded.vertex_count(),
            "gleiche Vertex-Zahl"
        );
        for i in 0..shaded.vertex_count() {
            let sb = i * FLOATS_PER_VERTEX;
            let tb = i * TEXTURED_FLOATS_PER_VERTEX;
            // Position (0..3) und Normale (3..6) bitgleich uebernommen.
            for k in 0..6 {
                assert_eq!(
                    shaded.verts[sb + k],
                    tex.verts[tb + k],
                    "Vertex {i} Kanal {k}: pos/normal muss identisch sein"
                );
            }
        }
    }

    #[test]
    fn texturierte_uv_ist_weltmassstaeblich() {
        // UV-Massstab: `u`/`v` in Metern (1 Kachel = 1 m). Fuer eine Wand entlang +X
        // liegt die +Z-Mantelflaeche bei Normale (0,0,1); dort ist die Tangente
        // t=(-n.z,0,n.x)=(-1,0,0), also u = -x und v = Hoehe. Die Deckflaeche
        // (Normale +Y) projiziert auf u=x, v=z. Wir pruefen, dass es UEBERHAUPT
        // Vertices mit v == Wandhoehe (2.5) bzw. v == 0 gibt (Hoehe wandert als v
        // mit) — belegt den weltmassstaeblichen Hoehen-Kanal.
        let tex = build_walls_mesh_textured(&[wall_x(3.0, 0.2, 2.5)]);
        let n = tex.vertex_count();
        let mut saw_top = false;
        let mut saw_bottom = false;
        for i in 0..n {
            let b = i * TEXTURED_FLOATS_PER_VERTEX;
            let ny = tex.verts[b + 4];
            let v = tex.verts[b + 7];
            // Nur Mantelflaechen (ny ~ 0) tragen die Hoehe als v.
            if ny.abs() < 0.5 {
                if (v - 2.5).abs() < 1e-5 {
                    saw_top = true;
                }
                if v.abs() < 1e-5 {
                    saw_bottom = true;
                }
            }
        }
        assert!(saw_top, "Mantel-Vertex mit v == Wandhoehe (2.5 m) erwartet");
        assert!(saw_bottom, "Mantel-Vertex mit v == 0 (Sockel) erwartet");
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

    /// `wall_x` mit gesetzter Bauteil-Schraffur (Voraussetzung fuer die Kappen).
    fn wall_x_hatched(len: f32, thickness: f32, height: f32) -> WallInput {
        WallInput {
            hatch: Some(Hatch { pattern: 3, angle: 45.0, scale: 1.0, line_weight: 0.13 }),
            ..wall_x(len, thickness, height)
        }
    }

    #[test]
    fn isolierte_wand_ohne_hatch_bekommt_keine_kappen() {
        // Bestehende Test-Fixtures (kein `hatch`) bleiben unangetastet: keine
        // Kappen-Geometrie, unabhaengig davon, dass beide Enden frei sind.
        let caps = build_free_wall_end_caps(&[wall_x(3.0, 0.2, 2.5)]);
        assert!(caps.is_empty());
    }

    #[test]
    fn isolierte_wand_mit_hatch_bekommt_kappen_an_beiden_freien_enden() {
        // Eine einzelne Wand hat KEINE Nachbarn -> beide Achsenenden sind frei ->
        // je Ende eine Schraffur-Kappe (1 Schicht x 2 Dreiecke x 3 Vertices = 6
        // Vertices je Ende, 12 insgesamt).
        let caps = build_free_wall_end_caps(&[wall_x_hatched(3.0, 0.2, 2.5)]);
        assert_eq!(caps.len() / CAP_FLOATS_PER_VERTEX, 12);
        // Jeder Kappen-Vertex traegt die Schraffur-Parameter (Muster 3 = crosshatch).
        for v in caps.chunks_exact(CAP_FLOATS_PER_VERTEX) {
            assert_eq!(v[5], 3.0, "pattern");
            assert!((v[6] - 45.0_f32.to_radians()).abs() < 1e-5, "angle_rad");
        }
    }

    #[test]
    fn verbundene_wandenden_bekommen_keine_kappe_dort() {
        // Zwei Waende treffen sich rechtwinklig bei (3,0) -> DIESES Ende ist bei
        // beiden Waenden NICHT frei (Gehrung/Anschluss), die beiden anderen
        // (freien) Enden bekommen weiterhin je eine Kappe -> 2 Kappen gesamt
        // (nicht 4), macht 12 Vertices statt 24.
        let a = wall_x_hatched(3.0, 0.2, 2.5); // (0,0) frei .. (3,0) verbunden
        let b = WallInput {
            start: [3.0, 0.0],
            end: [3.0, 4.0],
            ..wall_x_hatched(4.0, 0.2, 2.5) // (3,0) verbunden .. (3,4) frei
        };
        let caps = build_free_wall_end_caps(&[a, b]);
        assert_eq!(caps.len() / CAP_FLOATS_PER_VERTEX, 12, "nur die 2 freien Enden -> 2 Kappen");
    }

    #[test]
    fn t_stoss_bekommt_ebenfalls_keine_kappe_am_knoten() {
        // Drei Waende treffen sich am selben Punkt (T-Stoss, Gehrung bleibt
        // rechtwinklig, s. compute_wall_miters) -> trotzdem gilt der Knoten als
        // "beruehrt", KEINE der drei dortigen Enden bekommt eine Kappe.
        let a = wall_x_hatched(3.0, 0.2, 2.5); // endet bei (3,0)
        let b = WallInput { start: [3.0, 0.0], end: [3.0, 4.0], ..wall_x_hatched(4.0, 0.2, 2.5) };
        let c = WallInput { start: [3.0, 0.0], end: [6.0, 0.0], ..wall_x_hatched(3.0, 0.2, 2.5) };
        let caps = build_free_wall_end_caps(&[a, b, c]);
        // Freie Enden: a.start(0,0), b.end(3,4), c.end(6,0) -> 3 Kappen (nicht 6).
        assert_eq!(caps.len() / CAP_FLOATS_PER_VERTEX, 18);
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
                openings: vec![],
                layers: None,
                holes: vec![],
                material_index: None,
                hatch: None,
                cut: None,
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
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
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
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        };
        let mesh = build_walls_mesh(&[w]);
        assert_eq!(mesh.vertex_count(), 0);
        assert!(mesh.indices.is_empty());
    }

    // --- Oeffnungen (Fenster/Tueren) in der Vollkoerper-Extrusion -------------

    #[test]
    fn fenster_erzeugt_pfeiler_bruestung_sturz_und_sichtbare_luecke() {
        // Wand entlang +X, Laenge 4, ein Fenster bei x in [1.5,2.5], Bruestung
        // 0.9, Kopfhoehe 2.1 (< Wandhoehe 2.5) -> vier Teil-Quader: Pfeiler
        // 0..1.5 (voll), Bruestung 1.5..2.5 (0..0.9), Sturz 1.5..2.5 (2.1..2.5),
        // Pfeiler 2.5..4 (voll). Kein Vollkoerper mehr ueber die Oeffnung.
        let mut w = wall_x(4.0, 0.2, 2.5);
        w.openings = vec![Opening {
            from: 1.5,
            to: 2.5,
            sill: 0.9,
            height: 1.2,
        }];
        let mesh = build_walls_mesh(&[w]);
        assert_eq!(
            mesh.vertex_count(),
            4 * VERTS_PER_BOX,
            "vier Teil-Quader (2 Pfeiler + Bruestung + Sturz)"
        );
        assert_eq!(mesh.indices.len(), 4 * INDICES_PER_BOX);
        let max_idx = *mesh.indices.iter().max().unwrap();
        assert!((max_idx as usize) < mesh.vertex_count());

        // Aussenmasse bleiben unveraendert (Pfeiler+Bruestung+Sturz decken
        // zusammen wieder die volle Bounding-Box ab).
        let (min, max) = mesh.bounds();
        assert!((min[0]).abs() < 1e-5 && (max[0] - 4.0).abs() < 1e-5);
        assert!((min[1]).abs() < 1e-5 && (max[1] - 2.5).abs() < 1e-5);

        // Sichtbare Luecke: kein Vertex liegt (mit Sicherheitsabstand) im
        // Oeffnungs-Loch selbst (x in (1.5,2.5) UND y in (0.9,2.1)) — dort darf
        // keine Mesh-Flaeche mehr existieren.
        let margin = 0.05;
        let n = mesh.vertex_count();
        for i in 0..n {
            let (p, _) = vert(&mesh, i);
            let inside_hole = p[0] > 1.5 + margin
                && p[0] < 2.5 - margin
                && p[1] > 0.9 + margin
                && p[1] < 2.1 - margin;
            assert!(!inside_hole, "Vertex {i} bei {p:?} liegt im Fensterloch");
        }
    }

    #[test]
    fn tuer_erreicht_den_boden_keine_bruestung() {
        // Tuer (sill == 0.0) reicht bis zum Boden -> keine Bruestung, nur zwei
        // volle Pfeiler + ein Sturz-Quader ueber der Tuer (drei Teil-Quader).
        let mut w = wall_x(4.0, 0.2, 2.5);
        w.openings = vec![Opening {
            from: 1.0,
            to: 1.8,
            sill: 0.0,
            height: 2.1,
        }];
        let mesh = build_walls_mesh(&[w]);
        assert_eq!(
            mesh.vertex_count(),
            3 * VERTS_PER_BOX,
            "zwei Pfeiler + ein Sturz, keine Bruestung"
        );
        assert_eq!(mesh.indices.len(), 3 * INDICES_PER_BOX);

        // Im Tuerbereich (x in (1.0,1.8)) darf unterhalb der Kopfhoehe (2.1)
        // keine Geometrie liegen -> jeder Vertex dort liegt auf/ueber dem Sturz.
        let margin = 0.05;
        let n = mesh.vertex_count();
        for i in 0..n {
            let (p, _) = vert(&mesh, i);
            let in_door_span = p[0] > 1.0 + margin && p[0] < 1.8 - margin;
            if in_door_span {
                assert!(
                    p[1] > 2.1 - 1e-4,
                    "Vertex {i} bei {p:?} liegt unter der Tuer-Kopfhoehe"
                );
            }
        }
    }

    #[test]
    fn oeffnung_ausserhalb_der_wandlaenge_erzeugt_vollkoerper() {
        // Oeffnung komplett ausserhalb [0,length] -> Regressionsfall: ein
        // einzelner Vollkoerper-Quader wie ohne Oeffnungen.
        let mut w = wall_x(4.0, 0.2, 2.5);
        w.openings = vec![Opening {
            from: 5.0,
            to: 6.0,
            sill: 0.9,
            height: 1.2,
        }];
        let mesh = build_walls_mesh(&[w]);
        assert_eq!(mesh.vertex_count(), VERTS_PER_BOX);
        assert_eq!(mesh.indices.len(), INDICES_PER_BOX);
    }

    // --- Echte Loecher in EINEM Wandkoerper (WallInput::holes) -----------------

    #[test]
    fn zwei_versetzte_ueberlappende_loecher_in_einem_koerper() {
        // KERNFALL: EINE Wand (Laenge 4, Hoehe 2.5) mit ZWEI Loechern, deren
        // Achsen-Intervalle sich UEBERLAPPEN, aber auf UNTERSCHIEDLICHER Hoehe
        // liegen — Fenster A u=[1.0,2.0] z=[0.9,2.1], Fenster B u=[1.5,2.5]
        // z=[0.3,0.7]. Das kann die Segment-Zerlegung nicht abbilden; als Loecher
        // in EINEM Koerper muss es sauber zerfallen (keine Geometrie in den
        // Loechern, Aussenmasse erhalten, beide Laibungen vollstaendig).
        let mut w = wall_x(4.0, 0.2, 2.5);
        w.holes = vec![
            Hole { from: 1.0, to: 2.0, z_bottom: 0.9, z_top: 2.1 },
            Hole { from: 1.5, to: 2.5, z_bottom: 0.3, z_top: 0.7 },
        ];
        let mesh = build_walls_mesh(&[w]);

        // Mehr als ein Vollkoerper (Loecher fuegen Teilrechtecke + Laibungen hinzu).
        assert!(mesh.vertex_count() > VERTS_PER_BOX);
        // Index-Integritaet.
        let max_idx = *mesh.indices.iter().max().unwrap();
        assert!((max_idx as usize) < mesh.vertex_count());

        // Aussenmasse unveraendert (die soliden Teilrechtecke decken den Rand ab).
        let (min, max) = mesh.bounds();
        assert!((min[0]).abs() < 1e-5 && (max[0] - 4.0).abs() < 1e-5, "u 0..4");
        assert!((min[1]).abs() < 1e-5 && (max[1] - 2.5).abs() < 1e-5, "z 0..2.5");
        assert!((min[2] + 0.1).abs() < 1e-5 && (max[2] - 0.1).abs() < 1e-5, "Dicke +/-0.1");

        // KEIN Vertex liegt (mit Sicherheitsabstand) im Inneren eines der Loecher.
        let holes = [(1.0f32, 2.0f32, 0.9f32, 2.1f32), (1.5, 2.5, 0.3, 0.7)];
        let m = 0.05;
        let n = mesh.vertex_count();
        for i in 0..n {
            let (p, _) = vert(&mesh, i);
            for (a0, a1, zb, zt) in holes {
                let inside =
                    p[0] > a0 + m && p[0] < a1 - m && p[1] > zb + m && p[1] < zt - m;
                assert!(!inside, "Vertex {i} bei {p:?} liegt im Loch [{a0},{a1}]x[{zb},{zt}]");
            }
        }

        // Beide Loecher besitzen ihre vier inneren Laibungen: fuer jede Loch-Kante
        // muss mindestens ein Vertex GENAU auf der Kante (in u bzw. z) UND im
        // jeweils anderen Loch-Intervall liegen (die Laibungsflaeche).
        let has_vert = |pred: &dyn Fn([f32; 3]) -> bool| (0..n).any(|i| pred(vert(&mesh, i).0));
        for (a0, a1, zb, zt) in holes {
            // linke/rechte Laibung: Vertex bei u==a0 bzw. u==a1, z im Loch.
            assert!(
                has_vert(&|p| (p[0] - a0).abs() < 1e-4 && p[1] > zb - 1e-4 && p[1] < zt + 1e-4),
                "linke Laibung fehlt fuer Loch [{a0},{a1}]"
            );
            assert!(
                has_vert(&|p| (p[0] - a1).abs() < 1e-4 && p[1] > zb - 1e-4 && p[1] < zt + 1e-4),
                "rechte Laibung fehlt fuer Loch [{a0},{a1}]"
            );
            // untere/obere Laibung: Vertex bei z==zb bzw. z==zt, u im Loch.
            assert!(
                has_vert(&|p| (p[1] - zb).abs() < 1e-4 && p[0] > a0 - 1e-4 && p[0] < a1 + 1e-4),
                "untere Laibung fehlt fuer Loch [{a0},{a1}]"
            );
            assert!(
                has_vert(&|p| (p[1] - zt).abs() < 1e-4 && p[0] > a0 - 1e-4 && p[0] < a1 + 1e-4),
                "obere Laibung fehlt fuer Loch [{a0},{a1}]"
            );
        }
    }

    #[test]
    fn tuer_loch_bis_zum_boden_ohne_untere_laibung() {
        // Tuer-Loch reicht bis zum Boden (z_bottom == base_elevation 0): die
        // untere Kante liegt am Wandrand -> KEINE untere Laibung, stattdessen eine
        // Luecke im Boden-Streifen. Unter der Kopfhoehe (z_top 2.1) darf im
        // Tuerbereich keine Geometrie liegen.
        let mut w = wall_x(4.0, 0.2, 2.5);
        w.holes = vec![Hole { from: 1.0, to: 1.8, z_bottom: 0.0, z_top: 2.1 }];
        let mesh = build_walls_mesh(&[w]);
        let n = mesh.vertex_count();
        let m = 0.05;
        for i in 0..n {
            let (p, _) = vert(&mesh, i);
            let in_span = p[0] > 1.0 + m && p[0] < 1.8 - m;
            if in_span {
                assert!(
                    p[1] < m || p[1] > 2.1 - 1e-4,
                    "Vertex {i} bei {p:?} liegt unter der Tuer-Kopfhoehe im Loch"
                );
            }
        }
    }

    // --- Ecken-Verschneidung (Gehrung) -----------------------------------------

    #[test]
    fn rechtwinklige_ecke_wird_gehrt_kein_ueberstand_kein_spalt() {
        // Zwei Waende entlang +X bzw. +Y, die sich exakt im Ursprung treffen
        // (L-Ecke, Dicke 0.4 -> Halbdicke 0.2). Ohne Gehrung ueberlappen sich die
        // Baender im Eckbereich (jede Wand ragt um die Halbdicke der jeweils
        // anderen ueber den Knoten hinaus); MIT Gehrung muessen alle Vertices IM
        // Eckbereich exakt auf der 45-Grad-Gehrungslinie |x| == |z| liegen —
        // weder darueber hinaus (Ueberstand) noch darunter (Spalt).
        let a = WallInput {
            start: [0.0, 0.0],
            end: [3.0, 0.0],
            thickness: 0.4,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        };
        let b = WallInput {
            start: [0.0, 0.0],
            end: [0.0, 3.0],
            thickness: 0.4,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        };
        let mesh = build_walls_mesh(&[a, b]);
        assert_eq!(mesh.vertex_count(), 2 * VERTS_PER_BOX, "weiterhin zwei Quader");

        // Jeder Vertex nahe dem Knoten (innerhalb der doppelten Halbdicke) muss
        // auf der Gehrungslinie liegen: world.x und world.z (== Grundriss-y)
        // betragsgleich (45-Grad-Winkelhalbierende der beiden Achsen).
        let near_corner_margin = 0.5; // deutlich groesser als die Halbdicke 0.2
        let n = mesh.vertex_count();
        let mut checked_any = false;
        for i in 0..n {
            let (p, _) = vert(&mesh, i);
            if p[0].abs() < near_corner_margin && p[2].abs() < near_corner_margin {
                checked_any = true;
                assert!(
                    (p[0].abs() - p[2].abs()).abs() < 1e-4,
                    "Eck-Vertex {i} bei {p:?} liegt nicht auf der 45-Grad-Gehrungslinie"
                );
            }
        }
        assert!(checked_any, "Test hat keinen Eck-Vertex gefunden (Setup falsch)");

        // Kein Vertex ragt ueber die Gehrungslinie hinaus: fuer Punkte mit x>0
        // UND z>0 (im "inneren" Quadranten der Ecke) muss min(x,z) <= Halbdicke
        // gelten -- sonst wuerde die Wand ueber die andere hinausragen.
        for i in 0..n {
            let (p, _) = vert(&mesh, i);
            if p[0] > 1e-4 && p[2] > 1e-4 && p[0] < near_corner_margin && p[2] < near_corner_margin {
                assert!(
                    p[0].min(p[2]) <= 0.2 + 1e-4,
                    "Vertex {i} bei {p:?} ragt ueber die Gehrung hinaus"
                );
            }
        }
    }

    #[test]
    fn freies_wandende_bleibt_rechtwinklig() {
        // Eine einzelne Wand ohne Nachbarn: keine Gehrung, Enden bleiben exakt
        // senkrecht zur Achse -> identisch zum Einzel-Wand-Regressionsfall.
        let mesh = build_walls_mesh(&[wall_x(3.0, 0.2, 2.5)]);
        let (min, max) = mesh.bounds();
        assert!((min[0]).abs() < 1e-5 && (max[0] - 3.0).abs() < 1e-5);
    }

    #[test]
    fn t_stoss_bleibt_rechtwinklig() {
        // Drei Wandenden treffen sich im selben Knoten (T-Stoss) -> gemaess
        // Moduldoc/`joins.ts` bewusst NICHT gehrt (mehrdeutig), alle drei bleiben
        // rechtwinklig. Regressions-Absicherung: keine Panik, stabile Zaehlung.
        let mk = |s: [f32; 2], e: [f32; 2]| WallInput {
            start: s,
            end: e,
            thickness: 0.2,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        };
        let walls = vec![
            mk([0.0, 0.0], [3.0, 0.0]),
            mk([0.0, 0.0], [0.0, 3.0]),
            mk([0.0, 0.0], [-3.0, 0.0]),
        ];
        let mesh = build_walls_mesh(&walls);
        assert_eq!(mesh.vertex_count(), 3 * VERTS_PER_BOX);
    }

    #[test]
    fn zwei_geschosse_mit_gleichem_grundriss_verschneiden_sich_nicht_ueber_geschosse() {
        // EG (Hoehe 0..2.5) und OG (Basis 2.5, Hoehe 2.5..5.0) mit identischem
        // L-Grundriss: die Hoehenbereiche BERUEHREN sich nur (bei 2.5), ueber-
        // lappen aber nicht -> jedes Geschoss wird NUR gegen sein eigenes
        // Pendant gehrt, nicht ueber die Geschossgrenze hinweg. Absicherung:
        // beide Geschosse zusammen liefern exakt dieselbe Gehrung wie ein
        // einzelnes Geschoss fuer sich (Vertex-Zaehlung + Eck-Vertices je
        // Geschoss weiterhin auf der 45-Grad-Linie relativ zu SEINER Basis).
        let mk = |s: [f32; 2], e: [f32; 2], base: f32| WallInput {
            start: s,
            end: e,
            thickness: 0.4,
            height: 2.5,
            base_elevation: base,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        };
        let walls = vec![
            mk([0.0, 0.0], [3.0, 0.0], 0.0),
            mk([0.0, 0.0], [0.0, 3.0], 0.0),
            mk([0.0, 0.0], [3.0, 0.0], 2.5),
            mk([0.0, 0.0], [0.0, 3.0], 2.5),
        ];
        let mesh = build_walls_mesh(&walls);
        assert_eq!(mesh.vertex_count(), 4 * VERTS_PER_BOX);
        let n = mesh.vertex_count();
        for i in 0..n {
            let (p, _) = vert(&mesh, i);
            if p[0].abs() < 0.5 && p[2].abs() < 0.5 {
                assert!(
                    (p[0].abs() - p[2].abs()).abs() < 1e-4,
                    "Eck-Vertex {i} bei {p:?} (Geschoss-Basis {}) nicht auf der Gehrung",
                    p[1]
                );
            }
        }
    }

    // --- Schichten (WallInput::layers) -----------------------------------------

    #[test]
    fn ohne_layers_entsteht_weiterhin_ein_vollkoerper() {
        // Regressionsfall: `layers: None` extrudiert exakt wie zuvor.
        let mesh = build_walls_mesh(&[wall_x(3.0, 0.2, 2.5)]);
        assert_eq!(mesh.vertex_count(), VERTS_PER_BOX);
    }

    #[test]
    fn layer_wand_liefert_ein_prisma_je_schicht() {
        // Drei Schichten (Putz/Daemmung/Mauerwerk) -> drei eigenstaendige
        // Quader, je VERTS_PER_BOX Vertices, ohne Oeffnungen.
        let mut w = wall_x(3.0, 0.3, 2.5);
        w.layers = Some(vec![
            WallLayer { thickness: 0.02, color: [1.0, 1.0, 1.0] },
            WallLayer { thickness: 0.18, color: [0.9, 0.85, 0.7] },
            WallLayer { thickness: 0.10, color: [0.6, 0.3, 0.2] },
        ]);
        let mesh = build_walls_mesh(&[w]);
        assert_eq!(mesh.vertex_count(), 3 * VERTS_PER_BOX);
        assert_eq!(mesh.indices.len(), 3 * INDICES_PER_BOX);

        // Die Schichten decken zusammen exakt die Gesamtdicke (0.3, Z in
        // -0.15..0.15) lueckenlos und ueberlappungsfrei ab.
        let (min, max) = mesh.bounds();
        assert!((min[2] + 0.15).abs() < 1e-4, "min z == -0.15");
        assert!((max[2] - 0.15).abs() < 1e-4, "max z == 0.15");

        // Jede Schicht-Farbe taucht in den Vertex-Farben auf (Layer wurden
        // tatsaechlich mit ihrer eigenen Farbe extrudiert, nicht der Wandfarbe).
        let n = mesh.vertex_count();
        let has_color = |target: [f32; 3]| {
            (0..n).any(|i| {
                let b = i * FLOATS_PER_VERTEX;
                let c = [mesh.verts[b + 6], mesh.verts[b + 7], mesh.verts[b + 8]];
                (c[0] - target[0]).abs() < 1e-6
                    && (c[1] - target[1]).abs() < 1e-6
                    && (c[2] - target[2]).abs() < 1e-6
            })
        };
        assert!(has_color([1.0, 1.0, 1.0]), "Putz-Farbe fehlt");
        assert!(has_color([0.9, 0.85, 0.7]), "Daemmungs-Farbe fehlt");
        assert!(has_color([0.6, 0.3, 0.2]), "Mauerwerk-Farbe fehlt");
    }

    #[test]
    fn layer_ecke_wird_ebenfalls_gehrt() {
        // Zwei mehrschichtige Waende an einer Ecke: JEDE Schicht nutzt dasselbe
        // gehrte Fussabdruck-Band -> auch hier landen alle Eck-Vertices exakt
        // auf der 45-Grad-Gehrungslinie (analog zum Vollkoerper-Test oben).
        let layers = || {
            Some(vec![
                WallLayer { thickness: 0.15, color: [0.9, 0.85, 0.7] },
                WallLayer { thickness: 0.15, color: [0.6, 0.3, 0.2] },
            ])
        };
        let a = WallInput {
            start: [0.0, 0.0],
            end: [3.0, 0.0],
            thickness: 0.3,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: layers(),
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        };
        let mut b = a.clone();
        b.end = [0.0, 3.0];

        let mesh = build_walls_mesh(&[a, b]);
        let n = mesh.vertex_count();
        assert_eq!(n, 4 * VERTS_PER_BOX, "2 Waende x 2 Schichten");
        for i in 0..n {
            let (p, _) = vert(&mesh, i);
            if p[0].abs() < 0.4 && p[2].abs() < 0.4 {
                assert!(
                    (p[0].abs() - p[2].abs()).abs() < 1e-4,
                    "Layer-Eck-Vertex {i} bei {p:?} nicht auf der Gehrung"
                );
            }
        }
    }

    // --- Deckenplatten (extrudierte Polygone) ---------------------------------

    use super::mesh::{build_model_mesh, extrude_slab, triangulate};
    use super::types::SlabInput;

    /// Quadratischer Decken-Umriss (CCW) mit Kantenlaenge `s`, Ecke im Ursprung.
    fn square_slab(s: f32, z_bottom: f32, z_top: f32) -> SlabInput {
        SlabInput {
            outline: vec![[0.0, 0.0], [s, 0.0], [s, s], [0.0, s]],
            z_bottom,
            z_top,
            color: [0.86, 0.86, 0.88],
            hatch: None,
            cut: None,
        }
    }

    #[test]
    fn triangulate_quadrat_gibt_zwei_dreiecke() {
        let tris = triangulate(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
        assert_eq!(tris.len(), 6, "Quadrat -> 2 Dreiecke = 6 Indizes");
    }

    #[test]
    fn triangulate_cw_umriss_ebenfalls_zwei_dreiecke() {
        // CW-Umriss (negative Flaeche) muss genauso trianguliert werden.
        let tris = triangulate(&[[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]]);
        assert_eq!(tris.len(), 6);
    }

    #[test]
    fn slab_deckel_und_boden_und_mantel() {
        // Quadratische Platte: Deckel (2 Tri) + Boden (2 Tri) + 4 Mantel-Quads
        // (je 2 Tri) = 4 + 8 = 12 Dreiecke = 36 Vertices (je Tri eigene Vertices).
        let mut mesh = Mesh::default();
        extrude_slab(&mut mesh, &square_slab(4.0, 2.4, 2.65));
        assert_eq!(mesh.triangle_count(), 12, "2+2 Kappen + 8 Mantel");
        assert_eq!(mesh.vertex_count(), 36);
        // Z-Ausdehnung deckt die Deckendicke ab.
        let (min, max) = mesh.bounds();
        assert!((min[1] - 2.4).abs() < 1e-5, "UK 2.4");
        assert!((max[1] - 2.65).abs() < 1e-5, "OK 2.65");
    }

    #[test]
    fn slab_deckel_normale_zeigt_nach_oben_boden_nach_unten() {
        let mut mesh = Mesh::default();
        extrude_slab(&mut mesh, &square_slab(4.0, 0.0, 0.25));
        // Fuer jedes Vertex mit y==0.25 (Deckel) muss die Normale +Y sein, fuer
        // y==0.0 (Boden) −Y. Mantel-Vertices haben n.y ≈ 0.
        let n = mesh.vertex_count();
        for i in 0..n {
            let b = i * FLOATS_PER_VERTEX;
            let py = mesh.verts[b + 1];
            let ny = mesh.verts[b + 4];
            if (py - 0.25).abs() < 1e-6 && (mesh.verts[b + 3]).abs() < 1e-6 && (mesh.verts[b + 5]).abs() < 1e-6 {
                assert!((ny - 1.0).abs() < 1e-5, "Deckel-Normale +Y");
            }
        }
    }

    #[test]
    fn slab_mantel_normalen_zeigen_nach_aussen() {
        // Zentriertes Quadrat um den Ursprung: jede Mantel-Normale muss vom
        // Zentrum weg zeigen.
        let slab = SlabInput {
            outline: vec![[-2.0, -2.0], [2.0, -2.0], [2.0, 2.0], [-2.0, 2.0]],
            z_bottom: 0.0,
            z_top: 0.3,
            color: [0.8, 0.8, 0.8],
            hatch: None,
            cut: None,
        };
        let mut mesh = Mesh::default();
        extrude_slab(&mut mesh, &slab);
        let center = [0.0f32, 0.15, 0.0];
        let n = mesh.vertex_count();
        for i in 0..n {
            let b = i * FLOATS_PER_VERTEX;
            let p = [mesh.verts[b], mesh.verts[b + 1], mesh.verts[b + 2]];
            let nor = [mesh.verts[b + 3], mesh.verts[b + 4], mesh.verts[b + 5]];
            let out = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
            let d = out[0] * nor[0] + out[1] * nor[1] + out[2] * nor[2];
            assert!(d >= -1e-4, "Vertex {i}: Normale zeigt nach innen (dot={d})");
        }
    }

    #[test]
    fn build_model_mesh_haengt_slabs_an_waende() {
        let wall = build_walls_mesh(&[wall_x(4.0, 0.2, 2.6)]);
        let model = build_model_mesh(&[wall_x(4.0, 0.2, 2.6)], &[square_slab(4.0, 2.6, 2.85)]);
        // Modell = Wand-Vertices + Slab-Vertices.
        assert_eq!(model.vertex_count(), wall.vertex_count() + 36);
        assert!(model.indices.len() > wall.indices.len());
    }

    #[test]
    fn entarteter_slab_erzeugt_nichts() {
        let mut mesh = Mesh::default();
        // <3 Ecken.
        extrude_slab(&mut mesh, &SlabInput { outline: vec![[0.0, 0.0], [1.0, 0.0]], z_bottom: 0.0, z_top: 0.2, color: [0.8, 0.8, 0.8], hatch: None, cut: None });
        assert_eq!(mesh.vertex_count(), 0);
        // Nullhoehe.
        extrude_slab(&mut mesh, &square_slab(4.0, 2.6, 2.6));
        assert_eq!(mesh.vertex_count(), 0);
    }

    // --- Rohe Kontext-Meshes (Terrain / importierte Volumen) ------------------

    use super::mesh::{append_context_mesh, build_scene_mesh};
    use super::types::{MeshInput, MeshKind};

    /// Ein flaches Dreieck auf Modell-Hoehe `z` (Modell x,y,z=Hoehe).
    fn flat_context_tri(z: f32, kind: MeshKind, color: Option<[f32; 3]>) -> MeshInput {
        MeshInput {
            positions: vec![0.0, 0.0, z, 1.0, 0.0, z, 0.0, 1.0, z],
            indices: vec![0, 1, 2],
            kind,
            color,
            material_index: None,
            vertex_colors: Vec::new(),
        }
    }

    #[test]
    fn context_mesh_ist_doppelseitig_und_mappt_hoehe_nach_y() {
        let mut mesh = Mesh::default();
        append_context_mesh(&mut mesh, &flat_context_tri(5.0, MeshKind::Terrain, None));
        // Ein Quell-Dreieck -> zwei (Vorder-/Rueckseite) = 6 Vertices.
        assert_eq!(mesh.triangle_count(), 2);
        assert_eq!(mesh.vertex_count(), 6);
        // model (x,y,z) -> world (x, z, y): die Hoehe z=5 liegt auf world.y=5.
        let (min, max) = mesh.bounds();
        assert!((min[1] - 5.0).abs() < 1e-5 && (max[1] - 5.0).abs() < 1e-5, "flach auf y=5");
        // Doppelseitig: eine Normale +Y, eine −Y.
        let mut saw_up = false;
        let mut saw_down = false;
        for i in 0..mesh.vertex_count() {
            let ny = mesh.verts[i * FLOATS_PER_VERTEX + 4];
            if ny > 0.5 {
                saw_up = true;
            }
            if ny < -0.5 {
                saw_down = true;
            }
        }
        assert!(saw_up && saw_down, "Vorder- UND Rueckseite (±Y)");
    }

    #[test]
    fn context_mesh_default_farbe_je_kind() {
        // Ohne explizite Farbe greift die kind-Default-Farbe (three.js mats.*).
        let mut mesh = Mesh::default();
        append_context_mesh(&mut mesh, &flat_context_tri(0.0, MeshKind::Terrain, None));
        let c = [mesh.verts[6], mesh.verts[7], mesh.verts[8]];
        assert_eq!(c, MeshKind::Terrain.default_color());
        // Explizite Farbe schlaegt den Default.
        let mut mesh2 = Mesh::default();
        append_context_mesh(&mut mesh2, &flat_context_tri(0.0, MeshKind::Imported, Some([0.1, 0.2, 0.3])));
        assert_eq!([mesh2.verts[6], mesh2.verts[7], mesh2.verts[8]], [0.1, 0.2, 0.3]);
    }

    #[test]
    fn context_mesh_pro_vertex_farbe_wird_uebernommen() {
        // Luftbild-Drape: jeder Vertex traegt eine eigene Farbe. Wird 1:1 an die
        // Ausgabe-Vertices durchgereicht (statt der Einzelfarbe).
        let mut mesh = Mesh::default();
        append_context_mesh(
            &mut mesh,
            &MeshInput {
                positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                indices: vec![0, 1, 2],
                kind: MeshKind::Terrain,
                color: None,
                material_index: None,
                vertex_colors: vec![
                    1.0, 0.0, 0.0, // Vertex 0 rot
                    0.0, 1.0, 0.0, // Vertex 1 gruen
                    0.0, 0.0, 1.0, // Vertex 2 blau
                ],
            },
        );
        // Vorderseite = erste 3 Vertices (Winding a,b,c): Farben 0,1,2.
        assert_eq!([mesh.verts[6], mesh.verts[7], mesh.verts[8]], [1.0, 0.0, 0.0]);
        assert_eq!([mesh.verts[15], mesh.verts[16], mesh.verts[17]], [0.0, 1.0, 0.0]);
        assert_eq!([mesh.verts[24], mesh.verts[25], mesh.verts[26]], [0.0, 0.0, 1.0]);
        // Zu kurzes vertex_colors-Array -> Einzelfarbe (kein Panic, kein Teilbezug).
        let mut mesh2 = Mesh::default();
        append_context_mesh(
            &mut mesh2,
            &MeshInput {
                positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                indices: vec![0, 1, 2],
                kind: MeshKind::Terrain,
                color: None,
                material_index: None,
                vertex_colors: vec![1.0, 0.0, 0.0], // nur 1 Vertex -> ignoriert
            },
        );
        assert_eq!(
            [mesh2.verts[6], mesh2.verts[7], mesh2.verts[8]],
            MeshKind::Terrain.default_color()
        );
    }

    #[test]
    fn kontext_mesh_materialindex_wandert_in_die_textured_layer() {
        // Daecher (und potenziell andere Kontext-Meshes) koennen jetzt einen
        // Material-Textur-Index tragen (`MeshInput::material_index`) — vorher
        // war er fuer ALLE Kontext-Meshes hart auf -1 (Schachbrett) gesetzt, der
        // Stil „Textured" konnte also nie eine echte Dachziegel-Textur zeigen.
        let m = MeshInput {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            indices: vec![0, 1, 2],
            kind: MeshKind::Extrusion,
            color: None,
            material_index: Some(2),
            vertex_colors: Vec::new(),
        };
        let tex = build_scene_mesh_textured(&[], &[], std::slice::from_ref(&m));
        assert!(!tex.layers.is_empty());
        assert!(tex.layers.iter().all(|&l| l == 2.0), "alle Vertices Ebene 2");

        // Ohne material_index bleibt der Fallback (-1 -> Schachbrett).
        let m2 = MeshInput { material_index: None, ..m };
        let tex2 = build_scene_mesh_textured(&[], &[], std::slice::from_ref(&m2));
        assert!(tex2.layers.iter().all(|&l| l == -1.0));
    }

    #[test]
    fn context_mesh_ueberspringt_kaputte_indizes_und_entartung() {
        let mut mesh = Mesh::default();
        // Index 9 out-of-range (nur 3 Vertices) -> Dreieck verworfen, kein Panic.
        append_context_mesh(
            &mut mesh,
            &MeshInput {
                positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                indices: vec![0, 1, 9],
                kind: MeshKind::Imported,
                color: None,
                material_index: None,
                vertex_colors: Vec::new(),
            },
        );
        assert_eq!(mesh.vertex_count(), 0);
        // Kollineares (entartetes) Dreieck -> keine Normale, verworfen.
        append_context_mesh(
            &mut mesh,
            &MeshInput {
                positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0],
                indices: vec![0, 1, 2],
                kind: MeshKind::Imported,
                color: None,
                material_index: None,
                vertex_colors: Vec::new(),
            },
        );
        assert_eq!(mesh.vertex_count(), 0);
    }

    #[test]
    fn build_scene_mesh_haengt_kontext_meshes_hinten_an() {
        let model = build_model_mesh(&[wall_x(4.0, 0.2, 2.6)], &[square_slab(4.0, 2.6, 2.85)]);
        let scene = build_scene_mesh(
            &[wall_x(4.0, 0.2, 2.6)],
            &[square_slab(4.0, 2.6, 2.85)],
            &[flat_context_tri(0.0, MeshKind::Terrain, None)],
        );
        // Szene = Modell (Wand+Slab) + 6 Kontext-Vertices (doppelseitiges Dreieck).
        assert_eq!(scene.vertex_count(), model.vertex_count() + 6);
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
            Projection::Orthographic
        );
        assert_eq!(
            preset_camera(CameraPreset::Persp, t, 10.0).projection,
            Projection::Perspective
        );
        // Top blickt von oben herab: eye.y > target.y.
        let top = preset_camera(CameraPreset::Top, t, 10.0);
        assert!(top.eye[1] > t[1], "Top-Kamera ueber dem Ziel");
    }

    #[test]
    fn presets_kardinal_back_left_sind_orthografisch_und_gegenrichtung() {
        use super::math::preset_camera;
        use super::types::{CameraPreset, Projection};
        let t = [0.0, 0.0, 0.0];
        let front = preset_camera(CameraPreset::Front, t, 10.0);
        let back = preset_camera(CameraPreset::Back, t, 10.0);
        let side = preset_camera(CameraPreset::Side, t, 10.0);
        let left = preset_camera(CameraPreset::Left, t, 10.0);
        assert_eq!(back.projection, Projection::Orthographic);
        assert_eq!(left.projection, Projection::Orthographic);
        // Back/Left sind exakt die Gegenrichtung von Front/Side (gespiegelte Achse).
        assert!((back.eye[2] - (-front.eye[2])).abs() < 1e-4, "Back == -Front (Z)");
        assert!((left.eye[0] - (-side.eye[0])).abs() < 1e-4, "Left == -Side (X)");
    }

    #[test]
    fn presets_iso_oktanten_sind_orthografisch_gleich_gross() {
        use super::math::preset_camera;
        use super::types::{CameraPreset, Projection};
        let t = [0.0, 0.0, 0.0];
        let dist = 10.0;
        let iso = preset_camera(CameraPreset::Iso, t, dist);
        let fl = preset_camera(CameraPreset::IsoFrontLeft, t, dist);
        let br = preset_camera(CameraPreset::IsoBackRight, t, dist);
        let bl = preset_camera(CameraPreset::IsoBackLeft, t, dist);
        for cam in [&iso, &fl, &br, &bl] {
            assert_eq!(cam.projection, Projection::Orthographic);
            // Alle vier oberen Iso-Oktanten haben denselben eye-target-Abstand
            // (Modell erscheint in jedem Oktanten gleich gross).
            let d = ((cam.eye[0] - t[0]).powi(2)
                + (cam.eye[1] - t[1]).powi(2)
                + (cam.eye[2] - t[2]).powi(2))
            .sqrt();
            assert!((d - dist).abs() < 1e-3, "Iso-Oktant-Abstand == dist");
            // Alle vier blicken von OBEN (Y > 0) — untere Oktanten bleiben ungenutzt.
            assert!(cam.eye[1] > t[1], "Iso-Oktant ueber dem Ziel");
        }
        // Vier unterschiedliche horizontale Vorzeichen-Kombinationen (X,Z).
        assert!(iso.eye[0] > t[0] && iso.eye[2] > t[2]); // vorne-rechts
        assert!(fl.eye[0] < t[0] && fl.eye[2] > t[2]); // vorne-links
        assert!(br.eye[0] > t[0] && br.eye[2] < t[2]); // hinten-rechts
        assert!(bl.eye[0] < t[0] && bl.eye[2] < t[2]); // hinten-links
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

        // Bodengitter-Shader ebenso headless validieren.
        let grid_src = super::shaders::GRID_WGSL;
        let grid_module = naga::front::wgsl::parse_str(grid_src)
            .unwrap_or_else(|e| panic!("grid: WGSL-Parse-Fehler: {e:?}"));
        Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&grid_module)
            .unwrap_or_else(|e| panic!("grid: WGSL-Validierung fehlgeschlagen: {e:?}"));

        // Schnittflaechen-Kappen-Shader (Live-Schnitt-Schraffur) ebenso.
        let cap_src = super::shaders::CAP_WGSL;
        let cap_module = naga::front::wgsl::parse_str(cap_src)
            .unwrap_or_else(|e| panic!("cap: WGSL-Parse-Fehler: {e:?}"));
        Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&cap_module)
            .unwrap_or_else(|e| panic!("cap: WGSL-Validierung fehlgeschlagen: {e:?}"));

        // Texturierter Wand-Shader (RenderStyle::Textured, Bild-Textur in group 1)
        // ebenso headless validieren — faengt Textur-/Sampler-Bindungsfehler ab.
        let tex_src = super::shaders::MESH_TEXTURED_WGSL;
        let tex_module = naga::front::wgsl::parse_str(tex_src)
            .unwrap_or_else(|e| panic!("textured: WGSL-Parse-Fehler: {e:?}"));
        Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&tex_module)
            .unwrap_or_else(|e| panic!("textured: WGSL-Validierung fehlgeschlagen: {e:?}"));

        // Luftbild-Drape-Shader (Terrain-Overlay, Bild-Textur + Bbox-Uniform in
        // group 1) ebenso headless validieren.
        let aerial_src = super::shaders::MESH_AERIAL_WGSL;
        let aerial_module = naga::front::wgsl::parse_str(aerial_src)
            .unwrap_or_else(|e| panic!("aerial: WGSL-Parse-Fehler: {e:?}"));
        Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&aerial_module)
            .unwrap_or_else(|e| panic!("aerial: WGSL-Validierung fehlgeschlagen: {e:?}"));
    }
}
