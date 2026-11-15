// [263] Modul-Hook: die Oberleiste registriert den Öffner des Über-Dialogs (Hilfe → Über dossier …); das Menü ruft ihn auf,
// ohne an TopBar-State gekoppelt zu sein (Muster `shortcutOverviewHook`).

let opener: (() => void) | null = null;

/** TopBar registriert hier den Öffner (oder hebt ihn beim Unmount auf). */
export function setAboutDialogOpener(fn: (() => void) | null): void {
  opener = fn;
}

/** Öffnet den Über-Dialog, falls die Oberleiste ihn registriert hat. */
export function openAboutDialog(): void {
  opener?.();
}
