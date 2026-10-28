// Flächentabelle (Flächenarten je Geschoss) und IVHB-Kennziffern im Flächenbilanz-Panel ([70]).
//
//  • Die Tabellen stammen aus demselben Berichtsmodell wie CSV und PDF (`buildAreaReport`):
//    was hier steht, steht auch im Export.
//  • Eingaben, die das Modell nicht hergibt (anrechenbare Grundstücksfläche, Grünfläche, Basis der
//    aGF, Untergeschosse), liegen nur in der Ansicht (nicht im Projekt).
// Herleitung der Zahlen: `src-tauri/core/src/flaechen.rs`.

import { useMemo, useState } from "react";
import { t } from "../i18n";
import { usePanelHost } from "./host";
import { areaReportToCsv, buildAreaReport, buildAreaReportPdf } from "../core";
import type { AgfBasis } from "../core";
import { DEFAULT_AREA_INPUTS, ivhbOptionsOf, type AreaInputs } from "./areaInputs";
import { downloadCsv } from "./downloadFile";
import { useStore } from "../state/appStore";

const BASES: AgfBasis[] = ["ngf", "gf", "nf"];

export function AreaTableSection() {
  const host = usePanelHost();
  const project = host.project;
  const [inputs, setInputs] = useState<AreaInputs>(DEFAULT_AREA_INPUTS);
  const notify = useStore((s) => s.notify);
  const report = useMemo(
    () => buildAreaReport(project, { areas: true, ivhb: true, ivhbOptions: ivhbOptionsOf(inputs) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, inputs],
  );
  const set = (patch: Partial<AreaInputs>) => setInputs((i) => ({ ...i, ...patch }));
  const stem = `${project.name || "projekt"}-flaechen`;

  const exportPdf = () => {
    try {
      buildAreaReportPdf(report).save(`${stem}.pdf`);
    } catch {
      notify(t("areas.exportPdf.fail"));
    }
  };

  return (
    <div className="area-section">
      <div className="balance-head">
        <span className="balance-section-label">{t("areas.title")}</span>
        <span className="area-actions">
          <button type="button" className="balance-export" onClick={() => downloadCsv(`${stem}.csv`, areaReportToCsv(report))}>
            {t("areas.exportCsv")}
          </button>
          <button type="button" className="balance-export" onClick={exportPdf}>
            {t("areas.exportPdf")}
          </button>
        </span>
      </div>

      {report.sections.map((s, si) => (
        <div key={si} className="area-block">
          <div className="area-heading">{s.heading}</div>
          <div className="area-scroll">
            <table className="area-table">
              <thead>
                <tr>
                  {s.columns.map((c, i) => (
                    <th key={i} className={i === 0 ? "" : "num"}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r, ri) => (
                  <tr key={ri} className={r.total ? "total" : ""}>
                    {r.cells.map((c, ci) =>
                      typeof c === "string" ? (
                        <td key={ci}>{c}</td>
                      ) : (
                        <td key={ci} className="num">
                          {c.n === null ? "–" : c.n.toFixed(c.d)}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
