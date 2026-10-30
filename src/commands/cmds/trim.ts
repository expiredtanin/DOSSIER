// Trim — Quick-Trim („stutzen") für 2D-Kurven (line/polyline/rect), Rhino/
// AutoCAD-artig (docs §2.10/§3.4 Tier-1). Modell:
//   • Cutters sind IMPLIZIT alle ANDEREN Drawing2D-Elemente der aktiven Ebene
//     (Quick-Trim — kein separater Cutter-Auswahlschritt; üblich + einfacher).
//   • Ein Schritt: der Nutzer klickt auf den WEGZUSCHNEIDENDEN Teil einer Kurve.
//     Wir bestimmen das getroffene Element (Nähe), zerlegen es an seinen
//     Schnittpunkten mit allen Cuttern und ENTFERNEN den angeklickten Abschnitt
//     (zwischen den beiden nächstgelegenen Schnittpunkten um den Klick — bzw. bis
//     zum Element-Ende, wenn nur einseitig ein Schnitt liegt).
//   • Wiederholend, bis Esc/Enter.
//
// Linie → wird gekürzt/aufgeteilt; Polylinie → der getroffene Abschnitt fällt
// raus (kann die Polylinie in Stücke teilen). Treffer, Schneider, Rest-Ketten und
// Vorschau rechnet der Kern (`src-tauri/core/src/cmd_edit.rs`, [K4] S3); hier nur
// der Zustandsautomat. Wände (gerade und Bogen, [113]) gehen genauso: Klick auf den wegzuschneidenden
// Teil; Schneider sind die anderen Wände (Achse/Fläche), 2D-Kurven und Achsraster. Sowohl Ziel-Kurve
// als auch Schneider dürfen Bogen-Segmente (bulge) tragen.
//
// Bezeichner englisch, Kommentare/UI deutsch (CONVENTIONS.md).

import { cmdMutation } from "../../core";
import { uniqueStamp } from "../../tools/types";
import { cmdQuery, decodeShapes, pair } from "../../tools/coreCmd";
import type { CmdOption, Command, CommandResult, CommandState } from "../types";

/**
 * Wände ([113]): Grenze ist die Achse der anderen Wand (ergibt einen T-Stoss) oder — Option „Fläche" —
 * ihre Aussenflächen. Die Wahl bleibt über Aufrufe erhalten.
 */
let toFace = false;
const faceOption = (): CmdOption => ({ id: "face", labelKey: "cmd.wallEdit.faceOpt", value: toFace ? "on" : "off" });

// ── Zustand ───────────────────────────────────────────────────────────────────
// Einziger Schritt „pick": auf den wegzuschneidenden Abschnitt klicken;
// wiederholend, bis Esc/Enter. „done": beendet.
interface TrimPick extends CommandState {
  phase: "pick";
}
interface TrimDone extends CommandState {
  phase: "done";
}
type TrimState = TrimPick | TrimDone;

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as TrimDone,
  { draft: null, done: true },
];

export const trimCommand: Command = {
  name: "trim",
  labelKey: "cmd.trim.label",
  prompt: () => "cmd.trim.pick",
  accepts: () => ["point", "option"],
  options: () => [faceOption()],

  init: (): TrimPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as TrimState;
    if (s.phase === "done") return finish();
    if (input.kind === "option" && input.id === "face") {
      toFace = !toFace;
      return [s, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const { hit } = cmdQuery<{ hit: string | null }>(ctx.project, { q: "pickCurve", level: ctx.level.id, pt: pair(input.point) });
    if (!hit) {
      // Daneben geklickt → Befehl bleibt aktiv (weiter trimmen).
      return [s, { draft: null }];
    }
    // Wiederholend: NICHT done — nach dem Commit bleibt „pick" aktiv.
    return [s, { draft: null, commit: cmdMutation({ cmd: "trim", id: hit, pt: pair(input.point), face: toFace, stamp: uniqueStamp() }) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as TrimState;
    if (s.phase !== "pick") return [s, { draft: null }];
    const r = cmdQuery<{ hit: boolean; shapes: number[] }>(ctx.project, { q: "trim", level: ctx.level.id, pt: pair(point), face: toFace });
    if (!r.hit) return [s, { draft: null }];
    const preview = decodeShapes(r.shapes);
    return [
      s,
      {
        draft: {
          preview,
          vertices: [],
          hud: { at: point, text: "✂" },
        },
      },
    ];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
