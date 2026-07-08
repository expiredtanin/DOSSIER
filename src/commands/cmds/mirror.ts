// Mirror — spiegelt die AKTUELLE Auswahl (Wände + ein Drawing2D) an einer frei
// gewählten Achse (Rhino/Vectorworks-Spiegeln). Schritte:
//   1) „Erster Achsenpunkt:"   → Punkt
//   2) „Zweiter Achsenpunkt:"    → Punkt (Live-Vorschau der Spiegelung) → commit
//
// Die Auswahl kommt vorab über ctx.selection (erst selektieren, dann Befehl,
// wie Move/Copy). Ist sie leer, ist nichts zu spiegeln: kurzer No-op mit Hinweis
// („Nichts gewählt") und Beenden.
//
// Der Commit nutzt den bestehenden, getesteten `commitTransform` (op:"mirror",
// mode:"copy") — er spiegelt Wände UND alle 2D-Formen immutabel an der Achse und
// hängt das Spiegelbild als KOPIE an (das Original bleibt stehen). Das ist das
// klassische Mirror „Kopie spiegeln" (Rhino/Vectorworks-Default).

import { commitTransform } from "../../tools/transform";
import type { TransformSelection } from "../../tools/transform";
import { transformPreview } from "../../tools/transform";
import type {
  Command,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const EPS = 1e-6;

/** Hat die Auswahl überhaupt etwas Spiegelbares? */
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

// Zustand: erst ersten Achsenpunkt setzen, dann den zweiten (mit Auswahl-Snapshot).
interface MirrorFirst extends CommandState {
  phase: "first";
}
interface MirrorSecond extends CommandState {
  phase: "second";
  sel: CommandSelection;
  a: Vec2;
  cursor: Vec2 | null;
}
// „done": leere Auswahl → No-op, Befehl beendet.
interface MirrorDone extends CommandState {
  phase: "done";
}
type MirrorState = MirrorFirst | MirrorSecond | MirrorDone;

/** Live-Vorschau der an der Achse a→b gespiegelten Auswahl. */
function mirrorDraft(
  project: Project,
  sel: CommandSelection,
  a: Vec2,
  b: Vec2,
): ToolDraft {
  // Ohne echte Achse (Null-Strecke) nur den ersten Punkt markieren.
  if (segLen(a, b) < EPS) {
    return { preview: [], vertices: [a] };
  }
  const preview = transformPreview(
    project,
    toTransformSel(sel),
    "mirror",
    [a, b],
    "copy", // Spiegelbild als Kopie (Original bleibt stehen)
    1,
  );
  return {
    // Spiegelbild-Vorschau + die Achse selbst als Hilfslinie.
    preview: [...preview, { kind: "line", a, b }],
    // Beide Achsenpunkte als Stützpunkte (Marker).
    vertices: [a, b],
    hud: {
      at: b,
      text: `${((segAngleDeg(a, b) + 360) % 360).toFixed(0)}°`,
    },
  };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as MirrorDone,
  { draft: null, done: true },
];

export const mirrorCommand: Command = {
  name: "mirror",
  labelKey: "cmd.mirror.label",
  prompt: (s) => {
    const ms = s as MirrorState;
    if (ms.phase === "second") return "cmd.mirror.second";
    if (ms.phase === "done") return "cmd.mirror.empty";
    return "cmd.mirror.first";
  },
  accepts: () => ["point"],
  options: () => [],

  init: (): MirrorFirst => ({ phase: "first", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as MirrorState;
    if (s.phase === "done") return idle();
    // Leere Auswahl → nichts zu spiegeln (No-op + Hinweis, dann beenden).
    if (!hasSelection(ctx.selection)) {
      return [{ phase: "done", lastPoint: null } as MirrorDone, { draft: null, done: true }];
    }
    if (input.kind !== "point") {
      if (s.phase === "second") {
        return [s, { draft: s.cursor ? mirrorDraft(ctx.project, s.sel, s.a, s.cursor) : null }];
      }
      return [s, { draft: null }];
    }
    const pt = input.point;
    if (s.phase !== "second") {
      // Erster Achsenpunkt gesetzt → Auswahl-Snapshot mitführen.
      const next: MirrorSecond = {
        phase: "second",
        sel: ctx.selection,
        a: pt,
        cursor: pt,
        lastPoint: pt,
      };
      return [next, { draft: mirrorDraft(ctx.project, next.sel, pt, pt) }];
    }
    // Zweiter Achsenpunkt → commit (Auswahl an der Achse spiegeln). Null-Achse
    // verwerfen (kein Spiegeln ohne Richtung).
    if (segLen(s.a, pt) < EPS) {
      return [{ phase: "done", lastPoint: null } as MirrorDone, { draft: null, done: true }];
    }
    const a = s.a;
    const sel = s.sel;
    return [
      { phase: "done", lastPoint: null } as MirrorDone,
      {
        draft: null,
        done: true,
        commit: (p) => commitTransform(p, toTransformSel(sel), "mirror", [a, pt], "copy", 1),
      },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as MirrorState;
    if (s.phase !== "second") return [s, { draft: null }];
    const ns: MirrorSecond = { ...s, cursor: point };
    return [ns, { draft: mirrorDraft(ctx.project, s.sel, s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
