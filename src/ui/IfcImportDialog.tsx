// Auswahl beim IFC-Import ([B3]/[B4]): als Kontext-Meshes (Standard, wie bisher) oder als echte
// Bauteile (Kern `import_ifc.rs`). Overlay-Muster wie `UnsavedChangesDialog` (kein `window.confirm`).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import type { IfcElementsSummary } from "../io/ifcImport";

export type IfcImportMode = "mesh" | "elements";

export interface IfcImportDialogProps {
  fileName: string;
  onImport: (mode: IfcImportMode) => void;
  onCancel: () => void;
}

export function IfcImportDialog({ fileName, onImport, onCancel }: IfcImportDialogProps) {
  const [mode, setMode] = useState<IfcImportMode>("mesh");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="imp-overlay" onClick={onCancel}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("ifc.importDialog.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("ifc.importDialog.title")}</span>
          <button className="imp-close" onClick={onCancel} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{fileName}</div>
            <label className="imp-radio">
              <input type="radio" name="ifc-mode" checked={mode === "mesh"} onChange={() => setMode("mesh")} />
              <span>{t("ifc.importDialog.asMesh")}</span>
            </label>
            <div className="imp-note">{t("ifc.importDialog.asMeshHint")}</div>
            <label className="imp-radio">
              <input type="radio" name="ifc-mode" checked={mode === "elements"} onChange={() => setMode("elements")} />
              <span>{t("ifc.importDialog.asElements")}</span>
            </label>
            <div className="imp-note">{t("ifc.importDialog.asElementsHint")}</div>
          </section>
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onCancel}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn primary" onClick={() => onImport(mode)}>
            {t("ifc.importDialog.import")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Zeilen „erkannt" des Berichts: Zähler aus der Zusammenfassung des Kerns. */
const RECOGNIZED: ReadonlyArray<[string, (s: IfcElementsSummary) => number]> = [
  ["ifc.importReport.walls", (s) => s.walls],
  ["ifc.importReport.openings", (s) => s.openings],
  ["ifc.importReport.ceilings", (s) => s.ceilings],
  ["ifc.importReport.roofs", (s) => s.roofs ?? 0],
  ["ifc.importReport.stairs", (s) => s.stairs ?? 0],
  ["ifc.importReport.beams", (s) => s.beams ?? 0],
  ["ifc.importReport.columns", (s) => s.columns],
  ["ifc.importReport.rooms", (s) => s.rooms],
  ["ifc.importReport.floors", (s) => s.floors],
  [
    "ifc.importReport.types",
    (s) => s.wallTypes + s.ceilingTypes + (s.roofTypes ?? 0) + (s.doorTypes ?? 0) + (s.windowTypes ?? 0),
  ],
  ["ifc.importReport.meshes", (s) => s.meshes],
];

/** Bericht nach dem Bauteil-Import ([B4]): was erkannt wurde und was mit welchem Grund Mesh blieb. */
export function IfcImportReportDialog({
  fileName,
  summary,
  onClose,
}: {
  fileName: string;
  summary: IfcElementsSummary;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const kept = Object.entries(summary.keptReasons ?? {}).flatMap(([cls, reasons]) =>
    Object.entries(reasons).map(([why, n]) => ({ cls, why, n })),
  );
  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("ifc.importReport.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("ifc.importReport.title")}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">
              {fileName} · {t("ifc.importReport.recognized")}
            </div>
            <table className="imp-table">
              <tbody>
                {RECOGNIZED.map(([key, n]) => (
                  <tr key={key}>
                    <td>{t(key)}</td>
                    <td style={{ textAlign: "right" }}>{n(summary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="imp-section">
            <div className="imp-section-title">{t("ifc.importReport.kept")}</div>
            {kept.length === 0 ? (
              <div className="imp-note">{t("ifc.importReport.keptNone")}</div>
            ) : (
              <table className="imp-table">
                <tbody>
                  {kept.map(({ cls, why, n }) => (
                    <tr key={`${cls}/${why}`}>
                      <td>{cls}</td>
                      <td>{t(`ifc.reason.${why}`)}</td>
                      <td style={{ textAlign: "right" }}>{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
        <footer className="imp-foot">
          <button className="imp-btn primary" onClick={onClose}>
            {t("ifc.importReport.close")}
          </button>
        </footer>
      </div>
    </div>
  );
}
