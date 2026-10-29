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

import type { StairShape } from "../../model/types";
import { IDEAL_TREAD, MIN_STEPS } from "../../core";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, createPreview, xy } from "../createCore";

/** Default-Laufbreite (Meter). */
const DEF_WIDTH = 1.0;

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
 * Anfrage an den Kern (`cmd_create.rs`): aus dem Laufzustand entsteht dort die Treppe — Richtung/Länge
 * aus start→cursor, bei L ein symmetrischer zweiter Lauf, bei Wendel der Cursorabstand als Radius;
 * Stufenzahl im Trittmass-Modus „mit“ aus Soll-Auftritt + Lauflänge, sonst gesetzt oder Vorgabe;
 * Steighöhe = Geschosshöhe, falls nicht gesetzt; Ebene „40“.
 */
const stairReq = (s: StairRun) => ({
  cmd: "stair",
  shape: s.shape,
  up: s.up,
  width: s.width,
  referenz: s.referenz,
  treadMode: s.treadMode,
  auftritt: s.auftritt,
  steps: s.steps,
  rise: s.rise,
  start: xy(s.start),
  cursor: xy(s.cursor),
});

/** Vorschau: Tritt-Linien + Podest + Lauflinie (Kern) + HUD (Länge · Stufenanzahl). */
function runDraft(s: StairRun, ctx: CommandContext): ToolDraft {
  const pv = createPreview(ctx, stairReq(s), []);
  const draft: ToolDraft = { preview: pv.shapes, vertices: [s.start] };
  draft.hud = {
    at: s.cursor,
    text: `${lenOf(sub(s.cursor, s.start)).toFixed(2)} m · ${pv.info[0]} STG`,
  };
  return draft;
}

/** Commit der Treppe (Kern) und die Einstellungen für die nächste Treppe merken. */
function appendStair(s: StairRun, ctx: CommandContext) {
  stairDefaults.shape = s.shape;
  stairDefaults.up = s.up;
  stairDefaults.width = s.width;
  stairDefaults.referenz = s.referenz;
  stairDefaults.treadMode = s.treadMode;
  stairDefaults.auftritt = s.auftritt;
  stairDefaults.steps = s.steps;
  stairDefaults.rise = s.rise;
  return createMutation(ctx, stairReq(s));
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
      { draft: null, done: true, commit: appendStair(ns, ctx) },
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
        { draft: null, done: true, commit: appendStair(ns, ctx) },
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
