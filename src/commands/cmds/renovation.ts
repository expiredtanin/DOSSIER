// [271] Befehl „Umbau-Status setzen …“ (`renovation`, Kürzel `umbau`): setzt den Umbau-Status der gewählten Bauteile —
// Bestand, Abbruch oder Neu (Optionen B/A/N) — in einem Undo-Schritt. Die Etappe bleibt; sie stellt die Objekt-Info ein.
// Ohne Auswahl startet der Befehl nicht (Hinweis).

import { opsMutation, setRenovationOps } from "../../core";
import type { RenovationStatus } from "../../model/types";
import type { CmdOption, Command, CommandContext, CommandResult, CommandSelection, CommandState } from "../types";

/** Gewählte Bauteile mit Umbau-Status (Wände, Öffnungen, Decken, Dächer, Treppen, Räume, Stütze, Körper). */
export function renovationSelectionIds(sel: CommandSelection): string[] {
  return [
    ...sel.wallIds,
    ...(sel.openingIds ?? []),
    ...(sel.ceilingIds ?? []),
    ...(sel.roofIds ?? []),
    ...(sel.stairIds ?? []),
    ...(sel.roomIds ?? []),
    ...(sel.columnId ? [sel.columnId] : []),
    ...(sel.extrudedSolidId ? [sel.extrudedSolidId] : []),
  ];
}

const STATUS_OPTIONS: Array<{ id: RenovationStatus; key: string; labelKey: CmdOption["labelKey"] }> = [
  { id: "existing", key: "B", labelKey: "renovation.status.existing" },
  { id: "demolish", key: "A", labelKey: "renovation.status.demolish" },
  { id: "new", key: "N", labelKey: "renovation.status.new" },
];

const idle = (): CommandState => ({ phase: "pick", lastPoint: null });
const done = (commit?: CommandResult["commit"]): [CommandState, CommandResult] => [idle(), { draft: null, done: true, ...(commit ? { commit } : {}) }];

export const renovationCommand: Command = {
  name: "renovation",
  labelKey: "cmd.renovation.label",
  prompt: () => "cmd.renovation.prompt",
  accepts: () => ["option"],
  options: () => STATUS_OPTIONS.map((o) => ({ id: o.id, labelKey: o.labelKey, key: o.key })),
  precondition: (ctx: CommandContext) => (renovationSelectionIds(ctx.selection).length === 0 ? "cmd.renovation.needsSelection" : null),
  init: idle,

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const id = input.kind === "option" ? input.id : input.kind === "text" ? input.text.trim().toLowerCase() : "";
    const hit = STATUS_OPTIONS.find((o) => o.id === id || o.key.toLowerCase() === id);
    if (!hit) return [state, { draft: null }];
    const ids = renovationSelectionIds(ctx.selection);
    if (ids.length === 0) return done();
    return done(opsMutation((p) => setRenovationOps(p, ids, hit.id)));
  },
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
