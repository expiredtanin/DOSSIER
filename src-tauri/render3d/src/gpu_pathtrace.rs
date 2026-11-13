// [212] Pathtracer, wgpu-Seite (Feature `render`): Compute-Pipeline der Pfadverfolgung, Entrauscher-Pässe und
// Anzeige-Pipeline, Puffer für Baum, Dreiecke, Akkumulation und Hilfspuffer. Der `Renderer` (gpu.rs) legt ihn erst
// an, wenn der Stil „Pathtracing (Vorschau)" zum ersten Mal zeichnet; die übrigen Stile berührt er nicht.
//
// Progressiv: jeder `render`-Aufruf rechnet `batch` Samples je Pixel dazu (Web-Viewport: 1 je Bild) und zeigt das
// Mittel. Ändert sich Kamera, Grösse, Sonne/Nacht oder Szene, beginnt die Summe von vorn. Nach `max_samples` wird nur
// noch angezeigt. Bei grossen Ansichten rechnet er verkleinert (`max_pixels`, Standard `pathtrace::MAX_PIXELS`).
//
// Entrauscher (Etappe 2, `denoise.rs`): solange die Summe unter `max_samples` liegt und `denoise` an ist, filtern
// `prep` + 5 × `atrous` (Compute) das demodulierte Licht in zwei Pingpong-Puffer; die Anzeige mischt es nach
// `denoise::blend_weight` zum rohen Mittel. Die Akkumulation bleibt unberührt; gefiltert wird nur einmal je neuer
// Sample-Zahl.
//
// Texturen (Etappe 3): Texturdaten je Dreieck (`GpuTriTex`) als siebter Puffer neben dem Baum; das Textur-Array der
// schattierten Ansicht samt Sampler und der Kehrwert der Kartenmittel als eigene Bindungsgruppe (group 1,
// `set_textures`), damit ein Kartenwechsel die Pfad-Puffer nicht neu bindet.

use wgpu::util::DeviceExt;

use crate::bvh::{Bvh, GpuNode, GpuTri, GpuTriTex};
use crate::denoise::{blend_weight, DN_WGSL, ITERATIONS, SIGMA_L, SIGMA_N, SIGMA_Z};
use crate::pathtrace::{build_params, internal_size, night_sky, sky_for_sun, PtParams, MAX_PIXELS, PT_DISPLAY_WGSL, PT_WGSL};
use crate::types::{Camera, Projection};

/// Standard-Obergrenze der Samples je Pixel (danach steht das Bild).
pub const DEFAULT_MAX_SAMPLES: u32 = 1024;

/// Parameter eines Entrauscher-Durchgangs (1:1 zum WGSL-`DnParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct DnParams {
    dims: [u32; 4],
    k: [f32; 4],
}

/// Puffer je Pixel: Akkumulation, Hilfspuffer, Entrauscher-Pingpong.
struct Frame {
    accum: wgpu::Buffer,
    aux_a: wgpu::Buffer,
    aux_b: wgpu::Buffer,
    filt: [wgpu::Buffer; 2],
}

pub struct PathTracer {
    compute: wgpu::ComputePipeline,
    compute_layout: wgpu::BindGroupLayout,
    display: wgpu::RenderPipeline,
    display_layout: wgpu::BindGroupLayout,
    dn_prep: wgpu::ComputePipeline,
    dn_atrous: wgpu::ComputePipeline,
    dn_layout: wgpu::BindGroupLayout,
    /// Je Durchgang ein Parameter-Puffer (prep + ITERATIONS).
    dn_params: Vec<wgpu::Buffer>,
    params: wgpu::Buffer,
    nodes: wgpu::Buffer,
    tris: wgpu::Buffer,
    tri_tex: wgpu::Buffer,
    tex_layout: wgpu::BindGroupLayout,
    /// Bildkarten (group 1); None bis `set_textures` (dann zeichnet er nicht).
    tex_bind: Option<wgpu::BindGroup>,
    tri_count: u32,
    frame_bufs: Option<Frame>,
    internal: (u32, u32),
    compute_bind: Option<wgpu::BindGroup>,
    display_bind: Option<wgpu::BindGroup>,
    dn_binds: Vec<wgpu::BindGroup>,
    /// Zahl der aufsummierten Samples je Pixel.
    frame: u32,
    /// Sample-Zahl, zu der die Entrauscher-Puffer gerechnet sind (None = ungültig).
    dn_frame: Option<u32>,
    /// Bild-Schlüssel (Kamera, Grösse, Sonne, Szenen-Nummer) der laufenden Summe.
    key: Option<Vec<u32>>,
    scene_gen: u32,
    pub max_samples: u32,
    /// Entrauscher in der Anzeige (Standard an).
    pub denoise: bool,
    /// Höchstzahl Pixel je Sample (grössere Ansichten rechnen verkleinert).
    pub max_pixels: u64,
    srgb_encode: bool,
    max_binding: u64,
}

fn storage_entry(binding: u32, read_only: bool, vis: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: vis,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn uniform_entry(vis: wgpu::ShaderStages, size: u64) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: vis,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: wgpu::BufferSize::new(size) },
        count: None,
    }
}

impl PathTracer {
    pub fn new(device: &wgpu::Device, color_format: wgpu::TextureFormat) -> Self {
        let cs = wgpu::ShaderStages::COMPUTE;
        let fs = wgpu::ShaderStages::FRAGMENT;
        let psize = std::mem::size_of::<PtParams>() as u64;
        let compute_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathtrace.compute.layout"),
            entries: &[
                uniform_entry(cs, psize),
                storage_entry(1, true, cs),
                storage_entry(2, true, cs),
                storage_entry(3, false, cs),
                storage_entry(4, false, cs),
                storage_entry(5, false, cs),
                storage_entry(6, true, cs),
            ],
        });
        let tex_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathtrace.textures.layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: cs,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: cs, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                storage_entry(2, true, cs),
            ],
        });
        let display_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathtrace.display.layout"),
            entries: &[uniform_entry(fs, psize), storage_entry(1, true, fs), storage_entry(2, true, fs), storage_entry(3, true, fs)],
        });
        let dn_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathtrace.denoise.layout"),
            entries: &[
                uniform_entry(cs, std::mem::size_of::<DnParams>() as u64),
                storage_entry(1, true, cs),
                storage_entry(2, true, cs),
                storage_entry(3, true, cs),
                storage_entry(4, true, cs),
                storage_entry(5, false, cs),
            ],
        });
        let cmod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("pathtrace.wgsl"), source: wgpu::ShaderSource::Wgsl(PT_WGSL.into()) });
        let dmod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("pathtrace.display.wgsl"), source: wgpu::ShaderSource::Wgsl(PT_DISPLAY_WGSL.into()) });
        let nmod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("pathtrace.denoise.wgsl"), source: wgpu::ShaderSource::Wgsl(DN_WGSL.into()) });
        let clayout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("pathtrace.compute.pl"), bind_group_layouts: &[Some(&compute_layout), Some(&tex_layout)], immediate_size: 0 });
        let dlayout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("pathtrace.display.pl"), bind_group_layouts: &[Some(&display_layout)], immediate_size: 0 });
        let nlayout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("pathtrace.denoise.pl"), bind_group_layouts: &[Some(&dn_layout)], immediate_size: 0 });
        let compute_pipe = |label: &str, layout: &wgpu::PipelineLayout, module: &wgpu::ShaderModule, entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: Some(layout),
                module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let compute = compute_pipe("pathtrace.compute", &clayout, &cmod, "main");
        let dn_prep = compute_pipe("pathtrace.denoise.prep", &nlayout, &nmod, "prep");
        let dn_atrous = compute_pipe("pathtrace.denoise.atrous", &nlayout, &nmod, "atrous");
        let display = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("pathtrace.display"),
            layout: Some(&dlayout),
            vertex: wgpu::VertexState { module: &dmod, entry_point: Some("vs_main"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &dmod,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState { format: color_format, blend: Some(wgpu::BlendState::REPLACE), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: None, ..Default::default() },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pathtrace.params"),
            size: psize,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let dn_params = (0..=ITERATIONS)
            .map(|_| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("pathtrace.denoise.params"),
                    size: std::mem::size_of::<DnParams>() as u64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
            .collect();
        let (nodes, tris, tri_tex) = Self::scene_buffers(device, &Bvh::default());
        Self {
            compute,
            compute_layout,
            display,
            display_layout,
            dn_prep,
            dn_atrous,
            dn_layout,
            dn_params,
            params,
            nodes,
            tris,
            tri_tex,
            tex_layout,
            tex_bind: None,
            tri_count: 0,
            frame_bufs: None,
            internal: (0, 0),
            compute_bind: None,
            display_bind: None,
            dn_binds: Vec::new(),
            frame: 0,
            dn_frame: None,
            key: None,
            scene_gen: 0,
            max_samples: DEFAULT_MAX_SAMPLES,
            denoise: true,
            max_pixels: MAX_PIXELS,
            srgb_encode: !color_format.is_srgb(),
            max_binding: device.limits().max_storage_buffer_binding_size,
        }
    }

    /// Puffer für Baum, Dreiecke und Texturdaten; leer = je ein Platzhalter-Eintrag (Bindungen dürfen nicht leer sein).
    /// Texturdaten in anderer Länge als die Dreiecke (kein Fall des Baums) werden mit „ohne Textur“ aufgefüllt.
    fn scene_buffers(device: &wgpu::Device, bvh: &Bvh) -> (wgpu::Buffer, wgpu::Buffer, wgpu::Buffer) {
        let node0 = [GpuNode::default()];
        let tri0 = [GpuTri::default()];
        let nodes: &[GpuNode] = if bvh.nodes.is_empty() { &node0 } else { &bvh.nodes };
        let tris: &[GpuTri] = if bvh.tris.is_empty() { &tri0 } else { &bvh.tris };
        let mut tex: Vec<GpuTriTex> = bvh.tex.iter().copied().take(tris.len()).collect();
        tex.resize(tris.len(), GpuTriTex { scale: 1.0, ..GpuTriTex::default() });
        let n = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("pathtrace.nodes"), contents: bytemuck::cast_slice(nodes), usage: wgpu::BufferUsages::STORAGE });
        let t = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("pathtrace.tris"), contents: bytemuck::cast_slice(tris), usage: wgpu::BufferUsages::STORAGE });
        let x = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("pathtrace.tri_tex"), contents: bytemuck::cast_slice(&tex), usage: wgpu::BufferUsages::STORAGE });
        (n, t, x)
    }

    /// Bildkarten für den Pfad: Textur-Array (D2Array, wie `Renderer::set_material_textures`), Sampler mit Wiederholung
    /// und je Ebene der Kehrwert der mittleren Kartenfarbe (`PtMaterialTable::inv_means`, Index = Ebene). Die Summe
    /// beginnt von vorn.
    pub fn set_textures(&mut self, device: &wgpu::Device, view: &wgpu::TextureView, sampler: &wgpu::Sampler, inv_means: &[[f32; 4]]) {
        let one = [[1.0f32; 4]];
        let inv: &[[f32; 4]] = if inv_means.is_empty() { &one } else { inv_means };
        let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("pathtrace.layer_inv"), contents: bytemuck::cast_slice(inv), usage: wgpu::BufferUsages::STORAGE });
        self.tex_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pathtrace.textures.bind"),
            layout: &self.tex_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: buf.as_entire_binding() },
            ],
        }));
        self.scene_gen = self.scene_gen.wrapping_add(1);
        self.key = None;
    }

    /// Neue Szene hochladen; die Summe beginnt von vorn. Zu grosse Szenen (über dem Bindungs-Limit des Geräts)
    /// werden leer gezeigt statt die Validierung scheitern zu lassen.
    pub fn set_bvh(&mut self, device: &wgpu::Device, bvh: &Bvh) {
        let too_big = (bvh.tris.len() * std::mem::size_of::<GpuTri>()) as u64 > self.max_binding
            || (bvh.nodes.len() * std::mem::size_of::<GpuNode>()) as u64 > self.max_binding;
        let empty = Bvh::default();
        let use_bvh = if too_big { &empty } else { bvh };
        let (n, t, x) = Self::scene_buffers(device, use_bvh);
        self.nodes = n;
        self.tris = t;
        self.tri_tex = x;
        self.tri_count = use_bvh.tris.len() as u32;
        self.scene_gen = self.scene_gen.wrapping_add(1);
        self.compute_bind = None;
        self.key = None;
    }

    /// Dreiecke im Baum (0 = leer oder zu gross).
    pub fn tri_count(&self) -> u32 {
        self.tri_count
    }

    /// Aufsummierte Samples je Pixel der laufenden Summe.
    pub fn samples(&self) -> u32 {
        self.frame
    }

    /// Interne Auflösung der laufenden Summe.
    pub fn internal_size(&self) -> (u32, u32) {
        self.internal
    }

    /// Summe verwerfen (nächster Aufruf beginnt von vorn).
    pub fn reset(&mut self) {
        self.key = None;
    }

    /// Mischgewicht des Entrauschers für die laufende Summe (0 = aus).
    pub fn denoise_weight(&self) -> f32 {
        if self.denoise {
            blend_weight(self.frame, self.max_samples)
        } else {
            0.0
        }
    }

    fn ensure_frame(&mut self, device: &wgpu::Device, size: (u32, u32)) {
        if self.frame_bufs.is_some() && self.internal == size {
            return;
        }
        let bytes = (size.0 as u64 * size.1 as u64 * 16).max(16);
        let buf = |label: &str| device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: bytes, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        self.frame_bufs = Some(Frame {
            accum: buf("pathtrace.accum"),
            aux_a: buf("pathtrace.aux_a"),
            aux_b: buf("pathtrace.aux_b"),
            filt: [buf("pathtrace.filt0"), buf("pathtrace.filt1")],
        });
        self.internal = size;
        self.compute_bind = None;
        self.display_bind = None;
        self.dn_binds.clear();
        self.key = None;
    }

    fn key_for(&self, cam: &Camera, sun: Option<[f32; 3]>, night: bool, viewport: (u32, u32)) -> Vec<u32> {
        let mut k: Vec<u32> = Vec::with_capacity(22);
        k.extend(cam.eye.iter().chain(&cam.target).chain(&cam.up).map(|v| v.to_bits()));
        k.push(matches!(cam.projection, Projection::Orthographic) as u32);
        k.push(cam.fov_y.to_bits());
        k.push(cam.ortho_half_height.to_bits());
        k.push(viewport.0);
        k.push(viewport.1);
        match sun {
            Some(s) => k.extend(s.iter().map(|v| v.to_bits())),
            None => k.push(u32::MAX),
        }
        k.push(night as u32);
        k.push(self.scene_gen);
        k
    }

    /// Bindungen zu den aktuellen Puffern (nach Grössen- oder Szenenwechsel neu).
    fn ensure_binds(&mut self, device: &wgpu::Device) {
        let Some(fb) = self.frame_bufs.as_ref() else { return };
        if self.compute_bind.is_none() {
            self.compute_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pathtrace.compute.bind"),
                layout: &self.compute_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: self.nodes.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: self.tris.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: fb.accum.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: fb.aux_a.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 5, resource: fb.aux_b.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 6, resource: self.tri_tex.as_entire_binding() },
                ],
            }));
        }
        // Ergebnis der Pingpong-Kette: prep → filt[0], Durchgang i liest filt[i % 2] und schreibt filt[(i + 1) % 2].
        let last = (ITERATIONS % 2) as usize;
        if self.display_bind.is_none() {
            self.display_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pathtrace.display.bind"),
                layout: &self.display_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: fb.accum.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: fb.filt[last].as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: fb.aux_a.as_entire_binding() },
                ],
            }));
        }
        if self.dn_binds.is_empty() {
            for pass in 0..=ITERATIONS as usize {
                // pass 0 = prep (src unbenutzt), pass i ≥ 1 = atrous Nr. i − 1.
                let (src, dst) = if pass == 0 { (&fb.filt[1], &fb.filt[0]) } else { (&fb.filt[(pass - 1) % 2], &fb.filt[pass % 2]) };
                self.dn_binds.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("pathtrace.denoise.bind"),
                    layout: &self.dn_layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: self.dn_params[pass].as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: fb.accum.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 2, resource: fb.aux_a.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 3, resource: fb.aux_b.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 4, resource: src.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 5, resource: dst.as_entire_binding() },
                    ],
                }));
            }
        }
    }

    /// Entrauscher-Pässe (prep + À-trous) auf die aktuelle Summe.
    fn run_denoise(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        let (w, h) = self.internal;
        for (pass, buf) in self.dn_params.iter().enumerate() {
            let step = if pass == 0 { 0 } else { 1u32 << (pass - 1) };
            let p = DnParams { dims: [w, h, step, 0], k: [SIGMA_L, SIGMA_N, SIGMA_Z, 0.0] };
            queue.write_buffer(buf, 0, bytemuck::bytes_of(&p));
        }
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pathtrace.denoise") });
        for (pass, bind) in self.dn_binds.iter().enumerate() {
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("pathtrace.denoise.pass"), timestamp_writes: None });
            cp.set_pipeline(if pass == 0 { &self.dn_prep } else { &self.dn_atrous });
            cp.set_bind_group(0, bind, &[]);
            cp.dispatch_workgroups(w.div_ceil(8), h.div_ceil(8), 1);
        }
        queue.submit([enc.finish()]);
        self.dn_frame = Some(self.frame);
    }

    /// Rechnet bis zu `batch` Samples dazu und zeigt das Mittel in `target` (Format wie bei `new`). `night` = Sonne
    /// der Studie unter dem Horizont (Nachthimmel statt Standardlicht). Unbrauchbare Kamera oder Grösse: nichts.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        camera: &Camera,
        sun: Option<[f32; 3]>,
        night: bool,
        viewport: (u32, u32),
        batch: u32,
    ) {
        let (w, h) = (viewport.0.max(1), viewport.1.max(1));
        let max_px = self.max_pixels.max(1).min(self.max_binding / 16);
        self.ensure_frame(device, internal_size(w, h, max_px));
        let key = self.key_for(camera, sun, night, (w, h));
        if self.key.as_ref() != Some(&key) {
            self.frame = 0;
            self.dn_frame = None;
            self.key = Some(key);
        }
        let sky = if night { night_sky() } else { sky_for_sun(sun) };
        self.ensure_binds(device);
        let internal = self.internal;
        let (tri_count, srgb) = (self.tri_count, self.srgb_encode);
        let params = |frame: u32, dn: f32| build_params(camera, &sky, internal, (w, h), frame, tri_count, srgb, dn);
        if params(0, 0.0).is_none() || self.tex_bind.is_none() {
            return;
        }
        // Samples: je eines mit eigenem Parameter-Block (Schreiben + Abschicken in Reihenfolge).
        let n = batch.max(1).min(self.max_samples.saturating_sub(self.frame));
        for _ in 0..n {
            let Some(p) = params(self.frame, 0.0) else { return };
            queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&p));
            let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pathtrace.sample") });
            {
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("pathtrace.compute"), timestamp_writes: None });
                pass.set_pipeline(&self.compute);
                pass.set_bind_group(0, self.compute_bind.as_ref(), &[]);
                pass.set_bind_group(1, self.tex_bind.as_ref(), &[]);
                pass.dispatch_workgroups(internal.0.div_ceil(8), internal.1.div_ceil(8), 1);
            }
            queue.submit([enc.finish()]);
            self.frame += 1;
        }
        let dn = self.denoise_weight();
        if dn > 0.0 && self.dn_frame != Some(self.frame) {
            self.run_denoise(device, queue);
        }
        // Anzeige mit der zuletzt gerechneten Sample-Zahl (der Block hält Grössen, Belichtung, Mischgewicht).
        let Some(p) = params(self.frame, dn) else { return };
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&p));
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pathtrace.display") });
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pathtrace.display.pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.display);
            pass.set_bind_group(0, self.display_bind.as_ref(), &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit([enc.finish()]);
    }

    /// Test: gegebene Summen-Puffer (w × h) entrauschen und das gefilterte Licht zurücklesen.
    #[cfg(test)]
    pub(crate) fn denoise_for_test(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, bufs: [&[[f32; 4]]; 3]) -> Vec<[f32; 4]> {
        self.ensure_frame(device, (w, h));
        self.ensure_binds(device);
        let fb = self.frame_bufs.as_ref().unwrap();
        for (b, data) in [&fb.accum, &fb.aux_a, &fb.aux_b].into_iter().zip(bufs) {
            let tmp = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(data), usage: wgpu::BufferUsages::COPY_SRC });
            let mut enc = device.create_command_encoder(&Default::default());
            enc.copy_buffer_to_buffer(&tmp, 0, b, 0, (data.len() * 16) as u64);
            queue.submit([enc.finish()]);
        }
        self.run_denoise(device, queue);
        let fb = self.frame_bufs.as_ref().unwrap();
        let size = (w * h * 16) as u64;
        let read = device.create_buffer(&wgpu::BufferDescriptor { label: None, size, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(&fb.filt[(ITERATIONS % 2) as usize], 0, &read, 0, size);
        queue.submit([enc.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let data = read.slice(..).get_mapped_range();
        bytemuck::cast_slice::<u8, [f32; 4]>(&data).to_vec()
    }
}
