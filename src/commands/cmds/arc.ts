// Arc — Mittelpunkt + Startpunkt + Endpunkt. Schritte:
//   1) „Mittelpunkt:" → Punkt
//   2) „Startpunkt:"   → Punkt (setzt Radius r = |P1−Center| UND Startwinkel a0)
//   3) „Endpunkt:"     → Punkt (setzt Endwinkel a1; Radius bleibt) → commit
//
// Der Bogen läuft CCW von a0 nach a1 (wie DXF-ARC und das `{shape:"arc"}`-
// Rendering in PlanView). Der Endpunkt wird nur für seinen WINKEL genutzt (auf
// den Kreis mit Radius r projiziert). In generatePlan/PlanView als glatter
// SVG-Bogen (`drawingArc`) gerendert.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const EPS = 1e-6;

interface ArcCenter extends CommandState {
  phase: "center";
}
interface ArcStart extends CommandState {
  phase: "start";
  center: Vec2;
  cursor: Vec2 | null;
}
interface ArcEnd extends CommandState {
  phase: "end";
  center: Vec2;
  r: number;
  a0: number;
  cursor: Vec2 | null;
}
type ArcState = ArcCenter | ArcStart | ArcEnd;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const angle = (c: Vec2, p: Vec2): number => Math.atan2(p.y - c.y, p.x - c.x);

/** CCW-Spanne von a0 nach a1, normiert auf (0, 2π]. */
function sweepOf(a0: number, a1: number): number {
  const TAU = Math.PI * 2;
  const s = ((a1 - a0) % TAU + TAU) % TAU;
  return s < EPS ? TAU : s;
}

/** Punkte eines Bogens (CCW a0→a1) für die Vorschau. */
function arcPts(center: Vec2, r: number, a0: number, a1: number): Vec2[] {
  const sweep = sweepOf(a0, a1);
  const N = Math.max(2, Math.ceil(sweep / (Math.PI / 32)));
  const pts: Vec2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = a0 + (sweep * i) / N;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/** Punkte einer vollen Kreis-Approximation (Radius-Vorschau im „start"-Schritt). */
function circlePts(center: Vec2, r: number): Vec2[] {
  const N = 48;
  const pts: Vec2[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/** Vorschau (offener Bogen) + HUD (Radius als L, Spanne als W — L/W-Kästchen). */
function arcDraft(center: Vec2, r: number, a0: number, a1: number, at: Vec2 | null): ToolDraft {
  if (r < EPS) return { preview: [], vertices: [center] };
  const preview: DraftShape[] = [{ kind: "poly", pts: arcPts(center, r, a0, a1), closed: false }];
  const draft: ToolDraft = { preview, vertices: [center] };
  if (at) {
    const deg = (sweepOf(a0, a1) * 180) / Math.PI;
    draft.hud = { at, length: r, angleDeg: deg };
  }
  return draft;
}

function appendArc(p: Project, center: Vec2, r: number, a0: number, a1: number, ctx: CommandContext): Project {
  if (r < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "arc", center, r, a0, a1 },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "center", lastPoint: null },
  { draft: null, done: true },
];

export const arcCommand: Command = {
  name: "arc",
  labelKey: "cmd.arc.label",
  prompt: (s) => {
    const phase = (s as ArcState).phase;
    return phase === "start" ? "cmd.arc.start" : phase === "end" ? "cmd.arc.end" : "cmd.arc.center";
  },
  accepts: () => ["point"],
  options: () => [],
  init: (): ArcCenter => ({ phase: "center", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ArcState;
    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;
    if (s.phase === "center") {
      const ns: ArcStart = { phase: "start", center: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: { preview: [], vertices: [pt] } }];
    }
    if (s.phase === "start") {
      const r = dist(s.center, pt);
      if (r < EPS) return [s, { draft: null }];
      const a0 = angle(s.center, pt);
      const ns: ArcEnd = { phase: "end", center: s.center, r, a0, cursor: pt, lastPoint: pt };
      return [ns, { draft: arcDraft(s.center, r, a0, a0, pt) }];
    }
    // Endpunkt: Endwinkel setzen, Bogen committen.
    const a1 = angle(s.center, pt);
    const { center, r, a0 } = s;
    return [
      { phase: "center", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendArc(p, center, r, a0, a1, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as ArcState;
    if (s.phase === "start") {
      const r = dist(s.center, point);
      const ns: ArcStart = { ...s, cursor: point };
      return [
        ns,
        {
          draft: {
            preview: [{ kind: "poly", pts: circlePts(s.center, r), closed: true }],
            vertices: [s.center],
            hud: { at: point, text: `R: ${r.toFixed(3)}m` },
          },
        },
      ];
    }
    if (s.phase === "end") {
      const a1 = angle(s.center, point);
      const ns: ArcEnd = { ...s, cursor: point };
      return [ns, { draft: arcDraft(s.center, s.r, s.a0, a1, point) }];
    }
    return [s, { draft: null }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
