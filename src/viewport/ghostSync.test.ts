// [180] Teil-Update der Geisterschicht: gleiche Antwort ⇒ gleiche Prüfsumme, jede Änderung ⇒ andere.

import { describe, expect, it } from "vitest";
import { ghostSignature } from "./ghostSync";

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
