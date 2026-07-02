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

use crate::ortho::{compute_ortho_matrix, corrected_view_box, meet_scale, mm_to_device_px, Mat4};
use crate::shaders::{FILL_WGSL, LINE_WGSL};
use crate::tessellate::{compile_scene_scaled, to_screen, GpuGeometry, PX_PER_M};
use crate::types::{Scene, Text, TextAlign, ViewBox};

/// MSAA-Faktor: 4x Multisampling fuer glatte Linien-/Fuellkanten (wie im Browser).
const SAMPLE_COUNT: u32 = 4;

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
    /// Textzeilen der Szene (Modell-Anker + Papier-mm-Groesse). Werden nicht
    /// tesselliert, sondern pro Frame ueber den Glyphen-Atlas gesetzt (die
    /// Pixelgroesse haengt vom Zoom ab).
    texts: Vec<Text>,
}

/// Zustand des Glyphen-Textpasses (glyphon): Systemfonts + Rasterizer-Cache +
/// GPU-Atlas + Renderer. Lazily beim ersten Frame mit Texten erstellt (braucht
/// die Queue, die `Renderer::new` nicht bekommt — Signatur bleibt stabil).
struct TextState {
    font_system: glyphon::FontSystem,
    swash_cache: glyphon::SwashCache,
    viewport: glyphon::Viewport,
    atlas: glyphon::TextAtlas,
    renderer: glyphon::TextRenderer,
}

/// Schrift des Plans: dieselbe Familie wie der Browser-Text (`--font` in
/// styles.css beginnt mit "Inter"); cosmic-text laedt die Systemfonts und
/// faellt bei fehlender Familie auf sans-serif zurueck.
const TEXT_FAMILY: &str = "Inter";

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
    /// Die zuletzt hochgeladene Szene (fuer Re-Tessellierung bei Zoomaenderung,
    /// siehe `maybe_retessellate` — nur relevant, wenn die Szene Boegen enthaelt).
    last_scene: Option<Scene>,
    /// Geraete-px je Modell-Meter, mit dem `last_scene` zuletzt tessellliert wurde.
    arc_px_per_m: f32,
    /// Farbformat der Ziel-Surface (auch Format der MSAA-Textur).
    format: wgpu::TextureFormat,
    /// Multisample-Farbtextur (4x), lazily an die Ziel-Groesse gebunden.
    msaa_view: Option<wgpu::TextureView>,
    /// Groesse, fuer die `msaa_view` angelegt wurde.
    msaa_size: (u32, u32),
    /// Glyphen-Textpass (lazily beim ersten Frame mit Texten erstellt).
    text: Option<TextState>,
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
            multisample: wgpu::MultisampleState {
                count: SAMPLE_COUNT,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
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
            multisample: wgpu::MultisampleState {
                count: SAMPLE_COUNT,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
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
            last_scene: None,
            arc_px_per_m: PX_PER_M,
            format: color_format,
            msaa_view: None,
            msaa_size: (0, 0),
            text: None,
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

    /// Tessellliert eine Szene und laedt die Puffer hoch. `px_per_m` sind die
    /// aktuellen Geraete-px je Modell-Meter (treibt nur die Bogen-Adaptivitaet,
    /// siehe `tessellate::tessellate_arc`); wird gemerkt, damit `render` bei
    /// Zoomaenderung automatisch neu tessellliert (`maybe_retessellate`).
    pub fn upload_scene(&mut self, device: &wgpu::Device, scene: &Scene, px_per_m: f32) {
        let geo = compile_scene_scaled(scene, px_per_m);

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
            texts: scene.texts.clone(),
        });
        self.last_scene = Some(scene.clone());
        self.arc_px_per_m = px_per_m;
    }

    /// Tessellliert die zuletzt hochgeladene Szene neu, wenn sich der Zoom seit
    /// dem letzten Upload um mehr als den Faktor 1.3 veraendert hat UND die
    /// Szene ueberhaupt Boegen enthaelt (bei anderen Primitiven ist Zoom-
    /// invariant, kein Re-Tessellieren noetig). Haelt Boegen bei jeder
    /// Zoomstufe glatt, ohne jeden Frame neu zu tessellieren (Szenen sind
    /// klein, das Re-Tessellieren selbst ist billig — nur nicht JEDEN Frame).
    fn maybe_retessellate(&mut self, device: &wgpu::Device, view_box: ViewBox, viewport: (u32, u32)) {
        let Some(scene) = &self.last_scene else {
            return;
        };
        if scene.arcs.is_empty() {
            return;
        }
        let px_per_m = PX_PER_M * meet_scale(view_box, viewport.0 as f32, viewport.1 as f32);
        let ratio = px_per_m / self.arc_px_per_m.max(1e-6);
        if ratio > 1.3 || ratio < 1.0 / 1.3 {
            let scene = scene.clone();
            self.upload_scene(device, &scene, px_per_m);
        }
    }

    /// Erstellt den Glyphen-Textpass beim ersten Bedarf (FontSystem laedt die
    /// Systemfonts einmalig). Der TextRenderer MUSS mit demselben
    /// MultisampleState wie die Geometrie-Pipelines gebaut werden (MSAA 4x),
    /// sonst passt er nicht in den gemeinsamen Render-Pass.
    fn ensure_text(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        if self.text.is_some() {
            return;
        }
        let cache = glyphon::Cache::new(device);
        let viewport = glyphon::Viewport::new(device, &cache);
        let mut atlas = glyphon::TextAtlas::new(device, queue, &cache, self.format);
        let renderer = glyphon::TextRenderer::new(
            &mut atlas,
            device,
            wgpu::MultisampleState {
                count: SAMPLE_COUNT,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            None,
        );
        self.text = Some(TextState {
            font_system: glyphon::FontSystem::new(),
            swash_cache: glyphon::SwashCache::new(),
            viewport,
            atlas,
            renderer,
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
        self.maybe_retessellate(device, view_box, viewport);

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

        // ── Textpass vorbereiten (echte Glyphen via Atlas) ────────────────────
        // Pixelgroesse = Papier-mm * mm_px (dieselbe Formel wie die Strich-
        // breiten) -> Text waechst beim Zoomen exakt wie im Browser. Die Anker
        // werden ueber den aspekt-korrigierten viewBox in Fenster-Pixel
        // projiziert; die Ausrichtung nutzt die gemessene Zeilenbreite.
        let has_texts = self
            .scene
            .as_ref()
            .map_or(false, |s| !s.texts.is_empty());
        if has_texts || self.text.is_some() {
            self.ensure_text(device, queue);
            let ts = self.text.as_mut().expect("ensure_text");
            let cvb = corrected_view_box(view_box, vw, vh);
            let meet = meet_scale(view_box, vw, vh);

            // Je sichtbarer Zeile ein geshapter Buffer + Platzierung.
            struct Placed {
                buffer: glyphon::Buffer,
                left: f32,
                top: f32,
                color: glyphon::Color,
            }
            let mut placed: Vec<Placed> = Vec::new();
            if let Some(scene) = &self.scene {
                let attrs = glyphon::Attrs::new()
                    .family(glyphon::Family::Name(TEXT_FAMILY));
                for t in &scene.texts {
                    let font_px = t.size_mm * mm_px;
                    // Unlesbar kleine Glyphen ueberspringen (spart Shaping/Atlas).
                    if !(font_px >= 1.0) || t.content.is_empty() {
                        continue;
                    }
                    // Anker (Modell-Meter) -> Fenster-Pixel: erst Bildschirm-Raum
                    // (to_screen), dann viewBox-Projektion (meet-Skala).
                    let s = to_screen(t.pos);
                    let ax = (s[0] - cvb.x) * meet;
                    let ay = (s[1] - cvb.y) * meet;
                    // Grober Sichtbarkeits-Test VOR dem Shaping (Buffer sparen):
                    // grosszuegige Marge, da die Zeilenbreite noch unbekannt ist.
                    let margin = font_px * (t.content.len() as f32 + 2.0);
                    if ax < -margin || ax > vw + margin || ay < -2.0 * font_px || ay > vh + 2.0 * font_px {
                        continue;
                    }

                    let mut buffer = glyphon::Buffer::new(
                        &mut ts.font_system,
                        glyphon::Metrics::new(font_px, font_px * 1.2),
                    );
                    // Unbegrenzt: eine Zeile, kein Umbruch (Zeilen sind vorgeflacht).
                    buffer.set_size(&mut ts.font_system, None, None);
                    buffer.set_text(&mut ts.font_system, &t.content, attrs, glyphon::Shaping::Advanced);

                    // Gemessene Breite + Baseline fuer Ausrichtung/Anker.
                    let (line_w, baseline) = buffer
                        .layout_runs()
                        .next()
                        .map(|r| (r.line_w, r.line_y))
                        .unwrap_or((0.0, font_px * 0.8));
                    let left = match t.align {
                        TextAlign::Left => ax,
                        TextAlign::Center => ax - line_w / 2.0,
                        TextAlign::Right => ax - line_w,
                    };
                    let top = ay - baseline; // Anker-Y ist die BASELINE der Zeile.
                    // Praeziser Sichtbarkeits-Test mit gemessener Breite.
                    if left > vw || left + line_w < 0.0 || top > vh || top + font_px * 1.4 < 0.0 {
                        continue;
                    }
                    let c = t.color;
                    let to8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                    placed.push(Placed {
                        buffer,
                        left,
                        top,
                        color: glyphon::Color::rgba(to8(c[0]), to8(c[1]), to8(c[2]), to8(c[3])),
                    });
                }
            }

            ts.viewport.update(
                queue,
                glyphon::Resolution {
                    width: viewport.0,
                    height: viewport.1,
                },
            );
            let bounds = glyphon::TextBounds {
                left: 0,
                top: 0,
                right: viewport.0 as i32,
                bottom: viewport.1 as i32,
            };
            let areas = placed.iter().map(|p| glyphon::TextArea {
                buffer: &p.buffer,
                left: p.left,
                top: p.top,
                scale: 1.0,
                bounds,
                default_color: p.color,
                custom_glyphs: &[],
            });
            if let Err(e) = ts.renderer.prepare(
                device,
                queue,
                &mut ts.font_system,
                &mut ts.atlas,
                &ts.viewport,
                areas,
                &mut ts.swash_cache,
            ) {
                eprintln!("render2d Text-prepare fehlgeschlagen: {e:?}");
            }
            // Nicht mehr benoetigte Glyphen aus dem Atlas werfen (haelt ihn klein).
            ts.atlas.trim();
        }

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
                    resolve_target: Some(view),
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

            // 3) Text ZUOBERST im selben MSAA-Pass (der TextRenderer wurde mit
            //    identischem MultisampleState erstellt, siehe ensure_text).
            if let Some(ts) = &self.text {
                if let Err(e) = ts.renderer.render(&ts.atlas, &ts.viewport, &mut pass) {
                    eprintln!("render2d Text-render fehlgeschlagen: {e:?}");
                }
            }
        }
        queue.submit(std::iter::once(encoder.finish()));
    }
}
