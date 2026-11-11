// [195] Gewählter Bereich des Objekteinstellungs-Fensters („Objekt" / „Darstellung"). Ausserhalb von React
// lesbar und setzbar, damit Taste T den Bereich wählen kann, bevor das Fenster montiert ist.

import type { SettingsArea } from "./areas";

let area: SettingsArea = "object";
const listeners = new Set<() => void>();

export const getSettingsArea = (): SettingsArea => area;

export function setSettingsArea(next: SettingsArea): void {
  if (next === area) return;
  area = next;
  for (const l of [...listeners]) l();
}

export function subscribeSettingsArea(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
