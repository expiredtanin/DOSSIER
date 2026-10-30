// Fillet — verrundet die Ecke einer 2D-Kurve (polyline/rect) mit einem Radius
// (Rhino/AutoCAD-artig). Die reine Geometrie (`filletCorner`) existierte
// bereits im Kernel, hatte aber KEINEN Aufrufer — reine Verdrahtungsarbeit,
// kein neues Geometrie-Problem. Schritte:
//   1) „Ecke wählen:" → Punkt (nächstgelegener Eckpunkt einer polyline/rect
//      wird gewählt; ein einzelnes `line`-Element hat keine eigene Ecke)
//   2) „Radius:"       → Punkt (Abstand von der Ecke) ODER getippte Zahl → commit
//   Wände ([113]): trifft der erste Klick keine Ecke, aber eine Wand, folgt „Zweite Wand“ (Zahl =
//   Radius, Vorgabe 0 = L-Ecke am Achsschnittpunkt; Radius nur bei geraden Wänden → Bogenwand).
//
// Die Verrundung wird als ECHTES Bogen-Segment gespeichert (`bulge`, s.
// `geometry/bulge.ts`), nicht mehr tesselliert — editierbar wie jeder andere
// Bulge-Bogen (Griff zieht die Krümmung, Rendering bleibt exakt rund unabhängig
// vom Massstab). Quellkurven, die an der gewählten Ecke bereits ein Bogen-
// Segment tragen, bleiben ausgenommen (`geomToCurve`) — die Tangenten-Setback-
// Rechnung geht von geraden Schenkeln aus. Ein rect wird beim ersten Fillet zu
// einer polyline (kein reines Rechteck mehr).

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
import { cmdQuery, decodeShapes, pair } from "../../tools/coreCmd";
import type { CornerHit } from "./cornerHit";

const DEFAULT_RADIUS = 0.1; // m — Startwert, bis der Nutzer per Maus/Tab einen eigenen setzt
const EPS = 1e-6;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Entwurf: Vorschau (Kern) + Ecke als Marke + Messwert (✗, wenn der Radius nicht passt). */
function filletDraft(hit: CornerHit, preview: DraftShape[], v: number, at: Vec2 | null): ToolDraft {
  const draft: ToolDraft = { preview, vertices: [hit.corner] };
  if (at) draft.hud = { at, text: `R: ${v.toFixed(3)}m${preview.length ? "" : " ✗"}` };
  return draft;
}

// ── Zustand ───────────────────────────────────────────────────────────────────
const RADIUS_FIELDS: CommandField[] = [{ id: "radius", labelKey: "cmd.field.radius" }];

interface FilletPick extends CommandState {
  phase: "pick";
}
interface FilletRadius extends CommandState {
  phase: "radius";
  hit: CornerHit;
  radius: number;
}
interface FilletDone extends CommandState {
  phase: "done";
}
/**
 * Wände ([113]): erste Wand getroffen (statt einer Polylinien-Ecke), jetzt die zweite wählen. Beide
 * werden bis zum Achsschnittpunkt gestutzt/verlängert (L-Ecke); mit Radius > 0 (nur gerade Wände)
 * schliesst eine Bogenwand tangential an.
 */
interface FilletWall2 extends CommandState {
  phase: "wall2";
  wall: string;
  p1: Vec2;
}
type FilletState = FilletPick | FilletRadius | FilletDone | FilletWall2;

/** Radius der Wand-Verrundung (0 = scharfe L-Ecke), bleibt über Aufrufe. */
let wallRadius = 0;

function wallDraft(ctx: CommandContext, s: FilletWall2, point: Vec2): ToolDraft | null {
  const r = cmdQuery<{ hit: boolean; shapes: number[] }>(ctx.project, { q: "filletWalls", level: ctx.level.id, id: s.wall, p1: pair(s.p1), pt: pair(point), r: wallRadius });
  return { preview: decodeShapes(r.shapes), vertices: [s.p1], hud: { at: point, text: `R: ${wallRadius.toFixed(3)}m${r.hit ? "" : " ✗"}` } };
}

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as FilletDone,
  { draft: null, done: true },
];

export const filletCommand: Command = {
  name: "fillet",
  labelKey: "cmd.fillet.label",
  prompt: (s) => {
    const ph = (s as FilletState).phase;
    return ph === "radius" ? "cmd.fillet.radius" : ph === "wall2" ? "cmd.fillet.wall2" : "cmd.fillet.pick";
  },
  accepts: (s) => ((s as FilletState).phase === "radius" || (s as FilletState).phase === "wall2" ? ["point", "number"] : ["point"]),
  options: () => [],
  fields: (s) => ((s as FilletState).phase === "radius" ? RADIUS_FIELDS : []),

  init: (): FilletPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx: CommandContext): [CommandState, CommandResult] => {
    const s = state as FilletState;
    if (s.phase === "done") return finish();
    if (s.phase === "pick") {
      if (input.kind !== "point") return [s, { draft: null }];
      const { hit, preview } = pickCorner(ctx.project, ctx.level.id, input.point, "fillet", DEFAULT_RADIUS);
      if (!hit) {
        const wall = cmdQuery<{ hit: string | null }>(ctx.project, { q: "pickWall", level: ctx.level.id, pt: pair(input.point) }).hit;
        if (!wall) return [s, { draft: null }]; // daneben geklickt → aktiv bleiben
        const w2: FilletWall2 = { phase: "wall2", wall, p1: input.point, lastPoint: input.point };
        return [w2, { draft: { preview: [], vertices: [input.point] } }];
      }
      const next: FilletRadius = { phase: "radius", hit, radius: DEFAULT_RADIUS, lastPoint: input.point };
      return [next, { draft: filletDraft(hit, preview, next.radius, input.point) }];
    }
    if (s.phase === "wall2") {
      if (input.kind === "number") {
        wallRadius = Math.max(0, input.value);
        return [s, { draft: null }];
      }
      if (input.kind !== "point") return [s, { draft: null }];
      const id2 = cmdQuery<{ hit: string | null }>(ctx.project, { q: "pickWall", level: ctx.level.id, pt: pair(input.point) }).hit;
      if (!id2 || id2 === s.wall) return [s, { draft: null }];
      return [
        { phase: "done", lastPoint: null } as FilletDone,
        { draft: null, done: true, commit: cmdMutation({ cmd: "filletWalls", id: s.wall, p1: pair(s.p1), id2, p2: pair(input.point), r: wallRadius }) },
      ];
    }
    // phase === "radius"
    let r = s.radius;
    if (input.kind === "number") r = Math.max(0, input.value);
    else if (input.kind === "point") r = Math.max(0, dist(s.hit.corner, input.point));
    else return [s, { draft: null }];
    return [
      { phase: "done", lastPoint: null } as FilletDone,
      { draft: null, done: true, commit: cmdMutation({ cmd: "fillet", id: s.hit.id, index: s.hit.index, r }) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as FilletState;
    if (s.phase === "pick") {
      const { hit, preview } = pickCorner(ctx.project, ctx.level.id, point, "fillet", DEFAULT_RADIUS);
      if (!hit) return [s, { draft: null }];
      return [s, { draft: filletDraft(hit, preview, DEFAULT_RADIUS, point) }];
    }
    if (s.phase === "wall2") return [s, { draft: wallDraft(ctx, s, point) }];
    if (s.phase !== "radius") return [s, { draft: null }];
    const r = Math.max(0, dist(s.hit.corner, point));
    const ns: FilletRadius = { ...s, radius: r };
    return [ns, { draft: filletDraft(s.hit, cornerPreview(ctx.project, s.hit, "fillet", r), r, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),

  // Tab-Feld-Zyklus nur im „radius"-Schritt (ein Radius-Feld), analog zu
  // circle.ts: der gelockte Wert bestimmt den Punkt auf der Winkelhalbierenden
  // Richtung Cursor (bzw. +X ohne Cursor), dist(Ecke, Punkt) = radius.
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as FilletState;
    if (s.phase !== "radius" || !cursor) return {};
    return { radius: dist(s.hit.corner, cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as FilletState;
    if (s.phase !== "radius") return null;
    const corner = s.hit.corner;
    const r = "radius" in locks ? Math.max(0, locks.radius) : cursor ? dist(corner, cursor) : 0;
    if (cursor) {
      const d = dist(corner, cursor);
      if (d > EPS) {
        return {
          x: corner.x + ((cursor.x - corner.x) / d) * r,
          y: corner.y + ((cursor.y - corner.y) / d) * r,
        };
      }
    }
    return { x: corner.x + r, y: corner.y };
  },
};
