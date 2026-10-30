// GENERIERT aus dem Rust-Modell (src-tauri/core/src/model/) über ts-rs — NICHT von Hand ändern.
// Neue Modellfelder nur im Rust-Modell eintragen, dann `npm run gen:types` ([K4] S4).
// `npm run check` (cargo test im Kern) schlägt fehl, wenn diese Datei veraltet ist.
/* eslint-disable */

/** Absatz-Ausrichtung. */
export type Align = "left" | "center" | "right";

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
 * Wiederverwendbares 2D-Symbol (Möbelblock, Sanitär-/Normsymbol, Nordpfeil
 * u. Ä.) — s. `Project.blockDefs` + `Drawing2DGeom["block"]`. `geom2d` ist
 * LOKALE Geometrie (Ursprung = Einfügepunkt der Instanz, Winkel 0 = wie
 * definiert); jede Instanz transformiert sie beim Rendern per `at`/`rotation`.
 * Bewusst KEIN verschachtelter `"block"`-Shape in `geom2d` (keine Blöcke in
 * Blöcken, v1) — nicht technisch erzwungen, nur Konvention der Autoren-Seite
 * (`commands/cmds/defblock.ts`).
 */
export type BlockDef = { id: string; name: string; geom2d: Array<Drawing2DGeom> };

/**
 * Sichtbarkeit der MITGELIEFERTEN Farbpaletten-Bänke im Farbwahl-Popover
 * (`ui/FreeColorPicker.tsx`). Fehlt ein Schlüssel (oder das ganze Objekt),
 * gilt die Bank als sichtbar — nur ein explizites `false` blendet sie aus
 * (z. B. RAL, wenn im Projekt nie mit Fassadenfarben gearbeitet wird).
 */
export type BuiltinPaletteBanks = { simple?: boolean; tango?: boolean; material?: boolean; ral?: boolean };

/** Bekleidung einer Tür ([105]): auf der Aufschlagseite, der Gegenseite, beidseitig oder keine. */
export type CasingSides = "beide" | "aufschlag" | "gegen" | "keine";

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
export type Ceiling = {
  id: string;
  type: "ceiling";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "30" für Decken. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /** Aussen (true) / innen (false); fehlt = nicht angegeben (IFC `IsExternal`). */
  isExternal?: boolean;
  /** Tragend (IFC `LoadBearing`); fehlt = nicht angegeben. */
  loadBearing?: boolean;
  /**
   * Geschlossener Umriss im Grundriss (Meter). Der Schlusspunkt wird NICHT
   * dupliziert (die letzte Kante läuft von outline[n-1] zu outline[0]).
   */
  outline: Array<Vec2>;
  /**
   * Aussparungen (Löcher) im Grundriss (Meter): je Loch ein geschlossener
   * Umriss (Schlusspunkt nicht dupliziert), VOLLSTÄNDIG innerhalb von
   * {@link outline} — Treppenauge, Schacht, Kamindurchbruch. Wirkt in 2D
   * (Poché-Loch + Randlinien) und 3D (Loch im Slab). Fehlt/leer ⇒ Volldecke.
   */
  openings?: Array<Array<Vec2>>;
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
};

/**
 * Ein Deckentyp (Deckenstil) = geordneter Schichtaufbau EINER Decke, liegend
 * gestapelt (oben → unten) — das horizontale Gegenstück zum `WallType`. Nutzt
 * denselben `Layer`-Typ (Bauteil + Dicke + optionaler Schichtfugen-Linienstil),
 * damit Fuge/Schraffur-Auflösung identisch zur Wand bleiben. Eine „einschichtige"
 * Decke (SOLID) ist einfach ein Deckentyp mit genau einer Schicht.
 */
export type CeilingType = { id: string; name: string; layers: Array<Layer> };

/**
 * Ein Stift (ArchiCAD-Stiftsatz-Muster): ein reiner NAME/PLATZHALTER, der
 * projektweit über alle {@link PenSet}s hinweg dieselbe Identität `id` behält.
 * Ein Stift trägt selbst KEINE Farbe — welche Farbe er zeigt, bestimmt der
 * jeweils AKTIVE Stiftsatz (`Project.activePenSetId`). Ein Bauteil/eine Ebene,
 * die statt einer freien Farbe auf einen Stift zeigt (`xxxPenId`), übernimmt
 * dadurch automatisch jede Farbänderung des Stifts bzw. jeden Stiftsatz-
 * Wechsel — ohne selbst angefasst zu werden.
 */
export type ColorPen = { id: string; name: string };

/**
 * Eine Stütze (Column) — ein geschossgebundenes Tragwerk-Bauteil (Kategorie
 * „50"), definiert über einen Einfügepunkt `position`, ein Profil, eine Drehung
 * und eine Höhe. Vertikale Lage analog Wand (UK/OK-Anker, sonst Geschoss-UK +
 * `height`).
 */
export type Column = {
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
  /**
   * Quelle des Vordergrunds, wenn kein explizites `foreground` gesetzt ist — analog `Wall.foregroundSource`.
   */
  foregroundSource?: AttributeSource;
  /** Quelle des Hintergrunds, analog {@link Column.foregroundSource}. */
  backgroundSource?: AttributeSource;
  /** Quelle der Strichstärke, analog {@link Column.foregroundSource}. */
  strokeWeightSource?: AttributeSource;
  /** Quelle der Schraffur, analog {@link Column.foregroundSource}. */
  hatchSource?: AttributeSource;
};

/**
 * Querschnitt einer Stütze im Grundriss (Modell-Meter), lokal um `position`.
 *   • "rect"  — Rechteck `width` (X, quer) × `depth` (Y, längs), vor Rotation.
 *   • "round" — Kreis mit `radius`.
 */
export type ColumnProfile = { kind: "rect"; width: number; depth: number } | { kind: "round"; radius: number };

/**
 * Ein Bauteil-Material (Component Manager) — vereint Plan-Schnittdarstellung
 * (Schraffur) und 3D-Erscheinung. Ersetzt das frühere `Material`.
 */
export type Component = {
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
  /** Wärmeleitfähigkeit λ in W/(m·K) (Bemessungswert, z. B. SIA 381/1, Herstellerangabe). */
  lambda?: number;
  /** Rohdichte in kg/m³. */
  density?: number;
  /**
   * Brandverhalten nach VKF (Brandschutzrichtlinie 13-15): "RF1" (kein Brandbeitrag), "RF2"
   * (geringer), "RF3" (zulässiger), "RF4" (unzulässig). Freitext, damit auch Zusätze („RF1 (cr)") gehen.
   */
  fireClass?: string;
  /** Flächenfarbe in der Ansicht (Fassade/Dachaufsicht). Fehlt sie, gilt die bisherige Farbe. */
  elevationColor?: string;
  /**
   * Ansichtsschraffur ([100]): Oberflächenmuster, das auf sichtbaren Flächen dieses Bauteils gezeichnet
   * wird (Ansicht, Dachaufsicht im Grundriss). Masse in Metern am Bau, Ausrichtung am Element.
   */
  surfacePattern?: SurfacePattern;
  /**
   * Herkunft: Kennung des Standard-Eintrags ([100], „Standards laden"), damit erneutes Laden nichts verdoppelt.
   */
  standardId?: string;
};

/**
 * PBR-Material-Karten eines Bauteils (3D-Texturierung). Jede URL verweist auf
 * ein Bild — entweder ein eingebautes Bibliotheks-Asset unter
 * `/assets/materials/...` ODER eine per Nutzer-Upload erzeugte Object-/Data-URL.
 * Fehlende Karten werden weggelassen (z. B. nur `color` bei einem Upload).
 * `sizeM` ist die physische Kantenlänge EINER Texturkachel in Metern (für die
 * korrekte Skalierung der Wiederholung), Default 1.0 m.
 */
export type ComponentMaterial = {
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
};

/**
 * Bedingte-Dicken-Regel: weist bereits generierten Wänden einen anderen
 * Wandtyp zu, wenn eine Bedingung erfüllt ist.
 * Typischer Anwendungsfall: Außenwände erhalten einen anderen Aufbau als Innenwände.
 *
 * Ablauf (Engine):
 *   Bestehende Wände aus `existingWalls` filtern → `wallTypeId` ändern.
 *   Gibt modifizierte Kopien zurück (keine Mutation).
 */
export type ConditionalThicknessRule = {
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
};

/**
 * Ein georeferenziertes Rasterbild (Luftbild/SWISSIMAGE, eingefügtes Bild) —
 * planar von oben auf die Modell-Ebene gelegt. `src` = Data-URL (PNG/JPEG),
 * `min`/`max` = Modell-Meter-Bounding-Box, die das Bild ausfüllt (Bild-Oben =
 * +Y). Wird im Grundriss als Hintergrund-Ebene gezeichnet (unter der Geometrie).
 * Gelände-Drapierung im 3D ist Folge-Arbeit.
 */
export type ContextImage = {
  type: "image";
  id: string;
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
};

/** Kontext-Objekt (Tag `type`). */
export type ContextObject = ImportedMesh | ContourSet | TerrainMesh | ContextImage;

/**
 * Eine einzelne Kontur (Höhenlinie / Polylinie) auf konstanter Höhe `z`. `pts`
 * sind 2D-Stützpunkte (x,y) in Metern; `closed` schließt den Linienzug.
 */
export type Contour = {
  z: number;
  pts: Array<Vec2>;
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
  curve?: { kind: "circle" | "arc"; cx: number; cy: number; r: number; a0: number; a1: number };
};

/** Ein Satz Konturen (z. B. alle Höhenlinien eines DXF-Imports). */
export type ContourSet = {
  type: "contourSet";
  id: string;
  name: string;
  /** Ursprünglicher DXF-Layer-Name (für spätere Kategorisierung). */
  layer?: string;
  /** Grafik-Kategorie-Code, s. {@link ImportedMesh.categoryCode}. */
  categoryCode?: string;
  contours: Array<Contour>;
};

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
export type CustomPalette = {
  id: string;
  name: string;
  /** Hex-Werte, Reihenfolge = Anzeigereihenfolge im Raster. */
  colors: Array<string>;
  /**
   * Im Farbwahl-Popover anzeigen? Fehlt das Feld, gilt `true` (sichtbar) —
   * so bleiben bestehende Projekte unverändert. Umschaltbar im Ressourcen-
   * Manager (Tab „Paletten"), damit die Bank-Leiste im Popover kurz bleibt.
   */
  visible?: boolean;
};

/**
 * Detailgrad der Darstellung (≙ DOSSIER Einfach/Standard/Detail). Wirkt im
 * Grundriss auf Tür-/Fenstersymbole + Schraffuren/Linienfeinheit (siehe
 * generatePlan.DetailLevel); in der Perspektive noch ohne Wirkung (deferred).
 */
export type DetailLevel = "grob" | "mittel" | "fein";

/** Merkmal, an dem ein Bemassungspunkt hängt ([38], `dim_assoc.rs`). */
export type DimFeature = "wall" | "opening" | "vertex" | "edge" | "center" | "intersection";

/** Bezug eines Bemassungspunkts auf ein Element ([38]). */
export type DimRef = {
  /** Element-id (Wand, Öffnung, Stütze, Decke, Dach, Raum oder 2D-Zeichnung). */
  id: string;
  feature: DimFeature;
  index?: number;
  t?: number;
  id2?: string;
  index2?: number;
  /** Normalabstand Merkmal → Masslinie (Modell-Meter, links der Masslinie positiv); fehlt = 0. */
  d?: number;
  /** Bezug ungültig (Element/Punkt weg): der Punkt bleibt an der zuletzt gespeicherten Lage. */
  lost?: boolean;
};

/** Masse einer Türzarge/eines Türrahmens ([105]); Bedeutung je `frameKind`. Fehlt ⇒ Vorgabe. */
export type DoorFrameDetail = {
  /** Falzbreite (parallel zur Wandfläche: Überdeckung Blatt/Rahmen), Vorgabe 0.015. */
  falzWidth?: number;
  /** Falztiefe (quer zur Wand, ≈ Blattdicke), Vorgabe 0.04. */
  falzDepth?: number;
  /** Spiegelbreite der Stahlzarge auf der Wandfläche, Vorgabe 0.05. */
  spiegel?: number;
  /** Blechdicke der Stahlzarge, Vorgabe 0.002. */
  sheetThickness?: number;
  /** Futterstärke (Brett in der Leibung), Vorgabe 0.025. */
  liningThickness?: number;
  /** Bekleidungsbreite, Vorgabe 0.07. */
  casingWidth?: number;
  /** Bekleidungsdicke, Vorgabe 0.012. */
  casingThickness?: number;
  /** Bekleidung auf welcher Seite (Vorgabe beide). */
  casingSides?: CasingSides;
};

export type DoorType = {
  id: string;
  name: string;
  /**
   * Bauart: normaler Drehflügel, reine Wandöffnung (kein Blatt/Schwenk),
   * Schiebetür. Ersetzt/ergänzt das Inline-Feld `Opening.doorType`.
   */
  kind: "dreh" | "schiebe" | "wandoeffnung" | "hebeschiebe" | "pendel";
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
  frameKind?: "zarge" | "blockrahmen" | "blendrahmen" | "umfassungszarge" | "eckzarge" | "blockzarge" | "futter";
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
  insetFace?: "aussen" | "innen" | "mitte";
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
  /**
   * Anschlag (Maueranschlag): so weit (Meter, je Seite und oben) springt die Wand zwischen
   * der Fläche aus {@link insetFace} und der Rahmen-Vorderkante in die Öffnung vor. Wirkt nur
   * mit Leibung (`insetFromFace` > 0 bzw. `insetFace: "mitte"`). 0/fehlt ⇒ stumpf (bisher).
   */
  rebateDepth?: number;
  /**
   * Sturz: Höhe des Sturzes über der Öffnung (Meter), im Schnitt als eigener Querschnitt
   * gezeichnet. 0/fehlt ⇒ kein eigener Sturz (bisher).
   */
  lintelHeight?: number;
  /**
   * Rahmen-Detail ([105]): Blendrahmen je Seite, Flügelrahmen, Pfosten/Kämpfer, Zusatzprofile,
   * Anschlag je Seite. Fehlt ⇒ wie bisher (`frameWidth`, `rebateDepth`).
   */
  frameDetail?: FrameDetail;
  /**
   * Schichteinzug ([106]): wie die Wandschichten an Leibung, Sturz und Brüstung anschliessen.
   * Fehlt ⇒ alle Schichten bündig (bzw. `innerLayerRecess`, veraltet).
   */
  layerReveals?: Array<LayerReveal>;
  /** Masse der Türzarge/des Türrahmens ([105]): Falz, Spiegel, Futter, Bekleidung. */
  doorFrame?: DoorFrameDetail;
};

/**
 * Gaube/Lukarne ([G5]) in einer Dachfläche: Stirnwand parallel zur Traufe, Wangen bis an das
 * Hauptdach, eigenes Dach mit dem Hauptdach verschnitten; das Hauptdach ist an der Gaube in allen
 * Schichten ausgeschnitten. Das Fenster in der Stirn ist eine `Opening` mit `hostDormerId`.
 */
export type Dormer = {
  id: string;
  kind: DormerKind;
  /** Mitte der Stirnwand-Aussenseite im Grundriss (Meter); legt auch die Dachfläche fest. */
  position: Vec2;
  /** Aussenbreite (Wange aussen bis Wange aussen, Meter). */
  width: number;
  /** Stirnhöhe: von der Dach-Oberkante an der Stirn bis Unterkante Gaubendach (Meter). */
  frontHeight: number;
  /**
   * Neigung des Gaubendachs in Grad (Sattel/Walm/Schlepp); fehlt ⇒ Sattel/Walm 40°, Schlepp aus der
   * Tiefe bzw. 15°, Flach 0.
   */
  pitchDeg?: number;
  /**
   * Nur Schleppgaube: waagrechte Tiefe von der Stirn bis zum Anschluss an das Hauptdach (Meter);
   * gesetzt ⇒ die Neigung folgt daraus.
   */
  depth?: number;
  /** Dachüberstand an Stirn und Seiten (Meter); fehlt ⇒ 0.15. */
  overhang?: number;
  /** Wandtyp für Wangen und Stirn; fehlt ⇒ einschichtig 0.15 m. */
  wallTypeId?: string;
  /** Dachtyp des Gaubendachs; fehlt ⇒ der des Hauptdachs. */
  roofTypeId?: string;
};

/** Gaubenart ([G5]). */
export type DormerKind = "schlepp" | "sattel" | "flach" | "walm";

/** Ein freies 2D-Zeichenelement auf einer Zeichnungsebene. */
export type Drawing2D = {
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
   * vor der Kategorie-Strichstärke (Linienstile tragen keine Stärke, [110]).
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
   * "layer" erzwingt `LayerCategory.lw`,
   * "object"/`undefined` (Default) = Kategorie-Strichstärke.
   */
  strokeWeightSource?: AttributeSource;
  /**
   * Quelle der Schraffur, wenn kein explizites `hatchId` gesetzt ist: "layer"
   * erzwingt `LayerCategory.hatch`, "object"/`undefined` (Default) = heutiges
   * Verhalten (ohne `hatchId` keine Schraffur).
   */
  hatchSource?: AttributeSource;
};

/** Geometrie eines 2D-Zeichenelements (Tag `shape`). */
export type Drawing2DGeom =
  | { shape: "line"; a: Vec2; b: Vec2 }
  | { shape: "xline"; a: Vec2; b: Vec2 }
  | { shape: "ray"; a: Vec2; b: Vec2 }
  | {
    shape: "polyline";
    pts: Array<Vec2>;
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
    bulge?: Array<number>;
  }
  | { shape: "rect"; min: Vec2; max: Vec2 }
  | { shape: "circle"; center: Vec2; r: number }
  | { shape: "arc"; center: Vec2; r: number; a0: number; a1: number }
  | { shape: "ellipse"; center: Vec2; rx: number; ry: number; rotation: number }
  | { shape: "bezier"; pts: Array<Vec2> }
  | { shape: "spline"; pts: Array<Vec2>; closed: boolean; mode?: "fit" | "control" }
  | {
    shape: "dimension";
    pts: Array<Vec2>;
    offset: number;
    /**
     * Darstellungs-Feinheiten der Bemassung, ALLE optional und in
     * PAPIER-MILLIMETERN — so, wie die Zeichnungsnorm sie angibt
     * („Überstand 2 mm"), also unabhängig vom Massstab. Umgerechnet wird
     * beim Erzeugen des jeweiligen Plans (`model/dimension.ts::mmToModel`);
     * der Plan wird je Ziel — Bildschirm bzw. Layout-Viewport — eigens
     * erzeugt, der Massstab ist dort also bekannt und eindeutig.
     * Fehlt ein Wert, gilt `DIM_DEFAULTS_MM`.
     *
     * Abstand Masshilfslinie → bemessener Punkt (Default 1 mm).
     */
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
    textOffsetsMm?: Array<{ along: number; perp: number }>;
    /**
     * Assoziative Bemassung ([38]): je Punkt (Index wie `pts`) der Bezug auf ein Merkmal eines
     * Elements (`null` = freier Punkt). Der Kern führt `pts` nach jeder Änderung nach
     * (`dim_assoc.rs`); `pts` ist damit immer die zuletzt aufgelöste Lage und der Rückfall,
     * wenn ein Bezug ungültig wird. Fehlt das Feld, ist die Bemassung frei wie bisher.
     */
    refs?: Array<DimRef | null>;
  }
  | {
    shape: "kote";
    at: Vec2;
    value: number;
    kind: "okFertig" | "ukFertig" | "okRoh" | "ukRoh";
    /** Drehung (Radiant); Werkzeug erzeugt bewusst nur 0, s. Ellipse-Muster. */
    rotation: number;
  }
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
  | {
    shape: "scalebar";
    /** Linke untere Ecke des Balkens. */
    at: Vec2;
    /** Länge EINES Segments in ECHTEN Modell-Metern. */
    segmentLength: number;
    /** Anzahl Segmente (abwechselnd gefüllt/leer). */
    segments: number;
  }
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
    leaderBendPoints?: Array<Vec2>;
    /**
     * Text-entlang-Pfad: mind. 2 Stützpunkte, entlang derer der Text (nur
     * `text`, KEIN `doc`/Rich-Formatting — v1 bewusst einstilig) über ein
     * echtes SVG `<textPath>` fliesst. Ist gesetzt, bestimmt der Pfad die
     * Position/Neigung jedes Zeichens; `at`/`angle` werden dann ignoriert
     * (bleiben nur als Fallback für Alt-Konsumenten, die `pathPts` nicht
     * kennen — s. `drawing2d.ts`). Griffe sind dann die Pfadpunkte selbst
     * (wie bei `polyline`), nicht der einzelne Anker.
     */
    pathPts?: Array<Vec2>;
  }
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

export type DrawingLevel = {
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
  linePoints?:[Vec2, Vec2];
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
   * linie waagrecht, Blickrichtung nach oben, s. Kern `plan/underlay.rs`).
   * Fehlt ⇒ keine Unterlage.
   */
  planUnderlayId?: string;
  /**
   * Automatische Höhenkoten (nur Schnitt/Ansicht): je Geschoss OK fertig Boden
   * + oberste Kante, links neben der Zeichnung (`plan/levelMarkers.ts`).
   * Fehlt ⇒ an; `false` ⇒ aus.
   */
  levelMarks?: boolean;
  /**
   * Blatt-Ebene (nur kind "drawing"): gehört zum Layout mit dieser ID und trägt dessen
   * 2D-Zeichnung (Linien, Texte, Bilder …) als gewöhnliche `drawings2d`. Koordinaten = Papier
   * im Massstab 1:1 in Metern, Ursprung oben links am Blatt, Papier-y nach unten = −y
   * (Papier-mm (x, y) ↔ Modell (x/1000, −y/1000)). Nicht im Navigator; nur sichtbar, wenn das
   * Blatt offen ist. Fehlt ⇒ gewöhnliche Ebene.
   */
  layoutId?: string;
  /**
   * Ansichtsbereich ([36], nur Geschoss): Oberkante der Sichtweite über OKFF in Metern. Bauteile,
   * die ganz darüber liegen, entfallen; darunter bis zur Schnitthöhe erscheinen sie als „über
   * Schnitt“ (gestrichelt). Fehlt ⇒ unbegrenzt (heutiges Verhalten).
   */
  viewTop?: number;
  /**
   * Ansichtsbereich ([36], nur Geschoss): Unterkante der Sichtweite über OKFF in Metern (auch
   * negativ). Bauteile ganz darunter entfallen (oder erscheinen gepunktet, s. `viewDepth`).
   * Fehlt ⇒ unbegrenzt.
   */
  viewBottom?: number;
  /**
   * Ansichtsbereich ([36], nur Geschoss): „darunter sichtbar bis“ — Tiefe in Metern unter
   * `viewBottom`, bis zu der Bauteile gepunktet („unter Schnitt“) erscheinen. Fehlt/0 ⇒ keine.
   */
  viewDepth?: number;
  /**
   * Ansichtsvorlage ([34]), mit der diese Ansicht (Geschoss/Schnitt/Ansicht) einmal angewendet
   * oder verknüpft wurde.
   */
  templateId?: string;
  /**
   * `true` ⇒ die Ansicht folgt der Vorlage (Änderungen an der Vorlage wirken); sonst nur einmal angewendet.
   */
  templateLinked?: boolean;
};

/**
 * Art einer Zeichnungsebene.
 *   • "floor"     — Geschoss, trägt Bauteile.
 *   • "section"   — Schnitt (abgeleitete Projektion entlang einer Linie).
 *   • "elevation" — Ansicht (abgeleitete Projektion entlang einer Linie).
 *   • "drawing"   — freie 2D-Zeichnung, nicht an ein Geschoss gebunden.
 */
export type DrawingLevelKind = "floor" | "section" | "elevation" | "drawing";

/**
 * Geometrie-Form eines 2D-Zeichenelements.
 *
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

/** Ein extrudierter Körper: geschlossenes Profil (Modell-Meter) + Höhe. */
export type ExtrudedSolid = {
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
  points: Array<Vec2>;
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
};

/**
 * Ein Türtyp (Türstil) — wiederverwendbares Preset für {@link Opening} mit
 * `kind: "door"`. Bündelt Bauart, Blattausführung und Standardmaße. Werte am
 * einzelnen Element (Breite/Höhe/Anschlag) übersteuern die Typ-Defaults.
 *
 * Eckverbindung von Rahmenprofilen (s. `WindowType.frameCornerJoin`).
 */
export type FrameCornerJoin = "vertikal" | "horizontal" | "gehrung";

/**
 * Rahmen-Detail eines Fenster-/Türtyps ([105]); an der Öffnung feldweise übersteuerbar
 * (`Opening.frameDetail`). Alle Masse in Metern, fehlend ⇒ Typ-Wert bzw. bisheriges Verhalten.
 */
export type FrameDetail = {
  /** Blendrahmen: Ansichtsbreite je Seite (fehlt ⇒ `frameWidth`). */
  frameSides?: OpeningSides;
  /** Blendrahmen-Tiefe quer zur Wand (übersteuert `frameDepth`). */
  frameDepth?: number;
  /**
   * Lage: Abstand der Rahmen-Vorderkante von der Fläche `insetFace` (übersteuert `insetFromFace`).
   */
  insetFromFace?: number;
  /** Bezugsfläche der Lage (übersteuert `insetFace`). */
  insetFace?: "aussen" | "innen" | "mitte";
  /** Flügelrahmen: Ansichtsbreite (fehlt ⇒ wie Blendrahmen). */
  sashWidth?: number;
  /** Flügelrahmen: Tiefe quer zur Wand (fehlt ⇒ Blendrahmen-Tiefe). */
  sashDepth?: number;
  /** Flügel-Überschlag: so weit überdeckt der Flügel den Blendrahmen (fehlt ⇒ 0). */
  sashOverlap?: number;
  /** Pfosten (senkrechte Teilung): Breite (fehlt ⇒ `postWidth` der Flügeltabelle). */
  mullionWidth?: number;
  /** Pfosten-Tiefe (fehlt ⇒ Blendrahmen-Tiefe). */
  mullionDepth?: number;
  /** Kämpfer (waagrechte Teilung, Riegel): Breite (fehlt ⇒ wie Blendrahmen). */
  transomWidth?: number;
  /** Kämpfer-Tiefe (fehlt ⇒ Blendrahmen-Tiefe). */
  transomDepth?: number;
  /** Verbreiterungsprofile je Seite (Ansichtsbreite, aussen am Blendrahmen angesetzt). */
  extensionProfiles?: OpeningSides;
  /** Fensterbank-Anschlussprofil unten (Höhe, unter dem Blendrahmen). */
  sillProfile?: number;
  /** Storen-/Rollladen-Anschlussprofil oben (Höhe, über dem Blendrahmen). */
  shadingProfile?: number;
  /** Anschlag je Seite (Meter; übersteuert `rebateDepth`, 0 = kein Anschlag auf dieser Seite). */
  rebates?: OpeningSides;
};

/**
 * Raster-Regel: generiert Wände entlang gleichmäßiger X-/Y-Achsen.
 * Typischer Anwendungsfall: Tragwerks-Achsraster (z. B. 3 m Abstand).
 *
 * Ablauf (Engine):
 *   1. Rasterachsen aus `spacing` oder (später) verlinkter Grid-Ressource.
 *   2. Je Achse eine Wand von Rand zu Rand (begrenzt durch `boundaryId`).
 *   3. Wandtyp, Referenzlinie und Höhe gemäß Regelfelder.
 */
export type GridRule = {
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
};

/**
 * Gruppe (Vectorworks-artig) — reine Mitgliedschaft je Elementart, siehe
 * {@link Project.groups}. Alle ID-Listen sind additiv; ein Element gehört
 * NIE zu mehr als einer Gruppe auf derselben Ebene (das Werkzeug/der Befehl
 * stellt das beim Gruppieren sicher, nicht das Modell selbst).
 */
export type Group = {
  id: string;
  name?: string;
  wallIds: Array<string>;
  drawingIds: Array<string>;
  ceilingIds: Array<string>;
  roomIds: Array<string>;
  stairIds: Array<string>;
  columnIds: Array<string>;
  roofIds: Array<string>;
  openingIds: Array<string>;
  /** Verschachtelte Gruppen (diese Gruppe enthält andere Gruppen als Ganzes). */
  groupIds: Array<string>;
};

/** Mögliche Schraffur-Muster im Plan/Schnitt. */
export type HatchPattern =
  | "none"
  | "solid"
  | "insulation"
  | "diagonal"
  | "crosshatch"
  | "custom"
  | "insulationHard"
  | "insulationWave"
  | "timber"
  | "earth"
  | "gravel"
  | "stone"
  | "dots";

/** Eine wiederverwendbare Schraffur (Hatch Manager). */
export type HatchStyle = {
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
  /** Optionaler Linienstil für die Musterlinien (Line Manager): nur Muster/Farbe. */
  lineStyleId?: string;
  /** Strichstärke der Musterlinien in Papier-mm ([110]); fehlt sie, gilt 0.13. */
  lineWeight?: number;
  /**
   * Steuer-Parameter der Random-Vektor-Schraffur (`kind`/"vector" + `lines`===
   * "random", z. B. Kies/Splitt). ALLE additiv & optional — fehlen sie, gilt das
   * bestehende deterministische Streu-Verhalten (Seed aus der Flächen-Bounding-Box,
   * Dichte/Länge aus `scale`). Die Streuung bleibt bei gleichem `seed` + gleicher
   * Fläche reproduzierbar über ALLE Renderpfade (single render truth); KEIN
   * `Math.random()` zur Renderzeit.
   *
   * Expliziter Streu-Seed. Wird in den Flächen-Seed eingemischt; „Neu würfeln" setzt einen neuen Wert.
   */
  seed?: number;
  /** Streudichte als Multiplikator auf den Grundabstand (Default 1; >1 = dichter). */
  density?: number;
  /**
   * Minimale Strichlänge in mm (Papier). Fehlt es, greift die `scale`-abhängige Default-Länge.
   */
  lengthMin?: number;
  /**
   * Maximale Strichlänge in mm (Papier). Fehlt es, greift die `scale`-abhängige Default-Länge.
   */
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
  motif?: { points: Array<Vec2>; length: number };
};

/**
 * Ein importiertes Dreiecks-Mesh (z. B. aus DXF 3DFACE/POLYFACE/MESH). Rohe
 * BufferGeometry-Daten: `positions` = flaches Array (x,y,z, x,y,z, …) in Metern,
 * `indices` = Dreiecks-Indizes (je 3 ein Dreieck). Keine three-Objekte.
 */
export type ImportedMesh = {
  type: "importedMesh";
  id: string;
  name: string;
  /** Ursprünglicher DXF-Layer-Name (für spätere Kategorisierung). */
  layer?: string;
  /**
   * Grafik-Kategorie-Code (s. {@link LayerCategory}, `model/contextCategories.ts`)
   * — steuert Sichtbarkeit/Grau/Sperren wie bei jedem anderen Bauteil (Ebenen-
   * Panel). Fehlt er (ältere Importe vor dieser Erweiterung), bleibt das Objekt
   * IMMER sichtbar (Rückwärtskompatibilität), s. `plan/context.rs` im Kern.
   */
  categoryCode?: string;
  /**
   * Farbe aus der Quelldatei (`#rrggbb`, z. B. IFC-Oberflächenstil/Material); fehlt sie, gilt die Kontext-Grundfarbe.
   */
  color?: string;
  /** IFC-GlobalId des Quell-Bauteils (IFC-Import je Bauteil). */
  ifcGlobalId?: string;
  positions: Array<number>;
  indices: Array<number>;
};

/** Eine Schicht eines mehrschichtigen Bauteils. */
export type Layer = {
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
  /** Strichstärke der Schichtfuge in Papier-mm ([110]); fehlt sie, gilt die Standard-Fuge. */
  jointWeightMm?: number;
};

/**
 * Eine Ebene (LayerCategory) — ein Knoten im Grafik-Kategorie-Baum. Das
 * Schema gilt geschossübergreifend; Elemente verweisen über `code` darauf.
 */
export type LayerCategory = {
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
  children?: Array<LayerCategory>;
};

/**
 * Schichteinzug einer Wandschicht an der Öffnung ([106]): Regel für alle Seiten, je Seite
 * übersteuerbar. `layer` zählt ab aussen (0 = äusserste Schicht); negativ ab innen (−1 = innerste),
 * damit dieselbe Regel für verschiedene Wandtypen gilt.
 */
export type LayerReveal = {
  layer: number;
  mode: RevealMode;
  amount?: number;
  left?: RevealSide;
  right?: RevealSide;
  top?: RevealSide;
  bottom?: RevealSide;
};

/**
 * Ein Layout-Blatt — Papierformat/Ausrichtung, optionaler Master (`masterId`)
 * und die platzierten Viewports.
 */
export type Layout = {
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
  /**
   * Die 2D-Zeichnung auf dem Blatt liegt auf der Blatt-Ebene ({@link DrawingLevel.layoutId}),
   * nicht im Layout (bis Format 2: `annotations`, s. `project_format::migrate_layout_annotations`).
   */
  viewports: Array<LayoutViewport>;
  /**
   * Revisionsindex des Blatts (z. B. "A", "B" oder "2"); steht im Titelblock, wird beim
   * Publizieren eines Satzes optional hochgezählt ([79]).
   */
  revision?: string;
  /** Grafische Legenden auf dem Blatt ([82]). */
  legends?: Array<LayoutLegend>;
};

/**
 * Ein Ordner im Layouts-Baum (DOSSIER A3). Layouts verweisen per `folderId` auf
 * ihren Ordner; `parentId` erlaubt Verschachtelung (Ordner in Ordner). Fehlt
 * `parentId`, liegt der Ordner auf der Wurzelebene. Masterlayouts liegen NICHT
 * in Ordnern (sie sind Vorlagen). Additiv — Alt-Projekte laden unverändert.
 */
export type LayoutFolder = {
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
};

/**
 * Grafische Legende auf einem Layout-Blatt ([82]): listet Schraffuren/Materialien, Linientypen und/oder
 * Kategorien der gezeigten Viewports (`manualKeys` leer) oder einer Handauswahl, mit Muster und Name.
 */
export type LayoutLegend = {
  id: string;
  /** Linke Kante auf dem Blatt (mm). */
  xMm: number;
  /** Obere Kante auf dem Blatt (mm). */
  yMm: number;
  /** Titel; fehlt = „Legende". */
  title?: string;
  /** Gezeigte Arten: "hatch", "lineType", "category"; fehlt = nur Schraffuren. */
  kinds?: Array<string>;
  /**
   * Handauswahl als Schlüssel "hatch:<id>", "lineType:<id>", "category:<code>"; leer/fehlt = automatisch
   * aus den Viewports des Blatts.
   */
  manualKeys?: Array<string>;
};

/** Ausrichtung eines Layout-Blatts. */
export type LayoutOrientation = "portrait" | "landscape";

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

/**
 * Einfache Textfelder des Titelblocks (Master). Alle optional — leere Felder
 * werden beim Auflösen aus dem Projekt/Layout mit sinnvollen Defaults gefüllt
 * (Projektname ← `Project.name`, Blattname ← `Layout.name`, Datum ← heute).
 */
export type LayoutTitleBlock = { projectName?: string; sheetName?: string; scale?: string; date?: string; author?: string };

/**
 * Ein platzierter Viewport auf einem Layout-Blatt — Position/Grösse in Papier-mm,
 * gebunden an einen Ausschnitt (`snapshotId`). `scaleDenominator` übersteuert
 * optional den Massstab des Ausschnitts (Massstab pro Viewport).
 */
export type LayoutViewport = {
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
};

/** Ein wiederverwendbarer Linienstil (Line Manager). */
export type LineStyle = {
  id: string;
  name: string;
  /**
   * @deprecated Nur noch für die Migration alter Dateien gelesen ([110], Format 4): Ein Linienstil
   * legt nur das Muster (Volllinie, Strich, Punkt, Zickzack …) und die Farbe fest — die Strichstärke
   * kommt vom Element (`Drawing2D.weightMm`), der Schraffur (`HatchStyle.lineWeight`), der
   * Schichtfuge (`Layer.jointWeightMm`) bzw. Ebene/Stift. Die Migration trägt das alte Gewicht dort
   * ein und entfernt es hier; die Renderer werten es nicht mehr aus.
   */
  weight?: number;
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
  dash: Array<number> | null;
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
  motif?: { points: Array<Vec2>; length: number };
};

/** Optionale Farb-/Strichstärke-Übersteuerung einer Linien-Kategorie im Grundriss. */
export type LineStyleOverride = {
  /** Strichfarbe (Hex); fehlt ⇒ System-Default. */
  color?: string;
  /** Strichstärke in mm Papier; fehlt ⇒ System-Default (Haarlinie). */
  weight?: number;
};

/** Zeichen-Marks eines Runs. Alle optional; fehlend = „nicht gesetzt". */
export type Marks = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Hochgestellt. super und sub schliessen sich gegenseitig aus. */
  super?: boolean;
  /** Tiefgestellt. */
  sub?: boolean;
  /** Schriftfamilie (CSS font-family-Wert), z. B. "Helvetica". */
  font?: string;
  /** Schriftgrösse in typografischen Punkt (pt). */
  sizePt?: number;
  /** Farbe als "#rrggbb". */
  color?: string;
};

/**
 * Masterlayout — gemeinsame Blatt-Elemente (Titelblock + optionaler Rahmen), die
 * einzelne {@link Layout}s per `masterId` erben. Eine Änderung am Master schlägt
 * auf alle Layouts durch, die ihn referenzieren (InDesign-/ArchiCAD-Muster).
 */
export type MasterLayout = {
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
};

/**
 * Modul-Regel: teilt eine Referenzspanne in proportionale Felder auf.
 * Typischer Anwendungsfall: Tragwerks-Joche (z. B. 6 m-Module in einem Bauteil).
 *
 * Ablauf (Engine):
 *   1. Gesamtspanne aus `referenceWallId` oder Geschossausdehnung ableiten.
 *   2. In Module der Größe `moduleSize` unterteilen.
 *   3. Querwände an jedem Modulteilungspunkt setzen.
 */
export type ModuleRule = {
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
};

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
export type Opening = {
  id: string;
  type: "opening";
  /** Wirts-Wand; das Geschoss ergibt sich aus der Wand. */
  hostWallId: string;
  /** Grafik-Kategorie (Ebene), z. B. "21" für Türen/Fenster. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /** Bauteilnummer (Fenster-/Türliste); leer = automatisch je Geschoss nummeriert. */
  mark?: string;
  /** Feuerwiderstand (z. B. "EI30", "EI60"); Türliste, IFC `FireRating`. */
  fireRating?: string;
  /** Schallschutz (z. B. "Rw 32 dB"); IFC `AcousticRating`. */
  soundClass?: string;
  /** Wärmedurchgang U in W/(m²K); IFC `ThermalTransmittance`. */
  uValue?: number;
  /** Einbruchhemmung (z. B. "RC2"); IFC `SecurityRating`. */
  burglaryClass?: string;
  /** Bemerkung (Fenster-/Türliste). */
  notes?: string;
  /** Aussen (true) / innen (false); fehlt = aus der Wand und den Räumen abgeleitet. */
  isExternal?: boolean;
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
  /**
   * Umriss der Öffnung in der Wandebene ([G3]); fehlt ⇒ Rechteck. Bestimmt den Wandausschnitt
   * (Schnitt, Ansicht, 3D, IFC-Öffnungskörper); der Grundriss bleibt beim SIA-Symbol. Die
   * Öffnung füllt ihr Rechteck `width × height`; Bogen/Schräge liegen oben (Rund: Ellipse darin).
   */
  shape?: "rechteck" | "rundbogen" | "segmentbogen" | "spitzbogen" | "rund" | "schraeg" | "giebel";
  /**
   * Stichhöhe der Form in Metern ([G3]): Segmentbogen = Bogenstich (Default Breite/6), Spitzbogen =
   * Höhe über dem Kämpfer (≥ Breite/2, Default gleichseitig), Giebel = Höhe des Dreiecks (Default
   * Breite/2), Schräg = Höhenunterschied links→rechts (> 0 rechts höher, Default Breite/2).
   * Rundbogen/Rund/Rechteck ignorieren es.
   */
  shapeRise?: number;
  /**
   * Wirt Dach ([103], Dachfenster): Öffnung in einer Dachfläche; `hostWallId` bleibt leer. Lage
   * über {@link hostPoint}; `width` quer zum Gefälle, `height` entlang des Gefälles (in der
   * Dachebene gemessen); `position`/`sillHeight` gelten nicht.
   */
  hostRoofId?: string;
  /**
   * Wirt Decke ([103], Deckenöffnung mit Oberlicht): Öffnung in einer Decke, Lage über
   * {@link hostPoint}, `width` × `height` waagrecht (gedreht um {@link hostAngle}).
   */
  hostCeilingId?: string;
  /** Nur Dach-/Deckenwirt ([103]): Mittelpunkt der Öffnung im Grundriss (Meter). */
  hostPoint?: Vec2;
  /**
   * Nur Dach-/Deckenwirt ([103]): Drehung der Breitenrichtung im Grundriss in Grad, wo die
   * Fläche waagrecht ist (Decke, Flachdach); geneigte Dachflächen richten die Breite längs der
   * Traufe aus. Fehlt ⇒ 0 (x-Achse).
   */
  hostAngle?: number;
  /**
   * Wirt Gaube ([G5]): Fenster in der Stirnwand der Gaube `hostDormerId` des Dachs `hostRoofId`.
   * `position` = Versatz der Fenstermitte von der Stirnmitte (Meter, + nach rechts von aussen),
   * `sillHeight` = Brüstung über der Dach-Oberkante an der Stirn.
   */
  hostDormerId?: string;
  /** Übersteuert das Rahmen-Detail des Typs feldweise für diese Öffnung ([105]). */
  frameDetail?: FrameDetail;
  /** Ersetzt den Schichteinzug des Typs für diese Öffnung ([106]). */
  layerReveals?: Array<LayerReveal>;
  /** Übersteuert die Rahmenart des Türtyps ([105]). */
  doorFrameKind?: "zarge" | "blockrahmen" | "blendrahmen" | "umfassungszarge" | "eckzarge" | "blockzarge" | "futter";
  /** Übersteuert die Zargen-/Rahmenmasse des Türtyps feldweise ([105]). */
  doorFrame?: DoorFrameDetail;
};

/**
 * Ein Fenstertyp (Fensterstil) — wiederverwendbares Preset für {@link Opening}
 * mit `kind: "window"`. Bündelt Öffnungsart, Flügelzahl, Verglasung und
 * Standardmaße inkl. Brüstungshöhe.
 *
 * Öffnungsart eines einzelnen Flügels (bzw. des ganzen Fensters, alt).
 */
export type OpeningKind = "dreh" | "kipp" | "drehkipp" | "fest" | "schiebe";

/**
 * Werte je Seite einer Öffnung (Meter). `left` = Leibung beim Wandanfang (kleineres Achsmass),
 * `right` = beim Wandende, `top` = Sturz, `bottom` = Brüstung/Schwelle. Fehlt ⇒ Rückfallwert.
 */
export type OpeningSides = { left?: number; right?: number; top?: number; bottom?: number };

/**
 * Aktionen einer Override-Regel — jede optional (Teilaktionen sind erlaubt;
 * fehlende Felder lassen die reguläre Auflösung unberührt).
 */
export type OverrideActions = {
  /** Strich-/Umrandungsfarbe (hex). */
  color?: string;
  /** Strichstärke in mm Papier. */
  lineweight?: number;
  /** Linienstil (Line Manager) — wirkt, wo Elemente einen LineStyle tragen (Drawing2D). */
  linetypeId?: string;
};

/** Bedingung einer Override-Regel. */
export type OverrideCondition = {
  type: OverrideConditionType;
  operator: OverrideOperator;
  /** Vergleichswert (Freitext, case-insensitiv verglichen). */
  value: string;
};

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
export type OverrideOperator = "equals" | "contains" | "starts_with" | "not_equals";

/**
 * Eine grafische Override-Regel. Lebt in `Project.overrideRules` (Reihenfolge
 * = Priorität, oben gewinnt) und ist einzeln aktivier-/deaktivierbar.
 */
export type OverrideRule = {
  id: string;
  name: string;
  /** Deaktivierte Regeln werden bei der Auswertung übersprungen. */
  enabled: boolean;
  condition: OverrideCondition;
  actions: OverrideActions;
};

/** Ein Absatz: eine Zeile aus Runs plus optionale Ausrichtung/Zeilenhöhe. */
export type Paragraph = {
  runs: Array<TextRun>;
  align?: Align;
  /** Zeilenhöhe als Vielfaches der Basisgrösse (z. B. 1.3 = 130 %). */
  lineHeight?: number;
};

/** Parametrische Wandregel (Tag `type`). */
export type ParametricRule =
  | GridRule
  | ModuleRule
  | ConditionalThicknessRule
  | ReferenceLineRule
  | SequenceRule;

/**
 * Eine parametrische Wand-Regel — generiert automatisch Wall[]-Einträge für
 * ein gegebenes Geschoss. Lebt in der Ressourcen-Bibliothek des Projekts.
 * Wird über `resolveParametricWall()` aufgelöst, nicht zur Laufzeit gespeichert.
 */
export type ParametricWall = {
  id: string;
  /** Anzeigename, z. B. „Wohnbau-Raster 3m". */
  name: string;
  /** Optionale Beschreibung (für den Ressourcen-Manager). */
  description?: string;
  /**
   * Geordnete Liste der anzuwendenden Regeln. Spätere Regeln können die
   * Ausgabe früherer Regeln verfeinern (z. B. Dickenzuweisung nach Raster).
   */
  rules: Array<ParametricRule>;
  /**
   * Rückfall-Wandtyp, falls eine Regel keinen eigenen `wallTypeId` nennt.
   * Muss auf einen gültigen WallType im Projekt verweisen.
   */
  defaultWallTypeId: string;
};

export type PenSet = {
  id: string;
  name: string;
  /** Stift-ID (`ColorPen.id`) → Farbe+Strichstärke. */
  pens: { [key in string]: PenStyle };
};

/**
 * Ein Stiftsatz — ordnet JEDEM Stift (`ColorPen.id`) eine konkrete Farbe zu.
 * Mehrere Stiftsätze können nebeneinander existieren (z. B. „Standard",
 * „Plot S/W", „Präsentation"); nur einer ist je Projekt AKTIV
 * (`Project.activePenSetId`). Fehlt ein Stift im `colors`-Objekt (z. B. neu
 * angelegt, aber in diesem Satz noch nicht befüllt), gilt `PEN_FALLBACK_COLOR`
 * (s. `model/penSets.ts`).
 *
 * Farbe + Strichstärke EINES Stifts in EINEM Stiftsatz — wie ein echter
 * ArchiCAD-/AutoCAD-Stift wandern beide zusammen, wenn ein Element/eine Ebene
 * auf diesen Stift gestellt wird (s. `Component.colorPenId`-Doku).
 */
export type PenStyle = {
  color: string;
  /** Strichstärke in Millimetern. */
  weight: number;
};

export type Project = {
  /** Dateiformat-Version (s. `io/projectFormat.ts`); wird beim Speichern gesetzt. */
  formatVersion?: number;
  id: string;
  name: string;
  /** Linienstil-Bibliothek (Line Manager). */
  lineStyles: Array<LineStyle>;
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
  textStyles?: Array<TextStylePreset>;
  /** Schraffur-Bibliothek (Hatch Manager). */
  hatches: Array<HatchStyle>;
  /** Bauteil-Material-Bibliothek (Component Manager). */
  components: Array<Component>;
  wallTypes: Array<WallType>;
  /**
   * Deckentypen (Deckenstile) — dediziert für Decken, analog `wallTypes`.
   * Optional, damit bestehende Projekte/Tests ohne `ceilingTypes` gültig
   * bleiben; Decken ohne `ceilingTypeId` lösen weiterhin über das LEGACY-Feld
   * `Ceiling.wallTypeId` gegen `wallTypes` auf (siehe `getCeilingType`).
   */
  ceilingTypes?: Array<CeilingType>;
  /**
   * Dachtypen (Dachaufbauten) — mehrschichtig, analog `ceilingTypes`. Optional;
   * Dächer ohne `roofTypeId` lösen über die einschichtige `Roof.thickness` auf.
   */
  roofTypes?: Array<RoofType>;
  /**
   * Wiederverwendbare 2D-Symbol-Bibliothek (Möbelblöcke, Sanitär-/Norm-
   * symbole u. Ä.) — analog `wallTypes`: einmal definieren, beliebig oft als
   * `{shape:"block"}`-Instanz platzieren. V1 bewusst NUR 2D (kein 3D-Körper,
   * keine verschachtelten Blöcke). Optional, damit bestehende Projekte ohne
   * `blockDefs` gültig bleiben.
   */
  blockDefs?: Array<BlockDef>;
  /**
   * Türtypen-Bibliothek (Türstile), analog `wallTypes`. Optional, damit
   * bestehende Projekte/Tests ohne `doorTypes` gültig bleiben; Türen ohne
   * `typeId` verhalten sich wie bisher (Inline-Felder).
   */
  doorTypes?: Array<DoorType>;
  /** Fenstertypen-Bibliothek (Fensterstile). Optional (siehe `doorTypes`). */
  windowTypes?: Array<WindowType>;
  /** Treppentypen-Bibliothek (Treppenstile). Optional (siehe `doorTypes`). */
  stairTypes?: Array<StairType>;
  /**
   * Stift-Bibliothek (ArchiCAD-Stiftsatz-Muster, s. {@link ColorPen}):
   * projektweite Liste der Stift-IDs/-Namen. Optional, damit bestehende
   * Projekte/Tests ohne Stifte gültig bleiben.
   */
  pens?: Array<ColorPen>;
  /**
   * Stiftsätze (s. {@link PenSet}) — je einer eine vollständige Stift→Farbe-
   * Zuordnung. Optional (siehe `pens`).
   */
  penSets?: Array<PenSet>;
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
  customPalettes?: Array<CustomPalette>;
  /**
   * Welche MITGELIEFERTEN Paletten-Bänke im Farbwahl-Popover erscheinen
   * (s. {@link BuiltinPaletteBanks}). Fehlt das Objekt, sind alle sichtbar.
   */
  builtinPaletteBanks?: BuiltinPaletteBanks;
  /** Oberste Schnitte: Geschosse + Schnitte/Ansichten. */
  drawingLevels: Array<DrawingLevel>;
  /** Raumprogramm (Soll) für die Prüfung gegen das Modell. */
  roomProgram?: Array<RoomProgramRow>;
  /**
   * Toleranz der Soll/Ist-Ampel des Raumprogramms als Anteil der Soll-Fläche (Default 0.05 = ±5 %).
   */
  roomProgramTolerance?: number;
  /** Parzellenfläche (m²) für Ausnützungs- und Überbauungsziffer. */
  parcelArea?: number;
  /** Schattenstudie: Zeitpunkt (ISO 8601, UTC) und ob der Boden-Schatten im Grundriss erscheint. */
  sunStudy?: SunStudy;
  /**
   * Baurecht der Parzelle: Grenze, Grenzabstände, Baulinien, Gesamthöhe (`analysis/siteRules.ts`).
   */
  siteRules?: SiteRules;
  /**
   * Strichstärken im Grundriss mit dem Massstab skalieren, (100/n)^0.25 (`plan/lineWeightScale.ts`).
   */
  scaleLineWeights?: boolean;
  /** Grafik-Kategorie-Baum (geschossübergreifend). */
  layers: Array<LayerCategory>;
  walls: Array<Wall>;
  /**
   * Decken (Slabs) — geschossgebundene Flächenbauteile mit geschlossenem Umriss.
   * Optional, damit bestehende Projekte/Tests ohne `ceilings` gültig bleiben
   * (Default: leer behandeln).
   */
  ceilings?: Array<Ceiling>;
  /** Dächer über (rechteckigen) Grundriss-Umrissen. Optional (Alt-Projekte). */
  roofs?: Array<Roof>;
  /**
   * Öffnungen (Fenster/Türen), gehostet in Wänden. Optional, damit bestehende
   * Projekte/Tests ohne `openings` gültig bleiben (Default: leer behandeln).
   */
  openings?: Array<Opening>;
  /**
   * Treppen (Treppe) — geschossübergreifende Bauteile (gerade/L/Wendel). Optional,
   * damit bestehende Projekte/Tests ohne `stairs` gültig bleiben (Default: leer).
   */
  stairs?: Array<Stair>;
  /**
   * Räume (SIA-416-Flächen) — geschossgebundene Flächen mit geschlossenem Umriss.
   * Optional, damit bestehende Projekte/Tests ohne `rooms` gültig bleiben
   * (Default: leer behandeln).
   */
  rooms?: Array<Room>;
  /** Freie 2D-Zeichengeometrie (Line/Polyline/Rect/Circle/Arc/Text). */
  drawings2d: Array<Drawing2D>;
  /**
   * Kontext-Schicht: importierte/abgeleitete „dumme" Geometrie (Meshes,
   * Konturen, Gelände-TIN) — NICHT semantisch. Optional, damit bestehende
   * Projekte/Tests ohne `context` gültig bleiben (Default: leer behandeln).
   */
  context?: Array<ContextObject>;
  /**
   * Extrudierte Körper (truck-Integration) — geschlossene 2D-Profile mit Höhe,
   * siehe {@link ExtrudedSolid}. Optional, damit bestehende Projekte/Tests ohne
   * `extrudedSolids` gültig bleiben (Default: leer behandeln).
   */
  extrudedSolids?: Array<ExtrudedSolid>;
  /**
   * Stützen (Columns) — geschossgebundene Tragwerk-Bauteile (platzierte
   * Profil-Extrusionen), siehe {@link Column}. Optional, damit bestehende
   * Projekte/Tests ohne `columns` gültig bleiben (Default: leer behandeln).
   */
  columns?: Array<Column>;
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
  groups?: Array<Group>;
  /**
   * Bibliothek parametrischer Wand-Regelwerke. Optional, damit bestehende
   * Projekte ohne `parametricWalls` gültig bleiben (Default: leer behandeln).
   * Wird durch `resolveParametricWall()` in `src/model/parametricWalls.ts`
   * aufgelöst — generiert Wall[]-Objekte bei Bedarf.
   */
  parametricWalls?: Array<ParametricWall>;
  /**
   * Grafische Override-Regeln (Regel-Engine, Reihenfolge = Priorität, oben
   * gewinnt) — reines Rendering-Overlay, siehe {@link OverrideRule}. Optional,
   * damit bestehende Projekte/Tests ohne `overrideRules` gültig bleiben
   * (Default: leer behandeln).
   */
  overrideRules?: Array<OverrideRule>;
  /**
   * Ausschnitte / View-Snapshots (DOSSIER A2) — benannte, wiederherstellbare
   * Ansichten (siehe {@link ViewSnapshot}). Optional, damit bestehende
   * Projekte/Tests ohne `viewSnapshots` unverändert gültig bleiben (Default:
   * leer behandeln). Gehört ins Dokument (nicht localStorage).
   */
  viewSnapshots?: Array<ViewSnapshot>;
  /**
   * Ordner des Ausschnitte-Baums (DOSSIER A2) — Gruppierung der
   * {@link ViewSnapshot}s per `folderId`. Optional, damit bestehende
   * Projekte/Tests ohne `viewSnapshotFolders` gültig bleiben (Default: leer →
   * alle Ausschnitte auf Wurzelebene).
   */
  viewSnapshotFolders?: Array<ViewSnapshotFolder>;
  /** Ansichtsvorlagen ([34]). Optional: Alt-Projekte ohne Feld bleiben gültig. */
  viewTemplates?: Array<ViewTemplate>;
  /**
   * Layout-Blätter (DOSSIER A3) — Druck-/Plan-Blätter mit platzierten Viewports
   * (siehe {@link Layout}). Optional, damit bestehende Projekte/Tests ohne
   * `layouts` gültig bleiben (Default: leer behandeln). Gehört ins Dokument.
   */
  layouts?: Array<Layout>;
  /**
   * Masterlayouts (DOSSIER A3) — gemeinsame Blatt-Elemente (Titelblock/Rahmen),
   * die einzelne {@link Layout}s erben (siehe {@link MasterLayout}). Optional,
   * damit bestehende Projekte/Tests ohne `masterLayouts` gültig bleiben.
   */
  masterLayouts?: Array<MasterLayout>;
  /**
   * Ordner des Layouts-Baums (DOSSIER A3) — Gruppierung der {@link Layout}s per
   * `folderId`. Optional, damit bestehende Projekte/Tests ohne `layoutFolders`
   * gültig bleiben (Default: leer → alle Layouts auf Wurzelebene).
   */
  layoutFolders?: Array<LayoutFolder>;
  /** Publikationssätze ([79]). */
  publishSets?: Array<PublishSet>;
  /** Publikationsprotokoll ([79]), neueste zuletzt. */
  publishLog?: Array<PublishLogEntry>;
  /** Projektnummer für Titelblock und Dateinamen ([79]). */
  projectNumber?: string;
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
};

/** Protokolleintrag einer Publikation ([79]): Datum, Blätter mit Revision, erzeugte Dateien. */
export type PublishLogEntry = {
  id: string;
  setId: string;
  setName: string;
  /** ISO-Zeitstempel. */
  date: string;
  sheets: Array<PublishLogSheet>;
  files: Array<string>;
};

/** Ein Blatt im Publikationsprotokoll. */
export type PublishLogSheet = { layoutId: string; number: string; name: string; revision: string };

/**
 * Publikationssatz ([79]): benannte Menge von Layouts (und optional Ansichten) mit Ausgabe-Einstellungen.
 */
export type PublishSet = {
  id: string;
  name: string;
  /** Layouts des Satzes in Ausgabe-Reihenfolge. */
  layoutIds: Array<string>;
  /** Gespeicherte Ansichten, die zusätzlich als eigene Seiten ausgegeben werden. */
  snapshotIds?: Array<string>;
  /**
   * "pdf-multi" (ein PDF, Standard), "pdf-single" (je Blatt eine Datei), "dxf" (DXF mit Layouts).
   */
  format?: string;
  /**
   * Dateinamen-Muster mit {Projektnummer} {Projekt} {Blattnummer} {Blattname} {Index} {Datum} {Satz}.
   */
  namePattern?: string;
  /** Papierformat-Übersteuerung für alle Blätter des Satzes. */
  paperOverride?: LayoutPaperFormat;
  /** Massstab-Übersteuerung (1:N) für alle Viewports des Satzes. */
  scaleOverride?: number;
  /** Revisionsindex im Titelblock/Dateinamen ausgeben (Standard ja). */
  includeRevision?: boolean;
  /** Revisionsindex je Blatt beim Publizieren erhöhen (A→B, 1→2). */
  bumpRevision?: boolean;
  /** PDF-Ebenen (Optional Content) je Kategorie. */
  pdfLayers?: boolean;
};

/**
 * Referenzlinien-Regel: setzt die `referenceLine`-Eigenschaft bei passenden
 * Wänden einheitlich (Vectorworks-Stil).
 * Typischer Anwendungsfall: Alle Außenwände auf „left" (linke Fläche = Fassade).
 *
 * Ablauf (Engine):
 *   Bestehende Wände aus `existingWalls` filtern → `referenceLine` setzen.
 *   Gibt modifizierte Kopien zurück.
 */
export type ReferenceLineRule = {
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
};

/** Wie eine Wandschicht an der Öffnung anschliesst ([106]). */
export type RevealMode = "buendig" | "zurueck" | "leibung" | "ueberdaemmt";

/** Abweichende Regel für eine Seite ([106]). */
export type RevealSide = { mode: RevealMode; amount?: number };

/** Das gesamte Rich-Text-Dokument. */
export type RichTextDoc = { version: 1; paragraphs: Array<Paragraph> };

/**
 * Ein Dach über einem (rechteckigen) Grundriss-Umriss. Die Geometrie rechnet auf
 * der Bounding-Box des Umrisses (die gängige, intuitive Vereinfachung — First
 * entlang einer Hauptachse); der Umriss selbst wird beim Zeichnen als Rechteck
 * angelegt. Die Traufhöhe (`baseElevation`) ist die Unterkante der Dachfläche;
 * darüber steigt das Dach je nach Form/Neigung auf.
 */
export type Roof = {
  id: string;
  type: "roof";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "35" für Dächer. */
  categoryCode: string;
  /** Objekt-Sperre, analog `Wall.locked`. */
  locked?: boolean;
  /** Geschlossener Grundriss-Umriss (Meter); Geometrie nutzt die Bounding-Box. */
  outline: Array<Vec2>;
  /**
   * Innenhöfe/Lichthöfe als Ringe (Meter, jeder Ring geschlossen, Drehsinn egal). Das Dach
   * ist an dieser Stelle ausgespart (3D, Grundriss, Schnitt, Ansicht, IFC); die Hofkanten sind
   * innere Traufen. Wirkt bei Flach/Sattel/Walm/Mansarde/Zelt (Pult ignoriert sie); ein Ring,
   * der nicht ganz im Umriss liegt oder sich mit Umriss/anderen Höfen schneidet, macht die
   * Höfe wirkungslos (Dach wie ohne). Fehlt ⇒ keine Höfe.
   */
  holes?: Array<Array<Vec2>>;
  /**
   * Neigung je Umrisskante in Grad. Nummerierung: erst die Kanten von `outline` (Kante i =
   * Punkt i → i+1, in der gespeicherten Reihenfolge), danach die Kanten der `holes` Ring für
   * Ring. Eintrag `null` = Giebel (senkrechte Wand, Kante läuft nicht nach innen), eine Zahl
   * ≥ 0 = Neigung dieser Kante (übersteuert `pitchDeg`), eine NEGATIVE Zahl (oder ein fehlender
   * Eintrag) = Standard: `pitchDeg`, bei Satteldach/Mansard-Satteldach mit Giebel an den
   * Kanten quer zur Firstrichtung. Fehlt das Feld ganz ⇒ alles Standard (wie bisher).
   * Wirkt bei Sattel/Walm/Mansarde/Zelt (Flach/Pult ignorieren es).
   */
  edgePitchDeg?: Array<number | null>;
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
  /**
   * Ansichtsschraffur ([100]): Drehung (Grad) des Oberflächenmusters dieses Elements gegenüber der
   * Ausrichtung am Element (Default 0).
   */
  surfacePatternAngle?: number;
  /**
   * Ansichtsschraffur ([100]): Versatz (m) des Musterursprungs (x entlang, y quer/aufwärts) gegenüber
   * der Elementkante.
   */
  surfacePatternOffset?: Vec2;
  /** Gauben/Lukarnen ([G5]) in den Dachflächen dieses Dachs. Fehlt ⇒ keine. */
  dormers?: Array<Dormer>;
};

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
 * Ein Dachtyp (Dachaufbau) = geordneter Schichtaufbau EINES Daches, senkrecht
 * zur Dachfläche gestapelt (aussen/Eindeckung → innen/Verkleidung) — das
 * geneigte Gegenstück zu `WallType`/`CeilingType`. Nutzt denselben `Layer`-Typ.
 * Typische Folge: Eindeckung (Ziegel/Blech) → Konterlattung/Lattung → Unterdach
 * → Sparren/Dämmung → Dampfbremse → Innenverkleidung. Ein Dach ohne `roofTypeId`
 * fällt auf die einschichtige `Roof.thickness` zurück (rückwärtskompatibel).
 */
export type RoofType = {
  id: string;
  name: string;
  /** Aussen (Eindeckung) → innen (Verkleidung), analog `WallType.layers`. */
  layers: Array<Layer>;
};

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
export type Room = {
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
  boundary: Array<Vec2>;
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
};

/**
 * Eine Zeile des Raumprogramms (Soll): wird gegen die gezeichneten Räume geprüft (`analysis/kennzahlen.ts`).
 */
export type RoomProgramRow = {
  /**
   * Raumname wie im Modell (Vergleich ohne Gross-/Kleinschreibung, Präfix „Wohnen" trifft „Wohnen 2").
   */
  name: string;
  /** SIA-416-Kategorie des Soll-Raums (optional, schärft die Zuordnung). */
  siaCategory?: SiaCategory;
  /** Soll-Fläche je Raum in m². */
  area: number;
  /** Soll-Anzahl (Default 1). */
  count?: number;
  /**
   * Gruppe/Bereich/Geschoss aus dem Programm (z. B. „Wohnen", „EG"): Zwischensummen und Farbe beim Generieren.
   */
  group?: string;
  /** Bemerkung aus dem Programm (reiner Text). */
  note?: string;
};

/**
 * Feldmodell des Raum-Stempels. Ersetzt den freien Text durch benannte Felder;
 * daraus baut roomStamp.ts sowohl das gerenderte Rich-Text-Dokument als auch die
 * Live-Zeilen. Minimal gehalten (MVP).
 *
 * Folge-Arbeit: Fensterfläche (braucht Öffnung-in-Raum-Geometrie) — hier bewusst
 * NICHT enthalten.
 */
export type RoomStamp = {
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
};

/**
 * Ein Eintrag der Flügeleinteilung eines Fensters (VW „Flügeltabelle"): entweder
 * ein Flügel (verglaste, ggf. öffenbare Einheit) oder ein Pfosten (feste vertikale
 * Teilung). Ersetzt/erweitert das grobe {@link WindowType.wingCount}: ist
 * {@link WindowType.sashes} gesetzt, hat es Vorrang; sonst wird die Einteilung aus
 * `wingCount` gleichmäßig abgeleitet (siehe `sashesOfWindowType`).
 */
export type SashDef = {
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
};

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
export type SequenceRule = {
  type: "sequence";
  /** Unterregeln, in Ausführungsreihenfolge. */
  rules: Array<ParametricRule>;
  /**
   * Wenn `true`: Abbruch nach der ersten Unterregel, die mindestens eine Wand
   * generiert/verändert. Ähnlich wie ein Short-Circuit-Fallback.
   */
  stopOnMatch?: boolean;
};

/** Blatt-Kategorien nach SIA 416, die einem Raum direkt zugewiesen werden. */
export type SiaCategory = "HNF" | "NNF" | "VF" | "FF" | "KGF" | "AGF";

/**
 * Eine Zeichnungsebene (DrawingLevel) — eine oberste Schnittebene des
 * Dokuments. Ein Geschoss trägt die Bauteile (über `floorId`); ein
 * Schnitt/Ansicht ist eine abgeleitete Projektion (vorerst Platzhalter); eine
 * reine Zeichnung ist eine freie 2D-Ebene ohne Geschossbezug.
 *
 * Geschoss nutzt floorHeight/cutHeight/baseElevation; Schnitt/Ansicht nutzen
 * linePoints/directionSign; "drawing" nutzt keines dieser Felder.
 *
 * Baurecht einer Parzelle ([63]). Die zulässige Grundfläche ist die Parzelle ohne die Streifen
 * „näher als der Grenzabstand an Kante i", begrenzt durch die Baulinien.
 */
export type SiteRules = {
  /** Parzellengrenze als geschlossener Ring (Modell-Meter, Umlaufsinn beliebig). */
  parcel: Array<Vec2>;
  /**
   * Grenzabstand (m) je Kante i = parcel[i] → parcel[i+1]; fehlende Einträge → `defaultSetback`.
   */
  setbacks?: Array<number>;
  /** Grenzabstand (m) für alle Kanten ohne eigenen Wert. */
  defaultSetback: number;
  /**
   * Baulinien: das Gebäude bleibt auf der Seite der Linie, auf der der Parzellen-Schwerpunkt liegt.
   */
  buildingLines?: Array<{ a: Vec2; b: Vec2 }>;
  /** Zulässige Gesamthöhe über ±0.00 (m). */
  maxHeight?: number;
  /** Parzelle, zulässige Fläche und Verstösse im Grundriss zeigen (Default: ja). */
  show?: boolean;
};

/** Terminierungs-Regel einer Wand am Deckenanschluss (siehe {@link Wall.sliceTermination}). */
export type SliceTermination = "both" | "below" | "above";

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
export type Stair = {
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
  /**
   * Anzahl der Steigungen (Setzstufen). Die Trittanzahl = stepCount (letzte =
   *  Austritt aufs obere Geschoss). Steigungshöhe = totalRise / stepCount.
   */
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
};

/**
 * Grundform einer Treppe (DOSSIER: gerade / L / Wendel).
 *   • "straight" — ein gerader Lauf (Lauflinie = Start → Richtung).
 *   • "L"        — zwei rechtwinklige Läufe mit Zwischenpodest an der Ecke.
 *   • "spiral"   — Wendeltreppe um ein Zentrum (keilförmige Tritte).
 */
export type StairShape = "straight" | "L" | "spiral";

/**
 * Ein Treppentyp (Treppenstil) — wiederverwendbares Preset für {@link Stair}.
 * Bündelt Tragart, Stufenausbildung und Geländer. Geometrische Grundform
 * (gerade/L/Wendel) + Lauflänge/Stufenzahl bleiben am einzelnen Element.
 */
export type StairType = {
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
};

/** Schattenstudie (`analysis/sun.ts`): der Schatten liegt auf dem Geschoss nächst ±0.00. */
export type SunStudy = {
  /** Zeitpunkt als ISO-8601-Text in UTC, z. B. "2026-12-21T11:00:00Z". */
  when: string;
  show: boolean;
};

/**
 * Ansichtsschraffur eines Bauteils ([100]): Muster auf sichtbaren Flächen, im Kern zu Linien gerechnet
 * (`surface_pattern.rs`). Masse in Metern am Bau; Ursprung an der Elementkante (Wandanfang/UK, Traufe).
 */
export type SurfacePattern = {
  kind: "lines" | "boardBatten" | "runningBond" | "shingles" | "trapezoid" | "polygonal" | "grid";
  direction?: "vertical" | "horizontal";
  /** Hauptabstand (m): Linien-/Rippenabstand, Steinlänge, Plattenbreite. */
  spacing: number;
  /** Lagen-/Plattenhöhe (m; Läuferverband, Schindeln, Raster). Fehlt sie, gilt `spacing`. */
  height?: number;
  /** Breite (m) der Deckleiste bzw. des Trapez-Obergurts. */
  width?: number;
  /** Grunddrehung (Grad) zusätzlich zur Richtung. */
  angle?: number;
  /** Strichstärke (Papier-mm); Default 0.1. */
  weightMm?: number;
  /** Linienfarbe; Default Vordergrund des Bauteils bzw. Dunkelgrau. */
  color?: string;
};

/** Schwenkrichtung der Tür relativ zur Wandachse. */
export type SwingSide = "left" | "right";

/**
 * Ein TIN-Geländemodell, abgeleitet aus Konturen (Delaunay über (x,y), Z aus der
 * jeweiligen Kontur-Höhe). `positions` = flaches (x,y,z…)-Array in Metern,
 * `indices` = Dreiecks-Indizes. Gelände ist NICHT semantisch (Kontext-Schicht).
 */
export type TerrainMesh = {
  type: "terrainMesh";
  id: string;
  name: string;
  /** Ebenen-/Gruppierungsname (SitePanel), z. B. „Terrain". Optional. */
  layer?: string;
  /** Grafik-Kategorie-Code, s. {@link ImportedMesh.categoryCode}. */
  categoryCode?: string;
  positions: Array<number>;
  indices: Array<number>;
  /**
   * Optionale Pro-Vertex-Albedo (flach `[r,g,b, …]`, 0..1) — ein Wert je
   * Positions-Vertex, beim Import aus einem SWISSIMAGE-Luftbild gesampelt
   * („Luftbild aufs Gelände drapieren"). render3d färbt das TIN dann pro Vertex
   * statt mit der Grundfarbe. Fehlt es, bleibt das Gelände einfarbig.
   */
  vertexColors?: Array<number>;
};

/** Ein zusammenhängender Textabschnitt mit einheitlicher Formatierung. */
export type TextRun = { text: string; marks: Marks };

/** Ein benannter Stil (Marks-Vorlage), z. B. „Titel". */
export type TextStylePreset = {
  /** Stabiler Schlüssel (englisch), z. B. "title". */
  id: string;
  /** Anzeigename (bereits übersetzt oder Schlüssel für t()). */
  label: string;
  /** Marks, die der Stil auf die Auswahl (oder das ganze Dokument) legt. */
  marks: Marks;
};

export type Vec2 = { x: number; y: number };

/**
 * Vertikale Bindung einer Wandkante (UK/OK).
 *   • "floor"  — an ein Geschoss gebunden: Z = baseElevation des Geschosses
 *     (+ optionalem `offset`). Stapelt automatisch mit dem Geschoss.
 *   • "custom" — fester absoluter Z-Wert (Meter).
 */
export type VerticalAnchor =
  | { mode: "floor"; floorId: string; offset?: number }
  | { mode: "custom"; z: number };

/**
 * Kanonischer Blickwinkel der 3D-Ansicht (Vectorworks/DOSSIER-Stil). „front"/
 * „back"/„side"/„left" springen auf die vier Kardinalrichtungen (Vorne/Hinten/
 * Rechts/Links — KEINE Himmelsrichtungs-Labels, da es noch keinen Nordwinkel
 * gibt); „top" auf die Draufsicht. „iso"/„isoFrontLeft"/„isoBackRight"/
 * „isoBackLeft" sind die vier oberen Iso-Oktanten (untere vier bleiben im
 * Hochbau ungenutzt) — „iso" (vorne-oben-rechts) ist der bestehende Default.
 * „perspective" ist der freie 3/4-Blick. Wirkt nur in der Perspektive.
 */
export type View3d =
  | "front"
  | "back"
  | "side"
  | "left"
  | "top"
  | "iso"
  | "isoFrontLeft"
  | "isoBackRight"
  | "isoBackLeft"
  | "perspective";

/**
 * Das gesamte Projekt.
 *
 * Ein Ausschnitt (View-Snapshot) — eine benannte, gespeicherte Ansicht, die den
 * kompletten Darstellungszustand einfängt und per Klick wiederherstellt
 * (DOSSIER A2, ROADMAP §2c/§11). KEIN neuer Zustand, sondern ein Container, der
 * bereits vorhandene Bausteine KOMPONIERT + benennt: Ansicht (Typ/Kamera/
 * Massstab/Detail), Sichtbarkeit (Ebenen-/Zeichnungskombination, gleiches
 * Payload-Format wie {@link https LayerCombo}/`DrawingCombo`), aktive Overrides
 * und das aktive Geschoss. Lebt im DOKUMENT (`Project.viewSnapshots`), nicht im
 * localStorage — Ausschnitte gehören zum Projekt (Export/Teilen).
 */
export type ViewSnapshot = {
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
  /** Aktives Geschoss/Zeichnungsebene beim Erfassen. */
  activeLevelId: string;
  /** Ebenen-Sichtbarkeit: Kategorie-`code` → sichtbar (wie `LayerCombo.codes`). */
  layerVisibility: { [key in string]: boolean };
  /** Zeichnungsebenen-Sichtbarkeit: DrawingLevel-`id` → sichtbar (wie `DrawingCombo.ids`). */
  drawingVisibility: { [key in string]: boolean };
  /**
   * Ids der beim Erfassen AKTIVEN (`enabled`) Override-Regeln. Beim
   * Wiederherstellen wird jede Regel des Projekts auf `enabled = ids.includes(id)`
   * gesetzt. Optional, damit hand-/altangelegte Snapshots ohne Feld gültig sind.
   */
  enabledOverrideRuleIds?: Array<string>;
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
  /** Ansichtsvorlage ([34]) des Ausschnitts (einmal angewendet oder verknüpft). */
  templateId?: string;
  /** `true` ⇒ der Ausschnitt folgt der Vorlage. */
  templateLinked?: boolean;
};

/**
 * Ein Ordner im Ausschnitte-Baum (DOSSIER A2). Ausschnitte verweisen per
 * `folderId` auf ihren Ordner; `parentId` erlaubt Verschachtelung (Ordner in
 * Ordner). Fehlt `parentId`, liegt der Ordner auf der Wurzelebene. Additiv —
 * Alt-Projekte laden unverändert (spiegelbildlich zu {@link LayoutFolder}).
 */
export type ViewSnapshotFolder = {
  id: string;
  name: string;
  /** Übergeordneter Ordner; ohne → Wurzelebene. */
  parentId?: string;
};

/**
 * Ansichtsvorlage ([34]): ein benannter Satz Ansichts-Einstellungen für Grundriss, Schnitt, Ansicht
 * und Ausschnitte. Jedes Feld ist optional — fehlt es, lässt die Vorlage diese Einstellung unberührt.
 */
export type ViewTemplate = {
  id: string;
  name: string;
  /** Detailgrad (grob/mittel/fein). */
  detail?: DetailLevel;
  /** Papier-Massstab „1:N“ (der Nenner). */
  scaleDenominator?: number;
  /** Sichtbare Kategorien: `code` → sichtbar (Kategorien, die fehlen, bleiben unberührt). */
  layerVisibility?: { [key in string]: boolean };
  /** Ids der aktiven Override-Regeln (alle übrigen aus). */
  enabledOverrideRuleIds?: Array<string>;
  /** Darstellungsmodus der Geschosse (`all_force` … `locked`). */
  displayMode?: string;
  /** Schwarz-Weiss. */
  mono?: boolean;
  /** Schatten (Ansicht). */
  shadows?: boolean;
  /** Verdeckte Kanten (Schnitt/Ansicht). */
  hiddenLines?: boolean;
  /** Strichstärken mit dem Massstab skalieren. */
  scaleLineWeights?: boolean;
  /** Schnitthöhe über OKFF ([36]). */
  cutHeight?: number;
  /** Ansichtsbereich: Oberkante ([36]). */
  viewTop?: number;
  /** Ansichtsbereich: Unterkante ([36]). */
  viewBottom?: number;
  /** Ansichtsbereich: darunter sichtbar bis ([36]). */
  viewDepth?: number;
};

/** Ansichtstyp eines Geschosses (wie in App). */
export type ViewType = "grundriss" | "perspektive";

/** Eine Wand, definiert über ihre Achse (Centerline) und ihren Typ. */
export type Wall = {
  id: string;
  type: "wall";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "20" für Wände. */
  categoryCode: string;
  /**
   * Objekt-Sperre: gesperrte Elemente lassen sich nicht anwählen (daher
   *  auch nicht verschieben/bearbeiten/löschen) — anders als der Ebenen-/
   *  Geschoss-Sperrmodus (`DisplayMode`) ist das hier persistiert.
   */
  locked?: boolean;
  /** Aussen (true) / innen (false); fehlt = nicht angegeben (IFC `IsExternal`). */
  isExternal?: boolean;
  /** Tragend (IFC `LoadBearing`); fehlt = nicht angegeben. */
  loadBearing?: boolean;
  /** Achs-Startpunkt im Grundriss (Meter). */
  start: Vec2;
  /** Achs-Endpunkt im Grundriss (Meter). */
  end: Vec2;
  /**
   * Bogenwand ([T2]): Achse als Kreisbogen von `start` nach `end`, `bulge = tan(Öffnungswinkel/4)`;
   * positiv = Scheitel links der Sehne (Modell-Konvention wie Polylinien, = −DXF-Bulge). Fehlt/0 =
   * gerade Wand.
   */
  bulge?: number;
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
  /**
   * Ansichtsschraffur ([100]): Drehung (Grad) des Oberflächenmusters dieses Elements gegenüber der
   * Ausrichtung am Element (Default 0).
   */
  surfacePatternAngle?: number;
  /**
   * Ansichtsschraffur ([100]): Versatz (m) des Musterursprungs (x entlang, y quer/aufwärts) gegenüber
   * der Elementkante.
   */
  surfacePatternOffset?: Vec2;
};

/**
 * Lage der Wandachse (Referenzlinie) über die Dicke der Wand — analog
 * Vectorworks. Gemessen relativ zur Laufrichtung (start→end) mit der
 * leftNormal-Konvention `n = (-u.y, u.x)`:
 *   • "center" — Achse mittig (Default = heutiges Verhalten).
 *   • "left"   — Achse liegt auf der linken Wandfläche (+n-Seite, „außen").
 *   • "right"  — Achse liegt auf der rechten Wandfläche (−n-Seite, „innen").
 */
export type WallReferenceLine = "left" | "center" | "right";

/** Ein Wandtyp = geordneter Schichtaufbau (außen → innen). */
export type WallType = { id: string; name: string; layers: Array<Layer> };

/** Rollladen-/Sonnenschutzkasten über der Öffnung (P0-Minimalfassung). */
export type WindowShading = {
  create: boolean;
  kind: "rollladen" | "raffstore" | "markise";
  /** Kastenmasse (Meter): Breite (quer, meist = Öffnung), Höhe, Tiefe. */
  box: { width: number; height: number; depth: number };
  /**
   * Einbau des Kastens: "vorgesetzt" (vor der Rahmenebene, bisher) oder "sturz" (Storenkasten
   * im Sturz, in der Wand verdeckt — in der Schweiz üblich bei Lamellenstoren). Fehlt ⇒ vorgesetzt.
   */
  mount?: WindowShadingMount;
};

/** Einbau des Sonnenschutzkastens ({@link WindowShading.mount}). */
export type WindowShadingMount = "vorgesetzt" | "sturz";

export type WindowType = {
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
  sashes?: Array<SashDef>;
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
  insetFace?: "aussen" | "innen" | "mitte";
  /**
   * Schicht-Rücksprung an der Laibung: weicht die INNERSTE Wandschicht (meist
   * Gipsplatte/Holzverkleidung) an diesem Fenster um ihre eigene Dicke von der
   * Öffnung zurück, statt bündig mit den übrigen Schichten abzuschliessen —
   * anders als {@link insetFromFace} (der Rahmen-Position), ändert dies die
   * WAND-GEOMETRIE selbst an der Laibung. Default false (bündig, Alt-Verhalten).
   * Veraltet ([106]): gilt nur ohne {@link layerReveals} (= innerste Schicht „zurück um Schichtdicke").
   */
  innerLayerRecess?: boolean;
  /**
   * Oberlicht: Höhe eines festen, verglasten Oberlichts über dem Hauptflügel
   * (Meter), abgeteilt durch einen Kämpfer. 0/fehlt ⇒ kein Oberlicht.
   */
  transomHeight?: number;
  /**
   * Einteilung des Oberlichts über dem Riegel (Pfosten/Riegel, [95]): Felder und Pfosten wie
   * {@link sashes}, je Feld fest oder öffenbar (meist Kipp). Fehlt ⇒ ein festes Feld (bisher).
   */
  transomSashes?: Array<SashDef>;
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
  /**
   * Anschlag (Maueranschlag): so weit (Meter, je Seite und oben) springt die Wand zwischen
   * der Fläche aus {@link insetFace} und der Rahmen-Vorderkante in die Öffnung vor. Wirkt nur
   * mit Leibung (`insetFromFace` > 0 bzw. `insetFace: "mitte"`). 0/fehlt ⇒ stumpf (bisher).
   */
  rebateDepth?: number;
  /**
   * Sturz: Höhe des Sturzes über der Öffnung (Meter), im Schnitt als eigener Querschnitt
   * gezeichnet. 0/fehlt ⇒ kein eigener Sturz (bisher).
   */
  lintelHeight?: number;
  /**
   * Rahmen-Detail ([105]): Blendrahmen je Seite, Flügelrahmen, Pfosten/Kämpfer, Zusatzprofile,
   * Anschlag je Seite. Fehlt ⇒ wie bisher (`frameWidth`, `rebateDepth`).
   */
  frameDetail?: FrameDetail;
  /**
   * Schichteinzug ([106]): wie die Wandschichten an Leibung, Sturz und Brüstung anschliessen.
   * Fehlt ⇒ alle Schichten bündig (bzw. `innerLayerRecess`, veraltet).
   */
  layerReveals?: Array<LayerReveal>;
};
