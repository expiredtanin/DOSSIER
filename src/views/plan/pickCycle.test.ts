// [137] Wiederholter Klick an derselben Stelle schaltet durch die Objekte unter dem Cursor.
import { describe, expect, it } from "vitest";
import { cycleHint, plainCycleNext, selectionHas, type PlainCycle } from "./pickCycle";
import { EMPTY_SELECTION } from "../../state/selection";

const items = [
  { kind: "drawing" as const, id: "dim" },
  { kind: "site" as const, id: "sunStudy" },
  { kind: "context" as const, id: "terrain" },
];
const prev: PlainCycle = { x: 100, y: 100, t: 1000, planKey: "P", items, idx: 0 };
const sel = (o: Partial<typeof EMPTY_SELECTION>) => ({ ...EMPTY_SELECTION, ...o });

describe("[137] Klick-Zyklus", () => {
  it("zweiter Klick an derselben Stelle wählt das nächste Objekt, danach wieder das erste", () => {
    const s = sel({ drawings: ["dim"] });
    expect(plainCycleNext(prev, { x: 102, y: 99, t: 2000, planKey: "P" }, s)).toBe(1);
    expect(plainCycleNext({ ...prev, idx: 2 }, { x: 100, y: 100, t: 2000, planKey: "P" }, sel({ contextObjects: ["terrain"] }))).toBe(0);
  });

  it("kein Zyklus: andere Stelle, Doppelklick, anderer Plan, Auswahl inzwischen geändert, nur ein Treffer", () => {
    const s = sel({ drawings: ["dim"] });
    expect(plainCycleNext(prev, { x: 120, y: 100, t: 2000, planKey: "P" }, s)).toBeNull();
    expect(plainCycleNext(prev, { x: 100, y: 100, t: 1200, planKey: "P" }, s)).toBeNull();
    expect(plainCycleNext(prev, { x: 100, y: 100, t: 2000, planKey: "Q" }, s)).toBeNull();
    expect(plainCycleNext(prev, { x: 100, y: 100, t: 2000, planKey: "P" }, EMPTY_SELECTION)).toBeNull();
    expect(plainCycleNext({ ...prev, items: items.slice(0, 1) }, { x: 100, y: 100, t: 2000, planKey: "P" }, s)).toBeNull();
    expect(plainCycleNext(null, { x: 100, y: 100, t: 2000, planKey: "P" }, s)).toBeNull();
  });

  it("Auswahl-Abgleich je Art; Hinweis nur bei mehreren Treffern", () => {
    expect(selectionHas(sel({ site: ["sunStudy"] }), { kind: "site", id: "sunStudy" })).toBe(true);
    expect(selectionHas(sel({ sectionLines: ["s1"] }), { kind: "section", id: "s1" })).toBe(true);
    expect(selectionHas(sel({ walls: ["w"] }), { kind: "context", id: "w" })).toBe(false);
    expect(cycleHint(1, 0)).toBeNull();
    expect(cycleHint(3, 1)).toMatch(/2\/3/);
  });
});
