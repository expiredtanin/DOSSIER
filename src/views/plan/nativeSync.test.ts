// [272] Das native 3D-Fenster baut dieselbe Anfrage wie der WASM-Viewport (Stift, Grau, Sperre, Geisterschicht).
import { describe, expect, it } from "vitest";
import { applyOps } from "../../core/ops";
import { designOptionEditArg, ghostFilter3d } from "../../core";
import { addDesignOptionOps, addDesignOptionSetOps } from "../../model/designOptions";
import { sampleProject } from "../../model/sampleProject";
import { nativeViewQuery } from "./nativeSync";

function withSet() {
  const { ops, id } = addDesignOptionSetOps(sampleProject, "Dachform");
  const p = applyOps(sampleProject, ops);
  return { p: applyOps(p, addDesignOptionOps(p, id)), id };
}

describe("nativeViewQuery", () => {
  it("ohne Stift keine Bearbeitungsfelder, keine Geisterschicht", () => {
    const q = nativeViewQuery(sampleProject, sampleProject.drawingLevels[0].id, null, true, true);
    expect(q.designOptionEdit).toBeUndefined();
    expect(ghostFilter3d(q)).toBeNull();
  });
  it("Stift: gleiche Anfrage wie im WASM-Pfad (layer + lock), Grau gibt Geisterschicht", () => {
    const { p, id } = withSet();
    const draw = { set: id, option: "a" };
    const lvl = p.drawingLevels[0].id;
    const q = nativeViewQuery(p, lvl, draw, true, true);
    expect(q.designOptionEdit).toEqual(designOptionEditArg(p, draw, true, { lock: true }));
    expect(q.designOptionEdit).toMatchObject({ layer: true, lock: true, grey: true });
    expect(ghostFilter3d(q)).not.toBeNull();
    const q2 = nativeViewQuery(p, lvl, draw, false, false);
    expect(q2.designOptionEdit?.lock).toBeUndefined();
    expect(ghostFilter3d(q2)).toBeNull();
  });
});
