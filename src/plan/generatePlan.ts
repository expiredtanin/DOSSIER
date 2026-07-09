// Grundriss-Generator: erzeugt aus dem semantischen Modell den
// 2D-Grundriss als abstrakte Vektor-Primitive (später → SVG).
//
// Kern-Erkenntnis: Der Grundriss entsteht NICHT durch Zerschneiden eines
// 3D-Meshes, sondern direkt aus den Parametern (Wandachsen, Schichtaufbau,
// Öffnungen) — exakt, schnell, sauber.

import type {
  AttributeSource,
  Ceiling,
  Column,
  Component,
  Drawing2D,
  ExtrudedSolid,
  HatchPattern,
  LayerCategory,
  Opening,
  OverrideActions,
  Project,
  Roof,
  Room,
  Stair,
  Vec2,
  Wall,
} from "../model/types";
import {
  columnLabel,
  columnsOfFloor,
  flattenCategories,
  getCeilingType,
  getComponent,
  getDoorType,
  getHatch,
  getLayerCategory,
  getLineStyle,
  getWallType,
  getWindowType,
  glazingPanesOf,
  openingLabel,
  openingsOfWall,
  roomsOfFloor,
  sashesOfWindowType,
  stairLabel,
  stairsOfFloor,
  wallTypeThickness,
} from "../model/types";
import { columnFootprint } from "../geometry/column";
import { roofGeometry } from "../geometry/roof";
import { effectiveOverrides, hasOverrides } from "../overrides/engine";
import { evaluateRoom, siaLabel } from "../geometry/roomArea";
import type { Marks, RichTextDoc } from "../text/richText";
import { docFromText } from "../text/richText";
import { roomStampToDoc, roomStampExtraLines } from "../model/roomStamp";
import type { RoomStampLine } from "../model/roomStamp";
import { stairVerticalExtent, wallReferenceOffset } from "../model/wall";
import { stairGeometry, stairCut, stairOutline } from "../geometry/stair";
import type { SpiralOutlineSegments } from "../geometry/stair";
import {
  doorSymbol,
  openingGapQuad,
  openingInterval,
  openingJambs,
  wallAxisFrame,
  windowSymbol,
} from "../geometry/opening";
import {
  add,
  along,
  clippedBand,
  dot,
  leftNormal,
  lineIntersect,
  normalize,
  scale,
  sub,
  wallCorners,
} from "../model/geometry";
import type { Line } from "../model/geometry";

/**
 * Detailgrad der Plan-Darstellung (Oberleiste „grob/mittel/fein"). Steuert hier
 * konkret zwei Dinge im Grundriss:
 *  • Tür-/Fenstersymbole: grob = nur Öffnungs-Lücke + gerade Türblatt-Linie;
 *    mittel = + Schwenkbogen; fein = + Rahmen/Anschlag-Striche.
 *  • Schraffuren + Linienfeinheit: grob = vereinfachte Poché (eine Sammelfläche
 *    ohne Schraffur, dickere Umrisslinie); mittel = aktueller mehrschichtiger
 *    Aufbau mit Schraffuren; fein = volle Schraffuren + dünnere Linien.
 *
 * NOCH OFFEN (folgt, sobald die Features existieren — hier bewusst KEIN
 * Schein-Effekt): Bemaßung/Beschriftung werden mit dem Detailgrad auf-/abblenden
 * (Maßketten, Raumstempel), und die 3D-Geometrie-Auflösung (z. B. Profil-
 * Rundungen, Tritt-/Setzstufen) wird ebenfalls dem Detailgrad folgen, sobald
 * Bemaßung bzw. eine feinere 3D-Tessellierung implementiert sind.
 */
export type DetailLevel = "grob" | "mittel" | "fein";
import { computeJoins } from "../model/joins";
import type { WallCuts } from "../model/joins";
import type { SectionOutput } from "./toSection";

/** Stroke-Farbe der Schicht-Polygone (neutrales Schwarz, geteilte Tinte mit der Schraffur). */
const POCHE_STROKE = "#1a1a1a";

/** Tinte für den Schwarz-Weiss-Modus: einheitliches Dunkel für alle Striche. */
const MONO_INK = "#111111";

// ── Linienstärken in PAPIER-Millimeter (vgl. docs/design/plans-output.md §3.2) ──
// Alle Stricharten sind in mm Papier definiert; die PlanView rechnet sie über
// dpi = 96·devicePixelRatio in konstante Bildschirm-Pixel um (non-scaling-stroke),
// damit Linien beim Zoomen ihre Papiergröße behalten und der Massstab stimmt.

/** Default-Schichtfuge zwischen den Materialschichten in mm — Haarlinie (0.02),
 *  gleiche Stärke wie die Schraffur-Tinte. Pro Fuge im Wandstil überschreibbar
 *  (z. B. 0.13, wenn zwei massive Materialien aufeinandertreffen). */
const LAYER_LINE_MM = 0.02;
/** Haarlinie für Tür-/Fenstersymbole (Flügel, Bogen, Rahmen, Glas) in mm. */
const SYMBOL_HAIRLINE_MM = 0.02;
/** Strichmuster (mm Papier) für ÜBERKOPF-Ansichtslinien: Bauteile über der
 *  Grundriss-Schnittebene (Decken-/Slab-Überstände, Unterzüge) werden nach
 *  BIM-Konvention gestrichelt gezeichnet (Aufsicht auf ein Bauteil über einem). */
const OVERHEAD_DASH: number[] = [0.4, 0.25];
/** Strichstärken der Dach-Grundrisslinien (mm Papier): Traufe = mittlere
 *  Haarlinie, First etwas kräftiger als die Traufe, Grat dazwischen, Knick dünn
 *  + gestrichelt (vgl. addRoofs). */
const ROOF_EAVES_MM = 0.13;
const ROOF_RIDGE_MM = 0.25;
const ROOF_HIP_MM = 0.18;
const ROOF_BREAK_MM = 0.09;
/** Strichmuster (mm Papier) der Dach-Knicklinie (Mansarde). */
const ROOF_BREAK_DASH: number[] = [0.12, 0.08];
/** Stärke der Wand-Umrisslinie je Detailgrad, als Faktor auf die Ebenen-lw. */
const OUTLINE_DETAIL_FACTOR: Record<DetailLevel, number> = {
  grob: 1.6, // dickere Sammellinie
  mittel: 1.0, // wie die Kategorie-Strichstärke
  fein: 0.6, // feiner
};
/** Stärke der Schichtfugen je Detailgrad (mittel/fein; grob hat keine Fugen). */
const LAYER_DETAIL_FACTOR: Record<DetailLevel, number> = {
  grob: 1.0,
  mittel: 1.0,
  fein: 0.7,
};
/** Default-Umrandungs-Strichstärke (mm), falls die Kategorie keine lw trägt
   (Grundeinstellung für „normale Elemente"). */
const WALL_FALLBACK_MM = 0.18;

/**
 * Aufgelöste Schraffur eines Polygons — alle Werte stammen aus einer
 * HatchStyle-Ressource (Muster/Maßstab/Winkel/Farbe) plus dem optional
 * verknüpften LineStyle (Linienstärke/Strichmuster der Musterlinien). Die
 * PlanView ist damit rein darstellend und kennt das Projekt nicht.
 */
export interface HatchRender {
  pattern: HatchPattern;
  scale: number;
  angle: number;
  /**
   * AUFGELÖSTE Farbe der Musterlinien bzw. der Vollfüllung (pattern==="solid").
   * Ergebnis der Farb-Resolve-Kette (siehe {@link resolveHatch}): Vordergrund =
   * (Attribut-Override) ?? (Component.foreground) ?? (HatchStyle.color, Backward-
   * Compat) ?? Default. Der heutige SVG-/GL-/DXF-Renderer liest weiterhin nur
   * dieses Feld — die Kette ist zur Renderzeit bereits kollabiert.
   */
  color: string;
  /** Linienstärke der Musterlinien in mm. */
  lineWeight: number;
  /** Strichmuster der Musterlinien in mm; null = durchgezogen. */
  dash: number[] | null;
  /**
   * Schraffur-Typ (additiv). `undefined`/"vector" ⇒ Muster nach `pattern` (heutiges
   * Verhalten); "image" ⇒ Bild-Muster (`image`). Bestehende Renderer ignorieren
   * `kind` und zeichnen nach `pattern` → unbekannte kinds fallen auf heute zurück.
   */
  kind?: "vector" | "image";
  /** Vektor-Untermodus (additiv). `undefined`/"parallel" ⇒ regelmäßig; "random" ⇒ zufällig. */
  lines?: "parallel" | "random";
  /** Bild-Muster-Parameter (nur `kind==="image"`); durchgereicht aus dem HatchStyle. */
  image?: { src: string; scaleX: number; scaleY: number; rotation: number };
  /**
   * Steuer-Parameter der Random-Vektor-Streuung (nur `lines==="random"`), 1:1 aus
   * dem HatchStyle durchgereicht. Alle optional — die eigentliche Erzeugung/
   * Default-Auflösung liegt zentral in `glPlan/glPlanHatch.ts` (single render truth).
   */
  seed?: number;
  density?: number;
  lengthMin?: number;
  lengthMax?: number;
}

/**
 * Render-Entscheidung je Kategorie-Code für den Grundriss (vgl. ItemDisplay aus
 * dem Panel-Darstellungsmodus). `render`=false blendet die Kategorie ganz aus,
 * `greyed`=true zeichnet sie gedimmt. Wird kein Resolver übergeben, gilt für
 * jede sichtbare Kategorie {render:true, greyed:false} (bisheriges Verhalten).
 */
export interface CategoryDisplay {
  render: boolean;
  greyed: boolean;
}

/** Funktion, die je Kategorie-Code die Render-Entscheidung liefert. */
export type CategoryDisplayResolver = (code: string) => CategoryDisplay;

/** Standard-Resolver: jede (bereits gefilterte) Kategorie normal zeichnen. */
const SHOW_ALL: CategoryDisplayResolver = () => ({ render: true, greyed: false });

export type Primitive =
  | {
      kind: "polygon";
      pts: Vec2[];
      /** Füllfarbe (Component-Poché) bzw. "none" für reine Umrisslinien. */
      fill: string;
      stroke: string;
      /** Umriss-Strichstärke in PAPIER-Millimeter (siehe oben). */
      strokeWidthMm: number;
      hatch: HatchRender;
      /** Gedimmt zeichnen (Darstellungsmodus „andere grau"). */
      greyed?: boolean;
      /**
       * Kanten-Indizes, die NICHT umrissen (gestrichen) werden dürfen — die Füllung
       * bleibt das volle Polygon. Kante `i` läuft von `pts[i]` nach `pts[(i+1)%n]`.
       * Damit werden die inneren Gehrungs-/Stoß-Stirnflächen an einer Wandecke
       * unterdrückt: die Diagonale, an der GLEICHFARBIGE Schichten zweier Wände
       * aneinanderstoßen, würde sonst als sichtbare 45°-Naht erscheinen und der
       * Umriss würde als Barbe über den Eck-Apex hinausschießen (Gehrungs-Spitze).
       * Längskanten (Schichtfugen zwischen VERSCHIEDENEN Materialien) bleiben
       * gestrichen — nur die Stoß-Stirnkanten am Knoten entfallen.
       */
      noStrokeEdges?: number[];
      /**
       * ID der Wand, zu der dieses Schicht-/Umriss-Polygon gehört (für die
       * Links-Klick-Auswahl: die PlanView markiert ALLE Polygone derselben
       * Wand und meldet die wallId nach oben). Reine Umriss-/Symbol-Primitive
       * ohne Wandbezug lassen das Feld weg.
       */
      wallId?: string;
      /**
       * ID des 2D-Zeichenelements (Drawing2D), falls dieses gefüllte Polygon eine
       * geschlossene 2D-Form ist (für die Links-Klick-Auswahl der Fläche).
       */
      drawingId?: string;
      /**
       * ID der Decke (Ceiling), falls dieses Polygon eine Decken-Fläche/-Umriss
       * ist (für die Links-Klick-Auswahl der Decke).
       */
      ceilingId?: string;
      /** ID der Öffnung (Fenster/Tür), z. B. der Fensterrahmen (Auswahl). */
      openingId?: string;
      /** ID der Treppe (Stair), falls dieses Polygon ein Tritt/Podest ist (Auswahl). */
      stairId?: string;
      /** ID des Raums (Room), falls dieses Polygon eine Raum-Fläche ist (Auswahl). */
      roomId?: string;
      /**
       * ID des extrudierten Körpers (truck-Integration), falls dieses Polygon der
       * Grundriss-Footprint einer Extrusion ist (für eine spätere Links-Klick-
       * Auswahl — heute nur zur Nachvollziehbarkeit getaggt, noch nicht verdrahtet).
       */
      extrudedSolidId?: string;
      /**
       * ID der Stütze (Column), falls dieses Polygon der Grundriss-Querschnitt
       * (Poché) einer Stütze ist (für die Links-Klick-Auswahl der Fläche).
       */
      columnId?: string;
      /** ID des Dachs (Roof), falls dieses (unsichtbare) Polygon der Traufe-Umriss ist (Auswahl). */
      roofId?: string;
    }
  | {
      kind: "line";
      a: Vec2;
      b: Vec2;
      cls: string;
      /** Strichstärke in mm Papier (non-scaling). */
      weightMm: number;
      /** Strichmuster in mm Papier; null/undefined = durchgezogen. */
      dash?: number[] | null;
      /**
       * Zickzack-/Wellen-Parameter (aus einem LineStyle mit `kind==="zigzag"`),
       * beide in mm Papier. Ist es gesetzt, zeichnen die Renderer die Linie als
       * Zickzack-Pfad statt als gerade (ggf. gestrichelte) Linie — ADDITIV, ohne
       * die bestehenden Strich/Dash-Linien zu verändern (Feld fehlt ⇒ heute).
       */
      zigzag?: { amplitude: number; wavelength: number };
      /**
       * Frei gezeichnetes Wiederhol-Motiv (aus einem LineStyle mit
       * `kind==="custom"`): eine offene Polylinie in einer Einheitszelle, `points`
       * in mm Papier, `length` = Wiederhollänge in mm Papier. Ist es gesetzt,
       * kacheln die Renderer das Motiv entlang der Linie (analog `zigzag`) —
       * ADDITIV; fehlt es, bleibt die Linie gerade/gestrichelt.
       */
      motif?: { points: Vec2[]; length: number };
      /** Optionale explizite Strichfarbe (überschreibt die CSS-Klasse). */
      color?: string;
      /** ID des 2D-Zeichenelements (für Links-Klick-Auswahl von Drawing2D). */
      drawingId?: string;
      /** ID der Öffnung (für Links-Klick-Auswahl von Fenster/Tür-Symbolen). */
      openingId?: string;
      /** ID der Treppe (für Links-Klick-Auswahl von Treppen-Symbollinien). */
      stairId?: string;
      greyed?: boolean;
    }
  | {
      kind: "arc";
      center: Vec2;
      from: Vec2;
      to: Vec2;
      r: number;
      cls: string;
      /** Strichstärke in mm Papier (non-scaling). */
      weightMm: number;
      /** Strichmuster in mm Papier; null/undefined = durchgezogen. */
      dash?: number[] | null;
      /** ID der Öffnung (für Links-Klick-Auswahl von Tür-Schwenkbögen). */
      openingId?: string;
      /** ID der Treppe (für Links-Klick-Auswahl von Wendel-Outline-Bögen). */
      stairId?: string;
      greyed?: boolean;
    }
  | {
      kind: "text";
      /** Ankerpunkt im Modell (Meter). */
      at: Vec2;
      /**
       * Frei editierbarer Stempel-Text (Rich-Text). Wird zuerst gezeichnet;
       * `align` je Absatz steuert die Ausrichtung.
       */
      doc: RichTextDoc;
      /**
       * LIVE-Zusatzzeilen (z. B. Fläche „24.30 m²" + SIA-Tag), UNTER dem Doc
       * gezeichnet — unabhängig vom editierten Text, stets aktuell. Jede Zeile
       * trägt ihre eigene Ausrichtung (`align`).
       */
      extraLines: RoomStampLine[];
      /** Basis-Schriftgrösse in PUNKT (für Runs ohne eigene Grösse + Zusatzzeilen). */
      basePt: number;
      /** Textfarbe (hex) als Default. */
      color: string;
      /** ID des Raums (Room), zu dem dieser Stempel gehört (Auswahl). */
      roomId?: string;
      greyed?: boolean;
    }
  | {
      // Schlichter, modellverankerter Einzeltext (aus Drawing2D `{shape:"text"}`,
      // z. B. DXF-Import). Anders als `kind:"text"` (Raum-Stempel, RichText) trägt
      // er nur einen String mit Höhe in Metern + Drehung — rein SVG-gerendert.
      kind: "drawingText";
      /** Ankerpunkt im Modell (Meter). */
      at: Vec2;
      text: string;
      /** Schrifthöhe in Modell-Metern. */
      heightM: number;
      /** Drehung in RADIANT (CCW im Modell). */
      angle: number;
      color: string;
      /** Optionale einheitliche Formatierung (Schriftfamilie/fett/kursiv/…). */
      marks?: Marks;
      /**
       * Optionale Spaltenbreite in Modell-Metern (Textspalte): ist sie gesetzt,
       * bricht der Renderer den Text wortweise auf diese Breite um. Fehlt sie,
       * bleibt es einzeiliger Text.
       */
      wrapWidth?: number;
      /** ID des 2D-Zeichenelements (für Links-Klick-Auswahl). */
      drawingId?: string;
      greyed?: boolean;
    }
  | {
      // Glatter Kreis (aus Drawing2D `{shape:"circle"}`, z. B. DXF-CIRCLE) — als
      // echtes `<circle>` gerendert (rund bei jedem Zoom), nicht als Vieleck.
      kind: "drawingCircle";
      center: Vec2;
      /** Radius in Modell-Metern. */
      r: number;
      /** Vollton-Füllfarbe oder "none". */
      fill: string;
      stroke: string;
      weightMm: number;
      dash?: number[] | null;
      drawingId?: string;
      greyed?: boolean;
    }
  | {
      // Glatter Bogen (aus Drawing2D `{shape:"arc"}`, z. B. DXF-ARC) — als
      // SVG-Bogenpfad gerendert; Winkel in RADIANT (CCW im Modell).
      kind: "drawingArc";
      center: Vec2;
      r: number;
      a0: number;
      a1: number;
      stroke: string;
      weightMm: number;
      dash?: number[] | null;
      drawingId?: string;
      greyed?: boolean;
    };

/**
 * Löst eine HatchStyle-Ressource (per id) zu einer darstellungsfertigen
 * {@link HatchRender} auf. Der Linienstil der Musterlinien wird, falls gesetzt,
 * aus dem Line Manager nachgeschlagen; sonst gilt ein dünner Default.
 *
 * VORDERGRUND (Muster-/Schraffurlinienfarbe bzw. Vollfüllung): AKTUELL fest auf
 * {@link HATCH_INK} gezwungen (Nutzer-Vorgabe 2026-07-04) — Schnitt- WIE
 * Oberflächen-/Ansichtsschraffur zeigen dieselbe dunkle Tinte, unabhängig von
 * Material-/Bauteilfarbe, HatchStyle.color oder einem By-Layer/By-Object-
 * Vordergrund-Override. `_foreground` bleibt Teil der Signatur — alle Aufrufer
 * reichen weiterhin den über {@link resolveForeground} aufgelösten Bauteil-
 * Vordergrund durch (z. B. für eine spätere Wiederherstellung der materialtreuen
 * Schraffur) —, fließt aber bewusst nicht mehr in `color` ein.
 */
export function resolveHatch(
  project: Project,
  hatchId: string,
  wallAngleDeg?: number,
  _foreground?: string,
): HatchRender {
  const h = getHatch(project, hatchId);
  const ls = h.lineStyleId ? getLineStyle(project, h.lineStyleId) : null;
  // Wandbezogener Winkel: `HatchRender.angle` wird von allen Renderern in der
  // SVG-Konvention (im Uhrzeigersinn, Bildschirm-Y nach unten) verstanden — der
  // Modell-Renderer negiert ihn in `toModelAngleRad`. Die Wandachse `wallAngleDeg`
  // ist dagegen ein MODELL-Winkel (atan2 der Richtung, gegen den Uhrzeigersinn,
  // Y nach oben). Wegen der Y-Spiegelung entspricht die Wandrichtung am Bildschirm
  // dem Winkel −wallAngleDeg; das Muster folgt der Wand also, indem der
  // Wandwinkel SUBTRAHIERT wird. Ohne Wandkontext (Decke) bleibt `angle` absolut.
  const angle =
    h.relativeToWall && wallAngleDeg != null ? h.angle - wallAngleDeg : h.angle;
  return {
    pattern: h.pattern,
    scale: h.scale,
    angle,
    // Fest auf die Monochrom-Tinte gezwungen (siehe JSDoc oben) — weder
    // `_foreground` noch `HatchStyle.color` (Material-/Bauteilfarbe) fließen ein.
    color: HATCH_INK,
    lineWeight: ls?.weight ?? 0.13,
    dash: ls?.dash ?? null,
    kind: h.kind,
    lines: h.lines,
    image: h.image,
    // Random-Streu-Parameter unverändert durchreichen (Erzeugung in glPlanHatch).
    seed: h.seed,
    density: h.density,
    lengthMin: h.lengthMin,
    lengthMax: h.lengthMax,
  };
}

/**
 * Kollabiert die Vordergrund-Farbkette (Muster-/Schraffurlinienfarbe) eines
 * Bauteils zu einem einzelnen Wert für {@link resolveHatch}. AUFLÖSUNGSREIHENFOLGE
 * (By-Layer/By-Object, siehe `docs`/Attribut-Panel):
 *   (Attribut-Override `override`) ?? (`source==="layer"` ⇒ `category.color`) ??
 *   (`Component.foreground`) ?? `undefined`.
 * `source` fehlt/`"object"` ⇒ „Nach Bauteil" (heutiges Verhalten, unverändert).
 * `undefined` als Endergebnis heißt „Nach System" — die Kette läuft dann in
 * resolveHatch auf den HatchStyle.color-Backward-Compat-Fallback weiter
 * (Sample-Verhalten: kein Element setzt `override`/`source`, also identisch).
 */
export function resolveForeground(
  comp: Component,
  override?: string,
  category?: LayerCategory,
  source?: AttributeSource,
): string | undefined {
  if (override != null) return override;
  if (source === "layer") return category?.color ?? comp.foreground;
  return comp.foreground;
}

/**
 * Kollabiert die Hintergrund-/Füllfarbkette (Poché) eines Bauteils, analog zu
 * {@link resolveForeground}:
 *   (Attribut-Override `override`) ?? (`source==="layer"` ⇒ `category.color`) ??
 *   (`Component.background`) ?? `Component.color`.
 * Immer definiert (endet spätestens bei `Component.color` = heutiges Verhalten).
 */
export function resolveBackground(
  comp: Component,
  override?: string,
  category?: LayerCategory,
  source?: AttributeSource,
): string {
  if (override != null) return override;
  if (source === "layer") return category?.color ?? comp.background ?? comp.color;
  return comp.background ?? comp.color;
}

/**
 * Kollabiert die Schraffur-Referenz (Hatch Manager) eines Elements zu einer
 * einzelnen `hatchId` für {@link resolveHatch} — By-Layer/By-Object, analog zu
 * {@link resolveForeground}:
 *   (Attribut-Override `override`) ?? (`source==="layer"` ⇒ `category.hatch`) ??
 *   `fallback` (Bauteil-Schraffur, z. B. `Component.hatchId`/`viewHatchId`, oder
 *   `undefined` bei Drawing2D ohne Bauteil-Bezug).
 * `source` fehlt/`"object"` ⇒ „Nach Bauteil" (heutiges Verhalten, unverändert).
 * Ergebnis kann `undefined` sein — der Aufrufer fällt dann auf `NO_HATCH` zurück.
 */
export function resolveHatchId(
  override: string | undefined,
  source: AttributeSource | undefined,
  category: LayerCategory | undefined,
  fallback?: string,
): string | undefined {
  if (override != null) return override;
  if (source === "layer") return category?.hatch ?? fallback;
  return fallback;
}

/**
 * Kollabiert die Strichstärke-Kette (mm Papier) eines Elements, By-Layer/By-
 * Object, analog zu {@link resolveHatchId}:
 *   (Attribut-Override `override`) ?? (`source==="layer"` ⇒ `category.lw`) ??
 *   `fallback` (bisherige Bauteil-/LineStyle-/Kategorie-Default-Kette des
 *   Aufrufers — heutiges Verhalten).
 * `source` fehlt/`"object"` ⇒ „Nach Bauteil" (heutiges Verhalten, unverändert).
 */
export function resolveStrokeWeight(
  override: number | undefined,
  source: AttributeSource | undefined,
  category: LayerCategory | undefined,
  fallback: number,
): number {
  if (override != null) return override;
  if (source === "layer") return category?.lw ?? fallback;
  return fallback;
}

// ── SIA-Poché-Füllung + monochrome Schraffur-Tinte ──────────────────────────
// Die 2D-Poché einer (auch mehrschichtigen) Wand trägt NICHT die rohe Bauteil-
// Albedo (3D-Materialfarbe), sondern einen neutralen Hintergrund, auf dem die
// Schraffur-Musterlinien liegen: Vollmuster ("solid") = dunkle Tinten-Poché
// (kein Linienmuster), jedes andere Muster (inkl. "none") = HELLER Hintergrund.
// Dieselben zwei Werte sind AKTUELL auch die feste Schraffur-Vordergrundfarbe
// (siehe {@link resolveHatch}) — Schnitt- wie Oberflächen-Schraffur zeigen also
// einheitlich Tinte auf hellem Papier, unabhängig von Material-/Bauteilfarbe.
export const HATCH_PAPER = "#f0f0f0";
export const HATCH_INK = "#0f0f0f";
/** Neutrale Poché-Füllfarbe für ein Muster: "solid" → Tinte, sonst Papier. */
function pocheFill(pattern: HatchPattern): string {
  return pattern === "solid" ? HATCH_INK : HATCH_PAPER;
}

/** Füllfarbe + Schraffur eines aufgelösten Bauteils, fertig für eine Cut-Poché. */
export interface SectionCutStyle {
  fill: string;
  hatch: HatchRender;
}

/**
 * Löst das tragende Bauteil (höchste `joinPriority`) einer Wand auf — dieselbe
 * Regel wie {@link backbonePocheFill} für die grobe Grundriss-Poché — und liefert
 * dessen Poché-Füllung + echte Schraffur für die Schnitt-Poché. `null`, wenn Wandtyp
 * oder Bauteil nicht auflösbar sind (z. B. verwaistes `wallTypeId`); der
 * Aufrufer fällt dann auf die generische Schnitt-Schraffur zurück.
 */
export function resolveWallSectionStyle(project: Project, wall: Wall): SectionCutStyle | null {
  try {
    const wt = getWallType(project, wall);
    let best: Component | null = null;
    for (const layer of wt.layers) {
      const comp = getComponent(project, layer.componentId);
      if (!best || comp.joinPriority > best.joinPriority) best = comp;
    }
    if (!best) return null;
    const category = getLayerCategory(project, wall.categoryCode);
    const wallAngleDeg =
      (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
    const hatchId = resolveHatchId(wall.hatchId, wall.hatchSource, category, best.hatchId) ?? best.hatchId;
    const hatch = resolveHatch(
      project,
      hatchId,
      wallAngleDeg,
      resolveForeground(best, wall.foreground, category, wall.foregroundSource),
    );
    // Poché-Hintergrund neutral (Papier) statt Bauteil-Albedo; Vollmuster → Tinte.
    // `hatch.color` ist bereits über {@link resolveHatch} auf HATCH_INK gezwungen.
    const solid = hatch.pattern === "solid";
    return {
      fill: solid ? HATCH_INK : HATCH_PAPER,
      hatch,
    };
  } catch {
    return null;
  }
}

/**
 * Löst das erste Bauteil des Deckentyps einer Decke auf — dieselbe Regel wie
 * {@link addCeilingPoche} für die normale Deckenpoché — und liefert dessen
 * Füllfarbe + echte Schraffur für die Schnitt-Poché. `null`, wenn Deckentyp
 * oder Bauteil nicht auflösbar sind bzw. der Deckentyp keine Schicht trägt.
 */
export function resolveCeilingSectionStyle(
  project: Project,
  ceiling: Ceiling,
): SectionCutStyle | null {
  try {
    const wt = getCeilingType(project, ceiling);
    if (wt.layers.length === 0) return null;
    const comp = getComponent(project, wt.layers[0].componentId);
    const category = getLayerCategory(project, ceiling.categoryCode);
    const hatchId =
      resolveHatchId(ceiling.hatchId, ceiling.hatchSource, category, comp.hatchId) ?? comp.hatchId;
    const hatch = resolveHatch(
      project,
      hatchId,
      undefined,
      resolveForeground(comp, ceiling.foreground, category, ceiling.foregroundSource),
    );
    // Poché-Hintergrund neutral (Papier) statt Bauteil-Albedo; Vollmuster → Tinte
    // — dieselbe Neutralisierung wie {@link resolveWallSectionStyle}, damit die
    // geschnittene Decke nicht als andersfarbige Fläche gegenüber der Wand auffällt.
    const solid = hatch.pattern === "solid";
    return {
      fill: solid ? HATCH_INK : HATCH_PAPER,
      hatch,
    };
  } catch {
    return null;
  }
}

export interface Plan {
  primitives: Primitive[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Erzeugt den Grundriss eines Geschosses, gefiltert nach sichtbaren Ebenen
 * (Kategorie-Codes).
 *
 * Enthält Wände dieses Geschosses, deren `categoryCode` ∈ `visibleCodes`. Eine
 * Türöffnung gehört zur Wandgeometrie und wird stets ausgespart; das
 * Tür-SYMBOL (Blatt + Bogen) erscheint nur, wenn der Tür-Code sichtbar ist.
 */
export function generatePlan(
  project: Project,
  floorId: string,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver = SHOW_ALL,
  detail: DetailLevel = "mittel",
  showReferenceLines = false,
  mono = false,
): Plan {
  const primitives: Primitive[] = [];
  // Aktives Geschoss (für die Grundriss-Schnitthöhe der Treppen).
  const floor = project.drawingLevels.find((z) => z.id === floorId);
  // Code → Kategorie-Strichstärke (mm), damit die Wand-Umrisslinie aus dem
  // Modell (Ebene) stammt statt aus einer Magie-Konstante.
  const lwByCode = categoryLwMap(project.layers);
  const colorByCode = categoryColorMap(project.layers);
  // Code → volle LayerCategory, für die By-Layer-Attribut-Auflösung (Quelle
  // "layer" von Vordergrund/Hintergrund/Strichstärke/Schraffur).
  const catByCode = categoryMap(project.layers);

  // ── Grafische Overrides (Regel-Engine, src/overrides/engine.ts) ───────────
  // Effektive Aktionen je Element als OBERSTE Schicht ÜBER der regulären
  // By-Layer/By-Object-Auflösung: die Elemente werden hier — rein zur
  // Renderzeit — mit den Regel-Ergebnissen dekoriert (flache Kopien; das
  // Projekt bleibt unverändert, jederzeit reversibel). `layer_name` matcht
  // Ebenen-Name ODER -Code, `object_name` den Element-/Typ-Namen.
  const overrideFor = (
    categoryCode: string,
    objectName?: string,
  ): OverrideActions =>
    effectiveOverrides(project.overrideRules, {
      layerName: catByCode.get(categoryCode)?.name,
      layerCode: categoryCode,
      objectName,
    });
  const wallTypeNameById = new Map(project.wallTypes.map((t) => [t.id, t.name]));
  const ceilingTypeNameById = new Map(
    (project.ceilingTypes ?? []).map((t) => [t.id, t.name]),
  );

  // Sichtbarkeit wie bisher; der Darstellungsmodus verfeinert sie zusätzlich:
  // render=false blendet die Wand aus, greyed=true dimmt sie.
  const walls = project.walls
    .filter(
      (w) =>
        w.floorId === floorId &&
        visibleCodes.has(w.categoryCode) &&
        categoryDisplay(w.categoryCode).render,
    )
    .map((w) => {
      // Regel-Override gewinnt über den Per-Instanz-Wert (oberste Schicht):
      // Farbe → Umriss-/Fugenfarbe (Wall.color), Strichstärke → strokeWeight
      // (der topmost-Wert der bestehenden resolveStrokeWeight-Kette).
      const ov = overrideFor(w.categoryCode, wallTypeNameById.get(w.wallTypeId));
      if (!hasOverrides(ov)) return w;
      return {
        ...w,
        color: ov.color ?? w.color,
        strokeWeight: ov.lineweight ?? w.strokeWeight,
      };
    });

  // Freie 2D-Zeichengeometrie dieses Geschosses (wie Wände nach sichtbaren
  // Kategorien + Darstellungsmodus gefiltert). Wird über der Wand-Poché
  // gezeichnet (am Ende angehängt).
  const drawings = project.drawings2d
    .filter(
      (d) =>
        d.levelId === floorId &&
        visibleCodes.has(d.categoryCode) &&
        categoryDisplay(d.categoryCode).render,
    )
    .map((d) => {
      // `object_name` matcht bei freier 2D-Geometrie den Formnamen
      // (line/polyline/rect/circle/arc/text). Linienstil-Override nur hier —
      // Drawing2D ist das einzige Element mit LineStyle-Referenz.
      const ov = overrideFor(d.categoryCode, d.geom.shape);
      if (!hasOverrides(ov)) return d;
      return {
        ...d,
        color: ov.color ?? d.color,
        weightMm: ov.lineweight ?? d.weightMm,
        lineStyleId: ov.linetypeId ?? d.lineStyleId,
      };
    });

  // Decken dieses Geschosses (wie Wände nach sichtbaren Kategorien +
  // Darstellungsmodus gefiltert). Eine Decke liegt (als Slab) über der
  // Schnittebene → im Grundriss als gefüllter/schraffierter Umriss dargestellt,
  // UNTER der Wand-Poché (damit die Wände darüber lesbar bleiben).
  const ceilings = (project.ceilings ?? [])
    .filter(
      (c) =>
        c.floorId === floorId &&
        visibleCodes.has(c.categoryCode) &&
        categoryDisplay(c.categoryCode).render,
    )
    .map((c) => {
      // Decken: nur der Farb-Override wirkt (der Umriss ist eine feste
      // Überkopf-Haarlinie, siehe addCeilingPoche — keine Strichstärke).
      const typeName =
        (c.ceilingTypeId ? ceilingTypeNameById.get(c.ceilingTypeId) : undefined) ??
        wallTypeNameById.get(c.wallTypeId);
      const ov = overrideFor(c.categoryCode, typeName);
      return ov.color !== undefined ? { ...c, color: ov.color } : c;
    });
  // Wand-Footprints für das Verdecken der (darunterliegenden) Decken-Umrisse:
  // die Decke liegt als Slab über der Schnittebene, ihre Umrisslinie soll dort,
  // wo eine Wand darüber steht, NICHT durch die Wand-Poché schlagen. Nur nötig,
  // wenn es überhaupt Decken gibt.
  const wallFootprints = ceilings.length ? buildWallFootprints(project, walls) : [];
  for (const ceiling of ceilings) {
    const greyed = categoryDisplay(ceiling.categoryCode).greyed;
    const category = catByCode.get(ceiling.categoryCode);
    // Kein lwMm mehr: der Decken-Umriss ist eine feste Überkopf-Haarlinie
    // (gestrichelt), unabhängig von der Kategorie-Strichstärke.
    addCeilingPoche(primitives, project, ceiling, greyed, detail, category, wallFootprints);
  }

  // Dächer dieses Geschosses (Dachaufsicht): reine Grundriss-Linien (Traufe/
  // First/Grat/Knick), kein Poché. Über der Wand-Poché gezeichnet.
  const roofs = (project.roofs ?? []).filter(
    (r) =>
      r.floorId === floorId &&
      visibleCodes.has(r.categoryCode) &&
      categoryDisplay(r.categoryCode).render,
  );
  for (const roof of roofs) {
    const greyed = categoryDisplay(roof.categoryCode).greyed;
    const category = catByCode.get(roof.categoryCode);
    addRoof(primitives, roof, greyed, category);
  }

  // Räume (SIA-416-Flächen) dieses Geschosses: transluzente Farbfüllung + Stempel
  // (Name + Fläche + SIA-Tag). UNTER der Wand-Poché gezeichnet, damit die Wände
  // lesbar bleiben. Der Stempel (Text) entfällt beim Detailgrad „grob".
  const rooms = roomsOfFloor(project, floorId)
    .filter(
      (r) =>
        visibleCodes.has(r.categoryCode) && categoryDisplay(r.categoryCode).render,
    )
    .map((r) => {
      // Räume: `object_name` matcht den Raum-Namen; der Farb-Override färbt
      // Fläche + Stempel (Room.color) um.
      const ov = overrideFor(r.categoryCode, r.name);
      return ov.color !== undefined ? { ...r, color: ov.color } : r;
    });
  for (const room of rooms) {
    const greyed = categoryDisplay(room.categoryCode).greyed;
    addRoomArea(primitives, room, greyed, detail);
  }

  // Gehrungs-Schnittlinien einmal pro Plan berechnen (auf der gefilterten Menge).
  const joins = computeJoins(project, walls);

  for (const wall of walls) {
    const wallGreyed = categoryDisplay(wall.categoryCode).greyed;
    const wallCategory = catByCode.get(wall.categoryCode);
    const wallLwMm = resolveStrokeWeight(
      wall.strokeWeight,
      wall.strokeWeightSource,
      wallCategory,
      lwByCode.get(wall.categoryCode) ?? WALL_FALLBACK_MM,
    );
    // Türen (Legacy) + Öffnungen (Fenster/Türen) am Wandhost: BEIDE sparen die
    // Wand-Poché aus. Aus beiden wird eine gemeinsame Lücken-Intervall-Liste.
    const doors = project.doors.filter((d) => d.hostWallId === wall.id);
    const openings = openingsOfWall(project, wall.id);
    const gaps = wallGaps(wall, doors, openings);
    const cuts = joins.get(wall.id) ?? { startCut: null, endCut: null };
    // Schnitt vs. Ansicht nach Schnitthöhe (BIM-Standard): erreicht die Wand die
    // Grundriss-Schnittebene nicht (Höhe < Schnitthöhe des Geschosses, z. B. eine
    // Brüstung/ein Podestrand), wird sie nur als Ansichts-Umriss gezeichnet —
    // keine Schnitt-Poché. Normale Wände (Höhe ≥ Schnitthöhe) sind unberührt.
    const wallViewOnly = wall.height < (floor?.cutHeight ?? 1.0);
    addWallPoche(
      primitives, project, wall, gaps, cuts, wallGreyed, detail, wallLwMm, wallCategory, wallViewOnly,
    );
    // Referenzlinie: dünne gestrichelte Wand-Achslinie (von der Oberleiste
    // umschaltbar). Wird über der Poché gezeichnet, damit sie sichtbar bleibt.
    if (showReferenceLines) addReferenceLine(primitives, wall, wallGreyed);
    // Tür-Symbol (Legacy-Door) nur, wenn die Kategorie sichtbar ist und der Modus
    // sie zeigt.
    for (const door of doors) {
      const d = categoryDisplay(door.categoryCode);
      if (visibleCodes.has(door.categoryCode) && d.render) {
        const doorLwMm = lwByCode.get(door.categoryCode) ?? LAYER_LINE_MM;
        addDoorSymbol(primitives, wall, door, d.greyed, detail, doorLwMm);
      }
    }
    // Öffnungs-Symbole (Fenster/Tür) je Detailgrad + Auswahl-taggbar.
    for (const o of openings) {
      const d = categoryDisplay(o.categoryCode);
      if (visibleCodes.has(o.categoryCode) && d.render) {
        // Override-Regeln: `object_name` matcht das Öffnungs-Label
        // („Tür 90×210" / „Fenster 120×140").
        const ov = overrideFor(o.categoryCode, openingLabel(o));
        const oLwMm =
          ov.lineweight ?? lwByCode.get(o.categoryCode) ?? LAYER_LINE_MM;
        const effO = ov.color !== undefined ? { ...o, color: ov.color } : o;
        addOpeningSymbol(primitives, project, wall, effO, d.greyed, detail, oLwMm);
      }
    }
  }

  // Treppen dieses Geschosses: Tritte + Lauflinie + Auf-/Abpfeil, mit dem
  // Grundriss-Schnitt (Tritte unter der Schnitthöhe durchgezogen, darüber
  // gestrichelt/verdeckt + SIA-Bruchlinie). Über der Wand-Poché gezeichnet.
  const cutHeight = floor?.cutHeight ?? 1.0;
  const stairs = stairsOfFloor(project, floorId).filter(
    (s) =>
      visibleCodes.has(s.categoryCode) && categoryDisplay(s.categoryCode).render,
  );
  for (const stair of stairs) {
    const greyed = categoryDisplay(stair.categoryCode).greyed;
    // Override-Regeln: `object_name` matcht das Treppen-Label („Gerade 16 STG").
    const ov = overrideFor(stair.categoryCode, stairLabel(stair));
    const lwMm =
      ov.lineweight ?? lwByCode.get(stair.categoryCode) ?? WALL_FALLBACK_MM;
    const effStair = ov.color !== undefined ? { ...stair, color: ov.color } : stair;
    addStairSymbol(primitives, project, effStair, greyed, lwMm, cutHeight);
  }

  // Stützen (Tragwerk) dieses Geschosses: Querschnitt-Poché (Rechteck/Kreis),
  // um `rotation` gedreht, auf Kategorie „50". Über der Wand-Poché gezeichnet.
  const columns = columnsOfFloor(project, floorId).filter(
    (col) =>
      visibleCodes.has(col.categoryCode) && categoryDisplay(col.categoryCode).render,
  );
  for (const column of columns) {
    const greyed = categoryDisplay(column.categoryCode).greyed;
    const category = catByCode.get(column.categoryCode);
    const ov = overrideFor(column.categoryCode, columnLabel(column));
    const lwMm =
      ov.lineweight ?? resolveStrokeWeight(undefined, undefined, category, lwByCode.get(column.categoryCode) ?? WALL_FALLBACK_MM);
    const effCol = ov.color !== undefined ? { ...column, color: ov.color } : column;
    addColumnPoche(primitives, project, effCol, greyed, lwMm, category);
  }

  // 2D-Zeichengeometrie zuletzt (über der Poché).
  for (const d of drawings) {
    const greyed = categoryDisplay(d.categoryCode).greyed;
    addDrawing2D(primitives, project, d, greyed, lwByCode, colorByCode, catByCode);
  }

  // Extrudierte Körper (truck-Integration): das Quell-Profil wurde beim
  // Extrudieren aus `drawings2d` entfernt (s. `extrude.ts` appendExtrudedSolid)
  // — im Grundriss erscheint stattdessen der Footprint-Umriss des Körpers
  // selbst (Haarlinie, kein Poché/Schraffur; Farbe wie das 3D-Orange).
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.levelId === floorId) addExtrudedSolidOutline(primitives, solid);
  }

  // Kontext-Konturen (Höhenlinien) als dezente Linien zeichnen — UNTER der
  // Wand-Poché wäre ideal, aber da sie eine eigene gedämpfte Farbe tragen, ist
  // die Reihenfolge unkritisch; wir hängen sie als Referenz an.
  addContextContours(primitives, project);

  // Schwarz-Weiss (mono): nachträglich alle Farben auf reine Tinte zwingen.
  // Element-/Kategorie-/Hatch-Farben werden ignoriert, Füllungen werden weiss,
  // Musterlinien/Striche schwarz — so entsteht ein reiner S/W-Plan.
  if (mono) toMono(primitives);

  return {
    primitives,
    bounds: computeBounds(project, walls, drawings, ceilings, stairs, rooms, roofs),
  };
}

// ── Schnitt/Ansicht (abgeleitete Projektion aus render3d::section) ──────────────
// Die Rohdaten (Cut-Polygone + sichtbare/verdeckte projizierte Kanten) liefert
// der WASM-Extraktor (plan/toSection.ts → section.rs). Hier werden sie 1:1 in
// die BESTEHENDEN Plan-Primitive übersetzt — kein neues Primitiv nötig:
//   • Cut-Polygon  → `polygon` (kräftige Poché-Umrisslinie + Schnitt-Schraffur),
//   • sichtbare Kante → `line` (durchgezogen),
//   • verdeckte Kante → `line` (gestrichelt).
// Damit rendern PlanView (SVG) UND toRenderScene (Engine/WASM-2D) den Schnitt
// ohne jede Sonderbehandlung, mit voller Papier-mm-/Parität-Infrastruktur.

/** Tinte der Schnitt-Poché-Umrisslinie + Schraffur (dunkles Grau). */
const SECTION_INK = "#1f242c";
/** Tinte der sichtbaren Ansichtskanten. */
const SECTION_VISIBLE_INK = "#2b3039";
/** Tinte der verdeckten (gestrichelten) Ansichtskanten (etwas heller). */
const SECTION_HIDDEN_INK = "#8a929c";
/** Strichstärke der Cut-Poché-Umrisslinie (mm Papier, kräftig wie eine Wand). */
const SECTION_CUT_OUTLINE_MM = 0.35;
/** Strichstärke sichtbarer Ansichtskanten (mm Papier). */
const SECTION_VISIBLE_MM = 0.18;
/** Strichstärke verdeckter Ansichtskanten (mm Papier, dünner). */
const SECTION_HIDDEN_MM = 0.13;
/** Strichmuster verdeckter Kanten (mm Papier). */
const SECTION_HIDDEN_DASH: number[] = [0.12, 0.08];

/**
 * Schnitt-Schraffur der Cut-Flächen (diagonale Poché wie ein Wandschnitt) —
 * Fallback, wenn `toSection.ts` das Quell-Bauteil einer Cut-Fläche NICHT
 * auflösen konnte (siehe `attachCutStyles`). Vordergrund fest `HATCH_INK`,
 * damit auch der Fallback monochrom bleibt statt der rohen 3D-Albedo-Farbe.
 */
const SECTION_HATCH: HatchRender = {
  pattern: "diagonal",
  scale: 1,
  angle: 45,
  color: HATCH_INK,
  lineWeight: 0.13,
  dash: null,
};

/**
 * Baut aus einem {@link SectionOutput} (render3d::section, (u, v)-Meter) den
 * Plan eines Schnitts/einer Ansicht. `u` wird zur Plan-X, `v` (absolute Höhe)
 * zur Plan-Y — die PlanView zeigt Y nach oben, also erscheint der Schnitt
 * aufrecht. Rein darstellend; kennt das Projekt nicht.
 */
export function generateSectionPlan(output: SectionOutput, mono = false): Plan {
  const primitives: Primitive[] = [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  // Cut-Polygone: gefüllte Poché-Fläche + Schnitt-Schraffur + kräftige
  // Umrisslinie — wie eine geschnittene Wand im Grundriss. `toSection.ts`
  // (computeSection) löst je Cut-Polygon bereits das Quell-Bauteil auf und
  // hängt dessen echte Füllfarbe/Schraffur an (`cp.fill`/`cp.hatch`); fehlt
  // diese Auflösung (Fallback, z. B. verwaistes Bauteil), greift die generische
  // Schnitt-Schraffur (`SECTION_HATCH`, HATCH_PAPER-Hintergrund) — NICHT die rohe
  // Albedo-Farbe aus dem 3D-Modell (Nutzer-Vorgabe 2026-07-04: einheitlich
  // monochrom, auch im Fallback-Fall).
  for (const cp of output.cutPolygons) {
    if (cp.pts.length < 3) continue;
    const pts: Vec2[] = cp.pts.map(([u, v]) => {
      acc(u, v);
      return { x: u, y: v };
    });
    const fill = cp.fill ?? HATCH_PAPER;
    const hatch = cp.hatch ?? SECTION_HATCH;
    // Mono: neutrale Poché — Papier statt Bauteilfarbe, Schraffur-Musterlinien →
    // Tinte. Eine dunkle SIA-Vollpoché ("solid") BLEIBT jedoch dunkel
    // (Tinte bleibt Tinte, Papier bleibt Papier).
    const solid = hatch.pattern === "solid";
    const monoFill = solid ? HATCH_INK : HATCH_PAPER;
    const monoHatch =
      solid ? hatch : hatch.pattern !== "none" ? { ...hatch, color: SECTION_INK } : hatch;
    primitives.push({
      kind: "polygon",
      pts,
      fill: mono ? monoFill : fill,
      stroke: SECTION_INK,
      strokeWidthMm: SECTION_CUT_OUTLINE_MM,
      hatch: mono ? monoHatch : hatch,
    });
  }

  // Verdeckte Kanten zuerst (liegen unter den sichtbaren), gestrichelt.
  for (const e of output.hiddenEdges) {
    acc(e.a[0], e.a[1]);
    acc(e.b[0], e.b[1]);
    primitives.push({
      kind: "line",
      a: { x: e.a[0], y: e.a[1] },
      b: { x: e.b[0], y: e.b[1] },
      cls: "section-hidden",
      weightMm: SECTION_HIDDEN_MM,
      dash: SECTION_HIDDEN_DASH,
      color: SECTION_HIDDEN_INK,
    });
  }

  // Sichtbare Ansichtskanten, durchgezogen.
  for (const e of output.visibleEdges) {
    acc(e.a[0], e.a[1]);
    acc(e.b[0], e.b[1]);
    primitives.push({
      kind: "line",
      a: { x: e.a[0], y: e.a[1] },
      b: { x: e.b[0], y: e.b[1] },
      cls: "section-visible",
      weightMm: SECTION_VISIBLE_MM,
      color: SECTION_VISIBLE_INK,
    });
  }

  if (!isFinite(minX)) return { primitives, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
  return { primitives, bounds: { minX, minY, maxX, maxY } };
}

/** Dezente Plan-Farbe der Kontext-Konturen (gedämpftes Grau). */
const CONTEXT_LINE_COLOR = "#9aa3ad";
/** Strichstärke der Kontext-Konturen (mm Papier, dünn). */
const CONTEXT_LINE_MM = 0.1;

/**
 * Zeichnet die Konturen (Höhenlinien) der Kontext-Schicht `project.context` als
 * dünne, gedämpfte Referenz-Linien in den Grundriss. Die Z-Höhe wird ignoriert
 * (reine 2D-Projektion). TerrainMeshes/ImportedMeshes erscheinen im Plan NICHT
 * (3D genügt). Rein additiv — Wand-/Drawing-Darstellung bleibt unberührt.
 */
function addContextContours(out: Primitive[], project: Project): void {
  const context = project.context ?? [];
  for (const obj of context) {
    if (obj.type !== "contourSet") continue;
    for (const c of obj.contours) {
      const pts = c.pts;
      if (pts.length < 2) continue;
      const segEnd = c.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segEnd; i++) {
        out.push({
          kind: "line",
          a: pts[i],
          b: pts[(i + 1) % pts.length],
          cls: "context-line",
          weightMm: CONTEXT_LINE_MM,
          color: CONTEXT_LINE_COLOR,
        });
      }
    }
  }
}

/**
 * Post-Pass für den Schwarz-Weiss-Modus: ersetzt alle Farb-Informationen der
 * Plan-Primitive durch einheitliche Tinte/Weiss. Wirkt in-place.
 * - Polygone: Füllung → weiss, Umriss → Tinte, Schraffur-Musterlinien → Tinte
 *   (Vollfüllung „solid" wird zu Weiss neutralisiert, damit keine Poché-Farbe).
 * - Linien: explizite Strichfarbe → Tinte (CSS-Klassen sind bereits neutral).
 * - Bögen tragen keine Farbe (rein CSS, neutral) → unverändert.
 */
function toMono(primitives: Primitive[]): void {
  for (const p of primitives) {
    if (p.kind === "polygon") {
      // SIA-Poché in mono: Vollmuster „solid" ist eine SCHWARZE Poché und bleibt
      // schwarz (Schwarz bleibt Schwarz); jede andere Füllung wird weiß, die
      // Linien-/Kreuzschraffur bleibt sichtbar, aber in Tinte.
      if (p.hatch.pattern === "solid") {
        p.hatch = { ...p.hatch, color: HATCH_INK };
        p.fill = p.fill === "none" ? "none" : HATCH_INK;
      } else {
        if (p.hatch.pattern !== "none") p.hatch = { ...p.hatch, color: MONO_INK };
        p.fill = p.fill === "none" ? "none" : "#ffffff";
      }
      p.stroke = MONO_INK;
    } else if (p.kind === "line") {
      p.color = MONO_INK;
    } else if (p.kind === "text") {
      p.color = MONO_INK;
    }
  }
}

/** Baut eine Map Kategorie-Code → Strichstärke (mm) über den ganzen Baum. */
function categoryLwMap(layers: LayerCategory[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of flattenCategories(layers)) map.set(c.code, c.lw);
  return map;
}

/** Baut eine Map Kategorie-Code → Farbe über den ganzen Baum. */
function categoryColorMap(layers: LayerCategory[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of flattenCategories(layers)) map.set(c.code, c.color);
  return map;
}

/**
 * Baut eine Map Kategorie-Code → volle LayerCategory über den ganzen Baum, für
 * die By-Layer-Attribut-Auflösung (Quelle "layer" von Vordergrund/Hintergrund/
 * Strichstärke/Schraffur, siehe {@link resolveForeground} und Geschwister).
 */
function categoryMap(layers: LayerCategory[]): Map<string, LayerCategory> {
  const map = new Map<string, LayerCategory>();
  for (const c of flattenCategories(layers)) map.set(c.code, c);
  return map;
}

/** Footprint-Farbe der truck-Extrusionen im Grundriss (identisch zum 3D-Orange EXTRUSION_RGB in toWalls3d.ts). */
const EXTRUSION_STROKE = "#d98c40";

/**
 * Footprint-Umriss eines extrudierten Körpers (truck-Integration) im Grundriss:
 * reine Haarlinie ohne Füllung/Schraffur — analog zur Ansichtslinie einer Wand
 * unter der Schnitthöhe ({@link addWallPoche} `viewOnly`), da der Körper (noch)
 * keine Schnitt-Poché/Kategorie-Zuordnung hat.
 */
function addExtrudedSolidOutline(out: Primitive[], solid: ExtrudedSolid): void {
  out.push({
    kind: "polygon",
    pts: solid.points,
    fill: "none",
    stroke: EXTRUSION_STROKE,
    strokeWidthMm: SYMBOL_HAIRLINE_MM,
    hatch: NO_HATCH,
    extrudedSolidId: solid.id,
  });
}

/** Fallback-Poché-Füllung einer Stütze ohne (auflösbares) Bauteil: neutrale Tinte. */
const COLUMN_FALLBACK_FILL = "#3a3f47";

/**
 * Grundriss-Querschnitt einer Stütze (Column) als Schnitt-Poché: gefülltes
 * Polygon (Rechteck bzw. tesselliertes Kreisprofil), an `position` platziert und
 * um `rotation` gedreht. Trägt — sofern ein Bauteil (`componentId`) auflösbar ist
 * — dessen Füllung + Schraffur (dieselbe Auflösung wie Wand/Decke, {@link
 * resolveWallSectionStyle}); sonst eine neutrale Vollton-Poché. `columnId` macht
 * die Fläche links-klick-selektierbar (analog Extrusion/Raum).
 */
function addColumnPoche(
  out: Primitive[],
  project: Project,
  column: Column,
  greyed: boolean,
  lwMm: number,
  category: LayerCategory | undefined,
): void {
  const pts = columnFootprint(column);
  const stroke = column.color ?? category?.color ?? MONO_INK;
  let fill = column.color ?? category?.color ?? COLUMN_FALLBACK_FILL;
  let hatch: HatchRender = NO_HATCH;
  if (column.componentId) {
    try {
      const comp = getComponent(project, column.componentId);
      const hatchId =
        resolveHatchId(undefined, undefined, category, comp.hatchId) ?? comp.hatchId;
      const resolved = resolveHatch(
        project,
        hatchId,
        undefined,
        resolveForeground(comp, undefined, category, undefined),
      );
      hatch = resolved;
      fill = resolved.pattern === "solid" ? HATCH_INK : HATCH_PAPER;
    } catch {
      // Bauteil nicht auflösbar → neutrale Poché (Fallback bleibt bestehen).
    }
  }
  out.push({
    kind: "polygon",
    pts,
    fill,
    stroke,
    strokeWidthMm: lwMm,
    hatch,
    greyed,
    columnId: column.id,
  });
}

/**
 * Leitet ein 2D-Zeichenelement in Plan-Primitive ab (docs/design/drawing-tools.md
 * §7.2). Farbe/Strichstärke kommen aus dem optionalen LineStyle, sonst aus der
 * Kategorie. Phase 1 deckt line/polyline/rect ab (alles → line-Primitive);
 * circle/arc/text folgen mit den Primitive-Erweiterungen (Phase 3).
 */
function addDrawing2D(
  out: Primitive[],
  project: Project,
  d: Drawing2D,
  greyed: boolean,
  lwByCode: Map<string, number>,
  colorByCode: Map<string, string>,
  catByCode: Map<string, LayerCategory>,
): void {
  const category = catByCode.get(d.categoryCode);
  const ls = d.lineStyleId
    ? project.lineStyles.find((l) => l.id === d.lineStyleId)
    : undefined;
  // Plan-Tinte fix dunkel: Fallback auf MONO_INK (statt hell „#d0d0d0"), damit
  // ein kategorieloses 2D-Element auf dem hellen Papier sichtbar bleibt.
  const color = d.color ?? ls?.color ?? colorByCode.get(d.categoryCode) ?? MONO_INK;
  // Strichstärke: "layer" erzwingt die Ebenen-Strichstärke (umgeht das
  // LineStyle-Gewicht), sonst (Default "object") die heutige Kette.
  const weightMm = resolveStrokeWeight(
    d.weightMm,
    d.strokeWeightSource,
    category,
    ls?.weight ?? lwByCode.get(d.categoryCode) ?? WALL_FALLBACK_MM,
  );
  const dash = ls?.dash ?? null;
  // Drawing2D trägt kein Bauteil → die By-Layer-Quelle ist hier die einzige
  // Alternative zum expliziten Wert (kein Component-Fallback); Default
  // "object"/undefined bleibt exakt das heutige Verhalten.
  const foreground = d.foreground ?? (d.foregroundSource === "layer" ? category?.color : undefined);
  const background = d.background ?? (d.backgroundSource === "layer" ? category?.color : undefined);
  const hatchId = resolveHatchId(d.hatchId, d.hatchSource, category, undefined);
  // Zickzack-Parameter aus dem LineStyle durchreichen (nur kind==="zigzag").
  // Additiv: fehlt es, bleibt die Linie gerade/gestrichelt wie bisher.
  const zigzag = ls?.kind === "zigzag" ? ls.zigzag : undefined;
  // Custom-Motiv analog durchreichen (nur kind==="custom").
  const motif = ls?.kind === "custom" ? ls.motif : undefined;
  const seg = (a: Vec2, b: Vec2) =>
    out.push({ kind: "line", a, b, cls: "draw2d", weightMm, dash, zigzag, motif, color, greyed, drawingId: d.id });

  /**
   * Gefüllte Fläche einer GESCHLOSSENEN Form: trägt die Vollton-Füllfarbe
   * (`d.fillColor`, sonst transparent) UND die optionale Füllschraffur
   * (`d.hatchId`, sonst NO_HATCH). Wird VOR den Strichen gepusht, damit die
   * Umrisslinien oben liegen. Trägt `drawingId`, sodass ein Klick auf die Fläche
   * das Element selektiert (analog zu den Linien).
   */
  const fillPoly = (pts: Vec2[]) =>
    out.push({
      kind: "polygon",
      pts,
      // Hintergrund-Override (Wert ?? By-Layer) hat Vorrang vor dem Alt-Feld
      // fillColor (alle leer = transparente Fläche, nur Schraffur) — Sample
      // bleibt identisch (kein Element setzt background/backgroundSource).
      fill: background ?? d.fillColor ?? "none",
      // Umriss zeichnen die separaten Linien-Primitive (mit Strichmuster); die
      // Füllfläche selbst bleibt randlos, um doppelte Striche zu vermeiden.
      stroke: "none",
      strokeWidthMm: 0,
      // Drawing2D trägt kein Bauteil → Vordergrund/Schraffur-Override direkt aus
      // d.foreground/d.hatchId bzw. der Ebene (Attribut „Nach System" ⇒
      // undefined ⇒ HatchStyle.color-Fallback bzw. NO_HATCH).
      hatch: hatchId ? resolveHatch(project, hatchId, undefined, foreground) : NO_HATCH,
      greyed,
      drawingId: d.id,
    });

  const g = d.geom;
  switch (g.shape) {
    case "line":
      seg(g.a, g.b);
      break;
    case "polyline": {
      // Geschlossene Polylinie: zuerst die gefüllte Fläche (Vollton/Schraffur).
      if (g.closed && g.pts.length > 2) fillPoly(g.pts);
      for (let i = 0; i < g.pts.length - 1; i++) seg(g.pts[i], g.pts[i + 1]);
      if (g.closed && g.pts.length > 2) seg(g.pts[g.pts.length - 1], g.pts[0]);
      break;
    }
    case "rect": {
      const c1 = g.min;
      const c2 = { x: g.max.x, y: g.min.y };
      const c3 = g.max;
      const c4 = { x: g.min.x, y: g.max.y };
      // Rechteck ist immer geschlossen → zuerst die gefüllte Fläche.
      fillPoly([c1, c2, c3, c4]);
      seg(c1, c2);
      seg(c2, c3);
      seg(c3, c4);
      seg(c4, c1);
      break;
    }
    case "circle":
      // Echtes Kreis-Primitiv → glattes `<circle>` (rund bei jedem Zoom) mit
      // optionaler Vollton-Füllung. Ersetzt die frühere 64-Ecken-Approximation.
      out.push({
        kind: "drawingCircle",
        center: g.center,
        r: g.r,
        fill: background ?? d.fillColor ?? "none",
        stroke: color,
        weightMm,
        dash,
        greyed,
        drawingId: d.id,
      });
      break;
    case "arc":
      // Echtes Bogen-Primitiv → glatter SVG-Bogenpfad (Winkel in Radiant).
      out.push({
        kind: "drawingArc",
        center: g.center,
        r: g.r,
        a0: g.a0,
        a1: g.a1,
        stroke: color,
        weightMm,
        dash,
        greyed,
        drawingId: d.id,
      });
      break;
    case "text":
      out.push({
        kind: "drawingText",
        at: g.at,
        text: g.text,
        heightM: g.height,
        angle: g.angle,
        // marks.color (falls gesetzt) übersteuert die Kategorie-/Elementfarbe.
        color: g.marks?.color ?? color,
        ...(g.width && g.width > 0 ? { wrapWidth: g.width } : {}),
        ...(g.marks ? { marks: g.marks } : {}),
        greyed,
        drawingId: d.id,
      });
      break;
    default:
      break;
  }
}

/**
 * Wand als gefüllte Schnittfläche (Poché), um Öffnungen ausgespart.
 *
 * Detailgrad:
 *  • mittel/fein — jede Schicht des Wandtyps als eigenes Band (Füllfarbe +
 *    Schraffur des Bauteils), dazu eine kräftige Wand-Umrisslinie. fein zeichnet
 *    Schichtfugen und Umriss dünner als mittel.
 *  • grob — KEINE Schichten, KEINE Schraffur: eine einzige Sammelfläche über die
 *    volle Wanddicke (Füllung = Farbe des „Backbone"-Bauteils mit höchster
 *    joinPriority) mit dicker Umrisslinie. Bewusst vereinfacht (≙ DOSSIER
 *    „Einfach").
 */
/**
 * Ein Öffnungs-Intervall entlang der Wandachse (from..to in Metern). `headHeight`
 * = Sturzhöhe (OK der Öffnung über der Wand-UK) für die 3D-Aussparung; im Plan
 * ungenutzt, aber Teil des gemeinsamen Vertrags mit dem 3D-Pfad.
 */
export interface WallGap {
  from: number;
  to: number;
}

/**
 * Vereint Legacy-Türen (`Door`) und Öffnungen (`Opening`) einer Wand zu einer
 * sortierten Lücken-Intervall-Liste entlang der Wandachse. Entartete Intervalle
 * (Breite ≤ 0 oder außerhalb der Achse) werden verworfen.
 */
export function wallGaps(
  wall: Wall,
  doors: Project["doors"],
  openings: Opening[],
): WallGap[] {
  const gaps: WallGap[] = [];
  for (const d of doors) gaps.push({ from: d.position, to: d.position + d.width });
  for (const o of openings) {
    const iv = openingInterval(wall, o);
    if (iv) gaps.push(iv);
  }
  return gaps.sort((a, b) => a.from - b.from);
}

/** Toleranz für die Achsen-Intervall-Arithmetik der Durchgangswand-Aussparungen. */
const CUTOUT_EPS = 1e-9;

/**
 * Zieht die Loch-Intervalle `holes` vom Segment `[s,e]` ab und liefert die
 * verbleibenden (gezeichneten) Teil-Intervalle in Achsen-Metern. Löcher werden
 * auf `[s,e]` geklemmt, sortiert und vereinigt; leeres Ergebnis heisst „ganz
 * ausgespart". Ist `holes` leer, kommt exakt `[[s,e]]` zurück (unverändertes
 * Verhalten für Wände ohne Aussparung).
 */
function subtractIntervals(
  s: number,
  e: number,
  holes: Array<[number, number]>,
): Array<[number, number]> {
  const clipped = holes
    .map(([a, b]): [number, number] => [
      Math.max(s, Math.min(a, b)),
      Math.min(e, Math.max(a, b)),
    ])
    .filter(([a, b]) => b > a + CUTOUT_EPS)
    .sort((p, q) => p[0] - q[0]);
  const parts: Array<[number, number]> = [];
  let cursor = s;
  for (const [a, b] of clipped) {
    if (a > cursor + CUTOUT_EPS) parts.push([cursor, a]);
    if (b > cursor) cursor = b;
  }
  if (cursor < e - CUTOUT_EPS) parts.push([cursor, e]);
  return parts;
}

/**
 * Wand-Footprint als orientiertes Rechteck (OBB) für das Verdecken der
 * darunterliegenden Decke im Grundriss: Achs-Startpunkt + Einheits-Richtung `u`
 * und -Normale `m`, Halbdicke, Referenz-Querversatz (Wandachse↔Bandmitte) und
 * Achslänge. Die u-Ausdehnung wird beim Test an beiden Enden um die Halbdicke
 * verlängert, damit auch die Eck-Überlappe (Gehrungen) sicher abgedeckt sind.
 */
interface WallFootprint {
  a: Vec2;
  u: Vec2;
  m: Vec2;
  len: number;
  half: number;
  refOff: number;
}

/** Baut die Wand-Footprints (OBBs) aus den gerenderten Wänden. Nicht auflösbarer
 *  Wandtyp ⇒ Default-Dicke 0.2 m (wie der Vollkörper-Fallback im 3D-Emitter). */
function buildWallFootprints(project: Project, walls: Wall[]): WallFootprint[] {
  const out: WallFootprint[] = [];
  for (const w of walls) {
    let t = 0.2;
    try {
      t = wallTypeThickness(getWallType(project, w));
    } catch {
      // Default-Dicke behalten.
    }
    const u = normalize(sub(w.end, w.start));
    out.push({
      a: w.start,
      u,
      m: leftNormal(u),
      len: Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y),
      half: t / 2,
      refOff: wallReferenceOffset(w, t),
    });
  }
  return out;
}

/**
 * Parametrisches Intervall [t0,t1] ⊆ [0,1], über das die Strecke `pa→pb`
 * INNERHALB des Wand-Footprints liegt (also von der Wand verdeckt). `null`, wenn
 * die Strecke den Footprint nicht schneidet. OBB-Test über zwei Slabs: Projektion
 * auf die Achse `u` (Bereich [−half, len+half]) und auf die Normale `m` (Bereich
 * [refOff−half, refOff+half]); das Schnitt-Intervall beider Slabs ∩ [0,1] ist die
 * verdeckte Strecke.
 */
function segmentInsideWallBand(
  pa: Vec2,
  pb: Vec2,
  fp: WallFootprint,
): [number, number] | null {
  const d = sub(pb, pa);
  const rel = sub(pa, fp.a);
  const clipSlab = (
    f0: number,
    fd: number,
    lo: number,
    hi: number,
  ): [number, number] | null => {
    if (Math.abs(fd) < 1e-12)
      return f0 >= lo - CUTOUT_EPS && f0 <= hi + CUTOUT_EPS ? [0, 1] : null;
    let ta = (lo - f0) / fd;
    let tb = (hi - f0) / fd;
    if (ta > tb) [ta, tb] = [tb, ta];
    return [ta, tb];
  };
  const su = clipSlab(dot(rel, fp.u), dot(d, fp.u), -fp.half, fp.len + fp.half);
  if (!su) return null;
  const sm = clipSlab(
    dot(rel, fp.m),
    dot(d, fp.m),
    fp.refOff - fp.half,
    fp.refOff + fp.half,
  );
  if (!sm) return null;
  const t0 = Math.max(0, su[0], sm[0]);
  const t1 = Math.min(1, su[1], sm[1]);
  return t1 > t0 + CUTOUT_EPS ? [t0, t1] : null;
}

function addWallPoche(
  out: Primitive[],
  project: Project,
  wall: Wall,
  gaps: WallGap[],
  cuts: WallCuts,
  greyed: boolean,
  detail: DetailLevel,
  wallLwMm: number,
  category: LayerCategory | undefined,
  // Wand liegt GANZ unter der Grundriss-Schnittebene (z. B. 30-cm-Brüstung bei
  // 1 m Schnitthöhe) → „von oben gesehen": nur Ansichts-Umriss (Haarlinie), KEINE
  // Schnitt-Poché/Schraffur/Schichten. Der reguläre Schnittfall bleibt `false`.
  viewOnly: boolean,
): void {
  const wt = getWallType(project, wall);
  const total = wallTypeThickness(wt);
  // Versatz der Schichtstapelung über die Dicke gemäß Referenzlinie (center=0,
  // left=+T/2, right=−T/2). Alle Band-Offsets unten werden hierum verschoben,
  // sodass die Achse bei „außen"/„innen" auf der jeweiligen Wandfläche liegt.
  const refOff = wallReferenceOffset(wall, total);
  // Jede Schicht-/Umrissfläche trägt die Wand-ID, damit ein Links-Klick die
  // GANZE Wand (alle Bänder) markiert und die PlanView die wallId nach oben
  // melden kann.
  const wallId = wall.id;
  // Achswinkel der Wand (Modell, Grad) — treibt wandbezogene Schraffuren
  // ({@link resolveHatch}), damit z. B. eine Diagonale oder die Dämmungsstriche
  // mit der Wandorientierung mitdrehen.
  const wallAngleDeg =
    (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
  // Strich-/Umrandungsfarbe der Wand: optionale Übersteuerung (wall.color),
  // sonst der Default-Poché-Strich. Betrifft NUR die Linienfarbe (Umriss +
  // Schichtfugen), nicht die Schicht-Füllfarben/Schraffuren.
  const stroke = wall.color ?? POCHE_STROKE;

  // Öffnungs-Intervalle entlang der Wandachse, sortiert (bereits vereint).
  const openings = gaps;

  // Wand in Segmente zwischen den Öffnungen zerlegen.
  let cursor = 0;
  const segments: Array<[number, number]> = [];
  for (const op of openings) {
    if (op.from > cursor) segments.push([cursor, op.from]);
    cursor = Math.max(cursor, op.to);
  }
  const axisLen = length(wall);
  if (cursor < axisLen) segments.push([cursor, axisLen]);

  const outlineMm = wallLwMm * OUTLINE_DETAIL_FACTOR[detail];
  const layerLineMm = LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail];
  // Vereinfachte Füllung (grob): neutrale SIA-Poché des tragenden Bauteils
  // (höchste Priorität) — weiß, bzw. schwarz falls dessen Muster "solid" ist.
  const simpleFill = backbonePocheFill(project, wt);

  // Durchgangswand-Aussparungen (Phase 1c): über diese Achsen-Intervalle × Quer-
  // Offsetbereiche wird die Nah-Putz-Zone der Durchgangswand echt ausgeschnitten
  // (der Abzweig-Kern sticht durch). `offA` ist stets die Nahfläche, `offB` die
  // Rückgrat-Nahfläche (siehe SpanCutout in model/joins.ts). Leer ⇒ heutiges
  // Verhalten (Wand ohne T-Durchstoss).
  const spanCutouts = cuts.spanCutouts ?? [];

  // Kanten-Indizes der inneren Gehrungs-Stirnflächen (die Diagonalen am Knoten).
  // clippedBand liefert [A.start, A.end, B.end, B.start] → Kante 1 (A.end→B.end)
  // ist die endCut-Stirnfläche, Kante 3 (B.start→A.start) die startCut-Stirnfläche.
  // Diese werden NICHT umrissen: sonst 45°-Naht zwischen gleichfarbigen Schichten
  // + überschießende Gehrungs-Barbe am Eck-Apex. Freie Enden (kein Cut) bleiben
  // rechtwinklig gestrichen. Die Längskanten (Schichtfugen) bleiben stets sichtbar.
  const joinEdges = (startCut: Line | null, endCut: Line | null): number[] => {
    const e: number[] = [];
    if (endCut) e.push(1);
    if (startCut) e.push(3);
    return e;
  };

  for (const [s, e] of segments) {
    const p1 = along(wall.start, wall.end, s);
    const p2 = along(wall.start, wall.end, e);
    // Nur die echten Wandenden bekommen die Gehrung. Türnahe Segmentenden
    // bleiben rechtwinklig (kein Schnitt).
    const startCut = s <= 1e-6 ? cuts.startCut : null;
    const endCut = e >= axisLen - 1e-6 ? cuts.endCut : null;

    if (viewOnly) {
      // Ansichts-Wand (unter der Schnittebene): ein Umriss über die volle Dicke
      // als Haarlinie, ohne Füllung/Schraffur. Segment-/Gehrungs-/Öffnungs-Logik
      // bleibt dieselbe wie im Schnittfall (nur eben ohne Poché).
      out.push({
        kind: "polygon",
        pts: clippedBand(p1, p2, refOff - total / 2, refOff + total / 2, startCut, endCut),
        fill: "none",
        stroke,
        strokeWidthMm: layerLineMm,
        hatch: NO_HATCH,
        greyed,
        noStrokeEdges: joinEdges(startCut, endCut),
        wallId,
      });
      continue;
    }

    if (detail === "grob") {
      // Eine Sammelfläche über die volle Dicke, ohne Schraffur, dicker Umriss.
      out.push({
        kind: "polygon",
        pts: clippedBand(p1, p2, refOff - total / 2, refOff + total / 2, startCut, endCut),
        fill: simpleFill,
        stroke,
        strokeWidthMm: outlineMm,
        hatch: NO_HATCH,
        greyed,
        noStrokeEdges: joinEdges(startCut, endCut),
        wallId,
      });
      continue;
    }

    // mittel/fein: Schichten von außen (-T/2) nach innen (+T/2) stapeln. Jede
    // Schicht löst Bauteil (Füllfarbe) + Schraffur (Muster/Maßstab/Winkel/Farbe)
    // auf. Die Bänder tragen NUR Füllung + Schraffur (kein eigener Umriss); jede
    // innere Schichtfuge wird als EIGENSTÄNDIGE, stilisierbare Linie gezeichnet.
    const bandJoinEdges = joinEdges(startCut, endCut);
    // Nur die Aussparungen, die dieses Segment [s,e] entlang der Achse berühren.
    const segCutouts = spanCutouts.filter(
      (c) =>
        Math.min(c.from, c.to) < e - CUTOUT_EPS &&
        Math.max(c.from, c.to) > s + CUTOUT_EPS,
    );
    // Punkt entlang der Wandachse bei Achsen-Meter `d` (p1/p2 an den Rändern).
    const axisPt = (d: number): Vec2 =>
      d === s ? p1 : d === e ? p2 : along(wall.start, wall.end, d);
    // Materialbewusster T-Stoss (siehe resolveJoinPriority in model/joins.ts):
    // liegt eine Pro-Schicht-Cut-Überschreibung vor, ersetzt sie PRO SCHICHT den
    // einheitlichen startCut/endCut — nur an den echten Wandenden (dieselbe
    // Maskierung wie oben für startCut/endCut, s <= 1e-6 / e >= axisLen-1e-6).
    // Fehlt sie, bleibt alles wie zuvor (startCut/endCut für jede Schicht).
    const layerCuts = cuts.layerCuts;
    let off = refOff - total / 2;
    for (let li = 0; li < wt.layers.length; li++) {
      const layer = wt.layers[li];
      const comp = getComponent(project, layer.componentId);
      const layerHatchId =
        resolveHatchId(wall.hatchId, wall.hatchSource, category, comp.hatchId) ?? comp.hatchId;
      const layerHatch = resolveHatch(
        project,
        layerHatchId,
        wallAngleDeg,
        resolveForeground(comp, wall.foreground, category, wall.foregroundSource),
      );
      // SIA-Poché: neutraler Hintergrund (Papier) statt Bauteil-Albedo, die
      // Schichtschraffur (fest in HATCH_INK, siehe resolveHatch) liegt darüber;
      // Vollmuster ("solid") = Tinten-Poché.
      const layerSolid = layerHatch.pattern === "solid";
      const layerStartCut = s <= 1e-6 ? (layerCuts ? layerCuts.start[li] : startCut) : null;
      const layerEndCut = e >= axisLen - 1e-6 ? (layerCuts ? layerCuts.end[li] : endCut) : null;
      // Durchgangswand-Aussparung: liegt der Quer-Offsetbereich dieses Bandes
      // [off, off+thickness] im Nah-Putz-Bereich einer Aussparung, wird das Band
      // entlang der Achse in Teil-Bänder VOR/NACH dem Intervall zerlegt (das
      // Durchstoss-Stück entfällt). Ohne Überlappung bleibt genau ein Band
      // [s,e] (unverändertes Verhalten).
      const bandLo = off;
      const bandHi = off + layer.thickness;
      const bandHoles: Array<[number, number]> = [];
      for (const c of segCutouts) {
        const cLo = Math.min(c.offA, c.offB);
        const cHi = Math.max(c.offA, c.offB);
        if (bandLo < cHi - CUTOUT_EPS && bandHi > cLo + CUTOUT_EPS)
          bandHoles.push([c.from, c.to]);
      }
      for (const [a, b] of subtractIntervals(s, e, bandHoles)) {
        const sc = a <= s + CUTOUT_EPS ? layerStartCut : null;
        const ec = b >= e - CUTOUT_EPS ? layerEndCut : null;
        out.push({
          kind: "polygon",
          pts: clippedBand(axisPt(a), axisPt(b), off, off + layer.thickness, sc, ec),
          fill: layerSolid ? HATCH_INK : HATCH_PAPER,
          // Band ohne Umriss: keine Schichtfuge über die Bandkante, keine 45°-Naht
          // am Knoten. Die Fugen kommen als separate `line`-Primitive (siehe unten).
          stroke: "none",
          strokeWidthMm: 0,
          hatch: layerHatch,
          greyed,
          // Für die Ecktests/Konsistenz beibehalten (bei stroke:"none" wirkungslos).
          noStrokeEdges: bandJoinEdges,
          wallId,
        });
      }
      // L-Anschluss: eine getrimmte Schicht (z. B. Putz), die an eine
      // verschmelzende Nachbarschicht (durchlaufender Kern) grenzt, bekommt
      // zusätzlich eine seitliche Cut-Linie entlang der Durchgangsachse — sie
      // begrenzt die Schichtbreite dort, wo der Kern sie unterbricht (L-Form).
      const sideStart = s <= 1e-6 ? layerCuts?.startSide[li] : null;
      const sideEnd = e >= axisLen - 1e-6 ? layerCuts?.endSide[li] : null;
      if (sideStart || sideEnd) {
        const uSeg = normalize(sub(p2, p1));
        const nSeg = leftNormal(uSeg);
        const sidePoint = (base: Vec2, layerOff: number, cut: Line): Vec2 => {
          const pt = add(base, scale(nSeg, layerOff));
          return lineIntersect(pt, uSeg, cut.point, cut.dir) ?? pt;
        };
        if (sideStart) {
          out.push({
            kind: "line",
            a: sidePoint(p1, off, sideStart),
            b: sidePoint(p1, off + layer.thickness, sideStart),
            cls: "layer-joint-l",
            weightMm: layerLineMm,
            color: stroke,
            greyed,
          });
        }
        if (sideEnd) {
          out.push({
            kind: "line",
            a: sidePoint(p2, off, sideEnd),
            b: sidePoint(p2, off + layer.thickness, sideEnd),
            cls: "layer-joint-l",
            weightMm: layerLineMm,
            color: stroke,
            greyed,
          });
        }
      }
      off += layer.thickness;
      // Innere Schichtfuge (zwischen dieser und der nächst-inneren Schicht) als
      // eigene Linie am kumulierten Offset `off`, mit dem Cut der Bänder geclippt.
      // Stil aus layer.jointLineStyleId (Gewicht/Farbe/Strich); Rückfall = Haar-
      // linie (LAYER_LINE_MM) in Wandfarbe. Das Gewicht folgt demselben Detail-
      // Faktor wie die frühere Schichtfuge (`layerLineMm`), damit die Detailgrade
      // sich unverändert verhalten. Die innerste Schicht hat keine innere Fuge.
      // Nutzt bewusst weiterhin den einheitlichen startCut/endCut (nicht die
      // Pro-Schicht-Cuts): die Fuge markiert den Materialwechsel INNERHALB
      // dieser Wand und bleibt daher an der bisherigen Nahfläche.
      if (li < wt.layers.length - 1) {
        const jls = layer.jointLineStyleId
          ? project.lineStyles.find((l) => l.id === layer.jointLineStyleId)
          : undefined;
        // Durchgangswand-Aussparung: liegt die Fuge im (geschlossenen) Nah-Putz-
        // Bereich einer Aussparung — inkl. der Rückgrat-Nahfläche (Merge-Kontakt)
        // —, wird sie über das Durchstoss-Intervall unterbrochen. So bleibt an der
        // Verschmelzungsfläche keine Trennlinie stehen.
        const fugeHoles: Array<[number, number]> = [];
        for (const c of segCutouts) {
          const cLo = Math.min(c.offA, c.offB);
          const cHi = Math.max(c.offA, c.offB);
          if (off >= cLo - CUTOUT_EPS && off <= cHi + CUTOUT_EPS)
            fugeHoles.push([c.from, c.to]);
        }
        for (const [a, b] of subtractIntervals(s, e, fugeHoles)) {
          const sc = a <= s + CUTOUT_EPS ? startCut : null;
          const ec = b >= e - CUTOUT_EPS ? endCut : null;
          // clippedBand(pa, pb, off, off, …) liefert [edgeStart, edgeEnd, edgeEnd,
          // edgeStart] → die zwei distinkten Endpunkte sind Index 0 (Start) und 1
          // (Ende), beide am Cut abgeschnitten wie die Bandlängskante.
          const jq = clippedBand(axisPt(a), axisPt(b), off, off, sc, ec);
          out.push({
            kind: "line",
            a: jq[0],
            b: jq[1],
            cls: "layer-joint",
            weightMm: jls ? jls.weight * LAYER_DETAIL_FACTOR[detail] : layerLineMm,
            color: jls ? jls.color : stroke,
            dash: jls ? jls.dash : null,
            // Zickzack-Fuge (LineStyle kind==="zigzag") ebenfalls durchreichen.
            zigzag: jls?.kind === "zigzag" ? jls.zigzag : undefined,
            // Custom-Motiv-Fuge (LineStyle kind==="custom") ebenfalls durchreichen.
            motif: jls?.kind === "custom" ? jls.motif : undefined,
            greyed,
          });
        }
      }
    }
    // Kräftige Wand-Umrisslinie über die volle Dicke (nur Kontur, keine Füllung),
    // damit die Wand sich klar von den dünnen Schichtfugen abhebt. Die Gehrungs-
    // Stirnkanten am Knoten entfallen → sauberer Eck-Apex ohne überschießende Barbe.
    // Bei einer Durchgangswand-Aussparung wird zusätzlich die NAHFLÄCHEN-Kante
    // (die Längskante auf der Durchstoss-Seite) über [from,to] strokelos gemacht
    // und als separate Segmente vor/nach dem Durchstoss gezeichnet — sonst liefe
    // die Umrisslinie über die Durchstoss-Breite.
    const offLo = refOff - total / 2;
    const offHi = refOff + total / 2;
    const holesHi: Array<[number, number]> = [];
    const holesLo: Array<[number, number]> = [];
    for (const c of segCutouts) {
      // `offA` ist stets die Nahfläche (Wandoberfläche); ordne die Aussparung der
      // passenden Längskante (offHi bzw. offLo) zu.
      if (Math.abs(c.offA - offHi) < 1e-6) holesHi.push([c.from, c.to]);
      else if (Math.abs(c.offA - offLo) < 1e-6) holesLo.push([c.from, c.to]);
    }
    const outlineNoStroke = [...bandJoinEdges];
    // clippedBand-Kantenreihenfolge [A.start(offLo), A.end(offLo), B.end(offHi),
    // B.start(offHi)]: Kante 0 ist die offLo-Längskante, Kante 2 die offHi-Längskante.
    if (holesHi.length) outlineNoStroke.push(2);
    if (holesLo.length) outlineNoStroke.push(0);
    out.push({
      kind: "polygon",
      pts: clippedBand(p1, p2, offLo, offHi, startCut, endCut),
      fill: "none",
      stroke,
      strokeWidthMm: outlineMm,
      hatch: NO_HATCH,
      greyed,
      noStrokeEdges: outlineNoStroke,
      wallId,
    });
    const drawNearEdge = (edgeOff: number, holes: Array<[number, number]>): void => {
      for (const [a, b] of subtractIntervals(s, e, holes)) {
        const sc = a <= s + CUTOUT_EPS ? startCut : null;
        const ec = b >= e - CUTOUT_EPS ? endCut : null;
        const jq = clippedBand(axisPt(a), axisPt(b), edgeOff, edgeOff, sc, ec);
        out.push({
          kind: "line",
          a: jq[0],
          b: jq[1],
          cls: "wall-outline",
          weightMm: outlineMm,
          color: stroke,
          greyed,
        });
      }
    };
    if (holesHi.length) drawNearEdge(offHi, holesHi);
    if (holesLo.length) drawNearEdge(offLo, holesLo);
  }
}

/**
 * Neutrale SIA-Poché-Füllung des tragenden Bauteils (höchste joinPriority) für
 * die grobe Sammelfläche: Papier, bzw. Tinte falls dessen Schraffur "solid" ist.
 * (Ersetzt die frühere rohe Bauteil-Albedo — im Plan zählt die Poché, nicht die
 * 3D-Materialfarbe.)
 */
function backbonePocheFill(project: Project, wt: Project["wallTypes"][number]): string {
  let best: { pattern: HatchPattern; prio: number } | null = null;
  for (const layer of wt.layers) {
    const comp = getComponent(project, layer.componentId);
    if (!best || comp.joinPriority > best.prio)
      best = { pattern: getHatch(project, comp.hatchId).pattern, prio: comp.joinPriority };
  }
  return best ? pocheFill(best.pattern) : HATCH_PAPER;
}

/**
 * Tür-Symbol je Detailgrad:
 *  • grob   — nur die gerade Türblatt-Linie (die Öffnungs-Lücke kommt aus der
 *             ausgesparten Poché).
 *  • mittel — + Schwenkbogen (geschlossen → offen).
 *  • fein   — + Rahmen/Anschlag-Striche an beiden Pfosten (kurze Striche quer
 *             zur Wand, die den Türrahmen/-anschlag andeuten).
 */
function addDoorSymbol(
  out: Primitive[],
  wall: Wall,
  door: Project["doors"][number],
  greyed: boolean,
  detail: DetailLevel,
  _doorLwMm: number,
): void {
  const u = normalize(sub(wall.end, wall.start));
  const n = leftNormal(u); // linke Seite der Wandachse
  const swingDir = door.swing === "left" ? n : scale(n, -1);

  const jambStart = along(wall.start, wall.end, door.position);
  const jambEnd = along(wall.start, wall.end, door.position + door.width);
  const hinge = door.hinge === "start" ? jambStart : jambEnd;
  const closedDir = door.hinge === "start" ? u : scale(u, -1);

  const openEnd = add(hinge, scale(swingDir, door.width));
  const closedEnd = add(hinge, scale(closedDir, door.width));

  // Türblatt in geöffneter Stellung (alle Stufen).
  out.push({
    kind: "line",
    a: hinge,
    b: openEnd,
    cls: "door-leaf",
    weightMm: SYMBOL_HAIRLINE_MM,
    greyed,
  });

  // mittel + fein: Schwenkbogen von geschlossen → offen.
  if (detail !== "grob") {
    out.push({
      kind: "arc",
      center: hinge,
      from: closedEnd,
      to: openEnd,
      r: door.width,
      cls: "door-swing",
      weightMm: SYMBOL_HAIRLINE_MM,
      greyed,
    });
  }

  // fein: Rahmen/Anschlag-Striche an beiden Pfosten (kurz quer zur Wand,
  // symmetrisch um die Achse über eine halbe Wanddicke-Andeutung).
  if (detail === "fein") {
    const reveal = 0.06; // 6 cm Anschlag-Andeutung je Seite
    for (const jamb of [jambStart, jambEnd]) {
      out.push({
        kind: "line",
        a: add(jamb, scale(n, reveal)),
        b: add(jamb, scale(n, -reveal)),
        cls: "door-frame",
        weightMm: SYMBOL_HAIRLINE_MM,
        greyed,
      });
    }
  }
}

/**
 * Aufgelöste Rahmen-Parameter (Typ-Bibliothek) einer Tür-/Fenster-Öffnung —
 * nur vorhanden, wenn die Öffnung einen Bauteil-Typ referenziert (`typeId`).
 * Fehlt der Typ, bleibt das heutige Inline-Verhalten unverändert (kein
 * Rahmenband, kein Oberlicht) — siehe `resolveOpeningFrameSpec`.
 */
interface OpeningFrameSpec {
  frameWidth: number;
  /** Nur bei Türen relevant; Fenster zeichnen stets die schmale Zargen-Optik. */
  frameKind: "zarge" | "blockrahmen";
  insetFromFace: number;
  insetFace: "aussen" | "innen";
  transomHeight: number;
}

/**
 * Löst die Rahmen-Parameter aus dem referenzierten Tür-/Fenstertyp auf (samt
 * Defaults); `undefined`, wenn kein Typ referenziert/auflösbar ist — die
 * Öffnung bleibt dann beim heutigen Inline-Verhalten (rückwärtskompatibel).
 */
function resolveOpeningFrameSpec(project: Project, o: Opening): OpeningFrameSpec | undefined {
  if (o.kind === "door") {
    const t = getDoorType(project, o);
    if (!t) return undefined;
    return {
      frameWidth: t.frameWidth ?? 0.06,
      frameKind: t.frameKind ?? "zarge",
      insetFromFace: t.insetFromFace ?? 0,
      insetFace: t.insetFace ?? "aussen",
      transomHeight: t.transomHeight ?? 0,
    };
  }
  const t = getWindowType(project, o);
  if (!t) return undefined;
  return {
    frameWidth: t.frameWidth ?? 0.06,
    frameKind: "zarge",
    insetFromFace: t.insetFromFace ?? 0,
    insetFace: t.insetFace ?? "aussen",
    transomHeight: t.transomHeight ?? 0,
  };
}

/**
 * Rahmenband + Oberlicht-Andeutung einer Tür-/Fenstertyp-Öffnung im
 * Grundriss-Schnitt. Nur aufgerufen, wenn `resolveOpeningFrameSpec` einen Typ
 * liefert — sonst bleibt die Darstellung exakt wie zuvor (kein neues Primitiv).
 *
 *  • Zarge             — schmales Umlauf-Rahmenband, ringsum um `frameWidth`
 *    von der vollen Öffnung (Pfosten × Wanddicke) nach innen eingezogen.
 *  • Blockrahmen (Tür) — kräftiges Rechteckprofil, sitzt PROUD an der
 *    gewählten Fläche (kein Einzug an den Pfosten, nur eine Tiefenscheibe von
 *    `frameWidth` ab der Nah-Fläche), kräftigere Linie.
 *  • Schichteinzug     — verschiebt die Nah-Fläche des Rahmens um
 *    `insetFromFace` von der gewählten Wandfläche nach innen; die Gegenfläche
 *    bleibt unverändert (der Rahmen reicht weiterhin bis dorthin).
 *  • Oberlicht         — Überkopf-Andeutung (gestrichelte Linie quer über die
 *    Öffnung), nur wenn `transomHeight > 0`.
 */
function addOpeningFrameBand(
  out: Primitive[],
  project: Project,
  wall: Wall,
  o: Opening,
  spec: OpeningFrameSpec,
  greyed: boolean,
): void {
  const jambs = openingJambs(wall, o);
  if (!jambs) return;
  const { n } = wallAxisFrame(wall);
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  const outerFace = refOff + total / 2; // "aussen"-Fläche (+n)
  const innerFace = refOff - total / 2; // "innen"-Fläche (−n)

  // Schichteinzug: die GEWÄHLTE Fläche rückt um `insetFromFace` nach innen; die
  // gegenüberliegende Fläche bleibt unverändert (der Rahmen reicht weiterhin
  // bis dorthin) — vgl. DoorType.insetFromFace/WindowType.insetFromFace.
  const clampedInset = Math.max(0, Math.min(spec.insetFromFace, total));
  const nearIsAussen = spec.insetFace !== "innen";
  const faceNear = nearIsAussen ? outerFace - clampedInset : innerFace + clampedInset;
  const faceFar = nearIsAussen ? innerFace : outerFace;
  const lo = Math.min(faceNear, faceFar);
  const hi = Math.max(faceNear, faceFar);

  const { jambStart, jambEnd } = jambs;
  const color = o.color ?? POCHE_STROKE;

  // Rahmen-Rechteck NUR bei Türen zeichnen. Beim Fenster stellt bereits
  // `windowSymbol` den Rahmen dar (voller Öffnungsumriss + Glaslinien); ein
  // zusätzliches Band ergäbe ein doppeltes, verschachteltes Rechteck — genau
  // das wirkte im 2D „nicht korrekt". Die Tür hat dort nur Blatt+Bogen, daher
  // ist ihr Rahmenband die einzige Rahmenkontur und bleibt.
  if (o.kind === "door") {
    const frameWidth = Math.max(0, spec.frameWidth);
    const isBlock = spec.frameKind === "blockrahmen";
    let bandLo: number;
    let bandHi: number;
    let jStart: Vec2;
    let jEnd: Vec2;
    let weightMm: number;
    if (isBlock) {
      // Blockrahmen: volle Öffnungsbreite (kein Pfosten-Einzug), nur eine
      // Tiefenscheibe von frameWidth ab der Nah-Fläche — sitzt proud VOR/auf der
      // Laibung, statt schmal darin zu verschwinden (Zargen-Optik).
      const depth = Math.min(frameWidth, hi - lo);
      bandLo = nearIsAussen ? hi - depth : lo;
      bandHi = nearIsAussen ? hi : lo + depth;
      jStart = jambStart;
      jEnd = jambEnd;
      weightMm = SYMBOL_HAIRLINE_MM * 2.2;
    } else {
      // Zarge: ringsum um frameWidth von der vollen Öffnung eingezogenes,
      // schmales Rahmenband (Laibungs-Anschlaglinie).
      const jambSpan = Math.hypot(jambEnd.x - jambStart.x, jambEnd.y - jambStart.y);
      const jambInset = Math.min(frameWidth, jambSpan / 2);
      jStart = along(jambStart, jambEnd, jambInset);
      jEnd = along(jambEnd, jambStart, jambInset);
      const depthInset = Math.min(frameWidth, (hi - lo) / 2);
      bandLo = lo + depthInset;
      bandHi = hi - depthInset;
      weightMm = SYMBOL_HAIRLINE_MM;
    }

    // Geschlossenes Rechteck aus 4 Kanten (Primitive "line", nicht "polygon" —
    // so bleibt das Band per `cls` selektierbar/testbar wie die übrigen Symbole).
    const p1 = add(jStart, scale(n, bandLo));
    const p2 = add(jEnd, scale(n, bandLo));
    const p3 = add(jEnd, scale(n, bandHi));
    const p4 = add(jStart, scale(n, bandHi));
    const edges: [Vec2, Vec2][] = [
      [p1, p2],
      [p2, p3],
      [p3, p4],
      [p4, p1],
    ];
    for (const [a, b] of edges) {
      out.push({
        kind: "line",
        a,
        b,
        cls: "opening-frame",
        weightMm,
        color,
        greyed,
        openingId: o.id,
      });
    }
  }

  // Oberlicht (Überkopf-Andeutung): eine gestrichelte Linie quer über die
  // Öffnung auf der Wandachse — nur wenn der Typ ein Oberlicht definiert.
  if (spec.transomHeight > 0) {
    out.push({
      kind: "line",
      a: jambStart,
      b: jambEnd,
      cls: "opening-transom",
      weightMm: SYMBOL_HAIRLINE_MM,
      dash: OVERHEAD_DASH,
      color,
      greyed,
      openingId: o.id,
    });
  }
}

/**
 * Öffnungs-Symbol (Fenster/Tür) je Detailgrad. Anders als das Legacy-`addDoorSymbol`
 * arbeitet diese Funktion über die reinen Geometrie-Helfer (opening.ts) und taggt
 * ihre Primitive mit `openingId`, sodass die Öffnung im Plan selektierbar ist.
 *
 * Tür:
 *  • grob   — gerade Türblatt-Linie (die Lücke kommt aus der ausgesparten Poché).
 *  • mittel — + Schwenkbogen (Öffnungswinkel).
 *  • fein   — + Anschlag-Striche an beiden Pfosten.
 * Fenster:
 *  • grob   — eine einzelne Glaslinie über die Lücke.
 *  • mittel — Rahmen-Rechteck (Umriss) + eine Glaslinie.
 *  • fein   — Rahmen + zwei Glaslinien (Doppelverglasung angedeutet).
 */
function addOpeningSymbol(
  out: Primitive[],
  project: Project,
  wall: Wall,
  o: Opening,
  greyed: boolean,
  detail: DetailLevel,
  lwMm: number,
): void {
  if (o.kind === "door") {
    const sym = doorSymbol(wall, o);
    if (!sym) return;
    // Unsichtbares Pick-Polygon über der Öffnungslücke (Laibung × Wanddicke) —
    // damit die Tür wie ein Fenster per Punkt-in-Polygon über die ganze
    // Öffnungsfläche selektierbar ist (Türsymbol besteht sonst nur aus dünnem
    // Blatt + Bogen, die man exakt treffen müsste). fill/stroke "none" ⇒ zeichnet
    // nichts; `pickOpening` (PlanView) testet nur die `pts`.
    const gap = openingGapQuad(project, wall, o);
    if (gap) {
      out.push({
        kind: "polygon",
        pts: gap,
        fill: "none",
        stroke: "none",
        strokeWidthMm: 0,
        hatch: NO_HATCH,
        greyed,
        openingId: o.id,
      });
    }
    // Tür-Typ „wandoeffnung": reiner Wanddurchbruch — KEIN Türblatt, KEIN
    // Schwenkbogen. Nur die Öffnung/Laibung bleibt (die Wandlücke kommt aus der
    // ausgesparten Poché; Sturz-/Anschlaglinien werden weiter unten gezeichnet).
    // Entspricht `oeff_tuer_typ == "wandoeffnung"` im Rhino-Plugin.
    const isWandoeffnung = (o.doorType ?? "normal") === "wandoeffnung";
    if (!isWandoeffnung) {
      // Türblatt (alle Stufen).
      out.push({
        kind: "line",
        a: sym.hinge,
        b: sym.openEnd,
        cls: "door-leaf",
        weightMm: SYMBOL_HAIRLINE_MM,
        greyed,
        openingId: o.id,
      });
      // mittel + fein: Schwenkbogen von geschlossen → offen.
      if (detail !== "grob") {
        out.push({
          kind: "arc",
          center: sym.hinge,
          from: sym.closedEnd,
          to: sym.openEnd,
          r: sym.radius,
          cls: "door-swing",
          weightMm: SYMBOL_HAIRLINE_MM,
          greyed,
          openingId: o.id,
        });
      }
    }
    // fein: Anschlag-Striche an beiden Pfosten (quer zur Wand).
    if (detail === "fein") {
      const reveal = 0.06;
      for (const jamb of [sym.jambStart, sym.jambEnd]) {
        out.push({
          kind: "line",
          a: add(jamb, scale(sym.normal, reveal)),
          b: add(jamb, scale(sym.normal, -reveal)),
          cls: "door-frame",
          weightMm: SYMBOL_HAIRLINE_MM,
          greyed,
          openingId: o.id,
        });
      }
    }
    // Rahmenband (Zarge/Blockrahmen) + Oberlicht-Andeutung — nur wenn die
    // Öffnung einen Türtyp referenziert (siehe `resolveOpeningFrameSpec`).
    const doorFrameSpec = resolveOpeningFrameSpec(project, o);
    if (doorFrameSpec) addOpeningFrameBand(out, project, wall, o, doorFrameSpec, greyed);
    // Sturzlinien (SIA, gestrichelt) — Überkopf-Projektion des Sturzes quer über
    // die Öffnung an der Wand-Innen-/Aussenkante. Entspricht `_make_tuer_sturz_curves`
    // im Rhino-Plugin. Default „beide" wenn nicht explizit gesetzt.
    const lintelMode = o.lintelLines ?? "beide";
    if (lintelMode !== "keine") {
      const jambs = openingJambs(wall, o);
      if (jambs) {
        const { n } = wallAxisFrame(wall);
        const total = wallTypeThickness(getWallType(project, wall));
        const refOff = wallReferenceOffset(wall, total);
        const halfD = total / 2;
        const outerOff = refOff + halfD;
        const innerOff = refOff - halfD;
        // Strichmuster: gestrichelt (Überkopf-Projektion, SIA-Konvention).
        const dash: number[] = [0.18, 0.09];
        const strokeColor = o.color ?? POCHE_STROKE;
        /** Linie quer über die Öffnung am gegebenen Perp-Offset. */
        const lintelLine = (perpOff: number) => ({
          a: add(jambs.jambStart, scale(n, perpOff)),
          b: add(jambs.jambEnd,   scale(n, perpOff)),
        });
        if (lintelMode === "aussen" || lintelMode === "beide") {
          const seg = lintelLine(outerOff);
          out.push({
            kind: "line" as const,
            a: seg.a,
            b: seg.b,
            cls: "door-lintel",
            weightMm: SYMBOL_HAIRLINE_MM,
            dash,
            color: strokeColor,
            greyed,
            openingId: o.id,
          });
        }
        if (lintelMode === "innen" || lintelMode === "beide") {
          const seg = lintelLine(innerOff);
          out.push({
            kind: "line" as const,
            a: seg.a,
            b: seg.b,
            cls: "door-lintel",
            weightMm: SYMBOL_HAIRLINE_MM,
            dash,
            color: strokeColor,
            greyed,
            openingId: o.id,
          });
        }
      }
    }
    return;
  }

  // Fenster: Rahmen (mittel/fein) + Glaslinie(n) je Detailgrad + Fenstertyp.
  const wt = getWindowType(project, o);
  // Flügeltabelle NUR übergeben, wenn ein Fenstertyp auflösbar ist — fehlt er
  // (kein `typeId`/unbekannt), bleibt `windowSymbol` beim reinen
  // `o.wingCount`-Alt-Verhalten (siehe dortiger Kommentar, Regressionssicherheit).
  const sashes = wt ? sashesOfWindowType(wt) : undefined;
  const detailGlassCount = detail === "fein" ? 2 : 1;
  // Verglasungs-Scheibenzahl des Typs (glazingPanesOf) hebt die Detailgrad-
  // Vorgabe bei mittel/fein an (mind. so viele Glaslinien); "grob" bleibt bei
  // einer Glaslinie, unabhängig vom Typ (bleibt die schlichteste Stufe).
  const glassCount =
    detail === "grob" ? detailGlassCount : Math.max(detailGlassCount, wt ? glazingPanesOf(wt) : 0);
  const sym = windowSymbol(project, wall, o, glassCount, sashes);
  if (!sym) return;
  // Unsichtbares Pick-Polygon über der Öffnungslücke — macht das Fenster über
  // die ganze Fläche selektierbar, auch bei „grob" (nur eine Glaslinie, sonst
  // schwer zu treffen). Siehe Tür-Zweig oben.
  const wgap = openingGapQuad(project, wall, o);
  if (wgap) {
    out.push({
      kind: "polygon",
      pts: wgap,
      fill: "none",
      stroke: "none",
      strokeWidthMm: 0,
      hatch: NO_HATCH,
      greyed,
      openingId: o.id,
    });
  }
  if (detail !== "grob") {
    // Rahmen-Rechteck als reine Umrisslinie (Poché-Stroke, keine Füllung).
    out.push({
      kind: "polygon",
      pts: sym.frame,
      fill: "none",
      stroke: o.color ?? POCHE_STROKE,
      strokeWidthMm: lwMm,
      hatch: NO_HATCH,
      greyed,
      openingId: o.id,
    });
    // Flügel-/Pfosten-Trennlinien — reine Querlinien innerhalb des Rahmens
    // (kein Strichmuster). Nur mittel/fein; entfällt bei grob/schema.
    for (const [a, b] of sym.mullionLines) {
      out.push({
        kind: "line",
        a,
        b,
        cls: "window-mullion",
        weightMm: SYMBOL_HAIRLINE_MM,
        color: o.color ?? POCHE_STROKE,
        greyed,
        openingId: o.id,
      });
    }
    // Öffnungsandeutung je NICHT-festem Flügel (Dreh/Kipp/Drehkipp/Schiebe) —
    // schlichte Diagonale zur Bandseite, nur wenn ein Fenstertyp mit
    // Flügeltabelle referenziert ist (siehe windowSymbol/sashOpeningLines).
    for (const [a, b] of sym.sashOpeningLines) {
      out.push({
        kind: "line",
        a,
        b,
        cls: "window-opening",
        weightMm: SYMBOL_HAIRLINE_MM,
        color: o.color ?? POCHE_STROKE,
        greyed,
        openingId: o.id,
      });
    }
  }
  for (const [a, b] of sym.glassLines) {
    out.push({
      kind: "line",
      a,
      b,
      cls: "window-glass",
      weightMm: SYMBOL_HAIRLINE_MM,
      greyed,
      openingId: o.id,
    });
  }
  // Rahmenband (Zarge) + Oberlicht-Andeutung — nur wenn die Öffnung einen
  // Fenstertyp referenziert (siehe `resolveOpeningFrameSpec`). Kämpfer-Zeilen
  // (`mullionRows`) bleiben im Grundriss-Schnitt unsichtbar (3D-Sache).
  const windowFrameSpec = resolveOpeningFrameSpec(project, o);
  if (windowFrameSpec) addOpeningFrameBand(out, project, wall, o, windowFrameSpec, greyed);
  // fein: Anschlag-/Laibungsstriche an beiden Pfosten (kurz quer zur Wand) —
  // analog zur Tür, damit Fenster im Detailplan gleich „fertig" wirken (bisher
  // hatten nur Türen sie). Haarlinie, 6 cm Andeutung je Seite.
  if (detail === "fein") {
    const jambs = openingJambs(wall, o);
    const dir = sub(wall.end, wall.start);
    const len = Math.hypot(dir.x, dir.y);
    if (jambs && len > 1e-9) {
      const n = { x: -dir.y / len, y: dir.x / len };
      const reveal = 0.06;
      for (const jamb of [jambs.jambStart, jambs.jambEnd]) {
        out.push({
          kind: "line",
          a: add(jamb, scale(n, reveal)),
          b: add(jamb, scale(n, -reveal)),
          cls: "window-frame",
          weightMm: SYMBOL_HAIRLINE_MM,
          color: o.color ?? POCHE_STROKE,
          greyed,
          openingId: o.id,
        });
      }
    }
  }
  // Brüstungslinie (gepunktet) — zeigt die Brüstung im Grundriss auf der Wandachse.
  // Nur bei Fenstern mit Brüstungshöhe > 0. Entspricht der Sill-Linie in
  // `_make_oeffnung_preview` und dem Brüstungs-Plansymbol im Rhino-Plugin.
  if (o.sillHeight > 0) {
    const jambs = openingJambs(wall, o);
    if (jambs) {
      out.push({
        kind: "line",
        a: jambs.jambStart,
        b: jambs.jambEnd,
        cls: "window-sill",
        weightMm: SYMBOL_HAIRLINE_MM,
        // Gepunktet (dot-dash) wie in _make_oeffnung_preview DrawDottedLine.
        dash: [0.04, 0.08],
        color: o.color ?? POCHE_STROKE,
        greyed,
        openingId: o.id,
      });
    }
  }
  // Rollladen-/Sonnenschutzkasten (P0-Minimalfassung, reine 2D-Kontur): ein
  // gestricheltes Rechteck ÜBER der Öffnung, ausserhalb der Wand-Aussenfläche —
  // Breite = `shading.box.width` (0/fehlt ⇒ Öffnungsbreite), die zweite
  // Rechteckseite = `shading.box.height`. Die 3D-Tiefe (`box.depth`) bleibt für
  // eine spätere 3D-Box reserviert (Fokus hier bewusst 2D, s. Aufgabenstellung).
  // Gestrichelt wie die übrigen Überkopf-Projektionen (Sturz/Oberlicht) — der
  // Kasten liegt oberhalb der Schnittebene und wird nur angedeutet.
  if (wt?.shading?.create) {
    const jambs = openingJambs(wall, o);
    if (jambs) {
      const { u, n: nrm } = wallAxisFrame(wall);
      const total = wallTypeThickness(getWallType(project, wall));
      const refOff = wallReferenceOffset(wall, total);
      const outerFace = refOff + total / 2;
      const axisWidth = Math.hypot(
        jambs.jambEnd.x - jambs.jambStart.x,
        jambs.jambEnd.y - jambs.jambStart.y,
      );
      const boxWidth = wt.shading.box.width > 0 ? wt.shading.box.width : axisWidth;
      const boxHeight = Math.max(0, wt.shading.box.height);
      const center = add(jambs.jambStart, scale(u, axisWidth / 2));
      const half = boxWidth / 2;
      const c1 = add(center, scale(u, -half));
      const c2 = add(center, scale(u, half));
      const p1 = add(c1, scale(nrm, outerFace));
      const p2 = add(c2, scale(nrm, outerFace));
      const p3 = add(c2, scale(nrm, outerFace + boxHeight));
      const p4 = add(c1, scale(nrm, outerFace + boxHeight));
      const edges: [Vec2, Vec2][] = [
        [p1, p2],
        [p2, p3],
        [p3, p4],
        [p4, p1],
      ];
      for (const [a, b] of edges) {
        out.push({
          kind: "line",
          a,
          b,
          cls: "window-shading",
          weightMm: SYMBOL_HAIRLINE_MM,
          dash: OVERHEAD_DASH,
          color: o.color ?? POCHE_STROKE,
          greyed,
          openingId: o.id,
        });
      }
    }
  }
}

/** Schraffur-Platzhalter „ohne" (für reine Umriss-/Sammelflächen). */
const NO_HATCH: HatchRender = {
  pattern: "none",
  scale: 1,
  angle: 0,
  color: POCHE_STROKE,
  lineWeight: LAYER_LINE_MM,
  dash: null,
};

/**
 * Referenzlinie einer Wand: dünne, gestrichelte Achslinie entlang der Wandachse
 * (start → end). Von der Oberleiste umschaltbar; rein darstellend.
 */
function addReferenceLine(out: Primitive[], wall: Wall, greyed: boolean): void {
  out.push({
    kind: "line",
    a: wall.start,
    b: wall.end,
    cls: "wall-axis",
    weightMm: 0.13,
    dash: [0.18, 0.06, 0.04, 0.06], // Strich-Punkt-Achse in mm Papier
    greyed,
  });
}

/**
 * Decken-Poché im Grundriss: die Decke liegt als Slab ÜBER der Schnittebene und
 * wird daher als geschlossener Umriss ihres Grundriss-Polygons gezeichnet — eine
 * gefüllte + schraffierte Fläche plus eine kräftige Umrisslinie. Fill/Schraffur
 * stammen aus dem BAUTEIL der ersten (obersten) Schicht des Aufbau-Typs (analog
 * zur Wand-Schichtauflösung); die Umrissfarbe aus der optionalen Decken-Farbe
 * bzw. dem Poché-Strich. Jedes Polygon trägt die `ceilingId` für die Auswahl.
 *
 * BEWUSST FLÄCHIG, auch bei mehrschichtigem Deckentyp: anders als die Wand
 * (deren Schichten im Grundriss als Querschnitt sichtbar sind) liegt der
 * Schichtaufbau einer Decke in Z (oben → unten) — von oben unsichtbar. Die
 * Schichtbänderung erscheint daher NUR im Schnitt (siehe `toSection.ts`), nicht
 * hier. Im Detailgrad „grob" entfällt die Schraffur (nur Fläche + Umriss);
 * „mittel"/„fein" zeigen die Ansichts-Schraffur des Bauteils (`viewHatchId`,
 * Default weiss) — die frontal gesehene Aufsicht ist kein Schnitt. `lwMm` ist
 * die Kategorie-Strichstärke.
 */
function addCeilingPoche(
  out: Primitive[],
  project: Project,
  ceiling: Ceiling,
  greyed: boolean,
  detail: DetailLevel,
  category: LayerCategory | undefined,
  wallFootprints: WallFootprint[],
): void {
  const pts = ceiling.outline;
  if (pts.length < 3) return;
  const wt = getCeilingType(project, ceiling);
  const comp = wt.layers.length > 0 ? getComponent(project, wt.layers[0].componentId) : null;
  const stroke = ceiling.color ?? POCHE_STROKE;
  const ceilingId = ceiling.id;

  // Gefüllte Fläche mit der Ansichts-Schraffur: die Decke wird im Grundriss
  // frontal von unten gesehen, nicht aufgeschnitten — daher greift hier
  // NICHT die Schnitt-Schraffur (die gehört auf echte Schnittflächen, siehe
  // resolveCeilingSectionStyle/splitSlabLayers), sondern `viewHatchId`. Fehlt
  // sie (Default), bleibt die Aufsicht weiss. Im Detailgrad „grob" entfällt
  // die Schraffur ganz (nur Fläche + Umriss). Das Attribut-Override
  // `ceiling.hatchId` (+ `hatchSource`) überschreibt diese Ansichts-Schraffur
  // genauso wie die Schnitt-Schraffur in {@link resolveCeilingSectionStyle}.
  const effectiveViewHatchId = resolveHatchId(
    ceiling.hatchId,
    ceiling.hatchSource,
    category,
    comp?.viewHatchId,
  );
  const hatch =
    detail !== "grob" && comp && effectiveViewHatchId
      ? resolveHatch(
          project,
          effectiveViewHatchId,
          undefined,
          resolveForeground(comp, ceiling.foreground, category, ceiling.foregroundSource),
        )
      : NO_HATCH;
  // Gefüllte Fläche OHNE eigenen Umriss (stroke:"none"): die Decke liegt unter
  // der Wand-Poché; ihre Kante wird separat als verdeckungs-geclippte Linie
  // gezeichnet (s. u.), damit sie nicht durch die darüberstehenden Wände schlägt.
  // Trägt weiterhin die `ceilingId` für die Links-Klick-Auswahl der Fläche.
  out.push({
    kind: "polygon",
    pts,
    fill: comp ? pocheFill(hatch.pattern) : "none",
    stroke: "none",
    strokeWidthMm: 0,
    hatch,
    greyed,
    ceilingId,
  });
  // Kräftige Umrisslinie NUR dort, wo keine Wand die Decke verdeckt: jede
  // Umriss-Kante gegen die Wand-Footprints clippen und die freien Teilstücke als
  // Linien ausgeben. Liegt die Decke deckungsgleich unter den Wänden (Regelfall:
  // Deckenumriss = Gebäude-/Wand-Mittellinien), entfällt der Umriss ganz; nur
  // Überstände (Vordach/Balkon jenseits der Wand) bleiben sichtbar.
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const holes: Array<[number, number]> = [];
    for (const fp of wallFootprints) {
      const iv = segmentInsideWallBand(a, b, fp);
      if (iv) holes.push(iv);
    }
    const d = sub(b, a);
    for (const [t0, t1] of subtractIntervals(0, 1, holes)) {
      out.push({
        kind: "line",
        a: add(a, scale(d, t0)),
        b: add(a, scale(d, t1)),
        cls: "ceiling-outline",
        // Überkopf-Ansichtslinie (Decke liegt als Slab über der Schnittebene) →
        // gestrichelte Haarlinie statt kräftiger Volllinie (BIM-Konvention).
        weightMm: LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail],
        dash: OVERHEAD_DASH,
        color: stroke,
        greyed,
      });
    }
  }
}

/**
 * Dach im Grundriss (Dachaufsicht): reine Linien-Darstellung ohne Poché — die
 * 2D-Geometrie aus `roofGeometry` (First/Grat/Knick hängen NICHT von der
 * Traufhöhe ab, daher `eavesZ=0`):
 *  • Traufe (`eaves`): geschlossener Umriss-Ring als mittlere Haarlinie.
 *  • First (`ridges`): kräftige Volllinie, etwas stärker als die Traufe.
 *  • Grat (`hips`, Walm/Zelt): Volllinie zwischen Traufe- und First-Stärke.
 *  • Knick (`breaks`, Mansarde): dünne gestrichelte Linie.
 * Farbe: `roof.color` übersteuert sonst die Kategorie-Farbe (analog Stützen-
 * Poché), Default die neutrale Poché-Tinte.
 */
function addRoof(
  out: Primitive[],
  roof: Roof,
  greyed: boolean,
  category: LayerCategory | undefined,
): void {
  const stroke = roof.color ?? category?.color ?? POCHE_STROKE;
  const geo = roofGeometry(roof, 0);

  // Unsichtbares Pick-Polygon über der Traufe-Fläche — macht das Dach über die
  // ganze Fläche per Links-Klick selektierbar (die Dachlinien allein wären
  // schwer exakt zu treffen). fill/stroke "none" ⇒ zeichnet nichts; PlanView
  // testet nur die `pts` (Punkt-in-Polygon), analog Öffnung/Decke.
  if (geo.eaves.length >= 3) {
    out.push({
      kind: "polygon",
      pts: geo.eaves,
      fill: "none",
      stroke: "none",
      strokeWidthMm: 0,
      hatch: NO_HATCH,
      greyed,
      roofId: roof.id,
    });
  }

  const n = geo.eaves.length;
  for (let i = 0; i < n; i++) {
    out.push({
      kind: "line",
      a: geo.eaves[i],
      b: geo.eaves[(i + 1) % n],
      cls: "roof-eaves",
      weightMm: ROOF_EAVES_MM,
      color: stroke,
      greyed,
    });
  }
  for (const [a, b] of geo.ridges) {
    out.push({ kind: "line", a, b, cls: "roof-ridge", weightMm: ROOF_RIDGE_MM, color: stroke, greyed });
  }
  for (const [a, b] of geo.hips) {
    out.push({ kind: "line", a, b, cls: "roof-hip", weightMm: ROOF_HIP_MM, color: stroke, greyed });
  }
  for (const [a, b] of geo.breaks) {
    out.push({
      kind: "line",
      a,
      b,
      cls: "roof-break",
      weightMm: ROOF_BREAK_MM,
      dash: ROOF_BREAK_DASH,
      color: stroke,
      greyed,
    });
  }
}

/**
 * Deckkraft (0..255) der Raum-Füllung → 2-stelliges Hex-Suffix. Transluzente
 * Farbfüllung entfällt — Plandarstellung schwarz/grau; Farbe bleibt späteren
 * Schema-Ebenen vorbehalten. Alpha 0 = unsichtbar; das Polygon bleibt als
 * `roomId`-Primitiv erhalten (Auswahl per Punkt-in-Polygon in PlanView, NICHT
 * über die native Pointer-Trefferfläche der Füllung — die volle Fläche bleibt
 * damit trotz Alpha 0 klickbar).
 */
const ROOM_FILL_ALPHA = "00";
/** Basis-Schriftgrösse des Raum-Stempels in Punkt (pt). */
const ROOM_STAMP_PT = 10;

/** Farbe mit Alpha-Suffix versehen (nur, wenn `color` ein 6-stelliges Hex ist). */
function withAlpha(color: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alphaHex}` : color;
}

/**
 * Raum (SIA-416-Fläche) im Grundriss: eine (unsichtbare, nur klickbare) Füll-
 * fläche über dem lichten Umriss + eine dünne neutrale Umrisslinie (beide
 * `roomId`-getaggt für die Auswahl) + ein Raum-Stempel (Text) am Anker
 * (Centroid oder `stampAnchor`) mit Name, Fläche „24.30 m²" und SIA-Kürzel.
 * Keine Farbwäsche — Plandarstellung schwarz/grau, Farbe bleibt späteren
 * Schema-Ebenen vorbehalten. Der Stempel entfällt beim Detailgrad „grob";
 * Fläche/Umfang/Schwerpunkt werden aus `boundary` abgeleitet (nie gespeichert).
 * Wird UNTER der Wand-Poché gezeichnet.
 */
function addRoomArea(
  out: Primitive[],
  room: Room,
  greyed: boolean,
  detail: DetailLevel,
): void {
  const pts = room.boundary;
  if (pts.length < 3) return;
  const res = evaluateRoom(pts, room.siaCategory);
  const stroke = room.color;

  // Unsichtbare Füllfläche (Alpha 0): keine Farbwäsche im Plan, das Polygon
  // bleibt aber als `roomId`-Primitiv für die Punkt-in-Polygon-Auswahl erhalten.
  out.push({
    kind: "polygon",
    pts,
    fill: withAlpha(room.color, ROOM_FILL_ALPHA),
    stroke,
    strokeWidthMm: LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail],
    hatch: NO_HATCH,
    greyed,
    roomId: room.id,
  });

  // Raum-Stempel: frei editierbarer Rich-Text (Name/Notizen) + LIVE-Flächenzeile
  // + SIA-Kürzel. Anker fix (stampAnchor, sonst Centroid). Nur ab Detailgrad
  // „mittel". Die Flächenzeile aktualisiert sich unabhängig vom editierten Text.
  if (detail !== "grob") {
    const at = room.stampAnchor ?? res.centroid;
    // Strukturierter Stempel (Feldmodell) hat Vorrang; sonst Alt-Pfad (Rich-Text
    // bzw. Raum-Name als einfacher Text).
    const doc = room.stamp
      ? roomStampToDoc(room.stamp)
      : room.stampDoc ?? docFromText(room.name);
    const extraLines = room.stamp
      ? roomStampExtraLines(room.stamp, {
          netArea: res.netArea,
          siaCategory: room.siaCategory,
          siaLabel: siaLabel(room.siaCategory),
        })
      : [
          { text: `${res.netArea.toFixed(2)} m²`, align: "center" as const },
          {
            text: `${room.siaCategory} · ${siaLabel(room.siaCategory)}`,
            align: "center" as const,
          },
        ];
    out.push({
      kind: "text",
      at,
      doc,
      extraLines,
      basePt: ROOM_STAMP_PT,
      color: stroke,
      roomId: room.id,
      greyed,
    });
  }
}

/**
 * Zeichnet die Wendel-Aussenlinie: Innen-/Aussenbogen als Arc-Primitive plus zwei
 * radiale Schliesslinien. Wird von `addStairSymbol` aufgerufen wenn `shape === "spiral"`.
 */
function _addSpiralOutline(
  out: Primitive[],
  seg: SpiralOutlineSegments,
  stroke: string,
  lwMm: number,
  greyed: boolean,
  stairId: string,
): void {
  // Radiale Schliesslinien (Startwinkel + Endwinkel).
  for (const [a, b] of seg.lines) {
    out.push({ kind: "line", a, b, cls: "stair-outline", weightMm: lwMm, color: stroke, greyed, stairId });
  }
  // Innen- und Aussenbogen.
  for (const arc of seg.arcs) {
    const from: Vec2 = { x: arc.cx + arc.r * Math.cos(arc.a0), y: arc.cy + arc.r * Math.sin(arc.a0) };
    const to: Vec2   = { x: arc.cx + arc.r * Math.cos(arc.a1), y: arc.cy + arc.r * Math.sin(arc.a1) };
    out.push({
      kind: "arc",
      center: { x: arc.cx, y: arc.cy },
      from,
      to,
      r: arc.r,
      cls: "stair-outline",
      weightMm: lwMm,
      greyed,
      stairId,
    });
  }
}

/**
 * Treppen-Symbol im Grundriss (DOSSIER/SIA):
 *  • Tritte als Rechtecke: die Tritt-Trennlinien werden gezeichnet — unter der
 *    Schnittebene DURCHGEZOGEN (sichtbar), darüber GESTRICHELT (verdeckt).
 *  • Der erste Tritt oberhalb der Schnittebene trägt die diagonale SIA-Bruchlinie
 *    (Doppelstrich quer über den Lauf).
 *  • Zwischenpodest (L/Wendel) als Umriss-Polygon.
 *  • Lauflinie (Lauflinie) mit Auf-/Abpfeil (Auf-/Abpfeil) und Stufenanzahl-Label.
 * Alle Primitive tragen `stairId` für die Auswahl.
 */
function addStairSymbol(
  out: Primitive[],
  project: Project,
  stair: Stair,
  greyed: boolean,
  lwMm: number,
  cutHeight: number,
): void {
  const { zBottom, zTop } = stairVerticalExtent(project, stair);
  const totalRise = zTop - zBottom;
  const geo = stairGeometry(stair, totalRise);
  const cut = stairCut(geo, cutHeight);
  const below = new Set(cut.belowIndices);
  const stroke = stair.color ?? POCHE_STROKE;
  const stairId = stair.id;

  // Umriss + Tritt-Trennlinien je Stufe. Der letzte Punkt jedes Tritt-Rechtecks
  // liefert die vordere Kante (Auftritt); wir zeichnen jede Tritt-Kante.
  for (const tr of geo.treads) {
    const isBelow = below.has(tr.index);
    // Tritt-Rechteck als reine Umrisslinie (keine Füllung), durchgezogen wenn
    // unter der Schnittebene, sonst gestrichelt (verdeckt).
    out.push({
      kind: "polygon",
      pts: tr.pts,
      fill: "none",
      stroke,
      strokeWidthMm: lwMm * 0.7,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
    // Zusätzliche Auftrittskante (vordere Kante der Stufe) etwas kräftiger.
    const front: [Vec2, Vec2] = [tr.pts[1], tr.pts[2]];
    out.push({
      kind: "line",
      a: front[0],
      b: front[1],
      cls: "stair-tread",
      weightMm: lwMm * (isBelow ? 1.0 : 0.6),
      dash: isBelow ? null : [0.12, 0.08],
      color: stroke,
      greyed,
      stairId,
    });
  }

  // Zwischenpodest (L/Wendel-Auge): Umriss-Polygon.
  if (geo.landing && geo.landing.length >= 3) {
    out.push({
      kind: "polygon",
      pts: geo.landing,
      fill: "none",
      stroke,
      strokeWidthMm: lwMm * 0.7,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
  }

  // SIA-Bruchlinie (Doppelstrich diagonal über den Schnitt-Tritt).
  if (cut.breakLine) {
    for (const [a, b] of cut.breakLine) {
      out.push({
        kind: "line",
        a,
        b,
        cls: "stair-break",
        weightMm: lwMm,
        color: stroke,
        greyed,
        stairId,
      });
    }
  }

  // Lauflinie (Lauflinie) — kräftig, durchgezogen.
  for (let i = 0; i < geo.runLine.length - 1; i++) {
    out.push({
      kind: "line",
      a: geo.runLine[i],
      b: geo.runLine[i + 1],
      cls: "stair-run",
      weightMm: lwMm,
      color: stroke,
      greyed,
      stairId,
    });
  }
  // Auf-/Abpfeil an der Spitze der Lauflinie.
  const [h1, tip, h2] = geo.arrow.head;
  out.push({ kind: "line", a: h1, b: tip, cls: "stair-arrow", weightMm: lwMm, color: stroke, greyed, stairId });
  out.push({ kind: "line", a: h2, b: tip, cls: "stair-arrow", weightMm: lwMm, color: stroke, greyed, stairId });

  // Aussenlinie (Outline) der Treppe — schliessendes Umriss-Polygon (gerade/L)
  // bzw. Innen-/Aussenbogen + radiale Schliesslinien (Wendel).
  // Entspricht `_aussen_gerade` / `_aussen_l_polygon` / `_aussen_wendel` im
  // Rhino-Plugin. Stets durchgezogen, volle Strichstärke.
  const outline = stairOutline(stair, totalRise);
  if (outline.polygon && outline.polygon.length >= 3) {
    out.push({
      kind: "polygon",
      pts: outline.polygon,
      fill: "none",
      stroke,
      strokeWidthMm: lwMm,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
  }
  if (outline.spiral) {
    _addSpiralOutline(out, outline.spiral, stroke, lwMm, greyed, stairId);
  }
}

const length = (w: Wall): number => Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);

function computeBounds(
  project: Project,
  walls: Wall[],
  drawings: Drawing2D[] = [],
  ceilings: Ceiling[] = [],
  stairs: Stair[] = [],
  rooms: Room[] = [],
  roofs: Roof[] = [],
) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (p: Vec2) => {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  };
  for (const w of walls) {
    const t = wallTypeThickness(getWallType(project, w));
    for (const c of wallCorners(w.start, w.end, t)) acc(c);
  }
  for (const c of ceilings) for (const p of c.outline) acc(p);
  for (const r of rooms) for (const p of r.boundary) acc(p);
  // Traufe (inkl. Überstand) statt reinem Umriss, damit ein weit auskragendes
  // Dach das „Einpassen" korrekt mit einrahmt.
  for (const roof of roofs) for (const p of roofGeometry(roof, 0).eaves) acc(p);
  for (const s of stairs) {
    const { zBottom, zTop } = stairVerticalExtent(project, s);
    const geo = stairGeometry(s, zTop - zBottom);
    for (const tr of geo.treads) for (const p of tr.pts) acc(p);
    if (geo.landing) for (const p of geo.landing) acc(p);
  }
  for (const d of drawings) {
    const g = d.geom;
    if (g.shape === "line") { acc(g.a); acc(g.b); }
    else if (g.shape === "polyline") g.pts.forEach(acc);
    else if (g.shape === "rect") { acc(g.min); acc(g.max); }
    else if (g.shape === "circle" || g.shape === "arc") {
      acc({ x: g.center.x - g.r, y: g.center.y - g.r });
      acc({ x: g.center.x + g.r, y: g.center.y + g.r });
    } else if (g.shape === "text") acc(g.at);
  }
  // Kontext-Konturen mit einrahmen, damit „Einpassen" sie ebenfalls zeigt.
  for (const obj of project.context ?? []) {
    if (obj.type !== "contourSet") continue;
    for (const c of obj.contours) for (const p of c.pts) acc(p);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}
