// Circle — vier Konstruktionsmethoden (Nutzer-Wunsch: „Kreis durch zwei/drei
// bekannte Punkte" bzw. „tangential an zwei Wände" lässt sich über reines
// Mittelpunkt+Radius nicht direkt lösen). Wählbar über die Option „Methode"
// (klickbar im Feld-Row, tippbar als „m", zyklisch — dasselbe Muster wie bei
// `rect.ts`/`arc.ts`).
//
//   • Mittelpunkt (Default, unverändert): Mittelpunkt + Radius.
//       1) „Mittelpunkt:" → Punkt
//       2) „Radius:"       → Punkt (Abstand) ODER getippte Zahl (Radius) → commit
//   • 2-Punkt: die zwei Punkte sind die Enden EINES Durchmessers.
//       1) „Erster Punkt (Durchmesser):"  → Punkt
//       2) „Zweiter Punkt (Durchmesser):" → Punkt → commit
//   • 3-Punkt: Kreis durch alle drei Punkte (Umkreis).
//       1) „Erster Punkt:"  → Punkt
//       2) „Zweiter Punkt:" → Punkt
//       3) „Dritter Punkt:" → Punkt → commit (kollinear ⇒ Punkt wird ignoriert)
//   • TTR (Tangente-Tangente-Radius): Kreis tangential an zwei bestehende
//     Linien/Kreise/Bögen (gerade Kanten von line/polyline/rect ODER volle
//     circle/arc-Kreise), mit vorgegebenem Radius.
//       1) „Erstes Tangentenobjekt wählen:"  → Punkt (Hit-Test, kein Treffer
//          ⇒ Klick wird ignoriert, Schritt bleibt aktiv)
//       2) „Zweites Tangentenobjekt wählen:" → Punkt (Hit-Test; Treffer auf
//          dasselbe Element wie Schritt 1 wird ignoriert)
//       3) „Radius:" → Punkt (Abstand zum ERSTEN Klickpunkt aus Schritt 1)
//          ODER getippte Zahl → commit. Die eigentliche Geometrie steckt in
//          `geometry/kernel2d.ts::tangentCircleCenters` (Apollonius-
//          Spezialfall mit bekanntem Radius): pro Tangentialobjekt wird der
//          geometrische Ort aller passenden Mittelpunkte gebildet (Gerade:
//          zwei Parallelen im Abstand r; Kreis: äussere/innere Berührung),
//          die Örter werden geschnitten, und aus den 0-8 Kandidaten wird der
//          zu den beiden ANKLICKPUNKTEN nächstgelegene gewählt (dieselbe
//          „near"-Disambiguierung wie bei `bulgeFromSagittaPoint` &Co.).
//
// Radius akzeptiert bei der Mittelpunkt- UND der TTR-Methode sowohl einen
// Maus-Punkt (Abstand) als auch eine getippte nackte Zahl. Der Kreis wird in
// generatePlan als geschlossene Polygon-Approximation gerendert.

import type { Drawing2D, Drawing2DGeom } from "../../model/types";
import { uniqueId } from "../../tools/types";
import { arcThroughPoints } from "../../core";
import { pointSegmentDistance, polylineEdges, tangentCircleCenters, type TangentTarget } from "../../core";
import type {
  CmdOption,
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
import type { TranslationKey } from "../../i18n";

const EPS = 1e-6;

/** Konstruktionsmethode. */
type CircleMethod = "center" | "twoPoint" | "threePoint" | "ttr";
const METHOD_ORDER: CircleMethod[] = ["center", "twoPoint", "threePoint", "ttr"];
const nextMethod = (m: CircleMethod): CircleMethod =>
  METHOD_ORDER[(METHOD_ORDER.indexOf(m) + 1) % METHOD_ORDER.length];
const methodValue = (m: CircleMethod): string =>
  m === "center" ? "center" : m === "twoPoint" ? "2pt" : m === "threePoint" ? "3pt" : "ttr";

const methodOption = (m: CircleMethod): CmdOption => ({
  id: "method",
  labelKey: "cmd.circle.method",
  value: methodValue(m),
});

interface CircleCenterP1 extends CommandState {
  phase: "center";
  method: "center";
}
interface CircleCenterP2 extends CommandState {
  phase: "radius";
  method: "center";
  center: Vec2;
  cursor: Vec2 | null;
}
interface CircleTwoP1 extends CommandState {
  phase: "p1";
  method: "twoPoint";
}
interface CircleTwoP2 extends CommandState {
  phase: "p2";
  method: "twoPoint";
  a: Vec2;
  cursor: Vec2 | null;
}
interface CircleThreeP1 extends CommandState {
  phase: "p1";
  method: "threePoint";
}
interface CircleThreeP2 extends CommandState {
  phase: "p2";
  method: "threePoint";
  a: Vec2;
  cursor: Vec2 | null;
}
interface CircleThreeP3 extends CommandState {
  phase: "p3";
  method: "threePoint";
  a: Vec2;
  b: Vec2;
  cursor: Vec2 | null;
}
interface CircleTtrT1 extends CommandState {
  phase: "t1";
  method: "ttr";
}
interface CircleTtrT2 extends CommandState {
  phase: "t2";
  method: "ttr";
  t1: TangentTarget;
  near1: Vec2;
  t1DrawingId: string;
}
interface CircleTtrRadius extends CommandState {
  phase: "radius";
  method: "ttr";
  t1: TangentTarget;
  near1: Vec2;
  t2: TangentTarget;
  near2: Vec2;
  cursor: Vec2 | null;
}
type CircleState =
  | CircleCenterP1
  | CircleCenterP2
  | CircleTwoP1
  | CircleTwoP2
  | CircleThreeP1
  | CircleThreeP2
  | CircleThreeP3
  | CircleTtrT1
  | CircleTtrT2
  | CircleTtrRadius;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// ── TTR: Hit-Testing auf bestehende Linien/Kreise ───────────────────────────

const TTR_HIT_TOL = 0.3; // Modell-Meter: Pick-Toleranz für die Tangentenobjekt-Wahl

interface TangentPick {
  target: TangentTarget;
  near: Vec2;
  drawingId: string;
}

/** Winkel `ang` (rad) liegt innerhalb des Bogenspanns [a0, a1) (CCW, mit Wraparound). */
function inArcSpan(a0: number, a1: number, ang: number): boolean {
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const sweep = norm(a1 - a0) || TAU;
  return norm(ang - a0) <= sweep + 1e-6;
}

/** Gerade Kanten einer Form (line/polyline ohne Bogen-Segmente/rect) für den TTR-Hit-Test. */
function straightEdgesOf(g: Drawing2DGeom): [Vec2, Vec2][] {
  if (g.shape === "line") return [[g.a, g.b]];
  if (g.shape === "rect") {
    const pts = [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }];
    return polylineEdges(pts, true);
  }
  if (g.shape === "polyline") {
    const edges = polylineEdges(g.pts, g.closed);
    // Bogen-Segmente (bulge) sind hier keine Geraden — von der Tangenten-Wahl
    // ausgenommen (dieselbe Vereinfachung wie bei fillet.ts::geomToCurve).
    return edges.filter((_, i) => Math.abs(g.bulge?.[i] ?? 0) <= EPS);
  }
  return [];
}

/** Nächstes tangentenfähiges Element (Gerade ODER Kreis/Bogen) zum Klickpunkt, oder null. */
function pickTangentTarget(project: Project, levelId: string, pt: Vec2): TangentPick | null {
  let best: TangentPick | null = null;
  let bestD = TTR_HIT_TOL;
  for (const d of project.drawings2d) {
    if (d.levelId !== levelId) continue;
    const g = d.geom;
    if (g.shape === "circle") {
      const dd = Math.abs(dist(pt, g.center) - g.r);
      if (dd < bestD) {
        bestD = dd;
        best = { target: { kind: "circle", center: g.center, r: g.r }, near: pt, drawingId: d.id };
      }
    } else if (g.shape === "arc") {
      const dd = Math.abs(dist(pt, g.center) - g.r);
      const ang = Math.atan2(pt.y - g.center.y, pt.x - g.center.x);
      if (dd < bestD && inArcSpan(g.a0, g.a1, ang)) {
        bestD = dd;
        best = { target: { kind: "circle", center: g.center, r: g.r }, near: pt, drawingId: d.id };
      }
    } else {
      for (const [a, b] of straightEdgesOf(g)) {
        const dd = pointSegmentDistance(pt, a, b);
        if (dd < bestD) {
          bestD = dd;
          best = { target: { kind: "line", a, b }, near: pt, drawingId: d.id };
        }
      }
    }
  }
  return best;
}

/** Von mehreren Mittelpunkt-Kandidaten den zu (near1, near2) nächstgelegenen wählen. */
function nearestCandidate(cands: Vec2[], near1: Vec2, near2: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const c of cands) {
    const dd = dist(c, near1) + dist(c, near2);
    if (dd < bestD) {
      bestD = dd;
      best = c;
    }
  }
  return best;
}

/** Tab-Feld des Radius-Schritts (nur Methode „center"): der Radius selbst. */
const CIRCLE_FIELDS: CommandField[] = [{ id: "radius", labelKey: "cmd.field.radius" }];

/**
 * Punkt auf dem Kreis aus gelocktem Radius (oder Cursor-Abstand), so dass
 * dist(center, point) = Radius. Die Richtung folgt dem Cursor (sonst +X).
 */
function circlePointFromFields(center: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const r = "radius" in locks ? Math.abs(locks.radius) : cursor ? dist(center, cursor) : 0;
  if (cursor) {
    const d = dist(center, cursor);
    if (d > EPS) {
      return { x: center.x + ((cursor.x - center.x) / d) * r, y: center.y + ((cursor.y - center.y) / d) * r };
    }
  }
  return { x: center.x + r, y: center.y };
}

/** Punkte einer Kreis-Approximation (für die Vorschau). */
function circlePts(center: Vec2, r: number): Vec2[] {
  const N = 48;
  const pts: Vec2[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/** Vorschau (Kreis) + HUD (Radius). */
function circleDraft(center: Vec2, r: number, at: Vec2 | null): ToolDraft {
  if (r < EPS) return { preview: [], vertices: [center] };
  const preview: DraftShape[] = [{ kind: "poly", pts: circlePts(center, r), closed: true }];
  const draft: ToolDraft = { preview, vertices: [center] };
  if (at) draft.hud = { at, text: `R: ${r.toFixed(3)}m` };
  return draft;
}

/** Platzhalter-Vorschau (gerade Linie) für Zwischenschritte ohne vollständigen Kreis. */
function lineDraft(a: Vec2, b: Vec2): ToolDraft {
  return { preview: [{ kind: "line", a, b }], vertices: [a] };
}

function appendCircle(p: Project, center: Vec2, r: number, ctx: CommandContext): Project {
  if (r < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "circle", center, r },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (method: CircleMethod): [CommandState, CommandResult] => [
  (method === "center"
    ? { phase: "center", method }
    : method === "ttr"
      ? { phase: "t1", method }
      : { phase: "p1", method }) as CircleState,
  { draft: null, done: true },
];

function promptKey(s: CircleState): TranslationKey {
  if (s.method === "center") return s.phase === "radius" ? "cmd.circle.radius" : "cmd.circle.center";
  if (s.method === "twoPoint") return s.phase === "p2" ? "cmd.circle.diameterEnd" : "cmd.circle.diameterStart";
  if (s.method === "ttr") {
    if (s.phase === "radius") return "cmd.circle.radius";
    return s.phase === "t2" ? "cmd.circle.ttrSecond" : "cmd.circle.ttrFirst";
  }
  // threePoint
  if (s.phase === "p2") return "cmd.circle.threeSecond";
  if (s.phase === "p3") return "cmd.circle.threeThird";
  return "cmd.circle.threeFirst";
}

export const circleCommand: Command = {
  name: "circle",
  labelKey: "cmd.circle.label",
  prompt: (s) => promptKey(s as CircleState),
  accepts: (s) => {
    const st = s as CircleState;
    if (st.phase === "radius" && (st.method === "center" || st.method === "ttr")) return ["point", "number", "option"];
    return ["point", "option"];
  },
  options: (s) => [methodOption((s as CircleState).method)],
  init: (): CircleCenterP1 => ({ phase: "center", method: "center", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as CircleState;

    if (input.kind === "option") {
      if (input.id === "method") return idle(nextMethod(s.method));
      return [s, { draft: null }];
    }
    // Nur die Mittelpunkt- und die TTR-Methode akzeptieren im Radius-Schritt
    // eine getippte Zahl; alle anderen Schritte/Methoden brauchen einen Punkt.
    const acceptsNumber = s.phase === "radius" && (s.method === "center" || s.method === "ttr");
    if (input.kind !== "point" && !(acceptsNumber && input.kind === "number")) {
      return [s, { draft: null }];
    }

    if (s.method === "center") {
      if (s.phase !== "radius") {
        if (input.kind !== "point") return [s, { draft: null }];
        const ns: CircleCenterP2 = { phase: "radius", method: "center", center: input.point, cursor: input.point, lastPoint: input.point };
        return [ns, { draft: circleDraft(input.point, 0, null) }];
      }
      let r: number;
      if (input.kind === "number") r = input.value;
      else r = dist(s.center, input.point);
      const center = s.center;
      return [idle("center")[0], { draft: null, done: true, commit: (p) => appendCircle(p, center, r, ctx) }];
    }

    if (s.method === "ttr") {
      if (s.phase === "radius") {
        let r: number;
        if (input.kind === "number") r = input.value;
        else r = dist(s.near1, input.point);
        const center = r > EPS ? nearestCandidate(tangentCircleCenters(s.t1, s.t2, r), s.near1, s.near2) : null;
        // Kein Kandidat (z. B. Radius geometrisch unpassend) — ignorieren, weiter warten.
        if (!center) return [s, { draft: null }];
        return [idle("ttr")[0], { draft: null, done: true, commit: (p) => appendCircle(p, center, r, ctx) }];
      }
      if (input.kind !== "point") return [s, { draft: null }];
      const pick = pickTangentTarget(ctx.project, ctx.level.id, input.point);
      if (!pick) return [s, { draft: null }]; // kein Treffer auf Linie/Kreis — ignorieren, weiter warten
      if (s.phase === "t1") {
        const ns: CircleTtrT2 = {
          phase: "t2",
          method: "ttr",
          t1: pick.target,
          near1: pick.near,
          t1DrawingId: pick.drawingId,
          lastPoint: input.point,
        };
        return [ns, { draft: { preview: [], vertices: [pick.near] } }];
      }
      // phase t2
      if (pick.drawingId === s.t1DrawingId) return [s, { draft: null }]; // dasselbe Element — ignorieren
      const ns: CircleTtrRadius = {
        phase: "radius",
        method: "ttr",
        t1: s.t1,
        near1: s.near1,
        t2: pick.target,
        near2: pick.near,
        cursor: input.point,
        lastPoint: input.point,
      };
      return [ns, { draft: lineDraft(s.near1, pick.near) }];
    }

    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;

    if (s.method === "twoPoint") {
      if (s.phase === "p1") {
        const ns: CircleTwoP2 = { phase: "p2", method: "twoPoint", a: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: { preview: [], vertices: [pt] } }];
      }
      const center = mid(s.a, pt);
      const r = dist(s.a, pt) / 2;
      return [idle("twoPoint")[0], { draft: null, done: true, commit: (p) => appendCircle(p, center, r, ctx) }];
    }

    // threePoint
    if (s.phase === "p1") {
      const ns: CircleThreeP2 = { phase: "p2", method: "threePoint", a: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: { preview: [], vertices: [pt] } }];
    }
    if (s.phase === "p2") {
      if (dist(s.a, pt) < EPS) return [s, { draft: null }];
      const ns: CircleThreeP3 = { phase: "p3", method: "threePoint", a: s.a, b: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: lineDraft(s.a, pt) }];
    }
    // phase p3: dritter Punkt → Umkreis, committen.
    const circ = arcThroughPoints(s.a, s.b, pt); // a0/a1 hier irrelevant, nur center+r zählen
    if (!circ) return [s, { draft: lineDraft(s.a, pt) }]; // kollinear — ignorieren, weiter warten
    return [
      idle("threePoint")[0],
      { draft: null, done: true, commit: (p) => appendCircle(p, circ.center, circ.r, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as CircleState;
    if (s.method === "center") {
      if (s.phase !== "radius") return [s, { draft: null }];
      const r = dist(s.center, point);
      const ns: CircleCenterP2 = { ...s, cursor: point };
      return [ns, { draft: circleDraft(s.center, r, point) }];
    }
    if (s.method === "twoPoint") {
      if (s.phase !== "p2") return [s, { draft: null }];
      const ns: CircleTwoP2 = { ...s, cursor: point };
      return [ns, { draft: circleDraft(mid(s.a, point), dist(s.a, point) / 2, point) }];
    }
    // threePoint
    if (s.phase === "p2") {
      const ns: CircleThreeP2 = { ...s, cursor: point };
      return [ns, { draft: lineDraft(s.a, point) }];
    }
    if (s.phase === "p3") {
      const ns: CircleThreeP3 = { ...s, cursor: point };
      const circ = arcThroughPoints(s.a, s.b, point);
      return [ns, { draft: circ ? circleDraft(circ.center, circ.r, point) : lineDraft(s.a, point) }];
    }
    if (s.method === "ttr" && s.phase === "radius") {
      const r = dist(s.near1, point);
      const ns: CircleTtrRadius = { ...s, cursor: point };
      if (r < EPS) return [ns, { draft: null }];
      const center = nearestCandidate(tangentCircleCenters(s.t1, s.t2, r), s.near1, s.near2);
      return [ns, { draft: center ? circleDraft(center, r, point) : lineDraft(s.near1, s.near2) }];
    }
    return [s, { draft: null }];
  },

  onConfirm: (state): [CommandState, CommandResult] => idle((state as CircleState).method),
  onCancel: (state): [CommandState, CommandResult] => idle((state as CircleState).method),

  // Tab-Feld-Zyklus nur im „radius"-Schritt der Mittelpunkt-Methode; der
  // gelockte Wert committet direkt (Punkt liegt auf dem Kreis).
  fields: (state) => {
    const s = state as CircleState;
    return s.phase === "radius" && (s.method === "center" || s.method === "ttr") ? CIRCLE_FIELDS : [];
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as CircleState;
    if (s.phase !== "radius" || !cursor) return {};
    if (s.method === "center") return { radius: dist(s.center, cursor) };
    if (s.method === "ttr") return { radius: dist(s.near1, cursor) };
    return {};
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as CircleState;
    if (s.phase !== "radius") return null;
    if (s.method === "center") return circlePointFromFields(s.center, locks, cursor);
    if (s.method === "ttr") return circlePointFromFields(s.near1, locks, cursor);
    return null;
  },
};
