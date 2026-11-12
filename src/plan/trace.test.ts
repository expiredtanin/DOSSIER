// [205] Pausfolie: Fassade über der Kern-Abfrage `tracePlan` (Rechnung in `src-tauri/core/src/plan/trace.rs`).
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { collectVisibleCodes } from "../model/layers";
import { generatePlan } from "./generatePlan";
import { defaultTrace, tracePlan, traceSourceAllowed, withTrace } from "./trace";
import { planCount } from "./planLazy";
import type { Primitive } from "./generatePlan";

const p = buildComplexSampleProject();
const codes = collectVisibleCodes(p.layers);
const level = (id: string) => p.drawingLevels.find((l) => l.id === id)!;
const ids = (q: Primitive) => Object.keys(q).filter((k) => k.endsWith("Id") && (q as unknown as Record<string, unknown>)[k] !== undefined);

describe("[205] tracePlan", () => {
  const eg = level("eg");
  const egPlan = generatePlan(p, "eg", codes);

  it("Geschoss hinter Geschoss: deckungsgleich, gefärbt, ohne Auswahl-Ids, Achsraster nicht doppelt", () => {
    const t = tracePlan(p, eg, { ...defaultTrace("og"), color: "#2060c0", opacity: 1 }, { visibleCodes: codes, activeBounds: egPlan.bounds });
    expect(t).not.toBeNull();
    const prims = t!.primitives;
    expect(prims.length).toBeGreaterThan(20);
    expect(prims.every((q) => ids(q).length === 0)).toBe(true);
    expect(prims.every((q) => !q.greyed)).toBe(true);
    // Linien in der gewählten Farbe; Raumstempel des OG ohne roomId.
    expect(prims.filter((q) => q.kind === "line").every((q) => q.kind === "line" && q.color === "#2060c0")).toBe(true);
    expect(prims.some((q) => q.kind === "text")).toBe(true);
    expect(prims.filter((q) => q.kind === "drawingText" && q.text === "A").length).toBe(0);
  });

  it("Schnitt A-A hinter dem EG: an der Schnittlinie aufgeklappt, jenseits des Grundrisses", () => {
    const t = tracePlan(p, eg, defaultTrace("schnitt-a"), { visibleCodes: codes, activeBounds: egPlan.bounds });
    expect(t).not.toBeNull();
    const b = t!.bounds;
    // Schnittlinie (3, −9) → (3, 21) mit directionSign 1: Blick nach −x (Links-Normale); die Höhe wächst in
    // Blickrichtung, der Schnitt liegt also links neben dem Grundriss.
    expect(b.maxX).toBeLessThan(egPlan.bounds.minX);
    expect(b.maxY - b.minY).toBeGreaterThan(5);
    expect(t!.primitives.every((q) => ids(q).length === 0)).toBe(true);
  });

  it("Verschieben verschiebt die ganze Pause um genau den Versatz", () => {
    const base = tracePlan(p, eg, defaultTrace("og"), { visibleCodes: codes })!;
    const moved = tracePlan(p, eg, { ...defaultTrace("og"), offset: { x: 5, y: -2 } }, { visibleCodes: codes })!;
    expect(moved.bounds.minX - base.bounds.minX).toBeCloseTo(5, 6);
    expect(moved.bounds.maxY - base.bounds.maxY).toBeCloseTo(-2, 6);
  });

  it("Grundriss hinter Schnitt: unter dem Schnitt (wie die frühere Grundriss-Unterlage)", () => {
    const sec = level("schnitt-a");
    const t = tracePlan(p, sec, defaultTrace("eg"), { visibleCodes: codes, activeBounds: { minX: 0, minY: -1, maxX: 30, maxY: 10 } })!;
    expect(t.bounds.maxY).toBeLessThanOrEqual(-1 - 1.5 + 1e-6);
  });

  it("aus, ohne Quelle, Quelle = aktive Ebene: keine Pause", () => {
    expect(tracePlan(p, eg, { ...defaultTrace("og"), show: false }, { visibleCodes: codes })).toBeNull();
    expect(tracePlan(p, eg, defaultTrace("gibt-es-nicht"), { visibleCodes: codes })).toBeNull();
    expect(tracePlan(p, eg, defaultTrace("eg"), { visibleCodes: codes })).toBeNull();
    expect(traceSourceAllowed(eg, eg)).toBe(false);
  });

  it("withTrace legt die Pause unter (bzw. über) den Plan, Ausmass und gedimmte Bereiche bleiben richtig", () => {
    const t = tracePlan(p, eg, defaultTrace("og"), { visibleCodes: codes })!;
    const n = planCount(t);
    const plan = { ...egPlan, greyedRanges: [[0, 2]] as Array<[number, number]> };
    const under = withTrace(plan, t);
    expect(planCount(under)).toBe(planCount(egPlan) + n);
    expect(under.bounds).toEqual(egPlan.bounds);
    expect(under.greyedRanges).toEqual([[n, n + 2]]);
    expect(ids(under.primitives[0])).toEqual([]);
    const over = withTrace(plan, t, true);
    expect(over.greyedRanges).toEqual([[0, 2]]);
    expect(withTrace(egPlan, null)).toBe(egPlan);
  });
});
