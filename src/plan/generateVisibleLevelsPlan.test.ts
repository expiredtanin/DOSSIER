/**
 * `generateVisibleLevelsPlan` — Überlagerung mehrerer sichtbarer Geschoss-/
 * Zeichnungs-Ebenen in EINEM Plan (Nutzer-Wunsch: "mehrere Geschosse
 * gleichzeitig einschaltbar", "wie bei den Ebenen" — aktive Ebene farbig,
 * andere je Darstellungsmodus gedimmt/gesperrt/versteckt).
 */

import { describe, it, expect } from "vitest";
import { generateVisibleLevelsPlan, inGreyedRange, materializeGreyed } from "./generatePlan";
import type { CategoryDisplayResolver } from "./generatePlan";
import type { DrawingLevel, Project, Wall } from "../model/types";

const visible = new Set(["20", "90"]);
const SHOW_ALL: CategoryDisplayResolver = () => ({ render: true, greyed: false, locked: false });

function wallOf(id: string, floorId: string, x: number): Wall {
  return {
    id,
    type: "wall",
    floorId,
    categoryCode: "20",
    start: { x, y: 0 },
    end: { x: x + 4, y: 0 },
    wallTypeId: "aw",
    height: 2.6,
  } as unknown as Wall;
}

function baseProject(levels: DrawingLevel[], walls: Wall[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.2 }] }],
    drawingLevels: levels,
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls,
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  } as unknown as Project;
}

function floor(id: string, name: string): DrawingLevel {
  return {
    id,
    name,
    kind: "floor",
    visible: true,
    locked: false,
    floorHeight: 2.6,
    cutHeight: 1.0,
    baseElevation: 0,
  };
}

describe("generateVisibleLevelsPlan", () => {
  it("überlagert eine zweite sichtbare Ebene zusätzlich zur aktiven", () => {
    const p = baseProject(
      [floor("eg", "EG"), floor("og", "OG")],
      [wallOf("w-eg", "eg", 0), wallOf("w-og", "og", 10)],
    );
    const levelDisplay: CategoryDisplayResolver = (id) => ({
      render: true,
      greyed: id !== "eg",
      locked: false,
    });
    const plan = generateVisibleLevelsPlan(p, "eg", visible, SHOW_ALL, "mittel", false, false, levelDisplay);
    const wallIds = plan.primitives.map((pr) => (pr as { wallId?: string }).wallId).filter(Boolean);
    expect(wallIds).toContain("w-eg");
    expect(wallIds).toContain("w-og");
  });

  it("gedimmte (nicht-aktive) Ebene: als greyedRanges markiert (ohne Klonen), materialisiert greyed=true", () => {
    const p = baseProject(
      [floor("eg", "EG"), floor("og", "OG")],
      [wallOf("w-eg", "eg", 0), wallOf("w-og", "og", 10)],
    );
    const levelDisplay: CategoryDisplayResolver = (id) => ({
      render: true,
      greyed: id !== "eg",
      locked: false,
    });
    const plan = generateVisibleLevelsPlan(p, "eg", visible, SHOW_ALL, "mittel", false, false, levelDisplay);
    const idx = (wallId: string) =>
      plan.primitives.findIndex((pr) => (pr as { wallId?: string }).wallId === wallId && pr.kind === "polygon");
    // Rohplan: Primitive unverändert, nur der OG-Bereich ist als gedimmt markiert.
    expect(plan.greyedRanges?.length).toBe(1);
    expect(inGreyedRange(plan.greyedRanges, idx("w-og"))).toBe(true);
    expect(inGreyedRange(plan.greyedRanges, idx("w-eg"))).toBe(false);
    expect((plan.primitives[idx("w-og")] as { greyed?: boolean }).greyed).toBeFalsy();
    // Materialisiert: gleiche Indizes, OG-Primitive tragen greyed=true, EG nicht.
    const m = materializeGreyed(plan, true);
    expect(m.primitives).toHaveLength(plan.primitives.length);
    expect((m.primitives[idx("w-og")] as { greyed?: boolean }).greyed).toBe(true);
    expect((m.primitives[idx("w-eg")] as { greyed?: boolean }).greyed).toBeFalsy();
    // Ohne Bereiche bleibt der Plan unverändert (gleiches Objekt).
    expect(materializeGreyed({ ...plan, greyedRanges: undefined }, true).primitives).toBe(plan.primitives);
    // Linien-Ausnahme für den GPU-Pfad.
    const noLines = materializeGreyed(plan, false);
    const lineIdx = plan.primitives.findIndex((pr, i) => pr.kind === "line" && inGreyedRange(plan.greyedRanges, i));
    if (lineIdx >= 0) expect(noLines.primitives[lineIdx]).toBe(plan.primitives[lineIdx]);
  });

  it("Modus 'active' (render=false für andere): zeigt NUR die aktive Ebene", () => {
    const p = baseProject(
      [floor("eg", "EG"), floor("og", "OG")],
      [wallOf("w-eg", "eg", 0), wallOf("w-og", "og", 10)],
    );
    const levelDisplay: CategoryDisplayResolver = (id) => ({
      render: id === "eg",
      greyed: false,
      locked: false,
    });
    const plan = generateVisibleLevelsPlan(p, "eg", visible, SHOW_ALL, "mittel", false, false, levelDisplay);
    const wallIds = plan.primitives.map((pr) => (pr as { wallId?: string }).wallId).filter(Boolean);
    expect(wallIds).toContain("w-eg");
    expect(wallIds).not.toContain("w-og");
  });

  it("dedupliziert projektglobale Zutaten (Schnittlinien) — nur einmal, nicht je Ebene", () => {
    const p = baseProject(
      [
        floor("eg", "EG"),
        floor("og", "OG"),
        {
          id: "s-a",
          name: "Schnitt A",
          kind: "section",
          visible: true,
          locked: false,
          linePoints: [{ x: 0, y: 2 }, { x: 6, y: 2 }],
          directionSign: 1,
        },
      ],
      [wallOf("w-eg", "eg", 0), wallOf("w-og", "og", 10)],
    );
    const plan = generateVisibleLevelsPlan(p, "eg", visible, SHOW_ALL, "mittel", false, false, SHOW_ALL);
    const bands = plan.primitives.filter(
      (pr) => pr.kind === "polygon" && (pr as { sectionLineId?: string }).sectionLineId === "s-a",
    );
    expect(bands.length).toBe(1);
  });

  it("Regression: sehr viele Primitive (grossflächiger Import) lösen keinen Stack-Overflow aus", () => {
    // Nutzer-Report 2026-10-08: Import eines Kataster-DXF einer ganzen Stadt
    // (~400 MB, hunderttausende Elemente) liess die App mit "Maximum call
    // stack size exceeded" abstürzen — Ursache war `primitives.push(...grosses
    // Array)`, das V8s Argumentzahl-Grenze für Funktionsaufrufe sprengt (anders
    // als Array-LITERAL-Spread `[...a,...b]`, der KEIN Funktionsaufruf ist und
    // beliebig gross sein darf). Reproduziert hier mit genug Elementen, um die
    // Grenze (~65–130k, engine-abhängig) sicher zu überschreiten.
    const N = 200_000;
    const drawings2d: Project["drawings2d"] = [];
    for (let i = 0; i < N; i++) {
      drawings2d.push({
        id: `d${i}`,
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: { shape: "line", a: { x: 0, y: i * 0.001 }, b: { x: 1, y: i * 0.001 } },
      } as unknown as Project["drawings2d"][number]);
    }
    const p = { ...baseProject([floor("eg", "EG")], []), drawings2d };
    const visibleWide = new Set(["20", "90", "2d-line"]);
    expect(() =>
      generateVisibleLevelsPlan(p, "eg", visibleWide, SHOW_ALL, "mittel", false, false, SHOW_ALL),
    ).not.toThrow();
  });

  it("Schnitt/Ansicht-Ebenen bleiben Einzel-Pane (kein Stapeln über kind-Grenze)", () => {
    const p = baseProject(
      [
        floor("eg", "EG"),
        {
          id: "s-a",
          name: "Schnitt A",
          kind: "section",
          visible: true,
          locked: false,
          linePoints: [{ x: 0, y: 2 }, { x: 6, y: 2 }],
          directionSign: 1,
        },
      ],
      [wallOf("w-eg", "eg", 0)],
    );
    // Aktive Ebene ist der Schnitt selbst — Geschoss "eg" darf NICHT als
    // Referenz-Wand-Poché mit hineingemischt werden (andere Projektionsachse).
    const plan = generateVisibleLevelsPlan(p, "s-a", visible, SHOW_ALL, "mittel", false, false, SHOW_ALL);
    const wallIds = plan.primitives.map((pr) => (pr as { wallId?: string }).wallId).filter(Boolean);
    expect(wallIds).not.toContain("w-eg");
  });
});
