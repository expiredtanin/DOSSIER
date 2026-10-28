// Break — entfernt den Abschnitt ZWISCHEN zwei geklickten Punkten auf einer
// Kurve (line/offene, NICHT gebogene polyline), AutoCADs BREAK-Befehl.
// Nutzer-Wunsch: „Stretch/Break fehlen als Befehle — der Kernel hätte mit
// splitAtIntersections/removeSegment das meiste für Break schon fertig."
// (Tatsächlich reichte eine neue, direktere Kernel-Funktion — `breakCurve` —
// eher als die genannten; s. Kopfkommentar dort.)
//
// Schritte:
//   1) „Erster Punkt:"  → Punkt (bestimmt die Kurve + Startposition)
//   2) „Zweiter Punkt:" → Punkt (Position auf DERSELBEN Kurve) → commit:
//      der Abschnitt zwischen beiden Positionen (Klick-Reihenfolge egal)
//      fällt weg, bis zu zwei Reststücke bleiben.
//
// Bewusst NICHT unterstützt (Klick auf eine geschlossene Kurve oder eine mit
// Bogen-Segmenten bricht NICHT ab, sondern bleibt im ersten Schritt — sonst
// säße der Nutzer nach einem Fehlklick im zweiten Schritt fest, ohne zu
// wissen warum): geschlossene Polylinien/Rechtecke (welcher der beiden
// Ring-Bögen übrig bleibt, ist klick-reihenfolge-abhängig — eigener,
// grösserer Scope) und Bogen-Segmente (bulge) — beide s. PENDENZEN.md.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import { addItems, opsMutation, removeItems } from "../../core";
import type { CoreOp } from "../../core";
import { breakCurve, nearestOnPolyline } from "../../core";
import { hasRealBulge } from "../../core";
import { chainToGeom, geomToCurve, isTrimmable, pickCurveAt } from "./trim";
import type {
  Command,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  Vec2,
} from "../types";

/** Trifft der Klick eine offene, bogen-freie Kurve (line/gerade polyline)? */
function pickBreakable(project: Project, levelId: string, pt: Vec2): Drawing2D | null {
  const d = pickCurveAt(project, levelId, pt);
  if (!d || !isTrimmable(d)) return null;
  const curve = geomToCurve(d.geom);
  if (!curve || curve.closed || hasRealBulge(curve.bulge)) return null;
  return d;
}

function breakOps(p: Project, target: Drawing2D, p1: Vec2, p2: Vec2): CoreOp[] {
  const curve = geomToCurve(target.geom);
  if (!curve) return [];
  const hit1 = nearestOnPolyline(curve.pts, false, p1);
  const hit2 = nearestOnPolyline(curve.pts, false, p2);
  if (!hit1 || !hit2) return [];
  const pieces = breakCurve(curve.pts, hit1, hit2);
  const replacements: Drawing2D[] = pieces.map((pts) => ({
    ...target,
    id: uniqueId("dr2d"),
    geom: chainToGeom({ pts, closed: false }),
  }));
  // Ziel raus, Stücke hinten dran.
  return [...removeItems(p, "drawings2d", [target.id]), ...addItems("drawings2d", replacements)];
}

/** Vorschau der Reststücke (für den Draft). */
function breakPreview(target: Drawing2D, p1: Vec2, p2: Vec2): DraftShape[] {
  const curve = geomToCurve(target.geom);
  if (!curve) return [];
  const hit1 = nearestOnPolyline(curve.pts, false, p1);
  const hit2 = nearestOnPolyline(curve.pts, false, p2);
  if (!hit1 || !hit2) return [];
  return breakCurve(curve.pts, hit1, hit2)
    .filter((pts) => pts.length >= 2)
    .map((pts) => (pts.length === 2 ? { kind: "line" as const, a: pts[0], b: pts[1] } : { kind: "poly" as const, pts, closed: false }));
}

interface BreakP1 extends CommandState {
  phase: "p1";
}
interface BreakP2 extends CommandState {
  phase: "p2";
  target: Drawing2D;
  p1: Vec2;
  cursor: Vec2 | null;
}
type BreakState = BreakP1 | BreakP2;

const idle = (): [CommandState, CommandResult] => [
  { phase: "p1", lastPoint: null } as BreakP1,
  { draft: null, done: true },
];

export const breakCommand: Command = {
  name: "break",
  labelKey: "cmd.break.label",
  prompt: (s) => ((s as BreakState).phase === "p2" ? "cmd.break.p2" : "cmd.break.p1"),
  accepts: () => ["point"],
  options: () => [],
  init: (): BreakP1 => ({ phase: "p1", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as BreakState;
    if (input.kind !== "point") return [s, { draft: null }];
    if (s.phase === "p1") {
      const target = pickBreakable(ctx.project, ctx.level.id, input.point);
      if (!target) return [s, { draft: null }]; // daneben/ungeeignet → bleibt im ersten Schritt
      const ns: BreakP2 = { phase: "p2", target, p1: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: null }];
    }
    // phase "p2"
    const { target, p1 } = s;
    return [idle()[0], { draft: null, done: true, commit: opsMutation((p) => breakOps(p, target, p1, input.point)) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as BreakState;
    if (s.phase !== "p2") return [s, { draft: null }];
    const ns: BreakP2 = { ...s, cursor: point };
    const preview = breakPreview(s.target, s.p1, point);
    return [ns, { draft: { preview, vertices: [s.p1] } }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
