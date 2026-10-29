// Z-Anordnen von Listen mit `id` im Rust-Kern ([K4] S3, `src-tauri/core/src/reorder.rs`): dieselbe Rechnung
// für 2D-Zeichnungen (Zeichenreihenfolge im Grundriss) und Zeichnungsebenen. Der Kern liefert die neue
// Reihenfolge als Indizes, die Elemente behalten ihre Objekt-Identität.

import { core } from "../engine/coreWasm";

/** Anordnen: ans Ende / an den Anfang / eine Stelle vor / eine Stelle zurück. */
export type ReorderOp = "front" | "back" | "forward" | "backward";

/**
 * Ordnet die gewählten Elemente neu an (`ids` sind die gewählten ids; unbekannte zählen nicht). Ohne
 * Treffer kommt dieselbe Liste zurück. Kein Umlauf an den Listengrenzen; gewählte Nachbarn überholen
 * sich bei „forward"/„backward" nicht.
 */
export function reorderByIds<T extends { id: string }>(list: T[], ids: string[], op: ReorderOp): T[] {
  const out = core().reorder_call(JSON.stringify(list.map((e) => e.id)), JSON.stringify(ids), op);
  if (out === "") throw new Error("Kern: Z-Anordnen fehlgeschlagen");
  const order = JSON.parse(out) as number[] | null;
  return order === null ? list : order.map((i) => list[i]);
}
