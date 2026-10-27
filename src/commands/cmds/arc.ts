// Arc — vier Konstruktionsmethoden (Nutzer-Wunsch: „Architekten kennen fast
// nie den Bogen-Mittelpunkt, sondern zwei Endpunkte + einen Durchgangspunkt/
// Radius/Richtung"). Wählbar über die Option „Methode" (klickbar im
// Feld-Row, tippbar als „m", zyklisch — dasselbe Muster wie bei `rect.ts`).
//
//   • Mittelpunkt (Default, unverändert): Mittelpunkt + Startpunkt + Endpunkt.
//       1) „Mittelpunkt:"  → Punkt
//       2) „Startpunkt:"   → Punkt (setzt Radius r = |P1−Center| UND Startwinkel a0)
//       3) „Endpunkt:"     → Punkt (setzt Endwinkel a1; Radius bleibt) → commit
//   • 3-Punkt: Start + Durchgangspunkt + Ende (derselbe Klick-Ablauf wie der
//     Bogen-Modus beim Polylinien-Zeichnen, s. `polyline.ts` `pendingThrough`).
//       1) „Startpunkt:"        → Punkt
//       2) „Durchgangspunkt:"   → Punkt (nur Vorschau-Linie, noch kein Bogen)
//       3) „Endpunkt:"          → Punkt → commit (Kreis durch alle drei Punkte,
//          s. `geometry/bulge.ts` `arcThroughPoints`)
//   • Start-Ende-Radius: Start + Ende + Radius (getippt ODER als Punkt — Abstand
//     von der Sehnen-Mitte, wie bei `fillet.ts`s Radius-Schritt). Der Bogen
//     wölbt sich zur Seite, auf der der Cursor/Radius-Punkt steht (immer der
//     kleinere der beiden möglichen Bögen, s. `arcFromStartEndRadius`).
//       1) „Startpunkt:"  → Punkt
//       2) „Endpunkt:"    → Punkt
//       3) „Radius:"      → Punkt ODER Zahl → commit
//   • Start-Ende-Richtung: Start + Ende + Tangentenrichtung bei Start (klassische
//     dritte AutoCAD-ARC-Methode). Eindeutig bestimmt (kein Seiten-Wahl nötig),
//     s. `arcFromStartEndDirection`.
//       1) „Startpunkt:"        → Punkt
//       2) „Endpunkt:"          → Punkt
//       3) „Richtung:"          → Punkt (Tangentenrichtung bei Start) → commit
//
// Der Bogen läuft CCW von a0 nach a1 (wie DXF-ARC und das `{shape:"arc"}`-
// Rendering in PlanView). In generatePlan/PlanView als glatter SVG-Bogen
// (`drawingArc`) gerendert.

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import { arcFromStartEndDirection, arcFromStartEndRadius, arcThroughPoints } from "../../core";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";
import type { TranslationKey } from "../../i18n";

const EPS = 1e-6;

/** Konstruktionsmethode. */
type ArcMethod = "center" | "three" | "ser" | "sed";
const METHOD_ORDER: ArcMethod[] = ["center", "three", "ser", "sed"];
const nextMethod = (m: ArcMethod): ArcMethod =>
  METHOD_ORDER[(METHOD_ORDER.indexOf(m) + 1) % METHOD_ORDER.length];
const methodValue = (m: ArcMethod): string =>
  m === "center" ? "center" : m === "three" ? "3pt" : m === "ser" ? "radius" : "direction";
const RADIUS_FIELDS: CommandField[] = [{ id: "radius", labelKey: "cmd.field.radius" }];

/** Umschalt-Option für die Methode (im Feld-Row sichtbar, tippbar als „m"). */
const methodOption = (m: ArcMethod): CmdOption => ({
  id: "method",
  labelKey: "cmd.arc.method",
  value: methodValue(m),
});

// ── Zustand ──────────────────────────────────────────────────────────────────

interface ArcCenterPhase1 extends CommandState {
  phase: "center";
  method: "center";
}
interface ArcCenterPhase2 extends CommandState {
  phase: "start";
  method: "center";
  center: Vec2;
  cursor: Vec2 | null;
}
interface ArcCenterPhase3 extends CommandState {
  phase: "end";
  method: "center";
  center: Vec2;
  r: number;
  a0: number;
  cursor: Vec2 | null;
}
interface ArcThreePhase1 extends CommandState {
  phase: "p1";
  method: "three";
}
interface ArcThreePhase2 extends CommandState {
  phase: "p2";
  method: "three";
  a: Vec2;
  cursor: Vec2 | null;
}
interface ArcThreePhase3 extends CommandState {
  phase: "p3";
  method: "three";
  a: Vec2;
  through: Vec2;
  cursor: Vec2 | null;
}
interface ArcSerPhase1 extends CommandState {
  phase: "p1";
  method: "ser";
}
interface ArcSerPhase2 extends CommandState {
  phase: "p2";
  method: "ser";
  a: Vec2;
  cursor: Vec2 | null;
}
interface ArcSerPhase3 extends CommandState {
  phase: "radius";
  method: "ser";
  a: Vec2;
  b: Vec2;
  cursor: Vec2 | null;
}
interface ArcSedPhase1 extends CommandState {
  phase: "p1";
  method: "sed";
}
interface ArcSedPhase2 extends CommandState {
  phase: "p2";
  method: "sed";
  a: Vec2;
  cursor: Vec2 | null;
}
interface ArcSedPhase3 extends CommandState {
  phase: "direction";
  method: "sed";
  a: Vec2;
  b: Vec2;
  cursor: Vec2 | null;
}
type ArcState =
  | ArcCenterPhase1
  | ArcCenterPhase2
  | ArcCenterPhase3
  | ArcSerPhase1
  | ArcSerPhase2
  | ArcSerPhase3
  | ArcSedPhase1
  | ArcSedPhase2
  | ArcSedPhase3
  | ArcThreePhase1
  | ArcThreePhase2
  | ArcThreePhase3;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const angle = (c: Vec2, p: Vec2): number => Math.atan2(p.y - c.y, p.x - c.x);
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

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

/** Platzhalter-Vorschau (gerade Linie) für Zwischenschritte ohne vollständigen Bogen. */
function lineDraft(a: Vec2, b: Vec2): ToolDraft {
  return { preview: [{ kind: "line", a, b }], vertices: [a] };
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

const idle = (method: ArcMethod): [CommandState, CommandResult] => [
  (method === "center" ? { phase: "center", method } : { phase: "p1", method }) as ArcState,
  { draft: null, done: true },
];

function promptKey(s: ArcState): TranslationKey {
  if (s.method === "center") {
    return s.phase === "start" ? "cmd.arc.start" : s.phase === "end" ? "cmd.arc.end" : "cmd.arc.center";
  }
  if (s.method === "ser") {
    return s.phase === "p2" ? "cmd.arc.serEnd" : s.phase === "radius" ? "cmd.arc.radius" : "cmd.arc.serStart";
  }
  if (s.method === "sed") {
    return s.phase === "p2" ? "cmd.arc.sedEnd" : s.phase === "direction" ? "cmd.arc.direction" : "cmd.arc.sedStart";
  }
  return s.phase === "p2" ? "cmd.arc.through" : s.phase === "p3" ? "cmd.arc.threeEnd" : "cmd.arc.threeStart";
}

export const arcCommand: Command = {
  name: "arc",
  labelKey: "cmd.arc.label",
  prompt: (s) => promptKey(s as ArcState),
  accepts: (s) => {
    const st = s as ArcState;
    return st.method === "ser" && st.phase === "radius" ? ["point", "option", "number"] : ["point", "option"];
  },
  options: (s) => [methodOption((s as ArcState).method)],
  fields: (s) => {
    const st = s as ArcState;
    return st.method === "ser" && st.phase === "radius" ? RADIUS_FIELDS : [];
  },
  init: (): ArcCenterPhase1 => ({ phase: "center", method: "center", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ArcState;

    if (input.kind === "option") {
      if (input.id === "method") {
        // Methode zyklisch umschalten; laufende Konstruktion verwerfen und den
        // Befehl AKTIV lassen (kein done) — nur zum ersten Schritt zurück.
        const m = nextMethod(s.method);
        const [ns] = idle(m);
        return [ns, { draft: null }];
      }
      return [s, { draft: null }];
    }
    // Getippter Radius (Methode „ser", Schritt „radius"): Seite kommt vom
    // zuletzt bekannten Cursor (wie beim Tab-Feld-Controller sonst auch).
    if (input.kind === "number" && s.method === "ser" && s.phase === "radius") {
      const near = s.cursor ?? { x: s.b.x, y: s.b.y };
      const arc = arcFromStartEndRadius(s.a, s.b, input.value, near);
      if (!arc) return [s, { draft: null }];
      return [
        idle("ser")[0],
        { draft: null, done: true, commit: (p) => appendArc(p, arc.center, arc.r, arc.a0, arc.a1, ctx) },
      ];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;

    if (s.method === "center") {
      if (s.phase === "center") {
        const ns: ArcCenterPhase2 = { phase: "start", method: "center", center: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: { preview: [], vertices: [pt] } }];
      }
      if (s.phase === "start") {
        const r = dist(s.center, pt);
        if (r < EPS) return [s, { draft: null }];
        const a0 = angle(s.center, pt);
        const ns: ArcCenterPhase3 = { phase: "end", method: "center", center: s.center, r, a0, cursor: pt, lastPoint: pt };
        return [ns, { draft: arcDraft(s.center, r, a0, a0, pt) }];
      }
      // Endpunkt: Endwinkel setzen, Bogen committen.
      const a1 = angle(s.center, pt);
      const { center, r, a0 } = s;
      return [
        idle("center")[0],
        { draft: null, done: true, commit: (p) => appendArc(p, center, r, a0, a1, ctx) },
      ];
    }

    // Methode „three".
    if (s.method === "three") {
      if (s.phase === "p1") {
        const ns: ArcThreePhase2 = { phase: "p2", method: "three", a: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: { preview: [], vertices: [pt] } }];
      }
      if (s.phase === "p2") {
        if (dist(s.a, pt) < EPS) return [s, { draft: null }];
        const ns: ArcThreePhase3 = { phase: "p3", method: "three", a: s.a, through: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: lineDraft(s.a, pt) }];
      }
      // phase "p3": Endpunkt → Kreis durch alle drei Punkte, committen.
      const arc = arcThroughPoints(s.a, s.through, pt);
      if (!arc) return [s, { draft: lineDraft(s.a, pt) }]; // kollinear — Punkt ignorieren, weiter warten
      return [
        idle("three")[0],
        { draft: null, done: true, commit: (p) => appendArc(p, arc.center, arc.r, arc.a0, arc.a1, ctx) },
      ];
    }

    // Methode „ser" (Start-Ende-Radius).
    if (s.method === "ser") {
      if (s.phase === "p1") {
        const ns: ArcSerPhase2 = { phase: "p2", method: "ser", a: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: { preview: [], vertices: [pt] } }];
      }
      if (s.phase === "p2") {
        if (dist(s.a, pt) < EPS) return [s, { draft: null }];
        const ns: ArcSerPhase3 = { phase: "radius", method: "ser", a: s.a, b: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: lineDraft(s.a, pt) }];
      }
      // phase "radius": Radius-Punkt → committen (Seite = dieser Punkt).
      const arc = arcFromStartEndRadius(s.a, s.b, dist(mid(s.a, s.b), pt), pt);
      if (!arc) return [s, { draft: lineDraft(s.a, s.b) }]; // Radius zu klein — weiter warten
      return [
        idle("ser")[0],
        { draft: null, done: true, commit: (p) => appendArc(p, arc.center, arc.r, arc.a0, arc.a1, ctx) },
      ];
    }

    // Methode „sed" (Start-Ende-Richtung).
    if (s.phase === "p1") {
      const ns: ArcSedPhase2 = { phase: "p2", method: "sed", a: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: { preview: [], vertices: [pt] } }];
    }
    if (s.phase === "p2") {
      if (dist(s.a, pt) < EPS) return [s, { draft: null }];
      const ns: ArcSedPhase3 = { phase: "direction", method: "sed", a: s.a, b: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: lineDraft(s.a, pt) }];
    }
    // phase "direction": Richtungspunkt → committen.
    const sedArc = arcFromStartEndDirection(s.a, s.b, pt);
    if (!sedArc) return [s, { draft: lineDraft(s.a, s.b) }]; // entartete Richtung — weiter warten
    return [
      idle("sed")[0],
      { draft: null, done: true, commit: (p) => appendArc(p, sedArc.center, sedArc.r, sedArc.a0, sedArc.a1, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as ArcState;
    if (s.method === "center") {
      if (s.phase === "start") {
        const r = dist(s.center, point);
        const ns: ArcCenterPhase2 = { ...s, cursor: point };
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
        const ns: ArcCenterPhase3 = { ...s, cursor: point };
        return [ns, { draft: arcDraft(s.center, s.r, s.a0, a1, point) }];
      }
      return [s, { draft: null }];
    }
    if (s.phase === "p2") {
      // Erster Punkt gesetzt, zweiter folgt dem Cursor — identisch für alle
      // drei Zwei-Endpunkt-Methoden (three/ser/sed).
      const ns = { ...s, cursor: point } as ArcState;
      return [ns, { draft: lineDraft(s.a, point) }];
    }
    if (s.phase === "p3") {
      const ns: ArcThreePhase3 = { ...s, cursor: point };
      const arc = arcThroughPoints(s.a, s.through, point);
      return [ns, { draft: arc ? arcDraft(arc.center, arc.r, arc.a0, arc.a1, point) : lineDraft(s.a, point) }];
    }
    if (s.phase === "radius") {
      const ns: ArcSerPhase3 = { ...s, cursor: point };
      const arc = arcFromStartEndRadius(s.a, s.b, dist(mid(s.a, s.b), point), point);
      return [ns, { draft: arc ? arcDraft(arc.center, arc.r, arc.a0, arc.a1, point) : lineDraft(s.a, s.b) }];
    }
    if (s.phase === "direction") {
      const ns: ArcSedPhase3 = { ...s, cursor: point };
      const arc = arcFromStartEndDirection(s.a, s.b, point);
      return [ns, { draft: arc ? arcDraft(arc.center, arc.r, arc.a0, arc.a1, point) : lineDraft(s.a, s.b) }];
    }
    return [s, { draft: null }];
  },

  onConfirm: (state): [CommandState, CommandResult] => idle((state as ArcState).method),
  onCancel: (state): [CommandState, CommandResult] => idle((state as ArcState).method),

  // Tab-Feld-Zyklus nur im „radius"-Schritt der „ser"-Methode (ein
  // Radius-Feld), analog `fillet.ts`: der gelockte Wert bestimmt den Punkt
  // auf dem Strahl Sehnenmitte→Cursor (bzw. →+X ohne Cursor).
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as ArcState;
    if (s.method !== "ser" || s.phase !== "radius" || !cursor) return {};
    return { radius: dist(mid(s.a, s.b), cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as ArcState;
    if (s.method !== "ser" || s.phase !== "radius") return null;
    const m = mid(s.a, s.b);
    const r = "radius" in locks ? Math.max(0, locks.radius) : cursor ? dist(m, cursor) : 0;
    if (cursor) {
      const d = dist(m, cursor);
      if (d > EPS) {
        return { x: m.x + ((cursor.x - m.x) / d) * r, y: m.y + ((cursor.y - m.y) / d) * r };
      }
    }
    return { x: m.x + r, y: m.y };
  },
};
