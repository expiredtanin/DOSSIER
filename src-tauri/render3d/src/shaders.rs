// WGSL-Shader des nativen 3D-Renderers. Als Konstante hier, damit die Quelle auch
// ohne aktives GPU-Feature (headless) im Repo pruefbar bleibt (naga-Test, Muster:
// render2d/shaders).
//
// Beleuchtung: EIN Directional-Light (Sonne) + ambienter Grundterm — das Pendant
// zur three.js-Sicht (AmbientLight 0.6 + DirectionalLight 1.1 bei (6,12,4), siehe
// Viewport3D.tsx). PBR (Rauheit/Metallik/Texturen) folgt in spaeteren Milestones.
//
// Uniform-Layout (group(0) binding(0)):
//   view_proj  : mat4x4<f32>  world -> Clip (proj * view)
//   light_dir  : vec4<f32>    Richtung ZUM Licht (world, xyz; w ungenutzt)
//   ambient    : vec4<f32>    ambienter Grundfaktor (rgb; a ungenutzt)
//
// Vertex-Attribute: position (world), normal (world), color (Albedo).

/// Der einzige Shader (Vertex + Fragment). Diffuse Lambert-Beleuchtung mit einem
/// Directional-Light plus ambientem Sockel — GPU-Aequivalent des three.js-Setups.
pub const MESH_WGSL: &str = r#"
struct Globals {
    view_proj  : mat4x4<f32>,
    light_dir  : vec4<f32>,
    ambient    : vec4<f32>,
};
@group(0) @binding(0) var<uniform> globals : Globals;

struct VsIn {
    @location(0) position : vec3<f32>,
    @location(1) normal   : vec3<f32>,
    @location(2) color    : vec3<f32>,
};

struct VsOut {
    @builtin(position) clip_pos : vec4<f32>,
    @location(0) world_normal : vec3<f32>,
    @location(1) color        : vec3<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clip_pos = globals.view_proj * vec4<f32>(in.position, 1.0);
    out.world_normal = in.normal;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    let n = normalize(in.world_normal);
    let l = normalize(globals.light_dir.xyz);
    // Lambert-Diffusanteil; Rueckseiten (n.l < 0) tragen nichts bei.
    let diffuse = max(dot(n, l), 0.0);
    // Ambienter Sockel (Albedo * ambient) + gerichteter Anteil (Albedo * diffuse).
    let shaded = in.color * globals.ambient.rgb + in.color * diffuse;
    return vec4<f32>(shaded, 1.0);
}
"#;
