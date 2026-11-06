// [115] Layout-Viewport zeigt Schnitt und Ansicht wie einen Grundriss (vorher nur Geschoss/Zeichnung).
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { collectVisibleCodes } from "../model/types";
import { generatePlan } from "./generatePlan";
import { snapshotMono, viewportLevelPlan } from "./viewportPlan";

const p = buildComplexSampleProject();
const codes = collectVisibleCodes(p.layers);

describe("viewportLevelPlan", () => {
  it("Schnitt: Schnittfläche + Koten, Grenzen über die Höhe", async () => {
    const plan = await viewportLevelPlan(p, "schnitt-a", codes, "mittel", 100);
    expect(plan.primitives.length).toBeGreaterThan(200);
    // Höhe (y) statt Grundriss-Tiefe: das Haus reicht über mehrere Geschosse.
    expect(plan.bounds.maxY - plan.bounds.minY).toBeGreaterThan(8);
  });

  it("Ansicht: Fassade", async () => {
    const plan = await viewportLevelPlan(p, "ansicht-sued", codes, "mittel", 100);
    expect(plan.primitives.length).toBeGreaterThan(100);
  });

  it("Geschoss: wie bisher generatePlan", async () => {
    const plan = await viewportLevelPlan(p, "eg", codes, "mittel", 100);
    expect(plan.primitives.length).toBe(generatePlan(p, "eg", codes, undefined, "mittel", false, true, true, 100).primitives.length);
  });

  // [140] Blatt und PDF folgen dem Tusche-Standard der App: keine bunten Farben (Ziegelrot …), ausser
  // die Vorlage des Ausschnitts wählt Farbe (`mono: false`).
  it("Tusche als Standard, Farbe nur auf Wunsch", async () => {
    const bunt = (plan: { primitives: unknown[] }) => {
      const hex = JSON.stringify(plan.primitives).match(/#[0-9a-fA-F]{6}\b/g) ?? [];
      return hex.filter((h) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        return Math.max(r, g, b) - Math.min(r, g, b) > 24;
      });
    };
    expect(bunt(await viewportLevelPlan(p, "ansicht-sued", codes, "mittel", 100))).toEqual([]);
    expect(bunt(await viewportLevelPlan(p, "ansicht-sued", codes, "mittel", 100, false, false)).length).toBeGreaterThan(0);
  });

  it("snapshotMono: Vorlage mit mono: false = farbig, sonst Tusche", () => {
    const q = { ...p, viewTemplates: [{ id: "f", name: "F", mono: false }, { id: "t", name: "T", mono: true }] };
    const snap = { templateId: undefined as string | undefined };
    expect(snapshotMono(q, snap)).toBe(true);
    expect(snapshotMono(q, { templateId: "f" })).toBe(false);
    expect(snapshotMono(q, { templateId: "t" })).toBe(true);
    expect(snapshotMono(q, { templateId: "weg" })).toBe(true);
  });

  it("unbekannte Ebene: leer, kein Fehler", async () => {
    const plan = await viewportLevelPlan(p, "gibt-es-nicht", codes, "mittel", 100);
    expect(plan.primitives.length).toBe(0);
  });
});

// [100] Deckenspiegel auf dem Blatt: derselbe Plan wie die Deckenspiegel-Ebene (Blattansicht und PDF rufen
// beide `viewportLevelPlan`), Strichstärken der geschnittenen Wände wie im Grundriss.
describe("viewportLevelPlan: Deckenspiegel ([100])", () => {
  const q = structuredClone(p);
  q.drawingLevels.push({ id: "ds-og", name: "Deckenspiegel OG", kind: "ceiling", visible: true, locked: false, ceilingOfId: "og" });
  type Prim = { kind: string; wallId?: string; ceilingId?: string; cls?: string; weightMm?: number; a?: { x: number; y: number }; b?: { x: number; y: number } };

  it("gleicher Inhalt wie die Ebene, auch im Druck", async () => {
    for (const forPrint of [false, true]) {
      const vp = await viewportLevelPlan(q, "ds-og", codes, "mittel", 50, forPrint);
      const own = generatePlan(q, "ds-og", codes, undefined, "mittel", false, false, true, 50, forPrint);
      expect(vp.primitives.length).toBe(own.primitives.length);
      expect(vp.bounds).toEqual(own.bounds);
      const prims = vp.primitives as Prim[];
      expect(prims.some((x) => x.wallId)).toBe(true);
      expect(prims.some((x) => x.ceilingId || x.cls === "roof-eaves")).toBe(true);
      expect(prims.some((x) => x.cls === "door-swing" || x.cls === "door-leaf")).toBe(false);
    }
  });

  it("Wand-Strichstärken wie im Grundriss (gleicher Massstab)", async () => {
    const ds = (await viewportLevelPlan(q, "ds-og", codes, "mittel", 50, true)).primitives as Prim[];
    const gr = (await viewportLevelPlan(q, "og", codes, "mittel", 50, true)).primitives as Prim[];
    const wallLine = (x: Prim) => x.kind === "line" && (x.cls === "wall-outline" || x.cls === "layer-joint");
    const key = (x: Prim) => `${x.cls}|${x.a?.x.toFixed(4)}|${x.a?.y.toFixed(4)}|${x.b?.x.toFixed(4)}|${x.b?.y.toFixed(4)}`;
    const widths = new Map(gr.filter(wallLine).map((x) => [key(x), x.weightMm]));
    const shared = ds.filter((x) => wallLine(x) && widths.has(key(x)));
    expect(shared.length).toBeGreaterThan(100);
    for (const x of shared) expect(x.weightMm, key(x)).toBe(widths.get(key(x)));
  });
});
