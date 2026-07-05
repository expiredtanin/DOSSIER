// Treppe (Stair) als Engine-Befehl. Ablauf:
//   1) „Startpunkt der Treppe:" → Punkt (Antritt, unterste Stufe).
//   2) „Laufrichtung / Ende:" → Punkt: definiert Richtung + Lauflänge des ersten
//      Laufs. Bei L folgt ein zweiter Lauf (Ende des zweiten Laufs); bei Wendel
//      ist der zweite Punkt der äußere Rand (Radius). Committet die Treppe.
//
// Optionen (togglebar, IMMER sichtbar): Grundform gerade/L/Wendel, Auf-/Ab-
// Umschalter, Referenz (links/mitte/rechts), Trittmass-Modus (mit/ohne).
// Tab-Felder in BEIDEN Phasen: Breite (idle + run). Im Laufschritt zusätzlich:
//   • Trittmass-Modus „ohne": Stufen + Steighöhe (heutiges Verhalten).
//   • Trittmass-Modus „mit" : Auftritt (Soll-Trittmass); Stufenzahl wird daraus
//     abgeleitet: steps = clamp(round(runLength / auftritt), MIN_STEPS, …).
//
// Herkunft der Treppen-Felder (CommandContext):
//   • floorId     ← ctx.level.id (aktives Geschoss)
//   • categoryCode← "40 Treppen" (Fallback ctx.defaultCategoryCode)
//   • totalRise   ← Geschosshöhe (ctx.level.floorHeight), damit die Treppe genau
//     ins nächste Geschoss steigt (geschossübergreifend).
//
// Bezeichner englisch, sichtbarer Text via t() (CONVENTIONS.md).

import type { Stair, StairShape, Vec2 as MVec2 } from "../../model/types";
import { stairGeometry, defaultStepCount, IDEAL_TREAD, MIN_STEPS } from "../../geometry/stair";
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

// ── Trittmass-Modus ──────────────────────────────────────────────────────────
/** Trittmass-Modus: „with" = Soll-Auftritt vorgegeben, Stufen abgeleitet;
 *  „without" = heutiges Verhalten (freies Stufen-Feld). */
type TreadMode = "with" | "without";

// ── Persistente Defaults (modulweit, leben über Befehls-Instanzen hinweg) ────
/** Letzte Nutzer-Einstellungen für Treppen; wird von jeder neuen Instanz gelesen
 *  und nach jedem Commit aktualisiert. */
const stairDefaults: {
  shape: StairShape;
  up: boolean;
  width: number;
  referenz: "links" | "mitte" | "rechts";
  treadMode: TreadMode;
  auftritt: number; // Soll-Trittmass (Meter)
  steps: number | null;
  rise: number | null;
} = {
  shape: "straight",
  up: true,
  width: DEF_WIDTH,
  referenz: "mitte",
  treadMode: "without",
  auftritt: IDEAL_TREAD,
  steps: null,
  rise: null,
};

// ── Vektor-Helfer ─────────────────────────────────────────────────────────────
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

// ── Trittmass-Ableitung ───────────────────────────────────────────────────────
/**
 * Leitet die Stufenzahl aus Auftritt (Soll-Trittmass) + Lauflänge ab.
 * Klemmt auf [MIN_STEPS, maxByRun] (mind. 0.24 m Auftrittstiefe).
 * Entspricht dem `target_a`-Modus im Rhino-Plugin (_make_treppe_preview_handler).
 */
export function stepsFromTread(auftritt: number, runLength: number): number {
  const a = Math.max(0.05, auftritt);
  const raw = Math.round(runLength / a);
  // Auftrittstiefe aus Stufenzahl darf nicht unter 0.24 m sinken.
  const maxByRun = runLength > 0 ? Math.max(MIN_STEPS, Math.floor(runLength / 0.24) + 1) : raw;
  return Math.max(MIN_STEPS, Math.min(raw, maxByRun));
}

// ── Felder (Tab-Zyklus) ───────────────────────────────────────────────────────
/** Tab-Feld: Breite (immer, ab idle). */
const FIELD_WIDTH: CommandField = { id: "width", labelKey: "cmd.field.width" };
/** Tab-Feld: Stufenanzahl (run-Phase, nur Trittmass-Modus „ohne"). */
const FIELD_STEPS: CommandField = { id: "steps", labelKey: "cmd.stair.stepsField" };
/** Tab-Feld: Steighöhe (run-Phase, nur Trittmass-Modus „ohne"). */
const FIELD_RISE: CommandField = { id: "rise", labelKey: "cmd.stair.riseField" };
/** Tab-Feld: Auftritt (run-Phase, nur Trittmass-Modus „mit"). */
const FIELD_AUFTRITT: CommandField = { id: "auftritt", labelKey: "cmd.stair.auftrittField" };

// ── Optionen (immer sichtbar) ─────────────────────────────────────────────────
const SHAPE: CmdOption = { id: "shape", labelKey: "cmd.stair.shape", value: "straight" };
const UPDOWN: CmdOption = { id: "updown", labelKey: "cmd.stair.updown", value: "up" };
const REFERENZ: CmdOption = { id: "referenz", labelKey: "cmd.stair.referenz", value: "mitte" };
const TREAD_MODE: CmdOption = { id: "treadMode", labelKey: "cmd.stair.treadMode", value: "without" };

// ── Zustands-Typen ────────────────────────────────────────────────────────────
interface StairIdle extends CommandState {
  phase: "start";
  shape: StairShape;
  up: boolean;
  width: number;
  referenz: "links" | "mitte" | "rechts";
  treadMode: TreadMode;
  auftritt: number;
  steps: number | null; // null = automatisch
  rise: number | null; // null = Geschosshöhe
}
interface StairRun extends CommandState {
  phase: "run";
  shape: StairShape;
  up: boolean;
  width: number;
  referenz: "links" | "mitte" | "rechts";
  treadMode: TreadMode;
  auftritt: number;
  steps: number | null;
  rise: number | null;
  start: Vec2;
  cursor: Vec2;
}
type StairCmdState = StairIdle | StairRun;

/** Neuer Ruhezustand aus den modulweiten Defaults (oder überschrieben). */
function initState(override?: Partial<typeof stairDefaults>): StairIdle {
  const d = { ...stairDefaults, ...override };
  return {
    phase: "start",
    lastPoint: null,
    shape: d.shape,
    up: d.up,
    width: d.width,
    referenz: d.referenz,
    treadMode: d.treadMode,
    auftritt: d.auftritt,
    steps: d.steps,
    rise: d.rise,
  };
}

/**
 * Baut aus dem Laufzustand ein konkretes `Stair`-Objekt (aufgelöste Felder). Die
 * Richtung/Länge folgen aus start→cursor; bei L bricht der zweite Lauf um 90°
 * (links) ab, bei Wendel wird der Cursorabstand zum Radius.
 *
 * Im Trittmass-Modus „mit" wird die Stufenzahl aus dem Soll-Auftritt + der
 * aktuellen Lauflänge abgeleitet (stepsFromTread), kein freies steps-Feld.
 */
function buildStair(s: StairRun, ctx: CommandContext): Stair {
  const rise = s.rise ?? floorRise(ctx);
  const d = sub(s.cursor, s.start);
  const dist = Math.max(0.1, lenOf(d));
  const dir = dist > EPS ? normv(d) : ({ x: 1, y: 0 } as MVec2);
  const runLength = s.shape === "spiral" ? Math.max(0.5, dist) : dist;

  // Stufenzahl je Trittmass-Modus:
  //   „mit Trittmass" → aus Auftritt + Lauflänge ableiten (Soll-Schrittmass).
  //   „ohne Trittmass" → manuell oder defaultStepCount (heutiges Verhalten).
  const steps =
    s.treadMode === "with"
      ? stepsFromTread(s.auftritt, runLength)
      : (s.steps ?? defaultStepCount(rise, runLength));

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
    referenz: s.referenz,
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

/** Hängt eine Treppe ans Projekt (immutabel) und aktualisiert die Defaults. */
function appendStair(p: Project, s: StairRun, ctx: CommandContext): Project {
  const stair = buildStair(s, ctx);
  // Zuletzt genutzte Einstellungen für die nächste Treppe merken.
  stairDefaults.shape = s.shape;
  stairDefaults.up = s.up;
  stairDefaults.width = s.width;
  stairDefaults.referenz = s.referenz;
  stairDefaults.treadMode = s.treadMode;
  stairDefaults.auftritt = s.auftritt;
  stairDefaults.steps = s.steps;
  stairDefaults.rise = s.rise;
  const stairs = p.stairs ? [...p.stairs, stair] : [stair];
  return { ...p, stairs };
}

const idle = (from?: StairCmdState): [CommandState, CommandResult] => [
  initState(from ? {
    shape: from.shape,
    up: from.up,
    width: from.width,
    referenz: from.referenz,
    treadMode: from.treadMode,
    auftritt: from.auftritt,
    steps: from.steps,
    rise: from.rise,
  } : undefined),
  { draft: null, done: true },
];

// ── Referenz-Toggle-Zyklus ────────────────────────────────────────────────────
function nextReferenz(r: "links" | "mitte" | "rechts"): "links" | "mitte" | "rechts" {
  return r === "links" ? "mitte" : r === "mitte" ? "rechts" : "links";
}

// ── Command-Export ────────────────────────────────────────────────────────────
export const stairCommand: Command = {
  name: "stair",
  labelKey: "cmd.stair.label",
  floorOnly: true,
  prompt: (s) => ((s as StairCmdState).phase === "run" ? "cmd.stair.run" : "cmd.stair.start"),
  accepts: (s) =>
    (s as StairCmdState).phase === "run"
      ? ["point", "number", "option"]
      : ["point", "option"],

  /** Optionen werden IMMER angezeigt (idle + run): Grundform, Auf/Ab, Referenz,
   *  Trittmass-Modus. */
  options: (s): CmdOption[] => {
    const st = s as StairCmdState;
    return [
      { ...SHAPE, value: st.shape },
      { ...UPDOWN, value: st.up ? "up" : "down" },
      { ...REFERENZ, value: st.referenz },
      { ...TREAD_MODE, value: st.treadMode },
    ];
  },

  init: (): StairIdle => initState(),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as StairCmdState;

    if (input.kind === "option") {
      const next = { ...s } as StairCmdState;
      if (input.id === "shape") {
        next.shape = s.shape === "straight" ? "L" : s.shape === "L" ? "spiral" : "straight";
      } else if (input.id === "updown") {
        next.up = !s.up;
      } else if (input.id === "referenz") {
        next.referenz = nextReferenz(s.referenz);
      } else if (input.id === "treadMode") {
        next.treadMode = s.treadMode === "with" ? "without" : "with";
        // Im „mit"-Modus freie Stufenzahl zurücksetzen (wird abgeleitet).
        if (next.treadMode === "with") next.steps = null;
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
        referenz: s.referenz,
        treadMode: s.treadMode,
        auftritt: s.auftritt,
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

  /**
   * Tab-Felder:
   *   • idle-Phase: [Breite] (Konfiguration VOR dem ersten Punkt).
   *   • run-Phase, Trittmass-Modus „ohne": [Breite, Stufen, Steighöhe].
   *   • run-Phase, Trittmass-Modus „mit" : [Breite, Auftritt].
   */
  fields: (state): CommandField[] => {
    const s = state as StairCmdState;
    if (s.phase === "start") {
      return [FIELD_WIDTH];
    }
    // run-Phase
    if (s.treadMode === "with") {
      return [FIELD_WIDTH, FIELD_AUFTRITT];
    }
    return [FIELD_WIDTH, FIELD_STEPS, FIELD_RISE];
  },

  /** Getippte Tab-Felder sticky in den State übernehmen; kein Koordinatenpunkt. */
  pointFromFields: (state, locks) => {
    const s = state as StairCmdState;
    if ("width" in locks && locks.width > 0) s.width = locks.width;
    if (s.phase === "run") {
      if ("auftritt" in locks && locks.auftritt > 0) s.auftritt = locks.auftritt;
      // Stufen + Steighöhe nur im „ohne"-Modus als freie Felder.
      if (s.treadMode === "without") {
        if ("steps" in locks && locks.steps >= MIN_STEPS) s.steps = Math.round(locks.steps);
        if ("rise" in locks && locks.rise > 0) s.rise = locks.rise;
      }
    }
    return null;
  },

  fieldValues: (state, _locks, _cursor): Record<string, number> => {
    const s = state as StairCmdState;
    const out: Record<string, number> = { width: s.width };
    if (s.phase === "run") {
      if (s.treadMode === "with") {
        out.auftritt = s.auftritt;
      } else {
        if (s.steps != null) out.steps = s.steps;
        if (s.rise != null) out.rise = s.rise;
      }
    }
    return out;
  },
};
