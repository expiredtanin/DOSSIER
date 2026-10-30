// Gaube/Lukarne ([G5]) als Engine-Befehl: ein Klick in eine geneigte Dachfläche setzt die Gaube mit der
// Mitte ihrer Stirn an den Punkt (Breite 2.4 m, Stirnhöhe 1.5 m) und ein Fenster in die Stirn. Art als
// Inline-Option (Schlepp/Sattel/Flach/Walm). Kern: `cmd_solid.rs::dormer_ops`, Geometrie `dormer.rs`,
// Verschneidung mit dem Hauptdach `roof_assembly.rs`.

import { createMutation, xy } from "../createCore";
import type { CmdOption, Command, CommandResult, CommandState } from "../types";

const KIND_OPTIONS: CmdOption[] = [
  { id: "schlepp", labelKey: "cmd.dormer.opt.schlepp" },
  { id: "sattel", labelKey: "cmd.dormer.opt.sattel" },
  { id: "flach", labelKey: "cmd.dormer.opt.flach" },
  { id: "walm", labelKey: "cmd.dormer.opt.walm" },
];
const KIND_IDS = new Set(KIND_OPTIONS.map((o) => o.id));

interface DormerState extends CommandState {
  phase: "start";
  kind: string;
}

const idle = (kind = "schlepp"): [CommandState, CommandResult] => [
  { phase: "start", kind, lastPoint: null } as DormerState,
  { draft: null, done: true },
];

export const dormerCommand: Command = {
  name: "dormer",
  labelKey: "cmd.dormer.label",
  floorOnly: true,
  prompt: () => "cmd.dormer.start",
  accepts: () => ["point", "option"],
  options: () => KIND_OPTIONS,
  init: (): DormerState => ({ phase: "start", kind: "schlepp", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as DormerState;
    if (input.kind === "option" && KIND_IDS.has(input.id)) {
      return [{ ...s, kind: input.id } as DormerState, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    return [
      { ...s, lastPoint: input.point } as DormerState,
      { draft: null, commit: createMutation(ctx, { cmd: "dormer", p: xy(input.point), kind: s.kind }) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => [
    state,
    { draft: { preview: [{ kind: "poly", pts: [point], closed: false }], vertices: [point] } },
  ],

  onConfirm: (state): [CommandState, CommandResult] => idle((state as DormerState).kind),
  onCancel: (state): [CommandState, CommandResult] => idle((state as DormerState).kind),
};
