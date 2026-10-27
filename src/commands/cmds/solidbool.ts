// SolidBool — Boolesche Operation (Vereinigung / Differenz / Durchschnitt) zweier Körper
// (`ExtrudedSolid`). Das Ergebnis ist EIN Körper mit B-Rep-Spezifikation (`brep.spec` =
// `boolean`-Knoten über den beiden Operanden): truck rechnet auf B-Rep-Ebene und fällt bei
// koinzidenten Flächen automatisch auf Mesh-CSG zurück (trucksolid::solid_mesh_core).
//
// Schritte: „Ersten Körper wählen" (Klick in seine Grundfläche) → „Zweiten Körper wählen" →
// fertig. Die Operation wählt man als Inline-Option (Default Vereinigung); bei Differenz wird
// der ZWEITE vom ERSTEN abgezogen. Beide Quellkörper werden durch das Ergebnis ersetzt.

import type { ExtrudedSolid, Vec2 } from "../../model/types";
import { getFloor } from "../../model/types";
import { uniqueId } from "../../tools/types";
import { extrudedSolidSpec } from "../../core";
import type { Command, CommandResult, CommandState, CmdOption, Project, ToolDraft } from "../types";

export type SolidBoolOp = "union" | "difference" | "intersection";

const OP_OPTIONS: CmdOption[] = [
  { id: "union", labelKey: "cmd.solidbool.op.union" },
  { id: "difference", labelKey: "cmd.solidbool.op.difference" },
  { id: "intersection", labelKey: "cmd.solidbool.op.intersection" },
];
const OP_IDS = new Set(OP_OPTIONS.map((o) => o.id));

let lastOp: SolidBoolOp = "union";

interface BoolState extends CommandState {
  phase: "first" | "second";
  op: SolidBoolOp;
  firstId: string | null;
}

function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function bbox(pts: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

const rect = (b: { x0: number; y0: number; x1: number; y1: number }): Vec2[] => [
  { x: b.x0, y: b.y0 },
  { x: b.x1, y: b.y0 },
  { x: b.x1, y: b.y1 },
  { x: b.x0, y: b.y1 },
];

/** Körper auf der aktiven Ebene, dessen Grundfläche den Punkt enthält (der kleinste gewinnt). */
function pickSolid(project: Project, levelId: string, pt: Vec2): ExtrudedSolid | null {
  let best: ExtrudedSolid | null = null;
  let bestArea = Infinity;
  for (const s of project.extrudedSolids ?? []) {
    if (s.levelId !== levelId || !pointInPolygon(pt, s.points)) continue;
    const b = bbox(s.points);
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (area < bestArea) {
      best = s;
      bestArea = area;
    }
  }
  return best;
}

/** Ergebnis-Körper aus zwei Operanden (reiner Kern, getestet). `null`, wenn ein Operand keine B-Rep-Beschreibung hat. */
export function combineSolids(
  project: Project,
  a: ExtrudedSolid,
  b: ExtrudedSolid,
  op: SolidBoolOp,
): ExtrudedSolid | null {
  let baseZ = 0;
  try {
    baseZ = getFloor(project, a.levelId).baseElevation ?? 0;
  } catch {
    baseZ = 0;
  }
  // Operanden mit UK 0 beschreiben (lokales Z ab Geschoss-UK), Verschiebung ist eingebacken.
  const sa = extrudedSolidSpec(a, 0);
  const sb = extrudedSolidSpec(b, 0);
  void baseZ;
  if (!sa || !sb) return null;
  const ba = bbox(a.points);
  const bb = bbox(b.points);
  let points: Vec2[];
  let height: number;
  let label: string;
  if (op === "union") {
    points = rect({ x0: Math.min(ba.x0, bb.x0), y0: Math.min(ba.y0, bb.y0), x1: Math.max(ba.x1, bb.x1), y1: Math.max(ba.y1, bb.y1) });
    height = Math.max(a.height, b.height);
    label = "Vereinigung";
  } else if (op === "difference") {
    points = a.points.map((p) => ({ ...p }));
    height = a.height;
    label = "Differenz";
  } else {
    const x0 = Math.max(ba.x0, bb.x0);
    const y0 = Math.max(ba.y0, bb.y0);
    const x1 = Math.min(ba.x1, bb.x1);
    const y1 = Math.min(ba.y1, bb.y1);
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return null;
    points = rect({ x0, y0, x1, y1 });
    height = Math.min(a.height, b.height);
    label = "Durchschnitt";
  }
  return {
    id: uniqueId("body"),
    type: "extrudedSolid",
    levelId: a.levelId,
    points,
    height,
    brep: {
      spec: { kind: "boolean", op, a: sa, b: sb } as unknown as Record<string, unknown>,
      origin: points[0],
      label,
    },
  };
}

const reset = (op: SolidBoolOp): BoolState => ({ phase: "first", op, firstId: null, lastPoint: null });

function highlight(project: Project, id: string | null): ToolDraft | null {
  const s = id ? (project.extrudedSolids ?? []).find((x) => x.id === id) : null;
  return s ? { preview: [{ kind: "poly", pts: s.points, closed: true }], vertices: [] } : null;
}

export const solidBoolCommand: Command = {
  name: "solidbool",
  labelKey: "cmd.solidbool.label",
  floorOnly: true,
  prompt: (st) => ((st as BoolState).phase === "second" ? "cmd.solidbool.second" : "cmd.solidbool.first"),
  accepts: () => ["point", "option"],
  options: () => OP_OPTIONS,
  init: (): BoolState => reset(lastOp),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as BoolState;
    if (input.kind === "option" && OP_IDS.has(input.id)) {
      lastOp = input.id as SolidBoolOp;
      const ns: BoolState = { ...s, op: lastOp };
      return [ns, { draft: highlight(ctx.project, s.firstId) }];
    }
    if (input.kind !== "point") return [s, { draft: highlight(ctx.project, s.firstId) }];
    const hit = pickSolid(ctx.project, ctx.level.id, input.point);
    if (!hit) return [s, { draft: highlight(ctx.project, s.firstId) }];
    if (s.phase === "first") {
      const ns: BoolState = { ...s, phase: "second", firstId: hit.id, lastPoint: input.point };
      return [ns, { draft: highlight(ctx.project, hit.id) }];
    }
    if (hit.id === s.firstId) return [s, { draft: highlight(ctx.project, s.firstId) }];
    const firstId = s.firstId!;
    const op = s.op;
    return [
      reset(op),
      {
        draft: null,
        done: true,
        commit: (p: Project) => {
          const a = (p.extrudedSolids ?? []).find((x) => x.id === firstId);
          const b = (p.extrudedSolids ?? []).find((x) => x.id === hit.id);
          if (!a || !b) return p;
          const merged = combineSolids(p, a, b, op);
          if (!merged) return p;
          return {
            ...p,
            extrudedSolids: [...(p.extrudedSolids ?? []).filter((x) => x.id !== a.id && x.id !== b.id), merged],
          };
        },
      },
    ];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (state): [CommandState, CommandResult] => [reset((state as BoolState).op), { draft: null, done: true }],
  onCancel: (state): [CommandState, CommandResult] => [reset((state as BoolState).op), { draft: null, done: true }],
};
