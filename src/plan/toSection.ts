// Schnitt-/Ansichts-Pipeline: bindet den analytischen render3d-Schnitt-Extraktor
// (`section.rs`, WASM-Export `cut_section_json`) an das Dokumentmodell an.
//
// Ablauf:
//   1. Aus einer Zeichnungsebene (DrawingLevel, kind "section"/"elevation") wird
//      eine Schnittebene abgeleitet — die Grundriss-Schnittlinie `linePoints`
//      plus `directionSign` (Blickrichtung).
//   2. Das Projekt wird über `projectToModel3d` (dieselbe Wand-/Decken-Zerlegung
//      wie der 3D-Viewport) zu Wänden + Decken geflacht und als JSON an
//      `cut_section_json` gereicht.
//   3. Das zurückgegebene `SectionOutput` (Cut-Polygone + sichtbare/verdeckte
//      Kanten, alles in (u, v)-Metern) wird in `generateSectionPlan`
//      (generatePlan.ts) zu Plan-Primitiven übersetzt.
//
// Einheiten: METER. Koordinaten der Ausgabe: u = horizontal entlang der Ebene,
// v = absolute Höhe (world.y). Siehe src-tauri/render3d/src/section.rs.

import type { DrawingLevel, Project } from "../model/types";
import { projectToModel3d } from "./toWalls3d";
import { loadEngine3d } from "../engine/engine3d";

/** Bauteil-Referenz eines Cut-Polygons/einer Kante (Art + Eingabe-Index). */
export interface SectionComponentRef {
  kind: "wall" | "slab";
  index: number;
}

/** Ein geschnittenes Bauteil-Rechteck in (u, v)-Metern (Ring, implizit geschlossen). */
export interface SectionCutPolygon {
  component: SectionComponentRef;
  /** Albedo-Farbe des Bauteils (RGB 0..1). */
  color: [number, number, number];
  /** Ring-Ecken (u, v). */
  pts: Array<[number, number]>;
}

/** Ein projiziertes Liniensegment in (u, v)-Metern. */
export interface SectionEdge {
  component: SectionComponentRef;
  a: [number, number];
  b: [number, number];
}

/** Vollständige Ausgabe eines Schnitt-/Ansichts-Laufs (JSON von `cut_section_json`). */
export interface SectionOutput {
  cutPolygons: SectionCutPolygon[];
  visibleEdges: SectionEdge[];
  hiddenEdges: SectionEdge[];
}

/** Minimal-Typ des WASM-Exports (das echte `.d.ts` entsteht erst beim wasm-Build). */
interface Engine3dSection {
  cut_section_json(
    modelJson: string,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
  ): string;
}

/**
 * Eine Schnittebene in world-Koordinaten (Y-up): Punkt auf der Ebene +
 * Normale (= Blickrichtung, zeigt vom Betrachter ins Modell).
 */
export interface SectionPlaneSpec {
  point: [number, number, number];
  normal: [number, number, number];
}

/**
 * Leitet aus einer Schnitt-/Ansichtsebene die world-Schnittebene ab. Die
 * Grundriss-Schnittlinie `linePoints` [p0, p1] (Modell-Meter) liegt in der
 * XZ-Ebene (world.x = model.x, world.z = model.y); die Ebenennormale steht
 * senkrecht auf der Linie in der Horizontalen und wird über `directionSign`
 * (Voreinstellung +1) in die gewünschte Blickrichtung gedreht.
 *
 * Gibt `null` zurück, wenn die Ebene (noch) keine Schnittlinie trägt (z. B. eine
 * frisch angelegte Ansicht ohne gesetzte Linie) — der Aufrufer zeigt dann einen
 * Hinweis statt eines leeren Plans.
 */
export function sectionPlaneFromLevel(level: DrawingLevel): SectionPlaneSpec | null {
  const line = level.linePoints;
  if (!line) return null;
  const [p0, p1] = line;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Links-Normale der Linie im Grundriss (n = (-u.y, u.x)), per directionSign
  // in die Blickrichtung gedreht. Modell (nx, ny) → world (nx, 0, ny).
  const sign = level.directionSign ?? 1;
  const nx = -uy * sign;
  const ny = ux * sign;
  return {
    point: [p0.x, 0, p0.y],
    normal: [nx, 0, ny],
  };
}

/**
 * Berechnet den Schnitt/die Ansicht der Ebene `level` gegen das Modell `project`
 * über den WASM-Extraktor. Asynchron (das render3d-WASM-Modul wird lazy geladen).
 *
 * Gibt `null` zurück, wenn die Ebene keine gültige Schnittlinie hat. Wirft, wenn
 * das WASM-Modul den Export (noch) nicht bereitstellt — der Aufrufer fängt das ab
 * und blendet einen Fallback ein (pkg3d muss dann über `npm run build:engine3d`
 * neu gebaut werden, damit `cut_section_json` verfügbar ist).
 */
export async function computeSection(
  project: Project,
  level: DrawingLevel,
): Promise<SectionOutput | null> {
  const plane = sectionPlaneFromLevel(level);
  if (!plane) return null;
  const mod = (await loadEngine3d()) as Engine3dSection;
  if (typeof mod.cut_section_json !== "function") {
    throw new Error(
      "render3d-WASM ohne cut_section_json — pkg3d neu bauen (npm run build:engine3d)",
    );
  }
  const modelJson = JSON.stringify(projectToModel3d(project));
  const json = mod.cut_section_json(
    modelJson,
    plane.point[0],
    plane.point[1],
    plane.point[2],
    plane.normal[0],
    plane.normal[1],
    plane.normal[2],
  );
  return JSON.parse(json) as SectionOutput;
}
