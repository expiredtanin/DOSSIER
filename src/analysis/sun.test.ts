import { describe, expect, it } from "vitest";
import { sunPosition, shadowOfPrism, shadowPolygons } from "./sun";
import { sampleProject } from "../model/sampleProject";

describe("sunPosition", () => {
  it("Zürich, Sommersonnenwende, Sonnenhöchststand ≈ 66°, Süden", () => {
    const s = sunPosition(47.37, 8.54, new Date(Date.UTC(2026, 5, 21, 11, 26)));
    expect(s.elevation).toBeGreaterThan(65.5);
    expect(s.elevation).toBeLessThan(66.6);
    expect(Math.abs(s.azimuth - 180)).toBeLessThan(3);
  });
  it("Wintersonnenwende mittags ≈ 19°, nachts unter dem Horizont", () => {
    const noon = sunPosition(47.37, 8.54, new Date(Date.UTC(2026, 11, 21, 11, 20)));
    expect(noon.elevation).toBeGreaterThan(18.5);
    expect(noon.elevation).toBeLessThan(19.8);
    expect(sunPosition(47.37, 8.54, new Date(Date.UTC(2026, 5, 21, 23, 0))).elevation).toBeLessThan(0);
  });
  it("Vormittags steht die Sonne im Osten", () => {
    const s = sunPosition(47.37, 8.54, new Date(Date.UTC(2026, 2, 21, 6, 0)));
    expect(s.azimuth).toBeGreaterThan(60);
    expect(s.azimuth).toBeLessThan(120);
  });
});

describe("Schatten", () => {
  const sq = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
  it("Prisma 4 m hoch, Sonne im Süden auf 45° → Schatten 4 m nach Norden", () => {
    const sh = shadowOfPrism(sq, 0, 4, { azimuth: 180, elevation: 45 });
    const ys = sh.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(6, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
  });
  it("Sonne unter dem Horizont → kein Schatten, Projekt liefert Polygone am Tag", () => {
    expect(shadowOfPrism(sq, 0, 4, { azimuth: 0, elevation: -3 })).toEqual([]);
    expect(shadowPolygons(sampleProject, { azimuth: 200, elevation: 30 }).length).toBeGreaterThan(0);
    expect(shadowPolygons(sampleProject, { azimuth: 200, elevation: -3 })).toEqual([]);
  });
});
