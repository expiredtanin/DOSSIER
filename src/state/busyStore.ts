// Globaler "Bitte warten"-Hinweis für lange, den Haupt-Thread blockierende
// Schritte (Import grosser Dateien). Ausserhalb von React-State, weil der
// Aufrufer (runImport) und der Beender (PlanView, nach dem ersten gezeichneten
// Frame) in völlig verschiedenen Teilbäumen sitzen.
//
// Ablauf Import: Dialog zeigt "Importiere …" (gemalt, BEVOR die Arbeit startet)
// → runImport ruft beginBusy → Dialog schliesst, Plan wird aufgebaut (blockiert)
// → PlanView ruft nach dem Zeichnen endBusy. Dazwischen steht der Hinweis, statt
// dass die App scheinbar eingefroren ist.

import { useSyncExternalStore } from "react";

let current: string | null = null;
let failsafe: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Zeigt `label`. Verschwindet spätestens nach `maxMs` von selbst (nie hängen bleiben). */
export function beginBusy(label: string, maxMs = 120_000): void {
  current = label;
  if (failsafe !== null) clearTimeout(failsafe);
  failsafe = setTimeout(endBusy, maxMs);
  emit();
}

export function endBusy(): void {
  if (failsafe !== null) {
    clearTimeout(failsafe);
    failsafe = null;
  }
  if (current === null) return;
  current = null;
  emit();
}

/** Wie {@link endBusy}, aber erst NACH dem nächsten gemalten Frame. */
export function endBusyAfterPaint(): void {
  if (current === null) return;
  requestAnimationFrame(() => requestAnimationFrame(endBusy));
}

export function useBusy(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
