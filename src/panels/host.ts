// Host-Vertrag für Inhalts-Panels — die konkrete Form des PanelHostContext.
//
// Die Foundation (types.ts) hält den Context bewusst lose (Record<string,
// unknown>), damit der Kern nicht vom Projekt-/Handler-Modell abhängt. Die
// eingebauten Panels brauchen jedoch eine klare, getippte Sicht auf den Host.
// Dieses Modul definiert daher EINEN Vertrag (`PanelHostValue`) und einen Hook
// (`usePanelHost`), der den Context liest, gegen das Fehlen eines Providers
// absichert und das Ergebnis auf diesen Vertrag verengt.
//
// App stellt einen Wert dieser Form über <PanelHostContext.Provider> bereit
// (siehe Report am Ende der Aufgabe). Bezeichner englisch, Kommentare deutsch
// (CONVENTIONS.md).

import { useContext } from "react";
import { PanelHostContext } from "./types";
import type { DisplayMode } from "./types";
import type {
  AttributeSource,
  CeilingType,
  RoofType,
  Component,
  ContextObject,
  DrawingLevel,
  HatchStyle,
  LayerCategory,
  LayoutOrientation,
  LayoutPaperFormat,
  LineStyle,
  MasterLayout,
  Project,
  SiaCategory,
  SliceTermination,
  StairShape,
  VerticalAnchor,
  WallReferenceLine,
  WallType,
} from "../model/types";
import type { MeasurementReadout, SnapSettings, ToolId } from "../tools/types";
import type { Selection } from "../state/selectionInfo";
import type { ScheduleKind } from "../export/exportSchedule";

// ── Darstellungsmodus-Steuerung je Dock-Inhalt ────────────────────────────

/**
 * Aktueller Darstellungsmodus plus Setter. Panels, die `hasDisplayMode: true`
 * deklarieren, lesen `mode` und gruppieren ihre Zeilen danach (über
 * `itemDisplay` aus displayMode.ts). Der Umschalter selbst sitzt in der
 * Panel-Kopfzeile des Rahmens und ruft `setMode`.
 */
export interface DisplayModeControl {
  mode: DisplayMode;
  setMode: (mode: DisplayMode) => void;
}

// ── Vollständiger Host-Vertrag ─────────────────────────────────────────────

/**
 * Was die eingebauten Panels vom Host erwarten. App reicht genau dieses Objekt
 * über <PanelHostContext.Provider value={…}> hinein; jedes Feld entspricht
 * einem Stück Zustand bzw. einem immutablen Handler, der heute in App.tsx als
 * Closure über setProject existiert.
 */
export interface PanelHostValue {
  // Projektzustand (Single Source of Truth aus App).
  project: Project;

  // Aktive Auswahl (Zeichnungsebene) — Arbeitsfokus für „active"/„grey".
  activeLevelId: string;

  // ── Werkzeug-Palette (Tools-Panel) ──────────────────────────────────────
  /** Aktives Zeichenwerkzeug. */
  activeTool: ToolId;
  /** Werkzeug wählen. */
  onSelectTool: (id: ToolId) => void;
  /** Werkzeuge nur im Grundriss eines Geschosses sinnvoll. */
  toolsEnabled: boolean;
  /** Aktiver Wandtyp (für das Wand-Werkzeug). */
  activeWallTypeId: string;
  onActiveWallTypeId: (id: string) => void;
  /** Snap-Einstellungen + Setter (Fang-Optionen in der Werkzeug-Palette). */
  snap: SnapSettings;
  onSnapChange: (s: SnapSettings) => void;

  // Darstellungsmodus für ortsabhängige Panels (DrawingLevels, Layers).
  displayMode: DisplayModeControl;

  // Zeichnungsebenen-Handler.
  onSelectLevel: (id: string) => void;
  onToggleLevel: (id: string) => void;
  onAddFloor: () => void;
  onAddDrawing: () => void;
  onAddSection: () => void;
  onAddElevation: () => void;
  /**
   * Rechtsklick auf eine Zeichnungsebenen-Zeile: öffnet das Kontextmenü an der
   * Cursorposition. App hält das offene Menü und baut die Einträge
   * (Einstellungen / Duplizieren / Löschen).
   */
  onLevelContextMenu: (id: string, clientX: number, clientY: number) => void;

  // Ebenen-(Kategorie-)Handler.
  /** Aktive Ebene (Kategorie-Code) — Ziel neuer Zeichnungen; per Klick wählbar. */
  activeCategoryCode: string;
  /** Eine Ebene zur aktiven machen (Klick auf die Zeile im Ebenen-Panel). */
  onSelectCategory: (code: string) => void;
  onToggleCategory: (code: string) => void;
  onAddCategory: () => void;
  /**
   * Rechtsklick auf eine Ebenen-(Kategorie-)Zeile: öffnet das Kontextmenü an der
   * Cursorposition. App baut die Einträge (Einstellungen / Sub-Ebene /
   * Selektion übertragen / Duplizieren / Eigenschaften kopieren+einfügen /
   * Löschen) und hält das offene Menü.
   */
  onLayerContextMenu: (code: string, clientX: number, clientY: number) => void;

  // Ressourcen-Handler (Bauteile / Schraffuren / Linienstile). Spiegelt
  // ResourceManagerHandlers, hier flach getippt, damit dieses Modul nicht von
  // der UI-Komponente abhängt.
  onPatchComponent: (id: string, patch: Partial<Component>) => void;
  onAddComponent: () => void;
  onDeleteComponent: (id: string) => void;
  onPatchHatch: (id: string, patch: Partial<HatchStyle>) => void;
  onAddHatch: () => void;
  onDeleteHatch: (id: string) => void;
  onPatchLineStyle: (id: string, patch: Partial<LineStyle>) => void;
  onAddLineStyle: () => void;
  onDeleteLineStyle: (id: string) => void;
  /** Wandstile: immutable Änderung eines Wandtyps (Schichtfugen-Stile). */
  onPatchWallType: (id: string, patch: Partial<WallType>) => void;
  onAddWallType: () => void;
  onDeleteWallType: (id: string) => void;
  /** Deckenstile: immutable Änderung eines Deckentyps (Schichtfugen-Stile). */
  onPatchCeilingType: (id: string, patch: Partial<CeilingType>) => void;
  onAddCeilingType: () => void;
  onDeleteCeilingType: (id: string) => void;
  /** Dachtypen (Dachaufbauten): immutable Änderung/Anlage/Löschung. */
  onPatchRoofType: (id: string, patch: Partial<RoofType>) => void;
  onAddRoofType: () => void;
  onDeleteRoofType: (id: string) => void;
  /** Import fertiger (id-loser) Linienstile/Schraffuren (.lin/.pat). */
  onImportLineStyles: (styles: Omit<LineStyle, "id">[]) => void;
  onImportHatches: (hatches: Omit<HatchStyle, "id">[]) => void;

  // ── Selektions-Attribute (Attributes-/Object-Info-Paletten) ─────────────
  /**
   * Normalisierte, effektiv aufgelöste Sicht auf das ERSTE selektierte Element
   * (oder `null`). Die Paletten lesen daraus Farbe/Strichstärke/Füllung/bbox
   * und grauen nicht-anwendbare Felder per `selection.kind` aus.
   */
  selection: Selection | null;
  /**
   * Live-Messwerte des Mess-Werkzeugs (Länge/Fläche/Winkel), oder `null`, wenn
   * gerade nicht gemessen wird. Das Objekt-Info-Panel zeigt sie dauerhaft an,
   * damit der Messwert nicht nur flüchtig am Cursor (HUD) erscheint.
   */
  measurement: MeasurementReadout | null;
  /** Setzt die (Strich-)Farbe der aktuellen Selektion (Wand oder Drawing2D). */
  onSetSelectionColor: (color: string) => void;
  /**
   * Setzt den Strichstärke-Override (mm, „eigener Wert") — Wand/Decke
   * (`strokeWeight`) oder Drawing2D (`weightMm`). Die Quelle (Ebene/Bauteil)
   * setzt {@link onSetSelectionStrokeWeightSource}.
   */
  onSetSelectionWeight: (weightMm: number) => void;
  /**
   * Setzt/entfernt den Schraffur-Override („eigener Wert") — Wand, Decke oder
   * Drawing2D (geschlossene Formen). `null` löscht den Wert (fällt zurück auf
   * die Quelle, siehe {@link onSetSelectionHatchSource}).
   */
  onSetSelectionFill: (hatchId: string | null) => void;
  /**
   * Setzt/entfernt den Linienstil-Override — wirkt NUR auf Drawing2D (sonst
   * No-op). `undefined` löscht den Wert (fällt zurück auf den Default-Stil).
   */
  onSetSelectionLineStyle: (lineStyleId: string | undefined) => void;
  /**
   * Setzt/entfernt die Vollton-Füllfarbe — wirkt NUR auf Drawing2D (sonst No-op).
   * `null` entfernt die Füllfarbe (Fläche wieder transparent).
   */
  onSetSelectionFillColor: (color: string | null) => void;
  /**
   * Setzt/entfernt den Vordergrund-Override (Muster-/Schraffurfarbe, „eigener
   * Wert") der Selektion — Wand, Decke oder geschlossene Drawing2D. `null` =
   * „Nach System" (fällt zurück auf die Quelle, siehe
   * {@link onSetSelectionForegroundSource}).
   */
  onSetSelectionForeground: (color: string | null) => void;
  /**
   * Setzt/entfernt den Hintergrund-Override (Füllfarbe/Poché, „eigener Wert")
   * der Selektion — Wand, Decke oder geschlossene Drawing2D. `null` = „Nach
   * System" (siehe {@link onSetSelectionBackgroundSource}).
   */
  onSetSelectionBackground: (color: string | null) => void;
  /**
   * Setzt die Quelle des Vordergrunds, wenn KEIN „eigener Wert" gilt: "layer" =
   * Nach Ebene, "object" = Nach Bauteil. Löscht dabei IMMER den expliziten
   * Vordergrund-Override (die Quelle gewinnt nur, wenn kein Wert gesetzt ist).
   */
  onSetSelectionForegroundSource: (source: AttributeSource) => void;
  /** Setzt die Quelle des Hintergrunds, analog zu {@link onSetSelectionForegroundSource}. */
  onSetSelectionBackgroundSource: (source: AttributeSource) => void;
  /** Setzt die Quelle der Strichstärke, analog zu {@link onSetSelectionForegroundSource}. */
  onSetSelectionStrokeWeightSource: (source: AttributeSource) => void;
  /** Setzt die Quelle der Schraffur, analog zu {@link onSetSelectionForegroundSource}. */
  onSetSelectionHatchSource: (source: AttributeSource) => void;
  /**
   * Skaliert die Selektion auf Zielbreite×-höhe (Meter) um einen Anker
   * (fx/fy ∈ [0,1] relativ zur bbox; 0,0 = oben-links … 1,1 = unten-rechts).
   */
  onResizeSelection: (
    w: number,
    h: number,
    anchor: { fx: number; fy: number },
  ) => void;
  /**
   * Verschiebt die Selektion um (dx,dy) Meter — generischer Move über das
   * Transform-System (analog dem Move-Werkzeug/-Befehl), deckt Wand/Drawing2D/
   * Extrusionskörper ab. Bei Decke/Öffnung/Treppe/Raum (Transform-Kern kennt
   * diese Elementarten nicht) ein No-op.
   */
  onMoveSelectionBy: (dx: number, dy: number) => void;
  /**
   * Setzt die Grafik-Kategorie (Klasse/Ebene) des selektierten Elements —
   * editierbar im Objektinfo-Kopf (VW: „Klasse"). Wirkt auf alle Elementarten
   * mit `categoryCode`.
   */
  onSetSelectionCategory: (code: string) => void;
  /**
   * Verschiebt das selektierte Element auf eine andere Zeichnungsebene
   * (Geschoss) — editierbar im Objektinfo-Kopf (VW: „Ebene"). No-op bei
   * Öffnungen (deren Ebene kommt aus der Wirts-Wand).
   */
  onSetSelectionLevel: (levelId: string) => void;
  /**
   * Dreht die Selektion um `deg` Grad um den Weltpunkt (cx,cy) — generischer
   * Rotate über das Transform-System; deckt dieselben Selektionsarten ab wie
   * {@link onMoveSelectionBy}.
   */
  onRotateSelectionAround: (cx: number, cy: number, deg: number) => void;
  /**
   * Setzt die Länge einer Linien-Drawing2D (Endpunkt entlang der Richtung neu
   * skaliert, Startpunkt bleibt fix). No-op, wenn die Selektion keine Linie ist.
   */
  onSetDrawingLineLength: (length: number) => void;
  /**
   * Setzt den Radius einer Kreis-Drawing2D (Mittelpunkt bleibt fix). No-op,
   * wenn die Selektion kein Kreis ist.
   */
  onSetDrawingCircleRadius: (radius: number) => void;

  // ── Wand-Attribute (Object-Info-Panel; wirken NUR auf die selektierte Wand) ─
  /** Setzt die Lage der Wandachse über die Dicke (außen/mitte/innen). */
  onSetWallReferenceLine: (ref: WallReferenceLine) => void;
  /**
   * Setzt einen freien Achsversatz (Schichttrennlinie als Referenz) oder löscht
   * ihn (`null` → zurück zur benannten Referenzlinie). Meter entlang +n.
   */
  onSetWallReferenceOffset: (offset: number | null) => void;
  /**
   * Setzt die Terminierungs-Regel am Deckenanschluss (Zuschnitt, NICHT Priorität):
   * "both" = heutiges Verhalten, "below"/"above" = die Wand endet an der Decke.
   */
  onSetWallSliceTermination: (termination: SliceTermination) => void;
  /** Weist der Wand einen Wandtyp-Preset (mehrschichtiger Aufbau) zu. */
  onSetWallType: (wallTypeId: string) => void;
  /** Setzt die Gesamtdicke einer einschichtigen Wand (Meter). */
  onSetWallThickness: (thickness: number) => void;
  /** Setzt/entfernt die UK-Bindung (`null` = Geschoss-Default). */
  onSetWallBottom: (anchor: VerticalAnchor | null) => void;
  /** Setzt/entfernt die OK-Bindung (`null` = UK + height). */
  onSetWallTop: (anchor: VerticalAnchor | null) => void;

  // ── Decken-Attribute (Object-Info-Panel; wirken NUR auf die selektierte Decke) ─
  /** Weist der Decke einen dedizierten Deckentyp-Preset zu (Deckenstil). */
  onSetCeilingType: (ceilingTypeId: string) => void;
  /** Setzt die Gesamtdicke der Decke (Meter, thickness-Übersteuerung). */
  onSetCeilingThickness: (thickness: number) => void;
  /** Entfernt die Aussparung mit Index `index` der selektierten Decke. */
  onRemoveCeilingOpening: (index: number) => void;
  /** Setzt/entfernt die OK-Bindung der Decke (`null` = Geschoss-Oberkante). */
  onSetCeilingTop: (anchor: VerticalAnchor | null) => void;
  /**
   * Setzt/entfernt die UK-Bindung der Decke (`null` = OK − Dicke). Optional,
   * da bestehende Hosts (App.tsx) diesen Setter ggf. noch nicht verdrahtet
   * haben — additive Erweiterung analog `onSetWallBottom`.
   */
  onSetCeilingBottom?: (anchor: VerticalAnchor | null) => void;

  // ── Öffnungs-Attribute (Object-Info-Panel; nur die selektierte Öffnung) ─
  /** Wechselt die Art (Fenster/Tür); setzt bei Tür die Tür-Defaults. */
  onSetOpeningKind: (kind: "window" | "door") => void;
  /** Setzt die Öffnungsbreite (Meter). */
  onSetOpeningWidth: (width: number) => void;
  /** Setzt die Öffnungshöhe (Meter). */
  onSetOpeningHeight: (height: number) => void;
  /** Setzt die Brüstungshöhe (Meter; nur Fenster sinnvoll). */
  onSetOpeningSill: (sillHeight: number) => void;
  /** Setzt die Position entlang der Wandachse (Meter ab Wandanfang). */
  onSetOpeningPosition: (position: number) => void;
  /** Setzt den Türöffnungswinkel (Grad). */
  onSetOpeningSwingAngle: (swingAngle: number) => void;
  /** Setzt den Anschlag-Pfosten der Tür. */
  onSetOpeningHinge: (hinge: "start" | "end") => void;
  /** Setzt die Aufschlagseite der Tür. */
  onSetOpeningSwing: (swing: "left" | "right") => void;
  /** Setzt die Aufschlagrichtung der Tür (innen/außen). */
  onSetOpeningDir: (dir: "in" | "out") => void;
  /** Setzt die Flügelanzahl des Fensters (1–4). */
  onSetOpeningWingCount: (wingCount: number) => void;
  /** Setzt den Tür-Typ (normal / Wandöffnung). */
  onSetOpeningDoorType: (doorType: "normal" | "wandoeffnung") => void;
  /** Setzt die Sturzlinien-Darstellung der Tür. */
  onSetOpeningLintelLines: (lintelLines: "keine" | "innen" | "aussen" | "beide") => void;
  /** Übersteuert Farbe/Strichstärke des Blendrahmens + Stulp-/Laibungsblöcke. */
  onSetOpeningFrameLine: (v: { color?: string; weight?: number } | undefined) => void;
  /** Übersteuert Farbe/Strichstärke von Flügelrahmen/Sprossen. */
  onSetOpeningSashLine: (v: { color?: string; weight?: number } | undefined) => void;
  /** Übersteuert Farbe/Strichstärke der Auf-/Untersicht-Andeutung (Sims). */
  onSetOpeningSillLineStyle: (v: { color?: string; weight?: number } | undefined) => void;
  /** Weist der Öffnung einen Tür-/Fenstertyp (Bibliothek) zu; "" löst die Zuweisung. */
  onSetOpeningType: (typeId: string) => void;
  /**
   * Öffnet das Ressourcen-Fenster direkt beim Tür- bzw. Fenstertyp-Editor
   * (Discoverability: von der gewählten Öffnung in den Typeditor springen).
   */
  onEditOpeningType: (kind: "door" | "window") => void;
  /**
   * Öffnet den reichen Fenster-/Tür-Einstellungsdialog für DIESE Öffnung
   * (Kategorie-Sidebar, Live-2D-Vorschau, Flügeleinteilung, „Als Stil speichern").
   * Ist der Primärort für Öffnungs-Parameter; das ⚙ der OpeningSection ruft ihn.
   */
  onOpenOpeningEditor: (openingId: string) => void;
  /**
   * Immutable Änderung von Dach-Attributen (Form/Neigung/Überstand/Firstrichtung/
   * Dicke) — wirkt NUR auf das selektierte Dach.
   */
  onSetRoofPatch: (patch: Partial<import("../model/types").Roof>) => void;

  // ── Schnitt-/Ansichtslinie (Object-Info-Panel; nur die selektierte Linie) ──
  /**
   * Die aktuell gewählte Schnitt-/Ansichtsebene (DrawingLevel, kind
   * "section"/"elevation"), oder `null`. Das Object-Info-Panel zeigt ihre
   * Attribute (Name, Blickrichtung, Endpunkte, Tiefe), auch wenn `selection`
   * null ist (eine Schnittlinie ist KEIN Projekt-Bauteil).
   */
  sectionLine: DrawingLevel | null;
  /**
   * Immutable Änderung einer Schnitt-/Ansichtslinie (Name/directionSign/
   * linePoints/depth) — wirkt NUR auf die selektierte Linie.
   */
  onSetSectionLinePatch: (patch: Partial<DrawingLevel>) => void;
  /**
   * Löscht die Schnittlinie der gewählten Ebene (`linePoints` = undefined); die
   * Ebene selbst bleibt bestehen (der Schnitt zeigt dann wieder den Hinweis).
   */
  onDeleteSectionLine: () => void;

  // ── Treppen-Attribute (Object-Info-Panel; nur die selektierte Treppe) ───
  /** Setzt die Grundform (gerade/L/Wendel). */
  onSetStairShape: (shape: StairShape) => void;
  /** Setzt die Laufbreite (Meter). */
  onSetStairWidth: (width: number) => void;
  /** Setzt die Stufenanzahl (Setzstufen, ≥ 2). */
  onSetStairSteps: (stepCount: number) => void;
  /** Setzt die Gesamt-Steighöhe (Meter, OKFF → OKFF). */
  onSetStairRise: (totalRise: number) => void;
  /** Setzt die Laufrichtung (aufwärts/abwärts). */
  onSetStairUp: (up: boolean) => void;
  /** Setzt den Referenzpunkt der Laufbreite (links/mitte/rechts). */
  onSetStairReferenz: (referenz: "links" | "mitte" | "rechts") => void;
  /** Weist der Treppe einen Treppentyp (Bibliothek) zu; "" löst die Zuweisung. */
  onSetStairType: (typeId: string) => void;

  // ── Raum-Attribute (Object-Info-Panel; nur der selektierte Raum) ────────
  /** Setzt den Raum-Namen. */
  onSetRoomName: (name: string) => void;
  /** Setzt die SIA-416-Blatt-Kategorie des Raums. */
  onSetRoomSia: (category: SiaCategory) => void;
  /** Öffnet den Rich-Text-Editor des Raum-Stempels (per ID). */
  onEditRoomStamp: (roomId: string) => void;

  // ── Extrusions-Attribute (truck-Integration; nur der selektierte Körper) ──
  /** Setzt die Extrusionshöhe (Meter, > 0) — löst eine Re-Extrusion aus. */
  onSetExtrudedSolidHeight: (height: number) => void;
  /** Setzt die Verjüngung (0..1) — löst eine Re-Extrusion aus. */
  onSetExtrudedSolidTaper: (taper: number) => void;

  // ── Stützen-Attribute (Tragwerk; nur die selektierte Stütze) ────────────
  /** Wechselt das Profil (Rechteck/Kreis); leitet ein sinnvolles Mass ab. */
  onSetColumnProfileKind: (kind: "rect" | "round") => void;
  /** Setzt die Breite (X) eines Rechteckprofils (Meter). */
  onSetColumnWidth: (width: number) => void;
  /** Setzt die Tiefe (Y) eines Rechteckprofils (Meter). */
  onSetColumnDepth: (depth: number) => void;
  /** Setzt den Radius eines Kreisprofils (Meter). */
  onSetColumnRadius: (radius: number) => void;
  /** Setzt die Höhe der Stütze (Meter, > 0). */
  onSetColumnHeight: (height: number) => void;
  /** Setzt die Drehung der Stütze (Grad; intern in Radiant gespeichert). */
  onSetColumnRotation: (deg: number) => void;

  // ── Site-/Kontext-Schicht (SitePanel) ───────────────────────────────────
  /** Aktuelle Kontext-Objekte (Meshes/Konturen/Gelände) aus `project.context`. */
  contextObjects: ContextObject[];
  /** Im 3D-Viewport angewählte Kontext-Objekte (Umriss-Hervorhebung), s. selectionSlice. */
  selectedContextObjectIds: string[];
  /** Fügt mehrere Kontext-Objekte hinzu (z. B. aus einem DXF-Import). */
  onAddContextObjects: (objs: ContextObject[]) => void;
  /** Entfernt ein Kontext-Objekt per ID. */
  onRemoveContextObject: (id: string) => void;
  /**
   * Erzeugt aus einem ContourSet (per ID) ein Gelände-TIN. Liefert die neue
   * TerrainMesh-ID oder null (unbekannte ID / kein sinnvolles TIN).
   */
  onGenerateTerrain: (contourSetId: string) => string | null;
  /**
   * Setzt/ersetzt den Georeferenzierungs-Bezug (`Project.geoAnchor`) — welcher
   * Modell-Punkt welcher realen LV95-Koordinate entspricht. `undefined` löscht
   * den Bezug (nächster Import setzt ihn automatisch neu).
   */
  onSetGeoAnchor: (
    anchor: { lv95: { e: number; n: number }; model: { x: number; y: number }; label?: string } | undefined,
  ) => void;
  /** Öffnet den (in App montierten) versteckten DXF-Datei-Dialog. */
  onImportDxf: () => void;

  // ── Element-Baum (Elemente-Panel) ───────────────────────────────────────
  /**
   * Selektiert EIN Bauteil-Vorkommen aus der Elementliste (`scheduleRows`) im
   * Baum: leert alle Auswahl-Kanäle und setzt genau dieses Element im
   * passenden Kanal (Wand/Decke/Fenster+Öffnung/Treppe/Extrusion). Liegt das
   * Element auf einem anderen Geschoss, wechselt zuerst die aktive
   * Zeichnungsebene. Für Bauteilklassen ohne Auswahl-Kanal (aktuell nur die
   * Legacy-„Tür"-Datensätze aus `project.doors`, die kein Werkzeug mehr
   * anlegt) ein No-op. `opts.zoom` (Shift-Klick/Doppelklick in der Baumzeile)
   * passt die Plan-Ansicht zusätzlich ein.
   */
  onSelectScheduleRow: (
    kind: ScheduleKind,
    id: string,
    floorId: string | undefined,
    opts?: { zoom?: boolean },
  ) => void;

  // ── Ausschnitte / View-Snapshots (Ausschnitte-Panel, DOSSIER A2) ─────────
  // Die Liste selbst liest das Panel über `project.viewSnapshots`. Die
  // Erfassungs-/Anwendungslogik (Setter/rAF) lebt in App.tsx; hier nur die
  // immutablen Handler.
  /**
   * Erfasst den aktuellen Darstellungszustand als neuen, benannten Ausschnitt.
   * `folderId` legt ihn direkt im angegebenen Ordner ab (sonst Wurzelebene) —
   * additiv, Alt-Aufrufe ohne Ordner-Argument bleiben gültig.
   */
  onCaptureViewSnapshot: (name: string, folderId?: string) => void;
  /** Stellt alle Felder eines Ausschnitts wieder her (Geschoss/Sichtbarkeit/Overrides/Ansicht). */
  onApplyViewSnapshot: (id: string) => void;
  /** Benennt einen Ausschnitt um. */
  onRenameViewSnapshot: (id: string, name: string) => void;
  /** Löscht einen Ausschnitt. */
  onDeleteViewSnapshot: (id: string) => void;

  // ── Ausschnitte-Baum (Ordner, DOSSIER A2) ───────────────────────────────
  // Die Listen liest das Panel über `project.viewSnapshots`/
  // `project.viewSnapshotFolders`; pure CRUD in state/viewSnapshotFolders.ts.
  /** Legt einen neuen Ordner an (optional in `parentId`); liefert die neue Id. */
  onAddViewSnapshotFolder: (parentId?: string) => string;
  /** Benennt einen Ausschnitte-Ordner um. */
  onRenameViewSnapshotFolder: (id: string, name: string) => void;
  /**
   * Löscht einen Ausschnitte-Ordner (enthaltene Ausschnitte + Unterordner wandern
   * auf die Elternebene, kein Datenverlust).
   */
  onDeleteViewSnapshotFolder: (id: string) => void;
  /**
   * Verschiebt einen Ausschnitt per Drag&Drop in einen Ordner (`folderId`) bzw.
   * auf die Wurzelebene (`null`).
   */
  onMoveViewSnapshotToFolder: (snapshotId: string, folderId: string | null) => void;
  /**
   * Verschiebt einen Ordner per Drag&Drop unter einen Elternordner (`parentId`)
   * bzw. auf die Wurzelebene (`null`). Zyklen (Ordner in sich/seinen Nachfahren)
   * werden verworfen (No-op).
   */
  onMoveViewSnapshotFolder: (folderId: string, parentId: string | null) => void;

  /**
   * Id des aktuell „angewählten" Ausschnitts (Footer-Bar sichtbar) oder `null`.
   * Bleibt gesetzt, solange der Live-Zustand exakt dem Ausschnitt entspricht;
   * App löscht ihn, sobald der Nutzer eine erfasste Grösse ändert.
   */
  selectedViewSnapshotId: string | null;
  /** Namen aller gespeicherten Ebenen-Kombinationen (localStorage). */
  listLayerCombos: () => string[];
  /** Lädt die `codes`-Map einer Ebenen-Kombination (`null`, wenn unbekannt). */
  loadLayerCombo: (name: string) => Record<string, boolean> | null;
  /** Namen aller gespeicherten Zeichnungs-Kombinationen (localStorage). */
  listDrawingCombos: () => string[];
  /** Lädt die `ids`-Map einer Zeichnungs-Kombination (`null`, wenn unbekannt). */
  loadDrawingCombo: (name: string) => Record<string, boolean> | null;

  // ── Layouts / Masterlayouts (Layouts-Panel, DOSSIER A3) ─────────────────
  // Die Listen liest das Panel über `project.layouts`/`project.masterLayouts`.
  // Die Mutationslogik lebt in App.tsx (setProject); pure CRUD in
  // panels/layoutModel.ts.
  /** Legt ein neues, leeres Layout an und öffnet den Editor. */
  onAddLayout: (
    name: string,
    paper: LayoutPaperFormat,
    orientation: LayoutOrientation,
  ) => void;
  /** Benennt ein Layout um. */
  onRenameLayout: (id: string, name: string) => void;
  /** Löscht ein Layout (schliesst ggf. den offenen Editor). */
  onDeleteLayout: (id: string) => void;
  /** Öffnet ein Layout im schwebenden Layout-Editor. */
  onOpenLayout: (id: string) => void;
  /** Legt ein neues Masterlayout an. */
  onAddMasterLayout: (name: string) => void;
  /** Benennt ein Masterlayout um. */
  onRenameMasterLayout: (id: string, name: string) => void;
  /** Löscht ein Masterlayout (löst Bindungen der Layouts). */
  onDeleteMasterLayout: (id: string) => void;
  /** Ändert Felder eines Masterlayouts (Titelblock/Papier/Rahmen). */
  onPatchMasterLayout: (id: string, patch: Partial<MasterLayout>) => void;

  // ── Layouts-Baum (Ordner) + Erstell-Dialoge (DOSSIER A3) ────────────────
  /** Legt einen neuen Ordner an (optional in `parentId`); liefert die neue Id. */
  onAddLayoutFolder: (parentId?: string) => string;
  /**
   * Legt einen neuen MASTER-Ordner (`kind:"master"`) an (optional in `parentId`);
   * liefert die neue Id. Analog {@link onAddLayoutFolder}, aber im Master-Baum.
   */
  onAddMasterFolder: (parentId?: string) => string;
  /** Benennt einen Ordner um (Layout- wie Master-Ordner, per Id). */
  onRenameLayoutFolder: (id: string, name: string) => void;
  /** Löscht einen Ordner (Inhalt wandert auf die Elternebene, kein Datenverlust). */
  onDeleteLayoutFolder: (id: string) => void;
  /**
   * Löscht einen Master-Ordner (enthaltene Masterlayouts + Unterordner wandern
   * auf die Elternebene, kein Datenverlust). Analog {@link onDeleteLayoutFolder}.
   */
  onDeleteMasterFolder: (id: string) => void;
  /**
   * Legt ein Layout mit expliziten Startwerten (Master-Vorlage ODER freie
   * Grösse) an und liefert dessen Id (das Panel versetzt es in Inline-Rename).
   * Öffnet das Blatt NICHT automatisch (anders als {@link onAddLayout}).
   */
  onCreateLayout: (opts: CreateLayoutOptions) => string;
  /** Legt ein Masterlayout mit Grösse an und liefert dessen Id. */
  onCreateMasterLayout: (opts: CreateMasterLayoutOptions) => string;
  /** Exportiert alle Layouts eines Ordners als EIN Mehrseiten-PDF. */
  onExportFolderPdf: (folderId: string) => void;
  /**
   * Verschiebt ein Layout per Drag&Drop in einen Ordner (`folderId`) bzw. auf
   * die Wurzelebene (`null`).
   */
  onMoveLayoutToFolder: (layoutId: string, folderId: string | null) => void;
  /**
   * Verschiebt einen Ordner per Drag&Drop unter einen Elternordner (`parentId`)
   * bzw. auf die Wurzelebene (`null`). Zyklen (Ordner in sich/seinen Nachfahren)
   * werden verworfen (No-op).
   */
  onMoveFolderToFolder: (folderId: string, parentId: string | null) => void;
}

/** Startwerte eines neuen Layouts (aus dem „Neues Layout"-Dialog). */
export interface CreateLayoutOptions {
  /** Zielordner; ohne → Wurzelebene. */
  folderId?: string;
  /** Gebundenes Masterlayout (erbt dessen Grösse); ohne → freie Grösse. */
  masterId?: string;
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
  customWidthMm?: number;
  customHeightMm?: number;
}

/** Startwerte eines neuen Masterlayouts (aus dem „Neues Masterlayout"-Dialog). */
export interface CreateMasterLayoutOptions {
  /** Ziel-Master-Ordner; ohne → Wurzelebene des Master-Baums. */
  folderId?: string;
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
  customWidthMm?: number;
  customHeightMm?: number;
}

// Re-Export der Modelltypen, die die Panels im selben Atemzug brauchen — so
// importieren Panels nur aus „./host" und bleiben auf einen Pfad fokussiert.
export type { DrawingLevel, LayerCategory };
export type { SnapSettings, ToolId };
export type { Selection } from "../state/selectionInfo";
export type { ScheduleKind, ScheduleRow } from "../export/exportSchedule";

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Liest den Host-Context und verengt ihn auf `PanelHostValue`. Wirft, wenn das
 * Panel außerhalb eines Providers gerendert wird — das ist immer ein
 * Programmierfehler im Rahmen und soll laut scheitern statt still „leer"
 * anzuzeigen.
 */
export function usePanelHost(): PanelHostValue {
  const host = useContext(PanelHostContext);
  if (host === null) {
    throw new Error(
      "usePanelHost: außerhalb von <PanelHostContext.Provider> verwendet.",
    );
  }
  return host as unknown as PanelHostValue;
}
