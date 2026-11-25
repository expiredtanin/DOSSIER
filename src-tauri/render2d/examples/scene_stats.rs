//! Mess-Hilfe (nicht im Produkt): Szene (JSON, `dossier-cli … plan --format json`) einlesen, `compile_scene`
//! messen und Batch-/Wechselzahlen ausgeben. `cargo run --release --example scene_stats -- szene.json`
use render2d::{compile_scene, BatchKind, Scene};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("Pfad zur Szene (JSON)");
    let scene: Scene = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let t = Instant::now();
    let mut geo = compile_scene(&scene);
    for _ in 0..4 {
        geo = compile_scene(&scene);
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0 / 5.0;
    let switches = geo.draw_sequence.windows(2).filter(|w| w[0].0 != w[1].0).count();
    let (f, l, d) = geo.draw_sequence.iter().fold((0, 0, 0), |a, (k, _)| match k {
        BatchKind::Fill => (a.0 + 1, a.1, a.2),
        BatchKind::Line => (a.0, a.1 + 1, a.2),
        BatchKind::Dash => (a.0, a.1, a.2 + 1),
    });
    println!(
        "compile_scene {ms:.1} ms | draws {} (fill {f}, line {l}, dash {d}), Art-Wechsel {switches} | fill tris {} | line verts {} idx {} | arcs {} | dash segs {} | texts {}",
        geo.draw_sequence.len(),
        geo.fill_idx.len() / 3,
        geo.line_verts.len() / 6,
        geo.line_idx.len(),
        geo.arcs.len(),
        geo.dash_segments.len(),
        scene.texts.len()
    );
}
