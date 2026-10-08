// Punkt-/Knotenmarker (Nutzer-Wunsch: „Punkt-/Knotenmarker" aus der
// Werkzeug-Lücken-Liste). Einfachster aller Zeichen-Befehle: EIN Klick →
// Kreuz-in-Kreis-Symbol an genau dieser Stelle, keine weiteren Felder
// (analog `detailref.ts`, aber ohne Label/Blattverknüpfung).

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

const PREVIEW_RADIUS = 0.08; // Modell-Meter, deckt sich mit POINTMARKER_RADIUS_M (drawing2d.ts)
const PREVIEW_CROSS = 0.12;

interface PointMarkerIdle extends CommandState {
  phase: "point";
}
type PointMarkerState = PointMarkerIdle;

function pointDraft(at: Vec2): ToolDraft {
  const N = 32;
  const pts: Vec2[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push({ x: at.x + PREVIEW_RADIUS * Math.cos(t), y: at.y + PREVIEW_RADIUS * Math.sin(t) });
  }
  const preview: DraftShape[] = [
    { kind: "poly", pts, closed: true },
    { kind: "line", a: { x: at.x - PREVIEW_CROSS, y: at.y }, b: { x: at.x + PREVIEW_CROSS, y: at.y } },
    { kind: "line", a: { x: at.x, y: at.y - PREVIEW_CROSS }, b: { x: at.x, y: at.y + PREVIEW_CROSS } },
  ];
  return { preview, vertices: [at] };
}

function appendPointMarker(p: Project, at: Vec2, ctx: CommandContext): Project {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "pointmarker", at },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

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
      { draft: null, done: true, commit: (p) => appendPointMarker(p, input.point, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => [state, { draft: pointDraft(point) }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
