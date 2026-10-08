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

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
import type {
  CmdOption,
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  Project,
  Vec2,
} from "../types";

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

function appendInstance(
  p: Project,
  blockDefId: string,
  at: Vec2,
  rotation: number,
  scale: number,
  ctx: CommandContext,
): Project {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "block", blockDefId, at, rotation, scale },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

/** Drehwinkel + Skalierungsfaktor aus DEMSELBEN Punkt: Klick auf `at` = (0, 1). */
function rotationAndScaleFrom(at: Vec2, pt: Vec2): { rotation: number; scale: number } {
  const d = Math.hypot(pt.x - at.x, pt.y - at.y);
  if (d < EPS) return { rotation: 0, scale: 1 };
  return { rotation: Math.atan2(pt.y - at.y, pt.x - at.x), scale: d };
}

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
    const { rotation, scale } = rotationAndScaleFrom(at, pt);
    return [
      idle()[0],
      { draft: null, done: true, commit: (p) => appendInstance(p, blockDefId, at, rotation, scale, ctx) },
    ];
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
