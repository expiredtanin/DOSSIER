// CLI-Beweis fuer den Headless-Renderpfad (Feature "headless"): rendert die
// Demo-Szene (dieselbe wie der Fenster-Spike, `demo::demo_scene`) OHNE Fenster in
// eine PNG-Datei. Belegt, dass `HeadlessRenderer` unabhaengig von einer Display-
// Session funktioniert.
//
// Start: cargo run --features headless --bin render_png -- [--out PFAD] [--width N] [--height N]
//        [--scene szene.bin] [--crop x0,y0,x1,y1] [--scale N]
// `--scene`: Szene-Bytes wie für `set_scene_bin` (statt der Demo); Ausschnitt = Ausmass der Szene,
// `--crop` wählt daraus einen Teil (Anteile 0..1, y von oben), `--scale` den Papier-Massstab 1:N.
#![cfg(feature = "headless")]

use render2d::headless::HeadlessRenderer;
use render2d::{demo_scene, initial_view_box, ViewBox};

fn main() {
    // Defaults passend zum Seitenverhaeltnis von `initial_view_box` (990x630 —
    // Bildschirm-Raum-Einheiten der Demo-Szene, siehe demo.rs).
    let mut width = 990u32;
    let mut height = 630u32;
    let mut out = String::from("target/headless-demo.png");
    let mut scene_file: Option<String> = None;
    let mut crop = [0.0f32, 0.0, 1.0, 1.0];
    let mut paper_n = 100.0f32;

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
            "--scene" => scene_file = args.next(),
            "--scale" => paper_n = args.next().and_then(|v| v.parse().ok()).unwrap_or(paper_n),
            "--crop" => {
                let v: Vec<f32> = args.next().unwrap_or_default().split(',').filter_map(|x| x.parse().ok()).collect();
                if v.len() == 4 {
                    crop = [v[0], v[1], v[2], v[3]];
                }
            }
            other => eprintln!("render_png: unbekanntes Argument ignoriert: {other}"),
        }
    }

    let mut renderer = HeadlessRenderer::new().expect("Headless-Renderer initialisieren");
    let (scene, view_box) = match &scene_file {
        None => (demo_scene(), initial_view_box()),
        Some(f) => {
            let bytes = std::fs::read(f).expect("Szene lesen");
            let scene = render2d::scene_bin::decode_scene(&bytes).expect("Szene dekodieren");
            // Ausmass (Modell-Meter) → Bildschirm-Raum (x·90, −y·90), dann der Ausschnitt.
            let b = render2d::compile_scene(&scene).bounds;
            let (x0, x1) = (b[0] * 90.0, b[2] * 90.0);
            let (y0, y1) = (-b[3] * 90.0, -b[1] * 90.0);
            let (w, h) = (x1 - x0, y1 - y0);
            let vb = ViewBox::new(x0 + crop[0] * w, y0 + crop[1] * h, (crop[2] - crop[0]) * w, (crop[3] - crop[1]) * h);
            (scene, vb)
        }
    };
    let image = renderer.render_to_image(&scene, width, height, view_box, paper_n);
    let png = image.encode_png();

    if let Some(parent) = std::path::Path::new(&out).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).expect("Ausgabeverzeichnis anlegen");
        }
    }
    std::fs::write(&out, &png).expect("PNG schreiben");
    println!("render_png: geschrieben nach {out} ({width}x{height})");
}
