// Chamfer — fast die Ecke einer 2D-Kurve (polyline/rect) mit einer geraden
// Abschrägung (Rhino/AutoCAD-artig, Gegenstück zu Fillet ohne Bogen).
// Gleicher Aufbau wie fillet.ts (siehe dort für die ausführlichere
// Begründung), nur mit `chamferCorner` statt `filletCorner`:
//   1) „Ecke wählen:"  → Punkt (nächstgelegener Eckpunkt einer polyline/rect)
//   2) „Distanz:"       → Punkt (Abstand von der Ecke) ODER getippte Zahl → commit
//
// Anders als Fillet braucht Chamfer KEINE Bogen-Tessellierung — die Fasung
// ist von Natur aus gerade, also ein exaktes (nicht approximiertes) Ergebnis.

import { cmdMutation } from "../../core";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import { cornerPreview, pickCorner } from "./cornerHit";
import type { CornerHit } from "./cornerHit";

const DEFAULT_DISTANCE = 0.1; // m — Startwert, bis der Nutzer per Maus/Tab einen eigenen setzt
const EPS = 1e-6;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Entwurf: Vorschau (Kern) + Ecke als Marke + Messwert (✗, wenn die Distanz nicht passt). */
function chamferDraft(hit: CornerHit, preview: DraftShape[], v: number, at: Vec2 | null): ToolDraft {
  const draft: ToolDraft = { preview, vertices: [hit.corner] };
  if (at) draft.hud = { at, text: `D: ${v.toFixed(3)}m${preview.length ? "" : " ✗"}` };
  return draft;
}

// ── Zustand ───────────────────────────────────────────────────────────────────
const DISTANCE_FIELDS: CommandField[] = [{ id: "distance", labelKey: "cmd.field.distance" }];

interface ChamferPick extends CommandState {
  phase: "pick";
}
interface ChamferDistance extends CommandState {
  phase: "distance";
  hit: CornerHit;
  distance: number;
}
interface ChamferDone extends CommandState {
  phase: "done";
}
type ChamferState = ChamferPick | ChamferDistance | ChamferDone;

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ChamferDone,
  { draft: null, done: true },
];

export const chamferCommand: Command = {
  name: "chamfer",
  labelKey: "cmd.chamfer.label",
  prompt: (s) =>
    (s as ChamferState).phase === "distance" ? "cmd.chamfer.distance" : "cmd.chamfer.pick",
  accepts: (s) => ((s as ChamferState).phase === "distance" ? ["point", "number"] : ["point"]),
  options: () => [],
  fields: (s) => ((s as ChamferState).phase === "distance" ? DISTANCE_FIELDS : []),

  init: (): ChamferPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx: CommandContext): [CommandState, CommandResult] => {
    const s = state as ChamferState;
    if (s.phase === "done") return finish();
    if (s.phase === "pick") {
      if (input.kind !== "point") return [s, { draft: null }];
      const { hit, preview } = pickCorner(ctx.project, ctx.level.id, input.point, "chamfer", DEFAULT_DISTANCE);
      if (!hit) return [s, { draft: null }]; // daneben geklickt → aktiv bleiben
      const next: ChamferDistance = {
        phase: "distance",
        hit,
        distance: DEFAULT_DISTANCE,
        lastPoint: input.point,
      };
      return [next, { draft: chamferDraft(hit, preview, next.distance, input.point) }];
    }
    // phase === "distance"
    let d = s.distance;
    if (input.kind === "number") d = Math.max(0, input.value);
    else if (input.kind === "point") d = Math.max(0, dist(s.hit.corner, input.point));
    else return [s, { draft: null }];
    return [
      { phase: "done", lastPoint: null } as ChamferDone,
      { draft: null, done: true, commit: cmdMutation({ cmd: "chamfer", id: s.hit.id, index: s.hit.index, d }) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ChamferState;
    if (s.phase === "pick") {
      const { hit, preview } = pickCorner(ctx.project, ctx.level.id, point, "chamfer", DEFAULT_DISTANCE);
      if (!hit) return [s, { draft: null }];
      return [s, { draft: chamferDraft(hit, preview, DEFAULT_DISTANCE, point) }];
    }
    if (s.phase !== "distance") return [s, { draft: null }];
    const d = Math.max(0, dist(s.hit.corner, point));
    const ns: ChamferDistance = { ...s, distance: d };
    return [ns, { draft: chamferDraft(s.hit, cornerPreview(ctx.project, s.hit, "chamfer", d), d, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),

  // Tab-Feld-Zyklus nur im „distance"-Schritt, analog zu fillet.ts/circle.ts.
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as ChamferState;
    if (s.phase !== "distance" || !cursor) return {};
    return { distance: dist(s.hit.corner, cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as ChamferState;
    if (s.phase !== "distance") return null;
    const corner = s.hit.corner;
    const d = "distance" in locks ? Math.max(0, locks.distance) : cursor ? dist(corner, cursor) : 0;
    if (cursor) {
      const dd = dist(corner, cursor);
      if (dd > EPS) {
        return {
          x: corner.x + ((cursor.x - corner.x) / dd) * d,
          y: corner.y + ((cursor.y - corner.y) / dd) * d,
        };
      }
    }
    return { x: corner.x + d, y: corner.y };
  },
};
