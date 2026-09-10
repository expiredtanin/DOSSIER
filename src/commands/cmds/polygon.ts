// Regelmässiges Vieleck — Mittelpunkt + Radius (umschriebener Kreis), Anzahl
// Ecken zyklt über eine Inline-Option (3..12, Default 6), analog zum
// `count`-Zyklus bei Multiline. Committet als geschlossene `polyline` — kein
// neuer Shape-Typ nötig, erbt dadurch Rendering/Snapping/Griffe/Export
// komplett vom bestehenden Polylinien-Pfad. Schritte:
//   1) „Mittelpunkt:" → Punkt
//   2) „Radius:"       → Punkt (Abstand+Richtung des ersten Eckpunkts) ODER
//      getippte Zahl (Radius, Richtung +X) → commit. Ecken-Zahl per Option.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  CmdOption,
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
const MIN_SIDES = 3;
const MAX_SIDES = 12;

let lastSides = 6;

interface PolyIdle extends CommandState {
  phase: "center";
}
interface PolyDrawing extends CommandState {
  phase: "radius";
  center: Vec2;
  cursor: Vec2 | null;
}
type PolyState = PolyIdle | PolyDrawing;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

const RADIUS_FIELDS: CommandField[] = [{ id: "radius", labelKey: "cmd.field.radius" }];
const SIDES_OPTION: CmdOption = { id: "sides", labelKey: "cmd.polygon.sides" };

/** Eckpunkte des umschriebenen regelmässigen Vielecks (erste Ecke Richtung `dir`). */
function polygonPts(center: Vec2, r: number, sides: number, dir: Vec2 | null): Vec2[] {
  const t0 = dir && dist(center, dir) > EPS ? Math.atan2(dir.y - center.y, dir.x - center.x) : 0;
  const pts: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const t = t0 + (i / sides) * Math.PI * 2;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

function polygonDraft(center: Vec2, r: number, dir: Vec2 | null, at: Vec2 | null): ToolDraft {
  if (r < EPS) return { preview: [], vertices: [center] };
  const preview: DraftShape[] = [{ kind: "poly", pts: polygonPts(center, r, lastSides, dir), closed: true }];
  const draft: ToolDraft = { preview, vertices: [center] };
  if (at) draft.hud = { at, text: `R: ${r.toFixed(3)}m × ${lastSides}` };
  return draft;
}

function appendPolygon(p: Project, center: Vec2, r: number, dir: Vec2 | null, ctx: CommandContext): Project {
  if (r < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts: polygonPts(center, r, lastSides, dir), closed: true },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "center", lastPoint: null } as PolyIdle,
  { draft: null, done: true },
];

export const polygonCommand: Command = {
  name: "polygon",
  labelKey: "cmd.polygon.label",
  prompt: (s) => ((s as PolyState).phase === "radius" ? "cmd.polygon.radius" : "cmd.polygon.center"),
  accepts: (s) => ((s as PolyState).phase === "radius" ? ["point", "number", "option"] : ["point"]),
  options: (s) =>
    (s as PolyState).phase === "radius" ? [{ ...SIDES_OPTION, value: String(lastSides) }] : [],
  init: (): PolyIdle => ({ phase: "center", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as PolyState;
    if (s.phase !== "radius") {
      if (input.kind !== "point") return [s, { draft: null }];
      const ns: PolyDrawing = { phase: "radius", center: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: polygonDraft(input.point, 0, null, null) }];
    }
    if (input.kind === "option") {
      if (input.id === "sides") {
        lastSides = lastSides >= MAX_SIDES ? MIN_SIDES : lastSides + 1;
        const r = s.cursor ? dist(s.center, s.cursor) : 0;
        return [s, { draft: polygonDraft(s.center, r, s.cursor, s.cursor) }];
      }
      return [s, { draft: null }];
    }
    let r: number;
    let dir: Vec2 | null;
    if (input.kind === "number") {
      r = input.value;
      dir = s.cursor;
    } else if (input.kind === "point") {
      r = dist(s.center, input.point);
      dir = input.point;
    } else {
      const rr = s.cursor ? dist(s.center, s.cursor) : 0;
      return [s, { draft: polygonDraft(s.center, rr, s.cursor, s.cursor) }];
    }
    const center = s.center;
    return [
      idle()[0],
      { draft: null, done: true, commit: (p) => appendPolygon(p, center, r, dir, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as PolyState;
    if (s.phase !== "radius") return [s, { draft: null }];
    const r = dist(s.center, point);
    const ns: PolyDrawing = { ...s, cursor: point };
    return [ns, { draft: polygonDraft(s.center, r, point, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),

  fields: (state) => ((state as PolyState).phase === "radius" ? RADIUS_FIELDS : []),
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as PolyState;
    if (s.phase !== "radius" || !cursor) return {};
    return { radius: dist(s.center, cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as PolyState;
    if (s.phase !== "radius") return null;
    const r = "radius" in locks ? Math.abs(locks.radius) : cursor ? dist(s.center, cursor) : 0;
    if (cursor) {
      const d = dist(s.center, cursor);
      if (d > EPS) {
        return {
          x: s.center.x + ((cursor.x - s.center.x) / d) * r,
          y: s.center.y + ((cursor.y - s.center.y) / d) * r,
        };
      }
    }
    return { x: s.center.x + r, y: s.center.y };
  },
};
