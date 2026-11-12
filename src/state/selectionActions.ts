// [190] Kleine Ablage für Aktionen, die mehrere Eingänge haben (Tastenkürzel im Fenster, natives Menü):
// Duplizieren, Sperren, Verbinden, Ebenen aus-/einblenden, Einpassen. Die Aktionen leben dort, wo ihr Zustand
// ist (`useSelectionCommands`, `App`) und tragen sich bei jedem Render ein; das native Menü (`useNativeMenu`)
// ruft sie über `runSelectionAction`, ohne dass der Zustand durch die Menü-Verdrahtung gereicht werden muss.

export type SelectionActionId =
  | "duplicate"
  | "toggleLock"
  | "join"
  | "hideLayers"
  | "showAllLayers"
  | "fitAll"
  | "fitSelection"
  | "toggleTrace";

const actions: Partial<Record<SelectionActionId, () => void>> = {};

/** Trägt (oder ersetzt) Aktionen ein; spätere Aufrufe gewinnen. */
export function registerSelectionActions(a: Partial<Record<SelectionActionId, () => void>>): void {
  Object.assign(actions, a);
}

/** Führt die Aktion aus, falls eingetragen (sonst nichts). */
export function runSelectionAction(id: SelectionActionId): void {
  actions[id]?.();
}
