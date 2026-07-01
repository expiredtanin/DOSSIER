// Mesh-Erzeugung: extrudiert geflachte Waende zu Quader-Meshes. GPU-frei, headless
// per `cargo test` pruefbar (Muster: render2d/tessellate).
//
// Grundlage ist der Wandband-Ansatz aus src/model/geometry.ts (`wallCorners`):
//   u = normalize(end - start)          Achsenrichtung im Grundriss
//   n = leftNormal(u) = (-u.y, u.x)      Links-Normale (90 Grad CCW)
//   Band-Ecken = start/end +/- n * thickness/2   (CCW-Umlauf)
// Diese 2D-Band-Ecken werden nach world abgebildet (XZ-Ebene) und entlang +Y von
// `base_elevation` bis `base_elevation + height` extrudiert — analog zur
// three.js-`ExtrudeGeometry`, die den 2D-`clippedBand` hochzieht (Viewport3D.tsx
// `addLayerPrism`). M1 nimmt die stumpfe (rechtwinklige) Band-Form; Gehrungen
// (`computeJoins`/`clippedBand`) und Oeffnungen kommen in spaeteren Milestones.
//
// KOORDINATEN: model [x, y] -> world (x, elevation, y). Also Grundriss in der
// XZ-Ebene, Extrusion entlang +Y (Y-up), exakt wie Viewport3D.tsx:
//   "Modell (x,y,z) -> Three (x, z, y)  (Z = Hoehe nach oben)".

use crate::types::{Mesh, Point2, Rgb, WallInput, FLOATS_PER_VERTEX};

/// Ein Quader-Mesh besteht aus 6 Seiten (Boden, Deckel, 4 Waende) zu je 2
/// Dreiecken = 12 Dreiecke, mit flachen Normalen also 24 Vertices (je Seite 4,
/// keine geteilten Normalen). Konstanten dokumentieren die Test-Erwartung.
pub const VERTS_PER_BOX: usize = 24;
pub const INDICES_PER_BOX: usize = 36;

/// 2D-Einheits-Links-Normale zur Richtung (end - start), wie `leftNormal` im Web:
/// n = (-u.y, u.x). Liefert (0,0) bei Nulllaenge.
fn left_normal(start: Point2, end: Point2) -> Point2 {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        return [0.0, 0.0];
    }
    [-dy / len, dx / len]
}

/// Extrudiert EINE Wand zu einem Quader-Mesh und haengt sie an `mesh` an.
///
/// Aufbau: die vier Grundriss-Ecken des Bandes (CCW) bilden das Deckel-Rechteck.
/// Boden = gleiche XZ auf `y0`, Deckel = auf `y1`. Jede der sechs Seiten bekommt
/// eigene Vertices mit ihrer (nach aussen zeigenden) Flaechen-Normale — daher
/// flaches Shading und korrektes Backface-Culling.
pub fn extrude_wall(mesh: &mut Mesh, wall: &WallInput) {
    let n = left_normal(wall.start, wall.end);
    // Degenerierte Wand (Start == Ende) ueberspringen.
    if n == [0.0, 0.0] {
        return;
    }
    let h = wall.thickness * 0.5;

    // Vier Band-Ecken im Grundriss (CCW, wie `wallCorners(start,end,thickness)`):
    //  p0 = start + n*h,  p1 = end + n*h,  p2 = end - n*h,  p3 = start - n*h.
    let off = |p: Point2, s: f32| -> Point2 { [p[0] + n[0] * s * h, p[1] + n[1] * s * h] };
    let g0 = off(wall.start, 1.0);
    let g1 = off(wall.end, 1.0);
    let g2 = off(wall.end, -1.0);
    let g3 = off(wall.start, -1.0);

    let y0 = wall.base_elevation;
    let y1 = wall.base_elevation + wall.height;
    let color = wall.color;

    // world-Position aus Grundriss-XZ + Hoehe: (x, y, z=grundriss.y).
    let w = |g: Point2, y: f32| -> [f32; 3] { [g[0], y, g[1]] };

    // Acht Quader-Ecken (b* = Boden auf y0, t* = Deckel auf y1).
    let b0 = w(g0, y0);
    let b1 = w(g1, y0);
    let b2 = w(g2, y0);
    let b3 = w(g3, y0);
    let t0 = w(g0, y1);
    let t1 = w(g1, y1);
    let t2 = w(g2, y1);
    let t3 = w(g3, y1);

    // Sechs Seiten als Quads (Ecken CCW von aussen gesehen -> Normale zeigt raus).
    // Deckel oben (+Y): t0,t1,t2,t3 von oben CCW.
    push_quad(mesh, t0, t1, t2, t3, [0.0, 1.0, 0.0], color);
    // Boden unten (-Y): b0,b3,b2,b1 (von unten gesehen CCW).
    push_quad(mesh, b0, b3, b2, b1, [0.0, -1.0, 0.0], color);

    // Vier Mantelflaechen. Aussen-Normalen aus dem Grundriss:
    //  Kante g0->g1 liegt auf der +n-Seite  -> Normale +n.
    //  Kante g2->g3 liegt auf der -n-Seite  -> Normale -n.
    //  Kappen an Start (g3->g0) und Ende (g1->g2) liegen an den Achsen-Enden.
    let np = [n[0], 0.0, n[1]]; // +n-Seite (world)
    let nn = [-n[0], 0.0, -n[1]]; // -n-Seite
    // Achsenrichtung (fuer die End-Kappen-Normalen).
    let ux = wall.end[0] - wall.start[0];
    let uz = wall.end[1] - wall.start[1];
    let ul = (ux * ux + uz * uz).sqrt().max(1e-9);
    let u = [ux / ul, 0.0, uz / ul];
    let neg_u = [-u[0], 0.0, -u[2]];

    // +n-Wand: aussen betrachtet CCW = b0, b1, t1, t0.
    push_quad(mesh, b0, b1, t1, t0, np, color);
    // -n-Wand: aussen betrachtet CCW = b2, b3, t3, t2.
    push_quad(mesh, b2, b3, t3, t2, nn, color);
    // End-Kappe (Achsen-Ende, Normale +u): b1, b2, t2, t1.
    push_quad(mesh, b1, b2, t2, t1, u, color);
    // Start-Kappe (Achsen-Anfang, Normale -u): b3, b0, t0, t3.
    push_quad(mesh, b3, b0, t0, t3, neg_u, color);
}

/// Haengt ein Quad (vier Ecken in CCW von aussen) als zwei Dreiecke an, mit fester
/// Flaechen-Normale und Farbe je Vertex. Reihenfolge (0,1,2) + (0,2,3).
fn push_quad(
    mesh: &mut Mesh,
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    d: [f32; 3],
    normal: [f32; 3],
    color: Rgb,
) {
    let base = (mesh.verts.len() / FLOATS_PER_VERTEX) as u32;
    for p in [a, b, c, d] {
        mesh.verts.extend_from_slice(&[
            p[0], p[1], p[2], normal[0], normal[1], normal[2], color[0], color[1], color[2],
        ]);
    }
    mesh.indices
        .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
}

/// Baut ein einzelnes Mesh aus mehreren Waenden (alle in EINEN Puffer). Die
/// Reihenfolge der Vertices ist deterministisch (je Wand ein Quader), damit die
/// Tests stabile Zaehlungen erwarten koennen.
pub fn build_walls_mesh(walls: &[WallInput]) -> Mesh {
    let mut mesh = Mesh::default();
    for w in walls {
        extrude_wall(&mut mesh, w);
    }
    mesh
}
