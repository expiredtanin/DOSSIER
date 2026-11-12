// [208] Plakat-Vorlagen: Master mit Raster, Kopfzeile, Massstabsangabe; Blatt „aus Vorlage"; anonymer Plankopf.
import { describe, expect, it } from "vitest";
import { sampleProject } from "./sampleProject";
import { buildComplexSampleProject } from "./sampleProjectComplex";
import type { Layout, Project } from "./types";
import { effectiveSheetSizeMm, findMaster, resolveTitleBlock } from "./layoutModel";
import { createPosterMaster, findPosterMaster, POSTER_TEMPLATES, posterHeaderItems, posterMetrics, posterTemplate, viewportScaleLabel } from "./posterTemplates";
import { addWbwSetOps, setCompetitionOps } from "../state/publishActions";
import { applyOps } from "../core/ops";
import { planPublish } from "../export/publishSet";
import { placeImageOps } from "../state/layoutImageActions";
import { PNG_40X30 } from "./layoutImages.testing";

function withPosters(competition?: Project["competition"]): Project {
  const m = createPosterMaster("m1", posterTemplate("poster-a1-landscape")!);
  const lay = (id: string, name: string): Layout => ({ id, name, paper: "a1", orientation: "landscape", masterId: "m1", viewports: [] });
  return { ...sampleProject, name: "Haus Muster", projectNumber: "2611", masterLayouts: [m], layouts: [lay("p1", "Situation"), lay("p2", "Grundrisse"), { ...lay("x", "Anderes"), masterId: undefined }], competition };
}

describe("Plakat-Vorlagen", () => {
  it("A0 und A1, hoch und quer", () => {
    expect(POSTER_TEMPLATES.map((p) => p.key)).toEqual(["poster-a0-portrait", "poster-a0-landscape", "poster-a1-portrait", "poster-a1-landscape"]);
    for (const tpl of POSTER_TEMPLATES) {
      const m = createPosterMaster(`m-${tpl.key}`, tpl);
      const size = effectiveSheetSizeMm(m);
      expect(tpl.orientation === "landscape" ? size.w > size.h : size.h > size.w).toBe(true);
      expect(m.template).toBe(tpl.key);
      expect(m.posterHeader).toBe(true);
      expect(m.viewportScaleLabels).toBe(true);
      // Raster: 2 senkrechte Linien je Spalte, 4 waagrechte
      const mm = posterMetrics(size.w, size.h);
      expect(m.guides!.filter((g) => g.axis === "x")).toHaveLength(mm.columns * 2);
      expect(m.guides!.filter((g) => g.axis === "y")).toHaveLength(4);
      // alle Linien liegen im Blatt
      for (const g of m.guides!) {
        expect(g.posMm).toBeGreaterThan(0);
        expect(g.posMm).toBeLessThan(g.axis === "x" ? size.w : size.h);
      }
    }
  });

  it("A1 quer misst 841 × 594 mm mit 6 Spalten", () => {
    const m = createPosterMaster("m", posterTemplate("poster-a1-landscape")!);
    expect(effectiveSheetSizeMm(m)).toEqual({ w: 841, h: 594 });
    expect(posterMetrics(841, 594).columns).toBe(6);
  });

  it("findet den Master einer Vorlage im Projekt wieder", () => {
    const p = withPosters();
    expect(findPosterMaster(p, "poster-a1-landscape")?.id).toBe("m1");
    expect(findPosterMaster(p, "poster-a0-portrait")).toBeUndefined();
  });

  it("Kopfzeile: Kennwort-Feld und „Plan x/n“ zählen nur Plakate", () => {
    const p = withPosters({ anonymous: true, keyword: "FALKE 7" });
    const lay = p.layouts![1];
    const items = posterHeaderItems(p, lay, findMaster(p, lay)!, { w: 841, h: 594 });
    const texts = items.flatMap((i) => (i.kind === "text" ? [i.text] : []));
    expect(texts).toContain("Kennwort");
    expect(texts).toContain("FALKE 7");
    expect(texts).toContain("Plan 2/2");
    // anonym: kein Projektname in der Kopfzeile
    expect(texts.some((x) => x.includes("Haus Muster"))).toBe(false);
  });

  it("offene Abgabe zeigt den Projektnamen in der Kopfzeile", () => {
    const p = withPosters({ anonymous: false, keyword: "FALKE 7" });
    const items = posterHeaderItems(p, p.layouts![0], findMaster(p, p.layouts![0])!, { w: 841, h: 594 });
    expect(items.flatMap((i) => (i.kind === "text" ? [i.text] : []))).toContain("Haus Muster");
  });

  it("Plankopf anonym: Kennwort statt Projektname, kein Bearbeiter", () => {
    const p = withPosters({ anonymous: true, keyword: " FALKE 7 " });
    p.masterLayouts![0].titleBlock = { projectName: "Büro AG", author: "M. Muster" };
    const tb = resolveTitleBlock(p, p.layouts![0], p.masterLayouts![0]);
    expect([tb.projectName, tb.author, tb.anonymous, tb.keyword]).toEqual(["FALKE 7", "", true, "FALKE 7"]);
  });

  it("Massstabsangabe unter dem Viewport", () => {
    const snap = buildComplexSampleProject().viewSnapshots![0];
    const p = { ...withPosters(), viewSnapshots: [{ ...snap, scaleDenominator: 200 }] };
    const vp = { id: "v", snapshotId: snap.id, xMm: 50, yMm: 100, widthMm: 300, heightMm: 200 };
    const l = viewportScaleLabel(p, vp, { w: 841, h: 594 })!;
    expect(l.text).toBe("1:200");
    expect(l.x).toBe(50);
    expect(l.y).toBeGreaterThan(300);
    expect(viewportScaleLabel(p, { ...vp, scaleDenominator: 100 }, { w: 841, h: 594 })!.text).toBe("1:100");
    expect(viewportScaleLabel(p, { ...vp, snapshotId: "gibt-es-nicht" }, { w: 841, h: 594 })).toBeNull();
  });
});

describe("Wettbewerb und WBW-Abgabe", () => {
  it("Einstellung anonym + Kennwort als Ops; leer entfernt das Feld", () => {
    let p = withPosters();
    p = applyOps(p, setCompetitionOps(p, { anonymous: true }));
    expect(p.competition).toEqual({ anonymous: true, keyword: "" });
    p = applyOps(p, setCompetitionOps(p, { keyword: "FALKE 7" }));
    expect(p.competition).toEqual({ anonymous: true, keyword: "FALKE 7" });
    p = applyOps(p, setCompetitionOps(p, { anonymous: false, keyword: "" }));
    expect(p.competition).toBeUndefined();
  });

  it("Satz „WBW-Abgabe“ enthält die Plakate in Blattfolge, ein PDF, Dateiname = Kennwort", () => {
    let p = withPosters({ anonymous: true, keyword: "FALKE 7" });
    p = applyOps(p, addWbwSetOps(p, "s1"));
    const set = p.publishSets!.find((s) => s.id === "s1")!;
    expect(set.layoutIds).toEqual(["p1", "p2"]);
    expect(set.format).toBe("pdf-multi");
    const plan = planPublish(p, set, "2026-11-12");
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].layoutIds).toEqual(["p1", "p2"]);
    expect(plan.files[0].fileName).toBe("FALKE 7_WBW-Abgabe.pdf");
    expect(plan.files[0].fileName).not.toMatch(/Muster|2611/);
  });

  it("Einzeldateien (pdf-single) tragen ebenfalls kein Projekt", () => {
    let p = withPosters({ anonymous: true, keyword: "FALKE 7" });
    p = applyOps(p, addWbwSetOps(p, "s1"));
    const set = { ...p.publishSets![0], format: "pdf-single", namePattern: "{Projektnummer}_{Projekt}_{Blattnummer}" };
    const plan = planPublish(p, set, "2026-11-12");
    expect(plan.files.map((f) => f.fileName)).toEqual(["FALKE 7_01.pdf", "FALKE 7_02.pdf"]);
  });

  it("nicht anonym bleibt der Dateiname mit Projekt", () => {
    let p = withPosters();
    p = applyOps(p, addWbwSetOps(p, "s1"));
    expect(planPublish(p, p.publishSets![0], "2026-11-12").files[0].fileName).toBe("Haus Muster_WBW-Abgabe.pdf");
  });
});

describe("Rendering ins Layout einsetzen", () => {
  it("Ops setzen das Bild mittig aufs Blatt (A1 quer)", () => {
    let p = withPosters();
    const ops = placeImageOps(p, "p1", "r.png", PNG_40X30, "img-1")!;
    p = applyOps(p, ops);
    const img = p.layouts![0].images![0];
    expect(img.id).toBe("img-1");
    expect(img.pixelWidth).toBe(40);
    expect(img.xMm + img.widthMm / 2).toBeCloseTo(420.5, 0);
    expect(img.widthMm / img.heightMm).toBeCloseTo(4 / 3, 1);
  });

  it("unbekanntes Blatt oder kein Bild: keine Ops", () => {
    const p = withPosters();
    expect(placeImageOps(p, "gibts-nicht", "r.png", PNG_40X30, "i")).toBeNull();
    expect(placeImageOps(p, "p1", "r.png", new Uint8Array([1, 2]), "i")).toBeNull();
  });
});
