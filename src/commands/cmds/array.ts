// Array (Feld) — dupliziert die AKTUELLE Auswahl `count`-mal entlang eines
// Vektors, in EINER Geste (baut auf dem bestehenden Transform-Modus
// `"array"` auf, der bisher nie über einen Befehl erreichbar war — s.
// `tools/transform.ts::copyTs`). Schritte:
//   1) „Basispunkt:"  → Punkt
//   2) „Zielpunkt ( Anzahl ):" → Punkt/Zahl (Tab length/angle) → committet
//      ALLE `count` Kopien auf einmal (Original bleibt). „Anzahl" (Option,
//      persistent über Aufrufe wie bei Multiline) zyklt 2..12.
//
// Die Auswahl kommt vorab über ctx.selection (erst selektieren, dann Befehl,
// wie move/copy). Leere Auswahl → No-op.

import { commitTransform, transformPreview } from "../../tools/transform";
import type { TransformSelection } from "../../tools/transform";
import type {
  CmdOption,
  Command,
  CommandField,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const DEG = Math.PI / 180;
const MIN_COUNT = 2;
const MAX_COUNT = 12;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Persistente Anzahl über Aufrufe hinweg (wie `lastCount` bei Multiline). */
let lastCount = 3;

const ARRAY_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];
const COUNT_OPTION: CmdOption = { id: "count", labelKey: "cmd.array.count" };

function targetFromFields(base: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? base;
  const length = "length" in locks ? locks.length : segLen(base, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(base, ref);
  const ang = angleDeg * DEG;
  return { x: base.x + Math.cos(ang) * length, y: base.y + Math.sin(ang) * length };
}

function hasSelection(sel: CommandSelection): boolean {
  return sel.wallIds.length > 0 || sel.drawingId !== null || !!sel.extrudedSolidId || !!sel.columnId;
}
function toTransformSel(sel: CommandSelection): TransformSelection {
  return {
    wallIds: sel.wallIds,
    drawingId: sel.drawingId,
    extrudedSolidId: sel.extrudedSolidId,
    columnId: sel.columnId,
  };
}

interface ArrBase extends CommandState {
  phase: "base";
}
interface ArrTarget extends CommandState {
  phase: "target";
  sel: CommandSelection;
  base: Vec2;
  cursor: Vec2 | null;
}
type ArrState = ArrBase | ArrTarget;

/** Vorschau ALLER `lastCount` Kopien bei der aktuellen Cursor-Lage. */
function arrayDraft(project: Project, sel: CommandSelection, base: Vec2, target: Vec2): ToolDraft {
  const preview = transformPreview(project, toTransformSel(sel), "move", [base, target], "array", lastCount);
  return {
    preview,
    vertices: [base],
    hud: {
      at: target,
      text: `${segLen(base, target).toFixed(2)} m × ${lastCount}`,
    },
  };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "base", lastPoint: null } as ArrBase,
  { draft: null, done: true },
];

export const arrayCommand: Command = {
  name: "array",
  labelKey: "cmd.array.label",
  prompt: (s) => ((s as ArrState).phase === "target" ? "cmd.array.target" : "cmd.array.base"),
  accepts: (s) => ((s as ArrState).phase === "target" ? ["point", "number", "option"] : ["point"]),
  options: (s) =>
    (s as ArrState).phase === "target" ? [{ ...COUNT_OPTION, value: String(lastCount) }] : [],
  init: (): ArrBase => ({ phase: "base", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ArrState;
    if (!hasSelection(ctx.selection)) return idle();

    if (s.phase !== "target") {
      if (input.kind !== "point") return [s, { draft: null }];
      const next: ArrTarget = {
        phase: "target",
        sel: ctx.selection,
        base: input.point,
        cursor: input.point,
        lastPoint: input.point,
      };
      return [next, { draft: { preview: [], vertices: [input.point] } }];
    }

    if (input.kind === "option") {
      if (input.id === "count") {
        lastCount = lastCount >= MAX_COUNT ? MIN_COUNT : lastCount + 1;
        return [s, { draft: s.cursor ? arrayDraft(ctx.project, s.sel, s.base, s.cursor) : null }];
      }
      return [s, { draft: null }];
    }

    let target: Vec2 | null = null;
    if (input.kind === "point") target = input.point;
    else if (input.kind === "number") target = { x: s.base.x + input.value, y: s.base.y };
    if (!target || segLen(s.base, target) < 1e-6) return idle();

    const { base, sel } = s;
    return [
      idle()[0],
      { draft: null, done: true, commit: (p) => commitTransform(p, toTransformSel(sel), "move", [base, target!], "array", lastCount) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ArrState;
    if (s.phase !== "target") return [s, { draft: null }];
    const ns: ArrTarget = { ...s, cursor: point };
    return [ns, { draft: arrayDraft(ctx.project, s.sel, s.base, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),

  fields: (state) => ((state as ArrState).phase === "target" ? ARRAY_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as ArrState;
    if (s.phase !== "target") return null;
    return targetFromFields(s.base, locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as ArrState;
    if (s.phase !== "target" || !cursor) return {};
    return {
      length: segLen(s.base, cursor),
      angle: ((segAngleDeg(s.base, cursor) % 360) + 360) % 360,
    };
  },
};
