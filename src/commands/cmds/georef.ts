// Neuer Bezugspunkt — verschiebt das GESAMTE Projekt (Wände, Decken, Dächer,
// Treppen, Räume, Stützen, Extrusionen, freie 2D-Geometrie, Kontext-Schicht,
// Schnittlinien) so, dass der geklickte Punkt zum neuen Modell-Ursprung (0,0)
// wird. Praktisch nach einem Kataster-/3D-Import (Kontext-Geometrie landet
// dort, wo der gesuchte Standort war — kann weit vom bisherigen Ursprung
// liegen, s. `Project.geoAnchor`): man klickt den gewünschten Bezugspunkt
// (z. B. eine Parzellenecke aus dem Import) und zeichnet danach mit kleinen,
// bequemen Koordinaten weiter. `geoAnchor` wandert automatisch mit (reine
// Translation, s. `model/geoRebase.ts`), der reale LV95-Bezug bleibt exakt
// erhalten — beim Export ist die Verschiebung jederzeit rekonstruierbar.
//
// Ein-Klick-Befehl: der erste (einzige) Punkt committet sofort.

import { translateOps } from "../../model/geoRebase";
import { opsMutation } from "../../core";
import type {
  Command,
  CommandResult,
  CommandState,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

interface GeorefStart extends CommandState {
  phase: "start";
}

const IDLE: GeorefStart = { phase: "start", lastPoint: null };
const idle = (): [CommandState, CommandResult] => [{ ...IDLE }, { draft: null, done: true }];

/** HUD am Cursor: zeigt die resultierende Verschiebung, bevor geklickt wird. */
function draft(point: Vec2): ToolDraft {
  return {
    preview: [],
    vertices: [],
    hud: { at: point, dx: -point.x, dy: -point.y },
  };
}

export const georefCommand: Command = {
  name: "georef",
  labelKey: "cmd.georef.label",
  prompt: () => "cmd.georef.prompt",
  accepts: () => ["point"],
  options: () => [],
  init: (): GeorefStart => ({ ...IDLE }),

  onInput: (state, input): [CommandState, CommandResult] => {
    if (input.kind !== "point") return [state, { draft: null }];
    const { x, y } = input.point;
    return [
      { ...IDLE },
      {
        draft: null,
        done: true,
        commit: opsMutation((p: Project) => translateOps(p, -x, -y)),
      },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => [state, { draft: draft(point) }],
  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),
};
