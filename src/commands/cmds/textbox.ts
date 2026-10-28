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

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  Vec2,
} from "../types";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

/** Default-Schrifthöhe einer Textspalte in Modell-Metern (= Baseline-Versatz vom Rahmen-Top). */
const DEFAULT_TEXT_HEIGHT_M = 0.25;
/** Kleinste sinnvolle Rahmen-Breite/-Höhe (Meter). */
const MIN_SIZE_M = 0.2;

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
function rectOf(a: Vec2, b: Vec2): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  };
}

/** Breite/Höhe (geklemmt auf MIN_SIZE_M) + die Textanker-Position (oben-links, als Baseline). */
function frameOf(a: Vec2, b: Vec2): { at: Vec2; width: number; heightM: number } {
  const r = rectOf(a, b);
  const width = Math.max(MIN_SIZE_M, r.maxX - r.minX);
  const heightM = Math.max(MIN_SIZE_M, r.maxY - r.minY);
  // `at` ist die Baseline-links der ERSTEN Zeile (s. drawing2d.ts/primitives.tsx);
  // die Rahmen-Oberkante liegt eine Zeilenhöhe darüber → at.y = Rahmen-Top − Zeilenhöhe.
  return { at: { x: r.minX, y: r.maxY - DEFAULT_TEXT_HEIGHT_M }, width, heightM };
}

/** Vorschau: Rahmen-Rechteck zwischen den beiden Ecken. */
function frameDraft(a: Vec2, cursor: Vec2): { preview: DraftShape[]; vertices: Vec2[]; hud: { at: Vec2; text: string } } {
  const r = rectOf(a, cursor);
  const pts: Vec2[] = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
  const w = Math.max(MIN_SIZE_M, r.maxX - r.minX);
  const h = Math.max(MIN_SIZE_M, r.maxY - r.minY);
  return {
    preview: [{ kind: "poly", pts, closed: true }],
    vertices: [a, cursor],
    hud: { at: cursor, text: `${w.toFixed(2)} × ${h.toFixed(2)} m` },
  };
}

function appendEmptyTextbox(id: string, at: Vec2, width: number, ctx: CommandContext): CoreOp[] {
  const d: Drawing2D = {
    id,
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "text", at, text: "", height: DEFAULT_TEXT_HEIGHT_M, angle: 0, width },
  };
  return addItems("drawings2d", [d]);
}

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
    const { at, width, heightM } = frameOf(s.a, input.point);
    const id = uniqueId("dr2d");
    return [
      { phase: "first", lastPoint: null } as TbFirst,
      {
        draft: null,
        done: true,
        commit: opsMutation(() => appendEmptyTextbox(id, at, width, ctx)),
        focusDrawingId: id,
        focusMinHeightM: heightM,
      },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as TbState;
    if (s.phase !== "second") return [s, { draft: null }];
    const ns: TbSecond = { ...s, cursor: point };
    return [ns, { draft: frameDraft(s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
