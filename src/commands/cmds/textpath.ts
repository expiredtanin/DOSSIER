// Text-entlang-Pfad — wie `polyline` beim Punkte-Sammeln (≥2 Stützpunkte,
// Enter/Rechtsklick beendet), aber committet SOFORT ein leeres Text-Element
// mit `pathPts` gesetzt und meldet `focusDrawingId` — dieselbe Inline-Editor-
// Infrastruktur wie `text`/`leader` (kein neuer Shape, s. `Drawing2DGeom
// ["text"].pathPts`). Schritte:
//   1) „Pfadpunkt:" → Punkt
//   2) „Nächster Pfadpunkt ( Fertig ):" → Punkt … Enter beendet (≥2 Punkte nötig)

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const DEFAULT_TEXT_HEIGHT_M = 0.25;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

const PATH_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

function nextFromFields(last: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? last;
  const length = "length" in locks ? locks.length : segLen(last, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(last, ref);
  const ang = angleDeg * DEG;
  return { x: last.x + Math.cos(ang) * length, y: last.y + Math.sin(ang) * length };
}

interface TpIdle extends CommandState {
  phase: "start";
}
interface TpNext extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
}
type TpState = TpIdle | TpNext;

function pathDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  const preview: DraftShape[] = pts.length >= 2 ? [{ kind: "poly", pts, closed: false }] : [];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

function appendEmptyTextPath(p: Project, id: string, pts: Vec2[], ctx: CommandContext): Project {
  const d: Drawing2D = {
    id,
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "text", at: pts[0], text: "", height: DEFAULT_TEXT_HEIGHT_M, angle: 0, pathPts: pts },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as TpIdle,
  { draft: null, done: true },
];

function commitPath(pts: Vec2[], ctx: CommandContext): CommandResult {
  const id = uniqueId("dr2d");
  return { draft: null, done: true, commit: (p) => appendEmptyTextPath(p, id, pts, ctx), focusDrawingId: id };
}

export const textpathCommand: Command = {
  name: "textpath",
  labelKey: "cmd.textpath.label",
  prompt: (s) => ((s as TpState).phase === "next" ? "cmd.textpath.next" : "cmd.textpath.start"),
  accepts: () => ["point", "number"],
  options: () => [],
  init: (): TpIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input): [CommandState, CommandResult] => {
    const s = state as TpState;
    if (input.kind !== "point") {
      return [s, { draft: s.phase === "next" ? pathDraft(s.points, s.cursor) : null }];
    }
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: TpNext = { phase: "next", points: [pt], cursor: pt, lastPoint: pt };
      return [ns, { draft: pathDraft([pt], pt) }];
    }
    const points = [...s.points, pt];
    const ns: TpNext = { phase: "next", points, cursor: pt, lastPoint: pt };
    return [ns, { draft: pathDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as TpState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: TpNext = { ...s, cursor: point };
    return [ns, { draft: pathDraft(s.points, point) }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as TpState;
    if (s.phase === "next" && s.points.length >= 2) {
      return [idle()[0], commitPath(s.points, ctx)];
    }
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),

  fields: (state) => ((state as TpState).phase === "next" ? PATH_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as TpState;
    if (s.phase !== "next" || s.points.length === 0) return null;
    return nextFromFields(s.points[s.points.length - 1], locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as TpState;
    if (s.phase !== "next" || s.points.length === 0 || !cursor) return {};
    const last = s.points[s.points.length - 1];
    return {
      length: segLen(last, cursor),
      angle: ((segAngleDeg(last, cursor) % 360) + 360) % 360,
    };
  },
};
