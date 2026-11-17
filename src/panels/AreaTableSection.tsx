// Flächentabelle (Flächenarten je Geschoss) und IVHB-Kennziffern im Flächenbilanz-Panel ([70]).
//
//  • Die Tabellen stammen aus demselben Berichtsmodell wie CSV und PDF (`buildAreaReport`):
//    was hier steht, steht auch im Export.
//  • Eingaben, die das Modell nicht hergibt (anrechenbare Grundstücksfläche, Grünfläche, Basis der
//    aGF, Untergeschosse), liegen nur in der Ansicht (nicht im Projekt).
// Herleitung der Zahlen: `src-tauri/core/src/flaechen.rs`.

import { useMemo, useState } from "react";
import { t } from "../i18n";
import { exportProjectName, areaReportToCsv, buildAreaReport, buildAreaReportPdf, isAreaReportEmpty } from "../core";
import type { AgfBasis } from "../core";
import { DEFAULT_AREA_INPUTS, ivhbOptionsOf, type AreaInputs } from "./areaInputs";
import { downloadCsv } from "./downloadFile";
import { ReportTable } from "./ReportTable";
import { runWithAnonymityGate } from "../state/anonymityGate";
import { useStore } from "../state/appStore";

const BASES: AgfBasis[] = ["ngf", "gf", "nf"];

export function AreaTableSection() {
  const project = useStore((s) => s.project);
  const [inputs, setInputs] = useState<AreaInputs>(DEFAULT_AREA_INPUTS);
  const notify = useStore((s) => s.notify);
  const report = useMemo(
    () => buildAreaReport(project, { areas: true, ivhb: true, siteProof: true, ivhbOptions: ivhbOptionsOf(inputs) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, inputs],
  );
  // [278] CSV/PDF enthalten zusätzlich den Wohnungsspiegel (die Anzeige hat ihn im Abschnitt „Nutzungseinheiten“).
  const buildExport = () => buildAreaReport(project, { areas: true, ivhb: true, siteProof: true, units: true, ivhbOptions: ivhbOptionsOf(inputs) });
  const set = (patch: Partial<AreaInputs>) => setInputs((i) => ({ ...i, ...patch }));
  const stem = `${exportProjectName(project) || "projekt"}-flaechen`;

  // [263] Leeres Projekt: kein Export von Nullen, sondern ein Hinweis (sonst sähe die Datei wie ein Ergebnis aus).
  const emptyHint = () => {
    if (!isAreaReportEmpty(project)) return false;
    notify(t("areas.export.empty"));
    return true;
  };
  const exportCsv = () => {
    if (emptyHint()) return;
    runWithAnonymityGate(project, [`${stem}.csv`], () => downloadCsv(`${stem}.csv`, areaReportToCsv(buildExport())));
  };
  const exportPdf = () => {
    if (emptyHint()) return;
    runWithAnonymityGate(project, [`${stem}.pdf`], async () => {
      try {
        (await buildAreaReportPdf(buildExport())).save(`${stem}.pdf`);
      } catch {
        notify(t("areas.exportPdf.fail"));
      }
    });
  };

  return (
    <div className="area-section">
      <div className="balance-head">
        <span className="balance-section-label">{t("areas.title")}</span>
        <span className="area-actions">
          <button type="button" className="balance-export" onClick={exportCsv}>
            {t("areas.exportCsv")}
          </button>
          <button type="button" className="balance-export" onClick={exportPdf}>
            {t("areas.exportPdf")}
          </button>
        </span>
      </div>

      {report.sections.map((s, si) => (
        <ReportTable key={si} section={s} />
      ))}

      <div className="area-inputs">
        <label className="kz-parcel">
          <span>{t("areas.agsfInput")}</span>
          <input type="text" inputMode="decimal" className="kz-input kz-num" value={inputs.agsf} title={t("areas.agsfInput.hint")} onChange={(e) => set({ agsf: e.target.value })} />
          <span>m²</span>
        </label>
        <label className="kz-parcel">
          <span>{t("areas.greenInput")}</span>
          <input type="text" inputMode="decimal" className="kz-input kz-num" value={inputs.greenArea} title={t("areas.greenInput.hint")} onChange={(e) => set({ greenArea: e.target.value })} />
          <span>m²</span>
        </label>
        <label className="kz-parcel">
          <span>{t("areas.basisInput")}</span>
          <select className="kz-input" value={inputs.agfBasis} onChange={(e) => set({ agfBasis: e.target.value as AgfBasis })}>
            {BASES.map((b) => (
              <option key={b} value={b}>
                {t(`areas.basis.${b}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="kz-parcel">
          <span>{t("areas.includeUnderground")}</span>
          <input type="checkbox" checked={inputs.includeUnderground} onChange={(e) => set({ includeUnderground: e.target.checked })} />
        </label>
      </div>

      <ul className="area-notes">
        {report.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
