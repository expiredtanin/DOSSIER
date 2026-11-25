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
// Szene als Render-Bundle (Leistung, 25.11.): die Werte je Batch (Farbe, Papier-mm-Breite) liegen STATISCH in einem
// Uniform-Puffer (group 0, dynamischer Offset), beim Hochladen einmal geschrieben; die Werte des Bildes (Projektion,
// Zeichenpuffer, mm->px) in einem kleinen Bild-Uniform (group 1). Die ganze Zeichenfolge (Fuellungen, Linien, Striche
// in Maler-Reihenfolge) wird beim Hochladen EINMAL als Render-Bundle aufgezeichnet; je Bild bleiben ein 96-Byte-
// `write_buffer` und `execute_bundles`. Vorher je Bild: alle Batch-Bloecke neu schreiben (bei grossen Plaenen
// ~370 KB) und je Batch Pipeline/Puffer/Bind-Group setzen und zeichnen — im Browser tausende WebGPU-Aufrufe je Bild
// (gemessen: Grossgebaeude 1456 Draws, 1275 Pipeline-Wechsel, Bilder bis 0.8 s beim Zoomen).

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::ortho::{compute_ortho_matrix, corrected_view_box, meet_scale, mm_to_device_px, Mat4};
use crate::shaders::{scene_variant, ARC_WGSL, DASH_LINE_WGSL, FILL_WGSL, LINE_WGSL};
use crate::tessellate::{compile_scene, to_screen, ArcInstanceData, BatchKind, DashSegment, MAX_ARC_DASH, MAX_LINE_DASH};
use crate::glyph::GlyphText;
use crate::text_lines::GlyphLine;
use crate::types::{Scene, ViewBox};

/// MSAA-Faktor: 4x Multisampling fuer glatte Linien-/Fuellkanten (wie im Browser).
const SAMPLE_COUNT: u32 = 4;

/// Uniform-Block, 1:1 zum WGSL-`Globals`-Struct. std140-kompatibel ausgelegt
/// (16-Byte-Alignment der mat4/vec4, Skalare am Ende gepackt).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
struct BatchUniform {
    color: [f32; 4],
    /// Papier-mm-Breite (Fuellungen 0).
    stroke_px: f32,
    /// 1 = Breite in Bildschirm-Einheiten (Schraffur-Striche, an die Musterkachel gekoppelt), sonst Papier-mm.
    width_screen: f32,
    _pad: [f32; 2],
}

/// Bild-Uniform der Szenen-Pipelines (group 1, `SPLIT_UNIFORMS_WGSL` `Frame`).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct FrameUniform {
    view_proj: [f32; 16],
    viewport_px: [f32; 2],
    /// Papier-mm -> Geraete-px.
    mm_px: f32,
    /// Geraete-px je Bildschirm-Einheit (meet-Skala).
    px_per_screen: f32,
    /// Faktor auf die Strichmuster-Laengen ([96]): Muster sind bei 1:100 kompiliert, auf dem Papier
    /// gelten sie in mm — bei 1:N also `N / 100` (Papier-mm-Batches; Bildschirm-Striche 1, im Shader).
    dash_scale: f32,
    _pad: [f32; 3],
}

/// Frame-Uniform der analytischen Bogen-Pipeline (1:1 zu `ArcGlobals` in WGSL).
/// EIN Block je Frame (fuer ALLE Boegen gleich) — anders als die per-Batch-
/// `Globals` braucht er keinen dynamischen Offset. std140: mat4 + vec2 + 2 Skalare
/// = 80 Byte (16-Byte-Vielfaches).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ArcGlobals {
    view_proj: [f32; 16],
    viewport_px: [f32; 2],
    px_per_screen: f32,
    stroke_scale: f32,
    /// Faktor auf die Strichmuster-Laengen (`N / 100`, s. `Globals::dash_scale`).
    dash_scale: f32,
    _pad: [f32; 3],
}

/// EINE Bogen-Instanz fuer die GPU (Vertex-Puffer, step_mode Instance), 1:1 zum
/// Instanz-Layout in `ARC_WGSL`. Zoom-invariant: Bildschirm-Raum-Geometrie +
/// Dash in Modell-Metern. 18 f32 = 72 Byte.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ArcInstance {
    center: [f32; 2],
    /// (r_screen, a0, sweep, r_model)
    geom: [f32; 4],
    color: [f32; 4],
    /// (width_mm, dash_total, dash_count, cap) — cap [146]: 0 flach, 1 rund, 2 vorstehend
    wdash: [f32; 4],
    /// bis zu MAX_ARC_DASH An/Aus-Laengen (Modell-Meter).
    dash: [f32; 4],
}

impl ArcInstance {
    fn from_data(a: &ArcInstanceData) -> Self {
        // MAX_ARC_DASH ist 4 (== vec4 im Shader); Compile-Time abgesichert.
        const _: () = assert!(MAX_ARC_DASH == 4);
        Self {
            center: a.center,
            geom: [a.r_screen, a.a0, a.sweep, a.r_model],
            color: a.color,
            wdash: [a.width_mm, a.dash_total, a.dash_count as f32, a.cap as f32],
            dash: a.dash,
        }
    }
}

/// EIN gestricheltes Segment fuer die GPU (Instanz der Strich-Pipeline, 1:1 zu `DASH_LINE_WGSL`):
/// 16 f32 = 64 Byte.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct DashInstance {
    /// (a.x, a.y, b.x, b.y) Bildschirm-Raum
    ab: [f32; 4],
    /// (s0, run_len, total, count) Bildschirm-Einheiten
    run: [f32; 4],
    dash: [f32; 8],
}

impl DashInstance {
    fn from_segment(d: &DashSegment) -> Self {
        const _: () = assert!(MAX_LINE_DASH == 8);
        Self { ab: [d.a[0], d.a[1], d.b[0], d.b[1]], run: [d.s0, d.run_len, d.total, d.count as f32], dash: d.dash }
    }
}

/// Puffer ungemappt anlegen und ueber die Queue befuellen (Groesse auf die
/// Kopier-Ausrichtung von 4 Byte aufgerundet, `write_buffer` verlangt das).
/// Siehe [`Renderer::upload_scene_queued`].
pub(crate) fn buffer_via_queue(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    contents: &[u8],
    label: &str,
    usage: wgpu::BufferUsages,
) -> wgpu::Buffer {
    let size = queued_buffer_size(contents.len());
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size,
        usage: usage | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    if contents.len() as u64 == size {
        queue.write_buffer(&buffer, 0, contents);
    } else {
        let mut padded = contents.to_vec();
        padded.resize(size as usize, 0);
        queue.write_buffer(&buffer, 0, &padded);
    }
    buffer
}

/// Puffergroesse fuer [`buffer_via_queue`]: auf `COPY_BUFFER_ALIGNMENT` aufgerundet, mindestens 4.
fn queued_buffer_size(len: usize) -> u64 {
    align_up((len as u64).max(1), wgpu::COPY_BUFFER_ALIGNMENT)
}

/// Rundet `size` auf das naechste Vielfache von `align` (>=1) auf.
fn align_up(size: u64, align: u64) -> u64 {
    if align <= 1 {
        return size;
    }
    ((size + align - 1) / align) * align
}

/// GPU-seitige Puffer einer tessellierten Szene. Die Szenen-Puffer werden nur noch vom Bundle gelesen, bleiben aber
/// hier gehalten: im WebGPU-Backend gibt das Freigeben eines Puffers ihn sofort frei (`destroy`), das Bundle waere leer.
struct SceneBuffers {
    _fill_vbo: Option<wgpu::Buffer>,
    _fill_ibo: Option<wgpu::Buffer>,
    _line_vbo: Option<wgpu::Buffer>,
    _line_ibo: Option<wgpu::Buffer>,
    /// Instanz-Puffer der analytischen Boegen (je Bogen EINE Instanz); None wenn leer.
    arc_vbo: Option<wgpu::Buffer>,
    /// Anzahl Bogen-Instanzen (Draw: 6 Vertices je Instanz).
    arc_count: u32,
    _dash_vbo: Option<wgpu::Buffer>,
    _batch_buffer: wgpu::Buffer,
    /// Fuellungen, Linien und Striche in Maler-Reihenfolge, einmal aufgezeichnet.
    bundle: Option<wgpu::RenderBundle>,
}

/// Der native 2D-Renderer: haelt beide Pipelines, den (dynamischen) Uniform-
/// Puffer und die aktuell hochgeladene Szene. Pan/Zoom aktualisiert nur die
/// Ortho-Matrix (kein Re-Tessellieren).
pub struct Renderer {
    fill_pipeline: wgpu::RenderPipeline,
    line_pipeline: wgpu::RenderPipeline,
    /// Gestrichelte Linien (Muster im Fragment-Shader, `DASH_LINE_WGSL`), gleiche Globals.
    dash_pipeline: wgpu::RenderPipeline,
    /// Layout der Batch-Werte (group 0, dynamischer Offset).
    batch_layout: wgpu::BindGroupLayout,
    /// Bild-Uniform (group 1) samt Bind-Group, je Bild einmal geschrieben.
    frame_uniform: wgpu::Buffer,
    frame_bind_group: wgpu::BindGroup,
    /// Analytische Bogen-Pipeline (exakter Kreis-Shader, `ARC_WGSL`).
    arc_pipeline: wgpu::RenderPipeline,
    /// Frame-Uniform der Bogen-Pipeline (ein Block, kein dynamischer Offset).
    arc_uniform: wgpu::Buffer,
    arc_bind_group: wgpu::BindGroup,
    /// Ausgerichtete Groesse eines Batch-Blocks im Uniform-Puffer der Szene.
    uniform_stride: u64,
    scene: Option<SceneBuffers>,
    /// Farbformat der Ziel-Surface (auch Format der MSAA-Textur).
    format: wgpu::TextureFormat,
    /// Multisample-Farbtextur (4x), lazily an die Ziel-Groesse gebunden.
    msaa_view: Option<wgpu::TextureView>,
    /// Groesse, fuer die `msaa_view` angelegt wurde.
    msaa_size: (u32, u32),
    /// Glyphen-Textpass (glyphon, eingebettetes Inter; gemeinsam mit dem Chunk-Renderer, `glyph.rs`).
    text: GlyphText,
    /// Loeschfarbe (Zeichenblatt), Default hell wie im WebGL-Pfad (#f0f0f0).
    pub clear_color: wgpu::Color,
    /// Papier-Massstab-Nenner (1:N) fuer echte mm-Strichbreiten.
    pub paper_scale_n: f32,
    /// Plot-Massstab-Nenner (1:N) NUR fuer die Strichmuster (`ortho::dash_scale`): fest, nicht vom Zoom
    /// abgeleitet, damit der Rhythmus auf dem Bildschirm der Druckansicht gleicht; 0 = wie `paper_scale_n`.
    pub dash_scale_n: f32,
    /// Papier-Massstab-Nenner (1:N) NUR fuer die Text-Schriftgroesse — bewusst
    /// vom geometrischen `paper_scale_n` ENTKOPPELT: der SVG-Referenzpfad haelt
    /// die Raumstempel-Schriftgroesse im normalen Anzeigemodus auf einer festen
    /// Referenzskala 1:100 (lesbar, unabhaengig vom zufaelligen Einpass-Massstab
    /// der aktuellen Ansicht) und wechselt erst im Druck-Modus auf den echten
    /// gemessenen Massstab; siehe PlanView.tsx `textScaleForGl`/case "text". Ohne
    /// diese Trennung wuerde Text hier mit dem live aus dem Ausschnitt
    /// abgeleiteten `paper_scale_n` skalieren (z.B. 1:32 statt 1:100) und damit
    /// sichtbar kleiner/groesser als im SVG-Pfad erscheinen.
    pub text_scale_n: f32,
}

impl Renderer {
    /// Erzeugt Pipelines + Layout fuer ein gegebenes Farbformat (Surface).
    pub fn new(device: &wgpu::Device, color_format: wgpu::TextureFormat) -> Self {
        let fill_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fill.wgsl"),
            source: wgpu::ShaderSource::Wgsl(scene_variant(FILL_WGSL).expect("fill.wgsl: Globals-Kopf").into()),
        });
        let line_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("line.wgsl"),
            source: wgpu::ShaderSource::Wgsl(scene_variant(LINE_WGSL).expect("line.wgsl: Globals-Kopf").into()),
        });

        // group 0: Batch-Werte (dynamischer Offset, je Batch ein Block, statisch); group 1: Bild-Werte.
        let uniform_entry = |dynamic: bool, size: usize| wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: dynamic,
                min_binding_size: wgpu::BufferSize::new(size as u64),
            },
            count: None,
        };
        let batch_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("batch.layout"),
            entries: &[uniform_entry(true, std::mem::size_of::<BatchUniform>())],
        });
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("frame.layout"),
            entries: &[uniform_entry(false, std::mem::size_of::<FrameUniform>())],
        });
        let frame_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("frame.buffer"),
            size: std::mem::size_of::<FrameUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("frame.bind"),
            layout: &frame_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: frame_uniform.as_entire_binding() }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("2d.layout"),
            bind_group_layouts: &[Some(&batch_layout), Some(&frame_layout)],
            immediate_size: 0,
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
                entry_point: Some("vs_main"),
                buffers: &[fill_vertex_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &fill_module,
                entry_point: Some("fs_main"),
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
            multisample: wgpu::MultisampleState {
                count: SAMPLE_COUNT,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview_mask: None,
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
                entry_point: Some("vs_main"),
                buffers: &[line_vertex_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &line_module,
                entry_point: Some("fs_main"),
                targets: &[Some(color_target)],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState {
                count: SAMPLE_COUNT,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview_mask: None,
            cache: None,
        });

        // ── Gestrichelte Linien: je Segment eine Instanz, Quad aus vertex_index ──
        let dash_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("dash.wgsl"),
            source: wgpu::ShaderSource::Wgsl(scene_variant(DASH_LINE_WGSL).expect("dash.wgsl: Globals-Kopf").into()),
        });
        let dash_instance_layout = wgpu::VertexBufferLayout {
            array_stride: 16 * 4,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4],
        };
        let dash_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("dash.pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &dash_module,
                entry_point: Some("vs_main"),
                buffers: &[dash_instance_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &dash_module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState { format: color_format, blend, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: None, ..Default::default() },
            depth_stencil: None,
            multisample: wgpu::MultisampleState { count: SAMPLE_COUNT, mask: !0, alpha_to_coverage_enabled: false },
            multiview_mask: None,
            cache: None,
        });

        // ── Analytische Bogen-Pipeline (exakter Kreis-Shader) ─────────────────
        let arc_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("arc.wgsl"),
            source: wgpu::ShaderSource::Wgsl(ARC_WGSL.into()),
        });
        // Eigenes Layout: EIN Uniform-Block je Frame (kein dynamischer Offset).
        let arc_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("arc.globals.layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(
                            std::mem::size_of::<ArcGlobals>() as u64,
                        ),
                    },
                    count: None,
                }],
            });
        let arc_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("arc.pipeline.layout"),
                bind_group_layouts: &[Some(&arc_bind_group_layout)],
                immediate_size: 0,
            });
        // Instanz-Layout: [center vec2, geom vec4, color vec4, wdash vec4, dash vec4],
        // stride 18*4, step_mode Instance. Das Quad kommt aus @builtin(vertex_index).
        let arc_instance_layout = wgpu::VertexBufferLayout {
            array_stride: 18 * 4,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![
                0 => Float32x2, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4, 4 => Float32x4
            ],
        };
        let arc_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("arc.pipeline"),
            layout: Some(&arc_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &arc_module,
                entry_point: Some("vs_main"),
                buffers: &[arc_instance_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &arc_module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: color_format,
                    blend,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState {
                count: SAMPLE_COUNT,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview_mask: None,
            cache: None,
        });
        let arc_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("arc.globals.buffer"),
            size: std::mem::size_of::<ArcGlobals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let arc_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("arc.globals.bind"),
            layout: &arc_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: arc_uniform.as_entire_binding(),
            }],
        });

        // Block-Stride = Batch-Block auf die Dynamic-Offset-Ausrichtung des Geraets gepolstert.
        let min_align = device.limits().min_uniform_buffer_offset_alignment as u64;
        let uniform_stride = align_up(std::mem::size_of::<BatchUniform>() as u64, min_align.max(1));

        Self {
            fill_pipeline,
            line_pipeline,
            dash_pipeline,
            batch_layout,
            frame_uniform,
            frame_bind_group,
            arc_pipeline,
            arc_uniform,
            arc_bind_group,
            uniform_stride,
            scene: None,
            format: color_format,
            msaa_view: None,
            msaa_size: (0, 0),
            text: GlyphText::new(color_format, SAMPLE_COUNT),
            // #f0f0f0 (== --sheet). 0.941 entspricht dem WebGL-clearColor.
            clear_color: wgpu::Color {
                r: 0.941,
                g: 0.941,
                b: 0.941,
                a: 1.0,
            },
            paper_scale_n: 100.0,
            dash_scale_n: 0.0,
            text_scale_n: 100.0,
        }
    }

    /// Kompiliert eine Szene und laedt die GPU-Puffer hoch. Alles ist zoom-
    /// invariant — Papier-mm-Striche wie auch die analytischen Boegen werden erst
    /// im Shader auf Geraete-px abgebildet. Daher KEIN Zoom-Parameter und keine
    /// Neu-Tessellierung bei Zoomaenderung mehr (der frueher noetige Bogen-Re-Tess-
    /// Trigger entfaellt: der Kreis-Shader rendert bei jeder Skala exakt rund).
    ///
    /// Puffer werden „mapped at creation" befuellt (nativ der kuerzeste Weg). Im
    /// Browser stattdessen [`Self::upload_scene_queued`] nehmen.
    pub fn upload_scene(&mut self, device: &wgpu::Device, scene: &Scene) {
        self.upload_scene_with(device, scene, |contents, label, usage| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents,
                usage,
            })
        });
    }

    /// Wie [`Self::upload_scene`], aber Puffer ungemappt anlegen und ueber die Queue
    /// befuellen. Fuer WebGPU: dort wirft `createBuffer(mappedAtCreation)` bei
    /// verlorenem Geraet synchron, und wgpu macht daraus einen Panic (WASM bricht
    /// mitten im `&mut self`-Aufruf ab, das wasm-bindgen-Objekt bleibt gesperrt:
    /// „recursive use of an object …"). Ungemappt + `writeBuffer` wird bei
    /// verlorenem Geraet laut WebGPU-Spezifikation still ignoriert.
    pub fn upload_scene_queued(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, scene: &Scene) {
        self.upload_scene_with(device, scene, |contents, label, usage| {
            buffer_via_queue(device, queue, contents, label, usage)
        });
    }

    fn upload_scene_with(
        &mut self,
        device: &wgpu::Device,
        scene: &Scene,
        make: impl Fn(&[u8], &str, wgpu::BufferUsages) -> wgpu::Buffer,
    ) {
        let geo = compile_scene(scene);

        let mk_vbo = |data: &[f32], label: &str| -> Option<wgpu::Buffer> {
            if data.is_empty() {
                return None;
            }
            Some(make(bytemuck::cast_slice(data), label, wgpu::BufferUsages::VERTEX))
        };
        let mk_ibo = |data: &[u32], label: &str| -> Option<wgpu::Buffer> {
            if data.is_empty() {
                return None;
            }
            Some(make(bytemuck::cast_slice(data), label, wgpu::BufferUsages::INDEX))
        };

        // Bogen-Instanzen (je Bogen EINE) in einen Instanz-Vertexpuffer packen.
        let arc_instances: Vec<ArcInstance> =
            geo.arcs.iter().map(ArcInstance::from_data).collect();
        let arc_count = arc_instances.len() as u32;
        let arc_vbo = if arc_instances.is_empty() {
            None
        } else {
            Some(make(
                bytemuck::cast_slice(&arc_instances),
                "arc.instances",
                wgpu::BufferUsages::VERTEX,
            ))
        };

        let dash_instances: Vec<DashInstance> = geo.dash_segments.iter().map(DashInstance::from_segment).collect();
        let dash_vbo = if dash_instances.is_empty() {
            None
        } else {
            Some(make(bytemuck::cast_slice(&dash_instances), "dash.instances", wgpu::BufferUsages::VERTEX))
        };

        let (fill_vbo, fill_ibo) = (mk_vbo(&geo.fill_pos, "fill.vbo"), mk_ibo(&geo.fill_idx, "fill.ibo"));
        let (line_vbo, line_ibo) = (mk_vbo(&geo.line_verts, "line.vbo"), mk_ibo(&geo.line_idx, "line.ibo"));

        // Batch-Werte in Maler-Reihenfolge (ein Block je Eintrag von `draw_sequence`), einmal geschrieben.
        let stride = self.uniform_stride as usize;
        let n = geo.draw_sequence.len();
        let mut blocks = vec![0u8; stride * n.max(1)];
        for (i, &(kind, idx)) in geo.draw_sequence.iter().enumerate() {
            let b = match kind {
                BatchKind::Fill => BatchUniform { color: geo.fill_batches[idx as usize].color, ..Default::default() },
                BatchKind::Dash => {
                    let d = &geo.dash_batches[idx as usize];
                    BatchUniform { color: d.color, stroke_px: d.stroke_mm, width_screen: f32::from(u8::from(d.width_screen)), _pad: [0.0; 2] }
                }
                BatchKind::Line => {
                    let l = &geo.line_batches[idx as usize];
                    BatchUniform { color: l.color, stroke_px: l.stroke_mm, width_screen: f32::from(u8::from(l.width_screen)), _pad: [0.0; 2] }
                }
            };
            blocks[i * stride..i * stride + std::mem::size_of::<BatchUniform>()].copy_from_slice(bytemuck::bytes_of(&b));
        }
        let batch_buffer = make(&blocks, "batch.buffer", wgpu::BufferUsages::UNIFORM);
        let batch_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("batch.bind"),
            layout: &self.batch_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &batch_buffer,
                    offset: 0,
                    size: wgpu::BufferSize::new(std::mem::size_of::<BatchUniform>() as u64),
                }),
            }],
        });

        // Zeichenfolge als Render-Bundle (Maler-Reihenfolge `draw_sequence`, Fuell- und Linien-Batches
        // interleaved, Pipeline-/Puffer-Wechsel nur beim Wechsel der Art): nur so deckt eine spaetere Fuellung
        // einen frueheren Strich ab (SVG-Paritaet). Je Bild nur noch `execute_bundles`.
        let bundle = (n > 0).then(|| {
            let mut enc = device.create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
                label: Some("2d.scene.bundle"),
                color_formats: &[Some(self.format)],
                depth_stencil: None,
                sample_count: SAMPLE_COUNT,
                multiview: None,
            });
            enc.set_bind_group(1, &self.frame_bind_group, &[]);
            let mut bound: Option<BatchKind> = None;
            for (block, &(kind, idx)) in geo.draw_sequence.iter().enumerate() {
                let offset = [(block * stride) as u32];
                match kind {
                    BatchKind::Fill => {
                        let (Some(vbo), Some(ibo)) = (&fill_vbo, &fill_ibo) else { continue };
                        if bound != Some(BatchKind::Fill) {
                            enc.set_pipeline(&self.fill_pipeline);
                            enc.set_vertex_buffer(0, vbo.slice(..));
                            enc.set_index_buffer(ibo.slice(..), wgpu::IndexFormat::Uint32);
                            bound = Some(BatchKind::Fill);
                        }
                        let b = &geo.fill_batches[idx as usize];
                        enc.set_bind_group(0, &batch_bind, &offset);
                        enc.draw_indexed(b.start_index..b.start_index + b.index_count, 0, 0..1);
                    }
                    BatchKind::Dash => {
                        let Some(vbo) = &dash_vbo else { continue };
                        if bound != Some(BatchKind::Dash) {
                            enc.set_pipeline(&self.dash_pipeline);
                            enc.set_vertex_buffer(0, vbo.slice(..));
                            bound = Some(BatchKind::Dash);
                        }
                        let b = &geo.dash_batches[idx as usize];
                        enc.set_bind_group(0, &batch_bind, &offset);
                        enc.draw(0..6, b.start..b.start + b.count);
                    }
                    BatchKind::Line => {
                        let (Some(vbo), Some(ibo)) = (&line_vbo, &line_ibo) else { continue };
                        if bound != Some(BatchKind::Line) {
                            enc.set_pipeline(&self.line_pipeline);
                            enc.set_vertex_buffer(0, vbo.slice(..));
                            enc.set_index_buffer(ibo.slice(..), wgpu::IndexFormat::Uint32);
                            bound = Some(BatchKind::Line);
                        }
                        let b = &geo.line_batches[idx as usize];
                        enc.set_bind_group(0, &batch_bind, &offset);
                        enc.draw_indexed(b.start_index..b.start_index + b.index_count, 0, 0..1);
                    }
                }
            }
            enc.finish(&wgpu::RenderBundleDescriptor { label: Some("2d.scene.bundle") })
        });

        self.scene = Some(SceneBuffers {
            _fill_vbo: fill_vbo,
            _fill_ibo: fill_ibo,
            _line_vbo: line_vbo,
            _line_ibo: line_ibo,
            arc_vbo,
            arc_count,
            _dash_vbo: dash_vbo,
            _batch_buffer: batch_buffer,
            bundle,
        });
        self.text.set_lines(scene.texts.iter().map(GlyphLine::from).collect());
    }

    /// Andere Font-Bytes (TrueType/OpenType) als das eingebettete Inter (vor dem ersten Text-Frame).
    pub fn load_font(&mut self, bytes: Vec<u8>) {
        self.text.set_font(bytes);
    }


    /// [226] Schriftdatei (WOFF2/SFNT) fuer `key` = Familie << 8 | Schnitt (`glyph::font_key`) einspielen.
    pub fn add_font(&mut self, key: u32, bytes: &[u8]) -> bool {
        self.text.add_font(key >> 8, key & 0xff, bytes).is_ok()
    }

    /// [226] Es gibt keine Datei fuer `key` (nicht weiter anfordern).
    pub fn mark_font_unavailable(&mut self, key: u32) {
        self.text.mark_font_unavailable(key >> 8, key & 0xff);
    }

    /// [226] Schriftdateien (`font_key`), die die aktuellen Textzeilen noch brauchen.
    pub fn needed_fonts(&self) -> Vec<u32> {
        self.text.needed_fonts()
    }

    /// Stellt sicher, dass eine 4x-MSAA-Farbtextur passend zur Ziel-Groesse
    /// existiert; realloziert nur bei Groessenaenderung (analog ensure_depth in 3D).
    fn ensure_msaa(&mut self, device: &wgpu::Device, w: u32, h: u32) {
        let (w, h) = (w.max(1), h.max(1));
        if self.msaa_view.is_some() && self.msaa_size == (w, h) {
            return;
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("msaa.color"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: SAMPLE_COUNT,
            dimension: wgpu::TextureDimension::D2,
            format: self.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        self.msaa_view = Some(texture.create_view(&wgpu::TextureViewDescriptor::default()));
        self.msaa_size = (w, h);
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
        // Eigene mm->px-Umrechnung fuer Text (siehe `text_scale_n`-Doku): gleiche
        // Formel, aber am Text-Referenz-Massstab statt am Geometrie-Massstab.
        let text_mm_px = mm_to_device_px(view_box, vw, vh, self.text_scale_n);
        // Geraete-px je Bildschirm-Einheit (== meet-Skala) — der Bogen-Shader braucht
        // beides: px_per_screen fuer Radial-/Kappen-/Dash-AA, stroke_scale fuer die
        // Papier-mm-Breite (identisch zu den Linien).
        let px_per_screen = meet_scale(view_box, vw, vh);
        // Strichmuster sind in Modell-Metern bei 1:100 kompiliert; auf dem Papier gelten sie in mm ([96]).
        let dash_scale = crate::ortho::dash_scale(self.paper_scale_n, self.dash_scale_n);

        // Frame-Uniform der Bogen-Pipeline schreiben (ein Block fuer ALLE Boegen).
        queue.write_buffer(
            &self.arc_uniform,
            0,
            bytemuck::bytes_of(&ArcGlobals {
                view_proj: proj,
                viewport_px: [vw, vh],
                px_per_screen,
                stroke_scale: mm_px,
                dash_scale,
                _pad: [0.0; 3],
            }),
        );

        // Bild-Werte der Szenen-Pipelines (group 1); die Batch-Werte liegen statisch im Bundle.
        queue.write_buffer(
            &self.frame_uniform,
            0,
            bytemuck::bytes_of(&FrameUniform { view_proj: proj, viewport_px: [vw, vh], mm_px, px_per_screen, dash_scale, _pad: [0.0; 3] }),
        );

        // ── Textpass vorbereiten (echte Glyphen via Atlas, `glyph.rs`) ─────────
        // Pixelgroesse = Papier-mm * mm_px (dieselbe Formel wie die Strich-
        // breiten) -> Text waechst beim Zoomen exakt wie im Browser. Die Anker
        // werden ueber den aspekt-korrigierten viewBox in Fenster-Pixel projiziert.
        {
            let cvb = corrected_view_box(view_box, vw, vh);
            let meet = meet_scale(view_box, vw, vh);
            let place = |x: f64, y: f64| {
                let s = to_screen([x as f32, y as f32]);
                ((s[0] - cvb.x) * meet, (s[1] - cvb.y) * meet)
            };
            self.text.prepare(device, queue, viewport, place, text_mm_px);
        }

        // In die 4x-MSAA-Textur zeichnen und in die Surface aufloesen (Resolve):
        // das glaettet alle Fuell-/Linienkanten, die Aufrufer bleiben unveraendert.
        self.ensure_msaa(device, viewport.0, viewport.1);
        let msaa_view = self.msaa_view.as_ref().unwrap();

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("2d.encoder"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("2d.pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: msaa_view,
                    // Ziel ist eine 2D-Textur (kein 3D-Volumen) -> kein Depth-Slice.
                    depth_slice: None,
                    resolve_target: Some(view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(self.clear_color),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });

            // Fuellungen, Linien und Striche in Maler-Reihenfolge: das beim Hochladen aufgezeichnete Bundle.
            if let Some(bundle) = self.scene.as_ref().and_then(|sc| sc.bundle.as_ref()) {
                pass.execute_bundles(std::iter::once(bundle));
            }

            // 3) Analytische Boegen: eigene Pipeline, EIN Frame-Uniform, je Bogen
            //    EINE Instanz (6 Vertices, Quad aus vertex_index). Mathematisch
            //    exakt rund per SDF — nach den Linien, damit der Schwenkbogen ueber
            //    dem Tuerblatt liegt.
            if let Some(scene) = &self.scene {
                if let Some(arc_vbo) = &scene.arc_vbo {
                    if scene.arc_count > 0 {
                        pass.set_pipeline(&self.arc_pipeline);
                        pass.set_bind_group(0, &self.arc_bind_group, &[]);
                        pass.set_vertex_buffer(0, arc_vbo.slice(..));
                        pass.draw(0..6, 0..scene.arc_count);
                    }
                }
            }

            // 4) Text ZUOBERST im selben MSAA-Pass (der TextRenderer wurde mit
            //    identischem MultisampleState erstellt, s. `GlyphText::new`).
            self.text.render(&mut pass);
        }
        queue.submit(std::iter::once(encoder.finish()));
    }
}

#[cfg(test)]
mod tests {
    use super::queued_buffer_size;

    #[test]
    fn queued_buffer_size_ist_auf_kopier_ausrichtung_gerundet() {
        // `write_buffer` verlangt Vielfache von 4 Byte; leere Daten ergeben trotzdem einen Puffer.
        assert_eq!(queued_buffer_size(0), 4);
        assert_eq!(queued_buffer_size(1), 4);
        assert_eq!(queued_buffer_size(4), 4);
        assert_eq!(queued_buffer_size(6), 8);
        assert_eq!(queued_buffer_size(120), 120);
    }
}
