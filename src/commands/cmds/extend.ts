// Extend — verlängert eine OFFENE 2D-Kurve (line/offene polyline) bis zur
// nächsten anderen Kurve (Rhino/AutoCAD-artig, Gegenstück zu Trim). Modell:
//   • Cutters sind IMPLIZIT alle ANDEREN Drawing2D-Elemente der aktiven Ebene
//     (wie bei Trim — kein separater Cutter-Auswahlschritt).
//   • Ein Schritt: der Nutzer klickt auf die zu verlängernde Kurve, NAHE dem
//     Ende, das verlängert werden soll (das Ende, das dem Klick am nächsten
//     liegt, wird verlängert — nicht zwingend das nächste per Cursor-Distanz
//     zur ganzen Kurve, sondern zum jeweiligen Endpunkt).
//   • Trifft die Verlängerung keinen Cutter, passiert nichts (kein Fehler,
//     Befehl bleibt aktiv).
//   • Wiederholend, bis Esc/Enter.
//
// Wände ([113], gerade und Bogen) verlängert der Kern bis zur nächsten Wandachse/-fläche, 2D-Kurve
// oder Rasterachse (Bogenwände auf demselben Kreis).
//
// Geschlossene Formen (rect, geschlossene polyline) und reine Punktformen
// (circle/arc/text) sind nicht extend-fähig — ein geschlossener Ring hat kein
// "Ende". Treffer, Schneider und Verlängerung rechnet der Kern
// (`src-tauri/core/src/cmd_edit.rs`, [K4] S3, Geometrie `extendSegment`/`extendBulgeSegment`
// in `kernel2d`); hier nur der Zustandsautomat.
//
// Bogen-Enden: ist das äusserste Segment ein echter Bogen (bulge), verlängert
// der Kern denselben Kreis (Mittelpunkt/Radius unverändert, nur die
// Schwenk-Spanne wächst) bis zum nächsten Schneider — Cutter bleiben bewusst
// GERADE (Polylinien mit Bögen schneiden nicht).
//
// Bezeichner englisch, Kommentare/UI deutsch (CONVENTIONS.md).

import { cmdMutation } from "../../core";
import { cmdQuery, decodeShapes, pair } from "../../tools/coreCmd";
import type { CmdOption, Command, CommandResult, CommandState } from "../types";

/**
 * Wände ([113]): Grenze ist die Achse der anderen Wand (ergibt einen T-Stoss) oder — Option „Fläche" —
 * ihre Aussenflächen. Die Wahl bleibt über Aufrufe erhalten.
 */
let toFace = false;
const faceOption = (): CmdOption => ({ id: "face", labelKey: "cmd.wallEdit.faceOpt", value: toFace ? "on" : "off" });

// ── Zustand ───────────────────────────────────────────────────────────────────
// Einziger Schritt „pick": auf die zu verlängernde Kurve (nahe dem Ende) klicken;
// wiederholend, bis Esc/Enter.
interface ExtendPick extends CommandState {
  phase: "pick";
}
interface ExtendDone extends CommandState {
  phase: "done";
}
type ExtendState = ExtendPick | ExtendDone;

const finish = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as ExtendDone,
  { draft: null, done: true },
];

export const extendCommand: Command = {
  name: "extend",
  labelKey: "cmd.extend.label",
  prompt: () => "cmd.extend.pick",
  accepts: () => ["point", "option"],
  options: () => [faceOption()],

  init: (): ExtendPick => ({ phase: "pick", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as ExtendState;
    if (s.phase === "done") return finish();
    if (input.kind === "option" && input.id === "face") {
      toFace = !toFace;
      return [s, { draft: null }];
    }
    if (input.kind !== "point") return [s, { draft: null }];
    const { hit } = cmdQuery<{ hit: string | null }>(ctx.project, { q: "pickOpen", level: ctx.level.id, pt: pair(input.point) });
    if (!hit) return [s, { draft: null }];
    return [s, { draft: null, commit: cmdMutation({ cmd: "extend", id: hit, pt: pair(input.point), face: toFace }) }];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as ExtendState;
    if (s.phase !== "pick") return [s, { draft: null }];
    const r = cmdQuery<{ hit: boolean; shapes: number[] }>(ctx.project, { q: "extend", level: ctx.level.id, pt: pair(point), face: toFace });
    if (!r.hit) return [s, { draft: null }];
    const preview = decodeShapes(r.shapes);
    return [s, { draft: { preview, vertices: [], hud: { at: point, text: "↗" } } }];
  },

  onConfirm: (): [CommandState, CommandResult] => finish(),
  onCancel: (): [CommandState, CommandResult] => finish(),
};
