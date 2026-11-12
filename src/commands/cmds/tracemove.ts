// [205] Pausfolie verschieben / drehen (Archicad „Referenz verschieben/drehen"): ändert nur die Lage der Pause des
// Reiters (UI-Zustand, `state/traceActions.ts`), nie das Modell — `commit` bleibt leer.
//   tracemove:   Basispunkt → Zielpunkt (oder Versatz als Zahl/relativ getippt, wie Bewegen).
//   tracerotate: Drehpunkt → Bezugsrichtung → Zielrichtung (oder Winkel in Grad getippt).

import { moveTraceAction, rotateTraceAction, shownTrace } from "../../state/traceActions";
import type { Command, CommandResult, CommandState, ToolDraft, Vec2 } from "../types";

interface Idle extends CommandState {
  phase: "base";
}
interface Pick1 extends CommandState {
  phase: "second";
  a: Vec2;
  cursor: Vec2 | null;
}
interface Pick2 extends CommandState {
  phase: "third";
  a: Vec2;
  b: Vec2;
  cursor: Vec2 | null;
}
type S = Idle | Pick1 | Pick2;

const START: Idle = { phase: "base", lastPoint: null };
const done = (): [CommandState, CommandResult] => [{ ...START }, { draft: null, done: true }];
const ok = (p: Vec2 | undefined): p is Vec2 => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const deg = (c: Vec2, p: Vec2) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;

function lineDraft(a: Vec2, b: Vec2 | null, c?: Vec2 | null): ToolDraft | null {
  if (!b) return null;
  return { preview: [{ kind: "poly", pts: c ? [b, a, c] : [a, b], closed: false }], vertices: [a] };
}

/** Ohne eingeschaltete Pausfolie startet der Befehl nicht. */
const precondition = () => (shownTrace() ? null : ("cmd.tracemove.none" as const));

export const traceMoveCommand: Command = {
  name: "tracemove",
  labelKey: "cmd.tracemove.label",
  prompt: (s) => ((s as S).phase === "second" ? "cmd.tracemove.to" : "cmd.tracemove.from"),
  accepts: (s) => ((s as S).phase === "second" ? ["point", "number"] : ["point"]),
  options: () => [],
  precondition,
  init: () => ({ ...START }),
  onInput: (state, input): [CommandState, CommandResult] => {
    const s = state as S;
    if (s.phase === "second" && input.kind === "number" && Number.isFinite(input.value) && s.cursor) {
      // Distanz in Richtung des Cursors.
      const dx = s.cursor.x - s.a.x;
      const dy = s.cursor.y - s.a.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-12) moveTraceAction({ x: (dx / len) * input.value, y: (dy / len) * input.value });
      return done();
    }
    if (input.kind !== "point" || !ok(input.point)) return [s, { draft: null }];
    if (s.phase === "base") return [{ phase: "second", a: input.point, cursor: null, lastPoint: input.point } as Pick1, { draft: null }];
    if (s.phase === "second") {
      moveTraceAction({ x: input.point.x - s.a.x, y: input.point.y - s.a.y });
      return done();
    }
    return done();
  },
  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as S;
    if (s.phase !== "second" || !ok(point)) return [s, { draft: null }];
    return [{ ...s, cursor: point } as S, { draft: lineDraft(s.a, point) }];
  },
  onConfirm: () => done(),
  onCancel: () => done(),
};

export const traceRotateCommand: Command = {
  name: "tracerotate",
  labelKey: "cmd.tracerotate.label",
  prompt: (s) => {
    const p = (s as S).phase;
    return p === "base" ? "cmd.tracerotate.center" : p === "second" ? "cmd.tracerotate.ref" : "cmd.tracerotate.to";
  },
  accepts: (s) => ((s as S).phase === "base" ? ["point"] : ["point", "number"]),
  options: () => [],
  precondition,
  init: () => ({ ...START }),
  onInput: (state, input): [CommandState, CommandResult] => {
    const s = state as S;
    if (s.phase !== "base" && input.kind === "number" && Number.isFinite(input.value)) {
      // Winkel getippt: Drehung um den Drehpunkt um so viele Grad (CCW).
      rotateTraceAction(s.a, input.value);
      return done();
    }
    if (input.kind !== "point" || !ok(input.point)) return [s, { draft: null }];
    if (s.phase === "base") return [{ phase: "second", a: input.point, cursor: null, lastPoint: input.point } as Pick1, { draft: null }];
    if (s.phase === "second") {
      if (Math.hypot(input.point.x - s.a.x, input.point.y - s.a.y) < 1e-9) return [s, { draft: null }];
      return [{ phase: "third", a: s.a, b: input.point, cursor: null, lastPoint: input.point } as Pick2, { draft: null }];
    }
    if (Math.hypot(input.point.x - s.a.x, input.point.y - s.a.y) < 1e-9) return [s, { draft: null }];
    rotateTraceAction(s.a, deg(s.a, input.point) - deg(s.a, s.b));
    return done();
  },
  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as S;
    if (s.phase === "base" || !ok(point)) return [s, { draft: null }];
    if (s.phase === "second") return [{ ...s, cursor: point } as S, { draft: lineDraft(s.a, point) }];
    return [{ ...s, cursor: point } as S, { draft: lineDraft(s.a, s.b, point) }];
  },
  onConfirm: () => done(),
  onCancel: () => done(),
};
