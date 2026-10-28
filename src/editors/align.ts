// Ausrichten und Verteilen der 2D-Auswahl — reine Modell-Funktionen (wie
// `editors/explode.ts`), damit sie ohne UI testbar bleiben.
//
// Beides arbeitet auf den BOUNDING-BOXEN der Elemente (dieselbe Herleitung wie
// im Attribut-Panel, s. `geomBBox`) und verschiebt sie anschliessend als
// Ganzes. Die Form selbst bleibt unangetastet — es wird nur verschoben, nie
// skaliert oder verzerrt.

import type { Drawing2D, Project, Vec2 } from "../model/types";
import { geomBBox } from "../state/selectionInfo";
import { mvGeom, patchItems } from "../core";
import type { CoreOp } from "../core";

/** Ausrichtungskante bzw. -achse. */
export type AlignMode = "left" | "right" | "centerX" | "top" | "bottom" | "centerY";

/** Verteilungsachse: gleiche Abstände der Mittelpunkte entlang X bzw. Y. */
export type DistributeAxis = "x" | "y";

interface Boxed {
  d: Drawing2D;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxesOf(project: Project, ids: string[]): Boxed[] {
  const wanted = new Set(ids);
  return project.drawings2d
    .filter((d) => wanted.has(d.id))
    .map((d) => ({ d, ...geomBBox(d.geom) }));
}

/** Ops: verschiebt die genannten Elemente um je einen eigenen Vektor. */
function moveBy(project: Project, deltas: Map<string, Vec2>): CoreOp[] {
  if (deltas.size === 0) return [];
  return patchItems(project, "drawings2d", (d) => deltas.has(d.id), (d) => {
    const delta = deltas.get(d.id)!;
    if (delta.x === 0 && delta.y === 0) return d;
    const fn = (p: Vec2): Vec2 => ({ x: p.x + delta.x, y: p.y + delta.y });
    return { ...d, geom: mvGeom(d.geom, fn) };
  });
}

/**
 * Richtet die Elemente an der gemeinsamen Kante bzw. Mittelachse aus. Bezug
 * ist die Hülle ALLER gewählten Elemente (wie in Grafikprogrammen üblich):
 * „linksbündig" schiebt alle an den linkesten Rand der Auswahl.
 *
 * Weniger als zwei Elemente ergeben keine Ausrichtung (nichts, woran man sich
 * ausrichten könnte) — das Projekt bleibt unverändert.
 */
export function alignOps(project: Project, ids: string[], mode: AlignMode): CoreOp[] {
  const boxes = boxesOf(project, ids);
  if (boxes.length < 2) return [];

  const minX = Math.min(...boxes.map((b) => b.minX));
  const maxX = Math.max(...boxes.map((b) => b.maxX));
  const minY = Math.min(...boxes.map((b) => b.minY));
  const maxY = Math.max(...boxes.map((b) => b.maxY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const deltas = new Map<string, Vec2>();
  for (const b of boxes) {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case "left":
        dx = minX - b.minX;
        break;
      case "right":
        dx = maxX - b.maxX;
        break;
      case "centerX":
        dx = cx - (b.minX + b.maxX) / 2;
        break;
      case "top":
        dy = maxY - b.maxY;
        break;
      case "bottom":
        dy = minY - b.minY;
        break;
      case "centerY":
        dy = cy - (b.minY + b.maxY) / 2;
        break;
    }
    deltas.set(b.d.id, { x: dx, y: dy });
  }
  return moveBy(project, deltas);
}

/**
 * Verteilt die Elemente mit GLEICHEN MITTENABSTÄNDEN entlang der Achse. Die
 * beiden äussersten bleiben stehen und spannen den Bereich auf — alles
 * dazwischen rückt auf gleichmässige Abstände.
 *
 * Unter drei Elementen gibt es nichts zu verteilen (die Äusseren bleiben ja
 * ohnehin stehen) — das Projekt bleibt unverändert.
 */
export function distributeOps(project: Project, ids: string[], axis: DistributeAxis): CoreOp[] {
  const boxes = boxesOf(project, ids);
  if (boxes.length < 3) return [];

  const center = (b: Boxed) => (axis === "x" ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2);
  const sorted = [...boxes].sort((a, b) => center(a) - center(b));
  const first = center(sorted[0]);
  const last = center(sorted[sorted.length - 1]);
  const step = (last - first) / (sorted.length - 1);

  const deltas = new Map<string, Vec2>();
  sorted.forEach((b, i) => {
    // Erstes und letztes Element bleiben unangetastet (sie definieren den Bereich).
    if (i === 0 || i === sorted.length - 1) return;
    const target = first + step * i;
    const shift = target - center(b);
    deltas.set(b.d.id, axis === "x" ? { x: shift, y: 0 } : { x: 0, y: shift });
  });
  return moveBy(project, deltas);
}
