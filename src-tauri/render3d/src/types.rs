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

/// Schnitt-Schraffur eines Bauteils (fuer den 3D-Live-Schnitt). Rust-seitiges
/// Minimal-Aequivalent zu `HatchStyle` (src/model/types.ts): nur die drei Felder,
/// die der prozedurale Cap-Shader (`shaders::CAP_WGSL`) auswertet — Muster-Id,
/// Winkel und Skalierung. Die Muster-Farbe bleibt MONOCHROM (Tinte auf Papier,
/// siehe 2D-Direktive `HATCH_INK`) und wandert deshalb bewusst NICHT mit.
///
/// `pattern`: 0 = none (leer/weiss), 1 = solid (Vollton), 2 = diagonal (45°),
/// 3 = crosshatch (Kreuz), 4 = insulation (Zickzack/Daemmung). Die Zuordnung ist
/// mit der TS-Seite (`toWalls3d::hatchPatternId`) und dem Shader synchron zu halten.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Hatch {
    /// Muster-Id (siehe oben). Default 0 (none).
    #[serde(default)]
    pub pattern: u32,
    /// Musterdrehung in Grad (Bildschirm-/Schnittebenen-Konvention). Default 0.
    #[serde(default)]
    pub angle: f32,
    /// Grundmassstab (1 = Standardteilung). Default 1.
    #[serde(default = "default_hatch_scale")]
    pub scale: f32,
    /// Strichstaerke der Musterlinien in mm-Papier (aus dem LineStyle des Hatch,
    /// `HatchRender.lineWeight`). Der Cap-Shader (`CAP_WGSL`) setzt die Muster-
    /// linienbreite daraus (mm->Welt wie die Trennlinien), sodass die Schraffur-
    /// Staerke pro Schraffur einstellbar ist (z. B. SIA `hatch-hair` 0.02 mm vs.
    /// `thin` 0.13 mm). Default 0.13 (Alt-Verhalten/Haarlinie).
    #[serde(default = "default_hatch_line_weight", rename = "lineWeight")]
    pub line_weight: f32,
}

fn default_hatch_scale() -> f32 {
    1.0
}

fn default_hatch_line_weight() -> f32 {
    0.13
}

/// Verschneidungs-/Stil-Metadaten EINES geschnittenen Bauteil-Bandes fuer den
/// 3D-Live-Schnitt — das Rust-Gegenstueck zu den Feldern, mit denen `toSection.ts`
/// die Schnitt-Boolean-Dominanz (`subtractDominantBands`) rechnet. Rein additiv
/// (`#[serde(default)]` an jedem Feld); fehlt der ganze Block (`WallInput::cut ==
/// None`), verhaelt sich der Schnitt wie zuvor (Band nimmt an keiner Subtraktion
/// teil).
///
/// Da der 3D-Viewer-Pfad je Materiallage EINE eigene `WallInput`/`SlabInput`-Box
/// emittiert (`toWalls3d`, layered), traegt jede geschnittene Schicht hier IHRE
/// eigene Prioritaet/Identitaet/Linienstil — die Dominanz-Verschneidung
/// (`section_boolean.rs`) laeuft dann elementuebergreifend auf den erzeugten
/// (u,v)-Rechtecken, exakt wie im 2D-Schnitt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutBandMeta {
    /// `Component.joinPriority` der Schicht: ein Band mit STRIKT hoeherer
    /// Prioritaet schneidet ein ueberlappendes schwaecheres per Rechteck-
    /// Subtraktion weg (elementuebergreifend). `None` -> keine Teilnahme.
    #[serde(default)]
    pub join_priority: Option<i32>,
    /// `Component.id` der Schicht — steuert die MERGE-Regel (gleiche Komponente +
    /// Prioritaet verschmelzen zu einem Koerper, keine innere Trennlinie). `None`
    /// -> keine Verschmelzung.
    #[serde(default)]
    pub component_id: Option<String>,
    /// Farbe (RGB 0..1) der Schnitt-Umrisslinie dieses Bandes (P2, aus dem
    /// `jointLineStyleId`-LineStyle). `None` -> Default-Schnittkanten-Stil.
    #[serde(default)]
    pub line_color: Option<Rgb>,
    /// Strichstaerke der Schnitt-Umrisslinie in mm-Papier (aus dem LineStyle).
    /// `None` -> Default. Siehe `section_fill::build_cut_cap_lines` fuer die (ehrlich
    /// dokumentierte) mm->Welt-Umsetzung.
    #[serde(default)]
    pub line_weight: Option<f32>,
}

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
    /// Rechteckige LOECHER (Fenster/Tueren) als ECHTE Aussparungen in EINEM
    /// Wandkoerper (siehe `Hole` + `mesh::extrude_wall*`). Default leer.
    ///
    /// Anders als `openings` zerlegt das die Wand NICHT in Pfeiler/Bruestung/
    /// Sturz-Teilquader, sondern stanzt die Loecher in die beiden Langseiten
    /// (Rechteck-Gitter-Zerlegung + Laibungsflaechen). So bildet EIN Koerper
    /// beliebig (auch versetzt uebereinander) angeordnete Oeffnungen ab — das
    /// kann die Segment-Zerlegung nicht. Genutzt vom 3D-Viewer-Pfad der
    /// TS-Ableitung (`toWalls3d`, `layeredWalls:true`); der Schnitt-Pfad
    /// (`layeredWalls:false`) bleibt bei `openings`/Segmentierung.
    ///
    /// `holes` und `openings` schliessen sich im TS-Emitter gegenseitig aus; ist
    /// `holes` gesetzt, ueberspringt `mesh.rs` die Oeffnungs-Segmentierung und
    /// extrudiert den vollen Achsen-Abschnitt mit Loechern.
    #[serde(default)]
    pub holes: Vec<Hole>,
    /// Optionaler Material-Textur-Index fuer den Stil `Textured`: verweist auf eine
    /// per `Renderer::set_material_textures` hochgeladene Material-Farbkarte
    /// (Textur-Array-Ebene, 1-basiert; Ebene 0 ist das Fallback-Schachbrett). Da
    /// der 3D-Viewer-Pfad je Materiallage EINE eigene `WallInput`-Box emittiert
    /// (`toWalls3d`, `layeredWalls:true`), traegt jede Schicht so IHRE Material-
    /// Textur. `None` -> Fallback-Schachbrett (bisheriges Verhalten). Vom
    /// Schnitt/Serde-Pfad (`section.rs`) ignoriert.
    #[serde(default, rename = "materialIndex")]
    pub material_index: Option<u32>,
    /// Optionale Schnitt-Schraffur dieses Wand-Bandes (siehe `Hatch`). Nur der
    /// 3D-Live-Schnitt (`section.rs`/`section_fill.rs`) wertet sie aus, um die
    /// Schnittflaeche im MUSTER des Bauteils zu schraffieren (statt eines fixen
    /// 45°-Musters). `None` -> Fallback-Diagonalmuster (Alt-Verhalten). Da der
    /// 3D-Viewer-Pfad je Materiallage EINE eigene `WallInput`-Box emittiert
    /// (`toWalls3d`, `layeredWalls:true`), traegt jede geschnittene Schicht so
    /// ihre eigene Schraffur.
    #[serde(default)]
    pub hatch: Option<Hatch>,
    /// Schnitt-Verschneidungs-/Linienstil-Metadaten dieses Wand-Bandes (siehe
    /// `CutBandMeta`). Nur der 3D-Live-Schnitt (`section_fill`/`section_boolean`)
    /// wertet sie aus; fehlt sie, bleibt das Alt-Verhalten (keine Dominanz-
    /// Subtraktion, Default-Schnittkante).
    #[serde(default)]
    pub cut: Option<CutBandMeta>,
}

/// Ein rechteckiges Loch (Fenster/Tuer) in EINEM Wandkoerper. Siehe
/// `WallInput::holes`.
///
/// KONVENTION: `from`/`to` sind Achsen-Meter ab `WallInput::start` (0..Wandlaenge,
/// dieselbe Achse wie `Opening::from`/`to`); `z_bottom`/`z_top` sind ABSOLUTE
/// Weltmeter (NICHT relativ zu `base_elevation` — anders als `Opening::sill`).
/// Eine Tuer ist der Sonderfall `z_bottom == base_elevation` (Loch bis zur
/// Wand-Unterkante). Loecher liegen definitionsgemaess im Wand-INNEREN und
/// beruehren die gemiterten Enden nicht — die Gehrung (`compute_wall_miters`)
/// bleibt davon unberuehrt (siehe `mesh`-Moduldoc).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct Hole {
    /// Start des Loch-Intervalls entlang der Wandachse (Meter ab `start`).
    pub from: f32,
    /// Ende des Loch-Intervalls entlang der Wandachse (Meter ab `start`).
    pub to: f32,
    /// Absolute Unterkante des Lochs (Weltmeter).
    #[serde(default, rename = "zBottom")]
    pub z_bottom: f32,
    /// Absolute Oberkante des Lochs (Weltmeter).
    #[serde(default, rename = "zTop")]
    pub z_top: f32,
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
    /// Optionale Schnitt-Schraffur der Decke (siehe `Hatch`/`WallInput::hatch`).
    #[serde(default)]
    pub hatch: Option<Hatch>,
    /// Schnitt-Verschneidungs-/Linienstil-Metadaten dieser Decken-Schicht (siehe
    /// `CutBandMeta`/`WallInput::cut`).
    #[serde(default)]
    pub cut: Option<CutBandMeta>,
    /// Gruppe eines aus mehreren Prismen zusammengesetzten, MONOLITHISCHEN
    /// Bauteils (z. B. die Tritt-Prismen EINER massiven/Beton-Treppe). Im
    /// Schnitt/in der Ansicht verdecken sich Prismen derselben Gruppe auch bei
    /// GLEICHER Tiefe gegenseitig — die inneren Nähte zwischen den Tritten
    /// verschwinden, sichtbar bleibt der Umriss (Sägezahn). `None` = Einzelteil.
    #[serde(default)]
    pub monolith: Option<String>,
}

/// EINE Dachflächen-Schicht für den 3D-Live-Schnitt (`crate::roof_cut`).
///
/// Anders als `WallInput`/`SlabInput` ist das KEIN vertikales Prisma (2D-
/// Grundriss extrudiert über `[z0,z1]`) — eine Dachfläche ist ein GENEIGTES
/// Polygon, extrudiert entlang ihrer EIGENEN Flächennormalen (nicht vertikal).
/// `section.rs`s gesamter Ansatz ("jedes Bauteil ist ein vertikales Prisma,
/// daher ist der Schnitt mit einer vertikalen Ebene immer ein Rechteck")
/// funktioniert für ein geneigtes Bauteil nicht — daher ein eigener,
/// paralleler Pfad (`roof_cut::cut_roof_layer`) statt Wiederverwendung von
/// `Prism`. Das Ergebnis landet trotzdem im selben `CutPolygon`-Format
/// (`section::CutPolygon`, `component.kind = ComponentKind::Roof`) und läuft
/// durch dieselbe Cap-/Linien-Pipeline (`section_fill.rs`) wie Wand/Decke.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoofLayerInput {
    /// Eckpunkte der OBERSEITE dieser Schicht (näher am First/aussen), planar,
    /// in MODELL-Metern `(x, y, z=Höhe)` — dieselbe Konvention wie
    /// `MeshInput::positions` (NICHT vorab nach Welt umgerechnet; `roof_cut::
    /// cut_roof_layer` macht den Modell->Welt-Wechsel `(x,y,z)->(x,z,y)`
    /// selbst, wie `mesh.rs` es für Meshes tut). Schlusspunkt NICHT dupliziert.
    pub polygon: Vec<[f32; 3]>,
    /// Nach AUSSEN/OBEN zeigende Flächennormale (normalisiert, MODELL-Meter,
    /// dieselbe `(x,y,z)`-Konvention wie `polygon`) — exakt dieselbe wie
    /// `toWalls3d/roofs.ts::planeNormalUp` (dort TS-seitig berechnet und 1:1
    /// mitgegeben, statt hier erneut hergeleitet — vermeidet ein Konventions-/
    /// Vorzeichen-Auseinanderlaufen zwischen Render-Mesh und Schnitt-Geometrie).
    pub normal: [f32; 3],
    /// Schichtdicke (Meter), Extrusion entlang `-normal` (nach INNEN, wie
    /// `pushRoofSlab`: `bottom = top - normal*thickness`).
    pub thickness: f32,
    /// Albedo-Farbe dieser Schicht.
    pub color: Rgb,
    /// Optionale Schnitt-Schraffur (siehe `WallInput::hatch`).
    #[serde(default)]
    pub hatch: Option<Hatch>,
    /// Schnitt-Verschneidungs-/Linienstil-Metadaten (siehe `WallInput::cut`).
    /// `join_priority`/`component_id` bleiben für Dach-Schichten bewusst
    /// `None` (keine Teilnahme an `section_boolean::subtract_dominant_bands`
    /// — ein nicht-achsparalleles Cut-Polygon als Bounding-Box zu behandeln
    /// wäre falsch; die Dominanz-Subtraktion bleibt Wand/Decke vorbehalten).
    /// `line_color`/`line_weight` (aus `jointLineStyleId`) wirken trotzdem.
    #[serde(default)]
    pub cut: Option<CutBandMeta>,
}

fn default_slab_color() -> Rgb {
    [0.86, 0.86, 0.88]
}

/// Art eines rohen Kontext-Meshes (aus `Project.context`) — bestimmt die
/// Default-Einfaerbung, wenn kein explizites `color` mitkommt. Werte sind
/// serde-kompatibel mit der TS-Seite (lowercase).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MeshKind {
    /// Gelaende-TIN (offene Flaeche) — gedecktes Lehm-/Gelaendegruen-grau.
    Terrain,
    /// Importiertes Volumen (Gebaeude/DXF) — neutrales Hellgrau.
    #[default]
    Imported,
    /// Per truck (Profil-Extrusion, `src-tauri/trucksolid`) erzeugter Koerper —
    /// warmes Orange, damit er sich klar von Wand/Decke/Kontext abhebt.
    Extrusion,
}

impl MeshKind {
    /// Default-Albedo (RGB 0..1), wenn `MeshInput::color` fehlt. Werte 1:1 aus
    /// der three.js-Sicht (`src/viewport/Viewport3D.tsx`, `mats.terrain`/
    /// `mats.mesh`), damit beide Renderer denselben Kontext-Farbton zeigen.
    pub fn default_color(self) -> Rgb {
        match self {
            // 0xa9b0a2 — gedaempftes Lehm-/Gelaendegruen-grau (Clay-Look).
            MeshKind::Terrain => [0.663, 0.690, 0.635],
            // 0x9fa6ae — neutrales Hellgrau fuer importierte Meshes.
            MeshKind::Imported => [0.624, 0.651, 0.682],
            // Warmes Orange fuer truck-Profil-Extrusionen (Phase-1-Viewer-Beweis).
            MeshKind::Extrusion => [0.85, 0.55, 0.25],
        }
    }
}

/// Ein rohes Dreiecks-Mesh aus dem Geo-Kontext (`Project.context`): entweder ein
/// Gelaende-TIN (`TerrainMesh`) oder ein importiertes Volumen (`ImportedMesh`,
/// z. B. extrudierte OSM-Gebaeude/DXF). Anders als `WallInput`/`SlabInput` bringt
/// es die Geometrie bereits FERTIG TRIANGULIERT mit — `mesh.rs` berechnet daraus
/// nur noch die Flaechen-Normalen (Flat Shading, wie Wand/Slab) und speist es in
/// denselben GPU-Pfad ein.
///
/// KOORDINATEN: die TS-Seite (`projectToModel3d`) liefert `positions` im
/// MODELL-System als flaches `[x, y, z, ...]`-Array (z = Hoehe, in Metern);
/// `mesh.rs::append_context_mesh` bildet jeden Vertex nach world ab: model
/// `(x, y, z)` -> world `(x, z, -y)` — die Nord-Achse (Modell-y) wird NEGIERT
/// (anders als bei WallInput/SlabInput, die ueber eine orientierungserhaltende
/// Extrusion entstehen und daher OHNE Vorzeichenwechsel auskommen — reines
/// Achsen-Vertauschen eines allgemeinen xyz-Punktsatzes waere sonst eine
/// Spiegelung, s. `append_context_mesh`-Doc).
///
/// DOPPELSEITIG: Terrain-/Import-Meshes tragen KEIN garantiertes Winding (die
/// three.js-Sicht rendert sie mit `DoubleSide`, siehe `io/geoContext.ts`). Da der
/// Nordstern-Pfad Rueckseiten cullt, emittiert `mesh.rs` jedes Dreieck ZWEIMAL
/// (beide Windings, entgegengesetzte Normale) — so bleibt die Flaeche aus jeder
/// Blickrichtung sichtbar und korrekt beleuchtet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshInput {
    /// Flaches Positions-Array in MODELL-Metern: `[x0,y0,z0, x1,y1,z1, ...]`
    /// (z = Hoehe). Wird von `mesh.rs` nach world (x, z, y) abgebildet.
    pub positions: Vec<f32>,
    /// Dreiecks-Indizes (0-basiert auf die Positions-Vertices, je 3 ein Dreieck).
    pub indices: Vec<u32>,
    /// Art des Meshes (Default-Einfaerbung, siehe `MeshKind`). Default `Imported`.
    #[serde(default)]
    pub kind: MeshKind,
    /// Optionale explizite Albedo-Farbe (RGB 0..1). Fehlt sie, greift die
    /// Default-Farbe je `kind` (siehe `effective_color`).
    #[serde(default)]
    pub color: Option<Rgb>,
    /// Optionaler Material-Textur-Index fuer den Stil `Textured` (1-basiert,
    /// Ebene 0 = Fallback-Schachbrett) — analog `WallInput::material_index`.
    /// Bislang nutzen das nur Daecher (`toWalls3d.ts::emitRoofs`); andere
    /// Kontext-Meshes (Terrain/Import) bleiben ohne (`None` -> Schachbrett).
    #[serde(default, rename = "materialIndex")]
    pub material_index: Option<u32>,
    /// Optionale PRO-VERTEX-Albedo (flaches `[r,g,b, r,g,b, ...]`, 0..1) — ein
    /// Wert je Positions-Vertex. Wird u. a. genutzt, um ein SWISSIMAGE-Luftbild
    /// auf das Gelaende-TIN zu „drapieren" (jeder Vertex traegt den Bildpunkt an
    /// seiner Lage). Ist das Array leer oder zu kurz, greift die Einzelfarbe
    /// (`effective_color`) fuer das ganze Mesh. Die Farben werden im Shaded-Pfad
    /// pro Vertex interpoliert (kein Textur-Sampler noetig).
    #[serde(default, rename = "vertexColors")]
    pub vertex_colors: Vec<f32>,
}

impl MeshInput {
    /// Effektive Albedo-Farbe: explizit gesetzt (`color`) oder Default je `kind`.
    pub fn effective_color(&self) -> Rgb {
        self.color.unwrap_or_else(|| self.kind.default_color())
    }
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
// `pub(crate)`, damit `web::set_camera` denselben Basiswert als Untergrenze fuer
// die modellgroessen-abhaengige Far-Ebene nutzen kann (s. Moduldoc dort).
// War 1000.0 — Nutzer-Report: Teile des Modells (und das Boden-Referenzgitter)
// verschwanden abhaengig von Kamera-Distanz/-Winkel. Grosszuegig angehoben,
// damit im ueblichen Gebrauch (auch grosse/georeferenzierte Situationen) nie
// etwas am Fern-Clipping haengenbleibt; `set_camera` skaliert ohnehin
// zusaetzlich mit der tatsaechlichen Modell-Bounding-Box nach oben.
pub(crate) fn default_far() -> f32 {
    50_000.0
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

/// Die Kamera-Presets der Kardinal-/Iso-Sicht (ROADMAP §11). `Persp` ist frei
/// perspektivisch; alle anderen sind achsparallel bzw. diagonal orthografisch.
/// `Front`/`Back`/`Side`/`Left` sind die vier Kardinalrichtungen (Vorne/Hinten/
/// Rechts/Links im UI, s. `View3d` in TopBar.tsx — keine Himmelsrichtungen, da
/// es noch keinen Nordwinkel gibt); `Iso`/`IsoFrontLeft`/`IsoBackRight`/
/// `IsoBackLeft` sind die vier OBEREN Iso-Oktanten (untere vier bleiben im
/// Hochbau ungenutzt) — `Iso` (vorne-oben-rechts) ist der bestehende Default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CameraPreset {
    Front,
    Back,
    Top,
    Side,
    Left,
    Iso,
    IsoFrontLeft,
    IsoBackRight,
    IsoBackLeft,
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

/// Ausgabe der TEXTURIERTEN Mesh-Erzeugung (`RenderStyle::Textured`): interleaved
/// [pos.xyz, normal.xyz, uv.xy] je Vertex plus Indexpuffer. Ein ZWEITER, additiver
/// Vertex-Pfad neben `Mesh` — der bestehende `[pos, normal, color]`-Pfad (`Mesh`)
/// bleibt dadurch bitgleich unangetastet. Genutzt nur mit den GPU-Features
/// (`render`/`window`); serde-frei (reine GPU-Zwischenform), damit der Default-Bau
/// ohne GPU nichts davon zieht.
#[derive(Debug, Clone, Default)]
pub struct TexturedMesh {
    /// Interleaved Vertices: je 8 f32 = [px,py,pz, nx,ny,nz, u,v].
    pub verts: Vec<f32>,
    /// Dreiecks-Indizes (0-basiert auf die Vertices).
    pub indices: Vec<u32>,
    /// Optionaler PARALLELER Puffer: EIN f32 je Vertex = die Material-Textur-
    /// Ebene (Textur-Array-Index) dieses Vertex, oder `-1` fuer „kein Material"
    /// (Fallback-Schachbrett, Ebene 0). Leer, wenn ohne Material-Zuordnung gebaut
    /// (`textured_from_mesh`) — dann bindet die GPU-Schicht einen konstanten
    /// `-1`-Puffer. Als ZWEITER Vertex-Buffer gehalten (nicht in `verts`
    /// interleaved), damit das bestehende `[pos,normal,uv]`-Layout (und die
    /// Geometrie-Paritaets-Tests) bitgleich bleiben.
    pub layers: Vec<f32>,
}

/// Anzahl f32 je Vertex im texturierten Puffer: 3 Position + 3 Normale + 2 UV.
pub const TEXTURED_FLOATS_PER_VERTEX: usize = 8;

impl TexturedMesh {
    /// Anzahl Vertices im Puffer.
    pub fn vertex_count(&self) -> usize {
        self.verts.len() / TEXTURED_FLOATS_PER_VERTEX
    }
}

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
