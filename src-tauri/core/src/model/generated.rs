// Projektmodell ([K4] S2/S4): QUELLE der Datentypen. Einmal (28.10.) aus den damaligen TS-Typen
// übersetzt, seither von Hand gepflegt; `src/model/types.generated.ts` wird hieraus erzeugt
// (`npm run gen:types`, Regeln in `ts_export.rs`). Union-Typen mit Tag stehen in `manual.rs`.
#![allow(clippy::large_enum_variant)]
use super::manual::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum LineStyleKind {
    #[default]
    #[serde(rename = "dash")]
    Dash,
    #[serde(rename = "zigzag")]
    Zigzag,
    #[serde(rename = "custom")]
    Custom,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LineStyleZigzag {
    pub amplitude: f64,
    pub wavelength: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LineStyleMotif {
    pub points: Vec<Vec2>,
    pub length: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein wiederverwendbarer Linienstil (Line Manager).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LineStyle {
    pub id: String,
    pub name: String,
    /// @deprecated Die Strichstärke gehört NICHT mehr in den Linienstil — es gibt nur
    /// „Vollinie/Strich", die tatsächliche Dicke wird per Element-Attribut (bzw.
    /// Ebene/Default) aufgelöst. Das Feld bleibt für die Backward-Compat-Auflösung
    /// erhalten und dient den Renderern noch als Fallback für die Muster-/Fugen-Stärke
    /// (siehe `resolveHatch` → `HatchRender.lineWeight`). Der Linien-Detail-Editor
    /// zeigt es nicht mehr an; neue Linienstile bekommen einen Haarlinien-Default.
    /// Die echte per-Element-Strichstärken-Auflösung (Attribut → Ebene → Default)
    /// folgt separat mit dem By-Layer/By-Object-Refactor — NICHT hier.
    pub weight: f64,
    /// Farbe (hex).
    pub color: String,
    /// Strichmuster in Millimetern, alternierend AN/AUS (`[on, off, on, off, …]`),
    /// loopend; `null` = durchgezogen (Volllinie). Konvention des modularen
    /// Segment-Systems (siehe `src/ui/lineSegments.ts`): ein AN-Wert von 0 bedeutet
    /// einen PUNKT (Dot) — er wird nur mit runder Strichkappe sichtbar (die
    /// betroffene Linie erhält dann `stroke-linecap: round`). So bilden sich
    /// Volllinie/Strichlinie/Punktlinie/Strich-Punkt und frei modulare Folgen aus
    /// Strich/Punkt/Lücke ab. Additiv — kein zusätzliches Feld nötig.
    #[serde(default)]
    pub dash: Option<Vec<f64>>,
    /// Linien-Typ (additiv, Default `undefined` ⇒ "dash"):
    ///   • "dash"   — gerade Linie mit `dash`-Strichmuster (bestehendes Verhalten).
    ///   • "zigzag" — der Strich variiert in Y (Zickzack/Welle), Parameter in
    ///     `zigzag`. Fehlt `kind`, gilt „dash"; die heutigen Renderer ignorieren
    ///     `kind` und zeichnen weiterhin gerade Striche (Backward-Compat).
    ///   • "custom" — ein frei gezeichnetes Motiv (offene Polylinie in einer
    ///     Einheitszelle), das sich entlang der Linie wiederholt/loopt. Parameter in
    ///     `motif`. „zigzag" bleibt der eigene, parametrische Sonderfall.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub kind: Option<LineStyleKind>,
    /// Parameter der Zickzack-/Wellen-Linie (nur `kind==="zigzag"`), beide in mm
    /// Papier: `amplitude` = Ausschlag quer zur Linie, `wavelength` = Periodenlänge
    /// entlang der Linie. Fehlt es, wird die Linie gerade gezeichnet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub zigzag: Option<LineStyleZigzag>,
    /// Frei gezeichnetes Wiederhol-Motiv (nur `kind==="custom"`): eine OFFENE
    /// Polylinie in einer Einheitszelle. `points` sind die Stützpunkte in mm Papier;
    /// `x` läuft 0..`length` (mm entlang der Linie = Wiederhollänge), `y` = senkrechter
    /// Versatz zur Linienachse (mm, +/−). Das Motiv wird alle `length` entlang der
    /// Linie gekachelt. Fehlt es, wird die Linie gerade gezeichnet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub motif: Option<LineStyleMotif>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Zeichen-Marks eines Runs. Alle optional; fehlend = „nicht gesetzt".
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Marks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub strike: Option<bool>,
    /// Hochgestellt. super und sub schliessen sich gegenseitig aus.
    #[serde(rename = "super", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub super_: Option<bool>,
    /// Tiefgestellt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sub: Option<bool>,
    /// Schriftfamilie (CSS font-family-Wert), z. B. "Helvetica".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub font: Option<String>,
    /// Schriftgrösse in typografischen Punkt (pt).
    #[serde(rename = "sizePt", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size_pt: Option<f64>,
    /// Farbe als "#rrggbb".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein benannter Stil (Marks-Vorlage), z. B. „Titel".
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct TextStylePreset {
    /// Stabiler Schlüssel (englisch), z. B. "title".
    pub id: String,
    /// Anzeigename (bereits übersetzt oder Schlüssel für t()).
    pub label: String,
    /// Marks, die der Stil auf die Auswahl (oder das ganze Dokument) legt.
    pub marks: Marks,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum HatchStyleKind {
    #[default]
    #[serde(rename = "vector")]
    Vector,
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "gradient")]
    Gradient,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum HatchStyleLines {
    #[default]
    #[serde(rename = "parallel")]
    Parallel,
    #[serde(rename = "random")]
    Random,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct HatchStyleImage {
    pub src: String,
    #[serde(rename = "scaleX")]
    pub scale_x: f64,
    #[serde(rename = "scaleY")]
    pub scale_y: f64,
    pub rotation: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum HatchStyleGradientType {
    #[default]
    #[serde(rename = "linear")]
    Linear,
    #[serde(rename = "radial")]
    Radial,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct HatchStyleGradient {
    pub color1: String,
    pub color2: String,
    pub angle: f64,
    #[ts(inline)]
    pub r#type: HatchStyleGradientType,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Mögliche Schraffur-Muster im Plan/Schnitt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum HatchPattern {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "solid")]
    Solid,
    #[serde(rename = "insulation")]
    Insulation,
    #[serde(rename = "diagonal")]
    Diagonal,
    #[serde(rename = "crosshatch")]
    Crosshatch,
    #[serde(rename = "custom")]
    Custom,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct HatchStyleMotif {
    pub points: Vec<Vec2>,
    pub length: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine wiederverwendbare Schraffur (Hatch Manager).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct HatchStyle {
    pub id: String,
    pub name: String,
    /// Schraffur-Typ (additiv, Default `undefined` ⇒ "vector"):
    ///   • "vector"   — Musterlinien (die bestehenden `pattern`/`scale`/`angle`/
    ///     `relativeToWall`/`lineStyleId` sind die Vektor-Parameter). Untermodus
    ///     über `lines` (parallel vs. random).
    ///   • "image"    — ein Bild wird als Muster (Pattern-Fill) geladen; Parameter in
    ///     `image` (Skalierung/Verzerrung/Rotation).
    ///   • "gradient" — ein zweifarbiger Farbverlauf (linear/radial) füllt die
    ///     Fläche; Parameter in `gradient`. Wie „image" unabhängig vom `pattern`-
    ///     Feld. GL-/3D-Szene und DXF-Export kennen keine echten Verläufe (wie
    ///     bei „image" bereits der Fall) und fallen auf eine neutrale Füllung
    ///     zurück — nur die SVG-basierten Renderer (PlanView-Anzeige, Druck-/PDF-
    ///     Export) zeichnen den echten Verlauf, da SVG-`<linearGradient>`/
    ///     `<radialGradient>` sich genau wie ein `<pattern>` als `fill="url(#…)"`
    ///     referenzieren lassen — keine neue Fill-Mechanik nötig.
    /// Fehlt `kind`, gilt „vector"; heutige Renderer ignorieren unbekannte `kind`-
    /// Werte und zeichnen weiterhin nach `pattern` (Backward-Compat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub kind: Option<HatchStyleKind>,
    /// Untermodus einer Vektor-Schraffur (nur `kind` fehlt/"vector", Default
    /// `undefined` ⇒ "parallel"):
    ///   • "parallel" — regelmäßige Teilung (bestehendes Verhalten).
    ///   • "random"   — zufällig verteilte Striche (z. B. Kies/Splitt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub lines: Option<HatchStyleLines>,
    /// Bild-Muster (nur `kind==="image"`). `src` = Data-URL oder Asset-Referenz;
    /// `scaleX`/`scaleY` = unabhängige Verzerrung in Breite/Höhe (L×B), `rotation`
    /// = Drehung in Grad. Bei `kind==="vector"` ungenutzt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub image: Option<HatchStyleImage>,
    /// Farbverlauf (nur `kind==="gradient"`). `type`: "linear" (entlang `angle`,
    /// SVG-Konvention wie `HatchStyle.angle`) oder "radial" (vom Flächenzentrum
    /// nach aussen, `angle` dann ungenutzt). `angle` in Grad. Kein Gewicht/keine
    /// Zwischenfarben (Zweifarben-Verlauf, kein Multi-Stop-Editor) — deckt den
    /// Hauptfall ab, s. PENDENZEN.md für die bewusste Vereinfachung.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub gradient: Option<HatchStyleGradient>,
    /// Muster-Typ.
    pub pattern: HatchPattern,
    /// Grundmaßstab des Musters (1 = Standardteilung).
    pub scale: f64,
    /// Drehung des Musters in Grad.
    pub angle: f64,
    /// Wenn `true`, ist `angle` NICHT bildschirmfest, sondern relativ zur Achse der
    /// schraffierten Wand: das Muster dreht mit der Wandorientierung mit (z. B. eine
    /// Diagonale, die stets 45° zur Wand steht, oder Dämmungsstriche quer durch die
    /// Wanddicke). Nur die Wand-Poché wertet dies aus; ohne Wandkontext (z. B. Decke)
    /// degradiert es zu einem absoluten `angle`.
    #[serde(rename = "relativeToWall", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub relative_to_wall: Option<bool>,
    /// @deprecated Schraffuren tragen im Zielmodell KEINE eigene Farbe mehr — die
    /// Muster-/Vordergrundfarbe kommt vom Bauteil (`Component.foreground`) bzw. der
    /// Attribut-Überschreibung. Feld bleibt für die Backward-Compat-Auflösung als
    /// LETZTER Fallback erhalten (siehe Farb-Resolve-Reihenfolge in
    /// `plan/generatePlan.ts` → `resolveHatch`). Bei `pattern==="solid"` ist es die
    /// Vollfüllfarbe, bei `pattern==="none"` ungenutzt.
    pub color: String,
    /// Optionaler Linienstil für die Musterlinien (Line Manager).
    #[serde(rename = "lineStyleId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_style_id: Option<String>,
    /// Steuer-Parameter der Random-Vektor-Schraffur (`kind`/"vector" + `lines`===
    /// "random", z. B. Kies/Splitt). ALLE additiv & optional — fehlen sie, gilt das
    /// bestehende deterministische Streu-Verhalten (Seed aus der Flächen-Bounding-Box,
    /// Dichte/Länge aus `scale`). Die Streuung bleibt bei gleichem `seed` + gleicher
    /// Fläche reproduzierbar über ALLE Renderpfade (single render truth); KEIN
    /// `Math.random()` zur Renderzeit.
    ///
    /// Expliziter Streu-Seed. Wird in den Flächen-Seed eingemischt; „Neu würfeln" setzt einen neuen Wert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seed: Option<f64>,
    /// Streudichte als Multiplikator auf den Grundabstand (Default 1; >1 = dichter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub density: Option<f64>,
    /// Minimale Strichlänge in mm (Papier). Fehlt es, greift die `scale`-abhängige Default-Länge.
    #[serde(rename = "lengthMin", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length_min: Option<f64>,
    /// Maximale Strichlänge in mm (Papier). Fehlt es, greift die `scale`-abhängige Default-Länge.
    #[serde(rename = "lengthMax", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length_max: Option<f64>,
    /// Frei gezeichnetes Wiederhol-Motiv (nur `pattern==="custom"`) — gleiche Form
    /// wie `LineStyle.motif`: eine offene Polylinie in Papier-mm, `x` läuft
    /// 0..`length` (Wiederhollänge ENTLANG der Musterlinie), `y` = Versatz quer zur
    /// Musterlinie. Wird alle `length` Papier-mm entlang jeder Musterlinie
    /// gekachelt UND (wie bei diagonal/crosshatch) im Abstand von `scale`-
    /// abhängigen 8 px quer versetzt wiederholt. Fehlt es, zeichnet „custom" wie
    /// „diagonal" (gerade Linien) — kein Absturz bei frisch angelegten Hatches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub motif: Option<HatchStyleMotif>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// PBR-Material-Karten eines Bauteils (3D-Texturierung). Jede URL verweist auf
/// ein Bild — entweder ein eingebautes Bibliotheks-Asset unter
/// `/assets/materials/...` ODER eine per Nutzer-Upload erzeugte Object-/Data-URL.
/// Fehlende Karten werden weggelassen (z. B. nur `color` bei einem Upload).
/// `sizeM` ist die physische Kantenlänge EINER Texturkachel in Metern (für die
/// korrekte Skalierung der Wiederholung), Default 1.0 m.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ComponentMaterial {
    /// Optionaler Verweis auf ein Bibliotheks-Asset (`MaterialAsset.id`).
    #[serde(rename = "libraryId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub library_id: Option<String>,
    /// Albedo-/Farb-Karte (map).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Normal-Karte (normalMap) — erzeugt die Oberflächentiefe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub normal: Option<String>,
    /// Rauheits-Karte (roughnessMap).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub roughness: Option<String>,
    /// Metallizitäts-Karte (metalnessMap).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub metalness: Option<String>,
    /// Höhen-/Displacement-Karte (displacementMap, dezent angewandt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub displacement: Option<String>,
    /// Ambient-Occlusion-Karte (aoMap).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ao: Option<String>,
    /// Physische Kachelgröße in Metern (Default 1.0).
    #[serde(rename = "sizeM", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size_m: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Bauteil-Material (Component Manager) — vereint Plan-Schnittdarstellung
/// (Schraffur) und 3D-Erscheinung. Ersetzt das frühere `Material`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Component {
    pub id: String,
    pub name: String,
    /// Füllfarbe im Grundriss (Poché) und 3D-Diffusfarbe. Bleibt bestehen; im
    /// Zielmodell (Vordergrund/Hintergrund, s. u.) dient sie als Fallback für
    /// `background`. Migrationsabsicht: neue Projekte setzen `foreground`/
    /// `background`, Alt-Projekte fallen weiterhin auf `color` zurück.
    pub color: String,
    /// Vordergrundfarbe = Farbe der Muster-/Schraffurlinien (die Schraffur selbst
    /// trägt keine Farbe mehr). Optional; fehlt sie, greift die Resolve-Kette
    /// (Attribut-Override ?? Component.foreground ?? HatchStyle.color-Fallback).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground: Option<String>,
    /// Hintergrundfarbe = Füllung (Poché). Optional; fehlt sie, gilt als Fallback
    /// `color`. Migrationsabsicht: `background` ⇐ `color`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background: Option<String>,
    /// Stift-Kopplung (ArchiCAD-Stiftsatz-Muster, s. {@link ColorPen}/{@link
    /// PenSet}): ist eines dieser Felder gesetzt, wird `color`/`foreground`/
    /// `background` NICHT frei editiert, sondern bei jedem Stiftsatz-Wechsel
    /// bzw. jeder Stift-Farbänderung automatisch aus dem aktiven Stiftsatz NEU
    /// GESCHRIEBEN (`rebakePenColors`, `model/penSets.ts`) — die drei Felder
    /// bleiben dadurch für ALLE bestehenden Leser (2D-Plan, beide 3D-Renderer,
    /// Export) unverändert die eine gültige, aufgelöste Farbe; nur die Herkunft
    /// ist jetzt ein Stift statt eine freie Wahl. Ein gesetzter `xxxPenId` gilt
    /// genauso als „eigen" (explizit) wie eine frei gewählte Farbe — beides sind
    /// Werte AM Bauteil, kein Verweis auf eine Ebene (anders als `foregroundSource`
    /// an Wand/Decke/etc.).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_pen_id: Option<String>,
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_pen_id: Option<String>,
    /// Schnitt-Schraffur → Hatch Manager. Gilt, wo das Bauteil echt geschnitten ist.
    #[serde(rename = "hatchId")]
    pub hatch_id: String,
    /// Ansichts-Schraffur → Hatch Manager. Gilt, wo das Bauteil frontal/ungeschnitten
    /// gesehen wird (z. B. Deckenpoché im Grundriss: die Decke liegt über der
    /// horizontalen Schnittebene und wird von unten gesehen, nicht aufgeschnitten).
    /// Leer/`undefined` ⇒ keine Schraffur (weiss).
    #[serde(rename = "viewHatchId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_hatch_id: Option<String>,
    /// Optionale 3D-Textur (vorerst ignoriert).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub texture3d: Option<String>,
    /// Optionales echtes PBR-Material für die 3D-Texturierung (Bibliothek ODER
    /// Upload). Fehlt es, bleibt das heutige Verhalten (matte Farbe). Wirkt nur im
    /// Render-Modus „textured".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub material: Option<ComponentMaterial>,
    /// Optionales Kürzel für Wandtyp-Labels (z. B. „BET", „HLZ", „GKB", „DAE").
    /// Wird von `wallTypeLabel()` genutzt, um Wandtyp-Dropdowns kompakt darzustellen
    /// (z. B. „BET 24" statt dem vollen Namen). Fehlt es, greift der Name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub abbrev: Option<String>,
    /// Verschneidungs-Rang: höher läuft am Stoß durch (Backbone).
    #[serde(rename = "joinPriority")]
    pub join_priority: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine Schicht eines mehrschichtigen Bauteils.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Layer {
    /// Verweis auf das Bauteil-Material (Component Manager).
    #[serde(rename = "componentId")]
    pub component_id: String,
    /// Schichtdicke in Metern.
    pub thickness: f64,
    /// Linienstil (LineStyle) der Schichtfuge an der INNEREN Kante DIESER Schicht —
    /// also der Fuge zwischen dieser und der nächst-inneren Schicht. Bei der
    /// innersten Schicht ungenutzt (ihre innere Kante ist der Wand-Innenumriss).
    /// Fehlt das Feld, wird die Standard-Haarlinie (0.02 mm) gezeichnet.
    #[serde(rename = "jointLineStyleId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub joint_line_style_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Wandtyp = geordneter Schichtaufbau (außen → innen).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct WallType {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Deckentyp (Deckenstil) = geordneter Schichtaufbau EINER Decke, liegend
/// gestapelt (oben → unten) — das horizontale Gegenstück zum `WallType`. Nutzt
/// denselben `Layer`-Typ (Bauteil + Dicke + optionaler Schichtfugen-Linienstil),
/// damit Fuge/Schraffur-Auflösung identisch zur Wand bleiben. Eine „einschichtige"
/// Decke (SOLID) ist einfach ein Deckentyp mit genau einer Schicht.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct CeilingType {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Dachtyp (Dachaufbau) = geordneter Schichtaufbau EINES Daches, senkrecht
/// zur Dachfläche gestapelt (aussen/Eindeckung → innen/Verkleidung) — das
/// geneigte Gegenstück zu `WallType`/`CeilingType`. Nutzt denselben `Layer`-Typ.
/// Typische Folge: Eindeckung (Ziegel/Blech) → Konterlattung/Lattung → Unterdach
/// → Sparren/Dämmung → Dampfbremse → Innenverkleidung. Ein Dach ohne `roofTypeId`
/// fällt auf die einschichtige `Roof.thickness` zurück (rückwärtskompatibel).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct RoofType {
    pub id: String,
    pub name: String,
    /// Aussen (Eindeckung) → innen (Verkleidung), analog `WallType.layers`.
    pub layers: Vec<Layer>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Wiederverwendbares 2D-Symbol (Möbelblock, Sanitär-/Normsymbol, Nordpfeil
/// u. Ä.) — s. `Project.blockDefs` + `Drawing2DGeom["block"]`. `geom2d` ist
/// LOKALE Geometrie (Ursprung = Einfügepunkt der Instanz, Winkel 0 = wie
/// definiert); jede Instanz transformiert sie beim Rendern per `at`/`rotation`.
/// Bewusst KEIN verschachtelter `"block"`-Shape in `geom2d` (keine Blöcke in
/// Blöcken, v1) — nicht technisch erzwungen, nur Konvention der Autoren-Seite
/// (`commands/cmds/defblock.ts`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct BlockDef {
    pub id: String,
    pub name: String,
    pub geom2d: Vec<Drawing2DGeom>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum DoorTypeKind {
    #[default]
    #[serde(rename = "dreh")]
    Dreh,
    #[serde(rename = "schiebe")]
    Schiebe,
    #[serde(rename = "wandoeffnung")]
    Wandoeffnung,
    /// Hebeschiebetür: Rahmen in der Wand, ein festes und ein schiebbares Glasfeld ([95]).
    #[serde(rename = "hebeschiebe")]
    Hebeschiebe,
    /// Pendeltür: schlägt nach beiden Seiten auf ([95]).
    #[serde(rename = "pendel")]
    Pendel,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum DoorTypeLeafStyle {
    #[default]
    #[serde(rename = "glatt")]
    Glatt,
    #[serde(rename = "kassette")]
    Kassette,
    #[serde(rename = "glas")]
    Glas,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum DoorTypeFrameKind {
    #[default]
    #[serde(rename = "zarge")]
    Zarge,
    #[serde(rename = "blockrahmen")]
    Blockrahmen,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

// ── Bauteil-Typen: Tür / Fenster / Treppe ──────────────────────────────────
// Wiederverwendbare Stile (Presets) für Türen, Fenster und Treppen — analog
// `WallType`/`CeilingType` (Bibliothek im Projekt, referenziert per `typeId`).
// Getrennte Typen (kein gemeinsames „OpeningType"), damit türspezifische und
// fensterspezifische Parameter sauber je Gattung wohnen. Ein Element ohne
// `typeId` behält sein heutiges Inline-Verhalten (rückwärtskompatibel).

/// Ein Türtyp (Türstil) — wiederverwendbares Preset für {@link Opening} mit
/// `kind: "door"`. Bündelt Bauart, Blattausführung und Standardmaße. Werte am
/// einzelnen Element (Breite/Höhe/Anschlag) übersteuern die Typ-Defaults.
///
/// Eckverbindung von Rahmenprofilen (s. `WindowType.frameCornerJoin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum FrameCornerJoin {
    #[default]
    #[serde(rename = "vertikal")]
    Vertikal,
    #[serde(rename = "horizontal")]
    Horizontal,
    #[serde(rename = "gehrung")]
    Gehrung,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum DoorTypeInsetFace {
    #[default]
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "innen")]
    Innen,
    /// Rahmen mittig in der Wand (Leibung beidseitig gleich tief); `insetFromFace` wirkt nicht.
    #[serde(rename = "mitte")]
    Mitte,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct DoorType {
    pub id: String,
    pub name: String,
    /// Bauart: normaler Drehflügel, reine Wandöffnung (kein Blatt/Schwenk),
    /// Schiebetür. Ersetzt/ergänzt das Inline-Feld `Opening.doorType`.
    #[ts(inline)]
    pub kind: DoorTypeKind,
    /// Anzahl Türblätter (1 = einflügelig, 2 = zweiflügelig).
    #[serde(rename = "leafCount")]
    #[ts(type = "1 | 2")]
    pub leaf_count: f64,
    /// Blatt-Ausführung (3D/Detail): glatt, Kassette, Glasfüllung.
    #[serde(rename = "leafStyle")]
    #[ts(inline)]
    pub leaf_style: DoorTypeLeafStyle,
    /// Glasanteil des Blatts (0..1); nur bei `leafStyle: "glas"` relevant.
    #[serde(rename = "glazingRatio", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub glazing_ratio: Option<f64>,
    /// Anzahl Kassetten-Felder horizontal; nur bei `leafStyle: "kassette"` relevant. Default 2.
    #[serde(rename = "panelCols", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub panel_cols: Option<f64>,
    /// Anzahl Kassetten-Felder vertikal; nur bei `leafStyle: "kassette"` relevant. Default 3.
    #[serde(rename = "panelRows", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub panel_rows: Option<f64>,
    /// Zargen-/Rahmenstärke quer zur Wand (Meter).
    #[serde(rename = "frameThickness")]
    pub frame_thickness: f64,
    /// Rahmen-/Zargen-Tiefe in Wandrichtung (Meter); fehlt ⇒ aus Wanddicke.
    #[serde(rename = "frameDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_depth: Option<f64>,
    /// Rahmenart:
    ///  • "zarge"       — Zarge, umschliesst die Laibung (schmales Profil, in der
    ///    Wandlaibung sitzend — der Standard im Innenausbau).
    ///  • "blockrahmen" — Blockrahmen, sitzt als kräftiges Rechteckprofil VOR/auf
    ///    der Laibung (typisch bei Aussentüren/älterem Bestand).
    /// Fehlt es, gilt "zarge".
    #[serde(rename = "frameKind", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub frame_kind: Option<DoorTypeFrameKind>,
    /// Ansichtsbreite des Rahmenprofils (Meter) — die sichtbare Rahmen-Randbreite
    /// in der Öffnungsebene (Elevation), NICHT die Tiefe quer zur Wand. Fehlt es,
    /// gilt ein schmaler Default (~0.06 m). Steuert 2D-Rahmenkontur + 3D-Rahmen.
    #[serde(rename = "frameWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_width: Option<f64>,
    /// Eckverbindung der Rahmen (Blend- und Flügelrahmen) in der Ansicht:
    /// "vertikal" (Pfosten laufen durch, Riegel dazwischen — Default),
    /// "horizontal" (Riegel laufen durch) oder "gehrung" (45°-Stoss). Wirkt im
    /// 3D; vorher überlappten die Flügelrahmen-Profile an den Ecken (doppelte
    /// Kanten bei „Schattiert mit Kanten").
    #[serde(rename = "frameCornerJoin", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_corner_join: Option<FrameCornerJoin>,
    /// Schichteinzug: Abstand der Rahmen-Vorderkante von einer Wandfläche (Meter).
    /// 0/fehlt ⇒ bündig. > 0 ⇒ der Rahmen sitzt um diesen Betrag in die Wand
    /// zurückgesetzt (z. B. hinter die Aussenschale eines mehrschichtigen Aufbaus).
    /// Gemessen von der über {@link insetFace} gewählten Fläche.
    #[serde(rename = "insetFromFace", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inset_from_face: Option<f64>,
    /// Von welcher Wandfläche der {@link insetFromFace} gemessen wird; Default "aussen".
    #[serde(rename = "insetFace", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub inset_face: Option<DoorTypeInsetFace>,
    /// Oberlicht: Höhe eines festen, verglasten Oberlichts über dem Türblatt
    /// (Meter). 0/fehlt ⇒ kein Oberlicht. Das Oberlicht sitzt oberhalb eines
    /// Kämpfers innerhalb derselben lichten Öffnungshöhe.
    #[serde(rename = "transomHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transom_height: Option<f64>,
    /// Default-Lichtbreite (Meter) für neu platzierte Türen dieses Typs.
    #[serde(rename = "defaultWidth")]
    pub default_width: f64,
    /// Default-Lichthöhe (Meter).
    #[serde(rename = "defaultHeight")]
    pub default_height: f64,
    /// Bodenschwelle/Anschlag zeichnen (3D/Detail).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub threshold: Option<bool>,
    /// Anschlag (Maueranschlag): so weit (Meter, je Seite und oben) springt die Wand zwischen
    /// der Fläche aus {@link insetFace} und der Rahmen-Vorderkante in die Öffnung vor. Wirkt nur
    /// mit Leibung (`insetFromFace` > 0 bzw. `insetFace: "mitte"`). 0/fehlt ⇒ stumpf (bisher).
    #[serde(rename = "rebateDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rebate_depth: Option<f64>,
    /// Sturz: Höhe des Sturzes über der Öffnung (Meter), im Schnitt als eigener Querschnitt
    /// gezeichnet. 0/fehlt ⇒ kein eigener Sturz (bisher).
    #[serde(rename = "lintelHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lintel_height: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Fenstertyp (Fensterstil) — wiederverwendbares Preset für {@link Opening}
/// mit `kind: "window"`. Bündelt Öffnungsart, Flügelzahl, Verglasung und
/// Standardmaße inkl. Brüstungshöhe.
///
/// Öffnungsart eines einzelnen Flügels (bzw. des ganzen Fensters, alt).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OpeningKind {
    #[default]
    #[serde(rename = "dreh")]
    Dreh,
    #[serde(rename = "kipp")]
    Kipp,
    #[serde(rename = "drehkipp")]
    Drehkipp,
    #[serde(rename = "fest")]
    Fest,
    #[serde(rename = "schiebe")]
    Schiebe,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SashDefKind {
    #[default]
    #[serde(rename = "fluegel")]
    Fluegel,
    #[serde(rename = "pfosten")]
    Pfosten,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SashDefHingeSide {
    #[default]
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ein Eintrag der Flügeleinteilung eines Fensters (VW „Flügeltabelle"): entweder
/// ein Flügel (verglaste, ggf. öffenbare Einheit) oder ein Pfosten (feste vertikale
/// Teilung). Ersetzt/erweitert das grobe {@link WindowType.wingCount}: ist
/// {@link WindowType.sashes} gesetzt, hat es Vorrang; sonst wird die Einteilung aus
/// `wingCount` gleichmäßig abgeleitet (siehe `sashesOfWindowType`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SashDef {
    #[ts(inline)]
    pub kind: SashDefKind,
    /// Gleichmässig mitaufteilen (Default true); bei false gilt {@link width}.
    #[serde(rename = "autoWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_width: Option<bool>,
    /// Feste Flügelbreite (Meter), nur wenn `autoWidth === false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub width: Option<f64>,
    /// Pfostenbreite (Meter); nur `kind === "pfosten"`.
    #[serde(rename = "postWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub post_width: Option<f64>,
    /// Öffnungsart DIESES Flügels (nur `kind === "fluegel"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub opening: Option<OpeningKind>,
    /// Anschlag/Bandseite (nur öffenbare Flügel).
    #[serde(rename = "hingeSide", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub hinge_side: Option<SashDefHingeSide>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum WindowShadingKind {
    #[default]
    #[serde(rename = "rollladen")]
    Rollladen,
    #[serde(rename = "raffstore")]
    Raffstore,
    #[serde(rename = "markise")]
    Markise,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Einbau des Sonnenschutzkastens ({@link WindowShading.mount}).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum WindowShadingMount {
    #[default]
    #[serde(rename = "vorgesetzt")]
    Vorgesetzt,
    #[serde(rename = "sturz")]
    Sturz,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct WindowShadingBox {
    pub width: f64,
    pub height: f64,
    pub depth: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Rollladen-/Sonnenschutzkasten über der Öffnung (P0-Minimalfassung).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct WindowShading {
    pub create: bool,
    #[ts(inline)]
    pub kind: WindowShadingKind,
    /// Kastenmasse (Meter): Breite (quer, meist = Öffnung), Höhe, Tiefe.
    #[ts(inline)]
    pub r#box: WindowShadingBox,
    /// Einbau des Kastens: "vorgesetzt" (vor der Rahmenebene, bisher) oder "sturz" (Storenkasten
    /// im Sturz, in der Wand verdeckt — in der Schweiz üblich bei Lamellenstoren). Fehlt ⇒ vorgesetzt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mount: Option<WindowShadingMount>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum WindowTypeGlazing {
    #[default]
    #[serde(rename = "einfach")]
    Einfach,
    #[serde(rename = "zweifach")]
    Zweifach,
    #[serde(rename = "dreifach")]
    Dreifach,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum WindowTypeInsetFace {
    #[default]
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "innen")]
    Innen,
    /// Rahmen mittig in der Wand (Leibung beidseitig gleich tief); `insetFromFace` wirkt nicht.
    #[serde(rename = "mitte")]
    Mitte,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum WindowTypeSillLineFaces {
    #[default]
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "innen")]
    Innen,
    #[serde(rename = "beide")]
    Beide,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum WindowTypeSillLineView {
    #[default]
    #[serde(rename = "auf")]
    Auf,
    #[serde(rename = "unter")]
    Unter,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct WindowTypeSillLine {
    #[ts(inline)]
    pub faces: WindowTypeSillLineFaces,
    #[ts(inline)]
    pub view: WindowTypeSillLineView,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum WindowTypeSillBoard {
    #[default]
    #[serde(rename = "keine")]
    Keine,
    #[serde(rename = "innen")]
    Innen,
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "beide")]
    Beide,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct WindowType {
    pub id: String,
    pub name: String,
    /// Öffnungsart: Dreh, Kipp, Dreh-Kipp, fest verglast, Schiebe.
    pub kind: OpeningKind,
    /// Anzahl Flügel (1–4) → Mittelpfosten = wingCount − 1 (vgl. `Opening.wingCount`).
    #[serde(rename = "wingCount")]
    pub wing_count: f64,
    /// Flügeleinteilung (VW „Flügeltabelle"): einzelne Flügel/Pfosten mit Breite und
    /// Öffnungsrichtung. Hat Vorrang vor {@link wingCount}; fehlt es, wird die
    /// Einteilung gleichmässig aus `wingCount` abgeleitet (`sashesOfWindowType`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sashes: Option<Vec<SashDef>>,
    /// Rollladen-/Sonnenschutzkasten über der Öffnung.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shading: Option<WindowShading>,
    /// Verglasungs-Scheibenzahl, RENDER-wirksam (1/2/3). Fehlt es, wird sie aus
    /// {@link glazing} abgeleitet. Steuert die 3D-Scheibenzahl und die 2D-Glaslinien.
    #[serde(rename = "glazingPanes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "1 | 2 | 3")]
    pub glazing_panes: Option<f64>,
    /// Anzahl horizontaler Felder (Kämpfer-Zeilen): 1 = keine Querteilung, 2 = ein
    /// Kämpfer, usw. Zusammen mit {@link wingCount} (Spalten) ergibt sich das
    /// Sprossen-/Flügelraster. Fehlt es, gilt 1.
    #[serde(rename = "mullionRows", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mullion_rows: Option<f64>,
    /// Anzahl vertikaler Felder (Sprossen-Spalten): 1 = keine Querteilung, 2 = ein
    /// Sprossen-Mittelpunkt (Spalte), usw. Zusammen mit {@link wingCount} (Spalten)
    /// ergibt sich das Sprossen-/Flügelraster. Fehlt es, gilt 1.
    #[serde(rename = "mullionCols", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mullion_cols: Option<f64>,
    /// Verglasung: Einfach/Zweifach/Dreifach (3D-Scheibenzahl).
    #[ts(inline)]
    pub glazing: WindowTypeGlazing,
    /// Rahmenstärke quer zur Wand (Meter).
    #[serde(rename = "frameThickness")]
    pub frame_thickness: f64,
    /// Rahmen-Tiefe in Wandrichtung (Meter); fehlt ⇒ aus Wanddicke.
    #[serde(rename = "frameDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_depth: Option<f64>,
    /// Ansichtsbreite des Rahmen-/Flügelprofils (Meter) — sichtbare Randbreite in
    /// der Öffnungsebene. Fehlt es, gilt ein schmaler Default (~0.06 m). Steuert die
    /// 2D-Rahmen-/Sprossenkontur und den 3D-Rahmen.
    #[serde(rename = "frameWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_width: Option<f64>,
    /// Eckverbindung der Rahmen (Blend- und Flügelrahmen) in der Ansicht:
    /// "vertikal" (Pfosten laufen durch, Riegel dazwischen — Default),
    /// "horizontal" (Riegel laufen durch) oder "gehrung" (45°-Stoss). Wirkt im
    /// 3D; vorher überlappten die Flügelrahmen-Profile an den Ecken (doppelte
    /// Kanten bei „Schattiert mit Kanten").
    #[serde(rename = "frameCornerJoin", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_corner_join: Option<FrameCornerJoin>,
    /// Schichteinzug: Abstand der Rahmen-Vorderkante von einer Wandfläche (Meter).
    /// 0/fehlt ⇒ bündig; > 0 ⇒ der Rahmen sitzt zurückgesetzt (klassisch hinter der
    /// Aussenschale eines mehrschichtigen Wandaufbaus). Von {@link insetFace} gemessen.
    #[serde(rename = "insetFromFace", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inset_from_face: Option<f64>,
    /// Von welcher Wandfläche der {@link insetFromFace} gemessen wird; Default "aussen".
    #[serde(rename = "insetFace", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub inset_face: Option<WindowTypeInsetFace>,
    /// Schicht-Rücksprung an der Laibung: weicht die INNERSTE Wandschicht (meist
    /// Gipsplatte/Holzverkleidung) an diesem Fenster um ihre eigene Dicke von der
    /// Öffnung zurück, statt bündig mit den übrigen Schichten abzuschliessen —
    /// anders als {@link insetFromFace} (der Rahmen-Position), ändert dies die
    /// WAND-GEOMETRIE selbst an der Laibung. Default false (bündig, Alt-Verhalten).
    #[serde(rename = "innerLayerRecess", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inner_layer_recess: Option<bool>,
    /// Oberlicht: Höhe eines festen, verglasten Oberlichts über dem Hauptflügel
    /// (Meter), abgeteilt durch einen Kämpfer. 0/fehlt ⇒ kein Oberlicht.
    #[serde(rename = "transomHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transom_height: Option<f64>,
    /// Einteilung des Oberlichts über dem Riegel (Pfosten/Riegel, [95]): Felder und Pfosten wie
    /// {@link sashes}, je Feld fest oder öffenbar (meist Kipp). Fehlt ⇒ ein festes Feld (bisher).
    #[serde(rename = "transomSashes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transom_sashes: Option<Vec<SashDef>>,
    /// Auf-/Untersicht-Andeutung im Grundriss (mittel/fein): eine Referenzlinie an
    /// der gewählten Fläche(n) — sinnvoll, wenn die Öffnung die Schnittebene NICHT
    /// regulär durchschneidet (z. B. bodentiefes Fenster oder hoch sitzendes
    /// Oberlicht). `faces` wählt aussen/innen/beide, `view` die Blickrichtung:
    /// "auf" (Aufsicht von oben, dünn) oder "unter" (Untersicht von unten,
    /// gestrichelt wie eine überkopf liegende Kante). Fehlt/undefined ⇒ keine Linie.
    #[serde(rename = "sillLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub sill_line: Option<WindowTypeSillLine>,
    /// Default-Brüstungshöhe über Wand-UK (Meter).
    #[serde(rename = "defaultSillHeight")]
    pub default_sill_height: f64,
    /// Default-Lichtbreite (Meter).
    #[serde(rename = "defaultWidth")]
    pub default_width: f64,
    /// Default-Lichthöhe (Meter).
    #[serde(rename = "defaultHeight")]
    pub default_height: f64,
    /// Fensterbank zeichnen (Detail): keine / innen / aussen / beide.
    #[serde(rename = "sillBoard", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub sill_board: Option<WindowTypeSillBoard>,
    /// Anschlag (Maueranschlag): so weit (Meter, je Seite und oben) springt die Wand zwischen
    /// der Fläche aus {@link insetFace} und der Rahmen-Vorderkante in die Öffnung vor. Wirkt nur
    /// mit Leibung (`insetFromFace` > 0 bzw. `insetFace: "mitte"`). 0/fehlt ⇒ stumpf (bisher).
    #[serde(rename = "rebateDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rebate_depth: Option<f64>,
    /// Sturz: Höhe des Sturzes über der Öffnung (Meter), im Schnitt als eigener Querschnitt
    /// gezeichnet. 0/fehlt ⇒ kein eigener Sturz (bisher).
    #[serde(rename = "lintelHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lintel_height: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum StairTypeStructure {
    #[default]
    #[serde(rename = "massiv")]
    Massiv,
    #[serde(rename = "beton")]
    Beton,
    #[serde(rename = "wange")]
    Wange,
    #[serde(rename = "aufgesattelt")]
    Aufgesattelt,
    #[serde(rename = "spindel")]
    Spindel,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum StairTypeRailing {
    #[default]
    #[serde(rename = "keine")]
    Keine,
    #[serde(rename = "links")]
    Links,
    #[serde(rename = "rechts")]
    Rechts,
    #[serde(rename = "beide")]
    Beide,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ein Treppentyp (Treppenstil) — wiederverwendbares Preset für {@link Stair}.
/// Bündelt Tragart, Stufenausbildung und Geländer. Geometrische Grundform
/// (gerade/L/Wendel) + Lauflänge/Stufenzahl bleiben am einzelnen Element.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct StairType {
    pub id: String,
    pub name: String,
    /// Tragart:
    ///  • "massiv"       — Vollblock bis zur Treppen-UK (Treppe auf Erdreich/Sockel).
    ///  • "beton"        — Ortbeton-Laufplatte mit SCHRÄGER, offener Untersicht
    ///    (die klassische „normale Betontreppe" zwischen zwei Geschossen).
    ///  • "wange"        — Wangentreppe (schwebende Tritte, offen).
    ///  • "aufgesattelt" — aufgesattelte Tritte (mit Setzstufen, offen).
    ///  • "spindel"      — Spindel-/Wendeltreppe (offen).
    #[ts(inline)]
    pub structure: StairTypeStructure,
    /// Setzstufen geschlossen (true) oder offen (false, durchsichtige Tritte).
    #[serde(rename = "closedRisers")]
    pub closed_risers: bool,
    /// Trittstufendicke (Meter).
    #[serde(rename = "treadThickness")]
    pub tread_thickness: f64,
    /// Trittkanten-Überstand / Nase (Meter); fehlt ⇒ 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nosing: Option<f64>,
    /// Handlauf/Geländer: keine / links / rechts / beide (in Laufrichtung).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub railing: Option<StairTypeRailing>,
    /// Default-Laufbreite (Meter) für neu platzierte Treppen dieses Typs.
    #[serde(rename = "defaultWidth")]
    pub default_width: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── Ressourcen-Bibliotheken (Vectorworks-/DOSSIER-Stil) ────────────────────
// Verwaltete, per id verwiesene Stil-Ressourcen. Verweis-Kette:
//   Component → Hatch → LineStyle.
// Darstellung wird beim Rendern aus diesen Ressourcen aufgelöst, nie in die
// Geometrie eingebacken (siehe docs/design/resources-graphics.md).

/// Ein Stift (ArchiCAD-Stiftsatz-Muster): ein reiner NAME/PLATZHALTER, der
/// projektweit über alle {@link PenSet}s hinweg dieselbe Identität `id` behält.
/// Ein Stift trägt selbst KEINE Farbe — welche Farbe er zeigt, bestimmt der
/// jeweils AKTIVE Stiftsatz (`Project.activePenSetId`). Ein Bauteil/eine Ebene,
/// die statt einer freien Farbe auf einen Stift zeigt (`xxxPenId`), übernimmt
/// dadurch automatisch jede Farbänderung des Stifts bzw. jeden Stiftsatz-
/// Wechsel — ohne selbst angefasst zu werden.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ColorPen {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Stiftsatz — ordnet JEDEM Stift (`ColorPen.id`) eine konkrete Farbe zu.
/// Mehrere Stiftsätze können nebeneinander existieren (z. B. „Standard",
/// „Plot S/W", „Präsentation"); nur einer ist je Projekt AKTIV
/// (`Project.activePenSetId`). Fehlt ein Stift im `colors`-Objekt (z. B. neu
/// angelegt, aber in diesem Satz noch nicht befüllt), gilt `PEN_FALLBACK_COLOR`
/// (s. `model/penSets.ts`).
///
/// Farbe + Strichstärke EINES Stifts in EINEM Stiftsatz — wie ein echter
/// ArchiCAD-/AutoCAD-Stift wandern beide zusammen, wenn ein Element/eine Ebene
/// auf diesen Stift gestellt wird (s. `Component.colorPenId`-Doku).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct PenStyle {
    pub color: String,
    /// Strichstärke in Millimetern.
    pub weight: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct PenSet {
    pub id: String,
    pub name: String,
    /// Stift-ID (`ColorPen.id`) → Farbe+Strichstärke.
    pub pens: std::collections::BTreeMap<String, PenStyle>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine benutzerdefinierte Farbpalette (Farbmischer → „Diese Farbe
/// speichern", `ui/FreeColorPicker.tsx`). Anders als Stiftsätze: reine
/// Farb-Sammlung ohne Kopplungs-/Baking-Semantik — ein Klick auf einen
/// Swatch übernimmt einfach den Hex-Wert wie bei den mitgelieferten
/// Paletten (Einfach/Tango/Material/RAL), nur eben frei befüllbar. Mehrere
/// Paletten können nebeneinander existieren (z. B. „Fassade Projekt X",
/// „Innenausbau"); keine ist „aktiv" — alle sind gleichzeitig über den
/// Paletten-Umschalter erreichbar.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct CustomPalette {
    pub id: String,
    pub name: String,
    /// Hex-Werte, Reihenfolge = Anzeigereihenfolge im Raster.
    pub colors: Vec<String>,
    /// Im Farbwahl-Popover anzeigen? Fehlt das Feld, gilt `true` (sichtbar) —
    /// so bleiben bestehende Projekte unverändert. Umschaltbar im Ressourcen-
    /// Manager (Tab „Paletten"), damit die Bank-Leiste im Popover kurz bleibt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub visible: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Sichtbarkeit der MITGELIEFERTEN Farbpaletten-Bänke im Farbwahl-Popover
/// (`ui/FreeColorPicker.tsx`). Fehlt ein Schlüssel (oder das ganze Objekt),
/// gilt die Bank als sichtbar — nur ein explizites `false` blendet sie aus
/// (z. B. RAL, wenn im Projekt nie mit Fassadenfarben gearbeitet wird).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct BuiltinPaletteBanks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub simple: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tango: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub material: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ral: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Art einer Zeichnungsebene.
///   • "floor"     — Geschoss, trägt Bauteile.
///   • "section"   — Schnitt (abgeleitete Projektion entlang einer Linie).
///   • "elevation" — Ansicht (abgeleitete Projektion entlang einer Linie).
///   • "drawing"   — freie 2D-Zeichnung, nicht an ein Geschoss gebunden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum DrawingLevelKind {
    #[default]
    #[serde(rename = "floor")]
    Floor,
    #[serde(rename = "section")]
    Section,
    #[serde(rename = "elevation")]
    Elevation,
    #[serde(rename = "drawing")]
    Drawing,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct DrawingLevel {
    pub id: String,
    pub name: String,
    pub kind: DrawingLevelKind,
    /// Sichtbarkeit der Zeichnungsebene im Navigator.
    pub visible: bool,
    /// Gesperrt (keine Bearbeitung).
    pub locked: bool,
    /// Lichte Geschosshöhe in Metern (nur Geschoss).
    #[serde(rename = "floorHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_height: Option<f64>,
    /// Schnitthöhe über OKFF in Metern (nur Geschoss, für den Grundriss).
    #[serde(rename = "cutHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cut_height: Option<f64>,
    /// Oberkante Fertigfußboden in Metern (nur Geschoss).
    #[serde(rename = "baseElevation", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_elevation: Option<f64>,
    /// Schnitt-/Ansichtslinie im Grundriss (nur Schnitt/Ansicht).
    #[serde(rename = "linePoints", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_points: Option<[Vec2; 2]>,
    /// Blickrichtung relativ zur Schnittlinie (nur Schnitt/Ansicht).
    #[serde(rename = "directionSign", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "1 | -1")]
    pub direction_sign: Option<f64>,
    /// Schlagschatten in der Ansicht (nur kind "elevation"). Additiv; fehlt/`false`
    /// ⇒ keine Schatten (heutiges Verhalten). Steuert `generateElevationPlan`
    /// (toElevation.ts): auskragende Bauteile werfen einen 45°-Schlagschatten auf
    /// die dahinterliegende Fassade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shadows: Option<bool>,
    /// Schnitt-Tiefe in Metern (nur Schnitt/Ansicht): Bauteile weiter als `depth`
    /// HINTER der Schnittebene (in Blickrichtung) werden ausgeblendet. Fehlt der
    /// Wert, ist die Tiefe unbegrenzt (das gesamte Modell wird projiziert — heutiges
    /// Verhalten).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub depth: Option<f64>,
    /// Verdeckte Kanten im Schnitt zeichnen (gestrichelt). Default AUS — sie
    /// legen sich sonst als blasses Liniengewirr über Poché und Ansichtskanten.
    #[serde(rename = "hiddenLines", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hidden_lines: Option<bool>,
    /// Grundriss-Unterlage (nur Schnitt/Ansicht): ID eines Geschosses, dessen
    /// Grundriss AUSGERICHTET unter dem Schnitt/der Ansicht gezeigt wird (Schnitt-
    /// linie waagrecht, Blickrichtung nach oben, s. Kern `plan/underlay.rs`).
    /// Fehlt ⇒ keine Unterlage.
    #[serde(rename = "planUnderlayId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan_underlay_id: Option<String>,
    /// Automatische Höhenkoten (nur Schnitt/Ansicht): je Geschoss OK fertig Boden
    /// + oberste Kante, links neben der Zeichnung (`plan/levelMarkers.ts`).
    /// Fehlt ⇒ an; `false` ⇒ aus.
    #[serde(rename = "levelMarks", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub level_marks: Option<bool>,
    /// Blatt-Ebene (nur kind "drawing"): gehört zum Layout mit dieser ID und trägt dessen
    /// 2D-Zeichnung (Linien, Texte, Bilder …) als gewöhnliche `drawings2d`. Koordinaten = Papier
    /// im Massstab 1:1 in Metern, Ursprung oben links am Blatt, Papier-y nach unten = −y
    /// (Papier-mm (x, y) ↔ Modell (x/1000, −y/1000)). Nicht im Navigator; nur sichtbar, wenn das
    /// Blatt offen ist. Fehlt ⇒ gewöhnliche Ebene.
    #[serde(rename = "layoutId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layout_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Blatt-Kategorien nach SIA 416, die einem Raum direkt zugewiesen werden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SiaCategory {
    #[default]
    #[serde(rename = "HNF")]
    HNF,
    #[serde(rename = "NNF")]
    NNF,
    #[serde(rename = "VF")]
    VF,
    #[serde(rename = "FF")]
    FF,
    #[serde(rename = "KGF")]
    KGF,
    #[serde(rename = "AGF")]
    AGF,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Eine Zeile des Raumprogramms (Soll): wird gegen die gezeichneten Räume geprüft (`analysis/kennzahlen.ts`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct RoomProgramRow {
    /// Raumname wie im Modell (Vergleich ohne Gross-/Kleinschreibung, Präfix „Wohnen" trifft „Wohnen 2").
    pub name: String,
    /// SIA-416-Kategorie des Soll-Raums (optional, schärft die Zuordnung).
    #[serde(rename = "siaCategory", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sia_category: Option<SiaCategory>,
    /// Soll-Fläche je Raum in m².
    pub area: f64,
    /// Soll-Anzahl (Default 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub count: Option<f64>,
    /// Gruppe/Bereich/Geschoss aus dem Programm (z. B. „Wohnen", „EG"): Zwischensummen und Farbe beim Generieren.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group: Option<String>,
    /// Bemerkung aus dem Programm (reiner Text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Schattenstudie (`analysis/sun.ts`): der Schatten liegt auf dem Geschoss nächst ±0.00.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SunStudy {
    /// Zeitpunkt als ISO-8601-Text in UTC, z. B. "2026-12-21T11:00:00Z".
    pub when: String,
    pub show: bool,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SiteRulesBuildingLines {
    pub a: Vec2,
    pub b: Vec2,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine Zeichnungsebene (DrawingLevel) — eine oberste Schnittebene des
/// Dokuments. Ein Geschoss trägt die Bauteile (über `floorId`); ein
/// Schnitt/Ansicht ist eine abgeleitete Projektion (vorerst Platzhalter); eine
/// reine Zeichnung ist eine freie 2D-Ebene ohne Geschossbezug.
///
/// Geschoss nutzt floorHeight/cutHeight/baseElevation; Schnitt/Ansicht nutzen
/// linePoints/directionSign; "drawing" nutzt keines dieser Felder.
///
/// Baurecht einer Parzelle ([63]). Die zulässige Grundfläche ist die Parzelle ohne die Streifen
/// „näher als der Grenzabstand an Kante i", begrenzt durch die Baulinien.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SiteRules {
    /// Parzellengrenze als geschlossener Ring (Modell-Meter, Umlaufsinn beliebig).
    pub parcel: Vec<Vec2>,
    /// Grenzabstand (m) je Kante i = parcel[i] → parcel[i+1]; fehlende Einträge → `defaultSetback`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub setbacks: Option<Vec<f64>>,
    /// Grenzabstand (m) für alle Kanten ohne eigenen Wert.
    #[serde(rename = "defaultSetback")]
    pub default_setback: f64,
    /// Baulinien: das Gebäude bleibt auf der Seite der Linie, auf der der Parzellen-Schwerpunkt liegt.
    #[serde(rename = "buildingLines", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub building_lines: Option<Vec<SiteRulesBuildingLines>>,
    /// Zulässige Gesamthöhe über ±0.00 (m).
    #[serde(rename = "maxHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_height: Option<f64>,
    /// Parzelle, zulässige Fläche und Verstösse im Grundriss zeigen (Default: ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine Ebene (LayerCategory) — ein Knoten im Grafik-Kategorie-Baum. Das
/// Schema gilt geschossübergreifend; Elemente verweisen über `code` darauf.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayerCategory {
    /// Eindeutiger Kategorie-Code, z. B. "20" für Wände.
    pub code: String,
    pub name: String,
    /// Darstellungsfarbe (hex).
    pub color: String,
    /// Stift-Kopplung (s. `Component.colorPenId`): ist sie gesetzt, wird `color`
    /// bei jedem Stiftsatz-Wechsel automatisch aus dem aktiven Stiftsatz neu
    /// geschrieben. Zeichnet ein Objekt „nach Ebene", übernimmt es dadurch den
    /// Stift dieser Ebene — bleibt aber selbst bei einer FREIEN Farbe, keinem
    /// eigenen Stift-Verweis (nur `color` wandert mit).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    /// Linienstärke in Millimetern.
    pub lw: f64,
    pub visible: bool,
    pub locked: bool,
    /// Optionale Standard-Schraffur der Kategorie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch: Option<String>,
    /// Unterkategorien (Baum).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub children: Option<Vec<LayerCategory>>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Quelle eines vererbbaren Attributs (Vordergrund/Hintergrund/Strichstärke/
/// Schraffur), wenn KEIN expliziter Wert am Element gesetzt ist:
///   • "layer"  — „Nach Ebene": die LayerCategory des Elements erzwingt den Wert
///     (`color`/`lw`/`hatch`).
///   • "object" — „Nach Bauteil": erbt vom Bauteil (Component) bzw. dessen
///     bisheriger Fallback-Kette (bei Wand/Decke u. a. die neutrale SIA-Poché-
///     Konvention, s. `resolveBackground`). Das ist auch der DEFAULT bei Wand/
///     Decke, wenn das Source-Feld fehlt (`undefined`) — bewusst NICHT „Nach
///     Ebene": eine frisch erzeugte Wand soll die neutrale Bauteil-Konvention
///     zeigen (weisser Grund, schwarzer Vordergrund), nicht die rohe
///     Ebenenfarbe.
/// Ein Drawing2D hat KEIN eigenes Bauteil — „Nach Bauteil" ist dort im
/// Attribut-Panel gar nicht erst wählbar, ein fehlendes Source-Feld wird dort
/// vom Aufrufer (`selectionInfo.ts`) auf „Nach Ebene" gemappt (die einzig
/// sinnvolle Alternative zum expliziten Wert bei einem bauteillosen Element).
/// Ein gesetzter expliziter Wert (z. B. `foreground`) gewinnt IMMER, unabhängig
/// von der Source (s. Resolve-Reihenfolge in `plan/generatePlan/shared.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum AttributeSource {
    #[default]
    #[serde(rename = "layer")]
    Layer,
    #[serde(rename = "object")]
    Object,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Lage der Wandachse (Referenzlinie) über die Dicke der Wand — analog
/// Vectorworks. Gemessen relativ zur Laufrichtung (start→end) mit der
/// leftNormal-Konvention `n = (-u.y, u.x)`:
///   • "center" — Achse mittig (Default = heutiges Verhalten).
///   • "left"   — Achse liegt auf der linken Wandfläche (+n-Seite, „außen").
///   • "right"  — Achse liegt auf der rechten Wandfläche (−n-Seite, „innen").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum WallReferenceLine {
    #[default]
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "center")]
    Center,
    #[serde(rename = "right")]
    Right,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Terminierungs-Regel einer Wand am Deckenanschluss (siehe {@link Wall.sliceTermination}).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SliceTermination {
    #[default]
    #[serde(rename = "both")]
    Both,
    #[serde(rename = "below")]
    Below,
    #[serde(rename = "above")]
    Above,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Eine Wand, definiert über ihre Achse (Centerline) und ihren Typ.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Wall {
    pub id: String,
    #[ts(type = "\"wall\"")]
    pub r#type: String,
    /// Zugehörige Zeichnungsebene (Geschoss).
    #[serde(rename = "floorId")]
    pub floor_id: String,
    /// Grafik-Kategorie (Ebene), z. B. "20" für Wände.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre: gesperrte Elemente lassen sich nicht anwählen (daher
    ///  auch nicht verschieben/bearbeiten/löschen) — anders als der Ebenen-/
    ///  Geschoss-Sperrmodus (`DisplayMode`) ist das hier persistiert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Achs-Startpunkt im Grundriss (Meter).
    pub start: Vec2,
    /// Achs-Endpunkt im Grundriss (Meter).
    pub end: Vec2,
    /// Verweis auf den (mehrschichtigen) Wandtyp.
    #[serde(rename = "wallTypeId")]
    pub wall_type_id: String,
    /// Wandhöhe in Metern.
    pub height: f64,
    /// Optionale Übersteuerung der Strich-/Umrandungsfarbe der Wand; sonst gilt
    /// die Kategorie-Farbe. Übersteuert NUR die Linienfarbe (Umriss/Schichtfugen),
    /// nicht die Schicht-Füllfarben/Schraffuren.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    /// Attribut-Override der Muster-/Schraffurfarbe (Vordergrund) DIESER Wand-
    /// Instanz. `undefined` = „Nach System" (erben → Component.foreground →
    /// HatchStyle.color-Fallback). Höchste Priorität in der Farb-Resolve-Kette.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground: Option<String>,
    /// Attribut-Override der Füllfarbe (Hintergrund/Poché) DIESER Wand-Instanz.
    /// `undefined` = „Nach System" (erben → Component.background → Component.color).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background: Option<String>,
    /// Stift-Kopplung von `foreground` (s. `Component.foregroundPenId`-Doku).
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_pen_id: Option<String>,
    /// Stift-Kopplung von `background`, analog {@link Wall.foregroundPenId}.
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_pen_id: Option<String>,
    /// Attribut-Override der Strichstärke (mm Papier) DIESER Wand-Instanz (Umriss/
    /// Schichtfugen). `undefined` = „Nach System" (erben → `strokeWeightSource`).
    #[serde(rename = "strokeWeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke_weight: Option<f64>,
    /// Attribut-Override der Schnitt-Schraffur (Hatch Manager) DIESER Wand-Instanz;
    /// überschreibt die Schraffur ALLER Schichten einheitlich. `undefined` =
    /// „Nach System" (erben → `hatchSource`).
    #[serde(rename = "hatchId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_id: Option<String>,
    /// Quelle des Vordergrunds, wenn kein expliziter `foreground`-Wert gesetzt ist:
    /// "layer" erzwingt die Ebenenfarbe (LayerCategory.color), "object"/`undefined`
    /// (Default) erbt vom Bauteil (heutiges Verhalten).
    #[serde(rename = "foregroundSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_source: Option<AttributeSource>,
    /// Quelle des Hintergrunds, analog zu {@link Wall.foregroundSource}.
    #[serde(rename = "backgroundSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_source: Option<AttributeSource>,
    /// Quelle der Strichstärke, wenn kein explizites `strokeWeight` gesetzt ist:
    /// "layer" erzwingt `LayerCategory.lw`, "object"/`undefined` (Default) fällt auf
    /// die bisherige Kategorie-/Fallback-Strichstärke zurück (heutiges Verhalten).
    #[serde(rename = "strokeWeightSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke_weight_source: Option<AttributeSource>,
    /// Quelle der Schraffur, wenn kein explizites `hatchId` gesetzt ist: "layer"
    /// erzwingt `LayerCategory.hatch`, "object"/`undefined` (Default) erbt vom
    /// Bauteil (heutiges Verhalten).
    #[serde(rename = "hatchSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_source: Option<AttributeSource>,
    /// Lage der Wandachse über die Dicke. Fehlt sie, gilt "center" (= heutiges
    /// Verhalten: Schichten symmetrisch −T/2 … +T/2 um die Achse).
    #[serde(rename = "referenceLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference_line: Option<WallReferenceLine>,
    /// Freier Referenz-Versatz der Achse entlang der +n-Normalen von der Wandmitte
    /// (Meter). Ist er gesetzt, ÜBERSTEUERT er {@link referenceLine} — genutzt, um
    /// bei mehrschichtigen Wänden eine SCHICHTTRENNLINIE (Fuge zwischen zwei
    /// Schichten) als Referenzlinie zu wählen. +T/2 = Aussenfläche, 0 = Mitte,
    /// −T/2 = Innenfläche; ein interner Fugenwert liegt dazwischen.
    #[serde(rename = "referenceOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference_offset: Option<f64>,
    /// Vertikale Bindung der Unterkante (UK). Fehlt sie, sitzt die UK auf der
    /// baseElevation des zugehörigen Geschosses (= heutiges Verhalten).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bottom: Option<VerticalAnchor>,
    /// Vertikale Bindung der Oberkante (OK). Fehlt sie, ergibt sich die OK aus
    /// UK + `height` (= heutiges Verhalten). „custom" setzt einen absoluten
    /// Z-Wert; „floor" bindet die OK an ein (z. B. nächsthöheres) Geschoss.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub top: Option<VerticalAnchor>,
    /// TERMINIERUNGS-Regel am horizontalen Deckenanschluss (Zuschnitt, NICHT
    /// Priorität — bewusst getrennt von `Component.joinPriority`/der Schnitt-
    /// Boolean-Dominanz gehalten). Steuert, ob ein Wandband, das eine dominante
    /// Deckenschicht durchstösst, oberhalb der Decke „wieder auftaucht":
    ///   • `undefined`/"both" — heutiges Verhalten: die dominante Deckenschicht
    ///     stanzt nur ihr z-Band aus, das Wandband bleibt oben UND unten erhalten.
    ///   • "below" — die Wand ENDET an der Decke: nur der Teil UNTER dem höchst-
    ///     gelegenen dominanten Cut bleibt (Regelfall, Wand steigt von unten in die
    ///     Decke). Der oberhalb der Decke stehende Rest wird verworfen.
    ///   • "above" — spiegelbildlich: nur der Teil ÜBER dem tiefsten dominanten Cut
    ///     bleibt (Brüstung/Attika, die von oben an die Decke stösst).
    /// Additiv; Alt-Projekte laden unverändert (Default = "both").
    #[serde(rename = "sliceTermination", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slice_termination: Option<SliceTermination>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine Decke (Slab) — ein geschossgebundenes, mehrschichtiges Flächenbauteil,
/// definiert über einen GESCHLOSSENEN Umriss (Polygon) im Grundriss und eine
/// Dicke. Analog zur Wand trägt sie ihren Schichtaufbau über einen `wallTypeId`
/// (die Bauteil-/Schraffur-/Materialauflösung ist identisch); eine optionale
/// `thickness` übersteuert die Gesamtdicke des Typs (Meter).
///
/// Vertikale Lage: die OBERKANTE (OK) der Decke. Fehlt `top`, liegt die OK an der
/// Oberkante des Geschosses (baseElevation + floorHeight — also bündig mit dem
/// Wandkopf); die Decke wächst um `thickness` nach UNTEN. `top: custom` setzt eine
/// absolute Z-Höhe, `top: floor` bindet die OK an ein Geschoss. Optional übersteuert
/// `bottom` die UNTERKANTE (UK) direkt (analog zur Wand); fehlt `bottom`, bleibt es
/// beim heutigen Verhalten UK = OK − `thickness`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Ceiling {
    pub id: String,
    #[ts(type = "\"ceiling\"")]
    pub r#type: String,
    /// Zugehörige Zeichnungsebene (Geschoss).
    #[serde(rename = "floorId")]
    pub floor_id: String,
    /// Grafik-Kategorie (Ebene), z. B. "30" für Decken.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Geschlossener Umriss im Grundriss (Meter). Der Schlusspunkt wird NICHT
    /// dupliziert (die letzte Kante läuft von outline[n-1] zu outline[0]).
    pub outline: Vec<Vec2>,
    /// Aussparungen (Löcher) im Grundriss (Meter): je Loch ein geschlossener
    /// Umriss (Schlusspunkt nicht dupliziert), VOLLSTÄNDIG innerhalb von
    /// {@link outline} — Treppenauge, Schacht, Kamindurchbruch. Wirkt in 2D
    /// (Poché-Loch + Randlinien) und 3D (Loch im Slab). Fehlt/leer ⇒ Volldecke.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub openings: Option<Vec<Vec<Vec2>>>,
    /// LEGACY-Verweis auf einen Aufbau-Typ aus `wallTypes` (Rückwärtskompatibilität
    /// für Projekte von vor den dedizierten Deckenstilen). Nur wirksam, wenn
    /// `ceilingTypeId` fehlt.
    #[serde(rename = "wallTypeId")]
    pub wall_type_id: String,
    /// Verweis auf einen dedizierten Deckentyp (Deckenstil) aus `ceilingTypes` —
    /// der reguläre Weg für SOLID (1 Schicht) und MEHRSCHICHTIG (>1 Schicht). Hat
    /// Vorrang vor `wallTypeId`, falls gesetzt und im Projekt auflösbar.
    #[serde(rename = "ceilingTypeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ceiling_type_id: Option<String>,
    /// Optionale Übersteuerung der Gesamtdicke in Metern (sonst Typ-Dicke).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thickness: Option<f64>,
    /// Optionale Übersteuerung der Strich-/Umrandungsfarbe; sonst gilt die
    /// Kategorie-Farbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    /// Attribut-Override der Muster-/Schraffurfarbe (Vordergrund) DIESER Decken-
    /// Instanz. `undefined` = „Nach System" (erben → Component.foreground →
    /// HatchStyle.color-Fallback).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground: Option<String>,
    /// Attribut-Override der Füllfarbe (Hintergrund/Poché) DIESER Decken-Instanz.
    /// `undefined` = „Nach System" (erben → Component.background → Component.color).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background: Option<String>,
    /// Stift-Kopplung von `foreground` (s. `Component.foregroundPenId`-Doku).
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_pen_id: Option<String>,
    /// Stift-Kopplung von `background`, analog {@link Wall.foregroundPenId}.
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_pen_id: Option<String>,
    /// Attribut-Override der Strichstärke (mm Papier) DIESER Decken-Instanz.
    /// `undefined` = „Nach System" (erben → `strokeWeightSource`).
    #[serde(rename = "strokeWeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke_weight: Option<f64>,
    /// Attribut-Override der Schraffur (Hatch Manager) DIESER Decken-Instanz;
    /// überschreibt sowohl die Schnitt- als auch die Ansichts-Schraffur des
    /// Bauteils. `undefined` = „Nach System" (erben → `hatchSource`).
    #[serde(rename = "hatchId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_id: Option<String>,
    /// Quelle des Vordergrunds, analog zu {@link Wall.foregroundSource}.
    #[serde(rename = "foregroundSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_source: Option<AttributeSource>,
    /// Quelle des Hintergrunds, analog zu {@link Wall.backgroundSource}.
    #[serde(rename = "backgroundSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_source: Option<AttributeSource>,
    /// Quelle der Strichstärke, analog zu {@link Wall.strokeWeightSource}.
    #[serde(rename = "strokeWeightSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke_weight_source: Option<AttributeSource>,
    /// Quelle der Schraffur, analog zu {@link Wall.hatchSource}.
    #[serde(rename = "hatchSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_source: Option<AttributeSource>,
    /// Vertikale Bindung der OBERKANTE (OK). Fehlt sie, sitzt die OK an der
    /// Oberkante des Geschosses (baseElevation + floorHeight).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub top: Option<VerticalAnchor>,
    /// Vertikale Bindung der UNTERKANTE (UK). Fehlt sie, ergibt sich die UK aus
    /// OK − `thickness` (= heutiges Verhalten). „custom" setzt einen absoluten
    /// Z-Wert; „floor" bindet die UK an ein Geschoss.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bottom: Option<VerticalAnchor>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── Dach ────────────────────────────────────────────────────────────────────

/// Dachform (analog DOSSIER-Rhino):
///  • "flach"    — Flachdach (waagrechte Fläche auf Traufhöhe).
///  • "pult"     — Pultdach (eine geneigte Fläche, First an EINER Traufseite).
///  • "sattel"   — Satteldach (First mittig, zwei Flächen, Giebel an den Enden).
///  • "walm"     — Walmdach (allseitig geneigt, First verkürzt, vier Flächen).
///  • "mansarde" — Mansarddach (Sattel mit Knick: steile untere + flache obere Neigung).
///  • "zelt"     — Zeltdach (allseitig zur Spitze, First-Länge 0, Pyramide).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum RoofShape {
    #[default]
    #[serde(rename = "flach")]
    Flach,
    #[serde(rename = "pult")]
    Pult,
    #[serde(rename = "sattel")]
    Sattel,
    #[serde(rename = "walm")]
    Walm,
    #[serde(rename = "mansarde")]
    Mansarde,
    #[serde(rename = "zelt")]
    Zelt,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum RoofMansardType {
    #[default]
    #[serde(rename = "giebel")]
    Giebel,
    #[serde(rename = "walm")]
    Walm,
    #[serde(rename = "zelt")]
    Zelt,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum RoofRidgeAxis {
    #[default]
    #[serde(rename = "x")]
    X,
    #[serde(rename = "y")]
    Y,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ein Dach über einem (rechteckigen) Grundriss-Umriss. Die Geometrie rechnet auf
/// der Bounding-Box des Umrisses (die gängige, intuitive Vereinfachung — First
/// entlang einer Hauptachse); der Umriss selbst wird beim Zeichnen als Rechteck
/// angelegt. Die Traufhöhe (`baseElevation`) ist die Unterkante der Dachfläche;
/// darüber steigt das Dach je nach Form/Neigung auf.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Roof {
    pub id: String,
    #[ts(type = "\"roof\"")]
    pub r#type: String,
    /// Zugehörige Zeichnungsebene (Geschoss).
    #[serde(rename = "floorId")]
    pub floor_id: String,
    /// Grafik-Kategorie (Ebene), z. B. "35" für Dächer.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Geschlossener Grundriss-Umriss (Meter); Geometrie nutzt die Bounding-Box.
    pub outline: Vec<Vec2>,
    /// Innenhöfe/Lichthöfe als Ringe (Meter, jeder Ring geschlossen, Drehsinn egal). Das Dach
    /// ist an dieser Stelle ausgespart (3D, Grundriss, Schnitt, Ansicht, IFC); die Hofkanten sind
    /// innere Traufen. Wirkt bei Flach/Sattel/Walm/Mansarde/Zelt (Pult ignoriert sie); ein Ring,
    /// der nicht ganz im Umriss liegt oder sich mit Umriss/anderen Höfen schneidet, macht die
    /// Höfe wirkungslos (Dach wie ohne). Fehlt ⇒ keine Höfe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub holes: Option<Vec<Vec<Vec2>>>,
    /// Neigung je Umrisskante in Grad. Nummerierung: erst die Kanten von `outline` (Kante i =
    /// Punkt i → i+1, in der gespeicherten Reihenfolge), danach die Kanten der `holes` Ring für
    /// Ring. Eintrag `null` = Giebel (senkrechte Wand, Kante läuft nicht nach innen), eine Zahl
    /// ≥ 0 = Neigung dieser Kante (übersteuert `pitchDeg`), eine NEGATIVE Zahl (oder ein fehlender
    /// Eintrag) = Standard: `pitchDeg`, bei Satteldach/Mansard-Satteldach mit Giebel an den
    /// Kanten quer zur Firstrichtung. Fehlt das Feld ganz ⇒ alles Standard (wie bisher).
    /// Wirkt bei Sattel/Walm/Mansarde/Zelt (Flach/Pult ignorieren es).
    #[serde(rename = "edgePitchDeg", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub edge_pitch_deg: Option<Vec<Option<f64>>>,
    /// Dachform.
    pub shape: RoofShape,
    /// Hauptneigung in Grad (0 = flach).
    #[serde(rename = "pitchDeg")]
    pub pitch_deg: f64,
    /// Nur Mansarde: obere (flachere) Neigung in Grad; fehlt ⇒ halbe Hauptneigung.
    #[serde(rename = "pitchUpperDeg", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pitch_upper_deg: Option<f64>,
    /// Nur Mansarde: Untertyp der Mansardform. "giebel" = Mansard-Satteldach
    /// (steile untere + flache obere Neigung nur an zwei Seiten, Giebel an den
    /// Enden — Default), "walm" = Mansard-Walmdach (allseitige Mansarde, auch die
    /// Stirnseiten geknickt, kein Giebel), "zelt" = Mansard-Zeltdach (allseitig
    /// zur Spitze, geknickt). Fehlt ⇒ "giebel".
    #[serde(rename = "mansardType", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub mansard_type: Option<RoofMansardType>,
    /// Nur Mansarde: Lage der Knicklinie als Anteil der halben Spannweite (0..0.5),
    /// gemessen von der Traufe. Kleiner ⇒ steiler Sockel kürzer; fehlt ⇒ 0.4.
    #[serde(rename = "mansardKneeRatio", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mansard_knee_ratio: Option<f64>,
    /// Nur Satteldach: Krüppelwalm. Anteil der Firsthöhe (0..0.9), der an BEIDEN Giebeln
    /// abgewalmt wird — 0/fehlt = voller Giebel, 0.3 = oberes Drittel als kleine Walmflächen.
    #[serde(rename = "halfHipRatio", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub half_hip_ratio: Option<f64>,
    /// Dachüberstand an der TRAUFE (Meter, senkrecht zum First); 0 = bündig.
    pub overhang: f64,
    /// Dachüberstand am ORTGANG (Giebelseite, entlang des Firsts, Meter). Fehlt ⇒
    /// gleich dem Traufüberstand {@link overhang} (rückwärtskompatibel = ringsum).
    #[serde(rename = "overhangGable", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub overhang_gable: Option<f64>,
    /// Firstrichtung (Sattel/Walm/Mansarde/Pult): entlang der X- oder Y-Achse.
    #[serde(rename = "ridgeAxis")]
    #[ts(inline)]
    pub ridge_axis: RoofRidgeAxis,
    /// Traufhöhe (absolutes Z, Meter); fehlt ⇒ Oberkante des Geschosses.
    #[serde(rename = "baseElevation", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_elevation: Option<f64>,
    /// Dachdicke (Meter, senkrecht zur Fläche) — Fallback/Override. Ohne
    /// {@link roofTypeId} ist es die einschichtige Gesamtdicke; mit `roofTypeId`
    /// bleibt es als reiner Fallback bestehen (die Schichtsumme des Typs gilt).
    pub thickness: f64,
    /// Verweis auf einen Dachtyp (Dachaufbau) aus `Project.roofTypes` — mehrschichtig
    /// (Eindeckung/Lattung/Dämmung/Verkleidung), analog `Ceiling.ceilingTypeId`.
    /// Fehlt er, gilt die einschichtige {@link thickness}.
    #[serde(rename = "roofTypeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub roof_type_id: Option<String>,
    /// Optionale Übersteuerung der Strich-/Umrissfarbe; sonst Kategorie-Farbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ElementKind {
    #[default]
    #[serde(rename = "window")]
    Window,
    #[serde(rename = "door")]
    Door,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OpeningDoorType {
    #[default]
    #[serde(rename = "normal")]
    Normal,
    #[serde(rename = "wandoeffnung")]
    Wandoeffnung,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OpeningHinge {
    #[default]
    #[serde(rename = "start")]
    Start,
    #[serde(rename = "end")]
    End,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Schwenkrichtung der Tür relativ zur Wandachse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SwingSide {
    #[default]
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OpeningOpeningDir {
    #[default]
    #[serde(rename = "in")]
    In,
    #[serde(rename = "out")]
    Out,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OpeningLintelLines {
    #[default]
    #[serde(rename = "keine")]
    Keine,
    #[serde(rename = "innen")]
    Innen,
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "beide")]
    Beide,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Detailgrad der Darstellung (≙ DOSSIER Einfach/Standard/Detail). Wirkt im
/// Grundriss auf Tür-/Fenstersymbole + Schraffuren/Linienfeinheit (siehe
/// generatePlan.DetailLevel); in der Perspektive noch ohne Wirkung (deferred).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum DetailLevel {
    #[default]
    #[serde(rename = "grob")]
    Grob,
    #[serde(rename = "mittel")]
    Mittel,
    #[serde(rename = "fein")]
    Fein,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Optionale Farb-/Strichstärke-Übersteuerung einer Linien-Kategorie im Grundriss.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LineStyleOverride {
    /// Strichfarbe (Hex); fehlt ⇒ System-Default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Strichstärke in mm Papier; fehlt ⇒ System-Default (Haarlinie).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub weight: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine Öffnung (Fenster oder Tür), gehostet in einer Wand. Sie „kennt" ihre Wand
/// (`hostWallId`) und liegt über `position` (Abstand vom Wand-Startpunkt entlang
/// der Achse) relativ zur Wand — bewegt sich die Wand, folgt die Öffnung, weil die
/// Weltkoordinaten beim Rendern IMMER aus der Wandachse abgeleitet werden.
///
/// Vertikale Lage (relativ zur Wand-Unterkante, UK):
///   • Tür    — sitzt am Boden, `sillHeight` = 0, Höhe = lichte Türhöhe.
///   • Fenster— Brüstung `sillHeight` > 0, Öffnung reicht von sillHeight bis
///     sillHeight + height.
///
/// Türspezifisch: `hinge` (Anschlagpfosten) + `swing` (Aufschlagseite) + optional
/// `swingAngle` (Öffnungswinkel des Blatts in Grad, Default 90) + `openingDir`
/// (Aufschlag nach innen/außen — kippt den Schwenkbogen auf die andere Achsseite).
/// Fenster nutzen optional `frameDepth`/`frameThickness` für die 3D-Rahmenstärke.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Opening {
    pub id: String,
    #[ts(type = "\"opening\"")]
    pub r#type: String,
    /// Wirts-Wand; das Geschoss ergibt sich aus der Wand.
    #[serde(rename = "hostWallId")]
    pub host_wall_id: String,
    /// Grafik-Kategorie (Ebene), z. B. "21" für Türen/Fenster.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Fenster oder Tür.
    #[ts(inline)]
    pub kind: ElementKind,
    /// Abstand des ersten Pfostens vom Wand-Startpunkt entlang der Achse (Meter).
    pub position: f64,
    /// Lichte Öffnungsbreite in Metern.
    pub width: f64,
    /// Lichte Öffnungshöhe in Metern.
    pub height: f64,
    /// Brüstungshöhe (Unterkante der Öffnung) über der Wand-UK; 0 bei Türen.
    #[serde(rename = "sillHeight")]
    pub sill_height: f64,
    /// Nur Fenster: Anzahl der Flügel (1–4). Bei > 1 werden im Plan `wingCount − 1`
    /// Mittelpfosten (Querlinien quer zur Öffnungsrichtung) gleichmäßig innerhalb des
    /// Rahmens gezeichnet — analog den Mittelpfosten in `_make_oeffnung_pieces` des
    /// Rhino-Plugins (`oeff_fluegel`). Fehlt es, gilt 1 (= heutiges Verhalten: keine
    /// Pfosten).
    #[serde(rename = "wingCount", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wing_count: Option<f64>,
    /// Nur Tür: Tür-Typ (analog `oeff_tuer_typ` im Rhino-Plugin).
    ///   • "normal"       — Türblatt + Schwenkbogen (Default = heutiges Verhalten).
    ///   • "wandoeffnung" — reiner Wanddurchbruch: KEIN Türblatt, KEIN Schwenkbogen;
    ///     nur die Öffnung/Laibung (Wandlücke + ggf. Sturz-/Anschlaglinien) bleibt.
    /// Fehlt es, gilt "normal".
    #[serde(rename = "doorType", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub door_type: Option<OpeningDoorType>,
    /// Nur Tür: an welchem Pfosten das Scharnier sitzt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub hinge: Option<OpeningHinge>,
    /// Nur Tür: auf welche Seite der Wandachse das Blatt aufschlägt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub swing: Option<SwingSide>,
    /// Nur Tür: Öffnungswinkel des Blatts in Grad (Default 90).
    #[serde(rename = "swingAngle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub swing_angle: Option<f64>,
    /// Nur Tür: Aufschlagrichtung (nach innen/außen); Default "in".
    #[serde(rename = "openingDir", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub opening_dir: Option<OpeningOpeningDir>,
    /// Optionale Rahmenstärke (quer zur Wand) in Metern für die 3D-Darstellung.
    #[serde(rename = "frameThickness", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_thickness: Option<f64>,
    /// Nur Tür: Sturzlinien (SIA, gestrichelt) quer über die Öffnung an der Wand-
    /// Innen- und/oder Aussenkante. Zeigt die Überkopf-Projektion des Sturzes.
    ///   "keine" → keine Sturzlinien
    ///   "innen" → eine Linie an der Wand-Innenkante
    ///   "aussen"→ eine Linie an der Wand-Aussenkante
    ///   "beide" → beide Linien (Default wenn nicht gesetzt)
    #[serde(rename = "lintelLines", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub lintel_lines: Option<OpeningLintelLines>,
    /// Referenz auf einen Bauteil-Typ (Bibliothek): {@link DoorType} bei
    /// `kind: "door"`, {@link WindowType} bei `kind: "window"`. Fehlt sie, gilt
    /// das heutige Inline-Verhalten (rückwärtskompatibel). Typ-Defaults liefern
    /// Bauart/Rahmen/Verglasung; Element-Felder (Breite/Höhe/…) übersteuern.
    #[serde(rename = "typeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub type_id: Option<String>,
    /// Optionale per-Element-Übersteuerung der Detailstufe (grob/normal/
    /// detailliert); fehlt sie, gilt die Ansichts-/Projekt-Detailstufe.
    #[serde(rename = "detailLevel", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail_level: Option<DetailLevel>,
    /// Optionale Übersteuerung der Strich-/Symbolfarbe; sonst gilt die
    /// Kategorie-Farbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    /// Nur Fenster, Grundriss: Übersteuerung von Farbe/Strichstärke der
    /// GESCHNITTENEN Blendrahmen-Querschnittsblöcke an den Laibungs-Enden
    /// ({@link LineStyleOverride}, entspricht `windowSymbol.jambMarks` — die
    /// Schnittfläche des Rahmenmaterials an der Wand-Laibung). `undefined` ⇒
    /// {@link Opening.color}, sonst Kategorie-Farbe/Haarlinie. Separat von
    /// {@link frameViewLine} (die durchlaufende Rahmen-Kontur in Aufsicht).
    #[serde(rename = "frameLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_line: Option<LineStyleOverride>,
    /// Nur Fenster, Grundriss: Übersteuerung von Farbe/Strichstärke der
    /// durchlaufenden Blendrahmen-KONTUR in Aufsicht (das Rechteck aus
    /// `windowSymbol.frame` — die beiden Linien zwischen den geschnittenen
    /// Laibungs-/Stulp-Blöcken, NICHT geschnitten, sondern von oben/unten
    /// projiziert). `undefined` ⇒ fällt auf {@link frameLine} zurück (bisheriges
    /// Verhalten: eine gemeinsame Farbe/Stärke für Schnitt UND Aufsicht).
    #[serde(rename = "frameViewLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_view_line: Option<LineStyleOverride>,
    /// Nur Fenster, Grundriss: Übersteuerung von Farbe/Strichstärke des
    /// Flügelrahmens/der Sprossen (window-sash/window-mullion).
    #[serde(rename = "sashLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sash_line: Option<LineStyleOverride>,
    /// Nur Fenster, Grundriss: Übersteuerung von Farbe/Strichstärke der Auf-/
    /// Untersicht-Andeutung ({@link WindowType.sillLine}); nur wirksam, wenn der
    /// Fenstertyp dort eine Sims-Linie aktiviert hat.
    #[serde(rename = "sillLineStyle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sill_line_style: Option<LineStyleOverride>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Grundform einer Treppe (DOSSIER: gerade / L / Wendel).
///   • "straight" — ein gerader Lauf (Lauflinie = Start → Richtung).
///   • "L"        — zwei rechtwinklige Läufe mit Zwischenpodest an der Ecke.
///   • "spiral"   — Wendeltreppe um ein Zentrum (keilförmige Tritte).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum StairShape {
    #[default]
    #[serde(rename = "straight")]
    Straight,
    #[serde(rename = "L")]
    L,
    #[serde(rename = "spiral")]
    Spiral,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum StairReferenz {
    #[default]
    #[serde(rename = "links")]
    Links,
    #[serde(rename = "mitte")]
    Mitte,
    #[serde(rename = "rechts")]
    Rechts,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum StairArrowStyle {
    #[default]
    #[serde(rename = "line")]
    Line,
    #[serde(rename = "filled")]
    Filled,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Eine Treppe (Treppe/Stair) — ein geschossübergreifendes Bauteil, das über die
/// Geschosshöhe (OKFF → OKFF des nächsten Geschosses) steigt. Definiert über eine
/// Grundform (gerade / L / Wendel), eine Basis-Geometrie, die Laufbreite und die
/// Stufung (Steigungshöhe/Auftrittstiefe, aus der Stufenanzahl abgeleitet).
///
/// Basis-Geometrie je Grundform:
///   • straight — `start` + `dir` (Einheitsrichtung) + `runLength` (Lauflänge).
///   • L        — `start` + `dir` (erster Lauf) + `runLength` (erster Lauf) +
///     `run2Length` (zweiter Lauf) + `turn` (+1 = links, −1 = rechts abbiegen).
///     Das Zwischenpodest sitzt am Ende des ersten Laufs (quadratisch, `width`).
///   • spiral   — `center` + `radius` (Innenradius zur Lauflinie) + `sweep`
///     (Gesamtwinkel in Grad, +/− = Drehrichtung) + `start` (Startpunkt des ersten
///     Tritts am äußeren Rand, definiert die Anfangsrichtung).
///
/// Vertikale Lage: die UNTERKANTE (`baseZ`, abgeleitet aus dem Geschoss-OKFF) plus
/// `totalRise` (Default = Geschosshöhe des zugehörigen Geschosses, sodass die
/// Treppe genau ins nächste Geschoss steigt). `stepCount` Tritte/Setzstufen
/// verteilen `totalRise` gleichmäßig; die Steigungshöhe = totalRise/stepCount, die
/// Auftrittstiefe ergibt sich aus Lauflänge/(stepCount−1). Eine SIA-nahe
/// Schrittregel (2·Steigung + Auftritt ≈ 0.63 m) liefert die Default-Stufenzahl.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Stair {
    pub id: String,
    #[ts(type = "\"stair\"")]
    pub r#type: String,
    /// Zugehörige Zeichnungsebene (Geschoss), von dem die Treppe aufsteigt.
    #[serde(rename = "floorId")]
    pub floor_id: String,
    /// Grafik-Kategorie (Ebene), z. B. "40" für Treppen.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Grundform (gerade / L / Wendel).
    pub shape: StairShape,
    /// Startpunkt der Lauflinie im Grundriss (Meter).
    pub start: Vec2,
    /// Einheits-Laufrichtung des (ersten) Laufs im Grundriss.
    pub dir: Vec2,
    /// Lauflänge des (ersten) Laufs in Metern (entlang `dir`).
    #[serde(rename = "runLength")]
    pub run_length: f64,
    /// Nur L: Lauflänge des zweiten Laufs in Metern.
    #[serde(rename = "run2Length", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run2_length: Option<f64>,
    /// Nur L: Abbiegerichtung des zweiten Laufs (+1 = links, −1 = rechts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "1 | -1")]
    pub turn: Option<f64>,
    /// Nur Wendel: Zentrum der Wendeltreppe (Meter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub center: Option<Vec2>,
    /// Nur Wendel: Radius (Meter) von der Mitte zur Lauflinie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub radius: Option<f64>,
    /// Nur Wendel: Gesamt-Drehwinkel in Grad (+ = CCW, − = CW).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sweep: Option<f64>,
    /// Laufbreite in Metern (quer zur Laufrichtung).
    pub width: f64,
    /// Lage der gespeicherten Achse (`start`/`dir` bzw. Wendel-Bogen) über die
    /// Laufbreite — analog `treppe_referenz` im Rhino-Plugin. Bestimmt, ob die Achse
    /// die LINKE, MITTLERE oder RECHTE Kante der Treppe repräsentiert (in
    /// Laufrichtung gesehen). Fehlt sie, gilt "mitte" (= heutiges Verhalten: Achse =
    /// Treppen-Mitte).
    ///   • "links"  — Achse = linke Kante; die Treppe liegt rechts der Achse.
    ///   • "mitte"  — Achse = Mitte (Default).
    ///   • "rechts" — Achse = rechte Kante; die Treppe liegt links der Achse.
    /// Die Lauflinie samt Pfeil bleibt IMMER auf der visuellen Treppen-Mitte
    /// (nicht auf der Referenzkante) — siehe `stairGeometry`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub referenz: Option<StairReferenz>,
    /// Gesamt-Steighöhe in Metern (OKFF → OKFF nächstes Geschoss). Fehlt sie, gilt
    /// beim Auflösen die Geschosshöhe des zugehörigen Geschosses.
    #[serde(rename = "totalRise", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total_rise: Option<f64>,
    /// Anzahl der Steigungen (Setzstufen). Die Trittanzahl = stepCount (letzte =
    ///  Austritt aufs obere Geschoss). Steigungshöhe = totalRise / stepCount.
    #[serde(rename = "stepCount")]
    pub step_count: f64,
    /// Laufrichtung „aufwärts": true = die Lauflinie steigt von `start` in Richtung
    /// `dir` (Default). false kehrt Auf-/Abpfeil um (Treppe steigt zum Start hin).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub up: Option<bool>,
    /// Referenz auf einen {@link StairType} (Bibliothek). Fehlt sie, gilt das
    /// heutige Inline-Verhalten (rückwärtskompatibel). Typ-Defaults liefern
    /// Tragart/Stufenausbildung/Geländer; Element-Felder übersteuern.
    #[serde(rename = "typeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub type_id: Option<String>,
    /// Optionale per-Element-Übersteuerung der Detailstufe (grob/normal/
    /// detailliert); fehlt sie, gilt die Ansichts-/Projekt-Detailstufe.
    #[serde(rename = "detailLevel", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail_level: Option<DetailLevel>,
    /// Optionale Übersteuerung der Strich-/Umrandungsfarbe; sonst gilt die
    /// Kategorie-Farbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    /// Darstellung des Auf-/Abpfeils an der Lauflinie: "line" (offener
    /// Winkelpfeil, Default = heutiges Verhalten) oder "filled" (gefülltes
    /// Dreieck als SIA-Vollpfeil). Fehlt sie, gilt "line".
    #[serde(rename = "arrowStyle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub arrow_style: Option<StairArrowStyle>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein zusammenhängender Textabschnitt mit einheitlicher Formatierung.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct TextRun {
    pub text: String,
    pub marks: Marks,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Absatz-Ausrichtung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum Align {
    #[default]
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "center")]
    Center,
    #[serde(rename = "right")]
    Right,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ein Absatz: eine Zeile aus Runs plus optionale Ausrichtung/Zeilenhöhe.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Paragraph {
    pub runs: Vec<TextRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub align: Option<Align>,
    /// Zeilenhöhe als Vielfaches der Basisgrösse (z. B. 1.3 = 130 %).
    #[serde(rename = "lineHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_height: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Das gesamte Rich-Text-Dokument.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct RichTextDoc {
    #[ts(type = "1")]
    pub version: f64,
    pub paragraphs: Vec<Paragraph>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Feldmodell des Raum-Stempels. Ersetzt den freien Text durch benannte Felder;
/// daraus baut roomStamp.ts sowohl das gerenderte Rich-Text-Dokument als auch die
/// Live-Zeilen. Minimal gehalten (MVP).
///
/// Folge-Arbeit: Fensterfläche (braucht Öffnung-in-Raum-Geometrie) — hier bewusst
/// NICHT enthalten.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct RoomStamp {
    /// Raumnummer (kleiner Präfix in Zeile 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub number: Option<String>,
    /// Raumname (Zeile 1).
    pub name: String,
    /// Raumname Zeile 2 (in Listen mit `name` zu einem Namen zusammengezogen).
    #[serde(rename = "nameLine2", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name_line2: Option<String>,
    /// Bodenfläche anzeigen (Live-Zeile).
    #[serde(rename = "showFloorArea")]
    pub show_floor_area: bool,
    /// Präfix vor der Bodenfläche, z. B. "BF " (Default leer).
    #[serde(rename = "floorAreaPrefix", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_area_prefix: Option<String>,
    /// Nutzung (HNF/… · Bezeichnung) anzeigen (Live-Zeile).
    #[serde(rename = "showUsage")]
    pub show_usage: bool,
    /// Ausrichtung der Namenszeile (Zeile 1). Fehlt sie, gilt „links".
    #[serde(rename = "nameAlign", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name_align: Option<Align>,
    /// Ausrichtung der zweiten Namenszeile. Fehlt sie, gilt „links".
    #[serde(rename = "line2Align", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line2_align: Option<Align>,
    /// Ausrichtung der Bodenflächen-Zeile. Fehlt sie, gilt „zentriert" (Alt-Verhalten).
    #[serde(rename = "floorAreaAlign", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_area_align: Option<Align>,
    /// Ausrichtung der Nutzungs-Zeile. Fehlt sie, gilt „zentriert" (Alt-Verhalten).
    #[serde(rename = "usageAlign", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usage_align: Option<Align>,
    /// Personenzahl (Live-Zeile), z. B. für Nutzungsauflagen. Fehlt/undefined:
    /// keine Personenzahl-Zeile (Alt-Verhalten).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub occupancy: Option<f64>,
    /// Rundungsschritt der angezeigten Bodenfläche in m² (z. B. 0.5 → auf halbe
    /// m² gerundet). Fehlt er, gilt das Alt-Verhalten: 2 Nachkommastellen ohne
    /// Schrittrundung.
    #[serde(rename = "roundingStep", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rounding_step: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Raum (Raum/Room) — eine SIA-416-Fläche auf einem Geschoss, definiert über
/// einen GESCHLOSSENEN Umriss (Polygon, lichte Innenkontur) im Grundriss. Trägt
/// eine SIA-416-Blatt-Kategorie (HNF/NNF/VF/FF/KGF), einen Namen und eine Farbe.
///
/// Fläche/Umfang/Schwerpunkt werden NICHT gespeichert, sondern bei jedem Rendern
/// aus `boundary` über den reinen Rechenkern (geometry/roomArea) abgeleitet —
/// so sind sie nie veraltet. `stampAnchor` (optional) setzt den Ankerpunkt des
/// Raum-Stempels; fehlt er, gilt der Flächenschwerpunkt (Centroid).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Room {
    pub id: String,
    #[ts(type = "\"room\"")]
    pub r#type: String,
    /// Zugehörige Zeichnungsebene (Geschoss).
    #[serde(rename = "floorId")]
    pub floor_id: String,
    /// Grafik-Kategorie (Ebene), z. B. "45" für Räume.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// SIA-416-Blatt-Kategorie (HNF/NNF/VF/FF/KGF).
    #[serde(rename = "siaCategory")]
    pub sia_category: SiaCategory,
    /// Raum-Name, z. B. „Wohnen".
    pub name: String,
    /// Geschlossener Umriss (lichte Innenkontur) im Grundriss (Meter). Der
    /// Schlusspunkt wird NICHT dupliziert (die letzte Kante läuft von boundary[n-1]
    /// zu boundary[0]).
    pub boundary: Vec<Vec2>,
    /// Strich-/Füllfarbe des Raums (hex).
    pub color: String,
    /// Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    /// Anker des Raum-Stempels (Meter). Wird bei der Erstellung EINMAL auf den
    /// Zentroid gesetzt und danach nie automatisch neu berechnet — der Stempel ist
    /// frei verschiebbar und bleibt beim Ändern der Kontur/Fläche an seiner Stelle.
    /// Fehlt er (Alt-Daten), gilt beim Rendern der Centroid.
    #[serde(rename = "stampAnchor", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stamp_anchor: Option<Vec2>,
    /// Frei editierbarer Rich-Text des Raum-Stempels (Name + Notizen, mit Fett/
    /// Kursiv/Grösse/Farbe/Ausrichtung). Fehlt er, gilt der Raum-Name als einfacher
    /// Text. Die LIVE-Flächenzeile wird beim Rendern separat darunter gesetzt.
    #[serde(rename = "stampDoc", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stamp_doc: Option<RichTextDoc>,
    /// Strukturierter Raum-Stempel (Feldmodell). Ist er gesetzt, hat er Vorrang vor
    /// `stampDoc`/`name`: der Stempel-Text wird aus den Feldern gebaut, die Live-
    /// Zeilen (Bodenfläche/Nutzung) aus den Flags. Fehlt er, gilt der Alt-Pfad.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stamp: Option<RoomStamp>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── Freie 2D-Zeichengeometrie (Drawing2D) ──────────────────────────────────
// Ein semantisches 2D-Element (wie Wall/Door), das beim Rendern abgeleitet wird
// (keine vorab erzeugten Plan-Primitive). Siehe docs/design/drawing-tools.md §7.

/// Geometrie-Form eines 2D-Zeichenelements.
///
/// Linienende (Pfeilspitze & Co.) an einer OFFENEN 2D-Form — in jedem CAD eine
/// Standard-Objekteigenschaft, vor allem für Beschriftungen. Rein grafisch,
/// kein Bezug auf andere Elemente.
///   • "none"      — offenes Ende (Default)
///   • "arrow"     — gefüllte Pfeilspitze (wie bisher fest am Leader)
///   • "arrowOpen" — offene Pfeilspitze (zwei Striche)
///   • "dot"       — gefüllter Punkt
///   • "tick"      — Schrägstrich (45°, wie der Massstrich der Bemassung)
///   • "square"    — gefülltes Quadrat
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum EndMark {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "arrow")]
    Arrow,
    #[serde(rename = "arrowOpen")]
    ArrowOpen,
    #[serde(rename = "dot")]
    Dot,
    #[serde(rename = "tick")]
    Tick,
    #[serde(rename = "square")]
    Square,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Drawing2DEndMarks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start: Option<EndMark>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub end: Option<EndMark>,
    #[serde(rename = "sizeMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size_mm: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein freies 2D-Zeichenelement auf einer Zeichnungsebene.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Drawing2D {
    pub id: String,
    #[ts(type = "\"drawing2d\"")]
    pub r#type: String,
    /// Zeichnungsebene (Geschoss ODER freie 2D-Ebene).
    #[serde(rename = "levelId")]
    pub level_id: String,
    /// Grafik-Kategorie (Ebene) — liefert Farbe/Strichstärke als Default.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Sichtbar am Bildschirm, aber von PDF-/SVG-/DXF-Export ausgeschlossen —
    /// wie eine „Non-Plotting"-Ebene, nur pro Objekt statt pro ganzer Ebene
    /// (z. B. für eine Konstruktions-/Hilfslinie, s. `xline`). Wirkt nur bei
    /// `generatePlan(..., forPrint: true)` (den drei Export-Aufrufstellen in
    /// `state/useExportHandlers.ts`) — die Bildschirmansicht ignoriert das Feld.
    #[serde(rename = "noPrint", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub no_print: Option<bool>,
    pub geom: Drawing2DGeom,
    /// Optionaler Linienstil (Line Manager); sonst Kategorie-Default.
    #[serde(rename = "lineStyleId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_style_id: Option<String>,
    /// Optionale Schraffur für geschlossene Formen (Hatch Manager).
    #[serde(rename = "hatchId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_id: Option<String>,
    /// Attribut-Override der Muster-/Schraffurfarbe (Vordergrund) DIESER 2D-Form.
    /// `undefined` = „Nach System" (erben → HatchStyle.color-Fallback). Betrifft die
    /// Farbe der Schraffur-Musterlinien einer gefüllten Fläche (nicht den Umriss,
    /// der über `color`/`lineStyleId` läuft).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground: Option<String>,
    /// Attribut-Override der Füllfarbe (Hintergrund) DIESER 2D-Form. `undefined` =
    /// „Nach System". Synonym/Nachfolger von `fillColor`; ist `background` gesetzt,
    /// hat es Vorrang vor `fillColor` (der Poché-Hintergrund der geschlossenen Form).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background: Option<String>,
    /// Stift-Kopplung von `foreground` (s. `Component.foregroundPenId`-Doku).
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_pen_id: Option<String>,
    /// Stift-Kopplung von `background`, analog {@link Wall.foregroundPenId}.
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_pen_id: Option<String>,
    /// Optionale explizite Strichfarbe; sonst Kategorie-Farbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    /// Massstab des Strichmusters DIESES Elements (multipliziert die Strich-/
    /// Lückenlängen des Linienstils; Default 1). Entspricht dem LTSCALE je Objekt
    /// in AutoCAD: dieselbe Strichlinie soll in 1:50 und 1:200 nicht gleich
    /// „dicht" wirken. Ohne Wert bleibt das Muster exakt wie im Linienstil.
    #[serde(rename = "dashScale", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dash_scale: Option<f64>,
    /// Platzierung der Schraffur AN DIESEM OBJEKT (alle optional). Die Ressource
    /// (`HatchStyle`) legt Muster/Massstab/Winkel grundsätzlich fest; hier lässt
    /// sich das je Objekt nachjustieren — in AutoCAD eine der meistgenutzten
    /// Objekteigenschaften, etwa damit ein Plattenraster an der Raumecke ansetzt
    /// statt am Weltnullpunkt.
    ///   • `hatchAngleDeg`  — ERSETZT den Winkel der Ressource (Grad)
    ///   • `hatchScale`     — MULTIPLIZIERT den Massstab der Ressource
    ///   • `hatchOrigin`    — Ankerpunkt des Musterrasters (Modellkoordinaten);
    ///                        ohne Angabe bleibt es der Modellursprung, damit
    ///                        benachbarte Flächen dieselbe Musterphase teilen.
    #[serde(rename = "hatchAngleDeg", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_angle_deg: Option<f64>,
    #[serde(rename = "hatchScale", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_scale: Option<f64>,
    #[serde(rename = "hatchOrigin", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_origin: Option<Vec2>,
    /// Objekt-Transparenz 0..1 (Default 1 = deckend) — wirkt auf Striche UND
    /// Füllungen dieses Elements. In Vectorworks/AutoCAD eine Standard-
    /// Objekteigenschaft (Bestand hinterlegen, Abbruch, durchscheinende
    /// Flächen). Der DXF-Export trägt sie nicht mit (bewusst, s. PENDENZEN.md).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub opacity: Option<f64>,
    /// Transparenz NUR der Füllung/Schraffurfläche 0..1 (Default 1 = deckend) —
    /// zusätzlich zu `opacity` (das Strich UND Füllung trifft). Der Umriss bleibt
    /// dabei deckend (z. B. durchscheinende Fläche mit kräftiger Kontur).
    #[serde(rename = "fillOpacity", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill_opacity: Option<f64>,
    /// Linienenden an OFFENEN Formen (Linie, offene Polylinie, Bogen, Spline,
    /// Bezier) sowie an der Hinweislinie eines Textes. `start`/`end` beziehen
    /// sich auf die Zeichenrichtung der Form; `sizeMm` ist die Grösse in
    /// PAPIER-MILLIMETERN (massstabsunabhängig, wie die Bemassungs-Feinheiten —
    /// s. `model/dimension.ts`), Default `END_MARK_DEFAULT_SIZE_MM`.
    /// Geschlossene Formen (Rechteck, Kreis, Ellipse, geschlossene Polylinie)
    /// haben keine Enden und ignorieren das Feld.
    #[serde(rename = "endMarks", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub end_marks: Option<Drawing2DEndMarks>,
    /// Optionale Vollton-Füllfarbe für geschlossene Formen (getrennt von der
    /// Strichfarbe `color`). Fehlt sie, ist die Fläche transparent (nur Schraffur
    /// bzw. ungefüllt).
    #[serde(rename = "fillColor", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill_color: Option<String>,
    /// Optionale direkte Strichstärke-Übersteuerung in Millimetern; hat Vorrang
    /// vor dem LineStyle-Gewicht und der Kategorie-Strichstärke.
    #[serde(rename = "weightMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub weight_mm: Option<f64>,
    /// Quelle des Vordergrunds (Schraffur-Musterfarbe), wenn kein explizites
    /// `foreground` gesetzt ist: "layer" erzwingt die Ebenenfarbe
    /// (LayerCategory.color), "object"/`undefined` (Default) = heutiges Verhalten
    /// (kein Bauteil-Bezug bei Drawing2D → HatchStyle.color-Fallback).
    #[serde(rename = "foregroundSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_source: Option<AttributeSource>,
    /// Quelle des Hintergrunds (Füllfarbe), analog zu `foregroundSource`.
    #[serde(rename = "backgroundSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_source: Option<AttributeSource>,
    /// Quelle der Strichstärke, wenn kein explizites `weightMm` gesetzt ist:
    /// "layer" erzwingt `LayerCategory.lw` (unter Umgehung des LineStyle-Gewichts),
    /// "object"/`undefined` (Default) = heutige Kette (LineStyle.weight ?? Kategorie).
    #[serde(rename = "strokeWeightSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke_weight_source: Option<AttributeSource>,
    /// Quelle der Schraffur, wenn kein explizites `hatchId` gesetzt ist: "layer"
    /// erzwingt `LayerCategory.hatch`, "object"/`undefined` (Default) = heutiges
    /// Verhalten (ohne `hatchId` keine Schraffur).
    #[serde(rename = "hatchSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_source: Option<AttributeSource>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ExtrudedSolidCircle {
    pub center: Vec2,
    pub r: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ExtrudedSolidBrep {
    #[ts(type = "Record<string, unknown>")]
    pub spec: std::collections::BTreeMap<String, serde_json::Value>,
    pub origin: Vec2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── Extrudierter Körper (truck-Integration, docs/design/truck-plan.md) ─────
// Ein per `extrude`-Befehl aus einem geschlossenen 2D-Profil (Polylinie-Ring/
// Rechteck) erzeugter 3D-Körper. Die eigentliche B-Rep-Extrusion (truck-WASM,
// `engine/truckSolid.ts`) läuft NICHT hier, sondern asynchron in
// `toWalls3d.ts` (emitExtrudedSolids) — dieser Typ hält nur die Rohdaten.

/// Ein extrudierter Körper: geschlossenes Profil (Modell-Meter) + Höhe.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ExtrudedSolid {
    pub id: String,
    #[ts(type = "\"extrudedSolid\"")]
    pub r#type: String,
    /// Geschoss, dessen `baseElevation` die UK des Körpers bestimmt.
    #[serde(rename = "levelId")]
    pub level_id: String,
    /// Geschlossenes Profil in der XY-Ebene (Grundriss), ≥3 Punkte. Bei einem
    /// Kreis-Profil (`circle` gesetzt) eine Tessellierung des Kreises (48-Eck) —
    /// für 2D-Footprint/Auswahl/bbox/Verschieben; die 3D-Extrusion nutzt in dem
    /// Fall stattdessen `circle` (echte runde truck-Extrusion, `extrudeCircle`).
    pub points: Vec<Vec2>,
    /// Extrusionshöhe in Metern (> 0), nach +Z ab der Geschoss-UK.
    pub height: f64,
    /// Abstand der Körper-UK über der Geschoss-UK (Meter, Default 0).
    #[serde(rename = "baseOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_offset: Option<f64>,
    /// Boolesche Rolle im Gebäude: "subtract" = Abzugskörper (Aussparung/Durchbruch/Nische).
    /// Er zieht sich von allen Wänden, Decken und Stützen ab, die er durchdringt — in 3D
    /// (truck-Boolean), im Grundriss und im Schnitt; selbst wird er nur als Umriss gezeigt.
    /// Fehlt = normaler Körper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"subtract\"")]
    pub operation: Option<String>,
    /// Gesetzt, wenn das Profil ein Kreis ist (aus einem `Drawing2D` mit
    /// `shape:"circle"`) — `points` bleibt die Tessellierung, `toWalls3d.ts`
    /// (emitExtrudedSolids) nutzt `circle` für die runde 3D-Extrusion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub circle: Option<ExtrudedSolidCircle>,
    /// Verjüngung 0 (Prisma, Default/fehlend) … 1 (Spitze — Kegel bei Kreis-,
    /// Pyramide bei Polygon-Profil). Linear zum Profil-Schwerpunkt skaliert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub taper: Option<f64>,
    /// Eckenradius (Meter) der Aussenkontur: jede Ecke wird durch einen echten Kreisbogen
    /// verrundet (truck-B-Rep, auch im STEP-Export exakt). Fehlt/0 = scharfe Ecken.
    #[serde(rename = "cornerRadius", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub corner_radius: Option<f64>,
    /// Fase (Meter) an den Ecken der Aussenkontur — gerade Abschrägung; fehlt/0 = scharf.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chamfer: Option<f64>,
    /// B-Rep-Körper statt Profil-Extrusion (Grundkörper Kugel/Zylinder/Kegel/Torus/Quader …
    /// oder beliebige `trucksolid`-Spezifikation). `spec` ist eine `SolidSpec`
    /// (`engine/truckSolid.ts`) in LOKALEN Koordinaten (Z ab der Geschoss-UK); `origin` ist der
    /// Wert von `points[0]` bei der Erzeugung — die aktuelle Verschiebung ergibt sich aus
    /// `points[0] − origin`, sodass Verschieben/Kopieren das Profil mitnimmt. `points` bleibt die
    /// Grundriss-Fläche (Auswahl/2D-Umriss), `height` die Körperhöhe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub brep: Option<ExtrudedSolidBrep>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine Stütze (Column) — ein geschossgebundenes Tragwerk-Bauteil (Kategorie
/// „50"), definiert über einen Einfügepunkt `position`, ein Profil, eine Drehung
/// und eine Höhe. Vertikale Lage analog Wand (UK/OK-Anker, sonst Geschoss-UK +
/// `height`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Column {
    pub id: String,
    #[ts(type = "\"column\"")]
    pub r#type: String,
    /// Zugehörige Zeichnungsebene (Geschoss).
    #[serde(rename = "floorId")]
    pub floor_id: String,
    /// Grafik-Kategorie (Ebene), z. B. "50" für Tragwerk.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Einfügepunkt (Profil-Mitte) im Grundriss (Meter).
    pub position: Vec2,
    /// Querschnitt (Rechteck oder Kreis).
    pub profile: ColumnProfile,
    /// Drehung des Profils um `position` (Radiant, CCW; Default 0).
    pub rotation: f64,
    /// Höhe in Metern (> 0), nach +Z ab der UK.
    pub height: f64,
    /// Optionales tragendes Bauteil (Component) für Poché/3D-Farbe/Schraffur.
    #[serde(rename = "componentId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub component_id: Option<String>,
    /// Vertikale Bindung der Unterkante (UK). Fehlt sie, sitzt die UK auf der
    /// baseElevation des zugehörigen Geschosses (= Wand-Default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bottom: Option<VerticalAnchor>,
    /// Vertikale Bindung der Oberkante (OK). Fehlt sie, ergibt sich die OK aus
    /// UK + `height`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub top: Option<VerticalAnchor>,
    /// Optionale Übersteuerung der Strich-/Umrandungsfarbe; sonst gilt die
    /// Kategorie-Farbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku).
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color_pen_id: Option<String>,
    /// Attribut-Override der Muster-/Schraffurfarbe (Vordergrund) DIESER Stütze.
    /// `undefined` = „Nach System" (erben → Component.foreground), analog `Wall.
    /// foreground`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground: Option<String>,
    /// Attribut-Override der Füllfarbe (Hintergrund/Poché) DIESER Stütze.
    /// `undefined` = „Nach System" (neutrale SIA-Poché HATCH_INK/HATCH_PAPER je
    /// nach Schraffur-Muster), analog `Wall.background`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background: Option<String>,
    /// Stift-Kopplung von `foreground` (s. `Component.foregroundPenId`-Doku).
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_pen_id: Option<String>,
    /// Stift-Kopplung von `background`, analog {@link Wall.foregroundPenId}.
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_pen_id: Option<String>,
    /// Attribut-Override der Strichstärke (mm Papier) DIESER Stütze. `undefined`
    /// = „Nach System" (erben → `strokeWeightSource`), analog `Wall.strokeWeight`.
    #[serde(rename = "strokeWeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke_weight: Option<f64>,
    /// Attribut-Override der Schnitt-Schraffur (Hatch Manager) DIESER Stütze.
    /// `undefined` = „Nach System" (erben → `hatchSource`), analog `Wall.hatchId`.
    #[serde(rename = "hatchId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_id: Option<String>,
    /// Quelle des Vordergrunds, wenn kein explizites `foreground` gesetzt ist — analog `Wall.foregroundSource`.
    #[serde(rename = "foregroundSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground_source: Option<AttributeSource>,
    /// Quelle des Hintergrunds, analog {@link Column.foregroundSource}.
    #[serde(rename = "backgroundSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub background_source: Option<AttributeSource>,
    /// Quelle der Strichstärke, analog {@link Column.foregroundSource}.
    #[serde(rename = "strokeWeightSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke_weight_source: Option<AttributeSource>,
    /// Quelle der Schraffur, analog {@link Column.foregroundSource}.
    #[serde(rename = "hatchSource", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch_source: Option<AttributeSource>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Gruppe (Vectorworks-artig) — reine Mitgliedschaft je Elementart, siehe
/// {@link Project.groups}. Alle ID-Listen sind additiv; ein Element gehört
/// NIE zu mehr als einer Gruppe auf derselben Ebene (das Werkzeug/der Befehl
/// stellt das beim Gruppieren sicher, nicht das Modell selbst).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Group {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(rename = "wallIds")]
    pub wall_ids: Vec<String>,
    #[serde(rename = "drawingIds")]
    pub drawing_ids: Vec<String>,
    #[serde(rename = "ceilingIds")]
    pub ceiling_ids: Vec<String>,
    #[serde(rename = "roomIds")]
    pub room_ids: Vec<String>,
    #[serde(rename = "stairIds")]
    pub stair_ids: Vec<String>,
    #[serde(rename = "columnIds")]
    pub column_ids: Vec<String>,
    #[serde(rename = "roofIds")]
    pub roof_ids: Vec<String>,
    #[serde(rename = "openingIds")]
    pub opening_ids: Vec<String>,
    /// Verschachtelte Gruppen (diese Gruppe enthält andere Gruppen als Ganzes).
    #[serde(rename = "groupIds")]
    pub group_ids: Vec<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── Parametrische Wände (Parametric Walls) ────────────────────────────────
// Parametrische Wand-Regeln generieren automatisch Wall[]-Arrays — analog zu
// FreeCAD BIM. Sie leben in Project.resources.parametricWalls[] und werden
// durch `resolveParametricWall()` in `src/model/parametricWalls.ts` aufgelöst.
// Ausgabe: normale Wall[]-Objekte (kein neuer Elementtyp).

/// Eine parametrische Wand-Regel — generiert automatisch Wall[]-Einträge für
/// ein gegebenes Geschoss. Lebt in der Ressourcen-Bibliothek des Projekts.
/// Wird über `resolveParametricWall()` aufgelöst, nicht zur Laufzeit gespeichert.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ParametricWall {
    pub id: String,
    /// Anzeigename, z. B. „Wohnbau-Raster 3m".
    pub name: String,
    /// Optionale Beschreibung (für den Ressourcen-Manager).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    /// Geordnete Liste der anzuwendenden Regeln. Spätere Regeln können die
    /// Ausgabe früherer Regeln verfeinern (z. B. Dickenzuweisung nach Raster).
    pub rules: Vec<ParametricRule>,
    /// Rückfall-Wandtyp, falls eine Regel keinen eigenen `wallTypeId` nennt.
    /// Muss auf einen gültigen WallType im Projekt verweisen.
    #[serde(rename = "defaultWallTypeId")]
    pub default_wall_type_id: String,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── Grafische Overrides (Regel-Engine) ─────────────────────────────────────
// ArchiCAD-/Vectorworks-Stil: benannte Regeln `condition → actions`, die beim
// RENDERN als oberste Schicht über die By-Layer/By-Object-Attribut-Auflösung
// gelegt werden (reines Rendering-Overlay — die Elementdaten bleiben
// unverändert, jederzeit reversibel). Regeln werden additiv angewendet: pro
// Aktions-Feld gewinnt die OBERSTE (erste) aktive Regel, die es setzt.
// Auswertung: `src/overrides/engine.ts`; Einhängepunkt: `plan/generatePlan.ts`.

/// Bedingungs-Typ einer Override-Regel — wogegen der Wert verglichen wird:
///   • "layer_name"  — Name ODER Code der Ebene (LayerCategory) des Elements.
///   • "object_name" — Element-/Typ-Name (z. B. Wandtyp-Name, Raum-Name,
///     Öffnungs-Label, Drawing2D-Formname).
/// Ein `user_string`-Tag (DOSSIER-Rhino) existiert am Element noch nicht und
/// ist deshalb bewusst NICHT enthalten (kein Schein-Feature).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OverrideConditionType {
    #[default]
    #[serde(rename = "layer_name")]
    LayerName,
    #[serde(rename = "object_name")]
    ObjectName,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Vergleichs-Operator einer Override-Bedingung (case-insensitiv).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OverrideOperator {
    #[default]
    #[serde(rename = "equals")]
    Equals,
    #[serde(rename = "contains")]
    Contains,
    #[serde(rename = "starts_with")]
    StartsWith,
    #[serde(rename = "not_equals")]
    NotEquals,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Bedingung einer Override-Regel.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct OverrideCondition {
    pub r#type: OverrideConditionType,
    pub operator: OverrideOperator,
    /// Vergleichswert (Freitext, case-insensitiv verglichen).
    pub value: String,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Aktionen einer Override-Regel — jede optional (Teilaktionen sind erlaubt;
/// fehlende Felder lassen die reguläre Auflösung unberührt).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct OverrideActions {
    /// Strich-/Umrandungsfarbe (hex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Strichstärke in mm Papier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lineweight: Option<f64>,
    /// Linienstil (Line Manager) — wirkt, wo Elemente einen LineStyle tragen (Drawing2D).
    #[serde(rename = "linetypeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub linetype_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine grafische Override-Regel. Lebt in `Project.overrideRules` (Reihenfolge
/// = Priorität, oben gewinnt) und ist einzeln aktivier-/deaktivierbar.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct OverrideRule {
    pub id: String,
    pub name: String,
    /// Deaktivierte Regeln werden bei der Auswertung übersprungen.
    pub enabled: bool,
    pub condition: OverrideCondition,
    pub actions: OverrideActions,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ansichtstyp eines Geschosses (wie in App).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ViewType {
    #[default]
    #[serde(rename = "grundriss")]
    Grundriss,
    #[serde(rename = "perspektive")]
    Perspektive,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Kanonischer Blickwinkel der 3D-Ansicht (Vectorworks/DOSSIER-Stil). „front"/
/// „back"/„side"/„left" springen auf die vier Kardinalrichtungen (Vorne/Hinten/
/// Rechts/Links — KEINE Himmelsrichtungs-Labels, da es noch keinen Nordwinkel
/// gibt); „top" auf die Draufsicht. „iso"/„isoFrontLeft"/„isoBackRight"/
/// „isoBackLeft" sind die vier oberen Iso-Oktanten (untere vier bleiben im
/// Hochbau ungenutzt) — „iso" (vorne-oben-rechts) ist der bestehende Default.
/// „perspective" ist der freie 3/4-Blick. Wirkt nur in der Perspektive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum View3d {
    #[default]
    #[serde(rename = "front")]
    Front,
    #[serde(rename = "back")]
    Back,
    #[serde(rename = "side")]
    Side,
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "top")]
    Top,
    #[serde(rename = "iso")]
    Iso,
    #[serde(rename = "isoFrontLeft")]
    IsoFrontLeft,
    #[serde(rename = "isoBackRight")]
    IsoBackRight,
    #[serde(rename = "isoBackLeft")]
    IsoBackLeft,
    #[serde(rename = "perspective")]
    Perspective,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Das gesamte Projekt.
///
/// Ein Ausschnitt (View-Snapshot) — eine benannte, gespeicherte Ansicht, die den
/// kompletten Darstellungszustand einfängt und per Klick wiederherstellt
/// (DOSSIER A2, ROADMAP §2c/§11). KEIN neuer Zustand, sondern ein Container, der
/// bereits vorhandene Bausteine KOMPONIERT + benennt: Ansicht (Typ/Kamera/
/// Massstab/Detail), Sichtbarkeit (Ebenen-/Zeichnungskombination, gleiches
/// Payload-Format wie {@link https LayerCombo}/`DrawingCombo`), aktive Overrides
/// und das aktive Geschoss. Lebt im DOKUMENT (`Project.viewSnapshots`), nicht im
/// localStorage — Ausschnitte gehören zum Projekt (Export/Teilen).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ViewSnapshot {
    pub id: String,
    pub name: String,
    /// LEGACY: name-basierte Flach-Gruppierung (Phase 1). Wird von der neuen
    /// Ordner-/Baum-UI nicht mehr genutzt, bleibt aber für Alt-Projekte gültig.
    /// Neue Ausschnitte tragen stattdessen `folderId` (echte Ordner-Referenz).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub folder: Option<String>,
    /// Ordner (Baumstruktur) des Ausschnitte-Panels, in dem der Ausschnitt liegt
    /// ({@link ViewSnapshotFolder}). Fehlt er (oder verweist er ins Leere), liegt
    /// der Ausschnitt auf der Wurzelebene. Additiv — Alt-Projekte laden unverändert.
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub folder_id: Option<String>,
    /// Ansichtstyp (Grundriss / Perspektive).
    #[serde(rename = "viewType")]
    pub view_type: ViewType,
    /// Kanonischer 3D-Blickwinkel (Front/Top/Iso/… bzw. freie Perspektive).
    pub view3d: View3d,
    /// Sichtwinkel (FOV) der 3D-Perspektivkamera in Grad. Optional (nur 3D relevant).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fov: Option<f64>,
    /// Papier-Massstab „1:N" (der Nenner).
    #[serde(rename = "scaleDenominator")]
    pub scale_denominator: f64,
    /// Detailgrad der Darstellung (grob/mittel/fein).
    pub detail: DetailLevel,
    /// Aktives Geschoss/Zeichnungsebene beim Erfassen.
    #[serde(rename = "activeLevelId")]
    pub active_level_id: String,
    /// Ebenen-Sichtbarkeit: Kategorie-`code` → sichtbar (wie `LayerCombo.codes`).
    #[serde(rename = "layerVisibility")]
    pub layer_visibility: std::collections::BTreeMap<String, bool>,
    /// Zeichnungsebenen-Sichtbarkeit: DrawingLevel-`id` → sichtbar (wie `DrawingCombo.ids`).
    #[serde(rename = "drawingVisibility")]
    pub drawing_visibility: std::collections::BTreeMap<String, bool>,
    /// Ids der beim Erfassen AKTIVEN (`enabled`) Override-Regeln. Beim
    /// Wiederherstellen wird jede Regel des Projekts auf `enabled = ids.includes(id)`
    /// gesetzt. Optional, damit hand-/altangelegte Snapshots ohne Feld gültig sind.
    #[serde(rename = "enabledOverrideRuleIds", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled_override_rule_ids: Option<Vec<String>>,
    /// Kameraposition im Grundriss (Nutzer-Wunsch: „Ein gespeicherter Ausschnitt
    /// ändert, WAS sichtbar ist, nicht WOHIN man schaut" — bisher merkte sich ein
    /// Ausschnitt nie Bildmitte/Zoom). Beide Felder optional UND nur ein Paar
    /// (nicht einzeln sinnvoll) — fehlen sie (Alt-Ausschnitte vor dieser
    /// Ergänzung, oder beim Erfassen war kein Grundriss gemountet, z. B. 3D-
    /// Ansicht/Schnitt), bleibt die Bildmitte beim Wiederherstellen unverändert
    /// (nur der Massstab wird gesetzt, wie bisher).
    #[serde(rename = "cameraCenter", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub camera_center: Option<Vec2>,
    /// Zoom (Bildschirm-Pixel je Meter) beim Erfassen — zusammen mit `cameraCenter`.
    #[serde(rename = "cameraPxPerMeter", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub camera_px_per_meter: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Ordner im Ausschnitte-Baum (DOSSIER A2). Ausschnitte verweisen per
/// `folderId` auf ihren Ordner; `parentId` erlaubt Verschachtelung (Ordner in
/// Ordner). Fehlt `parentId`, liegt der Ordner auf der Wurzelebene. Additiv —
/// Alt-Projekte laden unverändert (spiegelbildlich zu {@link LayoutFolder}).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ViewSnapshotFolder {
    pub id: String,
    pub name: String,
    /// Übergeordneter Ordner; ohne → Wurzelebene.
    #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── Layout-Blätter mit Masterlayout (DOSSIER A3, ROADMAP §11) ───────────────
//
// Ein „Layout" ist ein Druck-/Plan-Blatt (A4/A3), auf dem mehrere Viewports
// platziert werden; jeder Viewport ist an einen Ausschnitt ({@link ViewSnapshot})
// gebunden und rendert dessen Plan im gewählten Massstab. Ein Masterlayout
// liefert die gemeinsamen Blatt-Elemente (Titelblock/Rahmen), die die Layouts
// erben. Alles lebt im DOKUMENT (`Project.layouts`/`Project.masterLayouts`),
// nicht im localStorage — Layouts gehören zum Projekt. Additiv: bestehende
// Projekte ohne diese Felder bleiben unverändert gültig.

/// Papierformat eines Layout-Blatts (Blattmasse in mm identisch zum PDF-Export).
/// ISO-216-Reihen A0–A6 und B0–B6; Alt-Projekte (nur A4/A3) laden unverändert.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum LayoutPaperFormat {
    #[default]
    #[serde(rename = "a0")]
    A0,
    #[serde(rename = "a1")]
    A1,
    #[serde(rename = "a2")]
    A2,
    #[serde(rename = "a3")]
    A3,
    #[serde(rename = "a4")]
    A4,
    #[serde(rename = "a5")]
    A5,
    #[serde(rename = "a6")]
    A6,
    #[serde(rename = "b0")]
    B0,
    #[serde(rename = "b1")]
    B1,
    #[serde(rename = "b2")]
    B2,
    #[serde(rename = "b3")]
    B3,
    #[serde(rename = "b4")]
    B4,
    #[serde(rename = "b5")]
    B5,
    #[serde(rename = "b6")]
    B6,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ausrichtung eines Layout-Blatts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum LayoutOrientation {
    #[default]
    #[serde(rename = "portrait")]
    Portrait,
    #[serde(rename = "landscape")]
    Landscape,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ein platzierter Viewport auf einem Layout-Blatt — Position/Grösse in Papier-mm,
/// gebunden an einen Ausschnitt (`snapshotId`). `scaleDenominator` übersteuert
/// optional den Massstab des Ausschnitts (Massstab pro Viewport).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayoutViewport {
    pub id: String,
    /// Id des gebundenen Ausschnitts ({@link ViewSnapshot}).
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    /// Linke Kante auf dem Blatt (mm, von links).
    #[serde(rename = "xMm")]
    pub x_mm: f64,
    /// Obere Kante auf dem Blatt (mm, von oben).
    #[serde(rename = "yMm")]
    pub y_mm: f64,
    /// Breite des Viewport-Rahmens auf dem Blatt (mm).
    #[serde(rename = "widthMm")]
    pub width_mm: f64,
    /// Höhe des Viewport-Rahmens auf dem Blatt (mm).
    #[serde(rename = "heightMm")]
    pub height_mm: f64,
    /// Optionaler Massstab-Nenner (1:N); übersteuert `snapshot.scaleDenominator`.
    #[serde(rename = "scaleDenominator", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scale_denominator: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Layout-Blatt — Papierformat/Ausrichtung, optionaler Master (`masterId`)
/// und die platzierten Viewports.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub paper: LayoutPaperFormat,
    pub orientation: LayoutOrientation,
    /// Eigene Plannummer im Titelblock; fehlt = laufende Nummer (`resolveTitleBlock`).
    #[serde(rename = "planNumber", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan_number: Option<String>,
    /// Referenz auf ein {@link MasterLayout}; ohne → kein Master (blanko Blatt).
    #[serde(rename = "masterId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub master_id: Option<String>,
    /// Ordner (Baumstruktur), in dem das Layout liegt ({@link LayoutFolder}). Fehlt
    /// er (oder verweist auf einen gelöschten Ordner), liegt das Layout auf der
    /// Wurzelebene. Additiv — Alt-Projekte laden unverändert.
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub folder_id: Option<String>,
    /// Freie Blattbreite in mm — überschreibt `paper`/A4·A3, siehe
    /// {@link MasterLayout.customWidthMm}. Bei gesetztem `masterId` erbt das Blatt
    /// ohnehin die Master-Grösse; eigene Custom-Werte gelten nur ohne Master.
    #[serde(rename = "customWidthMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub custom_width_mm: Option<f64>,
    /// Freie Blatthöhe in mm (siehe {@link Layout.customWidthMm}).
    #[serde(rename = "customHeightMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub custom_height_mm: Option<f64>,
    /// Die 2D-Zeichnung auf dem Blatt liegt auf der Blatt-Ebene ({@link DrawingLevel.layoutId}),
    /// nicht im Layout (bis Format 2: `annotations`, s. `project_format::migrate_layout_annotations`).
    pub viewports: Vec<LayoutViewport>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Einfache Textfelder des Titelblocks (Master). Alle optional — leere Felder
/// werden beim Auflösen aus dem Projekt/Layout mit sinnvollen Defaults gefüllt
/// (Projektname ← `Project.name`, Blattname ← `Layout.name`, Datum ← heute).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayoutTitleBlock {
    #[serde(rename = "projectName", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_name: Option<String>,
    #[serde(rename = "sheetName", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sheet_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub author: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Masterlayout — gemeinsame Blatt-Elemente (Titelblock + optionaler Rahmen), die
/// einzelne {@link Layout}s per `masterId` erben. Eine Änderung am Master schlägt
/// auf alle Layouts durch, die ihn referenzieren (InDesign-/ArchiCAD-Muster).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct MasterLayout {
    pub id: String,
    pub name: String,
    pub paper: LayoutPaperFormat,
    pub orientation: LayoutOrientation,
    /// Titelblock-Textfelder (Vorlage; leere Felder werden aufgelöst/aufgefüllt).
    #[serde(rename = "titleBlock")]
    pub title_block: LayoutTitleBlock,
    /// Ordner (Master-Baum), in dem das Masterlayout liegt ({@link LayoutFolder} mit
    /// `kind:"master"`). Fehlt er (oder verweist auf einen gelöschten/Layout-Ordner),
    /// liegt der Master auf der Wurzelebene. Additiv — Alt-Projekte laden unverändert.
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub folder_id: Option<String>,
    /// Blattrahmen zeichnen (Randlinie). Optional, Default `true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub border: Option<bool>,
    /// Freie Blattbreite in mm. Ist sie (zusammen mit `customHeightMm`) gesetzt,
    /// überschreibt sie `paper`/A4·A3 (die effektive Blattgrösse ist dann
    /// `customWidthMm`×`customHeightMm`, `orientation` wird ignoriert). Fehlt sie,
    /// gilt `paper`+`orientation` wie bisher. Additiv — Alt-Projekte laden unverändert.
    #[serde(rename = "customWidthMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub custom_width_mm: Option<f64>,
    /// Freie Blatthöhe in mm (siehe {@link MasterLayout.customWidthMm}).
    #[serde(rename = "customHeightMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub custom_height_mm: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum LayoutFolderKind {
    #[default]
    #[serde(rename = "layout")]
    Layout,
    #[serde(rename = "master")]
    Master,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ein Ordner im Layouts-Baum (DOSSIER A3). Layouts verweisen per `folderId` auf
/// ihren Ordner; `parentId` erlaubt Verschachtelung (Ordner in Ordner). Fehlt
/// `parentId`, liegt der Ordner auf der Wurzelebene. Masterlayouts liegen NICHT
/// in Ordnern (sie sind Vorlagen). Additiv — Alt-Projekte laden unverändert.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayoutFolder {
    pub id: String,
    pub name: String,
    /// Übergeordneter Ordner; ohne → Wurzelebene.
    #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<String>,
    /// Baum-Zugehörigkeit: `"layout"`-Ordner tragen Layouts, `"master"`-Ordner
    /// tragen Masterlayouts. Die beiden Bäume bleiben getrennt (ein Master-Ordner
    /// erscheint nie im Layout-Baum und umgekehrt). Fehlt das Feld, gilt `"layout"`
    /// (rückwärtskompatibel — Alt-Projekte ohne `kind` bleiben Layout-Ordner).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub kind: Option<LayoutFolderKind>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ProjectGeoAnchorLv95 {
    pub e: f64,
    pub n: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ProjectGeoAnchor {
    /// Reale Landeskoordinate (LV95/EPSG:2056, Meter).
    #[ts(inline)]
    pub lv95: ProjectGeoAnchorLv95,
    /// Reale Höhe des Bezugspunkts in Metern über Meer (m ü. M.). Wie ArchiCADs
    /// „Vermessungspunkt" (Ost/Nord/Höhe): rein informativ verankert, VERSCHIEBT
    /// das Modell NICHT. Wird beim IFC-Export als `IfcSite.RefElevation`
    /// (Standort-Datumshöhe) geschrieben. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<f64>,
    /// Zugehöriger Punkt im Modell (lokale Meter), Default (0,0).
    pub model: Vec2,
    /// Anzeige-Adresse/Bezeichnung des Bezugspunkts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Project {
    /// Dateiformat-Version (s. `io/projectFormat.ts`); wird beim Speichern gesetzt.
    #[serde(rename = "formatVersion", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub format_version: Option<f64>,
    pub id: String,
    pub name: String,
    /// Linienstil-Bibliothek (Line Manager).
    #[serde(rename = "lineStyles")]
    pub line_styles: Vec<LineStyle>,
    /// Textstil-Bibliothek (Nutzer-Wunsch: „Textstil-Bibliothek" — bisher gab es
    /// nur 4 FEST verdrahtete `DEFAULT_PRESETS` in `text/richText.ts`, nirgends
    /// im Projekt gespeichert, nirgends im ResourceManager editierbar). Optional
    /// mit Fallback auf `DEFAULT_PRESETS` (wie `layouts` — additiv, alte
    /// Projektdateien ohne dieses Feld bleiben gültig). Wiederverwendet den
    /// bereits vorhandenen `TextStylePreset`-Typ (Marks-Vorlage) UND die
    /// bereits vorhandene `applyPreset()`-Anwendungslogik aus `richText.ts` —
    /// neu ist NUR, dass die Liste jetzt projektbezogen + editierbar ist statt
    /// hart codiert.
    #[serde(rename = "textStyles", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text_styles: Option<Vec<TextStylePreset>>,
    /// Schraffur-Bibliothek (Hatch Manager).
    pub hatches: Vec<HatchStyle>,
    /// Bauteil-Material-Bibliothek (Component Manager).
    pub components: Vec<Component>,
    #[serde(rename = "wallTypes")]
    pub wall_types: Vec<WallType>,
    /// Deckentypen (Deckenstile) — dediziert für Decken, analog `wallTypes`.
    /// Optional, damit bestehende Projekte/Tests ohne `ceilingTypes` gültig
    /// bleiben; Decken ohne `ceilingTypeId` lösen weiterhin über das LEGACY-Feld
    /// `Ceiling.wallTypeId` gegen `wallTypes` auf (siehe `getCeilingType`).
    #[serde(rename = "ceilingTypes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ceiling_types: Option<Vec<CeilingType>>,
    /// Dachtypen (Dachaufbauten) — mehrschichtig, analog `ceilingTypes`. Optional;
    /// Dächer ohne `roofTypeId` lösen über die einschichtige `Roof.thickness` auf.
    #[serde(rename = "roofTypes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub roof_types: Option<Vec<RoofType>>,
    /// Wiederverwendbare 2D-Symbol-Bibliothek (Möbelblöcke, Sanitär-/Norm-
    /// symbole u. Ä.) — analog `wallTypes`: einmal definieren, beliebig oft als
    /// `{shape:"block"}`-Instanz platzieren. V1 bewusst NUR 2D (kein 3D-Körper,
    /// keine verschachtelten Blöcke). Optional, damit bestehende Projekte ohne
    /// `blockDefs` gültig bleiben.
    #[serde(rename = "blockDefs", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub block_defs: Option<Vec<BlockDef>>,
    /// Türtypen-Bibliothek (Türstile), analog `wallTypes`. Optional, damit
    /// bestehende Projekte/Tests ohne `doorTypes` gültig bleiben; Türen ohne
    /// `typeId` verhalten sich wie bisher (Inline-Felder).
    #[serde(rename = "doorTypes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub door_types: Option<Vec<DoorType>>,
    /// Fenstertypen-Bibliothek (Fensterstile). Optional (siehe `doorTypes`).
    #[serde(rename = "windowTypes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub window_types: Option<Vec<WindowType>>,
    /// Treppentypen-Bibliothek (Treppenstile). Optional (siehe `doorTypes`).
    #[serde(rename = "stairTypes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stair_types: Option<Vec<StairType>>,
    /// Stift-Bibliothek (ArchiCAD-Stiftsatz-Muster, s. {@link ColorPen}):
    /// projektweite Liste der Stift-IDs/-Namen. Optional, damit bestehende
    /// Projekte/Tests ohne Stifte gültig bleiben.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pens: Option<Vec<ColorPen>>,
    /// Stiftsätze (s. {@link PenSet}) — je einer eine vollständige Stift→Farbe-
    /// Zuordnung. Optional (siehe `pens`).
    #[serde(rename = "penSets", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pen_sets: Option<Vec<PenSet>>,
    /// ID des aktuell AKTIVEN Stiftsatzes (`penSets`). Fehlt sie (kein Stiftsatz
    /// angelegt/aktiviert), lösen Stift-Verweise auf `PEN_FALLBACK_COLOR` auf.
    #[serde(rename = "activePenSetId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_pen_set_id: Option<String>,
    /// Benutzerdefinierte Farbpaletten (s. {@link CustomPalette}) — im
    /// Farbmischer-Popover per „Diese Farbe speichern" befüllt. Optional
    /// (siehe `pens`).
    #[serde(rename = "customPalettes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub custom_palettes: Option<Vec<CustomPalette>>,
    /// Welche MITGELIEFERTEN Paletten-Bänke im Farbwahl-Popover erscheinen
    /// (s. {@link BuiltinPaletteBanks}). Fehlt das Objekt, sind alle sichtbar.
    #[serde(rename = "builtinPaletteBanks", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub builtin_palette_banks: Option<BuiltinPaletteBanks>,
    /// Oberste Schnitte: Geschosse + Schnitte/Ansichten.
    #[serde(rename = "drawingLevels")]
    pub drawing_levels: Vec<DrawingLevel>,
    /// Raumprogramm (Soll) für die Prüfung gegen das Modell.
    #[serde(rename = "roomProgram", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub room_program: Option<Vec<RoomProgramRow>>,
    /// Toleranz der Soll/Ist-Ampel des Raumprogramms als Anteil der Soll-Fläche (Default 0.05 = ±5 %).
    #[serde(rename = "roomProgramTolerance", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub room_program_tolerance: Option<f64>,
    /// Parzellenfläche (m²) für Ausnützungs- und Überbauungsziffer.
    #[serde(rename = "parcelArea", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parcel_area: Option<f64>,
    /// Schattenstudie: Zeitpunkt (ISO 8601, UTC) und ob der Boden-Schatten im Grundriss erscheint.
    #[serde(rename = "sunStudy", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sun_study: Option<SunStudy>,
    /// Baurecht der Parzelle: Grenze, Grenzabstände, Baulinien, Gesamthöhe (`analysis/siteRules.ts`).
    #[serde(rename = "siteRules", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site_rules: Option<SiteRules>,
    /// Strichstärken im Grundriss mit dem Massstab skalieren, (100/n)^0.25 (`plan/lineWeightScale.ts`).
    #[serde(rename = "scaleLineWeights", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scale_line_weights: Option<bool>,
    /// Grafik-Kategorie-Baum (geschossübergreifend).
    pub layers: Vec<LayerCategory>,
    pub walls: Vec<Wall>,
    /// Decken (Slabs) — geschossgebundene Flächenbauteile mit geschlossenem Umriss.
    /// Optional, damit bestehende Projekte/Tests ohne `ceilings` gültig bleiben
    /// (Default: leer behandeln).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ceilings: Option<Vec<Ceiling>>,
    /// Dächer über (rechteckigen) Grundriss-Umrissen. Optional (Alt-Projekte).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub roofs: Option<Vec<Roof>>,
    /// Öffnungen (Fenster/Türen), gehostet in Wänden. Optional, damit bestehende
    /// Projekte/Tests ohne `openings` gültig bleiben (Default: leer behandeln).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub openings: Option<Vec<Opening>>,
    /// Treppen (Treppe) — geschossübergreifende Bauteile (gerade/L/Wendel). Optional,
    /// damit bestehende Projekte/Tests ohne `stairs` gültig bleiben (Default: leer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stairs: Option<Vec<Stair>>,
    /// Räume (SIA-416-Flächen) — geschossgebundene Flächen mit geschlossenem Umriss.
    /// Optional, damit bestehende Projekte/Tests ohne `rooms` gültig bleiben
    /// (Default: leer behandeln).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rooms: Option<Vec<Room>>,
    /// Freie 2D-Zeichengeometrie (Line/Polyline/Rect/Circle/Arc/Text).
    pub drawings2d: Vec<Drawing2D>,
    /// Kontext-Schicht: importierte/abgeleitete „dumme" Geometrie (Meshes,
    /// Konturen, Gelände-TIN) — NICHT semantisch. Optional, damit bestehende
    /// Projekte/Tests ohne `context` gültig bleiben (Default: leer behandeln).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context: Option<Vec<ContextObject>>,
    /// Extrudierte Körper (truck-Integration) — geschlossene 2D-Profile mit Höhe,
    /// siehe {@link ExtrudedSolid}. Optional, damit bestehende Projekte/Tests ohne
    /// `extrudedSolids` gültig bleiben (Default: leer behandeln).
    #[serde(rename = "extrudedSolids", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extruded_solids: Option<Vec<ExtrudedSolid>>,
    /// Stützen (Columns) — geschossgebundene Tragwerk-Bauteile (platzierte
    /// Profil-Extrusionen), siehe {@link Column}. Optional, damit bestehende
    /// Projekte/Tests ohne `columns` gültig bleiben (Default: leer behandeln).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub columns: Option<Vec<Column>>,
    /// Gruppen (Vectorworks-artig: Cmd+G fasst die Auswahl zu einer Einheit
    /// zusammen; Doppelklick betritt die Gruppe zum Bearbeiten, alles andere
    /// wird dabei gedimmt/gesperrt — s. `state/useGroupState.ts`). Eine Gruppe
    /// ist reine MITGLIEDSCHAFT (IDs je Elementart, wie eine gespeicherte
    /// Mehrfachauswahl) — kein eigenes Geometrie-/Transform-Objekt, damit
    /// Verschieben/Kopieren/Löschen weiterhin dieselbe Maschinerie nutzen wie
    /// eine normale Mehrfachauswahl. `groupIds` erlaubt Verschachtelung (eine
    /// Gruppe kann andere Gruppen enthalten). Optional, damit bestehende
    /// Projekte/Tests ohne `groups` gültig bleiben (Default: leer behandeln).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub groups: Option<Vec<Group>>,
    /// Bibliothek parametrischer Wand-Regelwerke. Optional, damit bestehende
    /// Projekte ohne `parametricWalls` gültig bleiben (Default: leer behandeln).
    /// Wird durch `resolveParametricWall()` in `src/model/parametricWalls.ts`
    /// aufgelöst — generiert Wall[]-Objekte bei Bedarf.
    #[serde(rename = "parametricWalls", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parametric_walls: Option<Vec<ParametricWall>>,
    /// Grafische Override-Regeln (Regel-Engine, Reihenfolge = Priorität, oben
    /// gewinnt) — reines Rendering-Overlay, siehe {@link OverrideRule}. Optional,
    /// damit bestehende Projekte/Tests ohne `overrideRules` gültig bleiben
    /// (Default: leer behandeln).
    #[serde(rename = "overrideRules", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub override_rules: Option<Vec<OverrideRule>>,
    /// Ausschnitte / View-Snapshots (DOSSIER A2) — benannte, wiederherstellbare
    /// Ansichten (siehe {@link ViewSnapshot}). Optional, damit bestehende
    /// Projekte/Tests ohne `viewSnapshots` unverändert gültig bleiben (Default:
    /// leer behandeln). Gehört ins Dokument (nicht localStorage).
    #[serde(rename = "viewSnapshots", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_snapshots: Option<Vec<ViewSnapshot>>,
    /// Ordner des Ausschnitte-Baums (DOSSIER A2) — Gruppierung der
    /// {@link ViewSnapshot}s per `folderId`. Optional, damit bestehende
    /// Projekte/Tests ohne `viewSnapshotFolders` gültig bleiben (Default: leer →
    /// alle Ausschnitte auf Wurzelebene).
    #[serde(rename = "viewSnapshotFolders", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_snapshot_folders: Option<Vec<ViewSnapshotFolder>>,
    /// Layout-Blätter (DOSSIER A3) — Druck-/Plan-Blätter mit platzierten Viewports
    /// (siehe {@link Layout}). Optional, damit bestehende Projekte/Tests ohne
    /// `layouts` gültig bleiben (Default: leer behandeln). Gehört ins Dokument.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layouts: Option<Vec<Layout>>,
    /// Masterlayouts (DOSSIER A3) — gemeinsame Blatt-Elemente (Titelblock/Rahmen),
    /// die einzelne {@link Layout}s erben (siehe {@link MasterLayout}). Optional,
    /// damit bestehende Projekte/Tests ohne `masterLayouts` gültig bleiben.
    #[serde(rename = "masterLayouts", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub master_layouts: Option<Vec<MasterLayout>>,
    /// Ordner des Layouts-Baums (DOSSIER A3) — Gruppierung der {@link Layout}s per
    /// `folderId`. Optional, damit bestehende Projekte/Tests ohne `layoutFolders`
    /// gültig bleiben (Default: leer → alle Layouts auf Wurzelebene).
    #[serde(rename = "layoutFolders", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layout_folders: Option<Vec<LayoutFolder>>,
    /// Referenzhöhe des Erdgeschosses in Metern über Meer (m ü. M.), editierbar
    /// im Einstellungs-Fenster. Optional, damit bestehende Projekte ohne diesen
    /// Wert gültig bleiben (Default: unbestimmt/0). NUR Speicherfeld — die
    /// eigentliche Verwendung (Terrain-Draping/reale Höhen relativ dazu, siehe
    /// HANDOVER GEO-BLOCK) ist ein separater, späterer Task und liest dieses
    /// Feld noch nicht.
    #[serde(rename = "referenceElevationMasl", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference_elevation_masl: Option<f64>,
    /// Georeferenzierung: verbindet EINEN Modell-Punkt (lokale Meter) mit seiner
    /// realen LV95-Koordinate. Wird beim ERSTEN Standort-Import automatisch
    /// gesetzt (Modell-Position per Default (0,0), editierbar) und danach für
    /// ALLE weiteren Importe (Gebäude/Terrain/OSM) wiederverwendet — vorher
    /// berechnete jeder Import unabhängig einen neuen Bezug aus der jeweils
    /// gesuchten Adresse, wodurch mehrere Importe lagefalsch zueinander landen
    /// konnten, sobald nicht exakt derselbe Suchbegriff verwendet wurde.
    /// `label` ist die Anzeige-Adresse (rein informativ). Optional, damit
    /// bestehende Projekte ohne Bezug gültig bleiben.
    #[serde(rename = "geoAnchor", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub geo_anchor: Option<ProjectGeoAnchor>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum GridRuleDirections {
    #[default]
    #[serde(rename = "x")]
    X,
    #[serde(rename = "y")]
    Y,
    #[serde(rename = "both")]
    Both,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Raster-Regel: generiert Wände entlang gleichmäßiger X-/Y-Achsen.
/// Typischer Anwendungsfall: Tragwerks-Achsraster (z. B. 3 m Abstand).
///
/// Ablauf (Engine):
///   1. Rasterachsen aus `spacing` oder (später) verlinkter Grid-Ressource.
///   2. Je Achse eine Wand von Rand zu Rand (begrenzt durch `boundaryId`).
///   3. Wandtyp, Referenzlinie und Höhe gemäß Regelfelder.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct GridRule {
    /// Optionaler Verweis auf eine Grid-Ressource (Phase 3). Für MVP wird
    /// stattdessen `spacing` genutzt.
    #[serde(rename = "gridId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub grid_id: Option<String>,
    /// Rasterabstand in Metern (Default: 3.0). Wird genutzt, wenn kein `gridId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub spacing: Option<f64>,
    /// Achsrichtungen: „x" = nur horizontale Wände, „y" = nur vertikale,
    /// „both" = Vollraster.
    #[ts(inline)]
    pub directions: GridRuleDirections,
    /// Optionaler Verweis auf eine Drawing2D-Grenze (als Clipping-Polygon).
    /// Fehlt er, reicht das Raster über den sichtbaren Bereich des Geschosses.
    #[serde(rename = "boundaryId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub boundary_id: Option<String>,
    /// Optionale Wandtyp-Übersteuerung; sonst `defaultWallTypeId`.
    #[serde(rename = "wallTypeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wall_type_id: Option<String>,
    /// Lage der Wandachse über die Dicke (Vectorworks-Stil).
    #[serde(rename = "referenceLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference_line: Option<WallReferenceLine>,
    /// Optionale Höhenübersteuerung in Metern; sonst Geschosshöhe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModuleRuleDirection {
    #[default]
    #[serde(rename = "x")]
    X,
    #[serde(rename = "y")]
    Y,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Modul-Regel: teilt eine Referenzspanne in proportionale Felder auf.
/// Typischer Anwendungsfall: Tragwerks-Joche (z. B. 6 m-Module in einem Bauteil).
///
/// Ablauf (Engine):
///   1. Gesamtspanne aus `referenceWallId` oder Geschossausdehnung ableiten.
///   2. In Module der Größe `moduleSize` unterteilen.
///   3. Querwände an jedem Modulteilungspunkt setzen.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModuleRule {
    /// Modulmaß in Metern (z. B. 6.0, 3.6).
    #[serde(rename = "moduleSize")]
    pub module_size: f64,
    /// Ausrichtung der Trennwände: „x" = quer zur X-Achse, „y" = quer zur Y-Achse.
    #[ts(inline)]
    pub direction: ModuleRuleDirection,
    /// Optionaler Verweis auf eine Referenzwand, die die Spannweite definiert.
    /// Fehlt er, wird die Geschoss-Ausdehnung genutzt (Phase 3: Achsen-Referenz).
    #[serde(rename = "referenceWallId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference_wall_id: Option<String>,
    /// Optionale Wandtyp-Übersteuerung; sonst `defaultWallTypeId`.
    #[serde(rename = "wallTypeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wall_type_id: Option<String>,
    /// Lage der Wandachse über die Dicke.
    #[serde(rename = "referenceLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference_line: Option<WallReferenceLine>,
    /// Optionale Höhenübersteuerung in Metern.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ConditionalThicknessRuleLogic {
    #[default]
    #[serde(rename = "and")]
    And,
    #[serde(rename = "or")]
    Or,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Bedingte-Dicken-Regel: weist bereits generierten Wänden einen anderen
/// Wandtyp zu, wenn eine Bedingung erfüllt ist.
/// Typischer Anwendungsfall: Außenwände erhalten einen anderen Aufbau als Innenwände.
///
/// Ablauf (Engine):
///   Bestehende Wände aus `existingWalls` filtern → `wallTypeId` ändern.
///   Gibt modifizierte Kopien zurück (keine Mutation).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ConditionalThicknessRule {
    /// Bedingung für den Treffer:
    ///   • „exterior"  — Wand liegt am Außenrand (ermittelt via Grenzpolygon).
    ///   • „interior"  — Wand liegt im Inneren.
    ///   • „bearing"   — tragende Wand (über Tag oder Wandtyp-Rang).
    ///   • beliebiger String — benutzerdefiniertes Tag (Phase 3: Wall.tags[]).
    #[ts(type = "\"exterior\" | \"interior\" | \"bearing\" | string")]
    pub condition: serde_json::Value,
    /// Ziel-Wandtyp, der bei Treffer gesetzt wird.
    #[serde(rename = "wallTypeId")]
    pub wall_type_id: String,
    /// Verknüpfungslogik für mehrere Bedingungen (Phase 3: mehrere `condition`-Felder).
    /// Vorerst ungenutzt; Default ist implizites „or".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub logic: Option<ConditionalThicknessRuleLogic>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Referenzlinien-Regel: setzt die `referenceLine`-Eigenschaft bei passenden
/// Wänden einheitlich (Vectorworks-Stil).
/// Typischer Anwendungsfall: Alle Außenwände auf „left" (linke Fläche = Fassade).
///
/// Ablauf (Engine):
///   Bestehende Wände aus `existingWalls` filtern → `referenceLine` setzen.
///   Gibt modifizierte Kopien zurück.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ReferenceLineRule {
    /// Neue Lage der Wandachse, die einheitlich gesetzt wird.
    #[serde(rename = "referenceLine")]
    pub reference_line: WallReferenceLine,
    /// Filterziel:
    ///   • „all"      — alle Wände im aktuellen Satz.
    ///   • „exterior" — nur Außenwände (wie bei ConditionalThicknessRule).
    ///   • beliebiger String — benutzerdefiniertes Tag (Phase 3).
    #[ts(type = "\"all\" | \"exterior\" | string")]
    pub target: serde_json::Value,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Sequenz-Regel: fasst mehrere Unterregeln zusammen und wendet sie geordnet an.
/// Jede Unterregel kann die Ausgabe der vorherigen verfeinern.
/// Typischer Anwendungsfall: Raster → bedingte Dicke → Referenzlinie als atomare Einheit.
///
/// Ablauf (Engine):
///   Regeln in `rules` werden sequenziell ausgeführt; das Ergebnis jeder Regel wird
///   als `existingWalls` der nächsten übergeben. `stopOnMatch` bricht ab, sobald
///   eine Unterregel mindestens eine Wand generiert hat.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SequenceRule {
    /// Unterregeln, in Ausführungsreihenfolge.
    pub rules: Vec<ParametricRule>,
    /// Wenn `true`: Abbruch nach der ersten Unterregel, die mindestens eine Wand
    /// generiert/verändert. Ähnlich wie ein Short-Circuit-Fallback.
    #[serde(rename = "stopOnMatch", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stop_on_match: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── Kontext-Geometrie (importiert / abgeleitet, NICHT semantisch) ───────────
// Importierte Geometrie ist „dumme" KONTEXT-Geometrie (Anzeige + späteres
// Snap-Ziel), KEIN Teil des semantischen BIM-Modells. Sie lebt in einer eigenen
// Schicht `Project.context` und wird beim Rendern wie eine Referenz behandelt.
// Bewusst three-frei: nur rohe Buffer-Daten (positions/indices), three-Objekte
// entstehen erst im Viewport.

/// Ein importiertes Dreiecks-Mesh (z. B. aus DXF 3DFACE/POLYFACE/MESH). Rohe
/// BufferGeometry-Daten: `positions` = flaches Array (x,y,z, x,y,z, …) in Metern,
/// `indices` = Dreiecks-Indizes (je 3 ein Dreieck). Keine three-Objekte.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ImportedMesh {
    pub id: String,
    pub name: String,
    /// Ursprünglicher DXF-Layer-Name (für spätere Kategorisierung).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer: Option<String>,
    /// Grafik-Kategorie-Code (s. {@link LayerCategory}, `model/contextCategories.ts`)
    /// — steuert Sichtbarkeit/Grau/Sperren wie bei jedem anderen Bauteil (Ebenen-
    /// Panel). Fehlt er (ältere Importe vor dieser Erweiterung), bleibt das Objekt
    /// IMMER sichtbar (Rückwärtskompatibilität), s. `plan/context.rs` im Kern.
    #[serde(rename = "categoryCode", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub category_code: Option<String>,
    /// Farbe aus der Quelldatei (`#rrggbb`, z. B. IFC-Oberflächenstil/Material); fehlt sie, gilt die Kontext-Grundfarbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// IFC-GlobalId des Quell-Bauteils (IFC-Import je Bauteil).
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
    pub positions: Vec<f64>,
    pub indices: Vec<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ContourCurveKind {
    #[default]
    #[serde(rename = "circle")]
    Circle,
    #[serde(rename = "arc")]
    Arc,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ContourCurve {
    #[ts(inline)]
    pub kind: ContourCurveKind,
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    pub a0: f64,
    pub a1: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Eine einzelne Kontur (Höhenlinie / Polylinie) auf konstanter Höhe `z`. `pts`
/// sind 2D-Stützpunkte (x,y) in Metern; `closed` schließt den Linienzug.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Contour {
    pub z: f64,
    pub pts: Vec<Vec2>,
    pub closed: bool,
    /// Ursprünglicher DXF-Layer-Name (für die Kategorisierung beim 2D-Import).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer: Option<String>,
    /// Gefüllte Fläche (aus einer DXF-HATCH). Beim Drawing-Import wird daraus eine
    /// geschlossene, gefüllte 2D-Form (Vollton-Füllung); sonst nur ein Umriss.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filled: Option<bool>,
    /// Wahre Kurvengeometrie (aus CIRCLE/ARC). `pts` bleibt tesselliert (Kontext/
    /// 3D), aber der Drawing-Import baut daraus eine GLATTE `{shape:"circle"|"arc"}`-
    /// Form statt eines Vielecks. Winkel in RADIANT (CCW); Kreis = a0..a1 über 2π.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub curve: Option<ContourCurve>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Satz Konturen (z. B. alle Höhenlinien eines DXF-Imports).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ContourSet {
    pub id: String,
    pub name: String,
    /// Ursprünglicher DXF-Layer-Name (für spätere Kategorisierung).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer: Option<String>,
    /// Grafik-Kategorie-Code, s. {@link ImportedMesh.categoryCode}.
    #[serde(rename = "categoryCode", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub category_code: Option<String>,
    pub contours: Vec<Contour>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein TIN-Geländemodell, abgeleitet aus Konturen (Delaunay über (x,y), Z aus der
/// jeweiligen Kontur-Höhe). `positions` = flaches (x,y,z…)-Array in Metern,
/// `indices` = Dreiecks-Indizes. Gelände ist NICHT semantisch (Kontext-Schicht).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct TerrainMesh {
    pub id: String,
    pub name: String,
    /// Ebenen-/Gruppierungsname (SitePanel), z. B. „Terrain". Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer: Option<String>,
    /// Grafik-Kategorie-Code, s. {@link ImportedMesh.categoryCode}.
    #[serde(rename = "categoryCode", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub category_code: Option<String>,
    pub positions: Vec<f64>,
    pub indices: Vec<f64>,
    /// Optionale Pro-Vertex-Albedo (flach `[r,g,b, …]`, 0..1) — ein Wert je
    /// Positions-Vertex, beim Import aus einem SWISSIMAGE-Luftbild gesampelt
    /// („Luftbild aufs Gelände drapieren"). render3d färbt das TIN dann pro Vertex
    /// statt mit der Grundfarbe. Fehlt es, bleibt das Gelände einfarbig.
    #[serde(rename = "vertexColors", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vertex_colors: Option<Vec<f64>>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ContextImageFilters {
    /// 0 = Graustufen, 1 = Original, >1 = übersättigt. Default 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub saturation: Option<f64>,
    /// 0 = schwarz, 1 = Original, >1 = heller. Default 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub brightness: Option<f64>,
    /// 0 = flaches Grau, 1 = Original, >1 = kontrastreicher. Default 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub contrast: Option<f64>,
    /// 0 = kein Effekt, 1 = vollständig Graustufen. Default 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub grayscale: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein georeferenziertes Rasterbild (Luftbild/SWISSIMAGE, eingefügtes Bild) —
/// planar von oben auf die Modell-Ebene gelegt. `src` = Data-URL (PNG/JPEG),
/// `min`/`max` = Modell-Meter-Bounding-Box, die das Bild ausfüllt (Bild-Oben =
/// +Y). Wird im Grundriss als Hintergrund-Ebene gezeichnet (unter der Geometrie).
/// Gelände-Drapierung im 3D ist Folge-Arbeit.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ContextImage {
    pub id: String,
    pub name: String,
    /// Ebenen-/Gruppierungsname (SitePanel), z. B. „Luftbild". Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer: Option<String>,
    /// Grafik-Kategorie-Code, s. {@link ImportedMesh.categoryCode}.
    #[serde(rename = "categoryCode", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub category_code: Option<String>,
    /// Bildquelle als Data-URL (PNG/JPEG).
    pub src: String,
    /// Modell-Meter Bounding-Box (das Bild füllt [min..max] planar von oben).
    pub min: Vec2,
    pub max: Vec2,
    /// Deckkraft 0..1 (Default 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub opacity: Option<f64>,
    /// Aufs Gelände-TIN „drapieren": im 3D-Viewer wird das Bild als Textur über das
    /// Terrain gelegt (pixelscharf, s. render3d `set_aerial_texture`). Unabhängig von
    /// der 2D-Hintergrund-Darstellung. Default false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub drape: Option<bool>,
    /// Bildkorrektur (2D-Grundriss, CSS-`filter`-Semantik) — alle Werte optional,
    /// fehlend = neutral (kein visueller Unterschied zu keinem Filter). `grayscale`
    /// ist eine STETIGE 0..1-Blendung (nicht der binäre `mono`-Druckmodus von
    /// `generatePlan()`, der Luftbilder ganz ausblendet — unabhängige Konzepte).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub filters: Option<ContextImageFilters>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

impl Project {
    /// Setzt EIN Feld aus dem JSON-Baum (`None` = Feld entfernt → Standardwert); so bleibt die
    /// typisierte Sicht nach einer Op ohne Neu-Parsen des ganzen Projekts aktuell.
    pub fn set_field(&mut self, key: &str, v: Option<&serde_json::Value>) -> Result<(), String> {
        match key {
            "formatVersion" => {
                self.format_version = match v {
                    Some(v) => <Option<f64>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "id" => {
                self.id = match v {
                    Some(v) => <String>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "name" => {
                self.name = match v {
                    Some(v) => <String>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "lineStyles" => {
                self.line_styles = match v {
                    Some(v) => <Vec<LineStyle>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "textStyles" => {
                self.text_styles = match v {
                    Some(v) => <Option<Vec<TextStylePreset>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "hatches" => {
                self.hatches = match v {
                    Some(v) => <Vec<HatchStyle>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "components" => {
                self.components = match v {
                    Some(v) => <Vec<Component>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "wallTypes" => {
                self.wall_types = match v {
                    Some(v) => <Vec<WallType>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "ceilingTypes" => {
                self.ceiling_types = match v {
                    Some(v) => <Option<Vec<CeilingType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "roofTypes" => {
                self.roof_types = match v {
                    Some(v) => <Option<Vec<RoofType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "blockDefs" => {
                self.block_defs = match v {
                    Some(v) => <Option<Vec<BlockDef>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "doorTypes" => {
                self.door_types = match v {
                    Some(v) => <Option<Vec<DoorType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "windowTypes" => {
                self.window_types = match v {
                    Some(v) => <Option<Vec<WindowType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "stairTypes" => {
                self.stair_types = match v {
                    Some(v) => <Option<Vec<StairType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "pens" => {
                self.pens = match v {
                    Some(v) => <Option<Vec<ColorPen>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "penSets" => {
                self.pen_sets = match v {
                    Some(v) => <Option<Vec<PenSet>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "activePenSetId" => {
                self.active_pen_set_id = match v {
                    Some(v) => <Option<String>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "customPalettes" => {
                self.custom_palettes = match v {
                    Some(v) => <Option<Vec<CustomPalette>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "builtinPaletteBanks" => {
                self.builtin_palette_banks = match v {
                    Some(v) => <Option<BuiltinPaletteBanks>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "drawingLevels" => {
                self.drawing_levels = match v {
                    Some(v) => <Vec<DrawingLevel>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "roomProgram" => {
                self.room_program = match v {
                    Some(v) => <Option<Vec<RoomProgramRow>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "roomProgramTolerance" => {
                self.room_program_tolerance = match v {
                    Some(v) => <Option<f64>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "parcelArea" => {
                self.parcel_area = match v {
                    Some(v) => <Option<f64>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "sunStudy" => {
                self.sun_study = match v {
                    Some(v) => <Option<SunStudy>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "siteRules" => {
                self.site_rules = match v {
                    Some(v) => <Option<SiteRules>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "scaleLineWeights" => {
                self.scale_line_weights = match v {
                    Some(v) => <Option<bool>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "layers" => {
                self.layers = match v {
                    Some(v) => <Vec<LayerCategory>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "walls" => {
                self.walls = match v {
                    Some(v) => <Vec<Wall>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "ceilings" => {
                self.ceilings = match v {
                    Some(v) => <Option<Vec<Ceiling>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "roofs" => {
                self.roofs = match v {
                    Some(v) => <Option<Vec<Roof>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "openings" => {
                self.openings = match v {
                    Some(v) => <Option<Vec<Opening>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "stairs" => {
                self.stairs = match v {
                    Some(v) => <Option<Vec<Stair>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "rooms" => {
                self.rooms = match v {
                    Some(v) => <Option<Vec<Room>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "drawings2d" => {
                self.drawings2d = match v {
                    Some(v) => <Vec<Drawing2D>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "context" => {
                self.context = match v {
                    Some(v) => <Option<Vec<ContextObject>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "extrudedSolids" => {
                self.extruded_solids = match v {
                    Some(v) => <Option<Vec<ExtrudedSolid>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "columns" => {
                self.columns = match v {
                    Some(v) => <Option<Vec<Column>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "groups" => {
                self.groups = match v {
                    Some(v) => <Option<Vec<Group>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "parametricWalls" => {
                self.parametric_walls = match v {
                    Some(v) => <Option<Vec<ParametricWall>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "overrideRules" => {
                self.override_rules = match v {
                    Some(v) => <Option<Vec<OverrideRule>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "viewSnapshots" => {
                self.view_snapshots = match v {
                    Some(v) => <Option<Vec<ViewSnapshot>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "viewSnapshotFolders" => {
                self.view_snapshot_folders = match v {
                    Some(v) => <Option<Vec<ViewSnapshotFolder>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "layouts" => {
                self.layouts = match v {
                    Some(v) => <Option<Vec<Layout>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "masterLayouts" => {
                self.master_layouts = match v {
                    Some(v) => <Option<Vec<MasterLayout>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "layoutFolders" => {
                self.layout_folders = match v {
                    Some(v) => <Option<Vec<LayoutFolder>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "referenceElevationMasl" => {
                self.reference_elevation_masl = match v {
                    Some(v) => <Option<f64>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "geoAnchor" => {
                self.geo_anchor = match v {
                    Some(v) => <Option<ProjectGeoAnchor>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            other => match v {
                Some(v) => {
                    self.extra.0.insert(other.to_owned(), v.clone());
                }
                None => {
                    self.extra.0.remove(other);
                }
            },
        }
        Ok(())
    }
}

