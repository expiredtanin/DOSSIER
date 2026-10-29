// Block definieren — macht aus der aktuellen 2D-Mehrfachauswahl ein
// wiederverwendbares Symbol (`Project.blockDefs`, s. `model/types.ts`):
// die Quell-Elemente werden ENTFERNT und durch EINE `{shape:"block"}`-Instanz
// ersetzt, die auf die neue, gemeinsame Definition zeigt. Schritte:
//   1) „Basispunkt:" → Punkt (wird zum lokalen Ursprung der Definition UND
//      zum Einfügepunkt der ersetzenden Instanz — die Symbolgeometrie
//      verschiebt sich beim Commit relativ dazu, sieht also unverändert aus).
//
// Enthält die Auswahl bereits eine Block-Instanz, wird sie ignoriert (keine
// verschachtelten Blöcke, v1 — s. `BlockDef`-Kopfkommentar in model/types.ts).
// Leere/rein-block-Auswahl → No-Op (kein Commit).

import { cmdMutation } from "../../core/document";
import { uniqueStamp } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandSelection,
  CommandState,
  Vec2,
} from "../types";

function selectedDrawingIds(sel: CommandSelection): string[] {
  if (sel.drawingIds && sel.drawingIds.length) return sel.drawingIds;
  return sel.drawingId ? [sel.drawingId] : [];
}

/** Definition anhängen, Quellen raus, Instanz hinten dran — rechnet der Kern (`cmd_transform::defblock_ops`). */
function defineMutation(ids: string[], at: Vec2, ctx: CommandContext) {
  return cmdMutation({
    cmd: "defblock",
    ids,
    at: [at.x, at.y],
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    stamp: uniqueStamp(),
  });
}

interface DefblockState extends CommandState {
  phase: "base";
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "base", lastPoint: null } as DefblockState,
  { draft: null, done: true },
];

export const defblockCommand: Command = {
  name: "defblock",
  labelKey: "cmd.defblock.label",
  prompt: () => "cmd.defblock.base",
  accepts: () => ["point"],
  options: () => [],
  init: (): DefblockState => ({ phase: "base", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    if (input.kind !== "point") return [state, { draft: null }];
    const ids = selectedDrawingIds(ctx.selection);
    if (ids.length === 0) return idle();
    const at = input.point;
    return [idle()[0], { draft: null, done: true, commit: defineMutation(ids, at, ctx) }];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
