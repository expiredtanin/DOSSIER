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
//   mode         : vec4<f32>    x = Darstellungsart (0 = shaded/Material,
//                               1 = weiss/Clay, 2 = hidden-Line-Flaechen/flach-weiss)
//
// Vertex-Attribute: position (world), normal (world), color (Albedo).
//
// FILL-LIGHT: Zusaetzlich zum Haupt-Directional (Sonne) wirkt ein schwaches
// GEGEN-Fuelllicht aus der entgegengesetzten Azimut-Richtung (leicht von oben),
// abgeleitet aus der Sonnenrichtung — es hebt die vom Hauptlicht abgewandten
// Flaechen an, damit sie nicht in reinem Schwarz absaufen. Dezent (≈ 0.28 der
// Sonne, leicht kuehl), physikalisch als Himmels-/Bounce-Fuellung plausibel.

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
    let style = globals.mode.x;

    // Hemisphaerisches Ambient: Mischfaktor aus der Vertikal-Komponente der
    // Normalen (n.y = +1 -> voll Himmel, n.y = -1 -> voll Boden).
    let hemi_t = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
    let ambient = mix(globals.ground_color.rgb, globals.sky_color.rgb, hemi_t);

    // Gerichteter Lambert-Anteil (Sonne); Rueckseiten (n.l < 0) tragen nichts bei.
    let diffuse = max(dot(n, l), 0.0) * globals.sun_color.rgb;

    // Schwaches Gegen-Fuelllicht: aus entgegengesetztem Azimut, leicht von oben,
    // aus der Sonnenrichtung abgeleitet — hebt abgewandte Flaechen an (kein
    // reines Schwarz). Dezent (0.28) und leicht kuehl getoent.
    let fill_l = normalize(vec3<f32>(-l.x, abs(l.y) * 0.35 + 0.15, -l.z));
    let fill = max(dot(n, fill_l), 0.0) * globals.sun_color.rgb
        * vec3<f32>(0.24, 0.27, 0.30);

    // Weiss-Modus (Clay, style==1) bzw. Hidden-Flaechen (style==2): Material-/
    // Vertexfarbe durch ein einheitliches Hell ersetzen. Clay = warmes Hellgrau,
    // Hidden = nahezu Weiss (damit die dunklen Kanten obenauf klar lesbar sind).
    let clay = vec3<f32>(0.82, 0.82, 0.80);
    let paper = vec3<f32>(0.97, 0.97, 0.97);
    var albedo = in.color;
    if (style > 1.5) {
        albedo = paper;
    } else if (style > 0.5) {
        albedo = clay;
    }

    var shaded = albedo * (ambient + diffuse + fill);

    // Sanfte Kantenbetonung: senkrechte Flaechen (n.y nahe 0) minimal abdunkeln,
    // damit sich Waende vom hellen Deckel/Boden abheben (ohne Postprocessing).
    let edge = 0.90 + 0.10 * abs(n.y);
    shaded = shaded * edge;

    // Hidden-Line-Flaechen: sehr flach halten (fast unlit, nahezu weiss), damit
    // die dunklen Modell-Kanten die Form tragen und die Flaechen nur den Depth-
    // Buffer fuellen (verdeckte Kanten wegschneiden). Leichte Hemi-Toenung bleibt,
    // damit die Silhouette auch ohne Kante nicht voellig verschwindet.
    if (style > 1.5) {
        shaded = albedo * (0.88 + 0.12 * hemi_t);
    }

    return vec4<f32>(shaded, 1.0);
}
"#;

/// WGSL des Referenz-Bodengitters (grid.rs). Eigene, schlanke `LineList`-Pipeline:
/// KONSTANTE Farbe (unlit — unabhaengig von Normalen/Licht), nur View-Projektion
/// aus demselben `Globals`-Uniform (group(0) binding(0)) wie die Mesh-Pipeline.
/// Vertex-Attribute: position (world), color (rgb). Depth-Test laeuft ueber den
/// gemeinsamen Tiefenpuffer, sodass das Modell das Gitter korrekt verdeckt.
pub const GRID_WGSL: &str = r#"
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
    @location(1) color    : vec3<f32>,
};

struct VsOut {
    @builtin(position) clip_pos : vec4<f32>,
    @location(0) color : vec3<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clip_pos = globals.view_proj * vec4<f32>(in.position, 1.0);
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}
"#;
