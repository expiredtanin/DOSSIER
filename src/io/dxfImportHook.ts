// Kleiner Modul-Hook, der das (in App montierte) versteckte DXF-Datei-Input
// mit dem `import`-Befehl entkoppelt verbindet. App registriert beim Mount eine
// Trigger-Funktion (öffnet den Datei-Dialog); der Befehl ruft sie auf, ohne die
// Command-Engine an React/DOM zu koppeln. So bleibt der Import-Befehl additiv.
//
// Bewusst KEIN window-Global: ein Modul-Singleton genügt (eine App-Instanz).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

type DxfImportTrigger = () => void;

let trigger: DxfImportTrigger | null = null;

/** App registriert hier den Datei-Dialog-Öffner (oder hebt ihn beim Unmount auf). */
export function setDxfImportTrigger(fn: DxfImportTrigger | null): void {
  trigger = fn;
}

/** Öffnet den DXF-Datei-Dialog, falls App ihn registriert hat. */
export function openDxfImport(): void {
  trigger?.();
}
