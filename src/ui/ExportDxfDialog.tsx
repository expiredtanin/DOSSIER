// DXF-/DWG-Export-Dialog (modal). Fragt Format (DXF/DWG) und „Schraffuren mitexportieren?" ab und weist auf
// die Meter-Einheit hin (DXF ist Modell-Space in echten Metern, 1:1). Muster wie
// ExportPdfDialog: abgedunkeltes Overlay, Klick auf den Hintergrund + Esc schliessen.
//
// Rein gesteuert: hält nur Formular-Zustand und meldet die Entscheidung über
// `onExport` nach oben (App führt den Export aus, da es den Plan erzeugt).
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Dropdown } from "./Dropdown";
import type { CadExportFormat } from "../export/exportDxf";

/** Entscheidung, die der Dialog beim Bestätigen liefert. */
export interface ExportDxfDecision {
  /** Dateiformat: DXF (R2018 ASCII) oder DWG (R2018). */
  format: CadExportFormat;
  includeHatches: boolean;
  /** „nur Auswahl" statt des ganzen Plans (nur relevant, wenn `selectionCount > 0`). */
  selectionOnly: boolean;
}

export interface ExportDxfDialogProps {
  /** Titel/Geschossname (nur Anzeige im Dialogkopf). */
  planTitle: string;
  /** s. `ExportPdfDialogProps.selectionCount`. */
  selectionCount?: number;
  onExport: (decision: ExportDxfDecision) => void;
  onClose: () => void;
}

export function ExportDxfDialog({
  planTitle,
  selectionCount = 0,
  onExport,
  onClose,
}: ExportDxfDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [format, setFormat] = useState<CadExportFormat>("dxf");
  const [includeHatches, setIncludeHatches] = useState(true);
  const [selectionOnly, setSelectionOnly] = useState(false);

  const onConfirm = () =>
    onExport({ format, includeHatches, selectionOnly: selectionCount > 0 && selectionOnly });

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("exportDxf.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("exportDxf.title")}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <div className="imp-file">
            <span className="imp-file-label">{t("export.plan")}</span>
            <span className="imp-file-name" title={planTitle}>
              {planTitle}
            </span>
          </div>

          <section className="imp-section">
            <div className="imp-section-title">{t("exportDxf.format")}</div>
            <Dropdown
              value={format}
              onChange={(v) => setFormat(v === "dwg" ? "dwg" : "dxf")}
              title={t("exportDxf.format")}
              options={[
                { value: "dxf", label: t("exportDxf.format.dxf") },
                { value: "dwg", label: t("exportDxf.format.dwg") },
              ]}
            />
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("exportDxf.hatches")}</div>
            <Dropdown
              value={includeHatches ? "yes" : "no"}
              onChange={(v) => setIncludeHatches(v === "yes")}
              title={t("exportDxf.hatches")}
              options={[
                { value: "yes", label: t("exportDxf.hatches.yes") },
                { value: "no", label: t("exportDxf.hatches.no") },
              ]}
            />
          </section>

          <div className="imp-note">{t("exportDxf.unitsNote")}</div>

          {selectionCount > 0 && (
            <section className="imp-section">
              <label className="imp-check">
                <input
                  type="checkbox"
                  checked={selectionOnly}
                  onChange={(e) => setSelectionOnly(e.target.checked)}
                />
                <span>{t("export.selectionOnly", { count: String(selectionCount) })}</span>
              </label>
            </section>
          )}
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onClose}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn primary" onClick={onConfirm}>
            {t("export.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}
