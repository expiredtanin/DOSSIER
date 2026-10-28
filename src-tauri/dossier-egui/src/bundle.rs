// Eingabedaten der egui-Oberfläche. Das Modell ist noch TS ([K4]); die App liest deshalb das
// JSON, das `dossier-cli <projekt.obp> bundle` schreibt (src/cli/main.ts, `buildBundle`):
// je Geschoss die render2d-Szene (`planToRenderScene`), das 3D-Modell nur dieses Geschosses
// (`projectToModel3d`) und eine vereinfachte Bauteil-Liste; dazu Kennzahlen und Raumprogramm.
//
// Daneben werden zwei rohe CLI-Ausgaben angenommen (je als ein Pseudo-Geschoss):
//   • `model3d` (Objekt mit `walls`/`slabs`/`meshes`) → nur 3D,
//   • `plan --format json` (render2d-Szene mit `fills`/`lines`/…) → nur Grundriss.

use render3d::types::{MeshInput, SlabInput, WallInput};
use serde::Deserialize;

/// Kennung im Kopf des Ansichtspakets (`format`), s. `buildBundle` in src/cli/main.ts.
pub const BUNDLE_FORMAT: &str = "dossier-bundle";
/// Höchste verstandene Paket-Version.
pub const BUNDLE_VERSION: u32 = 1;

// Felder spiegeln das CLI-Format vollständig, auch wenn die App nicht alle liest.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct Bundle {
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub name: String,
    /// Massstab-Nenner (1:N), mit dem die Szenen erzeugt wurden.
    #[serde(default = "default_scale")]
    pub scale: f32,
    pub levels: Vec<Level>,
    /// Kontext (Gelände, Importe) — keinem Geschoss zugeordnet.
    #[serde(default, rename = "context3d")]
    pub context3d: Option<Model3d>,
    #[serde(default)]
    pub kennzahlen: Option<Kennzahlen>,
    #[serde(default)]
    pub raumprogramm: Option<Raumprogramm>,
}

fn default_scale() -> f32 {
    100.0
}

// Felder spiegeln das CLI-Format vollständig, auch wenn die App nicht alle liest.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct Level {
    pub id: String,
    pub name: String,
    /// Geschoss-Unterkante (m über ±0).
    #[serde(default)]
    pub elevation: f32,
    /// Geschosshöhe (m).
    #[serde(default)]
    pub height: f32,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub scene: render2d::Scene,
    #[serde(default)]
    pub model3d: Model3d,
    #[serde(default)]
    pub elements: Vec<Element>,
}

fn yes() -> bool {
    true
}

/// 3D-Eingabe von render3d (wie `render_png` sie liest).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Model3d {
    #[serde(default)]
    pub walls: Vec<WallInput>,
    #[serde(default)]
    pub slabs: Vec<SlabInput>,
    #[serde(default)]
    pub meshes: Vec<MeshInput>,
}

impl Model3d {
    pub fn is_empty(&self) -> bool {
        self.walls.is_empty() && self.slabs.is_empty() && self.meshes.is_empty()
    }
}

/// Ein anklickbares Bauteil im Grundriss (vereinfachte Form + Eigenschaften).
#[derive(Debug, Clone, Deserialize)]
pub struct Element {
    pub id: String,
    /// wall | door | window | room | column | stair | ceiling | roof
    pub kind: String,
    #[serde(default)]
    pub label: String,
    pub shape: Shape,
    /// Eigenschaften in Anzeige-Reihenfolge (Schlüssel englisch, übersetzt in `i18n`).
    #[serde(default)]
    pub props: Vec<(String, PropValue)>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Shape {
    /// Band entlang einer Achse (Wand, Öffnung, Treppenlauf).
    Segment { a: [f32; 2], b: [f32; 2], width: f32 },
    /// Geschlossenes Polygon (Raum, Decke, Dach).
    Polygon { pts: Vec<[f32; 2]> },
    /// Kreis (Stütze, Näherung).
    Circle { c: [f32; 2], r: f32 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum PropValue {
    Num(f64),
    Text(String),
}

impl PropValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            PropValue::Num(n) => Some(*n),
            PropValue::Text(_) => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Kennzahlen {
    #[serde(default)]
    pub levels: Vec<LevelKennzahlen>,
    #[serde(default)]
    pub gf: f64,
    #[serde(default)]
    pub agf: f64,
    #[serde(default)]
    pub gv: f64,
    #[serde(default)]
    pub footprint: f64,
    #[serde(default)]
    pub az: Option<f64>,
    #[serde(default)]
    pub uez: Option<f64>,
}

// Felder spiegeln das CLI-Format vollständig, auch wenn die App nicht alle liest.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct LevelKennzahlen {
    #[serde(rename = "levelId")]
    pub level_id: String,
    pub name: String,
    pub gf: f64,
    pub agf: f64,
    pub rooms: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Raumprogramm {
    #[serde(default)]
    pub rows: Vec<ProgramRow>,
    #[serde(default)]
    pub extra: Vec<ExtraRoom>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProgramRow {
    pub name: String,
    #[serde(rename = "targetArea")]
    pub target_area: f64,
    #[serde(rename = "targetCount")]
    pub target_count: u32,
    pub count: u32,
    pub area: f64,
    pub status: String,
}

// Felder spiegeln das CLI-Format vollständig, auch wenn die App nicht alle liest.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct ExtraRoom {
    pub id: String,
    pub name: String,
    pub area: f64,
}

/// Achsparallele Hülle in Modell-Metern.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds2 {
    pub min: [f32; 2],
    pub max: [f32; 2],
}

impl Bounds2 {
    pub fn empty() -> Self {
        Self { min: [f32::MAX; 2], max: [f32::MIN; 2] }
    }
    pub fn add(&mut self, p: [f32; 2]) {
        if !(p[0].is_finite() && p[1].is_finite()) {
            return;
        }
        for i in 0..2 {
            self.min[i] = self.min[i].min(p[i]);
            self.max[i] = self.max[i].max(p[i]);
        }
    }
    pub fn is_valid(&self) -> bool {
        self.min[0] <= self.max[0] && self.min[1] <= self.max[1]
    }
}

/// Hülle einer render2d-Szene (alle Primitive; Texte nur über ihren Anker).
pub fn scene_bounds(scene: &render2d::Scene) -> Bounds2 {
    let mut b = Bounds2::empty();
    for f in &scene.fills {
        f.pts.iter().for_each(|p| b.add(*p));
    }
    for o in &scene.outlines {
        o.pts.iter().for_each(|p| b.add(*p));
    }
    for p in &scene.polylines {
        p.pts.iter().for_each(|q| b.add(*q));
    }
    for l in &scene.lines {
        b.add(l.a);
        b.add(l.b);
    }
    for a in &scene.arcs {
        b.add([a.center[0] - a.r, a.center[1] - a.r]);
        b.add([a.center[0] + a.r, a.center[1] + a.r]);
    }
    for t in &scene.texts {
        b.add(t.pos);
    }
    b
}

/// Liest ein Ansichtspaket oder eine der rohen CLI-Ausgaben (s. Modulkopf).
pub fn parse(text: &str) -> Result<Bundle, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("JSON: {e}"))?;
    let obj = v.as_object().ok_or("JSON: kein Objekt")?;
    if obj.get("format").and_then(|f| f.as_str()) == Some(BUNDLE_FORMAT) {
        let b: Bundle = serde_json::from_value(v).map_err(|e| format!("Ansichtspaket: {e}"))?;
        if b.version > BUNDLE_VERSION {
            return Err(format!("Ansichtspaket-Version {} ist neuer als diese App ({BUNDLE_VERSION})", b.version));
        }
        return Ok(b);
    }
    if obj.contains_key("walls") || obj.contains_key("slabs") || obj.contains_key("meshes") {
        let m: Model3d = serde_json::from_value(v).map_err(|e| format!("3D-Modell: {e}"))?;
        return Ok(single_level(Level {
            id: "modell".into(),
            name: "Modell".into(),
            elevation: 0.0,
            height: 0.0,
            visible: true,
            scene: render2d::Scene::default(),
            model3d: m,
            elements: vec![],
        }));
    }
    if obj.contains_key("fills") || obj.contains_key("lines") || obj.contains_key("polylines") {
        let s: render2d::Scene = serde_json::from_value(v).map_err(|e| format!("Plan-Szene: {e}"))?;
        return Ok(single_level(Level {
            id: "plan".into(),
            name: "Plan".into(),
            elevation: 0.0,
            height: 0.0,
            visible: true,
            scene: s,
            model3d: Model3d::default(),
            elements: vec![],
        }));
    }
    Err("unbekanntes JSON (erwartet: dossier-cli … bundle, model3d oder plan --format json)".into())
}

fn single_level(level: Level) -> Bundle {
    Bundle {
        format: BUNDLE_FORMAT.into(),
        version: BUNDLE_VERSION,
        name: String::new(),
        scale: default_scale(),
        levels: vec![level],
        context3d: None,
        kennzahlen: None,
        raumprogramm: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINI: &str = r#"{
      "format": "dossier-bundle", "version": 1, "name": "Mini", "scale": 100,
      "levels": [{
        "id": "eg", "name": "EG", "elevation": 0, "height": 2.6, "visible": true,
        "scene": { "fills": [{ "pts": [[0,0],[4,0],[4,3]], "color": [0,0,0,1], "z": 0 }],
                   "texts": [{ "pos": [1,1], "content": "Wohnen", "sizeMm": 3, "color": [0,0,0,1], "align": "center" }],
                   "images": [], "bounds": { "minX": 0, "minY": 0, "maxX": 4, "maxY": 3 } },
        "model3d": { "walls": [{ "start": [0,0], "end": [4,0], "thickness": 0.3, "height": 2.6 }], "slabs": [], "meshes": [], "roofLayers": [] },
        "elements": [
          { "id": "W1", "kind": "wall", "label": "AW", "shape": { "type": "segment", "a": [0,0], "b": [4,0], "width": 0.3 },
            "props": [["type", "AW"], ["height", 2.6]] },
          { "id": "R1", "kind": "room", "label": "Wohnen", "shape": { "type": "polygon", "pts": [[0,0],[4,0],[4,3],[0,3]] }, "props": [] }
        ]
      }],
      "context3d": null,
      "kennzahlen": { "levels": [{ "levelId": "eg", "name": "EG", "gf": 12, "agf": 10, "rooms": 1 }], "gf": 12, "agf": 10, "gv": 0, "footprint": 12, "az": null, "uez": null },
      "raumprogramm": { "rows": [], "extra": [{ "id": "R1", "name": "Wohnen", "area": 12 }] }
    }"#;

    #[test]
    fn ansichtspaket_wird_gelesen() {
        let b = parse(MINI).unwrap();
        assert_eq!(b.name, "Mini");
        let l = &b.levels[0];
        assert_eq!(l.scene.fills.len(), 1);
        assert_eq!(l.scene.texts[0].content, "Wohnen");
        assert_eq!(l.model3d.walls.len(), 1);
        assert!(matches!(l.elements[0].shape, Shape::Segment { width, .. } if (width - 0.3).abs() < 1e-6));
        assert_eq!(l.elements[0].props[1].1.as_f64(), Some(2.6));
        assert!(matches!(&l.elements[0].props[0].1, PropValue::Text(t) if t == "AW"));
        let k = b.kennzahlen.unwrap();
        assert_eq!(k.levels[0].rooms, 1);
        assert!(k.az.is_none());
        assert_eq!(b.raumprogramm.unwrap().extra.len(), 1);
    }

    #[test]
    fn rohes_3d_modell_und_rohe_szene() {
        let m = parse(r#"{ "walls": [{ "start": [0,0], "end": [1,0], "thickness": 0.2, "height": 2 }] }"#).unwrap();
        assert_eq!(m.levels.len(), 1);
        assert_eq!(m.levels[0].model3d.walls.len(), 1);
        assert!(m.levels[0].scene.fills.is_empty());
        let s = parse(r#"{ "fills": [], "lines": [{ "a": [0,0], "b": [1,1], "color": [0,0,0,1], "widthMm": 0.25 }] }"#).unwrap();
        assert_eq!(s.levels[0].scene.lines.len(), 1);
        assert!(s.levels[0].model3d.is_empty());
    }

    #[test]
    fn unsinn_wird_abgelehnt() {
        assert!(parse("[]").is_err());
        assert!(parse("{").is_err());
        assert!(parse(r#"{ "foo": 1 }"#).is_err());
        assert!(parse(r#"{ "format": "dossier-bundle", "version": 99, "levels": [] }"#).is_err());
    }

    #[test]
    fn huelle_der_szene() {
        let b = parse(MINI).unwrap();
        let h = scene_bounds(&b.levels[0].scene);
        assert_eq!(h.min, [0.0, 0.0]);
        assert_eq!(h.max, [4.0, 3.0]);
        assert!(!Bounds2::empty().is_valid());
    }
}
