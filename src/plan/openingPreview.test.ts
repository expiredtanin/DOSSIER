import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { openingPreviewProject, openingPreviewSvgs } from "./openingPreview";

describe("openingPreview ([103]/[104])", () => {
  it("baut ein Vorschau-Projekt mit nur der Öffnung", () => {
    const mini = openingPreviewProject(sampleProject, "D1");
    expect(mini?.walls).toHaveLength(1);
    expect(mini?.openings?.map((o) => o.id)).toEqual(["D1"]);
    expect(openingPreviewProject(sampleProject, "fehlt")).toBeNull();
  });

  it("liefert Grundriss, Schnitt und Ansicht als SVG; Schichteinzug ändert den Grundriss", async () => {
    const svgs = await openingPreviewSvgs(sampleProject, "D1");
    expect(svgs?.plan).toContain("<svg");
    expect(svgs?.section).toContain("<polygon");
    expect(svgs?.elevation).toContain("<polygon");
    const withReveal: Project = {
      ...sampleProject,
      openings: sampleProject.openings!.map((o) => (o.id === "D1" ? { ...o, layerReveals: [{ layer: -1, mode: "zurueck", amount: 0.05 }] } : o)),
    };
    const other = await openingPreviewSvgs(withReveal, "D1");
    expect(other?.plan).not.toEqual(svgs?.plan);
  });
});
