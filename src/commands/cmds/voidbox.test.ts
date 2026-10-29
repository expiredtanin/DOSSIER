import { describe, expect, it } from "vitest";
import { sampleProject } from "../../model/sampleProject";
import type { CommandContext } from "../types";
import { voidBoxCommand } from "./voidbox";

const ctx = { project: sampleProject, level: { id: "eg" } } as unknown as CommandContext;

describe("Durchbruch", () => {
  it("legt einen Abzugskoerper mit Hoehe und Abstand an", () => {
    let st = voidBoxCommand.init();
    [st] = voidBoxCommand.onInput(st, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    [st] = voidBoxCommand.onInput(st, { kind: "point", point: { x: 1.4, y: 2 } }, ctx);
    [st] = voidBoxCommand.onInput(st, { kind: "number", value: 0.3 }, ctx);
    const [, res] = voidBoxCommand.onInput(st, { kind: "number", value: 1.2 }, ctx);
    const p = res.commit!(sampleProject);
    const v = p.extrudedSolids!.at(-1)!;
    expect(v.operation).toBe("subtract");
    expect(v.height).toBe(0.3);
    expect(v.baseOffset).toBe(1.2);
    expect(v.points).toHaveLength(4);
  });
  it("entartete Eingaben ergeben nichts", () => {
    const ops = (a: { x: number; y: number }, b: { x: number; y: number }, h: number) => {
      let st = voidBoxCommand.init();
      [st] = voidBoxCommand.onInput(st, { kind: "point", point: a }, ctx);
      [st] = voidBoxCommand.onInput(st, { kind: "point", point: b }, ctx);
      [st] = voidBoxCommand.onInput(st, { kind: "number", value: h }, ctx);
      const [, res] = voidBoxCommand.onInput(st, { kind: "number", value: 0 }, ctx);
      return res.commit!.toOps(sampleProject);
    };
    expect(ops({ x: 0, y: 0 }, { x: 0, y: 1 }, 1)).toEqual([]);
    expect(ops({ x: 0, y: 0 }, { x: 1, y: 1 }, 1)).toHaveLength(1);
  });
});
