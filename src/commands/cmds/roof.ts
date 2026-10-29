// Roof — Dach als Engine-Befehl: der Grundriss wird als RECHTECK aufgezogen
// (zwei Klicks: erste Ecke → Gegenecke), committet ein `Roof`-Bauteil. Die
// Dachform/Neigung wählt man nach dem Platzieren im Attribut-Panel; Default ist
// ein Satteldach mit First entlang der LÄNGEREN Rechteckseite.
//
// Schritte:
//   1) „Erste Dachecke:"  → Punkt
//   2) „Gegenecke:"       → Live-Rechteck-Vorschau; Klick committet das Dach.
//
// Herkunft der Dach-Felder (CommandContext):
//   • floorId     ← ctx.level.id (aktives Geschoss)
//   • categoryCode← "35" (Ebene „Dächer"; Fallback ctx.defaultCategoryCode)

import type { RoofShape } from "../../model/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview, xy } from "../createCore";

/** Wählbare Dachformen (Inline-Optionen der Befehlszeile). */
const SHAPE_OPTIONS: CmdOption[] = [
  { id: "sattel", labelKey: "cmd.roof.shape.sattel" },
  { id: "walm", labelKey: "cmd.roof.shape.walm" },
  { id: "pult", labelKey: "cmd.roof.shape.pult" },
  { id: "mansarde", labelKey: "cmd.roof.shape.mansarde" },
  { id: "zelt", labelKey: "cmd.roof.shape.zelt" },
  { id: "flach", labelKey: "cmd.roof.shape.flach" },
];
const SHAPE_IDS = new Set(SHAPE_OPTIONS.map((o) => o.id));

interface RoofIdle extends CommandState {
  phase: "start";
  shape: RoofShape;
}
interface RoofRect extends CommandState {
  phase: "corner";
  a: Vec2;
  cursor: Vec2;
  shape: RoofShape;
}
type RoofState = RoofIdle | RoofRect;

/** Vorschau: aufgezogenes Rechteck (Kern) + Masse im HUD. */
function roofDraft(ctx: CommandContext, a: Vec2, cursor: Vec2): ToolDraft {
  const draft: ToolDraft = { preview: createPreview(ctx, { cmd: "rect4" }, [a, cursor]).shapes, vertices: [a] };
  draft.hud = {
    at: cursor,
    text: `${Math.abs(cursor.x - a.x).toFixed(2)} × ${Math.abs(cursor.y - a.y).toFixed(2)} m`,
  };
  return draft;
}

/**
 * Commit (Kern, `cmd_create.rs`): Dach über dem Rechteck (entartet < 0.1 m → nichts), Ebene „31“,
 * Neigung 30° (flach 0°), Vorsprung 0.4 m, First entlang der längeren Seite, Dicke 0.2 m.
 */
const appendRoof = (a: Vec2, b: Vec2, shape: RoofShape, ctx: CommandContext) =>
  createMutation(ctx, { cmd: "roof", a: xy(a), b: xy(b), shape });

const idle = (shape: RoofShape = "sattel"): [CommandState, CommandResult] => [
  { phase: "start", shape, lastPoint: null } as RoofIdle,
  { draft: null, done: true },
];

export const roofCommand: Command = {
  name: "roof",
  labelKey: "cmd.roof.label",
  floorOnly: true,
  prompt: (s) => ((s as RoofState).phase === "corner" ? "cmd.roof.corner" : "cmd.roof.start"),
  accepts: () => ["point", "option"],
  // Dachform als Inline-Optionen — vor/während des Aufziehens wählbar.
  options: () => SHAPE_OPTIONS,
  init: (): RoofIdle => ({ phase: "start", shape: "sattel", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RoofState;
    // Dachform-Option: aktualisiert die Form, Phase/Rechteck bleiben.
    if (input.kind === "option" && SHAPE_IDS.has(input.id)) {
      const ns = { ...s, shape: input.id as RoofShape } as RoofState;
      const draft = ns.phase === "corner" ? roofDraft(ctx, ns.a, ns.cursor) : null;
      return [ns, { draft }];
    }
    if (input.kind !== "point") {
      return [s, { draft: s.phase === "corner" ? roofDraft(ctx, s.a, s.cursor) : null }];
    }
    if (s.phase !== "corner") {
      const ns: RoofRect = {
        phase: "corner",
        a: input.point,
        cursor: input.point,
        shape: s.shape,
        lastPoint: input.point,
      };
      return [ns, { draft: roofDraft(ctx, input.point, input.point) }];
    }
    // Zweite Ecke → committen.
    const a = s.a;
    const b = input.point;
    const shape = s.shape;
    return [
      { phase: "start", shape, lastPoint: null } as RoofIdle,
      { draft: null, done: true, commit: appendRoof(a, b, shape, ctx) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as RoofState;
    if (s.phase !== "corner") return [s, { draft: null }];
    const ns: RoofRect = { ...s, cursor: point };
    return [ns, { draft: roofDraft(ctx, s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
