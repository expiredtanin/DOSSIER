// Textspalte (Absatztext) — wie das Text-Werkzeug, aber als aufgezogener
// RAHMEN: Breite UND Höhe kommen aus einem Rechteck (zwei diagonale Punkte),
// nicht nur einer Breitenlinie (InDesign-artiges Textrahmen-Verhalten,
// Nutzer-Wunsch). Schritte:
//   1) „Erste Ecke:"  → Punkt
//   2) „Gegenecke:"    → Punkt (Live-Vorschau des Rahmens, beliebige Richtung)
//   Committet danach SOFORT ein leeres Text-Element (mit `width`) und meldet
//   `focusDrawingId` + `focusMinHeightM` (die aufgezogene Rahmenhöhe als
//   MINDESThöhe, s. types.ts) — die UI (PlanView) öffnet den Inline-Rich-
//   Text-Editor direkt auf der Zeichenfläche, mit der Spaltenbreite als CSS-
//   Breite (echter Wortumbruch beim Tippen, kein Dialog) und dem Rahmen als
//   Mindesthöhe (wächst bei mehr Text darüber hinaus). Bleibt der Editor
//   leer, verwirft `commitTextEdit`/`closeTextEdit` (App.tsx) das Element
//   wieder.
//
// Reuse des bestehenden {shape:"text"}-Elements (mit `width`) — so erben
// Selektion, Verschieben und Griff automatisch vom Einzeltext; die Modell-
// Geometrie selbst kennt aber keine feste Rahmenhöhe (nur `width` für den
// Wortumbruch) — die Höhe bleibt reine Editor-Startgrösse (PlanView-lokal,
// s. focusMinHeightM), die Textmenge bestimmt die tatsächliche Höhe.

import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  Vec2,
} from "../types";
import { createMutation, createPreview } from "../createCore";


interface TbFirst extends CommandState {
  phase: "first";
}
interface TbSecond extends CommandState {
  phase: "second";
  a: Vec2;
  cursor: Vec2 | null;
}
type TbState = TbFirst | TbSecond;

/** Normalisiertes Rechteck aus zwei diagonalen Punkten (beliebige Zugrichtung). */
/**
 * Textrahmen im Kern (`cmd_draw.rs`): Rechteck aus zwei Ecken, Breite/Höhe mindestens 0.2 m
 * (`info = [Breite, Höhe]`), Anker oben links eine Zeilenhöhe tief.
 */
function frameDraft(ctx: CommandContext, a: Vec2, cursor: Vec2): { preview: DraftShape[]; vertices: Vec2[]; hud: { at: Vec2; text: string } } {
  const pv = createPreview(ctx, { cmd: "textbox" }, [a, cursor]);
  const [w, h] = pv.info;
  return {
    preview: pv.shapes,
    vertices: [a, cursor],
    hud: { at: cursor, text: `${w.toFixed(2)} × ${h.toFixed(2)} m` },
  };
}

/** Commit (Kern): leere Textspalte (Breite des Rahmens), mit vorab vergebener id. */
const appendEmptyTextbox = (id: string, a: Vec2, b: Vec2, ctx: CommandContext) =>
  createMutation(ctx, { cmd: "textbox", id, a, b });

const idle = (): [CommandState, CommandResult] => [
  { phase: "first", lastPoint: null } as TbFirst,
  { draft: null, done: true },
];

export const textboxCommand: Command = {
  name: "textbox",
  labelKey: "cmd.textbox.label",
  prompt: (s) => ((s as TbState).phase === "second" ? "cmd.textbox.second" : "cmd.textbox.first"),
  accepts: () => ["point"],
  options: () => [],
  init: (): TbFirst => ({ phase: "first", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as TbState;
    if (input.kind !== "point") return [s, { draft: null }];
    if (s.phase === "first") {
      const ns: TbSecond = { phase: "second", a: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: { preview: [], vertices: [input.point] } }];
    }
    // phase === "second"
    const heightM = createPreview(ctx, { cmd: "textbox" }, [s.a, input.point]).info[1];
    const id = uniqueId("dr2d");
    return [
      { phase: "first", lastPoint: null } as TbFirst,
      {
        draft: null,
        done: true,
        commit: appendEmptyTextbox(id, s.a, input.point, ctx),
        focusDrawingId: id,
        focusMinHeightM: heightM,
      },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as TbState;
    if (s.phase !== "second") return [s, { draft: null }];
    const ns: TbSecond = { ...s, cursor: point };
    return [ns, { draft: frameDraft(ctx, s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
