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
// mittlere Farbe vor der Tabellenfarbe (der Pathtracer liest noch keine Texturen).

use serde::Deserialize;

/// Material-Art je Dreieck (Bits 24..32 von `GpuTri::mat`).
pub const MAT_DIFFUSE: u32 = 0;
/// Glänzend: Grundfarbe unter einer GGX-Schicht mit Rauigkeit `GpuTri::rough`; `GpuTri::metal` mischt zum Metall
/// (F0 = Grundfarbe, kein diffuser Anteil).
pub const MAT_GLOSSY: u32 = 1;
/// Glas: dünne Scheibe (Fresnel-Spiegelung, sonst gerader Durchgang mit leichter Tönung).
pub const MAT_GLASS: u32 = 2;

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
}

impl PtMaterial {
    pub const DIFFUSE: PtMaterial = PtMaterial { kind: MAT_DIFFUSE, rough: 1.0, metal: 0.0, color: None };

    fn look(color: Option<[f32; 3]>, rough: f32, metal: f32) -> Self {
        let kind = if metal > 0.5 || rough < GLOSSY_BELOW { MAT_GLOSSY } else { MAT_DIFFUSE };
        PtMaterial { kind, rough, metal, color }
    }
}

/// (Schlüsselwörter, Farbe sRGB oder None = Bauteilfarbe, Rauigkeit, Metall). Reihenfolge zählt: spezielle Wörter
/// zuerst („Stahlbeton“ ist Beton, „Tonziegel“/Dachziegel sind Dachziegel, „Ziegel“ allein Backstein).
type Look = (&'static [&'static str], Option<[f32; 3]>, f32, f32);
const LOOKS: &[Look] = &[
    (&["roofingtiles", "tonziegel", "dachziegel", "biber", "dachstein"], Some([0.56, 0.25, 0.16]), 0.7, 0.0),
    (&["schindel"], Some([0.40, 0.28, 0.18]), 0.85, 0.0),
    (&["faserzement", "eternit", "schiefer"], Some([0.22, 0.23, 0.25]), 0.8, 0.0),
    (&["beton", "concrete", "estrich"], Some([0.52, 0.52, 0.50]), 0.85, 0.0),
    (&["blech", "zink", "titan", "kupfer", "alu", "stehfalz", "stahl", "metal"], Some([0.55, 0.57, 0.58]), 0.35, 1.0),
    (&["kies", "gravel"], Some([0.46, 0.44, 0.41]), 0.95, 0.0),
    (&["begr", "substrat", "gras"], Some([0.30, 0.42, 0.18]), 0.95, 0.0),
    (&["bitumen", "abdicht", "sperrschicht", "folie"], Some([0.10, 0.10, 0.10]), 0.7, 0.0),
    (&["backstein", "ziegel", "klinker", "brick"], Some([0.60, 0.31, 0.22]), 0.8, 0.0),
    (&["holz", "parkett", "lattung", "schalung", "brettsperr", "bsp", "wood"], Some([0.56, 0.40, 0.24]), 0.65, 0.0),
    (&["naturstein", "marmor", "granit", "marble"], Some([0.62, 0.60, 0.57]), 0.5, 0.0),
    (&["keramik", "fliese", "tiles"], Some([0.75, 0.74, 0.72]), 0.3, 0.0),
    (&["erdreich", "ground"], Some([0.40, 0.33, 0.25]), 0.95, 0.0),
    (&["putz", "gips", "plaster"], None, 0.9, 0.0),
];

/// Look eines Baustoffs aus Name und Bildkarten-Pfad (klein geschrieben durchsucht). Glas über „glas“/„glass“.
pub fn look_for(name: &str, map: &str) -> Option<PtMaterial> {
    let text = format!("{} {}", name, map).to_lowercase();
    if text.contains("glas") {
        return Some(PtMaterial { kind: MAT_GLASS, rough: 0.0, metal: 0.0, color: None });
    }
    LOOKS.iter().find(|(words, ..)| words.iter().any(|w| text.contains(w))).map(|&(_, c, r, m)| PtMaterial::look(c, r, m))
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
}

/// Tabelle Material-Ebene (1-basiert) → Look.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PtMaterialTable {
    looks: Vec<Option<PtMaterial>>,
    /// Mittlere Farbe der Bildkarte je Ebene (sRGB), aus `set_material_textures`.
    means: Vec<Option<[f32; 3]>>,
}

impl PtMaterialTable {
    /// Aus der Eingabe-Liste (s. Moduldoc; JSON-Lesen beim Aufrufer: `web.rs`, `render_png`).
    pub fn from_entries(entries: &[PtMaterialEntry]) -> Self {
        Self::from_names(entries.iter().map(|e| (e.name.as_str(), e.map.as_str())))
    }

    pub fn from_names<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        PtMaterialTable { looks: entries.into_iter().map(|(n, m)| look_for(n, m)).collect(), means: Vec::new() }
    }

    /// Übernimmt die mittleren Bildkarten-Farben einer anderen Tabelle (neue Namen, gleiche Bilder).
    pub fn with_means_of(mut self, other: PtMaterialTable) -> Self {
        self.means = other.means;
        self
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
        let unset = color.iter().all(|c| *c >= 0.999);
        let c = if unset { mean.or(m.color).unwrap_or(color) } else { color };
        (m, c)
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
        PtMaterial { kind: MAT_GLASS, rough: 0.0, metal: 0.0, color: None }
    } else if near(STEEL_RGB) {
        PtMaterial { kind: MAT_GLOSSY, rough: 0.3, metal: 0.0, color: None }
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
}
