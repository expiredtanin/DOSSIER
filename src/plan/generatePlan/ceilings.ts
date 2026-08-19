// Decken-Domäne des Grundriss-Generators: die Decke liegt als Slab ÜBER der
// Grundriss-Schnittebene und wird daher als flächiger Aufsicht-Umriss
// gezeichnet (nicht als Schicht-Querschnitt wie eine Wand) — die Kante wird
// gegen die {@link WallFootprint}s der darunterliegenden Wände geclippt, damit
// sie dort nicht durch die Wand-Poché schlägt.

import type { Ceiling, LayerCategory, Project } from "../../model/types";
import { getCeilingType, getComponent } from "../../model/types";
import { mergeHoles } from "../../geometry/polygonHoles";
import { add, scale, sub } from "../../model/geometry";
import {
  NO_HATCH,
  OVERHEAD_DASH,
  POCHE_STROKE,
  LAYER_DETAIL_FACTOR,
  LAYER_LINE_MM,
  pocheFill,
  resolveForeground,
  resolveHatch,
  resolveHatchId,
  type DetailLevel,
  type Primitive,
} from "./shared";
import { segmentInsideWallBand, subtractIntervals, type WallFootprint } from "./walls";

/**
 * Decken-Poché im Grundriss: die Decke liegt als Slab ÜBER der Schnittebene und
 * wird daher als geschlossener Umriss ihres Grundriss-Polygons gezeichnet — eine
 * gefüllte + schraffierte Fläche plus eine kräftige Umrisslinie. Fill/Schraffur
 * stammen aus dem BAUTEIL der ersten (obersten) Schicht des Aufbau-Typs (analog
 * zur Wand-Schichtauflösung); die Umrissfarbe aus der optionalen Decken-Farbe
 * bzw. dem Poché-Strich. Jedes Polygon trägt die `ceilingId` für die Auswahl.
 *
 * BEWUSST FLÄCHIG, auch bei mehrschichtigem Deckentyp: anders als die Wand
 * (deren Schichten im Grundriss als Querschnitt sichtbar sind) liegt der
 * Schichtaufbau einer Decke in Z (oben → unten) — von oben unsichtbar. Die
 * Schichtbänderung erscheint daher NUR im Schnitt (siehe `toSection.ts`), nicht
 * hier. Im Detailgrad „grob" entfällt die Schraffur (nur Fläche + Umriss);
 * „mittel"/„fein" zeigen die Ansichts-Schraffur des Bauteils (`viewHatchId`,
 * Default weiss) — die frontal gesehene Aufsicht ist kein Schnitt. `lwMm` ist
 * die Kategorie-Strichstärke.
 */
export function addCeilingPoche(
  out: Primitive[],
  project: Project,
  ceiling: Ceiling,
  greyed: boolean,
  detail: DetailLevel,
  category: LayerCategory | undefined,
  wallFootprints: WallFootprint[],
): void {
  const pts = ceiling.outline;
  if (pts.length < 3) return;
  // Aussparungen (Treppenauge/Schacht) über den Brücken-Trick in EINEN
  // einfachen Poché-Ring einfügen: kein `openings` ⇒ `ring === pts` und
  // `bridgeEdges` leer (exakt heutiger Codepfad, siehe {@link mergeHoles}).
  const ceilingHoles = ceiling.openings ?? [];
  const { ring, bridgeEdges } = ceilingHoles.length
    ? mergeHoles(pts, ceilingHoles)
    : { ring: pts, bridgeEdges: [] as number[] };
  const wt = getCeilingType(project, ceiling);
  const comp = wt.layers.length > 0 ? getComponent(project, wt.layers[0].componentId) : null;
  const stroke = ceiling.color ?? POCHE_STROKE;
  const ceilingId = ceiling.id;

  // Gefüllte Fläche mit der Ansichts-Schraffur: die Decke wird im Grundriss
  // frontal von unten gesehen, nicht aufgeschnitten — daher greift hier
  // NICHT die Schnitt-Schraffur (die gehört auf echte Schnittflächen, siehe
  // resolveCeilingSectionStyle/splitSlabLayers), sondern `viewHatchId`. Fehlt
  // sie (Default), bleibt die Aufsicht weiss. Im Detailgrad „grob" entfällt
  // die Schraffur ganz (nur Fläche + Umriss). Das Attribut-Override
  // `ceiling.hatchId` (+ `hatchSource`) überschreibt diese Ansichts-Schraffur
  // genauso wie die Schnitt-Schraffur in {@link resolveCeilingSectionStyle}.
  const effectiveViewHatchId = resolveHatchId(
    ceiling.hatchId,
    ceiling.hatchSource,
    category,
    comp?.viewHatchId,
  );
  const hatch =
    detail !== "grob" && comp && effectiveViewHatchId
      ? resolveHatch(
          project,
          effectiveViewHatchId,
          undefined,
          resolveForeground(comp, ceiling.foreground, category, ceiling.foregroundSource),
        )
      : NO_HATCH;
  // Gefüllte Fläche OHNE eigenen Umriss (stroke:"none"): die Decke liegt unter
  // der Wand-Poché; ihre Kante wird separat als verdeckungs-geclippte Linie
  // gezeichnet (s. u.), damit sie nicht durch die darüberstehenden Wände schlägt.
  // Trägt weiterhin die `ceilingId` für die Links-Klick-Auswahl der Fläche.
  out.push({
    kind: "polygon",
    pts: ring,
    fill: comp ? pocheFill(hatch.pattern) : "none",
    stroke: "none",
    strokeWidthMm: 0,
    hatch,
    greyed,
    ceilingId,
    ...(bridgeEdges.length ? { noStrokeEdges: bridgeEdges } : {}),
  });
  // Kräftige Umrisslinie NUR dort, wo keine Wand die Decke verdeckt: jede
  // Umriss-Kante (inkl. Lochränder, die als Teil des Rings automatisch
  // mitgestrichen werden) gegen die Wand-Footprints clippen und die freien
  // Teilstücke als Linien ausgeben. Liegt die Decke deckungsgleich unter den
  // Wänden (Regelfall: Deckenumriss = Gebäude-/Wand-Mittellinien), entfällt
  // der Umriss ganz; nur Überstände (Vordach/Balkon jenseits der Wand)
  // bleiben sichtbar. Brückenkanten (künstliche Verbindung Aussenring↔Loch)
  // werden NICHT gestrichen.
  const n = ring.length;
  const bridgeSet = new Set(bridgeEdges);
  for (let i = 0; i < n; i++) {
    if (bridgeSet.has(i)) continue;
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const holes: Array<[number, number]> = [];
    for (const fp of wallFootprints) {
      const iv = segmentInsideWallBand(a, b, fp);
      if (iv) holes.push(iv);
    }
    const d = sub(b, a);
    for (const [t0, t1] of subtractIntervals(0, 1, holes)) {
      out.push({
        kind: "line",
        a: add(a, scale(d, t0)),
        b: add(a, scale(d, t1)),
        cls: "ceiling-outline",
        // Überkopf-Ansichtslinie (Decke liegt als Slab über der Schnittebene) →
        // gestrichelte Haarlinie statt kräftiger Volllinie (BIM-Konvention).
        weightMm: LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail],
        dash: OVERHEAD_DASH,
        color: stroke,
        greyed,
      });
    }
  }
}
