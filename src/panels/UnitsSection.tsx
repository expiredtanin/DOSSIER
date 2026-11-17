// Nutzungseinheiten und Wohnungsspiegel im Flächenbilanz-Panel ([278]).
//
//  • Liste der Einheiten (Nummer, Typ, Nutzung, Farbe) bearbeiten, neue Einheit anlegen (leer oder aus der Raum-Auswahl),
//    Auswahl einer Einheit zuordnen, Einheit löschen (die Räume bleiben, ohne Einheit).
//  • Wohnungsspiegel (Einheiten mit Zimmerzahl und Flächen, Summe je Typ und je Geschoss) aus demselben Berichtsmodell wie
//    CSV/PDF (`buildAreaReport` mit `units`); gerechnet im Kern (`unit_schedule.rs`).
// Alle Änderungen laufen über `applyChange` (Ops), eine Aktion = ein Undo-Schritt; Tippen verschmilzt über den coalesceKey.

import { useMemo } from "react";
import { t } from "../i18n";
import { useStore } from "../state/appStore";
import { UNIT_USAGES, buildAreaReport, computeUnitSchedule, exportProjectName, areaReportToCsv, buildAreaReportPdf } from "../core";
import type { Project, UnitUsage } from "../model/types";
import { ReportTable } from "./ReportTable";
import { downloadCsv } from "./downloadFile";
import { runWithAnonymityGate } from "../state/anonymityGate";
import { addUnitOps, assignRoomsOps, deleteUnitOps, draftUnit, patchUnitOps } from "./unitOps";

/** Auswahlwert „keine Einheit“ (leer ist der Platzhalter). */
const NONE = "-";

export function UnitsSection() {
  const project = useStore((s) => s.project);
  const applyChange = useStore((s) => s.applyChange);
  const notify = useStore((s) => s.notify);
  const selectedRooms = useStore((s) => s.selection.rooms);
  const units = project.units ?? [];
  const sched = useMemo(() => computeUnitSchedule(project), [project]);
  const rowOf = new Map(sched.units.map((r) => [r.id, r]));
  // Reihenfolge der Liste wie im Spiegel (nach Nummer natürlich sortiert).
  const ordered = sched.units.map((r) => units.find((u) => u.id === r.id)).filter((u): u is NonNullable<typeof u> => !!u);
  const report = useMemo(() => buildAreaReport(project, { areas: false, units: true }), [project]);
  const stem = `${exportProjectName(project) || "projekt"}-wohnungsspiegel`;

  const add = (fromSelection: boolean) =>
    applyChange((p: Project) => addUnitOps(p, draftUnit(p, t("units.nameDefault")), fromSelection ? selectedRooms : []));
  const patch = (id: string, field: string, v: Parameters<typeof patchUnitOps>[2]) => applyChange((p: Project) => patchUnitOps(p, id, v), `unit:${id}:${field}`);
  const assign = (unitId: string) => {
    if (selectedRooms.length === 0 || unitId === "") return;
    applyChange((p: Project) => assignRoomsOps(p, selectedRooms, unitId === NONE ? undefined : unitId));
  };

  const exportCsv = () => {
    if (!units.length) return notify(t("units.export.empty"));
    runWithAnonymityGate(project, [`${stem}.csv`], () => downloadCsv(`${stem}.csv`, areaReportToCsv(report)));
  };
  const exportPdf = () => {
    if (!units.length) return notify(t("units.export.empty"));
    runWithAnonymityGate(project, [`${stem}.pdf`], async () => {
      try {
        (await buildAreaReportPdf(report)).save(`${stem}.pdf`);
      } catch {
        notify(t("units.exportPdf.fail"));
      }
    });
  };

  return (
    <div className="area-section units-section" data-testid="units-section">
      <div className="balance-head">
        <span className="balance-section-label">{t("units.title")}</span>
        <span className="area-actions">
          <button type="button" className="balance-export" onClick={exportCsv}>
            {t("units.exportCsv")}
          </button>
          <button type="button" className="balance-export" onClick={exportPdf}>
            {t("units.exportPdf")}
          </button>
        </span>
      </div>

      {units.length === 0 && <div className="balance-empty">{t("units.empty")}</div>}

      {ordered.length > 0 && (
        <div className="units-list">
          {ordered.map((u) => {
            const r = rowOf.get(u.id);
            return (
              <div key={u.id} className="units-row" data-testid="unit-row">
                <input
                  type="text"
                  className="kz-input units-name"
                  value={u.name}
                  title={t("units.nameHint")}
                  placeholder={t("units.nameHint")}
                  onChange={(e) => patch(u.id, "name", { name: e.target.value })}
                />
                <input
                  type="text"
                  className="kz-input units-type"
                  value={u.unitType ?? ""}
                  title={t("units.typeHint")}
                  placeholder={r?.typeLabel || t("units.autoType")}
                  onChange={(e) => patch(u.id, "type", { unitType: e.target.value === "" ? undefined : e.target.value })}
                />
                <button type="button" className="site-remove" title={t("units.delete")} aria-label={t("units.delete")} onClick={() => applyChange((p: Project) => deleteUnitOps(p, u.id))}>
                  ×
                </button>
                <select
                  className="kz-input units-usage"
                  value={u.usage ?? "living"}
                  aria-label={t("units.col.usage")}
                  title={t("units.col.usage")}
                  onChange={(e) => patch(u.id, "usage", { usage: e.target.value as UnitUsage })}
                >
                  {UNIT_USAGES.map((x) => (
                    <option key={x} value={x}>
                      {t(`units.usage.${x}`)}
                    </option>
                  ))}
                </select>
                <input
                  type="color"
                  className="units-color"
                  value={u.color ?? "#9aa4b2"}
                  title={t("units.color")}
                  aria-label={t("units.color")}
                  onChange={(e) => patch(u.id, "color", { color: e.target.value })}
                />
                <span className="units-facts" title={r ? t("units.rooms", { n: r.rooms }) : undefined}>
                  {r ? `${r.usage === "living" ? t("units.zi", { n: r.roomCount }) + " · " : ""}${r.hnf.toFixed(1)} m²` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="kz-program-actions">
        <button type="button" className="kz-add" onClick={() => add(false)}>
          {t("units.add")}
        </button>
        <button type="button" className="kz-add" disabled={selectedRooms.length === 0} onClick={() => add(true)}>
          {t("units.addFromSelection")}
        </button>
        {units.length > 0 && (
          <select className="kz-input" value="" disabled={selectedRooms.length === 0} aria-label={t("units.assignTo")} title={t("units.assignTo")} onChange={(e) => assign(e.target.value)}>
            <option value="">{t("units.assign")}</option>
            <option value={NONE}>{t("units.field.none")}</option>
            {ordered.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {report.sections.map((s, si) => (
        <ReportTable key={si} section={s} />
      ))}
      {report.sections.length > 0 && (
        <ul className="area-notes">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
