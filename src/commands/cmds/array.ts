// Array (Feld) — dupliziert die AKTUELLE Auswahl `count`-mal, in EINER Geste
// (baut auf dem bestehenden Transform-Modus `"array"` auf, der bisher nie
// über einen Befehl erreichbar war — s. `tools/transform.ts::copyTs`). Zwei
// Konstruktionsarten, wählbar über die Option „Art" (klickbar im Feld-Row,
// tippbar als „t" — Buchstabe „a" ist bereits Angebot für den Winkel-
// Tab-Feld-Zyklus belegt, zyklisch wie bei `rect.ts`/`arc.ts`):
//
//   • Linear (Default, unverändert): Basispunkt → Zielpunkt (Vektor + Länge),
//     `count` Kopien in gleichem Abstand entlang dieses Vektors.
//       1) „Basispunkt:"           → Punkt
//       2) „Zielpunkt ( Anzahl ):" → Punkt/Zahl (Tab length/angle) → commit
//   • Polar (Nutzer-Wunsch: „Array kennt nur linear, kein Polar-/Pfad-
//     Modus"): Zentrum → Winkel PRO Kopie (Punkt-Richtung relativ zum
//     Zentrum ODER getippter Winkel), `count` Kopien gleichmässig um das
//     Zentrum verteilt (op:"rotate" statt op:"move" im selben `mode:"array"`
//     — braucht KEINE Änderung an `tools/transform.ts`, dessen `transformFn`/
//     `copyTs` das für op:"rotate" bereits als „Kopie k um k·Winkel drehen"
//     abbilden, exakt der Polar-Array-Mechanismus).
//       1) „Zentrum:"                    → Punkt
//       2) „Winkel je Kopie ( Anzahl ):" → Punkt/Zahl (Tab angle) → commit
//
// Die Auswahl kommt vorab über ctx.selection (erst selektieren, dann Befehl,
// wie move/copy). Leere Auswahl → No-op.

import {
  transformMutation,
  hasTransformSelection,
  toTransformSel,
  transformPreview,
} from "../../tools/transform";
import type {
  CmdOption,
  Command,
  CommandField,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
  ToolDraft,
  Vec2,
} from "../types";
import type { TranslationKey } from "../../i18n";

const DEG = Math.PI / 180;
const MIN_COUNT = 2;
const MAX_COUNT = 12;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Konstruktionsart. */
type ArrayKind = "linear" | "polar";
const KIND_ORDER: ArrayKind[] = ["linear", "polar"];
const nextKind = (k: ArrayKind): ArrayKind => KIND_ORDER[(KIND_ORDER.indexOf(k) + 1) % KIND_ORDER.length];

/** Persistente Anzahl/Art über Aufrufe hinweg (wie `lastCount` bei Multiline). */
let lastCount = 3;
let lastKind: ArrayKind = "linear";

const ARRAY_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];
const POLAR_FIELDS: CommandField[] = [{ id: "angle", labelKey: "cmd.field.angle" }];
const COUNT_OPTION: CmdOption = { id: "count", labelKey: "cmd.array.count" };
const KIND_OPTION = (k: ArrayKind): CmdOption => ({
  id: "kind",
  labelKey: "cmd.array.kind",
  value: k === "linear" ? "lin" : "polar",
});

function targetFromFields(base: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? base;
  const length = "length" in locks ? locks.length : segLen(base, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(base, ref);
  const ang = angleDeg * DEG;
  return { x: base.x + Math.cos(ang) * length, y: base.y + Math.sin(ang) * length };
}

/**
 * Referenz-/Zielpunkte für `transformFn("rotate", …)` aus Zentrum + Winkel
 * PRO KOPIE (Grad): Referenz = synthetische +X-Achse (dieselbe Konvention wie
 * `rotate.ts` `rotatePts` bei getipptem Winkel), Ziel = Zentrum + dieser
 * Winkel — `copyTs`/`transformFn` drehen Kopie k dann um k·Winkel.
 */
function polarPts(center: Vec2, degPerCopy: number): Vec2[] {
  const a = degPerCopy * DEG;
  return [
    center,
    { x: center.x + 1, y: center.y },
    { x: center.x + Math.cos(a), y: center.y + Math.sin(a) },
  ];
}

interface ArrBase extends CommandState {
  phase: "base";
  kind: ArrayKind;
}
interface ArrTarget extends CommandState {
  phase: "target";
  kind: ArrayKind;
  sel: CommandSelection;
  base: Vec2;
  cursor: Vec2 | null;
}
type ArrState = ArrBase | ArrTarget;

/** Vorschau ALLER `lastCount` Kopien bei der aktuellen Cursor-Lage (linear). */
function linearDraft(project: Project, sel: CommandSelection, base: Vec2, target: Vec2): ToolDraft {
  const preview = transformPreview(project, toTransformSel(sel), "move", [base, target], "array", lastCount);
  return {
    preview,
    vertices: [base],
    hud: { at: target, text: `${segLen(base, target).toFixed(2)} m × ${lastCount}` },
  };
}

/** Vorschau ALLER `lastCount` Kopien bei der aktuellen Cursor-Lage (polar). */
function polarDraft(project: Project, sel: CommandSelection, center: Vec2, cursor: Vec2): ToolDraft {
  const degPerCopy = segAngleDeg(center, cursor);
  const pts = polarPts(center, degPerCopy);
  const preview = transformPreview(project, toTransformSel(sel), "rotate", pts, "array", lastCount);
  const total = Math.abs(degPerCopy * (lastCount - 1));
  return {
    preview,
    vertices: [center],
    hud: { at: cursor, text: `${degPerCopy.toFixed(1)}° × ${lastCount} (${total.toFixed(1)}° total)` },
  };
}

const idle = (kind: ArrayKind): [CommandState, CommandResult] => [
  { phase: "base", lastPoint: null, kind } as ArrBase,
  { draft: null, done: true },
];

function promptKey(s: ArrState): TranslationKey {
  if (s.phase !== "target") return s.kind === "polar" ? "cmd.array.center" : "cmd.array.base";
  return s.kind === "polar" ? "cmd.array.polarAngle" : "cmd.array.target";
}

export const arrayCommand: Command = {
  name: "array",
  labelKey: "cmd.array.label",
  prompt: (s) => promptKey(s as ArrState),
  accepts: (s) => ((s as ArrState).phase === "target" ? ["point", "number", "option"] : ["point", "option"]),
  options: (s) => {
    const st = s as ArrState;
    const base = [KIND_OPTION(st.kind)];
    return st.phase === "target" ? [...base, { ...COUNT_OPTION, value: String(lastCount) }] : base;
  },
  init: (): ArrBase => ({ phase: "base", lastPoint: null, kind: lastKind }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ArrState;

    if (input.kind === "option") {
      if (input.id === "kind") {
        lastKind = nextKind(s.kind);
        return idle(lastKind);
      }
      if (input.id === "count" && s.phase === "target") {
        lastCount = lastCount >= MAX_COUNT ? MIN_COUNT : lastCount + 1;
        const draft = s.cursor
          ? s.kind === "polar"
            ? polarDraft(ctx.project, s.sel, s.base, s.cursor)
            : linearDraft(ctx.project, s.sel, s.base, s.cursor)
          : null;
        return [s, { draft }];
      }
      return [s, { draft: null }];
    }

    if (!hasTransformSelection(ctx.selection)) return idle(s.kind);

    if (s.phase !== "target") {
      if (input.kind !== "point") return [s, { draft: null }];
      const next: ArrTarget = {
        phase: "target",
        kind: s.kind,
        sel: ctx.selection,
        base: input.point,
        cursor: input.point,
        lastPoint: input.point,
      };
      return [next, { draft: { preview: [], vertices: [input.point] } }];
    }

    let target: Vec2 | null = null;
    if (input.kind === "point") target = input.point;
    else if (input.kind === "number") {
      target =
        s.kind === "polar"
          ? { x: s.base.x + Math.cos(input.value * DEG), y: s.base.y + Math.sin(input.value * DEG) }
          : { x: s.base.x + input.value, y: s.base.y };
    }
    if (!target || segLen(s.base, target) < 1e-6) return idle(s.kind);

    const { base, sel, kind } = s;
    const op = kind === "polar" ? "rotate" : "move";
    const pts = kind === "polar" ? polarPts(base, segAngleDeg(base, target)) : [base, target];
    return [
      idle(kind)[0],
      { draft: null, done: true, commit: transformMutation(toTransformSel(sel), op, pts, "array", lastCount) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ArrState;
    if (s.phase !== "target") return [s, { draft: null }];
    const ns: ArrTarget = { ...s, cursor: point };
    return [ns, { draft: s.kind === "polar" ? polarDraft(ctx.project, s.sel, s.base, point) : linearDraft(ctx.project, s.sel, s.base, point) }];
  },

  onConfirm: (state): [CommandState, CommandResult] => idle((state as ArrState).kind),
  onCancel: (state): [CommandState, CommandResult] => idle((state as ArrState).kind),

  fields: (state) => {
    const s = state as ArrState;
    if (s.phase !== "target") return [];
    return s.kind === "polar" ? POLAR_FIELDS : ARRAY_FIELDS;
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as ArrState;
    if (s.phase !== "target") return null;
    if (s.kind === "polar") {
      const deg = "angle" in locks ? locks.angle : cursor ? segAngleDeg(s.base, cursor) : 0;
      const a = deg * DEG;
      return { x: s.base.x + Math.cos(a), y: s.base.y + Math.sin(a) };
    }
    return targetFromFields(s.base, locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as ArrState;
    if (s.phase !== "target" || !cursor) return {};
    if (s.kind === "polar") {
      return { angle: ((segAngleDeg(s.base, cursor) % 360) + 360) % 360 };
    }
    return {
      length: segLen(s.base, cursor),
      angle: ((segAngleDeg(s.base, cursor) % 360) + 360) % 360,
    };
  },
};
