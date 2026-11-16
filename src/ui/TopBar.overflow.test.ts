// [263] Überlauf-Menü der Ansichtsleiste: welche Gruppen wandern bei zu wenig Platz ins „⋯“.
import { describe, expect, it } from "vitest";
import { overflowHidden } from "./TopBar";

const ids = ["views", "combos", "detail", "zoom", "sketch", "text"];
const widths = new Map([
  ["views", 140],
  ["combos", 410],
  ["detail", 290],
  ["zoom", 370],
  ["sketch", 70],
  ["text", 710],
]);

describe("overflowHidden", () => {
  it("nichts, wenn alles passt", () => {
    expect(overflowHidden(ids, widths, 2200)).toEqual([]);
  });
  it("zuerst Schrift, dann Skizze, dann Kombinationen, dann Detail", () => {
    expect(overflowHidden(ids, widths, 1478)).toEqual(["text"]);
    expect(overflowHidden(ids, widths, 1000)).toEqual(["combos", "sketch", "text"]);
    expect(overflowHidden(ids, widths, 800)).toEqual(["combos", "detail", "sketch", "text"]);
  });
  it("Massstab/Zoom bleibt am längsten", () => {
    expect(overflowHidden(ids, widths, 420)).toEqual(["views", "combos", "detail", "sketch", "text"]);
    expect(overflowHidden(ids, widths, 10)).toContain("zoom");
  });
});
