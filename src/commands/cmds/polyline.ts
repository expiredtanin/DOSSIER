// Polyline — mehrteiliger Zug (portiert polylineTool). Schritte:
//   1) „Startpunkt:" → Punkt
//   2) „Nächster Punkt ( Schliessen Zurück ):" → Punkt … (Enter beendet offen,
//      „Schliessen" schließt; Klick auf den Startpunkt schließt ebenfalls)
//
// Akzeptiert je Punkt Maus-Picks UND getippte Koordinaten (0,0 · r3,0 · 5<45).

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const CLOSE_HIT = 0.08; // Modell-Meter: Klick nahe Startpunkt schließt den Zug
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Tab-Felder je weiteren Punkt: Länge + Winkel relativ zum letzten Punkt. */
const POLY_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

/** Nächster Punkt aus gelockten Feldern (length/angle) + Cursor, relativ zu `last`. */
function polyNextFromFields(last: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? last;
  const length = "length" in locks ? locks.length : segLen(last, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(last, ref);
  const ang = angleDeg * DEG;
  return { x: last.x + Math.cos(ang) * length, y: last.y + Math.sin(ang) * length };
}

interface PolyIdle extends CommandState {
  phase: "start";
  /** Gewählter Schließ-Modus (bleibt über den Befehl hinweg erhalten). */
  closed: boolean;
}
interface PolyDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
  /** Soll der committete Zug als Ring (geschlossen) gelten? Default: offen. */
  closed: boolean;
}
type PolyState = PolyIdle | PolyDrawing;

/** Sofort-schließen-Aktion (nur ≥3 Punkte): committet als Ring und beendet. */
const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };
/** Toggle-Option: Ergebnis geschlossen (Ring) oder offen — im Feld-Row sichtbar. */
const closedOption = (closed: boolean): CmdOption => ({
  id: "mode",
  labelKey: "cmd.polyline.closedOpt",
  value: closed ? "on" : "off",
});

/** Vorschau (Zug + Gummiband zum Cursor) + HUD (Länge·Winkel des letzten Segments). */
function polyDraft(points: Vec2[], cursor: Vec2 | null, closed = false): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  // Ring nur ab 3 Punkten zeigen; darunter bleibt die Vorschau offen.
  const showClosed = closed && pts.length >= 3;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: showClosed }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

/** Hängt eine 2D-Polylinie ans Projekt (immutabel). Farbe/Strich erbt die Kategorie. */
function appendPolyline(
  p: Project,
  pts: Vec2[],
  closed: boolean,
  ctx: CommandContext,
): Project {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts, closed },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

/** Ruhezustand; behält den zuletzt gewählten Schließ-Modus bei. */
const idle = (closed = false): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null, closed } as PolyIdle,
  { draft: null, done: true },
];

export const polylineCommand: Command = {
  name: "polyline",
  labelKey: "cmd.polyline.label",
  prompt: (s) => ((s as PolyState).phase === "next" ? "cmd.polyline.next" : "cmd.polyline.start"),
  // Auch im Startschritt darf der Schließ-Modus gewählt werden.
  accepts: () => ["point", "number", "option"],
  options: (s) => {
    const ps = s as PolyState;
    const toggle = closedOption(ps.closed);
    if (ps.phase !== "next") return [toggle];
    return ps.points.length >= 2 ? [CLOSE, toggle, UNDO] : [toggle, UNDO];
  },
  init: (): PolyIdle => ({ phase: "start", lastPoint: null, closed: false }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as PolyState;

    if (input.kind === "option") {
      // Schließ-Modus umschalten (Tastenkürzel „C" bzw. Klick im Feld-Row);
      // in jedem Schritt verfügbar, ohne den laufenden Zug zu beenden.
      if (input.id === "mode") {
        const ns = { ...s, closed: !s.closed } as PolyState;
        return [ns, { draft: s.phase === "next" ? polyDraft(s.points, s.cursor, ns.closed) : null }];
      }
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0)
          return [{ phase: "start", lastPoint: null, closed: s.closed } as PolyIdle, { draft: null }];
        const ns: PolyDrawing = {
          phase: "next",
          points: pts,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
          closed: s.closed,
        };
        return [ns, { draft: polyDraft(pts, s.cursor, s.closed) }];
      }
      // Sofort schließen: committet als Ring (unabhängig vom Toggle-Zustand).
      if (input.id === "close" && s.points.length >= 3) {
        const pts = s.points;
        return [
          { phase: "start", lastPoint: null, closed: s.closed } as PolyIdle,
          { draft: null, done: true, commit: (p) => appendPolyline(p, pts, true, ctx) },
        ];
      }
      return [s, { draft: polyDraft(s.points, s.cursor, s.closed) }];
    }

    if (input.kind !== "point") {
      return [s, { draft: s.phase === "next" ? polyDraft(s.points, s.cursor, s.closed) : null }];
    }
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: PolyDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt, closed: s.closed };
      return [ns, { draft: polyDraft([pt], pt, s.closed) }];
    }
    // Klick nahe Startpunkt → schließen (committet als Ring).
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      const pts = s.points;
      return [
        { phase: "start", lastPoint: null, closed: s.closed } as PolyIdle,
        { draft: null, done: true, commit: (p) => appendPolyline(p, pts, true, ctx) },
      ];
    }
    const points = [...s.points, pt];
    const ns: PolyDrawing = { phase: "next", points, cursor: pt, lastPoint: pt, closed: s.closed };
    return [ns, { draft: polyDraft(points, pt, s.closed) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as PolyState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: PolyDrawing = { ...s, cursor: point };
    return [ns, { draft: polyDraft(s.points, point, s.closed) }];
  },

  // Enter/Space/Rechtsklick: Zug beenden (≥2 Punkte). Der Schließ-Modus des
  // Toggles bestimmt, ob als Ring oder offen committet wird. Ein Ring braucht
  // ≥3 Punkte, sonst fällt er auf „offen" zurück.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as PolyState;
    if (s.phase === "next" && s.points.length >= 2) {
      const pts = s.points;
      const close = s.closed && pts.length >= 3;
      return [
        { phase: "start", lastPoint: null, closed: s.closed } as PolyIdle,
        { draft: null, done: true, commit: (p) => appendPolyline(p, pts, close, ctx) },
      ];
    }
    return idle(s.closed);
  },
  onCancel: (state): [CommandState, CommandResult] => idle((state as PolyState).closed),

  // Tab-Feld-Zyklus nur im „next"-Schritt: Länge + Winkel relativ zum letzten
  // Punkt. (Erster Punkt = freie Koordinate, kein Feld-Modus.)
  fields: (state) => ((state as PolyState).phase === "next" ? POLY_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as PolyState;
    if (s.phase !== "next" || s.points.length === 0) return null;
    return polyNextFromFields(s.points[s.points.length - 1], locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as PolyState;
    if (s.phase !== "next" || s.points.length === 0 || !cursor) return {};
    const last = s.points[s.points.length - 1];
    return {
      length: segLen(last, cursor),
      angle: ((segAngleDeg(last, cursor) % 360) + 360) % 360,
    };
  },
};
