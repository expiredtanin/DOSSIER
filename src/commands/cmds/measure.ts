// Messen — schnelles, unverbindliches Distanz-/Winkel-Messwerkzeug (kein Element
// wird erzeugt). Schritte:
//   1) „Messen von:" → Punkt (Startpunkt)
//   2) „bis:"         → Live-Vorschau (Messlinie + Distanz·Winkel im HUD); Klick
//                        setzt einen neuen Startpunkt (fortlaufend messen).
// Esc/Enter beendet. Rein visuell: `commit` bleibt immer leer, das Modell ändert
// sich nie — nur der Entwurf (Linie + HUD) zeigt das Mass.

import type {
  Command,
  CommandResult,
  CommandState,
  ToolDraft,
  Vec2,
} from "../types";

const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

interface MeasureStart extends CommandState {
  phase: "start";
}
interface MeasureTo extends CommandState {
  phase: "to";
  from: Vec2;
  cursor: Vec2 | null;
}
type MeasureState = MeasureStart | MeasureTo;

/** Vorschau: Messlinie from→cursor + Distanz·Winkel im HUD am Cursor. */
function measureDraft(from: Vec2, cursor: Vec2): ToolDraft {
  const dist = segLen(from, cursor);
  const ang = ((segAngleDeg(from, cursor) % 360) + 360) % 360;
  return {
    preview: [{ kind: "line", a: from, b: cursor }],
    vertices: [from, cursor],
    hud: { at: cursor, text: `${dist.toFixed(3)} m · ${ang.toFixed(1)}°` },
  };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as MeasureStart,
  { draft: null, done: true },
];

export const measureCommand: Command = {
  name: "measure",
  labelKey: "cmd.measure.label",
  prompt: (s) => ((s as MeasureState).phase === "to" ? "cmd.measure.to" : "cmd.measure.start"),
  accepts: () => ["point"],
  options: () => [],
  init: (): MeasureStart => ({ phase: "start", lastPoint: null }),

  onInput: (state, input): [CommandState, CommandResult] => {
    const s = state as MeasureState;
    if (input.kind !== "point") {
      return [s, { draft: s.phase === "to" && s.cursor ? measureDraft(s.from, s.cursor) : null }];
    }
    // Jeder Klick setzt den (neuen) Startpunkt — fortlaufendes Messen, bis Esc/Enter.
    const ns: MeasureTo = { phase: "to", from: input.point, cursor: input.point, lastPoint: input.point };
    return [ns, { draft: measureDraft(input.point, input.point) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as MeasureState;
    if (s.phase !== "to") return [s, { draft: null }];
    const ns: MeasureTo = { ...s, cursor: point };
    return [ns, { draft: measureDraft(s.from, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
