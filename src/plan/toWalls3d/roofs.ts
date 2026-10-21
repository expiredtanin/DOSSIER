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
 * Gehrte Versatz-Ecken für ALLE Dachflächen eines Daches: liefert je Fläche die
 * um `d` (Meter, entlang der Flächennormalen nach innen) versetzten Ecken —
 * aber an Kanten, die sich zwei Flächen teilen (First/Grat/Knick), NICHT
 * stur entlang der EIGENEN Normalen, sondern auf der Gehrung: die Ecke liegt im
 * Schnitt der versetzten Ebenen beider Flächen. Vorher durchdrangen sich die
 * Slabs benachbarter Flächen am First, ihre Stirnflächen lagen deckungsgleich
 * auf der Nachbar-Oberseite (Störtriangle am First-Apex im „Schattiert mit
 * Kanten"-Modus). Freie Kanten (Traufe/Ortgang) behalten die senkrechte
 * Stirnfläche. `shared[i][k]` = Kante k→k+1 von Fläche i ist geteilt.
 */
export function mitredRoofOffsets(planes: RoofVec3[][]): {
  at: (i: number, d: number) => RoofVec3[];
  shared: boolean[][];
} {
  const r = (v: number) => Math.round(v * 1e5);
  const pk = (p: RoofVec3) => `${r(p[0])},${r(p[1])},${r(p[2])}`;
  const ek = (a: RoofVec3, b: RoofVec3) => {
    const ka = pk(a);
    const kb = pk(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const edgeOwners = new Map<string, number[]>();
  planes.forEach((pts, i) => {
    for (let k = 0; k < pts.length; k++) {
      const key = ek(pts[k], pts[(k + 1) % pts.length]);
      const list = edgeOwners.get(key);
      if (list) list.push(i);
      else edgeOwners.set(key, [i]);
    }
  });
  const normals = planes.map((pts) => planeNormalUp(pts));
  const neighbor = planes.map((pts, i) =>
    pts.map((p, k) => {
      const owners = edgeOwners.get(ek(p, pts[(k + 1) % pts.length])) ?? [];
      const j = owners.find((o) => o !== i);
      return j === undefined ? -1 : j;
    }),
  );
  const shared = neighbor.map((row) => row.map((j) => j >= 0));
  const dot = (a: RoofVec3, b: RoofVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: RoofVec3, b: RoofVec3): RoofVec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  // Ebene (Normale m, Abstand c: m·x = c) der Kante k→k+1 von Fläche i beim Versatz d:
  // geteilt → versetzte Nachbarebene (Gehrung), frei → senkrechte Stirnebene.
  const edgePlane = (i: number, k: number, d: number): [RoofVec3, number] => {
    const pts = planes[i];
    const a = pts[k];
    const b = pts[(k + 1) % pts.length];
    const j = neighbor[i][k];
    if (j >= 0) return [normals[j], dot(normals[j], planes[j][0]) - d];
    const dir: RoofVec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const m = cross(dir, normals[i]);
    return [m, dot(m, a)];
  };
  // Schnittpunkt dreier Ebenen (Cramer über Kreuzprodukte), null wenn entartet.
  const solve = (rows: Array<[RoofVec3, number]>): RoofVec3 | null => {
    const [[a, ca], [b, cb], [c, cc]] = rows;
    const bc = cross(b, c);
    const det = dot(a, bc);
    if (Math.abs(det) < 1e-9) return null;
    const cxa = cross(c, a);
    const axb = cross(a, b);
    return [
      (ca * bc[0] + cb * cxa[0] + cc * axb[0]) / det,
      (ca * bc[1] + cb * cxa[1] + cc * axb[1]) / det,
      (ca * bc[2] + cb * cxa[2] + cc * axb[2]) / det,
    ];
  };
  const at = (i: number, d: number): RoofVec3[] => {
    const pts = planes[i];
    const n = normals[i];
    if (d <= EPS) return pts.map((p) => [p[0], p[1], p[2]]);
    const own: [RoofVec3, number] = [n, dot(n, pts[0]) - d];
    return pts.map((p, k) => {
      const prev = (k + pts.length - 1) % pts.length;
      const fallback: RoofVec3 = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
      if (!shared[i][prev] && !shared[i][k]) return fallback;
      const q = solve([own, edgePlane(i, prev, d), edgePlane(i, k, d)]);
      // Ausreisser (fast parallele Ebenen) abfangen: nicht weiter als ein paar
      // Dicken von der senkrechten Lösung entfernt.
      if (!q || Math.hypot(q[0] - fallback[0], q[1] - fallback[1], q[2] - fallback[2]) > 4 * d + 0.5) {
        return fallback;
      }
      return q;
    });
  };
  return { at, shared };
}

/**
 * Slab einer Dachfläche zwischen fertigen Ober-/Unterseiten-Ecken (gleiche
 * Reihenfolge). Stirnflächen nur an FREIEN Kanten (`shared[k]` = false) — an
 * geteilten Kanten stossen die Nachbarflächen auf Gehrung, eine Stirnfläche
 * läge dort im Inneren des Dachs.
 */
function pushRoofSlabBetween(
  positions: number[],
  indices: number[],
  top: RoofVec3[],
  bottom: RoofVec3[],
  shared: boolean[],
): void {
  pushFanTriangles(positions, indices, top);
  pushFanTriangles(positions, indices, bottom);
  for (let i = 0; i < top.length; i++) {
    if (shared[i]) continue;
    const j = (i + 1) % top.length;
    const base = positions.length / 3;
    positions.push(top[i][0], top[i][1], top[i][2]);
    positions.push(top[j][0], top[j][1], top[j][2]);
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
    const mitre = mitredRoofOffsets(g.planes.map((pl) => pl.pts));
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
      g.planes.forEach((plane, i) => {
        // Oberseite dieser Schicht = Dachfläche um `offsetAbove` nach innen
        // versetzt, Unterseite um `offsetAbove + t` — an First/Grat gehrt.
        if (plane.pts.length < 3) return;
        const top = mitre.at(i, offsetAbove);
        const bottom = mitre.at(i, offsetAbove + t);
        pushRoofSlabBetween(positions, indices, top, bottom, mitre.shared[i]);
      });
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
