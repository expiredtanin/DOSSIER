// [137] Alles Sichtbare anwählbar (Musterhaus komplex): Klick im Grundriss auf Baugrube, Gelände,
// Schatten und Baurechtslinien; Objekt-Info der Baugrube; Gelände neu glätten mit Undo.

import { beforeAll, describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { collectVisibleCodes } from "../model/layers";
import { generatePlan } from "../plan/generatePlan";
import { PlanPickIndex } from "../plan/planView/planPick";
import { planPrimAt } from "../plan/planLazy";
import { deriveSelection } from "./selectionInfo";
import { getState, setState } from "./appStore";
import type { Project, TerrainMesh } from "../model/types";

let p: Project;
let terrainId: string;
beforeAll(() => {
  p = buildComplexSampleProject();
  terrainId = p.context!.find((c) => c.type === "terrainMesh")!.id;
});

/** Pick-Ids (Feld `contextObjectId`) unter (x, y) im EG 1:500, oberste zuerst — wie `PlanView.contextIdsAt`. */
const idsAt = (proj: Project, pts: [number, number][]): string[][] => {
  const plan = generatePlan(proj, "eg", collectVisibleCodes(proj.layers), undefined, "mittel", false, false, true, 500);
  const ix = new PlanPickIndex(plan);
  const out = pts.map(([x, y]) => ix.polygonsAt({ x, y }, "contextObjectId").map((i) => (planPrimAt(plan, i) as { contextObjectId?: string }).contextObjectId!));
  ix.release();
  return out;
};
/** Erstes Kontext-Objekt (ohne Lage-Darstellung `@…`). */
const contextAt = (proj: Project, x: number, y: number): string | null => idsAt(proj, [[x, y]])[0].find((id) => !id.startsWith("@")) ?? null;

describe("[137] Grundriss: Kontext anwählen", () => {
  it("Baugrube (Sohle und Böschung) vor dem Gelände, daneben das Gelände", () => {
    expect(contextAt(p, 8, -0.5)).toBe("baugrube");
    // Südwest-Böschung: ausserhalb der Sohle (Arbeitsraum 0.8 m um −0.36), noch im Wirkbereich.
    expect(contextAt(p, -1.6, 4)).toBe("baugrube");
    expect(contextAt(p, 25, -10)).toBe(terrainId);
  });

  it("Objekt-Info der Baugrube: Kontext-Objekt der Art Baugrube", () => {
    const sel = deriveSelection(p, { contextObjects: ["baugrube"] });
    expect(sel?.kind).toBe("contextObject");
    expect(sel?.contextObject?.objType).toBe("excavation");
  });
});

describe("[137] Schatten und Baurecht anwählen", () => {
  it("Parzellengrenze → Baurecht, Schattenfläche → Sonnenstand (Pick-Ids im Plan)", () => {
    // Westgrenze der Parzelle von (−14, −12) nach (−15, 24): bei y = 6 liegt sie auf x = −14.5.
    const grid: [number, number][] = [];
    for (let y = 22; y >= -4; y -= 1) for (let x = -10; x <= 26; x += 1) grid.push([x, y]);
    const [parcel, far, ...rest] = idsAt(p, [[-14.5, 6], [-40, -40], ...grid]);
    expect(parcel).toContain("@siteRules");
    expect(far).toEqual([]);
    // Schatten (21. Juni, 10 Uhr): irgendwo neben dem Haus.
    expect(rest.some((ids) => ids.includes("@sunStudy"))).toBe(true);
    // Studie aus: keine Schatten-Ids mehr.
    const off = idsAt({ ...p, sunStudy: { ...p.sunStudy!, show: false } }, grid);
    expect(off.some((ids) => ids.includes("@sunStudy"))).toBe(false);
  });
});

describe("[137] Gelände neu glätten", () => {
  it("andere Stufe ersetzt das Netz (gleiche Id), Undo stellt es wieder her", () => {
    const terrain = () => getState().project.context!.find((c) => c.id === terrainId) as TerrainMesh;
    setState({ project: p, undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
    getState().clearHistory();
    const before = terrain();
    expect(before.smooth).toBe(2);
    expect(before.sourceId).toBe("hoehenlinien");
    expect(getState().regenerateTerrain(terrainId, 0)).toBe(true);
    const raw = terrain();
    expect(raw.smooth).toBe(0);
    expect(raw.indices.length).toBeLessThan(before.indices.length);
    expect(raw.contourInterval).toBe(before.contourInterval);
    getState().undo();
    expect(terrain().indices.length).toBe(before.indices.length);
    expect(terrain().smooth).toBe(2);
  });
});

describe("[137] Raster-Gelände (swissALTI3D) nachglätten", () => {
  it("additive Durchgänge, nur z ändert sich, Undo; TIN aus Höhenlinien wird abgelehnt", () => {
    const positions: number[] = [];
    for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) positions.push(i * 2, j * 2, i === 3 && j === 3 ? 10 : 0);
    const indices: number[] = [];
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 5; i++) {
        const a = j * 6 + i;
        indices.push(a, a + 1, a + 7, a, a + 7, a + 6);
      }
    const grid: TerrainMesh = { id: "alti", type: "terrainMesh", name: "swissALTI3D", positions, indices, smooth: 1 };
    setState({ project: { ...p, context: [grid] }, undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
    getState().clearHistory();
    const cur = () => getState().project.context!.find((c) => c.id === "alti") as TerrainMesh;
    expect(getState().resmoothTerrain("alti", 2)).toBe(true);
    expect(cur().smooth).toBe(3);
    const peak = cur().positions[(3 * 6 + 3) * 3 + 2];
    expect(peak).toBeLessThan(10);
    expect(peak).toBeGreaterThan(0);
    expect(cur().positions.filter((_, k) => k % 3 !== 2)).toEqual(positions.filter((_, k) => k % 3 !== 2));
    expect(cur().indices).toEqual(indices);
    getState().undo();
    expect(cur().positions).toEqual(positions);
    expect(cur().smooth).toBe(1);
    // Musterhaus-Gelände (TIN aus Höhenlinien) ist kein Raster.
    setState({ project: p });
    expect(getState().resmoothTerrain(terrainId, 1)).toBe(false);
  });
});
