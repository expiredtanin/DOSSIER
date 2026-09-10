// Leader (Legenden-/Vorführungspfeil) — wie `text`, aber mit vorangestelltem
// Zielpunkt: Schritte:
//   1) „Zielpunkt:" → Punkt (Pfeilspitze, zeigt auf das referenzierte Detail)
//   2) „Textanker:" → Punkt (Textposition)
//   Committet SOFORT ein leeres Text-Element mit `leaderTarget` gesetzt und
//   meldet `focusDrawingId` — dieselbe Inline-Editor-Infrastruktur wie beim
//   `text`-Befehl (kein neuer Shape, s. `Drawing2DGeom["text"].leaderTarget`).

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const DEFAULT_TEXT_HEIGHT_M = 0.25;
const EPS = 1e-6;

interface LeaderTarget extends CommandState {
  phase: "target";
}
interface LeaderAnchor extends CommandState {
  phase: "anchor";
  target: Vec2;
  cursor: Vec2 | null;
}
type LeaderState = LeaderTarget | LeaderAnchor;

function appendEmptyLeaderText(p: Project, id: string, at: Vec2, target: Vec2, ctx: CommandContext): Project {
  const d: Drawing2D = {
    id,
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "text", at, text: "", height: DEFAULT_TEXT_HEIGHT_M, angle: 0, leaderTarget: target },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "target", lastPoint: null } as LeaderTarget,
  { draft: null, done: true },
];

function anchorDraft(target: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor || Math.hypot(cursor.x - target.x, cursor.y - target.y) < EPS) {
    return { preview: [], vertices: [target] };
  }
  const preview: DraftShape[] = [{ kind: "line", a: cursor, b: target }];
  return { preview, vertices: [target] };
}

export const leaderCommand: Command = {
  name: "leader",
  labelKey: "cmd.leader.label",
  prompt: (s) => ((s as LeaderState).phase === "anchor" ? "cmd.leader.anchor" : "cmd.leader.target"),
  accepts: () => ["point"],
  options: () => [],
  init: (): LeaderTarget => ({ phase: "target", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as LeaderState;
    if (input.kind !== "point") return [s, { draft: null }];
    if (s.phase !== "anchor") {
      const next: LeaderAnchor = { phase: "anchor", target: input.point, cursor: input.point, lastPoint: input.point };
      return [next, { draft: anchorDraft(input.point, input.point) }];
    }
    const id = uniqueId("dr2d");
    const at = input.point;
    const target = s.target;
    return [
      idle()[0],
      {
        draft: null,
        done: true,
        commit: (p) => appendEmptyLeaderText(p, id, at, target, ctx),
        focusDrawingId: id,
      },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as LeaderState;
    if (s.phase !== "anchor") return [s, { draft: null }];
    const ns: LeaderAnchor = { ...s, cursor: point };
    return [ns, { draft: anchorDraft(s.target, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
