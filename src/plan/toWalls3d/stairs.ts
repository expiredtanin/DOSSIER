// Treppen-Domäne der 3D-Ableitung: emittiert Treppen als extrudierte RSlabs
// (Tritte + Podest, tragart-abhängige Untersicht) — der WASM/wgpu-Renderer
// kennt sonst KEINE Treppen (nur Wände/Decken/Meshes). Für Ortbeton-Läufe
// zusätzlich ein glattes Dreiecks-Mesh der schrägen Laufplatten-Untersicht.

import type { Project, Vec2 } from "../../model/types";
import { getStairType } from "../../model/types";
import { stairVerticalExtent } from "../../model/wall";
import { stairGeometry } from "../../geometry/stair";
import { leftNormal, normalize } from "../../model/geometry";
import { EPS, SLAB_RGB, hexToRgb, type RMesh, type RRgb, type RSlab, type RVec2 } from "./shared";

/** Neutraler Beton-Grauton für Treppen (wie der Three.js-Pfad `addStairMeshes`). */
const STAIR_RGB: RRgb = hexToRgb("#9aa0a6", SLAB_RGB);

/** Laufplattendicke einer Ortbetontreppe (Meter). */
const CONCRETE_WAIST = 0.18;

/**
 * Emittiert Treppen als RSlabs (extrudierte Grundriss-Polygone) — der WASM/wgpu-
 * Renderer kennt sonst KEINE Treppen (nur Wände/Decken/Meshes), sodass Treppen im
 * Standard-3D unsichtbar blieben. Jeder Tritt ist ein extrudiertes Polygon; das
 * ist exakt eine RSlab. Tragart über `getStairType`:
 *  • "massiv" / kein Typ — Vollblock je Tritt von der Treppen-UK bis zur Tritt-OK
 *    (gestuftes Massiv, Treppe auf Erdreich/Sockel).
 *  • "beton" — Ortbeton-Laufplatte: je Tritt ein Block von der SCHRÄGEN Untersicht
 *    (eine Stufe + Laufplattendicke unter der Tritt-OK, an der Treppen-UK gekappt)
 *    bis zur Tritt-OK. Die stufig gestapelten Blöcke bilden die schräge, UNTEN
 *    OFFENE Untersicht der klassischen Betontreppe.
 *  • "wange"/"aufgesattelt"/"spindel" — nur eine dünne Tritt-Platte der Dicke
 *    `treadThickness` an der Tritt-OK, darunter offen.
 * Podest (L/Wendel) als Vollblock bis zur halben Steighöhe. Setzstufen/Nase/
 * Geländer sind Verfeinerungen (Three.js-Pfad) — hier zählt zuerst die SICHTBARKEIT.
 * `ceilingId` trägt hier die Treppen-Id (nur TS-seitiges Tagging; render3d ignoriert
 * das Feld, und der Pick läuft separat über `pickGeometry`).
 */
export function emitStairs(project: Project): RSlab[] {
  const out: RSlab[] = [];
  for (const stair of project.stairs ?? []) {
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const totalRise = zTop - zBottom;
    if (totalRise <= EPS) continue;
    const geo = stairGeometry(stair, totalRise);
    const st = getStairType(project, stair);
    const structure = st?.structure ?? "massiv";
    // Gerade Betontreppe: die GLATTE Laufplatte kommt als echtes Mesh
    // (emitStairMeshes) — hier keine Slab-Näherung emittieren (sonst doppelt).
    if (structure === "beton" && stair.shape === "straight") continue;
    const treadThickness = st?.treadThickness ?? 0.04;
    const riser = geo.riserHeight;
    for (const tr of geo.treads) {
      if (tr.pts.length < 3) continue;
      const top = zBottom + tr.topRise;
      const bottom =
        structure === "massiv"
          ? zBottom // Vollblock bis zur Treppen-UK
          : structure === "beton"
            ? Math.max(zBottom, top - riser - CONCRETE_WAIST) // schräge Laufplatte
            : top - treadThickness; // offene Tritte (Wange/aufgesattelt/Spindel)
      if (top - bottom <= EPS) continue;
      out.push({
        outline: tr.pts.map((p) => [p.x, p.y] as RVec2),
        zBottom: bottom,
        zTop: top,
        color: STAIR_RGB,
        ceilingId: stair.id,
      });
    }
    if (geo.landing && geo.landing.length >= 3) {
      out.push({
        outline: geo.landing.map((p) => [p.x, p.y] as RVec2),
        zBottom,
        zTop: zBottom + totalRise * 0.5,
        color: STAIR_RGB,
        ceilingId: stair.id,
      });
    }
  }
  return out;
}

/**
 * Glatte Ortbeton-Laufplatte (Tragart "beton") als echtes Dreiecks-Mesh — nur für
 * GERADE Läufe. Anders als die stufige Slab-Näherung ({@link emitStairs}) entsteht
 * eine SPIEGELGLATTE schräge Untersicht: je Tritt ein konvexes Prisma mit
 * HORIZONTALER Oberkante (= Trittfläche) und SCHRÄGER Unterkante auf EINER
 * gemeinsamen Soffit-Geraden. Weil alle Prismen-Unterkanten exakt auf dieser
 * Geraden liegen, bildet die Vereinigung eine durchgehende glatte Schräge; die
 * Höhensprünge der Oberkanten bleiben als sichtbare Setzstufen. Prismen sind
 * konvex → triviale, robuste Triangulierung (kein Ear-Clipping). Positions in
 * MODELL-Metern (x, y, z=Höhe); render3d bildet nach world (x, z, y) ab.
 */
export function emitStairMeshes(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const stair of project.stairs ?? []) {
    const st = getStairType(project, stair);
    if (!st || st.structure !== "beton") continue;
    if (stair.shape !== "straight") continue; // glattes Mesh nur für gerade Läufe
    if (stair.runLength <= EPS) continue;
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const totalRise = zTop - zBottom;
    if (totalRise <= EPS) continue;
    const geo = stairGeometry(stair, totalRise);
    const u = normalize(stair.dir); // Laufrichtung (Grundriss)
    const w = leftNormal(u); // Querrichtung (Breite)
    const runTotal = stair.runLength;
    // Laufplattendicke (vertikal): an die Steigung gekoppelt, geklemmt.
    const waistV = Math.min(0.24, Math.max(0.14, geo.riserHeight * 1.2));
    // Soffit-Höhe entlang des Laufs: eine Gerade PARALLEL zur Trittkantenlinie
    // (Steigung totalRise/runTotal), um `waistV` nach unten versetzt → KONSTANTE
    // Plattendicke über den ganzen Lauf (sonst würde die Platte nach oben dicker).
    // An der Treppen-UK gekappt, damit die unterste Stufe auf dem Boden aufsitzt
    // statt darunter zu schweben.
    const soffitH = (runS: number) => {
      const s = Math.min(Math.max(runS, 0), runTotal);
      return Math.max(zBottom, zBottom + (s / runTotal) * totalRise - waistV);
    };
    const runOf = (p: Vec2) => (p.x - stair.start.x) * u.x + (p.y - stair.start.y) * u.y;
    const sideOf = (p: Vec2) => (p.x - stair.start.x) * w.x + (p.y - stair.start.y) * w.y;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const tr of geo.treads) {
      if (tr.pts.length < 4) continue;
      // Vier Eckpunkte nach Lauf-Parameter trennen (2 kleinste = Startkante, 2
      // grösste = Endkante), je Kante nach Quer-Parameter sortieren (0 = links).
      const byRun = [...tr.pts].sort((a, b) => runOf(a) - runOf(b));
      const startEdge = [byRun[0], byRun[1]].sort((a, b) => sideOf(a) - sideOf(b));
      const endEdge = [byRun[2], byRun[3]].sort((a, b) => sideOf(a) - sideOf(b));
      const runS = Math.min(runOf(byRun[0]), runOf(byRun[1]));
      const runE = Math.max(runOf(byRun[2]), runOf(byRun[3]));
      const topH = zBottom + tr.topRise;
      const bS = soffitH(runS);
      const bE = soffitH(runE);
      if (topH - Math.max(bS, bE) <= EPS) continue;
      const base = positions.length / 3;
      const push = (p: Vec2, z: number) => positions.push(p.x, p.y, z);
      // 0/1 Startkante unten (soffit), 2/3 Endkante unten, 4/5 Start oben, 6/7 End oben.
      push(startEdge[0], bS); push(startEdge[1], bS);
      push(endEdge[0], bE);   push(endEdge[1], bE);
      push(startEdge[0], topH); push(startEdge[1], topH);
      push(endEdge[0], topH);   push(endEdge[1], topH);
      const quad = (a: number, b: number, c: number, d: number) =>
        indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
      quad(0, 1, 3, 2); // Untersicht (schräge Soffit-Fläche)
      quad(4, 6, 7, 5); // Oberseite (Trittfläche)
      quad(0, 4, 5, 1); // Startkante (Setzstufen-Front der Vorstufe sichtbar)
      quad(2, 3, 7, 6); // Endkante
      quad(0, 2, 6, 4); // linke Wange
      quad(1, 5, 7, 3); // rechte Wange
    }
    if (indices.length === 0) continue;
    out.push({ positions, indices, kind: "extrusion", color: STAIR_RGB });
  }
  return out;
}
