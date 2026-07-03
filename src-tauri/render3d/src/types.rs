// Eingabe- und Ausgabe-Typen des nativen 3D-Renderers. Die Eingabe ist eine
// geflachte Beschreibung der Modellsicht (Waende), wie sie aus dem Web-Modell
// (`src/model/wall.ts`) heruebergereicht wird — reduziert auf das, was die
// Extrusion braucht: Achse (Start/Ende), Dicke, Hoehe, Basis-Hoehe.
//
// Die Typen sind serde-only und bewusst frei von GPU-Abhaengigkeiten, damit die
// Mesh-Erzeugung eigenstaendig (headless) getestet werden kann (Muster: render2d).
//
// KOORDINATEN-KONVENTION (identisch zur three.js-Sicht in src/viewport/Viewport3D.tsx):
//   Modell ist 2D in Metern (x nach rechts, y nach "oben" im Grundriss).
//   In der 3D-Welt gilt Y-up:  world.x = model.x,  world.z = model.y,  world.y = Hoehe.
//   D.h. der Grundriss liegt in der XZ-Ebene, die Extrusion laeuft entlang +Y.

use serde::{Deserialize, Serialize};

/// Ein 2D-Punkt in MODELL-Metern (Grundriss). Wird bei der Extrusion nach
/// world (XZ-Ebene) abgebildet: `[x, y] -> world (x, elevation, y)`.
pub type Point2 = [f32; 2];

/// RGB-Farbe/Albedo, Komponenten in [0,1]. Alpha wird (noch) nicht gebraucht.
pub type Rgb = [f32; 3];

/// Eine geflachte Wand: Achse (Mittellinie) Start->Ende im Grundriss, plus Dicke,
/// Hoehe und Basis-Hoehe. Aus diesen Feldern wird ein extrudiertes Quader-Mesh
/// erzeugt (Band aus Achse+Dicke, hochgezogen auf `height` ab `base_elevation`).
///
/// Vereinfachung des Web-`Wall` (siehe src/model/wall.ts): Ecken-Verschneidung
/// (Gehrung an echten Wandenden, analog `computeJoins`/`wallCorners` im Web)
/// wird von `mesh.rs` SELBSTAENDIG aus der Wandkonnektivitaet berechnet (siehe
/// `mesh::compute_wall_miters`) — keine eigenen Eingabefelder noetig, robust
/// auch gegenueber der hier bereits in Teilquader zerlegten Darstellung (siehe
/// `openings` unten). Das Schnitt-Modul (`section.rs`) nutzt weiterhin die
/// (unveraenderte) achsparallele Bounding-Box-Naeherung ohne Gehrung — siehe
/// dessen Moduldoc "Bekannte Vereinfachungen".
/// `openings` (Tueren/Fenster, siehe `Opening`) werden vom Schnitt-Modul
/// (`section.rs`) UND von der Vollkoerper-Extrusion (`mesh.rs`) ausgewertet
/// (siehe `mesh::wall_solid_segments`) — beide nutzen dieselbe Bruestungs-/
/// Sturz-Zerlegung (`crate::openings`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WallInput {
    /// Achsen-Startpunkt im Grundriss (Modell-Meter).
    pub start: Point2,
    /// Achsen-Endpunkt im Grundriss (Modell-Meter).
    pub end: Point2,
    /// Wanddicke in Metern (das Band wird um `thickness/2` je Seite versetzt).
    /// Bleibt auch bei gesetztem `layers` die GESAMT-Dicke (Summe der
    /// Schichtdicken) — `section.rs`/`web::model_bounds` rechnen weiterhin
    /// allein mit diesem Feld, kennen `layers` nicht.
    pub thickness: f32,
    /// Wandhoehe in Metern (Extrusion entlang +Y).
    pub height: f32,
    /// Basis-Hoehe (Unterkante) in Metern. Default 0 (Geschossboden).
    #[serde(default, rename = "baseElevation")]
    pub base_elevation: f32,
    /// Albedo-Farbe der Wand (RGB 0..1). Default helles Grau wie die three.js-Sicht.
    /// Nur wirksam, wenn `layers` fehlt/leer ist (Vollkoerper-Fallback).
    #[serde(default = "default_wall_color")]
    pub color: Rgb,
    /// Oeffnungen (Tueren/Fenster) entlang der Wandachse. Default leer (volle Wand).
    #[serde(default)]
    pub openings: Vec<Opening>,
    /// Optionaler Schichtaufbau (z. B. Putz/Daemmung/Mauerwerk), quer zur
    /// Gesamtdicke gestapelt (siehe `mesh::extrude_wall`). Fehlt dieses Feld
    /// (`None`) oder ist es leer, extrudiert `mesh.rs` weiterhin EINEN
    /// Vollkoerper aus `thickness`/`color` (Rueckwaertskompatibilitaet, M1-
    /// Verhalten unveraendert).
    #[serde(default)]
    pub layers: Option<Vec<WallLayer>>,
}

/// Eine Wandschicht: Dicke + eigene Albedo-Farbe. Siehe `WallInput::layers`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WallLayer {
    /// Schichtdicke in Metern.
    pub thickness: f32,
    /// Albedo-Farbe dieser Schicht (RGB 0..1).
    pub color: Rgb,
}

/// Eine Oeffnung (Tuer/Fenster) in einer Wand: Intervall entlang der Wandachse
/// (Meter ab `WallInput::start`, 0..Wandlaenge) plus vertikale Ausdehnung relativ
/// zur Wand-Unterkante (`base_elevation`).
///
/// Vereinfachung des Web-`Opening` (siehe src/model/types.ts): keine eigene Id,
/// kein Oeffnungstyp (Tuer/Fenster) — nur die reine Geometrie, die Schnitt/Ansicht
/// brauchen. Eine Tuer ist der Sonderfall `sill == 0.0` (keine Bruestungsmauer).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Opening {
    /// Start des Oeffnungs-Intervalls entlang der Wandachse (Meter ab `start`).
    pub from: f32,
    /// Ende des Oeffnungs-Intervalls entlang der Wandachse (Meter ab `start`).
    pub to: f32,
    /// Bruestungshoehe: Unterkante der Oeffnung relativ zu `base_elevation`
    /// (Meter). 0 = Tuer (keine Bruestungsmauer darunter).
    #[serde(default)]
    pub sill: f32,
    /// Hoehe der Oeffnung (vertikale Ausdehnung ab `sill`), Meter.
    pub height: f32,
}

fn default_wall_color() -> Rgb {
    [0.82, 0.80, 0.76]
}

/// Eine geflachte Deckenplatte (Slab): ein GESCHLOSSENER Grundriss-Umriss (Polygon
/// in Modell-Metern, Schlusspunkt NICHT dupliziert) plus die absolute vertikale
/// Ausdehnung `z_bottom..z_top`. Aus diesen Feldern wird das Polygon trianguliert
/// (Ear-Clipping) und ueber die Dicke zu einer Platte extrudiert.
///
/// KOORDINATEN wie WallInput: model `[x, y]` -> world `(x, elevation, y)`, d. h. der
/// Umriss liegt in der XZ-Ebene, die Extrusion laeuft entlang +Y.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlabInput {
    /// Geschlossener Umriss im Grundriss (Modell-Meter), CW oder CCW zulaessig.
    pub outline: Vec<Point2>,
    /// Unterkante (absolut, Meter).
    #[serde(rename = "zBottom")]
    pub z_bottom: f32,
    /// Oberkante (absolut, Meter).
    #[serde(rename = "zTop")]
    pub z_top: f32,
    /// Albedo-Farbe (RGB 0..1). Default heller Deckenton.
    #[serde(default = "default_slab_color")]
    pub color: Rgb,
}

fn default_slab_color() -> Rgb {
    [0.86, 0.86, 0.88]
}

/// Projektionsart der Kamera. Die three.js-Sicht schaltet zwischen perspektivisch
/// (freies Orbit) und orthografisch (die achsparallelen Presets front/top/side um).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Projection {
    Perspective,
    Orthographic,
}

impl Default for Projection {
    fn default() -> Self {
        Projection::Perspective
    }
}

/// Kamera-Parameter (Blickrichtung + Projektion). `eye`/`target`/`up` in world.
/// Fuer die Orbit-Kamera werden `eye`/`target` aus Orbit-Winkeln+Distanz berechnet
/// (siehe `math::orbit_eye`), koennen hier aber auch direkt gesetzt werden.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Camera {
    /// Kamera-Position (world).
    pub eye: [f32; 3],
    /// Blickziel (world).
    pub target: [f32; 3],
    /// Up-Vektor (world). Fuer Y-up: [0,1,0].
    pub up: [f32; 3],
    /// Projektionsart.
    #[serde(default)]
    pub projection: Projection,
    /// Vertikaler Oeffnungswinkel in Radiant (nur perspektivisch).
    #[serde(default = "default_fov")]
    pub fov_y: f32,
    /// Halbe Hoehe des Sichtvolumens in world-Metern (nur orthografisch).
    #[serde(default = "default_ortho_half_height")]
    pub ortho_half_height: f32,
    /// Nah-/Fern-Ebene.
    #[serde(default = "default_near")]
    pub near: f32,
    #[serde(default = "default_far")]
    pub far: f32,
}

// `pub(crate)`, damit `web::set_view_preset` denselben Voreinstellungswert
// fuers formatfuellende Fit nutzen kann (kein zweiter FOV-Wert zum Pflegen).
pub(crate) fn default_fov() -> f32 {
    // 50 Grad, wie die three.js-PerspectiveCamera-Voreinstellung.
    50.0_f32.to_radians()
}
fn default_ortho_half_height() -> f32 {
    6.0
}
fn default_near() -> f32 {
    0.05
}
fn default_far() -> f32 {
    1000.0
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            eye: [8.0, 8.0, 8.0],
            target: [0.0, 0.0, 0.0],
            up: [0.0, 1.0, 0.0],
            projection: Projection::Perspective,
            fov_y: default_fov(),
            ortho_half_height: default_ortho_half_height(),
            near: default_near(),
            far: default_far(),
        }
    }
}

/// Die fuenf Kamera-Presets der three.js-Sicht. `Iso` und `Persp` sind
/// perspektivisch/frei; `Front`/`Top`/`Side` sind achsparallel (orthografisch).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CameraPreset {
    Front,
    Top,
    Side,
    Iso,
    Persp,
}

/// Ausgabe der Mesh-Erzeugung: interleaved [pos.xyz, normal.xyz, color.rgb] je
/// Vertex plus Indexpuffer. Bewusst GPU-frei (nur Vecs); die GPU-Schicht laedt
/// diese direkt in Vertex-/Index-Buffer hoch.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Mesh {
    /// Interleaved Vertices: je 9 f32 = [px,py,pz, nx,ny,nz, r,g,b].
    pub verts: Vec<f32>,
    /// Dreiecks-Indizes (0-basiert auf die Vertices).
    pub indices: Vec<u32>,
}

/// Anzahl f32 je Vertex im interleaved Puffer: 3 Position + 3 Normale + 3 Farbe.
pub const FLOATS_PER_VERTEX: usize = 9;

impl Mesh {
    /// Anzahl Vertices im Puffer.
    pub fn vertex_count(&self) -> usize {
        self.verts.len() / FLOATS_PER_VERTEX
    }

    /// Anzahl Dreiecke.
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Achsparallele Bounding-Box ueber alle Positionen: (min.xyz, max.xyz).
    /// Fuer leere Meshes: beide Ecken im Ursprung.
    pub fn bounds(&self) -> ([f32; 3], [f32; 3]) {
        if self.verts.is_empty() {
            return ([0.0; 3], [0.0; 3]);
        }
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        let n = self.vertex_count();
        for i in 0..n {
            let base = i * FLOATS_PER_VERTEX;
            for k in 0..3 {
                let v = self.verts[base + k];
                if v < min[k] {
                    min[k] = v;
                }
                if v > max[k] {
                    max[k] = v;
                }
            }
        }
        (min, max)
    }
}
