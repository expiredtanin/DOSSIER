// Textspalte (Absatztext) — wie das Text-Werkzeug, aber mit einer Spaltenbreite:
// der Text bricht beim Rendern UND beim Editieren wortweise auf diese Breite
// um (InDesign-artiges Textrahmen-Verhalten, Nutzer-Wunsch). Schritte:
//   1) „Ankerpunkt:"     → Punkt (oben-links der Spalte)
//   2) „Spaltenbreite:"   → Punkt (die horizontale Distanz zum Anker = Breite;
//                            Live-Vorschau der Breitenlinie)
//   Committet danach SOFORT ein leeres Text-Element (mit `width`) und meldet
//   `focusDrawingId` — die UI (PlanView) öffnet den Inline-Rich-Text-Editor
//   direkt auf der Zeichenfläche, mit der Spaltenbreite als CSS-Breite (echter
//   Wortumbruch beim Tippen, kein Dialog). Bleibt der Editor leer, verwirft
//   `commitTextEdit` (App.tsx) das Element wieder.
//
// Reuse des bestehenden {shape:"text"}-Elements (mit `width`) — so erben Selektion,
// Verschieben und Griff automatisch vom Einzeltext; nur die Breite kommt hinzu.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

/** Default-Schrifthöhe einer Textspalte in Modell-Metern. */
const DEFAULT_TEXT_HEIGHT_M = 0.25;
/** Kleinste sinnvolle Spaltenbreite (Meter). */
const MIN_WIDTH_M = 0.2;

interface TbPoint extends CommandState {
  phase: "point";
}
interface TbWidth extends CommandState {
  phase: "width";
  at: Vec2;
  cursor: Vec2 | null;
}
type TbState = TbPoint | TbWidth;

/** Horizontale Spaltenbreite aus Anker + Cursor (Betrag der x-Differenz, geklemmt). */
function widthOf(at: Vec2, cursor: Vec2): number {
  return Math.max(MIN_WIDTH_M, Math.abs(cursor.x - at.x));
}

/** Vorschau: waagrechte Breitenlinie am Anker (zeigt die Spaltenbreite). */
function widthDraft(at: Vec2, cursor: Vec2): ToolDraft {
  const w = widthOf(at, cursor);
  const b: Vec2 = { x: at.x + w, y: at.y };
  return {
    preview: [{ kind: "line", a: at, b }],
    vertices: [at, b],
    hud: { at: b, text: `${w.toFixed(2)} m` },
  };
}

function appendEmptyTextbox(p: Project, id: string, at: Vec2, width: number, ctx: CommandContext): Project {
  const d: Drawing2D = {
    id,
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "text", at, text: "", height: DEFAULT_TEXT_HEIGHT_M, angle: 0, width },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null } as TbPoint,
  { draft: null, done: true },
];

export const textboxCommand: Command = {
  name: "textbox",
  labelKey: "cmd.textbox.label",
  prompt: (s) => ((s as TbState).phase === "width" ? "cmd.textbox.width" : "cmd.textbox.point"),
  accepts: () => ["point"],
  options: () => [],
  init: (): TbPoint => ({ phase: "point", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as TbState;
    if (input.kind !== "point") return [s, { draft: null }];
    if (s.phase === "point") {
      const ns: TbWidth = { phase: "width", at: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: widthDraft(input.point, input.point) }];
    }
    // phase === "width"
    const width = widthOf(s.at, input.point);
    const id = uniqueId("dr2d");
    const at = s.at;
    return [
      { phase: "point", lastPoint: null } as TbPoint,
      {
        draft: null,
        done: true,
        commit: (p) => appendEmptyTextbox(p, id, at, width, ctx),
        focusDrawingId: id,
      },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as TbState;
    if (s.phase !== "width") return [s, { draft: null }];
    const ns: TbWidth = { ...s, cursor: point };
    return [ns, { draft: widthDraft(s.at, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
