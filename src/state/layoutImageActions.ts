// Bilder aufs Layout-Blatt setzen ([208]): aus dem Rendering-Dialog („Ins Layout einsetzen"), später auch für
// Fotos. Reine Ops-Bildung (`placeImageOps`) getrennt vom Store-Aufruf, damit sie ohne DOM testbar ist.

import { patchItem, type CoreOp } from "../core";
import type { Layout, Project } from "../model/types";
import { addImage, createLayoutImage } from "../model/layoutImages";
import { effectiveSheetSizeMm, findMaster, sheetLevelOf } from "../model/layoutModel";
import { getState } from "./appStore";

/** Blatt, das beim Einsetzen vorgewählt ist: das Blatt der aktiven Ebene (offenes Layout), sonst das letzte. */
export function defaultTargetLayout(project: Pick<Project, "layouts" | "drawingLevels">, activeLevelId: string): Layout | undefined {
  const layouts = project.layouts ?? [];
  const level = project.drawingLevels.find((l) => l.id === activeLevelId);
  return layouts.find((l) => l.id === level?.layoutId) ?? layouts[layouts.length - 1];
}

/**
 * Ops, die `bytes` (PNG/JPEG) mittig und im Seitenverhältnis auf das Blatt `layoutId` setzen; `null`, wenn das Blatt
 * fehlt oder die Bytes kein PNG/JPEG sind. `id` ist die Bild-Id (Aufrufer: Zeitstempel).
 */
export function placeImageOps(project: Project, layoutId: string, name: string, bytes: Uint8Array, id: string, mime = "image/png"): CoreOp[] | null {
  const layout = (project.layouts ?? []).find((l) => l.id === layoutId);
  if (!layout) return null;
  const image = createLayoutImage(id, name, bytes, effectiveSheetSizeMm(findMaster(project, layout) ?? layout), mime);
  if (!image) return null;
  return patchItem(project, "layouts", layoutId, (l) => addImage(l, image));
}

/** Setzt das Bild auf das Blatt (ein Undo-Schritt); `false`, wenn nichts eingesetzt werden konnte. */
export function placeImageOnLayout(layoutId: string, name: string, bytes: Uint8Array, mime = "image/png"): boolean {
  const st = getState();
  const ops = placeImageOps(st.project, layoutId, name, bytes, `img-${Date.now()}`, mime);
  if (!ops) return false;
  st.applyChange(ops);
  return true;
}

/** Blatt-Ebene eines Layouts (für „Blatt öffnen" nach dem Einsetzen). */
export function layoutSheetLevelId(project: Project, layoutId: string): string | undefined {
  return sheetLevelOf(project, layoutId)?.id;
}
