// Gemeinsame Fenster-Chrome für native Nebenfenster (Ressourcen, Einstellungen,
// künftige weitere) — spiegelt das Hauptfenster (tauri.conf.json: randlos, macOS-
// Overlay-Titelleiste, eigener Drag-Header) statt der nativen OS-Titelzeile samt
// Titeltext. Ohne das trägt jedes Nebenfenster ZWEI optisch übereinander
// liegende „Kopfzeilen" (OS-Titel + unser eigener `res-head`/`.win-head`) — genau
// das vom Nutzer bemängelte „wirkt am Header etwas weird".
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { LogicalPosition } from "@tauri-apps/api/dpi";

/** In `new WebviewWindow(label, { ...BORDERLESS_WINDOW_CHROME, ... })` mergen.
 *  `trafficLightPosition` zentriert die macOS-Ampeln vertikal in unserer 40px-
 *  Kopfzeile (sonst sitzen sie höher als der Titeltext). */
export const BORDERLESS_WINDOW_CHROME = {
  titleBarStyle: "overlay" as const,
  hiddenTitle: true,
  trafficLightPosition: new LogicalPosition(20, 22),
};
