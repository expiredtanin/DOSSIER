// Footer / Status-Leiste (unten, ~22 px) — MVP nach docs/design/topbar-footer.md.
//
// Layout: links der Werkzeug-Hinweis (kontextueller Text des aktiven
// Werkzeugs), rechts ein Cluster aus abgeleiteten View-/Modell-Werten:
//   Cursor X/Y (Meter, „—" wenn nicht über dem Plan) · Einheit „m" ·
//   Massstab 1:N · Zoom % · aktives Geschoss · aktive Ebene.
//
// Rein gesteuert (controlled): alle Werte kommen aus App (Modell + View-State),
// keine eigene Logik. Bezeichner englisch, UI-Text/Kommentare deutsch.

import type { Vec2 } from "../model/types";
import { t } from "../i18n";

export interface StatusBarProps {
  /** Kontextueller Werkzeug-Hinweis links (z. B. „Auswahl"). */
  hint: string;
  /** Cursor in Modell-Metern oder `null` (nicht über dem Plan). */
  cursor: Vec2 | null;
  /** Einheit aus dem Projekt (vorerst fix „m"). */
  unit: string;
  /**
   * LIVE Papier-Massstab-Nenner (1:N) aus der View-Transform oder `null`
   * (keine Plan-Ansicht aktiv → „—").
   */
  scaleDenominator: number | null;
  /** Live-Zoom in Prozent oder `null` (keine zoombare Ansicht aktiv). */
  zoomPercent: number | null;
  /** Name des aktiven Geschosses / der aktiven Zeichnungsebene. */
  activeFloor: string;
  /** Name der aktiven Ebene (Kategorie) oder „—". */
  activeLayer: string;
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
  scaleDenominator,
  zoomPercent,
  activeFloor,
  activeLayer,
}: StatusBarProps) {
  const coords = cursor
    ? `${fmt(cursor.x)}, ${fmt(cursor.y)}`
    : "—";

  return (
    <footer className="statusbar">
      {/* Links: Werkzeug-Hinweis. */}
      <span className="sb-hint">{hint}</span>

      {/* Rechts: abgeleiteter Wert-Cluster. */}
      <div className="sb-cluster">
        <Field label={t("status.xy")} value={coords} />
        <Sep />
        <Field label={t("status.unit")} value={unit} />
        <Sep />
        <Field
          label={t("status.scale")}
          value={scaleDenominator == null ? "—" : `1:${Math.round(scaleDenominator)}`}
        />
        <Sep />
        <Field
          label={t("status.zoom")}
          value={zoomPercent == null ? "—" : `${Math.round(zoomPercent)}%`}
        />
        <Sep />
        <Field label={t("status.floor")} value={activeFloor} />
        <Sep />
        <Field label={t("status.layer")} value={activeLayer} />
      </div>
    </footer>
  );
}
