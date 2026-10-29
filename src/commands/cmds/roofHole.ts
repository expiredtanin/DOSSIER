// Dachhof — Innenhof/Lichthof im Dach als Engine-Befehl: eine Kontur wird per Klicks gezeichnet und
// dem ERSTEN Dach des aktiven Geschosses hinzugefügt, in dem sie wirkt (ganz im Umriss, ohne
// Überschneidung, nicht bei Pultdach — das entscheidet der Rust-Kern, s. `cmd_solid.rs`).
//
// Warum Zeichnen statt „aus gewählter Kontur": die Auswahl kennt immer nur ein Objekt, mit dem
// Dach gewählt wäre keine zweite Kontur wählbar; gezeichnet gibt es Fang auf Wände und Umriss,
// und der Ablauf entspricht Deckenloch/Decke. Zwei Punkte + Enter ergeben ein Rechteck.
//
// Schritte:
//   1) „Erster Punkt des Hofs:"  → Punkt
//   2) „Nächster Punkt ( Schliessen Zurück ):" → Punkt … Schliessen per Klick auf den Startpunkt,
//      Option „Schliessen" oder Enter (≥ 3 Punkte; bei genau 2 Punkten: Rechteck aus den Ecken).

import type { Command, CommandContext, CommandResult, CommandState, CmdOption, DraftShape, ToolDraft, Vec2 } from "../types";
import { createMutation } from "../createCore";

const EPS = 1e-6;
const CLOSE_HIT = 0.08; // Modell-Meter: Klick nahe Startpunkt schliesst die Kontur

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Vier Ecken eines Rechtecks aus zwei Gegenecken. */
interface HoleIdle extends CommandState {
  phase: "start";
}
interface HoleDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
}
type HoleState = HoleIdle | HoleDrawing;

const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };

/** Vorschau: Kontur (ab 3 Punkten geschlossen) + Gummiband. */
function holeDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: pts.length >= 3 }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && dist(last, cursor) >= EPS) draft.hud = { at: cursor, text: `${dist(last, cursor).toFixed(2)} m` };
  return draft;
}

/** Aus den Klickpunkten die Hof-Kontur: ≥ 3 Punkte = Polygon, genau 2 = Rechteck. */
/**
 * Commit (Kern, `cmd_solid.rs`): Hof-Ring (≥ 3 Punkte wie gezeichnet, 2 Punkte als Rechteck) in das Dach
 * des Geschosses, das ihn ganz enthält und dessen Skelett ihn zulässt; sonst nichts.
 */
const roofHoleOps = (points: Vec2[], ctx: CommandContext) => createMutation(ctx, { cmd: "roofHole", pts: points });

const idle = (): [CommandState, CommandResult] => [{ phase: "start", lastPoint: null } as HoleIdle, { draft: null, done: true }];

const finish = (points: Vec2[], ctx: CommandContext): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as HoleIdle,
  { draft: null, done: true, commit: roofHoleOps(points, ctx) },
];

export const roofHoleCommand: Command = {
  name: "roofhole",
  labelKey: "cmd.roofHole.label",
  floorOnly: true,
  prompt: (s) => ((s as HoleState).phase === "next" ? "cmd.roofHole.next" : "cmd.roofHole.start"),
  accepts: (s) => ((s as HoleState).phase === "next" ? ["point", "option"] : ["point"]),
  options: (s) => {
    const ps = s as HoleState;
    if (ps.phase !== "next") return [];
    return ps.points.length >= 3 ? [CLOSE, UNDO] : [UNDO];
  },
  init: (): HoleIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as HoleState;
    if (input.kind === "option") {
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0) return [{ phase: "start", lastPoint: null } as HoleIdle, { draft: null }];
        const ns: HoleDrawing = { phase: "next", points: pts, cursor: s.cursor, lastPoint: pts[pts.length - 1] };
        return [ns, { draft: holeDraft(pts, s.cursor) }];
      }
      if (input.id === "close" && s.points.length >= 3) return finish(s.points, ctx);
      return [s, { draft: holeDraft(s.points, s.cursor) }];
    }
    if (input.kind !== "point") return [s, { draft: s.phase === "next" ? holeDraft(s.points, s.cursor) : null }];
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: HoleDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt };
      return [ns, { draft: holeDraft([pt], pt) }];
    }
    // Klick nahe Startpunkt schliesst die Kontur.
    if (s.points.length >= 3 && dist(s.points[0], pt) < CLOSE_HIT) return finish(s.points, ctx);
    // Null-Strecke ignorieren.
    if (dist(s.points[s.points.length - 1], pt) < EPS) return [s, { draft: holeDraft(s.points, s.cursor) }];
    const points = [...s.points, pt];
    const ns: HoleDrawing = { phase: "next", points, cursor: pt, lastPoint: pt };
    return [ns, { draft: holeDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as HoleState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: HoleDrawing = { ...s, cursor: point };
    return [ns, { draft: holeDraft(s.points, point) }];
  },

  // Enter/Rechtsklick: ≥ 3 Punkte Polygon, 2 Punkte Rechteck.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as HoleState;
    if (s.phase === "next" && s.points.length >= 2) return finish(s.points, ctx);
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),
};
