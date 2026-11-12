// [180] Teil-Update der Geisterschicht: gleiche Antwort ⇒ gleiche Prüfsumme, jede Änderung ⇒ andere.

import { describe, expect, it } from "vitest";
import type { Model3dPart } from "../core";
import { GHOST_CLEAR, GhostLayerSync, ghostSignature } from "./ghostSync";

const f = (...v: number[]) => new Float32Array(v);

describe("ghostSignature", () => {
  it("leere Schicht ist der leere Text", () => {
    expect(ghostSignature("", f(), f())).toBe("");
  });

  it("gleiche Eingabe gleich, auch bei neuen Puffern", () => {
    const a = ghostSignature('{"walls":[1]}', f(1, 2, 3, 4, 5, 6), f(7, 8));
    expect(ghostSignature('{"walls":[1]}', f(1, 2, 3, 4, 5, 6), f(7, 8))).toBe(a);
  });

  it("Änderung an Modell, Spuren oder Muster ändert die Summe", () => {
    const base = ghostSignature('{"walls":[1]}', f(1, 2, 3), f(4, 5));
    expect(ghostSignature('{"walls":[2]}', f(1, 2, 3), f(4, 5))).not.toBe(base);
    expect(ghostSignature('{"walls":[1]}', f(1, 2, 3.5), f(4, 5))).not.toBe(base);
    expect(ghostSignature('{"walls":[1]}', f(1, 2, 3), f(4, 5.25))).not.toBe(base);
    expect(ghostSignature('{"walls":[1]}', f(1, 2, 3), f())).not.toBe(base);
    // Verschiebung zwischen Spuren und Mustern bleibt unterscheidbar.
    expect(ghostSignature("", f(1, 2), f(3))).not.toBe(ghostSignature("", f(1), f(2, 3)));
  });

  it("Teilansicht eines grösseren Puffers zählt nur ihren Ausschnitt", () => {
    const big = f(9, 1, 2, 3, 9);
    expect(ghostSignature("m", big.subarray(1, 4), f())).toBe(ghostSignature("m", f(1, 2, 3), f()));
  });
});

describe("GhostLayerSync ([214] Geisterschicht als Teile)", () => {
  const wall = (id: string): Model3dPart => ({ id, fixed: true, walls: [] });
  const slabs = (z: number): Model3dPart => ({ id: "slabs", fixed: false, slabs: [{ zTop: z } as never] });

  it("schickt beim ersten Mal alles, danach nur Geändertes, unverändert nichts", () => {
    const g = new GhostLayerSync();
    const first = JSON.parse(g.partsUpdate([wall("w1"), wall("w2"), slabs(3)])!);
    expect(first.reset).toBe(true);
    expect(first.upsert.map((p: Model3dPart) => p.id)).toEqual(["w1", "w2", "slabs"]);
    expect(g.partsUpdate([wall("w1"), wall("w2"), slabs(3)])).toBeNull();
    const d = JSON.parse(g.partsUpdate([wall("w1"), wall("w3"), slabs(3)])!);
    expect(d.reset).toBe(false);
    expect(d.remove).toEqual(["w2"]);
    expect(d.upsert.map((p: Model3dPart) => p.id)).toEqual(["w3"]);
  });

  it("leert die Schicht genau einmal, wenn keine Klasse mehr grau ist", () => {
    const g = new GhostLayerSync();
    expect(g.partsUpdate(null)).toBeNull();
    g.partsUpdate([wall("w1")]);
    expect(g.partsUpdate(null)).toBe(GHOST_CLEAR);
    expect(g.partsUpdate(null)).toBeNull();
    // Danach wieder grau: Vollaufbau.
    expect(JSON.parse(g.partsUpdate([wall("w1")])!).reset).toBe(true);
  });

  it("Ganz-Weg (Explosion) und Teile-Weg wechseln sauber", () => {
    const g = new GhostLayerSync();
    g.partsUpdate([wall("w1")]);
    expect(g.modelChanged('{"walls":[1]}')).toBe(true);
    expect(g.modelChanged('{"walls":[1]}')).toBe(false);
    // Zurück zu den Teilen: render3d hat das ganze Modell, also Vollaufbau.
    expect(JSON.parse(g.partsUpdate([wall("w1")])!).reset).toBe(true);
    // Ganz-Weg ohne graue Klasse leert nur, wenn etwas da ist.
    expect(g.modelChanged("")).toBe(true);
    expect(g.modelChanged("")).toBe(false);
  });

  it("Spuren/Muster nur bei Änderung", () => {
    const g = new GhostLayerSync();
    expect(g.linesChanged(f(1, 2), f())).toBe(true);
    expect(g.linesChanged(f(1, 2), f())).toBe(false);
    expect(g.linesChanged(f(1, 3), f())).toBe(true);
    g.reset();
    expect(g.linesChanged(f(1, 3), f())).toBe(true);
  });
});
