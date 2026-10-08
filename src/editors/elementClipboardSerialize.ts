// OS-Zwischenablage-Serialisierung für `ElementClipboard` (Nutzer-Wunsch:
// „Element-Zwischenablage ist In-App-only — kein Copy/Paste zwischen zwei
// Fenstern/Projekten derselben App", `ElementClipboard` lebte bisher NUR als
// React-State, ohne `navigator.clipboard`-Aufruf). Reine Funktionen:
// Serialisieren zu einem markierten JSON-Text (für `navigator.clipboard.
// writeText`) + defensives Parsen zurück (für `readText`) — jeder Fehlschlag
// (fremder Text, falsche Marke, kaputtes/unvollständiges JSON — z. B. wenn
// der Nutzer zuletzt normalen Text kopiert hat) liefert `null` statt zu
// werfen, damit der Aufrufer klaglos auf die In-App-Zwischenablage zurückfällt
// (s. `useKeyboardShortcuts.ts::useElementClipboardShortcut`).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { ElementClipboard } from "./elementClipboard";

const MARKER = "dossier-element-clipboard-v1";

interface SerializedClipboard {
  __dossier: typeof MARKER;
  clip: ElementClipboard;
}

/** ElementClipboard → JSON-Text für `navigator.clipboard.writeText`. */
export function serializeClipboardText(clip: ElementClipboard): string {
  const payload: SerializedClipboard = { __dossier: MARKER, clip };
  return JSON.stringify(payload);
}

/** Die 9 Bauteil-Arten-Felder, die eine gültige `ElementClipboard`-Form ausmachen. */
const CLIP_ARRAY_KEYS = [
  "walls",
  "drawings",
  "ceilings",
  "roofs",
  "openings",
  "stairs",
  "rooms",
  "extrudedSolids",
  "columns",
] as const;

/**
 * JSON-Text (z. B. aus `navigator.clipboard.readText()`) → `ElementClipboard`,
 * oder `null` bei irgendeinem Fehlschlag: kein JSON, fremdes Format, falsche
 * Marke, oder eines der 9 Bauteil-Felder fehlt/ist kein Array (kaputte/
 * unvollständige Daten — lieber ablehnen als `pasteElementClipboard` mit
 * einer verformten Struktur zum Absturz zu bringen).
 */
export function parseClipboardText(text: string): ElementClipboard | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if ((parsed as Partial<SerializedClipboard>).__dossier !== MARKER) return null;
  const clip = (parsed as SerializedClipboard).clip as unknown;
  if (!clip || typeof clip !== "object") return null;
  const clipRecord = clip as Record<string, unknown>;
  for (const key of CLIP_ARRAY_KEYS) {
    if (!Array.isArray(clipRecord[key])) return null;
  }
  return clip as ElementClipboard;
}
