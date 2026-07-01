// Trim — Quick-Trim („stutzen") für 2D-Kurven (line/polyline/rect), Rhino/
// AutoCAD-artig (docs §2.10/§3.4 Tier-1). Modell:
//   • Cutters sind IMPLIZIT alle ANDEREN Drawing2D-Elemente der aktiven Ebene
//     (Quick-Trim — kein separater Cutter-Auswahlschritt; üblich + einfacher).
//   • Ein Schritt: der Nutzer klickt auf den WEGZUSCHNEIDENDEN Teil einer Kurve.
//     Wir bestimmen das getroffene Element (Nähe), zerlegen es an seinen
//     Schnittpunkten mit allen Cuttern und ENTFERNEN den angeklickten Abschnitt
//     (zwischen den beiden nächstgelegenen Schnittpunkten um den Klick — bzw. bis
//     zum Element-Ende, wenn nur einseitig ein Schnitt liegt).
//   • Wiederholend, bis Esc/Enter.
//
// Linie → wird gekürzt/aufgeteilt; Polylinie → der getroffene Abschnitt fällt
// raus (kann die Polylinie in Stücke teilen). Reine Geometrie liegt im Kernel
// (`trimPolyline`); hier nur Treffer-Bestimmung, Drawing2D ↔ {pts,closed} und der
// Commit. Wände sind ausgenommen (nur Drawing2D).
//
// Bezeichner englisch, Kommentare/UI deutsch (CONVENTIONS.md).

import type { Drawing2D, Drawing2DGeom } from "../../model/types";
import { uniqueId } from "../../tools/types";
import {
  pointSegmentDistance,
  polylineEdges,
  trimPolyline,
  vecEqual,
} from "../../geometry/kernel2d";
import type {
  Command,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  Vec2,
} from "../types";

const HIT_TOL = 0.25; // Modell-Meter: Pick-Toleranz für die Kurvenwahl

// ── Kurven-Abstraktion: line/polyline/rect → Punktliste + closed ──────────────

interface Curve {
  pts: Vec2[];
  closed: boolean;
}

/** Wandelt eine trim-fähige 2D-Form in eine Punktliste (+closed) oder null. */
function geomToCurve(g: Drawing2DGeom): Curve | null {
  if (g.shape === "line") return { pts: [g.a, g.b], closed: false };
  if (g.shape === "polyline") return { pts: g.pts, closed: g.closed };
  if (g.shape === "rect") {
    return {
      pts: [
        g.min,
        { x: g.max.x, y: g.min.y },
        g.max,
        { x: g.min.x, y: g.max.y },
      ],
      closed: true,
    };
  }
  return null; // circle/arc/text: hier nicht trim-fähig (offener Punkt)
}

/** Ist diese Form trim-fähig (line/polyline/rect)? */
function isTrimmable(d: Drawing2D): boolean {
  return (
    d.geom.shape === "line" ||
    d.geom.shape === "polyline" ||
    d.geom.shape === "rect"
  );
}

/** Nächstes trim-fähiges Drawing2D der Ebene zum Klickpunkt (innerhalb Toleranz). */
function pickCurveAt(
  project: Project,
  levelId: string,
  pt: Vec2,
): Drawing2D | null {
  let best: Drawing2D | null = null;
  let bestD = HIT_TOL;
  for (const d of project.drawings2d) {
    if (d.levelId !== levelId) continue;
    if (!isTrimmable(d)) continue;
    const curve = geomToCurve(d.geom);
    if (!curve) continue;
    for (const [a, b] of polylineEdges(curve.pts, curve.closed)) {
      const dd = pointSegmentDistance(pt, a, b);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
  }
  return best;
}

/** Alle anderen trim-fähigen Drawing2D der Ebene als Cutter-Kurven. */
function cuttersFor(
  project: Project,
  levelId: string,
  exceptId: string,
): Curve[] {
  const out: Curve[] = [];
  for (const d of project.drawings2d) {
    if (d.id === exceptId) continue;
    if (d.levelId !== levelId) continue;
    const curve = geomToCurve(d.geom);
    if (curve) out.push(curve);
  }
  return out;
}

/** Sind zwei Ketten geometrisch identisch (gleiches closed + gleiche Punkte)? */
function sameChain(a: { pts: Vec2[]; closed: boolean }, b: Curve): boolean {
  if (a.closed !== b.closed || a.pts.length !== b.pts.length) return false;
  for (let i = 0; i < a.pts.length; i++) {
    if (!vecEqual(a.pts[i], b.pts[i])) return false;
  }
  return true;
}

/** Eine getrimmte Rest-Kette als passende Drawing2D-Geometrie. */
function chainToGeom(chain: { pts: Vec2[]; closed: boolean }): Drawing2DGeom {
  if (chain.pts.length === 2 && !chain.closed) {
    return { shape: "line", a: chain.pts[0], b: chain.pts[1] };
  }
  return { shape: "polyline", pts: chain.pts, closed: chain.closed };
}

/**
 * Wendet einen Trim auf das Projekt an: ersetzt das getroffene Element durch
 * seine Rest-Ketten (Attribute geerbt). Bleibt nichts übrig, fällt es weg.
 */
function applyTrim(
  p: Project,
  target: Drawing2D,
  pick: Vec2,
): Project {
  const curve = geomToCurve(target.geom);
  if (!curve) return p;
  const cutters = cuttersFor(p, target.levelId, target.id).map((c) => ({
    pts: c.pts,
    closed: c.closed,
  }));
  const rest = trimPolyline(curve.pts, curve.closed, cutters, pick);
  // Echtes No-op: genau eine Kette, identisch (gleiche Punkte) zur Quelle →
  // nichts wurde weggeschnitten (kein Schnitt mit Cuttern).
  if (rest.length === 1 && sameChain(rest[0], curve)) return p;
  const replacements: Drawing2D[] = rest
    .filter((c) => c.pts.length >= 2)
    .map((c) => ({ ...target, id: uniqueId("dr2d"), geom: chainToGeom(c) }));
  const others = p.drawings2d.filter((d) => d.id !== target.id);
  return { ...p, drawings2d: [...others, ...replacements] };
}

/** Vorschau-Formen der NACH dem Trim verbleibenden Ketten (für den Draft). */
function trimPreview(
  project: Project,
  target: Drawing2D,
  pick: Vec2,
): DraftShape[] {
  const curve = geomToCurve(target.geom);
  if (!curve) return [];
  const cutters = cuttersFor(project, target.levelId, target.id).map((c) => ({
    pts: c.pts,
    closed: c.closed,
  }));
  const rest = trimPolyline(curve.pts, curve.closed, cutters, pick);
  const out: DraftShape[] = [];
  for (const c of rest) {
    if (c.pts.length < 2) continue;
    if (c.pts.length === 2 && !c.closed) {
      out.push({ kind: "line", a: c.pts[0], b: c.pts[1] });
    } else {
      out.push({ kind: "poly", pts: c.pts, closed: c.closed });
    }
  }
  return out;
}

// ── Zustand ───────────────────────────────────────────────────────────────────
// Einziger Schritt „pick": auf den wegzuschneidenden Abschnitt klicken;
// wiederholend, bis Esc/Enter. „done": beendet.
interface TrimPick extends CommandState {
  phase: "pick";
}
interface TrimDone extends CommandState {
  phase: "done";
}
type TrimState = TrimPick | TrimDone;

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as TrimDone,
  { draft: null, done: true },
];

export const trimCommand: Command = {
  name: "trim",
  labelKey: "cmd.trim.label",
  prompt: () => "cmd.trim.pick",
  accepts: () => ["point"],
  options: () => [],

  init: (): TrimPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as TrimState;
    if (s.phase === "done") return finish();
    if (input.kind !== "point") return [s, { draft: null }];
    const target = pickCurveAt(ctx.project, ctx.level.id, input.point);
    if (!target) {
      // Daneben geklickt → Befehl bleibt aktiv (weiter trimmen).
      return [s, { draft: null }];
    }
    const pick = input.point;
    // Wiederholend: NICHT done — nach dem Commit bleibt „pick" aktiv.
    return [
      s,
      { draft: null, commit: (p) => applyTrim(p, target, pick) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as TrimState;
    if (s.phase !== "pick") return [s, { draft: null }];
    const target = pickCurveAt(ctx.project, ctx.level.id, point);
    if (!target) return [s, { draft: null }];
    const preview = trimPreview(ctx.project, target, point);
    return [
      s,
      {
        draft: {
          preview,
          vertices: [],
          hud: { at: point, text: "✂" },
        },
      },
    ];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
