// Eingabe-Typen des nativen 2D-Renderers: geflachte Primitive, wie sie aus dem
// Web-Renderer (`src/plan/generatePlan.ts` -> `Plan.primitives`) heruebergereicht
// werden. Bewusst reduziert auf das, was die GPU zeichnet: gefuellte Polygone und
// Linien. Text/Schraffur bleiben (wie im WebGL-Pfad) Overlay bzw. spaeteres M3.
//
// Die Typen sind serde-only und bewusst frei von GPU-Abhaengigkeiten, damit die
// Tessellierung eigenstaendig (headless) getestet werden kann.

use serde::{Deserialize, Serialize};

/// RGBA-Farbe, Komponenten in [0,1] (deckungsgleich zu `Rgba` im WebGL-Pfad).
pub type Rgba = [f32; 4];

/// Ein 2D-Punkt in MODELL-Metern (nicht Bildschirm-Raum). Die Konvertierung nach
/// Bildschirm-Raum passiert erst in der Tessellierung (`to_screen`).
pub type Point = [f32; 2];

/// Gefuelltes Polygon (Wand-Poche, Raeume, Decken). `pts` in Modell-Metern.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FillPolygon {
    /// Ring-Ecken in Modell-Metern; erste != letzte (Ring wird implizit geschlossen).
    pub pts: Vec<Point>,
    /// Fuellfarbe (RGBA 0..1).
    pub color: Rgba,
    /// Maler-Reihenfolge (kleiner = frueher/unten). Der SVG-Referenzpfad zeichnet
    /// die Primitive strikt in Array-Reihenfolge (Fuellung/Umriss INTERLEAVED) —
    /// ein spaeteres Fuellpolygon (Wand-Poche) deckt z.B. den frueheren Raum-
    /// Umriss ab. `compile_scene` stellt diese Reihenfolge kategorien-uebergreifend
    /// wieder her. Default 0 (Alt-Szenen: bisherige Kategorien-Reihenfolge).
    #[serde(default)]
    pub z: u32,
}

/// Ein Liniensegment mit echter Papier-mm-Breite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Line {
    /// Startpunkt in Modell-Metern.
    pub a: Point,
    /// Endpunkt in Modell-Metern.
    pub b: Point,
    /// Strichfarbe (RGBA 0..1).
    pub color: Rgba,
    /// Strichbreite in ECHTEN Papier-Millimetern (siehe `stroke::mm_to_device_px`).
    #[serde(rename = "widthMm")]
    pub width_mm: f32,
    /// Strichmuster in Papier-mm; None/leer = durchgezogen (siehe `tessellate::split_dash`).
    #[serde(default)]
    pub dash: Option<Vec<f32>>,
    /// Maler-Reihenfolge (kleiner = frueher/unten), siehe `FillPolygon::z`.
    #[serde(default)]
    pub z: u32,
}

/// Ein geschlossenes Polygon als Umriss (nur Kanten, keine Fuellung) — bequemer
/// Weg, den Ring eines `FillPolygon` als Striche zu rendern (wie der WebGL-Pfad
/// die Poche-Umrisse zeichnet).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Outline {
    /// Ring-Ecken in Modell-Metern.
    pub pts: Vec<Point>,
    /// Strichfarbe (RGBA 0..1).
    pub color: Rgba,
    /// Strichbreite in echten Papier-Millimetern.
    #[serde(rename = "widthMm")]
    pub width_mm: f32,
    /// Strichmuster in Papier-mm; None/leer = durchgezogen. Ein gestrichelter
    /// Umriss wird als offene Teilstuecke gezeichnet (kein gehrter Ring-Schluss
    /// ueber die Dash-Luecke hinweg, siehe `tessellate::split_dash`).
    #[serde(default)]
    pub dash: Option<Vec<f32>>,
    /// Maler-Reihenfolge (kleiner = frueher/unten), siehe `FillPolygon::z`.
    #[serde(default)]
    pub z: u32,
}

/// Ein OFFENER Linienzug mit echter Papier-mm-Breite. Anders als `Outline`
/// (geschlossener Ring) und `Line` (Einzelsegment) traegt er >=2 zusammenhaengende
/// Punkte, deren INNERE Ecken korrekt gehrt (mitred) werden — genau das, was die
/// nicht-unterdrueckten Umrisskanten einer Wandecke bzw. eine 2D-Zeichnungs-
/// Polylinie brauchen (sonst Stumpfkappen statt Gehrung).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Polyline {
    /// Zusammenhaengende Punkte in Modell-Metern (offen, nicht geschlossen).
    pub pts: Vec<Point>,
    /// Strichfarbe (RGBA 0..1).
    pub color: Rgba,
    /// Strichbreite in echten Papier-Millimetern — bzw. in BILDSCHIRM-EinheITEN
    /// (viewBox-px), wenn `width_screen` gesetzt ist.
    #[serde(rename = "widthMm")]
    pub width_mm: f32,
    /// true: `width_mm` ist eine Breite in BILDSCHIRM-Einheiten (viewBox-px),
    /// die MIT dem Zoom skaliert — wie die SVG-Schraffur-Muster: deren Strich
    /// (`hatchStrokePx`) ist an die Musterkachel gekoppelt, nicht an Papier-mm.
    /// Der Renderer rechnet dann Geraete-px = Breite * meet-Skala (statt
    /// * mm->px). Default false (echte Papier-mm).
    #[serde(default, rename = "widthScreen")]
    pub width_screen: bool,
    /// Strichmuster in Papier-mm; None/leer = durchgezogen.
    #[serde(default)]
    pub dash: Option<Vec<f32>>,
    /// Maler-Reihenfolge (kleiner = frueher/unten), siehe `FillPolygon::z`.
    #[serde(default)]
    pub z: u32,
}

/// Ein Kreisbogen (kuerzerer Sweep von `from` nach `to` um `center`) in Modell-
/// Metern — MATHEMATISCH EXAKT gerendert: `compile_scene` verdichtet ihn nicht zu
/// Segmenten, sondern zu EINER analytischen Instanz (`tessellate::ArcInstanceData`),
/// die die GPU per SDF-Fragment-Shader (`shaders::ARC_WGSL`) bei JEDER Zoomstufe als
/// echten Kreis zeichnet — kein Vieleck, keine Neu-Tessellierung.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Arc {
    /// Mittelpunkt in Modell-Metern.
    pub center: Point,
    /// Anfangspunkt (auf dem Kreis) in Modell-Metern.
    pub from: Point,
    /// Endpunkt (auf dem Kreis) in Modell-Metern.
    pub to: Point,
    /// Radius in Modell-Metern.
    pub r: f32,
    /// Strichfarbe (RGBA 0..1).
    pub color: Rgba,
    /// Strichbreite in echten Papier-Millimetern.
    #[serde(rename = "widthMm")]
    pub width_mm: f32,
    /// Strichmuster in Papier-mm; None = durchgezogen (siehe `tessellate::split_dash`).
    #[serde(default)]
    pub dash: Option<Vec<f32>>,
}

/// Horizontale Ausrichtung eines Textes relativ zu seinem Anker (deckungsgleich
/// zur Absatz-Ausrichtung des Plan-Text-Primitivs: left/center/right).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// EINE Textzeile mit echter Papier-mm-Schriftgroesse. Der Web-Renderer flacht
/// mehrzeilige Raumstempel (Rich-Text + Zusatzzeilen) zeilenweise auf dieses
/// Format ab; gerendert wird mit ECHTEN TrueType-Glyphen ueber einen GPU-Atlas
/// (glyphon/cosmic-text) — bewusst KEINE Einstrich-Vektorschrift.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Text {
    /// Anker in Modell-Metern: X gemaess `align`, Y = BASELINE der Zeile.
    pub pos: Point,
    /// Zeileninhalt (bereits geflachte Runs, plain).
    pub content: String,
    /// Schriftgroesse in ECHTEN Papier-Millimetern (skaliert mit dem Zoom wie
    /// die Strichbreiten, siehe `ortho::mm_to_device_px`).
    #[serde(rename = "sizeMm")]
    pub size_mm: f32,
    /// Textfarbe (RGBA 0..1).
    pub color: Rgba,
    /// Ausrichtung relativ zu `pos` (Default: left).
    #[serde(default)]
    pub align: TextAlign,
}

/// Die vollstaendige Szene: alles, was ein Frame zeichnet. Reihenfolge ist
/// signifikant (Z-/Alpha-Ueberlagerung): erst Fuellungen, dann Umrisse, dann
/// offene Polylinien, dann Boegen, dann freie Linien — analog zur Draw-Reihenfolge
/// im WebGL-Pfad. Texte liegen zuoberst (eigener Glyphen-Pass nach der Geometrie).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Scene {
    #[serde(default)]
    pub fills: Vec<FillPolygon>,
    #[serde(default)]
    pub outlines: Vec<Outline>,
    #[serde(default)]
    pub polylines: Vec<Polyline>,
    /// Kreisboegen (unvortessellliert, siehe `Arc`); leer in aelteren Szenen
    /// ohne Bogen-Unterstuetzung (`#[serde(default)]`).
    #[serde(default)]
    pub arcs: Vec<Arc>,
    #[serde(default)]
    pub lines: Vec<Line>,
    #[serde(default)]
    pub texts: Vec<Text>,
}

/// Rechteckiger Ausschnitt in BILDSCHIRM-Einheiten (viewBox), analog `ViewBox`
/// im WebGL-Pfad. Getrieben von Pan/Zoom in der Webview.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ViewBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl ViewBox {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }
}
