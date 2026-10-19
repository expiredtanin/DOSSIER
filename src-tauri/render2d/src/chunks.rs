// Chunk-Renderer: zeichnet die FERTIG tessellierten GPU-Chunks der Webview
// (src/plan/glPlan/glPlanChunks.ts) nativ — dasselbe Vertex-Format, dieselben
// Shader (FILL_WGSL/LINE_WGSL), dieselbe Zeichenreihenfolge (erst alle
// Fuellungen, dann alle Linien) und dieselbe Projektionsmathematik wie
// `PlanGpuRenderer` (glPlanRender.ts), inkl. lokalem Chunk-Ursprung in doppelter
// Genauigkeit.
//
// Linien-Vertices kommen KOMPAKT (12 Byte, s. LINE_PACKED_WGSL).
//
// Die Webview kompiliert weiterhin (Cache/Chunk-Logik bleibt in TypeScript) und
// schickt nur noch die Puffer-BYTES je Chunk einmalig; pro Frame geht nur der
// Ausschnitt (viewBox) hierher. Rust haelt die Puffer — kein JSON, kein
// Re-Upload bei Pan/Zoom.

use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::shaders::FILL_WGSL;

const SAMPLE_COUNT: u32 = 4;
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
    let width_px = max(0.6, globals.stroke_px * globals.stroke_scale) * in.packed.w;
    let offset_px = unit_px * (width_px * 0.5) * in.packed.z;
    return vec4<f32>(clip_p.xy + offset_px / (globals.viewport_px * 0.5), clip_p.z, clip_p.w);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return globals.color;
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    view_proj: [f32; 16],
    color: [f32; 4],
    viewport_px: [f32; 2],
    stroke_px: f32,
    stroke_scale: f32,
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
}

/// Ein Chunk (== `GpuGeometry` der Webview): Puffer-IDs statt GL-Puffer.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct ChunkGeom {
    pub fill_pos: Option<u32>,
    pub fill_idx: Option<u32>,
    pub fill_batches: Vec<FillBatch>,
    pub line_vtx: Option<u32>,
    pub line_idx: Option<u32>,
    pub line_batches: Vec<LineBatch>,
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
    bind_group_layout: wgpu::BindGroupLayout,
    uniform: Option<(wgpu::Buffer, wgpu::BindGroup, u64)>,
    buffers: HashMap<u32, wgpu::Buffer>,
    layout: Vec<ChunkGeom>,
    msaa: Option<(wgpu::Texture, (u32, u32))>,
    format: wgpu::TextureFormat,
    pub clear: [f64; 3],
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
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
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
                    count: SAMPLE_COUNT,
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
        Self {
            fill_pipeline,
            line_pipeline,
            bind_group_layout,
            uniform: None,
            buffers: HashMap::new(),
            layout: Vec::new(),
            msaa: None,
            format,
            clear: [0.941, 0.941, 0.941],
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
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::INDEX,
        });
        self.buffers.insert(id, buf);
    }

    pub fn delete(&mut self, ids: &[u32]) {
        for id in ids {
            self.buffers.remove(id);
        }
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
        for g in &self.layout {
            if g.fill_pos.is_none() || g.fill_idx.is_none() {
                continue;
            }
            let proj = projection(bounds, g.origin);
            for b in &g.fill_batches {
                let c = if g.greyed { [1.0, 1.0, 1.0, b.color[3]] } else { b.color };
                blocks.push(Globals { view_proj: proj, color: c, viewport_px: vp, stroke_px: 0.0, stroke_scale: 1.0 });
            }
        }
        for g in &self.layout {
            if g.line_vtx.is_none() || g.line_idx.is_none() {
                continue;
            }
            let proj = projection(bounds, g.origin);
            for b in &g.line_batches {
                let c = if g.greyed { [GREY, GREY, GREY, b.color[3]] } else { b.color };
                blocks.push(Globals {
                    view_proj: proj,
                    color: c,
                    viewport_px: vp,
                    stroke_px: b.stroke_mm,
                    stroke_scale: if b.screen_px { meet as f32 } else { mm_px as f32 },
                });
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
                sample_count: SAMPLE_COUNT,
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
            for g in &self.layout {
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
            pass.set_pipeline(&self.line_pipeline);
            for g in &self.layout {
                let (Some(p), Some(i)) = (g.line_vtx, g.line_idx) else { continue };
                let (Some(pb), Some(ib)) = (self.buffers.get(&p), self.buffers.get(&i)) else {
                    block += g.line_batches.len() as u32;
                    continue;
                };
                pass.set_vertex_buffer(0, pb.slice(..));
                pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
                for b in &g.line_batches {
                    pass.set_bind_group(0, ubind, &[block * stride as u32]);
                    pass.draw_indexed(b.start..b.start + b.count, 0, 0..1);
                    block += 1;
                }
            }
        }
        queue.submit(Some(enc.finish()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
