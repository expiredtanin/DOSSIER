//! Mess-Hilfe (nicht im Produkt): Modell (JSON, `dossier-cli … model3d`) als Szene aufbauen (`Scene::set_model`,
//! Vernetzen + Kanten-Index) und alle Klumpen auslesen (`chunk_data`). `cargo run --release --example scene_bench -- m.json [n]`
use render3d::scene::{PartInput, PartsUpdate, Scene};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("Pfad zum Modell (JSON)");
    let n: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    let text = std::fs::read_to_string(path).unwrap();
    // Teil-Update wie im Browser (`set_parts`, `{reset, remove, upsert}`) oder ein ganzes Modell (`set_model`).
    let parts: Option<PartsUpdate> = text.contains("\"upsert\"").then(|| serde_json::from_str(&text).unwrap());
    let part: PartInput = if parts.is_some() { PartInput::default() } else { serde_json::from_str(&text).unwrap() };
    match &parts {
        Some(u) => println!("Teil-Update: {} Teile", u.upsert.len()),
        None => println!("Wände {}, Decken {}, Netze {}, Dachschichten {}", part.walls.len(), part.slabs.len(), part.meshes.len(), part.roof_layers.len()),
    }
    for _ in 0..n {
        let mut s = Scene::new();
        let t = Instant::now();
        let ch = match &parts {
            Some(u) => s.apply(u.clone()),
            None => s.set_model(part.clone()),
        };
        let t_apply = t.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        let (mut verts, mut edges) = (0, 0);
        for c in 0..s.chunk_count() {
            let d = s.chunk_data(c);
            verts += d.mesh.vertex_count();
            edges += d.edges.len();
        }
        let t_chunks = t.elapsed().as_secs_f64() * 1000.0;
        println!("apply {t_apply:.0} ms (vernetzt {}), chunk_data {t_chunks:.0} ms — Klumpen {}, Vertices {verts}, Kanten-Floats {edges}", ch.remeshed, s.chunk_count());
    }
}
