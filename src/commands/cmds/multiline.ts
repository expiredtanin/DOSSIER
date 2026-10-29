// Multiline — zeichnet in EINER Geste eine gerade Basislinie PLUS N−1 dazu
// parallel versetzte Kopien (gleicher Abstand, gleiche Seite), z. B. für
// Doppellinien/Leitungstrassen/Abstandslinien. Baut auf derselben Offset-
// Geometrie wie der bestehende `offset`-Befehl auf (`kernel2d::offset_segment`, Kern `cmd_draw.rs`), erzeugt
// aber alle Kopien auf einmal statt einzeln nacheinander offsetten zu müssen.
// Schritte:
//   1) „Startpunkt:"  → Punkt
//   2) „Endpunkt:"     → Punkt (Tab-Felder Länge/Winkel wie bei Line)
//   3) „Abstand/Seite:" → Distanz tippen (persistent über Aufrufe, wie bei
//      Offset) ODER Seite per Klick (Vorzeichen aus der Klickseite) → commit
//      ALLER `count` Linien (Basislinie + count−1 Kopien bei d, 2d, …).
//      Die Anzahl `count` zyklt über eine Inline-Option (2..6, dann zurück zu 2).
//
// Reine gerade Basislinien (kein Polylinien-Multiline) — deckt den häufigsten
// Anwendungsfall ab (Grenzlinie+Abstand, Leitungspaar, Randlinien), ohne die
// Komplexität einer mehrsegmentigen Variante.

import { segmentHud } from "../../tools/types";
import type {
  CmdOption,
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview } from "../createCore";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const MIN_COUNT = 2;
const MAX_COUNT = 6;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Persistente Einstellungen über Aufrufe hinweg (wie `lastDistance` bei Offset). */
let lastSpacing = 0.3;
let lastSign = 1; // +1 = links, −1 = rechts
let lastCount = 3;

const LINE_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

function endFromFields(a: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? a;
  const length = "length" in locks ? locks.length : segLen(a, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(a, ref);
  const ang = angleDeg * DEG;
  return { x: a.x + Math.cos(ang) * length, y: a.y + Math.sin(ang) * length };
}

/** Vorzeichen (+links / −rechts) für einen Klickpunkt relativ zur Basislinie a→b. */
/**
 * Vorschau im Kern (`cmd_draw.rs`): Original a→b + (count−1) parallele Kopien im Abstand `spacing` auf
 * der Seite `sign` (fehlt sie, die Seite des Cursors). `side` = Seite des Cursors (+1 links, −1 rechts).
 */
function multilineAt(ctx: CommandContext, a: Vec2, b: Vec2, cursor: Vec2 | null, sign: number | null) {
  const pv = createPreview(ctx, { cmd: "multiline", spacing: lastSpacing, count: lastCount, sign }, cursor ? [a, b, cursor] : [a, b]);
  return { shapes: pv.shapes, side: pv.info[0] };
}

/** Commit (Kern): Original + parallele Kopien als einzelne Linien (Null-Strecke → nichts). */
const appendMultiline = (a: Vec2, b: Vec2, spacing: number, sign: number, count: number, ctx: CommandContext) =>
  createMutation(ctx, { cmd: "multiline", a, b, spacing, sign, count });

const COUNT_OPTION: CmdOption = { id: "count", labelKey: "cmd.multiline.count" };

// ── Zustand ───────────────────────────────────────────────────────────────────
interface MlStart extends CommandState {
  phase: "start";
}
interface MlEnd extends CommandState {
  phase: "end";
  a: Vec2;
  cursor: Vec2 | null;
}
interface MlSpacing extends CommandState {
  phase: "spacing";
  a: Vec2;
  b: Vec2;
  cursor: Vec2 | null;
}
type MlState = MlStart | MlEnd | MlSpacing;

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as MlStart,
  { draft: null, done: true },
];

/** Vorschau aller `lastCount` Linien bei gegebenem Abstand+Seite. */
function spacingDraft(ctx: CommandContext, a: Vec2, b: Vec2, spacing: number, sign: number | null, at: Vec2 | null): ToolDraft {
  const draft: ToolDraft = { preview: multilineAt(ctx, a, b, at, sign).shapes, vertices: [a, b] };
  if (at) draft.hud = { at, text: `${spacing.toFixed(2)} m × ${lastCount}` };
  return draft;
}

export const multilineCommand: Command = {
  name: "multiline",
  labelKey: "cmd.multiline.label",
  prompt: (s) => {
    const ms = s as MlState;
    if (ms.phase === "end") return "cmd.multiline.end";
    if (ms.phase === "spacing") return "cmd.multiline.spacing";
    return "cmd.multiline.start";
  },
  accepts: (s) => ((s as MlState).phase === "spacing" ? ["point", "number", "option"] : ["point"]),
  options: (s) => ((s as MlState).phase === "spacing" ? [{ ...COUNT_OPTION, value: String(lastCount) }] : []),

  init: (): MlStart => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx: CommandContext): [CommandState, CommandResult] => {
    const s = state as MlState;

    if (s.phase === "start") {
      if (input.kind !== "point") return [s, { draft: null }];
      const next: MlEnd = { phase: "end", a: input.point, cursor: input.point, lastPoint: input.point };
      return [next, { draft: { preview: [], vertices: [input.point] } }];
    }

    if (s.phase === "end") {
      if (input.kind !== "point") return [s, { draft: spacingDraftForEnd(s) }];
      if (segLen(s.a, input.point) < EPS) return idle();
      const next: MlSpacing = { phase: "spacing", a: s.a, b: input.point, cursor: input.point, lastPoint: input.point };
      return [next, { draft: spacingDraft(ctx, next.a, next.b, lastSpacing, lastSign, input.point) }];
    }

    // phase === "spacing"
    if (input.kind === "option") {
      if (input.id === "count") {
        lastCount = lastCount >= MAX_COUNT ? MIN_COUNT : lastCount + 1;
        return [s, { draft: spacingDraft(ctx, s.a, s.b, lastSpacing, s.cursor ? null : lastSign, s.cursor) }];
      }
      return [s, { draft: null }];
    }
    if (input.kind === "number") {
      const mag = Math.abs(input.value);
      if (mag < EPS) return [s, { draft: null }];
      lastSpacing = mag;
      lastSign = input.value < 0 ? -1 : lastSign;
      const { a, b } = s;
      return [
        idle()[0],
        { draft: null, done: true, commit: appendMultiline(a, b, lastSpacing, lastSign, lastCount, ctx) },
      ];
    }
    if (input.kind === "point") {
      lastSign = multilineAt(ctx, s.a, s.b, input.point, null).side;
      const { a, b } = s;
      return [
        idle()[0],
        { draft: null, done: true, commit: appendMultiline(a, b, lastSpacing, lastSign, lastCount, ctx) },
      ];
    }
    return [s, { draft: null }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as MlState;
    if (s.phase === "end") {
      const next: MlEnd = { ...s, cursor: point };
      const preview: DraftShape[] = segLen(s.a, point) >= EPS ? [{ kind: "line", a: s.a, b: point }] : [];
      const draft: ToolDraft = { preview, vertices: [s.a] };
      if (segLen(s.a, point) >= EPS) draft.hud = segmentHud(s.a, point);
      return [next, { draft }];
    }
    if (s.phase === "spacing") {
      const next: MlSpacing = { ...s, cursor: point };
      return [next, { draft: spacingDraft(ctx, s.a, s.b, lastSpacing, null, point) }];
    }
    return [s, { draft: null }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),

  // Tab-Feld-Zyklus nur im „end"-Schritt (Basislinie): Länge + Winkel, wie line.ts.
  fields: (state) => ((state as MlState).phase === "end" ? LINE_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as MlState;
    if (s.phase !== "end") return null;
    return endFromFields(s.a, locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as MlState;
    if (s.phase !== "end" || !cursor) return {};
    return {
      length: segLen(s.a, cursor),
      angle: ((segAngleDeg(s.a, cursor) % 360) + 360) % 360,
    };
  },
};

/** Vorschau der Basislinie im „end"-Schritt (Fallback für Nicht-Punkt-Eingaben). */
function spacingDraftForEnd(s: MlEnd): ToolDraft {
  if (!s.cursor || segLen(s.a, s.cursor) < EPS) return { preview: [], vertices: [s.a] };
  return { preview: [{ kind: "line", a: s.a, b: s.cursor }], vertices: [s.a], hud: segmentHud(s.a, s.cursor) };
}
