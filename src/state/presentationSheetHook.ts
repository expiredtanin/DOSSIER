// [66] Modul-Hook: App registriert den Öffner des Präsentationsplan-Dialogs; Befehl `praesentation` und
// der Knopf im Layouts-Panel rufen ihn auf, ohne an React/App gekoppelt zu sein (Muster `io/dxfImportHook`).

let opener: (() => void) | null = null;

/** App registriert hier den Öffner (oder hebt ihn beim Unmount auf). */
export function setPresentationDialogOpener(fn: (() => void) | null): void {
  opener = fn;
}

/** Öffnet den Dialog „Präsentationsplan", falls App ihn registriert hat. */
export function openPresentationDialog(): void {
  opener?.();
}
