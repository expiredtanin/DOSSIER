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
/// ohne zu dominieren.
pub const MINOR_COLOR: [f32; 3] = [0.72, 0.72, 0.74];

/// Farbe einer "Major"-Linie (jede 5. Linie, inkl. Mittelachse): etwas kraeftiger
/// (dunkler) als Minor, damit die Rasterweite ablesbar bleibt. Auf dem hellen
/// Hintergrund liest sich "dunkler = betonter" am besten (CAD-uebliche Optik).
pub const MAJOR_COLOR: [f32; 3] = [0.55, 0.55, 0.58];

/// Jede n-te Linie (vom Zentrum aus gezaehlt) wird als Major-Linie eingefaerbt.
const MAJOR_EVERY: i32 = 5;

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

/// Baut die Linien-Vertices (Positions + Farbe, interleaved) fuer das Bodengitter.
///
/// - Quadratisches Raster in der Welt-XZ-Ebene, zentriert um (0,0), auf `y = elevation`.
/// - `extent` = Gesamt-Kantenlaenge (Meter); tatsaechlich genutzte Halb-Ausdehnung
///   ist `steps * spacing` (auf ein ganzes Vielfaches der Weite gerundet), damit
///   das Gitter ein sauberes Quadrat bildet, dessen Linien sich an den Ecken treffen.
/// - `spacing` = Linienabstand (Meter).
/// - Jede `MAJOR_EVERY`-te Linie (inkl. Mittelachse) bekommt `MAJOR_COLOR`, sonst `MINOR_COLOR`.
///
/// Ausgabe: `LineList`-Vertices (je 2 aufeinanderfolgende Vertices = 1 Segment),
/// interleaved `[px,py,pz, r,g,b, ...]`. Leerer Vektor bei unbrauchbaren Parametern.
pub fn build_ground_grid(elevation: f32, extent: f32, spacing: f32) -> Vec<f32> {
    let n = line_count(extent, spacing);
    if n == 0 {
        return Vec::new();
    }
    let steps = (n as i32 - 1) / 2;
    let half = steps as f32 * spacing;

    // 2 Richtungen * n Linien * 2 Endpunkte * 6 f32.
    let mut verts: Vec<f32> = Vec::with_capacity(2 * n * 2 * GRID_FLOATS_PER_VERTEX);

    let mut push = |x: f32, z: f32, c: [f32; 3]| {
        verts.push(x);
        verts.push(elevation);
        verts.push(z);
        verts.push(c[0]);
        verts.push(c[1]);
        verts.push(c[2]);
    };

    for i in -steps..=steps {
        let c = if i % MAJOR_EVERY == 0 {
            MAJOR_COLOR
        } else {
            MINOR_COLOR
        };
        let p = i as f32 * spacing;
        // Linie parallel zur X-Achse (konstantes z = p): von -half bis +half in x.
        push(-half, p, c);
        push(half, p, c);
        // Linie parallel zur Z-Achse (konstantes x = p): von -half bis +half in z.
        push(p, -half, c);
        push(p, half, c);
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
    }

    #[test]
    fn vertex_count_matches_lines() {
        let extent = 20.0;
        let spacing = 1.0;
        let n = line_count(extent, spacing); // 21
        let verts = build_ground_grid(0.0, extent, spacing);
        // 2 Richtungen * n Linien * 2 Endpunkte * 6 f32.
        assert_eq!(verts.len(), 2 * n * 2 * GRID_FLOATS_PER_VERTEX);
        // = 84 Vertices.
        assert_eq!(verts.len() / GRID_FLOATS_PER_VERTEX, 4 * n);
    }

    #[test]
    fn all_vertices_lie_on_elevation_plane_and_within_extent() {
        let elevation = 2.7;
        let extent = 20.0;
        let spacing = 1.0;
        let half = 10.0; // steps=10 * spacing=1
        let verts = build_ground_grid(elevation, extent, spacing);
        for v in verts.chunks(GRID_FLOATS_PER_VERTEX) {
            let (x, y, z) = (v[0], v[1], v[2]);
            assert_eq!(y, elevation, "alle Vertices auf y = elevation");
            assert!(x.abs() <= half + 1e-6);
            assert!(z.abs() <= half + 1e-6);
        }
    }

    #[test]
    fn first_line_endpoints_and_center_is_major() {
        let extent = 20.0;
        let spacing = 1.0;
        let half = 10.0;
        let verts = build_ground_grid(0.0, extent, spacing);
        // Erste Linie: i = -steps = -10 (kein Vielfaches von 5? -10 % 5 == 0 -> Major).
        // X-parallele Linie bei z = -10, von x=-half..+half.
        assert_eq!(&verts[0..3], &[-half, 0.0, -10.0]);
        assert_eq!(&verts[3..6], &MAJOR_COLOR); // -10 ist Vielfaches von 5 -> Major
        assert_eq!(&verts[6..9], &[half, 0.0, -10.0]);

        // Mittelachse (i = 0) muss als Major vorkommen: suche Vertex bei z=0 X-Linie.
        let center_is_major = verts
            .chunks(GRID_FLOATS_PER_VERTEX)
            .any(|v| v[2] == 0.0 && v[3..6] == MAJOR_COLOR);
        assert!(center_is_major);
    }

    #[test]
    fn extent_snaps_to_spacing_multiple() {
        // extent 21, spacing 2 -> steps = floor(10.5/2) = 5 -> half = 10 (nicht 10.5).
        let verts = build_ground_grid(0.0, 21.0, 2.0);
        let max_abs = verts
            .chunks(GRID_FLOATS_PER_VERTEX)
            .flat_map(|v| [v[0].abs(), v[2].abs()])
            .fold(0.0_f32, f32::max);
        assert_eq!(max_abs, 10.0);
    }
}
