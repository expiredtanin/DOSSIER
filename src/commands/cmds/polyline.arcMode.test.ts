/**
 * Bogen-Modus der Polylinie: gerade und gekrümmte Segmente in EINEM Element.
 * Zwei Varianten — DREI-PUNKT (Default: Durchgangspunkt + Endpunkt, Grösse
 * hängt nur an diesen drei Punkten) und TANGENTIAL (Unteroption: schliesst
 * weich an den Vorgänger an, Krümmung folgt daraus zwangsläufig).
 */

import { describe, expect, it } from "vitest";
import { polylineCommand } from "./polyline";
import { sampleProject } from "../../model/sampleProject";
import { bulgeArc } from "../../geometry/bulge";
import type { CommandContext, CommandState, Project, Vec2 } from "../types";

const ctx = {
  level: sampleProject.drawingLevels[0],
  defaultCategoryCode: sampleProject.layers[0].code,
} as CommandContext;

/** Spielt eine Eingabefolge ab und liefert das committete Projekt. */
function run(inputs: ({ pt: Vec2 } | { opt: string } | "confirm")[]): Project {
  let state: CommandState = polylineCommand.init();
  let project: Project = sampleProject;
  for (const step of inputs) {
    const [next, res] =
      step === "confirm"
        ? polylineCommand.onConfirm(state, ctx)
        : "pt" in step
          ? polylineCommand.onInput(state, { kind: "point", point: step.pt }, ctx)
          : polylineCommand.onInput(state, { kind: "option", id: step.opt }, ctx);
    state = next;
    if (res.commit) project = res.commit(project);
  }
  return project;
}

/** Die zuletzt angehängte Polylinie. */
function lastPolyline(p: Project) {
  const d = p.drawings2d[p.drawings2d.length - 1];
  if (d.geom.shape !== "polyline") throw new Error("keine Polylinie");
  return d.geom;
}

describe("Polylinie — gerade (unverändert)", () => {
  it("ohne Bogen-Modus bleibt alles gerade und OHNE bulge-Feld (Format unverändert)", () => {
    const g = lastPolyline(
      run([{ pt: { x: 0, y: 0 } }, { pt: { x: 4, y: 0 } }, { pt: { x: 4, y: 3 } }, "confirm"]),
    );
    expect(g.pts.length).toBe(3);
    expect(g.bulge).toBeUndefined();
  });
});

describe("Polylinie — Drei-Punkt-Bogen (Default)", () => {
  it("Durchgangspunkt + Endpunkt ergeben EIN Bogen-Segment", () => {
    const g = lastPolyline(
      run([
        { pt: { x: 0, y: 0 } },
        { opt: "arc" },
        { pt: { x: 2, y: 2 } }, // Durchgangspunkt
        { pt: { x: 4, y: 0 } }, // Endpunkt
        "confirm",
      ]),
    );
    // Der Durchgangspunkt ist KEIN Stützpunkt — nur Start und Ende.
    expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
    // Halbkreis über der Sehne → |bulge| = 1.
    expect(Math.abs(g.bulge![0])).toBeCloseTo(1, 9);
  });

  it("der Bogen läuft tatsächlich durch den gesetzten Durchgangspunkt", () => {
    const g = lastPolyline(
      run([
        { pt: { x: 0, y: 0 } },
        { opt: "arc" },
        { pt: { x: 3, y: 1 } },
        { pt: { x: 5, y: -2 } },
        "confirm",
      ]),
    );
    const arc = bulgeArc(g.pts[0], g.pts[1], g.bulge![0])!;
    expect(Math.hypot(3 - arc.center.x, 1 - arc.center.y)).toBeCloseTo(arc.r, 9);
  });

  it("die Grösse hängt NUR am eigenen Segment — nicht am Vorgänger (Nutzer-Anforderung)", () => {
    // Derselbe Bogen (gleiche drei Punkte relativ zueinander), einmal nach
    // einem langen und einmal nach einem kurzen Vorgänger-Segment: identisch.
    const withLong = lastPolyline(
      run([
        { pt: { x: 0, y: 0 } },
        { pt: { x: 10, y: 0 } },
        { opt: "arc" },
        { pt: { x: 12, y: 2 } },
        { pt: { x: 14, y: 0 } },
        "confirm",
      ]),
    );
    const withShort = lastPolyline(
      run([
        { pt: { x: 9, y: 0 } },
        { pt: { x: 10, y: 0 } },
        { opt: "arc" },
        { pt: { x: 12, y: 2 } },
        { pt: { x: 14, y: 0 } },
        "confirm",
      ]),
    );
    expect(withShort.bulge![1]).toBeCloseTo(withLong.bulge![1], 12);
  });

  it("Modus pro Segment umschaltbar: gerade → Bogen → gerade in EINEM Element", () => {
    const g = lastPolyline(
      run([
        { pt: { x: 0, y: 0 } },
        { pt: { x: 4, y: 0 } },
        { opt: "arc" },
        { pt: { x: 6, y: 2 } }, // Durchgangspunkt
        { pt: { x: 8, y: 0 } }, // Endpunkt
        { opt: "arc" }, // zurück auf gerade
        { pt: { x: 8, y: 4 } },
        "confirm",
      ]),
    );
    expect(g.pts.length).toBe(4);
    expect(g.bulge![0]).toBe(0);
    expect(Math.abs(g.bulge![1])).toBeGreaterThan(1e-6);
    expect(g.bulge![2]).toBe(0);
  });
});

describe("Polylinie — tangentialer Bogen (Unteroption)", () => {
  it("schliesst tangential ans vorherige Segment an und endet im geklickten Punkt", () => {
    const g = lastPolyline(
      run([
        { pt: { x: 0, y: 0 } },
        { pt: { x: 4, y: 0 } },
        { opt: "arc" },
        { opt: "tangent" },
        { pt: { x: 6, y: 2 } },
        "confirm",
      ]),
    );
    expect(g.pts.length).toBe(3);
    expect(g.bulge![0]).toBe(0);

    // Waagrechter Start ⇒ Mittelpunkt senkrecht über/unter dem Startpunkt.
    const arc = bulgeArc(g.pts[1], g.pts[2], g.bulge![1])!;
    expect(arc.center.x).toBeCloseTo(4, 9);
    const end = {
      x: arc.center.x + arc.r * Math.cos(arc.a1),
      y: arc.center.y + arc.r * Math.sin(arc.a1),
    };
    expect(end.x).toBeCloseTo(6, 9);
    expect(end.y).toBeCloseTo(2, 9);
  });

  it("erstes Segment bleibt gerade — ohne Vorgänger gibt es keine Tangente", () => {
    const g = lastPolyline(
      run([
        { opt: "arc" },
        { opt: "tangent" },
        { pt: { x: 0, y: 0 } },
        { pt: { x: 4, y: 0 } },
        "confirm",
      ]),
    );
    expect(g.bulge).toBeUndefined();
  });

  it("aufeinanderfolgende tangentiale Bögen bleiben tangentenstetig", () => {
    const g = lastPolyline(
      run([
        { pt: { x: 0, y: 0 } },
        { pt: { x: 4, y: 0 } },
        { opt: "arc" },
        { opt: "tangent" },
        { pt: { x: 6, y: 2 } },
        // NICHT auf der Tangente (die zeigt in (6,2) senkrecht nach oben) —
        // sonst wäre der tangentenstetige „Bogen" korrekterweise eine Gerade.
        { pt: { x: 9, y: 5 } },
        "confirm",
      ]),
    );
    expect(Math.abs(g.bulge![2])).toBeGreaterThan(1e-6);
    const a1 = bulgeArc(g.pts[1], g.pts[2], g.bulge![1])!;
    const a2 = bulgeArc(g.pts[2], g.pts[3], g.bulge![2])!;
    // Tangentenstetig: beide Mittelpunkte liegen mit dem Berührpunkt auf EINER
    // Geraden (gemeinsame Normale).
    const p = g.pts[2];
    const v1 = { x: a1.center.x - p.x, y: a1.center.y - p.y };
    const v2 = { x: a2.center.x - p.x, y: a2.center.y - p.y };
    expect(Math.abs(v1.x * v2.y - v1.y * v2.x)).toBeLessThan(1e-6);
  });
});

describe("Polylinie — Ring schliessen im Bogen-Modus (REGRESSION: Schluss-Segment verlor seinen Bulge)", () => {
  // Alle drei Wege, einen Ring zu schliessen, müssen dem SCHLUSS-Segment
  // (letzter Punkt → Start) denselben tangentenstetigen Bogen geben wie jedes
  // andere Segment — vorher committeten alle drei eine gerade Kante, weil das
  // Bulge-Array einen Eintrag zu kurz war (`drawing2d.ts` liest den fehlenden
  // Index als `undefined` = gerade).
  const path: ({ pt: Vec2 } | { opt: string })[] = [
    { pt: { x: 0, y: 0 } },
    { pt: { x: 4, y: 0 } }, // Segment 0: gerade (kein Vorgänger für die Tangente)
    { opt: "arc" },
    { opt: "tangent" },
    { pt: { x: 4, y: 3 } }, // Segment 1: Bogen (Tangente knickt von (1,0) auf (0,1) ab)
  ];

  it('Option „close"', () => {
    const g = lastPolyline(run([...path, { opt: "close" }]));
    expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }]);
    expect(g.bulge).toHaveLength(3);
    expect(Math.abs(g.bulge![2])).toBeGreaterThan(1e-6);
  });

  it('Ring-Toggle („mode") + Enter', () => {
    const g = lastPolyline(run([...path, { opt: "mode" }, "confirm"]));
    expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }]);
    expect(g.bulge).toHaveLength(3);
    expect(Math.abs(g.bulge![2])).toBeGreaterThan(1e-6);
  });

  it("Klick nahe am Startpunkt", () => {
    // Knapp innerhalb der Fangdistanz (CLOSE_HIT), nicht exakt (0,0) —
    // realistischer Nutzer-Klick beim Schliessen per Auge.
    const g = lastPolyline(run([...path, { pt: { x: 0.001, y: 0.001 } }]));
    expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }]);
    expect(g.bulge).toHaveLength(3);
    expect(Math.abs(g.bulge![2])).toBeGreaterThan(1e-6);
  });
});
