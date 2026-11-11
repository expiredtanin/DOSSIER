// [185] Element-Filter der 3D-Ansicht wie Archicad: „Auswahl in 3D zeigen" (Cmd/Ctrl+3) zeigt nur die gewählten
// Elemente, Cmd/Ctrl+4 blendet die gewählten temporär aus; Cmd/Ctrl+3 ohne Auswahl zeigt wieder alles.
//
// Reiner UI-Zustand (nicht im Projekt, kein Op, kein Undo-Schritt), wirkt zusätzlich zum Klassen-Filter ([180]):
// der Kern blendet die Elemente in Teilen und Pick aus (`model3d::ElementSelection`, Text `{"only", "hideIds"}`).
// Ein neu geladenes Projekt beginnt ohne Filter (`resetView3dFilter`).
//
// Pure Funktionen + ein kleiner externer Store (Muster viewTabs.ts).

import { useSyncExternalStore } from "react";
import type { Filter3d } from "../core";
import type { Selection, SelectionKind } from "./selection";

export interface View3dFilter {
  /** Nur diese Element-ids zeigen; `null` = alle. */
  only: string[] | null;
  /** Temporär ausgeblendete Element-ids. */
  hidden: string[];
  /** Zählt die Anfragen „Kamera auf das Gezeigte einpassen" (der 3D-Viewport passt bei jeder Änderung ein). */
  fitSeq: number;
}

export const NO_VIEW3D_FILTER: View3dFilter = Object.freeze({ only: null, hidden: [], fitSeq: 0 }) as View3dFilter;

/** Element-Arten, die im 3D vorkommen (Räume, Schnittlinien, Lage-Darstellung und Gruppen nicht). */
const KINDS_3D: readonly SelectionKind[] = ["walls", "ceilings", "openings", "stairs", "solids", "columns", "roofs", "contextObjects", "trees", "drawings"];

/** Element-ids der Auswahl, die im 3D vorkommen (ohne Doppel, in Wahl-Reihenfolge). */
export function selectionIds3d(sel: Selection): string[] {
  return [...new Set(KINDS_3D.flatMap((k) => sel[k]))];
}

/** Ist der Auswahl-Modus („3D · Auswahl") aktiv? */
export function isSelectionMode(f: View3dFilter): boolean {
  return f.only !== null;
}

/**
 * Cmd/Ctrl+3: mit Auswahl nur diese zeigen (ausgeblendete werden vergessen), ohne Auswahl alles zeigen. Beide Male
 * passt der 3D-Viewport die Kamera ein.
 */
export function showSelection3d(f: View3dFilter, ids: readonly string[]): View3dFilter {
  return ids.length ? { only: [...new Set(ids)], hidden: [], fitSeq: f.fitSeq + 1 } : { only: null, hidden: [], fitSeq: f.fitSeq + 1 };
}

/** Cmd/Ctrl+4: die Elemente `ids` zusätzlich ausblenden (Kamera bleibt). Ohne ids unverändert. */
export function hideSelection3d(f: View3dFilter, ids: readonly string[]): View3dFilter {
  if (!ids.length) return f;
  const hidden = [...new Set([...f.hidden, ...ids])];
  return hidden.length === f.hidden.length ? f : { ...f, hidden };
}

/** Filter für die 3D-Abfragen: Klassen-Codes `hide` plus Element-Auswahl (Kern `ClassFilter::from_text`). */
export function toFilter3d(f: View3dFilter, hide: readonly string[]): Filter3d {
  return { hide, only: f.only, hideIds: f.hidden };
}

// ── Store ───────────────────────────────────────────────────────────────────

let current: View3dFilter = NO_VIEW3D_FILTER;
const listeners = new Set<() => void>();

export function getView3dFilter(): View3dFilter {
  return current;
}

export function setView3dFilter(next: View3dFilter): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** Neues/geöffnetes Projekt: keine Element-Auswahl im 3D. */
export function resetView3dFilter(): void {
  setView3dFilter(NO_VIEW3D_FILTER);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useView3dFilter(): View3dFilter {
  return useSyncExternalStore(subscribe, getView3dFilter, getView3dFilter);
}
