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
import type { RichTextDoc, Align } from "../text/richText";
export type { RichTextDoc } from "../text/richText";

// ── Ressourcen-Bibliotheken (Vectorworks-/DOSSIER-Stil) ────────────────────
// Verwaltete, per id verwiesene Stil-Ressourcen. Verweis-Kette:
//   Component → Hatch → LineStyle.
// Darstellung wird beim Rendern aus diesen Ressourcen aufgelöst, nie in die
// Geometrie eingebacken (siehe docs/design/resources-graphics.md).

/** Ein wiederverwendbarer Linienstil (Line Manager). */
export interface LineStyle {
  id: string;
  name: string;
  /** Strichstärke in Millimetern (≙ Rhino PlotWeight). */
  weight: number;
  /** Farbe (hex). */
  color: string;
  /** Strichmuster in Millimetern; `null` = durchgezogen. */
  dash: number[] | null;
}

/** Mögliche Schraffur-Muster im Plan/Schnitt. */
export type HatchPattern =
  | "none"
  | "solid"
  | "insulation"
  | "diagonal"
  | "crosshatch";

/** Eine wiederverwendbare Schraffur (Hatch Manager). */
export interface HatchStyle {
  id: string;
  name: string;
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
   * Farbe der Musterlinien bzw. der Vollfüllung (`pattern==="solid"`). Bei
   * `pattern==="none"` ungenutzt.
   */
  color: string;
  /** Optionaler Linienstil für die Musterlinien (Line Manager). */
  lineStyleId?: string;
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
  /** Füllfarbe im Grundriss (Poché) und 3D-Diffusfarbe. */
  color: string;
  /** Schnitt-Schraffur → Hatch Manager. */
  hatchId: string;
  /** Optionale 3D-Textur (vorerst ignoriert). */
  texture3d?: string;
  /**
   * Optionales echtes PBR-Material für die 3D-Texturierung (Bibliothek ODER
   * Upload). Fehlt es, bleibt das heutige Verhalten (matte Farbe). Wirkt nur im
   * Render-Modus „textured".
   */
  material?: ComponentMaterial;
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
  /**
   * Lage der Wandachse über die Dicke. Fehlt sie, gilt "center" (= heutiges
   * Verhalten: Schichten symmetrisch −T/2 … +T/2 um die Achse).
   */
  referenceLine?: WallReferenceLine;
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
}

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
 * absolute Z-Höhe, `top: floor` bindet die OK an ein Geschoss.
 */
export interface Ceiling {
  id: string;
  type: "ceiling";
  /** Zugehörige Zeichnungsebene (Geschoss). */
  floorId: string;
  /** Grafik-Kategorie (Ebene), z. B. "30" für Decken. */
  categoryCode: string;
  /**
   * Geschlossener Umriss im Grundriss (Meter). Der Schlusspunkt wird NICHT
   * dupliziert (die letzte Kante läuft von outline[n-1] zu outline[0]).
   */
  outline: Vec2[];
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
  /**
   * Vertikale Bindung der OBERKANTE (OK). Fehlt sie, sitzt die OK an der
   * Oberkante des Geschosses (baseElevation + floorHeight).
   */
  top?: VerticalAnchor;
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
   * Optionale Übersteuerung der Strich-/Symbolfarbe; sonst gilt die
   * Kategorie-Farbe.
   */
  color?: string;
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
   * Optionale Übersteuerung der Strich-/Umrandungsfarbe; sonst gilt die
   * Kategorie-Farbe.
   */
  color?: string;
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
}

/** Eine Tür, gehostet in einer Wand. Ihr Geschoss ergibt sich aus der Wand. */
export interface Door {
  id: string;
  type: "door";
  hostWallId: string;
  /** Grafik-Kategorie (Ebene), z. B. "21" für Türen/Fenster. */
  categoryCode: string;
  /** Abstand des Türanschlags (erster Pfosten) vom Wand-Startpunkt, in Metern. */
  position: number;
  /** Türbreite (lichte Öffnung) in Metern. */
  width: number;
  /** Türhöhe in Metern. */
  height: number;
  /** Auf welche Seite der Wandachse die Tür aufschlägt. */
  swing: SwingSide;
  /** An welchem Pfosten das Scharnier sitzt. */
  hinge: "start" | "end";
}

// ── Freie 2D-Zeichengeometrie (Drawing2D) ──────────────────────────────────
// Ein semantisches 2D-Element (wie Wall/Door), das beim Rendern abgeleitet wird
// (keine vorab erzeugten Plan-Primitive). Siehe docs/design/drawing-tools.md §7.

/** Geometrie-Form eines 2D-Zeichenelements. */
export type Drawing2DGeom =
  | { shape: "line"; a: Vec2; b: Vec2 }
  | { shape: "polyline"; pts: Vec2[]; closed: boolean }
  | { shape: "rect"; min: Vec2; max: Vec2 }
  | { shape: "circle"; center: Vec2; r: number }
  | { shape: "arc"; center: Vec2; r: number; a0: number; a1: number }
  | { shape: "text"; at: Vec2; text: string; height: number; angle: number };

/** Ein freies 2D-Zeichenelement auf einer Zeichnungsebene. */
export interface Drawing2D {
  id: string;
  type: "drawing2d";
  /** Zeichnungsebene (Geschoss ODER freie 2D-Ebene). */
  levelId: string;
  /** Grafik-Kategorie (Ebene) — liefert Farbe/Strichstärke als Default. */
  categoryCode: string;
  geom: Drawing2DGeom;
  /** Optionaler Linienstil (Line Manager); sonst Kategorie-Default. */
  lineStyleId?: string;
  /** Optionale Schraffur für geschlossene Formen (Hatch Manager). */
  hatchId?: string;
  /** Optionale explizite Strichfarbe; sonst Kategorie-Farbe. */
  color?: string;
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
}

export type Element = Wall | Ceiling | Opening | Door | Stair | Room | Drawing2D;

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
}

/** Ein Satz Konturen (z. B. alle Höhenlinien eines DXF-Imports). */
export interface ContourSet {
  id: string;
  type: "contourSet";
  name: string;
  /** Ursprünglicher DXF-Layer-Name (für spätere Kategorisierung). */
  layer?: string;
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
  positions: number[];
  indices: number[];
}

/** Ein Kontext-Objekt: importiertes Mesh, Konturen-Satz oder abgeleitetes TIN. */
export type ContextObject = ImportedMesh | ContourSet | TerrainMesh;

/** Das gesamte Projekt. */
export interface Project {
  id: string;
  name: string;
  /** Linienstil-Bibliothek (Line Manager). */
  lineStyles: LineStyle[];
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
  /** Oberste Schnitte: Geschosse + Schnitte/Ansichten. */
  drawingLevels: DrawingLevel[];
  /** Grafik-Kategorie-Baum (geschossübergreifend). */
  layers: LayerCategory[];
  walls: Wall[];
  /**
   * Decken (Slabs) — geschossgebundene Flächenbauteile mit geschlossenem Umriss.
   * Optional, damit bestehende Projekte/Tests ohne `ceilings` gültig bleiben
   * (Default: leer behandeln).
   */
  ceilings?: Ceiling[];
  doors: Door[];
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
   * Bibliothek parametrischer Wand-Regelwerke. Optional, damit bestehende
   * Projekte ohne `parametricWalls` gültig bleiben (Default: leer behandeln).
   * Wird durch `resolveParametricWall()` in `src/model/parametricWalls.ts`
   * aufgelöst — generiert Wall[]-Objekte bei Bedarf.
   */
  parametricWalls?: ParametricWall[];
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
