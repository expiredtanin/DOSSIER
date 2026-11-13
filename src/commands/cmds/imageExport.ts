// [223] 3D-Bild exportieren — öffnet den Dialog (in App montiert) und endet sofort; Muster `rendering`.

import { openImageExportDialog } from "../../state/imageExportDialogHook";
import type { Command, CommandResult, CommandState } from "../types";

const IDLE: CommandState = { phase: "idle", lastPoint: null };

function open(): [CommandState, CommandResult] {
  openImageExportDialog();
  return [{ ...IDLE }, { draft: null, done: true }];
}

export const imageExportCommand: Command = {
  name: "bild3d",
  labelKey: "cmd.bild3d.label",
  prompt: () => "cmd.bild3d.prompt",
  accepts: () => [],
  options: () => [],
  init: () => ({ ...IDLE }),
  autoRun: (): CommandResult => {
    openImageExportDialog();
    return { draft: null, done: true };
  },
  onInput: () => open(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: () => open(),
  onCancel: (): [CommandState, CommandResult] => [{ ...IDLE }, { draft: null, done: true }],
};
