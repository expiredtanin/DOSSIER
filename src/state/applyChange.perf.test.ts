// [K4] S3 Messung: typische Hochfrequenz-Aktionen auf einem grossen Projekt (3000 Wände) über den
// Store — Griff ziehen (100 Schritte, ein Undo-Schritt), Auswahl verschieben (300 Wände, 20-mal),
// Eigenschaft tippen (100 Zeichen, ein Undo-Schritt). Werte gehen nach stderr (TODO [K4]); die
// Grenzen sind grosszügig (Container unter Last), geprüft wird vor allem das Ergebnis.
import { describe, expect, it } from "vitest";
import { getState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import type { Project, Wall } from "../model/types";

const st = () => getState();

function bigProject(n: number): Project {
  const base = sampleProject.walls;
  const walls: Wall[] = Array.from({ length: n }, (_, i) => ({
    ...base[i % base.length],
    id: `w${i}`,
    start: { x: i, y: 0 },
    end: { x: i + 1, y: 0 },
  }));
  return { ...structuredClone(sampleProject), walls };
}

describe("Messung Store-Aktionen, 3000 Wände", () => {
  it("Griff ziehen, Auswahl verschieben, Eigenschaft tippen", () => {
    st().loadProject(bigProject(3000));
    st().clearHistory();
    const depth0 = st().undoDepth;

    // Griff ziehen: 100 Mausschritte, ein Undo-Schritt.
    let t = performance.now();
    for (let i = 0; i < 100; i++) st().moveGripOf(null, "w1500", 0, { x: 1500 + i * 0.01, y: 0.5 });
    const gripMs = (performance.now() - t) / 100;
    expect(st().project.walls[1500].start).toEqual({ x: 1500 + 99 * 0.01, y: 0.5 });
    expect(st().undoDepth).toBe(depth0 + 1);

    // Auswahl verschieben: 300 Wände, 20 Verschiebungen.
    const ids = Array.from({ length: 300 }, (_, i) => `w${i * 10}`);
    t = performance.now();
    for (let i = 0; i < 20; i++) {
      st().commitTransformOn({ wallIds: ids, drawingId: null }, "move", [{ x: 0, y: 0 }, { x: 0, y: 0.1 }], "move", 1);
    }
    const moveMs = (performance.now() - t) / 20;
    expect(st().project.walls[10].start.y).toBeCloseTo(2, 9);
    expect(st().project.walls[11].start.y).toBe(0);

    // Eigenschaft tippen: 100 Tastenschritte mit coalesceKey.
    t = performance.now();
    for (let i = 0; i < 100; i++) st().updateWall("w42", { height: 2.5 + i / 1000 }, "typing:w42");
    const typeMs = (performance.now() - t) / 100;
    expect(st().project.walls[42].height).toBeCloseTo(2.599, 9);

    process.stderr.write(
      `3000 Wände (Store): Griff ziehen ${gripMs.toFixed(2)} ms/Schritt, Auswahl verschieben (300) ${moveMs.toFixed(2)} ms, Eigenschaft tippen ${typeMs.toFixed(2)} ms\n`,
    );
    expect(gripMs + moveMs + typeMs).toBeLessThan(200);
  });
});
