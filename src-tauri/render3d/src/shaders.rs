// WGSL-Shader des nativen 3D-Renderers. Als Konstante hier, damit die Quelle auch
// ohne aktives GPU-Feature (headless) im Repo pruefbar bleibt (naga-Test, Muster:
// render2d/shaders).
//
// Beleuchtung: HEMISPHAERISCHES Umgebungslicht (Himmel oben / Boden unten) plus
// EIN Directional-Light (Sonne). Das hemisphaerische Ambient toent jede Flaeche je
// nach ihrer Normalen-Neigung: Deckflaechen bekommen das helle Himmelslicht, nach
// unten weisende Flaechen das dunklere Bodenlicht, senkrechte Waende einen Misch-
// wert. Dadurch liest sich das Volumen sofort ab (Architektur-Massenmodell) — ohne
// teures Postprocessing. Zusaetzlich betont ein Facing-Term (n gegen die Blick-
// naeherung „nach oben") die Kanten sanft ab.
//
// Uniform-Layout (group(0) binding(0)):
//   view_proj    : mat4x4<f32>  world -> Clip (proj * view)
//   light_dir    : vec4<f32>    Richtung ZUM Licht (world, xyz; w = Sonnen-Staerke)
//   sky_color    : vec4<f32>    Himmels-Ambient (rgb; von oben)
//   ground_color : vec4<f32>    Boden-Ambient (rgb; von unten)
//   sun_color    : vec4<f32>    Farbe/Staerke des Directional-Lights (rgb)
//   mode         : vec4<f32>    x = Darstellungsart (0 = shaded/Material, 1 = weiss/Clay)
//
// Vertex-Attribute: position (world), normal (world), color (Albedo).

/// Der einzige Shader (Vertex + Fragment). Hemisphaerisches Ambient (Himmel/Boden)
/// + Lambert-Directional — GPU-Aequivalent eines Architektur-Massenmodell-Lichts.
pub const MESH_WGSL: &str = r#"
struct Globals {
    view_proj    : mat4x4<f32>,
    light_dir    : vec4<f32>,
    sky_color    : vec4<f32>,
    ground_color : vec4<f32>,
    sun_color    : vec4<f32>,
    mode         : vec4<f32>,
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

    // Hemisphaerisches Ambient: Mischfaktor aus der Vertikal-Komponente der
    // Normalen (n.y = +1 -> voll Himmel, n.y = -1 -> voll Boden).
    let hemi_t = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
    let ambient = mix(globals.ground_color.rgb, globals.sky_color.rgb, hemi_t);

    // Gerichteter Lambert-Anteil (Sonne); Rueckseiten (n.l < 0) tragen nichts bei.
    let diffuse = max(dot(n, l), 0.0) * globals.sun_color.rgb;

    // Weiss-Modus (Clay-Look): Material-/Vertexfarbe durch ein einheitliches
    // Hellgrau ersetzen, Beleuchtung (Ambient + Directional) bleibt aktiv — so
    // liest sich die Volumetrie ohne Bauteil-Farben ab (Vectorworks „white").
    let albedo = mix(in.color, vec3<f32>(0.82, 0.82, 0.80), globals.mode.x);

    var shaded = albedo * (ambient + diffuse);

    // Sanfte Kantenbetonung: senkrechte Flaechen (n.y nahe 0) minimal abdunkeln,
    // damit sich Waende vom hellen Deckel/Boden abheben (ohne Postprocessing).
    let edge = 0.90 + 0.10 * abs(n.y);
    shaded = shaded * edge;

    return vec4<f32>(shaded, 1.0);
}
"#;
