// Reines Modul für den strukturierten Raum-Stempel (Feldmodell): Standard-Stempel und Anzeigename
// für Listen. Das Stempel-Dokument und die Live-Zeilen (Fläche, Nutzung, Personen) baut der Kern
// beim Plan-Aufbau (`src-tauri/core/src/plan/domains.rs`, [K3d]).

import type { Room, RoomStamp } from "./types";
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
