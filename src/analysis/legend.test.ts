// [82] Grafische Legende: Einträge aus den Viewports (automatisch) oder der Handauswahl, Zeichnungselemente.

import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Layout, LayoutLegend, Project, ViewSnapshot } from "../model/types";
import { addLegend, legendBox, legendDrawings, legendEntries, legendKeysOfViewports, patchLegend, removeLegend } from "./legend";

function proj(): Project {
  const snap = {
    id: "s1",
    name: "EG",
    activeLevelId: "eg",
    layerVisibility: Object.fromEntries(sampleProject.layers.map((c) => [c.code, true])),
  } as unknown as ViewSnapshot;
  const layout: Layout = {
    id: "l1",
    name: "Blatt",
    paper: "a3",
    orientation: "landscape",
    viewports: [{ id: "v1", snapshotId: "s1", xMm: 10, yMm: 10, widthMm: 200, heightMm: 150 }],
  };
  return { ...sampleProject, viewSnapshots: [snap], layouts: [layout] };
}
const legend = (extra?: Partial<LayoutLegend>): LayoutLegend => ({ id: "g1", xMm: 20, yMm: 30, ...extra });

describe("legendKeysOfViewports", () => {
  it("findet die Materialien (Bauteile) der Wände im gezeigten Geschoss", () => {
    const p = proj();
    const keys = legendKeysOfViewports(p, p.layouts![0]);
    const wallType = p.wallTypes.find((w) => w.id === "aw")!;
    for (const l of wallType.layers) expect(keys).toContain(`component:${l.componentId}`);
    expect(keys.every((k) => /^(component|hatch|lineType|category):/.test(k))).toBe(true);
  });
  it("ohne Viewports nichts; ausgeblendete Kategorien zählen nicht", () => {
    const p = proj();
    expect(legendKeysOfViewports(p, { ...p.layouts![0], viewports: [] })).toEqual([]);
    const snap = { ...p.viewSnapshots![0], layerVisibility: {} } as ViewSnapshot;
    expect(legendKeysOfViewports({ ...p, viewSnapshots: [snap] }, p.layouts![0]).filter((k) => k.startsWith("component:"))).toEqual([]);
  });
});

describe("legendEntries", () => {
  it("Standard: nur Schraffuren/Materialien, mit Name und Schraffur-Id, ohne Doppelte", () => {
    const p = proj();
    const e = legendEntries(p, p.layouts![0], legend());
    expect(e.length).toBeGreaterThan(0);
    expect(e.every((x) => x.kind === "hatch")).toBe(true);
    expect(new Set(e.map((x) => x.key)).size).toBe(e.length);
    const comp = p.components.find((c) => e[0].key === `component:${c.id}`)!;
    expect(e[0]).toMatchObject({ label: comp.name, hatchId: comp.hatchId });
  });
  it("Handauswahl gewinnt, unbekannte Schlüssel entfallen, Kategorien tragen Code und Name", () => {
    const p = proj();
    const cat = p.layers[0];
    const e = legendEntries(p, p.layouts![0], legend({ kinds: ["hatch", "category"], manualKeys: [`category:${cat.code}`, "component:gibtsnicht", `hatch:${p.hatches[0].id}`] }));
    expect(e.map((x) => x.key)).toEqual([`category:${cat.code}`, `hatch:${p.hatches[0].id}`]);
    expect(e[0].label).toContain(cat.name);
    expect(e[1].label).toBe(p.hatches[0].name);
  });
  it("Linientypen aus den Zeichnungen des Geschosses", () => {
    const p = proj();
    const ls = p.lineStyles[0];
    const q: Project = {
      ...p,
      drawings2d: [{ id: "d1", type: "drawing2d", levelId: "eg", categoryCode: p.layers[0].code, geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, lineStyleId: ls.id }],
    };
    const e = legendEntries(q, q.layouts![0], legend({ kinds: ["lineType"] }));
    expect(e.map((x) => x.key)).toEqual([`lineType:${ls.id}`]);
  });
});

describe("legendDrawings", () => {
  it("erzeugt Titel, Rahmen, je Eintrag Muster + Name in Papier-Metern auf der Blatt-Ebene", () => {
    const p = proj();
    const lg = legend({ title: "Materialien" });
    const e = legendEntries(p, p.layouts![0], lg);
    const out = legendDrawings(p, lg, e, "lvl");
    expect(out.widthMm).toBeGreaterThan(20);
    expect(out.heightMm).toBeGreaterThan(5 * e.length);
    const texts = out.drawings.filter((d) => d.geom.shape === "text").map((d) => (d.geom as { text: string }).text);
    expect(texts).toContain("Materialien");
    for (const x of e) expect(texts).toContain(x.label);
    const swatches = out.drawings.filter((d) => d.hatchId !== undefined);
    expect(swatches).toHaveLength(e.length);
    expect(out.drawings.every((d) => d.levelId === "lvl")).toBe(true);
    // Position: x = 20 mm → 0.02 m, y = 30 mm → −0.03 m (Papier-y nach unten).
    const frame = out.drawings.find((d) => d.geom.shape === "rect")!;
    expect((frame.geom as { min: { x: number } }).min.x).toBeCloseTo(0.02, 9);
  });
});

describe("Legende-Liste am Layout", () => {
  it("hinzufügen, ändern, entfernen; Fläche folgt dem Inhalt", () => {
    const p = proj();
    let l = addLegend(p.layouts![0], legend());
    expect(l.legends).toHaveLength(1);
    l = patchLegend(l, "g1", { xMm: 50, title: "Material" });
    expect(l.legends![0]).toMatchObject({ xMm: 50, yMm: 30, title: "Material" });
    const box = legendBox(p, l, l.legends![0]);
    expect(box.xMm).toBe(50);
    expect(box.widthMm).toBeGreaterThan(20);
    l = removeLegend(l, "g1");
    expect(l.legends).toBeUndefined();
  });
});
