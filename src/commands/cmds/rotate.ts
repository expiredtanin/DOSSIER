// Rotate — dreht die AKTUELLE Auswahl um einen frei gewählten Drehpunkt.
// Schritte (AutoCAD-ROTATE-Muster, inkl. Referenz-Variante):
//   1) „Drehpunkt:"      → Punkt
//   2) „Winkel:"         → ZAHL (Grad) ⇒ sofort drehen und fertig
//                          ODER Punkt  ⇒ Referenzrichtung, weiter mit 3)
//   3) „Neue Richtung:"  → Punkt (Live-Vorschau) → commit
//
// Der getippte Winkel ist der schnelle Normalfall; die Zwei-Punkt-Variante ist
// die „Referenz"-Eingabe (etwas an einer vorhandenen Kante ausrichten, ohne
// deren Winkel zu kennen).
//
// Die Auswahl kommt vorab über `ctx.selection` (erst selektieren, dann Befehl —
// wie Move/Copy/Mirror). Gedreht wird über den bestehenden, getesteten
// `transformMutation` (op:"rotate", mode:"move") — er bewegt das ORIGINAL, es
// entsteht keine Kopie.

import {
  transformMutation,
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
const DEG = Math.PI / 180;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const angleDeg = (c: Vec2, p: Vec2): number => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;


/**
 * Punkte-Tripel für `transformFn("rotate", …)`: Drehpunkt, Referenzrichtung,
 * Zielrichtung. Für einen GETIPPTEN Winkel werden Referenz (+X-Achse) und Ziel
 * synthetisch erzeugt — der Drehwinkel ist dann genau der eingegebene.
 */
function rotatePts(center: Vec2, deg: number): Vec2[] {
  const a = deg * DEG;
  return [
    center,
    { x: center.x + 1, y: center.y },
    { x: center.x + Math.cos(a), y: center.y + Math.sin(a) },
  ];
}

interface RotBase extends CommandState {
  phase: "base";
}
interface RotAngle extends CommandState {
  phase: "angle";
  sel: CommandSelection;
  center: Vec2;
  cursor: Vec2 | null;
}
interface RotTarget extends CommandState {
  phase: "target";
  sel: CommandSelection;
  center: Vec2;
  ref: Vec2;
  cursor: Vec2 | null;
}
interface RotDone extends CommandState {
  phase: "done";
}
type RotState = RotBase | RotAngle | RotTarget | RotDone;

/** Live-Vorschau: gedrehte Auswahl + Drehpunkt/Schenkel als Hilfsgeometrie. */
function rotDraft(
  project: Project,
  sel: CommandSelection,
  pts: Vec2[],
  deg: number,
  legs: Vec2[],
): ToolDraft {
  const preview = transformPreview(project, toTransformSel(sel), "rotate", pts, "move", 1);
  const center = pts[0];
  return {
    preview: [...preview, ...legs.map((p) => ({ kind: "line" as const, a: center, b: p }))],
    vertices: [center],
    hud: { at: legs[legs.length - 1] ?? center, text: `${(((deg % 360) + 360) % 360).toFixed(1)}°` },
  };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as RotDone,
  { draft: null, done: true },
];

export const rotateCommand: Command = {
  name: "rotate",
  labelKey: "cmd.rotate.label",
  prompt: (s) => {
    const rs = s as RotState;
    if (rs.phase === "angle") return "cmd.rotate.angle";
    if (rs.phase === "target") return "cmd.rotate.target";
    if (rs.phase === "done") return "cmd.rotate.empty";
    return "cmd.rotate.base";
  },
  // Im Winkel-Schritt sind BEIDE Eingaben gültig: getippte Grad oder ein Punkt.
  accepts: (s) => ((s as RotState).phase === "angle" ? ["point", "number"] : ["point"]),
  options: () => [],

  init: (): RotBase => ({ phase: "base", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RotState;
    if (s.phase === "done") return idle();
    if (!hasTransformSelection(ctx.selection)) {
      return [{ phase: "done", lastPoint: null } as RotDone, { draft: null, done: true }];
    }

    // Getippter Winkel (nur im Winkel-Schritt): sofort drehen.
    if (input.kind === "number" && s.phase === "angle") {
      const { center, sel } = s;
      const pts = rotatePts(center, input.value);
      return [
        { phase: "done", lastPoint: null } as RotDone,
        {
          draft: null,
          done: true,
          commit: transformMutation(toTransformSel(sel), "rotate", pts, "move", 1),
        },
      ];
    }

    if (input.kind !== "point") return [s, { draft: null }];
    const pt = input.point;

    if (s.phase === "base") {
      const next: RotAngle = {
        phase: "angle",
        sel: ctx.selection,
        center: pt,
        cursor: pt,
        lastPoint: pt,
      };
      return [next, { draft: null }];
    }

    if (s.phase === "angle") {
      // Punkt statt Zahl ⇒ Referenzrichtung; ohne echte Richtung ignorieren.
      if (segLen(s.center, pt) < EPS) return [s, { draft: null }];
      const next: RotTarget = {
        phase: "target",
        sel: s.sel,
        center: s.center,
        ref: pt,
        cursor: pt,
        lastPoint: pt,
      };
      return [next, { draft: rotDraft(ctx.project, s.sel, rotatePts(s.center, 0), 0, [pt]) }];
    }

    // Zielrichtung → commit.
    if (segLen(s.center, pt) < EPS) return [s, { draft: null }];
    const { center, ref, sel } = s;
    return [
      { phase: "done", lastPoint: null } as RotDone,
      {
        draft: null,
        done: true,
        commit: transformMutation(toTransformSel(sel), "rotate", [center, ref, pt], "move", 1),
      },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as RotState;
    if (s.phase === "angle") {
      // Noch keine Referenz: Vorschau gegen die +X-Achse (= getippter Winkel).
      const deg = angleDeg(s.center, point);
      const ns: RotAngle = { ...s, cursor: point };
      if (segLen(s.center, point) < EPS) return [ns, { draft: null }];
      return [
        ns,
        { draft: rotDraft(ctx.project, s.sel, rotatePts(s.center, deg), deg, [point]) },
      ];
    }
    if (s.phase === "target") {
      const ns: RotTarget = { ...s, cursor: point };
      if (segLen(s.center, point) < EPS) return [ns, { draft: null }];
      const deg = angleDeg(s.center, point) - angleDeg(s.center, s.ref);
      return [
        ns,
        {
          draft: rotDraft(ctx.project, s.sel, [s.center, s.ref, point], deg, [s.ref, point]),
        },
      ];
    }
    return [s, { draft: null }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
