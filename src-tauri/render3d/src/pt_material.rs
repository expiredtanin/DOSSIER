// [212] Materialtabelle des Pathtracers (Etappe 2): Rauigkeit, Metall und Glas je Baustoff statt nur aus der Vertexfarbe.
//
// Transport: die Szene trägt je Netz schon die Material-Ebene der Bildkarten (`WallInput::material_index`,
// `MeshInput::material_index`, je Vertex in `ChunkData::layers`; 1-basiert, Reihenfolge `wallMaterialColorMaps` der
// TS-Seite). Die Tabelle hier ordnet jeder Ebene einen Look zu; der Baum (`bvh.rs`) schreibt Art, Rauigkeit und Metall
// aufgelöst ins Dreieck (`GpuTri`), das Format der Szene bleibt unverändert. Eingabe: kleine JSON-Liste
// `[{ "name": "Beton", "map": "/assets/materials/Concrete048/color.jpg" }, …]` (Index i = Ebene i + 1), im Viewer über
// `web::set_pathtrace_materials`, headless als `ptMaterials` im Modell-JSON (`dossier-cli model3d`).
//
// Looks nach Schlüsselwörtern im Baustoffnamen und Bildkarten-Pfad, angelehnt an den Blender-Leser [211]
// (`scripts/blender/render_dossier.py`, `ROOF_LOOKS`/`BUILDING_LOOKS`): Farbe nur, wenn das Bauteil keine eigene hat
// (Vertexfarbe weiss = nicht gesetzt). Hat der Viewer die Bildkarten dekodiert (`set_material_textures`), gilt deren
// mittlere Farbe vor der Tabellenfarbe.
//
// Etappe 3: Bildkarten im Pathtracer. Die Tabelle sagt je Dreieck, ob es eine Bildkarte liest (Ebene ≥ 1 mit geladener
// Karte, `tex_for`), mit welcher Kachelgrösse (`size` je Eintrag = `ComponentMaterial.sizeM`, Standard 1 m) und welche
// prozedurale Ersatz-Textur gilt, wenn keine Karte da ist (Wiese, Kies, Asphalt: `PROC_*`). Gelände ohne Material
// (`TERRAIN_LAYER`, gesetzt von `mesh::mesh_layer`) bekommt die Wiese wie im Blender-Leser [211]. Baustoffe mit
// „Leuchte“/„Lampe“ im Namen leuchten (`MAT_EMISSIVE`, warmes Licht; sichtbar vor allem bei Nacht).
//
// Etappe 4: Normalen- und Rauigkeitskarten je Eintrag (`normal`, `rough`; Detail-Ebene `pt_texture.rs`). Eine Ebene
// mit geladener Detail-Karte bekommt die glänzende Schicht auch bei hoher Rauigkeit (die Karte gibt der Fläche erst
// ihr Glanzbild; Rauigkeit je Texel = Tabelle · Karte / Kartenmittel), `PtTex::detail` sagt dem Shader, ob er die
// Detail-Ebene liest. Ein Eintrag mit `terrain: true` (die Wiese `Grass005`, von `pathtraceMaterials` angehängt) ist
// die Bildkarte des Geländes ohne Material: ist sie geladen, ersetzt sie die prozedurale Wiese.

use serde::Deserialize;

/// Material-Art je Dreieck (Bits 24..32 von `GpuTri::mat`).
pub const MAT_DIFFUSE: u32 = 0;
/// Glänzend: Grundfarbe unter einer GGX-Schicht mit Rauigkeit `GpuTri::rough`; `GpuTri::metal` mischt zum Metall
/// (F0 = Grundfarbe, kein diffuser Anteil).
pub const MAT_GLOSSY: u32 = 1;
/// Glas: dünne Scheibe (Fresnel-Spiegelung, sonst gerader Durchgang mit leichter Tönung).
pub const MAT_GLASS: u32 = 2;
/// Leuchte: strahlt ihre Grundfarbe ab (Shader `EMISSION` · Farbe), reflektiert nichts.
pub const MAT_EMISSIVE: u32 = 3;

/// Prozedurale Textur (Bits 16..24 von `GpuTriTex::tex`), wenn keine Bildkarte geladen ist.
pub const PROC_NONE: u32 = 0;
pub const PROC_GRASS: u32 = 1;
pub const PROC_GRAVEL: u32 = 2;
pub const PROC_ASPHALT: u32 = 3;

/// Material-Ebene des Geländes ohne eigenes Material und ohne Luftbild-Farben (`mesh::mesh_layer`): Wiese.
pub const TERRAIN_LAYER: i32 = -2;
/// Wiesengrün (sRGB) wie der Blender-Leser [211] (`GRASS_SRGB`).
pub const GRASS_SRGB: [f32; 3] = [0.33, 0.45, 0.18];

/// Unter dieser Rauigkeit bekommt ein dielektrischer Baustoff die glänzende Schicht (sonst rein diffus).
const GLOSSY_BELOW: f32 = 0.75;

/// Aufgelöstes Material eines Dreiecks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PtMaterial {
    pub kind: u32,
    pub rough: f32,
    pub metal: f32,
    /// Grundfarbe sRGB 0..1, wenn das Bauteil keine eigene hat (Vertexfarbe weiss).
    pub color: Option<[f32; 3]>,
    /// Prozedurale Textur ohne Bildkarte (`PROC_*`).
    pub proc: u32,
}

impl PtMaterial {
    pub const DIFFUSE: PtMaterial = PtMaterial { kind: MAT_DIFFUSE, rough: 1.0, metal: 0.0, color: None, proc: PROC_NONE };
    /// Wiese (Gelände ohne Material).
    pub const GRASS: PtMaterial = PtMaterial { kind: MAT_DIFFUSE, rough: 0.95, metal: 0.0, color: Some(GRASS_SRGB), proc: PROC_GRASS };
    const GLASS: PtMaterial = PtMaterial { kind: MAT_GLASS, rough: 0.0, metal: 0.0, color: None, proc: PROC_NONE };

    fn look(color: Option<[f32; 3]>, rough: f32, metal: f32, proc: u32) -> Self {
        let kind = if metal > 0.5 || rough < GLOSSY_BELOW { MAT_GLOSSY } else { MAT_DIFFUSE };
        PtMaterial { kind, rough, metal, color, proc }
    }
}

/// Warmweiss einer Leuchte ohne eigene Farbe (sRGB, ≈ 3000 K).
const LAMP_SRGB: [f32; 3] = [1.0, 0.85, 0.62];

/// (Schlüsselwörter, Farbe sRGB oder None = Bauteilfarbe, Rauigkeit, Metall). Reihenfolge zählt: spezielle Wörter
/// zuerst („Stahlbeton“ ist Beton, „Tonziegel“/Dachziegel sind Dachziegel, „Ziegel“ allein Backstein).
type Look = (&'static [&'static str], Option<[f32; 3]>, f32, f32, u32);
const LOOKS: &[Look] = &[
    (&["roofingtiles", "tonziegel", "dachziegel", "biber", "dachstein"], Some([0.56, 0.25, 0.16]), 0.7, 0.0, PROC_NONE),
    (&["schindel"], Some([0.40, 0.28, 0.18]), 0.85, 0.0, PROC_NONE),
    (&["faserzement", "eternit", "schiefer"], Some([0.22, 0.23, 0.25]), 0.8, 0.0, PROC_NONE),
    (&["beton", "concrete", "estrich"], Some([0.52, 0.52, 0.50]), 0.85, 0.0, PROC_NONE),
    (&["blech", "zink", "titan", "kupfer", "alu", "stehfalz", "stahl", "metal"], Some([0.55, 0.57, 0.58]), 0.35, 1.0, PROC_NONE),
    (&["kies", "gravel"], Some([0.46, 0.44, 0.41]), 0.95, 0.0, PROC_GRAVEL),
    (&["asphalt", "teer", "bitumenbelag"], Some([0.20, 0.20, 0.21]), 0.9, 0.0, PROC_ASPHALT),
    (&["wiese", "rasen", "begr", "substrat", "gras"], Some([0.30, 0.42, 0.18]), 0.95, 0.0, PROC_GRASS),
    (&["bitumen", "abdicht", "sperrschicht", "folie"], Some([0.10, 0.10, 0.10]), 0.7, 0.0, PROC_NONE),
    (&["backstein", "ziegel", "klinker", "brick"], Some([0.60, 0.31, 0.22]), 0.8, 0.0, PROC_NONE),
    (&["holz", "parkett", "lattung", "schalung", "brettsperr", "bsp", "wood"], Some([0.56, 0.40, 0.24]), 0.65, 0.0, PROC_NONE),
    (&["naturstein", "marmor", "granit", "marble"], Some([0.62, 0.60, 0.57]), 0.5, 0.0, PROC_NONE),
    (&["keramik", "fliese", "tiles"], Some([0.75, 0.74, 0.72]), 0.3, 0.0, PROC_NONE),
    (&["erdreich", "ground"], Some([0.40, 0.33, 0.25]), 0.95, 0.0, PROC_NONE),
    (&["putz", "gips", "plaster"], None, 0.9, 0.0, PROC_NONE),
];

/// Look eines Baustoffs aus Name und Bildkarten-Pfad (klein geschrieben durchsucht). Glas über „glas“/„glass“.
pub fn look_for(name: &str, map: &str) -> Option<PtMaterial> {
    let text = format!("{} {}", name, map).to_lowercase();
    if ["leuchte", "lampe", "leuchtmittel"].iter().any(|w| text.contains(w)) {
        return Some(PtMaterial { kind: MAT_EMISSIVE, rough: 1.0, metal: 0.0, color: Some(LAMP_SRGB), proc: PROC_NONE });
    }
    if text.contains("glas") {
        return Some(PtMaterial::GLASS);
    }
    LOOKS.iter().find(|(words, ..)| words.iter().any(|w| text.contains(w))).map(|&(_, c, r, m, p)| PtMaterial::look(c, r, m, p))
}

/// Eintrag der Eingabe-Liste (JSON `{ name, map }`; Index i = Material-Ebene i + 1).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct PtMaterialEntry {
    /// Baustoff-Name (`Component.name`).
    #[serde(default)]
    pub name: String,
    /// Pfad der Farbkarte (ambientCG-Ordnername verrät den Stoff).
    #[serde(default)]
    pub map: String,
    /// Kantenlänge einer Bildkarten-Kachel in Metern (`ComponentMaterial.sizeM`; fehlt = 1 m).
    #[serde(default)]
    pub size: Option<f32>,
    /// Normalenkarte (OpenGL, `ComponentMaterial.normal`; Etappe 4), leer = keine.
    #[serde(default)]
    pub normal: String,
    /// Rauigkeitskarte (`ComponentMaterial.roughness`), leer = keine.
    #[serde(default)]
    pub rough: String,
    /// Bildkarte des Geländes ohne eigenes Material (Wiese, s. Moduldoc).
    #[serde(default)]
    pub terrain: bool,
}

/// Tabelle Material-Ebene (1-basiert) → Look.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PtMaterialTable {
    looks: Vec<Option<PtMaterial>>,
    /// Kachelgrösse je Ebene (m).
    sizes: Vec<f32>,
    /// Mittlere Farbe der Bildkarte je Ebene (sRGB), aus `set_material_textures`.
    means: Vec<Option<[f32; 3]>>,
    /// Detail-Karte (Normale/Rauigkeit) geladen je Ebene (Etappe 4, `set_detail`).
    detail: Vec<bool>,
    /// Mittlere Rauigkeit der Rauigkeitskarte je Ebene.
    rough_means: Vec<Option<f32>>,
    /// Eintrag (0-basiert) der Gelände-Bildkarte.
    terrain: Option<usize>,
}

/// Texturzugriff eines Dreiecks (s. `PtMaterialTable::tex_for`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PtTex {
    /// Ebene im Textur-Array (≥ 1), 0 = keine Bildkarte.
    pub layer: u32,
    /// Prozedurale Textur ohne Bildkarte (`PROC_*`).
    pub proc: u32,
    /// UV-Massstab (1 / Kachelgrösse in m).
    pub scale: f32,
    /// Detail-Ebene (Normale/Rauigkeit) lesen (Etappe 4).
    pub detail: bool,
}

impl PtTex {
    pub const NONE: PtTex = PtTex { layer: 0, proc: PROC_NONE, scale: 1.0, detail: false };
}

impl PtMaterialTable {
    /// Aus der Eingabe-Liste (s. Moduldoc; JSON-Lesen beim Aufrufer: `web.rs`, `render_png`).
    pub fn from_entries(entries: &[PtMaterialEntry]) -> Self {
        let mut t = Self::from_names(entries.iter().map(|e| (e.name.as_str(), e.map.as_str())));
        t.sizes = entries.iter().map(|e| e.size.filter(|s| s.is_finite() && *s >= 0.01 && *s <= 1000.0).unwrap_or(1.0)).collect();
        t.terrain = entries.iter().position(|e| e.terrain);
        t
    }

    pub fn from_names<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        PtMaterialTable { looks: entries.into_iter().map(|(n, m)| look_for(n, m)).collect(), ..Default::default() }
    }

    /// Übernimmt die mittleren Bildkarten-Farben und Detail-Angaben einer anderen Tabelle (neue Namen, gleiche Bilder).
    pub fn with_means_of(mut self, other: PtMaterialTable) -> Self {
        self.means = other.means;
        self.detail = other.detail;
        self.rough_means = other.rough_means;
        self
    }

    /// Detail-Karten je Ebene (Etappe 4): geladen ja/nein und mittlere Rauigkeit (aus `pt_texture::pack_detail`).
    pub fn set_detail(&mut self, layers: &[crate::pt_texture::DetailLayer]) {
        self.detail = layers.iter().map(|d| d.present).collect();
        self.rough_means = layers.iter().map(|d| d.rough_mean).collect();
    }

    /// Material-Ebene der Gelände-Bildkarte, wenn sie geladen ist (sonst bleibt die prozedurale Wiese).
    pub fn terrain_layer(&self) -> Option<i32> {
        let i = self.terrain?;
        self.means.get(i).copied().flatten().map(|_| i as i32 + 1)
    }

    pub fn is_empty(&self) -> bool {
        self.looks.is_empty() && self.means.is_empty()
    }

    /// Mittlere Farben der Bildkarten (dicht gepackte RGBA8-Ebenen wie `Renderer::set_material_textures`).
    pub fn set_texture_means(&mut self, rgba: &[u8], bytes_per_layer: usize, layer_count: usize) {
        self.means = texture_means(rgba, bytes_per_layer, layer_count);
    }

    /// Material für ein Dreieck: Ebene (≥ 1 = Bildkarte, sonst keine) und Vertexfarbe. Ohne Eintrag: aus der Farbe
    /// (`classify_color`).
    pub fn resolve(&self, layer: i32, color: [f32; 3]) -> (PtMaterial, [f32; 3]) {
        let base = classify_color(color);
        if layer == TERRAIN_LAYER {
            // Wiese: mit geladener Bildkarte deren Ebene (Look der Wiese, Farbe = Kartenmittel), sonst prozedural.
            return match self.terrain_layer() {
                // Grundfarbe bleibt das Wiesengrün (die Karte gibt die Struktur: Texel / Kartenmittel), damit die Wiese mit
                // und ohne Bildkarten gleich satt wirkt.
                Some(l) => {
                    let (m, _) = self.resolve(l, crate::types::MeshKind::Terrain.default_color());
                    let m = if self.looks.get(l as usize - 1).copied().flatten().is_some() { m } else { PtMaterial { color: None, ..PtMaterial::GRASS } };
                    (m, GRASS_SRGB)
                }
                None => (PtMaterial::GRASS, GRASS_SRGB),
            };
        }
        if layer < 1 {
            return (base, color);
        }
        let i = (layer - 1) as usize;
        let look = self.looks.get(i).copied().flatten();
        let mean = self.means.get(i).copied().flatten();
        let mut m = match look {
            Some(l) => l,
            None if mean.is_some() => PtMaterial { color: None, ..base },
            None => return (base, color),
        };
        if base.kind == MAT_GLASS {
            m = base;
        }
        // Detail-Karte geladen: glänzende Schicht auch bei hoher Rauigkeit (Rauigkeit je Texel aus der Karte).
        if m.kind == MAT_DIFFUSE && self.detail.get(i).copied().unwrap_or(false) {
            m.kind = MAT_GLOSSY;
        }
        // Ungesetzt: weiss (Bauteil ohne Farbe) oder die Grundfarbe des Geländes (Kern `TERRAIN_RGB`), damit Gelände mit
        // Material dessen Farbe bekommt.
        let terrain = crate::types::MeshKind::Terrain.default_color();
        let unset = color.iter().all(|c| *c >= 0.999) || (0..3).all(|k| (color[k] - terrain[k]).abs() < 2e-3);
        let c = if unset { mean.or(m.color).unwrap_or(color) } else { color };
        (m, c)
    }

    /// Texturzugriff für ein Dreieck mit Ebene `layer` und aufgelöstem Material `m` (aus `resolve`): Bildkarte, wenn
    /// die Ebene eine geladene Karte hat (mittlere Farbe bekannt), sonst die prozedurale Textur des Looks. Glas und
    /// Leuchten ohne Textur.
    pub fn tex_for(&self, layer: i32, m: &PtMaterial) -> PtTex {
        if m.kind == MAT_GLASS || m.kind == MAT_EMISSIVE {
            return PtTex::NONE;
        }
        let layer = if layer == TERRAIN_LAYER { self.terrain_layer().unwrap_or(layer) } else { layer };
        if layer >= 1 {
            let i = (layer - 1) as usize;
            let scale = 1.0 / self.sizes.get(i).copied().unwrap_or(1.0);
            if self.means.get(i).copied().flatten().is_some() {
                let detail = self.detail.get(i).copied().unwrap_or(false);
                // Wiese mit Bildkarte: dazu die grossen Flecken der prozeduralen Wiese (die Karte kachelt alle paar Meter).
                let proc = if m.proc == PROC_GRASS { PROC_GRASS } else { PROC_NONE };
                return PtTex { layer: layer as u32, proc, scale, detail };
            }
            return PtTex { layer: 0, proc: m.proc, scale, detail: false };
        }
        PtTex { layer: 0, proc: m.proc, scale: 1.0, detail: false }
    }

    /// Kehrwert der mittleren Bildkarten-Farbe je Textur-Ebene (linear; Index = Ebene, 0 und fehlende = 1). Der Shader
    /// rechnet Albedo = Grundfarbe · Texel / Mittel: ungesetzte Bauteile (Grundfarbe = Mittel) zeigen die Karte, gesetzte
    /// Farben behalten ihren Ton und bekommen die Struktur der Karte. `w` = Kehrwert der mittleren Rauigkeit der
    /// Rauigkeitskarte (Etappe 4; Rauigkeit je Texel = Tabelle · Karte / Mittel), ohne Karte 1.
    pub fn inv_means(&self) -> Vec<[f32; 4]> {
        let n = self.means.len().max(self.rough_means.len());
        std::iter::once([1.0; 4])
            .chain((0..n).map(|i| {
                let w = self.rough_means.get(i).copied().flatten().map_or(1.0, |r| 1.0 / r.max(0.02));
                match self.means.get(i).copied().flatten() {
                    Some(c) => {
                        let l = c.map(|v| srgb_to_linear(v).max(0.02));
                        [1.0 / l[0], 1.0 / l[1], 1.0 / l[2], w]
                    }
                    None => [1.0, 1.0, 1.0, w],
                }
            }))
            .collect()
    }
}

/// Mittlere Farbe je Ebene (in linearem Licht gemittelt, zurück nach sRGB); None bei zu kurzem Puffer oder einer
/// fast leeren Ebene (Bild nicht geladen = schwarz).
pub fn texture_means(rgba: &[u8], bytes_per_layer: usize, layer_count: usize) -> Vec<Option<[f32; 3]>> {
    if bytes_per_layer < 4 || rgba.len() < bytes_per_layer.saturating_mul(layer_count) {
        return Vec::new();
    }
    let lut: Vec<f32> = (0..256).map(|v| srgb_to_linear(v as f32 / 255.0)).collect();
    (0..layer_count)
        .map(|l| {
            let px = &rgba[l * bytes_per_layer..(l + 1) * bytes_per_layer];
            let mut s = [0.0f64; 3];
            let mut n = 0usize;
            for p in px.chunks_exact(4) {
                for k in 0..3 {
                    s[k] += lut[p[k] as usize] as f64;
                }
                n += 1;
            }
            let m = s.map(|v| (v / n.max(1) as f64) as f32);
            (m.iter().sum::<f32>() > 1e-3).then(|| m.map(linear_to_srgb))
        })
        .collect()
}

/// Glasfarbe der Öffnungen (Kern `model3d/openings.rs`, `PART_RGB[0]`).
pub use crate::shadow::GLASS_RGB;
/// Stahlrahmen der Öffnungen (Kern `model3d/openings.rs`, `PART_RGB[4]`): glänzend (beschichtet).
pub const STEEL_RGB: [f32; 3] = [0.25, 0.27, 0.3];

/// Material nur aus der Vertexfarbe (Etappe 1): Glas über die Kern-Farbe der Verglasung (wie `shadow::caster_indices`),
/// Stahlrahmen glänzend, alles andere diffus.
pub fn classify_color(color: [f32; 3]) -> PtMaterial {
    let near = |c: [f32; 3]| (0..3).all(|k| (color[k] - c[k]).abs() < 1e-3);
    if near(GLASS_RGB) {
        PtMaterial::GLASS
    } else if near(STEEL_RGB) {
        PtMaterial { kind: MAT_GLOSSY, rough: 0.3, metal: 0.0, color: None, proc: PROC_NONE }
    } else {
        PtMaterial::DIFFUSE
    }
}

/// sRGB-Wert (0..1) nach linear.
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear nach sRGB (0..1).
pub fn linear_to_srgb(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl PtMaterialTable {
        fn from_json(json: &str) -> Self {
            Self::from_entries(&serde_json::from_str::<Vec<PtMaterialEntry>>(json).unwrap_or_default())
        }
    }

    #[test]
    fn looks_nach_baustoff_und_bildkarte() {
        let l = |n: &str, m: &str| look_for(n, m).expect(n);
        // Metall: glänzend, metallisch.
        let blech = l("Trapezblech", "");
        assert_eq!((blech.kind, blech.metal), (MAT_GLOSSY, 1.0));
        assert_eq!(l("Stahl", "/assets/materials/Metal063/color.jpg").metal, 1.0);
        // Stahlbeton ist Beton (nicht Metall), Zementestrich auch.
        let sb = l("Stahlbeton", "/assets/materials/Concrete048/color.jpg");
        assert_eq!((sb.kind, sb.metal), (MAT_DIFFUSE, 0.0));
        assert_eq!(l("Zementestrich", ""), sb);
        // Dachziegel vor Backstein; Bildkarte allein reicht.
        assert_eq!(l("Tonziegel", "").color, Some([0.56, 0.25, 0.16]));
        assert_eq!(l("Dach", "/assets/materials/RoofingTiles013A/color.jpg").color, Some([0.56, 0.25, 0.16]));
        assert_eq!(l("Ziegelmauerwerk", "").color, Some([0.60, 0.31, 0.22]));
        assert_eq!(l("Faserzementplatten", "").color, Some([0.22, 0.23, 0.25]));
        // Holz glänzt leicht, Putz bleibt weiss und matt, Keramik glänzt.
        assert_eq!(l("Brettsperrholz", "").kind, MAT_GLOSSY);
        let putz = l("Aussenputz", "/assets/materials/Plaster001/color.jpg");
        assert_eq!((putz.kind, putz.color), (MAT_DIFFUSE, None));
        assert!(l("Keramikplatten", "").rough < 0.5);
        assert_eq!(l("Glas", "").kind, MAT_GLASS);
        assert!(look_for("Mineralwolle", "").is_none());
    }

    #[test]
    fn tabelle_loest_ebene_und_farbe_auf() {
        let t = PtMaterialTable::from_json(r#"[{"name":"Beton","map":"/a/Concrete048/color.jpg"},{"name":"Trapezblech"},{"name":"Unbekannt"}]"#);
        let white = [1.0, 1.0, 1.0];
        // Ebene 1: Beton, Farbe aus der Tabelle (Bauteil weiss = ungesetzt).
        let (m, c) = t.resolve(1, white);
        assert_eq!(m.kind, MAT_DIFFUSE);
        assert_eq!(c, [0.52, 0.52, 0.50]);
        // Gesetzte Bauteilfarbe bleibt.
        assert_eq!(t.resolve(1, [0.3, 0.2, 0.1]).1, [0.3, 0.2, 0.1]);
        // Ebene 2: Metall.
        assert_eq!(t.resolve(2, white).0.metal, 1.0);
        // Unbekannt / ausserhalb / ohne Ebene: aus der Vertexfarbe.
        assert_eq!(t.resolve(3, white), (PtMaterial::DIFFUSE, white));
        assert_eq!(t.resolve(9, white), (PtMaterial::DIFFUSE, white));
        assert_eq!(t.resolve(-1, GLASS_RGB).0.kind, MAT_GLASS);
        assert_eq!(t.resolve(0, STEEL_RGB).0.kind, MAT_GLOSSY);
        // Glasfarbe schlägt die Ebene.
        assert_eq!(t.resolve(1, GLASS_RGB).0.kind, MAT_GLASS);
        // Kaputtes JSON: leer, kein Panic.
        assert!(PtMaterialTable::from_json("{kaputt").is_empty());
        assert!(PtMaterialTable::from_json("[1,2]").is_empty());
    }

    #[test]
    fn mittlere_texturfarbe_vor_tabellenfarbe() {
        let mut t = PtMaterialTable::from_json(r#"[{"name":"Backstein"},{"name":"Mineralwolle"}]"#);
        // Zwei Ebenen à 2 Pixel: rot / schwarz (nicht geladen).
        let rgba = [200u8, 40, 30, 255, 200, 40, 30, 255, 0, 0, 0, 255, 0, 0, 0, 255];
        t.set_texture_means(&rgba, 8, 2);
        let (m, c) = t.resolve(1, [1.0; 3]);
        assert_eq!(m.color, Some([0.60, 0.31, 0.22]));
        assert!((c[0] - 200.0 / 255.0).abs() < 1e-3 && (c[1] - 40.0 / 255.0).abs() < 1e-3, "{c:?}");
        // Ebene 2: kein Look, schwarzes Bild = kein Mittelwert → Vertexfarbe.
        assert_eq!(t.resolve(2, [1.0; 3]).1, [1.0; 3]);
        // Zu kurzer Puffer: keine Mittelwerte.
        assert!(texture_means(&rgba, 8, 3).is_empty());
        assert!(texture_means(&rgba, 0, 1).is_empty());
        // Gemischt in linearem Licht: schwarz/weiss → mittleres Grau ≈ 0.735 sRGB (nicht 0.5).
        let m = texture_means(&[0, 0, 0, 255, 255, 255, 255, 255], 8, 1)[0].unwrap();
        assert!((m[0] - 0.735).abs() < 0.01, "{m:?}");
    }

    /// [212] Etappe 3: Bildkarte nur mit geladener Karte (Kachelgrösse aus der Tabelle), sonst prozedurale Textur des
    /// Looks; Gelände ohne Material = Wiese; Asphalt, Leuchten; Kehrwert der Kartenmittel je Ebene.
    #[test]
    fn texturzugriff_gelaende_und_leuchte() {
        let mut t = PtMaterialTable::from_json(
            r#"[{"name":"Backstein","map":"/a/Bricks104/color.jpg","size":0.5},{"name":"Kies"},{"name":"Asphaltbelag"},{"name":"Deckenleuchte"},{"name":"Wiese","size":-3}]"#,
        );
        let white = [1.0; 3];
        // Ohne geladene Karten: keine Bildkarte; Kies und Asphalt prozedural, Backstein ohne.
        let tex = |t: &PtMaterialTable, l: i32| t.tex_for(l, &t.resolve(l, white).0);
        assert_eq!(tex(&t, 1), PtTex { layer: 0, proc: PROC_NONE, scale: 2.0, detail: false });
        assert_eq!(tex(&t, 2).proc, PROC_GRAVEL);
        assert_eq!(tex(&t, 3).proc, PROC_ASPHALT);
        assert_eq!(t.resolve(3, white).1, [0.20, 0.20, 0.21]);
        // Kachelgrösse ungültig (≤ 0) → 1 m.
        assert_eq!(tex(&t, 5), PtTex { layer: 0, proc: PROC_GRASS, scale: 1.0, detail: false });
        // Leuchte: strahlt, ohne Textur.
        let (lamp, c) = t.resolve(4, white);
        assert_eq!(lamp.kind, MAT_EMISSIVE);
        assert!(c[0] > c[2], "warmweiss");
        assert_eq!(t.tex_for(4, &lamp), PtTex::NONE);
        // Karten geladen (Ebene 1 und 2 nicht schwarz): Bildkarte statt Prozedur, Massstab bleibt.
        let px = |c: u8| [c, c, c, 255].repeat(4);
        let rgba = [px(180), px(120), px(0), px(0), px(0)].concat();
        t.set_texture_means(&rgba, 16, 5);
        assert_eq!(tex(&t, 1), PtTex { layer: 1, proc: PROC_NONE, scale: 2.0, detail: false });
        assert_eq!(tex(&t, 2), PtTex { layer: 2, proc: PROC_NONE, scale: 1.0, detail: false });
        assert_eq!(tex(&t, 3).layer, 0, "schwarze Ebene = nicht geladen");
        // Gelände mit Material (Grundfarbe des Geländes gilt als ungesetzt): Farbe des Looks.
        assert_eq!(t.resolve(3, crate::types::MeshKind::Terrain.default_color()).1, [0.20, 0.20, 0.21]);
        // Kehrwert der Mittel: Ebene 0 und ungeladene = 1, sonst 1 / linear.
        let inv = t.inv_means();
        assert_eq!(inv.len(), 6);
        assert_eq!(inv[0], [1.0; 4]);
        assert!((inv[1][0] - 1.0 / srgb_to_linear(180.0 / 255.0)).abs() < 1e-3, "{:?}", inv[1]);
        assert_eq!(inv[3], [1.0; 4]);
        // Gelände ohne Material: Wiese, auch ohne Tabelle; Glas bleibt Glas.
        let empty = PtMaterialTable::default();
        let (g, gc) = empty.resolve(TERRAIN_LAYER, [0.66, 0.69, 0.64]);
        assert_eq!((g.kind, g.proc, gc), (MAT_DIFFUSE, PROC_GRASS, GRASS_SRGB));
        assert_eq!(empty.tex_for(TERRAIN_LAYER, &g).proc, PROC_GRASS);
        assert_eq!(empty.tex_for(-1, &empty.resolve(-1, GLASS_RGB).0), PtTex::NONE);
        // Wiese/Kies/Asphalt nach Bildkarten-Ordner wie der Blender-Leser.
        assert_eq!(look_for("", "/assets/materials/Grass005/color.jpg").unwrap().proc, PROC_GRASS);
        assert_eq!(look_for("", "/assets/materials/Gravel043/color.jpg").unwrap().proc, PROC_GRAVEL);
        assert_eq!(look_for("Bitumenbahn", "").unwrap().proc, PROC_NONE, "Abdichtung ist kein Asphalt");
    }
    /// [212] Etappe 4: Detail-Karten machen die Ebene glänzend und lassen den Shader die Detail-Ebene lesen; mittlere
    /// Rauigkeit als Kehrwert in `inv_means().w`; die Gelände-Bildkarte ersetzt die prozedurale Wiese, sobald sie geladen
    /// ist.
    #[test]
    fn detailkarten_und_gelaende_bildkarte() {
        let mut t = PtMaterialTable::from_json(
            r#"[{"name":"Beton","map":"/a/Concrete048/color.jpg","normal":"/a/Concrete048/normal.jpg","rough":"/a/Concrete048/roughness.jpg"},
                {"name":"Putz","map":"/a/Plaster001/color.jpg"},
                {"name":"Wiese","map":"/a/Grass005/color.jpg","size":4,"terrain":true}]"#,
        );
        let white = [1.0; 3];
        let terrain = crate::types::MeshKind::Terrain.default_color();
        // Ohne geladene Karten: Gelände prozedural, Beton diffus.
        assert_eq!(t.terrain_layer(), None);
        assert_eq!(t.resolve(TERRAIN_LAYER, terrain), (PtMaterial::GRASS, GRASS_SRGB));
        assert_eq!(t.tex_for(TERRAIN_LAYER, &PtMaterial::GRASS).proc, PROC_GRASS);
        assert_eq!(t.resolve(1, white).0.kind, MAT_DIFFUSE);
        // Farbkarten geladen (Wiese grün), Detail nur für Beton (Rauigkeit im Mittel 0.5).
        let px = |c: [u8; 3]| [c[0], c[1], c[2], 255].repeat(4);
        t.set_texture_means(&[px([128, 128, 128]), px([230, 230, 225]), px([60, 110, 30])].concat(), 16, 3);
        let none = crate::pt_texture::DetailLayer { rgba: Vec::new(), present: false, rough_mean: None };
        let beton = crate::pt_texture::DetailLayer { rgba: Vec::new(), present: true, rough_mean: Some(0.5) };
        t.set_detail(&[beton, none.clone(), none]);
        let (m, _) = t.resolve(1, white);
        assert_eq!((m.kind, m.rough), (MAT_GLOSSY, 0.85), "Detail-Karte: glänzend, Rauigkeit der Tabelle als Mittel");
        assert!(t.tex_for(1, &m).detail);
        assert!(!t.tex_for(2, &t.resolve(2, white).0).detail);
        let inv = t.inv_means();
        assert_eq!((inv[1][3], inv[2][3]), (2.0, 1.0));
        // Gelände ohne Material: Bildkarte der Wiese (Ebene 3, Kachel 4 m).
        assert_eq!(t.terrain_layer(), Some(3));
        let (g, c) = t.resolve(TERRAIN_LAYER, terrain);
        assert_eq!(g.proc, PROC_GRASS);
        assert_eq!(c, GRASS_SRGB, "Wiesengrün, Struktur aus der Karte");
        let tx = t.tex_for(TERRAIN_LAYER, &g);
        assert_eq!((tx.layer, tx.proc, tx.scale), (3, PROC_GRASS, 0.25), "Karte + grosse Flecken");
        // Bildkarten-Tabelle mit neuen Namen behält Mittel und Detail.
        let u = PtMaterialTable::from_json(r#"[{"name":"Beton"},{"name":"Putz"},{"name":"Wiese","terrain":true}]"#).with_means_of(t);
        assert!(u.tex_for(1, &u.resolve(1, white).0).detail);
        assert_eq!(u.terrain_layer(), Some(3));
    }
}
