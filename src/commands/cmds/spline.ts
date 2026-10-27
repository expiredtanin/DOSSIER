// Spline — glatte Kurve über mehreren Wegpunkten, Bedienung 1:1 wie
// `polyline` (s. dort), nur dass die Vorschau/das Ergebnis zwischen den
// Punkten rundet statt gerade Kanten zu ziehen. Schritte:
//   1) „Startpunkt:" → Punkt
//   2) „Nächster Punkt ( Schliessen Zurück ):" → Punkt … (Enter beendet offen,
//      „Schliessen" schließt; Klick auf den Startpunkt schließt ebenfalls)
//
// Zwei Kurven-Modi (Option „Modus", tippbar/klickbar, zyklisch fit↔control
// — analog zum Methode-Zyklus bei `circle.ts`/`arc.ts`, hier nur 2 Werte):
//   • „fit" (Default, unverändert): die Kurve verläuft DURCH die Wegpunkte
//     (uniformer Catmull-Rom).
//   • „control" (Kontrollpunkt-/CV-Modus): die Wegpunkte sind Kontrollpunkte
//     eines kubischen B-Splines — die Kurve wird nur von ihnen GEZOGEN,
//     berührt sie i. A. NICHT (nur Start/Ende bei offener Kurve, geklemmt).
//     Kein Gewicht pro Kontrollpunkt (NURBS) — bewusst auf den unbewichteten
//     Fall beschränkt, s. PENDENZEN.md.

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
import { sampleCatmullRom, sampleUniformBSpline } from "../../geometry/curves";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const EPS = 1e-6;
const CLOSE_HIT = 0.08; // Modell-Meter: Klick nahe Startpunkt schließt den Zug
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

type CurveMode = "fit" | "control";

interface SplineIdle extends CommandState {
  phase: "start";
  closed: boolean;
  curveMode: CurveMode;
}
interface SplineDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
  closed: boolean;
  curveMode: CurveMode;
}
type SplineState = SplineIdle | SplineDrawing;

const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };
const closedOption = (closed: boolean): CmdOption => ({
  id: "mode",
  labelKey: "cmd.polyline.closedOpt",
  value: closed ? "on" : "off",
});
const curveModeOption = (mode: CurveMode): CmdOption => ({
  id: "curveMode",
  labelKey: "cmd.spline.curveMode",
  value: mode === "control" ? "cv" : "fit",
});

/** Kurvenpunkte je nach Modus (fit = interpolierend, control = B-Spline-Kontrollnetz). */
function sampleCurve(pts: Vec2[], closed: boolean, mode: CurveMode): Vec2[] {
  return mode === "control" ? sampleUniformBSpline(pts, closed) : sampleCatmullRom(pts, closed);
}

/** Vorschau (geglätteter Zug + Gummiband zum Cursor) + HUD. */
function splineDraft(points: Vec2[], cursor: Vec2 | null, closed: boolean, mode: CurveMode): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  const showClosed = closed && pts.length >= 3;
  const curve = sampleCurve(pts, showClosed, mode);
  const preview: DraftShape[] = [{ kind: "poly", pts: curve, closed: showClosed }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

function appendSpline(p: Project, pts: Vec2[], closed: boolean, mode: CurveMode, ctx: CommandContext): Project {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "spline", pts, closed, mode },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (closed = false, curveMode: CurveMode = "fit"): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null, closed, curveMode } as SplineIdle,
  { draft: null, done: true },
];

export const splineCommand: Command = {
  name: "spline",
  labelKey: "cmd.spline.label",
  prompt: (s) => ((s as SplineState).phase === "next" ? "cmd.spline.next" : "cmd.spline.start"),
  accepts: () => ["point", "option"],
  options: (s) => {
    const ps = s as SplineState;
    const toggles = [closedOption(ps.closed), curveModeOption(ps.curveMode)];
    if (ps.phase !== "next") return toggles;
    return ps.points.length >= 2 ? [CLOSE, ...toggles, UNDO] : [...toggles, UNDO];
  },
  init: (): SplineIdle => ({ phase: "start", lastPoint: null, closed: false, curveMode: "fit" }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as SplineState;

    if (input.kind === "option") {
      if (input.id === "mode") {
        const ns = { ...s, closed: !s.closed } as SplineState;
        return [ns, { draft: s.phase === "next" ? splineDraft(s.points, s.cursor, ns.closed, s.curveMode) : null }];
      }
      if (input.id === "curveMode") {
        const ns = { ...s, curveMode: s.curveMode === "control" ? "fit" : "control" } as SplineState;
        return [ns, { draft: s.phase === "next" ? splineDraft(s.points, s.cursor, s.closed, ns.curveMode) : null }];
      }
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0)
          return [
            { phase: "start", lastPoint: null, closed: s.closed, curveMode: s.curveMode } as SplineIdle,
            { draft: null },
          ];
        const ns: SplineDrawing = {
          phase: "next",
          points: pts,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
          closed: s.closed,
          curveMode: s.curveMode,
        };
        return [ns, { draft: splineDraft(pts, s.cursor, s.closed, s.curveMode) }];
      }
      if (input.id === "close" && s.points.length >= 3) {
        const pts = s.points;
        return [
          { phase: "start", lastPoint: null, closed: s.closed, curveMode: s.curveMode } as SplineIdle,
          { draft: null, done: true, commit: (p) => appendSpline(p, pts, true, s.curveMode, ctx) },
        ];
      }
      return [s, { draft: splineDraft(s.points, s.cursor, s.closed, s.curveMode) }];
    }

    if (input.kind !== "point") {
      return [s, { draft: s.phase === "next" ? splineDraft(s.points, s.cursor, s.closed, s.curveMode) : null }];
    }
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: SplineDrawing = {
        phase: "next",
        points: [pt],
        cursor: pt,
        lastPoint: pt,
        closed: s.closed,
        curveMode: s.curveMode,
      };
      return [ns, { draft: splineDraft([pt], pt, s.closed, s.curveMode) }];
    }
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      const pts = s.points;
      return [
        { phase: "start", lastPoint: null, closed: s.closed, curveMode: s.curveMode } as SplineIdle,
        { draft: null, done: true, commit: (p) => appendSpline(p, pts, true, s.curveMode, ctx) },
      ];
    }
    const points = [...s.points, pt];
    const ns: SplineDrawing = {
      phase: "next",
      points,
      cursor: pt,
      lastPoint: pt,
      closed: s.closed,
      curveMode: s.curveMode,
    };
    return [ns, { draft: splineDraft(points, pt, s.closed, s.curveMode) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as SplineState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: SplineDrawing = { ...s, cursor: point };
    return [ns, { draft: splineDraft(s.points, point, s.closed, s.curveMode) }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as SplineState;
    if (s.phase === "next" && s.points.length >= 2) {
      const pts = s.points;
      const close = s.closed && pts.length >= 3;
      return [
        { phase: "start", lastPoint: null, closed: s.closed, curveMode: s.curveMode } as SplineIdle,
        { draft: null, done: true, commit: (p) => appendSpline(p, pts, close, s.curveMode, ctx) },
      ];
    }
    return idle(s.closed, s.curveMode);
  },
  onCancel: (state): [CommandState, CommandResult] => idle((state as SplineState).closed, (state as SplineState).curveMode),
};
