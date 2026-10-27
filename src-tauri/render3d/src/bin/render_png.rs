// Headless-Rendering von render3d in eine PNG-Datei (lessons-bimcraft [R1]): dieselbe GPU-Schicht
// wie im Viewer, aber auf ein Offscreen-Texture (Metal/Vulkan/DX12 — keine Fenster-Session nötig).
// Dient Referenzbildern und der Prüfung des 3D ohne Nutzer-App.
//
//   cargo run --release --features png --bin render_png -- modell.json aus.png [--view iso] [--style shaded] [--size 1200x800] [--target x,y,z] [--dist 12]
//
// `modell.json` ist das Modell wie `set_model` es bekommt (`dossier-cli … model3d`).

use std::io::Write;

use render3d::gpu::{RenderStyle, Renderer};
use render3d::math::preset_camera;
use render3d::types::{CameraPreset, MeshInput, SlabInput, WallInput};
use serde::Deserialize;

#[derive(Deserialize)]
struct ModelInput {
    walls: Vec<WallInput>,
    #[serde(default)]
    slabs: Vec<SlabInput>,
    #[serde(default)]
    meshes: Vec<MeshInput>,
}

fn bounds(m: &ModelInput) -> Option<([f32; 3], [f32; 3])> {
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    let mut any = false;
    let mut add = |x: f32, y: f32, z: f32| {
        // Modell (x, y, z=Höhe) → world (x, Höhe, y)
        any = true;
        for (i, v) in [x, z, y].into_iter().enumerate() {
            min[i] = min[i].min(v);
            max[i] = max[i].max(v);
        }
    };
    for w in &m.walls {
        for p in [w.start, w.end] {
            add(p[0], p[1], w.base_elevation);
            add(p[0], p[1], w.base_elevation + w.height);
        }
    }
    for s in &m.slabs {
        for p in &s.outline {
            add(p[0], p[1], s.z_bottom);
            add(p[0], p[1], s.z_top);
        }
    }
    for me in &m.meshes {
        for c in me.positions.chunks(3) {
            if c.len() == 3 {
                add(c[0], c[1], c[2]);
            }
        }
    }
    any.then_some((min, max))
}

fn preset(name: &str) -> CameraPreset {
    match name {
        "front" => CameraPreset::Front,
        "back" => CameraPreset::Back,
        "top" => CameraPreset::Top,
        "side" => CameraPreset::Side,
        "left" => CameraPreset::Left,
        "isoFrontLeft" => CameraPreset::IsoFrontLeft,
        "isoBackRight" => CameraPreset::IsoBackRight,
        "isoBackLeft" => CameraPreset::IsoBackLeft,
        "perspective" => CameraPreset::Persp,
        _ => CameraPreset::Iso,
    }
}

/// Minimaler PNG-Schreiber (RGBA8, unkomprimierte Deflate-Blöcke) — keine zusätzliche Abhängigkeit.
fn write_png(path: &str, w: u32, h: u32, rgba: &[u8]) -> std::io::Result<()> {
    fn crc32(data: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for (n, t) in table.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *t = c;
        }
        let mut c = 0xFFFF_FFFFu32;
        for &b in data {
            c = table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
        }
        c ^ 0xFFFF_FFFF
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    }
    // Rohdaten: je Zeile ein Filter-Byte 0
    let mut raw = Vec::with_capacity((w as usize * 4 + 1) * h as usize);
    for y in 0..h as usize {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * w as usize * 4..(y + 1) * w as usize * 4]);
    }
    // zlib mit gespeicherten Blöcken
    let mut z = vec![0x78, 0x01];
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    let mut chunks = raw.chunks(65535).peekable();
    while let Some(c) = chunks.next() {
        z.push(if chunks.peek().is_none() { 1 } else { 0 });
        z.extend_from_slice(&(c.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(c.len() as u16)).to_le_bytes());
        z.extend_from_slice(c);
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    std::fs::File::create(path)?.write_all(&out)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
            .unwrap_or_else(|| default.to_string())
    };
    let pos: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|(i, a)| !a.starts_with("--") && (*i == 0 || !args[*i - 1].starts_with("--")))
        .map(|(_, a)| a)
        .collect();
    if pos.len() < 2 {
        eprintln!("Aufruf: render_png <modell.json> <aus.png> [--view iso] [--style shaded] [--size 1200x800]");
        std::process::exit(2);
    }
    let size = flag("--size", "1200x800");
    let (w, h) = size
        .split_once('x')
        .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)))
        .unwrap_or((1200, 800));
    let json = std::fs::read_to_string(pos[0]).expect("Modell lesen");
    let model: ModelInput = serde_json::from_str(&json).expect("Modell parsen");

    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .expect("kein GPU-Adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("render_png.device"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .expect("Device");

    let format = wgpu::TextureFormat::Rgba8UnormSrgb;
    let mut renderer = Renderer::new(&device, format);
    renderer.set_render_style(RenderStyle::from_str_or_shaded(&flag("--style", "shaded")));
    renderer.upload_model(&device, &model.walls, &model.slabs, &model.meshes);

    let (target, dist) = match bounds(&model) {
        Some((min, max)) => {
            let c = [(min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0, (min[2] + max[2]) / 2.0];
            let r = ((max[0] - min[0]).powi(2) + (max[1] - min[1]).powi(2) + (max[2] - min[2]).powi(2)).sqrt() * 0.5;
            (c, ((r.max(1.0) / (render3d::types::Camera::default().fov_y * 0.5).tan()) * 1.2).max(4.0))
        }
        None => ([2.5, 1.0, 2.0], 14.0),
    };
    // Optional: Blickziel (world x,y,z) und Abstand überschreiben (Ausschnitt statt Gesamtmodell).
    let target = flag("--target", "")
        .split(',')
        .map(|v| v.trim().parse::<f32>())
        .collect::<Result<Vec<_>, _>>()
        .ok()
        .filter(|v| v.len() == 3)
        .map(|v| [v[0], v[1], v[2]])
        .unwrap_or(target);
    let dist = flag("--dist", "").parse::<f32>().unwrap_or(dist);
    let camera = preset_camera(preset(&flag("--view", "iso")), target, dist);

    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("render_png.target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
    renderer.render(&device, &queue, &view, &camera, (w, h));

    let padded = (w * 4).div_ceil(256) * 256;
    let buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("render_png.readback"),
        size: (padded * h) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &buf,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(h) },
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    let slice = buf.slice(..);
    slice.map_async(wgpu::MapMode::Read, |r| r.expect("Readback"));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = slice.get_mapped_range();
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h as usize {
        rgba.extend_from_slice(&data[y * padded as usize..y * padded as usize + w as usize * 4]);
    }
    drop(data);
    write_png(pos[1], w, h, &rgba).expect("PNG schreiben");
    eprintln!("geschrieben: {} ({}x{})", pos[1], w, h);
}
