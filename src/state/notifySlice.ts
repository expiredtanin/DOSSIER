// Notify-Slice: nicht-blockierende Kurzmeldungen (Toasts). Ersetzt
// `window.alert`, das im Tauri-WKWebView deaktiviert ist (tut nichts) und
// Nutzer-Warnungen (z. B. „X wird noch verwendet") lautlos verschluckte.
//
// Reiner Zustand + zwei Actions — das Rendern (gestapelter Container) UND der
// Auto-Dismiss-Timer leben bewusst in der Toast-Komponente
// (src/ui/Toast.tsx), nicht hier: ein Timer pro GEMOUNTETER Meldung ist
// robuster als einer pro `notify()`-Aufruf (kein doppeltes Aufräumen bei
// Store-Reload/Tests, kein Timer, der eine Komponente überlebt, die es nie zu
// sehen bekam). Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { StoreApi } from "./store";

/** Art der Meldung — steuert nur den Farbakzent im Toast. */
export type NotifyKind = "info" | "warning" | "error";

/** Eine einzelne Toast-Meldung. */
export interface Notification {
  id: string;
  message: string;
  kind: NotifyKind;
}

/** Felder/Actions, die diese Slice in den RootState beisteuert. */
export interface NotifySlice {
  notifications: Notification[];
  /** Fügt eine Meldung mit eindeutiger id hinzu (Default-Art: "info"). */
  notify: (message: string, kind?: NotifyKind) => void;
  /** Entfernt eine Meldung per id (No-op bei unbekannter id). */
  dismissNotify: (id: string) => void;
}

// Monoton wachsender Zähler zusätzlich zum Zeitstempel: verhindert doppelte
// ids, falls mehrere `notify()`-Aufrufe innerhalb derselben Millisekunde
// passieren (z. B. mehrere Löschversuche in einer Schleife).
let counter = 0;
function nextId(): string {
  counter += 1;
  return `notify-${Date.now()}-${counter}`;
}

export function createNotifySlice(api: StoreApi<NotifySlice>): NotifySlice {
  const { set } = api;

  return {
    notifications: [],

    notify: (message, kind = "info") =>
      set((s) => ({
        notifications: [...s.notifications, { id: nextId(), message, kind }],
      })),

    dismissNotify: (id) =>
      set((s) => ({
        notifications: s.notifications.filter((n) => n.id !== id),
      })),
  };
}
