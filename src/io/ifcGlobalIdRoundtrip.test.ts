// [201] IFC-GlobalId-Rundreise: der Import setzt `ifcGlobalId` an jedem erkannten Bauteil (Wand, Öffnung, Decke, Stütze, Dach,
// Treppe, Raum, Extrusion), der Export schreibt sie zurück; ohne sie bleibt es bei der abgeleiteten GUID. Doppelte
// GlobalIds (Datei zweimal importiert) landen nie doppelt in der Ausgabe.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { exportIfcSpf } from "../export/exportIfc";
import { emptyProject, sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { importIfcInto } from "./importView.testutil";

const bytesOf = (s: string) => new TextEncoder().encode(s);

/** GlobalIds je IFC-Klasse (nur die 22-stelligen Kennungen am Anfang einer Entität). */
function guidsByClass(spf: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of spf.matchAll(/#\d+=(IFC[A-Z0-9]+)\('([0-9A-Za-z_$]{22})'/g)) {
    out.set(m[1], [...(out.get(m[1]) ?? []), m[2]]);
  }
  for (const v of out.values()) v.sort();
  return out;
}

async function imported(base: Project, src: Project): Promise<Project> {
  return (await importIfcInto(base, bytesOf(exportIfcSpf(src)), { elements: true })).project;
}

const BIM = ["IFCWALL", "IFCSLAB", "IFCDOOR", "IFCWINDOW", "IFCROOF", "IFCSTAIR", "IFCSPACE"];

describe("[201] IFC-GlobalId-Rundreise", () => {
  it("Import setzt ifcGlobalId an jedem erkannten Bauteil", async () => {
    const p = await imported(emptyProject, sampleProject);
    const all = [...p.walls, ...(p.openings ?? []), ...(p.ceilings ?? []), ...(p.roofs ?? []), ...(p.stairs ?? []), ...(p.rooms ?? [])];
    expect(all.length).toBeGreaterThan(10);
    for (const e of all) expect(e.ifcGlobalId, `${e.type} ${e.id}`).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
  });

  it("Import → Export: gleiche GlobalIds je Klasse wie die Quelldatei", async () => {
    const a = guidsByClass(exportIfcSpf(sampleProject));
    const p = await imported(emptyProject, sampleProject);
    const b = guidsByClass(exportIfcSpf(p));
    for (const cls of BIM) {
      expect(a.get(cls)?.length ?? 0, `${cls} in der Quelle`).toBeGreaterThan(0);
      expect(b.get(cls), cls).toEqual(a.get(cls));
    }
  });

  it("ohne ifcGlobalId bleibt die abgeleitete GUID (deterministisch wie bisher)", () => {
    const x = guidsByClass(exportIfcSpf(sampleProject));
    const y = guidsByClass(exportIfcSpf(sampleProject));
    expect(x.get("IFCWALL")).toEqual(y.get("IFCWALL"));
  });

  it("dieselbe Datei zweimal importiert: keine GlobalId doppelt in der Ausgabe", async () => {
    const once = await imported(emptyProject, sampleProject);
    const twice = await imported(once, sampleProject);
    expect(twice.walls.length).toBe(once.walls.length * 2);
    const spf = exportIfcSpf(twice);
    const all = [...spf.matchAll(/#\d+=IFC[A-Z0-9]+\('([0-9A-Za-z_$]{22})'/g)].map((m) => m[1]);
    expect(new Set(all).size).toBe(all.length);
    // Die erste Kopie behält die ursprünglichen GlobalIds.
    const src = guidsByClass(exportIfcSpf(sampleProject)).get("IFCWALL")!;
    const out = new Set(guidsByClass(spf).get("IFCWALL")!);
    for (const g of src) expect(out.has(g)).toBe(true);
  });
});
