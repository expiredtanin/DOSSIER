// Nativer wgpu-2D-Renderer fuer den CAD-Grundriss.
//
// Aufbau in Schichten (bewusst getrennt, siehe Feature-Flags in Cargo.toml):
//  - `types`      : serde-only Eingabe (geflachte Primitive, Szene, ViewBox).
//  - `tessellate` : Ear-Clipping + Linien->Quads, Bildschirm-Raum. GPU-frei,
//                   headless per `cargo test` pruefbar. Kern-Port des WebGL-Pfads.
//  - `ortho`      : aspekt-korrekte Ortho-Matrix + Papier-mm-Strichbreiten-Formel.
//  - `shaders`    : WGSL-Quellen (aus den GLSL-Vorlagen uebersetzt).
//  - `gpu`        : wgpu-Pipelines (Feature "render").
//  - `bin/spike`  : winit-Fenster fuer die visuelle Verifikation (Feature "window").
//
// Standard-Build (`cargo test`/`cargo build` ohne Features) enthaelt nur die
// GPU-freien Schichten und ist damit unabhaengig von einer Display-Session.

pub mod demo;
pub mod ortho;
pub mod shaders;
pub mod tessellate;
pub mod types;

#[cfg(feature = "render")]
pub mod gpu;

// Browser-Bindings (wasm32 + WebGPU), nur mit Feature "web". Setzt "render" voraus
// (dieselbe GPU-Schicht wie das native Fenster), fuegt aber KEINE winit-Abhaengigkeit
// hinzu — die Canvas dient direkt als wgpu-Surface.
#[cfg(feature = "web")]
pub mod web;

// Offscreen-Renderpfad (kein Fenster/Surface), nur mit Feature "headless".
// Siehe docs/design/engine-headless.md.
#[cfg(feature = "headless")]
pub mod headless;

pub use demo::{demo_scene, initial_view_box};
pub use ortho::{compute_ortho_matrix, meet_scale, mm_to_device_px, Mat4};
pub use tessellate::{
    arc_screen_params, compile_scene, prepare_arc_dash, triangulate, ArcInstanceData, BatchKind,
    GpuGeometry, MAX_ARC_DASH, PX_PER_M,
};
pub use types::{Arc, FillPolygon, Line, Outline, Point, Rgba, Scene, Text, TextAlign, ViewBox};

// --- Tests: Tessellierung (Muster wie glPlanCompile.test.ts) -----------------

#[cfg(test)]
mod tests {
    use super::tessellate::{triangulate, PX_PER_M};
    use super::types::Point;

    /// Summierte Dreiecksflaeche (Betrag) aus Indizes ueber pts.
    fn tri_area(pts: &[Point], idx: &[u32]) -> f32 {
        let mut area = 0.0f32;
        let mut i = 0;
        while i < idx.len() {
            let a = pts[idx[i] as usize];
            let b = pts[idx[i + 1] as usize];
            let c = pts[idx[i + 2] as usize];
            area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs() / 2.0;
            i += 3;
        }
        area
    }

    /// Polygon-Flaeche (Shoelace, Betrag).
    fn poly_area(pts: &[Point]) -> f32 {
        let mut a = 0.0f32;
        let n = pts.len();
        let mut j = n - 1;
        for i in 0..n {
            a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
            j = i;
        }
        a.abs() / 2.0
    }

    #[test]
    fn quadrat_zwei_dreiecke_volle_flaeche() {
        let sq: Vec<Point> = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]];
        let idx = triangulate(&sq);
        assert_eq!(idx.len(), 6, "2 Dreiecke erwartet");
        assert!((tri_area(&sq, &idx) - poly_area(&sq)).abs() < 1e-4);
    }

    #[test]
    fn konkaves_l_flaechentreu_kein_fan() {
        // L-Form: konkave Ecke bei (2,2). Ein Fan wuerde Flaeche ausserhalb des L
        // erzeugen; Ear-Clipping muss flaechentreu bleiben.
        let l: Vec<Point> = vec![
            [0.0, 0.0],
            [4.0, 0.0],
            [4.0, 2.0],
            [2.0, 2.0],
            [2.0, 4.0],
            [0.0, 4.0],
        ];
        let idx = triangulate(&l);
        assert_eq!(idx.len(), 12, "6 Ecken -> 4 Dreiecke");
        assert!((tri_area(&l, &idx) - poly_area(&l)).abs() < 1e-4);
        assert!((tri_area(&l, &idx) - 12.0).abs() < 1e-4, "L-Flaeche == 12");
    }

    #[test]
    fn weniger_als_drei_ecken_leer() {
        assert!(triangulate(&[]).is_empty());
        assert!(triangulate(&[[0.0, 0.0]]).is_empty());
        assert!(triangulate(&[[0.0, 0.0], [1.0, 1.0]]).is_empty());
    }

    #[test]
    fn beide_wicklungsrichtungen_gleich() {
        // CW-Quadrat.
        let cw: Vec<Point> = vec![[0.0, 0.0], [0.0, 4.0], [4.0, 4.0], [4.0, 0.0]];
        let idx = triangulate(&cw);
        assert_eq!(idx.len(), 6);
        assert!((tri_area(&cw, &idx) - poly_area(&cw)).abs() < 1e-4);

        // CCW-Quadrat gleicher Groesse -> gleiche Gesamtflaeche.
        let ccw: Vec<Point> = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]];
        let idx2 = triangulate(&ccw);
        assert_eq!(idx2.len(), 6);
        assert!((tri_area(&ccw, &idx2) - tri_area(&cw, &idx)).abs() < 1e-4);
    }

    // --- Zusatz: Bildschirm-Raum-Abbildung + Ortho-Matrix --------------------

    #[test]
    fn to_screen_konvention() {
        // sx = mx*90, sy = -my*90 (Modell-Y hoch -> Bildschirm-Y runter).
        let s = super::tessellate::to_screen([2.0, 3.0]);
        assert!((s[0] - 2.0 * PX_PER_M).abs() < 1e-4);
        assert!((s[1] + 3.0 * PX_PER_M).abs() < 1e-4);
    }

    #[test]
    fn ortho_bildet_viewbox_ecken_auf_clip_ab() {
        use super::ortho::compute_ortho_matrix;
        use super::types::ViewBox;
        // Quadratischer viewBox + quadratisches Canvas -> keine Aspekt-Dehnung.
        let m = compute_ortho_matrix(ViewBox::new(0.0, 0.0, 100.0, 100.0), 100.0, 100.0);
        // Spalten-Major: clip = M * (x,y,0,1).
        let clip = |x: f32, y: f32| -> (f32, f32) {
            (
                m[0] * x + m[4] * y + m[12],
                m[1] * x + m[5] * y + m[13],
            )
        };
        // Bildschirm-Punkt (0,0) = obere-linke Ecke -> Clip (-1, +1).
        let tl = clip(0.0, 0.0);
        assert!((tl.0 + 1.0).abs() < 1e-4);
        assert!((tl.1 - 1.0).abs() < 1e-4);
        // (100,100) = untere-rechte Ecke -> Clip (+1, -1).
        let br = clip(100.0, 100.0);
        assert!((br.0 - 1.0).abs() < 1e-4);
        assert!((br.1 + 1.0).abs() < 1e-4);
    }

    #[test]
    fn mm_zu_device_px_35_bei_1zu100() {
        use super::ortho::mm_to_device_px;
        use super::types::ViewBox;
        // meet=1 (viewport == viewBox), N=100: mmToPx = N/1000 * 90 * meet = 9 px/mm.
        // 0.35 mm -> 3.15 px.
        let vb = ViewBox::new(0.0, 0.0, 100.0, 100.0);
        let mm_px = mm_to_device_px(vb, 100.0, 100.0, 100.0);
        assert!((mm_px - 9.0).abs() < 1e-4, "9 px/mm bei 1:100, meet=1");
        assert!((0.35 * mm_px - 3.15).abs() < 1e-4);
    }

    /// Validiert die WGSL-Quellen headless ueber naga (Parser + Validator) —
    /// faengt Syntax-/Typfehler ohne GPU/Display ab. Nur mit Feature "render",
    /// weil naga sonst nicht mitgebaut wird.
    #[cfg(feature = "render")]
    #[test]
    fn wgsl_quellen_sind_valide() {
        use naga::valid::{Capabilities, ValidationFlags, Validator};

        for (name, src) in [
            ("fill", super::shaders::FILL_WGSL),
            ("line", super::shaders::LINE_WGSL),
            ("arc", super::shaders::ARC_WGSL),
        ] {
            let module = naga::front::wgsl::parse_str(src)
                .unwrap_or_else(|e| panic!("{name}: WGSL-Parse-Fehler: {e:?}"));
            let mut validator =
                Validator::new(ValidationFlags::all(), Capabilities::all());
            validator
                .validate(&module)
                .unwrap_or_else(|e| panic!("{name}: WGSL-Validierung fehlgeschlagen: {e:?}"));
        }
    }
}
