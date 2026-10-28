// Kontext-Domäne des Grundriss-Generators: zeichnet `project.context`
// (Höhenlinien, importierte Gebäude/Terrain-Meshes) als dezente Referenz-
// Konturen — für Meshes der Grundriss-Fussabdruck nahe der Objekt-Unterkante,
// nicht das volle Drahtgitter. Fussabdruck (Sockelkanten, entdoppelt) und Rahmen berechnet der
// Rust-Kern (`src-tauri/core/src/plan_misc.rs`, [K3a]).

import type { Project } from "../../model/types";
import { core } from "../../engine/coreWasm";
import { NO_HATCH, SHOW_ALL, type CategoryDisplayResolver, type Primitive } from "./shared";

/** Dezente Plan-Farbe der Kontext-Konturen (gedämpftes Grau). */
const CONTEXT_LINE_COLOR = "#9aa3ad";
/** Strichstärke der Kontext-Konturen (mm Papier, dünn). */
const CONTEXT_LINE_MM = 0.1;

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
 *
 * SICHTBARKEIT: jedes Objekt trägt (seit der Ebenen-Zuordnung der Kontext-
 * Schicht) optional eine `categoryCode` (s. `model/contextCategories.ts`) —
 * genau wie jedes andere Bauteil wird sie gegen `visibleCodes`/
 * `categoryDisplay` geprüft (Muster 1:1 aus `sections.ts::addSectionLines`).
 * Objekte OHNE `categoryCode` (ältere Importe vor dieser Erweiterung) bleiben
 * bewusst IMMER sichtbar (Rückwärtskompatibilität) statt stillschweigend zu
 * verschwinden.
 */
export function addContextContours(
  out: Primitive[],
  project: Project,
  visibleCodes?: Set<string>,
  categoryDisplay: CategoryDisplayResolver = SHOW_ALL,
): void {
  const context = project.context ?? [];
  for (const obj of context) {
    const code = obj.categoryCode;
    if (code !== undefined) {
      const d = categoryDisplay(code);
      if ((visibleCodes && !visibleCodes.has(code)) || !d.render) continue;
    }
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
 * Unterkante (minZ + 0.6 m), auf XY projiziert, über 1-cm-quantisierte Endpunkte
 * entdoppelt. `positions` = flaches [x,y,z…]-Array (Modell-Meter, z = Höhe),
 * `indices` = Dreiecks-Indizes.
 */
function addMeshFootprint(out: Primitive[], positions: number[], indices: number[]): void {
  const f = core().context_footprint_flat(Float64Array.from(positions), Float64Array.from(indices));
  for (let i = 0; i < f[0]; i++) {
    out.push({
      kind: "line",
      a: { x: f[1 + 4 * i], y: f[2 + 4 * i] },
      b: { x: f[3 + 4 * i], y: f[4 + 4 * i] },
      cls: "context-line",
      weightMm: CONTEXT_LINE_MM,
      color: CONTEXT_LINE_COLOR,
    });
  }
}

/** Grundriss-Rahmen eines Meshes (nur x/y) als vier Eckpunkte, oder `null` ohne Punkte. */
function meshBboxCorners(positions: number[]): { x: number; y: number }[] | null {
  const b = core().context_bbox_flat(Float64Array.from(positions));
  if (b.length === 0) return null;
  return [
    { x: b[0], y: b[1] },
    { x: b[2], y: b[1] },
    { x: b[2], y: b[3] },
    { x: b[0], y: b[3] },
  ];
}

/** Zeichnet nur den achsenparallelen 2D-Umriss (Bounding-Box) eines Meshes —
 *  für Terrain, dessen volles TIN-Gitter im Plan zu dicht wäre. */
function addMeshBboxOutline(out: Primitive[], positions: number[]): void {
  const corners = meshBboxCorners(positions);
  if (!corners) return;
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
 * ebenfalls als Ganzes klickbar ist.
 */
function addContextPickRegion(out: Primitive[], positions: number[], id: string): void {
  const pts = meshBboxCorners(positions);
  if (!pts) return;
  out.push({
    kind: "polygon",
    pts,
    fill: "none",
    stroke: "none",
    strokeWidthMm: 0,
    hatch: NO_HATCH,
    contextObjectId: id,
  });
}
