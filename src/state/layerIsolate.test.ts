import { describe, it, expect } from "vitest";
import type { LayerCategory } from "../model/types";
import { isolateKeepingParents, showAllLayers, visibilityOf, withAncestors } from "./layerIsolate";

const cat = (code: string, visible = true, children?: LayerCategory[]): LayerCategory => ({
  code, name: code, color: "#000", lw: 0.2, visible, locked: false, children,
});
const layers = [cat("20"), cat("05", true, [cat("100"), cat("101", true, [cat("1010")])])];

describe("Ebenen isolieren [192]", () => {
  it("nimmt Elternklassen mit", () => {
    expect([...withAncestors(layers, ["1010"])].sort()).toEqual(["05", "101", "1010"]);
  });
  it("isoliert, Eltern bleiben an", () => {
    expect(visibilityOf(isolateKeepingParents(layers, ["101"]))).toEqual({ "20": false, "05": true, "100": false, "101": true, "1010": false });
  });
  it("Alle einblenden stellt den gemerkten Zustand wieder her", () => {
    const before = [cat("20"), cat("05", false, [cat("100"), cat("101")])];
    const iso = isolateKeepingParents(before, ["20"]);
    expect(visibilityOf(showAllLayers(iso, visibilityOf(before)))).toEqual(visibilityOf(before));
  });
  it("ohne Gedächtnis (oder wirkungslos) wird alles eingeblendet", () => {
    const hidden = [cat("20", false), cat("05", false, [cat("100", false)])];
    expect(Object.values(visibilityOf(showAllLayers(hidden, null))).every(Boolean)).toBe(true);
    expect(Object.values(visibilityOf(showAllLayers(hidden, visibilityOf(hidden)))).every(Boolean)).toBe(true);
  });
});
