// Standard-Bibliothek ([94]–[96]) aus dem Rust-Kern (`src-tauri/core/src/standards.rs`): Baustoffe mit
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
