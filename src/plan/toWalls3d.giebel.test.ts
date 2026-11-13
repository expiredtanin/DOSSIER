// [231] Giebelwände im Musterhaus komplex: Fenster im Giebel (Dachgeschoss Ost/West, Anbau Nord) sauber eingeschnitten —
// je Schicht EIN Körper (Kern `model3d/wall_body.rs`) ohne innere Flächen: keine Fugen von der Öffnung bis zum Dach,
// keine am First, rundes Loch beim Oculus. Vorher zerfiel die Wand um Rechteckfenster in Pfeiler/Brüstung/Sturz mit
// eigener Oberkante, und am First blieb die Stossfläche der beiden Stücke im Körper stehen.

import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { projectToModel3d } from "./toWalls3d";

/** Kanten (nach Lage, 0,01 mm) eines Netzes, die nicht zu genau zwei Dreiecken gehören (innere Flächen, Risse). */
function seamEdges(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  const key = (i: number) => [0, 1, 2].map((k) => Math.round(positions[i * 3 + k] * 1e5)).join(",");
  const n = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = key(indices[t + k]);
      const b = key(indices[t + ((k + 1) % 3)]);
      if (a === b) continue;
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      n.set(e, (n.get(e) ?? 0) + 1);
    }
  }
  return [...n.values()].filter((c) => c !== 2).length;
}

describe("Fenster im Giebel ([231])", () => {
  const p = buildComplexSampleProject();
  const m = projectToModel3d(p);

  it.each([
    ["dg-aw-w", "Oculus (rund) über dem First"],
    ["dg-aw-o", "Rechteckfenster über dem First"],
    ["og-anbau-n", "Rechteckfenster im Anbau-Giebel"],
  ])("%s: %s — ein Körper je Schicht ohne Fugen", (wallId) => {
    const wall = p.walls.find((w) => w.id === wallId)!;
    const layers = p.wallTypes.find((t) => t.id === wall.wallTypeId)!.layers.length;
    expect(m.walls.filter((w) => w.wallId === wallId), "keine Stücke (Pfeiler/Sturz) mehr").toHaveLength(0);
    const bodies = m.meshes.filter((x) => x.wallId === wallId);
    expect(bodies).toHaveLength(layers);
    // Aussenschicht ganz ohne Fugen; innere Schichten mit Schichteinzug [106]: deren Leibungsstücke berühren den Körper
    // an einzelnen Ecken nur längs einer Kante (höchstens ein paar solcher Kanten, keine Fuge über die Wand).
    expect(seamEdges(bodies[0].positions, bodies[0].indices)).toBe(0);
    for (const b of bodies) expect(seamEdges(b.positions, b.indices)).toBeLessThanOrEqual(4);
  });
});
