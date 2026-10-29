/**
 * Verbinden (Join, Kern `cmd_edit.rs::join_ops`) — Bogen-Segmente (bulge) müssen beim Verbinden
 * erhalten bleiben (nicht mehr stillschweigend zu Geraden entarten).
 */
import { describe, it, expect } from "vitest";
import { cutSegmentOps, splitOps } from "./splitJoin";
import { getState } from "../state/appStore";
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

/** Segment löschen über den Kern: die geänderte Zeichnung (null = gelöscht). */
function cut(src: Drawing2D, at: { x: number; y: number }): Drawing2D | null {
  const p = { ...sampleProject, drawings2d: [src] } as Project;
  const next = applyOps(p, cutSegmentOps(p, src.id, at).ops).drawings2d;
  expect(next.length).toBeLessThanOrEqual(1);
  return next[0] ?? null;
}

describe("Segment löschen (Kern `cmd_split.rs`) — bulge-Erhalt", () => {
  it("Segment-Löschen an einer GERADEN Kante lässt den Bogen der Nachbarkante unangetastet (offen)", () => {
    // 4 Kanten: Bogen(0->1), gerade(1->2), gerade(2->3), gerade(3->4). Löscht Kante 1
    // (das längere, punktreichere Reststück rechts wird behalten, s. removeSegmentWithBulge).
    const src = poly(
      "a",
      [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }],
      [1, 0, 0, 0],
    );
    const out = cut(src, { x: 1.5, y: 0.01 });
    expect(out).not.toBeNull();
    if (!out || out.geom.shape !== "polyline") return;
    // Rechtes (längeres) Stück bleibt: [2,0] -> [3,0] -> [4,0], keine Kante mehr mit Bogen.
    expect(out.geom.pts).toEqual([{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }]);
    // Das bulge-Feld fällt ganz weg, wenn kein echter Bogen mehr übrig ist.
    expect(out.geom.bulge).toBeUndefined();
  });

  it("Segment-Löschen an der BOGEN-Kante selbst entfernt genau diesen Bogen", () => {
    // Halbkreis (-1,0)→(1,0) mit bulge 1 (Scheitel bei (0,-1)), dann gerade nach (1,2).
    const src = poly("a", [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }], [1, 0]);
    // Der Klickpunkt liegt am Bogen, aber näher an der geraden Kante als an der Sehne: getroffen wird
    // der Bogen (Abstand gegen die Kurve gemessen).
    const out = cut(src, { x: 0.7, y: -0.65 });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.geom).toEqual({ shape: "line", a: { x: 1, y: 0 }, b: { x: 1, y: 2 } });
  });
});

describe("Segment löschen ersetzt an Ort und Stelle", () => {
  it("das Element behält id und Attribute, die Liste bleibt gleich lang (Store)", () => {
    // Früher erzeugte cutSegment ein Element mit NEUER id als `replace` → angehängt, Original blieb.
    const d: Drawing2D = {
      id: "p", type: "drawing2d", levelId: "eg", categoryCode: "20", color: "#f00", opacity: 0.5,
      geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }], closed: false },
    };
    getState().loadProject({ ...sampleProject, drawings2d: [d] } as Project);
    getState().applyChange((p) => cutSegmentOps(p, "p", { x: 1.9, y: 1 }).ops);
    const after = getState().project.drawings2d;
    expect(after.length).toBe(1);
    expect(after[0]).toEqual({ ...d, geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: false } });
    getState().undo();
    expect(getState().project.drawings2d).toEqual([d]);
  });
});

describe("Split (Kern `cmd_split.rs`)", () => {
  it("teilt an den Schnittpunkten, Stücke an der Stelle des Originals, Auswahl = Stücke", () => {
    const a: Drawing2D = { id: "a", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } } };
    const b: Drawing2D = { id: "b", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 4, y: -1 }, b: { x: 4, y: 1 } } };
    const z: Drawing2D = { id: "z", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "circle", center: { x: 0, y: 0 }, r: 1 } };
    const p = { ...sampleProject, drawings2d: [a, b, z] } as Project;
    const { ops, selectIds } = splitOps(p, ["a", "z"]);
    const next = applyOps(p, ops).drawings2d;
    expect(next.map((d) => d.geom)).toEqual([
      { shape: "line", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
      { shape: "line", a: { x: 4, y: 0 }, b: { x: 10, y: 0 } },
      b.geom,
      z.geom,
    ]);
    expect(new Set(selectIds)).toEqual(new Set(["z", next[0].id, next[1].id]));
  });
});
