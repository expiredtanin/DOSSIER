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
  Component,
  ContextObject,
  DrawingLevel,
  HatchStyle,
  LayerCategory,
  LineStyle,
  Project,
  SiaCategory,
  StairShape,
  VerticalAnchor,
  WallReferenceLine,
  WallType,
} from "../model/types";
import type { SnapSettings, ToolId } from "../tools/types";
import type { Selection } from "../state/selectionInfo";

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
  /** Setzt die (Strich-)Farbe der aktuellen Selektion (Wand oder Drawing2D). */
  onSetSelectionColor: (color: string) => void;
  /** Setzt die Strichstärke (mm) — wirkt NUR auf Drawing2D (sonst No-op). */
  onSetSelectionWeight: (weightMm: number) => void;
  /** Setzt/entfernt die Füllschraffur — wirkt NUR auf Drawing2D (sonst No-op). */
  onSetSelectionFill: (hatchId: string | null) => void;
  /**
   * Setzt/entfernt die Vollton-Füllfarbe — wirkt NUR auf Drawing2D (sonst No-op).
   * `null` entfernt die Füllfarbe (Fläche wieder transparent).
   */
  onSetSelectionFillColor: (color: string | null) => void;
  /**
   * Skaliert die Selektion auf Zielbreite×-höhe (Meter) um einen Anker
   * (fx/fy ∈ [0,1] relativ zur bbox; 0,0 = oben-links … 1,1 = unten-rechts).
   */
  onResizeSelection: (
    w: number,
    h: number,
    anchor: { fx: number; fy: number },
  ) => void;

  // ── Wand-Attribute (Object-Info-Panel; wirken NUR auf die selektierte Wand) ─
  /** Setzt die Lage der Wandachse über die Dicke (außen/mitte/innen). */
  onSetWallReferenceLine: (ref: WallReferenceLine) => void;
  /** Weist der Wand einen Wandtyp-Preset (mehrschichtiger Aufbau) zu. */
  onSetWallType: (wallTypeId: string) => void;
  /** Setzt die Gesamtdicke einer einschichtigen Wand (Meter). */
  onSetWallThickness: (thickness: number) => void;
  /** Setzt/entfernt die UK-Bindung (`null` = Geschoss-Default). */
  onSetWallBottom: (anchor: VerticalAnchor | null) => void;
  /** Setzt/entfernt die OK-Bindung (`null` = UK + height). */
  onSetWallTop: (anchor: VerticalAnchor | null) => void;

  // ── Decken-Attribute (Object-Info-Panel; wirken NUR auf die selektierte Decke) ─
  /** Weist der Decke einen Aufbau-Typ-Preset zu (wie WallType). */
  onSetCeilingType: (wallTypeId: string) => void;
  /** Setzt die Gesamtdicke der Decke (Meter, thickness-Übersteuerung). */
  onSetCeilingThickness: (thickness: number) => void;
  /** Setzt/entfernt die OK-Bindung der Decke (`null` = Geschoss-Oberkante). */
  onSetCeilingTop: (anchor: VerticalAnchor | null) => void;

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

  // ── Raum-Attribute (Object-Info-Panel; nur der selektierte Raum) ────────
  /** Setzt den Raum-Namen. */
  onSetRoomName: (name: string) => void;
  /** Setzt die SIA-416-Blatt-Kategorie des Raums. */
  onSetRoomSia: (category: SiaCategory) => void;
  /** Öffnet den Rich-Text-Editor des Raum-Stempels (per ID). */
  onEditRoomStamp: (roomId: string) => void;

  // ── Site-/Kontext-Schicht (SitePanel) ───────────────────────────────────
  /** Aktuelle Kontext-Objekte (Meshes/Konturen/Gelände) aus `project.context`. */
  contextObjects: ContextObject[];
  /** Fügt mehrere Kontext-Objekte hinzu (z. B. aus einem DXF-Import). */
  onAddContextObjects: (objs: ContextObject[]) => void;
  /** Entfernt ein Kontext-Objekt per ID. */
  onRemoveContextObject: (id: string) => void;
  /**
   * Erzeugt aus einem ContourSet (per ID) ein Gelände-TIN. Liefert die neue
   * TerrainMesh-ID oder null (unbekannte ID / kein sinnvolles TIN).
   */
  onGenerateTerrain: (contourSetId: string) => string | null;
  /** Öffnet den (in App montierten) versteckten DXF-Datei-Dialog. */
  onImportDxf: () => void;
}

// Re-Export der Modelltypen, die die Panels im selben Atemzug brauchen — so
// importieren Panels nur aus „./host" und bleiben auf einen Pfad fokussiert.
export type { DrawingLevel, LayerCategory };
export type { SnapSettings, ToolId };
export type { Selection } from "../state/selectionInfo";

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
