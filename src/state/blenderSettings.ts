// [211] Einstellung „Blender-Programmdatei" (Rendering mit Blender/Cycles). Pro Rechner, nicht im Projekt:
// localStorage (die Einstellungsfenster sind eigene Dokumente ohne gemeinsamen Store, derselbe Ursprung teilt
// aber localStorage — Muster `commandAliasOverrides`). Leer = automatisch suchen (PATH, übliche Orte).

const KEY = "dossier.blenderPath";

/** Eigener Blender-Pfad oder leer. Fehlender/gesperrter Speicher ⇒ leer. */
export function getBlenderPath(): string {
  try {
    return localStorage.getItem(KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setBlenderPath(path: string): void {
  try {
    const p = path.trim();
    if (p) localStorage.setItem(KEY, p);
    else localStorage.removeItem(KEY);
  } catch {
    /* privates Fenster / Speicher gesperrt: Einstellung gilt nur bis zum Schliessen */
  }
}
