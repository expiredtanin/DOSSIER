// [79] Publikationssätze: Revisionsindex, Dateinamen-Muster, Satz → Dateien, Protokoll.

import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Layout, Project, PublishSet, ViewSnapshot } from "../model/types";
import { applyOps } from "../core/ops";
import {
  DEFAULT_NAME_PATTERN,
  expandNamePattern,
  nextRevision,
  planPublish,
  publishOps,
} from "./publishSet";

function proj(): Project {
  const base = sampleProject;
  const l = (id: string, name: string, extra?: Partial<Layout>): Layout => ({ id, name, paper: "a3", orientation: "landscape", viewports: [], ...extra });
  return {
    ...base,
    name: "Haus Müller",
    projectNumber: "2026-14",
    layouts: [l("l1", "Grundriss EG", { planNumber: "101", revision: "A" }), l("l2", "Schnitt A/A", { planNumber: "201" }), l("l3", "Fassade")],
  };
}
const set = (extra?: Partial<PublishSet>): PublishSet => ({ id: "s1", name: "Baueingabe", layoutIds: ["l2", "l1"], ...extra });

describe("nextRevision", () => {
  it("zählt Buchstaben und Zahlen hoch", () => {
    expect(nextRevision(undefined)).toBe("A");
    expect(nextRevision("")).toBe("A");
    expect(nextRevision("A")).toBe("B");
    expect(nextRevision("Z")).toBe("AA");
    expect(nextRevision("AZ")).toBe("BA");
    expect(nextRevision("2")).toBe("3");
    expect(nextRevision("09")).toBe("10");
    expect(nextRevision("v-x")).toBe("v-x2");
  });
});

describe("expandNamePattern", () => {
  it("ersetzt Platzhalter, säubert Dateinamen und lässt leere Teile weg", () => {
    expect(expandNamePattern(DEFAULT_NAME_PATTERN, { Projektnummer: "2026-14", Blattnummer: "101", Blattname: "Grundriss EG", Index: "B" })).toBe(
      "2026-14_101_Grundriss EG_B",
    );
    expect(expandNamePattern(DEFAULT_NAME_PATTERN, { Projektnummer: "", Blattnummer: "201", Blattname: "Schnitt A/A", Index: "" })).toBe("201_Schnitt A_A");
    expect(expandNamePattern("{Unbekannt}-{Satz}", { Satz: "X" })).toBe("X");
    expect(expandNamePattern("  ", { Satz: "X" })).toBe("X");
  });
});

describe("planPublish", () => {
  it("pdf-multi: eine Datei, Blätter in Satz-Reihenfolge, Index mit Titelblock-Nummer", () => {
    const plan = planPublish(proj(), set(), "2026-10-30");
    expect(plan.sheets.map((s) => s.layoutId)).toEqual(["l2", "l1"]);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].fileName).toBe("Baueingabe.pdf");
    expect(plan.files[0].layoutIds).toEqual(["l2", "l1"]);
  });
  it("pdf-single: je Blatt eine Datei nach Muster, Revision erst nach dem Hochzählen sichtbar", () => {
    const plan = planPublish(proj(), set({ format: "pdf-single", bumpRevision: true }), "2026-10-30");
    expect(plan.files.map((f) => f.fileName)).toEqual(["2026-14_201_Schnitt A_A_A.pdf", "2026-14_101_Grundriss EG_B.pdf"]);
    expect(plan.sheets.map((s) => s.revision)).toEqual(["A", "B"]);
  });
  it("ohne includeRevision kein Index im Namen und im Protokoll bleibt er leer", () => {
    const plan = planPublish(proj(), set({ format: "pdf-single", includeRevision: false }), "2026-10-30");
    expect(plan.files[1].fileName).toBe("2026-14_101_Grundriss EG.pdf");
  });
  it("dxf: eine Datei .dxf; fehlende Layouts werden übersprungen", () => {
    const plan = planPublish(proj(), set({ format: "dxf", layoutIds: ["l1", "weg"] }), "2026-10-30");
    expect(plan.files.map((f) => f.fileName)).toEqual(["Baueingabe.dxf"]);
    expect(plan.sheets).toHaveLength(1);
  });
  it("gespeicherte Ansichten: eigene Seiten (multi) bzw. eigene Dateien (single); dwg als .dwg", () => {
    const p: Project = { ...proj(), viewSnapshots: [{ id: "v1", name: "Ansicht Süd" } as ViewSnapshot] };
    const multi = planPublish(p, set({ snapshotIds: ["v1", "weg"] }), "2026-10-30");
    expect(multi.files[0].snapshotIds).toEqual(["v1"]);
    const single = planPublish(p, set({ format: "pdf-single", snapshotIds: ["v1"] }), "2026-10-30");
    expect(single.files.map((f) => f.fileName).at(-1)).toBe("2026-14_Ansicht Süd.pdf");
    expect(planPublish(p, set({ format: "dwg" }), "2026-10-30").files[0].fileName).toBe("Baueingabe.dwg");
  });
  it("paperOverride/Massstab liegen im Plan", () => {
    const plan = planPublish(proj(), set({ paperOverride: "a4", scaleOverride: 200 }), "2026-10-30");
    expect(plan.paperOverride).toBe("a4");
    expect(plan.scaleOverride).toBe(200);
  });
});

describe("publishOps", () => {
  it("erhöht Revisionen, hängt Protokoll an; ohne bumpRevision bleiben Layouts unverändert", () => {
    const p = proj();
    const plan = planPublish(p, set({ bumpRevision: true }), "2026-10-30");
    const q = applyOps(p, publishOps(p, set({ bumpRevision: true }), plan, "2026-10-30T10:00:00.000Z", "log-1"));
    expect(q.layouts!.find((l) => l.id === "l1")!.revision).toBe("B");
    expect(q.layouts!.find((l) => l.id === "l2")!.revision).toBe("A");
    expect(q.layouts!.find((l) => l.id === "l3")!.revision).toBeUndefined();
    expect(q.publishLog).toHaveLength(1);
    expect(q.publishLog![0]).toMatchObject({ id: "log-1", setId: "s1", setName: "Baueingabe", date: "2026-10-30T10:00:00.000Z" });
    expect(q.publishLog![0].sheets.map((s) => [s.number, s.revision])).toEqual([["201", "A"], ["101", "B"]]);

    const plan2 = planPublish(p, set(), "2026-10-30");
    const r = applyOps(p, publishOps(p, set(), plan2, "2026-10-30T10:00:00.000Z", "log-2"));
    expect(r.layouts!.find((l) => l.id === "l1")!.revision).toBe("A");
    expect(r.publishLog).toHaveLength(1);
  });
});
