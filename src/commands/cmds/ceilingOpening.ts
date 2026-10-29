// Deckenloch — Aussparung (Treppenauge/Schacht) als Engine-Befehl: ein RECHTECK
// wird aufgezogen (zwei Klicks: erste Ecke → Gegenecke) und der Decke des
// aktiven Geschosses hinzugefügt, die das Rechteck ENTHÄLT (alle vier Ecken
// innerhalb des Decken-Umrisses). Gerendert wird das Loch in 2D (Poché-Loch +
// Randlinien) und 3D (Loch im Slab), s. Ceiling.openings/mergeHoles.
//
// Schritte:
//   1) „Erste Ecke der Aussparung:"  → Punkt
//   2) „Gegenecke:"                  → Live-Rechteck-Vorschau; Klick committet.

import { createMutation, createPreview } from "../createCore";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";

/** Vier Eckpunkte eines Rechtecks aus zwei Gegenecken (CCW). */
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
function holeDraft(ctx: CommandContext, a: Vec2, cursor: Vec2 | null): ToolDraft {
  // Aufgezogenes Rechteck im Kern (`cmd_create.rs`).
  const preview: DraftShape[] = cursor ? createPreview(ctx, { cmd: "rect4" }, [a, cursor]).shapes : [{ kind: "poly", pts: [a], closed: false }];
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
/**
 * Commit (Kern, `cmd_solid.rs`): rechteckige Aussparung (≥ 5 cm je Seite) in die Decke des Geschosses,
 * die alle vier Ecken enthält; keine solche Decke → nichts.
 */
const ceilingOpening = (a: Vec2, b: Vec2, ctx: CommandContext) => createMutation(ctx, { cmd: "ceilingOpening", a, b });

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
      return [s, { draft: s.phase === "corner" ? holeDraft(ctx, s.a, s.cursor) : null }];
    }
    if (s.phase !== "corner") {
      const ns: HoleRect = {
        phase: "corner",
        a: input.point,
        cursor: input.point,
        lastPoint: input.point,
      };
      return [ns, { draft: holeDraft(ctx, input.point, input.point) }];
    }
    // Zweite Ecke → committen.
    const a = s.a;
    const b = input.point;
    return [
      { phase: "start", lastPoint: null } as HoleIdle,
      { draft: null, done: true, commit: ceilingOpening(a, b, ctx) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as HoleState;
    if (s.phase !== "corner") return [s, { draft: null }];
    const ns: HoleRect = { ...s, cursor: point };
    return [ns, { draft: holeDraft(ctx, s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
