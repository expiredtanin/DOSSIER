// Standard-Bibliothek ([100]–[102]) aus dem Rust-Kern (`src-tauri/core/src/standards.rs`): Baustoffe mit
// SIA-400-Schnittschraffur, Ansichtsfarbe/-schraffur, 3D-Textur und Kennwerten (λ, Rohdichte, VKF-RF),
// Linientypen nach SIA 400 / ISO 128 und Standard-Aufbauten. Hier nur dünne Fassaden: der Kern liefert die
// Ops, die fehlende Einträge anhängen (gleiche id oder gleicher Name gilt als vorhanden).

import type { LayerFunction, OverrideRule, Project } from "./types";
import type { CoreOp } from "../core/ops";
import { applyOps } from "../core/ops";
import { addedItems } from "../core/opsBuild";
import { documentFor, withDocument } from "../core/document";

/** Ops, die die fehlenden Standard-Ressourcen anhängen („Standards laden"); leer, wenn alles da ist. */
export function standardsMergeOps(project: Project): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("standardsMergeOps");
}

/** Projekt mit allen Standard-Ressourcen (für neue Projekte; eigenes, kurzlebiges Dokument, [122]). */
export function withStandards(project: Project): Project {
  return applyOps(project, withDocument(project, () => standardsMergeOps(project)));
}

/** Was „Standards laden" anhängt: Anzahl neuer Einträge je Projekt-Liste (für die Rückmeldung). */
export interface StandardsMergeCounts {
  lineStyles: number;
  hatches: number;
  components: number;
  wallTypes: number;
  ceilingTypes: number;
  roofTypes: number;
  viewTemplates: number;
  /** Symbole (2D-Blöcke, z. B. Deckenleuchte [100]). */
  blockDefs: number;
  /** [33] Override-Bausteine (z. B. „Deckenaufbau weiss"), ausgeschaltet. */
  overrideRules: number;
}

export function standardsMergeCounts(ops: readonly CoreOp[]): StandardsMergeCounts {
  const out: StandardsMergeCounts = { lineStyles: 0, hatches: 0, components: 0, wallTypes: 0, ceilingTypes: 0, roofTypes: 0, viewTemplates: 0, blockDefs: 0, overrideRules: 0 };
  for (const op of ops) {
    const key = op.kind === "add" ? op.collection : op.kind === "setField" ? op.key : null;
    const n = op.kind === "add" ? op.items.length : op.kind === "setField" && Array.isArray(op.value) ? op.value.length : 0;
    if (key && key in out) out[key as keyof StandardsMergeCounts] += n;
  }
  return out;
}

/**
 * [33] Mitgelieferte Override-Regeln (Bausteine für Ansichtsvorlagen, z. B. „Deckenaufbau weiss"): die im
 * Projekt vorhandenen (Standard-Kennung `std-or-…`) und die noch fehlenden aus der Bibliothek.
 */
export function standardOverrideRules(project: Project): OverrideRule[] {
  const present = (project.overrideRules ?? []).filter((r) => r.id.startsWith("std-or-"));
  const missing = addedItems(standardsMergeOps(project), "overrideRules") as OverrideRule[];
  return [...present, ...missing];
}

/** Ein Standard-Eintrag des Projekts, der von der heutigen Bibliothek abweicht („Standards aktualisieren"). */
export interface StandardsChange {
  /** Projekt-Liste (`hatches`, `components`, `wallTypes` …). */
  collection: string;
  id: string;
  name: string;
  /** Namen der Felder, die sich ändern würden. */
  fields: string[];
  /** Name weicht vom Standard ab: vermutlich selbst angepasst (im Dialog abgewählt). */
  renamed: boolean;
}

export interface StandardsUpdatePlan {
  /** Anzahl fehlender Standard-Einträge, die mit angehängt werden. */
  added: number;
  changes: StandardsChange[];
}

/** Schlüssel eines Eintrags in der Auswahl von {@link standardsUpdateOps}. */
export const standardsChangeKey = (c: Pick<StandardsChange, "collection" | "id">): string => `${c.collection}:${c.id}`;

/** Abweichungen der Standard-Einträge vom heutigen Standard (Regel s. `standards.rs`, „Standards aktualisieren"). */
export function standardsUpdatePlan(project: Project): StandardsUpdatePlan {
  return documentFor(project).queryRoot<StandardsUpdatePlan>("standardsUpdatePlan");
}

/** Ops: fehlende Standards anhängen und die gewählten Einträge (`standardsChangeKey`) auf den heutigen Stand bringen. */
export function standardsUpdateOps(project: Project, selected: readonly string[]): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("standardsUpdateOps", JSON.stringify(selected));
}

/** [33] Schichtfunktionen (Werte wie im Rust-Modell, `LayerFunction`), Reihenfolge der Auswahl im Aufbau-Editor. */
export const LAYER_FUNCTIONS: readonly LayerFunction[] = ["structure", "insulation", "screed", "finish", "plaster", "substructure", "membrane", "cladding", "air"];

/**
 * [33] Aus dem Baustoff abgeleitete Schichtfunktion je Bauteil-id (Kern `overrides::component_functions`, über
 * `standards::material_category`); gilt, solange eine Schicht kein eigenes `function` hat. `null` = keine.
 */
export function componentLayerFunctions(project: Project): Record<string, LayerFunction | null> {
  return documentFor(project).query<Record<string, LayerFunction | null>>("componentLayerFunctions");
}
