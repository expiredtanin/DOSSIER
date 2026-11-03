// Stempel-Editor eines Raums als schwebendes Fenster ([121] aus App.tsx herausgelöst): Doppelklick
// auf einen Raumstempel bzw. Button in der Objekt-Info öffnet ihn. Strukturierter Stempel für neue
// Räume, freier Rich-Text nur noch als Fallback für Alt-Räume. Liest die Räume selbst aus dem Store.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { defaultRoomStamp } from "../model/roomStamp";
import type { Room } from "../model/types";
import { RoomStampEditor } from "../panels/RoomStampEditor";
import { useStore } from "../state/appStore";
import { docFromText, type RichTextDoc } from "../text/richText";
import { TextEditorDialog } from "./TextEditorDialog";

const NO_ROOMS: Room[] = [];

export function RoomStampEditorHost({
  roomId,
  onClose,
  setRoomStamp,
  setRoomStampDoc,
}: {
  roomId: string;
  onClose: () => void;
  setRoomStamp: (id: string, stamp: NonNullable<Room["stamp"]>) => void;
  setRoomStampDoc: (id: string, doc: RichTextDoc) => void;
}) {
  const rooms = useStore((s) => s.project.rooms) ?? NO_ROOMS;
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return null;
  // Strukturierter Stempel für neue Räume (kein Alt-Rich-Text) bzw. sobald
  // einer gesetzt ist; freier Text nur noch als Fallback für Alt-Räume,
  // die einen stampDoc, aber keinen strukturierten Stempel tragen.
  const useStructured = Boolean(room.stamp) || !room.stampDoc;
  if (useStructured) {
    return (
      <RoomStampEditor
        value={room.stamp ?? defaultRoomStamp(room)}
        onApply={(edited) => {
          setRoomStamp(room.id, edited);
          onClose();
        }}
        onCancel={() => onClose()}
      />
    );
  }
  const doc = room.stampDoc ?? docFromText(room.name);
  return (
    <TextEditorDialog
      value={doc}
      onApply={(edited) => {
        setRoomStampDoc(room.id, edited);
        onClose();
      }}
      onCancel={() => onClose()}
    />
  );
}
