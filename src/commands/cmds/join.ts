// Join — verbindet die gewählten 2D-Zeichenelemente an koinzidenten Endpunkten zu
// Polylinien (geschlossen, wenn sich eine Kette schließt). Sofort-Befehl (kein
// Punkt-Picken): läuft direkt auf der bestehenden Mehrfachauswahl. So ist „Ctrl+J"
// und getipptes „join" EIN Pfad (§Task C).
//
// Wände werden nicht verbunden (2D-Editier-Operation); nicht-polyline Formen
// (circle/arc/text) bleiben unverändert und rücken hinter das Ergebnis. Rechnet der
// Kern (`src-tauri/core/src/cmd_edit.rs::join_ops`, [K4] S3): die gewählten Quell-
// Drawings raus, das Ergebnis hinten dran (ab zwei Elementen).

import { cmdMutation } from "../../core";
import { uniqueStamp } from "../../tools/types";
import type { Command, CommandContext, CommandResult, CommandSelection, CommandState } from "../types";

/** Alle gewählten 2D-Element-IDs (Mehrfachauswahl mit Fallback aufs Einzelelement). */
function selectedDrawingIds(sel: CommandSelection): string[] {
  if (sel.drawingIds && sel.drawingIds.length) return sel.drawingIds;
  return sel.drawingId ? [sel.drawingId] : [];
}

interface JoinState extends CommandState {
  phase: "done";
}

const done = (): [CommandState, CommandResult] => [
  { phase: "done", lastPoint: null } as JoinState,
  { draft: null, done: true },
];

export const joinCommand: Command = {
  name: "join",
  labelKey: "edit.join.label",
  prompt: () => "cmd.join.prompt",
  accepts: () => [],
  options: () => [],
  init: (): JoinState => ({ phase: "done", lastPoint: null }),

  // Sofort auf der Auswahl ausführen (kein Pick nötig).
  autoRun: (ctx: CommandContext): CommandResult => {
    const ids = selectedDrawingIds(ctx.selection);
    if (ids.length < 2) return { draft: null, done: true };
    return { draft: null, done: true, commit: cmdMutation({ cmd: "join", ids, stamp: uniqueStamp() }) };
  },

  onInput: (): [CommandState, CommandResult] => done(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
