// IFC-Import ([B3]): Rundreise mit dem eigenen IFC-Export und Gegencheck mit ifcopenshell.
//
// Toleranzen: Wände/Dächer sind im Export Dreiecksnetze (IfcTriangulatedFaceSet) und Decken
// Extrusionen von Polygonen — beides ohne Tessellierung, das Volumen muss bis auf die
// Zahlenformatierung des Exports (R(), ~1e-9 m) stimmen: relativ 1e-6. Gegen ifcopenshell gilt
// dasselbe für ebene Geometrie; Kreise/Bögen werden von beiden Seiten verschieden fein zerlegt
// (hier Sehnenfehler ≤ 2 mm) → dort relativ 3 %.

import "../engine/fileioWasm.setup";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { formatIfcReport, handleIfcWorkerRequest, ifcToImportedMeshes, readIfc, type IfcProduct, type IfcWorkerRequest } from "./ifcImport";

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
    const { products, report } = await readIfc(bytesOf(ifc));
    // Wände: dieselben Ausschnitt-Netze wie der Export (Bänder je Wand). [B5] schreibt einfache Wände als
    // ungeschnittene Extrusion + IfcOpeningElement, der Import zieht die Öffnungen ab ([B3]) → bei allen
    // Wänden das ausgeschnittene Volumen.
    const bands = pickGeometry(sampleProject).walls;
    const cut = new Map<string, number>();
    const add = (m: Map<string, number>, id: string, v: number) => m.set(id, (m.get(id) ?? 0) + Math.abs(v));
    wallCutMeshes(bands).forEach((m, i) => add(cut, bands[i].wallId, volume(m.positions, m.indices)));
    const lines = new Map(ifc.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l] as const));
    const wallsGot = products.filter((p) => p.ifcClass === "IfcWall");
    expect(wallsGot.length).toBe(sampleProject.walls.length);
    let swept = 0;
    for (const wall of sampleProject.walls) {
      const p = wallsGot.find((g) => g.globalId === ifcGuid(`${sampleProject.id}/wall/${wall.id}`))!;
      expect(p, wall.id).toBeDefined();
      const wallLine = [...lines.values()].find((l) => l.includes(`=IFCWALL('${p.globalId}'`))!;
      const shape = lines.get(/,(#\d+),\$,\$\);$/.exec(wallLine)![1])!;
      const rep = lines.get(/(#\d+)\)\);$/.exec(shape)![1])!; // letzte Darstellung = Body (davor ggf. Axis)
      const isSwept = rep.includes("'SweptSolid'");
      if (isSwept) swept++;
      const expected = cut.get(wall.id)!;
      expect(relClose(vol(p), expected, 1e-6), `${wall.id}: ${vol(p)} ≠ ${expected}`).toBe(true);
    }
    expect(swept).toBeGreaterThan(0);
    expect(report.voidsApplied).toBeGreaterThan(0);
    expect(report.voidsIgnored).toBe(0);
    expect(report.simplifiedBooleans).toBe(0);

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

// Synthetische Fälle (`testdata/ifc-geometry-cases.ifc`, von Hand erzeugt, ein Bauteil je Fall): Wände
// mit Öffnung (tiefer als die Wand bzw. bündig), Halbräume (.T./.F., polygonal begrenzt), Boolean
// UNION/INTERSECTION/DIFFERENCE, Rotation 90°/360°, Rohr (hohl, dünn), Sweep mit fester Referenz und
// auf Ebene, Bogen-Leitkurve. Sollwerte von Hand; ifcopenshell bestätigt sie unten.
const casesFile = new URL("./testdata/ifc-geometry-cases.ifc", import.meta.url);
// Freiform-Fälle ([25], `testdata/ifc-freeform-cases.ifc`, von Hand erzeugt): IfcAdvancedBrep mit Zylinder,
// Kugel, bilinearen und rationalen B-Spline-Flächen, B-Spline-Profil, Rohre mit StartParam/EndParam.
const freeformFile = new URL("./testdata/ifc-freeform-cases.ifc", import.meta.url);

describe("IFC-Import: Öffnungen, Boolesche Körper, Rotation, Sweeps", () => {
  it("alle Fälle gelesen, Volumen von Hand", async () => {
    const { products, report } = await readIfc(new Uint8Array(readFileSync(casesFile)));
    expect(report.skippedItems).toEqual({});
    expect(report.simplifiedBooleans).toBe(0);
    expect(report.voidsApplied).toBe(2);
    expect(report.voidsIgnored).toBe(0);
    expect(report.skippedProducts.IfcOpeningElement).toBe(2);
    const v = products.map((p) => [p.ifcClass, Math.round(vol(p) * 1e4) / 1e4] as const);
    const pi = Math.PI;
    const want: Array<[string, number, number]> = [
      ["IfcWall", 3.6 - 0.3 * 2, 1e-6],
      ["IfcWall", 3.6 - 0.3 * 2, 1e-6],
      ["IfcWall", 8 * 0.3, 1e-6],
      ["IfcWall", 12 * 0.3, 1e-6],
      ["IfcWall", 15 * 0.3, 1e-6],
      ["IfcBuildingElementProxy", 1.75, 1e-6],
      ["IfcBuildingElementProxy", 0.25, 1e-6],
      ["IfcBuildingElementProxy", 0.75, 1e-6],
      ["IfcMember", (pi / 2) * 2.5, 0.01],
      ["IfcMember", 2 * pi * 2.5, 0.01],
      ["IfcReinforcingBar", pi * (0.01 - 0.0025) * 9, 0.03],
      ["IfcReinforcingBar", pi * 0.006 ** 2 * 9, 0.03],
      ["IfcRailing", 0.08 * 7.1, 1e-6],
      ["IfcRailing", 0.08 * 7.1, 1e-6],
      ["IfcRailing", pi * 0.01 * pi, 0.03],
    ];
    expect(products.length).toBe(want.length);
    want.forEach(([cls, w, rel], i) => {
      expect(products[i].ifcClass).toBe(cls);
      expect(relClose(vol(products[i]), w, rel), `${i} ${cls}: ${vol(products[i])} ≠ ${w} (${JSON.stringify(v[i])})`).toBe(true);
    });
  });

  it("Freiform-Fälle: alle gelesen, Volumen von Hand", async () => {
    const { products, report } = await readIfc(new Uint8Array(readFileSync(freeformFile)));
    expect(report.skippedItems).toEqual({});
    const pi = Math.PI;
    const want: Array<[string, number]> = [
      ["IfcColumn", pi * 0.25 * 2],
      ["IfcBuildingElementProxy", (2 / 3) * pi],
      ["IfcColumn", pi * 0.25],
      ["IfcBuildingElementProxy", 2 / 3],
      ["IfcColumn", pi * 0.25],
      ["IfcPipeSegment", pi * 0.01 * 3.5],
      ["IfcPipeSegment", pi * 0.01 * pi],
      ["IfcPipeSegment", pi * 0.01 * 2 * pi],
    ];
    expect(products.map((p) => p.ifcClass)).toEqual(want.map((w) => w[0]));
    want.forEach(([, w], i) => expect(relClose(vol(products[i]), w, 0.02), `${i}: ${vol(products[i])} ≠ ${w}`).toBe(true));
  });

  describe("Laden im Web-Worker", () => {
    afterEach(() => vi.unstubAllGlobals());

    /** Nachbau eines Workers im selben Thread: gleiche Nachrichten, gleiche Übertragung. */
    class FakeWorker {
      static started = 0;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(url: URL) {
        expect(String(url)).toContain("ifcImport.worker");
        FakeWorker.started++;
      }
      postMessage(req: IfcWorkerRequest, transfer: Transferable[]) {
        expect(transfer).toEqual([req.data]);
        void handleIfcWorkerRequest(req).then(({ res, transfer: back }) => {
          if (res.type === "result") expect(back).toEqual([res.flat.positions.buffer, res.flat.indices.buffer]);
          this.onmessage?.({ data: res });
        });
      }
      terminate() {}
    }

    it("liest über den Worker, Aufrufer behält seine Bytes; Fehler kommen als Ablehnung zurück", async () => {
      vi.stubGlobal("Worker", FakeWorker);
      const bytes = new Uint8Array(readFileSync(casesFile));
      const before = FakeWorker.started;
      const { products, report } = await readIfc(bytes);
      expect(FakeWorker.started).toBe(before + 1);
      expect(products.length).toBe(15);
      expect(report.voidsApplied).toBe(2);
      expect(bytes.byteLength).toBeGreaterThan(0);
      await expect(readIfc(bytesOf("kein IFC"))).rejects.toThrow();
      const bad = await handleIfcWorkerRequest({ type: "nonsense" } as unknown as IfcWorkerRequest);
      expect(bad.res.type).toBe("error");
    });

    it("startet der Worker nicht, wird im aufrufenden Thread gelesen", async () => {
      vi.stubGlobal(
        "Worker",
        class {
          onerror: ((e: unknown) => void) | null = null;
          postMessage() {
            setTimeout(() => this.onerror?.(new Error("kein Worker")), 0);
          }
          terminate() {}
        },
      );
      const { products } = await readIfc(new Uint8Array(readFileSync(casesFile)));
      expect(products.length).toBe(15);
    });
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

  it("synthetische Fälle: Öffnungen, Halbräume, Booleans, Rotation, Sweeps", async () => {
    // Rohre/Bögen werden verschieden fein zerlegt → 3 %.
    const problems = await compare(casesFile.pathname, () => 0.03);
    expect(problems).toEqual([]);
  });

  it("Freiform-Fälle: Advanced Brep (Zylinder, B-Spline-Flächen), B-Spline-Profil und -Leitkurve", async () => {
    // ifcopenshell 0.9 liefert die nahtlose Halbkugel nicht (Volumen 0) und übergeht StartParam/EndParam
    // der Rohre (IfcOpenShell zieht absichtlich die ganze Leitkurve); diese prüft der Rust-Test von Hand.
    const handOnly = ["2dome", "6pipeparams", "7pipearc"];
    const problems = await compare(freeformFile.pathname, () => 0.03);
    expect(problems.filter((p) => !handOnly.some((h) => p.includes(h)))).toEqual([]);
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
