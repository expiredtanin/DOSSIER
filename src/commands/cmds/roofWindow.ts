// Dachfenster ([100]) als Engine-Befehl: ein Klick setzt ein Fenster (78 × 118 cm, in der Dachebene
// gemessen) mit seiner Mitte an den Punkt — in das Dach, dessen Umriss den Punkt enthält (Dächer des
// aktiven Geschosses zuerst), sonst als Oberlicht in die Decke des Geschosses. Die Öffnung schneidet
// alle Schichten (Kern: `cmd_solid.rs::roof_window_ops`, Geometrie `opening_shape.rs`).

import { createMutation } from "../createCore";
import type { Command, CommandResult, CommandState } from "../types";

const idle = (): [CommandState, CommandResult] => [{ phase: "start", lastPoint: null }, { draft: null, done: true }];

export const roofWindowCommand: Command = {
  name: "roofwindow",
  labelKey: "cmd.roofWindow.label",
  floorOnly: true,
  prompt: () => "cmd.roofWindow.start",
  accepts: () => ["point"],
  options: () => [],
  init: (): CommandState => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    if (input.kind !== "point") return [state, { draft: null }];
    return [
      { phase: "start", lastPoint: input.point },
      { draft: null, commit: createMutation(ctx, { cmd: "roofWindow", p: input.point }) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => [
    state,
    { draft: { preview: [{ kind: "poly", pts: [point], closed: false }], vertices: [point] } },
  ],

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
