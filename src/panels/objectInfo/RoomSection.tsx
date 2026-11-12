// Abschnitt „Raum" der Attribute ([165] aus `ObjectInfoPanel.tsx`): Name, Nutzung, SIA-Kategorie, Fläche,
// Stempel und die Oberflächen-Felder. Gerufen von `AttributesPanel`.

import type { RoomInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";
import type { SiaCategory, Project, Room } from "../../model/types";
import { SIA_CATEGORIES, siaLabelFull, patchItems, roomBook, ROOM_USAGES, usageLabel } from "../../core";
import { formatM } from "../../model/types";
import { useStore } from "../../state/appStore";
import type { TranslationKey } from "../../i18n";
import { selectionRoomValues } from "../../state/mixedValues";
import { MixedMark } from "./fields";
import { useMulti } from "./useMulti";

// ── Raum-Attribut-Abschnitt ──────────────────────────────────────────────────
// Editierbarer Name, SIA-416-Kategorie (5 Blatt-Kategorien), abgeleitete Fläche
// + Umfang (read-only), Referenzgeschoss, sowie ein Button, der den Rich-Text-
// Stempel-Editor öffnet. Alle Werte/Setter über den Host.
export function RoomSection({
  room,
  roomId,
  host,
}: {
  room: RoomInfo;
  roomId: string;
  host: ReturnType<typeof usePanelHost>;
}) {
  // [195b] Mehrfachauswahl: SIA-Kategorie und Oberflächen gelten für alle gewählten Räume; der Name bleibt je Raum
  // eigen (Feld gesperrt).
  const multi = useMulti("rooms", selectionRoomValues);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.room.section")}</div>

      {/* Name (editierbar). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.name")}</span>
        <input
          type="text"
          className="objinfo-text"
          value={room.name}
          disabled={multi != null}
          onChange={(e) => host.onSetRoomName(e.target.value)}
          title={t("objinfo.room.name")}
        />
      </div>

      {/* SIA-416-Kategorie (5 Blatt-Kategorien). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.sia")}</span>
        <Dropdown
          value={room.siaCategory}
          onChange={(v) => host.onSetRoomSia(v as SiaCategory)}
          options={SIA_CATEGORIES.map((c) => ({
            value: c,
            label: siaLabelFull(c),
          }))}
          title={t("objinfo.room.sia")}
          width={170}
        />
        <MixedMark on={multi?.siaCategory.mixed} what="sia" />
      </div>

      {/* Fläche + Umfang (read-only, abgeleitet). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.area")}</span>
        <span className="objinfo-fval">{room.area.toFixed(2)} m²</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.perimeter")}</span>
        <span className="objinfo-fval">{formatM(room.perimeter)}</span>
      </div>

      {/* Referenzgeschoss (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.refFloor")}</span>
        <span className="objinfo-fval">{room.floorName}</span>
      </div>

      {/* [158] Raumbuch: Nutzung und Oberflächen. */}
      <RoomFinishFields roomId={roomId} />

      {/* Stempel bearbeiten (öffnet den Rich-Text-Editor). */}
      <button
        type="button"
        className="objinfo-btn"
        onClick={() => host.onEditRoomStamp(roomId)}
      >
        {t("objinfo.room.editStamp")}
      </button>
    </>
  );
}


type RoomFinishField = "floorFinish" | "wallFinish" | "ceilingFinish" | "floorBuildUp";


/** [158] Nutzung (Nassraum abgeleitet) und Oberflächen Boden/Wand/Decke (Material aus dem Projekt oder
 *  Freitext; ein eingegebener Material-Name wird als Verweis gespeichert) und Bodenaufbau. */
function RoomFinishFields({ roomId }: { roomId: string }) {
  const storeProject = useStore((st) => st.project);
  const applyChange = useStore((s) => s.applyChange);
  const selectedRooms = useStore((s) => s.selection.rooms);
  const project = storeProject;
  const room = (project.rooms ?? []).find((r) => r.id === roomId);
  if (!room) return null;
  const comps = project.components;
  const listId = `room-finish-materials-${roomId}`;
  const shown = (v: string | undefined) => comps.find((c) => c.id === v)?.name ?? v ?? "";
  // [195b] Mehrfachauswahl: Nutzung und Oberflächen gelten für alle gewählten Räume (ein Undo-Schritt).
  const set = (field: RoomFinishField | "usage", value: string | undefined) => {
    const ids = selectedRooms.length > 1 && selectedRooms.includes(roomId) ? [...selectedRooms] : [roomId];
    applyChange((p: Project) => patchItems(p, "rooms", ids, (r) => ({ ...r, [field]: value }) as Room), `room:${roomId}:${field}`);
  };
  const setFinish = (field: RoomFinishField, text: string) => {
    const v = text.trim();
    if (!v) return set(field, undefined);
    const comp = field === "floorBuildUp" ? undefined : comps.find((c) => c.name.trim() === v);
    set(field, comp ? comp.id : text);
  };
  // Nassraum wie im Kern (Nutzung, sonst Name), für [156] „Nassräume" im Grundriss.
  const wet = roomBook(project).rows.find((r) => r.id === roomId)?.wet ?? false;
  const finishInput = (field: RoomFinishField, label: TranslationKey) => (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{t(label)}</span>
      <input
        type="text"
        className="objinfo-text"
        list={field === "floorBuildUp" ? undefined : listId}
        value={shown(room[field])}
        placeholder={field === "floorBuildUp" ? undefined : t("objinfo.room.finishHint")}
        onChange={(e) => setFinish(field, e.target.value)}
        title={t(label)}
      />
    </div>
  );
  return (
    <>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.usage")}</span>
        <Dropdown
          value={room.usage ?? ""}
          onChange={(v) => set("usage", v || undefined)}
          options={[{ value: "", label: t("objinfo.room.usageNone") }, ...ROOM_USAGES.map((u) => ({ value: u, label: usageLabel(u) }))]}
          title={t("objinfo.room.usage")}
          width={170}
        />
      </div>
      {wet && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.room.wet")}</span>
          <span className="objinfo-fval">✓</span>
        </div>
      )}
      <div className="objinfo-section-label">{t("objinfo.room.finishes")}</div>
      <datalist id={listId}>
        {comps.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
      {finishInput("floorFinish", "objinfo.room.floorFinish")}
      {finishInput("wallFinish", "objinfo.room.wallFinish")}
      {finishInput("ceilingFinish", "objinfo.room.ceilingFinish")}
      {finishInput("floorBuildUp", "objinfo.room.buildUp")}
    </>
  );
}
