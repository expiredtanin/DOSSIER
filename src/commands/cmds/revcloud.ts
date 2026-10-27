// Revisionswolke (Nutzer-Wunsch: „Keine Revisionswolken/Markup-Werkzeuge").
// Schritte (wie `polyline.ts`, aber ohne dessen Bogen-/Tangenten-Unteroptionen
// — JEDES Segment wird automatisch zu Beulen, s. `geometry/revisionCloud.ts`):
//   1) „Startpunkt:" → Punkt
//   2) „Nächster Punkt ( Schliessen ):" → Punkt … Enter beendet OFFEN (≥2
//      Punkte); Klick nahe dem Startpunkt ODER die Option „Schliessen"
//      committet als RING (≥3 Punkte).
// Beulengrösse (Ziel-Bogenlänge) per Option, zyklisch, persistiert über
// Aufrufe hinweg (wie `lastSides` bei `polygon.ts`).

import type { Drawing2D } from "../../model/types";
import { bulgeArcPoints } from "../../core";
import { revisionCloudPts } from "../../core";
import { segmentHud, uniqueId } from "../../tools/types";
import type {
  CmdOption,
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
const CLOSE_HIT = 0.15; // Modell-Meter: Klick nahe Startpunkt schliesst den Zug

const ARC_SIZE_PRESETS = [0.2, 0.3, 0.5, 0.8, 1.2];
let lastArcSize = 0.3;
const nextArcSize = (): number =>
  ARC_SIZE_PRESETS[(ARC_SIZE_PRESETS.indexOf(lastArcSize) + 1) % ARC_SIZE_PRESETS.length];

const ARC_SIZE_OPTION: CmdOption = { id: "arcSize", labelKey: "cmd.revcloud.arcSize" };
const CLOSE: CmdOption = { id: "close", labelKey: "cmd.revcloud.close" };

const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

interface RevcloudIdle extends CommandState {
  phase: "start";
}
interface RevcloudDrawing extends CommandState {
  phase: "next";
  points: Vec2[];
  cursor: Vec2 | null;
}
type RevcloudState = RevcloudIdle | RevcloudDrawing;

/** Vorschau: die tatsächliche Beulen-Kontur (tesselliert), inkl. Gummiband zum Cursor. */
function revcloudDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const all = cursor ? [...points, cursor] : points;
  const expanded = revisionCloudPts(all, false, lastArcSize);
  const pts: Vec2[] = [];
  if (expanded) {
    pts.push(expanded.pts[0]);
    for (let i = 0; i < expanded.pts.length - 1; i++) {
      const sub = bulgeArcPoints(expanded.pts[i], expanded.pts[i + 1], expanded.bulge[i]);
      for (let k = 1; k < sub.length; k++) pts.push(sub[k]);
    }
  }
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: false }];
  const draft: ToolDraft = { preview, vertices: points };
  const last = points[points.length - 1];
  if (cursor && last && segLen(last, cursor) >= EPS) draft.hud = segmentHud(last, cursor);
  return draft;
}

function appendRevcloud(p: Project, points: Vec2[], closed: boolean, ctx: CommandContext): Project {
  const expanded = revisionCloudPts(points, closed, lastArcSize);
  if (!expanded) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts: expanded.pts, closed, bulge: expanded.bulge },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "start", lastPoint: null } as RevcloudIdle,
  { draft: null, done: true },
];

export const revcloudCommand: Command = {
  name: "revcloud",
  labelKey: "cmd.revcloud.label",
  prompt: (s) => ((s as RevcloudState).phase === "next" ? "cmd.revcloud.next" : "cmd.revcloud.start"),
  accepts: () => ["point", "option"],
  options: (s) => {
    const st = s as RevcloudState;
    const base = [{ ...ARC_SIZE_OPTION, value: `${lastArcSize}m` }];
    return st.phase === "next" && st.points.length >= 3 ? [CLOSE, ...base] : base;
  },
  init: (): RevcloudIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RevcloudState;

    if (input.kind === "option") {
      if (input.id === "arcSize") {
        lastArcSize = nextArcSize();
        return [
          s,
          { draft: s.phase === "next" ? revcloudDraft(s.points, s.cursor) : null },
        ];
      }
      if (input.id === "close" && s.phase === "next" && s.points.length >= 3) {
        const pts = s.points;
        return [idle()[0], { draft: null, done: true, commit: (p) => appendRevcloud(p, pts, true, ctx) }];
      }
      return [s, { draft: null }];
    }

    if (input.kind !== "point") {
      return [s, { draft: s.phase === "next" ? revcloudDraft(s.points, s.cursor) : null }];
    }
    const pt = input.point;

    if (s.phase !== "next") {
      const ns: RevcloudDrawing = { phase: "next", points: [pt], cursor: pt, lastPoint: pt };
      return [ns, { draft: revcloudDraft([pt], pt) }];
    }

    // Klick nahe Startpunkt (≥3 Punkte) → schliessen (committet als Ring).
    if (s.points.length >= 3 && segLen(s.points[0], pt) < CLOSE_HIT) {
      const pts = s.points;
      return [idle()[0], { draft: null, done: true, commit: (p) => appendRevcloud(p, pts, true, ctx) }];
    }
    const points = [...s.points, pt];
    const ns: RevcloudDrawing = { phase: "next", points, cursor: pt, lastPoint: pt };
    return [ns, { draft: revcloudDraft(points, pt) }];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as RevcloudState;
    if (s.phase !== "next") return [s, { draft: null }];
    const ns: RevcloudDrawing = { ...s, cursor: point };
    return [ns, { draft: revcloudDraft(s.points, point) }];
  },

  // Enter/Space/Rechtsklick: Zug als OFFENE Wolke beenden (≥2 Punkte).
  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as RevcloudState;
    if (s.phase === "next" && s.points.length >= 2) {
      const pts = s.points;
      return [idle()[0], { draft: null, done: true, commit: (p) => appendRevcloud(p, pts, false, ctx) }];
    }
    return idle();
  },
  onCancel: (): [CommandState, CommandResult] => idle(),
};
