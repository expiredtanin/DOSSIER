// [211] Modul-Hook: App registriert den Öffner des Dialogs „Rendering…" (Blender/Cycles); Befehl `rendering`,
// Menüpunkt und Einstellungen rufen ihn auf, ohne an React/App gekoppelt zu sein (Muster `presentationSheetHook`).

let opener: (() => void) | null = null;

/** App registriert hier den Öffner (oder hebt ihn beim Unmount auf). */
export function setRenderDialogOpener(fn: (() => void) | null): void {
  opener = fn;
}

/** Öffnet den Rendering-Dialog, falls App ihn registriert hat. */
export function openRenderDialog(): void {
  opener?.();
}
