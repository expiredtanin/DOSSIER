// Bauteilliste mit U-Werten im Flächenbilanz-Panel ([71]): je Wand, Decke und Dach Typ, Geschoss, Fläche, Dicke und
// U-Wert aus dem Schichtaufbau (SIA 180 / EN ISO 6946, λ je Bauteil). Die Zeilen rechnet der Kern (`elementSchedule`);
// ein „–" mit Hinweis steht, wo einer Schicht λ fehlt. CSV und PDF kommen aus dem Berichtsmodell wie die Fenster-/Türliste.

import { useMemo } from "react";
import { t } from "../i18n";
import { usePanelHost } from "./host";
import { areaReportToCsv, buildAreaReportPdf, buildElementReport, elementSchedule } from "../core";
import { downloadCsv } from "./downloadFile";
import { useStore } from "../state/appStore";

export function ElementScheduleSection() {
  const host = usePanelHost();
  const project = host.project;
  const notify = useStore((s) => s.notify);
  const rows = useMemo(() => elementSchedule(project), [project]);
  const stem = `${project.name || "projekt"}-bauteile`;
  const exportPdf = () => {
    try {
      buildAreaReportPdf(buildElementReport(project)).save(`${stem}.pdf`);
    } catch {
      notify(t("openings.exportPdf.fail"));
    }
  };
  return (
    <div className="area-section element-section" data-element-schedule>
      <div className="balance-head">
        <span className="balance-section-label">{t("elemSchedule.title")}</span>
        {rows.length > 0 && (
          <span className="area-actions">
            <button type="button" className="balance-export" onClick={() => downloadCsv(`${stem}.csv`, areaReportToCsv(buildElementReport(project)))}>
              {t("openings.exportCsv")}
            </button>
            <button type="button" className="balance-export" onClick={exportPdf}>
              {t("openings.exportPdf")}
            </button>
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="balance-empty">{t("elemSchedule.empty")}</div>
      ) : (
        <div className="area-scroll">
          <table className="area-table">
            <thead>
              <tr>
                <th>{t("sheetTable.col.kind")}</th>
                <th>{t("elemSchedule.col.type")}</th>
                <th>{t("openings.col.floor")}</th>
                <th className="num">{t("elemSchedule.col.area")}</th>
                <th className="num">{t("elemSchedule.col.thickness")}</th>
                <th className="num">{t("openings.col.u")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}:${r.id}`}>
                  <td>{t(`elemSchedule.kind.${r.kind}`)}</td>
                  <td>{r.typeName}</td>
                  <td>{r.floor}</td>
                  <td className="num">{r.area.toFixed(2)}</td>
                  <td className="num">{(r.thickness * 100).toFixed(1)}</td>
                  <td className="num" title={r.complete ? undefined : t("elemSchedule.incompleteHint")}>
                    {r.u === null ? "–" : r.u.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="area-notes">
        <li>{t("elemSchedule.foot")}</li>
      </ul>
    </div>
  );
}
