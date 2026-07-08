// Reines Modul für den strukturierten Raum-Stempel (Feldmodell). App-frei und
// unit-getestet: baut aus einem RoomStamp das gerenderte Rich-Text-Dokument
// (roomStampToDoc) und die Live-Zeilen (roomStampExtraLines), und liefert den
// Anzeigenamen für Listen (roomDisplayName). Keine React-/Store-Abhängigkeit.
//
// Folge-Arbeit: Fensterfläche (braucht Öffnung-in-Raum-Geometrie).

import type { Room, RoomStamp } from "./types";
import type { SiaCategory } from "../geometry/roomArea";
import type { RichTextDoc, Paragraph, TextRun, Align } from "../text/richText";
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

  const paragraphs: Paragraph[] = [{ runs: line1, align: stamp.nameAlign }];
  const line2 = (stamp.nameLine2 ?? "").trim();
  if (line2) {
    paragraphs.push({
      runs: [makeRun(line2, { italic: true, sizePt: LINE2_PT })],
      align: stamp.line2Align,
    });
  }
  return { version: 1, paragraphs };
}

/** Kontext für die Live-Zeilen (nicht gespeichert, bei jedem Rendern frisch). */
export interface RoomStampContext {
  netArea: number;
  siaCategory: SiaCategory;
  siaLabel: string;
}

/** Eine Live-Zeile des Stempels mit Text und Ausrichtung. */
export interface RoomStampLine {
  text: string;
  align: Align;
}

/**
 * Formatiert die Bodenfläche für die Stempel-Anzeige: ohne `roundingStep` wie
 * bisher auf 2 Nachkommastellen; mit `roundingStep` auf das nächste Vielfache
 * davon gerundet (z. B. 0.5 → halbe m²), ohne Nachkommastellen-Rauschen.
 */
export function formatStampArea(area: number, roundingStep?: number): string {
  if (roundingStep && roundingStep > 0) {
    const rounded = Math.round(area / roundingStep) * roundingStep;
    // Rundungsfehler aus der Fliesskomma-Division kappen (max. 2 Nachkommastellen).
    return `${Math.round(rounded * 100) / 100}`;
  }
  return area.toFixed(2);
}

/**
 * Die Live-Zeilen unter dem Stempel: Bodenfläche (mit Präfix) wenn showFloorArea,
 * Nutzung (SIA-Kürzel · Bezeichnung) wenn showUsage, Personenzahl wenn gesetzt.
 * Die Ausrichtung folgt den Stempel-Feldern; fehlt sie, gilt „zentriert"
 * (Alt-Verhalten).
 */
export function roomStampExtraLines(stamp: RoomStamp, ctx: RoomStampContext): RoomStampLine[] {
  const lines: RoomStampLine[] = [];
  if (stamp.showFloorArea) {
    const prefix = stamp.floorAreaPrefix ?? "";
    lines.push({
      text: `${prefix}${formatStampArea(ctx.netArea, stamp.roundingStep)} m²`,
      align: stamp.floorAreaAlign ?? "center",
    });
  }
  if (stamp.showUsage) {
    lines.push({
      text: `${ctx.siaCategory} · ${ctx.siaLabel}`,
      align: stamp.usageAlign ?? "center",
    });
  }
  if (stamp.occupancy != null) {
    lines.push({
      text: `${stamp.occupancy} Pers.`,
      align: "center",
    });
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
