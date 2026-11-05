// [137] Statusleisten-Hinweis zum Klick-Zyklus („2/3 Treffer — erneut klicken zum Wechseln"). Ausserhalb von
// React-State, weil der Setzer (PlanView) und der Leser (StatusBar in App) in verschiedenen Teilbäumen sitzen.

import { useSyncExternalStore } from "react";

let current: string | null = null;
const listeners = new Set<() => void>();

export function setPickHint(hint: string | null): void {
  if (hint === current) return;
  current = hint;
  for (const l of listeners) l();
}

export function usePickHint(): string | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
}
