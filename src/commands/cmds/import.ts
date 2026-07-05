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

  // Sofort-Befehl (wie Join/Split): `startCommand` ruft `autoRun` SYNCHRON im
  // selben Aufruf-Stack wie die Enter-/Klick-Geste auf. Genau das braucht der
  // Datei-Dialog — ein `<input type=file>.click()` öffnet den OS-Dialog nur
  // innerhalb einer echten Nutzer-Geste; ein State-Update/async-Hop dazwischen
  // (wie beim reinen onConfirm/onInput-Weg) lässt ihn verzögern oder ausbleiben.
  autoRun: (): CommandResult => {
    openDxfImport();
    return { draft: null, done: true };
  },

  // Der Befehl hat keine Schritte: Start/Enter/Input öffnet den Dialog + endet.
  onInput: () => open(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: () => open(),
  onCancel: (): [CommandState, CommandResult] => [
    { ...IDLE },
    { draft: null, done: true },
  ],
};
