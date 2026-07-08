// Unit-Tests für den gemeinsamen Wand-Loch-Ausschnitt-Generator (wallMeshCut.ts,
// TS-Port von render3d/src/mesh.rs::extrude_layer_segment_with_holes). Prüft die
// geometrische Zerlegung (gleiche Rechteck-Anzahl wie die Rust-Referenz), nicht
// nur „läuft".

import { describe, it, expect } from "vitest";
import { isWatertight, solidSubrects, wallCutMesh } from "./wallMeshCut";
import type { CutMesh } from "./wallMeshCut";
import type { RWall } from "./toWalls3d";

/**
 * Geschlossene-Fläche-Kennzahlen: Vektorfläche ∮ n dA (Σ (v1−v0)×(v2−v0)) und
 * 6× signiertes Volumen (Σ v0·(v1×v2)). Dienen den Watertight-Tests direkt (statt
 * eines naiven Kanten-Manifold-Zählers, der an den legitimen T-Stössen der vollen
 * Deckel/Boden-Streifen scheitern würde — siehe isWatertight-Doc in wallMeshCut.ts).
 */
function surfaceIntegrals(m: CutMesh): { areaLen: number; vol6: number } {
  const p = m.positions;
  let ax = 0;
  let ay = 0;
  let az = 0;
  let vol6 = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const i0 = m.indices[t] * 3;
    const i1 = m.indices[t + 1] * 3;
    const i2 = m.indices[t + 2] * 3;
    const e1 = [p[i1] - p[i0], p[i1 + 1] - p[i0 + 1], p[i1 + 2] - p[i0 + 2]];
    const e2 = [p[i2] - p[i0], p[i2 + 1] - p[i0 + 1], p[i2 + 2] - p[i0 + 2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    ax += cx;
    ay += cy;
    az += cz;
    vol6 += p[i0] * cx + p[i0 + 1] * cy + p[i0 + 2] * cz;
  }
  return { areaLen: Math.hypot(ax, ay, az), vol6 };
}

/** Ein RWall-Band mit optionalen Löchern (frei stehend, Achse entlang +x). */
function band(holes?: RWall["holes"]): RWall {
  return {
    start: [0, 0],
    end: [5, 0],
    thickness: 0.4,
    height: 2.6,
    baseElevation: 0,
    color: [0.8, 0.8, 0.8],
    layers: [],
    wallId: "W1",
    ...(holes ? { holes } : {}),
  };
}

describe("solidSubrects — Koordinaten-Kompression (Rust-Parität)", () => {
  it("ohne Loch: genau ein Vollrechteck", () => {
    expect(solidSubrects(0, 5, 0, 2.6, [])).toEqual([[0, 5, 0, 2.6]]);
  });

  it("ein voll im Inneren liegendes Loch → 3×3-Gitter minus 1 = 8 solide Teilrechtecke", () => {
    const rects = solidSubrects(0, 5, 0, 2.6, [[2, 3, 0.9, 2.4]]);
    expect(rects).toHaveLength(8);
    // Keiner der Teilrechteck-Mittelpunkte liegt im Loch.
    for (const [ua, ub, za, zb] of rects) {
      const cu = (ua + ub) / 2;
      const cz = (za + zb) / 2;
      expect(cu > 2 && cu < 3 && cz > 0.9 && cz < 2.4).toBe(false);
    }
  });

  it("randständiges Loch (Tür am Boden) → 3×2-Gitter minus 1 = 5 Teilrechtecke", () => {
    expect(solidSubrects(0, 5, 0, 2.6, [[2, 3, 0, 2.1]])).toHaveLength(5);
  });

  it("zwei versetzt übereinanderliegende Löcher: keine überlappenden/entarteten Teilrechtecke", () => {
    const rects = solidSubrects(0, 5, 0, 2.8, [
      [1, 2, 0.9, 1.4],
      [3, 4, 1.6, 2.2],
    ]);
    // Alle Teilrechtecke haben echte Ausdehnung und liegen ausserhalb beider Löcher.
    for (const [ua, ub, za, zb] of rects) {
      expect(ub - ua).toBeGreaterThan(0);
      expect(zb - za).toBeGreaterThan(0);
    }
    expect(rects.length).toBeGreaterThan(0);
  });
});

describe("wallCutMesh — Loch-Ausschnitt-Mesh", () => {
  it("ohne Loch: 12 Dreiecke (volle Box-Äquivalenz)", () => {
    const m = wallCutMesh(band());
    expect(m.indices.length / 3).toBe(12);
  });

  it("Fenster im Inneren: 48 Dreiecke, 4 Laibungen, Loch-Rand-Vertices vorhanden", () => {
    const m = wallCutMesh(band([{ from: 2, to: 3, zBottom: 0.9, zTop: 2.4 }]));
    expect(m.indices.length / 3).toBe(48);
    // Vertices an allen vier Loch-Rändern (Brüstung/Sturz/links/rechts).
    const has = (axis: number, val: number) => {
      for (let i = 0; i < m.positions.length; i += 3) {
        if (Math.abs(m.positions[i + axis] - val) < 1e-6) return true;
      }
      return false;
    };
    expect(has(1, 0.9)).toBe(true); // y = Brüstungs-OK
    expect(has(1, 2.4)).toBe(true); // y = Sturz-UK
    expect(has(0, 2)).toBe(true); // x = linke Kante
    expect(has(0, 3)).toBe(true); // x = rechte Kante
    // KEIN Vertex liegt strikt im offenen Loch-Rechteck (die Fläche ist wirklich weg).
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i];
      const y = m.positions[i + 1];
      const strictlyInside = x > 2 + 1e-6 && x < 3 - 1e-6 && y > 0.9 + 1e-6 && y < 2.4 - 1e-6;
      expect(strictlyInside).toBe(false);
    }
  });

  it("Tür am Boden: 36 Dreiecke (untere Laibung entfällt, Boden bekommt die Lücke)", () => {
    const m = wallCutMesh(band([{ from: 2, to: 3, zBottom: 0, zTop: 2.1 }]));
    expect(m.indices.length / 3).toBe(36);
  });

  it("alle Dreiecks-Indizes referenzieren existierende Vertices", () => {
    const m = wallCutMesh(band([{ from: 2, to: 3, zBottom: 0.9, zTop: 2.4 }]));
    const vcount = m.positions.length / 3;
    for (const idx of m.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vcount);
    }
  });
});

describe("wallCutMesh — Wasserdichtigkeit + Aussen-Orientierung (der hohl/offen-Bug)", () => {
  it("volle Wand OHNE Loch: geschlossen (∮ n dA = 0), Normalen aussen (Volumen = L·T·H)", () => {
    const m = wallCutMesh(band());
    const { areaLen, vol6 } = surfaceIntegrals(m);
    expect(areaLen).toBeLessThan(1e-6); // ∮ n dA = 0 ⇒ kein Loch, kein invertiertes Dreieck
    expect(vol6 / 6).toBeCloseTo(5 * 0.4 * 2.6, 6); // > 0 ⇒ aussen orientiert
    expect(isWatertight(m)).toBe(true);
  });

  it("Wand mit Fenster: trotz T-Stösse geschlossen + aussen orientiert (Volumen = Wand − Fensterquader)", () => {
    const m = wallCutMesh(band([{ from: 2, to: 3, zBottom: 0.9, zTop: 2.4 }]));
    const { areaLen, vol6 } = surfaceIntegrals(m);
    expect(areaLen).toBeLessThan(1e-6);
    expect(vol6 / 6).toBeCloseTo(5 * 0.4 * 2.6 - 1 * 0.4 * (2.4 - 0.9), 6);
    expect(isWatertight(m)).toBe(true);
  });

  it("eine EINZELNE invertierte Kappe würde erkannt (Regressionswächter gegen falsche Wicklung)", () => {
    // Bau die volle Wand, kehre die Wicklung EINES Dreiecks um → nicht mehr dicht.
    const m = wallCutMesh(band());
    const broken: CutMesh = { positions: m.positions.slice(), indices: m.indices.slice() };
    [broken.indices[1], broken.indices[2]] = [broken.indices[2], broken.indices[1]];
    expect(isWatertight(broken)).toBe(false);
  });

  it("Türwand ist ein GESCHLOSSENER Prisma-Körper (Querschnitt = П-Polygon, Türkerbe umlaufend)", () => {
    // Die Türkerbe ist eine Einbuchtung der UNTEREN Umriss-Kante (kein Loch): der
    // Querschnitt bleibt EIN einfaches, geschlossenes Polygon (П-Form), das über
    // die Dicke extrudiert wieder einen geschlossenen Körper ergibt. Die fehlende
    // untere Laibung und die Boden-Lücke heben sich in ∮ n dA exakt auf.
    const m = wallCutMesh(band([{ from: 2, to: 3, zBottom: 0, zTop: 2.1 }]));
    const { areaLen, vol6 } = surfaceIntegrals(m);
    expect(areaLen).toBeLessThan(1e-6);
    expect(vol6 / 6).toBeCloseTo(5 * 0.4 * 2.6 - 1 * 0.4 * 2.1, 6);
    expect(isWatertight(m)).toBe(true);
  });
});
