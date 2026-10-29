// Text — modellverankerter Einzeltext als 2D-Element. Schritte:
//   1) „Ankerpunkt:" → Punkt (Position im Modell)
//   Committet SOFORT ein leeres Text-Element und meldet `focusDrawingId` —
//   die UI (PlanView) öffnet daraufhin direkt den Inline-Rich-Text-Editor AUF
//   der Zeichenfläche (kein Dialog, keine Befehlszeilen-Eingabe). Ohne
//   Spaltenbreite bricht der Text NICHT automatisch um: einzeilig, bis der
//   Nutzer selbst Enter drückt (siehe `textbox` fürs InDesign-artige
//   Wortumbruch-Textfeld). Bleibt der Editor leer, verwirft `commitTextEdit`
//   (App.tsx) das Element wieder.

import { uniqueId } from "../../tools/types";
import type { Command, CommandContext, CommandResult, CommandState, Vec2 } from "../types";
import { createMutation } from "../createCore";


interface TextIdle extends CommandState {
  phase: "point";
}
type TextState = TextIdle;

/** Commit (Kern, `cmd_draw.rs`): leere Textzeile am Anker (Höhe 0.25 m), mit vorab vergebener id. */
const appendEmptyText = (id: string, at: Vec2, ctx: CommandContext) => createMutation(ctx, { cmd: "text", id, at });

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
        commit: appendEmptyText(id, at, ctx),
        focusDrawingId: id,
      },
    ];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
