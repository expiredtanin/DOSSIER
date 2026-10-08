/**
 * `viewForCamera` — Ziel-Ausschnitt für eine gegebene Modell-Bildmitte +
 * einen gegebenen Zoom (px/m). Gegenstück zu `viewForScale` (hält die
 * BISHERIGE Mitte, setzt einen neuen Massstab); hier wird eine NEUE Mitte
 * bei einem gegebenen Zoom gesetzt — Grundlage für „gespeicherter Ausschnitt
 * merkt sich auch WOHIN man schaut" (`ViewSnapshot.cameraCenter`).
 */

import { describe, it, expect } from "vitest";
import { viewForCamera, meetScale, toScreen, PX_PER_M } from "./geometry";

/** Mock-SVG-Element: nur `getBoundingClientRect` wird von `viewForCamera` gelesen. */
function fakeSvg(width: number, height: number): SVGSVGElement {
  return {
    getBoundingClientRect: () =>
      ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect,
  } as unknown as SVGSVGElement;
}

describe("viewForCamera", () => {
  it("liefert null ohne Element (SVG noch nicht gemountet)", () => {
    expect(viewForCamera({ x: 0, y: 0 }, 50, null)).toBeNull();
  });

  it("liefert null bei pxPerMeter <= 0", () => {
    expect(viewForCamera({ x: 0, y: 0 }, 0, fakeSvg(800, 600))).toBeNull();
    expect(viewForCamera({ x: 0, y: 0 }, -5, fakeSvg(800, 600))).toBeNull();
  });

  it("liefert null bei einem Element ohne Ausdehnung (width/height = 0)", () => {
    expect(viewForCamera({ x: 0, y: 0 }, 50, fakeSvg(0, 0))).toBeNull();
  });

  it("zentriert die viewBox exakt auf toScreen(centerModel)", () => {
    const el = fakeSvg(800, 600);
    const center = { x: 5, y: 3 };
    const vb = viewForCamera(center, 50, el)!;
    const s = toScreen(center);
    expect(vb.x + vb.w / 2).toBeCloseTo(s.x, 6);
    expect(vb.y + vb.h / 2).toBeCloseTo(s.y, 6);
  });

  it("reproduziert exakt den angeforderten Zoom (Roundtrip über meetScale)", () => {
    const el = fakeSvg(1024, 768);
    const vb = viewForCamera({ x: 0, y: 0 }, 120, el)!;
    const scale = meetScale(vb, el)!;
    expect(scale * PX_PER_M).toBeCloseTo(120, 6);
  });

  it("passt die viewBox-Seitenverhältnisse dem Canvas an (kein Letterbox)", () => {
    const el = fakeSvg(1000, 500); // 2:1
    const vb = viewForCamera({ x: 0, y: 0 }, 90, el)!;
    expect(vb.w / vb.h).toBeCloseTo(2, 6);
  });
});
