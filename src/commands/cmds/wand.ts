// Zauberstab ([77]): EIN Klick in eine von Linien umschlossene Fläche (2D-Zeichnungen und Modellkanten des
// Geschosses) → geschlossene Polylinie mit Schraffur. Die Masche sucht der Kern (`magic_wand.rs`); die Vorschau
// zeigt sie schon beim Überfahren. Option S schaltet durch die Schraffuren des Projekts und „keine" (nur Umriss);
// Vorgabe ist die erste Schraffur. Die Wahl bleibt über mehrere Klicks (`sticky`).

import type { CmdOption, Command, CommandContext, CommandResult, CommandState, Vec2 } from "../types";
import { createMutation, createPreview } from "../createCore";

interface WandState extends CommandState {
  /** `hatch`: Index in den wählbaren Schraffuren (`NONE` = nur Umriss); `name`: Anzeige in der Befehlszeile. */
  sticky: { hatch: number; name?: string };
}

const NONE = -1;
const idle = (): [CommandState, CommandResult] => [{ phase: "point", lastPoint: null }, { draft: null, done: true }];

/** Wählbare Schraffuren: ohne Muster „none" (die Standard-Schraffur „Ohne" stünde sonst als Vorgabe vorne). */
const usable = (ctx: CommandContext) => ctx.project.hatches.filter((h) => h.pattern !== "none");

/** Gewählte Schraffur: Index in `usable`, `NONE` = nur Umriss; ausser Reichweite → erste. */
const hatchOf = (s: WandState, ctx: CommandContext): string | undefined =>
  s.sticky.hatch === NONE ? undefined : (usable(ctx)[s.sticky.hatch] ?? usable(ctx)[0])?.id;

export const wandCommand: Command = {
  name: "zauberstab",
  labelKey: "cmd.wand.label",
  prompt: () => "cmd.wand.point",
  accepts: () => ["point", "option"],
  options: (state): CmdOption[] => {
    const s = state as WandState;
    const value = s.sticky?.hatch === NONE ? "—" : (s.sticky?.name ?? "1");
    return [{ id: "hatch", labelKey: "cmd.wand.hatch", key: "S", value }];
  },
  init: (): WandState => ({ phase: "point", lastPoint: null, sticky: { hatch: 0 } }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as WandState;
    if (input.kind === "option" && input.id === "hatch") {
      const list = usable(ctx);
      const n = list.length;
      // Reihenfolge: 0, 1, …, n−1, keine, 0 …
      const next = s.sticky.hatch === NONE ? 0 : s.sticky.hatch + 1 >= n ? NONE : s.sticky.hatch + 1;
      return [{ ...s, sticky: { hatch: next, name: next === NONE ? undefined : list[next]?.name } } as WandState, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const at: Vec2 = input.point;
    // Kein Treffer: Befehl bleibt aktiv (nächster Klick), nichts wird angelegt.
    if (!createPreview(ctx, { cmd: "wand" }, [at]).ok) return [s, { draft: null }];
    return [s, { draft: null, commit: createMutation(ctx, { cmd: "wand", at, hatchId: hatchOf(s, ctx) }) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const pv = createPreview(ctx, { cmd: "wand" }, [point]);
    return [state, { draft: { preview: pv.ok ? pv.shapes : [], vertices: [point] } }];
  },
  onConfirm: () => idle(),
  onCancel: () => idle(),
};
