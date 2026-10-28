import { beforeEach, describe, expect, it } from "vitest";
import type { PointCloudData, PointCloudReport } from "../io/pointCloud";
import {
  addPointCloud,
  clearPointClouds,
  defaultColorMode,
  getPointClouds,
  removePointCloud,
  resetPointCloudStoreForTests,
  updatePointCloud,
} from "./pointCloudStore";

function report(p: Partial<PointCloudReport> = {}): PointCloudReport {
  return {
    format: "las",
    version: "1.4",
    pointFormat: 3,
    pointsDeclared: 2,
    pointsRead: 2,
    pointsKept: 2,
    pointsInvalid: 0,
    voxel: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [1, 1, 1],
    origin: [0, 0, 0],
    hasColor: false,
    hasIntensity: false,
    hasClassification: false,
    intensityRange: null,
    classCounts: [],
    epsg: null,
    truncated: false,
    warnings: [],
    ...p,
  };
}

function cloud(p: Partial<PointCloudReport> = {}): PointCloudData {
  return {
    origin: [0, 0, 0],
    xyz: new Float32Array(6),
    rgb: null,
    intensity: null,
    classification: null,
    report: report(p),
  };
}

describe("pointCloudStore", () => {
  beforeEach(() => resetPointCloudStoreForTests());

  it("wählt den Farbmodus nach vorhandenen Attributen", () => {
    expect(defaultColorMode(report({ hasColor: true, hasIntensity: true }))).toBe("rgb");
    expect(defaultColorMode(report({ hasIntensity: true }))).toBe("intensity");
    expect(defaultColorMode(report({ hasClassification: true }))).toBe("class");
    expect(defaultColorMode(report())).toBe("height");
  });

  it("fügt hinzu, ändert und entfernt", () => {
    const a = addPointCloud("a.las", cloud({ hasColor: true }));
    const b = addPointCloud("b.xyz", cloud());
    expect(getPointClouds().map((c) => c.id)).toEqual([a, b]);
    expect(getPointClouds()[0]).toMatchObject({ visible: true, colorMode: "rgb", pointSize: 2 });

    const before = getPointClouds();
    updatePointCloud(a, { visible: false, pointSize: 99 });
    expect(getPointClouds()).not.toBe(before); // neue Referenz → React rendert neu
    expect(getPointClouds()[0]).toMatchObject({ visible: false, pointSize: 10 });
    updatePointCloud(a, { pointSize: Number.NaN, colorMode: "quatsch" as never });
    expect(getPointClouds()[0]).toMatchObject({ pointSize: 10, colorMode: "rgb" });

    removePointCloud(a);
    expect(getPointClouds().map((c) => c.id)).toEqual([b]);
    const same = getPointClouds();
    removePointCloud(12345);
    expect(getPointClouds()).toBe(same);
    clearPointClouds();
    expect(getPointClouds()).toEqual([]);
  });
});
