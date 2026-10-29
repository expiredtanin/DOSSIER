// Brücke der Befehle/Werkzeuge zum Kern ([K4] S3, `src-tauri/core/src/commands.rs`): Vorschau-Formen
// aus flachen Puffern lesen und Abfragen zwischen den Schritten (Treffer, Vorschau) stellen. Die
// Zustandsautomaten bleiben in den Befehlen; gerechnet wird im Kern.

import type { Project, Vec2 } from "../model/types";
import type { DraftShape } from "./types";
import { documentFor } from "../core/document";

/** Punkt als Paar (Anfragen an den Kern). */
export const pair = (p: Vec2): [number, number] => [p.x, p.y];

/**
 * Vorschau-Puffer des Kerns → Formen: je Form `[art, n, x0, y0, …]`, art 0 = Linie (n = 2),
 * 1 = geschlossenes Polygon, 2 = offener Linienzug.
 */
export function decodeShapes(f: ArrayLike<number>): DraftShape[] {
  const out: DraftShape[] = [];
  let i = 0;
  while (i + 1 < f.length) {
    const kind = f[i];
    const n = f[i + 1];
    i += 2;
    const pts: Vec2[] = new Array(n);
    for (let k = 0; k < n; k++, i += 2) pts[k] = { x: f[i], y: f[i + 1] };
    out.push(kind === 0 ? { kind: "line", a: pts[0], b: pts[1] } : { kind: "poly", pts, closed: kind === 1 });
  }
  return out;
}

/** Abfrage eines Befehls zwischen den Schritten (`cmd_edit::query`), auf dem Dokument von `project`. */
export function cmdQuery<T>(project: Project, req: { q: string } & Record<string, unknown>): T {
  return documentFor(project).cmdQuery<T>(req);
}
