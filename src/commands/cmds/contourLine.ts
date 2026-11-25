// [332] Höhenlinie — eigene Gelände-Höhenlinien aus gezeichneten Linien (Linie, Polylinie, Spline, Bogen, Kreis,
// Ellipse, Rechteck). Ablauf wie beim Extrudieren:
//   1) Linie anklicken (oder eine vorgewählte nehmen),
//   2) „Höhe:" → Zahl tippen, Enter übernimmt den Vorschlag (letzte Höhe + Äquidistanz).
// Die Linie wird zur Höhenlinie (Kern `contour_draw.rs`, ein Undo-Schritt je Linie) und der Befehl wartet auf die
// nächste Linie; Enter/Esc beim Wählen beendet ihn. Daraus erzeugt „Gelände“ das Geländemodell.

import type { Command, CommandContext, CommandResult, CommandState, Project, Vec2 } from "../types";
import { createMutation, createQuery, xy } from "../createCore";

/** Getroffene Linie (Kern): Id, Linienzug, geschlossen? */
export interface LineHit {
  id: string;
  pts: Vec2[];
  closed: boolean;
}

/** Zuletzt getippte Höhe und Äquidistanz (Abstand der letzten beiden Höhen) über Aufrufe hinweg. */
let lastZ: number | null = null;
let step = 1;

/** Nur für Tests: Vorschlag zurücksetzen. */
export function resetContourLineDefaults(): void {
  lastZ = null;
  step = 1;
}

const query = (project: Project, req: { q: string } & Record<string, unknown>): LineHit | null =>
  createQuery<{ hit: LineHit | null }>(project, req).hit ?? null;

/** Höchste vorhandene Höhenlinie (alle Sätze der Kontext-Schicht), sonst null. */
function topContour(project: Project): number | null {
  let top: number | null = null;
  for (const o of project.context ?? []) {
    if (o.type !== "contourSet") continue;
    for (const c of o.contours) if (Number.isFinite(c.z) && (top === null || c.z > top)) top = c.z;
  }
  return top;
}

/** Vorschlag für die nächste Höhe: letzte + Äquidistanz, sonst über der höchsten vorhandenen, sonst 0. */
export function suggestedZ(project: Project): number {
  if (lastZ !== null) return lastZ + step;
  const top = topContour(project);
  return top === null ? 0 : top + step;
}

interface ClPick extends CommandState {
  phase: "pick";
}
interface ClHeight extends CommandState {
  phase: "height";
  hit: LineHit;
}
type ClState = ClPick | ClHeight;

const PICK: ClPick = { phase: "pick", lastPoint: null };

/** Genau eine vorgewählte Linie (sonst null). */
function preselected(ctx: CommandContext): LineHit | null {
  const ids = ctx.selection.drawingIds ?? (ctx.selection.drawingId ? [ctx.selection.drawingId] : []);
  if (ids.length !== 1 || ctx.selection.wallIds.length > 0) return null;
  return query(ctx.project, { q: "contourLine", id: ids[0] });
}

const draftOf = (hit: LineHit, at: Vec2 | null, project: Project): CommandResult => ({
  draft: {
    preview: [{ kind: "poly", pts: hit.pts, closed: hit.closed }],
    vertices: [],
    ...(at ? { hud: { at, text: `${suggestedZ(project).toFixed(2)} m` } } : {}),
  },
});

/** Höhe übernehmen: Höhenlinie anlegen, Vorschlag nachführen, nächste Linie wählen. */
function commit(hit: LineHit, z: number, ctx: CommandContext): [CommandState, CommandResult] {
  if (lastZ !== null && Math.abs(z - lastZ) > 1e-9) step = z - lastZ;
  lastZ = z;
  return [{ ...PICK }, { draft: null, commit: createMutation(ctx, { cmd: "contourLine", source: hit.id, z }) }];
}

export const contourLineCommand: Command = {
  name: "contourline",
  labelKey: "cmd.contourLine.label",
  prompt: (s) => ((s as ClState).phase === "height" ? "cmd.contourLine.height" : "cmd.contourLine.pick"),
  // Auch beim Wählen eine Zahl: mit vorgewählter Linie gilt sie sofort als deren Höhe.
  accepts: () => ["point", "number"],
  options: () => [],
  floorOnly: true,

  init: (): ClState => ({ ...PICK }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ClState;
    if (s.phase === "pick") {
      // Vorgewählte Linie: getippte Zahl ist gleich ihre Höhe (wie beim Extrudieren).
      if (input.kind === "number" && Number.isFinite(input.value)) {
        const pre = preselected(ctx);
        return pre ? commit(pre, input.value, ctx) : [s, { draft: null }];
      }
      if (input.kind !== "point") return [s, { draft: null }];
      const hit = query(ctx.project, { q: "pickContourLine", level: ctx.level.id, pt: xy(input.point) });
      if (!hit) return [s, { draft: null, notice: { key: "cmd.contourLine.noLine", kind: "warning" } }];
      return [{ phase: "height", hit, lastPoint: null } as ClHeight, draftOf(hit, input.point, ctx.project)];
    }
    if (input.kind === "number" && Number.isFinite(input.value)) return commit(s.hit, input.value, ctx);
    return [s, { draft: null }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ClState;
    if (s.phase === "height") return [s, draftOf(s.hit, point, ctx.project)];
    return [s, { draft: null }];
  },

  // Enter/Rechtsklick: beim Höhen-Schritt den Vorschlag übernehmen; beim Wählen beenden.
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as ClState;
    if (s.phase === "height") return commit(s.hit, suggestedZ(ctx.project), ctx);
    return [{ ...PICK }, { draft: null, done: true, notice: { key: "cmd.contourLine.done", kind: "info" } }];
  },
  onCancel: (): [CommandState, CommandResult] => [{ ...PICK }, { draft: null, done: true }],
};
