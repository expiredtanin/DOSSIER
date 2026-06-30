// Befehls-Registry (docs/design/rhino-command-system.md §3.2) — `COMMANDS` +
// Aliase + Präfix-Autocomplete. Einzelne Befehle leben als eigene Module unter
// `cmds/`, sodass weitere Befehle ADDITIV (ohne Änderung an Engine/App)
// dazukommen: hier importieren + registrieren, fertig.

import type { Command } from "./types";
import { lineCommand } from "./cmds/line";
import { polylineCommand } from "./cmds/polyline";
import { rectCommand } from "./cmds/rect";
import { circleCommand } from "./cmds/circle";
import { moveCommand } from "./cmds/move";
import { copyCommand } from "./cmds/copy";
import { offsetCommand } from "./cmds/offset";
import { importCommand } from "./cmds/import";
import { terrainCommand } from "./cmds/terrain";

/** Alle bekannten Befehle, Schlüssel = Befehlsname (lowercase). */
export const COMMANDS: Record<string, Command> = {
  line: lineCommand,
  polyline: polylineCommand,
  rect: rectCommand,
  circle: circleCommand,
  move: moveCommand,
  copy: copyCommand,
  offset: offsetCommand,
  import: importCommand,
  terrain: terrainCommand,
};

/**
 * Aliase / Kürzel → Befehlsname (§2.2). Werden VOR dem Autocomplete gematcht
 * (case-insensitiv). Minimal: Einzelbuchstaben. NICHT `r` (kollidiert mit dem
 * relativ-Koordinaten-Präfix `r5,3`).
 */
export const ALIASES: Record<string, string> = {
  l: "line",
  pl: "polyline",
  rec: "rect",
  c: "circle",
  m: "move",
  cp: "copy",
  o: "offset",
  imp: "import",
  ter: "terrain",
};

/** Liefert den Befehl zu einem exakten Namen (oder undefined). */
export function getCommand(name: string): Command | undefined {
  return COMMANDS[name.toLowerCase()];
}

/**
 * Löst eine getippte Eingabe zu einem Befehl auf: erst exakter Name, dann Alias,
 * dann eindeutiges Präfix (case-insensitiv). Mehrdeutige/leere Präfixe → null.
 */
export function resolveCommand(raw: string): Command | null {
  const q = raw.trim().toLowerCase();
  if (q === "") return null;
  if (COMMANDS[q]) return COMMANDS[q];
  if (ALIASES[q]) return COMMANDS[ALIASES[q]] ?? null;
  const matches = autocomplete(q);
  if (matches.length === 1) return COMMANDS[matches[0]] ?? null;
  // Exaktes Präfix, das auch ein Alias ist, hat Vorrang, wenn eindeutig.
  return null;
}

/**
 * Präfix-Autocomplete: alle Befehlsnamen, die mit dem (lowercase) Präfix
 * beginnen, alphabetisch. Aliase werden NICHT mitgelistet (sie sind Kürzel,
 * keine Vorschläge), aber ein exakter Alias-Treffer wird vorangestellt.
 */
export function autocomplete(prefix: string): string[] {
  const q = prefix.trim().toLowerCase();
  if (q === "") return Object.keys(COMMANDS).sort();
  const names = Object.keys(COMMANDS)
    .filter((n) => n.startsWith(q))
    .sort();
  return names;
}
