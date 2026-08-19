// Kontext-Domäne des Grundriss-Generators: zeichnet `project.context`
// (Höhenlinien, importierte Gebäude/Terrain-Meshes) als dezente Referenz-
// Konturen — für Meshes der Grundriss-Fussabdruck nahe der Objekt-Unterkante,
// nicht das volle Drahtgitter.

import type { Project } from "../../model/types";
import { NO_HATCH, type Primitive } from "./shared";

/** Dezente Plan-Farbe der Kontext-Konturen (gedämpftes Grau). */
const CONTEXT_LINE_COLOR = "#9aa3ad";
/** Strichstärke der Kontext-Konturen (mm Papier, dünn). */
const CONTEXT_LINE_MM = 0.1;

/** Höhen-Toleranz (Meter): Dreieckskanten, deren beide Endpunkte höchstens so
 *  weit über der Objekt-Unterkante (minZ) liegen, gelten als „Sockelkante" und
 *  bilden den Grundriss-Fussabdruck eines importierten Gebäudes. */
const FOOTPRINT_Z_TOL = 0.6;

/**
 * Zeichnet die Kontext-Schicht `project.context` in den Grundriss:
 *  • ContourSet (Höhenlinien) → dünne Referenz-Linien (Z ignoriert).
 *  • ImportedMesh (Gebäude) → GRUNDRISS-FUSSABDRUCK: die Dreieckskanten nahe
 *    der Objekt-Unterkante (Sockel), auf die XY-Ebene projiziert und über
 *    quantisierte Endpunkte entdoppelt — so erscheint das importierte Haus als
 *    erkennbarer Umriss im Plan (Nutzer-Wunsch: „ich sehe es sonst nicht"),
 *    ohne das gesamte Dach-Drahtgitter dicht darüberzulegen.
 *  • TerrainMesh → nur der 2D-Umriss (Bounding-Box), da ein volles TIN-Gitter
 *    im Plan unbrauchbar dicht wäre.
 * Rein additiv — Wand-/Drawing-Darstellung bleibt unberührt.
 */
export function addContextContours(out: Primitive[], project: Project): void {
  const context = project.context ?? [];
  for (const obj of context) {
    if (obj.type === "contourSet") {
      for (const c of obj.contours) {
        const pts = c.pts;
        if (pts.length < 2) continue;
        const segEnd = c.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < segEnd; i++) {
          out.push({
            kind: "line",
            a: pts[i],
            b: pts[(i + 1) % pts.length],
            cls: "context-line",
            weightMm: CONTEXT_LINE_MM,
            color: CONTEXT_LINE_COLOR,
          });
        }
      }
    } else if (obj.type === "importedMesh") {
      addMeshFootprint(out, obj.positions, obj.indices);
      addContextPickRegion(out, obj.positions, obj.id);
    } else if (obj.type === "terrainMesh") {
      addMeshBboxOutline(out, obj.positions);
      addContextPickRegion(out, obj.positions, obj.id);
    }
  }
}

/**
 * Zeichnet den Grundriss-Fussabdruck eines Meshes: Dreieckskanten nahe der
 * Unterkante (minZ + {@link FOOTPRINT_Z_TOL}), auf XY projiziert, über
 * quantisierte Endpunkt-Schlüssel entdoppelt. `positions` = flaches [x,y,z…]-
 * Array (Modell-Meter, z = Höhe), `indices` = Dreiecks-Indizes.
 */
function addMeshFootprint(out: Primitive[], positions: number[], indices: number[]): void {
  const vcount = Math.floor(positions.length / 3);
  if (vcount < 3 || indices.length < 3) return;
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) if (positions[i] < minZ) minZ = positions[i];
  if (!Number.isFinite(minZ)) return;
  const zLimit = minZ + FOOTPRINT_Z_TOL;
  const q = (v: number) => Math.round(v * 100); // 1-cm-Quantisierung (Entdopplung)
  const seen = new Set<string>();
  const edge = (ia: number, ib: number) => {
    if (ia >= vcount || ib >= vcount) return;
    const za = positions[ia * 3 + 2];
    const zb = positions[ib * 3 + 2];
    if (za > zLimit || zb > zLimit) return; // nur Sockelkanten
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1];
    // Kanten-Schlüssel richtungsunabhängig (kleinerer Endpunkt zuerst).
    const ka = `${q(ax)},${q(ay)}`;
    const kb = `${q(bx)},${q(by)}`;
    if (ka === kb) return;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: "line",
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
      cls: "context-line",
      weightMm: CONTEXT_LINE_MM,
      color: CONTEXT_LINE_COLOR,
    });
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    edge(a, b);
    edge(b, c);
    edge(c, a);
  }
}

/** Zeichnet nur den achsenparallelen 2D-Umriss (Bounding-Box) eines Meshes —
 *  für Terrain, dessen volles TIN-Gitter im Plan zu dicht wäre. */
function addMeshBboxOutline(out: Primitive[], positions: number[]): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return;
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  for (let i = 0; i < 4; i++) {
    out.push({
      kind: "line",
      a: corners[i],
      b: corners[(i + 1) % 4],
      cls: "context-line",
      weightMm: CONTEXT_LINE_MM,
      color: CONTEXT_LINE_COLOR,
    });
  }
}

/**
 * Unsichtbares Pick-Band (Grundriss-Bounding-Box) für ein Kontext-Objekt
 * (importiertes Gebäude/Terrain) — klickbar per Punkt-in-Polygon in PlanView,
 * trägt die `ContextObject.id` (analog `sectionLineId`, s. dort). Macht das
 * Objekt IRGENDWO innerhalb seiner Grundfläche anklickbar (nicht nur exakt auf
 * der dünnen Umriss-/Fussabdrucklinie) — wie bei Wänden, deren Poché-Fläche
 * ebenfalls als Ganzes klickbar ist (Nutzer-Wunsch: „eigene Elemente wie Wände").
 * `positions` = flaches [x,y,z…]-Array (Modell-Meter); die Bbox nutzt NUR x/y,
 * unabhängig von der Höhe.
 */
function addContextPickRegion(out: Primitive[], positions: number[], id: string): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return;
  out.push({
    kind: "polygon",
    pts: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    fill: "none",
    stroke: "none",
    strokeWidthMm: 0,
    hatch: NO_HATCH,
    contextObjectId: id,
  });
}
