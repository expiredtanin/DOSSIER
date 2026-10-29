// Höhenkote (SIA 400 B.5.4, Figur 18) — Dreieck-Symbol + Höhenwert an einem
// Punkt. Schritte:
//   1) „Punkt:"                     → Punkt (Dreieck-Spitze)
//   2) „Höhenwert ( Art ):"         → Zahl (Meter, z. B. 3.25 oder -0.1) →
//      commit. „Art" (Option, zyklisch: OK fertig/UK fertig/OK roh/UK roh)
//      wechselt VOR dem Tippen die Dreieck-Variante (Default OK fertig).

import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdOption,
  ToolDraft,
  Vec2,
} from "../types";
import type { TranslationKey } from "../../i18n";
import { createMutation, createPreview } from "../createCore";

type KoteKind = "okFertig" | "ukFertig" | "okRoh" | "ukRoh";
const KIND_ORDER: KoteKind[] = ["okFertig", "ukFertig", "okRoh", "ukRoh"];
const nextKind = (k: KoteKind): KoteKind => KIND_ORDER[(KIND_ORDER.indexOf(k) + 1) % KIND_ORDER.length];
const KIND_LABEL: Record<KoteKind, TranslationKey> = {
  okFertig: "cmd.kote.kind.okFertig",
  ukFertig: "cmd.kote.kind.ukFertig",
  okRoh: "cmd.kote.kind.okRoh",
  ukRoh: "cmd.kote.kind.ukRoh",
};

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

/** Vorschau (Kern, `cmd_draw.rs`): Kote-Dreieck (Spitze am Punkt, Basis oben für OK, unten für UK). */
function valueDraft(ctx: CommandContext, at: Vec2, kind: KoteKind): ToolDraft {
  return { preview: createPreview(ctx, { cmd: "kote", kind }, [at]).shapes, vertices: [at] };
}

/** Commit (Kern): Höhenkote am Punkt mit getipptem Wert. */
const appendKote = (at: Vec2, value: number, kind: KoteKind, ctx: CommandContext) =>
  createMutation(ctx, { cmd: "kote", at, value, kind });

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
      return [ns, { draft: valueDraft(ctx, input.point, "okFertig") }];
    }
    if (input.kind === "option" && input.id === "kind") {
      const ns: KoteValue = { ...s, kind: nextKind(s.kind) };
      return [ns, { draft: valueDraft(ctx, s.at, ns.kind) }];
    }
    if (input.kind !== "number") return [s, { draft: valueDraft(ctx, s.at, s.kind) }];
    const { at, kind } = s;
    return [
      { phase: "point", lastPoint: null },
      { draft: null, done: true, commit: appendKote(at, input.value, kind, ctx) },
    ];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
