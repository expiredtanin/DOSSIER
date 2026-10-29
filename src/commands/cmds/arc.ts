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
//          s. `kernel2d::arc_through_points`, Kern `cmd_draw.rs`)
//   • Start-Ende-Radius: Start + Ende + Radius (getippt ODER als Punkt — Abstand
//     von der Sehnen-Mitte, wie bei `fillet.ts`s Radius-Schritt). Der Bogen
//     wölbt sich zur Seite, auf der der Cursor/Radius-Punkt steht (immer der
//     kleinere der beiden möglichen Bögen, s. `kernel2d::arc_from_start_end_radius`).
//       1) „Startpunkt:"  → Punkt
//       2) „Endpunkt:"    → Punkt
//       3) „Radius:"      → Punkt ODER Zahl → commit
//   • Start-Ende-Richtung: Start + Ende + Tangentenrichtung bei Start (klassische
//     dritte AutoCAD-ARC-Methode). Eindeutig bestimmt (kein Seiten-Wahl nötig),
//     s. `kernel2d::arc_from_start_end_direction`.
//       1) „Startpunkt:"        → Punkt
//       2) „Endpunkt:"          → Punkt
//       3) „Richtung:"          → Punkt (Tangentenrichtung bei Start) → commit
//
// Der Bogen läuft CCW von a0 nach a1 (wie DXF-ARC und das `{shape:"arc"}`-
// Rendering in PlanView). In generatePlan/PlanView als glatter SVG-Bogen
// (`drawingArc`) gerendert.

import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  CmdOption,
  ToolDraft,
  Vec2,
} from "../types";
import type { TranslationKey } from "../../i18n";
import { createMutation, createPreview, type CreatePreview } from "../createCore";

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
  /** Startpunkt (setzt Radius und Startwinkel). */
  start: Vec2;
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
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Bogen im Kern (`cmd_draw.rs`) je Methode aus den Punkten: Mittelpunkt (Mitte, Start, Ende), 3-Punkt,
 * Start-Ende-Radius (Radius = Abstand des dritten Punkts von der Sehnenmitte oder getippt),
 * Start-Ende-Richtung; `ok` = bestimmt, `info = [cx, cy, r, Spanne°]`. `full`: voller Kreis um den
 * Mittelpunkt durch den Cursor (Radius-Vorschau im „start"-Schritt).
 */
const arcAt = (ctx: CommandContext, req: Record<string, unknown>, pts: Vec2[]): CreatePreview =>
  createPreview(ctx, { cmd: "arc", ...req }, pts);

/** Vorschau (offener Bogen) + HUD (Radius als L, Spanne als W — L/W-Kästchen). */
function arcDraft(pv: CreatePreview, at: Vec2 | null): ToolDraft {
  const [cx, cy, r, deg] = pv.info;
  const center = { x: cx, y: cy };
  if (r < EPS) return { preview: [], vertices: [center] };
  const draft: ToolDraft = { preview: pv.shapes, vertices: [center] };
  if (at) draft.hud = { at, length: r, angleDeg: deg };
  return draft;
}

/** Platzhalter-Vorschau (gerade Linie) für Zwischenschritte ohne vollständigen Bogen. */
function lineDraft(a: Vec2, b: Vec2): ToolDraft {
  return { preview: [{ kind: "line", a, b }], vertices: [a] };
}

/** Commit (Kern): Bogen aus der Anfrage (entartet r < EPS → nichts). */
const appendArc = (ctx: CommandContext, req: Record<string, unknown>) => createMutation(ctx, { cmd: "arc", ...req });

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
      const req = { method: "ser", pts: [s.a, s.b, near], r: input.value };
      if (!arcAt(ctx, req, [s.a, s.b, near]).ok) return [s, { draft: null }];
      return [idle("ser")[0], { draft: null, done: true, commit: appendArc(ctx, req) }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;

    if (s.method === "center") {
      if (s.phase === "center") {
        const ns: ArcCenterPhase2 = { phase: "start", method: "center", center: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: { preview: [], vertices: [pt] } }];
      }
      if (s.phase === "start") {
        const pv = arcAt(ctx, { method: "center" }, [s.center, pt, pt]);
        if (pv.info[2] < EPS) return [s, { draft: null }];
        const ns: ArcCenterPhase3 = { phase: "end", method: "center", center: s.center, start: pt, cursor: pt, lastPoint: pt };
        return [ns, { draft: arcDraft(pv, pt) }];
      }
      // Endpunkt: Endwinkel setzen, Bogen committen.
      return [
        idle("center")[0],
        { draft: null, done: true, commit: appendArc(ctx, { method: "center", pts: [s.center, s.start, pt] }) },
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
      const req = { method: "three", pts: [s.a, s.through, pt] };
      if (!arcAt(ctx, req, [s.a, s.through, pt]).ok) return [s, { draft: lineDraft(s.a, pt) }]; // kollinear — Punkt ignorieren, weiter warten
      return [idle("three")[0], { draft: null, done: true, commit: appendArc(ctx, req) }];
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
      const req = { method: "ser", pts: [s.a, s.b, pt] };
      if (!arcAt(ctx, req, [s.a, s.b, pt]).ok) return [s, { draft: lineDraft(s.a, s.b) }]; // Radius zu klein — weiter warten
      return [idle("ser")[0], { draft: null, done: true, commit: appendArc(ctx, req) }];
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
    const req = { method: "sed", pts: [s.a, s.b, pt] };
    if (!arcAt(ctx, req, [s.a, s.b, pt]).ok) return [s, { draft: lineDraft(s.a, s.b) }]; // entartete Richtung — weiter warten
    return [idle("sed")[0], { draft: null, done: true, commit: appendArc(ctx, req) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ArcState;
    if (s.method === "center") {
      if (s.phase === "start") {
        const pv = arcAt(ctx, { full: true }, [s.center, point]);
        const ns: ArcCenterPhase2 = { ...s, cursor: point };
        return [
          ns,
          {
            draft: {
              preview: pv.shapes,
              vertices: [s.center],
              hud: { at: point, text: `R: ${pv.info[2].toFixed(3)}m` },
            },
          },
        ];
      }
      if (s.phase === "end") {
        const ns: ArcCenterPhase3 = { ...s, cursor: point };
        return [ns, { draft: arcDraft(arcAt(ctx, { method: "center" }, [s.center, s.start, point]), point) }];
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
      const pv = arcAt(ctx, { method: "three" }, [s.a, s.through, point]);
      return [ns, { draft: pv.ok ? arcDraft(pv, point) : lineDraft(s.a, point) }];
    }
    if (s.phase === "radius") {
      const ns: ArcSerPhase3 = { ...s, cursor: point };
      const pv = arcAt(ctx, { method: "ser" }, [s.a, s.b, point]);
      return [ns, { draft: pv.ok ? arcDraft(pv, point) : lineDraft(s.a, s.b) }];
    }
    if (s.phase === "direction") {
      const ns: ArcSedPhase3 = { ...s, cursor: point };
      const pv = arcAt(ctx, { method: "sed" }, [s.a, s.b, point]);
      return [ns, { draft: pv.ok ? arcDraft(pv, point) : lineDraft(s.a, s.b) }];
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
