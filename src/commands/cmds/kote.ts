// Höhenkote (SIA 400 B.5.4, Figur 18) — Dreieck-Symbol + Höhenwert an einem
// Punkt. Schritte:
//   1) „Punkt:"                     → Punkt (Dreieck-Spitze)
//   2) „Höhenwert ( Art ):"         → Zahl (Meter, z. B. 3.25 oder -0.1) →
//      commit. „Art" (Option, zyklisch: OK fertig/UK fertig/OK roh/UK roh)
//      wechselt VOR dem Tippen die Dreieck-Variante (Default OK fertig).

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  ToolDraft,
  Vec2,
} from "../types";
import type { TranslationKey } from "../../i18n";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

type KoteKind = "okFertig" | "ukFertig" | "okRoh" | "ukRoh";
const KIND_ORDER: KoteKind[] = ["okFertig", "ukFertig", "okRoh", "ukRoh"];
const nextKind = (k: KoteKind): KoteKind => KIND_ORDER[(KIND_ORDER.indexOf(k) + 1) % KIND_ORDER.length];
const KIND_LABEL: Record<KoteKind, TranslationKey> = {
  okFertig: "cmd.kote.kind.okFertig",
  ukFertig: "cmd.kote.kind.ukFertig",
  okRoh: "cmd.kote.kind.okRoh",
  ukRoh: "cmd.kote.kind.ukRoh",
};

const TRI_SIZE = 0.15; // Modell-Meter, Vorschau-Grösse (Rendering: DIM_… in drawing2d.ts)
const HALF_W = TRI_SIZE * 0.6;

/** Dreieck-Punkte für die Vorschau: `at` = Spitze; OK zeigt nach unten, UK nach oben. */
function triPts(at: Vec2, kind: KoteKind): Vec2[] {
  const up = kind === "okFertig" || kind === "okRoh" ? 1 : -1; // Basis liegt in +up-Richtung von `at`
  return [
    at,
    { x: at.x - HALF_W, y: at.y + up * TRI_SIZE },
    { x: at.x + HALF_W, y: at.y + up * TRI_SIZE },
  ];
}

interface KotePoint extends CommandState {
  phase: "point";
}
interface KoteValue extends CommandState {
  phase: "value";
  at: Vec2;
  kind: KoteKind;
}
type KoteState = KotePoint | KoteValue;

function kindOption(kind: KoteKind): CmdOption {
  return { id: "kind", labelKey: KIND_LABEL[kind], value: kind };
}

function valueDraft(at: Vec2, kind: KoteKind): ToolDraft {
  const preview: DraftShape[] = [{ kind: "poly", pts: triPts(at, kind), closed: true }];
  return { preview, vertices: [at] };
}

function appendKote(at: Vec2, value: number, kind: KoteKind, ctx: CommandContext): CoreOp[] {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "kote", at, value, kind, rotation: 0 },
  };
  return addItems("drawings2d", [d]);
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "point", lastPoint: null },
  { draft: null, done: true },
];

export const koteCommand: Command = {
  name: "kote",
  labelKey: "cmd.kote.label",
  prompt: (s) => ((s as KoteState).phase === "value" ? "cmd.kote.value" : "cmd.kote.point"),
  accepts: (s) => ((s as KoteState).phase === "value" ? ["number", "option"] : ["point"]),
  options: (s) => ((s as KoteState).phase === "value" ? [kindOption((s as KoteValue).kind)] : []),
  init: (): KotePoint => ({ phase: "point", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as KoteState;
    if (s.phase === "point") {
      if (input.kind !== "point") return [s, { draft: null }];
      const ns: KoteValue = { phase: "value", at: input.point, kind: "okFertig", lastPoint: input.point };
      return [ns, { draft: valueDraft(input.point, "okFertig") }];
    }
    if (input.kind === "option" && input.id === "kind") {
      const ns: KoteValue = { ...s, kind: nextKind(s.kind) };
      return [ns, { draft: valueDraft(s.at, ns.kind) }];
    }
    if (input.kind !== "number") return [s, { draft: valueDraft(s.at, s.kind) }];
    const { at, kind } = s;
    return [
      { phase: "point", lastPoint: null },
      { draft: null, done: true, commit: opsMutation(() => appendKote(at, input.value, kind, ctx)) },
    ];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
