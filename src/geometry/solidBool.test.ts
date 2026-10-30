import { describe, expect, it } from "vitest";
import { solidBoolean, type SolidMesh } from "./solidBool";

function box(x: number, y: number, z: number, w: number, l: number, h: number): SolidMesh {
  const p = [
    [x, y, z],
    [x + w, y, z],
    [x + w, y + l, z],
    [x, y + l, z],
    [x, y, z + h],
    [x + w, y, z + h],
    [x + w, y + l, z + h],
    [x, y + l, z + h],
  ];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: p.flat(), indices };
}

function volume(m: { positions: ArrayLike<number>; indices: ArrayLike<number> }): number {
  let v = 0;
  const P = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
    v +=
      P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) -
      P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) +
      P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

describe("solidBoolean (Kern, Manifold)", () => {
  it("bündige Differenz exakt", () => {
    const r = solidBoolean(box(0, 0, 0, 2, 2, 2), box(1, 0, 0, 1, 2, 2), "difference");
    expect(r).not.toBeNull();
    expect(volume(r!)).toBeCloseTo(4, 9);
  });

  it("Schnitt ohne Überdeckung: leer, nicht null", () => {
    const r = solidBoolean(box(0, 0, 0, 1, 1, 1), box(5, 5, 5, 1, 1, 1), "intersection");
    expect(r).not.toBeNull();
    expect(r!.indices.length).toBe(0);
  });

  it("kaputte Netze: null statt Ausnahme (Fuzz)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const specials = [NaN, Infinity, -Infinity, 1e300, -0, 1e-12];
    for (let k = 0; k < 300; k++) {
      const a = box(rnd(), rnd(), rnd(), 0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd());
      const pos = Array.from(a.positions);
      const idx = Array.from(a.indices);
      switch (k % 5) {
        case 0:
          pos[Math.floor(rnd() * pos.length)] = specials[k % specials.length];
          break;
        case 1:
          idx[Math.floor(rnd() * idx.length)] = Math.floor(rnd() * 50) - 5;
          break;
        case 2:
          idx.length = Math.floor(rnd() * idx.length);
          break;
        case 3:
          idx.push(...idx.slice(0, 3));
          break;
        default:
          break;
      }
      const ops = ["union", "difference", "intersection"] as const;
      expect(() => solidBoolean({ positions: pos, indices: idx }, box(0.3, 0.3, 0.3, 1, 1, 1), ops[k % 3])).not.toThrow();
    }
  });
});
