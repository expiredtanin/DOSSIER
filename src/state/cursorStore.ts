// Hochfrequente Cursor-Werte (Modell-Meter) AUSSERHALB von React-State. Die
// Position ändert sich bei jeder Mausbewegung; als State in App.tsx bzw.
// PlanView hat sie bei jeder Bewegung die gesamte App bzw. den ganzen Plan neu
// gerendert — bei einem Kataster-Import (Mio. Primitive) ein spürbarer Teil der
// Ruckler. Hier rendert nur, wer den Wert abonniert.

import { useSyncExternalStore } from "react";
import type { Vec2 } from "../model/types";

export interface CursorStore {
  get(): Vec2 | null;
  set(next: Vec2 | null): void;
  subscribe(listener: () => void): () => void;
}

export function createCursorStore(): CursorStore {
  let current: Vec2 | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next) {
      if (next === current) return;
      if (next && current && next.x === current.x && next.y === current.y) return;
      current = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useCursorValue(store: CursorStore): Vec2 | null {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Cursor der aktiven Plan-Ansicht für die X/Y-Anzeige der Statusleiste. */
const statusCursor = createCursorStore();
export const setCursor = statusCursor.set;
export const useCursor = (): Vec2 | null => useCursorValue(statusCursor);
