// Align / Distribute — richtet die 2D-Auswahl an einer gemeinsamen Kante aus
// bzw. verteilt sie mit gleichen Abständen. Sofort-Befehle ohne Punkt-Eingabe
// (wie Join/Split/Explode): sie wirken auf die bestehende Auswahl, die
// gewünschte Kante/Achse wählt man in der Optionszeile.
//
// Die Modell-Logik liegt in `editors/align.ts`.

import { alignOps, distributeOps } from "../../editors/align";
import { opsMutation } from "../../core";
import type { AlignMode, DistributeAxis } from "../../editors/align";
import type {
  CmdOption,
  Command,
  CommandResult,
  CommandSelection,
  CommandState,
} from "../types";

function selectedDrawingIds(sel: CommandSelection): string[] {
  if (sel.drawingIds && sel.drawingIds.length) return sel.drawingIds;
  return sel.drawingId ? [sel.drawingId] : [];
}

interface AlignState extends CommandState {
  phase: "pick";
}

const ALIGN_OPTIONS: { id: AlignMode; labelKey: CmdOption["labelKey"] }[] = [
  { id: "left", labelKey: "cmd.align.left" },
  { id: "centerX", labelKey: "cmd.align.centerX" },
  { id: "right", labelKey: "cmd.align.right" },
  { id: "top", labelKey: "cmd.align.top" },
  { id: "centerY", labelKey: "cmd.align.centerY" },
  { id: "bottom", labelKey: "cmd.align.bottom" },
];
const DIST_OPTIONS: { id: DistributeAxis; labelKey: CmdOption["labelKey"] }[] = [
  { id: "x", labelKey: "cmd.align.distX" },
  { id: "y", labelKey: "cmd.align.distY" },
];

const done = (): [CommandState, CommandResult] => [
  { phase: "pick", lastPoint: null } as AlignState,
  { draft: null, done: true },
];

export const alignCommand: Command = {
  name: "align",
  labelKey: "cmd.align.label",
  prompt: () => "cmd.align.prompt",
  accepts: () => ["option"],
  options: () => [
    ...ALIGN_OPTIONS.map((o) => ({ id: o.id, labelKey: o.labelKey })),
    ...DIST_OPTIONS.map((o) => ({ id: `dist-${o.id}`, labelKey: o.labelKey })),
  ],
  init: (): AlignState => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    if (input.kind !== "option") return [state, { draft: null }];
    const ids = selectedDrawingIds(ctx.selection);
    if (ids.length === 0) return done();

    if (input.id.startsWith("dist-")) {
      const axis = input.id.slice(5) as DistributeAxis;
      return [
        { phase: "pick", lastPoint: null } as AlignState,
        { draft: null, done: true, commit: opsMutation((p) => distributeOps(p, ids, axis)) },
      ];
    }
    const mode = input.id as AlignMode;
    return [
      { phase: "pick", lastPoint: null } as AlignState,
      { draft: null, done: true, commit: opsMutation((p) => alignOps(p, ids, mode)) },
    ];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
