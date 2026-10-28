import { describe, expect, it } from "vitest";
import { DEFAULT_AREA_INPUTS, ivhbOptionsOf, parseAreaNumber } from "./areaInputs";

describe("Flächen-Eingaben", () => {
  it("Komma und Punkt, leer und Unsinn", () => {
    expect(parseAreaNumber("412,5")).toBe(412.5);
    expect(parseAreaNumber(" 300.25 ")).toBe(300.25);
    expect(parseAreaNumber("")).toBeUndefined();
    expect(parseAreaNumber("abc")).toBeUndefined();
    expect(parseAreaNumber("-3")).toBeUndefined();
    expect(parseAreaNumber("Infinity")).toBeUndefined();
  });
  it("Optionen für den Kern", () => {
    expect(ivhbOptionsOf(DEFAULT_AREA_INPUTS)).toEqual({ agsf: undefined, greenArea: undefined, agfBasis: "ngf", includeUnderground: false });
    expect(ivhbOptionsOf({ agsf: "500", greenArea: "120,5", agfBasis: "gf", includeUnderground: true })).toEqual({
      agsf: 500,
      greenArea: 120.5,
      agfBasis: "gf",
      includeUnderground: true,
    });
  });
});
