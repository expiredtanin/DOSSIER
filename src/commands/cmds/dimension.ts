// Bemassung (lineare Masslinie, SIA 400 B.5.3) — misst den Abstand zweier
// Punkte. Schritte:
//   1) „Erster Punkt:"               → Punkt (a)
//   2) „Zweiter Punkt:"               → Punkt (b) — zeigt die Länge live
//   3) „Lage der Masslinie:"          → Punkt/Zahl (Normalabstand zu a-b,
//      links von a→b positiv) → commit (shape:"dimension")
//
// Die Masszahl wird beim Rendern aus dist(a,b) abgeleitet (nicht gespeichert)
// — bleibt beim späteren Griff-Ziehen automatisch korrekt.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
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
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Vorzeichenbehafteter Normalabstand von `pt` zur Geraden a→b (links positiv). */
function signedOffset(a: Vec2, b: Vec2, pt: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return 0;
  const nx = -dy / len, ny = dx / len;
  return (pt.x - a.x) * nx + (pt.y - a.y) * ny;
}

interface DimStart extends CommandState {
  phase: "start";
}
interface DimEnd extends CommandState {
  phase: "end";
  a: Vec2;
  cursor: Vec2 | null;
}
interface DimOffset extends CommandState {
  phase: "offset";
  a: Vec2;
  b: Vec2;
  cursor: Vec2 | null;
}
type DimState = DimStart | DimEnd | DimOffset;

const OFFSET_FIELDS: CommandField[] = [{ id: "offset", labelKey: "cmd.field.offset" }];

/** Vorschau: Masshilfslinien + Masslinie (grob, ohne Massstriche/Text — Feinheiten rendert generatePlan). */
function dimDraft(a: Vec2, b: Vec2, offset: number, at: Vec2 | null): ToolDraft {
  const preview: DraftShape[] = [];
  if (Math.abs(offset) > EPS) {
    const off = offsetPoints(a, b, offset);
    preview.push({ kind: "line", a, b: off.a });
    preview.push({ kind: "line", a: b, b: off.b });
    preview.push({ kind: "line", a: off.a, b: off.b });
  } else {
    preview.push({ kind: "line", a, b });
  }
  const draft: ToolDraft = { preview, vertices: [a, b] };
  if (at) draft.hud = { at, text: `${dist(a, b).toFixed(3)}m · Δ${offset.toFixed(3)}m` };
  return draft;
}

/** Endpunkte der um `offset` parallel verschobenen Masslinie. */
function offsetPoints(a: Vec2, b: Vec2, offset: number): { a: Vec2; b: Vec2 } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * offset, ny = (dx / len) * offset;
  return { a: { x: a.x + nx, y: a.y + ny }, b: { x: b.x + nx, y: b.y + ny } };
}

function appendDimension(p: Project, a: Vec2, b: Vec2, offset: number, ctx: CommandContext): Project {
  if (dist(a, b) < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "dimension", a, b, offset },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null },
  { draft: null, done: true },
];

export const dimensionCommand: Command = {
  name: "dimension",
  labelKey: "cmd.dimension.label",
  prompt: (s) => {
    const phase = (s as DimState).phase;
    return phase === "end" ? "cmd.dimension.end" : phase === "offset" ? "cmd.dimension.offset" : "cmd.dimension.start";
  },
  accepts: (s) => ((s as DimState).phase === "offset" ? ["point", "number"] : ["point"]),
  options: () => [],
  init: (): DimStart => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as DimState;
    if (s.phase !== "offset") {
      if (input.kind !== "point") return [s, { draft: null }];
      const pt = input.point;
      if (s.phase !== "end") {
        const ns: DimEnd = { phase: "end", a: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: { preview: [], vertices: [pt] } }];
      }
      if (dist(s.a, pt) < EPS) return idle();
      const ns: DimOffset = { phase: "offset", a: s.a, b: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: dimDraft(s.a, pt, 0, null) }];
    }
    // Offset-Schritt: Zahl = direkter Abstand, Punkt = Abstand zum Cursor.
    let offset: number;
    if (input.kind === "number") offset = input.value;
    else if (input.kind === "point") offset = signedOffset(s.a, s.b, input.point);
    else return [s, { draft: dimDraft(s.a, s.b, 0, null) }];
    const { a, b } = s;
    return [
      { phase: "start", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendDimension(p, a, b, offset, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as DimState;
    if (s.phase === "end") {
      const ns: DimEnd = { ...s, cursor: point };
      if (dist(s.a, point) < EPS) return [ns, { draft: { preview: [], vertices: [s.a] } }];
      const draft: ToolDraft = {
        preview: [{ kind: "line", a: s.a, b: point }],
        vertices: [s.a],
        hud: { at: point, text: `${dist(s.a, point).toFixed(3)}m` },
      };
      return [ns, { draft }];
    }
    if (s.phase === "offset") {
      const off = signedOffset(s.a, s.b, point);
      const ns: DimOffset = { ...s, cursor: point };
      return [ns, { draft: dimDraft(s.a, s.b, off, point) }];
    }
    return [s, { draft: null }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),

  fields: (state) => ((state as DimState).phase === "offset" ? OFFSET_FIELDS : []),
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as DimState;
    if (s.phase !== "offset" || !cursor) return {};
    return { offset: signedOffset(s.a, s.b, cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as DimState;
    if (s.phase !== "offset") return null;
    const offset = "offset" in locks ? locks.offset : cursor ? signedOffset(s.a, s.b, cursor) : 0;
    return offsetPoints(s.a, s.b, offset).a;
  },
};
