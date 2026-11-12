// [195b] Umleitung der Projekt-Änderungen eines Nebenfensters: Im nativen Fenster „Objekteinstellungen" läuft
// derselbe Store wie im Hauptfenster, aber nur als Spiegel (Leseansicht + eigenes Kern-Dokument, nachgeführt
// über die Sync-Brücke). Ist ein Abfluss gesetzt, wenden `applyChange`, `setProject`, Befehle und Griffe
// NICHTS lokal an: sie rechnen die Ops auf dem Spiegel (der dem Stand des Hauptfensters gleicht) und geben sie
// mit `coalesceKey` hierher ab; das Hauptfenster wendet sie per `applyChange` an (Prüfung, Undo je Änderung)
// und schickt den neuen Stand zurück. Im Hauptfenster ist kein Abfluss gesetzt (eine Abfrage, sonst nichts).

import type { CoreOp } from "../core/ops";

export type ChangeSink = (ops: readonly CoreOp[], coalesceKey: string | undefined) => void;

let sink: ChangeSink | null = null;

/** Abfluss setzen (`null` = wieder lokal anwenden). */
export function setChangeSink(next: ChangeSink | null): void {
  sink = next;
}

/** Aktueller Abfluss oder `null` (Hauptfenster). */
export function changeSink(): ChangeSink | null {
  return sink;
}
