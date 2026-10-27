import { describe, expect, it } from "vitest";
import { allowedArea, checkSiteRules, multiPolygonArea } from "./siteRules";
import { computeKennzahlen } from "./kennzahlen";
import type { ExtrudedSolid, Project, SiteRules, Vec2 } from "../model/types";

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
// Parzelle 30 × 20 m; Kante 0 = Süd (y = 0), 1 = Ost, 2 = Nord, 3 = West.
const parcel = rect(0, 0, 30, 20);
const base: SiteRules = { parcel, defaultSetback: 4 };

function project(site: SiteRules, solids: ExtrudedSolid[] = []): Project {
  return {
    id: "t", name: "T", lineStyles: [], hatches: [], components: [], wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 3, cutHeight: 1, baseElevation: 0 },
    ],
    layers: [], walls: [], openings: [], ceilings: [], stairs: [], rooms: [], drawings2d: [], context: [],
    extrudedSolids: solids, siteRules: site,
  } as unknown as Project;
}
const solid = (pts: Vec2[], height: number): ExtrudedSolid =>
  ({ id: "k" + pts[0].x, type: "extrudedSolid", levelId: "eg", points: pts, height }) as ExtrudedSolid;

describe("zulässige Grundfläche", () => {
  it("gleicher Grenzabstand rundum → inneres Rechteck", () => {
    expect(multiPolygonArea(allowedArea(base))).toBeCloseTo(22 * 12, 6);
  });
  it("Grenzabstand je Kante (Süden 8 m)", () => {
    expect(multiPolygonArea(allowedArea({ ...base, setbacks: [8] }))).toBeCloseTo(22 * 8, 6);
  });
  it("Baulinie begrenzt auf der Seite der Parzelle", () => {
    // Baulinie bei y = 14, Richtung egal: zulässig ist die Seite mit dem Parzellen-Schwerpunkt.
    const site = { ...base, setbacks: [8], buildingLines: [{ a: { x: 30, y: 14 }, b: { x: 0, y: 14 } }] };
    expect(multiPolygonArea(allowedArea(site))).toBeCloseTo(22 * 6, 6);
  });
  it("Uhrzeigersinn der Parzelle spielt keine Rolle", () => {
    expect(multiPolygonArea(allowedArea({ ...base, parcel: parcel.slice().reverse() }))).toBeCloseTo(22 * 12, 6);
  });
  it("einspringende Ecke: Abstand als Kreisbogen um die Ecke", () => {
    // L-Parzelle, 2 m rundum: scharfe Innen-L 156 m² plus (8..10)² ausserhalb des Kreises um (10, 10).
    const l = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
    expect(multiPolygonArea(allowedArea({ parcel: l, defaultSetback: 2 }))).toBeCloseTo(160 - Math.PI, 3);
  });
  it("ungültige Parzelle → keine Fläche, kein Absturz", () => {
    expect(allowedArea({ parcel: rect(0, 0, 1, 1).slice(0, 2), defaultSetback: 1 })).toEqual([]);
    expect(multiPolygonArea(allowedArea({ parcel, defaultSetback: Number.NaN }))).toBeCloseTo(600, 6);
  });
});

describe("Prüfung gegen das Modell", () => {
  it("Körper über dem Grenzabstand → Verstoss mit Fläche", () => {
    const r = checkSiteRules(project(base, [solid(rect(1, 1, 6, 6), 6)]))!;
    expect(r.violationArea).toBeCloseTo(25 - 4, 6);
    expect(r.heightExceeded).toBe(false);
  });
  it("Höhe über der Gesamthöhe", () => {
    const r = checkSiteRules(project({ ...base, maxHeight: 10 }, [solid(rect(10, 6, 16, 12), 12)]))!;
    expect(r.violationArea).toBeCloseTo(0, 6);
    expect(r.maxTop).toBeCloseTo(12, 6);
    expect(r.heightExceeded).toBe(true);
  });
  it("ohne Baurecht → null", () => {
    expect(checkSiteRules({ ...project(base), siteRules: undefined })).toBeNull();
  });
  it("Parzellenfläche aus der Grenze, wenn keine Zahl gesetzt ist", () => {
    const p = project(base, [solid(rect(10, 6, 16, 12), 6)]);
    expect(computeKennzahlen(p).az).not.toBeNull();
    expect(computeKennzahlen({ ...p, parcelArea: 1000 }).az).toBeCloseTo(computeKennzahlen(p).agf / 1000, 9);
  });
});
