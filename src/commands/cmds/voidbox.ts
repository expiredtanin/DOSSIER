// Durchbruch — legt einen quaderförmigen Abzugskörper an (`ExtrudedSolid.operation =
// "subtract"`, s. `plan/voids.ts`): er zieht sich von allen Wänden, Decken und Stützen ab, die er
// durchdringt (Grundriss, Schnitt, 3D, STEP). Für Leitungsdurchbrüche, Nischen, Schlitze.
//
// Schritte: Ecke → Gegenecke → Höhe → Abstand über Geschoss-UK (Zahl tippen; Enter = 0).
// Beliebige Profile: Polylinie extrudieren und im Objekt-Panel „Abzugskörper" setzen.

import type { Command, CommandContext, CommandResult, CommandState, ToolDraft, Vec2 } from "../types";
import { createMutation, createPreview } from "../createCore";

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

/** Vorschau (Kern): Rechteck mit Diagonalen + HUD (Masse bzw. Höhe/Versatz). */
function draftOf(ctx: CommandContext, s: VoidState): ToolDraft | null {
  if (!s.p0) return null;
  const b = s.p1 ?? s.cursor ?? s.p0;
  return {
    preview: createPreview(ctx, { cmd: "voidbox" }, [s.p0, b]).shapes,
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

/** Commit (Kern, `cmd_solid.rs`): Aussparungs-Quader (subtrahierender Körper) mit Versatz über der UK. */
function finish(s: VoidState, offset: number, ctx: CommandContext): [CommandState, CommandResult] {
  lastOffset = offset;
  // Unvollständige Eingaben (ohne Ecken/Höhe) ergeben im Kern nichts.
  return [reset(), { draft: null, done: true, commit: createMutation(ctx, { cmd: "voidbox", a: s.p0, b: s.p1, height: s.height, offset }) }];
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
      return [ns, { draft: draftOf(ctx, ns) }];
    }
    if (s.step === "corner2" && input.kind === "point") {
      const ns: VoidState = { ...s, step: "height", p1: input.point };
      return [ns, { draft: draftOf(ctx, ns) }];
    }
    if (s.step === "height" && input.kind === "number" && input.value > 0) {
      lastHeight = input.value;
      const ns: VoidState = { ...s, step: "offset", height: input.value };
      return [ns, { draft: draftOf(ctx, ns) }];
    }
    if (s.step === "offset" && input.kind === "number") return finish(s, input.value, ctx);
    return [s, { draft: draftOf(ctx, s) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as VoidState;
    const ns: VoidState = { ...s, cursor: point };
    return [ns, { draft: draftOf(ctx, ns) }];
  },

  // Enter übernimmt die letzten Werte (Höhe bzw. Abstand).
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as VoidState;
    if (s.step === "height") {
      const ns: VoidState = { ...s, step: "offset", height: lastHeight };
      return [ns, { draft: draftOf(ctx, ns) }];
    }
    if (s.step === "offset") return finish(s, lastOffset, ctx);
    return [reset(), { draft: null, done: true }];
  },
  onCancel: (): [CommandState, CommandResult] => [reset(), { draft: null, done: true }],
};
