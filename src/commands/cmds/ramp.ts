// [281] Rampe — Decke mit Neigung als eigener Befehl: Umriss (wie „Decke"), dann die Gefällelinie (Anfang auf
// Geschosshöhe, Ende) und das Gefälle in %. Der Kern (`cmd_create.rs`, `ramp`) legt eine Decke mit `slope`
// ({from, to, rise, ramp: true}) und OK am Anfang auf dem Geschossboden an.
// Schritte:
//   1) „Erster Umrisspunkt der Rampe:" → Punkt
//   2) „Nächster Punkt ( Schliessen ):" … Klick auf den Startpunkt, „Schliessen" oder Enter (≥ 3 Punkte)
//   3) „Anfang der Gefällelinie:" → Punkt
//   4) „Ende der Gefällelinie:" → Punkt
//   5) „Gefälle in % (negativ = abwärts) <6>:" → Zahl, Enter = 6 % (SIA 500, rollstuhlgerecht)

import type { Command, CommandContext, CommandResult, CommandState, CmdOption, DraftShape, ToolDraft, Vec2 } from "../types";
import { createMutation, xy } from "../createCore";

const EPS = 1e-6;
const CLOSE_HIT = 0.08;
/** Vorgabe, wenn beim Gefälle nur Enter kommt (SIA 500: höchstens 6 %). */
export const RAMP_DEFAULT_PERCENT = 6;

type Phase = "start" | "next" | "from" | "to" | "percent";
interface RampState extends CommandState {
  phase: Phase;
  points: Vec2[];
  from?: Vec2;
  to?: Vec2;
  cursor: Vec2 | null;
}

const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };

const dist = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

function draft(s: RampState): ToolDraft {
  const closed = s.phase !== "start" && s.phase !== "next";
  const pts = !closed && s.cursor ? [...s.points, s.cursor] : s.points;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: closed || pts.length >= 3 }];
  const a = s.from;
  const b = s.to ?? (s.phase === "to" ? s.cursor : null);
  if (a && b) preview.push({ kind: "poly", pts: [a, b], closed: false });
  const d: ToolDraft = { preview, vertices: s.points };
  if (a && b && dist(a, b) > EPS) d.hud = { at: b, text: `${dist(a, b).toFixed(2)} m` };
  return d;
}

const idle = (): RampState => ({ phase: "start", points: [], cursor: null, lastPoint: null });

function commit(s: RampState, percent: number, ctx: CommandContext): [CommandState, CommandResult] {
  const req = { cmd: "ramp", pts: s.points.map(xy), from: xy(s.from!), to: xy(s.to!), percent };
  return [idle(), { draft: null, done: true, commit: createMutation(ctx, req) }];
}

const closeOutline = (s: RampState): [CommandState, CommandResult] => {
  const ns: RampState = { ...s, phase: "from", cursor: null, lastPoint: null };
  return [ns, { draft: draft(ns) }];
};

export const rampCommand: Command = {
  name: "ramp",
  labelKey: "cmd.ramp.label",
  floorOnly: true,
  prompt: (st) => {
    const p = (st as RampState).phase;
    return p === "start" ? "cmd.ramp.start" : p === "next" ? "cmd.ramp.next" : p === "from" ? "cmd.ramp.from" : p === "to" ? "cmd.ramp.to" : "cmd.ramp.percent";
  },
  accepts: (st) => {
    const p = (st as RampState).phase;
    return p === "percent" ? ["number"] : p === "next" ? ["point", "number", "option"] : ["point", "number"];
  },
  options: (st) => {
    const s = st as RampState;
    if (s.phase !== "next") return [];
    return s.points.length >= 3 ? [CLOSE, UNDO] : [UNDO];
  },
  init: () => idle(),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RampState;
    if (input.kind === "option") {
      if (s.phase !== "next") return [s, { draft: draft(s) }];
      if (input.id === "undo") {
        const points = s.points.slice(0, -1);
        if (points.length === 0) return [idle(), { draft: null }];
        const ns = { ...s, points, lastPoint: points[points.length - 1] };
        return [ns, { draft: draft(ns) }];
      }
      if (input.id === "close" && s.points.length >= 3) return closeOutline(s);
      return [s, { draft: draft(s) }];
    }
    if (s.phase === "percent") {
      if (input.kind !== "number" || !isFinite(input.value) || input.value === 0) return [s, { draft: draft(s) }];
      return commit(s, input.value, ctx);
    }
    if (input.kind !== "point") return [s, { draft: s.phase === "start" ? null : draft(s) }];
    const pt = input.point;
    switch (s.phase) {
      case "start": {
        const ns: RampState = { phase: "next", points: [pt], cursor: pt, lastPoint: pt };
        return [ns, { draft: draft(ns) }];
      }
      case "next": {
        if (s.points.length >= 3 && dist(s.points[0], pt) < CLOSE_HIT) return closeOutline(s);
        if (dist(s.points[s.points.length - 1], pt) < EPS) return [s, { draft: draft(s) }];
        const ns: RampState = { ...s, points: [...s.points, pt], cursor: pt, lastPoint: pt };
        return [ns, { draft: draft(ns) }];
      }
      case "from": {
        const ns: RampState = { ...s, phase: "to", from: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: draft(ns) }];
      }
      default: {
        if (!s.from || dist(s.from, pt) < 0.01) return [s, { draft: draft(s) }];
        const ns: RampState = { ...s, phase: "percent", to: pt, cursor: null, lastPoint: pt };
        return [ns, { draft: draft(ns) }];
      }
    }
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as RampState;
    if (s.phase === "start") return [s, { draft: null }];
    const ns: RampState = { ...s, cursor: point };
    return [ns, { draft: draft(ns) }];
  },

  // Enter: Umriss schliessen (≥ 3 Punkte) bzw. beim Gefälle die Vorgabe übernehmen.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as RampState;
    if (s.phase === "next" && s.points.length >= 3) return closeOutline(s);
    if (s.phase === "percent") return commit(s, RAMP_DEFAULT_PERCENT, ctx);
    return [idle(), { draft: null, done: true }];
  },
  onCancel: (): [CommandState, CommandResult] => [idle(), { draft: null, done: true }],
};
