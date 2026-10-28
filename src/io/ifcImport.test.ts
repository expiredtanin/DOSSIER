// IFC-Import ([B3]): Rundreise mit dem eigenen IFC-Export und Gegencheck mit ifcopenshell.
//
// Toleranzen: Wände/Dächer sind im Export Dreiecksnetze (IfcTriangulatedFaceSet) und Decken
// Extrusionen von Polygonen — beides ohne Tessellierung, das Volumen muss bis auf die
// Zahlenformatierung des Exports (R(), ~1e-9 m) stimmen: relativ 1e-6. Gegen ifcopenshell gilt
// dasselbe für ebene Geometrie; Kreise/Bögen werden von beiden Seiten verschieden fein zerlegt
// (hier Sehnenfehler ≤ 2 mm) → dort relativ 3 %.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportIfcSpf, ifcGuid } from "../export/exportIfc";
import { sampleProject } from "../model/sampleProject";
import { ceilingVerticalExtent } from "../model/wall";
import { polygonArea } from "../geometry/roomArea";
import { pickGeometry } from "../plan/toWalls3d";
import { wallCutMeshes } from "../plan/wallMeshCut";
import { formatIfcReport, ifcToImportedMeshes, readIfc, type IfcProduct } from "./ifcImport";

function volume(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    v +=
      (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) +
        pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2]) +
        pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) /
      6;
  }
  return v;
}
const vol = (p: IfcProduct) => volume(p.positions, p.indices);
const bytesOf = (s: string) => new TextEncoder().encode(s);

/** Bauteile je IFC-Klasse aus dem Export-Text (Zeilen `#n=IFCWALL(`). */
function exportedCounts(ifc: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const cls of ["IFCWALL", "IFCSLAB", "IFCROOF", "IFCDOOR", "IFCWINDOW", "IFCSTAIR", "IFCCOLUMN", "IFCBUILDINGELEMENTPROXY"]) {
    const n = (ifc.match(new RegExp(`^#\\d+=${cls}\\(`, "gm")) ?? []).length;
    if (n) m.set(cls, n);
  }
  return m;
}

const relClose = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-9);

describe("IFC-Import: Rundreise mit dem eigenen Export", () => {
  const ifc = exportIfcSpf(sampleProject);

  it("gleiche Bauteilzahl je Klasse, Räume ausgelassen", async () => {
    const { products, report } = await readIfc(bytesOf(ifc));
    expect(report.schema).toBe("IFC4");
    expect(report.parseErrors).toBe(0);
    expect(report.productsWithoutGeometry).toBe(0);
    expect(report.skippedItems).toEqual({});
    const got = new Map<string, number>();
    for (const p of products) got.set(p.ifcClass.toUpperCase(), (got.get(p.ifcClass.toUpperCase()) ?? 0) + 1);
    expect(got).toEqual(exportedCounts(ifc));
    const spaces = (ifc.match(/^#\d+=IFCSPACE\(/gm) ?? []).length;
    expect(report.skippedProducts.IfcSpace ?? 0).toBe(spaces);
    // Alle Körper geschlossen und aussen orientiert.
    for (const p of products) expect(vol(p), `${p.ifcClass} ${p.name}`).toBeGreaterThan(0);
    // Geschoss und GlobalId gesetzt.
    for (const p of products) {
      expect(p.globalId).toMatch(/^[0-9A-Za-z_$]{22}$/);
      expect(p.storey).toBeTruthy();
    }
  });

  it("Volumen je Wand = Volumen der Wand-Netze, je Decke = Fläche × Dicke", async () => {
    const { products } = await readIfc(bytesOf(ifc));
    // Wände: dieselben Ausschnitt-Netze wie der Export (Bänder je Wand).
    // [B5]: einfache Wände kommen als ungeschnittene Extrusion + IfcOpeningElement; der Import zieht
    // Öffnungen noch nicht ab ([B3] offen) → dort das Volumen der vollen Bänder.
    const bands = pickGeometry(sampleProject).walls;
    const cut = new Map<string, number>();
    const full = new Map<string, number>();
    const add = (m: Map<string, number>, id: string, v: number) => m.set(id, (m.get(id) ?? 0) + Math.abs(v));
    wallCutMeshes(bands).forEach((m, i) => add(cut, bands[i].wallId, volume(m.positions, m.indices)));
    wallCutMeshes(bands.map((b) => ({ ...b, holes: [] }))).forEach((m, i) => add(full, bands[i].wallId, volume(m.positions, m.indices)));
    const lines = new Map(ifc.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l] as const));
    const wallsGot = products.filter((p) => p.ifcClass === "IfcWall");
    expect(wallsGot.length).toBe(sampleProject.walls.length);
    let swept = 0;
    for (const wall of sampleProject.walls) {
      const p = wallsGot.find((g) => g.globalId === ifcGuid(`${sampleProject.id}/wall/${wall.id}`))!;
      expect(p, wall.id).toBeDefined();
      const wallLine = [...lines.values()].find((l) => l.includes(`=IFCWALL('${p.globalId}'`))!;
      const shape = lines.get(/,(#\d+),\$,\$\);$/.exec(wallLine)![1])!;
      const rep = lines.get(/\(\(?(#\d+)\)\);$/.exec(shape)![1])!;
      const isSwept = rep.includes("'SweptSolid'");
      if (isSwept) swept++;
      const expected = (isSwept ? full : cut).get(wall.id)!;
      expect(relClose(vol(p), expected, 1e-6), `${wall.id}: ${vol(p)} ≠ ${expected}`).toBe(true);
    }
    expect(swept).toBeGreaterThan(0);

    const slabsExpected = (sampleProject.ceilings ?? [])
      .filter((c) => c.outline.length >= 3)
      .map((c) => {
        const { zBottom, zTop } = ceilingVerticalExtent(sampleProject, c);
        return Math.abs(polygonArea(c.outline)) * Math.max(zTop - zBottom, 0.001);
      })
      .sort((a, b) => a - b);
    const slabsGot = products.filter((p) => p.ifcClass === "IfcSlab").map(vol).sort((a, b) => a - b);
    expect(slabsGot.length).toBe(slabsExpected.length);
    slabsGot.forEach((v, i) => expect(relClose(v, slabsExpected[i], 1e-6), `${v} ≠ ${slabsExpected[i]}`).toBe(true));
  });

  it("Kontext-Meshes: je Bauteil, Klasse als Ebene; Rückschub auf den Modell-Nullpunkt bei Georeferenz", async () => {
    const { products, report } = await readIfc(bytesOf(ifc));
    const meshes = ifcToImportedMeshes(products, "haus.ifc");
    expect(meshes.length).toBe(products.length);
    expect(new Set(meshes.map((m) => m.id)).size).toBe(meshes.length);
    expect(meshes.every((m) => m.type === "importedMesh" && m.positions.length >= 9 && m.indices.length >= 3)).toBe(true);
    expect(meshes.find((m) => m.layer === "IfcWall")).toBeTruthy();
    const grouped = ifcToImportedMeshes(products, "haus.ifc", { group: "class" });
    expect(grouped.length).toBeLessThan(meshes.length);
    expect(grouped.reduce((s, m) => s + m.indices.length, 0)).toBe(meshes.reduce((s, m) => s + m.indices.length, 0));
    // Datei in LV95 (Export mit Standort-Bezug) → zurück auf die lokalen Koordinaten.
    const origin = { e: 2_600_000, n: 1_200_000 };
    const shifted = products.map((p) => {
      const pos = new Float64Array(p.positions);
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] += origin.e;
        pos[i + 1] += origin.n;
      }
      return { ...p, positions: pos };
    });
    const back = ifcToImportedMeshes(shifted, "haus.ifc", { geoOrigin: origin });
    expect(back[0].positions[0]).toBeCloseTo(meshes[0].positions[0], 6);
    // Ohne Bezug in der Datei (lokal) bleibt alles, auch wenn das Projekt einen hat.
    const local = ifcToImportedMeshes(products, "haus.ifc", { geoOrigin: origin });
    expect(local[0].positions[0]).toBeCloseTo(meshes[0].positions[0], 9);
    const text = formatIfcReport(report, (k, v) => `${k}${JSON.stringify(v ?? {})}`);
    expect(text).toContain("ifc.import.done");
  });

  it("Unsinn ergibt einen Fehler, keinen Absturz des Moduls", async () => {
    await expect(readIfc(new Uint8Array())).rejects.toBeTruthy();
    await expect(readIfc(bytesOf("kein IFC"))).rejects.toBeTruthy();
    const broken = ifc.slice(0, Math.floor(ifc.length / 2));
    const r = await readIfc(bytesOf(broken));
    expect(r.products.length).toBeGreaterThanOrEqual(0);
    // Modul lebt noch.
    expect((await readIfc(bytesOf(ifc))).products.length).toBeGreaterThan(0);
  });
});

// ── Gegencheck mit ifcopenshell (ohne Python/ifcopenshell übersprungen) ─────────────────────────
const hasIfcOpenShell = spawnSync("python3", ["-c", "import ifcopenshell, ifcopenshell.geom, ifcopenshell.util.shape"]).status === 0;

interface OsProduct {
  class: string;
  triangles: number;
  volume: number;
}
function ifcopenshellProducts(file: string): Record<string, OsProduct> {
  const r = spawnSync("python3", ["scripts/ifc-import-compare.py", file], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Record<string, OsProduct>;
}

/** Vergleich je GlobalId; liefert Abweichungen als Text (leer = gleich). */
async function compare(file: string, rel: (p: IfcProduct) => number): Promise<string[]> {
  const ref = ifcopenshellProducts(file);
  const { products, report } = await readIfc(new Uint8Array(readFileSync(file)));
  // ifcopenshell 0.9 liefert bei manchen Dateien in mm (z. B. buildingSMART
  // „wall-with-opening-and-window.ifc", IfcSIUnit MILLI) die Geometrie unskaliert in Dateieinheiten,
  // obwohl `convert-back-units` aus ist; unser Import rechnet dort richtig in m (Rust-Test mit mm).
  const s3 = report.lengthScale ** 3;
  const problems: string[] = [];
  const ours = new Map(products.map((p) => [p.globalId, p]));
  for (const [gid, o] of Object.entries(ref)) {
    const p = ours.get(gid);
    if (!p) {
      problems.push(`${o.class} ${gid}: fehlt im Import`);
      continue;
    }
    if (p.ifcClass !== o.class) problems.push(`${gid}: Klasse ${p.ifcClass} ≠ ${o.class}`);
    const v = Math.abs(vol(p));
    const refV = Math.abs(o.volume);
    if (!relClose(v, refV, rel(p)) && !(s3 !== 1 && relClose(v, refV * s3, rel(p)))) problems.push(`${o.class} ${gid}: Volumen ${v} ≠ ${o.volume}`);
  }
  for (const p of products) if (!(p.globalId in ref)) problems.push(`${p.ifcClass} ${p.globalId}: nur im Import`);
  return problems;
}

describe.skipIf(!hasIfcOpenShell)("IFC-Import gegen ifcopenshell", { timeout: 120_000 }, () => {
  it("Demo-Haus: gleiche Bauteile, gleiches Volumen je Bauteil", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dossier-ifcimp-"));
    const file = join(dir, "demo-haus.ifc");
    writeFileSync(file, exportIfcSpf(sampleProject));
    const problems = await compare(file, () => 1e-6);
    expect(problems).toEqual([]);
  });

  it("mit runder Stütze (Kreis-Profil): Volumen bis auf Tessellierung", async () => {
    const col = {
      id: "S2", type: "column" as const, floorId: "eg", categoryCode: "50", position: { x: 1, y: 1 },
      profile: { kind: "round" as const, radius: 0.15 }, rotation: 0, height: 2.5,
    };
    const dir = mkdtempSync(join(tmpdir(), "dossier-ifcimp-"));
    const file = join(dir, "stuetze.ifc");
    writeFileSync(file, exportIfcSpf({ ...sampleProject, columns: [col] }));
    const problems = await compare(file, (p) => (p.ifcClass === "IfcColumn" ? 0.03 : 1e-6));
    expect(problems).toEqual([]);
  });

  // Freie Beispieldateien (z. B. github.com/buildingSMART/Sample-Test-Files, nicht im Repo, Lizenz
  // ungeklärt): DOSSIER_IFC_SAMPLES=<Verzeichnis> setzen.
  const samples = process.env.DOSSIER_IFC_SAMPLES;
  it.skipIf(!samples || !existsSync(samples))("Beispieldateien aus DOSSIER_IFC_SAMPLES", async () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ifc$/i.test(n)) files.push(p);
      }
    };
    walk(samples!);
    const all: string[] = [];
    for (const f of files) {
      // Gekrümmte Geometrie wird verschieden fein zerlegt → 3 %.
      for (const p of await compare(f, () => 0.03)) all.push(`${f}: ${p}`);
    }
    expect(all).toEqual([]);
  });
});
