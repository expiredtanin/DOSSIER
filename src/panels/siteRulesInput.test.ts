import { describe, expect, it } from "vitest";
import { lineFromDrawing, parcelFromDrawing } from "./siteRulesInput";
import type { Drawing2D, Drawing2DGeom } from "../model/types";

const d = (geom: Drawing2DGeom): Drawing2D => ({ id: "d", type: "drawing2d", levelId: "eg", categoryCode: "20", geom }) as Drawing2D;

describe("Parzelle und Baulinie aus der Auswahl", () => {
  it("Rechteck und geschlossene Polylinie (doppelter Schlusspunkt entfällt)", () => {
    expect(parcelFromDrawing(d({ shape: "rect", min: { x: 0, y: 0 }, max: { x: 2, y: 1 } }))).toHaveLength(4);
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }, { x: 0, y: 2 }, { x: 0, y: 0 }];
    expect(parcelFromDrawing(d({ shape: "polyline", pts, closed: true }))).toHaveLength(4);
  });
  it("offene Polylinie ist keine Parzelle, aber zweipunktig eine Baulinie", () => {
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 0 }];
    expect(parcelFromDrawing(d({ shape: "polyline", pts, closed: false }))).toBeNull();
    expect(lineFromDrawing(d({ shape: "polyline", pts, closed: false }))).toEqual({ a: pts[0], b: pts[1] });
    expect(lineFromDrawing(d({ shape: "line", a: pts[0], b: pts[1] }))).toEqual({ a: pts[0], b: pts[1] });
    expect(lineFromDrawing(undefined)).toBeNull();
  });
});
