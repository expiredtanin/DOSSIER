import { describe, expect, it } from "vitest";
import { looksLikeLv95, placePointCloud } from "./pointCloudPlacement";

const lv95Cloud = {
  origin: [2_600_100, 1_200_050, 450] as [number, number, number],
  bboxMin: [2_600_090, 1_200_040, 440] as [number, number, number],
  bboxMax: [2_600_120, 1_200_070, 470] as [number, number, number],
};

describe("placePointCloud", () => {
  it("passt eine LV95-Wolke über den Standort-Bezug ein (Höhe aus dem Anker)", () => {
    const p = placePointCloud({ ...lv95Cloud, epsg: 2056 }, { e: 2_600_000, n: 1_200_000 }, 445);
    expect(p.mode).toBe("georef");
    expect(p.offset).toEqual([100, 50, 5]);
    expect(p.heightFromAnchor).toBe(true);
    expect(p.epsgAssumed).toBe(false);
  });

  it("ohne Ankerhöhe: tiefster Punkt auf 0", () => {
    const p = placePointCloud({ ...lv95Cloud, epsg: 2056 }, { e: 2_600_000, n: 1_200_000 });
    expect(p.offset).toEqual([100, 50, 10]);
    expect(p.heightFromAnchor).toBe(false);
  });

  it("ohne EPSG, aber mit LV95-Koordinaten: LV95 angenommen", () => {
    const p = placePointCloud({ ...lv95Cloud, epsg: null }, { e: 2_600_000, n: 1_200_000 }, 440);
    expect(p.mode).toBe("georef");
    expect(p.epsgAssumed).toBe(true);
  });

  it("anderes EPSG mit Bezug: nicht georeferenziert, sondern zentriert", () => {
    const p = placePointCloud({ ...lv95Cloud, epsg: 4326 }, { e: 2_600_000, n: 1_200_000 });
    expect(p.mode).toBe("centered");
  });

  it("ohne Bezug: Landeskoordinaten werden mittig auf den Nullpunkt gelegt", () => {
    const p = placePointCloud({ ...lv95Cloud, epsg: 2056 }, null);
    expect(p.mode).toBe("centered");
    // Mitte (2 600 105 / 1 200 055) → 0, tiefster Punkt 440 → 0.
    expect(p.offset).toEqual([-5, -5, 10]);
  });

  it("lokale Koordinaten bleiben wie in der Datei", () => {
    const p = placePointCloud(
      { origin: [3, 4, 0], bboxMin: [-5, -5, -1], bboxMax: [12, 9, 6], epsg: null },
      { e: 2_600_000, n: 1_200_000 },
    );
    expect(p.mode).toBe("local");
    expect(p.offset).toEqual([3, 4, 0]);
  });

  it("erkennt LV95-Bereich", () => {
    expect(looksLikeLv95(lv95Cloud.bboxMin, lv95Cloud.bboxMax)).toBe(true);
    expect(looksLikeLv95([600_000, 200_000, 0], [600_100, 200_100, 0])).toBe(false); // LV03
  });
});
