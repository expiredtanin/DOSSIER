// Projektmodell ([K4] S2/S4): QUELLE der Datentypen. Einmal (28.10.) aus den damaligen TS-Typen
// übersetzt, seither von Hand gepflegt; `src/model/types.generated.ts` wird hieraus erzeugt
// (`npm run gen:types`, Regeln in `ts_export.rs`). Union-Typen mit Tag stehen in `manual.rs`.
#![allow(clippy::large_enum_variant)]
use super::manual::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Linienenden aller Striche im Plan/Schnitt/Ansicht und in den Exporten ([146]); fehlt = flach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum LineCap {
    #[default]
    #[serde(rename = "butt")]
    Butt,
    #[serde(rename = "round")]
    Round,
    #[serde(rename = "square")]
    Square,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Linienecken (Stoss zweier Segmente eines Zugs) ([146]); fehlt = Gehrung (Grenze 4, sonst gefast).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum LineJoin {
    #[default]
    #[serde(rename = "miter")]
    Miter,
    #[serde(rename = "round")]
    Round,
    #[serde(rename = "bevel")]
    Bevel,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

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
    /// @deprecated Nur noch für die Migration alter Dateien gelesen ([110], Format 4): Ein Linienstil
    /// legt nur das Muster (Volllinie, Strich, Punkt, Zickzack …) und die Farbe fest — die Strichstärke
    /// kommt vom Element (`Drawing2D.weightMm`), der Schraffur (`HatchStyle.lineWeight`), der
    /// Schichtfuge (`Layer.jointWeightMm`) bzw. Ebene/Stift. Die Migration trägt das alte Gewicht dort
    /// ein und entfernt es hier; die Renderer werten es nicht mehr aus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub weight: Option<f64>,
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
    /// Hartschaum (EPS/XPS, [109]): Zickzack über die ganze Schichtdicke.
    #[serde(rename = "insulationHard")]
    InsulationHard,
    /// Holzfaser-Dämmung ([109]): Sinuswelle über die ganze Schichtdicke.
    #[serde(rename = "insulationWave")]
    InsulationWave,
    /// Holz im Querschnitt ([109]): Diagonalkreuz je Querschnittsfeld über die Schichtdicke.
    #[serde(rename = "timber")]
    Timber,
    /// Erdreich ([109]): Gruppen kurzer Striche, wechselnd ±45° (Flechtmuster).
    #[serde(rename = "earth")]
    Earth,
    /// Kies/Geröll ([109]): kleine Kreise auf gestreutem Raster.
    #[serde(rename = "gravel")]
    Gravel,
    /// Naturstein ([109], SIA 400 Fig. 34): Diagonale paarweise (zweite Linie bei ⅓ der Teilung).
    #[serde(rename = "stone")]
    Stone,
    /// Punktfeld ([109], Putz): feine Punkte im versetzten Raster.
    #[serde(rename = "dots")]
    Dots,
    /// Holzwerkstoffe (SIA 400 Fig. 34): 45°-Linien in Dreiergruppen.
    #[serde(rename = "woodBased")]
    WoodBased,
    /// Holz massiv (SIA 400 Fig. 34): dichte Parallelen mit unregelmässigem Abstand (Maserung).
    #[serde(rename = "wood")]
    Wood,
    /// Sperrschicht (Wind, Dampf, Wasser; SIA 400 Fig. 34): kräftige Strichlinie auf der Schichtmitte.
    #[serde(rename = "barrier")]
    Barrier,
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
    /// Optionaler Linienstil für die Musterlinien (Line Manager): nur Muster/Farbe.
    #[serde(rename = "lineStyleId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_style_id: Option<String>,
    /// Strichstärke der Musterlinien in Papier-mm ([110]); fehlt sie, gilt 0.13.
    #[serde(rename = "lineWeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_weight: Option<f64>,
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

/// Art einer Ansichtsschraffur ([100]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SurfacePatternKind {
    /// Parallele Linien im Abstand `spacing` (Lattung, Schalung, Stehfalz).
    #[default]
    #[serde(rename = "lines")]
    Lines,
    /// Boden-Deckel-Schalung: Deckleisten der Breite `width` im Abstand `spacing`.
    #[serde(rename = "boardBatten")]
    BoardBatten,
    /// Läuferverband: Lagen der Höhe `height`, Stossfugen alle `spacing`, je Lage um ½ versetzt.
    #[serde(rename = "runningBond")]
    RunningBond,
    /// Schindeln: Lagen der Höhe `height`, Stossfugen alle `spacing`, je Lage um ⅓ versetzt.
    #[serde(rename = "shingles")]
    Shingles,
    /// Trapezblech: je Rippe (Abstand `spacing`, Obergurt `width`) vier Linien.
    #[serde(rename = "trapezoid")]
    Trapezoid,
    /// Naturstein polygonal: unregelmässiges Netz um die Steingrösse `spacing`.
    #[serde(rename = "polygonal")]
    Polygonal,
    /// Plattenteilung: Raster `spacing` × `height` ohne Versatz.
    #[serde(rename = "grid")]
    Grid,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Richtung der Musterlinien gegenüber dem Element ([94]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SurfacePatternDirection {
    /// Hauptlinien senkrecht (quer zur Wandachse; bei Dächern in Falllinie).
    #[default]
    #[serde(rename = "vertical")]
    Vertical,
    /// Hauptlinien waagrecht (entlang der Wandachse; bei Dächern traufparallel).
    #[serde(rename = "horizontal")]
    Horizontal,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ansichtsschraffur eines Bauteils ([100]): Muster auf sichtbaren Flächen, im Kern zu Linien gerechnet
/// (`surface_pattern.rs`). Masse in Metern am Bau; Ursprung an der Elementkante (Wandanfang/UK, Traufe).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SurfacePattern {
    #[ts(inline)]
    pub kind: SurfacePatternKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub direction: Option<SurfacePatternDirection>,
    /// Hauptabstand (m): Linien-/Rippenabstand, Steinlänge, Plattenbreite.
    pub spacing: f64,
    /// Lagen-/Plattenhöhe (m; Läuferverband, Schindeln, Raster). Fehlt sie, gilt `spacing`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<f64>,
    /// Breite (m) der Deckleiste bzw. des Trapez-Obergurts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub width: Option<f64>,
    /// Grunddrehung (Grad) zusätzlich zur Richtung.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub angle: Option<f64>,
    /// Strichstärke (Papier-mm); Default 0.1.
    #[serde(rename = "weightMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub weight_mm: Option<f64>,
    /// Linienfarbe; Default Vordergrund des Bauteils bzw. Dunkelgrau.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
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
    /// Wärmeleitfähigkeit λ in W/(m·K) (Bemessungswert, z. B. SIA 381/1, Herstellerangabe).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lambda: Option<f64>,
    /// Rohdichte in kg/m³.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub density: Option<f64>,
    /// Brandverhalten nach VKF (Brandschutzrichtlinie 13-15): "RF1" (kein Brandbeitrag), "RF2"
    /// (geringer), "RF3" (zulässiger), "RF4" (unzulässig). Freitext, damit auch Zusätze („RF1 (cr)") gehen.
    #[serde(rename = "fireClass", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fire_class: Option<String>,
    /// Flächenfarbe in der Ansicht (Fassade/Dachaufsicht). Fehlt sie, gilt die bisherige Farbe.
    #[serde(rename = "elevationColor", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub elevation_color: Option<String>,
    /// Ansichtsschraffur ([100]): Oberflächenmuster, das auf sichtbaren Flächen dieses Bauteils gezeichnet
    /// wird (Ansicht, Dachaufsicht im Grundriss). Masse in Metern am Bau, Ausrichtung am Element.
    #[serde(rename = "surfacePattern", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub surface_pattern: Option<SurfacePattern>,
    /// Herkunft: Kennung des Standard-Eintrags ([100], „Standards laden"), damit erneutes Laden nichts verdoppelt.
    #[serde(rename = "standardId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub standard_id: Option<String>,
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
    /// Strichstärke der Schichtfuge in Papier-mm ([110]); fehlt sie, gilt die Standard-Fuge.
    #[serde(rename = "jointWeightMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub joint_weight_mm: Option<f64>,
    /// [33] Funktion der Schicht im Aufbau (tragend, Dämmung, Unterlagsboden …) für Grafik-Overrides auf
    /// Schichten. Fehlt sie, leitet der Kern sie aus dem Baustoff ab (`plan::overrides::layer_function`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub function: Option<LayerFunction>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [33] Funktion einer Bauteilschicht (für Override-Regeln auf Schichten).
///   • "structure"    — tragend (Beton, Mauerwerk, Holz-/Stahltragwerk)
///   • "insulation"   — Wärme-/Trittschalldämmung
///   • "screed"       — Unterlagsboden/Estrich
///   • "finish"       — Belag (Parkett, Platten)
///   • "plaster"      — Putz, Gipsbekleidung
///   • "substructure" — Unterbau (Kies, Magerbeton, Erdreich)
///   • "membrane"     — Abdichtung, Dampfbremse
///   • "cladding"     — Bekleidung, Eindeckung, Lattung
///   • "air"          — Luftschicht, Hinterlüftung
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum LayerFunction {
    #[serde(rename = "structure")]
    Structure,
    #[serde(rename = "insulation")]
    Insulation,
    #[serde(rename = "screed")]
    Screed,
    #[serde(rename = "finish")]
    Finish,
    #[serde(rename = "plaster")]
    Plaster,
    #[serde(rename = "substructure")]
    Substructure,
    #[serde(rename = "membrane")]
    Membrane,
    #[serde(rename = "cladding")]
    Cladding,
    #[serde(rename = "air")]
    Air,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
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
    /// Taschen-Schiebetür: Blatt läuft in eine Tasche in der Wand, Taschenseite = Bandseite (`hinge`) ([95]).
    #[serde(rename = "tasche")]
    Tasche,
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
    /// Blendrahmen ([105]): Rahmen VOR der Wandfläche (Aufschlagseite), überdeckt die Leibungskante.
    #[serde(rename = "blendrahmen")]
    Blendrahmen,
    /// Umfassungszarge ([105]): Stahlzarge umfasst die ganze Wanddicke, Spiegel beidseitig.
    #[serde(rename = "umfassungszarge")]
    Umfassungszarge,
    /// Eckzarge ([105]): Winkel-Stahlzarge nur auf der Aufschlagseite (Spiegel + Falz).
    #[serde(rename = "eckzarge")]
    Eckzarge,
    /// Blockzarge ([105]): Holz-Blockzarge über die ganze Leibungstiefe, Falz auf der Aufschlagseite.
    #[serde(rename = "blockzarge")]
    Blockzarge,
    /// Futter und Bekleidung ([105]): Futterbrett in der Leibung, Bekleidung auf einer/beiden Wandflächen.
    #[serde(rename = "futter")]
    Futter,
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
    /// Linientyp der Sturzlinien im Grundriss ([105]); fehlt ⇒ gestrichelt.
    #[serde(rename = "lintelLineStyle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lintel_line_style: Option<LintelLineStyle>,
    /// Rahmen-Detail ([105]): Blendrahmen je Seite, Flügelrahmen, Pfosten/Kämpfer, Zusatzprofile,
    /// Anschlag je Seite. Fehlt ⇒ wie bisher (`frameWidth`, `rebateDepth`).
    #[serde(rename = "frameDetail", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_detail: Option<FrameDetail>,
    /// Schichteinzug ([106]): wie die Wandschichten an Leibung, Sturz und Brüstung anschliessen.
    /// Fehlt ⇒ alle Schichten bündig (bzw. `innerLayerRecess`, veraltet).
    #[serde(rename = "layerReveals", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer_reveals: Option<Vec<LayerReveal>>,
    /// Masse der Türzarge/des Türrahmens ([105]): Falz, Spiegel, Futter, Bekleidung.
    #[serde(rename = "doorFrame", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub door_frame: Option<DoorFrameDetail>,
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
    /// Veraltet ([106]): gilt nur ohne {@link layerReveals} (= innerste Schicht „zurück um Schichtdicke").
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
    /// Brüstungsfeld unten ([95]): Höhe ab Öffnungs-Unterkante bis Mitte des Riegels (Meter), darunter
    /// ein festes Feld. 0/fehlt ⇒ keins (bisher).
    #[serde(rename = "bottomPanelHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bottom_panel_height: Option<f64>,
    /// Einteilung des Brüstungsfelds (Pfosten/Riegel wie {@link transomSashes}, je Feld fest oder
    /// öffenbar). Fehlt ⇒ ein festes Glasfeld.
    #[serde(rename = "bottomSashes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bottom_sashes: Option<Vec<SashDef>>,
    /// Öffnungslinien der Flügel in der Ansicht (Dreh-/Kipp-Dreiecke, [95]). Fehlt ⇒ an.
    #[serde(rename = "sashSymbols", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sash_symbols: Option<bool>,
    /// Aufschlagbogen der Drehflügel im Grundriss (zur Innenseite, [95]). Fehlt ⇒ aus.
    #[serde(rename = "planSwingArcs", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan_swing_arcs: Option<bool>,
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
    /// Rahmen-Detail ([105]): Blendrahmen je Seite, Flügelrahmen, Pfosten/Kämpfer, Zusatzprofile,
    /// Anschlag je Seite. Fehlt ⇒ wie bisher (`frameWidth`, `rebateDepth`).
    #[serde(rename = "frameDetail", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_detail: Option<FrameDetail>,
    /// Schichteinzug ([106]): wie die Wandschichten an Leibung, Sturz und Brüstung anschliessen.
    /// Fehlt ⇒ alle Schichten bündig (bzw. `innerLayerRecess`, veraltet).
    #[serde(rename = "layerReveals", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer_reveals: Option<Vec<LayerReveal>>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

// ── [105] Rahmen-/Anschlag-Details, [106] Schichteinzug ─────────────────────

/// Werte je Seite einer Öffnung (Meter). `left` = Leibung beim Wandanfang (kleineres Achsmass),
/// `right` = beim Wandende, `top` = Sturz, `bottom` = Brüstung/Schwelle. Fehlt ⇒ Rückfallwert.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct OpeningSides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub left: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub right: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub top: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bottom: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Rahmen-Detail eines Fenster-/Türtyps ([105]); an der Öffnung feldweise übersteuerbar
/// (`Opening.frameDetail`). Alle Masse in Metern, fehlend ⇒ Typ-Wert bzw. bisheriges Verhalten.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct FrameDetail {
    /// Blendrahmen: Ansichtsbreite je Seite (fehlt ⇒ `frameWidth`).
    #[serde(rename = "frameSides", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_sides: Option<OpeningSides>,
    /// Blendrahmen-Tiefe quer zur Wand (übersteuert `frameDepth`).
    #[serde(rename = "frameDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_depth: Option<f64>,
    /// Lage: Abstand der Rahmen-Vorderkante von der Fläche `insetFace` (übersteuert `insetFromFace`).
    #[serde(rename = "insetFromFace", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inset_from_face: Option<f64>,
    /// Bezugsfläche der Lage (übersteuert `insetFace`).
    #[serde(rename = "insetFace", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub inset_face: Option<WindowTypeInsetFace>,
    /// Flügelrahmen: Ansichtsbreite (fehlt ⇒ wie Blendrahmen).
    #[serde(rename = "sashWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sash_width: Option<f64>,
    /// Flügelrahmen: Tiefe quer zur Wand (fehlt ⇒ Blendrahmen-Tiefe).
    #[serde(rename = "sashDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sash_depth: Option<f64>,
    /// Flügel-Überschlag: so weit überdeckt der Flügel den Blendrahmen (fehlt ⇒ 0).
    #[serde(rename = "sashOverlap", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sash_overlap: Option<f64>,
    /// Pfosten (senkrechte Teilung): Breite (fehlt ⇒ `postWidth` der Flügeltabelle).
    #[serde(rename = "mullionWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mullion_width: Option<f64>,
    /// Pfosten-Tiefe (fehlt ⇒ Blendrahmen-Tiefe).
    #[serde(rename = "mullionDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mullion_depth: Option<f64>,
    /// Kämpfer (waagrechte Teilung, Riegel): Breite (fehlt ⇒ wie Blendrahmen).
    #[serde(rename = "transomWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transom_width: Option<f64>,
    /// Kämpfer-Tiefe (fehlt ⇒ Blendrahmen-Tiefe).
    #[serde(rename = "transomDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transom_depth: Option<f64>,
    /// Verbreiterungsprofile je Seite (Ansichtsbreite, aussen am Blendrahmen angesetzt).
    #[serde(rename = "extensionProfiles", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extension_profiles: Option<OpeningSides>,
    /// Fensterbank-Anschlussprofil unten (Höhe, unter dem Blendrahmen).
    #[serde(rename = "sillProfile", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sill_profile: Option<f64>,
    /// Storen-/Rollladen-Anschlussprofil oben (Höhe, über dem Blendrahmen).
    #[serde(rename = "shadingProfile", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shading_profile: Option<f64>,
    /// Anschlag je Seite (Meter; übersteuert `rebateDepth`, 0 = kein Anschlag auf dieser Seite).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rebates: Option<OpeningSides>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Bekleidung einer Tür ([105]): auf der Aufschlagseite, der Gegenseite, beidseitig oder keine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum CasingSides {
    #[default]
    #[serde(rename = "beide")]
    Beide,
    #[serde(rename = "aufschlag")]
    Aufschlag,
    #[serde(rename = "gegen")]
    Gegen,
    #[serde(rename = "keine")]
    Keine,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Masse einer Türzarge/eines Türrahmens ([105]); Bedeutung je `frameKind`. Fehlt ⇒ Vorgabe.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct DoorFrameDetail {
    /// Falzbreite (parallel zur Wandfläche: Überdeckung Blatt/Rahmen), Vorgabe 0.015.
    #[serde(rename = "falzWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub falz_width: Option<f64>,
    /// Falztiefe (quer zur Wand, ≈ Blattdicke), Vorgabe 0.04.
    #[serde(rename = "falzDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub falz_depth: Option<f64>,
    /// Spiegelbreite der Stahlzarge auf der Wandfläche, Vorgabe 0.05.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub spiegel: Option<f64>,
    /// Blechdicke der Stahlzarge, Vorgabe 0.002.
    #[serde(rename = "sheetThickness", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sheet_thickness: Option<f64>,
    /// Futterstärke (Brett in der Leibung), Vorgabe 0.025.
    #[serde(rename = "liningThickness", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lining_thickness: Option<f64>,
    /// Bekleidungsbreite, Vorgabe 0.07.
    #[serde(rename = "casingWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub casing_width: Option<f64>,
    /// Bekleidungsdicke, Vorgabe 0.012.
    #[serde(rename = "casingThickness", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub casing_thickness: Option<f64>,
    /// Bekleidung auf welcher Seite (Vorgabe beide).
    #[serde(rename = "casingSides", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub casing_sides: Option<CasingSides>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Wie eine Wandschicht an der Öffnung anschliesst ([106]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum RevealMode {
    /// Schicht endet bündig an der Rohbauöffnung (bisher).
    #[default]
    #[serde(rename = "buendig")]
    Buendig,
    /// Schicht springt um `amount` zurück (fehlt ⇒ um ihre eigene Dicke).
    #[serde(rename = "zurueck")]
    Zurueck,
    /// Schicht läuft in die Leibung bis an den Rahmen (Dicke dort `amount`, fehlt ⇒ Schichtdicke, höchstens 4 cm).
    #[serde(rename = "leibung")]
    Leibung,
    /// Schicht überdeckt den Rahmen um `amount` (fehlt ⇒ 3 cm), nur vor dem Rahmen.
    #[serde(rename = "ueberdaemmt")]
    Ueberdaemmt,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Abweichende Regel für eine Seite ([106]).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct RevealSide {
    pub mode: RevealMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub amount: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Schichteinzug einer Wandschicht an der Öffnung ([106]): Regel für alle Seiten, je Seite
/// übersteuerbar. `layer` zählt ab aussen (0 = äusserste Schicht); negativ ab innen (−1 = innerste),
/// damit dieselbe Regel für verschiedene Wandtypen gilt.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayerReveal {
    pub layer: f64,
    pub mode: RevealMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub left: Option<RevealSide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub right: Option<RevealSide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub top: Option<RevealSide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bottom: Option<RevealSide>,
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
///   • "ceiling"   — Deckenspiegel ([100]): Untersicht eines Geschosses (`ceilingOfId`), von der
///                   Schnitthöhe nach oben gesehen, in Grundriss-Lage gespiegelt (deckt den Grundriss).
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
    #[serde(rename = "ceiling")]
    Ceiling,
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
    /// Bezugsgeschoss ±0.00 ([131], nur Geschoss): OK fertig Boden dieses Geschosses ist ±0.00
    /// (Modell-z 0, m ü. M. = `Project.referenceElevationMasl`); Geschosse darunter erhalten negative
    /// `baseElevation`. Höchstens ein Geschoss trägt das Kennzeichen; fehlt es, ist das erste Geschoss
    /// der Bezug (Verhalten vor Format 5).
    #[serde(rename = "zeroLevel", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub zero_level: Option<bool>,
    /// Deckenspiegel ([100], nur kind "ceiling"): ID des Geschosses, dessen Untersicht gezeigt wird
    /// (Wände geschnitten auf seiner Schnitthöhe, Decken-/Dachuntersicht darüber). Eigene 2D-Elemente
    /// der Ebene (z. B. Leuchten) kommen dazu.
    #[serde(rename = "ceilingOfId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ceiling_of_id: Option<String>,
    /// Schnitt-/Ansichtslinie im Grundriss (nur Schnitt/Ansicht).
    #[serde(rename = "linePoints", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_points: Option<[Vec2; 2]>,
    /// Knickpunkte einer geknickten Schnittlinie ([176]), der Reihe nach zwischen `linePoints[0]` und
    /// `linePoints[1]`. Fehlt/leer ⇒ gerade Linie (altes Format). Nur Darstellung im Grundriss; der Schnitt selbst
    /// folgt weiter der Verbindung der Endpunkte.
    #[serde(rename = "bendPoints", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bend_points: Option<Vec<Vec2>>,
    /// [176] Schnittmarke im Grundriss: "arrow" (Pfeil mit Dreieck, Basis) oder "lAngle" (nur ein L je Ende). Fehlt ⇒ die
    /// Vorgabe der Modelldarstellung (`sectionMarks.style`), sonst Pfeil. Nur Schnitt.
    #[serde(rename = "markerStyle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub marker_style: Option<SectionMarkerStyle>,
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
    /// Skizzenstil ([67]): Striche leicht gewellt, an Enden und Ecken überzogen (Präsentation).
    /// Wirkt auf Grundriss, Schnitt und Ansicht dieser Ebene; Default aus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sketch: Option<bool>,
    /// [140] Schnittflächen (Wände, Stützen, Decken) auch ab 1:100 mit Schichten und Schraffur statt als
    /// schwarze Fläche (Poché). Fehlt/aus: ab 1:100 schwarz, 1:50 und Detail „fein" schraffiert.
    #[serde(rename = "cutHatch", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cut_hatch: Option<bool>,
    /// [156] Bodenbelag-Muster im Grundriss: fehlt = automatisch (ab 1:50 bzw. Detail „fein" alle, gröber keine).
    #[serde(rename = "floorFinish", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_finish: Option<FloorFinishDisplay>,
    /// [157] Gelände, Höhenlinien und Baugruben im Grundriss: fehlt = automatisch (nur im Geschoss nächst ±0.00
    /// und ab 1:500), `true` immer, `false` nie. Schatten der Sonnenstudie bleiben davon unberührt.
    #[serde(rename = "showTerrain", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_terrain: Option<bool>,
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
    /// Ansichtsbereich ([36], nur Geschoss): Oberkante der Sichtweite über OKFF in Metern. Bauteile,
    /// die ganz darüber liegen, entfallen; darunter bis zur Schnitthöhe erscheinen sie als „über
    /// Schnitt“ (gestrichelt). Fehlt ⇒ unbegrenzt (heutiges Verhalten).
    #[serde(rename = "viewTop", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_top: Option<f64>,
    /// Ansichtsbereich ([36], nur Geschoss): Unterkante der Sichtweite über OKFF in Metern (auch
    /// negativ). Bauteile ganz darunter entfallen (oder erscheinen gepunktet, s. `viewDepth`).
    /// Fehlt ⇒ unbegrenzt.
    #[serde(rename = "viewBottom", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_bottom: Option<f64>,
    /// Ansichtsbereich ([36], nur Geschoss): „darunter sichtbar bis“ — Tiefe in Metern unter
    /// `viewBottom`, bis zu der Bauteile gepunktet („unter Schnitt“) erscheinen. Fehlt/0 ⇒ keine.
    #[serde(rename = "viewDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_depth: Option<f64>,
    /// Ansichtsvorlage ([34]), mit der diese Ansicht (Geschoss/Schnitt/Ansicht) einmal angewendet
    /// oder verknüpft wurde.
    #[serde(rename = "templateId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template_id: Option<String>,
    /// `true` ⇒ die Ansicht folgt der Vorlage (Änderungen an der Vorlage wirken); sonst nur einmal angewendet.
    #[serde(rename = "templateLinked", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template_linked: Option<bool>,
    /// [173] Modelldarstellung (`Project.modelViewOptions`, Id einer eigenen Stufe oder „grob"/„mittel"/„fein").
    /// Fehlt ⇒ der Detailgrad allein bestimmt die Darstellung (heutiges Verhalten).
    #[serde(rename = "modelViewOptionId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_view_option_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ansichtsvorlage ([34]): ein benannter Satz Ansichts-Einstellungen für Grundriss, Schnitt, Ansicht
/// und Ausschnitte. Jedes Feld ist optional — fehlt es, lässt die Vorlage diese Einstellung unberührt.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ViewTemplate {
    pub id: String,
    pub name: String,
    /// Detailgrad (grob/mittel/fein).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<DetailLevel>,
    /// Papier-Massstab „1:N“ (der Nenner).
    #[serde(rename = "scaleDenominator", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scale_denominator: Option<f64>,
    /// Sichtbare Kategorien: `code` → sichtbar (Kategorien, die fehlen, bleiben unberührt).
    #[serde(rename = "layerVisibility", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer_visibility: Option<std::collections::BTreeMap<String, bool>>,
    /// Ids der aktiven Override-Regeln (alle übrigen aus).
    #[serde(rename = "enabledOverrideRuleIds", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled_override_rule_ids: Option<Vec<String>>,
    /// Darstellungsmodus der Geschosse (`all_force` … `locked`).
    #[serde(rename = "displayMode", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_mode: Option<String>,
    /// Schwarz-Weiss.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mono: Option<bool>,
    /// Schatten (Ansicht).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shadows: Option<bool>,
    /// Verdeckte Kanten (Schnitt/Ansicht).
    #[serde(rename = "hiddenLines", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hidden_lines: Option<bool>,
    /// Skizzenstil ([67]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sketch: Option<bool>,
    /// [140] Schnittflächen ab 1:100 schraffiert statt schwarz (s. `DrawingLevel::cut_hatch`).
    #[serde(rename = "cutHatch", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cut_hatch: Option<bool>,
    /// [156] Bodenbelag-Muster im Grundriss (s. `DrawingLevel::floor_finish`).
    #[serde(rename = "floorFinish", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_finish: Option<FloorFinishDisplay>,
    /// [157] Gelände im Grundriss zeigen (s. `DrawingLevel::show_terrain`).
    #[serde(rename = "showTerrain", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_terrain: Option<bool>,
    /// Strichstärken mit dem Massstab skalieren.
    #[serde(rename = "scaleLineWeights", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scale_line_weights: Option<bool>,
    /// Schnitthöhe über OKFF ([36]).
    #[serde(rename = "cutHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cut_height: Option<f64>,
    /// Ansichtsbereich: Oberkante ([36]).
    #[serde(rename = "viewTop", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_top: Option<f64>,
    /// Ansichtsbereich: Unterkante ([36]).
    #[serde(rename = "viewBottom", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_bottom: Option<f64>,
    /// Ansichtsbereich: darunter sichtbar bis ([36]).
    #[serde(rename = "viewDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_depth: Option<f64>,
    /// [173] Modelldarstellung (`Project.modelViewOptions`, Id einer eigenen Stufe oder „grob"/„mittel"/„fein").
    /// Fehlt ⇒ der Detailgrad allein bestimmt die Darstellung (heutiges Verhalten).
    #[serde(rename = "modelViewOptionId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_view_option_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Modelldarstellung (≙ Archicad „Modelldarstellung"/Model View Options): eine benannte Stufe der
/// Darstellung über einem Basis-Detailgrad, mit Optionen je Bauteilart. Jede Option fehlt ⇒ „wie Basis":
/// dann zeichnet der Detailgrad wie bisher. Rangfolge: Element-Einstellung > Typ-Einstellung > Modelldarstellung
/// der Ansicht > Basis-Detailgrad (Kern `plan/model_view.rs`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewOption {
    pub id: String,
    pub name: String,
    /// Basis-Detailgrad; fehlt ⇒ der gewählte Detailgrad der Ansicht.
    #[serde(rename = "baseDetail", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_detail: Option<DetailLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub doors: Option<ModelViewDoors>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub windows: Option<ModelViewWindows>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stairs: Option<ModelViewStairs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub walls: Option<ModelViewWalls>,
    /// Decken und Böden.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slabs: Option<ModelViewSlabs>,
    /// Gelände.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site: Option<ModelViewSite>,
    /// [173] Dächer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub roofs: Option<ModelViewRoofs>,
    /// [173] Stützen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub columns: Option<ModelViewColumns>,
    /// [173] Ansicht (Fassade).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub elevation: Option<ModelViewElevation>,
    /// [176] Schnittmarken im Grundriss.
    #[serde(rename = "sectionMarks", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub section_marks: Option<ModelViewSectionMarks>,
    /// [173] Raumstempel: welche Zeilen (die Einstellung am Stempel geht vor).
    #[serde(rename = "roomStamps", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub room_stamps: Option<ModelViewRoomStamps>,
    /// [173] Bemassung: Massketten der automatischen Aussenbemassung, Höhenkoten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dimensions: Option<ModelViewDimensions>,
    /// [207] Situationsplan / Schwarzplan: fehlt ⇒ gewöhnlicher Grundriss; vorhanden ⇒ statt der Bauteile das
    /// eigene Gebäude als gefüllter Umriss, die Kontextgebäude gefüllt, dazu Nordpfeil und Massstabsbalken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub situation: Option<ModelViewSituation>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [207] Füllung eines Gebäudes im Situationsplan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SituationFill {
    #[default]
    #[serde(rename = "black")]
    Black,
    #[serde(rename = "grey")]
    Grey,
    #[serde(rename = "off")]
    Off,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [207] Situationsplan in der Modelldarstellung (≙ Schwarzplan): jede Option fehlt ⇒ Standard des
/// Situationsplans (eigenes Gebäude schwarz, Kontext grau, mit Planzeichen).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewSituation {
    /// Eigenes Gebäude: Umriss über alle Geschosse über Terrain und die Dächer, gefüllt (Basis: schwarz).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub own: Option<SituationFill>,
    /// Kontextgebäude (importierte Netze, Grundfläche aus der Aufsicht), gefüllt (Basis: grau; „Schwarzplan": schwarz).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context: Option<SituationFill>,
    /// Nordpfeil und Massstabsbalken zeichnen (Basis: ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub symbols: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Raumstempel in der Modelldarstellung (fehlt ⇒ wie Basis). Die Einstellung am Raumstempel geht vor
/// (Bodenfläche und SIA-Kategorie sind dort immer gesetzt, Belag und Trennlinie, wenn gewählt); die Stufe
/// bestimmt die übrigen Zeilen und die Räume ohne eigenen Stempel.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewRoomStamps {
    /// Raumnummer (Basis: ja; der Stempel liefert nur den Text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub number: Option<bool>,
    /// Bodenfläche (Basis: ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub area: Option<bool>,
    /// SIA-416-Kategorie (Basis: nein).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usage: Option<bool>,
    /// Lichte Raumhöhe (Basis: nein).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<bool>,
    /// Bodenbelag (Basis: nein).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub finish: Option<bool>,
    /// Trennlinie unter dem Namen (Basis: nein; nur bei Räumen mit Stempel).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub divider: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Bemassung in der Modelldarstellung (fehlt ⇒ wie Basis). Wirkt auf die Ketten der automatischen
/// Aussenbemassung (`autodim-…`) und auf die Höhenkoten; eigene Massketten bleiben.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewDimensions {
    /// Massketten der Aussenbemassung (Basis: alle).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chains: Option<ModelViewDimChains>,
    /// Höhenkoten: 2D-Koten im Plan und die automatischen Koten in Schnitt/Ansicht (die Ebene geht vor; Basis: ja).
    #[serde(rename = "levelMarks", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub level_marks: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Ketten der automatischen Aussenbemassung: alle, ohne die Öffnungskette (Vor-/Rücksprünge und
/// Gesamtmass) oder nur das Gesamtmass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModelViewDimChains {
    #[default]
    #[serde(rename = "all")]
    All,
    #[serde(rename = "outer")]
    Outer,
    #[serde(rename = "total")]
    Total,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [176] Schnittmarken in der Modelldarstellung (fehlt ⇒ Pfeil).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewSectionMarks {
    /// Markentyp der Schnitte (die Ebene geht vor; Basis: Pfeil).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub style: Option<SectionMarkerStyle>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [176] Markentyp einer Schnittlinie im Grundriss: Pfeil (kräftige Endstücke, dünne Linie, Schenkel mit Dreieck)
/// oder nur ein L an jedem Ende (langer Schenkel längs der Linie, kurzer in Blickrichtung, keine Linie dazwischen).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum SectionMarkerStyle {
    #[default]
    #[serde(rename = "arrow")]
    Arrow,
    #[serde(rename = "lAngle")]
    LAngle,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [173] Türen in der Modelldarstellung (fehlt ⇒ wie Basis).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewDoors {
    /// Sturzlinie im Grundriss (Element und Türtyp gehen vor).
    #[serde(rename = "lintelLineStyle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lintel_line_style: Option<LintelLineStyle>,
    /// Öffnungswinkel des Türblatts in Grad, solange die Tür keinen eigenen hat (Basis 90°).
    #[serde(rename = "swingAngle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub swing_angle: Option<f64>,
    /// Aufschlagbogen zeichnen (Basis: ja, ausser in der Übersicht ab 1:500).
    #[serde(rename = "swingArc", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub swing_arc: Option<bool>,
    /// Zarge/Rahmen zeichnen (Basis: ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame: Option<bool>,
    /// Türblatt als Linie oder als Rechteck mit Blattdicke (Basis: Rechteck nur „fein").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub leaf: Option<ModelViewLeaf>,
    /// Schwelle im Grundriss: aus, nur Hebeschiebetüren oder alle Türen (Basis: aus).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub threshold: Option<ModelViewThreshold>,
    /// Zarge, Blatt und Sturz im Schnitt: ja = voll, nein = höchstens das Blatt; ohne Wert folgt es dem Detailgrad (grob: Blatt als Strich).
    #[serde(rename = "sectionDetail", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub section_detail: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Türblatt im Grundriss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModelViewLeaf {
    #[default]
    #[serde(rename = "line")]
    Line,
    #[serde(rename = "rect")]
    Rect,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [173] Fenster in der Modelldarstellung (fehlt ⇒ wie Basis).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewWindows {
    /// Öffnungslinien (Dreh-/Kipp-Dreiecke) in der Ansicht (Element und Fenstertyp gehen vor; Basis: ja).
    #[serde(rename = "sashSymbols", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sash_symbols: Option<bool>,
    /// Aufschlagbögen der Drehflügel im Grundriss (Element und Fenstertyp gehen vor; Basis: nein).
    #[serde(rename = "planSwingArcs", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan_swing_arcs: Option<bool>,
    /// Fensterbank (innen/aussen nach Typ) im Grundriss (Basis: nur „fein").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sill: Option<bool>,
    /// Flügelrahmen im Grundriss (Basis: nur „fein").
    #[serde(rename = "sashFrames", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sash_frames: Option<bool>,
    /// Vereinfachter Grundriss („3 Linien", CH-Praxis 1:200): nur Leibungskante aussen, Leibungskante innen und ein Strich
    /// in der Fenstermitte; kein Rahmen, keine Flügel, keine Anschlagnase, keine Fensterbank (Basis: nur Detailgrad „grob").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub simplified: Option<bool>,
    /// Storenkasten im Grundriss als Untersicht (gestrichelt über der Schnittebene) zeigen (Basis: nein).
    #[serde(rename = "shadingBox", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shading_box: Option<bool>,
    /// Sturzlinie im Grundriss (gestrichelt an den Wandflächen; Element-Linientyp geht vor; Basis: nein).
    #[serde(rename = "lintelLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lintel_line: Option<bool>,
    /// Rahmen, Kämpfer, Sturz, Fensterbank im Schnitt: ja = voll, nein = höchstens einfacher Rahmen und Glas; ohne Wert folgt es dem Detailgrad (grob: ein Strich, mittel: einfach, fein: voll).
    #[serde(rename = "sectionDetail", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub section_detail: Option<bool>,
    /// Fensterteilung (Flügel, Sprossen, Kämpfer) in der Ansicht; ohne Wert folgt sie dem Detailgrad (grob: keine).
    #[serde(rename = "elevationDivision", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub elevation_division: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Treppen in der Modelldarstellung (fehlt ⇒ wie Basis).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewStairs {
    /// Lauflinie (Basis: ja).
    #[serde(rename = "walkLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub walk_line: Option<bool>,
    /// Pfeil der Lauflinie (Basis: ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub arrow: Option<bool>,
    /// Bruchlinie an der Schnitthöhe (Basis: ja).
    #[serde(rename = "breakLine", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub break_line: Option<bool>,
    /// Stufen über der Schnitthöhe (Basis: gestrichelt).
    #[serde(rename = "aboveCut", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub above_cut: Option<ModelViewAboveCut>,
    /// Handlauf (Basis: doppelt ab 1:50 bzw. „fein", sonst einfach; nur wo der Treppentyp einen hat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub handrail: Option<ModelViewHandrail>,
    /// Treppen hinter der Schnittebene (Stufen, Wangen, Geländer) im Schnitt (Basis: ja).
    #[serde(rename = "sectionBeyond", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub section_beyond: Option<bool>,
    /// Versatz der Lauflinie am Anfang in Papier-mm (Basis 0: ab der Antrittskante).
    #[serde(rename = "runStartMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_start_mm: Option<f64>,
    /// Versatz der Lauflinie am Ende in Papier-mm (Basis 0: bis zur Austrittskante).
    #[serde(rename = "runEndMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_end_mm: Option<f64>,
    /// Antrittspunkt am Anfang der Lauflinie (Basis: nein).
    #[serde(rename = "startMark", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_mark: Option<bool>,
    /// [173] Stufennummern im Grundriss (Basis: nein).
    #[serde(rename = "stepNumbers", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub step_numbers: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Darstellung der Stufen über der Schnitthöhe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModelViewAboveCut {
    #[default]
    #[serde(rename = "dashed")]
    Dashed,
    #[serde(rename = "off")]
    Off,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [173] Handlauf im Grundriss: aus, einfache Linie (Achse) oder doppelte (Rohrkanten).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModelViewHandrail {
    #[default]
    #[serde(rename = "off")]
    Off,
    #[serde(rename = "single")]
    Single,
    #[serde(rename = "double")]
    Double,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [173] Wände in der Modelldarstellung (fehlt ⇒ wie Basis).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewWalls {
    /// Schichten: alle, vereinfacht (dünne Schichten zusammengefasst) oder nur das Kern-Material als eine
    /// Fläche (Basis: vereinfacht ab 1:50 ausser „fein").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layers: Option<ModelViewLayers>,
    /// Dünne Schichten zusammenfassen unter dieser Papierdicke in mm (Basis 0.5).
    #[serde(rename = "thinLayerMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thin_layer_mm: Option<f64>,
    /// Schichteinzug an Leibungen zeigen (Basis: ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reveals: Option<bool>,
    /// Schnittflächen ab 1:100 schraffiert statt schwarz (die Ebene geht vor; Basis: schwarz).
    #[serde(rename = "cutHatch", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cut_hatch: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Wandschichten im Grundriss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModelViewLayers {
    #[default]
    #[serde(rename = "all")]
    All,
    #[serde(rename = "simplified")]
    Simplified,
    #[serde(rename = "core")]
    Core,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [173] Decken und Böden in der Modelldarstellung.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewSlabs {
    /// Bodenbelag-Muster im Grundriss (die Ebene geht vor; Basis: automatisch).
    #[serde(rename = "floorFinish", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_finish: Option<FloorFinishDisplay>,
    /// Schichten im Schnitt: alle, vereinfacht oder nur die tragende Schicht (Basis: vereinfacht ab 1:75 ausser „fein").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layers: Option<ModelViewLayers>,
    /// Bodenaufbau (Schichten über der tragenden) im Schnitt: zeigen oder zu einer Fläche zusammenfassen (Basis: zeigen).
    #[serde(rename = "buildUp", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub build_up: Option<ModelViewBuildUp>,
    /// Umriss der Decken im Grundriss (Basis: ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outline: Option<bool>,
    /// Ansichtsschraffur der Decken im Grundriss (Basis: ja ausser „grob").
    #[serde(rename = "viewHatch", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_hatch: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Schwelle der Türen im Grundriss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModelViewThreshold {
    #[default]
    #[serde(rename = "off")]
    Off,
    #[serde(rename = "liftSlide")]
    LiftSlide,
    #[serde(rename = "all")]
    All,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [173] Bodenaufbau im Schnitt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModelViewBuildUp {
    #[default]
    #[serde(rename = "show")]
    Show,
    #[serde(rename = "merged")]
    Merged,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [173] Dächer in der Modelldarstellung (fehlt ⇒ wie Basis).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewRoofs {
    /// Schichten im Schnitt (Basis: vereinfacht ab 1:75 ausser „fein").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layers: Option<ModelViewLayers>,
    /// Dachrand, First und Grate über der Schnitthöhe (strichpunktiert) im Grundriss (Basis: ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub overhead: Option<bool>,
    /// Ansichtsschraffur und Muster der Eindeckung in der Dachaufsicht (Basis: ja).
    #[serde(rename = "viewHatch", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_hatch: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Geschnittene Stütze: Schraffur des Baustoffs, schwarz oder leer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum ModelViewCutFill {
    #[default]
    #[serde(rename = "material")]
    Material,
    #[serde(rename = "solid")]
    Solid,
    #[serde(rename = "empty")]
    Empty,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [173] Stützen in der Modelldarstellung (fehlt ⇒ wie Basis).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewColumns {
    /// Schnittfläche im Grundriss und Schnitt (Basis: Schraffur, ab 1:100 schwarz).
    #[serde(rename = "cutFill", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cut_fill: Option<ModelViewCutFill>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Ansicht (Fassade) in der Modelldarstellung (fehlt ⇒ wie Basis).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewElevation {
    /// Schlagschatten (die Ebene geht vor; Basis: aus).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shadows: Option<bool>,
    /// Ansichtsschraffur der Baustoffe (Basis: ja).
    #[serde(rename = "materialHatch", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub material_hatch: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [173] Gelände in der Modelldarstellung.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ModelViewSite {
    /// Gelände, Höhenlinien und Baugruben im Grundriss (die Ebene geht vor; Basis: automatisch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub terrain: Option<bool>,
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

/// UI-Zustand der App, mit der Projektdatei gesichert ([136]); gehört nicht ins semantische Modell.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct UiState {
    /// Offene Zeichnungs-Reiter samt Reihenfolge und aktivem Reiter.
    #[serde(rename = "viewTabs", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_tabs: Option<UiViewTabs>,
}

/// Offene Zeichnungs-Reiter (`state/viewTabs.ts`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct UiViewTabs {
    pub tabs: Vec<UiViewTab>,
    /// Id des aktiven Reiters.
    #[serde(rename = "activeId")]
    pub active_id: String,
}

/// Ein Reiter: Verweis auf den Ausschnitt (nur Titel), fester Titel und gemerkte Ansicht.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct UiViewTab {
    pub id: String,
    #[serde(rename = "snapshotId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snapshot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// Darstellungszustand (`ViewSnapshotState`: Ansicht, Zoom, Ebene, Sichtbarkeit …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub state: Option<serde_json::Value>,
}

/// Schattenstudie (`analysis/sun.ts`): der Schatten liegt auf dem Geschoss nächst ±0.00.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SunStudy {
    /// Zeitpunkt als ISO-8601-Text in UTC, z. B. "2026-12-21T11:00:00Z".
    pub when: String,
    pub show: bool,
    /// [142] Höhe der Bäume (2D-Kreise der Ebene „Bäume", Code 13) in m über Terrain für den
    /// Schattenwurf; fehlt der Wert, gilt 8 m.
    #[serde(rename = "treeHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tree_height: Option<f64>,
    /// [64] Schatten im 3D (Sonne aus `when`); fehlt der Wert, gilt `show`.
    #[serde(rename = "shadows3d", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shadows3d: Option<bool>,
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
    /// Zulässige Hülle (zulässige Fläche bis zur Gesamthöhe) im 3D durchscheinend zeigen (Default: nein).
    #[serde(rename = "show3d", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show3d: Option<bool>,
    /// Vorsprünge ([63]): zulässige Tiefe (m) in den Grenzabstand bzw. über die Baulinie für
    /// Dachüberstände und als Vorsprung markierte Bauteile (`siteProjection`). Fehlt ⇒ keine
    /// Vorsprungsregel (Dächer und Decken werden nicht geprüft, wie bisher).
    #[serde(rename = "projectionDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub projection_depth: Option<f64>,
    /// Vorsprünge ([63]): höchster Anteil (0..1) der Fassadenlänge, den markierte Vorsprünge
    /// (Balkone, Erker; nicht Dachüberstände) je Grenze/Baulinie einnehmen dürfen. Fehlt ⇒ unbegrenzt.
    #[serde(rename = "projectionShare", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub projection_share: Option<f64>,
    /// Gebäudeprofil ([63]): Profilwinkel (Grad über der Horizontalen, 0 < α < 90); die zulässige
    /// Höhe steigt von jeder Parzellengrenze und Baulinie nach innen mit tan(α). Fehlt ⇒ kein Profil.
    #[serde(rename = "profileAngle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile_angle: Option<f64>,
    /// Gebäudeprofil ([63]): Höhe (m) des Profils an der Grenze bzw. Baulinie über dem massgebenden
    /// Terrain (ohne Gelände über ±0.00). Fehlt ⇒ 0.
    #[serde(rename = "profileHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile_height: Option<f64>,
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
    /// [201] IFC-GlobalId des Quell-Bauteils (IFC-Import); der IFC-Export schreibt sie zurück, damit
    /// die Rundreise dieselben GUIDs behält. Kopien (Einfügen, Kopieren, Reihe, Wand teilen) tragen sie NICHT.
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
    /// Vorsprung im Baurecht ([63]: Wand eines Erkers): darf mit `SiteRules.projectionDepth`/
    /// `projectionShare` in den Grenzabstand ragen. Fehlt ⇒ normales Bauteil.
    #[serde(rename = "siteProjection", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site_projection: Option<bool>,
    /// Objekt-Sperre: gesperrte Elemente lassen sich nicht anwählen (daher
    ///  auch nicht verschieben/bearbeiten/löschen) — anders als der Ebenen-/
    ///  Geschoss-Sperrmodus (`DisplayMode`) ist das hier persistiert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Aussen (true) / innen (false); fehlt = nicht angegeben (IFC `IsExternal`).
    #[serde(rename = "isExternal", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_external: Option<bool>,
    /// Tragend (IFC `LoadBearing`); fehlt = nicht angegeben.
    #[serde(rename = "loadBearing", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub load_bearing: Option<bool>,
    /// Achs-Startpunkt im Grundriss (Meter).
    pub start: Vec2,
    /// Achs-Endpunkt im Grundriss (Meter).
    pub end: Vec2,
    /// Bogenwand ([T2]): Achse als Kreisbogen von `start` nach `end`, `bulge = tan(Öffnungswinkel/4)`;
    /// positiv = Scheitel links der Sehne (Modell-Konvention wie Polylinien, = −DXF-Bulge). Fehlt/0 =
    /// gerade Wand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bulge: Option<f64>,
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
    /// An Dach anschliessen ([G2]): `undefined` = automatisch (die Wand endet an der Dach-Unterkante,
    /// wo ihre Krone darüber liegt — je Schicht, Giebel/Traufe/Grat/Kehle/Gaube), `true` = zusätzlich bis
    /// unter das Dach verlängert, `false` = Dächer schneiden die Wand nicht.
    #[serde(rename = "roofAttach", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub roof_attach: Option<bool>,
    /// Ansichtsschraffur ([100]): Drehung (Grad) des Oberflächenmusters dieses Elements gegenüber der
    /// Ausrichtung am Element (Default 0).
    #[serde(rename = "surfacePatternAngle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub surface_pattern_angle: Option<f64>,
    /// Ansichtsschraffur ([100]): Versatz (m) des Musterursprungs (x entlang, y quer/aufwärts) gegenüber
    /// der Elementkante.
    #[serde(rename = "surfacePatternOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub surface_pattern_offset: Option<Vec2>,
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
    /// [201] IFC-GlobalId des Quell-Bauteils (IFC-Import); der IFC-Export schreibt sie zurück, damit
    /// die Rundreise dieselben GUIDs behält. Kopien (Einfügen, Kopieren, Reihe, Wand teilen) tragen sie NICHT.
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
    /// Vorsprung im Baurecht ([63]: Balkon, Erker): darf mit `SiteRules.projectionDepth`/
    /// `projectionShare` in den Grenzabstand ragen. Fehlt ⇒ normales Bauteil.
    #[serde(rename = "siteProjection", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site_projection: Option<bool>,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Aussen (true) / innen (false); fehlt = nicht angegeben (IFC `IsExternal`).
    #[serde(rename = "isExternal", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_external: Option<bool>,
    /// Tragend (IFC `LoadBearing`); fehlt = nicht angegeben.
    #[serde(rename = "loadBearing", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub load_bearing: Option<bool>,
    /// [178] Deckenrand an Aussenwänden: `true` = Platte bis an den Umriss (über die Aussenschichten der
    /// Wand); fehlt/`false` = Auflager bis Aussenkante der tragenden Schicht, Aussendämmung/Putz laufen
    /// an der Deckenstirn durch.
    #[serde(rename = "edgeAtOutline", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub edge_at_outline: Option<bool>,
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
    /// [191] Bögen im Umriss: `outlineBulge[i]` krümmt die Kante `outline[i] → outline[i+1]` (letzte: zum
    /// Start) zum Kreisbogen, `bulge = tan(Öffnungswinkel/4)`, positiv = Scheitel links der Kante (wie
    /// `Wall.bulge`/Polylinien). Fehlt/kürzer/0 = gerade Kante. Ableitungen rechnen über `ring_arc`.
    #[serde(rename = "outlineBulge", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outline_bulge: Option<Vec<f64>>,
    /// [191] Bögen der Aussparungen, je Loch wie `outlineBulge` (Index wie `openings`).
    #[serde(rename = "openingsBulge", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub openings_bulge: Option<Vec<Vec<f64>>>,
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
    /// [201] IFC-GlobalId des Quell-Bauteils (IFC-Import); der IFC-Export schreibt sie zurück, damit
    /// die Rundreise dieselben GUIDs behält. Kopien (Einfügen, Kopieren, Reihe, Wand teilen) tragen sie NICHT.
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Geschlossener Grundriss-Umriss (Meter). Flach/Pult/Walm/Zelt folgen dem Umriss, Sattel/Mansarde einem
    /// rechtwinkligen; nur Giebelformen auf schiefem Umriss nutzen die Bounding-Box.
    pub outline: Vec<Vec2>,
    /// Innenhöfe/Lichthöfe als Ringe (Meter, jeder Ring geschlossen, Drehsinn egal). Das Dach
    /// ist an dieser Stelle ausgespart (3D, Grundriss, Schnitt, Ansicht, IFC); die Hofkanten sind
    /// innere Traufen. Wirkt bei Flach/Sattel/Walm/Mansarde/Zelt (Pult ignoriert sie); ein Ring,
    /// der nicht ganz im Umriss liegt oder sich mit Umriss/anderen Höfen schneidet, macht die
    /// Höfe wirkungslos (Dach wie ohne). Fehlt ⇒ keine Höfe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub holes: Option<Vec<Vec<Vec2>>>,
    /// [191] Bögen im Umriss je Kante wie `Ceiling.outlineBulge`. Eine Bogenkante bleibt EINE Kante
    /// (Neigung/Giebel aus `edgePitchDeg` gilt für den ganzen Bogen).
    #[serde(rename = "outlineBulge", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outline_bulge: Option<Vec<f64>>,
    /// [191] Bögen der Höfe, je Ring wie `outlineBulge` (Index wie `holes`).
    #[serde(rename = "holesBulge", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub holes_bulge: Option<Vec<Vec<f64>>>,
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
    /// Ansichtsschraffur ([100]): Drehung (Grad) des Oberflächenmusters dieses Elements gegenüber der
    /// Ausrichtung am Element (Default 0).
    #[serde(rename = "surfacePatternAngle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub surface_pattern_angle: Option<f64>,
    /// Ansichtsschraffur ([100]): Versatz (m) des Musterursprungs (x entlang, y quer/aufwärts) gegenüber
    /// der Elementkante.
    #[serde(rename = "surfacePatternOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub surface_pattern_offset: Option<Vec2>,
    /// Gauben/Lukarnen ([G5]) in den Dachflächen dieses Dachs. Fehlt ⇒ keine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dormers: Option<Vec<Dormer>>,
    /// Attika ([148]): Höhe über der Dachhaut (Meter) am Rand eines Flachdachs, umlaufend auf dem Dachumriss
    /// (mit Überstand). Fehlt oder 0 ⇒ keine Attika. Wirkt nur bei Flachdach.
    #[serde(rename = "parapetHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parapet_height: Option<f64>,
    /// Attika: Breite (Meter, nach innen vom Dachrand); fehlt ⇒ 0.2.
    #[serde(rename = "parapetWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parapet_width: Option<f64>,
    /// Attika: Bauteil/Material (Farbe, Schnittschraffur); fehlt ⇒ Wandfarbe ohne Schraffur.
    #[serde(rename = "parapetComponentId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parapet_component_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Gaubenart ([G5]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum DormerKind {
    /// Schleppgaube: eine Dachfläche, flacher als das Hauptdach.
    #[default]
    #[serde(rename = "schlepp")]
    Schlepp,
    /// Satteldachgaube (Giebelgaube): First quer zur Traufe des Hauptdachs.
    #[serde(rename = "sattel")]
    Sattel,
    /// Flachdachgaube.
    #[serde(rename = "flach")]
    Flach,
    /// Walmgaube: Satteldachgaube mit abgewalmter Stirn.
    #[serde(rename = "walm")]
    Walm,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Gaube/Lukarne ([G5]) in einer Dachfläche: Stirnwand parallel zur Traufe, Wangen bis an das
/// Hauptdach, eigenes Dach mit dem Hauptdach verschnitten; das Hauptdach ist an der Gaube in allen
/// Schichten ausgeschnitten. Das Fenster in der Stirn ist eine `Opening` mit `hostDormerId`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Dormer {
    pub id: String,
    pub kind: DormerKind,
    /// Mitte der Stirnwand-Aussenseite im Grundriss (Meter); legt auch die Dachfläche fest.
    pub position: Vec2,
    /// Aussenbreite (Wange aussen bis Wange aussen, Meter).
    pub width: f64,
    /// Stirnhöhe: von der Dach-Oberkante an der Stirn bis Unterkante Gaubendach (Meter).
    #[serde(rename = "frontHeight")]
    pub front_height: f64,
    /// Neigung des Gaubendachs in Grad (Sattel/Walm/Schlepp); fehlt ⇒ Sattel/Walm 40°, Schlepp aus der
    /// Tiefe bzw. 15°, Flach 0.
    #[serde(rename = "pitchDeg", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pitch_deg: Option<f64>,
    /// Nur Schleppgaube: waagrechte Tiefe von der Stirn bis zum Anschluss an das Hauptdach (Meter);
    /// gesetzt ⇒ die Neigung folgt daraus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub depth: Option<f64>,
    /// Dachüberstand an Stirn und Seiten (Meter); fehlt ⇒ 0.15.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub overhang: Option<f64>,
    /// Wandtyp für Wangen und Stirn; fehlt ⇒ einschichtig 0.15 m.
    #[serde(rename = "wallTypeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wall_type_id: Option<String>,
    /// Dachtyp des Gaubendachs; fehlt ⇒ der des Hauptdachs.
    #[serde(rename = "roofTypeId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub roof_type_id: Option<String>,
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

/// Linientyp der Sturzlinien einer Tür im Grundriss ([105]; Strichmuster in Papier-mm wie [153]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum LintelLineStyle {
    #[default]
    #[serde(rename = "gestrichelt")]
    Gestrichelt,
    #[serde(rename = "punktiert")]
    Punktiert,
    #[serde(rename = "durchgehend")]
    Durchgehend,
    #[serde(rename = "keine")]
    Keine,
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

/// Umrissform einer Öffnung ([G3]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OpeningShape {
    #[default]
    #[serde(rename = "rechteck")]
    Rechteck,
    #[serde(rename = "rundbogen")]
    Rundbogen,
    #[serde(rename = "segmentbogen")]
    Segmentbogen,
    #[serde(rename = "spitzbogen")]
    Spitzbogen,
    #[serde(rename = "rund")]
    Rund,
    #[serde(rename = "schraeg")]
    Schraeg,
    #[serde(rename = "giebel")]
    Giebel,
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

/// [156] Bodenbelag-Muster im Grundriss (Ansichtsvorlage/Ebene): „aus" nie, „Nassräume" ab 1:50/„fein"
/// alle und gröber nur Plattenbeläge in Nassräumen (Bad/WC/Dusche), „alle" in jedem Massstab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum FloorFinishDisplay {
    #[default]
    #[serde(rename = "off")]
    Off,
    #[serde(rename = "wet")]
    Wet,
    #[serde(rename = "all")]
    All,
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
    /// [201] IFC-GlobalId des Quell-Bauteils (IFC-Import); der IFC-Export schreibt sie zurück, damit
    /// die Rundreise dieselben GUIDs behält. Kopien (Einfügen, Kopieren, Reihe, Wand teilen) tragen sie NICHT.
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Bauteilnummer (Fenster-/Türliste); leer = automatisch je Geschoss nummeriert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mark: Option<String>,
    /// Feuerwiderstand (z. B. "EI30", "EI60"); Türliste, IFC `FireRating`.
    #[serde(rename = "fireRating", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fire_rating: Option<String>,
    /// Schallschutz (z. B. "Rw 32 dB"); IFC `AcousticRating`.
    #[serde(rename = "soundClass", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sound_class: Option<String>,
    /// Wärmedurchgang U in W/(m²K); IFC `ThermalTransmittance`.
    #[serde(rename = "uValue", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub u_value: Option<f64>,
    /// Einbruchhemmung (z. B. "RC2"); IFC `SecurityRating`.
    #[serde(rename = "burglaryClass", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub burglary_class: Option<String>,
    /// Bemerkung (Fenster-/Türliste).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    /// Aussen (true) / innen (false); fehlt = aus der Wand und den Räumen abgeleitet.
    #[serde(rename = "isExternal", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_external: Option<bool>,
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
    /// Linientyp der Sturzlinien im Grundriss ([105]); fehlt ⇒ wie Türtyp, sonst gestrichelt.
    #[serde(rename = "lintelLineStyle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lintel_line_style: Option<LintelLineStyle>,
    /// Fenster: Öffnungslinien in der Ansicht ein/aus (übersteuert den Fenstertyp, [95]).
    #[serde(rename = "sashSymbols", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sash_symbols: Option<bool>,
    /// Fenster: Aufschlagbogen der Drehflügel im Grundriss ein/aus (übersteuert den Fenstertyp, [95]).
    #[serde(rename = "planSwingArcs", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan_swing_arcs: Option<bool>,
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
    /// Umriss der Öffnung in der Wandebene ([G3]); fehlt ⇒ Rechteck. Bestimmt den Wandausschnitt
    /// (Schnitt, Ansicht, 3D, IFC-Öffnungskörper); der Grundriss bleibt beim SIA-Symbol. Die
    /// Öffnung füllt ihr Rechteck `width × height`; Bogen/Schräge liegen oben (Rund: Ellipse darin).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub shape: Option<OpeningShape>,
    /// Stichhöhe der Form in Metern ([G3]): Segmentbogen = Bogenstich (Default Breite/6), Spitzbogen =
    /// Höhe über dem Kämpfer (≥ Breite/2, Default gleichseitig), Giebel = Höhe des Dreiecks (Default
    /// Breite/2), Schräg = Höhenunterschied links→rechts (> 0 rechts höher, Default Breite/2).
    /// Rundbogen/Rund/Rechteck ignorieren es.
    #[serde(rename = "shapeRise", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shape_rise: Option<f64>,
    /// Wirt Dach ([103], Dachfenster): Öffnung in einer Dachfläche; `hostWallId` bleibt leer. Lage
    /// über {@link hostPoint}; `width` quer zum Gefälle, `height` entlang des Gefälles (in der
    /// Dachebene gemessen); `position`/`sillHeight` gelten nicht.
    #[serde(rename = "hostRoofId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_roof_id: Option<String>,
    /// Wirt Decke ([103], Deckenöffnung mit Oberlicht): Öffnung in einer Decke, Lage über
    /// {@link hostPoint}, `width` × `height` waagrecht (gedreht um {@link hostAngle}).
    #[serde(rename = "hostCeilingId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_ceiling_id: Option<String>,
    /// Nur Dach-/Deckenwirt ([103]): Mittelpunkt der Öffnung im Grundriss (Meter).
    #[serde(rename = "hostPoint", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_point: Option<Vec2>,
    /// Nur Dach-/Deckenwirt ([103]): Drehung der Breitenrichtung im Grundriss in Grad, wo die
    /// Fläche waagrecht ist (Decke, Flachdach); geneigte Dachflächen richten die Breite längs der
    /// Traufe aus. Fehlt ⇒ 0 (x-Achse).
    #[serde(rename = "hostAngle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_angle: Option<f64>,
    /// Wirt Gaube ([G5]): Fenster in der Stirnwand der Gaube `hostDormerId` des Dachs `hostRoofId`.
    /// `position` = Versatz der Fenstermitte von der Stirnmitte (Meter, + nach rechts von aussen),
    /// `sillHeight` = Brüstung über der Dach-Oberkante an der Stirn.
    #[serde(rename = "hostDormerId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_dormer_id: Option<String>,
    /// Übersteuert das Rahmen-Detail des Typs feldweise für diese Öffnung ([105]).
    #[serde(rename = "frameDetail", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_detail: Option<FrameDetail>,
    /// Ersetzt den Schichteinzug des Typs für diese Öffnung ([106]).
    #[serde(rename = "layerReveals", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layer_reveals: Option<Vec<LayerReveal>>,
    /// Übersteuert die Rahmenart des Türtyps ([105]).
    #[serde(rename = "doorFrameKind", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub door_frame_kind: Option<DoorTypeFrameKind>,
    /// Übersteuert die Zargen-/Rahmenmasse des Türtyps feldweise ([105]).
    #[serde(rename = "doorFrame", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub door_frame: Option<DoorFrameDetail>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Grundform einer Treppe (DOSSIER: gerade / L / Wendel / U / gerade mit Podest).
///   • "straight" — ein gerader Lauf (Lauflinie = Start → Richtung).
///   • "L"        — zwei rechtwinklige Läufe mit Zwischenpodest an der Ecke.
///   • "spiral"   — Wendeltreppe um ein Zentrum (keilförmige Tritte).
///   • "U"        — [151] zwei gegenläufige Läufe mit Halbpodest (Treppenauge `gap`, Drehsinn `turn`),
///                  wahlweise mit Mittellauf quer über das Auge und zwei Viertelpodesten (`midSteps`).
///   • "straightLanding" — [151] zwei Läufe in einer Richtung mit Zwischenpodest (`landingLength`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum StairShape {
    #[default]
    #[serde(rename = "straight")]
    Straight,
    #[serde(rename = "L")]
    L,
    #[serde(rename = "spiral")]
    Spiral,
    #[serde(rename = "U")]
    U,
    #[serde(rename = "straightLanding")]
    StraightLanding,
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

/// [T3] Querschnittsform von Handlauf bzw. Geländerpfosten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum StairRailProfile {
    /// Rundrohr (Durchmesser = Breite).
    #[default]
    #[serde(rename = "rund")]
    Rund,
    /// Rechteck (Breite × Höhe bzw. Tiefe).
    #[serde(rename = "rechteck")]
    Rechteck,
    /// Flachstahl (Breite × Dicke, Dicke klein).
    #[serde(rename = "flach")]
    Flach,
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
    /// [201] IFC-GlobalId des Quell-Bauteils (IFC-Import); der IFC-Export schreibt sie zurück, damit
    /// die Rundreise dieselben GUIDs behält. Kopien (Einfügen, Kopieren, Reihe, Wand teilen) tragen sie NICHT.
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
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
    /// Nur L / U / gerade mit Podest: Lauflänge des zweiten (bei U: des letzten) Laufs in Metern.
    #[serde(rename = "run2Length", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run2_length: Option<f64>,
    /// Nur L / U: Abbiegerichtung des zweiten Laufs bzw. Drehsinn (+1 = links, −1 = rechts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "1 | -1")]
    pub turn: Option<f64>,
    /// [151] Nur U: lichte Weite des Treppenauges zwischen erstem und letztem Lauf (Meter; fehlt = 0.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gap: Option<f64>,
    /// [151] Nur U / gerade mit Podest: Podesttiefe in Laufrichtung (Meter; fehlt = Laufbreite).
    #[serde(rename = "landingLength", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub landing_length: Option<f64>,
    /// [151] Nur L / U / gerade mit Podest: Steigungen im ersten Lauf bis zum Podest (fehlt = nach
    /// Lauflängen aufgeteilt). Jedes Podest zählt als eine Steigung.
    #[serde(rename = "run1Steps", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run1_steps: Option<f64>,
    /// [151] Nur U: Steigungen im Mittellauf quer über das Auge (zwei Viertelpodeste); fehlt/0 =
    /// Halbpodest. Auftritt wie Lauf 1, höchstens Augenweite / Steigungen.
    #[serde(rename = "midSteps", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mid_steps: Option<f64>,
    /// [151] Nur U: Versatz des letzten Laufs ins Podest hinein (Meter, entlang Lauf 1; fehlt = 0).
    #[serde(rename = "run2Offset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run2_offset: Option<f64>,
    /// [151] Nur U mit Mittellauf: Verschiebung des Mittellaufs im Treppenauge zur Wendeseite hin (Meter;
    /// fehlt = mittig). Ergibt ungleiche Viertelpodeste; begrenzt auf die Reserve im Auge.
    #[serde(rename = "midOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mid_offset: Option<f64>,
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
    /// [187] Antrittsversatz in Metern: Höhe des Antritts über der Basis des Geschosses (negativ = darunter). Der
    /// Austritt bleibt auf `totalRise` ab Geschoss-Basis, die Steigung ist `totalRise - baseOffset`. Fehlt es: 0.
    #[serde(rename = "baseOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_offset: Option<f64>,
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
    /// Nur Wendel: Radius (Meter) der Mittelsäule (Spindel) im Zentrum. Fehlt er oder ist er
    /// ≤ 0, gibt es keine Säule.
    #[serde(rename = "centerColumn", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub center_column: Option<f64>,
    /// [T3] Handlauf-Profil (gilt für alle Treppenformen und die Absturzsicherung am Deckenloch);
    /// fehlt es, ist der Handlauf ein Rundrohr von 4 cm.
    #[serde(rename = "railProfile", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub rail_profile: Option<StairRailProfile>,
    /// [T3] Handlauf-Breite in Metern (rund: Durchmesser; fehlt = 0.04).
    #[serde(rename = "railWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rail_width: Option<f64>,
    /// [T3] Handlauf-Höhe in Metern (rechteckig: fehlt = 0.04; Flachstahl: Dicke, fehlt = 0.01; rund: ohne Wirkung).
    #[serde(rename = "railHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rail_height: Option<f64>,
    /// [T3] Pfosten-Profil (fehlt = rund).
    #[serde(rename = "postProfile", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub post_profile: Option<StairRailProfile>,
    /// [T3] Pfosten-Breite in Metern, in Richtung des Handlaufs (rund: Durchmesser; fehlt = 0.03, Flachstahl 0.04).
    #[serde(rename = "postWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub post_width: Option<f64>,
    /// [T3] Pfosten-Tiefe in Metern, quer zum Handlauf (rechteckig: fehlt = 0.03; Flachstahl: Dicke, fehlt = 0.01; rund: ohne Wirkung).
    #[serde(rename = "postDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub post_depth: Option<f64>,
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

/// [218] Schrift einer Zeile des Raumstempels; fehlende Werte gelten als „wie die Vorgabe" (Stempelschrift, dann
/// die eingebauten Werte der Zeile). Grösse in typografischen Punkt auf dem Papier bei der Grundschrift 10 pt
/// (kleinere Massstäbe verkleinern sie im Verhältnis).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct RoomStampFont {
    /// Schriftfamilie (eine der gebündelten Schriften, z. B. "Work Sans").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub family: Option<String>,
    /// Schriftgrösse in pt.
    #[serde(rename = "sizePt", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub italic: Option<bool>,
    /// Farbe als "#rrggbb".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
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
    /// Bodenfläche anzeigen (Live-Zeile). [173] Fehlt: wie die Modelldarstellung (Basis: ja); gesetzt geht vor.
    #[serde(rename = "showFloorArea", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_floor_area: Option<bool>,
    /// Präfix vor der Bodenfläche, z. B. "BF " (Default leer).
    #[serde(rename = "floorAreaPrefix", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_area_prefix: Option<String>,
    /// SIA-416-Kategorie (HNF/… · Bezeichnung) im Stempel anzeigen (Live-Zeile). [177]: Vorgabe aus, die
    /// Kategorie ist ein Attribut des Raums. [173] Fehlt: wie die Modelldarstellung (Basis: nein); gesetzt geht vor.
    #[serde(rename = "showUsage", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_usage: Option<bool>,
    /// Ausrichtung der Namenszeile (Zeile 1). Fehlt sie, gilt „links".
    #[serde(rename = "nameAlign", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name_align: Option<Align>,
    /// Ausrichtung der zweiten Namenszeile. Fehlt sie, gilt „links".
    #[serde(rename = "line2Align", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line2_align: Option<Align>,
    /// Ausrichtung der Bodenflächen-Zeile. Fehlt sie, gilt „links" ([177], Archicad-Stil).
    #[serde(rename = "floorAreaAlign", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_area_align: Option<Align>,
    /// Ausrichtung der Nutzungs-Zeile. Fehlt sie, gilt „links" ([177], Archicad-Stil).
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
    /// [158] Bodenbelag des Raums als Zeile anzeigen (Live-Zeile). Fehlt/false: keine Belagszeile.
    #[serde(rename = "showFinish", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_finish: Option<bool>,
    /// [177] Trennlinie unter dem Namen anzeigen. Fehlt/false: keine Linie.
    #[serde(rename = "showDivider", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_divider: Option<bool>,
    /// [218] Schrift des ganzen Stempels (Vorgabe für alle Zeilen ohne eigene Angabe).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub font: Option<RoomStampFont>,
    /// [218] Schrift der Namenszeile (Vorgabe: Stempelschrift, sonst 12 pt fett).
    #[serde(rename = "nameFont", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name_font: Option<RoomStampFont>,
    /// [218] Schrift der zweiten Namenszeile (Vorgabe: Stempelschrift, sonst 9 pt kursiv).
    #[serde(rename = "line2Font", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line2_font: Option<RoomStampFont>,
    /// [218] Schrift der Raumnummer (Vorgabe: Stempelschrift, sonst 9 pt).
    #[serde(rename = "numberFont", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub number_font: Option<RoomStampFont>,
    /// [218] Schrift der Bodenflächen-Zeile (Vorgabe: Stempelschrift, sonst 0.8 × Grundschrift).
    #[serde(rename = "areaFont", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub area_font: Option<RoomStampFont>,
    /// [218] Schrift der Nutzungs-Zeile (Vorgabe: Stempelschrift, sonst 0.8 × Grundschrift).
    #[serde(rename = "usageFont", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usage_font: Option<RoomStampFont>,
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
    /// [201] IFC-GlobalId des Quell-Bauteils (IFC-Import); der IFC-Export schreibt sie zurück, damit
    /// die Rundreise dieselben GUIDs behält. Kopien (Einfügen, Kopieren, Reihe, Wand teilen) tragen sie NICHT.
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
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
    /// [191] Bögen im Umriss je Kante wie `Ceiling.outlineBulge`.
    #[serde(rename = "boundaryBulge", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub boundary_bulge: Option<Vec<f64>>,
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
    /// [158] Raumbuch: Nutzung (Wohnen, Bad, Verkehr …); Nassraum wird daraus abgeleitet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usage: Option<RoomUsage>,
    /// [158] Bodenbelag: Kennung eines Bauteil-Materials (`components`) oder Freitext. Ein Material mit
    /// Oberflächenmuster gilt im Grundriss im Raum statt des Belags der Decke.
    #[serde(rename = "floorFinish", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_finish: Option<String>,
    /// [158] Wandoberfläche (Material-Kennung oder Freitext).
    #[serde(rename = "wallFinish", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wall_finish: Option<String>,
    /// [158] Deckenoberfläche (Material-Kennung oder Freitext).
    #[serde(rename = "ceilingFinish", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ceiling_finish: Option<String>,
    /// [158] Bodenaufbau als Freitext (z. B. „Parkett 15, UB 80, TSD 20").
    #[serde(rename = "floorBuildUp", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floor_build_up: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [158] Nutzung eines Raums (Raumbuch). Nassräume: Bad, WC, Dusche, Waschküche.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum RoomUsage {
    #[default]
    #[serde(rename = "living")]
    Living,
    #[serde(rename = "sleeping")]
    Sleeping,
    #[serde(rename = "kitchen")]
    Kitchen,
    #[serde(rename = "dining")]
    Dining,
    #[serde(rename = "bath")]
    Bath,
    #[serde(rename = "wc")]
    Wc,
    #[serde(rename = "shower")]
    Shower,
    #[serde(rename = "laundry")]
    Laundry,
    #[serde(rename = "circulation")]
    Circulation,
    #[serde(rename = "technical")]
    Technical,
    #[serde(rename = "storage")]
    Storage,
    #[serde(rename = "office")]
    Office,
    #[serde(rename = "other")]
    Other,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
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
    /// vor der Kategorie-Strichstärke (Linienstile tragen keine Stärke, [110]).
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
    /// "layer" erzwingt `LayerCategory.lw`,
    /// "object"/`undefined` (Default) = Kategorie-Strichstärke.
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
// Rechteck) erzeugter 3D-Körper. Die Beschreibung baut `cmd_solid::extruded_solid_spec`, das Netz
// für Grundriss, Schnitt, Ansicht und 3D `solid_mesh.rs` ([115]), STEP truck — dieser Typ hält nur
// die Rohdaten.

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
    /// [180] Klasse (Ebene/Kategorie) wie bei jedem Bauteil: Sichtbarkeit in Grundriss, Schnitt und Ansicht.
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// [201] IFC-GlobalId des Quell-Bauteils (IFC-Import); der IFC-Export schreibt sie zurück, damit
    /// die Rundreise dieselben GUIDs behält. Kopien (Einfügen, Kopieren, Reihe, Wand teilen) tragen sie NICHT.
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
    /// Geschlossenes Profil in der XY-Ebene (Grundriss), ≥3 Punkte. Bei einem
    /// Kreis-Profil (`circle` gesetzt) eine Tessellierung des Kreises (48-Eck) —
    /// für 2D-Footprint/Auswahl/bbox/Verschieben; die 3D-Extrusion nutzt in dem
    /// Fall stattdessen `circle` (Zylinder bzw. Kegel, `solid_mesh.rs`).
    pub points: Vec<Vec2>,
    /// Extrusionshöhe in Metern (> 0), nach +Z ab der Geschoss-UK.
    pub height: f64,
    /// Abstand der Körper-UK über der Geschoss-UK (Meter, Default 0).
    #[serde(rename = "baseOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_offset: Option<f64>,
    /// Boolesche Rolle im Gebäude: "subtract" = Abzugskörper (Aussparung/Durchbruch/Nische).
    /// Er zieht sich von allen Wänden, Decken und Stützen ab, die er durchdringt — in 3D
    /// (Manifold-Boolean im Kern), im Grundriss und im Schnitt; selbst wird er nur als Umriss gezeigt.
    /// Fehlt = normaler Körper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"subtract\"")]
    pub operation: Option<String>,
    /// Vorsprung im Baurecht ([63]: Balkon, Erker): darf mit `SiteRules.projectionDepth`/
    /// `projectionShare` in den Grenzabstand ragen. Fehlt ⇒ normales Bauteil.
    #[serde(rename = "siteProjection", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site_projection: Option<bool>,
    /// Gesetzt, wenn das Profil ein Kreis ist (aus einem `Drawing2D` mit
    /// `shape:"circle"`) — `points` bleibt die Tessellierung, der Kern
    /// (`solid_mesh.rs`) nutzt `circle` für den runden Körper.
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
    /// [G1] Bauteil (Component Manager) des Körpers: Füllung und SIA-Schraffur der Schnittfläche im
    /// Grundriss und im Schnitt. Fehlt = neutrale Körper-Füllung mit Rückfall-Schraffur.
    #[serde(rename = "componentId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub component_id: Option<String>,
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
    /// [201] IFC-GlobalId des Quell-Bauteils (IFC-Import); der IFC-Export schreibt sie zurück, damit
    /// die Rundreise dieselben GUIDs behält. Kopien (Einfügen, Kopieren, Reihe, Wand teilen) tragen sie NICHT.
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
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

/// Kronenform eines Baums ([149]): Grundform der Silhouette (Schnitt/Ansicht), des 3D-Körpers und
/// des Schattenwerfers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum TreeShape {
    /// Kugelig (Laubbaum, Krone ≈ Kugel/Ellipsoid über dem Kronenansatz).
    #[default]
    #[serde(rename = "round")]
    Round,
    /// Oval (Krone höher als breit, Ellipsoid).
    #[serde(rename = "oval")]
    Oval,
    /// Säulenförmig (schlanker, hoher Zylinder mit gerundeten Enden).
    #[serde(rename = "columnar")]
    Columnar,
    /// Kegel (Nadelbaum, Spitze oben).
    #[serde(rename = "conical")]
    Conical,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Bestand eines Baums ([149]) nach Plankonvention: bestehend (schwarz), neu (rot/Planung),
/// zu fällen (gelb bzw. durchgekreuzt).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum TreeStatus {
    #[default]
    #[serde(rename = "existing")]
    Existing,
    #[serde(rename = "new")]
    New,
    #[serde(rename = "remove")]
    Remove,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Laub- oder Nadelbaum ([149]) — Planzeichen der Krone (Laub: Wellenkranz, Nadel: Zacken).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum TreeFoliage {
    #[default]
    #[serde(rename = "deciduous")]
    Deciduous,
    #[serde(rename = "conifer")]
    Conifer,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Ein Baum ([149]) — eigenes Objekt der Umgebung mit Stamm, Krone und Höhe. Grundriss/Situation
/// (Kronenkreis mit Planzeichen, Stamm), Schnitt/Ansicht (Silhouette nach Form), 3D (Stamm-Zylinder +
/// Krone), Schatten (Sonnenstudie), IFC (IfcGeographicElement). Fuss auf dem Gelände an `position`
/// (sonst auf der Geschoss-UK) plus `baseOffset`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Tree {
    pub id: String,
    #[ts(type = "\"tree\"")]
    pub r#type: String,
    /// Zugehörige Zeichnungsebene (Geschoss), auf der der Baum im Grundriss erscheint.
    #[serde(rename = "floorId")]
    pub floor_id: String,
    /// Grafik-Kategorie (Ebene), Vorgabe "13" (Bäume).
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Stammmitte im Grundriss (Meter).
    pub position: Vec2,
    /// Stammdurchmesser (m, > 0).
    #[serde(rename = "trunkDiameter")]
    pub trunk_diameter: f64,
    /// Kronendurchmesser (m, > 0).
    #[serde(rename = "crownDiameter")]
    pub crown_diameter: f64,
    /// Höhe des Kronenansatzes über dem Fuss (m, ≥ 0, < `height`).
    #[serde(rename = "crownBase")]
    pub crown_base: f64,
    /// Gesamthöhe über dem Fuss (m, > 0).
    pub height: f64,
    /// Kronenform.
    pub shape: TreeShape,
    /// Bestehend / neu / zu fällen.
    pub status: TreeStatus,
    /// Laub- oder Nadelbaum.
    pub foliage: TreeFoliage,
    /// Optionaler Art-Name (z. B. „Quercus robur"), erscheint als Beschriftung im Grundriss.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub species: Option<String>,
    /// [149] Art-Name als Beschriftung im Grundriss zeigen (nahe am Stamm; Vorgabe aus).
    #[serde(rename = "showLabel", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_label: Option<bool>,
    /// [149] Lage der Beschriftung (Griff): linker Rand der Zeile (Mitte) relativ zur Stammmitte (m); fehlt =
    /// rechts neben dem Stamm (1 mm Papier Abstand). Wandert mit dem Baum.
    #[serde(rename = "labelOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label_offset: Option<Vec2>,
    /// Höhenversatz des Fusses gegenüber Gelände bzw. Geschoss-UK (m, Vorgabe 0).
    #[serde(rename = "baseOffset", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_offset: Option<f64>,
    /// Optionale Übersteuerung der Strichfarbe; sonst gilt die Kategorie-Farbe bzw. die Bestandsfarbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Projektion einer Kamera ([213]): Perspektive, Axonometrie (Parallelprojektion mit schrägem Blick, z. B.
/// Isometrie) oder Parallelprojektion (frei ausgerichtet). Axonometrie und Parallel zeichnen im 3D orthografisch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum CameraProjection {
    #[default]
    #[serde(rename = "perspective")]
    Perspective,
    #[serde(rename = "axonometric")]
    Axonometric,
    #[serde(rename = "parallel")]
    Parallel,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Eine Kamera ([213]) — gespeicherter Standpunkt für die 3D-Ansicht (und das Rendering): Standpunkt im
/// Grundriss mit Augenhöhe über dem Geschoss, Ziel (Grundriss und absolute Höhe), Bildwinkel, Projektion
/// und optional Datum/Uhrzeit für den Sonnenstand. Im Grundriss als Symbol mit Sichtkegel auf der Klasse
/// „Kameras" (Vorgabe "92"); „Kamera öffnen" setzt die 3D-Ansicht exakt.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Camera {
    pub id: String,
    #[ts(type = "\"camera\"")]
    pub r#type: String,
    pub name: String,
    /// Geschoss, auf dem das Symbol im Grundriss steht und auf das sich die Augenhöhe bezieht.
    #[serde(rename = "floorId")]
    pub floor_id: String,
    /// Klasse (Ebene), Vorgabe "92" (Kameras).
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// Objekt-Sperre, analog `Wall.locked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    /// Standpunkt im Grundriss (Meter).
    pub position: Vec2,
    /// Augenhöhe über OK Fertigboden des Geschosses (m).
    #[serde(rename = "eyeHeight")]
    pub eye_height: f64,
    /// Ziel im Grundriss (Meter); der Abstand Standpunkt–Ziel ist die Länge des Sichtkegels.
    pub target: Vec2,
    /// Höhe des Ziels (m, absolut, z des Modells).
    #[serde(rename = "targetHeight")]
    pub target_height: f64,
    /// Vertikaler Bildwinkel (Grad, perspektivisch). Die Kleinbild-Brennweite folgt daraus (24-mm-Sensorhöhe).
    #[serde(rename = "fovDeg")]
    pub fov_deg: f64,
    pub projection: CameraProjection,
    /// Sichthöhe in Metern (volle Bildhöhe) bei Axonometrie/Parallel; fehlt = 10 m.
    #[serde(rename = "orthoHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ortho_height: Option<f64>,
    /// Zeitpunkt für den Sonnenstand (ISO-8601 in UTC wie `SunStudy.when`); „Kamera öffnen" setzt ihn in der
    /// Sonnenstudie. Fehlt er, bleibt die Sonne der Studie.
    #[serde(rename = "sunWhen", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sun_when: Option<String>,
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
    /// [149] Bäume (fehlt in älteren Dateien).
    #[serde(rename = "treeIds", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tree_ids: Option<Vec<String>>,
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
// Auswertung: Kern `plan/overrides.rs` ([33]: auch auf Bauteilschichten).

/// Bedingungs-Typ einer Override-Regel — wogegen der Wert verglichen wird:
///   • "layer_name"  — Name ODER Code der Ebene (LayerCategory) des Elements.
///   • "object_name" — Element-/Typ-Name (z. B. Wandtyp-Name, Raum-Name,
///     Öffnungs-Label, Drawing2D-Formname).
///   • "element_kind" — [33] Bauteilart: "wall", "slab" (Decke), "ground_slab"
///     (Bodenplatte), "roof".
///   Schicht-Bedingungen ([33]; eine Regel mit einer davon wirkt nur auf
///   Bauteilschichten, nicht auf ganze Elemente):
///   • "layer_function" — Funktion der Schicht (`LayerFunction`, sonst aus dem Baustoff).
///   • "layer_position" — Lage zur tragenden Schicht: "above" (oben/aussen),
///     "structure", "below" (unten/innen).
///   • "material" — Baustoff: id, Standard-Kennung (`std-c-…`) oder Name.
///   • "material_category" — Baustoff-Kategorie (aus Standard-Kennung/Name abgeleitet:
///     "concrete", "masonry", "timber", "insulation", "screed", "flooring", "plaster",
///     "loose_fill", "metal", "glass", "membrane", "air", "cladding", "stone", "other").
/// Ein `user_string`-Tag (DOSSIER-Rhino) existiert am Element noch nicht und
/// ist deshalb bewusst NICHT enthalten (kein Schein-Feature).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum OverrideConditionType {
    #[default]
    #[serde(rename = "layer_name")]
    LayerName,
    #[serde(rename = "object_name")]
    ObjectName,
    #[serde(rename = "element_kind")]
    ElementKind,
    #[serde(rename = "layer_function")]
    LayerFunction,
    #[serde(rename = "layer_position")]
    LayerPosition,
    #[serde(rename = "material")]
    Material,
    #[serde(rename = "material_category")]
    MaterialCategory,
    /// [33] Darstellung: "plan" (Grundriss, Deckenspiegel), "section" (Schnitt), "elevation" (Ansicht).
    #[serde(rename = "view_kind")]
    ViewKind,
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
    /// [33] Füllfarbe geschnittener Flächen/Schichten (hex) — hat Vorrang vor der
    /// Massstabsregel „Schnittflächen 1:100 schwarz“.
    #[serde(rename = "fillColor", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill_color: Option<String>,
    /// [33] Schraffur geschnittener Flächen/Schichten: "none" (ohne), "material"
    /// (Schraffur des Baustoffs, auch ab 1:100) oder die id einer Schraffur.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hatch: Option<String>,
    /// [33] Umriss/Fugenlinie geschnittener Flächen/Schichten: an (true) oder aus.
    /// Benachbarte Schichten mit gleicher Darstellung ohne Muster bilden eine Fläche.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outline: Option<bool>,
    /// [33] Bauteil ausblenden (Grundriss, Deckenspiegel, Schnitt, Ansicht: Element samt Linien, Schraffur und
    /// Beschriftung entfällt und verdeckt nichts; eine Wand nimmt ihre Öffnungen mit; Bemassung bleibt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hide: Option<bool>,
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
    /// [33] Weitere Bedingungen; die Regel trifft nur, wenn ALLE zutreffen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub conditions: Option<Vec<OverrideCondition>>,
    /// [33] Massstab-Kriterium: Regel wirkt nur ab Massstab 1:`minScale` (Nenner ≥, z. B. 100 = „ab 1:100“).
    #[serde(rename = "minScale", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub min_scale: Option<f64>,
    /// [33] Massstab-Kriterium: Regel wirkt nur bis Massstab 1:`maxScale` (Nenner ≤).
    #[serde(rename = "maxScale", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_scale: Option<f64>,
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
    /// Ansichtsvorlage ([34]) des Ausschnitts (einmal angewendet oder verknüpft).
    #[serde(rename = "templateId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template_id: Option<String>,
    /// `true` ⇒ der Ausschnitt folgt der Vorlage.
    #[serde(rename = "templateLinked", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template_linked: Option<bool>,
    /// [173] Modelldarstellung (`Project.modelViewOptions`, Id einer eigenen Stufe oder „grob"/„mittel"/„fein").
    /// Fehlt ⇒ der Detailgrad allein bestimmt die Darstellung (heutiges Verhalten).
    #[serde(rename = "modelViewOptionId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_view_option_id: Option<String>,
    /// [205] Pausfolie des Ausschnitts (nur Anzeige, nie im Druck).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trace: Option<TraceReference>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [205] Pausfolie (Archicad „Pausfolie & Referenz"): eine andere Ansicht gedämpft hinter (oder über) der
/// aktiven — nur Anzeige, nie anwählbar, nie im Druck/Export. Lebt je Reiter (UI-Zustand `uiState.viewTabs`)
/// und im Ausschnitt; das Modell ändert sie nie. Gezeichnet über die Kern-Abfrage `tracePlan` (`plan/trace.rs`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct TraceReference {
    /// Quell-Ebene (`DrawingLevel.id`: Geschoss, Schnitt, Ansicht, Zeichnung, Deckenspiegel).
    #[serde(rename = "sourceId")]
    pub source_id: String,
    /// Eingeschaltet (das Kürzel schaltet nur dies, die Einstellungen bleiben).
    pub show: bool,
    /// Farbe `#rrggbb`; fehlt = Grau.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Deckkraft 0…1.
    pub opacity: f64,
    /// Verschiebung der Pause in Metern (nach der Drehung).
    pub offset: Vec2,
    /// Drehung der Pause in Grad (CCW um den Ursprung).
    pub rotation: f64,
    /// Über statt unter der aktiven Ansicht.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub above: Option<bool>,
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

/// Quelle einer Blatt-Tabelle ([111]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum LayoutTableSource {
    /// Fenster- und Türliste ([97]).
    #[default]
    #[serde(rename = "openings")]
    Openings,
    /// Flächentabelle nach SIA 416 ([70]).
    #[serde(rename = "areas")]
    Areas,
    /// Raumprogramm Soll/Ist.
    #[serde(rename = "rooms")]
    Rooms,
    /// Bauteilliste mit U-Werten ([71]).
    #[serde(rename = "elements")]
    Elements,
    /// [68] Erdarbeiten: Baugruben mit Abtrag/Auftrag/Hinterfüllung.
    #[serde(rename = "earthworks")]
    Earthworks,
    /// [158] Raumbuch: Oberflächen je Raum.
    #[serde(rename = "roomBook")]
    RoomBook,
    /// [209] Kostenschätzung grob (eBKP-H-Hauptgruppen, Zuschläge, Total).
    #[serde(rename = "costs")]
    Costs,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Eine lebendige Tabelle auf einem Layout-Blatt ([111]): zeigt eine Liste des Modells (Fenster/Türen,
/// Flächen, Raumprogramm, Bauteile) im Rahmen `xMm`/`yMm`/`widthMm`/(`heightMm`). Ist `heightMm` gesetzt, zeigt
/// die Tabelle nur so viele Zeilen, wie hineinpassen; `continues` verweist auf die vorige Tabelle, deren Rest sie zeigt.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayoutTable {
    pub id: String,
    pub source: LayoutTableSource,
    /// Linke Kante auf dem Blatt (mm, von links).
    #[serde(rename = "xMm")]
    pub x_mm: f64,
    /// Obere Kante auf dem Blatt (mm, von oben).
    #[serde(rename = "yMm")]
    pub y_mm: f64,
    /// Breite (mm).
    #[serde(rename = "widthMm")]
    pub width_mm: f64,
    /// Höhe des Rahmens (mm); fehlt sie, zeigt die Tabelle alle Zeilen.
    #[serde(rename = "heightMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height_mm: Option<f64>,
    /// Gewählte Spalten (Kennungen der Quelle, in Reihenfolge); fehlt sie, gelten die Standard-Spalten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub columns: Option<Vec<String>>,
    /// Einschränkung der Quelle: Öffnungen "window"/"door".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filter: Option<String>,
    /// Textstil ({@link TextStylePreset.id}): Schrift, Grösse, fett.
    #[serde(rename = "textStyleId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text_style_id: Option<String>,
    /// Schriftgrösse in pt (übersteuert den Textstil); Standard 8.
    #[serde(rename = "fontSizePt", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub font_size_pt: Option<f64>,
    /// Zeilenhöhe in mm; Standard 1.9 × Schrifthöhe.
    #[serde(rename = "rowHeightMm", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub row_height_mm: Option<f64>,
    /// Linien: "grid" (Standard), "rows" (nur waagrecht), "outer" (Rahmen + Kopflinie), "none".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub borders: Option<String>,
    /// Kopfzeile zeigen (Standard ja).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub header: Option<bool>,
    /// Vorige Tabelle ({@link LayoutTable.id}), deren übrige Zeilen diese Tabelle zeigt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub continues: Option<String>,
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
    /// Revisionsindex des Blatts (z. B. "A", "B" oder "2"); steht im Titelblock, wird beim
    /// Publizieren eines Satzes optional hochgezählt ([79]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub revision: Option<String>,
    /// Grafische Legenden auf dem Blatt ([82]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub legends: Option<Vec<LayoutLegend>>,
    /// Lebendige Tabellen auf dem Blatt ([111]); fehlt = keine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tables: Option<Vec<LayoutTable>>,
    /// Bilder auf dem Blatt ([208]): Renderings, Fotos, Luftbilder; fehlt = keine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub images: Option<Vec<LayoutImage>>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Bild auf einem Layout-Blatt ([208]): PNG oder JPEG als Data-URL (gleicher Weg wie `ContextImage.src`),
/// im Rahmen `xMm`/`yMm`/`widthMm`/`heightMm` (Papier-mm). Das Seitenverhältnis des Ausschnitts bleibt erhalten;
/// `crop` schneidet zu (Anteile 0..1 des Originals). Im PDF wird das Original unverändert eingebettet (JPEG ohne
/// Neukompression).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayoutImage {
    pub id: String,
    /// Anzeigename (Dateiname).
    pub name: String,
    /// Bildquelle als Data-URL (`data:image/png;base64,…` oder `data:image/jpeg;base64,…`).
    pub src: String,
    /// Linke Kante auf dem Blatt (mm, von links).
    #[serde(rename = "xMm")]
    pub x_mm: f64,
    /// Obere Kante auf dem Blatt (mm, von oben).
    #[serde(rename = "yMm")]
    pub y_mm: f64,
    /// Breite des gezeigten Ausschnitts (mm).
    #[serde(rename = "widthMm")]
    pub width_mm: f64,
    /// Höhe des gezeigten Ausschnitts (mm).
    #[serde(rename = "heightMm")]
    pub height_mm: f64,
    /// Pixelbreite des Originals (aus dem Dateikopf gelesen).
    #[serde(rename = "pixelWidth")]
    pub pixel_width: f64,
    /// Pixelhöhe des Originals.
    #[serde(rename = "pixelHeight")]
    pub pixel_height: f64,
    /// Zuschnitt als Anteile des Originals (0..1); fehlt = ganzes Bild.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub crop: Option<LayoutImageCrop>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Zuschnitt eines Blatt-Bilds ([208]): linke/obere Kante und Breite/Höhe als Anteile des Originals.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayoutImageCrop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Hilfslinie eines Masters ([208], Gestaltungsraster): senkrecht (`x`) oder waagrecht (`y`) in Papier-mm.
/// Nur am Bildschirm, nie im Druck.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayoutGuide {
    /// "x" = senkrechte Linie bei `posMm` von links, "y" = waagrechte Linie bei `posMm` von oben.
    pub axis: String,
    #[serde(rename = "posMm")]
    pub pos_mm: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Wettbewerbs-Einstellung des Projekts ([208]): anonym = Kennwort statt Büro- und Projektname in Plankopf,
/// Dateinamen und PDF-Metadaten.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct CompetitionSettings {
    /// Anonyme Abgabe: keine Büro-/Autor-Angaben in Export und Plankopf.
    pub anonymous: bool,
    /// Kennwort der Abgabe (steht in Plankopf und PDF-Titel).
    pub keyword: String,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [209] Bezugsmenge eines Kostenkennwerts (Kostenschätzung nach der Kennwert-Methode).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum CostBasis {
    /// Die Menge der Methode des Projekts (`CostEstimate.method`: m³ GV oder m² GF).
    #[default]
    #[serde(rename = "method")]
    Method,
    /// Gebäudevolumen GV (m³, SIA 416).
    #[serde(rename = "gv")]
    Gv,
    /// Geschossfläche GF (m², SIA 416).
    #[serde(rename = "gf")]
    Gf,
    /// Hauptnutzfläche HNF (m², SIA 416).
    #[serde(rename = "hnf")]
    Hnf,
    /// Fassadenfläche (m², Aussenumfang × Geschosshöhe).
    #[serde(rename = "facade")]
    Facade,
    /// Dachfläche (m², geneigte Dachflächen, ohne Dach die oberirdische Grundfläche).
    #[serde(rename = "roof")]
    Roof,
    /// Pauschal: der Kennwert ist der Betrag (Menge 1).
    #[serde(rename = "lump")]
    Lump,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [209] Hauptmenge der Kostenschätzung: m³ GV oder m² GF.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub enum CostMethod {
    #[default]
    #[serde(rename = "gv")]
    Gv,
    #[serde(rename = "gf")]
    Gf,
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// [209] Eine Zeile der Kennwert-Tabelle: eBKP-H-Hauptgruppe (B–J) oder eine zusammengefasste Gruppe.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct CostGroup {
    /// Kennung der Gruppe nach eBKP-H (SN 506 511), z. B. „C“ oder „B–J“.
    pub code: String,
    /// Eigene Bezeichnung; fehlt = Name der eBKP-H-Hauptgruppe (aus `code`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub basis: CostBasis,
    /// Kennwert in CHF je Einheit der Bezugsmenge (pauschal: CHF).
    pub rate: f64,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [209] Grobe Kostenschätzung (Vorprojekt/Wettbewerb) nach der Kennwert-Methode: Menge × Kennwert je
/// eBKP-H-Hauptgruppe, dazu Honorare, Reserve und MwSt in Prozent. Fehlt das Feld, rechnet der Kern mit
/// Beispielwerten (`kosten::default_estimate`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct CostEstimate {
    pub method: CostMethod,
    pub groups: Vec<CostGroup>,
    /// Honorare (eBKP-H V) in % der Summe B–J.
    #[serde(rename = "feesPct")]
    pub fees_pct: f64,
    /// Reserve/Unvorhergesehenes (eBKP-H Y) in % der Summe B–J + Honorare.
    #[serde(rename = "reservePct")]
    pub reserve_pct: f64,
    /// Mehrwertsteuer (eBKP-H Z) in %.
    #[serde(rename = "vatPct")]
    pub vat_pct: f64,
    /// Genauigkeit der Schätzung ± in %.
    #[serde(rename = "accuracyPct")]
    pub accuracy_pct: f64,
    /// Region-Faktor auf alle Kennwerte (1 = keiner).
    #[serde(rename = "regionFactor")]
    pub region_factor: f64,
    /// Teuerung vom Preisstand der Kennwerte bis heute als Faktor (Baupreisindex neu / alt; 1 = keine).
    #[serde(rename = "indexFactor")]
    pub index_factor: f64,
    /// Preisstand der Kennwerte (Text, z. B. „Okt. 2025, Baupreisindex Hochbau“).
    #[serde(rename = "priceBase")]
    pub price_base: String,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Grafische Legende auf einem Layout-Blatt ([82]): listet Schraffuren/Materialien, Linientypen und/oder
/// Kategorien der gezeigten Viewports (`manualKeys` leer) oder einer Handauswahl, mit Muster und Name.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct LayoutLegend {
    pub id: String,
    /// Linke Kante auf dem Blatt (mm).
    #[serde(rename = "xMm")]
    pub x_mm: f64,
    /// Obere Kante auf dem Blatt (mm).
    #[serde(rename = "yMm")]
    pub y_mm: f64,
    /// Titel; fehlt = „Legende".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// Gezeigte Arten: "hatch", "lineType", "category"; fehlt = nur Schraffuren.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kinds: Option<Vec<String>>,
    /// Handauswahl als Schlüssel "hatch:<id>", "lineType:<id>", "category:<code>"; leer/fehlt = automatisch
    /// aus den Viewports des Blatts.
    #[serde(rename = "manualKeys", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub manual_keys: Option<Vec<String>>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Publikationssatz ([79]): benannte Menge von Layouts (und optional Ansichten) mit Ausgabe-Einstellungen.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct PublishSet {
    pub id: String,
    pub name: String,
    /// Layouts des Satzes in Ausgabe-Reihenfolge.
    #[serde(rename = "layoutIds")]
    pub layout_ids: Vec<String>,
    /// Gespeicherte Ansichten, die zusätzlich als eigene Seiten ausgegeben werden.
    #[serde(rename = "snapshotIds", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snapshot_ids: Option<Vec<String>>,
    /// "pdf-multi" (ein PDF, Standard), "pdf-single" (je Blatt eine Datei), "dxf" (DXF mit Layouts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub format: Option<String>,
    /// Dateinamen-Muster mit {Projektnummer} {Projekt} {Blattnummer} {Blattname} {Index} {Datum} {Satz}.
    #[serde(rename = "namePattern", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name_pattern: Option<String>,
    /// Papierformat-Übersteuerung für alle Blätter des Satzes.
    #[serde(rename = "paperOverride", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub paper_override: Option<LayoutPaperFormat>,
    /// Massstab-Übersteuerung (1:N) für alle Viewports des Satzes.
    #[serde(rename = "scaleOverride", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scale_override: Option<f64>,
    /// Revisionsindex im Titelblock/Dateinamen ausgeben (Standard ja).
    #[serde(rename = "includeRevision", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub include_revision: Option<bool>,
    /// Revisionsindex je Blatt beim Publizieren erhöhen (A→B, 1→2).
    #[serde(rename = "bumpRevision", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bump_revision: Option<bool>,
    /// PDF-Ebenen (Optional Content) je Kategorie.
    #[serde(rename = "pdfLayers", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pdf_layers: Option<bool>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein Blatt im Publikationsprotokoll.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct PublishLogSheet {
    #[serde(rename = "layoutId")]
    pub layout_id: String,
    pub number: String,
    pub name: String,
    pub revision: String,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Protokolleintrag einer Publikation ([79]): Datum, Blätter mit Revision, erzeugte Dateien.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct PublishLogEntry {
    pub id: String,
    #[serde(rename = "setId")]
    pub set_id: String,
    #[serde(rename = "setName")]
    pub set_name: String,
    /// ISO-Zeitstempel.
    pub date: String,
    pub sheets: Vec<PublishLogSheet>,
    pub files: Vec<String>,
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
    /// Vorlagen-Schlüssel ([208], z. B. "poster-a1-landscape"): wiederverwendet den Master beim Anlegen weiterer Plakate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template: Option<String>,
    /// Plakat-Kopfzeile ([208]): Band über die Satzbreite mit Kennwort-Feld, Projekttitel und „Plan x/n".
    #[serde(rename = "posterHeader", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub poster_header: Option<bool>,
    /// Massstab unter jedem Viewport ausgeben ([208]).
    #[serde(rename = "viewportScaleLabels", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub viewport_scale_labels: Option<bool>,
    /// Hilfslinien des Gestaltungsrasters ([208]), nur am Bildschirm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub guides: Option<Vec<LayoutGuide>>,
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
    /// Linienenden aller Striche ([146]); fehlt = flach (`butt`).
    #[serde(rename = "lineCap", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_cap: Option<LineCap>,
    /// Linienecken aller Striche ([146]); fehlt = Gehrung (`miter`, Grenze 4).
    #[serde(rename = "lineJoin", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_join: Option<LineJoin>,
    /// UI-Zustand beim Speichern ([136]: offene Zeichnungs-Reiter). Kein Modell: nie über Ops, nie im Verlauf;
    /// die App schreibt es beim Speichern (`serializeProject`) und liest es beim Öffnen.
    #[serde(rename = "uiState", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ui_state: Option<UiState>,
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
    /// [181] Gelände- und Umgebungs-Elemente (Gelände, Höhenlinien, Netzkörper wie Nachbargebäude, Luftbilder,
    /// Baugruben): normale Elemente mit Klasse (`categoryCode`), unabhängig von ihrer Herkunft; s.
    /// {@link ContextObject}. Fehlt das Feld, gilt die Liste als leer.
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
    /// Bäume ([149]) — eigene Objekte mit Stamm, Krone und Höhe, siehe {@link Tree}. Optional, damit
    /// bestehende Projekte ohne `trees` gültig bleiben (Default: leer behandeln).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trees: Option<Vec<Tree>>,
    /// Kameras ([213]) — gespeicherte Standpunkte für 3D-Ansicht und Rendering, siehe {@link Camera}. Optional
    /// (Default: leer behandeln).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cameras: Option<Vec<Camera>>,
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
    /// Ansichtsvorlagen ([34]). Optional: Alt-Projekte ohne Feld bleiben gültig.
    #[serde(rename = "viewTemplates", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_templates: Option<Vec<ViewTemplate>>,
    /// [173] Modelldarstellungen: eigene Stufen der Darstellung (wie Archicads „Modelldarstellung"), je
    /// Bauteilart wählbare Optionen über einem Basis-Detailgrad. Die Stufen „grob", „mittel", „fein" sind
    /// eingebaut und stehen nicht in der Liste. Optional: Alt-Projekte ohne Feld bleiben gültig.
    #[serde(rename = "modelViewOptions", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_view_options: Option<Vec<ModelViewOption>>,
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
    /// Publikationssätze ([79]).
    #[serde(rename = "publishSets", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub publish_sets: Option<Vec<PublishSet>>,
    /// Publikationsprotokoll ([79]), neueste zuletzt.
    #[serde(rename = "publishLog", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub publish_log: Option<Vec<PublishLogEntry>>,
    /// Projektnummer für Titelblock und Dateinamen ([79]).
    #[serde(rename = "projectNumber", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_number: Option<String>,
    /// Wettbewerb ([208]): anonyme Abgabe mit Kennwort.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub competition: Option<CompetitionSettings>,
    /// [209] Kostenschätzung grob (Kennwerte, Zuschläge); fehlt = Beispielwerte.
    #[serde(rename = "costEstimate", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_estimate: Option<CostEstimate>,
    /// Höhe von ±0.00 (OK fertig Boden des Bezugsgeschosses, `DrawingLevel.zeroLevel`)
    /// in Metern über Meer (m ü. M.), editierbar im Einstellungs-Fenster. Optional.
    /// Die automatischen Koten im Schnitt/in der Ansicht schreiben „±0.00 = 512.40"
    /// ([131]); Terrain-Draping liest den Wert noch nicht.
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
    /// [181] Klasse/Ebene (Grafik-Kategorie, s. {@link LayerCategory}): steuert Sichtbarkeit, Grau und
    /// Sperren wie bei jedem anderen Element. Pflicht; Importe setzen sie (`model/contextCategories.ts`).
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// [181] Herkunft (z. B. „swissBUILDINGS3D", „IFC IfcSite", „DXF-Layer Haus") — nur Auskunft in der
    /// Objekt-Info, ohne jede Wirkung auf Darstellung oder Sichtbarkeit (die steuert allein `categoryCode`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
    /// Farbe aus der Quelldatei (`#rrggbb`, z. B. IFC-Oberflächenstil/Material); fehlt sie, gilt die Kontext-Grundfarbe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// IFC-GlobalId des Quell-Bauteils (IFC-Import je Bauteil).
    #[serde(rename = "ifcGlobalId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ifc_global_id: Option<String>,
    /// [T4] Glatt schattieren (geteilte Normalen an Kanten über dem Knickwinkel); fehlt = kantig.
    #[serde(rename = "smoothShading", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub smooth_shading: Option<bool>,
    /// [T4] Knickwinkel in Grad für das glatte Schattieren (Default 30°).
    #[serde(rename = "creaseAngle", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crease_angle: Option<f64>,
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
    /// [181] Klasse/Ebene (Grafik-Kategorie, s. {@link LayerCategory}): steuert Sichtbarkeit, Grau und
    /// Sperren wie bei jedem anderen Element. Pflicht; Importe setzen sie (`model/contextCategories.ts`).
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// [181] Herkunft (z. B. „swissBUILDINGS3D", „IFC IfcSite", „DXF-Layer Haus") — nur Auskunft in der
    /// Objekt-Info, ohne jede Wirkung auf Darstellung oder Sichtbarkeit (die steuert allein `categoryCode`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
    pub contours: Vec<Contour>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// Ein TIN-Geländemodell, abgeleitet aus Konturen (Delaunay über (x,y), Z aus der
/// jeweiligen Kontur-Höhe). `positions` = flaches (x,y,z…)-Array in Metern,
/// `indices` = Dreiecks-Indizes. Gelände-Element ([181]): aus Höhenlinien erzeugt oder importiert (swissALTI3D,
/// IFC-Gelände), danach unabhängig von der Quelle.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct TerrainMesh {
    pub id: String,
    pub name: String,
    /// [181] Klasse/Ebene (Grafik-Kategorie, s. {@link LayerCategory}): steuert Sichtbarkeit, Grau und
    /// Sperren wie bei jedem anderen Element. Pflicht; Importe setzen sie (`model/contextCategories.ts`).
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// [181] Herkunft (z. B. „swissBUILDINGS3D", „IFC IfcSite", „DXF-Layer Haus") — nur Auskunft in der
    /// Objekt-Info, ohne jede Wirkung auf Darstellung oder Sichtbarkeit (die steuert allein `categoryCode`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
    pub positions: Vec<f64>,
    pub indices: Vec<f64>,
    /// Optionale Pro-Vertex-Albedo (flach `[r,g,b, …]`, 0..1) — ein Wert je
    /// Positions-Vertex, beim Import aus einem SWISSIMAGE-Luftbild gesampelt
    /// („Luftbild aufs Gelände drapieren"). render3d färbt das TIN dann pro Vertex
    /// statt mit der Grundfarbe. Fehlt es, bleibt das Gelände einfarbig.
    #[serde(rename = "vertexColors", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vertex_colors: Option<Vec<f64>>,
    /// [T6] Äquidistanz der Höhenlinien im Grundriss in m (aus dem Netz neu erzeugt, inkl. Baugruben).
    /// Fehlt der Wert oder ist er ≤ 0, zeigt der Grundriss nur den Rahmen.
    #[serde(rename = "contourInterval", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub contour_interval: Option<f64>,
    /// [T6] Jede n-te Höhenlinie ist Zähllinie (dicker, beschriftet). Default 5.
    #[serde(rename = "contourIndexEvery", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub contour_index_every: Option<f64>,
    /// [T6] Tiefe des Erdreich-Bands im Schnitt unter dem Gelände in m (Default 1.5).
    #[serde(rename = "earthDepth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub earth_depth: Option<f64>,
    /// [137] Glättungsstufe, mit der das Netz aus Höhenlinien erzeugt wurde (0 = roh, 1–4 Kantenteilungen).
    /// Fehlt bei importierten Netzen (swissALTI3D) — dann gibt es nichts neu zu glätten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub smooth: Option<f64>,
    /// [137] Quelle: Id des Höhenlinien-Satzes (`contourSet`), aus dem das Netz erzeugt wurde.
    #[serde(rename = "sourceId", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_id: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Extra,
}

/// [68] Baugrube / Geländebearbeitung: Sohle als Umriss auf der Höhe `bottom` (m, Modell ±0.00).
/// Ausserhalb steigt die Böschung mit `slope` (Grad, Default 45; je Kante `edgeSlopes`, 0 = Default)
/// bis zum Gelände (Abtrag); liegt das Gelände tiefer, fällt eine Schüttung mit `fillSlope` (Default
/// 33.7 ≈ 2:3) bis zum Gelände (Auftrag). Bermen: alle `bermHeight` m Höhe eine waagrechte Berme der
/// Breite `bermWidth`. Schneidet jedes Gelände-Netz, das den Umriss enthält.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Excavation {
    pub id: String,
    pub name: String,
    /// [181] Klasse/Ebene (Grafik-Kategorie, s. {@link LayerCategory}): steuert Sichtbarkeit, Grau und
    /// Sperren wie bei jedem anderen Element. Pflicht; Importe setzen sie (`model/contextCategories.ts`).
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    pub outline: Vec<Vec2>,
    /// [191] Bögen im Umriss: je Kante (Punkt i → i+1) ein Bulge wie bei `Ceiling.outlineBulge`
    /// (`tan(Öffnungswinkel/4)`, positiv = Scheitel links; fehlt/0 = Gerade). Die Ableitungen (Böschung,
    /// Arbeitsraum, Verbau, Schnitt, 3D, Plan) rechnen auf dem fein geteilten Umriss; `edgeSlopes`/`edgeShoring`
    /// gelten je Kante dieses Felds (eine Bogenkante = ein Eintrag).
    #[serde(rename = "outlineBulge", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outline_bulge: Option<Vec<f64>>,
    pub bottom: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slope: Option<f64>,
    #[serde(rename = "fillSlope", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill_slope: Option<f64>,
    #[serde(rename = "edgeSlopes", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub edge_slopes: Option<Vec<f64>>,
    #[serde(rename = "bermWidth", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub berm_width: Option<f64>,
    #[serde(rename = "bermHeight", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub berm_height: Option<f64>,
    /// [68] Arbeitsraum in m: der Umriss gilt als Gebäude-Grundfläche, die Sohle liegt um dieses Mass
    /// weiter aussen (Gehrung an den Ecken). Fehlt = 0 (Umriss = Sohle).
    #[serde(rename = "workingSpace", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub working_space: Option<f64>,
    /// [68] Senkrechter Verbau (Spundwand) je Kante (wie `edgeSlopes`): keine Böschung, Wand steht senkrecht.
    #[serde(rename = "edgeShoring", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub edge_shoring: Option<Vec<bool>>,
    /// [68] Art des Verbaus auf den verbauten Kanten: `sheetPile` (Spundwand, Vorgabe), `soldierPile` (Rühlwand),
    /// `borePile` (Bohrpfahlwand). Bestimmt Vorgabe-Dicke und Schraffur im Schnitt und Grundriss.
    #[serde(rename = "shoringKind", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shoring_kind: Option<String>,
    /// [68] Dicke der Verbauwand in m (nach aussen von der Sohlkante); fehlt = Vorgabe der Art.
    #[serde(rename = "shoringThickness", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shoring_thickness: Option<f64>,
    /// [68] Einbindetiefe der Verbauwand unter die Sohle in m; fehlt = 1 m.
    #[serde(rename = "shoringEmbed", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shoring_embed: Option<f64>,
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
    /// [181] Klasse/Ebene (Grafik-Kategorie, s. {@link LayerCategory}): steuert Sichtbarkeit, Grau und
    /// Sperren wie bei jedem anderen Element. Pflicht; Importe setzen sie (`model/contextCategories.ts`).
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    /// [181] Herkunft (z. B. „swissBUILDINGS3D", „IFC IfcSite", „DXF-Layer Haus") — nur Auskunft in der
    /// Objekt-Info, ohne jede Wirkung auf Darstellung oder Sichtbarkeit (die steuert allein `categoryCode`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
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
            "lineCap" => {
                self.line_cap = match v {
                    Some(v) => <Option<LineCap>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "lineJoin" => {
                self.line_join = match v {
                    Some(v) => <Option<LineJoin>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "uiState" => {
                self.ui_state = match v {
                    Some(v) => <Option<UiState>>::deserialize(v).map_err(|e| e.to_string())?,
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
            "trees" => {
                self.trees = match v {
                    Some(v) => <Option<Vec<Tree>>>::deserialize(v).map_err(|e| e.to_string())?,
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
            "viewTemplates" => {
                self.view_templates = match v {
                    Some(v) => <Option<Vec<ViewTemplate>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "modelViewOptions" => {
                self.model_view_options = match v {
                    Some(v) => <Option<Vec<ModelViewOption>>>::deserialize(v).map_err(|e| e.to_string())?,
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
            "publishSets" => {
                self.publish_sets = match v {
                    Some(v) => <Option<Vec<PublishSet>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "publishLog" => {
                self.publish_log = match v {
                    Some(v) => <Option<Vec<PublishLogEntry>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "projectNumber" => {
                self.project_number = match v {
                    Some(v) => <Option<String>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "competition" => {
                self.competition = match v {
                    Some(v) => <Option<CompetitionSettings>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "costEstimate" => {
                self.cost_estimate = match v {
                    Some(v) => <Option<CostEstimate>>::deserialize(v).map_err(|e| e.to_string())?,
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

