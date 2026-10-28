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

import { generateTerrainFromContours } from "../../model/terrain";
import type { ContextObject } from "../../model/types";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";
import type {
  Command,
  CommandResult,
  CommandState,
  Project,
} from "../types";

/** Ops: hängt ein aus dem ersten ContourSet abgeleitetes TIN an `context` an. */
function terrainOps(p: Project): CoreOp[] {
  const context: ContextObject[] = p.context ?? [];
  const set = context.find((o) => o.type === "contourSet");
  if (!set || set.type !== "contourSet") return [];
  const terrain = generateTerrainFromContours(set.contours);
  if (terrain.indices.length === 0) return []; // kein sinnvolles TIN
  return addItems("context", [terrain]);
}

/** Ergebnis, das den Befehl sofort beendet und das TIN committet. */
const COMMIT_DONE: CommandResult = {
  draft: null,
  done: true,
  commit: opsMutation(terrainOps),
};

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
  onInput: (): [CommandState, CommandResult] => [{ ...IDLE }, COMMIT_DONE],
  onMove: (state): [CommandState, CommandResult] => [state, { draft: null }],
  // Enter/Space/Rechtsklick: Gelände erzeugen + beenden.
  onConfirm: (): [CommandState, CommandResult] => [{ ...IDLE }, COMMIT_DONE],
  onCancel: (): [CommandState, CommandResult] => [
    { ...IDLE },
    { draft: null, done: true },
  ],
};
