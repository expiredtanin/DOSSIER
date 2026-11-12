// [211] Rendering mit Blender — öffnet den Dialog (in App montiert) und endet sofort; Muster `presentation`.

import { openRenderDialog } from "../../state/renderDialogHook";
import type { Command, CommandResult, CommandState } from "../types";

const IDLE: CommandState = { phase: "idle", lastPoint: null };

function open(): [CommandState, CommandResult] {
  openRenderDialog();
  return [{ ...IDLE }, { draft: null, done: true }];
}

export const renderingCommand: Command = {
  name: "rendering",
  labelKey: "cmd.rendering.label",
  prompt: () => "cmd.rendering.prompt",
  accepts: () => [],
  options: () => [],
  init: () => ({ ...IDLE }),
  autoRun: (): CommandResult => {
    openRenderDialog();
    return { draft: null, done: true };
  },
  onInput: () => open(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: () => open(),
  onCancel: (): [CommandState, CommandResult] => [{ ...IDLE }, { draft: null, done: true }],
};
