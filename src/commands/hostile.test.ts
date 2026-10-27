// [16] „Befehle mit Unsinn füttern": jeder Befehl der Registratur bekommt feindliche Eingaben
// (NaN, ∞, riesige Zahlen, leere/lange Texte, fremde ids). Erwartung: kein Wurf, und was am Ende
// committet wird, darf das Projekt nie ungültig machen — oder wird vom Op-Wächter in setProject
// abgelehnt (core/ops.ts `validateOps`). Der Test prüft beides.
import { describe, expect, it } from "vitest";
import { COMMANDS } from "./registry";
import type { CmdInput, CommandContext } from "./types";
import { sampleProject } from "../model/sampleProject";
import { applyOps, diffToOps, validateOps } from "../core/ops";

const level = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
const ctx: CommandContext = {
  project: sampleProject,
  level,
  defaultCategoryCode: sampleProject.layers[0]?.code ?? "20",
  activeLineStyleId: "",
  activeWallTypeId: sampleProject.wallTypes[0]?.id ?? "",
  lastPoint: null,
  selection: {
    wallIds: sampleProject.walls.slice(0, 2).map((w) => w.id),
    drawingId: null,
    drawingIds: [],
  } as unknown as CommandContext["selection"],
};

const NUMS = [NaN, Infinity, -Infinity, 0, -1, 1e300, -1e300, 1e-300, 0.5, 3];
const TEXTS = ["", " ", "x".repeat(10_000), "0,0", "r3<45", "\u0000", "-", "NaN"];
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

function hostile(optionIds: string[]): CmdInput {
  switch (Math.floor(rnd() * 5)) {
    case 0:
      return { kind: "point", point: { x: pick(NUMS), y: pick(NUMS) } };
    case 1:
      return { kind: "number", value: pick(NUMS) };
    case 2:
      return { kind: "option", id: pick([...optionIds, "", "gibt-es-nicht", "__proto__"]) };
    case 3:
      return { kind: "text", text: pick(TEXTS) };
    default:
      return { kind: "selection", wallIds: ["nope", "", ...sampleProject.walls.map((w) => w.id).slice(0, 1)], drawingIds: ["nope"] };
  }
}

describe("Befehle mit feindlichen Eingaben", () => {
  const names = Object.keys(COMMANDS);
  it("die Registratur ist nicht leer", () => expect(names.length).toBeGreaterThan(50));

  for (const name of names) {
    it(`${name}: kein Wurf, Projekt bleibt gültig oder wird abgelehnt`, () => {
      const cmd = COMMANDS[name];
      const failures: string[] = [];
      for (let round = 0; round < 25; round++) {
        let state: ReturnType<typeof cmd.init>;
        try {
          state = cmd.init();
        } catch (e) {
          failures.push(`init: ${String(e)}`);
          break;
        }
        for (let step = 0; step < 14; step++) {
          let opts: string[] = [];
          try {
            opts = (cmd.options(state) ?? []).map((o) => o.id);
          } catch (e) {
            failures.push(`options: ${String(e)}`);
          }
          const kind = Math.floor(rnd() * 6);
          try {
            let res;
            if (kind === 0) [state, res] = cmd.onMove(state, { x: pick(NUMS), y: pick(NUMS) }, null, ctx);
            else if (kind === 1) [state, res] = cmd.onConfirm(state, ctx);
            else if (kind === 2 && rnd() < 0.2) [state, res] = cmd.onCancel(state);
            else [state, res] = cmd.onInput(state, hostile(opts), ctx);
            if (res?.commit) {
              const next = res.commit(sampleProject);
              const ops = diffToOps(sampleProject, next);
              const applied = applyOps(sampleProject, ops);
              validateOps(applied, ops, sampleProject); // darf melden, aber nicht werfen
            }
            if (res?.done) break;
          } catch (e) {
            failures.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
            break;
          }
        }
      }
      expect([...new Set(failures)].slice(0, 5)).toEqual([]);
    });
  }
});
