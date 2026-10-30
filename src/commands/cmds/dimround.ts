// Radius-, Durchmesser- und Bogenlängen-Bemassung ([38]): Klick auf den Rand eines Kreises, Bogens oder
// einer Bogenwand (Fläche oder Achse). Der Kern (`cmd_draw.rs`, `dim_assoc::round_dimension`) findet den
// Kreis, setzt Mittelpunkt und Randpunkte und hängt sie daran (Bezug `center`/`rim`): Verschieben oder
// Vergrössern des Kreises, Strecken der Bogenwand führt das Mass nach. Radius und Durchmesser: ein Klick;
// Bogenlänge: Anfang, Ende (gegen den Uhrzeigersinn), dann Lage der Masslinie.

import type { Command, CommandContext, CommandResult, CommandState, ToolDraft, Vec2 } from "../types";
import { createMutation, createPreview, xy } from "../createCore";

export type RoundKind = "radius" | "diameter" | "arc";

interface RoundState extends CommandState {
  phase: "first" | "second" | "offset";
  pts: Vec2[];
}

const fresh = (): RoundState => ({ phase: "first", lastPoint: null, pts: [] });
const idle = (): [CommandState, CommandResult] => [fresh(), { draft: null, done: true }];

/** Fangtoleranz auf dem Rand (Modell-Meter). */
const TOL = 0.2;

function draft(ctx: CommandContext, kind: RoundKind, pts: Vec2[], cursor: Vec2 | null): ToolDraft | null {
  const all = cursor ? [...pts, cursor] : pts;
  if (all.length === 0) return null;
  const pv = createPreview(ctx, { cmd: "dimround", kind, tol: TOL }, all);
  return { preview: pv.shapes, vertices: pts };
}

function make(kind: RoundKind, name: string): Command {
  const keyOf = (s: RoundState) => (s.phase === "first" ? `cmd.${name}.first` : s.phase === "second" ? `cmd.${name}.second` : `cmd.${name}.offset`);
  return {
    name,
    labelKey: `cmd.${name}.label` as never,
    prompt: (s) => keyOf(s as RoundState) as never,
    accepts: () => ["point"],
    options: () => [],
    init: fresh,

    onInput: (state, input, ctx): [CommandState, CommandResult] => {
      const s = state as RoundState;
      if (input.kind !== "point") return [s, { draft: null }];
      const pts = [...s.pts, input.point];
      if (kind !== "arc" || s.phase === "offset") {
        const commit = createMutation(ctx, { cmd: "dimround", kind, tol: TOL, pts: pts.slice(0, kind === "arc" ? 2 : 1).map(xy), side: kind === "arc" ? xy(input.point) : null });
        return [fresh(), { draft: null, done: true, commit }];
      }
      const ns: RoundState = { phase: pts.length >= 2 ? "offset" : "second", pts, lastPoint: input.point };
      return [ns, { draft: draft(ctx, kind, pts, null) }];
    },

    onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => [state, { draft: draft(ctx, kind, (state as RoundState).pts, point) }],
    onConfirm: () => idle(),
    onCancel: () => idle(),
  };
}

export const radiusDimCommand = make("radius", "dimradius");
export const diameterDimCommand = make("diameter", "dimdiameter");
export const arcDimCommand = make("arc", "dimarc");
