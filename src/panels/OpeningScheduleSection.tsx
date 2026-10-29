// Fenster- und Türliste im Flächenbilanz-Panel ([97]): eine Zeile je Öffnung mit Nummer, Typ, Geschoss,
// angrenzenden Räumen, Mass, Aufschlag und den Kennwerten (Brand-, Schallschutz, U-Wert, Einbruchhemmung,
// aussen/innen, Bemerkung). Die Zeilen rechnet der Kern (`openingSchedule`, abgeleitet aus Modell und
// Räumen); die Kennwert-Felder sind direkt in der Tabelle editierbar (Ops mit coalesceKey: Tippen = ein
// Undo-Schritt). CSV und PDF kommen aus demselben Berichtsmodell wie der Flächennachweis.

import { useMemo } from "react";
import { t } from "../i18n";
import { usePanelHost } from "./host";
import { areaReportToCsv, buildAreaReportPdf, buildOpeningReport, externalText, openingSchedule, patchItem, roomsText, swingText } from "../core";
import type { OpeningScheduleRow } from "../core";
import type { Opening, Project } from "../model/types";
import { downloadCsv } from "./downloadFile";
import { useStore } from "../state/appStore";

type TextField = "mark" | "fireRating" | "soundClass" | "burglaryClass" | "notes";

const m2 = (v: number) => v.toFixed(2);

export function OpeningScheduleSection() {
  const host = usePanelHost();
  const project = host.project;
  const applyChange = useStore((s) => s.applyChange);
  const notify = useStore((s) => s.notify);
  const rows = useMemo(() => openingSchedule(project), [project]);
  const stem = `${project.name || "projekt"}-fenster-tueren`;

  const patch = (id: string, change: Partial<Opening>, field: string) =>
    applyChange((p: Project) => patchItem(p, "openings", id, change), `opening:${id}:${field}`);
  const setText = (id: string, field: TextField, text: string) => patch(id, { [field]: text.trim() === "" ? undefined : text } as Partial<Opening>, field);
  const setU = (id: string, text: string) => {
    const v = Number(text.replace(",", "."));
    patch(id, { uValue: text.trim() !== "" && Number.isFinite(v) && v > 0 ? v : undefined }, "uValue");
  };
  const setExternal = (id: string, value: string) => patch(id, { isExternal: value === "" ? undefined : value === "ext" }, "isExternal");

  const exportPdf = () => {
    try {
      buildAreaReportPdf(buildOpeningReport(project)).save(`${stem}.pdf`);
    } catch {
      notify(t("openings.exportPdf.fail"));
    }
  };
  const select = (r: OpeningScheduleRow) => host.onSelectScheduleRow(r.kind === "door" ? "Tür" : "Fenster", r.id, r.floorId);

  const textInput = (r: OpeningScheduleRow, field: TextField, value: string, className = "") => (
    <input type="text" className={`kz-input opening-input ${className}`} value={value} onChange={(e) => setText(r.id, field, e.target.value)} />
  );

  return (
    <div className="area-section opening-section">
      <div className="balance-head">
        <span className="balance-section-label">{t("openings.title")}</span>
        {rows.length > 0 && (
          <span className="area-actions">
            <button type="button" className="balance-export" onClick={() => downloadCsv(`${stem}.csv`, areaReportToCsv(buildOpeningReport(project)))}>
              {t("openings.exportCsv")}
            </button>
            <button type="button" className="balance-export" onClick={exportPdf}>
              {t("openings.exportPdf")}
            </button>
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="balance-empty">{t("openings.empty")}</div>
      ) : (
        <div className="area-scroll">
          <table className="area-table opening-table">
            <thead>
              <tr>
                <th>{t("openings.col.mark")}</th>
                <th>{t("openings.col.type")}</th>
                <th>{t("openings.col.floor")}</th>
                <th>{t("openings.col.rooms")}</th>
                <th className="num">{t("openings.col.width")}</th>
                <th className="num">{t("openings.col.height")}</th>
                <th className="num">{t("openings.col.clearWidth")}</th>
                <th className="num">{t("openings.col.sill")}</th>
                <th>{t("openings.col.swing")}</th>
                <th>{t("openings.col.fire")}</th>
                <th>{t("openings.col.sound")}</th>
                <th className="num">{t("openings.col.u")}</th>
                <th>{t("openings.col.rc")}</th>
                <th>{t("openings.col.ext")}</th>
                <th>{t("openings.col.notes")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const own = project.openings?.find((o) => o.id === r.id);
                const door = r.kind === "door";
                return (
                  <tr key={r.id}>
                    <td title={r.markAuto ? t("openings.markAuto") : undefined}>
                      <input
                        type="text"
                        className="kz-input opening-input opening-mark"
                        value={r.markAuto ? "" : r.mark}
                        placeholder={r.mark}
                        onChange={(e) => setText(r.id, "mark", e.target.value)}
                      />
                    </td>
                    <td>{r.typeName}</td>
                    <td className="opening-select" onClick={() => select(r)}>
                      {r.floor}
                    </td>
                    <td>{roomsText(r)}</td>
                    <td className="num">{m2(r.width)}</td>
                    <td className="num">{m2(r.height)}</td>
                    <td className="num">{door ? `${m2(r.clearWidth)} × ${m2(r.clearHeight)}` : ""}</td>
                    <td className="num">{door ? "" : m2(r.sill)}</td>
                    <td>{swingText(r)}</td>
                    <td>{door ? textInput(r, "fireRating", r.fireRating, "opening-short") : ""}</td>
                    <td>{textInput(r, "soundClass", r.soundClass, "opening-short")}</td>
                    <td className="num">
                      <input
                        type="text"
                        inputMode="decimal"
                        className="kz-input kz-num opening-input opening-short"
                        defaultValue={r.uValue === null ? "" : String(r.uValue)}
                        key={`${r.id}:${r.uValue}`}
                        onBlur={(e) => setU(r.id, e.target.value)}
                      />
                    </td>
                    <td>{textInput(r, "burglaryClass", r.burglaryClass, "opening-short")}</td>
                    <td>
                      <select className="kz-input" value={own?.isExternal === undefined ? "" : own.isExternal ? "ext" : "int"} onChange={(e) => setExternal(r.id, e.target.value)}>
                        <option value="">{`${t("openings.extAuto")}${r.external === null ? "" : `: ${externalText(r.external)}`}`}</option>
                        <option value="ext">{t("openings.external")}</option>
                        <option value="int">{t("openings.internal")}</option>
                      </select>
                    </td>
                    <td>{textInput(r, "notes", r.notes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ul className="area-notes">
        <li>{t("openings.foot")}</li>
      </ul>
    </div>
  );
}
