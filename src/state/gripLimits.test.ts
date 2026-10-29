import { describe, expect, it } from "vitest";
import { MAX_GRIP_DRAWINGS, MAX_GRIP_VERTICES, gripDrawingIdsFor } from "./gripLimits";

describe("gripDrawingIdsFor", () => {
  const counts = (n: number) => () => n;

  it("ein einzeln gewähltes Element bekommt immer Griffe, auch mit sehr vielen Stützpunkten (Kataster)", () => {
    // Fehlerbericht 29.10.: Strassenparzelle/Bodenbedeckung aus DWG mit > 600 Stützpunkten → keine Griffe.
    expect(gripDrawingIdsFor(["road"], counts(25_000))).toEqual(["road"]);
  });

  it("Mehrfachauswahl unter den Grenzen: alle bekommen Griffe", () => {
    expect(gripDrawingIdsFor(["a", "b"], counts(10))).toEqual(["a", "b"]);
  });

  it("Mehrfachauswahl über der Stützpunkt-Grenze: keine Griffe (wie bisher)", () => {
    const per = Math.ceil((MAX_GRIP_VERTICES + 1) / 2);
    expect(gripDrawingIdsFor(["a", "b"], counts(per))).toEqual([]);
  });

  it("Mehrfachauswahl über der Objekt-Grenze: keine Griffe (wie bisher)", () => {
    const ids = Array.from({ length: MAX_GRIP_DRAWINGS + 1 }, (_, i) => `d${i}`);
    expect(gripDrawingIdsFor(ids, counts(1))).toEqual([]);
  });

  it("leere Auswahl", () => {
    expect(gripDrawingIdsFor([], counts(1))).toEqual([]);
  });
});
