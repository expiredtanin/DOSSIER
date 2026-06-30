// Copy — wie Move, aber jeder Zielpunkt fügt eine KOPIE der Auswahl (neue IDs)
// an der Ziellage hinzu; das Original bleibt (Rhino-Copy, docs §2.10). Schritte:
//   1) „Basispunkt:"  → Punkt
//   2) „Zielpunkt:"     → Punkt (Tab length/angle) → Kopie + BLEIBT AKTIV
//      → weitere Zielpunkte = weitere Kopien (Basispunkt bleibt), bis Esc/Enter.
//
// Die Auswahl kommt vorab über ctx.selection. Leere Auswahl → No-op + Hinweis.
// Der Commit nutzt `commitTransform` (op:"move", mode:"copy") — eine Kopie der
// Auswahl an die Endlage, Original unverändert; neue IDs via uniqueId (dort).

import { commitTransform } from "../../tools/transform";
import type { TransformSelection } from "../../tools/transform";
import { transformPreview } from "../../tools/transform";
import type {
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
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Tab-Felder des Zielschritts: Länge + Winkel des Kopier-Versatzes (§2.7). */
const COPY_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

function targetFromFields(base: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? base;
  const length = "length" in locks ? locks.length : segLen(base, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(base, ref);
  const ang = angleDeg * DEG;
  return { x: base.x + Math.cos(ang) * length, y: base.y + Math.sin(ang) * length };
}

function hasSelection(sel: CommandSelection): boolean {
  return sel.wallIds.length > 0 || sel.drawingId !== null;
}
function toTransformSel(sel: CommandSelection): TransformSelection {
  return { wallIds: sel.wallIds, drawingId: sel.drawingId };
}

interface CopyBase extends CommandState {
  phase: "base";
}
interface CopyTarget extends CommandState {
  phase: "target";
  sel: CommandSelection;
  base: Vec2;
  cursor: Vec2 | null;
}
interface CopyDone extends CommandState {
  phase: "done";
}
type CopyState = CopyBase | CopyTarget | CopyDone;

/** Vorschau EINER Kopie der Auswahl an der Cursor-Lage. */
function copyDraft(
  project: Project,
  sel: CommandSelection,
  base: Vec2,
  target: Vec2,
): ToolDraft {
  const preview = transformPreview(
    project,
    toTransformSel(sel),
    "move",
    [base, target],
    "copy",
    1,
  );
  return {
    preview,
    vertices: [base],
    hud: {
      at: target,
      text: `${segLen(base, target).toFixed(2)} m · ${Math.abs(
        (segAngleDeg(base, target) + 360) % 360,
      ).toFixed(0)}°`,
    },
  };
}

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as CopyDone,
  { draft: null, done: true },
];

export const copyCommand: Command = {
  name: "copy",
  labelKey: "cmd.copy.label",
  prompt: (s) => {
    const cs = s as CopyState;
    if (cs.phase === "target") return "cmd.copy.target";
    if (cs.phase === "done") return "cmd.copy.empty";
    return "cmd.copy.base";
  },
  accepts: () => ["point"],
  options: () => [],
  init: (): CopyBase => ({ phase: "base", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as CopyState;
    if (s.phase === "done") return finish();
    if (!hasSelection(ctx.selection)) {
      return [{ phase: "done", lastPoint: null } as CopyDone, { draft: null, done: true }];
    }
    if (input.kind !== "point") {
      if (s.phase === "target") {
        return [s, { draft: s.cursor ? copyDraft(ctx.project, s.sel, s.base, s.cursor) : null }];
      }
      return [s, { draft: null }];
    }
    const pt = input.point;
    if (s.phase !== "target") {
      const next: CopyTarget = {
        phase: "target",
        sel: ctx.selection,
        base: pt,
        cursor: pt,
        lastPoint: pt,
      };
      return [next, { draft: copyDraft(ctx.project, next.sel, pt, pt) }];
    }
    // Zielpunkt → eine Kopie committen, ABER aktiv bleiben (wiederholend): der
    // Befehl kehrt NICHT in den Ruhezustand zurück (kein done), Basispunkt
    // bleibt; jeder weitere Zielpunkt = weitere Kopie, bis Esc/Enter.
    const base = s.base;
    const sel = s.sel;
    const next: CopyTarget = { ...s, cursor: pt, lastPoint: pt };
    return [
      next,
      {
        draft: copyDraft(ctx.project, sel, base, pt),
        commit: (p) => commitTransform(p, toTransformSel(sel), "move", [base, pt], "copy", 1),
      },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as CopyState;
    if (s.phase !== "target") return [s, { draft: null }];
    const ns: CopyTarget = { ...s, cursor: point };
    return [ns, { draft: copyDraft(ctx.project, s.sel, s.base, point) }];
  },

  // Enter/Space/Rechtsklick: Copy-Serie beenden (kein Commit hier).
  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),

  fields: (state) => ((state as CopyState).phase === "target" ? COPY_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as CopyState;
    if (s.phase !== "target") return null;
    return targetFromFields(s.base, locks, cursor);
  },
};
