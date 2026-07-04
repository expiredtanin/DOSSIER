// wgpu-Pipeline des nativen 3D-Renderers (nur mit Feature "render").
//
// Eine Pipeline: extrudierte Wand-Meshes mit Tiefenpuffer, View-Projektions-
// Matrix-Uniform und einem Directional-Light im Fragment-Shader. Backface-Culling
// ist aktiv (die Extrusion liefert konsistent nach aussen zeigende Flaechen, siehe
// mesh.rs) — das haelt das Innere der Waende korrekt verdeckt.
//
// Der Renderer ist fenster-/surface-agnostisch: er bekommt `Device`, `Queue` und
// ein `TextureView` (Surface- oder Offscreen-Textur) plus die aktuelle Kamera und
// zeichnet dort hinein. Die Fenster-Anbindung (winit) liegt separat im Spike-Bin.

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::math::{view_projection, Mat4};
use crate::mesh::{build_scene_mesh, build_walls_mesh};
use crate::shaders::MESH_WGSL;
use crate::types::{Camera, Mesh, MeshInput, SlabInput, WallInput, FLOATS_PER_VERTEX};

/// Tiefenformat des Z-Puffers (32 Bit Float, ueberall verfuegbar).
pub const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

/// MSAA-Samples fuer Farb- und Tiefenziel. 4x ist auf allen gaengigen Backends
/// (Vulkan/Metal/DX12/GL) fuer die ueblichen Oberflaechenformate verfuegbar und
/// gleicht die Treppenstufen an Wandkanten/Silhouetten spuerbar aus.
const SAMPLE_COUNT: u32 = 4;

/// Uniform-Block, 1:1 zum WGSL-`Globals`-Struct. std140-kompatibel (mat4/vec4 auf
/// 16 Byte ausgerichtet).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    view_proj: [f32; 16],
    light_dir: [f32; 4],
    sky_color: [f32; 4],
    ground_color: [f32; 4],
    sun_color: [f32; 4],
    /// x = Darstellungsart (0 = shaded/Material, 1 = weiss/Clay); siehe shaders.rs.
    mode: [f32; 4],
}

impl Default for Globals {
    fn default() -> Self {
        Self {
            view_proj: crate::math::identity(),
            // Richtung ZUM Licht (world), normiert. Sonne oben-vorne (6,12,4).
            light_dir: normalize4([6.0, 12.0, 4.0]),
            // Himmels-Ambient (von oben): helles, leicht kuehles Licht.
            sky_color: [0.66, 0.68, 0.72, 1.0],
            // Boden-Ambient (von unten): dunkler, warmer Ton (Bounce/Schatten).
            ground_color: [0.30, 0.29, 0.27, 1.0],
            // Directional-Sonne: warmweiss, moderat.
            sun_color: [0.55, 0.53, 0.49, 1.0],
            mode: [0.0, 0.0, 0.0, 0.0],
        }
    }
}

fn normalize4(v: [f32; 3]) -> [f32; 4] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-9);
    [v[0] / l, v[1] / l, v[2] / l, 0.0]
}

/// GPU-seitige Puffer eines hochgeladenen Meshes.
struct MeshBuffers {
    vbo: wgpu::Buffer,
    ibo: wgpu::Buffer,
    index_count: u32,
}

/// Der native 3D-Renderer: haelt die Pipeline, das Uniform (View-Projektion +
/// Licht) und das aktuell hochgeladene Mesh. Ein Tiefenpuffer wird passend zur
/// Ziel-Groesse (neu) angelegt.
pub struct Renderer {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    mesh: Option<MeshBuffers>,
    depth: Option<DepthTarget>,
    msaa: Option<MsaaTarget>,
    /// Farbformat des Render-Ziels (Surface), fuer die MSAA-Zwischentextur.
    color_format: wgpu::TextureFormat,
    globals: Globals,
    /// Loeschfarbe (Hintergrund). Default heller Grauton wie die three.js-Sicht.
    pub clear_color: wgpu::Color,
}

/// Tiefen-Textur samt View, an eine bestimmte Groesse gebunden.
struct DepthTarget {
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

/// Multisampled Farb-Zwischentextur samt View, an eine bestimmte Groesse
/// gebunden. Wird jeden Frame in das eigentliche Ziel (Surface-View) aufgeloest.
struct MsaaTarget {
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

impl Renderer {
    /// Erzeugt Pipeline + Layout fuer ein gegebenes Farbformat (Surface).
    pub fn new(device: &wgpu::Device, color_format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("mesh.wgsl"),
            source: wgpu::ShaderSource::Wgsl(MESH_WGSL.into()),
        });

        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("globals.layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(
                            std::mem::size_of::<Globals>() as u64
                        ),
                    },
                    count: None,
                }],
            });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("3d.layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });

        // Vertex-Layout: [pos vec3, normal vec3, color vec3], stride 9*4.
        let vertex_layout = wgpu::VertexBufferLayout {
            array_stride: (FLOATS_PER_VERTEX * 4) as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x3],
        };

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("mesh.pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                buffers: &[vertex_layout],
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
                // Aussen zeigende Flaechen sind CCW (mesh.rs) -> Rueckseiten cullen.
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState {
                count: SAMPLE_COUNT,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview_mask: None,
            cache: None,
        });

        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals.buffer"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globals.bind"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }],
        });

        Self {
            pipeline,
            bind_group,
            uniform,
            mesh: None,
            depth: None,
            msaa: None,
            color_format,
            globals: Globals::default(),
            // #f5f5f5 heller Hintergrund (wie der 2D-Grundriss).
            clear_color: wgpu::Color {
                r: 0.961,
                g: 0.961,
                b: 0.961,
                a: 1.0,
            },
        }
    }

    /// Erzeugt das Mesh aus geflachten Waenden und laedt die Puffer hoch.
    pub fn upload_walls(&mut self, device: &wgpu::Device, walls: &[WallInput]) {
        self.upload_mesh(device, build_walls_mesh(walls));
    }

    /// Erzeugt das Mesh aus Waenden, Deckenplatten UND rohen Kontext-Meshes
    /// (Terrain/importierte Volumen, siehe `MeshInput`) und laedt die Puffer hoch.
    pub fn upload_model(
        &mut self,
        device: &wgpu::Device,
        walls: &[WallInput],
        slabs: &[SlabInput],
        meshes: &[MeshInput],
    ) {
        self.upload_mesh(device, build_scene_mesh(walls, slabs, meshes));
    }

    /// Laedt ein fertiges Mesh in die GPU-Puffer (oder loescht es bei leer).
    fn upload_mesh(&mut self, device: &wgpu::Device, mesh: Mesh) {
        if mesh.indices.is_empty() {
            self.mesh = None;
            return;
        }
        let vbo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("mesh.vbo"),
            contents: bytemuck::cast_slice(&mesh.verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let ibo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("mesh.ibo"),
            contents: bytemuck::cast_slice(&mesh.indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        self.mesh = Some(MeshBuffers {
            vbo,
            ibo,
            index_count: mesh.indices.len() as u32,
        });
    }

    /// Setzt die Richtung ZUM Directional-Light (Sonne, world). Das hemisphaerische
    /// Ambient (Himmel/Boden) bleibt bei den Default-Farben.
    pub fn set_light(&mut self, dir_to_light: [f32; 3]) {
        self.globals.light_dir = normalize4(dir_to_light);
    }

    /// Uebersteuert die hemisphaerischen Ambient-Farben (Himmel oben, Boden unten)
    /// und die Sonnenfarbe. Fuer Feinabstimmung des Massenmodell-Looks.
    pub fn set_ambient(&mut self, sky: [f32; 3], ground: [f32; 3], sun: [f32; 3]) {
        self.globals.sky_color = [sky[0], sky[1], sky[2], 1.0];
        self.globals.ground_color = [ground[0], ground[1], ground[2], 1.0];
        self.globals.sun_color = [sun[0], sun[1], sun[2], 1.0];
    }

    /// Darstellungsart umschalten: `true` = weisses Clay-Material (Beleuchtung
    /// bleibt aktiv, siehe shaders.rs), `false` = normale Bauteil-/Vertexfarbe.
    pub fn set_white_mode(&mut self, white: bool) {
        self.globals.mode[0] = if white { 1.0 } else { 0.0 };
    }

    /// Stellt sicher, dass ein Tiefenpuffer passend zur Ziel-Groesse existiert.
    fn ensure_depth(&mut self, device: &wgpu::Device, w: u32, h: u32) {
        let ok = matches!(&self.depth, Some(d) if d.width == w && d.height == h);
        if ok {
            return;
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("depth"),
            size: wgpu::Extent3d {
                width: w.max(1),
                height: h.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            // Muss zur Sample-Zahl der Farb-/Pipeline-Ziele passen (MSAA).
            sample_count: SAMPLE_COUNT,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.depth = Some(DepthTarget {
            view,
            width: w.max(1),
            height: h.max(1),
        });
    }

    /// Stellt sicher, dass eine multisampled Farb-Zwischentextur passend zur
    /// Ziel-Groesse existiert (wird jeden Frame in die Surface-View aufgeloest).
    fn ensure_msaa(&mut self, device: &wgpu::Device, w: u32, h: u32) {
        let ok = matches!(&self.msaa, Some(m) if m.width == w && m.height == h);
        if ok {
            return;
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("msaa.color"),
            size: wgpu::Extent3d {
                width: w.max(1),
                height: h.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: SAMPLE_COUNT,
            dimension: wgpu::TextureDimension::D2,
            format: self.color_format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.msaa = Some(MsaaTarget {
            view,
            width: w.max(1),
            height: h.max(1),
        });
    }

    /// Zeichnet einen Frame und loest ihn in `target` auf (Surface- oder
    /// Offscreen-Textur). Intern wird in eine multisampled Zwischentextur (MSAA)
    /// gerendert und am Ende der Pass in `target` aufgeloest. Die Kamera liefert
    /// die View-Projektions-Matrix; `viewport` bestimmt das Seitenverhaeltnis und
    /// die Tiefen-/MSAA-Puffer-Groesse.
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        camera: &Camera,
        viewport: (u32, u32),
    ) {
        let (w, h) = viewport;
        let aspect = if h > 0 { w as f32 / h as f32 } else { 1.0 };
        let vp: Mat4 = view_projection(camera, aspect);
        self.globals.view_proj = vp;
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&self.globals));

        self.ensure_depth(device, w, h);
        self.ensure_msaa(device, w, h);
        let depth_view = &self.depth.as_ref().unwrap().view;
        let msaa_view = &self.msaa.as_ref().unwrap().view;

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("3d.encoder"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("3d.pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    // In die multisampled Zwischentextur rendern; wgpu loest sie am
                    // Ende der Pass automatisch in `target` (Surface-View) auf.
                    view: msaa_view,
                    // Ziel ist eine 2D-Textur (kein 3D-Volumen) -> kein Depth-Slice.
                    depth_slice: None,
                    resolve_target: Some(target),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(self.clear_color),
                        // Der multisampled Inhalt selbst wird nach dem Aufloesen nicht
                        // mehr gebraucht — Discard spart Bandbreite.
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });

            if let Some(m) = &self.mesh {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.set_vertex_buffer(0, m.vbo.slice(..));
                pass.set_index_buffer(m.ibo.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..m.index_count, 0, 0..1);
            }
        }
        queue.submit(std::iter::once(encoder.finish()));
    }
}
