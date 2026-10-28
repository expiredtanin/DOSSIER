// Wipeout/Maskenregion (Nutzer-Wunsch: „Wipeout/Maskenregion" aus der
// Werkzeug-Lücken-Liste). Schritte (wie `revcloud.ts`, aber ohne dessen
// Beulen-Logik — eine Maskenfläche ist eine ganz normale gerade Kontur):
//   1) „Startpunkt:" → Punkt
//   2) „Nächster Punkt:" → Punkt … Klick nahe dem Startpunkt ODER Enter
//      (≥3 Punkte) schliesst und committet.
//
// ANDERS als bei jedem anderen Mehrpunkt-Werkzeug MUSS ein Wipeout immer
// GESCHLOSSEN sein (eine offene „Maske" hätte kein Innen/Aussen) — Enter
// schliesst hier daher automatisch, statt (wie bei `revcloud`) offen zu
// beenden.
//
// Bewusst KEIN neuer Shape-Typ: das Ergebnis ist eine ganz normale
// `Drawing2DGeom["polyline"]` (geschlossen, keine Bögen) mit weisser
// Füll- UND Strichfarbe (`background`/`color`, beide bereits vorhandene
// Attribut-Override-Felder) — sie deckt darunterliegende Zeichnung ab, weil
// neue Elemente an das ENDE von `project.drawings2d` angehängt werden und
// damit automatisch oben im Zeichen-Stapel liegen (dieselbe Reihenfolge, die
// „Nach vorne holen"/„Nach hinten legen" im Kontextmenü nutzt) — keine
// eigene Z-Order-Logik nötig. Farbe/Deckkraft bleiben über das
// Attribute-Panel wie bei jeder anderen Fläche nachträglich änderbar (kein
// Sonderfall, nur ein sinnvoller Default).

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

const EPS = 1e-6;
const CLOSE_HIT = 0.15; // Modell-Meter: Klick nahe Startpunkt schliesst den Zug
const MASK_COLOR = "#ffffff"; // Deckt wie Papier ab — Fläche UND Rand (unsichtbare Kontur)

const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

interface WipeoutIdle extends CommandState {
  phase: "start";
}
interface WipeoutDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
}
type WipeoutState = WipeoutIdle | WipeoutDrawing;

function wipeoutDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: false }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

function appendWipeout(points: Vec2[], ctx: CommandContext): CoreOp[] {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts: points, closed: true },
    background: MASK_COLOR,
    color: MASK_COLOR,
  };
  return addItems("drawings2d", [d]);
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as WipeoutIdle,
  { draft: null, done: true },
];

export const wipeoutCommand: Command = {
  name: "wipeout",
  labelKey: "cmd.wipeout.label",
  prompt: (s) => ((s as WipeoutState).phase === "next" ? "cmd.wipeout.next" : "cmd.wipeout.start"),
  accepts: () => ["point"],
  options: () => [],
  init: (): WipeoutIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as WipeoutState;
    if (input.kind !== "point") {
      return [s, { draft: s.phase === "next" ? wipeoutDraft(s.points, s.cursor) : null }];
    }
    const pt = input.point;

    if (s.phase !== "next") {
      const ns: WipeoutDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt };
      return [ns, { draft: wipeoutDraft([pt], pt) }];
    }

    // Klick nahe Startpunkt (≥3 Punkte) → schliessen (committet).
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      const pts = s.points;
      return [idle()[0], { draft: null, done: true, commit: opsMutation(() => appendWipeout(pts, ctx)) }];
    }
    const points = [...s.points, pt];
    const ns: WipeoutDrawing = { phase: "next", points, cursor: pt, lastPoint: pt };
    return [ns, { draft: wipeoutDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as WipeoutState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: WipeoutDrawing = { ...s, cursor: point };
    return [ns, { draft: wipeoutDraft(s.points, point) }];
  },

  // Enter/Space/Rechtsklick: schliesst AUTOMATISCH (≥3 Punkte) — anders als
  // bei `revcloud`/`polyline` gibt es keinen sinnvollen offenen Endzustand.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as WipeoutState;
    if (s.phase === "next" && s.points.length >= 3) {
      const pts = s.points;
      return [idle()[0], { draft: null, done: true, commit: opsMutation(() => appendWipeout(pts, ctx)) }];
    }
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),
};
