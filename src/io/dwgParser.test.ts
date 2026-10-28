// DWG-/Binär-DXF-Import über das Rust-Format-Modul (acadrust). Testdateien (`testdata/tile*`) sind
// aus `testdata/tile.dxf` (Quelle, cp1252) per acadrust geschrieben und bilden eine swissBUILDINGS3D-
// v3-„separated"-Kachel nach: Polyface-Meshes in Blöcken auf den Ebenen „Roof"/„Wall", per INSERT
// an LV95-Koordinaten platziert — früher nur über die Low-Level-API von LibreDWG lesbar
// (`extractPfaceMeshesByLayer`, gleiche Erwartungswerte wie die damaligen Tests).

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDwg } from "./dwgParser";
import { parseDxf } from "./dxfParser";
import type { DxfImportResult } from "./dxfParser";
import { loadFileioForTests } from "../engine/fileioWasm.testing";

beforeAll(loadFileioForTests);

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./testdata/${name}`, import.meta.url))));
const asBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function meshByLayer(res: DxfImportResult, layer: string) {
  const m = res.meshes.find((x) => x.layer === layer);
  expect(m, `Mesh auf Ebene ${layer}`).toBeDefined();
  return m!;
}

/** Gemeinsame Erwartungen für alle Varianten der Kachel. */
function checkTile(res: DxfImportResult) {
  expect(res.meshes.map((m) => m.layer).sort()).toEqual(["Roof", "Wall"]);
  const roof = meshByLayer(res, "Roof");
  // 3 Punkte, je um die INSERT-Einfügung verschoben (Skalierung 1, Drehung 0).
  expect(roof.positions).toEqual([
    2739334.4, 1176965.2, 1808.7,
    2739335.4, 1176965.2, 1809,
    2739334.4, 1176966.2, 1810,
  ]);
  // Ein Dreieck (Face 1,2,3 → 0-basiert 0,1,2).
  expect(roof.indices).toEqual([0, 1, 2]);
  // Viereck mit negativem (unsichtbare Kante) Index → zwei Dreiecke.
  expect(meshByLayer(res, "Wall").indices).toHaveLength(6);
  const cs = res.contours.flatMap((s) => s.contours);
  expect(cs).toHaveLength(2);
  // Bulge 1 zwischen (0,5) und (4,5): Halbkreis mit Radius 2 statt Sehne.
  const arc = cs.find((c) => c.pts.length > 2)!;
  for (const p of arc.pts) expect(Math.hypot(p.x - 2, p.y - 5)).toBeCloseTo(2, 9);
  expect(res.texts?.map((t) => t.text)).toEqual(["Gebäude"]);
  expect(res.layerColors?.Roof).toBe("#ff0000");
  expect(res.insUnits).toBe(6);
}

describe("parseDwg (acadrust)", () => {
  it("liest Polyface-Meshes aus Blöcken nach Ebene gruppiert, mit INSERT-Verschiebung (R2018)", async () => {
    const res = await parseDwg(asBuffer(fixture("tile-r2018.dwg")));
    checkTile(res);
    expect(res.meshes.map((m) => m.name).sort()).toEqual(["DWG-Mesh (Roof)", "DWG-Mesh (Wall)"]);
  });

  it("liest dieselbe Kachel als R2000-DWG", async () => {
    checkTile(await parseDwg(asBuffer(fixture("tile-r2000.dwg"))));
  });

  it("wirft bei kaputter DWG-Datei statt abzustürzen", async () => {
    const broken = fixture("tile-r2018.dwg").slice(0, 200);
    await expect(parseDwg(asBuffer(broken))).rejects.toThrow();
  });

  it("Layout-Auswahl wirkt auch bei DWG (unbekanntes Layout → Fehler mit Namen)", async () => {
    await expect(parseDwg(asBuffer(fixture("tile-r2018.dwg")), "gibt es nicht")).rejects.toThrow(/nicht gefunden/);
  });
});

describe("parseDxf — Binär-DXF und Code-Seite", () => {
  it("liest Binär-DXF gleich wie die ASCII-Quelle", () => {
    checkTile(parseDxf(fixture("tile-r2000-bin.dxf")));
  });

  it("ASCII-Quelle in cp1252 ($DWGCODEPAGE fehlt) — Umlaute bleiben erhalten", () => {
    checkTile(parseDxf(fixture("tile.dxf")));
  });
});

describe("parseDxf — Papierbereich-Layouts (Datei mit ezdxf erzeugt)", () => {
  it("listet Layouts mit Inhalt im Bericht; Modellraum bleibt Vorgabe", () => {
    const res = parseDxf(fixture("layouts.dxf"));
    expect(res.layouts).toEqual([{ name: "A3 Grundriss", entities: 2 }]);
    expect(res.layout).toBeUndefined();
    expect(res.recovered).toBe(false);
    expect(res.contours[0].contours).toHaveLength(1);
    expect(res.texts ?? []).toHaveLength(0);
  });

  it("liest ein Layout statt des Modellraums (Papier in mm → Meter)", () => {
    const res = parseDxf(fixture("layouts.dxf"), "", "A3 Grundriss");
    expect(res.layout).toBe("A3 Grundriss");
    const c = res.contours[0].contours[0];
    expect(c.pts[1].x).toBeCloseTo(0.42, 9);
    expect(res.texts!.map((t) => t.text)).toEqual(["Plankopf"]);
    expect(res.texts![0].height).toBeCloseTo(0.005, 9);
  });
});
