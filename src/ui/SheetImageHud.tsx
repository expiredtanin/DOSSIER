// Eigenschaften des gewählten Bilds auf dem Layout-Blatt ([208]): Lage, Breite (Höhe folgt dem Seitenverhältnis),
// Zuschnitt in Prozent je Kante, Auflösung (dpi) und Löschen. Gestaltung wie die übrigen Blatt-HUDs.

import type { LayoutImage } from "../model/types";
import { cropImage, imageGeometry, resizeImageWidth } from "../model/layoutImages";
import { t } from "../i18n";

/** dpi, ab denen ein Bild für den Druck knapp wird (Plakate werden aus Distanz betrachtet). */
export const LOW_DPI = 100;

type Edge = "left" | "right" | "top" | "bottom";

/** Zuschnitt-Anteile (0..1) → Randabstände je Kante in Prozent. */
function edges(img: LayoutImage): Record<Edge, number> {
  const c = img.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  return {
    left: Math.round(c.x * 1000) / 10,
    top: Math.round(c.y * 1000) / 10,
    right: Math.round((1 - c.x - c.w) * 1000) / 10,
    bottom: Math.round((1 - c.y - c.h) * 1000) / 10,
  };
}

function cropFromEdges(e: Record<Edge, number>): LayoutImage["crop"] {
  const l = Math.min(98, Math.max(0, e.left)) / 100;
  const t0 = Math.min(98, Math.max(0, e.top)) / 100;
  const r = Math.min(98 - l * 100, Math.max(0, e.right)) / 100;
  const b = Math.min(98 - t0 * 100, Math.max(0, e.bottom)) / 100;
  if (l === 0 && t0 === 0 && r === 0 && b === 0) return undefined;
  return { x: l, y: t0, w: 1 - l - r, h: 1 - t0 - b };
}

export function SheetImageHud({
  image,
  cropping = false,
  onToggleCrop,
  onPatch,
  onRemove,
}: {
  image: LayoutImage;
  /** Zuschnitt-Modus ([208]): Griffe am Ausschnitt auf dem Blatt. */
  cropping?: boolean;
  onToggleCrop?: () => void;
  onPatch: (patch: Partial<Omit<LayoutImage, "id">>) => void;
  onRemove: () => void;
}) {
  const e = edges(image);
  const dpi = Math.round(imageGeometry(image).dpi);
  const num = (v: number, set: (n: number) => void, testId?: string) => (
    <input
      type="number"
      className="res-input mono num"
      step={1}
      data-testid={testId}
      value={Math.round(v * 10) / 10}
      onChange={(ev) => {
        const n = parseFloat(ev.target.value);
        if (Number.isFinite(n)) set(n);
      }}
    />
  );
  return (
    <div className="layout-sheet-hud" data-sheet-ui data-image-hud data-testid="image-hud">
      <div className="layout-sheet-hud-title">{image.name || t("sheetImage.title")}</div>
      <div className="layout-sheet-hud-row">
        <span>X / Y mm</span>
        <span className="layout-sheet-hud-scale">
          {num(image.xMm, (xMm) => onPatch({ xMm }), "image-x")}
          {num(image.yMm, (yMm) => onPatch({ yMm }), "image-y")}
        </span>
      </div>
      <div className="layout-sheet-hud-row">
        <span>{t("sheetImage.width")}</span>
        <span className="layout-sheet-hud-scale">{num(image.widthMm, (w) => onPatch(resizeImageWidth(image, w)), "image-width")}</span>
      </div>
      <div className="layout-sheet-hud-size">
        {Math.round(image.widthMm)} × {Math.round(image.heightMm)} mm · {image.pixelWidth} × {image.pixelHeight} px
      </div>
      <div className="layout-sheet-hud-size" data-testid="image-dpi" style={dpi > 0 && dpi < LOW_DPI ? { color: "#b45309" } : undefined}>
        {dpi > 0 ? t("sheetImage.dpi", { dpi }) : ""}
        {dpi > 0 && dpi < LOW_DPI ? ` · ${t("sheetImage.lowDpi")}` : ""}
      </div>
      <div className="layout-sheet-hud-title" style={{ marginTop: 6, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span>{t("sheetImage.crop")}</span>
        {onToggleCrop && (
          <button className={`nav-add${cropping ? " active" : ""}`} data-testid="image-crop-toggle" onClick={onToggleCrop} title={t("sheetImage.cropHint")}>
            {cropping ? t("sheetImage.cropDone") : t("sheetImage.cropStart")}
          </button>
        )}
      </div>
      {(["left", "right", "top", "bottom"] as Edge[]).map((k) => (
        <div key={k} className="layout-sheet-hud-row">
          <span>{t(`sheetImage.crop.${k}`)}</span>
          <span className="layout-sheet-hud-scale">
            {num(e[k], (v) => onPatch(cropImage(image, cropFromEdges({ ...e, [k]: v }))), `image-crop-${k}`)}%
          </span>
        </div>
      ))}
      {cropping && <div className="layout-sheet-hud-size">{t("sheetImage.cropHint")}</div>}
      <div className="layout-sheet-hud-actions">
        {image.crop && (
          <button className="nav-add" data-testid="image-crop-reset" onClick={() => onPatch(cropImage(image, undefined))} title={t("sheetImage.cropReset")}>
            {t("sheetImage.cropReset")}
          </button>
        )}
        <button className="nav-add" data-testid="image-remove" onClick={onRemove} title={t("sheetImage.remove")}>
          <span className="material-symbols-outlined" aria-hidden="true">delete</span>
        </button>
      </div>
    </div>
  );
}
