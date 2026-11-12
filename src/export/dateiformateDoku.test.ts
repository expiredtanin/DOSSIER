// [C9] Hält `doc/DATEIFORMATE.md` ehrlich: jedes Export-Format der App muss dort vorkommen, sonst veraltet die
// Paritäts-Doku still. Quellen der Formatlisten: `EXPORT_FORMAT_EXT` (Direktexporte), `CadExportFormat`
// (DXF/DWG), die Handler der nativen Menüleiste. Gelesen wird der Quelltext, nicht die UI-Module
// (die ziehen React und Dialoge nach).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const doc = read("doc/DATEIFORMATE.md").toLowerCase();

/** Schlüssel eines Literals der Form `NAME ... = { key: "wert", … }`. */
function recordKeys(src: string, name: string): string[] {
  const m = new RegExp(`${name}[^=]*=\\s*\\{([^}]*)\\}`).exec(src);
  if (!m) throw new Error(`${name} nicht gefunden`);
  return [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]);
}

describe("doc/DATEIFORMATE.md", () => {
  it("nennt jedes Direkt-Exportformat des Export-Dialogs", () => {
    const keys = recordKeys(read("src/ui/ExportSaveDialog.tsx"), "EXPORT_FORMAT_EXT");
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const k of keys) expect(doc, `Format ${k} fehlt in der Doku`).toContain(k);
  });

  it("nennt DXF, DWG, Binär-DXF, PDF, SVG, Projektdatei und die Importe", () => {
    const cad = /CadExportFormat = ([^;]+);/.exec(read("src/export/exportDxf.ts"))![1];
    for (const f of [...cad.matchAll(/"(\w+)"/g)].map((x) => x[1])) {
      expect(doc, `CAD-Format ${f}`).toContain(f === "dxfbin" ? "binär-dxf" : f);
    }
    for (const w of [".obp", "pdf", "svg", "step", "gltf", "punktwolken", "swissbuildings3d", "osm", "bcf", "nicht exportiert"]) {
      expect(doc, w).toContain(w);
    }
  });

  it("nennt jeden Export-/Import-Menüpunkt der nativen Menüleiste", () => {
    const src = read("src/native/appMenu.ts");
    const handlers = [...src.matchAll(/^\s*on(?:Export|Import)(\w+)\??:/gm)].map((m) => m[1].toLowerCase());
    expect(handlers.length).toBeGreaterThan(8);
    const alias: Record<string, string> = {
      pdf: "pdf",
      dxf: "dxf",
      schedule: "csv",
      ifc: "ifc",
      obj: "obj",
      stl: "stl",
      glb: "glb",
      step: "step",
      pointcloud: "punktwolken",
      mesh: "obj",
    };
    for (const h of handlers) {
      expect(alias, `Menüpunkt ${h} ohne Zuordnung im Test`).toHaveProperty(h);
      expect(doc, `Menüpunkt ${h}`).toContain(alias[h]);
    }
  });
});
