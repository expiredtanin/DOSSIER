// Reines Modul für den strukturierten Raum-Stempel (Feldmodell). App-frei und
// unit-getestet: baut aus einem RoomStamp das gerenderte Rich-Text-Dokument
// (roomStampToDoc) und die Live-Zeilen (roomStampExtraLines), und liefert den
// Anzeigenamen für Listen (roomDisplayName). Keine React-/Store-Abhängigkeit.
//
// Folge-Arbeit: Fensterfläche (braucht Öffnung-in-Raum-Geometrie).

import type { Room, RoomStamp } from "./types";
import type { SiaCategory } from "../geometry/roomArea";
import type { RichTextDoc, Paragraph, TextRun } from "../text/richText";
import { makeRun } from "../text/richText";

/** Grösse (pt) des Raumnamens (Zeile 1) relativ zur Stempel-Basis. */
const NAME_PT = 12;
/** Grösse (pt) der kleinen Raumnummer als Präfix. */
const NUMBER_PT = 9;
/** Grösse (pt) der zweiten Namenszeile. */
const LINE2_PT = 9;

/**
 * Standard-Stempel aus einem Raum ableiten: Name = Raum-Name, Bodenfläche und
 * Nutzung angezeigt. Nummer/Zeile 2 bleiben leer (frei ergänzbar).
 */
export function defaultRoomStamp(room: Room): RoomStamp {
  return {
    name: room.name,
    showFloorArea: true,
    showUsage: true,
  };
}

/**
 * Baut das Rich-Text-Dokument des Stempels:
 *  • Zeile 1: optionale Raumnummer (kleiner Präfix) + Raumname (grösser, fett).
 *  • Zeile 2 (optional): nameLine2 (kursiv, kleiner).
 * Die Live-Zeilen (Fläche/Nutzung) werden separat als extraLines gesetzt.
 */
export function roomStampToDoc(stamp: RoomStamp): RichTextDoc {
  const line1: TextRun[] = [];
  const number = (stamp.number ?? "").trim();
  if (number) {
    line1.push(makeRun(`${number} `, { sizePt: NUMBER_PT }));
  }
  line1.push(makeRun(stamp.name, { bold: true, sizePt: NAME_PT }));

  const paragraphs: Paragraph[] = [{ runs: line1 }];
  const line2 = (stamp.nameLine2 ?? "").trim();
  if (line2) {
    paragraphs.push({ runs: [makeRun(line2, { italic: true, sizePt: LINE2_PT })] });
  }
  return { version: 1, paragraphs };
}

/** Kontext für die Live-Zeilen (nicht gespeichert, bei jedem Rendern frisch). */
export interface RoomStampContext {
  netArea: number;
  siaCategory: SiaCategory;
  siaLabel: string;
}

/**
 * Die Live-Zeilen unter dem Stempel: Bodenfläche (mit Präfix) wenn showFloorArea,
 * Nutzung (SIA-Kürzel · Bezeichnung) wenn showUsage.
 */
export function roomStampExtraLines(stamp: RoomStamp, ctx: RoomStampContext): string[] {
  const lines: string[] = [];
  if (stamp.showFloorArea) {
    const prefix = stamp.floorAreaPrefix ?? "";
    lines.push(`${prefix}${ctx.netArea.toFixed(2)} m²`);
  }
  if (stamp.showUsage) {
    lines.push(`${ctx.siaCategory} · ${ctx.siaLabel}`);
  }
  return lines;
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
