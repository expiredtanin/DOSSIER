// PDF-Export-Dialog (modal). Fragt Massstab (1:N), Papierformat (A4/A3) und
// Ausrichtung (Hoch/Quer) ab und löst den Vektor-PDF-Export aus. Muster wie
// ImportDialog: abgedunkeltes Overlay, Klick auf den Hintergrund + Esc schließen.
// Themedes Dropdown für die Auswahlfelder.
//
// Rein gesteuert: hält nur Formular-Zustand und meldet die Entscheidung über
// `onExport` nach oben (App führt den eigentlichen Export aus, da es den Plan
// erzeugt). Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Dropdown } from "./Dropdown";
import { SCALE_PRESETS } from "./TopBar";
import type { Orientation, PaperFormat } from "../export/exportPdf";
import { pageSizeMm } from "../export/exportPdf";

/** Entscheidung, die der Dialog beim Bestätigen liefert. */
export interface ExportPdfDecision {
  scaleDenominator: number;
  paper: PaperFormat;
  orientation: Orientation;
}

export interface ExportPdfDialogProps {
  /** Vorbelegung des Massstabs (aktueller Plan-Massstab). */
  initialScale: number;
  /** Titel/Geschossname (nur Anzeige im Dialogkopf). */
  planTitle: string;
  /**
   * Massstäbliche Inhalts-Maße des Plans in Metern (Breite/Höhe), für die
   * „passt aufs Blatt?"-Warnung. Optional.
   */
  contentMeters?: { w: number; h: number };
  onExport: (decision: ExportPdfDecision) => void;
  onClose: () => void;
}

export function ExportPdfDialog({
  initialScale,
  planTitle,
  contentMeters,
  onExport,
  onClose,
}: ExportPdfDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [scale, setScale] = useState<number>(initialScale);
  const [paper, setPaper] = useState<PaperFormat>("a4");
  const [orientation, setOrientation] = useState<Orientation>("landscape");

  // Passt der Plan im gewählten Massstab aufs Blatt (abzüglich Rand)? Best-effort-
  // Hinweis; der Export läuft trotzdem (Plan ragt dann über den Blattrand).
  const fits = (() => {
    if (!contentMeters) return true;
    const { w: pageW, h: pageH } = pageSizeMm(paper, orientation);
    const margin = 12; // Rand + etwas Luft fürs Schriftfeld
    const k = 1000 / scale; // mm je Meter
    return (
      contentMeters.w * k <= pageW - margin * 2 &&
      contentMeters.h * k <= pageH - margin * 2
    );
  })();

  const onConfirm = () => onExport({ scaleDenominator: scale, paper, orientation });

  const scaleOptions = SCALE_PRESETS.map((n) => ({
    value: String(n),
    label: `1:${n}`,
  }));

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("export.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("export.title")}</span>
          <button
            className="imp-close"
            onClick={onClose}
            aria-label={t("export.close")}
          >
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
            <div className="imp-section-title">{t("export.scale")}</div>
            <Dropdown
              value={String(scale)}
              onChange={(v) => setScale(Number(v))}
              title={t("export.scale")}
              triggerClassName="tb-dd-mono"
              options={scaleOptions}
            />
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("export.paper")}</div>
            <Dropdown
              value={paper}
              onChange={(v) => setPaper(v as PaperFormat)}
              title={t("export.paper")}
              options={[
                { value: "a4", label: "A4" },
                { value: "a3", label: "A3" },
              ]}
            />
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("export.orientation")}</div>
            <Dropdown
              value={orientation}
              onChange={(v) => setOrientation(v as Orientation)}
              title={t("export.orientation")}
              options={[
                { value: "portrait", label: t("export.orientation.portrait") },
                { value: "landscape", label: t("export.orientation.landscape") },
              ]}
            />
          </section>

          {!fits && <div className="imp-warn">{t("export.warnFit")}</div>}
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
