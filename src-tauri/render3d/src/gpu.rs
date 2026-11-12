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

use crate::edges::{build_silhouette_edges, EDGE_FLOATS_PER_VERTEX};
use crate::grid::{build_ground_grid, GRID_FLOATS_PER_VERTEX};
use crate::gpu_points::{PointRenderer, PointStyle};
use crate::points::PointCloudCpu;
use crate::math::{view_projection, Mat4};
use crate::scene::{ChunkData, PartEntry, PartInput, PartsUpdate, Scene, SceneChange};
use crate::section::SectionPlane;
use crate::section_fill::{
    build_cut_cap_lines, build_cut_caps, CAP_FLOATS_PER_VERTEX, CUT_LINE_FLOATS_PER_VERTEX,
};
use crate::shaders::{CAP_WGSL, GHOST_WGSL, GRID_WGSL, MESH_AERIAL_WGSL, MESH_TEXTURED_WGSL, MESH_WGSL, SHADOW_WGSL};
use crate::shadow::{caster_indices, cascades, far_map_size, texel_world_size, DEFAULT_SHADOW_MAP_SIZE};
use crate::types::{
    Camera, MeshInput, RoofLayerInput, SlabInput, WallInput,
    FLOATS_PER_VERTEX,
};

/// Darstellungsart des 3D-Renderers (Oberleiste: shaded/white/textured/
/// wireframe/hidden). Bestimmt, welche Pipelines je Frame gezeichnet werden und
/// welchen `mode.x`-Wert der Mesh-Shader bekommt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderStyle {
    /// Beleuchtete Bauteilfarben (Default).
    Shaded,
    /// Clay-Look: einheitlich helles Material, beleuchtet.
    White,
    /// Echte Bild-Textur (prozedurales Schachbrett) auf den Wandflaechen,
    /// beleuchtet wie `Shaded` (eigene Pipeline + Textur-Bind-Group group 1,
    /// siehe `textured_pipeline`).
    Textured,
    /// Nur Modell-Kanten (Feature-Edges), keine gefuellten Flaechen.
    Wireframe,
    /// Hidden-Line: flach-weisse Flaechen (fuellen den Depth-Buffer) + dunkle
    /// Kanten obenauf, tiefengetestet -> nur sichtbare Kanten erscheinen.
    Hidden,
    /// "Schattiert mit Kanten" (typischer BIM-Look, z. B. Revit/ArchiCAD): wie
    /// `Shaded` (echte Bauteilfarben, beleuchtet), ZUSAETZLICH die dunklen
    /// Modell-Kanten obenauf (wie bei `Hidden`, aber mit Material- statt
    /// Weiss-Flaechen).
    ShadedEdges,
    /// „Nur Konturen" (Gipsmodell-Look): flach-weisse Flaechen wie `Hidden`, aber
    /// obenauf NUR die blickabhaengige Silhouette (Umriss je Volumen), nicht die
    /// inneren Knickkanten (Dachgrate). Die Silhouette wird je Kamera aus der
    /// gecachten Kanten-Adjazenz neu abgeleitet (siehe `edges::build_silhouette_edges`).
    Contour,
}

impl RenderStyle {
    /// Parst den API-String; unbekannte Werte fallen auf `Shaded` zurueck.
    pub fn from_str_or_shaded(s: &str) -> Self {
        match s {
            "white" => RenderStyle::White,
            "textured" => RenderStyle::Textured,
            "wireframe" => RenderStyle::Wireframe,
            "hidden" => RenderStyle::Hidden,
            "shaded-edges" => RenderStyle::ShadedEdges,
            "contour" => RenderStyle::Contour,
            _ => RenderStyle::Shaded,
        }
    }

    /// `mode.x`-Wert fuer den Mesh-Shader (siehe shaders.rs): 0 = Material/shaded
    /// (auch textured/shaded-edges), 1 = weiss/Clay, 2 = flach-weisse
    /// Hidden-Line-Flaechen.
    fn mesh_mode(self) -> f32 {
        match self {
            RenderStyle::White => 1.0,
            // Contour teilt den flach-weissen Flaechen-Look von Hidden (mode 2).
            RenderStyle::Hidden | RenderStyle::Contour => 2.0,
            // Shaded, Textured, Wireframe (Flaechen werden bei Wireframe eh nicht
            // gezeichnet), ShadedEdges -> Material.
            _ => 0.0,
        }
    }

    /// Werden in diesem Stil gefuellte Flaechen gezeichnet?
    fn draws_faces(self) -> bool {
        !matches!(self, RenderStyle::Wireframe)
    }

    /// Werden in diesem Stil Modell-Kanten gezeichnet?
    fn draws_edges(self) -> bool {
        matches!(
            self,
            RenderStyle::Wireframe | RenderStyle::Hidden | RenderStyle::ShadedEdges
        )
    }

    /// Ansichtsschraffur auf den Flaechen ([100])? In den Stilen mit Flaechen UND Kanten (Verdeckt,
    /// Schattiert mit Kanten); im Drahtmodell ohne Flaechen wuerde sie nur verwirren.
    fn draws_pattern_lines(self) -> bool {
        matches!(self, RenderStyle::Hidden | RenderStyle::ShadedEdges)
    }

    /// Braucht dieser Stil die leicht nach hinten gebiaste Flaechen-Pipeline,
    /// damit die (tiefengetesteten) Kanten sauber obenauf liegen, statt mit den
    /// Flaechen zu flackern (Z-Fighting)? Gilt fuer alle Stile, die BEIDES
    /// zeichnen (Flaechen + Kanten) — bislang nur `Hidden`, jetzt auch
    /// `ShadedEdges`.
    fn needs_biased_face_pipeline(self) -> bool {
        matches!(
            self,
            RenderStyle::Hidden | RenderStyle::ShadedEdges | RenderStyle::Contour
        )
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
    /// Schatten ([64]): world -> Licht-Clip (`shadow::light_view_proj`).
    light_view_proj: [f32; 16],
    /// Schatten: x = an (1)/aus (0), y = Normalen-Verschiebung (m), z = PCF-Schritt (UV), w = Tiefen-Bias.
    shadow: [f32; 4],
    /// [186] Kaskade 1 (alle eigenen Bauteile, grober): Licht-Matrix und Werte wie `shadow`
    /// (x = Kaskade benutzt). Kaskade 0 (`light_view_proj`/`shadow`) passt eng aufs Gebaeude.
    light_view_proj_far: [f32; 16],
    shadow_far: [f32; 4],
}

/// Uniform des Schatten-Tiefenpasses, 1:1 zu `ShadowGlobals` in `SHADOW_WGSL`.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ShadowGlobals {
    light_view_proj: [f32; 16],
    section_plane: [f32; 4],
    mode: [f32; 4],
}

/// Tiefenformat der Schattentextur (vergleichs-sampelbar auf WebGPU, Metal, Vulkan).
const SHADOW_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

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
            light_view_proj: crate::math::identity(),
            shadow: [0.0; 4],
            light_view_proj_far: crate::math::identity(),
            shadow_far: [0.0; 4],
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

/// Material-Ebenen des TEXTURIERTEN Pfades (`RenderStyle::Textured`): EIN f32 (Material-Textur-Ebene) je
/// Vertex, @location(3) im `MESH_TEXTURED_WGSL`. Ecken und Indizes kommen aus `MeshBuffers` desselben Klumpens
/// (UV im Shader, [214]); immer gesetzt (Fallback `-1` je Vertex), damit das Layout stets zwei Puffer hat.
struct TexturedMeshBuffers {
    layer_vbo: wgpu::Buffer,
}

/// GPU-Ressourcen EINES georeferenzierten Luftbilds (SWISSIMAGE), das aufs Gelaende
/// drapiert wird (`gpu::aerial_pipeline`). Haelt Textur + View am Leben und die
/// fertige Bind-Group (group 1: Textur + Sampler + Bbox-Uniform).
struct AerialBuffers {
    #[allow(dead_code)]
    texture: wgpu::Texture,
    #[allow(dead_code)]
    view: wgpu::TextureView,
    #[allow(dead_code)]
    bbox: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

/// Kantenlaenge der prozeduralen Test-Textur (Schachbrett), in Texeln.
const TEXTURE_SIZE: u32 = 256;

/// Erzeugt ein 256x256-RGBA-Schachbrett IM CODE (kein Asset, keine `image`-Crate):
/// 8x8 Felder abwechselnd hell/dunkel, mit einem duennen Raster als Kachel-Grenze.
/// Rueckgabe = flaches RGBA8-Byte-Array (`4 * TEXTURE_SIZE * TEXTURE_SIZE`), direkt
/// fuer `queue.write_texture` (Zeilen sind `4 * TEXTURE_SIZE` Byte breit, ohne
/// Padding, weil `256 * 4 = 1024` bereits ein Vielfaches von 256 ist). Bewusst
/// selbststaendig, damit der Spike ohne Dateipfade/Asset-Pipeline laeuft.
fn build_checker_texture() -> Vec<u8> {
    let size = TEXTURE_SIZE as usize;
    // 8 Felder je Kante -> jedes Feld 32 Texel breit. Das macht 1 Textur-Kachel
    // (= 1 m Welt, siehe UV-Massstab) in ein 8x8-Schachbrett sichtbar.
    let cell = size / 8;
    let mut data = vec![0u8; size * size * 4];
    // Zwei Grautoene als Schachbrett + eine dunkle Rasterlinie an den Feldgrenzen.
    let light = [220u8, 220, 224, 255];
    let dark = [150u8, 152, 160, 255];
    let line = [70u8, 72, 80, 255];
    for y in 0..size {
        for x in 0..size {
            let checker = ((x / cell) + (y / cell)) % 2 == 0;
            // Duenne Rasterlinie (2 Texel) exakt auf den Feldkanten — betont die
            // weltmassstaebliche Kachelung an Gehrungen/Ecken sichtbar.
            let on_line = (x % cell) < 2 || (y % cell) < 2;
            let px = if on_line {
                line
            } else if checker {
                light
            } else {
                dark
            };
            let o = (y * size + x) * 4;
            data[o..o + 4].copy_from_slice(&px);
        }
    }
    data
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

/// GPU-Puffer eines Klumpens der Szene (`scene.rs`); None = leer.
#[derive(Default)]
struct ChunkBuffers {
    mesh: Option<MeshBuffers>,
    textured: Option<TexturedMeshBuffers>,
    /// Modell-Kanten (Feature-Edges) als LineList, gezeichnet in wireframe/hidden/… und bei Schnitt.
    edges: Option<LineBuffers>,
    /// Schraffur-Kappen an Wand-Oberseiten und freien Wandenden (statisch, unabhaengig vom Live-Schnitt).
    caps: Option<CapBuffers>,
    /// Schatten ([64]): Indizes der schattenwerfenden Dreiecke (ohne Glas) und ihre Zahl. `None` mit
    /// Zahl > 0 = alle Dreiecke werfen, der Haupt-Indexpuffer `mesh.ibo` genuegt.
    caster_ibo: Option<wgpu::Buffer>,
    caster_count: u32,
}

fn vertex_buffer(device: &wgpu::Device, label: &str, data: &[f32]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytemuck::cast_slice(data),
        usage: wgpu::BufferUsages::VERTEX,
    })
}

fn index_buffer(device: &wgpu::Device, label: &str, data: &[u32]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytemuck::cast_slice(data),
        usage: wgpu::BufferUsages::INDEX,
    })
}

/// Laedt die Zeichendaten eines Klumpens hoch (leere Teile -> None).
fn upload_chunk(device: &wgpu::Device, d: ChunkData) -> ChunkBuffers {
    let mut out = ChunkBuffers::default();
    if !d.edges.is_empty() {
        out.edges = Some(LineBuffers {
            vbo: vertex_buffer(device, "edges.vbo", &d.edges),
            vertex_count: (d.edges.len() / EDGE_FLOATS_PER_VERTEX) as u32,
        });
    }
    if !d.caps.is_empty() {
        out.caps = Some(CapBuffers {
            vbo: vertex_buffer(device, "wall_end_caps.vbo", &d.caps),
            vertex_count: (d.caps.len() / CAP_FLOATS_PER_VERTEX) as u32,
        });
    }
    if d.mesh.indices.is_empty() {
        return out;
    }
    let casters = caster_indices(&d.mesh.verts, &d.mesh.indices);
    out.caster_count = casters.len() as u32;
    if !casters.is_empty() && casters.len() != d.mesh.indices.len() {
        out.caster_ibo = Some(index_buffer(device, "mesh.shadow.ibo", &casters));
    }
    out.mesh = Some(MeshBuffers {
        vbo: vertex_buffer(device, "mesh.vbo", &d.mesh.verts),
        ibo: index_buffer(device, "mesh.ibo", &d.mesh.indices),
        index_count: d.mesh.indices.len() as u32,
    });
    // Texturiert ([214]): nur die Material-Ebene je Vertex (fehlt sie: -1 = Schachbrett); Ecken/Indizes wie oben.
    let vertex_count = d.mesh.vertex_count();
    let layer_data: Vec<f32> = if d.layers.len() == vertex_count { d.layers } else { vec![-1.0; vertex_count] };
    out.textured = Some(TexturedMeshBuffers { layer_vbo: vertex_buffer(device, "mesh.textured.layer.vbo", &layer_data) });
    out
}

/// Schattentextur ([64]) der Kantenlaenge `size` als View (Tiefe, als Ziel und vergleichs-sampelbar).
fn create_shadow_view(device: &wgpu::Device, size: u32) -> wgpu::TextureView {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("shadow.map"),
        size: wgpu::Extent3d { width: size.max(1), height: size.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: SHADOW_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    tex.create_view(&wgpu::TextureViewDescriptor::default())
}

/// Bind-Group 0 aller Pipelines: Globals-Uniform + Schattentexturen (Kaskade 0 und 1, [186]) +
/// Vergleichs-Sampler.
fn create_globals_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    uniform: &wgpu::Buffer,
    shadow_view: &wgpu::TextureView,
    shadow_view_far: &wgpu::TextureView,
    shadow_sampler: &wgpu::Sampler,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("globals.bind"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(shadow_view) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(shadow_sampler) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(shadow_view_far) },
        ],
    })
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
    /// Durchscheinende Koerper ([63] zulaessige Huelle): TriangleList, GHOST_WGSL, Vertex
    /// `[pos vec3, rgba vec4]`, Alpha-Blending, Tiefentest ohne Tiefen-Write, kein Culling.
    ghost_pipeline: wgpu::RenderPipeline,
    /// Dreiecke (`GHOST_FLOATS_PER_VERTEX`) und Kanten (LineList wie das Gitter) der
    /// durchscheinenden Koerper; None = nichts. Ueber `set_ghost`, gezeichnet nach allem Opaken.
    ghost: Option<LineBuffers>,
    ghost_lines: Option<LineBuffers>,
    /// [180] Geisterschicht: Elemente grauer Klassen als eigene Szene aus Teilen ([214]: ein Teil-Update vernetzt und
    /// laedt nur die geaenderten Klumpen, `update_ghost_parts`), je Klumpen Dreiecke und Kanten in den Formaten von
    /// `ghost`/`ghost_lines` (`ghost::chunk_ghost_buffers`), gleiche Pipeline.
    ghost_scene: Scene,
    ghost_chunks: Vec<GhostChunk>,
    /// [180] 2D-Spuren grauer Klassen (gedaempft, `ghost::mute_lines`), tiefengetestet wie die Kanten der Geisterschicht.
    ghost_drawing_lines: Option<LineBuffers>,
    /// [180] Flaechenmuster grauer Klassen (gedaempft, `ghost::mute_pattern`): wie `pattern_data` je Kamera nach Abstand
    /// ausgewaehlt und im selben Puffer gezeichnet.
    ghost_pattern_data: Vec<f32>,
    /// Schnittflaechen-Kappen (TriangleList, CAP_WGSL, eigenes Vertex-Layout
    /// [pos vec3, uv vec2]). Teilt sich die `Globals`-Bind-Group; leichter
    /// Depth-Bias zur Kamera hin gegen Z-Fighting mit den an der Ebene
    /// per-`discard` gekappten Wandflaechen. Backface-Culling AUS (CullMode::None).
    cap_pipeline: wgpu::RenderPipeline,
    /// Schnitt-Umrisslinien-Pipeline (Cut-Cap-Kanten, P2): TriangleList von
    /// Ribbon-Quads (`section_fill::build_cut_cap_lines`), Vertex-Layout [pos vec3,
    /// color vec3] wie die Grid/Highlight-LineList — teilt darum das `grid_module`
    /// (GRID_WGSL). KEIN Tiefentest (`depth_compare: Always`, kein Write) wie das
    /// Highlight: die Fugenlinien liegen (leicht zur Kamera versetzt) sichtbar auf
    /// den Cut-Caps. Sie werden NICHT an der Schnittebene weggeclippt (sie SIND die
    /// Schnittflaeche) — der Kamera-Lift in `build_cut_cap_lines` haelt sie vor der
    /// `depth > 0`-Kappung von GRID_WGSL.
    cut_line_pipeline: wgpu::RenderPipeline,
    /// Texturierte Wand-Pipeline (`RenderStyle::Textured`, TriangleList,
    /// MESH_TEXTURED_WGSL, Vertex-Layout [pos vec3, normal vec3, uv vec2]). Bindet
    /// group 0 (Globals) UND group 1 (Bild-Textur). Depth-/MSAA-/Farbziel
    /// BITIDENTISCH zur Haupt-`pipeline` (sonst inkompatibler Render-Pass), nur
    /// Shader/Layout unterscheiden sich.
    textured_pipeline: wgpu::RenderPipeline,
    /// Luftbild-Drape-Pipeline (`MESH_AERIAL_WGSL`): zeichnet das Terrain-Overlay
    /// (`terrain_overlay`) ein zweites Mal mit einer Bild-Textur (group 1). Vertex-
    /// Layout = Haupt-Mesh-Layout `[pos, normal, color]`. Leichter Depth-Bias zur
    /// Kamera hin (wie `cap_pipeline`), damit das Overlay das deckungsgleiche
    /// Terrain im Hauptpuffer ueberlagert statt zu flimmern.
    aerial_pipeline: wgpu::RenderPipeline,
    /// Bind-Group-Layout (group 1) des Luftbild-Pfades: Textur + Sampler + Bbox-
    /// Uniform. Festgehalten fuer den Bind-Group-Neubau in `set_aerial_texture`.
    aerial_bind_group_layout: wgpu::BindGroupLayout,
    /// Sampler des Luftbilds (ClampToEdge/Linear — kein Kacheln, weiche Filterung).
    aerial_sampler: wgpu::Sampler,
    /// Das aktuell drapierte Luftbild (Textur + Bind-Group). None = kein Luftbild.
    aerial: Option<AerialBuffers>,
    /// Nur die Gelaende-Dreiecke (aus `build_terrain_mesh`) als eigener Puffer —
    /// Grundlage des Luftbild-Overlays. Bei `upload_model` erzeugt; None = kein
    /// Terrain. Wird nur gezeichnet, wenn zusaetzlich `aerial` gesetzt ist.
    terrain_overlay: Option<MeshBuffers>,
    /// Zuletzt gebaute Silhouetten-LineList (Stil `Contour`) + die Kamera-Signatur,
    /// fuer die sie gilt — bei Blickwechsel neu abgeleitet (nicht je Frame blind).
    silhouette: Option<LineBuffers>,
    silhouette_key: Option<[i64; 6]>,
    /// Bind-Group des Material-Textur-Arrays (group 1): Array-View + Sampler.
    /// Wird bei `set_material_textures` neu gebaut (mehr Ebenen); bis dahin haelt
    /// sie das 1-Ebenen-Array mit dem Fallback-Schachbrett.
    texture_bind_group: wgpu::BindGroup,
    /// Das Textur-Array selbst. Start: 1 Ebene (Schachbrett). `set_material_textures`
    /// ersetzt es durch ein Array `[Schachbrett, Material0, Material1, …]`.
    texture: wgpu::Texture,
    /// Bind-Group-Layout (group 1), festgehalten fuer den Neubau der Bind-Group
    /// beim Hochladen von Material-Texturen.
    texture_bind_group_layout: wgpu::BindGroupLayout,
    /// Sampler (Repeat/Linear), festgehalten fuer den Bind-Group-Neubau.
    texture_sampler: wgpu::Sampler,
    /// Anzahl gueltiger Ebenen im Textur-Array (>= 1). 1 = nur Schachbrett; nach
    /// `set_material_textures` = 1 + Anzahl Material-Karten. Wandert je Frame nach
    /// `mode.z` (Klemmung der Ebenen-Auswahl im Shader).
    material_layer_count: u32,
    /// Ob die Schachbrett-Texel (Ebene 0) schon hochgeladen wurden. Beim ersten
    /// `render` einmalig gesetzt (lazy Upload, weil `new` keine Queue bekommt).
    texture_uploaded: bool,
    bind_group: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    /// Layout von group 0 (Globals + Schattentextur + Vergleichs-Sampler), fuer den Neubau der
    /// Bind-Group, wenn die Schattentextur neu angelegt wird.
    bind_group_layout: wgpu::BindGroupLayout,
    /// Schatten ([64]): Tiefenpass-Pipeline, ihr Uniform/Bind-Group, die Schattentextur (zuerst 1x1
    /// als Platzhalter, beim ersten Einschalten in voller Groesse) und der Vergleichs-Sampler.
    shadow_pipeline: wgpu::RenderPipeline,
    shadow_uniform: wgpu::Buffer,
    shadow_bind_group: wgpu::BindGroup,
    shadow_view: wgpu::TextureView,
    shadow_sampler: wgpu::Sampler,
    /// [186] Kaskade 1 (grob): Uniform, Bind-Group, Textur; `shadow_far_on` = im letzten Pass benutzt.
    shadow_uniform_far: wgpu::Buffer,
    shadow_bind_group_far: wgpu::BindGroup,
    shadow_view_far: wgpu::TextureView,
    shadow_far_on: bool,
    /// Licht-Matrizen des letzten Tiefenpasses (Kaskade 0, 1): neuer Pass nur, wenn sie wechseln.
    shadow_last: Option<([f32; 16], [f32; 16])>,
    /// Box der Nahsicht-Kaskade im letzten Frame (Hysterese, `shadow::view_box`).
    shadow_view_box: Option<crate::math::Bounds3>,
    /// Kantenlaenge der angelegten Schattentexturen (Kaskade 0, 1) und die gewuenschte fuer
    /// Kaskade 0 (Option, Standard `DEFAULT_SHADOW_MAP_SIZE`; Kaskade 1 `shadow::far_map_size`).
    shadow_alloc: (u32, u32),
    shadow_size: u32,
    /// Richtung ZUR Sonne (world) oder None (keine Sonnenstudie / Nacht) und der Schalter.
    sun: Option<[f32; 3]>,
    shadows_on: bool,
    /// Licht ohne Sonne (`set_light`), gilt wieder, sobald die Sonne wegfaellt.
    base_light: [f32; 4],
    /// Schattentextur muss neu gerendert werden (Sonne, Geometrie, Schnitt, Groesse geaendert) —
    /// nicht je Kamera-Frame.
    shadow_dirty: bool,
    /// Zahl der Schatten-Tiefenpaesse seit dem Start (Test/Diagnose).
    shadow_passes: u32,
    /// Das Modell als Teile ([58], `scene.rs`): CPU-Netze je Teil, Kanten-Index, Klumpen-Zuordnung.
    scene: Scene,
    /// GPU-Puffer je Klumpen der Szene (Flächen, texturiert, Kanten, Wand-Kappen); ein Teil-Update
    /// lädt nur die geänderten Klumpen neu hoch.
    chunks: Vec<ChunkBuffers>,
    /// Bodengitter-Vertices (None = nicht erzeugt). Wird nur gezeichnet, wenn
    /// zusaetzlich `grid_visible` gesetzt ist.
    grid: Option<LineBuffers>,
    /// Auswahl-Highlight-Linien (Kanten des selektierten Bauteils, LineList) als
    /// LineBuffers. None = keine Auswahl -> nichts wird gezeichnet. Ueber
    /// `set_highlight_lines` gesetzt/geloescht; im Render-Pass als ALLERLETZTES
    /// (ohne Tiefentest) gezeichnet.
    highlight: Option<LineBuffers>,
    /// 2D-Zeichnungs-Unterlage (Boden-Spuren der `Drawing2D`-Elemente) als
    /// LineList. Bewusst KEINE Meshes: ein Kataster-Import kann Millionen
    /// Segmente haben — als Dreiecks-Ribbons (`append_context_mesh`, beidseitig
    /// + de-indiziert) waeren das GB-weise Vertexdaten, als LineList sind es
    /// 2 Vertices je Segment. Ueber `set_drawing_lines` gesetzt/geloescht;
    /// tiefengetestet wie das Gitter gezeichnet (Bauteile verdecken korrekt).
    drawing_lines: Option<LineBuffers>,
    /// Ansichtsschraffur auf den Flächen ([100], `pattern_lines`): Rohdaten aus dem Kern und die für die
    /// aktuelle Kamera ausgewählten Linien (neu bei merklicher Kamera-/Grössenänderung).
    pattern_data: Vec<f32>,
    pattern_lines: Option<LineBuffers>,
    pattern_key: Option<[i64; 8]>,
    /// Schnittflaechen-Kappen (Cut-Caps) des Live-Schnitts. None = kein Schnitt
    /// aktiv / keine Schnittgeometrie. Ueber `set_cut_caps` gesetzt/geloescht,
    /// gezeichnet NACH den Flaechen, VOR Kanten/Grid/Highlight.
    caps: Option<CapBuffers>,
    /// Schnitt-Umrisslinien (Cut-Cap-Kanten, P2) als Ribbon-TriangleList
    /// (`[pos, color]`). None = kein Schnitt aktiv / keine Kanten. Ueber
    /// `set_cut_lines` gesetzt/geloescht, gezeichnet NACH den Caps.
    cut_lines: Option<LineBuffers>,
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
    /// Punktwolken ([27], `gpu_points.rs`): eigene Instanz-Quad-Pipeline, tiefengetestet im
    /// selben Pass wie das Modell.
    points: PointRenderer,
    /// Loeschfarbe (Hintergrund). Default heller Grauton wie die three.js-Sicht.
    pub clear_color: wgpu::Color,
    /// [214] Zahlen des letzten Frames (`frame_stats`).
    frame_stats: FrameStats,
    /// [214] Inhalts-Schluessel der zuletzt gesetzten Linien/Huelle: Gleiches wird nicht neu hochgeladen.
    keys: DataKeys,
}

/// [180]/[214] GPU-Puffer eines Klumpens der Geisterschicht (Formate wie `set_ghost`).
#[derive(Default)]
struct GhostChunk {
    tris: Option<LineBuffers>,
    lines: Option<LineBuffers>,
}

/// [214] Daten, die der Viewer bei jeder Modellaenderung ganz neu schickt.
#[derive(Clone, Copy)]
enum DataSlot {
    Drawing,
    Pattern,
    Envelope,
    GhostLines,
}

/// [214] Inhalts-Schluessel je [`DataSlot`] (`content_key`); `None` = noch nichts gesetzt.
#[derive(Default)]
struct DataKeys([Option<u64>; 4]);

impl DataKeys {
    /// Merkt den Schluessel von `data`; `false`, wenn er dem zuletzt gemerkten gleicht (nichts zu tun).
    fn changed(&mut self, slot: DataSlot, data: &[&[f32]]) -> bool {
        let k = Some(content_key(data));
        let old = std::mem::replace(&mut self.0[slot as usize], k);
        old != k
    }
}

/// [214] 64-Bit-Schluessel ueber die Bits mehrerer f32-Folgen samt ihrer Laengen (Kollision praktisch
/// ausgeschlossen; billig gegen das Anlegen und Hochladen eines Puffers).
pub(crate) fn content_key(data: &[&[f32]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |w: u64| {
        h ^= w;
        h = h.wrapping_mul(0x0000_0100_0000_01b3).rotate_left(29).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    };
    for d in data {
        mix(d.len() as u64 | (1 << 63));
        for c in d.chunks(2) {
            let a = c[0].to_bits() as u64;
            let b = c.get(1).map_or(0, |v| v.to_bits() as u64);
            mix(a | (b << 32));
        }
    }
    h
}

/// [214] Zahlen eines Frames (Messung): Draw-Calls und gezeichnete Ecken/Indizes im Hauptpass, Draw-Calls im
/// Schatten-Tiefenpass (0 = kein Pass in diesem Frame).
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameStats {
    pub draws: u32,
    pub elements: u64,
    pub shadow_draws: u32,
}

impl FrameStats {
    fn add(&mut self, n: u32) {
        self.draws += 1;
        self.elements += n as u64;
    }
}

/// Floats je Ecke der durchscheinenden Koerper: `[px,py,pz, r,g,b,a]`.
pub const GHOST_FLOATS_PER_VERTEX: usize = 7;

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
                entries: &[
                    wgpu::BindGroupLayoutEntry {
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
                    },
                    // Schatten ([64]): Tiefentextur + Vergleichs-Sampler (nur die beleuchteten
                    // Flaechen-Shader lesen sie; die uebrigen ignorieren die Bindungen).
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Depth,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                        count: None,
                    },
                    // [186] Schattentextur der Kaskade 1 (grob, alle eigenen Bauteile).
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Depth,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                ],
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

        // Durchscheinende Koerper ([63]): nach dem Opaken gezeichnet, testen die Tiefe (Modell
        // verdeckt), schreiben sie aber nicht (die Huelle verdeckt nichts), Alpha-Blending.
        let ghost_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("ghost.wgsl"),
            source: wgpu::ShaderSource::Wgsl(GHOST_WGSL.into()),
        });
        let ghost_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ghost.pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &ghost_module,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: (GHOST_FLOATS_PER_VERTEX * 4) as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x4],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &ghost_module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: color_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(false),
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

        // Schnitt-Umrisslinien-Pipeline (Cut-Cap-Kanten, P2): dasselbe schlanke
        // LineList-Vertex-Layout [pos vec3, color vec3] und `grid_module` (GRID_WGSL)
        // wie Grid/Highlight, aber als TriangleList (die Kanten sind Ribbon-Quads,
        // damit die Strichstaerke als Welt-Breite durchkommt). Depth wie Highlight
        // (Always, kein Write) -> immer sichtbar auf den Caps.
        let cut_line_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("cut_line.pipeline"),
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
                topology: wgpu::PrimitiveTopology::TriangleList,
                // Ribbons sind flach in der Schnittebene, aus beiden Seiten sichtbar.
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(false),
                depth_compare: Some(wgpu::CompareFunction::Always),
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

        // Schnittflaechen-Kappen-Pipeline: eigener Shader (CAP_WGSL), eigenes
        // schlankes Vertex-Layout [pos vec3, uv vec2], TriangleList. Dieselbe
        // Bind-Group (Globals) und dasselbe Depth-/MSAA-/Farbziel wie oben.
        let cap_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("cap.wgsl"),
            source: wgpu::ShaderSource::Wgsl(CAP_WGSL.into()),
        });
        // Vertex-Layout: [pos vec3, uv vec2, hatch vec4(pattern, angle_rad, scale,
        // line_weight_mm)], stride 9*4 (`CAP_FLOATS_PER_VERTEX`). Das dritte Attribut
        // treibt die musterspezifische Schraffur im Cap-Fragment-Shader (CAP_WGSL);
        // `line_weight_mm` setzt die Musterlinien-Breite je Schraffur.
        let cap_vertex_layout = wgpu::VertexBufferLayout {
            array_stride: (CAP_FLOATS_PER_VERTEX * 4) as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2, 2 => Float32x4],
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

        // ── Texturierter Wand-Pfad (RenderStyle::Textured) ──────────────────────
        // Bild-Textur-Bind-Group-Layout (group 1): sampelbare 2D-Float-Textur +
        // Filter-Sampler. `Globals` bleibt group 0 (oben) UND unveraendert.
        let texture_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("texture.layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2Array,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        // Pipeline-Layout des texturierten Pfades: group 0 = Globals (wie oben),
        // group 1 = Textur. Reihenfolge = Bindungs-Index, deshalb beide hier.
        let textured_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("3d.textured.layout"),
                bind_group_layouts: &[Some(&bind_group_layout), Some(&texture_bind_group_layout)],
                immediate_size: 0,
            });
        let textured_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("mesh_textured.wgsl"),
            source: wgpu::ShaderSource::Wgsl(MESH_TEXTURED_WGSL.into()),
        });
        // [214] Vertex-Layout = Flaechen-Puffer `[pos vec3, normal vec3, color vec3]` (color ungenutzt, UV im
        // Shader): derselbe Puffer wie der schattierte Pfad, kein zweites Netz je Klumpen.
        let textured_vertex_layout = wgpu::VertexBufferLayout {
            array_stride: (FLOATS_PER_VERTEX * 4) as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3],
        };
        // ZWEITER Vertex-Buffer: die Material-Textur-Ebene je Vertex (@location(3),
        // 1 f32). Separat gehalten, damit das Haupt-`[pos,normal,uv]`-Layout (und
        // die Geometrie-Paritaet zum Shaded-Pfad) unveraendert bleibt.
        let textured_layer_layout = wgpu::VertexBufferLayout {
            array_stride: 4,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![3 => Float32],
        };
        // WICHTIG: Depth-Format, MSAA (`SAMPLE_COUNT`), Color-Target-Format,
        // Topologie und Culling BITIDENTISCH zur Haupt-`pipeline` (make_mesh_pipeline)
        // — die texturierten Waende laufen im GLEICHEN Render-Pass, deshalb muss der
        // Pipeline-State kompatibel sein (sonst wgpu-Validierungspanik). Einziger
        // Unterschied: Shader/Vertex-Layout und das zusaetzliche group-1-Layout.
        let textured_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("mesh.textured.pipeline"),
            layout: Some(&textured_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &textured_module,
                entry_point: Some("vs_main"),
                buffers: &[textured_vertex_layout, textured_layer_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &textured_module,
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

        // ── Luftbild-Drape-Pfad (aerial_pipeline) ───────────────────────────────
        // group 1: EINE 2D-Bild-Textur + Sampler + Bbox-Uniform (16 Byte, vec4).
        // group 0 (Globals) bleibt geteilt. Vertex-Layout = Haupt-Mesh-Layout
        // [pos, normal, color], damit der Terrain-Overlay-Puffer direkt passt.
        let aerial_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("aerial.layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(16),
                        },
                        count: None,
                    },
                ],
            });
        let aerial_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("3d.aerial.layout"),
                bind_group_layouts: &[Some(&bind_group_layout), Some(&aerial_bind_group_layout)],
                immediate_size: 0,
            });
        let aerial_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("mesh_aerial.wgsl"),
            source: wgpu::ShaderSource::Wgsl(MESH_AERIAL_WGSL.into()),
        });
        let aerial_vertex_layout = wgpu::VertexBufferLayout {
            array_stride: (FLOATS_PER_VERTEX * 4) as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x3],
        };
        let aerial_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("mesh.aerial.pipeline"),
            layout: Some(&aerial_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &aerial_module,
                entry_point: Some("vs_main"),
                buffers: &[aerial_vertex_layout],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &aerial_module,
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
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                // Das Overlay nutzt EXAKT dieselbe Terrain-Geometrie wie der
                // Hauptpuffer -> bit-identische Tiefe. Mit LessEqual gewinnt das
                // NACH dem Terrain gezeichnete Overlay bei gleicher Tiefe
                // deterministisch (kein Bias noetig). Ein Slope-Bias wuerde in
                // ORTHO-Praesets (iso/axo) je nach Dreiecks-Neigung ungleich
                // schieben und fleckige „Abschnitte" erzeugen — daher KEIN Bias.
                depth_compare: Some(wgpu::CompareFunction::LessEqual),
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
        // ClampToEdge (Randpixel ausserhalb der Bbox) + Linear (weiche Filterung).
        let aerial_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("aerial.sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });

        // Prozedurale 256x256-Schachbrett-Textur ANLEGEN (kein Asset). RGBA8-srgb,
        // damit die im Shader gesampelten Werte im linearen Raum landen (die
        // Beleuchtung rechnet linear) — analog zum srgb-Surface-Format. Das
        // Hochladen der Texel (queue.write_texture) passiert einmalig beim ersten
        // `render` (siehe `texture_uploaded`), weil `new` bewusst KEINE Queue
        // bekommt — die Signatur bleibt fuer die bestehenden Aufrufer (web.rs,
        // spike3d) unveraendert.
        // Textur-ARRAY (D2Array). Start: EINE Ebene (Fallback-Schachbrett).
        // `set_material_textures` ersetzt das Array spaeter durch mehrere Ebenen.
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("materials.texture_array"),
            size: wgpu::Extent3d {
                width: TEXTURE_SIZE,
                height: TEXTURE_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        // Repeat (weltmassstaebliches UV kachelt) + Linear (weiche Filterung).
        let texture_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("materials.sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        let texture_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("materials.bind"),
            layout: &texture_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&texture_sampler),
                },
            ],
        });

        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals.buffer"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        // Schatten ([64]): Platzhalter-Textur 1x1 bis zum ersten Einschalten, Vergleichs-Sampler
        // (LessEqual: Fragment-Tiefe <= gespeicherte -> besonnt; linear = 2x2-PCF je Abtastung).
        let shadow_view = create_shadow_view(device, 1);
        let shadow_view_far = create_shadow_view(device, 1);
        let shadow_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("shadow.sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });
        let bind_group = create_globals_bind_group(device, &bind_group_layout, &uniform, &shadow_view, &shadow_view_far, &shadow_sampler);

        // Schatten-Tiefenpass: eigenes Uniform (Licht-Matrix + Schnitt), nur Positionen des
        // Haupt-Mesh-Layouts, kein Farbziel, kein Culling (doppelseitige/duenne Teile werfen auch),
        // Steigungs-Bias gegen Akne (klein: zu viel Bias loest den Schatten vom Werfer, Peter-Panning).
        let shadow_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("shadow.layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<ShadowGlobals>() as u64),
                },
                count: None,
            }],
        });
        let shadow_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("shadow.globals"),
            size: std::mem::size_of::<ShadowGlobals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let shadow_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("shadow.bind"),
            layout: &shadow_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: shadow_uniform.as_entire_binding() }],
        });
        // [186] Kaskade 1: eigenes Uniform (Licht-Matrix), gleiche Pipeline.
        let shadow_uniform_far = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("shadow.globals.far"),
            size: std::mem::size_of::<ShadowGlobals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let shadow_bind_group_far = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("shadow.bind.far"),
            layout: &shadow_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: shadow_uniform_far.as_entire_binding() }],
        });
        let shadow_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("shadow.wgsl"),
            source: wgpu::ShaderSource::Wgsl(SHADOW_WGSL.into()),
        });
        let shadow_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("shadow.pipeline.layout"),
            bind_group_layouts: &[Some(&shadow_layout)],
            immediate_size: 0,
        });
        let shadow_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("shadow.pipeline"),
            layout: Some(&shadow_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shadow_module,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: (FLOATS_PER_VERTEX * 4) as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shadow_module,
                entry_point: Some("fs_main"),
                targets: &[],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: SHADOW_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState { constant: 2, slope_scale: 1.5, clamp: 0.0 },
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let points =
            PointRenderer::new(device, &bind_group_layout, color_format, DEPTH_FORMAT, SAMPLE_COUNT);

        Self {
            points,
            pipeline,
            hidden_face_pipeline,
            grid_pipeline,
            highlight_pipeline,
            ghost_pipeline,
            ghost: None,
            ghost_lines: None,
            ghost_scene: Scene::new(),
            ghost_chunks: Vec::new(),
            ghost_drawing_lines: None,
            ghost_pattern_data: Vec::new(),
            cap_pipeline,
            cut_line_pipeline,
            textured_pipeline,
            aerial_pipeline,
            aerial_bind_group_layout,
            aerial_sampler,
            aerial: None,
            terrain_overlay: None,
            silhouette: None,
            silhouette_key: None,
            texture_bind_group,
            texture,
            texture_bind_group_layout,
            texture_sampler,
            material_layer_count: 1,
            texture_uploaded: false,
            bind_group,
            uniform,
            bind_group_layout,
            shadow_pipeline,
            shadow_uniform,
            shadow_bind_group,
            shadow_view,
            shadow_sampler,
            shadow_uniform_far,
            shadow_bind_group_far,
            shadow_view_far,
            shadow_far_on: false,
            shadow_last: None,
            shadow_view_box: None,
            shadow_alloc: (1, 1),
            shadow_size: DEFAULT_SHADOW_MAP_SIZE,
            sun: None,
            shadows_on: false,
            base_light: Globals::default().light_dir,
            shadow_dirty: true,
            shadow_passes: 0,
            scene: Scene::new(),
            chunks: Vec::new(),
            grid: None,
            highlight: None,
            drawing_lines: None,
            pattern_data: Vec::new(),
            pattern_lines: None,
            pattern_key: None,
            caps: None,
            cut_lines: None,
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
            frame_stats: FrameStats::default(),
            keys: DataKeys::default(),
        }
    }

    /// [214] Bytes der Modell-Puffer auf der GPU (Messung): Klumpen (Flächen, texturiert, Schatten-Indizes, Kanten,
    /// Kappen), Gelände-Overlay, Geisterschicht, Linien (Zeichnungen, Muster, Silhouette). Ohne Texturen/Punktwolken.
    pub fn gpu_bytes(&self) -> u64 {
        let mut n = 0u64;
        for c in &self.chunks {
            if let Some(m) = &c.mesh {
                n += m.vbo.size() + m.ibo.size();
            }
            if let Some(t) = &c.textured {
                n += t.layer_vbo.size();
            }
            n += c.caster_ibo.as_ref().map_or(0, |b| b.size());
            n += c.edges.as_ref().map_or(0, |b| b.vbo.size());
            n += c.caps.as_ref().map_or(0, |b| b.vbo.size());
        }
        n += self.terrain_overlay.as_ref().map_or(0, |m| m.vbo.size() + m.ibo.size());
        for l in [&self.ghost, &self.ghost_lines, &self.ghost_drawing_lines, &self.drawing_lines, &self.pattern_lines, &self.silhouette] {
            n += l.as_ref().map_or(0, |b| b.vbo.size());
        }
        for g in &self.ghost_chunks {
            n += g.tris.as_ref().map_or(0, |b| b.vbo.size()) + g.lines.as_ref().map_or(0, |b| b.vbo.size());
        }
        n
    }

    /// Setzt/ersetzt die Punktwolke `id` ([27]); `None` (unbrauchbare Eingabe) entfernt sie.
    pub fn set_point_cloud(
        &mut self,
        device: &wgpu::Device,
        id: u32,
        cloud: Option<PointCloudCpu>,
        style: PointStyle,
    ) {
        self.points.set_cloud(device, id, cloud, style);
    }

    /// Nur die Darstellung einer Punktwolke aendern (Farbmodus/Groesse/Sichtbarkeit).
    /// `false`, wenn die Wolke unbekannt ist.
    pub fn set_point_cloud_style(&mut self, queue: &wgpu::Queue, id: u32, style: PointStyle) -> bool {
        self.points.set_style(queue, id, style)
    }

    /// Entfernt die Punktwolke `id` (unbekannt = nichts).
    pub fn remove_point_cloud(&mut self, id: u32) {
        self.points.remove(id);
    }

    /// Entfernt alle Punktwolken.
    pub fn clear_point_clouds(&mut self) {
        self.points.clear();
    }

    /// Punktzahl der Wolke `id` (0 = unbekannt).
    pub fn point_cloud_len(&self, id: u32) -> usize {
        self.points.point_count(id)
    }

    /// World-Bounding-Box aller sichtbaren Punktwolken.
    pub fn point_cloud_bounds(&self) -> Option<([f32; 3], [f32; 3])> {
        self.points.bounds()
    }

    /// Erzeugt das Mesh aus geflachten Waenden und laedt die Puffer hoch.
    pub fn upload_walls(&mut self, device: &wgpu::Device, walls: &[WallInput]) {
        self.upload_model(device, walls, &[], &[]);
    }

    /// Erzeugt das Mesh aus Waenden, Deckenplatten UND rohen Kontext-Meshes
    /// (Terrain/importierte Volumen, siehe `MeshInput`) und laedt die Puffer hoch
    /// (ein einziger Teil der Szene, voller Neuaufbau).
    pub fn upload_model(
        &mut self,
        device: &wgpu::Device,
        walls: &[WallInput],
        slabs: &[SlabInput],
        meshes: &[MeshInput],
    ) {
        let part = PartInput { walls: walls.to_vec(), slabs: slabs.to_vec(), meshes: meshes.to_vec(), roof_layers: Vec::new() };
        self.update_parts(device, PartsUpdate { reset: true, remove: Vec::new(), upsert: vec![PartEntry::new("", part)] });
    }

    /// Teil-Update des Modells ([58], `scene.rs`): fuegt Teile hinzu, ersetzt oder entfernt sie und
    /// laedt nur die betroffenen Klumpen neu hoch (Flaechen, texturiert, Kanten, Wand-Kappen; das
    /// Gelaende-Overlay nur, wenn sich Gelaende geaendert hat). `reset` = ganzes Modell neu.
    pub fn update_parts(&mut self, device: &wgpu::Device, upd: PartsUpdate) -> SceneChange {
        let ch = self.scene.apply(upd);
        self.shadow_dirty = true;
        // Silhouette-Cache verwerfen (neues Modell) — wird bei Bedarf neu gebaut.
        self.silhouette = None;
        self.silhouette_key = None;
        if ch.reset {
            self.chunks.clear();
        }
        self.chunks.resize_with(self.scene.chunk_count(), ChunkBuffers::default);
        for &c in &ch.dirty_chunks {
            self.chunks[c] = upload_chunk(device, self.scene.chunk_data(c));
        }
        if ch.terrain_changed {
            let terrain = self.scene.terrain();
            self.terrain_overlay = if terrain.indices.is_empty() {
                None
            } else {
                Some(MeshBuffers {
                    vbo: vertex_buffer(device, "terrain.overlay.vbo", &terrain.verts),
                    ibo: index_buffer(device, "terrain.overlay.ibo", &terrain.indices),
                    index_count: terrain.indices.len() as u32,
                })
            };
        }
        ch
    }

    /// Die Szene (Teile, Ausdehnung, Eingaben fuer den Live-Schnitt).
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Setzt die Richtung ZUM Directional-Light (Sonne, world). Das hemisphaerische
    /// Ambient (Himmel/Boden) bleibt bei den Default-Farben.
    pub fn set_light(&mut self, dir_to_light: [f32; 3]) {
        self.base_light = normalize4(dir_to_light);
        if self.sun.is_none() {
            self.globals.light_dir = self.base_light;
        }
    }

    /// Sonne der Sonnenstudie ([64]): Richtung ZUR Sonne (world, `shadow::sun_dir_world`) oder
    /// `None` (keine Studie, Sonne unter dem Horizont) und ob Schatten gezeichnet werden. Mit Sonne
    /// kommt das Licht aus ihrer Richtung; ohne gilt wieder `set_light`. Der Schattenpass laeuft
    /// erst im naechsten `render` und nur, wenn sich etwas geaendert hat.
    pub fn set_sun(&mut self, dir_to_sun: Option<[f32; 3]>, shadows: bool) {
        let dir = dir_to_sun.filter(|d| d.iter().all(|v| v.is_finite()) && d[1] > 0.0);
        if dir != self.sun || shadows != self.shadows_on {
            self.shadow_dirty = true;
        }
        self.sun = dir;
        self.shadows_on = shadows;
        self.globals.light_dir = match dir {
            Some(d) => normalize4(d),
            None => self.base_light,
        };
    }

    /// Kantenlaenge der Schattentextur der Kaskade 0 (Option, Standard `DEFAULT_SHADOW_MAP_SIZE`;
    /// geklemmt 256…8192 und aufs Geraete-Limit beim Anlegen).
    pub fn set_shadow_map_size(&mut self, size: u32) {
        let s = size.clamp(256, 8192);
        if s != self.shadow_size {
            self.shadow_size = s;
            self.shadow_dirty = true;
        }
    }

    /// Werden im naechsten Frame Schatten gezeichnet (Sonne ueber dem Horizont, Schalter an,
    /// beleuchteter Stil, Modell vorhanden)?
    pub fn shadows_active(&self) -> bool {
        self.sun.is_some()
            && self.shadows_on
            && self.style.draws_faces()
            && self.style.mesh_mode() < 1.5
            && self.scene.shadow_bounds().is_some()
    }

    /// Zahl der bisher gerenderten Schatten-Tiefenpaesse (Diagnose: nicht je Kamera-Frame).
    pub fn shadow_pass_count(&self) -> u32 {
        self.shadow_passes
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

    /// Setzt/loescht die durchscheinenden Koerper ([63] zulaessige Huelle): `tris` = TriangleList
    /// `[px,py,pz, r,g,b,a, ...]` (world, `GHOST_FLOATS_PER_VERTEX`), `lines` = LineList wie
    /// `set_highlight_lines`. Leere Slices loeschen; unvollstaendige Ecken am Ende fallen weg.
    pub fn set_ghost(&mut self, device: &wgpu::Device, tris: &[f32], lines: &[f32]) {
        // [214] Gleicher Inhalt wie zuletzt (jede Modellaenderung schickt die Huelle neu): nichts hochladen.
        if !self.keys.changed(DataSlot::Envelope, &[tris, lines]) {
            return;
        }
        let buf = |label: &str, v: &[f32], stride: usize, per: usize| {
            let n = v.len() / stride / per * per;
            (n > 0).then(|| LineBuffers {
                vbo: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents: bytemuck::cast_slice(&v[..n * stride]),
                    usage: wgpu::BufferUsages::VERTEX,
                }),
                vertex_count: n as u32,
            })
        };
        self.ghost = buf("ghost.vbo", tris, GHOST_FLOATS_PER_VERTEX, 3);
        self.ghost_lines = buf("ghost.lines.vbo", lines, GRID_FLOATS_PER_VERTEX, 2);
    }

    /// [180] Setzt/loescht die Geisterschicht (Elemente grauer Klassen) als ganzes Modell (ein Teil; leer loescht).
    pub fn set_ghost_model(&mut self, device: &wgpu::Device, part: PartInput) -> SceneChange {
        let empty = part.walls.is_empty() && part.slabs.is_empty() && part.meshes.is_empty() && part.roof_layers.is_empty();
        let upsert = if empty { Vec::new() } else { vec![PartEntry::new("", part)] };
        self.update_ghost_parts(device, PartsUpdate { reset: true, remove: Vec::new(), upsert })
    }

    /// [180]/[214] Teil-Update der Geisterschicht (Format wie [`Self::update_parts`]): vernetzt nur die geaenderten
    /// Teile und setzt nur die Klumpen neu, in denen sich etwas geaendert hat.
    pub fn update_ghost_parts(&mut self, device: &wgpu::Device, upd: PartsUpdate) -> SceneChange {
        let ch = self.ghost_scene.apply(upd);
        if ch.reset {
            self.ghost_chunks.clear();
        }
        self.ghost_chunks.resize_with(self.ghost_scene.chunk_count(), GhostChunk::default);
        let buf = |label: &str, v: &[f32], stride: usize| {
            (v.len() >= stride).then(|| LineBuffers {
                vbo: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents: bytemuck::cast_slice(v),
                    usage: wgpu::BufferUsages::VERTEX,
                }),
                vertex_count: (v.len() / stride) as u32,
            })
        };
        for &c in &ch.dirty_chunks {
            let (tris, lines) = crate::ghost::chunk_ghost_buffers(&self.ghost_scene.chunk_data(c));
            self.ghost_chunks[c] = GhostChunk {
                tris: buf("ghost.model.vbo", &tris, GHOST_FLOATS_PER_VERTEX),
                lines: buf("ghost.model.lines.vbo", &lines, GRID_FLOATS_PER_VERTEX),
            };
        }
        ch
    }

    /// [180] Ob eine Geisterschicht gesetzt ist (Test/Diagnose).
    pub fn has_ghost_model(&self) -> bool {
        self.ghost_chunks.iter().any(|g| g.tris.is_some() || g.lines.is_some()) || self.ghost_drawing_lines.is_some() || !self.ghost_pattern_data.is_empty()
    }

    /// [180] 2D-Spuren (`drawing`, LineList `[x y z r g b]`) und Flaechenmuster (`pattern`, `PATTERN_STRIDE`) der grauen
    /// Klassen: in der Geisterschicht gedaempft gezeichnet (`ghost::mute_lines`/`mute_pattern`). Leer loescht.
    pub fn set_ghost_lines(&mut self, device: &wgpu::Device, drawing: &[f32], pattern: &[f32]) {
        if !self.keys.changed(DataSlot::GhostLines, &[drawing, pattern]) {
            return;
        }
        let d = crate::ghost::mute_lines(drawing);
        self.ghost_drawing_lines = (!d.is_empty()).then(|| LineBuffers {
            vbo: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("ghost.drawing.vbo"),
                contents: bytemuck::cast_slice(&d),
                usage: wgpu::BufferUsages::VERTEX,
            }),
            vertex_count: (d.len() / GRID_FLOATS_PER_VERTEX) as u32,
        });
        self.ghost_pattern_data = crate::ghost::mute_pattern(pattern);
        self.pattern_lines = None;
        self.pattern_key = None;
    }

    /// Ob durchscheinende Koerper gesetzt sind (Test/Diagnose).
    pub fn has_ghost(&self) -> bool {
        self.ghost.is_some() || self.ghost_lines.is_some()
    }

    /// Setzt die Ansichtsschraffur-Linien (`pattern_lines::PATTERN_STRIDE` Floats je Linie); leer löscht.
    /// Die Auswahl nach Abstand passiert im nächsten `render`.
    pub fn set_pattern_lines(&mut self, data: &[f32]) {
        // [214] Unveraendert (jede Modellaenderung schickt die Muster neu): Auswahl und Puffer behalten.
        if !self.keys.changed(DataSlot::Pattern, &[data]) {
            return;
        }
        self.pattern_data = data.to_vec();
        self.pattern_lines = None;
        self.pattern_key = None;
    }

    /// Setzt/loescht die 2D-Zeichnungs-Unterlage (Boden-Spuren der
    /// `Drawing2D`-Elemente). Gleiches Format wie Grid-/Edge-/Highlight-Vertices:
    /// interleaved `[px,py,pz, r,g,b, ...]` (world), je 2 Vertices = 1 Segment.
    /// Leeres Slice -> Unterlage loeschen.
    ///
    /// Bewusst eine eigene LineList statt `MeshInput`-Ribbons: ein Kataster-DXF
    /// (Amtliche Vermessung einer Stadt) liefert Millionen Segmente. Als Ribbon-
    /// Meshes waeren das ueber `append_context_mesh` (jedes Dreieck doppelt,
    /// de-indiziert fuer Flat-Shading) GB-weise Vertexdaten — und der Weg dorthin
    /// (`set_model` als EIN JSON-String) sprengt vorher schon die
    /// JS-String-Laengengrenze. Als LineList + `&[f32]`-Binaertransfer bleibt es
    /// bei 2 Vertices je Segment ohne jede Textkodierung.
    pub fn set_drawing_lines(&mut self, device: &wgpu::Device, verts: &[f32]) {
        // [214] Unveraendert (jede Modellaenderung schickt die Spuren neu, ein Kataster hat Mio. Segmente): behalten.
        if !self.keys.changed(DataSlot::Drawing, &[verts]) {
            return;
        }
        if verts.is_empty() {
            self.drawing_lines = None;
            return;
        }
        let vbo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("drawing_lines.vbo"),
            contents: bytemuck::cast_slice(verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        self.drawing_lines = Some(LineBuffers {
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
        let mode = if active { 1.0 } else { 0.0 };
        if self.globals.section_plane != [n[0], n[1], n[2], w] || self.globals.mode[1] != mode {
            self.shadow_dirty = true;
        }
        self.globals.section_plane = [n[0], n[1], n[2], w];
        self.globals.mode[1] = mode;
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

    /// Setzt/loescht die Schnitt-Umrisslinien (Cut-Cap-Kanten, P2). `verts` =
    /// interleaved `[px,py,pz, r,g,b, ...]` (world-Meter + Farbe, TriangleList von
    /// Ribbon-Quads, `CUT_LINE_FLOATS_PER_VERTEX`), wie `section_fill::
    /// build_cut_cap_lines` liefert. Leeres Slice loescht die Linien. Wirkt erst
    /// beim naechsten `render`.
    pub fn set_cut_lines(&mut self, device: &wgpu::Device, verts: &[f32]) {
        if verts.is_empty() {
            self.cut_lines = None;
            return;
        }
        let vbo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("cut_lines.vbo"),
            contents: bytemuck::cast_slice(verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        self.cut_lines = Some(LineBuffers {
            vbo,
            vertex_count: (verts.len() / CUT_LINE_FLOATS_PER_VERTEX) as u32,
        });
    }

    /// Komfort: Schnittebene setzen UND die Cap-Geometrie aus den (gecachten)
    /// Waenden/Decken neu bauen — bei `active == false` werden Uniform-Flag und
    /// Caps geloescht. Buendelt `set_section_plane` + `build_cut_caps` +
    /// `set_cut_caps`, damit `web.rs` nur EINEN Aufruf braucht.
    #[allow(clippy::too_many_arguments)]
    pub fn update_section(
        &mut self,
        device: &wgpu::Device,
        active: bool,
        point: [f32; 3],
        normal: [f32; 3],
        walls: &[WallInput],
        slabs: &[SlabInput],
        roofs: &[RoofLayerInput],
    ) {
        self.set_section_plane(active, point, normal);
        if active {
            let plane = SectionPlane::new(point, normal);
            let caps = build_cut_caps(&plane, walls, slabs, roofs);
            self.set_cut_caps(device, &caps);
            // P2: die Schnitt-Umrisslinien (Fugen-/Materiallinien) je ueberlebendem
            // Cut-Cap-Rechteck aus DERSELBEN, dominanz-verschnittenen Rechteck-Menge.
            let lines = build_cut_cap_lines(&plane, walls, slabs, roofs);
            self.set_cut_lines(device, &lines);
        } else {
            self.set_cut_caps(device, &[]);
            self.set_cut_lines(device, &[]);
        }
    }

    /// Laedt die Material-Farbkarten fuer den Stil `Textured` als Textur-ARRAY hoch.
    /// `rgba` = dicht gepackte RGBA8-Bytes von `layer_count` Ebenen, jede exakt
    /// `TEXTURE_SIZE × TEXTURE_SIZE` (der Aufrufer skaliert/dekodiert die Bilder
    /// JS-seitig, siehe `web::set_material_textures`/`Wasm3DViewport`). Baut ein
    /// neues Array `[Schachbrett (Ebene 0), Material0 (Ebene 1), …]`, laedt es hoch
    /// und ersetzt die group-1-Bind-Group. Ein Wand-Band verweist per
    /// `WallInput::material_index` (1-basiert) auf seine Ebene; Baender ohne
    /// Material (`-1`) bleiben beim Schachbrett (Ebene 0). `layer_count == 0` (oder
    /// leere/zu kleine Daten) setzt auf das reine Schachbrett-Array zurueck.
    /// Setzt/ersetzt das aufs Gelaende drapierte Luftbild (SWISSIMAGE). `rgba` =
    /// dicht gepackte RGBA8-Bytes (`width*height*4`, zeilenweise von OBEN = Nord);
    /// `bbox = [min_x, min_y, max_x, max_y]` die Modell-Meter-Bounding-Box, die das
    /// Bild ausfuellt (x = Ost/world.x, y = Nord/world.z). Erzeugt Textur + Bind-
    /// Group (group 1) fuer die `aerial_pipeline`. Ungueltige/leere Eingabe loescht
    /// das Luftbild. Gezeichnet wird nur, wenn zusaetzlich Terrain vorliegt.
    pub fn set_aerial_texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        rgba: &[u8],
        width: u32,
        height: u32,
        bbox: [f32; 4],
    ) {
        let needed = (width as usize) * (height as usize) * 4;
        if width == 0 || height == 0 || rgba.len() < needed {
            self.aerial = None;
            return;
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("aerial.texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // srgb: die gesampelten Werte landen linear (Beleuchtung rechnet linear).
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        // write_texture verlangt bytes_per_row als Vielfaches von 256. Bei Bedarf
        // Zeilen in einen gepolsterten Puffer kopieren (sonst 1:1 hochladen).
        let unpadded = (width * 4) as usize;
        let padded = unpadded.div_ceil(256) * 256;
        let upload: std::borrow::Cow<[u8]> = if padded == unpadded {
            std::borrow::Cow::Borrowed(&rgba[..needed])
        } else {
            let mut buf = vec![0u8; padded * height as usize];
            for row in 0..height as usize {
                let src = &rgba[row * unpadded..row * unpadded + unpadded];
                buf[row * padded..row * padded + unpadded].copy_from_slice(src);
            }
            std::borrow::Cow::Owned(buf)
        };
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &upload,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded as u32),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bbox_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("aerial.bbox"),
            contents: bytemuck::cast_slice(&bbox),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("aerial.bind"),
            layout: &self.aerial_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.aerial_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: bbox_buf.as_entire_binding(),
                },
            ],
        });
        self.aerial = Some(AerialBuffers {
            texture,
            view,
            bbox: bbox_buf,
            bind_group,
        });
    }

    /// Loescht das drapierte Luftbild (das Gelaende erscheint wieder einfarbig/shaded).
    pub fn clear_aerial(&mut self) {
        self.aerial = None;
    }

    pub fn set_material_textures(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        rgba: &[u8],
        layer_count: u32,
    ) {
        let bytes_per_layer = (TEXTURE_SIZE * TEXTURE_SIZE * 4) as usize;
        // Ungueltige/leere Eingabe -> reines Schachbrett-Array (1 Ebene).
        let valid = layer_count > 0 && rgba.len() >= layer_count as usize * bytes_per_layer;
        let material_layers = if valid { layer_count } else { 0 };
        let total_layers = material_layers + 1; // Ebene 0 = Schachbrett

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("materials.texture_array"),
            size: wgpu::Extent3d {
                width: TEXTURE_SIZE,
                height: TEXTURE_SIZE,
                depth_or_array_layers: total_layers,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        // Ebene 0: Schachbrett-Fallback.
        let checker = build_checker_texture();
        let write_layer = |layer: u32, data: &[u8]| {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: 0,
                        z: layer,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(4 * TEXTURE_SIZE),
                    rows_per_image: Some(TEXTURE_SIZE),
                },
                wgpu::Extent3d {
                    width: TEXTURE_SIZE,
                    height: TEXTURE_SIZE,
                    depth_or_array_layers: 1,
                },
            );
        };
        write_layer(0, &checker);
        for i in 0..material_layers {
            let start = i as usize * bytes_per_layer;
            write_layer(i + 1, &rgba[start..start + bytes_per_layer]);
        }

        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        self.texture_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("materials.bind"),
            layout: &self.texture_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.texture_sampler),
                },
            ],
        });
        self.texture = texture;
        self.material_layer_count = total_layers;
        // Ebene 0 (Schachbrett) ist bereits geladen -> den Lazy-Upload ueberspringen.
        self.texture_uploaded = true;
    }

    /// Schatten vorbereiten ([64]): setzt `globals.shadow*`/`light_view_proj*`, legt die Schattentexturen
    /// bei Bedarf in voller Groesse an und schreibt die Uniforms der Tiefenpaesse. `true` = in diesem
    /// Frame die Tiefenpaesse rendern (nur nach einer Aenderung, nicht je Kamera-Frame). [186] Zwei
    /// Kaskaden (`shadow::cascades`): 0 eng aufs Gebaeude, 1 ueber alle eigenen Bauteile — diese nur,
    /// wenn sie deutlich mehr umfasst.
    fn prepare_shadows(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, camera: &Camera, aspect: f32) -> bool {
        self.globals.shadow = [0.0; 4];
        self.globals.shadow_far = [0.0; 4];
        if !self.shadows_active() {
            return false;
        }
        let (Some(sun), Some(bounds)) = (self.sun, self.scene.shadow_bounds()) else {
            return false;
        };
        let max = device.limits().max_texture_dimension_2d.max(1);
        let size = self.shadow_size.min(max).max(1);
        // Nahsicht: Kaskade 0 auf den sichtbaren Teil des Gebaeudes, Kaskade 1 fuer den Rest.
        let view = crate::shadow::view_box(self.shadow_view_box, bounds.core, crate::shadow::view_region(camera, aspect));
        self.shadow_view_box = view;
        let far_on = view.is_some() || crate::shadow::far_cascade_needed(&bounds);
        // Kaskade 1 nur angelegt, wenn benutzt (sonst 1x1-Platzhalter).
        let size_far = if far_on { far_map_size(size).min(max).max(1) } else { 1 };
        let Some([light, light_far]) = cascades(sun, &bounds, view, size, size_far.max(256)) else {
            return false;
        };
        if self.shadow_alloc != (size, size_far) {
            if self.shadow_alloc.0 != size {
                self.shadow_view = create_shadow_view(device, size);
            }
            if self.shadow_alloc.1 != size_far {
                self.shadow_view_far = create_shadow_view(device, size_far);
            }
            self.shadow_alloc = (size, size_far);
            self.bind_group = create_globals_bind_group(
                device,
                &self.bind_group_layout,
                &self.uniform,
                &self.shadow_view,
                &self.shadow_view_far,
                &self.shadow_sampler,
            );
            self.shadow_dirty = true;
        }
        // Normalen-Verschiebung ≈ 1.5 Texel, Tiefen-Bias ≈ 2 cm im Licht-NDC.
        let params = |m: &crate::math::Mat4, sz: u32| {
            let texel = texel_world_size(m, sz);
            let depth_range = 1.0 / m[10].abs().max(1e-9);
            [1.0, texel * 1.5, 1.0 / sz as f32, 0.02 / depth_range]
        };
        self.globals.light_view_proj = light;
        self.globals.shadow = params(&light, size);
        self.globals.light_view_proj_far = light_far;
        if far_on {
            self.globals.shadow_far = params(&light_far, size_far);
        }
        // Anderes Licht-Frustum (Nahsicht-Box gewechselt) = neuer Tiefenpass; sonst nicht je Kamera-Frame.
        if far_on != self.shadow_far_on || self.shadow_last != Some((light, light_far)) {
            self.shadow_far_on = far_on;
            self.shadow_last = Some((light, light_far));
            self.shadow_dirty = true;
        }
        if !self.shadow_dirty {
            return false;
        }
        let sg = ShadowGlobals { light_view_proj: light, section_plane: self.globals.section_plane, mode: self.globals.mode };
        queue.write_buffer(&self.shadow_uniform, 0, bytemuck::bytes_of(&sg));
        if far_on {
            let sg = ShadowGlobals { light_view_proj: light_far, ..sg };
            queue.write_buffer(&self.shadow_uniform_far, 0, bytemuck::bytes_of(&sg));
        }
        self.shadow_dirty = false;
        self.shadow_passes += 1;
        true
    }

    /// Rendert die schattenwerfenden Dreiecke aller Klumpen in die Schattentextur(en).
    fn encode_shadow_pass(&self, encoder: &mut wgpu::CommandEncoder) -> FrameStats {
        let mut st = FrameStats::default();
        let mut targets = vec![(&self.shadow_view, &self.shadow_bind_group)];
        if self.shadow_far_on {
            targets.push((&self.shadow_view_far, &self.shadow_bind_group_far));
        }
        for (view, bind) in targets {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("shadow.pass"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.shadow_pipeline);
            pass.set_bind_group(0, bind, &[]);
            for c in &self.chunks {
                let Some(m) = &c.mesh else { continue };
                if c.caster_count == 0 {
                    continue;
                }
                pass.set_vertex_buffer(0, m.vbo.slice(..));
                let ibo = c.caster_ibo.as_ref().unwrap_or(&m.ibo);
                pass.set_index_buffer(ibo.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..c.caster_count, 0, 0..1);
                st.add(c.caster_count);
            }
        }
        st
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
        // `mode.z` = Anzahl gueltiger Textur-Array-Ebenen (Klemmung im Textur-Shader).
        self.globals.mode[2] = self.material_layer_count as f32;
        // Schatten ([64]): Tiefenpass nur bei Aenderung (Sonne, Geometrie, Schnitt, Groesse).
        let shadow_pass = self.prepare_shadows(device, queue, camera, aspect);
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&self.globals));

        // Prozedurale Schachbrett-Textur einmalig hochladen (lazy, weil `new` keine
        // Queue bekommt — Signatur unveraendert). Danach steht sie fuer den Stil
        // `Textured` bereit; kostet ab dem zweiten Frame nichts mehr.
        if !self.texture_uploaded {
            let texel_data = build_checker_texture();
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &texel_data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(4 * TEXTURE_SIZE),
                    rows_per_image: Some(TEXTURE_SIZE),
                },
                wgpu::Extent3d {
                    width: TEXTURE_SIZE,
                    height: TEXTURE_SIZE,
                    depth_or_array_layers: 1,
                },
            );
            self.texture_uploaded = true;
        }

        self.ensure_depth(device, w, h);
        self.ensure_msaa(device, w, h);

        // Ansichtsschraffur: Linien je Kamera nach Abstand auswählen (Signatur-Cache wie die Silhouette).
        if self.style.draws_pattern_lines() && !(self.pattern_data.is_empty() && self.ghost_pattern_data.is_empty()) {
            let q = |v: f32, s: f32| (v * s).round() as i64;
            let key = [
                q(camera.eye[0], 20.0),
                q(camera.eye[1], 20.0),
                q(camera.eye[2], 20.0),
                q(camera.target[0], 20.0),
                q(camera.target[1], 20.0),
                q(camera.target[2], 20.0),
                q(camera.ortho_half_height, 20.0),
                h as i64,
            ];
            if self.pattern_key != Some(key) {
                let mut verts = crate::pattern_lines::select_pattern_lines(&self.pattern_data, camera, h as f32);
                verts.extend(crate::pattern_lines::select_pattern_lines(&self.ghost_pattern_data, camera, h as f32));
                self.pattern_lines = (!verts.is_empty()).then(|| LineBuffers {
                    vbo: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("pattern_lines.vbo"),
                        contents: bytemuck::cast_slice(&verts),
                        usage: wgpu::BufferUsages::VERTEX,
                    }),
                    vertex_count: (verts.len() / GRID_FLOATS_PER_VERTEX) as u32,
                });
                self.pattern_key = Some(key);
            }
        }

        // Silhouette (Stil `Contour`) je Blickwinkel neu ableiten — aber nur, wenn
        // sich die Kamera merklich bewegt hat (Signatur-Cache), nicht blind je Frame.
        if self.style == RenderStyle::Contour && self.scene.has_edges() {
            let eye = camera.eye;
            let mut fwd = [
                camera.target[0] - eye[0],
                camera.target[1] - eye[1],
                camera.target[2] - eye[2],
            ];
            let fl = (fwd[0] * fwd[0] + fwd[1] * fwd[1] + fwd[2] * fwd[2]).sqrt();
            if fl > 1e-6 {
                fwd = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
            }
            let perspective = matches!(camera.projection, crate::types::Projection::Perspective);
            // Signatur: Auge (0.01 m) + Blickrichtung (0.001). Perspektive haengt
            // von der Auge-Position ab, Ortho nur von der Richtung — beide erfasst.
            let q = |v: f32, s: f32| (v * s).round() as i64;
            let key = [
                q(eye[0], 100.0),
                q(eye[1], 100.0),
                q(eye[2], 100.0),
                q(fwd[0], 1000.0),
                q(fwd[1], 1000.0),
                q(fwd[2], 1000.0),
            ];
            if self.silhouette.is_none() || self.silhouette_key != Some(key) {
                let verts = build_silhouette_edges(self.scene.edge_adj(), eye, fwd, perspective);
                self.silhouette = if verts.is_empty() {
                    None
                } else {
                    let vbo = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("silhouette.vbo"),
                        contents: bytemuck::cast_slice(&verts),
                        usage: wgpu::BufferUsages::VERTEX,
                    });
                    Some(LineBuffers {
                        vbo,
                        vertex_count: (verts.len() / EDGE_FLOATS_PER_VERTEX) as u32,
                    })
                };
                self.silhouette_key = Some(key);
            }
        }

        // Punktwolken: Viewport/Punktgroesse in die Uniforms (feste Pixelgroesse).
        self.points.prepare(queue, (w, h));

        let depth_view = &self.depth.as_ref().unwrap().view;
        let msaa_view = &self.msaa.as_ref().unwrap().view;

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("3d.encoder"),
        });
        let mut st = FrameStats::default();
        if shadow_pass {
            let sh = self.encode_shadow_pass(&mut encoder);
            st.shadow_draws = sh.draws;
        }
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

            // Live-Schnitt aktiv? Dann erzwingen wir die Modell-Kanten ZUSAETZLICH
            // zum aktuellen Stil (unabhaengig von `draws_edges()`) — Nutzer-Report:
            // duenne, schraeg angeschnittene Bauteile (Zwischenwaende, Giebel-Enden,
            // einzelne Material-Schichten) haben aus vielen Blickwinkeln eine fast
            // unsichtbare (kantige) Stirnflaeche, waehrend ihre (flache) Schnitt-
            // kappe voll sichtbar bleibt — das wirkt wie ein abgeloestes,
            // "schwebendes" Element. Die dunklen Kanten (bereits vorhanden fuer
            // wireframe/hidden/shaded-edges, `edges::build_mesh_edges`, tiefen-
            // getestet + von der Schnittebene gekappt wie das Mesh selbst) zeichnen
            // jede Bauteilkante nach, auch wenn ihre Flaeche praktisch auf Null
            // Bildschirmbreite zusammenfaellt — das verbindet Kappe und Bauteil
            // sichtbar, ohne die Kamera zu bewegen oder Geometrie zu aendern.
            let force_edges_for_section = self.globals.mode[1] > 0.5;
            // 1) Gefuellte Flaechen — in allen Stilen ausser "wireframe". Im
            //    Hidden-Line-Stil die leicht nach hinten gebiaste Pipeline, damit
            //    die folgenden Kanten sauber obenauf liegen. Bei aktivem Schnitt
            //    ebenso (die Kanten werden dann erzwungen, s.o.).
            if self.style.draws_faces() {
                if self.style == RenderStyle::Textured {
                    // Texturierter Pfad: eigene Pipeline + zweiter Vertex-Puffer
                    // ([pos, normal, uv]) + zusaetzliche Textur-Bind-Group (group 1).
                    // Globals bleiben group 0. Fehlt der texturierte Puffer (kein
                    // Mesh geladen), wird nichts gezeichnet.
                    pass.set_pipeline(&self.textured_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    pass.set_bind_group(1, &self.texture_bind_group, &[]);
                    for (m, t) in self.chunks.iter().filter_map(|c| Some((c.mesh.as_ref()?, c.textured.as_ref()?))) {
                        pass.set_vertex_buffer(0, m.vbo.slice(..));
                        pass.set_vertex_buffer(1, t.layer_vbo.slice(..));
                        pass.set_index_buffer(m.ibo.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..m.index_count, 0, 0..1);
                        st.add(m.index_count);
                    }
                } else {
                    let face_pipeline = if self.style.needs_biased_face_pipeline()
                        || force_edges_for_section
                    {
                        &self.hidden_face_pipeline
                    } else {
                        &self.pipeline
                    };
                    pass.set_pipeline(face_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    for m in self.chunks.iter().filter_map(|c| c.mesh.as_ref()) {
                        pass.set_vertex_buffer(0, m.vbo.slice(..));
                        pass.set_index_buffer(m.ibo.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..m.index_count, 0, 0..1);
                        st.add(m.index_count);
                    }
                }
            }

            // 1a) Luftbild-Drape: das Terrain-Overlay ein zweites Mal texturiert
            //     ueber das (deckungsgleiche) Terrain im Hauptpuffer zeichnen. Nur
            //     wenn Flaechen gezeichnet werden, ein Luftbild gesetzt ist UND ein
            //     Terrain-Overlay vorliegt. Der Depth-Bias der Pipeline haelt es vor
            //     dem Terrain (kein Z-Fighting). group 1 = Bild-Textur + Bbox.
            if self.style.draws_faces() {
                if let (Some(a), Some(t)) = (&self.aerial, &self.terrain_overlay) {
                    pass.set_pipeline(&self.aerial_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    pass.set_bind_group(1, &a.bind_group, &[]);
                    pass.set_vertex_buffer(0, t.vbo.slice(..));
                    pass.set_index_buffer(t.ibo.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..t.index_count, 0, 0..1);
                    st.add(t.index_count);
                }
            }

            // 1a2) Schraffur-Kappen an freien Wandenden (STATISCH, unabhaengig vom
            //      Live-Schnitt-Zustand — `mesh::build_free_wall_end_caps`): ein
            //      unangeschlossenes Wandende zeigt die Bauteil-Schraffur statt der
            //      Flaechenfarbe, wie ein echter Schnitt. Dieselbe `cap_pipeline`
            //      (Bias zur Kamera) wie die Live-Schnitt-Kappen — sitzt exakt auf
            //      der (weiterhin vorhandenen) flach eingefaerbten End-Kappe im
            //      Hauptpuffer und gewinnt den Tiefentest.
            if self.style.draws_faces() {
                pass.set_pipeline(&self.cap_pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                for wc in self.chunks.iter().filter_map(|c| c.caps.as_ref()) {
                    pass.set_vertex_buffer(0, wc.vbo.slice(..));
                    pass.draw(0..wc.vertex_count, 0..1);
                    st.add(wc.vertex_count);
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
                st.add(c.vertex_count);
            }

            // 1c) Schnitt-Umrisslinien (Cut-Cap-Kanten, P2) NACH den Caps: die
            //     Material-/Fugenlinien je ueberlebendem Cut-Rechteck (Ribbon-
            //     TriangleList, eigener Stil je Schicht). Ohne Tiefentest (Always)
            //     liegen sie sichtbar auf den Caps; der Kamera-Lift in
            //     `build_cut_cap_lines` haelt sie vor der Ebenen-Kappung.
            if let Some(cl) = &self.cut_lines {
                pass.set_pipeline(&self.cut_line_pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.set_vertex_buffer(0, cl.vbo.slice(..));
                pass.draw(0..cl.vertex_count, 0..1);
                st.add(cl.vertex_count);
            }

            // 2) Modell-Kanten (wireframe/hidden, ODER erzwungen bei aktivem
            //    Schnitt, s.o.) — LineList-Pipeline (wie Grid). Tiefengetestet
            //    gegen die (gebiasten) Flaechen -> verdeckte Kanten fallen weg.
            //    Im Wireframe ohne Flaechen -> alle Kanten sichtbar.
            if self.style.draws_edges() || force_edges_for_section {
                pass.set_pipeline(&self.grid_pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                for e in self.chunks.iter().filter_map(|c| c.edges.as_ref()) {
                    pass.set_vertex_buffer(0, e.vbo.slice(..));
                    pass.draw(0..e.vertex_count, 0..1);
                    st.add(e.vertex_count);
                }
            }

            // 2a) Ansichtsschraffur auf den Flächen ([100]) in den Kanten-Stilen (Verdeckt, Schattiert mit
            //     Kanten): tiefengetestet gegen die gebiasten Flächen, knapp vor der Fläche angehoben.
            if self.style.draws_pattern_lines() {
                if let Some(pl) = &self.pattern_lines {
                    pass.set_pipeline(&self.grid_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    pass.set_vertex_buffer(0, pl.vbo.slice(..));
                    pass.draw(0..pl.vertex_count, 0..1);
                    st.add(pl.vertex_count);
                }
            }

            // 2b) „Nur Konturen" (Stil Contour): die blickabhaengige Silhouette
            //     obenauf (tiefengetestet gegen die gebiasten Flaechen -> nur
            //     sichtbare Umrisslinien). Gleiche LineList-Pipeline wie die
            //     Feature-Edges, aber der reduzierte Kantensatz.
            if self.style == RenderStyle::Contour {
                if let Some(s) = &self.silhouette {
                    pass.set_pipeline(&self.grid_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    pass.set_vertex_buffer(0, s.vbo.slice(..));
                    pass.draw(0..s.vertex_count, 0..1);
                    st.add(s.vertex_count);
                }
            }

            // 2c) 2D-Zeichnungs-Unterlage (Boden-Spuren der Drawing2D-Elemente)
            //     als LineList — dieselbe tiefengetestete Pipeline wie Gitter/
            //     Kanten, damit Bauteile die Unterlage korrekt verdecken. Stil-
            //     unabhaengig: die Referenzlinien gehoeren in jeder Darstellung
            //     dazu (s. `set_drawing_lines`).
            if let Some(dl) = &self.drawing_lines {
                pass.set_pipeline(&self.grid_pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.set_vertex_buffer(0, dl.vbo.slice(..));
                pass.draw(0..dl.vertex_count, 0..1);
                st.add(dl.vertex_count);
            }

            // 2d) Punktwolken ([27]): Instanz-Quads, tiefengetestet gegen Modell/Unterlage —
            //     stilunabhaengig (gemessene Bestandsdaten gehoeren in jede Darstellung).
            self.points.draw(&mut pass, &self.bind_group);

            // 3) Bodengitter NACH dem Modell zeichnen (gemeinsamer Tiefenpuffer ->
            //    das Modell verdeckt das Gitter korrekt). Unabhaengig vom Stil, nur
            //    wenn sichtbar + vorhanden.
            if self.grid_visible {
                if let Some(g) = &self.grid {
                    pass.set_pipeline(&self.grid_pipeline);
                    pass.set_bind_group(0, &self.bind_group, &[]);
                    pass.set_vertex_buffer(0, g.vbo.slice(..));
                    pass.draw(0..g.vertex_count, 0..1);
                    st.add(g.vertex_count);
                }
            }

            // 3b) Durchscheinende Koerper ([63] zulaessige Huelle): Kanten tiefengetestet wie das
            //     Gitter, dann die Flaechen mit Alpha-Blending (ohne Tiefen-Write) nach allem Opaken.
            //     [180] Davor die Geisterschicht der grauen Klassen (gleiche Pipelines).
            let ghost_model_lines = self.ghost_chunks.iter().filter_map(|g| g.lines.as_ref());
            for gl in ghost_model_lines.chain([&self.ghost_drawing_lines, &self.ghost_lines].into_iter().flatten()) {
                pass.set_pipeline(&self.grid_pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.set_vertex_buffer(0, gl.vbo.slice(..));
                pass.draw(0..gl.vertex_count, 0..1);
                st.add(gl.vertex_count);
            }
            let ghost_model = self.ghost_chunks.iter().filter_map(|g| g.tris.as_ref());
            for g in ghost_model.chain(self.ghost.as_ref()) {
                pass.set_pipeline(&self.ghost_pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.set_vertex_buffer(0, g.vbo.slice(..));
                pass.draw(0..g.vertex_count, 0..1);
                st.add(g.vertex_count);
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
                st.add(hl.vertex_count);
            }
        }
        queue.submit(std::iter::once(encoder.finish()));
        self.frame_stats = st;
    }

    /// [214] Zahlen des letzten `render` (Messung, `render_png --bench`).
    pub fn frame_stats(&self) -> FrameStats {
        self.frame_stats
    }
}

#[cfg(test)]
mod data_key_tests {
    use super::{content_key, DataKeys, DataSlot};

    /// [214] Gleiche Daten erkennt der Schlüssel wieder (kein neuer Puffer), jede Änderung (Wert, Länge, Aufteilung
    /// auf die Folgen) nicht; die Fächer sind unabhängig.
    #[test]
    fn gleiche_daten_werden_nicht_neu_gesetzt() {
        let a = [1.0f32, 2.0, 3.0];
        assert_eq!(content_key(&[&a]), content_key(&[&[1.0, 2.0, 3.0]]));
        assert_ne!(content_key(&[&a]), content_key(&[&[1.0, 2.0, 3.5]]));
        assert_ne!(content_key(&[&[1.0]]), content_key(&[&[1.0, 0.0]]), "Länge zählt");
        assert_ne!(content_key(&[&a, &[]]), content_key(&[&[], &a]), "Aufteilung zählt");
        assert_ne!(content_key(&[&[0.0]]), content_key(&[&[-0.0]]), "Bits, nicht Werte");
        let mut k = DataKeys::default();
        assert!(k.changed(DataSlot::Drawing, &[&a]), "erstes Mal");
        assert!(!k.changed(DataSlot::Drawing, &[&a]), "unverändert");
        assert!(k.changed(DataSlot::Pattern, &[&a]), "anderes Fach");
        assert!(k.changed(DataSlot::Drawing, &[&[]]), "geleert");
        assert!(!k.changed(DataSlot::Drawing, &[&[]]));
    }
}

#[cfg(test)]
mod render_style_tests {
    use super::RenderStyle;

    #[test]
    fn shaded_edges_parses_from_api_string() {
        assert_eq!(
            RenderStyle::from_str_or_shaded("shaded-edges"),
            RenderStyle::ShadedEdges
        );
    }

    #[test]
    fn unknown_style_falls_back_to_shaded() {
        assert_eq!(RenderStyle::from_str_or_shaded("bogus"), RenderStyle::Shaded);
    }

    #[test]
    fn shaded_edges_uses_material_colors_like_shaded() {
        // mode.x = 0.0 -> Material/Bauteilfarben, NICHT weiss (1.0) oder
        // Hidden-Line-Flaechen (2.0) — der BIM-Look behaelt echte Farben.
        assert_eq!(RenderStyle::ShadedEdges.mesh_mode(), 0.0);
        assert_eq!(RenderStyle::Shaded.mesh_mode(), RenderStyle::ShadedEdges.mesh_mode());
    }

    #[test]
    fn shaded_edges_draws_both_faces_and_edges() {
        assert!(RenderStyle::ShadedEdges.draws_faces());
        assert!(RenderStyle::ShadedEdges.draws_edges());
        assert!(RenderStyle::ShadedEdges.draws_pattern_lines() && RenderStyle::Hidden.draws_pattern_lines());
        assert!(!RenderStyle::Wireframe.draws_pattern_lines() && !RenderStyle::Shaded.draws_pattern_lines());
    }

    #[test]
    fn shaded_edges_needs_biased_face_pipeline_like_hidden() {
        assert!(RenderStyle::ShadedEdges.needs_biased_face_pipeline());
        assert!(RenderStyle::Hidden.needs_biased_face_pipeline());
        assert!(!RenderStyle::Shaded.needs_biased_face_pipeline());
    }

    #[test]
    fn plain_shaded_style_unaffected_by_new_variant() {
        assert!(!RenderStyle::Shaded.draws_edges());
        assert!(RenderStyle::Shaded.draws_faces());
    }
}

/// Schatten ([64]) auf einer echten GPU: im Linux-Container über Vulkan/lavapipe, auf macOS Metal.
/// Ohne Adapter (CI ohne Grafik) wird der Test still übersprungen.
#[cfg(test)]
mod shadow_gpu_tests {
    use super::{RenderStyle, Renderer};
    use crate::types::{Camera, WallInput};

    fn device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()?;
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()
    }

    fn walls() -> Vec<WallInput> {
        let w = |a: [f32; 2], b: [f32; 2]| -> WallInput {
            let mut w: WallInput = serde_json::from_str(r#"{"start":[0,0],"end":[1,0],"thickness":0.2,"height":6}"#).unwrap();
            w.start = a;
            w.end = b;
            w
        };
        vec![w([0.0, 0.0], [8.0, 0.0]), w([8.0, 0.0], [8.0, 6.0]), w([8.0, 6.0], [0.0, 6.0]), w([0.0, 6.0], [0.0, 0.0])]
    }

    /// Der Tiefenpass läuft nur nach einer Änderung (Sonne, Geometrie, Schalter), nicht je Kamera-Frame;
    /// unter dem Horizont und in den Linien-Stilen gar nicht.
    #[test]
    fn schattenpass_nur_bei_aenderung() {
        let Some((device, queue)) = device() else {
            eprintln!("kein GPU-Adapter: Test übersprungen");
            return;
        };
        let format = wgpu::TextureFormat::Rgba8UnormSrgb;
        let mut r = Renderer::new(&device, format);
        r.upload_walls(&device, &walls());
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: 64, height: 48, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = tex.create_view(&Default::default());
        let mut cam = Camera { eye: [20.0, 15.0, 20.0], target: [4.0, 2.0, 3.0], ..Camera::default() };
        let frame = |r: &mut Renderer, cam: &Camera| r.render(&device, &queue, &view, cam, (64, 48));

        frame(&mut r, &cam);
        assert_eq!(r.shadow_pass_count(), 0, "ohne Sonne kein Schattenpass");
        r.set_sun(crate::shadow::sun_dir_world(135.0, 30.0), true);
        assert!(r.shadows_active());
        frame(&mut r, &cam);
        assert_eq!(r.shadow_pass_count(), 1);
        for k in 0..5 {
            cam.eye[0] += k as f32;
            frame(&mut r, &cam);
        }
        assert_eq!(r.shadow_pass_count(), 1, "Kamera bewegt: kein neuer Schattenpass");
        r.set_sun(crate::shadow::sun_dir_world(150.0, 32.0), true);
        frame(&mut r, &cam);
        assert_eq!(r.shadow_pass_count(), 2, "neue Sonne");
        r.upload_walls(&device, &walls()[..2]);
        frame(&mut r, &cam);
        assert_eq!(r.shadow_pass_count(), 3, "neue Geometrie");
        r.set_render_style(RenderStyle::Hidden);
        r.set_sun(crate::shadow::sun_dir_world(160.0, 33.0), true);
        frame(&mut r, &cam);
        assert_eq!(r.shadow_pass_count(), 3, "Verdeckt: keine Schatten");
        r.set_render_style(RenderStyle::Shaded);
        r.set_sun(crate::shadow::sun_dir_world(160.0, -4.0), true);
        assert!(!r.shadows_active(), "Sonne unter dem Horizont");
        frame(&mut r, &cam);
        assert_eq!(r.shadow_pass_count(), 3);
    }
}
