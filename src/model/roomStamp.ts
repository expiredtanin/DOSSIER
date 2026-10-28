// Reines Modul für den strukturierten Raum-Stempel (Feldmodell): Standard-Stempel und Anzeigename
// für Listen. Das Stempel-Dokument und die Live-Zeilen (Fläche, Nutzung, Personen) baut der Kern
// beim Plan-Aufbau (`src-tauri/core/src/plan/domains.rs`, [K3d]).

import type { Room, RoomStamp } from "./types";
import type { Align } from "../text/richText";

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
