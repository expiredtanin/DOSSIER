// Block einfügen — platziert eine Instanz einer vorhandenen Block-Definition
// (`Project.blockDefs`, s. `defblock`). Welche Definition aktiv ist, zyklt
// über eine Inline-Option (persistent über Aufrufe, wie `count` bei
// Multiline). Schritte:
//   1) „Einfügepunkt:"        → Punkt
//   2) „Drehwinkel/Grösse:"   → Punkt (Richtung + Abstand vom Einfügepunkt;
//      Klick auf denselben Punkt = 0°/Grösse 1) → commit. Ohne definierte
//      Blöcke: No-Op.
//
// EIN Punkt bestimmt beide Werte gleichzeitig (Winkel UND Abstand) — dieselbe
// Zieh-Geste, die die Live-Vorschau ohnehin schon als HUD anzeigt (L/W-Box,
// s. `segmentHud`): `L` (Länge) war bisher rein kosmetisch (nur `W`/Winkel
// wirkte), jetzt wird sie zum Skalierungsfaktor (Abstand in Metern = Faktor,
// wie bei `circle.ts`s Radius-Punkt). Kein separater dritter Klick-Schritt
// nötig — Nutzer-Wunsch „Skalierung beim Einfügen" bei minimaler UX-Änderung.

import { segmentHud } from "../../tools/types";
import type {
  CmdOption,
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  Vec2,
} from "../types";
import { createMutation } from "../createCore";

const EPS = 1e-6;

let lastDefIndex = 0;

interface BlockPoint extends CommandState {
  phase: "point";
  defIds: string[];
  defNames: string[];
}
interface BlockRotate extends CommandState {
  phase: "rotate";
  defIds: string[];
  defNames: string[];
  at: Vec2;
  cursor: Vec2 | null;
}
type BlockState = BlockPoint | BlockRotate;

const DEF_OPTION: CmdOption = { id: "def", labelKey: "cmd.block.def" };

function readDefs(ctx: CommandContext): { ids: string[]; names: string[] } {
  const defs = ctx.project.blockDefs ?? [];
  return { ids: defs.map((d) => d.id), names: defs.map((d) => d.name) };
}

/**
 * Commit (Kern, `cmd_draw.rs`): Block-Instanz am Einfügepunkt; der zweite Punkt gibt Drehung (Richtung)
 * und Massstab (Abstand) — derselbe Punkt: unskaliert, ungedreht.
 */
const appendInstance = (blockDefId: string, at: Vec2, pt: Vec2, ctx: CommandContext) =>
  createMutation(ctx, { cmd: "block", def: blockDefId, at, pt });

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null, defIds: [], defNames: [] } as BlockPoint,
  { draft: null, done: true },
];

export const blockCommand: Command = {
  name: "block",
  labelKey: "cmd.block.label",
  prompt: (s) => ((s as BlockState).phase === "rotate" ? "cmd.block.rotate" : "cmd.block.point"),
  accepts: () => ["point", "option"],
  options: (state) => {
    const s = state as BlockState;
    const i = s.defIds.length ? lastDefIndex % s.defIds.length : 0;
    return s.defIds.length ? [{ ...DEF_OPTION, value: s.defNames[i] }] : [];
  },
  init: (): BlockPoint => ({ phase: "point", lastPoint: null, defIds: [], defNames: [] }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as BlockState;
    const { ids, names } = readDefs(ctx);

    if (input.kind === "option") {
      if (input.id === "def" && ids.length) lastDefIndex = (lastDefIndex + 1) % ids.length;
      return [{ ...s, defIds: ids, defNames: names } as BlockState, { draft: null }];
    }
    if (input.kind !== "point") return [{ ...s, defIds: ids, defNames: names } as BlockState, { draft: null }];

    if (s.phase === "point") {
      if (ids.length === 0) return idle();
      const ns: BlockRotate = { phase: "rotate", defIds: ids, defNames: names, at: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: { preview: [], vertices: [input.point] } }];
    }

    // phase "rotate": Klick auf denselben Punkt = 0°/Grösse 1 (kein Rückschritt
    // zum bisherigen Verhalten für alle, denen Richtung/Grösse egal ist).
    const blockDefId = s.defIds[lastDefIndex % s.defIds.length];
    const { at } = s;
    const pt = input.point;
    return [idle()[0], { draft: null, done: true, commit: appendInstance(blockDefId, at, pt, ctx) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as BlockState;
    const { ids, names } = readDefs(ctx);
    if (s.phase === "rotate") {
      const ns: BlockRotate = { ...s, defIds: ids, defNames: names, cursor: point };
      const preview =
        Math.hypot(point.x - s.at.x, point.y - s.at.y) < EPS
          ? []
          : [{ kind: "line" as const, a: s.at, b: point }];
      return [ns, { draft: { preview, vertices: [s.at], hud: segmentHud(s.at, point) } }];
    }
    return [{ ...s, defIds: ids, defNames: names } as BlockState, { draft: null }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
