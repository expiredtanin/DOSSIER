// [279] Geländer als Engine-Befehl (`gelaender`): Polylinie auf dem aktiven Geschoss (Balkon, Galerie, Treppenauge,
// Terrasse), Ablauf wie die Polylinie/Decke:
//   1) „Erster Punkt des Geländers:" → Punkt
//   2) „Nächster Punkt ( Schliessen Zurück Art ):" → Punkt … Enter beendet (offen, ≥ 2 Punkte), „Schliessen" (C) oder
//      ein Klick auf den Startpunkt schliesst den Zug (≥ 3 Punkte, Treppenauge/Galerie ringsum).
// Eine getippte Zahl setzt die Höhe (Vorgabe 1.00 m, SIA 358); sie bleibt über Aufrufe. Optionen (Klick wechselt): Art
// Stäbe/Glas/Brüstung/Lochblech. Fusshöhe, Handlauf, Stababstand, Dicke danach in der Objekt-Info.
//
// Die Ops baut der Kern (`cmd_create.rs`, Befehl „railing"): Ebene „41" (Geländer), falls vorhanden, sonst die aktive.
//
// Bezeichner englisch, sichtbarer Text via t().

import type { Command, CommandContext, CommandField, CommandResult, CommandState, CmdOption, DraftShape, ToolDraft, Vec2 } from "../types";
import type { RailingKind } from "../../model/types";
import { createMutation, xy } from "../createCore";
import { t, type TranslationKey } from "../../i18n";

const EPS = 1e-6;
const DEG = Math.PI / 180;
/** Klick so nah am Startpunkt (Modell-Meter) schliesst den Zug. */
const CLOSE_HIT = 0.08;

const KINDS: RailingKind[] = ["bars", "glass", "solid", "perforated"];

/** Vorgaben des Werkzeugs (modulweit, leben über Befehls-Instanzen hinweg). */
export const railingDefaults: { kind: RailingKind; height: number } = { kind: "bars", height: 1.0 };

const next = <T>(list: readonly T[], v: T): T => list[(list.indexOf(v) + 1) % list.length];

const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Tab-Felder je weiteren Punkt: Länge + Winkel relativ zum letzten Punkt. */
const FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

/** Nächster Punkt aus gelockten Feldern (length/angle) + Cursor, relativ zu `last`. */
function nextFromFields(last: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? last;
  const length = "length" in locks ? locks.length : segLen(last, ref);
  const ang = ("angle" in locks ? locks.angle : segAngleDeg(last, ref)) * DEG;
  return { x: last.x + Math.cos(ang) * length, y: last.y + Math.sin(ang) * length };
}

/** Anfrage an den Kern (Werkzeug-Vorgaben). */
export const railingReq = (pts: Vec2[], closed: boolean) => ({
  cmd: "railing",
  kind: railingDefaults.kind,
  height: railingDefaults.height,
  closed,
  pts: pts.map(xy),
});

const RAILING_DONE = { key: "cmd.railing.done", kind: "info" } as const;
const appendRailing = (pts: Vec2[], closed: boolean, ctx: CommandContext) => createMutation(ctx, railingReq(pts, closed));

interface RailIdle extends CommandState {
  phase: "start";
}
interface RailDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
}
type RailState = RailIdle | RailDrawing;

const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };

const idle = (): [CommandState, CommandResult] => [{ phase: "start", lastPoint: null } as RailIdle, { draft: null, done: true }];

/** Vorschau: Zug samt Gummiband, bei geschlossenem Zug der Ring; HUD mit Länge, Winkel und Höhe. */
function railingDraft(points: Vec2[], cursor: Vec2 | null, closed = false): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) {
    draft.hud = {
      at: cursor,
      text: `${segLen(last, cursor).toFixed(2)} m · ${((segAngleDeg(last, cursor) + 360) % 360).toFixed(0)}° · h ${railingDefaults.height.toFixed(2)} m`,
    };
  }
  return draft;
}

export const railingCommand: Command = {
  name: "gelaender",
  labelKey: "cmd.gelaender.label",
  // Geländer stehen auf Geschossen — wie die Wand nur dort aktiv.
  floorOnly: true,
  prompt: (s) => ((s as RailState).phase === "next" ? "cmd.gelaender.next" : "cmd.gelaender.start"),
  accepts: (s) => ((s as RailState).phase === "next" ? ["point", "number", "option"] : ["point", "number", "option"]),
  options: (s): CmdOption[] => {
    const ps = s as RailState;
    const kind: CmdOption = { id: "kind", labelKey: "cmd.gelaender.kind", value: t(`objinfo.railing.kind.${railingDefaults.kind}` as TranslationKey) };
    if (ps.phase !== "next") return [kind];
    return ps.points.length >= 3 ? [CLOSE, UNDO, kind] : [UNDO, kind];
  },
  init: (): RailIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RailState;
    const draft = (closed = false) => (s.phase === "next" ? railingDraft(s.points, s.cursor, closed) : null);

    if (input.kind === "number") {
      const v = Math.abs(input.value);
      if (v >= 0.1 && v <= 5 && Number.isFinite(v)) railingDefaults.height = v;
      return [s, { draft: draft() }];
    }

    if (input.kind === "option") {
      if (input.id === "kind") {
        railingDefaults.kind = next(KINDS, railingDefaults.kind);
        return [s, { draft: draft() }];
      }
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0) return [{ phase: "start", lastPoint: null } as RailIdle, { draft: null }];
        const ns: RailDrawing = { phase: "next", points: pts, cursor: s.cursor, lastPoint: pts[pts.length - 1] };
        return [ns, { draft: railingDraft(pts, s.cursor) }];
      }
      // Schliessen: Treppenauge/Galerie ringsum (≥ 3 Punkte).
      if (input.id === "close" && s.points.length >= 3) {
        return [{ phase: "start", lastPoint: null } as RailIdle, { draft: null, done: true, commit: appendRailing(s.points, true, ctx), notice: RAILING_DONE }];
      }
      return [s, { draft: draft() }];
    }

    if (input.kind !== "point") return [s, { draft: draft() }];
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: RailDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt };
      return [ns, { draft: railingDraft([pt], pt) }];
    }
    // Klick nahe Startpunkt → Zug schliessen und committen.
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      return [{ phase: "start", lastPoint: null } as RailIdle, { draft: null, done: true, commit: appendRailing(s.points, true, ctx), notice: RAILING_DONE }];
    }
    // Null-Strecke (Klick auf denselben Punkt) ignorieren.
    if (segLen(s.points[s.points.length - 1], pt) < EPS) return [s, { draft: draft() }];
    const points = [...s.points, pt];
    const ns: RailDrawing = { phase: "next", points, cursor: pt, lastPoint: pt };
    return [ns, { draft: railingDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as RailState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: RailDrawing = { ...s, cursor: point };
    return [ns, { draft: railingDraft(s.points, point) }];
  },

  // Enter/Rechtsklick: offenen Zug committen (≥ 2 Punkte).
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as RailState;
    if (s.phase === "next" && s.points.length >= 2) {
      return [{ phase: "start", lastPoint: null } as RailIdle, { draft: null, done: true, commit: appendRailing(s.points, false, ctx), notice: RAILING_DONE }];
    }
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),

  fields: (state) => ((state as RailState).phase === "next" ? FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as RailState;
    if (s.phase !== "next" || s.points.length === 0) return null;
    return nextFromFields(s.points[s.points.length - 1], locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as RailState;
    if (s.phase !== "next" || s.points.length === 0 || !cursor) return {};
    const last = s.points[s.points.length - 1];
    return { length: segLen(last, cursor), angle: ((segAngleDeg(last, cursor) % 360) + 360) % 360 };
  },
};
