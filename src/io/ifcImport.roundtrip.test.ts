// [B4] Rundreise Export → Import für Träger, Geländer, Rampen und Dächer: Fachplaner-Austausch darf Bauteile nicht in Körper
// verwandeln. Anzahl je Bauteilart gleich; Träger (Achse, Breite, Höhe), Geländer (Achse, Höhe, Art) und Rampe (Gefälle,
// Umriss) stimmen; die Dachplatten kommen nicht zusätzlich zum Dach als Netz.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { exportIfcSpf } from "../export/exportIfc";
import { emptyProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";
import type { Project } from "../model/types";
import type { IfcElementsSummary } from "./ifcImport";
import { importIfcInto } from "./importView.testutil";

const near = (a: number, b: number, tol = 1e-5) => Math.abs(a - b) <= tol;

async function roundtrip(src: Project) {
  const spf = exportIfcSpf(src);
  const r = await importIfcInto({ ...emptyProject, drawingLevels: src.drawingLevels }, new TextEncoder().encode(spf), { elements: true });
  return { spf, p: r.project, summary: r.summary as IfcElementsSummary };
}
const count = (spf: string, cls: string) => (spf.match(new RegExp(`=${cls}\\(`, "g")) ?? []).length;
const len = (a: { start: { x: number; y: number }; end: { x: number; y: number } }) => Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y);
const mid = (a: { start: { x: number; y: number }; end: { x: number; y: number } }) => [(a.start.x + a.end.x) / 2, (a.start.y + a.end.y) / 2];

describe("[B4] IFC-Rundreise: Träger, Geländer, Rampen, Dächer", () => {
  it(":komplex: Träger kommen als Träger zurück, Dächer nicht doppelt", async () => {
    const src = buildComplexSampleProject();
    const { spf, p, summary } = await roundtrip(src);
    expect(src.beams!.length).toBeGreaterThan(0);
    expect(count(spf, "IFCBEAM")).toBe(src.beams!.length);
    expect(p.beams?.length).toBe(src.beams!.length);
    expect(p.extrudedSolids ?? []).toEqual([]);
    expect(summary.beams).toBe(src.beams!.length);
    for (const b of src.beams!) {
      const got = p.beams!.find((g) => g.floorId === b.floorId && near(len(g), len(b)) && near(mid(g)[0], mid(b)[0]) && near(mid(g)[1], mid(b)[1]))!;
      expect(got, b.id).toBeDefined();
      expect(near(got.width, b.width) && near(got.height, b.height), JSON.stringify(got)).toBe(true);
      expect(near(got.topOffset ?? 0, b.topOffset ?? 0, 1e-4), JSON.stringify([got.topOffset, b.topOffset])).toBe(true);
    }
    // Dach: Dachplatten (IfcSlab ROOF) kommen nicht zusätzlich zum Dach als Kontext-Netz.
    const roofSlabs = (spf.match(/=IFCSLAB\([^;]*\.ROOF\.\);/g) ?? []).length;
    expect(roofSlabs).toBeGreaterThan(0);
    const gids = (p.context ?? []).map((c) => (c as { ifcGlobalId?: string }).ifcGlobalId).filter(Boolean);
    expect(new Set(gids).size, "kein Bauteil doppelt als Netz").toBe(gids.length);
  });

  it(":komplex: alle Dächer kommen als Dach zurück (Form, Neigung, Umriss, Gauben)", async () => {
    const src = buildComplexSampleProject();
    const { spf, p, summary } = await roundtrip(src);
    expect(src.roofs!.length).toBe(4);
    expect((spf.match(/IFCPROPERTYSET\([^;]*Dossier_Roof/g) ?? []).length).toBe(src.roofs!.length);
    expect(p.roofs?.length).toBe(src.roofs!.length);
    expect(summary.roofs).toBe(src.roofs!.length);
    for (const r of src.roofs!) {
      const got = p.roofs!.find((g) => g.shape === r.shape && g.ridgeAxis === r.ridgeAxis && g.outline.length === r.outline.length && g.outline.every((q, i) => near(q.x, r.outline[i].x) && near(q.y, r.outline[i].y)))!;
      expect(got, r.id).toBeDefined();
      expect(near(got.pitchDeg, r.pitchDeg) && near(got.overhang, r.overhang) && near(got.thickness, r.thickness, 1e-4), JSON.stringify(got)).toBe(true);
      expect(got.overhangGable ?? null).toEqual(r.overhangGable ?? null);
      expect(got.outlineBulge ?? null).toEqual(r.outlineBulge ?? null);
      expect(got.parapetHeight ?? null).toEqual(r.parapetHeight ?? null);
      expect((got.dormers ?? []).map((d) => [d.kind, d.width])).toEqual((r.dormers ?? []).map((d) => [d.kind, d.width]));
      expect((got.dormers ?? []).every((d, i) => near(d.position.x, r.dormers![i].position.x) && near(d.position.y, r.dormers![i].position.y))).toBe(true);
      expect(near(got.baseElevation ?? 0, r.baseElevation ?? got.baseElevation ?? 0, 1e-4), `${r.id} ${got.baseElevation} ${r.baseElevation}`).toBe(true);
    }
  });

  it(":wettbewerb: Dach kommt als Dach zurück", async () => {
    const src = buildWettbewerbSampleProject();
    const { p } = await roundtrip(src);
    expect(src.roofs!.length).toBeGreaterThan(0);
    expect(p.roofs?.length).toBe(src.roofs!.length);
    for (const r of src.roofs!) {
      const got = p.roofs!.find((g) => g.shape === r.shape && g.outline.length === r.outline.length && near(g.pitchDeg, r.pitchDeg))!;
      expect(got, r.id).toBeDefined();
      expect(near(got.thickness, r.thickness, 1e-4)).toBe(true);
    }
  });

  it(":wettbewerb: Geländer und Rampe kommen als Bauteile zurück", async () => {
    const src = buildWettbewerbSampleProject();
    const { spf, p, summary } = await roundtrip(src);
    expect((spf.match(/IFCPROPERTYSET\([^;]*Dossier_Railing/g) ?? []).length).toBe(src.railings!.length);
    expect(p.railings?.length).toBe(src.railings!.length);
    expect(summary.railings).toBe(src.railings!.length);
    for (const r of src.railings!) {
      const got = p.railings!.find((g) => g.floorId === r.floorId && g.points.length === r.points.length && g.points.every((q, i) => near(q.x, r.points[i].x) && near(q.y, r.points[i].y)))!;
      expect(got, r.id).toBeDefined();
      expect(near(got.height, r.height)).toBe(true);
      expect(got.kind).toBe(r.kind);
      expect(got.closed ?? false).toBe(r.closed ?? false);
      expect(near(got.baseOffset ?? 0, r.baseOffset ?? 0, 1e-4)).toBe(true);
    }
    const ramps = (src.ceilings ?? []).filter((c) => c.slope?.ramp);
    expect(ramps.length).toBeGreaterThan(0);
    expect(count(spf, "IFCRAMP\\b")).toBe(ramps.length);
    expect((p.ceilings ?? []).filter((c) => c.slope?.ramp).length).toBe(ramps.length);
    expect((p.ceilings ?? []).length).toBe((src.ceilings ?? []).length);
    for (const c of ramps) {
      const grade = (s: NonNullable<typeof c.slope>) => s.rise / Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
      const got = (p.ceilings ?? []).find((g) => g.slope?.ramp && near(Math.abs(g.slope.rise), Math.abs(c.slope!.rise), 1e-3))!;
      expect(got, c.id).toBeDefined();
      expect(Math.abs(grade(got.slope!))).toBeCloseTo(Math.abs(grade(c.slope!)), 3);
      expect(got.outline.length).toBe(c.outline.length);
    }
  });
});
