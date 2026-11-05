import { it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { getState } from "../state/appStore";
import { documentFor } from "../core/document";
it("dbg", () => {
  getState().loadProject(buildComplexSampleProject());
  const p = getState().project;
  const codes: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (cs: any[]) => cs.forEach((c) => (codes.push(c.code + ":" + c.name), c.children && walk(c.children)));
  walk(p.layers);
  console.log(codes.join(" | "));
  const run = (hide: string[], lv: string) => {
    const vis: Record<string, boolean> = {};
    for (const c of codes) vis[c.split(":")[0]] = !hide.includes(c.split(":")[0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = documentFor(p).query("presentationSheet", [], JSON.stringify({ levels: [lv], groups: [0], layerVisibility: vis, detail: "mittel", sheetW: 841, sheetH: 594, titleBlock: true, shadows: true }));
    return `${r.scale}:${Math.round(r.items[0]?.widthMm)}x${Math.round(r.items[0]?.heightMm)}`;
  };
  for (const c of [[], ...codes.map((c) => [c.split(":")[0]])]) console.log("hide", c.join(), run(c, "eg"), run(c, "ansicht-sued"));
});
