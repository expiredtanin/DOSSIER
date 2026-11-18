// Ceiling — Decke als echter Engine-Befehl (analog polyline: ein GESCHLOSSENER
// Umriss), committet aber ein einzelnes `Ceiling`-Bauteil statt einer 2D-Form.
// Schritte:
//   1) „Erster Umrisspunkt der Decke:" → Punkt
//   2) „Nächster Punkt ( Schliessen Zurück ):" → Punkt … Der Umriss schließt per
//      Klick auf den Startpunkt, Option „Schliessen" (C) oder Enter (≥3 Punkte).
//   3) nur bei Lage „Frei": „Oberkante in m über Geschossboden <0>:" → Zahl, Enter = 0.
//
// Option „Lage" ([285], sticky über den Befehl): „Oben" = Oberkante am Geschoss (Geschossdecke, wie bisher) ·
// „Unter" = Bodenplatte, Oberkante auf dem Geschossboden (UK = OK − Dicke, also unter dem Geschoss) ·
// „Frei" = Oberkante getippt (z. B. −0.02 für eine abgesenkte Balkonplatte). Vorher ging das nur über OK/UK
// „Eigene" in der Objekt-Info (6 Schritte).
//
// Akzeptiert je Punkt Maus-Picks UND getippte Koordinaten (0,0 · r3,0 · 5<45) —
// derselbe Eingabepfad wie Polylinie/Wand. Die fertige Decke rendert über die
// bestehende Decken-Darstellung (generatePlan / 3D); der Draft zeigt den Umriss.
//
// Herkunft der Decken-Felder (CommandContext):
//   • ceilingTypeId ← erster Deckentyp des Projekts (`ceilingTypes`, [206]); ohne Deckentypen gilt
//     das Pflichtfeld wallTypeId ← ctx.activeWallTypeId (Fallback: erster Projekt-Wandtyp).
//   • floorId     ← ctx.level.id (aktives Geschoss)
//   • categoryCode← "30" (Ebene „Decken"; Fallback ctx.defaultCategoryCode)

import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import { createMutation, xy } from "../createCore";
import { t } from "../../i18n";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const CLOSE_HIT = 0.08; // Modell-Meter: Klick nahe Startpunkt schließt den Umriss

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

/** Lage der Decke ([285]): am Geschoss oben, unter dem Geschoss (Bodenplatte) oder frei (OK getippt). */
export type CeilPos = "top" | "below" | "free";
const POS_NEXT: Record<CeilPos, CeilPos> = { top: "below", below: "free", free: "top" };

interface CeilIdle extends CommandState {
  phase: "start";
  pos: CeilPos;
}
interface CeilDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
  pos: CeilPos;
}
/** Lage „Frei": Umriss steht, die Oberkante fehlt noch. */
interface CeilZ extends CommandState {
  phase: "z";
  points: Vec2[];
  pos: CeilPos;
}
type CeilState = CeilIdle | CeilDrawing | CeilZ;

const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };
const posOption = (pos: CeilPos): CmdOption => ({ id: "pos", labelKey: "cmd.ceiling.pos", value: t(`cmd.ceiling.pos.${pos}`), key: "L" });

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

/**
 * Commit: Decke aus dem Umriss (normalisiert, CCW; entartet → nichts), Typ = aktiver Aufbau, Ebene
 * „30“ falls vorhanden — im Kern (`cmd_create.rs`).
 */
const appendCeiling = (pts: Vec2[], ctx: CommandContext, top: number | null = null) =>
  createMutation(ctx, { cmd: "ceiling", pts: pts.map(xy), top });

const idleOf = (pos: CeilPos): CeilIdle => ({ phase: "start", lastPoint: null, pos });
const idle = (pos: CeilPos = "top"): [CommandState, CommandResult] => [idleOf(pos), { draft: null, done: true }];

/** Umriss steht: „Frei" fragt nach der Oberkante, sonst gleich anlegen („Unter" = OK auf dem Geschossboden). */
function finish(s: CeilDrawing, ctx: CommandContext): [CommandState, CommandResult] {
  if (s.pos === "free") {
    const ns: CeilZ = { phase: "z", points: s.points, pos: s.pos, lastPoint: null };
    return [ns, { draft: ceilingDraft(s.points, null) }];
  }
  return [idleOf(s.pos), { draft: null, done: true, commit: appendCeiling(s.points, ctx, s.pos === "below" ? 0 : null) }];
}

export const ceilingCommand: Command = {
  name: "ceiling",
  labelKey: "cmd.ceiling.label",
  // Decken leben auf Geschossen — wie die Wand nur dort aktiv.
  floorOnly: true,
  prompt: (s) => {
    const ph = (s as CeilState).phase;
    return ph === "z" ? "cmd.ceiling.z" : ph === "next" ? "cmd.ceiling.next" : "cmd.ceiling.start";
  },
  accepts: (s) => {
    const ph = (s as CeilState).phase;
    return ph === "z" ? ["number", "option"] : ph === "next" ? ["point", "number", "option"] : ["point", "number", "option"];
  },
  options: (s) => {
    const ps = s as CeilState;
    const pos = posOption(ps.pos);
    if (ps.phase === "z") return [pos];
    if (ps.phase !== "next") return [pos];
    return ps.points.length >= 3 ? [CLOSE, UNDO, pos] : [UNDO, pos];
  },
  init: (): CeilIdle => idleOf("top"),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as CeilState;

    // Lage umschalten (jederzeit); steht der Umriss schon und fehlt nur die Oberkante, entscheidet die neue Lage.
    if (input.kind === "option" && input.id === "pos") {
      const pos = POS_NEXT[s.pos];
      if (s.phase === "z") {
        if (pos === "free") return [{ ...s, pos } as CeilZ, { draft: ceilingDraft(s.points, null) }];
        return [idleOf(pos), { draft: null, done: true, commit: appendCeiling(s.points, ctx, pos === "below" ? 0 : null) }];
      }
      const ns = { ...s, pos } as CeilState;
      return [ns, { draft: ns.phase === "next" ? ceilingDraft(ns.points, ns.cursor) : null }];
    }

    // Oberkante getippt (Lage „Frei"), m über dem Geschossboden; Unsinn bleibt im Schritt.
    if (s.phase === "z") {
      if (input.kind === "number" && Number.isFinite(input.value)) {
        return [idleOf(s.pos), { draft: null, done: true, commit: appendCeiling(s.points, ctx, input.value) }];
      }
      return [s, { draft: ceilingDraft(s.points, null) }];
    }

    if (input.kind === "option") {
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0) return [idleOf(s.pos), { draft: null }];
        const ns: CeilDrawing = {
          phase: "next",
          points: pts,
          cursor: s.cursor,
          lastPoint: pts[pts.length - 1],
          pos: s.pos,
        };
        return [ns, { draft: ceilingDraft(pts, s.cursor) }];
      }
      // Sofort schließen (≥3 Punkte).
      if (input.id === "close" && s.points.length >= 3) return finish(s, ctx);
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
      const ns: CeilDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt, pos: s.pos };
      return [ns, { draft: ceilingDraft([pt], pt) }];
    }
    // Klick nahe Startpunkt → schließen (committet die Decke).
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) return finish(s, ctx);
    // Null-Strecke (Klick auf denselben Punkt) ignorieren.
    const last = s.points[s.points.length - 1];
    if (segLen(last, pt) < EPS) {
      return [s, { draft: ceilingDraft(s.points, s.cursor) }];
    }
    const points = [...s.points, pt];
    const ns: CeilDrawing = { phase: "next", points, cursor: pt, lastPoint: pt, pos: s.pos };
    return [ns, { draft: ceilingDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as CeilState;
    if (s.phase !== "next") return [s, { draft: s.phase === "z" ? ceilingDraft(s.points, null) : null }];
    const ns: CeilDrawing = { ...s, cursor: point };
    return [ns, { draft: ceilingDraft(s.points, point) }];
  },

  // Enter/Space/Rechtsklick: Umriss schließen + committen (≥3 Punkte).
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as CeilState;
    if (s.phase === "next" && s.points.length >= 3) return finish(s, ctx);
    // Lage „Frei": Enter = Oberkante 0 (Geschossboden).
    if (s.phase === "z") return [idleOf(s.pos), { draft: null, done: true, commit: appendCeiling(s.points, ctx, 0) }];
    return idle(s.pos);
  },
  onCancel: (state): [CommandState, CommandResult] => idle((state as CeilState).pos),

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
