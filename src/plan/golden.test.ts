// [119] Referenz-Ausgaben: Plan (je Geschoss, 1:100 und 1:50), ein Schnitt, eine Ansicht und die
// 3D-Zusammenfassung beider Musterprojekte als lesbarer Digest (Zähler, Rahmen, Hash der gerundeten
// Zahlen) gegen eingecheckte Dateien in src/plan/__golden__. Gewollte Änderung übernehmen mit
//   npx vitest run -u src/plan/golden.test.ts
// und den Diff der Dateien im Commit ansehen. Zahlen sind gerundet (Plan 1e-3 m, 3D 1e-4 m).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { computeSection, generateElevationPlan, generatePlan, generateSectionPlan, planToSvgString, projectToModel3d, projectWithTemplate } from "../core";
import { sampleProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import type { Project } from "../model/types";

const roundNums = (s: string, dec: number): string =>
  s.replace(/-?\d+\.\d+(?:e-?\d+)?/g, (m) => {
    const v = Number(Number(m).toFixed(dec));
    return String(Object.is(v, -0) ? 0 : v);
  });
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

function svgDigest(svg: string): string {
  const s = roundNums(svg, 3);
  const tags = new Map<string, number>();
  for (const m of s.matchAll(/<([a-z]+)\b/g)) tags.set(m[1], (tags.get(m[1]) ?? 0) + 1);
  const viewBox = /viewBox="([^"]*)"/.exec(s)?.[1] ?? "-";
  const lines = [`viewBox ${viewBox}`, `bytes ${s.length}`];
  for (const [k, v] of [...tags].sort()) lines.push(`${k} ${v}`);
  lines.push(`hash ${sha(s)}`);
  return lines.join("\n") + "\n";
}

// Beliebige Struktur → Zähler je Feld (Länge von Listen/Puffern) + Hash der gerundeten Zahlen.
function structDigest(o: unknown): string {
  const lines: string[] = [];
  const h = createHash("sha256");
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "number") {
      h.update(path + "=" + Number(v.toFixed(4)) + ";");
    } else if (ArrayBuffer.isView(v)) {
      const a = Array.from(v as unknown as ArrayLike<number>);
      lines.push(`${path} [${a.length}]`);
      h.update(path + ":" + a.map((x) => Number(x.toFixed(4))).join(",") + ";");
    } else if (Array.isArray(v)) {
      lines.push(`${path} [${v.length}]`);
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const k of Object.keys(v).sort()) walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    } else {
      h.update(path + "=" + String(v) + ";");
    }
  };
  walk(o, "");
  // Elementweise Pfade (mit Index) nur im Hash, im Text nur die Feldzähler ohne Index
  const counts = new Map<string, number>();
  for (const l of lines) {
    const key = l.replace(/\[\d+\](?=[. ])/g, "[]");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort().map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ""}`).join("\n") + `\nhash ${h.digest("hex").slice(0, 16)}\n`;
}

const projects: [string, () => Project][] = [
  ["muster", () => sampleProject],
  ["komplex", buildComplexSampleProject],
];

for (const [name, make] of projects) {
  describe(`Golden ${name}`, () => {
    const p = make();
    const codes = new Set(p.layers.map((l) => l.code));

    for (const lvl of p.drawingLevels.filter((l) => l.kind === "floor")) {
      for (const scale of [100, 50]) {
        it(`Grundriss ${lvl.id} 1:${scale}`, async () => {
          const svg = planToSvgString(generatePlan(p, lvl.id, codes, undefined, "mittel", false, false, true, scale), { scaleDenominator: scale });
          await expect(svgDigest(svg)).toMatchFileSnapshot(`__golden__/${name}-grundriss-${lvl.id}-${scale}.txt`);
        });
      }
    }

    // [207] Situationsplan 1:500 (Ansichtsvorlage „Situation WBW") und Schwarzplan.
    for (const [id, file] of [["std-vt-situation-wbw", "situation"], ["std-vt-schwarzplan", "schwarzplan"]]) {
      it(`${file} 1:500`, async () => {
        const tpl = p.viewTemplates?.find((t) => t.id === id);
        if (!tpl) return;
        const tp = projectWithTemplate(p, "eg", tpl);
        const show = new Set([...codes].filter((c) => tpl.layerVisibility?.[c] !== false));
        const svg = planToSvgString(generatePlan(tp, "eg", show, undefined, tpl.detail ?? "grob", false, true, true, 500), { scaleDenominator: 500 });
        await expect(svgDigest(svg)).toMatchFileSnapshot(`__golden__/${name}-${file}-500.txt`);
      });
    }

    it("Schnitt", async () => {
      const sec = p.drawingLevels.find((l) => l.kind === "section");
      if (!sec) return;
      const out = await computeSection(p, sec);
      expect(out).toBeTruthy();
      const svg = planToSvgString(generateSectionPlan(out!, false, { visibleCodes: codes, hiddenLines: sec.hiddenLines, openings: true, scaleDenominator: 100 }), { scaleDenominator: 100 });
      await expect(svgDigest(svg)).toMatchFileSnapshot(`__golden__/${name}-schnitt-${sec.id}.txt`);
    }, 30_000);

    it("Ansicht", async () => {
      const el = p.drawingLevels.find((l) => l.kind === "elevation");
      if (!el) return;
      const plan = generateElevationPlan(p, el, { scaleDenominator: 100 });
      expect(plan).toBeTruthy();
      await expect(svgDigest(planToSvgString(plan!, { scaleDenominator: 100 }))).toMatchFileSnapshot(`__golden__/${name}-ansicht-${el.id}.txt`);
    });

    it("3D-Modell", async () => {
      await expect(structDigest(projectToModel3d(p))).toMatchFileSnapshot(`__golden__/${name}-model3d.txt`);
    });
  });
}
