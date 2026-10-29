// Messung des Import-Rückwegs (Kern → Leseansicht) mit einem synthetischen Kataster (150 000 Entities).
// Läuft nur mit `DOSSIER_BENCH=1` (dauert und braucht Speicher); Zahlen auf der Konsole.
import { beforeAll, describe, expect, it } from "vitest";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { parseDxf } from "../io/dxfParser";
import { sampleProject } from "../model/sampleProject";
import { ProjectDocument } from "./document";

/** Kataster-ähnliche DXF: je Zelle Parzelle (geschlossene LWPOLYLINE mit Bogen), Linie, Grenzpunkt, Text. */
function syntheticCadastre(cells: number): string {
  const out: string[] = ["0", "SECTION", "2", "ENTITIES"];
  const side = Math.ceil(Math.sqrt(cells));
  const e0 = 2600000;
  const n0 = 1200000;
  const ring = [[0, 0], [20, 0], [22, 10], [20, 20], [0, 20], [-2, 10]];
  for (let c = 0; c < cells; c++) {
    const x = e0 + (c % side) * 25;
    const y = n0 + Math.floor(c / side) * 25;
    const layer = ["LS_Parzelle", "BB_Gebaeude", "LS_Parzelle", "BB_Gebaeude", "EO_Wald"][c % 5];
    out.push("0", "LWPOLYLINE", "8", layer, "90", "6", "70", "1");
    ring.forEach(([px, py], k) => {
      out.push("10", (x + px).toFixed(3), "20", (y + py).toFixed(3));
      if (k === 2) out.push("42", "0.25");
    });
    out.push("0", "LINE", "8", "EO_Linie", "10", (x + 1).toFixed(3), "20", (y + 1).toFixed(3), "11", (x + 19).toFixed(3), "21", (y + 19).toFixed(3));
    out.push("0", "CIRCLE", "8", "GP_Punkt", "10", x.toFixed(3), "20", y.toFixed(3), "40", "0.15");
    out.push("0", "TEXT", "8", "NK_Text", "10", (x + 8).toFixed(3), "20", (y + 9).toFixed(3), "40", "1.5", "1", String(1000 + c));
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return out.join("\n");
}

const RUN = process.env.DOSSIER_BENCH === "1";

describe.runIf(RUN)("Import-Rückweg 150 000 Entities (Messung)", () => {
  beforeAll(loadFileioForTests);
  it("Import, Undo, Redo", () => {
    const parsed = parseDxf(syntheticCadastre(37500));
    const base = sampleProject;
    const doc = new ProjectDocument(base);
    const mem0 = process.memoryUsage().heapUsed;
    let t = performance.now();
    const r = doc.importDrawing(
      base,
      parsed.src,
      {
        target: { kind: "new", name: "Import" },
        categoryMode: "byLayer",
        activeCategoryCode: "20",
        importMeshes: true,
        levelNameTemplate: "Z {n}",
        parentName: "Import",
        dashStyleTemplate: "{pattern}",
      },
      Date.now(),
    );
    const tImport = performance.now() - t;
    if ("problems" in r) throw new Error(r.problems.join("; "));
    const mem1 = process.memoryUsage().heapUsed;
    t = performance.now();
    const u = doc.undo(r.project);
    const tUndo = performance.now() - t;
    t = performance.now();
    const re = u && doc.redo(u);
    const tRedo = performance.now() - t;
    console.log(
      `Import ${tImport.toFixed(0)} ms (${r.project.drawings2d.length} Zeichnungen, Heap +${((mem1 - mem0) / 1e6).toFixed(0)} MB), ` +
        `Undo ${tUndo.toFixed(0)} ms, Redo ${tRedo.toFixed(0)} ms`,
    );
    expect(JSON.parse(JSON.stringify(re))).toEqual(JSON.parse(doc.json()));
    doc.close();
  }, 600_000);
});
