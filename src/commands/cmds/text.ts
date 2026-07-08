// Text — modellverankerter Einzeltext als 2D-Element. Schritte:
//   1) „Ankerpunkt:" → Punkt (Position im Modell)
//   2) „Text:"        → getippte Zeile (das Label) → commit Drawing2D {shape:"text"}
//
// Der Text-Schritt nimmt Freitext an (accepts:["text"]) — die Engine reicht die
// komplette getippte Zeile 1:1 durch (auch Zahlen/Kommas). Gerendert wird der
// Text in generatePlan als `drawingText` (SVG), analog zum DXF-Import.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  Project,
  Vec2,
} from "../types";

/** Default-Schrifthöhe eines frei platzierten Texts in Modell-Metern. */
const DEFAULT_TEXT_HEIGHT_M = 0.25;

interface TextIdle extends CommandState {
  phase: "point";
}
interface TextLabel extends CommandState {
  phase: "label";
  at: Vec2;
}
type TextState = TextIdle | TextLabel;

function appendText(p: Project, at: Vec2, text: string, ctx: CommandContext): Project {
  const label = text.trim();
  if (label === "") return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "text", at, text: label, height: DEFAULT_TEXT_HEIGHT_M, angle: 0 },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null },
  { draft: null, done: true },
];

export const textCommand: Command = {
  name: "text",
  labelKey: "cmd.text.label",
  prompt: (s) => ((s as TextState).phase === "label" ? "cmd.text.enter" : "cmd.text.point"),
  accepts: (s) => ((s as TextState).phase === "label" ? ["text"] : ["point"]),
  options: () => [],
  init: (): TextIdle => ({ phase: "point", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as TextState;
    if (s.phase !== "label") {
      if (input.kind !== "point") return [s, { draft: null }];
      const ns: TextLabel = { phase: "label", at: input.point, lastPoint: input.point };
      return [ns, { draft: null }];
    }
    if (input.kind !== "text") return [s, { draft: null }];
    const at = s.at;
    return [
      { phase: "point", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendText(p, at, input.text, ctx) },
    ];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
