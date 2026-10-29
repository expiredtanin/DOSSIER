import { describe, expect, it } from "vitest";
import { MODEL_UNITS, PAPER_UNITS, fmtLength, rulerLabel, unitsForLevel, xToDisplay, yFromDisplay, yToDisplay } from "./displayUnits";
import { parseInput, toModelInput } from "../commands/parseInput";
import { hudSegments } from "./hudFormat";

describe("[93] Anzeige-Einheiten auf dem Layout-Blatt", () => {
  it("Blatt-Ebene = Papier-mm mit y nach unten, sonst Meter", () => {
    expect(unitsForLevel({ layoutId: "L" })).toBe(PAPER_UNITS);
    expect(unitsForLevel({})).toBe(MODEL_UNITS);
    // Blatt-Punkt (0.42, −0.297) = Papier (420, 297) mm.
    expect(xToDisplay(PAPER_UNITS, 0.42)).toBeCloseTo(420, 9);
    expect(yToDisplay(PAPER_UNITS, -0.297)).toBeCloseTo(297, 9);
    expect(yFromDisplay(PAPER_UNITS, 297)).toBeCloseTo(-0.297, 12);
    expect(fmtLength(PAPER_UNITS, 0.0125)).toBe("12.5mm");
    expect(fmtLength(MODEL_UNITS, 3)).toBe("3.000m");
  });

  it("Lineal: mm ohne Einheit, y positiv nach unten; Modell unverändert", () => {
    expect(rulerLabel(PAPER_UNITS, "x", 0.05)).toBe("50");
    expect(rulerLabel(PAPER_UNITS, "y", -0.1)).toBe("100");
    expect(rulerLabel(PAPER_UNITS, "y", 0)).toBe("0");
    expect(rulerLabel(MODEL_UNITS, "y", -1)).toBe("-1.000m");
  });

  it("getippte Koordinaten/Längen in Papier-mm → Blatt-Meter", () => {
    expect(toModelInput(parseInput("100,50"), PAPER_UNITS, "length")).toEqual({ kind: "absolute", point: { x: 0.1, y: -0.05 } });
    expect(toModelInput(parseInput("r10,20"), PAPER_UNITS, "length")).toEqual({ kind: "relative", delta: { x: 0.01, y: -0.02 } });
    expect(toModelInput(parseInput("50<30"), PAPER_UNITS, "length")).toEqual({ kind: "polar", dist: 0.05, angleDeg: 30 });
    expect(toModelInput(parseInput("25"), PAPER_UNITS, "length")).toEqual({ kind: "distance", value: 0.025 });
    expect(toModelInput(parseInput("25"), PAPER_UNITS, "dy")).toEqual({ kind: "distance", value: -0.025 });
    // Anzahl/Winkel/Faktor bleiben; im Modell bleibt alles.
    expect(toModelInput(parseInput("5"), PAPER_UNITS, "none")).toEqual({ kind: "distance", value: 5 });
    expect(toModelInput(parseInput("100,50"), MODEL_UNITS, "length")).toEqual({ kind: "absolute", point: { x: 100, y: 50 } });
  });

  it("Cursor-HUD in mm, Δy nach unten", () => {
    const segs = hudSegments({ at: { x: 0, y: 0 }, dx: 0.03, dy: -0.02 }, null, PAPER_UNITS).map((s) => s.text);
    expect(segs).toEqual(["Δx: 30.0mm", "Δy: 20.0mm"]);
    const l = hudSegments({ at: { x: 0, y: 0 }, length: 0.05, angleDeg: 90 }, null, PAPER_UNITS).map((s) => s.text);
    expect(l).toEqual(["L: 50.0mm", "W: 90.000°"]);
    const f = hudSegments({ at: { x: 0, y: 0 }, length: 0.05, angleDeg: 0 }, {
      fields: [
        { id: "length", value: null, locked: false, active: true },
        { id: "angle", value: 45, locked: true, active: false },
      ],
      typed: "",
    }, PAPER_UNITS).map((s) => s.text);
    expect(f).toEqual(["L: 50.0mm", "W: 45.000°"]);
  });
});
