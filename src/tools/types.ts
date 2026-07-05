// Tool-System für das aktive Zeichnen im Grundriss (docs/design/drawing-tools.md).
//
// Werkzeuge sind reine Funktionen über einen internen `ToolState`
// (Discriminated Union je Werkzeug). Sie greifen NUR über `commit(project)`
// immutabel auf das Modell zu und schreiben nie Plan-Primitive — die Ansicht
// bleibt abgeleitet. Bezeichner englisch, UI-Text via t().

import type { DrawingLevel, Project, Vec2 } from "../model/types";

/** Werkzeug-Identität. */
export type ToolId =
  | "select"
  | "wall"
  | "ceiling"
  | "window"
  | "door"
  | "stair"
  | "room"
  | "line"
  | "polyline"
  | "rect"
  | "circle";

// ── Snapping ───────────────────────────────────────────────────────────────

export type SnapKind =
  | "endpoint"
  | "midpoint"
  | "intersection"
  | "center"
  | "quadrant"
  | "onEdge"
  | "grid"
  | "ortho"
  | "extension";

export interface SnapResult {
  /** Gefangener Punkt (Meter). */
  point: Vec2;
  kind: SnapKind;
  /** Quell-Bezugspunkt (für Hilfslinien bei ortho/extension), optional. */
  refA?: Vec2;
  /** Bildschirm-Distanz Cursor→Snap (px) — für die Auswahl des Besten. */
  distPx: number;
}

export interface SnapSettings {
  enabled: boolean;
  endpoint: boolean;
  midpoint: boolean;
  intersection: boolean;
  center: boolean;
  onEdge: boolean;
  grid: boolean;
  /** Rasterweite in Metern. */
  gridSize: number;
  /** Ortho/Winkelraster (Shift erzwingt zusätzlich). */
  ortho: boolean;
  /** Winkelraster in Grad (z. B. 90 = H/V). */
  angleStep: number;
  /** Fangradius am Bildschirm in Pixeln. */
  tolerancePx: number;
}

/** Default-Snap-Einstellungen (endpoint/midpoint/intersection/onEdge + grid). */
export const DEFAULT_SNAP: SnapSettings = {
  enabled: true,
  endpoint: true,
  midpoint: true,
  intersection: true,
  center: false,
  onEdge: true,
  grid: true,
  gridSize: 0.1,
  ortho: false,
  angleStep: 90,
  tolerancePx: 12,
};

// ── Werkzeug-Schnittstelle ──────────────────────────────────────────────────

/** Live-Kontext, den ein Werkzeug bei jedem Schritt erhält. */
export interface ToolContext {
  project: Project;
  /** Aktives Geschoss/die aktive Zeichnungsebene (Ziel der neuen Elemente). */
  level: DrawingLevel;
  /** Default-Kategorie-Code für neue Elemente. */
  defaultCategoryCode: string;
  /** Aktiver Wandtyp für das Wand-Werkzeug. */
  activeWallTypeId: string;
  /** Aktiver Linienstil-Code für 2D-Primitive. */
  activeLineStyleId: string;
}

/** Ein an einer Modellposition ausgelöstes Pointer-Ereignis (fertig gesnappt). */
export interface ToolPointer {
  /** Roher Modellpunkt (vor Snapping), in Metern. */
  raw: Vec2;
  /** Gesnappter Punkt + Marker-Info; null = kein Snap. */
  snap: SnapResult | null;
  /** Effektiver Punkt = snap?.point ?? raw. */
  point: Vec2;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** 0 = links, 2 = rechts. */
  button: number;
}

/**
 * Leichte Vorschau-Form (Rubber-Band). Bewusst NICHT der volle `Primitive`-Typ
 * (kein HatchRender nötig); PlanView zeichnet sie mit einer Vorschau-CSS-Klasse
 * (gestrichelt, Akzentfarbe). Modell-Meter; PlanView projiziert via toScreen.
 */
export type DraftShape =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "poly"; pts: Vec2[]; closed?: boolean };

/** Darstellbare Vorschau (Rubber-Band). */
export interface ToolDraft {
  /** Vorschau-Formen (gestrichelt/halbtransparent gezeichnet). */
  preview: DraftShape[];
  /** Bereits gesetzte „feste" Stützpunkte (kleine Quadrate). */
  vertices: Vec2[];
  /** Aktiver Snap (für den Bildschirm-Marker), optional. */
  snap?: SnapResult | null;
  /** Optionaler Maß-/Winkel-Text am Cursor (z. B. „3.20 m · 90°"). */
  hud?: { at: Vec2; text: string };
}

/** Was ein Werkzeug-Schritt nach außen meldet. */
export interface ToolResult {
  /** Neuer Vorschau-Zustand; null = nichts zu zeigen. */
  draft: ToolDraft | null;
  /** Bei Abschluss: Mutation, die App über setProject anwendet. */
  commit?: (p: Project) => Project;
  /** true → Werkzeug ist fertig und kehrt in seinen Ruhezustand zurück. */
  done?: boolean;
}

/**
 * Interner Zustand eines Werkzeugs. Basis-Form; jedes Werkzeug verfeinert sie zu
 * einer eigenen Discriminated Union (z. B. WallState) und castet beim Eintritt.
 */
export interface ToolState {
  phase: string;
}

/** Die Werkzeug-Schnittstelle (reine Funktionen über einen internen State). */
export interface Tool {
  id: ToolId;
  /** UI-Label-Key (i18n), z. B. „tool.wall". */
  labelKey: string;
  /** Statuszeilen-Hinweis-Key je Phase. */
  hintKey: (state: ToolState) => string;
  /** Nur auf Geschossen aktiv? (Wand braucht ein Geschoss.) */
  floorOnly?: boolean;
  /** Initialer Ruhezustand. */
  init(): ToolState;
  /** Klick (Punkt setzen). */
  onClick(state: ToolState, p: ToolPointer, ctx: ToolContext): [ToolState, ToolResult];
  /** Bewegung (Hover/Drag): nur Vorschau, nie Commit. */
  onMove(state: ToolState, p: ToolPointer, ctx: ToolContext): [ToolState, ToolResult];
  /** Doppelklick/Enter/Rechtsklick: mehrteilige Werkzeuge abschließen. */
  onCommitGesture(state: ToolState, ctx: ToolContext): [ToolState, ToolResult];
  /** Esc: Entwurf verwerfen, im selben Werkzeug bleiben. */
  onCancel(state: ToolState): [ToolState, ToolResult];
  /** Backspace: letzten gesetzten Punkt zurücknehmen (optional). */
  onUndoPoint?(state: ToolState, ctx: ToolContext): [ToolState, ToolResult];
}

// ── PlanView-Brücke ──────────────────────────────────────────────────────────
// PlanView meldet rohe Modellpunkte + die aktuelle Pixel/Meter-Skala nach oben;
// der ToolController (App) snappt, fährt das Werkzeug und hält den `draft`,
// den PlanView als Overlay zeichnet. So bleibt die Snap-/Modell-Logik außerhalb
// der reinen Darstellungs-/Eingabeschicht.

export interface ToolMods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface ToolHandlers {
  /** Hover/Drag: roher Modellpunkt (Meter) + Pixel/Meter + Modifikatoren. */
  onToolMove(raw: Vec2, pxPerMeter: number, mods: ToolMods): void;
  /** Klick (Punkt setzen). */
  onToolClick(raw: Vec2, pxPerMeter: number, mods: ToolMods): void;
  /** Doppelklick / Rechtsklick: mehrteiliges Werkzeug abschließen. */
  onToolCommit(): void;
  /** Aktuelle Vorschau (vom Controller gehalten). */
  draft: ToolDraft | null;
}

// ── ID-Vergabe ───────────────────────────────────────────────────────────────

let idCounter = 0;
/** Neue eindeutige ID, konsistent mit der Praxis in App (`prefix-Date-counter`). */
export function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}
