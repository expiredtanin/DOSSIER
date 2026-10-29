/**
 * `groupActions.ts` — reine Gruppen-Logik (Mitgliedschaft/Verschachtelung/
 * Erzeugen/Auflösen), Vectorworks-artig: Cmd+G fasst die Auswahl zusammen,
 * Doppelklick betritt eine Gruppe (Isolation), alles ausserhalb wird
 * gedimmt/gesperrt.
 */

import { describe, it, expect } from "vitest";
import {
  applyGroupDimming,
  applyGroupDimmingToPlan,
  containingGroupId,
  expandToGroups,
  groupSelection,
  isInsideActiveGroup,
  transitiveMembership,
  ungroup,
} from "./groupActions";
import type { Primitive } from "../plan/generatePlan/shared";
import { materializeUnderlay, type Plan } from "../plan/generatePlan";
import type { Drawing2D, Group, Project } from "../model/types";
import { applyOps } from "../core/ops";
import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";

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
    drawings2d: [],
    groups,
  };
}

describe("groupSelection", () => {
  it("erzeugt eine Gruppe aus ≥2 gewählten Elementen", () => {
    const p = project([]);
    const res = groupSelection({ ...EMPTY_MEM, wallIds: ["w1", "w2"] }, []);
    expect(res).not.toBeNull();
    const out = applyOps(p, res!.ops);
    expect(out.groups).toHaveLength(1);
    expect(out.groups![0]).toMatchObject({ wallIds: ["w1", "w2"], groupIds: [] });
  });

  it("weniger als 2 Elemente gruppiert nicht (Vectorworks-Konvention)", () => {
    expect(groupSelection({ ...EMPTY_MEM, wallIds: ["w1"] }, [])).toBeNull();
    expect(groupSelection(EMPTY_MEM, [])).toBeNull();
  });

  it("bereits gewählte Gruppen werden als Untergruppen verschachtelt, nicht vermischt", () => {
    const inner: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
    const p = project([inner]);
    const res = groupSelection({ ...EMPTY_MEM, wallIds: ["w2"] }, ["g1"]);
    expect(res).not.toBeNull();
    const outer = applyOps(p, res!.ops).groups!.find((g) => g.id === res!.groupId)!;
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

describe("containingGroupId (Kern)", () => {
  const inner: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
  const outer: Group = { id: "g2", wallIds: ["w2"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1"] };
  const p = project([inner, outer]);

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

describe("applyGroupDimmingToPlan", () => {
  const g1: Group = { id: "g1", wallIds: [], drawingIds: ["din"], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
  const p = project([g1]);
  const din = { id: "din" } as unknown as Drawing2D;
  const dout = { id: "dout" } as unknown as Drawing2D;
  const mkLine = (d: Drawing2D) => ({ kind: "line", drawingId: d.id }) as unknown as Primitive;
  const underlay = [{ drawings: [din, dout], catGreyed: false, tint: false, above: true, ctx: [], build: (ds: Drawing2D[]) => ds.map(mkLine) }];
  const plan = { primitives: [], underlay } as unknown as Plan;

  it("ohne Isolation unverändert", () => {
    expect(applyGroupDimmingToPlan(plan, p, [])).toBe(plan);
  });

  it("Unterlage bleibt kompakt: Zeichnungen ausserhalb in gedimmte Untergruppe", () => {
    const out = applyGroupDimmingToPlan(plan, p, ["g1"]);
    expect(out.underlay).toHaveLength(2);
    expect(out.underlay![0].drawings).toEqual([din]);
    expect(out.underlay![0].tint).toBe(false);
    expect(out.underlay![1].drawings).toEqual([dout]);
    expect(out.underlay![1].tint).toBe(true);
  });

  it("materializeUnderlay markiert gedimmte obere Gruppen als greyedRange", () => {
    const m = materializeUnderlay(applyGroupDimmingToPlan(plan, p, ["g1"]));
    expect(m.primitives).toHaveLength(2);
    expect(m.greyedRanges).toEqual([[1, 2]]);
  });
});

describe("Zeichnen in der aktiven Gruppe ([K4] S3: Gruppen-Zuordnung im Kern, `cmd_create::group_ops`)", () => {
  const g1: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
  const line = (id: string) =>
    ({ id, type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } } }) as Project["drawings2d"][number];
  const ctx = { level: "eg", cat: "20" };
  /** Befehl im Kern rechnen (mit `group` wie `EngineHost.commit` in App.tsx) und anwenden. */
  const ops = (before: Project, req: object, group?: string): CoreOp[] =>
    documentFor(before).cmdOps({ ...req, ctx, stamp: "t", ...(group ? { group } : {}) });
  const commit = (before: Project, req: object, group?: string) => applyOps(before, ops(before, req, group));
  const lineReq = { cmd: "line", a: [0, 0], b: [2, 0] };

  it("neu gezeichnetes Element wird Mitglied der aktiven (innersten) Gruppe", () => {
    const result = commit(project([g1]), lineReq, "g1");
    const g = result.groups!.find((x) => x.id === "g1")!;
    expect(g.drawingIds).toEqual(["dr2d-t-1"]);
    expect(g.wallIds).toEqual(["w1"]); // bestehende Mitgliedschaft bleibt
  });

  it("ohne aktive Gruppe keine zusätzlichen Ops", () => {
    expect(ops(project([g1]), lineReq)).toHaveLength(1);
  });

  it("ohne neue Elemente (nur Ersetzen) keine zusätzlichen Ops", () => {
    const p: Project = { ...project([g1]), drawings2d: [line("d0")] };
    const move = { cmd: "transform", sel: { drawingIds: ["d0"] }, op: "move", pts: [[0, 0], [1, 0]], mode: "move", count: 1 };
    expect(ops(p, move, "g1").map((o) => o.kind)).toEqual(["replace"]);
  });

  it("unbekannte aktive Gruppe: keine zusätzlichen Ops", () => {
    expect(ops(project([g1]), lineReq, "gx")).toHaveLength(1);
  });

  it("mehrere neue Elemente auf einmal (Mehrfachlinie) werden alle Mitglied", () => {
    const result = commit(project([g1]), { cmd: "multiline", a: [0, 0], b: [4, 0], spacing: 0.3, sign: 1, count: 3 }, "g1");
    expect(result.groups!.find((x) => x.id === "g1")!.drawingIds).toEqual(["dr2d-t-1", "dr2d-t-2", "dr2d-t-3"]);
  });

  it("verschachtelt: neues Element landet in der INNERSTEN (aktiven) Gruppe, nicht der äusseren", () => {
    const inner: Group = { id: "g1", wallIds: [], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
    const outer: Group = { id: "g2", wallIds: [], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1"] };
    const result = commit(project([inner, outer]), lineReq, "g1");
    expect(result.groups!.find((x) => x.id === "g1")!.drawingIds).toEqual(["dr2d-t-1"]);
    expect(result.groups!.find((x) => x.id === "g2")!.drawingIds).toEqual([]);
  });
});

describe("ungroup", () => {
  it("löst genau EIN Level auf; Untergruppen bleiben als eigene Gruppen bestehen", () => {
    const inner: Group = { id: "g1", wallIds: ["w1"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: [] };
    const outer: Group = { id: "g2", wallIds: ["w2"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1"] };
    const p = project([inner, outer]);
    const res = ungroup(p, "g2");
    expect(res).not.toBeNull();
    expect(applyOps(p, res!.ops).groups!.map((g) => g.id)).toEqual(["g1"]); // g2 weg, g1 bleibt
    expect(res!.members.wallIds).toEqual(["w2"]);
    expect(res!.subGroupIds).toEqual(["g1"]);
  });

  it("unbekannte ID liefert null", () => {
    expect(ungroup(project([]), "missing")).toBeNull();
  });
});
