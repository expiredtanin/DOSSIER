// Scale — skaliert die AKTUELLE Auswahl gleichmässig um einen frei gewählten
// Basispunkt. Schritte (AutoCAD-SCALE-Muster inkl. Referenz-Variante):
//   1) „Basispunkt:"     → Punkt (bleibt fix)
//   2) „Faktor:"         → ZAHL  ⇒ sofort skalieren und fertig
//                          ODER Punkt ⇒ Referenzlänge, weiter mit 3)
//   3) „Neue Länge:"     → Punkt (Live-Vorschau) → commit
//
// Die Referenz-Variante ist der Grund, warum es den Befehl braucht: „diese
// Kante soll so lang werden wie jene" lässt sich ohne Rechnen abgreifen.
//
// WICHTIG — was mitskaliert: 2D-Geometrie inklusive Radien, Schrifthöhen und
// Bemassungs-Abstand (s. `tools/transform.ts::scaleGeom`). Bei Wänden/Stützen
// skalieren nur LAGE und Achslänge; die Dicke bzw. das Profil steckt im
// jeweiligen Typ (geteilte Ressource) und bliebe sonst für ALLE Elemente
// desselben Typs verändert — bewusste Grenze, s. PENDENZEN.md.

import {
  commitTransform,
  hasTransformSelection,
  toTransformSel,
  transformPreview,
} from "../../tools/transform";
import type {
  Command,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const EPS = 1e-6;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Punkte-Tripel für `transformFn("scale", …)`: Basispunkt, Referenzpunkt,
 * Zielpunkt. Für einen GETIPPTEN Faktor werden Referenz (1 Einheit rechts) und
 * Ziel (f Einheiten rechts) synthetisch erzeugt.
 */
function scalePts(base: Vec2, factor: number): Vec2[] {
  return [base, { x: base.x + 1, y: base.y }, { x: base.x + factor, y: base.y }];
}

interface ScBase extends CommandState {
  phase: "base";
}
interface ScFactor extends CommandState {
  phase: "factor";
  sel: CommandSelection;
  base: Vec2;
}
interface ScTarget extends CommandState {
  phase: "target";
  sel: CommandSelection;
  base: Vec2;
  ref: Vec2;
  cursor: Vec2 | null;
}
interface ScDone extends CommandState {
  phase: "done";
}
type ScState = ScBase | ScFactor | ScTarget | ScDone;

function scDraft(project: Project, sel: CommandSelection, pts: Vec2[], f: number): ToolDraft {
  const preview = transformPreview(project, toTransformSel(sel), "scale", pts, "move", 1);
  const base = pts[0];
  return {
    preview: [...preview, { kind: "line", a: base, b: pts[2] }],
    vertices: [base],
    hud: { at: pts[2], text: `×${f.toFixed(3)}` },
  };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ScDone,
  { draft: null, done: true },
];

export const scaleCommand: Command = {
  name: "scale",
  labelKey: "cmd.scale.label",
  prompt: (s) => {
    const ss = s as ScState;
    if (ss.phase === "factor") return "cmd.scale.factor";
    if (ss.phase === "target") return "cmd.scale.target";
    if (ss.phase === "done") return "cmd.scale.empty";
    return "cmd.scale.base";
  },
  accepts: (s) => ((s as ScState).phase === "factor" ? ["point", "number"] : ["point"]),
  options: () => [],

  init: (): ScBase => ({ phase: "base", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ScState;
    if (s.phase === "done") return idle();
    if (!hasTransformSelection(ctx.selection)) {
      return [{ phase: "done", lastPoint: null } as ScDone, { draft: null, done: true }];
    }

    // Getippter Faktor: sofort skalieren. 0/negativ ist keine sinnvolle
    // Skalierung (Objekt verschwände bzw. klappte um) — ignoriert.
    if (input.kind === "number" && s.phase === "factor") {
      if (input.value <= EPS) return [s, { draft: null }];
      const { base, sel } = s;
      const pts = scalePts(base, input.value);
      return [
        { phase: "done", lastPoint: null } as ScDone,
        {
          draft: null,
          done: true,
          commit: (p) => commitTransform(p, toTransformSel(sel), "scale", pts, "move", 1),
        },
      ];
    }

    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;

    if (s.phase === "base") {
      const next: ScFactor = { phase: "factor", sel: ctx.selection, base: pt, lastPoint: pt };
      return [next, { draft: null }];
    }

    if (s.phase === "factor") {
      // Referenzlänge; ohne Länge (Klick auf den Basispunkt) ignorieren.
      if (segLen(s.base, pt) < EPS) return [s, { draft: null }];
      const next: ScTarget = {
        phase: "target",
        sel: s.sel,
        base: s.base,
        ref: pt,
        cursor: pt,
        lastPoint: pt,
      };
      return [next, { draft: scDraft(ctx.project, s.sel, [s.base, pt, pt], 1) }];
    }

    // Neue Länge → commit.
    if (segLen(s.base, pt) < EPS) return [s, { draft: null }];
    const { base, ref, sel } = s;
    return [
      { phase: "done", lastPoint: null } as ScDone,
      {
        draft: null,
        done: true,
        commit: (p) => commitTransform(p, toTransformSel(sel), "scale", [base, ref, pt], "move", 1),
      },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ScState;
    if (s.phase !== "target") return [s, { draft: null }];
    const ns: ScTarget = { ...s, cursor: point };
    const refLen = segLen(s.base, s.ref);
    if (refLen < EPS) return [ns, { draft: null }];
    const f = segLen(s.base, point) / refLen;
    return [ns, { draft: scDraft(ctx.project, s.sel, [s.base, s.ref, point], f) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
