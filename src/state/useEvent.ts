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
