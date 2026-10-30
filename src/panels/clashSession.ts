// Sitzungszustand der Kollisionsprüfung ([T8]): die Ergebnisse der letzten Prüfung leben ausserhalb des
// Projekts (Marker im Grundriss kommen weiterhin als Zeichnungs-Elemente), damit Liste (ClashPanel) und
// 3D-Hervorhebung (viewportContent) dieselben Treffer zeigen. Kleiner Modul-Speicher wie `bcfSession`.

import { useSyncExternalStore } from "react";
import { clashMarkerOps, runClashCheck, type Clash } from "../analysis/clash";
import { t } from "../i18n";
import { getState } from "../state/appStore";

export interface ClashSession {
  clashes: Clash[];
  /** Index des gewählten Treffers (Liste/Zoom) oder null. */
  selected: number | null;
  /** Prüfung läuft. */
  running: boolean;
}

let state: ClashSession = { clashes: [], selected: null, running: false };
const listeners = new Set<() => void>();

export const getClashSession = (): ClashSession => state;

export function setClashSession(patch: Partial<ClashSession>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useClashSession(): ClashSession {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getClashSession,
  );
}

/**
 * Prüfung ausführen: Ergebnis in die Sitzung (Liste + 3D-Hervorhebung), Marker in den Grundriss, Meldung.
 * Läuft auf dem aktuellen Projektstand des Stores.
 */
export async function runClashAndStore(): Promise<void> {
  if (state.running) return;
  const st = getState();
  setClashSession({ running: true });
  try {
    const clashes = await runClashCheck(st.project);
    st.applyChange((p) => clashMarkerOps(p, clashes, st.activeCategoryCode));
    setClashSession({ clashes, selected: null, running: false });
    // window.alert ist im Tauri-WKWebView wirkungslos → Toast.
    st.notify(
      clashes.length === 0
        ? t("clash.none")
        : `${t("clash.found")}: ${clashes.length} — ` +
            clashes
              .slice(0, 5)
              .map((c, k) => `K${k + 1} ${c.a.kind}↔${c.b.kind}${c.volume !== null ? ` ${c.volume.toFixed(3)} m³` : ""}`)
              .join(", "),
      clashes.length === 0 ? "info" : "warning",
    );
  } catch (err) {
    setClashSession({ running: false });
    st.notify(`${t("clash.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}
