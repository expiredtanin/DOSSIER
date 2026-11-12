import { describe, expect, it } from "vitest";
import { selectionHint } from "./useStatusBarInfo";
import { EMPTY_SELECTION, mergeSelection } from "./selection";

describe("[204] Status-Leiste: Auswahl-Hinweis zählt alle Bauteilarten", () => {
  it("nur Wände: wie bisher „Auswahl: 1 Wand“ / „n Wände“", () => {
    expect(selectionHint(EMPTY_SELECTION, 0)).toBe("Auswahl");
    expect(selectionHint(mergeSelection(EMPTY_SELECTION, { walls: ["w1"] }), 1)).toBe("Auswahl: 1 Wand");
    expect(selectionHint(mergeSelection(EMPTY_SELECTION, { walls: ["w1", "w2"] }), 2)).toBe("Auswahl: 2 Wände");
  });

  it("Tür, Treppe oder gemischte Auswahl: nicht mehr „Auswahl“ bzw. „1 Wand“", () => {
    expect(selectionHint(mergeSelection(EMPTY_SELECTION, { openings: ["d1"] }), 0)).toBe("Auswahl: 1 Element");
    // Eingefügte Wand samt ihren drei Öffnungen.
    expect(selectionHint(mergeSelection(EMPTY_SELECTION, { walls: ["w1"], openings: ["o1", "o2", "o3"] }), 1)).toBe("Auswahl: 4 Elemente");
    // Gruppen zählen nicht doppelt (die Mitglieder stehen in den übrigen Arten).
    expect(selectionHint(mergeSelection(EMPTY_SELECTION, { stairs: ["s1"], groups: ["g1"] }), 0)).toBe("Auswahl: 1 Element");
  });
});
