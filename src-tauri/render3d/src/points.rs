// Punktwolken für den 3D-Viewport ([27], Stufe 1): GPU-freie Schicht (Puffer-Aufbau, Farbabbildung,
// WGSL-Quelle). Die Pipeline selbst liegt in `gpu_points.rs` (Feature "render") und läuft so
// unverändert im Browser (WebGPU, `web.rs`) wie nativ (Metal/Vulkan: `render_png`, `native.rs`).
//
// Eingabe: wie der Leser sie liefert (`src/io/pointCloud.ts`, `fileio/pointcloud*.rs`) — `xyz` als
// f32 RELATIV zu einem Ursprung, dazu der Modellversatz dieses Ursprungs als f64 (Modell-Meter,
// x = Ost, y = Nord, z = Höhe). Die Summe wird hier in f64 gebildet und erst danach auf f32
// gerundet: LV95-Koordinaten (2,6 Mio. m) kippen so nie in f32 (dort nur ~0,25 m Auflösung).
//
// Achsen: wie die übrigen ECHTEN Geo-Rohdaten (Gelände/Import, `mesh::append_context_mesh`,
// `MeshKind::Terrain`): Modell (x, y, z) → world (x, z, −y). So liegt eine Punktwolke deckungsgleich
// auf einem swissALTI3D-Gelände desselben Standort-Bezugs.
//
// Darstellung: ein Instanz-Quad je Punkt (6 Vertices aus `vertex_index`, keine Geometrie je Punkt
// im Puffer), feste Grösse in Bildschirm-Pixeln, tiefengetestet gegen das Modell. Farben werden auf
// der CPU berechnet (eine Quelle der Wahrheit, testbar) und als eigener RGBA8-Puffer neben den
// Positionen gehalten — ein Wechsel des Farbmodus lädt nur diesen kleinen Puffer neu.

/// Farbmodus einer Punktwolke.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointColorMode {
    /// Gemessene Farbe (RGB aus der Datei); ohne Farbe → Höhe.
    Rgb,
    /// Intensität als Grauwert (robuster Bereich 1.–99. Perzentil); ohne Intensität → Höhe.
    Intensity,
    /// ASPRS-Klassifikation (Boden, Vegetation, Gebäude …); ohne Klassen → Höhe.
    Class,
    /// Höhe als Farbverlauf (blau → grün → gelb → rot).
    Height,
}

impl PointColorMode {
    /// Parst den API-String ("rgb" | "intensity" | "class" | "height"); Unbekanntes → `Rgb`.
    pub fn from_str_or_rgb(s: &str) -> Self {
        match s {
            "intensity" => PointColorMode::Intensity,
            "class" => PointColorMode::Class,
            "height" => PointColorMode::Height,
            _ => PointColorMode::Rgb,
        }
    }
}

/// Höchstzahl Punkte je GPU-Puffer. 4 Mio. × 12 Byte = 48 MB — sicher unter dem WebGPU-Standard-
/// limit `maxBufferSize` (256 MB) und `maxStorageBufferBindingSize`; grössere Wolken werden auf
/// mehrere Puffer (je ein Draw-Call) verteilt, nie ein Draw je Punkt.
pub const MAX_POINTS_PER_CHUNK: usize = 4_000_000;

/// Grenzen der Punktgrösse in Bildschirm-Pixeln (Klemmung aller Eingaben).
pub const MIN_POINT_SIZE_PX: f32 = 1.0;
pub const MAX_POINT_SIZE_PX: f32 = 32.0;

/// Klemmt eine Punktgrösse (NaN → 2 px).
pub fn clamp_point_size(px: f32) -> f32 {
    if px.is_finite() {
        px.clamp(MIN_POINT_SIZE_PX, MAX_POINT_SIZE_PX)
    } else {
        2.0
    }
}

/// CPU-Seite einer Punktwolke: world-Positionen (f32, bereits mit Versatz) und die optionalen
/// Attribute, gefiltert auf gültige Punkte (NaN/∞ fliegen raus, Attribute bleiben ausgerichtet).
#[derive(Clone, Debug, Default)]
pub struct PointCloudCpu {
    /// world x, y (= Höhe), z (= −Nord) je Punkt.
    pub positions: Vec<f32>,
    pub rgb: Option<Vec<u8>>,
    pub intensity: Option<Vec<u16>>,
    pub classification: Option<Vec<u8>>,
    /// Höhenbereich (world y) aller Punkte, für den Höhen-Farbverlauf.
    pub height_range: [f32; 2],
}

impl PointCloudCpu {
    /// Baut die world-Positionen aus `xyz` (relativ, f32) + `offset` (Modell-Meter des Ursprungs, f64).
    /// Attribute mit falscher Länge werden ignoriert (nicht abgeschnitten — lieber keine Farbe als
    /// verrutschte). `None` bei unbrauchbarer Eingabe (kein vollständiger Punkt, Versatz nicht endlich).
    pub fn from_raw(
        xyz: &[f32],
        rgb: &[u8],
        intensity: &[u16],
        classification: &[u8],
        offset: [f64; 3],
    ) -> Option<Self> {
        if !offset.iter().all(|v| v.is_finite()) {
            return None;
        }
        let n = xyz.len() / 3;
        if n == 0 {
            return None;
        }
        let rgb = (rgb.len() == n * 3).then_some(rgb);
        let intensity = (intensity.len() == n).then_some(intensity);
        let classification = (classification.len() == n).then_some(classification);

        let mut positions = Vec::with_capacity(n * 3);
        let mut out_rgb = rgb.map(|_| Vec::with_capacity(n * 3));
        let mut out_int = intensity.map(|_| Vec::with_capacity(n));
        let mut out_cls = classification.map(|_| Vec::with_capacity(n));
        let mut hmin = f32::INFINITY;
        let mut hmax = f32::NEG_INFINITY;
        for i in 0..n {
            let (x, y, z) = (xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
            if !(x.is_finite() && y.is_finite() && z.is_finite()) {
                continue;
            }
            // In f64 addieren, erst dann runden (LV95-fest).
            let wx = (offset[0] + x as f64) as f32;
            let wy = (offset[2] + z as f64) as f32;
            let wz = -((offset[1] + y as f64) as f32);
            if !(wx.is_finite() && wy.is_finite() && wz.is_finite()) {
                continue;
            }
            positions.extend_from_slice(&[wx, wy, wz]);
            hmin = hmin.min(wy);
            hmax = hmax.max(wy);
            if let (Some(o), Some(src)) = (out_rgb.as_mut(), rgb) {
                o.extend_from_slice(&src[i * 3..i * 3 + 3]);
            }
            if let (Some(o), Some(src)) = (out_int.as_mut(), intensity) {
                o.push(src[i]);
            }
            if let (Some(o), Some(src)) = (out_cls.as_mut(), classification) {
                o.push(src[i]);
            }
        }
        if positions.is_empty() {
            return None;
        }
        Some(Self {
            positions,
            rgb: out_rgb,
            intensity: out_int,
            classification: out_cls,
            height_range: [hmin, hmax],
        })
    }

    /// Anzahl Punkte.
    pub fn len(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    /// Welcher Modus tatsächlich gezeichnet wird (fehlt das Attribut, fällt er auf Höhe zurück).
    pub fn effective_mode(&self, mode: PointColorMode) -> PointColorMode {
        let has = match mode {
            PointColorMode::Rgb => self.rgb.is_some(),
            PointColorMode::Intensity => self.intensity.is_some(),
            PointColorMode::Class => self.classification.is_some(),
            PointColorMode::Height => true,
        };
        if has {
            mode
        } else {
            PointColorMode::Height
        }
    }

    /// RGBA8 je Punkt (Alpha 255) für den Farbmodus — der Inhalt des Farb-Vertex-Puffers.
    pub fn colors(&self, mode: PointColorMode) -> Vec<[u8; 4]> {
        let n = self.len();
        match self.effective_mode(mode) {
            PointColorMode::Rgb => {
                let rgb = self.rgb.as_deref().unwrap_or(&[]);
                (0..n).map(|i| [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255]).collect()
            }
            PointColorMode::Intensity => {
                let it = self.intensity.as_deref().unwrap_or(&[]);
                let [lo, hi] = intensity_window(it);
                let span = (hi as f32 - lo as f32).max(1.0);
                it.iter()
                    .map(|&v| {
                        let t = ((v as f32 - lo as f32) / span).clamp(0.0, 1.0);
                        // Leicht angehoben (nie ganz schwarz) — dunkle Punkte bleiben auf dem
                        // dunklen Hintergrund/Modell sichtbar.
                        let g = (30.0 + t * 225.0).round() as u8;
                        [g, g, g, 255]
                    })
                    .collect()
            }
            PointColorMode::Class => {
                let cls = self.classification.as_deref().unwrap_or(&[]);
                cls.iter()
                    .map(|&c| {
                        let [r, g, b] = class_color(c);
                        [r, g, b, 255]
                    })
                    .collect()
            }
            PointColorMode::Height => {
                let [lo, hi] = self.height_range;
                let span = (hi - lo).max(1e-6);
                (0..n)
                    .map(|i| {
                        let t = (self.positions[i * 3 + 1] - lo) / span;
                        let [r, g, b] = height_ramp(t);
                        [r, g, b, 255]
                    })
                    .collect()
            }
        }
    }
}

/// Robuster Intensitätsbereich: 1.–99. Perzentil (Histogramm über u16), damit einzelne Ausreisser
/// (Reflektoren) nicht die ganze Wolke grau in grau machen. Leer → [0, 65535].
pub fn intensity_window(values: &[u16]) -> [u16; 2] {
    if values.is_empty() {
        return [0, u16::MAX];
    }
    let mut hist = vec![0u32; 65_536];
    for &v in values {
        hist[v as usize] += 1;
    }
    let n = values.len() as u64;
    let lo_rank = n / 100;
    let hi_rank = n - 1 - n / 100;
    let mut acc: u64 = 0;
    let mut lo = None;
    let mut hi = u16::MAX;
    for (v, &c) in hist.iter().enumerate() {
        if c == 0 {
            continue;
        }
        let next = acc + c as u64;
        if lo.is_none() && next > lo_rank {
            lo = Some(v as u16);
        }
        if next > hi_rank {
            hi = v as u16;
            break;
        }
        acc = next;
    }
    let lo = lo.unwrap_or(0);
    [lo, hi.max(lo)]
}

/// Farben der ASPRS-Standardklassen (LAS 1.4, Tabelle 17). Unbekannte/benutzerdefinierte Klassen →
/// neutrales Grau.
pub fn class_color(c: u8) -> [u8; 3] {
    match c {
        0 | 1 => [170, 170, 170], // nie klassifiziert / nicht zugeordnet
        2 => [166, 120, 72],      // Boden
        3 => [170, 210, 120],     // niedrige Vegetation
        4 => [96, 170, 72],       // mittlere Vegetation
        5 => [40, 120, 50],       // hohe Vegetation
        6 => [214, 90, 70],       // Gebäude
        7 => [255, 0, 255],       // Rauschen (tief)
        8 => [240, 220, 60],      // Modell-Schlüsselpunkt (LAS 1.0–1.3)
        9 => [70, 130, 220],      // Wasser
        10 => [120, 80, 160],     // Schiene
        11 => [90, 90, 90],       // Strassenoberfläche
        13 => [250, 160, 40],     // Leitungsschutz
        14 => [250, 200, 40],     // Leitung
        15 => [200, 60, 160],     // Mast
        17 => [130, 110, 100],    // Brücke
        18 => [255, 80, 255],     // Rauschen (hoch)
        _ => [140, 140, 140],
    }
}

/// Höhen-Farbverlauf (t ∈ [0,1], ausserhalb geklemmt): blau → cyan → grün → gelb → rot.
pub fn height_ramp(t: f32) -> [u8; 3] {
    const STOPS: [[f32; 3]; 5] = [
        [40.0, 70.0, 200.0],
        [40.0, 180.0, 220.0],
        [80.0, 190.0, 80.0],
        [240.0, 220.0, 60.0],
        [220.0, 60.0, 40.0],
    ];
    let t = if t.is_finite() { t.clamp(0.0, 1.0) } else { 0.0 };
    let f = t * (STOPS.len() - 1) as f32;
    let i = (f.floor() as usize).min(STOPS.len() - 2);
    let u = f - i as f32;
    let a = STOPS[i];
    let b = STOPS[i + 1];
    [
        (a[0] + (b[0] - a[0]) * u).round() as u8,
        (a[1] + (b[1] - a[1]) * u).round() as u8,
        (a[2] + (b[2] - a[2]) * u).round() as u8,
    ]
}

/// Teilt `n` Punkte in Puffer-Bereiche von höchstens `MAX_POINTS_PER_CHUNK` (Start, Anzahl).
pub fn chunk_ranges(n: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut s = 0;
    while s < n {
        let c = (n - s).min(MAX_POINTS_PER_CHUNK);
        out.push((s, c));
        s += c;
    }
    out
}

/// Vertex-Shader-Ecken des Instanz-Quads (zwei Dreiecke, CCW), in Einheiten der halben Punktgrösse.
pub const QUAD_CORNERS: [[f32; 2]; 6] = [
    [-1.0, -1.0],
    [1.0, -1.0],
    [1.0, 1.0],
    [-1.0, -1.0],
    [1.0, 1.0],
    [-1.0, 1.0],
];

/// WGSL der Punkt-Pipeline. group(0) = dasselbe `Globals` wie Mesh/Grid (View-Projektion,
/// Live-Schnitt); group(1) = Punkt-Parameter (`params.x` = Grösse px, `yz` = Viewport px,
/// `w` > 0.5 = runde Punkte). Instanz-Attribute: Position (world) + RGBA8-Farbe.
pub const POINT_WGSL: &str = r#"
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

struct PointParams {
    params : vec4<f32>,
};
@group(1) @binding(0) var<uniform> point : PointParams;

struct VsIn {
    @builtin(vertex_index) vi : u32,
    @location(0) position : vec3<f32>,
    @location(1) color    : vec4<f32>,
};

struct VsOut {
    @builtin(position) clip_pos : vec4<f32>,
    @location(0) color     : vec3<f32>,
    @location(1) world_pos : vec3<f32>,
    @location(2) corner    : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
    );
    let c = corners[in.vi % 6u];
    var clip = globals.view_proj * vec4<f32>(in.position, 1.0);
    // Feste Bildschirmgrösse: Versatz in NDC (2 / Viewport je Pixel), mit w multipliziert, damit
    // die Perspektiv-Division ihn nicht wieder verkleinert.
    let vp = max(point.params.yz, vec2<f32>(1.0, 1.0));
    let half_px = 0.5 * point.params.x;
    clip = vec4<f32>(clip.xy + c * half_px * 2.0 / vp * clip.w, clip.zw);
    var out : VsOut;
    out.clip_pos = clip;
    out.color = in.color.rgb;
    out.world_pos = in.position;
    out.corner = c;
    return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    // Live-Schnitt wie Mesh/Grid: was hinter der Ebene liegt, fällt weg.
    if (globals.mode.y > 0.5) {
        if (dot(in.world_pos, globals.section_plane.xyz) + globals.section_plane.w > 0.0) {
            discard;
        }
    }
    if (point.params.w > 0.5 && dot(in.corner, in.corner) > 1.0) {
        discard;
    }
    return vec4<f32>(in.color, 1.0);
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_mode_parses_api_strings() {
        assert_eq!(PointColorMode::from_str_or_rgb("rgb"), PointColorMode::Rgb);
        assert_eq!(PointColorMode::from_str_or_rgb("intensity"), PointColorMode::Intensity);
        assert_eq!(PointColorMode::from_str_or_rgb("class"), PointColorMode::Class);
        assert_eq!(PointColorMode::from_str_or_rgb("height"), PointColorMode::Height);
        assert_eq!(PointColorMode::from_str_or_rgb("quatsch"), PointColorMode::Rgb);
    }

    #[test]
    fn positions_map_model_to_world_like_terrain() {
        // Modell (x, y, z) → world (x, z, −y), Versatz addiert.
        let c = PointCloudCpu::from_raw(&[1.0, 2.0, 3.0], &[], &[], &[], [10.0, 20.0, 30.0]).unwrap();
        assert_eq!(c.positions, vec![11.0, 33.0, -22.0]);
        assert_eq!(c.height_range, [33.0, 33.0]);
    }

    #[test]
    fn lv95_offset_is_added_in_f64() {
        // Ursprung in LV95 (2,6 Mio. m), Projekt-Nullpunkt 2 600 000 / 1 200 000: Versatz klein,
        // aber die Summe Ursprung + Punkt darf nicht über f32 laufen. Hier: Versatz −0,5 (aus
        // f64-Differenz), Punkt 0,123 → 0,623 mm-genau.
        let off = [2_600_123.0_f64 - 2_600_123.5, 1_200_000.0 - 1_200_000.25, 0.0];
        let c = PointCloudCpu::from_raw(&[0.123, 0.001, 0.0], &[], &[], &[], off).unwrap();
        assert!((c.positions[0] - (-0.377)).abs() < 1e-6);
        assert!((c.positions[2] - 0.249).abs() < 1e-6);
    }

    #[test]
    fn invalid_points_are_dropped_and_attributes_stay_aligned() {
        let xyz = [0.0, 0.0, 0.0, f32::NAN, 0.0, 0.0, 1.0, 1.0, 1.0];
        let rgb = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        let it = [10u16, 20, 30];
        let cls = [2u8, 6, 9];
        let c = PointCloudCpu::from_raw(&xyz, &rgb, &it, &cls, [0.0; 3]).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c.rgb.as_deref(), Some(&[1, 2, 3, 7, 8, 9][..]));
        assert_eq!(c.intensity.as_deref(), Some(&[10, 30][..]));
        assert_eq!(c.classification.as_deref(), Some(&[2, 9][..]));
    }

    #[test]
    fn broken_input_yields_none_not_panic() {
        assert!(PointCloudCpu::from_raw(&[], &[], &[], &[], [0.0; 3]).is_none());
        assert!(PointCloudCpu::from_raw(&[1.0, 2.0], &[], &[], &[], [0.0; 3]).is_none());
        assert!(PointCloudCpu::from_raw(&[1.0, 2.0, 3.0], &[], &[], &[], [f64::NAN, 0.0, 0.0]).is_none());
        assert!(PointCloudCpu::from_raw(&[f32::INFINITY, 0.0, 0.0], &[], &[], &[], [0.0; 3]).is_none());
        // Überzählige xyz-Werte (kein ganzer Punkt) werden ignoriert.
        let c = PointCloudCpu::from_raw(&[1.0, 2.0, 3.0, 4.0], &[], &[], &[], [0.0; 3]).unwrap();
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn attributes_with_wrong_length_are_ignored() {
        let c = PointCloudCpu::from_raw(&[0.0; 6], &[1, 2, 3], &[5], &[1, 2, 3], [0.0; 3]).unwrap();
        assert!(c.rgb.is_none() && c.intensity.is_none() && c.classification.is_none());
        // Ohne Attribut fällt jeder Modus auf Höhe zurück.
        assert_eq!(c.effective_mode(PointColorMode::Rgb), PointColorMode::Height);
        assert_eq!(c.effective_mode(PointColorMode::Class), PointColorMode::Height);
        assert_eq!(c.colors(PointColorMode::Intensity).len(), 2);
    }

    #[test]
    fn rgb_colors_pass_through() {
        let c = PointCloudCpu::from_raw(&[0.0; 6], &[255, 0, 0, 0, 128, 255], &[], &[], [0.0; 3]).unwrap();
        assert_eq!(c.colors(PointColorMode::Rgb), vec![[255, 0, 0, 255], [0, 128, 255, 255]]);
    }

    #[test]
    fn class_colors_follow_asprs() {
        let c = PointCloudCpu::from_raw(&[0.0; 9], &[], &[], &[2, 6, 200], [0.0; 3]).unwrap();
        let col = c.colors(PointColorMode::Class);
        assert_eq!(col[0], [166, 120, 72, 255]); // Boden
        assert_eq!(col[1], [214, 90, 70, 255]); // Gebäude
        assert_eq!(col[2], [140, 140, 140, 255]); // unbekannt
    }

    #[test]
    fn height_ramp_runs_from_blue_to_red_by_world_height() {
        // Modell-z 0 / 5 / 10 → world y; tiefster Punkt blau, höchster rot.
        let xyz = [0.0, 0.0, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 10.0];
        let c = PointCloudCpu::from_raw(&xyz, &[], &[], &[], [0.0; 3]).unwrap();
        let col = c.colors(PointColorMode::Height);
        assert_eq!(&col[0][..3], &height_ramp(0.0)[..]);
        assert_eq!(&col[2][..3], &height_ramp(1.0)[..]);
        assert_eq!(height_ramp(0.0), [40, 70, 200]);
        assert_eq!(height_ramp(1.0), [220, 60, 40]);
        assert_eq!(height_ramp(f32::NAN), [40, 70, 200]);
        assert_eq!(height_ramp(7.0), [220, 60, 40]);
    }

    #[test]
    fn intensity_uses_robust_window() {
        // 1000 Punkte 100..1099 plus ein Ausreisser 65535: der Ausreisser setzt den Bereich NICHT.
        let mut it: Vec<u16> = (100..1100).collect();
        it.push(65_535);
        let w = intensity_window(&it);
        assert!(w[0] >= 100 && w[0] < 120, "{w:?}");
        assert!(w[1] > 1000 && w[1] < 1100, "{w:?}");
        let xyz = vec![0.0f32; it.len() * 3];
        let c = PointCloudCpu::from_raw(&xyz, &[], &it, &[], [0.0; 3]).unwrap();
        let col = c.colors(PointColorMode::Intensity);
        assert_eq!(col[0], [30, 30, 30, 255]); // dunkelstes Ende (nie schwarz)
        assert_eq!(col[col.len() - 1], [255, 255, 255, 255]); // Ausreisser geklemmt
        assert_eq!(intensity_window(&[]), [0, 65_535]);
        assert_eq!(intensity_window(&[7, 7, 7]), [7, 7]);
    }

    #[test]
    fn chunking_splits_large_clouds() {
        assert!(chunk_ranges(0).is_empty());
        assert_eq!(chunk_ranges(10), vec![(0, 10)]);
        let r = chunk_ranges(MAX_POINTS_PER_CHUNK * 2 + 5);
        assert_eq!(r.len(), 3);
        assert_eq!(r[2], (MAX_POINTS_PER_CHUNK * 2, 5));
    }

    #[test]
    fn point_size_is_clamped() {
        assert_eq!(clamp_point_size(0.0), MIN_POINT_SIZE_PX);
        assert_eq!(clamp_point_size(100.0), MAX_POINT_SIZE_PX);
        assert_eq!(clamp_point_size(f32::NAN), 2.0);
        assert_eq!(clamp_point_size(3.5), 3.5);
    }

    #[test]
    fn point_wgsl_validates() {
        use naga::valid::{Capabilities, ValidationFlags, Validator};
        let module = naga::front::wgsl::parse_str(POINT_WGSL)
            .unwrap_or_else(|e| panic!("points: WGSL-Parse-Fehler: {e:?}"));
        Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&module)
            .unwrap_or_else(|e| panic!("points: WGSL-Validierung fehlgeschlagen: {e:?}"));
    }

    #[test]
    fn quad_corners_match_shader() {
        // Die Ecken im WGSL müssen dieselben sein wie die Rust-Konstante (zwei CCW-Dreiecke).
        for c in QUAD_CORNERS {
            let s = format!("vec2<f32>({:.1}, {:.1})", c[0], c[1]);
            assert!(POINT_WGSL.contains(&s), "fehlt im Shader: {s}");
        }
    }
}
