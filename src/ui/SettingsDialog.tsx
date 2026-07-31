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
import { ColorHexField } from "./ColorHexField";
import { LayoutMenu } from "./LayoutMenu";
import { APP_VERSION } from "./TopBar";
import type { RendererMode } from "./StatusBar";
import type { LayoutState } from "../panels/types";
import type { ThemeMode } from "../theme/themeMode";
import { checkForUpdate, getUpdateSnoozeUntil, setUpdateSnooze } from "../update/checkForUpdate";
import { getRunningVersion } from "../update/version";
import {
  fetchVersionHistory,
  openVersionDownload,
  type VersionEntry,
} from "../update/versionHistory";

/** Pausier-Optionen fuer den stillen Start-Check (s. checkForUpdate.ts). */
const SNOOZE_OPTIONS = [
  { id: "active", ms: null },
  { id: "1day", ms: 24 * 60 * 60 * 1000 },
  { id: "1week", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "1month", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export interface SettingsDialogProps {
  /** Hell/Dunkel — Standard ist Hell (siehe theme/themeMode.ts). */
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  marqueeColor: string;
  onMarqueeColorChange: (hex: string) => void;
  snapColor: string;
  onSnapColorChange: (hex: string) => void;
  /** Referenzhöhe des Erdgeschosses (m ü. M.) — statt des ganzen Projekts nur
   * dieses eine Feld + sein Setter (schmale Grenzfläche, s. `windowed`). */
  referenceElevationMasl: number | undefined;
  onReferenceElevationChange: (n: number | undefined) => void;
  /** Aktuell gewählter Plan-Renderer (aus dem `?engine`-URL-Param abgeleitet). */
  rendererMode: RendererMode;
  /** Ist `navigator.gpu` vorhanden? Steuert, ob „Nordstern" wählbar ist. */
  webGpuAvailable: boolean;
  /**
   * Renderer wechseln (setzt/entfernt den `engine`-URL-Param und lädt neu — kein
   * Live-Remount der Renderer-Hooks).
   */
  onRendererModeChange: (mode: RendererMode) => void;
  /** Arbeitsumgebung (Fenster-/Dock-Layouts) — LayoutMenu wird HIER gerendert
   * (nicht mehr als vorgefertigtes ReactNode hereingereicht: JSX ist über eine
   * Fenstergrenze nicht serialisierbar, s. `windowed`). */
  layout: LayoutState;
  onApplyLayout: (layout: LayoutState) => void;
  onClose: () => void;
  /**
   * Läuft in einem EIGENEN nativen Fenster (siehe native/settingsWindow.ts)
   * statt als abgedunkelter Overlay-Dialog im Hauptfenster: kein Backdrop/
   * Klick-aussen-schliesst (kein „aussen" in einem echten OS-Fenster), füllt
   * die Fensterfläche, Kopfzeile wird zum Ziehbereich statt zum Schliessen-Klick.
   */
  windowed?: boolean;
}

export function SettingsDialog({
  themeMode,
  onThemeModeChange,
  marqueeColor,
  onMarqueeColorChange,
  snapColor,
  onSnapColorChange,
  referenceElevationMasl,
  onReferenceElevationChange,
  rendererMode,
  webGpuAvailable,
  onRendererModeChange,
  layout,
  onApplyLayout,
  onClose,
  windowed = false,
}: SettingsDialogProps) {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [snoozeUntil, setSnoozeUntilState] = useState<number | null>(() => getUpdateSnoozeUntil());
  const [versionHistory, setVersionHistory] = useState<VersionEntry[] | null>(null);
  const [selectedTag, setSelectedTag] = useState<string>("");

  useEffect(() => {
    void getRunningVersion().then(setRunningVersion);
  }, []);
  useEffect(() => {
    void fetchVersionHistory().then((entries) => {
      setVersionHistory(entries);
      if (entries.length > 0) setSelectedTag(entries[0].tag);
    });
  }, []);

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
    referenceElevationMasl != null ? String(referenceElevationMasl) : "",
  );
  useEffect(() => {
    setElevationText(referenceElevationMasl != null ? String(referenceElevationMasl) : "");
  }, [referenceElevationMasl]);

  const commitElevation = (raw: string) => {
    setElevationText(raw);
    const trimmed = raw.trim();
    if (trimmed === "") {
      onReferenceElevationChange(undefined);
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      onReferenceElevationChange(n);
    }
  };

  const dialog = (
      <div
        className={`imp-dialog${windowed ? " imp-dialog-embedded" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={windowed ? undefined : (e) => e.stopPropagation()}
      >
        <header
          className="imp-head"
          {...(windowed ? { "data-tauri-drag-region": true } : {})}
        >
          <span className="imp-head-title">{t("settings.title")}</span>
          {!windowed && (
            <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
              ×
            </button>
          )}
        </header>

        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("settings.section.workspace")}</div>
            <LayoutMenu layout={layout} onApply={onApplyLayout} />
          </section>

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
            <span className="settings-field-label">{t("settings.theme")}</span>
            <span className="sb-renderer-toggle" role="group" aria-label={t("settings.theme")}>
              <button
                type="button"
                className={`sb-renderer-btn${themeMode === "light" ? " active" : ""}`}
                aria-pressed={themeMode === "light"}
                onClick={() => onThemeModeChange("light")}
              >
                {t("settings.theme.light")}
              </button>
              <button
                type="button"
                className={`sb-renderer-btn${themeMode === "dark" ? " active" : ""}`}
                aria-pressed={themeMode === "dark"}
                onClick={() => onThemeModeChange("dark")}
              >
                {t("settings.theme.dark")}
              </button>
            </span>
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

          <section className="imp-section">
            <div className="imp-section-title">{t("settings.section.update")}</div>
            <div className="imp-note">
              {t("about.version")} {runningVersion ?? APP_VERSION}
            </div>
            <button
              type="button"
              className="imp-btn"
              disabled={checkingUpdate}
              onClick={async () => {
                setCheckingUpdate(true);
                try {
                  await checkForUpdate(false);
                } finally {
                  setCheckingUpdate(false);
                }
              }}
            >
              {checkingUpdate ? t("about.checkingUpdate") : t("about.checkUpdate")}
            </button>

            <div className="settings-subsection">
              <label className="settings-field-label" htmlFor="settings-update-snooze">
                {t("settings.update.autoCheck")}
              </label>
              <select
                id="settings-update-snooze"
                className="settings-select"
                value={snoozeUntil == null ? "active" : String(snoozeUntil)}
                onChange={(e) => {
                  const opt = SNOOZE_OPTIONS.find((o) => o.id === e.target.value);
                  const until = opt?.ms == null ? null : Date.now() + opt.ms;
                  setUpdateSnooze(until);
                  setSnoozeUntilState(until);
                }}
              >
                {SNOOZE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {t(`settings.update.snooze.${o.id}` as const)}
                  </option>
                ))}
              </select>
              {snoozeUntil != null && (
                <div className="imp-note">
                  {t("settings.update.snoozedUntil", {
                    date: new Date(snoozeUntil).toLocaleDateString(),
                  })}
                </div>
              )}
            </div>

            <div className="settings-subsection">
              <label className="settings-field-label" htmlFor="settings-update-history">
                {t("settings.update.versionHistory")}
              </label>
              {versionHistory == null ? (
                <div className="imp-note">{t("settings.update.loadingHistory")}</div>
              ) : versionHistory.length === 0 ? (
                <div className="imp-note">{t("settings.update.noHistory")}</div>
              ) : (
                <>
                  <div className="settings-history-row">
                    <select
                      id="settings-update-history"
                      className="settings-select"
                      value={selectedTag}
                      onChange={(e) => setSelectedTag(e.target.value)}
                    >
                      {versionHistory.map((v) => (
                        <option key={v.tag} value={v.tag}>
                          {v.version} — {v.pub_date.slice(0, 10)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="imp-btn"
                      onClick={() => {
                        const entry = versionHistory.find((v) => v.tag === selectedTag);
                        if (entry) void openVersionDownload(entry);
                      }}
                    >
                      {t("settings.update.download")}
                    </button>
                  </div>
                  <div className="imp-note">{t("settings.update.versionHistory.hint")}</div>
                </>
              )}
            </div>
          </section>
        </div>

        {!windowed && (
          <footer className="imp-foot">
            <button className="imp-btn primary" onClick={onClose}>
              {t("export.close")}
            </button>
          </footer>
        )}
      </div>
  );

  if (windowed) return dialog;
  return (
    <div className="imp-overlay" onClick={onClose}>
      {dialog}
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
