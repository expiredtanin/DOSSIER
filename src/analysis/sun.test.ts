import { describe, expect, it } from "vitest";
import { sunPosition, shadowOfPrism, shadowPolygons, withoutHoles, projectLatLon } from "./sun";
import { polygonArea } from "../geometry/roomArea";
import type { Vec2 } from "../model/types";
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

describe("Schatten mit Hof", () => {
  // Quadratischer Ring (aussen 20 m, Hof 10 m) als Polygon mit Loch.
  const ring = (x0: number, y0: number, s: number): Vec2[] => [
    { x: x0, y: y0 }, { x: x0 + s, y: y0 }, { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s },
  ];
  const courtyard = [ring(0, 0, 20), ring(5, 5, 10).reverse()];
  it("lochfreie Teile haben dieselbe Fläche wie Aussenring minus Hof", () => {
    const parts = withoutHoles(courtyard);
    expect(parts.length).toBeGreaterThan(1);
    const sum = parts.reduce((s, p) => s + Math.abs(polygonArea(p)), 0);
    expect(sum).toBeCloseTo(400 - 100, 6);
    // Kein Teil enthält den Hofmittelpunkt.
    for (const p of parts) {
      const xs = p.map((q) => q.x);
      const ys = p.map((q) => q.y);
      const inside = Math.min(...xs) < 10 && Math.max(...xs) > 10 && Math.min(...ys) < 10 && Math.max(...ys) > 10;
      expect(inside && Math.abs(polygonArea(p)) > 150).toBe(false);
    }
  });
  it("ohne Loch bleibt das Polygon unverändert", () => {
    expect(withoutHoles([ring(0, 0, 3)])).toEqual([ring(0, 0, 3)]);
  });
  it("Projekt-Schatten: erster Ring je Polygon ist der Aussenring", () => {
    const polys = shadowPolygons(sampleProject, { azimuth: 200, elevation: 30 });
    for (const p of polys) expect(p[0].length).toBeGreaterThanOrEqual(3);
  });
});

// [142] Musterhaus komplex, Studienzeitpunkt: alle Schatten von der Sonne weg — kein Schattenpunkt liegt
// weiter zur Sonne hin als der sonnennächste Körperpunkt (früher warfen Untergeschoss-Wände und Stützmauer
// unter ±0.00 Schattenstücke zur Sonne hin).
describe("Schatten in eine Richtung (Musterhaus komplex)", () => {
  it("kein Schattenpunkt auf der Sonnenseite der Körper", async () => {
    const { buildComplexSampleProject } = await import("../model/sampleProjectComplex");
    const p = buildComplexSampleProject();
    const { lat, lon } = projectLatLon(p);
    const sun = sunPosition(lat, lon, new Date(p.sunStudy!.when));
    const az = (sun.azimuth * Math.PI) / 180;
    const dot = (v: Vec2) => v.x * Math.sin(az) + v.y * Math.cos(az);
    // [142] auch Stützen und Bäume (Kreise der Ebene 13) werfen Schatten; Baum: sonnennächster Kronenpunkt.
    const trees = p.drawings2d.flatMap((d) => (d.categoryCode === "13" && d.geom.shape === "circle" ? [{ x: d.geom.center.x + d.geom.r * Math.sin(az), y: d.geom.center.y + d.geom.r * Math.cos(az) }] : []));
    const casters: Vec2[] = [
      ...p.walls.flatMap((w) => [w.start, w.end]),
      ...(p.extrudedSolids ?? []).flatMap((s) => s.points),
      ...(p.columns ?? []).map((c) => c.position),
      ...trees,
    ];
    const shadows = shadowPolygons(p, sun);
    expect(shadows.length).toBeGreaterThan(0);
    const pts = shadows.flatMap((poly) => poly[0]);
    expect(Math.max(...pts.map(dot))).toBeLessThanOrEqual(Math.max(...casters.map(dot)) + 0.3);
    // und die Schatten reichen deutlich von der Sonne weg (nicht nur Grundflächen)
    expect(Math.min(...pts.map(dot))).toBeLessThan(Math.min(...casters.map(dot)) - 2);
  });
});

// [186] Grundriss EG (Schnitt 1.0): Der Schatten schliesst an die Fassaden auf der Schattenseite an. Vorher lag
// unter dem Dachvorsprung (Nord 0.6 m, West 0.35 m) kein Schatten — die Traufe galt als Abdeckung —, er
// begann erst jenseits davon.
describe("Schatten an der Fassade (Musterhaus komplex, EG)", () => {
  it("Punkte 1 cm vor Nord- und Westfassade liegen im Schatten", async () => {
    const { buildComplexSampleProject } = await import("../model/sampleProjectComplex");
    const p = buildComplexSampleProject();
    const { lat, lon } = projectLatLon(p);
    const sun = sunPosition(lat, lon, new Date(p.sunStudy!.when));
    const shadows = shadowPolygons(p, sun, 1.0);
    const inside = (q: Vec2, r: Vec2[]) => {
      let c = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (r[i].y > q.y !== r[j].y > q.y && q.x < ((r[j].x - r[i].x) * (q.y - r[i].y)) / (r[j].y - r[i].y) + r[i].x) c = !c;
      }
      return c;
    };
    const shaded = (q: Vec2) => shadows.some((poly) => poly.reduce((c, r) => (inside(q, r) ? !c : c), false));
    // Aussenkante Nord (Atelier) y = 10.195, West x = −0.195.
    for (const x of [0.5, 2.5, 4.5]) expect(shaded({ x, y: 10.205 }), `Nord x=${x}`).toBe(true);
    for (const y of [6, 8, 9.5]) expect(shaded({ x: -0.205, y }), `West y=${y}`).toBe(true);
    // Das Innere bleibt ohne Schatten.
    expect(shaded({ x: 2.5, y: 7.5 })).toBe(false);
  });
});
