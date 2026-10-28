// Punktwolken im Lage-Panel ([27] Stufe 1): Liste der geladenen Wolken mit Sichtbarkeit,
// Farbmodus, Punktgrösse und Entfernen, dazu „Importieren …". Die Wolken liegen im UI-Store
// (`state/pointCloudStore.ts`), nicht im Projekt — Änderungen hier sind kein Undo-Schritt.

import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { usePanelHost } from "./host";
import {
  MAX_POINT_SIZE,
  MIN_POINT_SIZE,
  POINT_COLOR_MODES,
  colorModeAvailable,
  openPointCloudFileDialog,
  removePointCloud,
  updatePointCloud,
  usePointClouds,
} from "../state/pointCloudStore";
import type { PointColorMode } from "../state/pointCloudStore";
import { placementHints, placementOf } from "../ui/PointCloudImportDialog";

const MODE_KEY: Record<PointColorMode, TranslationKey> = {
  rgb: "pointCloud.color.rgb",
  intensity: "pointCloud.color.intensity",
  class: "pointCloud.color.class",
  height: "pointCloud.color.height",
};

export function PointCloudSection() {
  const host = usePanelHost();
  const clouds = usePointClouds();
  return (
    <div className="site-rules" data-testid="pointcloud-section">
      <div className="site-rules-head">
        <span>{t("pointCloud.section")}</span>
        <button type="button" className="site-btn" onClick={() => openPointCloudFileDialog()}>
          {t("pointCloud.import")}
        </button>
      </div>
      {clouds.length === 0 && <div className="sun-readout">{t("pointCloud.empty")}</div>}
      {clouds.map((c) => (
        <div key={c.id} className="site-rules">
          <div className="sun-row">
            <input
              type="checkbox"
              checked={c.visible}
              title={t("pointCloud.visible")}
              aria-label={t("pointCloud.visible")}
              onChange={(e) => updatePointCloud(c.id, { visible: e.target.checked })}
            />
            <span className="site-name" title={c.name}>
              {c.name}
            </span>
            <button
              type="button"
              className="site-remove"
              title={t("pointCloud.remove")}
              aria-label={t("pointCloud.remove")}
              onClick={() => removePointCloud(c.id)}
            >
              ×
            </button>
          </div>
          <div className="sun-row">
            <select
              className="kz-input"
              value={c.colorMode}
              title={t("pointCloud.color")}
              aria-label={t("pointCloud.color")}
              onChange={(e) => updatePointCloud(c.id, { colorMode: e.target.value as PointColorMode })}
            >
              {POINT_COLOR_MODES.map((m) => (
                <option key={m} value={m} disabled={!colorModeAvailable(c.data.report, m)}>
                  {t(MODE_KEY[m])}
                </option>
              ))}
            </select>
            <input
              type="range"
              className="sun-slider"
              min={MIN_POINT_SIZE}
              max={MAX_POINT_SIZE}
              step={1}
              value={c.pointSize}
              title={t("pointCloud.size")}
              aria-label={t("pointCloud.size")}
              onChange={(e) => updatePointCloud(c.id, { pointSize: Number(e.target.value) })}
            />
            <span className="sun-time">{c.pointSize} px</span>
          </div>
          <div className="sun-readout">
            {t("pointCloud.count", { n: c.data.report.pointsKept.toLocaleString("de-CH") })}
            {c.data.report.epsg !== null && <> · EPSG {c.data.report.epsg}</>}
            {" · "}
            {placementHints(placementOf(c.data, host.project))
              .map((k) => t(k))
              .join(" ")}
          </div>
        </div>
      ))}
      {clouds.length > 0 && <div className="sun-readout">{t("pointCloud.only3d")} {t("pointCloud.sessionHint")}</div>}
    </div>
  );
}
