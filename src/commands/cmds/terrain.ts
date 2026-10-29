// Terrain — erzeugt aus dem (ersten) ContourSet der Kontext-Schicht ein
// Gelände-TIN und hängt es an `project.context`. Null-Schritt-Befehl: er
// committet sofort beim Start (über onConfirm, das die Engine direkt aufruft,
// wenn keine Punkte erwartet werden) — wir lösen das robust über onInput/
// onConfirm, die beide dieselbe Mutation liefern.
//
// Die Mutation ist rein (kein Store/React): sie sucht den ersten ContourSet in
// p.context, ruft generateTerrainFromContours und fügt das TIN hinzu. Liefert
// das TIN kein sinnvolles Mesh (zu wenige/kollineare Punkte), bleibt p
// unverändert.
//
// Bezeichner englisch, sichtbarer Text via t() (Namespace `cmd.terrain.*`).

import { createMutation } from "../createCore";
import type { Command, CommandContext, CommandResult, CommandState } from "../types";

/**
 * Ergebnis, das den Befehl sofort beendet und das TIN committet (Kern, `cmd_solid.rs`: erstes
 * ContourSet aus `context` → Delaunay-TIN; ohne sinnvolles TIN nichts).
 */
const commitDone = (ctx: CommandContext): CommandResult => ({ draft: null, done: true, commit: createMutation(ctx, { cmd: "terrain" }) });

const IDLE: CommandState = { phase: "idle", lastPoint: null };

export const terrainCommand: Command = {
  name: "terrain",
  labelKey: "cmd.terrain.label",
  prompt: () => "cmd.terrain.prompt",
  // Erwartet keine echten Eingaben; Enter/Start committet sofort.
  accepts: () => [],
  options: () => [],
  init: () => ({ ...IDLE }),

  // Jeglicher Input beendet den Befehl mit dem Commit (es gibt keine Schritte).
  onInput: (_s, _i, ctx): [CommandState, CommandResult] => [{ ...IDLE }, commitDone(ctx)],
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  // Enter/Space/Rechtsklick: Gelände erzeugen + beenden.
  onConfirm: (_s, ctx): [CommandState, CommandResult] => [{ ...IDLE }, commitDone(ctx)],
  onCancel: (): [CommandState, CommandResult] => [
    { ...IDLE },
    { draft: null, done: true },
  ],
};
