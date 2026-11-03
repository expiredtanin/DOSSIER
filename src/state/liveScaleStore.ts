// LIVE Papier-Massstab-Nenner der Plan-Ansicht AUSSERHALB von React-State ([121]). PlanView meldet
// ihn bei jedem Zoom-Schritt; als State in App.tsx hat jeder Mausrad-Schritt die ganze App neu
// gerendert. Hier rendert nur, wer ihn abonniert (die Zoom-Anzeige der Oberleiste).
// null = keine Plan-Ansicht aktiv.

import { useSyncExternalStore } from "react";

let current: number | null = null;
const listeners = new Set<() => void>();

export function setLiveScale(next: number | null): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

export function getLiveScale(): number | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveScale(): number | null {
  return useSyncExternalStore(subscribe, getLiveScale, getLiveScale);
}

/**
 * Live-Zoom in Prozent RELATIV zum angewandten Papier-Massstab: 100 % = Live-Ansicht steht exakt
 * im angewandten Massstab (liveScale == scaleDenominator). Reinzoomen > 100 %, Rauszoomen < 100 %.
 * Ohne Live-Massstab (keine Plan-Ansicht) Fallback 100 %.
 */
export function zoomPercentOf(scaleDenominator: number, liveScale: number | null): number {
  return liveScale != null && liveScale > 0 ? (scaleDenominator / liveScale) * 100 : 100;
}
