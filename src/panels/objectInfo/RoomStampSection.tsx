// [218] Abschnitt „Raumstempel" der Objekteinstellungen (Doppelklick auf einen Stempel öffnet das Fenster mit diesem
// Abschnitt; vorher Overlay-Dialog „Fenster im Fenster"): Nummer, Namenszeilen mit Ausrichtung, Flächen-/Nutzungs-/
// Belagszeile und die Schrift (Familie, Grösse, fett, kursiv, Farbe) für den ganzen Stempel und je Zeile.
// Schreibt über die Ops des Stores (`applyChange`, wie die Oberflächenfelder des Raums), darum läuft der Abschnitt
// im Nebenfenster unverändert über die Spiegelung. Mehrfachauswahl: gleiche Werte zeigen, abweichende „gemischt";
// eine Änderung gilt für alle gewählten Räume in EINEM Undo-Schritt; Nummer und Namen bleiben je Raum eigen.

import { t } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import { defaultRoomStamp, setStampFontAttr, STAMP_FONT_LINES, type StampFontAttr, type StampFontKey } from "../../model/roomStamp";
import type { Room, RoomStamp, RoomStampFont } from "../../model/types";
import { useStore } from "../../state/appStore";
import { commonValue, type Common } from "../../state/mixedValues";
import { editRoomStamps, stampTargetIds } from "../../state/roomStampEdit";
import { TEXT_FONTS } from "../../text/fontList";
import type { Align } from "../../text/richText";
import { Dropdown } from "../../ui/Dropdown";
import { MixedMark } from "./fields";

const NO_ROOMS: Room[] = [];
type AlignKey = "nameAlign" | "line2Align" | "floorAreaAlign" | "usageAlign";
const RESET_ICON = "restart_alt";
const ALIGN_CELLS: { align: Align; icon: string; titleKey: TranslationKey }[] = [
  { align: "left", icon: "format_align_left", titleKey: "text.align.left" },
  { align: "center", icon: "format_align_center", titleKey: "text.align.center" },
  { align: "right", icon: "format_align_right", titleKey: "text.align.right" },
];

function AlignToggle({ value, mixed, disabled, label, onChange }: { value: Align | undefined; mixed?: boolean; disabled?: boolean; label: string; onChange: (a: Align) => void }) {
  const current = mixed ? undefined : (value ?? "left");
  return (
    <div className="roomstamp-align" role="group" aria-label={label}>
      {ALIGN_CELLS.map((cell) => (
        <button
          key={cell.align}
          type="button"
          className={`roomstamp-align-btn${current === cell.align ? " active" : ""}`}
          disabled={disabled}
          aria-pressed={current === cell.align}
          title={t(cell.titleKey)}
          aria-label={t(cell.titleKey)}
          onClick={() => onChange(cell.align)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">{cell.icon}</span>
        </button>
      ))}
    </div>
  );
}

/** Dreifach-Wahl: fehlt = wie Modelldarstellung (Stufe), sonst an/aus am Stempel. */
function TriState({ value, mixed, onChange, testId }: { value: boolean | undefined; mixed?: boolean; onChange: (v: boolean | undefined) => void; testId?: string }) {
  return (
    <select
      className="objinfo-text"
      data-testid={testId}
      value={mixed ? "mixed" : value === undefined ? "" : value ? "1" : "0"}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "1")}
    >
      {mixed && <option value="mixed" disabled>{t("objsettings.mixed")}</option>}
      <option value="">{t("roomStamp.asModelView")}</option>
      <option value="1">{t("roomStamp.on")}</option>
      <option value="0">{t("roomStamp.off")}</option>
    </select>
  );
}

export function RoomStampSection({ roomId }: { roomId: string }) {
  const rooms = useStore((s) => s.project.rooms) ?? NO_ROOMS;
  const selected = useStore((s) => s.selection.rooms);
  const ids = stampTargetIds(selected, roomId);
  const multi = ids.length > 1;
  const targets = rooms.filter((r) => ids.includes(r.id));
  const stamps = targets.map((r) => r.stamp ?? defaultRoomStamp(r));

  /** Gemeinsamer Wert eines Stempelfelds über die gewählten Räume. */
  const common = <T,>(pick: (s: RoomStamp) => T): Common<T> => commonValue(stamps.map(pick));
  /** Änderung am Stempel aller gewählten Räume (ein Undo-Schritt; gleicher Schlüssel = ein Schritt beim Tippen). */
  const edit = (fn: (s: RoomStamp) => RoomStamp, key: string) => editRoomStamps(ids, fn, `stamp:${roomId}:${key}`);
  /** Feld setzen; leer/`undefined` entfernt es (⇒ Vorgabe). */
  const setField = <K extends keyof RoomStamp>(key: K, value: RoomStamp[K] | undefined) =>
    edit((s) => {
      const next = { ...s };
      if (value === undefined || value === "") delete next[key];
      else next[key] = value as RoomStamp[K];
      return next;
    }, String(key));

  if (targets.length === 0) return null;

  const alignOf = (key: AlignKey, label: TranslationKey, disabled = false) => {
    const c = common((s) => s[key] ?? "left");
    return <AlignToggle value={c.value} mixed={c.mixed} disabled={disabled} label={t(label)} onChange={(a) => setField(key, a)} />;
  };
  const text = (label: TranslationKey, key: "number" | "name" | "nameLine2" | "floorAreaPrefix", perRoom: boolean, testId: string, align?: AlignKey) => {
    const c = common((s) => (s[key] as string | undefined) ?? "");
    const locked = perRoom && multi;
    return (
      <div className="objinfo-field">
        <span className="objinfo-flabel" title={t(label)}>{t(label)}</span>
        <input
          type="text"
          className="objinfo-text"
          data-testid={testId}
          value={locked ? "" : (c.value ?? "")}
          placeholder={c.mixed ? t("objsettings.mixed") : undefined}
          disabled={locked}
          onChange={(e) => setField(key, key === "name" ? e.target.value : e.target.value || undefined)}
          title={t(label)}
        />
        {align && alignOf(align, label)}
      </div>
    );
  };
  const tri = (label: TranslationKey, key: "showFloorArea" | "showUsage", testId: string, align: AlignKey, off: boolean) => {
    const c = common((s) => s[key]);
    return (
      <div className="objinfo-field">
        <span className="objinfo-flabel" title={t(label)}>{t(label)}</span>
        <TriState testId={testId} value={c.value} mixed={c.mixed} onChange={(v) => setField(key, v)} />
        {alignOf(align, label, off)}
      </div>
    );
  };
  const check = (label: TranslationKey, key: "showDivider" | "showFinish") => {
    const c = common((s) => s[key] === true);
    return (
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t(label)}</span>
        <input type="checkbox" checked={c.value === true} ref={(el) => { if (el) el.indeterminate = c.mixed; }} onChange={(e) => setField(key, e.target.checked ? true : undefined)} />
        <MixedMark on={c.mixed} what={key} />
      </div>
    );
  };
  const floorOff = common((s) => s.showFloorArea === false).value === true;
  const usageOff = common((s) => s.showUsage === false).value === true;
  const rounding = common((s) => s.roundingStep);
  const occupancy = common((s) => s.occupancy);

  return (
    <div data-testid="roomstamp-section">
      {text("roomStamp.number", "number", true, "roomstamp-number")}
      {text("roomStamp.name", "name", true, "roomstamp-name", "nameAlign")}
      {text("roomStamp.nameLine2", "nameLine2", true, "roomstamp-line2", "line2Align")}
      {tri("roomStamp.showFloorArea", "showFloorArea", "roomstamp-showFloorArea", "floorAreaAlign", floorOff)}
      {text("roomStamp.floorAreaPrefix", "floorAreaPrefix", false, "roomstamp-prefix")}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("roomStamp.roundingStep")}</span>
        <select
          className="objinfo-text"
          value={rounding.mixed ? "mixed" : (rounding.value ?? "")}
          disabled={floorOff}
          onChange={(e) => setField("roundingStep", e.target.value === "" ? undefined : Number(e.target.value))}
        >
          {rounding.mixed && <option value="mixed" disabled>{t("objsettings.mixed")}</option>}
          <option value="">{t("roomStamp.roundingStepDefault")}</option>
          <option value="0.01">0.01 m²</option>
          <option value="0.1">0.1 m²</option>
          <option value="0.5">0.5 m²</option>
          <option value="1">1 m²</option>
        </select>
      </div>
      {tri("roomStamp.showUsage", "showUsage", "roomstamp-showUsage", "usageAlign", usageOff)}
      {check("roomStamp.showDivider", "showDivider")}
      {check("roomStamp.showFinish", "showFinish")}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("roomStamp.occupancy")}</span>
        <input
          type="number"
          min={0}
          step={1}
          className="objinfo-text"
          value={occupancy.mixed ? "" : (occupancy.value ?? "")}
          placeholder={occupancy.mixed ? t("objsettings.mixed") : undefined}
          onChange={(e) => setField("occupancy", e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </div>

      <div className="objinfo-section-label">{t("roomStamp.font.section")}</div>
      {STAMP_FONT_LINES.map((line) => (
        <FontRow key={line.key} line={line} stamps={stamps} edit={edit} />
      ))}
    </div>
  );
}

/** Eine Schriftzeile: Familie, Grösse (pt), fett, kursiv, Farbe, Zurücksetzen auf die Vorgabe. */
function FontRow({
  line,
  stamps,
  edit,
}: {
  line: (typeof STAMP_FONT_LINES)[number];
  stamps: readonly RoomStamp[];
  edit: (fn: (s: RoomStamp) => RoomStamp, key: string) => void;
}) {
  const key: StampFontKey = line.key;
  const attr = <K extends StampFontAttr>(a: K): Common<RoomStampFont[K]> => commonValue(stamps.map((s) => s[key]?.[a]));
  const set = <K extends StampFontAttr>(a: K, v: RoomStampFont[K] | undefined) => edit((s) => setStampFontAttr(s, key, a, v), `${key}.${a}`);
  const family = attr("family");
  const size = attr("sizePt");
  const bold = attr("bold");
  const italic = attr("italic");
  const color = attr("color");
  const anySet = stamps.some((s) => s[key] !== undefined);
  const label = t(line.labelKey as TranslationKey);
  const toggle = (a: "bold" | "italic", c: Common<boolean | undefined>, builtin: boolean, icon: string) => {
    const on = c.mixed ? false : (c.value ?? builtin);
    return (
      <button
        type="button"
        className={`roomstamp-align-btn roomstamp-fontbtn${on ? " active" : ""}`}
        data-testid={`roomstamp-${key}-${a}`}
        aria-pressed={on}
        title={t(a === "bold" ? "text.bold" : "text.italic")}
        aria-label={t(a === "bold" ? "text.bold" : "text.italic")}
        onClick={() => set(a, !on)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
      </button>
    );
  };
  return (
    <div className="roomstamp-fontrow" data-testid={`roomstamp-font-${key}`}>
      <div className="objinfo-field">
        <span className="objinfo-flabel" title={label}>{label}</span>
        <Dropdown
          value={family.mixed ? "" : (family.value ?? "")}
          onChange={(v) => set("family", v || undefined)}
          options={[{ value: "", label: family.mixed ? t("objsettings.mixed") : t("roomStamp.font.default") }, ...TEXT_FONTS.map((f) => ({ value: f, label: f }))]}
          title={`${label} — ${t("roomStamp.font.family")}`}
          width={150}
        />
      </div>
      <div className="objinfo-field roomstamp-fontattrs">
        <input
          type="number"
          min={1}
          max={200}
          step={0.5}
          className="objinfo-text roomstamp-size"
          data-testid={`roomstamp-${key}-size`}
          value={size.mixed ? "" : (size.value ?? "")}
          placeholder={size.mixed ? t("objsettings.mixed") : String(line.size)}
          title={`${label} — ${t("roomStamp.font.size")}`}
          aria-label={`${label} — ${t("roomStamp.font.size")}`}
          onChange={(e) => set("sizePt", e.target.value === "" ? undefined : Number(e.target.value))}
        />
        <span className="objinfo-muted">pt</span>
        {toggle("bold", bold, line.bold, "format_bold")}
        {toggle("italic", italic, line.italic, "format_italic")}
        <input
          type="color"
          className="roomstamp-color"
          data-testid={`roomstamp-${key}-color`}
          value={color.mixed ? "#000000" : (color.value ?? "#000000")}
          title={`${label} — ${t("roomStamp.font.color")}`}
          aria-label={`${label} — ${t("roomStamp.font.color")}`}
          onChange={(e) => set("color", e.target.value)}
        />
        <button
          type="button"
          className="roomstamp-align-btn roomstamp-fontbtn"
          disabled={!anySet}
          title={t("roomStamp.font.reset")}
          aria-label={t("roomStamp.font.reset")}
          onClick={() => edit((s) => { const n = { ...s }; delete n[key]; return n; }, `${key}.reset`)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">{RESET_ICON}</span>
        </button>
        <MixedMark on={family.mixed || size.mixed || bold.mixed || italic.mixed || color.mixed} what={`font-${key}`} />
      </div>
    </div>
  );
}
