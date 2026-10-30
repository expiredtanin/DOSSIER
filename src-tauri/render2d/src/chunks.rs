// Chunk-Renderer: zeichnet die FERTIG tessellierten GPU-Chunks der Webview
// (src/plan/glPlan/glPlanChunks.ts) nativ — dasselbe Vertex-Format, dieselben
// Shader (FILL_WGSL/LINE_WGSL), dieselbe Zeichenreihenfolge (erst alle
// Fuellungen, dann alle Linien) und dieselbe Projektionsmathematik wie
// `PlanGpuRenderer` (glPlanRender.ts), inkl. lokalem Chunk-Ursprung in doppelter
// Genauigkeit.
//
// Linien-Vertices kommen KOMPAKT (12 Byte, s. LINE_PACKED_WGSL).
//
// Gestrichelte Striche kommen als Instanzen (je Segment 16 x f32, Format wie
// `DashSegment`/`gpu::DashInstance`) und laufen durch DIESELBE Strich-Pipeline wie
// der Szenen-Pfad (`DASH_LINE_WGSL`: Striche, Luecken, runde Enden im Fragment-
// Shader). Innerhalb eines Chunks in Maler-Reihenfolge mit den Linien verzahnt
// (`DashBatch::line_at`), damit spaetere Striche fruehere gestrichelte decken.
//
// Die Webview kompiliert weiterhin (Cache/Chunk-Logik bleibt in TypeScript) und
// schickt nur noch die Puffer-BYTES je Chunk einmalig; pro Frame geht nur der
// Ausschnitt (viewBox) hierher. Rust haelt die Puffer — kein JSON, kein
// Re-Upload bei Pan/Zoom.

use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::shaders::{DASH_LINE_WGSL, FILL_WGSL};

/// Graustufe fuer gedimmte Linien (== GREY_RGB in glPlanCompile.ts).
const GREY: f32 = 0.549;
/// Viewbox-Einheiten je Meter (== PX_PER_M).
const PX_PER_M: f64 = 90.0;

/// Linien-Shader fuer das KOMPAKTE Vertex-Format der Webview (12 statt 24 Byte):
/// `position` (2 x f32) + `packed` (4 x snorm8 = bisector.xy, side, miter).
/// Rechnung identisch zu `shaders::LINE_WGSL`.
const LINE_PACKED_WGSL: &str = r#"
struct Globals {
    view_proj    : mat4x4<f32>,
    color        : vec4<f32>,
    viewport_px  : vec2<f32>,
    stroke_px    : f32,
    stroke_scale : f32,
};
@group(0) @binding(0) var<uniform> globals : Globals;

struct VsIn {
    @location(0) position : vec2<f32>,
    @location(1) packed   : vec4<f32>,  // (bisector.x, bisector.y, side, miter)
};

@vertex
fn vs_main(in : VsIn) -> @builtin(position) vec4<f32> {
    let clip_p = globals.view_proj * vec4<f32>(in.position, 0.0, 1.0);
    let clip_n = globals.view_proj * vec4<f32>(in.position + in.packed.xy, 0.0, 1.0);
    let dir_px = (clip_n.xy - clip_p.xy) * globals.viewport_px * 0.5;
    let len = length(dir_px);
    var unit_px = vec2<f32>(0.0, 0.0);
    if (len > 1e-6) {
        unit_px = dir_px / len;
    }
    let width_px = max(1.0, globals.stroke_px * globals.stroke_scale) * in.packed.w;
    let offset_px = unit_px * (width_px * 0.5) * in.packed.z;
    return vec4<f32>(clip_p.xy + offset_px / (globals.viewport_px * 0.5), clip_p.z, clip_p.w);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return globals.color;
}
"#;

/// Vektor-Text: Glyphen-Dreiecke (em-Einheiten) pro Instanz positioniert, skaliert
/// und gedreht. `pos` ist relativ zur Ansichtsmitte (f64 → f32 auf der CPU).
const TEXT_WGSL: &str = r#"
struct Globals {
    view_proj    : mat4x4<f32>,
    color        : vec4<f32>,
    viewport_px  : vec2<f32>,
    stroke_px    : f32,
    stroke_scale : f32,
};
@group(0) @binding(0) var<uniform> globals : Globals;

struct VsIn {
    @location(0) g     : vec2<f32>,  // Glyphenpunkt in em (Y nach oben)
    @location(1) pos   : vec2<f32>,  // Textanker (Bildschirm-Raum, relativ zur Ansichtsmitte)
    @location(2) scale : f32,        // em → Bildschirm-Einheiten (= Schrifthoehe)
    @location(3) xoff  : f32,        // X-Versatz der Glyphe in em (Vorschub)
    @location(4) cs    : vec2<f32>,  // (cos, sin) der Bildschirm-Drehung
    @location(5) color : vec4<f32>,
};
struct VsOut {
    @builtin(position) p : vec4<f32>,
    @location(0) color : vec4<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
    let lx = (in.xoff + in.g.x) * in.scale;
    let ly = -in.g.y * in.scale;
    let x = lx * in.cs.x - ly * in.cs.y;
    let y = lx * in.cs.y + ly * in.cs.x;
    var o : VsOut;
    o.p = globals.view_proj * vec4<f32>(in.pos + vec2<f32>(x, y), 0.0, 1.0);
    o.color = in.color;
    return o;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    return in.color;
}
"#;

/// Text-Eingabe aus der Webview (Bildschirm-Raum, doppelte Genauigkeit).
#[derive(Clone, Debug, serde::Deserialize)]
pub struct TextIn {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    /// Schrifthoehe (= em) in Bildschirm-Einheiten.
    pub size: f64,
    /// Drehung in Bildschirm-Raum (Radiant, im Uhrzeigersinn positiv).
    pub angle: f64,
    pub color: [f32; 4],
    pub text: String,
}

struct TextItem {
    x: f64,
    y: f64,
    size: f64,
    cs: [f32; 2],
    color: [f32; 4],
    glyphs: Vec<(u16, f32)>,
    width_em: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct TextInst {
    pos: [f32; 2],
    scale: f32,
    xoff: f32,
    cs: [f32; 2],
    color: [f32; 4],
}

/// Obergrenze gleichzeitig gezeichneter Texte; darueber bleiben die groessten.
const MAX_VISIBLE_TEXTS: usize = 6000;
/// Texte unter dieser Hoehe (Geraete-px) werden nicht gezeichnet.
const MIN_TEXT_PX: f64 = 2.0;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    view_proj: [f32; 16],
    color: [f32; 4],
    viewport_px: [f32; 2],
    stroke_px: f32,
    stroke_scale: f32,
    /// Faktor auf die Strichmuster-Laengen (`N / 100`, wie `gpu::Globals::dash_scale`) ([96]).
    dash_scale: f32,
    _pad: [f32; 3],
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct FillBatch {
    pub start: u32,
    pub count: u32,
    pub color: [f32; 4],
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct LineBatch {
    pub start: u32,
    pub count: u32,
    pub color: [f32; 4],
    pub stroke_mm: f32,
    #[serde(default)]
    pub screen_px: bool,
    /// Breite ist bereits in GERAETE-px (zoom-unabhaengig, z. B. Auswahl-Hervorhebung).
    #[serde(default)]
    pub device_px: bool,
}

/// Instanz-Bereich gestrichelter Segmente (Strich-Pipeline) mit Farbe + Papier-mm.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct DashBatch {
    pub start: u32,
    pub count: u32,
    pub color: [f32; 4],
    pub stroke_mm: f32,
    /// Maler-Reihenfolge: gezeichnet vor dem ersten Linien-Batch mit `start >= line_at`
    /// (Linien-Index-Position beim Erzeugen; kein Linien-Batch ueberspannt sie).
    #[serde(default)]
    pub line_at: u32,
}

/// Zeichenfolge der Striche eines Chunks: (gestrichelt?, Batch-Index), Linien und
/// gestrichelte Batches nach `line_at` verzahnt. Fehlen die Puffer einer Art, entfaellt sie.
fn stroke_order(g: &ChunkGeom) -> Vec<(bool, usize)> {
    let lines = if g.line_vtx.is_some() && g.line_idx.is_some() { g.line_batches.len() } else { 0 };
    let dashes = if g.dash_inst.is_some() { g.dash_batches.len() } else { 0 };
    let mut out = Vec::with_capacity(lines + dashes);
    let mut j = 0;
    for i in 0..lines {
        while j < dashes && g.dash_batches[j].line_at <= g.line_batches[i].start {
            out.push((true, j));
            j += 1;
        }
        out.push((false, i));
    }
    out.extend((j..dashes).map(|k| (true, k)));
    out
}

/// Bytes je Strich-Instanz (16 x f32: ab, run, dash[8]; wie `gpu::DashInstance`).
pub const DASH_INSTANCE_BYTES: u64 = 16 * 4;

/// Ein Chunk (== `GpuGeometry` der Webview): Puffer-IDs statt GL-Puffer.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct ChunkGeom {
    pub fill_pos: Option<u32>,
    pub fill_idx: Option<u32>,
    pub fill_batches: Vec<FillBatch>,
    pub line_vtx: Option<u32>,
    pub line_idx: Option<u32>,
    pub line_batches: Vec<LineBatch>,
    /// Puffer der Strich-Instanzen (gestrichelte Segmente); fehlt ohne Strichmuster.
    #[serde(default)]
    pub dash_inst: Option<u32>,
    #[serde(default)]
    pub dash_batches: Vec<DashBatch>,
    pub origin: [f64; 2],
    #[serde(default)]
    pub greyed: bool,
}

/// Ausschnitt in Bildschirm-Einheiten (doppelte Genauigkeit).
#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct View {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub struct ChunkRenderer {
    fill_pipeline: wgpu::RenderPipeline,
    line_pipeline: wgpu::RenderPipeline,
    dash_pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform: Option<(wgpu::Buffer, wgpu::BindGroup, u64)>,
    buffers: HashMap<u32, wgpu::Buffer>,
    layout: Vec<ChunkGeom>,
    /// Auswahl-Hervorhebung: eine Geometrie zuoberst, unabhaengig vom Layout gesetzt.
    highlight: Option<ChunkGeom>,
    msaa: Option<(wgpu::Texture, (u32, u32))>,
    format: wgpu::TextureFormat,
    samples: u32,
    pub clear: [f64; 3],
    /// Plot-Massstab der Strichmuster (`ortho::dash_scale`), 0 = wie der Strich-Massstab.
    pub dash_scale_n: f64,
    // --- Vektor-Text ---
    text_pipeline: wgpu::RenderPipeline,
    font: Option<crate::vtext::VectorFont>,
    texts: HashMap<u32, TextItem>,
    glyph_vbo: Option<wgpu::Buffer>,
    glyph_ibo: Option<wgpu::Buffer>,
    inst_buf: Option<(wgpu::Buffer, u64)>,
}

/// Aspekt-korrigierte Grenzen (left,right,bottom,top) wie `orthoBounds`.
fn ortho_bounds(v: View, cw: f64, ch: f64) -> (f64, f64, f64, f64) {
    let (mut x, mut y, mut w, mut h) = (v.x, v.y, v.w, v.h);
    if cw > 0.0 && ch > 0.0 && w > 0.0 && h > 0.0 {
        let ca = cw / ch;
        if ca > w / h {
            let nw = h * ca;
            x -= (nw - w) / 2.0;
            w = nw;
        } else {
            let nh = w / ca;
            y -= (nh - h) / 2.0;
            h = nh;
        }
    }
    (x, x + w, y + h, y)
}

/// Projektion relativ zum Chunk-Ursprung (== `projectionFor` + `mat4Ortho`).
fn projection(b: (f64, f64, f64, f64), origin: [f64; 2]) -> [f32; 16] {
    let (left, right, bottom, top) = b;
    let (l, r, bo, t) = (left - origin[0], right - origin[0], bottom - origin[1], top - origin[1]);
    let w = r - l;
    let h = t - bo;
    let mut m = [0.0f32; 16];
    m[0] = (2.0 / w) as f32;
    m[5] = (2.0 / h) as f32;
    m[10] = -1.0;
    m[12] = (-(r + l) / w) as f32;
    m[13] = (-(t + bo) / h) as f32;
    m[15] = 1.0;
    m
}

impl ChunkRenderer {
    /// `samples`: MSAA-Stufe (4 oder 8, je nach GPU-Unterstuetzung) — Kantenglaettung
    /// fuer ALLE Geometrie (Flaechen, Linien, Text).
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, samples: u32) -> Self {
        let fill_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("chunks.fill"),
            source: wgpu::ShaderSource::Wgsl(FILL_WGSL.into()),
        });
        let line_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("chunks.line"),
            source: wgpu::ShaderSource::Wgsl(LINE_PACKED_WGSL.into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("chunks.globals"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<Globals>() as u64),
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("chunks.layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let target = wgpu::ColorTargetState {
            format,
            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::ALL,
        };
        let make = |module: &wgpu::ShaderModule, layout: wgpu::VertexBufferLayout<'_>, label: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module,
                    entry_point: Some("vs_main"),
                    buffers: &[layout],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module,
                    entry_point: Some("fs_main"),
                    targets: &[Some(target.clone())],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState {
                    count: samples,
                    mask: !0,
                    alpha_to_coverage_enabled: false,
                },
                multiview_mask: None,
                cache: None,
            })
        };
        let fill_pipeline = make(
            &fill_module,
            wgpu::VertexBufferLayout {
                array_stride: 8,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x2],
            },
            "chunks.fill.pipeline",
        );
        let line_pipeline = make(
            &line_module,
            wgpu::VertexBufferLayout {
                array_stride: 12,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Snorm8x4],
            },
            "chunks.line.pipeline",
        );
        // Gestrichelte Segmente: Instanz-Puffer, Quad aus `vertex_index` (wie gpu.rs).
        let dash_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("chunks.dash"),
            source: wgpu::ShaderSource::Wgsl(DASH_LINE_WGSL.into()),
        });
        let dash_pipeline = make(
            &dash_module,
            wgpu::VertexBufferLayout {
                array_stride: DASH_INSTANCE_BYTES,
                step_mode: wgpu::VertexStepMode::Instance,
                attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4],
            },
            "chunks.dash.pipeline",
        );
        let text_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("chunks.text"),
            source: wgpu::ShaderSource::Wgsl(TEXT_WGSL.into()),
        });
        let text_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("chunks.text.pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &text_module,
                entry_point: Some("vs_main"),
                buffers: &[
                    wgpu::VertexBufferLayout {
                        array_stride: 8,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![0 => Float32x2],
                    },
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<TextInst>() as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &wgpu::vertex_attr_array![1 => Float32x2, 2 => Float32, 3 => Float32, 4 => Float32x2, 5 => Float32x4],
                    },
                ],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &text_module,
                entry_point: Some("fs_main"),
                targets: &[Some(target.clone())],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState { count: samples, mask: !0, alpha_to_coverage_enabled: false },
            multiview_mask: None,
            cache: None,
        });
        Self {
            text_pipeline,
            font: None,
            texts: HashMap::new(),
            glyph_vbo: None,
            glyph_ibo: None,
            inst_buf: None,
            fill_pipeline,
            line_pipeline,
            dash_pipeline,
            bind_group_layout,
            uniform: None,
            buffers: HashMap::new(),
            layout: Vec::new(),
            highlight: None,
            msaa: None,
            format,
            samples,
            clear: [0.941, 0.941, 0.941],
            dash_scale_n: 0.0,
        }
    }

    /// Puffer-Bytes ablegen (Vertex- und Indexdaten teilen sich die Nutzung).
    pub fn upload(&mut self, device: &wgpu::Device, id: u32, bytes: &[u8]) {
        let len = bytes.len() & !3;
        if len == 0 {
            return;
        }
        let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("chunks.buf"),
            contents: &bytes[..len],
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
        });
        self.buffers.insert(id, buf);
    }

    /// Aendert einen vorhandenen Puffer ab und legt ihn unter einer NEUEN ID ab:
    /// nur die geaenderten Bereiche (`ranges` = (Offset, Laenge) in Bytes, `bytes` =
    /// deren Inhalte hintereinander) werden geschrieben. Gibt `false` zurueck, wenn
    /// der alte Puffer fehlt oder die Angaben nicht passen (Aufrufer sendet dann voll).
    pub fn patch(&mut self, queue: &wgpu::Queue, from: u32, to: u32, ranges: &[(u64, u64)], bytes: &[u8]) -> bool {
        let total: u64 = ranges.iter().map(|r| r.1).sum();
        if total != bytes.len() as u64 {
            return false;
        }
        let Some(buf) = self.buffers.get(&from) else { return false };
        if ranges.iter().any(|(o, l)| o % 4 != 0 || l % 4 != 0 || o + l > buf.size()) {
            return false;
        }
        let buf = self.buffers.remove(&from).unwrap();
        let mut pos = 0usize;
        for (off, len) in ranges {
            queue.write_buffer(&buf, *off, &bytes[pos..pos + *len as usize]);
            pos += *len as usize;
        }
        self.buffers.insert(to, buf);
        true
    }

    pub fn delete(&mut self, ids: &[u32]) {
        for id in ids {
            self.buffers.remove(id);
        }
    }

    /// Texte einfuegen/ersetzen bzw. entfernen. `false`, wenn keine Schrift
    /// verfuegbar ist (die Webview zeichnet die Texte dann selbst).
    pub fn set_texts(&mut self, upsert: Vec<TextIn>, remove: &[u32]) -> bool {
        if self.font.is_none() {
            self.font = crate::vtext::VectorFont::system();
        }
        let Some(font) = self.font.as_ref() else { return false };
        for id in remove {
            self.texts.remove(id);
        }
        for t in upsert {
            let (glyphs, width_em) = font.shape(&t.text);
            self.texts.insert(
                t.id,
                TextItem {
                    x: t.x,
                    y: t.y,
                    size: t.size,
                    cs: [t.angle.cos() as f32, t.angle.sin() as f32],
                    color: t.color,
                    glyphs,
                    width_em,
                },
            );
        }
        true
    }

    pub fn text_count(&self) -> usize {
        self.texts.len()
    }

    /// Sichtbare Texte dieses Frames als nach Glyphe gruppierte Instanzen.
    /// Rueckgabe: Instanzen (nach Glyph-ID sortiert) + Gruppen (gid, Instanzbereich).
    fn build_text_instances(
        &mut self,
        bounds: (f64, f64, f64, f64),
        px_per_unit: f64,
    ) -> (Vec<TextInst>, Vec<(u16, std::ops::Range<u32>)>) {
        let Some(font) = self.font.as_mut() else { return (Vec::new(), Vec::new()) };
        let (left, right, bottom, top) = bounds;
        let (cx, cy) = ((left + right) / 2.0, (top + bottom) / 2.0);
        let mut vis: Vec<u32> = Vec::new();
        for (id, t) in &self.texts {
            if t.size * px_per_unit < MIN_TEXT_PX {
                continue;
            }
            let reach = t.size * (t.width_em as f64 + 1.0);
            if t.x + reach < left || t.x - reach > right || t.y + reach < top || t.y - reach > bottom {
                continue;
            }
            vis.push(*id);
        }
        if vis.len() > MAX_VISIBLE_TEXTS {
            // Nur die groessten behalten (wie bei Karten: wichtige Beschriftungen bleiben).
            let mut sizes: Vec<f64> = vis.iter().map(|id| self.texts[id].size).collect();
            let k = vis.len() - MAX_VISIBLE_TEXTS;
            sizes.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let threshold = sizes[k];
            vis.retain(|id| self.texts[id].size >= threshold);
        }
        let mut tmp: Vec<(u16, TextInst)> = Vec::new();
        for id in &vis {
            let t = &self.texts[id];
            let pos = [(t.x - cx) as f32, (t.y - cy) as f32];
            for &(gid, xoff) in &t.glyphs {
                if font.mesh(gid).is_none() {
                    continue;
                }
                tmp.push((gid, TextInst { pos, scale: t.size as f32, xoff, cs: t.cs, color: t.color }));
            }
        }
        tmp.sort_by_key(|(g, _)| *g);
        let mut groups: Vec<(u16, std::ops::Range<u32>)> = Vec::new();
        for (i, (g, _)) in tmp.iter().enumerate() {
            match groups.last_mut() {
                Some((lg, r)) if lg == g => r.end = i as u32 + 1,
                _ => groups.push((*g, i as u32..i as u32 + 1)),
            }
        }
        (tmp.into_iter().map(|(_, i)| i).collect(), groups)
    }

    pub fn set_highlight(&mut self, geom: Option<ChunkGeom>) {
        self.highlight = geom;
    }

    pub fn set_layout(&mut self, layout: Vec<ChunkGeom>) {
        self.layout = layout;
    }

    pub fn buffer_count(&self) -> usize {
        self.buffers.len()
    }

    /// Zeichnet einen Frame in `target` (Surface-Textur-View).
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        view: View,
        viewport: (u32, u32),
        paper_scale_n: f64,
    ) {
        let (vw, vh) = (viewport.0 as f64, viewport.1 as f64);
        let bounds = ortho_bounds(view, vw, vh);
        let meet = (vw / view.w).min(vh / view.h);
        let mm_px = (paper_scale_n / 1000.0) * PX_PER_M * meet;

        // Alle Uniform-Bloecke in Zeichenreihenfolge sammeln.
        let align = device.limits().min_uniform_buffer_offset_alignment as u64;
        let stride = (std::mem::size_of::<Globals>() as u64).div_ceil(align) * align;
        let mut blocks: Vec<Globals> = Vec::new();
        let vp = [vw as f32, vh as f32];
        for g in self.layout.iter().chain(self.highlight.iter()) {
            if g.fill_pos.is_none() || g.fill_idx.is_none() {
                continue;
            }
            let proj = projection(bounds, g.origin);
            for b in &g.fill_batches {
                let c = if g.greyed { [1.0, 1.0, 1.0, b.color[3]] } else { b.color };
                blocks.push(Globals { view_proj: proj, color: c, viewport_px: vp, stroke_px: 0.0, stroke_scale: 1.0, dash_scale: 1.0, _pad: [0.0; 3] });
            }
        }
        // Striche (Linien + gestrichelte) je Chunk in Maler-Reihenfolge (`stroke_order`).
        let orders: Vec<Vec<(bool, usize)>> = self.layout.iter().chain(self.highlight.iter()).map(stroke_order).collect();
        for (g, order) in self.layout.iter().chain(self.highlight.iter()).zip(&orders) {
            let proj = projection(bounds, g.origin);
            for &(dashed, k) in order {
                let (color, stroke_mm, scale) = if dashed {
                    let b = &g.dash_batches[k];
                    (b.color, b.stroke_mm, mm_px as f32)
                } else {
                    let b = &g.line_batches[k];
                    (b.color, b.stroke_mm, if b.device_px { 1.0 } else if b.screen_px { meet as f32 } else { mm_px as f32 })
                };
                let c = if g.greyed { [GREY, GREY, GREY, color[3]] } else { color };
                blocks.push(Globals { view_proj: proj, color: c, viewport_px: vp, stroke_px: stroke_mm, stroke_scale: scale, dash_scale: crate::ortho::dash_scale(paper_scale_n as f32, self.dash_scale_n as f32), _pad: [0.0; 3] });
            }
        }

        // Vektor-Text dieses Frames (sichtbare Texte, nach Glyphe gruppiert).
        let (text_insts, text_groups) = self.build_text_instances(bounds, meet);
        let text_block = blocks.len() as u32;
        if !text_groups.is_empty() {
            let centre = [(bounds.0 + bounds.1) / 2.0, (bounds.3 + bounds.2) / 2.0];
            blocks.push(Globals {
                view_proj: projection(bounds, centre),
                color: [0.0; 4],
                viewport_px: vp,
                stroke_px: 0.0,
                stroke_scale: 1.0,
                dash_scale: 1.0,
                _pad: [0.0; 3],
            });
            // Glyphen-Mesh-Puffer neu aufbauen, wenn neue Glyphen dazukamen.
            if let Some(font) = self.font.as_mut() {
                if font.dirty || self.glyph_vbo.is_none() {
                    self.glyph_vbo = Some(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("chunks.glyph.vbo"),
                        contents: bytemuck::cast_slice(&font.verts),
                        usage: wgpu::BufferUsages::VERTEX,
                    }));
                    self.glyph_ibo = Some(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("chunks.glyph.ibo"),
                        contents: bytemuck::cast_slice(&font.indices),
                        usage: wgpu::BufferUsages::INDEX,
                    }));
                    font.dirty = false;
                }
            }
            let need = (text_insts.len() * std::mem::size_of::<TextInst>()) as u64;
            if self.inst_buf.as_ref().map_or(true, |b| b.1 < need) {
                let cap = need.next_power_of_two().max(64 * 1024);
                self.inst_buf = Some((
                    device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("chunks.text.inst"),
                        size: cap,
                        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    }),
                    cap,
                ));
            }
            if let Some((buf, _)) = &self.inst_buf {
                queue.write_buffer(buf, 0, bytemuck::cast_slice(&text_insts));
            }
        }

        // Uniform-Puffer bei Bedarf vergroessern, dann einmal schreiben.
        let need = stride * blocks.len().max(1) as u64;
        if self.uniform.as_ref().map_or(true, |u| u.2 < need) {
            let cap = need.next_power_of_two().max(stride * 256);
            let buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("chunks.uniform"),
                size: cap,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("chunks.bind"),
                layout: &self.bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &buf,
                        offset: 0,
                        size: wgpu::BufferSize::new(std::mem::size_of::<Globals>() as u64),
                    }),
                }],
            });
            self.uniform = Some((buf, bg, cap));
        }
        let (ubuf, ubind, _) = self.uniform.as_ref().unwrap();
        let mut bytes = vec![0u8; (stride as usize) * blocks.len()];
        for (i, b) in blocks.iter().enumerate() {
            let o = i * stride as usize;
            bytes[o..o + std::mem::size_of::<Globals>()].copy_from_slice(bytemuck::bytes_of(b));
        }
        if !bytes.is_empty() {
            queue.write_buffer(ubuf, 0, &bytes);
        }

        // MSAA-Ziel (Groesse/Format an die Surface gekoppelt).
        if self.msaa.as_ref().map_or(true, |m| m.1 != viewport) {
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("chunks.msaa"),
                size: wgpu::Extent3d { width: viewport.0, height: viewport.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: self.samples,
                dimension: wgpu::TextureDimension::D2,
                format: self.format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            self.msaa = Some((tex, viewport));
        }
        let msaa_view = self.msaa.as_ref().unwrap().0.create_view(&Default::default());

        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("chunks.enc") });
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("chunks.pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &msaa_view,
                    depth_slice: None,
                    resolve_target: Some(target),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: self.clear[0],
                            g: self.clear[1],
                            b: self.clear[2],
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            let mut block = 0u32;
            pass.set_pipeline(&self.fill_pipeline);
            for g in self.layout.iter().chain(self.highlight.iter()) {
                let (Some(p), Some(i)) = (g.fill_pos, g.fill_idx) else { continue };
                let (Some(pb), Some(ib)) = (self.buffers.get(&p), self.buffers.get(&i)) else {
                    block += g.fill_batches.len() as u32;
                    continue;
                };
                pass.set_vertex_buffer(0, pb.slice(..));
                pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
                for b in &g.fill_batches {
                    pass.set_bind_group(0, ubind, &[block * stride as u32]);
                    pass.draw_indexed(b.start..b.start + b.count, 0, 0..1);
                    block += 1;
                }
            }
            // Striche je Chunk: Linien-Batches (indiziert) und gestrichelte Segmente (je
            // Instanz ein Quad aus 6 Vertices) in Maler-Reihenfolge, Pipeline nur bei Wechsel.
            let mut current: Option<bool> = None;
            for (g, order) in self.layout.iter().chain(self.highlight.iter()).zip(&orders) {
                let lines = match (g.line_vtx.and_then(|p| self.buffers.get(&p)), g.line_idx.and_then(|i| self.buffers.get(&i))) {
                    (Some(pb), Some(ib)) => Some((pb, ib)),
                    _ => None,
                };
                let dash = g.dash_inst.and_then(|d| self.buffers.get(&d));
                let mut bound_lines = false;
                let mut bound_dash = false;
                for &(dashed, k) in order {
                    let this_block = block;
                    block += 1;
                    if dashed {
                        let Some(db) = dash else { continue };
                        if current != Some(true) {
                            pass.set_pipeline(&self.dash_pipeline);
                            current = Some(true);
                            bound_lines = false;
                        }
                        if !bound_dash {
                            pass.set_vertex_buffer(0, db.slice(..));
                            bound_dash = true;
                        }
                        let b = &g.dash_batches[k];
                        // Bereich gegen die Puffergroesse klemmen (fremde Angaben → nie ausserhalb lesen).
                        let n_inst = (db.size() / DASH_INSTANCE_BYTES) as u32;
                        let end = b.start.saturating_add(b.count).min(n_inst);
                        if b.start < end {
                            pass.set_bind_group(0, ubind, &[this_block * stride as u32]);
                            pass.draw(0..6, b.start..end);
                        }
                    } else {
                        let Some((pb, ib)) = lines else { continue };
                        if current != Some(false) {
                            pass.set_pipeline(&self.line_pipeline);
                            current = Some(false);
                            bound_dash = false;
                        }
                        if !bound_lines {
                            pass.set_vertex_buffer(0, pb.slice(..));
                            pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
                            bound_lines = true;
                        }
                        let b = &g.line_batches[k];
                        pass.set_bind_group(0, ubind, &[this_block * stride as u32]);
                        pass.draw_indexed(b.start..b.start + b.count, 0, 0..1);
                    }
                }
            }
            // Text zuoberst.
            if let (false, Some(vbo), Some(ibo), Some((inst, _)), Some(font)) = (
                text_groups.is_empty(),
                &self.glyph_vbo,
                &self.glyph_ibo,
                &self.inst_buf,
                self.font.as_ref(),
            ) {
                pass.set_pipeline(&self.text_pipeline);
                pass.set_bind_group(0, ubind, &[text_block * stride as u32]);
                pass.set_vertex_buffer(0, vbo.slice(..));
                pass.set_vertex_buffer(1, inst.slice(..));
                pass.set_index_buffer(ibo.slice(..), wgpu::IndexFormat::Uint32);
                for (gid, range) in &text_groups {
                    if let Some(m) = font.mesh_info(*gid) {
                        pass.draw_indexed(m.first_index..m.first_index + m.index_count, 0, range.clone());
                    }
                }
            }
        }
        queue.submit(Some(enc.finish()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lb(start: u32) -> LineBatch {
        LineBatch { start, count: 6, color: [0.0; 4], stroke_mm: 0.1, screen_px: false, device_px: false }
    }
    fn db(line_at: u32) -> DashBatch {
        DashBatch { start: 0, count: 1, color: [0.0; 4], stroke_mm: 0.1, line_at }
    }

    #[test]
    fn striche_in_maler_reihenfolge() {
        let g = ChunkGeom {
            fill_pos: None,
            fill_idx: None,
            fill_batches: vec![],
            line_vtx: Some(1),
            line_idx: Some(2),
            line_batches: vec![lb(0), lb(6), lb(12)],
            dash_inst: Some(3),
            dash_batches: vec![db(0), db(6), db(6), db(18)],
            origin: [0.0, 0.0],
            greyed: false,
        };
        assert_eq!(stroke_order(&g), vec![(true, 0), (false, 0), (true, 1), (true, 2), (false, 1), (false, 2), (true, 3)]);
        // Ohne Strich-Puffer: nur Linien; ohne Linien-Puffer: nur gestrichelte.
        let only_lines = ChunkGeom { dash_inst: None, ..g.clone() };
        assert_eq!(stroke_order(&only_lines), vec![(false, 0), (false, 1), (false, 2)]);
        let only_dash = ChunkGeom { line_idx: None, ..g };
        assert_eq!(stroke_order(&only_dash), vec![(true, 0), (true, 1), (true, 2), (true, 3)]);
    }

    #[test]
    fn projection_matches_ts_reference() {
        // viewBox 0,0,100,50 auf 200x100 px: keine Aspekt-Korrektur noetig.
        let b = ortho_bounds(View { x: 0.0, y: 0.0, w: 100.0, h: 50.0 }, 200.0, 100.0);
        assert_eq!(b, (0.0, 100.0, 50.0, 0.0));
        let m = projection(b, [0.0, 0.0]);
        assert!((m[0] - 0.02).abs() < 1e-7 && (m[5] + 0.04).abs() < 1e-7);
        assert!((m[12] + 1.0).abs() < 1e-7 && (m[13] - 1.0).abs() < 1e-7);
        // Ursprung verschiebt in doppelter Genauigkeit: Punkt (ox,oy) -> Mitte-Offset.
        let m2 = projection(b, [50.0, 25.0]);
        assert!(m2[12].abs() < 1e-7 && m2[13].abs() < 1e-7);
    }
}
