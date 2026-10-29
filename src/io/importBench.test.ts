// VORÜBERGEHEND ([K4] S4): Zeitmessung Kataster-Import alt (TS-Umwandlung + Commit) ↔ neu (Kern).
import "../engine/fileioWasm.setup";
import { describe, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyOps } from "../core/ops";
import type { CoreOp } from "../core/ops";
import { addItems, fieldOps } from "../core/opsBuild";
import { ProjectDocument } from "../core/document";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories } from "../model/types";
import { decodeImport, importDrawingFlat } from "./dxfParser";
import { countContours, distinctImportLayers, distinctLayers, planImportCategories } from "./dxfToDrawings";
import { buildDrawings } from "../ui/ImportDialog";
import { planDashLineStyles } from "./pdfLineStyles";
import { packChunks, importSummary } from "./importSource";
import { core } from "../engine/coreWasm";

const FX = process.env.DOSSIER_PARITY_FX ?? "";
const file = join(FX, "kataster150k.dxf");

describe.skipIf(!existsSync(file))("Zeitmessung Kataster 150k", { timeout: 600_000 }, () => {
  it("alt ↔ neu", () => {
    const bytes = new Uint8Array(readFileSync(file));
    const runs = Number(process.env.BENCH_RUNS ?? 3);
    for (let run = 0; run < runs; run++) {
      let t0 = performance.now();
      const flat = importDrawingFlat(bytes);
      const tParse = performance.now() - t0;
      if (process.env.BENCH_DUMP) {
        writeFileSync(join(FX, "k150.geom"), new Uint8Array(flat.geom.buffer, flat.geom.byteOffset, flat.geom.byteLength));
        writeFileSync(join(FX, "k150.strings.json"), JSON.stringify(flat.strings));
      }
      // alt
      t0 = performance.now();
      const parsed = decodeImport(flat.geom, flat.strings);
      void [countContours(parsed.contours), distinctLayers(parsed.contours)];
      const tOldDecode = performance.now() - t0;
      t0 = performance.now();
      const base = sampleProject;
      const levelId = "drawing-1";
      const ops: CoreOp[] = addItems("drawingLevels", [{ id: levelId, name: "K", kind: "drawing", visible: true, locked: false }]);
      let p = applyOps(base, ops);
      const plan = planImportCategories(distinctImportLayers(parsed.contours, parsed.texts ?? []), flattenCategories(base.layers), "Import", parsed.layerColors, parsed.layerLineWeights);
      const lops = fieldOps(p, "layers", [...p.layers, plan.parent!]);
      p = applyOps(p, lops);
      const dash = planDashLineStyles(parsed.layerDashes, base.lineStyles);
      const drawings = buildDrawings({ target: { kind: "existing", levelId }, categoryMode: "byLayer", importMeshes: false, placement: "origin", parsed }, levelId, base, "20", plan.codeByLayer, dash.styleByLayer);
      const all = [...ops, ...lops, ...addItems("drawings2d", drawings)];
      const tOldConvert = performance.now() - t0;
      const docOld = new ProjectDocument(base);
      t0 = performance.now();
      const rOld = docOld.commit(base, all, undefined, Date.now());
      const tOldCommit = performance.now() - t0;
      if ("problems" in rOld) throw new Error(rOld.problems[0]);
      docOld.close();
      // neu
      t0 = performance.now();
      const src = packChunks([flat]);
      const summary = importSummary(src);
      const tNewSummary = performance.now() - t0;
      const docNew = new ProjectDocument(base);
      t0 = performance.now();
      const r = docNew.importDrawing(base, src, { target: { kind: "new", name: "K" }, categoryMode: "byLayer", activeCategoryCode: "20", importMeshes: false, parentName: "Import" }, Date.now());
      const tNewImport = performance.now() - t0;
      if ("problems" in r) throw new Error(r.problems[0]);
      // Aufteilung: Kern-Aufruf, JSON.parse, applyOps.
      const docX = new ProjectDocument(base);
      void docX.json();
      t0 = performance.now();
      const out = core().doc_import_drawing(docX.id, src.geom, JSON.stringify(src.strings), JSON.stringify(src.source), JSON.stringify({ target: { kind: "new", name: "K" }, categoryMode: "byLayer", activeCategoryCode: "20", importMeshes: false, parentName: "Import" }), "", Date.now());
      const tCore = performance.now() - t0;
      t0 = performance.now();
      const parsedOut = JSON.parse(out) as { ops: CoreOp[] };
      const tParseOut = performance.now() - t0;
      t0 = performance.now();
      applyOps(base, parsedOut.ops);
      const tApply = performance.now() - t0;
      console.log(`  Kern ${tCore.toFixed(0)} ms (${(out.length / 1e6).toFixed(1)} MB JSON), JSON.parse ${tParseOut.toFixed(0)} ms, applyOps ${tApply.toFixed(0)} ms`);
      docX.close();
      docNew.close();
      const f = (x: number) => x.toFixed(0).padStart(5);
      console.log(
        `Lauf ${run}: ${summary.contours + summary.texts} Elemente | Lesen ${f(tParse)} ms | alt: Dekodieren ${f(tOldDecode)} + Umwandeln ${f(tOldConvert)} + Commit ${f(tOldCommit)} = ${f(tOldDecode + tOldConvert + tOldCommit)} ms | neu: Zusammenfassung ${f(tNewSummary)} + Import ${f(tNewImport)} = ${f(tNewSummary + tNewImport)} ms`,
      );
    }
  });
});
