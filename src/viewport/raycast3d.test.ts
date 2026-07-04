import { describe, it, expect } from "vitest";
import {
  cameraRay,
  rayWallBox,
  raySlabPrism,
  pickNearest,
  type RayCamera,
  type PickWall,
  type PickSlab,
} from "./raycast3d";

// Kamera bei (0,1,10), Blick entlang -Z auf (0,1,0). Zentraler Strahl (ndc 0,0)
// zeigt in -Z. World-Konvention: Modell (x,y) → world (x, elevation, y).
const CAM: RayCamera = {
  eye: [0, 1, 10],
  target: [0, 1, 0],
  up: [0, 1, 0],
  fovY: Math.PI / 4,
};

describe("cameraRay", () => {
  it("Zentralstrahl zeigt entlang der Blickrichtung", () => {
    const ray = cameraRay(CAM, 0, 0, 16 / 9);
    expect(ray.origin).toEqual([0, 1, 10]);
    expect(ray.dir[0]).toBeCloseTo(0, 6);
    expect(ray.dir[1]).toBeCloseTo(0, 6);
    expect(ray.dir[2]).toBeCloseTo(-1, 6);
  });

  it("positives ndcX weicht nach rechts (+X), ndcY nach oben (+Y) aus", () => {
    const ray = cameraRay(CAM, 0.5, 0.5, 1);
    expect(ray.dir[0]).toBeGreaterThan(0);
    expect(ray.dir[1]).toBeGreaterThan(0);
    expect(ray.dir[2]).toBeLessThan(0);
    // normalisiert
    expect(Math.hypot(...ray.dir)).toBeCloseTo(1, 6);
  });
});

// Wand: Achse model (-1,5)→(1,5) → world x∈[-1,1], z≈5. Dicke 0.2, Höhe 2 ab 0.
const WALL: PickWall = {
  start: [-1, 5],
  end: [1, 5],
  thickness: 0.2,
  height: 2,
  baseElevation: 0,
  wallId: "w1",
};

describe("rayWallBox", () => {
  it("Treffer liefert die Eintritts-Distanz (Vorderfläche)", () => {
    // Strahl von (0,1,10) entlang -Z trifft die Front bei z=5.1 → t=4.9.
    const t = rayWallBox({ origin: [0, 1, 10], dir: [0, 0, -1] }, WALL);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(4.9, 6);
  });

  it("Strahl neben der Wand verfehlt", () => {
    const t = rayWallBox({ origin: [5, 1, 10], dir: [0, 0, -1] }, WALL);
    expect(t).toBeNull();
  });

  it("Strahl über der Wandhöhe verfehlt", () => {
    const t = rayWallBox({ origin: [0, 5, 10], dir: [0, 0, -1] }, WALL);
    expect(t).toBeNull();
  });
});

// Decke: Quadrat model (0,0),(4,0),(4,4),(0,4), Platte z 2.9..3.0.
const SLAB: PickSlab = {
  outline: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
  zBottom: 2.9,
  zTop: 3.0,
  ceilingId: "c1",
};

describe("raySlabPrism", () => {
  it("Strahl von oben trifft den Deckel (kleinstes t)", () => {
    // eye (2,10,2) senkrecht nach unten: Deckel y=3 bei t=7.
    const t = raySlabPrism({ origin: [2, 10, 2], dir: [0, -1, 0] }, SLAB);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(7, 6);
  });

  it("Strahl neben dem Umriss verfehlt", () => {
    const t = raySlabPrism({ origin: [10, 10, 2], dir: [0, -1, 0] }, SLAB);
    expect(t).toBeNull();
  });

  it("horizontaler Strahl trifft eine Seitenfläche", () => {
    // Von (-5, 2.95, 2) entlang +X: Seitenquad bei x=0 in Höhe 2.9..3 → t=5.
    const t = raySlabPrism({ origin: [-5, 2.95, 2], dir: [1, 0, 0] }, SLAB);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(5, 6);
  });
});

describe("pickNearest", () => {
  it("das nähere Bauteil gewinnt (Wand vor Decke)", () => {
    // Ray -Z: Wand (front z=5.1, t=4.9). Decke als vertikale Wand weiter hinten.
    const farSlab: PickSlab = {
      outline: [
        [-1, 0],
        [1, 0],
        [1, 0.01],
        [-1, 0.01],
      ],
      zBottom: 0,
      zTop: 2,
      ceilingId: "c-far",
    };
    const hit = pickNearest({ origin: [0, 1, 10], dir: [0, 0, -1] }, [WALL], [farSlab]);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("wall");
    expect(hit!.id).toBe("w1");
  });

  it("Leertreffer liefert null", () => {
    const hit = pickNearest({ origin: [50, 50, 10], dir: [0, 0, -1] }, [WALL], [SLAB]);
    expect(hit).toBeNull();
  });
});
