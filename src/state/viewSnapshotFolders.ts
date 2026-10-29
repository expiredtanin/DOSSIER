// Ausschnitte-Baum (Ordner + Ausschnitte) — reine, testbare Logik (DOSSIER A2).
//
// Enthält KEINE React-/DOM-Abhängigkeit: nur immutable CRUD auf ViewSnapshot-
// Ordnern und die Auflösung der flachen Listen zum verschachtelten Baum. Das
// UI-Wiring (App.tsx setProject, ViewSnapshotsPanel) baut hierauf auf.
//
// Baum-Rechnung (Aufbau, Löschen, Nachfahren-Test) im Rust-Kern ([K4] S3, `folder_tree.rs`, gemeinsam mit
// dem Layouts-Baum in `model/layoutModel.ts`); hier setzen die Fassaden die Knoten aus den Indizes des
// Kerns mit den Original-Objekten zusammen.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { ViewSnapshot, ViewSnapshotFolder } from "../model/types";
import { isDescendantFolder, treeBuild, treeDelete } from "../model/folderTree";

// ── Fabrik ───────────────────────────────────────────────────────────────────

/** Neuer, leerer Ausschnitte-Ordner (optional in `parentId`). */
export function createViewSnapshotFolder(
  id: string,
  name: string,
  parentId?: string,
): ViewSnapshotFolder {
  return { id, name, ...(parentId ? { parentId } : {}) };
}

// ── Baum-Aufbau ──────────────────────────────────────────────────────────────

/** Ein Ordner-Knoten: der Ordner, seine Unterordner und direkten Ausschnitte. */
export interface ViewSnapshotFolderNode {
  folder: ViewSnapshotFolder;
  subfolders: ViewSnapshotFolderNode[];
  snapshots: ViewSnapshot[];
}

/** Der aufgebaute Baum: Wurzel-Ausschnitte (ohne Ordner) + Wurzel-Ordner. */
export interface ViewSnapshotTree {
  /** Ausschnitte ohne (gültigen) `folderId` — auf Wurzelebene. */
  rootSnapshots: ViewSnapshot[];
  /** Ordner ohne (gültigen) `parentId` — auf Wurzelebene, je mit Unterbaum. */
  rootFolders: ViewSnapshotFolderNode[];
}

/**
 * Baut aus der flachen Ordner-/Ausschnitt-Liste den verschachtelten Baum. Robust
 * gegen verwaiste Referenzen: ein Ausschnitt mit unbekanntem `folderId` bzw. ein
 * Ordner mit unbekanntem `parentId` landet auf der Wurzelebene (so bleiben
 * Alt-/Teilprojekte sichtbar). Die Eingabe-Reihenfolge bleibt je Ebene erhalten.
 */
export function buildViewSnapshotTree(
  folders: ViewSnapshotFolder[],
  snapshots: ViewSnapshot[],
): ViewSnapshotTree {
  const shape = treeBuild(folders, snapshots);
  const nodes: ViewSnapshotFolderNode[] = folders.map((folder) => ({ folder, subfolders: [], snapshots: [] }));
  shape.nodes.forEach((n, i) => {
    nodes[i].subfolders = n.subfolders.map((j) => nodes[j]);
    nodes[i].snapshots = n.leaves.map((k) => snapshots[k]);
  });
  return {
    rootSnapshots: shape.rootLeaves.map((k) => snapshots[k]),
    rootFolders: shape.rootFolders.map((j) => nodes[j]),
  };
}

// ── Baum-Umsortieren (Drag & Drop) + Löschen ────────────────────────────────

/**
 * Ist `candidateId` gleich `rootId` oder ein Nachfahre von `rootId`? Für den
 * Zyklus-Schutz beim Ordner-in-Ordner-Verschieben: ein Ordner darf NICHT in sich
 * selbst oder einen seiner Nachfahren wandern (sonst löst sich der Ast vom Baum).
 * Robust gegen kaputte `parentId`-Ketten (bricht bei unbekannter Referenz ab).
 */
export function isDescendant(
  folders: ViewSnapshotFolder[],
  candidateId: string,
  rootId: string,
): boolean {
  return isDescendantFolder(folders, candidateId, rootId);
}

/**
 * Verschiebt einen Ausschnitt in einen anderen Ordner (immutabel). `folderId =
 * null` → zurück auf die Wurzelebene. No-op, wenn die Ausschnitt-Id fehlt.
 */
export function moveSnapshotToFolder(
  snapshots: ViewSnapshot[],
  snapshotId: string,
  folderId: string | null,
): ViewSnapshot[] {
  return snapshots.map((s) => {
    if (s.id !== snapshotId) return s;
    if (folderId) return { ...s, folderId };
    const next = { ...s };
    delete next.folderId;
    return next;
  });
}

/**
 * Verschiebt einen Ordner unter einen neuen Elternordner (immutabel).
 * `parentId = null` → Wurzelebene. Verhindert Zyklen: ein Ordner kann nicht in
 * sich selbst oder einen seiner Nachfahren wandern (dann No-op — Original zurück).
 */
export function moveFolder(
  folders: ViewSnapshotFolder[],
  folderId: string,
  parentId: string | null,
): ViewSnapshotFolder[] {
  if (parentId && isDescendant(folders, parentId, folderId)) return folders;
  return folders.map((f) => {
    if (f.id !== folderId) return f;
    if (parentId) return { ...f, parentId };
    return stripParentId(f);
  });
}

/**
 * Löscht einen Ordner (immutabel). Unterordner und Ausschnitte des Ordners
 * werden auf die Ebene des gelöschten Ordners (dessen `parentId`) hochgezogen,
 * statt mitgelöscht zu werden — es gehen keine Ausschnitte verloren. Liefert die
 * neuen `folders`/`snapshots`-Listen.
 */
export function deleteFolder(
  folderId: string,
  folders: ViewSnapshotFolder[],
  snapshots: ViewSnapshot[],
): { folders: ViewSnapshotFolder[]; snapshots: ViewSnapshot[] } {
  const plan = treeDelete(folders, snapshots, folderId);
  return {
    folders: plan.folders.map(([i, c]) =>
      c === null ? folders[i] : c.v ? { ...folders[i], parentId: c.v } : stripParentId(folders[i]),
    ),
    snapshots: snapshots.map((s, i) => {
      const c = plan.leaves[i];
      if (c === null) return s;
      return c.v ? { ...s, folderId: c.v } : stripFolderId(s);
    }),
  };
}

/** Ordner auf die Wurzelebene setzen (parentId entfernen). */
function stripParentId(folder: ViewSnapshotFolder): ViewSnapshotFolder {
  const next = { ...folder };
  delete next.parentId;
  return next;
}

/** Ausschnitt auf die Wurzelebene setzen (folderId entfernen). */
function stripFolderId(snap: ViewSnapshot): ViewSnapshot {
  const next = { ...snap };
  delete next.folderId;
  return next;
}
