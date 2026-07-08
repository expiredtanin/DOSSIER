// Ausschnitte-Baum (Ordner + Ausschnitte) — reine, testbare Logik (DOSSIER A2).
//
// Enthält KEINE React-/DOM-Abhängigkeit: nur immutable CRUD auf ViewSnapshot-
// Ordnern und die Auflösung der flachen Listen zum verschachtelten Baum. Das
// UI-Wiring (App.tsx setProject, ViewSnapshotsPanel) baut hierauf auf.
//
// Spiegelbildlich zu `panels/layoutModel.ts` (Layouts-Baum), aber bewusst OHNE
// Import aus dort — Ausschnitte-spezifisch und entkoppelt gehalten.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { ViewSnapshot, ViewSnapshotFolder } from "../model/types";

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
  const folderIds = new Set(folders.map((f) => f.id));
  const nodes = new Map<string, ViewSnapshotFolderNode>();
  for (const f of folders) {
    nodes.set(f.id, { folder: f, subfolders: [], snapshots: [] });
  }

  const rootFolders: ViewSnapshotFolderNode[] = [];
  for (const f of folders) {
    const node = nodes.get(f.id)!;
    const parent =
      f.parentId && folderIds.has(f.parentId) ? nodes.get(f.parentId) : undefined;
    if (parent) parent.subfolders.push(node);
    else rootFolders.push(node);
  }

  const rootSnapshots: ViewSnapshot[] = [];
  for (const s of snapshots) {
    const node =
      s.folderId && folderIds.has(s.folderId) ? nodes.get(s.folderId) : undefined;
    if (node) node.snapshots.push(s);
    else rootSnapshots.push(s);
  }

  return { rootSnapshots, rootFolders };
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
  if (candidateId === rootId) return true;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const seen = new Set<string>();
  let cur = byId.get(candidateId);
  while (cur && cur.parentId && !seen.has(cur.id)) {
    if (cur.parentId === rootId) return true;
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return false;
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
  const target = folders.find((f) => f.id === folderId);
  const grandParentId = target?.parentId;
  const nextFolders = folders
    .filter((f) => f.id !== folderId)
    .map((f) =>
      f.parentId === folderId
        ? grandParentId
          ? { ...f, parentId: grandParentId }
          : stripParentId(f)
        : f,
    );
  const nextSnapshots = snapshots.map((s) =>
    s.folderId === folderId
      ? grandParentId
        ? { ...s, folderId: grandParentId }
        : stripFolderId(s)
      : s,
  );
  return { folders: nextFolders, snapshots: nextSnapshots };
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
