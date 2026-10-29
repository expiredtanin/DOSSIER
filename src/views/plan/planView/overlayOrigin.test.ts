import { describe, expect, it } from "vitest";
import { ORIGIN_REACH, localView, localViewBoxAttr, makeToLocal, pickOverlayOrigin } from "./overlayOrigin";

const PX = 90;
const E = 2_600_000;
const N = 1_200_000;
/** Ausschnitt `wM` Meter breit (Seitenverhältnis 3:2) um den Modellpunkt (cx, cy). */
const viewAt = (cx: number, cy: number, wM: number) => {
  const w = wM * PX;
  const h = (wM * PX * 2) / 3;
  return { x: cx * PX - w / 2, y: -cy * PX - h / 2, w, h };
};

describe("pickOverlayOrigin", () => {
  it("lokales Projekt: Ursprung bleibt (0, 0) — Overlay wie bisher", () => {
    expect(pickOverlayOrigin(viewAt(10, 5, 40), null)).toEqual({ x: 0, y: 0 });
    expect(pickOverlayOrigin(viewAt(10, 5, 1), null)).toEqual({ x: 0, y: 0 });
    expect(pickOverlayOrigin(viewAt(-300, 200, 600), null)).toEqual({ x: 0, y: 0 });
  });

  it("LV95: Ursprung nahe der Ausschnitt-Mitte, lokale Werte klein", () => {
    for (const wM of [500, 11, 1.5, 0.05]) {
      const v = viewAt(E + 37.25, N + 12.5, wM);
      const o = pickOverlayOrigin(v, null);
      const lv = localView(v, o);
      const size = Math.max(v.w, v.h);
      expect(Math.abs(lv.x) + lv.w).toBeLessThan(ORIGIN_REACH * size);
      expect(Math.abs(lv.y) + lv.h).toBeLessThan(ORIGIN_REACH * size);
      expect(Math.abs(o.x - (v.x + v.w / 2))).toBeLessThanOrEqual(size);
    }
  });

  it("Ursprung bleibt beim Schwenken/Zoomen in der Nähe (gleiches Objekt) und springt erst weit weg", () => {
    const o = pickOverlayOrigin(viewAt(E, N, 50), null);
    expect(pickOverlayOrigin(viewAt(E + 300, N - 200, 50), o)).toBe(o);
    expect(pickOverlayOrigin(viewAt(E + 10, N, 2), o)).toBe(o);
    const far = pickOverlayOrigin(viewAt(E + 10, N, 0.1), o);
    expect(far).not.toBe(o);
    // Zurück ins lokale Gebiet → wieder (0, 0).
    expect(pickOverlayOrigin(viewAt(3, 3, 30), far)).toEqual({ x: 0, y: 0 });
  });

  it("unsinniger Ausschnitt → bisheriger Ursprung", () => {
    const o = { x: 5, y: 6 };
    expect(pickOverlayOrigin({ x: NaN, y: 0, w: 1, h: 1 }, o)).toBe(o);
    expect(pickOverlayOrigin({ x: 0, y: 0, w: 0, h: 0 }, null)).toEqual({ x: 0, y: 0 });
  });
});

describe("lokale Abbildung", () => {
  it("toLocal = toScreen − Ursprung; viewBox-Attribut lokal", () => {
    const o = { x: 900, y: -450 };
    expect(makeToLocal(o)({ x: 20, y: 10 })).toEqual({ x: 20 * PX - 900, y: -10 * PX + 450 });
    expect(localViewBoxAttr({ x: 1000, y: -500, w: 30, h: 20 }, o)).toBe("100 -50 30 20");
  });

  it("f32-Fehler eines Griffs bei LV95 im 1-m-Ausschnitt: absolut px-weit daneben, lokal < 0.01 px", () => {
    const corner = { x: E + 68.123, y: N + 68.456 };
    const v = viewAt(corner.x + 0.2, corner.y - 0.1, 1);
    const pxPerUnit = 1500 / v.w; // 1500 px breite Fläche
    // Bildschirm-Abstand zum Ausschnitt-Rand, wie ihn der Browser in f32 rechnet, gegen f64.
    const err = (x: number, vx: number) => Math.abs(Math.fround(x) - Math.fround(vx) - (x - vx)) * pxPerUnit;
    expect(err(corner.x * PX, v.x)).toBeGreaterThan(1); // bisher: absolut
    const o = pickOverlayOrigin(v, null);
    const s = makeToLocal(o)(corner);
    const lv = localView(v, o);
    expect(err(s.x, lv.x)).toBeLessThan(0.01);
    expect(err(s.y, lv.y)).toBeLessThan(0.01);
  });
});
