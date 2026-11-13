// [246] Modul-Hook: das Panel „Ausschnitte" öffnet den Dialog „Kamerafahrt" über den Öffner, den die App registriert
// (Muster `imageExportDialogHook`).

let opener: (() => void) | null = null;

export function setCameraTourDialogOpener(fn: (() => void) | null): void {
  opener = fn;
}

export function openCameraTourDialog(): void {
  opener?.();
}
