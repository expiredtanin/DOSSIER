// Strukturvergleich für reine Daten ([121]): Objekte, Arrays, Primitive (JSON-artig). Für abgeleitete
// Werte, die bei jeder Berechnung neu entstehen (Objekt-Info, Zustand der Nebenfenster): ist das
// Ergebnis inhaltlich gleich, bleibt die alte Referenz bzw. entfällt das Senden. Ohne Abhängigkeiten,
// damit auch die Nebenfenster es laden können.

/** Inhaltlich gleich? Funktionen, Maps u. ä. zählen nur bei gleicher Referenz. */
export function dataEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!dataEqual(a[i], bb[i])) return false;
    return true;
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!dataEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
