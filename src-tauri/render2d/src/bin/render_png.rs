// CLI-Beweis fuer den Headless-Renderpfad (Feature "headless"): rendert die
// Demo-Szene (dieselbe wie der Fenster-Spike, `demo::demo_scene`) OHNE Fenster in
// eine PNG-Datei. Belegt, dass `HeadlessRenderer` unabhaengig von einer Display-
// Session funktioniert.
//
// Start: cargo run --features headless --bin render_png -- [--out PFAD] [--width N] [--height N]
#![cfg(feature = "headless")]

use render2d::headless::HeadlessRenderer;
use render2d::{demo_scene, initial_view_box};

fn main() {
    // Defaults passend zum Seitenverhaeltnis von `initial_view_box` (990x630 —
    // Bildschirm-Raum-Einheiten der Demo-Szene, siehe demo.rs).
    let mut width = 990u32;
    let mut height = 630u32;
    let mut out = String::from("target/headless-demo.png");

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--width" => {
                width = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(width);
            }
            "--height" => {
                height = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(height);
            }
            "--out" => out = args.next().unwrap_or(out),
            other => eprintln!("render_png: unbekanntes Argument ignoriert: {other}"),
        }
    }

    let mut renderer = HeadlessRenderer::new().expect("Headless-Renderer initialisieren");
    let image = renderer.render_to_image(&demo_scene(), width, height, initial_view_box(), 100.0);
    let png = image.encode_png();

    if let Some(parent) = std::path::Path::new(&out).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).expect("Ausgabeverzeichnis anlegen");
        }
    }
    std::fs::write(&out, &png).expect("PNG schreiben");
    println!("render_png: geschrieben nach {out} ({width}x{height})");
}
