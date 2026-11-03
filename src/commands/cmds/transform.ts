// Bewegen / Drehen / Spiegeln der AKTUELLEN Auswahl ([123]: einzige Fassung — vorher lief daneben
// eine eigene Transformations-Maschine in App.tsx). Ein Befehl je Operation, gleiche Mechanik:
//   Bewegen:  Basispunkt → Zielpunkt              (Feld „Distanz" ab Basispunkt)
//   Drehen:   Drehzentrum → Bezugspunkt → Ziel    (Feld „Winkel" ab Bezugsrichtung)
//   Spiegeln: erster → zweiter Achsenpunkt
// Optionen U/I/O/P = Kopiermodus (Bewegen/Kopie/N Kopien/Verteilen); er ist kein Schritt (`sticky`),
// Esc nimmt nur Punkte zurück ([99]). Enter = Klick auf die letzte (gesnappte) Mausposition.
// Die Auswahl kommt aus `ctx.selection` (erst wählen, dann Befehl; `needsSelection` lässt den
// Befehl ohne Auswahl gar nicht starten). Commit über `transformMutation` (Kern `cmd_transform`).

import {
  hasTransformSelection,
  rotateGizmoShapes,
  toTransformSel,
  transformMutation,
  transformPreview,
  type CopyMode,
} from "../../tools/transform";
import type { TranslationKey } from "../../i18n";
import type {
  CmdInput,
  CmdOption,
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  Vec2,
} from "../types";

export type TransformCmdOp = "move" | "rotate" | "mirror";

interface Sticky extends Record<string, unknown> {
  copyMode: CopyMode;
  count: number;
}
interface TrState extends CommandState {
  /** `p<n>` = n Punkte gesetzt; „done" nach Commit/ohne Auswahl. */
  phase: string;
  points: Vec2[];
  cursor: Vec2 | null;
  sticky: Sticky;
}

const MODES: { id: CopyMode; labelKey: TranslationKey; key: string }[] = [
  { id: "move", labelKey: "transform.mode.move", key: "U" },
  { id: "copy", labelKey: "transform.mode.copy", key: "I" },
  { id: "array", labelKey: "transform.mode.array", key: "O" },
  { id: "distribute", labelKey: "transform.mode.distribute", key: "P" },
];
const DEG = Math.PI / 180;
const DISTANCE: CommandField[] = [{ id: "distance", labelKey: "cmd.field.distance" }];
const ANGLE: CommandField[] = [{ id: "angle", labelKey: "cmd.field.angle" }];

const need = (op: TransformCmdOp): number => (op === "rotate" ? 3 : 2);

function stateOf(points: Vec2[], cursor: Vec2 | null, sticky: Sticky): TrState {
  return {
    phase: `p${points.length}`,
    points,
    cursor,
    sticky,
    lastPoint: points.length ? points[points.length - 1] : null,
  };
}

const done = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as CommandState,
  { draft: null, done: true },
];

/** Live-Drehwinkel (Grad, 0…360) von der Bezugsrichtung zum Cursor. */
function liveAngle(c: Vec2, ref: Vec2, cursor: Vec2): number {
  const a0 = Math.atan2(ref.y - c.y, ref.x - c.x);
  const a1 = Math.atan2(cursor.y - c.y, cursor.x - c.x);
  return ((((a1 - a0) * 180) / Math.PI) % 360 + 360) % 360;
}

export function makeTransformCommand(op: TransformCmdOp, labelKey: TranslationKey): Command {
  const fieldsOf = (s: TrState): CommandField[] =>
    op === "move" && s.points.length === 1 ? DISTANCE : op === "rotate" && s.points.length === 2 ? ANGLE : [];

  const preview = (s: TrState, cursor: Vec2, ctx: CommandContext): CommandResult => {
    const eff = [...s.points, cursor].slice(0, need(op));
    const shapes =
      eff.length === need(op)
        ? transformPreview(ctx.project, toTransformSel(ctx.selection), op, eff, s.sticky.copyMode, s.sticky.count)
        : [];
    // Dreh-Darstellung (Radius-Kreis + Bezugs-/Winkelstrahl) zusätzlich, sobald Zentrum+Bezug stehen.
    const gizmo = op === "rotate" && s.points.length === 2 ? rotateGizmoShapes(s.points[0], s.points[1], cursor) : [];
    return { draft: { preview: [...shapes, ...gizmo], vertices: s.points, hud: { at: cursor } } };
  };

  const input = (state: CommandState, inp: CmdInput, ctx: CommandContext): [CommandState, CommandResult] => {
    const s = state as TrState;
    if (s.phase === "done" || !hasTransformSelection(ctx.selection)) return done();
    if (inp.kind === "option") {
      const mode = MODES.find((m) => m.id === inp.id);
      if (!mode) return [s, { draft: s.cursor ? preview(s, s.cursor, ctx).draft : null }];
      const count = inp.value !== undefined && inp.value >= 1 ? Math.round(inp.value) : s.sticky.count;
      const ns: TrState = { ...s, sticky: { copyMode: mode.id, count } };
      return [ns, { draft: ns.cursor ? preview(ns, ns.cursor, ctx).draft : null }];
    }
    if (inp.kind !== "point") return [s, { draft: null }];
    const points = [...s.points, inp.point];
    if (points.length < need(op)) {
      const ns = stateOf(points, inp.point, s.sticky);
      return [ns, preview(ns, inp.point, ctx)];
    }
    const { copyMode, count } = s.sticky;
    return [
      { phase: "done", lastPoint: null } as CommandState,
      { draft: null, done: true, commit: transformMutation(toTransformSel(ctx.selection), op, points, copyMode, count) },
    ];
  };

  return {
    name: op,
    labelKey,
    needsSelection: "transform.needSelection",
    prompt: (state) => {
      const s = state as TrState;
      if (s.phase === "done") return "cmd.move.empty";
      return `transform.hint.${op}.${Math.min(s.points.length, need(op) - 1)}` as TranslationKey;
    },
    accepts: () => ["point", "option"],
    options: (state): CmdOption[] => {
      const s = state as TrState;
      if (!s.sticky) return [];
      return MODES.map((m) => ({
        id: m.id,
        labelKey: m.labelKey,
        key: m.key,
        active: s.sticky.copyMode === m.id,
        // ×Anzahl nur beim aktiven Reihen-/Verteilungs-Modus.
        value: (m.id === "array" || m.id === "distribute") && s.sticky.copyMode === m.id ? `×${s.sticky.count}` : undefined,
      }));
    },
    init: () => stateOf([], null, { copyMode: "move", count: 1 }),
    onInput: input,
    onMove: (state, point, _snap, ctx) => {
      const s = state as TrState;
      if (s.phase === "done") return [s, { draft: null }];
      const ns: TrState = { ...s, cursor: point };
      return [ns, preview(ns, point, ctx)];
    },
    // Enter = Klick auf die letzte Mausposition (setzt den nächsten Punkt bzw. schliesst ab).
    onConfirm: (state, ctx) => {
      const s = state as TrState;
      if (s.phase === "done") return done();
      if (!s.cursor) return [s, { draft: null }];
      return input(s, { kind: "point", point: s.cursor }, ctx);
    },
    onCancel: () => done(),
    fields: (state) => ((state as TrState).points ? fieldsOf(state as TrState) : []),
    // Getippte Distanz (Bewegen) entlang der Live-Richtung bzw. Winkel (Drehen) ab der Bezugsrichtung.
    pointFromFields: (state, locks, cursor) => {
      const s = state as TrState;
      if (op === "move" && s.points.length === 1 && "distance" in locks) {
        const base = s.points[0];
        const c = cursor ?? base;
        const dx = c.x - base.x, dy = c.y - base.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: base.x + (dx / len) * locks.distance, y: base.y + (dy / len) * locks.distance };
      }
      if (op === "rotate" && s.points.length === 2 && "angle" in locks) {
        const [c, ref] = s.points;
        const a = Math.atan2(ref.y - c.y, ref.x - c.x) + locks.angle * DEG;
        const r = Math.hypot(ref.x - c.x, ref.y - c.y) || 1;
        return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
      }
      return cursor;
    },
    fieldValues: (state, _locks, cursor): Record<string, number> => {
      const s = state as TrState;
      if (!cursor) return {};
      if (op === "move" && s.points.length === 1) {
        return { distance: Math.hypot(cursor.x - s.points[0].x, cursor.y - s.points[0].y) };
      }
      if (op === "rotate" && s.points.length === 2) return { angle: liveAngle(s.points[0], s.points[1], cursor) };
      return {};
    },
  };
}

export const moveCommand = makeTransformCommand("move", "cmd.move.label");
export const rotateCommand = makeTransformCommand("rotate", "cmd.rotate.label");
export const mirrorCommand = makeTransformCommand("mirror", "cmd.mirror.label");
