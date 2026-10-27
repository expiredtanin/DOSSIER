// Das semantische Gebäudemodell — der Kern von BIM.
// Bauteile haben Bedeutung, nicht nur Form. Eine Tür "kennt" ihre Wand,
// eine Wand "kennt" ihren mehrschichtigen Aufbau (WallType).
//
// Dokumentmodell (nach DOSSIER): zwei UNABHÄNGIGE Achsen.
//   1. Zeichnungsebenen (DrawingLevel) = oberste Schnitte: Geschosse +
//      Schnitte/Ansichten.
//   2. Ebenen (LayerCategory) = Grafik-Kategorie-Schema, das für jedes
//      Geschoss gilt. Ein Element lebt auf einer Kategorie (code) UND einem
//      Geschoss.

export type Vec2 = { x: number; y: number };

// SIA-416-Blatt-Kategorie eines Raums. Der reine Rechenkern (geometry/roomArea)
// definiert den Typ; hier nur der Typ-Import (kein Zyklus zur Laufzeit).
import type { SiaCategory } from "../geometry/roomArea";
export type { SiaCategory } from "../geometry/roomArea";
// Rich-Text-Dokument für den Raum-Stempel (frei editierbarer Teil).
import type { RichTextDoc, Align, Marks, TextStylePreset } from "../text/richText";
export type { RichTextDoc } from "../text/richText";
// Ansichts-Enums für Ausschnitte/View-Snapshots (Ansichtstyp, Kamera-Preset,
// Detailgrad). Rein type-only importiert — zur Laufzeit erased, kein Zyklus
// (TopBar importiert seinerseits nur `Project` als Typ). Wie SiaCategory oben.
import type { DetailLevel, View3d, ViewType } from "./viewTypes";

// ── Ressourcen-Bibliotheken (Vectorworks-/DOSSIER-Stil) ────────────────────
// Verwaltete, per id verwiesene Stil-Ressourcen. Verweis-Kette:
//   Component → Hatch → LineStyle.
// Darstellung wird beim Rendern aus diesen Ressourcen aufgelöst, nie in die
// Geometrie eingebacken (siehe docs/design/resources-graphics.md).

/** Ein wiederverwendbarer Linienstil (Line Manager). */
/**
 * Ein Stift (ArchiCAD-Stiftsatz-Muster): ein reiner NAME/PLATZHALTER, der
 * projektweit über alle {@link PenSet}s hinweg dieselbe Identität `id` behält.
 * Ein Stift trägt selbst KEINE Farbe — welche Farbe er zeigt, bestimmt der
 * jeweils AKTIVE Stiftsatz (`Project.activePenSetId`). Ein Bauteil/eine Ebene,
 * die statt einer freien Farbe auf einen Stift zeigt (`xxxPenId`), übernimmt
 * dadurch automatisch jede Farbänderung des Stifts bzw. jeden Stiftsatz-
 * Wechsel — ohne selbst angefasst zu werden.
 */
export interface ColorPen {
  id: string;
  name: string;
}

/**
 * Ein Stiftsatz — ordnet JEDEM Stift (`ColorPen.id`) eine konkrete Farbe zu.
 * Mehrere Stiftsätze können nebeneinander existieren (z. B. „Standard",
 * „Plot S/W", „Präsentation"); nur einer ist je Projekt AKTIV
 * (`Project.activePenSetId`). Fehlt ein Stift im `colors`-Objekt (z. B. neu
 * angelegt, aber in diesem Satz noch nicht befüllt), gilt `PEN_FALLBACK_COLOR`
 * (s. `model/penSets.ts`).
 */
/**
 * Farbe + Strichstärke EINES Stifts in EINEM Stiftsatz — wie ein echter
 * ArchiCAD-/AutoCAD-Stift wandern beide zusammen, wenn ein Element/eine Ebene
 * auf diesen Stift gestellt wird (s. `Component.colorPenId`-Doku).
 */
export interface PenStyle {
  color: string;
  /** Strichstärke in Millimetern. */
  weight: number;
}

export interface PenSet {
  id: string;
  name: string;
  /** Stift-ID (`ColorPen.id`) → Farbe+Strichstärke. */
  pens: Record<string, PenStyle>;
}

/**
 * Eine benutzerdefinierte Farbpalette (Farbmischer → „Diese Farbe
 * speichern", `ui/FreeColorPicker.tsx`). Anders als Stiftsätze: reine
 * Farb-Sammlung ohne Kopplungs-/Baking-Semantik — ein Klick auf einen
 * Swatch übernimmt einfach den Hex-Wert wie bei den mitgelieferten
 * Paletten (Einfach/Tango/Material/RAL), nur eben frei befüllbar. Mehrere
 * Paletten können nebeneinander existieren (z. B. „Fassade Projekt X",
 * „Innenausbau"); keine ist „aktiv" — alle sind gleichzeitig über den
 * Paletten-Umschalter erreichbar.
 */
export interface CustomPalette {
  id: string;
  name: string;
  /** Hex-Werte, Reihenfolge = Anzeigereihenfolge im Raster. */
  colors: string[];
  /**
   * Im Farbwahl-Popover anzeigen? Fehlt das Feld, gilt `true` (sichtbar) —
   * so bleiben bestehende Projekte unverändert. Umschaltbar im Ressourcen-
   * Manager (Tab „Paletten"), damit die Bank-Leiste im Popover kurz bleibt.
   */
  visible?: boolean;
}

/**
 * Sichtbarkeit der MITGELIEFERTEN Farbpaletten-Bänke im Farbwahl-Popover
 * (`ui/FreeColorPicker.tsx`). Fehlt ein Schlüssel (oder das ganze Objekt),
 * gilt die Bank als sichtbar — nur ein explizites `false` blendet sie aus
 * (z. B. RAL, wenn im Projekt nie mit Fassadenfarben gearbeitet wird).
 */
export interface BuiltinPaletteBanks {
  simple?: boolean;
  tango?: boolean;
  material?: boolean;
  ral?: boolean;
}

/** Schlüssel einer mitgelieferten Palette-Bank (s. {@link BuiltinPaletteBanks}). */
export type BuiltinPaletteBank = keyof BuiltinPaletteBanks;

export interface LineStyle {
  id: string;
  name: string;
  /**
   * @deprecated Die Strichstärke gehört NICHT mehr in den Linienstil — es gibt nur
   * „Vollinie/Strich", die tatsächliche Dicke wird per Element-Attribut (bzw.
   * Ebene/Default) aufgelöst. Das Feld bleibt für die Backward-Compat-Auflösung
   * erhalten und dient den Renderern noch als Fallback für die Muster-/Fugen-Stärke
   * (siehe `resolveHatch` → `HatchRender.lineWeight`). Der Linien-Detail-Editor
   * zeigt es nicht mehr an; neue Linienstile bekommen einen Haarlinien-Default.
   * Die echte per-Element-Strichstärken-Auflösung (Attribut → Ebene → Default)
   * folgt separat mit dem By-Layer/By-Object-Refactor — NICHT hier.
   */
  weight: number;
  /** Farbe (hex). */
  color: string;
  /**
   * Strichmuster in Millimetern, alternierend AN/AUS (`[on, off, on, off, …]`),
   * loopend; `null` = durchgezogen (Volllinie). Konvention des modularen
   * Segment-Systems (siehe `src/ui/lineSegments.ts`): ein AN-Wert von 0 bedeutet
   * einen PUNKT (Dot) — er wird nur mit runder Strichkappe sichtbar (die
   * betroffene Linie erhält dann `stroke-linecap: round`). So bilden sich
   * Volllinie/Strichlinie/Punktlinie/Strich-Punkt und frei modulare Folgen aus
   * Strich/Punkt/Lücke ab. Additiv — kein zusätzliches Feld nötig.
   */
  dash: number[] | null;
  /**
   * Linien-Typ (additiv, Default `undefined` ⇒ "dash"):
   *   • "dash"   — gerade Linie mit `dash`-Strichmuster (bestehendes Verhalten).
   *   • "zigzag" — der Strich variiert in Y (Zickzack/Welle), Parameter in
   *     `zigzag`. Fehlt `kind`, gilt „dash"; die heutigen Renderer ignorieren
   *     `kind` und zeichnen weiterhin gerade Striche (Backward-Compat).
   *   • "custom" — ein frei gezeichnetes Motiv (offene Polylinie in einer
   *     Einheitszelle), das sich entlang der Linie wiederholt/loopt. Parameter in
   *     `motif`. „zigzag" bleibt der eigene, parametrische Sonderfall.
   */
  kind?: "dash" | "zigzag" | "custom";
  /**
   * Parameter der Zickzack-/Wellen-Linie (nur `kind==="zigzag"`), beide in mm
   * Papier: `amplitude` = Ausschlag quer zur Linie, `wavelength` = Periodenlänge
   * entlang der Linie. Fehlt es, wird die Linie gerade gezeichnet.
   */
  zigzag?: { amplitude: number; wavelength: number };
  /**
   * Frei gezeichnetes Wiederhol-Motiv (nur `kind==="custom"`): eine OFFENE
   * Polylinie in einer Einheitszelle. `points` sind die Stützpunkte in mm Papier;
   * `x` läuft 0..`length` (mm entlang der Linie = Wiederhollänge), `y` = senkrechter
   * Versatz zur Linienachse (mm, +/−). Das Motiv wird alle `length` entlang der
   * Linie gekachelt. Fehlt es, wird die Linie gerade gezeichnet.
   */
  motif?: { points: Vec2[]; length: number };
}

/** Mögliche Schraffur-Muster im Plan/Schnitt. */
export type HatchPattern =
  | "none"
  | "solid"
  | "insulation"
  | "diagonal"
  | "crosshatch"
  /**
   * Frei gezeichnetes Wiederhol-Motiv (Parameter in {@link HatchStyle.motif},
   * gleiche Form wie `LineStyle.motif` — der Editor `MotifEditor.tsx` ist
   * bereits generisch für beide gebaut). Ohne gesetztes `motif` degradiert die
   * Fläche zu geraden Parallel-Musterlinien (wie „diagonal").
   */
  | "custom";

/** Eine wiederverwendbare Schraffur (Hatch Manager). */
export interface HatchStyle {
  id: string;
  name: string;
  /**
   * Schraffur-Typ (additiv, Default `undefined` ⇒ "vector"):
   *   • "vector"   — Musterlinien (die bestehenden `pattern`/`scale`/`angle`/
   *     `relativeToWall`/`lineStyleId` sind die Vektor-Parameter). Untermodus
   *     über `lines` (parallel vs. random).
   *   • "image"    — ein Bild wird als Muster (Pattern-Fill) geladen; Parameter in
   *     `image` (Skalierung/Verzerrung/Rotation).
   *   • "gradient" — ein zweifarbiger Farbverlauf (linear/radial) füllt die
   *     Fläche; Parameter in `gradient`. Wie „image" unabhängig vom `pattern`-
   *     Feld. GL-/3D-Szene und DXF-Export kennen keine echten Verläufe (wie
   *     bei „image" bereits der Fall) und fallen auf eine neutrale Füllung
   *     zurück — nur die SVG-basierten Renderer (PlanView-Anzeige, Druck-/PDF-
   *     Export) zeichnen den echten Verlauf, da SVG-`<linearGradient>`/
   *     `<radialGradient>` sich genau wie ein `<pattern>` als `fill="url(#…)"`
   *     referenzieren lassen — keine neue Fill-Mechanik nötig.
   * Fehlt `kind`, gilt „vector"; heutige Renderer ignorieren unbekannte `kind`-
   * Werte und zeichnen weiterhin nach `pattern` (Backward-Compat).
   */
  kind?: "vector" | "image" | "gradient";
  /**
   * Untermodus einer Vektor-Schraffur (nur `kind` fehlt/"vector", Default
   * `undefined` ⇒ "parallel"):
   *   • "parallel" — regelmäßige Teilung (bestehendes Verhalten).
   *   • "random"   — zufällig verteilte Striche (z. B. Kies/Splitt).
   */
  lines?: "parallel" | "random";
  /**
   * Bild-Muster (nur `kind==="image"`). `src` = Data-URL oder Asset-Referenz;
   * `scaleX`/`scaleY` = unabhängige Verzerrung in Breite/Höhe (L×B), `rotation`
   * = Drehung in Grad. Bei `kind==="vector"` ungenutzt.
   */
  image?: { src: string; scaleX: number; scaleY: number; rotation: number };
  /**
   * Farbverlauf (nur `kind==="gradient"`). `type`: "linear" (entlang `angle`,
   * SVG-Konvention wie `HatchStyle.angle`) oder "radial" (vom Flächenzentrum
   * nach aussen, `angle` dann ungenutzt). `angle` in Grad. Kein Gewicht/keine
   * Zwischenfarben (Zweifarben-Verlauf, kein Multi-Stop-Editor) — deckt den
   * Hauptfall ab, s. PENDENZEN.md für die bewusste Vereinfachung.
   */
  gradient?: { color1: string; color2: string; angle: number; type: "linear" | "radial" };
  /** Muster-Typ. */
  pattern: HatchPattern;
  /** Grundmaßstab des Musters (1 = Standardteilung). */
  scale: number;
  /** Drehung des Musters in Grad. */
  angle: number;
  /**
   * Wenn `true`, ist `angle` NICHT bildschirmfest, sondern relativ zur Achse der
   * schraffierten Wand: das Muster dreht mit der Wandorientierung mit (z. B. eine
   * Diagonale, die stets 45° zur Wand steht, oder Dämmungsstriche quer durch die
   * Wanddicke). Nur die Wand-Poché wertet dies aus; ohne Wandkontext (z. B. Decke)
   * degradiert es zu einem absoluten `angle`.
   */
  relativeToWall?: boolean;
  /**
   * @deprecated Schraffuren tragen im Zielmodell KEINE eigene Farbe mehr — die
   * Muster-/Vordergrundfarbe kommt vom Bauteil (`Component.foreground`) bzw. der
   * Attribut-Überschreibung. Feld bleibt für die Backward-Compat-Auflösung als
   * LETZTER Fallback erhalten (siehe Farb-Resolve-Reihenfolge in
   * `plan/generatePlan.ts` → `resolveHatch`). Bei `pattern==="solid"` ist es die
   * Vollfüllfarbe, bei `pattern==="none"` ungenutzt.
   */
  color: string;
  /** Optionaler Linienstil für die Musterlinien (Line Manager). */
  lineStyleId?: string;
  /**
   * Steuer-Parameter der Random-Vektor-Schraffur (`kind`/"vector" + `lines`===
   * "random", z. B. Kies/Splitt). ALLE additiv & optional — fehlen sie, gilt das
   * bestehende deterministische Streu-Verhalten (Seed aus der Flächen-Bounding-Box,
   * Dichte/Länge aus `scale`). Die Streuung bleibt bei gleichem `seed` + gleicher
   * Fläche reproduzierbar über ALLE Renderpfade (single render truth); KEIN
   * `Math.random()` zur Renderzeit.
   */
  /** Expliziter Streu-Seed. Wird in den Flächen-Seed eingemischt; „Neu würfeln" setzt einen neuen Wert. */
  seed?: number;
  /** Streudichte als Multiplikator auf den Grundabstand (Default 1; >1 = dichter). */
  density?: number;
  /** Minimale Strichlänge in mm (Papier). Fehlt es, greift die `scale`-abhängige Default-Länge. */
  lengthMin?: number;
  /** Maximale Strichlänge in mm (Papier). Fehlt es, greift die `scale`-abhängige Default-Länge. */
  lengthMax?: number;
  /**
   * Frei gezeichnetes Wiederhol-Motiv (nur `pattern==="custom"`) — gleiche Form
   * wie `LineStyle.motif`: eine offene Polylinie in Papier-mm, `x` läuft
   * 0..`length` (Wiederhollänge ENTLANG der Musterlinie), `y` = Versatz quer zur
   * Musterlinie. Wird alle `length` Papier-mm entlang jeder Musterlinie
   * gekachelt UND (wie bei diagonal/crosshatch) im Abstand von `scale`-
   * abhängigen 8 px quer versetzt wiederholt. Fehlt es, zeichnet „custom" wie
   * „diagonal" (gerade Linien) — kein Absturz bei frisch angelegten Hatches.
   */
  motif?: { points: Vec2[]; length: number };
}

/**
 * PBR-Material-Karten eines Bauteils (3D-Texturierung). Jede URL verweist auf
 * ein Bild — entweder ein eingebautes Bibliotheks-Asset unter
 * `/assets/materials/...` ODER eine per Nutzer-Upload erzeugte Object-/Data-URL.
 * Fehlende Karten werden weggelassen (z. B. nur `color` bei einem Upload).
 * `sizeM` ist die physische Kantenlänge EINER Texturkachel in Metern (für die
 * korrekte Skalierung der Wiederholung), Default 1.0 m.
 */
export interface ComponentMaterial {
  /** Optionaler Verweis auf ein Bibliotheks-Asset (`MaterialAsset.id`). */
  libraryId?: string;
  /** Albedo-/Farb-Karte (map). */
  color?: string;
  /** Normal-Karte (normalMap) — erzeugt die Oberflächentiefe. */
  normal?: string;
  /** Rauheits-Karte (roughnessMap). */
  roughness?: string;
  /** Metallizitäts-Karte (metalnessMap). */
  metalness?: string;
  /** Höhen-/Displacement-Karte (displacementMap, dezent angewandt). */
  displacement?: string;
  /** Ambient-Occlusion-Karte (aoMap). */
  ao?: string;
  /** Physische Kachelgröße in Metern (Default 1.0). */
  sizeM?: number;
}

/**
 * Ein Bauteil-Material (Component Manager) — vereint Plan-Schnittdarstellung
 * (Schraffur) und 3D-Erscheinung. Ersetzt das frühere `Material`.
 */
export interface Component {
  id: string;
  name: string;
  /**
   * Füllfarbe im Grundriss (Poché) und 3D-Diffusfarbe. Bleibt bestehen; im
   * Zielmodell (Vordergrund/Hintergrund, s. u.) dient sie als Fallback für
   * `background`. Migrationsabsicht: neue Projekte setzen `foreground`/
   * `background`, Alt-Projekte fallen weiterhin auf `color` zurück.
   */
  color: string;
  /**
   * Vordergrundfarbe = Farbe der Muster-/Schraffurlinien (die Schraffur selbst
   * trägt keine Farbe mehr). Optional; fehlt sie, greift die Resolve-Kette
   * (Attribut-Override ?? Component.foreground ?? HatchStyle.color-Fallback).
   */
  foreground?: string;
  /**
   * Hintergrundfarbe = Füllung (Poché). Optional; fehlt sie, gilt als Fallback
   * `color`. Migrationsabsicht: `background` ⇐ `color`.
   */
  background?: string;
  /**
   * Stift-Kopplung (ArchiCAD-Stiftsatz-Muster, s. {@link ColorPen}/{@link
   * PenSet}): ist eines dieser Felder gesetzt, wird `color`/`foreground`/
   * `background` NICHT frei editiert, sondern bei jedem Stiftsatz-Wechsel
   * bzw. jeder Stift-Farbänderung automatisch aus dem aktiven Stiftsatz NEU
   * GESCHRIEBEN (`rebakePenColors`, `model/penSets.ts`) — die drei Felder
   * bleiben dadurch für ALLE bestehenden Leser (2D-Plan, beide 3D-Renderer,
   * Export) unverändert die eine gültige, aufgelöste Farbe; nur die Herkunft
   * ist jetzt ein Stift statt eine freie Wahl. Ein gesetzter `xxxPenId` gilt
   * genauso als „eigen" (explizit) wie eine frei gewählte Farbe — beides sind
   * Werte AM Bauteil, kein Verweis auf eine Ebene (anders als `foregroundSource`
   * an Wand/Decke/etc.).
   */
  colorPenId?: string;
  foregroundPenId?: string;
  backgroundPenId?: string;
  /** Schnitt-Schraffur → Hatch Manager. Gilt, wo das Bauteil echt geschnitten ist. */
  hatchId: string;
  /**
   * Ansichts-Schraffur → Hatch Manager. Gilt, wo das Bauteil frontal/ungeschnitten
   * gesehen wird (z. B. Deckenpoché im Grundriss: die Decke liegt über der
   * horizontalen Schnittebene und wird von unten gesehen, nicht aufgeschnitten).
   * Leer/`undefined` ⇒ keine Schraffur (weiss).
   */
  viewHatchId?: string;
  /** Optionale 3D-Textur (vorerst ignoriert). */
  texture3d?: string;
  /**
   * Optionales echtes PBR-Material für die 3D-Texturierung (Bibliothek ODER
   * Upload). Fehlt es, bleibt das heutige Verhalten (matte Farbe). Wirkt nur im
   * Render-Modus „textured".
   */
  material?: ComponentMaterial;
  /**
   * Optionales Kürzel für Wandtyp-Labels (z. B. „BET", „HLZ", „GKB", „DAE").
   * Wird von `wallTypeLabel()` genutzt, um Wandtyp-Dropdowns kompakt darzustellen
   * (z. B. „BET 24" statt dem vollen Namen). Fehlt es, greift der Name.
   */
  abbrev?: string;
  /** Verschneidungs-Rang: höher läuft am Stoß durch (Backbone). */
  joinPriority: number;
}

/** Eine Schicht eines mehrschichtigen Bauteils. */
export interface Layer {
  /** Verweis auf das Bauteil-Material (Component Manager). */
  componentId: string;
  /** Schichtdicke in Metern. */
  thickness: number;
  /**
   * Linienstil (LineStyle) der Schichtfuge an der INNEREN Kante DIESER Schicht —
   * also der Fuge zwischen dieser und der nächst-inneren Schicht. Bei der
   * innersten Schicht ungenutzt (ihre innere Kante ist der Wand-Innenumriss).
   * Fehlt das Feld, wird die Standard-Haarlinie (0.02 mm) gezeichnet.
   */
  jointLineStyleId?: string;
}

/** Ein Wandtyp = geordneter Schichtaufbau (außen → innen). */
export interface WallType {
  id: string;
  name: string;
  layers: Layer[];
}

/**
 * Ein Deckentyp (Deckenstil) = geordneter Schichtaufbau EINER Decke, liegend
 * gestapelt (oben → unten) — das horizontale Gegenstück zum `WallType`. Nutzt
 * denselben `Layer`-Typ (Bauteil + Dicke + optionaler Schichtfugen-Linienstil),
 * damit Fuge/Schraffur-Auflösung identisch zur Wand bleiben. Eine „einschichtige"
 * Decke (SOLID) ist einfach ein Deckentyp mit genau einer Schicht.
 */
export interface CeilingType {
  id: string;
  name: string;
  layers: Layer[];
}

/**
 * Ein Dachtyp (Dachaufbau) = geordneter Schichtaufbau EINES Daches, senkrecht
 * zur Dachfläche gestapelt (aussen/Eindeckung → innen/Verkleidung) — das
 * geneigte Gegenstück zu `WallType`/`CeilingType`. Nutzt denselben `Layer`-Typ.
 * Typische Folge: Eindeckung (Ziegel/Blech) → Konterlattung/Lattung → Unterdach
 * → Sparren/Dämmung → Dampfbremse → Innenverkleidung. Ein Dach ohne `roofTypeId`
 * fällt auf die einschichtige `Roof.thickness` zurück (rückwärtskompatibel).
 */
export interface RoofType {
  id: string;
  name: string;
  /** Aussen (Eindeckung) → innen (Verkleidung), analog `WallType.layers`. */
  layers: Layer[];
}

/**
 * Wiederverwendbares 2D-Symbol (Möbelblock, Sanitär-/Normsymbol, Nordpfeil
 * u. Ä.) — s. `Project.blockDefs` + `Drawing2DGeom["block"]`. `geom2d` ist
 * LOKALE Geometrie (Ursprung = Einfügepunkt der Instanz, Winkel 0 = wie
 * definiert); jede Instanz transformiert sie beim Rendern per `at`/`rotation`.
 * Bewusst KEIN verschachtelter `"block"`-Shape in `geom2d` (keine Blöcke in
 * Blöcken, v1) — nicht technisch erzwungen, nur Konvention der Autoren-Seite
 * (`commands/cmds/defblock.ts`).
 */
export interface BlockDef {
  id: string;
  name: string;
  geom2d: Drawing2DGeom[];
}

// ── Bauteil-Typen: Tür / Fenster / Treppe ──────────────────────────────────
// Wiederverwendbare Stile (Presets) für Türen, Fenster und Treppen — analog
// `WallType`/`CeilingType` (Bibliothek im Projekt, referenziert per `typeId`).
// Getrennte Typen (kein gemeinsames „OpeningType"), damit türspezifische und
// fensterspezifische Parameter sauber je Gattung wohnen. Ein Element ohne
// `typeId` behält sein heutiges Inline-Verhalten (rückwärtskompatibel).

// Detailstufe der Bauteil-Darstellung (Grundriss + 3D) nutzt das bestehende
// {@link DetailLevel}-Vokabular ("grob" | "mittel" | "fein", aus ui/TopBar) —
// bewusst KEIN zweites Detail-Enum, damit Ansicht und Bauteil dieselbe Skala
// teilen. Ausgewertet an der Symbol-/Mesh-Erzeugung (Phase 2).

/**
 * Ein Türtyp (Türstil) — wiederverwendbares Preset für {@link Opening} mit
 * `kind: "door"`. Bündelt Bauart, Blattausführung und Standardmaße. Werte am
 * einzelnen Element (Breite/Höhe/Anschlag) übersteuern die Typ-Defaults.
 */
/** Eckverbindung von Rahmenprofilen (s. `WindowType.frameCornerJoin`). */
export type FrameCornerJoin = "vertikal" | "horizontal" | "gehrung";

export interface DoorType {
  id: string;
  name: string;
  /**
   * Bauart: normaler Drehflügel, reine Wandöffnung (kein Blatt/Schwenk),
   * Schiebetür. Ersetzt/ergänzt das Inline-Feld `Opening.doorType`.
   */
  kind: "dreh" | "schiebe" | "wandoeffnung";
  /** Anzahl Türblätter (1 = einflügelig, 2 = zweiflügelig). */
  leafCount: 1 | 2;
  /** Blatt-Ausführung (3D/Detail): glatt, Kassette, Glasfüllung. */
  leafStyle: "glatt" | "kassette" | "glas";
  /** Glasanteil des Blatts (0..1); nur bei `leafStyle: "glas"` relevant. */
  glazingRatio?: number;
  /** Anzahl Kassetten-Felder horizontal; nur bei `leafStyle: "kassette"` relevant. Default 2. */
  panelCols?: number;
  /** Anzahl Kassetten-Felder vertikal; nur bei `leafStyle: "kassette"` relevant. Default 3. */
  panelRows?: number;
  /** Zargen-/Rahmenstärke quer zur Wand (Meter). */
  frameThickness: number;
  /** Rahmen-/Zargen-Tiefe in Wandrichtung (Meter); fehlt ⇒ aus Wanddicke. */
  frameDepth?: number;
  /**
   * Rahmenart:
   *  • "zarge"       — Zarge, umschliesst die Laibung (schmales Profil, in der
   *    Wandlaibung sitzend — der Standard im Innenausbau).
   *  • "blockrahmen" — Blockrahmen, sitzt als kräftiges Rechteckprofil VOR/auf
   *    der Laibung (typisch bei Aussentüren/älterem Bestand).
   * Fehlt es, gilt "zarge".
   */
  frameKind?: "zarge" | "blockrahmen";
  /**
   * Ansichtsbreite des Rahmenprofils (Meter) — die sichtbare Rahmen-Randbreite
   * in der Öffnungsebene (Elevation), NICHT die Tiefe quer zur Wand. Fehlt es,
   * gilt ein schmaler Default (~0.06 m). Steuert 2D-Rahmenkontur + 3D-Rahmen.
   */
  frameWidth?: number;
  /**
   * Eckverbindung der Rahmen (Blend- und Flügelrahmen) in der Ansicht:
   * "vertikal" (Pfosten laufen durch, Riegel dazwischen — Default),
   * "horizontal" (Riegel laufen durch) oder "gehrung" (45°-Stoss). Wirkt im
   * 3D; vorher überlappten die Flügelrahmen-Profile an den Ecken (doppelte
   * Kanten bei „Schattiert mit Kanten").
   */
  frameCornerJoin?: FrameCornerJoin;
  /**
   * Schichteinzug: Abstand der Rahmen-Vorderkante von einer Wandfläche (Meter).
   * 0/fehlt ⇒ bündig. > 0 ⇒ der Rahmen sitzt um diesen Betrag in die Wand
   * zurückgesetzt (z. B. hinter die Aussenschale eines mehrschichtigen Aufbaus).
   * Gemessen von der über {@link insetFace} gewählten Fläche.
   */
  insetFromFace?: number;
  /** Von welcher Wandfläche der {@link insetFromFace} gemessen wird; Default "aussen". */
  insetFace?: "aussen" | "innen";
  /**
   * Oberlicht: Höhe eines festen, verglasten Oberlichts über dem Türblatt
   * (Meter). 0/fehlt ⇒ kein Oberlicht. Das Oberlicht sitzt oberhalb eines
   * Kämpfers innerhalb derselben lichten Öffnungshöhe.
   */
  transomHeight?: number;
  /** Default-Lichtbreite (Meter) für neu platzierte Türen dieses Typs. */
  defaultWidth: number;
  /** Default-Lichthöhe (Meter). */
  defaultHeight: number;
  /** Bodenschwelle/Anschlag zeichnen (3D/Detail). */
  threshold?: boolean;
}

/**
 * Ein Fenstertyp (Fensterstil) — wiederverwendbares Preset für {@link Opening}
 * mit `kind: "window"`. Bündelt Öffnungsart, Flügelzahl, Verglasung und
 * Standardmaße inkl. Brüstungshöhe.
 */
/** Öffnungsart eines einzelnen Flügels (bzw. des ganzen Fensters, alt). */
export type OpeningKind = "dreh" | "kipp" | "drehkipp" | "fest" | "schiebe";

/**
 * Ein Eintrag der Flügeleinteilung eines Fensters (VW „Flügeltabelle"): entweder
 * ein Flügel (verglaste, ggf. öffenbare Einheit) oder ein Pfosten (feste vertikale
 * Teilung). Ersetzt/erweitert das grobe {@link WindowType.wingCount}: ist
 * {@link WindowType.sashes} gesetzt, hat es Vorrang; sonst wird die Einteilung aus
 * `wingCount` gleichmäßig abgeleitet (siehe `sashesOfWindowType`).
 */
export interface SashDef {
  kind: "fluegel" | "pfosten";
  /** Gleichmässig mitaufteilen (Default true); bei false gilt {@link width}. */
  autoWidth?: boolean;
  /** Feste Flügelbreite (Meter), nur wenn `autoWidth === false`. */
  width?: number;
  /** Pfostenbreite (Meter); nur `kind === "pfosten"`. */
  postWidth?: number;
  /** Öffnungsart DIESES Flügels (nur `kind === "fluegel"`). */
  opening?: OpeningKind;
  /** Anschlag/Bandseite (nur öffenbare Flügel). */
  hingeSide?: "left" | "right";
}

/** Rollladen-/Sonnenschutzkasten über der Öffnung (P0-Minimalfassung). */
export interface WindowShading {
  create: boolean;
  kind: "rollladen" | "raffstore" | "markise";
  /** Kastenmasse (Meter): Breite (quer, meist = Öffnung), Höhe, Tiefe. */
  box: { width: number; height: number; depth: number };
}

export interface WindowType {
  id: string;
  name: string;
  /** Öffnungsart: Dreh, Kipp, Dreh-Kipp, fest verglast, Schiebe. */
  kind: OpeningKind;
  /** Anzahl Flügel (1–4) → Mittelpfosten = wingCount − 1 (vgl. `Opening.wingCount`). */
  wingCount: number;
  /**
   * Flügeleinteilung (VW „Flügeltabelle"): einzelne Flügel/Pfosten mit Breite und
   * Öffnungsrichtung. Hat Vorrang vor {@link wingCount}; fehlt es, wird die
   * Einteilung gleichmässig aus `wingCount` abgeleitet (`sashesOfWindowType`).
   */
  sashes?: SashDef[];
  /** Rollladen-/Sonnenschutzkasten über der Öffnung. */
  shading?: WindowShading;
  /**
   * Verglasungs-Scheibenzahl, RENDER-wirksam (1/2/3). Fehlt es, wird sie aus
   * {@link glazing} abgeleitet. Steuert die 3D-Scheibenzahl und die 2D-Glaslinien.
   */
  glazingPanes?: 1 | 2 | 3;
  /**
   * Anzahl horizontaler Felder (Kämpfer-Zeilen): 1 = keine Querteilung, 2 = ein
   * Kämpfer, usw. Zusammen mit {@link wingCount} (Spalten) ergibt sich das
   * Sprossen-/Flügelraster. Fehlt es, gilt 1.
   */
  mullionRows?: number;
  /**
   * Anzahl vertikaler Felder (Sprossen-Spalten): 1 = keine Querteilung, 2 = ein
   * Sprossen-Mittelpunkt (Spalte), usw. Zusammen mit {@link wingCount} (Spalten)
   * ergibt sich das Sprossen-/Flügelraster. Fehlt es, gilt 1.
   */
  mullionCols?: number;
  /** Verglasung: Einfach/Zweifach/Dreifach (3D-Scheibenzahl). */
  glazing: "einfach" | "zweifach" | "dreifach";
  /** Rahmenstärke quer zur Wand (Meter). */
  frameThickness: number;
  /** Rahmen-Tiefe in Wandrichtung (Meter); fehlt ⇒ aus Wanddicke. */
  frameDepth?: number;
  /**
   * Ansichtsbreite des Rahmen-/Flügelprofils (Meter) — sichtbare Randbreite in
   * der Öffnungsebene. Fehlt es, gilt ein schmaler Default (~0.06 m). Steuert die
   * 2D-Rahmen-/Sprossenkontur und den 3D-Rahmen.
   */
  frameWidth?: number;
  /**
   * Eckverbindung der Rahmen (Blend- und Flügelrahmen) in der Ansicht:
   * "vertikal" (Pfosten laufen durch, Riegel dazwischen — Default),
   * "horizontal" (Riegel laufen durch) oder "gehrung" (45°-Stoss). Wirkt im
   * 3D; vorher überlappten die Flügelrahmen-Profile an den Ecken (doppelte
   * Kanten bei „Schattiert mit Kanten").
   */
  frameCornerJoin?: FrameCornerJoin;
  /**
   * Schichteinzug: Abstand der Rahmen-Vorderkante von einer Wandfläche (Meter).
   * 0/fehlt ⇒ bündig; > 0 ⇒ der Rahmen sitzt zurückgesetzt (klassisch hinter der
   * Aussenschale eines mehrschichtigen Wandaufbaus). Von {@link insetFace} gemessen.
   */
  insetFromFace?: number;
  /** Von welcher Wandfläche der {@link insetFromFace} gemessen wird; Default "aussen". */
  insetFace?: "aussen" | "innen";
  /**
   * Schicht-Rücksprung an der Laibung: weicht die INNERSTE Wandschicht (meist
   * Gipsplatte/Holzverkleidung) an diesem Fenster um ihre eigene Dicke von der
   * Öffnung zurück, statt bündig mit den übrigen Schichten abzuschliessen —
   * anders als {@link insetFromFace} (der Rahmen-Position), ändert dies die
   * WAND-GEOMETRIE selbst an der Laibung. Default false (bündig, Alt-Verhalten).
   */
  innerLayerRecess?: boolean;
  /**
   * Oberlicht: Höhe eines festen, verglasten Oberlichts über dem Hauptflügel
   * (Meter), abgeteilt durch einen Kämpfer. 0/fehlt ⇒ kein Oberlicht.
   */
  transomHeight?: number;
  /**
   * Auf-/Untersicht-Andeutung im Grundriss (mittel/fein): eine Referenzlinie an
   * der gewählten Fläche(n) — sinnvoll, wenn die Öffnung die Schnittebene NICHT
   * regulär durchschneidet (z. B. bodentiefes Fenster oder hoch sitzendes
   * Oberlicht). `faces` wählt aussen/innen/beide, `view` die Blickrichtung:
   * "auf" (Aufsicht von oben, dünn) oder "unter" (Untersicht von unten,
   * gestrichelt wie eine überkopf liegende Kante). Fehlt/undefined ⇒ keine Linie.
   */
  sillLine?: { faces: "aussen" | "innen" | "beide"; view: "auf" | "unter" };
  /** Default-Brüstungshöhe über Wand-UK (Meter). */
  defaultSillHeight: number;
  /** Default-Lichtbreite (Meter). */
  defaultWidth: number;
  /** Default-Lichthöhe (Meter). */
  defaultHeight: number;
  /** Fensterbank zeichnen (Detail): keine / innen / aussen / beide. */
  sillBoard?: "keine" | "innen" | "aussen" | "beide";
}

/**
 * Ein Treppentyp (Treppenstil) — wiederverwendbares Preset für {@link Stair}.
 * Bündelt Tragart, Stufenausbildung und Geländer. Geometrische Grundform
 * (gerade/L/Wendel) + Lauflänge/Stufenzahl bleiben am einzelnen Element.
 */
export interface StairType {
  id: string;
  name: string;
  /**
   * Tragart:
   *  • "massiv"       — Vollblock bis zur Treppen-UK (Treppe auf Erdreich/Sockel).
   *  • "beton"        — Ortbeton-Laufplatte mit SCHRÄGER, offener Untersicht
   *    (die klassische „normale Betontreppe" zwischen zwei Geschossen).
   *  • "wange"        — Wangentreppe (schwebende Tritte, offen).
   *  • "aufgesattelt" — aufgesattelte Tritte (mit Setzstufen, offen).
   *  • "spindel"      — Spindel-/Wendeltreppe (offen).
   */
  structure: "massiv" | "beton" | "wange" | "aufgesattelt" | "spindel";
  /** Setzstufen geschlossen (true) oder offen (false, durchsichtige Tritte). */
  closedRisers: boolean;
  /** Trittstufendicke (Meter). */
  treadThickness: number;
  /** Trittkanten-Überstand / Nase (Meter); fehlt ⇒ 0. */
  nosing?: number;
  /** Handlauf/Geländer: keine / links / rechts / beide (in Laufrichtung). */
  railing?: "keine" | "links" | "rechts" | "beide";
  /** Default-Laufbreite (Meter) für neu platzierte Treppen dieses Typs. */
  defaultWidth: number;
}

// ── Grafische Overrides (Regel-Engine) ─────────────────────────────────────
// ArchiCAD-/Vectorworks-Stil: benannte Regeln `condition → actions`, die beim
// RENDERN als oberste Schicht über die By-Layer/By-Object-Attribut-Auflösung
// gelegt werden (reines Rendering-Overlay — die Elementdaten bleiben
// unverändert, jederzeit reversibel). Regeln werden additiv angewendet: pro
// Aktions-Feld gewinnt die OBERSTE (erste) aktive Regel, die es setzt.
// Auswertung: `src/overrides/engine.ts`; Einhängepunkt: `plan/generatePlan.ts`.

/**
 * Bedingungs-Typ einer Override-Regel — wogegen der Wert verglichen wird:
 *   • "layer_name"  — Name ODER Code der Ebene (LayerCategory) des Elements.
 *   • "object_name" — Element-/Typ-Name (z. B. Wandtyp-Name, Raum-Name,
 *     Öffnungs-Label, Drawing2D-Formname).
 * Ein `user_string`-Tag (DOSSIER-Rhino) existiert am Element noch nicht und
 * ist deshalb bewusst NICHT enthalten (kein Schein-Feature).
 */
export type OverrideConditionType = "layer_name" | "object_name";

/** Vergleichs-Operator einer Override-Bedingung (case-insensitiv). */
export type OverrideOperator =
  | "equals"
  | "contains"
  | "starts_with"
  | "not_equals";

/** Bedingung einer Override-Regel. */
export interface OverrideCondition {
  type: OverrideConditionType;
  operator: OverrideOperator;
  /** Vergleichswert (Freitext, case-insensitiv verglichen). */
  value: string;
}

/**
 * Aktionen einer Override-Regel — jede optional (Teilaktionen sind erlaubt;
 * fehlende Felder lassen die reguläre Auflösung unberührt).
 */
export interface OverrideActions {
  /** Strich-/Umrandungsfarbe (hex). */
  color?: string;
  /** Strichstärke in mm Papier. */
  lineweight?: number;
  /** Linienstil (Line Manager) — wirkt, wo Elemente einen LineStyle tragen (Drawing2D). */
  linetypeId?: string;
}

/**
 * Eine grafische Override-Regel. Lebt in `Project.overrideRules` (Reihenfolge
 * = Priorität, oben gewinnt) und ist einzeln aktivier-/deaktivierbar.
 */
export interface OverrideRule {
  id: string;
  name: string;
  /** Deaktivierte Regeln werden bei der Auswertung übersprungen. */
  enabled: boolean;
  condition: OverrideCondition;
  actions: OverrideActions;
}

// ── Parametrische Wände (Parametric Walls) ────────────────────────────────
// Parametrische Wand-Regeln generieren automatisch Wall[]-Arrays — analog zu
// FreeCAD BIM. Sie leben in Project.resources.parametricWalls[] und werden
// durch `resolveParametricWall()` in `src/model/parametricWalls.ts` aufgelöst.
// Ausgabe: normale Wall[]-Objekte (kein neuer Elementtyp).

/**
 * Eine parametrische Wand-Regel — generiert automatisch Wall[]-Einträge für
 * ein gegebenes Geschoss. Lebt in der Ressourcen-Bibliothek des Projekts.
 * Wird über `resolveParametricWall()` aufgelöst, nicht zur Laufzeit gespeichert.
 */
export interface ParametricWall {
  id: string;
  /** Anzeigename, z. B. „Wohnbau-Raster 3m". */
  name: string;
  /** Optionale Beschreibung (für den Ressourcen-Manager). */
  description?: string;
  /**
   * Geordnete Liste der anzuwendenden Regeln. Spätere Regeln können die
   * Ausgabe früherer Regeln verfeinern (z. B. Dickenzuweisung nach Raster).
   */
  rules: ParametricRule[];
  /**
   * Rückfall-Wandtyp, falls eine Regel keinen eigenen `wallTypeId` nennt.
   * Muss auf einen gültigen WallType im Projekt verweisen.
   */
  defaultWallTypeId: string;
}

/**
 * Eine einzelne parametrische Regel — eine Strategie zur Wandplatzierung oder
 * -verfeinerung. Regeln werden als Discriminated Union kodiert; der `type`-Tag
 * bestimmt, welche Felder verfügbar sind.
 */
export type ParametricRule =
  | GridRule
  | ModuleRule
  | ConditionalThicknessRule
  | ReferenceLineRule
  | SequenceRule;

/**
 * Raster-Regel: generiert Wände entlang gleichmäßiger X-/Y-Achsen.
 * Typischer Anwendungsfall: Tragwerks-Achsraster (z. B. 3 m Abstand).
 *
 * Ablauf (Engine):
 *   1. Rasterachsen aus `spacing` oder (später) verlinkter Grid-Ressource.
 *   2. Je Achse eine Wand von Rand zu Rand (begrenzt durch `boundaryId`).
 *   3. Wandtyp, Referenzlinie und Höhe gemäß Regelfelder.
 */
export interface GridRule {
  type: "grid";
  /**
   * Optionaler Verweis auf eine Grid-Ressource (Phase 3). Für MVP wird
   * stattdessen `spacing` genutzt.
   */
  gridId?: string;
  /** Rasterabstand in Metern (Default: 3.0). Wird genutzt, wenn kein `gridId`. */
  spacing?: number;
  /**
   * Achsrichtungen: „x" = nur horizontale Wände, „y" = nur vertikale,
   * „both" = Vollraster.
   */
  directions: "x" | "y" | "both";
  /**
   * Optionaler Verweis auf eine Drawing2D-Grenze (als Clipping-Polygon).
   * Fehlt er, reicht das Raster über den sichtbaren Bereich des Geschosses.
   */
  boundaryId?: string;
  /** Optionale Wandtyp-Übersteuerung; sonst `defaultWallTypeId`. */
  wallTypeId?: string;
  /** Lage der Wandachse über die Dicke (Vectorworks-Stil). */
  referenceLine?: WallReferenceLine;
  /** Optionale Höhenübersteuerung in Metern; sonst Geschosshöhe. */
  height?: number;
}

/**
 * Modul-Regel: teilt eine Referenzspanne in proportionale Felder auf.
 * Typischer Anwendungsfall: Tragwerks-Joche (z. B. 6 m-Module in einem Bauteil).
 *
 * Ablauf (Engine):
 *   1. Gesamtspanne aus `referenceWallId` oder Geschossausdehnung ableiten.
 *   2. In Module der Größe `moduleSize` unterteilen.
 *   3. Querwände an jedem Modulteilungspunkt setzen.
 */
export interface ModuleRule {
  type: "module";
  /** Modulmaß in Metern (z. B. 6.0, 3.6). */
  moduleSize: number;
  /** Ausrichtung der Trennwände: „x" = quer zur X-Achse, „y" = quer zur Y-Achse. */
  direction: "x" | "y";
  /**
   * Optionaler Verweis auf eine Referenzwand, die die Spannweite definiert.
   * Fehlt er, wird die Geschoss-Ausdehnung genutzt (Phase 3: Achsen-Referenz).
   */
  referenceWallId?: string;
  /** Optionale Wandtyp-Übersteuerung; sonst `defaultWallTypeId`. */
  wallTypeId?: string;
  /** Lage der Wandachse über die Dicke. */
  referenceLine?: WallReferenceLine;
  /** Optionale Höhenübersteuerung in Metern. */
  height?: number;
}

/**
 * Bedingte-Dicken-Regel: weist bereits generierten Wänden einen anderen
 * Wandtyp zu, wenn eine Bedingung erfüllt ist.
 * Typischer Anwendungsfall: Außenwände erhalten einen anderen Aufbau als Innenwände.
 *
 * Ablauf (Engine):
 *   Bestehende Wände aus `existingWalls` filtern → `wallTypeId` ändern.
 *   Gibt modifizierte Kopien zurück (keine Mutation).
 */
export interface ConditionalThicknessRule {
  type: "conditional-thickness";
  /**
   * Bedingung für den Treffer:
   *   • „exterior"  — Wand liegt am Außenrand (ermittelt via Grenzpolygon).
   *   • „interior"  — Wand liegt im Inneren.
   *   • „bearing"   — tragende Wand (über Tag oder Wandtyp-Rang).
   *   • beliebiger String — benutzerdefiniertes Tag (Phase 3: Wall.tags[]).
   */
  condition: "exterior" | "interior" | "bearing" | string;
  /** Ziel-Wandtyp, der bei Treffer gesetzt wird. */
  wallTypeId: string;
  /**
   * Verknüpfungslogik für mehrere Bedingungen (Phase 3: mehrere `condition`-Felder).
   * Vorerst ungenutzt; Default ist implizites „or".
   */
  logic?: "and" | "or";
}

/**
 * Referenzlinien-Regel: setzt die `referenceLine`-Eigenschaft bei passenden
 * Wänden einheitlich (Vectorworks-Stil).
 * Typischer Anwendungsfall: Alle Außenwände auf „left" (linke Fläche = Fassade).
 *
 * Ablauf (Engine):
 *   Bestehende Wände aus `existingWalls` filtern → `referenceLine` setzen.
 *   Gibt modifizierte Kopien zurück.
 */
export interface ReferenceLineRule {
  type: "reference-line";
  /** Neue Lage der Wandachse, die einheitlich gesetzt wird. */
  referenceLine: WallReferenceLine;
  /**
   * Filterziel:
   *   • „all"      — alle Wände im aktuellen Satz.
   *   • „exterior" — nur Außenwände (wie bei ConditionalThicknessRule).
   *   • beliebiger String — benutzerdefiniertes Tag (Phase 3).
   */
  target: "all" | "exterior" | string;
}

/**
 * Sequenz-Regel: fasst mehrere Unterregeln zusammen und wendet sie geordnet an.
 * Jede Unterregel kann die Ausgabe der vorherigen verfeinern.
 * Typischer Anwendungsfall: Raster → bedingte Dicke → Referenzlinie als atomare Einheit.
 *
 * Ablauf (Engine):
 *   Regeln in `rules` werden sequenziell ausgeführt; das Ergebnis jeder Regel wird
 *   als `existingWalls` der nächsten übergeben. `stopOnMatch` bricht ab, sobald
 *   eine Unterregel mindestens eine Wand generiert hat.
 */
export interface SequenceRule {
  type: "sequence";
  /** Unterregeln, in Ausführungsreihenfolge. */
  rules: ParametricRule[];
  /**
   * Wenn `true`: Abbruch nach der ersten Unterregel, die mindestens eine Wand
   * generiert/verändert. Ähnlich wie ein Short-Circuit-Fallback.
   */
  stopOnMatch?: boolean;
}

/**
 * Art einer Zeichnungsebene.
 *   • "floor"     — Geschoss, trägt Bauteile.
 *   • "section"   — Schnitt (abgeleitete Projektion entlang einer Linie).
 *   • "elevation" — Ansicht (abgeleitete Projektion entlang einer Linie).
 *   • "drawing"   — freie 2D-Zeichnung, nicht an ein Geschoss gebunden.
 */
export type DrawingLevelKind = "floor" | "section" | "elevation" | "drawing";

/**
 * Eine Zeichnungsebene (DrawingLevel) — eine oberste Schnittebene des
 * Dokuments. Ein Geschoss trägt die Bauteile (über `floorId`); ein
 * Schnitt/Ansicht ist eine abgeleitete Projektion (vorerst Platzhalter); eine
 * reine Zeichnung ist eine freie 2D-Ebene ohne Geschossbezug.
 *
 * Geschoss nutzt floorHeight/cutHeight/baseElevation; Schnitt/Ansicht nutzen
 * linePoints/directionSign; "drawing" nutzt keines dieser Felder.
 */
/** Eine Zeile des Raumprogramms (Soll): wird gegen die gezeichneten Räume geprüft (`analysis/kennzahlen.ts`). */
export interface RoomProgramRow {
  /** Raumname wie im Modell (Vergleich ohne Gross-/Kleinschreibung, Präfix „Wohnen" trifft „Wohnen 2"). */
  name: string;
  /** SIA-416-Kategorie des Soll-Raums (optional, schärft die Zuordnung). */
  siaCategory?: SiaCategory;
  /** Soll-Fläche je Raum in m². */
  area: number;
  /** Soll-Anzahl (Default 1). */
  count?: number;
}

export interface DrawingLevel {
  id: string;
  name: string;
  kind: DrawingLevelKind;
  /** Sichtbarkeit der Zeichnungsebene im Navigator. */
  visible: boolean;
  /** Gesperrt (keine Bearbeitung). */
  locked: boolean;
  /** Lichte Geschosshöhe in Metern (nur Geschoss). */
  floorHeight?: number;
  /** Schnitthöhe über OKFF in Metern (nur Geschoss, für den Grundriss). */
  cutHeight?: number;
  /** Oberkante Fertigfußboden in Metern (nur Geschoss). */
  baseElevation?: number;
  /** Schnitt-/Ansichtslinie im Grundriss (nur Schnitt/Ansicht). */
  linePoints?: [Vec2, Vec2];
  /** Blickrichtung relativ zur Schnittlinie (nur Schnitt/Ansicht). */
  directionSign?: 1 | -1;
  /**
   * Schlagschatten in der Ansicht (nur kind "elevation"). Additiv; fehlt/`false`
   * ⇒ keine Schatten (heutiges Verhalten). Steuert `generateElevationPlan`
   * (toElevation.ts): auskragende Bauteile werfen einen 45°-Schlagschatten auf
   * die dahinterliegende Fassade.
   */
  shadows?: boolean;
  /**
   * Schnitt-Tiefe in Metern (nur Schnitt/Ansicht): Bauteile weiter als `depth`
   * HINTER der Schnittebene (in Blickrichtung) werden ausgeblendet. Fehlt der
   * Wert, ist die Tiefe unbegrenzt (das gesamte Modell wird projiziert — heutiges
   * Verhalten).
   */
  depth?: number;
  /**
   * Verdeckte Kanten im Schnitt zeichnen (gestrichelt). Default AUS — sie
   * legen sich sonst als blasses Liniengewirr über Poché und Ansichtskanten.
   */
  hiddenLines?: boolean;
  /**
   * Grundriss-Unterlage (nur Schnitt/Ansicht): ID eines Geschosses, dessen
   * Grundriss AUSGERICHTET unter dem Schnitt/der Ansicht gezeigt wird (Schnitt-
   * linie waagrecht, Blickrichtung nach oben, s. `plan/planUnderlay.ts`).
   * Fehlt ⇒ keine Unterlage.
   */
  planUnderlayId?: string;
  /**
   * Automatische Höhenkoten (nur Schnitt/Ansicht): je Geschoss OK fertig Boden
   * + oberste Kante, links neben der Zeichnung (`plan/levelMarkers.ts`).
   * Fehlt ⇒ an; `false` ⇒ aus.
   */
  levelMarks?: boolean;
}

/**
 * Eine Ebene (LayerCategory) — ein Knoten im Grafik-Kategorie-Baum. Das
 * Schema gilt geschossübergreifend; Elemente verweisen über `code` darauf.
 */
export interface LayerCategory {
  /** Eindeutiger Kategorie-Code, z. B. "20" für Wände. */
  code: string;
  name: string;
  /** Darstellungsfarbe (hex). */
  color: string;
  /**
   * Stift-Kopplung (s. `Component.colorPenId`): ist sie gesetzt, wird `color`
   * bei jedem Stiftsatz-Wechsel automatisch aus dem aktiven Stiftsatz neu
   * geschrieben. Zeichnet ein Objekt „nach Ebene", übernimmt es dadurch den
   * Stift dieser Ebene — bleibt aber selbst bei einer FREIEN Farbe, keinem
   * eigenen Stift-Verweis (nur `color` wandert mit).
   */
  colorPenId?: string;
  /** Linienstärke in Millimetern. */
  lw: number;
  visible: boolean;
  locked: boolean;
  /** Optionale Standard-Schraffur der Kategorie. */
  hatch?: string;
  /** Unterkategorien (Baum). */
  children?: LayerCategory[];
}

/**
 * Quelle eines vererbbaren Attributs (Vordergrund/Hintergrund/Strichstärke/
 * Schraffur), wenn KEIN expliziter Wert am Element gesetzt ist:
 *   • "layer"  — „Nach Ebene": die LayerCategory des Elements erzwingt den Wert
 *     (`color`/`lw`/`hatch`).
 *   • "object" — „Nach Bauteil": erbt vom Bauteil (Component) bzw. dessen
 *     bisheriger Fallback-Kette (bei Wand/Decke u. a. die neutrale SIA-Poché-
 *     Konvention, s. `resolveBackground`). Das ist auch der DEFAULT bei Wand/
 *     Decke, wenn das Source-Feld fehlt (`undefined`) — bewusst NICHT „Nach
 *     Ebene": eine frisch erzeugte Wand soll die neutrale Bauteil-Konvention
 *     zeigen (weisser Grund, schwarzer Vordergrund), nicht die rohe
 *     Ebenenfarbe.
 * Ein Drawing2D hat KEIN eigenes Bauteil — „Nach Bauteil" ist dort im
 * Attribut-Panel gar nicht erst wählbar, ein fehlendes Source-Feld wird dort
 * vom Aufrufer (`selectionInfo.ts`) auf „Nach Ebene" gemappt (die einzig
 * sinnvolle Alternative zum expliziten Wert bei einem bauteillosen Element).
 * Ein gesetzter expliziter Wert (z. B. `foreground`) gewinnt IMMER, unabhängig
 * von der Source (s. Resolve-Reihenfolge in `plan/generatePlan/shared.ts`).
 */
export type AttributeSource = "layer" | "object";

/**
 * Lage der Wandachse (Referenzlinie) über die Dicke der Wand — analog
 * Vectorworks. Gemessen relativ zur Laufrichtung (start→end) mit der
 * leftNormal-Konvention `n = (-u.y, u.x)`:
 *   • "center" — Achse mittig (Default = heutiges Verhalten).
 *   • "left"   — Achse liegt auf der linken Wandfläche (+n-Seite, „außen").
 *   • "right"  — Achse liegt auf der rechten Wandfläche (−n-Seite, „innen").
 */
export type WallReferenceLine = "left" | "center" | "right";

/**
 * Vertikale Bindung einer Wandkante (UK/OK).
 *   • "floor"  — an ein Geschoss gebunden: Z = baseElevation des Geschosses
 *     (+ optionalem `offset`). Stapelt automatisch mit dem Geschoss.
 *   • "custom" — fester absoluter Z-Wert (Meter).
 */
export type VerticalAnchor =
  | { mode: "floor"; floorId: string; offset?: number }
  | { mode: "custom"; z: number };

/** Eine Wand, definiert über ihre Achse (Centerline) und ihren Typ. */
export interface Wall {
  id: string;
  type: "wall";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "20" für Wände. */
  categoryCode: string;
  /** Objekt-Sperre: gesperrte Elemente lassen sich nicht anwählen (daher
   *  auch nicht verschieben/bearbeiten/löschen) — anders als der Ebenen-/
   *  Geschoss-Sperrmodus (`DisplayMode`) ist das hier persistiert. */
  locked?: boolean;
  /** Achs-Startpunkt im Grundriss (Meter). */
  start: Vec2;
  /** Achs-Endpunkt im Grundriss (Meter). */
  end: Vec2;
  /** Verweis auf den (mehrschichtigen) Wandtyp. */
  wallTypeId: string;
  /** Wandhöhe in Metern. */
  height: number;
  /**
   * Optionale Übersteuerung der Strich-/Umrandungsfarbe der Wand; sonst gilt
   * die Kategorie-Farbe. Übersteuert NUR die Linienfarbe (Umriss/Schichtfugen),
   * nicht die Schicht-Füllfarben/Schraffuren.
   */
  color?: string;
  /** Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku). */
  colorPenId?: string;
  /**
   * Attribut-Override der Muster-/Schraffurfarbe (Vordergrund) DIESER Wand-
   * Instanz. `undefined` = „Nach System" (erben → Component.foreground →
   * HatchStyle.color-Fallback). Höchste Priorität in der Farb-Resolve-Kette.
   */
  foreground?: string;
  /**
   * Attribut-Override der Füllfarbe (Hintergrund/Poché) DIESER Wand-Instanz.
   * `undefined` = „Nach System" (erben → Component.background → Component.color).
   */
  background?: string;
  /** Stift-Kopplung von `foreground` (s. `Component.foregroundPenId`-Doku). */
  foregroundPenId?: string;
  /** Stift-Kopplung von `background`, analog {@link Wall.foregroundPenId}. */
  backgroundPenId?: string;
  /**
   * Attribut-Override der Strichstärke (mm Papier) DIESER Wand-Instanz (Umriss/
   * Schichtfugen). `undefined` = „Nach System" (erben → `strokeWeightSource`).
   */
  strokeWeight?: number;
  /**
   * Attribut-Override der Schnitt-Schraffur (Hatch Manager) DIESER Wand-Instanz;
   * überschreibt die Schraffur ALLER Schichten einheitlich. `undefined` =
   * „Nach System" (erben → `hatchSource`).
   */
  hatchId?: string;
  /**
   * Quelle des Vordergrunds, wenn kein expliziter `foreground`-Wert gesetzt ist:
   * "layer" erzwingt die Ebenenfarbe (LayerCategory.color), "object"/`undefined`
   * (Default) erbt vom Bauteil (heutiges Verhalten).
   */
  foregroundSource?: AttributeSource;
  /** Quelle des Hintergrunds, analog zu {@link Wall.foregroundSource}. */
  backgroundSource?: AttributeSource;
  /**
   * Quelle der Strichstärke, wenn kein explizites `strokeWeight` gesetzt ist:
   * "layer" erzwingt `LayerCategory.lw`, "object"/`undefined` (Default) fällt auf
   * die bisherige Kategorie-/Fallback-Strichstärke zurück (heutiges Verhalten).
   */
  strokeWeightSource?: AttributeSource;
  /**
   * Quelle der Schraffur, wenn kein explizites `hatchId` gesetzt ist: "layer"
   * erzwingt `LayerCategory.hatch`, "object"/`undefined` (Default) erbt vom
   * Bauteil (heutiges Verhalten).
   */
  hatchSource?: AttributeSource;
  /**
   * Lage der Wandachse über die Dicke. Fehlt sie, gilt "center" (= heutiges
   * Verhalten: Schichten symmetrisch −T/2 … +T/2 um die Achse).
   */
  referenceLine?: WallReferenceLine;
  /**
   * Freier Referenz-Versatz der Achse entlang der +n-Normalen von der Wandmitte
   * (Meter). Ist er gesetzt, ÜBERSTEUERT er {@link referenceLine} — genutzt, um
   * bei mehrschichtigen Wänden eine SCHICHTTRENNLINIE (Fuge zwischen zwei
   * Schichten) als Referenzlinie zu wählen. +T/2 = Aussenfläche, 0 = Mitte,
   * −T/2 = Innenfläche; ein interner Fugenwert liegt dazwischen.
   */
  referenceOffset?: number;
  /**
   * Vertikale Bindung der Unterkante (UK). Fehlt sie, sitzt die UK auf der
   * baseElevation des zugehörigen Geschosses (= heutiges Verhalten).
   */
  bottom?: VerticalAnchor;
  /**
   * Vertikale Bindung der Oberkante (OK). Fehlt sie, ergibt sich die OK aus
   * UK + `height` (= heutiges Verhalten). „custom" setzt einen absoluten
   * Z-Wert; „floor" bindet die OK an ein (z. B. nächsthöheres) Geschoss.
   */
  top?: VerticalAnchor;
  /**
   * TERMINIERUNGS-Regel am horizontalen Deckenanschluss (Zuschnitt, NICHT
   * Priorität — bewusst getrennt von `Component.joinPriority`/der Schnitt-
   * Boolean-Dominanz gehalten). Steuert, ob ein Wandband, das eine dominante
   * Deckenschicht durchstösst, oberhalb der Decke „wieder auftaucht":
   *   • `undefined`/"both" — heutiges Verhalten: die dominante Deckenschicht
   *     stanzt nur ihr z-Band aus, das Wandband bleibt oben UND unten erhalten.
   *   • "below" — die Wand ENDET an der Decke: nur der Teil UNTER dem höchst-
   *     gelegenen dominanten Cut bleibt (Regelfall, Wand steigt von unten in die
   *     Decke). Der oberhalb der Decke stehende Rest wird verworfen.
   *   • "above" — spiegelbildlich: nur der Teil ÜBER dem tiefsten dominanten Cut
   *     bleibt (Brüstung/Attika, die von oben an die Decke stösst).
   * Additiv; Alt-Projekte laden unverändert (Default = "both").
   */
  sliceTermination?: SliceTermination;
}

/** Terminierungs-Regel einer Wand am Deckenanschluss (siehe {@link Wall.sliceTermination}). */
export type SliceTermination = "both" | "below" | "above";

/**
 * Eine Decke (Slab) — ein geschossgebundenes, mehrschichtiges Flächenbauteil,
 * definiert über einen GESCHLOSSENEN Umriss (Polygon) im Grundriss und eine
 * Dicke. Analog zur Wand trägt sie ihren Schichtaufbau über einen `wallTypeId`
 * (die Bauteil-/Schraffur-/Materialauflösung ist identisch); eine optionale
 * `thickness` übersteuert die Gesamtdicke des Typs (Meter).
 *
 * Vertikale Lage: die OBERKANTE (OK) der Decke. Fehlt `top`, liegt die OK an der
 * Oberkante des Geschosses (baseElevation + floorHeight — also bündig mit dem
 * Wandkopf); die Decke wächst um `thickness` nach UNTEN. `top: custom` setzt eine
 * absolute Z-Höhe, `top: floor` bindet die OK an ein Geschoss. Optional übersteuert
 * `bottom` die UNTERKANTE (UK) direkt (analog zur Wand); fehlt `bottom`, bleibt es
 * beim heutigen Verhalten UK = OK − `thickness`.
 */
export interface Ceiling {
  id: string;
  type: "ceiling";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "30" für Decken. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /**
   * Geschlossener Umriss im Grundriss (Meter). Der Schlusspunkt wird NICHT
   * dupliziert (die letzte Kante läuft von outline[n-1] zu outline[0]).
   */
  outline: Vec2[];
  /**
   * Aussparungen (Löcher) im Grundriss (Meter): je Loch ein geschlossener
   * Umriss (Schlusspunkt nicht dupliziert), VOLLSTÄNDIG innerhalb von
   * {@link outline} — Treppenauge, Schacht, Kamindurchbruch. Wirkt in 2D
   * (Poché-Loch + Randlinien) und 3D (Loch im Slab). Fehlt/leer ⇒ Volldecke.
   */
  openings?: Vec2[][];
  /**
   * LEGACY-Verweis auf einen Aufbau-Typ aus `wallTypes` (Rückwärtskompatibilität
   * für Projekte von vor den dedizierten Deckenstilen). Nur wirksam, wenn
   * `ceilingTypeId` fehlt.
   */
  wallTypeId: string;
  /**
   * Verweis auf einen dedizierten Deckentyp (Deckenstil) aus `ceilingTypes` —
   * der reguläre Weg für SOLID (1 Schicht) und MEHRSCHICHTIG (>1 Schicht). Hat
   * Vorrang vor `wallTypeId`, falls gesetzt und im Projekt auflösbar.
   */
  ceilingTypeId?: string;
  /** Optionale Übersteuerung der Gesamtdicke in Metern (sonst Typ-Dicke). */
  thickness?: number;
  /**
   * Optionale Übersteuerung der Strich-/Umrandungsfarbe; sonst gilt die
   * Kategorie-Farbe.
   */
  color?: string;
  /** Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku). */
  colorPenId?: string;
  /**
   * Attribut-Override der Muster-/Schraffurfarbe (Vordergrund) DIESER Decken-
   * Instanz. `undefined` = „Nach System" (erben → Component.foreground →
   * HatchStyle.color-Fallback).
   */
  foreground?: string;
  /**
   * Attribut-Override der Füllfarbe (Hintergrund/Poché) DIESER Decken-Instanz.
   * `undefined` = „Nach System" (erben → Component.background → Component.color).
   */
  background?: string;
  /** Stift-Kopplung von `foreground` (s. `Component.foregroundPenId`-Doku). */
  foregroundPenId?: string;
  /** Stift-Kopplung von `background`, analog {@link Wall.foregroundPenId}. */
  backgroundPenId?: string;
  /**
   * Attribut-Override der Strichstärke (mm Papier) DIESER Decken-Instanz.
   * `undefined` = „Nach System" (erben → `strokeWeightSource`).
   */
  strokeWeight?: number;
  /**
   * Attribut-Override der Schraffur (Hatch Manager) DIESER Decken-Instanz;
   * überschreibt sowohl die Schnitt- als auch die Ansichts-Schraffur des
   * Bauteils. `undefined` = „Nach System" (erben → `hatchSource`).
   */
  hatchId?: string;
  /** Quelle des Vordergrunds, analog zu {@link Wall.foregroundSource}. */
  foregroundSource?: AttributeSource;
  /** Quelle des Hintergrunds, analog zu {@link Wall.backgroundSource}. */
  backgroundSource?: AttributeSource;
  /** Quelle der Strichstärke, analog zu {@link Wall.strokeWeightSource}. */
  strokeWeightSource?: AttributeSource;
  /** Quelle der Schraffur, analog zu {@link Wall.hatchSource}. */
  hatchSource?: AttributeSource;
  /**
   * Vertikale Bindung der OBERKANTE (OK). Fehlt sie, sitzt die OK an der
   * Oberkante des Geschosses (baseElevation + floorHeight).
   */
  top?: VerticalAnchor;
  /**
   * Vertikale Bindung der UNTERKANTE (UK). Fehlt sie, ergibt sich die UK aus
   * OK − `thickness` (= heutiges Verhalten). „custom" setzt einen absoluten
   * Z-Wert; „floor" bindet die UK an ein Geschoss.
   */
  bottom?: VerticalAnchor;
}

// ── Dach ────────────────────────────────────────────────────────────────────

/**
 * Dachform (analog DOSSIER-Rhino):
 *  • "flach"    — Flachdach (waagrechte Fläche auf Traufhöhe).
 *  • "pult"     — Pultdach (eine geneigte Fläche, First an EINER Traufseite).
 *  • "sattel"   — Satteldach (First mittig, zwei Flächen, Giebel an den Enden).
 *  • "walm"     — Walmdach (allseitig geneigt, First verkürzt, vier Flächen).
 *  • "mansarde" — Mansarddach (Sattel mit Knick: steile untere + flache obere Neigung).
 *  • "zelt"     — Zeltdach (allseitig zur Spitze, First-Länge 0, Pyramide).
 */
export type RoofShape = "flach" | "pult" | "sattel" | "walm" | "mansarde" | "zelt";

/**
 * Ein Dach über einem (rechteckigen) Grundriss-Umriss. Die Geometrie rechnet auf
 * der Bounding-Box des Umrisses (die gängige, intuitive Vereinfachung — First
 * entlang einer Hauptachse); der Umriss selbst wird beim Zeichnen als Rechteck
 * angelegt. Die Traufhöhe (`baseElevation`) ist die Unterkante der Dachfläche;
 * darüber steigt das Dach je nach Form/Neigung auf.
 */
export interface Roof {
  id: string;
  type: "roof";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "35" für Dächer. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /** Geschlossener Grundriss-Umriss (Meter); Geometrie nutzt die Bounding-Box. */
  outline: Vec2[];
  /** Dachform. */
  shape: RoofShape;
  /** Hauptneigung in Grad (0 = flach). */
  pitchDeg: number;
  /** Nur Mansarde: obere (flachere) Neigung in Grad; fehlt ⇒ halbe Hauptneigung. */
  pitchUpperDeg?: number;
  /**
   * Nur Mansarde: Untertyp der Mansardform. "giebel" = Mansard-Satteldach
   * (steile untere + flache obere Neigung nur an zwei Seiten, Giebel an den
   * Enden — Default), "walm" = Mansard-Walmdach (allseitige Mansarde, auch die
   * Stirnseiten geknickt, kein Giebel), "zelt" = Mansard-Zeltdach (allseitig
   * zur Spitze, geknickt). Fehlt ⇒ "giebel".
   */
  mansardType?: "giebel" | "walm" | "zelt";
  /**
   * Nur Mansarde: Lage der Knicklinie als Anteil der halben Spannweite (0..0.5),
   * gemessen von der Traufe. Kleiner ⇒ steiler Sockel kürzer; fehlt ⇒ 0.4.
   */
  mansardKneeRatio?: number;
  /**
   * Nur Satteldach: Krüppelwalm. Anteil der Firsthöhe (0..0.9), der an BEIDEN Giebeln
   * abgewalmt wird — 0/fehlt = voller Giebel, 0.3 = oberes Drittel als kleine Walmflächen.
   */
  halfHipRatio?: number;
  /** Dachüberstand an der TRAUFE (Meter, senkrecht zum First); 0 = bündig. */
  overhang: number;
  /**
   * Dachüberstand am ORTGANG (Giebelseite, entlang des Firsts, Meter). Fehlt ⇒
   * gleich dem Traufüberstand {@link overhang} (rückwärtskompatibel = ringsum).
   */
  overhangGable?: number;
  /** Firstrichtung (Sattel/Walm/Mansarde/Pult): entlang der X- oder Y-Achse. */
  ridgeAxis: "x" | "y";
  /** Traufhöhe (absolutes Z, Meter); fehlt ⇒ Oberkante des Geschosses. */
  baseElevation?: number;
  /**
   * Dachdicke (Meter, senkrecht zur Fläche) — Fallback/Override. Ohne
   * {@link roofTypeId} ist es die einschichtige Gesamtdicke; mit `roofTypeId`
   * bleibt es als reiner Fallback bestehen (die Schichtsumme des Typs gilt).
   */
  thickness: number;
  /**
   * Verweis auf einen Dachtyp (Dachaufbau) aus `Project.roofTypes` — mehrschichtig
   * (Eindeckung/Lattung/Dämmung/Verkleidung), analog `Ceiling.ceilingTypeId`.
   * Fehlt er, gilt die einschichtige {@link thickness}.
   */
  roofTypeId?: string;
  /** Optionale Übersteuerung der Strich-/Umrissfarbe; sonst Kategorie-Farbe. */
  color?: string;
  /** Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku). */
  colorPenId?: string;
}

/** Schwenkrichtung der Tür relativ zur Wandachse. */
export type SwingSide = "left" | "right";

/**
 * Eine Öffnung (Fenster oder Tür), gehostet in einer Wand. Sie „kennt" ihre Wand
 * (`hostWallId`) und liegt über `position` (Abstand vom Wand-Startpunkt entlang
 * der Achse) relativ zur Wand — bewegt sich die Wand, folgt die Öffnung, weil die
 * Weltkoordinaten beim Rendern IMMER aus der Wandachse abgeleitet werden.
 *
 * Vertikale Lage (relativ zur Wand-Unterkante, UK):
 *   • Tür    — sitzt am Boden, `sillHeight` = 0, Höhe = lichte Türhöhe.
 *   • Fenster— Brüstung `sillHeight` > 0, Öffnung reicht von sillHeight bis
 *     sillHeight + height.
 *
 * Türspezifisch: `hinge` (Anschlagpfosten) + `swing` (Aufschlagseite) + optional
 * `swingAngle` (Öffnungswinkel des Blatts in Grad, Default 90) + `openingDir`
 * (Aufschlag nach innen/außen — kippt den Schwenkbogen auf die andere Achsseite).
 * Fenster nutzen optional `frameDepth`/`frameThickness` für die 3D-Rahmenstärke.
 */
export interface Opening {
  id: string;
  type: "opening";
  /** Wirts-Wand; das Geschoss ergibt sich aus der Wand. */
  hostWallId: string;
  /** Grafik-Kategorie (Ebene), z. B. "21" für Türen/Fenster. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /** Fenster oder Tür. */
  kind: "window" | "door";
  /** Abstand des ersten Pfostens vom Wand-Startpunkt entlang der Achse (Meter). */
  position: number;
  /** Lichte Öffnungsbreite in Metern. */
  width: number;
  /** Lichte Öffnungshöhe in Metern. */
  height: number;
  /** Brüstungshöhe (Unterkante der Öffnung) über der Wand-UK; 0 bei Türen. */
  sillHeight: number;
  /**
   * Nur Fenster: Anzahl der Flügel (1–4). Bei > 1 werden im Plan `wingCount − 1`
   * Mittelpfosten (Querlinien quer zur Öffnungsrichtung) gleichmäßig innerhalb des
   * Rahmens gezeichnet — analog den Mittelpfosten in `_make_oeffnung_pieces` des
   * Rhino-Plugins (`oeff_fluegel`). Fehlt es, gilt 1 (= heutiges Verhalten: keine
   * Pfosten).
   */
  wingCount?: number;
  /**
   * Nur Tür: Tür-Typ (analog `oeff_tuer_typ` im Rhino-Plugin).
   *   • "normal"       — Türblatt + Schwenkbogen (Default = heutiges Verhalten).
   *   • "wandoeffnung" — reiner Wanddurchbruch: KEIN Türblatt, KEIN Schwenkbogen;
   *     nur die Öffnung/Laibung (Wandlücke + ggf. Sturz-/Anschlaglinien) bleibt.
   * Fehlt es, gilt "normal".
   */
  doorType?: "normal" | "wandoeffnung";
  /** Nur Tür: an welchem Pfosten das Scharnier sitzt. */
  hinge?: "start" | "end";
  /** Nur Tür: auf welche Seite der Wandachse das Blatt aufschlägt. */
  swing?: SwingSide;
  /** Nur Tür: Öffnungswinkel des Blatts in Grad (Default 90). */
  swingAngle?: number;
  /** Nur Tür: Aufschlagrichtung (nach innen/außen); Default "in". */
  openingDir?: "in" | "out";
  /** Optionale Rahmenstärke (quer zur Wand) in Metern für die 3D-Darstellung. */
  frameThickness?: number;
  /**
   * Nur Tür: Sturzlinien (SIA, gestrichelt) quer über die Öffnung an der Wand-
   * Innen- und/oder Aussenkante. Zeigt die Überkopf-Projektion des Sturzes.
   *   "keine" → keine Sturzlinien
   *   "innen" → eine Linie an der Wand-Innenkante
   *   "aussen"→ eine Linie an der Wand-Aussenkante
   *   "beide" → beide Linien (Default wenn nicht gesetzt)
   */
  lintelLines?: "keine" | "innen" | "aussen" | "beide";
  /**
   * Referenz auf einen Bauteil-Typ (Bibliothek): {@link DoorType} bei
   * `kind: "door"`, {@link WindowType} bei `kind: "window"`. Fehlt sie, gilt
   * das heutige Inline-Verhalten (rückwärtskompatibel). Typ-Defaults liefern
   * Bauart/Rahmen/Verglasung; Element-Felder (Breite/Höhe/…) übersteuern.
   */
  typeId?: string;
  /**
   * Optionale per-Element-Übersteuerung der Detailstufe (grob/normal/
   * detailliert); fehlt sie, gilt die Ansichts-/Projekt-Detailstufe.
   */
  detailLevel?: DetailLevel;
  /**
   * Optionale Übersteuerung der Strich-/Symbolfarbe; sonst gilt die
   * Kategorie-Farbe.
   */
  color?: string;
  /** Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku). */
  colorPenId?: string;
  /**
   * Nur Fenster, Grundriss: Übersteuerung von Farbe/Strichstärke der
   * GESCHNITTENEN Blendrahmen-Querschnittsblöcke an den Laibungs-Enden
   * ({@link LineStyleOverride}, entspricht `windowSymbol.jambMarks` — die
   * Schnittfläche des Rahmenmaterials an der Wand-Laibung). `undefined` ⇒
   * {@link Opening.color}, sonst Kategorie-Farbe/Haarlinie. Separat von
   * {@link frameViewLine} (die durchlaufende Rahmen-Kontur in Aufsicht).
   */
  frameLine?: LineStyleOverride;
  /**
   * Nur Fenster, Grundriss: Übersteuerung von Farbe/Strichstärke der
   * durchlaufenden Blendrahmen-KONTUR in Aufsicht (das Rechteck aus
   * `windowSymbol.frame` — die beiden Linien zwischen den geschnittenen
   * Laibungs-/Stulp-Blöcken, NICHT geschnitten, sondern von oben/unten
   * projiziert). `undefined` ⇒ fällt auf {@link frameLine} zurück (bisheriges
   * Verhalten: eine gemeinsame Farbe/Stärke für Schnitt UND Aufsicht).
   */
  frameViewLine?: LineStyleOverride;
  /**
   * Nur Fenster, Grundriss: Übersteuerung von Farbe/Strichstärke des
   * Flügelrahmens/der Sprossen (window-sash/window-mullion).
   */
  sashLine?: LineStyleOverride;
  /**
   * Nur Fenster, Grundriss: Übersteuerung von Farbe/Strichstärke der Auf-/
   * Untersicht-Andeutung ({@link WindowType.sillLine}); nur wirksam, wenn der
   * Fenstertyp dort eine Sims-Linie aktiviert hat.
   */
  sillLineStyle?: LineStyleOverride;
}

/** Optionale Farb-/Strichstärke-Übersteuerung einer Linien-Kategorie im Grundriss. */
export interface LineStyleOverride {
  /** Strichfarbe (Hex); fehlt ⇒ System-Default. */
  color?: string;
  /** Strichstärke in mm Papier; fehlt ⇒ System-Default (Haarlinie). */
  weight?: number;
}

/**
 * Grundform einer Treppe (DOSSIER: gerade / L / Wendel).
 *   • "straight" — ein gerader Lauf (Lauflinie = Start → Richtung).
 *   • "L"        — zwei rechtwinklige Läufe mit Zwischenpodest an der Ecke.
 *   • "spiral"   — Wendeltreppe um ein Zentrum (keilförmige Tritte).
 */
export type StairShape = "straight" | "L" | "spiral";

/**
 * Eine Treppe (Treppe/Stair) — ein geschossübergreifendes Bauteil, das über die
 * Geschosshöhe (OKFF → OKFF des nächsten Geschosses) steigt. Definiert über eine
 * Grundform (gerade / L / Wendel), eine Basis-Geometrie, die Laufbreite und die
 * Stufung (Steigungshöhe/Auftrittstiefe, aus der Stufenanzahl abgeleitet).
 *
 * Basis-Geometrie je Grundform:
 *   • straight — `start` + `dir` (Einheitsrichtung) + `runLength` (Lauflänge).
 *   • L        — `start` + `dir` (erster Lauf) + `runLength` (erster Lauf) +
 *     `run2Length` (zweiter Lauf) + `turn` (+1 = links, −1 = rechts abbiegen).
 *     Das Zwischenpodest sitzt am Ende des ersten Laufs (quadratisch, `width`).
 *   • spiral   — `center` + `radius` (Innenradius zur Lauflinie) + `sweep`
 *     (Gesamtwinkel in Grad, +/− = Drehrichtung) + `start` (Startpunkt des ersten
 *     Tritts am äußeren Rand, definiert die Anfangsrichtung).
 *
 * Vertikale Lage: die UNTERKANTE (`baseZ`, abgeleitet aus dem Geschoss-OKFF) plus
 * `totalRise` (Default = Geschosshöhe des zugehörigen Geschosses, sodass die
 * Treppe genau ins nächste Geschoss steigt). `stepCount` Tritte/Setzstufen
 * verteilen `totalRise` gleichmäßig; die Steigungshöhe = totalRise/stepCount, die
 * Auftrittstiefe ergibt sich aus Lauflänge/(stepCount−1). Eine SIA-nahe
 * Schrittregel (2·Steigung + Auftritt ≈ 0.63 m) liefert die Default-Stufenzahl.
 */
export interface Stair {
  id: string;
  type: "stair";
  /** Zugehörige Zeichnungsebene (Geschoss), von dem die Treppe aufsteigt. */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "40" für Treppen. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /** Grundform (gerade / L / Wendel). */
  shape: StairShape;
  /** Startpunkt der Lauflinie im Grundriss (Meter). */
  start: Vec2;
  /** Einheits-Laufrichtung des (ersten) Laufs im Grundriss. */
  dir: Vec2;
  /** Lauflänge des (ersten) Laufs in Metern (entlang `dir`). */
  runLength: number;
  /** Nur L: Lauflänge des zweiten Laufs in Metern. */
  run2Length?: number;
  /** Nur L: Abbiegerichtung des zweiten Laufs (+1 = links, −1 = rechts). */
  turn?: 1 | -1;
  /** Nur Wendel: Zentrum der Wendeltreppe (Meter). */
  center?: Vec2;
  /** Nur Wendel: Radius (Meter) von der Mitte zur Lauflinie. */
  radius?: number;
  /** Nur Wendel: Gesamt-Drehwinkel in Grad (+ = CCW, − = CW). */
  sweep?: number;
  /** Laufbreite in Metern (quer zur Laufrichtung). */
  width: number;
  /**
   * Lage der gespeicherten Achse (`start`/`dir` bzw. Wendel-Bogen) über die
   * Laufbreite — analog `treppe_referenz` im Rhino-Plugin. Bestimmt, ob die Achse
   * die LINKE, MITTLERE oder RECHTE Kante der Treppe repräsentiert (in
   * Laufrichtung gesehen). Fehlt sie, gilt "mitte" (= heutiges Verhalten: Achse =
   * Treppen-Mitte).
   *   • "links"  — Achse = linke Kante; die Treppe liegt rechts der Achse.
   *   • "mitte"  — Achse = Mitte (Default).
   *   • "rechts" — Achse = rechte Kante; die Treppe liegt links der Achse.
   * Die Lauflinie samt Pfeil bleibt IMMER auf der visuellen Treppen-Mitte
   * (nicht auf der Referenzkante) — siehe `stairGeometry`.
   */
  referenz?: "links" | "mitte" | "rechts";
  /**
   * Gesamt-Steighöhe in Metern (OKFF → OKFF nächstes Geschoss). Fehlt sie, gilt
   * beim Auflösen die Geschosshöhe des zugehörigen Geschosses.
   */
  totalRise?: number;
  /** Anzahl der Steigungen (Setzstufen). Die Trittanzahl = stepCount (letzte =
   *  Austritt aufs obere Geschoss). Steigungshöhe = totalRise / stepCount. */
  stepCount: number;
  /**
   * Laufrichtung „aufwärts": true = die Lauflinie steigt von `start` in Richtung
   * `dir` (Default). false kehrt Auf-/Abpfeil um (Treppe steigt zum Start hin).
   */
  up?: boolean;
  /**
   * Referenz auf einen {@link StairType} (Bibliothek). Fehlt sie, gilt das
   * heutige Inline-Verhalten (rückwärtskompatibel). Typ-Defaults liefern
   * Tragart/Stufenausbildung/Geländer; Element-Felder übersteuern.
   */
  typeId?: string;
  /**
   * Optionale per-Element-Übersteuerung der Detailstufe (grob/normal/
   * detailliert); fehlt sie, gilt die Ansichts-/Projekt-Detailstufe.
   */
  detailLevel?: DetailLevel;
  /**
   * Optionale Übersteuerung der Strich-/Umrandungsfarbe; sonst gilt die
   * Kategorie-Farbe.
   */
  color?: string;
  /** Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku). */
  colorPenId?: string;
  /**
   * Darstellung des Auf-/Abpfeils an der Lauflinie: "line" (offener
   * Winkelpfeil, Default = heutiges Verhalten) oder "filled" (gefülltes
   * Dreieck als SIA-Vollpfeil). Fehlt sie, gilt "line".
   */
  arrowStyle?: "line" | "filled";
}

/**
 * Ein Raum (Raum/Room) — eine SIA-416-Fläche auf einem Geschoss, definiert über
 * einen GESCHLOSSENEN Umriss (Polygon, lichte Innenkontur) im Grundriss. Trägt
 * eine SIA-416-Blatt-Kategorie (HNF/NNF/VF/FF/KGF), einen Namen und eine Farbe.
 *
 * Fläche/Umfang/Schwerpunkt werden NICHT gespeichert, sondern bei jedem Rendern
 * aus `boundary` über den reinen Rechenkern (geometry/roomArea) abgeleitet —
 * so sind sie nie veraltet. `stampAnchor` (optional) setzt den Ankerpunkt des
 * Raum-Stempels; fehlt er, gilt der Flächenschwerpunkt (Centroid).
 */
export interface Room {
  id: string;
  type: "room";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "45" für Räume. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /** SIA-416-Blatt-Kategorie (HNF/NNF/VF/FF/KGF). */
  siaCategory: SiaCategory;
  /** Raum-Name, z. B. „Wohnen". */
  name: string;
  /**
   * Geschlossener Umriss (lichte Innenkontur) im Grundriss (Meter). Der
   * Schlusspunkt wird NICHT dupliziert (die letzte Kante läuft von boundary[n-1]
   * zu boundary[0]).
   */
  boundary: Vec2[];
  /** Strich-/Füllfarbe des Raums (hex). */
  color: string;
  /** Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku). */
  colorPenId?: string;
  /**
   * Anker des Raum-Stempels (Meter). Wird bei der Erstellung EINMAL auf den
   * Zentroid gesetzt und danach nie automatisch neu berechnet — der Stempel ist
   * frei verschiebbar und bleibt beim Ändern der Kontur/Fläche an seiner Stelle.
   * Fehlt er (Alt-Daten), gilt beim Rendern der Centroid.
   */
  stampAnchor?: Vec2;
  /**
   * Frei editierbarer Rich-Text des Raum-Stempels (Name + Notizen, mit Fett/
   * Kursiv/Grösse/Farbe/Ausrichtung). Fehlt er, gilt der Raum-Name als einfacher
   * Text. Die LIVE-Flächenzeile wird beim Rendern separat darunter gesetzt.
   */
  stampDoc?: RichTextDoc;
  /**
   * Strukturierter Raum-Stempel (Feldmodell). Ist er gesetzt, hat er Vorrang vor
   * `stampDoc`/`name`: der Stempel-Text wird aus den Feldern gebaut, die Live-
   * Zeilen (Bodenfläche/Nutzung) aus den Flags. Fehlt er, gilt der Alt-Pfad.
   */
  stamp?: RoomStamp;
}

/**
 * Feldmodell des Raum-Stempels. Ersetzt den freien Text durch benannte Felder;
 * daraus baut roomStamp.ts sowohl das gerenderte Rich-Text-Dokument als auch die
 * Live-Zeilen. Minimal gehalten (MVP).
 *
 * Folge-Arbeit: Fensterfläche (braucht Öffnung-in-Raum-Geometrie) — hier bewusst
 * NICHT enthalten.
 */
export interface RoomStamp {
  /** Raumnummer (kleiner Präfix in Zeile 1). */
  number?: string;
  /** Raumname (Zeile 1). */
  name: string;
  /** Raumname Zeile 2 (in Listen mit `name` zu einem Namen zusammengezogen). */
  nameLine2?: string;
  /** Bodenfläche anzeigen (Live-Zeile). */
  showFloorArea: boolean;
  /** Präfix vor der Bodenfläche, z. B. "BF " (Default leer). */
  floorAreaPrefix?: string;
  /** Nutzung (HNF/… · Bezeichnung) anzeigen (Live-Zeile). */
  showUsage: boolean;
  /** Ausrichtung der Namenszeile (Zeile 1). Fehlt sie, gilt „links". */
  nameAlign?: Align;
  /** Ausrichtung der zweiten Namenszeile. Fehlt sie, gilt „links". */
  line2Align?: Align;
  /** Ausrichtung der Bodenflächen-Zeile. Fehlt sie, gilt „zentriert" (Alt-Verhalten). */
  floorAreaAlign?: Align;
  /** Ausrichtung der Nutzungs-Zeile. Fehlt sie, gilt „zentriert" (Alt-Verhalten). */
  usageAlign?: Align;
  /**
   * Personenzahl (Live-Zeile), z. B. für Nutzungsauflagen. Fehlt/undefined:
   * keine Personenzahl-Zeile (Alt-Verhalten).
   */
  occupancy?: number;
  /**
   * Rundungsschritt der angezeigten Bodenfläche in m² (z. B. 0.5 → auf halbe
   * m² gerundet). Fehlt er, gilt das Alt-Verhalten: 2 Nachkommastellen ohne
   * Schrittrundung.
   */
  roundingStep?: number;
}

// ── Freie 2D-Zeichengeometrie (Drawing2D) ──────────────────────────────────
// Ein semantisches 2D-Element (wie Wall/Door), das beim Rendern abgeleitet wird
// (keine vorab erzeugten Plan-Primitive). Siehe docs/design/drawing-tools.md §7.

/** Geometrie-Form eines 2D-Zeichenelements. */
/**
 * Linienende (Pfeilspitze & Co.) an einer OFFENEN 2D-Form — in jedem CAD eine
 * Standard-Objekteigenschaft, vor allem für Beschriftungen. Rein grafisch,
 * kein Bezug auf andere Elemente.
 *   • "none"      — offenes Ende (Default)
 *   • "arrow"     — gefüllte Pfeilspitze (wie bisher fest am Leader)
 *   • "arrowOpen" — offene Pfeilspitze (zwei Striche)
 *   • "dot"       — gefüllter Punkt
 *   • "tick"      — Schrägstrich (45°, wie der Massstrich der Bemassung)
 *   • "square"    — gefülltes Quadrat
 */
export type EndMark = "none" | "arrow" | "arrowOpen" | "dot" | "tick" | "square";

export type Drawing2DGeom =
  | { shape: "line"; a: Vec2; b: Vec2 }
  /**
   * Konstruktionslinie (Hilfslinie): unendliche Ausrichtungslinie durch `a`
   * und `b`, nur zwei gesetzte Punkte gespeichert — beim Rendern/Picken WEIT
   * über beide hinaus verlängert (s. `XLINE_EXTEND_M`), damit sie optisch/
   * funktional unendlich wirkt, ohne echte Unendlichkeits-Sonderfälle in der
   * SVG-/PDF-/DXF-Pipeline zu brauchen. Bewusst NICHT offset-/trim-/
   * extend-/join-fähig (reine Ausrichtungshilfe, kein reales Bauteil).
   */
  | { shape: "xline"; a: Vec2; b: Vec2 }
  /**
   * Strahl (Nutzer-Wunsch: „Ray, halb-unendliche Linie — nur `xline`,
   * beidseitig unendlich, existiert"): `a` ist der FESTE Anker (wird NICHT
   * verlängert), `b` bestimmt nur die Richtung — beim Rendern/Picken weit
   * über `b` hinaus verlängert (dieselbe `XLINE_EXTEND_M`-Konstante), aber
   * NICHT über `a` hinaus. Sonst wie `xline`: bewusst NICHT offset-/trim-/
   * extend-/join-fähig.
   */
  | { shape: "ray"; a: Vec2; b: Vec2 }
  | {
      shape: "polyline";
      pts: Vec2[];
      closed: boolean;
      /**
       * Optionale Bogen-Segmente (DXF-„Bulge"-Konvention): `bulge[i]` krümmt
       * das Segment `pts[i] → pts[i+1]` (bei `closed` zusätzlich `bulge[pts.
       * length-1]` für das Schliess-Segment `pts[letzter] → pts[0]`) zu einem
       * Kreisbogen statt einer Geraden. `bulge[i] = tan(Δ/4)` (Δ = Öffnungs-
       * winkel des Bogens); Vorzeichen bestimmt die Seite (positiv = links von
       * a→b, s. `geometry/bulge.ts::bulgeArcPoints`). Fehlt der Eintrag oder
       * ist er 0/nahe 0 (`< 1e-9`), bleibt das Segment gerade — rein additiv,
       * jede bestehende Polylinie ohne `bulge` verhält sich exakt wie bisher.
       * Nur DIESES Feld unterscheidet eine „echte" Bogen-Polylinie von der
       * bisherigen rein geradlinigen; Rendering/Fläche/Export tessellieren den
       * Bogen (kein eigenes SVG-Arc-Primitiv, analog Ellipse/Spline/Bezier).
       */
      bulge?: number[];
    }
  | { shape: "rect"; min: Vec2; max: Vec2 }
  | { shape: "circle"; center: Vec2; r: number }
  | { shape: "arc"; center: Vec2; r: number; a0: number; a1: number }
  /**
   * Ellipse — achsparalleles Zentrum + zwei Halbachsen + Drehung (Radiant,
   * CCW). Das Zeichen-Werkzeug erzeugt bewusst nur `rotation: 0`; das Feld
   * existiert für zukünftige Dreh-Bearbeitung bzw. gedrehte Ellipsen aus
   * anderen Quellen. Rendering/Snapping/Griffe tessellieren sie (wie ehemals
   * `circle`), kein eigenes glattes SVG-Primitiv (s. `generatePlan/drawing2d.ts`).
   */
  | { shape: "ellipse"; center: Vec2; rx: number; ry: number; rotation: number }
  /**
   * Kubische Bezier-Kette: `pts.length` ≡ 1 (mod 3), ≥ 4 — Punkte im Muster
   * Anker·Griff·Griff·Anker·Griff·Griff·Anker·… (jedes weitere Segment fügt
   * 3 Punkte an). Manuell gesetzte Kontrollpunkte (klassisches Bezier-
   * Werkzeug), im Unterschied zu `spline` (Kurve DURCH Punkte, automatisch
   * geglättet). Immer offen (kein `closed`-Feld).
   */
  | { shape: "bezier"; pts: Vec2[] }
  /**
   * Glatte Kurve über `pts`, analog `polyline`, aber mit gerundetem statt
   * geradem Verlauf zwischen den Wegpunkten. `closed` schliesst den Ring
   * (letzter Wegpunkt → erster). `mode` (optional, Default `"fit"` bei
   * Fehlen — additiv wie üblich): `"fit"` = Kurve verläuft DURCH `pts`
   * (uniformer Catmull-Rom, das bisherige/einzige Verhalten); `"control"` =
   * `pts` sind Kontrollpunkte eines kubischen B-Splines (CV-Modus), die
   * Kurve wird nur von ihnen gezogen, berührt sie i. A. NICHT (Ausnahme:
   * Start/Ende bei offener Kurve, geklemmt). S. `tools/curves.ts::
   * sampleUniformBSpline` für die Geometrie.
   */
  | { shape: "spline"; pts: Vec2[]; closed: boolean; mode?: "fit" | "control" }
  /**
   * Masslinie (lineare Bemassung, SIA 400 B.5.3): misst den Abstand `a`↔`b`.
   * `offset` ist der VORZEICHENBEHAFTETE Normalabstand (Modell-Meter, links
   * von a→b positiv), in dem die eigentliche Masslinie parallel zu a-b liegt
   * — Masshilfslinien laufen von a/b bis zu dieser Linie. Die Masszahl wird
   * beim Rendern aus `dist(a,b)` abgeleitet (nicht gespeichert), bleibt also
   * beim Verschieben der Griffe automatisch korrekt. Rein 2D (kein Bezug auf
   * andere Elemente — Assoziativität nur über die eigenen Endpunkte).
   */
  /**
   * `pts.length` ≥ 2, IMMER kollinear (Werkzeug erzwingt das beim Zeichnen/
   * Ergänzen — eine Masskette ist eine Gerade, kein Zickzack-Pfad). Jedes
   * aufeinanderfolgende Punktpaar ist EIN gemessenes Segment (Reihenbemassung,
   * SIA 400 Figur 14), alle teilen denselben `offset`. EIN Element für die
   * ganze Kette (nicht mehrere) — spätere Bearbeitung kann Punkte ergänzen
   * (verlängern ODER dazwischen einfügen, s. `commands/cmds/dimension.ts`).
   */
  | {
      shape: "dimension";
      pts: Vec2[];
      offset: number;
      /**
       * Darstellungs-Feinheiten der Bemassung, ALLE optional und in
       * PAPIER-MILLIMETERN — so, wie die Zeichnungsnorm sie angibt
       * („Überstand 2 mm"), also unabhängig vom Massstab. Umgerechnet wird
       * beim Erzeugen des jeweiligen Plans (`model/dimension.ts::mmToModel`);
       * der Plan wird je Ziel — Bildschirm bzw. Layout-Viewport — eigens
       * erzeugt, der Massstab ist dort also bekannt und eindeutig.
       * Fehlt ein Wert, gilt `DIM_DEFAULTS_MM`.
       */
      /** Abstand Masshilfslinie → bemessener Punkt (Default 1 mm). */
      gapMm?: number;
      /** Überstand der Masshilfslinie ÜBER die Masslinie hinaus (Default 1 mm). */
      overshootMm?: number;
      /** Länge der Massstriche an den Masslinien-Enden (Default 3 mm). */
      tickLenMm?: number;
      /** Schrifthöhe der Masszahl (Default 4 mm). */
      textHeightMm?: number;
      /**
       * Strichstärken der drei Bestandteile, in PAPIER-MILLIMETERN (wie jede
       * andere Strichstärke hier — erst beim Rendern aufgelöst und daher
       * massstabsunabhängig; im Gegensatz zu den Abständen oben, die
       * zwangsläufig Modellmass sind). Fehlt ein Wert, gilt der bisherige
       * Default: Masslinie und Masshilfslinien erben die Strichstärke des
       * Elements, die Massstriche werden doppelt so dick gezeichnet
       * (Erkennbarkeit, SIA 400 Figur 13).
       */
      lineWeightMm?: number;
      extWeightMm?: number;
      tickWeightMm?: number;
      /**
       * Verschiebung der Masszahl aus ihrer Standardlage, ebenfalls in
       * PAPIER-MILLIMETERN, im Segment-Koordinatensystem: `along` entlang
       * der Masslinie (+ = Richtung b), `perp` quer dazu (+ = von der
       * Masslinie weg). Fehlt es, sitzt die Zahl mittig knapp über der
       * Masslinie. Bei einer Masskette gilt der Versatz je Segment,
       * Index = Segmentnummer.
       */
      textOffsetsMm?: { along: number; perp: number }[];
    }
  /**
   * Höhenkote (SIA 400 B.5.4, Figur 18): Dreieck-Symbol + Höhenwert (Meter,
   * ±0.00-Referenz frei wählbar, s. Norm) an einem Punkt. `kind` bestimmt
   * Dreieck-Richtung (OK = Spitze nach unten, UK = Spitze nach oben) UND
   * Füllung (fertig = Kontur/hohl, roh = voll gefüllt) — vier norm-genaue
   * Varianten, die fünfte („OK fertig UND roh kombiniert") ist nicht gebaut.
   * `at` ist die SPITZE des Dreiecks (der exakte referenzierte Punkt).
   */
  | {
      shape: "kote";
      at: Vec2;
      value: number;
      kind: "okFertig" | "ukFertig" | "okRoh" | "ukRoh";
      /** Drehung (Radiant); Werkzeug erzeugt bewusst nur 0, s. Ellipse-Muster. */
      rotation: number;
    }
  /**
   * Detail-/Schnitt-Verweis-Symbol (Nutzer-Wunsch: „Nur `leaderTarget` an
   * Text — kein zweiteiliges Verweis-Symbol, das eine Sheet/Layout-ID
   * trägt"). Klassische zweigeteilte Verweisblase: Kreis mit waagrechter
   * Trennlinie, `label` oben (Detail-/Schnitt-Bezeichner, z. B. „A"/„1"),
   * Blattbezeichnung unten (`sheetLayoutId` verweist auf ein echtes
   * `Project.layouts`-Blatt und LÖST seinen Namen zur Anzeige auf; fehlt der
   * Verweis oder ist das Blatt gelöscht, zeigt `sheetLabel` einen manuell
   * getippten Platzhalter). Fixe Modell-Meter-Grösse wie beim strukturell
   * ähnlichen `kote`-Symbol (keine Papier-mm-Skalierung — dieselbe bewusste
   * Vereinfachung).
   */
  | {
      shape: "detailref";
      /** Zentrum des Kreises. */
      at: Vec2;
      /** Obere Zeile: Detail-/Schnitt-Bezeichner. */
      label: string;
      /** Verknüpftes Blatt (`Project.layouts[].id`); `undefined` = kein Verweis. */
      sheetLayoutId?: string;
      /**
       * Untere Zeile OHNE Verweis (oder als Blatt gelöscht wurde): manuell
       * getippter Platzhalter. Mit gültigem `sheetLayoutId` wird stattdessen
       * der ECHTE Blattname angezeigt (immer aktuell, keine Duplizierung).
       */
      sheetLabel?: string;
    }
  /**
   * Massstabsbalken (Nutzer-Wunsch: „kein Massstabsbalken existiert"). Anders
   * als Bemassung/Kote/Detail-Verweis ist die BALKENLÄNGE bewusst in ECHTEN
   * Modell-Metern angegeben (nicht Papier-mm): der ganze Plan wird ohnehin im
   * Papier-Massstab abgebildet, ein 1-Meter-Segment erscheint dadurch
   * automatisch in der richtigen Papiergrösse für JEDEN Massstab — keine
   * eigene Umrechnung nötig. Nur die Balkenhöhe/Beschriftungsgrösse sind
   * (wie bei Bemassung/Kote) Papier-mm, damit sie unabhängig vom Massstab
   * lesbar bleiben. Achsparallel (horizontal) — keine Drehung in v1, analog
   * zur bewusst einfachen Ellipse-Erzeugung.
   */
  | {
      shape: "scalebar";
      /** Linke untere Ecke des Balkens. */
      at: Vec2;
      /** Länge EINES Segments in ECHTEN Modell-Metern. */
      segmentLength: number;
      /** Anzahl Segmente (abwechselnd gefüllt/leer). */
      segments: number;
    }
  /**
   * Punkt-/Knotenmarker (Nutzer-Wunsch: „Punkt-/Knotenmarker" aus der
   * Werkzeug-Lücken-Liste). Kleines, fest grosses Kreuz-in-Kreis-Symbol an
   * `at` — markiert einen einzelnen Referenz-/Vermessungspunkt im Plan (z. B.
   * einen Fixpunkt), OHNE selbst Bemassung/Text zu tragen. Fixe Modell-
   * Meter-Grösse wie `kote`/`detailref` (keine Papier-mm-Skalierung) — ein
   * physischer Bodenpunkt hat eine reale, vom Papier-Massstab unabhängige
   * Grösse ist hier bewusst NICHT das Ziel; wie bei `kote` geht es um
   * gleichbleibende Lesbarkeit im Plan.
   */
  | { shape: "pointmarker"; at: Vec2 }
  | {
      shape: "text";
      at: Vec2;
      text: string;
      height: number;
      angle: number;
      /**
       * Optionale Spaltenbreite in Metern (Textspalte/Absatztext). Ist sie gesetzt,
       * wird der Text beim Rendern wortweise auf diese Breite umgebrochen; fehlt
       * sie, bleibt es einzeiliger Text (heutiges Verhalten).
       */
      width?: number;
      /**
       * Optionale einheitliche Formatierung des ganzen Texts (Schriftfamilie, fett/
       * kursiv, Farbe …) — gesetzt über die Text-Formatier-Gruppe der Oberleiste,
       * wenn dieser Text selektiert ist. Die Grösse bleibt bewusst über `height`
       * (Modell-Meter) geführt, nicht über `marks.sizePt`.
       */
      marks?: Marks;
      /**
       * Reiches Textfeld (mehrere Absätze, gemischte Formatierung pro Zeichen —
       * InDesign-/Affinity-artig): gesetzt über den Doppelklick-Editor
       * (TextEditorDialog/RichTextEditor). Ist `doc` gesetzt, hat es Vorrang vor
       * `text`/`marks` beim Rendern; `text` wird beim Schreiben als Reintext-
       * Spiegel nachgeführt (DXF-Export, Suche, Alt-Konsumenten lesen weiter
       * `text`). `width` bricht wie gehabt wortweise um.
       */
      doc?: RichTextDoc;
      /**
       * Legenden-/Vorführungspfeil (Leader): optionale Zielposition, auf die
       * eine dünne Linie + Pfeilspitze vom Text aus zeigt (z. B. Beschriftung
       * eines entfernten Details). Kein eigener Shape — erbt dadurch die
       * komplette Inline-Text-Editor-Infrastruktur (analog `width` bei der
       * Textspalte). Gesetzt vom `leader`-Befehl, am normalen `text`-Werkzeug
       * unverändert `undefined`.
       */
      leaderTarget?: Vec2;
      /**
       * Zwischen-Knickpunkte der Hinweislinie, zwischen `at` (Textanker) und
       * `leaderTarget` (Spitze) — Nutzer-Wunsch: „Hinweislinie hat nur EIN
       * Segment, kein Knick-Punkt wie bei AutoCADs Multileader". Reihenfolge
       * vom TEXTANKER zur SPITZE (wie die Zeichenrichtung im `leader`-Befehl:
       * erst Spitze, dann rückwärts über die Knicke zum Text). Fehlt das
       * Feld (Alt-Daten/einfache Hinweislinie), bleibt es bei der bisherigen
       * geraden Linie `at → leaderTarget` — rein additiv, kein Format-Bruch.
       */
      leaderBendPoints?: Vec2[];
      /**
       * Text-entlang-Pfad: mind. 2 Stützpunkte, entlang derer der Text (nur
       * `text`, KEIN `doc`/Rich-Formatting — v1 bewusst einstilig) über ein
       * echtes SVG `<textPath>` fliesst. Ist gesetzt, bestimmt der Pfad die
       * Position/Neigung jedes Zeichens; `at`/`angle` werden dann ignoriert
       * (bleiben nur als Fallback für Alt-Konsumenten, die `pathPts` nicht
       * kennen — s. `drawing2d.ts`). Griffe sind dann die Pfadpunkte selbst
       * (wie bei `polyline`), nicht der einzelne Anker.
       */
      pathPts?: Vec2[];
    }
  /**
   * Platzierte Instanz eines wiederverwendbaren 2D-Symbols (`Project.
   * blockDefs`, s. dort). `rotation` in Radiant. Trägt selbst KEINE Geometrie
   * — die kommt beim Rendern/Picken/Snapping aus `blockDefId` + dieser
   * Transformation. Verweist die Instanz auf eine gelöschte/unbekannte
   * `blockDefId`, rendert sie schlicht nichts (kein Crash, s. `drawing2d.ts`).
   */
  | {
      shape: "block";
      blockDefId: string;
      at: Vec2;
      rotation: number;
      /**
       * Uniformer Skalierungsfaktor der Blockinstanz (Default 1, additiv/
       * optional — alte Projektdateien ohne dieses Feld bleiben gültig).
       * Nutzer-Wunsch: „Skalierung beim Einfügen" — zuvor gab es dafür kein
       * Modellfeld, ein `scale`-Transform auf eine Blockinstanz war damit ein
       * kompletter No-Op (kein Feld zum Multiplizieren). Bewusst NUR ein
       * uniformer Skalar (keine unabhängigen x/y-Faktoren) — konsistent mit
       * `rotation` (auch nur EIN Winkel, keine Scherung).
       */
      scale?: number;
    }
  | {
      shape: "image";
      /** Obere-linke Ecke der Bild-Box (Modell-Meter). */
      min: Vec2;
      /** Untere-rechte Ecke der Bild-Box (Modell-Meter). */
      max: Vec2;
      /** Bildquelle als Data-URL (PNG/JPEG) — eingebettet, keine externe Datei. */
      src: string;
      /** Deckkraft 0..1 (Default 1). */
      opacity?: number;
    };

/** Ein freies 2D-Zeichenelement auf einer Zeichnungsebene. */
export interface Drawing2D {
  id: string;
  type: "drawing2d";
  /** Zeichnungsebene (Geschoss ODER freie 2D-Ebene). */
  levelId: string;
  /** Grafik-Kategorie (Ebene) — liefert Farbe/Strichstärke als Default. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /**
   * Sichtbar am Bildschirm, aber von PDF-/SVG-/DXF-Export ausgeschlossen —
   * wie eine „Non-Plotting"-Ebene, nur pro Objekt statt pro ganzer Ebene
   * (z. B. für eine Konstruktions-/Hilfslinie, s. `xline`). Wirkt nur bei
   * `generatePlan(..., forPrint: true)` (den drei Export-Aufrufstellen in
   * `state/useExportHandlers.ts`) — die Bildschirmansicht ignoriert das Feld.
   */
  noPrint?: boolean;
  geom: Drawing2DGeom;
  /** Optionaler Linienstil (Line Manager); sonst Kategorie-Default. */
  lineStyleId?: string;
  /** Optionale Schraffur für geschlossene Formen (Hatch Manager). */
  hatchId?: string;
  /**
   * Attribut-Override der Muster-/Schraffurfarbe (Vordergrund) DIESER 2D-Form.
   * `undefined` = „Nach System" (erben → HatchStyle.color-Fallback). Betrifft die
   * Farbe der Schraffur-Musterlinien einer gefüllten Fläche (nicht den Umriss,
   * der über `color`/`lineStyleId` läuft).
   */
  foreground?: string;
  /**
   * Attribut-Override der Füllfarbe (Hintergrund) DIESER 2D-Form. `undefined` =
   * „Nach System". Synonym/Nachfolger von `fillColor`; ist `background` gesetzt,
   * hat es Vorrang vor `fillColor` (der Poché-Hintergrund der geschlossenen Form).
   */
  background?: string;
  /** Stift-Kopplung von `foreground` (s. `Component.foregroundPenId`-Doku). */
  foregroundPenId?: string;
  /** Stift-Kopplung von `background`, analog {@link Wall.foregroundPenId}. */
  backgroundPenId?: string;
  /** Optionale explizite Strichfarbe; sonst Kategorie-Farbe. */
  color?: string;
  /** Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku). */
  colorPenId?: string;
  /**
   * Massstab des Strichmusters DIESES Elements (multipliziert die Strich-/
   * Lückenlängen des Linienstils; Default 1). Entspricht dem LTSCALE je Objekt
   * in AutoCAD: dieselbe Strichlinie soll in 1:50 und 1:200 nicht gleich
   * „dicht" wirken. Ohne Wert bleibt das Muster exakt wie im Linienstil.
   */
  dashScale?: number;
  /**
   * Platzierung der Schraffur AN DIESEM OBJEKT (alle optional). Die Ressource
   * (`HatchStyle`) legt Muster/Massstab/Winkel grundsätzlich fest; hier lässt
   * sich das je Objekt nachjustieren — in AutoCAD eine der meistgenutzten
   * Objekteigenschaften, etwa damit ein Plattenraster an der Raumecke ansetzt
   * statt am Weltnullpunkt.
   *   • `hatchAngleDeg`  — ERSETZT den Winkel der Ressource (Grad)
   *   • `hatchScale`     — MULTIPLIZIERT den Massstab der Ressource
   *   • `hatchOrigin`    — Ankerpunkt des Musterrasters (Modellkoordinaten);
   *                        ohne Angabe bleibt es der Modellursprung, damit
   *                        benachbarte Flächen dieselbe Musterphase teilen.
   */
  hatchAngleDeg?: number;
  hatchScale?: number;
  hatchOrigin?: Vec2;
  /**
   * Objekt-Transparenz 0..1 (Default 1 = deckend) — wirkt auf Striche UND
   * Füllungen dieses Elements. In Vectorworks/AutoCAD eine Standard-
   * Objekteigenschaft (Bestand hinterlegen, Abbruch, durchscheinende
   * Flächen). Der DXF-Export trägt sie nicht mit (bewusst, s. PENDENZEN.md).
   */
  opacity?: number;
  /**
   * Transparenz NUR der Füllung/Schraffurfläche 0..1 (Default 1 = deckend) —
   * zusätzlich zu `opacity` (das Strich UND Füllung trifft). Der Umriss bleibt
   * dabei deckend (z. B. durchscheinende Fläche mit kräftiger Kontur).
   */
  fillOpacity?: number;
  /**
   * Linienenden an OFFENEN Formen (Linie, offene Polylinie, Bogen, Spline,
   * Bezier) sowie an der Hinweislinie eines Textes. `start`/`end` beziehen
   * sich auf die Zeichenrichtung der Form; `sizeMm` ist die Grösse in
   * PAPIER-MILLIMETERN (massstabsunabhängig, wie die Bemassungs-Feinheiten —
   * s. `model/dimension.ts`), Default `END_MARK_DEFAULT_SIZE_MM`.
   * Geschlossene Formen (Rechteck, Kreis, Ellipse, geschlossene Polylinie)
   * haben keine Enden und ignorieren das Feld.
   */
  endMarks?: { start?: EndMark; end?: EndMark; sizeMm?: number };
  /**
   * Optionale Vollton-Füllfarbe für geschlossene Formen (getrennt von der
   * Strichfarbe `color`). Fehlt sie, ist die Fläche transparent (nur Schraffur
   * bzw. ungefüllt).
   */
  fillColor?: string;
  /**
   * Optionale direkte Strichstärke-Übersteuerung in Millimetern; hat Vorrang
   * vor dem LineStyle-Gewicht und der Kategorie-Strichstärke.
   */
  weightMm?: number;
  /**
   * Quelle des Vordergrunds (Schraffur-Musterfarbe), wenn kein explizites
   * `foreground` gesetzt ist: "layer" erzwingt die Ebenenfarbe
   * (LayerCategory.color), "object"/`undefined` (Default) = heutiges Verhalten
   * (kein Bauteil-Bezug bei Drawing2D → HatchStyle.color-Fallback).
   */
  foregroundSource?: AttributeSource;
  /** Quelle des Hintergrunds (Füllfarbe), analog zu `foregroundSource`. */
  backgroundSource?: AttributeSource;
  /**
   * Quelle der Strichstärke, wenn kein explizites `weightMm` gesetzt ist:
   * "layer" erzwingt `LayerCategory.lw` (unter Umgehung des LineStyle-Gewichts),
   * "object"/`undefined` (Default) = heutige Kette (LineStyle.weight ?? Kategorie).
   */
  strokeWeightSource?: AttributeSource;
  /** Quelle der Schraffur, wenn kein explizites `hatchId` gesetzt ist: "layer"
   * erzwingt `LayerCategory.hatch`, "object"/`undefined` (Default) = heutiges
   * Verhalten (ohne `hatchId` keine Schraffur). */
  hatchSource?: AttributeSource;
}

/**
 * Ein Kanten-/Seiten-Griff eines selektierten Elements (zusätzlich zu den
 * Eckpunkt-Griffen). Liegt am Mittelpunkt einer Seite (Modell-Meter) und zeigt
 * mit `normal` als Einheitsvektor nach AUSSEN (vom Element weg). `aIndex`/
 * `bIndex` sind die beiden Vertex-Indizes der Kante — passend zur Indizierung
 * von `drawingVertices`/`moveGripOf`. Ziehen verschiebt BEIDE Vertices senkrecht
 * zur Kante (Form wächst/schrumpft an dieser Seite).
 */
export interface EdgeGrip {
  mid: Vec2;
  normal: Vec2;
  aIndex: number;
  bIndex: number;
  /**
   * Freie Kanten-Verschiebung: gesetzt bei OFFENER Geometrie (Linie/offene
   * Polylinie). Das Segment folgt dem vollen Cursor-Delta (nicht nur der Normale),
   * beide Endpunkte wandern mit, die Nachbar-Segmente dehnen sich nach. Bei
   * geschlossenen Formen/Wänden fehlt das Flag → senkrechte (parallel-)Verschiebung
   * entlang der Außennormale wie bisher.
   */
  free?: boolean;
  /**
   * Zu welchem Element diese Kante gehört (für Mehrfachauswahl — mehrere
   * gewählte Elemente liefern je eigene Kanten-Griffe). Fehlt bei den
   * exklusiven Einzel-Fällen (Decke/Raum), die weiterhin über die separat
   * gehaltene `selectedCeilingId`/`selectedRoomId` aufgelöst werden.
   */
  owner?: { drawingId?: string; wallId?: string };
}

// ── Extrudierter Körper (truck-Integration, docs/design/truck-plan.md) ─────
// Ein per `extrude`-Befehl aus einem geschlossenen 2D-Profil (Polylinie-Ring/
// Rechteck) erzeugter 3D-Körper. Die eigentliche B-Rep-Extrusion (truck-WASM,
// `engine/truckSolid.ts`) läuft NICHT hier, sondern asynchron in
// `toWalls3d.ts` (emitExtrudedSolids) — dieser Typ hält nur die Rohdaten.

/** Ein extrudierter Körper: geschlossenes Profil (Modell-Meter) + Höhe. */
export interface ExtrudedSolid {
  id: string;
  type: "extrudedSolid";
  /** Geschoss, dessen `baseElevation` die UK des Körpers bestimmt. */
  levelId: string;
  /**
   * Geschlossenes Profil in der XY-Ebene (Grundriss), ≥3 Punkte. Bei einem
   * Kreis-Profil (`circle` gesetzt) eine Tessellierung des Kreises (48-Eck) —
   * für 2D-Footprint/Auswahl/bbox/Verschieben; die 3D-Extrusion nutzt in dem
   * Fall stattdessen `circle` (echte runde truck-Extrusion, `extrudeCircle`).
   */
  points: Vec2[];
  /** Extrusionshöhe in Metern (> 0), nach +Z ab der Geschoss-UK. */
  height: number;
  /** Abstand der Körper-UK über der Geschoss-UK (Meter, Default 0). */
  baseOffset?: number;
  /**
   * Boolesche Rolle im Gebäude: "subtract" = Abzugskörper (Aussparung/Durchbruch/Nische).
   * Er zieht sich von allen Wänden, Decken und Stützen ab, die er durchdringt — in 3D
   * (truck-Boolean), im Grundriss und im Schnitt; selbst wird er nur als Umriss gezeigt.
   * Fehlt = normaler Körper.
   */
  operation?: "subtract";
  /**
   * Gesetzt, wenn das Profil ein Kreis ist (aus einem `Drawing2D` mit
   * `shape:"circle"`) — `points` bleibt die Tessellierung, `toWalls3d.ts`
   * (emitExtrudedSolids) nutzt `circle` für die runde 3D-Extrusion.
   */
  circle?: { center: Vec2; r: number };
  /**
   * Verjüngung 0 (Prisma, Default/fehlend) … 1 (Spitze — Kegel bei Kreis-,
   * Pyramide bei Polygon-Profil). Linear zum Profil-Schwerpunkt skaliert.
   */
  taper?: number;
  /**
   * Eckenradius (Meter) der Aussenkontur: jede Ecke wird durch einen echten Kreisbogen
   * verrundet (truck-B-Rep, auch im STEP-Export exakt). Fehlt/0 = scharfe Ecken.
   */
  cornerRadius?: number;
  /** Fase (Meter) an den Ecken der Aussenkontur — gerade Abschrägung; fehlt/0 = scharf. */
  chamfer?: number;
  /**
   * B-Rep-Körper statt Profil-Extrusion (Grundkörper Kugel/Zylinder/Kegel/Torus/Quader …
   * oder beliebige `trucksolid`-Spezifikation). `spec` ist eine `SolidSpec`
   * (`engine/truckSolid.ts`) in LOKALEN Koordinaten (Z ab der Geschoss-UK); `origin` ist der
   * Wert von `points[0]` bei der Erzeugung — die aktuelle Verschiebung ergibt sich aus
   * `points[0] − origin`, sodass Verschieben/Kopieren das Profil mitnimmt. `points` bleibt die
   * Grundriss-Fläche (Auswahl/2D-Umriss), `height` die Körperhöhe.
   */
  brep?: { spec: Record<string, unknown>; origin: Vec2; label?: string };
}

// ── Stütze (Column, Tragwerk) ──────────────────────────────────────────────
// Eine Stütze ist im Kern eine PLATZIERTE PROFIL-EXTRUSION: ein an `position`
// gesetztes 2D-Profil (Rechteck oder Kreis), um `rotation` gedreht, über `height`
// nach oben extrudiert. Anders als der generische `ExtrudedSolid` trägt sie
// vollständige BIM-Attribute (Geschoss, Kategorie, optionales Bauteil, UK/OK-
// Anker) — sie lebt daher in `Project.columns` mit eigenem Selektionskanal.

/**
 * Querschnitt einer Stütze im Grundriss (Modell-Meter), lokal um `position`.
 *   • "rect"  — Rechteck `width` (X, quer) × `depth` (Y, längs), vor Rotation.
 *   • "round" — Kreis mit `radius`.
 */
export type ColumnProfile =
  | { kind: "rect"; width: number; depth: number }
  | { kind: "round"; radius: number };

/**
 * Eine Stütze (Column) — ein geschossgebundenes Tragwerk-Bauteil (Kategorie
 * „50"), definiert über einen Einfügepunkt `position`, ein Profil, eine Drehung
 * und eine Höhe. Vertikale Lage analog Wand (UK/OK-Anker, sonst Geschoss-UK +
 * `height`).
 */
export interface Column {
  id: string;
  type: "column";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "50" für Tragwerk. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /** Einfügepunkt (Profil-Mitte) im Grundriss (Meter). */
  position: Vec2;
  /** Querschnitt (Rechteck oder Kreis). */
  profile: ColumnProfile;
  /** Drehung des Profils um `position` (Radiant, CCW; Default 0). */
  rotation: number;
  /** Höhe in Metern (> 0), nach +Z ab der UK. */
  height: number;
  /** Optionales tragendes Bauteil (Component) für Poché/3D-Farbe/Schraffur. */
  componentId?: string;
  /**
   * Vertikale Bindung der Unterkante (UK). Fehlt sie, sitzt die UK auf der
   * baseElevation des zugehörigen Geschosses (= Wand-Default).
   */
  bottom?: VerticalAnchor;
  /**
   * Vertikale Bindung der Oberkante (OK). Fehlt sie, ergibt sich die OK aus
   * UK + `height`.
   */
  top?: VerticalAnchor;
  /**
   * Optionale Übersteuerung der Strich-/Umrandungsfarbe; sonst gilt die
   * Kategorie-Farbe.
   */
  color?: string;
  /** Stift-Kopplung von `color` (s. `Component.colorPenId`-Doku). */
  colorPenId?: string;
  /**
   * Attribut-Override der Muster-/Schraffurfarbe (Vordergrund) DIESER Stütze.
   * `undefined` = „Nach System" (erben → Component.foreground), analog `Wall.
   * foreground`.
   */
  foreground?: string;
  /**
   * Attribut-Override der Füllfarbe (Hintergrund/Poché) DIESER Stütze.
   * `undefined` = „Nach System" (neutrale SIA-Poché HATCH_INK/HATCH_PAPER je
   * nach Schraffur-Muster), analog `Wall.background`.
   */
  background?: string;
  /** Stift-Kopplung von `foreground` (s. `Component.foregroundPenId`-Doku). */
  foregroundPenId?: string;
  /** Stift-Kopplung von `background`, analog {@link Wall.foregroundPenId}. */
  backgroundPenId?: string;
  /**
   * Attribut-Override der Strichstärke (mm Papier) DIESER Stütze. `undefined`
   * = „Nach System" (erben → `strokeWeightSource`), analog `Wall.strokeWeight`.
   */
  strokeWeight?: number;
  /**
   * Attribut-Override der Schnitt-Schraffur (Hatch Manager) DIESER Stütze.
   * `undefined` = „Nach System" (erben → `hatchSource`), analog `Wall.hatchId`.
   */
  hatchId?: string;
  /** Quelle des Vordergrunds, wenn kein explizites `foreground` gesetzt ist — analog `Wall.foregroundSource`. */
  foregroundSource?: AttributeSource;
  /** Quelle des Hintergrunds, analog {@link Column.foregroundSource}. */
  backgroundSource?: AttributeSource;
  /** Quelle der Strichstärke, analog {@link Column.foregroundSource}. */
  strokeWeightSource?: AttributeSource;
  /** Quelle der Schraffur, analog {@link Column.foregroundSource}. */
  hatchSource?: AttributeSource;
}

// ── Kontext-Geometrie (importiert / abgeleitet, NICHT semantisch) ───────────
// Importierte Geometrie ist „dumme" KONTEXT-Geometrie (Anzeige + späteres
// Snap-Ziel), KEIN Teil des semantischen BIM-Modells. Sie lebt in einer eigenen
// Schicht `Project.context` und wird beim Rendern wie eine Referenz behandelt.
// Bewusst three-frei: nur rohe Buffer-Daten (positions/indices), three-Objekte
// entstehen erst im Viewport.

/**
 * Ein importiertes Dreiecks-Mesh (z. B. aus DXF 3DFACE/POLYFACE/MESH). Rohe
 * BufferGeometry-Daten: `positions` = flaches Array (x,y,z, x,y,z, …) in Metern,
 * `indices` = Dreiecks-Indizes (je 3 ein Dreieck). Keine three-Objekte.
 */
export interface ImportedMesh {
  id: string;
  type: "importedMesh";
  name: string;
  /** Ursprünglicher DXF-Layer-Name (für spätere Kategorisierung). */
  layer?: string;
  /**
   * Grafik-Kategorie-Code (s. {@link LayerCategory}, `model/contextCategories.ts`)
   * — steuert Sichtbarkeit/Grau/Sperren wie bei jedem anderen Bauteil (Ebenen-
   * Panel). Fehlt er (ältere Importe vor dieser Erweiterung), bleibt das Objekt
   * IMMER sichtbar (Rückwärtskompatibilität), s. `generatePlan/context.ts`.
   */
  categoryCode?: string;
  positions: number[];
  indices: number[];
}

/**
 * Eine einzelne Kontur (Höhenlinie / Polylinie) auf konstanter Höhe `z`. `pts`
 * sind 2D-Stützpunkte (x,y) in Metern; `closed` schließt den Linienzug.
 */
export interface Contour {
  z: number;
  pts: Vec2[];
  closed: boolean;
  /** Ursprünglicher DXF-Layer-Name (für die Kategorisierung beim 2D-Import). */
  layer?: string;
  /**
   * Gefüllte Fläche (aus einer DXF-HATCH). Beim Drawing-Import wird daraus eine
   * geschlossene, gefüllte 2D-Form (Vollton-Füllung); sonst nur ein Umriss.
   */
  filled?: boolean;
  /**
   * Wahre Kurvengeometrie (aus CIRCLE/ARC). `pts` bleibt tesselliert (Kontext/
   * 3D), aber der Drawing-Import baut daraus eine GLATTE `{shape:"circle"|"arc"}`-
   * Form statt eines Vielecks. Winkel in RADIANT (CCW); Kreis = a0..a1 über 2π.
   */
  curve?: {
    kind: "circle" | "arc";
    cx: number;
    cy: number;
    r: number;
    a0: number;
    a1: number;
  };
}

/**
 * Ein importiertes Text-Element (DXF TEXT/MTEXT). `at` = Einfügepunkt in Metern,
 * `height` = Schrifthöhe in Modell-Metern, `angle` = Drehung in RADIANT (CCW).
 * Wird beim Drawing-Import zu einem `{shape:"text"}`-Drawing2D.
 */
export interface ImportedText {
  at: Vec2;
  text: string;
  height: number;
  angle: number;
  /** Ursprünglicher DXF-Layer-Name (für die Kategorisierung beim 2D-Import). */
  layer?: string;
}

/** Ein Satz Konturen (z. B. alle Höhenlinien eines DXF-Imports). */
export interface ContourSet {
  id: string;
  type: "contourSet";
  name: string;
  /** Ursprünglicher DXF-Layer-Name (für spätere Kategorisierung). */
  layer?: string;
  /** Grafik-Kategorie-Code, s. {@link ImportedMesh.categoryCode}. */
  categoryCode?: string;
  contours: Contour[];
}

/**
 * Ein TIN-Geländemodell, abgeleitet aus Konturen (Delaunay über (x,y), Z aus der
 * jeweiligen Kontur-Höhe). `positions` = flaches (x,y,z…)-Array in Metern,
 * `indices` = Dreiecks-Indizes. Gelände ist NICHT semantisch (Kontext-Schicht).
 */
export interface TerrainMesh {
  id: string;
  type: "terrainMesh";
  name: string;
  /** Ebenen-/Gruppierungsname (SitePanel), z. B. „Terrain". Optional. */
  layer?: string;
  /** Grafik-Kategorie-Code, s. {@link ImportedMesh.categoryCode}. */
  categoryCode?: string;
  positions: number[];
  indices: number[];
  /**
   * Optionale Pro-Vertex-Albedo (flach `[r,g,b, …]`, 0..1) — ein Wert je
   * Positions-Vertex, beim Import aus einem SWISSIMAGE-Luftbild gesampelt
   * („Luftbild aufs Gelände drapieren"). render3d färbt das TIN dann pro Vertex
   * statt mit der Grundfarbe. Fehlt es, bleibt das Gelände einfarbig.
   */
  vertexColors?: number[];
}

/**
 * Ein georeferenziertes Rasterbild (Luftbild/SWISSIMAGE, eingefügtes Bild) —
 * planar von oben auf die Modell-Ebene gelegt. `src` = Data-URL (PNG/JPEG),
 * `min`/`max` = Modell-Meter-Bounding-Box, die das Bild ausfüllt (Bild-Oben =
 * +Y). Wird im Grundriss als Hintergrund-Ebene gezeichnet (unter der Geometrie).
 * Gelände-Drapierung im 3D ist Folge-Arbeit.
 */
export interface ContextImage {
  id: string;
  type: "image";
  name: string;
  /** Ebenen-/Gruppierungsname (SitePanel), z. B. „Luftbild". Optional. */
  layer?: string;
  /** Grafik-Kategorie-Code, s. {@link ImportedMesh.categoryCode}. */
  categoryCode?: string;
  /** Bildquelle als Data-URL (PNG/JPEG). */
  src: string;
  /** Modell-Meter Bounding-Box (das Bild füllt [min..max] planar von oben). */
  min: Vec2;
  max: Vec2;
  /** Deckkraft 0..1 (Default 1). */
  opacity?: number;
  /**
   * Aufs Gelände-TIN „drapieren": im 3D-Viewer wird das Bild als Textur über das
   * Terrain gelegt (pixelscharf, s. render3d `set_aerial_texture`). Unabhängig von
   * der 2D-Hintergrund-Darstellung. Default false.
   */
  drape?: boolean;
  /**
   * Bildkorrektur (2D-Grundriss, CSS-`filter`-Semantik) — alle Werte optional,
   * fehlend = neutral (kein visueller Unterschied zu keinem Filter). `grayscale`
   * ist eine STETIGE 0..1-Blendung (nicht der binäre `mono`-Druckmodus von
   * `generatePlan()`, der Luftbilder ganz ausblendet — unabhängige Konzepte).
   */
  filters?: {
    /** 0 = Graustufen, 1 = Original, >1 = übersättigt. Default 1. */
    saturation?: number;
    /** 0 = schwarz, 1 = Original, >1 = heller. Default 1. */
    brightness?: number;
    /** 0 = flaches Grau, 1 = Original, >1 = kontrastreicher. Default 1. */
    contrast?: number;
    /** 0 = kein Effekt, 1 = vollständig Graustufen. Default 0. */
    grayscale?: number;
  };
}

/** Ein Kontext-Objekt: importiertes Mesh, Konturen-Satz, TIN oder Rasterbild. */
export type ContextObject = ImportedMesh | ContourSet | TerrainMesh | ContextImage;

/** Das gesamte Projekt. */
/**
 * Ein Ausschnitt (View-Snapshot) — eine benannte, gespeicherte Ansicht, die den
 * kompletten Darstellungszustand einfängt und per Klick wiederherstellt
 * (DOSSIER A2, ROADMAP §2c/§11). KEIN neuer Zustand, sondern ein Container, der
 * bereits vorhandene Bausteine KOMPONIERT + benennt: Ansicht (Typ/Kamera/
 * Massstab/Detail), Sichtbarkeit (Ebenen-/Zeichnungskombination, gleiches
 * Payload-Format wie {@link https LayerCombo}/`DrawingCombo`), aktive Overrides
 * und das aktive Geschoss. Lebt im DOKUMENT (`Project.viewSnapshots`), nicht im
 * localStorage — Ausschnitte gehören zum Projekt (Export/Teilen).
 */
export interface ViewSnapshot {
  id: string;
  name: string;
  /**
   * LEGACY: name-basierte Flach-Gruppierung (Phase 1). Wird von der neuen
   * Ordner-/Baum-UI nicht mehr genutzt, bleibt aber für Alt-Projekte gültig.
   * Neue Ausschnitte tragen stattdessen `folderId` (echte Ordner-Referenz).
   */
  folder?: string;
  /**
   * Ordner (Baumstruktur) des Ausschnitte-Panels, in dem der Ausschnitt liegt
   * ({@link ViewSnapshotFolder}). Fehlt er (oder verweist er ins Leere), liegt
   * der Ausschnitt auf der Wurzelebene. Additiv — Alt-Projekte laden unverändert.
   */
  folderId?: string;
  // ── Ansicht ──────────────────────────────────────────────────────────────
  /** Ansichtstyp (Grundriss / Perspektive). */
  viewType: ViewType;
  /** Kanonischer 3D-Blickwinkel (Front/Top/Iso/… bzw. freie Perspektive). */
  view3d: View3d;
  /** Sichtwinkel (FOV) der 3D-Perspektivkamera in Grad. Optional (nur 3D relevant). */
  fov?: number;
  /** Papier-Massstab „1:N" (der Nenner). */
  scaleDenominator: number;
  /** Detailgrad der Darstellung (grob/mittel/fein). */
  detail: DetailLevel;
  // ── Zustand ──────────────────────────────────────────────────────────────
  /** Aktives Geschoss/Zeichnungsebene beim Erfassen. */
  activeLevelId: string;
  /** Ebenen-Sichtbarkeit: Kategorie-`code` → sichtbar (wie `LayerCombo.codes`). */
  layerVisibility: Record<string, boolean>;
  /** Zeichnungsebenen-Sichtbarkeit: DrawingLevel-`id` → sichtbar (wie `DrawingCombo.ids`). */
  drawingVisibility: Record<string, boolean>;
  /**
   * Ids der beim Erfassen AKTIVEN (`enabled`) Override-Regeln. Beim
   * Wiederherstellen wird jede Regel des Projekts auf `enabled = ids.includes(id)`
   * gesetzt. Optional, damit hand-/altangelegte Snapshots ohne Feld gültig sind.
   */
  enabledOverrideRuleIds?: string[];
  /**
   * Kameraposition im Grundriss (Nutzer-Wunsch: „Ein gespeicherter Ausschnitt
   * ändert, WAS sichtbar ist, nicht WOHIN man schaut" — bisher merkte sich ein
   * Ausschnitt nie Bildmitte/Zoom). Beide Felder optional UND nur ein Paar
   * (nicht einzeln sinnvoll) — fehlen sie (Alt-Ausschnitte vor dieser
   * Ergänzung, oder beim Erfassen war kein Grundriss gemountet, z. B. 3D-
   * Ansicht/Schnitt), bleibt die Bildmitte beim Wiederherstellen unverändert
   * (nur der Massstab wird gesetzt, wie bisher).
   */
  cameraCenter?: Vec2;
  /** Zoom (Bildschirm-Pixel je Meter) beim Erfassen — zusammen mit `cameraCenter`. */
  cameraPxPerMeter?: number;
}

/**
 * Ein Ordner im Ausschnitte-Baum (DOSSIER A2). Ausschnitte verweisen per
 * `folderId` auf ihren Ordner; `parentId` erlaubt Verschachtelung (Ordner in
 * Ordner). Fehlt `parentId`, liegt der Ordner auf der Wurzelebene. Additiv —
 * Alt-Projekte laden unverändert (spiegelbildlich zu {@link LayoutFolder}).
 */
export interface ViewSnapshotFolder {
  id: string;
  name: string;
  /** Übergeordneter Ordner; ohne → Wurzelebene. */
  parentId?: string;
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

/**
 * Papierformat eines Layout-Blatts (Blattmasse in mm identisch zum PDF-Export).
 * ISO-216-Reihen A0–A6 und B0–B6; Alt-Projekte (nur A4/A3) laden unverändert.
 */
export type LayoutPaperFormat =
  | "a0"
  | "a1"
  | "a2"
  | "a3"
  | "a4"
  | "a5"
  | "a6"
  | "b0"
  | "b1"
  | "b2"
  | "b3"
  | "b4"
  | "b5"
  | "b6";
/** Ausrichtung eines Layout-Blatts. */
export type LayoutOrientation = "portrait" | "landscape";

/**
 * Einfache Textfelder des Titelblocks (Master). Alle optional — leere Felder
 * werden beim Auflösen aus dem Projekt/Layout mit sinnvollen Defaults gefüllt
 * (Projektname ← `Project.name`, Blattname ← `Layout.name`, Datum ← heute).
 */
export interface LayoutTitleBlock {
  projectName?: string;
  sheetName?: string;
  scale?: string;
  date?: string;
  author?: string;
}

/**
 * Masterlayout — gemeinsame Blatt-Elemente (Titelblock + optionaler Rahmen), die
 * einzelne {@link Layout}s per `masterId` erben. Eine Änderung am Master schlägt
 * auf alle Layouts durch, die ihn referenzieren (InDesign-/ArchiCAD-Muster).
 */
export interface MasterLayout {
  id: string;
  name: string;
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
  /** Titelblock-Textfelder (Vorlage; leere Felder werden aufgelöst/aufgefüllt). */
  titleBlock: LayoutTitleBlock;
  /**
   * Ordner (Master-Baum), in dem das Masterlayout liegt ({@link LayoutFolder} mit
   * `kind:"master"`). Fehlt er (oder verweist auf einen gelöschten/Layout-Ordner),
   * liegt der Master auf der Wurzelebene. Additiv — Alt-Projekte laden unverändert.
   */
  folderId?: string;
  /** Blattrahmen zeichnen (Randlinie). Optional, Default `true`. */
  border?: boolean;
  /**
   * Freie Blattbreite in mm. Ist sie (zusammen mit `customHeightMm`) gesetzt,
   * überschreibt sie `paper`/A4·A3 (die effektive Blattgrösse ist dann
   * `customWidthMm`×`customHeightMm`, `orientation` wird ignoriert). Fehlt sie,
   * gilt `paper`+`orientation` wie bisher. Additiv — Alt-Projekte laden unverändert.
   */
  customWidthMm?: number;
  /** Freie Blatthöhe in mm (siehe {@link MasterLayout.customWidthMm}). */
  customHeightMm?: number;
}

/**
 * Ein platzierter Viewport auf einem Layout-Blatt — Position/Grösse in Papier-mm,
 * gebunden an einen Ausschnitt (`snapshotId`). `scaleDenominator` übersteuert
 * optional den Massstab des Ausschnitts (Massstab pro Viewport).
 */
export interface LayoutViewport {
  id: string;
  /** Id des gebundenen Ausschnitts ({@link ViewSnapshot}). */
  snapshotId: string;
  /** Linke Kante auf dem Blatt (mm, von links). */
  xMm: number;
  /** Obere Kante auf dem Blatt (mm, von oben). */
  yMm: number;
  /** Breite des Viewport-Rahmens auf dem Blatt (mm). */
  widthMm: number;
  /** Höhe des Viewport-Rahmens auf dem Blatt (mm). */
  heightMm: number;
  /** Optionaler Massstab-Nenner (1:N); übersteuert `snapshot.scaleDenominator`. */
  scaleDenominator?: number;
}

/**
 * Eine 2D-Annotation (Linie/Rechteck/Text), direkt auf dem Layout-Blatt in
 * Papier-mm-Koordinaten gezeichnet — eine vom Viewport-Baum unabhängige
 * Zusatzschicht (Markup). `color`/`weightMm` sind optional (Editor-Defaults:
 * `#111111` / 0.25 mm); Text trägt statt `weightMm` seine Zeilenhöhe.
 */
export type LayoutAnnotation =
  | {
      id: string;
      kind: "line";
      x1Mm: number;
      y1Mm: number;
      x2Mm: number;
      y2Mm: number;
      color?: string;
      weightMm?: number;
    }
  | {
      id: string;
      kind: "rect";
      xMm: number;
      yMm: number;
      widthMm: number;
      heightMm: number;
      color?: string;
      weightMm?: number;
    }
  | {
      id: string;
      kind: "text";
      xMm: number;
      yMm: number;
      text: string;
      heightMm: number;
      color?: string;
      /**
       * Reiches Textfeld (mehrere Absätze, gemischte Formatierung) — Vorrang vor
       * `text`, s. gleichnamiges Feld bei `Drawing2DGeom["text"]`.
       */
      doc?: RichTextDoc;
      /** Optionale Rahmenbreite (mm) — bricht `doc` wortweise um; fehlt sie: einzeilig. */
      widthMm?: number;
    }
  | {
      id: string;
      kind: "image";
      xMm: number;
      yMm: number;
      widthMm: number;
      heightMm: number;
      /** Bildquelle als Data-URL (PNG/JPEG) — eingebettet, keine externe Datei. */
      src: string;
      opacity?: number;
    };

/**
 * Flaches Patch-Objekt für {@link LayoutAnnotation} — alle Felder ALLER Arten
 * optional (statt eines pro Art unterscheidenden Unions), damit CRUD/Handler
 * unabhängig von der konkreten `kind` bleiben (der Aufrufer setzt ohnehin nur
 * die zur gewählten Annotation passenden Felder).
 */
export type LayoutAnnotationPatch = Partial<{
  x1Mm: number;
  y1Mm: number;
  x2Mm: number;
  y2Mm: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  text: string;
  color: string;
  weightMm: number;
  doc: RichTextDoc;
  src: string;
  opacity: number;
}>;

/**
 * Ein Layout-Blatt — Papierformat/Ausrichtung, optionaler Master (`masterId`)
 * und die platzierten Viewports.
 */
export interface Layout {
  id: string;
  name: string;
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
  /** Eigene Plannummer im Titelblock; fehlt = laufende Nummer (`resolveTitleBlock`). */
  planNumber?: string;
  /** Referenz auf ein {@link MasterLayout}; ohne → kein Master (blanko Blatt). */
  masterId?: string;
  /**
   * Ordner (Baumstruktur), in dem das Layout liegt ({@link LayoutFolder}). Fehlt
   * er (oder verweist auf einen gelöschten Ordner), liegt das Layout auf der
   * Wurzelebene. Additiv — Alt-Projekte laden unverändert.
   */
  folderId?: string;
  /**
   * Freie Blattbreite in mm — überschreibt `paper`/A4·A3, siehe
   * {@link MasterLayout.customWidthMm}. Bei gesetztem `masterId` erbt das Blatt
   * ohnehin die Master-Grösse; eigene Custom-Werte gelten nur ohne Master.
   */
  customWidthMm?: number;
  /** Freie Blatthöhe in mm (siehe {@link Layout.customWidthMm}). */
  customHeightMm?: number;
  viewports: LayoutViewport[];
  /**
   * 2D-Markups direkt auf dem Blatt (Linie/Rechteck/Text), siehe
   * {@link LayoutAnnotation}. Additiv — Alt-Layouts ohne dieses Feld laden
   * unverändert (Editor/CRUD behandeln ein fehlendes Array wie ein leeres).
   */
  annotations?: LayoutAnnotation[];
}

/**
 * Ein Ordner im Layouts-Baum (DOSSIER A3). Layouts verweisen per `folderId` auf
 * ihren Ordner; `parentId` erlaubt Verschachtelung (Ordner in Ordner). Fehlt
 * `parentId`, liegt der Ordner auf der Wurzelebene. Masterlayouts liegen NICHT
 * in Ordnern (sie sind Vorlagen). Additiv — Alt-Projekte laden unverändert.
 */
export interface LayoutFolder {
  id: string;
  name: string;
  /** Übergeordneter Ordner; ohne → Wurzelebene. */
  parentId?: string;
  /**
   * Baum-Zugehörigkeit: `"layout"`-Ordner tragen Layouts, `"master"`-Ordner
   * tragen Masterlayouts. Die beiden Bäume bleiben getrennt (ein Master-Ordner
   * erscheint nie im Layout-Baum und umgekehrt). Fehlt das Feld, gilt `"layout"`
   * (rückwärtskompatibel — Alt-Projekte ohne `kind` bleiben Layout-Ordner).
   */
  kind?: "layout" | "master";
}

/**
 * Gruppe (Vectorworks-artig) — reine Mitgliedschaft je Elementart, siehe
 * {@link Project.groups}. Alle ID-Listen sind additiv; ein Element gehört
 * NIE zu mehr als einer Gruppe auf derselben Ebene (das Werkzeug/der Befehl
 * stellt das beim Gruppieren sicher, nicht das Modell selbst).
 */
export interface Group {
  id: string;
  name?: string;
  wallIds: string[];
  drawingIds: string[];
  ceilingIds: string[];
  roomIds: string[];
  stairIds: string[];
  columnIds: string[];
  roofIds: string[];
  openingIds: string[];
  /** Verschachtelte Gruppen (diese Gruppe enthält andere Gruppen als Ganzes). */
  groupIds: string[];
}

export interface Project {
  /** Dateiformat-Version (s. `io/projectFormat.ts`); wird beim Speichern gesetzt. */
  formatVersion?: number;
  id: string;
  name: string;
  /** Linienstil-Bibliothek (Line Manager). */
  lineStyles: LineStyle[];
  /**
   * Textstil-Bibliothek (Nutzer-Wunsch: „Textstil-Bibliothek" — bisher gab es
   * nur 4 FEST verdrahtete `DEFAULT_PRESETS` in `text/richText.ts`, nirgends
   * im Projekt gespeichert, nirgends im ResourceManager editierbar). Optional
   * mit Fallback auf `DEFAULT_PRESETS` (wie `layouts` — additiv, alte
   * Projektdateien ohne dieses Feld bleiben gültig). Wiederverwendet den
   * bereits vorhandenen `TextStylePreset`-Typ (Marks-Vorlage) UND die
   * bereits vorhandene `applyPreset()`-Anwendungslogik aus `richText.ts` —
   * neu ist NUR, dass die Liste jetzt projektbezogen + editierbar ist statt
   * hart codiert.
   */
  textStyles?: TextStylePreset[];
  /** Schraffur-Bibliothek (Hatch Manager). */
  hatches: HatchStyle[];
  /** Bauteil-Material-Bibliothek (Component Manager). */
  components: Component[];
  wallTypes: WallType[];
  /**
   * Deckentypen (Deckenstile) — dediziert für Decken, analog `wallTypes`.
   * Optional, damit bestehende Projekte/Tests ohne `ceilingTypes` gültig
   * bleiben; Decken ohne `ceilingTypeId` lösen weiterhin über das LEGACY-Feld
   * `Ceiling.wallTypeId` gegen `wallTypes` auf (siehe `getCeilingType`).
   */
  ceilingTypes?: CeilingType[];
  /**
   * Dachtypen (Dachaufbauten) — mehrschichtig, analog `ceilingTypes`. Optional;
   * Dächer ohne `roofTypeId` lösen über die einschichtige `Roof.thickness` auf.
   */
  roofTypes?: RoofType[];
  /**
   * Wiederverwendbare 2D-Symbol-Bibliothek (Möbelblöcke, Sanitär-/Norm-
   * symbole u. Ä.) — analog `wallTypes`: einmal definieren, beliebig oft als
   * `{shape:"block"}`-Instanz platzieren. V1 bewusst NUR 2D (kein 3D-Körper,
   * keine verschachtelten Blöcke). Optional, damit bestehende Projekte ohne
   * `blockDefs` gültig bleiben.
   */
  blockDefs?: BlockDef[];
  /**
   * Türtypen-Bibliothek (Türstile), analog `wallTypes`. Optional, damit
   * bestehende Projekte/Tests ohne `doorTypes` gültig bleiben; Türen ohne
   * `typeId` verhalten sich wie bisher (Inline-Felder).
   */
  doorTypes?: DoorType[];
  /**
   * Fenstertypen-Bibliothek (Fensterstile). Optional (siehe `doorTypes`).
   */
  windowTypes?: WindowType[];
  /**
   * Treppentypen-Bibliothek (Treppenstile). Optional (siehe `doorTypes`).
   */
  stairTypes?: StairType[];
  /**
   * Stift-Bibliothek (ArchiCAD-Stiftsatz-Muster, s. {@link ColorPen}):
   * projektweite Liste der Stift-IDs/-Namen. Optional, damit bestehende
   * Projekte/Tests ohne Stifte gültig bleiben.
   */
  pens?: ColorPen[];
  /**
   * Stiftsätze (s. {@link PenSet}) — je einer eine vollständige Stift→Farbe-
   * Zuordnung. Optional (siehe `pens`).
   */
  penSets?: PenSet[];
  /**
   * ID des aktuell AKTIVEN Stiftsatzes (`penSets`). Fehlt sie (kein Stiftsatz
   * angelegt/aktiviert), lösen Stift-Verweise auf `PEN_FALLBACK_COLOR` auf.
   */
  activePenSetId?: string;
  /**
   * Benutzerdefinierte Farbpaletten (s. {@link CustomPalette}) — im
   * Farbmischer-Popover per „Diese Farbe speichern" befüllt. Optional
   * (siehe `pens`).
   */
  customPalettes?: CustomPalette[];
  /**
   * Welche MITGELIEFERTEN Paletten-Bänke im Farbwahl-Popover erscheinen
   * (s. {@link BuiltinPaletteBanks}). Fehlt das Objekt, sind alle sichtbar.
   */
  builtinPaletteBanks?: BuiltinPaletteBanks;
  /** Oberste Schnitte: Geschosse + Schnitte/Ansichten. */
  drawingLevels: DrawingLevel[];
  /** Raumprogramm (Soll) für die Prüfung gegen das Modell. */
  roomProgram?: RoomProgramRow[];
  /** Parzellenfläche (m²) für Ausnützungs- und Überbauungsziffer. */
  parcelArea?: number;
  /** Grafik-Kategorie-Baum (geschossübergreifend). */
  layers: LayerCategory[];
  walls: Wall[];
  /**
   * Decken (Slabs) — geschossgebundene Flächenbauteile mit geschlossenem Umriss.
   * Optional, damit bestehende Projekte/Tests ohne `ceilings` gültig bleiben
   * (Default: leer behandeln).
   */
  ceilings?: Ceiling[];
  /** Dächer über (rechteckigen) Grundriss-Umrissen. Optional (Alt-Projekte). */
  roofs?: Roof[];
  /**
   * Öffnungen (Fenster/Türen), gehostet in Wänden. Optional, damit bestehende
   * Projekte/Tests ohne `openings` gültig bleiben (Default: leer behandeln).
   */
  openings?: Opening[];
  /**
   * Treppen (Treppe) — geschossübergreifende Bauteile (gerade/L/Wendel). Optional,
   * damit bestehende Projekte/Tests ohne `stairs` gültig bleiben (Default: leer).
   */
  stairs?: Stair[];
  /**
   * Räume (SIA-416-Flächen) — geschossgebundene Flächen mit geschlossenem Umriss.
   * Optional, damit bestehende Projekte/Tests ohne `rooms` gültig bleiben
   * (Default: leer behandeln).
   */
  rooms?: Room[];
  /** Freie 2D-Zeichengeometrie (Line/Polyline/Rect/Circle/Arc/Text). */
  drawings2d: Drawing2D[];
  /**
   * Kontext-Schicht: importierte/abgeleitete „dumme" Geometrie (Meshes,
   * Konturen, Gelände-TIN) — NICHT semantisch. Optional, damit bestehende
   * Projekte/Tests ohne `context` gültig bleiben (Default: leer behandeln).
   */
  context?: ContextObject[];
  /**
   * Extrudierte Körper (truck-Integration) — geschlossene 2D-Profile mit Höhe,
   * siehe {@link ExtrudedSolid}. Optional, damit bestehende Projekte/Tests ohne
   * `extrudedSolids` gültig bleiben (Default: leer behandeln).
   */
  extrudedSolids?: ExtrudedSolid[];
  /**
   * Stützen (Columns) — geschossgebundene Tragwerk-Bauteile (platzierte
   * Profil-Extrusionen), siehe {@link Column}. Optional, damit bestehende
   * Projekte/Tests ohne `columns` gültig bleiben (Default: leer behandeln).
   */
  columns?: Column[];
  /**
   * Gruppen (Vectorworks-artig: Cmd+G fasst die Auswahl zu einer Einheit
   * zusammen; Doppelklick betritt die Gruppe zum Bearbeiten, alles andere
   * wird dabei gedimmt/gesperrt — s. `state/useGroupState.ts`). Eine Gruppe
   * ist reine MITGLIEDSCHAFT (IDs je Elementart, wie eine gespeicherte
   * Mehrfachauswahl) — kein eigenes Geometrie-/Transform-Objekt, damit
   * Verschieben/Kopieren/Löschen weiterhin dieselbe Maschinerie nutzen wie
   * eine normale Mehrfachauswahl. `groupIds` erlaubt Verschachtelung (eine
   * Gruppe kann andere Gruppen enthalten). Optional, damit bestehende
   * Projekte/Tests ohne `groups` gültig bleiben (Default: leer behandeln).
   */
  groups?: Group[];
  /**
   * Bibliothek parametrischer Wand-Regelwerke. Optional, damit bestehende
   * Projekte ohne `parametricWalls` gültig bleiben (Default: leer behandeln).
   * Wird durch `resolveParametricWall()` in `src/model/parametricWalls.ts`
   * aufgelöst — generiert Wall[]-Objekte bei Bedarf.
   */
  parametricWalls?: ParametricWall[];
  /**
   * Grafische Override-Regeln (Regel-Engine, Reihenfolge = Priorität, oben
   * gewinnt) — reines Rendering-Overlay, siehe {@link OverrideRule}. Optional,
   * damit bestehende Projekte/Tests ohne `overrideRules` gültig bleiben
   * (Default: leer behandeln).
   */
  overrideRules?: OverrideRule[];
  /**
   * Ausschnitte / View-Snapshots (DOSSIER A2) — benannte, wiederherstellbare
   * Ansichten (siehe {@link ViewSnapshot}). Optional, damit bestehende
   * Projekte/Tests ohne `viewSnapshots` unverändert gültig bleiben (Default:
   * leer behandeln). Gehört ins Dokument (nicht localStorage).
   */
  viewSnapshots?: ViewSnapshot[];
  /**
   * Ordner des Ausschnitte-Baums (DOSSIER A2) — Gruppierung der
   * {@link ViewSnapshot}s per `folderId`. Optional, damit bestehende
   * Projekte/Tests ohne `viewSnapshotFolders` gültig bleiben (Default: leer →
   * alle Ausschnitte auf Wurzelebene).
   */
  viewSnapshotFolders?: ViewSnapshotFolder[];
  /**
   * Layout-Blätter (DOSSIER A3) — Druck-/Plan-Blätter mit platzierten Viewports
   * (siehe {@link Layout}). Optional, damit bestehende Projekte/Tests ohne
   * `layouts` gültig bleiben (Default: leer behandeln). Gehört ins Dokument.
   */
  layouts?: Layout[];
  /**
   * Masterlayouts (DOSSIER A3) — gemeinsame Blatt-Elemente (Titelblock/Rahmen),
   * die einzelne {@link Layout}s erben (siehe {@link MasterLayout}). Optional,
   * damit bestehende Projekte/Tests ohne `masterLayouts` gültig bleiben.
   */
  masterLayouts?: MasterLayout[];
  /**
   * Ordner des Layouts-Baums (DOSSIER A3) — Gruppierung der {@link Layout}s per
   * `folderId`. Optional, damit bestehende Projekte/Tests ohne `layoutFolders`
   * gültig bleiben (Default: leer → alle Layouts auf Wurzelebene).
   */
  layoutFolders?: LayoutFolder[];
  /**
   * Referenzhöhe des Erdgeschosses in Metern über Meer (m ü. M.), editierbar
   * im Einstellungs-Fenster. Optional, damit bestehende Projekte ohne diesen
   * Wert gültig bleiben (Default: unbestimmt/0). NUR Speicherfeld — die
   * eigentliche Verwendung (Terrain-Draping/reale Höhen relativ dazu, siehe
   * HANDOVER GEO-BLOCK) ist ein separater, späterer Task und liest dieses
   * Feld noch nicht.
   */
  referenceElevationMasl?: number;
  /**
   * Georeferenzierung: verbindet EINEN Modell-Punkt (lokale Meter) mit seiner
   * realen LV95-Koordinate. Wird beim ERSTEN Standort-Import automatisch
   * gesetzt (Modell-Position per Default (0,0), editierbar) und danach für
   * ALLE weiteren Importe (Gebäude/Terrain/OSM) wiederverwendet — vorher
   * berechnete jeder Import unabhängig einen neuen Bezug aus der jeweils
   * gesuchten Adresse, wodurch mehrere Importe lagefalsch zueinander landen
   * konnten, sobald nicht exakt derselbe Suchbegriff verwendet wurde.
   * `label` ist die Anzeige-Adresse (rein informativ). Optional, damit
   * bestehende Projekte ohne Bezug gültig bleiben.
   */
  geoAnchor?: {
    /** Reale Landeskoordinate (LV95/EPSG:2056, Meter). */
    lv95: { e: number; n: number };
    /**
     * Reale Höhe des Bezugspunkts in Metern über Meer (m ü. M.). Wie ArchiCADs
     * „Vermessungspunkt" (Ost/Nord/Höhe): rein informativ verankert, VERSCHIEBT
     * das Modell NICHT. Wird beim IFC-Export als `IfcSite.RefElevation`
     * (Standort-Datumshöhe) geschrieben. Optional.
     */
    height?: number;
    /** Zugehöriger Punkt im Modell (lokale Meter), Default (0,0). */
    model: Vec2;
    /** Anzeige-Adresse/Bezeichnung des Bezugspunkts. */
    label?: string;
  };
}

// ── Helfer ───────────────────────────────────────────────────────────────

export const getWallType = (project: Project, wall: Wall): WallType => {
  const wt = project.wallTypes.find((t) => t.id === wall.wallTypeId);
  if (!wt) throw new Error(`Unbekannter Wandtyp: ${wall.wallTypeId}`);
  return wt;
};

/**
 * Liefert den Aufbau-Typ einer Decke oder wirft. Bevorzugt den dedizierten
 * Deckentyp (`ceilingTypeId` → `ceilingTypes`); fehlt er, fällt die Auflösung
 * auf das LEGACY-Feld `wallTypeId` → `wallTypes` zurück (Rückwärtskompatibilität
 * mit Projekten von vor den Deckenstilen — dort trug die Decke ihren Aufbau
 * direkt über einen WallType).
 */
export const getCeilingType = (project: Project, ceiling: Ceiling): CeilingType | WallType => {
  if (ceiling.ceilingTypeId) {
    const ct = (project.ceilingTypes ?? []).find((t) => t.id === ceiling.ceilingTypeId);
    if (ct) return ct;
  }
  const wt = project.wallTypes.find((t) => t.id === ceiling.wallTypeId);
  if (!wt) throw new Error(`Unbekannter Deckentyp: ${ceiling.ceilingTypeId ?? ceiling.wallTypeId}`);
  return wt;
};

/**
 * Gesamtdicke einer Decke (Meter): eine explizite `thickness`-Übersteuerung hat
 * Vorrang, sonst die Summe der Schichtdicken ihres Aufbau-Typs (siehe
 * `getCeilingType`).
 */
export const ceilingThickness = (project: Project, ceiling: Ceiling): number => {
  if (ceiling.thickness != null && ceiling.thickness > 0) return ceiling.thickness;
  try {
    return wallTypeThickness(getCeilingType(project, ceiling));
  } catch {
    return 0.2;
  }
};

/**
 * Schichtaufbau eines Daches (aussen/Eindeckung → innen/Verkleidung). Mit
 * {@link Roof.roofTypeId} die Schichten des Dachtyps; sonst eine EINSCHICHTIGE
 * synthetische Schicht aus {@link Roof.thickness} (leere `componentId` ⇒ der
 * Renderer nutzt seine Default-Dachfarbe).
 */
export const roofLayers = (project: Project, roof: Roof): Layer[] => {
  if (roof.roofTypeId) {
    const rt = (project.roofTypes ?? []).find((t) => t.id === roof.roofTypeId);
    if (rt && rt.layers.length > 0) return rt.layers;
  }
  return [{ componentId: "", thickness: Math.max(0, roof.thickness) }];
};

/**
 * Löst den {@link DoorType} einer Tür-Öffnung auf, oder `undefined` (keine
 * `typeId` bzw. unbekannt ⇒ Inline-Verhalten). Bewusst NICHT werfend — der
 * Typ ist eine optionale Übersteuerung, kein Pflichtbezug wie beim Wandtyp.
 */
export const getDoorType = (project: Project, opening: Opening): DoorType | undefined =>
  opening.typeId ? (project.doorTypes ?? []).find((t) => t.id === opening.typeId) : undefined;

/** Löst den {@link WindowType} einer Fenster-Öffnung auf, oder `undefined`. */
export const getWindowType = (project: Project, opening: Opening): WindowType | undefined =>
  opening.typeId ? (project.windowTypes ?? []).find((t) => t.id === opening.typeId) : undefined;

/**
 * Flügeleinteilung eines Fenstertyps als normalisierte {@link SashDef}-Liste.
 * Ist `wt.sashes` gesetzt, gilt sie unverändert; sonst wird sie aus `wingCount`
 * gleichmässig abgeleitet (n Flügel ⇒ n Flügel-Einträge; die n−1 Mittelpfosten
 * ergeben sich implizit aus der gleichmässigen Aufteilung). So beherrschen alle
 * Renderer beide Wege (Alt-Projekte ohne `sashes` inbegriffen).
 */
export const sashesOfWindowType = (wt: WindowType): SashDef[] => {
  if (wt.sashes && wt.sashes.length > 0) return wt.sashes;
  const n = Math.max(1, Math.round(wt.wingCount || 1));
  const opening = wt.kind === "fest" ? "fest" : wt.kind;
  return Array.from({ length: n }, (_, i) => ({
    kind: "fluegel" as const,
    autoWidth: true,
    opening,
    // Abwechselnder Anschlag (klassisch): erster Flügel links, nächster rechts …
    hingeSide: (i % 2 === 0 ? "left" : "right") as "left" | "right",
  }));
};

/**
 * Verglasungs-Scheibenzahl (1/2/3) eines Fenstertyps, render-wirksam. `glazingPanes`
 * hat Vorrang; fehlt es, wird sie aus {@link WindowType.glazing} abgeleitet.
 */
export const glazingPanesOf = (wt: WindowType): 1 | 2 | 3 => {
  if (wt.glazingPanes) return wt.glazingPanes;
  return wt.glazing === "dreifach" ? 3 : wt.glazing === "zweifach" ? 2 : 1;
};

/** Löst den {@link StairType} einer Treppe auf, oder `undefined`. */
export const getStairType = (project: Project, stair: Stair): StairType | undefined =>
  stair.typeId ? (project.stairTypes ?? []).find((t) => t.id === stair.typeId) : undefined;

/** Alle Öffnungen einer Wand (leere Liste, wenn keine oder `openings` fehlt). */
export const openingsOfWall = (project: Project, wallId: string): Opening[] =>
  (project.openings ?? []).filter((o) => o.hostWallId === wallId);

/** Menschenlesbarer Standardname einer Öffnung (Fenster/Tür + Breite×Höhe). */
export const openingLabel = (o: Opening): string =>
  `${o.kind === "door" ? "Tür" : "Fenster"} ${(o.width * 100).toFixed(0)}×${(
    o.height * 100
  ).toFixed(0)}`;

/** Alle Treppen eines Geschosses (leere Liste, wenn keine oder `stairs` fehlt). */
export const stairsOfFloor = (project: Project, floorId: string): Stair[] =>
  (project.stairs ?? []).filter((s) => s.floorId === floorId);

/** Menschenlesbarer Standardname einer Treppe (Grundform + Stufenanzahl). */
export const stairLabel = (s: Stair): string => {
  const shape =
    s.shape === "straight" ? "Gerade" : s.shape === "L" ? "L-Treppe" : "Wendel";
  return `${shape} ${s.stepCount} STG`;
};

/** Alle Stützen eines Geschosses (leere Liste, wenn keine oder `columns` fehlt). */
export const columnsOfFloor = (project: Project, floorId: string): Column[] =>
  (project.columns ?? []).filter((c) => c.floorId === floorId);

/** Menschenlesbarer Standardname einer Stütze (Profil + Masse in cm). */
export const columnLabel = (c: Column): string => {
  if (c.profile.kind === "round") {
    return `Stütze Ø${(c.profile.radius * 200).toFixed(0)}`;
  }
  return `Stütze ${(c.profile.width * 100).toFixed(0)}×${(c.profile.depth * 100).toFixed(0)}`;
};

/** Alle Räume eines Geschosses (leere Liste, wenn keine oder `rooms` fehlt). */
export const roomsOfFloor = (project: Project, floorId: string): Room[] =>
  (project.rooms ?? []).filter((r) => r.floorId === floorId);

/** Liefert ein Bauteil-Material (Component) per ID oder wirft. */
export const getComponent = (project: Project, id: string): Component => {
  const c = project.components.find((co) => co.id === id);
  if (!c) throw new Error(`Unbekanntes Bauteil-Material: ${id}`);
  return c;
};

/** Liefert eine Schraffur (HatchStyle) per ID oder wirft. */
export const getHatch = (project: Project, id: string): HatchStyle => {
  const h = project.hatches.find((ht) => ht.id === id);
  if (!h) throw new Error(`Unbekannte Schraffur: ${id}`);
  return h;
};

/** Liefert einen Linienstil (LineStyle) per ID oder wirft. */
export const getLineStyle = (project: Project, id: string): LineStyle => {
  const l = project.lineStyles.find((ls) => ls.id === id);
  if (!l) throw new Error(`Unbekannter Linienstil: ${id}`);
  return l;
};

/** Liefert eine Zeichnungsebene (Geschoss) per ID oder wirft. */
export const getFloor = (project: Project, id: string): DrawingLevel => {
  const g = project.drawingLevels.find((z) => z.id === id);
  if (!g) throw new Error(`Unbekanntes Geschoss: ${id}`);
  return g;
};

/**
 * Stapelt baseElevation der Geschosse in Dokumentreihenfolge: Das erste
 * Geschoss beginnt bei 0, jedes weitere bei baseElevation + floorHeight des
 * vorigen Geschosses. Nicht-Geschoss-Ebenen behalten baseElevation undefined.
 * Liefert eine neue Liste (mit neuen Geschoss-Objekten); die Eingabe bleibt
 * unverändert.
 */
export const recomputeFloorElevations = (
  levels: DrawingLevel[],
): DrawingLevel[] => {
  let nextBase = 0;
  return levels.map((level) => {
    if (level.kind !== "floor") {
      return { ...level, baseElevation: undefined };
    }
    const baseElevation = nextBase;
    nextBase = baseElevation + (level.floorHeight ?? 0);
    return { ...level, baseElevation };
  });
};

/** Flacht den Kategorie-Baum (Tiefensuche) in eine Liste ab. */
export const flattenCategories = (cats: LayerCategory[]): LayerCategory[] => {
  const out: LayerCategory[] = [];
  const walk = (list: LayerCategory[]) => {
    for (const c of list) {
      out.push(c);
      if (c.children) walk(c.children);
    }
  };
  walk(cats);
  return out;
};

/**
 * Liefert die LayerCategory zu einem Kategorie-Code (Baum durchsucht), oder
 * `undefined`, falls der Code auf keine Ebene verweist (verwaister
 * `categoryCode`). Nicht-werfend, damit die Attribut-Resolve-Kette
 * (`plan/generatePlan.ts`) robust auf einen fehlenden Ebenen-Wert zurückfallen
 * kann (→ Bauteil-Fallback).
 */
export const getLayerCategory = (project: Project, code: string): LayerCategory | undefined =>
  flattenCategories(project.layers).find((c) => c.code === code);

/** Menge aller Codes sichtbarer Kategorien (Baum berücksichtigt). */
export const collectVisibleCodes = (layers: LayerCategory[]): Set<string> => {
  const codes = new Set<string>();
  for (const c of flattenCategories(layers)) {
    if (c.visible) codes.add(c.code);
  }
  return codes;
};

/** Gesamtdicke eines Wandtyps = Summe der Schichtdicken. */
export const wallTypeThickness = (wt: WallType): number =>
  wt.layers.reduce((sum, l) => sum + l.thickness, 0);

/**
 * Kompakter Anzeigetext für einen Wandtyp im Dropdown (VW-Stil).
 * - Einschichtig mit Kürzel: „BET 24" (Kürzel + Dicke in cm)
 * - Mehrschichtig mit Kürzeln: „GKB·BET·DAE" + Gesamtdicke „(25.5)"
 * - Ohne Kürzel: Name bleibt — kein Rückfall auf rohen Namen, nur keine Kurzform.
 *
 * `project.components` wird genutzt, um `Component.abbrev` aufzulösen.
 * Ist kein abbrev gesetzt, erscheint der volle Name unverändert.
 */
export function wallTypeLabel(
  wt: WallType | CeilingType,
  components: Component[],
): string {
  const resolve = (id: string) => components.find((c) => c.id === id);
  const totalCm = +(wallTypeThickness(wt) * 100).toFixed(1);
  // cm-Zahl: "24" statt "24.0", "17.5" bleibt "17.5"
  const cmStr = totalCm % 1 === 0 ? String(totalCm | 0) : String(totalCm);

  // Alle Schichten haben ein Kürzel → Kurzform bauen
  const abbrevs = wt.layers.map((l) => resolve(l.componentId)?.abbrev ?? "");
  const allHaveAbbrev = abbrevs.every((a) => a.length > 0);
  if (allHaveAbbrev) {
    if (wt.layers.length === 1) return `${abbrevs[0]} ${cmStr}`;
    return `${abbrevs.join("·")} (${cmStr})`;
  }
  // Fallback: voller Name
  return wt.name;
}

/** Formatiert Meter mit zwei Nachkommastellen, z. B. "0.35 m". */
export const formatM = (meters: number): string => meters.toFixed(2) + " m";

/**
 * Standard-Stiftstärken (mm Papier bei 100 %), Vorgabeliste für Linienstil-/
 * Strichstärke-Eingaben. Bedeutung: Breite auf dem Papier — die Linien skalieren
 * mit dem Massstab (non-scaling-stroke). Werte sind Vorschläge; man darf abweichen.
 */
export const PEN_WEIGHTS: number[] = [
  0.02, 0.1, 0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0,
];
