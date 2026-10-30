// Split — teilt eine Wand (gerade oder Bogen) oder eine offene 2D-Kurve ([113]). Ein Schritt, wiederholend:
//   • Klick auf das Element → Teilung an dieser Stelle (Wand: Lot auf die Achse; Kurve: nächster Punkt).
//   • Option „Schnittpunkte" → der Klick teilt das Element an allen Schnittpunkten mit den übrigen
//     Wänden (Achsen), 2D-Kurven und Achsrastern des Geschosses.
// Öffnungen bleiben am Stück, in dem ihre Mitte liegt (Lage umgerechnet), Bemassungs-Bezüge ([38])
// werden auf die Stücke umgehängt. Treffer, Teilung und Vorschau rechnet der Kern
// (`src-tauri/core/src/cmd_edit.rs` → `cmd_wall_edit.rs`); hier nur der Zustandsautomat.

import { cmdMutation } from "../../core";
import { uniqueStamp } from "../../tools/types";
import { cmdQuery, decodeShapes, pair } from "../../tools/coreCmd";
import type { CmdOption, Command, CommandResult, CommandState } from "../types";

/** An allen Schnittpunkten statt am Klickpunkt teilen (bleibt über Aufrufe). */
let atIntersections = false;
const interOption = (): CmdOption => ({ id: "inter", labelKey: "cmd.split.interOpt", value: atIntersections ? "on" : "off" });

interface SplitPick extends CommandState {
  phase: "pick";
}
interface SplitDone extends CommandState {
  phase: "done";
}
type SplitState = SplitPick | SplitDone;

const finish = (): [CommandState, CommandResult] => [{ phase: "done", lastPoint: null } as SplitDone, { draft: null, done: true }];

export const splitCommand: Command = {
  name: "split",
  labelKey: "cmd.split.label",
  prompt: () => "cmd.split.pick",
  accepts: () => ["point", "option"],
  options: () => [interOption()],
  init: (): SplitPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as SplitState;
    if (s.phase === "done") return finish();
    if (input.kind === "option" && input.id === "inter") {
      atIntersections = !atIntersections;
      return [s, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const { hit } = cmdQuery<{ hit: string | null }>(ctx.project, { q: "split", level: ctx.level.id, pt: pair(input.point), inter: atIntersections });
    if (!hit) return [s, { draft: null }];
    const req = atIntersections ? { cmd: "splitInter", id: hit, stamp: uniqueStamp() } : { cmd: "splitAt", id: hit, pt: pair(input.point), stamp: uniqueStamp() };
    return [s, { draft: null, commit: cmdMutation(req) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as SplitState;
    if (s.phase !== "pick") return [s, { draft: null }];
    const r = cmdQuery<{ hit: string | null; shapes: number[] }>(ctx.project, { q: "split", level: ctx.level.id, pt: pair(point), inter: atIntersections });
    if (!r.hit) return [s, { draft: null }];
    return [s, { draft: { preview: decodeShapes(r.shapes), vertices: [point], hud: { at: point, text: "⫽" } } }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
