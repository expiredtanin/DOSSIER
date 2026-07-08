// Move — verschiebt die AKTUELLE Auswahl (Wände + ein Drawing2D) um
// delta = Ziel − Basis (Rhino-Move, docs §2.10/§3.4 Tier-1). Schritte:
//   1) „Basispunkt:"  → Punkt
//   2) „Zielpunkt:"     → Punkt (mit Tab-Feldern length/angle wie Line) → commit
//
// Die Auswahl kommt vorab über ctx.selection (erst selektieren, dann Befehl).
// Ist sie leer, ist nichts zu verschieben: kurzer No-op mit Hinweis-Prompt
// („Nichts gewählt") und Beenden — das ist der einfache, robuste Weg (statt
// einen zweiten, divergierenden Pick-Pfad für die Objektwahl aufzumachen; die
// Selektion läuft schon sauber über die Plan-Ansicht/Store).
//
// Der Commit nutzt den bestehenden, getesteten `commitTransform` (op:"move",
// mode:"move") statt eine zweite Verschiebe-Logik zu duplizieren — er bewegt
// Wände UND alle 2D-Formen immutabel an die Endlage.

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

/** Tab-Felder des Zielschritts: Länge + Winkel des Verschiebevektors (§2.7). */
const MOVE_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

/** Zielpunkt aus gelockten Feldern (length/angle) + Cursor, relativ zum Basispunkt. */
function targetFromFields(base: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? base;
  const length = "length" in locks ? locks.length : segLen(base, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(base, ref);
  const ang = angleDeg * DEG;
  return { x: base.x + Math.cos(ang) * length, y: base.y + Math.sin(ang) * length };
}

/** Hat die Auswahl überhaupt etwas Verschiebbares? */
function hasSelection(sel: CommandSelection): boolean {
  return (
    sel.wallIds.length > 0 ||
    sel.drawingId !== null ||
    !!sel.extrudedSolidId ||
    !!sel.columnId
  );
}

/** Auswahl → TransformSelection (gleiche Form). */
function toTransformSel(sel: CommandSelection): TransformSelection {
  return {
    wallIds: sel.wallIds,
    drawingId: sel.drawingId,
    extrudedSolidId: sel.extrudedSolidId,
    columnId: sel.columnId,
  };
}

// Zustand: erst Basispunkt setzen, dann Ziel (mit Auswahl-Snapshot vom Start).
interface MoveBase extends CommandState {
  phase: "base";
}
interface MoveTarget extends CommandState {
  phase: "target";
  sel: CommandSelection;
  base: Vec2;
  cursor: Vec2 | null;
}
// „done": leere Auswahl → No-op, Befehl beendet.
interface MoveDone extends CommandState {
  phase: "done";
}
type MoveState = MoveBase | MoveTarget | MoveDone;

/** Live-Vorschau der Auswahl an der aktuellen Cursor-Lage (Move). */
function moveDraft(
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
    "move",
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

const idle = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as MoveDone,
  { draft: null, done: true },
];

export const moveCommand: Command = {
  name: "move",
  labelKey: "cmd.move.label",
  prompt: (s) => {
    const ms = s as MoveState;
    if (ms.phase === "target") return "cmd.move.target";
    if (ms.phase === "done") return "cmd.move.empty";
    return "cmd.move.base";
  },
  accepts: () => ["point"],
  options: () => [],

  // Beim Start die Auswahl aus dem Kontext einfrieren — dafür braucht init()
  // den Kontext nicht, das macht onInput beim ersten Aufruf; bis dahin „base".
  // Damit die leere Auswahl SOFORT (vor dem ersten Klick) auffällt, prüfen wir
  // sie zusätzlich im ersten onMove/onInput.
  init: (): MoveBase => ({ phase: "base", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as MoveState;
    if (s.phase === "done") return idle();
    // Leere Auswahl → nichts zu verschieben (No-op + Hinweis, dann beenden).
    if (!hasSelection(ctx.selection)) {
      return [{ phase: "done", lastPoint: null } as MoveDone, { draft: null, done: true }];
    }
    if (input.kind !== "point") {
      if (s.phase === "target") {
        return [s, { draft: s.cursor ? moveDraft(ctx.project, s.sel, s.base, s.cursor) : null }];
      }
      return [s, { draft: null }];
    }
    const pt = input.point;
    if (s.phase !== "target") {
      // Basispunkt gesetzt → Auswahl-Snapshot mitführen.
      const next: MoveTarget = {
        phase: "target",
        sel: ctx.selection,
        base: pt,
        cursor: pt,
        lastPoint: pt,
      };
      return [next, { draft: moveDraft(ctx.project, next.sel, pt, pt) }];
    }
    // Zielpunkt → commit (Auswahl an die Endlage verschieben).
    const base = s.base;
    const sel = s.sel;
    return [
      { phase: "done", lastPoint: null } as MoveDone,
      {
        draft: null,
        done: true,
        commit: (p) => commitTransform(p, toTransformSel(sel), "move", [base, pt], "move", 1),
      },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as MoveState;
    if (s.phase !== "target") return [s, { draft: null }];
    const ns: MoveTarget = { ...s, cursor: point };
    return [ns, { draft: moveDraft(ctx.project, s.sel, s.base, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),

  // Tab-Feld-Zyklus nur im Zielschritt: Länge + Winkel relativ zum Basispunkt.
  fields: (state) => ((state as MoveState).phase === "target" ? MOVE_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as MoveState;
    if (s.phase !== "target") return null;
    return targetFromFields(s.base, locks, cursor);
  },
};
