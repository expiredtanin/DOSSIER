// Headless-Offscreen-Renderpfad (Feature "headless"): derselbe Draw-Code wie der
// Fenster-Spike (`gpu::Renderer::render` nimmt ohnehin nur Device/Queue/View —
// Surface- oder Offscreen-Textur macht dafuer keinen Unterschied), aber OHNE
// Fenster/Surface. Ziel ist eine `wgpu::Texture` (RENDER_ATTACHMENT | COPY_SRC),
// aus der die Pixel per Buffer-Copy ausgelesen und als PNG kodiert werden.
//
// Zweck: Engine-Nordstern Punkt 3 (siehe HANDOVER.md) — deterministisches
// Headless-Rendering fuer PNG-Export und Golden-Image-Tests, ohne Fenster/Display-
// Server-Zwang. Details/Row-Alignment-Falle: docs/design/engine-headless.md.
//
// WICHTIG (Row-Alignment-Falle): wgpu verlangt beim Texture->Buffer-Copy, dass
// `bytes_per_row` ein Vielfaches von `wgpu::COPY_BYTES_PER_ROW_ALIGNMENT` (256)
// ist. Bei RGBA8 (4 Byte/Pixel) trifft das NUR zufaellig zu (z.B. Breite 300px =
// 1200 Byte/Zeile -> kein Vielfaches von 256). Der Zielpuffer wird daher auf die
// naechste 256er-Grenze gepolstert (`padded_bytes_per_row`); beim Auslesen wird
// jede Zeile wieder auf die echte Breite (`unpadded_bytes_per_row`) zurueckgeschnitten.

use image::ImageEncoder;

use crate::chunks::{ChunkGeom, ChunkRenderer, DashBatch, FillBatch, LineBatch, View};
use crate::gpu::Renderer;
use crate::types::{Scene, ViewBox};

/// Farbformat der Offscreen-Zieltextur. Non-sRGB (Rgba8Unorm): der Fragment-
/// Shader schreibt seine Farbwerte unkonvertiert — identisch zur Annahme, unter
/// der der Textpass mit `glyphon::ColorMode::Web` faehrt (siehe
/// `gpu::Renderer::ensure_text`); damit bleibt der Offscreen-Pfad farblich
/// konsistent zum Fenster-Pfad auf Plattformen ohne sRGB-Surface-Format.
pub const COLOR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Straff gepacktes RGBA8-Bild (kein Zeilen-Padding mehr — das wurde beim
/// Auslesen bereits entfernt, siehe Modul-Kopf).
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` Bytes, Reihenfolge R,G,B,A, zeilenweise von oben.
    pub pixels: Vec<u8>,
}

impl RgbaImage {
    /// Kodiert das Bild als PNG-Bytes.
    pub fn encode_png(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder
            .write_image(
                &self.pixels,
                self.width,
                self.height,
                image::ExtendedColorType::Rgba8,
            )
            .expect("PNG-Encoding fehlgeschlagen");
        bytes
    }

    /// Dekodiert PNG-Bytes zurueck in ein straff gepacktes RGBA8-Bild —
    /// Gegenstueck zu `encode_png`, damit der Golden-Image-Test das Referenzbild
    /// laden kann, ohne die `image`-Crate selbst zu ziehen.
    pub fn decode_png(bytes: &[u8]) -> Result<Self, String> {
        let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
            .map_err(|e| format!("PNG-Dekodierung fehlgeschlagen: {e}"))?
            .into_rgba8();
        Ok(Self {
            width: img.width(),
            height: img.height(),
            pixels: img.into_raw(),
        })
    }
}

/// Haelt Device/Queue + den geteilten Draw-Code (`gpu::Renderer`) fuer den
/// Offscreen-Pfad. Ein Renderer pro Instanz reicht — die Pipelines sind an
/// `COLOR_FORMAT` gebunden, das bleibt fuer alle Aufrufe gleich.
pub struct HeadlessRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    renderer: Renderer,
}

impl HeadlessRenderer {
    /// Baut Instance/Adapter/Device OHNE Surface (kein Fenster, keine Display-
    /// Session noetig). Backend explizit auf Vulkan gepinnt: Vulkan rendert
    /// offscreen ohne jede Fenster-/Surface-Abhaengigkeit; GL braucht auf Linux
    /// i.d.R. einen EGL/GLX-Kontext, der ohne Display-Server Sonderfaelle hat.
    ///
    /// `Err` statt Panik, wenn kein Adapter/Device verfuegbar ist — der Golden-
    /// Image-Test ueberspringt sich dann sauber (CI-Runner ohne GPU).
    pub fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            // Kein Fenster -> keine kompatible Surface noetig.
            compatible_surface: None,
        }))
        .map_err(|e| format!("kein Vulkan-Adapter fuer Headless-Rendering gefunden: {e}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("headless.device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        }))
        .map_err(|e| format!("Headless-Device anfordern fehlgeschlagen: {e}"))?;

        let renderer = Renderer::new(&device, COLOR_FORMAT);
        Ok(Self {
            device,
            queue,
            renderer,
        })
    }

    /// Rendert `scene` in ein `width`x`height`-Offscreen-Bild (Papier-Massstab
    /// `paper_scale_n`, z.B. `100.0` fuer 1:100) und liest es als straff gepacktes
    /// RGBA8-Bild zurueck. Jeder Aufruf laedt die Szene neu hoch (kein Zwischen-
    /// Zustand noetig fuer den CLI-/Test-Anwendungsfall).
    pub fn render_to_image(
        &mut self,
        scene: &Scene,
        width: u32,
        height: u32,
        view_box: ViewBox,
        paper_scale_n: f32,
    ) -> RgbaImage {
        let (width, height) = (width.max(1), height.max(1));
        self.renderer.paper_scale_n = paper_scale_n;
        self.renderer.upload_scene(&self.device, scene);

        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("headless.target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COLOR_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        self.renderer
            .render(&self.device, &self.queue, &view, view_box, (width, height));

        RgbaImage {
            width,
            height,
            pixels: self.read_pixels(&texture, width, height),
        }
    }

    /// Rendert GPU-Chunks (je Eintrag die flache Ausgabe der Kern-Kompilierung
    /// `gpu_compile_flat`, gepackte Linien-Vertices) ueber den Chunk-Renderer, den der
    /// native macOS-Pfad benutzt (`chunks.rs`: dieselben Shader und dieselbe
    /// Zeichenreihenfolge, nur ohne Metal-Flaeche). `view` in Bildschirm-Einheiten.
    /// Fuer Headless-Vergleiche Chunk-Pfad gegen Szenen-Pfad.
    pub fn render_chunks_to_image(&self, chunks: &[Vec<u32>], width: u32, height: u32, view: View, paper_scale_n: f64) -> Result<RgbaImage, String> {
        let (width, height) = (width.max(1), height.max(1));
        let mut cr = ChunkRenderer::new(&self.device, COLOR_FORMAT, 4);
        let mut layout = Vec::new();
        let mut next_id = 1u32;
        for words in chunks {
            let (geom, bufs) = chunk_from_flat(words, &mut next_id).ok_or("Chunk-Ausgabe unlesbar")?;
            for (id, bytes) in bufs {
                cr.upload(&self.device, id, &bytes);
            }
            layout.push(geom);
        }
        cr.set_layout(layout);
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("headless.chunks.target"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COLOR_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let tv = texture.create_view(&wgpu::TextureViewDescriptor::default());
        cr.render(&self.device, &self.queue, &tv, view, (width, height), paper_scale_n);
        Ok(RgbaImage { width, height, pixels: self.read_pixels(&texture, width, height) })
    }

    /// Texture -> gepolsterter Buffer -> straff gepacktes Pixel-Array (Row-
    /// Alignment-Falle, siehe Modul-Kopf).
    fn read_pixels(&self, texture: &wgpu::Texture, width: u32, height: u32) -> Vec<u8> {
        const BYTES_PER_PIXEL: u32 = 4;
        let unpadded_bytes_per_row = width * BYTES_PER_PIXEL;
        let padded_bytes_per_row = align_up(unpadded_bytes_per_row, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer_size = u64::from(padded_bytes_per_row) * u64::from(height);

        let output_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("headless.readback"),
            size: buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("headless.copy"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &output_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(std::iter::once(encoder.finish()));

        let slice = output_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        // Vulkan hat keine Event-Loop wie ein Fenster -> Poll blockierend, bis
        // die Map-Callback feuert (kein busy-loop noetig, `PollType::Wait` wartet
        // ohne Timeout auf die juengste Submission).
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("Device-Poll fehlgeschlagen");
        rx.recv()
            .expect("Map-Callback nie aufgerufen")
            .expect("Buffer-Mapping fehlgeschlagen");

        let data = slice.get_mapped_range();
        let mut pixels =
            Vec::with_capacity(unpadded_bytes_per_row as usize * height as usize);
        for row in 0..height as usize {
            let start = row * padded_bytes_per_row as usize;
            let end = start + unpadded_bytes_per_row as usize;
            pixels.extend_from_slice(&data[start..end]);
        }
        drop(data);
        output_buffer.unmap();
        pixels
    }
}

/// Rundet `value` auf das naechste Vielfache von `align` (>=1) auf.
fn align_up(value: u32, align: u32) -> u32 {
    if align <= 1 {
        return value;
    }
    ((value + align - 1) / align) * align
}

/// Modell-Ausmass (minX, minY, maxX, maxY, Meter) einer flachen Chunk-Ausgabe (`gpu_compile_flat`).
pub fn chunk_flat_bounds(words: &[u32]) -> Option<[f64; 4]> {
    let meta = flat_meta(words)?;
    (meta.len() >= 6).then(|| [meta[2], meta[3], meta[4], meta[5]])
}

fn flat_meta(words: &[u32]) -> Option<Vec<f64>> {
    let m = *words.first()? as usize;
    if words.len() < 2 + 2 * m {
        return None;
    }
    Some((0..m).map(|i| f64::from_bits(words[2 + 2 * i] as u64 | ((words[3 + 2 * i] as u64) << 32))).collect())
}

/// Flache Kern-Ausgabe (Layout s. `core/src/gpu_compile.rs`, gepackt) → Layout-Eintrag + Puffer
/// (ID, Bytes) wie sie die Webview an den nativen Renderer schickt (`nativeGl.ts`).
pub fn chunk_from_flat(words: &[u32], next_id: &mut u32) -> Option<(ChunkGeom, Vec<(u32, Vec<u8>)>)> {
    let meta = flat_meta(words)?;
    if meta.len() < 12 {
        return None;
    }
    let n = |v: f64| -> Option<usize> { (v >= 0.0 && v.fract() == 0.0).then_some(v as usize) };
    let (nfp, nfi, nlv, nli, nf, nl) = (n(meta[6])?, n(meta[7])?, n(meta[8])?, n(meta[9])?, n(meta[10])?, n(meta[11])?);
    let mut k = 12;
    let rgba = |m: &[f64]| [m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32];
    let mut fill_batches = Vec::new();
    for _ in 0..nf {
        let b = meta.get(k..k + 6)?;
        fill_batches.push(FillBatch { start: b[0] as u32, count: b[1] as u32, color: rgba(&b[2..6]) });
        k += 6;
    }
    let mut line_batches = Vec::new();
    for _ in 0..nl {
        let b = meta.get(k..k + 8)?;
        line_batches.push(LineBatch { start: b[0] as u32, count: b[1] as u32, color: rgba(&b[2..6]), stroke_mm: b[6] as f32, screen_px: b[7] == 1.0, device_px: false });
        k += 8;
    }
    let (nd, ndb) = (meta.get(k).copied().map(n).unwrap_or(Some(0))?, meta.get(k + 1).copied().map(n).unwrap_or(Some(0))?);
    k += 2;
    let mut dash_batches = Vec::new();
    for _ in 0..ndb {
        let b = meta.get(k..k + 8)?;
        dash_batches.push(DashBatch { start: b[0] as u32, count: b[1] as u32, color: rgba(&b[2..6]), stroke_mm: b[6] as f32, line_at: b[7] as u32 });
        k += 8;
    }
    let mut off = 2 + 2 * meta.len();
    let mut bufs = Vec::new();
    let mut take = |len: usize, off: &mut usize| -> Option<Option<u32>> {
        let w = words.get(*off..*off + len)?;
        *off += len;
        if len == 0 {
            return Some(None);
        }
        let id = *next_id;
        *next_id += 1;
        bufs.push((id, w.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()));
        Some(Some(id))
    };
    let fill_pos = take(nfp, &mut off)?;
    let fill_idx = take(nfi, &mut off)?;
    let line_vtx = take(nlv, &mut off)?;
    let line_idx = take(nli, &mut off)?;
    let dash_inst = take(nd * 16, &mut off)?;
    let geom = ChunkGeom {
        fill_pos,
        fill_idx,
        fill_batches,
        line_vtx,
        line_idx,
        line_batches,
        dash_inst,
        dash_batches,
        origin: [meta[0], meta[1]],
        greyed: false,
    };
    Some((geom, bufs))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Flache Ausgabe wie `gpu_compile_flat` mit EINER gestrichelten Linie (Instanz) von
    /// (0,0) nach (L,0) Bildschirm-Einheiten, Muster an/aus = `on`/`off`.
    fn dashed_chunk(len: f32, on: f32, off: f32, stroke_mm: f64) -> Vec<u32> {
        let mut meta: Vec<f64> = vec![0.0, 0.0, 0.0, 0.0, len as f64 / 90.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        meta.extend_from_slice(&[1.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, stroke_mm, 0.0]);
        let mut out = vec![meta.len() as u32, 0];
        for m in &meta {
            let b = m.to_bits();
            out.push(b as u32);
            out.push((b >> 32) as u32);
        }
        let inst = [0.0, 0.0, len, 0.0, 0.0, len, on + off, 2.0, on, off, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0f32];
        out.extend(inst.iter().map(|v| v.to_bits()));
        out
    }

    /// Der Chunk-Renderer (nativer macOS-Pfad, hier ueber Vulkan/lavapipe) zeichnet Striche
    /// und Luecken: entlang der Achse wechseln gedeckte und freie Pixel im Muster-Takt.
    #[test]
    fn chunk_renderer_zeichnet_striche_und_luecken() {
        let r = match HeadlessRenderer::new() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("uebersprungen, kein Headless-Adapter: {e}");
                return;
            }
        };
        // 200 Einheiten lang, Muster 20 an / 20 aus; Ansicht 1:1 auf 200x40 px.
        let chunk = dashed_chunk(200.0, 20.0, 20.0, 0.05);
        let img = r
            .render_chunks_to_image(&[chunk], 200, 40, View { x: 0.0, y: -20.0, w: 200.0, h: 40.0 }, 1000.0)
            .expect("rendern");
        let px = |x: u32| {
            let i = ((20 * img.width + x) * 4) as usize;
            img.pixels[i] // Rot-Kanal: Linie schwarz -> 0, Hintergrund weiss -> 255
        };
        // Strich-Mitten (10, 50, 90 …) dunkel, Luecken-Mitten (30, 70, 110 …) hell.
        for c in [10u32, 50, 90, 130, 170] {
            assert!(px(c) < 80, "Strich bei x={c}: {}", px(c));
        }
        for c in [30u32, 70, 110, 150] {
            assert!(px(c) > 200, "Luecke bei x={c}: {}", px(c));
        }
    }

    #[test]
    fn flache_ausgabe_wird_gelesen() {
        let mut id = 1;
        let (g, bufs) = chunk_from_flat(&dashed_chunk(100.0, 5.0, 5.0, 0.35), &mut id).unwrap();
        assert_eq!(g.dash_inst, Some(1));
        assert_eq!(g.dash_batches.len(), 1);
        assert_eq!(bufs[0].1.len(), 64);
        assert!(g.line_vtx.is_none() && g.fill_pos.is_none());
        assert!(chunk_from_flat(&[5, 0, 1], &mut id).is_none());
    }
}
