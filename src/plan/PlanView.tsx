// Rendert einen Plan als SVG. Vektor → unendlich scharf & druckbar.
//
// Schraffuren werden aus der je Polygon aufgelösten HatchStyle-Ressource
// erzeugt (Muster, Maßstab, Winkel, Farbe, Linienstärke). Pro schraffiertem
// Polygon wird ein eigenes <pattern> in <defs> definiert, damit Maßstab/Winkel/
// Farbe variieren können.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import type { HatchRender, Plan, PlanImage, Primitive } from "./generatePlan";
import type { EdgeGrip, Vec2 } from "../model/types";
import type { ToolHandlers, ToolId, ToolMods } from "../tools/types";
import type { HudFieldsState } from "../tools/hudFormat";
import type { RichTextDoc } from "../text/richText";
import { docFromText } from "../text/richText";
import { contentFontBaselineFromTop, TEXT_LINE_HEIGHT_MULT } from "../text/fontMetrics";
import { textFrameCorners } from "../text/textFrame";
import { RichTextEditor } from "../text/RichTextEditor";
import { useGlPlanRenderer } from "./useGlPlanRenderer";
import { useWasmPlanRenderer } from "./useWasmPlanRenderer";
import { DEFAULT_MARQUEE_COLOR, DEFAULT_SNAP_COLOR } from "../theme/accents";
import {
  type ViewBox,
  PX_PER_M,
  PAD,
  toScreen,
  clamp,
  meetScale,
  scaleFromView,
  viewForScale,
  viewForCamera,
  fitBoxFor,
  pointInPolygon,
  pointSegDistPx,
  marqueeHit,
  marqueeHitDrawings,
  marqueeHitCeilings,
  marqueeHitRooms,
  marqueeHitStairs,
} from "./planView/geometry";
import {
  polyUsesPattern,
  HatchPattern,
  buildDrawingRuns,
  DrawingRunShape,
  PrimitiveShape,
  greyColor,
} from "./planView/primitives";
import { DraftOverlay } from "./planView/overlays";
import { PlanRulers } from "./planView/PlanRulers";
import { PlanGrid } from "./planView/PlanGrid";
import { expandRegion, primitivesInRegion, regionContains, type Bounds } from "./planView/cullPrimitives";

/**
 * Feld-Status der Befehlszeile fürs Cursor-HUD (Tab-Feld-Zyklus §2.7) — Typ
 * lebt in `tools/hudFormat.ts` (dort auch von der 3D-Ansicht genutzt);
 * hier nur re-exportiert (bestehende Importe aus `./PlanView` bleiben gültig).
 */
export type { HudFieldsState } from "../tools/hudFormat";

// Viewport-Culling (s. `cullPrimitives.ts`): erst ab dieser Primitiv-Anzahl
// aktiv — normale Projekte liegen weit darunter und bleiben unverändert.
const CULL_THRESHOLD = 5000;
// Puffer um `view` als Vielfaches der View-Grösse je Seite (50 % → ein
// Schwenk muss schon über die halbe Bildschirmbreite hinausgehen, bevor neu
// gerechnet wird).
const CULL_MARGIN_FACTOR = 0.5;
const cullMargin = (vb: ViewBox) => Math.max(vb.w, vb.h) * CULL_MARGIN_FACTOR;
// Text-Primitive unter dieser Höhe (als Anteil der aktuellen View-Höhe)
// gelten als unleserlich und werden gar nicht erst gerendert (s.
// `isTooSmallToRead` in cullPrimitives.ts) — unabhängig von der Position.
// 0.5 % einer typischen Bildschirmhöhe (~800 px) sind ~4 px, die Schwelle,
// ab der Text praktisch ohnehin nicht mehr lesbar ist.
const MIN_RELATIVE_TEXT_HEIGHT = 0.005;
// Deutlich reingezoomt seit der letzten Neuberechnung (View < 30 % der
// gepufferten Region) → neu rechnen, auch wenn `view` noch "drin liegt" —
// sonst bliebe die LOD-Schwelle (an der ALTEN, grösseren View-Höhe bemessen)
// zu streng und Text, der beim aktuellen Zoom längst lesbar wäre, bliebe
// unsichtbar.
const CULL_RESCALE_FACTOR = 0.3;

interface CullState {
  region: Bounds;
  minTextHeightVb: number;
  forViewW: number;
  forViewH: number;
}
function computeCullState(view: ViewBox): CullState {
  return {
    region: expandRegion(view, cullMargin(view)),
    minTextHeightVb: view.h * MIN_RELATIVE_TEXT_HEIGHT,
    forViewW: view.w,
    forViewH: view.h,
  };
}
function cullStateStale(s: CullState, view: ViewBox): boolean {
  if (!regionContains(s.region, view)) return true;
  return view.w < s.forViewW * CULL_RESCALE_FACTOR || view.h < s.forViewH * CULL_RESCALE_FACTOR;
}

// Zoom-Grenzen relativ zur eingepassten Default-Ansicht. Kleinere viewBox-
// Breite = stärkerer Zoom. ZOOM_MAX → max. Hineinzoomen, ZOOM_MIN → Herauszoomen.
// Grosszügig bemessen (CAD-Anspruch: vom Milimeter-Detail bis zum Siedlungs-
// Kontext) statt der früheren 250×-Spanne (50/0.2), die für Detailarbeit an
// einem Gebäude deutlich zu eng war.
const ZOOM_MAX = 20000; // bis 20 000× hinein (Sub-Millimeter-Details)
const ZOOM_MIN = 0.005; // bis 200× heraus (Siedlungs-/Site-Kontext)
const WHEEL_STEP = 0.0015; // Empfindlichkeit des Mausrads

// Schwelle (Bildschirm-Pixel), ab der ein Links-Ziehen als Marquee gilt; darunter
// bleibt es ein Klick (Einzelwahl). Verhindert versehentliche Mini-Rechtecke.
const MARQUEE_THRESHOLD_PX = 4;

// Trefferradius (Bildschirm-Pixel) für das Greifen eines Editier-Griffs.
const GRIP_HIT_PX = 9;
// Toleranz (Bildschirm-Pixel) für die Linien-Auswahl von 2D-Zeichenelementen.
const LINE_PICK_PX = 6;

/** Ein Polygon mit Schraffur + die ihm zugewiesene <pattern>-ID. */
interface HatchedPoly {
  patternId: string;
  hatch: HatchRender;
}

/**
 * Imperatives Steuerhandle der Plan-Ansicht für die Oberleiste (Zoom-Buttons).
 * Die Ansicht behält Pan/Zoom intern; das Handle löst nur die fest definierten
 * Sprünge aus, ohne den sonstigen Zustand zu berühren.
 */
export interface PlanViewHandle {
  /** Auf die eingepasste Standard-Ansicht zurücksetzen (Einpassen). */
  fit: () => void;
  /**
   * Auf die aktuelle Auswahl einpassen (lokal hervorgehobenes Polygon); gibt es
   * keine Auswahl, verhält es sich wie „Einpassen".
   */
  fitSelection: () => void;
  /**
   * Den Zoom so setzen, dass das Modell im PAPIER-Massstab 1:N abgebildet wird
   * (siehe docs/design/plans-output.md §3). Hält die aktuelle Bildmitte. Wird
   * von der Oberleiste benutzt (Massstab-Preset wählen, „100 %").
   */
  applyScale: (n: number) => void;
  /** Aktuelle Pixel/Meter-Skala (für Snap-Toleranz der Command-Engine). */
  pxPerMeter: () => number;
  /** Mitte des aktuellen Ausschnitts in Modell-Metern (z. B. für Import-Platzierung). */
  viewCenterModel: () => Vec2;
  /**
   * Setzt die Bildmitte + den Zoom (Bildschirm-px je Meter) direkt — Gegenstück
   * zu `viewCenterModel`/`pxPerMeter` (Auslesen). Für „gespeicherter Ausschnitt
   * wiederherstellen": stellt WOHIN man schaut wieder her, nicht nur WAS
   * sichtbar ist. No-op ohne Messung (SVG noch nicht gemountet).
   */
  setCamera: (center: Vec2, pxPerMeter: number) => void;
  /**
   * Auf eine beliebige Punktmenge (Modell-Meter) einpassen, z. B. die Bounding-
   * Box neu importierter Kontext-Objekte (Auto-Zoom nach Geo-/DXF-Import).
   * Leere Punktmenge → No-op (kein Fit, kein Crash).
   */
  fitBounds: (pts: Vec2[]) => void;
  /**
   * Einen bewaffneten Punkt-Griff (s. gripDrag) an seiner AKTUELLEN Position
   * abschließen — dieselbe Aktion wie ein bestätigender Klick/Enter auf der
   * Zeichenfläche, aber von der Befehlszeile aus angestoßen (Enter dort MIT
   * leerem Eingabetext: kein neuer Wert zu locken, nur „fertig, so lassen").
   * No-op ohne bewaffneten Griff.
   */
  confirmGripEdit: () => void;
  /** Dasselbe für einen bewaffneten Kanten-Griff (s. edgeDrag). */
  confirmEdgeEdit: () => void;
}

/** Ergebnis eines Links-Klicks (Auswahl) an einer Modellposition. */
export interface PlanSelection {
  /** Klickposition in Modell-Metern. */
  model: Vec2;
  /** Index des getroffenen Polygon-Primitivs, oder `null` (Leerraum). */
  hitIndex: number | null;
  /**
   * ID der getroffenen Wand (aus dem Polygon-Primitiv), oder `null`, wenn der
   * Klick keine Wand traf (Leerraum bzw. ein Polygon ohne Wandbezug). Damit
   * setzt der Aufrufer (App) die Auswahl auf genau diese Wand (bzw. leert sie).
   */
  wallId: string | null;
  /**
   * ID des getroffenen 2D-Zeichenelements (Drawing2D), wenn der Klick nahe an
   * dessen Linien lag und KEINE Wand getroffen wurde; sonst `null`.
   */
  drawingId: string | null;
  /**
   * ID der getroffenen Decke (aus dem Polygon-Primitiv), wenn der Klick eine
   * Decken-Fläche traf und KEINE Wand/kein 2D-Element; sonst `null`.
   */
  ceilingId: string | null;
  /**
   * ID der getroffenen Öffnung (Fenster/Tür), wenn der Klick nahe an ihrem Symbol
   * (Türblatt/Schwenkbogen/Fenster-Glaslinie/-Rahmen) lag und KEINE Wand/kein
   * 2D-Element/keine Decke getroffen wurde; sonst `null`.
   */
  openingId: string | null;
  /**
   * ID der getroffenen Treppe (aus einem Tritt-/Podest-Polygon), wenn der Klick
   * eine Treppe traf und KEINE Wand/kein 2D-Element/keine Decke/keine Öffnung;
   * sonst `null`.
   */
  stairId: string | null;
  /**
   * ID des getroffenen Raums (aus einer Raum-Fläche), wenn der Klick einen Raum
   * traf und KEIN Element höherer Priorität (Wand/2D/Decke/Öffnung/Treppe);
   * sonst `null`.
   */
  roomId: string | null;
  /**
   * ID des getroffenen extrudierten Körpers (truck-Integration, Footprint-
   * Umriss), wenn der Klick ihn traf und KEIN Element höherer Priorität
   * (Wand/2D/Decke/Öffnung/Treppe); sonst `null`.
   */
  extrudedSolidId: string | null;
  /**
   * ID der getroffenen Stütze (Column, Grundriss-Querschnitt), wenn der Klick sie
   * traf und KEIN Element höherer Priorität (Öffnung/Wand); sonst `null`.
   */
  columnId: string | null;
  /**
   * ID des getroffenen Dachs (Traufe-Fläche), wenn der Klick es traf und KEIN
   * Element höherer Priorität (alle anderen gehen vor); sonst `null`.
   */
  roofId: string | null;
  /**
   * ID der getroffenen Schnitt-/Ansichtslinie (DrawingLevel), wenn der Klick ihr
   * dünnes Pick-Band traf; sonst `null`. Höchste Priorität (das schmale Band liegt
   * über allem — ein Klick genau darauf meint die Linie).
   */
  sectionLineId: string | null;
  /**
   * ID des getroffenen Kontext-Objekts (importiertes Gebäude/Terrain), wenn der
   * Klick sein Grundriss-Pick-Band traf und KEIN Element höherer Priorität
   * (alle anderen gehen vor, analog `roofId`); sonst `null`.
   */
  contextObjectId: string | null;
  /**
   * War beim Klick Shift gedrückt? Dann ERWEITERT der Aufrufer (App) die
   * Auswahl um das getroffene Element (bzw. schaltet es ab/zu), statt sie zu
   * ersetzen. Bei Leerraum-Klick mit Shift bleibt die Auswahl erhalten.
   */
  shift: boolean;
}

/**
 * Ergebnis eines Auswahl-Rechtecks (Marquee). `wallIds` ist die nach der
 * CAD-Konvention bestimmte Menge getroffener Wände (siehe `crossing`). Der
 * Aufrufer (App) ersetzt die aktuelle Auswahl durch diese Menge.
 */
export interface MarqueeSelection {
  wallIds: string[];
  /** Getroffene 2D-Zeichenelemente (gleiche window/crossing-Konvention). */
  drawingIds: string[];
  /** Getroffene Decken/Räume/Treppen (gleiche window/crossing-Konvention). */
  ceilingIds: string[];
  roomIds: string[];
  stairIds: string[];
  /**
   * Zieh-Richtung: `false` = links→rechts (positiv Δx) → nur VOLLSTÄNDIG
   * eingeschlossene Wände; `true` = rechts→links (negativ Δx) → auch berührte/
   * kreuzende Wände (CAD-Konvention: „crossing window").
   */
  crossing: boolean;
}

/**
 * Ein per Doppelklick getroffenes, potenziell gruppiertes Element — genau
 * EIN Feld gesetzt (analog `PlanSelection`, aber ohne die Klick-spezifischen
 * Felder). Für Gruppen-Eintritt (`onEnterGroup`); Formen ohne eigenes
 * Polygon-Primitiv (z. B. reine Linien-2D-Elemente) werden hier nicht
 * erkannt (kleine, bewusste Vereinfachung — s. `anyGroupableHit`).
 */
export interface GroupableHit {
  wallId?: string;
  drawingId?: string;
  ceilingId?: string;
  roomId?: string;
  stairId?: string;
  columnId?: string;
  roofId?: string;
}

export interface PlanViewProps {
  plan: Plan;
  /**
   * Stabiler Schlüssel des Plan-Kontexts (z. B. Geschoss-/Ebenen-ID). Der
   * sichtbare Ausschnitt wird NUR auf „eingepasst" zurückgesetzt, wenn sich
   * dieser Schlüssel ändert (Plan-/Geschoss-Wechsel) — NICHT bei jeder Modell-/
   * Bounds-Änderung durch Editieren. So „wandert" die Ansicht beim Verschieben/
   * Löschen nicht mehr mit; sie ändert sich nur durch manuelles Pan/Zoom/
   * Einpassen. Fehlt der Schlüssel, bleibt der Ausschnitt nach dem ersten
   * Einpassen stehen (kein Auto-Reset).
   */
  resetKey?: string;
  /**
   * Meldet die Cursor-Position in Modell-Koordinaten (Meter) nach oben, bzw.
   * `null`, wenn der Zeiger die Fläche verlässt. Optional — ohne Callback
   * verhält sich die Ansicht wie zuvor.
   */
  onCursor?: (model: Vec2 | null) => void;
  /**
   * Meldet den LIVE Papier-Massstab als Nenner N (1:N), berechnet aus dem
   * aktuellen Ausschnitt + Canvas-Größe + dpi (docs/design/plans-output.md §3).
   * Aktualisiert sich beim Wheel-Zoom/Pan/Resize. Optional.
   */
  onScale?: (n: number) => void;
  /**
   * Links-Klick (Auswahl): meldet die getroffene Wand (bzw. `hitIndex: null`
   * bei Klick in den Leerraum → Auswahl löschen). Optional. Die Ansicht
   * markiert das getroffene Polygon zusätzlich selbst (lokale Hervorhebung).
   */
  onSelect?: (selection: PlanSelection) => void;
  /**
   * Alt+Klick (Schere/Segment löschen): meldet das nahe getroffene Drawing2D plus
   * den Modellpunkt des Klicks. Der Aufrufer (App) ermittelt daraus die nächst-
   * gelegene Kante und entfernt sie. Optional. Nur ausgelöst, wenn ein 2D-Element
   * unter dem Cursor liegt (sonst no-op).
   */
  onSegmentCut?: (drawingId: string, model: Vec2) => void;
  /**
   * Aktuell ausgewählte Wand-IDs (kontrolliert von App). Die Ansicht markiert
   * ALLE Polygone JEDER dieser Wände mit einer Akzentkontur — unabhängig davon,
   * welches Band der Klick traf. Leeres Array/undefined = keine Wand-Auswahl.
   */
  selectedWallIds?: string[];
  /**
   * Aktuell ausgewählte Decken-IDs (kontrolliert von App). Die Ansicht markiert
   * ALLE Polygone JEDER dieser Decken mit einer Akzentkontur.
   */
  selectedCeilingIds?: string[];
  /**
   * Aktuell ausgewählte Öffnungs-IDs (Fenster/Tür; kontrolliert von App). Die
   * Ansicht markiert alle Symbol-Primitive JEDER dieser Öffnungen.
   */
  selectedOpeningIds?: string[];
  /**
   * Aktuell ausgewählte Treppen-IDs (kontrolliert von App). Die Ansicht markiert
   * alle Tritt-/Symbol-Primitive JEDER dieser Treppen mit einer Akzentkontur.
   */
  selectedStairIds?: string[];
  /**
   * Aktuell ausgewählte Raum-IDs (kontrolliert von App). Die Ansicht markiert die
   * Fläche JEDES dieser Räume mit einer Akzentkontur.
   */
  selectedRoomIds?: string[];
  /** Aktuell ausgewählte Dach-IDs (von App); die Ansicht markiert die Traufe. */
  selectedRoofIds?: string[];
  /**
   * Aktuell ausgewählte Kontext-Objekt-IDs (importiertes Gebäude/Terrain; von
   * App). Die Ansicht markiert das Grundriss-Pick-Band JEDES dieser Objekte mit
   * einer Akzentkontur.
   */
  selectedContextObjectIds?: string[];
  /**
   * Aktuell ausgewählte Schnitt-/Ansichtslinien-IDs (DrawingLevel; von App). Die
   * Ansicht markiert das Pick-Band JEDER dieser Linien mit einer Akzentkontur.
   */
  selectedSectionLineIds?: string[];
  /**
   * Aktuell ausgewählte IDs extrudierter Körper (truck-Integration; kontrolliert
   * von App). Die Ansicht markiert den Footprint-Umriss JEDES dieser Körper mit
   * einer Akzentkontur.
   */
  selectedExtrudedSolidIds?: string[];
  /**
   * Aktuell ausgewählte Stützen-IDs (Tragwerk; kontrolliert von App). Die Ansicht
   * markiert den Querschnitt-Umriss JEDER dieser Stützen mit einer Akzentkontur.
   */
  selectedColumnIds?: string[];
  /**
   * IDs der gewählten GRUPPEN (Vectorworks-artig). Nicht-leer → die Ansicht
   * zeigt statt der einzelnen Mitglieds-Umrisse nur eine Bounding-Box mit vier
   * Eckpunkten (s. `groupBBox`); die per-Kind-`selected…Ids`-Felder tragen
   * weiterhin die volle Mitgliedschaft (für Verschieben/Griffe/Löschen).
   */
  selectedGroupIds?: string[];
  /**
   * Der Stempel-Griff des (einzeln) gewählten Raums: sein Anker (Meter) + ID.
   * PlanView zeichnet einen ziehbaren Griff und meldet Bewegung/Doppelklick.
   * `null` = kein einzelner Raum gewählt.
   */
  roomStamp?: { roomId: string; anchor: Vec2 } | null;
  /** Der Stempel-Griff wurde verschoben (inkrementelles Modell-Delta). */
  onStampMove?: (roomId: string, delta: Vec2) => void;
  /** Doppelklick auf einen Raum-Stempel: Editor öffnen. */
  onStampEdit?: (roomId: string) => void;
  /** Doppelklick auf ein Text-2D-Element: Inhalt bearbeiten (Editor öffnen). */
  onEditDrawingText?: (drawingId: string) => void;
  /**
   * Doppelklick auf IRGENDEIN Element (Wand/2D/Decke/Raum/Treppe/Stütze/
   * Dach): meldet, welches Element getroffen wurde (genau EIN Feld gesetzt).
   * Der Aufrufer prüft, ob es zu einer Gruppe gehört (Vectorworks „Gruppe
   * betreten") und liefert `true`, wenn er die Gruppe betreten hat — dann
   * bricht `onDoubleClick` sofort ab, VOR allen anderen Doppelklick-Aktionen
   * (Gruppen-Eintritt hat Vorrang, wie in Vectorworks). `false`/kein Handler
   * → die übrigen Doppelklick-Prüfungen (Text/Raum-Stempel/Schnittlinie) laufen
   * normal weiter.
   */
  onEnterGroup?: (hit: GroupableHit) => boolean;
  /**
   * Drawing2D-ID, deren Inhalt gerade inline auf der Zeichenfläche editiert
   * wird (frisch über `text`/`textbox` erzeugt ODER per Doppelklick auf ein
   * bestehendes Element geöffnet) — `null`/undefined = kein Inline-Editor
   * offen. PlanView rendert dafür einen `RichTextEditor`-Overlay direkt über
   * dem Element (kein Dialog), positioniert/skaliert über den aktuellen
   * Ausschnitt.
   */
  editTextId?: string | null;
  /**
   * Mindesthöhe (Meter) des Inline-Editors, wenn `editTextId` aus einem
   * frisch aufgezogenen Textspalten-RAHMEN kommt (s. textbox.ts). `null`/
   * undefined = keine Mindesthöhe, der Inhalt bestimmt die Höhe allein.
   */
  editTextMinHeightM?: number | null;
  /** Jede Änderung im Inline-Text-Editor (live, pro Tastendruck). */
  onCommitTextEdit?: (doc: RichTextDoc) => void;
  /** Inline-Text-Editor schliessen (Backdrop-Klick/Escape). */
  onCloseTextEdit?: () => void;
  /** Doppelklick auf eine Schnittlinie: in deren 2D-Schnittansicht springen
   *  (Zeichnungsebene aktivieren). */
  onOpenSectionLevel?: (levelId: string) => void;
  /**
   * Links-Drag (Marquee): meldet die im Auswahl-Rechteck getroffenen Wände nach
   * der CAD-Konvention (siehe {@link MarqueeSelection}). Optional.
   */
  onMarquee?: (selection: MarqueeSelection) => void;
  /**
   * Rechts-Klick: öffnet ein Kontextmenü an der Cursorposition. Erhält die
   * Viewport-Pixel (clientX/Y) plus den Modellpunkt. Optional. Das Standard-
   * Browser-Kontextmenü wird immer unterdrückt.
   */
  onContextMenu?: (info: { clientX: number; clientY: number; model: Vec2 }) => void;
  /**
   * Aktives Zeichenwerkzeug. `"select"`/undefined = bisheriges Verhalten
   * (Auswahl/Marquee). Bei einem aktiven Zeichenwerkzeug übernimmt das Werkzeug
   * die linke Maustaste (Punkte setzen) statt der Auswahl; Pan/Zoom bleiben.
   */
  activeTool?: ToolId;
  /**
   * Übernimmt ein Zeichenwerkzeug ODER eine Transformation die linke Maustaste?
   * Wird von App berechnet (Zeichenwerkzeug aktiv ODER laufende Transformation).
   * Fehlt der Wert, wird aus `activeTool` abgeleitet (Rückwärtskompatibilität).
   */
  toolInputActive?: boolean;
  /**
   * Werkzeug-Treiber: PlanView meldet rohe Modellpunkte + Pixel/Meter hierher
   * und zeichnet den zurückgegebenen `draft` als Overlay (Vorschau + Snap-Marker).
   */
  toolHandlers?: ToolHandlers;
  /** Lineale (oben + links, VW-Stil) einblenden. Default an. */
  showRulers?: boolean;
  /** Sichtbares Hintergrund-Raster (rein visuell, unabhängig vom Fang-Raster). Default aus. */
  showGrid?: boolean;
  /**
   * Feld-Status der Befehlszeile fürs Cursor-HUD (Tab-Feld-Zyklus §2.7):
   * gelockte/live Werte je Feld, aktives Tab-Ziel und der gerade getippte
   * Text. Das HUD spiegelt damit die Eingabe LIVE am Cursor (VW-Verhalten:
   * tippen → Wert erscheint oben im Kästchen UND unten im Befehl); ohne
   * Felder fällt es auf die draft.hud-Livewerte zurück.
   */
  hudFields?: HudFieldsState | null;
  /**
   * Editier-Griffe (Grips) des aktuell EINZELN selektierten Elements, in Modell-
   * Metern (Wand-Enden, 2D-Vertices/Ecken). Werden als ziehbare Quadrate
   * gezeichnet; das Ziehen meldet sich über {@link gripHandlers}. Nur im
   * Auswahl-Werkzeug sichtbar/aktiv.
   */
  grips?: Vec2[];
  /**
   * Bezier-Hilfslinien (Anker → Kontrollpunkt-Griff) des selektierten
   * Elements — gestrichelt gerendert, damit sichtbar bleibt, welcher Griff
   * welchen Kurvenabschnitt steuert (s. `useGripEditing.ts`).
   */
  gripHandleLines?: { a: Vec2; b: Vec2 }[];
  /**
   * Kanten-/Seiten-Griffe (Edge Grips) des selektierten Elements: je Seite ein
   * dreieckiger Anfasser am Kanten-Mittelpunkt, dessen Spitze nach AUSSEN zeigt.
   * Ziehen meldet sich über {@link GripHandlers.onEdgeMove}. Nur sichtbar/aktiv,
   * wenn auch die Eckpunkt-Griffe aktiv sind.
   */
  edgeGrips?: EdgeGrip[];
  /**
   * „Display"-Modus: alle Plan-Linien als konstante Haarlinie (1 px) zeichnen,
   * statt der echten mm-Strichstärken (Print). Reine Darstellung.
   */
  hairline?: boolean;
  /** ID des selektierten 2D-Elements (für „Körper greifen → verschieben"). */
  selectedDrawingId?: string | null;
  /** Alle selektierten 2D-Elemente (Mehrfach-/Marquee-Auswahl) — für Hervorhebung. */
  selectedDrawingIds?: string[];
  /** Griff-Zieh-Treiber: Live-Bewegung (gesnappt) + Abschluss. */
  gripHandlers?: GripHandlers;
  /**
   * Farbe des Auswahlrahmens (Marquee-Ziehauswahl). Einstellbar im
   * Einstellungs-Fenster (State in ViewSlice); Default = Akzent „Yuyake".
   */
  marqueeColor?: string;
  /**
   * Farbe der Snap-/Endpunkt-Hervorhebung (Werkzeug-Overlay). Einstellbar im
   * Einstellungs-Fenster (State in ViewSlice); Default = Akzent „Sora".
   */
  snapColor?: string;
  /**
   * Ruht der Cursor (kein Werkzeug/Drag aktiv) länger als diese Zeit (ms) auf
   * einer 2D-Linie, erscheinen ihre Teilpunkte (s. `hoverDivideCount`) kurz
   * mit Akzentfarbe — reine Sichtbarkeits-Hilfe, kein Snap-Ziel. Einstellbar
   * im Footer (`SnapSettings.hoverDivideDelayMs`); Default 300 ms.
   */
  hoverDivideDelayMs?: number;
  /**
   * In wie viele gleiche Teile die gehoverte Linie dabei angezeigt wird
   * (2 = nur der Mittelpunkt). Einstellbar im Footer
   * (`SnapSettings.hoverDivideCount`); Default 2.
   */
  hoverDivideCount?: number;
}

/** Treiber für das Ziehen von Editier-Griffen (von App bereitgestellt). */
export interface GripHandlers {
  onGripMove(index: number, raw: Vec2, pxPerMeter: number, mods: ToolMods): void;
  /**
   * Ganzes Element parallel verschieben (inkrementelles Delta in Metern).
   * `target` benennt das gegriffene Element (Wand-ID ODER Drawing-ID) — wichtig
   * bei MEHRFACHAUSWAHL, wo das unter dem Cursor gegriffene Element verschoben
   * wird und koinzidente Enden der übrigen gewählten Elemente mitwandern. Fehlt
   * `target`, gilt das einzeln selektierte Element (Rückwärtskompatibilität).
   */
  onMoveBody(
    delta: Vec2,
    target?: { wallId?: string; drawingId?: string },
    mods?: ToolMods,
  ): void;
  /**
   * Eine SEITE (Kante) ziehen: verschiebt beide Vertices der Kante senkrecht
   * (nur die Normal-Komponente von `raw` wirkt; siehe App). `raw` ist der rohe
   * Modellpunkt unter dem Cursor.
   */
  onEdgeMove(edge: EdgeGrip, raw: Vec2, pxPerMeter: number, mods: ToolMods): void;
  onGripEnd(): void;
  /**
   * Bewaffneten Punkt-Griff verwerfen (Escape): setzt den Punkt exakt auf
   * `origin` zurück (ohne Snap/Ortho-Neuauswertung) und räumt danach wie
   * {@link onGripEnd} auf.
   */
  onGripCancel(index: number, origin: Vec2): void;
  /** Bewaffneten Kanten-Griff an seiner aktuellen Position abschließen. */
  onEdgeEnd(): void;
  /**
   * Bewaffneten Kanten-Griff verwerfen (Escape): setzt ihn exakt auf `anchor`
   * (den originalen Kanten-Mittelpunkt) zurück und räumt danach wie
   * {@link onEdgeEnd} auf.
   */
  onEdgeCancel(edge: EdgeGrip, anchor: Vec2): void;
}

/**
 * Baut die CSS-`filter`-Kette für ein Hintergrund-Luftbild aus
 * `ContextImage.filters` (Sättigung/Helligkeit/Kontrast/Graustufen). `null`
 * bei fehlenden/neutralen Werten (kein `style`-Attribut nötig — vermeidet
 * unnötige Re-Renders/DOM-Diffs für das Gros der Bilder ohne Korrektur).
 * Reihenfolge (saturate→brightness→contrast→grayscale) ist beliebig, da jeder
 * Filter unabhängig auf den vorherigen Zustand wirkt.
 */
export function cssImageFilter(filters: PlanImage["filters"]): string | undefined {
  if (!filters) return undefined;
  const { saturation = 1, brightness = 1, contrast = 1, grayscale = 0 } = filters;
  if (saturation === 1 && brightness === 1 && contrast === 1 && grayscale === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (saturation !== 1) parts.push(`saturate(${saturation})`);
  if (brightness !== 1) parts.push(`brightness(${brightness})`);
  if (contrast !== 1) parts.push(`contrast(${contrast})`);
  if (grayscale !== 0) parts.push(`grayscale(${grayscale})`);
  return parts.join(" ");
}

export const PlanView = forwardRef<PlanViewHandle, PlanViewProps>(
  function PlanView(
    {
      plan,
      resetKey,
      onCursor,
      onScale,
      onSelect,
      onMarquee,
      onSegmentCut,
      onContextMenu,
      selectedWallIds,
      selectedCeilingIds,
      selectedOpeningIds,
      selectedStairIds,
      selectedRoomIds,
      selectedRoofIds,
      selectedContextObjectIds,
      selectedSectionLineIds,
      selectedExtrudedSolidIds,
      selectedColumnIds,
      selectedGroupIds,
      roomStamp,
      onStampMove,
      onStampEdit,
      onEditDrawingText,
      onEnterGroup,
      editTextId,
      editTextMinHeightM,
      onCommitTextEdit,
      onCloseTextEdit,
      onOpenSectionLevel,
      activeTool,
      toolInputActive,
      toolHandlers,
      showRulers = true,
      showGrid = false,
      hudFields,
      grips,
      gripHandleLines,
      edgeGrips,
      hairline,
      selectedDrawingId,
      selectedDrawingIds,
      gripHandlers,
      marqueeColor = DEFAULT_MARQUEE_COLOR,
      snapColor = DEFAULT_SNAP_COLOR,
      hoverDivideDelayMs = 300,
      hoverDivideCount = 2,
    },
    ref,
  ) {
  // Linke Maustaste liegt beim Werkzeug/der Transformation, wenn App das meldet
  // (toolInputActive) bzw. — fallback — ein Zeichenwerkzeug aktiv ist.
  const inputActive = toolInputActive ?? (!!activeTool && activeTool !== "select");
  const toolActive = inputActive && !!toolHandlers;
  // Editier-Griffe sind nur im Auswahl-Werkzeug aktiv.
  const gripsActive = !toolActive && !!grips && grips.length > 0 && !!gripHandlers;
  // Kanten-Griffe nur aktiv, wenn auch die Eckpunkt-Griffe aktiv sind.
  const edgeGripsActive = gripsActive && !!edgeGrips && edgeGrips.length > 0;
  // Eingepasste Standard-Ansicht aus den AKTUELLEN Bounds, über die fixe
  // toScreen-Abbildung. Reset-/Einpassen-Ziel + Bezug für die Zoom-Grenzen; wird
  // NICHT automatisch angewandt (nur bei resetKey-Wechsel und „Einpassen").
  const defaultView = useMemo<ViewBox>(() => {
    const { minX, minY, maxX, maxY } = plan.bounds;
    return {
      x: minX * PX_PER_M - PAD,
      y: -maxY * PX_PER_M - PAD,
      w: (maxX - minX) * PX_PER_M + PAD * 2,
      h: (maxY - minY) * PX_PER_M + PAD * 2,
    };
  }, [plan]);

  // Aktueller Ausschnitt; treibt die viewBox des SVG. Initial = eingepasst.
  const [view, setView] = useState<ViewBox>(defaultView);
  // Ausschnitt NUR bei Plan-/Geschoss-Wechsel (resetKey) auf „eingepasst"
  // zurücksetzen — NICHT bei jeder Bounds-Änderung durch Editieren (sonst
  // „wandert" die Ansicht beim Verschieben/Löschen mit). `defaultView` ist beim
  // resetKey-Wechsel bereits frisch (neues Geschoss), daher direkt anwendbar.
  useEffect(() => {
    setView(defaultView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Viewport-/LOD-Culling für `primitiveEls` (s. cullPrimitives.ts) — NUR
  // aktiv bei sehr vielen Primitiven (Kataster-DXF-Import, Nutzer-Report
  // 2026-10-09: 59'391 Einzel-Textbeschriftungen liessen die App nach dem
  // Import hängen, weil React/SVG ALLE auf einmal als DOM-Knoten erzeugte,
  // egal ob sichtbar oder lesbar) — bei normalen Projekten bleibt das
  // Verhalten exakt wie zuvor (kein Overhead, `cullState` bleibt `null`).
  //
  // ZWEI Kriterien, nicht nur Position: direkt nach einem Import zeigt die
  // "eingepasste" Übersicht den GESAMTEN Umriss (bei Luzern: 2158×2583 m) —
  // technisch liegen dann ALLE 59'391 Labels "im Bild", wären aber jedes nur
  // ein paar Pixel gross und unleserlich. `minTextHeightVb` filtert zusätzlich
  // nach Lesbarkeit bei der aktuellen Zoomstufe (unabhängig von der Position) —
  // erst damit bleibt auch der ALLERERSTE Blick nach dem Import schnell.
  //
  // Puffer+Hysterese (CULL_MARGIN_FACTOR, `cullStateStale`), damit kleine
  // Schwenks/Zoom-Schritte KEINE Neuberechnung auslösen — dieselbe Überlegung
  // wie beim bestehenden `primitiveEls`-Memo weiter unten, das bewusst NICHT
  // an `view` hängt (sonst Ruckler auf WebKitGTK bei jedem Pan/Zoom, s.
  // Kommentar dort): nur bei einem GRÖSSEREN Schwenk ODER spürbarem Hinein-
  // zoomen (view schrumpft stark — reines "liegt noch drin" reicht hier
  // NICHT, ein View, der nur kleiner wird, bleibt sonst fälschlich innerhalb
  // der alten, zu grosszügigen Region) wird neu gerechnet.
  const needsCull = plan.primitives.length > CULL_THRESHOLD;
  const [cullState, setCullState] = useState<CullState | null>(() => {
    if (!needsCull) return null;
    return computeCullState(defaultView);
  });
  useEffect(() => {
    if (!needsCull) {
      if (cullState !== null) setCullState(null);
      return;
    }
    if (!cullState || cullStateStale(cullState, view)) {
      setCullState(computeCullState(view));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, needsCull, plan]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Engine-Auswahl. STANDARD-Pfad: WebGL2 (useGlPlanRenderer); der SVG-Renderer
  // bleibt automatischer Fallback (nur falls WebGL2/Shader nicht verfügbar), `?gl=0`
  // erzwingt reines SVG. INTEGRATIONS-SPIKE: Mit `?engine=wasm` UND vorhandenem
  // WebGPU (navigator.gpu) übernimmt statt WebGL2 der native render2d-Renderer als
  // WASM/WebGPU-Viewport (useWasmPlanRenderer) — dieselbe Szene, dieselbe ViewBox,
  // dasselbe SVG-Overlay (Text/Griffe/Auswahl) darüber. Fehlt WebGPU trotz Flag:
  // stiller Fallback auf WebGL2 (+ Warnung).
  const engineParam =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("engine");
  const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const wantWasm = engineParam === "wasm" && hasWebGpu;
  useEffect(() => {
    if (engineParam === "wasm" && !hasWebGpu) {
      console.warn("engine=wasm angefragt, aber navigator.gpu fehlt → WebGL2-Fallback");
    }
  }, [engineParam, hasWebGpu]);
  // WebGL2 nur, wenn NICHT der WASM-Pfad aktiv ist (und `?gl!=0`).
  const wantGl =
    !wantWasm &&
    (typeof window === "undefined"
      ? true
      : new URLSearchParams(window.location.search).get("gl") !== "0");
  // Beide Hooks unbedingt aufrufen (Hook-Regeln); je nach Flag ist genau einer aktiv.
  const glHook = useGlPlanRenderer(canvasRef, wantGl);
  const wasmHook = useWasmPlanRenderer(canvasRef, wantWasm);
  const activeEngine = wantWasm ? wasmHook : glHook;
  const { render: renderGl, updateGeometry, ready: glReady } = activeEngine;
  // „GPU-Canvas montieren?" — beide GPU-Pfade brauchen das Canvas (an der ABSICHT
  // montiert, nicht am ready, sonst könnte die Engine mangels Canvas nie starten).
  const wantGpu = wantGl || wantWasm;
  // Georeferenzierte Hintergrund-Rasterbilder (Luftbild) vorhanden? Der GPU-
  // Canvas löscht das Blatt UNDURCHSICHTIG (clearColor …,1) und würde ein
  // dahinterliegendes Bild verdecken. Daher bei aktivem Luftbild bewusst den
  // vollen SVG-Pfad nutzen — dort liegt das Bild als eigene Ebene ZWISCHEN
  // Blatt-Hintergrund und Geometrie (sichtbar, ohne den GL-Renderer zu ändern).
  const hasBgImages = (plan.backgroundImages?.length ?? 0) > 0;
  // Eingebettete Bild-Zeichenelemente (Drawing2D `{shape:"image"}`, Foto/Logo/
  // PDF-Seite) kann das GPU-Backend ebenfalls nicht texturieren (kein Bild-
  // Primitiv in render2d, s. toRenderScene.ts `RImage`-Kommentar) — dieselbe
  // SVG-Fallback-Regel wie bei georeferenzierten Luftbildern.
  const hasDrawingImages = plan.primitives.some((p) => p.kind === "drawingImage");
  // Engine WIRKLICH aktiv? Steuert das Umschalten SVG↔GPU: bei false rendert der
  // volle SVG-Pfad (Fallback), bei true übernimmt die GPU-Ebene + Text-Overlay.
  const useGpuRenderer = wantGpu && glReady && !hasBgImages && !hasDrawingImages;

  // Stabiler Papier-Massstab-Nenner N (1:N) als REFERENZ für die Print-Strich-
  // breiten. BEWUSST NICHT der live aus dem Zoom abgeleitete N (der sich beim
  // Rad-Zoom ändert): Print-Strichbreiten sind echte Papier-mm, die beim Zoomen
  // MIT der Geometrie skalieren (reinzoomen = dicker). Damit das funktioniert,
  // muss die mm→Welt-Umrechnung an einem beim Rad-Zoom KONSTANTEN N hängen; er
  // ändert sich nur, wenn die Oberleiste explizit einen Massstab setzt
  // (applyScale) bzw. beim ersten Messen/Einpassen. So gilt: 1:10→1:100 = ×10
  // dicker (halber Sprung des Nenners → 10× mehr Welt-Meter je Papier-mm).
  const [paperScale, setPaperScale] = useState<number | null>(null);
  const paperScaleRef = useRef(paperScale);
  paperScaleRef.current = paperScale;
  // Frische Werte in Refs spiegeln, damit das (stabile) imperative Handle und
  // der Resize-Beobachter stets den aktuellen Stand lesen (Handle hat leere Deps).
  const viewRef = useRef(view);
  viewRef.current = view;
  const defaultViewRef = useRef(defaultView);
  defaultViewRef.current = defaultView;
  const toScreenRef = useRef(toScreen);
  toScreenRef.current = toScreen;
  const planRef = useRef(plan);
  planRef.current = plan;
  // Zuletzt tessellierter LOD-Bucket (quantisierter Zoom). Nur bei Bucket-Wechsel
  // wird die Bogen-Geometrie neu aufgebaut — sonst bliebe Pan/Zoom reines
  // Matrix-Update. −Infinity = „noch nie tesselliert".
  const lodBucketRef = useRef<number>(-Infinity);

  // Papier-Massstab-Nenner (1:N) für die GL-Strichbreiten — ECHTE mm im Massstab
  // (0.35 mm bei 1:100). Bevorzugt der stabile `paperScale` (wie beim SVG-Print);
  // solange der noch nicht gemessen ist, der live aus dem Ausschnitt abgeleitete N.
  // Im Haarlinien-Modus (Display, wie `textScaleForGl` daneben) NICHT den
  // stabilen `paperScale`: der bliebe beim Rad-Zoom konstant, während die GPU-
  // Strichbreite (`mm_to_device_px` = N/1000·PX_PER_M·meet) über `meet` trotzdem
  // mit dem Zoom wächst — genau der Haarlinien-Bug (Finding 1). Der LIVE aus dem
  // Ausschnitt abgeleitete `scaleFromView` ist hingegen exakt der reziproke Wert
  // von `meet` (siehe dessen Formel), sodass N·meet — und damit die GL-Strich-
  // breite in Geräte-px — unabhängig vom Zoom konstant bleibt: dieselbe Wirkung
  // wie `non-scaling-stroke` im SVG-Pfad, nur über den Massstab-Nenner erzielt.
  const paperScaleForGl = (v: ViewBox): number =>
    hairline
      ? scaleFromView(v, svgRef.current) ?? 100
      : paperScaleRef.current ?? scaleFromView(v, svgRef.current) ?? 100;

  // Referenz-Nenner (1:N) NUR für die Text-Schriftgröße der Engine — spiegelt
  // EXAKT die SVG-Formel (case "text" unten, gleiche `print`-Bedingung): im
  // normalen Anzeigemodus fest auf die Referenzskala 1:100 (Raumstempel bleibt
  // lesbar, unabhängig vom zufälligen Einpass-Massstab der Ansicht), erst im
  // Druck-Modus der echte gemessene `paperScale`. BEWUSST NICHT `paperScaleForGl`
  // (das dort verwendete live abgeleitete N wäre für Text willkürlich/unlesbar
  // und würde vom SVG-Referenzpfad abweichen — siehe Doku in `gpu::Renderer`).
  const textScaleForGl = (): number => {
    const print = !hairline && paperScale != null && paperScale > 0;
    return print ? paperScale! : 100;
  };

  // Bildschirm-Massstab (Geräte-px je Modell-Meter) beim aktuellen Ausschnitt:
  // meet-Skala (CSS-px je viewBox-Einheit) · PX_PER_M (viewBox-Einheiten je Meter)
  // · dpr (Geräte-px je CSS-px). Steuert die adaptive Bogen-Tessellierung.
  const pxPerMeterForView = (v: ViewBox): number => {
    const meet = meetScale(v, svgRef.current);
    if (!meet || meet <= 0) return 0;
    return meet * PX_PER_M * (window.devicePixelRatio || 1);
  };
  // LOD-Bucket = quantisierter Zoom (log2 des Bildschirm-Massstabs, auf Ganzzahl
  // gerundet → Schritte von ×2). Nur ein Bucket-Wechsel löst eine Neu-Tessellierung
  // aus; innerhalb eines Buckets bleibt Pan/Zoom reines Matrix-Uniform-Update.
  const lodBucketForView = (v: ViewBox): number => {
    const s = pxPerMeterForView(v);
    return s > 0 ? Math.round(Math.log2(s)) : -Infinity;
  };

  // GL-Geometrie beim Plan-Wechsel neu tessellieren + sofort neu zeichnen. Der
  // aktuelle LOD-Bucket wird mitgeschrieben, damit der Pan/Zoom-Effekt weiss, ab
  // wann sich der Zoom weit genug bewegt hat, um Bögen neu aufzulösen.
  useEffect(() => {
    if (!useGpuRenderer) return;
    const v = viewRef.current;
    updateGeometry(plan, pxPerMeterForView(v));
    lodBucketRef.current = lodBucketForView(v);
    renderGl(v, paperScaleForGl(v), textScaleForGl());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useGpuRenderer, plan, updateGeometry, renderGl]);

  // GL bei jeder Ausschnittsänderung (Pan/Zoom) neu zeichnen. Normalfall: NUR
  // Matrix-Uniform (keine Re-Tessellierung → flüssig). Ausnahme: hat der Zoom
  // einen neuen LOD-Bucket erreicht, werden die Bögen einmalig mit dem neuen
  // Bildschirm-Massstab neu tesselliert (rund beim Hineinzoomen, billig weit weg).
  // Kostennotiz: `updateGeometry` baut die GESAMTE Linien-/Füll-Geometrie neu auf,
  // nicht nur die Bögen — Bucket-Wechsel sind aber selten (Zoom-Faktor ×2).
  useEffect(() => {
    if (!useGpuRenderer) return;
    const bucket = lodBucketForView(view);
    if (bucket !== lodBucketRef.current) {
      lodBucketRef.current = bucket;
      updateGeometry(plan, pxPerMeterForView(view));
    }
    renderGl(view, paperScaleForGl(view), textScaleForGl());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useGpuRenderer, renderGl, view, paperScale]);

  // Ausstehende imperative Pan-Aufräumung beim Unmount.
  useEffect(() => {
    return () => {
      if (panRaf.current !== null) cancelAnimationFrame(panRaf.current);
    };
  }, []);

  // LIVE Papier-Massstab (1:N) nach oben melden. Berechnung aus der effektiven
  // meet-Skala (Bildschirm-px je viewBox-Einheit) → px je Meter → mm je Meter,
  // verglichen mit der Papier-Abbildung. Aktualisiert bei Ausschnitts-/Größen-
  // änderung; ein ResizeObserver fängt reine Größenänderungen ab.
  const reportScale = () => {
    if (!onScale) return;
    const n = scaleFromView(viewRef.current, svgRef.current);
    if (n != null && isFinite(n)) onScale(n);
  };
  useEffect(() => {
    reportScale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScale, view, plan]);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => reportScale());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScale]);

  // Referenz-Papier-Massstab initialisieren, sobald das SVG messbar ist (bzw. der
  // Plan/das Geschoss wechselt): aus dem AKTUELLEN Ausschnitt (der beim Wechsel
  // eingepasst wird). Danach bleibt er beim Rad-Zoom stehen; applyScale setzt ihn
  // explizit neu. Ohne Messung (SSR/erste Runde) bleibt er null → Fallback im
  // Renderer auf live-N, damit Print nie „unsichtbar" wird.
  useEffect(() => {
    if (paperScaleRef.current != null) return;
    const n = scaleFromView(viewRef.current, svgRef.current);
    if (n != null && isFinite(n) && n > 0) setPaperScale(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  // Beim Plan-/Geschoss-Wechsel den Referenz-Massstab an den (frisch eingepassten)
  // Ausschnitt angleichen.
  useEffect(() => {
    const n = scaleFromView(defaultViewRef.current, svgRef.current);
    if (n != null && isFinite(n) && n > 0) setPaperScale(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Frischer Spiegel der gripHandlers-Prop für das (unten stabil mit leeren
  // Deps memoisierte) Imperativ-Handle — direkt referenzieren würde die Prop
  // vom ERSTEN Render einfrieren (stale closure, s. Kommentar dort).
  const gripHandlersRef = useRef(gripHandlers);
  gripHandlersRef.current = gripHandlers;

  // Imperatives Steuerhandle für die Oberleiste (Einpassen / Auswahl / Massstab).
  // Stabil (leere Deps); liest den frischen Ausschnitt + die Auswahl aus Refs.
  useImperativeHandle(
    ref,
    () => ({
      fit: () => setView(defaultViewRef.current),
      confirmGripEdit: () => {
        // Von der Befehlszeile aus angestoßen (Enter mit leerem Eingabetext,
        // s. App.tsx) — dieselbe Aktion wie ein bestätigender Klick auf der
        // Zeichenfläche (siehe onPointerDown-Kopf unten), nur eben nicht über
        // ein Pointer-Event.
        if (gripDrag.current) {
          gripDrag.current = null;
          gripHandlersRef.current?.onGripEnd();
        }
      },
      confirmEdgeEdit: () => {
        if (edgeDrag.current) {
          edgeDrag.current = null;
          gripHandlersRef.current?.onEdgeEnd();
        }
      },
      fitSelection: () => {
        const sel = selectedRef.current;
        const prim = sel !== null ? planRef.current.primitives[sel] : undefined;
        if (prim && prim.kind === "polygon") {
          setView(fitBoxFor(prim.pts, toScreenRef.current));
        } else {
          setView(defaultViewRef.current);
        }
      },
      applyScale: (n: number) => {
        const target = viewForScale(n, viewRef.current, svgRef.current);
        if (target) setView(target);
        // Diesen Massstab als stabile Referenz für die Print-Strichbreiten merken:
        // ab jetzt skalieren die Papier-mm-Linien um genau dieses N (bis der
        // nächste Massstab gewählt wird); Rad-Zoom lässt ihn unberührt.
        if (n > 0) setPaperScale(n);
      },
      pxPerMeter: () => currentPxPerMeter(),
      viewCenterModel: () => {
        // Mitte der frischen viewBox (aus Ref) → Modell (inverse toScreen).
        const v = viewRef.current;
        return { x: (v.x + v.w / 2) / PX_PER_M, y: -(v.y + v.h / 2) / PX_PER_M };
      },
      setCamera: (center, pxPerMeter) => {
        const target = viewForCamera(center, pxPerMeter, svgRef.current);
        if (target) setView(target);
      },
      fitBounds: (pts) => {
        if (pts.length === 0) return; // leerer Import → kein Fit, kein Crash
        setView(fitBoxFor(pts, toScreenRef.current));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Transiente Pan-Zieh-Daten (Mitteltaste; kein State → kein Re-Render je
  // Bewegung).
  const drag = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startView: ViewBox;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Transiente Marquee-Zieh-Daten (linke Taste). Startpunkt in viewBox-Einheiten
  // + die Bildschirm-Pixel (für die Klick-vs-Drag-Schwelle).
  const marquee = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startView: Vec2; // Startpunkt in viewBox-Einheiten
    moved: boolean; // Schwelle überschritten → echtes Rechteck (kein Klick)
  } | null>(null);
  // Aktuelles Auswahl-Rechteck in viewBox-Einheiten (für die sichtbare Kontur);
  // null = kein Marquee aktiv.
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    crossing: boolean;
  } | null>(null);

  // Hover-Teilpunkte (Nutzer-Wunsch): ruht der Cursor im Auswahl-Ruhezustand
  // (kein Werkzeug/Drag/Marquee — s. Aufruf in onPointerMove) länger als
  // `hoverDivideDelayMs` auf einem 2D-Linien-Segment, werden dessen gleiche
  // Teilpunkte (Anzahl `hoverDivideCount`, 2 = nur Mitte) kurz mit
  // Akzentfarbe eingeblendet. Reine Sichtbarkeits-Hilfe, kein Snap-Ziel.
  const [hoverDivideSeg, setHoverDivideSeg] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  // Zuletzt erkanntes Segment (Serialisiert als Schlüssel) — erkennt einen
  // Wechsel, ohne bei jedem Move-Event neu zu timern.
  const hoverDivideKeyRef = useRef<string | null>(null);
  const hoverDivideTimerRef = useRef<number | null>(null);

  // Nächstliegendes Linien-Segment unterm Cursor ermitteln und die
  // Hover-Teilpunkte-Anzeige entsprechend (neu) timern/verwerfen.
  const updateHoverDivide = (clientX: number, clientY: number) => {
    const seg = nearestLineSegment(clientX, clientY);
    const key = seg ? `${seg.a.x},${seg.a.y}|${seg.b.x},${seg.b.y}` : null;
    if (key === hoverDivideKeyRef.current) return; // dasselbe Segment (oder weiter keins)
    hoverDivideKeyRef.current = key;
    if (hoverDivideTimerRef.current !== null) {
      window.clearTimeout(hoverDivideTimerRef.current);
      hoverDivideTimerRef.current = null;
    }
    setHoverDivideSeg(null); // Segment gewechselt → alte Anzeige sofort weg
    if (!seg) return;
    hoverDivideTimerRef.current = window.setTimeout(() => {
      hoverDivideTimerRef.current = null;
      setHoverDivideSeg(seg);
    }, hoverDivideDelayMs);
  };
  const clearHoverDivide = () => {
    if (hoverDivideTimerRef.current !== null) {
      window.clearTimeout(hoverDivideTimerRef.current);
      hoverDivideTimerRef.current = null;
    }
    hoverDivideKeyRef.current = null;
    setHoverDivideSeg(null);
  };
  // Weg, sobald ein Werkzeug aktiv wird (sonst könnte eine veraltete Anzeige
  // ohne weiteres Move-Event über einem neuen Werkzeug-Entwurf stehen bleiben).
  useEffect(() => {
    if (toolActive) clearHoverDivide();
  }, [toolActive]);
  useEffect(() => () => clearHoverDivide(), []);

  // Transiente Griff-Zieh-Daten (linke Taste auf einem Grip). Kein State je
  // Bewegung; die Modell-Mutation läuft live über gripHandlers.onGripMove.
  // Anders als bei Kante/Körper braucht das Loslassen der Maus die Bearbeitung
  // NICHT mehr zu beenden: der Griff bleibt „bewaffnet" (kein Pointer-Capture),
  // folgt dem Cursor beim Schweben weiter — wie beim Zeichnen (Klick → Punkt
  // setzen, Maus bewegt sich frei, Wert tippbar, nächster Klick/Enter bestätigt,
  // Escape verwirft zur ursprünglichen Position `origin` zurück).
  const gripDrag = useRef<{ pointerId: number; index: number; origin: Vec2 } | null>(
    null,
  );
  // Transiente Kanten-Griff-Zieh-Daten (linke Taste auf einem Dreieck-Anfasser).
  // Hält den gegriffenen EdgeGrip (Momentaufnahme vom Grab — sein `.mid` ist der
  // Anker für Feld-Eingabe/Escape-Revert); die Mutation läuft live über
  // onEdgeMove. Dasselbe „bewaffnet"-Verhalten wie gripDrag oben: Loslassen
  // beendet die Bearbeitung NICHT, erst ein weiterer Klick/Enter (bestätigt)
  // oder Escape (verwirft zurück auf `edge.mid`).
  const edgeDrag = useRef<{ pointerId: number; edge: EdgeGrip } | null>(null);
  // Transiente „Körper verschieben"-Daten: letzter Modellpunkt, gegen den das
  // inkrementelle Delta gebildet wird (parallel-Verschiebung des Elements).
  const moveDrag = useRef<{
    pointerId: number;
    last: Vec2;
    target: { wallId?: string; drawingId?: string };
  } | null>(null);
  // Transiente Stempel-Griff-Zieh-Daten: letzter Modellpunkt, gegen den das
  // inkrementelle Delta gebildet wird (verschiebt NUR den Raum-Stempel-Anker).
  const stampDrag = useRef<{ pointerId: number; roomId: string; last: Vec2 } | null>(
    null,
  );
  // Letzter Links-Klick (Zeit + Bildschirmposition) für die manuelle Doppelklick-
  // Erkennung auf Raum-Stempel (Pointer-Capture unterdrückt natives dblclick).
  const lastClickRef = useRef<{ t: number; x: number; y: number } | null>(null);

  // Tastatur-Abschluss eines bewaffneten Punkt- ODER Kanten-Griffs (s. gripDrag/
  // edgeDrag oben): Escape verwirft (zurück auf die Ursprungsposition), Enter
  // bestätigt die aktuelle Position — beide NUR wenn kein Eingabefeld
  // fokussiert ist (die Befehlszeile behandelt ihr eigenes Enter für getippte
  // Werte selbst, s. App.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const gd = gripDrag.current;
      const ed = edgeDrag.current;
      if ((!gd && !ed) || !gripHandlers) return;
      if (e.key !== "Escape" && e.key !== "Enter") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      e.preventDefault();
      if (gd) {
        gripDrag.current = null;
        if (e.key === "Escape") gripHandlers.onGripCancel(gd.index, gd.origin);
        else gripHandlers.onGripEnd();
      } else if (ed) {
        edgeDrag.current = null;
        if (e.key === "Escape") gripHandlers.onEdgeCancel(ed.edge, ed.edge.mid);
        else gripHandlers.onEdgeEnd();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gripHandlers]);

  /** Bildschirm-px-Distanz Cursor → Stempel-Griff; null = kein einzelner Raum. */
  const stampHandleAt = (clientX: number, clientY: number): string | null => {
    if (!roomStamp) return null;
    const s = vbToClient(toScreen(roomStamp.anchor).x, toScreen(roomStamp.anchor).y);
    const d = Math.hypot(clientX - s.x, clientY - s.y);
    return d <= GRIP_HIT_PX ? roomStamp.roomId : null;
  };

  // Lokale Auswahl: Index des hervorgehobenen Polygon-Primitivs (oder null).
  // Reine Darstellung; die eigentliche Wand-Auswahl meldet onSelect nach oben.
  // Beim Plan-Wechsel zurücksetzen (Indizes sind nicht mehr gültig).
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    setSelected(null);
  }, [plan]);

  // Verhältnis viewBox-Einheiten ↔ Bildschirm-Pixel. preserveAspectRatio
  // "xMidYMid meet" passt die viewBox einheitlich (kleinerer Faktor) ein und
  // zentriert sie; daraus ergibt sich die effektive Skala + der Versatz.
  const measure = (vb: ViewBox) => {
    const el = svgRef.current;
    const rect = el?.getBoundingClientRect();
    const pxW = rect?.width ?? vb.w;
    const pxH = rect?.height ?? vb.h;
    // Bildschirm-Pixel je viewBox-Einheit (meet = min beider Achsen).
    const scale = Math.min(pxW / vb.w, pxH / vb.h);
    const drawnW = vb.w * scale;
    const drawnH = vb.h * scale;
    // Letterbox-Versatz durch die Zentrierung.
    const offX = (pxW - drawnW) / 2;
    const offY = (pxH - drawnH) / 2;
    return { rect, scale, offX, offY };
  };

  // Cursor-Position (clientX/Y) → viewBox-Koordinaten des aktuellen Ausschnitts.
  const clientToView = (clientX: number, clientY: number, vb: ViewBox): Vec2 => {
    const { rect, scale, offX, offY } = measure(vb);
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return {
      x: vb.x + (clientX - left - offX) / scale,
      y: vb.y + (clientY - top - offY) / scale,
    };
  };

  // viewBox-Einheiten → Modell-Koordinaten in Metern (Inverse des fixen
  // toScreen): x/PX_PER_M, Plan-Y zeigt nach oben → −y/PX_PER_M.
  const viewToModel = (vbX: number, vbY: number): Vec2 => ({
    x: vbX / PX_PER_M,
    y: -vbY / PX_PER_M,
  });

  // Roher Modellpunkt (Meter) unter dem Cursor — für die Zeichenwerkzeuge.
  const rawModelAt = (clientX: number, clientY: number): Vec2 => {
    const v = clientToView(clientX, clientY, view);
    return viewToModel(v.x, v.y);
  };
  // viewBox-Koordinaten → Client-Pixel (Inverse von clientToView), für die
  // Griff-Trefferprüfung in Bildschirm-Pixeln.
  const vbToClient = (vbX: number, vbY: number): { x: number; y: number } => {
    const { rect, scale, offX, offY } = measure(view);
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return { x: left + offX + (vbX - view.x) * scale, y: top + offY + (vbY - view.y) * scale };
  };
  // Index des Griffs unter dem Cursor (Bildschirm-Pixel) oder null.
  const gripAt = (clientX: number, clientY: number): number | null => {
    if (!grips) return null;
    for (let i = 0; i < grips.length; i++) {
      const vb = toScreen(grips[i]);
      const c = vbToClient(vb.x, vb.y);
      if (Math.hypot(c.x - clientX, c.y - clientY) <= GRIP_HIT_PX) return i;
    }
    return null;
  };
  // Bildschirm-Versatz (viewBox-Einheiten) eines Kanten-Anfassers entlang seiner
  // Normale: das Dreieck sitzt etwas AUSSERHALB der Kante. Y wird gespiegelt
  // (toScreen spiegelt Y), damit „außen" am Bildschirm auch wirklich außen ist.
  // Dreieck-Höhe (nach außen) + halbe Basisbreite in Bildschirm-Pixeln. Die Basis
  // sitzt AUF der Linie (am Kanten-Mittelpunkt), die Spitze zeigt nach außen.
  // Flacher, breiter Pfeil (Apex ~124°, also flacher als 120°) statt spitzem
  // Dreieck: breitere Basis, geringere Höhe.
  const EDGE_GRIP_H_PX = 8;
  const EDGE_GRIP_HALF_PX = 15;
  const screenNormal = (n: Vec2): Vec2 => ({ x: n.x, y: -n.y });
  // Index des Kanten-Griffs unter dem Cursor (Bildschirm-Pixel) oder null. Die
  // Trefferfläche liegt um die Dreiecks-Mitte (etwas außerhalb der Linie).
  const edgeGripAt = (clientX: number, clientY: number): EdgeGrip | null => {
    if (!edgeGrips) return null;
    const s = meetScale(view, svgRef.current) ?? 1;
    const midOutVb = (EDGE_GRIP_H_PX * 0.45) / s; // Mitte des Dreiecks
    for (const e of edgeGrips) {
      const m = toScreen(e.mid);
      const sn = screenNormal(e.normal);
      const cVb = { x: m.x + sn.x * midOutVb, y: m.y + sn.y * midOutVb };
      const c = vbToClient(cVb.x, cVb.y);
      if (Math.hypot(c.x - clientX, c.y - clientY) <= GRIP_HIT_PX) return e;
    }
    return null;
  };
  // Aktuelle Bildschirm-Pixel pro Meter (für die zoom-unabhängige Snap-Toleranz).
  const currentPxPerMeter = (): number =>
    (meetScale(view, svgRef.current) ?? 1) * PX_PER_M;
  // Modifikatoren eines Pointer-Events (Shift=Ortho, Ctrl/Cmd=Snap aus).
  const toolMods = (e: React.PointerEvent | React.MouseEvent) => ({
    shift: e.shiftKey,
    ctrl: e.ctrlKey || e.metaKey,
    alt: e.altKey,
  });

  // Cursor in Modell-Metern nach oben melden (für die Status-Leiste) und
  // lokal für die Lineal-Marker halten (App re-rendert bei jedem Move ohnehin
  // über onCursor → X/Y-Anzeige; das lokale State-Update kostet nichts extra).
  const [rulerCursor, setRulerCursor] = useState<Vec2 | null>(null);
  const reportCursor = (clientX: number, clientY: number) => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    setRulerCursor(m);
    if (!onCursor) return;
    onCursor(m);
  };

  // Trefferprüfung: liefert den Index des obersten Polygon-Primitivs unter dem
  // Cursor (Modellpunkt in einem Schicht-Polygon) oder null. In umgekehrter
  // Reihenfolge testen, damit das zuletzt gezeichnete (oberste) zuerst trifft.
  const hitTest = (clientX: number, clientY: number): number | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    const prims = plan.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims[i];
      if (p.kind === "polygon" && pointInPolygon(m, p.pts)) return i;
    }
    return null;
  };

  // Irgendein Element (Wand/Decke/Raum/Treppe/Stütze/Dach/2D) unter dem
  // Cursor — für Gruppen-Eintritt per Doppelklick (`onEnterGroup`). Nutzt
  // `hitTest` (Polygon-Primitive, deckt alle flächigen Bauteile ab) und
  // fällt für linienbasierte 2D-Elemente auf `pickDrawing` zurück (das
  // selbst erst nach dessen Definition unten verfügbar ist, daher als
  // separate Closure statt inline hier).
  const anyGroupableHit = (clientX: number, clientY: number): GroupableHit | null => {
    const idx = hitTest(clientX, clientY);
    if (idx !== null) {
      const p = plan.primitives[idx];
      if (p.kind === "polygon") {
        if (p.wallId) return { wallId: p.wallId };
        if (p.ceilingId) return { ceilingId: p.ceilingId };
        if (p.roomId) return { roomId: p.roomId };
        if (p.stairId) return { stairId: p.stairId };
        if (p.columnId) return { columnId: p.columnId };
        if (p.roofId) return { roofId: p.roofId };
        if (p.drawingId) return { drawingId: p.drawingId };
      }
    }
    const did = pickDrawing(clientX, clientY);
    return did ? { drawingId: did } : null;
  };

  // Abstand (Bildschirm-Pixel) eines Klicks vom Ring eines Kreis/Bogen-2D-
  // Elements — bei gefüllten Kreisen zählt auch INNERHALB als Treffer (d=0).
  // Bögen zusätzlich auf ihre Winkel-Spanne begrenzt (CCW, Modell-Radiant, s.
  // toRenderScene.ts für dieselbe Normalisierung).
  const distToDrawingRing = (
    clientX: number,
    clientY: number,
    p: Extract<Primitive, { kind: "drawingCircle" | "drawingArc" }>,
  ): number => {
    const m = rawModelAt(clientX, clientY);
    const distFromCenter = Math.hypot(m.x - p.center.x, m.y - p.center.y);
    if (p.kind === "drawingArc") {
      const TAU = Math.PI * 2;
      const sweep = (((p.a1 - p.a0) % TAU) + TAU) % TAU || TAU;
      const ang = Math.atan2(m.y - p.center.y, m.x - p.center.x);
      const rel = (((ang - p.a0) % TAU) + TAU) % TAU;
      // Kleiner Winkel-Toleranzsaum (in Bogenmass, radiusabhängig), damit die
      // Enden eines kurzen Bogens nicht unerreichbar schmal werden.
      const angTolRad = distFromCenter > 1e-6 ? LINE_PICK_PX / (currentPxPerMeter() * Math.max(distFromCenter, 0.05)) : Infinity;
      if (rel > sweep + angTolRad && TAU - rel > angTolRad) return Infinity;
    }
    const filled = p.kind === "drawingCircle" && p.fill !== "none";
    const dMeters = filled ? Math.max(0, distFromCenter - p.r) : Math.abs(distFromCenter - p.r);
    return dMeters * currentPxPerMeter();
  };

  // Nächstgelegenes 2D-Zeichenelement (Drawing2D) zum Cursor per Linien-Nähe in
  // Bildschirm-Pixeln (zoom-unabhängige Toleranz). Liefert die drawingId oder null.
  const pickDrawing = (clientX: number, clientY: number): string | null => {
    let bestId: string | null = null;
    let bestDist = LINE_PICK_PX;
    for (const p of plan.primitives) {
      if (p.kind === "line" && p.drawingId) {
        const a = vbToClient(toScreen(p.a).x, toScreen(p.a).y);
        const b = vbToClient(toScreen(p.b).x, toScreen(p.b).y);
        const d = pointSegDistPx({ x: clientX, y: clientY }, a, b);
        if (d < bestDist) {
          bestDist = d;
          bestId = p.drawingId;
        }
      } else if ((p.kind === "drawingCircle" || p.kind === "drawingArc") && p.drawingId) {
        const d = distToDrawingRing(clientX, clientY, p);
        if (d < bestDist) {
          bestDist = d;
          bestId = p.drawingId;
        }
      }
    }
    if (bestId) return bestId;
    // Kein Linien-/Kreis-/Bogen-Treffer: Text- dann Bild-Elemente prüfen (eigene Bbox-Logik).
    return pickDrawingText(clientX, clientY) ?? pickDrawingImage(clientX, clientY);
  };

  // Nächstgelegenes EINZELNES Geraden-Segment (nicht das ganze Element) für
  // die Hover-Teilpunkte-Anzeige (s. hoverDivideSeg unten) — dieselbe Nähe-
  // Logik wie pickDrawing, liefert aber die zwei Endpunkte des getroffenen
  // Segments selbst: eine Polylinie besteht aus mehreren "line"-Primitiven
  // (eins je Segment, gleiche drawingId), unterteilt werden soll nur das
  // konkret gehoverte Segment, nicht das ganze Element.
  const nearestLineSegment = (clientX: number, clientY: number): { a: Vec2; b: Vec2 } | null => {
    let best: { a: Vec2; b: Vec2 } | null = null;
    let bestDist = LINE_PICK_PX;
    for (const p of plan.primitives) {
      if (p.kind !== "line" || !p.drawingId) continue;
      const a = vbToClient(toScreen(p.a).x, toScreen(p.a).y);
      const b = vbToClient(toScreen(p.b).x, toScreen(p.b).y);
      const d = pointSegDistPx({ x: clientX, y: clientY }, a, b);
      if (d < bestDist) {
        bestDist = d;
        best = { a: p.a, b: p.b };
      }
    }
    return best;
  };

  // Trifft der Klick ein Text-2D-Element (kind "drawingText")? Grosszügige Modell-
  // Bounding-Box um den Ankerpunkt (Text hat keine Linien-Geometrie zum Anfassen);
  // Winkel wird vernachlässigt (meist waagrecht). Liefert die drawingId oder null.
  const pickDrawingText = (clientX: number, clientY: number): string | null => {
    const m = rawModelAt(clientX, clientY);
    for (const p of plan.primitives) {
      if (p.kind !== "drawingText" || !p.drawingId) continue;
      const singleW = Math.max(1, p.text.length) * p.heightM * 0.6;
      // Textspalte: Breite = wrapWidth, Höhe = geschätzte Zeilenzahl · Zeilenhöhe.
      const w = p.wrapWidth && p.wrapWidth > 0 ? p.wrapWidth : singleW;
      const lines =
        p.wrapWidth && p.wrapWidth > 0 ? Math.max(1, Math.ceil(singleW / p.wrapWidth)) : 1;
      const pad = p.heightM * 0.6;
      const minX = p.at.x - pad;
      const maxX = p.at.x + w + pad;
      // Baseline am Anker; Text läuft nach unten (Zeilen) und etwas nach oben (Oberlängen).
      const minY = p.at.y - lines * p.heightM * 1.25 - pad;
      const maxY = p.at.y + p.heightM * 0.4 + pad;
      if (m.x >= minX && m.x <= maxX && m.y >= minY && m.y <= maxY) {
        return p.drawingId;
      }
    }
    return null;
  };

  // Trifft der Klick ein Bild-2D-Element (kind "drawingImage")? Reine
  // Bounding-Box-Prüfung (achsparallel, keine Rotation). Liefert die drawingId
  // oder null.
  const pickDrawingImage = (clientX: number, clientY: number): string | null => {
    const m = rawModelAt(clientX, clientY);
    for (let i = plan.primitives.length - 1; i >= 0; i--) {
      const p = plan.primitives[i];
      if (p.kind !== "drawingImage" || !p.drawingId) continue;
      if (m.x >= p.min.x && m.x <= p.max.x && m.y >= p.min.y && m.y <= p.max.y) {
        return p.drawingId;
      }
    }
    return null;
  };

  // Nächstgelegene Öffnung (Fenster/Tür) zum Cursor: Linien-/Bogen-Primitive mit
  // `openingId` per Bildschirm-Nähe, plus getroffene Fenster-Rahmen (Polygon mit
  // openingId, per Punkt-in-Polygon). Liefert die openingId oder null.
  const pickOpening = (clientX: number, clientY: number): string | null => {
    let bestId: string | null = null;
    let bestDist = LINE_PICK_PX;
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    for (const p of plan.primitives) {
      if (p.kind === "line" && p.openingId) {
        const a = vbToClient(toScreen(p.a).x, toScreen(p.a).y);
        const b = vbToClient(toScreen(p.b).x, toScreen(p.b).y);
        const d = pointSegDistPx({ x: clientX, y: clientY }, a, b);
        if (d < bestDist) {
          bestDist = d;
          bestId = p.openingId;
        }
      } else if (p.kind === "arc" && p.openingId) {
        // Bogen: über from→to als Sehne annähern (ausreichend für die Auswahl).
        const a = vbToClient(toScreen(p.from).x, toScreen(p.from).y);
        const b = vbToClient(toScreen(p.to).x, toScreen(p.to).y);
        const d = pointSegDistPx({ x: clientX, y: clientY }, a, b);
        if (d < bestDist) {
          bestDist = d;
          bestId = p.openingId;
        }
      } else if (p.kind === "polygon" && p.openingId && pointInPolygon(m, p.pts)) {
        return p.openingId;
      }
    }
    return bestId;
  };

  // Nächstgelegene Treppe zum Cursor: getroffenes Tritt-/Podest-Polygon (per
  // Punkt-in-Polygon), sonst eine nahe Symbollinie (Lauflinie/Pfeil) mit stairId.
  const pickStair = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    for (const p of plan.primitives) {
      if (p.kind === "polygon" && p.stairId && pointInPolygon(m, p.pts)) {
        return p.stairId;
      }
    }
    let bestId: string | null = null;
    let bestDist = LINE_PICK_PX;
    for (const p of plan.primitives) {
      if (p.kind === "line" && p.stairId) {
        const a = vbToClient(toScreen(p.a).x, toScreen(p.a).y);
        const b = vbToClient(toScreen(p.b).x, toScreen(p.b).y);
        const d = pointSegDistPx({ x: clientX, y: clientY }, a, b);
        if (d < bestDist) {
          bestDist = d;
          bestId = p.stairId;
        }
      }
    }
    return bestId;
  };

  // Getroffener Raum: die Raum-Fläche (Polygon mit `roomId`) per Punkt-in-Polygon.
  // Bei überlappenden Räumen gewinnt der zuletzt gezeichnete (oberste).
  const pickRoom = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    for (let i = plan.primitives.length - 1; i >= 0; i--) {
      const p = plan.primitives[i];
      if (p.kind === "polygon" && p.roomId && pointInPolygon(m, p.pts)) {
        return p.roomId;
      }
    }
    return null;
  };

  // Getroffenes Dach: das unsichtbare Traufe-Pick-Polygon per Punkt-in-Polygon
  // (die sichtbaren Dachlinien allein wären schwer exakt zu treffen).
  const pickRoof = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    for (let i = plan.primitives.length - 1; i >= 0; i--) {
      const p = plan.primitives[i];
      if (p.kind === "polygon" && p.roofId && pointInPolygon(m, p.pts)) {
        return p.roofId;
      }
    }
    return null;
  };

  // Getroffene Schnitt-/Ansichtslinie: ihr schmales, unsichtbares Pick-Band
  // (Polygon mit sectionLineId) per Punkt-in-Polygon.
  const pickSectionLine = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    for (let i = plan.primitives.length - 1; i >= 0; i--) {
      const p = plan.primitives[i];
      if (p.kind === "polygon" && p.sectionLineId && pointInPolygon(m, p.pts)) {
        return p.sectionLineId;
      }
    }
    return null;
  };

  // Getroffenes Kontext-Objekt (importiertes Gebäude/Terrain): sein unsichtbares
  // Grundriss-Pick-Band (Bounding-Box) per Punkt-in-Polygon — macht es wie eine
  // Wand irgendwo innerhalb seiner Fläche anklickbar, nicht nur exakt auf der
  // dünnen Umrisslinie.
  const pickContextObject = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    for (let i = plan.primitives.length - 1; i >= 0; i--) {
      const p = plan.primitives[i];
      if (p.kind === "polygon" && p.contextObjectId && pointInPolygon(m, p.pts)) {
        return p.contextObjectId;
      }
    }
    return null;
  };

  // Getroffener extrudierter Körper (truck-Integration): der Footprint-Umriss
  // ist ein reiner Haarlinien-Umriss (fill:"none"), aber per Punkt-in-Polygon
  // trotzdem als FLÄCHE anklickbar (analog Raum, nicht nur auf der Linie).
  const pickExtrudedSolid = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    for (let i = plan.primitives.length - 1; i >= 0; i--) {
      const p = plan.primitives[i];
      if (p.kind === "polygon" && p.extrudedSolidId && pointInPolygon(m, p.pts)) {
        return p.extrudedSolidId;
      }
    }
    return null;
  };

  // Getroffene Stütze (Tragwerk): ihr Querschnitt ist eine gefüllte Poché
  // (Polygon mit columnId) — per Punkt-in-Polygon als FLÄCHE anklickbar.
  const pickColumn = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    for (let i = plan.primitives.length - 1; i >= 0; i--) {
      const p = plan.primitives[i];
      if (p.kind === "polygon" && p.columnId && pointInPolygon(m, p.pts)) {
        return p.columnId;
      }
    }
    return null;
  };

  // Liegt der Cursor auf dem KÖRPER eines GEWÄHLTEN Elements (Wand-Poché bzw.
  // 2D-Linie)? Liefert das gegriffene Element (Wand-ID ODER Drawing-ID) für das
  // Parallel-Verschieben — oder null. Bei MEHRFACHAUSWAHL wird das Element UNTER
  // dem Cursor gegriffen; die übrigen gewählten Enden wandern (App) koinzident mit.
  const grabbedBody = (
    clientX: number,
    clientY: number,
  ): { wallId?: string; drawingId?: string } | null => {
    const selWalls = new Set(selectedWallIds ?? []);
    if (selWalls.size) {
      const hi = hitTest(clientX, clientY);
      if (hi !== null) {
        const p = plan.primitives[hi];
        if (p.kind === "polygon" && p.wallId && selWalls.has(p.wallId)) {
          return { wallId: p.wallId };
        }
      }
    }
    const selDraws = selectedDrawingIds && selectedDrawingIds.length
      ? new Set(selectedDrawingIds)
      : selectedDrawingId
        ? new Set([selectedDrawingId])
        : null;
    if (selDraws) {
      const id = pickDrawing(clientX, clientY);
      if (id && selDraws.has(id)) return { drawingId: id };
    }
    return null;
  };

  // Maus-Schema (docs/design/context-menu.md): MITTE = schwenken (Pan),
  // LINKS = Auswahl, RECHTS = Kontextmenü, RAD = Zoom.
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Ein Punkt- ODER Kanten-Griff ist bereits „bewaffnet" (Maus wurde
    // losgelassen, der Griff folgt seither dem Cursor) — JEDER weitere
    // Linksklick bestätigt nur die aktuelle Position, statt irgendeine andere
    // Aktion (Doppelklick, Schere, neue Auswahl, …) an derselben Stelle
    // auszulösen.
    if (e.button === 0 && gripDrag.current && gripHandlers) {
      e.preventDefault();
      gripDrag.current = null;
      gripHandlers.onGripEnd();
      return;
    }
    if (e.button === 0 && edgeDrag.current && gripHandlers) {
      e.preventDefault();
      edgeDrag.current = null;
      gripHandlers.onEdgeEnd();
      return;
    }
    // Doppelklick (zweiter Klick der Sequenz) auf einen Raum-Stempel/-Fläche →
    // Stempel-Editor öffnen. Manuell über Zeit/Abstand erkannt, weil PlanView
    // Pointer-Capture nutzt und der Browser dann kein natives `dblclick`
    // synthetisiert (bzw. `detail` nicht zuverlässig füllt).
    if (e.button === 0 && !toolActive && onStampEdit) {
      const now = Date.now();
      const prev = lastClickRef.current;
      const isDbl =
        prev &&
        now - prev.t < 400 &&
        Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 6;
      lastClickRef.current = { t: now, x: e.clientX, y: e.clientY };
      if (isDbl) {
        const rid =
          stampHandleAt(e.clientX, e.clientY) ?? pickRoom(e.clientX, e.clientY);
        if (rid) {
          e.preventDefault();
          lastClickRef.current = null;
          onStampEdit(rid);
          return;
        }
      }
    }
    if (e.button === 1) {
      // Mittlere Taste: Ausschnitt zum Ziehen einfrieren (Pan).
      e.preventDefault(); // verhindert Auto-Scroll-Modus im Browser.
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startView: view,
      };
      setDragging(true);
      return;
    }
    if (e.button === 0 && e.altKey && onSegmentCut) {
      // Alt+Klick = Schere: getroffenes 2D-Element bestimmen und Segment-Löschen
      // an App melden (App ermittelt die nächstgelegene Kante aus dem Modellpunkt).
      const id = pickDrawing(e.clientX, e.clientY);
      if (id) {
        e.preventDefault();
        const v = clientToView(e.clientX, e.clientY, view);
        onSegmentCut(id, viewToModel(v.x, v.y));
        return;
      }
      // Kein 2D-Element getroffen → wie ein normaler Klick weiterbehandeln.
    }
    if (e.button === 0 && toolActive) {
      // Aktives Zeichenwerkzeug: linke Taste setzt Punkte (kein Marquee). Capture,
      // damit move/up zuverlässig ankommen; sofort eine Vorschau anstoßen.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      toolHandlers!.onToolMove(
        rawModelAt(e.clientX, e.clientY),
        currentPxPerMeter(),
        toolMods(e),
      );
      return;
    }
    if (e.button === 0 && !toolActive && roomStamp && onStampMove) {
      // Linke Taste auf dem Stempel-Griff: NUR den Stempel-Anker verschieben.
      const rid = stampHandleAt(e.clientX, e.clientY);
      if (rid) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        stampDrag.current = {
          pointerId: e.pointerId,
          roomId: rid,
          last: rawModelAt(e.clientX, e.clientY),
        };
        return;
      }
    }
    if (e.button === 0 && gripsActive) {
      // Linke Taste auf einem Editier-Griff: Griff ziehen (Endpunkt verschieben).
      const gi = gripAt(e.clientX, e.clientY);
      if (gi !== null) {
        e.preventDefault();
        // KEIN Pointer-Capture: der Griff bleibt nach dem Loslassen bewaffnet
        // und folgt via normalem Hover-onPointerMove weiter dem Cursor (s.
        // Kommentar an der gripDrag-Deklaration).
        gripDrag.current = { pointerId: e.pointerId, index: gi, origin: grips![gi] };
        return;
      }
      // Linke Taste auf einem Kanten-Anfasser (Dreieck): Seite ziehen. KEIN
      // Pointer-Capture — dasselbe „bewaffnet nach Loslassen"-Verhalten wie
      // beim Punkt-Griff (s. Kommentar an der edgeDrag-Deklaration).
      if (edgeGripsActive) {
        const eg = edgeGripAt(e.clientX, e.clientY);
        if (eg) {
          e.preventDefault();
          edgeDrag.current = { pointerId: e.pointerId, edge: eg };
          return;
        }
      }
      // Sonst: auf dem Körper eines gewählten Elements? → Parallel-Verschieben.
      const body = grabbedBody(e.clientX, e.clientY);
      if (body) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        moveDrag.current = { pointerId: e.pointerId, last: rawModelAt(e.clientX, e.clientY), target: body };
        return;
      }
    }
    // Körper-Verschieben auch bei MEHRFACHAUSWAHL (dann sind die einzel-Element-
    // Griffe inaktiv): Links-Drag auf einem gewählten Körper verschiebt es; die
    // koinzidenten Enden der übrigen gewählten Elemente wandern mit (App).
    if (e.button === 0 && !toolActive && !!gripHandlers && !gripsActive) {
      const body = grabbedBody(e.clientX, e.clientY);
      if (body) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        moveDrag.current = { pointerId: e.pointerId, last: rawModelAt(e.clientX, e.clientY), target: body };
        return;
      }
    }
    if (e.button === 0) {
      // Linke Taste: Auswahl-Geste beginnen. Ob daraus ein Klick (eine Wand
      // wählen) oder ein Marquee (Mengenauswahl) wird, entscheidet sich erst
      // beim Loslassen anhand der zurückgelegten Strecke (Schwelle in
      // onPointerMove). Startpunkt in viewBox-Einheiten festhalten.
      e.currentTarget.setPointerCapture(e.pointerId);
      const start = clientToView(e.clientX, e.clientY, view);
      marquee.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startView: start,
        moved: false,
      };
      return;
    }
    // Rechte Taste (button 2): Kontextmenü läuft über onContextMenu.
  };

  // Perf: modell-mutierende Drags (Griff/Kante/Körper/Stempel) auf EIN Update je
  // Animationsframe drosseln. Schnelles Ziehen feuert pointermove schneller, als
  // der Plan neu gebaut/gezeichnet werden kann — ungebremst staut sich ein
  // Rückstand ("kommt nicht hinterher"). Wir merken nur die NEUESTE Position und
  // verarbeiten sie einmal pro Frame.
  const dragMovePending = useRef<{
    cx: number;
    cy: number;
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    pointerId: number;
  } | null>(null);
  const dragMoveRaf = useRef<number | null>(null);

  // Imperativer GL-Pan/Zoom: während der Geste NICHT setView pro Frame (das würde
  // die ganze PlanView neu rendern). GL-Matrix wird pro Frame aktualisiert; das
  // SVG-Overlay bekommt statt eines viewBox-Neusatzes (→ Cairo-Re-Raster in
  // WebKitGTK, teuer!) einen GPU-komponierten CSS-`transform`. React-State (view)
  // + echtes viewBox werden erst beim Loslassen abgeglichen → in WebKit KEIN
  // SVG-Re-Raster je Frame mehr.
  const panPending = useRef<ViewBox | null>(null);
  const panStartView = useRef<ViewBox | null>(null); // viewBox bei Gestenbeginn (V0)
  const panRaf = useRef<number | null>(null);

  /**
   * CSS-transform, der das SVG (fest gezeichnet mit viewBox V0) so verschiebt/
   * skaliert, dass es exakt den Ziel-Ausschnitt V zeigt — deckungsgleich mit der
   * GL-Ebene (beide nutzen xMidYMid meet in dieselbe Elementbox).
   */
  const applySvgTransform = (v0: ViewBox, v: ViewBox) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const m = Math.min(rect.width / v0.w, rect.height / v0.h); // meet-Skala bei V0
    const A = v0.w / v.w; // Zoomfaktor (uniform)
    const lbX = (rect.width - v0.w * m) / 2; // Letterbox-Offset (0 bei passendem Aspekt)
    const lbY = (rect.height - v0.h * m) / 2;
    const cx = m * A * (v0.x - v.x) + (1 - A) * lbX;
    const cy = m * A * (v0.y - v.y) + (1 - A) * lbY;
    svg.style.transformOrigin = "0 0";
    svg.style.transform = `translate(${cx}px, ${cy}px) scale(${A})`;
  };

  const flushPan = () => {
    panRaf.current = null;
    const v = panPending.current;
    const v0 = panStartView.current;
    if (!v || !v0) return;
    viewRef.current = v; // abgeleitete Reads (Snap-Toleranz etc.) frisch halten
    applySvgTransform(v0, v); // SVG per GPU-Composit (kein Re-Raster)
    renderGl(v, paperScaleForGl(v), textScaleForGl()); // GL exakt auf V (Strich in echten Papier-mm)
  };
  /** Pan-/Zoom-Ziel imperativ anwenden (rAF-gedrosselt), ohne React-Render. */
  const enqueuePan = (v: ViewBox) => {
    if (!panStartView.current) panStartView.current = { ...viewRef.current };
    panPending.current = v;
    if (panRaf.current === null) panRaf.current = requestAnimationFrame(flushPan);
  };
  /** Anhängigen imperativen Pan in React-State übernehmen (+ Transform lösen). */
  const commitPan = () => {
    if (panRaf.current !== null) {
      cancelAnimationFrame(panRaf.current);
      panRaf.current = null;
    }
    if (panPending.current) {
      // SVG-Transform lösen; setView setzt das echte viewBox (ein einziger Re-Raster).
      if (svgRef.current) svgRef.current.style.transform = "";
      setView(panPending.current);
      panPending.current = null;
    }
    panStartView.current = null;
  };

  const flushDragMove = () => {
    dragMoveRaf.current = null;
    const p = dragMovePending.current;
    dragMovePending.current = null;
    if (!p) return;
    const mods = { shift: p.shift, ctrl: p.ctrl, alt: p.alt };
    const raw = rawModelAt(p.cx, p.cy);
    const ed = edgeDrag.current;
    if (ed && ed.pointerId === p.pointerId) {
      gripHandlers!.onEdgeMove(ed.edge, raw, currentPxPerMeter(), mods);
      return;
    }
    const gd = gripDrag.current;
    if (gd && gd.pointerId === p.pointerId) {
      gripHandlers!.onGripMove(gd.index, raw, currentPxPerMeter(), mods);
      return;
    }
    const sd = stampDrag.current;
    if (sd && sd.pointerId === p.pointerId) {
      const delta = { x: raw.x - sd.last.x, y: raw.y - sd.last.y };
      if ((delta.x !== 0 || delta.y !== 0) && onStampMove) {
        onStampMove(sd.roomId, delta);
        sd.last = raw;
      }
      return;
    }
    const md = moveDrag.current;
    if (md && md.pointerId === p.pointerId) {
      const delta = { x: raw.x - md.last.x, y: raw.y - md.last.y };
      if (delta.x !== 0 || delta.y !== 0) {
        gripHandlers!.onMoveBody(delta, md.target, mods);
        md.last = raw;
      }
      return;
    }
  };
  const enqueueDragMove = (e: React.PointerEvent<SVGSVGElement>) => {
    dragMovePending.current = {
      cx: e.clientX,
      cy: e.clientY,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      pointerId: e.pointerId,
    };
    if (dragMoveRaf.current === null) {
      dragMoveRaf.current = requestAnimationFrame(flushDragMove);
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // Immer die Cursor-Position melden (auch ohne Ziehen), für die Statusleiste.
    reportCursor(e.clientX, e.clientY);

    // Modell-mutierende Drags (Kante/Griff/Stempel/Körper): auf rAF drosseln —
    // ein Update je Frame mit der jeweils neuesten Position (siehe flushDragMove).
    if (
      (edgeDrag.current && edgeDrag.current.pointerId === e.pointerId) ||
      (gripDrag.current && gripDrag.current.pointerId === e.pointerId) ||
      (stampDrag.current && stampDrag.current.pointerId === e.pointerId) ||
      (moveDrag.current && moveDrag.current.pointerId === e.pointerId)
    ) {
      enqueueDragMove(e);
      return;
    }

    // Aktives Zeichenwerkzeug: Hover/Drag liefert die Live-Vorschau + Snap-Marker.
    // Mittlere Taste (Pan) bleibt davon unberührt (eigener Zweig unten).
    if (toolActive && drag.current === null) {
      toolHandlers!.onToolMove(
        rawModelAt(e.clientX, e.clientY),
        currentPxPerMeter(),
        toolMods(e),
      );
      return;
    }

    // Marquee (linke Taste) aufziehen: Rechteck in viewBox-Einheiten vom
    // Startpunkt zum aktuellen Cursor. Erst ab einer kleinen Pixel-Schwelle gilt
    // es als Drag (sonst bleibt es ein Klick → Einzelwahl beim Loslassen).
    const mq = marquee.current;
    if (mq && mq.pointerId === e.pointerId) {
      const dxPx = e.clientX - mq.startClientX;
      const dyPx = e.clientY - mq.startClientY;
      if (!mq.moved && Math.hypot(dxPx, dyPx) < MARQUEE_THRESHOLD_PX) return;
      mq.moved = true;
      const cur = clientToView(e.clientX, e.clientY, view);
      // crossing-Richtung aus dem Vorzeichen von Δx am Bildschirm (rechts→links
      // = negativ = berührend). Bildschirm-x und viewBox-x sind gleichläufig.
      const crossing = dxPx < 0;
      setMarqueeRect({
        x: Math.min(mq.startView.x, cur.x),
        y: Math.min(mq.startView.y, cur.y),
        w: Math.abs(cur.x - mq.startView.x),
        h: Math.abs(cur.y - mq.startView.y),
        crossing,
      });
      return;
    }

    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) {
      // Echter Ruhezustand (kein Drag/Werkzeug/Marquee/Pan) — Hover-
      // Teilpunkte-Erkennung.
      updateHoverDivide(e.clientX, e.clientY);
      return;
    }
    const { scale } = measure(d.startView);
    // Bildschirm-Delta → viewBox-Einheiten; Inhalt folgt dem Cursor, also
    // verschiebt sich der Ausschnitt entgegengesetzt.
    const dx = (e.clientX - d.startClientX) / scale;
    const dy = (e.clientY - d.startClientY) / scale;
    const next: ViewBox = {
      x: d.startView.x - dx,
      y: d.startView.y - dy,
      w: d.startView.w,
      h: d.startView.h,
    };
    // GL-Pfad: imperativ (rAF, kein React-Render pro Frame). SVG-Pfad: wie bisher
    // über setView (das SVG muss über React neu rendern).
    if (useGpuRenderer) enqueuePan(next);
    else setView(next);
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    // Perf: einen anhängigen (rAF-gedrosselten) Drag mit der FINALEN Position
    // sofort anwenden, damit das Objekt exakt an der Loslass-Stelle landet, bevor
    // committet wird.
    if (dragMoveRaf.current !== null) {
      cancelAnimationFrame(dragMoveRaf.current);
      dragMoveRaf.current = null;
    }
    if (
      (edgeDrag.current && edgeDrag.current.pointerId === e.pointerId) ||
      (gripDrag.current && gripDrag.current.pointerId === e.pointerId) ||
      (stampDrag.current && stampDrag.current.pointerId === e.pointerId) ||
      (moveDrag.current && moveDrag.current.pointerId === e.pointerId)
    ) {
      dragMovePending.current = {
        cx: e.clientX,
        cy: e.clientY,
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
        alt: e.altKey,
        pointerId: e.pointerId,
      };
      flushDragMove();
    }

    // Stempel-Griff loslassen: Ziehen abschließen.
    const sd = stampDrag.current;
    if (sd && sd.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      stampDrag.current = null;
      return;
    }
    // Kanten-Griff: Maus loslassen beendet die Bearbeitung NICHT mehr — kein
    // Pointer-Capture gehalten, der Griff bleibt bewaffnet und folgt weiter dem
    // Cursor. Abschluss erst per erneutem Klick (oben in onPointerDown) oder
    // Enter, Verwerfen per Escape (beides im Tastatur-Effekt unten).
    if (edgeDrag.current && edgeDrag.current.pointerId === e.pointerId) {
      return;
    }

    // Editier-Griff: Maus loslassen beendet die Bearbeitung NICHT mehr — kein
    // Pointer-Capture gehalten, der Griff bleibt bewaffnet und folgt weiter dem
    // Cursor. Abschluss erst per erneutem Klick (oben in onPointerDown) oder
    // Enter, Verwerfen per Escape (beides im Tastatur-Effekt unten).
    if (gripDrag.current && gripDrag.current.pointerId === e.pointerId) {
      return;
    }

    // Körper-Verschieben loslassen.
    const md = moveDrag.current;
    if (md && md.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      moveDrag.current = null;
      gripHandlers!.onGripEnd();
      return;
    }

    // Aktives Zeichenwerkzeug: linke Taste loslassen = Punkt setzen (Klick).
    if (toolActive && e.button === 0) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      toolHandlers!.onToolClick(
        rawModelAt(e.clientX, e.clientY),
        currentPxPerMeter(),
        toolMods(e),
      );
      return;
    }

    // Marquee/Klick (linke Taste) abschließen.
    const mq = marquee.current;
    if (mq && mq.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      marquee.current = null;
      if (mq.moved) {
        // Echtes Auswahl-Rechteck: Wände nach CAD-Konvention bestimmen und nach
        // oben melden. Das Rechteck stand zuletzt in marqueeRect (viewBox-Raum)
        // → in Modell-Raum umrechnen und gegen die Wand-Polygone testen.
        const cur = clientToView(e.clientX, e.clientY, view);
        const crossing = e.clientX - mq.startClientX < 0;
        const a = viewToModel(mq.startView.x, mq.startView.y);
        const b = viewToModel(cur.x, cur.y);
        const rect = {
          minX: Math.min(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxX: Math.max(a.x, b.x),
          maxY: Math.max(a.y, b.y),
        };
        if (onMarquee) {
          onMarquee({
            wallIds: marqueeHit(plan.primitives, rect, crossing),
            drawingIds: marqueeHitDrawings(plan.primitives, rect, crossing),
            ceilingIds: marqueeHitCeilings(plan.primitives, rect, crossing),
            roomIds: marqueeHitRooms(plan.primitives, rect, crossing),
            stairIds: marqueeHitStairs(plan.primitives, rect, crossing),
            crossing,
          });
        }
        // Die lokale Einzel-Hervorhebung räumen (jetzt gilt die Mengenauswahl).
        setSelected(null);
        setMarqueeRect(null);
        return;
      }
      // Kein Drag → Klick: Wand unter dem Cursor wählen bzw. Auswahl löschen.
      setMarqueeRect(null);
      const hitIndex = hitTest(e.clientX, e.clientY);
      setSelected(hitIndex);
      if (onSelect) {
        const v = clientToView(e.clientX, e.clientY, view);
        const hit = hitIndex !== null ? plan.primitives[hitIndex] : undefined;
        // Öffnung (Fenster/Tür) zuerst: ihr Symbol sitzt in der ausgesparten Lücke
        // bzw. schlägt über die Wand — ein Klick nahe am Symbol wählt die Öffnung.
        // Schnitt-/Ansichtslinie zuerst: ihr schmales Band liegt über allem, ein
        // Klick genau darauf meint die Linie (nicht die darunterliegende Wand) —
        // dann sofort melden (kein anderes Element konkurriert).
        const sectionLineId = pickSectionLine(e.clientX, e.clientY);
        if (sectionLineId) {
          onSelect({
            model: viewToModel(v.x, v.y),
            hitIndex,
            wallId: null,
            drawingId: null,
            ceilingId: null,
            openingId: null,
            stairId: null,
            roomId: null,
            extrudedSolidId: null,
            columnId: null,
            roofId: null,
            sectionLineId,
            contextObjectId: null,
            shift: e.shiftKey,
          });
          return;
        }
        const openingId = pickOpening(e.clientX, e.clientY);
        const wallId =
          openingId ? null : hit && hit.kind === "polygon" ? hit.wallId ?? null : null;
        // Stütze (Tragwerk): ihre Querschnitt-Poché liegt ÜBER der Wand-Poché —
        // ein direkter Klick auf sie trifft zuerst die Stütze (hit.columnId), sonst
        // die Fläche per Punkt-in-Polygon. Priorität direkt nach Öffnung/Wand.
        const polyColumnId =
          hit && hit.kind === "polygon" ? hit.columnId ?? null : null;
        const columnId =
          openingId || wallId
            ? null
            : polyColumnId ?? pickColumn(e.clientX, e.clientY);
        // Traf der Klick KEINE Wand/Öffnung/Stütze: zuerst eine getroffene gefüllte
        // 2D-Fläche (Polygon mit drawingId), sonst die 2D-Linien (Drawing2D) per Nähe.
        const polyDrawingId =
          hit && hit.kind === "polygon" ? hit.drawingId ?? null : null;
        const drawingId =
          openingId || wallId || columnId
            ? null
            : polyDrawingId ?? pickDrawing(e.clientX, e.clientY);
        // Extrudierter Körper (truck-Integration): sein Footprint-Umriss ersetzt
        // die frühere Drawing2D-Fläche, also gleiche Priorität wie drawingId.
        const polyExtrudedSolidId =
          hit && hit.kind === "polygon" ? hit.extrudedSolidId ?? null : null;
        const extrudedSolidId =
          openingId || wallId || columnId || drawingId
            ? null
            : polyExtrudedSolidId ?? pickExtrudedSolid(e.clientX, e.clientY);
        // Decke nur, wenn weder Öffnung/Wand noch 2D-Element getroffen wurde. Da die
        // Decken-Polygone UNTER der Wand-Poché liegen, trifft ein direkter Klick
        // auf die Wand zuerst die Wand; freie Deckenfläche trifft die Decke.
        const hitCeilingId =
          hit && hit.kind === "polygon" ? hit.ceilingId ?? null : null;
        const ceilingId =
          openingId || wallId || columnId || drawingId || extrudedSolidId ? null : hitCeilingId;
        // Treppe nur, wenn nichts anderes getroffen wurde (Tritte liegen frei).
        const stairId =
          openingId || wallId || columnId || drawingId || extrudedSolidId || ceilingId
            ? null
            : pickStair(e.clientX, e.clientY);
        // Raum als vorletzte Priorität: die Raum-Fläche liegt UNTER allem anderen.
        const roomId =
          openingId || wallId || columnId || drawingId || extrudedSolidId || ceilingId || stairId
            ? null
            : pickRoom(e.clientX, e.clientY);
        // Dach als LETZTE Priorität: die Traufe-Fläche deckt den ganzen Grundriss
        // ab, daher erst wählen, wenn wirklich nichts anderes getroffen wurde.
        const roofId =
          openingId || wallId || columnId || drawingId || extrudedSolidId || ceilingId || stairId || roomId
            ? null
            : pickRoof(e.clientX, e.clientY);
        // Kontext-Objekt (Gebäude/Terrain) als ALLERLETZTE Priorität — seine
        // Bbox-Pick-Fläche kann grosszügig überlappen, daher erst wenn wirklich
        // nichts anderes getroffen wurde.
        const contextObjectId =
          openingId || wallId || columnId || drawingId || extrudedSolidId || ceilingId || stairId || roomId || roofId
            ? null
            : pickContextObject(e.clientX, e.clientY);
        onSelect({
          model: viewToModel(v.x, v.y),
          hitIndex,
          wallId,
          drawingId,
          ceilingId,
          openingId,
          stairId,
          roomId,
          extrudedSolidId,
          columnId,
          roofId,
          sectionLineId: null,
          contextObjectId,
          shift: e.shiftKey,
        });
      }
      return;
    }

    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Imperativen GL-Pan in React-State übernehmen (Ausschnitt final festschreiben).
    commitPan();
    drag.current = null;
    setDragging(false);
  };

  /** Rechnet aus einem Ausschnitt + Rad-Delta den neuen (geklemmten) Ausschnitt. */
  const zoomedView = (prev: ViewBox, clientX: number, clientY: number, deltaY: number): ViewBox => {
    // Punkt unter dem Cursor (bleibt nach dem Zoom ortsfest).
    const anchor = clientToView(clientX, clientY, prev);
    // Hochrollen (deltaY < 0) → hinein → kleinere viewBox.
    let factor = Math.exp(deltaY * WHEEL_STEP);
    // Zoom relativ zur Default-Breite begrenzen.
    const minW = defaultView.w / ZOOM_MAX;
    const maxW = defaultView.w / ZOOM_MIN;
    const targetW = clamp(prev.w * factor, minW, maxW);
    // Tatsächlich angewandter Faktor nach Klemmung (hält Seitenverhältnis).
    factor = targetW / prev.w;
    return {
      x: anchor.x - (anchor.x - prev.x) * factor,
      y: anchor.y - (anchor.y - prev.y) * factor,
      w: prev.w * factor,
      h: prev.h * factor,
    };
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    // Zoom läuft IMMER über setView (React) — auch im GL-Pfad. Grund: der Zoom
    // ändert den Massstab, und bildschirmkonstante SVG-Elemente (Auswahlrahmen,
    // Griffe, Snap-Marker) müssen dabei NEU (in korrekter Grösse) gerendert
    // werden. Ein imperativer CSS-scale würde sie fälschlich mitskalieren. In
    // Chromium ist setView pro Rad-Schritt problemlos flüssig; der GL-Effekt auf
    // `view` zeichnet die Ebene nur per Matrix-Uniform neu (keine Re-Tessellierung).
    setView((prev) => zoomedView(prev, e.clientX, e.clientY, e.deltaY));
  };

  // Doppelklick → bei aktivem Werkzeug den mehrteiligen Entwurf abschließen,
  // sonst wieder auf die eingepasste Standard-Ansicht.
  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (toolActive) {
      toolHandlers!.onToolCommit();
      return;
    }
    // Gruppen betreten hat VORRANG vor allen anderen Doppelklick-Aktionen
    // (Vectorworks: ein gruppiertes Element öffnet zuerst die Gruppe — erst
    // ein weiterer Doppelklick INNERHALB träfe dann z. B. den Text-Editor).
    if (onEnterGroup) {
      const hit = anyGroupableHit(e.clientX, e.clientY);
      if (hit && onEnterGroup(hit)) return;
    }
    // Doppelklick auf ein Text-2D-Element → Inhalt bearbeiten (Vorrang vor Raum).
    if (onEditDrawingText) {
      const tid = pickDrawingText(e.clientX, e.clientY);
      if (tid) {
        onEditDrawingText(tid);
        return;
      }
    }
    // Doppelklick auf einen Raum (Stempel-Griff ODER Fläche) → Stempel-Editor.
    if (onStampEdit) {
      const rid =
        stampHandleAt(e.clientX, e.clientY) ?? pickRoom(e.clientX, e.clientY);
      if (rid) {
        onStampEdit(rid);
        return;
      }
    }
    // Doppelklick auf eine Schnittlinie → in deren 2D-Schnittansicht springen.
    if (onOpenSectionLevel) {
      const sid = pickSectionLine(e.clientX, e.clientY);
      if (sid) {
        onOpenSectionLevel(sid);
        return;
      }
    }
    setView(defaultView);
  };

  // Rechtsklick: Browser-Menü unterdrücken. Bei aktivem Werkzeug mit laufendem
  // Entwurf = abschließen (CAD-üblich, KEIN Kontextmenü); sonst Kontextmenü.
  const onContextMenuHandler = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    // Bei aktivem Werkzeug/Befehl ist Rechtsklick = Enter (abschließen/wiederholen,
    // §2.3) — KEIN Kontextmenü, auch ohne laufenden Entwurf.
    if (toolActive) {
      toolHandlers!.onToolCommit();
      return;
    }
    if (!onContextMenu) return;
    const v = clientToView(e.clientX, e.clientY, view);
    onContextMenu({
      clientX: e.clientX,
      clientY: e.clientY,
      model: viewToModel(v.x, v.y),
    });
  };

  // Hervorhebungs-Konturen der Auswahl. Vorrang hat die wand-bezogene Auswahl
  // (selectedWallIds, von App kontrolliert): dann werden ALLE Bänder JEDER
  // gewählten Wand umrandet. Ohne Wand-Auswahl greift die lokale Klick-
  // Hervorhebung (ein einzelnes Polygon per hitIndex), z. B. für Polygone ohne
  // Wandbezug.
  const highlightPolys = useMemo(() => {
    const ids = selectedWallIds && selectedWallIds.length ? new Set(selectedWallIds) : null;
    if (ids) {
      return plan.primitives.filter(
        (p): p is Extract<Primitive, { kind: "polygon" }> =>
          p.kind === "polygon" && p.wallId != null && ids.has(p.wallId),
      );
    }
    if (selected !== null) {
      const p = plan.primitives[selected];
      if (p && p.kind === "polygon") return [p];
    }
    return [];
  }, [plan, selectedWallIds, selected]);

  // Hervorhebung der selektierten 2D-Zeichenelemente (Mehrfach/Marquee): alle
  // Linien-/Polygon-Primitive, deren drawingId in der Auswahl liegt, werden mit
  // Akzentkontur überzeichnet (sichtbares Feedback auch ohne Griffe).
  const highlightDrawPrims = useMemo(() => {
    const ids =
      selectedDrawingIds && selectedDrawingIds.length
        ? new Set(selectedDrawingIds)
        : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "line" | "polygon" }> =>
        (p.kind === "line" || p.kind === "polygon") &&
        p.drawingId != null &&
        ids.has(p.drawingId),
    );
  }, [plan, selectedDrawingIds]);

  // Hervorhebung ausgewählter TEXT-Objekte (Auswahl-Rahmen, Nutzer-Wunsch):
  // `drawingText` hat keine `pts`/`a`/`b` wie Linie/Polygon, daher eigener
  // Zweig statt `highlightDrawPrims` — der Rahmen wird geschätzt, s.
  // `text/textFrame.ts` `textFrameCorners`. Während des Inline-Editors (`editTextId`) NICHT
  // zusätzlich zeichnen — der Editor-Rahmen selbst übernimmt dort die Anzeige.
  const highlightTextFrames = useMemo(() => {
    const ids =
      selectedDrawingIds && selectedDrawingIds.length ? new Set(selectedDrawingIds) : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "drawingText" }> =>
        p.kind === "drawingText" &&
        p.drawingId != null &&
        ids.has(p.drawingId) &&
        p.drawingId !== editTextId,
    );
  }, [plan, selectedDrawingIds, editTextId]);

  // Hervorhebung der selektierten Decken: alle Polygone JEDER gewählten Decke
  // (Fläche + Umriss) mit Akzentkontur überzeichnen — analog zur Wand-Auswahl.
  const highlightCeilingPolys = useMemo(() => {
    const ids =
      selectedCeilingIds && selectedCeilingIds.length
        ? new Set(selectedCeilingIds)
        : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "polygon" }> =>
        p.kind === "polygon" && p.ceilingId != null && ids.has(p.ceilingId),
    );
  }, [plan, selectedCeilingIds]);

  // Hervorhebung der selektierten Öffnungen: alle Symbol-Primitive (Linien/Bögen/
  // Rahmen) mit der gewählten openingId mit Akzentkontur überzeichnen.
  const highlightOpeningPrims = useMemo(() => {
    const ids =
      selectedOpeningIds && selectedOpeningIds.length
        ? new Set(selectedOpeningIds)
        : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "line" | "arc" | "polygon" }> =>
        (p.kind === "line" || p.kind === "arc" || p.kind === "polygon") &&
        p.openingId != null &&
        ids.has(p.openingId),
    );
  }, [plan, selectedOpeningIds]);

  // Hervorhebung der selektierten Treppen: alle Tritt-/Symbol-Primitive (Polygone
  // + Linien) mit der gewählten stairId mit Akzentkontur überzeichnen.
  const highlightStairPrims = useMemo(() => {
    const ids =
      selectedStairIds && selectedStairIds.length ? new Set(selectedStairIds) : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "line" | "polygon" }> =>
        (p.kind === "line" || p.kind === "polygon") &&
        p.stairId != null &&
        ids.has(p.stairId),
    );
  }, [plan, selectedStairIds]);

  // Hervorhebung der selektierten Räume: die Fläche JEDES gewählten Raums (Polygon
  // mit roomId) mit Akzentkontur überzeichnen — analog zur Decken-Auswahl.
  const highlightRoomPolys = useMemo(() => {
    const ids =
      selectedRoomIds && selectedRoomIds.length ? new Set(selectedRoomIds) : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "polygon" }> =>
        p.kind === "polygon" && p.roomId != null && ids.has(p.roomId),
    );
  }, [plan, selectedRoomIds]);

  // Hervorhebung der selektierten Dächer: das (unsichtbare) Traufe-Pick-Polygon
  // mit roofId als Akzentkontur überzeichnen — analog zur Raum-/Decken-Auswahl.
  const highlightRoofPolys = useMemo(() => {
    const ids =
      selectedRoofIds && selectedRoofIds.length ? new Set(selectedRoofIds) : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "polygon" }> =>
        p.kind === "polygon" && p.roofId != null && ids.has(p.roofId),
    );
  }, [plan, selectedRoofIds]);

  // Hervorhebung der selektierten Kontext-Objekte (Gebäude/Terrain): das
  // (unsichtbare) Bbox-Pick-Band mit contextObjectId als Akzentkontur
  // überzeichnen — analog zur Dach-/Raum-Auswahl.
  const highlightContextObjectPolys = useMemo(() => {
    const ids =
      selectedContextObjectIds && selectedContextObjectIds.length
        ? new Set(selectedContextObjectIds)
        : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "polygon" }> =>
        p.kind === "polygon" && p.contextObjectId != null && ids.has(p.contextObjectId),
    );
  }, [plan, selectedContextObjectIds]);

  // Hervorhebung der selektierten Schnitt-/Ansichtslinie: das (unsichtbare)
  // Pick-Band (Polygon mit sectionLineId) mit Akzentkontur überzeichnen.
  const highlightSectionLinePolys = useMemo(() => {
    const ids =
      selectedSectionLineIds && selectedSectionLineIds.length
        ? new Set(selectedSectionLineIds)
        : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "polygon" }> =>
        p.kind === "polygon" && p.sectionLineId != null && ids.has(p.sectionLineId),
    );
  }, [plan, selectedSectionLineIds]);

  // Hervorhebung der selektierten extrudierten Körper (truck-Integration): der
  // Footprint-Umriss (Polygon mit extrudedSolidId) mit Akzentkontur überzeichnen
  // — analog zur Raum-Auswahl.
  const highlightExtrudedSolidPolys = useMemo(() => {
    const ids =
      selectedExtrudedSolidIds && selectedExtrudedSolidIds.length
        ? new Set(selectedExtrudedSolidIds)
        : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "polygon" }> =>
        p.kind === "polygon" && p.extrudedSolidId != null && ids.has(p.extrudedSolidId),
    );
  }, [plan, selectedExtrudedSolidIds]);

  // Hervorhebung der selektierten Stützen (Tragwerk): der Querschnitt-Umriss
  // (Polygon mit columnId) mit Akzentkontur überzeichnen — analog Extrusion/Raum.
  const highlightColumnPolys = useMemo(() => {
    const ids =
      selectedColumnIds && selectedColumnIds.length ? new Set(selectedColumnIds) : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "polygon" }> =>
        p.kind === "polygon" && p.columnId != null && ids.has(p.columnId),
    );
  }, [plan, selectedColumnIds]);

  // Ist eine GRUPPE gewählt (statt einzelner Elemente), zeigt die Auswahl NUR
  // eine einfache Bounding-Box mit vier Eckpunkten statt jedes einzelnen
  // Mitglieds-Umrisses (Nutzer-Wunsch, Vectorworks-Vorbild: „einfach vier
  // Aussenpunkte zeigen") — vereint dieselben Hervorhebungs-Listen, die sonst
  // einzeln gezeichnet würden.
  const groupBBox = useMemo(() => {
    if (!selectedGroupIds || selectedGroupIds.length === 0) return null;
    const pts: Vec2[] = [];
    for (const poly of highlightPolys) pts.push(...poly.pts);
    for (const poly of highlightCeilingPolys) pts.push(...poly.pts);
    for (const poly of highlightRoomPolys) pts.push(...poly.pts);
    for (const poly of highlightRoofPolys) pts.push(...poly.pts);
    for (const poly of highlightColumnPolys) pts.push(...poly.pts);
    const fromLineOrPoly = (p: { kind: string; a?: Vec2; b?: Vec2; from?: Vec2; to?: Vec2; center?: Vec2; pts?: Vec2[] }) => {
      if (p.kind === "line" && p.a && p.b) pts.push(p.a, p.b);
      else if (p.kind === "arc" && p.from && p.to) pts.push(p.from, p.to);
      else if (p.pts) pts.push(...p.pts);
    };
    for (const p of highlightDrawPrims) fromLineOrPoly(p);
    for (const p of highlightOpeningPrims) fromLineOrPoly(p);
    for (const p of highlightStairPrims) fromLineOrPoly(p);
    if (pts.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }, [
    selectedGroupIds,
    highlightPolys,
    highlightCeilingPolys,
    highlightRoomPolys,
    highlightRoofPolys,
    highlightColumnPolys,
    highlightDrawPrims,
    highlightOpeningPrims,
    highlightStairPrims,
  ]);

  // Zusammenhängende 2D-Zeichen-Linien (gleiche drawingId + Stil) zu Zügen
  // bündeln, damit sie als EIN <polyline>/<polygon> gezeichnet werden können —
  // so gehren dicke Ecken sauber (kein Butt-Cap-Sprung). generatePlan schiebt die
  // Kanten eines Elements aufeinanderfolgend + End-an-Start verkettet ein, daher
  // genügt greedy-Anhängen benachbarter Segmente.
  const drawingRuns = useMemo(() => buildDrawingRuns(plan.primitives), [plan]);

  // Pro Polygon mit Linien-/Kreuz-Schraffur ein eigenes <pattern> sammeln.
  // Vollfüllung ("solid") und "none" brauchen kein Muster. Gedimmte Polygone
  // (greyed) bekommen HIER separat dieselbe Grau-Umfärbung wie `greyedCopy` in
  // primitives.tsx — die <pattern>-Definition ist eine eigene, vom Primitiv
  // losgelöste Ressource (nur über `url(#hatch-i)` referenziert) und würde
  // sonst weiterhin in der ORIGINAL-Bauteilfarbe erscheinen.
  const hatched = useMemo(() => {
    const list: HatchedPoly[] = [];
    plan.primitives.forEach((p, i) => {
      if (p.kind === "polygon" && polyUsesPattern(p.hatch)) {
        // Verlauf-Schraffuren tragen ihre eigentliche Farbe in `gradient.color1/
        // color2` (nicht in `hatch.color`, das dort ungenutzt ist) — beide
        // Stops müssen separat eingegraut werden, sonst bliebe ein gedimmtes
        // Bauteil mit einer Verlauf-Schraffur trotzdem knallfarbig.
        const hatch = p.greyed
          ? {
              ...p.hatch,
              color: greyColor(p.hatch.color) ?? p.hatch.color,
              gradient: p.hatch.gradient && {
                ...p.hatch.gradient,
                color1: greyColor(p.hatch.gradient.color1) ?? p.hatch.gradient.color1,
                color2: greyColor(p.hatch.gradient.color2) ?? p.hatch.gradient.color2,
              },
            }
          : p.hatch;
        list.push({ patternId: `hatch-${i}`, hatch });
      }
    });
    return list;
  }, [plan]);

  // `cullState` (s. o.) reduziert bei sehr vielen Primitiven die Menge VOR
  // dem eigentlichen JSX-Mapping — gleiche Eigenschaft wie zuvor (hängt NICHT
  // direkt an `view`, nur am per Hysterese gepufferten `cullState`), behält
  // aber den URSPRÜNGLICHEN Index `i` (Auswahl/Hit-Testing + Hatch-Pattern-IDs
  // indizieren in `plan.primitives[i]`, s. `cullPrimitives.ts`). Ohne aktives
  // Culling (`cullState === null`, der Normalfall) identisch zu vorher.
  const culledIndexed = useMemo(() => {
    if (!cullState) return plan.primitives.map((p, i) => ({ p, i }));
    return primitivesInRegion(plan.primitives, cullState.region, cullState.minTextHeightVb);
  }, [plan, cullState]);

  // Perf: die Primitiv-Elemente hängen NUR an `culledIndexed` (+ Haarlinie/
  // Massstab), NICHT an `view` direkt. Ohne Memo würde jedes Schwenken/Zoomen
  // (das nur die viewBox ändert) den gesamten Element-Baum neu erzeugen und
  // React ihn komplett abgleichen — auf WebKitGTK (Tauri-Desktop) der spürbare
  // Ruckler. Memoisiert bleibt der Baum referenzstabil, Pan/Zoom aktualisiert
  // nur noch das viewBox-Attribut (ausser `cullState` wechselt, s. o.).
  const primitiveEls = useMemo(
    () =>
      culledIndexed.map(({ p, i }) =>
        // Bei aktivem GL zeichnet die WebGL-Ebene Poché/Linien/Bögen; das SVG wird
        // zur reinen Text-Overlay-Ebene (scharfe Schrift, DOM-Hit-Test) → hier nur
        // noch Text-Primitive. Bei aktiver WASM-Engine rastert render2d den
        // Raum-Stempel selbst (glyphon) — das SVG darf ihn NICHT zusätzlich
        // zeichnen (sonst doppelter Text), also entfällt dort auch das Textoverlay.
        // Sonst (reines SVG): alles außer den gebündelten 2D-Zeichenlinien.
        // `drawingText` (importierter Einzeltext) rendert IMMER im SVG — der GL-
        // wie der WASM-Renderer zeichnet ihn nicht. Der Raum-Stempel (`text`)
        // bleibt: unter WASM rastert ihn render2d selbst (sonst doppelt).
        // ZUSÄTZLICH: das gerade im Inline-Editor offene Text-Element NIE
        // statisch mitzeichnen — Bug-Meldung ("sonst alles io" nach den
        // Positions-Fixes, aber sichtbare Text-Dopplung): das SVG bricht
        // Zeilen nach einer GESCHÄTZTEN Zeichenbreite um
        // (`CHAR_WIDTH_FACTOR`), der Browser im Editor nach ECHTER
        // Font-Metrik — beide Umbrüche weichen leicht voneinander ab, sodass
        // der (weisse, aber nicht überall deckende) Editor-Rahmen Reste des
        // statischen Texts sichtbar unbedeckt liess.
        (p.kind === "drawingText" && p.drawingId === editTextId) ||
        (useGpuRenderer
          ? wantWasm
            ? p.kind !== "drawingText"
            : p.kind !== "text" && p.kind !== "drawingText"
          : p.kind === "line" && p.drawingId)
          ? null : (
          <PrimitiveShape
            key={i}
            p={p}
            index={i}
            toScreen={toScreen}
            hairline={!!hairline}
            paperScale={paperScale}
          />
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toScreen ist modulweit konstant
    [culledIndexed, hairline, paperScale, useGpuRenderer, wantWasm, editTextId],
  );
  const drawingRunEls = useMemo(
    () =>
      // Bei aktivem GL übernimmt die WebGL-Ebene die 2D-Zeichenlinien.
      useGpuRenderer
        ? []
        : drawingRuns.map((run, i) => (
            <DrawingRunShape
              key={`run-${i}`}
              run={run}
              toScreen={toScreen}
              hairline={!!hairline}
              paperScale={paperScale}
            />
          )),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toScreen ist modulweit konstant
    [drawingRuns, hairline, paperScale, useGpuRenderer],
  );

  return (
    // Flex-Passthrough (wie das frühere .plan-svg direkt): flex:1 + min-height:0,
    // damit die Fläche in WebKitGTK/Tauri NICHT auf Null-Höhe kollabiert (was
    // height:100% dort täte). display:flex, damit das innere SVG (flex:1) füllt.
    <div
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        width: "100%",
        display: "flex",
      }}
    >
      {/* WebGL2-GPU-Ebene: liegt HINTER dem SVG (z-index 0). Zeichnet die schwere
          Geometrie (Poché/Linien/Bögen); pointer-events aus, damit Klicks das SVG
          darüber erreichen. An `wantGpu` (Absicht) montiert — NICHT an `useGpuRenderer`
          (=wantGpu&&glReady), sonst könnte GL nie initialisieren (Canvas fehlt →
          glReady bleibt false → Deadlock). Bei WebGL-Fehler bleibt es leer hinten
          und der volle SVG-Pfad übernimmt sichtbar. NICHT montiert, wenn ein
          Luftbild aktiv ist — dann rendert der SVG-Pfad alles inkl. Bild-Ebene. */}
      {wantGpu && !hasBgImages && (
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      )}
      {/* SVG-Ebene: bei GL transparent DARÜBER (Text/Griffe/Snap/Vorschau, scharf +
          DOM-Hit-Test); ohne GL der vollständige Renderer (Fallback). */}
      <svg
        ref={svgRef}
        className="plan-svg"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => { setRulerCursor(null); onCursor?.(null); clearHoverDivide(); }}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenuHandler}
        // Maus-Schema: MITTE schwenkt (grabbing), sonst Standard-Cursor (LINKS
        // wählt aus). touchAction:none, damit das Schwenken nicht scrollt.
        style={{
          position: useGpuRenderer ? "absolute" : undefined,
          inset: useGpuRenderer ? 0 : undefined,
          zIndex: useGpuRenderer ? 1 : undefined,
          width: useGpuRenderer ? "100%" : undefined,
          height: useGpuRenderer ? "100%" : undefined,
          // Bei GL transparent, damit die WebGL-Ebene dahinter durchscheint.
          background: useGpuRenderer ? "transparent" : undefined,
          cursor: dragging
            ? "grabbing"
            : toolActive || marqueeRect
              ? "crosshair"
              : "default",
          touchAction: "none",
        }}
      >
      <defs>
        {hatched.map((h) => (
          <HatchPattern
            key={h.patternId}
            id={h.patternId}
            hatch={h.hatch}
            hairline={!!hairline}
            paperScale={paperScale}
          />
        ))}
      </defs>
      {/* Zeichenblatt-Hintergrund: deckt den aktuellen Ausschnitt (viewBox)
          vollständig — unabhängig von den Modell-Bounds (fixer Ursprung). Bei
          aktivem GL löscht die WebGL-Ebene das Blatt → hier transparent halten
          (bleibt aber Klick-/Pan-Trefferfläche für Leerraum). */}
      <rect
        x={view.x}
        y={view.y}
        width={view.w}
        height={view.h}
        className={useGpuRenderer ? undefined : "plan-bg"}
        fill={useGpuRenderer ? "transparent" : undefined}
      />
      {/* Sichtbares Hintergrund-Raster (rein visuell, unabhängig vom Fang) —
          MUSS hinter Luftbildern/Geometrie liegen, sonst überdeckt es die
          Zeichnung. */}
      {showGrid && (
        <PlanGrid
          vb={{ x0: view.x, y0: view.y, w: view.w, h: view.h }}
          pxPerMeter={currentPxPerMeter()}
        />
      )}
      {/* Georeferenzierte Luftbilder ZWISCHEN Blatt-Hintergrund und Geometrie:
          Modell-Meter × PX_PER_M mit negierter y-Achse (s. toScreen) → Bild-Norden
          (max.y) oben bei y=−max.y·PX; das Bild zeichnet natürlich von oben (kein
          Flip). Nur im SVG-Pfad relevant (bei Luftbild ist GPU deaktiviert). */}
      {hasBgImages && plan.backgroundImages!.map((img) => {
        const w = (img.max.x - img.min.x) * PX_PER_M;
        const h = (img.max.y - img.min.y) * PX_PER_M;
        if (w <= 0 || h <= 0) return null;
        const filter = cssImageFilter(img.filters);
        return (
          <image
            key={img.id}
            href={img.src}
            x={img.min.x * PX_PER_M}
            y={-img.max.y * PX_PER_M}
            width={w}
            height={h}
            opacity={img.opacity}
            style={filter ? { filter } : undefined}
            preserveAspectRatio="none"
            pointerEvents="none"
          />
        );
      })}
      {/* 2D-Zeichen-Linien mit drawingId werden gemergt (drawingRuns) als EIN Zug
          gezeichnet → gehrte Ecken statt Butt-Cap-Stufe; im Memo übersprungen. */}
      {primitiveEls}
      {/* Zusammenhängende 2D-Zeichen-Linienzüge als EIN <polyline>/<polygon>:
          CAD-typische Gehrung an den Ecken (stroke-linejoin), keine Stufe bei
          dicken Linien. Nach der Haupt-Ebene gezeichnet (2D liegt ohnehin oben). */}
      {drawingRunEls}
      {/* Ist eine GRUPPE gewählt, ersetzt die Bounding-Box unten die einzelnen
          Mitglieds-Hervorhebungen (s. `groupBBox`) — dieser ganze Block bleibt
          dann aus. */}
      {!groupBBox && (
      <>
      {/* Auswahl-Hervorhebung: alle Bänder der gewählten Wand (bzw. das lokal
          getroffene Polygon) mit Akzentkontur überzeichnen. */}
      {highlightPolys.map((poly, i) => (
        <polygon
          key={`sel-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Decken (Akzentkontur). */}
      {highlightCeilingPolys.map((poly, i) => (
        <polygon
          key={`selc-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Räume (Akzentkontur der Fläche). */}
      {highlightRoomPolys.map((poly, i) => (
        <polygon
          key={`selrm-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Dächer (Traufe-Umriss). */}
      {highlightRoofPolys.map((poly, i) => (
        <polygon
          key={`selrf-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Kontext-Objekte (Bbox-Pick-Band). */}
      {highlightContextObjectPolys.map((poly, i) => (
        <polygon
          key={`selctx-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Schnitt-/Ansichtslinie (Pick-Band). */}
      {highlightSectionLinePolys.map((poly, i) => (
        <polygon
          key={`selsl-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten extrudierten Körper (truck-Integration). */}
      {highlightExtrudedSolidPolys.map((poly, i) => (
        <polygon
          key={`selex-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Stützen (Tragwerk). */}
      {highlightColumnPolys.map((poly, i) => (
        <polygon
          key={`selcol-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Hervorhebung der selektierten Öffnungen (Fenster/Tür-Symbole). */}
      {highlightOpeningPrims.map((p, i) =>
        p.kind === "line" ? (
          <line
            key={`selo-${i}`}
            className="plan-sel-draw"
            x1={toScreen(p.a).x}
            y1={toScreen(p.a).y}
            x2={toScreen(p.b).x}
            y2={toScreen(p.b).y}
            pointerEvents="none"
          />
        ) : p.kind === "arc" ? (
          <line
            key={`selo-${i}`}
            className="plan-sel-draw"
            x1={toScreen(p.from).x}
            y1={toScreen(p.from).y}
            x2={toScreen(p.to).x}
            y2={toScreen(p.to).y}
            pointerEvents="none"
          />
        ) : (
          <polygon
            key={`selo-${i}`}
            className="plan-sel-draw"
            points={p.pts
              .map(toScreen)
              .map((s) => `${s.x},${s.y}`)
              .join(" ")}
            pointerEvents="none"
          />
        ),
      )}
      {/* Hervorhebung der selektierten Treppen (Tritte + Symbollinien). */}
      {highlightStairPrims.map((p, i) =>
        p.kind === "line" ? (
          <line
            key={`selst-${i}`}
            className="plan-sel-draw"
            x1={toScreen(p.a).x}
            y1={toScreen(p.a).y}
            x2={toScreen(p.b).x}
            y2={toScreen(p.b).y}
            pointerEvents="none"
          />
        ) : (
          <polygon
            key={`selst-${i}`}
            className="plan-selected"
            points={p.pts
              .map(toScreen)
              .map((s) => `${s.x},${s.y}`)
              .join(" ")}
            pointerEvents="none"
          />
        ),
      )}
      {/* Hervorhebung der selektierten 2D-Zeichenelemente (Akzentkontur). */}
      {highlightDrawPrims.map((p, i) =>
        p.kind === "line" ? (
          <line
            key={`seld-${i}`}
            className="plan-sel-draw"
            x1={toScreen(p.a).x}
            y1={toScreen(p.a).y}
            x2={toScreen(p.b).x}
            y2={toScreen(p.b).y}
            pointerEvents="none"
          />
        ) : (
          <polygon
            key={`seld-${i}`}
            className="plan-sel-draw"
            points={p.pts
              .map(toScreen)
              .map((s) => `${s.x},${s.y}`)
              .join(" ")}
            pointerEvents="none"
          />
        ),
      )}
      {/* Auswahl-Rahmen für Text-Objekte (geschätzte Box, kein echter Umriss
          wie bei Linie/Polygon — s. `text/textFrame.ts` `textFrameCorners`). Gestrichelt
          statt durchgezogen wie `.plan-sel-draw`, um sichtbar zu machen: das
          ist eine SCHÄTZUNG, keine exakt nachgezeichnete Geometrie. */}
      {highlightTextFrames.map((p) => (
        <polygon
          key={`selt-${p.drawingId}`}
          className="plan-sel-text-frame"
          points={textFrameCorners(p)
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      </>
      )}
      {/* Gruppen-Auswahl: nur eine Bounding-Box mit vier Eckpunkten (kein
          Umriss jedes einzelnen Mitglieds) — s. `groupBBox`. */}
      {groupBBox && (() => {
        const c1 = toScreen({ x: groupBBox.minX, y: groupBBox.minY });
        const c2 = toScreen({ x: groupBBox.maxX, y: groupBBox.minY });
        const c3 = toScreen({ x: groupBBox.maxX, y: groupBBox.maxY });
        const c4 = toScreen({ x: groupBBox.minX, y: groupBBox.maxY });
        const size = 4 / (meetScale(view, svgRef.current) ?? 1);
        const corners = [c1, c2, c3, c4];
        return (
          <>
            <polygon
              className="plan-group-bbox"
              points={corners.map((s) => `${s.x},${s.y}`).join(" ")}
              pointerEvents="none"
            />
            {corners.map((s, i) => (
              <circle
                key={`gbb-${i}`}
                className="plan-grip plan-group-bbox-corner"
                cx={s.x}
                cy={s.y}
                r={size}
                pointerEvents="none"
              />
            ))}
          </>
        );
      })()}
      {/* Auswahl-Rechteck (Marquee). Gestrichelt; die crossing-Variante (rechts→
          links, berührend) hebt sich farblich/strichlich ab. Das Rechteck steht
          bereits in viewBox-Einheiten → direkt setzbar. */}
      {marqueeRect && (
        <rect
          className={
            marqueeRect.crossing
              ? "plan-marquee plan-marquee-crossing"
              : "plan-marquee"
          }
          x={marqueeRect.x}
          y={marqueeRect.y}
          width={marqueeRect.w}
          height={marqueeRect.h}
          style={{ stroke: marqueeColor, fill: marqueeColor }}
          pointerEvents="none"
        />
      )}
      {/* Bezier-Hilfslinien (Anker → Griff), gestrichelt — VOR den Griff-
          Quadraten gezeichnet, damit die Griffe oben liegen (anklickbar). */}
      {gripsActive &&
        gripHandleLines &&
        gripHandleLines.map((l, i) => (
          <line
            key={`gripline-${i}`}
            className="plan-grip-line"
            x1={toScreen(l.a).x}
            y1={toScreen(l.a).y}
            x2={toScreen(l.b).x}
            y2={toScreen(l.b).y}
            pointerEvents="none"
          />
        ))}
      {/* Editier-Griffe des selektierten Elements (Wand-Enden / 2D-Vertices):
          ziehbare Kreise. Bildschirmkonstante Größe über die meet-Skala.
          Radius bewusst kleiner als der Treffer-Radius (GRIP_HIT_PX) — die
          Klickfläche bleibt grosszügig, nur die sichtbare Form schrumpft. */}
      {gripsActive &&
        grips!.map((g, i) => {
          const s = toScreen(g);
          const size = 4.5 / (meetScale(view, svgRef.current) ?? 1);
          return (
            <circle
              key={`grip-${i}`}
              className="plan-grip"
              cx={s.x}
              cy={s.y}
              r={size}
              pointerEvents="none"
            />
          );
        })}
      {/* Raum-Stempel-Griff: eine ziehbare Raute am Anker des gewählten Raums.
          Verschiebt NUR den Stempel (nicht die Kontur); Doppelklick öffnet den
          Editor. Bildschirmkonstante Größe. */}
      {roomStamp &&
        (() => {
          const s = toScreen(roomStamp.anchor);
          const size = 4 / (meetScale(view, svgRef.current) ?? 1);
          const pts = [
            `${s.x},${s.y - size}`,
            `${s.x + size},${s.y}`,
            `${s.x},${s.y + size}`,
            `${s.x - size},${s.y}`,
          ].join(" ");
          return (
            <polygon
              className="plan-grip plan-stamp-grip"
              points={pts}
              pointerEvents="none"
            />
          );
        })()}
      {/* Kanten-/Seiten-Griffe: je Seite ein dreieckiger Anfasser, leicht nach
          AUSSEN entlang der (bildschirm-transformierten) Normale versetzt, mit
          der Spitze nach außen. Y wird gespiegelt (toScreen spiegelt Y), damit
          das Dreieck wirklich nach außen zeigt. Größe bildschirmkonstant. */}
      {edgeGripsActive &&
        edgeGrips!.map((eg, i) => {
          const s = meetScale(view, svgRef.current) ?? 1;
          const m = toScreen(eg.mid);
          // Normale in den Bildschirmraum (Y spiegeln); auf Bildschirm-px-Größen.
          const sn = screenNormal(eg.normal);
          const hVb = EDGE_GRIP_H_PX / s; // Dreieckshöhe (nach außen)
          const halfVb = EDGE_GRIP_HALF_PX / s; // halbe Basisbreite
          // Tangente = 90°-Drehung der (Bildschirm-)Normale, für die Basisbreite.
          const tx = -sn.y;
          const ty = sn.x;
          // Basis SITZT AUF DER LINIE (Mittelpunkt m), Spitze zeigt nach außen.
          const tipX = m.x + sn.x * hVb;
          const tipY = m.y + sn.y * hVb;
          const b1x = m.x + tx * halfVb;
          const b1y = m.y + ty * halfVb;
          const b2x = m.x - tx * halfVb;
          const b2y = m.y - ty * halfVb;
          return (
            <polygon
              key={`edge-grip-${i}`}
              className="plan-edge-grip"
              points={`${tipX},${tipY} ${b1x},${b1y} ${b2x},${b2y}`}
              pointerEvents="none"
            />
          );
        })}
      {/* Werkzeug-Overlay: Live-Vorschau (Rubber-Band) + gesetzte Stützpunkte +
          Snap-Marker + HUD. Immer obenauf, pointerEvents none. Glyph-/Schrift-
          Größen werden über die aktuelle meet-Skala bildschirmkonstant gehalten. */}
      {toolHandlers?.draft && (
        <DraftOverlay
          draft={toolHandlers.draft}
          toScreen={toScreen}
          vbPerPx={1 / (meetScale(view, svgRef.current) ?? 1)}
          snapColor={snapColor}
          hudFields={hudFields ?? null}
        />
      )}
      {/* Hover-Teilpunkte (s. hoverDivideSeg oben): kleine Punkte in Akzentfarbe
          an den `hoverDivideCount`-gleichen Teilpunkten des gehoverten Segments
          (2 = nur Mitte). Nur im Ruhezustand (kein Werkzeug aktiv). */}
      {hoverDivideSeg && !toolActive && (() => {
        const vbPerPx = 1 / (meetScale(view, svgRef.current) ?? 1);
        const r = 3.5 * vbPerPx;
        const n = Math.max(2, Math.round(hoverDivideCount));
        const { a, b } = hoverDivideSeg;
        const pts = Array.from({ length: n - 1 }, (_, i) => {
          const t = (i + 1) / n;
          return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        });
        return (
          <g className="plan-hover-divide" pointerEvents="none">
            {pts.map((pt, i) => {
              const s = toScreen(pt);
              return (
                <circle
                  key={i}
                  cx={s.x}
                  cy={s.y}
                  r={r}
                  style={{ fill: snapColor, stroke: snapColor }}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </g>
        );
      })()}
      </svg>
      {/* Inline-Text-Editor DIREKT auf der Zeichenfläche (kein Dialog, Nutzer-
          Feedback) — für ein frisch über `text`/`textbox` erzeugtes Element
          (sofort nach dem Platzieren, s. App.tsx host.focusDrawing) ODER ein
          per Doppelklick geöffnetes bestehendes. `RichTextEditor` bringt seine
          eigene Mini-Toolbar mit; die schwebt PER CSS (s. styles.css
          `.planview-inline-text .rt-toolbar`, `position:absolute;
          bottom:100%`) OBERHALB der Textfläche, ausserhalb von deren
          Layout-Fluss — sie darf die Fläche NICHT nach unten schieben
          (Bug-Meldung "Editor ist tiefer als der Text": vorher stand die
          Toolbar noch im normalen Fluss ÜBER der Fläche und schob sie um
          ihre eigene, zoomunabhängige Höhe nach unten, während hier nur mit
          EINER Zeilenhöhe Versatz gerechnet wird — bei üblichem Zoom kleiner
          als die Toolbar-Höhe). `at` ist die Baseline-links der ersten Zeile
          (s. primitives.tsx "drawingText") — der Editor-Rahmen (= die
          Textfläche, jetzt ohne die Toolbar davor) sitzt daher ~eine
          Zeilenhöhe darüber. OHNE `wrapWidth` (Text-Werkzeug) bleibt die
          Breite frei (kein Wortumbruch, nur Enter erzeugt neue Zeilen); MIT
          `wrapWidth` (Textspalte) bricht der Editor live um wie ein
          InDesign-Textrahmen — `position:"fixed"` mit echten Client-Pixeln
          (vbToClient), damit die Positionierung unabhängig vom umgebenden
          Layout stimmt. */}
      {editTextId &&
        (() => {
          const prim = plan.primitives.find(
            (p): p is Extract<Primitive, { kind: "drawingText" }> =>
              p.kind === "drawingText" && p.drawingId === editTextId,
          );
          if (!prim) return null;
          const doc = prim.doc ?? docFromText(prim.text, prim.marks ?? {});
          // WYSIWYG: Position, Breite, Feldhöhe UND Schriftgrösse folgen alle dem
          // echten Zoom (currentPxPerMeter) — die Box soll exakt so aussehen wie
          // der spätere gerenderte Text, in genau der Grösse des gezeichneten
          // Feldes (Nutzer-Wunsch). Die Schriftgrösse geht NICHT über
          // transform:scale() auf die ganze Box (das skalierte vorher die
          // Toolbar mit hoch und sprengte sie beim Reinzoomen), sondern NUR auf
          // die Textfläche via CSS-Variable (--rt-font-size/--rt-min-height,
          // s. styles.css `.planview-inline-text .rt-surface`) — die Toolbar
          // bleibt dadurch immer normal gross und bedienbar.
          const pxPerM = currentPxPerMeter();
          // Baseline → Box-Oberkante: ECHTES Font-Measuring statt der groben
          // "ganzes heightM = Ascent"-Näherung (Bug-Meldung "Sprung nach
          // rechts oben" — Rest-Y-Versatz nach dem Toolbar-Fluss-/Schrift-Fix).
          const baselineFromTop = contentFontBaselineFromTop(TEXT_LINE_HEIGHT_MULT);
          const topAnchor = toScreen({ x: prim.at.x, y: prim.at.y + prim.heightM * baselineFromTop });
          const screen = vbToClient(topAnchor.x, topAnchor.y);
          const hasWrap = !!prim.wrapWidth;
          const widthPx = hasWrap ? prim.wrapWidth! * pxPerM : undefined;
          const minWidthPx = hasWrap ? undefined : 160;
          const fontSizePx = Math.max(9, prim.heightM * pxPerM);
          // Aufgezogener Textspalten-Rahmen (textbox.ts): dessen Höhe als
          // Mindesthöhe der Textfläche — wächst bei mehr Text darüber hinaus.
          const minHeightPx = editTextMinHeightM ? editTextMinHeightM * pxPerM : undefined;
          const cssVars = {
            "--rt-font-size": `${fontSizePx}px`,
            ...(minHeightPx ? { "--rt-min-height": `${minHeightPx}px` } : {}),
          } as CSSProperties;
          return (
            <>
              <div
                className="planview-inline-backdrop"
                onPointerDown={() => onCloseTextEdit?.()}
              />
              <div
                className={"planview-inline-text" + (hasWrap ? "" : " planview-inline-text-free")}
                style={{
                  left: screen.x,
                  top: screen.y,
                  width: widthPx,
                  minWidth: minWidthPx,
                  ...cssVars,
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    onCloseTextEdit?.();
                  }
                }}
              >
                <RichTextEditor
                  value={doc}
                  onChange={(d) => onCommitTextEdit?.(d)}
                  autoFocus
                  sizeUnit="em"
                />
              </div>
            </>
          );
        })()}
      {/* Lineale (oben + links, VW-Stil): Modell-Meter mit Ticks, Beschriftung
          und Cursor-Marker — screen-fix über den sichtbaren Ausschnitt gelegt.
          BEWUSST ein eigenes Sibling-SVG (nicht mehr Kind von `svgRef`): beim
          imperativen GL-Pan (`applySvgTransform`, s.o.) bekommt NUR `svgRef`
          während der Geste einen CSS-transform verpasst — läge das Lineal
          darin, würde es sichtbar mit dem Inhalt mitwandern statt am Rand
          fixiert zu bleiben. Als eigenständiges Element bleibt es während der
          Geste stehen (aktualisiert erst beim Loslassen, wenn `view` neu
          gesetzt wird) — exakt das gewünschte „statische" Verhalten. */}
      {showRulers && (() => {
        const m = measure(view);
        if (!m.rect) return null;
        const scale = m.scale || 1;
        const vb = {
          x0: view.x - m.offX / scale,
          y0: view.y - m.offY / scale,
          w: (m.rect.width || 1) / scale,
          h: (m.rect.height || 1) / scale,
        };
        return (
          <svg
            className="plan-ruler-overlay"
            viewBox={`${vb.x0} ${vb.y0} ${vb.w} ${vb.h}`}
            preserveAspectRatio="none"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              zIndex: 2,
              pointerEvents: "none",
            }}
          >
            <PlanRulers
              vb={vb}
              vbPerPx={1 / scale}
              pxPerMeter={scale * PX_PER_M}
              cursor={rulerCursor}
            />
          </svg>
        );
      })()}
    </div>
  );
});
