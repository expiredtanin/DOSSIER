// Kataster-Fund 29.10.: LWPOLYLINE mit Bögen (Bulges) kommen als Polylinie MIT `bulge` in die
// 2D-Zeichnung statt fein zerlegt — wenige Stützpunkte, Griffe an Ecken und Bogen-Mitten.

import { beforeAll, describe, expect, it } from "vitest";
import { parseDxf } from "./dxfParser";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { importInto, inspectDxf } from "./importView.testutil";
import { emptyProject } from "../model/sampleProject";
import { bulgePolylinePoints } from "../geometry/bulge";
import type { Vec2 } from "../model/types";

beforeAll(loadFileioForTests);

function dxf(...entities: string[][]): string {
  const lines = ["0", "SECTION", "2", "ENTITIES"];
  for (const pairs of entities) lines.push(...pairs);
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n");
}

/** Parzelle in LV95 (30 × 30 m), Unterkante leicht nach aussen gewölbt, Oberkante nach innen. */
const PARZELLE = [
  "0", "LWPOLYLINE", "8", "Liegenschaften", "90", "4", "70", "1",
  "10", "2600000", "20", "1200000", "42", "0.12",
  "10", "2600030", "20", "1200000",
  "10", "2600030", "20", "1200030", "42", "-0.25",
  "10", "2600000", "20", "1200030",
];

const toDrawings = (src: string) => importInto(emptyProject, parseDxf(src), { categoryMode: "active", activeCategoryCode: "01" }).drawings;

describe("DXF-Import: Polylinien mit Bögen", () => {
  it("bleiben eine Polylinie mit den DXF-Stützpunkten und Bulges", () => {
    const [d] = toDrawings(dxf(PARZELLE));
    expect(d.geom.shape).toBe("polyline");
    if (d.geom.shape !== "polyline") return;
    expect(d.geom.pts).toEqual([
      { x: 2600000, y: 1200000 },
      { x: 2600030, y: 1200000 },
      { x: 2600030, y: 1200030 },
      { x: 2600000, y: 1200030 },
    ]);
    // Vorzeichen umgekehrt: Modell-Bulge > 0 = Scheitel links der Sehne, DXF > 0 = Gegenuhrzeigersinn.
    expect(d.geom.bulge).toEqual([-0.12, 0, 0.25, 0]);
    expect(d.geom.closed).toBe(true);
  });

  it("gleiche Bogen-Seite wie die Tessellierung des Imports (Vorzeichen DXF ↔ Modell)", () => {
    const contour = inspectDxf(dxf(PARZELLE)).contours[0].contours[0];
    const [d] = toDrawings(dxf(PARZELLE));
    if (d.geom.shape !== "polyline") throw new Error("Polylinie erwartet");
    const ours = bulgePolylinePoints(d.geom.pts, d.geom.bulge, true);
    // Jeder Punkt der Import-Tessellierung liegt auf dem Linienzug der Modell-Polylinie (≤ 15 cm: Sehnenfehler der gröberen Modell-Tessellierung; die falsche Seite läge Meter daneben).
    const dist = (p: Vec2) => {
      let best = Infinity;
      for (let i = 0; i < ours.length; i++) {
        const a = ours[i];
        const b = ours[(i + 1) % ours.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
      }
      return best;
    };
    for (const p of contour.pts) expect(dist(p)).toBeLessThan(0.15);
    // Die Unterkante wölbt sich nach aussen (DXF: Bulge > 0 von links nach rechts = Gegenuhrzeigersinn).
    expect(Math.min(...ours.map((p) => p.y))).toBeLessThan(1_200_000 - 1);
  });

  it("offener Bogen aus zwei Punkten wird Polylinie (keine Linie)", () => {
    const [d] = toDrawings(
      dxf(["0", "LWPOLYLINE", "8", "0", "90", "2", "70", "0", "10", "0", "20", "0", "42", "1", "10", "2", "20", "0"]),
    );
    expect(d.geom).toEqual({ shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, bulge: [-1, 0] });
  });

  it("Schraffur mit Bogen-Rand: gefüllte Polylinie mit Bulges", () => {
    const [d] = toDrawings(
      dxf([
        "0", "HATCH", "8", "BB", "2", "SOLID", "70", "1", "91", "1", "92", "3", "72", "1", "73", "1", "93", "3",
        "10", "0", "20", "0", "42", "0.3", "10", "10", "20", "0", "42", "0", "10", "10", "20", "10", "42", "0", "97", "0",
      ]),
    );
    expect(d.fillColor).toBeDefined();
    if (d.geom.shape !== "polyline") throw new Error("Polylinie erwartet");
    expect(d.geom.pts).toHaveLength(3);
    expect(d.geom.bulge).toEqual([-0.3, 0, 0]);
  });

  it("ohne Bögen unverändert: Linienzug ohne `bulge`", () => {
    const [d] = toDrawings(
      dxf(["0", "LWPOLYLINE", "8", "0", "90", "3", "70", "0", "10", "0", "20", "0", "10", "1", "20", "0", "10", "1", "20", "1"]),
    );
    expect(d.geom).toEqual({ shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: false });
  });
});
