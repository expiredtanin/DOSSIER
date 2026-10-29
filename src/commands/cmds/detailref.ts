// Detail-/Schnitt-Verweis-Symbol (Nutzer-Wunsch: „Kein zweiteiliges Verweis-
// Symbol, das eine Sheet/Layout-ID trägt"). Schritte:
//   1) „Punkt:" → Punkt (Kreis-Zentrum) → commit mit Default-Label „A",
//      OHNE Blattverknüpfung. Label/Blattverknüpfung werden DANACH im
//      Attribute-Panel gesetzt (wie beim Platzieren eines Blocks: erst
//      Position, Feinheiten hinterher) — kein Tipp-Schritt beim Platzieren
//      nötig, das Symbol landet sofort selektiert-editierbar im Plan.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

const PREVIEW_RADIUS = 0.3; // Modell-Meter, deckt sich mit DETAILREF_RADIUS_M (plan/drawings.rs)
const DEFAULT_LABEL = "A";

interface DetailRefIdle extends CommandState {
  phase: "point";
}
type DetailRefState = DetailRefIdle;

/** Kreis-Vorschau (Vollkreis-Approximation, wie andere Symbol-Vorschauen). */
function pointDraft(at: Vec2): ToolDraft {
  const N = 32;
  const pts: Vec2[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push({ x: at.x + PREVIEW_RADIUS * Math.cos(t), y: at.y + PREVIEW_RADIUS * Math.sin(t) });
  }
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: true }];
  return { preview, vertices: [at] };
}

function appendDetailRef(at: Vec2, ctx: CommandContext): CoreOp[] {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "detailref", at, label: DEFAULT_LABEL },
  };
  return addItems("drawings2d", [d]);
}

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
      { draft: null, done: true, commit: opsMutation(() => appendDetailRef(input.point, ctx)) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => [state, { draft: pointDraft(point) }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
