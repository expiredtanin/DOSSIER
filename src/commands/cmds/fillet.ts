// Fillet — verrundet die Ecke einer 2D-Kurve (polyline/rect) mit einem Radius
// (Rhino/AutoCAD-artig). Die reine Geometrie (`filletCorner`) existierte
// bereits im Kernel, hatte aber KEINEN Aufrufer — reine Verdrahtungsarbeit,
// kein neues Geometrie-Problem. Schritte:
//   1) „Ecke wählen:" → Punkt (nächstgelegener Eckpunkt einer polyline/rect
//      wird gewählt; ein einzelnes `line`-Element hat keine eigene Ecke)
//   2) „Radius:"       → Punkt (Abstand von der Ecke) ODER getippte Zahl → commit
//
// Die Verrundung wird als ECHTES Bogen-Segment gespeichert (`bulge`, s.
// `geometry/bulge.ts`), nicht mehr tesselliert — editierbar wie jeder andere
// Bulge-Bogen (Griff zieht die Krümmung, Rendering bleibt exakt rund unabhängig
// vom Massstab). Quellkurven, die an der gewählten Ecke bereits ein Bogen-
// Segment tragen, bleiben ausgenommen (`geomToCurve`) — die Tangenten-Setback-
// Rechnung geht von geraden Schenkeln aus. Ein rect wird beim ersten Fillet zu
// einer polyline (kein reines Rechteck mehr).

import type { Drawing2D, Drawing2DGeom } from "../../model/types";
import { bulgeFromSagittaPoint, hasRealBulge } from "../../core";
import { filletCorner, type Fillet } from "../../core";
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
const DEFAULT_RADIUS = 0.1; // m — Startwert, bis der Nutzer per Maus/Tab einen eigenen setzt
const EPS = 1e-6;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

interface Curve {
  pts: Vec2[];
  closed: boolean;
}

/** Wandelt eine fillet-fähige 2D-Form (polyline/rect) in eine Punktliste oder null. */
function geomToCurve(g: Drawing2DGeom): Curve | null {
  // Bogen-Segmente (bulge) hier noch nicht unterstützt — der Fillet-Commit
  // baut die Polylinie komplett neu aus reinen Punkten auf und würde ein
  // bestehendes bulge-Array an anderen Segmenten sonst stillschweigend
  // verlieren, s. offset.ts.
  if (g.shape === "polyline" && !hasRealBulge(g.bulge)) return { pts: g.pts, closed: g.closed };
  if (g.shape === "rect") {
    return {
      pts: [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }],
      closed: true,
    };
  }
  return null; // line (keine eigene Ecke), circle/arc/text/Bogen-Polylinie: nicht fillet-fähig
}

/** Ein Treffer: das Element + der Eckpunkt-Index (mit gültigen beiden Nachbarn). */
interface CornerHit {
  drawing: Drawing2D;
  curve: Curve;
  index: number;
}

/** Nächster Eckpunkt (mit zwei Nachbarn) einer fillet-fähigen Drawing2D zum Klickpunkt. */
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

/** Verrundungs-Geometrie für einen Treffer + Radius (oder null, falls unmöglich). */
function filletFor(hit: CornerHit, r: number): Fillet | null {
  const n = hit.curve.pts.length;
  const prev = hit.curve.pts[(hit.index - 1 + n) % n];
  const next = hit.curve.pts[(hit.index + 1) % n];
  const corner = hit.curve.pts[hit.index];
  return filletCorner(corner, prev, next, r);
}

/** Bogen (center/radius/start-/endAngle) als kurze Punktfolge tesselliert (kürzester Bogen). */
function tessellateFillet(f: Fillet, segments = 12): Vec2[] {
  const TAU = Math.PI * 2;
  let delta = f.endAngle - f.startAngle;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = f.startAngle + (delta * i) / segments;
    pts.push({ x: f.center.x + f.radius * Math.cos(a), y: f.center.y + f.radius * Math.sin(a) });
  }
  return pts;
}

/** Ersetzt den Eckpunkt durch die beiden Tangentenpunkte (Tangente↔Tangente). */
function applyFilletPoints(hit: CornerHit, f: Fillet): Vec2[] {
  return [
    ...hit.curve.pts.slice(0, hit.index),
    f.tangentA,
    f.tangentB,
    ...hit.curve.pts.slice(hit.index + 1),
  ];
}

/** Bulge-Wert des Verrundungs-Bogens (tangentA→tangentB), aus einem echten Bogenpunkt hergeleitet. */
function filletBulge(f: Fillet): number {
  const TAU = Math.PI * 2;
  let delta = f.endAngle - f.startAngle;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  const mid = f.startAngle + delta / 2;
  const apex: Vec2 = { x: f.center.x + f.radius * Math.cos(mid), y: f.center.y + f.radius * Math.sin(mid) };
  return bulgeFromSagittaPoint(f.tangentA, f.tangentB, apex);
}

function filletDraft(hit: CornerHit, r: number, at: Vec2 | null): ToolDraft {
  const f = r > EPS ? filletFor(hit, r) : null;
  const preview: DraftShape[] = f
    ? [{ kind: "poly", pts: tessellateFillet(f), closed: false }]
    : [];
  const draft: ToolDraft = { preview, vertices: [hit.curve.pts[hit.index]] };
  if (at) draft.hud = { at, text: `R: ${r.toFixed(3)}m${f ? "" : " ✗"}` };
  return draft;
}

function commitFillet(p: Project, hit: CornerHit, r: number): Project {
  const f = filletFor(hit, r);
  if (!f) return p; // Radius zu gross für die Schenkellänge, oder Ecke (fast) gerade → No-op
  const pts = applyFilletPoints(hit, f);
  const edgeCount = hit.curve.closed ? pts.length : pts.length - 1;
  const bulge = new Array(edgeCount).fill(0);
  bulge[hit.index] = filletBulge(f); // Kante tangentA→tangentB (an Position hit.index)
  const geom: Drawing2DGeom = { shape: "polyline", pts, closed: hit.curve.closed, bulge };
  return {
    ...p,
    drawings2d: p.drawings2d.map((d) => (d.id === hit.drawing.id ? { ...d, geom } : d)),
  };
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
type FilletState = FilletPick | FilletRadius | FilletDone;

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as FilletDone,
  { draft: null, done: true },
];

export const filletCommand: Command = {
  name: "fillet",
  labelKey: "cmd.fillet.label",
  prompt: (s) => ((s as FilletState).phase === "radius" ? "cmd.fillet.radius" : "cmd.fillet.pick"),
  accepts: (s) => ((s as FilletState).phase === "radius" ? ["point", "number"] : ["point"]),
  options: () => [],
  fields: (s) => ((s as FilletState).phase === "radius" ? RADIUS_FIELDS : []),

  init: (): FilletPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx: CommandContext): [CommandState, CommandResult] => {
    const s = state as FilletState;
    if (s.phase === "done") return finish();
    if (s.phase === "pick") {
      if (input.kind !== "point") return [s, { draft: null }];
      const hit = pickCornerAt(ctx.project, ctx.level.id, input.point);
      if (!hit) return [s, { draft: null }]; // daneben geklickt → aktiv bleiben
      const next: FilletRadius = { phase: "radius", hit, radius: DEFAULT_RADIUS, lastPoint: input.point };
      return [next, { draft: filletDraft(hit, next.radius, input.point) }];
    }
    // phase === "radius"
    let r = s.radius;
    if (input.kind === "number") r = Math.max(0, input.value);
    else if (input.kind === "point") r = Math.max(0, dist(s.hit.curve.pts[s.hit.index], input.point));
    else return [s, { draft: null }];
    return [
      { phase: "done", lastPoint: null } as FilletDone,
      { draft: null, done: true, commit: (p) => commitFillet(p, s.hit, r) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as FilletState;
    if (s.phase === "pick") {
      const hit = pickCornerAt(ctx.project, ctx.level.id, point);
      if (!hit) return [s, { draft: null }];
      return [s, { draft: filletDraft(hit, DEFAULT_RADIUS, point) }];
    }
    if (s.phase !== "radius") return [s, { draft: null }];
    const r = Math.max(0, dist(s.hit.curve.pts[s.hit.index], point));
    const ns: FilletRadius = { ...s, radius: r };
    return [ns, { draft: filletDraft(s.hit, r, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),

  // Tab-Feld-Zyklus nur im „radius"-Schritt (ein Radius-Feld), analog zu
  // circle.ts: der gelockte Wert bestimmt den Punkt auf der Winkelhalbierenden
  // Richtung Cursor (bzw. +X ohne Cursor), dist(Ecke, Punkt) = radius.
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as FilletState;
    if (s.phase !== "radius" || !cursor) return {};
    return { radius: dist(s.hit.curve.pts[s.hit.index], cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as FilletState;
    if (s.phase !== "radius") return null;
    const corner = s.hit.curve.pts[s.hit.index];
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
