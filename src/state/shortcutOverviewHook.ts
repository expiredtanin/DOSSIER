// [210] Modul-Hook: App registriert den Öffner der Kürzel-Übersicht (Hilfe → Tastaturkürzel); Menüs rufen ihn auf,
// ohne an React/App gekoppelt zu sein (Muster `renderDialogHook`).

let opener: (() => void) | null = null;

/** App registriert hier den Öffner (oder hebt ihn beim Unmount auf). */
export function setShortcutOverviewOpener(fn: (() => void) | null): void {
  opener = fn;
}

/** Öffnet die Kürzel-Übersicht, falls App sie registriert hat. */
export function openShortcutOverview(): void {
  opener?.();
}
