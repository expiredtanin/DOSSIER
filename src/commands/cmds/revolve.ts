// Rotationskörper ([T7]): geschlossenes Plan-Profil + Drehachse (2 Punkte im Plan) + Winkel → truck-
// `revolve` als B-Rep-Körper (`ExtrudedSolid.brep`, Kern `cmd_solid.rs`). Das Profil muss ganz auf einer
// Seite der Achse liegen; die Achse liegt waagrecht auf Höhe des grössten Profilabstands, ein voller
// Körper steht also auf der Geschoss-UK. Die Quelle (Profil) wird ersetzt wie beim Extrudieren.
//
// Schritte: Profil wählen (oder vorselektiert) → Achse Anfang → Achse Ende → Winkel (Zahl oder Enter = zuletzt, 360).

import type { Command, CommandContext, CommandResult, CommandState, Vec2 } from "../types";
import { createMutation } from "../createCore";
import { pickProfileAt, singleSelectedProfile, type Profile } from "./extrude";

let lastAngle = 360;

interface RevState extends CommandState {
  phase: "pick" | "axisA" | "axisB" | "angle" | "done";
  profile: Profile | null;
  sourceId: string | null;
  a: Vec2 | null;
  b: Vec2 | null;
  cursor: Vec2 | null;
}

const draft = (s: RevState, cursor: Vec2 | null): CommandResult["draft"] => {
  const preview: NonNullable<CommandResult["draft"]>["preview"] = [];
  if (s.profile) preview.push({ kind: "poly", pts: s.profile.pts, closed: true });
  const end = s.b ?? cursor;
  if (s.a && end) preview.push({ kind: "line", a: s.a, b: end });
  return { preview, vertices: s.a ? [s.a] : [], hud: cursor && s.phase === "angle" ? { at: cursor, text: `${lastAngle}°` } : undefined };
};

const finished = (): RevState => ({ phase: "done", profile: null, sourceId: null, a: null, b: null, cursor: null, lastPoint: null });

const done = (): [CommandState, CommandResult] => [finished(), { draft: null, done: true }];

function commit(s: RevState, angle: number, ctx: CommandContext): [CommandState, CommandResult] {
  lastAngle = angle;
  return [
    finished(),
    { draft: null, done: true, commit: createMutation(ctx, { cmd: "revolve", source: s.sourceId, a: s.a, b: s.b, angle }) },
  ];
}

export const revolveCommand: Command = {
  name: "revolve",
  labelKey: "cmd.revolve.label",
  prompt: (st) => {
    const p = (st as RevState).phase;
    return p === "axisA" ? "cmd.revolve.axisA" : p === "axisB" ? "cmd.revolve.axisB" : p === "angle" ? "cmd.revolve.angle" : "cmd.revolve.pick";
  },
  accepts: (st) => ((st as RevState).phase === "angle" ? ["number"] : ["point"]),
  options: () => [],
  floorOnly: true,

  init: (): RevState => ({ phase: "pick", profile: null, sourceId: null, a: null, b: null, cursor: null, lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    let s = state as RevState;
    if (s.phase === "done") return done();
    if (s.phase === "pick") {
      if (input.kind !== "point") return [s, { draft: null }];
      // Vorselektiertes Profil: der erste Punkt ist gleich der Achsenanfang.
      const pre = singleSelectedProfile(ctx.project, ctx.selection);
      if (pre) {
        s = { ...s, phase: "axisA", profile: pre, sourceId: pre.id };
      } else {
        const hit = pickProfileAt(ctx.project, ctx.level.id, input.point);
        if (!hit) return [s, { draft: null }];
        const ns: RevState = { ...s, phase: "axisA", profile: hit, sourceId: hit.id };
        return [ns, { draft: draft(ns, null) }];
      }
    }
    if (s.phase === "axisA") {
      if (input.kind !== "point") return [s, { draft: draft(s, s.cursor) }];
      const ns: RevState = { ...s, phase: "axisB", a: input.point, lastPoint: input.point };
      return [ns, { draft: draft(ns, input.point) }];
    }
    if (s.phase === "axisB") {
      if (input.kind !== "point" || !s.a || Math.hypot(input.point.x - s.a.x, input.point.y - s.a.y) < 1e-6) return [s, { draft: draft(s, s.cursor) }];
      const ns: RevState = { ...s, phase: "angle", b: input.point, lastPoint: input.point };
      return [ns, { draft: draft(ns, input.point) }];
    }
    // angle
    if (input.kind !== "number" || !(input.value > 0)) return [s, { draft: draft(s, s.cursor) }];
    return commit(s, Math.min(360, input.value), ctx);
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = { ...(state as RevState), cursor: point };
    return [s, { draft: draft(s, point) }];
  },

  // Enter beim Winkel: zuletzt benutzten Winkel übernehmen.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as RevState;
    return s.phase === "angle" ? commit(s, lastAngle, ctx) : done();
  },
  onCancel: () => done(),
};
