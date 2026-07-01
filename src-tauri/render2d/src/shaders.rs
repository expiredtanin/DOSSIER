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
    @location(1) bisector : vec2<f32>,  // Bildschirm-Raum-Miter-Bisektor (Einheit)
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
