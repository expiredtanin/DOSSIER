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
pub(crate) mod openings;
pub mod section;
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
pub use mesh::{build_model_mesh, build_walls_mesh, extrude_slab, extrude_wall, triangulate};
pub use section::{
    cut_section, ComponentKind, ComponentRef, CutPolygon, SectionEdge, SectionOutput, SectionPlane,
};
pub use types::{
    Camera, CameraPreset, Mesh, Point2, Projection, Rgb, SlabInput, WallInput, FLOATS_PER_VERTEX,
};

// --- Tests: Mesh-Erzeugung (Muster wie render2d/tessellate) -------------------

#[cfg(test)]
mod tests {
    use super::mesh::{build_walls_mesh, extrude_wall, INDICES_PER_BOX, VERTS_PER_BOX};
    use super::types::{Mesh, Opening, WallInput, WallLayer, FLOATS_PER_VERTEX};

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
                openings: vec![],
                layers: None,
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
        extrude_slab(&mut mesh, &SlabInput { outline: vec![[0.0, 0.0], [1.0, 0.0]], z_bottom: 0.0, z_top: 0.2, color: [0.8, 0.8, 0.8] });
        assert_eq!(mesh.vertex_count(), 0);
        // Nullhoehe.
        extrude_slab(&mut mesh, &square_slab(4.0, 2.6, 2.6));
        assert_eq!(mesh.vertex_count(), 0);
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
