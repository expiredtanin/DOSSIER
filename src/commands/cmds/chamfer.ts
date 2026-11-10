// Chamfer — fast die Ecke einer 2D-Kurve (polyline/rect) mit einer geraden
// Abschrägung (Rhino/AutoCAD-artig, Gegenstück zu Fillet ohne Bogen).
// Gleicher Aufbau wie fillet.ts (siehe dort für die ausführlichere
// Begründung), nur mit `chamferCorner` statt `filletCorner`:
//   1) „Ecke wählen:"  → Punkt (nächstgelegener Eckpunkt einer polyline/rect)
//   2) „Distanz:"       → Punkt (Abstand von der Ecke) ODER getippte Zahl → commit
//
// Anders als Fillet braucht Chamfer KEINE Bogen-Tessellierung — die Fasung
// ist von Natur aus gerade, also ein exaktes (nicht approximiertes) Ergebnis.
//   Wände ([113]): trifft der erste Klick keine Ecke, aber eine Wand, folgt „Zweite Wand" (Zahl =
//   Distanz, Vorgabe 0 = L-Ecke am Achsschnittpunkt): beide Wände enden im Abstand vor dem Schnittpunkt
//   (bei Bogenwänden als Bogenlänge), eine gerade Wand (Kopie der ersten) verbindet die Enden. Rechnung
//   im Kern (`cmd_wall_edit.rs`, `chamfer`).

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
import { cmdQuery, decodeShapes, pair } from "../../tools/coreCmd";

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
/** Wände: erste Wand getroffen (statt einer Polylinien-Ecke), jetzt die zweite wählen. */
interface ChamferWall2 extends CommandState {
  phase: "wall2";
  wall: string;
  p1: Vec2;
}
type ChamferState = ChamferPick | ChamferDistance | ChamferDone | ChamferWall2;

/** Fasen-Distanz an Wänden (0 = scharfe L-Ecke), bleibt über Aufrufe. */
let wallDistance = 0;

function wallDraft(ctx: CommandContext, s: ChamferWall2, point: Vec2): ToolDraft {
  const r = cmdQuery<{ hit: boolean; shapes: number[] }>(ctx.project, { q: "chamferWalls", level: ctx.level.id, id: s.wall, p1: pair(s.p1), pt: pair(point), d: wallDistance });
  return { preview: decodeShapes(r.shapes), vertices: [s.p1], hud: { at: point, text: `D: ${wallDistance.toFixed(3)}m${r.hit ? "" : " ✗"}` } };
}

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ChamferDone,
  { draft: null, done: true },
];

export const chamferCommand: Command = {
  name: "chamfer",
  labelKey: "cmd.chamfer.label",
  prompt: (s) => {
    const ph = (s as ChamferState).phase;
    return ph === "distance" ? "cmd.chamfer.distance" : ph === "wall2" ? "cmd.chamfer.wall2" : "cmd.chamfer.pick";
  },
  accepts: (s) => ((s as ChamferState).phase === "distance" || (s as ChamferState).phase === "wall2" ? ["point", "number"] : ["point"]),
  options: () => [],
  fields: (s) => ((s as ChamferState).phase === "distance" ? DISTANCE_FIELDS : []),

  init: (): ChamferPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx: CommandContext): [CommandState, CommandResult] => {
    const s = state as ChamferState;
    if (s.phase === "done") return finish();
    if (s.phase === "pick") {
      if (input.kind !== "point") return [s, { draft: null }];
      const { hit, preview } = pickCorner(ctx.project, ctx.level.id, input.point, "chamfer", DEFAULT_DISTANCE);
      if (!hit) {
        const wall = cmdQuery<{ hit: string | null }>(ctx.project, { q: "pickWall", level: ctx.level.id, pt: pair(input.point) }).hit;
        if (!wall) return [s, { draft: null }]; // daneben geklickt → aktiv bleiben
        const w2: ChamferWall2 = { phase: "wall2", wall, p1: input.point, lastPoint: null };
        return [w2, { draft: { preview: [], vertices: [input.point] } }];
      }
      const next: ChamferDistance = {
        phase: "distance",
        hit,
        distance: DEFAULT_DISTANCE,
        lastPoint: input.point,
      };
      return [next, { draft: chamferDraft(hit, preview, next.distance, input.point) }];
    }
    if (s.phase === "wall2") {
      if (input.kind === "number") {
        wallDistance = Math.max(0, input.value);
        return [s, { draft: null }];
      }
      if (input.kind !== "point") return [s, { draft: null }];
      const id2 = cmdQuery<{ hit: string | null }>(ctx.project, { q: "pickWall", level: ctx.level.id, pt: pair(input.point) }).hit;
      if (!id2 || id2 === s.wall) return [s, { draft: null }];
      return [
        { phase: "done", lastPoint: null } as ChamferDone,
        { draft: null, done: true, commit: cmdMutation({ cmd: "chamferWalls", id: s.wall, p1: pair(s.p1), id2, p2: pair(input.point), d: wallDistance }) },
      ];
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
    if (s.phase === "wall2") return [s, { draft: wallDraft(ctx, s, point) }];
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
