// wgpu-Pipelines des nativen 2D-Renderers (nur mit Feature "render").
//
// Zwei Pipelines analog zum WebGL-Pfad:
//  - Fuell-Pipeline: gefuellte Polygone, Ortho-Matrix-Uniform.
//  - Linien-Pipeline: Quad-Expansion, Breite in echten Papier-mm (Shader).
//
// Der Renderer ist fenster-/surface-agnostisch: er bekommt ein `Device`, eine
// `Queue` und ein `TextureView` (die Surface oder eine Offscreen-Textur) und
// zeichnet dort hinein. Die Fenster-Anbindung (winit) liegt separat im Spike-Bin.
//
// Pro-Batch-Uniforms ueber DYNAMISCHE Offsets: alle Globals-Bloecke (je Fuell-/
// Linien-Batch einer) liegen hintereinander in EINEM Uniform-Puffer (auf die
// GPU-Mindest-Ausrichtung gepolstert). Vor dem Zeichnen wird der ganze Puffer
// EINMAL geschrieben; jeder Draw-Call bindet seinen Block per dynamischem Offset.
// Das umgeht die Regel "kein write_buffer auf gebundenen Puffer im offenen Pass".

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::ortho::{compute_ortho_matrix, mm_to_device_px, Mat4};
use crate::shaders::{FILL_WGSL, LINE_WGSL};
use crate::tessellate::{compile_scene, GpuGeometry};
use crate::types::{Scene, ViewBox};

/// Uniform-Block, 1:1 zum WGSL-`Globals`-Struct. std140-kompatibel ausgelegt
/// (16-Byte-Alignment der mat4/vec4, Skalare am Ende gepackt).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    view_proj: [f32; 16],
    color: [f32; 4],
    viewport_px: [f32; 2],
    stroke_px: f32,
    stroke_scale: f32,
}

impl Default for Globals {
    fn default() -> Self {
        Self {
            view_proj: crate::ortho::identity(),
            color: [0.0, 0.0, 0.0, 1.0],
            viewport_px: [1.0, 1.0],
            stroke_px: 0.0,
            stroke_scale: 1.0,
        }
    }
}

/// Rundet `size` auf das naechste Vielfache von `align` (>=1) auf.
fn align_up(size: u64, align: u64) -> u64 {
    if align <= 1 {
        return size;
    }
    ((size + align - 1) / align) * align
}

/// GPU-seitige Puffer + Batch-Metadaten einer tessellierten Szene.
struct SceneBuffers {
    fill_vbo: Option<wgpu::Buffer>,
    fill_ibo: Option<wgpu::Buffer>,
    line_vbo: Option<wgpu::Buffer>,
    line_ibo: Option<wgpu::Buffer>,
    geo: GpuGeometry,
}

/// Der native 2D-Renderer: haelt beide Pipelines, den (dynamischen) Uniform-
/// Puffer und die aktuell hochgeladene Szene. Pan/Zoom aktualisiert nur die
/// Ortho-Matrix (kein Re-Tessellieren).
pub struct Renderer {
    fill_pipeline: wgpu::RenderPipeline,
    line_pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    /// Ausgerichtete Groesse eines Globals-Blocks im dynamischen Uniform-Puffer.
    uniform_stride: u64,
    /// Aktuell allozierter Uniform-Puffer + zugehoerige Bind-Group (wachsen bei Bedarf).
    uniform: Option<UniformArena>,
    scene: Option<SceneBuffers>,
    /// Loeschfarbe (Zeichenblatt), Default hell wie im WebGL-Pfad (#f0f0f0).
    pub clear_color: wgpu::Color,
    /// Papier-Massstab-Nenner (1:N) fuer echte mm-Strichbreiten.
    pub paper_scale_n: f32,
}

/// Ein Uniform-Puffer, der `capacity` Globals-Bloecke fasst, plus Bind-Group.
struct UniformArena {
    buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    capacity: u64,
}

impl Renderer {
    /// Erzeugt Pipelines + Layout fuer ein gegebenes Farbformat (Surface).
    pub fn new(device: &wgpu::Device, color_format: wgpu::TextureFormat) -> Self {
        let fill_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fill.wgsl"),
            source: wgpu::ShaderSource::Wgsl(FILL_WGSL.into()),
        });
        let line_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("line.wgsl"),
            source: wgpu::ShaderSource::Wgsl(LINE_WGSL.into()),
        });

        // Ein Uniform-Block (Globals), fuer beide Pipelines geteilt, mit dynamischem
        // Offset (jeder Batch bekommt seinen eigenen Block-Slice).
        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("globals.layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(
                            std::mem::size_of::<Globals>() as u64
                        ),
                    },
                    count: None,
                }],
            });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("2d.layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        // Alpha-Blending (SRC_ALPHA, ONE_MINUS_SRC_ALPHA) wie im WebGL-Pfad.
        let blend = Some(wgpu::BlendState::ALPHA_BLENDING);
        let color_target = wgpu::ColorTargetState {
            format: color_format,
            blend,
            write_mask: wgpu::ColorWrites::ALL,
        };

        // Fuell-Pipeline: ein vec2-Attribut (Bildschirm-Position).
        let fill_vertex_layout = wgpu::VertexBufferLayout {
            array_stride: 2 * 4,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x2],
        };
        let fill_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("fill.pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &fill_module,
                entry_point: "vs_main",
                buffers: &[fill_vertex_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &fill_module,
                entry_point: "fs_main",
                targets: &[Some(color_target.clone())],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                // Ohr-Clipping liefert stets CCW; wir lassen Culling aus (robuster).
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // Linien-Pipeline: [pos vec2, bisector vec2, side f32, miter f32], stride 6*4.
        let line_vertex_layout = wgpu::VertexBufferLayout {
            array_stride: 6 * 4,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32, 3 => Float32],
        };
        let line_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("line.pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &line_module,
                entry_point: "vs_main",
                buffers: &[line_vertex_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &line_module,
                entry_point: "fs_main",
                targets: &[Some(color_target)],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // Block-Stride = Globals auf die Dynamic-Offset-Ausrichtung des Geraets gepolstert.
        let min_align = device.limits().min_uniform_buffer_offset_alignment as u64;
        let uniform_stride = align_up(std::mem::size_of::<Globals>() as u64, min_align.max(1));

        Self {
            fill_pipeline,
            line_pipeline,
            bind_group_layout,
            uniform_stride,
            uniform: None,
            scene: None,
            // #f0f0f0 (== --sheet). 0.941 entspricht dem WebGL-clearColor.
            clear_color: wgpu::Color {
                r: 0.941,
                g: 0.941,
                b: 0.941,
                a: 1.0,
            },
            paper_scale_n: 100.0,
        }
    }

    /// Tessellliert eine Szene und laedt die Puffer hoch (einmal je Szene).
    pub fn upload_scene(&mut self, device: &wgpu::Device, scene: &Scene) {
        let geo = compile_scene(scene);

        let mk_vbo = |data: &[f32], label: &str| -> Option<wgpu::Buffer> {
            if data.is_empty() {
                return None;
            }
            Some(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(data),
                usage: wgpu::BufferUsages::VERTEX,
            }))
        };
        let mk_ibo = |data: &[u32], label: &str| -> Option<wgpu::Buffer> {
            if data.is_empty() {
                return None;
            }
            Some(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(data),
                usage: wgpu::BufferUsages::INDEX,
            }))
        };

        self.scene = Some(SceneBuffers {
            fill_vbo: mk_vbo(&geo.fill_pos, "fill.vbo"),
            fill_ibo: mk_ibo(&geo.fill_idx, "fill.ibo"),
            line_vbo: mk_vbo(&geo.line_verts, "line.vbo"),
            line_ibo: mk_ibo(&geo.line_idx, "line.ibo"),
            geo,
        });
    }

    /// Stellt sicher, dass der dynamische Uniform-Puffer mindestens `count`
    /// Bloecke fasst; realloziert (Puffer + Bind-Group) bei Bedarf.
    fn ensure_uniform_capacity(&mut self, device: &wgpu::Device, count: u64) {
        let need = count.max(1);
        if let Some(u) = &self.uniform {
            if u.capacity >= need {
                return;
            }
        }
        let size = self.uniform_stride * need;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals.buffer"),
            size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globals.bind"),
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &buffer,
                    offset: 0,
                    size: wgpu::BufferSize::new(std::mem::size_of::<Globals>() as u64),
                }),
            }],
        });
        self.uniform = Some(UniformArena {
            buffer,
            bind_group,
            capacity: need,
        });
    }

    /// Zeichnet einen Frame in `view` (Surface- oder Offscreen-Textur).
    /// Pan/Zoom kommt ueber `view_box`/`viewport`; nur die Ortho-Matrix aendert sich.
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        view: &wgpu::TextureView,
        view_box: ViewBox,
        viewport: (u32, u32),
    ) {
        let (vw, vh) = (viewport.0 as f32, viewport.1 as f32);
        let proj: Mat4 = compute_ortho_matrix(view_box, vw, vh);
        let mm_px = mm_to_device_px(view_box, vw, vh, self.paper_scale_n);

        // Alle Globals-Bloecke der Reihenfolge nach (erst Fuell-, dann Linien-Batches)
        // sammeln, den Puffer einmal schreiben, danach nur noch dynamisch binden.
        let mut blocks: Vec<Globals> = Vec::new();
        if let Some(scene) = &self.scene {
            for b in &scene.geo.fill_batches {
                blocks.push(Globals {
                    view_proj: proj,
                    color: b.color,
                    viewport_px: [vw, vh],
                    stroke_px: 0.0,
                    stroke_scale: mm_px,
                });
            }
            for b in &scene.geo.line_batches {
                blocks.push(Globals {
                    view_proj: proj,
                    color: b.color,
                    viewport_px: [vw, vh],
                    stroke_px: b.stroke_mm,
                    stroke_scale: mm_px,
                });
            }
        }

        self.ensure_uniform_capacity(device, blocks.len() as u64);

        // Alle Bloecke in den (auf uniform_stride gepolsterten) Puffer schreiben.
        if let Some(u) = &self.uniform {
            let stride = self.uniform_stride as usize;
            let mut bytes = vec![0u8; stride * blocks.len().max(1)];
            for (i, g) in blocks.iter().enumerate() {
                let off = i * stride;
                bytes[off..off + std::mem::size_of::<Globals>()]
                    .copy_from_slice(bytemuck::bytes_of(g));
            }
            if !blocks.is_empty() {
                queue.write_buffer(&u.buffer, 0, &bytes);
            }
        }

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("2d.encoder"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("2d.pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(self.clear_color),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if let (Some(scene), Some(u)) = (&self.scene, &self.uniform) {
                let stride = self.uniform_stride as u32;
                let mut block = 0u32; // Laufindex ueber Fuell- dann Linien-Batches

                // 1) Fuellungen.
                if let (Some(vbo), Some(ibo)) = (&scene.fill_vbo, &scene.fill_ibo) {
                    pass.set_pipeline(&self.fill_pipeline);
                    pass.set_vertex_buffer(0, vbo.slice(..));
                    pass.set_index_buffer(ibo.slice(..), wgpu::IndexFormat::Uint32);
                    for b in &scene.geo.fill_batches {
                        pass.set_bind_group(0, &u.bind_group, &[block * stride]);
                        let start = b.start_index;
                        pass.draw_indexed(start..start + b.index_count, 0, 0..1);
                        block += 1;
                    }
                } else {
                    block += scene.geo.fill_batches.len() as u32;
                }

                // 2) Linien (Umrisse + freie Linien).
                if let (Some(vbo), Some(ibo)) = (&scene.line_vbo, &scene.line_ibo) {
                    pass.set_pipeline(&self.line_pipeline);
                    pass.set_vertex_buffer(0, vbo.slice(..));
                    pass.set_index_buffer(ibo.slice(..), wgpu::IndexFormat::Uint32);
                    for b in &scene.geo.line_batches {
                        pass.set_bind_group(0, &u.bind_group, &[block * stride]);
                        let start = b.start_index;
                        pass.draw_indexed(start..start + b.index_count, 0, 0..1);
                        block += 1;
                    }
                }
            }
        }
        queue.submit(std::iter::once(encoder.finish()));
    }
}
