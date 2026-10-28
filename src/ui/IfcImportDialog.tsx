// Auswahl beim IFC-Import ([B3]/[B4]): als Kontext-Meshes (Standard, wie bisher) oder als echte
// Bauteile (`io/ifcElements.ts`). Overlay-Muster wie `UnsavedChangesDialog` (kein `window.confirm`).

import { useEffect, useState } from "react";
import { t } from "../i18n";

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
