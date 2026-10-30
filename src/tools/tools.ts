// Werkzeug-Registry (docs/design/drawing-tools.md §3, §4, §10). Alle Zeichenwerkzeuge sind an
// Befehle gekoppelt (TOOL_COMMAND in App.tsx); die Elemente baut der Kern ([K4] S3,
// `src-tauri/core/src/cmd_create.rs`). Hier stehen nur noch Platzhalter (Label, Hinweis) und
// das Auswahl-Werkzeug.

import type { Tool, ToolId } from "./types";

// ── Select ──────────────────────────────────────────────────────────────────
// Reines Platzhalter-Werkzeug: die Auswahl-/Marquee-Logik bleibt in PlanView;
// der Controller ruft dieses Werkzeug für "select" gar nicht erst auf.
const selectTool: Tool = {
  id: "select",
  labelKey: "tool.select",
  hintKey: () => "tool.select.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Wall / Ceiling ───────────────────────────────────────────────────────────
// An die gekoppelten Befehle `wall`/`ceiling` (TOOL_COMMAND in App.tsx) gebunden: Klick und
// getipptes „wall“ münden in denselben Befehl, die Elemente baut der Kern ([K4] S3,
// `cmd_create.rs`). Diese Tool-Objekte sind reine Platzhalter (wie window/door).
const wallTool: Tool = {
  id: "wall",
  labelKey: "tool.wall",
  floorOnly: true,
  hintKey: () => "tool.wall.firstPoint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

const ceilingTool: Tool = {
  id: "ceiling",
  labelKey: "tool.ceiling",
  floorOnly: true,
  hintKey: () => "tool.ceiling.firstPoint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Window / Door (Öffnungen) ─────────────────────────────────────────────────
// Beide sind an den gekoppelten Befehl `fenster`/`tuer` (TOOL_COMMAND) gebunden:
// der interaktive Ablauf (Host-Wand picken → Position → committen) läuft komplett
// in der CommandEngine. Diese Tool-Objekte sind reine Platzhalter (wie `select`);
// der Controller ruft sie nicht auf, sobald der gekoppelte Befehl läuft.
const windowTool: Tool = {
  id: "window",
  labelKey: "tool.window",
  floorOnly: true,
  hintKey: () => "tool.window.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

const doorTool: Tool = {
  id: "door",
  labelKey: "tool.door",
  floorOnly: true,
  hintKey: () => "tool.door.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Stair (Treppe) ───────────────────────────────────────────────────────────
// An den gekoppelten Befehl `stair` (TOOL_COMMAND) gebunden: der interaktive
// Ablauf (Startpunkt → Laufrichtung/Ende → committen) läuft komplett in der
// CommandEngine. Dieses Tool-Objekt ist ein reiner Platzhalter (wie window/door);
// der Controller ruft es nicht auf, sobald der gekoppelte Befehl läuft.
const stairTool: Tool = {
  id: "stair",
  labelKey: "tool.stair",
  floorOnly: true,
  hintKey: () => "tool.stair.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Room (Raum) ──────────────────────────────────────────────────────────────
// An den gekoppelten Befehl `room` (TOOL_COMMAND) gebunden: der interaktive
// Ablauf (Klick-innen zur Erkennung ODER manueller Umriss) läuft komplett in der
// CommandEngine. Dieses Tool-Objekt ist ein reiner Platzhalter (wie stair/window);
// der Controller ruft es nicht auf, sobald der gekoppelte Befehl läuft.
const roomTool: Tool = {
  id: "room",
  labelKey: "tool.room",
  floorOnly: true,
  hintKey: () => "tool.room.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Line / Polyline / Rectangle ──────────────────────────────────────────────
// Gekoppelt an die Befehle `line`/`polyline`/`rect` (TOOL_COMMAND); reine Platzhalter.
const lineTool: Tool = {
  id: "line",
  labelKey: "tool.line",
  hintKey: () => "tool.line.firstPoint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Konstruktionslinie: Platzhalter-Werkzeug, gekoppelt an den `xline`-Befehl
// (zwei Punkte legen die Richtung fest, Rendering/Snapping verlängern weit
// darüber hinaus). Nicht floorOnly (freies 2D-Element).
const xlineTool: Tool = {
  id: "xline",
  labelKey: "tool.xline",
  hintKey: () => "tool.xline.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Strahl: Platzhalter-Werkzeug, gekoppelt an den `ray`-Befehl (wie `xline`,
// aber nur einseitig verlängert). Nicht floorOnly (freies 2D-Element).
const rayTool: Tool = {
  id: "ray",
  labelKey: "tool.ray",
  hintKey: () => "tool.ray.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

const polylineTool: Tool = {
  id: "polyline",
  labelKey: "tool.polyline",
  hintKey: () => "tool.polyline.firstPoint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

const rectTool: Tool = {
  id: "rect",
  labelKey: "tool.rect",
  hintKey: () => "tool.rect.firstCorner",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Kreis: Platzhalter-Werkzeug (analog window/door), gekoppelt an den
// `circle`-Befehl (TOOL_COMMAND in App.tsx). Der eigentliche Ablauf
// (Mittelpunkt → Radius) läuft über die Command-Engine — EIN Pfad für
// Toolbar-Klick und getipptes „circle". Nicht floorOnly (freie 2D-Zeichnung).
const circleTool: Tool = {
  id: "circle",
  labelKey: "tool.circle",
  hintKey: () => "tool.circle.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Bogen: Platzhalter-Werkzeug, gekoppelt an den `arc`-Befehl (3 Klicks:
// Mitte → Start/Radius → Ende). Wie Kreis nicht floorOnly.
const arcTool: Tool = {
  id: "arc",
  labelKey: "tool.arc",
  hintKey: () => "tool.arc.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Ellipse: Platzhalter-Werkzeug, gekoppelt an den `ellipse`-Befehl (zwei
// Bounding-Box-Ecken). Wie Kreis/Bogen nicht floorOnly.
const ellipseTool: Tool = {
  id: "ellipse",
  labelKey: "tool.ellipse",
  hintKey: () => "tool.ellipse.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Regelmässiges Vieleck: Platzhalter-Werkzeug, gekoppelt an den `polygon`-
// Befehl (Mittelpunkt → Radius, Ecken-Zahl per Inline-Option). Wie Kreis/
// Bogen/Ellipse nicht floorOnly; committet als geschlossene Polylinie.
const polygonTool: Tool = {
  id: "polygon",
  labelKey: "tool.polygon",
  hintKey: () => "tool.polygon.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Block einfügen: Platzhalter-Werkzeug, gekoppelt an den `block`-Befehl
// (Einfügepunkt, aktive Definition per Inline-Option). Nicht floorOnly.
const blockTool: Tool = {
  id: "block",
  labelKey: "tool.block",
  hintKey: () => "tool.block.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Spline: Platzhalter-Werkzeug, gekoppelt an den `spline`-Befehl (Wegpunkte,
// wie Polylinie, aber geglättet). Nicht floorOnly.
const splineTool: Tool = {
  id: "spline",
  labelKey: "tool.spline",
  hintKey: () => "tool.spline.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Bezier: Platzhalter-Werkzeug, gekoppelt an den `bezier`-Befehl (manuelle
// Kontrollpunkt-Kette). Nicht floorOnly.
const bezierTool: Tool = {
  id: "bezier",
  labelKey: "tool.bezier",
  hintKey: () => "tool.bezier.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Bemassung: Platzhalter-Werkzeug, gekoppelt an den `dimension`-Befehl (zwei
// Punkte + Lage der Masslinie). Nicht floorOnly.
const dimensionTool: Tool = {
  id: "dimension",
  labelKey: "tool.dimension",
  hintKey: () => "tool.dimension.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Höhenkote: Platzhalter-Werkzeug, gekoppelt an den `kote`-Befehl (Punkt →
// getippter Höhenwert). Nicht floorOnly.
const koteTool: Tool = {
  id: "kote",
  labelKey: "tool.kote",
  hintKey: () => "tool.kote.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Detail-/Schnitt-Verweis: Platzhalter-Werkzeug, gekoppelt an den
// `detailref`-Befehl (ein Klick → Verweisblase, Label/Blattverknüpfung
// danach im Attribute-Panel). Freies 2D-Element (nicht floorOnly).
const detailrefTool: Tool = {
  id: "detailref",
  labelKey: "tool.detailref",
  hintKey: () => "tool.detailref.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Massstabsbalken: Platzhalter-Werkzeug, gekoppelt an den `scalebar`-Befehl
// (ein Klick, Segmentlänge/-anzahl per Option). Freies 2D-Element.
const scalebarTool: Tool = {
  id: "scalebar",
  labelKey: "tool.scalebar",
  hintKey: () => "tool.scalebar.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Revisionswolke: Platzhalter-Werkzeug, gekoppelt an den `revcloud`-Befehl
// (Punktfolge → Beulen-Kontur). Freies 2D-Element (nicht floorOnly).
const revcloudTool: Tool = {
  id: "revcloud",
  labelKey: "tool.revcloud",
  hintKey: () => "tool.revcloud.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Punkt-/Knotenmarker: Platzhalter-Werkzeug, gekoppelt an den
// `pointmarker`-Befehl (ein Klick → Kreuz-in-Kreis-Symbol). Freies
// 2D-Element (nicht floorOnly).
const pointmarkerTool: Tool = {
  id: "pointmarker",
  labelKey: "tool.pointmarker",
  hintKey: () => "tool.pointmarker.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Achsraster ([112]): Platzhalter-Werkzeug, gekoppelt an den `grid`-Befehl (Ursprung + Feldweiten).
const gridTool: Tool = {
  id: "grid",
  labelKey: "tool.grid",
  hintKey: () => "tool.grid.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Wipeout/Maskenregion: Platzhalter-Werkzeug, gekoppelt an den
// `wipeout`-Befehl (Punktfolge, schliesst automatisch → weisse Maskenfläche).
// Freies 2D-Element (nicht floorOnly).
const wipeoutTool: Tool = {
  id: "wipeout",
  labelKey: "tool.wipeout",
  hintKey: () => "tool.wipeout.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Text: Platzhalter-Werkzeug, gekoppelt an den `text`-Befehl (Ankerpunkt →
// getippte Zeile). Wie Kreis/Bogen nicht floorOnly (freies 2D-Element).
const textTool: Tool = {
  id: "text",
  labelKey: "tool.text",
  hintKey: () => "tool.text.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Leader: Platzhalter-Werkzeug, gekoppelt an den `leader`-Befehl (Zielpunkt →
// Textanker → getippte Zeile, wie Text). Freies 2D-Element (nicht floorOnly).
const leaderTool: Tool = {
  id: "leader",
  labelKey: "tool.leader",
  hintKey: () => "tool.leader.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Text-entlang-Pfad: Platzhalter-Werkzeug, gekoppelt an den `textpath`-Befehl
// (≥2 Pfadpunkte → getippte Zeile, wie Text). Freies 2D-Element.
const textpathTool: Tool = {
  id: "textpath",
  labelKey: "tool.textpath",
  hintKey: () => "tool.textpath.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Textspalte: Platzhalter-Werkzeug, gekoppelt an den `textbox`-Befehl (Anker →
// Spaltenbreite → getippte Zeile). Freies 2D-Element (nicht floorOnly).
const textboxTool: Tool = {
  id: "textbox",
  labelKey: "tool.textbox",
  hintKey: () => "tool.textbox.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Bild einfügen: KEIN Klick-Platzieren wie die übrigen Zeichen-Werkzeuge —
// die Datei-Auswahl ist async (Dateidialog), daher fängt `onSelectTool`
// (App.tsx) die ID VOR der normalen Werkzeug-Aktivierung ab und öffnet direkt
// den Datei-Dialog (s. dortigen Kommentar). Dieses Objekt existiert nur, damit
// `TOOLS`/`ToolsPanel` eine vollständige Abbildung + Label/Hint haben.
const imageTool: Tool = {
  id: "image",
  labelKey: "tool.image",
  hintKey: () => "tool.image.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Registry ─────────────────────────────────────────────────────────────────

const TOOLS: Record<ToolId, Tool> = {
  select: selectTool,
  wall: wallTool,
  ceiling: ceilingTool,
  window: windowTool,
  door: doorTool,
  stair: stairTool,
  room: roomTool,
  line: lineTool,
  xline: xlineTool,
  ray: rayTool,
  polyline: polylineTool,
  rect: rectTool,
  circle: circleTool,
  arc: arcTool,
  ellipse: ellipseTool,
  polygon: polygonTool,
  block: blockTool,
  spline: splineTool,
  bezier: bezierTool,
  dimension: dimensionTool,
  kote: koteTool,
  detailref: detailrefTool,
  scalebar: scalebarTool,
  revcloud: revcloudTool,
  pointmarker: pointmarkerTool,
  grid: gridTool,
  wipeout: wipeoutTool,
  text: textTool,
  leader: leaderTool,
  textpath: textpathTool,
  textbox: textboxTool,
  image: imageTool,
};

/** Liefert das Werkzeug zur ID. */
export function getTool(id: ToolId): Tool {
  return TOOLS[id];
}

