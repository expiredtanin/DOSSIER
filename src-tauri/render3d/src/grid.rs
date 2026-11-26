// Referenz-Bodengitter (Ground-Grid) fuer den 3D-Renderer.
//
// Erzeugt CPU-seitig die Linien-Vertices eines quadratischen Referenzgitters in
// der Welt-XZ-Ebene (Grundriss-Ebene), zentriert um den Welt-Ursprung
// (x=0, z=0), auf konstanter Hoehe `y = elevation`. Damit hat der 3D-Viewport
// einen dezenten Boden + raeumliche Orientierung.
//
// KOORDINATEN (wie types.rs): Welt-Y ist die Hoehe, XZ die Grundriss-Ebene. Das
// Gitter liegt also flach in XZ auf konstantem y = elevation.
//
// Diese Schicht ist GPU-frei (nur `Vec<f32>`), damit sie headless per `cargo
// test` pruefbar bleibt (Muster: mesh.rs/section.rs). Die GPU-Schicht (gpu.rs)
// laedt die erzeugten Vertices in einen Linien-Vertex-Buffer und zeichnet sie
// ueber eine eigene `LineList`-Pipeline (shaders::GRID_WGSL).

/// f32 je Gitter-Vertex im interleaved Puffer: 3 Position (world) + 3 Farbe (rgb).
pub const GRID_FLOATS_PER_VERTEX: usize = 6;

/// Farbe einer normalen ("Minor") Gitterlinie (RGB 0..1). Gedecktes Neutralgrau,
/// das sich vom hellen Hintergrund (#f5f5f5) und vom Modell (~0.8er Grau) abhebt,
/// ohne zu dominieren. (Spiegel der Konstanten in `shaders::GROUND_GRID_WGSL`.)
pub const MINOR_COLOR: [f32; 3] = [0.72, 0.72, 0.74];

/// Farbe einer "Major"-Linie (jede 5. Linie, inkl. Mittelachse): etwas kraeftiger
/// (dunkler) als Minor, damit die Rasterweite ablesbar bleibt.
pub const MAJOR_COLOR: [f32; 3] = [0.55, 0.55, 0.58];

/// Jede n-te Linie (vom Zentrum aus gezaehlt) ist eine Major-Linie.
pub const MAJOR_EVERY: i32 = 5;

/// Anzahl der Gitterlinien PRO Richtung fuer gegebene Ausdehnung/Weite.
///
/// Linien sitzen bei `i * spacing` fuer `i` in `-steps..=steps`, wobei
/// `steps = floor((extent/2) / spacing)`. Ergebnis ist damit immer ungerade
/// (die Mittelachse `i = 0` ist stets dabei). 0, falls Parameter unbrauchbar.
pub fn line_count(extent: f32, spacing: f32) -> usize {
    if !(extent > 0.0) || !(spacing > 0.0) {
        return 0;
    }
    let steps = ((extent * 0.5) / spacing).floor() as i32;
    if steps < 0 {
        return 0;
    }
    (2 * steps + 1) as usize
}

/// [333] Baut die Bodenfläche des Gitters: EIN Quadrat (zwei Dreiecke, 6 Vertices) in der Welt-XZ-Ebene auf
/// `y = elevation`, Halb-Ausdehnung `steps * spacing` (auf ein ganzes Vielfaches der Weite gerundet). Die Linien
/// zeichnet der Shader (`shaders::GROUND_GRID_WGSL`) je Pixel: geglättet, etwa ein Pixel breit, Meterlinien blenden aus,
/// wo sie zu dicht stehen (sonst Moiré zum Horizont), weicher Rand. Zuvor 2·n Linien ohne Glättung.
///
/// Vertex-Layout wie die Linien (`GRID_FLOATS_PER_VERTEX`): Position (world) + `[spacing, half, MAJOR_EVERY]` im
/// Farb-Slot (der Shader liest daraus die Rasterweite). Leerer Vektor bei unbrauchbaren Parametern.
pub fn build_ground_grid(elevation: f32, extent: f32, spacing: f32) -> Vec<f32> {
    let n = line_count(extent, spacing);
    if n == 0 {
        return Vec::new();
    }
    let half = ((n as i32 - 1) / 2) as f32 * spacing;
    let params = [spacing, half, MAJOR_EVERY as f32];
    let mut verts = Vec::with_capacity(6 * GRID_FLOATS_PER_VERTEX);
    for (x, z) in [(-half, -half), (half, -half), (half, half), (-half, -half), (half, half), (-half, half)] {
        verts.extend_from_slice(&[x, elevation, z]);
        verts.extend_from_slice(&params);
    }
    verts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_count_inclusive_and_odd() {
        // extent 20, spacing 1 -> steps 10 -> 21 Linien je Richtung.
        assert_eq!(line_count(20.0, 1.0), 21);
        // extent 10, spacing 2 -> steps 2 (half=5, 5/2=2.5 floor 2) -> 5 Linien.
        assert_eq!(line_count(10.0, 2.0), 5);
        // Mittelachse immer dabei -> ungerade.
        assert_eq!(line_count(3.0, 1.0) % 2, 1);
    }

    #[test]
    fn degenerate_params_yield_empty() {
        assert_eq!(line_count(0.0, 1.0), 0);
        assert_eq!(line_count(20.0, 0.0), 0);
        assert_eq!(line_count(-5.0, 1.0), 0);
        assert!(build_ground_grid(0.0, 0.0, 1.0).is_empty());
        assert!(build_ground_grid(0.0, 20.0, 0.0).is_empty());
        assert!(build_ground_grid(0.0, f32::NAN, 1.0).is_empty());
    }

    /// [333] Ein Quadrat auf der Höhe, Halb-Ausdehnung auf die Weite gerundet, Rasterparameter in jedem Vertex.
    #[test]
    fn quadrat_auf_hoehe_mit_rasterparametern() {
        let verts = build_ground_grid(2.7, 21.0, 2.0); // steps = floor(10.5/2) = 5 -> half = 10
        assert_eq!(verts.len(), 6 * GRID_FLOATS_PER_VERTEX);
        let mut area = 0.0;
        for t in verts.chunks(3 * GRID_FLOATS_PER_VERTEX) {
            let p: Vec<[f32; 2]> = t.chunks(GRID_FLOATS_PER_VERTEX).map(|v| [v[0], v[2]]).collect();
            area += 0.5 * ((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])).abs();
        }
        assert_eq!(area, 400.0, "zwei Dreiecke decken das Quadrat 20 × 20");
        for v in verts.chunks(GRID_FLOATS_PER_VERTEX) {
            assert_eq!(v[1], 2.7);
            assert_eq!((v[0].abs(), v[2].abs()), (10.0, 10.0));
            assert_eq!(&v[3..6], &[2.0, 10.0, MAJOR_EVERY as f32]);
        }
    }
}
