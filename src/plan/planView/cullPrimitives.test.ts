// Tests für `cullPrimitives.ts` — Viewport-Culling der PlanView-Primitive.
// Zwei Eigenschaften sind regressionskritisch (s. Kopfkommentar der Datei):
// (1) ein sichtbares Element darf NIE fälschlich wegfallen (konservative
// Bounding-Box, lieber zu grosszügig); (2) der URSPRÜNGLICHE Index bleibt
// erhalten (Auswahl/Hit-Testing und Hatch-Pattern-IDs indizieren direkt in
// `plan.primitives`).

import { describe, expect, it } from "vitest";
import type { Primitive } from "../generatePlan";
import {
  expandRegion,
  indexedInRegion,
  primitiveBoundsVb,
  primitivesInRegion,
  regionContains,
} from "./cullPrimitives";
import { PX_PER_M, toScreen, type ViewBox } from "./geometry";

function line(ax: number, ay: number, bx: number, by: number): Primitive {
  return {
    kind: "line",
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    cls: "c",
    weightMm: 0.1,
  } as Primitive;
}

function drawingText(x: number, y: number, text = "ABC"): Primitive {
  return {
    kind: "drawingText",
    at: { x, y },
    text,
    heightM: 0.25,
    angle: 0,
    color: "#000",
  } as Primitive;
}

describe("primitiveBoundsVb", () => {
  it("line: Bbox umschliesst beide Endpunkte (viewBox-Einheiten, Y gespiegelt)", () => {
    const b = primitiveBoundsVb(line(0, 0, 2, 3))!;
    const sa = toScreen({ x: 0, y: 0 });
    const sb = toScreen({ x: 2, y: 3 });
    expect(b.minX).toBeCloseTo(Math.min(sa.x, sb.x), 6);
    expect(b.maxX).toBeCloseTo(Math.max(sa.x, sb.x), 6);
    expect(b.minY).toBeCloseTo(Math.min(sa.y, sb.y), 6);
    expect(b.maxY).toBeCloseTo(Math.max(sa.y, sb.y), 6);
  });

  it("polygon: Bbox umschliesst alle Punkte", () => {
    const p: Primitive = {
      kind: "polygon",
      pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 2 }, { x: 0, y: 2 }],
      fill: "#fff",
      stroke: "#000",
      strokeWidthMm: 0.1,
      hatch: { pattern: "none", scale: 1, angle: 0, color: "#000", lineWeight: 0.1, dash: null } as any,
    } as Primitive;
    const b = primitiveBoundsVb(p)!;
    expect(b.maxX - b.minX).toBeCloseTo(5 * PX_PER_M, 3);
    expect(b.maxY - b.minY).toBeCloseTo(2 * PX_PER_M, 3);
  });

  it("leeres Polygon liefert null (degeneriert, wird nie gerendert)", () => {
    const p: Primitive = {
      kind: "polygon",
      pts: [],
      fill: "#fff",
      stroke: "#000",
      strokeWidthMm: 0.1,
      hatch: { pattern: "none", scale: 1, angle: 0, color: "#000", lineWeight: 0.1, dash: null } as any,
    } as Primitive;
    expect(primitiveBoundsVb(p)).toBeNull();
  });

  it("arc/drawingCircle: Bbox ist der volle Kreis um das Zentrum", () => {
    const p: Primitive = { kind: "drawingCircle", center: { x: 1, y: 1 }, r: 3, fill: "none", stroke: "#000", weightMm: 0.1 } as Primitive;
    const b = primitiveBoundsVb(p)!;
    const c = toScreen({ x: 1, y: 1 });
    expect(b.minX).toBeCloseTo(c.x - 3 * PX_PER_M, 3);
    expect(b.maxX).toBeCloseTo(c.x + 3 * PX_PER_M, 3);
  });

  it("drawingText: längerer Text ergibt eine grössere Bbox als kürzerer", () => {
    const short = primitiveBoundsVb(drawingText(0, 0, "A"))!;
    const long = primitiveBoundsVb(drawingText(0, 0, "A".repeat(50)))!;
    expect(long.maxX - long.minX).toBeGreaterThan(short.maxX - short.minX);
  });

  it("drawingText: Bbox ist um den Anker ZENTRIERT (rotationsunabhängig)", () => {
    const b = primitiveBoundsVb(drawingText(0, 0, "Hallo"))!;
    const c = toScreen({ x: 0, y: 0 });
    expect((b.minX + b.maxX) / 2).toBeCloseTo(c.x, 3);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(c.y, 3);
  });
});

describe("expandRegion / regionContains", () => {
  const view: ViewBox = { x: 0, y: 0, w: 100, h: 100 };

  it("expandRegion vergrössert nach allen vier Seiten um genau `margin`", () => {
    const r = expandRegion(view, 20);
    expect(r).toEqual({ minX: -20, minY: -20, maxX: 120, maxY: 120 });
  });

  it("regionContains: eine Region enthält die View, aus der sie gebaut wurde", () => {
    const r = expandRegion(view, 20);
    expect(regionContains(r, view)).toBe(true);
  });

  it("regionContains: false, sobald die View über den Rand hinausragt", () => {
    const r = expandRegion(view, 20);
    expect(regionContains(r, { x: -25, y: 0, w: 100, h: 100 })).toBe(false);
    expect(regionContains(r, { x: 0, y: 0, w: 141, h: 100 })).toBe(false);
  });
});

describe("primitivesInRegion", () => {
  it("behält NUR Primitive, deren Bbox die Region schneidet", () => {
    // Region deckt (viewBox-Einheiten) x∈[0,200] y∈[-200,0] ab → Modell
    // x∈[0, 200/PX_PER_M] y∈[0, 200/PX_PER_M] (Y gespiegelt, s. toScreen).
    const prims = [line(0, 0, 1, 1), line(1000, 1000, 1001, 1001), line(1.5, 1.5, 2, 1.8)];
    const region = expandRegion({ x: 0, y: -200, w: 200, h: 200 }, 0);
    const kept = primitivesInRegion(prims, region);
    expect(kept.map((k) => k.i)).toEqual([0, 2]);
  });

  it("behält den URSPRÜNGLICHEN Index auch nach dem Herausfiltern (kein Renummerieren)", () => {
    const prims = [line(1000, 1000, 1001, 1001), line(0, 0, 1, 1), line(1000, 1000, 1001, 1001)];
    const region = expandRegion({ x: 0, y: -200, w: 200, h: 200 }, 0);
    const kept = primitivesInRegion(prims, region);
    expect(kept).toHaveLength(1);
    expect(kept[0].i).toBe(1); // NICHT 0 — Index muss der im Original-Array bleiben.
    expect(kept[0].p).toBe(prims[1]);
  });

  it("leere Eingabe liefert leeres Ergebnis", () => {
    expect(primitivesInRegion([], expandRegion({ x: 0, y: 0, w: 10, h: 10 }, 0))).toEqual([]);
  });

  describe("LOD-Filter (minTextHeightVb) — Nutzer-Report 2026-10-09", () => {
    // Regression: der eingepasste Übersichts-Ausschnitt direkt nach einem
    // Kataster-Import deckt den GESAMTEN Umriss ab — rein positionell liegen
    // dann ALLE Text-Labels "im Bild". Ohne Grössen-Filter würde also genau
    // der Fall, der den Hänger ausgelöst hat, NICHT entschärft.
    const bigRegion = expandRegion({ x: -1_000_000, y: -1_000_000, w: 2_000_000, h: 2_000_000 }, 0);

    it("ohne minTextHeightVb (0, Default): auch winzige Texte bleiben drin", () => {
      const tiny: Primitive = {
        kind: "drawingText", at: { x: 0, y: 0 }, text: "x", heightM: 0.001, angle: 0, color: "#000",
      } as Primitive;
      expect(primitivesInRegion([tiny], bigRegion)).toHaveLength(1);
    });

    it("mit minTextHeightVb: ein winziges Label (weit unter der Schwelle) fällt weg", () => {
      const tiny: Primitive = {
        kind: "drawingText", at: { x: 0, y: 0 }, text: "x", heightM: 0.001, angle: 0, color: "#000",
      } as Primitive;
      expect(primitivesInRegion([tiny], bigRegion, 1000)).toHaveLength(0);
    });

    it("mit minTextHeightVb: ein grosses Label (über der Schwelle) bleibt drin", () => {
      const big: Primitive = {
        kind: "drawingText", at: { x: 0, y: 0 }, text: "x", heightM: 1000, angle: 0, color: "#000",
      } as Primitive;
      expect(primitivesInRegion([big], bigRegion, 1000)).toHaveLength(1);
    });

    it("Geometrie-Primitive (line/polygon) bleiben vom LOD-Filter UNBERÜHRT, egal wie klein", () => {
      const tinyLine = line(0, 0, 0.0001, 0.0001);
      expect(primitivesInRegion([tinyLine], bigRegion, 1_000_000)).toHaveLength(1);
    });

    it("Raum-Stempel (kind:\"text\") bleiben vom LOD-Filter UNBERÜHRT (selten, nicht die Masse)", () => {
      const stamp: Primitive = {
        kind: "text", at: { x: 0, y: 0 }, doc: { blocks: [] } as any, extraLines: [], basePt: 1, color: "#000",
      } as Primitive;
      expect(primitivesInRegion([stamp], bigRegion, 1_000_000)).toHaveLength(1);
    });

    it("realistisches Szenario: Kataster-Übersicht (grosser Umriss) filtert winzige Labels, Nahaufnahme nicht", () => {
      const label: Primitive = {
        kind: "drawingText", at: { x: 0, y: 0 }, text: "Parzelle 123", heightM: 0.25, angle: 0, color: "#000",
      } as Primitive;
      // Eingepasst auf einen 2000 m hohen Umriss (wie beim echten Luzern-Import).
      const overviewMinHeight = 2000 * PX_PER_M * 0.005;
      expect(primitivesInRegion([label], bigRegion, overviewMinHeight)).toHaveLength(0);
      // Herangezoomt auf 50 m.
      const zoomedMinHeight = 50 * PX_PER_M * 0.005;
      expect(primitivesInRegion([label], bigRegion, zoomedMinHeight)).toHaveLength(1);
    });
  });
});

describe('indexedInRegion: Text-Budget', () => {
  const txt = (h: number) => ({ kind: 'drawingText', heightM: h, at: { x: 0, y: 0 }, text: 'x', drawingId: 'd' }) as unknown as Primitive;
  const region = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };
  it('behält über dem Budget nur die grössten Texte', () => {
    const items = [1, 2, 3, 4, 5].map((h, i) => ({ p: txt(h), i }));
    const out = indexedInRegion(items, region, 0, 3);
    expect(out.map((o) => o.i)).toEqual([2, 3, 4]);
  });
  it('lässt alles durch, wenn das Budget reicht', () => {
    const items = [1, 2, 3].map((h, i) => ({ p: txt(h), i }));
    expect(indexedInRegion(items, region, 0, 10)).toHaveLength(3);
  });
});
