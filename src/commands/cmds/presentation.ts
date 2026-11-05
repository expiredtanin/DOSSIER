// [66] Präsentationsplan — öffnet den Dialog (in App montiert) und endet sofort; das Blatt entsteht beim
// Bestätigen in einem Undo-Schritt (`state/presentationSheet.ts`). Muster wie `import`.

import { openPresentationDialog } from "../../state/presentationSheetHook";
import type { Command, CommandResult, CommandState } from "../types";

const IDLE: CommandState = { phase: "idle", lastPoint: null };

function open(): [CommandState, CommandResult] {
  openPresentationDialog();
  return [{ ...IDLE }, { draft: null, done: true }];
}

export const presentationCommand: Command = {
  name: "praesentation",
  labelKey: "cmd.praesentation.label",
  prompt: () => "cmd.praesentation.prompt",
  accepts: () => [],
  options: () => [],
  init: () => ({ ...IDLE }),
  autoRun: (): CommandResult => {
    openPresentationDialog();
    return { draft: null, done: true };
  },
  onInput: () => open(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: () => open(),
  onCancel: (): [CommandState, CommandResult] => [{ ...IDLE }, { draft: null, done: true }],
};
