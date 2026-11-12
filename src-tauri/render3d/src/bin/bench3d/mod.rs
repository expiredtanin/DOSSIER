// Messung der 3D-Engine ([214]), eingebunden in `render_png` (`--bench <ordner>`):
//
//   render_png --bench <ordner> [--frames 36] [--size 1600x1000] [--style shaded-edges] [--sun 135,30] [--png bild.png]
//
// Liest die Eingaben, die der Viewer bekommt (`dossier-cli <projekt> bench3d --out <ordner>`): `parts.json` (Teil-Update wie
// `set_parts`), `delta.json` (eine Wand verschoben, wie `Model3dPartsSync` es schickt), `drawing.f32`/`pattern.f32`
// (2D-Spuren, Flächenmuster), `ghost.json` (Geisterschicht, Format `set_model`) und `ghost-parts.json` (dieselbe als Teile,
// wie `set_ghost_parts`), und misst
// (b) Aufbau: Parsen, Vernetzen, Puffer anlegen, bis die GPU fertig ist,
// (c) Bildzeit über einen Umlauf um das Modell: CPU-Seite (`render` = Abfragen, Encoder, Submit) und mit Warten auf die GPU
//     (im Linux-Container lavapipe = Software, nur relativ aussagekräftig), Draw-Calls, Schattenpässe,
// (d) eine Modelländerung: Teil-Update + was der Viewer sonst je Änderung schickt, nächstes Bild,
// (e) Speicher: GPU-Puffer des Modells (`Renderer::gpu_bytes`) und Prozess-RSS.
// `--png` schreibt das erste Bild des Umlaufs (Bildvergleich vorher/nachher, derselbe Teile-Weg wie der Viewer).

use std::time::Instant;

use render3d::gpu::{RenderStyle, Renderer};
use render3d::math::preset_camera;
use render3d::scene::{PartInput, PartsUpdate, Scene};

use crate::{new_device, preset, read_back, target_texture};

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// Speicher des Prozesses (VmRSS, VmHWM in MB) aus /proc (Linux; sonst 0).
fn rss_mb() -> (f64, f64) {
    let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let get = |k: &str| {
        s.lines()
            .find(|l| l.starts_with(k))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<f64>().ok())
            .map_or(0.0, |kb| kb / 1024.0)
    };
    (get("VmRSS:"), get("VmHWM:"))
}

fn read_f32(path: &str) -> Vec<f32> {
    std::fs::read(path)
        .map(|b| b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
        .unwrap_or_default()
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v.get(v.len() / 2).copied().unwrap_or(0.0)
}

fn row(name: &str, v: String) {
    println!("{name:<48} {v}");
}

pub fn bench(dir: &str, flag: &dyn Fn(&str, &str) -> String) {
    let read = |f: &str| std::fs::read_to_string(format!("{dir}/{f}")).ok();
    let parts_json = read("parts.json").expect("parts.json fehlt");
    let delta_json = read("delta.json");
    let drawing = read_f32(&format!("{dir}/drawing.f32"));
    let pattern = read_f32(&format!("{dir}/pattern.f32"));
    let ghost_json = read("ghost.json");
    let frames: usize = flag("--frames", "36").parse().unwrap_or(36);
    let (w, h) = flag("--size", "1600x1000")
        .split_once('x')
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)))
        .unwrap_or((1600, 1000));

    let (device, queue) = new_device();
    let format = wgpu::TextureFormat::Rgba8UnormSrgb;
    let mut renderer = Renderer::new(&device, format);
    renderer.set_render_style(RenderStyle::from_str_or_shaded(&flag("--style", "shaded-edges")));
    let sun: Vec<f64> = flag("--sun", "135,30").split(',').filter_map(|v| v.trim().parse().ok()).collect();
    if sun.len() == 2 {
        renderer.set_sun(render3d::shadow::sun_dir_world(sun[0], sun[1]), true);
    }
    let (rss0, _) = rss_mb();

    // (b) Aufbau: Parsen, Vernetzen (Szene allein), dann Vernetzen + Hochladen (Renderer).
    let t = Instant::now();
    let upd: PartsUpdate = serde_json::from_str(&parts_json).expect("parts.json parsen");
    let t_parse = ms(t);
    let n_parts = upd.upsert.len();
    let t = Instant::now();
    let mut scene = Scene::new();
    let ch = scene.apply(upd.clone());
    let t_scene = ms(t);
    let t = Instant::now();
    let data: Vec<_> = ch.dirty_chunks.iter().map(|&c| scene.chunk_data(c)).collect();
    let t_chunks = ms(t);
    let verts: usize = data.iter().map(|d| d.mesh.vertex_count()).sum();
    let tris: usize = data.iter().map(|d| d.mesh.indices.len() / 3).sum();
    let edge_verts: usize = data.iter().map(|d| d.edges.len() / 6).sum();
    drop(data);
    drop(scene);
    let t = Instant::now();
    renderer.update_parts(&device, upd);
    let t_upload_cpu = ms(t);
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let t_upload = ms(t);
    let t = Instant::now();
    if !drawing.is_empty() || !pattern.is_empty() {
        renderer.set_drawing_lines(&device, &drawing);
        renderer.set_pattern_lines(&pattern);
    }
    let t_lines = ms(t);
    let mut t_ghost = 0.0;
    if let Some(g) = &ghost_json {
        let t = Instant::now();
        let part: PartInput = serde_json::from_str(g).expect("ghost.json parsen");
        renderer.set_ghost_model(&device, part);
        t_ghost = ms(t);
    }
    // [214] Geisterschicht als Teile (wie der Viewer jetzt): ersetzt die ganze von oben.
    let mut t_ghost_parts = None;
    if let Some(g) = read("ghost-parts.json") {
        let t = Instant::now();
        let upd: PartsUpdate = serde_json::from_str(&g).expect("ghost-parts.json parsen");
        renderer.update_ghost_parts(&device, upd);
        t_ghost_parts = Some(ms(t));
    }
    row("Teile / Klumpen", format!("{n_parts} / {}", renderer.scene().chunk_count()));
    row("Ecken / Dreiecke / Kanten-Ecken", format!("{verts} / {tris} / {edge_verts}"));
    row("Aufbau: JSON parsen", format!("{t_parse:.1} ms"));
    row("Aufbau: Szene vernetzen", format!("{t_scene:.1} ms"));
    row("Aufbau: Klumpen-Daten", format!("{t_chunks:.1} ms"));
    row("Aufbau: Renderer (vernetzen + Puffer)", format!("{t_upload_cpu:.1} ms"));
    row("Aufbau: Renderer + GPU fertig", format!("{t_upload:.1} ms"));
    row("Aufbau: 2D-Spuren + Muster", format!("{t_lines:.1} ms ({} + {} f32)", drawing.len(), pattern.len()));
    row("Aufbau: Geisterschicht ganz", format!("{t_ghost:.1} ms"));
    if let Some(t) = t_ghost_parts {
        row("Aufbau: Geisterschicht als Teile", format!("{t:.1} ms"));
    }

    // (c) Bildzeit: Umlauf um das Modell.
    let (target, dist) =
        render3d::math::fit_target_dist(renderer.scene().bounds(), render3d::types::Camera::default().fov_y);
    let tex = target_texture(&device, format, w, h);
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
    let base = preset_camera(preset(&flag("--view", "iso")), target, dist);
    let orbit = |k: usize| {
        let mut c = base;
        let a = k as f32 / frames.max(1) as f32 * std::f32::consts::TAU;
        let (dx, dz) = (c.eye[0] - target[0], c.eye[2] - target[2]);
        c.eye[0] = target[0] + dx * a.cos() - dz * a.sin();
        c.eye[2] = target[2] + dx * a.sin() + dz * a.cos();
        c
    };
    // Erstes Bild (Schattenpass, Ziele anlegen) getrennt.
    let t = Instant::now();
    renderer.render(&device, &queue, &view, &orbit(0), (w, h));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let t_first = ms(t);
    let first = renderer.frame_stats();
    let png = flag("--png", "");
    if !png.is_empty() {
        read_back(&device, &queue, &tex, w, h, &png);
    }
    let (mut cpu, mut all) = (Vec::new(), Vec::new());
    let mut shadow_frames = 0;
    let mut draws = 0u32;
    let mut elements = 0u64;
    for k in 0..frames {
        let cam = orbit(k + 1);
        let t = Instant::now();
        renderer.render(&device, &queue, &view, &cam, (w, h));
        cpu.push(ms(t));
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        all.push(ms(t));
        let st = renderer.frame_stats();
        draws = draws.max(st.draws);
        elements += st.elements;
        shadow_frames += (st.shadow_draws > 0) as usize;
    }
    // Gleiche Kamera, nichts geändert.
    let mut still = Vec::new();
    for _ in 0..frames.min(12) {
        let t = Instant::now();
        renderer.render(&device, &queue, &view, &orbit(0), (w, h));
        still.push(ms(t));
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
    }
    row(
        "Bild: erstes (Schattenpass, GPU fertig)",
        format!("{t_first:.1} ms, {} Draw-Calls + {} im Schattenpass", first.draws, first.shadow_draws),
    );
    row("Bild: Umlauf CPU (encode + submit), Median", format!("{:.2} ms", median(&mut cpu)));
    row("Bild: Umlauf mit GPU (lavapipe), Median", format!("{:.1} ms", median(&mut all)));
    row("Bild: Kamera fest CPU, Median", format!("{:.2} ms", median(&mut still)));
    row("Bild: Draw-Calls (max), Schattenpässe im Umlauf", format!("{draws}, {shadow_frames} von {frames}"));
    row("Bild: Ecken/Indizes je Bild (Mittel)", format!("{}", elements / frames.max(1) as u64));

    // (d) Eine Wand verschoben: Teil-Update wie der Viewer (dazu 2D-Spuren/Muster erneut, wie `updateModel`).
    if let Some(dj) = &delta_json {
        let t = Instant::now();
        let upd: PartsUpdate = serde_json::from_str(dj).expect("delta.json parsen");
        let n = upd.upsert.len() + upd.remove.len();
        let t_parse = ms(t);
        let ch = renderer.update_parts(&device, upd);
        let t_cpu = ms(t);
        let t2 = Instant::now();
        if !drawing.is_empty() || !pattern.is_empty() {
            renderer.set_drawing_lines(&device, &drawing);
            renderer.set_pattern_lines(&pattern);
        }
        let t_lines = ms(t2);
        let t3 = Instant::now();
        renderer.render(&device, &queue, &view, &orbit(0), (w, h));
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let t_frame = ms(t3);
        row(
            "Änderung: Teile im Update",
            format!("{n} (davon {} neu vernetzt, {} Klumpen neu)", ch.remeshed, ch.dirty_chunks.len()),
        );
        row("Änderung: parsen + Renderer", format!("{t_cpu:.1} ms (parsen {t_parse:.1})"));
        row("Änderung: 2D-Spuren + Muster erneut", format!("{t_lines:.1} ms"));
        row("Änderung: nächstes Bild (Schattenpass)", format!("{t_frame:.1} ms"));
    }

    // (e) Speicher.
    let (rss, hwm) = rss_mb();
    row("Speicher: GPU-Puffer des Modells", format!("{:.1} MB", renderer.gpu_bytes() as f64 / 1e6));
    row("Speicher: Prozess RSS / Spitze (vor Aufbau)", format!("{rss:.0} / {hwm:.0} MB ({rss0:.0})"));
}
