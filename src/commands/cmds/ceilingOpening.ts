// Deckenloch — Aussparung (Treppenauge/Schacht) als Engine-Befehl: ein RECHTECK
// wird aufgezogen (zwei Klicks: erste Ecke → Gegenecke) und der Decke des
// aktiven Geschosses hinzugefügt, die das Rechteck ENTHÄLT (alle vier Ecken
// innerhalb des Decken-Umrisses). Gerendert wird das Loch in 2D (Poché-Loch +
// Randlinien) und 3D (Loch im Slab), s. Ceiling.openings/mergeHoles.
//
// Schritte:
//   1) „Erste Ecke der Aussparung:"  → Punkt
//   2) „Gegenecke:"                  → Live-Rechteck-Vorschau; Klick committet.

import { opsMutation, patchItem, pointInOutline } from "../../core";
import type { CoreOp } from "../../core";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

/** Vier Eckpunkte eines Rechtecks aus zwei Gegenecken (CCW). */
function rectCorners(a: Vec2, b: Vec2): Vec2[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

interface HoleIdle extends CommandState {
  phase: "start";
}
interface HoleRect extends CommandState {
  phase: "corner";
  a: Vec2;
  cursor: Vec2 | null;
}
type HoleState = HoleIdle | HoleRect;

/** Vorschau: aufgezogenes Rechteck + Masse im HUD. */
function holeDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  const pts = cursor ? rectCorners(a, cursor) : [a];
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: !!cursor }];
  const draft: ToolDraft = { preview, vertices: [a] };
  if (cursor) {
    draft.hud = {
      at: cursor,
      text: `${Math.abs(cursor.x - a.x).toFixed(2)} × ${Math.abs(cursor.y - a.y).toFixed(2)} m`,
    };
  }
  return draft;
}

/**
 * Fügt die Aussparung der ERSTEN Decke des aktiven Geschosses hinzu, die das
 * Rechteck vollständig enthält (alle 4 Ecken im Umriss). Entartete Rechtecke
 * und Rechtecke ausserhalb jeder Decke werden verworfen (Projekt unverändert).
 */
function ceilingOpeningOps(p: Project, a: Vec2, b: Vec2, ctx: CommandContext): CoreOp[] {
  const w = Math.abs(b.x - a.x);
  const d = Math.abs(b.y - a.y);
  if (w < 0.05 || d < 0.05) return [];
  const corners = rectCorners(a, b);
  const host = (p.ceilings ?? []).find(
    (c) =>
      c.floorId === ctx.level.id &&
      c.outline.length >= 3 &&
      corners.every((pt) => pointInOutline(pt, c.outline)),
  );
  if (!host) return [];
  return patchItem(p, "ceilings", host.id, (c) => ({ ...c, openings: [...(c.openings ?? []), corners] }));
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as HoleIdle,
  { draft: null, done: true },
];

export const ceilingOpeningCommand: Command = {
  name: "ceilingopening",
  labelKey: "cmd.ceilingOpening.label",
  floorOnly: true,
  prompt: (s) =>
    (s as HoleState).phase === "corner" ? "cmd.ceilingOpening.corner" : "cmd.ceilingOpening.start",
  accepts: () => ["point"],
  options: () => [],
  init: (): HoleIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as HoleState;
    if (input.kind !== "point") {
      return [s, { draft: s.phase === "corner" ? holeDraft(s.a, s.cursor) : null }];
    }
    if (s.phase !== "corner") {
      const ns: HoleRect = {
        phase: "corner",
        a: input.point,
        cursor: input.point,
        lastPoint: input.point,
      };
      return [ns, { draft: holeDraft(input.point, input.point) }];
    }
    // Zweite Ecke → committen.
    const a = s.a;
    const b = input.point;
    return [
      { phase: "start", lastPoint: null } as HoleIdle,
      { draft: null, done: true, commit: opsMutation((p) => ceilingOpeningOps(p, a, b, ctx)) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as HoleState;
    if (s.phase !== "corner") return [s, { draft: null }];
    const ns: HoleRect = { ...s, cursor: point };
    return [ns, { draft: holeDraft(s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
