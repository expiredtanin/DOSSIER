// Punktwolken im UI-Zustand ([27] Stufe 1). Bewusst KEIN `Project`-Feld: die Punkte (Millionen,
// zig MB) gehören nicht ins .obp, und das Modellfeld (`Project.pointClouds`, Vorschlag in TODO.md
// [27]) kommt erst mit dem Asset-Speicher. Bis dahin leben die Wolken nur in dieser Sitzung —
// nach dem Neuladen sind sie weg (bekannt, s. TODO).
//
// Kleiner externer Store (Muster `busyStore.ts`, `useSyncExternalStore`), weil Viewport (Anzeige),
// Lage-Panel (Liste/Einstellungen) und der Import-Dialog in getrennten Teilbäumen sitzen.

import { useSyncExternalStore } from "react";
import type { PointCloudData, PointCloudReport } from "../io/pointCloud";

export type PointColorMode = "rgb" | "intensity" | "class" | "height";

export const POINT_COLOR_MODES: readonly PointColorMode[] = ["rgb", "intensity", "class", "height"];

export interface PointCloudEntry {
  /** Laufnummer (auch die id im Renderer). */
  id: number;
  name: string;
  data: PointCloudData;
  visible: boolean;
  colorMode: PointColorMode;
  /** Punktgrösse in Bildschirm-Pixeln. */
  pointSize: number;
}

export const DEFAULT_POINT_SIZE = 2;
export const MIN_POINT_SIZE = 1;
export const MAX_POINT_SIZE = 10;

/** Ist der Farbmodus mit den Attributen der Wolke möglich? (Höhe immer.) */
export function colorModeAvailable(report: PointCloudReport, mode: PointColorMode): boolean {
  if (mode === "rgb") return report.hasColor;
  if (mode === "intensity") return report.hasIntensity;
  if (mode === "class") return report.hasClassification;
  return true;
}

/** Voreinstellung: gemessene Farbe, sonst Intensität, sonst Klassen, sonst Höhe. */
export function defaultColorMode(report: PointCloudReport): PointColorMode {
  return POINT_COLOR_MODES.find((m) => colorModeAvailable(report, m)) ?? "height";
}

let clouds: readonly PointCloudEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getPointClouds(): readonly PointCloudEntry[] {
  return clouds;
}

/** Fügt eine gelesene Wolke hinzu (sichtbar, Voreinstellungen aus dem Bericht); liefert die id. */
export function addPointCloud(name: string, data: PointCloudData): number {
  const id = nextId++;
  clouds = [
    ...clouds,
    { id, name, data, visible: true, colorMode: defaultColorMode(data.report), pointSize: DEFAULT_POINT_SIZE },
  ];
  emit();
  return id;
}

/** Ändert Sichtbarkeit/Farbmodus/Punktgrösse/Name (Unbekanntes wird ignoriert, Grösse geklemmt). */
export function updatePointCloud(
  id: number,
  patch: Partial<Pick<PointCloudEntry, "visible" | "colorMode" | "pointSize" | "name">>,
): void {
  let changed = false;
  clouds = clouds.map((c) => {
    if (c.id !== id) return c;
    changed = true;
    const next = { ...c, ...patch };
    if (!Number.isFinite(next.pointSize)) next.pointSize = c.pointSize;
    next.pointSize = Math.min(MAX_POINT_SIZE, Math.max(MIN_POINT_SIZE, next.pointSize));
    if (!POINT_COLOR_MODES.includes(next.colorMode)) next.colorMode = c.colorMode;
    return next;
  });
  if (changed) emit();
}

export function removePointCloud(id: number): void {
  const next = clouds.filter((c) => c.id !== id);
  if (next.length === clouds.length) return;
  clouds = next;
  emit();
}

export function clearPointClouds(): void {
  if (clouds.length === 0) return;
  clouds = [];
  emit();
}

export function usePointClouds(): readonly PointCloudEntry[] {
  return useSyncExternalStore(subscribe, getPointClouds, getPointClouds);
}

// ── Import-Anfrage (Menü, Drag & Drop, Panel-Knopf → Dialog) ────────────────────────────────

let pendingFile: File | null = null;
const importListeners = new Set<() => void>();
let fileInput: HTMLInputElement | null = null;

function emitImport(): void {
  for (const l of importListeners) l();
}

/** Öffnet den Import-Dialog für `file` (Drag & Drop, Datei-Auswahl). */
export function requestPointCloudImport(file: File): void {
  pendingFile = file;
  emitImport();
}

/** Schliesst den Import-Dialog. */
export function closePointCloudImport(): void {
  if (pendingFile === null) return;
  pendingFile = null;
  emitImport();
}

export function usePointCloudImportRequest(): File | null {
  return useSyncExternalStore(
    (l) => {
      importListeners.add(l);
      return () => importListeners.delete(l);
    },
    () => pendingFile,
    () => pendingFile,
  );
}

/** Der Dialog-Host meldet sein verstecktes Datei-Feld an (oder ab mit `null`). */
export function registerPointCloudFileInput(el: HTMLInputElement | null): void {
  fileInput = el;
}

/** Datei-Auswahl öffnen (Menü „Punktwolke importieren …"). Synchron im Klick, sonst blockt WebKit. */
export function openPointCloudFileDialog(): void {
  fileInput?.click();
}

/** Nur für Tests: Zustand zurücksetzen. */
export function resetPointCloudStoreForTests(): void {
  clouds = [];
  nextId = 1;
  pendingFile = null;
  fileInput = null;
}
