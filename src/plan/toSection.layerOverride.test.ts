/**
 * `splitWallLayers`/`splitSlabLayers` — Attribut-Override (By-Layer/By-Object)
 * bei MEHRSCHICHTIGEM Wand-/Deckentyp im Schnitt. Vorher wurde `owner.foreground`/
 * `hatchId`/`hatchSource`/`background`/`backgroundSource` hier komplett ignoriert
 * (nur der einschichtige Pfad über resolveWallSectionStyle/resolveCeilingSectionStyle
 * respektierte den Override) — Regressionsschutz für den Nachzieh-Fix
 * (2D-Vervollständigung, Fund D).
 */

import { describe, it, expect } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { getCeilingType, getWallType } from "../model/types";
import { splitWallLayers, splitSlabLayers, type SectionCutPolygon } from "./toSection";

const cp: SectionCutPolygon = {
  component: { kind: "wall", index: 0 },
  color: [0.5, 0.5, 0.5],
  pts: [
    [0, 0],
    [1, 0],
    [1, 2],
    [0, 2],
  ],
};

describe("splitWallLayers — Attribut-Override greift auf ALLE Schichten", () => {
  const wall = sampleProject.walls.find((w) => w.id === "W1")!; // wallTypeId "aw", 4 Schichten
  const wt = getWallType(sampleProject, wall);

  it("Testvoraussetzung: Wandtyp ist tatsächlich mehrschichtig", () => {
    expect(wt.layers.length).toBeGreaterThan(1);
  });

  it("ohne Override: Füllung bleibt SIA-neutral, nicht die Override-Testfarbe", () => {
    const bands = splitWallLayers(cp, sampleProject, wt, wall, { x: 1, y: 0 });
    expect(bands.length).toBe(wt.layers.length);
    for (const b of bands) {
      expect(typeof b.fill).toBe("string");
      expect(b.fill).not.toBe("#ff00ff");
    }
  });

  it("mit explizitem background-Override: JEDE Schicht bekommt die Override-Farbe", () => {
    const overridden = { ...wall, background: "#ff00ff" };
    const bands = splitWallLayers(cp, sampleProject, wt, overridden, { x: 1, y: 0 });
    expect(bands.length).toBe(wt.layers.length);
    for (const b of bands) expect(b.fill).toBe("#ff00ff");
  });
});

describe("splitSlabLayers — Attribut-Override greift auf ALLE Schichten", () => {
  const ceiling = (sampleProject.ceilings ?? []).find((c) => c.id === "C1")!; // ceilingTypeId "dg-massiv"
  const wt = getCeilingType(sampleProject, ceiling);

  it("Testvoraussetzung: Deckentyp ist tatsächlich mehrschichtig", () => {
    expect(wt.layers.length).toBeGreaterThan(1);
  });

  it("mit explizitem background-Override: JEDE Schicht bekommt die Override-Farbe", () => {
    const overridden = { ...ceiling, background: "#00ffff" };
    const bands = splitSlabLayers(cp, sampleProject, wt, overridden);
    expect(bands.length).toBe(wt.layers.length);
    for (const b of bands) expect(b.fill).toBe("#00ffff");
  });

  it("mit backgroundSource:'layer': category.color wird für ALLE Schichten übernommen", () => {
    const category = sampleProject.layers.find((l) => l.code === ceiling.categoryCode)!;
    const overridden = { ...ceiling, backgroundSource: "layer" as const };
    const bands = splitSlabLayers(cp, sampleProject, wt, overridden);
    expect(bands.length).toBe(wt.layers.length);
    for (const b of bands) expect(b.fill).toBe(category.color);
  });
});
