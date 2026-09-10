// Dach-Domäne der 3D-Ableitung: emittiert Dächer (`project.roofs`) als
// geschlossene, geschichtete Dreiecks-Meshes (Eindeckung → innen) aus den
// geneigten Dachflächen (`RoofGeometry.planes`) — jede Schicht ein eigener
// solider Slab mit ihrer Bauteilfarbe/-textur.

import type { Project } from "../../model/types";
import { getComponent, roofLayers } from "../../model/types";
import { roofBaseElevation, roofGeometry } from "../../geometry/roof";
import type { Vec3 as RoofVec3 } from "../../geometry/roof";
import {
  EPS,
  hexToRgb,
  resolveComponentMaterialLayer,
  resolveCutLineStyle,
  type RCutMeta,
  type RMesh,
  type RRgb,
  type RRoofLayer,
} from "./shared";

/** Warmer Terrakotta-Grauton für Dachflächen/-giebel — hebt das Dach klar von Wand/Decke/Kontext ab. */
const ROOF_RGB: RRgb = [0.72, 0.45, 0.36];

/**
 * Trianguliert ein KONVEXES 3D-Polygon per Dreiecks-Fächer ab Vertex 0 und hängt
 * die Dreiecke an `positions`/`indices` an. `roofGeometry` (Vertrag in
 * `geometry/roof.ts`) liefert für `planes`/`gables` ausschliesslich konvexe
 * Polygone (Dreieck/Quader bei den meisten Formen, ein Fünfeck-Giebel bei
 * Mansarde) — ein Fächer trianguliert diese korrekt, ohne Ear-Clipping.
 */
function pushFanTriangles(positions: number[], indices: number[], pts: RoofVec3[]): void {
  if (pts.length < 3) return;
  const base = positions.length / 3;
  for (const p of pts) positions.push(p[0], p[1], p[2]);
  for (let i = 1; i < pts.length - 1; i++) indices.push(base, base + i, base + i + 1);
}

/**
 * Robuste Flächennormale (Newell) einer Polygon-Ebene in MODELL-Koordinaten
 * ([x, y, z=Höhe]), nach OBEN orientiert (positive Höhen-Komponente) — für die
 * Dach-Dickenversetzung (Unterseite = Oberseite − Normale·Dicke).
 */
function planeNormalUp(pts: RoofVec3[]): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const d = pts[(i + 1) % pts.length];
    nx += (c[1] - d[1]) * (c[2] + d[2]);
    ny += (c[2] - d[2]) * (c[0] + d[0]);
    nz += (c[0] - d[0]) * (c[1] + d[1]);
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  const u: [number, number, number] = [nx / len, ny / len, nz / len];
  return u[2] < 0 ? [-u[0], -u[1], -u[2]] : u;
}

/**
 * Eine Dachfläche als SOLIDER Slab (Oberseite + um `thickness` entlang der
 * Normalen nach unten versetzte Unterseite + umlaufende Seitenwände) — gibt dem
 * Dach eine echte Materialdicke statt einer papierdünnen Fläche. render3d
 * rendert doppelseitig, Winding ist unerheblich.
 */
function pushRoofSlab(
  positions: number[],
  indices: number[],
  pts: RoofVec3[],
  thickness: number,
): void {
  if (pts.length < 3 || thickness <= EPS) {
    pushFanTriangles(positions, indices, pts);
    return;
  }
  const nrm = planeNormalUp(pts);
  const bottom: RoofVec3[] = pts.map((p) => [
    p[0] - nrm[0] * thickness,
    p[1] - nrm[1] * thickness,
    p[2] - nrm[2] * thickness,
  ]);
  pushFanTriangles(positions, indices, pts); // Oberseite
  pushFanTriangles(positions, indices, bottom); // Unterseite
  // Seitenwände: je Kante ein Quad (zwei Dreiecke) zwischen Ober- und Unterseite.
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const base = positions.length / 3;
    positions.push(pts[i][0], pts[i][1], pts[i][2]);
    positions.push(pts[j][0], pts[j][1], pts[j][2]);
    positions.push(bottom[j][0], bottom[j][1], bottom[j][2]);
    positions.push(bottom[i][0], bottom[i][1], bottom[i][2]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * Emittiert Dächer (`project.roofs`) als geschlossene Dreiecks-Meshes: sowohl die
 * geneigten Dachflächen (`RoofGeometry.planes`) als auch die Giebelflächen
 * (`RoofGeometry.gables`) — erst zusammen bilden sie einen von aussen
 * geschlossenen Körper (die Giebel schliessen die offenen Enden bei Sattel/
 * Mansarde, die First-/Grat-/Knicklinien sind reine Grundriss-Hilfslinien und
 * werden hier nicht gebraucht). Traufhöhe über `roofBaseElevation`
 * (Override oder Geschoss-Oberkante), Flächen über `roofGeometry`. Farbe:
 * `roof.color` (falls gültiges Hex), sonst {@link ROOF_RGB}. `positions` in
 * MODELL-Metern (x, y, z=Höhe); render3d rendert Kontext-Meshes doppelseitig,
 * die Winding-Reihenfolge ist also unerheblich.
 */
export function emitRoofs(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const roof of project.roofs ?? []) {
    const eavesZ = roofBaseElevation(project, roof);
    const g = roofGeometry(roof, eavesZ);
    const overrideColor = roof.color ? hexToRgb(roof.color, ROOF_RGB) : null;
    // Schichtaufbau (aussen/Eindeckung → innen). Jede Schicht wird zu einem
    // eigenen RMesh mit ihrer Bauteilfarbe, entlang der Flächennormalen unter die
    // vorige gestapelt. Leere componentId (einschichtige thickness-Fallback) ⇒
    // Default-Dachfarbe. Eine Roof.color-Übersteuerung gilt für alle Schichten.
    const layers = roofLayers(project, roof);
    layers.reduce((offsetAbove, layer) => {
      const t = Math.max(0, layer.thickness);
      if (t <= EPS) return offsetAbove;
      const color =
        overrideColor ??
        (layer.componentId ? hexToRgb(getComponent(project, layer.componentId).color, ROOF_RGB) : ROOF_RGB);
      // Material-Textur-Ebene fürs Textured-Rendering (z. B. echte Dachziegel-
      // Textur der Eindeckung) — nur wenn KEIN Farb-Override greift (Override
      // = bewusst eine einheitliche Farbe für alle Schichten, kein Bauteil-Bezug).
      const materialIndex =
        !overrideColor && layer.componentId
          ? resolveComponentMaterialLayer(project, layer.componentId)
          : undefined;
      const positions: number[] = [];
      const indices: number[] = [];
      for (const plane of g.planes) {
        // Oberseite dieser Schicht = Dachfläche um `offsetAbove` entlang der
        // Normalen nach innen versetzt; Slab-Dicke = Schichtdicke.
        const nrm = planeNormalUp(plane.pts);
        const top: RoofVec3[] = plane.pts.map((p) => [
          p[0] - nrm[0] * offsetAbove,
          p[1] - nrm[1] * offsetAbove,
          p[2] - nrm[2] * offsetAbove,
        ]);
        pushRoofSlab(positions, indices, top, t);
      }
      if (indices.length > 0) out.push({ positions, indices, kind: "extrusion", color, materialIndex });
      return offsetAbove + t;
    }, 0);
    // Giebel-ENDFÜLLUNG bewusst NICHT mehr emittieren: die dreieckige Giebelfläche
    // wurde früher als papierdünne Einzelfläche gebaut ("komischer Abschluss" an
    // den Sattel-/Mansard-Enden) und lag zudem deckungsgleich vor der Giebelwand,
    // die ohnehin bis an die Dach-Unterkante hochgeklemmt wird (s.
    // `../bands.ts::clipPieceToRoofs`) — also doppelt und optisch als dünne
    // 2D-Schicht sichtbar. Es wird nur noch das Dach SELBST (die geneigten
    // Slab-Flächen) konstruiert; der Giebel entsteht aus der Wand darunter.
  }
  return out;
}

/**
 * Baut die Dach-Schicht-Eingabe für den 3D-Live-Schnitt (`RRoofLayer[]`,
 * `render3d::roof_cut::cut_roof_layer`) — GETRENNT von {@link emitRoofs} (dem
 * Render-Mesh), weil `section.rs` beliebige Dreiecksnetze nicht schneiden
 * kann (nur Wand-Boxen/Decken-Polygone; eine Dachfläche ist kein vertikales
 * Prisma, s. `RRoofLayer`-Doc in `shared.ts`). EIN Eintrag je (Dach, Schicht,
 * geneigte Fläche) — ein mehrflächiges Dach (Sattel/Walm/Mansarde) hat
 * mehrere `g.planes`, jede mit ihrer eigenen Normalen, anders als beim
 * gemeinsam tessellierten Render-Mesh also KEIN zusammengefasster Eintrag.
 * Punkte/Normalen bleiben in MODELL-Metern (wie `emitRoofs`) — render3d macht
 * den Modell->Welt-Wechsel selbst (dieselbe Konvention wie `RMesh`).
 */
export function emitRoofCutLayers(project: Project): RRoofLayer[] {
  const out: RRoofLayer[] = [];
  for (const roof of project.roofs ?? []) {
    const eavesZ = roofBaseElevation(project, roof);
    const g = roofGeometry(roof, eavesZ);
    const overrideColor = roof.color ? hexToRgb(roof.color, ROOF_RGB) : null;
    const layers = roofLayers(project, roof);
    layers.reduce((offsetAbove, layer) => {
      const t = Math.max(0, layer.thickness);
      if (t <= EPS) return offsetAbove;
      const color =
        overrideColor ??
        (layer.componentId ? hexToRgb(getComponent(project, layer.componentId).color, ROOF_RGB) : ROOF_RGB);
      const lineStyle = resolveCutLineStyle(project, layer.jointLineStyleId);
      const cut: RCutMeta | undefined =
        lineStyle && (lineStyle.color !== undefined || lineStyle.weight !== undefined)
          ? { lineColor: lineStyle.color, lineWeight: lineStyle.weight }
          : undefined;
      for (const plane of g.planes) {
        const nrm = planeNormalUp(plane.pts);
        const top: RoofVec3[] = plane.pts.map((p) => [
          p[0] - nrm[0] * offsetAbove,
          p[1] - nrm[1] * offsetAbove,
          p[2] - nrm[2] * offsetAbove,
        ]);
        out.push({ polygon: top, normal: nrm, thickness: t, color, cut });
      }
      return offsetAbove + t;
    }, 0);
  }
  return out;
}
