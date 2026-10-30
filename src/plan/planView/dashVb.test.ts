import { describe, it, expect } from "vitest";
import { dashArrayCss, fitDashToPeriod, hatchDashVb, lineDashVb } from "./dashVb";
import { PX_PER_M } from "./geometry";

describe("Strichmuster im Modell-Raum (SVG-Pfad)", () => {
  it("Linientyp: Papier-mm im Plot-Massstab, unabhängig vom Zoom = Druck-SVG", () => {
    // 6 mm bei 1:50 = 0.3 m Modell — wie sceneToPrintSvg (mm auf dem Blatt bei 1:50).
    const vb = lineDashVb([6, 2], 50);
    expect(vb[0] / PX_PER_M).toBeCloseTo(0.3, 9);
    // Unter non-scaling-stroke: Bildschirm-px = vb · meet (CSS-Variable), bei zwei Zoomstufen
    // dieselbe Modell-Länge.
    for (const meet of [0.5, 7]) {
      const px = parseFloat(dashArrayCss(vb, true)!.match(/\* ([\d.]+)px/)![1]) * meet;
      expect(px / meet / PX_PER_M).toBeCloseTo(0.3, 4);
    }
    expect(dashArrayCss(vb, false)).toBe("27 9");
  });

  it("Schraffur-Strich skaliert mit der Musterskala (wie hatch::hatch_dash)", () => {
    const a = hatchDashVb([1, 0.7], 0.35);
    expect(a[0]).toBeCloseTo((0.35 / 0.13), 9);
    expect(hatchDashVb([1], 0.35, true)[0]).toBeCloseTo(1 / 0.13, 9);
  });

  it("Kachel-Anpassung: ganze Perioden je Kachel", () => {
    const f = fitDashToPeriod([3, 2], 8);
    expect(f[0] + f[1]).toBeCloseTo(8 / 2, 9);
    expect(fitDashToPeriod([], 8)).toEqual([]);
  });
});
