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
            ..Default::default()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            // Kein Fenster -> keine kompatible Surface noetig.
            compatible_surface: None,
        }))
        .ok_or_else(|| "kein Vulkan-Adapter fuer Headless-Rendering gefunden".to_string())?;
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("headless.device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
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
            wgpu::ImageCopyTexture {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &output_buffer,
                layout: wgpu::ImageDataLayout {
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
        // die Map-Callback feuert (kein busy-loop noetig, `Maintain::Wait` wartet).
        self.device.poll(wgpu::Maintain::Wait);
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
