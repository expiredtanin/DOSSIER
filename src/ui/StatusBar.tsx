// Footer / Status-Leiste (unten, ~22 px) — MVP nach docs/design/topbar-footer.md.
//
// Layout: links der Werkzeug-Hinweis (kontextueller Text des aktiven
// Werkzeugs), rechts ein Cluster aus abgeleiteten View-/Modell-Werten:
//   Cursor X/Y (Meter, „—" wenn nicht über dem Plan) · Einheit „m" ·
//   Massstab 1:N · Zoom % · aktives Geschoss · aktive Ebene.
//
// Rein gesteuert (controlled): alle Werte kommen aus App (Modell + View-State),
// keine eigene Logik. Bezeichner englisch, UI-Text/Kommentare deutsch.

import { useEffect, useRef, useState } from "react";
import type { Vec2 } from "../model/types";
import type { SnapSettings } from "../tools/types";
import { t } from "../i18n";

/** Plan-Renderer-Wahl, gespiegelt aus dem `?engine`-URL-Param (siehe PlanView). */
export type RendererMode = "webgl2" | "wasm";

export interface StatusBarProps {
  /** Kontextueller Werkzeug-Hinweis links (z. B. „Auswahl"). */
  hint: string;
  /** Cursor in Modell-Metern oder `null` (nicht über dem Plan). */
  cursor: Vec2 | null;
  /** Einheit aus dem Projekt (vorerst fix „m"). */
  unit: string;
  /** Referenzlinien (Wandachsen) an/aus — sitzt jetzt in der Statusleiste. */
  referenceLines: boolean;
  /** Referenzlinien umschalten. */
  onReferenceLines: (on: boolean) => void;
  /** Nur im Grundriss sinnvoll — deaktiviert den Schalter wenn `false`. */
  referenceLinesEnabled: boolean;
  /** Name des aktiven Geschosses / der aktiven Zeichnungsebene. */
  activeFloor: string;
  /** Name der aktiven Ebene (Kategorie) oder „—". */
  activeLayer: string;
  /** Linien-Darstellung: „display" (Haarlinien) oder „print" (echte mm-Stärken). */
  lineMode: "display" | "print";
  /** Linien-Darstellung wechseln. */
  onLineModeChange: (mode: "display" | "print") => void;
  /** Nur im Grundriss sinnvoll — deaktiviert beide Segmente wenn `false`. */
  lineModeEnabled: boolean;
  /** Fang-Einstellungen (Werkzeug-übergreifend). */
  snap: SnapSettings;
  /** Fang-Einstellungen ändern. */
  onSnapChange: (s: SnapSettings) => void;
}

/**
 * Zweisegmentige Umschalt-Pille Display/Print für die Statusleiste — optisch
 * an `.sb-renderer-toggle` angelehnt (gleiche Höhe/Radius), eigene Klasse
 * `.sb-seg` weil sie generisch (nicht renderer-spezifisch) bleibt.
 */
function LineModeToggle({
  lineMode,
  onLineModeChange,
  lineModeEnabled,
}: {
  lineMode: "display" | "print";
  onLineModeChange: (m: "display" | "print") => void;
  lineModeEnabled: boolean;
}) {
  return (
    <span className="sb-field">
      <span className="sb-key">{t("topbar.lineModeGroup")}</span>
      <span
        className={`sb-seg${lineModeEnabled ? "" : " disabled"}`}
        role="group"
        aria-label={t("topbar.lineModeGroup")}
      >
        <button
          type="button"
          className={`sb-seg-btn${lineMode === "display" ? " active" : ""}`}
          aria-pressed={lineMode === "display"}
          disabled={!lineModeEnabled}
          title={t("topbar.lineMode.display.hint")}
          onClick={() => onLineModeChange("display")}
        >
          {t("topbar.lineMode.display")}
        </button>
        <button
          type="button"
          className={`sb-seg-btn${lineMode === "print" ? " active" : ""}`}
          aria-pressed={lineMode === "print"}
          disabled={!lineModeEnabled}
          title={t("topbar.lineMode.print.hint")}
          onClick={() => onLineModeChange("print")}
        >
          {t("topbar.lineMode.print")}
        </button>
      </span>
    </span>
  );
}

/**
 * Fang-Kontrolle für die Statusleiste: eine Pille schaltet `snap.enabled`
 * direkt um (Klick = an/aus, aktive Einfärbung wie der Renderer-Umschalter);
 * ein kleiner Caret daneben öffnet ein NACH OBEN öffnendes Popover (Leiste
 * sitzt unten) mit den Fang-Unteroptionen — 1:1 aus dem früheren
 * ToolsPanel-„Fang-Abschnitt" übernommen. Schliesst bei Klick ausserhalb.
 */
function SnapControl({
  snap,
  onSnapChange,
}: {
  snap: SnapSettings;
  onSnapChange: (s: SnapSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <span className="sb-snap-wrap" ref={wrapRef}>
      <span className={`sb-seg${open ? " open" : ""}`} role="group" aria-label={t("tool.snap")}>
        <button
          type="button"
          className={`sb-seg-btn${snap.enabled ? " active" : ""}`}
          aria-pressed={snap.enabled}
          title={t("tool.snap.hint")}
          onClick={() => onSnapChange({ ...snap, enabled: !snap.enabled })}
        >
          {t("tool.snap")}
        </button>
        <button
          type="button"
          className={`sb-seg-btn sb-seg-caret${open ? " active" : ""}`}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={t("tool.snap")}
          title={t("tool.snap")}
          onClick={() => setOpen((v) => !v)}
        >
          ▴
        </button>
      </span>
      {open && (
        <div className="sb-snap-popover" role="dialog" aria-label={t("tool.snap")}>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, enabled: e.target.checked })}
            />
            <span>{t("snap.enabled")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.endpoint}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, endpoint: e.target.checked })}
            />
            <span>{t("snap.endpoint")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.midpoint}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, midpoint: e.target.checked })}
            />
            <span>{t("snap.midpoint")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.center}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, center: e.target.checked })}
            />
            <span>{t("snap.center")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.intersection}
              disabled={!snap.enabled}
              onChange={(e) =>
                onSnapChange({ ...snap, intersection: e.target.checked })
              }
            />
            <span>{t("snap.intersection")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.onEdge}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, onEdge: e.target.checked })}
            />
            <span>{t("snap.onEdge")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.perpendicular}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, perpendicular: e.target.checked })}
            />
            <span>{t("snap.perpendicular")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.tangent}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, tangent: e.target.checked })}
            />
            <span>{t("snap.tangent")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.parallel}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, parallel: e.target.checked })}
            />
            <span>{t("snap.parallel")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.grid}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, grid: e.target.checked })}
            />
            <span>{t("snap.grid")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.ortho}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, ortho: e.target.checked })}
            />
            <span>{t("snap.ortho")}</span>
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("snap.angleStep")}</span>
            <input
              type="number"
              step={5}
              min={1}
              max={180}
              disabled={!snap.enabled}
              value={snap.angleStep}
              onChange={(e) =>
                onSnapChange({ ...snap, angleStep: Number(e.target.value) })
              }
            />
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("snap.gridSize")}</span>
            <input
              type="number"
              step={0.05}
              min={0.01}
              value={snap.gridSize}
              onChange={(e) =>
                onSnapChange({ ...snap, gridSize: Number(e.target.value) })
              }
            />
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.showGrid}
              onChange={(e) => onSnapChange({ ...snap, showGrid: e.target.checked })}
            />
            <span>{t("snap.showGrid")}</span>
          </label>
          <label className="sb-snap-row">
            <input
              type="checkbox"
              checked={snap.commonAngles}
              disabled={!snap.enabled}
              onChange={(e) => onSnapChange({ ...snap, commonAngles: e.target.checked })}
            />
            <span>{t("snap.commonAngles")}</span>
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("snap.commonAngleTolerance")}</span>
            <input
              type="number"
              step={0.5}
              min={0.5}
              max={10}
              disabled={!snap.enabled || !snap.commonAngles}
              value={snap.commonAngleTolerance}
              onChange={(e) =>
                onSnapChange({ ...snap, commonAngleTolerance: Number(e.target.value) })
              }
            />
          </label>
          {/* Hover-Teilpunkte (rein visuell, unabhängig vom Fang selbst — daher
              NICHT an snap.enabled gekoppelt): Ruht der Cursor auf einer Linie,
              erscheinen nach der Verzögerung ihre Teilpunkte mit Akzentfarbe. */}
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("snap.hoverDivideDelayMs")}</span>
            <input
              type="number"
              step={50}
              min={0}
              max={3000}
              value={snap.hoverDivideDelayMs}
              onChange={(e) =>
                onSnapChange({ ...snap, hoverDivideDelayMs: Number(e.target.value) })
              }
            />
          </label>
          <label className="sb-snap-row sb-snap-row-num">
            <span>{t("snap.hoverDivideCount")}</span>
            <input
              type="number"
              step={1}
              min={2}
              max={12}
              value={snap.hoverDivideCount}
              onChange={(e) =>
                onSnapChange({ ...snap, hoverDivideCount: Number(e.target.value) })
              }
            />
          </label>
        </div>
      )}
    </span>
  );
}

/** Ein Wert-Feld im rechten Cluster: kleine Beschriftung + Wert. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="sb-field">
      <span className="sb-key">{label}</span>
      <span className="sb-val">{value}</span>
    </span>
  );
}

/** Vertikaler Trenner im Cluster. */
function Sep() {
  return <span className="sb-sep" aria-hidden="true" />;
}

/** Eine Meterzahl für die Statusleiste (3 Nachkommastellen, ohne Einheit). */
const fmt = (n: number): string => n.toFixed(3);

export function StatusBar({
  hint,
  cursor,
  unit,
  referenceLines,
  onReferenceLines,
  referenceLinesEnabled,
  activeFloor,
  activeLayer,
  lineMode,
  onLineModeChange,
  lineModeEnabled,
  snap,
  onSnapChange,
}: StatusBarProps) {
  const coords = cursor
    ? `${fmt(cursor.x)}, ${fmt(cursor.y)}`
    : "—";

  return (
    <footer className="statusbar">
      {/* Links: Werkzeug-Hinweis. */}
      <span className="sb-hint">{hint}</span>

      {/* Rechts: abgeleiteter Wert-Cluster. Interaktive Kontrollen (Linien-
          Darstellung, Fang) zuerst, danach die reinen Anzeigewerte. */}
      <div className="sb-cluster">
        <LineModeToggle
          lineMode={lineMode}
          onLineModeChange={onLineModeChange}
          lineModeEnabled={lineModeEnabled}
        />
        <Sep />
        <SnapControl snap={snap} onSnapChange={onSnapChange} />
        <Sep />
        {/* Referenzlinien-Schalter (aus der TopBar hierher gewandert). */}
        <button
          type="button"
          className={`sb-toggle${referenceLines ? " active" : ""}`}
          aria-pressed={referenceLines}
          disabled={!referenceLinesEnabled}
          onClick={() => onReferenceLines(!referenceLines)}
          title={
            referenceLinesEnabled
              ? t("status.referenceLines.hint")
              : t("status.referenceLines.hintDisabled")
          }
        >
          {t("status.referenceLines")}
        </button>
        <Sep />
        <Field label={t("status.xy")} value={coords} />
        <Sep />
        <Field label={t("status.unit")} value={unit} />
        <Sep />
        <Field label={t("status.floor")} value={activeFloor} />
        <Sep />
        <Field label={t("status.layer")} value={activeLayer} />
      </div>
    </footer>
  );
}
