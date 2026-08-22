// Befehls-Registry (docs/design/rhino-command-system.md §3.2) — `COMMANDS` +
// Aliase + Präfix-Autocomplete. Einzelne Befehle leben als eigene Module unter
// `cmds/`, sodass weitere Befehle ADDITIV (ohne Änderung an Engine/App)
// dazukommen: hier importieren + registrieren, fertig.

import type { Command } from "./types";
import { lineCommand } from "./cmds/line";
import { polylineCommand } from "./cmds/polyline";
import { wallCommand } from "./cmds/wall";
import { ceilingCommand } from "./cmds/ceiling";
import { openingCommand, fensterCommand, tuerCommand } from "./cmds/opening";
import { stairCommand } from "./cmds/stair";
import { columnCommand } from "./cmds/column";
import { roofCommand } from "./cmds/roof";
import { ceilingOpeningCommand } from "./cmds/ceilingOpening";
import { roomCommand } from "./cmds/room";
import { rectCommand } from "./cmds/rect";
import { circleCommand } from "./cmds/circle";
import { arcCommand } from "./cmds/arc";
import { ellipseCommand } from "./cmds/ellipse";
import { splineCommand } from "./cmds/spline";
import { bezierCommand } from "./cmds/bezier";
import { dimensionCommand } from "./cmds/dimension";
import { koteCommand } from "./cmds/kote";
import { textCommand } from "./cmds/text";
import { textboxCommand } from "./cmds/textbox";
import { moveCommand } from "./cmds/move";
import { mirrorCommand } from "./cmds/mirror";
import { joinCommand } from "./cmds/join";
import { copyCommand } from "./cmds/copy";
import { offsetCommand } from "./cmds/offset";
import { extrudeCommand } from "./cmds/extrude";
import { trimCommand } from "./cmds/trim";
import { extendCommand } from "./cmds/extend";
import { filletCommand } from "./cmds/fillet";
import { chamferCommand } from "./cmds/chamfer";
import { multilineCommand } from "./cmds/multiline";
import { importCommand } from "./cmds/import";
import { terrainCommand } from "./cmds/terrain";
import { measureCommand } from "./cmds/measure";
import { sectionLineCommand, viewLineCommand } from "./cmds/sectionline";
import { georefCommand } from "./cmds/georef";

/** Alle bekannten Befehle, Schlüssel = Befehlsname (lowercase). */
export const COMMANDS: Record<string, Command> = {
  wall: wallCommand,
  ceiling: ceilingCommand,
  opening: openingCommand,
  fenster: fensterCommand,
  tuer: tuerCommand,
  stair: stairCommand,
  column: columnCommand,
  roof: roofCommand,
  ceilingopening: ceilingOpeningCommand,
  room: roomCommand,
  line: lineCommand,
  polyline: polylineCommand,
  rect: rectCommand,
  circle: circleCommand,
  arc: arcCommand,
  ellipse: ellipseCommand,
  spline: splineCommand,
  bezier: bezierCommand,
  dimension: dimensionCommand,
  kote: koteCommand,
  text: textCommand,
  textbox: textboxCommand,
  move: moveCommand,
  mirror: mirrorCommand,
  join: joinCommand,
  copy: copyCommand,
  offset: offsetCommand,
  extrude: extrudeCommand,
  trim: trimCommand,
  extend: extendCommand,
  fillet: filletCommand,
  chamfer: chamferCommand,
  multiline: multilineCommand,
  import: importCommand,
  terrain: terrainCommand,
  measure: measureCommand,
  sectionline: sectionLineCommand,
  viewline: viewLineCommand,
  georef: georefCommand,
};

/**
 * Aliase / Kürzel → Befehlsname (§2.2). Werden VOR dem Autocomplete gematcht
 * (case-insensitiv). Minimal: Einzelbuchstaben. NICHT `r` (kollidiert mit dem
 * relativ-Koordinaten-Präfix `r5,3`).
 */
export const ALIASES: Record<string, string> = {
  w: "wall",
  wand: "wall",
  d: "ceiling",
  decke: "ceiling",
  f: "fenster",
  t: "tuer",
  tür: "tuer",
  oe: "opening",
  treppe: "stair",
  tp: "stair",
  stuetze: "column",
  stütze: "column",
  dach: "roof",
  deckenloch: "ceilingopening",
  aussparung: "ceilingopening",
  rf: "roof",
  raum: "room",
  rm: "room",
  l: "line",
  pl: "polyline",
  rec: "rect",
  c: "circle",
  a: "arc",
  bogen: "arc",
  el: "ellipse",
  sp: "spline",
  dim: "dimension",
  bemassung: "dimension",
  kt: "kote",
  hoehenkote: "kote",
  bz: "bezier",
  tx: "text",
  txt: "text",
  beschriftung: "text",
  m: "move",
  s: "mirror",
  spiegeln: "mirror",
  j: "join",
  verbinden: "join",
  cp: "copy",
  o: "offset",
  ex: "extrude",
  tr: "trim",
  ext: "extend",
  verlaengern: "extend",
  verlängern: "extend",
  fi: "fillet",
  verrunden: "fillet",
  ch: "chamfer",
  fasen: "chamfer",
  ml: "multiline",
  parallel: "multiline",
  imp: "import",
  ter: "terrain",
  schnittlinie: "sectionline",
  ansichtslinie: "viewline",
  bezugspunkt: "georef",
  nullpunkt: "georef",
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
