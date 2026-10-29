// Aussenbemassung ([81]) — Sofort-Befehl ohne Punkt-Eingabe: erzeugt für das aktive Geschoss
// die Massketten (Öffnungen, Vor-/Rücksprünge, Gesamtmass) je Gebäudeseite
// (Kern: `auto_dimensions.rs`, Elemente `cmd_draw.rs`). Ein erneuter Aufruf ersetzt die zuvor automatisch erzeugten
// Ketten DIESES Geschosses (feste IDs), von Hand gezeichnete Bemassungen bleiben.

import { createMutation, createPreview } from "../createCore";
import type { Command, CommandContext, CommandResult, CommandState } from "../types";


const done = (): [CommandState, CommandResult] => [
  { phase: "idle", lastPoint: null },
  { draft: null, done: true },
];

export const autodimCommand: Command = {
  name: "autodim",
  labelKey: "cmd.autodim.label",
  prompt: () => "cmd.autodim.label",
  accepts: () => [],
  options: () => [],
  init: (): CommandState => ({ phase: "idle", lastPoint: null }),

  autoRun: (ctx: CommandContext): CommandResult => {
    if (ctx.level.kind !== "floor") return { draft: null, done: true };
    // Ketten im Kern (`cmd_draw.rs`, `auto_dimensions.rs`); ohne Ketten (keine Wände) kein Commit.
    if (!createPreview(ctx, { cmd: "autodim" }, []).ok) return { draft: null, done: true };
    return { draft: null, done: true, commit: createMutation(ctx, { cmd: "autodim" }) };
  },

  onInput: (): [CommandState, CommandResult] => done(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
