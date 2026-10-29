// Transformations-System (Bewegen/Spiegeln/Drehen) auf der Auswahl, im Stil von
// Vectorworks: Geste „Basispunkt → Ziel", Live-Vorschau, und eine Modusleiste
// U/I/O/P, die die Vervielfältigung steuert:
//   U move       — nur das Original transformieren.
//   I copy       — Original bleibt + eine transformierte Kopie.
//   O array      — Original bleibt + N Kopien, je um den vollen Schritt versetzt.
//   P distribute — Original bleibt + N Kopien gleichmäßig zwischen Original und Ziel.
//
// Die Rechnung (Abbildung, alle Elementarten, Kopien, Vorschau-Formen) steht im Kern
// (`src-tauri/core/src/cmd_transform.rs`, [K4] S3); hier die Typen, die Fassade und das Dreh-Gizmo.

import type { Project, Vec2 } from "../model/types";
import type { DraftShape } from "./types";
import { uniqueStamp } from "./types";
import { decodeShapes, pair } from "./coreCmd";
import type { CommandSelection } from "../commands/types";
import { applyOps } from "../core";
import type { CoreOp, ProjectMutation } from "../core";
import { cmdMutation, documentFor } from "../core/document";
import { DEFAULT_SCALE_DENOMINATOR } from "../model/dimension";
import { contentFontBaselineFromTop, TEXT_LINE_HEIGHT_MULT } from "../text/fontMetrics";

export type TransformOp = "move" | "rotate" | "mirror" | "scale";
export type CopyMode = "move" | "copy" | "array" | "distribute"; // U / I / O / P

/** Welche Auswahl transformiert wird. */
export interface TransformSelection {
  wallIds: string[];
  /**
   * Einzeln gewähltes 2D-Element (Legacy-Feld, s. `CommandSelection.drawingId`).
   * `drawingIds` (Mehrfachauswahl) wird bevorzugt ausgewertet; beide zusammen
   * ergeben die MENGE der zu transformierenden 2D-Elemente (Union, dedupliziert).
   */
  drawingId: string | null;
  /** ALLE gewählten 2D-Elemente (Mehrfachauswahl) — s. `CommandSelection.drawingIds`. */
  drawingIds?: string[];
  /** Gewählter extrudierter Körper (truck-Integration); nur move.ts setzt ihn. */
  extrudedSolidId?: string | null;
  /** Gewählte Stütze (Tragwerk); von move/copy/mirror gesetzt. */
  columnId?: string | null;
  /** Gewählte Decken (Mehrfachauswahl). */
  ceilingIds?: string[];
  /**
   * Gewählte Dächer (Mehrfachauswahl). Der Umriss ist geometrisch an die
   * Weltachsen gebunden (immer ein Rechteck, First folgt `ridgeAxis` „x"/„y")
   * — Rotate/Mirror würden diese Invariante brechen (First bliebe trotz
   * gedrehtem Umriss achsparallel stehen). `gatherItems` nimmt Dächer daher
   * NUR bei move/scale mit, nicht bei rotate/mirror.
   */
  roofIds?: string[];
  /** Gewählte Treppen (Mehrfachauswahl). */
  stairIds?: string[];
  /** Gewählte Räume (Mehrfachauswahl). */
  roomIds?: string[];
}

/** Auswahl (Befehlskontext) → TransformSelection (gleiche Form, alle Elementarten). */
export function toTransformSel(sel: CommandSelection): TransformSelection {
  return {
    wallIds: sel.wallIds,
    drawingId: sel.drawingId,
    drawingIds: sel.drawingIds,
    extrudedSolidId: sel.extrudedSolidId,
    columnId: sel.columnId,
    ceilingIds: sel.ceilingIds,
    roofIds: sel.roofIds,
    stairIds: sel.stairIds,
    roomIds: sel.roomIds,
  };
}

/** Hat die Auswahl überhaupt etwas Transformierbares? */
export function hasTransformSelection(sel: CommandSelection): boolean {
  return (
    sel.wallIds.length > 0 ||
    sel.drawingId !== null ||
    (sel.drawingIds?.length ?? 0) > 0 ||
    !!sel.extrudedSolidId ||
    !!sel.columnId ||
    (sel.ceilingIds?.length ?? 0) > 0 ||
    (sel.roofIds?.length ?? 0) > 0 ||
    (sel.stairIds?.length ?? 0) > 0 ||
    (sel.roomIds?.length ?? 0) > 0
  );
}

/** Wie viele Klickpunkte die Operation braucht (Drehen = 3, sonst 2). */
export const requiredPoints = (op: TransformOp): number => (op === "rotate" ? 3 : 2);

const pairs = (pts: readonly Vec2[]): [number, number][] => pts.map(pair);

/** Vorschau-Formen einer Transformation aus dem Kern (Zeichnungen über die Plan-Primitive). */
function previewShapes(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: readonly Vec2[],
  mode: CopyMode,
  count: number,
  opts: { ignoreLock?: boolean; scale?: number } = {},
): DraftShape[] {
  const req = {
    cmd: "transform",
    sel,
    op,
    pts: pairs(pts),
    mode,
    count,
    ignoreLock: !!opts.ignoreLock,
    scale: opts.scale ?? DEFAULT_SCALE_DENOMINATOR,
    top: contentFontBaselineFromTop(TEXT_LINE_HEIGHT_MULT),
  };
  return decodeShapes(documentFor(project).cmdPreview(req));
}

/** Vorschau eines einzelnen Elements unter einer Verschiebung (Griff-Vorschau; Sperre ohne Wirkung). */
export function areaMovePreview(
  project: Project,
  kind: "ceiling" | "room" | "stair" | "wall",
  id: string,
  delta: Vec2,
): DraftShape[] {
  const sel: TransformSelection = { wallIds: kind === "wall" ? [id] : [], drawingId: null };
  if (kind === "ceiling") sel.ceilingIds = [id];
  if (kind === "room") sel.roomIds = [id];
  if (kind === "stair") sel.stairIds = [id];
  return previewShapes(project, sel, "move", [{ x: 0, y: 0 }, delta], "move", 1, { ignoreLock: true });
}

/** Vorschau einer verschobenen Zeichnung (aufgeschobenes Körper-Verschieben beim Griff-Ziehen). */
export function drawingMovePreview(project: Project, id: string, delta: Vec2, scaleDenominator?: number): DraftShape[] {
  return previewShapes(project, { wallIds: [], drawingId: id }, "move", [{ x: 0, y: 0 }, delta], "move", 1, {
    ignoreLock: true,
    scale: scaleDenominator,
  });
}

/**
 * Vorschau aller transformierten Instanzen (bewegtes Original bei U + alle
 * Kopien). `pts` sind die bisher gesetzten Punkte inkl. Cursor (Länge =
 * requiredPoints).
 */
export function transformPreview(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): DraftShape[] {
  return previewShapes(project, sel, op, pts, mode, count);
}

/** Anzahl Segmente des Radius-Kreises in {@link rotateGizmoShapes} — grob
 * genug für eine flüssige Draft-Vorschau, fein genug, um rund zu wirken. */
const ROTATE_GIZMO_CIRCLE_SEGMENTS = 48;

/**
 * Dreh-Gizmo (ArchiCAD/Vectorworks-Stil, Nutzer-Wunsch „bei Drehen auch eine
 * Darstellung"): eine Linie vom Zentrum zum FESTEN Referenzpunkt (0°-Basis),
 * eine Linie vom Zentrum zum aktuellen Cursor (laufender Winkel) und ein
 * Kreis mit Radius = Abstand Zentrum→Referenzpunkt. Der Kreis besteht bewusst
 * aus einzelnen `"line"`-Segmenten statt EINES geschlossenen `"poly"` — Letzeres
 * rendert im 2D-SVG-Overlay (`plan/planView/overlays.tsx`) IMMER gefüllt
 * (`.tool-preview-fill`, auch bei `closed:false` — ein `<polygon>` kennt keine
 * offene Variante) und wäre optisch nicht mehr von der transformierten
 * Vorschau-Kontur (ebenfalls oft eine gefüllte Fläche) zu unterscheiden; als
 * Liniensegmente bleibt der Kreis ein dünner Ring (`.tool-preview-line`).
 * Läuft über denselben `draft.preview`-Kanal wie die transformierte
 * Vorschau-Kontur (App.tsx `transformMove` hängt das Ergebnis an), zeichnet
 * sich also automatisch in BEIDEN Ansichten (2D-SVG-Overlay UND 3D-Weltraum-
 * Linien, s. `plan/toWalls3d.ts::draftWorldLines`) — kein eigener Render-Pfad
 * nötig. Leeres Array, wenn Zentrum und Referenzpunkt zusammenfallen (kein
 * Radius).
 */
export function rotateGizmoShapes(center: Vec2, refPoint: Vec2, cursor: Vec2): DraftShape[] {
  const radius = Math.hypot(refPoint.x - center.x, refPoint.y - center.y);
  if (radius < 1e-6) return [];
  const circle: Vec2[] = [];
  for (let i = 0; i < ROTATE_GIZMO_CIRCLE_SEGMENTS; i++) {
    const a = (i / ROTATE_GIZMO_CIRCLE_SEGMENTS) * Math.PI * 2;
    circle.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
  }
  const shapes: DraftShape[] = [
    { kind: "line", a: center, b: refPoint },
    { kind: "line", a: center, b: cursor },
  ];
  for (let i = 0; i < circle.length; i++) {
    shapes.push({ kind: "line", a: circle[i], b: circle[(i + 1) % circle.length] });
  }
  return shapes;
}

// ── Commit ───────────────────────────────────────────────────────────────────

/** Kern-Anfrage einer Transformation (neue ids: `prefix-Stempel-k`). */
const transformReq = (sel: TransformSelection, op: TransformOp, pts: readonly Vec2[], mode: CopyMode, count: number) => ({
  cmd: "transform",
  sel,
  op,
  pts: pairs(pts),
  mode,
  count,
  stamp: uniqueStamp(),
});

/**
 * Die Transformation als Ops ([K4] S3, Kern `cmd_transform::transform_ops`): `replace` je bewegtem
 * Original (nur bei „move"), `add` der Kopien je Liste. Gesperrte Elemente bleiben unberührt; Dächer
 * nur bei Verschieben/Skalieren.
 */
export function transformOps(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): CoreOp[] {
  return documentFor(project).cmdOps(transformReq(sel, op, pts, mode, count));
}

/** Wendet die Transformation immutabel auf das Projekt an (Original + Kopien), über {@link transformOps}. */
export function commitTransform(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): Project {
  return applyOps(project, transformOps(project, sel, op, pts, mode, count));
}

/**
 * Wie {@link commitTransform}, als Projekt → Projekt-Funktion mit mitgeführten Ops (`opsMutation`) —
 * für `CommandResult.commit`: `setProject` übergibt die Ops ohne Projekt-Differenz an den Kern.
 */
export function transformMutation(
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): ProjectMutation {
  return cmdMutation(transformReq(sel, op, pts, mode, count));
}
