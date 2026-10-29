// Ordner-Bäume im Rust-Kern ([K4] S3, `src-tauri/core/src/folder_tree.rs`): Layouts-, Master- und
// Ausschnitte-Baum teilen dieselbe Rechnung. Der Kern rechnet auf Indizes der Eingabelisten (nur `id`,
// `parentId` bzw. `folderId` gehen hinüber); die Fassaden (`layoutModel.ts`, `state/viewSnapshotFolders.ts`)
// setzen daraus die Knoten mit den ORIGINAL-Objekten zusammen — Objekt-Identitäten bleiben.

import { core } from "../engine/coreWasm";

/** Ordner, soweit der Kern ihn liest. */
interface FolderLike {
  id: string;
  parentId?: string;
}

/** Blatt (Layout, Master, Ausschnitt), soweit der Kern es liest. */
interface LeafLike {
  folderId?: string;
}

/** Baum als Indizes: Knoten je Ordner (Unterordner = Knoten-Indizes, Blätter = Blatt-Indizes). */
export interface TreeShape {
  rootLeaves: number[];
  rootFolders: number[];
  nodes: { subfolders: number[]; leaves: number[] }[];
}

/** Änderung eines Verweises: `v` = neuer Wert, `null` = Schlüssel entfernen. */
export interface RefChange {
  v: string | null;
}

/** Ergebnis von {@link treeDelete}: behaltene Ordner (Eingabe-Index, Änderung von `parentId`), Änderung je Blatt. */
export interface DeletePlan {
  folders: [number, RefChange | null][];
  leaves: (RefChange | null)[];
}

const folderRefs = (folders: readonly FolderLike[]) => folders.map((f) => ({ id: f.id, parentId: f.parentId }));
const leafRefs = (leaves: readonly LeafLike[]) => leaves.map((l) => ({ folderId: l.folderId }));

function call<T>(name: string, arg: unknown): T {
  const out = core().layout_call(name, JSON.stringify(arg));
  if (out === "") throw new Error(`Kern: Ordner-Baum-Rechnung „${name}" fehlgeschlagen`);
  return JSON.parse(out) as T;
}

/** Baum aus flachen Listen (verwaiste Verweise landen auf der Wurzel; Eingabe-Reihenfolge je Ebene bleibt). */
export function treeBuild(folders: readonly FolderLike[], leaves: readonly LeafLike[]): TreeShape {
  return call("treeBuild", { folders: folderRefs(folders), leaves: leafRefs(leaves) });
}

/** Blatt-Indizes eines Ordners in Baum-Reihenfolge (direkte zuerst, dann die der Unterordner). */
export function treeCollect(folders: readonly FolderLike[], leaves: readonly LeafLike[], folderId: string): number[] {
  return call("treeCollect", { folders: folderRefs(folders), leaves: leafRefs(leaves), folderId });
}

/** Ist `candidateId` gleich `rootId` oder ein Nachfahre von `rootId`? (Zyklenschutz beim Verschieben.) */
export function isDescendantFolder(folders: readonly FolderLike[], candidateId: string, rootId: string): boolean {
  return call("isDescendant", { folders: folderRefs(folders), candidate: candidateId, root: rootId });
}

/** Plan für das Löschen eines Ordners: Unterordner und Blätter rücken auf den Elternordner. */
export function treeDelete(folders: readonly FolderLike[], leaves: readonly LeafLike[], folderId: string): DeletePlan {
  return call("treeDelete", { folders: folderRefs(folders), leaves: leafRefs(leaves), folderId });
}
