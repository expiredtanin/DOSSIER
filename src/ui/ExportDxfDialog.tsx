// DXF-Export-Dialog (modal). Fragt „Schraffuren mitexportieren?" ab und weist auf
// die Meter-Einheit hin (DXF ist Modell-Space in echten Metern, 1:1). Muster wie
// ExportPdfDialog: abgedunkeltes Overlay, Klick auf den Hintergrund + Esc schliessen.
//
// Rein gesteuert: hält nur Formular-Zustand und meldet die Entscheidung über
// `onExport` nach oben (App führt den Export aus, da es den Plan erzeugt).
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Dropdown } from "./Dropdown";

/** Entscheidung, die der Dialog beim Bestätigen liefert. */
export interface ExportDxfDecision {
  includeHatches: boolean;
}

export interface ExportDxfDialogProps {
  /** Titel/Geschossname (nur Anzeige im Dialogkopf). */
  planTitle: string;
  onExport: (decision: ExportDxfDecision) => void;
  onClose: () => void;
}

export function ExportDxfDialog({ planTitle, onExport, onClose }: ExportDxfDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [includeHatches, setIncludeHatches] = useState(true);

  const onConfirm = () => onExport({ includeHatches });

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
