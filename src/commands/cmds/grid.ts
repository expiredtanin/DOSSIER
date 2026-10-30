// Achsraster ([112]): Ursprung klicken, dann die Feldweiten als Text (`6 4.5 3x5`: Zahlen, `N x W` =
// N Felder zu W). Rechtwinklig: erst die Richtung 1, 2, 3 …, dann A, B, C …; radial: Strahlwinkel in
// Grad und Ringabstände. Das Raster ist eine 2D-Zeichnung (Kern, `grid.rs`): Achsen mit Blasen in
// allen Plänen, Schnitten und Ansichten, Fang auf Achsen und Schnittpunkte, Griffe je Achse.

import type { Command, CommandContext, CommandResult, CommandState, CmdOption, ToolDraft, Vec2 } from "../types";
import { createMutation, createPreview, xy } from "../createCore";

type Phase = "origin" | "xs" | "ys";

interface GridState extends CommandState {
  phase: Phase;
  origin: Vec2 | null;
  radial: boolean;
  xs: string;
  ys: string;
}

const DEFAULTS = {
  ortho: { xs: "6 6 6", ys: "6 6" },
  radial: { xs: "4x45", ys: "3 3 3" },
};

const RADIAL: CmdOption = { id: "radial", labelKey: "cmd.grid.radial" };

const start = (radial = false): GridState => ({
  phase: "origin",
  lastPoint: null,
  origin: null,
  radial,
  xs: radial ? DEFAULTS.radial.xs : DEFAULTS.ortho.xs,
  ys: radial ? DEFAULTS.radial.ys : DEFAULTS.ortho.ys,
});

const idle = (): [CommandState, CommandResult] => [start(), { draft: null, done: true }];

/** Vorschau (Kern): die Achsen des Rasters am Cursor. */
function draft(ctx: CommandContext, s: GridState, at: Vec2): ToolDraft {
  const pv = createPreview(ctx, { cmd: "grid", xs: s.xs, ys: s.ys, radial: s.radial, angle: 0 }, [at]);
  return { preview: pv.shapes, vertices: [at] };
}

const commit = (ctx: CommandContext, s: GridState, ys: string) =>
  createMutation(ctx, { cmd: "grid", at: xy(s.origin as Vec2), xs: s.xs, ys, radial: s.radial, angle: 0 });

export const gridCommand: Command = {
  name: "grid",
  labelKey: "cmd.grid.label",
  prompt: (state) => {
    const s = state as GridState;
    if (s.phase === "origin") return "cmd.grid.origin";
    if (s.phase === "xs") return s.radial ? "cmd.grid.xsRadial" : "cmd.grid.xs";
    return s.radial ? "cmd.grid.ysRadial" : "cmd.grid.ys";
  },
  accepts: (state) => ((state as GridState).phase === "origin" ? ["point", "option"] : ["text"]),
  options: (state): CmdOption[] => ((state as GridState).phase === "origin" ? [{ ...RADIAL, value: (state as GridState).radial ? "ja" : "nein" }] : []),
  floorOnly: false,
  init: () => start(),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as GridState;
    if (s.phase === "origin") {
      if (input.kind === "option" && input.id === "radial") return [start(!s.radial), { draft: null }];
      if (input.kind !== "point") return [s, { draft: null }];
      const ns: GridState = { ...s, phase: "xs", origin: input.point, lastPoint: input.point };
      return [ns, { draft: draft(ctx, ns, input.point) }];
    }
    if (input.kind !== "text") return [s, { draft: null }];
    const text = input.text.trim();
    if (s.phase === "xs") {
      const ns: GridState = { ...s, phase: "ys", xs: text === "" ? s.xs : text };
      return [ns, { draft: s.origin ? draft(ctx, ns, s.origin) : null }];
    }
    const ys = text === "" && !s.radial ? s.ys : text;
    return [start(), { draft: null, done: true, commit: commit(ctx, s, ys) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as GridState;
    if (s.phase !== "origin") return [s, { draft: s.origin ? draft(ctx, s, s.origin) : null }];
    return [s, { draft: draft(ctx, s, point) }];
  },

  // Enter: Vorgabe-Feldweiten übernehmen.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as GridState;
    if (s.phase === "origin") return idle();
    if (s.phase === "xs") {
      const ns: GridState = { ...s, phase: "ys" };
      return [ns, { draft: s.origin ? draft(ctx, ns, s.origin) : null }];
    }
    return [start(), { draft: null, done: true, commit: commit(ctx, s, s.ys) }];
  },
  onCancel: () => idle(),
};
