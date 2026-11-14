// [158] Raumbuch im Flächenbilanz-Panel: eine Zeile je Raum mit Geschoss, Nummer, Name, Fläche, Nutzung und
// den Oberflächen (Boden, Wand, Decke), dazu die Mengen je Material. Die Zeilen rechnet der Kern
// (`roomBook`); bearbeitet werden die Angaben in der Objekt-Info des Raums. CSV und PDF kommen aus
// demselben Berichtsmodell wie die Fenster-/Türliste.

import { CardTable } from "./CardTable";
import { useMemo } from "react";
import { t } from "../i18n";
import { exportProjectName, areaReportToCsv, buildAreaReportPdf, buildRoomBookReport, hasSlope, roomBook, usageLabel } from "../core";
import { downloadCsv } from "./downloadFile";
import { runWithAnonymityGate } from "../state/anonymityGate";
import { useStore } from "../state/appStore";

const m2 = (v: number) => v.toFixed(2);

export function RoomBookSection() {
  const project = useStore((s) => s.project);
  const notify = useStore((s) => s.notify);
  const book = useMemo(() => roomBook(project), [project]);
  const sloped = book.rows.some(hasSlope);
  const stem = `${exportProjectName(project) || "projekt"}-raumbuch`;

  const exportPdf = () => {
    runWithAnonymityGate(project, [`${stem}.pdf`], async () => {
      try {
        (await buildAreaReportPdf(buildRoomBookReport(project))).save(`${stem}.pdf`);
      } catch {
        notify(t("roomBook.exportPdf.fail"));
      }
    });
  };

  return (
    <div className="area-section opening-section">
      <div className="balance-head">
        <span className="balance-section-label">{t("roomBook.title")}</span>
        {book.rows.length > 0 && (
          <span className="area-actions">
            <button type="button" className="balance-export" onClick={() => runWithAnonymityGate(project, [`${stem}.csv`], () => downloadCsv(`${stem}.csv`, areaReportToCsv(buildRoomBookReport(project))))}>
              {t("roomBook.exportCsv")}
            </button>
            <button type="button" className="balance-export" onClick={exportPdf}>
              {t("roomBook.exportPdf")}
            </button>
          </span>
        )}
      </div>
      {book.rows.length === 0 ? (
        <div className="balance-empty">{t("roomBook.empty")}</div>
      ) : (
        <div className="area-scroll">
          <CardTable className="opening-table room-book-table">
            <thead>
              <tr>
                <th>{t("openings.col.floor")}</th>
                <th>{t("roomBook.col.number")}</th>
                <th>{t("sheetTable.col.room")}</th>
                <th className="num">{t("sheetTable.col.area")}</th>
                <th>{t("roomBook.col.usage")}</th>
                <th>{t("roomBook.col.floorFinish")}</th>
                <th>{t("roomBook.col.wallFinish")}</th>
                <th>{t("roomBook.col.ceilingFinish")}</th>
                <th className="num">{t("roomBook.col.clearHeight")}</th>
                {sloped && (
                  <>
                    <th className="num">{t("roomBook.col.heightMin")}</th>
                    <th className="num">{t("roomBook.col.heightMean")}</th>
                    <th className="num">{t("roomBook.col.areaUnder1")}</th>
                    <th className="num">{t("roomBook.col.area1To15")}</th>
                  </>
                )}
                <th className="num">{t("roomBook.col.wallArea")}</th>
                <th className="num">{t("roomBook.col.reveals")}</th>
                <th className="num">{t("roomBook.col.skirting")}</th>
              </tr>
            </thead>
            <tbody>
              {book.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.floor}</td>
                  <td>{r.number}</td>
                  <td>{r.name}</td>
                  <td className="num">{m2(r.area)}</td>
                  <td>{usageLabel(r.usage)}</td>
                  <td>{r.floorFinish}</td>
                  <td>{r.wallFinish}</td>
                  <td>{r.ceilingFinish}</td>
                  <td className="num">{m2(r.clearHeight)}</td>
                  {sloped && (
                    <>
                      <td className="num">{m2(r.heightMin)}</td>
                      <td className="num">{m2(r.heightMean)}</td>
                      <td className="num">{m2(r.areaUnder1)}</td>
                      <td className="num">{m2(r.area1To15)}</td>
                    </>
                  )}
                  <td className="num">{m2(r.wallArea)}</td>
                  <td className="num">{m2(r.revealArea)}</td>
                  <td className="num">{m2(r.skirting)}</td>
                </tr>
              ))}
            </tbody>
          </CardTable>
          {book.quantities.length > 0 && (
            <CardTable className="opening-table room-book-table">
              <thead>
                <tr>
                  <th>{t("roomBook.col.surface")}</th>
                  <th>{t("roomBook.col.finish")}</th>
                  <th className="num">{t("roomBook.col.rooms")}</th>
                  <th className="num">{t("sheetTable.col.area")}</th>
                </tr>
              </thead>
              <tbody>
                {book.quantities.map((q) => (
                  <tr key={`${q.surface}:${q.finish}`}>
                    <td>{t(`roomBook.surface.${q.surface}`)}</td>
                    <td>{q.finish}</td>
                    <td className="num">{q.rooms}</td>
                    <td className="num">{m2(q.area)}</td>
                  </tr>
                ))}
              </tbody>
            </CardTable>
          )}
        </div>
      )}
      <ul className="area-notes">
        <li>{t("roomBook.foot")}</li>
      </ul>
    </div>
  );
}
