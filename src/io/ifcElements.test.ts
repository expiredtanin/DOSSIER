// IFC-Import zu echten Bauteilen ([B4]): Rundreise eigener Export → Import als Bauteile → gleiche
// Wände/Öffnungen/Decken/Räume (Lage, Dicke, Höhe, Typ) wie das Original (Demo-Haus); dazu Farbe und
// GlobalId am Kontext-Mesh ([B3]-Nachtrag) und die Speichern/Laden-Rundreise.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyOps, diffToOps, validateProject } from "../core/ops";
import { exportIfcSpf } from "../export/exportIfc";
import { emptyProject, sampleProject } from "../model/sampleProject";
import type { Column, Opening, Project, Vec2, Wall } from "../model/types";
import { wallTypeThickness } from "../model/types";
import { formatIfcElementsSummary, ifcElementsToProject, readIfcElements } from "./ifcElements";
import { ifcToImportedMeshes, readIfc, type IfcProduct } from "./ifcImport";
import { parseProjectFile, serializeProject } from "./projectFormat";

const bytesOf = (s: string) => new TextEncoder().encode(s);
const near = (a: Vec2, b: Vec2, tol = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
const symmetric = (p: Project, wallTypeId: string) => {
  const l = p.wallTypes.find((t) => t.id === wallTypeId)!.layers;
  return l.every((x, i) => x.componentId === l[l.length - 1 - i].componentId && Math.abs(x.thickness - l[l.length - 1 - i].thickness) < 1e-9);
};

async function importInto(base: Project, src: Project) {
  const { products, report, elements } = await readIfcElements(bytesOf(exportIfcSpf(src)));
  const r = ifcElementsToProject(base, products, elements, { fileName: "haus.ifc" });
  return { ...r, report, elements, products };
}

describe("IFC-Import als Bauteile: Rundreise Demo-Haus", () => {
  it("gleiche Wände (Achse, Typ, Höhe, Geschoss), Öffnungen, Decke, Raum; Rest als Mesh", async () => {
    const { project: p, summary, report } = await importInto(emptyProject, sampleProject);
    expect(report.parseErrors).toBe(0);
    expect(summary).toMatchObject({ walls: 9, openings: 3, ceilings: 1, columns: 0, rooms: 1, floors: 0, wallTypes: 0, ceilingTypes: 0, components: 0, kept: 0 });
    // Dach und Treppenlauf (die IfcStair selbst hat keine Darstellung) bleiben Kontext-Mesh.
    expect((p.context ?? []).map((c) => (c as { layer?: string }).layer).sort()).toEqual(["IfcRoof", "IfcStairFlight"]);
    expect(validateProject(p)).toEqual([]);

    const byOrig = new Map<string, Wall>();
    for (const w of sampleProject.walls) {
      const sym = symmetric(sampleProject, w.wallTypeId);
      const got = p.walls.find(
        (g) =>
          g.floorId === w.floorId &&
          ((near(g.start, w.start) && near(g.end, w.end)) || (sym && near(g.start, w.end) && near(g.end, w.start))),
      );
      expect(got, `${w.id} ${JSON.stringify(p.walls.map((x) => [x.start, x.end]))}`).toBeDefined();
      expect(got!.wallTypeId).toBe(w.wallTypeId);
      expect(got!.height).toBeCloseTo(w.height, 9);
      expect(got!.bottom).toBeUndefined();
      expect(got!.categoryCode).toBe("20");
      byOrig.set(w.id, got!);
    }
    for (const o of sampleProject.openings ?? []) {
      const host = byOrig.get(o.hostWallId)!;
      const got = (p.openings ?? []).find((g) => g.hostWallId === host.id && Math.abs(g.width - o.width) < 1e-6 && g.kind === o.kind) as Opening;
      expect(got, o.id).toBeDefined();
      const orig = sampleProject.walls.find((w) => w.id === o.hostWallId)!;
      const len = Math.hypot(orig.end.x - orig.start.x, orig.end.y - orig.start.y);
      const pos = near(host.start, orig.start) ? o.position : len - o.position - o.width;
      expect(got.position).toBeCloseTo(pos, 6);
      expect(got.height).toBeCloseTo(o.height, 6);
      expect(got.sillHeight).toBeCloseTo(o.sillHeight, 6);
      expect(got.typeId).toBe(o.typeId);
    }
    const c = sampleProject.ceilings![0];
    const gc = p.ceilings![0];
    expect(gc.floorId).toBe(c.floorId);
    expect(gc.ceilingTypeId).toBe(c.ceilingTypeId);
    expect(gc.top).toBeUndefined();
    expect(gc.outline.length).toBe(c.outline.length);
    for (const q of c.outline) expect(gc.outline.some((g) => near(g, q)), JSON.stringify(q)).toBe(true);
    const room = sampleProject.rooms![0];
    const gr = p.rooms![0];
    expect([gr.name, gr.siaCategory, gr.floorId]).toEqual([room.name, room.siaCategory, room.floorId]);
    for (const q of room.boundary) expect(gr.boundary.some((g) => near(g, q))).toBe(true);
    const text = formatIfcElementsSummary(summary, report, (k, v) => `${k}${JSON.stringify(v ?? {})}`);
    expect(text).toContain('"walls":9');
  });

  it("Tür-Anschlag/Aufschlag und Fensterteilung aus OperationType/PartitioningType (Rundreise)", async () => {
    // Lage im Raum vergleichen (die Wand kann umgekehrt ankommen): Scharnierpunkt und Aufschlagrichtung.
    const physical = (o: Opening, w: Wall) => {
      const l = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
      const u = { x: (w.end.x - w.start.x) / l, y: (w.end.y - w.start.y) / l };
      const along = (o.hinge ?? "start") === "start" ? o.position : o.position + o.width;
      const s = ((o.swing ?? "left") === "left" ? 1 : -1) * ((o.openingDir ?? "in") === "in" ? 1 : -1);
      return { hinge: { x: w.start.x + u.x * along, y: w.start.y + u.y * along }, swing: { x: -u.y * s, y: u.x * s } };
    };
    for (const hinge of ["start", "end"] as const)
      for (const swing of ["left", "right"] as const)
        for (const openingDir of ["in", "out"] as const) {
          const src: Project = {
            ...sampleProject,
            openings: (sampleProject.openings ?? []).map((o) =>
              o.id === "D1" ? { ...o, hinge, swing, openingDir } : o.id === "O2" ? { ...o, wingCount: 2 } : o,
            ),
          };
          const { project: p } = await importInto(emptyProject, src);
          const d1 = src.openings!.find((o) => o.id === "D1")!;
          const w1 = src.walls.find((w) => w.id === d1.hostWallId)!;
          const got = (p.openings ?? []).find((o) => o.kind === "door")!;
          const gw = p.walls.find((w) => w.id === got.hostWallId)!;
          const want = physical(d1, w1);
          const have = physical(got, gw);
          const tag = `${hinge}/${swing}/${openingDir}`;
          expect(near(have.hinge, want.hinge), tag).toBe(true);
          expect(near(have.swing, want.swing), tag).toBe(true);
          expect(got.typeId, tag).toBe("door-standard");
          // Fenster O2 mit zwei Flügeln: Typ mit zwei Flügeln (oder eigene Flügelzahl).
          const o2 = (p.openings ?? []).find((o) => o.kind === "window" && Math.abs(o.width - 1.4) < 1e-6)!;
          const wt = (p.windowTypes ?? []).find((t) => t.id === o2.typeId);
          expect(o2.wingCount ?? wt?.wingCount, tag).toBe(2);
        }
  });

  it("in ein Projekt ohne Geschosse/Typen: legt Geschosse, Wand-/Deckentypen und Materialien an", async () => {
    const bare: Project = {
      ...emptyProject,
      drawingLevels: emptyProject.drawingLevels.filter((l) => l.kind !== "floor"),
      wallTypes: [],
      ceilingTypes: [],
      components: [],
    };
    const { project: p, summary } = await importInto(bare, sampleProject);
    expect(summary).toMatchObject({ walls: 9, openings: 3, ceilings: 1, rooms: 1, floors: 2, wallTypes: 2, ceilingTypes: 1 });
    // Materialien: Aussenputz, Wärmedämmung, Backstein, Innenputz, Zementestrich, Beton.
    expect(summary.components).toBe(6);
    const floors = p.drawingLevels.filter((l) => l.kind === "floor");
    expect(floors.map((f) => [f.name, f.baseElevation, f.floorHeight])).toEqual([
      ["Erdgeschoss", 0, 2.6],
      ["Obergeschoss", 2.6, 2.6],
    ]);
    const aw = p.wallTypes.find((t) => t.name === "Aussenwand 34.5 cm")!;
    expect(wallTypeThickness(aw)).toBeCloseTo(0.345, 9);
    expect(aw.layers.map((l) => p.components.find((c) => c.id === l.componentId)!.name)).toEqual([
      "Aussenputz", "Wärmedämmung", "Backstein", "Innenputz",
    ]);
    expect(p.walls.filter((w) => w.wallTypeId === aw.id).length).toBe(8);
    expect(validateProject(p)).toEqual([]);
  });

  it("über Ops angewandt und gespeichert/geladen bleibt alles gleich", async () => {
    const { project: next } = await importInto(emptyProject, sampleProject);
    const applied = applyOps(emptyProject, diffToOps(emptyProject, next));
    expect(applied.walls).toEqual(next.walls);
    expect(applied.openings).toEqual(next.openings);
    const back = parseProjectFile(serializeProject(applied));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.warnings).toEqual([]);
    expect(back.project.walls).toEqual(next.walls);
    expect(back.project.ceilings).toEqual(next.ceilings);
    expect(back.project.context).toEqual(next.context);
  });

  it("Stützen (rechteckig gedreht, rund) und abgesetzte Wand-Unterkante", async () => {
    const cols: Column[] = [
      { id: "S1", type: "column", floorId: "eg", categoryCode: "50", position: { x: 1, y: 1 }, profile: { kind: "rect", width: 0.3, depth: 0.5 }, rotation: 0, height: 2.4 },
      { id: "S2", type: "column", floorId: "og", categoryCode: "50", position: { x: 3, y: 2 }, profile: { kind: "round", radius: 0.15 }, rotation: 0, height: 2.5 },
    ];
    const src: Project = { ...sampleProject, columns: cols };
    const { project: p, summary } = await importInto(emptyProject, src);
    expect(summary.columns).toBe(2);
    const s1 = p.columns!.find((c) => c.profile.kind === "rect")!;
    expect(s1.floorId).toBe("eg");
    expect(near(s1.position, { x: 1, y: 1 })).toBe(true);
    expect(s1.profile).toEqual({ kind: "rect", width: 0.3, depth: 0.5 });
    expect(s1.rotation).toBeCloseTo(0, 9);
    expect(s1.height).toBeCloseTo(2.4, 9);
    const s2 = p.columns!.find((c) => c.profile.kind === "round")!;
    expect(s2.floorId).toBe("og");
    expect(near(s2.position, { x: 3, y: 2 }, 1e-4)).toBe(true);
    expect(s2.profile.kind === "round" && s2.profile.radius).toBeCloseTo(0.15, 6);
  });
});

describe("Kontext-Mesh: Farbe und GlobalId", () => {
  const product = (color: IfcProduct["color"], globalId = "2O2Fr$t4X7Zf8NOew3FLOH"): IfcProduct => ({
    globalId,
    ifcClass: "IfcWall",
    name: "Wand",
    storey: "EG",
    color,
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  });

  it("Farbe als #rrggbb, GlobalId als Feld, Name ohne GlobalId", () => {
    const [m] = ifcToImportedMeshes([product([1, 0.5, 0, 0.8])], "x.ifc", { group: "product" });
    expect(m.color).toBe("#ff8000");
    expect(m.ifcGlobalId).toBe("2O2Fr$t4X7Zf8NOew3FLOH");
    expect(m.name).toBe("EG: Wand");
    const [n] = ifcToImportedMeshes([product(null, "")], "x.ifc", { group: "product" });
    expect(n.color).toBeUndefined();
    expect(n.ifcGlobalId).toBeUndefined();
    // Zusammengelegt: gemeinsame Farbe nur, wenn alle gleich.
    expect(ifcToImportedMeshes([product([1, 0, 0, 1]), product([1, 0, 0, 1])], "x.ifc", { group: "class" })[0].color).toBe("#ff0000");
    expect(ifcToImportedMeshes([product([1, 0, 0, 1]), product([0, 0, 1, 1])], "x.ifc", { group: "class" })[0].color).toBeUndefined();
  });

  it("Farbe aus der Datei (IfcStyledItem) kommt am Mesh an und übersteht Speichern/Laden", async () => {
    const { products } = await readIfc(new Uint8Array(readFileSync(new URL("./testdata/ifc-geometry-cases.ifc", import.meta.url))));
    const meshes = ifcToImportedMeshes(products, "cases.ifc");
    expect(meshes.every((m) => m.ifcGlobalId && !m.name.includes("["))).toBe(true);
    const withColor = { ...meshes[0], color: "#336699" };
    const proj: Project = { ...emptyProject, context: [withColor] };
    const back = parseProjectFile(serializeProject(proj));
    expect(back.ok && back.project.context?.[0]).toEqual(withColor);
  });
});

// Freie Beispieldateien (github.com/buildingSMART/Sample-Test-Files u. a., nicht im Repo):
// DOSSIER_IFC_SAMPLES=<Verzeichnis>. Prüft: kein Absturz, gültiges Projekt, Zählung je Datei.
const samples = process.env.DOSSIER_IFC_SAMPLES;
describe.skipIf(!samples || !existsSync(samples))("IFC-Import als Bauteile: Beispieldateien", { timeout: 600_000 }, () => {
  it("alle Dateien lesbar, Ergebnis gültig", async () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.ifc$/i.test(n)) files.push(f);
      }
    };
    walk(samples!);
    const rows: string[] = [];
    for (const f of files) {
      const { products, elements } = await readIfcElements(new Uint8Array(readFileSync(f)));
      const { project, summary } = ifcElementsToProject(emptyProject, products, elements, { fileName: f });
      expect(validateProject(project), f).toEqual([]);
      rows.push(`${f.slice(samples!.length + 1)}: ${JSON.stringify(summary)}`);
    }
    process.stderr.write(rows.join("\n") + "\n");
  });
});
