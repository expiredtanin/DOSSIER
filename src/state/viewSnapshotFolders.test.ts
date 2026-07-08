// Pure Tests für den Ausschnitte-Baum (state/viewSnapshotFolders.ts):
// Aufbau, Reparent, Zyklus-Schutz, verwaiste Referenzen, Löschen ohne
// Datenverlust. Kein React/DOM.

import { describe, it, expect } from "vitest";
import type { ViewSnapshot, ViewSnapshotFolder } from "../model/types";
import {
  buildViewSnapshotTree,
  createViewSnapshotFolder,
  deleteFolder,
  isDescendant,
  moveFolder,
  moveSnapshotToFolder,
} from "./viewSnapshotFolders";

/** Minimaler ViewSnapshot-Stub (nur id/name/folderId sind hier relevant). */
function snap(id: string, folderId?: string): ViewSnapshot {
  return {
    id,
    name: id,
    ...(folderId ? { folderId } : {}),
    viewType: "grundriss",
    view3d: "top",
    scaleDenominator: 100,
    detail: "mittel",
    activeLevelId: "L0",
    layerVisibility: {},
    drawingVisibility: {},
  } as ViewSnapshot;
}

function folder(id: string, parentId?: string): ViewSnapshotFolder {
  return createViewSnapshotFolder(id, id, parentId);
}

describe("createViewSnapshotFolder", () => {
  it("lässt parentId weg, wenn nicht gesetzt (Wurzelebene)", () => {
    const f = createViewSnapshotFolder("f1", "Ordner");
    expect(f).toEqual({ id: "f1", name: "Ordner" });
    expect("parentId" in f).toBe(false);
  });
  it("setzt parentId, wenn gegeben", () => {
    expect(createViewSnapshotFolder("f2", "Sub", "f1").parentId).toBe("f1");
  });
});

describe("buildViewSnapshotTree", () => {
  it("verschachtelt Ordner + Ausschnitte", () => {
    const folders = [folder("f1"), folder("f2", "f1")];
    const snaps = [snap("s0"), snap("s1", "f1"), snap("s2", "f2")];
    const tree = buildViewSnapshotTree(folders, snaps);
    expect(tree.rootSnapshots.map((s) => s.id)).toEqual(["s0"]);
    expect(tree.rootFolders).toHaveLength(1);
    const f1 = tree.rootFolders[0];
    expect(f1.folder.id).toBe("f1");
    expect(f1.snapshots.map((s) => s.id)).toEqual(["s1"]);
    expect(f1.subfolders).toHaveLength(1);
    expect(f1.subfolders[0].folder.id).toBe("f2");
    expect(f1.subfolders[0].snapshots.map((s) => s.id)).toEqual(["s2"]);
  });

  it("hebt Ausschnitt mit unbekanntem folderId auf die Wurzelebene (verwaist)", () => {
    const tree = buildViewSnapshotTree([folder("f1")], [snap("s1", "ghost")]);
    expect(tree.rootSnapshots.map((s) => s.id)).toEqual(["s1"]);
    expect(tree.rootFolders[0].snapshots).toHaveLength(0);
  });

  it("hebt Ordner mit unbekanntem parentId auf die Wurzelebene (verwaist)", () => {
    const tree = buildViewSnapshotTree([folder("f2", "ghost")], []);
    expect(tree.rootFolders.map((n) => n.folder.id)).toEqual(["f2"]);
  });

  it("bewahrt die Eingabe-Reihenfolge je Ebene", () => {
    const folders = [folder("b"), folder("a")];
    const snaps = [snap("s2"), snap("s1")];
    const tree = buildViewSnapshotTree(folders, snaps);
    expect(tree.rootFolders.map((n) => n.folder.id)).toEqual(["b", "a"]);
    expect(tree.rootSnapshots.map((s) => s.id)).toEqual(["s2", "s1"]);
  });
});

describe("isDescendant", () => {
  const folders = [folder("f1"), folder("f2", "f1"), folder("f3", "f2")];
  it("erkennt sich selbst", () => {
    expect(isDescendant(folders, "f1", "f1")).toBe(true);
  });
  it("erkennt echten Nachfahren (transitiv)", () => {
    expect(isDescendant(folders, "f3", "f1")).toBe(true);
  });
  it("verneint Nicht-Nachfahren", () => {
    expect(isDescendant(folders, "f1", "f3")).toBe(false);
  });
  it("bricht bei kaputter parentId-Kette ab (kein Absturz)", () => {
    expect(isDescendant([folder("x", "ghost")], "x", "f1")).toBe(false);
  });
});

describe("moveSnapshotToFolder", () => {
  it("setzt folderId", () => {
    const out = moveSnapshotToFolder([snap("s1")], "s1", "f1");
    expect(out[0].folderId).toBe("f1");
  });
  it("entfernt folderId bei null (Wurzelebene)", () => {
    const out = moveSnapshotToFolder([snap("s1", "f1")], "s1", null);
    expect("folderId" in out[0]).toBe(false);
  });
  it("no-op bei unbekannter Id", () => {
    const input = [snap("s1", "f1")];
    expect(moveSnapshotToFolder(input, "ghost", null)).toEqual(input);
  });
});

describe("moveFolder", () => {
  const folders = [folder("f1"), folder("f2", "f1"), folder("f3")];
  it("hängt Ordner unter neuen Elternordner", () => {
    const out = moveFolder(folders, "f3", "f1");
    expect(out.find((f) => f.id === "f3")!.parentId).toBe("f1");
  });
  it("verschiebt auf Wurzelebene bei null", () => {
    const out = moveFolder(folders, "f2", null);
    expect("parentId" in out.find((f) => f.id === "f2")!).toBe(false);
  });
  it("verhindert Zyklus: Ordner in eigenen Nachfahren (No-op)", () => {
    expect(moveFolder(folders, "f1", "f2")).toEqual(folders);
  });
  it("verhindert Ordner in sich selbst (No-op)", () => {
    expect(moveFolder(folders, "f1", "f1")).toEqual(folders);
  });
});

describe("deleteFolder", () => {
  it("zieht Unterordner + Ausschnitte auf die Elternebene (kein Datenverlust)", () => {
    // f1 > f2 > f3; s1 in f2. f2 löschen → f3 & s1 hängen an f1.
    const folders = [folder("f1"), folder("f2", "f1"), folder("f3", "f2")];
    const snaps = [snap("s1", "f2")];
    const out = deleteFolder("f2", folders, snaps);
    expect(out.folders.map((f) => f.id).sort()).toEqual(["f1", "f3"]);
    expect(out.folders.find((f) => f.id === "f3")!.parentId).toBe("f1");
    expect(out.snapshots[0].folderId).toBe("f1");
  });

  it("zieht auf die Wurzelebene, wenn der gelöschte Ordner an der Wurzel lag", () => {
    const folders = [folder("f1"), folder("f2", "f1")];
    const snaps = [snap("s1", "f1")];
    const out = deleteFolder("f1", folders, snaps);
    expect(out.folders).toHaveLength(1);
    expect("parentId" in out.folders[0]).toBe(false); // f2 an Wurzel
    expect("folderId" in out.snapshots[0]).toBe(false); // s1 an Wurzel
  });

  it("no-op bei unbekannter Ordner-Id", () => {
    const folders = [folder("f1")];
    const snaps = [snap("s1", "f1")];
    const out = deleteFolder("ghost", folders, snaps);
    expect(out.folders).toEqual(folders);
    expect(out.snapshots).toEqual(snaps);
  });
});
