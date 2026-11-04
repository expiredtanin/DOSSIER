// Zauberstab ([77]): EIN Klick in eine von Linien umschlossene Fläche (2D-Zeichnungen und Modellkanten des
// Geschosses) → geschlossene Polylinie mit Schraffur. Die Masche sucht der Kern (`magic_wand.rs`); die Vorschau
// zeigt sie schon beim Überfahren. Schraffur: die erste Schraffur des Projekts (ohne Schraffuren nur der Umriss).

import type { Command, CommandContext, CommandResult, CommandState, Vec2 } from "../types";
import { createMutation, createPreview } from "../createCore";

const idle = (): [CommandState, CommandResult] => [{ phase: "point", lastPoint: null }, { draft: null, done: true }];

const hatchOf = (ctx: CommandContext): string | undefined => ctx.project.hatches[0]?.id;

export const wandCommand: Command = {
  name: "wand",
  labelKey: "cmd.wand.label",
  prompt: () => "cmd.wand.point",
  accepts: () => ["point"],
  options: () => [],
  init: () => ({ phase: "point", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    if (input.kind !== "point") return [state, { draft: null }];
    const at: Vec2 = input.point;
    // Kein Treffer: Befehl bleibt aktiv (nächster Klick), nichts wird angelegt.
    if (!createPreview(ctx, { cmd: "wand" }, [at]).ok) return [state, { draft: null }];
    return [state, { draft: null, commit: createMutation(ctx, { cmd: "wand", at, hatchId: hatchOf(ctx) }) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const pv = createPreview(ctx, { cmd: "wand" }, [point]);
    return [state, { draft: { preview: pv.ok ? pv.shapes : [], vertices: [point] } }];
  },
  onConfirm: () => idle(),
  onCancel: () => idle(),
};
