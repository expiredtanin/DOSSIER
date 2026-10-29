// [K4] Messung: Objekt-Info (`deriveSelection`), Griff-Schritte und grosse Polylinien auf einem grossen
// Projekt (3000 Wände + 20 000 Zeichnungen, 40 Dächer) über den Store. Werte gehen nach stderr (TODO [K4]);
// die Grenzen sind grosszügig (Container unter Last), geprüft wird vor allem das Ergebnis.
import { describe, expect, it } from "vitest";
import { getState } from "./appStore";
import { deriveSelection } from "./selectionInfo";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Project, Roof, Wall } from "../model/types";

const st = () => getState();

function bigProject(): Project {
  const base = sampleProject.walls;
  const walls: Wall[] = Array.from({ length: 3000 }, (_, i) => ({
    ...base[i % base.length],
    id: `w${i}`,
    start: { x: i, y: 0 },
    end: { x: i + 1, y: 0 },
  }));
  const level = sampleProject.drawingLevels[0].id;
  const drawings: Drawing2D[] = Array.from({ length: 20000 }, (_, i) => ({
    id: `d${i}`,
    levelId: level,
    categoryCode: "01",
    geom:
      i === 19000
        ? {
            shape: "polyline",
            closed: false,
            pts: Array.from({ length: 5000 }, (_, k) => ({ x: k * 0.1, y: Math.sin(k / 50) })),
          }
        : { shape: "polyline", closed: false, pts: [{ x: i, y: 1 }, { x: i + 1, y: 2 }, { x: i + 2, y: 1 }] },
  })) as Drawing2D[];
  const roof = sampleProject.roofs![0];
  const roofs: Roof[] = Array.from({ length: 40 }, (_, i) => ({
    ...roof,
    id: `r${i}`,
    outline: roof.outline.map((p) => ({ x: p.x + i * 10, y: p.y })),
  }));
  return { ...structuredClone(sampleProject), walls, drawings2d: drawings, roofs };
}

/** Kleinster Mittelwert (µs) aus `rounds` Läufen à `n` Aufrufen. */
function bench(n: number, fn: (i: number) => void, rounds = 3): number {
  let best = Infinity;
  for (let i = 0; i < Math.ceil(n / 4); i++) fn(i); // Aufwärmen (JIT, Caches)
  for (let r = 0; r < rounds; r++) {
    const t = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    best = Math.min(best, ((performance.now() - t) * 1000) / n);
  }
  return best;
}

const sel = (p: Project, k: { wall?: string; drawing?: string; roof?: string }) =>
  deriveSelection(p, k.wall ? [k.wall] : [], k.drawing ?? null, null, null, null, null, null, null, k.roof ?? null);

describe("Messung Objekt-Info und Griffe, 3000 Wände + 20 000 Zeichnungen", () => {
  it("Objekt-Info, Griff-Schritte, Polylinien-Punkttyp", { timeout: 120000 }, () => {
    st().loadProject(bigProject());
    const p = st().project;
    const out: string[] = [];
    for (const i of [10, 1500, 2990]) {
      expect(sel(p, { wall: `w${i}` })?.kind).toBe("wall");
      out.push(`Info Wand ${i} ${bench(200, () => sel(p, { wall: `w${i}` })).toFixed(0)} µs`);
    }
    expect(sel(p, { drawing: "d10000" })?.kind).toBe("drawing2d");
    out.push(`Info Zeichnung 10000 ${bench(200, () => sel(p, { drawing: "d10000" })).toFixed(0)} µs`);
    expect(sel(p, { roof: "r20" })?.kind).toBe("roof");
    out.push(`Info Dach (40 im Wechsel) ${bench(200, (i) => sel(p, { roof: `r${i % 40}` })).toFixed(0)} µs`);

    for (const i of [10, 1500, 2990]) {
      const us = bench(50, (k) => st().moveGripOf(null, `w${i}`, 0, { x: i + (k % 7) * 0.01, y: 0.5 }));
      out.push(`Griff Wand ${i} ${us.toFixed(0)} µs`);
    }
    expect(st().project.walls[1500].start.y).toBe(0.5);
    const big = (k: number) => st().moveGripOf("d19000", null, 2500, { x: 250 + (k % 5) * 0.01, y: 3 });
    out.push(`Griff Polylinie 5000 Punkte ${(bench(20, big) / 1000).toFixed(2)} ms`);
    out.push(`Griff Zeichnung 15000 ${bench(50, (k) => st().moveGripOf("d15000", null, 1, { x: 15001, y: 2 + (k % 5) * 0.01 })).toFixed(0)} µs`);

    const types = ["arc", "spline", "corner"] as const;
    out.push(
      `Punkttyp Polylinie 5000 Punkte ${(bench(20, (k) => st().setPolylineVertexType("d19000", 100 + k, types[k % 3])) / 1000).toFixed(2)} ms`,
    );
    out.push(`Punkttyp kleine Polylinie ${bench(50, (k) => st().setPolylineVertexType("d12000", 1, types[k % 3])).toFixed(0)} µs`);
    st().setPolylineVertexType("d12000", 1, "arc");
    expect((st().project.drawings2d[12000].geom as { bulge?: number[] }).bulge?.length).toBe(2);
    st().setPolylineVertexType("d12000", 1, "corner");
    expect((st().project.drawings2d[12000].geom as { bulge?: number[] }).bulge).toBeUndefined();

    process.stderr.write(`Objekt-Info/Griffe (Store): ${out.join(", ")}\n`);
  });
});
