import { describe, expect, it } from "vitest";
import { fromWorldInput, isLv95, parseInput } from "./parseInput";

describe("[221] getippte Landeskoordinaten", () => {
  const origin = { e: 2_600_000, n: 1_200_000 };
  it("absolute LV95-Eingabe wird bei Standort-Bezug auf den Projekt-Nullpunkt gerechnet", () => {
    expect(fromWorldInput(parseInput("2600048,1200046"), origin)).toEqual({ kind: "absolute", point: { x: 48, y: 46 } });
  });
  it("lokale, relative Eingaben und Projekte ohne Bezug bleiben", () => {
    expect(fromWorldInput(parseInput("48,46"), origin)).toEqual({ kind: "absolute", point: { x: 48, y: 46 } });
    expect(fromWorldInput(parseInput("r2600048,1200046"), origin).kind).toBe("relative");
    expect(fromWorldInput(parseInput("2600048,1200046"), null)).toEqual({ kind: "absolute", point: { x: 2600048, y: 1200046 } });
  });
  it("LV95-Bereich", () => {
    expect(isLv95(2_600_000, 1_200_000)).toBe(true);
    expect(isLv95(600_000, 200_000)).toBe(false);
    expect(isLv95(48, 46)).toBe(false);
  });
});
