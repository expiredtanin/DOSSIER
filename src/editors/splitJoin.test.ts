/**
 * Verbinden (Join, Kern `cmd_edit.rs::join_ops`) — Bogen-Segmente (bulge) müssen beim Verbinden
 * erhalten bleiben (nicht mehr stillschweigend zu Geraden entarten).
 */
import { describe, it, expect } from "vitest";
import { cutSegment, nearestEdgeIndex } from "./splitJoin";
import type { Drawing2D, Project } from "../model/types";
import { documentFor } from "../core/document";
import { applyOps } from "../core/ops";
import { sampleProject } from "../model/sampleProject";

/** Join der Elemente über den Kern: die neue Menge der Zeichnungen. */
function joinDrawings(srcs: Drawing2D[]): Drawing2D[] {
  const p = { ...sampleProject, drawings2d: srcs } as Project;
  return applyOps(p, documentFor(p).cmdOps({ cmd: "join", ids: srcs.map((d) => d.id), stamp: "t" })).drawings2d;
}

function poly(id: string, pts: { x: number; y: number }[], bulge?: number[]): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "polyline", pts, closed: false, ...(bulge ? { bulge } : {}) },
  };
}

describe("Join — bulge-Erhalt", () => {
  it("zwei offene Ketten (eine mit Bogen) werden verbunden, der Bogen bleibt erhalten", () => {
    const a = poly("a", [{ x: -1, y: 0 }, { x: 1, y: 0 }], [1]); // Halbkreis
    const b = poly("b", [{ x: 1, y: 0 }, { x: 3, y: 0 }]); // gerade, schliesst an a's Ende an
    const out = joinDrawings([a, b]);
    expect(out.length).toBe(1);
    const g = out[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape !== "polyline") return;
    expect(g.pts.length).toBe(3);
    expect(g.bulge?.[0]).toBeCloseTo(1, 6); // erste Kante (a's Bogen) unverändert
    expect(g.bulge?.[1] ?? 0).toBeCloseTo(0, 6); // zweite Kante (b, gerade)
  });

  it("wird eine bulge-Kette beim Verbinden umgedreht, kehrt sich das Vorzeichen um", () => {
    // b's Startpunkt trifft a's Startpunkt → b muss umgedreht werden, um anzuschliessen.
    const a = poly("a", [{ x: -1, y: 0 }, { x: 1, y: 0 }], [1]);
    const b = poly("b", [{ x: -1, y: 0 }, { x: -3, y: 0 }]);
    const out = joinDrawings([a, b]);
    expect(out.length).toBe(1);
    const g = out[0].geom;
    if (g.shape !== "polyline") return;
    // Kette läuft jetzt b(umgedreht) → a: [-3,0] → [-1,0] → [1,0].
    expect(g.pts[0]).toEqual({ x: -3, y: 0 });
    expect(g.pts[2]).toEqual({ x: 1, y: 0 });
    expect(g.bulge?.[0] ?? 0).toBeCloseTo(0, 6); // b's (gerade) Kante zuerst
    expect(g.bulge?.[1]).toBeCloseTo(1, 6); // a's Bogen unverändert (nicht umgedreht)
  });

  it("nicht-verbindbare Elemente (kein gemeinsamer Endpunkt) bleiben unverändert", () => {
    const a = poly("a", [{ x: 0, y: 0 }, { x: 1, y: 0 }], [0.5]);
    const b = poly("b", [{ x: 10, y: 10 }, { x: 11, y: 10 }]);
    const out = joinDrawings([a, b]);
    expect(out.length).toBe(2);
    // Neue IDs (inherit() vergibt immer frische IDs) — über den bulge-Wert
    // finden statt über die ursprüngliche ID.
    const withBulge = out.find((d) => d.geom.shape === "polyline" && d.geom.bulge);
    expect(withBulge).toBeDefined();
    if (withBulge?.geom.shape === "polyline") expect(withBulge.geom.bulge?.[0]).toBeCloseTo(0.5, 6);
  });
});

describe("cutSegment / nearestEdgeIndex — bulge-Erhalt", () => {
  it("Segment-Löschen an einer GERADEN Kante lässt den Bogen der Nachbarkante unangetastet (offen)", () => {
    // 4 Kanten: Bogen(0->1), gerade(1->2), gerade(2->3), gerade(3->4). Löscht Kante 1
    // (das längere, punktreichere Reststück rechts wird behalten, s. removeSegmentWithBulge).
    const src = poly(
      "a",
      [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }],
      [1, 0, 0, 0],
    );
    const out = cutSegment(src, 1);
    expect(out).not.toBeNull();
    if (!out || out.geom.shape !== "polyline") return;
    // Rechtes (längeres) Stück bleibt: [2,0] -> [3,0] -> [4,0], keine Kante mehr mit Bogen.
    expect(out.geom.pts).toEqual([{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }]);
    // fromPolyForm lässt das bulge-Feld ganz weg, wenn kein echter Bogen mehr übrig ist.
    expect(out.geom.bulge).toBeUndefined();
  });

  it("Segment-Löschen an der BOGEN-Kante selbst entfernt genau diesen Bogen", () => {
    const src = poly("a", [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], [1, 0]);
    const out = cutSegment(src, 0);
    expect(out).not.toBeNull();
    if (!out || out.geom.shape !== "polyline") return;
    expect(out.geom.pts).toEqual([{ x: 1, y: 0 }, { x: 2, y: 0 }]);
    expect(out.geom.bulge?.[0] ?? 0).toBeCloseTo(0, 6);
  });

  it("nearestEdgeIndex trifft die Bogen-Kante auch, wenn der Klickpunkt neben der Sehne liegt (auf dem Bogen)", () => {
    // Halbkreis von (-1,0) nach (1,0), bulge=1 -> Apex bei (0,1).
    const src = poly("a", [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }], [1, 0]);
    const idx = nearestEdgeIndex(src.geom, { x: 0, y: 0.95 });
    expect(idx).toBe(0); // Bogen-Kante, nicht die gerade Kante 1
  });
});
