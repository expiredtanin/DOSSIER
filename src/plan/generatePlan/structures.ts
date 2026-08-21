// Sonstige Tragwerks-/Fremdkörper-Domäne des Grundriss-Generators: Stützen
// (Poché-Querschnitt, analog zur Wand-/Deckenschicht-Auflösung) und der
// Footprint-Umriss einer truck-Extrusion (Haarlinie ohne Poché/Schraffur, da
// Extrusionen noch keine Kategorie-/Bauteil-Zuordnung tragen).

import type { Column, ExtrudedSolid, LayerCategory, Project } from "../../model/types";
import { getComponent } from "../../model/types";
import { columnFootprint } from "../../geometry/column";
import {
  HATCH_INK,
  HATCH_PAPER,
  MONO_INK,
  NO_HATCH,
  SYMBOL_HAIRLINE_MM,
  resolveBackground,
  resolveForeground,
  resolveHatch,
  resolveHatchId,
  type HatchRender,
  type Primitive,
} from "./shared";

/** Footprint-Farbe der truck-Extrusionen im Grundriss (identisch zum 3D-Orange EXTRUSION_RGB in toWalls3d.ts). */
const EXTRUSION_STROKE = "#d98c40";

/**
 * Footprint-Umriss eines extrudierten Körpers (truck-Integration) im Grundriss:
 * reine Haarlinie ohne Füllung/Schraffur — analog zur Ansichtslinie einer Wand
 * unter der Schnitthöhe (`addWallPoche` `viewOnly`), da der Körper (noch)
 * keine Schnitt-Poché/Kategorie-Zuordnung hat.
 */
export function addExtrudedSolidOutline(out: Primitive[], solid: ExtrudedSolid): void {
  out.push({
    kind: "polygon",
    pts: solid.points,
    fill: "none",
    stroke: EXTRUSION_STROKE,
    strokeWidthMm: SYMBOL_HAIRLINE_MM,
    hatch: NO_HATCH,
    extrudedSolidId: solid.id,
  });
}

/** Fallback-Poché-Füllung einer Stütze ohne (auflösbares) Bauteil: neutrale Tinte. */
const COLUMN_FALLBACK_FILL = "#3a3f47";

/**
 * Grundriss-Querschnitt einer Stütze (Column) als Schnitt-Poché: gefülltes
 * Polygon (Rechteck bzw. tesselliertes Kreisprofil), an `position` platziert und
 * um `rotation` gedreht. Trägt — sofern ein Bauteil (`componentId`) auflösbar ist
 * — dessen Füllung + Schraffur (dieselbe Auflösung wie Wand/Decke, {@link
 * ./shared.resolveHatch}); sonst eine neutrale Vollton-Poché. `columnId` macht
 * die Fläche links-klick-selektierbar (analog Extrusion/Raum).
 */
export function addColumnPoche(
  out: Primitive[],
  project: Project,
  column: Column,
  greyed: boolean,
  lwMm: number,
  category: LayerCategory | undefined,
): void {
  const pts = columnFootprint(column);
  const stroke = column.color ?? category?.color ?? MONO_INK;
  let fill = column.color ?? category?.color ?? COLUMN_FALLBACK_FILL;
  let hatch: HatchRender = NO_HATCH;
  if (column.componentId) {
    try {
      const comp = getComponent(project, column.componentId);
      const hatchId =
        resolveHatchId(column.hatchId, column.hatchSource, category, comp.hatchId) ?? comp.hatchId;
      const resolved = resolveHatch(
        project,
        hatchId,
        undefined,
        resolveForeground(comp, column.foreground, category, column.foregroundSource),
      );
      hatch = resolved;
      // SIA-Poché: neutraler Hintergrund (Tinte/Papier je nach Muster) statt
      // Bauteil-Albedo, es sei denn ein expliziter Hintergrund-Override greift
      // (analog addWallPoche: bgOverride ?? neutrale Poché).
      const bgOverride = resolveBackground(comp, column.background, category, column.backgroundSource);
      fill = bgOverride ?? (resolved.pattern === "solid" ? HATCH_INK : HATCH_PAPER);
    } catch {
      // Bauteil nicht auflösbar → neutrale Poché (Fallback bleibt bestehen).
    }
  }
  out.push({
    kind: "polygon",
    pts,
    fill,
    stroke,
    strokeWidthMm: lwMm,
    hatch,
    greyed,
    columnId: column.id,
  });
}
