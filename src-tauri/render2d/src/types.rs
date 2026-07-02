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
    /// Strichbreite in echten Papier-Millimetern.
    #[serde(rename = "widthMm")]
    pub width_mm: f32,
}

/// Die vollstaendige Szene: alles, was ein Frame zeichnet. Reihenfolge ist
/// signifikant (Z-/Alpha-Ueberlagerung): erst Fuellungen, dann Umrisse, dann
/// offene Polylinien, dann freie Linien — analog zur Draw-Reihenfolge im WebGL-Pfad.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Scene {
    #[serde(default)]
    pub fills: Vec<FillPolygon>,
    #[serde(default)]
    pub outlines: Vec<Outline>,
    #[serde(default)]
    pub polylines: Vec<Polyline>,
    #[serde(default)]
    pub lines: Vec<Line>,
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
