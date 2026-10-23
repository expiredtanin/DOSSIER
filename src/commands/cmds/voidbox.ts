// Durchbruch — legt einen quaderförmigen Abzugskörper an (`ExtrudedSolid.operation =
// "subtract"`, s. `plan/voids.ts`): er zieht sich von allen Wänden, Decken und Stützen ab, die er
// durchdringt (Grundriss, Schnitt, 3D, STEP). Für Leitungsdurchbrüche, Nischen, Schlitze.
//
// Schritte: Ecke → Gegenecke → Höhe → Abstand über Geschoss-UK (Zahl tippen; Enter = 0).
// Beliebige Profile: Polylinie extrudieren und im Objekt-Panel „Abzugskörper" setzen.

import type { ExtrudedSolid } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type { Command, CommandResult, CommandState, Project, ToolDraft, Vec2 } from "../types";

type Step = "corner" | "corner2" | "height" | "offset";

interface VoidState extends CommandState {
  step: Step;
  p0: Vec2 | null;
  p1: Vec2 | null;
  height: number | null;
  cursor: Vec2 | null;
}

/** Letzte Werte (Enter übernimmt sie beim nächsten Mal). */
let lastHeight = 0.3;
let lastOffset = 1.0;

const rectPts = (a: Vec2, b: Vec2): Vec2[] => {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
};

/** Abzugskörper aus den Eingaben (reiner Kern, getestet). */
export function voidFromInputs(levelId: string, a: Vec2, b: Vec2, height: number, offset: number): ExtrudedSolid | null {
  if (Math.abs(b.x - a.x) < 1e-6 || Math.abs(b.y - a.y) < 1e-6 || !(height > 1e-6)) return null;
  return {
    id: uniqueId("void"),
    type: "extrudedSolid",
    levelId,
    points: rectPts(a, b),
    height,
    operation: "subtract",
    ...(Math.abs(offset) > 1e-9 ? { baseOffset: offset } : {}),
  };
}

function draftOf(s: VoidState): ToolDraft | null {
  if (!s.p0) return null;
  const b = s.p1 ?? s.cursor ?? s.p0;
  const pts = rectPts(s.p0, b);
  return {
    preview: [
      { kind: "poly", pts, closed: true },
      { kind: "line", a: pts[0], b: pts[2] },
      { kind: "line", a: pts[1], b: pts[3] },
    ],
    vertices: [s.p0],
    hud: {
      at: b,
      text:
        s.step === "corner2"
          ? `${Math.abs(b.x - s.p0.x).toFixed(2)} × ${Math.abs(b.y - s.p0.y).toFixed(2)} m`
          : s.step === "height"
            ? `h = ${lastHeight.toFixed(2)} m (Enter)`
            : `UK + ${lastOffset.toFixed(2)} m (Enter)`,
    },
  };
}

const reset = (): VoidState => ({ phase: "void", step: "corner", p0: null, p1: null, height: null, cursor: null, lastPoint: null });

const PROMPT: Record<Step, string> = {
  corner: "cmd.void.corner",
  corner2: "cmd.void.corner2",
  height: "cmd.void.height",
  offset: "cmd.void.offset",
};

function finish(s: VoidState, offset: number, levelId: string): [CommandState, CommandResult] {
  lastOffset = offset;
  const solid = s.p0 && s.p1 && s.height ? voidFromInputs(levelId, s.p0, s.p1, s.height, offset) : null;
  return [
    reset(),
    {
      draft: null,
      done: true,
      commit: (p: Project) => (solid ? { ...p, extrudedSolids: [...(p.extrudedSolids ?? []), solid] } : p),
    },
  ];
}

export const voidBoxCommand: Command = {
  name: "voidbox",
  labelKey: "cmd.void.label",
  floorOnly: true,
  prompt: (st) => PROMPT[(st as VoidState).step] as never,
  accepts: (st) => ((st as VoidState).step === "height" || (st as VoidState).step === "offset" ? ["number"] : ["point"]),
  options: () => [],
  init: (): VoidState => reset(),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as VoidState;
    if (s.step === "corner" && input.kind === "point") {
      const ns: VoidState = { ...s, step: "corner2", p0: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: draftOf(ns) }];
    }
    if (s.step === "corner2" && input.kind === "point") {
      const ns: VoidState = { ...s, step: "height", p1: input.point };
      return [ns, { draft: draftOf(ns) }];
    }
    if (s.step === "height" && input.kind === "number" && input.value > 0) {
      lastHeight = input.value;
      const ns: VoidState = { ...s, step: "offset", height: input.value };
      return [ns, { draft: draftOf(ns) }];
    }
    if (s.step === "offset" && input.kind === "number") return finish(s, input.value, ctx.level.id);
    return [s, { draft: draftOf(s) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as VoidState;
    const ns: VoidState = { ...s, cursor: point };
    return [ns, { draft: draftOf(ns) }];
  },

  // Enter übernimmt die letzten Werte (Höhe bzw. Abstand).
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as VoidState;
    if (s.step === "height") {
      const ns: VoidState = { ...s, step: "offset", height: lastHeight };
      return [ns, { draft: draftOf(ns) }];
    }
    if (s.step === "offset") return finish(s, lastOffset, ctx.level.id);
    return [reset(), { draft: null, done: true }];
  },
  onCancel: (): [CommandState, CommandResult] => [reset(), { draft: null, done: true }],
};
