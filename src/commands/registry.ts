// Befehls-Registry (docs/design/rhino-command-system.md §3.2) — `COMMANDS` +
// Aliase + Präfix-Autocomplete. Einzelne Befehle leben als eigene Module unter
// `cmds/`, sodass weitere Befehle ADDITIV (ohne Änderung an Engine/App)
// dazukommen: hier importieren + registrieren, fertig.

import type { Command } from "./types";
import { lineCommand } from "./cmds/line";
import { polylineCommand } from "./cmds/polyline";
import { xlineCommand } from "./cmds/xline";
import { rayCommand } from "./cmds/ray";
import { wallCommand } from "./cmds/wall";
import { ceilingCommand } from "./cmds/ceiling";
import { openingCommand, fensterCommand, tuerCommand } from "./cmds/opening";
import { stairCommand } from "./cmds/stair";
import { columnCommand } from "./cmds/column";
import { roofCommand } from "./cmds/roof";
import { solidCommand } from "./cmds/solid";
import { solidBoolCommand } from "./cmds/solidbool";
import { voidBoxCommand } from "./cmds/voidbox";
import { ceilingOpeningCommand } from "./cmds/ceilingOpening";
import { roofWindowCommand } from "./cmds/roofWindow";
import { dormerCommand } from "./cmds/dormer";
import { roofHoleCommand } from "./cmds/roofHole";
import { roomCommand } from "./cmds/room";
import { rectCommand } from "./cmds/rect";
import { circleCommand } from "./cmds/circle";
import { arcCommand } from "./cmds/arc";
import { ellipseCommand } from "./cmds/ellipse";
import { polygonCommand } from "./cmds/polygon";
import { splineCommand } from "./cmds/spline";
import { bezierCommand } from "./cmds/bezier";
import { dimensionCommand } from "./cmds/dimension";
import { koteCommand } from "./cmds/kote";
import { detailrefCommand } from "./cmds/detailref";
import { scalebarCommand } from "./cmds/scalebar";
import { revcloudCommand } from "./cmds/revcloud";
import { pointmarkerCommand } from "./cmds/pointmarker";
import { wipeoutCommand } from "./cmds/wipeout";
import { textCommand } from "./cmds/text";
import { leaderCommand } from "./cmds/leader";
import { textpathCommand } from "./cmds/textpath";
import { textboxCommand } from "./cmds/textbox";
import { moveCommand } from "./cmds/move";
import { mirrorCommand } from "./cmds/mirror";
import { rotateCommand } from "./cmds/rotate";
import { scaleCommand } from "./cmds/scale";
import { explodeCommand } from "./cmds/explode";
import { dimdetachCommand } from "./cmds/dimdetach";
import { autodimCommand } from "./cmds/autodim";
import { alignCommand } from "./cmds/align";
import { joinCommand } from "./cmds/join";
import { copyCommand } from "./cmds/copy";
import { arrayCommand } from "./cmds/array";
import { offsetCommand } from "./cmds/offset";
import { extrudeCommand } from "./cmds/extrude";
import { trimCommand } from "./cmds/trim";
import { breakCommand } from "./cmds/break";
import { extendCommand } from "./cmds/extend";
import { filletCommand } from "./cmds/fillet";
import { chamferCommand } from "./cmds/chamfer";
import { multilineCommand } from "./cmds/multiline";
import { importCommand } from "./cmds/import";
import { terrainCommand } from "./cmds/terrain";
import { measureCommand } from "./cmds/measure";
import { sectionLineCommand, viewLineCommand } from "./cmds/sectionline";
import { georefCommand } from "./cmds/georef";
import { blockCommand } from "./cmds/block";
import { defblockCommand } from "./cmds/defblock";

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
  solid: solidCommand,
  solidbool: solidBoolCommand,
  voidbox: voidBoxCommand,
  ceilingopening: ceilingOpeningCommand,
  roofwindow: roofWindowCommand,
  dormer: dormerCommand,
  roofhole: roofHoleCommand,
  room: roomCommand,
  line: lineCommand,
  polyline: polylineCommand,
  xline: xlineCommand,
  ray: rayCommand,
  rect: rectCommand,
  circle: circleCommand,
  arc: arcCommand,
  ellipse: ellipseCommand,
  polygon: polygonCommand,
  spline: splineCommand,
  bezier: bezierCommand,
  dimension: dimensionCommand,
  kote: koteCommand,
  detailref: detailrefCommand,
  scalebar: scalebarCommand,
  revcloud: revcloudCommand,
  pointmarker: pointmarkerCommand,
  wipeout: wipeoutCommand,
  text: textCommand,
  leader: leaderCommand,
  textpath: textpathCommand,
  textbox: textboxCommand,
  move: moveCommand,
  mirror: mirrorCommand,
  rotate: rotateCommand,
  scale: scaleCommand,
  explode: explodeCommand,
  dimdetach: dimdetachCommand,
  autodim: autodimCommand,
  align: alignCommand,
  join: joinCommand,
  copy: copyCommand,
  array: arrayCommand,
  offset: offsetCommand,
  extrude: extrudeCommand,
  trim: trimCommand,
  break: breakCommand,
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
  block: blockCommand,
  defblock: defblockCommand,
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
  koerper: "solid",
  durchbruch: "voidbox",
  nische: "voidbox",
  void: "voidbox",
  koerperbool: "solidbool",
  verschneiden: "solidbool",
  bool: "solidbool",
  körper: "solid",
  kugel: "solid",
  body: "solid",
  deckenloch: "ceilingopening",
  aussparung: "ceilingopening",
  dachfenster: "roofwindow",
  oberlicht: "roofwindow",
  gaube: "dormer",
  lukarne: "dormer",
  dachhof: "roofhole",
  lichthof: "roofhole",
  rf: "roof",
  raum: "room",
  rm: "room",
  l: "line",
  pl: "polyline",
  xl: "xline",
  hilfslinie: "xline",
  konstruktionslinie: "xline",
  ry: "ray",
  strahl: "ray",
  bl: "block",
  symbol: "block",
  db: "defblock",
  blockdef: "defblock",
  rec: "rect",
  c: "circle",
  a: "arc",
  bogen: "arc",
  el: "ellipse",
  vg: "polygon",
  vieleck: "polygon",
  sp: "spline",
  dim: "dimension",
  bemassung: "dimension",
  kt: "kote",
  hoehenkote: "kote",
  dr: "detailref",
  detail: "detailref",
  verweis: "detailref",
  sb: "scalebar",
  massstabsbalken: "scalebar",
  massstab: "scalebar",
  rv: "revcloud",
  wolke: "revcloud",
  revisionswolke: "revcloud",
  pm: "pointmarker",
  punkt: "pointmarker",
  knoten: "pointmarker",
  wo: "wipeout",
  maske: "wipeout",
  maskierung: "wipeout",
  bz: "bezier",
  tx: "text",
  txt: "text",
  beschriftung: "text",
  ld: "leader",
  vorführer: "leader",
  txp: "textpath",
  pfadtext: "textpath",
  m: "move",
  s: "mirror",
  spiegeln: "mirror",
  ro: "rotate",
  drehen: "rotate",
  sc: "scale",
  skalieren: "scale",
  x: "explode",
  aufloesen: "explode",
  bml: "dimdetach",
  bemassungloesen: "dimdetach",
  ab: "autodim",
  aussenbemassung: "autodim",
  al: "align",
  ausrichten: "align",
  j: "join",
  verbinden: "join",
  cp: "copy",
  ar: "array",
  feld: "array",
  o: "offset",
  ex: "extrude",
  tr: "trim",
  br: "break",
  unterbrechen: "break",
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
 * Löst eine getippte Eingabe zu einem Befehl auf: erst exakter Name, dann
 * NUTZER-Kürzel (`customAliases`, s. `state/commandAliasOverrides.ts` —
 * Nutzer-Wunsch „Befehls-Kürzel sind hart codiert, keine Remap-UI"), dann das
 * eingebaute Kürzel, dann eindeutiges Präfix (case-insensitiv). Mehrdeutige/
 * leere Präfixe → null. Ein Nutzer-Kürzel kann ein EINGEBAUTES Kürzel
 * überschreiben (gleicher Schlüssel, anderes Ziel), aber NIE einen exakten
 * Befehlsnamen (der gewinnt immer zuerst — sonst würde getipptes „wall"
 * plötzlich etwas anderes tun).
 */
export function resolveCommand(raw: string, customAliases?: Record<string, string>): Command | null {
  const q = raw.trim().toLowerCase();
  if (q === "") return null;
  if (COMMANDS[q]) return COMMANDS[q];
  if (customAliases?.[q]) return COMMANDS[customAliases[q]] ?? null;
  if (ALIASES[q]) return COMMANDS[ALIASES[q]] ?? null;
  const matches = autocomplete(q);
  if (matches.length === 1) return COMMANDS[matches[0]] ?? null;
  // Exaktes Präfix, das auch ein Alias ist, hat Vorrang, wenn eindeutig.
  return null;
}

/** Alle bekannten Befehlsnamen, alphabetisch — für die Kürzel-Remap-UI. */
export function allCommandNames(): string[] {
  return Object.keys(COMMANDS).sort();
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
