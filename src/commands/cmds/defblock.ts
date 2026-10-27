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

import type { BlockDef, Drawing2D } from "../../model/types";
import { mvGeom } from "../../geometry/geomTransform";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
  Vec2,
} from "../types";

function selectedDrawingIds(sel: CommandSelection): string[] {
  if (sel.drawingIds && sel.drawingIds.length) return sel.drawingIds;
  return sel.drawingId ? [sel.drawingId] : [];
}

function nextBlockName(p: Project): string {
  return `Block ${(p.blockDefs?.length ?? 0) + 1}`;
}

function defineAndReplace(p: Project, ids: string[], at: Vec2, ctx: CommandContext): Project {
  const idSet = new Set(ids);
  // Block-Instanzen als Quelle ausschliessen (keine verschachtelten Blöcke).
  const srcs = p.drawings2d.filter((d) => idSet.has(d.id) && d.geom.shape !== "block");
  if (srcs.length === 0) return p;
  const toLocal = (pt: Vec2): Vec2 => ({ x: pt.x - at.x, y: pt.y - at.y });
  const def: BlockDef = {
    id: uniqueId("blk"),
    name: nextBlockName(p),
    geom2d: srcs.map((d) => mvGeom(d.geom, toLocal)),
  };
  const instance: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "block", blockDefId: def.id, at, rotation: 0 },
  };
  const srcIds = new Set(srcs.map((d) => d.id));
  const rest = p.drawings2d.filter((d) => !srcIds.has(d.id));
  return {
    ...p,
    blockDefs: [...(p.blockDefs ?? []), def],
    drawings2d: [...rest, instance],
  };
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
    return [idle()[0], { draft: null, done: true, commit: (p) => defineAndReplace(p, ids, at, ctx) }];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
