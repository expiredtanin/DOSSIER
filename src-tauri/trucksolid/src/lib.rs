// Profil-Extrusion via truck B-Rep. Erzeugt ein tesselliertes Mesh aus einem
// 2D-Polygon-Querschnitt (XY-Ebene, Modell-Meter) durch lineare Extrusion
// entlang +Z. Ausgabe ist kompatibel mit render3d::types::MeshInput.
//
// truck-Architektur:
//   truck_modeling::builder  — Vertex/Edge/Wire/Face bauen + tsweep (Validierung)
//   Tessellierung             — direkt aus den Eingangskoordinaten (Prismen-Geometrie)
// Bewusst NICHT genutzt: truck-modeling Booleans (instabil upstream).
// truck-polymesh wird nicht benötigt (keine Tess.-API für Solids in 0.3).

use serde::{Deserialize, Serialize};
use truck_modeling::*;

mod boolean;
pub mod brep;
pub use boolean::{boolean_mesh_core, BooleanMeshInput, BooleanMeshOutput};

/// Flaches [x0,y0, x1,y1, …] Array + Höhe → Extrusion.
#[derive(Deserialize)]
pub struct ExtrudePolyInput {
    pub points: Vec<f64>,
    pub height: f64,
    /// Verjüngung 0.0 (Prisma, Default) … 1.0 (Spitze/Kegel-Pyramide). Fehlt
    /// das Feld (ältere Aufrufer), greift serde-Default 0.0 — unverändertes
    /// Prisma-Verhalten.
    #[serde(default)]
    pub taper: f64,
}

/// Tesselliertes Mesh, kompatibel mit render3d::types::MeshInput.
/// positions: flat [x,y,z, …] in Modell-Metern; indices: Dreiecks-Indizes.
#[derive(Serialize)]
pub struct MeshOutput {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}

/// Extrudiert ein geschlossenes Polygon (≥3 Punkte) um `height` Meter nach +Z,
/// optional verjüngt (`taper` 0.0 Prisma … 1.0 Spitze/Kegel-Pyramide — linear
/// zum Schwerpunkt skaliert). Nutzt truck::builder zur Validierung der
/// Grundfläche; tesselliert dann direkt aus den Koordinaten.
pub fn extrude_polygon_core(
    pts: &[(f64, f64)],
    height: f64,
    taper: f64,
) -> std::result::Result<MeshOutput, String> {
    if pts.len() < 3 {
        return Err("min 3 Punkte".into());
    }
    if height <= 0.0 {
        return Err("height muss > 0 sein".into());
    }
    if !(0.0..=1.0).contains(&taper) {
        return Err("taper muss zwischen 0 und 1 liegen".into());
    }

    // Letzten Punkt entfernen falls er den ersten wiederholt (geschlossener Ring).
    let ring: Vec<(f64, f64)> = {
        let mut r = pts.to_vec();
        if r.len() >= 2 {
            let first = r[0];
            let last = *r.last().unwrap();
            if (first.0 - last.0).abs() < 1e-10 && (first.1 - last.1).abs() < 1e-10 {
                r.pop();
            }
        }
        r
    };
    if ring.len() < 3 {
        return Err("min 3 eindeutige Punkte".into());
    }
    let n = ring.len();

    // ── truck B-Rep: try_attach_plane validiert Planarität und Degenerierung ──
    let verts: Vec<Vertex> = ring
        .iter()
        .map(|&(x, y)| builder::vertex(Point3::new(x, y, 0.0)))
        .collect();
    let edges: Vec<Edge> = (0..n)
        .map(|i| builder::line(&verts[i], &verts[(i + 1) % n]))
        .collect();
    let wire = Wire::from_iter(edges);
    // Gibt Err zurück bei degeneriertem / nicht-ebenem Profil.
    let face = builder::try_attach_plane(&[wire]).map_err(|e| format!("{e}"))?;
    // tsweep erzeugt den Solid — wir nutzen ihn zur Vollständigkeit, auch wenn
    // wir ihn für die Tessellierung nicht direkt traversieren (nur fürs
    // ungetaperte Prisma sinnvoll validiert; Verjüngung ist reine Tessellierung).
    let _solid: Solid = builder::tsweep(&face, Vector3::new(0.0, 0.0, height));

    let centroid = polygon_centroid(&ring);

    // Deckel-/Boden-Triangulierung fuer BELIEBIGE (auch konkave) Profile per
    // Ohr-Clipping — NICHT per Fächer-ab-Vertex-0 (der nur fuer konvexe bzw.
    // von Vertex 0 aus sternfoermige Polygone korrekt ist; bei einem T-Traeger
    // o.ae. erzeugt ein Fächer Phantom-Dreiecke quer durch die konkave Kerbe).
    // `cap_tris` ist bereits in der Konvention orientiert, die der bisherige
    // "Fächer ab Vertex 0" fuer KONVEXE Ringe erzeugt hat (a,b,c mit
    // aufsteigendem Index), sodass die Deck-/Boden-Zuordnung unten unveraendert
    // bleibt.
    let cap_tris = ear_triangulate(&ring);

    // Volle Verjüngung (taper ≈ 1): Spitze statt entartetem Deck-Ring — Kegel/
    // Pyramide als n Boden-Vertices + 1 Spitzen-Vertex, sonst gäbe es
    // Nulldreiecke (Deckfläche + halbe Seitenflächen) mit Kreuzprodukt-Normale
    // (0,0,0) am Deck.
    if taper >= 1.0 - 1e-9 {
        let mut positions: Vec<f32> = Vec::with_capacity((n + 1) * 3);
        for &(x, y) in &ring {
            positions.extend_from_slice(&[x as f32, y as f32, 0.0_f32]);
        }
        positions.extend_from_slice(&[centroid.0 as f32, centroid.1 as f32, height as f32]);
        let apex = n as u32;

        let mut indices: Vec<u32> = Vec::with_capacity((cap_tris.len() + n) * 3);
        // Bodenfläche: wie im Prisma-Fall die zu "oben" umgekehrte Wicklung
        // (CCW von unten).
        for &(a, b, c) in &cap_tris {
            indices.extend_from_slice(&[a as u32, c as u32, b as u32]);
        }
        // Seitenflächen: ein Dreieck je Kante zur Spitze.
        for i in 0..n as u32 {
            let j = (i + 1) % n as u32;
            indices.extend_from_slice(&[i, j, apex]);
        }
        return Ok(MeshOutput { positions, indices });
    }

    // ── Tessellierung (Prisma bei taper=0, sonst Pyramidenstumpf) ──
    // Für ein n-Eck ergeben sich:
    //   Bodenfläche: len(cap_tris) Dreiecke (Ohr-Clipping, konkav-sicher)
    //   Deckfläche:  len(cap_tris) Dreiecke
    //   Seitenflächen: n * 2 Dreiecke (je Kante ein Rechteck → 2 Dreiecke)

    let mut positions: Vec<f32> = Vec::with_capacity(2 * n * 3);
    let mut indices: Vec<u32> = Vec::with_capacity((cap_tris.len() * 2 + n * 2) * 3);

    // Vertices: Boden (0..n-1) gefolgt von Dach (n..2n-1) — Dach zum
    // Schwerpunkt hin um (1-taper) skaliert (taper=0 ⇒ Prisma, unveränderte
    // Kontur; 0<taper<1 ⇒ Pyramidenstumpf).
    let scale = 1.0 - taper;
    for &(x, y) in &ring {
        positions.extend_from_slice(&[x as f32, y as f32, 0.0_f32]);
    }
    for &(x, y) in &ring {
        let tx = centroid.0 + (x - centroid.0) * scale;
        let ty = centroid.1 + (y - centroid.1) * scale;
        positions.extend_from_slice(&[tx as f32, ty as f32, height as f32]);
    }

    let base = 0u32;
    let top = n as u32;

    // Bodenfläche: umgekehrte Wicklung relativ zur Deckfläche (CCW von unten).
    for &(a, b, c) in &cap_tris {
        indices.extend_from_slice(&[base + a as u32, base + c as u32, base + b as u32]);
    }

    // Deckfläche: gleiche Wicklung wie `cap_tris` (CCW von oben).
    for &(a, b, c) in &cap_tris {
        indices.extend_from_slice(&[top + a as u32, top + b as u32, top + c as u32]);
    }

    // Seitenflächen: Rechteck pro Kante → 2 Dreiecke
    for i in 0..n as u32 {
        let j = (i + 1) % n as u32;
        // Unteres Dreieck
        indices.extend_from_slice(&[base + i, base + j, top + i]);
        // Oberes Dreieck
        indices.extend_from_slice(&[base + j, top + j, top + i]);
    }

    Ok(MeshOutput { positions, indices })
}

/// Signierte Fläche (Shoelace) — positiv bei CCW-Umlauf.
fn signed_area_f64(ring: &[(f64, f64)]) -> f64 {
    let n = ring.len();
    let mut a = 0.0;
    let mut j = n - 1;
    for i in 0..n {
        a += ring[j].0 * ring[i].1 - ring[i].0 * ring[j].1;
        j = i;
    }
    a * 0.5
}

/// Flächen-gewichteter Schwerpunkt eines einfachen Polygons (nicht der reine
/// Vertex-Mittelwert, der bei asymmetrischen/konkaven Profilen verzerrt ist).
/// Fallback auf Vertex-Mittelwert bei (nahezu) entarteter Fläche.
fn polygon_centroid(ring: &[(f64, f64)]) -> (f64, f64) {
    let n = ring.len();
    let a = signed_area_f64(ring);
    if a.abs() < 1e-12 {
        let (sx, sy) = ring.iter().fold((0.0, 0.0), |(sx, sy), &(x, y)| (sx + x, sy + y));
        return (sx / n as f64, sy / n as f64);
    }
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..n {
        let (x0, y0) = ring[i];
        let (x1, y1) = ring[(i + 1) % n];
        let cross = x0 * y1 - x1 * y0;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    (cx / (6.0 * a), cy / (6.0 * a))
}

/// Kreuzprodukt (b-a) x (c-a) im Grundriss.
#[inline]
fn cross2_f64(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// Liegt p im (a,b,c)-Dreieck? (CCW-orientiert).
fn point_in_tri_f64(a: (f64, f64), b: (f64, f64), c: (f64, f64), p: (f64, f64)) -> bool {
    let d1 = cross2_f64(a, b, p);
    let d2 = cross2_f64(b, c, p);
    let d3 = cross2_f64(c, a, p);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Ear-Clipping-Triangulierung eines einfachen (lochfreien) Rings — robust fuer
/// konvexe UND konkave Profile (z. B. T-Traeger, L-Profil, Freiform). Portiert
/// von `render3d::mesh::triangulate` (dort fuer Decken/Slabs genutzt) auf f64.
/// O(n^2), fuer Extrusionsprofile mit wenigen Ecken voellig ausreichend.
/// Liefert Dreiecke als (a,b,c)-Indextripel (0-basiert auf `ring`), in der
/// Wicklung des (intern auf CCW normalisierten) Rings.
fn ear_triangulate(ring: &[(f64, f64)]) -> Vec<(usize, usize, usize)> {
    let n = ring.len();
    if n < 3 {
        return Vec::new();
    }
    let mut idx: Vec<usize> = (0..n).collect();
    if signed_area_f64(ring) < 0.0 {
        idx.reverse();
    }

    let mut tris: Vec<(usize, usize, usize)> = Vec::new();
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
            let a = ring[i_prev];
            let b = ring[i_cur];
            let c = ring[i_next];
            if cross2_f64(a, b, c) <= 0.0 {
                continue; // konkav/kollinear -> kein Ohr
            }
            let mut contains = false;
            for &vi in &idx {
                if vi == i_prev || vi == i_cur || vi == i_next {
                    continue;
                }
                if point_in_tri_f64(a, b, c, ring[vi]) {
                    contains = true;
                    break;
                }
            }
            if contains {
                continue;
            }
            tris.push((i_prev, i_cur, i_next));
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break;
        }
    }
    if idx.len() == 3 {
        tris.push((idx[0], idx[1], idx[2]));
    }
    tris
}

/// Zylinder-Extrusion (Kreis-Querschnitt), optional verjüngt (Kegel bei
/// `taper=1.0`). Tesselliert den Kreis in N Segmente und ruft
/// `extrude_polygon_core` auf.
pub fn extrude_circle_core(
    cx: f64,
    cy: f64,
    r: f64,
    height: f64,
    taper: f64,
) -> std::result::Result<MeshOutput, String> {
    if r <= 0.0 {
        return Err("Radius muss > 0 sein".into());
    }
    let n = ((2.0 * std::f64::consts::PI * r / 0.02).ceil() as usize).max(16);
    let pts: Vec<(f64, f64)> = (0..n)
        .map(|i| {
            let a = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
            (cx + r * a.cos(), cy + r * a.sin())
        })
        .collect();
    extrude_polygon_core(&pts, height, taper)
}

// ── WASM-Bindings (nur mit Feature "web") ────────────────────────────────────

#[cfg(feature = "web")]
mod web {
    use super::*;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(start)]
    pub fn init() {
        console_error_panic_hook::set_once();
    }

    /// Extrudiert ein Polygon-Profil.
    /// Input JSON: `{ "points": [x0,y0,…], "height": 2.5 }`
    /// Output JSON: `{ "positions": […], "indices": […] }` oder JsError.
    #[wasm_bindgen]
    pub fn extrude_polygon(input_json: &str) -> std::result::Result<String, JsError> {
        let input: ExtrudePolyInput =
            serde_json::from_str(input_json).map_err(|e| JsError::new(&e.to_string()))?;
        if input.points.len() % 2 != 0 {
            return Err(JsError::new("points muss x/y-Paare enthalten"));
        }
        let pts: Vec<(f64, f64)> = input
            .points
            .chunks(2)
            .map(|c| (c[0], c[1]))
            .collect();
        let mesh = extrude_polygon_core(&pts, input.height, input.taper)
            .map_err(|e| JsError::new(&e.to_string()))?;
        serde_json::to_string(&mesh).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Extrudiert einen Kreis-Querschnitt (Zylinder, oder Kegel bei `taper=1`).
    /// Input JSON: `{ "cx": 0, "cy": 0, "r": 0.15, "height": 3.0, "taper": 0.0 }`
    #[wasm_bindgen]
    pub fn extrude_circle(input_json: &str) -> std::result::Result<String, JsError> {
        #[derive(serde::Deserialize)]
        struct In {
            cx: f64,
            cy: f64,
            r: f64,
            height: f64,
            #[serde(default)]
            taper: f64,
        }
        let i: In =
            serde_json::from_str(input_json).map_err(|e| JsError::new(&e.to_string()))?;
        let mesh = extrude_circle_core(i.cx, i.cy, i.r, i.height, i.taper)
            .map_err(|e| JsError::new(&e.to_string()))?;
        serde_json::to_string(&mesh).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Volumen, Oberfläche, Schwerpunkt, Hülle und Dichtheit eines Körpers.
    /// Input JSON: `{ "spec": {…}, "tol": 0.005 }`
    #[wasm_bindgen]
    pub fn solid_props(input_json: &str) -> std::result::Result<String, JsError> {
        #[derive(serde::Deserialize)]
        struct In {
            spec: brep::SolidSpec,
            #[serde(default = "tol")]
            tol: f64,
        }
        fn tol() -> f64 {
            0.005
        }
        let i: In = serde_json::from_str(input_json).map_err(|e| JsError::new(&e.to_string()))?;
        let p = brep::solid_props_core(&i.spec, i.tol).map_err(|e| JsError::new(&e))?;
        serde_json::to_string(&p).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Kollisionsprüfung zweier Körper (Durchdringungslinien + Überlappungsvolumen).
    /// Input JSON: `{ "a": {…}, "b": {…}, "tol": 0.01, "maxLines": 200 }`
    #[wasm_bindgen]
    pub fn solid_clash(input_json: &str) -> std::result::Result<String, JsError> {
        #[derive(serde::Deserialize)]
        struct In {
            a: brep::SolidSpec,
            b: brep::SolidSpec,
            #[serde(default = "tol")]
            tol: f64,
            #[serde(default = "max_lines", rename = "maxLines")]
            max_lines: usize,
        }
        fn tol() -> f64 {
            0.01
        }
        fn max_lines() -> usize {
            200
        }
        let i: In = serde_json::from_str(input_json).map_err(|e| JsError::new(&e.to_string()))?;
        let r = brep::clash_core(&i.a, &i.b, i.tol, i.max_lines).map_err(|e| JsError::new(&e))?;
        serde_json::to_string(&r).map_err(|e| JsError::new(&e.to_string()))
    }

    /// B-Rep-Körper aus einer Spezifikation (s. `brep::SolidSpec`) → Mesh.
    /// Input JSON: `{ "spec": {kind:"extrude",…}, "tol": 0.01 }`
    #[wasm_bindgen]
    pub fn build_solid_mesh(input_json: &str) -> std::result::Result<String, JsError> {
        #[derive(serde::Deserialize)]
        struct In {
            spec: brep::SolidSpec,
            #[serde(default = "default_tol")]
            tol: f64,
        }
        fn default_tol() -> f64 {
            0.01
        }
        let i: In = serde_json::from_str(input_json).map_err(|e| JsError::new(&e.to_string()))?;
        let mesh = brep::solid_mesh_core(&i.spec, i.tol).map_err(|e| JsError::new(&e))?;
        serde_json::to_string(&mesh).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Exportiert Körper als STEP-Text (ISO 10303-42).
    /// Input JSON: `{ "solids": [spec, …], "fileName": "haus.stp", "organizationSystem": "dossier" }`
    #[wasm_bindgen]
    pub fn export_step(input_json: &str) -> std::result::Result<String, JsError> {
        #[derive(serde::Deserialize)]
        struct In {
            solids: Vec<brep::SolidSpec>,
            #[serde(default, rename = "fileName")]
            file_name: String,
            #[serde(default, rename = "organizationSystem")]
            organization_system: String,
        }
        let i: In = serde_json::from_str(input_json).map_err(|e| JsError::new(&e.to_string()))?;
        brep::export_step_core(
            &i.solids,
            &brep::StepHeader { file_name: i.file_name, organization_system: i.organization_system },
        )
        .map_err(|e| JsError::new(&e))
    }

    /// Liest STEP-Text und tesselliert alle Körper (`relTol` = Toleranz relativ zur
    /// Bounding-Box-Diagonale, Default 0.001). Flacher Puffer für den Kern (`import_step.rs`):
    /// `[1, n, (np, ni, Positionen…, Indizes…) je Körper]`, Positionen als f32 in f64 geweitet.
    #[wasm_bindgen]
    pub fn import_step_flat(text: &str, rel_tol: f64) -> std::result::Result<Vec<f64>, JsError> {
        let meshes = brep::import_step_core(text, rel_tol).map_err(|e| JsError::new(&e))?;
        Ok(brep::step_meshes_flat(&meshes))
    }

    /// Boolesche Operation zwischen zwei Dreiecks-Meshes (Mesh-Ebenen-CSG via
    /// csgrs). Input JSON: `{ "a_positions": […], "a_indices": […],
    /// "b_positions": […], "b_indices": […], "op": "union"|"difference"|"intersection" }`
    /// Output JSON: `{ "positions": […], "indices": […], "empty": bool }`
    #[wasm_bindgen]
    pub fn boolean_mesh(input_json: &str) -> std::result::Result<String, JsError> {
        let input: BooleanMeshInput =
            serde_json::from_str(input_json).map_err(|e| JsError::new(&e.to_string()))?;
        let mesh = boolean_mesh_core(
            &input.a_positions,
            &input.a_indices,
            &input.b_positions,
            &input.b_indices,
            &input.op,
        )
        .map_err(|e| JsError::new(&e))?;
        serde_json::to_string(&mesh).map_err(|e| JsError::new(&e.to_string()))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quad_extrusion_vertex_count() {
        let pts = vec![(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
        let m = extrude_polygon_core(&pts, 2.0, 0.0).unwrap();
        // 2 * 4 = 8 Vertices → 24 Floats
        assert_eq!(m.positions.len(), 8 * 3, "Vertex-Anzahl");
        assert_eq!(m.indices.len() % 3, 0, "unvollständige Dreiecke");
        // Quader: 2*(4-2) + 4*2 = 4 + 8 = 12 Dreiecke
        assert_eq!(m.indices.len(), 12 * 3, "Dreieck-Anzahl für Quader");
    }

    #[test]
    fn l_profile_extrusion() {
        let pts = vec![
            (0.0, 0.0),
            (0.3, 0.0),
            (0.3, 0.1),
            (0.1, 0.1),
            (0.1, 0.3),
            (0.0, 0.3),
        ];
        let m = extrude_polygon_core(&pts, 3.0, 0.0).unwrap();
        assert_eq!(m.indices.len() % 3, 0);
        assert!(!m.positions.is_empty());
    }

    #[test]
    fn cylinder_extrusion() {
        let m = extrude_circle_core(0.0, 0.0, 0.15, 3.0, 0.0).unwrap();
        assert_eq!(m.indices.len() % 3, 0);
        assert!(!m.positions.is_empty());
    }

    #[test]
    fn rejects_too_few_points() {
        assert!(extrude_polygon_core(&[(0.0, 0.0), (1.0, 0.0)], 1.0, 0.0).is_err());
    }

    #[test]
    fn rejects_zero_height() {
        let pts = vec![(0.0, 0.0), (1.0, 0.0), (0.5, 1.0)];
        assert!(extrude_polygon_core(&pts, 0.0, 0.0).is_err());
    }

    #[test]
    fn rejects_taper_out_of_range() {
        let pts = vec![(0.0, 0.0), (1.0, 0.0), (0.5, 1.0)];
        assert!(extrude_polygon_core(&pts, 1.0, 1.5).is_err());
        assert!(extrude_polygon_core(&pts, 1.0, -0.1).is_err());
    }

    /// Kegel-Volumen (taper=1, Kreis-Querschnitt) via Divergenzsatz gegen die
    /// analytische Formel V = π·r²·h/3 geprüft.
    #[test]
    fn cone_taper_one_has_correct_volume() {
        let r = 0.5;
        let h = 2.0;
        let m = extrude_circle_core(0.0, 0.0, r, h, 1.0).unwrap();
        // Spitze ist der letzte Vertex — Boden-Vertices sind alle bei z=0, kein
        // separater Deck-Ring mehr (kein Nulldreieck-Risiko).
        assert_eq!(m.positions.len() % 3, 0);
        let n_verts = m.positions.len() / 3;
        // Boden-N-Eck + 1 Spitze.
        let apex_z = m.positions[(n_verts - 1) * 3 + 2];
        assert!((apex_z as f64 - h).abs() < 1e-6, "Spitze muss bei z=height liegen");

        let mut vol = 0.0f64;
        for tri in m.indices.chunks(3) {
            let mut p = [[0.0f64; 3]; 3];
            for (k, &i) in tri.iter().enumerate() {
                let o = i as usize * 3;
                p[k] = [m.positions[o] as f64, m.positions[o + 1] as f64, m.positions[o + 2] as f64];
            }
            vol += (p[0][0] * (p[1][1] * p[2][2] - p[2][1] * p[1][2])
                - p[0][1] * (p[1][0] * p[2][2] - p[2][0] * p[1][2])
                + p[0][2] * (p[1][0] * p[2][1] - p[2][0] * p[1][1]))
                / 6.0;
        }
        let expected = std::f64::consts::PI * r * r * h / 3.0;
        // Kreis ist n-eck-tesselliert (nicht analytisch exakt) → grobe Toleranz.
        assert!((vol.abs() - expected).abs() / expected < 0.01, "Kegel-Volumen: {} vs {}", vol.abs(), expected);
    }

    /// Pyramidenstumpf (taper=0.5, Quadrat-Querschnitt): Deckfläche muss auf
    /// die Hälfte der Kantenlänge geschrumpft sein, zentriert um den
    /// Schwerpunkt der Grundfläche.
    #[test]
    fn frustum_taper_half_shrinks_top_toward_centroid() {
        let pts = vec![(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];
        let m = extrude_polygon_core(&pts, 1.0, 0.5).unwrap();
        // Prisma-Topologie bleibt erhalten (2n Vertices, kein Spitzen-Sonderfall).
        assert_eq!(m.positions.len(), 8 * 3);
        // Deck-Ring: Vertices 4..7. Schwerpunkt der Grundfläche ist (1,1).
        // scale=0.5 ⇒ Ecke (0,0)→(1,1)+0.5*((0,0)-(1,1))=(0.5,0.5).
        let top0 = (m.positions[4 * 3] as f64, m.positions[4 * 3 + 1] as f64);
        assert!((top0.0 - 0.5).abs() < 1e-6 && (top0.1 - 0.5).abs() < 1e-6, "Deck-Ecke: {:?}", top0);
    }

    /// Punkt-in-Polygon (Ray-Casting) für die Korrektheits-Prüfung unten.
    fn point_in_polygon(p: (f64, f64), poly: &[(f64, f64)]) -> bool {
        let n = poly.len();
        let mut inside = false;
        let mut j = n - 1;
        for i in 0..n {
            let (xi, yi) = poly[i];
            let (xj, yj) = poly[j];
            if ((yi > p.1) != (yj > p.1)) && (p.0 < (xj - xi) * (p.1 - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
            j = i;
        }
        inside
    }

    /// T-Träger-Querschnitt (konkav, NICHT von Vertex 0 aus sternförmig) —
    /// genau das Zielprofil aus PENDENZEN/truck-plan.md. Eine Fächer-Triangu-
    /// lierung ab Vertex 0 erzeugt hier Phantom-Dreiecke quer durch die
    /// konkave Kerbe (nachgerechnet: 2 von 6 Fächer-Dreiecken liegen mit ihrem
    /// Schwerpunkt ausserhalb des Profils). Regressionstest fürs Ohr-Clipping.
    #[test]
    fn t_beam_caps_stay_inside_polygon() {
        let pts = vec![
            (1.0, 0.0),
            (2.0, 0.0),
            (2.0, 1.0),
            (3.0, 1.0),
            (3.0, 2.0),
            (0.0, 2.0),
            (0.0, 1.0),
            (1.0, 1.0),
        ];
        let m = extrude_polygon_core(&pts, 1.0, 0.0).unwrap();
        let mut checked = 0;
        for tri in m.indices.chunks(3) {
            let p: Vec<[f32; 3]> = tri
                .iter()
                .map(|&i| {
                    let o = i as usize * 3;
                    [m.positions[o], m.positions[o + 1], m.positions[o + 2]]
                })
                .collect();
            // Nur Deckel/Boden (alle 3 Ecken auf derselben Höhe) prüfen, nicht
            // die Seitenwand-Quads (die spannen z zwischen 0 und height).
            if (p[0][2] - p[1][2]).abs() > 1e-6 || (p[1][2] - p[2][2]).abs() > 1e-6 {
                continue;
            }
            let centroid = (
                (p[0][0] + p[1][0] + p[2][0]) as f64 / 3.0,
                (p[0][1] + p[1][1] + p[2][1]) as f64 / 3.0,
            );
            assert!(
                point_in_polygon(centroid, &pts),
                "Deckel-/Boden-Dreieck-Schwerpunkt {:?} liegt ausserhalb des T-Profils",
                centroid
            );
            checked += 1;
        }
        assert!(checked > 0, "kein Deckel-/Boden-Dreieck gefunden");
    }
}
