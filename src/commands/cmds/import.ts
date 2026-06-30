// Import — öffnet den DXF-Datei-Dialog (in App montiert) und beendet sich
// sofort. Der eigentliche Import (Datei lesen → parseDxf → addContextObjects)
// läuft asynchron über das App-onChange des versteckten <input type=file>; ein
// Command kann den Datei-Dialog nicht selbst „committen" (er ist DOM-/async-
// seitig). Daher koppelt dieser Befehl nur den Trigger an (über den Modul-Hook
// dxfImportHook) und gibt keine Mutation zurück.
//
// Bezeichner englisch, sichtbarer Text via t() (Namespace `cmd.import.*`).

import { openDxfImport } from "../../io/dxfImportHook";
import type { Command, CommandResult, CommandState } from "../types";

const IDLE: CommandState = { phase: "idle", lastPoint: null };

/** Öffnet den Datei-Dialog und beendet den Befehl sofort (keine Mutation). */
function open(): [CommandState, CommandResult] {
  openDxfImport();
  return [{ ...IDLE }, { draft: null, done: true }];
}

export const importCommand: Command = {
  name: "import",
  labelKey: "cmd.import.label",
  prompt: () => "cmd.import.prompt",
  accepts: () => [],
  options: () => [],
  init: () => ({ ...IDLE }),

  // Der Befehl hat keine Schritte: Start/Enter/Input öffnet den Dialog + endet.
  onInput: () => open(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: () => open(),
  onCancel: (): [CommandState, CommandResult] => [
    { ...IDLE },
    { draft: null, done: true },
  ],
};
