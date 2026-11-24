// [329] Griffe beim Loslassen übernehmen (Einstellung, Wunsch Maintainer 24.11.): an = ein mit gedrückter Maustaste
// GEZOGENER Punkt- oder Kanten-Griff gilt beim Loslassen (Archicad/Vectorworks); ein Klick ohne Ziehen bewaffnet
// weiterhin (dann Wert tippen oder an der Zielstelle klicken). Aus (Vorgabe) = wie bisher: jeder Griff bleibt bis
// zum nächsten Klick/Enter bewaffnet. Pro Rechner (localStorage), gelesen beim Loslassen — so gilt eine Änderung im
// Einstellungsfenster (Tauri: eigenes Dokument, gleicher Speicher) sofort.

const KEY = "dossier.gripCommitOnRelease";

/** Ab so vielen Bildschirm-Pixeln zwischen Drücken und Loslassen gilt es als Ziehen (nicht als Klick). */
export const GRIP_DRAG_PX = 4;

export function getGripCommitOnRelease(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setGripCommitOnRelease(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* Best-Effort (privater Modus). */
  }
}

/** Soll ein Griff, gedrückt bei (sx, sy) und losgelassen bei (x, y), jetzt übernommen werden? */
export function gripCommitsOnRelease(sx: number, sy: number, x: number, y: number, on: boolean = getGripCommitOnRelease()): boolean {
  return on && Math.hypot(x - sx, y - sy) >= GRIP_DRAG_PX;
}
