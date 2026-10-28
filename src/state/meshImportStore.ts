// Import-Anfrage für 3D-Modelle (OBJ/STL/glTF/GLB/PLY): Menü, Drag & Drop → Dialog (`ui/MeshImportDialog.tsx`).
// Kleiner externer Store (Muster `pointCloudStore.ts`): UI-Zustand, kein Teil des Projekts. Die Anfrage
// besteht aus der Hauptdatei und den mitgegebenen Begleitdateien (`.mtl`, `.bin`).

import { useSyncExternalStore } from "react";
import { isMeshFile, isMeshSidecar } from "../io/meshImport";

export interface MeshImportRequest {
  file: File;
  sidecars: File[];
}

let pending: MeshImportRequest | null = null;
let fileInput: HTMLInputElement | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Teilt eine Dateiliste in Hauptdatei (erste Mesh-Datei) und Begleitdateien; `null` ohne Mesh-Datei. */
export function splitMeshFiles(files: readonly File[]): MeshImportRequest | null {
  const file = files.find((f) => isMeshFile(f.name));
  if (!file) return null;
  return { file, sidecars: files.filter((f) => f !== file && isMeshSidecar(f.name)) };
}

/** Öffnet den Import-Dialog. */
export function requestMeshImport(file: File, sidecars: File[] = []): void {
  pending = { file, sidecars };
  emit();
}

/** Schliesst den Import-Dialog. */
export function closeMeshImport(): void {
  if (pending === null) return;
  pending = null;
  emit();
}

export function useMeshImportRequest(): MeshImportRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
    () => pending,
  );
}

/** Der Dialog-Host meldet sein verstecktes Datei-Feld an (oder ab mit `null`). */
export function registerMeshFileInput(el: HTMLInputElement | null): void {
  fileInput = el;
}

/** Datei-Auswahl öffnen (Menü „3D-Modell importieren …"). Synchron im Klick, sonst blockt WebKit. */
export function openMeshFileDialog(): void {
  fileInput?.click();
}

/** Nur für Tests: Zustand zurücksetzen. */
export function resetMeshImportStoreForTests(): void {
  pending = null;
  fileInput = null;
}
