// Abschnitt „Raum" der Attribute ([165] aus `ObjectInfoPanel.tsx`): Name, Nutzung, SIA-Kategorie, Fläche,
// Stempel und die Oberflächen-Felder. Gerufen von `AttributesPanel`.

import type { RoomInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";
import type { SiaCategory, Project, Room } from "../../model/types";
import { SIA_CATEGORIES, siaLabelFull, patchItems, roomBook, ROOM_USAGES, usageLabel } from "../../core";
import { addUnitOps, assignRoomsOps, draftUnit } from "../unitOps";
import { formatM } from "../../model/types";
import { useStore } from "../../state/appStore";
import type { TranslationKey } from "../../i18n";
import { selectionRoomValues } from "../../state/mixedValues";
import { MixedMark } from "./fields";
import { useMulti } from "./useMulti";

// ── Raum-Attribut-Abschnitt ──────────────────────────────────────────────────
// Editierbarer Name, SIA-416-Kategorie (5 Blatt-Kategorien), abgeleitete Fläche
// + Umfang (read-only), Referenzgeschoss. Alle Werte/Setter über den Host. Der Stempel hat seit [218] einen
// eigenen Abschnitt (`RoomStampSection`).
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

      {/* [278] Nutzungseinheit und Zimmer-Zählung (Wohnungsspiegel). */}
      <RoomUnitFields roomId={roomId} />
    </>
  );
}

const UNIT_NONE = "";
const UNIT_NEW = "__new";
const UNIT_MIXED = "__mixed";
/** Zimmer-Zählung: automatisch (aus der Nutzung) oder fest 0 / 0.5 / 1 / 1.5 / 2. */
const ROOM_COUNTS = [0, 0.5, 1, 1.5, 2] as const;
const COUNT_KEY = { 0: "units.roomCount.0", 0.5: "units.roomCount.05", 1: "units.roomCount.1", 1.5: "units.roomCount.15", 2: "units.roomCount.2" } as const satisfies Record<(typeof ROOM_COUNTS)[number], TranslationKey>;

/** [278] Einheit des Raums (Auswahl, „Neue Einheit …“) und Beitrag zur Zimmerzahl. Bei Mehrfachauswahl gilt die Wahl für alle
 *  gewählten Räume in einem Undo-Schritt; unterschiedliche Werte zeigt die Auswahl als „gemischt“. */
function RoomUnitFields({ roomId }: { roomId: string }) {
  const project = useStore((st) => st.project);
  const applyChange = useStore((s) => s.applyChange);
  const selectedRooms = useStore((s) => s.selection.rooms);
  const room = (project.rooms ?? []).find((r) => r.id === roomId);
  if (!room) return null;
  const ids = selectedRooms.length > 1 && selectedRooms.includes(roomId) ? [...selectedRooms] : [roomId];
  const group = ids.map((id) => (project.rooms ?? []).find((r) => r.id === id)).filter((r): r is Room => !!r);
  const unitIds = new Set(group.map((r) => r.unitId ?? UNIT_NONE));
  const counts = new Set(group.map((r) => (r.roomCount === undefined ? "auto" : String(r.roomCount))));
  const units = project.units ?? [];
  const known = new Set(units.map((u) => u.id));
  const unitValue = unitIds.size > 1 ? UNIT_MIXED : known.has(room.unitId ?? "") ? (room.unitId as string) : UNIT_NONE;
  const countValue = counts.size > 1 ? UNIT_MIXED : room.roomCount === undefined ? "auto" : String(room.roomCount);
  const onUnit = (v: string) => {
    if (v === UNIT_MIXED) return;
    if (v === UNIT_NEW) applyChange((p: Project) => addUnitOps(p, draftUnit(p, t("units.nameDefault")), ids), "unit:new");
    else applyChange((p: Project) => assignRoomsOps(p, ids, v === UNIT_NONE ? undefined : v), `room:${roomId}:unit`);
  };
  const onCount = (v: string) => {
    if (v === UNIT_MIXED) return;
    applyChange((p: Project) => patchItems(p, "rooms", ids, (r) => ({ ...r, roomCount: v === "auto" ? undefined : Number(v) }) as Room), `room:${roomId}:roomCount`);
  };
  const mixed = { value: UNIT_MIXED, label: t("objsettings.mixed"), disabled: true };
  return (
    <>
      <div className="objinfo-section-label">{t("units.title")}</div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("units.field")}</span>
        <Dropdown
          value={unitValue}
          onChange={onUnit}
          options={[
            ...(unitValue === UNIT_MIXED ? [mixed] : []),
            { value: UNIT_NONE, label: t("units.field.none") },
            ...units.map((u) => ({ value: u.id, label: u.unitType ? `${u.name} · ${u.unitType}` : u.name })),
            { value: UNIT_NEW, label: t("units.field.new") },
          ]}
          title={t("units.field")}
          width={170}
        />
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("units.roomCount")}</span>
        <Dropdown
          value={countValue}
          onChange={onCount}
          options={[
            ...(countValue === UNIT_MIXED ? [mixed] : []),
            { value: "auto", label: t("units.roomCount.auto") },
            ...ROOM_COUNTS.map((c) => ({ value: String(c), label: t(COUNT_KEY[c]) })),
          ]}
          title={t("units.roomCount.hint")}
          width={170}
        />
      </div>
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
