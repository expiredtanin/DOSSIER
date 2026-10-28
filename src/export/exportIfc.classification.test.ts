// IFC für die Schweizer Praxis ([B5], 28.10.): Klassifikation (eBKP-H-Hauptgruppen, Ebene des Modells),
// SIA-416-Zonen und Geschoss-Kennwerte; Rundreise Export → Import und Prüfung mit ifcopenshell.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../engine/fileioWasm.setup";
import { exportIfcSpf } from "./exportIfc";
import { EBKPH_GROUPS, ebkphGroup, layerClassification } from "./ifcClassification";
import { readIfcElements } from "../io/ifcElements";
import { classificationSuffix, ifcToImportedMeshes, readIfc } from "../io/ifcImport";
import { sampleProject } from "../model/sampleProject";
import type { Project, Room } from "../model/types";

const hasIfcOpenShell = spawnSync("python3", ["-c", "import ifcopenshell, ifcopenshell.util.classification, ifcopenshell.validate, _pytest"]).status === 0;

const lines = (ifc: string, ty: string): string[] => ifc.split("\n").filter((l) => new RegExp(`^#\\d+=${ty}\\(`).test(l));

/** Demo-Haus mit Räumen in mehreren SIA-Kategorien (zwei im EG, einer im OG). */
function houseWithRooms(): Project {
  const base = sampleProject.rooms![0];
  const at = (id: string, floorId: string, siaCategory: Room["siaCategory"], dx: number): Room => ({
    ...base,
    id,
    floorId,
    siaCategory,
    name: id,
    boundary: base.boundary.map((p) => ({ x: p.x + dx, y: p.y })),
  });
  return {
    ...sampleProject,
    rooms: [base, at("R2", "eg", "HNF", 6), at("R3", "eg", "VF", 12), at("R4", "og", "NNF", 0)],
  };
}

describe("eBKP-H-Standardzuordnung", () => {
  it("nur gesicherte Hauptgruppen, Tür und Raum bleiben unklassifiziert", () => {
    expect(Object.keys(EBKPH_GROUPS)).toEqual(["C", "E", "F"]);
    expect(ebkphGroup("wall")).toEqual({ code: "C", name: "Konstruktion Gebäude" });
    expect(ebkphGroup("slab")?.code).toBe("C");
    expect(ebkphGroup("column")?.code).toBe("C");
    expect(ebkphGroup("stair")?.code).toBe("C");
    expect(ebkphGroup("roof")).toEqual({ code: "F", name: "Bedachung Gebäude" });
    expect(ebkphGroup("window")).toEqual({ code: "E", name: "Äussere Wandbekleidung Gebäude" });
    expect(ebkphGroup("door")).toBeNull();
    expect(ebkphGroup("space")).toBeNull();
  });

  it("Ebene: Name aus dem Ebenenbaum, unbekannter Code bleibt Code, ohne Code nichts", () => {
    expect(layerClassification(sampleProject, "20")?.code).toBe("20");
    expect(layerClassification(sampleProject, "25")?.name).toBe("Stützen"); // Unterkategorie
    expect(layerClassification(sampleProject, "777")).toEqual({ code: "777", name: "777" });
    expect(layerClassification(sampleProject, undefined)).toBeNull();
    expect(layerClassification(sampleProject, " ")).toBeNull();
  });
});

describe("IFC-Export: Zonen und Geschoss-Kennwerte (SIA 416)", () => {
  it("je Kategorie eine IfcZone mit ihren Räumen, Kategorie und Fläche als Eigenschaft", () => {
    const ifc = exportIfcSpf(houseWithRooms());
    // HNF (R1, R2), VF (R3), NNF (R4) → 3 Zonen; 4 Räume in 3 Zuordnungen.
    const zones = lines(ifc, "IFCZONE");
    expect(zones).toHaveLength(3);
    expect(zones.map((l) => l.match(/,'(HNF|NNF|VF)',\$,\$,/)?.[1]).sort()).toEqual(["HNF", "NNF", "VF"]);
    expect(lines(ifc, "IFCRELASSIGNSTOGROUP")).toHaveLength(3);
    expect(ifc).toContain("'CH_Zone'");
    expect(ifc).toContain("'CH_Qto_SIA416'");
    // Ohne Option keine Klassifikation.
    expect(lines(ifc, "IFCCLASSIFICATION")).toHaveLength(0);
  });

  it("ohne Räume keine Zonen und keine Geschoss-Mengen", () => {
    const ifc = exportIfcSpf({ ...sampleProject, rooms: [] });
    expect(lines(ifc, "IFCZONE")).toHaveLength(0);
    expect(ifc).not.toContain("Qto_BuildingStoreyBaseQuantities");
  });

  it("GUIDs der Zonen und der übrigen Bauteile bleiben stabil (zweimal exportiert gleich)", () => {
    const a = exportIfcSpf(houseWithRooms());
    const b = exportIfcSpf(houseWithRooms());
    const guids = (t: string) => [...t.matchAll(/=IFC[A-Z]+\('([0-9A-Za-z_$]{22})'/g)].map((m) => m[1]);
    // Zeitstempel im Kopf/OwnerHistory ändern sich nicht innerhalb derselben Sekunde zuverlässig → nur GUIDs.
    expect(guids(a)).toEqual(guids(b));
    expect(new Set(guids(a)).size).toBe(guids(a).length);
  });
});

describe("IFC-Export: Klassifikation", () => {
  it("eBKP-H: ein System, je Hauptgruppe eine Referenz und eine Beziehung; Türen und Räume ohne", () => {
    const ifc = exportIfcSpf(houseWithRooms(), { ebkph: true });
    const sys = lines(ifc, "IFCCLASSIFICATION");
    expect(sys).toHaveLength(1);
    expect(sys[0]).toContain("'SN 506 511:2020'");
    expect(sys[0]).toContain("'eBKP-H'");
    const refs = lines(ifc, "IFCCLASSIFICATIONREFERENCE");
    // C (Wand, Decke, Treppe), F (Dach), E (Fenster) — Stützen hat das Demo-Haus nicht.
    expect(refs.map((l) => l.match(/^#\d+=IFCCLASSIFICATIONREFERENCE\(\$,'(\w)'/)![1]).sort()).toEqual(["C", "E", "F"]);
    expect(lines(ifc, "IFCRELASSOCIATESCLASSIFICATION")).toHaveLength(3);
  });

  it("Ebene des Modells als eigenes System, beide Systeme zusammen möglich", () => {
    const ifc = exportIfcSpf(houseWithRooms(), { layerCodes: true, ebkph: true });
    expect(lines(ifc, "IFCCLASSIFICATION")).toHaveLength(2);
    expect(ifc).toContain("'Dossier-Ebenen'");
    const codes = lines(ifc, "IFCCLASSIFICATIONREFERENCE").map((l) => l.match(/^#\d+=IFCCLASSIFICATIONREFERENCE\(\$,'(\w+)'/)![1]);
    // Wände 20, Decke 30, Dach 31, Treppe 40, Türen/Fenster 21, Räume 60 + eBKP-H C, E, F.
    for (const c of ["20", "21", "30", "31", "40", "60", "C", "E", "F"]) expect(codes, c).toContain(c);
  });

  it("ohne Bauteile (leeres Projekt) kein leeres System", () => {
    const ifc = exportIfcSpf({ ...sampleProject, walls: [], openings: [], ceilings: [], roofs: [], stairs: [], rooms: [], columns: [], extrudedSolids: [] }, { ebkph: true, layerCodes: true });
    expect(lines(ifc, "IFCCLASSIFICATION")).toHaveLength(0);
  });
});

describe("Rundreise Export → Import", () => {
  it("Klassifikation kommt an Bauteilen und am Mesh-Rest wieder an", async () => {
    const ifc = exportIfcSpf(houseWithRooms(), { ebkph: true, layerCodes: true });
    const bytes = new TextEncoder().encode(ifc);
    const { products, elements } = await readIfcElements(bytes);
    const wall = elements.walls[0];
    expect(wall.classifications?.map((c) => `${c.system}:${c.code}`).sort()).toEqual(["Dossier-Ebenen:20", "eBKP-H:C"]);
    expect(wall.classifications?.find((c) => c.system === "eBKP-H")?.name).toBe("Konstruktion Gebäude");
    const window = elements.openings.find((o) => o.kind === "window")!;
    expect(window.classifications?.map((c) => `${c.system}:${c.code}`).sort()).toEqual(["Dossier-Ebenen:21", "eBKP-H:E"]);
    const door = elements.openings.find((o) => o.kind === "door")!;
    expect(door.classifications?.map((c) => c.system)).toEqual(["Dossier-Ebenen"]);
    // Dach bleibt Mesh, trägt aber seine Klassifikation.
    const roof = products.find((p) => p.ifcClass === "IfcRoof")!;
    expect(roof.classifications?.map((c) => c.code).sort()).toEqual(["31", "F"]);
    // Räume: Kategorie bleibt (auch über die Zone).
    expect(elements.spaces.map((s) => s.sia).sort()).toEqual(["HNF", "HNF", "NNF", "VF"]);
  });

  it("Mesh-Import: Klassifikation im Namen des Kontext-Objekts", async () => {
    const ifc = exportIfcSpf(sampleProject, { ebkph: true });
    const { products } = await readIfc(new TextEncoder().encode(ifc));
    expect(products.find((p) => p.ifcClass === "IfcRoof")?.classifications?.[0]).toMatchObject({ system: "eBKP-H", code: "F" });
    const roof = ifcToImportedMeshes(products, "haus.ifc", { group: "product" }).find((m) => m.layer === "IfcRoof")!;
    expect(roof.name).toMatch(/ \[eBKP-H F\]$/);
    expect(classificationSuffix(undefined)).toBe("");
    expect(classificationSuffix([{ system: "", code: "214", name: null }])).toBe(" [214]");
  });
});

describe.skipIf(!hasIfcOpenShell)("ifcopenshell", () => {
  const PY = `
import json, sys
import ifcopenshell, ifcopenshell.util.classification as uc, ifcopenshell.util.element as ue
m = ifcopenshell.open(sys.argv[1])
out = {"classes": {}, "zones": {}, "storeys": {}}
for e in m.by_type("IfcProduct"):
    refs = uc.get_references(e)
    if refs:
        out["classes"].setdefault(e.is_a(), []).extend(sorted(f"{uc.get_classification(r).Name}:{r.Identification}" for r in refs))
for z in m.by_type("IfcZone"):
    members = [a.is_a() for rel in z.IsGroupedBy for a in rel.RelatedObjects]
    psets = ue.get_psets(z)
    out["zones"][z.Name] = {"members": members, "sia": psets["CH_Zone"]["SIA416"], "area": psets["CH_Qto_SIA416"]["NetFloorArea"]}
for s in m.by_type("IfcBuildingStorey"):
    out["storeys"][s.Name] = ue.get_psets(s, qtos_only=True)
print(json.dumps(out))
`;
  const run = (name: string, ifc: string) => {
    const dir = mkdtempSync(join(tmpdir(), "dossier-ifc-cls-"));
    const file = join(dir, `${name}.ifc`);
    writeFileSync(file, ifc);
    const r = spawnSync("python3", ["-c", PY, file], { encoding: "utf8", timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const v = spawnSync("python3", ["scripts/validate-ifc.py", file], { encoding: "utf8", timeout: 180_000 });
    return { read: JSON.parse(r.stdout), valid: { status: v.status, out: `${v.stdout}${v.stderr}` } };
  };

  it("liest Klassifikation, Zonen und Geschoss-Mengen; 0 Befunde", () => {
    const { read, valid } = run("klassifiziert", exportIfcSpf(houseWithRooms(), { ebkph: true, layerCodes: true }));
    expect(valid.out).toMatch(/ 0 Befunde/);
    expect(valid.status).toBe(0);
    expect(read.classes.IfcWall).toContain("eBKP-H:C");
    expect(read.classes.IfcWall).toContain("Dossier-Ebenen:20");
    expect(read.classes.IfcRoof).toContain("eBKP-H:F");
    expect(read.classes.IfcWindow).toContain("eBKP-H:E");
    expect(read.classes.IfcDoor).not.toContain("eBKP-H:E");
    expect(Object.keys(read.zones).sort()).toEqual(["HNF", "NNF", "VF"]);
    expect(read.zones.HNF.members).toEqual(["IfcSpace", "IfcSpace"]);
    expect(read.zones.HNF.sia).toBe("HNF");
    // Zwei gleich grosse Räume: doppelte Nettofläche des Einzelraums.
    expect(read.zones.HNF.area).toBeCloseTo(read.zones.VF.area * 2, 6);
    const eg = read.storeys["Erdgeschoss"] ?? Object.values(read.storeys)[0];
    expect(eg.Qto_BuildingStoreyBaseQuantities.GrossFloorArea).toBeGreaterThan(0);
    expect(eg.CH_Qto_SIA416.GF).toBeCloseTo(eg.Qto_BuildingStoreyBaseQuantities.GrossFloorArea, 9);
  }, 300_000);

  it("Standardexport (ohne Option) mit Zonen: 0 Befunde", () => {
    const { valid } = run("standard", exportIfcSpf(houseWithRooms()));
    expect(valid.out).toMatch(/ 0 Befunde/);
    expect(valid.status).toBe(0);
  }, 300_000);
});
