// WGSL-Shader des nativen 2D-Renderers. Uebersetzt aus den GLSL-300-es-Vorlagen
// in `src/plan/glPlan/glPlanShaders.ts` (WGSL ~= GLSL). Als Konstanten hier, damit
// die Quellen auch ohne aktives GPU-Feature (headless) im Repo pruefbar bleiben.
//
// Uniform-Layout (ein gemeinsamer Struct, group(0) binding(0)):
//   view_proj    : mat4x4<f32>  Bildschirm-Raum -> Clip
//   color        : vec4<f32>    Draw-Farbe (pro Batch gesetzt)
//   viewport_px  : vec2<f32>    Zeichenpuffer-Groesse [w,h] in Geraete-px
//   stroke_px    : f32          ECHTE Papier-mm-Breite (Basis; == strokeMm)
//   stroke_scale : f32          mm -> Geraete-px (== mmToDevicePx)
//
// Fuellungen ignorieren die Linien-Felder; Linien nutzen alle.

/// Gemeinsame WGSL-Uniform-Deklaration (fuer beide Pipelines identisch).
pub const UNIFORM_WGSL: &str = r#"
struct Globals {
    view_proj    : mat4x4<f32>,
    color        : vec4<f32>,
    viewport_px  : vec2<f32>,
    stroke_px    : f32,
    stroke_scale : f32,
};
@group(0) @binding(0) var<uniform> globals : Globals;
"#;

/// Fuell-Pipeline: bildet Bildschirm-Raum-Positionen ueber `view_proj` in den
/// Clip-Raum ab und faerbt einheitlich (MVP; Schraffur folgt in M3).
pub const FILL_WGSL: &str = r#"
struct Globals {
    view_proj    : mat4x4<f32>,
    color        : vec4<f32>,
    viewport_px  : vec2<f32>,
    stroke_px    : f32,
    stroke_scale : f32,
};
@group(0) @binding(0) var<uniform> globals : Globals;

@vertex
fn vs_main(@location(0) position : vec2<f32>) -> @builtin(position) vec4<f32> {
    return globals.view_proj * vec4<f32>(position, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return globals.color;
}
"#;

/// Linien-Pipeline mit ECHTER Papier-mm-Breite.
///
/// Idee (wie im GLSL-Original): Endpunkt und (Endpunkt + Normale) werden durch
/// `view_proj` transformiert; ihre Clip-Differenz (in Pixel skaliert) ergibt die
/// Perpendikel-Richtung. Diese wird auf `width_px/2` Pixel normiert und — je nach
/// `side` — auf die passende Seite versetzt, dann px -> Clip zurueckgerechnet. So
/// bleibt die Strichbreite zoom-unabhaengig echte Papier-mm (keine Re-Tessellierung).
///
///   width_px = max(0.6, stroke_px * stroke_scale)   (== mm * mmToDevicePx)
/// Mindestens ~0.6 px, damit feine Gewichte beim Rauszoomen sichtbar bleiben.
pub const LINE_WGSL: &str = r#"
struct Globals {
    view_proj    : mat4x4<f32>,
    color        : vec4<f32>,
    viewport_px  : vec2<f32>,
    stroke_px    : f32,
    stroke_scale : f32,
};
@group(0) @binding(0) var<uniform> globals : Globals;

struct VsIn {
    @location(0) position : vec2<f32>,  // Bildschirm-Raum-Endpunkt
    @location(1) bisector : vec2<f32>,  // Bildschirm-Raum-Versatzrichtung (Einheit; Normale bei Quads, Radialrichtung bei Rundkappen/-ecken)
    @location(2) side     : f32,        // +1.0 oder -1.0
    @location(3) miter    : f32,        // 1/cos(theta/2)-Laengenfaktor (Gehrung)
};

@vertex
fn vs_main(in : VsIn) -> @builtin(position) vec4<f32> {
    let clip_p = globals.view_proj * vec4<f32>(in.position, 0.0, 1.0);
    let clip_n = globals.view_proj * vec4<f32>(in.position + in.bisector, 0.0, 1.0);

    // Bisektor-Richtung im Pixel-Raum (Clip-Differenz -> px).
    let dir_px = (clip_n.xy - clip_p.xy) * globals.viewport_px * 0.5;
    let len = length(dir_px);
    var unit_px = vec2<f32>(0.0, 0.0);
    if (len > 1e-6) {
        unit_px = dir_px / len;
    }

    // Echte Papierbreite in Geraete-px = mm(stroke_px) * (mm->px)(stroke_scale),
    // entlang des Bisektors um den Miter-Faktor verlaengert (buendige Gehrung).
    let width_px = max(0.6, globals.stroke_px * globals.stroke_scale) * in.miter;
    let offset_px = unit_px * (width_px * 0.5) * in.side;

    var out = clip_p;
    out = vec4<f32>(out.xy + offset_px / (globals.viewport_px * 0.5), out.z, out.w);
    return out;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return globals.color;
}
"#;

/// Analytische BOGEN-Pipeline: rendert einen Kreisbogen mathematisch exakt (SDF im
/// Fragment-Shader) statt als Segment-Kette — bei jedem Zoom ein "richtiger" Kreis,
/// nie ein Vieleck.
///
/// Ein Bogen = EINE Instanz + EIN Quad (6 Vertices, aus `vertex_index` erzeugt).
/// Das Quad ist die Bounding-Box des Bogens im BILDSCHIRM-Raum, im Vertex-Shader
/// aus der aktuellen px-Skala aufgespannt (Radius + halbe Strichbreite + AA-Rand),
/// sodass es bei jedem Zoom passt — OHNE Neu-Tessellierung.
///
/// Instanz-Layout (alles zoom-invariant, in Bildschirm-Raum bzw. Modell-Metern):
///   @location(0) center : vec2   Mittelpunkt (Bildschirm-Raum)
///   @location(1) geom   : vec4   (r_screen, a0, sweep, r_model)
///   @location(2) color  : vec4   RGBA
///   @location(3) wdash  : vec4   (width_mm, dash_total[m], dash_count, _pad)
///   @location(4) dash   : vec4   bis zu MAX_ARC_DASH(=4) An/Aus-Laengen (Modell-m)
///
/// Frame-Uniform (`ArcGlobals`): view_proj, viewport_px, px_per_screen (== meet-
/// Skala, Geraete-px je Bildschirm-Einheit) und stroke_scale (mm -> Geraete-px,
/// dieselbe Formel wie die Linien, `ortho::mm_to_device_px`).
///
/// Fragment: `d = abs(length(p-center) - r)` gibt den Ring-Abstand; die Kante wird
/// analytisch per `smoothstep` (~device-px) geglaettet (MSAA glaettet zusaetzlich).
/// Der Winkel wird gegen [0, sweep] geklemmt (beide Sweep-Vorzeichen, sauberer
/// Wrap) mit Butt-Cap an den Enden. Dash: Bogenlaenge s = theta_rel * r_model
/// (Modell-Meter!) modulo Muster, weicher An/Aus-Uebergang.
pub const ARC_WGSL: &str = r#"
struct ArcGlobals {
    view_proj     : mat4x4<f32>,
    viewport_px   : vec2<f32>,
    px_per_screen : f32,
    stroke_scale  : f32,
};
@group(0) @binding(0) var<uniform> g : ArcGlobals;

const PI : f32 = 3.14159265358979;
// Bildschirm-Einheiten je Modell-Meter (== tessellate::PX_PER_M). Fest, weil die
// Instanz-Geometrie bereits in Bildschirm-Raum vorliegt (to_screen skaliert *90).
const PX_PER_M_2D : f32 = 90.0;

struct VsOut {
    @builtin(position) pos : vec4<f32>,
    @location(0)                    frag   : vec2<f32>,
    @location(1) @interpolate(flat) center : vec2<f32>,
    @location(2) @interpolate(flat) geom   : vec4<f32>,
    @location(3) @interpolate(flat) color  : vec4<f32>,
    @location(4) @interpolate(flat) wdash  : vec4<f32>,
    @location(5) @interpolate(flat) dash   : vec4<f32>,
};

@vertex
fn vs_main(
    @builtin(vertex_index) vidx : u32,
    @location(0) center : vec2<f32>,
    @location(1) geom   : vec4<f32>,
    @location(2) color  : vec4<f32>,
    @location(3) wdash  : vec4<f32>,
    @location(4) dash   : vec4<f32>,
) -> VsOut {
    // Zwei Dreiecke, Ecken in {-1,+1}^2.
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0,  1.0), vec2<f32>(-1.0,  1.0),
    );
    let corner = corners[vidx];

    let r_s = geom.x;
    // Echte Papierbreite (Geraete-px) -> zurueck in Bildschirm-Einheiten fuer die
    // Quad-Groesse; plus AA-Rand (~2 px). px_per_screen gegen 0 sichern.
    let pps = max(g.px_per_screen, 1e-6);
    let width_px = max(0.6, wdash.x * g.stroke_scale);
    let half_w_screen = 0.5 * width_px / pps;
    let aa_screen = 2.0 / pps;
    let ext = r_s + half_w_screen + aa_screen;

    let p_screen = center + corner * ext;

    var out : VsOut;
    out.pos = g.view_proj * vec4<f32>(p_screen, 0.0, 1.0);
    out.frag = p_screen;
    out.center = center;
    out.geom = geom;
    out.color = color;
    out.wdash = wdash;
    out.dash = dash;
    return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    let center = in.center;
    let r_s    = in.geom.x;
    let a0     = in.geom.y;
    let sweep  = in.geom.z;
    let r_m    = in.geom.w;
    let width_mm   = in.wdash.x;
    let dash_total = in.wdash.y;
    let dash_count = i32(in.wdash.z + 0.5);
    let pps = max(g.px_per_screen, 1e-6);

    let rel  = in.frag - center;
    let dist = length(rel);

    // 1) Radiale Kante (Strichbreite quer zum Bogen), analytisch antialiased.
    let d_ring_px = abs(dist - r_s) * pps;
    let half_w_px = 0.5 * max(0.6, width_mm * g.stroke_scale);
    let cov_radial = 1.0 - smoothstep(half_w_px - 0.6, half_w_px + 0.6, d_ring_px);

    // 2) Winkel-Clamp auf [min(0,sweep), max(0,sweep)] mit Butt-Cap an den Enden.
    let theta = atan2(rel.y, rel.x);
    var da = theta - a0;
    da = da - 2.0 * PI * round(da / (2.0 * PI)); // Wrap nach (-pi, pi]
    let lo = min(0.0, sweep);
    let hi = max(0.0, sweep);
    var sd : f32;
    if (da < lo) {
        sd = lo - da;
    } else if (da > hi) {
        sd = da - hi;
    } else {
        sd = -min(da - lo, hi - da);
    }
    let cap_px = sd * r_s * pps;          // signierter Abstand zur Kappe (Geraete-px)
    let cov_cap = 1.0 - smoothstep(-0.5, 0.5, cap_px);

    // 3) Dash: Bogenlaenge ab a0 (Modell-Meter) modulo Muster, weicher Uebergang.
    var cov_dash = 1.0;
    if (dash_count > 0 && dash_total > 1e-9) {
        var progress = da;
        if (sweep < 0.0) { progress = -da; }
        progress = max(progress, 0.0);
        let s_model = progress * r_m;
        let m = s_model - dash_total * floor(s_model / dash_total);

        var cyc = array<f32, 4>(in.dash.x, in.dash.y, in.dash.z, in.dash.w);
        var acc = 0.0;
        var cur_on = true;
        var edge = dash_total;
        for (var i = 0; i < 4; i = i + 1) {
            if (i >= dash_count) { break; }
            let seg = cyc[i];
            if (m >= acc && m < acc + seg) {
                cur_on = (i % 2) == 0;              // gerade Segmente = "an"
                edge = min(m - acc, acc + seg - m); // Abstand zur naechsten Grenze
            }
            acc = acc + seg;
        }
        let px_per_m = PX_PER_M_2D * pps;
        let edge_px = edge * px_per_m;
        // Signierter Abstand: innen "an" positiv, innen "aus" negativ.
        let sdist = select(-edge_px, edge_px, cur_on);
        cov_dash = smoothstep(-0.5, 0.5, sdist);
    }

    let a = in.color.a * cov_radial * cov_cap * cov_dash;
    if (a <= 0.002) {
        discard;
    }
    return vec4<f32>(in.color.rgb, a);
}
"#;
