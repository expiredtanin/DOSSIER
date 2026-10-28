import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../io/pointCloud";
import { planPointCloudSync } from "./pointCloudSync";
import type { PointCloudSyncItem, UploadedPointCloud } from "./pointCloudSync";

const data = (): PointCloudData => ({
  origin: [0, 0, 0],
  xyz: new Float32Array(3),
  rgb: null,
  intensity: null,
  classification: null,
  report: {} as PointCloudData["report"],
});

function item(id: number, d: PointCloudData, p: Partial<PointCloudSyncItem> = {}): PointCloudSyncItem {
  return { id, data: d, offset: [0, 0, 0], colorMode: "rgb", pointSize: 2, visible: true, ...p };
}

const asUploaded = (i: PointCloudSyncItem): UploadedPointCloud => ({
  data: i.data,
  offset: [...i.offset],
  colorMode: i.colorMode,
  pointSize: i.pointSize,
  visible: i.visible,
});

describe("planPointCloudSync", () => {
  it("lädt neue Wolken hoch und entfernt verschwundene", () => {
    const d1 = data();
    const prev = new Map([[9, asUploaded(item(9, data()))]]);
    expect(planPointCloudSync(prev, [item(1, d1)])).toEqual([
      { kind: "remove", id: 9 },
      { kind: "set", item: item(1, d1) },
    ]);
  });

  it("nur Darstellung geändert → style, unverändert → nichts", () => {
    const d = data();
    const prev = new Map([[1, asUploaded(item(1, d))]]);
    expect(planPointCloudSync(prev, [item(1, d)])).toEqual([]);
    const ops = planPointCloudSync(prev, [item(1, d, { colorMode: "height", visible: false })]);
    expect(ops.map((o) => o.kind)).toEqual(["style"]);
  });

  it("neue Daten oder neue Lage → neu hochladen", () => {
    const d = data();
    const prev = new Map([[1, asUploaded(item(1, d))]]);
    expect(planPointCloudSync(prev, [item(1, data())]).map((o) => o.kind)).toEqual(["set"]);
    expect(planPointCloudSync(prev, [item(1, d, { offset: [0, 0, 1] })]).map((o) => o.kind)).toEqual(["set"]);
  });
});
