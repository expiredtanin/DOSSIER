// Break — entfernt den Abschnitt ZWISCHEN zwei geklickten Punkten auf einer
// Kurve (line/offene, NICHT gebogene polyline), AutoCADs BREAK-Befehl.
// Nutzer-Wunsch: „Stretch/Break fehlen als Befehle — der Kernel hätte mit
// splitAtIntersections/removeSegment das meiste für Break schon fertig."
// (Tatsächlich reichte eine neue, direktere Kernel-Funktion — `breakCurve` —
// eher als die genannten; s. Kopfkommentar dort.)
//
// Schritte:
//   1) „Erster Punkt:"  → Punkt (bestimmt die Kurve + Startposition)
//   2) „Zweiter Punkt:" → Punkt (Position auf DERSELBEN Kurve) → commit:
//      der Abschnitt zwischen beiden Positionen (Klick-Reihenfolge egal)
//      fällt weg, bis zu zwei Reststücke bleiben.
//
// Bewusst NICHT unterstützt (Klick auf eine geschlossene Kurve oder eine mit
// Bogen-Segmenten bricht NICHT ab, sondern bleibt im ersten Schritt — sonst
// säße der Nutzer nach einem Fehlklick im zweiten Schritt fest, ohne zu
// wissen warum): geschlossene Polylinien/Rechtecke (welcher der beiden
// Ring-Bögen übrig bleibt, ist klick-reihenfolge-abhängig — eigener,
// grösserer Scope) und Bogen-Segmente (bulge) — beide s. PENDENZEN.md.

// Treffer, Reststücke und Vorschau rechnet der Kern (`src-tauri/core/src/cmd_edit.rs`, [K4] S3,
// Geometrie `breakCurve` in `kernel2d`); hier nur der Zustandsautomat.

import { cmdMutation } from "../../core";
import { uniqueStamp } from "../../tools/types";
import { cmdQuery, decodeShapes, pair } from "../../tools/coreCmd";
import type { Command, CommandResult, CommandState, Vec2 } from "../types";

interface BreakP1 extends CommandState {
  phase: "p1";
}
interface BreakP2 extends CommandState {
  phase: "p2";
  /** Getroffene Kurve (id). */
  target: string;
  p1: Vec2;
  cursor: Vec2 | null;
}
type BreakState = BreakP1 | BreakP2;

const idle = (): [CommandState, CommandResult] => [
  { phase: "p1", lastPoint: null } as BreakP1,
  { draft: null, done: true },
];

export const breakCommand: Command = {
  name: "break",
  labelKey: "cmd.break.label",
  prompt: (s) => ((s as BreakState).phase === "p2" ? "cmd.break.p2" : "cmd.break.p1"),
  accepts: () => ["point"],
  options: () => [],
  init: (): BreakP1 => ({ phase: "p1", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as BreakState;
    if (input.kind !== "point") return [s, { draft: null }];
    if (s.phase === "p1") {
      const target = cmdQuery<{ hit: string | null }>(ctx.project, { q: "pickBreakable", level: ctx.level.id, pt: pair(input.point) }).hit;
      if (!target) return [s, { draft: null }]; // daneben/ungeeignet → bleibt im ersten Schritt
      const ns: BreakP2 = { phase: "p2", target, p1: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: null }];
    }
    // phase "p2"
    const { target, p1 } = s;
    return [idle()[0], { draft: null, done: true, commit: cmdMutation({ cmd: "break", id: target, p1: pair(p1), p2: pair(input.point), stamp: uniqueStamp() }) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as BreakState;
    if (s.phase !== "p2") return [s, { draft: null }];
    const ns: BreakP2 = { ...s, cursor: point };
    const preview = decodeShapes(cmdQuery<{ shapes: number[] }>(ctx.project, { q: "break", id: s.target, p1: pair(s.p1), pt: pair(point) }).shapes);
    return [ns, { draft: { preview, vertices: [s.p1] } }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
