// [256] Klassen-Füllung (`LayerCategory.fill`) über den Store setzen, entfernen, zurücknehmen; Ziehen im Farbwähler = ein Undo-Schritt.
import { beforeEach, describe, expect, it } from "vitest";
import { getState } from "./appStore";
import { findCategory } from "../model/layers";
import { sampleProject } from "../model/sampleProject";

const st = () => getState();
const code = () => st().project.layers[0].code;
const fill = () => findCategory(st().project.layers, code())?.fill;

beforeEach(() => {
  st().loadProject(structuredClone(sampleProject));
  st().clearHistory();
});

describe("Klassen-Füllung bearbeiten ([256])", () => {
  it("setzt, entfernt und nimmt zurück", () => {
    st().patchCategory(code(), { fill: "#d9d9d9" });
    expect(fill()).toBe("#d9d9d9");
    st().patchCategory(code(), { name: "X" }); // beendet die Zusammenfassung
    st().patchCategory(code(), { fill: undefined });
    expect(fill()).toBeUndefined();
    expect(findCategory(st().project.layers, code())).not.toHaveProperty("fill", null);
    st().undo();
    st().undo();
    expect(fill()).toBe("#d9d9d9");
    st().undo();
    expect(fill()).toBeUndefined();
  });

  it("Ziehen im Farbwähler ist ein Undo-Schritt", () => {
    for (const c of ["#111111", "#222222", "#333333"]) st().patchCategory(code(), { fill: c });
    expect(fill()).toBe("#333333");
    st().undo();
    expect(fill()).toBeUndefined();
  });
});
