// Reines Modul für den strukturierten Raum-Stempel (Feldmodell): Standard-Stempel und Anzeigename
// für Listen. Das Stempel-Dokument und die Live-Zeilen (Fläche, Nutzung, Personen) baut der Kern
// beim Plan-Aufbau (`src-tauri/core/src/plan/domains.rs`, [K3d]).

import type { Marks, Room, RoomStamp, RoomStampFont } from "./types";
import type { Align } from "../text/richText";

/**
 * Standard-Stempel aus einem Raum ableiten (Archicad-Stil, linksbündig): Name = Raum-Name, Bodenfläche
 * angezeigt, SIA-Kategorie nicht. Nummer/Zeile 2 bleiben leer (frei ergänzbar).
 */
export function defaultRoomStamp(room: Room): RoomStamp {
  return {
    name: room.name,
    // [173] Fläche und SIA-Kategorie bleiben offen („wie Modelldarstellung“; Basis: Fläche ja, Kategorie nein —
    // [177] die Kategorie ist ein Attribut des Raums, nicht Teil des Stempels).
  };
}

/** Eine Live-Zeile des Stempels mit Text und Ausrichtung. */
export interface RoomStampLine {
  text: string;
  align: Align;
  /** [218] Schrift der Zeile (Familie, Grösse in pt bei Grundschrift 10, fett, kursiv, Farbe); fehlt: 0.8 × Grundschrift. */
  marks?: Marks;
}

/**
 * Anzeigename für Listen: strukturierter Name (name + optional nameLine2 zu
 * einem Namen zusammengezogen), sonst der Alt-Raumname.
 */
export function roomDisplayName(room: Room): string {
  const stamp = room.stamp;
  if (!stamp) return room.name;
  const line2 = (stamp.nameLine2 ?? "").trim();
  return line2 ? `${stamp.name} ${line2}` : stamp.name;
}

// ── [218] Schrift des Stempels (Objekteinstellungen, Abschnitt „Raumstempel") ────────────────────────
// Der Kern setzt sie beim Plan-Aufbau um (`plan/domains.rs::stamp_line_marks`): Zeilenschrift > Stempelschrift >
// eingebaute Werte der Zeile.

/** Schrift-Schlüssel am Stempel: der ganze Stempel und je Zeile. */
export type StampFontKey = "font" | "nameFont" | "line2Font" | "numberFont" | "areaFont" | "usageFont";

/** Eigenschaft einer Stempelschrift. */
export type StampFontAttr = keyof RoomStampFont;

/** Zeilen mit eigener Schrift in Anzeige-Reihenfolge samt den eingebauten Werten (Anzeige, wenn nichts gesetzt ist). */
export const STAMP_FONT_LINES: readonly { key: StampFontKey; labelKey: string; size: number; bold: boolean; italic: boolean }[] = [
  { key: "font", labelKey: "roomStamp.font.all", size: 10, bold: false, italic: false },
  { key: "nameFont", labelKey: "roomStamp.font.name", size: 12, bold: true, italic: false },
  { key: "line2Font", labelKey: "roomStamp.font.line2", size: 9, bold: false, italic: true },
  { key: "numberFont", labelKey: "roomStamp.font.number", size: 9, bold: false, italic: false },
  { key: "areaFont", labelKey: "roomStamp.font.area", size: 8, bold: false, italic: false },
  { key: "usageFont", labelKey: "roomStamp.font.usage", size: 8, bold: false, italic: false },
];

/** Schrift einer Zeile setzen (`value` = `undefined`: Eigenschaft entfernen ⇒ Vorgabe); eine leere Schrift entfällt. */
export function setStampFontAttr<K extends StampFontAttr>(stamp: RoomStamp, key: StampFontKey, attr: K, value: RoomStampFont[K] | undefined): RoomStamp {
  const font: RoomStampFont = { ...(stamp[key] ?? {}) };
  if (value === undefined || value === "" || (typeof value === "number" && !(value > 0))) delete font[attr];
  else font[attr] = value;
  const next: RoomStamp = { ...stamp };
  if (Object.keys(font).length === 0) delete next[key];
  else next[key] = font;
  return next;
}
