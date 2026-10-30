// Tests der reinen Layout-Logik (DOSSIER A3): Blatt-Geometrie, Fabriken,
// immutables Viewport-CRUD, Master-Vererbung der Titelblock-Werte,
// Viewport→Ausschnitt-Auflösung + Massstab, Sichtbarkeits-Ableitung.

import { describe, expect, it } from "vitest";
import type {
  Layout,
  LayoutFolder,
  MasterLayout,
  Project,
  ViewSnapshot,
} from "./types";
import {
  addViewport,
  buildLayoutTree,
  buildMasterTree,
  collectFolderLayouts,
  createLayout,
  createLayoutFolder,
  createMasterLayout,
  createSheetLevel,
  createViewport,
  deleteFolder,
  deleteMasterFolder,
  effectiveSheetSizeMm,
  findMaster,
  findSnapshot,
  folderPdfPages,
  isDescendant,
  isSheetLevel,
  moveFolderToFolder,
  moveLayoutToFolder,
  PAPER_FORMATS,
  patchViewport,
  removeViewport,
  resolveTitleBlock,
  resolveViewportScale,
  SHEET_SCALE_DENOMINATOR,
  sheetLevelOf,
  sheetMmToModel,
  sheetModelToMm,
  sheetSizeMm,
  visibleCodesFromSnapshot,
} from "./layoutModel";

/** Minimaler Ausschnitt (nur die im Layout-System genutzten Felder tragen Werte). */
function snap(id: string, patch?: Partial<ViewSnapshot>): ViewSnapshot {
  return {
    id,
    name: `Snap ${id}`,
    viewType: "grundriss",
    view3d: "top",
    scaleDenominator: 100,
    detail: "mittel",
    activeLevelId: "floor-0",
    layerVisibility: { A: true, B: false, C: true },
    drawingVisibility: {},
    ...patch,
  };
}

/** Minimales Projekt-Gerüst mit optionalen Layout-Feldern. */
function project(patch?: Partial<Project>): Project {
  return {
    id: "p1",
    name: "Villa Test",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [],
    layers: [],
    walls: [],
    drawings2d: [],
    ...patch,
  };
}

describe("sheetSizeMm", () => {
  it("liefert A4/A3 in Hoch- und Querformat", () => {
    expect(sheetSizeMm("a4", "portrait")).toEqual({ w: 210, h: 297 });
    expect(sheetSizeMm("a4", "landscape")).toEqual({ w: 297, h: 210 });
    expect(sheetSizeMm("a3", "portrait")).toEqual({ w: 297, h: 420 });
    expect(sheetSizeMm("a3", "landscape")).toEqual({ w: 420, h: 297 });
  });
});

describe("Fabriken", () => {
  it("createLayout: leer, ohne Master", () => {
    const l = createLayout("l1", "Blatt 1", "a3", "landscape");
    expect(l).toEqual({
      id: "l1",
      name: "Blatt 1",
      paper: "a3",
      orientation: "landscape",
      viewports: [],
    });
    expect(l.masterId).toBeUndefined();
  });

  it("createMasterLayout: leerer Titelblock + Rahmen an", () => {
    const m = createMasterLayout("m1", "Master", "a4", "portrait");
    expect(m.titleBlock).toEqual({});
    expect(m.border).toBe(true);
  });

  it("createViewport: Defaults + optionaler Massstab", () => {
    const v = createViewport("v1", "s1");
    expect(v).toMatchObject({ id: "v1", snapshotId: "s1", xMm: 20, yMm: 20, widthMm: 120, heightMm: 90 });
    expect(v.scaleDenominator).toBeUndefined();
    const v2 = createViewport("v2", "s1", { xMm: 5, scaleDenominator: 50 });
    expect(v2.xMm).toBe(5);
    expect(v2.scaleDenominator).toBe(50);
  });
});

describe("Viewport-CRUD (immutabel)", () => {
  const base = addViewport(createLayout("l1", "L", "a4", "portrait"), createViewport("v1", "s1"));

  it("addViewport verändert das Original nicht", () => {
    const before = createLayout("l1", "L", "a4", "portrait");
    const after = addViewport(before, createViewport("v1", "s1"));
    expect(before.viewports).toHaveLength(0);
    expect(after.viewports).toHaveLength(1);
    expect(after).not.toBe(before);
  });

  it("removeViewport entfernt per Id", () => {
    const two = addViewport(base, createViewport("v2", "s2"));
    const one = removeViewport(two, "v1");
    expect(one.viewports.map((v) => v.id)).toEqual(["v2"]);
  });

  it("patchViewport ändert nur das Ziel, immutabel", () => {
    const patched = patchViewport(base, "v1", { xMm: 42, scaleDenominator: 50 });
    expect(patched.viewports[0]).toMatchObject({ xMm: 42, scaleDenominator: 50 });
    expect(base.viewports[0].xMm).toBe(20);
    // Unbekannte Id → No-op (gleiche Werte, neue Liste).
    const noop = patchViewport(base, "nope", { xMm: 1 });
    expect(noop.viewports[0].xMm).toBe(20);
  });
});

// ── Blatt-Ebene (2D-Zeichnung auf dem Blatt) ────────────────────────────────

describe("Blatt-Ebene", () => {
  const lay = createLayout("l1", "Blatt 1", "a3", "landscape");
  const sheet = createSheetLevel("sheet-l1", lay);

  it("ist eine Zeichnungsebene mit Layout-Bezug", () => {
    expect(sheet).toEqual({ id: "sheet-l1", name: "Blatt 1", kind: "drawing", visible: true, locked: false, layoutId: "l1" });
    expect(isSheetLevel(sheet)).toBe(true);
    expect(isSheetLevel({ layoutId: undefined })).toBe(false);
    expect(isSheetLevel(undefined)).toBe(false);
  });

  it("wird über das Layout gefunden", () => {
    const p = { drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false }, sheet] } as unknown as Project;
    expect(sheetLevelOf(p, "l1")).toBe(sheet);
    expect(sheetLevelOf(p, "nope")).toBeUndefined();
  });

  it("Papier-mm ↔ Meter (1:1, y nach unten = −y), hin und zurück", () => {
    expect(sheetMmToModel(420, 297)).toEqual({ x: 0.42, y: -0.297 });
    expect(sheetModelToMm({ x: 0.42, y: -0.297 })).toEqual({ xMm: 420, yMm: 297 });
    expect(SHEET_SCALE_DENOMINATOR).toBe(1);
  });
});

describe("resolveViewportScale", () => {
  const s = snap("s1", { scaleDenominator: 200 });
  it("Viewport-Override gewinnt", () => {
    expect(resolveViewportScale(createViewport("v", "s1", { scaleDenominator: 50 }), s)).toBe(50);
  });
  it("sonst Ausschnitt-Massstab", () => {
    expect(resolveViewportScale(createViewport("v", "s1"), s)).toBe(200);
  });
  it("Fallback ohne beides", () => {
    expect(resolveViewportScale(createViewport("v", "s1"), undefined, 100)).toBe(100);
  });
});

describe("findSnapshot / findMaster", () => {
  const p = project({
    viewSnapshots: [snap("s1"), snap("s2")],
    masterLayouts: [createMasterLayout("m1", "M1", "a4", "portrait")],
  });
  it("findSnapshot", () => {
    expect(findSnapshot(p, "s2")?.id).toBe("s2");
    expect(findSnapshot(p, "x")).toBeUndefined();
  });
  it("findMaster nur bei gesetzter masterId", () => {
    const bound: Layout = { ...createLayout("l", "L", "a4", "portrait"), masterId: "m1" };
    expect(findMaster(p, bound)?.id).toBe("m1");
    expect(findMaster(p, createLayout("l2", "L2", "a4", "portrait"))).toBeUndefined();
    // Dangling masterId → undefined.
    expect(findMaster(p, { ...bound, masterId: "gone" })).toBeUndefined();
  });
});

describe("resolveTitleBlock — Master-Vererbung + Defaults", () => {
  const p = project({ name: "Villa Test", viewSnapshots: [snap("s1", { scaleDenominator: 50 })] });

  it("ohne Master: Defaults aus Projekt/Layout + Massstab aus erstem Viewport", () => {
    let l = createLayout("l1", "EG Grundriss", "a4", "portrait");
    l = addViewport(l, createViewport("v1", "s1"));
    const tb = resolveTitleBlock(p, l, undefined, "2026-07-07");
    expect(tb.projectName).toBe("Villa Test");
    expect(tb.sheetName).toBe("EG Grundriss");
    expect(tb.scale).toBe("1:50");
    expect(tb.date).toBe("2026-07-07");
    expect(tb.author).toBe("");
    expect(tb.planNumber).toBe("01"); // nicht in project.layouts → erste Nummer
    expect(tb.revision).toBeUndefined();
  });

  it("[79] Revisionsindex des Blatts steht im Titelblock", () => {
    const l = { ...createLayout("l1", "EG", "a4", "portrait"), revision: "C" };
    expect(resolveTitleBlock(p, l, undefined, "2026-07-07").revision).toBe("C");
  });

  it("Plannummer: laufend nach Reihenfolge, eigene Nummer übersteuert", () => {
    const a = createLayout("a", "A", "a4", "portrait");
    const b = createLayout("b", "B", "a4", "portrait");
    const pp = { ...p, layouts: [a, b] };
    expect(resolveTitleBlock(pp, b, undefined, "2026-07-07").planNumber).toBe("02");
    expect(resolveTitleBlock(pp, { ...b, planNumber: "A-101" }, undefined, "2026-07-07").planNumber).toBe("A-101");
  });

  it("Master-Werte übersteuern die Defaults", () => {
    const master: MasterLayout = {
      id: "m1",
      name: "M",
      paper: "a4",
      orientation: "portrait",
      titleBlock: { projectName: "Kundenprojekt", author: "GV", scale: "1:100" },
    };
    const l = createLayout("l1", "EG", "a4", "portrait");
    const tb = resolveTitleBlock(p, l, master, "2026-07-07");
    expect(tb.projectName).toBe("Kundenprojekt");
    expect(tb.author).toBe("GV");
    expect(tb.scale).toBe("1:100"); // Master-Wert schlägt den Viewport-Default
    expect(tb.sheetName).toBe("EG"); // leer im Master → Layout-Name
  });

  it("leere/whitespace Master-Felder fallen auf Defaults zurück", () => {
    const master: MasterLayout = {
      id: "m1",
      name: "M",
      paper: "a4",
      orientation: "portrait",
      titleBlock: { projectName: "  ", sheetName: "" },
    };
    const l = createLayout("l1", "OG", "a4", "portrait");
    const tb = resolveTitleBlock(p, l, master, "2026-07-07");
    expect(tb.projectName).toBe("Villa Test");
    expect(tb.sheetName).toBe("OG");
    expect(tb.scale).toBe("—"); // kein Viewport → kein Massstab
  });
});

describe("visibleCodesFromSnapshot", () => {
  it("nur sichtbare Codes landen im Set", () => {
    const codes = visibleCodesFromSnapshot(snap("s1"));
    expect([...codes].sort()).toEqual(["A", "C"]);
    expect(codes.has("B")).toBe(false);
  });
});

// ── Freie Grösse (custom übersteuert Papier) ──────────────────────────────────

describe("sheetSizeMm / effectiveSheetSizeMm — freie Grösse", () => {
  it("custom übersteuert paper/orientation, wenn beide positiv gesetzt", () => {
    expect(sheetSizeMm("a4", "portrait", 500, 300)).toEqual({ w: 500, h: 300 });
  });
  it("fällt auf paper zurück, wenn custom fehlt oder nicht positiv ist", () => {
    expect(sheetSizeMm("a4", "portrait", undefined, 300)).toEqual({ w: 210, h: 297 });
    expect(sheetSizeMm("a3", "landscape", 0, 300)).toEqual({ w: 420, h: 297 });
  });
  it("effectiveSheetSizeMm liest die Felder eines Layouts/Masters", () => {
    expect(
      effectiveSheetSizeMm({ paper: "a4", orientation: "portrait" }),
    ).toEqual({ w: 210, h: 297 });
    expect(
      effectiveSheetSizeMm({
        paper: "a4",
        orientation: "portrait",
        customWidthMm: 250,
        customHeightMm: 250,
      }),
    ).toEqual({ w: 250, h: 250 });
  });
});

describe("createMasterLayout — freie Grösse", () => {
  it("übernimmt custom Breite/Höhe, wenn übergeben", () => {
    const m = createMasterLayout("m", "M", "a4", "portrait", {
      widthMm: 400,
      heightMm: 250,
    });
    expect(m.customWidthMm).toBe(400);
    expect(m.customHeightMm).toBe(250);
  });
});

// ── Ordner-Baum (CRUD + Aufbau) ───────────────────────────────────────────────

function lay(id: string, folderId?: string): Layout {
  return {
    id,
    name: id,
    paper: "a4",
    orientation: "portrait",
    viewports: [],
    ...(folderId ? { folderId } : {}),
  };
}

describe("createLayoutFolder", () => {
  it("Wurzelordner ohne parentId", () => {
    expect(createLayoutFolder("f1", "Ordner")).toEqual({ id: "f1", name: "Ordner" });
  });
  it("Unterordner mit parentId", () => {
    expect(createLayoutFolder("f2", "Sub", "f1")).toEqual({
      id: "f2",
      name: "Sub",
      parentId: "f1",
    });
  });
  it("Master-Ordner trägt kind:\"master\"", () => {
    expect(createLayoutFolder("m1", "Master-Ordner", undefined, "master")).toEqual({
      id: "m1",
      name: "Master-Ordner",
      kind: "master",
    });
  });
  it("kind \"layout\"/undefined wird NICHT gesetzt (rückwärtskompatibel)", () => {
    expect(createLayoutFolder("l1", "Layout-Ordner", undefined, "layout")).toEqual({
      id: "l1",
      name: "Layout-Ordner",
    });
    expect(createLayoutFolder("l2", "Layout-Ordner", "p", undefined)).toEqual({
      id: "l2",
      name: "Layout-Ordner",
      parentId: "p",
    });
  });
});

describe("buildLayoutTree", () => {
  it("gruppiert Layouts in Ordner + Wurzel; Unterordner verschachtelt", () => {
    const folders: LayoutFolder[] = [
      createLayoutFolder("A", "A"),
      createLayoutFolder("B", "B", "A"),
    ];
    const layouts = [lay("root1"), lay("inA", "A"), lay("inB", "B")];
    const tree = buildLayoutTree(folders, layouts);
    expect(tree.rootLayouts.map((l) => l.id)).toEqual(["root1"]);
    expect(tree.rootFolders).toHaveLength(1);
    const a = tree.rootFolders[0];
    expect(a.folder.id).toBe("A");
    expect(a.layouts.map((l) => l.id)).toEqual(["inA"]);
    expect(a.subfolders).toHaveLength(1);
    expect(a.subfolders[0].folder.id).toBe("B");
    expect(a.subfolders[0].layouts.map((l) => l.id)).toEqual(["inB"]);
  });

  it("verwaiste Referenzen landen auf der Wurzel", () => {
    const tree = buildLayoutTree(
      [createLayoutFolder("orphan", "O", "missing")],
      [lay("ghost", "gone")],
    );
    // Ordner mit unbekanntem parent → Wurzel; Layout mit unbekanntem folder → Wurzel.
    expect(tree.rootFolders.map((f) => f.folder.id)).toEqual(["orphan"]);
    expect(tree.rootLayouts.map((l) => l.id)).toEqual(["ghost"]);
  });
});

// ── Master-Baum + Layout/Master-Trennung (kind) ──────────────────────────────

function mas(id: string, folderId?: string): MasterLayout {
  return {
    id,
    name: id,
    paper: "a4",
    orientation: "portrait",
    titleBlock: {},
    ...(folderId ? { folderId } : {}),
  };
}

describe("buildMasterTree", () => {
  it("gruppiert Master in Master-Ordner + Wurzel; Unterordner verschachtelt", () => {
    const folders: LayoutFolder[] = [
      createLayoutFolder("A", "A", undefined, "master"),
      createLayoutFolder("B", "B", "A", "master"),
    ];
    const masters = [mas("root1"), mas("inA", "A"), mas("inB", "B")];
    const tree = buildMasterTree(folders, masters);
    expect(tree.rootMasters.map((m) => m.id)).toEqual(["root1"]);
    expect(tree.rootFolders).toHaveLength(1);
    const a = tree.rootFolders[0];
    expect(a.folder.id).toBe("A");
    expect(a.masters.map((m) => m.id)).toEqual(["inA"]);
    expect(a.subfolders[0].masters.map((m) => m.id)).toEqual(["inB"]);
  });
});

describe("Layout-/Master-Ordner bleiben getrennt (kind-Filter)", () => {
  it("Master-Ordner erscheint NICHT im Layout-Baum und umgekehrt", () => {
    const folders: LayoutFolder[] = [
      createLayoutFolder("L", "Layout-Ordner"), // kind fehlt → Layout
      createLayoutFolder("M", "Master-Ordner", undefined, "master"),
    ];
    const layouts = [lay("l1", "L"), lay("lm", "M")]; // lm zeigt fälschlich auf Master-Ordner
    const masters = [mas("m1", "M"), mas("ml", "L")]; // ml zeigt fälschlich auf Layout-Ordner

    // Wie das Panel filtert: Layout-Baum nur kind!=="master", Master-Baum nur kind==="master".
    const layoutTree = buildLayoutTree(
      folders.filter((f) => f.kind !== "master"),
      layouts,
    );
    const masterTree = buildMasterTree(
      folders.filter((f) => f.kind === "master"),
      masters,
    );

    // Layout-Baum kennt nur den Layout-Ordner; das auf M zeigende Layout fällt auf die Wurzel.
    expect(layoutTree.rootFolders.map((f) => f.folder.id)).toEqual(["L"]);
    expect(layoutTree.rootLayouts.map((l) => l.id)).toEqual(["lm"]);
    // Master-Baum kennt nur den Master-Ordner; der auf L zeigende Master fällt auf die Wurzel.
    expect(masterTree.rootFolders.map((f) => f.folder.id)).toEqual(["M"]);
    expect(masterTree.rootMasters.map((m) => m.id)).toEqual(["ml"]);
    expect(masterTree.rootFolders[0].masters.map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("deleteMasterFolder", () => {
  it("zieht Master + Unterordner auf die Elternebene und erhält kind:\"master\"", () => {
    const folders: LayoutFolder[] = [
      createLayoutFolder("A", "A", undefined, "master"),
      createLayoutFolder("B", "B", "A", "master"),
    ];
    const masters = [mas("a1", "A"), mas("b1", "B")];
    const r = deleteMasterFolder("A", folders, masters);
    expect(r.folders.map((f) => f.id)).toEqual(["B"]);
    // B auf Wurzel hochgezogen, aber weiterhin Master-Ordner.
    expect(r.folders[0].parentId).toBeUndefined();
    expect(r.folders[0].kind).toBe("master");
    expect(r.masters.find((m) => m.id === "a1")!.folderId).toBeUndefined();
    expect(r.masters.find((m) => m.id === "b1")!.folderId).toBe("B");
  });
});

describe("collectFolderLayouts", () => {
  it("liefert direkte Blätter zuerst, dann rekursiv Unterordner (PDF-Reihenfolge)", () => {
    const folders: LayoutFolder[] = [
      createLayoutFolder("A", "A"),
      createLayoutFolder("B", "B", "A"),
    ];
    const layouts = [lay("root1"), lay("a1", "A"), lay("a2", "A"), lay("b1", "B")];
    expect(collectFolderLayouts("A", folders, layouts).map((l) => l.id)).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
    expect(collectFolderLayouts("B", folders, layouts).map((l) => l.id)).toEqual([
      "b1",
    ]);
  });
  it("unbekannter Ordner → leer", () => {
    expect(collectFolderLayouts("nope", [], [lay("x")])).toEqual([]);
  });
});

describe("deleteFolder", () => {
  it("zieht Layouts + Unterordner auf die Elternebene (kein Datenverlust)", () => {
    const folders: LayoutFolder[] = [
      createLayoutFolder("A", "A"),
      createLayoutFolder("B", "B", "A"),
    ];
    const layouts = [lay("a1", "A"), lay("b1", "B")];
    // A (Wurzel) löschen → a1 auf Wurzel, B verliert parent → Wurzel.
    const r = deleteFolder("A", folders, layouts);
    expect(r.folders.map((f) => f.id)).toEqual(["B"]);
    expect(r.folders[0].parentId).toBeUndefined();
    expect(r.layouts.find((l) => l.id === "a1")!.folderId).toBeUndefined();
    expect(r.layouts.find((l) => l.id === "b1")!.folderId).toBe("B");
  });
  it("Unterordner löschen zieht Kinder zum Grosselter", () => {
    const folders: LayoutFolder[] = [
      createLayoutFolder("A", "A"),
      createLayoutFolder("B", "B", "A"),
    ];
    const layouts = [lay("b1", "B")];
    const r = deleteFolder("B", folders, layouts);
    expect(r.folders.map((f) => f.id)).toEqual(["A"]);
    expect(r.layouts[0].folderId).toBe("A");
  });
});

describe("folderPdfPages", () => {
  it("plant Seiten in Baum-Reihenfolge mit effektiver Blattgrösse", () => {
    const master: MasterLayout = createMasterLayout("m", "M", "a3", "landscape");
    const layouts: Layout[] = [
      { ...lay("p1", "F"), masterId: "m" }, // erbt A3 quer vom Master
      { ...lay("p2", "F"), customWidthMm: 500, customHeightMm: 200 }, // freie Grösse
      lay("p3", "F"), // A4 hoch (Default)
    ];
    const p = project({
      layoutFolders: [createLayoutFolder("F", "F")],
      layouts,
      masterLayouts: [master],
    });
    const pages = folderPdfPages(p, "F");
    expect(pages.map((x) => x.layout.id)).toEqual(["p1", "p2", "p3"]);
    expect(pages[0]).toMatchObject({ widthMm: 420, heightMm: 297 }); // Master A3 quer
    expect(pages[1]).toMatchObject({ widthMm: 500, heightMm: 200 }); // custom
    expect(pages[2]).toMatchObject({ widthMm: 210, heightMm: 297 }); // A4 hoch
  });
  it("leerer/unbekannter Ordner → keine Seiten", () => {
    expect(folderPdfPages(project(), "nope")).toEqual([]);
  });
});

describe("PAGE_MM / Standard-Formate A0–A6 + B0–B6", () => {
  it("PAPER_FORMATS listet 14 Formate (A-Reihe, dann B-Reihe)", () => {
    expect(PAPER_FORMATS).toEqual([
      "a0", "a1", "a2", "a3", "a4", "a5", "a6",
      "b0", "b1", "b2", "b3", "b4", "b5", "b6",
    ]);
  });
  it("liefert offizielle ISO-216-Masse (Hochformat, mm)", () => {
    expect(sheetSizeMm("a0", "portrait")).toEqual({ w: 841, h: 1189 });
    expect(sheetSizeMm("a1", "portrait")).toEqual({ w: 594, h: 841 });
    expect(sheetSizeMm("a2", "portrait")).toEqual({ w: 420, h: 594 });
    expect(sheetSizeMm("a5", "portrait")).toEqual({ w: 148, h: 210 });
    expect(sheetSizeMm("a6", "portrait")).toEqual({ w: 105, h: 148 });
    expect(sheetSizeMm("b0", "portrait")).toEqual({ w: 1000, h: 1414 });
    expect(sheetSizeMm("b3", "portrait")).toEqual({ w: 353, h: 500 });
    expect(sheetSizeMm("b6", "portrait")).toEqual({ w: 125, h: 176 });
  });
  it("Querformat dreht die Basis (Beispiel A0)", () => {
    expect(sheetSizeMm("a0", "landscape")).toEqual({ w: 1189, h: 841 });
  });
  it("jedes Format hat eine definierte Grösse", () => {
    for (const f of PAPER_FORMATS) {
      const s = sheetSizeMm(f, "portrait");
      expect(s.w).toBeGreaterThan(0);
      expect(s.h).toBeGreaterThan(0);
    }
  });
});

describe("isDescendant — Zyklus-Schutz", () => {
  const folders: LayoutFolder[] = [
    createLayoutFolder("A", "A"),
    createLayoutFolder("B", "B", "A"),
    createLayoutFolder("C", "C", "B"),
    createLayoutFolder("X", "X"),
  ];
  it("ein Ordner ist sein eigener Nachfahre (self)", () => {
    expect(isDescendant(folders, "A", "A")).toBe(true);
  });
  it("erkennt direkte + tiefe Nachfahren", () => {
    expect(isDescendant(folders, "B", "A")).toBe(true);
    expect(isDescendant(folders, "C", "A")).toBe(true);
  });
  it("nicht-verwandte Ordner sind keine Nachfahren", () => {
    expect(isDescendant(folders, "X", "A")).toBe(false);
    expect(isDescendant(folders, "A", "B")).toBe(false);
  });
});

describe("moveLayoutToFolder", () => {
  const layouts = [lay("l1", "A"), lay("l2")];
  it("setzt folderId auf den Zielordner", () => {
    const r = moveLayoutToFolder(layouts, "l2", "A");
    expect(r.find((l) => l.id === "l2")!.folderId).toBe("A");
  });
  it("null → zurück auf Wurzel (folderId entfernt)", () => {
    const r = moveLayoutToFolder(layouts, "l1", null);
    expect(r.find((l) => l.id === "l1")!.folderId).toBeUndefined();
    expect("folderId" in r.find((l) => l.id === "l1")!).toBe(false);
  });
  it("unbekannte Id → unverändert", () => {
    expect(moveLayoutToFolder(layouts, "nope", "A")).toEqual(layouts);
  });
});

describe("moveFolderToFolder", () => {
  const folders: LayoutFolder[] = [
    createLayoutFolder("A", "A"),
    createLayoutFolder("B", "B", "A"),
    createLayoutFolder("X", "X"),
  ];
  it("setzt parentId auf den Zielordner", () => {
    const r = moveFolderToFolder(folders, "X", "A");
    expect(r.find((f) => f.id === "X")!.parentId).toBe("A");
  });
  it("null → zurück auf Wurzel (parentId entfernt)", () => {
    const r = moveFolderToFolder(folders, "B", null);
    expect(r.find((f) => f.id === "B")!.parentId).toBeUndefined();
  });
  it("kind bleibt beim Wurzel-Verschieben erhalten (Master-Ordner)", () => {
    const withMaster: LayoutFolder[] = [
      createLayoutFolder("P", "P", undefined, "master"),
      createLayoutFolder("Q", "Q", "P", "master"),
    ];
    const r = moveFolderToFolder(withMaster, "Q", null);
    const q = r.find((f) => f.id === "Q")!;
    expect(q.parentId).toBeUndefined();
    expect(q.kind).toBe("master");
  });
  it("Zyklus (in eigenen Nachfahren) → No-op, Original zurück", () => {
    expect(moveFolderToFolder(folders, "A", "B")).toEqual(folders);
  });
  it("in sich selbst → No-op", () => {
    expect(moveFolderToFolder(folders, "A", "A")).toEqual(folders);
  });
});

describe("Kern-Rechnung: Sonderfälle", () => {
  it("collectFolderLayouts endet auch bei kaputten Ketten (Kreis, Selbstverweis)", () => {
    const folders = [
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "a" },
      { id: "s", name: "S", parentId: "s" },
    ] as LayoutFolder[];
    const layouts = [{ id: "l", name: "L", paper: "a4", orientation: "portrait", viewports: [], folderId: "s" }] as Layout[];
    expect(collectFolderLayouts("zz", folders, layouts)).toEqual([]);
    expect(collectFolderLayouts("s", folders, layouts)).toEqual([]);
  });

  it("buildLayoutTree behält die Original-Objekte (Identität)", () => {
    const folder = { id: "f", name: "F" } as LayoutFolder;
    const layout = { id: "l", name: "L", paper: "a4", orientation: "portrait", viewports: [], folderId: "f" } as Layout;
    const tree = buildLayoutTree([folder], [layout]);
    expect(tree.rootFolders[0].folder).toBe(folder);
    expect(tree.rootFolders[0].layouts[0]).toBe(layout);
  });

  it("Titelblock trimmt wie JS (U+FEFF ja, U+0085 nein)", () => {
    const p = { id: "p", name: "Haus", layouts: [], viewSnapshots: [] } as unknown as Project;
    const l = { id: "x", name: "Blatt", paper: "a4", orientation: "portrait", viewports: [] } as Layout;
    const m = { id: "m", name: "M", paper: "a4", orientation: "portrait", border: true, titleBlock: { author: "﻿ Ann  ", date: "\u0085" } } as MasterLayout;
    const tb = resolveTitleBlock(p, l, m, "2026-01-01");
    expect(tb.author).toBe("Ann");
    expect(tb.date).toBe("\u0085");
  });
});
