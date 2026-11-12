// [190] Verbinden der aktuellen Auswahl (Wände: Ecken/T-Stösse/kollinear; 2D-Elemente: Ketten). EIN Pfad für das
// Tastenkürzel im Fenster (`useSplitJoinShortcut`) und das native Menü „Bearbeiten > Verbinden" (`selectionActions`).
// Unter macOS fängt das Menü Cmd+J ab, das Fenster sieht die Taste dann nie — der Menü-Weg muss alles allein
// leisten. Darum liest dieser Pfad die Auswahl IMMER frisch aus dem Store und nicht aus einer Render-Closure.

import { t } from "../i18n";
import { getState } from "./appStore";
import type { CommandEngine } from "../commands/engine";

/** Startet „join" auf der aktuellen Auswahl; false (mit Hinweis), wenn weniger als zwei Elemente gewählt sind. */
export function joinCurrentSelection(engine: Pick<CommandEngine, "start">): boolean {
  const s = getState();
  const n = s.selection.drawings.length + s.selection.walls.length;
  if (n < 2) {
    s.notify(t("cmd.join.few"), "info");
    return false;
  }
  engine.start("join");
  // Die alte Auswahl zeigt nach dem Verbinden auf ersetzte ids → aufräumen.
  s.setSelection({ drawings: [], walls: [] });
  return true;
}
