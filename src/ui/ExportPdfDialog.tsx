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
import { SCALE_PRESETS, parseScaleInput } from "./TopBar";
import type { Orientation, PaperFormat } from "../export/exportPdf";
import { pageSizeMm } from "../export/exportPdf";

/** Entscheidung, die der Dialog beim Bestätigen liefert. */
export interface ExportPdfDecision {
  scaleDenominator: number;
  paper: PaperFormat;
  orientation: Orientation;
  /** „nur Auswahl" statt des ganzen Plans (nur relevant, wenn `selectionCount > 0`). */
  selectionOnly: boolean;
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
  /**
   * Anzahl aktuell ausgewählter Elemente (über alle Arten) — > 0 blendet den
   * „nur Auswahl exportieren"-Schalter ein (Nutzer-Wunsch: „Export
   * exportiert immer den GANZEN Plan"). 0/fehlend: kein Schalter, Export
   * bleibt wie bisher immer der ganze Plan.
   */
  selectionCount?: number;
  onExport: (decision: ExportPdfDecision) => void;
  /** Zweiter Export-Weg (Nutzer-Wunsch „Kein SVG-Export") — nutzt dieselbe
   *  Massstab/Papier/Ausrichtung-Auswahl wie der PDF-Export, nur als
   *  eigenständiger SVG-Download statt eines gerenderten PDF. */
  onExportSvg?: (decision: ExportPdfDecision) => void;
  onClose: () => void;
}

export function ExportPdfDialog({
  initialScale,
  planTitle,
  contentMeters,
  selectionCount = 0,
  onExport,
  onExportSvg,
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
  const [selectionOnly, setSelectionOnly] = useState(false);
  // Freitext-Massstab (Nutzer-Wunsch: „PDF-Export-Massstab nur 9 feste
  // Presets, kein Freitext für z. B. 1:75") — eigenes Feld statt eines
  // dritten `__custom__`-Dropdown-Eintrags mit Popup-Prompt (wie im
  // TopBar-Vorbild): hier läuft der Dialog bereits selbst als Overlay mit
  // eigenem Escape-Handler, ein verschachtelter zweiter Overlay-Dialog
  // (`PromptDialog`) würde bei Escape BEIDE schliessen (window-weite
  // Listener, keine Bubbling-Trennung). `parseScaleInput` (dieselbe
  // Funktion wie im TopBar) akzeptiert „1:75" ODER „75".
  const [customScaleText, setCustomScaleText] = useState("");
  const applyCustomScale = () => {
    const n = parseScaleInput(customScaleText);
    if (n != null) setScale(n);
  };

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

  const decision = (): ExportPdfDecision => ({
    scaleDenominator: scale,
    paper,
    orientation,
    selectionOnly: selectionCount > 0 && selectionOnly,
  });
  const onConfirm = () => onExport(decision());
  const onConfirmSvg = () => onExportSvg?.(decision());

  const inPresets = SCALE_PRESETS.includes(scale);
  const scaleOptions = [
    ...(inPresets ? [] : [{ value: String(scale), label: `1:${scale}` }]),
    ...SCALE_PRESETS.map((n) => ({ value: String(n), label: `1:${n}` })),
  ];

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
            <div className="imp-scale-custom">
              <input
                className="imp-input"
                type="text"
                placeholder={t("export.scale.customPlaceholder")}
                value={customScaleText}
                onChange={(e) => setCustomScaleText(e.target.value)}
                onBlur={applyCustomScale}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCustomScale();
                }}
              />
            </div>
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

          {!fits && <div className="imp-warn">{t("export.warnFit")}</div>}
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onClose}>
            {t("export.cancel")}
          </button>
          {onExportSvg && (
            <button className="imp-btn" onClick={onConfirmSvg}>
              {t("export.confirmSvg")}
            </button>
          )}
          <button className="imp-btn primary" onClick={onConfirm}>
            {onExportSvg ? t("export.confirmPdf") : t("export.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}
