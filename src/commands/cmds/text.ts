// Text — modellverankerter Einzeltext als 2D-Element. Schritte:
//   1) „Ankerpunkt:" → Punkt (Position im Modell)
//   Committet SOFORT ein leeres Text-Element und meldet `focusDrawingId` —
//   die UI (PlanView) öffnet daraufhin direkt den Inline-Rich-Text-Editor AUF
//   der Zeichenfläche (kein Dialog, keine Befehlszeilen-Eingabe). Ohne
//   Spaltenbreite bricht der Text NICHT automatisch um: einzeilig, bis der
//   Nutzer selbst Enter drückt (siehe `textbox` fürs InDesign-artige
//   Wortumbruch-Textfeld). Bleibt der Editor leer, verwirft `commitTextEdit`
//   (App.tsx) das Element wieder.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type { Command, CommandContext, CommandResult, CommandState, Vec2 } from "../types";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

/** Default-Schrifthöhe eines frei platzierten Texts in Modell-Metern. */
const DEFAULT_TEXT_HEIGHT_M = 0.25;

interface TextIdle extends CommandState {
  phase: "point";
}
type TextState = TextIdle;

function appendEmptyText(id: string, at: Vec2, ctx: CommandContext): CoreOp[] {
  const d: Drawing2D = {
    id,
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "text", at, text: "", height: DEFAULT_TEXT_HEIGHT_M, angle: 0 },
  };
  return addItems("drawings2d", [d]);
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null } as TextIdle,
  { draft: null, done: true },
];

export const textCommand: Command = {
  name: "text",
  labelKey: "cmd.text.label",
  prompt: () => "cmd.text.point",
  accepts: () => ["point"],
  options: () => [],
  init: (): TextIdle => ({ phase: "point", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as TextState;
    if (input.kind !== "point") return [s, { draft: null }];
    const id = uniqueId("dr2d");
    const at = input.point;
    return [
      { phase: "point", lastPoint: null } as TextIdle,
      {
        draft: null,
        done: true,
        commit: opsMutation(() => appendEmptyText(id, at, ctx)),
        focusDrawingId: id,
      },
    ];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
