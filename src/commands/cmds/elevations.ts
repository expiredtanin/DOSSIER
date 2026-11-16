// [267] Ansichten aller Seiten — legt die Ansichten Nord/Ost/Süd/West um das Gebäude an und endet sofort
// (Null-Schritt-Befehl wie `terrain`). Rechnung im Kern (`elevation_set.rs`), Brücke in `commands/elevationSetFor.ts`.

import { elevationSetFor } from "../elevationSetFor";
import type { Command, CommandContext, CommandResult, CommandState } from "../types";

const IDLE: CommandState = { phase: "idle", lastPoint: null };

const run = (ctx: CommandContext): CommandResult => {
  const { commit, notice } = elevationSetFor(ctx.project);
  return { draft: null, done: true, ...(commit ? { commit } : {}), notice };
};

export const elevationsCommand: Command = {
  name: "ansichten",
  labelKey: "cmd.elevations.label",
  prompt: () => "cmd.elevations.prompt",
  accepts: () => [],
  options: () => [],
  init: () => ({ ...IDLE }),
  autoRun: run,
  onInput: (_s, _i, ctx): [CommandState, CommandResult] => [{ ...IDLE }, run(ctx)],
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (_s, ctx): [CommandState, CommandResult] => [{ ...IDLE }, run(ctx)],
  onCancel: (): [CommandState, CommandResult] => [{ ...IDLE }, { draft: null, done: true }],
};
