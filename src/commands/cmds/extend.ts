// Extend — verlängert eine OFFENE 2D-Kurve (line/offene polyline) bis zur
// nächsten anderen Kurve (Rhino/AutoCAD-artig, Gegenstück zu Trim). Modell:
//   • Cutters sind IMPLIZIT alle ANDEREN Drawing2D-Elemente der aktiven Ebene
//     (wie bei Trim — kein separater Cutter-Auswahlschritt).
//   • Ein Schritt: der Nutzer klickt auf die zu verlängernde Kurve, NAHE dem
//     Ende, das verlängert werden soll (das Ende, das dem Klick am nächsten
//     liegt, wird verlängert — nicht zwingend das nächste per Cursor-Distanz
//     zur ganzen Kurve, sondern zum jeweiligen Endpunkt).
//   • Trifft die Verlängerung keinen Cutter, passiert nichts (kein Fehler,
//     Befehl bleibt aktiv).
//   • Wiederholend, bis Esc/Enter.
//
// Geschlossene Formen (rect, geschlossene polyline) und reine Punktformen
// (circle/arc/text) sind nicht extend-fähig — ein geschlossener Ring hat kein
// "Ende". Reine Geometrie liegt im Kernel (`extendSegment`/`extendBulgeSegment`);
// hier nur Treffer-Bestimmung, Drawing2D ↔ {pts,closed,bulge} und der Commit.
//
// Bogen-Enden: ist das äusserste Segment ein echter Bogen (bulge), verlängert
// `extendBulgeSegment` denselben Kreis (Mittelpunkt/Radius unverändert, nur
// die Schwenk-Spanne wächst) bis zum nächsten Schneider — Cutter bleiben
// bewusst GERADE (wie überall bei Trim/Extend, s. `cuttersFor`).
//
// Bezeichner englisch, Kommentare/UI deutsch (CONVENTIONS.md).

import type { Drawing2D, Drawing2DGeom } from "../../model/types";
import { bulgeArcPoints, hasRealBulge } from "../../core";
import { extendBulgeSegment, extendSegment, pointSegmentDistance, polylineEdges } from "../../core";
import type {
  Command,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  Vec2,
} from "../types";

const HIT_TOL = 0.25; // Modell-Meter: Pick-Toleranz für die Kurvenwahl

interface Curve {
  pts: Vec2[];
  closed: boolean;
  bulge?: number[];
}

/** Wandelt eine extend-fähige 2D-Form (offen) in eine Punktliste oder null. */
function geomToOpenCurve(g: Drawing2DGeom): Curve | null {
  if (g.shape === "line") return { pts: [g.a, g.b], closed: false };
  if (g.shape === "polyline" && !g.closed) return { pts: g.pts, closed: false, bulge: g.bulge };
  return null; // rect/geschlossene polyline/circle/arc/text: kein Ende zum Verlängern
}

/**
 * Treffer-Kanten einer (evtl. bulge-tragenden) Kurve für Pick/Preview: bei
 * echten Bogen-Segmenten wird tesselliert (Kreisbogen ≠ Sehne), sonst bleiben
 * es die rohen Polylinien-Kanten. Wortgetreu wie `offset.ts`/`trim.ts`.
 */
function curveHitEdges(curve: Curve): [Vec2, Vec2][] {
  if (!hasRealBulge(curve.bulge)) return polylineEdges(curve.pts, curve.closed);
  const n = curve.pts.length;
  const edgeCount = curve.closed ? n : n - 1;
  const chain: Vec2[] = [curve.pts[0]];
  for (let i = 0; i < edgeCount; i++) {
    const seg = bulgeArcPoints(curve.pts[i], curve.pts[(i + 1) % n], curve.bulge?.[i]);
    chain.push(...seg.slice(1));
  }
  return polylineEdges(chain, false);
}

/** Alle trim/extend-fähigen Drawing2D der Ebene als Cutter-Kurven (auch geschlossene). */
function cuttersFor(project: Project, levelId: string, exceptId: string): Curve[] {
  const out: Curve[] = [];
  for (const d of project.drawings2d) {
    if (d.id === exceptId) continue;
    if (d.levelId !== levelId) continue;
    const g = d.geom;
    if (g.shape === "line") out.push({ pts: [g.a, g.b], closed: false });
    // Als Cutter würde eine Bogen-Polylinie fälschlich als Gerade behandelt
    // (falscher Schnittpunkt) — lieber als Cutter ignorieren als falsch rechnen.
    else if (g.shape === "polyline" && !hasRealBulge(g.bulge)) out.push({ pts: g.pts, closed: g.closed });
    else if (g.shape === "rect") {
      out.push({
        pts: [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }],
        closed: true,
      });
    }
  }
  return out;
}

/** Nächste extend-fähige (offene) Drawing2D der Ebene zum Klickpunkt. */
function pickOpenCurveAt(project: Project, levelId: string, pt: Vec2): Drawing2D | null {
  let best: Drawing2D | null = null;
  let bestD = HIT_TOL;
  for (const d of project.drawings2d) {
    if (d.levelId !== levelId) continue;
    const curve = geomToOpenCurve(d.geom);
    if (!curve) continue;
    for (const [a, b] of curveHitEdges(curve)) {
      const dd = pointSegmentDistance(pt, a, b);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
  }
  return best;
}

/**
 * Verlängert die Kurve am Ende, das dem Klickpunkt am nächsten liegt, bis zum
 * nächsten Schnitt mit den Cuttern (jenseits dieses Endes). Liefert die neuen
 * Punkte (+ ggf. bulge-Array), oder `null`, wenn kein Cutter getroffen wird
 * (kein Effekt). Ist das betroffene ÄUSSERSTE Segment ein echter Bogen, läuft
 * die Verlängerung über `extendBulgeSegment` (gleicher Kreis, grössere
 * Schwenk-Spanne) statt über die Geraden-Variante.
 */
function extendCurve(curve: Curve, cutters: Curve[], pick: Vec2): Curve | null {
  const n = curve.pts.length;
  if (n < 2) return null;
  const distStart = Math.hypot(pick.x - curve.pts[0].x, pick.y - curve.pts[0].y);
  const distEnd = Math.hypot(pick.x - curve.pts[n - 1].x, pick.y - curve.pts[n - 1].y);
  const extendStart = distStart <= distEnd;
  const segIdx = extendStart ? 0 : n - 2; // bulge-Index des äussersten Segments
  const bulgeVal = curve.bulge?.[segIdx] ?? 0;

  if (Math.abs(bulgeVal) > 1e-9) {
    const a = curve.pts[segIdx];
    const b = curve.pts[segIdx + 1];
    const result = extendBulgeSegment(a, b, bulgeVal, extendStart ? "start" : "end", cutters);
    if (!result) return null;
    const nextPts = [...curve.pts];
    const nextBulge = curve.bulge ? [...curve.bulge] : new Array(n - 1).fill(0);
    if (extendStart) {
      nextPts[0] = result.point;
      nextBulge[0] = result.bulge;
    } else {
      nextPts[n - 1] = result.point;
      nextBulge[n - 2] = result.bulge;
    }
    return { pts: nextPts, closed: false, bulge: nextBulge };
  }

  const idxA = extendStart ? 1 : n - 2;
  const idxB = extendStart ? 0 : n - 1;
  const result = extendSegment(curve.pts[idxA], curve.pts[idxB], "end", cutters);
  if (!result) return null;
  const next = [...curve.pts];
  next[idxB] = result[1];
  return { pts: next, closed: false, bulge: curve.bulge };
}

/** Wendet Extend auf das Projekt an: ersetzt die getroffene Kurve durch ihre verlängerte Form. */
function applyExtend(p: Project, target: Drawing2D, pick: Vec2): Project {
  const curve = geomToOpenCurve(target.geom);
  if (!curve) return p;
  const cutters = cuttersFor(p, target.levelId, target.id);
  const next = extendCurve(curve, cutters, pick);
  if (!next) return p;
  const geom: Drawing2DGeom =
    next.pts.length === 2 && target.geom.shape === "line" && !hasRealBulge(next.bulge)
      ? { shape: "line", a: next.pts[0], b: next.pts[1] }
      : {
          shape: "polyline",
          pts: next.pts,
          closed: false,
          ...(hasRealBulge(next.bulge) ? { bulge: next.bulge } : {}),
        };
  return {
    ...p,
    drawings2d: p.drawings2d.map((d) => (d.id === target.id ? { ...d, geom } : d)),
  };
}

/** Vorschau-Form der verlängerten Kurve (für den Draft — Bogen tesselliert, s. `curveHitEdges`). */
function extendPreview(project: Project, target: Drawing2D, pick: Vec2): DraftShape[] {
  const curve = geomToOpenCurve(target.geom);
  if (!curve) return [];
  const cutters = cuttersFor(project, target.levelId, target.id);
  const next = extendCurve(curve, cutters, pick);
  if (!next) return [];
  const pts = hasRealBulge(next.bulge)
    ? curveHitEdges(next).reduce<Vec2[]>((acc, [a, b], i) => {
        if (i === 0) acc.push(a);
        acc.push(b);
        return acc;
      }, [])
    : next.pts;
  return [{ kind: "poly", pts, closed: false }];
}

// ── Zustand ───────────────────────────────────────────────────────────────────
// Einziger Schritt „pick": auf die zu verlängernde Kurve (nahe dem Ende) klicken;
// wiederholend, bis Esc/Enter.
interface ExtendPick extends CommandState {
  phase: "pick";
}
interface ExtendDone extends CommandState {
  phase: "done";
}
type ExtendState = ExtendPick | ExtendDone;

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ExtendDone,
  { draft: null, done: true },
];

export const extendCommand: Command = {
  name: "extend",
  labelKey: "cmd.extend.label",
  prompt: () => "cmd.extend.pick",
  accepts: () => ["point"],
  options: () => [],

  init: (): ExtendPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ExtendState;
    if (s.phase === "done") return finish();
    if (input.kind !== "point") return [s, { draft: null }];
    const target = pickOpenCurveAt(ctx.project, ctx.level.id, input.point);
    if (!target) return [s, { draft: null }];
    const pick = input.point;
    return [s, { draft: null, commit: (p) => applyExtend(p, target, pick) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ExtendState;
    if (s.phase !== "pick") return [s, { draft: null }];
    const target = pickOpenCurveAt(ctx.project, ctx.level.id, point);
    if (!target) return [s, { draft: null }];
    const preview = extendPreview(ctx.project, target, point);
    return [s, { draft: { preview, vertices: [], hud: { at: point, text: "↗" } } }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
