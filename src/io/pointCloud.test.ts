// Punktwolken-Fassade ([B9]): Rundreise über das Rust-WASM (kleine, im Test erzeugte Dateien).
// Die Formatdetails (LAS 1.0–1.4, LAZ, E57, PLY) prüfen die Rust-Tests in `pointcloud*.rs`.

import { beforeAll, describe, expect, it } from "vitest";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { isPointCloudFile, readPointCloud, readPointCloudFlat } from "./pointCloud";

beforeAll(loadFileioForTests);

/** LAS 1.2, Punktformat 2 (XYZ, Intensität, Klasse, RGB), Skala 1 mm. */
function makeLas(n: number): Uint8Array {
  const rec = 26;
  const buf = new Uint8Array(227 + n * rec);
  const dv = new DataView(buf.buffer);
  buf.set([0x4c, 0x41, 0x53, 0x46], 0);
  buf[24] = 1;
  buf[25] = 2;
  dv.setUint16(94, 227, true);
  dv.setUint32(96, 227, true);
  buf[104] = 2;
  dv.setUint16(105, rec, true);
  dv.setUint32(107, n, true);
  const off = [2683000, 1248000, 400];
  for (let i = 0; i < 3; i++) {
    dv.setFloat64(131 + 8 * i, 0.001, true);
    dv.setFloat64(155 + 8 * i, off[i], true);
  }
  dv.setFloat64(179, 2683000 + 99.9, true);
  dv.setFloat64(187, 2683000, true);
  dv.setFloat64(195, 1248000 + 9.9, true);
  dv.setFloat64(203, 1248000, true);
  dv.setFloat64(211, 405, true);
  dv.setFloat64(219, 400, true);
  for (let k = 0; k < n; k++) {
    const o = 227 + k * rec;
    dv.setInt32(o, Math.round((k % 1000) * 100), true); // x: 0,1 m Raster
    dv.setInt32(o + 4, Math.round(Math.floor(k / 1000) * 100), true);
    dv.setInt32(o + 8, (k % 6) * 1000, true);
    dv.setUint16(o + 12, k % 500, true);
    buf[o + 15] = k % 2 === 0 ? 2 : 6;
    dv.setUint16(o + 20, 65535, true);
  }
  return buf;
}

describe("readPointCloud (Rust-WASM)", () => {
  it("liest LAS: Werte, Anzahl, Ursprung, Klassifikation", () => {
    const c = readPointCloudFlat(makeLas(2000), "t.las", { maxPoints: 0 });
    expect(c.report.format).toBe("las");
    expect(c.report.pointsKept).toBe(2000);
    expect(c.xyz.length).toBe(6000);
    // absolut = origin + xyz
    expect(c.origin[0] + c.xyz[3]).toBeCloseTo(2683000.1, 3);
    expect(c.origin[2] + c.xyz[5]).toBeCloseTo(401, 3);
    expect(c.rgb?.[0]).toBe(255);
    expect(c.classification?.[0]).toBe(2);
    expect(c.classification?.[1]).toBe(6);
    expect(c.report.classCounts).toEqual([[2, 1000], [6, 1000]]);
    // f32 relativ zum Ursprung genügt für mm
    expect(Math.max(...c.xyz.map(Math.abs))).toBeLessThan(200);
  });

  it("dünnt über Budget und Voxel aus", () => {
    const las = makeLas(5000);
    const budget = readPointCloudFlat(las, "t.las", { maxPoints: 300 });
    expect(budget.report.pointsRead).toBe(5000);
    expect(budget.xyz.length / 3).toBeLessThanOrEqual(300);
    expect(budget.report.voxel).toBeGreaterThan(0);
    const vox = readPointCloudFlat(las, "t.las", { voxel: 1, maxPoints: 0 });
    // x: 100 Zellen, y: 0–0,4 m = 1 Zelle, z: 0–5 m = 6 Zellen
    expect(vox.xyz.length / 3).toBe(600);
    // Bounding-Box bleibt die der ganzen Datei
    expect(budget.report.bboxMax[0]).toBeCloseTo(2683000 + 99.9, 3);
  });

  it("liest XYZ-Text über readPointCloud (ohne Worker)", async () => {
    const text = new TextEncoder().encode("2600000.5 1200000.5 400\n2600001.5 1200001.5 401\n");
    const c = await readPointCloud(text.buffer as ArrayBuffer, "a.xyz");
    expect(c.report.format).toBe("xyz");
    expect(c.report.pointsKept).toBe(2);
  });

  it("wirft bei Unsinn verständliche Fehler (kein Panic)", () => {
    expect(() => readPointCloudFlat(new Uint8Array(0), "x.las")).toThrow();
    expect(() => readPointCloudFlat(new Uint8Array([1, 2, 3, 4, 5, 6]), "x.bin")).toThrow();
    expect(() => readPointCloudFlat(makeLas(10).slice(0, 100), "x.las")).toThrow(/abgeschnitten/);
    // Danach funktioniert das Modul weiter.
    expect(readPointCloudFlat(makeLas(3), "ok.las", { maxPoints: 0 }).report.pointsKept).toBe(3);
  });

  it("erkennt Dateiendungen", () => {
    expect(isPointCloudFile("Kachel_2683_1248.LAZ")).toBe(true);
    expect(isPointCloudFile("scan.e57")).toBe(true);
    expect(isPointCloudFile("plan.dxf")).toBe(false);
  });
});
