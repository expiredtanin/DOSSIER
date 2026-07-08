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
    view_proj     : mat4x4<f32>,
    light_dir     : vec4<f32>,
    sky_color     : vec4<f32>,
    ground_color  : vec4<f32>,
    sun_color     : vec4<f32>,
    mode          : vec4<f32>,
    section_plane : vec4<f32>,
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
    @location(2) world_pos    : vec3<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clip_pos = globals.view_proj * vec4<f32>(in.position, 1.0);
    out.world_normal = in.normal;
    out.color = in.color;
    out.world_pos = in.position;
    return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    // Live-Schnitt: mode.y > 0.5 aktiviert die Kappung. section_plane.xyz =
    // Ebenennormale (= Blickrichtung), .w = -dot(n, point). depth > 0 heisst
    // "hinter der Ebene" (in Blickrichtung) -> dieses Material wird weggeschnitten,
    // die Schnittflaechen-Caps (cap_pipeline) fuellen die entstehende Wunde.
    if (globals.mode.y > 0.5) {
        if (dot(in.world_pos, globals.section_plane.xyz) + globals.section_plane.w > 0.0) {
            discard;
        }
    }
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

/// WGSL des TEXTURIERTEN Wand-Pfades (`RenderStyle::Textured`, gpu::textured_pipeline).
/// GLEICHE Beleuchtung wie `MESH_WGSL` (hemisphaerisches Ambient Himmel/Boden +
/// Lambert-Directional + Gegen-Fuelllicht + Kantenbetonung) — nur die ALBEDO kommt
/// aus einer Bild-Textur (`textureSample`) statt aus der Vertexfarbe. Vertex-Layout
/// [pos vec3, normal vec3, uv vec2]; `Globals` bleibt group(0) binding(0) unveraendert,
/// die Textur haengt in group(1). Die Weiss-/Hidden-Modi (`mode.x`) sind hier nicht
/// relevant: `Textured` reicht `mode.x == 0` (Material) durch (siehe gpu.rs).
pub const MESH_TEXTURED_WGSL: &str = r#"
struct Globals {
    view_proj     : mat4x4<f32>,
    light_dir     : vec4<f32>,
    sky_color     : vec4<f32>,
    ground_color  : vec4<f32>,
    sun_color     : vec4<f32>,
    mode          : vec4<f32>,
    section_plane : vec4<f32>,
};
@group(0) @binding(0) var<uniform> globals : Globals;

// Material-Textur-ARRAY + Sampler (group 1). Sampler mit Repeat/Linear (siehe
// gpu.rs) -> das weltmassstaebliche UV-Raster kachelt sich ueber die Wandflaechen.
// Ebene 0 = Fallback-Schachbrett; Ebenen 1..N = per `set_material_textures`
// hochgeladene Material-Farbkarten. Die Ebene je Vertex kommt aus einem ZWEITEN
// Vertex-Buffer (@location(3)); `mode.z` traegt die Anzahl gueltiger Ebenen.
@group(1) @binding(0) var tex  : texture_2d_array<f32>;
@group(1) @binding(1) var samp : sampler;

struct VsIn {
    @location(0) position : vec3<f32>,
    @location(1) normal   : vec3<f32>,
    @location(2) uv       : vec2<f32>,
    // Material-Textur-Ebene dieses Vertex (`-1` = kein Material -> Schachbrett).
    @location(3) layer    : f32,
};

struct VsOut {
    @builtin(position) clip_pos : vec4<f32>,
    @location(0) world_normal : vec3<f32>,
    @location(1) uv           : vec2<f32>,
    @location(2) world_pos    : vec3<f32>,
    @location(3) @interpolate(flat) layer : f32,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clip_pos = globals.view_proj * vec4<f32>(in.position, 1.0);
    out.world_normal = in.normal;
    out.uv = in.uv;
    out.world_pos = in.position;
    out.layer = in.layer;
    return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    // Live-Schnitt-Kappung identisch zur Mesh-Pipeline (mode.y > 0.5 = aktiv).
    if (globals.mode.y > 0.5) {
        if (dot(in.world_pos, globals.section_plane.xyz) + globals.section_plane.w > 0.0) {
            discard;
        }
    }
    let n = normalize(in.world_normal);
    let l = normalize(globals.light_dir.xyz);

    // Hemisphaerisches Ambient (identisch zu MESH_WGSL).
    let hemi_t = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
    let ambient = mix(globals.ground_color.rgb, globals.sky_color.rgb, hemi_t);

    // Gerichteter Lambert-Anteil (Sonne).
    let diffuse = max(dot(n, l), 0.0) * globals.sun_color.rgb;

    // Gegen-Fuelllicht (identisch zu MESH_WGSL).
    let fill_l = normalize(vec3<f32>(-l.x, abs(l.y) * 0.35 + 0.15, -l.z));
    let fill = max(dot(n, fill_l), 0.0) * globals.sun_color.rgb
        * vec3<f32>(0.24, 0.27, 0.30);

    // Albedo aus dem Material-Textur-Array statt Vertexfarbe. Ebene je Vertex:
    // `layer < 0` (kein Material) -> Ebene 0 (Schachbrett). Sonst auf den
    // gueltigen Bereich [0, mode.z-1] geklemmt (Sicherheit gegen ueberzaehlige
    // Indizes, falls die Material-Menge kleiner ist als erwartet).
    let max_layer = max(i32(globals.mode.z) - 1, 0);
    let li = clamp(i32(round(in.layer)), 0, max_layer);
    let albedo = textureSample(tex, samp, in.uv, li).rgb;

    var shaded = albedo * (ambient + diffuse + fill);

    // Sanfte Kantenbetonung (identisch zu MESH_WGSL).
    let edge = 0.90 + 0.10 * abs(n.y);
    shaded = shaded * edge;

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
    view_proj     : mat4x4<f32>,
    light_dir     : vec4<f32>,
    sky_color     : vec4<f32>,
    ground_color  : vec4<f32>,
    sun_color     : vec4<f32>,
    mode          : vec4<f32>,
    section_plane : vec4<f32>,
};
@group(0) @binding(0) var<uniform> globals : Globals;

struct VsIn {
    @location(0) position : vec3<f32>,
    @location(1) color    : vec3<f32>,
};

struct VsOut {
    @builtin(position) clip_pos : vec4<f32>,
    @location(0) color     : vec3<f32>,
    @location(1) world_pos : vec3<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clip_pos = globals.view_proj * vec4<f32>(in.position, 1.0);
    out.color = in.color;
    out.world_pos = in.position;
    return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    // Gleiche Kappung wie die Mesh-Pipeline: Grid-, Modell-Kanten- und
    // Highlight-Linien (alle teilen diesen Shader) werden an der Schnittebene
    // weggeschnitten, damit auf der abgeschnittenen Seite keine Kanten stehen
    // bleiben (mode.y > 0.5 = aktiv).
    if (globals.mode.y > 0.5) {
        if (dot(in.world_pos, globals.section_plane.xyz) + globals.section_plane.w > 0.0) {
            discard;
        }
    }
    return vec4<f32>(in.color, 1.0);
}
"#;

/// WGSL der Schnittflaechen-Kappen (Cut-Caps, section_fill.rs / gpu::cap_pipeline).
/// Eigene TriangleList-Pipeline: Vertex-Layout [pos vec3, uv vec2, hatch vec3],
/// dieselbe `Globals`-Bind-Group (group(0) binding(0)) wie Mesh/Grid. Die Caps
/// werden NICHT geclippt (sie SIND die Schnittflaeche). Fragment: PROZEDURALE
/// Bauteil-Schraffur je geschnittener Schicht — Muster/Winkel/Skalierung kommen aus
/// dem `hatch`-Vertex-Attribut (pattern, angle_rad, scale; siehe
/// `section_fill.rs`/`types::Hatch`). MONOCHROM (dunkle Tinte auf hellem Papier,
/// passend zur 2D-Schnittkonvention `HATCH_INK`): es variiert das MUSTER, nicht die
/// Farbe. Muster-Ids: 0 = none (leer/weiss), 1 = solid (Vollton),
/// 2 = diagonal (Linienschar, `angle` steuert die Neigung — 0° = horizontal, wie
/// im 2D), 3 = crosshatch (Kreuz), 4 = insulation (Zickzack/Daemmung).
pub const CAP_WGSL: &str = r#"
struct Globals {
    view_proj     : mat4x4<f32>,
    light_dir     : vec4<f32>,
    sky_color     : vec4<f32>,
    ground_color  : vec4<f32>,
    sun_color     : vec4<f32>,
    mode          : vec4<f32>,
    section_plane : vec4<f32>,
};
@group(0) @binding(0) var<uniform> globals : Globals;

struct VsIn {
    @location(0) position : vec3<f32>,
    @location(1) uv       : vec2<f32>,
    // hatch: x = Muster-Id, y = Winkel (Radiant), z = Skalierung, w = Musterlinien-
    // Staerke (mm-Papier). Je Cut-Polygon konstant (redundant je Vertex, siehe
    // section_fill.rs).
    @location(2) hatch    : vec4<f32>,
};

struct VsOut {
    @builtin(position) clip_pos : vec4<f32>,
    @location(0) uv : vec2<f32>,
    // flat: die Muster-Parameter sind je Flaeche konstant und duerfen nicht
    // interpoliert werden (Muster-Id ist eine Ganzzahl-Auswahl).
    @location(1) @interpolate(flat) hatch : vec4<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clip_pos = globals.view_proj * vec4<f32>(in.position, 1.0);
    out.uv = in.uv;
    out.hatch = in.hatch;
    return out;
}

// Ein AA-gekantetes Linienband entlang der Koordinate `s` (in Einheiten von
// `spacing`): 1 auf der Linie, 0 dazwischen. `fwidth` glaettet blickwinkelrichtig.
fn line_band(s : f32, half_s : f32) -> f32 {
    let frac = fract(s);
    let dist = min(frac, 1.0 - frac);
    let aa = max(fwidth(s), 1e-5);
    return 1.0 - smoothstep(half_s, half_s + aa, dist);
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    let ink   = vec3<f32>(0.06, 0.06, 0.06);
    let paper = vec3<f32>(0.94, 0.94, 0.94);

    let pattern = i32(round(in.hatch.x));
    let angle   = in.hatch.y;
    let scale   = max(in.hatch.z, 0.05);

    // none (0): leere (weisse) Schnittflaeche — wie „keine Schraffur" im 2D.
    if (pattern == 0) {
        return vec4<f32>(paper, 1.0);
    }
    // solid (1): Vollton (Poché) — z. B. Beton.
    if (pattern == 1) {
        return vec4<f32>(ink, 1.0);
    }

    // Muster-Koordinaten: (u,v) in Modell-Metern, um `angle` gedreht. Konvention
    // wie die 2D-Schraffur (`hatchPreview.parallelLines`): `angle == 0` ergibt
    // HORIZONTALE Linien (Phasen-Achse = dv), `+angle` dreht die Schar gegen den
    // Uhrzeigersinn wie im 2D-Swatch. `du` laeuft ENTLANG der Linienrichtung, `dv`
    // ist die Quer-/Phasen-Achse. (Frueher lag hier ein fixer 45°-Versatz, weil das
    // Diagonalmuster ueber `du+dv` lief — dadurch war alles 45° verdreht.)
    let ca = cos(angle);
    let sa = sin(angle);
    let du =  in.uv.x * ca + in.uv.y * sa;   // entlang der Linienrichtung
    let dv = -in.uv.x * sa + in.uv.y * ca;   // quer (Phase)

    let spacing = 0.08 * scale;   // Grund-Linienabstand ~8 cm * Skalierung
    // Musterlinien-Staerke PRO Schraffur aus `hatch.w` (mm-Papier, aus dem LineStyle
    // des Hatch — wie die 2D-Schnitt-Schraffur: SIA `hatch-hair` 0.02 mm vs. `thin`
    // 0.13 mm). Dieselbe mm→Welt-Kalibrierung wie die Schicht-Trennlinien
    // (`section_fill::CUT_LINE_MM_TO_WORLD` = 0.01, halbe Breite ×0.5 → Faktor 0.005),
    // damit Schraffur- und Trennlinien-Staerke konsistent skalieren. Kleiner Floor,
    // damit eine Haarlinie nicht ganz verschwindet.
    let half    = max(in.hatch.w * 0.005, 0.0001);
    let half_s  = half / spacing;

    var line = 0.0;
    if (pattern == 2) {
        // diagonal: EINE Linienschar quer zur Phasen-Achse (dv). angle==0 →
        // horizontal; `hatch.angle` (z. B. 45° bei Backstein) dreht sie wie im 2D.
        line = line_band(dv / spacing, half_s);
    } else if (pattern == 3) {
        // crosshatch: zwei Scharen ueber Kreuz (Phase dv + Phase du = +90°). Bei
        // angle==0 horizontal+vertikal, bei 45° (Beton) das gekippte Kreuz — wie 2D.
        line = max(
            line_band(dv / spacing, half_s),
            line_band(du / spacing, half_s)
        );
    } else {
        // insulation (4, Daemmung): Zickzack. Die Quer-Position (dv) folgt einer
        // Dreieckswelle entlang der Lauf-Achse (du) — ein durchgehender Zickzack.
        let cell = spacing * 2.0;
        let a = du / cell;
        let b = dv / cell;
        let tri = abs(fract(a) - 0.5) * 2.0;   // 0..1 Dreieckswelle
        let fb = fract(b);
        let d = min(abs(fb - tri), min(abs(fb - tri + 1.0), abs(fb - tri - 1.0)));
        let aa = max(fwidth(fb) + fwidth(tri), 1e-5);
        let hw = half / cell;
        line = 1.0 - smoothstep(hw, hw + aa, d);
    }

    let color = mix(paper, ink, clamp(line, 0.0, 1.0));
    return vec4<f32>(color, 1.0);
}
"#;
