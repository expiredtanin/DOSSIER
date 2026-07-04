//! Schnittflaechen-Geometrie fuer den Live-3D-Schnitt: wandelt die analytischen
//! Cut-Polygone aus `section::cut_section` (achsparallele (u,v)-Rechtecke, siehe
//! `section.rs`-Moduldoc) in kamerataugliche Dreiecks-Geometrie fuer die Cap-
//! Pipeline (`gpu::cap_pipeline`, Schraffur in `shaders::CAP_WGSL`).
//!
//! ## Ruecktransformation (u,v) -> Welt
//!
//! `SectionPlane::project(p) = [dot(p - point, u_axis), p.y]` (nur vertikale
//! Ebenen). Die Inverse fuer einen Punkt AUF der Ebene ist damit
//!
//! ```text
//! world = point + u * u_axis   (horizontale Lage),   world.y = v
//! ```
//!
//! `u_axis` ist horizontal (y = 0), also traegt `u * u_axis` nichts zur Hoehe
//! bei — `world.y = v` gilt exakt, und der Punkt liegt auf der Ebene, weil
//! `u_axis` und die Welt-Hoehenachse [0,1,0] beide senkrecht auf der (horizon-
//! talen) Normale stehen. Wir nutzen `SectionPlane::u_axis()` (pub(crate)),
//! damit die Achsdefinition (inkl. Entartungs-Fallback) mit `section.rs`
//! identisch bleibt.
//!
//! ## Ausgabeformat
//!
//! Interleaved `[world_x, world_y, world_z, u, v]` je Vertex (5 f32,
//! `CAP_FLOATS_PER_VERTEX`), Dreiecksliste. `(u,v)` in Modell-Metern wandern als
//! Attribut mit, damit die Schraffur im Fragment-Shader ein durchgaengiges,
//! blickwinkel-unabhaengiges Muster IN der Schnittebene zeichnet (nicht im
//! Bildschirmraum). Ein Cut-Polygon ist stets ein konvexes Rechteck (4 Ecken,
//! siehe `section.rs`) — Fan-Triangulierung genuegt.

use crate::section::{cut_section, SectionPlane};
use crate::types::{SlabInput, WallInput};

/// f32 pro Cap-Vertex: [pos.x, pos.y, pos.z, u, v]. Spiegel des Vertex-Layouts
/// der `cap_pipeline` (gpu.rs) und des `VsIn` in `CAP_WGSL` (shaders.rs).
pub const CAP_FLOATS_PER_VERTEX: usize = 5;

/// Erzeugt die Schnittflaechen-Geometrie (Cut-Caps) fuer eine vertikale
/// Schnittebene: ruft `cut_section` und trianguliert jedes (u,v)-Rechteck in die
/// Welt zurueck. Rueckgabe = interleaved Vertexpuffer (`CAP_FLOATS_PER_VERTEX`),
/// leer, wenn die Ebene das Modell nicht schneidet.
///
/// WINDING: bewusst nicht garantiert kamerakonsistent — die Cap-Pipeline
/// zeichnet ohne Backface-Culling (`CullMode::None`, siehe gpu.rs), sodass die
/// flache Schnittflaeche aus beiden Richtungen sichtbar ist. Die Schraffur haengt
/// nicht von der Normale ab.
pub fn build_cut_caps(
    plane: &SectionPlane,
    walls: &[WallInput],
    slabs: &[SlabInput],
) -> Vec<f32> {
    let out = cut_section(plane, walls, slabs);
    let point = plane.point;
    let u_axis = plane.u_axis();
    // (u, v) -> Welt: horizontale Lage aus point + u*u_axis, Hoehe = v.
    let to_world = |uv: [f32; 2]| -> [f32; 3] {
        [
            point[0] + uv[0] * u_axis[0],
            uv[1],
            point[2] + uv[0] * u_axis[2],
        ]
    };

    let mut verts: Vec<f32> = Vec::new();
    for poly in &out.cut_polygons {
        let pts = &poly.pts;
        if pts.len() < 3 {
            continue;
        }
        let mut push_vertex = |uv: [f32; 2]| {
            let w = to_world(uv);
            verts.extend_from_slice(&[w[0], w[1], w[2], uv[0], uv[1]]);
        };
        // Fan-Triangulierung (konvexe Rechtecke): (0, i, i+1).
        for i in 1..pts.len() - 1 {
            push_vertex(pts[0]);
            push_vertex(pts[i]);
            push_vertex(pts[i + 1]);
        }
    }
    verts
}
