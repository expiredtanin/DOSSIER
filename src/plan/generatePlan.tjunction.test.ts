/**
 * Unit-Tests für den materialbewussten T-Stoss im 2D-Plan (generatePlan):
 * an einem T-Stoss zweier verputzter Mauerwerkswände (W9-artig: Innenputz/
 * Backstein-Kern/Innenputz) darf der Abzweig nicht mehr naiv über die volle
 * Dicke an der Durchgangswand-Fläche gekappt werden.
 *  • Der Backstein-Kern des Abzweigs sticht durch den Nah-Putz der Durchgangs-
 *    wand und stoppt an deren Kern-Nahfläche (kein Durchlaufen bis zur Achse,
 *    kein Überlappen) — "durchstechender Kern".
 *  • Die Innenputz-Schichten des Abzweigs enden an der Nahfläche. Ist der
 *    Nah-Putz der Durchgangswand materialgleich, füllt er die Flanken durchgehend
 *    → durchgehendes Putz-L OHNE Trennnaht (keine "layer-joint-l"-Linie).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Project, Wall } from "../model/types";

/** W9-artiger Wandtyp: Innenputz (0.015) / Backstein-Kern (0.12) / Innenputz (0.015). */
function tJunctionProject(): Project {
  const wall = (id: string, start: Wall["start"], end: Wall["end"]): Wall => ({
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "iw",
    height: 2.6,
  });
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [
      { id: "render-int", name: "Innenputz", color: "#efece6", hatchId: "none", joinPriority: 10 },
      { id: "brick", name: "Backstein", color: "#8c5544", hatchId: "none", joinPriority: 50 },
    ],
    wallTypes: [
      {
        id: "iw",
        name: "Innenwand",
        layers: [
          { componentId: "render-int", thickness: 0.015 },
          { componentId: "brick", thickness: 0.12 },
          { componentId: "render-int", thickness: 0.015 },
        ],
      },
    ],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [
      // Durchgangswand WA1/WA2 in zwei Hälften, Abzweig WB nach oben (5,0)→(5,3).
      wall("WA1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      wall("WA2", { x: 5, y: 0 }, { x: 10, y: 0 }),
      wall("WB", { x: 5, y: 0 }, { x: 5, y: 3 }),
    ],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const visible = new Set(["20"]);

describe("generatePlan — materialbewusster T-Stoss (Poché-Bänder)", () => {
  it("lässt den Backstein-Kern des Abzweigs ungekappt durchlaufen, während der Innenputz an der Nahfläche endet", () => {
    const plan = generatePlan(tJunctionProject(), "eg", visible, undefined, "mittel");
    // Die Schicht-Bänder der Wand WB: gefüllte Polygone ohne eigenen Umriss
    // (stroke:"none"), in Schicht-Reihenfolge gepusht (0=Putz,1=Backstein,2=Putz).
    const bands = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> =>
        p.kind === "polygon" && p.wallId === "WB" && p.stroke === "none",
    );
    expect(bands.length).toBe(3);
    const [render0, brick, render2] = bands;

    // clippedBand liefert [edgeStart(offA), edgeEnd(offA), edgeEnd(offB), edgeStart(offB)];
    // edgeStart liegt am Wandanfang (5,0) = der T-Stoss-Seite. Für die beiden
    // Innenputz-Bänder MUSS die Y-Koordinate dort exakt auf der Nahfläche
    // (0.075, halbe Wanddicke 0.15/2) liegen — unverändertes Trim-Verhalten.
    expect(render0.pts[0].y).toBeCloseTo(0.075, 6);
    expect(render0.pts[3].y).toBeCloseTo(0.075, 6);
    expect(render2.pts[0].y).toBeCloseTo(0.075, 6);
    expect(render2.pts[3].y).toBeCloseTo(0.075, 6);

    // Der Backstein-Kern verschmilzt, sticht aber nur durch den Nah-Putz der
    // Durchgangswand bis zur Nahfläche des Durchgangs-Kerns (y = 0.075 − 0.015 =
    // 0.06) — nicht bis zur Nahfläche (0.075) und NICHT bis zur Achse (0).
    expect(brick.pts[0].y).toBeCloseTo(0.06, 6);
    expect(brick.pts[3].y).toBeCloseTo(0.06, 6);
  });

  it("zeichnet KEINE L-Seitenlinie, wenn der getrimmte Putz materialgleich mit dem durchgehenden Nah-Putz der Durchgangswand ist (durchgehendes Putz-L ohne Naht)", () => {
    const plan = generatePlan(tJunctionProject(), "eg", visible, undefined, "mittel");
    const lLines = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "line" }> => p.kind === "line" && p.cls === "layer-joint-l",
    );
    // Alle drei Wände sind vom selben iw-Typ: der Innenputz des Abzweigs trifft
    // an der Flanke auf den materialgleichen Innenputz der Durchgangswand (der
    // spanCutout schneidet nur die Kernbreite aus, nicht die Putzflanken). Der
    // Putz läuft dort durchgehend ums Eck (L) — eine Trennnaht würde eine falsche
    // Materialgrenze suggerieren. Daher KEINE L-Linie.
    expect(lLines.length).toBe(0);
  });

  it("bricht die Nah-Putz-Schicht der Durchgangswand am Durchstoss auf (Phase 1c)", () => {
    // Am T-Knoten wird eine der kollinearen Hälften als Durchgangswand gewählt
    // und bekommt eine Aussparung; ihr Innenputz-Band auf der Durchstoss-Seite
    // (y∈[0.06,0.075]) wird über die Backstein-Breite [4.94,5.06] gekürzt (der
    // Cutout reicht bis ans Knoten-Ende x=5). Backstein-Kern + Aussenputz bleiben
    // voll (kein Überlappungsbereich).
    const plan = generatePlan(tJunctionProject(), "eg", visible, undefined, "mittel");
    // Die Durchgangs-Hälfte ist die mit spanCutouts — finde sie über ihre
    // gekürzten Bänder: sammle die Bänder beider Hälften.
    const bandsOf = (id: string) =>
      plan.primitives.filter(
        (p): p is Extract<typeof p, { kind: "polygon" }> =>
          p.kind === "polygon" && p.wallId === id && p.stroke === "none",
      );
    const wa1 = bandsOf("WA1");
    const wa2 = bandsOf("WA2");
    // Beide Hälften haben weiterhin drei Bänder (der Cutout reicht bis ans
    // Wandende, splittet also nicht in zwei, sondern kürzt nur).
    expect(wa1.length).toBe(3);
    expect(wa2.length).toBe(3);
    // Genau EINE Hälfte trägt ein gekürztes Nah-Putz-Band: das innere Putzband
    // (y-Nahfläche 0.075) endet nicht mehr am Knoten x=5, sondern bei 4.94 bzw.
    // (für die andere Orientierung) bei 5.06.
    // Nah-Putz-Band = Offsetzone y∈[0.06,0.075] (offA=0.06 → pts[0/1], offB=0.075
    // → pts[2/3]); dessen X-Kanten verraten die Kürzung.
    const isNearPlaster = (b: { pts: { y: number }[] }) => {
      const ys = b.pts.map((p) => p.y);
      return Math.abs(Math.min(...ys) - 0.06) < 1e-6 && Math.abs(Math.max(...ys) - 0.075) < 1e-6;
    };
    const nearPlasterEnds = [...wa1, ...wa2]
      .filter(isNearPlaster)
      .flatMap((b) => b.pts.map((p) => p.x));
    // Mindestens eine Kante liegt bei 4.94 oder 5.06 (Backstein-Breite ab Knoten).
    const shortened = nearPlasterEnds.some(
      (x) => Math.abs(x - 4.94) < 1e-6 || Math.abs(x - 5.06) < 1e-6,
    );
    expect(shortened).toBe(true);
  });
});

/** Mittelspannen-Variante: EINE Durchgangswand W, Abzweig WB trifft mittig. */
function midSpanProject(): Project {
  const base = tJunctionProject();
  const wall = (id: string, start: Wall["start"], end: Wall["end"]): Wall => ({
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "iw",
    height: 2.6,
  });
  base.walls = [
    wall("W", { x: 0, y: 0 }, { x: 10, y: 0 }),
    wall("WB", { x: 4, y: 3 }, { x: 4, y: 0 }),
  ];
  return base;
}

describe("generatePlan — Durchgangswand-Aussparung am Mittelspann-Stoss (Phase 1c)", () => {
  it("splittet das Innenputz-Band der Durchgangswand über dem Durchstoss in zwei Teil-Bänder", () => {
    const plan = generatePlan(midSpanProject(), "eg", visible, undefined, "mittel");
    const bands = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> =>
        p.kind === "polygon" && p.wallId === "W" && p.stroke === "none",
    );
    // Innenputz-Band (Nahfläche y=0.075) wird über [3.94,4.06] entfernt → ZWEI
    // Teil-Bänder statt einem. Backstein (2 Bänder? nein 1) + Aussenputz bleiben
    // je ein Band → insgesamt 4 Bänder (1 Aussenputz + 1 Backstein + 2 Innenputz).
    const innerPlaster = bands.filter((b) => {
      const ys = b.pts.map((p) => p.y);
      return Math.abs(Math.min(...ys) - 0.06) < 1e-6 && Math.abs(Math.max(...ys) - 0.075) < 1e-6;
    });
    expect(innerPlaster.length).toBe(2);
    // Das linke Teil-Band endet bei x=3.94, das rechte beginnt bei x=4.06.
    const xs = innerPlaster.flatMap((b) => b.pts.map((p) => p.x)).sort((a, b) => a - b);
    // Erwartete Kanten: 0, 3.94 (linkes Band) und 4.06, 10 (rechtes Band).
    expect(xs.some((x) => Math.abs(x - 3.94) < 1e-6)).toBe(true);
    expect(xs.some((x) => Math.abs(x - 4.06) < 1e-6)).toBe(true);
    // Insgesamt bleiben Backstein-Kern (y-Nahfläche 0.06) und Aussenputz (−0.06)
    // ganze Bänder → 4 Bänder gesamt.
    expect(bands.length).toBe(4);
  });

  it("unterbricht die Schichtfuge im Merge-Bereich (keine Trennlinie an der Verschmelzungsfläche)", () => {
    const plan = generatePlan(midSpanProject(), "eg", visible, undefined, "mittel");
    // Fugen der Durchgangswand W: layer-joint-Linien parallel zur x-Achse.
    const joints = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "line" }> =>
        p.kind === "line" && p.cls === "layer-joint",
    );
    // Die Fuge an der Rückgrat-Nahfläche y=0.06 (Merge-Kontakt) darf NICHT über
    // den Durchstoss [3.94,4.06] laufen: kein Fugen-Segment enthält einen Punkt
    // mit y≈0.06 und x im offenen Intervall (3.94, 4.06).
    for (const l of joints) {
      if (Math.abs(l.a.y - 0.06) < 1e-6 && Math.abs(l.b.y - 0.06) < 1e-6) {
        const lo = Math.min(l.a.x, l.b.x);
        const hi = Math.max(l.a.x, l.b.x);
        // Das Segment darf den Durchstoss nicht überspannen/betreten.
        expect(lo >= 4.06 - 1e-9 || hi <= 3.94 + 1e-9).toBe(true);
      }
    }
    // Und es MUSS Fugen-Segmente auf beiden Seiten geben (die Fuge existiert weiter,
    // nur unterbrochen).
    const at006 = joints.filter(
      (l) => Math.abs(l.a.y - 0.06) < 1e-6 && Math.abs(l.b.y - 0.06) < 1e-6,
    );
    expect(at006.some((l) => Math.max(l.a.x, l.b.x) <= 3.94 + 1e-6)).toBe(true);
    expect(at006.some((l) => Math.min(l.a.x, l.b.x) >= 4.06 - 1e-6)).toBe(true);
  });

  it("unterbricht die Nahflächen-Umrisslinie über dem Durchstoss", () => {
    const plan = generatePlan(midSpanProject(), "eg", visible, undefined, "mittel");
    // Die separat gezeichneten Nahkanten-Segmente (cls "wall-outline") liegen bei
    // y=0.075 und lassen [3.94,4.06] frei.
    const outline = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "line" }> =>
        p.kind === "line" && p.cls === "wall-outline",
    );
    expect(outline.length).toBe(2); // links + rechts vom Durchstoss
    for (const l of outline) {
      expect(Math.abs(l.a.y - 0.075) < 1e-6).toBe(true);
      expect(Math.abs(l.b.y - 0.075) < 1e-6).toBe(true);
    }
    // Ein Segment endet bei 3.94, das andere beginnt bei 4.06.
    const allX = outline.flatMap((l) => [l.a.x, l.b.x]);
    expect(allX.some((x) => Math.abs(x - 3.94) < 1e-6)).toBe(true);
    expect(allX.some((x) => Math.abs(x - 4.06) < 1e-6)).toBe(true);
  });
});
