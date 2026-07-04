// Einstellungs-Fenster (modal). HANDOVER-Backlog Punkt 4: Default-Farbe des
// Auswahlrahmens (Marquee) + der Snap-/Endpunkt-Hervorhebung im Grundriss,
// beide mit freiem Farbpicker + Akzent-Schnellauswahl; dazu ein Projekt-Feld
// für die Referenzhöhe des Erdgeschosses (m ü. M.).
//
// Rein gesteuert: Marquee-/Snap-Farbe kommen aus der ViewSlice (App reicht
// Wert + Setter durch), das MüM-Feld schreibt direkt ins Projekt über die
// bestehende `setProject`-Aktion. Muster wie ExportDxfDialog (abgedunkeltes
// Overlay, Klick auf Hintergrund + Esc schliessen).
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import { ACCENT_SWATCHES } from "../theme/accents";
import type { Project } from "../model/types";
import { ColorHexField } from "./ColorHexField";
import type { RendererMode } from "./StatusBar";

export interface SettingsDialogProps {
  marqueeColor: string;
  onMarqueeColorChange: (hex: string) => void;
  snapColor: string;
  onSnapColorChange: (hex: string) => void;
  project: Project;
  setProject: (next: Project | ((p: Project) => Project)) => void;
  /** Aktuell gewählter Plan-Renderer (aus dem `?engine`-URL-Param abgeleitet). */
  rendererMode: RendererMode;
  /** Ist `navigator.gpu` vorhanden? Steuert, ob „Nordstern" wählbar ist. */
  webGpuAvailable: boolean;
  /**
   * Renderer wechseln (setzt/entfernt den `engine`-URL-Param und lädt neu — kein
   * Live-Remount der Renderer-Hooks).
   */
  onRendererModeChange: (mode: RendererMode) => void;
  onClose: () => void;
}

export function SettingsDialog({
  marqueeColor,
  onMarqueeColorChange,
  snapColor,
  onSnapColorChange,
  project,
  setProject,
  rendererMode,
  webGpuAvailable,
  onRendererModeChange,
  onClose,
}: SettingsDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lokaler Textzustand fürs MüM-Feld: erlaubt Zwischenzustände beim Tippen
  // (leer, "412." etc.), ohne bei jedem Tastendruck einen ungültigen/
  // gerundeten Projektwert zu schreiben. Synchronisiert sich, wenn sich das
  // Projekt von aussen ändert (z. B. Undo/Import).
  const [elevationText, setElevationText] = useState(
    project.referenceElevationMasl != null ? String(project.referenceElevationMasl) : "",
  );
  useEffect(() => {
    setElevationText(
      project.referenceElevationMasl != null ? String(project.referenceElevationMasl) : "",
    );
  }, [project.referenceElevationMasl]);

  const commitElevation = (raw: string) => {
    setElevationText(raw);
    const trimmed = raw.trim();
    if (trimmed === "") {
      setProject((p) => ({ ...p, referenceElevationMasl: undefined }));
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      setProject((p) => ({ ...p, referenceElevationMasl: n }));
    }
  };

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("settings.title")}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("status.renderer")}</div>
            <span className="sb-renderer-toggle" role="group" aria-label={t("status.renderer")}>
              <button
                type="button"
                className={`sb-renderer-btn${rendererMode === "webgl2" ? " active" : ""}`}
                aria-pressed={rendererMode === "webgl2"}
                onClick={() => onRendererModeChange("webgl2")}
              >
                {t("status.rendererWebgl")}
              </button>
              <button
                type="button"
                className={`sb-renderer-btn${rendererMode === "wasm" ? " active" : ""}`}
                aria-pressed={rendererMode === "wasm"}
                disabled={!webGpuAvailable}
                title={webGpuAvailable ? undefined : t("status.rendererWasmUnavailable")}
                onClick={() => onRendererModeChange("wasm")}
              >
                {t("status.rendererWasm")}
              </button>
            </span>
            {!webGpuAvailable && (
              <div className="imp-note">{t("status.rendererWasmUnavailable")}</div>
            )}
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("settings.section.display")}</div>
            <AccentColorField
              label={t("settings.marqueeColor")}
              hint={t("settings.marqueeColor.hint")}
              value={marqueeColor}
              onChange={onMarqueeColorChange}
            />
            <AccentColorField
              label={t("settings.snapColor")}
              hint={t("settings.snapColor.hint")}
              value={snapColor}
              onChange={onSnapColorChange}
            />
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("settings.section.project")}</div>
            <label className="settings-field-label" htmlFor="settings-reference-elevation">
              {t("settings.referenceElevation")}
            </label>
            <input
              id="settings-reference-elevation"
              className="settings-num-input"
              type="number"
              step="0.1"
              inputMode="decimal"
              value={elevationText}
              onChange={(e) => commitElevation(e.target.value)}
              placeholder="0.0"
            />
            <div className="imp-note">{t("settings.referenceElevation.hint")}</div>
          </section>
        </div>

        <footer className="imp-foot">
          <button className="imp-btn primary" onClick={onClose}>
            {t("export.close")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Farbfeld: freier Picker (Swatch + Hex) + Akzent-Presets als Schnellauswahl. */
function AccentColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="settings-color-field">
      <div className="settings-color-head">
        <span className="settings-field-label">{label}</span>
        <ColorHexField value={value} onChange={onChange} />
      </div>
      <div className="settings-accent-presets" role="group" aria-label={label}>
        {ACCENT_SWATCHES.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`settings-accent-btn${
              value.toLowerCase() === a.hex.toLowerCase() ? " active" : ""
            }`}
            style={{ background: a.hex }}
            title={a.name}
            aria-label={a.name}
            aria-pressed={value.toLowerCase() === a.hex.toLowerCase()}
            onClick={() => onChange(a.hex)}
          />
        ))}
      </div>
      <div className="imp-note">{hint}</div>
    </div>
  );
}
