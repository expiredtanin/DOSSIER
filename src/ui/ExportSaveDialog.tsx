// Schnellexport-Dialog (modal) für die Direkt-Formate CSV/IFC/OBJ/STL aus dem
// Topbar-Export-Menü: Format wählen + Dateiname festlegen, dann speichern.
// (PDF/DXF haben eigene Options-Dialoge.) Später bekommen „Ausschnitte" einen
// vordefinierten Namen + Speicherort; dies ist der interaktive Schnellweg.
//
// Muster wie ExportDxfDialog: abgedunkeltes Overlay, Klick auf Hintergrund + Esc
// schliessen. Rein gesteuert — meldet Format + Dateiname über `onSave` nach oben
// (App führt Erzeugung + Download aus). Bezeichner englisch, UI deutsch (t()).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Dropdown } from "./Dropdown";
import type { IfcExportOptions } from "../export/ifcClassification";

/** Direkt-herunterladbare Exportformate (mit Datei-Endung). */
export type ExportSaveFormat = "csv" | "ifc" | "obj" | "stl" | "glb" | "step";

/** Datei-Endung je Format. */
export const EXPORT_FORMAT_EXT: Record<ExportSaveFormat, string> = {
  csv: "csv",
  ifc: "ifc",
  obj: "obj",
  stl: "stl",
  glb: "glb",
  step: "stp",
};

export interface ExportSaveDialogProps {
  /** Vorausgewähltes Format (aus dem angeklickten Menüeintrag). */
  initialFormat: ExportSaveFormat;
  /** Basis-Dateiname OHNE Endung (i. d. R. Projektname). */
  baseName: string;
  /** `ifc`: Klassifikations-Optionen (nur bei Format IFC gesetzt). */
  onSave: (format: ExportSaveFormat, filename: string, ifc?: IfcExportOptions) => void;
  onClose: () => void;
}

/** Endung sicher an den Basisnamen hängen (doppelte Endung vermeiden). */
function withExt(base: string, ext: string): string {
  const trimmed = base.trim() || "modell";
  const lower = trimmed.toLowerCase();
  return lower.endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`;
}

export function ExportSaveDialog({
  initialFormat,
  baseName,
  onSave,
  onClose,
}: ExportSaveDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [format, setFormat] = useState<ExportSaveFormat>(initialFormat);
  // Der Dateiname wird OHNE Endung editiert; die Endung folgt aus dem Format.
  const [name, setName] = useState(baseName);

  const filename = withExt(name, EXPORT_FORMAT_EXT[format]);
  // IFC-Klassifikation (Schweizer Praxis): beides aus, bis die Nutzerin es wählt.
  const [ebkph, setEbkph] = useState(false);
  const [layerCodes, setLayerCodes] = useState(false);
  const onConfirm = () => onSave(format, filename, format === "ifc" ? { ebkph, layerCodes } : undefined);

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("exportSave.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("exportSave.title")}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("exportSave.format")}</div>
            <Dropdown
              value={format}
              onChange={(v) => setFormat(v as ExportSaveFormat)}
              title={t("exportSave.format")}
              options={[
                { value: "csv", label: t("exportSave.fmt.csv") },
                { value: "ifc", label: t("exportSave.fmt.ifc") },
                { value: "obj", label: t("exportSave.fmt.obj") },
                { value: "stl", label: t("exportSave.fmt.stl") },
                { value: "glb", label: t("exportSave.fmt.glb") },
                { value: "step", label: t("exportSave.fmt.step") },
              ]}
            />
          </section>

          {format === "ifc" && (
            <section className="imp-section">
              <label className="imp-check">
                <input type="checkbox" checked={ebkph} onChange={(e) => setEbkph(e.target.checked)} />
                <span>{t("exportSave.ifc.ebkph")}</span>
              </label>
              <div className="imp-note">{t("exportSave.ifc.ebkphHint")}</div>
              <label className="imp-check">
                <input type="checkbox" checked={layerCodes} onChange={(e) => setLayerCodes(e.target.checked)} />
                <span>{t("exportSave.ifc.layers")}</span>
              </label>
              <div className="imp-note">{t("exportSave.ifc.layersHint")}</div>
              <div className="imp-note">{t("exportSave.ifc.zonesNote")}</div>
            </section>
          )}

          <section className="imp-section">
            <div className="imp-section-title">{t("exportSave.filename")}</div>
            <input
              className="settings-num-input"
              type="text"
              value={name}
              autoFocus
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onConfirm();
              }}
              placeholder="modell"
            />
            <div className="imp-note">
              {filename} · {t("exportSave.locationNote")}
            </div>
          </section>
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
