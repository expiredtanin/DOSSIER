// Explode — löst die gewählten 2D-Elemente in ihre Einzelteile auf (Block →
// Teilgeometrien, Polylinie → Segmente, Rechteck → vier Linien). Sofort-Befehl
// ohne Punkt-Eingabe (wie Join/Split): wirkt auf die bestehende Auswahl.
//
// Die eigentliche Zerlegung liegt in `editors/explode.ts` — dort auch, was
// bewusst NICHT zerlegt wird (Kreis/Ellipse/Spline/Text/…): diese Elemente
// bleiben unverändert stehen, statt zu verschwinden.

import { explodeDrawings } from "../../editors/explode";
import type { Command, CommandContext, CommandResult, CommandSelection, CommandState } from "../types";

/** Gewählte 2D-Elemente (Mehrfachauswahl bevorzugt). */
function selectedDrawingIds(sel: CommandSelection): string[] {
  if (sel.drawingIds && sel.drawingIds.length) return sel.drawingIds;
  return sel.drawingId ? [sel.drawingId] : [];
}

const done = (): [CommandState, CommandResult] => [
  { phase: "idle", lastPoint: null },
  { draft: null, done: true },
];

export const explodeCommand: Command = {
  name: "explode",
  labelKey: "cmd.explode.label",
  prompt: () => "cmd.explode.label",
  accepts: () => [],
  options: () => [],
  init: (): CommandState => ({ phase: "idle", lastPoint: null }),

  autoRun: (ctx: CommandContext): CommandResult => {
    const ids = selectedDrawingIds(ctx.selection);
    if (ids.length === 0) return { draft: null, done: true };
    return { draft: null, done: true, commit: (p) => explodeDrawings(p, ids) };
  },

  onInput: (): [CommandState, CommandResult] => done(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
