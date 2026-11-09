// Kleine Info-Blöcke der Objekt-Info ([165] aus `ObjectInfoPanel.tsx`): Messwert-Anzeige und Hinweis zu den
// Schlagschatten der Ansicht. Gerufen von `ObjectInfoPanel`.

import type { MeasurementReadout } from "../../tools/types";
import { t } from "../../i18n";
import { useStore } from "../../state/appStore";
import { patchItem } from "../../core";

// ── Mess-Werkzeug-Abschnitt ───────────────────────────────────────────────────
// Zeigt die Live-Messwerte (letztes Segment, aufsummierte Länge, umschlossene
// Fläche, Richtung). Fläche nur, sobald der Zug ≥ 3 Ecken hat.
export function MeasurementSection({ m }: { m: MeasurementReadout }) {
  return (
    <div className="objinfo-measure">
      <div className="objinfo-section-label">{t("objinfo.measure.title")}</div>
      <div className="objinfo-measure-grid">
        <span className="objinfo-measure-key">{t("objinfo.measure.segment")}</span>
        <span className="objinfo-measure-val">{m.segment.toFixed(3)} m</span>
        <span className="objinfo-measure-key">{t("objinfo.measure.total")}</span>
        <span className="objinfo-measure-val">{m.total.toFixed(3)} m</span>
        <span className="objinfo-measure-key">{t("objinfo.measure.angle")}</span>
        <span className="objinfo-measure-val">{m.angle.toFixed(1)}°</span>
        {m.area != null && (
          <>
            <span className="objinfo-measure-key">{t("objinfo.measure.area")}</span>
            <span className="objinfo-measure-val">{m.area.toFixed(2)} m²</span>
          </>
        )}
      </div>
      <div className="objinfo-measure-hint">{t("objinfo.measure.hint")}</div>
    </div>
  );
}


/** [137] Schlagschatten der Ansicht angeklickt: Schalter der aktiven Ansicht (DrawingLevel.shadows, Undo). */
export function ViewShadowsInfo() {
  const level = useStore((s) => s.project.drawingLevels.find((l) => l.id === s.activeLevelId));
  const applyChange = useStore((s) => s.applyChange);
  return (
    <div className="objinfo-panel">
      <div className="objinfo-head">
        <span className="objinfo-kind">{t("objinfo.kind.viewShadows")}</span>
      </div>
      <div className="objinfo-muted objinfo-site-hint">{t("elevation.shadows.hint")}</div>
      {level && (
        <label className="objinfo-row" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            data-testid="view-shadows"
            checked={!!level.shadows}
            onChange={(e) => applyChange((p) => patchItem(p, "drawingLevels", level.id, { shadows: e.target.checked }))}
          />
          {t("elevation.shadows")}
        </label>
      )}
    </div>
  );
}
