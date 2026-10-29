// NUR für Tests: Ops, die `prev` in `next` überführen (je Feld `fieldOps`, Listen elementweise).
// Die App erzeugt Änderungen direkt als Ops ([K4] S3, `opsBuild.ts`) und lädt ganze Projekte über
// den Kern (`loadProject`/`openProjectFile`, S4); eine Projekt-Differenz gibt es dort nicht mehr. Die
// Tests brauchen sie, um beliebige Zufallsänderungen als Ops an den Kern zu geben.

import type { Project } from "../model/types";
import type { CoreOp } from "./ops";
import { fieldOps } from "./opsBuild";

export function projectDiffOps(prev: Project, next: Project): CoreOp[] {
  if (prev === next) return [];
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const ops: CoreOp[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key]) ops.push(...fieldOps(prev, key as keyof Project, b[key] as never));
  }
  return ops;
}
