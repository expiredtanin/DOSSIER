// [287] (6) Objekt-Info bei Mehrfachauswahl (Vectorworks-Muster): die Klasse im Kopf gilt für ALLE gewählten Elemente,
// ein Undo-Schritt; dazu die Zusammenfassung „3 Elemente (2 Wände, 1 Tür)“ für den Kopf.

import type { CoreOp } from "../core";
import { patchItems } from "../core";
import type { Project } from "../model/types";
import type { Selection } from "./selection";

/** Auswahl-Art → Sammlungen im Projekt (der Kanal „columns“ trägt Stützen UND Träger). */
const KIND_COLLECTIONS = [
  ["walls", ["walls"]],
  ["drawings", ["drawings2d"]],
  ["ceilings", ["ceilings"]],
  ["openings", ["openings"]],
  ["stairs", ["stairs"]],
  ["rooms", ["rooms"]],
  ["solids", ["extrudedSolids"]],
  ["columns", ["columns", "beams"]],
  ["roofs", ["roofs"]],
  ["contextObjects", ["context"]],
  ["trees", ["trees"]],
  ["cameras", ["cameras"]],
  ["railings", ["railings"]],
] as const;

/** Ops: Klasse `code` für jedes gewählte Element (ohne Änderung, wo sie schon gilt). */
export function categoryOpsForSelection(p: Project, sel: Selection, code: string): CoreOp[] {
  const ops: CoreOp[] = [];
  for (const [kind, collections] of KIND_COLLECTIONS) {
    const ids = sel[kind];
    if (!ids?.length) continue;
    for (const col of collections) ops.push(...patchItems(p, col, ids, (e) => ({ ...e, categoryCode: code })));
  }
  return ops;
}

/** Anzahl gewählter Modell-Elemente je Auswahl-Art (ohne Gruppen, Schnittlinien, Lage-Darstellung). */
export function selectionCounts(sel: Selection): { kind: (typeof KIND_COLLECTIONS)[number][0]; n: number }[] {
  return KIND_COLLECTIONS.map(([kind]) => ({ kind, n: sel[kind]?.length ?? 0 })).filter((x) => x.n > 0);
}
