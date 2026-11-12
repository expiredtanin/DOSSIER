// [180] Geisterschicht: Elemente, deren Klasse im Darstellungsmodus „grau" steht, zeichnet der Viewer gedämpft
// und durchscheinend über dem Modell — das 3D-Gegenstück zum gedimmten Hintergrund des Grundrisses.
//
// Die Eingabe ist ein gewöhnliches Modell (Format `set_model`, vom Kern mit `{"grey": …, "ghost": true}` nur aus
// den grauen Elementen gebaut). Vernetzt wird es mit derselben `Scene` wie das Hauptmodell (gleiche Dreiecke,
// gleiche Feature-Kanten), dann in die Puffer der durchscheinenden Pipeline umgesetzt (`gpu::ghost_pipeline`,
// dieselbe wie die zulässige Hülle [63]: Dreiecke `[x y z r g b a]`, Kanten als LineList `[x y z r g b]`).
//
// Farbe: hell und entsättigt statt der Bauteilfarbe, durchscheinend statt deckend. Begründung: Im Grundriss
// werden graue Klassen mit weisser Füllung, grauen Linien und Deckkraft 0.45 gezeichnet (`greyedCopy`,
// `primitives.tsx`) — Hintergrund, der die aktiven Bauteile nicht verdeckt. Deckend hellgrau würde im 3D die
// aktiven Bauteile dahinter verstecken; durchscheinend mit hellgrauen Kanten bleibt die Form lesbar (Kanten),
// das Aktive sichtbar. Die Helligkeit der Bauteilfarbe bleibt schwach erhalten (dunkle Bauteile etwas dunkler),
// dazu eine leichte, feste Schattierung nach der Flächennormalen, damit Flächen verschiedener Richtung
// unterscheidbar bleiben (die Pipeline ist unbeleuchtet).
//
// GPU-frei (nur `Vec<f32>`), per `cargo test` prüfbar.

use crate::edges::EDGE_FLOATS_PER_VERTEX;
use crate::scene::{ChunkData, PartInput, Scene};
use crate::types::FLOATS_PER_VERTEX;

/// f32 je Dreiecks-Vertex der Geisterschicht (wie `gpu::GHOST_FLOATS_PER_VERTEX`).
pub const GHOST_TRI_FLOATS: usize = 7;

/// Deckkraft der grauen Flächen (Grundriss: 0.45 auf weisser Fläche; im 3D überlagern sich mehrere Flächen
/// hintereinander, daher etwas weniger).
pub const GHOST_ALPHA: f32 = 0.2;

/// Farbe der Kanten grauer Elemente (Grundriss: graue Linien statt der Bauteilfarbe).
pub const GHOST_EDGE_COLOR: [f32; 3] = [0.62, 0.63, 0.65];

/// Feste Richtung der Flächen-Schattierung (zum Licht, normiert beim Gebrauch).
const SHADE_DIR: [f32; 3] = [0.35, 0.85, 0.4];

/// Helle, entsättigte Farbe zu einer Bauteilfarbe `rgb` auf einer Fläche mit Normale `n`.
pub fn ghost_color(rgb: [f32; 3], n: [f32; 3]) -> [f32; 3] {
    let lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    let base = 0.78 + 0.14 * lum.clamp(0.0, 1.0);
    let l = (SHADE_DIR[0] * SHADE_DIR[0] + SHADE_DIR[1] * SHADE_DIR[1] + SHADE_DIR[2] * SHADE_DIR[2]).sqrt();
    let d = ((n[0] * SHADE_DIR[0] + n[1] * SHADE_DIR[1] + n[2] * SHADE_DIR[2]) / l).abs();
    let shade = if d.is_finite() { 0.88 + 0.12 * d } else { 1.0 };
    // Leicht kühler Ton wie die grauen Linien im Grundriss.
    [base * shade * 0.98, base * shade * 0.99, base * shade]
}

/// Dreiecke (`GHOST_TRI_FLOATS` je Vertex, TriangleList ohne Index) und Kanten (LineList) der Geisterschicht.
pub fn ghost_buffers(part: PartInput) -> (Vec<f32>, Vec<f32>) {
    let mut scene = Scene::new();
    scene.set_model(part);
    let mut tris = Vec::new();
    let mut lines = Vec::new();
    for c in 0..scene.chunk_count() {
        let (t, l) = chunk_ghost_buffers(&scene.chunk_data(c));
        tris.extend(t);
        lines.extend(l);
    }
    (tris, lines)
}

/// [214] Dreiecke und Kanten eines Klumpens der Geisterschicht (Formate wie [`ghost_buffers`]); die GPU-Schicht
/// setzt damit nach einem Teil-Update nur die geänderten Klumpen neu (`gpu::Renderer::update_ghost_parts`).
pub fn chunk_ghost_buffers(data: &ChunkData) -> (Vec<f32>, Vec<f32>) {
    let v = &data.mesh.verts;
    let mut tris = Vec::with_capacity(data.mesh.indices.len() * GHOST_TRI_FLOATS);
    for &i in &data.mesh.indices {
        let b = i as usize * FLOATS_PER_VERTEX;
        let Some(x) = v.get(b..b + FLOATS_PER_VERTEX) else { continue };
        let col = ghost_color([x[6], x[7], x[8]], [x[3], x[4], x[5]]);
        tris.extend_from_slice(&[x[0], x[1], x[2], col[0], col[1], col[2], GHOST_ALPHA]);
    }
    let mut lines = Vec::with_capacity(data.edges.len());
    for e in data.edges.chunks_exact(EDGE_FLOATS_PER_VERTEX) {
        lines.extend_from_slice(&[e[0], e[1], e[2], GHOST_EDGE_COLOR[0], GHOST_EDGE_COLOR[1], GHOST_EDGE_COLOR[2]]);
    }
    (tris, lines)
}

/// 2D-Spuren grauer Klassen (LineList `[x y z r g b]` je Vertex, Kern `drawing_line_verts`) gedämpft: die Farbe der
/// Linie weicht der Kantenfarbe der Geisterschicht, die Lage bleibt. Unvollständige Reste am Ende fallen weg.
pub fn mute_lines(verts: &[f32]) -> Vec<f32> {
    let mut out = verts[..verts.len() / EDGE_FLOATS_PER_VERTEX * EDGE_FLOATS_PER_VERTEX].to_vec();
    for v in out.chunks_exact_mut(EDGE_FLOATS_PER_VERTEX) {
        v[3..6].copy_from_slice(&GHOST_EDGE_COLOR);
    }
    out
}

/// Flächenmuster grauer Klassen (`pattern_lines::PATTERN_STRIDE` je Linie, Farbe an Stelle 6..9) gedämpft: Farbe
/// wie [`mute_lines`], Lage und LOD-Maske bleiben.
pub fn mute_pattern(data: &[f32]) -> Vec<f32> {
    use crate::pattern_lines::PATTERN_STRIDE;
    let mut out = data[..data.len() / PATTERN_STRIDE * PATTERN_STRIDE].to_vec();
    for l in out.chunks_exact_mut(PATTERN_STRIDE) {
        l[6..9].copy_from_slice(&GHOST_EDGE_COLOR);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::WallInput;

    fn wall() -> WallInput {
        serde_json::from_value(serde_json::json!({
            "start": [0.0, 0.0], "end": [4.0, 0.0], "thickness": 0.2, "height": 2.5, "baseElevation": 0.0, "color": [0.8, 0.2, 0.1]
        }))
        .unwrap()
    }

    #[test]
    fn leeres_modell_leere_schicht() {
        let (t, l) = ghost_buffers(PartInput::default());
        assert!(t.is_empty() && l.is_empty());
    }

    #[test]
    fn wand_wird_hell_entsaettigt_und_durchscheinend() {
        let (t, l) = ghost_buffers(PartInput { walls: vec![wall()], ..Default::default() });
        assert!(!t.is_empty() && t.len() % (3 * GHOST_TRI_FLOATS) == 0, "ganze Dreiecke");
        assert!(!l.is_empty() && l.len() % (2 * EDGE_FLOATS_PER_VERTEX) == 0, "Kanten des Quaders");
        for v in t.chunks_exact(GHOST_TRI_FLOATS) {
            let (r, g, b, a) = (v[3], v[4], v[5], v[6]);
            assert_eq!(a, GHOST_ALPHA);
            // Hell und (fast) unbunt, obwohl die Wand rot ist.
            assert!(r > 0.6 && g > 0.6 && b > 0.6, "{r} {g} {b}");
            assert!((r - g).abs() < 0.03 && (g - b).abs() < 0.03, "entsättigt: {r} {g} {b}");
        }
        for v in l.chunks_exact(EDGE_FLOATS_PER_VERTEX) {
            assert_eq!([v[3], v[4], v[5]], GHOST_EDGE_COLOR);
        }
        // Die Lage stimmt mit dem Wandquader überein (x 0..4, Höhe 0..2.5).
        let xs: Vec<f32> = t.chunks_exact(GHOST_TRI_FLOATS).map(|v| v[0]).collect();
        let ys: Vec<f32> = t.chunks_exact(GHOST_TRI_FLOATS).map(|v| v[1]).collect();
        assert!(xs.iter().all(|&x| (-0.2..=4.2).contains(&x)) && ys.iter().cloned().fold(0.0, f32::max) > 2.4);
    }

    #[test]
    fn dunkle_bauteile_bleiben_etwas_dunkler() {
        let n = [0.0, 1.0, 0.0];
        let hell = ghost_color([1.0, 1.0, 1.0], n);
        let dunkel = ghost_color([0.0, 0.0, 0.0], n);
        assert!(hell[0] > dunkel[0] && dunkel[0] > 0.6);
        assert!(ghost_color([0.5, 0.5, 0.5], [f32::NAN, 0.0, 0.0]).iter().all(|c| c.is_finite()));
    }

    /// [214] Teil-Update der Geisterschicht: die Klumpen nach dem Update ergeben dieselben Dreiecke und Kanten wie ein
    /// Vollaufbau des neuen Stands, und nur die Klumpen des geänderten Teils sind neu.
    #[test]
    fn teil_update_gleich_vollaufbau() {
        use crate::scene::{PartEntry, PartsUpdate};
        let at = |x: f32, y: f32| -> WallInput {
            let mut w = wall();
            w.start = [x, y];
            w.end = [x + 4.0, y];
            w
        };
        let parts = |shift: f32| -> Vec<PartEntry> {
            (0..6).map(|i| PartEntry::new(&format!("w{i}"), PartInput { walls: vec![at(if i == 3 { shift } else { 0.0 }, 3.0 * i as f32)], ..Default::default() })).collect()
        };
        let sorted = |v: Vec<f32>, n: usize| {
            let mut g: Vec<Vec<i64>> = v.chunks_exact(n).map(|c| c.iter().map(|x| (x * 1e4).round() as i64).collect()).collect();
            g.sort();
            g
        };
        let all = |s: &Scene| {
            let (mut t, mut l) = (Vec::new(), Vec::new());
            for c in 0..s.chunk_count() {
                let (a, b) = chunk_ghost_buffers(&s.chunk_data(c));
                t.extend(a);
                l.extend(b);
            }
            (sorted(t, 3 * GHOST_TRI_FLOATS), sorted(l, 2 * EDGE_FLOATS_PER_VERTEX))
        };
        let mut s = Scene::new();
        s.apply(PartsUpdate { reset: true, remove: vec![], upsert: parts(0.0) });
        let ch = s.apply(PartsUpdate { reset: false, remove: vec![], upsert: vec![parts(1.5).remove(3)] });
        assert_eq!((ch.remeshed, ch.dirty_chunks.len()), (1, 1), "nur der geänderte Teil");
        let mut full = Scene::new();
        full.apply(PartsUpdate { reset: true, remove: vec![], upsert: parts(1.5) });
        assert_eq!(all(&s), all(&full));
        // Dasselbe wie die bisherige Ganz-Umsetzung.
        let mut whole = PartInput::default();
        for e in parts(1.5) {
            whole.walls.extend(e.walls);
        }
        let (t, l) = ghost_buffers(whole);
        assert_eq!(all(&s), (sorted(t, 3 * GHOST_TRI_FLOATS), sorted(l, 2 * EDGE_FLOATS_PER_VERTEX)));
    }

    #[test]
    fn spuren_und_muster_werden_gedaempft() {
        let l = mute_lines(&[1.0, 2.0, 3.0, 1.0, 0.0, 0.0, 4.0, 5.0, 6.0, 0.0, 0.0, 1.0, 9.0, 9.0]);
        assert_eq!(l.len(), 12, "unvollständiger Rest fällt weg");
        assert_eq!(&l[..3], &[1.0, 2.0, 3.0]);
        assert_eq!(&l[3..6], &GHOST_EDGE_COLOR);
        assert_eq!(&l[9..12], &GHOST_EDGE_COLOR);
        let m = mute_pattern(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 5.0, 7.0]);
        assert_eq!(m.len(), 10);
        assert_eq!(&m[6..9], &GHOST_EDGE_COLOR);
        assert_eq!((m[3], m[9]), (1.0, 5.0), "Lage und Maske bleiben");
        assert!(mute_lines(&[]).is_empty() && mute_pattern(&[]).is_empty());
    }
}
