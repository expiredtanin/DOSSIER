/**
 * `groupActions.ts` — reine Gruppen-Logik (Mitgliedschaft/Verschachtelung/
 * Erzeugen/Auflösen), Vectorworks-artig: Cmd+G fasst die Auswahl zusammen,
 * Doppelklick betritt eine Gruppe (Isolation), alles ausserhalb wird
 * gedimmt/gesperrt.
 */

import { describe, it, expect } from "vitest";
import {
  applyGroupDimming,
  containingGroupId,
  expandToGroups,
  groupSelection,
  isInsideActiveGroup,
  topLevelGroups,
  transitiveMembership,
  ungroup,
} from "./groupActions";
import type { Primitive } from "../plan/generatePlan/shared";
import type { Group, Project } from "../model/types";

const EMPTY_MEM = {
  wallIds: [] as string[],
  drawingIds: [] as string[],
  ceilingIds: [] as string[],
  roomIds: [] as string[],
  stairIds: [] as string[],
  columnIds: [] as string[],
  roofIds: [] as string[],
  openingIds: [] as string[],
};

function project(groups: Group[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [],
    layers: [],
    walls: [],
    doors: [],
    drawings2d: [],
    groups,
  };
}

describe("groupSelection", () => {
  it("erzeugt eine Gruppe aus ≥2 gewählten Elementen", () => {
    const p = project([]);
    const res = groupSelection(p, { ...EMPTY_MEM, wallIds: ["w1", "w2"] }, []);
    expect(res).not.toBeNull();
    expect(res!.project.groups).toHaveLength(1);
    expect(res!.project.groups![0]).toMatchObject({ wallIds: ["w1", "w2"], groupIds: [] });
  });

  it("weniger als 2 Elemente gruppiert nicht (Vectorworks-Konvention)", () => {
    const p = project([]);
    expect(groupSelection(p, { ...EMPTY_MEM, wallIds: ["w1"] }, [])).toBeNull();
    expect(groupSelection(p, EMPTY_MEM, [])).toBeNull();
  });

  it("bereits gewählte Gruppen werden als Untergruppen verschachtelt, nicht vermischt", () => {
    const inner: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
    const p = project([inner]);
    const res = groupSelection(p, { ...EMPTY_MEM, wallIds: ["w2"] }, ["g1"]);
    expect(res).not.toBeNull();
    const outer = res!.project.groups!.find((g) => g.id === res!.groupId)!;
    expect(outer.wallIds).toEqual(["w2"]);
    expect(outer.groupIds).toEqual(["g1"]);
  });
});

describe("transitiveMembership", () => {
  it("löst verschachtelte Gruppen rekursiv auf", () => {
    const inner: Group = { id: "g1", wallIds: ["w1"], drawingIds: ["d1"], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
    const outer: Group = { id: "g2", wallIds: ["w2"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1"] };
    const p = project([inner, outer]);
    const mem = transitiveMembership(p, "g2");
    expect(mem.wallIds.sort()).toEqual(["w1", "w2"]);
    expect(mem.drawingIds).toEqual(["d1"]);
  });

  it("unbekannte Gruppen-ID liefert leere Mitgliedschaft", () => {
    const mem = transitiveMembership(project([]), "missing");
    expect(mem).toEqual(EMPTY_MEM);
  });
});

describe("topLevelGroups / containingGroupId", () => {
  const inner: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
  const outer: Group = { id: "g2", wallIds: ["w2"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1"] };
  const p = project([inner, outer]);

  it("topLevelGroups schliesst verschachtelte Untergruppen aus", () => {
    expect(topLevelGroups(p).map((g) => g.id)).toEqual(["g2"]);
  });

  it("ohne Isolation (groupPath leer): findet nur die ÄUSSERE Gruppe für ein Element in g1", () => {
    expect(containingGroupId(p, "wallIds", "w1", [])).toBe("g2");
  });

  it("innerhalb von g2 isoliert: findet g1 (direkte Untergruppe) für w1", () => {
    expect(containingGroupId(p, "wallIds", "w1", ["g2"])).toBe("g1");
  });

  it("innerhalb von g2 isoliert: w2 (direktes Mitglied von g2 selbst) gehört zu KEINER Gruppe mehr (einzeln editierbar)", () => {
    expect(containingGroupId(p, "wallIds", "w2", ["g2"])).toBeNull();
  });

  it("Element ausserhalb jeder Gruppe liefert null", () => {
    expect(containingGroupId(p, "wallIds", "w999", [])).toBeNull();
  });
});

describe("isInsideActiveGroup", () => {
  const inner: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
  const outer: Group = { id: "g2", wallIds: ["w2"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1"] };
  const p = project([inner, outer]);

  it("ohne Isolation ist alles editierbar", () => {
    expect(isInsideActiveGroup(p, "wallIds", "w1", [])).toBe(true);
    expect(isInsideActiveGroup(p, "wallIds", "irgendwas", [])).toBe(true);
  });

  it("isoliert in g2: w2 und (transitiv über g1) w1 sind editierbar", () => {
    expect(isInsideActiveGroup(p, "wallIds", "w2", ["g2"])).toBe(true);
    expect(isInsideActiveGroup(p, "wallIds", "w1", ["g2"])).toBe(true);
  });

  it("isoliert in g2: ein Element ausserhalb der Gruppe ist gesperrt", () => {
    expect(isInsideActiveGroup(p, "wallIds", "w-outside", ["g2"])).toBe(false);
  });
});

describe("expandToGroups", () => {
  const g1: Group = { id: "g1", wallIds: ["w1", "w2"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
  const p = project([g1]);

  it("Klick/Marquee-Treffer, der zu einer Gruppe gehört, wird auf die ganze Gruppe erweitert", () => {
    const { expanded, groupIds } = expandToGroups(p, { ...EMPTY_MEM, wallIds: ["w1"] }, []);
    expect(expanded.wallIds.sort()).toEqual(["w1", "w2"]); // w2 kommt über die Gruppe dazu
    expect(groupIds).toEqual(["g1"]);
  });

  it("Treffer ohne Gruppe bleibt einzeln, gemischt mit einem gruppierten Treffer", () => {
    const { expanded, groupIds } = expandToGroups(p, { ...EMPTY_MEM, wallIds: ["w1", "w-loose"] }, []);
    expect(expanded.wallIds.sort()).toEqual(["w-loose", "w1", "w2"]);
    expect(groupIds).toEqual(["g1"]);
  });

  it("Marquee über mehrere Elementarten hinweg erweitert jede Art unabhängig", () => {
    const g2: Group = { id: "g2", wallIds: [], drawingIds: ["d1"], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
    const p2 = project([g1, g2]);
    const { expanded, groupIds } = expandToGroups(p2, { ...EMPTY_MEM, wallIds: ["w1"], drawingIds: ["d1"] }, []);
    expect(expanded.wallIds.sort()).toEqual(["w1", "w2"]);
    expect(expanded.drawingIds).toEqual(["d1"]);
    expect(groupIds.sort()).toEqual(["g1", "g2"]);
  });
});

describe("applyGroupDimming", () => {
  const g1: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
  const p = project([g1]);
  const wallInside = { kind: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, cls: "wall", weightMm: 0.2, wallId: "w1" } as unknown as Primitive;
  const wallOutside = { kind: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, cls: "wall", weightMm: 0.2, wallId: "w-outside" } as unknown as Primitive;
  const noOwner = { kind: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, cls: "grid", weightMm: 0.1 } as unknown as Primitive;

  it("ohne Isolation (groupPath leer) bleibt alles unverändert", () => {
    const out = applyGroupDimming([wallInside, wallOutside], p, []);
    expect(out).toEqual([wallInside, wallOutside]);
  });

  it("isoliert in g1: das Mitglied bleibt normal, alles andere mit ID wird gedimmt", () => {
    const out = applyGroupDimming([wallInside, wallOutside], p, ["g1"]);
    expect(out[0].greyed).toBeUndefined();
    expect(out[1].greyed).toBe(true);
  });

  it("Primitive ohne jede ID (Raster o. Ä.) werden nie gedimmt", () => {
    const out = applyGroupDimming([noOwner], p, ["g1"]);
    expect(out[0].greyed).toBeUndefined();
  });
});

describe("ungroup", () => {
  it("löst genau EIN Level auf; Untergruppen bleiben als eigene Gruppen bestehen", () => {
    const inner: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
    const outer: Group = { id: "g2", wallIds: ["w2"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1"] };
    const p = project([inner, outer]);
    const res = ungroup(p, "g2");
    expect(res).not.toBeNull();
    expect(res!.project.groups!.map((g) => g.id)).toEqual(["g1"]); // g2 weg, g1 bleibt
    expect(res!.members.wallIds).toEqual(["w2"]);
    expect(res!.subGroupIds).toEqual(["g1"]);
  });

  it("unbekannte ID liefert null", () => {
    expect(ungroup(project([]), "missing")).toBeNull();
  });
});
