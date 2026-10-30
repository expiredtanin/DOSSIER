// Standard-Bibliothek ([100]–[102]) aus dem Rust-Kern (`src-tauri/core/src/standards.rs`): Baustoffe mit
// SIA-400-Schnittschraffur, Ansichtsfarbe/-schraffur, 3D-Textur und Kennwerten (λ, Rohdichte, VKF-RF),
// Linientypen nach SIA 400 / ISO 128 und Standard-Aufbauten. Hier nur dünne Fassaden: der Kern liefert die
// Ops, die fehlende Einträge anhängen (gleiche id oder gleicher Name gilt als vorhanden).

import type { Project } from "./types";
import type { CoreOp } from "../core/ops";
import { applyOps } from "../core/ops";
import { documentFor } from "../core/document";

/** Ops, die die fehlenden Standard-Ressourcen anhängen („Standards laden"); leer, wenn alles da ist. */
export function standardsMergeOps(project: Project): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("standardsMergeOps");
}

/** Projekt mit allen Standard-Ressourcen (für neue Projekte). */
export function withStandards(project: Project): Project {
  return applyOps(project, standardsMergeOps(project));
}

/** Was „Standards laden" anhängt: Anzahl neuer Einträge je Projekt-Liste (für die Rückmeldung). */
export interface StandardsMergeCounts {
  lineStyles: number;
  hatches: number;
  components: number;
  wallTypes: number;
  ceilingTypes: number;
  roofTypes: number;
}

export function standardsMergeCounts(ops: readonly CoreOp[]): StandardsMergeCounts {
  const out: StandardsMergeCounts = { lineStyles: 0, hatches: 0, components: 0, wallTypes: 0, ceilingTypes: 0, roofTypes: 0 };
  for (const op of ops) {
    const key = op.kind === "add" ? op.collection : op.kind === "setField" ? op.key : null;
    const n = op.kind === "add" ? op.items.length : op.kind === "setField" && Array.isArray(op.value) ? op.value.length : 0;
    if (key && key in out) out[key as keyof StandardsMergeCounts] += n;
  }
  return out;
}
