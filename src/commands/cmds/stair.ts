// Treppe (Stair) als Engine-Befehl. Ablauf:
//   1) „Startpunkt der Treppe:" → Punkt (Antritt, unterste Stufe).
//   2) „Laufrichtung / Ende:" → Punkt: definiert Richtung + Lauflänge des ersten
//      Laufs. Bei L folgt ein zweiter Lauf (Ende des zweiten Laufs); bei Wendel
//      ist der zweite Punkt der äußere Rand (Radius). Committet die Treppe.
//
// Optionen (togglebar): Grundform gerade/L/Wendel (Auf-/Ab-Umschalter). Tab-Felder
// im Laufschritt: Breite / Stufenanzahl / Steighöhe (totalRise). Live-Vorschau
// zeigt die Tritt-Linien + die Lauflinie.
//
// Herkunft der Treppen-Felder (CommandContext):
//   • floorId     ← ctx.level.id (aktives Geschoss)
//   • categoryCode← "40 Treppen" (Fallback ctx.defaultCategoryCode)
//   • totalRise   ← Geschosshöhe (ctx.level.floorHeight), damit die Treppe genau
//     ins nächste Geschoss steigt (geschossübergreifend).
//
// Bezeichner englisch, sichtbarer Text via t() (CONVENTIONS.md).

import type { Stair, StairShape, Vec2 as MVec2 } from "../../model/types";
import { stairGeometry, defaultStepCount } from "../../geometry/stair";
import { uniqueId } from "../../tools/types";
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

/** Default-Ebene (Kategorie) für Treppen: „40" Treppen (Fallback: aktive). */
const STAIR_CATEGORY = "40";
/** Default-Laufbreite (Meter). */
const DEF_WIDTH = 1.0;
const EPS = 1e-6;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const lenOf = (a: Vec2): number => Math.hypot(a.x, a.y);
const normv = (a: Vec2): Vec2 => {
  const l = lenOf(a) || 1e-9;
  return { x: a.x / l, y: a.y / l };
};

/** Existiert die Treppen-Kategorie („40")? Sonst Fallback auf die aktive. */
function stairCategory(ctx: CommandContext): string {
  const flat: { code: string }[] = [];
  const walk = (list: { code: string; children?: unknown[] }[]) => {
    for (const c of list) {
      flat.push({ code: c.code });
      if (c.children) walk(c.children as { code: string; children?: unknown[] }[]);
    }
  };
  walk(ctx.project.layers as { code: string; children?: unknown[] }[]);
  return flat.some((c) => c.code === STAIR_CATEGORY)
    ? STAIR_CATEGORY
    : ctx.defaultCategoryCode;
}

/** Geschosshöhe als Default-Steighöhe (Fallback 2.6 m). */
function floorRise(ctx: CommandContext): number {
  return ctx.level.floorHeight && ctx.level.floorHeight > 0 ? ctx.level.floorHeight : 2.6;
}

/** Tab-Felder im Laufschritt: Breite / Stufenanzahl / Steighöhe. */
const RUN_FIELDS: CommandField[] = [
  { id: "width", labelKey: "cmd.field.width" },
  { id: "steps", labelKey: "cmd.stair.stepsField" },
  { id: "rise", labelKey: "cmd.stair.riseField" },
];

const SHAPE: CmdOption = { id: "shape", labelKey: "cmd.stair.shape", value: "straight" };
const UPDOWN: CmdOption = { id: "updown", labelKey: "cmd.stair.updown", value: "up" };

interface StairIdle extends CommandState {
  phase: "start";
  shape: StairShape;
  up: boolean;
  width: number;
  steps: number | null; // null = automatisch
  rise: number | null; // null = Geschosshöhe
}
interface StairRun extends CommandState {
  phase: "run";
  shape: StairShape;
  up: boolean;
  width: number;
  steps: number | null;
  rise: number | null;
  start: Vec2;
  cursor: Vec2;
}
type StairCmdState = StairIdle | StairRun;

function initState(shape: StairShape = "straight"): StairIdle {
  return { phase: "start", lastPoint: null, shape, up: true, width: DEF_WIDTH, steps: null, rise: null };
}

/**
 * Baut aus dem Laufzustand ein konkretes `Stair`-Objekt (aufgelöste Felder). Die
 * Richtung/Länge folgen aus start→cursor; bei L bricht der zweite Lauf um 90°
 * (links) ab, bei Wendel wird der Cursorabstand zum Radius.
 */
function buildStair(s: StairRun, ctx: CommandContext): Stair {
  const rise = s.rise ?? floorRise(ctx);
  const d = sub(s.cursor, s.start);
  const dist = Math.max(0.1, lenOf(d));
  const dir = dist > EPS ? normv(d) : ({ x: 1, y: 0 } as MVec2);
  const runLength = s.shape === "spiral" ? Math.max(0.5, dist) : dist;
  const steps = s.steps ?? defaultStepCount(rise, runLength);
  const base: Stair = {
    id: uniqueId("ST"),
    type: "stair",
    floorId: ctx.level.id,
    categoryCode: stairCategory(ctx),
    shape: s.shape,
    start: s.start,
    dir,
    runLength,
    width: s.width,
    totalRise: rise,
    stepCount: steps,
    up: s.up,
  };
  if (s.shape === "L") {
    base.run2Length = runLength; // symmetrischer zweiter Lauf
    base.turn = 1;
  } else if (s.shape === "spiral") {
    base.center = s.start;
    base.radius = dist;
    base.sweep = 270;
    // Startpunkt am äußeren Rand: Lauflinie beginnt hier.
    base.start = s.cursor;
    base.dir = dir;
  }
  return base;
}

/** Vorschau: Tritt-Linien + Lauflinie + HUD (Länge · Stufenanzahl). */
function runDraft(s: StairRun, ctx: CommandContext): ToolDraft {
  const stair = buildStair(s, ctx);
  const rise = stair.totalRise ?? floorRise(ctx);
  const geo = stairGeometry(stair, rise);
  const preview: DraftShape[] = [];
  for (const tr of geo.treads) preview.push({ kind: "poly", pts: tr.pts, closed: true });
  if (geo.landing) preview.push({ kind: "poly", pts: geo.landing, closed: true });
  if (geo.runLine.length >= 2) preview.push({ kind: "poly", pts: geo.runLine, closed: false });
  const draft: ToolDraft = { preview, vertices: [s.start] };
  draft.hud = {
    at: s.cursor,
    text: `${lenOf(sub(s.cursor, s.start)).toFixed(2)} m · ${stair.stepCount} STG`,
  };
  return draft;
}

/** Hängt eine Treppe ans Projekt (immutabel). */
function appendStair(p: Project, s: StairRun, ctx: CommandContext): Project {
  const stair = buildStair(s, ctx);
  const stairs = p.stairs ? [...p.stairs, stair] : [stair];
  return { ...p, stairs };
}

const idle = (from?: StairCmdState): [CommandState, CommandResult] => [
  initState(from?.shape ?? "straight"),
  { draft: null, done: true },
];

export const stairCommand: Command = {
  name: "stair",
  labelKey: "cmd.stair.label",
  floorOnly: true,
  prompt: (s) => ((s as StairCmdState).phase === "run" ? "cmd.stair.run" : "cmd.stair.start"),
  accepts: (s) =>
    (s as StairCmdState).phase === "run"
      ? ["point", "number", "option"]
      : ["point", "option"],
  options: (s): CmdOption[] => {
    const st = s as StairCmdState;
    return [
      { ...SHAPE, value: st.shape },
      { ...UPDOWN, value: st.up ? "up" : "down" },
    ];
  },
  init: (): StairIdle => initState("straight"),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as StairCmdState;

    if (input.kind === "option") {
      const next = { ...s } as StairCmdState;
      if (input.id === "shape") {
        next.shape = s.shape === "straight" ? "L" : s.shape === "L" ? "spiral" : "straight";
      } else if (input.id === "updown") {
        next.up = !s.up;
      }
      return [next, { draft: next.phase === "run" ? runDraft(next as StairRun, ctx) : null }];
    }

    if (input.kind !== "point") {
      return [s, { draft: s.phase === "run" ? runDraft(s as StairRun, ctx) : null }];
    }

    const pt = input.point;
    if (s.phase !== "run") {
      const ns: StairRun = {
        phase: "run",
        lastPoint: pt,
        shape: s.shape,
        up: s.up,
        width: s.width,
        steps: s.steps,
        rise: s.rise,
        start: pt,
        cursor: pt,
      };
      return [ns, { draft: null }];
    }
    // Zweiter Punkt: Lauf definieren + committen (Null-Strecke ignorieren).
    if (lenOf(sub(pt, s.start)) < 0.05) {
      return [{ ...s }, { draft: runDraft(s, ctx) }];
    }
    const ns: StairRun = { ...s, cursor: pt };
    return [
      idle(s)[0],
      { draft: null, done: true, commit: (p) => appendStair(p, ns, ctx) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as StairCmdState;
    if (s.phase !== "run") return [s, { draft: null }];
    const ns: StairRun = { ...s, cursor: point };
    return [ns, { draft: runDraft(ns, ctx) }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as StairCmdState;
    if (s.phase === "run" && lenOf(sub(s.cursor, s.start)) >= 0.05) {
      const ns = s;
      return [
        idle(s)[0],
        { draft: null, done: true, commit: (p) => appendStair(p, ns, ctx) },
      ];
    }
    return idle(s);
  },
  onCancel: (state): [CommandState, CommandResult] => idle(state as StairCmdState),

  fields: (state) => ((state as StairCmdState).phase === "run" ? RUN_FIELDS : []),
  // Getippte Tab-Felder sticky in den State übernehmen; kein Koordinatenpunkt.
  pointFromFields: (state, locks) => {
    const s = state as StairCmdState;
    if ("width" in locks && locks.width > 0) s.width = locks.width;
    if ("steps" in locks && locks.steps >= 2) s.steps = Math.round(locks.steps);
    if ("rise" in locks && locks.rise > 0) s.rise = locks.rise;
    return null;
  },
  fieldValues: (state, _locks, _cursor): Record<string, number> => {
    const s = state as StairCmdState;
    const out: Record<string, number> = { width: s.width };
    if (s.steps != null) out.steps = s.steps;
    if (s.rise != null) out.rise = s.rise;
    return out;
  },
};
