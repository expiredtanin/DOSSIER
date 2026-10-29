// IFC2x3-Export (Coordination View 2.0, [B5] 28.10.): Schema-Option des IFC-Exports.
//
//  - Text: Kopf, Entitäten des Schemas (keine IFC4-Entitäten), gleiche GlobalIds wie IFC4.
//  - Eigener Import (`src/io/ifcImport.ts`, Kern `import_ifc.rs`): liest die 2x3-Datei als Meshes und als
//    Bauteile mit demselben Ergebnis wie die IFC4-Datei.
//  - ifcopenshell (nur mit Python/ifcopenshell): Schema-Prüfung der 2x3-Datei ohne Befunde, Volumen und
//    Lage je Bauteil gleich der IFC4-Ausgabe.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../engine/fileioWasm.setup";
import { exportIfcSpf } from "./exportIfc";
import { importIfcInto, inspectIfc } from "../io/importView.testutil";
import { emptyProject, sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const hasIfcOpenShell = spawnSync("python3", ["-c", "import ifcopenshell, ifcopenshell.validate, _pytest"]).status === 0;
const bytesOf = (s: string) => new TextEncoder().encode(s);

const geoProject: Project = { ...sampleProject, geoAnchor: { lv95: { e: 2683000, n: 1248000 }, height: 410, model: { x: 0, y: 0 } } };
/** Laufende Import-Ids (`ifc-wall-<Zeit>-<Zähler>`) in Reihenfolge des Auftretens nummerieren. */
function normIds(x: unknown): unknown {
  const seen = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(x).replace(/ifc-[a-z]+-[0-9a-z]+-\d+/g, (m) => {
      if (!seen.has(m)) seen.set(m, `id${seen.size}`);
      return seen.get(m)!;
    }),
  );
}

/** Demo-Haus mit mehrschichtigem Dachtyp am Dach (in IFC2x3 ohne IfcRoofType). */
const roofTyped: Project = { ...sampleProject, roofs: (sampleProject.roofs ?? []).map((r) => ({ ...r, roofTypeId: "roof-warm" })) };
const v4 = (p: Project, o = {}) => exportIfcSpf(p, o);
const v3 = (p: Project, o = {}) => exportIfcSpf(p, { ...o, schema: "IFC2X3" });

/** Entitätsnamen (`#n=IFCWALL(`) der Datei. */
function entityNames(ifc: string): Set<string> {
  return new Set([...ifc.matchAll(/^#\d+=(IFC[A-Z0-9]+)\(/gm)].map((m) => m[1]));
}
/** GlobalIds aller Zeilen, die mit `'<22 Zeichen>'` beginnen. */
function guids(ifc: string): Set<string> {
  return new Set([...ifc.matchAll(/^#\d+=IFC[A-Z0-9]+\('([0-9A-Za-z_$]{22})'/gm)].map((m) => m[1]));
}

describe("IFC2x3-Export: Text", () => {
  const ifc = v3(sampleProject);
  it("Kopf: Schema IFC2X3 und Coordination View 2.0; IFC4 bleibt Standard", () => {
    expect(ifc).toContain("FILE_SCHEMA(('IFC2X3'));");
    expect(ifc).toContain("FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');");
    expect(v4(sampleProject)).toContain("FILE_SCHEMA(('IFC4'));");
    expect(exportIfcSpf(sampleProject, { schema: "IFC4" }).split("\n").slice(-20)).toEqual(v4(sampleProject).split("\n").slice(-20));
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(ifc)).toBe(true);
  });

  it("keine IFC4-Entitäten, Ersatz aus IFC2x3", () => {
    const names = entityNames(ifc);
    for (const gone of [
      "IFCTRIANGULATEDFACESET",
      "IFCCARTESIANPOINTLIST3D",
      "IFCROOFTYPE",
      "IFCPROJECTEDCRS",
      "IFCMAPCONVERSION",
    ]) {
      expect(names.has(gone), gone).toBe(false);
    }
    // Dach als Netz → IfcFacetedBrep (dicht) bzw. IfcShellBasedSurfaceModel; Türen mit IfcDoorStyle.
    expect(names.has("IFCFACETEDBREP") || names.has("IFCSHELLBASEDSURFACEMODEL")).toBe(true);
    expect(names.has("IFCDOORSTYLE")).toBe(true);
    expect(names.has("IFCWALLSTANDARDCASE")).toBe(true);
    expect(names.has("IFCPRESENTATIONSTYLEASSIGNMENT")).toBe(true);
    // Türen/Fenster ohne PredefinedType/OperationType: nur Höhe und Breite am Ende.
    for (const line of ifc.split("\n").filter((l) => /^#\d+=IFC(DOOR|WINDOW)\(/.test(l))) {
      expect(line, line).toMatch(/,\$,[\d.]+,[\d.]+\);$/);
    }
  });

  it("gleiche GlobalIds wie IFC4 (ausser den Entitäten, die es nur in einem Schema gibt)", () => {
    const a = guids(v4(sampleProject));
    const b = guids(ifc);
    const onlyIn3 = [...b].filter((g) => !a.has(g));
    const onlyIn4 = [...a].filter((g) => !b.has(g));
    // IFC2x3: Türstil + Beziehung (je Ausführung); IFC4: Dachtyp samt Zuordnung, Material am Typ.
    expect(onlyIn3.length).toBeLessThanOrEqual(8);
    expect(onlyIn4.length).toBeLessThanOrEqual(6);
    // Alle Bauteile (IfcProduct) tragen in beiden Schemata dieselbe GlobalId.
    const productGuids = (t: string) =>
      new Set(
        [...t.matchAll(/^#\d+=(IFCWALL|IFCWALLSTANDARDCASE|IFCSLAB|IFCROOF|IFCDOOR|IFCWINDOW|IFCSTAIR|IFCSTAIRFLIGHT|IFCRAILING|IFCCOLUMN|IFCSPACE|IFCOPENINGELEMENT|IFCBUILDINGSTOREY|IFCBUILDING|IFCSITE|IFCPROJECT)\('([^']{22})'/gm)].map((m) => m[2]),
      );
    expect(productGuids(ifc)).toEqual(productGuids(v4(sampleProject)));
  });

  it("Georeferenz: IfcSite RefLatitude/RefLongitude/RefElevation und ePSet_*, kein IfcMapConversion", () => {
    const g = v3(geoProject);
    const site = g.split("\n").find((l) => /^#\d+=IFCSITE\(/.test(l))!;
    // LV95 2683000/1248000 ≈ Zürich-Nord: 47° 25′ N, 8° 33′ E (swisstopo-Näherung).
    const m = site.match(/\.ELEMENT\.,\((\d+),(\d+),(\d+),(\d+)\),\((\d+),(\d+),(\d+),(\d+)\),410\.0,\$,\$\);$/);
    expect(m, site).not.toBeNull();
    const [lat, lon] = [m!.slice(1, 5).map(Number), m!.slice(5, 9).map(Number)];
    expect(lat[0] + lat[1] / 60 + lat[2] / 3600 + lat[3] / 3.6e9).toBeCloseTo(47.4, 0);
    expect(lon[0] + lon[1] / 60 + lon[2] / 3600 + lon[3] / 3.6e9).toBeCloseTo(8.5, 0);
    expect(g).toContain("'ePSet_ProjectedCRS'");
    expect(g).toContain("'ePSet_MapConversion'");
    expect(g).toContain("IFCLABEL('EPSG:2056')");
    expect(g).not.toContain("IFCMAPCONVERSION");
    // Ohne Bezug weder Winkel noch Sätze.
    expect(ifc).not.toContain("ePSet_");
    expect(ifc.split("\n").find((l) => /^#\d+=IFCSITE\(/.test(l))).toContain(".ELEMENT.,$,$,$,$,$);");
    // IFC4 trägt die Georeferenz weiter über IfcMapConversion.
    expect(v4(geoProject)).toContain("IFCMAPCONVERSION(");
  });

  it("Klassifikation, Zonen, Psets und Mengen wie in IFC4", () => {
    const a = v4(sampleProject, { ebkph: true });
    const b = v3(sampleProject, { ebkph: true });
    for (const name of ["IFCCLASSIFICATION", "IFCCLASSIFICATIONREFERENCE", "IFCRELASSOCIATESCLASSIFICATION", "IFCPROPERTYSET", "IFCELEMENTQUANTITY", "IFCQUANTITYAREA", "IFCQUANTITYLENGTH", "IFCQUANTITYVOLUME", "IFCZONE"]) {
      const n = (t: string) => (t.match(new RegExp(`^#\\d+=${name}\\(`, "gm")) ?? []).length;
      expect(n(b), name).toBe(n(a));
    }
    expect(b).toContain("'Qto_WallBaseQuantities'");
    expect(b).toContain("'Pset_WallCommon'");
    expect(b).toContain("'eBKP-H'");
  });

  it("deterministisch", () => {
    // Zeitstempel (`now`, `iso`) ändern sich je Sekunde: nur die Datensätze vergleichen.
    const strip = (t: string) => t.replace(/FILE_NAME\([^;]*;/, "").replace(/IFCOWNERHISTORY\([^;]*;/, "");
    expect(strip(v3(sampleProject))).toBe(strip(v3(sampleProject)));
  });
});

describe("IFC2x3-Export: eigener Import liest dasselbe wie bei IFC4", () => {
  const a = v4(sampleProject);
  const b = v3(sampleProject);

  it("Meshes: gleiche Körper (GlobalId, Volumen), Schema IFC2X3 erkannt", async () => {
    const r4 = await inspectIfc(bytesOf(a));
    const r3 = await inspectIfc(bytesOf(b));
    expect(r4.meta.schema).toBe("IFC4");
    expect(r3.meta.schema).toBe("IFC2X3");
    expect(r3.meta.parseErrors).toBe(0);
    expect(r3.meta.skippedItems).toEqual({});
    expect(r3.meta.productsWithoutGeometry).toBe(0);
    expect(r3.products.length).toBe(r4.products.length);
    const vol = (p: { positions: ArrayLike<number>; indices: ArrayLike<number> }) => {
      let v = 0;
      for (let i = 0; i + 2 < p.indices.length; i += 3) {
        const [x, y, z] = [p.indices[i] * 3, p.indices[i + 1] * 3, p.indices[i + 2] * 3];
        const q = p.positions;
        v += (q[x] * (q[y + 1] * q[z + 2] - q[y + 2] * q[z + 1]) + q[x + 1] * (q[y + 2] * q[z] - q[y] * q[z + 2]) + q[x + 2] * (q[y] * q[z + 1] - q[y + 1] * q[z])) / 6;
      }
      return v;
    };
    const byId4 = new Map(r4.products.map((p) => [p.globalId, p]));
    for (const p of r3.products) {
      const q = byId4.get(p.globalId);
      expect(q, `${p.ifcClass} ${p.name}`).toBeDefined();
      expect(p.name).toBe(q!.name);
      expect(p.storey).toBe(q!.storey);
      expect(vol(p), `${p.ifcClass} ${p.name}`).toBeCloseTo(vol(q!), 6);
      expect(vol(p)).toBeGreaterThan(0);
    }
  });

  it("Bauteile: gleiche Wände, Öffnungen, Decken, Räume", async () => {
    const p4 = await importIfcInto(emptyProject, bytesOf(a), { elements: true });
    const p3 = await importIfcInto(emptyProject, bytesOf(b), { elements: true });
    expect(p3.report.parseErrors).toBe(0);
    expect(p3.summary).toEqual(p4.summary);
    for (const key of ["walls", "openings", "ceilings", "rooms", "wallTypes"] as const) {
      expect(normIds(p3.project[key]), key).toEqual(normIds(p4.project[key]));
    }
  });
});

// ── ifcopenshell ────────────────────────────────────────────────────────────

function writeIfc(name: string, ifc: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dossier-ifc2x3-"));
  const file = join(dir, `${name}.ifc`);
  writeFileSync(file, ifc);
  return file;
}

function validate(name: string, ifc: string): { status: number | null; out: string } {
  const r = spawnSync("python3", ["scripts/validate-ifc.py", writeIfc(name, ifc)], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// Je Produkt (GlobalId): Klasse, Volumen und Welt-Bounding-Box der Geometrie sowie Schema der Datei.
const PRODUCTS = `
import json, sys
import ifcopenshell, ifcopenshell.geom, ifcopenshell.util.shape as us
m = ifcopenshell.open(sys.argv[1])
s = ifcopenshell.geom.settings()
s.set("use-world-coords", True)
out = {"schema": m.schema, "products": {}}
for p in m.by_type("IfcProduct"):
    if p.Representation is None:
        continue
    sh = ifcopenshell.geom.create_shape(s, p)
    v = sh.geometry.verts
    xs, ys, zs = v[0::3], v[1::3], v[2::3]
    out["products"][p.GlobalId] = {"cls": p.is_a(), "name": p.Name, "volume": us.get_volume(sh.geometry),
        "bbox": [min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)]}
print(json.dumps(out))
`;

interface ProductInfo {
  cls: string;
  name: string | null;
  volume: number;
  bbox: number[];
}

function products(name: string, ifc: string): { schema: string; products: Record<string, ProductInfo> } {
  const r = spawnSync("python3", ["-c", PRODUCTS, writeIfc(name, ifc)], { encoding: "utf8", timeout: 120_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

// Schema je Bauteil (nach ifcopenshell gelesen): Typ-Zuordnung, Türausführung, Material am Dach.
const DETAILS = `
import json, sys
import ifcopenshell
m = ifcopenshell.open(sys.argv[1])
out = {"standardCase": len(m.by_type("IfcWallStandardCase", include_subtypes=False)),
       "doorOps": sorted({(d.is_a(), getattr(d, "OperationType", None)) for d in m.by_type("IfcDoorStyle")} | {(d.is_a(), getattr(d, "OperationType", None)) for d in m.by_type("IfcWindowStyle")}),
       "doorsWithStyle": sum(1 for d in m.by_type("IfcDoor") if any(r.is_a("IfcRelDefinesByType") for r in d.IsDefinedBy)),
       "doors": len(m.by_type("IfcDoor")),
       "wallUsage": sum(1 for w in m.by_type("IfcWallStandardCase") for r in w.HasAssociations if r.is_a("IfcRelAssociatesMaterial") and r.RelatingMaterial.is_a("IfcMaterialLayerSetUsage")),
       "roofLayers": [[l.LayerThickness for l in r.RelatingMaterial.MaterialLayers] for roof in m.by_type("IfcRoof") for r in roof.HasAssociations if r.is_a("IfcRelAssociatesMaterial") and r.RelatingMaterial.is_a("IfcMaterialLayerSet")],
       "site": [m.by_type("IfcSite")[0].RefLatitude, m.by_type("IfcSite")[0].RefLongitude, m.by_type("IfcSite")[0].RefElevation]}
print(json.dumps(out))
`;

function details(name: string, ifc: string): Record<string, unknown> {
  const r = spawnSync("python3", ["-c", DETAILS, writeIfc(name, ifc)], { encoding: "utf8", timeout: 120_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

/** Eine freistehende Wand 5 × 0.4 × 2.6 m mit einem Fenster (wie `exportIfc.validate.test.ts`). */
function singleWall(recess: boolean): Project {
  return {
    ...sampleProject,
    walls: [{ id: "W1", type: "wall", floorId: "eg", categoryCode: "20", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, wallTypeId: "solo", height: 2.6 }],
    wallTypes: [...sampleProject.wallTypes, { id: "solo", name: "Beton 40", layers: [{ componentId: sampleProject.components[0].id, thickness: 0.4 }] }],
    windowTypes: [{ id: "wt", name: "Fenster", kind: "drehkipp", wingCount: 1, glazing: "dreifach", frameThickness: 0.08, defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.2, innerLayerRecess: recess }],
    openings: [{ id: "F1", type: "opening", hostWallId: "W1", categoryCode: "21", kind: "window", position: 1, width: 1.2, height: 1.2, sillHeight: 0.9, typeId: "wt" }],
    ceilings: [],
    roofs: [],
    rooms: [],
    stairs: [],
    columns: [],
  } as Project;
}

/** Wie `singleWall`, dazu Stützen (Rechteck/rund), damit auch IfcColumn geprüft wird. */
function withColumns(): Project {
  const col = (id: string, profile: { kind: "rect"; width: number; depth: number } | { kind: "round"; radius: number }) => ({
    id, type: "column" as const, floorId: "eg", categoryCode: "50", position: { x: 1, y: 1 }, profile, rotation: 0.3, height: 2.5,
  });
  return { ...sampleProject, columns: [col("S1", { kind: "rect", width: 0.3, depth: 0.2 }), col("S2", { kind: "round", radius: 0.15 })] };
}

// Je Fall ein Python-Prozess (~3 s, unter Last mehr): eigenes Zeitlimit.
describe.skipIf(!hasIfcOpenShell)("IFC2x3-Export gegen ifcopenshell", { timeout: 90_000 }, () => {
  const cases: [string, Project, object][] = [
    ["demo-haus", sampleProject, {}],
    ["demo-haus-klassifiziert", sampleProject, { ebkph: true, layerCodes: true }],
    ["demo-haus-geo", geoProject, {}],
    ["dach-mit-typ", roofTyped, {}],
    ["stuetzen", withColumns(), {}],
    ["wand-oeffnung", singleWall(false), {}],
    ["wand-mesh", singleWall(true), {}],
    ["umlaute", { ...sampleProject, name: "Wohnüberbauung «Süd»", rooms: (sampleProject.rooms ?? []).map((r) => ({ ...r, name: "Küche/Essen" })) }, {}],
  ];

  it.each(cases)("%s: Schema IFC2X3 ohne Befunde, Körper erzeugbar", (name, project, opts) => {
    const r = validate(name, v3(project, opts));
    expect(r.out).toContain("0 Befunde");
    expect(r.status).toBe(0);
    expect(products(name, v3(project, opts)).schema).toBe("IFC2X3");
  });

  it.each(cases)("%s: Volumen und Lage je Bauteil gleich IFC4", (name, project, opts) => {
    const four = products(name + "-4", v4(project, opts));
    const three = products(name + "-3", v3(project, opts));
    expect(four.schema).toBe("IFC4");
    expect(Object.keys(three.products).sort()).toEqual(Object.keys(four.products).sort());
    expect(Object.keys(three.products).length).toBeGreaterThan(0);
    for (const [id, p3] of Object.entries(three.products)) {
      const p4 = four.products[id];
      const what = `${p3.cls} ${p3.name}`;
      expect(Math.abs(p3.volume - p4.volume), `${what}: ${p3.volume} vs ${p4.volume}`).toBeLessThanOrEqual(1e-6);
      p3.bbox.forEach((x, i) => expect(Math.abs(x - p4.bbox[i]), `${what} bbox ${i}`).toBeLessThanOrEqual(1e-6));
      // Klasse: IfcWallStandardCase ist ein IfcWall; sonst gleich.
      expect(p3.cls === p4.cls || (p4.cls === "IfcWall" && p3.cls === "IfcWallStandardCase"), `${p4.cls} → ${p3.cls}`).toBe(true);
    }
  });

  it("Demo-Haus: StandardCase mit Usage, Türen mit Style, Dachschichten am Dach", () => {
    const d = details("demo-haus", v3(roofTyped)) as {
      standardCase: number;
      doorsWithStyle: number;
      doors: number;
      wallUsage: number;
      roofLayers: number[][];
      doorOps: [string, string][];
    };
    // Jede StandardCase-Wand hat genau eine LayerSetUsage (IFC2x3 WR1).
    expect(d.standardCase).toBeGreaterThan(0);
    expect(d.wallUsage).toBe(d.standardCase);
    expect(d.doors).toBeGreaterThan(0);
    expect(d.doorsWithStyle).toBe(d.doors);
    expect(d.doorOps.length).toBeGreaterThan(0);
    // Dachtyp gibt es in IFC2x3 nicht: Schichten direkt am Dach.
    expect(d.roofLayers.length).toBeGreaterThan(0);
    for (const layers of d.roofLayers) expect(layers.reduce((s, x) => s + x, 0)).toBeGreaterThan(0);
  });

  it("Georeferenz: IfcSite-Winkel gelesen, Höhe 410", () => {
    const d = details("geo", v3(geoProject)) as { site: [number[], number[], number] };
    const deg = (a: number[]) => a[0] + a[1] / 60 + a[2] / 3600 + (a[3] ?? 0) / 3.6e9;
    expect(deg(d.site[0])).toBeCloseTo(47.4, 0);
    expect(deg(d.site[1])).toBeCloseTo(8.5, 0);
    expect(d.site[2]).toBeCloseTo(410, 9);
  });
});
