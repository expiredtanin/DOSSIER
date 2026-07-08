// Messen — schnelles, unverbindliches Mess-Werkzeug (kein Element wird erzeugt).
// Ein Mess-Pfad ist ein Polygonzug: jeder Klick setzt einen weiteren Stützpunkt.
//   • 1 Punkt gesetzt → Live-Strecke (Länge · Winkel) zum Cursor.
//   • ≥ 2 Punkte gesetzt → zusätzlich aufsummierte Pfadlänge; sobald der Zug
//     (inkl. Cursor) ≥ 3 Ecken hat, zeigt er auch die umschlossene FLÄCHE.
// Rechtsklick/Enter beendet den aktuellen Pfad und armiert einen NEUEN — so misst
// man mehrere nacheinander. Ein weiterer Rechtsklick auf leerem Pfad (bzw. Esc)
// beendet das Werkzeug. Rein visuell: `commit` bleibt immer leer.

import type {
  Command,
  CommandResult,
  CommandState,
  ToolDraft,
  Vec2,
} from "../types";
import type { MeasurementReadout } from "../../tools/types";

const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Aufsummierte Länge eines Polygonzugs (offene Kette). */
function pathLength(pts: Vec2[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += segLen(pts[i - 1], pts[i]);
  return sum;
}

/** Vorzeichenlose Fläche (Gauss/Schuhband), Zug als geschlossen gedacht. */
function polygonArea(pts: Vec2[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

interface MeasureStart extends CommandState {
  phase: "start";
}
interface MeasureDraw extends CommandState {
  phase: "draw";
  /** Bereits gesetzte Stützpunkte (≥ 1). */
  points: Vec2[];
  cursor: Vec2 | null;
}
type MeasureState = MeasureStart | MeasureDraw;

/** Messwerte aus gesetzten Punkten + aktuellem Cursor bilden. */
function readout(points: Vec2[], cursor: Vec2 | null): MeasurementReadout {
  const chain = cursor ? [...points, cursor] : points;
  const last = points[points.length - 1];
  const segment = cursor && last ? segLen(last, cursor) : 0;
  const angle = cursor && last ? ((segAngleDeg(last, cursor) % 360) + 360) % 360 : 0;
  return {
    segment,
    total: pathLength(chain),
    area: chain.length >= 3 ? polygonArea(chain) : null,
    angle,
    points: points.length,
  };
}

/** Vorschau: gesetzter Zug + Live-Segment zum Cursor + HUD + Messwerte. */
function measureDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const chain = cursor ? [...points, cursor] : points;
  const r = readout(points, cursor);
  const hudText =
    r.area != null
      ? `${r.segment.toFixed(3)} m · Σ ${r.total.toFixed(3)} m · ${r.area.toFixed(2)} m²`
      : `${r.segment.toFixed(3)} m · ${r.angle.toFixed(1)}°`;
  return {
    preview: [{ kind: "poly", pts: chain, closed: chain.length >= 3 }],
    vertices: points,
    hud: cursor ? { at: cursor, text: hudText } : undefined,
    measure: r,
  };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as MeasureStart,
  { draft: null, done: true },
];

export const measureCommand: Command = {
  name: "measure",
  labelKey: "cmd.measure.label",
  prompt: (s) => ((s as MeasureState).phase === "draw" ? "cmd.measure.next" : "cmd.measure.start"),
  accepts: () => ["point"],
  options: () => [],
  init: (): MeasureStart => ({ phase: "start", lastPoint: null }),

  onInput: (state, input): [CommandState, CommandResult] => {
    const s = state as MeasureState;
    if (input.kind !== "point") {
      const draft =
        s.phase === "draw" ? measureDraft(s.points, s.cursor) : null;
      return [s, { draft }];
    }
    // Klick hängt einen Stützpunkt an den Pfad (bzw. beginnt einen neuen).
    const points = s.phase === "draw" ? [...s.points, input.point] : [input.point];
    const ns: MeasureDraw = {
      phase: "draw",
      points,
      cursor: input.point,
      lastPoint: input.point,
    };
    return [ns, { draft: measureDraft(points, input.point) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as MeasureState;
    if (s.phase !== "draw") return [s, { draft: null }];
    const ns: MeasureDraw = { ...s, cursor: point };
    return [ns, { draft: measureDraft(s.points, point) }];
  },

  // Rechtsklick/Enter: laufenden Pfad beenden und einen NEUEN armieren (mehrere
  // Messungen nacheinander). Auf leerem Pfad = Werkzeug beenden.
  onConfirm: (state): [CommandState, CommandResult] => {
    const s = state as MeasureState;
    if (s.phase === "draw" && s.points.length > 0) {
      return [{ phase: "start", lastPoint: null } as MeasureStart, { draft: null }];
    }
    return idle();
  },
  // Esc: Werkzeug ganz beenden.
  onCancel: (): [CommandState, CommandResult] => idle(),
};
