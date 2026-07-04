import { describe, it, expect } from "vitest";
import { unionDrawings } from "./booleanOps";
import type { Drawing2D } from "../model/types";

/** Geschlossenes Quadrat als Drawing2D mit optionalen Attributen. */
function square(
  id: string,
  x: number,
  extra: Partial<Drawing2D> = {},
): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "L1",
    categoryCode: "10",
    geom: {
      shape: "polyline",
      pts: [
        { x, y: 0 },
        { x: x + 2, y: 0 },
        { x: x + 2, y: 2 },
        { x, y: 2 },
      ],
      closed: true,
    },
    ...extra,
  };
}

describe("unionDrawings — Attribut-Vererbung vom ERST gewählten Element", () => {
  it("übernimmt Füllung/Ebene des ersten Elements, auch wenn das zweite keine hat", () => {
    // Element 1 (zuerst gewählt): rote Füllung via `background`, Schraffur, eigene
    // Ebene/Kategorie. Element 2: nackt. Die Formen überlappen.
    const first = square("a", 0, {
      background: "#ff0000",
      hatchId: "h1",
      color: "#333333",
      levelId: "L2",
      categoryCode: "20",
      foregroundSource: "layer",
    });
    const second = square("b", 1); // ohne Attribute, überlappt „a"

    const { created, replacedIds } = unionDrawings([first, second]);

    expect(replacedIds).toEqual(["a", "b"]);
    expect(created.length).toBeGreaterThanOrEqual(1);
    const outer = created[0];
    // Volles Erscheinungsbild des ersten Elements bleibt erhalten:
    expect(outer.background).toBe("#ff0000");
    expect(outer.hatchId).toBe("h1");
    expect(outer.color).toBe("#333333");
    expect(outer.levelId).toBe("L2");
    expect(outer.categoryCode).toBe("20");
    expect(outer.foregroundSource).toBe("layer");
  });

  it("die Reihenfolge entscheidet: das ZWEITE Element diktiert nichts", () => {
    const red = square("a", 0, { background: "#ff0000" });
    const blue = square("b", 1, { background: "#0000ff" });
    // „blue" zuerst gewählt → Ergebnis blau.
    const out = unionDrawings([blue, red]).created[0];
    expect(out.background).toBe("#0000ff");
  });
});
