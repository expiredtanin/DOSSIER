// Detail-/Schnitt-Verweis-Symbol (Nutzer-Wunsch: „Kein zweiteiliges Verweis-
// Symbol, das eine Sheet/Layout-ID trägt"). Schritte:
//   1) „Punkt:" → Punkt (Kreis-Zentrum) → commit mit Default-Label „A",
//      OHNE Blattverknüpfung. Label/Blattverknüpfung werden DANACH im
//      Attribute-Panel gesetzt (wie beim Platzieren eines Blocks: erst
//      Position, Feinheiten hinterher) — kein Tipp-Schritt beim Platzieren
//      nötig, das Symbol landet sofort selektiert-editierbar im Plan.

import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview } from "../createCore";


interface DetailRefIdle extends CommandState {
  phase: "point";
}
type DetailRefState = DetailRefIdle;

/** Kreis-Vorschau (Vollkreis-Approximation, wie andere Symbol-Vorschauen). */
/** Vorschau (Kern, `cmd_draw.rs`): Verweisblase (Kreis r = 0.3 m) am Cursor. */
function pointDraft(ctx: CommandContext, at: Vec2): ToolDraft {
  return { preview: createPreview(ctx, { cmd: "detailref" }, [at]).shapes, vertices: [at] };
}

/** Commit (Kern): Verweis „A“ am Punkt (Label/Blatt danach im Attribut-Panel). */
const appendDetailRef = (at: Vec2, ctx: CommandContext) => createMutation(ctx, { cmd: "detailref", at });

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null } as DetailRefIdle,
  { draft: null, done: true },
];

export const detailrefCommand: Command = {
  name: "detailref",
  labelKey: "cmd.detailref.label",
  prompt: () => "cmd.detailref.point",
  accepts: () => ["point"],
  options: () => [],
  init: (): DetailRefIdle => ({ phase: "point", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as DetailRefState;
    if (input.kind !== "point") return [s, { draft: null }];
    return [
      { phase: "point", lastPoint: null } as DetailRefIdle,
      { draft: null, done: true, commit: appendDetailRef(input.point, ctx) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => [state, { draft: pointDraft(ctx, point) }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
