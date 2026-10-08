// Ellipse — zwei Konstruktionsmethoden. Wählbar über die Option „Methode"
// (klickbar im Feld-Row, tippbar als „m", zyklisch — dasselbe Muster wie bei
// `rect.ts`/`circle.ts`/`arc.ts`).
//
//   • Box (Default, unverändert): zwei gegenüberliegende Ecken einer
//     Bounding-Box, achsparallel (`rotation` bleibt 0).
//       1) „Erste Ecke:"            → Punkt
//       2) „Gegenüberliegende Ecke:" → Punkt → commit
//   • Achse (gedreht): Zentrum + Hauptachse + Nebenachse — beliebig gedrehte
//     Ellipse. `rotation` existiert im Modell seit Langem (Rendering +
//     Griff-Editieren lesen es bereits, s. `plan/generatePlan/drawing2d.ts`
//     Z. 448 bzw. `projectSlice.ts` `drawingVertices`), nur die Erzeugung
//     setzte es bisher immer auf 0.
//       1) „Zentrum:"       → Punkt
//       2) „Hauptachse:"    → Punkt (Richtung + rx = Abstand zum Zentrum)
//       3) „Nebenachse:"    → Punkt (senkrechter Abstand zur Hauptachse = ry) → commit
//
// Teil-/Ellipsenbogen (a0/a1) bewusst NICHT umgesetzt — das Modell kennt
// dafür keine Felder (separate, grössere Erweiterung, analog wie circle/arc
// getrennte Shapes sind statt einer gemeinsamen mit optionaler Spanne).

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
import { ellipsePts } from "../../tools/curves";
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
type EllipseMethod = "box" | "axis";
const METHOD_ORDER: EllipseMethod[] = ["box", "axis"];
const nextMethod = (m: EllipseMethod): EllipseMethod =>
  METHOD_ORDER[(METHOD_ORDER.indexOf(m) + 1) % METHOD_ORDER.length];
const methodOption = (m: EllipseMethod): CmdOption => ({
  id: "method",
  labelKey: "cmd.ellipse.method",
  value: m,
});

const DEG = Math.PI / 180;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const angleOf = (a: Vec2, b: Vec2): number => Math.atan2(b.y - a.y, b.x - a.x);
const segAngleDeg = (a: Vec2, b: Vec2): number => (angleOf(a, b) * 180) / Math.PI;

/** Senkrechter (signierter) Abstand eines Punktes zur Achse a→b. */
function perpDist(a: Vec2, b: Vec2, p: Vec2): number {
  const len = dist(a, b);
  if (len < EPS) return 0;
  const dx = (b.x - a.x) / len;
  const dy = (b.y - a.y) / len;
  return (p.x - a.x) * -dy + (p.y - a.y) * dx;
}

// ── Zustand ──────────────────────────────────────────────────────────────────

interface EllipseBoxP1 extends CommandState {
  phase: "corner1";
  method: "box";
}
interface EllipseBoxP2 extends CommandState {
  phase: "corner2";
  method: "box";
  p0: Vec2;
  cursor: Vec2 | null;
}
interface EllipseAxisCenter extends CommandState {
  phase: "center";
  method: "axis";
}
interface EllipseAxisMajor extends CommandState {
  phase: "major";
  method: "axis";
  center: Vec2;
  cursor: Vec2 | null;
}
interface EllipseAxisMinor extends CommandState {
  phase: "minor";
  method: "axis";
  center: Vec2;
  major: Vec2;
  cursor: Vec2 | null;
}
type EllipseState =
  | EllipseBoxP1
  | EllipseBoxP2
  | EllipseAxisCenter
  | EllipseAxisMajor
  | EllipseAxisMinor;

/** Zentrum + Halbachsen aus zwei gegenüberliegenden Bounding-Box-Ecken. */
function ellipseFromCorners(p0: Vec2, p1: Vec2): { center: Vec2; rx: number; ry: number } {
  return {
    center: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 },
    rx: Math.abs(p1.x - p0.x) / 2,
    ry: Math.abs(p1.y - p0.y) / 2,
  };
}

// ── Vorschau ─────────────────────────────────────────────────────────────────

function ellipseDraft(center: Vec2, rx: number, ry: number, rotation: number, at: Vec2 | null): ToolDraft {
  if (rx < EPS || ry < EPS) return { preview: [], vertices: [center] };
  const preview: DraftShape[] = [{ kind: "poly", pts: ellipsePts(center, rx, ry, rotation), closed: true }];
  const draft: ToolDraft = { preview, vertices: [center] };
  if (at) draft.hud = { at, text: `${(rx * 2).toFixed(3)}×${(ry * 2).toFixed(3)}m` };
  return draft;
}

function boxDraft(p0: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor) return { preview: [], vertices: [p0] };
  const { center, rx, ry } = ellipseFromCorners(p0, cursor);
  return ellipseDraft(center, rx, ry, 0, cursor);
}

function axisMajorDraft(center: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor || dist(center, cursor) < EPS) return { preview: [], vertices: [center] };
  return { preview: [{ kind: "line", a: center, b: cursor }], vertices: [center], hud: segmentHud(center, cursor) };
}

function axisMinorDraft(center: Vec2, major: Vec2, cursor: Vec2 | null): ToolDraft {
  const rx = dist(center, major);
  if (!cursor) return ellipseDraft(center, rx, 0, angleOf(center, major), null);
  const ry = Math.abs(perpDist(center, major, cursor));
  return ellipseDraft(center, rx, ry, angleOf(center, major), cursor);
}

// ── Commit ───────────────────────────────────────────────────────────────────

function appendEllipse(
  p: Project,
  center: Vec2,
  rx: number,
  ry: number,
  rotation: number,
  ctx: CommandContext,
): Project {
  if (rx < EPS || ry < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "ellipse", center, rx, ry, rotation },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (method: EllipseMethod): [CommandState, CommandResult] => [
  (method === "box" ? { phase: "corner1", method } : { phase: "center", method }) as EllipseState,
  { draft: null, done: true },
];

function promptKey(s: EllipseState): TranslationKey {
  if (s.method === "box") return s.phase === "corner2" ? "cmd.ellipse.corner2" : "cmd.ellipse.corner1";
  if (s.phase === "center") return "cmd.ellipse.axisCenter";
  if (s.phase === "major") return "cmd.ellipse.major";
  return "cmd.ellipse.minor";
}

/** Tab-Feld des Hauptachsen-Schritts: Länge (rx) + Winkel der Achse. */
const MAJOR_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];
/** Tab-Feld des Nebenachsen-Schritts: senkrechter Abstand (ry). */
const MINOR_FIELDS: CommandField[] = [{ id: "radius", labelKey: "cmd.field.radius" }];

export const ellipseCommand: Command = {
  name: "ellipse",
  labelKey: "cmd.ellipse.label",
  prompt: (s) => promptKey(s as EllipseState),
  accepts: () => ["point", "option"],
  options: (s) => [methodOption((s as EllipseState).method)],
  init: (): EllipseBoxP1 => ({ phase: "corner1", method: "box", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as EllipseState;

    if (input.kind === "option") {
      if (input.id === "method") return idle(nextMethod(s.method));
      return [s, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;

    if (s.method === "box") {
      if (s.phase !== "corner2") {
        const ns: EllipseBoxP2 = { phase: "corner2", method: "box", p0: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: boxDraft(pt, pt) }];
      }
      const { center, rx, ry } = ellipseFromCorners(s.p0, pt);
      return [idle("box")[0], { draft: null, done: true, commit: (p) => appendEllipse(p, center, rx, ry, 0, ctx) }];
    }

    // axis
    if (s.phase === "center") {
      const ns: EllipseAxisMajor = { phase: "major", method: "axis", center: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: { preview: [], vertices: [pt] } }];
    }
    if (s.phase === "major") {
      if (dist(s.center, pt) < EPS) return [s, { draft: null }];
      const ns: EllipseAxisMinor = { phase: "minor", method: "axis", center: s.center, major: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: axisMinorDraft(s.center, pt, null) }];
    }
    // phase "minor" → committen.
    const { center, major } = s;
    const rx = dist(center, major);
    const ry = Math.abs(perpDist(center, major, pt));
    const rotation = angleOf(center, major);
    return [
      idle("axis")[0],
      { draft: null, done: true, commit: (p) => appendEllipse(p, center, rx, ry, rotation, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as EllipseState;
    if (s.method === "box") {
      if (s.phase !== "corner2") return [s, { draft: null }];
      const ns: EllipseBoxP2 = { ...s, cursor: point };
      return [ns, { draft: boxDraft(s.p0, point) }];
    }
    if (s.phase === "major") {
      const ns: EllipseAxisMajor = { ...s, cursor: point };
      return [ns, { draft: axisMajorDraft(s.center, point) }];
    }
    if (s.phase === "minor") {
      const ns: EllipseAxisMinor = { ...s, cursor: point };
      return [ns, { draft: axisMinorDraft(s.center, s.major, point) }];
    }
    return [s, { draft: null }];
  },

  onConfirm: (state): [CommandState, CommandResult] => idle((state as EllipseState).method),
  onCancel: (state): [CommandState, CommandResult] => idle((state as EllipseState).method),

  fields: (state) => {
    const s = state as EllipseState;
    if (s.method === "axis" && s.phase === "major") return MAJOR_FIELDS;
    if (s.method === "axis" && s.phase === "minor") return MINOR_FIELDS;
    return [];
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as EllipseState;
    if (!cursor) return {};
    if (s.method === "axis" && s.phase === "major") {
      return { length: dist(s.center, cursor), angle: ((segAngleDeg(s.center, cursor) % 360) + 360) % 360 };
    }
    if (s.method === "axis" && s.phase === "minor") {
      return { radius: Math.abs(perpDist(s.center, s.major, cursor)) };
    }
    return {};
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as EllipseState;
    if (s.method === "axis" && s.phase === "major") {
      const ref = cursor ?? s.center;
      const length = "length" in locks ? locks.length : dist(s.center, ref);
      const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(s.center, ref);
      const ang = angleDeg * DEG;
      return { x: s.center.x + Math.cos(ang) * length, y: s.center.y + Math.sin(ang) * length };
    }
    if (s.method === "axis" && s.phase === "minor") {
      if (!("radius" in locks)) return cursor;
      const len = dist(s.center, s.major);
      if (len < EPS) return cursor;
      const dx = (s.major.x - s.center.x) / len;
      const dy = (s.major.y - s.center.y) / len;
      const sign = cursor && perpDist(s.center, s.major, cursor) < 0 ? -1 : 1;
      const r = sign * Math.abs(locks.radius);
      // Fusspunkt: Nebenachse ausgehend von der Mitte der Hauptachse (Zentrum),
      // orthogonal zur Achsrichtung (-dy, dx).
      return { x: s.center.x + -dy * r, y: s.center.y + dx * r };
    }
    return null;
  },
};
