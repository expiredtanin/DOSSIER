// Stabile Rückruf-Identität mit immer aktuellem Inhalt ([121], Muster „useEvent").
//
// App.tsx baut viele Handler als Closures über den aktuellen Render (Projekt, Auswahl …). Gibt man
// sie direkt an `memo`-Kinder weiter, ist jede Identität je Render neu und `memo` wirkungslos.
// `useEvent(fn)` liefert eine Funktion, deren Identität über die ganze Lebensdauer gleich bleibt und
// die beim Aufruf die Fassung des LETZTEN Renders ausführt. Nur für Ereignis-Handler (Klick, Ziehen,
// Befehl) — nie für Funktionen, deren Ergebnis während des Renders gelesen wird (die würden ein
// `memo`-Kind sonst nicht mehr neu zeichnen, obwohl sich ihr Ergebnis ändert).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useEvent<F extends (...args: any[]) => any>(fn: F): F {
  const latest = useRef(fn);
  // Im Render nachführen (nicht erst im Effekt): Kinder rufen manche Handler schon in ihren eigenen
  // Layout-Effekten auf, die VOR denen des Elternteils laufen — sie sollen die neue Fassung sehen.
  // Die App rendert ohne Transitions, ein verworfener Render kommt nicht vor.
  latest.current = fn;
  const stable = useRef<F | null>(null);
  if (stable.current === null) {
    stable.current = ((...args: Parameters<F>) => latest.current(...args)) as F;
  }
  return stable.current;
}

/**
 * Wie `useEvent`, aber für ein ganzes Bündel von Handlern (Objekt aus Funktionen): liefert ein
 * stabiles Objekt mit stabilen Weiterleitungen je Schlüssel. Die Schlüsselmenge muss gleich bleiben.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useEventBundle<T extends Record<string, (...args: any[]) => any>>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const stable = useRef<T | null>(null);
  if (stable.current === null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(handlers)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out[key] = (...args: any[]) => latest.current[key](...args);
    }
    stable.current = out as T;
  }
  return stable.current;
}

/** Strukturgleichheit für reine Daten (Zahlen, Strings, Arrays, flache Objekte). */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Behält die vorige Referenz, solange der neue Wert strukturell gleich ist — für je Render neu
 * berechnete, kleine Daten (Griff-Listen), die an `memo`-Kinder gehen. Nicht für grosse Listen.
 */
export function useSameData<T>(value: T): T {
  const ref = useRef(value);
  if (!sameData(ref.current, value)) ref.current = value;
  return ref.current;
}
