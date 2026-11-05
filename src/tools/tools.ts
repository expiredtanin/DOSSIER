// Werkzeug-Liste der Palette ([123]): nur noch Beschriftung, Hinweis, Geschoss-Bindung und der
// gekoppelte Befehl. Alle Zeichenwerkzeuge SIND Engine-Befehle (Klick aufs Werkzeug startet den
// Befehl, die Elemente baut der Kern, `cmd_create.rs`); „select" ist der Auswahl-Modus, „image"
// öffnet den Datei-Dialog (`onSelectTool` in App.tsx). Die frühere Tool-Registry mit eigenen
// Klick-/Vorschau-Handlern ist entfallen.

import type { ToolId } from "./types";

export interface ToolInfo {
  /** UI-Label-Key (i18n), z. B. „tool.wall". */
  labelKey: string;
  /** Hinweis-Key (Tooltip). */
  hintKey: string;
  /** Nur auf Geschossen aktiv? (Wand braucht ein Geschoss.) */
  floorOnly?: boolean;
  /** Gekoppelter Engine-Befehl; fehlt bei „select" und „image". */
  command?: string;
}

const TOOLS: Record<ToolId, ToolInfo> = {
  select: { labelKey: "tool.select", hintKey: "tool.select.hint" },
  wall: { labelKey: "tool.wall", hintKey: "tool.wall.firstPoint", floorOnly: true, command: "wall" },
  ceiling: { labelKey: "tool.ceiling", hintKey: "tool.ceiling.firstPoint", floorOnly: true, command: "ceiling" },
  window: { labelKey: "tool.window", hintKey: "tool.window.hint", floorOnly: true, command: "fenster" },
  door: { labelKey: "tool.door", hintKey: "tool.door.hint", floorOnly: true, command: "tuer" },
  stair: { labelKey: "tool.stair", hintKey: "tool.stair.hint", floorOnly: true, command: "stair" },
  room: { labelKey: "tool.room", hintKey: "tool.room.hint", floorOnly: true, command: "room" },
  line: { labelKey: "tool.line", hintKey: "tool.line.firstPoint", command: "line" },
  xline: { labelKey: "tool.xline", hintKey: "tool.xline.hint", command: "xline" },
  ray: { labelKey: "tool.ray", hintKey: "tool.ray.hint", command: "ray" },
  polyline: { labelKey: "tool.polyline", hintKey: "tool.polyline.firstPoint", command: "polyline" },
  rect: { labelKey: "tool.rect", hintKey: "tool.rect.firstCorner", command: "rect" },
  circle: { labelKey: "tool.circle", hintKey: "tool.circle.hint", command: "circle" },
  arc: { labelKey: "tool.arc", hintKey: "tool.arc.hint", command: "arc" },
  ellipse: { labelKey: "tool.ellipse", hintKey: "tool.ellipse.hint", command: "ellipse" },
  polygon: { labelKey: "tool.polygon", hintKey: "tool.polygon.hint", command: "polygon" },
  block: { labelKey: "tool.block", hintKey: "tool.block.hint", command: "block" },
  spline: { labelKey: "tool.spline", hintKey: "tool.spline.hint", command: "spline" },
  bezier: { labelKey: "tool.bezier", hintKey: "tool.bezier.hint", command: "bezier" },
  dimension: { labelKey: "tool.dimension", hintKey: "tool.dimension.hint", command: "dimension" },
  kote: { labelKey: "tool.kote", hintKey: "tool.kote.hint", command: "kote" },
  detailref: { labelKey: "tool.detailref", hintKey: "tool.detailref.hint", command: "detailref" },
  scalebar: { labelKey: "tool.scalebar", hintKey: "tool.scalebar.hint", command: "scalebar" },
  revcloud: { labelKey: "tool.revcloud", hintKey: "tool.revcloud.hint", command: "revcloud" },
  pointmarker: { labelKey: "tool.pointmarker", hintKey: "tool.pointmarker.hint", command: "pointmarker" },
  wand: { labelKey: "tool.wand", hintKey: "tool.wand.hint", command: "zauberstab" },
  grid: { labelKey: "tool.grid", hintKey: "tool.grid.hint", command: "grid" },
  wipeout: { labelKey: "tool.wipeout", hintKey: "tool.wipeout.hint", command: "wipeout" },
  text: { labelKey: "tool.text", hintKey: "tool.text.hint", command: "text" },
  leader: { labelKey: "tool.leader", hintKey: "tool.leader.hint", command: "leader" },
  textpath: { labelKey: "tool.textpath", hintKey: "tool.textpath.hint", command: "textpath" },
  textbox: { labelKey: "tool.textbox", hintKey: "tool.textbox.hint", command: "textbox" },
  image: { labelKey: "tool.image", hintKey: "tool.image.hint" },
};

/** Beschreibung des Werkzeugs zur ID. */
export function toolInfo(id: ToolId): ToolInfo {
  return TOOLS[id];
}
