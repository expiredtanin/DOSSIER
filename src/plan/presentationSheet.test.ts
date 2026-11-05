import { beforeEach, describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { getState } from "../state/appStore";
import { sheetSizeMm } from "../model/layoutModel";
import { PRESENTATION_TEMPLATE_ID, presentationDefaults, presentationSheetOps } from "./presentationSheet";
import type { Project } from "../model/types";

const LABELS = { sheetName: "Präsentationsplan", masterName: "Planrahmen", north: "N", northGroup: "Nordpfeil", scaleBarGroup: "Massstabsbalken" };
const st = () => getState();

function overlaps(a: { xMm: number; yMm: number; widthMm: number; heightMm: number }, b: typeof a): boolean {
  return a.xMm < b.xMm + b.widthMm && b.xMm < a.xMm + a.widthMm && a.yMm < b.yMm + b.heightMm && b.yMm < a.yMm + a.heightMm;
}

describe("[66] Präsentationsplan", () => {
  let project: Project;
  beforeEach(() => {
    st().loadProject(buildComplexSampleProject());
    st().clearHistory();
    project = st().project;
  });

  it("Vorschlag: alle Geschosse, Ansichten, ein Schnitt, A1 quer (Master)", () => {
    const d = presentationDefaults(project);
    expect(d.floors.length).toBeGreaterThanOrEqual(4);
    expect(d.elevations).toBe(true);
    expect(d.sectionId).not.toBeNull();
    expect([d.paper, d.orientation]).toEqual(["a1", "landscape"]);
    expect(d.sketch).toBe(false);
  });

  it("ein Undo-Schritt: Blatt mit je einem Viewport pro Ebene, alle auf dem Blatt, ohne Überlappung", () => {
    const o = presentationDefaults(project);
    const elevations = project.drawingLevels.filter((l) => l.kind === "elevation").length;
    const layoutsBefore = (project.layouts ?? []).length;
    const res = presentationSheetOps(project, o, LABELS, "t1");
    expect(res).not.toBeNull();
    const { ops, layoutId, plan } = res!;
    expect([50, 100, 200]).toContain(plan.scale);
    expect(plan.fits).toBe(true);
    st().applyChange(ops);
    expect(st().undoDepth).toBe(1);
    const p = st().project;
    const lay = p.layouts!.find((l) => l.id === layoutId)!;
    expect(lay.viewports.length).toBe(o.floors.length + elevations + 1);
    expect(lay.masterId).toBeTruthy();
    const size = sheetSizeMm(lay.paper, lay.orientation);
    for (const [i, v] of lay.viewports.entries()) {
      expect(v.xMm).toBeGreaterThanOrEqual(0);
      expect(v.yMm).toBeGreaterThanOrEqual(0);
      expect(v.xMm + v.widthMm).toBeLessThanOrEqual(size.w);
      expect(v.yMm + v.heightMm).toBeLessThanOrEqual(size.h);
      expect(v.scaleDenominator).toBe(plan.scale);
      for (const w of lay.viewports.slice(i + 1)) expect(overlaps(v, w)).toBe(false);
      const snap = p.viewSnapshots!.find((s) => s.id === v.snapshotId)!;
      expect(snap.templateId).toBe(PRESENTATION_TEMPLATE_ID);
      expect(snap.templateLinked).toBe(true);
    }
    // Titel je Viewport + Nordpfeil + Massstabsbalken (2 Beschriftungen) auf der Blatt-Ebene.
    const sheet = p.drawingLevels.find((l) => l.layoutId === layoutId)!;
    const onSheet = p.drawings2d.filter((d) => d.levelId === sheet.id);
    const texts = onSheet.filter((d) => d.geom.shape === "text");
    expect(texts.length).toBe(lay.viewports.length + 1 + 2);
    expect(onSheet.filter((d) => /-s\d$/.test(d.id) && d.geom.shape === "polyline").length).toBe(5);
    // [137] Nordpfeil und Massstabsbalken sind je eine Gruppe (Klick wählt, verschiebt und löscht sie als Ganzes).
    const groups = (p.groups ?? []).filter((g) => g.drawingIds.some((id) => onSheet.some((d) => d.id === id)));
    expect(groups.map((g) => g.drawingIds.length).sort()).toEqual([4, 7]);
    expect(groups.every((g) => g.name && g.drawingIds.every((id) => onSheet.some((d) => d.id === id)))).toBe(true);
    // Titel und Balken liegen auf dem Blatt.
    for (const d of onSheet) if (d.geom.shape === "text") {
      expect(d.geom.at.x * 1000).toBeGreaterThan(0);
      expect(d.geom.at.x * 1000).toBeLessThan(size.w);
      expect(-d.geom.at.y * 1000).toBeLessThan(size.h);
    }
    // Skizze aus: Ebenen unverändert; Ansichten mit Schatten (Vorlage).
    expect(p.drawingLevels.some((l) => l.sketch)).toBe(false);
    expect(p.drawingLevels.filter((l) => l.kind === "elevation").every((l) => l.shadows)).toBe(true);
    st().undo();
    expect((st().project.layouts ?? []).length).toBe(layoutsBefore);
    expect(st().project.viewSnapshots?.some((s) => s.id.startsWith("vs-pres-"))).toBe(false);
  });

  it("gewählte Geschosse, ohne Ansichten/Schnitt, Skizze an, A3: kleinerer Massstab", () => {
    const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId).slice(0, 2).map((l) => l.id);
    const res = presentationSheetOps(project, { floors, elevations: false, sectionId: null, paper: "a3", orientation: "landscape", sketch: true }, LABELS, "t2")!;
    expect(res.plan.items.map((i) => i.levelId)).toEqual(floors);
    expect(res.plan.scale).toBeGreaterThanOrEqual(100);
    st().applyChange(res.ops);
    const p = st().project;
    expect(p.layouts!.find((l) => l.id === res.layoutId)!.viewports.length).toBe(2);
    expect(floors.every((id) => p.drawingLevels.find((l) => l.id === id)!.sketch)).toBe(true);
  });

  it("nichts gewählt ⇒ null, Projekt unverändert", () => {
    expect(presentationSheetOps(project, { floors: [], elevations: false, sectionId: null, paper: "a1", orientation: "landscape", sketch: false }, LABELS, "t3")).toBeNull();
  });
});
