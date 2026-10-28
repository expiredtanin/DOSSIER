// Bezier — klassisches Kontrollpunkt-Werkzeug (manuell gesetzte Griffe, kein
// Auto-Glätten wie `spline`). Jedes Segment braucht 3 Klicks nach dem Anker:
//   1) „Startpunkt:"      → Punkt (erster Anker)
//   2) „Griff 1:"          → Punkt (Kontrollpunkt 1 dieses Segments)
//   3) „Griff 2:"          → Punkt (Kontrollpunkt 2 dieses Segments)
//   4) „Endpunkt:"         → Punkt (Segment-Ende, = Anker des nächsten Segments)
// Nach ≥1 fertigem Segment kann „Fertig" (Enter) den Zug abschliessen; jeder
// weitere Anker startet automatisch ein neues Segment (Schritte 2–4).

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import { sampleBezierChain } from "../../core";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

interface BezierStart extends CommandState {
  phase: "start";
}
interface BezierC1 extends CommandState {
  phase: "c1";
  pts: Vec2[]; // abgeschlossene Punkte (Anker·Griff·Griff·Anker·…)
  anchor: Vec2; // letzter Anker (= pts[pts.length-1])
  cursor: Vec2 | null;
}
interface BezierC2 extends CommandState {
  phase: "c2";
  pts: Vec2[];
  anchor: Vec2;
  c1: Vec2;
  cursor: Vec2 | null;
}
interface BezierEnd extends CommandState {
  phase: "end";
  pts: Vec2[];
  anchor: Vec2;
  c1: Vec2;
  c2: Vec2;
  cursor: Vec2 | null;
}
type BezierState = BezierStart | BezierC1 | BezierC2 | BezierEnd;

const FINISH: CmdOption = { id: "finish", labelKey: "cmd.bezier.finish" };

/** Vorschau: abgeschlossene Kurve (tessellierte Segmente) + Gummiband-Linien des laufenden Segments. */
function bezierDraft(pts: Vec2[], rubber: Vec2[]): ToolDraft {
  const preview: DraftShape[] = [];
  if (pts.length >= 4) preview.push({ kind: "poly", pts: sampleBezierChain(pts), closed: false });
  for (let i = 0; i < rubber.length - 1; i++) preview.push({ kind: "line", a: rubber[i], b: rubber[i + 1] });
  return { preview, vertices: pts.length > 0 ? [pts[0]] : [] };
}

function appendBezier(pts: Vec2[], ctx: CommandContext): CoreOp[] {
  if (pts.length < 4) return [];
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "bezier", pts },
  };
  return addItems("drawings2d", [d]);
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as BezierStart,
  { draft: null, done: true },
];
const finish = (pts: Vec2[], ctx: CommandContext): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as BezierStart,
  { draft: null, done: true, commit: opsMutation(() => appendBezier(pts, ctx)) },
];

export const bezierCommand: Command = {
  name: "bezier",
  labelKey: "cmd.bezier.label",
  prompt: (s) => {
    const phase = (s as BezierState).phase;
    return phase === "c1"
      ? "cmd.bezier.c1"
      : phase === "c2"
        ? "cmd.bezier.c2"
        : phase === "end"
          ? "cmd.bezier.end"
          : "cmd.bezier.start";
  },
  accepts: () => ["point", "option"],
  options: (s) => ((s as BezierState).phase === "c1" && (s as BezierC1).pts.length >= 4 ? [FINISH] : []),
  init: (): BezierStart => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as BezierState;

    if (input.kind === "option") {
      if (input.id === "finish" && s.phase === "c1" && s.pts.length >= 4) return finish(s.pts, ctx);
      return [s, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;

    if (s.phase === "start") {
      const ns: BezierC1 = { phase: "c1", pts: [pt], anchor: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: bezierDraft(ns.pts, [pt]) }];
    }
    if (s.phase === "c1") {
      const ns: BezierC2 = { phase: "c2", pts: s.pts, anchor: s.anchor, c1: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: bezierDraft(ns.pts, [s.anchor, pt]) }];
    }
    if (s.phase === "c2") {
      const ns: BezierEnd = {
        phase: "end",
        pts: s.pts,
        anchor: s.anchor,
        c1: s.c1,
        c2: pt,
        cursor: pt,
        lastPoint: pt,
      };
      return [ns, { draft: bezierDraft(ns.pts, [s.anchor, s.c1, pt]) }];
    }
    // phase "end": Segment abschliessen, direkt das nächste Segment beginnen.
    const pts = [...s.pts, s.c1, s.c2, pt];
    const ns: BezierC1 = { phase: "c1", pts, anchor: pt, cursor: pt, lastPoint: pt };
    return [ns, { draft: bezierDraft(pts, [pt]) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as BezierState;
    if (s.phase === "start") return [s, { draft: null }];
    if (s.phase === "c1") {
      const ns: BezierC1 = { ...s, cursor: point };
      return [ns, { draft: bezierDraft(s.pts, [s.anchor, point]) }];
    }
    if (s.phase === "c2") {
      const ns: BezierC2 = { ...s, cursor: point };
      return [ns, { draft: bezierDraft(s.pts, [s.anchor, s.c1, point]) }];
    }
    const ns: BezierEnd = { ...s, cursor: point };
    // Endschritt: die tatsächliche Bezier-Kurve bis zum Cursor live anzeigen.
    return [ns, { draft: bezierDraft([...s.pts, s.c1, s.c2, point], []) }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as BezierState;
    if (s.phase === "c1" && s.pts.length >= 4) return finish(s.pts, ctx);
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),
};
