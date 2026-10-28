// Join — verbindet die gewählten 2D-Zeichenelemente an koinzidenten Endpunkten zu
// Polylinien (geschlossen, wenn sich eine Kette schließt). Sofort-Befehl (kein
// Punkt-Picken): läuft direkt auf der bestehenden Mehrfachauswahl. So ist „Ctrl+J"
// und getipptes „join" EIN Pfad (§Task C).
//
// Wände werden nicht verbunden (2D-Editier-Operation); nicht-polyline Formen
// (circle/arc/text) reicht `joinDrawings` unverändert durch.

import { joinDrawings } from "../../editors/splitJoin";
import type { Drawing2D } from "../../model/types";
import { addItems, opsMutation, removeItems } from "../../core";
import type { CoreOp } from "../../core";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandSelection,
  CommandState,
  Project,
} from "../types";

/** Alle gewählten 2D-Element-IDs (Mehrfachauswahl mit Fallback aufs Einzelelement). */
function selectedDrawingIds(sel: CommandSelection): string[] {
  if (sel.drawingIds && sel.drawingIds.length) return sel.drawingIds;
  return sel.drawingId ? [sel.drawingId] : [];
}

/** Ops: die gewählten Quell-Drawings raus, das Join-Ergebnis hinten dran. */
function joinOps(project: Project, ids: string[]): CoreOp[] {
  const idSet = new Set(ids);
  const srcs = project.drawings2d.filter((d) => idSet.has(d.id));
  if (srcs.length < 2) return []; // <2 → nichts zu verbinden
  const joined: Drawing2D[] = joinDrawings(srcs);
  return [...removeItems(project, "drawings2d", idSet), ...addItems("drawings2d", joined)];
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
    return { draft: null, done: true, commit: opsMutation((p) => joinOps(p, ids)) };
  },

  onInput: (): [CommandState, CommandResult] => done(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
