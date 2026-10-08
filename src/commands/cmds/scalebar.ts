// Massstabsbalken (Nutzer-Wunsch: „kein Massstabsbalken existiert"). Schritte:
//   1) „Punkt (linke untere Ecke):" → Punkt → commit mit den aktuellen
//      Segmentlänge-/Anzahl-Optionen (persistieren über Aufrufe hinweg, wie
//      `lastSides` bei `polygon.ts`).
// Segmentlänge + Anzahl per Option (zyklisch, tippbar als „l"/„n").

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  CmdOption,
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

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
function pointDraft(at: Vec2): ToolDraft {
  const h = lastLength * 0.06; // rein optische Balkenhöhe für die Vorschau
  const preview: DraftShape[] = [];
  for (let i = 0; i < lastSegments; i++) {
    const x0 = at.x + i * lastLength;
    const x1 = x0 + lastLength;
    preview.push({
      kind: "poly",
      pts: [
        { x: x0, y: at.y },
        { x: x1, y: at.y },
        { x: x1, y: at.y + h },
        { x: x0, y: at.y + h },
      ],
      closed: true,
    });
  }
  return {
    preview,
    vertices: [at],
    hud: { at, text: `${lastLength}m × ${lastSegments} = ${(lastLength * lastSegments).toFixed(1)}m` },
  };
}

function appendScalebar(p: Project, at: Vec2, ctx: CommandContext): Project {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "scalebar", at, segmentLength: lastLength, segments: lastSegments },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

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
    return [idle()[0], { draft: null, done: true, commit: (p) => appendScalebar(p, input.point, ctx) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => [state, { draft: pointDraft(point) }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
