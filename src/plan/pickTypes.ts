// Minimal-Formen der Pick-Geometrie (Wand-/Öffnungs-/Dach-… Körper für den 3D-Raycast). Sie
// stehen im Kern (`pickGeometry` in toWalls3d erzeugt sie); der Raycast der Hülle
// (viewport/raycast3d.ts) konsumiert sie.

export type Vec3 = [number, number, number];

/** Minimal-Form eines Wand-Quaders für den Raycast (RWall erfüllt sie strukturell). */
export interface PickWall {
  start: readonly [number, number];
  end: readonly [number, number];
  thickness: number;
  height: number;
  baseElevation: number;
  wallId: string;
}

/**
 * Minimal-Form einer Öffnungs-Box (Fenster/Tür) für den Raycast — dieselbe
 * orientierte-Quader-Form wie `PickWall` (Achse jambStart→jambEnd in der
 * XZ-Ebene, Dicke = Wanddicke am Sitz der Öffnung), nur über ihre EIGENE
 * vertikale Ausdehnung (Brüstung..Sturz) statt der vollen Wandhöhe.
 */
export interface PickOpening {
  start: readonly [number, number];
  end: readonly [number, number];
  thickness: number;
  height: number;
  baseElevation: number;
  openingId: string;
}

/**
 * Minimal-Form eines Segments einer freien 2D-Zeichnung (Linie/Polylinie/
 * Rechteck) für den Raycast — dieselbe orientierte-Quader-Form wie
 * `PickOpening`, aber mit fester (grosszügiger) Klick-Toleranz statt echter
 * Bauteildicke: die sichtbare Boden-Spur im 3D ist nur 0.008m breit (s.
 * `toWalls3d/drawing2d.ts::DRAWING_LINE_HALF_WIDTH`) — zu schmal, um
 * zuverlässig zu treffen. `baseElevation` ist bereits die UNTERE Kante der
 * Pick-Box (Boden-Spur-Höhe minus halbe Toleranzhöhe), s. `pickDrawingSegs`.
 */
export interface PickDrawingSeg {
  start: readonly [number, number];
  end: readonly [number, number];
  baseElevation: number;
  drawingId: string;
}

/** Klick-Toleranz für 2D-Zeichnungs-Boden-Spuren im 3D (Welt-Meter, s.
 * {@link PickDrawingSeg}) — quer zur Linie UND vertikal, je zur Hälfte um die
 * sichtbare Spur zentriert. Analog dem 2D-Plan-Pick-Radius
 * (`PlanView.tsx::LINE_PICK_PX`), hier als fester Welt-Wert statt Pixel-
 * Toleranz (im 3D gibt es keinen globalen Pixel/Meter-Faktor). */
export const DRAWING_PICK_TOLERANCE = 0.12;

/** Minimal-Form eines Decken-Prismas für den Raycast (RSlab erfüllt sie strukturell). */
export interface PickSlab {
  outline: ReadonlyArray<readonly [number, number]>;
  zBottom: number;
  zTop: number;
  ceilingId: string;
}

/**
 * Minimal-Form eines Treppen-Bounding-Prismas für den Raycast: ein achsparalleles
 * Rechteck über den Grundriss-Fußabdruck (alle Tritte + Podest), extrudiert über
 * die vertikale Ausdehnung der Treppe. Pragmatische Näherung statt Tritt-für-
 * Tritt-Boxen — reicht für zuverlässiges Anklicken im 3D-Viewport.
 */
export interface PickStair {
  outline: ReadonlyArray<readonly [number, number]>;
  zBottom: number;
  zTop: number;
  stairId: string;
}

/**
 * Minimal-Form eines Dachs für den Raycast: die Dachflächen + Giebel als
 * WORLD-Dreiecke (fan-trianguliert, dieselbe Konvention wie `emitRoofs`:
 * model (x,y,z=Höhe) → world (x, z, y)). Präzise geneigte Flächen statt eines
 * grosszügigen Bounding-Prismas — sonst stähle das Dach Klicks auf die
 * Fassade dahinter (pickNearest entscheidet über die Strahl-Distanz).
 */
export interface PickRoof {
  tris: ReadonlyArray<readonly [Vec3, Vec3, Vec3]>;
  roofId: string;
}

/**
 * Minimal-Form eines Kontext-Meshes (importiertes Gebäude/Terrain, s.
 * `ContextObject`) für den Raycast: rohe WORLD-Dreiecke (dieselbe Konvention
 * wie {@link PickRoof} — model (x,y,z=Höhe) → world (x, z, y)), keine
 * Vereinfachung auf ein Bounding-Prisma (Gebäude-Meshes sind zu unregelmässig
 * dafür, ein grosszügiges Prisma stähle Klicks auf dahinterliegende Bauteile).
 */
export interface PickContextMesh {
  tris: ReadonlyArray<readonly [Vec3, Vec3, Vec3]>;
  contextObjectId: string;
}
