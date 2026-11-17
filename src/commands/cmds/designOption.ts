// [272] Befehle „Variante zuweisen …“ (`designOption`, Kürzel `variante`) und „In Variante kopieren …“
// (`designOptionCopy`, Kürzel `variantekopieren`): die gewählten Elemente gehören danach der Variante (bzw. Kopien davon) —
// in einem Undo-Schritt. Ziel getippt als „Dachform=B“, als Variantenname („B Satteldach“, eindeutig über alle Sätze) oder
// als Nummer der Liste „Satz: Variante“ (1, 2, …); Option H = Hauptmodell. Ohne Auswahl oder ohne Variantensatz kein Start.

import { assignDesignOptionOps, copyToDesignOptionOps, designOptionSets, designOptionTargets, opsMutation, parseCombination } from "../../core";
import type { Project } from "../../model/types";
import type { Command, CommandContext, CommandResult, CommandSelection, CommandState } from "../types";
import { renovationSelectionIds } from "./renovation";

/** Gewählte Elemente, die einer Variante angehören können (Bauteile, Räume, 2D-Zeichnungen samt Bibliotheksobjekten). */
export function designOptionSelectionIds(sel: CommandSelection): string[] {
  const drawings = sel.drawingIds ?? (sel.drawingId ? [sel.drawingId] : []);
  return [...renovationSelectionIds(sel), ...drawings];
}

/** Ziel aus getipptem Text: `null` = Hauptmodell, `undefined` = unbekannt. */
export function parseDesignOptionTarget(project: Project, text: string): { set: string; option: string } | null | undefined {
  const q = text.trim().toLowerCase();
  if (!q) return undefined;
  if (q === "h" || q === "haupt" || q === "hauptmodell" || q === "main") return null;
  const targets = designOptionTargets(project);
  const n = Number(q);
  if (Number.isInteger(n) && n >= 1 && n <= targets.length) {
    const [set, option] = targets[n - 1].key.split("/");
    return { set, option };
  }
  if (q.includes("=")) {
    const c = parseCombination(project, q);
    const [set, option] = Object.entries(c)[0] ?? [];
    return set ? { set, option } : undefined;
  }
  // Variantenname oder „Satz: Variante“, eindeutig über alle Sätze.
  const hits: { set: string; option: string }[] = [];
  for (const s of designOptionSets(project)) {
    for (const o of s.options) {
      const name = o.name.trim().toLowerCase();
      if (name === q || o.id.toLowerCase() === q || `${s.name}: ${o.name}`.toLowerCase() === q) hits.push({ set: s.id, option: o.id });
    }
  }
  return hits.length === 1 ? hits[0] : undefined;
}

const idle = (): CommandState => ({ phase: "pick", lastPoint: null });
const done = (commit?: CommandResult["commit"]): [CommandState, CommandResult] => [idle(), { draft: null, done: true, ...(commit ? { commit } : {}) }];

function makeCommand(copy: boolean): Command {
  const key = copy ? "designOptionCopy" : "designOption";
  return {
    name: key,
    labelKey: copy ? "cmd.designOptionCopy.label" : "cmd.designOption.label",
    prompt: () => (copy ? "cmd.designOptionCopy.prompt" : "cmd.designOption.prompt"),
    accepts: () => ["option", "text"],
    options: () => [{ id: "main", labelKey: "designOption.main", key: "H" }],
    precondition: (ctx: CommandContext) => {
      if (!designOptionSets(ctx.project).length) return "cmd.designOption.needsSet";
      return designOptionSelectionIds(ctx.selection).length === 0 ? "cmd.designOption.needsSelection" : null;
    },
    init: idle,

    onInput: (state, input, ctx): [CommandState, CommandResult] => {
      const text = input.kind === "option" ? (input.id === "main" ? "h" : input.id) : input.kind === "text" ? input.text : "";
      const target = parseDesignOptionTarget(ctx.project, text);
      if (target === undefined) return [state, { draft: null }];
      const ids = designOptionSelectionIds(ctx.selection);
      if (ids.length === 0) return done();
      return done(opsMutation((p) => (copy ? copyToDesignOptionOps(p, ids, target) : assignDesignOptionOps(p, ids, target))));
    },
    onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
    onConfirm: (): [CommandState, CommandResult] => done(),
    onCancel: (): [CommandState, CommandResult] => done(),
  };
}

export const designOptionCommand: Command = makeCommand(false);
export const designOptionCopyCommand: Command = makeCommand(true);
