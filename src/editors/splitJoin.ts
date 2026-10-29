// Split / Segment löschen für 2D-Zeichenelemente — Fassade über den Kern ([K4] S3,
// `src-tauri/core/src/cmd_split.rs`; Join: `cmd_edit.rs`). Der Kern rechnet auf dem Dokument des
// Projekts und liefert Ops; hier nur die Anfrage und die ids für die Nachauswahl.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project, Vec2 } from "../model/types";
import type { CoreOp } from "../core";
import { documentFor } from "../core/document";
import { uniqueStamp } from "../tools/types";

/**
 * Split der Zeichnungen `ids` an ihren Schnittpunkten mit den übrigen Zeichnungen des Geschosses
 * (ohne Schnitt an der Mitte). Die Stücke ersetzen das Original an seiner Stelle. `selectIds`: die
 * Stücke und die nicht teilbaren gewählten Zeichnungen (Nachauswahl).
 */
export function splitOps(project: Project, ids: readonly string[]): { ops: CoreOp[]; selectIds: string[] } {
  const ops = documentFor(project).cmdOps({ cmd: "split", ids, stamp: uniqueStamp() });
  const removed = new Set<string>();
  const added: string[] = [];
  for (const op of ops) {
    if (op.kind === "remove") for (const id of op.ids) removed.add(id);
    if (op.kind === "add") for (const e of op.items) added.push((e as { id: string }).id);
  }
  const have = new Set(project.drawings2d.map((d) => d.id));
  return { ops, selectIds: [...ids.filter((id) => have.has(id) && !removed.has(id)), ...added] };
}

/**
 * Segment löschen (Alt+Klick): die dem Modellpunkt `at` nächste Kante der Zeichnung `id` fällt weg
 * (geschlossen → offen; Bögen bleiben). Das Element behält id und Attribute; bleiben weniger als
 * zwei Punkte, wird es gelöscht (`removed`).
 */
export function cutSegmentOps(project: Project, id: string, at: Vec2): { ops: CoreOp[]; removed: boolean } {
  const ops = documentFor(project).cmdOps({ cmd: "cutSegment", id, at });
  return { ops, removed: ops.some((op) => op.kind === "remove") };
}
