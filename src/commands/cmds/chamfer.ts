// Chamfer — fast die Ecke einer 2D-Kurve (polyline/rect) mit einer geraden
// Abschrägung (Rhino/AutoCAD-artig, Gegenstück zu Fillet ohne Bogen).
// Gleicher Aufbau wie fillet.ts (siehe dort für die ausführlichere
// Begründung), nur mit `chamferCorner` statt `filletCorner`:
//   1) „Ecke wählen:"  → Punkt (nächstgelegener Eckpunkt einer polyline/rect)
//   2) „Distanz:"       → Punkt (Abstand von der Ecke) ODER getippte Zahl → commit
//
// Anders als Fillet braucht Chamfer KEINE Bogen-Tessellierung — die Fasung
// ist von Natur aus gerade, also ein exaktes (nicht approximiertes) Ergebnis.

import type { Drawing2D, Drawing2DGeom } from "../../model/types";
import { opsMutation, patchItem } from "../../core";
import type { CoreOp } from "../../core";
import { hasRealBulge } from "../../core";
import { chamferCorner, type Chamfer } from "../../core";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const HIT_TOL = 0.3; // Modell-Meter: Pick-Toleranz für die Eckenwahl
const DEFAULT_DISTANCE = 0.1; // m — Startwert, bis der Nutzer per Maus/Tab einen eigenen setzt
const EPS = 1e-6;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

interface Curve {
  pts: Vec2[];
  closed: boolean;
}

/** Wandelt eine chamfer-fähige 2D-Form (polyline/rect) in eine Punktliste oder null. */
function geomToCurve(g: Drawing2DGeom): Curve | null {
  // Bogen-Segmente (bulge) hier noch nicht unterstützt, s. fillet.ts/offset.ts.
  if (g.shape === "polyline" && !hasRealBulge(g.bulge)) return { pts: g.pts, closed: g.closed };
  if (g.shape === "rect") {
    return {
      pts: [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }],
      closed: true,
    };
  }
  return null; // line (keine eigene Ecke), circle/arc/text: nicht chamfer-fähig
}

/** Ein Treffer: das Element + der Eckpunkt-Index (mit gültigen beiden Nachbarn). */
interface CornerHit {
  drawing: Drawing2D;
  curve: Curve;
  index: number;
}

/** Nächster Eckpunkt (mit zwei Nachbarn) einer chamfer-fähigen Drawing2D zum Klickpunkt. */
function pickCornerAt(project: Project, levelId: string, pt: Vec2): CornerHit | null {
  let best: CornerHit | null = null;
  let bestD = HIT_TOL;
  for (const d of project.drawings2d) {
    if (d.levelId !== levelId) continue;
    const curve = geomToCurve(d.geom);
    if (!curve) continue;
    const n = curve.pts.length;
    for (let i = 0; i < n; i++) {
      // Offene Polylinie: die beiden Endpunkte haben keinen zweiten Nachbarn.
      if (!curve.closed && (i === 0 || i === n - 1)) continue;
      const dd = dist(pt, curve.pts[i]);
      if (dd < bestD) {
        bestD = dd;
        best = { drawing: d, curve, index: i };
      }
    }
  }
  return best;
}

/** Fasungs-Geometrie für einen Treffer + Distanz (oder null, falls unmöglich). */
function chamferFor(hit: CornerHit, distance: number): Chamfer | null {
  const n = hit.curve.pts.length;
  const prev = hit.curve.pts[(hit.index - 1 + n) % n];
  const next = hit.curve.pts[(hit.index + 1) % n];
  const corner = hit.curve.pts[hit.index];
  return chamferCorner(corner, prev, next, distance);
}

/** Ersetzt den Eckpunkt durch die beiden Fasungs-Punkte (Schenkel↔Schenkel). */
function applyChamferPoints(hit: CornerHit, c: Chamfer): Vec2[] {
  return [
    ...hit.curve.pts.slice(0, hit.index),
    c.a,
    c.b,
    ...hit.curve.pts.slice(hit.index + 1),
  ];
}

function chamferDraft(hit: CornerHit, d: number, at: Vec2 | null): ToolDraft {
  const c = d > EPS ? chamferFor(hit, d) : null;
  const preview: DraftShape[] = c ? [{ kind: "poly", pts: [c.a, c.b], closed: false }] : [];
  const draft: ToolDraft = { preview, vertices: [hit.curve.pts[hit.index]] };
  if (at) draft.hud = { at, text: `D: ${d.toFixed(3)}m${c ? "" : " ✗"}` };
  return draft;
}

function chamferOps(p: Project, hit: CornerHit, distance: number): CoreOp[] {
  const c = chamferFor(hit, distance);
  if (!c) return []; // Distanz zu gross für die Schenkellänge, oder Ecke (fast) gerade → No-op
  const pts = applyChamferPoints(hit, c);
  const geom: Drawing2DGeom = { shape: "polyline", pts, closed: hit.curve.closed };
  return patchItem(p, "drawings2d", hit.drawing.id, { geom });
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
      const hit = pickCornerAt(ctx.project, ctx.level.id, input.point);
      if (!hit) return [s, { draft: null }]; // daneben geklickt → aktiv bleiben
      const next: ChamferDistance = {
        phase: "distance",
        hit,
        distance: DEFAULT_DISTANCE,
        lastPoint: input.point,
      };
      return [next, { draft: chamferDraft(hit, next.distance, input.point) }];
    }
    // phase === "distance"
    let d = s.distance;
    if (input.kind === "number") d = Math.max(0, input.value);
    else if (input.kind === "point") d = Math.max(0, dist(s.hit.curve.pts[s.hit.index], input.point));
    else return [s, { draft: null }];
    return [
      { phase: "done", lastPoint: null } as ChamferDone,
      { draft: null, done: true, commit: opsMutation((p) => chamferOps(p, s.hit, d)) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ChamferState;
    if (s.phase === "pick") {
      const hit = pickCornerAt(ctx.project, ctx.level.id, point);
      if (!hit) return [s, { draft: null }];
      return [s, { draft: chamferDraft(hit, DEFAULT_DISTANCE, point) }];
    }
    if (s.phase !== "distance") return [s, { draft: null }];
    const d = Math.max(0, dist(s.hit.curve.pts[s.hit.index], point));
    const ns: ChamferDistance = { ...s, distance: d };
    return [ns, { draft: chamferDraft(s.hit, d, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),

  // Tab-Feld-Zyklus nur im „distance"-Schritt, analog zu fillet.ts/circle.ts.
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as ChamferState;
    if (s.phase !== "distance" || !cursor) return {};
    return { distance: dist(s.hit.curve.pts[s.hit.index], cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as ChamferState;
    if (s.phase !== "distance") return null;
    const corner = s.hit.curve.pts[s.hit.index];
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
