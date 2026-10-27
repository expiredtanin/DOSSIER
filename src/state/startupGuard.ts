// Start-Protokoll ([46]): erkennt, dass die vorige Sitzung nicht sauber beendet wurde (Absturz,
// Prozess beendet, GPU-Treiber-Hänger). Beim Start wird eine Marke gesetzt, beim sauberen
// Schliessen (pagehide) gelöscht; steht sie beim nächsten Start noch, war der letzte Lauf kaputt.
// Die Daten schützt der Autosave ([13]); dieses Protokoll liefert dazu die Meldung.

const KEY = "dossier.session";

interface Session {
  startedAt: number;
  clean: boolean;
}

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Setzt die Start-Marke; liefert, ob der vorige Lauf unsauber endete (und wann er begann). */
export function markSessionStart(store: Store | null = defaultStore(), now = Date.now()): { previousCrashed: boolean; previousStartedAt?: number } {
  if (!store) return { previousCrashed: false };
  let prev: Session | null = null;
  try {
    prev = JSON.parse(store.getItem(KEY) ?? "null") as Session | null;
  } catch {
    prev = null;
  }
  try {
    store.setItem(KEY, JSON.stringify({ startedAt: now, clean: false } satisfies Session));
  } catch {
    /* Speicher gesperrt */
  }
  return prev && prev.clean === false ? { previousCrashed: true, previousStartedAt: prev.startedAt } : { previousCrashed: false };
}

/** Markiert die laufende Sitzung als sauber beendet (pagehide/beforeunload). */
export function markSessionClean(store: Store | null = defaultStore()): void {
  if (!store) return;
  try {
    const cur = JSON.parse(store.getItem(KEY) ?? "null") as Session | null;
    store.setItem(KEY, JSON.stringify({ startedAt: cur?.startedAt ?? Date.now(), clean: true } satisfies Session));
  } catch {
    /* ignorieren */
  }
}
