// [218] Raumstempel mehrerer Räume in EINEM Undo-Schritt ändern (Abschnitt „Raumstempel" der Objekteinstellungen).
// Fehlt einem Raum der Stempel, beginnt die Änderung beim Standard-Stempel des Raums. Gleicher `key` (Tippen,
// Regler) fasst aufeinanderfolgende Änderungen zu einem Schritt zusammen.

import { patchItems } from "../core";
import { defaultRoomStamp } from "../model/roomStamp";
import type { Project, Room, RoomStamp } from "../model/types";
import { getState } from "./appStore";

export function editRoomStamps(ids: readonly string[], fn: (stamp: RoomStamp) => RoomStamp, key: string): void {
  getState().applyChange((p: Project) => patchItems(p, "rooms", [...ids], (r) => ({ ...r, stamp: fn(r.stamp ?? defaultRoomStamp(r)) }) as Room), key);
}

/** Räume, die eine Änderung trifft: bei Mehrfachauswahl alle gewählten (wenn `roomId` dazugehört), sonst nur `roomId`. */
export function stampTargetIds(selected: readonly string[], roomId: string): string[] {
  return selected.length > 1 && selected.includes(roomId) ? [...selected] : [roomId];
}
