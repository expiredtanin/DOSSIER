// [333] Umgebungsverdeckung (SSAO) für die beleuchteten Stile: weiche Kontaktschatten in Ecken, an Wandfüssen, unter
// Vordächern — macht Massenmodelle plastischer, ohne Sonne und Schattenkarte.
//
// Ablauf je Bild (`gpu::Renderer::render`): Durchgang A zeichnet die Flächen (MSAA-Farbe und -Tiefe bleiben), dann
// rechnet `encode` in halber Auflösung je Pixel die Verdeckung aus der Tiefe (Lage im Kameraraum über die inverse
// Projektion, Normale aus den Nachbarn, 12 Proben in der Halbkugel, je Pixel gedreht); Durchgang B multipliziert zuerst
// die Farbe mit der geglätteten Verdeckung (`draw_composite`, Weichzeichner, der Tiefensprünge respektiert) und
// zeichnet danach Kanten, Linien und Gitter — die bleiben unverdunkelt.
//
// Alles im Kameraraum (kleine Zahlen, f32-genau), Radius in Metern. Hintergrund (Tiefe 1.0) bleibt unberührt.

use crate::math::Mat4;
use bytemuck::{Pod, Zeroable};

/// Uniform beider Shader, 1:1 zu `AoU` in den WGSL-Quellen.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub(crate) struct AoUniform {
    pub proj: Mat4,
    pub inv_proj: Mat4,
    /// x = Radius (m), y = Stärke, z = Tiefen-Bias (m), w = perspektivisch (1) / orthografisch (0).
    pub params: [f32; 4],
    /// xy = volle Grösse (px), zw = AO-Grösse (px).
    pub size: [f32; 4],
    /// [333] x = AO an (1/0), y = Umriss an (1/0), z = Umriss-Stärke (0..1), w = frei.
    pub flags: [f32; 4],
}

/// Gemeinsamer Kopf beider Shader.
const AO_COMMON_WGSL: &str = r#"
struct AoU {
    proj     : mat4x4<f32>,
    inv_proj : mat4x4<f32>,
    params   : vec4<f32>,
    size     : vec4<f32>,
    flags    : vec4<f32>,
};
@group(0) @binding(0) var<uniform> u : AoU;
@group(0) @binding(1) var depth_ms : texture_depth_multisampled_2d;

fn depth_at(px : vec2<i32>) -> f32 {
    let c = clamp(px, vec2<i32>(0, 0), vec2<i32>(u.size.xy) - vec2<i32>(1, 1));
    return textureLoad(depth_ms, c, 0);
}

// Lage im Kameraraum aus Bild-UV (0..1, y nach unten) und Tiefe (0..1).
fn view_pos(uv : vec2<f32>, d : f32) -> vec3<f32> {
    let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
    let v = u.inv_proj * ndc;
    return v.xyz / v.w;
}

fn view_at(px : vec2<i32>) -> vec3<f32> {
    let c = clamp(px, vec2<i32>(0, 0), vec2<i32>(u.size.xy) - vec2<i32>(1, 1));
    return view_pos((vec2<f32>(c) + 0.5) / u.size.xy, textureLoad(depth_ms, c, 0));
}

struct VsOut {
    @builtin(position) pos : vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> VsOut {
    // Ein Dreieck über das ganze Bild.
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out : VsOut;
    out.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
    return out;
}
"#;

/// Verdeckung je AO-Pixel (Rg16Float: r = 1 frei … 0 ganz verdeckt, g = Tiefe im Kameraraum, Hintergrund +1).
const AO_FS_WGSL: &str = r#"
// Proben in der Halbkugel (z = Normale), nach innen dichter.
const KERNEL : array<vec3<f32>, 12> = array<vec3<f32>, 12>(
    vec3<f32>( 0.536,  0.180, 0.283), vec3<f32>(-0.290,  0.442, 0.212), vec3<f32>(-0.163, -0.507, 0.336),
    vec3<f32>( 0.402, -0.395, 0.181), vec3<f32>( 0.112,  0.710, 0.402), vec3<f32>(-0.705, -0.093, 0.335),
    vec3<f32>( 0.734,  0.476, 0.240), vec3<f32>(-0.512, -0.672, 0.188), vec3<f32>( 0.158, -0.858, 0.399),
    vec3<f32>(-0.880,  0.389, 0.200), vec3<f32>( 0.211,  0.170, 0.902), vec3<f32>(-0.177, -0.143, 0.604),
);

@fragment
fn fs_ao(in : VsOut) -> @location(0) vec4<f32> {
    let scale = u.size.xy / u.size.zw;
    let fp = vec2<i32>(floor(in.pos.xy * scale));
    let d = depth_at(fp);
    if (d >= 1.0) {
        return vec4<f32>(1.0, 1.0, 0.0, 1.0);
    }
    let p = view_at(fp);
    // Normale aus den Nachbarn: je Achse die Seite mit dem kleineren Tiefensprung (keine Verwischung an Kanten).
    let pr = view_at(fp + vec2<i32>(1, 0));
    let pl = view_at(fp - vec2<i32>(1, 0));
    let pd = view_at(fp + vec2<i32>(0, 1));
    let pu = view_at(fp - vec2<i32>(0, 1));
    let dx = select(pr - p, p - pl, abs(pl.z - p.z) < abs(pr.z - p.z));
    let dy = select(pd - p, p - pu, abs(pu.z - p.z) < abs(pd.z - p.z));
    var n = normalize(cross(dx, dy));
    let to_eye = select(vec3<f32>(0.0, 0.0, 1.0), -p, u.params.w > 0.5);
    if (dot(n, to_eye) < 0.0) {
        n = -n;
    }
    // Drehung je Pixel (4×4-Muster, der Weichzeichner glättet es).
    let k = vec2<u32>(vec2<i32>(in.pos.xy)) % vec2<u32>(4u, 4u);
    let a = (f32(k.x * 4u + k.y) * 0.39269908 + f32(k.y) * 1.7) ;
    let r0 = vec3<f32>(cos(a), sin(a), 0.0);
    let t = normalize(r0 - n * dot(r0, n));
    let b = cross(n, t);
    let radius = u.params.x;
    // Bias wächst mit der Entfernung (Tiefen- und Normalen-Rauschen der fernen Flächen).
    let bias = u.params.z + 0.002 * abs(p.z);
    var occ = 0.0;
    for (var i = 0u; i < 12u; i = i + 1u) {
        // Von der Fläche abheben (z ≥ ~0.35): flache Proben träfen die eigene, leicht verrauschte Fläche (Flecken).
        let kv = normalize(KERNEL[i] + vec3<f32>(0.0, 0.0, 0.35)) * length(KERNEL[i]);
        let s = p + (t * kv.x + b * kv.y + n * kv.z) * radius;
        let c = u.proj * vec4<f32>(s, 1.0);
        if (c.w <= 0.0) {
            continue;
        }
        let ndc = c.xy / c.w;
        let suv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
        if (any(suv < vec2<f32>(0.0)) || any(suv > vec2<f32>(1.0))) {
            continue;
        }
        let sp = view_at(vec2<i32>(suv * u.size.xy));
        // Blick entlang −z: näher = grösseres z.
        let blocked = sp.z >= s.z + bias;
        let range = smoothstep(0.0, 1.0, radius / max(abs(p.z - sp.z), 1e-4));
        occ = occ + select(0.0, range, blocked);
    }
    let ao = clamp(1.0 - occ / 12.0 * u.params.y, 0.0, 1.0);
    return vec4<f32>(ao, p.z, 0.0, 1.0);
}
"#;

/// [333] Umriss je Pixel (R8, volle Auflösung: 1 = kein Umriss): kräftige Umrisslinie, wo die Tiefe zu einem weiter
/// hinten liegenden Körper oder zum Hintergrund springt — die Silhouette der Körper wie in einer Zeichnung betont,
/// die Kanten innen bleiben fein (eigene 1-px-Linien). Gezeichnet auf dem vorderen Körper: Nachbarn im Abstand 1 voll,
/// im Abstand 2 halb (~2 px, aussen weich); Sprung relativ zur Entfernung (Neigung schräger Flächen zählt nicht).
const OUTLINE_FS_WGSL: &str = r#"
const RING : array<vec3<i32>, 12> = array<vec3<i32>, 12>(
    vec3<i32>(1, 0, 2), vec3<i32>(-1, 0, 2), vec3<i32>(0, 1, 2), vec3<i32>(0, -1, 2),
    vec3<i32>(1, 1, 2), vec3<i32>(-1, 1, 2), vec3<i32>(1, -1, 2), vec3<i32>(-1, -1, 2),
    vec3<i32>(2, 0, 1), vec3<i32>(-2, 0, 1), vec3<i32>(0, 2, 1), vec3<i32>(0, -2, 1),
);

@fragment
fn fs_outline(in : VsOut) -> @location(0) vec4<f32> {
    let fp = vec2<i32>(floor(in.pos.xy));
    if (depth_at(fp) >= 1.0) {
        return vec4<f32>(1.0);
    }
    let zc = view_at(fp).z;
    // Toleranz wächst mit der Entfernung (Tiefenauflösung) und mit dem Pixel-Abstand der Probe (schräge Flächen).
    let tol = 0.03 * abs(zc) + 0.04;
    var edge = 0.0;
    for (var k = 0u; k < 12u; k = k + 1u) {
        let o = RING[k];
        let q = fp + o.xy;
        var zq = -1.0e9;
        if (depth_at(q) < 1.0) {
            zq = view_at(q).z;
        }
        let w = select(0.5, 1.0, o.z == 2);
        if (zc - zq > tol * f32(3 - o.z)) {
            edge = max(edge, w);
        }
    }
    return vec4<f32>(1.0 - u.flags.z * edge);
}
"#;

/// Multipliziert die Farbe mit der geglätteten Verdeckung (Mischung `Ziel × Quelle`). Liest nur die AO-Textur (die
/// Tiefe hängt in Durchgang B als Anhang, darf dort nicht gelesen werden): Gewichte nach der dort abgelegten Tiefe.
const COMPOSITE_WGSL: &str = r#"
struct AoU {
    proj     : mat4x4<f32>,
    inv_proj : mat4x4<f32>,
    params   : vec4<f32>,
    size     : vec4<f32>,
    flags    : vec4<f32>,
};
@group(0) @binding(0) var<uniform> u : AoU;
@group(0) @binding(1) var ao_tex : texture_2d<f32>;
@group(0) @binding(2) var outline_tex : texture_2d<f32>;

struct VsOut {
    @builtin(position) pos : vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> VsOut {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out : VsOut;
    out.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_composite(in : VsOut) -> @location(0) vec4<f32> {
    var line = 1.0;
    if (u.flags.y > 0.5) {
        line = textureLoad(outline_tex, vec2<i32>(floor(in.pos.xy)), 0).r;
    }
    if (u.flags.x < 0.5) {
        return vec4<f32>(line, line, line, 1.0);
    }
    let scale = u.size.xy / u.size.zw;
    let ao_size = vec2<i32>(u.size.zw);
    let c = clamp(vec2<i32>(floor(in.pos.xy / scale)), vec2<i32>(0, 0), ao_size - vec2<i32>(1, 1));
    let z = textureLoad(ao_tex, c, 0).g;
    if (z > 0.0) {
        return vec4<f32>(line, line, line, 1.0);
    }
    // 4×4 AO-Texel, gewichtet nach Tiefen-Nähe (relativ zur Entfernung): kein Hof über Silhouetten.
    var sum = 0.0;
    var wsum = 0.0;
    for (var j = -2; j <= 1; j = j + 1) {
        for (var i = -2; i <= 1; i = i + 1) {
            let q = clamp(c + vec2<i32>(i, j), vec2<i32>(0, 0), ao_size - vec2<i32>(1, 1));
            let t = textureLoad(ao_tex, q, 0);
            let w = select(exp(-abs(t.g - z) / max(0.02 * abs(z), 0.05)), 0.0, t.g > 0.0);
            sum = sum + t.r * w;
            wsum = wsum + w;
        }
    }
    let ao = select(1.0, sum / wsum, wsum > 1e-4) * line;
    return vec4<f32>(ao, ao, ao, 1.0);
}
"#;

pub(crate) fn ao_wgsl() -> String {
    format!("{AO_COMMON_WGSL}{AO_FS_WGSL}")
}

pub(crate) fn outline_wgsl() -> String {
    format!("{AO_COMMON_WGSL}{OUTLINE_FS_WGSL}")
}

pub(crate) fn composite_wgsl() -> String {
    COMPOSITE_WGSL.to_string()
}

/// Grösse der AO-Textur: halbe Auflösung (mindestens 1 px).
pub(crate) fn ao_size(w: u32, h: u32) -> (u32, u32) {
    (w.div_ceil(2).max(1), h.div_ceil(2).max(1))
}

/// Radius (m) nach Entfernung der Kamera zum Ziel: nah fein (Fensterleibung, Sockel), fern gröber (sonst verschwindet
/// die Verdeckung im ganzen Quartier).
pub(crate) fn ao_radius(view_dist: f32) -> f32 {
    if !view_dist.is_finite() {
        return 0.6;
    }
    (0.04 * view_dist).clamp(0.25, 2.5)
}

/// [333] Stärke der Umrisslinie (Abdunkelung 0..1).
pub(crate) const OUTLINE_STRENGTH: f32 = 0.82;

/// Uniform für ein Bild: `ao`/`outline` = welche Wirkungen an sind.
pub(crate) fn uniform(proj: &Mat4, perspective: bool, view_dist: f32, full: (u32, u32), ao: bool, outline: bool) -> AoUniform {
    let (aw, ah) = ao_size(full.0, full.1);
    let r = ao_radius(view_dist);
    AoUniform {
        proj: *proj,
        inv_proj: crate::math::invert(proj).unwrap_or_else(crate::math::identity),
        params: [r, 1.1, 0.04 * r, if perspective { 1.0 } else { 0.0 }],
        size: [full.0 as f32, full.1 as f32, aw as f32, ah as f32],
        flags: [f32::from(u8::from(ao)), f32::from(u8::from(outline)), OUTLINE_STRENGTH, 0.0],
    }
}

/// Format der Umriss-Textur (volle Auflösung).
pub(crate) const OUTLINE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R8Unorm;

/// Format der AO-Textur: Verdeckung + Tiefe im Kameraraum.
pub(crate) const AO_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rg16Float;

/// GPU-Teil: Pipelines, Uniform, AO-Textur (halbe Auflösung) und Bind-Groups (neu bei Grössen-/Tiefen-Wechsel).
pub(crate) struct Ssao {
    uniform: wgpu::Buffer,
    ao_layout: wgpu::BindGroupLayout,
    comp_layout: wgpu::BindGroupLayout,
    ao_pipeline: wgpu::RenderPipeline,
    outline_pipeline: wgpu::RenderPipeline,
    comp_pipeline: wgpu::RenderPipeline,
    target: Option<(wgpu::TextureView, (u32, u32))>,
    /// [333] Umriss-Textur (volle Auflösung).
    outline_target: Option<(wgpu::TextureView, (u32, u32))>,
    ao_bind: Option<wgpu::BindGroup>,
    comp_bind: Option<wgpu::BindGroup>,
}

impl Ssao {
    pub(crate) fn new(device: &wgpu::Device, color_format: wgpu::TextureFormat, depth_format: wgpu::TextureFormat, samples: u32) -> Self {
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("ssao.uniform"),
            size: std::mem::size_of::<AoUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let ubind = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let ao_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ssao.ao.layout"),
            entries: &[
                ubind,
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: samples > 1,
                    },
                    count: None,
                },
            ],
        });
        let comp_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ssao.comp.layout"),
            entries: &[
                ubind,
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let ao_src = ao_wgsl();
        let ao_src = if samples > 1 { ao_src } else { ao_src.replace("texture_depth_multisampled_2d", "texture_depth_2d") };
        let ao_module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ssao.ao.wgsl"), source: wgpu::ShaderSource::Wgsl(ao_src.into()) });
        let ol_src = outline_wgsl();
        let ol_src = if samples > 1 { ol_src } else { ol_src.replace("texture_depth_multisampled_2d", "texture_depth_2d") };
        let ol_module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ssao.outline.wgsl"), source: wgpu::ShaderSource::Wgsl(ol_src.into()) });
        let comp_module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ssao.comp.wgsl"), source: wgpu::ShaderSource::Wgsl(composite_wgsl().into()) });
        let layout = |l: &wgpu::BindGroupLayout, name: &str| {
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(name), bind_group_layouts: &[Some(l)], immediate_size: 0 })
        };
        let ao_pl = layout(&ao_layout, "ssao.ao.pl");
        let comp_pl = layout(&comp_layout, "ssao.comp.pl");
        let ao_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ssao.ao"),
            layout: Some(&ao_pl),
            vertex: wgpu::VertexState { module: &ao_module, entry_point: Some("vs_main"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &ao_module,
                entry_point: Some("fs_ao"),
                targets: &[Some(wgpu::ColorTargetState { format: AO_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let outline_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ssao.outline"),
            layout: Some(&ao_pl),
            vertex: wgpu::VertexState { module: &ol_module, entry_point: Some("vs_main"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &ol_module,
                entry_point: Some("fs_outline"),
                targets: &[Some(wgpu::ColorTargetState { format: OUTLINE_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        // Ziel × Quelle (Farbe), Alpha bleibt.
        let multiply = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::Src, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
        };
        let comp_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ssao.composite"),
            layout: Some(&comp_pl),
            vertex: wgpu::VertexState { module: &comp_module, entry_point: Some("vs_main"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &comp_module,
                entry_point: Some("fs_composite"),
                targets: &[Some(wgpu::ColorTargetState { format: color_format, blend: Some(multiply), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            // Durchgang B hat den Tiefen-Anhang: kompatibel, aber ohne Test und ohne Schreiben.
            depth_stencil: Some(wgpu::DepthStencilState {
                format: depth_format,
                depth_write_enabled: Some(false),
                depth_compare: Some(wgpu::CompareFunction::Always),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState { count: samples, mask: !0, alpha_to_coverage_enabled: false },
            multiview_mask: None,
            cache: None,
        });
        Self { uniform, ao_layout, comp_layout, ao_pipeline, outline_pipeline, comp_pipeline, target: None, outline_target: None, ao_bind: None, comp_bind: None }
    }

    /// Bind-Groups verwerfen (neue Tiefentextur).
    pub(crate) fn invalidate(&mut self) {
        self.ao_bind = None;
        self.comp_bind = None;
    }

    /// Verdeckung (halbe Auflösung) und Umriss (volle Auflösung) rechnen, je nach `u.flags` (eigene Durchgänge, lesen die
    /// Tiefe aus Durchgang A).
    pub(crate) fn encode(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        depth_view: &wgpu::TextureView,
        u: &AoUniform,
    ) {
        let full = (u.size[0] as u32, u.size[1] as u32);
        let size = ao_size(full.0, full.1);
        if self.target.as_ref().map(|t| t.1) != Some(size) {
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("ssao.ao"),
                size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: AO_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            self.target = Some((tex.create_view(&wgpu::TextureViewDescriptor::default()), size));
            self.invalidate();
        }
        if self.outline_target.as_ref().map(|t| t.1) != Some(full) {
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("ssao.outline"),
                size: wgpu::Extent3d { width: full.0.max(1), height: full.1.max(1), depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: OUTLINE_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            self.outline_target = Some((tex.create_view(&wgpu::TextureViewDescriptor::default()), full));
            self.invalidate();
        }
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(u));
        let ao_view = &self.target.as_ref().unwrap().0;
        let ol_view = &self.outline_target.as_ref().unwrap().0;
        if self.ao_bind.is_none() {
            self.ao_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("ssao.ao.bind"),
                layout: &self.ao_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.uniform.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(depth_view) },
                ],
            }));
            self.comp_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("ssao.comp.bind"),
                layout: &self.comp_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.uniform.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(ao_view) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(ol_view) },
                ],
            }));
        }
        let full_pass = |encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, label: &str, pipeline: &wgpu::RenderPipeline, bind: &wgpu::BindGroup| {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(label),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 1.0, g: 1.0, b: 0.0, a: 1.0 }), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, bind, &[]);
            pass.draw(0..3, 0..1);
        };
        let bind = self.ao_bind.as_ref().unwrap();
        if u.flags[0] > 0.5 {
            full_pass(encoder, ao_view, "ssao.pass", &self.ao_pipeline, bind);
        }
        if u.flags[1] > 0.5 {
            full_pass(encoder, ol_view, "ssao.outline.pass", &self.outline_pipeline, bind);
        }
    }

    /// Farbe mit der Verdeckung multiplizieren (in Durchgang B, vor Kanten und Linien).
    pub(crate) fn draw_composite(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(b) = &self.comp_bind {
            pass.set_pipeline(&self.comp_pipeline);
            pass.set_bind_group(0, b, &[]);
            pass.draw(0..3, 0..1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halbe_aufloesung_und_radius() {
        assert_eq!(ao_size(1001, 2), (501, 1));
        assert_eq!(ao_size(0, 0), (1, 1));
        assert!((ao_radius(10.0) - 0.4).abs() < 1e-6);
        assert_eq!(ao_radius(1.0), 0.25);
        assert_eq!(ao_radius(1e6), 2.5);
        assert_eq!(ao_radius(f32::NAN), 0.6);
    }

    #[test]
    fn uniform_kehrt_die_projektion_um() {
        let p = crate::math::perspective(0.8, 1.5, 0.1, 500.0);
        let u = uniform(&p, true, 20.0, (300, 200), true, false);
        assert_eq!(u.flags, [1.0, 0.0, OUTLINE_STRENGTH, 0.0]);
        let m = crate::math::mul(&u.proj, &u.inv_proj);
        for (i, v) in m.iter().enumerate() {
            let want = if i % 5 == 0 { 1.0 } else { 0.0 };
            assert!((v - want).abs() < 1e-4, "P·P⁻¹[{i}] = {v}");
        }
        assert_eq!(u.size, [300.0, 200.0, 150.0, 100.0]);
    }

    /// Beide Shader sind gültiges WGSL (naga).
    #[cfg(feature = "render")]
    #[test]
    fn wgsl_valide() {
        use naga::valid::{Capabilities, ValidationFlags, Validator};
        for (name, src) in [("ao", ao_wgsl()), ("outline", outline_wgsl()), ("composite", composite_wgsl())] {
            let m = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(&src)));
            Validator::new(ValidationFlags::all(), Capabilities::all())
                .validate(&m)
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        }
    }
}
