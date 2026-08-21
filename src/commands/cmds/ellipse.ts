// Ellipse — zwei gegenüberliegende Ecken einer Bounding-Box (achsparallel,
// wie das 2-Punkt-Rechteck). Schritte:
//   1) „Erste Ecke:"            → Punkt
//   2) „Gegenüberliegende Ecke:" → Punkt → commit (shape:"ellipse", rotation 0)
//
// Bewusst nur die einfache Bounding-Box-Methode (kein Dreh-Winkel über das
// Werkzeug) — `rotation` bleibt 0, das Feld existiert im Modell für spätere
// Dreh-Bearbeitung/andere Quellen (s. `model/types.ts`).

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
import { ellipsePts } from "../../tools/curves";

const EPS = 1e-6;

interface EllipseIdle extends CommandState {
  phase: "corner1";
}
interface EllipseDrawing extends CommandState {
  phase: "corner2";
  p0: Vec2;
  cursor: Vec2 | null;
}
type EllipseState = EllipseIdle | EllipseDrawing;

/** Zentrum + Halbachsen aus zwei gegenüberliegenden Bounding-Box-Ecken. */
function ellipseFromCorners(p0: Vec2, p1: Vec2): { center: Vec2; rx: number; ry: number } {
  return {
    center: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 },
    rx: Math.abs(p1.x - p0.x) / 2,
    ry: Math.abs(p1.y - p0.y) / 2,
  };
}

/** Vorschau (tessellierte Ellipse) + HUD (Breite×Höhe). */
function ellipseDraft(p0: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor) return { preview: [], vertices: [p0] };
  const { center, rx, ry } = ellipseFromCorners(p0, cursor);
  if (rx < EPS || ry < EPS) return { preview: [], vertices: [p0] };
  const preview: DraftShape[] = [{ kind: "poly", pts: ellipsePts(center, rx, ry, 0), closed: true }];
  return {
    preview,
    vertices: [p0],
    hud: { at: cursor, text: `${(rx * 2).toFixed(3)}×${(ry * 2).toFixed(3)}m` },
  };
}

function appendEllipse(p: Project, center: Vec2, rx: number, ry: number, ctx: CommandContext): Project {
  if (rx < EPS || ry < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "ellipse", center, rx, ry, rotation: 0 },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "corner1", lastPoint: null },
  { draft: null, done: true },
];

export const ellipseCommand: Command = {
  name: "ellipse",
  labelKey: "cmd.ellipse.label",
  prompt: (s) => ((s as EllipseState).phase === "corner2" ? "cmd.ellipse.corner2" : "cmd.ellipse.corner1"),
  accepts: () => ["point"],
  options: () => [],
  init: (): EllipseIdle => ({ phase: "corner1", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as EllipseState;
    if (input.kind !== "point") return [s, { draft: null }];
    if (s.phase !== "corner2") {
      const ns: EllipseDrawing = { phase: "corner2", p0: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: ellipseDraft(input.point, null) }];
    }
    const { center, rx, ry } = ellipseFromCorners(s.p0, input.point);
    return [
      { phase: "corner1", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendEllipse(p, center, rx, ry, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as EllipseState;
    if (s.phase !== "corner2") return [s, { draft: null }];
    const ns: EllipseDrawing = { ...s, cursor: point };
    return [ns, { draft: ellipseDraft(s.p0, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
