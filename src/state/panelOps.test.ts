// Typ-CRUD (`useProjectActions`) und Panel-Aktionen (`usePanelHostBase`) liefern ihre Änderung als Ops
// ([K4] S3): „applyOps(vorher, Ops) == erwartetes Ergebnis". Beim Umbau wurden dieselben Schritte
// gegen die alte setProject-Fassung (git HEAD) verglichen: Typ-CRUD und 46 Panel-Aktionen, gleich.
// Die Hooks laufen hier über `renderToString` (kein DOM nötig) und geben ihre Closures heraus.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { applyOps } from "../core/ops";
import type { CoreOp } from "../core/ops";
import { useProjectActions } from "./useProjectActions";
import { usePanelHostBase } from "./usePanelHostBase";

/* eslint-disable @typescript-eslint/no-explicit-any */
function capture<T>(f: () => T): T {
  let out: T | undefined;
  renderToString(
    createElement(() => {
      out = f();
      return null;
    }),
  );
  return out as T;
}

/** Platzhalter für die vielen Zustandsfelder, die die getesteten Aktionen nicht anfassen. */
function deepStub(): any {
  const fn = function () {
    return undefined;
  };
  return new Proxy(fn, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : deepStub()),
    apply: () => undefined,
  });
}
function stubObj(over: Record<string, unknown>): any {
  return new Proxy(over, {
    get: (t, k) => (k in t ? (t as any)[k] : typeof k === "symbol" ? undefined : deepStub()),
  });
}

/** Zustandshalter: Ops anwenden wie der Store. */
function holder(start: Project) {
  const h = {
    p: start,
    notes: [] as string[],
    applyChange: (c: readonly CoreOp[] | ((p: Project) => readonly CoreOp[])) => {
      h.p = applyOps(h.p, typeof c === "function" ? c(h.p) : c);
    },
  };
  return h;
}

describe("useProjectActions: Typ-CRUD über Ops", () => {
  it("Anlegen, Ändern, geschütztes Löschen, Stil speichern", () => {
    const h = holder({ ...sampleProject, doorTypes: [], windowTypes: [], stairTypes: [], roofTypes: [] });
    const a = capture(() => useProjectActions(h.applyChange, (m) => h.notes.push(m), { current: null }));
    const wt = h.p.wallTypes[0].id;
    const nWall = h.p.wallTypes.length;

    a.addWallType();
    expect(h.p.wallTypes).toHaveLength(nWall + 1);
    expect(h.p.wallTypes[nWall].layers).toHaveLength(1);
    a.patchWallType(wt, { name: "Neu" });
    expect(h.p.wallTypes[0].name).toBe("Neu");
    a.deleteWallType(wt); // wird von Wänden verwendet
    expect(h.p.wallTypes).toHaveLength(nWall + 1);
    expect(h.notes).toHaveLength(1);
    a.deleteWallType(h.p.wallTypes[nWall].id);
    expect(h.p.wallTypes).toHaveLength(nWall);

    a.addDoorType();
    a.addWindowType();
    a.addStairType();
    a.addRoofType();
    a.addCeilingType();
    expect([h.p.doorTypes!.length, h.p.windowTypes!.length, h.p.stairTypes!.length, h.p.roofTypes!.length]).toEqual([1, 1, 1, 1]);
    a.patchDoorType(h.p.doorTypes![0].id, { name: "T" });
    expect(h.p.doorTypes![0].name).toBe("T");

    const opening = (h.p.openings ?? [])[0];
    if (opening) {
      a.saveOpeningStyle(opening.id, "Mein Stil");
      const after = h.p.openings!.find((o) => o.id === opening.id)!;
      const list = opening.kind === "door" ? h.p.doorTypes! : h.p.windowTypes!;
      expect(list.some((t) => t.id === after.typeId && t.name === "Mein Stil")).toBe(true);
    }

    a.setOverrideRules([]);
    expect(h.p.overrideRules).toEqual([]);
    a.deleteDoorType(h.p.doorTypes![0].id);
    expect(h.p.doorTypes!.some((d) => d.name === "T")).toBe(false);
  });
});

const L0 = sampleProject.drawingLevels[0].id;
const base: Project = {
  ...sampleProject,
  columns: [
    { id: "col1", type: "column", floorId: L0, categoryCode: "20", position: { x: 1, y: 1 }, height: 3, rotation: 0, profile: { kind: "rect", width: 0.3, depth: 0.3 } },
    { id: "col2", type: "column", floorId: L0, categoryCode: "20", position: { x: 3, y: 1 }, height: 3, rotation: 0, profile: { kind: "round", radius: 0.2 } },
  ] as any,
  extrudedSolids: [{ id: "ex1", type: "extrudedSolid", levelId: L0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], height: 1 }] as any,
  context: [{ id: "img1", type: "image", min: { x: 0, y: 0 }, max: { x: 1, y: 1 }, opacity: 1 }] as any,
  viewSnapshots: [{ id: "vs-1", name: "A", state: {} }, { id: "vs-2", name: "B", state: {} }] as any,
  viewSnapshotFolders: [{ id: "vsf-1", name: "F" }] as any,
  layouts: [{ id: "lay-1", name: "L1", masterId: "mas-1" }, { id: "lay-2", name: "L2" }] as any,
  masterLayouts: [{ id: "mas-1", name: "M1" }] as any,
  layoutFolders: [{ id: "folder-1", name: "LF" }, { id: "mfolder-1", name: "MF", kind: "master" }] as any,
};

function host(h: ReturnType<typeof holder>, selection: any) {
  (globalThis as any).requestAnimationFrame = () => 0;
  return capture(() =>
    usePanelHostBase({
      project: h.p,
      setProject: (n: any) => {
        h.p = typeof n === "function" ? n(h.p) : n;
      },
      applyChange: h.applyChange,
      activeLevelId: L0,
      setActiveLevelId: () => {},
      setViewType: () => {},
      activeLevel: sampleProject.drawingLevels[0],
      viewType: "grundriss",
      selection,
      projectActions: stubObj({ snapshotLayerVisibility: () => ({}), snapshotDrawingVisibility: () => ({}), applyLayerVisibility: () => {}, applyDrawingVisibility: () => {} }),
      selectionState: stubObj({ selectedContextObjectIds: [] }),
      toolState: stubObj({}),
      topBarState: stubObj({}),
      dialogState: stubObj({ setActiveLayoutId: () => {} }),
      contextMenuState: stubObj({}),
      engineView: { commandName: null },
      planViewRef: { current: null },
      dxfInputRef: { current: null },
      activeLayout: undefined,
      patchOpenLayout: () => {},
    } as any),
  ) as any;
}

describe("usePanelHostBase: Panel-Aktionen über Ops", () => {
  it("Stützen, Extrusionen, Kontext-Bild", () => {
    const h = holder(base);
    host(h, { kind: "column", id: "col1" }).onSetColumnWidth(0.5);
    expect((h.p.columns![0].profile as any).width).toBe(0.5);
    host(h, { kind: "column", id: "col2" }).onSetColumnWidth(0.5); // runde Stütze: keine Breite
    expect(h.p.columns![1].profile).toEqual({ kind: "round", radius: 0.2 });
    host(h, { kind: "column", id: "col1" }).onSetColumnProfileKind("round");
    expect(h.p.columns![0].profile).toEqual({ kind: "round", radius: 0.25 });
    host(h, { kind: "column", id: "col1" }).onSetColumnRotation(90);
    expect(h.p.columns![0].rotation).toBeCloseTo(Math.PI / 2, 12);
    host(h, { kind: "column", id: "col1" }).onSetSelectionLevel("og");
    expect(h.p.columns![0].floorId).toBe("og");
    expect(h.p.columns![1]).toBe(base.columns![1]); // unberührt: gleiche Referenz
    host(h, { kind: "extrudedSolid", id: "ex1" }).onSetExtrudedSolidHeight(2.5);
    host(h, { kind: "extrudedSolid", id: "ex1" }).onSetExtrudedSolidSubtract(true);
    expect(h.p.extrudedSolids![0]).toMatchObject({ height: 2.5, operation: "subtract" });
    host(h, { kind: "contextObject", id: "img1" }).onSetSelectionOpacity(0.4);
    expect((h.p.context![0] as any).opacity).toBe(0.4);
    host(h, null).onSetGeoAnchor({ lv95: { e: 1, n: 2 }, model: { x: 0, y: 0 } });
    expect(h.p.geoAnchor).toEqual({ lv95: { e: 1, n: 2 }, model: { x: 0, y: 0 } });
  });

  it("Ausschnitte und Ordner", () => {
    const h = holder(base);
    const a = host(h, null);
    a.onRenameViewSnapshot("vs-1", "  Neu A ");
    expect(h.p.viewSnapshots![0].name).toBe("Neu A");
    a.onMoveViewSnapshotToFolder("vs-2", "vsf-1");
    expect((h.p.viewSnapshots![1] as any).folderId).toBe("vsf-1");
    const id = a.onCaptureViewSnapshot("Neu", "vsf-1");
    expect(h.p.viewSnapshots!.at(-1)!.id).toBe(id);
    a.onDeleteViewSnapshot("vs-2");
    expect(h.p.viewSnapshots!.map((s) => s.id)).toEqual(["vs-1", id]);
    a.onDeleteViewSnapshotFolder("vsf-1");
    expect(h.p.viewSnapshotFolders).toEqual([]);
  });

  it("Layouts, Masterlayouts, Layout-Ordner", () => {
    const h = holder(base);
    const a = host(h, null);
    a.onRenameLayout("lay-2", "Z");
    expect(h.p.layouts![1].name).toBe("Z");
    a.onDeleteMasterLayout("mas-1"); // löst die Bindung der Layouts
    expect(h.p.masterLayouts).toEqual([]);
    expect(h.p.layouts![0].masterId).toBeUndefined();
    a.onDeleteLayout("lay-1");
    expect(h.p.layouts!.map((l) => l.id)).toEqual(["lay-2"]);
    const id = a.onCreateLayout({ paper: "a4", orientation: "portrait", folderId: "folder-1" });
    expect(h.p.layouts!.at(-1)).toMatchObject({ id, folderId: "folder-1" });
    a.onMoveLayoutToFolder("lay-2", "folder-1");
    expect((h.p.layouts![0] as any).folderId).toBe("folder-1");
    a.onDeleteLayoutFolder("folder-1");
    expect(h.p.layoutFolders!.map((f) => f.id)).toEqual(["mfolder-1"]);
  });
});
