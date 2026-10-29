// Massstabsbalken (Nutzer-Wunsch: „kein Massstabsbalken existiert"). Schritte:
//   1) „Punkt (linke untere Ecke):" → Punkt → commit mit den aktuellen
//      Segmentlänge-/Anzahl-Optionen (persistieren über Aufrufe hinweg, wie
//      `lastSides` bei `polygon.ts`).
// Segmentlänge + Anzahl per Option (zyklisch, tippbar als „l"/„n").

import type {
  CmdOption,
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview } from "../createCore";

const LENGTH_PRESETS = [0.5, 1, 2, 5, 10, 20, 50];
let lastLength = 1;
const nextLength = (): number => LENGTH_PRESETS[(LENGTH_PRESETS.indexOf(lastLength) + 1) % LENGTH_PRESETS.length];

const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 8;
let lastSegments = 5;

const LENGTH_OPTION: CmdOption = { id: "length", labelKey: "cmd.scalebar.length" };
const SEGMENTS_OPTION: CmdOption = { id: "segments", labelKey: "cmd.scalebar.segments" };

interface ScalebarIdle extends CommandState {
  phase: "point";
}
type ScalebarState = ScalebarIdle;

/** Vorschau: abwechselnd gefüllte/leere Rechtecke, wie das Rendering (grob, ohne Beschriftung). */
/** Vorschau (Kern, `cmd_draw.rs`): Segment-Balken am Cursor + HUD (Länge × Anzahl). */
function pointDraft(ctx: CommandContext, at: Vec2): ToolDraft {
  return {
    preview: createPreview(ctx, { cmd: "scalebar", length: lastLength, segments: lastSegments }, [at]).shapes,
    vertices: [at],
    hud: { at, text: `${lastLength}m × ${lastSegments} = ${(lastLength * lastSegments).toFixed(1)}m` },
  };
}

/** Commit (Kern): Massstabsbalken mit Segmentlänge und -anzahl. */
const appendScalebar = (at: Vec2, ctx: CommandContext) =>
  createMutation(ctx, { cmd: "scalebar", at, length: lastLength, segments: lastSegments });

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null } as ScalebarIdle,
  { draft: null, done: true },
];

export const scalebarCommand: Command = {
  name: "scalebar",
  labelKey: "cmd.scalebar.label",
  prompt: () => "cmd.scalebar.point",
  accepts: () => ["point", "option"],
  options: () => [
    { ...LENGTH_OPTION, value: `${lastLength}m` },
    { ...SEGMENTS_OPTION, value: String(lastSegments) },
  ],
  init: (): ScalebarIdle => ({ phase: "point", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ScalebarState;
    if (input.kind === "option") {
      if (input.id === "length") lastLength = nextLength();
      else if (input.id === "segments") {
        lastSegments = lastSegments >= MAX_SEGMENTS ? MIN_SEGMENTS : lastSegments + 1;
      }
      return [s, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    return [idle()[0], { draft: null, done: true, commit: appendScalebar(input.point, ctx) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => [state, { draft: pointDraft(ctx, point) }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
