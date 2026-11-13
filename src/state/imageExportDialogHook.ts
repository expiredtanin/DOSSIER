// [223] Modul-Hook: App registriert den Öffner des Dialogs „3D-Bild exportieren …"; Befehl `bild3d` und die Menüs
// rufen ihn auf, ohne an React/App gekoppelt zu sein (Muster `renderDialogHook`).

let opener: (() => void) | null = null;

/** App registriert hier den Öffner (oder hebt ihn beim Unmount auf). */
export function setImageExportDialogOpener(fn: (() => void) | null): void {
  opener = fn;
}

/** Öffnet den Dialog, falls App ihn registriert hat. */
export function openImageExportDialog(): void {
  opener?.();
}
