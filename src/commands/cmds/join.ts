// Join — verbindet die gewählten 2D-Zeichenelemente an koinzidenten Endpunkten zu
// Polylinien (geschlossen, wenn sich eine Kette schließt). Sofort-Befehl (kein
// Punkt-Picken): läuft direkt auf der bestehenden Mehrfachauswahl. So ist „Ctrl+J"
// und getipptes „join" EIN Pfad (§Task C).
//
// Wände werden nicht verbunden (2D-Editier-Operation); nicht-polyline Formen
// (circle/arc/text) reicht `joinDrawings` unverändert durch.

import { joinDrawings } from "../../editors/splitJoin";
import type { Drawing2D } from "../../model/types";
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

/** Ersetzt die gewählten Quell-Drawings durch das Join-Ergebnis (immutabel). */
function applyJoin(project: Project, ids: string[]): Project {
  const idSet = new Set(ids);
  const srcs = project.drawings2d.filter((d) => idSet.has(d.id));
  if (srcs.length < 2) return project; // <2 → nichts zu verbinden
  const joined: Drawing2D[] = joinDrawings(srcs);
  const rest = project.drawings2d.filter((d) => !idSet.has(d.id));
  return { ...project, drawings2d: [...rest, ...joined] };
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
    return { draft: null, done: true, commit: (p) => applyJoin(p, ids) };
  },

  onInput: (): [CommandState, CommandResult] => done(),
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  onConfirm: (): [CommandState, CommandResult] => done(),
  onCancel: (): [CommandState, CommandResult] => done(),
};
