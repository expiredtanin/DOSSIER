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
//
// Etappe 4: zweites Textur-Array mit den Detail-Ebenen (Normale/Rauigkeit, `pt_texture.rs`) in derselben Gruppe
// (binding 3); beide Arrays mit Mip-Stufen, der Shader wählt die Stufe nach Strahlkegel.
//
// Etappe 5: Lichtliste (`pt_lights.rs`, binding 7: Portale, Leuchten, Raumlicht) mit dem Baum hochgeladen;
// Belichtungsautomatik (`exposure.rs`) als kleiner Compute-Pass vor der Anzeige, Ergebnis in einem 16-Byte-Puffer, den
// die Anzeige liest (Viewport sanft nachgeführt, Stapel > 1 sofort); Zeitstempel je Abschnitt (Samples, Entrauscher,
// Belichtung + Anzeige), wenn das Gerät `TIMESTAMP_QUERY` kann und `timing` an ist (Messung, `render_png --timing`).

#[cfg(test)]
use wgpu::util::DeviceExt;

use crate::bvh::{Bvh, GpuTri, GpuTriTex, GpuWideNode};
use crate::denoise::{blend_weight, DN_WGSL, ITERATIONS, SIGMA_L, SIGMA_N, SIGMA_Z};
use crate::exposure::EXPOSE_WGSL;
use crate::pathtrace::{build_params_with, internal_size, night_sky, sky_for_sun, PtOptions, PtParams, AUTO_EXPOSURE_RATE, MAX_PIXELS, PT_DISPLAY_WGSL, PT_WGSL};
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

/// Zeitstempel der Abschnitte eines `render` (GPU, ms): Samples, Entrauscher, Belichtung + Anzeige.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PtTimings {
    pub samples_ms: f64,
    pub denoise_ms: f64,
    pub display_ms: f64,
}

struct Timing {
    set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    read: wgpu::Buffer,
    period_ns: f32,
}

/// Zeitstempel-Plätze: Samples (Anfang, Ende), Entrauscher, Belichtung + Anzeige.
const TS_COUNT: u32 = 6;

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
    /// Etappe 5: Lichtgruppen und Lichter (ein Puffer, `LightList::gpu_records`), Zahl der Gruppen je Art
    /// (Parameter-Block) und der Lichter je Art (Diagnose).
    lights: wgpu::Buffer,
    light_counts: [u32; 3],
    cluster_counts: [u32; 3],
    expose: wgpu::ComputePipeline,
    expose_layout: wgpu::BindGroupLayout,
    expose_bind: Option<wgpu::BindGroup>,
    /// Belichtung der Automatik (x aktuell, y gültig, z Ziel, w Mittel log2).
    expo: wgpu::Buffer,
    timing: Option<Timing>,
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
    /// Etappe 5: Fenster als Lichtportale, Raumlicht bei Nacht, Belichtungskorrektur (EV), Automatik, Abpraller,
    /// Bildkarten aus (Messung). Ändern beginnt die Summe von vorn (ausser EV/Automatik: nur Anzeige).
    pub options: PtOptions,
    /// Belichtungsautomatik an (Rate je Bild `AUTO_EXPOSURE_RATE`, Stapel > 1 sofort).
    pub auto_exposure: bool,
    srgb_encode: bool,
    /// Grösster Speicher-Puffer (kleinere von Puffer- und Bindungsgrenze des Geräts).
    max_binding: u64,
    /// Letzte Szene überschritt die Grenzen (leer gezeigt).
    too_big: bool,
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
                storage_entry(7, true, cs),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: cs,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let display_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathtrace.display.layout"),
            entries: &[uniform_entry(fs, psize), storage_entry(1, true, fs), storage_entry(2, true, fs), storage_entry(3, true, fs), storage_entry(4, true, fs)],
        });
        let expose_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathtrace.expose.layout"),
            entries: &[uniform_entry(cs, psize), storage_entry(1, true, cs), storage_entry(2, false, cs)],
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
        let emod = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("pathtrace.expose.wgsl"), source: wgpu::ShaderSource::Wgsl(EXPOSE_WGSL.into()) });
        let elayout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("pathtrace.expose.pl"), bind_group_layouts: &[Some(&expose_layout)], immediate_size: 0 });
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
        let expose = compute_pipe("pathtrace.expose", &elayout, &emod, "expose");
        let expo = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pathtrace.expo"),
            size: 16,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let lights = Self::storage_with(device, None, "pathtrace.lights", &[]);
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
        let (nodes, tris, tri_tex) = Self::scene_buffers(device, None, &Bvh::default());
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
            lights,
            light_counts: [0; 3],
            cluster_counts: [0; 3],
            expose,
            expose_layout,
            expose_bind: None,
            expo,
            timing: None,
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
            options: PtOptions::default(),
            auto_exposure: true,
            srgb_encode: !color_format.is_srgb(),
            max_binding: device.limits().max_storage_buffer_binding_size.min(device.limits().max_buffer_size),
            too_big: false,
        }
    }

    /// Speicher-Puffer mit Inhalt, OHNE `mapped_at_creation` (Etappe 5): im Browser wirft `createBuffer` mit
    /// `mappedAtCreation` synchron, wenn der Puffer nicht angelegt werden kann (Grenze, Speicher), und wgpu macht daraus
    /// einen Panic, der das ganze WASM-Modul lahmlegt (SwiftShader, Musterhaus komplex). Leer angelegt und per
    /// `write_buffer` gefüllt landen Fehler höchstens als Validierungsmeldung; die Grösse prüft `fits` vorher.
    /// Ohne `queue` (beim Anlegen) bleibt er genullt.
    fn storage_with(device: &wgpu::Device, queue: Option<&wgpu::Queue>, label: &str, bytes: &[u8]) -> wgpu::Buffer {
        let size = (bytes.len() as u64).max(64).next_multiple_of(wgpu::COPY_BUFFER_ALIGNMENT);
        let buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        if let Some(q) = queue {
            if !bytes.is_empty() {
                let mut data = bytes.to_vec();
                data.resize(bytes.len().next_multiple_of(wgpu::COPY_BUFFER_ALIGNMENT as usize), 0);
                q.write_buffer(&buf, 0, &data);
            }
        }
        buf
    }

    /// Passt ein Speicher-Puffer dieser Grösse in die Grenzen des Geräts (Puffer- und Bindungsgrösse)?
    pub fn fits(&self, bytes: u64) -> bool {
        bytes <= self.max_binding
    }

    /// Szene war zu gross für das Gerät (Pathtracer zeigt nur den Himmel; der Viewport meldet es).
    pub fn scene_too_big(&self) -> bool {
        self.too_big
    }

    /// Test: Grenzen des Geräts künstlich verkleinern (Puffer = Bindung = `bytes`).
    #[cfg(test)]
    pub(crate) fn limit_for_test(&mut self, bytes: u64) {
        self.max_binding = bytes;
    }

    /// Puffer für Baum, Dreiecke und Texturdaten; leer = je ein Platzhalter-Eintrag (Bindungen dürfen nicht leer sein).
    /// Texturdaten in anderer Länge als die Dreiecke (kein Fall des Baums) werden mit „ohne Textur“ aufgefüllt.
    fn scene_buffers(device: &wgpu::Device, queue: Option<&wgpu::Queue>, bvh: &Bvh) -> (wgpu::Buffer, wgpu::Buffer, wgpu::Buffer) {
        let wide = bvh.wide_nodes();
        let node0 = [GpuWideNode::default()];
        let tri0 = [GpuTri::default()];
        let nodes: &[GpuWideNode] = if wide.is_empty() { &node0 } else { &wide };
        let tris: &[GpuTri] = if bvh.tris.is_empty() { &tri0 } else { &bvh.tris };
        let mut tex: Vec<GpuTriTex> = bvh.tex.iter().copied().take(tris.len()).collect();
        tex.resize(tris.len(), GpuTriTex { scale: 1.0, ..GpuTriTex::default() });
        let n = Self::storage_with(device, queue, "pathtrace.nodes", bytemuck::cast_slice(nodes));
        let t = Self::storage_with(device, queue, "pathtrace.tris", bytemuck::cast_slice(tris));
        let x = Self::storage_with(device, queue, "pathtrace.tri_tex", bytemuck::cast_slice(&tex));
        (n, t, x)
    }


    /// Zeitstempel je Abschnitt an/aus (nur wenn das Gerät `TIMESTAMP_QUERY` kann; sonst bleibt es aus). Rückgabe: an?
    pub fn set_timing(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, on: bool) -> bool {
        if !on || !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            self.timing = None;
            return false;
        }
        if self.timing.is_none() {
            let size = TS_COUNT as u64 * 8;
            self.timing = Some(Timing {
                set: device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("pathtrace.timestamps"), ty: wgpu::QueryType::Timestamp, count: TS_COUNT }),
                resolve: device.create_buffer(&wgpu::BufferDescriptor { label: None, size, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false }),
                read: device.create_buffer(&wgpu::BufferDescriptor { label: None, size, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false }),
                period_ns: queue.get_timestamp_period(),
            });
        }
        true
    }

    /// Zeitstempel des letzten `render` lesen (wartet auf die GPU; nur für Messungen). None ohne `set_timing`.
    pub fn read_timings(&self, device: &wgpu::Device) -> Option<PtTimings> {
        let t = self.timing.as_ref()?;
        let slice = t.read.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let ts: Vec<u64> = bytemuck::cast_slice::<u8, u64>(&slice.get_mapped_range()).to_vec();
        t.read.unmap();
        let ms = |a: usize| if ts[a + 1] > ts[a] { (ts[a + 1] - ts[a]) as f64 * t.period_ns as f64 / 1e6 } else { 0.0 };
        Some(PtTimings { samples_ms: ms(0), denoise_ms: ms(2), display_ms: ms(4) })
    }

    /// Belichtung der Automatik lesen (wartet auf die GPU; Tests, Messung): (aktuell, gültig, Ziel, Mittel log2).
    pub fn read_exposure(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> [f32; 4] {
        let read = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(&self.expo, 0, &read, 0, 16);
        queue.submit([enc.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let v = bytemuck::cast_slice::<u8, f32>(&read.slice(..).get_mapped_range()).to_vec();
        [v[0], v[1], v[2], v[3]]
    }

    /// Zahl der Lichter je Art (Portale, Leuchten, Raumlicht).
    pub fn light_counts(&self) -> [u32; 3] {
        self.light_counts
    }

    /// Bildkarten für den Pfad: Textur-Array (D2Array, wie `Renderer::set_material_textures`), Detail-Array (Normale/
    /// Rauigkeit, gleiche Ebenen-Nummern; Etappe 4), Sampler mit Wiederholung und je Ebene der Kehrwert der mittleren
    /// Kartenfarbe (`PtMaterialTable::inv_means`, Index = Ebene). Die Summe beginnt von vorn.
    #[allow(clippy::too_many_arguments)]
    pub fn set_textures(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, view: &wgpu::TextureView, detail: &wgpu::TextureView, sampler: &wgpu::Sampler, inv_means: &[[f32; 4]]) {
        let one = [[1.0f32; 4]];
        let inv: &[[f32; 4]] = if inv_means.is_empty() || !self.fits((inv_means.len() * 16) as u64) { &one } else { inv_means };
        let buf = Self::storage_with(device, Some(queue), "pathtrace.layer_inv", bytemuck::cast_slice(inv));
        self.tex_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pathtrace.textures.bind"),
            layout: &self.tex_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(detail) },
            ],
        }));
        self.scene_gen = self.scene_gen.wrapping_add(1);
        self.key = None;
    }

    /// Neue Szene hochladen; die Summe beginnt von vorn. Zu grosse Szenen (ein Puffer über der Puffer- oder
    /// Bindungsgrenze des Geräts) werden leer gezeigt (`scene_too_big`) statt die Validierung scheitern zu lassen
    /// oder — im Browser — einen Panic auszulösen.
    pub fn set_bvh(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, bvh: &Bvh) {
        let sizes = [
            bvh.tris.len() * std::mem::size_of::<GpuTri>(),
            bvh.nodes.len() / 2 * std::mem::size_of::<GpuWideNode>(),
            bvh.tris.len() * std::mem::size_of::<GpuTriTex>(),
            (bvh.lights.lights.len() + bvh.lights.clusters.len()) * std::mem::size_of::<crate::pt_lights::GpuLight>(),
        ];
        let too_big = sizes.iter().any(|&b| !self.fits(b as u64));
        self.too_big = too_big;
        let empty = Bvh::default();
        let use_bvh = if too_big { &empty } else { bvh };
        let (n, t, x) = Self::scene_buffers(device, Some(queue), use_bvh);
        self.nodes = n;
        self.tris = t;
        self.tri_tex = x;
        self.tri_count = use_bvh.tris.len() as u32;
        self.lights = Self::storage_with(device, Some(queue), "pathtrace.lights", bytemuck::cast_slice(&use_bvh.lights.gpu_records()));
        self.light_counts = use_bvh.lights.counts;
        self.cluster_counts = use_bvh.lights.cluster_counts;
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
        self.expose_bind = None;
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
        let o = &self.options;
        k.extend([o.portals as u32, o.room_light as u32, o.bounces, o.no_tex as u32]);
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
                    wgpu::BindGroupEntry { binding: 7, resource: self.lights.as_entire_binding() },
                ],
            }));
        }
        if self.expose_bind.is_none() {
            self.expose_bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pathtrace.expose.bind"),
                layout: &self.expose_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: fb.accum.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: self.expo.as_entire_binding() },
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
                    wgpu::BindGroupEntry { binding: 4, resource: self.expo.as_entire_binding() },
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
        let last = self.dn_binds.len().saturating_sub(1);
        for (pass, bind) in self.dn_binds.iter().enumerate() {
            let ts = self.timing.as_ref().filter(|_| pass == 0 || pass == last).map(|t| wgpu::ComputePassTimestampWrites {
                query_set: &t.set,
                beginning_of_pass_write_index: (pass == 0).then_some(2),
                end_of_pass_write_index: (pass == last).then_some(3),
            });
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("pathtrace.denoise.pass"), timestamp_writes: ts });
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
        // Belichtung: Automatik im Viewport sanft (je Bild), bei mehreren Samples auf einmal (Export, headless) sofort.
        let opt = PtOptions {
            light_counts: self.cluster_counts,
            auto_exposure: if !self.auto_exposure { 0.0 } else if batch > 1 { 1.0 } else { AUTO_EXPOSURE_RATE },
            ..self.options
        };
        let params = |frame: u32, dn: f32| build_params_with(camera, &sky, internal, (w, h), frame, tri_count, srgb, dn, &opt);
        if params(0, 0.0).is_none() || self.tex_bind.is_none() {
            return;
        }
        // Samples: je eines mit eigenem Parameter-Block (Schreiben + Abschicken in Reihenfolge).
        let n = batch.max(1).min(self.max_samples.saturating_sub(self.frame));
        for s in 0..n {
            let Some(p) = params(self.frame, 0.0) else { return };
            queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&p));
            let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pathtrace.sample") });
            {
                let ts = self.timing.as_ref().filter(|_| s == 0 || s + 1 == n).map(|t| wgpu::ComputePassTimestampWrites {
                    query_set: &t.set,
                    beginning_of_pass_write_index: (s == 0).then_some(0),
                    end_of_pass_write_index: (s + 1 == n).then_some(1),
                });
                let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("pathtrace.compute"), timestamp_writes: ts });
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
        // Belichtungsautomatik (eine Arbeitsgruppe) vor der Anzeige.
        if self.auto_exposure && self.frame > 0 {
            let ts = self.timing.as_ref().map(|t| wgpu::ComputePassTimestampWrites { query_set: &t.set, beginning_of_pass_write_index: Some(4), end_of_pass_write_index: None });
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("pathtrace.expose"), timestamp_writes: ts });
            cp.set_pipeline(&self.expose);
            cp.set_bind_group(0, self.expose_bind.as_ref(), &[]);
            cp.dispatch_workgroups(1, 1, 1);
        }
        {
            let ts = self.timing.as_ref().map(|t| wgpu::RenderPassTimestampWrites {
                query_set: &t.set,
                beginning_of_pass_write_index: (!self.auto_exposure || self.frame == 0).then_some(4),
                end_of_pass_write_index: Some(5),
            });
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pathtrace.display.pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: ts,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.display);
            pass.set_bind_group(0, self.display_bind.as_ref(), &[]);
            pass.draw(0..3, 0..1);
        }
        if let Some(t) = &self.timing {
            enc.resolve_query_set(&t.set, 0..TS_COUNT, &t.resolve, 0);
            enc.copy_buffer_to_buffer(&t.resolve, 0, &t.read, 0, TS_COUNT as u64 * 8);
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

#[cfg(test)]
impl PathTracer {
    /// Test: Akkumulation und Hilfspuffer A (Albedo, Luminanz²) der laufenden Summe zurücklesen.
    pub(crate) fn read_sums(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> (Vec<[f32; 4]>, Vec<[f32; 4]>) {
        let fb = self.frame_bufs.as_ref().unwrap();
        let size = self.internal.0 as u64 * self.internal.1 as u64 * 16;
        let read = |b: &wgpu::Buffer| {
            let r = device.create_buffer(&wgpu::BufferDescriptor { label: None, size, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
            let mut enc = device.create_command_encoder(&Default::default());
            enc.copy_buffer_to_buffer(b, 0, &r, 0, size);
            queue.submit([enc.finish()]);
            r.slice(..).map_async(wgpu::MapMode::Read, |_| {});
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            let v = bytemuck::cast_slice::<u8, [f32; 4]>(&r.slice(..).get_mapped_range()).to_vec();
            v
        };
        (read(&fb.accum), read(&fb.aux_a))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Camera;

    fn device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()?;
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()
    }

    /// Pathtracer mit 1×1-Platzhalter-Texturen (keine Bildkarten).
    fn tracer(device: &wgpu::Device, queue: &wgpu::Queue) -> PathTracer {
        let mut pt = PathTracer::new(device, wgpu::TextureFormat::Rgba8UnormSrgb);
        let tex = |fmt| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: fmt,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };
        let a = tex(wgpu::TextureFormat::Rgba8UnormSrgb);
        let b = tex(wgpu::TextureFormat::Rgba8Unorm);
        let view = |t: &wgpu::Texture| t.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
        let sampler = device.create_sampler(&Default::default());
        pt.set_textures(device, queue, &view(&a), &view(&b), &sampler, &[]);
        pt.denoise = false;
        pt
    }

    fn target(device: &wgpu::Device, w: u32, h: u32) -> wgpu::TextureView {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&Default::default())
    }

    /// Mittel und mittlere Varianz je Pixel (aus Summe und Luminanz²-Summe) der Luminanz über das Bild.
    fn stats(acc: &[[f32; 4]], aux: &[[f32; 4]]) -> (f64, f64) {
        let (mut mean, mut var) = (0.0f64, 0.0f64);
        for (a, x) in acc.iter().zip(aux) {
            let n = a[3].max(1.0) as f64;
            let m = (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) as f64 / n;
            mean += m;
            var += (x[3] as f64 / n - m * m).max(0.0);
        }
        (mean / acc.len() as f64, var / acc.len() as f64)
    }

    const CAM: Camera = Camera {
        eye: [3.6, 1.5, 3.7],
        target: [1.0, 0.6, 0.5],
        up: [0.0, 1.0, 0.0],
        projection: crate::types::Projection::Perspective,
        fov_y: 1.0,
        ortho_half_height: 5.0,
        near: 0.05,
        far: 1000.0,
    };

    /// [212] Etappe 5: Fenster als Lichtportale — im geschlossenen Raum mit einem Fenster (bedeckter Himmel, keine Sonne)
    /// bleibt der Erwartungswert gleich wie ohne Portale (MIS erwartungstreu), die Varianz je Pixel sinkt deutlich.
    #[test]
    fn portal_nee_erwartungswert_gleich_varianz_kleiner() {
        let Some((device, queue)) = device() else {
            eprintln!("kein GPU-Adapter: Test übersprungen");
            return;
        };
        let bvh = Bvh::build(&crate::pt_lights::tests::room());
        assert_eq!(bvh.lights.counts[0], 2);
        let (w, h) = (48u32, 32u32);
        let view = target(&device, w, h);
        let run = |portals: bool, spp: u32| {
            let mut pt = tracer(&device, &queue);
            pt.set_bvh(&device, &queue, &bvh);
            pt.options.portals = portals;
            pt.options.cam_inside = bvh.encloses(CAM.eye);
            assert!(pt.options.cam_inside, "Kamera im Raum");
            // Viele Abpraller: die Abschneidung des Pfades (die NEE der letzten Ecke reicht ein Segment weiter) fällt
            // nicht ins Gewicht.
            pt.options.bounces = 16;
            pt.max_samples = spp;
            pt.render(&device, &queue, &view, &CAM, None, false, (w, h), spp);
            let (acc, aux) = pt.read_sums(&device, &queue);
            assert_eq!(pt.samples(), spp);
            stats(&acc, &aux)
        };
        let (m_off, v_off) = run(false, 1024);
        let (m_on, v_on) = run(true, 1024);
        eprintln!("ohne Portale: Mittel {m_off:.5}, Varianz {v_off:.6}; mit: Mittel {m_on:.5}, Varianz {v_on:.6}");
        assert!(m_off > 0.0 && m_on > 0.0);
        assert!((m_on - m_off).abs() / m_off < 0.01, "Erwartungswert: {m_on} vs {m_off}");
        assert!(v_on < v_off * 0.5, "Varianz: {v_on} vs {v_off}");
        // Kamera draussen, Blick durchs Fenster: Portale erst nach dem Durchgang (gerade/ungerade Zahl gekreuzter Portale);
        // Erwartungswert ebenso gleich.
        let outside = Camera { eye: [2.0, 1.4, -2.5], target: [2.0, 1.0, 2.0], ..CAM };
        let run_out = |portals: bool| {
            let mut pt = tracer(&device, &queue);
            pt.set_bvh(&device, &queue, &bvh);
            pt.options.portals = portals;
            pt.options.bounces = 16;
            pt.options.cam_inside = bvh.encloses(outside.eye);
            pt.max_samples = 512;
            pt.render(&device, &queue, &view, &outside, None, false, (w, h), 512);
            let (acc, aux) = pt.read_sums(&device, &queue);
            stats(&acc, &aux)
        };
        let (mo_off, vo_off) = run_out(false);
        let (mo_on, vo_on) = run_out(true);
        eprintln!("draussen ohne Portale: Mittel {mo_off:.5}, Varianz {vo_off:.6}; mit: Mittel {mo_on:.5}, Varianz {vo_on:.6}");
        assert!((mo_on - mo_off).abs() / mo_off < 0.01, "Erwartungswert draussen: {mo_on} vs {mo_off}");
        assert!(vo_on <= vo_off * 1.02, "Varianz draussen: {vo_on} vs {vo_off}");
    }

    /// [212] Etappe 5: Belichtungsautomatik auf der GPU wie die CPU-Referenz (`exposure::measure`), Stapel > 1 stellt
    /// sofort ein; Innenraum bekommt mehr Belichtung als der Himmel allein.
    #[test]
    fn belichtung_wie_referenz() {
        let Some((device, queue)) = device() else {
            eprintln!("kein GPU-Adapter: Test übersprungen");
            return;
        };
        let bvh = Bvh::build(&crate::pt_lights::tests::room());
        let (w, h) = (48u32, 32u32);
        let view = target(&device, w, h);
        let mut pt = tracer(&device, &queue);
        pt.set_bvh(&device, &queue, &bvh);
        pt.max_samples = 8;
        pt.render(&device, &queue, &view, &CAM, None, false, (w, h), 8);
        let e = pt.read_exposure(&device, &queue);
        let (acc, _) = pt.read_sums(&device, &queue);
        let sky = sky_for_sun(None);
        let lo = sky.exposure * crate::pathtrace::AUTO_EXPOSURE_MIN;
        let hi = sky.exposure * crate::pathtrace::AUTO_EXPOSURE_MAX_DAY;
        let (tgt, m) = crate::exposure::measure(&acc, w, h, lo, hi);
        assert_eq!(e[1], 1.0, "gültig");
        assert!((e[3] - m).abs() < 1e-3, "Mittel log2 {} vs {m}", e[3]);
        assert!((e[2] - tgt).abs() / tgt < 1e-3 && (e[0] - tgt).abs() / tgt < 1e-3, "{e:?} vs {tgt}");
        assert!(e[0] > sky.exposure, "Innenraum heller belichtet: {}", e[0]);
        // Viewport (Stapel 1): sanft, nur ein Teil des Weges zu einem neuen Ziel.
        let far = Camera { eye: [3.6, 1.5, 3.7], target: [2.0, 1.4, -1.0], ..CAM };
        pt.max_samples = 16;
        pt.render(&device, &queue, &view, &far, None, false, (w, h), 1);
        let e2 = pt.read_exposure(&device, &queue);
        assert!((e2[0] - e2[2]).abs() > 1e-4 || (e2[2] - e[0]).abs() < 1e-4, "{e2:?}");
    }

    /// Browser-Befund (SwiftShader): zu grosse Puffer dürfen den Pathtracer nicht abstürzen lassen. Mit künstlich
    /// kleinen Grenzen bleibt die Szene leer (gemeldet), die Summe rechnet verkleinert — ohne Validierungsfehler
    /// (die native wgpu-Schicht würde darauf mit Panic reagieren).
    #[test]
    fn kleine_grenzen_ohne_panic() {
        let Some((device, queue)) = device() else {
            eprintln!("kein GPU-Adapter: Test übersprungen");
            return;
        };
        let bvh = Bvh::build(&crate::pt_lights::tests::room());
        let mut pt = tracer(&device, &queue);
        pt.limit_for_test(1024);
        pt.set_bvh(&device, &queue, &bvh);
        assert!(pt.scene_too_big());
        assert_eq!(pt.tri_count(), 0);
        let view = target(&device, 64, 48);
        pt.render(&device, &queue, &view, &CAM, None, false, (64, 48), 2);
        let (iw, ih) = pt.internal_size();
        assert!((iw as u64 * ih as u64 * 16) <= 1024, "{iw}x{ih}");
        assert_eq!(pt.samples(), 2);
        // Grenze wieder gross: Szene da, Meldung weg.
        pt.limit_for_test(1 << 26);
        pt.set_bvh(&device, &queue, &bvh);
        assert!(!pt.scene_too_big() && pt.tri_count() > 0);
        pt.render(&device, &queue, &view, &CAM, None, false, (64, 48), 1);
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
    }
}
