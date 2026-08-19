// Dach-Domäne des Grundriss-Generators (Dachaufsicht): reine Linien-Darstellung
// ohne Poché — Traufe/First/Grat/Knick aus `roofGeometry`.

import type { LayerCategory, Project, Roof } from "../../model/types";
import { getComponent, roofLayers } from "../../model/types";
import { roofGeometry } from "../../geometry/roof";
import {
  NO_HATCH,
  POCHE_STROKE,
  ROOF_BREAK_DASH,
  ROOF_BREAK_MM,
  ROOF_EAVES_MM,
  ROOF_HIP_MM,
  ROOF_RIDGE_MM,
  resolveHatch,
  type Primitive,
} from "./shared";

/**
 * Dach im Grundriss (Dachaufsicht): reine Linien-Darstellung ohne Poché — die
 * 2D-Geometrie aus `roofGeometry` (First/Grat/Knick hängen NICHT von der
 * Traufhöhe ab, daher `eavesZ=0`):
 *  • Traufe (`eaves`): geschlossener Umriss-Ring als mittlere Haarlinie.
 *  • First (`ridges`): kräftige Volllinie, etwas stärker als die Traufe.
 *  • Grat (`hips`, Walm/Zelt): Volllinie zwischen Traufe- und First-Stärke.
 *  • Knick (`breaks`, Mansarde): dünne gestrichelte Linie.
 * Farbe: `roof.color` übersteuert sonst die Kategorie-Farbe (analog Stützen-
 * Poché), Default die neutrale Poché-Tinte.
 */
export function addRoof(
  out: Primitive[],
  project: Project,
  roof: Roof,
  greyed: boolean,
  category: LayerCategory | undefined,
): void {
  const stroke = roof.color ?? category?.color ?? POCHE_STROKE;
  const geo = roofGeometry(roof, 0);

  // Ansichts-Poché der Dachaufsicht: das Dach liegt ÜBER der Schnittebene und
  // wird von oben gesehen (nicht geschnitten) → Ansichts-Schraffur
  // (viewHatchId) der ÄUSSERSTEN Schicht (Eindeckung) des Dachtyps, analog dem
  // Decken-Poché (Aufsicht = erste Lage). Ohne Dachtyp/viewHatchId keine
  // Schraffur (weiss) — die Fläche bleibt trotzdem das Pick-Polygon.
  let viewHatch = NO_HATCH;
  const firstLayer = roofLayers(project, roof)[0];
  if (firstLayer?.componentId) {
    try {
      const comp = getComponent(project, firstLayer.componentId);
      if (comp.viewHatchId) viewHatch = resolveHatch(project, comp.viewHatchId);
    } catch {
      viewHatch = NO_HATCH;
    }
  }

  // Pick-Polygon über der Traufe-Fläche (macht das Dach über die ganze Fläche
  // per Links-Klick selektierbar) — trägt jetzt zusätzlich die Ansichts-
  // Schraffur der Eindeckung (fill bleibt "none": keine Volltonfüllung, nur
  // Musterlinien). PlanView testet die `pts` (Punkt-in-Polygon).
  if (geo.eaves.length >= 3) {
    out.push({
      kind: "polygon",
      pts: geo.eaves,
      fill: "none",
      stroke: "none",
      strokeWidthMm: 0,
      hatch: viewHatch,
      greyed,
      roofId: roof.id,
    });
  }

  const n = geo.eaves.length;
  for (let i = 0; i < n; i++) {
    out.push({
      kind: "line",
      a: geo.eaves[i],
      b: geo.eaves[(i + 1) % n],
      cls: "roof-eaves",
      weightMm: ROOF_EAVES_MM,
      color: stroke,
      greyed,
    });
  }
  for (const [a, b] of geo.ridges) {
    out.push({ kind: "line", a, b, cls: "roof-ridge", weightMm: ROOF_RIDGE_MM, color: stroke, greyed });
  }
  for (const [a, b] of geo.hips) {
    out.push({ kind: "line", a, b, cls: "roof-hip", weightMm: ROOF_HIP_MM, color: stroke, greyed });
  }
  for (const [a, b] of geo.breaks) {
    out.push({
      kind: "line",
      a,
      b,
      cls: "roof-break",
      weightMm: ROOF_BREAK_MM,
      dash: ROOF_BREAK_DASH,
      color: stroke,
      greyed,
    });
  }
}
