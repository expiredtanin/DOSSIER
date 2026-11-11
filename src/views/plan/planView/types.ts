// Typen der Plan-Ansicht (`PlanView.tsx`): Auswahl-Ergebnisse, Eigenschaften, Steuerhandle und
// Griff-Treiber. [165] aus `PlanView.tsx` herausgelöst; `PlanView.tsx` führt die öffentlichen Typen
// unverändert wieder aus, die übrigen Dateien in `planView/` importieren sie von hier.

import type { ReactNode } from "react";
import type { HatchRender, Plan, PickKind } from "../../../core";
import type { EdgeGrip, Vec2 } from "../../../model/types";
import type { ToolHandlers, ToolId, ToolMods } from "../../../tools/types";
import type { HudFieldsState } from "../../../tools/hudFormat";
import type { RichTextDoc } from "../../../text/richText";
import type { DisplayUnits } from "../../../tools/displayUnits";
import type { Selection } from "../../../state/selection";

/** Ein Polygon mit Schraffur + die ihm zugewiesene <pattern>-ID. */
export interface HatchedPoly {
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

/** Ein Objekt unter dem Cursor — für das Durchschalten übereinanderliegender Objekte. */
export interface PickCandidate {
  kind: PickKind;
  id: string;
  /** Polygon-Index (für die lokale Hervorhebung), falls aus einem Polygon. */
  hitIndex: number | null;
  /** Kurzbezeichnung für die Liste (z. B. "Wand", "Linie"). */
  label: string;
}

/** Ids einer Auswahl OHNE Klickposition/Shift — Ergebnis von `defaultPick`. */
export type PickIds = Omit<PlanSelection, "model" | "shift" | "replaces">;

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
   * [137] Getroffene Lage-Darstellung (Schattenfläche → `"sunStudy"`, Baurechtslinie → `"siteRules"`),
   * wenn kein Element höherer Priorität getroffen wurde; Vorrang vor Kontext-Objekten (sie liegt darüber).
   */
  siteId?: string | null;
  /**
   * [149] Getroffener Baum (Kronenfläche, Pick-Id `@tree:<id>` im Feld `contextObjectId`), wenn keine
   * Öffnung/Wand/Stütze/2D-Element/Körper getroffen wurde; Vorrang vor Decke, Raum, Dach und Gelände.
   */
  treeId?: string | null;
  /**
   * War beim Klick Shift gedrückt? Dann ERWEITERT der Aufrufer (App) die
   * Auswahl um das getroffene Element (bzw. schaltet es ab/zu), statt sie zu
   * ersetzen. Bei Leerraum-Klick mit Shift bleibt die Auswahl erhalten.
   */
  shift: boolean;
  /**
   * Nur bei Shift + Durchschalten (Cmd/Strg+Shift-Klick wiederholt an derselben
   * Stelle): das im vorigen Schritt dazugewählte Objekt wird zuerst wieder
   * entfernt, damit nicht jede Zwischenstation in der Auswahl landet.
   */
  replaces?: { kind: PickKind; id: string };
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
  /** [149] Getroffene Bäume (Kronenfläche, gleiche Konvention). */
  treeIds?: string[];
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
   * [185] Schlüssel nur für das Einpassen (fehlt: `resetKey`). Geschosse teilen sich einen (`planFitKey`): der
   * Geschosswechsel behält Zoom und Ausschnitt exakt, Pick-Zyklus u. ä. folgen weiter `resetKey`.
   */
  fitKey?: string;
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
  /** Kategorie-/Layer-Name eines Objekts für die Cmd/Strg+Klick-Liste ("Fläche · 01421"). */
  describePick?: (kind: PickKind, id: string) => string | undefined;
  /** [137] Statusleisten-Hinweis zum Klick-Zyklus („2/3 Treffer — erneut klicken …"), `null` = keiner. */
  onPickHint?: (hint: string | null) => void;
  /**
   * Alt+Klick (Schere/Segment löschen): meldet das nahe getroffene Drawing2D plus
   * den Modellpunkt des Klicks. Der Aufrufer (App) ermittelt daraus die nächst-
   * gelegene Kante und entfernt sie. Optional. Nur ausgelöst, wenn ein 2D-Element
   * unter dem Cursor liegt (sonst no-op).
   */
  onSegmentCut?: (drawingId: string, model: Vec2) => void;
  /**
   * Die Auswahl (kontrolliert von App, [130]). Die Ansicht markiert ALLE Primitive
   * JEDES gewählten Elements mit einer Akzentkontur (Wände: alle Bänder; Dach: die
   * Traufe; Kontext-Objekte/Schnittlinien: das Pick-Band). Gewählte GRUPPEN zeigen
   * statt der Mitglieds-Umrisse nur eine Bounding-Box (s. `groupBBox`); die übrigen
   * Arten tragen weiterhin die volle Mitgliedschaft. Fehlt = nichts gewählt.
   */
  selection?: Selection;
  /**
   * Der Stempel-Griff des (einzeln) gewählten Raums: sein Anker (Meter) + ID.
   * PlanView zeichnet einen ziehbaren Griff und meldet Bewegung/Doppelklick.
   * `null` = kein einzelner Raum gewählt.
   */
  roomStamp?: { roomId: string; anchor: Vec2 } | null;
  /** Der Stempel-Griff wurde verschoben (inkrementelles Modell-Delta). */
  /** `from`: gezeichnete Lage des Stempels (der Kern verschiebt ab ihr, solange der Raum keinen eigenen Anker hat). */
  onStampMove?: (roomId: string, delta: Vec2, from?: Vec2) => void;
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
  /** Griff-Zieh-Treiber: Live-Bewegung (gesnappt) + Abschluss. */
  gripHandlers?: GripHandlers;
  /**
   * Schnitt-/Ansichts-Blatt: zusätzlich gewählte Öffnungen und Decken per
   * Körper-Zug greifbar (die App überträgt das Blatt-Delta entlang der
   * Schnittlinie, s. useGripEditing `sheet`). Im Grundriss aus.
   */
  sheetBodies?: boolean;
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
  /**
   * Hintergrund unter der Zeichnung (z. B. das Layout-Blatt: Papier, Master, Viewports), gezeichnet
   * im SVG zwischen Raster und Geometrie. `origin` = Ursprung des Overlays (viewBox-Einheiten, s.
   * planView/overlayOrigin.ts), `pxPerMeter` = aktueller Zoom. Mit Hintergrund zeichnet der SVG-Pfad
   * (wie bei Luftbildern), damit er sichtbar bleibt.
   */
  backdrop?: (origin: Vec2, pxPerMeter: number) => ReactNode;
  /** Anzeige-Einheiten von Linealen und HUD (Layout-Blatt: Papier-mm, y nach unten, [93]). */
  units?: DisplayUnits;
  /** Einpass-Bereich (Modell-Meter) statt der Plan-Grenzen — z. B. das Blatt. */
  fitBounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Treiber für das Ziehen von Editier-Griffen (von App bereitgestellt). */
/** Gegriffener Körper beim Parallel-Verschieben. */
export interface BodyTarget {
  wallId?: string;
  drawingId?: string;
  /** Nur im Schnitt/in der Ansicht (`sheetBodies`). */
  openingId?: string;
  /** Nur im Schnitt/in der Ansicht (`sheetBodies`). */
  ceilingId?: string;
  /** Nur im Schnitt/in der Ansicht (`sheetBodies`). */
  stairId?: string;
  /** [193] Gelände-/Umgebungs-Elemente (alle gewählten, das gegriffene liegt darunter). */
  contextIds?: string[];
}

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
    target?: BodyTarget,
    mods?: ToolMods,
    pxPerMeter?: number,
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
