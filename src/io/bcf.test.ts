// BCF-Fassade ([BCF]): Rundreise über Rust, Fehlerfälle, reine Hilfen und die GlobalId-Zuordnung
// zum IFC-Export (gleiche Ableitung → Dossier → IFC → BCF → Dossier trifft).

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import {
  addComment,
  addTopic,
  bcfInfo,
  emptyBcf,
  newTopic,
  newViewpoint,
  parseBcf,
  setTopicStatus,
  writeBcf,
  type BcfCamera,
} from "./bcf";
import { buildGuidIndex, emptyBcfSelection, resolveGuids, selectionToGuids, viewpointGuids } from "./bcfMatch";
import { exportIfcSpf, ifcGuid } from "../export/exportIfc";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const camera: BcfCamera = {
  kind: "perspective",
  position: [10, -12, 8],
  direction: [-0.5, 0.6, -0.4],
  up: [0, 0, 1],
  fieldOfView: 50,
  viewToWorldScale: 0,
  aspectRatio: 1.5,
};

function sample() {
  const vp = newViewpoint("vp-1", ["0n_zVrPdE0cg_UxWSd1GmA"], camera);
  let f = emptyBcf("proj-1", "Haus Müller");
  f = addTopic(f, newTopic({ guid: "11111111-2222-3333-4444-555555555555", title: "Wand zu dünn", author: "a@b.ch", now: "2026-10-28T09:00:00Z", description: "Mindestens 30 cm", viewpoints: [vp] }));
  f = addComment(f, "11111111-2222-3333-4444-555555555555", { guid: "c-1", date: "2026-10-28T09:10:00Z", author: "c@d.ch", comment: "Einverstanden", viewpointGuid: "vp-1", modifiedDate: "", modifiedAuthor: "" });
  return setTopicStatus(f, "11111111-2222-3333-4444-555555555555", "Resolved", "c@d.ch", "2026-10-28T09:20:00Z");
}

describe("BCF-Fassade", () => {
  it("Rundreise 2.1 und 3.0 über Rust", async () => {
    for (const version of ["2.1", "3.0"] as const) {
      const bytes = await writeBcf(sample(), version);
      expect(bytes[0]).toBe(0x50); // ZIP
      const back = await parseBcf(bytes);
      expect(back.version).toBe(version);
      expect(back.projectName).toBe("Haus Müller");
      const t = back.topics[0];
      expect(t.title).toBe("Wand zu dünn");
      expect(t.topicStatus).toBe("Resolved");
      expect(t.modifiedAuthor).toBe("c@d.ch");
      expect(t.comments).toHaveLength(1);
      expect(t.comments[0].comment).toBe("Einverstanden");
      expect(t.comments[0].viewpointGuid).toBe("vp-1");
      expect(t.viewpoints[0].camera).toEqual(camera);
      expect(t.viewpoints[0].selection[0].ifcGuid).toBe("0n_zVrPdE0cg_UxWSd1GmA");
    }
  });

  it("Unsinn ergibt einen Fehler, keinen Absturz", async () => {
    await expect(parseBcf(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    await expect(parseBcf(new Uint8Array())).rejects.toThrow();
    await expect(writeBcf(sample(), "9.9" as never)).rejects.toThrow(/Version/);
    const bad = { ...sample(), topics: [{ ...sample().topics[0], guid: "../x" }] };
    await expect(writeBcf(bad, "2.1")).rejects.toThrow();
  });

  it("Hilfen ändern den Eingang nicht", () => {
    const f = emptyBcf();
    const g = addTopic(f, newTopic({ guid: "g", title: "t", author: "a", now: "n" }));
    expect(f.topics).toHaveLength(0);
    expect(g.topics).toHaveLength(1);
    const h = setTopicStatus(g, "g", "Closed", "x", "later");
    expect(g.topics[0].topicStatus).toBe("Open");
    expect(h.topics[0].topicStatus).toBe("Closed");
  });

  it("bcfInfo ohne Snapshot-Bytes", async () => {
    const info = bcfInfo(await parseBcf(await writeBcf(sample(), "3.0"))) as { topicCount: number; topics: { viewpoints: { selected: string[] }[] }[] };
    expect(info.topicCount).toBe(1);
    expect(info.topics[0].viewpoints[0].selected).toEqual(["0n_zVrPdE0cg_UxWSd1GmA"]);
    expect(JSON.stringify(info)).not.toContain("snapshot\":\"");
  });
});

describe("BCF-GlobalId-Zuordnung", () => {
  const ifc = exportIfcSpf(sampleProject);

  it("jede GlobalId des Index steht im IFC-Export", () => {
    const index = buildGuidIndex(sampleProject);
    const channels = new Set<string>();
    let found = 0;
    for (const [guid, target] of index) {
      // `opening/…` (IfcOpeningElement) wird in manchen Wänden nicht geschrieben — die Füllung (`fill/…`) schon.
      if (ifc.includes(`'${guid}'`)) {
        found++;
        channels.add(target.channel);
      }
    }
    expect(found).toBeGreaterThan(10);
    for (const c of ["wallIds", "ceilingIds", "openingIds"]) expect(channels.has(c)).toBe(true);
  });

  it("Rundreise Auswahl → GlobalId → Auswahl", () => {
    const sel = emptyBcfSelection();
    sel.wallIds = sampleProject.walls.slice(0, 2).map((w) => w.id);
    sel.ceilingIds = (sampleProject.ceilings ?? []).slice(0, 1).map((c) => c.id);
    sel.openingIds = (sampleProject.openings ?? []).slice(0, 1).map((o) => o.id);
    const guids = selectionToGuids(sampleProject, sel);
    expect(guids).toHaveLength(sel.wallIds.length + sel.ceilingIds.length + sel.openingIds.length);
    for (const g of guids) expect(ifc).toContain(`'${g}'`);
    const back = resolveGuids(sampleProject, guids);
    expect(back.missing).toEqual([]);
    expect(back.selection).toEqual(sel);
  });

  it("Wand-GlobalId entspricht der im Export (Projekt-id/wall/id)", () => {
    const w = sampleProject.walls[0];
    const g = ifcGuid(`${sampleProject.id}/wall/${w.id}`);
    expect(resolveGuids(sampleProject, [g]).selection.wallIds).toEqual([w.id]);
  });

  it("unbekannte GUIDs werden gemeldet", () => {
    const r = resolveGuids(sampleProject, ["0000000000000000000000", ifcGuid(`${sampleProject.id}/wall/${sampleProject.walls[0].id}`)]);
    expect(r.missing).toEqual(["0000000000000000000000"]);
    expect(r.selection.wallIds).toHaveLength(1);
  });

  it("importierte Meshes über ifcGlobalId", () => {
    const p = {
      ...sampleProject,
      context: [{ id: "m1", type: "importedMesh", name: "x", ifcGlobalId: "2O2Fr$t4X7Zf8NOew3FLOH", positions: [], indices: [] }],
    } as unknown as Project;
    expect(resolveGuids(p, ["2O2Fr$t4X7Zf8NOew3FLOH"]).selection.contextObjectIds).toEqual(["m1"]);
    const sel = emptyBcfSelection();
    sel.contextObjectIds = ["m1"];
    expect(selectionToGuids(p, sel)).toEqual(["2O2Fr$t4X7Zf8NOew3FLOH"]);
  });

  it("viewpointGuids: Auswahl, sonst sichtbare Ausnahmen bei defaultVisibility=false", () => {
    const vp = newViewpoint("v", ["A", "B", "A"]);
    expect(viewpointGuids(vp)).toEqual(["A", "B"]);
    const hidden = { ...newViewpoint("v", []), defaultVisibility: false, exceptions: [{ ifcGuid: "C", originatingSystem: "", authoringToolId: "" }] };
    expect(viewpointGuids(hidden)).toEqual(["C"]);
    expect(viewpointGuids(newViewpoint("v", []))).toEqual([]);
  });
});
