// [212] Pathtracer, wgpu-Seite (Feature `render`): Compute-Pipeline der Pfadverfolgung und Anzeige-Pipeline,
// Puffer für Baum, Dreiecke und Akkumulation. Der `Renderer` (gpu.rs) legt ihn erst an, wenn der Stil
// „Pathtracing (Vorschau)" zum ersten Mal zeichnet; die übrigen Stile berührt er nicht.
//
// Progressiv: jeder `render`-Aufruf rechnet `batch` Samples je Pixel dazu (Web-Viewport: 1 je Bild) und zeigt das
// Mittel. Ändert sich Kamera, Grösse, Sonne oder Szene, beginnt die Summe von vorn. Nach `max_samples` wird nur
// noch angezeigt. Bei grossen Ansichten rechnet er verkleinert (`pathtrace::MAX_PIXELS`).

use wgpu::util::DeviceExt;

use crate::bvh::{Bvh, GpuNode, GpuTri};
use crate::pathtrace::{build_params, internal_size, sky_for_sun, PtParams, MAX_PIXELS, PT_DISPLAY_WGSL, PT_WGSL};
use crate::types::{Camera, Projection};

/// Standard-Obergrenze der Samples je Pixel (danach steht das Bild).
pub const DEFAULT_MAX_SAMPLES: u32 = 1024;

pub struct PathTracer {
    compute: wgpu::ComputePipeline,
    compute_layout: wgpu::BindGroupLayout,
    display: wgpu::RenderPipeline,
    display_layout: wgpu::BindGroupLayout,
    params: wgpu::Buffer,
    nodes: wgpu::Buffer,
    tris: wgpu::Buffer,
    tri_count: u32,
    accum: Option<wgpu::Buffer>,
    internal: (u32, u32),
    compute_bind: Option<wgpu::BindGroup>,
    display_bind: Option<wgpu::BindGroup>,
    /// Zahl der aufsummierten Samples je Pixel.
    frame: u32,
    /// Bild-Schlüssel (Kamera, Grösse, Sonne, Szenen-Nummer) der laufenden Summe.
    key: Option<Vec<u32>>,
    scene_gen: u32,
    pub max_samples: u32,
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

fn uniform_entry(vis: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: vis,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<PtParams>() as u64),
        },
        count: None,
    }
}

impl PathTracer {
    pub fn new(device: &wgpu::Device, color_format: wgpu::TextureFormat) -> Self {
        let cs = wgpu::ShaderStages::COMPUTE;
        let fs = wgpu::ShaderStages::FRAGMENT;
        let compute_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathtrace.compute.layout"),
            entries: &[uniform_entry(cs), storage_entry(1, true, cs), storage_entry(2, true, cs), storage_entry(3, false, cs)],
        });
        let display_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathtrace.display.layout"),
            entries: &[uniform_entry(fs), storage_entry(1, true, fs)],
        });
        let cmod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("pathtrace.wgsl"), source: wgpu::ShaderSource::Wgsl(PT_WGSL.into()) });
        let dmod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("pathtrace.display.wgsl"), source: wgpu::ShaderSource::Wgsl(PT_DISPLAY_WGSL.into()) });
        let clayout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("pathtrace.compute.pl"), bind_group_layouts: &[Some(&compute_layout)], immediate_size: 0 });
        let dlayout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("pathtrace.display.pl"), bind_group_layouts: &[Some(&display_layout)], immediate_size: 0 });
        let compute = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("pathtrace.compute"),
            layout: Some(&clayout),
            module: &cmod,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
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
            size: std::mem::size_of::<PtParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let (nodes, tris) = Self::scene_buffers(device, &Bvh::default());
        Self {
            compute,
            compute_layout,
            display,
            display_layout,
            params,
            nodes,
            tris,
            tri_count: 0,
            accum: None,
            internal: (0, 0),
            compute_bind: None,
            display_bind: None,
            frame: 0,
            key: None,
            scene_gen: 0,
            max_samples: DEFAULT_MAX_SAMPLES,
            srgb_encode: !color_format.is_srgb(),
            max_binding: device.limits().max_storage_buffer_binding_size,
        }
    }

    /// Puffer für Baum und Dreiecke; leer = je ein Platzhalter-Eintrag (Bindungen dürfen nicht leer sein).
    fn scene_buffers(device: &wgpu::Device, bvh: &Bvh) -> (wgpu::Buffer, wgpu::Buffer) {
        let node0 = [GpuNode::default()];
        let tri0 = [GpuTri::default()];
        let nodes: &[GpuNode] = if bvh.nodes.is_empty() { &node0 } else { &bvh.nodes };
        let tris: &[GpuTri] = if bvh.tris.is_empty() { &tri0 } else { &bvh.tris };
        let n = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("pathtrace.nodes"), contents: bytemuck::cast_slice(nodes), usage: wgpu::BufferUsages::STORAGE });
        let t = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("pathtrace.tris"), contents: bytemuck::cast_slice(tris), usage: wgpu::BufferUsages::STORAGE });
        (n, t)
    }

    /// Neue Szene hochladen; die Summe beginnt von vorn. Zu grosse Szenen (über dem Bindungs-Limit des Geräts)
    /// werden leer gezeigt statt die Validierung scheitern zu lassen.
    pub fn set_bvh(&mut self, device: &wgpu::Device, bvh: &Bvh) {
        let too_big = (bvh.tris.len() * std::mem::size_of::<GpuTri>()) as u64 > self.max_binding
            || (bvh.nodes.len() * std::mem::size_of::<GpuNode>()) as u64 > self.max_binding;
        let empty = Bvh::default();
        let use_bvh = if too_big { &empty } else { bvh };
        let (n, t) = Self::scene_buffers(device, use_bvh);
        self.nodes = n;
        self.tris = t;
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

    fn ensure_accum(&mut self, device: &wgpu::Device, size: (u32, u32)) {
        if self.accum.is_some() && self.internal == size {
            return;
        }
        let bytes = (size.0 as u64 * size.1 as u64 * 16).max(16);
        self.accum = Some(device.create_buffer(&wgpu::BufferDescriptor { label: Some("pathtrace.accum"), size: bytes, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false }));
        self.internal = size;
        self.compute_bind = None;
        self.display_bind = None;
        self.key = None;
    }

    fn key_for(&self, cam: &Camera, sun: Option<[f32; 3]>, viewport: (u32, u32)) -> Vec<u32> {
        let mut k: Vec<u32> = Vec::with_capacity(20);
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
        k.push(self.scene_gen);
        k
    }

    /// Rechnet bis zu `batch` Samples dazu und zeigt das Mittel in `target` (Format wie bei `new`).
    /// Unbrauchbare Kamera oder Grösse: nichts (kein Panic).
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        camera: &Camera,
        sun: Option<[f32; 3]>,
        viewport: (u32, u32),
        batch: u32,
    ) {
        let (w, h) = (viewport.0.max(1), viewport.1.max(1));
        let max_px = MAX_PIXELS.min(self.max_binding / 16);
        self.ensure_accum(device, internal_size(w, h, max_px));
        let key = self.key_for(camera, sun, (w, h));
        if self.key.as_ref() != Some(&key) {
            self.frame = 0;
            self.key = Some(key);
        }
        let sky = sky_for_sun(sun);
        let Some(accum) = self.accum.as_ref() else { return };
        if self.compute_bind.is_none() {
            self.compute_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pathtrace.compute.bind"),
                layout: &self.compute_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: self.nodes.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: self.tris.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: accum.as_entire_binding() },
                ],
            }));
        }
        if self.display_bind.is_none() {
            self.display_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pathtrace.display.bind"),
                layout: &self.display_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: accum.as_entire_binding() },
                ],
            }));
        }
        let internal = self.internal;
        let params = |frame: u32| build_params(camera, &sky, internal, (w, h), frame, self.tri_count, self.srgb_encode);
        if params(0).is_none() {
            return;
        }
        // Samples: je eines mit eigenem Parameter-Block (Schreiben + Abschicken in Reihenfolge).
        let n = batch.max(1).min(self.max_samples.saturating_sub(self.frame));
        for _ in 0..n {
            let Some(p) = params(self.frame) else { return };
            queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&p));
            let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pathtrace.sample") });
            {
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("pathtrace.compute"), timestamp_writes: None });
                pass.set_pipeline(&self.compute);
                pass.set_bind_group(0, self.compute_bind.as_ref(), &[]);
                pass.dispatch_workgroups(internal.0.div_ceil(8), internal.1.div_ceil(8), 1);
            }
            queue.submit([enc.finish()]);
            self.frame += 1;
        }
        // Anzeige mit der zuletzt gerechneten Sample-Zahl (der Block hält Grössen und Belichtung).
        let Some(p) = params(self.frame) else { return };
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
}
