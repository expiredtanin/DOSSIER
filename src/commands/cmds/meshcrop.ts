// Netz zuschneiden ([193]) — frei gezeichnetes Polygon (oder Rechteck aus zwei Ecken); behalten werden die Dreiecke des
// gewählten Geländes/Netzes, deren Schwerpunkt im Polygon liegt (Kern `cmd_context.rs`, Befehl `meshCrop`).
//
// Schritte:
//   1) „Erster Punkt des Zuschnitts:" → Punkt
//   2) „Nächster Punkt …" → Punkt … Abschluss per Klick auf den Startpunkt, Option „Schliessen" oder Enter
//      (≥ 3 Punkte; bei genau 2 Punkten: Rechteck aus den Ecken).
// Meldungen statt stillem Scheitern: ohne gewähltes Netz startet der Befehl nicht; schneidet das Polygon nichts ab
// (oder bliebe nichts übrig), entsteht keine Änderung und es erscheint ein Hinweis.

import type { Command, CommandContext, CommandResult, CommandState, CmdOption, DraftShape, ToolDraft, Vec2 } from "../types";
import { createMutation } from "../createCore";
import { documentFor } from "../../core/document";

const EPS = 1e-6;
const CLOSE_HIT = 0.08; // Modell-Meter: Klick nahe Startpunkt schliesst die Kontur

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

interface CropIdle extends CommandState {
  phase: "start";
}
interface CropDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
}
type CropState = CropIdle | CropDrawing;

const CLOSE: CmdOption = { id: "close", labelKey: "cmd.polyline.close" };
const UNDO: CmdOption = { id: "undo", labelKey: "cmd.polyline.undo" };

/** Das einzeln gewählte Gelände/Netz (id), sonst `null`. */
function targetMesh(ctx: CommandContext): string | null {
  const ids = ctx.selection.contextIds ?? [];
  if (ids.length !== 1) return null;
  const o = (ctx.project.context ?? []).find((c) => c.id === ids[0]);
  return o && (o.type === "terrainMesh" || o.type === "importedMesh") ? o.id : null;
}

/** Vorschau: Kontur (ab 3 Punkten geschlossen) + Gummiband. */
function cropDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const pts = cursor ? [...points, cursor] : points;
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: pts.length >= 3 }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && dist(last, cursor) >= EPS) draft.hud = { at: cursor, text: `${dist(last, cursor).toFixed(2)} m` };
  return draft;
}

/** Polygon als flache Liste; 2 Punkte = Rechteck aus den Ecken. */
function polyOf(points: Vec2[]): number[] {
  if (points.length === 2) {
    const [a, b] = points;
    return [a.x, a.y, b.x, a.y, b.x, b.y, a.x, b.y];
  }
  return points.flatMap((q) => [q.x, q.y]);
}

function finishResult(points: Vec2[], ctx: CommandContext): CommandResult {
  const id = targetMesh(ctx);
  const poly = polyOf(points);
  if (!id || poly.length < 6) return { draft: null, done: true, notice: { key: "cmd.meshcrop.noMesh", kind: "warning" } };
  if (documentFor(ctx.project).cmdOps({ cmd: "meshCrop", id, poly }).length === 0) {
    return { draft: null, done: true, notice: { key: "cmd.meshcrop.nothing", kind: "warning" } };
  }
  return { draft: null, done: true, commit: createMutation(ctx, { cmd: "meshCrop", id, poly }), notice: { key: "cmd.meshcrop.done", kind: "info" } };
}

const idle = (): [CommandState, CommandResult] => [{ phase: "start", lastPoint: null } as CropIdle, { draft: null, done: true }];
const finish = (points: Vec2[], ctx: CommandContext): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as CropIdle,
  finishResult(points, ctx),
];

export const meshCropCommand: Command = {
  name: "meshcrop",
  labelKey: "cmd.meshcrop.label",
  floorOnly: true,
  prompt: (s) => ((s as CropState).phase === "next" ? "cmd.meshcrop.next" : "cmd.meshcrop.start"),
  accepts: (s) => ((s as CropState).phase === "next" ? ["point", "option"] : ["point"]),
  options: (s) => {
    const ps = s as CropState;
    if (ps.phase !== "next") return [];
    return ps.points.length >= 3 ? [CLOSE, UNDO] : [UNDO];
  },
  precondition: (ctx) => (targetMesh(ctx) ? null : "cmd.meshcrop.noMesh"),
  init: (): CropIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as CropState;
    if (input.kind === "option") {
      if (s.phase !== "next") return [s, { draft: null }];
      if (input.id === "undo") {
        const pts = s.points.slice(0, -1);
        if (pts.length === 0) return [{ phase: "start", lastPoint: null } as CropIdle, { draft: null }];
        const ns: CropDrawing = { phase: "next", points: pts, cursor: s.cursor, lastPoint: pts[pts.length - 1] };
        return [ns, { draft: cropDraft(pts, s.cursor) }];
      }
      if (input.id === "close" && s.points.length >= 3) return finish(s.points, ctx);
      return [s, { draft: cropDraft(s.points, s.cursor) }];
    }
    if (input.kind !== "point") return [s, { draft: s.phase === "next" ? cropDraft(s.points, s.cursor) : null }];
    const pt = input.point;
    if (s.phase !== "next") {
      const ns: CropDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt };
      return [ns, { draft: cropDraft([pt], pt) }];
    }
    if (s.points.length >= 3 && dist(s.points[0], pt) < CLOSE_HIT) return finish(s.points, ctx);
    if (dist(s.points[s.points.length - 1], pt) < EPS) return [s, { draft: cropDraft(s.points, s.cursor) }];
    const points = [...s.points, pt];
    const ns: CropDrawing = { phase: "next", points, cursor: pt, lastPoint: pt };
    return [ns, { draft: cropDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as CropState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: CropDrawing = { ...s, cursor: point };
    return [ns, { draft: cropDraft(s.points, point) }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as CropState;
    if (s.phase === "next" && s.points.length >= 2) return finish(s.points, ctx);
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),
};
