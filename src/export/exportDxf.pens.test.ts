// [200] DXF-Export: Klassen-Stil (Tür-/Fenster-/Achslinien ohne eigene Farbe) und Textfarben kommen in AutoCAD-Werten an:
// Entitäten tragen True-Color (420) + nächste ACI (62) und Strichstärke (370), wenn sie vom Standard der Ebene abweichen.
// Gegengelesen mit ezdxf (Python, `scripts/validate-dxf.py`); ohne ezdxf übersprungen. In AutoCAD/BricsCAD nicht geprüft.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanDxf, buildPlanDxfBinary } from "./exportDxf";
import { sampleProject } from "../model/sampleProject";
import { generatePlan } from "../plan/generatePlan";
import { flattenCategories } from "../model/types";
import type { Project } from "../model/types";

const hasEzdxf = spawnSync("python3", ["-c", "import ezdxf"]).status === 0;

interface Ent {
  type: string;
  layer: string;
  trueColor?: number[] | null;
  aci?: number | null;
  lineweight?: number | null;
  text?: string;
}
interface Res {
  errors: string[];
  layers: Record<string, { lineweight: number; rgb: number[] | null }>;
  entities: Ent[];
  blocks: Record<string, { entities: Record<string, number>; pens: Array<{ type: string; trueColor: number[] | null; lineweight: number | null }> }>;
}

function ezdxf(name: string, bytes: string | Uint8Array): Res {
  const dir = mkdtempSync(join(tmpdir(), "dossier-dxf-"));
  const file = join(dir, `${name}.dxf`);
  writeFileSync(file, bytes);
  const r = spawnSync("python3", ["scripts/validate-dxf.py", file], { encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Res;
}

const hex = (c: string) => {
  const h = c.trim().replace(/^#/, "").toLowerCase();
  return h.length === 3 ? [...h].map((x) => x + x).join("") : h;
};
const rgbHex = (v: number[]) => v.map((x) => x.toString(16).padStart(2, "0")).join("");

/** Mit anderer Farbe/Stärke der Ebene „Türen/Fenster“, damit „nach Ebene“ nie zufällig stimmt. */
function projectWithOddDoorLayer(): Project {
  const odd = (l: Project["layers"][number]): Project["layers"][number] =>
    l.code === "21" ? { ...l, color: "#ff0000", lw: 0.7 } : { ...l, children: l.children?.map(odd) };
  const layers = sampleProject.layers.map(odd);
  return { ...sampleProject, layers };
}

describe.skipIf(!hasEzdxf)("[200] Klassen-Stil und Textfarbe im DXF", { timeout: 60_000 }, () => {
  const floor = sampleProject.drawingLevels.find((l) => l.kind === "floor")!.id;

  it("Texte tragen ihre Plan-Farbe (wirksam: eigene Farbe, sonst die der Ebene)", () => {
    const p = sampleProject;
    const plan = generatePlan(p, floor, new Set(flattenCategories(p.layers).map((l) => l.code)));
    const want = new Set(
      plan.primitives
        .filter((x) => x.kind === "text" || x.kind === "drawingText")
        .map((x) => hex((x as { color?: string }).color ?? "#000000")),
    );
    expect(want.size).toBeGreaterThan(0);
    for (const bytes of [buildPlanDxf(plan, p), buildPlanDxfBinary(plan, p)]) {
      const r = ezdxf("text", bytes);
      expect(r.errors).toEqual([]);
      const texts = r.entities.filter((e) => e.type === "TEXT");
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) {
        const eff = t.trueColor ?? r.layers[t.layer]?.rgb;
        expect(eff, `Text ${t.text} auf ${t.layer}`).toBeTruthy();
        expect(want.has(rgbHex(eff!)), `Text ${t.text}: ${rgbHex(eff!)} nicht in ${[...want]}`).toBe(true);
        expect(t.lineweight ?? null, "Texte tragen keine Strichstärke").toBeNull();
      }
    }
  });

  it("Tür-/Fensterblöcke: Klassenfarbe (#1a1a1a) und Strichstärke stehen an den Entitäten, nicht an der Ebene der Einfügung", () => {
    const p = projectWithOddDoorLayer();
    const plan = generatePlan(p, floor, new Set(flattenCategories(p.layers).map((l) => l.code)));
    for (const bytes of [buildPlanDxf(plan, p), buildPlanDxfBinary(plan, p)]) {
      const r = ezdxf("bloecke", bytes);
      expect(r.errors).toEqual([]);
      const blocks = Object.entries(r.blocks).filter(([n]) => /^(Tuer|Fenster|Wandoeffnung)_/.test(n));
      expect(blocks.length).toBeGreaterThan(0);
      for (const [name, b] of blocks) {
        const lines = b.pens.filter((x) => x.type === "LINE" || x.type === "ARC");
        expect(lines.length, name).toBeGreaterThan(0);
        for (const x of lines) {
          // Layer „21“ ist hier rot/0,7 mm: ein Block ohne eigene Werte würde so erscheinen.
          expect(x.trueColor, `${name}: Farbe`).toEqual([0x1a, 0x1a, 0x1a]);
          expect(x.lineweight, `${name}: Strichstärke`).not.toBeNull();
          expect(x.lineweight!, `${name}: Strichstärke`).toBeLessThan(70);
        }
      }
    }
  });
});
