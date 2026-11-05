/**
 * [58] Messung (nur mit `BENCH_3D=1`): Zeit von einer Wand-Änderung bis zu den Daten für render3d am
 * Grossgebäude — vorher das ganze Modell als JSON (`set_model`), jetzt nur geänderte Teile (`set_parts`).
 * Mit `BENCH_3D_OUT=<ordner>` schreibt der Test die JSON-Eingaben für den render3d-Bench
 * (`cargo test --release --lib scene::bench -- --ignored`, Umgebung `SCENE_BENCH_DIR`).
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { buildBigSampleProject } from "../model/sampleProjectBig";
import type { Project } from "../model/types";
import { withDocument } from "../core/document";
import { patchItem } from "../core/opsBuild";
import { projectToModel3d, projectToModel3dParts } from "../core";
import { Model3dPartsSync } from "./model3dPartsSync";

const run = process.env.BENCH_3D === "1";

describe.skipIf(!run)("3D-Viewer Teil-Updates: Messung Grossgebäude", () => {
  it("Wand-Änderung bis Daten für render3d", { timeout: 600_000 }, () => {
    let cur: Project = buildBigSampleProject();
    withDocument(cur, (doc) => {
      const sync = new Model3dPartsSync();
      const t0 = performance.now();
      const fullJson = JSON.stringify(projectToModel3d(cur));
      const tFull0 = performance.now() - t0;
      const t1 = performance.now();
      const first = sync.diff(projectToModel3dParts(cur)!)!;
      const tParts0 = performance.now() - t1;
      const out = process.env.BENCH_3D_OUT;
      const full: number[] = [];
      const inc: number[] = [];
      let last = first;
      let before = first;
      for (let i = 0; i < 6; i++) {
        // Stand vor der letzten Änderung als Ganzes (Ausgangslage des render3d-Benches).
        if (i === 5 && out) before = new Model3dPartsSync().diff(projectToModel3dParts(cur)!)!;
        const w = cur.walls[(i * 97) % cur.walls.length];
        const r = doc.commit(cur, patchItem(cur, "walls", w.id, { height: (w.height ?? 2.6) + 0.05 }), undefined, Date.now());
        if (!("project" in r)) throw new Error(r.problems.join("; "));
        cur = r.project;
        // Abwechselnd zuerst gemessen, damit der Kern-Cache keinen Weg bevorzugt.
        const measureFull = () => {
          const t = performance.now();
          JSON.stringify(projectToModel3d(cur));
          full.push(performance.now() - t);
        };
        const measureInc = () => {
          const t = performance.now();
          last = sync.diff(projectToModel3dParts(cur)!)!;
          inc.push(performance.now() - t);
        };
        if (i % 2) {
          measureFull();
          measureInc();
        } else {
          measureInc();
          measureFull();
        }
        expect(last.reset).toBe(false);
      }
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
      process.stderr.write(
        `[58] Grossgebäude (${cur.walls.length} Wände): kalt voll ${tFull0.toFixed(0)} ms (${(fullJson.length / 1e6).toFixed(1)} MB), ` +
          `kalt Teile ${tParts0.toFixed(0)} ms (${first.upserted} Teile); nach 1 Wand-Änderung: voll (projectToModel3d + JSON) ` +
          `${med(full).toFixed(1)} ms, Teile (+ Diff) ${med(inc).toFixed(1)} ms, ${last.upserted} Teile neu / ${last.removed} weg, ` +
          `${(last.json.length / 1e3).toFixed(0)} kB\n`,
      );
      if (out) {
        writeFileSync(`${out}/full.json`, fullJson);
        writeFileSync(`${out}/parts.json`, before.json);
        writeFileSync(`${out}/delta.json`, last.json);
      }
    });
  });
});
