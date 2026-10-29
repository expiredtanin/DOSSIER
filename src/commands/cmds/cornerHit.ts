// Ecken-Treffer für Verrunden/Fasen ([K4] S3): Treffer und Vorschau rechnet der Kern
// (`src-tauri/core/src/cmd_edit.rs`); der Befehl merkt sich nur Element, Eckpunkt-Index und die Ecke.

import type { Project, Vec2 } from "../../model/types";
import type { DraftShape } from "../types";
import { cmdQuery, decodeShapes, pair } from "../../tools/coreCmd";

/** Getroffene Ecke: Element, Eckpunkt-Index (mit zwei Nachbarn), Lage der Ecke. */
export interface CornerHit {
  id: string;
  index: number;
  corner: Vec2;
}

export type CornerKind = "fillet" | "chamfer";

/**
 * Nächste Ecke einer Polylinie/eines Rechtecks der Ebene zum Punkt (Polylinien mit Bögen ausgenommen)
 * samt Vorschau der Verrundung/Fasung mit `r`.
 */
export function pickCorner(project: Project, levelId: string, pt: Vec2, kind: CornerKind, r: number): { hit: CornerHit | null; preview: DraftShape[] } {
  const res = cmdQuery<{ hit: { id: string; index: number; corner: [number, number] } | null; shapes: number[] }>(project, {
    q: "pickCorner",
    level: levelId,
    pt: pair(pt),
    kind,
    r,
  });
  if (!res.hit) return { hit: null, preview: [] };
  const { id, index, corner } = res.hit;
  return { hit: { id, index, corner: { x: corner[0], y: corner[1] } }, preview: decodeShapes(res.shapes) };
}

/** Vorschau der Verrundung/Fasung einer gemerkten Ecke (leer, wenn sie mit `r` nicht geht). */
export function cornerPreview(project: Project, hit: CornerHit, kind: CornerKind, r: number): DraftShape[] {
  return decodeShapes(cmdQuery<{ shapes: number[] }>(project, { q: "corner", kind, id: hit.id, index: hit.index, r }).shapes);
}
