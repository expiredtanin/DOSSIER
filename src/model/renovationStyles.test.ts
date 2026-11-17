// [275] Umbau-Farben: gedämpfte Vorgabe, Farbe ODER Stift (aktiver Stiftsatz), eigene Farben je Etappe — Auflösung im Kern
// (`renovationStyles`), Ops der Oberfläche, und dass der Grundriss genau die Farben der Muster zeigt.

import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import { generatePlan } from "../plan/generatePlan";
import { buildUmbauSampleProject } from "./sampleProjectUmbau";
import { patchRenovationStyles, renovationStyleOf, resolvedRenovationStyles, setPhaseStylesOps, setRenovationStylesOps } from "./renovation";
import type { Project } from "./types";

const ALL = new Set(["20", "21", "30", "31", "40", "60"]);
function fills(p: Project, filter: string): string[] {
  const q = { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === "eg" ? { ...l, renovationFilter: filter } : l)) };
  return generatePlan(q, "eg", ALL).primitives.flatMap((x) => (x.kind === "polygon" ? [x.fill] : []));
}

describe("[275] Umbau-Farben", () => {
  it("Vorgabe gedämpft: Ocker-Gelb, Ziegelrot, Grau", () => {
    const r = resolvedRenovationStyles(buildUmbauSampleProject());
    expect(r.defaults.demolish).toEqual({ fill: "#e8c35a", dashed: true });
    expect(r.defaults.new).toEqual({ fill: "#c8524a", line: "#9e3a33", dashed: false });
    expect(r.defaults.existing.fill).toBe("#a6a6a6");
  });

  it("Farbe und Stift schliessen sich aus; leer = Vorgabe", () => {
    let s = patchRenovationStyles(undefined, "new", { fill: "#123456" });
    expect(s).toEqual({ new: { fill: "#123456" } });
    s = patchRenovationStyles(s, "new", { fillPen: "3" });
    expect(s).toEqual({ new: { fillPen: "3" } });
    s = patchRenovationStyles(s, "new", { line: "#000000" });
    s = patchRenovationStyles(s, "new", { linePen: "4" });
    expect(s).toEqual({ new: { fillPen: "3", linePen: "4" } });
    s = patchRenovationStyles(s, "demolish", { dashed: false });
    expect(patchRenovationStyles(patchRenovationStyles(s, "new", null), "demolish", null)).toBeUndefined();
  });

  it("Stift: Farbe aus dem aktiven Stiftsatz, ein S/W-Satz färbt den Umbauplan um", () => {
    const base = buildUmbauSampleProject();
    const withPens: Project = {
      ...base,
      pens: [...(base.pens ?? []), { id: "u1", name: "Umbau Neu" }],
      penSets: [
        { id: "farbe", name: "Farbe", pens: { u1: { color: "#3366cc", weight: 0.25 } } },
        { id: "sw", name: "S/W", pens: { u1: { color: "#999999", weight: 0.25 } } },
      ],
      activePenSetId: "farbe",
    };
    const p = applyOps(withPens, setRenovationStylesOps(withPens, { new: { fillPen: "u1" } }));
    expect(renovationStyleOf(p, "new").fill).toBe("#3366cc");
    expect(fills(p, "umbauplan")).toContain("#3366cc");
    const sw = { ...p, activePenSetId: "sw" };
    expect(renovationStyleOf(sw, "new").fill).toBe("#999999");
    expect(fills(sw, "umbauplan")).toContain("#999999");
    expect(fills(sw, "umbauplan")).not.toContain("#3366cc");
    // SIA-Vorgabe zurück.
    const back = applyOps(p, setRenovationStylesOps(p, undefined));
    expect(back.renovation?.styles).toBeUndefined();
    expect(renovationStyleOf(back, "new").fill).toBe("#c8524a");
  });

  it("Etappe mit eigener Farbe: Neu der Etappe 2 im Beispiel in eigener Farbe, Projektfarbe bleibt", () => {
    const p0 = buildUmbauSampleProject();
    const e2 = p0.renovation!.phases![1];
    // Das Beispiel zeigt Etappe 2 schon in eigener Farbe.
    expect(e2.styles?.new).toBeTruthy();
    const own = renovationStyleOf(p0, "new", e2.id).fill;
    expect(own).not.toBe(renovationStyleOf(p0, "new").fill);
    expect(fills(p0, "umbauplan")).toContain(own);
    // Zurück auf die Projektfarben: nur die Etappe ändert sich (Name, Reihenfolge, Elemente bleiben).
    const p1 = applyOps(p0, setPhaseStylesOps(p0, e2.id, undefined));
    expect(p1.renovation!.phases![1]).toEqual({ id: e2.id, name: e2.name });
    expect(resolvedRenovationStyles(p1).phases[e2.id]).toBeUndefined();
    expect(fills(p1, "umbauplan")).not.toContain(own);
    expect(p1.walls.map((w) => w.renovation)).toEqual(p0.walls.map((w) => w.renovation));
    // Neue eigene Farbe für Abbruch der Etappe.
    const p2 = applyOps(p1, setPhaseStylesOps(p1, e2.id, { demolish: { fill: "#7a5c99" } }));
    expect(resolvedRenovationStyles(p2).phases[e2.id].demolish.fill).toBe("#7a5c99");
    expect(resolvedRenovationStyles(p2).phases[e2.id].new.fill).toBe("#c8524a");
  });
});
