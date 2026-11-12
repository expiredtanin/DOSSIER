/**
 * [214] Messung der 3D-Kette je Szene (nur mit `BENCH_3D=1`): was der Viewer bei jeder Modelländerung im Kern/TS tut
 * (`useWasm3dRenderer.updateModel`: Teile + Abgleich, 2D-Spuren, zulässige Hülle, Geisterschicht, Flächenmuster), für
 * Musterhaus komplex, Grossgebäude (1832 Wände) und einen grossen Kontext (Gelände-Netz + viele Kontextgebäude).
 *
 * Mit `BENCH_3D_OUT=<ordner>` schreibt der Test je Szene die Eingaben für die Engine-Messung
 * (`render_png --bench <ordner>/<szene>`, `src-tauri/render3d/src/bin/bench3d/mod.rs`): `parts.json` (Stand vor der
 * letzten Änderung, wie `set_parts` ihn beim ersten Mal bekommt), `delta.json` (eine Wand verschoben), `drawing.f32`,
 * `pattern.f32`, `ghost.json` (Geisterschicht: alle Geschosse ausser dem untersten grau).
 *
 *   BENCH_3D=1 BENCH_3D_OUT=/tmp/b3d npx vitest run src/viewport/render3d.bench.test.ts
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildBigSampleProject } from "../model/sampleProjectBig";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import type { ContextObject, Project } from "../model/types";
import { withDocument } from "../core/document";
import { patchItem } from "../core/opsBuild";
import { emitDrawingLineVerts, emitSurfacePatternLines, ghostFilter3d, projectToModel3d, projectToModel3dParts } from "../core";
import { siteEnvelope3d } from "../core/extra";
import type { Filter3d } from "../plan/toWalls3d";
import { Model3dPartsSync } from "./model3dPartsSync";
import { GhostLayerSync, ghostSignature } from "./ghostSync";

const run = process.env.BENCH_3D === "1";
const GHOST_EMPTY = '{"reset":true,"remove":[],"upsert":[]}';

/** Gelände-Gitter (`n`×`n` Felder à `step` m, sanfte Wellen) und `count` Kontextgebäude (Quader mit Satteldach) rundum. */
export function withLargeContext(p: Project, n = 250, step = 2, count = 800): Project {
  const positions: number[] = [];
  const indices: number[] = [];
  const x0 = -(n * step) / 2 + 8;
  const y0 = -(n * step) / 2 + 5;
  const z = (x: number, y: number) => -1 + 0.8 * Math.sin(x / 23) + 0.6 * Math.cos(y / 31);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(x0 + i * step, y0 + j * step, z(x0 + i * step, y0 + j * step));
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  const ctx: ContextObject[] = [{ type: "terrainMesh", id: "bench-gelaende", name: "Gelände (Messung)", categoryCode: "02", positions, indices }];
  // Gebäude auf Ringen um das Haus, ausserhalb von 40 m.
  for (let k = 0; k < count; k++) {
    const r = Math.sqrt(1600 + k * 60);
    const a = k * 2.399963;
    const cx = 8 + r * Math.cos(a);
    const cy = 5 + r * Math.sin(a);
    if (Math.abs(cx - x0 - (n * step) / 2) > (n * step) / 2 - 10 || Math.abs(cy - y0 - (n * step) / 2) > (n * step) / 2 - 10) continue;
    const w = 6 + (k % 5);
    const d = 8 + (k % 3);
    const h = 6 + (k % 4) * 3;
    const b = z(cx, cy) - 0.5;
    const pts = [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]];
    const pos: number[] = [];
    for (const [x, y] of pts) pos.push(x, y, b);
    for (const [x, y] of pts) pos.push(x, y, b + h);
    pos.push(cx, cy - d / 2, b + h + 3, cx, cy + d / 2, b + h + 3);
    const idx = [0, 2, 1, 0, 3, 2, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
      4, 5, 8, 5, 6, 9, 5, 9, 8, 6, 7, 9, 7, 4, 8, 7, 8, 9];
    ctx.push({ type: "importedMesh", id: `bench-haus-${k}`, name: `Nachbar ${k}`, categoryCode: "12", positions: pos, indices: idx });
  }
  return { ...p, context: [...(p.context ?? []), ...ctx] };
}

const scenes: Array<[string, () => Project]> = [
  ["komplex", buildComplexSampleProject],
  ["gross", () => buildBigSampleProject()],
  ["kontext", () => withLargeContext(buildComplexSampleProject())],
];

const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0;

describe.skipIf(!run)("[214] 3D-Kette: Messung je Szene", () => {
  for (const [name, build] of scenes) {
    it(name, { timeout: 900_000 }, () => {
      let cur = build();
      const floors = cur.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId);
      // Zeichnungsebenen-Modus: aktives Geschoss = unterstes mit Wänden, die übrigen grau.
      const active = floors.find((f) => cur.walls.some((w) => w.floorId === f.id))!;
      const hide: Filter3d = { greyFloors: floors.filter((f) => f.id !== active.id).map((f) => f.id) };
      const ghost = ghostFilter3d(hide)!;
      const rows: Array<[string, string]> = [];
      withDocument(cur, (doc) => {
        const sync = new Model3dPartsSync();
        const t0 = performance.now();
        const first = sync.diff(projectToModel3dParts(cur, { detail: "mittel", voids: true, hide })!)!;
        rows.push(["Kern kalt: Teile + Abgleich", `${(performance.now() - t0).toFixed(0)} ms, ${first.upserted} Teile, ${(first.json.length / 1e6).toFixed(1)} MB JSON`]);
        let ghostSig: string | null = null;
        const ghostSync = new GhostLayerSync();
        const ghostFirst = ghostSync.partsUpdate(projectToModel3dParts(cur, { detail: "mittel", voids: true, hide: ghost }));
        // Ein Durchgang wie `updateModel`; liefert die Zeiten je Schritt.
        const update = () => {
          const t: Record<string, number> = {};
          let s = performance.now();
          const parts = projectToModel3dParts(cur, { detail: "mittel", voids: true, hide })!;
          t.parts = performance.now() - s;
          s = performance.now();
          const d = sync.diff(parts);
          t.diff = performance.now() - s;
          s = performance.now();
          const drawing = emitDrawingLineVerts(cur, 0, hide);
          t.drawing = performance.now() - s;
          s = performance.now();
          siteEnvelope3d(cur);
          t.envelope = performance.now() - s;
          s = performance.now();
          const json = JSON.stringify(projectToModel3d(cur, { detail: "mittel", voids: true, hide: ghost }));
          const gd = emitDrawingLineVerts(cur, 0, ghost);
          const gp = emitSurfacePatternLines(cur, 0, ghost);
          const sig = ghostSignature(json, gd, gp);
          const ghostChanged = sig !== ghostSig;
          ghostSig = sig;
          t.ghostFull = performance.now() - s;
          // [214] Teile-Weg wie `useWasm3dRenderer` jetzt: Teile + Abgleich, Spuren/Muster mit Prüfsumme.
          s = performance.now();
          const ghostJson = ghostSync.partsUpdate(projectToModel3dParts(cur, { detail: "mittel", voids: true, hide: ghost }));
          ghostSync.linesChanged(emitDrawingLineVerts(cur, 0, ghost), emitSurfacePatternLines(cur, 0, ghost));
          t.ghost = performance.now() - s;
          s = performance.now();
          const pattern = emitSurfacePatternLines(cur, 0, hide);
          t.pattern = performance.now() - s;
          return { t, d, drawing, pattern, json, ghostChanged, ghostJson };
        };
        let last = update();
        const times: Record<string, number[]> = {};
        let before = first;
        const movable = cur.walls.filter((w) => w.floorId === active.id);
        for (let i = 0; i < 7; i++) {
          if (i === 6) before = new Model3dPartsSync().diff(projectToModel3dParts(cur, { detail: "mittel", voids: true, hide })!)!;
          const w = movable[(i * 7) % movable.length];
          const dx = 0.01 * (i + 1);
          const r = doc.commit(cur, patchItem(cur, "walls", w.id, { start: { x: w.start.x + dx, y: w.start.y }, end: { x: w.end.x + dx, y: w.end.y } }), undefined, Date.now());
          if (!("project" in r)) throw new Error(r.problems.join("; "));
          cur = r.project;
          last = update();
          for (const [k, v] of Object.entries(last.t)) (times[k] ??= []).push(v);
          expect(last.d?.reset).toBe(false);
        }
        const total = Object.entries(times).filter(([k]) => k !== "ghostFull").reduce((acc, [, a]) => acc + med(a), 0);
        rows.push(["Änderung: Teile (Kern)", `${med(times.parts).toFixed(1)} ms`]);
        rows.push(["Änderung: Abgleich (Model3dPartsSync)", `${med(times.diff).toFixed(1)} ms (${last.d?.upserted} Teile neu, ${last.d?.removed} weg, ${((last.d?.json.length ?? 0) / 1e3).toFixed(0)} kB)`]);
        rows.push(["Änderung: 2D-Spuren", `${med(times.drawing).toFixed(1)} ms (${last.drawing.length} f32)`]);
        rows.push(["Änderung: zulässige Hülle", `${med(times.envelope).toFixed(1)} ms`]);
        rows.push(["Änderung: Geisterschicht ganz (Modell + JSON + Prüfsumme)", `${med(times.ghostFull).toFixed(1)} ms (${(last.json.length / 1e6).toFixed(2)} MB, neu gesetzt: ${last.ghostChanged})`]);
        rows.push(["Änderung: Geisterschicht als Teile [214]", `${med(times.ghost).toFixed(1)} ms (Update: ${last.ghostJson ? last.ghostJson.length + " Zeichen" : "keins"})`]);
        rows.push(["Änderung: Flächenmuster", `${med(times.pattern).toFixed(1)} ms (${last.pattern.length} f32)`]);
        rows.push(["Änderung: Summe Kern/TS (Geisterschicht als Teile)", `${total.toFixed(1)} ms`]);
        const out = process.env.BENCH_3D_OUT;
        if (out) {
          const dir = `${out}/${name}`;
          mkdirSync(dir, { recursive: true });
          writeFileSync(`${dir}/parts.json`, before.json);
          writeFileSync(`${dir}/delta.json`, last.d!.json);
          writeFileSync(`${dir}/drawing.f32`, new Uint8Array(last.drawing.buffer, last.drawing.byteOffset, last.drawing.byteLength));
          writeFileSync(`${dir}/pattern.f32`, new Uint8Array(last.pattern.buffer, last.pattern.byteOffset, last.pattern.byteLength));
          writeFileSync(`${dir}/ghost.json`, last.json);
          writeFileSync(`${dir}/ghost-parts.json`, ghostFirst ?? GHOST_EMPTY);
        }
      });
      process.stderr.write(`\n[214] ${name} (${cur.walls.length} Wände, ${cur.context?.length ?? 0} Kontext-Objekte)\n` + rows.map(([k, v]) => `  ${k.padEnd(52)} ${v}`).join("\n") + "\n");
    });
  }
});
