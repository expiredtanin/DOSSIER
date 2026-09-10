// Block einfügen — platziert eine Instanz einer vorhandenen Block-Definition
// (`Project.blockDefs`, s. `defblock`). Welche Definition aktiv ist, zyklt
// über eine Inline-Option (persistent über Aufrufe, wie `count` bei
// Multiline); Rotation läuft NICHT über dieses Werkzeug, sondern über den
// bestehenden `rotate`-Transform (v1 bewusst nur Position). Schritte:
//   1) „Einfügepunkt:" → Punkt → commit. Ohne definierte Blöcke: No-Op.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  CmdOption,
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  Project,
  Vec2,
} from "../types";

let lastDefIndex = 0;

interface BlockState extends CommandState {
  phase: "point";
  defIds: string[];
  defNames: string[];
}

const DEF_OPTION: CmdOption = { id: "def", labelKey: "cmd.block.def" };

function readDefs(ctx: CommandContext): { ids: string[]; names: string[] } {
  const defs = ctx.project.blockDefs ?? [];
  return { ids: defs.map((d) => d.id), names: defs.map((d) => d.name) };
}

function appendInstance(p: Project, blockDefId: string, at: Vec2, ctx: CommandContext): Project {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "block", blockDefId, at, rotation: 0 },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null, defIds: [], defNames: [] } as BlockState,
  { draft: null, done: true },
];

export const blockCommand: Command = {
  name: "block",
  labelKey: "cmd.block.label",
  prompt: () => "cmd.block.point",
  accepts: () => ["point", "option"],
  options: (state) => {
    const s = state as BlockState;
    const i = s.defIds.length ? lastDefIndex % s.defIds.length : 0;
    return s.defIds.length ? [{ ...DEF_OPTION, value: s.defNames[i] }] : [];
  },
  init: (): BlockState => ({ phase: "point", lastPoint: null, defIds: [], defNames: [] }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as BlockState;
    const { ids, names } = readDefs(ctx);
    const ns: BlockState = { ...s, defIds: ids, defNames: names };
    if (input.kind === "option") {
      if (input.id === "def" && ids.length) lastDefIndex = (lastDefIndex + 1) % ids.length;
      return [ns, { draft: null }];
    }
    if (input.kind !== "point") return [ns, { draft: null }];
    if (ids.length === 0) return idle();
    const blockDefId = ids[lastDefIndex % ids.length];
    const at = input.point;
    return [idle()[0], { draft: null, done: true, commit: (p) => appendInstance(p, blockDefId, at, ctx) }];
  },

  onMove: (state, _point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as BlockState;
    const { ids, names } = readDefs(ctx);
    const ns: BlockState = { ...s, defIds: ids, defNames: names };
    return [ns, { draft: null }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
