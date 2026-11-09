// Zeichnungs-Reiter ([136]) — offene Ansichten über der Zeichenfläche, ENTKOPPELT von den Ausschnitten.
//
// Ein Reiter ist reiner UI-Zustand (nicht im Modell, kein Undo-Schritt): er merkt sich
// den Darstellungszustand, den er beim Verlassen hatte (`state`), und optional den Ausschnitt, aus dem er
// geöffnet wurde (`snapshotId`, nur für den Titel). Beim Speichern geht er als `uiState.viewTabs` in die
// Projektdatei (nicht ins Modell, kein Op; s. `uiStateForSave`), beim Öffnen wird er wiederhergestellt
// (`restoreViewTabs`: Reiter auf gelöschte Ausschnitte fallen weg). Ausschnitte (`Project.viewSnapshots`) leben allein im
// Panel „Ausschnitte"; einen Reiter schliessen löscht nie einen Ausschnitt, eine Änderung der Ansicht im
// Reiter schreibt nie still in den Ausschnitt zurück (dafür gibt es „Ausschnitt aktualisieren").
//
// Verhalten (wie in gängigen CAD-Programmen):
// - Klick auf einen Ausschnitt im Panel = im AKTIVEN Reiter anzeigen; Doppelklick / Knopf = in NEUEM Reiter.
// - „+" in der Reiterleiste = neuer Reiter mit der aktuellen Ansicht (kein Ausschnitt).
// - „×" schliesst nur den Reiter; der letzte Reiter bleibt immer offen.
// - Wird ein Ausschnitt gelöscht, bleiben seine Reiter offen (sie tragen ihren eigenen Zustand) und
//   behalten den letzten Namen als Titel; die Verbindung zum Ausschnitt fällt weg.
// - Neues/geöffnetes Projekt: ein einziger Reiter mit der aktuellen Ansicht.
//
// Pure Funktionen + ein kleiner externer Store (Muster liveScaleStore.ts).

import { useSyncExternalStore } from "react";
import type { Project, UiState } from "../model/types";
import type { ViewSnapshotState } from "./viewSnapshots";

export interface ViewTab {
  id: string;
  /** Ausschnitt, aus dem der Reiter geöffnet wurde (nur Titel/„Aktualisieren"), sonst undefiniert. */
  snapshotId?: string;
  /** Fester Titel (Reiter ohne Ausschnitt bzw. nach Löschen des Ausschnitts); leer = automatisch. */
  title?: string;
  /** Darstellungszustand beim letzten Verlassen; der aktive Reiter zeigt den Live-Zustand. */
  state?: ViewSnapshotState;
}

export interface ViewTabsState {
  tabs: ViewTab[];
  activeId: string;
}

let seq = 0;
export function newTabId(): string {
  seq += 1;
  return `tab-${Date.now().toString(36)}-${seq}`;
}

export function initialTabs(): ViewTabsState {
  const id = newTabId();
  return { tabs: [{ id }], activeId: id };
}

export function activeTab(s: ViewTabsState): ViewTab {
  return s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0];
}

/** Merkt den Live-Zustand im aktiven Reiter (vor einem Wechsel). */
export function storeActiveState(s: ViewTabsState, live: ViewSnapshotState): ViewTabsState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, state: live } : t)) };
}

/** Öffnet einen neuen Reiter rechts vom aktiven und aktiviert ihn. `live` = Zustand des bisherigen Reiters. */
export function openTab(
  s: ViewTabsState,
  tab: Omit<ViewTab, "id">,
  live?: ViewSnapshotState,
): ViewTabsState {
  const base = live ? storeActiveState(s, live) : s;
  const id = newTabId();
  const i = base.tabs.findIndex((t) => t.id === base.activeId);
  const tabs = [...base.tabs];
  tabs.splice(i < 0 ? tabs.length : i + 1, 0, { ...tab, id });
  return { tabs, activeId: id };
}

/** Aktiviert einen Reiter; liefert den neuen Stand und den Zustand, der anzuwenden ist (oder null). */
export function activateTab(
  s: ViewTabsState,
  id: string,
  live: ViewSnapshotState,
): { next: ViewTabsState; apply: ViewSnapshotState | null } {
  if (id === s.activeId || !s.tabs.some((t) => t.id === id)) return { next: s, apply: null };
  const stored = storeActiveState(s, live);
  const target = stored.tabs.find((t) => t.id === id)!;
  return { next: { ...stored, activeId: id }, apply: target.state ?? null };
}

/** Schliesst einen Reiter (nie den letzten). War er aktiv, wird der rechte (sonst linke) Nachbar aktiv;
 *  dessen gemerkter Zustand ist anzuwenden. Ausschnitte bleiben unberührt. */
export function closeTab(
  s: ViewTabsState,
  id: string,
): { next: ViewTabsState; apply: ViewSnapshotState | null } {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0 || s.tabs.length <= 1) return { next: s, apply: null };
  const tabs = s.tabs.filter((t) => t.id !== id);
  if (id !== s.activeId) return { next: { ...s, tabs }, apply: null };
  const neighbour = tabs[Math.min(i, tabs.length - 1)];
  return { next: { tabs, activeId: neighbour.id }, apply: neighbour.state ?? null };
}

/** Verbindet den aktiven Reiter mit einem Ausschnitt (Klick im Panel / Speichern). */
export function linkActiveTab(s: ViewTabsState, snapshotId: string): ViewTabsState {
  return {
    ...s,
    tabs: s.tabs.map((t) => (t.id === s.activeId ? { id: t.id, snapshotId, state: t.state } : t)),
  };
}

/** Ausschnitte gelöscht: Reiter bleiben offen, verlieren die Verbindung und behalten den letzten Namen. */
export function detachSnapshots(
  s: ViewTabsState,
  removed: { id: string; name: string }[],
): ViewTabsState {
  const names = new Map(removed.map((r) => [r.id, r.name]));
  if (!s.tabs.some((t) => t.snapshotId && names.has(t.snapshotId))) return s;
  return {
    ...s,
    tabs: s.tabs.map((t) =>
      t.snapshotId && names.has(t.snapshotId) ? { id: t.id, title: names.get(t.snapshotId), state: t.state } : t,
    ),
  };
}

/** Titel eines Reiters: Name des Ausschnitts (folgt Umbenennen), sonst fester Titel, sonst `fallback`
 *  (Name der Zeichnungsebene des Reiters). */
export function tabTitle(
  tab: ViewTab,
  snapshots: readonly { id: string; name: string }[],
  fallback: (tab: ViewTab) => string,
): string {
  const snap = tab.snapshotId ? snapshots.find((v) => v.id === tab.snapshotId) : undefined;
  return snap?.name ?? tab.title ?? fallback(tab);
}

// ── Store ───────────────────────────────────────────────────────────────────

let current: ViewTabsState = initialTabs();
const listeners = new Set<() => void>();

export function getViewTabs(): ViewTabsState {
  return current;
}

export function setViewTabs(next: ViewTabsState): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

// ── Mit dem Projekt sichern / wiederherstellen ([136]) ──────────────────────

/** Liest/setzt den Darstellungszustand der laufenden App (vom Panel-Host je Render eingetragen). */
export interface ViewStateBridge {
  live: () => ViewSnapshotState;
  apply: (st: ViewSnapshotState) => void;
}
let bridge: ViewStateBridge | null = null;

export function setViewStateBridge(b: ViewStateBridge | null): void {
  bridge = b;
}

/** Reiter für die Datei: der aktive trägt den Live-Zustand `live` (sonst seinen gemerkten). */
export function serializeViewTabs(s: ViewTabsState, live?: ViewSnapshotState): UiState {
  const tabs = s.tabs.map((t) => {
    const state = t.id === s.activeId && live ? live : t.state;
    return {
      id: t.id,
      ...(t.snapshotId ? { snapshotId: t.snapshotId } : {}),
      ...(t.title ? { title: t.title } : {}),
      ...(state ? { state: state as unknown as Record<string, unknown> } : {}),
    };
  });
  return { viewTabs: { tabs, activeId: s.activeId } };
}

/** `uiState` beim Speichern: aktuelle Reiter samt Live-Zustand des aktiven. */
export function uiStateForSave(): UiState {
  let live: ViewSnapshotState | undefined;
  try {
    live = bridge?.live();
  } catch {
    live = undefined;
  }
  return serializeViewTabs(current, live);
}

/**
 * Gesicherte Reiter aus einem geladenen Projekt. Reiter auf Ausschnitte, die es nicht mehr gibt, fallen
 * weg (war der aktive darunter, wird der nächste aktiv); fehlt das Feld oder bleibt kein Reiter,
 * `null` (dann gilt: ein Reiter mit der aktuellen Ansicht).
 */
export function restoreViewTabs(project: Pick<Project, "uiState" | "viewSnapshots">): ViewTabsState | null {
  const saved = project.uiState?.viewTabs;
  if (!saved || !Array.isArray(saved.tabs)) return null;
  const snapIds = new Set((project.viewSnapshots ?? []).map((v) => v.id));
  const seen = new Set<string>();
  const keep: ViewTab[] = [];
  let activeIndex = -1; // Position des aktiven Reiters unter den behaltenen (oder des nächsten)
  for (const raw of saved.tabs) {
    if (!raw || typeof raw.id !== "string" || !raw.id || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const dropped = typeof raw.snapshotId === "string" && !snapIds.has(raw.snapshotId);
    if (raw.id === saved.activeId && !dropped) activeIndex = keep.length;
    else if (raw.id === saved.activeId) activeIndex = -2; // nächster behaltener folgt
    if (dropped) continue;
    if (activeIndex === -2) activeIndex = keep.length;
    const state = raw.state && typeof raw.state === "object" ? (raw.state as unknown as ViewSnapshotState) : undefined;
    keep.push({
      id: raw.id,
      ...(typeof raw.snapshotId === "string" ? { snapshotId: raw.snapshotId } : {}),
      ...(typeof raw.title === "string" && raw.title ? { title: raw.title } : {}),
      ...(state ? { state } : {}),
    });
  }
  if (keep.length === 0) return null;
  const idx = activeIndex >= 0 ? activeIndex : activeIndex === -2 ? keep.length - 1 : 0;
  return { tabs: keep, activeId: keep[Math.min(idx, keep.length - 1)].id };
}

/**
 * Projekt geöffnet: gesicherte Reiter wiederherstellen (sonst ein Reiter) und den Zustand des aktiven
 * Reiters nach dem Neuaufbau der Ansichten anwenden.
 */
export function restoreViewTabsFromProject(project: Pick<Project, "uiState" | "viewSnapshots">): void {
  const restored = restoreViewTabs(project);
  if (!restored) {
    resetViewTabs();
    return;
  }
  setViewTabs(restored);
  const st = activeTab(restored).state;
  if (st && bridge) setTimeout(() => bridge?.apply(st), 0);
}

/** Neues/geöffnetes Projekt: ein Reiter mit der aktuellen Ansicht. */
export function resetViewTabs(): void {
  setViewTabs(initialTabs());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useViewTabs(): ViewTabsState {
  return useSyncExternalStore(subscribe, getViewTabs, getViewTabs);
}
