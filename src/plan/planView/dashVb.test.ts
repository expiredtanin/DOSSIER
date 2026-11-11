import { describe, it, expect } from "vitest";
import { dashArrayCss, dashOffsetCss, fitDashToPeriod, hatchDashVb, lineDashOffsetVb, lineDashVb, ringDashVb } from "./dashVb";
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

  it("[153] Phase in viewBox-Einheiten = Kern-Phase in Papier-mm, Ring mit ganzen Wiederholungen", () => {
    // 10 mm lang bei 1:100 mit [2, 1]: Phase 0.5 mm (Kern `phase`).
    const k = (100 / 1000) * PX_PER_M;
    expect(lineDashOffsetVb([2, 1], 100, 10 * k)).toBeCloseTo(0.5 * k, 6);
    expect(lineDashOffsetVb([2, 1], 100, 0)).toBe(0);
    expect(dashOffsetCss(0, true)).toBeUndefined();
    expect(dashOffsetCss(3, false)).toBe("3");
    const ring = ringDashVb([2, 1], 100, 31.4 * k);
    expect((ring[0] + ring[1]) * 10).toBeCloseTo(31.4 * k, 6);
  });
});
