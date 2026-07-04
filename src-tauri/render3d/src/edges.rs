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

/// Baut die Feature-Edge-LineList aus dem Mesh (siehe Moduldoc).
///
/// Ausgabe: interleaved `[px,py,pz, r,g,b, ...]`, je 2 Vertices = 1 Segment.
/// Leerer Vektor bei leerem/degeneriertem Mesh.
pub fn build_mesh_edges(mesh: &Mesh) -> Vec<f32> {
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

    let mut verts: Vec<f32> = Vec::new();
    let mut push = |p: [f32; 3]| {
        verts.push(p[0]);
        verts.push(p[1]);
        verts.push(p[2]);
        verts.push(EDGE_COLOR[0]);
        verts.push(EDGE_COLOR[1]);
        verts.push(EDGE_COLOR[2]);
    };

    for rec in edges.values() {
        if should_draw(&rec.normals) {
            push(rec.p0);
            push(rec.p1);
        }
    }
    verts
}

/// Entscheidet, ob eine Kante gezeichnet wird: Randkante (nur ein Dreieck) oder
/// Knickkante (zwei angrenzende Dreiecke stehen ueber dem Crease-Winkel zuein-
/// ander). Koplanare geteilte Kanten (Flaechendiagonalen) werden unterdrueckt.
fn should_draw(normals: &[[f32; 3]]) -> bool {
    match normals.len() {
        0 => false,
        1 => true, // Silhouette/Rand: gehoert nur einem Dreieck
        _ => {
            // Zeichnen, sobald irgendein Normalen-Paar deutlich abknickt.
            for i in 0..normals.len() {
                for j in (i + 1)..normals.len() {
                    if dot(normals[i], normals[j]) < CREASE_COS {
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
}
