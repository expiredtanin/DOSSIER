// Punkt-/Knotenmarker (Nutzer-Wunsch: „Punkt-/Knotenmarker" aus der
// Werkzeug-Lücken-Liste). Einfachster aller Zeichen-Befehle: EIN Klick →
// Kreuz-in-Kreis-Symbol an genau dieser Stelle, keine weiteren Felder
// (analog `detailref.ts`, aber ohne Label/Blattverknüpfung).

import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview } from "../createCore";


interface PointMarkerIdle extends CommandState {
  phase: "point";
}
type PointMarkerState = PointMarkerIdle;

/** Vorschau (Kern, `cmd_draw.rs`): Kreis (r = 0.08 m) mit Kreuz am Cursor. */
function pointDraft(ctx: CommandContext, at: Vec2): ToolDraft {
  return { preview: createPreview(ctx, { cmd: "pointmarker" }, [at]).shapes, vertices: [at] };
}

/** Commit (Kern): Punktmarker am Punkt. */
const appendPointMarker = (at: Vec2, ctx: CommandContext) => createMutation(ctx, { cmd: "pointmarker", at });

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null } as PointMarkerIdle,
  { draft: null, done: true },
];

export const pointmarkerCommand: Command = {
  name: "pointmarker",
  labelKey: "cmd.pointmarker.label",
  prompt: () => "cmd.pointmarker.point",
  accepts: () => ["point"],
  options: () => [],
  init: (): PointMarkerIdle => ({ phase: "point", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as PointMarkerState;
    if (input.kind !== "point") return [s, { draft: null }];
    return [
      { phase: "point", lastPoint: null } as PointMarkerIdle,
      { draft: null, done: true, commit: appendPointMarker(input.point, ctx) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => [state, { draft: pointDraft(ctx, point) }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
