// Besitzer-Index über die Primitive eines Plans: welche Primitive gehören zu
// Wand/Decke/Raum/Zeichnung/…-ID X? Die Auswahl-Hervorhebung in PlanView hat
// das bisher mit je einem `plan.primitives.filter(...)` PRO Elementart gelöst —
// zehn Durchgänge über alle Primitive bei jeder Plan-Änderung (bei einem
// Kataster-Import 3,7 Mio. → ~300 ms pro Änderung). Der Index braucht EINEN
// Durchgang je Plan; danach kostet jede Abfrage nur die Treffer.

import type { Primitive } from "../generatePlan";

export const OWNER_FIELDS = [
  "wallId",
  "drawingId",
  "ceilingId",
  "openingId",
  "stairId",
  "roomId",
  "roofId",
  "contextObjectId",
  "sectionLineId",
  "extrudedSolidId",
  "columnId",
] as const;
export type OwnerField = (typeof OWNER_FIELDS)[number];

export type OwnerIndex = Record<OwnerField, Map<string, number[]>>;

export function buildOwnerIndex(prims: readonly Primitive[]): OwnerIndex {
  const index = Object.fromEntries(OWNER_FIELDS.map((f) => [f, new Map<string, number[]>()])) as OwnerIndex;
  const add = (field: OwnerField, id: string, i: number) => {
    const m = index[field];
    const list = m.get(id);
    if (list) list.push(i);
    else m.set(id, [i]);
  };
  for (let i = 0; i < prims.length; i++) {
    const rec = prims[i] as unknown as Record<OwnerField, unknown>;
    // Schnellpfad: Primitive aus 2D-Zeichnungen (der Massenfall) tragen NUR eine
    // drawingId, nie eine andere Besitzer-ID (s. generatePlan/drawing2d.ts).
    const did = rec.drawingId;
    if (typeof did === "string") {
      add("drawingId", did, i);
      continue;
    }
    for (const f of OWNER_FIELDS) {
      const v = rec[f];
      if (typeof v === "string") add(f, v, i);
    }
  }
  return index;
}

/** Primitive, deren `field` in `ids` liegt — in Plan-Reihenfolge (wie `filter`). */
export function ownedBy(
  index: OwnerIndex,
  prims: readonly Primitive[],
  field: OwnerField,
  ids: Iterable<string>,
): Primitive[] {
  const hits: number[] = [];
  for (const id of ids) {
    const list = index[field].get(id);
    if (list) for (const i of list) hits.push(i);
  }
  hits.sort((a, b) => a - b);
  return hits.map((i) => prims[i]);
}
