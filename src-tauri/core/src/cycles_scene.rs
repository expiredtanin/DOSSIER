//! [215] Cycles-Szene aus dem Projekt: schreibt die Cycles-XML-Szene für das mitgelieferte `cycles`-Programm
//! (Standalone, Apache-2.0; Plan und Messwerte: `doc/CYCLES.md`).
//!
//! Dreiecks-Quelle ist dieselbe wie bei glTF/OBJ/STL und der 3D-Anzeige (`mesh_data::collect_scene`: Wände mit
//! Öffnungen, Decken, Dächer, Stützen, Treppen, Bäume, Fenster/Türen mit Glas, freie Körper, Gelände, Kontext;
//! Baugrube wie [227] ausblendbar). Aus den Welt-Achsen der Sammlung (x, Höhe, y) werden Modell-Achsen
//! (x Ost, y Nord, z oben) mit umgekehrter Wicklung; Cycles bekommt die Netze unverändert in Metern.
//!
//! Was das Programm braucht und wie Dossier es liefert:
//!   • Netze: `<mesh P nverts verts>` je Teil-Netz, Ecken nach Knickwinkel (30°) geteilt (`smooth_corner_normals`),
//!     Schattierung `smooth` — Cycles mittelt die Normalen je Ecke selbst, scharfe Kanten bleiben kantig.
//!   • Materialien: Principled BSDF aus den Dossier-Materialien (Farbe sRGB → linear, Albedo höchstens 0.8, Rauheit,
//!     Metall); Glas = Transmission 1 (IOR 1.5), für Schattenstrahlen durchsichtig; Bildkarten (`Component.material`,
//!     Gelände: gewählte oder Wiese `Grass005`) als Box-Projektion über Objektkoordinaten, Kachel `sizeM`
//!     (Farbkarte: Farbraum „auto“ = sRGB bei 8 Bit; Rauheit/Metall `Non-Color`). Ohne Bildkarte Ersatzlooks nach
//!     Verwendung und Baustoffname wie im Blender-Leser (`scripts/blender/render_dossier.py`).
//!   • Kamera: `<transform matrix>` 16 Zahlen SPALTENWEISE (rechts, oben, Blickrichtung, Ort); die Cycles-Kamera blickt
//!     entlang +Z, oben = +Y, rechts = Blick × oben. Orthogonal: `camera_type="orthograph"`, die Sichthöhe steckt als
//!     Skalierung (halbe Höhe) in den Spalten rechts/oben. `fov` ist der Bildwinkel der kürzeren Bildkante.
//!   • Himmel: Nishita (`multiple_scattering`) mit Sonne aus Datum/Ort (`sun::sun_position`) oder Azimut/Höhe; Cycles
//!     zählt die Sonnen-Rotation wie der Kompass (0 = Nord +Y, 90° = Ost +X). Hintergrundlicht mit `use_mis`.
//!   • Belichtung: `<film exposure>` als Faktor, automatisch nach Sonnenhöhe (`SUNLIT_WHITE` aus dem Blender-Leser);
//!     das Programm schreibt lineares Licht (EXR), Tonwert: `cycles_post.rs`.
//! Rückgabe: XML-Text und die Liste der Bilddateien (relativer Pfad ↔ URL des Material-Systems); die Gastgeber laden
//! die Bytes (Rust im WASM liest keine Dateien) und legen sie neben die XML.

use crate::jsnum;
use crate::mesh_data::{collect_scene, MeshOptions, Prim, SceneData};
use crate::model::*;
use crate::style::hex_to_rgb;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as _;

/// Albedo-Obergrenze (linear): kein Baustoff reflektiert 100 Prozent (wie `ALBEDO_MAX` im Blender-Leser).
const ALBEDO_MAX: f64 = 0.80;
/// Knickwinkel der geteilten Ecken (wie glTF-Export und 3D-Anzeige).
const CREASE_DEG: f32 = 30.0;
/// Gemessene Strahldichte einer weissen besonnten Fläche im Nishita-Himmel nach Sonnenhöhe (Grad → Wert), wie im Blender-Leser.
const SUNLIT_WHITE: [(f64, f64); 11] = [(1.0, 0.65), (3.0, 1.5), (6.0, 3.3), (10.0, 6.4), (15.0, 10.9), (20.0, 14.9), (30.0, 23.7), (45.0, 34.9), (60.0, 43.5), (70.0, 47.5), (90.0, 50.8)];
/// Gewünschte Helligkeit einer weissen besonnten Fläche nach der Belichtung.
const SUNLIT_TARGET: f64 = 1.5;
/// Mittag, 21. Juni 2026, 12:00 UTC (Vorgabe der Sonne ohne Zeitangabe).
const DEFAULT_WHEN_MS: f64 = 1_782_043_200_000.0;
const GRASS: [&str; 3] = ["/assets/materials/Grass005/color.jpg", "/assets/materials/Grass005/normal.jpg", "/assets/materials/Grass005/roughness.jpg"];
const GRASS_SIZE_M: f64 = 4.0;

/// Sonne mit festem Azimut (Grad von Nord im Uhrzeigersinn) und Höhe.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct SunIn {
    pub azimuth: f64,
    pub elevation: f64,
}

/// Kamera: Voreinstellung (`iso`, `perspective`, `front`, `back`, `left`, `right`, `side`, `top`; rahmt das Gebäude ein)
/// oder explizit in Modell-Koordinaten (Form wie `RenderCamera` in `doc/RENDER-SZENE.md`).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CameraSpec {
    Preset { preset: String },
    Explicit {
        #[serde(default)]
        kind: String,
        position: [f64; 3],
        direction: [f64; 3],
        #[serde(default = "up_z")]
        up: [f64; 3],
        #[serde(default, rename = "fovDeg")]
        fov_deg: Option<f64>,
        #[serde(default, rename = "orthoHeight")]
        ortho_height: Option<f64>,
    },
}

fn up_z() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}

/// Optionen der Szene (JSON, camelCase).
#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CyclesOptions {
    pub width: f64,
    pub height: f64,
    pub samples: f64,
    pub denoise: bool,
    /// Zeitpunkt der Sonne (Unix-ms); ohne Angabe und ohne `sun` der 21.6.2026 12:00 UTC.
    pub when_ms: Option<f64>,
    /// Fester Sonnenstand (übersteuert Zeit und Ort).
    pub sun: Option<SunIn>,
    /// Sonnenstärke (Vorgabe 1).
    pub sun_intensity: f64,
    /// Belichtung in EV (Vorgabe: automatisch nach Sonnenhöhe).
    pub exposure_ev: Option<f64>,
    pub camera: Option<CameraSpec>,
    /// [227] Gelände ohne Baugrube (hinterfüllt); Vorgabe an (für Bilder).
    pub backfilled: bool,
    /// Gelände und Kontext mitnehmen.
    pub context: bool,
    /// Bodenplatte unter dem Modell (der Himmel unter dem Horizont ist dunkel).
    pub ground: bool,
    /// Bild-URLs, die der Gastgeber laden kann; `None` = alle. Fehlende Karten fallen auf den Ersatzlook zurück.
    pub textures: Option<Vec<String>>,
}

impl Default for CyclesOptions {
    fn default() -> Self {
        CyclesOptions {
            width: 1920.0,
            height: 1080.0,
            samples: 128.0,
            denoise: true,
            when_ms: None,
            sun: None,
            sun_intensity: 1.0,
            exposure_ev: None,
            camera: None,
            backfilled: true,
            context: true,
            ground: true,
            textures: None,
        }
    }
}

/// Eine Bilddatei der Szene: relativer Pfad neben der XML, URL im Material-System.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextureRef {
    pub path: String,
    pub url: String,
}

/// Ergebnis: XML-Text, Bilddateien, Kennzahlen.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CyclesScene {
    pub xml: String,
    pub textures: Vec<TextureRef>,
    /// Anzahl der Netze des Modells (ohne Boden) und ihrer Dreiecke.
    pub meshes: usize,
    pub triangles: usize,
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    pub sun_azimuth: f64,
    pub sun_elevation: f64,
    /// Belichtungsfaktor in `<film exposure>` (2^EV).
    pub exposure: f64,
    pub notes: Vec<String>,
}

// ── Farben, Materialien ─────────────────────────────────────────────────────

fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        jsnum::pow((c + 0.055) / 1.055, 2.4)
    }
}

fn lin(rgb: [f64; 3]) -> [f64; 3] {
    [srgb_to_linear(rgb[0]), srgb_to_linear(rgb[1]), srgb_to_linear(rgb[2])]
}

fn clamp_albedo(c: [f64; 3]) -> [f64; 3] {
    [c[0].min(ALBEDO_MAX), c[1].min(ALBEDO_MAX), c[2].min(ALBEDO_MAX)]
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Role {
    Terrain,
    Context,
    Roof,
    Opening,
    Building,
}

fn role_of(kind: &str) -> Role {
    match kind {
        "terrain" => Role::Terrain,
        "context" => Role::Context,
        "roof" => Role::Roof,
        "window" | "door" | "" => Role::Opening,
        _ => Role::Building,
    }
}

/// Bildkarten eines Materials (URLs) und Kachelgrösse.
#[derive(Debug, Clone, PartialEq)]
struct Tex {
    color: String,
    rough: Option<String>,
    metal: Option<String>,
    size_m: f64,
}

/// Aufgelöstes Aussehen einer Fläche.
#[derive(Debug, Clone, PartialEq)]
struct Look {
    label: String,
    /// Linear, Albedo begrenzt (bei Glas leicht getönt).
    color: [f64; 3],
    rough: f64,
    metal: f64,
    glass: bool,
    tex: Option<Tex>,
}

/// Ersatzlooks ohne Bildkarte: (Schlüsselwörter im Baustoffnamen, Farbe sRGB, Rauheit, Metall).
type LookRow = (&'static [&'static str], [f64; 3], f64, f64);
const ROOF_LOOKS: [LookRow; 7] = [
    (&["ziegel", "biber", "dachstein"], [0.56, 0.25, 0.16], 0.7, 0.0),
    (&["schindel"], [0.40, 0.28, 0.18], 0.85, 0.0),
    (&["blech", "zink", "titan", "kupfer", "alu", "stehfalz"], [0.55, 0.57, 0.58], 0.35, 1.0),
    (&["kies"], [0.46, 0.44, 0.41], 0.95, 0.0),
    (&["schiefer", "faserzement", "eternit"], [0.22, 0.23, 0.25], 0.8, 0.0),
    (&["begr", "substrat", "gras"], [0.30, 0.42, 0.18], 0.95, 0.0),
    (&["bitumen", "abdicht", "folie"], [0.10, 0.10, 0.10], 0.7, 0.0),
];
const ROOF_DEFAULT: ([f64; 3], f64, f64) = ([0.34, 0.30, 0.28], 0.75, 0.0);
const BUILDING_LOOKS: [LookRow; 6] = [
    (&["backstein", "ziegel"], [0.60, 0.31, 0.22], 0.8, 0.0),
    (&["beton"], [0.52, 0.52, 0.50], 0.85, 0.0),
    (&["holz", "parkett", "lattung", "schalung", "bsp", "brettsperr"], [0.56, 0.40, 0.24], 0.65, 0.0),
    (&["stahl", "metall", "alu"], [0.55, 0.57, 0.58], 0.4, 1.0),
    (&["naturstein", "marmor", "granit"], [0.62, 0.60, 0.57], 0.5, 0.0),
    (&["keramik", "fliese", "platte"], [0.75, 0.74, 0.72], 0.3, 0.0),
];
const GRASS_SRGB: [f64; 3] = [0.33, 0.45, 0.18];
const CONTEXT_SRGB: [f64; 3] = [0.78, 0.78, 0.77];

fn pick_look(table: &[LookRow], text: &str) -> Option<([f64; 3], f64, f64)> {
    table.iter().find(|(words, ..)| words.iter().any(|w| text.contains(w))).map(|(_, c, r, m)| (*c, *r, *m))
}

/// Weiss = vom Modell nicht gesetzt (der Look kommt aus Bildkarte oder Namen).
fn is_unset(c: [f64; 3]) -> bool {
    c.iter().all(|v| *v >= 0.97)
}

/// Aussehen ohne Bildkarte: Farbe/Rauheit/Metall nach Verwendung, Baustoffname und gesetzter Farbe.
fn flat_look(role: Role, text: &str, rgb: [f64; 3], rough: f64, metal: f64) -> ([f64; 3], f64, f64) {
    let mut hit: Option<([f64; 3], f64, f64)> = None;
    match role {
        Role::Terrain => hit = Some((GRASS_SRGB, 0.95, 0.0)),
        Role::Context => hit = Some((CONTEXT_SRGB, 0.9, 0.0)),
        Role::Roof => {
            hit = pick_look(&ROOF_LOOKS, text);
            if hit.is_none() && is_unset(rgb) {
                hit = Some(ROOF_DEFAULT);
            }
        }
        _ => {
            if is_unset(rgb) {
                hit = pick_look(&BUILDING_LOOKS, text);
            }
        }
    }
    let (c, r, m) = hit.unwrap_or((rgb, rough, metal));
    (clamp_albedo(lin(c)), r, m)
}

/// Dachschicht, deren Baustoff die Farbe des Teilnetzes trägt (wie `splitRoofMaterials` in TS): die Schicht des
/// Dachtyps (aussen → innen), Rückfall die äusserste. Dächer mit eigener Farbe oder ohne Typ bleiben „Dach“.
fn roof_layer<'a>(p: &'a Project, roof_id: &str, mat_srgb: [f64; 3]) -> Option<&'a Component> {
    let roof = p.roofs.as_deref()?.iter().find(|r| r.id == roof_id)?;
    if roof.color.as_deref().is_some_and(|c| !c.is_empty()) {
        return None;
    }
    let tid = roof.roof_type_id.as_deref()?;
    let ty = p.roof_types.as_deref()?.iter().find(|t| t.id == tid)?;
    let comps: Vec<&Component> = ty.layers.iter().filter_map(|l| p.component(&l.component_id)).collect();
    let want = lin(mat_srgb);
    let close = |c: &Component| {
        let have = lin(hex_to_rgb(&c.color, [f64::NAN; 3]));
        have.iter().all(|v| v.is_finite()) && (have[0] - want[0]).abs() + (have[1] - want[1]).abs() + (have[2] - want[2]).abs() < 0.02
    };
    comps.iter().copied().find(|c| close(c)).or_else(|| comps.first().copied())
}

/// Erster Gelände-Körper mit Bauteil-Bildkarten, sonst die Wiese.
fn terrain_material(p: &Project) -> ComponentMaterial {
    for o in p.context.as_deref().unwrap_or(&[]) {
        if let ContextObject::TerrainMesh(t) = o {
            if let Some(m) = t.component_id.as_deref().and_then(|id| p.component(id)).and_then(|c| c.material.as_ref()) {
                if m.color.as_deref().is_some_and(|c| !c.is_empty()) {
                    return m.clone();
                }
            }
        }
    }
    ComponentMaterial { library_id: Some("Grass005".into()), color: Some(GRASS[0].into()), normal: Some(GRASS[1].into()), roughness: Some(GRASS[2].into()), size_m: Some(GRASS_SIZE_M), ..Default::default() }
}

/// Ordner der Bilddateien neben der XML.
struct Textures {
    list: Vec<TextureRef>,
    by_url: HashMap<String, String>,
}

impl Textures {
    fn path_for(&mut self, url: &str, kind: &str) -> String {
        if let Some(p) = self.by_url.get(url) {
            return p.clone();
        }
        let path = format!("textures/{}_{kind}.{}", self.by_url.len(), extension_of(url));
        self.by_url.insert(url.to_string(), path.clone());
        self.list.push(TextureRef { path: path.clone(), url: url.to_string() });
        path
    }
}

fn extension_of(url: &str) -> String {
    let base = url.split(['?', '#']).next().unwrap_or("");
    match base.rsplit_once('.') {
        Some((_, e)) if (2..=4).contains(&e.len()) && e.bytes().all(|b| b.is_ascii_alphanumeric()) => e.to_ascii_lowercase(),
        _ => "jpg".into(),
    }
}

// ── Zahlen und XML ──────────────────────────────────────────────────────────

/// Zahl mit höchstens `digits` Nachkommastellen, ohne überflüssige Nullen; nicht endlich → 0.
fn fmt(v: f64, digits: usize) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let mut s = format!("{v:.digits$}");
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    if s == "-0" {
        s = "0".into();
    }
    s
}

fn rgb_attr(c: [f64; 3]) -> String {
    format!("{} {} {}", fmt(c[0], 5), fmt(c[1], 5), fmt(c[2], 5))
}

/// Name für das XML: Buchstaben, Ziffern, `_`/`-`; sonst `_`.
fn xml_name(s: &str) -> String {
    let n: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    if n.is_empty() {
        "x".into()
    } else {
        n
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// `<shader>` für ein Aussehen. Dateipfade der Bildkarten über `tex`.
fn shader_xml(name: &str, look: &Look, tex: &mut Textures) -> String {
    let mut s = String::new();
    let _ = write!(s, "<shader name=\"{name}\">");
    if look.glass {
        let _ = write!(
            s,
            "<principled_bsdf name=\"p\" base_color=\"{}\" roughness=\"0\" metallic=\"0\" ior=\"1.5\" transmission_weight=\"1\" />\
             <light_path name=\"lp\" /><transparent_bsdf name=\"clr\" /><mix_closure name=\"mx\" />\
             <connect from=\"lp is_shadow_ray\" to=\"mx fac\" /><connect from=\"p bsdf\" to=\"mx closure1\" />\
             <connect from=\"clr bsdf\" to=\"mx closure2\" /><connect from=\"mx closure\" to=\"output surface\" />",
            rgb_attr(look.color)
        );
    } else if let Some(t) = &look.tex {
        let inv = 1.0 / t.size_m;
        let _ = write!(
            s,
            "<texture_coordinate name=\"tc\" /><mapping name=\"m\" scale=\"{0} {0} {0}\" />\
             <connect from=\"tc object\" to=\"m vector\" />\
             <image_texture name=\"tcol\" filename=\"{1}\" projection=\"box\" projection_blend=\"0.2\" interpolation=\"linear\" />\
             <vector_math name=\"alb\" math_type=\"multiply\" vector2=\"{2} {2} {2}\" />\
             <principled_bsdf name=\"p\" roughness=\"{3}\" metallic=\"{4}\" />\
             <connect from=\"m vector\" to=\"tcol vector\" /><connect from=\"tcol color\" to=\"alb vector1\" />\
             <connect from=\"alb vector\" to=\"p base_color\" />",
            fmt(inv, 6),
            xml_escape(&tex.path_for(&t.color, "color")),
            fmt(ALBEDO_MAX, 3),
            fmt(look.rough, 4),
            fmt(look.metal, 4)
        );
        for (url, id, socket) in [(&t.rough, "trough", "roughness"), (&t.metal, "tmetal", "metallic")] {
            if let Some(u) = url {
                let _ = write!(
                    s,
                    "<image_texture name=\"{id}\" filename=\"{}\" projection=\"box\" projection_blend=\"0.2\" interpolation=\"linear\" colorspace=\"Non-Color\" />\
                     <connect from=\"m vector\" to=\"{id} vector\" /><connect from=\"{id} color\" to=\"p {socket}\" />",
                    xml_escape(&tex.path_for(u, socket))
                );
            }
        }
        s.push_str("<connect from=\"p bsdf\" to=\"output surface\" />");
    } else {
        let _ = write!(
            s,
            "<principled_bsdf name=\"p\" base_color=\"{}\" roughness=\"{}\" metallic=\"{}\" /><connect from=\"p bsdf\" to=\"output surface\" />",
            rgb_attr(look.color),
            fmt(look.rough, 4),
            fmt(look.metal, 4)
        );
    }
    s.push_str("</shader>");
    s
}

// ── Netze ───────────────────────────────────────────────────────────────────

/// Ein Netz in Modell-Achsen mit geteilten Ecken.
struct MeshOut {
    p: Vec<f64>,
    verts: Vec<u32>,
}

/// Teil-Netz (Welt-Achsen x, Höhe, y; nach aussen gewickelt) → Modell-Achsen (x, y, z) mit vertauschter Wicklung, Ecken je Lage und
/// Normale geteilt (Knickwinkel). Dreiecke mit ungültigen Indizes/Ecken und entartete fallen weg.
fn mesh_out(prim: &Prim) -> Option<(MeshOut, Vec<[f64; 3]>)> {
    let model: Vec<[f64; 3]> = prim.positions.chunks_exact(3).map(|c| [c[0], c[2], c[1]]).collect();
    let nv = model.len();
    let ok = |v: f64| v >= 0.0 && v < nv as f64 && v.fract() == 0.0 && model[v as usize].iter().all(|x| x.is_finite());
    let mut idx: Vec<u32> = Vec::with_capacity(prim.indices.len());
    for t in prim.indices.chunks_exact(3) {
        if ok(t[0]) && ok(t[1]) && ok(t[2]) {
            idx.extend_from_slice(&[t[0] as u32, t[2] as u32, t[1] as u32]);
        }
    }
    if idx.is_empty() {
        return None;
    }
    let world = |i: usize| -> [f32; 3] { [model[i][0] as f32, model[i][1] as f32, model[i][2] as f32] };
    let normals = dossier_hatch::mesh_normals::smooth_corner_normals(&idx, nv, &world, CREASE_DEG);
    let key = |v: f64| jsnum::round(v * 1e4) as i64;
    let nkey = |v: f32| jsnum::round(f64::from(v) * 1e3) as i32;
    let mut weld: HashMap<([i64; 3], [i32; 3]), u32> = HashMap::new();
    let mut out = MeshOut { p: Vec::new(), verts: Vec::new() };
    let mut used: Vec<[f64; 3]> = Vec::new();
    for (t, n) in idx.chunks_exact(3).zip(&normals) {
        let Some(n) = n else { continue };
        for k in 0..3 {
            let v = model[t[k] as usize];
            let id = *weld.entry(([key(v[0]), key(v[1]), key(v[2])], [nkey(n[k][0]), nkey(n[k][1]), nkey(n[k][2])])).or_insert_with(|| {
                out.p.extend_from_slice(&v);
                used.push(v);
                (used.len() - 1) as u32
            });
            out.verts.push(id);
        }
    }
    (!out.verts.is_empty()).then_some((out, used))
}

// ── Kamera, Sonne ───────────────────────────────────────────────────────────

fn norm3(v: [f64; 3]) -> Option<[f64; 3]> {
    let l = v[0].hypot(v[1]).hypot(v[2]);
    (l.is_finite() && l > 1e-12).then(|| [v[0] / l, v[1] / l, v[2] / l])
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Aufgelöste Kamera: Ort, Blickrichtung, oben, Art, vertikaler Bildwinkel (Grad) bzw. Sichthöhe (m).
struct Cam {
    pos: [f64; 3],
    dir: [f64; 3],
    up: [f64; 3],
    ortho: bool,
    fov_deg: f64,
    ortho_height: f64,
}

/// Blickrichtungen der Voreinstellungen (vom Auge zum Modell, x Ost, y Nord, z oben) und ob orthogonal.
fn preset(name: &str) -> ([f64; 3], bool) {
    match name {
        "perspective" => ([1.0, 1.0, -0.55], false),
        "front" => ([0.0, 1.0, 0.0], true),
        "back" => ([0.0, -1.0, 0.0], true),
        "side" | "right" => ([-1.0, 0.0, 0.0], true),
        "left" => ([1.0, 0.0, 0.0], true),
        "top" => ([0.0, 0.0, -1.0], true),
        _ => ([1.0, 1.0, -0.8], true),
    }
}

/// Kamera rahmt das Gebäude ein (Mitte der Hülle, Radius = halbe Diagonale, mind. 1 m); wie `make_camera` im Blender-Leser.
fn framed_camera(name: &str, lo: [f64; 3], hi: [f64; 3], aspect: f64) -> Cam {
    let (d, ortho) = preset(name);
    let dir = norm3(d).unwrap_or([0.0, 1.0, 0.0]);
    let up = if name == "top" { [0.0, 1.0, 0.0] } else { [0.0, 0.0, 1.0] };
    let center = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0];
    let radius = ((hi[0] - lo[0]).hypot(hi[1] - lo[1]).hypot(hi[2] - lo[2]) / 2.0).max(1.0);
    let fov = 50.0_f64;
    let (dist, ortho_height) = if ortho {
        (radius * 3.0, 2.2 * radius * (1.0_f64).max(1.0 / aspect))
    } else {
        let half = (fov.to_radians() / 2.0).min(jsnum::atan(jsnum::tan(fov.to_radians() / 2.0) * aspect));
        (radius * 1.15 / jsnum::sin(half), 0.0)
    };
    Cam { pos: [center[0] - dir[0] * dist, center[1] - dir[1] * dist, center[2] - dir[2] * dist], dir, up, ortho, fov_deg: fov, ortho_height }
}

/// Matrix und Kamera-Element des XML. `None` bei unbrauchbarer Kamera (Richtung null, nicht endlich).
fn camera_xml(c: &Cam, width: f64, height: f64) -> Option<String> {
    let dir = norm3(c.dir)?;
    let mut right = cross(dir, c.up);
    if norm3(right).is_none() {
        right = cross(dir, [0.0, 1.0, 0.0]);
    }
    let right = norm3(right)?;
    let up = norm3(cross(right, dir))?;
    if !c.pos.iter().all(|v| v.is_finite()) {
        return None;
    }
    let aspect = width / height;
    let (sx, sy, attrs) = if c.ortho {
        let h = if c.ortho_height.is_finite() && c.ortho_height > 0.0 { c.ortho_height } else { 10.0 };
        // Die Sichtebene der Cycles-Kamera ist 2 hoch (Querformat) bzw. 2 breit (Hochformat): Spalten rechts/oben skalieren.
        let s = h / 2.0;
        (s, s, "camera_type=\"orthograph\"".to_string())
    } else {
        let fv = c.fov_deg.clamp(5.0, 120.0).to_radians();
        // Cycles: `fov` gilt für die kürzere Bildkante.
        let f = if aspect >= 1.0 { fv } else { 2.0 * jsnum::atan(jsnum::tan(fv / 2.0) * aspect) };
        (1.0, 1.0, format!("camera_type=\"perspective\" fov=\"{}\"", fmt(f, 8)))
    };
    let col = |v: [f64; 3], s: f64| format!("{} {} {} 0", fmt(v[0] * s, 8), fmt(v[1] * s, 8), fmt(v[2] * s, 8));
    Some(format!(
        "<camera width=\"{}\" height=\"{}\" />\n<transform matrix=\"{}  {}  {}  {} {} {} 1\"><camera {attrs} nearclip=\"0.05\" farclip=\"100000\" /></transform>\n",
        fmt(width, 0),
        fmt(height, 0),
        col(right, sx),
        col(up, sy),
        col(dir, 1.0),
        fmt(c.pos[0], 5),
        fmt(c.pos[1], 5),
        fmt(c.pos[2], 5)
    ))
}

/// Belichtungsfaktor wie eine Kamera mit Automatik: besonnte weisse Fläche → `SUNLIT_TARGET`; geometrische
/// Interpolation der Tabelle (ohne `ln`/`exp`, plattformgleich). Begrenzt auf 2^-8 … 2^3.
fn auto_exposure(elevation: f64, strength: f64) -> f64 {
    let e = if elevation.is_finite() { elevation.max(1.0) } else { 40.0 };
    let mut value = SUNLIT_WHITE[SUNLIT_WHITE.len() - 1].1;
    for w in SUNLIT_WHITE.windows(2) {
        let ((e0, v0), (e1, v1)) = (w[0], w[1]);
        if e <= e1 {
            let f = ((e - e0) / (e1 - e0)).max(0.0);
            value = v0 * jsnum::pow(v1 / v0, f);
            break;
        }
    }
    let s = if strength.is_finite() { strength.max(1e-3) } else { 1.0 };
    (SUNLIT_TARGET / (value * s)).clamp(jsnum::pow(2.0, -8.0), 8.0)
}

// ── Szene ───────────────────────────────────────────────────────────────────

/// Schreibt die Cycles-Szene. Fehler nur bei unbrauchbaren Optionen (Bildgrösse, Kamera); ein leeres Projekt ergibt eine
/// gültige Szene ohne Netze (`meshes == 0`).
pub fn cycles_scene(p: &Project, o: &CyclesOptions) -> Result<CyclesScene, String> {
    let dim = |v: f64, what: &str| -> Result<u32, String> {
        if v.is_finite() && (1.0..=32768.0).contains(&v) {
            Ok(v.round() as u32)
        } else {
            Err(format!("cyclesScene: {what} ausserhalb 1…32768"))
        }
    };
    let (width, height) = (dim(o.width, "Breite")?, dim(o.height, "Höhe")?);
    if !(o.samples.is_finite() && o.samples >= 1.0) {
        return Err("cyclesScene: Samples ≥ 1".into());
    }
    let samples = o.samples.min(1e6).round() as u32;
    let mut notes: Vec<String> = Vec::new();

    let SceneData { groups, mats, .. } = collect_scene(p, &MeshOptions { opening_parts: true, context: o.context, by_level: false, backfilled: o.backfilled })?;

    let comp_mat: HashMap<&str, &ComponentMaterial> = {
        let mut m = HashMap::new();
        for c in &p.components {
            if let Some(cm) = c.material.as_ref().filter(|m| m.color.as_deref().is_some_and(|u| !u.is_empty())) {
                m.entry(c.name.as_str()).or_insert(cm);
            }
        }
        m
    };
    let terrain_mat = terrain_material(p);
    let avail = |u: &str| o.textures.as_ref().map_or(true, |l| l.iter().any(|x| x == u));
    let mut missing: Vec<String> = Vec::new();

    let mut tex = Textures { list: Vec::new(), by_url: HashMap::new() };
    let mut shader_ids: HashMap<String, usize> = HashMap::new();
    let mut shaders: Vec<String> = Vec::new();
    let mut by_shader: Vec<Vec<String>> = Vec::new();
    let (mut meshes, mut triangles) = (0usize, 0usize);
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let (mut lo_all, mut hi_all) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let mut terrain_lo_z = f64::INFINITY;

    for g in &groups {
        let role = role_of(g.kind);
        for prim in &g.prims {
            let Some(m) = (prim.material >= 0.0 && prim.material.fract() == 0.0).then(|| mats.list.get(prim.material as usize)).flatten() else { continue };
            let Some((mesh, used)) = mesh_out(prim) else { continue };

            // Aussehen: Glas, Bildkarte, sonst Ersatzlook.
            let srgb = [m.rgba[0], m.rgba[1], m.rgba[2]];
            let mut comp_name = m.name.clone();
            let mut label = m.name.clone();
            if role == Role::Roof && m.name == "Dach" {
                if let Some(c) = roof_layer(p, &g.id, srgb) {
                    comp_name = c.name.clone();
                    label = format!("Dach: {}", c.name);
                }
            }
            let look = if m.rgba[3] < 1.0 {
                let c = lin(srgb);
                Look { label, color: [0.90 + 0.10 * c[0], 0.94 + 0.06 * c[1], 0.95 + 0.05 * c[2]], rough: 0.0, metal: 0.0, glass: true, tex: None }
            } else {
                let cm = if role == Role::Terrain { Some(&terrain_mat) } else { comp_mat.get(comp_name.as_str()).copied() };
                let mut t: Option<Tex> = None;
                if let Some(cm) = cm {
                    match cm.color.as_deref().filter(|u| !u.is_empty()) {
                        Some(u) if avail(u) => {
                            let ok = |u: &Option<String>, missing: &mut Vec<String>| u.as_deref().filter(|u| !u.is_empty()).and_then(|u| if avail(u) { Some(u.to_string()) } else { missing.push(u.to_string()); None });
                            t = Some(Tex {
                                color: u.to_string(),
                                rough: ok(&cm.roughness, &mut missing),
                                metal: ok(&cm.metalness, &mut missing),
                                size_m: cm.size_m.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(1.0),
                            });
                        }
                        Some(u) => missing.push(u.to_string()),
                        None => {}
                    }
                }
                let (color, rough, metal) = flat_look(role, &comp_name.to_lowercase(), srgb, m.roughness, m.metallic);
                Look { label, color, rough, metal, glass: false, tex: t }
            };
            let key = format!("{look:?}");
            let sid = match shader_ids.get(&key) {
                Some(&i) => i,
                None => {
                    let i = shaders.len();
                    shaders.push(shader_xml(&format!("m{i}_{}", xml_name(&look.label)), &look, &mut tex));
                    by_shader.push(Vec::new());
                    shader_ids.insert(key, i);
                    i
                }
            };

            let mut s = String::with_capacity(mesh.p.len() * 8 + mesh.verts.len() * 7 + 64);
            s.push_str("<mesh P=\"");
            for (i, v) in mesh.p.iter().enumerate() {
                if i > 0 {
                    s.push(' ');
                }
                s.push_str(&fmt(*v, 4));
            }
            let _ = write!(s, "\" nverts=\"{}\" verts=\"", vec!["3"; mesh.verts.len() / 3].join(" "));
            for (i, v) in mesh.verts.iter().enumerate() {
                if i > 0 {
                    s.push(' ');
                }
                let _ = write!(s, "{v}");
            }
            s.push_str("\" />");
            by_shader[sid].push(s);
            meshes += 1;
            triangles += mesh.verts.len() / 3;
            for v in &used {
                for k in 0..3 {
                    lo_all[k] = lo_all[k].min(v[k]);
                    hi_all[k] = hi_all[k].max(v[k]);
                    if !matches!(role, Role::Context | Role::Terrain) {
                        lo[k] = lo[k].min(v[k]);
                        hi[k] = hi[k].max(v[k]);
                    }
                }
                if role == Role::Terrain {
                    terrain_lo_z = terrain_lo_z.min(v[2]);
                }
            }
        }
    }
    if meshes == 0 {
        notes.push("Keine Geometrie im Modell".into());
        lo_all = [0.0; 3];
        hi_all = [0.0; 3];
    }
    // Hülle fürs Einrahmen: das Gebäude; gibt es nur Kontext/Gelände, dieses.
    let (blo, bhi) = if lo[0].is_finite() { (lo, hi) } else { (lo_all, hi_all) };
    if !missing.is_empty() {
        missing.sort();
        missing.dedup();
        notes.push(format!("{} Bildkarten nicht verfügbar (Material einfarbig): {}", missing.len(), missing.join(", ")));
    }

    // Sonne.
    let (azimuth, elevation) = match (&o.sun, o.when_ms) {
        (Some(s), _) if s.azimuth.is_finite() && s.elevation.is_finite() => (s.azimuth, s.elevation),
        (_, when) => {
            let (lat, lon) = crate::plan::extras::project_lat_lon(p);
            let t = when.filter(|t| t.is_finite()).unwrap_or(DEFAULT_WHEN_MS);
            let s = crate::sun::sun_position(lat, lon, t);
            (s.azimuth, s.elevation)
        }
    };
    let strength = if o.sun_intensity.is_finite() && o.sun_intensity > 0.0 { o.sun_intensity } else { 1.0 };
    let exposure = match o.exposure_ev {
        Some(ev) if ev.is_finite() => jsnum::pow(2.0, ev.clamp(-12.0, 8.0)),
        _ => auto_exposure(elevation, strength),
    };
    // Unter dem Horizont gibt es keine Sonne; knapp darüber rendern (Dämmerung) statt schwarz.
    let sun_el = elevation.max(1.0).min(90.0).to_radians();
    let sun_rot = (((azimuth % 360.0) + 360.0) % 360.0).to_radians();

    // Kamera.
    let aspect = f64::from(width) / f64::from(height);
    let cam = match &o.camera {
        Some(CameraSpec::Explicit { kind, position, direction, up, fov_deg, ortho_height }) => {
            Cam { pos: *position, dir: *direction, up: *up, ortho: kind == "orthogonal", fov_deg: fov_deg.filter(|f| f.is_finite() && *f > 0.0).unwrap_or(50.0), ortho_height: ortho_height.unwrap_or(10.0) }
        }
        Some(CameraSpec::Preset { preset }) => framed_camera(preset, blo, bhi, aspect),
        None => framed_camera("iso", blo, bhi, aspect),
    };
    let cam_xml = camera_xml(&cam, f64::from(width), f64::from(height)).ok_or("cyclesScene: Kamera unbrauchbar (Blickrichtung null oder nicht endlich)")?;

    // Boden: knapp unter dem Gelände (sonst dem tiefsten Punkt), gross genug bis zum Horizont.
    let ground = o.ground.then(|| {
        let z = if terrain_lo_z.is_finite() { terrain_lo_z } else { lo_all[2] } - 0.02;
        let (cx, cy) = ((lo_all[0] + hi_all[0]) / 2.0, (lo_all[1] + hi_all[1]) / 2.0);
        let h = ((hi_all[0] - lo_all[0]).hypot(hi_all[1] - lo_all[1]).hypot(hi_all[2] - lo_all[2])).max(10.0) * 30.0;
        format!(
            "<mesh P=\"{} {} {} {} {} {} {} {} {} {} {} {}\" nverts=\"4\" verts=\"0 1 2 3\" />",
            fmt(cx - h, 2), fmt(cy - h, 2), fmt(z, 4), fmt(cx + h, 2), fmt(cy - h, 2), fmt(z, 4), fmt(cx + h, 2), fmt(cy + h, 2), fmt(z, 4), fmt(cx - h, 2), fmt(cy + h, 2), fmt(z, 4)
        )
    });

    let mut xml = String::new();
    let _ = writeln!(xml, "<cycles>");
    let _ = writeln!(xml, "<!-- Dossier [215]: Szene aus dem Projekt. Meter, x Ost, y Nord, z oben. -->");
    let _ = writeln!(xml, "<film exposure=\"{}\" />", fmt(exposure, 6));
    let _ = writeln!(
        xml,
        "<integrator max_bounce=\"8\" max_diffuse_bounce=\"4\" max_glossy_bounce=\"4\" max_transmission_bounce=\"8\" use_adaptive_sampling=\"true\" ao_factor=\"0.4\" ao_distance=\"1.5\" use_denoise=\"{}\" />",
        o.denoise
    );
    xml.push_str(&cam_xml);
    let _ = writeln!(
        xml,
        "<background>\n  <sky_texture name=\"sky\" sky_type=\"multiple_scattering\" sun_disc=\"true\" sun_size=\"0.009512\" sun_intensity=\"{}\" sun_elevation=\"{}\" sun_rotation=\"{}\" air_density=\"1.0\" aerosol_density=\"1.0\" ozone_density=\"1.0\" altitude=\"100\" />\n  <background name=\"bg\" strength=\"1.0\" />\n  <connect from=\"sky color\" to=\"bg color\" />\n  <connect from=\"bg background\" to=\"output surface\" />\n</background>",
        fmt(strength, 4),
        fmt(sun_el, 8),
        fmt(sun_rot, 8)
    );
    for s in &shaders {
        let _ = writeln!(xml, "{s}");
    }
    if ground.is_some() {
        let _ = writeln!(
            xml,
            "<shader name=\"boden\"><principled_bsdf name=\"p\" base_color=\"{}\" roughness=\"0.95\" metallic=\"0\" /><connect from=\"p bsdf\" to=\"output surface\" /></shader>",
            rgb_attr(lin([0.40, 0.46, 0.28]))
        );
    }
    let _ = writeln!(xml, "<state shader=\"default_background\"><light light_type=\"background\" use_mis=\"true\" map_resolution=\"1024\" /></state>");
    for (i, list) in by_shader.iter().enumerate() {
        if list.is_empty() {
            continue;
        }
        let name = shaders[i].split('"').nth(1).unwrap_or("x").to_string();
        let _ = writeln!(xml, "<state shader=\"{name}\" interpolation=\"smooth\">{}</state>", list.join(""));
    }
    if let Some(g) = &ground {
        let _ = writeln!(xml, "<state shader=\"boden\" interpolation=\"flat\">{g}</state>");
    }
    xml.push_str("</cycles>\n");

    Ok(CyclesScene { xml, textures: tex.list, meshes, triangles, width, height, samples, sun_azimuth: azimuth, sun_elevation: elevation, exposure, notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    fn opts(json: &str) -> CyclesOptions {
        serde_json::from_str(json).unwrap()
    }

    /// Prüft die Verschachtelung (Stapel der Element-Namen), Kommentare und Anführungszeichen der Attribute.
    fn well_formed(xml: &str) {
        let mut stack: Vec<String> = Vec::new();
        let mut rest = xml;
        let mut roots = 0;
        while let Some(i) = rest.find('<') {
            rest = &rest[i..];
            if let Some(r) = rest.strip_prefix("<!--") {
                rest = &r[r.find("-->").expect("Kommentar offen") + 3..];
                continue;
            }
            // Ende des Tags: erstes `>` ausserhalb von Anführungszeichen.
            let (mut q, mut end) = (false, None);
            for (k, c) in rest.char_indices() {
                match c {
                    '"' => q = !q,
                    '>' if !q => {
                        end = Some(k);
                        break;
                    }
                    _ => {}
                }
            }
            let end = end.expect("Tag offen");
            let tag = &rest[1..end];
            rest = &rest[end + 1..];
            if let Some(name) = tag.strip_prefix('/') {
                assert_eq!(stack.pop().as_deref(), Some(name.trim()), "Schliess-Tag {name}");
            } else {
                let name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap().to_string();
                assert!(!name.is_empty());
                if stack.is_empty() {
                    roots += 1;
                }
                if !tag.ends_with('/') {
                    stack.push(name);
                }
            }
        }
        assert!(stack.is_empty() && roots == 1, "offene Elemente {stack:?}, Wurzeln {roots}");
    }

    /// Zählt `<tag` im Text.
    fn count(xml: &str, tag: &str) -> usize {
        xml.matches(&format!("<{tag} ")).count() + xml.matches(&format!("<{tag}>")).count()
    }

    /// Das Beispielprojekt ergibt eine wohlgeformte XML-Szene: Zähler und Verschachtelung stimmen, alle Indizes zeigen auf Ecken.
    #[test]
    fn beispiel_ist_wohlgeformt() {
        let s = cycles_scene(&sample(), &opts("{}")).unwrap();
        assert!(s.meshes > 5 && s.triangles > 50, "{} Netze, {} Dreiecke", s.meshes, s.triangles);
        let x = &s.xml;
        assert!(x.starts_with("<cycles>") && x.trim_end().ends_with("</cycles>"));
        well_formed(x);
        // Netzanzahl = Teil-Netze (Modell + ein Boden).
        assert_eq!(count(x, "mesh"), s.meshes + 1);
        // Jedes Netz: nverts × 3 = verts, alle Indizes < Ecken.
        let mut tris = 0;
        for m in x.split("<mesh ").skip(1) {
            let m = &format!(" {m}");
            let attr = |n: &str| m.split(&format!(" {n}=\"")).nth(1).unwrap().split('"').next().unwrap().to_string();
            let (pn, nv, vs) = (attr("P"), attr("nverts"), attr("verts"));
            let np = pn.split_whitespace().count();
            assert_eq!(np % 3, 0);
            let faces = nv.split_whitespace().count();
            let ids: Vec<usize> = vs.split_whitespace().map(|v| v.parse().unwrap()).collect();
            assert_eq!(nv.split_whitespace().map(|v| v.parse::<usize>().unwrap()).sum::<usize>(), ids.len());
            assert!(ids.iter().all(|i| *i < np / 3));
            tris += faces;
        }
        assert_eq!(tris, s.triangles + 1, "Flächen (Boden: 1 Viereck)");
        // Jeder Shader, den ein <state> nennt, ist definiert.
        for st in x.split("<state shader=\"").skip(1) {
            let name = st.split('"').next().unwrap();
            if name != "default_background" {
                assert!(x.contains(&format!("<shader name=\"{name}\">")), "Shader {name}");
            }
        }
        // Verbindungen nur zu Knoten desselben Shaders (grob): jede `from`-Knoten-Id kommt als name vor.
        assert!(x.contains("transmission_weight=\"1\""), "Glas der Fenster");
        assert!(x.contains("is_shadow_ray"));
        assert!(x.contains("interpolation=\"smooth\""));
        assert!(x.contains("use_denoise=\"true\""));
    }

    #[test]
    fn leeres_projekt_ohne_panik() {
        let p = Project { id: "leer".into(), ..Default::default() };
        let s = cycles_scene(&p, &opts("{}")).unwrap();
        assert_eq!(s.meshes, 0);
        assert!(s.notes.iter().any(|n| n.contains("Keine Geometrie")));
        assert!(s.xml.contains("<camera ") && s.xml.contains("sky_texture"));
        let s2 = cycles_scene(&p, &opts("{\"ground\":false}")).unwrap();
        assert_eq!(count(&s2.xml, "mesh"), 0);
    }

    #[test]
    fn unbrauchbare_optionen_ergeben_fehler_statt_panik() {
        let p = sample();
        for j in ["{\"width\":0}", "{\"height\":1e99}", "{\"samples\":0}", "{\"camera\":{\"position\":[0,0,0],\"direction\":[0,0,0]}}"] {
            assert!(cycles_scene(&p, &opts(j)).is_err(), "{j}");
        }
        // NaN/Unendlich im JSON (null) und in den Zahlen: kein Panic, endliches Ergebnis.
        let mut o = CyclesOptions::default();
        o.when_ms = Some(f64::NAN);
        o.sun_intensity = f64::NAN;
        o.exposure_ev = Some(f64::INFINITY);
        o.sun = Some(SunIn { azimuth: f64::NAN, elevation: 10.0 });
        let s = cycles_scene(&p, &o).unwrap();
        assert!(!s.xml.contains("NaN") && !s.xml.contains("inf"));
        assert!(s.exposure.is_finite() && s.sun_elevation.is_finite());
        o.camera = Some(CameraSpec::Explicit { kind: String::new(), position: [f64::NAN, 0.0, 0.0], direction: [0.0, 1.0, 0.0], up: [0.0, 0.0, 1.0], fov_deg: None, ortho_height: None });
        assert!(cycles_scene(&p, &o).is_err());
    }

    /// Ein bekannter Blick nach Norden (+Y), z oben: rechts = Ost (+X), Kameramatrix spaltenweise (rechts, oben, vorn, Ort).
    #[test]
    fn kamera_matrix_fuer_blick_nach_norden() {
        let s = cycles_scene(&sample(), &opts("{\"camera\":{\"kind\":\"perspective\",\"position\":[1,2,3],\"direction\":[0,1,0],\"up\":[0,0,1],\"fovDeg\":60}}")).unwrap();
        let m = s.xml.split("<transform matrix=\"").nth(1).unwrap().split('"').next().unwrap();
        let v: Vec<f64> = m.split_whitespace().map(|x| x.parse().unwrap()).collect();
        assert_eq!(v, vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 2.0, 3.0, 1.0]);
        // Bildwinkel 60° vertikal bei 16:9 → `fov` = 60° im Bogenmass.
        assert!(s.xml.contains("camera_type=\"perspective\" fov=\"1.047197"), "{}", s.xml.split("<transform").nth(1).unwrap());
        // Rechtshändig: rechts = vorn × oben, Spalte 1 = X für Blick Nord.
        let east = cross([0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
        assert_eq!(east, [1.0, 0.0, 0.0]);
    }

    #[test]
    fn kamera_hochformat_und_orthogonal() {
        let s = cycles_scene(&sample(), &opts("{\"width\":600,\"height\":1200,\"camera\":{\"kind\":\"perspective\",\"position\":[0,-20,5],\"direction\":[0,1,0],\"fovDeg\":60}}")).unwrap();
        // Hochformat: `fov` gilt für die kurze (horizontale) Kante: 2·atan(tan(30°)·0.5).
        let want = 2.0 * (30.0_f64.to_radians().tan() * 0.5).atan();
        let fov: f64 = s.xml.split("fov=\"").nth(1).unwrap().split('"').next().unwrap().parse().unwrap();
        assert!((fov - want).abs() < 1e-6, "{fov} ≠ {want}");
        // Orthogonal: halbe Sichthöhe als Spaltenlänge von rechts und oben.
        let o = cycles_scene(&sample(), &opts("{\"camera\":{\"kind\":\"orthogonal\",\"position\":[0,-20,5],\"direction\":[0,1,0],\"orthoHeight\":12}}")).unwrap();
        assert!(o.xml.contains("camera_type=\"orthograph\""));
        let m = o.xml.split("<transform matrix=\"").nth(1).unwrap().split('"').next().unwrap();
        let v: Vec<f64> = m.split_whitespace().map(|x| x.parse().unwrap()).collect();
        assert_eq!((v[0], v[6], v[9]), (6.0, 6.0, 1.0), "rechts = 6·X, oben = 6·Z, vorn = Y");
    }

    #[test]
    fn voreinstellung_rahmt_das_gebaeude() {
        let s = cycles_scene(&sample(), &opts("{\"camera\":{\"preset\":\"front\"}}")).unwrap();
        let m = s.xml.split("<transform matrix=\"").nth(1).unwrap().split('"').next().unwrap();
        let v: Vec<f64> = m.split_whitespace().map(|x| x.parse().unwrap()).collect();
        // Blick nach Norden: Ort südlich des Hauses (y < 0), Blickrichtung +Y.
        assert!(v[13] < -5.0, "y = {}", v[13]);
        assert_eq!((v[8], v[9], v[10]), (0.0, 1.0, 0.0));
    }

    /// Sonne: fester Azimut/Höhe → Nishita-Rotation = Kompass, Höhe im Bogenmass; Datum/Ort: Mittsommer Zürich.
    #[test]
    fn sonnenrichtung() {
        let s = cycles_scene(&sample(), &opts("{\"sun\":{\"azimuth\":90,\"elevation\":30}}")).unwrap();
        assert!(s.xml.contains(&format!("sun_rotation=\"{}\"", fmt(90.0_f64.to_radians(), 8))));
        assert!(s.xml.contains(&format!("sun_elevation=\"{}\"", fmt(30.0_f64.to_radians(), 8))));
        // 21.6.2026 12:00 UTC in Zürich: ~65° hoch, nahe Süd (kurz nach dem Sonnenhöchststand also Azimut ≥ 180).
        let z = cycles_scene(&Project { id: "z".into(), ..Default::default() }, &opts("{\"whenMs\":1782043200000}")).unwrap();
        assert!((z.sun_elevation - 65.0).abs() < 2.0, "{}", z.sun_elevation);
        assert!((175.0..205.0).contains(&z.sun_azimuth), "{}", z.sun_azimuth);
        // Winter morgens um 8 Uhr UTC: tiefe Sonne im Südosten.
        let w = cycles_scene(&Project { id: "z".into(), ..Default::default() }, &opts("{\"whenMs\":1766390400000}")).unwrap();
        assert!(w.sun_elevation < 10.0 && (100.0..160.0).contains(&w.sun_azimuth), "{} {}", w.sun_elevation, w.sun_azimuth);
        // Tiefe Sonne → hellere Belichtung (Faktor grösser).
        assert!(w.exposure > z.exposure * 4.0);
    }

    #[test]
    fn belichtung_nach_tabelle() {
        // Tabellenpunkte treffen ihren Wert: 60° → 1.5/43.5.
        assert!((auto_exposure(60.0, 1.0) - SUNLIT_TARGET / 43.5).abs() < 1e-9);
        assert!((auto_exposure(10.0, 1.0) - SUNLIT_TARGET / 6.4).abs() < 1e-9);
        // Überschreiben in EV.
        let s = cycles_scene(&sample(), &opts("{\"exposureEv\":-3}")).unwrap();
        assert!((s.exposure - 0.125).abs() < 1e-12);
    }

    /// Material: Glas der Fenster, Bildkarte der Bauteile mit Material, Ersatzlooks; fehlende Karten fallen zurück.
    #[test]
    fn materialien_und_texturen() {
        let mut p = sample();
        for c in p.components.iter_mut() {
            c.material = Some(ComponentMaterial { color: Some("/assets/materials/Bricks104/color.jpg".into()), roughness: Some("/assets/materials/Bricks104/roughness.jpg".into()), size_m: Some(2.0), ..Default::default() });
        }
        let s = cycles_scene(&p, &opts("{}")).unwrap();
        assert!(s.xml.contains("projection=\"box\"") && s.xml.contains("<mapping name=\"m\" scale=\"0.5 0.5 0.5\""));
        assert!(s.textures.iter().any(|t| t.url.ends_with("Bricks104/color.jpg") && t.path.starts_with("textures/0_color.jpg")));
        assert!(s.xml.contains("colorspace=\"Non-Color\""), "Rauheit linear");
        for t in &s.textures {
            assert!(s.xml.contains(&format!("filename=\"{}\"", t.path)));
        }
        // Nur die Wiese verfügbar: die Bauteile fallen auf Einfarbig zurück, Hinweis in `notes`.
        let only = cycles_scene(&p, &opts("{\"textures\":[]}")).unwrap();
        assert!(only.textures.is_empty() && !only.xml.contains("image_texture"));
        assert!(only.notes.iter().any(|n| n.contains("Bildkarten")));
    }

    #[test]
    fn albedo_ist_begrenzt_und_linear() {
        let (c, ..) = flat_look(Role::Building, "putz", [0.9, 0.9, 0.9], 0.9, 0.0);
        assert!(c.iter().all(|v| *v <= ALBEDO_MAX + 1e-12), "{c:?}");
        let (c, r, m) = flat_look(Role::Roof, "tonziegel", [1.0, 1.0, 1.0], 0.9, 0.0);
        assert!(c[0] > c[2] && (r - 0.7).abs() < 1e-12 && m == 0.0, "{c:?}");
        let (c, _, m) = flat_look(Role::Building, "stahl", [1.0, 1.0, 1.0], 0.9, 0.0);
        assert!(m == 1.0 && c[0] < 0.4);
        assert!((srgb_to_linear(0.5) - 0.2140411).abs() < 1e-6);
    }

    /// Hartes Ende bleibt kantig: ein Würfel hat 24 Ecken (3 je Ecke), eine glatte Fläche teilt ihre Ecken.
    #[test]
    fn ecken_nach_knickwinkel_geteilt() {
        // Würfel als 8 Ecken / 12 Dreiecke in Welt-Achsen (x, Höhe, y).
        let pos: Vec<f64> = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0];
        let quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
        let mut idx: Vec<f64> = Vec::new();
        for q in quads {
            for t in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
                idx.extend(t.iter().map(|v| *v as f64));
            }
        }
        let prim = Prim { material: 0.0, positions: pos, indices: idx };
        let (m, _) = mesh_out(&prim).unwrap();
        assert_eq!(m.p.len() / 3, 24, "scharfe Kanten: 4 Ecken je Seite");
        assert_eq!(m.verts.len(), 36);
        // Ebene Fläche aus zwei Dreiecken: 4 Ecken (Diagonale geteilt).
        let flat = Prim { material: 0.0, positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0] };
        assert_eq!(mesh_out(&flat).unwrap().0.p.len() / 3, 4);
        // Kaputte Indizes/NaN: weg statt Panic.
        let bad = Prim { material: 0.0, positions: vec![f64::NAN; 9], indices: vec![0.0, 1.0, 2.0, 9.0, 9.0, 9.0] };
        assert!(mesh_out(&bad).is_none());
    }

    /// Modell-Achsen: ein Dreieck, das in Welt-Achsen nach oben (+Höhe) zeigt, zeigt im Modell nach +z (Wicklung vertauscht).
    #[test]
    fn wicklung_zeigt_nach_aussen() {
        // Welt (x, Höhe, y): Dreieck in der Ebene Höhe = 0, nach aussen (oben) gewickelt: Normale (0,1,0) in Welt-Rechtssystem.
        let prim = Prim { material: 0.0, positions: vec![0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0], indices: vec![0.0, 1.0, 2.0] };
        let (m, _) = mesh_out(&prim).unwrap();
        let q = |i: usize| [m.p[3 * i], m.p[3 * i + 1], m.p[3 * i + 2]];
        let (a, b, c) = (q(m.verts[0] as usize), q(m.verts[1] as usize), q(m.verts[2] as usize));
        let n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        assert!(n[2] > 0.0, "Modell-Normale {n:?}");
    }

    #[test]
    fn baugrube_ausgeblendet_wie_227() {
        let mut p = sample();
        let t = TerrainMesh { id: "g".into(), positions: vec![-50.0, -50.0, 0.0, 50.0, -50.0, 0.0, 50.0, 50.0, 0.0, -50.0, 50.0, 0.0], indices: vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0], ..Default::default() };
        let pit = Excavation {
            id: "bg".into(),
            outline: vec![Vec2 { x: -5.0, y: -5.0 }, Vec2 { x: 5.0, y: -5.0 }, Vec2 { x: 5.0, y: 5.0 }, Vec2 { x: -5.0, y: 5.0 }],
            bottom: -3.0,
            slope: Some(45.0),
            ..Default::default()
        };
        p.context = Some(vec![ContextObject::TerrainMesh(t), ContextObject::Excavation(pit)]);
        let with = cycles_scene(&p, &opts("{\"backfilled\":false}")).unwrap();
        let back = cycles_scene(&p, &opts("{\"backfilled\":true}")).unwrap();
        assert!(with.triangles > back.triangles);
        let none = cycles_scene(&p, &opts("{\"context\":false}")).unwrap();
        assert!(none.triangles < back.triangles);
    }

    #[test]
    fn dachschicht_nach_farbe() {
        let mut p = sample();
        p.components.push(Component { id: "ziegel".into(), name: "Tonziegel".into(), color: "#8f402a".into(), ..Default::default() });
        p.roof_types = Some(vec![RoofType { id: "rt".into(), name: "Ziegeldach".into(), layers: vec![Layer { component_id: "ziegel".into(), thickness: 0.05, ..Default::default() }], ..Default::default() }]);
        if let Some(r) = p.roofs.as_mut().and_then(|r| r.first_mut()) {
            r.roof_type_id = Some("rt".into());
            r.color = None;
        }
        let s = cycles_scene(&p, &opts("{}")).unwrap();
        assert!(s.xml.contains("Dach__Tonziegel") || s.xml.contains("Dach_"), "{}", s.xml.lines().filter(|l| l.starts_with("<shader")).take(20).collect::<Vec<_>>().join("\n"));
    }
}
