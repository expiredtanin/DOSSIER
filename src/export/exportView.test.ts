// [271][272] Ansicht eines Exports: Umbaufilter und Variantenkombination der aktiven Ebene gelten für IFC, OBJ/STL/glTF,
// STEP-Spezifikationen und die Cycles-Szene; ohne Ansicht Hauptvarianten und alles (wie bisher).
import { describe, expect, it } from "vitest";
import "../engine/fileioWasm.setup";
import { buildUmbauSampleProject } from "../model/sampleProjectUmbau";
import { buildVariantenSampleProject } from "../model/sampleProjectVarianten";
import { exportIfcSpf } from "./exportIfc";
import { exportObj } from "./exportMesh";
import { projectSolidSpecs } from "./exportStep";
import { cyclesSceneInfo } from "./cyclesRender";
import { exportViewFields, exportViewLabels, exportViewText, hasExportView, levelExportView } from "./exportView";
import type { Project } from "../model/types";

const count = (text: string, word: string): number => text.split(word).length - 1;

/** Das Projekt mit Umbaufilter an der Ebene „eg“. */
function withFilter(p: Project, filter: string, phase?: string): Project {
  return { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === "eg" ? { ...l, renovationFilter: filter, ...(phase ? { renovationPhase: phase } : {}) } : l)) };
}

describe("Ansicht der Ebene", () => {
  it("liest Umbaufilter, Etappe und Kombination der Ebene", () => {
    const u = withFilter(buildUmbauSampleProject(), "endzustand", "etappe-1");
    expect(levelExportView(u, "eg")).toEqual({ renovation: "endzustand", renovationPhase: "etappe-1" });
    expect(levelExportView(u, "gibt-es-nicht")).toEqual({});
    expect(levelExportView(u, null)).toEqual({});

    const v = buildVariantenSampleProject();
    const lv = { ...v, drawingLevels: v.drawingLevels.map((l) => (l.id === "eg" ? { ...l, designOptionCombination: "studie-2" } : l)) };
    // Benannte Kombination wird zur vollständigen Wahl aufgelöst.
    expect(levelExportView(lv, "eg").designOptions).toEqual({ dachform: "b", fassade: "b" });
    expect(hasExportView(levelExportView(lv, "eg"))).toBe(true);
    expect(hasExportView(levelExportView(v, "eg"))).toBe(false);
  });

  it("Text für den Kern: leer ohne Wirkung, sonst JSON; Beschriftung", () => {
    expect(exportViewText(undefined)).toBe("");
    expect(exportViewText({})).toBe("");
    expect(exportViewText({}, { iso: "2026-01-01T00:00:00" })).toBe('{"iso":"2026-01-01T00:00:00"}');
    expect(JSON.parse(exportViewText({ renovation: "endzustand", renovationPhase: "e1", designOptions: { a: "b" } }, { iso: "x" }))).toEqual({
      iso: "x",
      renovation: "endzustand",
      renovationPhase: "e1",
      designOptions: { a: "b" },
    });
    expect(exportViewFields(undefined)).toEqual({});
    expect(exportViewFields({ renovation: "bestand" })).toEqual({ renovation: "bestand" });

    const v = buildVariantenSampleProject();
    const labels = exportViewLabels(v, { designOptions: { dachform: "b", fassade: "b" } }, (id) => id);
    expect(labels.combination).toBe("Studie 2 Satteldach/Bandfenster");
    expect(labels.renovation).toBeNull();
    const u = buildUmbauSampleProject();
    const first = u.renovation?.phases?.[0];
    expect(exportViewLabels(u, { renovation: "endzustand", renovationPhase: first?.id }, () => "Endzustand").renovation).toBe(`Endzustand (${first?.name})`);
  });
});

describe("Exporte folgen der Ansicht", () => {
  it("IFC: Endzustand ohne Abbruch, andere Kombination andere Bauteile", () => {
    const u = buildUmbauSampleProject();
    const ganz = exportIfcSpf(u);
    const endzustand = exportIfcSpf(u, { view: { renovation: "endzustand" } });
    expect(count(endzustand, "IFCWALL(")).toBeLessThan(count(ganz, "IFCWALL("));
    // Ohne Ansicht wie bisher (Hauptvarianten, kein Filter).
    expect(exportIfcSpf(u, { view: {} }).length).toBe(ganz.length);

    const v = buildVariantenSampleProject();
    const a = exportIfcSpf(v);
    const b = exportIfcSpf(v, { view: { designOptions: { dachform: "b", fassade: "b" } } });
    expect(count(a, "IFCROOF(")).not.toBe(count(b, "IFCROOF(") + 1000); // beide lesbar
    expect(a).not.toBe(b);
    expect(count(b, "IFCWINDOW(")).toBeGreaterThan(0);
  });

  it("OBJ und STEP-Körper: gleiche Ansicht, gleiche Auswahl", () => {
    const u = buildUmbauSampleProject();
    const objs = (view?: Parameters<typeof exportObj>[1]) => count(exportObj(u, view), "\no ");
    expect(objs({ view: { renovation: "endzustand" } })).toBeLessThan(objs());
    const specs = projectSolidSpecs(u).length;
    expect(projectSolidSpecs(u, { renovation: "endzustand" }).length).toBeLessThan(specs);
  });

  it("Cycles-Szene: ohne Ausgeblendetes, Kombination, Umbau-Farben nur auf Wunsch", () => {
    const u = buildUmbauSampleProject();
    const base = { width: 64, height: 36, samples: 1, context: false };
    const alle = cyclesSceneInfo(u, base);
    const end = cyclesSceneInfo(u, { ...base, ...exportViewFields({ renovation: "endzustand" }) });
    expect(end.triangles).toBeLessThan(alle.triangles);

    const plan = { ...base, renovation: "umbauplan" };
    expect(cyclesSceneInfo(u, plan).xml).not.toContain("Umbau-");
    const farbig = cyclesSceneInfo(u, { ...plan, renovationColors: true });
    expect(farbig.xml).toContain("Umbau-e8c35a");
    expect(farbig.triangles).toBe(cyclesSceneInfo(u, plan).triangles);

    const v = buildVariantenSampleProject();
    const a = cyclesSceneInfo(v, base);
    const b = cyclesSceneInfo(v, { ...base, designOptions: { dachform: "b", fassade: "b" } });
    expect(b.triangles).not.toBe(a.triangles);
  });
});
