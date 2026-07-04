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

use crate::edges::{build_mesh_edges, EDGE_FLOATS_PER_VERTEX};
use crate::grid::{build_ground_grid, GRID_FLOATS_PER_VERTEX};
use crate::math::{view_projection, Mat4};
use crate::mesh::{build_scene_mesh, build_walls_mesh};
use crate::section::SectionPlane;
use crate::section_fill::{build_cut_caps, CAP_FLOATS_PER_VERTEX};
use crate::shaders::{CAP_WGSL, GRID_WGSL, MESH_WGSL};
use crate::types::{Camera, Mesh, MeshInput, SlabInput, WallInput, FLOATS_PER_VERTEX};

/// Darstellungsart des 3D-Renderers (Oberleiste: shaded/white/textured/
/// wireframe/hidden). Bestimmt, welche Pipelines je Frame gezeichnet werden und
/// welchen `mode.x`-Wert der Mesh-Shader bekommt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderStyle {
    /// Beleuchtete Bauteilfarben (Default).
    Shaded,
    /// Clay-Look: einheitlich helles Material, beleuchtet.
    White,
    /// Mangels Textur-Pipeline VORERST identisch zu `Shaded` behandelt (kein Fake).
    Textured,
    /// Nur Modell-Kanten (Feature-Edges), keine gefuellten Flaechen.
    Wireframe,
    /// Hidden-Line: flach-weisse Flaechen (fuellen den Depth-Buffer) + dunkle
    /// Kanten obenauf, tiefengetestet -> nur sichtbare Kanten erscheinen.
    Hidden,
}

impl RenderStyle {
    /// Parst den API-String; unbekannte Werte fallen auf `Shaded` zurueck.
    pub fn from_str_or_shaded(s: &str) -> Self {
        match s {
            "white" => RenderStyle::White,
            "textured" => RenderStyle::Textured,
            "wireframe" => RenderStyle::Wireframe,
            "hidden" => RenderStyle::Hidden,
            _ => RenderStyle::Shaded,
        }
    }

    /// `mode.x`-Wert fuer den Mesh-Shader (siehe shaders.rs): 0 = Material/shaded
    /// (auch textured), 1 = weiss/Clay, 2 = flach-weisse Hidden-Line-Flaechen.
    fn mesh_mode(self) -> f32 {
        match self {
            RenderStyle::White => 1.0,
            RenderStyle::Hidden => 2.0,
            // Shaded, Textured, Wireframe (Flaechen werden bei Wireframe eh nicht
            // gezeichnet) -> Material.
            _ => 0.0,
        }
    }

    /// Werden in diesem Stil gefuellte Flaechen gezeichnet?
    fn draws_faces(self) -> bool {
        !matches!(self, RenderStyle::Wireframe)
    }

    /// Werden in diesem Stil Modell-Kanten gezeichnet?
    fn draws_edges(self) -> bool {
        matches!(self, RenderStyle::Wireframe | RenderStyle::Hidden)
    }
}

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
    /// x = Darstellungsart (0 = shaded/Material, 1 = weiss/Clay, 2 = hidden);
    /// y = Live-Schnitt aktiv (0/1). Siehe shaders.rs.
    mode: [f32; 4],
    /// Live-Schnittebene: xyz = Ebenennormale (= Blickrichtung, normiert),
    /// w = -dot(normal, point). Ein Fragment mit `dot(world, xyz) + w > 0` liegt
    /// hinter der Ebene und wird (bei aktivem Schnitt, mode.y > 0.5) verworfen.
    section_plane: [f32; 4],
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
            // Default: kein Schnitt (mode.y = 0). Neutrale Ebene.
            section_plane: [0.0, 0.0, 1.0, 0.0],
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

/// GPU-seitiger Vertex-Buffer einer LineList (kein Indexpuffer). Format
/// [pos vec3, color vec3] — genutzt fuer das Bodengitter UND die Modell-Kanten
/// (identisches Layout/Shader, siehe grid.rs / edges.rs).
struct LineBuffers {
    vbo: wgpu::Buffer,
    vertex_count: u32,
}

/// GPU-seitiger Vertex-Buffer der Schnittflaechen-Kappen (Cut-Caps, TriangleList,
/// kein Indexpuffer). Format `[pos vec3, uv vec2]` (`CAP_FLOATS_PER_VERTEX`) —
/// die (u,v)-Ebenenkoordinaten treiben die prozedurale Schraffur (CAP_WGSL).
struct CapBuffers {
    vbo: wgpu::Buffer,
    vertex_count: u32,
}

/// Der native 3D-Renderer: haelt die Pipeline, das Uniform (View-Projektion +
/// Licht) und das aktuell hochgeladene Mesh. Ein Tiefenpuffer wird passend zur
/// Ziel-Groesse (neu) angelegt.
pub struct Renderer {
    pipeline: wgpu::RenderPipeline,
    /// Wie `pipeline`, aber mit positivem Depth-Bias (Flaechen leicht nach hinten
    /// geschoben). Nur fuer den Hidden-Line-Stil: so gewinnen die danach an ihrer
    /// wahren Tiefe gezeichneten Kanten den Less-Test und liegen sauber obenauf,
    /// waehrend verdeckte Kanten weiterhin weggeschnitten werden (kein Z-Fighting).
    hidden_face_pipeline: wgpu::RenderPipeline,
    /// Eigene, schlanke Linien-Pipeline (LineList, unlit) fuer das Bodengitter
    /// UND die Modell-Kanten (wireframe/hidden — identisches Layout/Shader).
    /// Teilt sich das `Globals`-Uniform/Bind-Group (nur View-Projektion) mit der
    /// Mesh-Pipeline und rendert in denselben Pass/Tiefenpuffer.
    grid_pipeline: wgpu::RenderPipeline,
    /// Wie `grid_pipeline` (LineList, GRID_WGSL), aber OHNE Tiefentest
    /// (`depth_compare: Always`, kein Depth-Write): die Auswahl-Highlight-Linien
    /// liegen immer sichtbar obenauf und scheinen auch hinter Waenden durch.
    highlight_pipeline: wgpu::RenderPipeline,
    /// Schnittflaechen-Kappen (TriangleList, CAP_WGSL, eigenes Vertex-Layout
    /// [pos vec3, uv vec2]). Teilt sich die `Globals`-Bind-Group; leichter
    /// Depth-Bias zur Kamera hin gegen Z-Fighting mit den an der Ebene
    /// per-`discard` gekappten Wandflaechen. Backface-Culling AUS (CullMode::None).
    cap_pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    mesh: Option<MeshBuffers>,
    /// Modell-Kanten (Feature-Edges, edges.rs) als LineList. Einmalig bei
    /// `set_model`/`upload_*` erzeugt und gecacht (nicht je Frame). Gezeichnet in
    /// den Stilen wireframe/hidden.
    edges: Option<LineBuffers>,
    /// Bodengitter-Vertices (None = nicht erzeugt). Wird nur gezeichnet, wenn
    /// zusaetzlich `grid_visible` gesetzt ist.
    grid: Option<LineBuffers>,
    /// Auswahl-Highlight-Linien (Kanten des selektierten Bauteils, LineList) als
    /// LineBuffers. None = keine Auswahl -> nichts wird gezeichnet. Ueber
    /// `set_highlight_lines` gesetzt/geloescht; im Render-Pass als ALLERLETZTES
    /// (ohne Tiefentest) gezeichnet.
    highlight: Option<LineBuffers>,
    /// Schnittflaechen-Kappen (Cut-Caps) des Live-Schnitts. None = kein Schnitt
    /// aktiv / keine Schnittgeometrie. Ueber `set_cut_caps` gesetzt/geloescht,
    /// gezeichnet NACH den Flaechen, VOR Kanten/Grid/Highlight.
    caps: Option<CapBuffers>,
    /// Ob das Bodengitter im naechsten `render` gezeichnet wird. Default false —
    /// bestehende Aufrufer ohne `set_ground_grid` bekommen KEIN Gitter.
    grid_visible: bool,
    /// Aktuelle Darstellungsart (Default `Shaded`). Einzige Quelle der Wahrheit;
    /// `set_white_mode` bildet auf `Shaded`/`White` ab.
    style: RenderStyle,
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

        // Mesh-Pipeline-Fabrik: identische Beschreibung fuer die Standard-Flaechen
        // (kein Bias) und die Hidden-Line-Flaechen (positiver Depth-Bias, damit die
        // spaeter gezeichneten Kanten obenauf liegen). Nur `bias` unterscheidet sich.
        let make_mesh_pipeline = |label: &str, bias: wgpu::DepthBiasState| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs_main"),
                    buffers: &[vertex_layout.clone()],
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
                    bias,
                }),
                multisample: wgpu::MultisampleState {
                    count: SAMPLE_COUNT,
                    mask: !0,
                    alpha_to_coverage_enabled: false,
                },
                multiview_mask: None,
                cache: None,
            })
        };
        let pipeline = make_mesh_pipeline("mesh.pipeline", wgpu::DepthBiasState::default());
        // Hidden-Line-Flaechen leicht nach hinten schieben (Depth-Bias auf
        // Dreiecke wirkt zuverlaessig — anders als bei Linien), damit die Kanten
        // an ihrer wahren Tiefe den Less-Test gewinnen.
        let hidden_face_pipeline = make_mesh_pipeline(
            "mesh.hidden.pipeline",
            wgpu::DepthBiasState {
                constant: 4,
                slope_scale: 1.0,
                clamp: 0.0,
            },
        );

        // Bodengitter-Pipeline: dieselbe Bind-Group (Globals/View-Projektion) und
        // dasselbe Depth-/MSAA-/Farbziel wie die Mesh-Pipeline, aber LineList-
        // Topologie, ein eigener unlit-Shader (konstante Vertexfarbe) und ein
        // schlankeres Vertex-Layout [pos vec3, color vec3].
        let grid_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("grid.wgsl"),
            source: wgpu::ShaderSource::Wgsl(GRID_WGSL.into()),
        });
        let grid_vertex_layout = wgpu::VertexBufferLayout {
            array_stride: (GRID_FLOATS_PER_VERTEX * 4) as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3],
        };
        // Linien-Pipeline-Fabrik: identische Beschreibung (LineList, GRID_WGSL,
        // gemeinsame Bind-Group/Farbziel/MSAA) fuer das Bodengitter/die Kanten
        // (tiefengetestet) UND die Auswahl-Highlight-Linien (ohne Tiefentest, siehe
        // unten). Nur der `depth_stencil`-Zustand unterscheidet sich.
        let make_line_pipeline = |label: &str, depth: wgpu::DepthStencilState| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &grid_module,
                    entry_point: Some("vs_main"),
                    buffers: &[grid_vertex_layout.clone()],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &grid_module,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: color_format,
                        blend: Some(wgpu::BlendState::REPLACE),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::LineList,
                    // Linien haben keine Vorder-/Rueckseite -> kein Culling.
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: Some(depth),
                multisample: wgpu::MultisampleState {
                    count: SAMPLE_COUNT,
                    mask: !0,
                    alpha_to_coverage_enabled: false,
                },
                multiview_mask: None,
                cache: None,
            })
        };
        // Grid/Kanten: normaler Tiefentest (Less), schreibt Tiefe -> das Modell
        // verdeckt Gitter/verdeckte Kanten korrekt.
        let grid_pipeline = make_line_pipeline(
            "grid.pipeline",
            wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            },
        );
        // Auswahl-Highlight: KEIN Tiefentest (`Always`) und KEIN Tiefen-Write —
        // die Auswahl-Umrisslinien werden unabhaengig von der Szenentiefe immer
        // gezeichnet und scheinen so auch hinter Waenden durch (liegen optisch oben,
        // weil sie als letztes gezeichnet werden).
        let highlight_pipeline = make_line_pipeline(
            "highlight.pipeline",
            wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(false),
                depth_compare: Some(wgpu::CompareFunction::Always),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            },
        );

        // Schnittflaechen-Kappen-Pipeline: eigener Shader (CAP_WGSL), eigenes
        // schlankes Vertex-Layout [pos vec3, uv vec2], TriangleList. Dieselbe
        // Bind-Group (Globals) und dasselbe Depth-/MSAA-/Farbziel wie oben.
        let cap_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("cap.wgsl"),
            source: wgpu::ShaderSource::Wgsl(CAP_WGSL.into()),
        });
        let cap_vertex_layout = wgpu::VertexBufferLayout {
            array_stride: (CAP_FLOATS_PER_VERTEX * 4) as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2],
        };
        let cap_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("cap.pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &cap_module,
                entry_point: Some("vs_main"),
                buffers: &[cap_vertex_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &cap_module,
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
                // Die Cap ist eine flache Flaeche und soll aus BEIDEN Richtungen
                // sichtbar sein (das Winding der Rueckprojektion ist nicht
                // kamerakonsistent garantiert) -> kein Backface-Culling.
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                // Leicht ZUR Kamera ziehen (negativer Bias, Gegenteil des
                // hidden_face_pipeline-Bias): die Caps liegen exakt auf der
                // Schnittebene, an der die Wandflaechen weggeschnitten werden —
                // der negative Bias vermeidet Z-Fighting mit an der Grenze
                // gerade noch stehen gebliebenen Wandfragmenten.
                bias: wgpu::DepthBiasState {
                    constant: -4,
                    slope_scale: -1.0,
                    clamp: 0.0,
                },
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
            hidden_face_pipeline,
            grid_pipeline,
            highlight_pipeline,
            cap_pipeline,
            bind_group,
            uniform,
            mesh: None,
            edges: None,
            grid: None,
            highlight: None,
            caps: None,
            grid_visible: false,
            style: RenderStyle::Shaded,
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

    /// Laedt ein fertiges Mesh in die GPU-Puffer (oder loescht es bei leer) und
    /// erzeugt ZUGLEICH die gecachten Modell-Kanten (Feature-Edges, edges.rs) fuer
    /// die Stile wireframe/hidden — einmalig hier, nicht je Frame.
    fn upload_mesh(&mut self, device: &wgpu::Device, mesh: Mesh) {
        if mesh.indices.is_empty() {
            self.mesh = None;
            self.edges = None;
            return;
        }

        // Kanten aus der Mesh-Geometrie ableiten und (falls vorhanden) hochladen.
        let edge_verts = build_mesh_edges(&mesh);
        self.edges = if edge_verts.is_empty() {
            None
        } else {
            let vbo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("edges.vbo"),
                contents: bytemuck::cast_slice(&edge_verts),
                usage: wgpu::BufferUsages::VERTEX,
            });
            Some(LineBuffers {
                vbo,
                vertex_count: (edge_verts.len() / EDGE_FLOATS_PER_VERTEX) as u32,
            })
        };

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

    /// Darstellungsart setzen (shaded/white/textured/wireframe/hidden). Einzige
    /// Quelle der Wahrheit; `render` leitet daraus Pipeline-Wahl und `mode.x` ab.
    pub fn set_render_style(&mut self, style: RenderStyle) {
        self.style = style;
    }

    /// Rueckwaerts-kompatibler Schalter: `true` bildet auf `White`, `false` auf
    /// `Shaded` ab (kein separater Zustand mehr — vermeidet Widerspruch zum
    /// `style`-Feld). Neue Aufrufer nutzen `set_render_style`.
    pub fn set_white_mode(&mut self, white: bool) {
        self.style = if white {
            RenderStyle::White
        } else {
            RenderStyle::Shaded
        };
    }

    /// Setzt/aktualisiert das Referenz-Bodengitter (grid.rs). Erzeugt den Linien-
    /// Vertex-Buffer aus den Parametern neu und merkt sich die Sichtbarkeit; der
    /// naechste `render` zeichnet das Gitter (bzw. nichts bei `visible == false`).
    /// Ohne Aufruf bleibt das Gitter unsichtbar (Default), damit bestehende
    /// Aufrufer unveraendert bleiben.
    pub fn set_ground_grid(
        &mut self,
        device: &wgpu::Device,
        visible: bool,
        elevation: f32,
        extent: f32,
        spacing: f32,
    ) {
        self.grid_visible = visible;
        let verts = build_ground_grid(elevation, extent, spacing);
        if verts.is_empty() {
            self.grid = None;
            return;
        }
        let vbo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("grid.vbo"),
            contents: bytemuck::cast_slice(&verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        self.grid = Some(LineBuffers {
            vbo,
            vertex_count: (verts.len() / GRID_FLOATS_PER_VERTEX) as u32,
        });
    }

    /// Setzt/loescht die Auswahl-Highlight-Linien (Kanten des selektierten Bauteils).
    /// `verts` = interleaved LineList-Vertices `[px,py,pz, r,g,b, ...]` (world,
    /// je 2 Vertices = 1 Segment), exakt wie Grid-/Edge-Vertices
    /// (`GRID_FLOATS_PER_VERTEX`). Leeres Slice -> Highlight loeschen. Analog
    /// `set_ground_grid`, aber ohne Sichtbarkeits-Flag: vorhanden = gezeichnet.
    pub fn set_highlight_lines(&mut self, device: &wgpu::Device, verts: &[f32]) {
        if verts.is_empty() {
            self.highlight = None;
            return;
        }
        let vbo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("highlight.vbo"),
            contents: bytemuck::cast_slice(verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        self.highlight = Some(LineBuffers {
            vbo,
            vertex_count: (verts.len() / GRID_FLOATS_PER_VERTEX) as u32,
        });
    }

    /// Aktiviert/deaktiviert den Live-Schnitt und setzt die Schnittebene. `active`
    /// steuert `mode.y` (der Mesh-/Grid-Shader kappt die Geometrie nur bei > 0.5);
    /// `point`/`normal` (world-Meter, Normale = Blickrichtung) fuellen
    /// `section_plane = [n, -dot(n, point)]`. Nur die Uniform-Werte — die Cap-
    /// Geometrie setzt der Aufrufer separat via `set_cut_caps`.
    pub fn set_section_plane(&mut self, active: bool, point: [f32; 3], normal: [f32; 3]) {
        let n = crate::math::normalize(normal);
        let w = -(n[0] * point[0] + n[1] * point[1] + n[2] * point[2]);
        self.globals.section_plane = [n[0], n[1], n[2], w];
        self.globals.mode[1] = if active { 1.0 } else { 0.0 };
    }

    /// Setzt/loescht die Schnittflaechen-Kappen (Cut-Caps). `verts` = interleaved
    /// `[px,py,pz, u,v, ...]` (world-Meter + Ebenenkoordinaten, TriangleList,
    /// `CAP_FLOATS_PER_VERTEX`), wie `section_fill::build_cut_caps` liefert. Leeres
    /// Slice loescht die Caps. Wirkt erst beim naechsten `render`.
    pub fn set_cut_caps(&mut self, device: &wgpu::Device, verts: &[f32]) {
        if verts.is_empty() {
            self.caps = None;
            return;
        }
        let vbo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("caps.vbo"),
            contents: bytemuck::cast_slice(verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        self.caps = Some(CapBuffers {
            vbo,
            vertex_count: (verts.len() / CAP_FLOATS_PER_VERTEX) as u32,
        });
    }

    /// Komfort: Schnittebene setzen UND die Cap-Geometrie aus den (gecachten)
    /// Waenden/Decken neu bauen — bei `active == false` werden Uniform-Flag und
    /// Caps geloescht. Buendelt `set_section_plane` + `build_cut_caps` +
    /// `set_cut_caps`, damit `web.rs` nur EINEN Aufruf braucht.
    pub fn update_section(
        &mut self,
        device: &wgpu::Device,
        active: bool,
        point: [f32; 3],
        normal: [f32; 3],
        walls: &[WallInput],
        slabs: &[SlabInput],
    ) {
        self.set_section_plane(active, point, normal);
        if active {
            let plane = SectionPlane::new(point, normal);
            let caps = build_cut_caps(&plane, walls, slabs);
            self.set_cut_caps(device, &caps);
        } else {
            self.set_cut_caps(device, &[]);
        }
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
        // `mode.x` fuer den Mesh-Shader aus dem aktuellen Stil ableiten (Material/
        // Clay/Hidden-Flaechen). Wireframe zeichnet keine Flaechen -> Wert egal.
        self.globals.mode[0] = self.style.mesh_mode();
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

            // 1) Gefuellte Flaechen — in allen Stilen ausser "wireframe". Im
            //    Hidden-Line-Stil die leicht nach hinten gebiaste Pipeline, damit
            //    die folgenden Kanten sauber obenauf liegen.
            if self.style.draws_faces() {
                if let Some(m) = &self.mesh {
                    let face_pipeline = if self.style == RenderStyle::Hidden {
                        &self.hidden_face_pipeline
                    } else {
                        &self.pipeline
                    };
                    pass.set_pipeline(face_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    pass.set_vertex_buffer(0, m.vbo.slice(..));
                    pass.set_index_buffer(m.ibo.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..m.index_count, 0, 0..1);
                }
            }

            // 1b) Schnittflaechen-Kappen (Cut-Caps) NACH den Flaechen, VOR den
            //     Kanten: sie fuellen die an der Schnittebene weggeschnittene Wunde
            //     mit der Diagonalschraffur (CAP_WGSL). Werden selbst NICHT gekappt.
            //     Nur vorhanden, wenn der Live-Schnitt aktiv ist (set_cut_caps).
            if let Some(c) = &self.caps {
                pass.set_pipeline(&self.cap_pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.set_vertex_buffer(0, c.vbo.slice(..));
                pass.draw(0..c.vertex_count, 0..1);
            }

            // 2) Modell-Kanten (wireframe/hidden) — LineList-Pipeline (wie Grid).
            //    Im Hidden-Stil obenauf, tiefengetestet gegen die (gebiasten)
            //    Flaechen -> verdeckte Kanten fallen weg. Im Wireframe ohne
            //    Flaechen -> alle Kanten sichtbar.
            if self.style.draws_edges() {
                if let Some(e) = &self.edges {
                    pass.set_pipeline(&self.grid_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    pass.set_vertex_buffer(0, e.vbo.slice(..));
                    pass.draw(0..e.vertex_count, 0..1);
                }
            }

            // 3) Bodengitter NACH dem Modell zeichnen (gemeinsamer Tiefenpuffer ->
            //    das Modell verdeckt das Gitter korrekt). Unabhaengig vom Stil, nur
            //    wenn sichtbar + vorhanden.
            if self.grid_visible {
                if let Some(g) = &self.grid {
                    pass.set_pipeline(&self.grid_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    pass.set_vertex_buffer(0, g.vbo.slice(..));
                    pass.draw(0..g.vertex_count, 0..1);
                }
            }

            // 4) Auswahl-Highlight-Linien als ALLERLETZTES — ohne Tiefentest
            //    (`highlight_pipeline`: depth_compare Always, kein Depth-Write),
            //    damit die Auswahl immer sichtbar obenauf liegt und auch hinter
            //    Waenden durchscheint. Nur wenn per `set_highlight_lines` gesetzt.
            if let Some(hl) = &self.highlight {
                pass.set_pipeline(&self.highlight_pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.set_vertex_buffer(0, hl.vbo.slice(..));
                pass.draw(0..hl.vertex_count, 0..1);
            }
        }
        queue.submit(std::iter::once(encoder.finish()));
    }
}
