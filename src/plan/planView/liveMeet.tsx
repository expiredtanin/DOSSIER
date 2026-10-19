/**
 * "Live"-Massstab für bildschirmkonstante Overlay-Elemente (Griffe, Fangpunkt,
 * Werkzeug-Vorschau) WÄHREND einer Pan-/Zoom-Geste.
 *
 * PlanView setzt den Ausschnitt in der Geste imperativ (kein React-Render pro Frame).
 * Elemente, deren Grösse in Zeicheneinheiten aus dem Massstab berechnet wird, würden
 * dabei mit dem Zoom mitwachsen und erst nach dem Festschreiben auf Pixelgrösse
 * zurückspringen (zu gross bei schnellem Zoom). Dieser kleine Store liefert den
 * aktuellen Massstab je Frame an NUR diese Elemente — PlanView selbst rendert nicht.
 */

import { useSyncExternalStore, type ReactNode } from "react";

export interface MeetStore {
  get(): number | null;
  set(v: number | null): void;
  subscribe(l: () => void): () => void;
}

export function createMeetStore(): MeetStore {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(v) {
      if (v === value) return;
      value = v;
      listeners.forEach((l) => l());
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Rendert `children(meet)` mit dem Live-Massstab (null → `base` aus dem React-State). */
export function LiveMeet({ store, base, children }: { store: MeetStore; base: number; children: (meet: number) => ReactNode }) {
  const live = useSyncExternalStore(store.subscribe, store.get);
  return <>{children(live ?? base)}</>;
}
