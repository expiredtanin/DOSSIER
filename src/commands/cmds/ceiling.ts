// Ceiling — Decke als echter Engine-Befehl (analog polyline: ein GESCHLOSSENER
// Umriss), committet aber ein einzelnes `Ceiling`-Bauteil statt einer 2D-Form.
// Schritte:
//   1) „Erster Umrisspunkt der Decke:" → Punkt
//   2) „Nächster Punkt ( Schliessen Zurück ):" → Punkt … Der Umriss schließt per
//      Klick auf den Startpunkt, Option „Schliessen" (C) oder Enter (≥3 Punkte).
//
// Akzeptiert je Punkt Maus-Picks UND getippte Koordinaten (0,0 · r3,0 · 5<45) —
// derselbe Eingabepfad wie Polylinie/Wand. Die fertige Decke rendert über die
// bestehende Decken-Darstellung (generatePlan / 3D); der Draft zeigt den Umriss.
//
// Herkunft der Decken-Felder (CommandContext):
//   • wallTypeId  ← ctx.activeWallTypeId (Fallback: erster Projekt-Wandtyp) — der
//     Schichtaufbau (Bauteil/Schraffur/Material) wird identisch zur Wand aufgelöst.
//   • floorId     ← ctx.level.id (aktives Geschoss)
//   • categoryCode← "30" (Ebene „Decken"; Fallback ctx.defaultCategoryCode)

import type { Ceiling } from "../../model/types";
import { normalizeOutline, ceilingArea } from "../../core";
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

const EPS = 1e-6;
const DEG = Math.PI / 180;
const CLOSE_HIT = 0.08; // Modell-Meter: Klick nahe Startpunkt schließt den Umriss
/** Default-Ebene (Kategorie) für Decken. */
const CEILING_CATEGORY = "30";

const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Tab-Felder je weiteren Punkt: Länge + Winkel relativ zum letzten Punkt. */
const CEIL_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

/** Nächster Punkt aus gelockten Feldern (length/angle) + Cursor, relativ zu `last`. */
function nextFromFields(
  last: Vec2,
  locks: Record<string, number>,
  cursor: Vec2 | null,
): Vec2 {
  const ref = cursor ?? last;
  const length = "length" in locks ? locks.length : segLen(last, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(last, ref);
  const ang = angleDeg * DEG;
  return { x: last.x + Math.cos(ang) * length, y: last.y + Math.sin(ang) * length };
}

/** Aktiver Aufbau-Typ-ID; Fallback auf den ersten Projekt-Wandtyp. */
function activeTypeId(ctx: CommandContext): string {
  const wt =
    ctx.project.wallTypes.find((t) => t.id === ctx.activeWallTypeId) ??
    ctx.project.wallTypes[0];
  return wt ? wt.id : ctx.activeWallTypeId;
}

/** Existiert die Decken-Kategorie („30")? Sonst Fallback auf die aktive Kategorie. */
function ceilingCategory(ctx: CommandContext): string {
  const flat: { code: string }[] = [];
  const walk = (list: { code: string; children?: unknown[] }[]) => {
    for (const c of list) {
      flat.push({ code: c.code });
      if (c.children) walk(c.children as { code: string; children?: unknown[] }[]);
    }
  };
  walk(ctx.project.layers as { code: string; children?: unknown[] }[]);
  return flat.some((c) => c.code === CEILING_CATEGORY)
    ? CEILING_CATEGORY
    : ctx.defaultCategoryCode;
}

interface CeilIdle extends CommandState {
  phase: "start";
}
interface CeilDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
}
type CeilState = CeilIdle | CeilDrawing;

const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };

/** Vorschau: geschlossener Umriss-Ring (ab 3 Punkten) + Gummiband + HUD. */
function ceilingDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  const showClosed = pts.length >= 3;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: showClosed }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) {
    draft.hud = {
      at: cursor,
      text: `${segLen(last, cursor).toFixed(2)} m · ${Math.abs(
        (segAngleDeg(last, cursor) + 360) % 360,
      ).toFixed(0)}°`,
    };
  }
  return draft;
}

/** Hängt eine Decke ans Projekt (immutabel). Entartete Umrisse werden verworfen. */
function appendCeiling(p: Project, pts: Vec2[], ctx: CommandContext): Project {
  const outline = normalizeOutline(pts);
  if (!outline || ceilingArea(outline) < 1e-4) return p;
  const ceiling: Ceiling = {
    id: uniqueId("C"),
    type: "ceiling",
    floorId: ctx.level.id,
    categoryCode: ceilingCategory(ctx),
    outline,
    wallTypeId: activeTypeId(ctx),
  };
  const ceilings = p.ceilings ? [...p.ceilings, ceiling] : [ceiling];
  return { ...p, ceilings };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as CeilIdle,
  { draft: null, done: true },
];

export const ceilingCommand: Command = {
  name: "ceiling",
  labelKey: "cmd.ceiling.label",
  // Decken leben auf Geschossen — wie die Wand nur dort aktiv.
  floorOnly: true,
  prompt: (s) =>
    (s as CeilState).phase === "next" ? "cmd.ceiling.next" : "cmd.ceiling.start",
  accepts: (s) =>
    (s as CeilState).phase === "next"
      ? ["point", "number", "option"]
      : ["point", "number"],
  options: (s) => {
    const ps = s as CeilState;
    if (ps.phase !== "next") return [];
    return ps.points.length >= 3 ? [CLOSE, UNDO] : [UNDO];
  },
  init: (): CeilIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as CeilState;

    if (input.kind === "option") {
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0)
          return [{ phase: "start", lastPoint: null } as CeilIdle, { draft: null }];
        const ns: CeilDrawing = {
          phase: "next",
          points: pts,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
        };
        return [ns, { draft: ceilingDraft(pts, s.cursor) }];
      }
      // Sofort schließen: committet die Decke (unabhängig, ≥3 Punkte).
      if (input.id === "close" && s.points.length >= 3) {
        const pts = s.points;
        return [
          { phase: "start", lastPoint: null } as CeilIdle,
          { draft: null, done: true, commit: (p) => appendCeiling(p, pts, ctx) },
        ];
      }
      return [s, { draft: ceilingDraft(s.points, s.cursor) }];
    }

    if (input.kind !== "point") {
      return [
        s,
        { draft: s.phase === "next" ? ceilingDraft(s.points, s.cursor) : null },
      ];
    }
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: CeilDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt };
      return [ns, { draft: ceilingDraft([pt], pt) }];
    }
    // Klick nahe Startpunkt → schließen (committet die Decke).
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      const pts = s.points;
      return [
        { phase: "start", lastPoint: null } as CeilIdle,
        { draft: null, done: true, commit: (p) => appendCeiling(p, pts, ctx) },
      ];
    }
    // Null-Strecke (Klick auf denselben Punkt) ignorieren.
    const last = s.points[s.points.length - 1];
    if (segLen(last, pt) < EPS) {
      return [s, { draft: ceilingDraft(s.points, s.cursor) }];
    }
    const points = [...s.points, pt];
    const ns: CeilDrawing = { phase: "next", points, cursor: pt, lastPoint: pt };
    return [ns, { draft: ceilingDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as CeilState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: CeilDrawing = { ...s, cursor: point };
    return [ns, { draft: ceilingDraft(s.points, point) }];
  },

  // Enter/Space/Rechtsklick: Umriss schließen + committen (≥3 Punkte).
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as CeilState;
    if (s.phase === "next" && s.points.length >= 3) {
      const pts = s.points;
      return [
        { phase: "start", lastPoint: null } as CeilIdle,
        { draft: null, done: true, commit: (p) => appendCeiling(p, pts, ctx) },
      ];
    }
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),

  // Tab-Feld-Zyklus nur im „next"-Schritt: Länge + Winkel relativ zum letzten Punkt.
  fields: (state) => ((state as CeilState).phase === "next" ? CEIL_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as CeilState;
    if (s.phase !== "next" || s.points.length === 0) return null;
    return nextFromFields(s.points[s.points.length - 1], locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as CeilState;
    if (s.phase !== "next" || s.points.length === 0 || !cursor) return {};
    const last = s.points[s.points.length - 1];
    return {
      length: segLen(last, cursor),
      angle: ((segAngleDeg(last, cursor) % 360) + 360) % 360,
    };
  },
};
