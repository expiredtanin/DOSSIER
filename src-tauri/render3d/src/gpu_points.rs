// GPU-Teil der Punktwolken ([27]): eigene Pipeline neben Mesh/Grid im selben Render-Pass,
// dasselbe Tiefen-/MSAA-/Farbziel (sonst inkompatibler Pass) und dieselbe `Globals`-Bind-Group.
// Läuft unverändert auf WebGPU (Browser) und nativ (Metal/Vulkan) — `Renderer` ruft nur
// `prepare` vor und `draw` im Pass auf.
//
// Je Punkt ein Instanz-Eintrag (Position 12 B + RGBA8 4 B); das Quad entsteht im Vertex-Shader
// aus `vertex_index` (6 Vertices je Instanz, kein Index-/Geometriepuffer je Punkt). Grosse Wolken
// liegen in Puffern zu höchstens `MAX_POINTS_PER_CHUNK` Punkten (je ein Draw-Call).

use std::collections::BTreeMap;

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::points::{chunk_ranges, clamp_point_size, PointCloudCpu, PointColorMode, POINT_WGSL};

/// Uniform je Wolke, 1:1 zu `PointParams` im WGSL.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PointParams {
    /// x = Grösse px, y/z = Viewport px, w = runde Punkte (1/0).
    params: [f32; 4],
}

struct PointChunk {
    positions: wgpu::Buffer,
    colors: wgpu::Buffer,
    start: usize,
    count: u32,
}

struct PointCloudGpu {
    cpu: PointCloudCpu,
    chunks: Vec<PointChunk>,
    uniform: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    mode: PointColorMode,
    size_px: f32,
    visible: bool,
}

/// Darstellungs-Einstellungen einer Wolke.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointStyle {
    pub mode: PointColorMode,
    pub size_px: f32,
    pub visible: bool,
}

/// Alle Punktwolken des Renderers + ihre Pipeline.
pub struct PointRenderer {
    pipeline: wgpu::RenderPipeline,
    params_layout: wgpu::BindGroupLayout,
    clouds: BTreeMap<u32, PointCloudGpu>,
}

impl PointRenderer {
    /// `globals_layout` = group(0) der übrigen Pipelines; Ziel-Format, Tiefenformat und Samples
    /// müssen mit dem Haupt-Pass übereinstimmen.
    pub fn new(
        device: &wgpu::Device,
        globals_layout: &wgpu::BindGroupLayout,
        color_format: wgpu::TextureFormat,
        depth_format: wgpu::TextureFormat,
        sample_count: u32,
    ) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("points.wgsl"),
            source: wgpu::ShaderSource::Wgsl(POINT_WGSL.into()),
        });
        let params_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("points.params.layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<PointParams>() as u64),
                },
                count: None,
            }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("points.layout"),
            bind_group_layouts: &[Some(globals_layout), Some(&params_layout)],
            immediate_size: 0,
        });
        let pos_layout = wgpu::VertexBufferLayout {
            array_stride: 12,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3],
        };
        let col_layout = wgpu::VertexBufferLayout {
            array_stride: 4,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![1 => Unorm8x4],
        };
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("points.pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                buffers: &[pos_layout, col_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: color_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                // Bildschirm-Quads, immer zur Kamera gewandt — kein Culling nötig.
                cull_mode: None,
                ..Default::default()
            },
            // Tiefentest gegen das Modell (Wände verdecken Punkte dahinter) und Tiefe schreiben
            // (Punkte verdecken Gitter/Kanten dahinter).
            depth_stencil: Some(wgpu::DepthStencilState {
                format: depth_format,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState {
                count: sample_count,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview_mask: None,
            cache: None,
        });
        Self {
            pipeline,
            params_layout,
            clouds: BTreeMap::new(),
        }
    }

    /// Setzt/ersetzt die Wolke `id`. `None`-Daten (unbrauchbare Eingabe) entfernen sie.
    pub fn set_cloud(
        &mut self,
        device: &wgpu::Device,
        id: u32,
        cpu: Option<PointCloudCpu>,
        style: PointStyle,
    ) {
        let Some(cpu) = cpu else {
            self.clouds.remove(&id);
            return;
        };
        let size_px = clamp_point_size(style.size_px);
        let colors = cpu.colors(style.mode);
        let chunks = chunk_ranges(cpu.len())
            .into_iter()
            .map(|(start, count)| PointChunk {
                positions: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("points.positions"),
                    contents: bytemuck::cast_slice(&cpu.positions[start * 3..(start + count) * 3]),
                    usage: wgpu::BufferUsages::VERTEX,
                }),
                colors: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("points.colors"),
                    contents: bytemuck::cast_slice(&colors[start..start + count]),
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                }),
                start,
                count: count as u32,
            })
            .collect();
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("points.params"),
            size: std::mem::size_of::<PointParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("points.params.bind"),
            layout: &self.params_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }],
        });
        self.clouds.insert(
            id,
            PointCloudGpu {
                cpu,
                chunks,
                uniform,
                bind_group,
                mode: style.mode,
                size_px,
                visible: style.visible,
            },
        );
    }

    /// Ändert nur die Darstellung (Farbmodus, Grösse, Sichtbarkeit). Bei neuem Farbmodus wird nur
    /// der Farbpuffer überschrieben (Positionen bleiben). `false`, wenn `id` unbekannt ist.
    pub fn set_style(&mut self, queue: &wgpu::Queue, id: u32, style: PointStyle) -> bool {
        let Some(c) = self.clouds.get_mut(&id) else {
            return false;
        };
        c.size_px = clamp_point_size(style.size_px);
        c.visible = style.visible;
        if c.cpu.effective_mode(style.mode) != c.cpu.effective_mode(c.mode) {
            let colors = c.cpu.colors(style.mode);
            for ch in &c.chunks {
                let end = ch.start + ch.count as usize;
                queue.write_buffer(&ch.colors, 0, bytemuck::cast_slice(&colors[ch.start..end]));
            }
        }
        c.mode = style.mode;
        true
    }

    pub fn remove(&mut self, id: u32) {
        self.clouds.remove(&id);
    }

    pub fn clear(&mut self) {
        self.clouds.clear();
    }

    /// Anzahl Punkte der Wolke `id` (0 = unbekannt), für Bindungen/Tests.
    pub fn point_count(&self, id: u32) -> usize {
        self.clouds.get(&id).map_or(0, |c| c.cpu.len())
    }

    /// World-Bounding-Box aller sichtbaren Wolken (für das Einpassen der Kamera).
    pub fn bounds(&self) -> Option<([f32; 3], [f32; 3])> {
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for c in self.clouds.values().filter(|c| c.visible) {
            for p in c.cpu.positions.chunks_exact(3) {
                for i in 0..3 {
                    min[i] = min[i].min(p[i]);
                    max[i] = max[i].max(p[i]);
                }
            }
        }
        min[0].is_finite().then_some((min, max))
    }

    /// Je Frame vor dem Pass: Viewport/Grösse in die Uniforms schreiben.
    pub fn prepare(&self, queue: &wgpu::Queue, viewport: (u32, u32)) {
        for c in self.clouds.values().filter(|c| c.visible) {
            let round = if c.size_px >= 3.0 { 1.0 } else { 0.0 };
            let p = PointParams {
                params: [c.size_px, viewport.0.max(1) as f32, viewport.1.max(1) as f32, round],
            };
            queue.write_buffer(&c.uniform, 0, bytemuck::bytes_of(&p));
        }
    }

    /// Im Haupt-Pass: alle sichtbaren Wolken zeichnen (ein Draw-Call je Puffer).
    pub fn draw<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>, globals: &'a wgpu::BindGroup) {
        let mut bound = false;
        for c in self.clouds.values().filter(|c| c.visible) {
            if !bound {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, globals, &[]);
                bound = true;
            }
            pass.set_bind_group(1, &c.bind_group, &[]);
            for ch in &c.chunks {
                pass.set_vertex_buffer(0, ch.positions.slice(..));
                pass.set_vertex_buffer(1, ch.colors.slice(..));
                pass.draw(0..6, 0..ch.count);
            }
        }
    }
}

// Headless-Render in eine Textur (Vulkan/lavapipe im Linux-Container, Metal auf macOS). Ohne
// GPU-Adapter wird der Test übersprungen (Meldung auf stderr) statt rot.
#[cfg(test)]
mod gpu_tests {
    use super::PointStyle;
    use crate::gpu::Renderer;
    use crate::points::{PointCloudCpu, PointColorMode};
    use crate::types::{Camera, WallInput};

    const W: u32 = 64;
    const H: u32 = 64;
    const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

    fn device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::default(),
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .ok()?;
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("points.test"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        }))
        .ok()
    }

    /// Rendert und liefert RGBA8 aller Pixel.
    fn render(device: &wgpu::Device, queue: &wgpu::Queue, r: &mut Renderer, cam: &Camera) -> Vec<u8> {
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        r.render(device, queue, &view, cam, (W, H));
        let padded = (W * 4).div_ceil(256) * 256;
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (padded * H) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(H),
                },
            },
            wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        );
        queue.submit([enc.finish()]);
        let slice = buf.slice(..);
        slice.map_async(wgpu::MapMode::Read, |r| r.expect("Readback"));
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let data = slice.get_mapped_range();
        let mut out = Vec::with_capacity((W * H * 4) as usize);
        for y in 0..H as usize {
            out.extend_from_slice(&data[y * padded as usize..y * padded as usize + W as usize * 4]);
        }
        out
    }

    fn pixel(img: &[u8], x: u32, y: u32) -> [u8; 3] {
        let i = ((y * W + x) * 4) as usize;
        [img[i], img[i + 1], img[i + 2]]
    }

    fn is_red(c: [u8; 3]) -> bool {
        c[0] > 200 && c[1] < 40 && c[2] < 40
    }

    /// Senkrechte Punkt-Fläche 2 × 2 m (Modell x −1..1, Höhe 0..2) auf Modell-y = `y`, rot.
    fn red_sheet(y: f64) -> PointCloudCpu {
        let mut xyz = Vec::new();
        let mut rgb = Vec::new();
        for i in 0..=40 {
            for k in 0..=40 {
                xyz.extend_from_slice(&[-1.0 + i as f32 * 0.05, 0.0, k as f32 * 0.05]);
                rgb.extend_from_slice(&[255, 0, 0]);
            }
        }
        PointCloudCpu::from_raw(&xyz, &rgb, &[], &[], [0.0, y, 0.0]).unwrap()
    }

    fn camera() -> Camera {
        // Blick von world +z (Modell-Süd, Nord-Achse negiert) auf den Nullpunkt, 1 m hoch.
        Camera { eye: [0.0, 1.0, 10.0], target: [0.0, 1.0, 0.0], ..Camera::default() }
    }

    const STYLE: PointStyle = PointStyle { mode: PointColorMode::Rgb, size_px: 4.0, visible: true };

    #[test]
    fn points_render_visible_and_respect_depth_of_model() {
        let Some((device, queue)) = device() else {
            eprintln!("kein GPU-Adapter — Punkt-Render-Test übersprungen");
            return;
        };
        let mut r = Renderer::new(&device, FORMAT);
        let wall: WallInput =
            serde_json::from_str(r#"{"start":[-3,0],"end":[3,0],"thickness":0.2,"height":3}"#).unwrap();
        r.upload_model(&device, &[wall], &[], &[]);
        let cam = camera();

        // Wolke VOR der Wand (Modell-y = −3 → world z = +3): rot in der Bildmitte.
        r.set_point_cloud(&device, 1, Some(red_sheet(-3.0)), STYLE);
        assert_eq!(r.point_cloud_len(1), 41 * 41);
        let img = render(&device, &queue, &mut r, &cam);
        let c = pixel(&img, W / 2, H / 2);
        assert!(is_red(c), "Mitte sollte rot sein: {c:?}");

        // Wolke HINTER der Wand (Modell-y = +5 → world z = −5): Wand verdeckt sie.
        r.set_point_cloud(&device, 1, Some(red_sheet(5.0)), STYLE);
        let img = render(&device, &queue, &mut r, &cam);
        let c = pixel(&img, W / 2, H / 2);
        assert!(!is_red(c), "Wand muss Punkte verdecken: {c:?}");

        // Unsichtbar geschaltet: auch vor der Wand nichts Rotes.
        r.set_point_cloud(&device, 1, Some(red_sheet(-3.0)), STYLE);
        assert!(r.set_point_cloud_style(&queue, 1, PointStyle { visible: false, ..STYLE }));
        let img = render(&device, &queue, &mut r, &cam);
        assert!(!is_red(pixel(&img, W / 2, H / 2)), "unsichtbare Wolke gezeichnet");

        // Farbmodus Höhe: nur der Farbpuffer wird ersetzt → Mitte nicht mehr Rot, nicht Hintergrund.
        let height = PointStyle { mode: PointColorMode::Height, ..STYLE };
        assert!(r.set_point_cloud_style(&queue, 1, height));
        let img = render(&device, &queue, &mut r, &cam);
        let c = pixel(&img, W / 2, H / 2);
        assert!(!is_red(c) && c != pixel(&img, 0, 0), "Höhenfarbe erwartet: {c:?}");

        // Entfernen + unbekannte id.
        r.remove_point_cloud(1);
        assert_eq!(r.point_cloud_len(1), 0);
        assert!(!r.set_point_cloud_style(&queue, 1, STYLE));
    }

    #[test]
    fn fixed_pixel_size_independent_of_distance() {
        let Some((device, queue)) = device() else {
            eprintln!("kein GPU-Adapter — Punkt-Render-Test übersprungen");
            return;
        };
        let mut r = Renderer::new(&device, FORMAT);
        let one = PointCloudCpu::from_raw(&[0.0, 0.0, 1.0], &[0, 0, 255], &[], &[], [0.0; 3]).unwrap();
        let count_blue =
            |img: &[u8]| img.chunks_exact(4).filter(|p| p[2] > 200 && p[0] < 60 && p[1] < 60).count();
        r.set_point_cloud(&device, 7, Some(one), PointStyle { size_px: 8.0, ..STYLE });
        let near = render(&device, &queue, &mut r, &Camera { eye: [0.0, 1.0, 5.0], ..camera() });
        let far = render(&device, &queue, &mut r, &Camera { eye: [0.0, 1.0, 50.0], ..camera() });
        let (a, b) = (count_blue(&near), count_blue(&far));
        // Runder Punkt Ø 8 px ≈ 50 px Fläche, unabhängig vom Abstand.
        assert!(a > 25 && a < 80, "nah: {a}");
        assert!((a as i32 - b as i32).abs() <= 6, "nah {a} vs fern {b}");
    }
}
