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
import { t, type TranslationKey } from "../i18n";
import { ACCENT_SWATCHES } from "../theme/accents";
import { ColorHexField } from "./ColorHexField";
import { LayoutMenu } from "./LayoutMenu";
import { APP_VERSION } from "./TopBar";
import type { LayoutState } from "../panels/types";
import type { ThemeMode } from "../theme/themeMode";
import { checkForUpdate, getUpdateSnoozeUntil, setUpdateSnooze } from "../update/checkForUpdate";
import { getRunningVersion } from "../update/version";
import {
  fetchVersionHistory,
  openVersionDownload,
  type VersionEntry,
} from "../update/versionHistory";
import { allCommandNames } from "../commands/registry";
import {
  isValidAliasKey,
  loadAliasOverrides,
  saveAliasOverrides,
} from "../state/commandAliasOverrides";
import {
  comboFromEvent,
  findConflict,
  formatCombo,
  isReservedCombo,
  loadShortcutOverrides,
  resolveCombo,
  saveShortcutOverrides,
  SHORTCUT_DEFS,
  shortcutDef,
  type ShortcutCategory,
  type ShortcutId,
  type ShortcutOverrides,
} from "../state/keyboardShortcuts";

type SettingsTabId = "general" | "shortcuts" | "update";

const SETTINGS_TABS: { id: SettingsTabId; labelKey: TranslationKey }[] = [
  { id: "general", labelKey: "settings.tab.general" },
  { id: "shortcuts", labelKey: "settings.tab.shortcuts" },
  { id: "update", labelKey: "settings.tab.update" },
];

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
  /** Offline-Modus: sperrt alle entfernten Abrufe (Materialbibliothek, swisstopo, OSM). */
  offline: boolean;
  onOfflineChange: (offline: boolean) => void;
  /** Arbeitsumgebung (Fenster-/Dock-Layouts) — LayoutMenu wird HIER gerendert
   * (nicht mehr als vorgefertigtes ReactNode hereingereicht: JSX ist über eine
   * Fenstergrenze nicht serialisierbar, s. `windowed`). */
  layout: LayoutState;
  onApplyLayout: (layout: LayoutState) => void;
  /**
   * Optionaler Live-Hook für die Kürzel-Remap-Sektion — nur im INLINE-Dialog
   * (Nicht-Tauri) relevant: die Sektion persistiert ihre Änderungen IMMER
   * selbst in localStorage (`state/commandAliasOverrides.ts`), aber das
   * `storage`-Event feuert NIE im selben Fenster, das den Wert geschrieben
   * hat (Web-Storage-API-Standardverhalten) — dieser Callback schliesst
   * genau diese Lücke, damit die LAUFENDE Command-Engine im selben Fenster
   * sofort die neuen Kürzel kennt. Im nativen Einstellungs-Fenster
   * (`windowed`) braucht es das nicht (dort läuft keine Engine) — das
   * Hauptfenster empfängt die Änderung dort stattdessen über das
   * `storage`-Event (s. App.tsx).
   */
  onAliasOverridesChange?: (overrides: Record<string, string>) => void;
  /** Gleicher Live-Hook wie `onAliasOverridesChange`, nur für die echten
   * Tastenkombinationen (`state/keyboardShortcuts.ts`) statt der Befehlszeilen-
   * Kürzel — schliesst dieselbe Cross-Fenster-`storage`-Lücke. */
  onShortcutOverridesChange?: (overrides: ShortcutOverrides) => void;
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
  offline,
  onOfflineChange,
  layout,
  onApplyLayout,
  onAliasOverridesChange,
  onShortcutOverridesChange,
  onClose,
  windowed = false,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTabId>("general");
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

        <nav className="settings-tabs" role="tablist">
          {SETTINGS_TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              type="button"
              role="tab"
              aria-selected={tab === tabDef.id}
              className={`settings-tab-btn${tab === tabDef.id ? " active" : ""}`}
              onClick={() => setTab(tabDef.id)}
            >
              {t(tabDef.labelKey)}
            </button>
          ))}
        </nav>

        <div className="imp-body">
        {tab === "general" && (
        <>
          <section className="imp-section">
            <div className="imp-section-title">{t("settings.section.workspace")}</div>
            <LayoutMenu layout={layout} onApply={onApplyLayout} />
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("settings.section.network")}</div>
            <label className="settings-check">
              <input type="checkbox" checked={offline} onChange={(e) => onOfflineChange(e.target.checked)} />
              {t("settings.offline")}
            </label>
            <div className="imp-note">{t("settings.offline.hint")}</div>
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
        </>
        )}

        {tab === "shortcuts" && (
        <>
          <section className="imp-section">
            <div className="imp-section-title">{t("settings.section.keyboardShortcuts")}</div>
            <ShortcutRemapSection onChange={onShortcutOverridesChange} />
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("settings.section.shortcuts")}</div>
            <AliasRemapSection onChange={onAliasOverridesChange} />
          </section>
        </>
        )}

        {tab === "update" && (
        <>
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
        </>
        )}
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

/**
 * Befehls-Kürzel-Remap (Nutzer-Wunsch: „Befehls-Kürzel sind hart codiert,
 * keine Remap-UI"): listet die NUTZER-Übersteuerungen (aus localStorage) mit
 * Löschen-Knopf + eine „Neu"-Zeile (Kürzel-Text + Befehls-Dropdown). Verwaltet
 * ihren State selbst (lädt/speichert direkt über `commandAliasOverrides.ts`)
 * — `onChange` ist nur ein Live-Hook fürs selbe Fenster, s. Prop-Kommentar
 * bei `SettingsDialogProps.onAliasOverridesChange`.
 */
function AliasRemapSection({ onChange }: { onChange?: (overrides: Record<string, string>) => void }) {
  const [overrides, setOverrides] = useState<Record<string, string>>(() => loadAliasOverrides());
  const [newKey, setNewKey] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const commands = allCommandNames();

  const commit = (next: Record<string, string>) => {
    setOverrides(next);
    saveAliasOverrides(next);
    onChange?.(next);
  };

  const addOverride = () => {
    const key = newKey.trim().toLowerCase();
    if (!isValidAliasKey(key) || !newCommand) return;
    commit({ ...overrides, [key]: newCommand });
    setNewKey("");
    setNewCommand("");
  };

  const removeOverride = (key: string) => {
    const next = { ...overrides };
    delete next[key];
    commit(next);
  };

  const entries = Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="settings-alias-remap">
      <div className="imp-note">{t("settings.shortcuts.hint")}</div>
      {entries.length > 0 && (
        <div className="settings-alias-list">
          {entries.map(([key, cmd]) => (
            <div className="settings-alias-row" key={key}>
              <span className="settings-alias-key">{key}</span>
              <span className="settings-alias-arrow">→</span>
              <select
                className="settings-select"
                value={cmd}
                onChange={(e) => commit({ ...overrides, [key]: e.target.value })}
              >
                {commands.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="imp-btn"
                onClick={() => removeOverride(key)}
                aria-label={t("settings.shortcuts.remove")}
                title={t("settings.shortcuts.remove")}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="settings-alias-row settings-alias-new">
        <input
          type="text"
          className="settings-num-input settings-alias-key-input"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder={t("settings.shortcuts.newKey")}
        />
        <span className="settings-alias-arrow">→</span>
        <select
          className="settings-select"
          value={newCommand}
          onChange={(e) => setNewCommand(e.target.value)}
        >
          <option value="">{t("settings.shortcuts.pickCommand")}</option>
          {commands.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="imp-btn"
          disabled={!isValidAliasKey(newKey) || !newCommand}
          onClick={addOverride}
        >
          {t("settings.shortcuts.add")}
        </button>
      </div>
    </div>
  );
}

const CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "selection",
  "edit",
  "boolean",
  "transform",
  "group",
  "tools",
];

/**
 * Remap-UI für die ECHTEN Tastenkombinationen (`state/keyboardShortcuts.ts`) —
 * Gegenstück zu `AliasRemapSection`, aber für `keydown`-Kürzel statt
 * Befehlszeilen-Tipp-Alias. Verwaltet ihren State selbst (lädt/speichert
 * direkt), `onChange` ist nur der Live-Hook fürs selbe Fenster (s.
 * `SettingsDialogProps.onShortcutOverridesChange`).
 *
 * Aufnahme läuft über einen `keydown`-Listener in der CAPTURE-Phase +
 * `stopPropagation`: die App-weiten Shortcut-Hooks (`useKeyboardShortcuts.ts`)
 * hängen alle in der Bubble-Phase am selben `window` — ohne das Abfangen
 * hier würde z. B. das Drücken von „m" während der Aufnahme (im INLINE-
 * Overlay-Dialog, selbes Fenster) zusätzlich sofort die Bewegen-Transformation
 * im Hintergrund auslösen.
 */
function ShortcutRemapSection({
  onChange,
}: {
  onChange?: (overrides: ShortcutOverrides) => void;
}) {
  const [overrides, setOverrides] = useState<ShortcutOverrides>(() => loadShortcutOverrides());
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<{ id: ShortcutId; message: string } | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{
    id: ShortcutId;
    combo: string;
    conflictWith: ShortcutId;
  } | null>(null);

  const commit = (next: ShortcutOverrides) => {
    setOverrides(next);
    saveShortcutOverrides(next);
    onChange?.(next);
  };

  useEffect(() => {
    if (!recordingId) return;
    const id = recordingId;
    const def = shortcutDef(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRecordingId(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // reiner Modifikator-Tastendruck — weiter warten
      e.preventDefault();
      e.stopPropagation();
      if (isReservedCombo(combo)) {
        setError({ id, message: t("settings.keyboardShortcuts.reserved") });
        setRecordingId(null);
        return;
      }
      if (def.bareKeyOnly && combo.includes("+")) {
        setError({ id, message: t("settings.keyboardShortcuts.reserved") });
        setRecordingId(null);
        return;
      }
      const conflict = findConflict(combo, id, overrides);
      setRecordingId(null);
      if (conflict) {
        setPendingConflict({ id, combo, conflictWith: conflict });
        return;
      }
      commit({ ...overrides, [id]: combo });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, overrides]);

  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className="settings-shortcut-remap">
      <div className="imp-note">{t("settings.keyboardShortcuts.hint")}</div>
      {CATEGORY_ORDER.map((cat) => {
        const defs = SHORTCUT_DEFS.filter((d) => d.category === cat);
        if (defs.length === 0) return null;
        return (
          <div className="settings-shortcut-category" key={cat}>
            <div className="settings-shortcut-category-title">
              {t(`settings.keyboardShortcuts.category.${cat}` as TranslationKey)}
            </div>
            {defs.map((def) => {
              const combo = resolveCombo(def.id, overrides);
              const isOverridden = def.id in overrides;
              const recording = recordingId === def.id;
              return (
                <div className="settings-shortcut-row" key={def.id}>
                  <span className="settings-shortcut-label">
                    {t(def.labelKey as TranslationKey)}
                  </span>
                  <span
                    className={`settings-shortcut-combo${recording ? " recording" : ""}`}
                  >
                    {recording ? t("settings.keyboardShortcuts.recording") : formatCombo(combo)}
                  </span>
                  <button
                    type="button"
                    className="imp-btn"
                    onClick={() => {
                      setError(null);
                      setPendingConflict(null);
                      setRecordingId(def.id);
                    }}
                  >
                    {t("settings.keyboardShortcuts.change")}
                  </button>
                  {isOverridden && (
                    <button
                      type="button"
                      className="imp-btn"
                      onClick={() => {
                        const next = { ...overrides };
                        delete next[def.id];
                        commit(next);
                      }}
                    >
                      {t("settings.keyboardShortcuts.reset")}
                    </button>
                  )}
                  {error?.id === def.id && <div className="imp-warn">{error.message}</div>}
                  {pendingConflict?.id === def.id && (
                    <div className="imp-warn">
                      {t("settings.keyboardShortcuts.conflict", {
                        action: t(shortcutDef(pendingConflict.conflictWith).labelKey as TranslationKey),
                      })}
                      <button
                        type="button"
                        className="imp-btn"
                        onClick={() => {
                          commit({ ...overrides, [def.id]: pendingConflict.combo });
                          setPendingConflict(null);
                        }}
                      >
                        {t("settings.keyboardShortcuts.conflictConfirm")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {hasOverrides && (
        <button type="button" className="imp-btn" onClick={() => commit({})}>
          {t("settings.keyboardShortcuts.resetAll")}
        </button>
      )}
    </div>
  );
}
