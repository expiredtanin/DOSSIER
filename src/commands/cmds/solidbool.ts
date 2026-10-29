// SolidBool — Boolesche Operation (Vereinigung / Differenz / Durchschnitt) zweier Körper
// (`ExtrudedSolid`). Das Ergebnis ist EIN Körper mit B-Rep-Spezifikation (`brep.spec` =
// `boolean`-Knoten über den beiden Operanden): truck rechnet auf B-Rep-Ebene und fällt bei
// koinzidenten Flächen automatisch auf Mesh-CSG zurück (trucksolid::solid_mesh_core).
//
// Schritte: „Ersten Körper wählen" (Klick in seine Grundfläche) → „Zweiten Körper wählen" →
// fertig. Die Operation wählt man als Inline-Option (Default Vereinigung); bei Differenz wird
// der ZWEITE vom ERSTEN abgezogen. Beide Quellkörper werden durch das Ergebnis ersetzt.

import type { Command, CommandContext, CommandResult, CommandState, CmdOption, ToolDraft } from "../types";
import { createMutation, createPreview, createQuery, xy } from "../createCore";

export type SolidBoolOp = "union" | "difference" | "intersection";

const OP_OPTIONS: CmdOption[] = [
  { id: "union", labelKey: "cmd.solidbool.op.union" },
  { id: "difference", labelKey: "cmd.solidbool.op.difference" },
  { id: "intersection", labelKey: "cmd.solidbool.op.intersection" },
];
const OP_IDS = new Set(OP_OPTIONS.map((o) => o.id));

let lastOp: SolidBoolOp = "union";

interface BoolState extends CommandState {
  phase: "first" | "second";
  op: SolidBoolOp;
  firstId: string | null;
}

/** Kleinster Körper der Ebene, dessen Grundriss den Punkt enthält (Kern), oder null. */
function pickSolid(ctx: CommandContext, pt: { x: number; y: number }): string | null {
  return createQuery<{ hit: string | null }>(ctx.project, { q: "pickSolid", level: ctx.level.id, pt: xy(pt) }).hit;
}

const reset = (op: SolidBoolOp): BoolState => ({ phase: "first", op, firstId: null, lastPoint: null });

/** Hervorhebung des ersten gewählten Körpers (Grundriss aus dem Kern). */
function highlight(ctx: CommandContext, id: string | null): ToolDraft | null {
  if (!id) return null;
  const pv = createPreview(ctx, { cmd: "solidOutline", id }, []);
  return pv.ok ? { preview: pv.shapes, vertices: [] } : null;
}

export const solidBoolCommand: Command = {
  name: "solidbool",
  labelKey: "cmd.solidbool.label",
  floorOnly: true,
  prompt: (st) => ((st as BoolState).phase === "second" ? "cmd.solidbool.second" : "cmd.solidbool.first"),
  accepts: () => ["point", "option"],
  options: () => OP_OPTIONS,
  init: (): BoolState => reset(lastOp),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as BoolState;
    if (input.kind === "option" && OP_IDS.has(input.id)) {
      lastOp = input.id as SolidBoolOp;
      const ns: BoolState = { ...s, op: lastOp };
      return [ns, { draft: highlight(ctx, s.firstId) }];
    }
    if (input.kind !== "point") return [s, { draft: highlight(ctx, s.firstId) }];
    const hit = pickSolid(ctx, input.point);
    if (!hit) return [s, { draft: highlight(ctx, s.firstId) }];
    if (s.phase === "first") {
      const ns: BoolState = { ...s, phase: "second", firstId: hit, lastPoint: input.point };
      return [ns, { draft: highlight(ctx, hit) }];
    }
    if (hit === s.firstId) return [s, { draft: highlight(ctx, s.firstId) }];
    const firstId = s.firstId!;
    const op = s.op;
    return [
      reset(op),
      {
        draft: null,
        done: true,
        // Verknüpfung im Kern (`cmd_solid.rs`): Grundriss, Höhe, B-Rep `boolean` beider Körper.
        commit: createMutation(ctx, { cmd: "solidbool", a: firstId, b: hit, op }),
      },
    ];
  },

  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (state): [CommandState, CommandResult] => [reset((state as BoolState).op), { draft: null, done: true }],
  onCancel: (state): [CommandState, CommandResult] => [reset((state as BoolState).op), { draft: null, done: true }],
};
