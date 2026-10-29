// CLI-Beweis fuer den Headless-Renderpfad (Feature "headless"): rendert die
// Demo-Szene (dieselbe wie der Fenster-Spike, `demo::demo_scene`) OHNE Fenster in
// eine PNG-Datei. Belegt, dass `HeadlessRenderer` unabhaengig von einer Display-
// Session funktioniert.
//
// Start: cargo run --features headless --bin render_png -- [--out PFAD] [--width N] [--height N]
//        [--scene szene.bin | --chunks a.bin,b.bin…] [--bounds minX,minY,maxX,maxY] [--crop x0,y0,x1,y1] [--scale N]
// `--scene`: Szene-Bytes wie für `set_scene_bin` (statt der Demo); Ausschnitt = Ausmass der Szene,
// `--crop` wählt daraus einen Teil (Anteile 0..1, y von oben), `--scale` den Papier-Massstab 1:N.
// `--chunks`: GPU-Chunks (je Datei die u32-Ausgabe von `gpu_compile_flat`, gepackt) über den
// Chunk-Renderer des nativen macOS-Pfads (`chunks.rs`); Ausschnitt = Vereinigung der Chunk-Ausmasse.
// `--bounds` (Modell-Meter) ersetzt das Ausmass — für deckungsgleiche Vergleiche Szene ↔ Chunks.
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
    let mut chunk_files: Vec<String> = Vec::new();
    let mut bounds_arg: Option<[f32; 4]> = None;

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
            "--chunks" => chunk_files = args.next().unwrap_or_default().split(',').filter(|f| !f.is_empty()).map(String::from).collect(),
            "--bounds" => {
                let v: Vec<f32> = args.next().unwrap_or_default().split(',').filter_map(|x| x.parse().ok()).collect();
                if v.len() == 4 {
                    bounds_arg = Some([v[0], v[1], v[2], v[3]]);
                }
            }
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
    // Ausmass (Modell-Meter) → Bildschirm-Raum (x·90, −y·90), dann der Ausschnitt.
    let view_of = |b: [f32; 4]| {
        let (x0, x1) = (b[0] * 90.0, b[2] * 90.0);
        let (y0, y1) = (-b[3] * 90.0, -b[1] * 90.0);
        let (w, h) = (x1 - x0, y1 - y0);
        ViewBox::new(x0 + crop[0] * w, y0 + crop[1] * h, (crop[2] - crop[0]) * w, (crop[3] - crop[1]) * h)
    };
    if !chunk_files.is_empty() {
        let chunks: Vec<Vec<u32>> = chunk_files
            .iter()
            .map(|f| std::fs::read(f).expect("Chunk lesen").chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
            .collect();
        let b = bounds_arg.unwrap_or_else(|| {
            let mut b = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
            for c in &chunks {
                if let Some(cb) = render2d::headless::chunk_flat_bounds(c) {
                    b = [b[0].min(cb[0] as f32), b[1].min(cb[1] as f32), b[2].max(cb[2] as f32), b[3].max(cb[3] as f32)];
                }
            }
            b
        });
        let vb = view_of(b);
        let view = render2d::chunks::View { x: vb.x as f64, y: vb.y as f64, w: vb.w as f64, h: vb.h as f64 };
        let image = renderer.render_chunks_to_image(&chunks, width, height, view, paper_n as f64).expect("Chunks rendern");
        std::fs::write(&out, image.encode_png()).expect("PNG schreiben");
        println!("render_png: Chunks geschrieben nach {out} ({width}x{height})");
        return;
    }
    let (scene, view_box) = match &scene_file {
        None => (demo_scene(), initial_view_box()),
        Some(f) => {
            let bytes = std::fs::read(f).expect("Szene lesen");
            let scene = render2d::scene_bin::decode_scene(&bytes).expect("Szene dekodieren");
            let b = bounds_arg.unwrap_or_else(|| render2d::compile_scene(&scene).bounds);
            (scene, view_of(b))
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
