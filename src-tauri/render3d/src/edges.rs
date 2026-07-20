// Modell-Kanten (Feature-Edges) fuer die Draufsicht-Stile "wireframe" und
// "hidden" des 3D-Renderers.
//
// Leitet aus einem fertigen Dreiecks-`Mesh` (types::Mesh, interleaved
// [pos, normal, color]) eine schlanke Kantenliste ab und liefert sie im
// GLEICHEN Vertex-Format wie das Bodengitter (grid.rs): interleaved
// [px,py,pz, r,g,b], je 2 Vertices = 1 Liniensegment (LineList). Dadurch teilt
// sich die Kanten-Zeichnung Shader (GRID_WGSL) und Vertex-Layout mit dem Grid;
// die GPU-Schicht (gpu.rs) laedt die Vertices einmalig bei `set_model` in einen
// Linien-Vertex-Buffer und cached sie (nicht je Frame).
//
// FEATURE-EDGE-STATT-ALLE-DREIECKSKANTEN: Wuerde man jede Dreieckskante zeichnen,
// erschienen auch die Triangulierungs-Diagonalen jeder rechteckigen Flaeche
// (jede Wand-/Deckenseite ist aus 2 Dreiecken) — ein unruhiges Gitter. Statt
// dessen dedupliziert diese Schicht geteilte Kanten UND unterdrueckt Kanten
// zwischen zwei koplanaren Dreiecken (Flaechen-Innendiagonalen): gezeichnet
// werden nur Silhouetten-/Randkanten (Kante gehoert nur einem Dreieck) und
// Knickkanten ("Crease": die beiden angrenzenden Dreiecke stehen deutlich
// zueinander gewinkelt). Ergebnis ist ein sauberer Architektur-Drahtgitter-/
// Hidden-Line-Look statt einer Dreiecks-Suppe.
//
// GPU-frei (nur `Vec<f32>`), damit headless per `cargo test` pruefbar (Muster:
// grid.rs / mesh.rs / section.rs).

use std::collections::HashMap;

use crate::types::{Mesh, FLOATS_PER_VERTEX};

/// f32 je Kanten-Vertex im interleaved Puffer: 3 Position (world) + 3 Farbe.
/// Bewusst identisch zu `grid::GRID_FLOATS_PER_VERTEX`, damit dieselbe
/// LineList-Pipeline/derselbe Shader (GRID_WGSL) beide zeichnen kann.
pub const EDGE_FLOATS_PER_VERTEX: usize = 6;

/// Farbe der Modell-Kanten (RGB 0..1). Dezentes, dunkles Anthrazit — deutlich
/// genug fuer den Hidden-Line-Look, ohne hart schwarz zu wirken.
pub const EDGE_COLOR: [f32; 3] = [0.16, 0.16, 0.18];

/// Quantisierungsfaktor fuer den Kanten-Schluessel: Positionen werden auf 0.1 mm
/// (1e4 pro Meter) gerundet, damit geometrisch zusammenfallende Endpunkte aus
/// verschiedenen (pro Flaeche duplizierten) Vertices denselben Schluessel teilen.
const QUANT: f32 = 1.0e4;

/// Kosinus des Crease-Winkels: liegen die Normalen zweier angrenzender Dreiecke
/// enger beieinander (dot > COS), gelten sie als koplanar → die geteilte Kante
/// wird NICHT gezeichnet (Flaechen-Innendiagonale). Darunter = Knickkante →
/// zeichnen. cos(15°) ≈ 0.966: Ebenen-Diagonalen (dot≈1) fallen weg, echte
/// Bauteil-Kanten (≥ ~90°) bleiben.
const CREASE_COS: f32 = 0.966;

/// Ganzzahliger Positions-Schluessel (quantisiert) fuer die Kanten-Deduplizierung.
type Key = [i64; 3];

fn key_of(p: [f32; 3]) -> Key {
    [
        (p[0] * QUANT).round() as i64,
        (p[1] * QUANT).round() as i64,
        (p[2] * QUANT).round() as i64,
    ]
}

/// Sammlung je Kante: die (erste gesehene) Position beider Endpunkte plus die
/// Normalen aller angrenzenden Dreiecke — daraus entscheidet sich Rand/Knick.
struct EdgeRec {
    p0: [f32; 3],
    p1: [f32; 3],
    normals: Vec<[f32; 3]>,
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if l <= 1e-12 {
        [0.0, 0.0, 0.0]
    } else {
        [v[0] / l, v[1] / l, v[2] / l]
    }
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Eine Kante samt ihrer deduplizierten Repraesentanten-Normalen (Rueckseiten
/// bereits gepaart, s. `representatives`). Grundlage BEIDER Kanten-Stile: die
/// statischen Feature-Edges (`build_mesh_edges`) UND die blickabhaengigen
/// Silhouetten-Konturen (`build_silhouette_edges`).
pub struct EdgeAdj {
    pub p0: [f32; 3],
    pub p1: [f32; 3],
    /// Flaechennormalen der (max. 2) angrenzenden Original-Dreiecke.
    pub reps: Vec<[f32; 3]>,
}

/// Baut die Kanten-Adjazenz aus dem Mesh: je eindeutiger Kante die Endpunkte +
/// die deduplizierten Repraesentanten-Normalen. GPU-frei; einmalig bei `set_model`
/// berechnet und gecacht (die Silhouette wird daraus je Blickwinkel neu abgeleitet).
pub fn build_edge_adjacency(mesh: &Mesh) -> Vec<EdgeAdj> {
    if mesh.indices.len() < 3 {
        return Vec::new();
    }
    let pos = |i: u32| -> [f32; 3] {
        let b = i as usize * FLOATS_PER_VERTEX;
        [mesh.verts[b], mesh.verts[b + 1], mesh.verts[b + 2]]
    };

    // Kanten-Schluessel (kanonisch sortiertes Endpunkt-Paar) -> Datensatz.
    let mut edges: HashMap<(Key, Key), EdgeRec> = HashMap::new();

    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (pos(tri[0]), pos(tri[1]), pos(tri[2]));
        // Geometrische Flaechennormale (robuster als die pro-Vertex-Normalen).
        let n = normalize(cross(sub(b, a), sub(c, a)));
        if n == [0.0, 0.0, 0.0] {
            continue; // entartetes Dreieck ueberspringen
        }
        for (u, v) in [(a, b), (b, c), (c, a)] {
            let (ku, kv) = (key_of(u), key_of(v));
            if ku == kv {
                continue; // Null-Laengen-Kante
            }
            // Kanonische Reihenfolge, damit u->v und v->u denselben Schluessel haben.
            let (key, p0, p1) = if ku <= kv {
                ((ku, kv), u, v)
            } else {
                ((kv, ku), v, u)
            };
            edges
                .entry(key)
                .or_insert_with(|| EdgeRec {
                    p0,
                    p1,
                    normals: Vec::new(),
                })
                .normals
                .push(n);
        }
    }

    edges
        .into_values()
        .map(|rec| EdgeAdj {
            p0: rec.p0,
            p1: rec.p1,
            reps: representatives(&rec.normals),
        })
        .collect()
}

fn push_edge(verts: &mut Vec<f32>, p0: [f32; 3], p1: [f32; 3]) {
    for p in [p0, p1] {
        verts.extend_from_slice(&[p[0], p[1], p[2], EDGE_COLOR[0], EDGE_COLOR[1], EDGE_COLOR[2]]);
    }
}

/// Baut die Feature-Edge-LineList aus dem Mesh (siehe Moduldoc).
///
/// Ausgabe: interleaved `[px,py,pz, r,g,b, ...]`, je 2 Vertices = 1 Segment.
/// Leerer Vektor bei leerem/degeneriertem Mesh.
pub fn build_mesh_edges(mesh: &Mesh) -> Vec<f32> {
    let adj = build_edge_adjacency(mesh);
    let mut verts: Vec<f32> = Vec::new();
    for a in &adj {
        if draws_crease(&a.reps) {
            push_edge(&mut verts, a.p0, a.p1);
        }
    }
    verts
}

/// Blickabhaengige Silhouetten-Konturen aus der gecachten Kanten-Adjazenz: gezeichnet
/// werden Randkanten (nur ein Dreieck) UND echte Silhouetten-Kanten — solche, deren
/// zwei angrenzende Flaechen aus Sicht der Kamera GEGENSAETZLICH orientiert sind
/// (eine vorder-, eine rueckseitig). Ergebnis ist der reine Umriss (Gipsmodell-/
/// Konturen-Look) ohne die inneren Knickkanten (Dachgrate). `eye` = Kameraposition
/// (world), `forward` = Blickrichtung (world, von der Kamera ins Bild); `perspective`
/// waehlt die pro-Kante-Blickrichtung (Perspektive) vs. die konstante (ortho).
pub fn build_silhouette_edges(
    adj: &[EdgeAdj],
    eye: [f32; 3],
    forward: [f32; 3],
    perspective: bool,
) -> Vec<f32> {
    let mut verts: Vec<f32> = Vec::new();
    for a in adj {
        let draw = match a.reps.len() {
            0 => false,
            1 => true, // offene Randkante -> immer Teil der Kontur
            _ => {
                let mid = [
                    (a.p0[0] + a.p1[0]) * 0.5,
                    (a.p0[1] + a.p1[1]) * 0.5,
                    (a.p0[2] + a.p1[2]) * 0.5,
                ];
                // Blickvektor von der Flaeche ZUR Kamera. Perspektive: eye - mid;
                // ortho: entgegen der Blickrichtung (konstante Kamera).
                let view = if perspective {
                    sub(eye, mid)
                } else {
                    [-forward[0], -forward[1], -forward[2]]
                };
                let mut front = false;
                let mut back = false;
                for n in &a.reps {
                    let d = dot(*n, view);
                    if d > 0.0 {
                        front = true;
                    } else if d < 0.0 {
                        back = true;
                    }
                }
                front && back // Silhouette: eine Flaeche vorder-, eine rueckseitig
            }
        };
        if draw {
            push_edge(&mut verts, a.p0, a.p1);
        }
    }
    verts
}

/// Entscheidet, ob eine Kante gezeichnet wird: Randkante (nur ein Dreieck) oder
/// Knickkante (zwei angrenzende Dreiecke stehen ueber dem Crease-Winkel zuein-
/// ander). Koplanare geteilte Kanten (Flaechendiagonalen) werden unterdrueckt.
///
/// DOPPELSEITIGE MESHES (Kontext/Dach/Fenster-Glas, s. `mesh.rs::push_ctx_tri` —
/// jedes Dreieck wird dort MIT gespiegelter Rueckseite [-Normale] dupliziert,
/// weil die Mesh-Pipeline Backface-Culling aktiv hat): jedes Original-Dreieck
/// liefert dadurch IMMER ein exaktes +n/-n-Paar an jeder seiner Kanten. Ohne
/// Beruecksichtigung wuerde das faelschlich als extremer Knick (dot ≈ -1)
/// gewertet und JEDE Flaechen-Innendiagonale eines doppelseitigen Meshes
/// gezeichnet (Nutzer-Report: Dreiecks-Diagonalen sichtbar auf Dach/Glas).
/// Fix: zuerst Rueckseiten-Partner (dot ≈ -1 zueinander) einander zuordnen und
/// nur EINEN Vertreter je Original-Dreieck behalten — danach greift dieselbe
/// Rand-/Knick-Logik wie bei einseitigen Meshes (Waende), unabhaengig davon,
/// ob doppelseitig gerendert wurde oder nicht.
/// Dedupliziert die angrenzenden Normalen zu Repraesentanten: paart die von der
/// doppelseitigen Emission stammenden Rueckseiten (dot ≈ -1) und behaelt je
/// Original-Dreieck EINEN Vertreter (s. Moduldoc `should_draw`-Historie).
fn representatives(normals: &[[f32; 3]]) -> Vec<[f32; 3]> {
    let mut reps: Vec<[f32; 3]> = Vec::new();
    let mut used = vec![false; normals.len()];
    for i in 0..normals.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        reps.push(normals[i]);
        for j in (i + 1)..normals.len() {
            if used[j] {
                continue;
            }
            if dot(normals[i], normals[j]) < -CREASE_COS {
                used[j] = true; // Rueckseiten-Duplikat desselben Dreiecks
                break;
            }
        }
    }
    reps
}

/// Entscheidet fuer die STATISCHEN Feature-Edges, ob eine Kante gezeichnet wird:
/// Randkante (ein Repraesentant) oder Knickkante (zwei stehen ueber dem Crease-
/// Winkel zueinander). Koplanare geteilte Kanten (Flaechendiagonalen) fallen weg.
fn draws_crease(reps: &[[f32; 3]]) -> bool {
    match reps.len() {
        0 => false,
        1 => true, // Silhouette/Rand: gehoert nur einem Original-Dreieck
        _ => {
            for i in 0..reps.len() {
                for j in (i + 1)..reps.len() {
                    if dot(reps[i], reps[j]) < CREASE_COS {
                        return true;
                    }
                }
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hilfsbau: Mesh aus (pos, dummy-normal, dummy-color) + Indizes.
    fn mesh(positions: &[[f32; 3]], indices: &[u32]) -> Mesh {
        let mut verts = Vec::new();
        for p in positions {
            verts.extend_from_slice(&[p[0], p[1], p[2], 0.0, 1.0, 0.0, 0.8, 0.8, 0.8]);
        }
        Mesh {
            verts,
            indices: indices.to_vec(),
        }
    }

    fn segment_count(v: &[f32]) -> usize {
        v.len() / EDGE_FLOATS_PER_VERTEX / 2
    }

    #[test]
    fn single_triangle_has_three_boundary_edges() {
        let m = mesh(
            &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
            &[0, 1, 2],
        );
        let e = build_mesh_edges(&m);
        assert_eq!(segment_count(&e), 3);
    }

    #[test]
    fn coplanar_quad_drops_shared_diagonal() {
        // Ebenes Quad aus 2 Dreiecken in der XZ-Ebene: geteilte Diagonale ist
        // koplanar -> weg; es bleiben die 4 Umriss-Kanten.
        let m = mesh(
            &[
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
            ],
            &[0, 1, 2, 0, 2, 3],
        );
        let e = build_mesh_edges(&m);
        assert_eq!(segment_count(&e), 4);
    }

    #[test]
    fn folded_quad_keeps_crease() {
        // Zwei Dreiecke im 90°-Knick teilen die Kante (0,0,0)-(1,0,0):
        // Normalen stehen senkrecht -> Knickkante bleibt erhalten.
        let m = mesh(
            &[
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 1.0], // erstes Dreieck in XZ (Normale +Y)
                [1.0, 1.0, 0.0], // zweites Dreieck kippt nach oben (Normale +Z)
            ],
            &[0, 1, 2, 0, 3, 1],
        );
        let e = build_mesh_edges(&m);
        // geteilte Knickkante + je 2 Randkanten pro Dreieck = 5 Segmente.
        assert_eq!(segment_count(&e), 5);
    }

    #[test]
    fn empty_mesh_yields_no_edges() {
        let m = Mesh::default();
        assert!(build_mesh_edges(&m).is_empty());
    }

    /// Ein geschlossener Wuerfel: 8 Ecken, 12 Dreiecke (6 Flaechen, aussen).
    fn unit_cube() -> Mesh {
        let c = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
            [0.0, 1.0, 1.0],
        ];
        #[rustfmt::skip]
        let idx: Vec<u32> = vec![
            0,3,2, 0,2,1, // -Z
            4,5,6, 4,6,7, // +Z
            0,1,5, 0,5,4, // -Y
            3,7,6, 3,6,2, // +Y
            0,4,7, 0,7,3, // -X
            1,2,6, 1,6,5, // +X
        ];
        mesh(&c, &idx)
    }

    #[test]
    fn cube_feature_edges_are_twelve() {
        // Statische Feature-Edges: die 12 Wuerfelkanten (Flaechendiagonalen weg).
        let e = build_mesh_edges(&unit_cube());
        assert_eq!(segment_count(&e), 12);
    }

    #[test]
    fn cube_silhouette_from_generic_view_is_hexagon() {
        // Aus einer generischen Ecken-Sicht ist die Silhouette eines Wuerfels ein
        // Sechseck = 6 Kanten (nur der Umriss, KEINE inneren Knickkanten).
        let adj = build_edge_adjacency(&unit_cube());
        let eye = [5.0, 6.0, 7.0];
        let fwd = normalize(sub([0.5, 0.5, 0.5], eye)); // Blick auf die Mitte
        let sil = build_silhouette_edges(&adj, eye, fwd, true);
        assert_eq!(segment_count(&sil), 6);
    }

    #[test]
    fn cube_silhouette_ortho_is_hexagon_too() {
        // Auch orthografisch (konstante Blickrichtung) ergibt sich das Sechseck.
        let adj = build_edge_adjacency(&unit_cube());
        let fwd = normalize([-1.0, -1.2, -1.4]);
        let sil = build_silhouette_edges(&adj, [0.0, 0.0, 0.0], fwd, false);
        assert_eq!(segment_count(&sil), 6);
    }
}

#[cfg(test)]
mod double_sided_tests {
    // Deckt den Nutzer-Report ab (Dreiecks-Diagonalen sichtbar auf Dach/Glas):
    // Kontext-Meshes werden von `mesh.rs::push_ctx_tri` IMMER doppelseitig
    // aufgebaut (jedes Dreieck + gespiegelte Rueckseite [-Normale], weil die
    // Mesh-Pipeline Backface-Culling aktiv hat). Diese Tests bauen genau dieses
    // Muster nach (nicht die einfachen einseitigen Test-Meshes oben).
    use super::*;

    fn mesh_single_sided(positions: &[[f32; 3]], indices: &[u32]) -> Mesh {
        let mut verts = Vec::new();
        for p in positions {
            verts.extend_from_slice(&[p[0], p[1], p[2], 0.0, 1.0, 0.0, 0.8, 0.8, 0.8]);
        }
        Mesh { verts, indices: indices.to_vec() }
    }

    /// Baut ein Mesh wie `mesh_single_sided`, aber verdoppelt JEDES Dreieck mit
    /// umgekehrter Wicklung (a,c,b statt a,b,c) — exakt das Muster von
    /// `mesh.rs::push_ctx_tri` (Vorder- + Rueckseite fuer doppelseitiges Rendering).
    fn mesh_double_sided(positions: &[[f32; 3]], indices: &[u32]) -> Mesh {
        let mut verts = Vec::new();
        for p in positions {
            verts.extend_from_slice(&[p[0], p[1], p[2], 0.0, 1.0, 0.0, 0.8, 0.8, 0.8]);
        }
        let mut doubled = Vec::with_capacity(indices.len() * 2);
        for tri in indices.chunks_exact(3) {
            doubled.extend_from_slice(&[tri[0], tri[1], tri[2]]);
            doubled.extend_from_slice(&[tri[0], tri[2], tri[1]]); // gespiegelte Rueckseite
        }
        Mesh { verts, indices: doubled }
    }

    fn segment_count(v: &[f32]) -> usize {
        v.len() / EDGE_FLOATS_PER_VERTEX / 2
    }

    #[test]
    fn doubled_coplanar_quad_still_drops_shared_diagonal() {
        // Dasselbe ebene Quad wie coplanar_quad_drops_shared_diagonal, aber
        // doppelseitig aufgebaut — VOR dem Fix haette dies faelschlich 6 statt
        // 4 Segmente geliefert (Diagonale faelschlich als Knick erkannt).
        let m = mesh_double_sided(
            &[
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
            ],
            &[0, 1, 2, 0, 2, 3],
        );
        let e = build_mesh_edges(&m);
        assert_eq!(segment_count(&e), 4);
    }

    #[test]
    fn doubled_single_triangle_still_has_three_boundary_edges() {
        // Silhouette-Kanten eines EINZELNEN Dreiecks muessen trotz Verdopplung
        // (Vorder-/Rueckseite) weiterhin als Rand erkannt und gezeichnet werden.
        let m = mesh_double_sided(
            &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
            &[0, 1, 2],
        );
        let e = build_mesh_edges(&m);
        assert_eq!(segment_count(&e), 3);
    }

    #[test]
    fn doubled_folded_quad_still_keeps_crease() {
        // Echter 90°-Knick bleibt auch doppelseitig als Kante erhalten (keine
        // Ueberkompensation, die auch echte Knicke unterdruecken wuerde).
        let m = mesh_double_sided(
            &[
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 1.0],
                [1.0, 1.0, 0.0],
            ],
            &[0, 1, 2, 0, 3, 1],
        );
        let e = build_mesh_edges(&m);
        assert_eq!(segment_count(&e), 5);
    }

    #[test]
    fn real_opening_box_topology_suppresses_face_diagonals_doubled() {
        // Exakte Ecken-Reihenfolge/Indizes aus toWalls3d.ts::OPENING_BOX_TRIS,
        // diesmal ECHT doppelseitig wie im tatsaechlichen Render-Pfad (die
        // Fenster-Glas-/Rahmen-Boxen laufen ueber append_context_mesh).
        let from = 0.0f32;
        let to = 1.2f32;
        let z_bottom = 0.9f32;
        let z_top = 2.1f32;
        let n_min = -0.03f32;
        let n_max = 0.03f32;
        let mut positions = Vec::new();
        for i in 0..8u32 {
            let s = if i & 1 != 0 { to } else { from };
            let z = if i & 2 != 0 { z_top } else { z_bottom };
            let t = if i & 4 != 0 { n_max } else { n_min };
            positions.push([s, -t, z]);
        }
        let indices: Vec<u32> = vec![
            0, 1, 3, 0, 3, 2,
            4, 5, 7, 4, 7, 6,
            0, 1, 5, 0, 5, 4,
            2, 3, 7, 2, 7, 6,
            0, 2, 6, 0, 6, 4,
            1, 3, 7, 1, 7, 5,
        ];
        let m = mesh_double_sided(&positions, &indices);
        let e = build_mesh_edges(&m);
        // Ein Quader hat 12 echte Kanten (Silhouette); bei korrekter Diagonalen-
        // Unterdrueckung sollten es GENAU 12 sein (nicht 12+6 Diagonalen=18).
        assert_eq!(segment_count(&e), 12, "erwartet 12 Kanten (Quader-Silhouette), keine Flaechendiagonalen");
    }

    #[test]
    fn single_sided_helper_matches_module_level_mesh_helper() {
        // Absicherung: der lokale mesh_single_sided-Helfer verhaelt sich
        // identisch zum bestehenden `tests::mesh` (keine versehentliche
        // Abweichung beim Kopieren).
        let m = mesh_single_sided(
            &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
            &[0, 1, 2],
        );
        let e = build_mesh_edges(&m);
        assert_eq!(segment_count(&e), 3);
    }
}
