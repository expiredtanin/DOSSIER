// Bemassung lösen ([38]) — entfernt die Bezüge der gewählten Bemassungen auf Modell-Elemente
// (assoziative Bemassung, `dim_assoc.rs`): die Punkte bleiben, wo sie sind, folgen aber nicht mehr.
// Sofort-Befehl ohne Punkt-Eingabe (wie Auflösen): wirkt auf die bestehende Auswahl.

import { cmdMutation } from "../../core";
import type { Command, CommandContext, CommandResult, CommandState } from "../types";

const done = (): [CommandState, CommandResult] => [
  { phase: "idle", lastPoint: null },
  { draft: null, done: true },
];

export const dimdetachCommand: Command = {
  name: "dimdetach",
  labelKey: "cmd.dimdetach.label",
  prompt: () => "cmd.dimdetach.label",
  accepts: () => [],
  options: () => [],
  init: (): CommandState => ({ phase: "idle", lastPoint: null }),

  autoRun: (ctx: CommandContext): CommandResult => {
    const sel = ctx.selection;
    const ids = sel.drawingIds?.length ? sel.drawingIds : sel.drawingId ? [sel.drawingId] : [];
    if (ids.length === 0) return { draft: null, done: true };
    return { draft: null, done: true, commit: cmdMutation({ cmd: "dimdetach", ids }) };
  },

  onInput: (): [CommandState, CommandResult] => done(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
