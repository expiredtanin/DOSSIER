// Line — erster Befehl der Command-Engine (portiert lineTool aus
// src/tools/tools.ts). Zwei Punkte → Drawing2D{shape:"line"}.
//
// Schritte:
//   1) „Start of line:"  → Punkt (Klick ODER getippt: 0,0 / r3,0 / 3<45)
//   2) „End of line:"     → Punkt → commit Drawing2D line → done
//
// Akzeptiert in JEDEM Punkt-Schritt sowohl Maus-Picks (gesnappt) als auch
// getippte Koordinaten — das ist die Kern-Vereinheitlichung gegenüber dem alten
// Tool. Live-Vorschau + HUD (Länge/Winkel) wie die bestehenden Tools.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Tab-Felder des End-Schritts: erst Länge, dann Winkel (§2.7). */
const LINE_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

/**
 * Endpunkt aus gelockten Feldern (length/angle) + Cursor: ungelockte Werte
 * folgen dem Cursor relativ zum Startpunkt `a`.
 */
function lineEndFromFields(a: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? a;
  const length = "length" in locks ? locks.length : segLen(a, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(a, ref);
  const ang = angleDeg * DEG;
  return { x: a.x + Math.cos(ang) * length, y: a.y + Math.sin(ang) * length };
}

interface LineIdle extends CommandState {
  phase: "start";
}
interface LineDrawing extends CommandState {
  phase: "end";
  a: Vec2;
  cursor: Vec2 | null;
}
type LineState = LineIdle | LineDrawing;

/** Vorschau (Rubber-Band) + HUD (Länge·Winkel) für das lebende Segment. */
function lineDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  const preview: DraftShape[] = [];
  if (cursor && segLen(a, cursor) >= EPS) preview.push({ kind: "line", a, b: cursor });
  const draft: ToolDraft = { preview, vertices: [a] };
  if (cursor && segLen(a, cursor) >= EPS) {
    draft.hud = {
      at: cursor,
      text: `${segLen(a, cursor).toFixed(2)} m · ${Math.abs(
        (segAngleDeg(a, cursor) + 360) % 360,
      ).toFixed(0)}°`,
    };
  }
  return draft;
}

/** Hängt eine 2D-Linie ans Projekt (immutabel). Farbe/Strich erbt die Kategorie. */
function appendLine(p: import("../types").Project, a: Vec2, b: Vec2, ctx: CommandContext) {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "line", a, b },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

export const lineCommand: Command = {
  name: "line",
  labelKey: "cmd.line.label",
  prompt: (s) => ((s as LineState).phase === "end" ? "cmd.line.end" : "cmd.line.start"),
  accepts: () => ["point", "number"],
  options: () => [],
  init: (): LineIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as LineState;
    // Beide Punkt-Schritte erwarten einen aufgelösten Punkt; die Engine reicht
    // getippte Koordinaten bereits als {kind:"point"} herein.
    if (input.kind !== "point") return [s, { draft: s.phase === "end" ? lineDraft(s.a, s.cursor) : null }];
    const pt = input.point;
    if (s.phase !== "end") {
      const next: LineDrawing = { phase: "end", a: pt, cursor: pt, lastPoint: pt };
      return [next, { draft: lineDraft(pt, pt) }];
    }
    // Zweiter Punkt: Null-Strecke verwerfen, sonst committen.
    if (segLen(s.a, pt) < EPS) {
      return [{ phase: "start", lastPoint: null }, { draft: null, done: true }];
    }
    const a = s.a;
    return [
      { phase: "start", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendLine(p, a, pt, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as LineState;
    if (s.phase !== "end") return [s, { draft: null }];
    const next: LineDrawing = { ...s, cursor: point };
    return [next, { draft: lineDraft(s.a, point) }];
  },

  // Line braucht genau zwei Punkte; Enter/Rechtsklick im offenen Entwurf bricht ab.
  onConfirm: (): [CommandState, CommandResult] => [
    { phase: "start", lastPoint: null },
    { draft: null, done: true },
  ],
  onCancel: (): [CommandState, CommandResult] => [
    { phase: "start", lastPoint: null },
    { draft: null, done: true },
  ],

  // Tab-Feld-Zyklus nur im End-Schritt: Länge + Winkel relativ zum Startpunkt.
  fields: (state) => ((state as LineState).phase === "end" ? LINE_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as LineState;
    if (s.phase !== "end") return null;
    return lineEndFromFields(s.a, locks, cursor);
  },
};
