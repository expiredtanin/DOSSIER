// Golden-Image-Test des Headless-Renderpfads (Feature "headless"): rendert die
// Demo-Szene (dieselbe wie der Fenster-Spike) und vergleicht sie pixelweise gegen
// ein eingechecktes Referenzbild (`tests/golden/demo.png`), mit Toleranz fuer
// GPU-/Treiber-AA-Rauschen.
//
// `#[ignore]`: die Vulkan-/GPU-Verfuegbarkeit ist auf CI-Runnern nicht garantiert,
// und ein Software-Rasterizer (llvmpipe) wuerde anderes AA liefern als das
// Referenzbild (siehe docs/design/engine-headless.md). Lokal ausfuehren mit:
//   cargo test --features headless -- --include-ignored
//
// Bei einer bewussten Rendering-Aenderung das Referenzbild neu erzeugen (siehe
// docs/design/engine-headless.md, Abschnitt "Referenzbild aktualisieren").
#![cfg(feature = "headless")]

use render2d::headless::{HeadlessRenderer, RgbaImage};
use render2d::{demo_scene, initial_view_box};

/// Ort des eingecheckten Referenzbilds (absolut ueber das Crate-Manifest, damit
/// der Test unabhaengig vom Arbeitsverzeichnis laeuft).
const GOLDEN_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/demo.png");
/// Debug-Diff-Bild bei Abweichung (rote Pixel == abweichend, sonst Ist-Bild).
const DIFF_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/golden-diff.png");
/// Ist-Bild bei Abweichung (Basis fuer eine gewollte Referenz-Aktualisierung).
const ACTUAL_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/golden-actual.png");

/// Ein Pixel gilt als "abweichend", wenn IRGENDEIN Kanal-Delta diesen Wert
/// ueberschreitet (deckt AA-Rundungsrauschen zwischen GPU-Treibern ab).
const CHANNEL_DELTA_THRESHOLD: i32 = 2;
/// Maximal erlaubter Anteil abweichender Pixel, bevor der Test fehlschlaegt.
const MAX_DIFFERING_FRACTION: f64 = 0.005;

#[test]
#[ignore]
fn demo_szene_entspricht_referenzbild() {
    // Dieselben Defaults wie `render_png` (siehe src/bin/render_png.rs) — das
    // Referenzbild wird exakt so erzeugt.
    let width = 990u32;
    let height = 630u32;

    // Kein Adapter (z.B. CI-Runner ohne GPU) -> Test sauber ueberspringen statt
    // rot zu schlagen (siehe `HeadlessRenderer::new`-Doku).
    let mut renderer = match HeadlessRenderer::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("golden: uebersprungen, kein Headless-Adapter verfuegbar: {e}");
            return;
        }
    };
    let actual = renderer.render_to_image(&demo_scene(), width, height, initial_view_box(), 100.0);

    let golden_bytes = std::fs::read(GOLDEN_PATH).unwrap_or_else(|e| {
        panic!(
            "Referenzbild {GOLDEN_PATH} fehlt oder unlesbar ({e}); zuerst erzeugen, \
             siehe docs/design/engine-headless.md"
        )
    });
    let golden = RgbaImage::decode_png(&golden_bytes).expect("Referenzbild dekodieren");

    assert_eq!(golden.width, actual.width, "Referenzbild-Breite weicht ab");
    assert_eq!(golden.height, actual.height, "Referenzbild-Hoehe weicht ab");

    let total_pixels = (actual.width as usize) * (actual.height as usize);
    let mut differing = 0usize;
    let mut diff_pixels = vec![0u8; actual.pixels.len()];

    for i in 0..total_pixels {
        let base = i * 4;
        let is_diff = (0..4).any(|c| {
            (actual.pixels[base + c] as i32 - golden.pixels[base + c] as i32).abs()
                > CHANNEL_DELTA_THRESHOLD
        });
        if is_diff {
            differing += 1;
            // Abweichende Pixel signalrot markieren, Rest unveraendert lassen
            // (Kontext fuers Debuggen).
            diff_pixels[base] = 255;
            diff_pixels[base + 1] = 0;
            diff_pixels[base + 2] = 0;
            diff_pixels[base + 3] = 255;
        } else {
            diff_pixels[base..base + 4].copy_from_slice(&actual.pixels[base..base + 4]);
        }
    }

    let fraction = differing as f64 / total_pixels as f64;
    println!(
        "golden: {differing}/{total_pixels} Pixel abweichend ({:.4}%), Toleranz {:.1}%",
        fraction * 100.0,
        MAX_DIFFERING_FRACTION * 100.0
    );
    if fraction > MAX_DIFFERING_FRACTION {
        if let Some(parent) = std::path::Path::new(DIFF_PATH).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let diff = RgbaImage {
            width: actual.width,
            height: actual.height,
            pixels: diff_pixels,
        };
        std::fs::write(DIFF_PATH, diff.encode_png()).expect("Diff-Bild schreiben");
        std::fs::write(ACTUAL_PATH, actual.encode_png()).expect("Ist-Bild schreiben");
        panic!(
            "Golden-Image-Test fehlgeschlagen: {differing}/{total_pixels} Pixel weichen ab \
             ({:.3}% > {:.3}% Toleranz), Diff-Bild: {DIFF_PATH}, Ist-Bild: {ACTUAL_PATH}",
            fraction * 100.0,
            MAX_DIFFERING_FRACTION * 100.0
        );
    }
}
