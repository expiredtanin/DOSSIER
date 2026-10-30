// Loft ([T7]): ≥ 2 geschlossene Plan-Profile nacheinander anklicken (erstes = unten), Enter, dann die
// Gesamthöhe. Die Profile werden gleichmässig über die Höhe verteilt (Kern `cmd_solid.rs`: gleiche
// Punktzahl durch Kantenteilung, Drehsinn angeglichen) und zu einem truck-`loft`-B-Rep-Körper
// (`ExtrudedSolid.brep`) verbunden; die Quellprofile entfallen wie beim Extrudieren.

import type { Command, CommandContext, CommandResult, CommandState, Vec2 } from "../types";
import { createMutation } from "../createCore";
import { pickProfileAt, type ProfileHit } from "./extrude";

let lastHeight = 3;

interface LoftState extends CommandState {
  phase: "pick" | "height" | "done";
  picks: ProfileHit[];
}

const draft = (s: LoftState, cursor: Vec2 | null): CommandResult["draft"] => ({
  preview: s.picks.map((p) => ({ kind: "poly" as const, pts: p.pts, closed: true })),
  vertices: [],
  hud: cursor ? { at: cursor, text: s.phase === "height" ? `${lastHeight.toFixed(2)} m` : `${s.picks.length}` } : undefined,
});

const finished = (): LoftState => ({ phase: "done", picks: [], lastPoint: null });
const done = (): [CommandState, CommandResult] => [finished(), { draft: null, done: true }];

function commit(s: LoftState, height: number, ctx: CommandContext): [CommandState, CommandResult] {
  lastHeight = height;
  return [
    finished(),
    { draft: null, done: true, commit: createMutation(ctx, { cmd: "loft", sources: s.picks.map((p) => p.id), height }) },
  ];
}

export const loftCommand: Command = {
  name: "loft",
  labelKey: "cmd.loft.label",
  prompt: (st) => ((st as LoftState).phase === "height" ? "cmd.loft.height" : (st as LoftState).picks.length < 2 ? "cmd.loft.pick" : "cmd.loft.pickMore"),
  accepts: (st) => ((st as LoftState).phase === "height" ? ["number"] : ["point"]),
  options: () => [],
  floorOnly: true,

  init: (): LoftState => ({ phase: "pick", picks: [], lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as LoftState;
    if (s.phase === "done") return done();
    if (s.phase === "pick") {
      if (input.kind !== "point") return [s, { draft: draft(s, null) }];
      const hit = pickProfileAt(ctx.project, ctx.level.id, input.point);
      if (!hit || s.picks.some((p) => p.id === hit.id)) return [s, { draft: draft(s, null) }];
      const ns: LoftState = { ...s, picks: [...s.picks, hit] };
      return [ns, { draft: draft(ns, input.point) }];
    }
    if (input.kind !== "number" || !(input.value > 0)) return [s, { draft: draft(s, null) }];
    return commit(s, input.value, ctx);
  },

  onMove: (state, point): [CommandState, CommandResult] => [state, { draft: draft(state as LoftState, point) }],

  // Enter: mit ≥ 2 Profilen zur Höhe; bei der Höhe die zuletzt benutzte übernehmen.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as LoftState;
    if (s.phase === "pick") {
      if (s.picks.length < 2) return [s, { draft: draft(s, null) }];
      const ns: LoftState = { ...s, phase: "height" };
      return [ns, { draft: draft(ns, null) }];
    }
    return s.phase === "height" ? commit(s, lastHeight, ctx) : done();
  },
  onCancel: () => done(),
};
