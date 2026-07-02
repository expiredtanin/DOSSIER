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

use crate::types::{Mesh, Point2, Rgb, SlabInput, WallInput, FLOATS_PER_VERTEX};

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

/// Baut das volle Modell-Mesh: erst die Waende (Quader), dann die Deckenplatten
/// (extrudierte Polygone) — alles in EINEN Puffer. Die Wand-Reihenfolge bleibt
/// vorne (deterministische Zaehlung fuer die Wand-Tests).
pub fn build_model_mesh(walls: &[WallInput], slabs: &[SlabInput]) -> Mesh {
    let mut mesh = build_walls_mesh(walls);
    for s in slabs {
        extrude_slab(&mut mesh, s);
    }
    mesh
}

// ── Deckenplatten (extrudierte Polygone) ─────────────────────────────────────

/// Signierte Flaeche eines Grundriss-Polygons (Shoelace) in Modell-Koordinaten.
fn signed_area(pts: &[Point2]) -> f32 {
    let mut a = 0.0f32;
    let n = pts.len();
    if n < 3 {
        return 0.0;
    }
    let mut j = n - 1;
    for i in 0..n {
        a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        j = i;
    }
    a * 0.5
}

/// Kreuzprodukt (b-a) x (c-a) im Grundriss.
#[inline]
fn cross2(a: Point2, b: Point2, c: Point2) -> f32 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Liegt p im (a,b,c)-Dreieck? (CCW-orientiert).
fn point_in_tri(a: Point2, b: Point2, c: Point2, p: Point2) -> bool {
    let d1 = cross2(a, b, p);
    let d2 = cross2(b, c, p);
    let d3 = cross2(c, a, p);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Ear-Clipping-Triangulierung eines einfachen (lochfreien) Polygons. Robust fuer
/// konvexe UND konkave Ringe. O(n^2) — fuer Decken-Umrisse (wenige Ecken) voellig
/// ausreichend. Liefert Dreiecks-Indizes (0-basiert auf `pts`); leer bei <3 Ecken
/// oder Degeneration. 1:1-Port von `render2d::tessellate::triangulate`.
pub fn triangulate(pts: &[Point2]) -> Vec<u32> {
    let n = pts.len();
    if n < 3 {
        return Vec::new();
    }
    // Ohr-Test unten nutzt cross>0 = konvex (setzt CCW voraus). CW-Polygone drehen.
    let mut idx: Vec<usize> = (0..n).collect();
    if signed_area(pts) < 0.0 {
        idx.reverse();
    }

    let mut tris: Vec<u32> = Vec::new();
    let mut guard = 0usize;
    let max_guard = n * n + 16;

    while idx.len() > 3 && guard < max_guard {
        guard += 1;
        let mut clipped = false;
        let m = idx.len();
        for i in 0..m {
            let i_prev = idx[(i + m - 1) % m];
            let i_cur = idx[i];
            let i_next = idx[(i + 1) % m];
            let a = pts[i_prev];
            let b = pts[i_cur];
            let c = pts[i_next];
            if cross2(a, b, c) <= 0.0 {
                continue; // konkav/kollinear -> kein Ohr
            }
            let mut contains = false;
            for &vi in &idx {
                if vi == i_prev || vi == i_cur || vi == i_next {
                    continue;
                }
                if point_in_tri(a, b, c, pts[vi]) {
                    contains = true;
                    break;
                }
            }
            if contains {
                continue;
            }
            tris.push(i_prev as u32);
            tris.push(i_cur as u32);
            tris.push(i_next as u32);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break;
        }
    }
    if idx.len() == 3 {
        tris.push(idx[0] as u32);
        tris.push(idx[1] as u32);
        tris.push(idx[2] as u32);
    }
    tris
}

/// Haengt ein Dreieck (drei world-Ecken) mit fester Flaechen-Normale + Farbe an.
/// Die Reihenfolge wird so gedreht, dass die geometrische Normale mit `want_normal`
/// gleich orientiert ist (CCW von aussen -> korrektes Backface-Culling).
fn push_tri_oriented(
    mesh: &mut Mesh,
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    want_normal: [f32; 3],
    color: Rgb,
) {
    // Geometrische Normale (b-a) x (c-a).
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let gn = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    let dot = gn[0] * want_normal[0] + gn[1] * want_normal[1] + gn[2] * want_normal[2];
    let (v0, v1, v2) = if dot < 0.0 { (a, c, b) } else { (a, b, c) };
    let base = (mesh.verts.len() / FLOATS_PER_VERTEX) as u32;
    for p in [v0, v1, v2] {
        mesh.verts.extend_from_slice(&[
            p[0], p[1], p[2], want_normal[0], want_normal[1], want_normal[2], color[0], color[1],
            color[2],
        ]);
    }
    mesh.indices.extend_from_slice(&[base, base + 1, base + 2]);
}

/// Extrudiert EINE Deckenplatte (Slab) und haengt sie an `mesh` an: Deckel (+Y),
/// Boden (−Y) — beide aus der Polygon-Triangulierung — plus die Mantelflaechen
/// (ein Quad je Umriss-Kante). Normalen werden robust nach aussen orientiert
/// (Deckel +Y, Boden −Y, Mantel weg vom Umriss-Schwerpunkt), sodass Culling und
/// Shading unabhaengig von der Umlaufrichtung des Umrisses stimmen.
pub fn extrude_slab(mesh: &mut Mesh, slab: &SlabInput) {
    let pts = &slab.outline;
    let n = pts.len();
    if n < 3 {
        return;
    }
    let y0 = slab.z_bottom.min(slab.z_top);
    let y1 = slab.z_bottom.max(slab.z_top);
    if (y1 - y0) < 1e-6 {
        return;
    }
    let tris = triangulate(pts);
    if tris.is_empty() {
        return;
    }
    let color = slab.color;
    // world-Position: model [x, y] -> (x, hoehe, y).
    let w = |g: Point2, y: f32| -> [f32; 3] { [g[0], y, g[1]] };

    // Deckel (+Y) und Boden (−Y) aus den Triangulierungs-Dreiecken.
    for t in tris.chunks_exact(3) {
        let a = pts[t[0] as usize];
        let b = pts[t[1] as usize];
        let c = pts[t[2] as usize];
        push_tri_oriented(mesh, w(a, y1), w(b, y1), w(c, y1), [0.0, 1.0, 0.0], color);
        push_tri_oriented(mesh, w(a, y0), w(b, y0), w(c, y0), [0.0, -1.0, 0.0], color);
    }

    // Umriss-Schwerpunkt (Grundriss) fuer die Aussenrichtung der Mantel-Normalen.
    let mut cx = 0.0f32;
    let mut cy = 0.0f32;
    for p in pts {
        cx += p[0];
        cy += p[1];
    }
    cx /= n as f32;
    cy /= n as f32;

    // Mantelflaechen: je Kante ein vertikales Quad (unten y0, oben y1).
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let ex = b[0] - a[0];
        let ez = b[1] - a[1];
        let elen = (ex * ex + ez * ez).sqrt();
        if elen < 1e-9 {
            continue; // entartete Kante
        }
        // Horizontale Kanten-Normale (senkrecht zur Kante), nach aussen orientiert.
        let mx = (a[0] + b[0]) * 0.5;
        let mz = (a[1] + b[1]) * 0.5;
        let out = [mx - cx, mz - cy];
        let mut nx = -ez / elen;
        let mut nz = ex / elen;
        if nx * out[0] + nz * out[1] < 0.0 {
            nx = -nx;
            nz = -nz;
        }
        let normal = [nx, 0.0, nz];
        let ba = w(a, y0);
        let bb = w(b, y0);
        let tb = w(b, y1);
        let ta = w(a, y1);
        // Als zwei orientierte Dreiecke (Winding via push_tri_oriented gesichert).
        push_tri_oriented(mesh, ba, bb, tb, normal, color);
        push_tri_oriented(mesh, ba, tb, ta, normal, color);
    }
}
