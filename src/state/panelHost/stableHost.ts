// Panel-Host mit stabiler Identität ([121]). Der Basis-Host wird in `usePanelHostBase` bei jeder
// Projekt- oder Auswahl-Änderung neu gebaut (seine Handler schliessen über das aktuelle Projekt).
// Panels sollen deshalb aber nicht neu rendern: `useStableHost` gibt ein Objekt zurück, dessen
// Handler feste Trampoline sind (rufen beim Aufruf die Fassung des letzten Renders) und das sich nur
// ändert, wenn sich ein Wert-Feld (aktive Ebene, Werkzeug, Fang, Schnittlinie …) ändert.
//
// Damit gilt: wer Projektdaten anzeigt, abonniert sie selbst im Store (`useStore`,
// `useSelectionInfo`); der Host trägt nur noch Handler und kleine Ansichts-Werte. Handler, deren
// ERGEBNIS im Render gelesen wird (`viewTabAutoName`), braucht der Leser mit eigenem Abo (s. App.tsx).

import { useRef } from "react";

/** Zustand der Stabilisierung: Ausgabe und was zu ihr geführt hat. */
export interface StableHost<T> {
  /** Ausgabe-Objekt (Trampoline + Wert-Felder). */
  out: T;
  /** Wert-Felder der Ausgabe (Schlüssel → Wert) zum Vergleich. */
  values: Map<string, unknown>;
  /** Schlüssel mit Handler (Funktion). */
  fns: Set<string>;
}

/** Gleiche Schlüssel, gleiche Handler-Schlüssel, gleiche Wert-Felder (Referenz)? */
function sameShape<T extends object>(prev: StableHost<T>, next: T): boolean {
  const keys = Object.keys(next);
  if (keys.length !== prev.values.size + prev.fns.size) return false;
  for (const k of keys) {
    const v = (next as Record<string, unknown>)[k];
    if (typeof v === "function") {
      if (!prev.fns.has(k)) return false;
    } else if (!prev.values.has(k) || !Object.is(prev.values.get(k), v)) {
      return false;
    }
  }
  return true;
}

/**
 * Ein Schritt der Stabilisierung (rein, für Tests): liefert `prev` unverändert, wenn `value` dieselbe
 * Form und dieselben Wert-Felder hat, sonst eine neue Ausgabe. Trampoline rufen `latest.current[k]`;
 * bestehende Trampoline werden weiterverwendet.
 */
export function stabilizeHost<T extends object>(
  prev: StableHost<T> | null,
  value: T,
  latest: { readonly current: T },
): StableHost<T> {
  if (prev !== null && sameShape(prev, value)) return prev;
  const prevOut = prev?.out as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  const values = new Map<string, unknown>();
  const fns = new Set<string>();
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "function") {
      fns.add(k);
      out[k] =
        prevOut && prev?.fns.has(k)
          ? prevOut[k]
          : (...args: unknown[]) => ((latest.current as Record<string, unknown>)[k] as (...a: unknown[]) => unknown)(...args);
    } else {
      values.set(k, v);
      out[k] = v;
    }
  }
  return { out: out as T, values, fns };
}

/**
 * Stabile Fassung von `value` (s. Kopf). Ohne `target` rufen die Trampoline die Fassung des letzten
 * Renders; mit `target` dessen `current` (z. B. ein Getter, der bei geändertem Store neu baut, s.
 * `usePanelHostBase`).
 */
export function useStableHost<T extends object>(value: T, target?: { readonly current: T }): T {
  const latest = useRef(value);
  // Im Render nachführen: Handler-Aufrufe danach treffen die neue Fassung.
  latest.current = value;
  const stable = useRef<StableHost<T> | null>(null);
  stable.current = stabilizeHost(stable.current, value, target ?? latest);
  return stable.current.out;
}
