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
// - Reiter-Arten wie in Archicad ([182]): Grundriss, 3D, Schnitt, Ansicht, 2D-Zeichnung werden nie in einem
//   Reiter gemischt. Geschoss im Navigator wählen behält die Art des aktiven Reiters (3D bleibt 3D); Schnitt,
//   Ansicht, Zeichnung öffnen einen eigenen Reiter bzw. springen zum offenen; 3D/Grundriss sind aus jedem
//   Reiter erreichbar (`navigateToLevel`, `switchViewKind`).
//
// Pure Funktionen + ein kleiner externer Store (Muster liveScaleStore.ts).

import { useSyncExternalStore } from "react";
import type { DrawingLevel, Project, UiState } from "../model/types";
import type { ViewType } from "../model/viewTypes";
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

// ── Reiter-Arten und Navigation ([182]) ─────────────────────────────────────

export type TabKind = "plan" | "3d" | "section" | "elevation" | "drawing";
type LevelLite = Pick<DrawingLevel, "id" | "kind">;
type KindState = Pick<ViewSnapshotState, "viewType" | "activeLevelId">;

/** Reiter-Art, die eine Zeichnungsebene (ohne 3D) öffnet. */
export function levelTabKind(kind: DrawingLevel["kind"]): Exclude<TabKind, "3d"> {
  return kind === "floor" ? "plan" : kind === "section" ? "section" : kind === "elevation" ? "elevation" : "drawing";
}

/** Ist der Reiter ein Grundriss-Reiter (Hervorhebung des Grundriss-Knopfs)? Schnitt/Ansicht/Zeichnung/3D: nein. */
export function isPlanKindActive(viewType: ViewSnapshotState["viewType"], levelKind: DrawingLevel["kind"]): boolean {
  return viewType !== "perspektive" && levelTabKind(levelKind) === "plan";
}

/** Art eines Reiters aus seinem Darstellungszustand (`null`: unbekannt, z. B. ohne gemerkten Zustand). */
export function tabKindOf(st: KindState | undefined, levels: readonly LevelLite[]): TabKind | null {
  if (!st) return null;
  if (st.viewType === "perspektive") return "3d";
  const level = levels.find((l) => l.id === st.activeLevelId);
  return level ? levelTabKind(level.kind) : null;
}

/** Ergebnis einer Reiter-Navigation: neuer Reiter-Stand, anzuwendender Zustand und/oder nur Geschosswechsel im selben Reiter. */
export interface TabNav {
  next: ViewTabsState;
  /** Voller Zustand, der anzuwenden ist (anderer/neuer Reiter), sonst `null`. */
  apply: ViewSnapshotState | null;
  /** Gleicher Reiter, nur das aktive Geschoss wechselt (Ansichtsart bleibt). */
  setLevel?: string;
}

function noCamera(st: ViewSnapshotState): ViewSnapshotState {
  const { cameraCenter: _c, cameraPxPerMeter: _p, ...rest } = st;
  return rest;
}

function firstFloor(levels: readonly LevelLite[]): string | undefined {
  return levels.find((l) => l.kind === "floor")?.id;
}

/** Geschoss für einen neuen 3D-/Grundriss-Reiter, wenn die aktuelle Ansicht keines hat. */
function lastFloorId(s: ViewTabsState, levels: readonly LevelLite[]): string | undefined {
  for (const t of s.tabs) {
    const k = tabKindOf(t.state, levels);
    if ((k === "plan" || k === "3d") && t.state) return t.state.activeLevelId;
  }
  return firstFloor(levels);
}

function activateOther(stored: ViewTabsState, tab: ViewTab, state: ViewSnapshotState): TabNav {
  return { next: { ...stored, activeId: tab.id }, apply: state };
}

function openNew(stored: ViewTabsState, state: ViewSnapshotState): TabNav {
  const id = newTabId();
  const i = stored.tabs.findIndex((t) => t.id === stored.activeId);
  const tabs = [...stored.tabs];
  tabs.splice(i < 0 ? tabs.length : i + 1, 0, { id, state });
  return { next: { tabs, activeId: id }, apply: state };
}

/**
 * Ebene im Navigator gewählt. Geschoss: im Grundriss-/3D-Reiter bleibt die Art, nur das Geschoss wechselt;
 * aus Schnitt/Ansicht/Zeichnung geht es in einen Grundriss-Reiter. Schnitt/Ansicht/Zeichnung: eigener
 * Reiter (der offene dieses Elements wird aktiv), nie ein umgebauter Grundriss-/3D-Reiter.
 */
export function navigateToLevel(
  s: ViewTabsState,
  live: ViewSnapshotState,
  levels: readonly DrawingLevel[] | readonly LevelLite[],
  levelId: string,
): TabNav {
  const level = levels.find((l) => l.id === levelId);
  if (!level) return { next: s, apply: null };
  const want = levelTabKind(level.kind);
  const liveKind = tabKindOf(live, levels);
  if (want === "plan" && (liveKind === "plan" || liveKind === "3d")) {
    // [204] Anderes Geschoss im selben Reiter: der Reiter zeigt keinen Ausschnitt mehr (Titel = Geschoss, wie Archicad);
    // sonst hiesse er weiter „EG 1:100" und „Ausschnitt aktualisieren" schriebe das OG in den EG-Ausschnitt.
    return live.activeLevelId === levelId ? { next: s, apply: null } : { next: unlinkActiveTab(s), apply: null, setLevel: levelId };
  }
  if (want !== "plan" && liveKind === want && live.activeLevelId === levelId) return { next: s, apply: null };
  const stored = storeActiveState(s, live);
  const others = stored.tabs.filter((t) => t.id !== stored.activeId);
  if (want === "plan") {
    const same = others.find((t) => tabKindOf(t.state, levels) === "plan" && t.state!.activeLevelId === levelId);
    const any = same ?? others.find((t) => tabKindOf(t.state, levels) === "plan");
    if (any) return activateOther(stored, any, { ...any.state!, activeLevelId: levelId });
  } else {
    const found = others.find((t) => tabKindOf(t.state, levels) === want && t.state!.activeLevelId === levelId);
    if (found) return activateOther(stored, found, found.state!);
  }
  return openNew(stored, noCamera({ ...live, viewType: "grundriss", activeLevelId: levelId }));
}

/**
 * „Grundriss" bzw. „3D" gewählt (Werkzeugleiste, Menü, Kürzel): aus jedem Reiter erreichbar, wechselt zum
 * passenden Reiter (bei Grundriss/3D mit dem aktiven Geschoss) oder öffnet ihn. Schnitt-/Ansichts-Reiter
 * werden nie umgebaut.
 */
export function switchViewKind(
  s: ViewTabsState,
  live: ViewSnapshotState,
  levels: readonly DrawingLevel[] | readonly LevelLite[],
  want: ViewType,
): TabNav {
  const wantKind: TabKind = want === "perspektive" ? "3d" : "plan";
  const liveKind = tabKindOf(live, levels);
  if (liveKind === wantKind) return { next: s, apply: null };
  // Geschoss mitnehmen, wenn die aktuelle Ansicht ein Geschoss zeigt (Grundriss ↔ 3D).
  const carry = liveKind === "plan" || liveKind === "3d" ? live.activeLevelId : undefined;
  const stored = storeActiveState(s, live);
  const others = stored.tabs.filter((t) => t.id !== stored.activeId);
  const sameKind = others.filter((t) => tabKindOf(t.state, levels) === wantKind);
  const found = sameKind.find((t) => carry && t.state!.activeLevelId === carry) ?? sameKind[0];
  if (found) return activateOther(stored, found, carry ? { ...found.state!, activeLevelId: carry } : found.state!);
  const levelId = carry ?? lastFloorId(stored, levels);
  if (!levelId) return { next: s, apply: null };
  return openNew(stored, noCamera({ ...live, viewType: want, activeLevelId: levelId }));
}

/**
 * [185] Nächstes Geschoss über (`dir` = +1, Cmd/Ctrl+6) bzw. unter (−1, Cmd/Ctrl+5) dem aktiven, nach Höhe
 * (`baseElevation`, gleich hoch: Reihenfolge der Liste). `null` am obersten/untersten Geschoss oder wenn die aktive
 * Ebene kein Geschoss ist.
 */
export function adjacentFloorId(
  levels: readonly Pick<DrawingLevel, "id" | "kind" | "baseElevation">[],
  activeId: string,
  dir: 1 | -1,
): string | null {
  const floors = levels
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.kind === "floor")
    .sort((a, b) => (a.l.baseElevation ?? 0) - (b.l.baseElevation ?? 0) || a.i - b.i)
    .map(({ l }) => l.id);
  const at = floors.indexOf(activeId);
  if (at < 0) return null;
  return floors[at + dir] ?? null;
}

/**
 * [185] Cmd/Ctrl+5 (`dir` −1) bzw. Cmd/Ctrl+6 (+1): im Grundriss- oder 3D-Reiter ein Geschoss tiefer/höher, im
 * selben Reiter (Art, Zoom und Ausschnitt bleiben). Sonst (Schnitt, Ansicht, Zeichnung; oberstes/unterstes
 * Geschoss) `null`.
 */
export function stepFloor(
  s: ViewTabsState,
  live: ViewSnapshotState,
  levels: readonly Pick<DrawingLevel, "id" | "kind" | "baseElevation">[],
  dir: 1 | -1,
): TabNav | null {
  const kind = tabKindOf(live, levels);
  if (kind !== "plan" && kind !== "3d") return null;
  const id = adjacentFloorId(levels, live.activeLevelId, dir);
  return id ? navigateToLevel(s, live, levels, id) : null;
}

/**
 * [185] Schlüssel, bei dessen Wechsel die Plan-Ansicht neu einpasst. Geschosse teilen sich einen: der Wechsel in ein
 * anderes Geschoss im selben Reiter behält Zoom und Ausschnitt exakt (wie Archicad); Schnitt, Ansicht, Zeichnung und
 * ein neu geladenes Projekt (`epoch`) passen ein.
 */
export function planFitKey(level: Pick<DrawingLevel, "id" | "kind">, epoch: number): string {
  return `${level.kind === "floor" ? "floors" : `level:${level.id}`}#${epoch}`;
}

/** Verbindet den aktiven Reiter mit einem Ausschnitt (Klick im Panel / Speichern). */
export function linkActiveTab(s: ViewTabsState, snapshotId: string): ViewTabsState {
  return {
    ...s,
    tabs: s.tabs.map((t) => (t.id === s.activeId ? { id: t.id, snapshotId, state: t.state } : t)),
  };
}

/** [204] Löst den aktiven Reiter von seinem Ausschnitt (Titel folgt dann der Ebene); ohne Ausschnitt unverändert. */
export function unlinkActiveTab(s: ViewTabsState): ViewTabsState {
  const tab = activeTab(s);
  if (!tab?.snapshotId) return s;
  return { ...s, tabs: s.tabs.map((t) => (t.id === tab.id ? { id: t.id, state: t.state } : t)) };
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

export function getViewStateBridge(): ViewStateBridge | null {
  return bridge;
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
