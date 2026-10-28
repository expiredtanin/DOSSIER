// Inhalts-Panel „Flächenbilanz" — listet alle Räume gruppiert nach
// ihrer Flächenart (SIA 416) mit Zwischen-/Gesamtsummen und bietet einen
// CSV-Export, darüber die Kennzahlenleiste mit Parzelle und Raumprogramm
// (KennzahlenSection). Fläche/Bilanz werden LIVE aus den Raum-Umrissen abgeleitet
// (geometry/roomArea: evaluateRoom/balance/roomsToCsv) — nie gespeichert.
//
// Daten kommen über usePanelHost (project.rooms). Bezeichner englisch, UI-Text
// deutsch via t() (CONVENTIONS.md).

import { t } from "../i18n";
import { usePanelHost } from "./host";
import { balance, evaluateRoom, roomsToCsv, siaLabelFull } from "../core";
import type { Room } from "../model/types";
import { roomDisplayName } from "../model/roomStamp";
import { KennzahlenSection } from "./KennzahlenSection";
import { AreaTableSection } from "./AreaTableSection";
import { downloadCsv } from "./downloadFile";

/** Löst je Raum die anrechenbare (Netto-)Fläche + Kategorie auf. */
function roomAreas(rooms: Room[]): { category: Room["siaCategory"]; area: number }[] {
  return rooms.map((r) => ({
    category: r.siaCategory,
    area: evaluateRoom(r.boundary, r.siaCategory).netArea,
  }));
}

/** Löst den Anzeigenamen eines Geschosses (oder die ID) auf. */
function floorNameOf(
  levels: { id: string; name: string }[],
  floorId: string,
): string {
  return levels.find((z) => z.id === floorId)?.name ?? floorId;
}

export function RoomBalancePanel() {
  const host = usePanelHost();
  const rooms = host.project.rooms ?? [];
  const levels = host.project.drawingLevels;

  if (rooms.length === 0) {
    return (
      <div className="balance-panel">
        <KennzahlenSection />
        <AreaTableSection />
        <div className="balance-empty">{t("balance.empty")}</div>
      </div>
    );
  }

  const bal = balance(roomAreas(rooms));

  const onExport = () => {
    const csv = roomsToCsv(
      rooms.map((r) => ({
        number: r.stamp?.number ?? r.id,
        name: roomDisplayName(r),
        level: floorNameOf(levels, r.floorId),
        category: r.siaCategory,
        area: evaluateRoom(r.boundary, r.siaCategory).netArea,
      })),
    );
    downloadCsv("flaechenbilanz.csv", csv);
  };

  return (
    <div className="balance-panel">
      <div className="balance-head">
        <span className="balance-title">{t("balance.title")}</span>
        <button type="button" className="balance-export" onClick={onExport}>
          {t("balance.export")}
        </button>
      </div>

      {/* Kennzahlenleiste, Parzelle und Raumprogramm. */}
      <KennzahlenSection />

      {/* Flächentabelle und IVHB-Kennziffern. */}
      <AreaTableSection />

      {/* Raumliste (je Raum: Name · Geschoss · SIA · Fläche). */}
      <div className="balance-section-label">{t("balance.rooms")}</div>
      <div className="balance-table">
        {rooms.map((r) => {
          const res = evaluateRoom(r.boundary, r.siaCategory);
          return (
            <div key={r.id} className="balance-row">
              <span className="balance-name">{roomDisplayName(r)}</span>
              <span className="balance-cat">{r.siaCategory}</span>
              <span className="balance-area">{res.netArea.toFixed(2)} m²</span>
            </div>
          );
        })}
      </div>

      {/* SIA-416-Bilanz (Blatt-Kategorien + Zwischensummen NF/NGF + Gesamt GF). */}
      <div className="balance-section-label">{t("balance.summary")}</div>
      <div className="balance-table">
        {bal.rows.map((row) => (
          <div
            key={row.key}
            className={"balance-row" + (row.aggregate ? " aggregate" : "")}
            title={siaLabelFull(row.key)}
          >
            <span className="balance-name">
              {row.key} · {row.label}
            </span>
            <span className="balance-count">{row.count}</span>
            <span className="balance-area">{row.area.toFixed(2)} m²</span>
          </div>
        ))}
      </div>
    </div>
  );
}
